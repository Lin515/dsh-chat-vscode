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
  FileChangeKind,
  ModelSelectionView,
  ProviderGroupView,
  QuestionView,
  SessionSummaryView,
  UploadState,
} from "../shared/chat";
import type { HostToWebview, WebviewToHost } from "../shared/ipc";
import { SessionAdapter, type ImageRef } from "./adapter";
import { classifyDroppedBytes, classifyPath, formatPathList, isDirectoryPath, isImagePath } from "./attachments";
import { ConfigChangeRouter } from "./configChanges";
import { fileChangeKind, hasWorkingChange, isNotFoundError, resolveChipPath, type FileExistence, type GitChangeStateLike } from "./fileChange";
import { shouldContinuePaging } from "./historyPaging";
import { composeWithReferences, formatFileMention } from "./references";
import { resolveForVsCode } from "./hostText";
import { DshApiError, DshAuthError, DshClient, type ConnectionState, type SessionSummaryWire } from "./client";
import type { RemoteEventFrame, RemoteEventWaterfall, SessionControlFrame } from "./protocol";
import { SupervisorManager, type ServerInfo, type ServerStatus } from "./supervisorManager";
import { SessionScope } from "./scope";
import { queueItems, type QueueOrigin } from "./queueView";
import { goalFromProjection, planModeFromProjection, subagentsFromCatalog, subagentsFromList } from "./projections";
import { lineageDepths, visibleSessionRows } from "./sessionList";
import { buildSettingsSection } from "./settingsSchema";
import { isBlank, WindowRestore, WorkspaceWindowStateStore, type SidebarSlot, type WindowCache, type WindowKind } from "./windowState";

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
 * 界面字号（`dshChat.fontSize`）：用户填的基准像素（整数）。
 *
 * 合法域是 `0` ∪ 整数 ≥8：`0`（以及缺省/坏值）时界面用 VS Code 注入的
 * `--vscode-font-size`；填了整数时下发像素，界面写进 `--font-size`，
 * 整套文本尺度随之移动。手写 settings.json 能绕开设置页的类型校验，
 * 负数、小数、1–7 这类坏值按「拿不到肯定证据」处理：回退 auto，不动。
 */
function readFontSize(): number | undefined {
  const value = vscode.workspace.getConfiguration("dshChat").get<number>("fontSize");
  if (typeof value === "number" && Number.isInteger(value) && value >= 8) {
    return value;
  }
  return undefined;
}

/**
 * 一份问卷一次展开几道题（`dshChat.questionBatch`）。
 *
 * 合法域是**整数 ≥0**：`0` 表示始终一次展开全部；题目数**多于**它时界面改为
 * 依次问答。坏值（负数、小数、非数字）一律回退默认 3——手写 settings.json 能
 * 绕开设置页的校验，而「负数」既不是「全部展开」也不是「一题一题」，
 * 猜它的意图不如用默认值（与 `readFontSize` 同一条判据纪律）。
 */
const DEFAULT_QUESTION_BATCH = 3;
function readQuestionBatch(): number {
  const value = vscode.workspace.getConfiguration("dshChat").get<number>("questionBatch");
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return DEFAULT_QUESTION_BATCH;
}

/** 把投影里的未知值收成数字（缺字段/坏值一律用回退值）。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 同上，但没有回退值：缺字段/坏值一律 undefined（用于「可缺」的投影字段）。 */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 内建 git 扩展导出对象的**结构**视图。
 *
 * `@types/vscode` 只带 VS Code 自己的 API，git 扩展的 API 类型不随包发布，
 * 所以这里按用到的字段自己声明。形状是读内建扩展的实现确认的（VS Code 1.137
 * `extensions/git/dist/main.js`）：
 * - `getAPI(1).getRepository(uri).state` 上确实有 `workingTreeChanges` /
 *   `indexChanges` / `mergeChanges` 三个清单（同一个文件里的
 *   `git.api.getRepositoryState` 也是这么取的）；
 * - `getAPI(1).repositories` 返回数组（`get repositories(){return this.#e.repositories.map(...)}`），
 *   每个元素有 `async status(): Promise<void>`（`await this.run(ae.Status)`）
 *   —— 这就是轮次结束后主动推 Git 状态刷新用的那个方法。
 */
interface GitApiLike {
  /** 全部已打开仓库（写类调用可能落在别的仓库里，刷新要全覆盖）。 */
  readonly repositories?: readonly GitRepositoryLike[];
  getRepository(uri: vscode.Uri): GitRepositoryLike | null;
}

interface GitRepositoryLike {
  readonly state?: GitChangeStateLike;
  /** 重跑一次 `git status` 并刷新扩展里的 `state`。 */
  status(): Promise<void>;
}

interface GitExtensionExportsLike {
  getAPI(version: number): GitApiLike;
}

/** 服务器 → webview 的会话内容总控。 */
export class ChatController implements vscode.Disposable {
  private client: DshClient | undefined;
  private sessions: SessionSummaryView[] = [];
  /**
   * 打开的会话域（sessionId → 域）。每个窗口绑定一个域；域内产生的帧只发给
   * 绑定该会话的窗口（见 `deliver`），全局帧走 `emitAll`。域在窗口首次绑定时
   * 惰性创建，最后一个绑定窗口解绑时回收。
   */
  private readonly scopes = new Map<string, SessionScope>();
  /** 窗口（viewId）→ 当前绑定的会话 id。未绑定的窗口是「空态」（还没有会话）。 */
  private readonly viewSessions = new Map<string, string>();
  /**
   * 窗口（viewId）→ 它属于哪种宿主（主侧栏 / 辅助侧栏 / 编辑区面板）。
   *
   * 只有编辑区面板需要额外照看：VS Code 会按自己的节奏恢复面板（`WebviewPanelSerializer`），
   * 而侧栏视图是 VS Code 必定重建的容器。窗口状态缓存要按种类分别记（见
   * `persistWindowState`），所以挂窗口时就得把种类记下来。
   */
  private readonly viewKinds = new Map<string, WindowKind>();
  /**
   * 工作区级的「会话窗口状态」缓存（`workspaceState`，见 `dsh/windowState.ts`）。
   * 关掉工作区前谁开着哪个会话，下次打开时据此各自接回。
   */
  private readonly windowState: WorkspaceWindowStateStore;
  /** 恢复期的会话认领器（编辑区面板按下标对位，见 `WindowRestore`）。 */
  private readonly windowRestore: WindowRestore;
  /**
   * 恢复期给每个窗口暂存的「该接回哪个会话」：窗口刚挂上时可能还没连接、
   * 甚至页面还没加载，那一刻绑定会推开一个空快照；等它发 `ready` 时再绑，
   * 正好把这个会话写进它的首帧快照里。
   */
  private readonly restoreHints = new Map<string, string>();
  /**
   * 恢复窗口（还有缓存里的窗口没来认领）期间攒下的「要写缓存」标记。
   * 见 `persistWindowState` 与 `settleRestoreWindow`。
   */
  private restoreWritePending = false;
  /**
   * 工作区身份还没就绪时排队的**编辑区面板**认领（按 VS Code 的恢复顺序入队）。
   * 顺序就是位置，所以必须按原序补（见 `flushRestoreClaims`）。
   */
  private readonly panelClaimsQueued: string[] = [];
  /** 上面那批窗口（`ChatViewProvider` 据此决定是否留等 `ready` 的兜底）。 */
  private readonly restoreAwaiting = new Set<string>();
  /**
   * 窗口的最近活动顺序（末尾 = 最近活动）。命令面板入口（新建/历史/停止/加选区…）
   * 都指向「最近活动的那个窗口」——VS Code 没有 API 问用户此刻在看哪个视图，
   * 只能按「谁最后发了消息 / 谁可见」推断。
   */
  private readonly viewOrder: string[] = [];
  /**
   * 窗口（viewId）→ 把它带到前台的动作。
   *
   * 三种宿主的「显示」语义各不相同：主/辅助侧栏是 `WebviewView.show()`（还需要
   * 先把容器切过去），编辑区面板是 `WebviewPanel.reveal()`。控制器不知道谁是谁，
   * 由 `ChatViewProvider` 在挂窗口时注册。
   *
   * 为什么需要：编辑器右键「添加选中代码到对话」之后要**把焦点还给用户上次用的
   * 那个对话窗口**。此前写死 `dshChat.view.focus`（主侧栏），于是对话开在编辑区
   * 面板时，加完引用视线被硬拽到侧栏——用户 2026-09-14 报的正是这条。
   */
  private readonly revealers = new Map<string, () => void>();
  private controlHandle: { cancel(): void } | undefined;
  private eventsHandle: { cancel(): void } | undefined;
  private eventsClientId: string | undefined;
  private readonly handledEvents = new Set<string>();
  /**
   * 配置文件热重载：宿主侧的 watcher（`settings.yaml` / `cordis.patch.yml` /
   * `.credentials.yaml`）改了什么，这里就按服务端转发的 emit 帧重读什么。
   * 帧 → 动作的映射与合并见 `configChanges.ts`。
   */
  private readonly configChanges: ConfigChangeRouter;
  /**
   * 对应会话**还没有窗口打开**时就到达的审批 / 提问（关窗后服务端仍可能继续跑）。
   * 先挂起——**不能回**：回了等于放行，请求就丢了。会话再次被打开（域创建）时
   * 回放进适配器。eventId → 会话 同时记在 `eventSessions`，回答时据此路由回域。
   */
  private readonly heldEvents = new Map<
    string,
    { kind: "approval" | "question"; sessionId: string; request: unknown }
  >();
  private readonly eventSessions = new Map<string, string>();
  private workspaceHandle: { cancel(): void } | undefined;
  /**
   * 服务端**工作区注册表**里当前项目那条记录的 id（`workspace/create` 幂等返回）。
   *
   * 它决定新会话会不会被记进工作区分组：DSH Web 的分组不是按 cwd 推的，而是
   * 「会话 header 的 cwd == 工作区路径」**且**「会话在注册表的 sessionIds 里」，
   * 后半条只有 `session/create` 带 `workspaceId` 时才会发生。缓存它避免每次
   * 新建会话都发一次注册请求；换个服务器（新 client）时清空重取。
   */
  private workspaceId: string | undefined;
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
   * 已绑定会话的窗口用会话 id 做键（同会话的多窗口共享）；**未绑定**的窗口用
   * 自己的 viewId 做键（各自暂存，建会话时迁移到会话键，见 `bindViewToSession`）。
   */
  private readonly drafts = new Map<string, string>();
  private readonly attachmentsBySession = new Map<string, Attachment[]>();
  private models: ProviderGroupView[] = [];
  /**
   * 部署默认模型（`agent-default-model` 设置命名空间）。
   * 新会话在首轮之前没有 `modelSelection` 投影，模型胶囊退回这个值。
   * 全局一份：它是部署配置，不是会话状态。
   */
  private defaultModel: ModelSelectionView | undefined;
  /**
   * 已提交但可能还排在队列里的消息：requestId → 用户当时真正输入的内容。
   *
   * 为什么不能直接用队列回显：提交给服务端的正文里已经把 `@path` 引用拼在正文
   * 前面（见 `composeWithReferences`），上传文件变成 `{type:'file', receiptId}`
   * 内容块、图片是独立内容块——回显文本里看不到这些结构。用回显「重新编辑」
   * 会丢掉附件芯片。这里按 requestId 存原文，队列帧带回 `rpcId` 时就能对回去。
   * requestId 全局唯一，跨会话共享一份表即可。
   */
  private readonly submissions = new Map<
    string,
    { text: string; attachments: Attachment[]; content: unknown[]; at: number }
  >();
  private connection: ConnectionState | "error" = "connecting";
  private connectionDetail: string | undefined;
  /** 上次连接因缺少/拒绝令牌失败：界面据此给出「输入令牌」入口。 */
  private needsToken = false;
  /** 心跳触发的共享后台切换正在跑（去重，见 `reconnectPeer`）。 */
  private peerReconnect = false;
  private disposed = false;

  /**
   * 宿主 → 窗口的订阅。`target` 是 `"all"`（全局帧：连接、会话列表、模型目录、
   * 设置……发给所有窗口）或一个 viewId（定向帧：只发给那个窗口）。
   * 会话帧在控制器里先按会话解析出窗口集合再逐个发。
   */
  private readonly listeners = new Set<(target: "all" | string, frame: HostToWebview) => void>();

  constructor(
    private server: SupervisorManager,
    private readonly log: (line: string) => void,
    /** 全局存储：跨工作区的状态（本地已删除的会话 id）。 */
    private readonly state: vscode.Memento,
    /** **工作区**存储：VS Code 自己那份按工作区分文件的缓存（窗口状态）。 */
    private readonly workspaceState: vscode.Memento,
    /** 外部服务器会话 cookie 的存放处（SecretStorage，不落明文配置）。 */
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.deletedSessionIds = new Set(this.state.get<string[]>("deletedSessionIds") ?? []);
    // 窗口状态缓存走 **workspaceState**（VS Code 自己的工作区缓存）而不是 globalState：
    // 「这个文件夹上次开着哪几个窗口、各自是哪个会话」本来就是工作区级的，
    // 换个项目不该被带过去。读取是同步的（构造期一次），所以激活同期的
    // `deserializeWebviewPanel` 里也能立刻拿到缓存。
    this.windowState = new WorkspaceWindowStateStore({ storage: this.workspaceState, log });
    this.windowRestore = new WindowRestore(this.windowState.snapshot(), log);
    // 工作区身份可能此刻还没就绪：恢复由 VS Code 驱动（面板恢复甚至就是本次激活的
    // 原因），序列化器可能先于 workspaceFolders 可用被调用。所以这里允许「先挂窗口、
    // 后绑缓存键」：认领请求按序排队，等键绑上（`ensureWindowState`）再补。
    this.ensureWindowState();
    this.configChanges = new ConfigChangeRouter(
      {
        reloadSettings: () => this.reloadSettings(),
        reloadModelTopology: () => this.loadModels(),
        reloadCommandCatalogs: (sessionId) => this.reloadCommandCatalogs(sessionId),
      },
      log,
    );
    // 早期版本存过启动令牌；令牌每次启动都会刷新，留着只会误导，直接清掉
    void this.secrets.delete(LEGACY_TOKEN_SECRET);

    // 心跳自检：只有控制器知道"当前连接还活着吗"。ServerManager 每 5 秒问一次，
    // 这里回答两件事：连接还在吗；不在的话该连哪儿（共享后台的地址可能已经被
    // 别的窗口换掉——它重起过，端口变了）。
    //
    // 换地址这件事**由控制器执行**（`reconnectPeer`），因为重建客户端与重开
    // 跟随流都是客户端侧的事；管理器只管进程与租约。
    this.server.onHeartbeat(() => {
      void this.handleHeartbeat();
    });
  }

  /** 当前后台管理器（恒为激活期那一个；配置变更改为重载窗口，不再整体替换）。 */
  get currentServer(): SupervisorManager {
    return this.server;
  }

  /**
   * 心跳的一次体检：连接还活着吗？不活就换到该去的地方。
   *
   * 完全异步（探测本身要发 HTTP），所以它**不阻塞** manager 的心跳节拍：
   * 钩子只负责叫起这一轮，结论由这里自己消化。
   */
  private async handleHeartbeat(): Promise<void> {
    const probe = await this.probeConnection(this.server.activeBaseUrl);
    if (probe.alive || !probe.info) return;
    await this.reconnectPeer(probe.info);
  }

