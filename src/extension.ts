import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";
import { ChatController, stamp } from "./dsh/controller";
import { selectionLines } from "./dsh/selection";
import {
  clearStaleDocumentLocks,
  cleanupResidualServers,
  dropStaleHostLeases,
  leaseDirectory,
  scanServers,
  setLeaseGroup,
} from "./dsh/processRegistry";
import { ServerManager } from "./dsh/serverManager";

let output: vscode.OutputChannel | undefined;

/**
 * 启动命令的兜底默认值——**与 `package.json` 里 `dshChat.command` 的 default 必须一致**。
 *
 * 为什么要有这个常量：设置在用户没写过时也会返回 schema 的 default，所以这里只在
 * 「用户把命令清成空串」时才生效；但它出现在**两个**地方（激活期构造 ServerManager、
 * 配置变更后重连），写两份字符串迟早漂移。
 *
 * 命令**原样执行，扩展不追加任何参数**：`--port 0`（系统分配端口）与 `--no-open`
 * （不弹系统浏览器）都是这条默认值的一部分，用户可以整条改掉。
 */
const DEFAULT_COMMAND = "dsh web --port 0 --no-open";

/**
 * 这台机器上"共享同一个后台"的分组键：**由有效服务器配置算出来**。
 *
 * 为什么需要它：VS Code 的设置是有作用域的（默认 / 工作区 / 工作区文件夹），所以
 * **不同窗口的 `dshChat.url` / `dshChat.command` 可能不同**——例如 A、B 两个工作区
 * 各自写了"用内部 dsh"，而全局用户设置是"用外部 URL"，其余窗口就该走外部。
 * 若所有窗口共用一份会合信息，配置不同的窗口会互相抢后台（配置外部的那位会无视
 * 自己那份配置，去接入别人起的内部后台）。
 *
 * 所以按**有效配置**分组：有效配置相同的窗口（包括"来源不同但有效值相同"）共用一个后台；
 * 不同的各管各的。`url` 非空时只按 url 分组——那时 `command` 与超时本来就不生效。
 */
function leaseGroupKey(config: () => vscode.WorkspaceConfiguration): string {
  const url = (config().get<string>("url") ?? "").trim().replace(/\/+$/, "");
  const command = config().get<string>("command") || DEFAULT_COMMAND;
  const identity = url ? `external:${url}` : `internal:${command}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

function log(line: string): void {
  output ??= vscode.window.createOutputChannel("DSH Chat");
  if (line) output.appendLine(stamp(line));
}

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration("dshChat");

  // **先定分组，再碰任何租约**：分组决定"和哪些窗口共享后台"
  setLeaseGroup(leaseGroupKey(config));

  const server = new ServerManager({
    url: config().get<string>("url") ?? "",
    command: config().get<string>("command") || DEFAULT_COMMAND,
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
  registerContributions(context, { controller, provider, secondaryProvider, server, config });

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
  /** 每次调用都重读 `dshChat.*`（配置变更监听要用最新值，不能用激活期快照）。 */
  config: () => vscode.WorkspaceConfiguration;
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
      const shared = server.sharedSummary();
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
        shared
          ? vscode.l10n.t(
              "Shared with other VS Code windows: {0}",
              shared.ownership === "self"
                ? vscode.l10n.t("this window runs the server, {0} window(s) in total", shared.hostCount)
                : shared.ownership === "peer"
                  ? vscode.l10n.t("using the server of another window, {0} window(s) in total", shared.hostCount)
                  : vscode.l10n.t("no (dshChat.url)"),
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
      // 服务器三件套改了要**真正换一个后台**：配置项只在启动时读一次，
      // 不重连的话用户改了 `dshChat.url`（或启动命令）却仍连着旧服务器。
      // **服务器三件套不再就地热切换**（用户口径 2026-09-14：太复杂，改成重载窗口生效）。
      // 原地切需要"断干净 + 按新配置接上 + 换分组 + 别把别人的后台带走"一整套时序，
      // 收益却只是省一次窗口重载——不值得。这里的提示是**唯一**的生效入口，
      // 配置项说明里也写明了「改完需要重载窗口」。
      if (
        event.affectsConfiguration("dshChat.url") ||
        event.affectsConfiguration("dshChat.command") ||
        event.affectsConfiguration("dshChat.startTimeoutSec")
      ) {
        void promptServerReload();
      }
    }),
  );
}

/** 服务器配置改了：提示重载窗口（这是唯一生效方式）。 */
async function promptServerReload(): Promise<void> {
  const picked = await vscode.window.showInformationMessage(
    vscode.l10n.t("Server settings changed. Reload the window to apply them."),
    vscode.l10n.t("Reload Window"),
  );
  if (picked) void vscode.commands.executeCommand("workbench.action.reloadWindow");
}

/** 启动期收尾：清理上次未正常关闭的残留服务器、按配置自动连接、按需打开面板。 */
function startup(
  config: () => vscode.WorkspaceConfiguration,
  controller: ChatController,
  provider: ChatViewProvider,
): void {
  // 启动初期的残留处置（顺应用户口径 2026-09-14）：
  //
  // 1) **所有失效的心跳文件一律清理**（不论 `dshChat.url` 有没有配置——残留可能发生在
  //    改 URL 之前）。判"失效"用的是**进程真的在不在**（批量 `Get-Process`），
  //    不能用 `process.kill(pid, 0)`：被强杀的进程在回收前那个探测仍返回成功。
  // 2) **服务器本身不在这里动**：能复用的（还在跑）留给 `ServerManager.start()` 接管
  //    ——它手里还攥着会话与内存状态；真的连不上的，也由它在启动决策里顺手回收并重起。
  //    放在这里杀会和"接管"抢时序（踩过：遗留租约被这条清理删掉，于是只能重起）。
  //
  // 不 await：判活要起一次 PowerShell，不该拖住激活流程；失败也只记日志。
  try {
    const dropped = dropStaleHostLeases();
    if (dropped.length) log(`[cleanup] 清理了 ${dropped.length} 个失效心跳文件`);
  } catch (error) {
    log(`[cleanup] 心跳清理失败：${error instanceof Error ? error.message : String(error)}`);
  }

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
