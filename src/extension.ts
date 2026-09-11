import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";
import { ChatController, stamp } from "./dsh/controller";
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
    log,
  });

  const controller = new ChatController(server, log, context.globalState);
  const provider = new ChatViewProvider(context, controller);

  context.subscriptions.push(
    output ?? vscode.window.createOutputChannel("DSH Chat"),
    controller,
    provider,
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
    vscode.commands.registerCommand("dshChat.showLogs", () => {
      output ??= vscode.window.createOutputChannel("DSH Chat");
      output.show(true);
    }),
    vscode.commands.registerCommand("dshChat.showDiagnostics", async () => {
      const status = server.getStatus();
      const message = [
        `服务器状态：${status.state}`,
        status.info ? `地址：${status.info.baseUrl}` : undefined,
        status.info ? `由本扩展启动：${status.info.owned ? "是" : "否（使用 dshChat.url）"}` : undefined,
        status.detail ? `说明：${status.detail}` : undefined,
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
  );

  // 辅助侧栏容器（secondarySidebar 贡献点）只在 VS Code ≥ 1.106 存在。
  // 活动栏容器用 `when: !dshChat.supportsSecondarySidebar` 与它互斥，
  // 所以这个标记必须按真实版本设置：写死 true 会让旧版本两个容器都不显示。
  void vscode.commands.executeCommand(
    "setContext",
    "dshChat.supportsSecondarySidebar",
    supportsSecondarySidebar(),
  );

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
  // 资源随 context.subscriptions 释放；服务器进程若由本扩展启动，交由 dispose 处理
}
