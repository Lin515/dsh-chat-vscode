import { randomBytes, randomUUID } from "node:crypto";
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
  /** 编辑区面板的 viewType：也是 VS Code 恢复面板时回传给序列化器的类型名。 */
  static readonly panelViewType = "dshChat.panel";

  private readonly disposables: vscode.Disposable[] = [];
  /** 窗口（viewId）→ 它的 webview。定向投递按这个表找到目标。 */
  private readonly viewWebviews = new Map<string, vscode.Webview>();
  /** 恢复期的兜底定时器：页面迟迟不发 `ready` 时到点也得把会话接回去。 */
  private readonly restoreTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 已经认领过缓存会话的侧栏槽位（每个槽位只认领一次，见 `resolveWebviewView`）。 */
  private readonly sidebarRestored = new Set<string>();

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
    const sidebar = this.kind === "secondary" ? "secondary" : "primary";
    this.controller.bindViewKind(viewId, sidebar);
    // 工作区打开时把**这个侧栏上次开的会话**认下来（真正接回要等页面 ready，
    // 见 controller.resumeRestoreHint）。每个侧栏只认领一次：之后 VS Code 再
    // 实例化视图（用户手动关掉又打开）算新窗口，不该被旧缓存拽回旧会话。
    if (!this.sidebarRestored.has(sidebar)) {
      this.sidebarRestored.add(sidebar);
      this.controller.claimSidebarRestore(viewId, sidebar);
    }
    this.armRestoreFallback(viewId);
    this.log(`[view] ${this.kind} 侧栏视图实例化 viewId=${viewId}`);
    // 侧栏视图变可见视作活动：命令面板入口（新建/历史/加选区…）据此定位窗口。
    // 编辑区面板有同样的处理（见 openPanel），两边口径必须一致
    this.disposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.controller.noteActiveView(viewId);
      }),
    );
  }

  /**
   * 让扩展**接管编辑区聊天面板的恢复**。
   *
   * 面板是 VS Code 的编辑器（`WebviewPanel`），重开工作区时由 VS Code 自己按
   * 当初的排布重建；扩展这边拿到的是一个全新的 `WebviewPanel`，只有靠序列化器
   * 才能挂回事件、把页面填上、把会话接回去。不注册它，恢复出来的面板就是一块
   * 白板（VS Code 把面板恢复了，但我们不认识它）。
   *
   * `activate()` 里**同步**注册：面板恢复可能正是扩展被激活的原因
   * （`onWebviewPanel:dshChat.panel`），晚一步注册就接不到这次恢复。
   *
   * 序列化器是扩展级的（一个 viewType 一个），但面板的挂载只走一处，所以
   * 由传进来的 `owner` 挂——默认 `this`，`openPanel` 的调用方与它保持一致。
   */
  registerPanelSerializer(owner: ChatViewProvider = this): void {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(ChatViewProvider.panelViewType, {
        deserializeWebviewPanel: (panel: vscode.WebviewPanel) => {
          const viewId = owner.attachPanel(panel);
          // 按 VS Code 的恢复顺序对位认领会话（见 dsh/windowState.ts）
          owner.controller.claimPanelRestore(viewId);
          owner.armRestoreFallback(viewId);
          owner.log(`[view] 恢复编辑区面板 viewId=${viewId}`);
          return Promise.resolve();
        },
      }),
    );
  }

  /**
   * 在编辑器区打开一个独立面板；指定会话时面板打开那个会话。
   *
   * `column` 默认 `ViewColumn.Beside`（「在编辑器中打开」＝新开一个分组，与用户正在看的
   * 文件并排）；`focus` 默认 false——**只有编辑器标题栏那条**「在本分组新建对话窗口」
   * 要 `focus: true`（用户 2026-09-15 口径：点了要「跳转」过去）。
   *
   * 返回 `viewId`：调用方可能要往这个新窗口里塞一个**新会话**
   * （`newSessionInGroup` 走 `controller.newSession(viewId)`）。页面还没加载完也没关系
   * ——界面发 `ready` 时宿主会补一份完整快照。
   */
  openPanel(
    sessionId?: string,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
    focus = false,
  ): { panel: vscode.WebviewPanel; viewId: string } {
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.panelViewType,
      "DSH",
      // 只有明确要求「跳转」时才显式写 `preserveFocus: false`；其余调用方照旧直接传一个
      // `ViewColumn`——那种写法的默认聚焦行为没有写进类型声明，别在这条路径上顺手改掉
      // 「在编辑器中打开」原来的行为。
      focus ? { viewColumn: column, preserveFocus: false } : column,
      this.webviewOptions(),
    );
    const viewId = this.attachPanel(panel);
    this.log(`[view] 创建编辑区面板 viewId=${viewId} session=${sessionId ?? "（空态）"}`);
    // 「在编辑器中打开」：调用方带会话时，编辑器窗口打开那个会话（点击动作
    // 来自那个会话所在的窗口）。openSession 绑定后会向这个窗口推完整状态
    // 快照，页面加载早于绑定完成的窗口也会被补上内容
    if (sessionId) void this.controller.openSession(viewId, sessionId);
    // 新面板刻意**不认领**缓存里的会话：缓存属于「上次退出时还开着的那些窗口」，
    // 用户此刻新开一个，就该是空态
    return { panel, viewId };
  }

  /** 挂一个编辑区面板：与侧栏共用 attach，额外登记种类与可见性。 */
  private attachPanel(panel: vscode.WebviewPanel): string {
    const viewId = this.attach(panel.webview, panel.onDidDispose, () =>
      panel.reveal(undefined, false),
    );
    this.controller.bindViewKind(viewId, "panel");
    // 面板变可见时视作活动（命令面板入口「最近活动的窗口」靠它定位）
    this.disposables.push(
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) this.controller.noteActiveView(viewId);
      }),
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    return viewId;
  }

  /**
   * 恢复的兜底：页面迟迟不发 `ready` 时也得把会话接回去。
   *
   * 正常情况下 `ready` 是唯一的接回时机（那一刻绑定，会话内容正好进首帧快照）。
   * 但有两条路会让 `ready` 永远不来：视图在**折叠的侧栏容器**里时 webview 可能
   * 一直不加载；或者认领时工作区身份还没就绪、请求还排着队（`hasPendingRestore`）。
   * 到点后照接不误——`resumeRestoreHint` 是幂等的，`ready` 先到就什么都不做。
   */
  private armRestoreFallback(viewId: string): void {
    if (!this.controller.hasRestoreHint(viewId) && !this.controller.hasPendingRestore(viewId)) return;
    const timer = setTimeout(() => {
      this.restoreTimers.delete(timer);
      if (!this.controller.hasRestoreHint(viewId)) {
        // 认领还排着队（工作区身份一直没就绪）：留一行日志，方便解释
        // 「为什么这个窗口没接回上一次的会话」
        if (this.controller.hasPendingRestore(viewId)) {
          this.log(`[view] ${viewId} 的恢复认领仍未就绪（工作区身份未绑定？）`);
        }
        return;
      }
      this.log(`[view] ${viewId} 迟迟没有 ready，按超时接回会话`);
      void this.controller.resumeRestoreHint(viewId);
    }, RESTORE_READY_TIMEOUT_MS);
    this.restoreTimers.add(timer);
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
        // **接住异常**：`handle` 是 async，帧又来自 webview（形状不受类型系统约束），
        // 一条残缺的帧不该变成扩展宿主里的 unhandled rejection——那既没有全局处理器，
        // 用户也只会看到"某个功能莫名不动了"。记日志、继续服务下一条消息。
        this.controller.handle(message, viewId).catch((error: unknown) => {
          this.log(`[view] 处理界面消息失败（type=${String((message as { type?: unknown })?.type)}）：${String(error)}`);
        });
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
    for (const timer of this.restoreTimers) clearTimeout(timer);
    this.restoreTimers.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.viewWebviews.clear();
  }
}

/**
 * 恢复期等页面 `ready` 的上限。
 *
 * 8 秒是权衡：正常加载远快于此（本机 webview 首帧通常 <1s），而给「视图在折叠
 * 的容器里、webview 迟迟没加载」留出足够的宽限——到点强制接回，最坏结果是
 * 会话已经绑好、用户展开侧栏时页面自己再拉一次快照，不会重复。
 */
const RESTORE_READY_TIMEOUT_MS = 8_000;

function makeNonce(): string {
  // CSP nonce 是安全令牌，用密码学随机源而不是 `Math.random()`
  // （后者的内部状态可从少量输出反推，虽然本页 HTML 是静态模板、当前无可注入点）
  return randomBytes(16).toString("base64");
}
