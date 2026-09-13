import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";
import { ChatController, stamp } from "./dsh/controller";
import { selectionLines } from "./dsh/selection";
import { clearStaleDocumentLocks, cleanupResidualServers, leaseDirectory, scanServers } from "./dsh/processRegistry";
import { ServerManager } from "./dsh/serverManager";

let output: vscode.OutputChannel | undefined;

function log(line: string): void {
  output ??= vscode.window.createOutputChannel("DSH Chat");
  if (line) output.appendLine(stamp(line));
}

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration("dshChat");

  const server = new ServerManager({
    url: config().get<string>("url") ?? "",
    command: config().get<string>("command") || "dsh",
    startTimeoutMs: (config().get<number>("startTimeoutSec") ?? 90) * 1000,
    workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    log,
  });

  const controller = new ChatController(
    server,
    log,
    // 全局存储：跨工作区共享（本地已删除的会话 id）
    context.globalState,
    // 工作区存储：VS Code 自己那份**按工作区分文件**的缓存，用来记「这个文件夹
    // 上次开着哪几个对话窗口、各自是哪个会话」（见 dsh/windowState.ts）。
    // 它落在 VS Code 的 workspaceStorage 下，不往项目目录里写任何文件。
    context.workspaceState,
    context.secrets,
  );
  // 两个侧栏视图容器各挂一个带标识的实例：日志里能区分视图来自主侧栏还是辅助侧栏
  const provider = new ChatViewProvider(context, controller, "primary", log);
  const secondaryProvider = new ChatViewProvider(context, controller, "secondary", log);

  // 编辑区面板的恢复必须**同步**注册：重开工作区时面板恢复可能就是扩展被激活的
  // 原因，晚一步注册这次恢复就接不到了（见 ChatViewProvider.registerPanelSerializer）。
  // 挂在主侧栏那个实例上，与 openPanel 的创建方保持一致（面板只有这一处宿主）
  provider.registerPanelSerializer();

  // 第一部分：把服务、控制器、视图与全部命令挂到 context.subscriptions（释放即随扩展一起走）
  registerContributions(context, { controller, provider, secondaryProvider, server });

  // 辅助侧栏容器（secondarySidebar 贡献点）只在 VS Code ≥ 1.106 存在。
  // 活动栏容器用 `when: !dshChat.supportsSecondarySidebar` 与它互斥，
  // 所以这个标记必须按真实版本设置：写死 true 会让旧版本两个容器都不显示。
  void vscode.commands.executeCommand(
    "setContext",
    "dshChat.supportsSecondarySidebar",
    supportsSecondarySidebar(),
  );

  // 第二部分：启动期收尾——清残留进程、自动连接、按需打开面板
  startup(config, controller, provider);
}

/** 激活期需要交给命令注册使用的对象。 */
interface Contributions {
  controller: ChatController;
  provider: ChatViewProvider;
  secondaryProvider: ChatViewProvider;
  server: ServerManager;
}

/**
 * 注册视图提供者、命令与配置/状态监听。
 * 全部一次性 push 进 context.subscriptions，deactivate 时统一释放。
 */
