import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { HostToWebview, WebviewToHost } from "./shared/ipc";
import { jsonSafeFrame } from "./shared/wire";
import type { ChatController } from "./dsh/controller";

/**
 * 承载自绘界面的 webview。
 *
 * 这里刻意只做三件事：注入带 nonce 的 CSP、加载打包好的 bundle、在宿主与
 * 界面之间转发消息。所有会话逻辑都在 ChatController 里，界面不认识 dsh 协议。
 *
 * 多窗口互不同步：每个 webview 有自己唯一的 `viewId`，控制器据此让每个窗口
 * 绑定**各自**的会话（`controller.bindView/handle/unbindView`）。全局帧
 * （连接、会话列表……）发给所有窗口；会话帧只发给绑定那个会话的窗口。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "dshChat.view";
  static readonly secondaryViewType = "dshChat.viewSecondary";

  private readonly disposables: vscode.Disposable[] = [];
  /** 窗口（viewId）→ 它的 webview。定向投递按这个表找到目标。 */
  private readonly viewWebviews = new Map<string, vscode.Webview>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ChatController,
    /** 日志用标识：primary（主侧栏）/ secondary（辅助侧栏）/ panel（编辑区面板的宿主实例） */
    private readonly kind: string = "view",
    private readonly log: (line: string) => void = () => {},
  ) {
    this.disposables.push(controller.subscribe((target, frame) => this.deliver(target, frame)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // VS Code 实例化侧栏视图时才会走到这里——多出一个侧栏 DSH 视图必然是
    // 某个时刻调用了这里，日志用于定位是谁/何时触发的
    //
    // reveal 用 `view.show()`：侧栏视图的「带到前台」就是它（面板那侧是
    // `panel.reveal()`）。命令入口靠这个把焦点还给「你上次用的那个对话窗口」。
    const viewId = this.attach(view.webview, view.onDidDispose, () => view.show());
    this.log(`[view] ${this.kind} 侧栏视图实例化 viewId=${viewId}`);
    // 侧栏视图变可见视作活动：命令面板入口（新建/历史/加选区…）据此定位窗口。
    // 编辑区面板有同样的处理（见 openPanel），两边口径必须一致
    this.disposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.controller.noteActiveView(viewId);
      }),
    );
  }

  /** 在编辑器区打开一个独立面板；指定会话时面板打开那个会话。 */
  openPanel(sessionId?: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      "dshChat.panel",
      "DSH",
      vscode.ViewColumn.Beside,
      this.webviewOptions(),
    );
    const viewId = this.attach(panel.webview, panel.onDidDispose, () =>
      panel.reveal(undefined, false),
    );
    this.log(`[view] 创建编辑区面板 viewId=${viewId} session=${sessionId ?? "（空态）"}`);
    // 「在编辑器中打开」：调用方带会话时，编辑器窗口打开那个会话（点击动作
    // 来自那个会话所在的窗口）。openSession 绑定后会向这个窗口推完整状态
    // 快照，页面加载早于绑定完成的窗口也会被补上内容
    if (sessionId) void this.controller.openSession(viewId, sessionId);
    // 面板变可见时视作活动（命令面板入口「最近活动的窗口」靠它定位）
    this.disposables.push(
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) this.controller.noteActiveView(viewId);
      }),
    );
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

  /** 挂一个新窗口：铸一个 viewId 并登记到控制器。 */
  private attach(
    webview: vscode.Webview,
    onDispose: (listener: () => void) => vscode.Disposable,
    /** 把这个窗口带到前台（侧栏视图 `show()` / 编辑区面板 `reveal()`）。 */
    reveal: () => void,
  ): string {
    const viewId = randomUUID();
    webview.options = this.webviewOptions();
    webview.html = this.html(webview);
    this.viewWebviews.set(viewId, webview);
    this.controller.bindView(viewId);
    this.controller.registerRevealer(viewId, reveal);

    this.disposables.push(
      webview.onDidReceiveMessage((message: WebviewToHost) => {
        // 任何来自窗口的消息都算它的活动；指令按这个窗口路由
        this.controller.noteActiveView(viewId);
        void this.controller.handle(message, viewId);
      }),
      onDispose(() => {
        this.viewWebviews.delete(viewId);
        this.controller.unbindView(viewId);
      }),
    );
    return viewId;
  }

  /**
   * 宿主 → 窗口的投递：`"all"` 广播给所有窗口，其余值按 viewId 定向发给单个窗口。
   */
  private deliver(target: "all" | string, frame: HostToWebview): void {
    // ✅ 过线前必须过一遍 jsonSafeFrame：VS Code 把 webview 消息 `JSON.stringify`
    // 过（见 shared/wire.ts 的模块注释），原样发的话「清空某字段」的 patch
    // 会因为值是 undefined 而被整条丢掉，界面永远停在旧值上。
    const wire = jsonSafeFrame(frame);
    if (target === "all") {
      for (const view of this.viewWebviews.values()) void view.postMessage(wire);
      return;
    }
    void this.viewWebviews.get(target)?.postMessage(wire);
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
    this.viewWebviews.clear();
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
