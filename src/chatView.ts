import * as vscode from "vscode";
import type { HostToWebview, WebviewToHost } from "./shared/ipc";
import { jsonSafeFrame } from "./shared/wire";
import type { ChatController } from "./dsh/controller";

/**
 * 承载自绘界面的 webview。
 *
 * 这里刻意只做三件事：注入带 nonce 的 CSP、加载打包好的 bundle、在宿主与
 * 界面之间转发消息。所有会话逻辑都在 ChatController 里，界面不认识 dsh 协议。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "dshChat.view";
  static readonly secondaryViewType = "dshChat.viewSecondary";

  private readonly disposables: vscode.Disposable[] = [];
  private readonly views = new Set<vscode.Webview>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ChatController,
  ) {
    this.disposables.push(controller.subscribe((frame) => this.broadcast(frame)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview, view.onDidDispose);
  }

  /** 在编辑器区打开一个独立面板。 */
  openPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      "dshChat.panel",
      "DSH",
      vscode.ViewColumn.Beside,
      this.webviewOptions(),
    );
    this.attach(panel.webview, panel.onDidDispose);
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    return panel;
  }

  private webviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
  }

  private attach(
    webview: vscode.Webview,
    onDispose: (listener: () => void) => vscode.Disposable,
  ): void {
    webview.options = this.webviewOptions();
    webview.html = this.html(webview);
    this.views.add(webview);

    this.disposables.push(
      webview.onDidReceiveMessage((message: WebviewToHost) => {
        void this.controller.handle(message);
      }),
      onDispose(() => this.views.delete(webview)),
    );
  }

  private broadcast(frame: HostToWebview): void {
    // ✅ 过线前必须过一遍 jsonSafeFrame：VS Code 把 webview 消息 `JSON.stringify`
    // 过（见 shared/wire.ts 的模块注释），原样发的话「清空某字段」的 patch
    // 会因为值是 undefined 而被整条丢掉，界面永远停在旧值上。
    const wire = jsonSafeFrame(frame);
    for (const view of this.views) void view.postMessage(wire);
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>DSH</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.views.clear();
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