function registerContributions(context: vscode.ExtensionContext, host: Contributions): void {
  const { controller, provider, secondaryProvider, server } = host;

  context.subscriptions.push(
    output ?? vscode.window.createOutputChannel("DSH Chat"),
    controller,
    provider,
    // 必须注册 server 本身：deactivate 时 dispose → stop() 带走它拉起的进程树
    server,
    server.onDidChangeStatus((status) => controller.onServerStatus(status)),

    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.secondaryViewType, secondaryProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    secondaryProvider,

    // 「新建对话」建在**最近活动的窗口**上：那个窗口的会话换成新的（其他窗口不动）
    vscode.commands.registerCommand("dshChat.newSession", () => controller.newSession(controller.activeViewId())),
    vscode.commands.registerCommand("dshChat.history", async () => {
      await controller.openHistory();
      controller.revealActiveView();
    }),
    // 「在编辑器中打开」：webview 按钮会把点击来源窗口的会话带过来；
    // 命令面板直接执行（没有来源窗口）时用最近活动窗口的会话；都没有就空态
    vscode.commands.registerCommand(
      "dshChat.openInEditor",
      (sessionId?: string) => {
        log(`[cmd] openInEditor session=${sessionId ?? "（无来源窗口，取活动窗口）"}`);
        return provider.openPanel(sessionId ?? controller.activeSessionId());
      },
    ),
    // 「停止」停最近活动窗口的会话轮
    vscode.commands.registerCommand("dshChat.stop", () => controller.stopActive()),
    vscode.commands.registerCommand("dshChat.startServer", () => controller.ensureConnected()),
    vscode.commands.registerCommand("dshChat.restartServer", () => controller.restart()),
    // 外部服务器（dshChat.url）要求授权时，令牌从这里输入
    vscode.commands.registerCommand("dshChat.setToken", () => controller.setToken()),
    vscode.commands.registerCommand("dshChat.cleanupProcesses", async () => {
      const result = await cleanupResidualServers(log);
      const message = result.killed.length
        ? vscode.l10n.t(
            "Cleaned up {0} leftover dsh process(es): {1}",
            result.killed.length,
            result.killed.join(", "),
          )
        : result.orphans.length
          ? vscode.l10n.t(
              "Found {0} process(es) that look leftover but could not be confirmed or cleaned up: {1}",
              result.orphans.length,
              result.orphans.join(", "),
            )
          : vscode.l10n.t("No leftover dsh processes were found.");
      await vscode.window.showInformationMessage(message, { modal: true });
    }),
    vscode.commands.registerCommand("dshChat.showLogs", () => {
      output ??= vscode.window.createOutputChannel("DSH Chat");
      output.show(true);
    }),
    vscode.commands.registerCommand("dshChat.showDiagnostics", async () => {
      const status = server.getStatus();
      const orphans = (await scanServers())
        .filter((item) => item.orphan)
        .map((item) => item.lease.serverPid);
      const message = [
        vscode.l10n.t("Server state: {0}", status.state),
        status.info ? vscode.l10n.t("Address: {0}", status.info.baseUrl) : undefined,
        status.info
          ? vscode.l10n.t(
              "Started by this extension: {0}",
              status.info.owned ? vscode.l10n.t("yes") : vscode.l10n.t("no (using dshChat.url)"),
            )
          : undefined,
        status.detail ? vscode.l10n.t("Detail: {0}", status.detail) : undefined,
        vscode.l10n.t(
          "Leftover processes: {0}",
          orphans.length
            ? vscode.l10n.t(
                "{0} (pid {1}) — use the “DSH: Clean Up Leftover Processes” command",
                orphans.length,
                orphans.join(", "),
              )
            : vscode.l10n.t("none"),
        ),
        vscode.l10n.t("Process lease directory: {0}", leaseDirectory()),
        vscode.l10n.t("Server log: {0}", server.logPath),
        vscode.l10n.t("Extension log: the “DSH Chat” output channel"),
      ]
        .filter(Boolean)
        .join("\n");
      await vscode.window.showInformationMessage(message, { modal: true });
    }),

    // 编辑器与资源管理器右键入口
    vscode.commands.registerCommand("dshChat.addSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText(editor.selection);
      const name = vscode.workspace.asRelativePath(editor.document.uri);
      controller.addSelection(name, text, selectionLines(editor.selection));
      // 焦点回到**加引用的那个窗口**（可能是侧栏，也可能是编辑区面板）：
      // 写死 `dshChat.view.focus` 会把开在编辑区的对话硬拽回侧栏
      controller.revealActiveView();
    }),
    vscode.commands.registerCommand("dshChat.addFile", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== "file") return;
      void controller.addFileContext(target.fsPath);
      controller.revealActiveView();
    }),
    // 目录单独入口：Windows/Linux 的文件对话框不能同时选文件和目录
    // （见 controller.pickFiles 的注释），所以目录走独立命令。
    // 右键文件夹时 uri 直接给到，不再弹对话框。
    vscode.commands.registerCommand("dshChat.addFolder", async (uri?: vscode.Uri) => {
      if (uri) await controller.addFileContext(uri.fsPath);
      else await controller.addFolder();
      controller.revealActiveView();
    }),

    // 界面相关配置（diff 排版 / 语言 / 字号 / 问卷题数）改了即时生效，不必重载窗口。
    // 它们都是纯显示层：重载会丢掉滚动位置与展开状态，代价不成比例。
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("dshChat.diffLayout")) controller.refreshDiffLayout();
      if (
        event.affectsConfiguration("dshChat.language") ||
        event.affectsConfiguration("dshChat.fontSize") ||
        event.affectsConfiguration("dshChat.questionBatch")
      ) {
        controller.refreshAppearance();
      }
    }),
  );
}

