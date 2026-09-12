import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type {
  Attachment,
  ChatState,
  CommandView,
  DiffLayout,
  JobItemView,
  ModelSelectionView,
  ProviderGroupView,
  QuestionView,
  QueuedMessageView,
  SessionSummaryView,
  SubagentView,
  UploadState,
} from "../shared/chat";
import type { HostToWebview, WebviewToHost } from "../shared/ipc";
import { SessionAdapter, type ImageRef } from "./adapter";
import { classifyPath, formatPathList, isDirectoryPath, isImagePath } from "./attachments";
import { composeWithReferences, formatFileMention } from "./references";
import { resolveForVsCode } from "./hostText";
import { DshApiError, DshAuthError, DshClient, type ConnectionState, type SessionSummaryWire } from "./client";
import type { RemoteEventFrame, RemoteEventWaterfall, SessionControlFrame } from "./protocol";
import { ServerManager, type ServerInfo, type ServerStatus } from "./serverManager";
import { queueItems, type QueueOrigin } from "./queueView";
import { goalFromProjection, planModeFromProjection, subagentsFromCatalog, subagentsFromList } from "./projections";
import { buildSettingsSection } from "./settingsSchema";

/**
 * SecretStorage 里存「外部服务器会话 cookie」的 key 前缀。
 *
 * 存 cookie 而不是启动令牌，是因为二者的生命周期完全不同（实测见
 * `scripts/cookieSurvivesRestart.ts`）：
 * - 启动令牌是 `randomBytes(32)` 按进程生成的，**每次 `dsh web` 启动都会刷新**，
 *   存下来下次必然失效；
 * - cookie 的签名密钥存在服务端凭据库里（`client-connection.browser-session`，
 *   跨重启不变，`cookieMaxAgeDays` 默认 30 天），cookie 只绑定 authority 与有效期，
 *   所以同一个地址的服务器**重启后 cookie 依然有效**。
 *
 * 按 baseUrl 分键：不同地址的服务器各有各的会话。
 */
const SESSION_SECRET_PREFIX = "dshChat.session.";

/** 早期版本把启动令牌存进了 SecretStorage；存它没有意义，激活时清掉。 */
const LEGACY_TOKEN_SECRET = "dshChat.externalAccessToken";

function sessionSecretKey(baseUrl: string): string {
  return `${SESSION_SECRET_PREFIX}${baseUrl}`;
}

/** 提交记录（用于队列「重新编辑」还原原文）的保留时长与条数上限。 */
const SUBMISSION_TTL_MS = 30 * 60 * 1000;
const MAX_SUBMISSIONS = 50;

/** 读取编辑节点 diff 的排版设置（auto / unified / split，缺省自适应）。 */
function readDiffLayout(): DiffLayout {
  const value = vscode.workspace.getConfiguration("dshChat").get<string>("diffLayout");
  return value === "unified" || value === "split" ? value : "auto";
}

/**
 * 界面语言（`dshChat.language`）。
 *
 * `auto` 交给 VS Code 的显示语言；否则固定。返回的是**语言标识**（不是一个
 * 布尔），界面侧用 `normalizeLocale` 归一化——这样加第三种语言时只改词典。
 */
function readLanguage(): string {
  const value = vscode.workspace.getConfiguration("dshChat").get<string>("language");
  if (value === "zh-cn" || value === "en") return value;
  return vscode.env.language;
}

/**
 * 界面字号档位（`dshChat.fontSize`）。
 *
 * `auto` 下界面用 VS Code 注入的 `--vscode-font-size`；固定档位时下发基准像素，
 * 界面写进 `--font-size` 覆盖它。用字符串档位而不是数字：字号是**设计尺度**，
 * 让人直接填 13.5px 只会做出越界的排版。
 */
function readFontSize(): "auto" | "small" | "medium" | "large" {
  const value = vscode.workspace.getConfiguration("dshChat").get<string>("fontSize");
  return value === "small" || value === "medium" || value === "large" ? value : "auto";
}

/** 字号档位 → 基准像素（与 VS Code 的默认 13px 对齐）。 */
const FONT_SIZE_PX: Record<"small" | "medium" | "large", number> = {
  small: 12,
  medium: 13,
  large: 15,
};

/** 把投影里的未知值收成数字（缺字段/坏值一律用回退值）。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 同上，但没有回退值：缺字段/坏值一律 undefined（用于「可缺」的投影字段）。 */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 服务器 → webview 的会话内容总控。 */
export class ChatController implements vscode.Disposable {
  private client: DshClient | undefined;
  private adapter: SessionAdapter | undefined;
  private sessions: SessionSummaryView[] = [];
  private currentSessionId: string | undefined;
  private followHandle: { cancel(): void } | undefined;
  private controlHandle: { cancel(): void } | undefined;
  private eventsHandle: { cancel(): void } | undefined;
  private eventsClientId: string | undefined;
  private readonly handledEvents = new Set<string>();
  private workspaceHandle: { cancel(): void } | undefined;
  /** 已归档会话的权威集合（来自 workspace/follow 流）。 */
  private archivedSessionIds = new Set<string>();
  /**
   * 本地已删除的会话 id 集合（持久化于 globalState 的 `deletedSessionIds`）。
   *
   * 服务端**没有**会话删除/detach API：当前 dsh 进程打开过的会话常驻服务端内存
   * 直到进程退出，删掉本地日志目录后 `session/list` 仍会列出它们。扩展因此把
   * 删除过的 id 持久化下来，从历史/归档两个列表里永久过滤，界面不再显示。
   */
  private readonly deletedSessionIds: Set<string>;
  /**
   * 草稿与附件按会话隔离：切换会话时输入框文本与附件芯片一起切换。
   * 无当前会话时挂在空 key 上（连接建立前暂存）。
   */
  private readonly drafts = new Map<string, string>();
  private readonly attachmentsBySession = new Map<string, Attachment[]>();
  private models: ProviderGroupView[] = [];
  private model: ModelSelectionView | undefined;
  private running = false;
  private permission: string | undefined;
  private planMode = false;
  private todos: ChatState["todos"] = [];
  private subagents: SubagentView[] = [];
  private jobs: JobItemView[] = [];
  private queueItems: QueuedMessageView[] = [];
  /**
   * 已提交但可能还排在队列里的消息：requestId → 用户当时真正输入的内容。
   *
   * 为什么不能直接用队列回显：提交给服务端的正文里已经把文件/目录上下文
   * 内联进去了（见 `buildContextText`），图片则是独立的内容块。用回显文本
   * 「重新编辑」会把整段内联上下文倒回输入框。这里按 requestId 存原文，
   * 队列帧带回 `rpcId` 时就能对回去。
   */
  private readonly submissions = new Map<
    string,
    { text: string; attachments: Attachment[]; content: unknown[]; at: number }
  >();
  /** 队列项 id → 它的原始输入（每次队列帧到达时按 rpcId 重建）。 */
  private readonly queueOrigin = new Map<string, QueueOrigin>();
  /** 上下文构成与会话统计（投影值），存下来供首帧快照使用。 */
  private contextBreakdown: ChatState["contextBreakdown"];
  private sessionStats: ChatState["sessionStats"];
  /** 全日志累计的四桶用量（`tokenUsage` 投影）。 */
  private tokenUsage: ChatState["tokenUsage"];
  /** 轮次导航（`turnOutline` 投影）。 */
  private turnOutline: ChatState["turnOutline"];
  /** 图片准入上限（`imageLimits` 投影）。 */
  private imageLimits: ChatState["imageLimits"];
  private goal: ChatState["goal"];
  private connection: ConnectionState | "error" = "connecting";
  private connectionDetail: string | undefined;
  /** 上次连接因缺少/拒绝令牌失败：界面据此给出「输入令牌」入口。 */
  private needsToken = false;
  private disposed = false;

  private readonly listeners = new Set<(frame: HostToWebview) => void>();

  constructor(
    private readonly server: ServerManager,
    private readonly log: (line: string) => void,
    private readonly state: vscode.Memento,
    /** 外部服务器会话 cookie 的存放处（SecretStorage，不落明文配置）。 */
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.deletedSessionIds = new Set(this.state.get<string[]>("deletedSessionIds") ?? []);
    // 早期版本存过启动令牌；令牌每次启动都会刷新，留着只会误导，直接清掉
    void this.secrets.delete(LEGACY_TOKEN_SECRET);
  }

  // ---------- 订阅与广播 ----------

  subscribe(listener: (frame: HostToWebview) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private emit(frame: HostToWebview): void {
    // 顺带把「是否正在生成」同步到控制器自己：宿主状态（首帧快照、ESC 处理）
    // 依赖它，而 turn/start 与 turn/end 只由适配器发出 patch
    if (frame.type === "patch" && typeof frame.patch.running === "boolean") {
      this.running = frame.patch.running;
    }
    for (const listener of this.listeners) listener(frame);
  }

  private workspacePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : process.cwd();
  }

  /** 当前会话的草稿 / 附件键（无会话时空串）。 */
  private sessionKey(): string {
    return this.currentSessionId ?? "";
  }

  private attachmentsNow(): Attachment[] {
    return this.attachmentsBySession.get(this.sessionKey()) ?? [];
  }

  /** 修改当前会话的附件并同步给界面。 */
  private mutateAttachments(fn: (list: Attachment[]) => void): void {
    const key = this.sessionKey();
    const list = this.attachmentsBySession.get(key) ?? [];
    fn(list);
    this.attachmentsBySession.set(key, list);
    this.emit({ type: "patch", patch: { attachments: [...list] } });
  }

  /** 给新连接的 webview 的首帧快照。 */
  snapshot(): ChatState {
    return {
      connection: this.connection === "error" ? "error" : this.connection === "connected" ? "ready" : "connecting",
      connectionDetail: this.connectionDetail,
      /** 外部服务器缺令牌：界面给「输入令牌」按钮。 */
      needsToken: this.needsToken || undefined,
      serverUrl: this.client?.baseUrl,
      locale: readLanguage(),
      /** 编辑类节点的 diff 排版（auto / unified / split）。 */
      diffLayout: readDiffLayout(),
      /** 字号档位（auto = 跟随 VS Code）；界面换算成 --font-size。 */
      fontSize: readFontSize(),
      fontSizePx: readFontSize() === "auto" ? undefined : FONT_SIZE_PX[readFontSize() as "small" | "medium" | "large"],
      session: this.sessions.find((session) => session.id === this.currentSessionId),
      messages: this.adapter?.snapshotMessages() ?? [],
      running: this.running,
      queueItems: this.queueItems,
      attachments: this.attachmentsNow(),
      draft: this.drafts.get(this.sessionKey()) ?? "",
      models: this.models,
      model: this.model,
      permission: this.permission,
      planMode: this.planMode,
      todos: this.todos,
      subagents: this.subagents,
      jobs: this.jobs,
      goal: this.goal,
      // 会话内的粘性显示值：首帧快照必须带上，否则 webview 一重载，上下文占用/
      // 速度/构成/统计就空到下一轮才有数据（表现为「时有时无」）
      ...(this.adapter?.stickyState() ?? {}),
      contextBreakdown: this.contextBreakdown,
      sessionStats: this.sessionStats,
      tokenUsage: this.tokenUsage,
      turnOutline: this.turnOutline,
      imageLimits: this.imageLimits,
    };
  }

  // ---------- 连接 ----------

  async ensureConnected(): Promise<void> {
    if (this.disposed) return;
    if (this.client && this.connection === "connected") return;
    this.setConnection("connecting");
    try {
      const info = await this.server.ensure();
      const client = info.owned ? await this.openOwnedClient(info) : await this.openExternalClient(info);
      client.onDidChangeState((state) => {
        this.setConnection(state === "connected" ? "connected" : state === "connecting" ? "connecting" : "error", state === "disconnected" ? "@connectionLost" : undefined);
        if (state === "connected") void this.onConnected();
      });
      this.client = client;
      client.connect();
      await this.loadModels();
      await this.refreshSessions();
      this.setConnection("connected");
      if (!this.currentSessionId) await this.newSession();
    } catch (error) {
      // 外部服务器要求授权：记下标记，界面显示「输入令牌」入口
      if (error instanceof DshAuthError && this.server.externalUrl) this.setNeedsToken(true);
      const detail = this.describeError(error);
      this.log(`[connect] 失败：${detail}`);
      this.setConnection("error", detail);
    }
  }

  /** 自管服务器：启动令牌来自子进程日志，认证失败只能如实报错。 */
  private async openOwnedClient(info: ServerInfo): Promise<DshClient> {
    const client = new DshClient(info.baseUrl, info.token, this.log);
    await client.authenticate();
    return client;
  }

