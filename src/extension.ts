import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";
import { ChatController, stamp } from "./dsh/controller";
import { cleanupResidualServers, leaseDirectory, scanServers } from "./dsh/processRegistry";
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

  const controller = new ChatController(server, log, context.globalState, context.secrets);
  const provider = new ChatViewProvider(context, controller);

  // 第一部分：把服务、控制器、视图与全部命令挂到 context.subscriptions（释放即随扩展一起走）
  registerContributions(context, { controller, provider, server });

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
  server: ServerManager;
}

/**
 * 注册视图提供者、命令与配置/状态监听。
 * 全部一次性 push 进 context.subscriptions，deactivate 时统一释放。
 */
function registerContributions(context: vscode.ExtensionContext, host: Contributions): void {
  const { controller, provider, server } = host;

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
    vscode.window.registerWebviewViewProvider(ChatViewProvider.secondaryViewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("dshChat.newSession", () => controller.newSession()),
    vscode.commands.registerCommand("dshChat.history", async () => {
      await controller.openHistory();
      await vscode.commands.executeCommand("dshChat.view.focus");
    }),
    vscode.commands.registerCommand("dshChat.openInEditor", () => provider.openPanel()),
    vscode.commands.registerCommand("dshChat.stop", () => controller.handle({ type: "stop" })),
    vscode.commands.registerCommand("dshChat.startServer", () => controller.ensureConnected()),
    vscode.commands.registerCommand("dshChat.restartServer", () => controller.restart()),
    // 外部服务器（dshChat.url）要求授权时，令牌从这里输入
    vscode.commands.registerCommand("dshChat.setToken", () => controller.setToken()),
    vscode.commands.registerCommand("dshChat.cleanupProcesses", async () => {
      const result = await cleanupResidualServers(log);
      const message = result.killed.length
        ? `已清理 ${result.killed.length} 个残留的 dsh 进程：${result.killed.join("、")}`
        : result.orphans.length
          ? `发现 ${result.orphans.length} 个疑似残留进程，但未能确认/清理：${result.orphans.join("、")}`
          : "没有发现残留的 dsh 进程。";
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
        `服务器状态：${status.state}`,
        status.info ? `地址：${status.info.baseUrl}` : undefined,
        status.info ? `由本扩展启动：${status.info.owned ? "是" : "否（使用 dshChat.url）"}` : undefined,
        status.detail ? `说明：${status.detail}` : undefined,
        `残留进程：${
          orphans.length
            ? `${orphans.length} 个（pid ${orphans.join("、")}）——用命令「DSH: 清理残留进程」处理`
            : "无"
        }`,
        `进程租约目录：${leaseDirectory()}`,
        `服务器日志：${server.logPath}`,
        `扩展日志：输出通道「DSH Chat」`,
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
      controller.addSelection(name, text);
      void vscode.commands.executeCommand("dshChat.view.focus");
    }),
    vscode.commands.registerCommand("dshChat.addFile", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== "file") return;
      controller.addFileContext(target.fsPath);
      void vscode.commands.executeCommand("dshChat.view.focus");
    }),
    // 目录单独入口：Windows/Linux 的文件对话框不能同时选文件和目录
    // （见 controller.pickFiles 的注释），所以目录走独立命令。
    // 右键文件夹时 uri 直接给到，不再弹对话框。
    vscode.commands.registerCommand("dshChat.addFolder", async (uri?: vscode.Uri) => {
      if (uri) controller.addFileContext(uri.fsPath);
      else await controller.addFolder();
      void vscode.commands.executeCommand("dshChat.view.focus");
    }),

    // 界面相关配置（diff 排版）改了即时生效，不必重载窗口
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("dshChat.diffLayout")) controller.refreshDiffLayout();
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
          `已清理 ${result.killed.length} 个残留的 dsh 服务器进程（上次 VS Code 未正常关闭）。`,
        );
      }
    })
    .catch((error: unknown) => {
      log(`[cleanup] 残留进程检测失败：${error instanceof Error ? error.message : String(error)}`);
    });

  const autoStart = config().get<boolean>("autoStart") ?? true;
  if (autoStart) {
    void controller.ensureConnected();
  } else {
    log("已关闭自动启动，可用命令「DSH: 启动服务器」手动连接。");
  }

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