/** 启动期收尾：清理上次未正常关闭的残留服务器、按配置自动连接、按需打开面板。 */
function startup(
  config: () => vscode.WorkspaceConfiguration,
  controller: ChatController,
  provider: ChatViewProvider,
): void {
  // 上次 VS Code 非正常关闭（崩溃 / 强杀）留下的 dsh web 进程：认出来并清掉。
  // 不 await：清理要起 PowerShell（Windows 上约 1.5s），不该拖住激活流程；
  // 它本身已是异步的，await 期间扩展宿主照常响应。失败也只记日志。
  void cleanupResidualServers(log)
    .then((result) => {
      if (result.killed.length) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "Cleaned up {0} leftover dsh server process(es) (VS Code did not shut down cleanly last time).",
            result.killed.length,
          ),
        );
      }
    })
    .catch((error: unknown) => {
      log(`[cleanup] 残留进程检测失败：${error instanceof Error ? error.message : String(error)}`);
    });

  // 崩溃留下的 writer 锁同样要清，而且**必须在起服务器之前**：
  // `dsh web` 的 boot 会去锁 `.credentials.yaml`，等 30 秒拿不到就把整个进程带走
  // （用户实测的 `atomic-write: timed out waiting for the writer lock`）。
  // 库本身刻意不回收孤儿锁，所以这一步是扩展的责任。
  //
  // 顺序是硬要求：不 await 就会与 ensureConnected 赛跑，服务器照样撞上那把锁。
  // 没有锁时这一步只是两次 ENOENT 的读文件（微秒级），有锁时才起 PowerShell。
  const autoStart = config().get<boolean>("autoStart") ?? true;
  void clearStaleDocumentLocks(log)
    .then((result) => {
      if (result.cleared.length) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "Cleared the file lock left behind by the last abnormal exit (otherwise the dsh server would fail to start while waiting for it).",
          ),
        );
      }
      if (result.held.length) {
        log(`[lock] ${result.held.join("、")} 仍有持有者，未清理`);
      }
    })
    .catch((error: unknown) => {
      log(`[lock] 残留锁检测失败：${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      if (autoStart) {
        void controller.ensureConnected();
      } else {
        log("已关闭自动启动，可用命令「DSH: 启动服务器」手动连接。");
      }
    });

  if (config().get<boolean>("openPanelOnStartup")) {
    provider.openPanel();
  }
}

/** VS Code ≥ 1.106 才有辅助侧栏（secondarySidebar 视图容器贡献点）。 */
function supportsSecondarySidebar(): boolean {
  const [major, minor] = vscode.version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 1 || (major === 1 && minor >= 106);
}

export function deactivate(): void {
  // 全部资源（含 ServerManager.dispose → stop() 杀服务器进程树）随
  // context.subscriptions 在 deactivate 时释放，这里无需额外动作
}