  /**
   * 外部服务器（`dshChat.url`）：可能要求访问令牌。
   *
   * 两级尝试：
   * 1. **上次换来的会话 cookie**（SecretStorage）——服务器重启后依然有效，
   *    所以重启用户自己的 `dsh web` 不会反复要令牌；cookie 过期或被拒才往下走；
   * 2. **启动令牌**——用一次换 cookie 并落盘。没带令牌先按「无认证服务器」试，
   *    401 时再弹输入框；用户取消就记下 needsToken，交给界面给入口。
   */
  private async openExternalClient(info: ServerInfo): Promise<DshClient> {
    const key = sessionSecretKey(info.baseUrl);

    // 1) 复用已保存的会话
    const saved = await this.secrets.get(key);
    if (saved) {
      const client = new DshClient(info.baseUrl, undefined, this.log);
      client.useSessionCookie(saved);
      try {
        await client.listSessions();
        this.setNeedsToken(false);
        this.log("[auth] 复用已保存的会话 cookie");
        return client;
      } catch (error) {
        client.dispose();
        if (!(error instanceof DshAuthError)) throw error;
        // 会话过期（默认 30 天）或服务端换了 DSH home：删掉，回落到令牌
        await this.secrets.delete(key);
        this.log("[auth] 已保存的会话已失效，改用启动令牌");
      }
    }

    // 2) 用启动令牌换 cookie；被拒就弹输入框
    let token: string | undefined;
    let retry = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = new DshClient(info.baseUrl, token, this.log);
      try {
        await client.authenticate();
        // authenticate 只换 cookie；真正的鉴权探测要打一次 /api
        await client.listSessions();
        const cookie = client.sessionCookie;
        if (cookie) await this.secrets.store(key, cookie);
        this.setNeedsToken(false);
        return client;
      } catch (error) {
        client.dispose();
        if (!(error instanceof DshAuthError)) throw error;
        const entered = await this.promptForToken(info.baseUrl, retry);
        if (!entered) {
          this.setNeedsToken(true);
          throw error;
        }
        token = entered;
        retry = true;
      }
    }
    throw new DshAuthError("访问令牌连续被拒，请确认用的是 dsh web 最新打印的 URL。");
  }

  /**
   * 弹窗要求输入访问令牌。
   *
   * `retry` 为真表示上一次输入的没通过（或本地会话已失效）。
   */
  private async promptForToken(baseUrl: string, retry: boolean): Promise<string | undefined> {
    const entered = await vscode.window.showInputBox({
      title: retry
        ? vscode.l10n.t("Access token rejected")
        : vscode.l10n.t("The DSH server requires an access token"),
      prompt: retry
        ? vscode.l10n.t(
            "The server {0} rejected the previous token. Paste the token printed in the URL when dsh web started (the part after ?token=).",
            baseUrl,
          )
        : vscode.l10n.t(
            "The server {0} requires authorization. Paste the token printed in the URL when dsh web started (the part after ?token=; the token is refreshed on every restart, but this extension remembers the session once it is accepted, so you will not have to enter it again).",
            baseUrl,
          ),
      placeHolder: "token",
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim() ? undefined : vscode.l10n.t("The token cannot be empty")),
    });
    return entered?.trim() || undefined;
  }

  /**
   * 手动输入 / 替换外部服务器访问令牌（命令面板与连接失败提示条共用）。
   *
   * 校验通过后立即换成会话 cookie 落盘，所以这个命令的实际语义是
   * 「重新建立会话」——用户只需在令牌刷新后输一次。
   */
  async setToken(): Promise<void> {
    const baseUrl = this.server.externalUrl;
    if (!baseUrl) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "No external DSH server is configured (dshChat.url): the extension starts the server itself, so the token is obtained automatically and does not need to be entered.",
        ),
      );
      return;
    }
    const entered = await this.promptForToken(baseUrl, this.needsToken);
    if (!entered) return;

    const probe = new DshClient(baseUrl, entered, this.log);
    try {
      await probe.authenticate();
      await probe.listSessions();
      const cookie = probe.sessionCookie;
      if (cookie) await this.secrets.store(sessionSecretKey(baseUrl), cookie);
    } catch (error) {
      this.setNeedsToken(true);
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Token check failed: {0}", this.describeError(error)),
      );
      return;
    } finally {
      probe.dispose();
    }

    // 已建立的连接带着旧会话，重新走一遍连接流程
    this.teardownStreams();
    this.client?.dispose();
    this.client = undefined;
    this.connection = "connecting";
    await this.ensureConnected();
  }

  private setNeedsToken(needed: boolean): void {
    if (this.needsToken === needed) return;
    this.needsToken = needed;
    this.emit({ type: "patch", patch: { needsToken: needed } });
  }

  /** 配置里改了 diff 排版：直接推给界面，不必重载 webview。 */
  refreshDiffLayout(): void {
    this.emit({ type: "patch", patch: { diffLayout: readDiffLayout() } });
  }

  /**
   * 配置里改了语言或字号：推给界面。
   *
   * 两者都**不需要**重载 webview：语言是纯词典切换（界面用 `locale` 选字典），
   * 字号是写一个 CSS 变量。重载会丢掉滚动位置与展开状态，代价不成比例。
   */
  refreshAppearance(): void {
    const fontSize = readFontSize();
    this.emit({
      type: "patch",
      patch: {
        locale: readLanguage(),
        fontSize,
        fontSizePx: fontSize === "auto" ? undefined : FONT_SIZE_PX[fontSize],
      },
    });
  }

  private async onConnected(): Promise<void> {
    // socket 重建后长活流都要重开
    if (this.currentSessionId) this.follow(this.currentSessionId);
    this.openControlStream();
    this.openEventsStream();
    this.openWorkspaceStream();
  }

  private setConnection(state: ConnectionState | "error", detail?: string): void {
    this.connection = state;
    this.connectionDetail = detail;
    this.emit({
      type: "patch",
      patch: {
        connection: state === "error" ? "error" : state === "connected" ? "ready" : "connecting",
        connectionDetail: detail,
        serverUrl: this.client?.baseUrl,
      },
    });
  }

  /**
   * 把异常翻译成**语言中立的 `@key` 标记**，交给 webview 按用户选的界面语言渲染
   * （`describeError` 的结果会进 `connectionDetail`，见 `setConnection`）。
   *
   * `DshAuthError` 的原始 message 是诊断用的（日志里能看），面向用户的两句话由
   * 这里按「外部服务器 / 自管服务器」分成两个标记——用户真正需要知道的是**下一步
   * 该做什么**，而不是哪个 HTTP 状态码。
   *
   * 注意：同一条返回值也会经 `reportError` 走到 VS Code 的通知里，那边由
   * `resolveForVsCode` 按 VS Code 自己的显示语言解析（见 `hostText.ts`）。
   */
  private describeError(error: unknown): string {
    if (error instanceof DshAuthError) {
      if (this.server.externalUrl) {
        return "@authNeedsToken";
      }
      return "@authTokenRejected";
    }
    if (error instanceof DshApiError) return `${error.message}（${error.code}）`;
    return error instanceof Error ? error.message : String(error);
  }

  async restart(): Promise<void> {
    this.log("[server] 重启");
    this.teardownStreams();
    this.client?.dispose();
    this.client = undefined;
    await this.server.restart();
    await this.ensureConnected();
    vscode.window.showInformationMessage(vscode.l10n.t("The DSH server has been restarted."));
  }

  /** 服务器状态变化时同步给界面。 */
  onServerStatus(status: ServerStatus): void {
    if (status.state === "failed" && status.detail) {
      this.setConnection("error", status.detail);
    }
  }

  // ---------- 会话 ----------

  /** 命令面板入口「DSH: 历史对话」：刷新列表并让界面切到历史抽屉。 */
  async openHistory(): Promise<void> {
    await this.refreshSessions();
    this.emit({ type: "ui/openPanel", panel: "history" });
  }

  async refreshSessions(): Promise<void> {
    if (!this.client) return;
    try {
      const value = await this.client.listSessions();
      // 只显示属于**当前工作区**的会话（dsh web 可能为多个项目开过会话，
      // 跨项目会话混进来会既占列表又会因 cwd 不匹配导致 resume 失败）
      const workspace = this.workspacePath().replace(/\\/g, "/").toLowerCase();
      const currentCwd = this.sessions.find((s) => s.id === this.currentSessionId)?.cwd?.replace(/\\/g, "/").toLowerCase();
      this.sessions = (value.items ?? [])
        // 本地删过的会话若被当前 dsh 进程打开过，仍会留在服务端内存里被
        // session/list 列出——按持久化的删除集合过滤，保证界面干净
        .filter((item) => !this.deletedSessionIds.has(item.sessionId))
        .filter((item) => !item.origin && !item.parentSessionId)
        .filter((item) => {
          if (!item.cwd) return false;
          const cwd = item.cwd.replace(/\\/g, "/").toLowerCase();
          return cwd === workspace || (currentCwd !== undefined && cwd === currentCwd);
        })
        .map((item) => this.toSessionView(item));
      this.emitSessionLists();
    } catch (error) {
      this.log(`[sessions] 列表获取失败：${this.describeError(error)}`);
    }
  }

  /** 真正展示给界面的两个列表：历史列表（滤掉已归档会话）与归档列表。 */
  private emitSessionLists(): void {
    const active: SessionSummaryView[] = [];
    const archived: SessionSummaryView[] = [];
    for (const session of this.sessions) {
      (this.archivedSessionIds.has(session.id) ? archived : active).push(session);
    }
    this.emit({ type: "sessions", sessions: active });
    this.emit({ type: "archivedSessions", sessions: archived });
  }

  /**
   * 归档：服务端把会话从工作区分组移出。权威状态经 workspace/follow 流的
   * `archived` 增量回到这里，列表自动刷新；兜底再拉一次列表（增量延迟时）。
   */
  private async archiveSession(sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.archiveSession(sessionId);
      this.archivedSessionIds.add(sessionId);
      this.emitSessionLists();
      setTimeout(() => void this.refreshSessions(), 500);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to archive the session"), error);
    }
  }

  /**
   * 删除会话。服务端**没有**删除/detach API（会话日志文件只增不减），这里
   * 直接删除本地日志目录：`~/.dsh/sessions/<工作区>/session-<会话id>`（目录名
   * 就是会话 id，见日志文件头 `id` 字段），并把会话 id 记入 `deletedSessionIds`
   * （持久化）：被当前 dsh 进程打开过的会话常驻服务端内存、`session/list` 会
   * 一直列出它，客户端必须过滤才能让列表干净。
   *
   * 日志目录已不存在（此前已删过）时同样记录 id 并清理列表——那次删除已经把
   * 文件删掉了，这里不再报错。
   *
   * 保护：运行中的会话不能删（服务端还在往里写）；当前正在跟随的会话不能删
   * （删完无处可看，且服务端内存里还开着它）。
   */
  private async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      this.log(`[sessions] 删除失败：列表中不存在会话 ${sessionId}`);
      return;
    }
    if (session.running) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("This session is running and cannot be deleted."),
      );
      return;
    }
    if (sessionId === this.currentSessionId) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Cannot delete the session you are currently viewing; switch to another session first."),
      );
      return;
    }
    const dir = this.findSessionDir(sessionId);
    let removed = false;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed = true;
        this.log(`[sessions] 已删除会话日志：${dir}`);
      } catch (error) {
        this.reportError(vscode.l10n.t("Failed to delete the session"), error);
        return;
      }
    }
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.rememberDeleted(sessionId);
    this.emitSessionLists();
    if (!removed) {
      this.log(
        `[sessions] 会话 ${sessionId} 的日志目录已不存在，已从列表中移除（服务端内存中的副本仍存活到 dsh 进程退出）`,
      );
    }
  }

  /** 记住一个已删除的会话 id 并持久化（跨扩展重载，列表保持干净）。 */
  private rememberDeleted(sessionId: string): void {
    if (this.deletedSessionIds.has(sessionId)) return;
    this.deletedSessionIds.add(sessionId);
    void this.state.update("deletedSessionIds", [...this.deletedSessionIds]);
  }

  /** 在 `~/.dsh/sessions` 的各工作区子目录里找会话日志目录（目录名=会话 id）。 */
  private findSessionDir(sessionId: string): string | undefined {
    const root = join(homedir(), ".dsh", "sessions");
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, sessionId);
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // 不在这个工作区，继续
      }
    }
    return undefined;
  }

  private toSessionView(item: SessionSummaryWire): SessionSummaryView {
    const title = item.projections?.values?.title;
    return {
      id: item.sessionId,
      // 标题留空表示「还没生成标题」，由界面按当前语言回退为「未命名对话」；
      // 宿主不写死文案，否则会漏进另一种语言的界面
      title: typeof title === "string" ? title : "",
      updatedAt: item.updatedAt ?? Date.now(),
      cwd: item.cwd,
      running: Boolean(item.running),
      blank: item.blank,
    };
  }

  async newSession(): Promise<void> {
    if (!this.client) return;
    try {
      const created = await this.client.createSession(this.workspacePath());
      this.currentSessionId = created.sessionId;
      this.follow(created.sessionId);
      await this.refreshSessions();
      this.clearStickySessionState();
      this.emit({ type: "messages/reset", messages: [] });
      this.emit({ type: "todos", todos: [] });
      this.emit({
        type: "patch",
        patch: {
          session: this.sessions.find((s) => s.id === created.sessionId) ?? {
            id: created.sessionId,
            title: "",
            updatedAt: Date.now(),
            running: false,
          },
          running: false,
          // 新会话的草稿与附件天然是空的，显式下发让输入框复位
          draft: this.drafts.get(created.sessionId) ?? "",
          attachments: this.attachmentsBySession.get(created.sessionId) ?? [],
          // 上一会话的投影与队列残留清掉（新会话队列必为空）
          ...this.clearedStickyPatch(),
          queueItems: [],
        },
      });
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to create a session"), error);
    }
  }

  async openSession(sessionId: string): Promise<void> {
    this.currentSessionId = sessionId;
    this.follow(sessionId);
    // 重开控制流拿新会话的 baseline（队列/任务/投影），否则旧会话的队列残留
    this.openControlStream();
    this.clearStickySessionState();
    this.emit({
      type: "patch",
      patch: {
        session: this.sessions.find((s) => s.id === sessionId),
        // 输入框内容跟随会话切换
        draft: this.drafts.get(sessionId) ?? "",
        attachments: this.attachmentsBySession.get(sessionId) ?? [],
        // 上一会话的粘性显示值清掉，等新会话的 snapshot/baseline 回填
        ...this.clearedStickyPatch(),
      },
    });
  }

  /** 切换会话时清掉控制器侧存的投影值（新会话由新适配器/投影重新填）。 */
  private clearStickySessionState(): void {
    this.contextBreakdown = undefined;
    this.sessionStats = undefined;
    this.tokenUsage = undefined;
    this.turnOutline = undefined;
    this.imageLimits = undefined;
  }

  /** 切换会话时一并把界面上的粘性显示值清空。 */
  private clearedStickyPatch(): Pick<
    ChatState,
    | "contextBreakdown"
    | "sessionStats"
    | "contextOccupancy"
    | "contextWindow"
    | "lastSpeed"
    | "tokenUsage"
    | "turnOutline"
    | "imageLimits"
  > {
    return {
      contextBreakdown: undefined,
      sessionStats: undefined,
      contextOccupancy: undefined,
      contextWindow: undefined,
      lastSpeed: undefined,
      tokenUsage: undefined,
      turnOutline: undefined,
      imageLimits: undefined,
    };
  }

  private follow(sessionId: string): void {
    if (!this.client) return;
    this.followHandle?.cancel();
    const adapter = new SessionAdapter((frame) => this.emit(frame));
    // 图片句柄 → 字节：`read_image` 的 image 块只给不透明 attachmentId，
    // 要经 `session/attachment` 换成 base64 才能显示。适配器不持有网络客户端，
    // 所以在这里注入。
    adapter.loadImages = (refs, done) => {
      void this.loadAttachmentImages(sessionId, refs, done);
    };
    adapter.setSession(
      this.sessions.find((s) => s.id === sessionId) ?? {
        id: sessionId,
        title: "",
        updatedAt: Date.now(),
        running: false,
      },
    );
    this.adapter = adapter;
    // 命令目录随会话预取：手打的 `/xxx` 要靠它才能被路由到命令通道，
    // 不能等输入 `/` 弹出候选时才拉（粘贴一行后立刻回车就赶不上了）
    void this.listCommands();
    this.followHandle = this.client.followSession(sessionId, {
      onItem: (value) => {
        const frame = value as { type?: string; projections?: { values?: Record<string, unknown> } };
        // **顺序很重要**：先让适配器回放历史记录，再铺开投影值。
        // 投影是「截至 asOfSeq 的折叠结果」，永远比记录里的事件新；反过来先铺投影
        // 再回放，历史里最后一个事件会把折叠值**覆盖回旧状态**——`plan` 就是活例：
        // 一次轮次进行中发出的 `/plan` 只留下 `pending`，日志里没有对应的
        // `plan/mode`，于是回放末尾那条旧的 `plan/mode` 会把界面上的计划模式关掉，
        // 每次重开会话都复现。
        adapter.applyFrame(value as never);
        if (frame?.type === "snapshot") {
          for (const [key, projectionValue] of Object.entries(frame.projections?.values ?? {})) {
            this.applyProjection(key, projectionValue);
          }
        }
      },
      onError: () => {
        // socket 断开重连后会由 onConnected 重开
      },
    });
  }

  /**
   * 把 durable 图片句柄换成可显示的 data URL。
   *
   * `session/attachment` 返回 `{attachment, data: <base64>}`——`attachmentId` 是
   * 不透明存储标识（`sha256:…`），既不是路径也不是 URL，只能用这条 RPC 取字节。
   * 失败时不抛：一张图取不到不该影响整条消息的渲染，退回空数组（界面不显示图）。
   */
  private async loadAttachmentImages(
    sessionId: string,
    refs: ImageRef[],
    done: (dataUrls: string[]) => void,
  ): Promise<void> {
    if (!this.client) {
      done([]);
      return;
    }
    const results = await Promise.all(
      refs.map(async (ref) => {
        try {
          const value = await this.client!.request<{ attachment?: unknown; data?: unknown }>(
            "session/attachment",
            { request: { sessionId, attachmentId: ref.attachmentId } },
          );
          const data = typeof value?.data === "string" ? value.data : "";
          if (!data) return "";
          // 服务端只回 base64 与字节，媒体类型在句柄里（拿不到就按 png——
          // 浏览器对 data URL 的 MIME 很宽容，错的类型仍会渲染）
          const mediaType = ref.mediaType ?? "image/png";
          return `data:${mediaType};base64,${data}`;
        } catch (error) {
          this.log(`[attachment] 读取图片失败：${this.describeError(error)}`);
          return "";
        }
      }),
    );
    done(results.filter((url) => url !== ""));
  }

  /**
   * 加载更早的历史（`session/page`）。
   *
   * 为什么需要它：跟随流开窗只带 `maxMessages` 条（默认 60），更早的内容**根本
   * 没进过客户端**——不是被清理了，而是从来没取过。此前这个入口在协议层有
   * （`loadMore` 消息类型、`client.page()`）但**没有任何地方接上**，于是用户
   * 「较早的信息都翻不到」（2026-09-12 反馈）。
   *
   * 两个参数都有硬约束：
   * - `throughSeq` **必须**来自同一次 `session/follow` 开帧的 `snapshot.cursor`，
   *   从别处拿会校验失败——所以由适配器记着（`cursor()`）；
   * - `beforeSeq` 取当前已折叠事件的最小 seq，服务端只回它之前的那一页。
   */
  private async loadMore(): Promise<void> {
    if (!this.client || !this.currentSessionId || !this.adapter) return;
    if (this.running) {
      // 分页与流式叠加层互斥：重折历史会让当前这段流式正文重来一次
      this.emit({ type: "toast", level: "warn", text: "@historyBusy" });
      return;
    }
    const throughSeq = this.adapter.cursor();
    const beforeSeq = this.adapter.earliestSeq();
    if (throughSeq === undefined || beforeSeq === undefined) {
      this.log("[history] 拿不到分页锚点（缺 snapshot.cursor 或本地无事件）");
      this.emit({ type: "patch", patch: { hasMoreHistory: false } });
      return;
    }
    try {
      const page = await this.client.page(this.currentSessionId, throughSeq, beforeSeq);
      this.adapter.prependRecords((page.records ?? []) as never[], Boolean(page.hasMore));
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to load earlier history"), error);
    }
  }

  /**
   * 从某条助手消息创建分支。
   *
   * `session/fork` 把一个**冷可读的已完成轮前缀**复制成一个新会话：原会话不动，
   * 新会话带着到该轮为止的历史（所以它永远不是空白会话），并在列表里挂到源会话下。
   *
   * 锚点必须落在 `turn/end` 上：契约里「边界是 atSeq 之后第一个 turn/end；
   * 在**开放轮**里锚定会被拒绝而不是往前裁剪」。所以正在跑的那一轮不能分支
   * （适配器也不给它的 seq），界面据此禁用按钮。
   */
  private async branchFrom(messageId: string): Promise<void> {
    if (!this.client) return;
    const source = this.currentSessionId;
    if (!source) return;
    const atSeq = this.adapter?.forkAnchorFor(messageId);
    if (atSeq === undefined) {
      this.emit({ type: "toast", level: "warn", text: "@branchNoAnchor" });
      return;
    }
    try {
      const value = await this.client.request<{ sessionId?: string }>("session/fork", {
        request: { sessionId: source, atSeq },
      });
      const childId = value?.sessionId;
      if (!childId) {
        this.emit({ type: "toast", level: "error", text: "@branchFailed" });
        return;
      }
      await this.refreshSessions();
      await this.openSession(childId);
      const title = this.sessions.find((session) => session.id === childId)?.title ?? childId;
      this.emit({ type: "toast", level: "info", text: `@branchCreated:${title}` });
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to create the branch"), error);
    }
  }

  /**
   * 从 `modelSelection` 投影同步模型胶囊。
   *
   * 投影形如 `{lastUsed, next}`：`lastUsed` 是上一轮实际用的，`next` 是下一轮将要
   * 用的（新会话里用户选了模型就落在这）。胶囊显示「下一次会用什么」，所以优先 `next`。
   * 两者都为空（全新会话还没跑过）时，退回部署默认模型。
   */
  private applyModelSelection(selection: unknown): void {
    this.lastModelSelection = selection;
    const value = selection as
      | {
          lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null;
          next?: { provider?: string; model?: string; reasoningEffort?: string } | null;
        }
      | null
      | undefined;
    const used = value?.next ?? value?.lastUsed;
    if (!used?.provider || !used.model) {
      void this.loadDefaultModel();
      return;
    }
    const group = this.models.find((g) => g.id === used.provider);
    const model = group?.models.find((m) => m.id === used.model);

    this.model = {
      provider: used.provider,
      model: used.model,
      label: model?.name ?? used.model,
      reasoningEffort: used.reasoningEffort || undefined,
      efforts: model?.efforts,
      contextWindow: model?.contextWindow ?? this.model?.contextWindow,
      acceptsImage: this.acceptsImageFor(used.provider, used.model),
    };
    this.emit({ type: "patch", patch: { model: this.model } });
  }

  private teardownStreams(): void {
    this.followHandle?.cancel();
    this.controlHandle?.cancel();
    this.eventsHandle?.cancel();
    this.workspaceHandle?.cancel();
    this.followHandle = undefined;
    this.controlHandle = undefined;
    this.eventsHandle = undefined;
    this.workspaceHandle = undefined;
    this.eventsClientId = undefined;
    this.handledEvents.clear();
  }

  private openControlStream(): void {
    if (!this.client) return;
    this.controlHandle?.cancel();
    this.controlHandle = this.client.followControl({
      onItem: (value) => this.onControlFrame(value as SessionControlFrame),
    });
  }

  private openWorkspaceStream(): void {
    if (!this.client) return;
    this.workspaceHandle?.cancel();
    this.workspaceHandle = this.client.openStream(
      "workspace/follow",
      {},
      {
        onItem: (value) =>
          this.onWorkspaceFrame(
            value as { type?: string; value?: { archivedSessionIds?: string[] }; archivedSessionIds?: string[] },
          ),
      },
    );
  }

  /**
   * 工作区状态流承载已归档会话的权威集合：每代以一个 `baseline` 开场，
   * 其后是 `archived` 增量（每次都是**完整集合**）。`session/list` 不分
   * 归档与否，归档过滤在客户端做。
   */
  private onWorkspaceFrame(
    frame: { type?: string; value?: { archivedSessionIds?: string[] }; archivedSessionIds?: string[] },
  ): void {
    let next: string[] | undefined;
    if (frame?.type === "baseline") next = frame.value?.archivedSessionIds;
    else if (frame?.type === "archived") next = frame.archivedSessionIds;
    if (!Array.isArray(next)) return;
    const nextSet = new Set(next);
    let changed = nextSet.size !== this.archivedSessionIds.size;
    if (!changed) {
      for (const id of nextSet) {
        if (!this.archivedSessionIds.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    this.archivedSessionIds = nextSet;
    this.emitSessionLists();
  }

  /**
   * 控制流承载队列、后台任务与**投影**。
   *
   * 投影是会话整体状态的折叠值（模型选择、权限预设、待办、计划模式、标题…），
   * 比客户端自己重放日志省事得多。每次重连以一个 `baseline` 开场，其后是逐条
   * `projection` 增量；两者都按「seq 更小者不覆盖」的规则消费。
   */
  private onControlFrame(frame: SessionControlFrame): void {
    if (!frame || typeof frame !== "object") return;

    if (frame.type === "baseline") {
      const value = (frame as { value?: { queues?: Record<string, unknown[]>; jobs?: Record<string, unknown[]>; projections?: Record<string, { values?: Record<string, unknown> }> } }).value;
      if (!value) return;
      const sessionId = this.currentSessionId;
      if (sessionId) {
        const projections = value.projections?.[sessionId]?.values ?? {};
        for (const [key, projectionValue] of Object.entries(projections)) {
          this.applyProjection(key, projectionValue);
        }
        this.syncQueue(value.queues?.[sessionId]);
        this.applyJobs(value.jobs?.[sessionId]);
      }
      return;
    }

    if (frame.type === "queue" && frame.sessionId === this.currentSessionId) {
      this.syncQueue(frame.items);
      return;
    }

    if (frame.type === "jobs" && frame.sessionId === this.currentSessionId) {
      this.applyJobs(frame.jobs);
      return;
    }

    if (frame.type === "projection" && frame.sessionId === this.currentSessionId) {
      this.applyProjection(String(frame.key ?? ""), frame.value);
    }
  }

  /**
   * 队列帧进来到界面状态：同时重建「队列项 id → 原始输入 / 可重发内容」的索引，
   * 供「重新编辑」与「ESC 中止并把队首发出去」使用。
   */
  private syncQueue(items: unknown[] | undefined): void {
    const entries = queueItems(items, (rpcId) => this.originFor(rpcId));
    this.queueOrigin.clear();
    for (const entry of entries) {
      this.queueOrigin.set(entry.view.id, {
        text: entry.view.text,
        attachments: this.originFor(entry.view.rpcId)?.attachments ?? [],
        content: entry.content,
      });
    }
    this.queueItems = entries.map((entry) => entry.view);
    this.emit({ type: "patch", patch: { queueItems: this.queueItems } });
  }

  /** 单个投影值 → 界面状态。未知 key 直接忽略（插件没加载 = 能力缺失，不是错误）。 */
  private applyProjection(key: string, value: unknown): void {    switch (key) {
      case "modelSelection":
        this.applyModelSelection(value);
        break;

      case "permissions": {
        // {options:[{value,name}], currentValue}：用它初始化权限胶囊
        const current = (value as { currentValue?: string } | null)?.currentValue;
        if (typeof current === "string" && current) {
          this.permission = current;
          this.emit({ type: "patch", patch: { permission: current } });
        }
        break;
      }

      case "plan": {
        // 生效状态是 `pending ? !active : active`，不是裸 `active`：轮次进行中发出的
        // `/plan` 只会把选择挂起（`active` 仍为 false），只读 active 会让「进入计划
        // 模式」看起来没反应。见 projections.planModeFromProjection。
        const active = planModeFromProjection(value);
        this.planMode = active;
        this.emit({ type: "patch", patch: { planMode: active } });
        break;
      }

      case "todos": {
        const items = Array.isArray(value) ? value : [];
        this.todos = items.map((todo, index) => {
          const item = todo as { id?: string; content?: string; text?: string; status?: string };
          return {
            id: String(item?.id ?? index),
            content: String(item?.content ?? item?.text ?? ""),
            status:
              item?.status === "completed"
                ? ("completed" as const)
                : item?.status === "in_progress"
                  ? ("in_progress" as const)
                  : ("pending" as const),
          };
        });
        this.emit({ type: "todos", todos: this.todos });
        break;
      }

      case "contextPressure": {
        // 占用条的权威来源（官方 `ContextPressureProjection`）：
        // `usedTokens = projectedTokens ?? pressureTokens`，分子**不含 output**，
        // 且 `projectedTokens` 会跟着压缩下降。见 adapter.refreshOccupancy。
        //
        // 这里同时把 `contextWindow` 同步到模型胶囊：官方把「最新请求的压力」与
        // 「最新已知的路由容量」放在**同一个投影**里（两个槽各自 last-wins，
        // 刻意不保证是一次请求的原子观测），所以两件事必须一起处理。
        const pressure = (value ?? {}) as Record<string, unknown>;
        const pressureTokens = optionalNumber(pressure.pressureTokens);
        const projectedTokens = optionalNumber(pressure.projectedTokens);
        const contextWindow = optionalNumber(pressure.contextWindow);
        this.adapter?.applyContextPressure({ pressureTokens, projectedTokens, contextWindow });
        if (contextWindow !== undefined && contextWindow > 0 && this.model) {
          this.model = { ...this.model, contextWindow };
          this.emit({ type: "patch", patch: { model: this.model } });
        }
        break;
      }

      case "tokenUsage": {
        // 全日志累计的四桶用量（互不重叠：reasoning 已含在 outputTokens 里）。
        // 界面用它显示「这次会话一共花了多少」，与占用条（prompt 侧）不是一回事。
        const usage = (value ?? {}) as {
          uncachedInputTokens?: unknown;
          outputTokens?: unknown;
          cacheReadTokens?: unknown;
          cacheWriteTokens?: unknown;
        };
        this.tokenUsage = {
          uncachedInputTokens: numberOr(usage.uncachedInputTokens, 0),
          outputTokens: numberOr(usage.outputTokens, 0),
          cacheReadTokens: numberOr(usage.cacheReadTokens, 0),
          cacheWriteTokens: numberOr(usage.cacheWriteTokens, 0),
        };
        this.emit({ type: "patch", patch: { tokenUsage: this.tokenUsage } });
        break;
      }

      case "turnOutline": {
        // 轮次导航：每轮的序号、起始 seq 与一句话摘要。界面用它做「跳到某一轮」。
        const rounds = Array.isArray(value) ? value : [];
        this.turnOutline = rounds.map((round) => {
          const item = round as { turn?: unknown; seq?: unknown; summary?: unknown; startedAt?: unknown };
          return {
            turn: numberOr(item.turn, 0),
            seq: numberOr(item.seq, 0),
            summary: typeof item.summary === "string" ? item.summary : "",
            startedAt: numberOr(item.startedAt, 0),
          };
        });
        this.emit({ type: "patch", patch: { turnOutline: this.turnOutline } });
        break;
      }

      case "imageLimits": {
        // 图片准入上限：发送前就能拦住超限的图，而不是等服务端拒绝
        const limits = (value ?? {}) as {
          maxImagesPerMessage?: unknown;
          maxImageBytes?: unknown;
          maxMessageImageBytes?: unknown;
        };
        this.imageLimits = {
          maxImagesPerMessage: numberOr(limits.maxImagesPerMessage, 0) || undefined,
          maxImageBytes: numberOr(limits.maxImageBytes, 0) || undefined,
          maxMessageImageBytes: numberOr(limits.maxMessageImageBytes, 0) || undefined,
        };
        break;
      }

      case "title": {
        if (typeof value === "string" && value) {
          const existing = this.sessions.find((s) => s.id === this.currentSessionId);
          const session: SessionSummaryView = existing
            ? { ...existing, title: value }
            : {
                id: this.currentSessionId ?? "",
                title: value,
                updatedAt: Date.now(),
                running: false,
              };
          if (existing) existing.title = value;
          this.adapter?.setSession(session);
          this.emit({ type: "patch", patch: { session } });
        }
        break;
      }

      case "contextBreakdown": {
        // {systemTokens, toolsTokens, messageTokens}：上下文构成的启发式估算
        const bd = value as { systemTokens?: number; toolsTokens?: number; messageTokens?: number } | null;
        if (
          bd &&
          typeof bd.systemTokens === "number" &&
          typeof bd.toolsTokens === "number" &&
          typeof bd.messageTokens === "number"
        ) {
          this.contextBreakdown = {
            systemTokens: bd.systemTokens,
            toolsTokens: bd.toolsTokens,
            messageTokens: bd.messageTokens,
          };
          this.emit({ type: "patch", patch: { contextBreakdown: this.contextBreakdown } });
        }
        break;
      }

      case "sessionStats": {
        // 全日志墙钟统计：{turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}
        const st = value as {
          turns?: number;
          steps?: number;
          llmMs?: number;
          toolMs?: number;
          ttftMs?: number;
          ttftSteps?: number;
          decodeMs?: number;
          decodeTokens?: number;
        } | null;
        if (st && typeof st.llmMs === "number" && typeof st.toolMs === "number") {
          this.sessionStats = {
            turns: st.turns ?? 0,
            steps: st.steps ?? 0,
            llmMs: st.llmMs,
            toolMs: st.toolMs,
            ttftMs: st.ttftMs ?? 0,
            ttftSteps: st.ttftSteps ?? 0,
            decodeMs: st.decodeMs ?? 0,
            decodeTokens: st.decodeTokens ?? 0,
          };
          this.emit({ type: "patch", patch: { sessionStats: this.sessionStats } });
        }
        break;
      }

      case "subagentCatalog": {
        // 投影里已经带着子代理目录，界面无需再单独请求一次。
        // 形状解析见 projections.ts（投影**没有** kind/activity，与 RPC 行不同）。
        this.subagents = subagentsFromCatalog(value, this.subagents);
        this.emit({
          type: "subagents/list",
          entries: this.subagents,
          parentAvailable: this.subagents.length > 0,
        });
        break;
      }

      case "goal": {
        // 投影是**嵌套**的，轮次计数在外层（见 projections.goalFromProjection）。
        // 以前按扁平的 `{objective, phase, rounds, maxRounds}` 读，两个字段都取不到，
        // 于是 goal 恒被清空、目标条从未渲染（docs/audit-summary.md §3）。
        this.goal = goalFromProjection(value);
        this.emit({ type: "patch", patch: { goal: this.goal } });
        break;
      }

      default:
        break;
    }
  }

  /** 后台任务帧 → 界面状态。 */
  private applyJobs(jobs: unknown): void {
    const list = Array.isArray(jobs) ? jobs : [];
    this.jobs = list.map((job) => {
      const item = job as {
        id: string;
        kind?: string;
        label?: string;
        status?: string;
        detail?: string;
        startedAt?: number;
        finishedAt?: number;
      };
      const status =
        item.status === "running" ||
        item.status === "stopping" ||
        item.status === "completed" ||
        item.status === "killed" ||
        item.status === "failed"
          ? item.status
          : "completed";
      return {
        id: item.id,
        kind: item.kind ?? "job",
        label: item.label ?? item.id,
        status,
        detail: item.detail,
        startedAt: item.startedAt ?? Date.now(),
        finishedAt: item.finishedAt,
      };
    });
    this.emit({ type: "jobs/list", jobs: this.jobs });
    this.emit({ type: "patch", patch: { jobs: this.jobs } });
  }

  // ---------- 主机事件（审批 / 提问） ----------

  private openEventsStream(): void {
    if (!this.client) return;
    this.eventsHandle?.cancel();
    this.eventsHandle = this.client.openEvents({
      onItem: (value) => void this.onEventFrame(value as RemoteEventFrame),
    });
  }

  /**
   * 审批与提问只从这条流来。**收到 waterfall 必须回复**——不回复会把 Agent 永久挂住，
   * 而且重连后同一条会重投递，所以要按 eventId 去重。
   */
  private async onEventFrame(frame: RemoteEventFrame): Promise<void> {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "ready") {
      this.eventsClientId = frame.clientId;
      return;
    }
    if (frame.type !== "waterfall") return;
    const waterfall = frame as RemoteEventWaterfall;
    if (this.handledEvents.has(waterfall.eventId)) {
      // 重投递：直接放行给链上的下一个处理器，避免重复弹卡片
      await this.replyEvent(waterfall.eventId, { kind: "next" });
      return;
    }

    if (waterfall.event === "approval/request") {
      const request = waterfall.request as { toolName?: string; callId?: string; reason?: string };
      this.handledEvents.add(waterfall.eventId);
      this.adapter?.addApproval({
        requestId: waterfall.eventId,
        // 工具名缺失时给标记而不是中文：审批卡按用户选的界面语言渲染
        toolName: request.toolName ?? "@toolGeneric",
        reason: request.reason,
        detail: request.callId ? `@callId:${request.callId}` : undefined,
        state: "waiting",
      });
      this.pendingApproval = waterfall.eventId;
      return;
    }

    if (waterfall.event === "user-questions/request") {
      const request = waterfall.request as { questions?: QuestionView["items"] };
      this.handledEvents.add(waterfall.eventId);
      this.adapter?.addQuestion({
        requestId: waterfall.eventId,
        items: (request.questions ?? []).map((item) => ({
          id: item.id,
          header: item.header,
          question: item.question,
          options: item.options ?? [],
          multiSelect: item.multiSelect,
        })),
        state: "waiting",
      });
      this.pendingQuestion = waterfall.eventId;
      return;
    }

    // 不认识的事件：放行，不能拦着
    await this.replyEvent(waterfall.eventId, { kind: "next" });
  }

  private pendingApproval: string | undefined;
  private pendingQuestion: string | undefined;
  /** 待应用的模型选择：UI 切换模型时只记到这里，下次发送前才真正 selectModel。 */
  private pendingModel: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    label?: string;
    efforts?: { id: string; name: string }[];
    contextWindow?: number;
    acceptsImage?: boolean;
  } | undefined;
  /** 最近一次收到的 modelSelection 原始投影，模型目录就绪后用于重放。 */
  private lastModelSelection: unknown;

  private async replyEvent(eventId: string, outcome: unknown): Promise<void> {
    if (!this.client || !this.eventsClientId) return;
    try {
      await this.client.answerEvent(this.eventsClientId, eventId, outcome as never);
    } catch (error) {
      this.log(`[$events] 回复失败：${this.describeError(error)}`);
    }
  }

  // ---------- 模型 ----------

  /**
   * `provider:model` → 是否接受图片输入。
   *
   * `session/modelCatalog` 的线格式不带输入模态（严格 schema 只有
   * id/name/description/reasoning），模态只存在于 LLM 适配器的设置命名空间：
   * - `llm-pi-ai`：`{providers: {<route>: {defaultInput?, models?, modelOverrides?}}}`；
   * - `llm-deepseek`：`{models: [{id, inputModalities?}]}`（provider 固定 deepseek-official）。
   * 从 `settings/describe` 读出后按模型归档；未声明者按「支持」处理（与 dsh web
   * 一致——它也不隐藏按钮，发送时由服务端 `session/attachment` 复核并报错）。
   */
  private imageCaps = new Map<string, boolean>();

  private acceptsImageFor(provider: string, model: string): boolean {
    return this.imageCaps.get(`${provider}:${model}`) ?? true;
  }

  private async refreshImageCaps(): Promise<void> {
    if (!this.client) return;
    try {
      const described = await this.client.settingsDescribe();
      const caps = new Map<string, boolean>();
      for (const section of described.namespaces ?? []) {
        const value = section.value as Record<string, any> | null | undefined;
        if (!value || typeof value !== "object") continue;
        const providers = value.providers as Record<string, any> | undefined;
        if (section.ns === "llm-pi-ai" && providers && typeof providers === "object") {
          for (const [provider, profile] of Object.entries(providers)) {
            const p = (profile && typeof profile === "object" ? profile : {}) as Record<string, any>;
            const defaultInput = Array.isArray(p.defaultInput) ? p.defaultInput : undefined;
            const record = (id: string, declared?: string[]) => {
              const list = declared ?? defaultInput;
              if (Array.isArray(list)) caps.set(`${provider}:${id}`, list.includes("image"));
            };
            if (Array.isArray(p.models)) {
              for (const entry of p.models) {
                if (entry?.id) record(entry.id, Array.isArray(entry.input) ? entry.input : undefined);
              }
            }
            const overrides = (p.modelOverrides && typeof p.modelOverrides === "object" ? p.modelOverrides : {}) as Record<string, any>;
            for (const [id, ov] of Object.entries(overrides)) {
              if (!caps.has(`${provider}:${id}`)) record(id, Array.isArray(ov?.input) ? ov.input : undefined);
            }
          }
        } else if (section.ns === "llm-deepseek" && Array.isArray(value.models)) {
          for (const m of value.models) {
            if (m?.id && Array.isArray(m.inputModalities)) {
              caps.set(`deepseek-official:${m.id}`, m.inputModalities.includes("image"));
            }
          }
        }
      }
      this.imageCaps = caps;
      // 当前模型同步刷新后推给界面（切换模型前目录/设置可能已更新）
      if (this.model) {
        this.model = { ...this.model, acceptsImage: this.acceptsImageFor(this.model.provider, this.model.model) };
        this.emit({ type: "patch", patch: { model: this.model } });
      }
    } catch (error) {
      this.log(`[models] 图片输入能力读取失败：${this.describeError(error)}`);
    }
  }

  private async loadModels(): Promise<void> {
    if (!this.client) return;
    try {
      const catalog = await this.client.modelCatalog();
      this.models = (catalog.groups ?? []).map((group) => ({
        id: group.id,
        name: group.name,
        models: (group.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          efforts: model.reasoning?.efforts,
          defaultEffort: model.reasoning?.defaultEffort,
        })),
      }));
      this.emit({ type: "models", groups: this.models, current: this.model });
      // 图片能力来自设置命名空间，在选定默认/当前模型前刷新
      await this.refreshImageCaps();
      // 投影可能先于模型目录到达（WS 一开就推 baseline），那时只能显示模型 id；
      // 目录就绪后用原始投影重放一次，把 id 换成人类可读的名字
      if (this.lastModelSelection) this.applyModelSelection(this.lastModelSelection);
      else await this.loadDefaultModel();
    } catch (error) {
      this.log(`[models] 目录获取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 新会话在首次对话前没有 modelSelection，但 agent 仍会用部署默认值。
   * 从 `agent-default-model` 设置命名空间读出来，开场就显示真实模型。
   */
  private async loadDefaultModel(): Promise<void> {
    if (!this.client || this.model) return;
    try {
      const described = await this.client.settingsDescribe();
      const section = described.namespaces?.find((item) => item.ns === "agent-default-model");
      const value = section?.value as { provider?: string; model?: string; reasoningEffort?: string } | undefined;
      if (!value?.provider || !value.model) return;
      const group = this.models.find((g) => g.id === value.provider);
      const model = group?.models.find((m) => m.id === value.model);
      this.model = {
        provider: value.provider,
        model: value.model,
        label: model?.name ?? value.model,
        reasoningEffort: value.reasoningEffort,
        efforts: model?.efforts,
        contextWindow: model?.contextWindow,
        acceptsImage: this.acceptsImageFor(value.provider, value.model),
      };
      this.emit({ type: "patch", patch: { model: this.model } });
    } catch (error) {
      this.log(`[models] 默认模型读取失败：${this.describeError(error)}`);
    }
  }

  // ---------- webview 指令 ----------

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case "ready":
        this.emit({ type: "state", state: this.snapshot() });
        break;

      case "send":
        // 未连接时先恢复连接：历史会话切换后跟随流尚未建立时直接 prompt
        // 会触发服务端 resume，冷启动竞态下 resume 可能失败
        if (!this.client || this.connection !== "connected") await this.ensureConnected();
        await this.send(message.text, message.attachments);
        break;

      case "stop":
        await this.stopRunning();
        break;

      case "queueRemove":
        // 移除后服务端会重发队列帧，界面以帧为准；这里只做请求与兜底报错
        if (this.client && this.currentSessionId && message.id) {
          this.client.updateQueueRemove(this.currentSessionId, message.id).catch((error) => {
            this.reportError(vscode.l10n.t("Failed to cancel the queued message"), error);
          });
        }
        break;

      case "queueEdit":
        await this.editQueuedMessage(message.id);
        break;

      case "newSession":
        await this.newSession();
        break;

      case "openSession":
        await this.openSession(message.sessionId);
        break;

      case "listSessions":
        await this.refreshSessions();
        break;

      case "archiveSession":
        await this.archiveSession(message.sessionId);
        break;

      case "deleteSession":
        await this.deleteSession(message.sessionId);
        break;

      case "setModel":
        // 延迟到下一次发送时生效（与 UI 进入计划模式同机制）：
        // 避免正在生成时切模型导致本轮中途换模型，也让界面立刻反映选择
        const group = this.models.find((g) => g.id === message.provider);
        const model = group?.models.find((m) => m.id === message.model);
        this.pendingModel = {
          provider: message.provider,
          model: message.model,
          reasoningEffort: message.reasoningEffort,
          label: model?.name ?? message.model,
          efforts: model?.efforts,
          contextWindow: model?.contextWindow ?? this.model?.contextWindow,
          acceptsImage: this.acceptsImageFor(message.provider, message.model),
        };
        // 立即更新胶囊显示（实际 selectModel 在下次发送前执行）
        this.model = {
          provider: this.pendingModel.provider,
          model: this.pendingModel.model,
          label: this.pendingModel.label ?? this.pendingModel.model,
          reasoningEffort: this.pendingModel.reasoningEffort,
          efforts: this.pendingModel.efforts,
          contextWindow: this.pendingModel.contextWindow,
          acceptsImage: this.pendingModel.acceptsImage,
        };
        this.emit({ type: "patch", patch: { model: this.model } });
        break;

      case "setPermission":
        await this.runCommand(`/permission ${message.permission}`);
        break;

      case "runCommand": {
        // 界面上的按钮化命令（权限预设、进入/退出计划模式）。成功与失败都靠
        // command/run ↔ command/done 折出的节点呈现，这里只补「命令不存在」这种
        // 压根没进处理器、因而没有节点可显示的情形。
        const outcome = await this.runCommand(message.line);
        if (outcome && !outcome.ok) {
          this.emit({
            type: "toast",
            level: "error",
            text: outcome.text ?? `@commandFailed:${message.line}`,
          });
        }
        break;
      }

      case "answerApproval": {
        const eventId = message.requestId;
        if (!eventId) break;
        await this.replyEvent(eventId, {
          kind: "result",
          value: message.approved ? "allowed-once" : "rejected",
        });
        this.adapter?.resolveApproval(eventId, message.approved ? "approved" : "rejected");
        if (this.pendingApproval === eventId) this.pendingApproval = undefined;
        break;
      }

      case "answerQuestion": {
        const eventId = message.requestId;
        if (!eventId) break;
        await this.replyEvent(eventId, {
          kind: "result",
          value: { answers: message.answers },
        });
        this.adapter?.resolveQuestion(eventId);
        if (this.pendingQuestion === eventId) this.pendingQuestion = undefined;
        break;
      }

      case "addFiles":
        await this.pickFiles();
        break;

      case "addMention": {
        // `@` 选中的文件/目录：
        // - 目录 → 变成 `@dir/` **引用芯片**（官方靠结尾斜杠标记目录，模型自己
        //   决定要不要 list；以前是把带引号路径插进输入框，语义弱且用户看不见状态）；
        // - 文件 → 走常规分派（图片内联、其余上传）。
        if (message.kind === "directory") {
          this.addReference(message.path, "directory");
        } else {
          this.applyPaths([{ path: message.path, name: this.attachmentName(message.path) }]);
        }
        break;
      }

      case "addFolderReference":
        // 用户明确要求「整个目录作为引用」（`@` 列表右侧的按钮）
        this.addReference(message.path, "directory");
        break;

      case "retryUpload":
        this.retryUpload(message.id);
        break;

      case "runCommandLine":
        // 命令面板里点的一条命令（不是手打的正文）
        await this.runCommand(message.line);
        break;

      case "branchFrom":
        await this.branchFrom(message.messageId);
        break;

      case "loadMore":
        await this.loadMore();
        break;

      case "removeAttachment":
        this.removeAttachment(message.id);
        break;

      case "setDraft":
        this.drafts.set(this.sessionKey(), message.text);
        break;

      case "openFile":
        await this.openFile(message.path);
        break;

      case "insertText":
        await this.insertIntoEditor(message.text);
        break;

      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        this.emit({ type: "toast", level: "info", text: "@copied" });
        break;

      case "listSubagents":
        await this.refreshSubagents();
        break;

      case "openSubagent":
        await this.openSubagent(message.id);
        break;

      case "listJobs":
        this.emit({ type: "jobs/list", jobs: this.jobs });
        break;

      case "listCommands":
        await this.listCommands();
        break;

      case "queryFiles":
        await this.queryFiles(message.query);
        break;

      case "describeSettings":
        await this.describeSettings();
        break;

      case "saveSetting":
        await this.saveSetting(message.ns, message.path, message.value, message.expectedRevision);
        // 设置里可能改了 LLM 适配器的输入模态声明，刷新图片能力
        void this.refreshImageCaps();
        break;

      case "resetSettings":
        await this.resetNamespace(message.ns);
        void this.refreshImageCaps();
        break;

      case "saveSecret":
        await this.saveSecret(message.ns, message.path, message.value, message.ref);
        break;

      case "openVscodeSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "dshChat");
        break;

      case "openInEditor":
        await vscode.commands.executeCommand("dshChat.openInEditor");
        break;

      case "showLogs":
        this.log("");
        break;

      case "restartServer":
        await this.restart();
        break;

      case "setToken":
        await this.setToken();
        break;

      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "dshChat");
        break;

      default:
        break;
    }
  }

  private async send(text: string, attachments: Attachment[]): Promise<void> {
    if (!this.client) return;
    if (!this.currentSessionId) await this.newSession();
    if (!this.currentSessionId) return;

    // 斜杠命令走命令通道，**不发给模型**：官方客户端的 enter 列把 `/xxx` 交给
    // `commands/execute`，宿主也明确「without sending it to the model」。
    // 以前只有 `/permission` 走命令通道，手打的 `/compact`、`/goal` 等一律当普通
    // 消息发给模型（docs/audit-summary.md §2）。附带附件时仍按普通消息发：
    // 命令若不能带附件，服务端会拒绝，而用户此刻显然是想发这批内容。
    const slash = attachments.length === 0 ? this.slashCommandOf(text) : undefined;
    if (slash) {
      this.drafts.set(this.sessionKey(), "");
      this.emit({ type: "patch", patch: { draft: "" } });
      const outcome = await this.runCommand(slash.line);
      if (outcome && !outcome.ok) {
        this.emit({
          type: "toast",
          level: "error",
          text: outcome.text ?? `@commandFailed:${slash.line}`,
        });
      }
      return;
    }

    const content: unknown[] = [];
    // 内容块按**官方顺序**装配：附件在前、正文在后
    // （`content = [...attachments, {type:'text', text}]`）。
    // 文件不再内联正文：引用变成正文里的 `@path`，上传文件变成 `{type:'file', receiptId}`。
    const references = attachments.filter(
      (attachment): attachment is Attachment & { path: string } =>
        attachment.kind === "reference" && Boolean(attachment.path),
    );
    const selections = attachments.filter((attachment) => attachment.kind === "selection" && attachment.text);
    // 选区是本地便利能力（官方没有对应原语）：它的文本仍作为上下文前置。
    if (selections.length) {
      content.push({
        type: "text",
        text: selections
          .map((attachment) => `以下是来自 ${attachment.name} 的选中代码：\n\`\`\`\n${attachment.text}\n\`\`\``)
          .join("\n\n"),
      });
    }
    const uploaded: { receiptId: string }[] = [];
    const notUploaded: string[] = [];
    for (const attachment of attachments) {
      if (attachment.kind !== "file" || !attachment.path) continue;
      if (attachment.upload?.status === "ready") {
        uploaded.push({ receiptId: attachment.upload.receiptId });
      } else {
        notUploaded.push(attachment.name);
      }
    }
    for (const file of uploaded) content.push({ type: "file", receiptId: file.receiptId });
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.dataUrl) {
        const match = /^data:([^;]+);base64,(.*)$/.exec(attachment.dataUrl);
        if (match) {
          content.push({ type: "image", mediaType: match[1], data: match[2], name: attachment.name });
        }
      }
    }
    // 正文最后：引用 token 拼在用户输入之前（同一条 text 块，官方也是单一 text 块）
    const body = composeWithReferences(
      text,
      references.map((attachment) => ({
        path: attachment.path,
        kind: attachment.referenceKind ?? "file",
      })),
    );
    if (body) content.push({ type: "text", text: body });
    if (content.length === 0) return;

    try {
      // 发送前应用待生效的模型选择（切换即时生效于"下一轮"）
      if (this.pendingModel) {
        const { provider, model, reasoningEffort } = this.pendingModel;
        this.pendingModel = undefined;
        try {
          await this.client.selectModel(this.currentSessionId, provider, model, reasoningEffort);
        } catch (error) {
          this.log(`[model] 发送前应用模型选择失败：${this.describeError(error)}`);
        }
      }
      const key = this.sessionKey();
      this.attachmentsBySession.set(key, []);
      this.drafts.set(key, "");
      this.running = true;
      this.emit({ type: "patch", patch: { attachments: [], draft: "", running: true } });
      // requestId 由这里铸造：队列帧会把同一个 id 作为 rpcId 带回来，
      // 「重新编辑」凭它还原成用户当时输入的文本与附件
      const requestId = randomUUID();
      // 队列「重新编辑」要还原用户**原始**输入，所以记的是拼引用之前的正文
      this.rememberSubmission(requestId, text.trim(), content, attachments);
      await this.client.prompt(this.currentSessionId, content, this.submitMode(), requestId);
      if (notUploaded.length) this.warnUploadIncomplete(notUploaded);
    } catch (error) {
      this.running = false;
      this.emit({ type: "patch", patch: { running: false } });
      this.reportError(vscode.l10n.t("Failed to send"), error);
    }
  }

  /**
   * 运行中提交时用 queue 还是 steer（官方 `resolveSubmitMode`）。
   *
   * 本机 `~/.dsh/settings.yaml` 就是 `ui-conversation.busyEnter: steer`，而这里
   * 曾经把 `"queue"` 写死——设置面板里改了「保存成功但不生效」
   * （docs/audit-summary.md §17）。
   *
   * steer 需要 agent 处于 `running`：不满足时退回 queue，否则服务端会拒绝。
   */
  private submitMode(): "queue" | "steer" {
    if (!this.running) return "queue";
    return this.busyEnter === "steer" ? "steer" : "queue";
  }

  /** `ui-conversation.busyEnter` 设置（`queue` / `steer`），未配置时按 queue。 */
  private busyEnter: string | undefined;

  /** 从设置命名空间里读「运行中回车」的行为；没有该配置就保持 queue。 */
  private applyBusyEnter(settings: { ns?: string; value?: unknown }[]): void {
    const section = settings.find((item) => item?.ns === "ui-conversation");
    const value = (section?.value ?? {}) as { busyEnter?: unknown };
    this.busyEnter = typeof value.busyEnter === "string" ? value.busyEnter : undefined;
  }

  /** 提示：有文件附件没上传成功，发送时被跳过（内容没丢，仍在芯片上）。 */
  private warnUploadIncomplete(names: string[]): void {
    // `、` 是中文顿号，英文里得用 `, `——所以预览串只做「取前几个 + 省略号」，
    // 分隔符与「等 N 个」都交给词典按语言拼（见 texts.ts 的 uploadIncomplete）。
    const preview = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? "…" : "";
    this.emit({
      type: "toast",
      level: "warn",
      text: `@uploadIncomplete:${names.length}:${preview}${more}`,
    });
  }

  private relativePath(path: string): string {
    const root = this.workspacePath();
    const rel = relative(root, path);
    return rel && !rel.startsWith("..") ? rel : path;
  }

  /**
   * 执行一条斜杠命令。
   *
   * `commands/execute` 的第三个位置参数在 0.1.5 从 `images` 改名为
   * `submittedAttachments`，而网关对参数名做严格校验（多一个少一个都拒）。
   * 协议没有版本协商，所以先按新名调用，命中 `gateway/arguments-invalid`
   * 时回退到旧名，并记住生效的那个。
   *
   * 命令**必须**走这条通道，不能把 `/plan` 之类拼进消息正文：实测服务端只认
   * 命令通道（`scripts/planCommandProbe.ts`，正文前缀 `plan.active` 仍为 false）。
   * 返回值里 `value === undefined` 表示「没有这条命令」——官方客户端也把它当
   * 错误结果处理（`unknown or malformed command`）。
   */
  private async runCommand(line: string): Promise<{ ok: boolean; text?: string } | undefined> {
    if (!this.client) return undefined;
    // 命令按会话执行：还没有会话时先建一个（点按钮时用户并没有先发过消息）
    if (!this.currentSessionId) await this.newSession();
    if (!this.currentSessionId) return undefined;
    const agentId = this.currentSessionId;
    const attempt = (attachmentsKey: "submittedAttachments" | "images") =>
      this.client!.request<{ result?: { kind?: string; text?: string } } | undefined>("commands/execute", {
        agentId,
        line,
        [attachmentsKey]: [],
      });

    const interpret = (value: { result?: { kind?: string; text?: string } } | undefined) => {
      if (value === undefined) return { ok: false, text: `@unknownCommand:${line}` };
      return { ok: value.result?.kind !== "error", text: value.result?.text };
    };

    try {
      return interpret(await attempt(this.attachmentsParam));
    } catch (error) {
      const isArgumentMismatch = error instanceof DshApiError && error.code === "gateway/arguments-invalid";
      if (!isArgumentMismatch) {
        this.reportError(vscode.l10n.t("Failed to run {0}", line), error);
        return undefined;
      }
      const fallback = this.attachmentsParam === "submittedAttachments" ? "images" : "submittedAttachments";
      this.log(`[commands] 参数名不被接受，回退为 ${fallback}`);
      try {
        const value = await attempt(fallback);
        this.attachmentsParam = fallback;
        return interpret(value);
      } catch (retryError) {
        this.reportError(vscode.l10n.t("Failed to run {0}", line), retryError);
        return undefined;
      }
    }
  }

  /**
   * 手打的一行是不是斜杠命令？
   *
   * 判定与官方 `ui-commands` 的 enter 列一致：行首 `/` + 非空命令名 + 名字在
   * 命令目录里（带参数时要求该命令声明了自由输入）。目录是异步拉的，这里用
   * 已缓存的快照——**故意不为一行文本去发一次 RPC**：目录在会话打开与输入
   * `/` 时就已拉过，拿不到就按普通消息发送（与旧行为一致，不会卡住发送）。
   */
  private slashCommandOf(text: string): { name: string; line: string } | undefined {
    const line = text.trim();
    if (!line.startsWith("/")) return undefined;
    const match = /^\/([^\s/]+)([\s\S]*)$/.exec(line);
    if (!match) return undefined;
    const name = match[1];
    const rest = match[2] ?? "";
    const known = this.commandCatalog.get(name);
    if (!known) return undefined;
    // 带参数的行只对「声明了自由输入」的命令成立，其余照旧当消息发出去
    if (rest.trim() && !known.hint) return undefined;
    return { name, line };
  }

  /** 命令目录（`commands/list`）：名字 → 描述符。用于把输入行路由到命令通道。 */
  private readonly commandCatalog = new Map<string, { hint?: string }>();

  /** 记下 0.1.5 起的参数名，回退成功后更新。 */
  private attachmentsParam: "submittedAttachments" | "images" = "submittedAttachments";

  /**
   * 通用「添加文件」：一个入口收下任意**文件**，按内容分派。
   *
   * - 图片 → 图片附件（按内容块发送）；
   * - 其余文件 → **上传**成文件附件（拿 `receiptId`），不再内联正文；
   * - 读不出来 / 过大到无法上传 → 带引号的路径插到输入框光标处。
   *
   * 这里**只选文件**，不能同时选目录：VS Code 的 `OpenDialogOptions` 明确写着
   * 「On Windows and Linux, a file dialog cannot be both a file selector and a
   * folder selector, so if you set both `canSelectFiles` and `canSelectFolders`
   * to `true` on these platforms, a folder selector will be shown.」——同时置 true
   * 会让 Windows/Linux 上**只**弹目录选择器，文件全被过滤掉（这正是之前的 bug）。
   * 目录改由 `pickFolder`（命令面板 / 资源管理器右键文件夹）负责。
   *
   * 刻意不再有「只选图片」的对话框：同一个按钮既能给图片也能给代码/日志，
   * 由文件本身决定走哪条路，用户不必先想清楚该点哪个按钮。
   */
  private async pickFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: vscode.l10n.t("Add as context"),
    });
    if (!picked?.length) return;
    this.addPaths(picked.map((uri) => uri.fsPath));
  }

  /** 添加目录（单独入口：与文件选择器在 Windows 上互斥，见 pickFiles 注释）。 */
  private async pickFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: vscode.l10n.t("Add folder as context"),
    });
    if (!picked?.length) return;
    this.addPaths(picked.map((uri) => uri.fsPath));
  }

  /** 把一批路径交给 `applyPaths` 分派（附件 / 上传 / 路径）。 */
  private addPaths(paths: string[]): void {
    this.applyPaths(paths.map((path) => ({ path, name: this.attachmentName(path) })));
  }

  /**
   * 把一批路径并入当前会话的输入。
   *
   * 三条去向，与官方一致：
   * - **图片** → 图片附件（内容块，官方同样内联图片字节）；
   * - **目录** → `@dir/` 引用（官方靠结尾斜杠标记目录，模型自己决定要不要 list）；
   * - **其余文件** → 文件附件并**立即上传**（官方 upload-on-pick：选完就开始传，
   *   大文件在按下发送前就能看到进度，发送时只带 `receiptId`）。
   *
   * 读不出来且上传不了的（极端情况）退回把带引号的路径插到光标处——那是最后一道
   * 兜底，不再假装「已作为上下文加入」。
   *
   * 用户明确说过的口径（2026-09-12）：`@` 列表里选中**目录**默认是**打开该目录**
   * （继续下钻），只有点右侧的「整个目录」才是把目录本身载入。这里收的就是后者。
   */
  private applyPaths(items: { path: string; name: string; directory?: boolean }[]): void {
    const key = this.sessionKey();
    const list = this.attachmentsBySession.get(key) ?? [];
    const pathOnly: string[] = [];
    let unsupportedImages = 0;

    for (const item of items) {
      // 附件按路径去重（同一张图加两次没有意义）；路径型结果不去重——
      // 用户每次明确选择都应该在光标处再插一份
      if (list.some((a) => a.path === item.path)) continue;
      const outcome = classifyPath({
        ...item,
        // 未拿到模型能力时按「支持」处理，与服务端最终校验一致
        acceptsImage: this.model?.acceptsImage !== false,
        onError: (message) => this.log(`[attach] ${message}`),
      });
      if (outcome.kind === "attachment") {
        if (outcome.attachment.kind === "file" && outcome.attachment.path) {
          // 上传是异步的：先把芯片放进列表（带 uploading 状态），字节到了再更新
          const attachment = outcome.attachment;
          list.push(attachment);
          this.uploadAttachment(key, attachment);
          continue;
        }
        list.push(outcome.attachment);
        continue;
      }
      pathOnly.push(item.path);
      if (outcome.reason === "image-unsupported") unsupportedImages++;
    }

    this.attachmentsBySession.set(key, list);
    this.emit({ type: "patch", patch: { attachments: [...list] } });
    if (pathOnly.length) {
      this.emit({ type: "ui/insertText", text: formatPathList(pathOnly) });
    }
    if (unsupportedImages > 0) {
      const model = this.model?.label ?? this.model?.model ?? "";
      this.emit({ type: "toast", level: "warn", text: `@imagePathsInserted:${unsupportedImages}:${model}` });
    }
  }

  /** 上传一个文件附件并把 `receiptId` 写回芯片（失败标 error，可重试）。 */
  private uploadAttachment(sessionKey: string, attachment: Attachment): void {
    void this.runUpload(sessionKey, attachment.id, attachment.path, attachment.name);
  }

  private async runUpload(
    sessionKey: string,
    id: string,
    path: string | undefined,
    name: string,
  ): Promise<void> {
    const setState = (state: UploadState) => {
      this.mutateAttachmentsForKey(sessionKey, (list) => {
        const target = list.find((a) => a.id === id);
        if (target) target.upload = state;
      });
    };
    if (!this.client || !this.currentSessionId || !path) {
      setState({ status: "error", message: "@uploadNoSession" });
      return;
    }
    try {
      setState({ status: "uploading", loaded: 0 });
      const bytes = readFileSync(path);
      const value = await this.client.uploadFile(this.currentSessionId, new Uint8Array(bytes), name);
      setState({ status: "ready", receiptId: value.receiptId });
    } catch (error) {
      this.log(`[upload] ${name} 上传失败：${this.describeError(error)}`);
      setState({ status: "error", message: this.describeError(error) });
    }
  }

  /** 修改**指定会话**（而非当前会话）的附件并下发。 */
  private mutateAttachmentsForKey(sessionKey: string, fn: (list: Attachment[]) => void): void {
    const list = this.attachmentsBySession.get(sessionKey) ?? [];
    fn(list);
    this.attachmentsBySession.set(sessionKey, list);
    // 只有仍在看这个会话时才刷新界面
    if (sessionKey === this.sessionKey()) {
      this.emit({ type: "patch", patch: { attachments: [...list] } });
    }
  }

  /** 加一个 `@path` 引用芯片（不内联、不上传，正文里只出现路径 token）。 */
  private addReference(path: string, kind: "file" | "directory"): void {
    // 含控制字符或引号的路径无法构成合法 mention：退回把路径插到光标处
    if (formatFileMention(path, kind) === undefined) {
      this.emit({ type: "ui/insertText", text: `"${path}"` });
      return;
    }
    this.mutateAttachments((list) => {
      if (list.some((a) => a.path === path && a.kind === "reference")) return;
      list.push({
        id: randomUUID(),
        kind: "reference",
        path,
        name: kind === "directory" ? `${basename(path)}/` : this.relativePath(path),
        referenceKind: kind,
      });
    });
  }

  /** 重传一个失败的文件附件。 */
  private retryUpload(id: string): void {
    const key = this.sessionKey();
    const attachment = (this.attachmentsBySession.get(key) ?? []).find((a) => a.id === id);
    if (!attachment?.path) return;
    void this.runUpload(key, attachment.id, attachment.path, attachment.name);
  }

  /**
   * 附件的展示名：图片与目录取文件名（芯片里更好读），其余取工作区相对路径。
   * 三个入口（选文件 / 选目录 / 右键 / `@`）共用，避免各自写一份而走样。
   */
  private attachmentName(path: string): string {
    return isImagePath(path) || isDirectoryPath(path) ? basename(path) : this.relativePath(path);
  }

  private removeAttachment(id: string): void {
    this.mutateAttachments((list) => {
      const index = list.findIndex((a) => a.id === id);
      if (index >= 0) list.splice(index, 1);
    });
  }

  /**
   * 按 requestId 取回用户原始输入，并顺手缓存到 `queueOrigin`（供「重新编辑」）。
   * 取不到返回 undefined，调用方退回线上文本。
   */
  private originFor(rpcId: string | undefined): QueueOrigin | undefined {
    if (!rpcId) return undefined;
    const record = this.submissions.get(rpcId);
    if (!record) return undefined;
    return { text: record.text, attachments: record.attachments, content: record.content };
  }

  /**
   * 记下这次提交的原文、附件与内容块，供队列「重新编辑」还原、
   * 以及「ESC 中止后把队首重新发出」使用（后者需要原样内容块才能带上图片）。
   *
   * 服务端不保证会回 `rpcId`（插件/版本差异），所以这只是尽力而为的记录；
   * 同时按时间与条数设上限，避免长会话里无限增长。
   */
  private rememberSubmission(
    requestId: string,
    text: string,
    content: unknown[],
    attachments: Attachment[],
  ): void {
    const now = Date.now();
    for (const [key, value] of [...this.submissions]) {
      if (now - value.at > SUBMISSION_TTL_MS) this.submissions.delete(key);
    }
    while (this.submissions.size >= MAX_SUBMISSIONS) {
      const oldest = this.submissions.keys().next().value;
      if (oldest === undefined) break;
      this.submissions.delete(oldest);
    }
    this.submissions.set(requestId, {
      text,
      attachments: [...attachments],
      content: [...content],
      at: now,
    });
  }

  /**
   * 中止当前轮；**队列非空时把队首消息接着发出去**。
   *
   * 实测（`scripts/queueContinueProbe.ts`，两轮各 3 次）确定的两个事实：
   * 1. 只 `cancel` **不会**让队列自动接续——agent 因 abort 抛出而跳出轮循环，
   *    队列项保留（`cancel` 用 `keepInbox: true`）但不会被消费（两轮都 3/3）；
   * 2. 中止之后再提交新消息，服务端**是否顺带把保留的队列项跑起来是不确定的**：
   *    同一脚本两次运行得到相反结果（一次 3/3 唤醒、一次 0/3），取决于中止落在
   *    轮循环哪一步，客户端无法预判。被唤醒时用户刚提交的那条会被排到队列项后面。
   *
   * 所以做法是：先把**整条队列**摘空（服务端就没有可继续的待办，事实 2 的两条分支
   * 都不再成立），再中止、等空闲，然后按原顺序重新提交。首条自然成为新一轮，其余在
   * 其后排队，与正常排队语义一致。任何一步失败都退化为「只中止」，不会丢消息或发两遍。
   */
  private async stopRunning(): Promise<void> {
    if (!this.client || !this.currentSessionId) return;
    const sessionId = this.currentSessionId;

    const pending = this.queueItems
      .map((item) => ({ id: item.id, origin: this.queueOrigin.get(item.id) }))
      .filter((entry): entry is { id: string; origin: QueueOrigin } => Boolean(entry.origin?.content?.length));

    if (!pending.length) {
      if (this.queueItems.length) {
        // 有排队消息但拿不到可重发内容（理论上不会发生）：只中止，别把消息弄丢
        this.emit({ type: "toast", level: "warn", text: "@queueContentLost" });
      }
      await this.finishCancelOnly();
      return;
    }

    // 1) 摘空队列：避免服务端继续消费，也避免重发后重复
    const removed: typeof pending = [];
    for (const entry of pending) {
      try {
        await this.client.updateQueueRemove(sessionId, entry.id);
        removed.push(entry);
        this.queueOrigin.delete(entry.id);
      } catch (error) {
        // 摘不动（可能正好开始执行了）：把已摘的放回队列，退化为纯中止
        this.reportError(
          vscode.l10n.t("Failed to take back the queued message; only the current turn was stopped"),
          error,
        );
        await this.requeue(removed);
        await this.finishCancelOnly();
        return;
      }
    }

    // 2) 中止，并等本轮真正结束
    await this.cancelTurn();
    if (!(await this.waitUntilIdle())) {
      this.reportError(
        vscode.l10n.t("Timed out waiting for the current turn to finish"),
        new Error("turn did not settle"),
      );
      await this.requeue(removed);
      this.emit({ type: "toast", level: "warn", text: "@queueDispatchFailed" });
      return;
    }

    // 3) 按原顺序重新提交（首条即是「接着发出去」的那条）
    await this.resubmit(removed);
  }

  /** 只中止，并把界面上的「生成中」收掉（服务端迟迟不回时兜底）。 */
  private async finishCancelOnly(): Promise<void> {
    await this.cancelTurn();
    if (!(await this.waitUntilIdle())) {
      this.emit({ type: "patch", patch: { running: false } });
    }
  }

  /** 把一批已摘出的消息按顺序重新提交。失败时剩下的内容放回输入框。 */
  private async resubmit(entries: { origin: QueueOrigin }[]): Promise<void> {
    for (let index = 0; index < entries.length; index++) {
      const { origin } = entries[index];
      if (!this.client || !this.currentSessionId) return;
      try {
        // 必须用新的 requestId：旧 id 已被服务端记为已受理，复用会被当成重试而不插入
        const requestId = randomUUID();
        this.rememberSubmission(requestId, origin.text, origin.content ?? [], origin.attachments);
        if (index === 0) {
          this.running = true;
          this.emit({ type: "patch", patch: { running: true } });
        }
        await this.client.prompt(this.currentSessionId, origin.content ?? [], "queue", requestId);
      } catch (error) {
        this.running = false;
        this.emit({ type: "patch", patch: { running: false } });
        this.reportError(
          vscode.l10n.t("Failed to send the queued message (its content is back in the box)"),
          error,
        );
        this.emit({ type: "toast", level: "warn", text: "@queueDispatchFailed" });
        // 这条以及后面还没发出的，内容都放回输入框
        for (const rest of entries.slice(index)) {
          this.appendDraft(rest.origin.text, rest.origin.attachments);
        }
        return;
      }
    }
  }

  /** 把已摘出的消息按顺序放回队列（回滚用）。 */
  private async requeue(entries: { origin: QueueOrigin }[]): Promise<void> {
    if (!entries.length) return;
    await this.resubmit(entries);
  }

  /**
   * 中止当前轮。
   *
   * 刻意**不**在这里乐观地置 `running: false`：那会骗过下面的 `waitUntilIdle`，
   * 让我们在本轮真正结束前就重新提交（于是那条消息被排进队列且不会自动接续）。
   * 界面上的「生成中」由服务端回 `turn/end` 时适配器发的 patch 收掉。
   */
  private async cancelTurn(): Promise<void> {
    if (!this.client || !this.currentSessionId) return;
    try {
      await this.client.cancel(this.currentSessionId);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to stop"), error);
    }
  }

  /** 轮询等待当前轮结束（`running` 由适配器的 patch 帧同步）；返回是否真的等到了。 */
  private async waitUntilIdle(timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      await delay(80);
    }
    return !this.running;
  }

  /** 把文本与附件追加回输入框（发送失败时的兜底，尽量不丢内容）。 */
  private appendDraft(text: string, attachments: Attachment[]): void {
    const key = this.sessionKey();
    const existing = this.drafts.get(key) ?? "";
    const next = existing.trim()
      ? `${existing.replace(/\s+$/, "")}\n${text}`
      : text;
    this.drafts.set(key, next);
    const list = this.attachmentsBySession.get(key) ?? [];
    for (const attachment of attachments) {
      if (!list.some((entry) => entry.id === attachment.id)) list.push(attachment);
    }
    this.attachmentsBySession.set(key, list);
    this.emit({ type: "patch", patch: { draft: next, attachments: [...list] } });
  }

  /**
   * 队列消息「重新编辑」：把它从队列里摘掉，内容放回输入框。
   *
   * 顺序不能反——先摘队列再回填。若这条其实已经开始发送了（服务端回
   * `session/queue-item-not-found`），回填会让用户以为它还没发出去，
   * 接着一发送就变成重复消息。
   *
   * 正文用客户端自己存的原文（`submissions`）而不是队列回显：提交给服务端的
   * 正文已经把文件上下文内联进去了，把回显倒回输入框会是一大坨内容。
   */
  private async editQueuedMessage(itemId: string): Promise<void> {
    if (!this.client || !this.currentSessionId) return;
    const item = this.queueItems.find((entry) => entry.id === itemId);
    try {
      await this.client.updateQueueRemove(this.currentSessionId, itemId);
    } catch (error) {
      this.reportError(
        vscode.l10n.t("Failed to restore the queued message (it may already be sending)"),
        error,
      );
      return;
    }

    const origin = this.queueOrigin.get(itemId);
    this.queueOrigin.delete(itemId);

    const key = this.sessionKey();
    const restored = origin?.text ?? item?.text ?? "";
    // 输入框里可能已经有草稿：追加而不是覆盖，避免把用户正在写的内容弄丢
    const existing = this.drafts.get(key) ?? "";
    const next = existing.trim() ? `${existing.replace(/\s+$/, "")}\n${restored}` : restored;
    this.drafts.set(key, next);

    const list = this.attachmentsBySession.get(key) ?? [];
    for (const attachment of origin?.attachments ?? []) {
      if (!list.some((entry) => entry.id === attachment.id)) list.push(attachment);
    }
    this.attachmentsBySession.set(key, list);
    this.emit({ type: "patch", patch: { draft: next, attachments: [...list] } });

    // 线上正文里带附件、本地却没有原始记录（扩展重载过）：附件找不回来，说清楚
    if (item?.hasMedia && !origin?.attachments.length) {
      this.emit({ type: "toast", level: "warn", text: "@queueAttachmentsLost" });
    }
  }

  /** 供编辑器命令调用：把一段文本作为上下文加入输入框。 */
  addSelection(name: string, text: string): void {
    this.mutateAttachments((list) => {
      list.push({ id: randomUUID(), kind: "selection", name, text });
    });
  }

  /** 供资源管理器右键调用：文件/目录都按内容分派（目录会自动识别成路径型）。 */
  addFileContext(path: string): void {
    this.applyPaths([{ path, name: this.attachmentName(path) }]);
  }

  /** 命令面板 / 右键文件夹：选目录加为上下文。 */
  async addFolder(): Promise<void> {
    await this.pickFolder();
  }

  private async openFile(path: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.log(`[open] 打开失败 ${path}：${this.describeError(error)}`);
    }
  }

  private async insertIntoEditor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage(
      vscode.l10n.t("No editor is open; the code was copied to the clipboard."),
    );
      return;
    }
    await editor.edit((builder) => builder.insert(editor.selection.active, text));
  }

  // ---------- 子代理 ----------

  /** 拉取子代理目录（投影里没有时按需请求）。 */
  private async refreshSubagents(): Promise<void> {
    if (!this.client || !this.currentSessionId) {
      this.emit({ type: "subagents/list", entries: [], parentAvailable: false });
      return;
    }
    try {
      const result = await this.client.request<{ entries?: unknown[]; parentAvailable?: boolean }>(
        "subagents/list",
        { parentSessionId: this.currentSessionId },
      );
      // `subagents/list` 返回的是 RPC 行 `SubagentListEntry`：`kind:'child'` 才是
      // 可用子代理，`kind:'diagnostic'` 是「有候选但读不出身份」的诊断行——这里
      // 过滤掉是对的（**投影**那边没有这个字段，别把这段照搬过去）。
      this.subagents = subagentsFromList(result.entries);
      this.emit({
        type: "subagents/list",
        entries: this.subagents,
        parentAvailable: result.parentAvailable ?? this.subagents.length > 0,
      });
    } catch (error) {
      this.log(`[subagents] 列表获取失败：${this.describeError(error)}`);
      this.emit({ type: "subagents/list", entries: [], parentAvailable: false });
    }
  }

  /**
   * 打开某个子代理的对话记录。
   *
   * 子代理是独立会话，用 `session/follow` 的 subagent 地址打开一次快照即可
   * （不需要长跟随：这里只是查看）。
   */
  private async openSubagent(childSessionId: string): Promise<void> {
    if (!this.client || !this.currentSessionId) return;
    const child = this.subagents.find((item) => item.id === childSessionId);
    if (!child) {
      this.log(`[subagents] 目录里没有 ${childSessionId}，不打开`);
      return;
    }
    const mode = child.mode;
    const parentSessionId = this.currentSessionId;
    const adapter = new SessionAdapter(() => {});
    adapter.setSession({
      id: childSessionId,
      title: childSessionId,
      updatedAt: Date.now(),
      running: false,
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        handle?.cancel();
        this.emit({ type: "subagent/transcript", id: childSessionId, messages: adapter.snapshotMessages() });
        resolve();
      };
      const handle = this.client!.openStream(
        "session/follow",
        {
          request: {
            // 模式**必须**用这个子代理的真实模式：硬编码 `continuable` 去打开一个
            // one-shot 子代理，宿主会以 `subagent/unauthorized` 拒绝（address 是
            // 宿主鉴权的一部分，不是提示）。目录里查不到时退回会话地址之外的空值
            // 没有意义，所以查不到就直接不发（列表里没有的 id 本就不该被打开）。
            address: { kind: "subagent", parentSessionId, childSessionId, mode },
            maxMessages: 60,
            assistantStream: false,
          },
        },
        {
          onItem: (value) => {
            adapter.applyFrame(value as never);
            if ((value as { type?: string })?.type === "event") {
              // 拿到第一条事件（或快照）后给一个小窗口收完剩余记录
              setTimeout(finish, 800);
            } else if ((value as { type?: string })?.type === "snapshot") {
              setTimeout(finish, 800);
            }
          },
          onError: () => finish(),
          onEnd: () => finish(),
        },
      );
      setTimeout(finish, 8_000);
    });
  }

  // ---------- 斜杠命令与文件提及 ----------

  /** 斜杠命令目录；冷会话也能列。 */
  private async listCommands(): Promise<void> {
    if (!this.client || !this.currentSessionId) {
      this.emit({ type: "commands/list", commands: [] });
      return;
    }
    try {
      const rows = await this.client.request<
        { name: string; description?: string; input?: { hint?: string } }[]
      >("commands/list", { agentId: this.currentSessionId });
      // 目录同时用于把「手打的 /xxx」路由到命令通道（见 slashCommandOf）：
      // 只有真正存在的命令才该被拦下来，打错的 `/foo` 仍按普通消息发出去。
      this.commandCatalog.clear();
      for (const row of rows ?? []) {
        if (row?.name) this.commandCatalog.set(row.name, { hint: row.input?.hint });
      }
      this.emit({
        type: "commands/list",
        commands: [
          ...(rows ?? []).map((row) => ({
            name: row.name,
            description: row.description ?? "",
            hint: row.input?.hint,
          })),
          ...(await this.skillCommands()),
        ],
      });
    } catch (error) {
      this.log(`[commands] 列表获取失败：${this.describeError(error)}`);
      this.emit({ type: "commands/list", commands: [] });
    }
  }

  /**
   * 技能目录（`skills/list`）→ `/` 菜单里的条目。
   *
   * 技能**不是**命令：没有 `commands/execute` 能执行它们，它们的用法是被模型用
   * `skill` 工具调起（或用户在正文里点名）。所以这里只是把技能名字放进候选列表，
   * 让用户**知道有这些技能、名字怎么拼**——选中后把名字作为普通文本发出去。
   *
   * 因此它们**不进** `commandCatalog`（那是「拦不拦这条斜杠命令」的判据，
   * 把技能放进去会让 `/build` 被当成命令通道执行，而服务端会回「没有这条命令」）。
   */
  private async skillCommands(): Promise<CommandView[]> {
    try {
      const value = await this.client!.request<{
        skills?: { name?: string; description?: string; whenToUse?: string }[];
      }>("skills/list", { request: { sessionId: this.currentSessionId } });
      return (value?.skills ?? [])
        .filter((skill) => typeof skill?.name === "string" && skill.name)
        .map((skill) => ({
          name: skill.name!,
          description: skill.description ?? "",
          hint: skill.whenToUse,
          skill: true,
        }));
    } catch (error) {
      // 没挂技能插件时这条 RPC 不存在：静默即可，不该让整个 `/` 菜单失败
      this.log(`[skills] 列表获取失败：${this.describeError(error)}`);
      return [];
    }
  }

  /** @ 提及：查询文件引用候选。 */
  private async queryFiles(query: string): Promise<void> {
    if (!this.client || !this.currentSessionId) {
      this.emit({ type: "files/list", query, items: [] });
      return;
    }
    try {
      const rows = await this.client.request<{ path: string; kind: "file" | "directory" }[]>(
        "fileReferences/list",
        { agentId: this.currentSessionId, query },
      );
      this.emit({ type: "files/list", query, items: rows ?? [] });
    } catch (error) {
      this.log(`[files] 查询失败：${this.describeError(error)}`);
      this.emit({ type: "files/list", query, items: [] });
    }
  }

  // ---------- 设置 ----------

  /** 读取全部设置命名空间，并把手里的 schema 化成可渲染字段。 */
  private async describeSettings(): Promise<void> {
    if (!this.client) return;
    try {
      const described = await this.client.settingsDescribe();
      const namespaces = (described as { namespaces?: Record<string, unknown>[] }).namespaces ?? [];
      // 「运行中回车」的行为来自部署设置（`ui-conversation.busyEnter`）。
      // 本机就是 `steer`，而发送路径曾经把 `queue` 写死——设置改了却没效果。
      this.applyBusyEnter(namespaces as { ns?: string; value?: unknown }[]);
      const sections = namespaces.map((item) => buildSettingsSection(item as never));
      this.emit({
        type: "settings/describe",
        sections,
        writable: Boolean((described as { writable?: boolean }).writable),
      });
    } catch (error) {
      this.log(`[settings] 读取失败：${this.describeError(error)}`);
      this.emit({ type: "settings/describe", sections: [], writable: false });
    }
  }

  /** 写入一个字段：布尔/数字/字符串都走 settings/mutate 的 set 操作。 */
  private async saveSetting(
    ns: string,
    path: string[],
    value: unknown,
    expectedRevision: number,
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request("settings/mutate", {
        ns,
        ops: [{ op: "set", path, value }],
        expectedRevision,
      });
      // 不额外弹提示：字段自己会显示「已保存」（见 Panels.tsx 的 Field）
      await this.describeSettings();
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to save to {0}", ns), error);
      // 版本冲突后重读，界面拿到新的 revision 才能重试
      await this.describeSettings();
    }
  }

  /** 重置某个命名空间的用户层覆盖。 */
  private async resetNamespace(ns: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request("settings/replace", { ns, section: {} });
      // 整组重置没有行内反馈，用轻提示告知结果
      this.emit({ type: "toast", level: "info", text: "@settingsResetDone" });
      await this.describeSettings();
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to reset {0}", ns), error);
    }
  }

  /**
   * 密钥字段写入凭据存储（值不会回显，服务端只回 set 状态）。
   *
   * ref 是 POSIX 环境变量名（schema 里 `role: credential-ref` 的兄弟字段给出，
   * 界面随字段一起带到 secretRef），不是设置路径。
   */
  private async saveSecret(ns: string, path: string[], value: string, ref?: string): Promise<void> {
    if (!this.client || !value) return;
    const target = ref || path[path.length - 1];
    try {
      await this.client.request("credentials/set", { ref: target, value });
      this.emit({ type: "toast", level: "info", text: "@settingsSaved" });
      await this.describeSettings();
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to write the secret ({0} → {1})", ns, target), error);
    }
  }

  /**
   * 报错（日志 + VS Code 通知）。
   *
   * `prefix` 由调用方用 `vscode.l10n.t(...)` 给出——这里跟随的是 **VS Code 自己的
   * 显示语言**，与 webview 的 `dshChat.language` 无关。
   *
   * `detail` 可能带 `@key` 标记（如 `describeError` 对授权失败给出的那两个），
   * 所以先经 `resolveForVsCode` 落地成当前语言的文本再拼。
   */
  private reportError(prefix: string, error: unknown): void {
    const detail = resolveForVsCode(this.describeError(error));
    const line = vscode.l10n.t("{0}: {1}", prefix, detail);
    this.log(`[error] ${line}`);
    void vscode.window.showErrorMessage(line);
  }

  dispose(): void {
    this.disposed = true;
    this.teardownStreams();
    this.client?.dispose();
  }
}

/**
 * 队列里「用户等待发送的消息」的视图：纯映射，见 dsh/queueView.ts。
 * 放在那边是为了让冒烟测试能直接验证，不必启动扩展宿主。
 */

/** 供日志通道使用的时间戳。 */
export function stamp(line: string): string {
  return `[${new Date().toLocaleTimeString()}] ${line}`;
}