  /**
   * 心跳用的连接体检（**纯 HTTP，不碰 WS / 不断开任何东西**）。
   *
   * 刻意这么轻：它每 5 秒跑一次，任何"顺手重连一下"的动作都会变成风暴。
   * 未授权（401/403）也算活着——我们只判断"这个地址上有没有服务器"。
   *
   * 新形态下它比旧实现简单得多：**地址只有一个来源**（supervisor 的会合文件，
   * 由 manager 通过长连接推给我们），不再需要"去租约里找别的窗口的后台"。
   */
  private async probeConnection(active: string | undefined): Promise<{ alive: boolean; info?: ServerInfo }> {
    const info = this.server.getStatus().info;
    if (!active || !info) return { alive: false };
    return { alive: await this.reachable(active), info: { ...info } };
  }

  /** 不带凭据探一下这个地址上有没有 HTTP 服务（401/403 也算活着）。 */
  private async reachable(baseUrl: string): Promise<boolean> {
    try {
      await fetch(baseUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 心跳发现：我们连的是**别的窗口**的后台，而它换了地址（或刚被重起）。
   * 换上新的令牌/地址重连——会话还在服务端，只是连接要重来一次。
   *
   * `inFlight` 去重是必须的：心跳每 5 秒一次，而重连要起 PowerShell/HTTP 好几轮，
   * 不去重就会并发建出多个客户端，每个都开一套跟随流。
   */
  async reconnectPeer(info: ServerInfo): Promise<void> {
    if (this.peerReconnect) return;
    this.peerReconnect = true;
    try {
      this.log(`[server] 切换共享后台：${info.baseUrl}`);
      this.teardownStreams();
      this.client?.dispose();
      this.client = undefined;
      await this.ensureConnected();
    } catch (error) {
      this.log(`[server] 切换共享后台失败：${this.describeError(error)}`);
    } finally {
      this.peerReconnect = false;
    }
  }

  // ---------- 订阅与路由 ----------

  subscribe(listener: (target: "all" | string, frame: HostToWebview) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  /** 全局帧：发给所有窗口（连接状态、会话列表、模型目录、设置……）。 */
  private emitAll(frame: HostToWebview): void {
    for (const listener of this.listeners) listener("all", frame);
  }

  /** 发给某个窗口。 */
  private emitToView(viewId: string, frame: HostToWebview): void {
    for (const listener of this.listeners) listener(viewId, frame);
  }

  /**
   * 会话帧：只发给绑定了该会话的窗口。顺带把「是否正在生成」同步到域上：
   * 宿主状态（首帧快照、ESC 处理）依赖它，而 turn/start 与 turn/end 只由适配器
   * 发出 patch。
   */
  private deliver(sessionId: string, frame: HostToWebview): void {
    if (frame.type === "patch" && typeof frame.patch.running === "boolean") {
      const scope = this.scopes.get(sessionId);
      if (scope) scope.running = frame.patch.running;
    }
    const targets: string[] = [];
    for (const [viewId, bound] of this.viewSessions) {
      if (bound === sessionId) targets.push(viewId);
    }
    if (!targets.length) return;
    for (const listener of this.listeners) {
      for (const viewId of targets) listener(viewId, frame);
    }
  }

  private workspacePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : process.cwd();
  }

  /** 窗口的草稿 / 附件键：已绑定用会话 id，未绑定用 viewId 自身（见字段注释）。 */
  private keyForView(viewId: string): string {
    return this.viewSessions.get(viewId) ?? viewId;
  }

  /** 给新连接的窗口（`ready`）的首帧快照：它绑定的会话（未绑定 = 空态）。 */
  snapshotFor(viewId: string | undefined): ChatState {
    const sessionId = viewId ? this.viewSessions.get(viewId) : undefined;
    const scope = sessionId ? this.scopes.get(sessionId) : undefined;
    return {
      connection: this.connection === "error" ? "error" : this.connection === "connected" ? "ready" : "connecting",
      connectionDetail: this.connectionDetail,
      /** 外部服务器缺令牌：界面给「输入令牌」按钮。 */
      needsToken: this.needsToken || undefined,
      serverUrl: this.client?.baseUrl,
      locale: readLanguage(),
      /** 编辑类节点的 diff 排版（auto / unified / split）。 */
      diffLayout: readDiffLayout(),
      /** 界面字号（px）；undefined = auto，跟随 VS Code 注入的字号。 */
      fontSizePx: readFontSize(),
      /** 问卷一次展开几道题（多于它就依次问答；0 = 始终全部展开）。 */
      questionBatch: readQuestionBatch(),
      session: sessionId ? this.sessions.find((session) => session.id === sessionId) : undefined,
      messages: scope?.adapter?.snapshotMessages() ?? [],
      running: scope?.running ?? false,
      queueItems: scope?.queueItems ?? [],
      attachments: this.attachmentsBySession.get(sessionId ?? viewId ?? "") ?? [],
      draft: this.drafts.get(sessionId ?? viewId ?? "") ?? "",
      models: this.models,
      model: scope?.model,
      permission: scope?.permission,
      planMode: scope?.planMode ?? false,
      todos: scope?.todos ?? [],
      subagents: scope?.subagents ?? [],
      jobs: scope?.jobs ?? [],
      goal: scope?.goal,
      // 会话内的粘性显示值：首帧快照必须带上，否则 webview 一重载，上下文占用/
      // 速度/构成/统计就空到下一轮才有数据（表现为「时有时无」）
      ...(scope?.adapter?.stickyState() ?? {}),
      // 文件芯片的记号表同理**必须在首帧里**：patch 侧有「没变化不重发」的去重，
      // 而重载 / 第二个窗口一来就重算出的表与缓存相同 → 那个 patch 永远不会发，
      // 新窗口的 [新增] / 删除线就会一直是空的（用户 2026-09-14 报的「重载后
      // 记号全没了」）。undefined 会过线成 null → 界面折回「没有这张表」。
      fileKinds: scope?.adapter?.fileKindsState(),
      // 「加载更早」的可用性：重放只在 follow 流开窗那一刻发过一次 patch，
      // 第二个窗口绑上已有会话 / 页面重载后要靠快照补回
      hasMoreHistory: scope?.adapter?.hasMoreHistory() ?? false,
      contextBreakdown: scope?.contextBreakdown,
      sessionStats: scope?.sessionStats,
      tokenUsage: scope?.tokenUsage,
      turnOutline: scope?.turnOutline,
      imageLimits: scope?.imageLimits,
    };
  }

  // ---------- 窗口绑定 ----------

  /** 新窗口上线（还没有会话，是空态）。 */
  bindView(viewId: string): void {
    if (!this.viewOrder.includes(viewId)) this.viewOrder.push(viewId);
  }

  /**
   * 登记窗口的种类（主侧栏 / 辅助侧栏 / 编辑区面板）。
   *
   * 窗口状态缓存按种类分槽：侧栏各一个固定槽位，编辑区面板是一条列表
   * ——恢复时侧栏按槽位接、面板按下标认领（见 `WindowRestore`）。
   */
  bindViewKind(viewId: string, kind: WindowKind): void {
    this.viewKinds.set(viewId, kind);
    this.persistWindowState();
  }

  /**
   * 把一个已有的窗口绑到某个会话（恢复路径用：刷新会话列表 + 建域 + 推快照）。
   *
   * 与 `openSession` 的分工：那边是「用户点了历史里的一条」，只做重绑；这边是
   * 「工作区刚打开，这个窗口上次开的就是它」，多一步**先确认会话还在**——
   * 缓存是上一次运行留下的，会话可能已经被删掉或归档（服务端没有删除 API，
   * 本地删除只记了 id）。会话不在了就什么都不做，窗口保持空态。
   */
  async restoreViewSession(viewId: string, sessionId: string): Promise<void> {
    if (this.viewSessions.get(viewId) === sessionId) return;
    if (!this.client || this.connection !== "connected") await this.ensureConnected();
    if (!this.client || this.connection !== "connected") {
      this.log(`[restore] 未连接，跳过 ${sessionId}`);
      return;
    }
    // 会话列表是「哪些会话还在」的权威来源（它已经滤掉本地删除的、并在
    // 归档流到达后重建）：不在列表里就当它不存在，别把窗口接到一个死会话上
    if (!this.sessions.length) await this.refreshSessions();
    if (!this.sessions.some((session) => session.id === sessionId)) {
      this.log(`[restore] 会话已不存在（已删/已归档），窗口回退空态：${sessionId}`);
      return;
    }
    this.log(`[restore] 窗口=${viewId} 接回会话=${sessionId}`);
    await this.openSession(viewId, sessionId);
  }

  /**
   * 这个窗口的恢复认领**还排着队**（工作区身份未就绪，见 `ensureWindowState`）。
   *
   * `ChatViewProvider` 用它决定要不要给这个窗口留一次「等 `ready` 再接回会话」
   * 的机会：认领已经落定的窗口不必留（那时接回本来就要等 `ready`）。
   */
  hasPendingRestore(viewId: string): boolean {
    return this.restoreAwaiting.has(viewId);
  }

  /**
   * 面板恢复会话的认领（按下标对位，见 `WindowRestore.claimPanel`）。
   *
   * 缓存键还没绑上时**先排队**：位置就是这个面板的恢复顺序，等键绑好再按序补
   * （见 `flushRestoreClaims`）——提前认领会把顺序用掉，后面的窗口就接错了。
   */
  claimPanelRestore(viewId: string): void {
    if (!this.windowState.key) {
      this.panelClaimsQueued.push(viewId);
      this.restoreAwaiting.add(viewId);
      this.log(`[restore] 工作区身份未就绪，面板 ${viewId} 的认领先排队`);
      return;
    }
    this.applyRestoreHint(viewId, this.windowRestore.claimPanel());
    this.settleRestoreWindow();
  }

  /** 侧栏恢复会话的认领（固定槽位）。 */
  claimSidebarRestore(viewId: string, slot: SidebarSlot): void {
    if (!this.windowState.key) {
      this.ensureWindowState();
      if (!this.windowState.key) {
        // 工作区真的没有文件夹（空窗口）→ 本来就没有缓存可恢复
        this.log("[restore] 没有打开的工作区文件夹，不做窗口恢复");
        return;
      }
    }
    this.applyRestoreHint(viewId, this.windowRestore.slot(slot));
    this.settleRestoreWindow();
  }

  /** 该窗口有没有待接回的会话（`ChatViewProvider` 发 `ready` 前用它决定等多久）。 */
  hasRestoreHint(viewId: string): boolean {
    return this.restoreHints.has(viewId);
  }

  private applyRestoreHint(viewId: string, sessionId: string | undefined): void {
    if (sessionId) this.restoreHints.set(viewId, sessionId);
  }

  /**
   * 缓存的读侧延迟绑定：构造时工作区身份可能还没就绪（`workspaceFolders` 为空），
   * 键就先没有；第一次真正要用（认领 / 恢复）时补一次，绑上就重新读一次缓存。
   *
   * 绑定只做一次：键有了就不再重算——工作区在会话中途变过（多根增删）属于极少数，
   * 那时以启动时的 folders 为准更稳定。
   */
  private ensureWindowState(): void {
    if (this.windowState.key) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    if (!folders.length) return;
    const cache = this.windowState.bindFolders(folders);
    this.windowRestore.replace(cache);
    const known = [cache.primary, cache.secondary].filter((entry) => !isBlank(entry)).length;
    this.log(
      `[restore] 窗口缓存：侧栏 ${known} 个、编辑区面板 ${cache.panels.length} 个（key=${this.windowState.key}）`,
    );
    this.flushRestoreClaims();
  }

  /** 把排队中的认领按原顺序补上（顺序就是这个窗口在恢复序列里的位置）。 */
  private flushRestoreClaims(): void {
    if (!this.windowState.key) return;
    for (const viewId of this.panelClaimsQueued.splice(0)) {
      this.restoreAwaiting.delete(viewId);
      if (!this.viewKinds.has(viewId)) continue;
      this.applyRestoreHint(viewId, this.windowRestore.claimPanel());
      this.settleRestoreWindow();
    }
  }

  /**
   * 窗口的页面就绪（或兜底超时）时把暂存的会话接回去。
   *
   * 为什么必须等 `ready`：`restoreViewSession` 会推一份完整快照，而网页还没加载完
   * 时推的快照会丢（webview 的 message 监听是在 bundle 执行后才挂上的）。
   * 绑在这一刻，会话内容正好出现在它的首帧快照里。
   */
  async resumeRestoreHint(viewId: string): Promise<void> {
    const sessionId = this.restoreHints.get(viewId);
    if (!sessionId) return;
    this.restoreHints.delete(viewId);
    await this.restoreViewSession(viewId, sessionId);
    // 接回会话会落一次缓存；若这是最后一个待恢复的窗口，恢复窗口就此结束
    this.settleRestoreWindow();
  }

  /** 注册「把这个窗口带到前台」的动作（见 `revealers`）。 */
  registerRevealer(viewId: string, reveal: () => void): void {
    this.revealers.set(viewId, reveal);
  }

  /**
   * 把**最近活动的窗口**带到前台。
   *
   * 命令面板与编辑器右键入口调用它：那些动作的目标窗口就是 `activeViewId()`，
   * 把焦点交回同一个窗口才对得上（见 `revealers` 的注释）。
   */
  revealActiveView(): void {
    const viewId = this.activeViewId();
    if (viewId) this.revealers.get(viewId)?.();
  }

  /** 窗口产生活动（发了消息 / 编辑器面板变可见）。 */
  noteActiveView(viewId: string): void {
    const index = this.viewOrder.indexOf(viewId);
    if (index >= 0 && index === this.viewOrder.length - 1) return;
    if (index >= 0) this.viewOrder.splice(index, 1);
    this.viewOrder.push(viewId);
    // 顺序变了才落缓存：这条路径每来一条消息都会被调（流式期间很密），
    // 落盘本身是防抖的，这里再省掉「本来就是最后一个」的绝大多数调用
    this.persistWindowState();
  }

  /** 窗口下线：解绑，若它是该会话最后一个窗口则回收整个域。 */
  unbindView(viewId: string): void {
    const sessionId = this.viewSessions.get(viewId);
    this.viewSessions.delete(viewId);
    this.revealers.delete(viewId);
    this.viewKinds.delete(viewId);
    this.restoreHints.delete(viewId);
    const index = this.viewOrder.indexOf(viewId);
    if (index >= 0) this.viewOrder.splice(index, 1);
    if (sessionId) this.dropViewers(sessionId);
    // 关掉的窗口不该留在缓存里：VS Code 只恢复「上次退出时还开着」的面板，
    // 缓存里多留一条，下次启动就可能多开一个窗口（恢复未完时这次写会延后，
    // 见 `persistWindowState`，但一定会写）
    this.persistWindowState();
  }

  /**
   * 把当前窗口状态写进工作区缓存（变更后调用，落盘由 store 防抖）。
   *
   * 「当前状态」就是内存里那几张表的投影：`viewSessions` 是绑定，
   * `viewKinds` 是种类，`viewOrder` 是最近活动顺序。编辑区面板的顺序取
   * `viewOrder` 里出现过的先后（= 创建顺序），与 VS Code 恢复编辑器的
   * 顺序一致（都是「当初的排布顺序」）。
   *
   * **恢复未完时不写**：VS Code 是「面板第一次变为可见时」才认领会话的
   * （见 `WindowRestore.pending`），那一刻之前活着的窗口只是**已经恢复的**那部分
   * ——此时按内存状态覆写，缓存里还没露面的面板就会被抹掉（它们的会话随之失联）。
   * 所以恢复窗口内只记「待写」，等最后一个槽位问过话再一次性落盘；
   * 用户在恢复窗口里真关掉一个窗口也走这条路（关窗会调 `markDirty`），
   * 不会因为延后而丢。
   */
  private persistWindowState(): void {
    if (!this.windowState.key) return;
    if (this.pendingRestore) {
      this.restoreWritePending = true;
      return;
    }
    const now = Date.now();
    const cache: WindowCache = { panels: [], activeOrder: [...this.viewOrder] };
    // 编辑区面板：按 `viewOrder` 里出现的先后（= 创建顺序）逐条记，
    // 与 VS Code 恢复编辑器时的顺序一致
    for (const viewId of this.viewOrder) {
      if (this.viewKinds.get(viewId) !== "panel") continue;
      cache.panels.push({ sessionId: this.viewSessions.get(viewId) ?? null, lastActiveAt: now });
    }
    for (const [viewId, kind] of this.viewKinds) {
      if (kind === "panel") continue;
      cache[kind] = { sessionId: this.viewSessions.get(viewId) ?? null, lastActiveAt: now };
    }
    this.windowState.load(cache);
    this.windowState.markDirty();
  }

  /**
   * 恢复窗口是否还没结束（还有缓存里的窗口没来认领）。
   *
   * 恢复一结束就把期间攒下的变更补写一次——否则「恢复窗口里的最后一次变更」
   * 要等到下一次窗口活动才落盘，中间关掉 VS Code 就白改了。
   */
  private get pendingRestore(): boolean {
    return this.windowRestore.pending;
  }

  private settleRestoreWindow(): void {
    if (this.pendingRestore || !this.restoreWritePending) return;
    this.restoreWritePending = false;
    this.log("[restore] 恢复窗口结束，补写窗口缓存");
    this.persistWindowState();
  }

  /** 最近活动的窗口（命令面板入口都指向它）。 */
  activeViewId(): string | undefined {
    return this.viewOrder[this.viewOrder.length - 1];
  }

  /** 最近活动窗口当前绑定的会话（命令面板直接入口时用作默认目标）。 */
  activeSessionId(): string | undefined {
    const viewId = this.activeViewId();
    return viewId ? this.viewSessions.get(viewId) : undefined;
  }

  private scopeOfView(viewId: string | undefined): SessionScope | undefined {
    if (!viewId) return undefined;
    const sessionId = this.viewSessions.get(viewId);
    return sessionId ? this.scopes.get(sessionId) : undefined;
  }

  private dropViewers(sessionId: string): void {
    const scope = this.scopes.get(sessionId);
    if (!scope) return;
    scope.viewers -= 1;
    if (scope.viewers > 0) return;
    this.destroyScope(scope);
  }

  /**
   * 回收会话域：切断 follow 流、丢弃视图模型。
   * 会话本身在服务端继续存活——重新打开时重新跟随、重新推快照，状态从服务端
   * 重算（草稿/附件在控制器侧按会话键保留，不受影响）。
   */
  private destroyScope(scope: SessionScope): void {
    this.scopes.delete(scope.sessionId);
    scope.followHandle?.cancel();
    scope.followHandle = undefined;
    scope.adapter = undefined;
    this.log(`[scope] 回收域 session=${scope.sessionId}`);
  }

  /**
   * 把一个窗口绑到指定会话（域不存在则创建）。
   *
   * 窗口原来无会话时，它按 viewId 暂存的草稿/附件在这里迁移到会话键——
   * 输入框里的话和刚加的附件不能因为会话建立而丢。
   */
  private bindViewToSession(viewId: string, sessionId: string, scope: SessionScope): void {
    const previous = this.viewSessions.get(viewId);
    if (previous === sessionId) return;
    if (previous) {
      this.dropViewers(previous);
    } else {
      const draft = this.drafts.get(viewId);
      if (draft !== undefined) {
        this.drafts.set(sessionId, draft);
        this.drafts.delete(viewId);
      }
      const attachments = this.attachmentsBySession.get(viewId);
      if (attachments) {
        this.attachmentsBySession.set(sessionId, attachments);
        this.attachmentsBySession.delete(viewId);
      }
    }
    this.viewSessions.set(viewId, sessionId);
    scope.viewers += 1;
    this.log(`[bind] 窗口=${viewId} → 会话=${sessionId}（原=${previous ?? "空态"}）`);
    this.persistWindowState();
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
      // 工作区 id 是**服务端注册表**里的东西：换了服务器（或注册表被重置）时
      // 旧 id 会 `workspace/not-found`，所以每次新建 client 都重新解析一次
      this.workspaceId = undefined;
      client.connect();
      await this.loadModels();
      await this.refreshSessions();
      this.setConnection("connected");
      // 不再自动建会话：每个窗口的会话由它自己的首次动作（发消息/新建/切会话）
      // 按需建立，空窗口保持空态——多窗口各自为政，互不同步。
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
            "The server {0} requires authorization. Paste the token printed in the URL when dsh web started (the part after ?token=; the token is refreshed on every restart, but the extension stores the session cookie it exchanges for, so it does not have to be verified again).",
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
    this.emitAll({ type: "patch", patch: { needsToken: needed } });
  }

  /** 配置里改了 diff 排版：直接推给界面，不必重载 webview。 */
  refreshDiffLayout(): void {
    this.emitAll({ type: "patch", patch: { diffLayout: readDiffLayout() } });
  }

  /**
   * 配置里改了语言、字号或问卷一次展开的题数：推给界面。
   *
   * 三者都**不需要**重载 webview：语言是纯词典切换（界面用 `locale` 选字典），
   * 字号与题数是几个数字。重载会丢掉滚动位置与展开状态，代价不成比例。
   */
  refreshAppearance(): void {
    this.emitAll({
      type: "patch",
      patch: {
        locale: readLanguage(),
        /** 0（auto）时为 undefined，过线成 null，界面清掉 `--font-size` 回到 VS Code 字号 */
        fontSizePx: readFontSize(),
        questionBatch: readQuestionBatch(),
      },
    });
  }

  private async onConnected(): Promise<void> {
    // socket 重建后长活流都要重开：每个打开的域重新跟随（适配器整个重建，
    // 新快照会重放最近 60 条），全局流重开一次
    for (const scope of this.scopes.values()) this.openScopeFollow(scope);
    // 重连后服务端会重投递未决的审批/提问；若某个会话的窗口当时关着、事件已
    // 挂在 heldEvents 里，域还在，这里直接回放（heldEvents 消费后即清，
    // 服务端重投递会被 handledEvents 幂等放行，不会重复弹卡片）
    for (const [eventId, held] of [...this.heldEvents]) {
      const scope = this.scopes.get(held.sessionId);
      if (!scope) continue;
      this.heldEvents.delete(eventId);
      this.deliverEventToScope(eventId, held, scope);
    }
    this.openControlStream();
    this.openEventsStream();
    this.openWorkspaceStream();
  }

  private setConnection(state: ConnectionState | "error", detail?: string): void {
    this.connection = state;
    this.connectionDetail = detail;
    // 连接状态是所有窗口共享的全局态
    this.emitAll({
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
    // 接入的是**别的窗口**拉起的后台时，"重启服务器"会打断所有窗口（supervisor 杀 dsh
    // 再拉起一个，端口通常会变）——那是一次对所有人的中断，必须说出来，不能静默
    const wasPeer = this.server.getStatus().info?.ownership === "peer";
    this.log(wasPeer ? "[server] 重启（后台由别的窗口拉起，会打断所有窗口）" : "[server] 重启");
    this.teardownStreams();
    this.client?.dispose();
    this.client = undefined;
    await this.server.restart();
    await this.ensureConnected();
    if (wasPeer) {
      this.emitAll({ type: "toast", level: "warn", text: "@sharedRestarted" });
      return;
    }
    vscode.window.showInformationMessage(vscode.l10n.t("The DSH server has been restarted."));
  }

  /** 服务器状态变化时同步给界面。 */
  onServerStatus(status: ServerStatus): void {
    if (status.state === "failed" && status.detail) {
      this.setConnection("error", status.detail);
    }
  }

  // ---------- 会话 ----------

  /** 命令面板入口「DSH: 历史对话」：刷新列表并让**最近活动的窗口**切到历史抽屉。 */
  async openHistory(): Promise<void> {
    await this.refreshSessions();
    const target = this.activeViewId();
    if (target) this.emitToView(target, { type: "ui/openPanel", panel: "history" });
    else this.emitAll({ type: "ui/openPanel", panel: "history" });
  }

  async refreshSessions(): Promise<void> {
    if (!this.client) return;
    try {
      const value = await this.client.listSessions();
      // 只显示属于**当前工作区**的会话（dsh web 可能为多个项目开过会话，
      // 跨项目会话混进来会既占列表又会因 cwd 不匹配导致 resume 失败）
      const workspace = this.workspacePath().replace(/\\/g, "/").toLowerCase();
      // 基准放宽到**任何打开的域**的 cwd：工作区目录与历史会话目录的写法
      // （大小写/分隔符）可能不一致，只看当前工作区会漏掉它们
      const openCwds: string[] = [];
      for (const scope of this.scopes.values()) {
        const cwd = this.sessions.find((s) => s.id === scope.sessionId)?.cwd?.replace(/\\/g, "/").toLowerCase();
        if (cwd) openCwds.push(cwd);
      }
      const views = visibleSessionRows(value.items ?? [])
        // 本地删过的会话若被当前 dsh 进程打开过，仍会留在服务端内存里被
        // session/list 列出——按持久化的删除集合过滤，保证界面干净
        .filter((item) => !this.deletedSessionIds.has(item.sessionId))
        .filter((item) => {
          if (!item.cwd) return false;
          const cwd = item.cwd.replace(/\\/g, "/").toLowerCase();
          return cwd === workspace || openCwds.includes(cwd);
        })
        .map((item) => this.toSessionView(item));
      // 血缘深度：分支缩进显示在源会话下面（否则「分支继承了源标题」会看成两条重复项）
      const depths = lineageDepths(views);
      this.sessions = views.map((view) => ({ ...view, depth: depths.get(view.id) ?? 0 }));
      this.emitSessionLists();
    } catch (error) {
      this.log(`[sessions] 列表获取失败：${this.describeError(error)}`);
    }
  }

  /** 真正展示给界面的两个列表（所有窗口共享同一份会话列表）。 */
  private emitSessionLists(): void {
    const active: SessionSummaryView[] = [];
    const archived: SessionSummaryView[] = [];
    for (const session of this.sessions) {
      (this.archivedSessionIds.has(session.id) ? archived : active).push(session);
    }
    this.emitAll({ type: "sessions", sessions: active });
    this.emitAll({ type: "archivedSessions", sessions: archived });
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
   * 保护：运行中的会话不能删（服务端还在往里写）；还有窗口正看着的会话不能删
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
    let viewed = false;
    for (const bound of this.viewSessions.values()) {
      if (bound === sessionId) {
        viewed = true;
        break;
      }
    }
    if (viewed) {
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
      // 血缘：分支会话带 parentSessionId（子代理的 origin 已在过滤时排除）
      parentSessionId: item.parentSessionId,
    };
  }

  /**
   * 取回（必要时注册）当前项目在服务端的工作区 id。
   *
   * `workspace/create` 是**幂等**的：同一条 realpath 再来一次就返回原有记录
   * （`resolveByPath`），所以「每次连接解析一次」不会堆出重复工作区。
   *
   * 拿不到（老版本服务器没有这条 RPC、路径不存在、网络失败…）时**返回 undefined
   * 而不是抛错**：会话照旧按 cwd 建得出来，只是那一条在 Web 端仍落在未分组里——
   * 让「新建会话」整体失败是更糟的结果。失败原因进日志。
   */
  private async ensureWorkspace(): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId;
    if (!this.client) return undefined;
    // 没有打开文件夹时不注册：那种情况下 `workspacePath()` 是扩展宿主的 cwd，
    // 把 VS Code 自己所在目录注册成一个工作区不是用户的意思（会话照旧按 cwd 建）
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const path = folder.uri.fsPath;
    try {
      const value = await this.client.createWorkspace(path);
      const id = value?.workspace?.workspaceId;
      if (typeof id === "string" && id) {
        this.workspaceId = id;
        this.log(`[workspace] 工作区已注册：${path} → ${id}`);
        return id;
      }
      this.log(`[workspace] 注册返回里没有 workspaceId：${JSON.stringify(value)}`);
      return undefined;
    } catch (error) {
      this.log(`[workspace] 注册失败（本次回退到按 cwd 建会话）：${this.describeError(error)}`);
      return undefined;
    }
  }

  /**
   * 新建一个会话。指定窗口时把**那个窗口**绑上去（其他窗口保持各自会话，
   * 互不同步）；不指定窗口（命令面板入口且无活动窗口）时只建会话，不挂域。
   */
  async newSession(viewId?: string): Promise<void> {
    if (!this.client || this.connection !== "connected") {
      await this.ensureConnected();
    }
    if (!this.client) return;
    try {
      const workspaceId = await this.ensureWorkspace();
      const created = await this.createSessionInWorkspace(workspaceId);
      // 域是「窗口打开会话」的产物：没有窗口要绑（命令面板且无活动窗口）就不建域，
      // 会话只进列表，等某个窗口打开它时再开 follow 流
      const scope = viewId ? this.ensureScope(created.sessionId) : undefined;
      await this.refreshSessions();
      if (scope && viewId) {
        this.bindViewToSession(viewId, created.sessionId, scope);
        // 推**完整状态快照**而不是增量 patch：新会话的域天然是空的，快照把
        // 消息/队列/目标/计划模式/投影一次归零——旧 patch 没覆盖 model/goal/
        // jobs/planMode/permission，上一会话的残留会漏进新窗口
        this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
      }
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to create a session"), error);
    }
  }

  /**
   * 按工作区建会话；工作区 id 失效（注册表被重置 / 换了 DSH home）时清掉缓存、
   * 退化成按 cwd 建——**一次重试**，不再递归（见 `ensureWorkspace`）。
   */
  private async createSessionInWorkspace(
    workspaceId: string | undefined,
  ): Promise<{ sessionId: string; agentPreset?: string }> {
    if (!this.client) throw new Error("no client");
    if (!workspaceId) return this.client.createSession({ cwd: this.workspacePath() });
    try {
      return await this.client.createSession({ workspaceId });
    } catch (error) {
      this.workspaceId = undefined;
      this.log(`[workspace] 按工作区建会话失败，回退 cwd：${this.describeError(error)}`);
      return this.client.createSession({ cwd: this.workspacePath() });
    }
  }

  /** 把指定窗口切到给定会话（域不存在则创建；其他窗口不受影响）。 */
  async openSession(viewId: string, sessionId: string): Promise<void> {
    // 已经在这个会话上（历史抽屉里点了当前选中的那条）：什么都不做，
    // 避免重绑把粘性显示值清掉后等不到回填
    if (this.viewSessions.get(viewId) === sessionId) return;
    if (!this.client || this.connection !== "connected") await this.ensureConnected();
    if (!this.client) return;
    const scope = this.ensureScope(sessionId);
    if (!scope) return;
    this.bindViewToSession(viewId, sessionId, scope);
    // 给这个窗口推**完整状态快照**（不是增量 patch）：域可能早已存在（别的窗口
    // 先打开过它），它的历史重放只发生在 follow 流开窗那一刻，这个窗口当时没绑上、
    // 收不到——不补快照，它的内容就永远是空的。域是刚建的时快照近似为空，
    // follow 流开帧随后回填，两条路径行为一致。
    this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
  }

  /**
   * 取（或创建）给定会话的域：建视图模型、开 follow 流、重开控制流拿该会话
   * 的 baseline、预取命令目录、回放挂起的审批/提问事件。
   */
  private ensureScope(sessionId: string): SessionScope | undefined {
    const existing = this.scopes.get(sessionId);
    if (existing) return existing;
    if (!this.client) return undefined;
    const scope = new SessionScope(sessionId);
    this.scopes.set(sessionId, scope);
    this.openScopeFollow(scope);
    // 重开控制流拿新会话的 baseline（队列/任务/投影）：baseline 是全量集合，
    // 多取一次是幂等的
    this.openControlStream();
    // 命令目录随会话预取：手打的 `/xxx` 要靠它才能被路由到命令通道，
    // 不能等输入 `/` 弹出候选时才拉（粘贴一行后立刻回车就赶不上了）
    void this.listCommandsFor(scope);
    // 回放该会话窗口关闭期间挂起的审批/提问（会话再次被打开，请求不该丢）
    for (const [eventId, held] of [...this.heldEvents]) {
      if (held.sessionId !== sessionId) continue;
      this.heldEvents.delete(eventId);
      this.deliverEventToScope(eventId, held, scope);
    }
    // 新建的域没有 `modelSelection` 投影（首次对话前），给它填部署默认模型；
    // 服务端真给了投影时，baseline 到达会覆盖这里的默认值
    this.ensureDefaultModelApplied();
    return scope;
  }

  /**
   * 确保部署默认模型已读取并填进仍缺选择的域。
   * 连接路径与建域路径都要调：`loadModels` 只在连接时跑一次，其后新建的域
   * 不会再被 `applyDefaultModelToScopes` 覆盖。
   */
  private ensureDefaultModelApplied(): void {
    if (this.defaultModel) {
      this.applyDefaultModelToScopes();
      return;
    }
    void this.loadDefaultModel();
  }

  /** 给域开（或 socket 重连后重开）`session/follow` 流；适配器整个重建。 */
  private openScopeFollow(scope: SessionScope): void {
    const sessionId = scope.sessionId;
    if (!this.client) return;
    scope.followHandle?.cancel();
    const adapter = new SessionAdapter((frame) => this.deliver(sessionId, frame));
    // 图片句柄 → 字节：`read_image` 的 image 块只给不透明 attachmentId，
    // 要经 `session/attachment` 换成 base64 才能显示。适配器不持有网络客户端，
    // 所以在这里注入。
    adapter.loadImages = (refs, done) => {
      void this.loadAttachmentImages(sessionId, refs, done);
    };
    // 文件芯片种类（[新增] / 删除线）的分类回调：适配器交路径，宿主查 git 与磁盘。
    // 带上会话 cwd：芯片路径可能是相对会话工作目录的拼写，解析不了会误判 deleted
    adapter.classifyFiles = (paths) => this.classifyFiles(this.cwdOf(scope), paths);
    // 轮次结束时先推一次 Git 重扫：否则刚写完的文件还没进改动清单，用户第一次
    // 点芯片看到的是完整文件而不是 diff（见 refreshGitState 的注释）
    adapter.refreshFiles = () => this.refreshGitState();
    adapter.setSession(
      this.sessions.find((s) => s.id === sessionId) ?? {
        id: sessionId,
        title: "",
        updatedAt: Date.now(),
        running: false,
      },
    );
    scope.adapter = adapter;
    scope.followHandle = this.client.followSession(sessionId, {
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
            this.applyProjection(scope, key, projectionValue);
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
   *
   * `historyLoading` 由**宿主**发：界面据此把「加载更早」按钮变成不可点的
   * 「正在加载更早消息…」，也据它判断一页是否落定。发帧顺序必须是
   * `true` →（prependRecords 的 hasMoreHistory / messages/reset）→ `false`：
   * 界面先拿到内容，再看到「取完了」。
   *
   * **连取由宿主驱动**（界面只发一次请求）：一次触发要「至少取到用户的上一条消息」，
   * 而判断「到没到一轮的开头」「这一页到底有没有带来新事件」都只有宿主有真凭据
   * （适配器的消息流与新并入的事件数）。放在界面侧拿「首条消息 id 变没变」猜，
   * 会在「旧事件只是把第一条助手消息补长」时误判成没进展而提前收手
   * （用户 2026-09-15 报的「并没有加载到上一条消息就已经停了」，现场见
   * `scripts/pageLoopProbe.ts`）。
   */
  private async loadMore(viewId: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!this.client || !scope || !scope.adapter) return;
    if (scope.running) {
      // 分页与流式叠加层互斥：重折历史会让当前这段流式正文重来一次
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@historyBusy" });
      return;
    }
    // 一次只跑一条链：滚动事件会在「historyLoading 帧回到界面」之前连发好几个
    if (scope.historyLoading) return;
    scope.historyLoading = true;
    this.deliver(scope.sessionId, { type: "patch", patch: { historyLoading: true } });
    try {
      await this.pageBackwards(scope);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to load earlier history"), error);
    } finally {
      scope.historyLoading = false;
      this.deliver(scope.sessionId, { type: "patch", patch: { historyLoading: false } });
    }
  }

  /**
   * 一页一页往前取，直到**取到用户的上一条消息**（一轮的开头）或没有更早的了。
   *
   * 每页都会单独发一份 `messages/reset`：界面逐页把视口钉回原处（见 App 的
   * `useHistoryPaging`），所以用户看到的是「内容在上面长出来、自己没被推走」。
   */
  private async pageBackwards(scope: SessionScope): Promise<void> {
    let pages = 0;
    for (;;) {
      // 生成开始了就停：分页与流式叠加层互斥
      if (scope.running) {
        this.log(`[history] 取到第 ${pages + 1} 页前发现新一轮已开始，停下`);
        return;
      }
      const throughSeq = scope.adapter?.cursor();
      const beforeSeq = scope.adapter?.earliestSeq();
      if (!scope.adapter || throughSeq === undefined || beforeSeq === undefined) {
        this.log("[history] 拿不到分页锚点（缺 snapshot.cursor 或本地无事件）");
        this.deliver(scope.sessionId, { type: "patch", patch: { hasMoreHistory: false } });
        return;
      }
      const page = await this.client!.page(scope.sessionId, throughSeq, beforeSeq);
      const added = scope.adapter.prependRecords(
        (page.records ?? []) as never[],
        Boolean(page.hasMore),
      );
      pages += 1;
      if (shouldContinuePaging(added, Boolean(page.hasMore), scope.adapter.snapshotMessages())) {
        continue;
      }
      this.log(
        `[history] 取到第 ${pages} 页停：新并入 ${added} 条事件、hasMore=${Boolean(page.hasMore)}、` +
          `顶部=${scope.adapter.snapshotMessages()[0]?.role ?? "（空）"}`,
      );
      return;
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
  private async branchFrom(viewId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    const scope = this.scopeOfView(viewId);
    const source = scope?.sessionId;
    if (!source) return;
    const atSeq = scope?.adapter?.forkAnchorFor(messageId);
    if (atSeq === undefined) {
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@branchNoAnchor" });
      return;
    }
    try {
      const value = await this.client.request<{ sessionId?: string }>("session/fork", {
        request: { sessionId: source, atSeq },
      });
      const childId = value?.sessionId;
      if (!childId) {
        this.emitToView(viewId, { type: "toast", level: "error", text: "@branchFailed" });
        return;
      }
      await this.refreshSessions();
      // 分支结果落在点击的那个窗口：它切到新会话，其他窗口保持不动
      await this.openSession(viewId, childId);
      const title = this.sessions.find((session) => session.id === childId)?.title ?? childId;
      this.emitToView(viewId, { type: "toast", level: "info", text: `@branchCreated:${title}` });
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
   *
   * 模型选择是**会话**级的：每个域各自缓存自己的投影与当前模型，互不覆盖。
   */
  private applyModelSelection(scope: SessionScope, selection: unknown): void {
    scope.lastModelSelection = selection;
    const value = selection as
      | {
          lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null;
          next?: { provider?: string; model?: string; reasoningEffort?: string } | null;
        }
      | null
      | undefined;
    const used = value?.next ?? value?.lastUsed;
    if (!used?.provider || !used.model) {
      // 新会话还没有选择：若部署默认已就绪直接套用，否则异步读设置
      if (this.defaultModel) {
        scope.model = this.defaultModel;
        this.deliver(scope.sessionId, { type: "patch", patch: { model: scope.model } });
      } else {
        void this.loadDefaultModel();
      }
      return;
    }
    const group = this.models.find((g) => g.id === used.provider);
    const model = group?.models.find((m) => m.id === used.model);

    scope.model = {
      provider: used.provider,
      model: used.model,
      label: model?.name ?? used.model,
      reasoningEffort: used.reasoningEffort || undefined,
      efforts: model?.efforts,
      contextWindow: model?.contextWindow ?? scope.model?.contextWindow,
      acceptsImage: this.acceptsImageFor(used.provider, used.model),
    };
    this.deliver(scope.sessionId, { type: "patch", patch: { model: scope.model } });
  }

  private teardownStreams(): void {
    // 每个域的 follow 流单独取消（域本身保留，重连时由 onConnected 重开）
    for (const scope of this.scopes.values()) {
      scope.followHandle?.cancel();
      scope.followHandle = undefined;
    }
    this.controlHandle?.cancel();
    this.eventsHandle?.cancel();
    this.workspaceHandle?.cancel();
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
      // baseline 是**全量**集合（按会话分键）：逐个套用到已打开的域上。
      // 没打开的会话不建域——它们的状态等窗口打开时由新 snapshot/baseline 重建。
      for (const [sessionId, projections] of Object.entries(value.projections ?? {})) {
        const scope = this.scopes.get(sessionId);
        if (!scope) continue;
        for (const [key, projectionValue] of Object.entries((projections as { values?: Record<string, unknown> })?.values ?? {})) {
          this.applyProjection(scope, key, projectionValue);
        }
      }
      for (const [sessionId, queue] of Object.entries(value.queues ?? {})) {
        const scope = this.scopes.get(sessionId);
        if (scope) this.syncQueue(scope, queue);
      }
      for (const [sessionId, jobs] of Object.entries(value.jobs ?? {})) {
        const scope = this.scopes.get(sessionId);
        if (scope) this.applyJobs(scope, jobs);
      }
      return;
    }

    const scope = frame.sessionId ? this.scopes.get(frame.sessionId) : undefined;
    if (!scope) return;

    if (frame.type === "queue") {
      this.syncQueue(scope, frame.items);
      return;
    }

    if (frame.type === "jobs") {
      this.applyJobs(scope, frame.jobs);
      return;
    }

    if (frame.type === "projection") {
      this.applyProjection(scope, String(frame.key ?? ""), frame.value);
    }
  }

  /**
   * 队列帧进来到界面状态：同时重建「队列项 id → 原始输入 / 可重发内容」的索引，
   * 供「重新编辑」与「ESC 中止并把队首发出去」使用。
   */
  private syncQueue(scope: SessionScope, items: unknown[] | undefined): void {
    const entries = queueItems(items, (rpcId) => this.originFor(rpcId));
    scope.queueOrigin.clear();
    for (const entry of entries) {
      scope.queueOrigin.set(entry.view.id, {
        text: entry.view.text,
        attachments: this.originFor(entry.view.rpcId)?.attachments ?? [],
        content: entry.content,
      });
    }
    scope.queueItems = entries.map((entry) => entry.view);
    this.deliver(scope.sessionId, { type: "patch", patch: { queueItems: scope.queueItems } });
  }

  /** 单个投影值 → 界面状态。未知 key 直接忽略（插件没加载 = 能力缺失，不是错误）。 */
  private applyProjection(scope: SessionScope, key: string, value: unknown): void {
    switch (key) {
      case "modelSelection":
        this.applyModelSelection(scope, value);
        break;

      case "permissions": {
        // {options:[{value,name}], currentValue}：用它初始化权限胶囊
        const current = (value as { currentValue?: string } | null)?.currentValue;
        if (typeof current === "string" && current) {
          scope.permission = current;
          this.deliver(scope.sessionId, { type: "patch", patch: { permission: current } });
        }
        break;
      }

      case "plan": {
        // 生效状态是 `pending ? !active : active`，不是裸 `active`：轮次进行中发出的
        // `/plan` 只会把选择挂起（`active` 仍为 false），只读 active 会让「进入计划
        // 模式」看起来没反应。见 projections.planModeFromProjection。
        const active = planModeFromProjection(value);
        scope.planMode = active;
        this.deliver(scope.sessionId, { type: "patch", patch: { planMode: active } });
        break;
      }

      case "todos": {
        const items = Array.isArray(value) ? value : [];
        scope.todos = items.map((todo, index) => {
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
        this.deliver(scope.sessionId, { type: "todos", todos: scope.todos });
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
        scope.adapter?.applyContextPressure({ pressureTokens, projectedTokens, contextWindow });
        if (contextWindow !== undefined && contextWindow > 0 && scope.model) {
          scope.model = { ...scope.model, contextWindow };
          this.deliver(scope.sessionId, { type: "patch", patch: { model: scope.model } });
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
        scope.tokenUsage = {
          uncachedInputTokens: numberOr(usage.uncachedInputTokens, 0),
          outputTokens: numberOr(usage.outputTokens, 0),
          cacheReadTokens: numberOr(usage.cacheReadTokens, 0),
          cacheWriteTokens: numberOr(usage.cacheWriteTokens, 0),
        };
        this.deliver(scope.sessionId, { type: "patch", patch: { tokenUsage: scope.tokenUsage } });
        break;
      }

      case "turnOutline": {
        // 轮次导航：每轮的序号、起始 seq 与一句话摘要。界面用它做「跳到某一轮」。
        const rounds = Array.isArray(value) ? value : [];
        scope.turnOutline = rounds.map((round) => {
          const item = round as { turn?: unknown; seq?: unknown; summary?: unknown; startedAt?: unknown };
          return {
            turn: numberOr(item.turn, 0),
            seq: numberOr(item.seq, 0),
            summary: typeof item.summary === "string" ? item.summary : "",
            startedAt: numberOr(item.startedAt, 0),
          };
        });
        this.deliver(scope.sessionId, { type: "patch", patch: { turnOutline: scope.turnOutline } });
        break;
      }

      case "imageLimits": {
        // 图片准入上限：发送前就能拦住超限的图，而不是等服务端拒绝
        const limits = (value ?? {}) as {
          maxImagesPerMessage?: unknown;
          maxImageBytes?: unknown;
          maxMessageImageBytes?: unknown;
        };
        scope.imageLimits = {
          maxImagesPerMessage: numberOr(limits.maxImagesPerMessage, 0) || undefined,
          maxImageBytes: numberOr(limits.maxImageBytes, 0) || undefined,
          maxMessageImageBytes: numberOr(limits.maxMessageImageBytes, 0) || undefined,
        };
        break;
      }

      case "title": {
        if (typeof value === "string" && value) {
          const existing = this.sessions.find((s) => s.id === scope.sessionId);
          const session: SessionSummaryView = existing
            ? { ...existing, title: value }
            : {
                id: scope.sessionId,
                title: value,
                updatedAt: Date.now(),
                running: false,
              };
          if (existing) existing.title = value;
          scope.adapter?.setSession(session);
          this.deliver(scope.sessionId, { type: "patch", patch: { session } });
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
          scope.contextBreakdown = {
            systemTokens: bd.systemTokens,
            toolsTokens: bd.toolsTokens,
            messageTokens: bd.messageTokens,
          };
          this.deliver(scope.sessionId, { type: "patch", patch: { contextBreakdown: scope.contextBreakdown } });
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
          scope.sessionStats = {
            turns: st.turns ?? 0,
            steps: st.steps ?? 0,
            llmMs: st.llmMs,
            toolMs: st.toolMs,
            ttftMs: st.ttftMs ?? 0,
            ttftSteps: st.ttftSteps ?? 0,
            decodeMs: st.decodeMs ?? 0,
            decodeTokens: st.decodeTokens ?? 0,
          };
          this.deliver(scope.sessionId, { type: "patch", patch: { sessionStats: scope.sessionStats } });
        }
        break;
      }

      case "subagentCatalog": {
        // 投影里已经带着子代理目录，界面无需再单独请求一次。
        // 形状解析见 projections.ts（投影**没有** kind/activity，与 RPC 行不同）。
        scope.subagents = subagentsFromCatalog(value, scope.subagents);
        this.deliver(scope.sessionId, {
          type: "subagents/list",
          entries: scope.subagents,
          parentAvailable: scope.subagents.length > 0,
        });
        break;
      }

      case "goal": {
        // 投影是**嵌套**的，轮次计数在外层（见 projections.goalFromProjection）。
        // 以前按扁平的 `{objective, phase, rounds, maxRounds}` 读，两个字段都取不到，
        // 于是 goal 恒被清空、目标条从未渲染（docs/audit-summary.md §3）。
        scope.goal = goalFromProjection(value);
        this.deliver(scope.sessionId, { type: "patch", patch: { goal: scope.goal } });
        break;
      }

      default:
        break;
    }
  }

  /** 后台任务帧 → 界面状态。 */
  private applyJobs(scope: SessionScope, jobs: unknown): void {
    const list = Array.isArray(jobs) ? jobs : [];
    scope.jobs = list.map((job) => {
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
    this.deliver(scope.sessionId, { type: "jobs/list", jobs: scope.jobs });
    this.deliver(scope.sessionId, { type: "patch", patch: { jobs: scope.jobs } });
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
   *
   * 这条流上还有**转发的 emit 帧**（网关 `broadcastRemoteEvent` 的
   * `{type:'emit', event, args}`）：配置文件热重载的后果就藏在里面
   * （`settings/document-updated` 等，白名单见 `dsh-api-remotes`）。emit 帧
   * **不需要回复**，交给 `ConfigChangeRouter` 决定重读什么。
   */
  private async onEventFrame(frame: RemoteEventFrame): Promise<void> {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "ready") {
      this.eventsClientId = frame.clientId;
      return;
    }
    if (frame.type === "emit") {
      this.configChanges.handle(frame.event, frame.args ?? []);
      return;
    }
    if (frame.type !== "waterfall") return;
    const waterfall = frame as RemoteEventWaterfall;
    if (this.handledEvents.has(waterfall.eventId)) {
      // 重投递：直接放行给链上的下一个处理器，避免重复弹卡片
      await this.replyEvent(waterfall.eventId, { kind: "next" });
      return;
    }

    if (waterfall.event === "approval/request" || waterfall.event === "user-questions/request") {
      // `agentId` 就是发起请求的会话 id：多会话并存时按它路由到对应域
      const sessionId = waterfall.agentId;
      if (!sessionId) {
        // 没有会话标识就不知道该把卡片放进哪个域：放行（拦着只会永久挂住 agent）
        await this.replyEvent(waterfall.eventId, { kind: "next" });
        return;
      }
      const scope = this.scopes.get(sessionId);
      const held = {
        kind: waterfall.event === "approval/request" ? ("approval" as const) : ("question" as const),
        sessionId,
        request: waterfall.request,
      };
      this.handledEvents.add(waterfall.eventId);
      this.eventSessions.set(waterfall.eventId, sessionId);
      if (scope) {
        this.deliverEventToScope(waterfall.eventId, held, scope);
      } else {
        // 该会话的窗口关着：挂起（**不能回**——回了等于放行，请求就丢了），
        // 会话再次被打开（域创建）时回放
        this.heldEvents.set(waterfall.eventId, held);
      }
      return;
    }

    // 不认识的事件：放行，不能拦着
    await this.replyEvent(waterfall.eventId, { kind: "next" });
  }

  /** 把一条审批/提问事件交给域的适配器（即时到达与挂起回放共用）。 */
  private deliverEventToScope(
    eventId: string,
    held: { kind: "approval" | "question"; sessionId: string; request: unknown },
    scope: SessionScope,
  ): void {
    if (held.kind === "approval") {
      const request = held.request as { toolName?: string; callId?: string; reason?: string };
      scope.adapter?.addApproval({
        requestId: eventId,
        // 工具名缺失时给标记而不是中文：审批卡按用户选的界面语言渲染
        toolName: request.toolName ?? "@toolGeneric",
        reason: request.reason,
        detail: request.callId ? `@callId:${request.callId}` : undefined,
        state: "waiting",
      });
      return;
    }
    const request = held.request as { questions?: QuestionView["items"] };
    scope.adapter?.addQuestion({
      requestId: eventId,
      items: (request.questions ?? []).map((item) => ({
        id: item.id,
        header: item.header,
        question: item.question,
        options: item.options ?? [],
        multiSelect: item.multiSelect,
      })),
      state: "waiting",
    });
  }

  private async replyEvent(eventId: string, outcome: unknown): Promise<void> {
    if (!this.client || !this.eventsClientId) return;
    try {
      await this.client.answerEvent(this.eventsClientId, eventId, outcome as never);
    } catch (error) {
      this.log(`[$events] 回复失败：${this.describeError(error)}`);
    }
  }

  // ---------- 配置文件热重载的重读动作（由 ConfigChangeRouter 调用） ----------

  /**
   * 用户设置层被外部改动（`settings/document-updated`：`~/.dsh/settings.yaml`
   * 被手改或被另一个 dsh 界面写；`credentials/reference-updated`：
   * `~/.dsh/.credentials.yaml` 改了）。
   *
   * 三样东西都从设置命名空间派生，官方前端同样是「失效就重读」：
   * 设置面板（含 `busyEnter`）、图片输入能力、部署默认模型。
   */
  private async reloadSettings(): Promise<void> {
    // 部署默认模型是**有缓存**的（`agent-default-model` 设置）：不清掉就永远读不到新值
    this.defaultModel = undefined;
    await this.describeSettings();
    await this.refreshImageCaps();
    // 模型目录还没到（首连的那一小段窗口）时不读默认模型：标签会退化成裸 id
    // 并被缓存住；那次连接流程自己会在 loadModels 之后读一遍。
    if (this.models.length > 0) await this.loadDefaultModel();
  }

  /**
   * 命令 / 技能目录重取（`commands/change`：插件行增删让命令注册表变了；
   * `agent-preset/selected`：预设换了，该会话能用的命令与技能都不一样）。
   *
   * 缺省重取**所有打开的域**——命令注册表是全局的；给 `sessionId` 时只重取那一个。
   * 技能顺带一起重取（`listCommandsFor` 里合并了 `skills/list`）：宿主侧
   * `skills/change` **不在**转发白名单里，所以技能目录没有专属帧，只能借这些
   * 时机刷新——官方 `ui-skill` 也只在 `agent-preset/selected` 时作废缓存。
   */
  private async reloadCommandCatalogs(sessionId?: string): Promise<void> {
    const scopes =
      sessionId === undefined
        ? [...this.scopes.values()]
        : [this.scopes.get(sessionId)].filter((scope): scope is SessionScope => scope !== undefined);
    await Promise.all(scopes.map((scope) => this.listCommandsFor(scope)));
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
      // 各打开域的当前模型同步刷新后推给界面（切换模型前目录/设置可能已更新）
      for (const scope of this.scopes.values()) {
        if (!scope.model) continue;
        scope.model = { ...scope.model, acceptsImage: this.acceptsImageFor(scope.model.provider, scope.model.model) };
        this.deliver(scope.sessionId, { type: "patch", patch: { model: scope.model } });
      }
      if (this.defaultModel) {
        this.defaultModel = {
          ...this.defaultModel,
          acceptsImage: this.acceptsImageFor(this.defaultModel.provider, this.defaultModel.model),
        };
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
      // 模型目录是全局共享的；「当前模型」是会话级状态，各域各自推给绑定它的窗口
      this.emitAll({ type: "models", groups: this.models });
      // 图片能力来自设置命名空间，在选定默认/当前模型前刷新
      await this.refreshImageCaps();
      // 投影可能先于模型目录到达（WS 一开就推 baseline），那时只能显示模型 id；
      // 目录就绪后用原始投影重放一次，把 id 换成人类可读的名字。
      // 没有选择的域（全新会话）退回部署默认模型。
      let replayed = false;
      for (const scope of this.scopes.values()) {
        if (scope.lastModelSelection) {
          this.applyModelSelection(scope, scope.lastModelSelection);
          replayed = true;
        }
      }
      if (!replayed) await this.loadDefaultModel();
    } catch (error) {
      this.log(`[models] 目录获取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 新会话在首次对话前没有 modelSelection，但 agent 仍会用部署默认值。
   * 从 `agent-default-model` 设置命名空间读出来，开场就显示真实模型。
   * 结果缓存到 `defaultModel`（部署级配置，全局一份），再填给还没有选择的各域。
   */
  private async loadDefaultModel(): Promise<void> {
    if (!this.client) return;
    if (this.defaultModel) {
      this.applyDefaultModelToScopes();
      return;
    }
    try {
      const described = await this.client.settingsDescribe();
      const section = described.namespaces?.find((item) => item.ns === "agent-default-model");
      const value = section?.value as { provider?: string; model?: string; reasoningEffort?: string } | undefined;
      if (!value?.provider || !value.model) return;
      const group = this.models.find((g) => g.id === value.provider);
      const model = group?.models.find((m) => m.id === value.model);
      this.defaultModel = {
        provider: value.provider,
        model: value.model,
        label: model?.name ?? value.model,
        reasoningEffort: value.reasoningEffort,
        efforts: model?.efforts,
        contextWindow: model?.contextWindow,
        acceptsImage: this.acceptsImageFor(value.provider, value.model),
      };
      this.applyDefaultModelToScopes();
    } catch (error) {
      this.log(`[models] 默认模型读取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 把部署默认**填进或刷新到**「没有自己选择」的各域。
   *
   * 判据是「投影里有没有 `next`/`lastUsed`」，不是「域上有没有 model」：
   * 新会话的投影是 `{lastUsed:null,next:null}`（**不是** undefined），
   * 胶囊此时显示的就是部署默认——按旧判据（`scope.model || lastModelSelection`
   * 就跳过）它永远不会被刷新，于是改 `settings.yaml` 里的档位后，
   * 新会话的档位列表停在旧目录上（用户 2026-09-12 报的现场之一）。
   *
   * 有未提交的界面选择（`pendingModel`）时不动它——那是用户刚点下、
   * 下次发送才落库的值，覆盖掉会让胶囊自己跳回去。
   */
  private applyDefaultModelToScopes(): void {
    if (!this.defaultModel) return;
    for (const scope of this.scopes.values()) {
      if (scope.pendingModel) continue;
      const shown = scope.lastModelSelection as
        | { lastUsed?: { provider?: string } | null; next?: { provider?: string } | null }
        | null
        | undefined;
      const used = shown?.next ?? shown?.lastUsed;
      if (used?.provider) continue; // 该域有自己的选择，默认值管不着它
      scope.model = this.defaultModel;
      this.deliver(scope.sessionId, { type: "patch", patch: { model: scope.model } });
    }
  }

  // ---------- webview 指令 ----------

  /**
   * 一条窗口 → 宿主的指令。`viewId` 标识**发出这条指令的窗口**：会话级动作
   * （发送、停止、切会话……）都落在它绑定的那个会话域上，别的窗口不受影响。
   */
  async handle(message: WebviewToHost, viewId: string): Promise<void> {
    switch (message.type) {
      case "ready":
        // 页面就绪前不推帧（webview 的监听还没挂上，推了也白推），所以工作区
        // 打开时「这个窗口上次开着哪个会话」的接回动作放在这里：绑定完再发
        // 快照，会话内容直接出现在它的首帧里
        await this.resumeRestoreHint(viewId);
        // 每个窗口拿的是**自己**的快照（它绑定的会话；未绑定 = 空态）
        this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
        break;

      case "send":
        // 未连接时先恢复连接：历史会话切换后跟随流尚未建立时直接 prompt
        // 会触发服务端 resume，冷启动竞态下 resume 可能失败
        if (!this.client || this.connection !== "connected") await this.ensureConnected();
        await this.send(viewId, message.text, message.attachments);
        break;

      case "stop":
        await this.stopRunning(viewId);
        break;

      case "queueRemove": {
        const scope = this.scopeOfView(viewId);
        // 移除后服务端会重发队列帧，界面以帧为准；这里只做请求与兜底报错
        if (this.client && scope && message.id) {
          this.client.updateQueueRemove(scope.sessionId, message.id).catch((error) => {
            this.reportError(vscode.l10n.t("Failed to cancel the queued message"), error);
          });
        }
        break;
      }

      case "queueEdit":
        await this.editQueuedMessage(viewId, message.id);
        break;

      case "newSession":
        await this.newSession(viewId);
        break;

      case "openSession":
        await this.openSession(viewId, message.sessionId);
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

      case "setModel": {
        // 延迟到下一次发送时生效（与 UI 进入计划模式同机制）：
        // 避免正在生成时切模型导致本轮中途换模型，也让界面立刻反映选择
        let scope = this.scopeOfView(viewId);
        if (!scope) {
          // 窗口还是空态：先建会话，选择才有地方挂
          if (this.client || this.connection === "connected") {
            await this.newSession(viewId);
            scope = this.scopeOfView(viewId);
          }
        }
        if (!scope) break;
        const group = this.models.find((g) => g.id === message.provider);
        const model = group?.models.find((m) => m.id === message.model);
        scope.pendingModel = {
          provider: message.provider,
          model: message.model,
          reasoningEffort: message.reasoningEffort,
          label: model?.name ?? message.model,
          efforts: model?.efforts,
          contextWindow: model?.contextWindow ?? scope.model?.contextWindow,
          acceptsImage: this.acceptsImageFor(message.provider, message.model),
        };
        // 立即更新胶囊显示（实际 selectModel 在下次发送前执行）
        scope.model = {
          provider: scope.pendingModel.provider,
          model: scope.pendingModel.model,
          label: scope.pendingModel.label ?? scope.pendingModel.model,
          reasoningEffort: scope.pendingModel.reasoningEffort,
          efforts: scope.pendingModel.efforts,
          contextWindow: scope.pendingModel.contextWindow,
          acceptsImage: scope.pendingModel.acceptsImage,
        };
        this.deliver(scope.sessionId, { type: "patch", patch: { model: scope.model } });
        break;
      }

      case "setPermission":
        await this.runCommand(viewId, `/permission ${message.permission}`);
        break;

      case "runCommand": {
        // 界面上的按钮化命令（权限预设、进入/退出计划模式）。成功与失败都靠
        // command/run ↔ command/done 折出的节点呈现，这里只补「命令不存在」这种
        // 压根没进处理器、因而没有节点可显示的情形。
        const outcome = await this.runCommand(viewId, message.line);
        if (outcome && !outcome.ok) {
          this.emitToView(viewId, {
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
        const sessionId = this.eventSessions.get(eventId);
        const scope = sessionId ? this.scopes.get(sessionId) : undefined;
        scope?.adapter?.resolveApproval(eventId, message.approved ? "approved" : "rejected");
        break;
      }

      case "answerQuestion": {
        const eventId = message.requestId;
        if (!eventId) break;
        await this.replyEvent(eventId, {
          kind: "result",
          value: { answers: message.answers },
        });
        const sessionId = this.eventSessions.get(eventId);
        const scope = sessionId ? this.scopes.get(sessionId) : undefined;
        scope?.adapter?.resolveQuestion(eventId);
        break;
      }

      case "addFiles":
        await this.pickFiles(viewId);
        break;

      case "attachBytes":
        // 拖放进来的文件（只有字节和名字，见 shared/ipc.ts 的 attachBytes）
        await this.applyBytesForView(viewId, message.files, message.unreadable, message.tooLarge);
        break;

      case "addMention": {
        // `@` 选中一律是**引用芯片**，不上传、不读内容（官方 dsh-client-ui-reference：
        // @ 只发 `@path` / `@dir/` token，模型自己用 read 工具读；逐字节上传只归
        // 附件按钮 / 拖拽入口）。目录靠结尾斜杠标记（`@dir/`）。
        this.addReference(viewId, message.path, message.kind);
        break;
      }

      case "addFolderReference":
        // 用户明确要求「整个目录作为引用」（`@` 列表右侧的按钮）
        this.addReference(viewId, message.path, "directory");
        break;

      case "retryUpload":
        this.retryUpload(viewId, message.id);
        break;

      case "runCommandLine":
        // 命令面板里点的一条命令（不是手打的正文）
        await this.runCommand(viewId, message.line);
        break;

      case "branchFrom":
        await this.branchFrom(viewId, message.messageId);
        break;

      case "loadMore":
        await this.loadMore(viewId);
        break;

      case "removeAttachment":
        this.removeAttachment(viewId, message.id);
        break;

      case "setDraft":
        this.drafts.set(this.keyForView(viewId), message.text);
        break;

      case "openFile": {
        const scope = this.scopeOfView(viewId);
        await this.openFile(message.path, message.diff, viewId, scope ? this.cwdOf(scope) : undefined);
        break;
      }

      case "insertText":
        await this.insertIntoEditor(message.text);
        break;

      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        this.emitToView(viewId, { type: "toast", level: "info", text: "@copied" });
        break;

      case "listSubagents":
        await this.refreshSubagents(viewId);
        break;

      case "openSubagent":
        await this.openSubagent(viewId, message.id);
        break;

      case "listJobs": {
        const scope = this.scopeOfView(viewId);
        this.emitToView(viewId, { type: "jobs/list", jobs: scope?.jobs ?? [] });
        break;
      }

      case "listCommands":
        await this.listCommandsForView(viewId);
        break;

      case "queryFiles":
        await this.queryFiles(viewId, message.query);
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

      case "openInEditor": {
        // 「在编辑器中打开」：把这个窗口当前的会话带进新编辑器窗口；
        // 未绑会话（空态）就不带，新窗口从空态起
        const sessionForEditor = this.viewSessions.get(viewId);
        this.log(`[openInEditor] 窗口=${viewId} 会话=${sessionForEditor ?? "（空态）"}`);
        await vscode.commands.executeCommand("dshChat.openInEditor", sessionForEditor);
        break;
      }

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

  /** 命令面板入口「DSH: 停止」：停最近活动窗口的会话轮。 */
  async stopActive(): Promise<void> {
    const viewId = this.activeViewId();
    if (viewId) await this.stopRunning(viewId);
  }

  private async send(viewId: string, text: string, attachments: Attachment[]): Promise<void> {
    if (!this.client) return;
    // 窗口还没有会话（空态）：首条消息就建立它
    let scope = this.scopeOfView(viewId);
    if (!scope) {
      await this.newSession(viewId);
      scope = this.scopeOfView(viewId);
    }
    if (!scope) return;

    // 斜杠命令走命令通道，**不发给模型**：官方客户端的 enter 列把 `/xxx` 交给
    // `commands/execute`，宿主也明确「without sending it to the model」。
    // 以前只有 `/permission` 走命令通道，手打的 `/compact`、`/goal` 等一律当普通
    // 消息发给模型（docs/audit-summary.md §2）。附带附件时仍按普通消息发：
    // 命令若不能带附件，服务端会拒绝，而用户此刻显然是想发这批内容。
    const slash = attachments.length === 0 ? this.slashCommandOf(scope, text) : undefined;
    if (slash) {
      const key = this.keyForView(viewId);
      this.drafts.set(key, "");
      this.deliver(scope.sessionId, { type: "patch", patch: { draft: "" } });
      const outcome = await this.runCommand(viewId, slash.line);
      if (outcome && !outcome.ok) {
        this.emitToView(viewId, {
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
    // 带行号的选区把范围写进正文——用户引的是「这个文件的这几行」，
    // 不说清楚的话模型只能猜代码出处（用户 2026-09-14 明确要求）。
    if (selections.length) {
      content.push({
        type: "text",
        text: selections
          .map((attachment) => {
            const range = attachment.lines
              ? ` 第 ${attachment.lines.start}-${attachment.lines.end} 行`
              : "";
            return `以下是来自 ${attachment.name}${range} 的选中代码：\n\`\`\`\n${attachment.text}\n\`\`\``;
          })
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
      if (scope.pendingModel) {
        const { provider, model, reasoningEffort } = scope.pendingModel;
        scope.pendingModel = undefined;
        try {
          await this.client.selectModel(scope.sessionId, provider, model, reasoningEffort);
        } catch (error) {
          this.log(`[model] 发送前应用模型选择失败：${this.describeError(error)}`);
        }
      }
      const key = this.keyForView(viewId);
      this.attachmentsBySession.set(key, []);
      this.drafts.set(key, "");
      scope.running = true;
      this.deliver(scope.sessionId, { type: "patch", patch: { attachments: [], draft: "", running: true } });
      // requestId 由这里铸造：队列帧会把同一个 id 作为 rpcId 带回来，
      // 「重新编辑」凭它还原成用户当时输入的文本与附件
      const requestId = randomUUID();
      // 队列「重新编辑」要还原用户**原始**输入，所以记的是拼引用之前的正文
      this.rememberSubmission(requestId, text.trim(), content, attachments);
      await this.client.prompt(scope.sessionId, content, this.submitMode(scope), requestId);
      if (notUploaded.length) this.warnUploadIncomplete(viewId, notUploaded);
    } catch (error) {
      scope.running = false;
      this.deliver(scope.sessionId, { type: "patch", patch: { running: false } });
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
   * running 是**会话**级状态（多会话并行跑时互不影响）。
   */
  private submitMode(scope: SessionScope): "queue" | "steer" {
    if (!scope.running) return "queue";
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
  private warnUploadIncomplete(viewId: string, names: string[]): void {
    // `、` 是中文顿号，英文里得用 `, `——所以预览串只做「取前几个 + 省略号」，
    // 分隔符与「等 N 个」都交给词典按语言拼（见 texts.ts 的 uploadIncomplete）。
    const preview = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? "…" : "";
    this.emitToView(viewId, {
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
  private async runCommand(viewId: string, line: string): Promise<{ ok: boolean; text?: string } | undefined> {
    if (!this.client) return undefined;
    // 命令按会话执行：还没有会话时先建一个（点按钮时用户并没有先发过消息）
    let scope = this.scopeOfView(viewId);
    if (!scope) {
      await this.newSession(viewId);
      scope = this.scopeOfView(viewId);
    }
    if (!scope) return undefined;
    const agentId = scope.sessionId;
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
  private slashCommandOf(scope: SessionScope, text: string): { name: string; line: string } | undefined {
    const line = text.trim();
    if (!line.startsWith("/")) return undefined;
    const match = /^\/([^\s/]+)([\s\S]*)$/.exec(line);
    if (!match) return undefined;
    const name = match[1];
    const rest = match[2] ?? "";
    const known = scope.commandCatalog.get(name);
    if (!known) return undefined;
    // 带参数的行只对「声明了自由输入」的命令成立，其余照旧当消息发出去
    if (rest.trim() && !known.hint) return undefined;
    return { name, line };
  }

  /** 记下 0.1.5 起的参数名，回退成功后更新（服务端行为，全局一份）。 */
  private attachmentsParam: "submittedAttachments" | "images" = "submittedAttachments";

  /**
   * 通用「添加文件」：一个入口收下任意**文件**，按内容分派。
   *
   * - 图片 → 图片附件（按内容块发送）；
   * - 其余文件 → **上传**成文件附件（拿 `receiptId`），不再内联正文；
   *   上传按字节发，二进制 / 非 UTF-8 / 过大都不拦；只有读不出来（选择到读取之间被删）/ 模型不收图片 → 带引号的路径
   *   插到输入框光标处（最后兜底）。
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
  private async pickFiles(viewId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: vscode.l10n.t("Add as context"),
    });
    if (!picked?.length) return;
    await this.addPaths(viewId, picked.map((uri) => uri.fsPath));
  }

  /** 添加目录（单独入口：与文件选择器在 Windows 上互斥，见 pickFiles 注释）。 */
  private async pickFolder(viewId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: vscode.l10n.t("Add folder as context"),
    });
    if (!picked?.length) return;
    await this.addPaths(viewId, picked.map((uri) => uri.fsPath));
  }

  /** 把一批路径交给 `applyPathsForView` 分派（图片 / 上传 / 目录引用）。 */
  private async addPaths(viewId: string, paths: string[]): Promise<void> {
    await this.applyPathsForView(viewId, paths.map((path) => ({ path, name: this.attachmentName(path) })));
  }

  /**
   * 把一批路径并入当前会话的输入（附件入口：文件选择器 / 资源管理器右键 /
   * 命令面板「添加文件夹」）。
   *
   * 三条去向，与官方一致：
   * - **图片** → 图片附件（内容块，官方同样内联图片字节）；
   * - **目录** → `@dir/` **引用芯片**（官方靠结尾斜杠标记目录，模型自己决定
   *   要不要 list；目录不是「读不出来的文件」，不走路径文本兜底）；
   * - **其余文件** → 文件附件并**立即上传**（官方 upload-on-pick：选完就开始传，
   *   大文件在按下发送前就能看到进度，发送时只带 `receiptId`；上传路径按字节发，
   *   类型与大小都不挑）。
   *
   * 只有文件读不出来（选择到读取之间被删的竞态）、或模型不收图片，才退回把带
   * 引号的路径插到光标处——那是最后一道兜底，不再假装「已作为上下文加入」。
   *
   * 分工与 `@` 入口不同：`@` 选中的文件/目录一律只生成引用芯片（官方 @ 只发
   * `@path` / `@dir/` token），真正逐字节上传只从这里发生。
   */
  private async applyPathsForView(viewId: string, items: { path: string; name: string; directory?: boolean }[]): Promise<void> {
    // 文件上传需要会话：窗口还是空态时先建（附件按键是常见的第一步动作）
    if (!this.scopeOfView(viewId)) {
      if (this.client || this.connection === "connected") {
        await this.newSession(viewId);
      }
    }
    const key = this.keyForView(viewId);
    const list = this.attachmentsBySession.get(key) ?? [];
    // 图片能力取自该窗口会话的模型；空态（还没会话）按「支持」处理
    const acceptsImage = this.scopeOfView(viewId)?.model?.acceptsImage !== false;
    const pathOnly: string[] = [];
    let unsupportedImages = 0;

    for (const item of items) {
      // 附件按路径去重（同一张图加两次没有意义）；路径型结果不去重——
      // 用户每次明确选择都应该在光标处再插一份
      if (list.some((a) => a.path === item.path)) continue;
      // 目录 → 引用芯片（与 `@` 的「整个目录」同形；官方靠结尾斜杠区分）
      if (item.directory ?? isDirectoryPath(item.path)) {
        list.push({
          id: randomUUID(),
          kind: "reference",
          path: item.path,
          name: `${basename(item.path)}/`,
          referenceKind: "directory",
        });
        continue;
      }
      const outcome = classifyPath({
        ...item,
        // 未拿到模型能力时按「支持」处理，与服务端最终校验一致
        acceptsImage,
        onError: (message) => this.log(`[attach] ${message}`),
      });
      if (outcome.kind === "attachment") {
        if (outcome.attachment.kind === "file" && outcome.attachment.path) {
          // 上传是异步的：先把芯片放进列表（带 uploading 状态），字节到了再更新
          const attachment = outcome.attachment;
          list.push(attachment);
          this.uploadAttachment(viewId, attachment);
          continue;
        }
        list.push(outcome.attachment);
        continue;
      }
      pathOnly.push(item.path);
      if (outcome.reason === "image-unsupported") unsupportedImages++;
    }

    this.attachmentsBySession.set(key, list);
    this.pushAttachmentsForView(viewId, list);
    if (pathOnly.length) {
      this.emitToView(viewId, { type: "ui/insertText", text: formatPathList(pathOnly) });
    }
    if (unsupportedImages > 0) {
      const model = this.scopeOfView(viewId)?.model;
      const label = model?.label ?? model?.model ?? "";
      this.emitToView(viewId, { type: "toast", level: "warn", text: `@imagePathsInserted:${unsupportedImages}:${label}` });
    }
  }

  /**
   * 拖放进来的文件：**只有字节和文件名**（webview 拿不到路径，理由见
   * `shared/ipc.ts` 的 `attachBytes`）。与 `applyPathsForView` 同口径，只是信息更少：
   * - 图片且模型收图 → 图片附件（内容块，与官方内联图片字节一致）；
   * - 其余（含模型不收图的图片）→ 文件附件并**立即上传字节**。上传路径本来就
   *   按字节发、不挑类型，图片当普通文件传也比丢掉强——"模型不收图"时退回
   *   路径文本对拖放根本不可行（没有路径可插）。
   *
   * `unreadable` / `tooLarge` 是这一批里没进来的名字（目录 / 超限），逐个提示，
   * 不静默丢弃——拖了一堆文件却少进来几个，用户必须知道是哪个、为什么。
   */
  private async applyBytesForView(
    viewId: string,
    files: readonly { name: string; base64: string }[],
    unreadable: readonly string[],
    tooLarge: readonly string[],
  ): Promise<void> {
    // 上传需要会话：与 addFiles 一样，空态时先建一个
    if (!this.scopeOfView(viewId)) {
      if (this.client || this.connection === "connected") {
        await this.newSession(viewId);
      }
    }
    const key = this.keyForView(viewId);
    const list = this.attachmentsBySession.get(key) ?? [];
    const acceptsImage = this.scopeOfView(viewId)?.model?.acceptsImage !== false;
    const pending: { attachment: Attachment; bytes: Uint8Array }[] = [];

    for (const file of files) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(file.base64, "base64"));
      } catch (error) {
        this.log(`[attach] 拖放解码失败 ${file.name}：${this.describeError(error)}`);
        continue;
      }
      const outcome = classifyDroppedBytes({ name: file.name, bytes, acceptsImage });
      list.push(outcome.attachment);
      if (outcome.attachment.kind === "file") {
        pending.push({ attachment: outcome.attachment, bytes });
      }
    }

    this.attachmentsBySession.set(key, list);
    this.pushAttachmentsForView(viewId, list);

    for (const item of pending) {
      this.uploadBytes(viewId, item.attachment, item.bytes);
    }
    for (const name of unreadable) {
      this.emitToView(viewId, { type: "toast", level: "warn", text: `@dropUnreadable:${name}` });
    }
    for (const name of tooLarge) {
      this.emitToView(viewId, { type: "toast", level: "warn", text: `@dropTooLarge:${name}` });
    }
  }

  /** 把窗口的附件列表推给界面：绑了会话走会话投递，空态直接发给这个窗口。 */
  private pushAttachmentsForView(viewId: string, list: readonly Attachment[]): void {
    const sessionId = this.viewSessions.get(viewId);
    if (sessionId) {
      this.deliver(sessionId, { type: "patch", patch: { attachments: [...list] } });
    } else {
      this.emitToView(viewId, { type: "patch", patch: { attachments: [...list] } });
    }
  }

  /** 上传一个文件附件并把 `receiptId` 写回芯片（失败标 error，可重试）。 */
  private uploadAttachment(viewId: string, attachment: Attachment): void {
    void this.runUpload(viewId, attachment.id, attachment.path, attachment.name);
  }

  /**
   * 上传**拖放进来**的字节（没有路径可读）。
   *
   * 字节先存进 `droppedBytes`：上传失败后芯片上的「重试」要能再传一次，而拖放的
   * 字节没有任何别的来源（列表里只有名字）。上传成功后立刻丢掉，失败则留到用户
   * 重试或删掉芯片——内存占用因此只跟「在飞 + 失败」的条目走。
   */
  private uploadBytes(viewId: string, attachment: Attachment, bytes: Uint8Array): void {
    this.droppedBytes.set(attachment.id, bytes);
    this.setStateForUpload(viewId, attachment.id, { status: "uploading", loaded: 0 });
    void this.runUploadBytes(viewId, attachment.id, attachment.name, bytes);
  }

  /** 拖放字节的暂存（键 = 附件 id）：只为「上传失败后重试」而留。 */
  private readonly droppedBytes = new Map<string, Uint8Array>();

  private async runUploadBytes(viewId: string, id: string, name: string, bytes: Uint8Array): Promise<void> {
    const sessionId = this.viewSessions.get(viewId);
    if (!this.client || !sessionId) {
      this.setStateForUpload(viewId, id, { status: "error", message: "@uploadNoSession" });
      return;
    }
    try {
      const value = await this.client.uploadFile(sessionId, bytes, name);
      this.droppedBytes.delete(id);
      this.setStateForUpload(viewId, id, { status: "ready", receiptId: value.receiptId });
    } catch (error) {
      this.log(`[upload] ${name} 上传失败：${this.describeError(error)}`);
      this.setStateForUpload(viewId, id, { status: "error", message: this.describeError(error) });
    }
  }

  /** 改**指定窗口**某个附件的上传状态并下发。 */
  private setStateForUpload(viewId: string, id: string, state: UploadState): void {
    this.mutateAttachmentsForView(viewId, (list) => {
      const target = list.find((a) => a.id === id);
      if (target) target.upload = state;
    });
  }

  private async runUpload(
    viewId: string,
    id: string,
    path: string | undefined,
    name: string,
  ): Promise<void> {
    const setState = (state: UploadState) => {
      this.mutateAttachmentsForView(viewId, (list) => {
        const target = list.find((a) => a.id === id);
        if (target) target.upload = state;
      });
    };
    const sessionId = this.viewSessions.get(viewId);
    if (!this.client || !sessionId || !path) {
      setState({ status: "error", message: "@uploadNoSession" });
      return;
    }
    try {
      setState({ status: "uploading", loaded: 0 });
      const bytes = readFileSync(path);
      const value = await this.client.uploadFile(sessionId, new Uint8Array(bytes), name);
      setState({ status: "ready", receiptId: value.receiptId });
    } catch (error) {
      this.log(`[upload] ${name} 上传失败：${this.describeError(error)}`);
      setState({ status: "error", message: this.describeError(error) });
    }
  }

  /** 修改**指定窗口**的附件并下发（键为会话 id；空态窗口用 viewId 做键）。 */
  private mutateAttachmentsForView(viewId: string, fn: (list: Attachment[]) => void): void {
    const key = this.keyForView(viewId);
    const list = this.attachmentsBySession.get(key) ?? [];
    fn(list);
    this.attachmentsBySession.set(key, list);
    this.pushAttachmentsForView(viewId, list);
  }

  /** 加一个 `@path` 引用芯片（不内联、不上传，正文里只出现路径 token）。 */
  private addReference(viewId: string, path: string, kind: "file" | "directory"): void {
    // 含控制字符或引号的路径无法构成合法 mention：退回把路径插到光标处
    if (formatFileMention(path, kind) === undefined) {
      this.emitToView(viewId, { type: "ui/insertText", text: `"${path}"` });
      return;
    }
    this.mutateAttachmentsForView(viewId, (list) => {
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
  private retryUpload(viewId: string, id: string): void {
    const key = this.keyForView(viewId);
    const attachment = (this.attachmentsBySession.get(key) ?? []).find((a) => a.id === id);
    if (!attachment) return;
    // 拖放进来的附件没有路径，字节存在 `droppedBytes` 里（见 uploadBytes）
    const dropped = this.droppedBytes.get(id);
    if (dropped) {
      void this.runUploadBytes(viewId, id, attachment.name, dropped);
      return;
    }
    if (!attachment.path) return;
    void this.runUpload(viewId, attachment.id, attachment.path, attachment.name);
  }

  /**
   * 附件的展示名：图片与目录取文件名（芯片里更好读），其余取工作区相对路径。
   * 三个入口（选文件 / 选目录 / 右键 / `@`）共用，避免各自写一份而走样。
   */
  private attachmentName(path: string): string {
    return isImagePath(path) || isDirectoryPath(path) ? basename(path) : this.relativePath(path);
  }

  private removeAttachment(viewId: string, id: string): void {
    // 拖放字节只为「失败重试」而留：芯片删了就没用了，别占着内存
    this.droppedBytes.delete(id);
    this.mutateAttachmentsForView(viewId, (list) => {
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
  private async stopRunning(viewId: string): Promise<void> {
    if (!this.client) return;
    const scope = this.scopeOfView(viewId);
    if (!scope) return;
    const sessionId = scope.sessionId;

    const pending = scope.queueItems
      .map((item) => ({ id: item.id, origin: scope.queueOrigin.get(item.id) }))
      .filter((entry): entry is { id: string; origin: QueueOrigin } => Boolean(entry.origin?.content?.length));

    if (!pending.length) {
      if (scope.queueItems.length) {
        // 有排队消息但拿不到可重发内容（理论上不会发生）：只中止，别把消息弄丢
        this.emitToView(viewId, { type: "toast", level: "warn", text: "@queueContentLost" });
      }
      await this.finishCancelOnly(scope);
      return;
    }

    // 1) 摘空队列：避免服务端继续消费，也避免重发后重复
    const removed: typeof pending = [];
    for (const entry of pending) {
      try {
        await this.client.updateQueueRemove(sessionId, entry.id);
        removed.push(entry);
        scope.queueOrigin.delete(entry.id);
      } catch (error) {
        // 摘不动（可能正好开始执行了）：把已摘的放回队列，退化为纯中止
        this.reportError(
          vscode.l10n.t("Failed to take back the queued message; only the current turn was stopped"),
          error,
        );
        await this.requeue(viewId, scope, removed);
        await this.finishCancelOnly(scope);
        return;
      }
    }

    // 2) 中止，并等本轮真正结束
    await this.cancelTurn(scope);
    if (!(await this.waitUntilIdle(scope))) {
      this.reportError(
        vscode.l10n.t("Timed out waiting for the current turn to finish"),
        new Error("turn did not settle"),
      );
      await this.requeue(viewId, scope, removed);
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@queueDispatchFailed" });
      return;
    }

    // 3) 按原顺序重新提交（首条即是「接着发出去」的那条）
    await this.resubmit(viewId, scope, removed);
  }

  /** 只中止，并把界面上的「生成中」收掉（服务端迟迟不回时兜底）。 */
  private async finishCancelOnly(scope: SessionScope): Promise<void> {
    await this.cancelTurn(scope);
    if (!(await this.waitUntilIdle(scope))) {
      this.deliver(scope.sessionId, { type: "patch", patch: { running: false } });
    }
  }

  /** 把一批已摘出的消息按顺序重新提交。失败时剩下的内容放回输入框。 */
  private async resubmit(viewId: string, scope: SessionScope, entries: { origin: QueueOrigin }[]): Promise<void> {
    for (let index = 0; index < entries.length; index++) {
      const { origin } = entries[index];
      if (!this.client) return;
      try {
        // 必须用新的 requestId：旧 id 已被服务端记为已受理，复用会被当成重试而不插入
        const requestId = randomUUID();
        this.rememberSubmission(requestId, origin.text, origin.content ?? [], origin.attachments);
        if (index === 0) {
          scope.running = true;
          this.deliver(scope.sessionId, { type: "patch", patch: { running: true } });
        }
        await this.client.prompt(scope.sessionId, origin.content ?? [], "queue", requestId);
      } catch (error) {
        scope.running = false;
        this.deliver(scope.sessionId, { type: "patch", patch: { running: false } });
        this.reportError(
          vscode.l10n.t("Failed to send the queued message (its content is back in the box)"),
          error,
        );
        this.emitToView(viewId, { type: "toast", level: "warn", text: "@queueDispatchFailed" });
        // 这条以及后面还没发出的，内容都放回输入框
        for (const rest of entries.slice(index)) {
          this.appendDraft(viewId, rest.origin.text, rest.origin.attachments);
        }
        return;
      }
    }
  }

  /** 把已摘出的消息按顺序放回队列（回滚用）。 */
  private async requeue(viewId: string, scope: SessionScope, entries: { origin: QueueOrigin }[]): Promise<void> {
    if (!entries.length) return;
    await this.resubmit(viewId, scope, entries);
  }

  /**
   * 中止当前轮。
   *
   * 刻意**不**在这里乐观地置 `running: false`：那会骗过下面的 `waitUntilIdle`，
   * 让我们在本轮真正结束前就重新提交（于是那条消息被排进队列且不会自动接续）。
   * 界面上的「生成中」由服务端回 `turn/end` 时适配器发的 patch 收掉。
   */
  private async cancelTurn(scope: SessionScope): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.cancel(scope.sessionId);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to stop"), error);
    }
  }

  /** 轮询等待当前轮结束（`running` 由适配器的 patch 帧同步）；返回是否真的等到了。 */
  private async waitUntilIdle(scope: SessionScope, timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (scope.running && Date.now() < deadline) {
      await delay(80);
    }
    return !scope.running;
  }

  /** 把文本与附件追加回输入框（发送失败时的兜底，尽量不丢内容）。 */
  private appendDraft(viewId: string, text: string, attachments: Attachment[]): void {
    const key = this.keyForView(viewId);
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
    this.emitToView(viewId, { type: "patch", patch: { draft: next, attachments: [...list] } });
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
  private async editQueuedMessage(viewId: string, itemId: string): Promise<void> {
    if (!this.client) return;
    const scope = this.scopeOfView(viewId);
    if (!scope) return;
    const item = scope.queueItems.find((entry) => entry.id === itemId);
    try {
      await this.client.updateQueueRemove(scope.sessionId, itemId);
    } catch (error) {
      this.reportError(
        vscode.l10n.t("Failed to restore the queued message (it may already be sending)"),
        error,
      );
      return;
    }

    const origin = scope.queueOrigin.get(itemId);
    scope.queueOrigin.delete(itemId);

    const key = this.keyForView(viewId);
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
    this.emitToView(viewId, { type: "patch", patch: { draft: next, attachments: [...list] } });

    // 线上正文里带附件、本地却没有原始记录（扩展重载过）：附件找不回来，说清楚
    if (item?.hasMedia && !origin?.attachments.length) {
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@queueAttachmentsLost" });
    }
  }

  /**
   * 供编辑器命令调用：把一段文本作为上下文加入最近活动窗口的输入框。
   *
   * `lines` 是选区覆盖的行号（1 基闭区间）：**部分引用必须带上它**——界面上
   * 芯片要显示 `文件:12-40`，发给模型的正文里也要写清是哪些行（否则模型看到的
   * 是一段无出处的代码，用户也分不清自己引的是整篇还是几行）。
   */
  addSelection(name: string, text: string, lines?: { start: number; end: number }): void {
    const viewId = this.activeViewId();
    if (!viewId) return;
    this.mutateAttachmentsForView(viewId, (list) => {
      list.push({ id: randomUUID(), kind: "selection", name, text, lines });
    });
  }

  /** 供资源管理器右键调用：文件 → 上传附件；目录 → `@dir/` 引用芯片。 */
  async addFileContext(path: string): Promise<void> {
    const viewId = this.activeViewId();
    if (!viewId) return;
    await this.applyPathsForView(viewId, [{ path, name: this.attachmentName(path) }]);
  }

  /** 命令面板 / 右键文件夹：选目录加为最近活动窗口的上下文。 */
  async addFolder(): Promise<void> {
    const viewId = this.activeViewId();
    if (!viewId) return;
    await this.pickFolder(viewId);
  }

  /**
   * 在编辑器里打开一个文件。
   *
   * `diff` 表示**想看改动**（文件芯片的普通点击）：有可对比的改动就打开 VS Code
   * 的改动对比窗口（等同 SCM 里的「打开更改」），否则回落成普通打开——拿不到
   * 改动不是错误，「点了什么都不发生」才是。回落逻辑按文件种类分（见
   * `fileChangeKind`）：新文件/无改动 → 直接打开文件本身（用户新增 2026-09-14 的
   * 口径：新建文件点开就是看文件，不是 diff）；已删除 → git 里还有旧内容就开
   * 对比窗口（左边 HEAD、右边空 = 查看被删前的内容），真找不回再明确告知。
   *
   * `path` 是芯片上的原样拼写，可能是**相对**会话工作目录的路径（工具调用
   * 参数原样保留）：先经 `resolveChipPath` 用会话 cwd 解析成绝对路径再动手——
   * 不解析的话 `Uri.file` 拼不出可解析的 URI，「已删除」提示与打开失败都会
   * 对无辜文件发生。解析不了（拿不到 cwd）时**明确告知**用户，不再只写日志：
   * 「点了什么都不发生」正是本文件反复要避免的那种失败。
   *
   * `preview: true` 是既有行为：单击芯片只是预览，不挤掉已经打开的文件。
   */
  private async openFile(
    path: string,
    diff?: boolean,
    viewId?: string,
    cwd?: string,
  ): Promise<void> {
    // 芯片路径可能是相对会话工作目录的拼写：先解析成绝对路径再动手，
    // 不解析的话 Uri.file 拼不出可解析的 URI，「已删除」提示与打开失败
    // 都会对无辜文件发生（与 classifyFiles 同一口径，见 resolveChipPath）
    const resolved = resolveChipPath(cwd, path);
    if (!resolved) {
      // 只可能发生在「相对路径 + 拿不到会话工作目录」时（会话还没进列表）。
      // 以前这里只写日志 → 用户点了完全没反应，不知道发生了什么。
      this.log(`[open] 路径解析不了（相对且缺会话工作目录），放弃打开：${path}`);
      if (viewId) {
        this.emitToView(viewId, { type: "toast", level: "warn", text: "@chipPathUnresolved" });
      }
      return;
    }
    const uri = vscode.Uri.file(resolved);
    const existence = await this.fileExistence(uri);
    if (diff === true) {
      if (await this.openChanges(uri)) return;
      if (existence === "absent") {
        // 磁盘上没有了、git 也没有记录 → 内容找不回。明确说一声，别静默。
        if (viewId) {
          this.emitToView(viewId, { type: "toast", level: "warn", text: "@chipFileDeleted" });
        }
        return;
      }
    } else if (existence === "absent") {
      // 按住修饰键 = 「直接打开文件本身」，但磁盘上已经没有这个文件了，
      // 打开必然失败。这里退化成和普通点击同一条链（先试改动对比），
      // 而不是静默失败：对被删除的文件来说，能看到删除前的内容已经是最好的结果。
      if (await this.openChanges(uri)) return;
      if (viewId) {
        this.emitToView(viewId, { type: "toast", level: "warn", text: "@chipFileDeleted" });
      }
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.log(`[open] 打开失败 ${path}：${this.describeError(error)}`);
    }
  }

  /**
   * 有可对比的改动时打开 VS Code 的对比窗口，返回是否开出来了。
   *
   * 复用 git 扩展的 `git.openChange`（左边是 HEAD/暂存版本、右边是工作区文件），
   * 但**先自己判定有没有改动**：该命令对不在 SCM 改动清单里的文件是静默无操作
   * （内部 `getSCMResource()` 找不到资源就 return），直接调用会「点了没反应」。
   * 判定口径见 `fileChange.ts`——只认工作区/暂存/合并三组（`getSCMResource()` 查的
   * 就是这三组）。未跟踪文件在默认配置（`git.untrackedChanges: "mixed"`）下**也在**
   * 工作区组里，所以这条命令找得到它；只是 git 自己解析不出左侧、最终执行的是
   * `vscode.open`（打开文件本身）——新文件点开就是看文件，正是要的语义。
   * 设成 `"separate"` 时它在未跟踪组、这里判定为「没改动」→ 回落普通打开，结果一样。
   *
   * 判定只做**一次**、落空立即回落，绝不等待（用户 2026-09-14 拍板）：曾试过
   * 「轻推 SCM 重扫 + 限时轮询」来救「第一次点不出 diff」的竞态（git
   * 扩展按 fs 事件去抖刷新，刚写完的文件还没进改动清单），但代价是「真没改动」
   * 的点击（无改动的交付文件、被忽略的文件）每次都要白等 1.2s——点击的即时感
   * 优先，宁可偶尔第一下先看到文件、第二下才是 diff。
   */
  private async openChanges(uri: vscode.Uri): Promise<boolean> {
    try {
      const git = vscode.extensions.getExtension<GitExtensionExportsLike>("vscode.git");
      if (!git) return false;
      // 内建扩展按需激活：没激活时 exports 还是空的
      const exports = git.isActive ? git.exports : await git.activate();
      const repo = exports?.getAPI?.(1)?.getRepository(uri);
      if (!repo) return false;
      // 对比窗口只在这里开：确认在改动清单里才会走进来
      if (hasWorkingChange(repo.state, uri.fsPath)) {
        await vscode.commands.executeCommand("git.openChange", uri);
        return true;
      }
      return false;
    } catch (error) {
      // git 扩展缺失 / 命令失败都不该让「点文件」整个失败：回落普通打开
      this.log(`[open] 改动对比不可用，改为直接打开 ${uri.fsPath}：${this.describeError(error)}`);
      return false;
    }
  }

  // ---------- 文件芯片分类（[新增] / 删除线记号的数据来源） ----------
  /**
   * 文件在磁盘上的存在性（`vscode.workspace.fs` 是宿主内的标准异步入口）。
   *
   * **只有 stat 明确报「找不到」才算 `absent`**，其余异常一律 `unknown`——
   * 拿不到证据时不动（见 `FileExistence` 与 `isNotFoundError` 的注释）。
   */
  private async fileExistence(uri: vscode.Uri): Promise<FileExistence> {
    try {
      await vscode.workspace.fs.stat(uri);
      return "present";
    } catch (error) {
      return isNotFoundError(error) ? "absent" : "unknown";
    }
  }

  /**
   * 会话的工作目录（芯片**相对**路径的解析基准）；会话还没进列表时 undefined
   * （调用方按「解析不了 = 不确定」处理，不猜）。
   */
  private cwdOf(scope: SessionScope): string | undefined {
    return this.sessions.find((s) => s.id === scope.sessionId)?.cwd;
  }

  /**
   * 给一批芯片路径做种类判定（供适配器下发表格给界面）。
   *
   * 每个路径独立判定；单个失败不影响其它（那条退化为无记号）。判定靠
   * `fileChangeKind`（git 状态 + 磁盘存在性），**没有**轮询——那是点击链路
   * （`openChanges`）的专属：分类慢半拍顶多晚一点显示记号，点击必须当场给出
   * 正确行为，二者要求不同。
   *
   * 芯片路径可能是**相对**会话工作目录的拼写（工具调用参数原样保留）：先经
   * `resolveChipPath` 解析成绝对路径再查盘 / 查 git，否则 `stat` 必失败、
   * 被改过的文件会被误判成 `deleted`。表格键保持芯片上的原样路径（界面按它查）。
   */
  private async classifyFiles(
    cwd: string | undefined,
    paths: readonly string[],
  ): Promise<Record<string, FileChangeKind>> {
    const entries = await Promise.all(
      paths.map(async (path): Promise<[string, FileChangeKind] | undefined> => {
        try {
          const resolved = resolveChipPath(cwd, path);
          if (!resolved) return undefined; // 解析不了 = 不确定，不猜 deleted
          const uri = vscode.Uri.file(resolved);
          const existence = await this.fileExistence(uri);
          const state = this.gitStateFor(uri);
          const kind = fileChangeKind(state, uri.fsPath, existence);
          return kind ? [path, kind] : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const kinds: Record<string, FileChangeKind> = {};
    for (const entry of entries) {
      if (entry) kinds[entry[0]] = entry[1];
    }
    return kinds;
  }

  /**
   * 主动让 git 扩展重新算一次状态（**轮次结束时**调一次，不在点击链路里）。
   *
   * 为什么需要：git 扩展按文件系统事件去抖刷新，模型刚写完的文件往往还没进
   * 改动清单。于是用户第一次点文件芯片时 `hasWorkingChange` 判定为「没改动」，
   * 回落成普通打开——看到的是完整文件内容而不是 diff；过一会儿（或点第二次）
   * 刷新到了才是 diff。在轮次结束、文件都已落盘之后主动推一次，用户几秒后
   * 再点就是 diff 了。
   *
   * 与「点击时轻推重扫 + 轮询」的区别：那个是**点击当场等**（真没改动也要白等
   * 1.2s，用户 2026-09-14 拍板撤掉）；这里是**轮次结束时推一次**，不占点击的
   * 任何时间。刷新是尽力而为：失败只记日志，分类照旧（拿不到就无记号）。
   */
  private async refreshGitState(): Promise<void> {
    try {
      const git = vscode.extensions.getExtension<GitExtensionExportsLike>("vscode.git");
      if (!git) return;
      // 这里**要**激活：用户马上就会点芯片，状态必须是对的
      const exports = git.isActive ? git.exports : await git.activate();
      const repositories = exports?.getAPI?.(1)?.repositories ?? [];
      await Promise.all(
        repositories.map(async (repository) => {
          try {
            await repository.status();
          } catch (error) {
            this.log(`[files] 刷新 git 状态失败：${this.describeError(error)}`);
          }
        }),
      );
    } catch (error) {
      this.log(`[files] 取 git 扩展失败：${this.describeError(error)}`);
    }
  }

  /** git 扩展里该路径所属仓库的状态；扩展缺失 / 不在仓库里时返回 undefined。 */
  private gitStateFor(uri: vscode.Uri): GitChangeStateLike | undefined {
    try {
      const git = vscode.extensions.getExtension<GitExtensionExportsLike>("vscode.git");
      const exports = git?.isActive ? git.exports : undefined;
      // 注意：这里**不**主动激活 git 扩展——分类是锦上添花，不值得为一批记号
      // 把整个内建扩展拉起来；没激活就当没有（点击 diff 链路会激活它，
      // 轮次结束的 `refreshGitState` 也会）。
      return exports?.getAPI?.(1)?.getRepository(uri)?.state;
    } catch {
      return undefined;
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

  /** 拉取子代理目录（投影里没有时按需请求；按该窗口绑定的会话）。 */
  private async refreshSubagents(viewId: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!this.client || !scope) {
      this.emitToView(viewId, { type: "subagents/list", entries: [], parentAvailable: false });
      return;
    }
    try {
      const result = await this.client.request<{ entries?: unknown[]; parentAvailable?: boolean }>(
        "subagents/list",
        { parentSessionId: scope.sessionId },
      );
      // `subagents/list` 返回的是 RPC 行 `SubagentListEntry`：`kind:'child'` 才是
      // 可用子代理，`kind:'diagnostic'` 是「有候选但读不出身份」的诊断行——这里
      // 过滤掉是对的（**投影**那边没有这个字段，别把这段照搬过去）。
      scope.subagents = subagentsFromList(result.entries);
      this.deliver(scope.sessionId, {
        type: "subagents/list",
        entries: scope.subagents,
        parentAvailable: result.parentAvailable ?? scope.subagents.length > 0,
      });
    } catch (error) {
      this.log(`[subagents] 列表获取失败：${this.describeError(error)}`);
      this.emitToView(viewId, { type: "subagents/list", entries: [], parentAvailable: false });
    }
  }

  /**
   * 打开某个子代理的对话记录。
   *
   * 子代理是独立会话，用 `session/follow` 的 subagent 地址打开一次快照即可
   * （不需要长跟随：这里只是查看）。
   */
  private async openSubagent(viewId: string, childSessionId: string): Promise<void> {
    if (!this.client) return;
    const scope = this.scopeOfView(viewId);
    const child = scope?.subagents.find((item) => item.id === childSessionId);
    if (!child) {
      this.log(`[subagents] 目录里没有 ${childSessionId}，不打开`);
      return;
    }
    const mode = child.mode;
    const parentSessionId = scope!.sessionId;
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
        this.emitToView(viewId, { type: "subagent/transcript", id: childSessionId, messages: adapter.snapshotMessages() });
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

  /** 窗口侧「列出命令」：没绑会话时给空菜单。 */
  private async listCommandsForView(viewId: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!scope) {
      this.emitToView(viewId, { type: "commands/list", commands: [] });
      return;
    }
    await this.listCommandsFor(scope);
  }

  /** 斜杠命令目录；冷会话也能列。目录存到域上（各会话的菜单可以不同）。 */
  private async listCommandsFor(scope: SessionScope): Promise<void> {
    if (!this.client) {
      this.deliver(scope.sessionId, { type: "commands/list", commands: [] });
      return;
    }
    try {
      const rows = await this.client.request<
        { name: string; description?: string; input?: { hint?: string } }[]
      >("commands/list", { agentId: scope.sessionId });
      // 目录同时用于把「手打的 /xxx」路由到命令通道（见 slashCommandOf）：
      // 只有真正存在的命令才该被拦下来，打错的 `/foo` 仍按普通消息发出去。
      scope.commandCatalog.clear();
      for (const row of rows ?? []) {
        if (row?.name) scope.commandCatalog.set(row.name, { hint: row.input?.hint });
      }
      this.deliver(scope.sessionId, {
        type: "commands/list",
        commands: [
          ...(rows ?? []).map((row) => ({
            name: row.name,
            description: row.description ?? "",
            hint: row.input?.hint,
          })),
          ...(await this.skillCommands(scope)),
        ],
      });
    } catch (error) {
      this.log(`[commands] 列表获取失败：${this.describeError(error)}`);
      this.deliver(scope.sessionId, { type: "commands/list", commands: [] });
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
  private async skillCommands(scope: SessionScope): Promise<CommandView[]> {
    try {
      const value = await this.client!.request<{
        skills?: { name?: string; description?: string; whenToUse?: string }[];
      }>("skills/list", { request: { sessionId: scope.sessionId } });
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

  /** @ 提及：查询文件引用候选（按该窗口绑定的会话查）。 */
  private async queryFiles(viewId: string, query: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!this.client || !scope) {
      this.emitToView(viewId, { type: "files/list", query, items: [] });
      return;
    }
    try {
      const rows = await this.client.request<{ path: string; kind: "file" | "directory" }[]>(
        "fileReferences/list",
        { agentId: scope.sessionId, query },
      );
      this.emitToView(viewId, { type: "files/list", query, items: rows ?? [] });
    } catch (error) {
      this.log(`[files] 查询失败：${this.describeError(error)}`);
      this.emitToView(viewId, { type: "files/list", query, items: [] });
    }
  }

  // ---------- 设置（部署级配置，所有窗口共享同一份） ----------

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
      this.emitAll({
        type: "settings/describe",
        sections,
        writable: Boolean((described as { writable?: boolean }).writable),
      });
    } catch (error) {
      this.log(`[settings] 读取失败：${this.describeError(error)}`);
      this.emitAll({ type: "settings/describe", sections: [], writable: false });
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
      this.emitAll({ type: "toast", level: "info", text: "@settingsResetDone" });
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
      this.emitAll({ type: "toast", level: "info", text: "@settingsSaved" });
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
    // **后台管理器一定要释放**：`reconnectServer` 每次配置变更都会换一个新的管理器，
    // 而只有激活期那个进了 `context.subscriptions`——不在这里统一 dispose，
    // 配置变更之后起的那个后台就不会被清（关窗后它照样在跑，白占端口与内存）。
    this.server.dispose();
    // 停用（关窗 / 重载 / 退出）时把窗口状态缓存刷盘：这一次写基本就是
    // 「下次打开工作区」要用的那份，等不到防抖到点
    this.windowState.dispose();
  }
}

/**
 * 队列里「用户等待发送的消息」的视图：纯映射，见 dsh/queueView.ts。
 * 放在那边是为了让冒烟测试能直接验证，不必启动扩展宿主。
 */

/** 供日志通道使用的时间戳；实现已移到 `dsh/hostLog.ts`（日志写入器之家），这里只做转出。 */
export { stamp } from "./hostLog";

