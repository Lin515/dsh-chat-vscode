import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { panelTabTitle } from "../shared/chat";
import type {
  Attachment,
  ChangesSummaryView,
  ChatState,
  CommandView,
  ConnectPhase,
  DiffLayout,
  DshTarget,
  FileChangeKind,
  GoalView,
  ModelSelectionView,
  ProviderGroupView,
  QuestionAnswerView,
  QuestionView,
  SessionRefView,
  SessionSummaryView,
  TodoView,
  UploadState,
} from "../shared/chat";
import type { HostToWebview, WebviewToHost } from "../shared/ipc";
import { SessionAdapter, type ImageRef } from "./adapter";
import { decodeChangesSummary } from "./changes";
import { changesSummaryKey } from "../shared/changesSummary";
import {
  ATTACH_BYTES_LIMIT,
  buildPromptContent,
  formatPathList,
  isDirectoryPath,
  isImagePath,
  planIntake,
  type IntakeItem,
  type IntakeRejection,
  type IntakeUpload,
} from "./attachments";
import { readClipboardPaths } from "./clipboardPaths";
import { ConfigChangeRouter } from "./configChanges";
import { fileChangeKind, hasWorkingChange, isNotFoundError, resolveChipPath, type FileExistence, type GitChangeStateLike } from "./fileChange";
import { readLocalImages } from "./localImages";
import { shouldContinuePaging } from "./historyPaging";
import { formatFileMention } from "./references";
import { formatFileMentionWithLines } from "../shared/mentions";
import { resolveForVsCode } from "./hostText";
import { normalizeTurnProcessThreshold } from "../shared/turnProcessThreshold";
import { chooseTarget, describeFacts, externalStateOf, type TargetFacts } from "./connectTarget";
import { DshApiError, DshAuthError, DshClient, type SessionReferenceCandidateWire, type SessionSummaryWire } from "./client";
import type { ProjectionBlockWire } from "./projectionStore";
import { PendingInteractions, type HeldInteraction } from "./pendingInteractions";
import type {
  RemoteEventFrame,
  RemoteEventWaterfall,
  SessionControlFrame,
  SessionFollowFrame,
  SessionFollowRequest,
} from "./protocol";
import {
  ServerNotRunningError,
  SupervisorManager,
  WaitCancelledError,
  type ConnectSnapshot,
  type EnsureOptions,
  type ServerInfo,
  type ServerStatus,
} from "./supervisorManager";
import { SessionScope } from "./scope";
import {
  appearanceView,
  sessionPatch,
  sessionSourceOf,
  sessionView,
  type AppearanceViewSource,
  type SessionViewSource,
  type WireChatState,
} from "./sessionView";
import { queueItemsFromInbox, queueItemsFromWire, type QueuedItemEntry, type QueueOrigin } from "./queueView";
import { mergeSubagentActivity, modelSelectionFromProjection, subagentsFromList } from "./projections";
import type { ModelSelectionDecoded, SubagentCatalogEntryView } from "./projections";
import {
  ingestControlBaseline,
  ingestFollowSnapshot,
  ingestProjection,
  replayFollowSnapshot,
  type ProjectionHandlers,
} from "./projectionIngest";
import { deriveTrajectoryModel } from "./trajectory";
import { normalizePath, visibleForWorkspace, visibleSessionRows } from "./sessionList";
import { acceptSessionStatus, decodeSessionStatus } from "./sessionStatus";
import { isBlank, mergeWindowCache, WindowRestore, WorkspaceWindowStateStore, type SidebarSlot, type WindowCache, type WindowKind } from "./windowState";

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
 * `dshChat.autoConnect`：激活期要不要**自动选路连上**。
 *
 * 语义（用户 2026-09-18 口径，取代同名含义的旧 `autoStart`）：关掉 = 启动后**完全不自动连**，
 * 只把内部/外部的探测结论摆到连接条上、显示按钮等用户点。
 *
 * 它只约束扩展自己的**自动**行为（激活期自动连接、窗口恢复会话、心跳自检）。
 * 用户显式动作——发消息、新建/切换会话、点「启动内部 DSH」/「连接内部/外部 DSH」/
 * 「重启内部 DSH」——一律不受它限制。
 */
function readAutoConnect(): boolean {
  return vscode.workspace.getConfiguration("dshChat").get<boolean>("autoConnect") ?? true;
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

/**
 * 连续过程折叠的阈值（`dshChat.turnProcessThreshold`）。
 *
 * 合法域是**整数 ≥0**：`0` = 永不折叠；`1–2` = 永远折叠（只有 1 次工具调用的段
 * 照旧平铺）；`≥3` = 达到该次数才折。坏值（负数、小数、非数字）回退默认 5——
 * 与 `readQuestionBatch` 同一条判据纪律。归一化与特殊值语义都收在
 * `shared/turnProcessThreshold.ts`（宿主、界面共用一份，默认值不会两边漂移）。
 */
function readTurnProcessThreshold(): number {
  return normalizeTurnProcessThreshold(
    vscode.workspace.getConfiguration("dshChat").get<unknown>("turnProcessThreshold"),
  );
}

/** `workspace/follow` 的线格式（只取本地用得到的字段）。 */
interface WorkspaceFollowFrameWire {
  type?: string;
  value?: {
    items?: { workspaceId?: unknown; path?: unknown; sessionIds?: unknown }[];
    archivedSessionIds?: string[];
  };
  workspace?: { workspaceId?: unknown; path?: unknown; sessionIds?: unknown };
  workspaceId?: string;
  archivedSessionIds?: string[];
}

/** 一条工作区记录的形状校验（坏数据逐条丢弃，不整份丢）。 */
function workspaceRow(value: { workspaceId?: unknown; path?: unknown; sessionIds?: unknown } | undefined):
  | { workspaceId: string; path: string; sessionIds: string[] }
  | undefined {
  const workspaceId = typeof value?.workspaceId === "string" ? value.workspaceId : "";
  if (!workspaceId) return undefined;
  return {
    workspaceId,
    path: typeof value?.path === "string" ? value.path : "",
    sessionIds: Array.isArray(value?.sessionIds)
      ? value.sessionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
  };
}

function workspaceRows(
  items: { workspaceId?: unknown; path?: unknown; sessionIds?: unknown }[] | undefined,
): { workspaceId: string; path: string; sessionIds: string[] }[] {
  if (!Array.isArray(items)) return [];
  const rows: { workspaceId: string; path: string; sessionIds: string[] }[] = [];
  for (const item of items) {
    const row = workspaceRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * 界面提交的答案数组 → 卡片展开记录用的「按题目 id 归档」形状。
 *
 * 界面发的是官方线格式的数组（`AskUserQuestionAnswerItem[]`，顺序就是题目顺序），
 * 卡片要按题目 id 取用，所以在这里折一次。
 */
function answersByQuestionId(
  answers: readonly { id: string; selected: string[]; custom?: string }[],
): Record<string, QuestionAnswerView> {
  const map: Record<string, QuestionAnswerView> = {};
  for (const answer of answers ?? []) {
    if (!answer?.id) continue;
    map[answer.id] = {
      selected: Array.isArray(answer.selected) ? answer.selected : [],
      ...(answer.custom ? { custom: answer.custom } : {}),
    };
  }
  return map;
}

/**
 * 会话 id 能不能当一个**纯目录名**用。
 * 会话日志目录名就是会话 id（`~/.dsh/sessions/<工作区>/<会话id>`），而这个 id 是
 * **服务端给的**——`dshChat.url` 指向别人的服务器时，那份列表由对方决定。删除会话
 * 要拿它 `rmSync(recursive)`，所以这里按肯定证据收窄：只有「不含路径分隔符、不是
 * `.`/`..`、不含 Windows 非法字符」的 id 才放行（dsh 的 id 是 `randomUUID()` 一类的
 * 不透明串，正常值天然满足）。
 */
function isSafeSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId === "." || sessionId === "..") return false;
  if (sessionId.length > 200) return false;
  return !/[\\/:*?"<>|]/.test(sessionId);
}

/**
 * `ATTACH_BYTES_LIMIT` 对应的 base64 字符数上限（+3 给 padding 波动留余量）。
 *
 * 界面发来的 base64 先比长度再解码：解码一个几百 MB 的字符串本身就要先分配一份
 * 同量级的内存，而"它超限"这件事只看长度就够了。
 */
const MAX_BASE64_CHARS = Math.ceil(ATTACH_BYTES_LIMIT / 3) * 4 + 3;

/**
 * 图片**内联**（读成字节做内容块）的保守硬上限：64 MB。
 *
 * 只在服务端没给出 `imageLimits.maxImageBytes` 时用。真实的服务端上限通常远小于
 * 此值；这条只是为了兜住「同步读一个巨大文件」的最坏情况。
 */
const IMAGE_INLINE_HARD_CAP = 64 * 1024 * 1024;

/**
 * 这一批附件是从哪条路进来的。
 *
 * 只影响**提示措辞与日志**：准入判据、上限、上传通道完全相同（三个入口共用
 * `ingestAttachments`）。`"button"` 是添加文件按钮——对话框只给读得出来的路径，
 * 所以那条路不会有「读不出来 / 太大」的拒绝。
 */
type IngestSource = "button" | "drop" | "paste";

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

/**
 * 连接那组界面字段的输入：**管理器只读快照** + **本窗口自己的观测** + **本轮的结算**。
 *
 * 三者刻意分开，因为它们的所有权不同（见 `ChatController` 里那几个字段的注释）：
 * 快照是"本窗口与这一套后台现在是什么关系"（管理器的权威），`facts` 是"本窗口刚探到的
 * 两轴结论"（管理器的快照里没有这两个值：它们是**异步探测**，见 §9.1），
 * `round` 是"本窗口这一轮连到哪一步了"（客户端状态机，管理器不知道）。
 */
interface ConnectionFieldsInput {
  /** `SupervisorManager.snapshot()`：目标、外部地址、两道闸、活连接数…… */
  snapshot: ConnectSnapshot;
  /** 两轴探测结论（5 秒心跳 / 显式动作时刷新）。 */
  facts: TargetFacts;
  /** 本窗口那一轮的状态机（`DshClient` 回调与失败分类写进来的）。 */
  round: {
    /** 五值内部态；界面只看得到三档（见 `connection` 字段注释）。 */
    connection: "connecting" | "connected" | "disconnected" | "error" | "stopped";
    detail: string | undefined;
    phase: ConnectPhase;
    target: DshTarget | undefined;
    needsToken: boolean;
  };
  /** 当前客户端连着的地址（连上时界面兜底文案用）。 */
  serverUrl: string | undefined;
}

/** 连接那组字段（首帧快照与增量 patch 共用的那一份）。 */
type ConnectionFields = Pick<
  ChatState,
  | "connection"
  | "connectionDetail"
  | "internalRunning"
  | "externalState"
  | "externalAddress"
  | "connectTarget"
  | "connectPhase"
  | "needsToken"
  | "serverUrl"
>;

/**
 * **连接那组界面字段 = 上面三个输入的纯函数映射**（首帧快照与增量 patch 共用这一份，
 * 两处各写一遍必然漂移）。
 *
 * 两种"单一来源"各归各位：
 * - **管理器那一半**（外部地址、目标、后台在不在）只读 `snapshot()`——控制器不再存一份镜像。
 *   删掉的那两个镜像字段（`internalRunning` / `externalReachable`）在这里由 `facts` 出，
 *   而 `facts` 是**本窗口的探测结论**（快照里没有：内部那一轴要问"守护进程进程还在吗"、
 *   外部那一轴要发一次 HTTP，都是异步探测，见 §9.1）；
 * - **本窗口那一半**（客户端连到哪一步、详情、令牌入口）由 `round` 出——那是 `DshClient`
 *   的状态机，管理器根本不知道（它对"连着外部那个地址的 ws 通不通"没有任何知识）。
 */
function connectionFieldsOf(input: ConnectionFieldsInput): ConnectionFields {
  const { snapshot, facts, round } = input;
  return {
    /**
     * 内部五值态 → 界面三档：`connected` → `ready`；`error` / `stopped` 各自成一档
     * （`stopped` = 按钮态、`error` = 要用户动作的失败）；其余（`connecting` /
     * `disconnected`）都是"正在连接…"。
     */
    connection:
      round.connection === "connected"
        ? "ready"
        : round.connection === "error"
          ? "error"
          : round.connection === "stopped"
            ? "stopped"
            : "connecting",
    connectionDetail: round.detail,
    /** 内部后台在不在跑：按钮态据此给「启动内部 DSH」还是「连接内部 DSH」。 */
    internalRunning: facts.internalRunning || undefined,
    /** 外部备用地址的状态：`unconfigured` 时「连接外部 DSH」置灰。 */
    externalState: externalStateOf(facts),
    /** 外部地址本身（连接中那条文案要写出"在连哪个地址"）——**来自快照**。 */
    externalAddress: snapshot.externalUrl,
    /** 粘性目标（连接中条上写"内部/外部"）；没选过时为 undefined（过线成 null → 界面清键）。 */
    connectTarget: round.target,
    /** 阶段只在连接中有意义，其余状态清掉（否则按钮态还挂着"正在启动…"）。 */
    connectPhase: round.connection === "connecting" ? round.phase : undefined,
    needsToken: round.needsToken || undefined,
    serverUrl: input.serverUrl,
  };
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
   * 工作区身份还没就绪时排队的**编辑区面板**认领（按 VS Code 的恢复顺序入队）。
   * 顺序就是位置，所以必须按原序补（见 `flushRestoreClaims`）；`known` 是面板
   * 自己存下来的会话 id（身份认领用，见 `claimPanelRestore`）。
   */
  private readonly panelClaimsQueued: { viewId: string; known?: string }[] = [];
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
  /**
   * 窗口（viewId）→ 写编辑区标签标题的动作（只有面板注册）。
   *
   * 与 `revealers` 同一套口径：控制器不知道窗口是侧栏还是面板，由 `ChatViewProvider`
   * 挂窗口时注册；标签标题只在**面板**上有意义（侧栏没有标签）。
   * 附带一张「上次写下去的标题」表，避免同一标题反复写（`panel.title` 会重画标签）。
   */
  private readonly panelTitles = new Map<string, (title: string) => void>();
  private readonly panelTitleValues = new Map<string, string>();
  private controlHandle: { cancel(): void } | undefined;
  private eventsHandle: { cancel(): void } | undefined;
  private eventsClientId: string | undefined;
  /**
   * 配置文件热重载：宿主侧的 watcher（`settings.yaml` / `cordis.patch.yml` /
   * `.credentials.yaml`）改了什么，这里就按服务端转发的 emit 帧重读什么。
   * 帧 → 动作的映射与合并见 `configChanges.ts`。
   */
  private readonly configChanges: ConfigChangeRouter;
  /**
   * **还没结算**的审批 / 提问的账本（`eventId` → 请求 / 去重记账）。
   *
   * 规则（去重、回放不删、结算才删）全在 `PendingInteractions` 里，控制器只负责
   * 投递与回复 Host：
   *
   * - 收到 waterfall → `hold()`，`"new"` 就投进域（有域的话；没域就只挂着——**不能回**：
   *   回了等于放行，请求就丢了）；
   * - 窗口绑上会话（`bindViewToSession`）→ `forSession()` 逐条回放；
   * - 本窗口答复 / 用户撤回（`handle` 的三个 arm）→ `settle()`；
   * - Host 撤回（`$events` 的 cancel 帧）→ `withdraw()` 收场本窗口那张卡。
   *
   * 条目**投递出去也留着**：卡片会随域被回收（切会话就是），而审批 / 提问不是 durable
   * 事件（会话日志里没有它们，重放不回），只留适配器里就会永久丢失——agent 卡在 ask
   * 节点。详见 `pendingInteractions.ts` 文件头。
   */
  private readonly interactions = new PendingInteractions();
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
  /**
   * 服务端工作区注册表的**本地镜像**（`workspace/follow` 的 baseline + upsert/remove）。
   *
   * `session/list` 的 `SessionSummary` **不带 workspaceId**（契约里只有 sessionId /
   * cwd / parentSessionId / origin），所以「这条会话属于哪个工作区」只能从注册表
   * 自己的 `sessionIds` 读——这也正是 Web 端分组的权威口径（会话被 `session/create`
   * 带 `workspaceId` 建出来时才记进某个工作区；否则它落在「未分组」）。
   * 历史列表的可见性判据据此写（见 `refreshSessions`）。
   */
  private workspaces: { workspaceId: string; path: string; sessionIds: string[] }[] = [];
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
  /**
   * 改动文件清单的 **fetch-once 缓存**（键 = 会话 id + 事件 seq，见 `changesSummaryKey`）。
   *
   * 缓存**成功与「Host 明确说没有」两种结果**（后者存 `null`）：清单要经一次 HTTP
   * 往返，而同一份清单会被反复问到——打开会话时的重放、加载更早的历史、切走再切回
   * 都会再问一次（见 `shared/ipc.ts` 的 `requestChanges`）。`null` 也缓存，是为了
   * 别对着一份 Host 早就没有的清单反复打请求（旧会话里每一轮都会问一次）。
   *
   * 网络 / 认证类失败**不进缓存**：那类失败重试是有意义的（Host 可能只是忙）。
   */
  private readonly changesSummaries = new Map<string, ChangesSummaryView | null>();
  /**
   * 上面那份缓存属于哪条连接。
   *
   * seq 只在**同一条连接**的会话里有意义：换了目标 / Host 之后，同一个 seq 可能是
   * 别的东西。用「取用时发现 client 换了就整体清空」而不是在每个 `this.client = …`
   * 附近各写一句 clear——赋值点有七八处，漏一处就是拿旧 Host 的清单渲染新 Host 的会话。
   */
  private changesSummaryOwner: DshClient | undefined;
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
   * 为什么不能直接用队列回显：提交给服务端的正文里，`@path` 引用**就在用户正文
   * 里**（界面插的 token），上传文件变成 `{type:'file', receiptId}` 内容块、图片是
   * 独立内容块——回显文本里看不到这些结构。用回显「重新编辑」会丢掉附件芯片。这里按 requestId 存原文，队列帧带回 `rpcId` 时就能对回去。
   * requestId 全局唯一，跨会话共享一份表即可。
   */
  private readonly submissions = new Map<
    string,
    { text: string; attachments: Attachment[]; content: unknown[]; at: number }
  >();
  /**
   * 连接状态（**本窗口自己那一轮**的状态机）。
   *
   * `"stopped"` 与 `"error"` 分开是 2026-09-14 定的，2026-09-18 重新划了界：
   * `"stopped"` = **按钮态**（没连、也没在试：关掉自动连接、用户点过停止、
   * 或内部那套不在），界面给启动/连接按钮；`"error"` = **需要用户动作的失败**
   * （启动类、认证类），界面给原因 + 同一组按钮。连接类失败不进这两档——
   * 它留在 `"connecting"` 里一轮轮重试，直到连上或用户点「停止连接」。
   *
   * **它不是管理器那份快照的镜像**：快照里"后台在不在、手里握着什么"与这里
   * "本窗口的 ws 连上没有"是两件事（例如目标是外部时，快照的 `connected` 恒为假——
   * 管理器与外部服务器之间没有任何连接可言，而本窗口可能正连着它）。三档的判定在
   * `connectionFieldsOf` 里一次做完，界面侧再由 `connectViewOf` 渲染。
   */
  private connection: "connecting" | "connected" | "disconnected" | "error" | "stopped" = "connecting";
  private connectionDetail: string | undefined;
  /** 上次连接因缺少/拒绝令牌失败：界面据此给出「输入令牌」入口（本窗口的鉴权状态）。 */
  private needsToken = false;
  /** 心跳触发的共享后台切换正在跑（去重，见 `reconnectPeer`）。 */
  private peerReconnect = false;
  /**
   * 自动重连是开着的（用户可点「停止连接」关掉，点任意连接按钮再打开）。
   *
   * 重连**没有总超时**（用户 2026-09-14 口径），但只对"还能接着试"的目标生效：
   * 启动类/认证类失败要用户动作，`retryable` 会被置假，不再空转。
   *
   * **为什么它不是快照字段**（管理器那两道闸回答的不是这个问题）：`detachedByUser` /
   * `stoppedByUser` 管的是"**不许自动拉起 / 不许自动接回内部那套**"，而这里管的是
   * "**本窗口还重不重试自己那条连接**"。两者在外部目标上会分叉——「停止连接」之后点
   * 「连接外部 DSH」：控制器把重连重新打开（用户显式动作），而管理器那条外部分支
   * **不经过 `bringUp`**、`detachedByUser` 仍是 true。按闸推导 `autoReconnect` 的话，
   * 外部连接一掉线就再也不重试（`DshClient` 自己也带退避重连，§9.7）。
   */
  private autoReconnect = true;
  /**
   * **两轴探测结论**：内部守护进程在不在跑、外部备用地址可不可达（同一次心跳刷新）。
   *
   * 这是**本窗口的观测**，不是管理器快照的镜像：快照里没有这两个值（内部那一轴要
   * `probeRunning()` 问"守护进程进程还在吗"、外部那一轴要发一次 HTTP，都是异步的，
   * 见 §9.1）。它们只在 `probeFacts()` / `setFacts()` / `setInternalRunning()` 三处写入，
   * 界面侧由 `connectionFieldsOf` 一次映射成 `internalRunning` / `externalState`。
   *
   * 此前是两个字段（`internalRunning` / `externalReachable`）各自被赋值的：一个值两处
   * 镜像，"改了内部忘了外部"就会让按钮态那半句与按钮集各说各话。现在只有这一份，
   * 且只有 `externalStateOf(facts)` 一个读法（它本来就在 `connectTarget` 里）。
   */
  private facts: TargetFacts = { internalRunning: false, externalConfigured: false, externalReachable: false };
  /**
   * **粘性目标**：这一轮连内部还是外部，以及本轮允不允许"内部不存在就拉起一套"。
   *
   * 用户 2026-09-18 口径：自动路径**选一次就不再换**（换目标 = 换服务器、换会话列表、
   * 丢掉正在跑的轮次），只有用户点按钮才换。`undefined` = 还没选过
   * （`dshChat.autoConnect` 关掉且用户没点过按钮时就是这一档，此时心跳不许自动连）。
   *
   * **为什么它不读快照的 `target`**：管理器那份是"上一轮 `ensure()` 记下的目标"，
   * 它**回不到 `undefined`**；而控制器这份有一个管理器表达不了的状态——`autoConnect`
   * 改关时把它清空（"界面给按钮、心跳什么都不做"），改开时靠"还没定过目标"重新选一次路
   * （见 `applyAutoConnect`）。读快照的话，这个"从没定过"的判据永远是假，改开关就不生效了。
   */
  private target?: { kind: DshTarget; mayStart: boolean };
  /**
   * 在途那一轮连的是哪个目标（可能落后于 `target`：命令面板在连接中换了入口）。
   *
   * 只用于两件事：判断"要不要按新目标补跑一轮"，以及让被中止的旧轮**别去改界面状态**
   * （否则会在新目标那一轮开始前闪一下按钮态）。
   */
  private connectRoundTarget?: DshTarget;
  /**
   * 连接轮次号：**作废在途轮**用。
   *
   * `prepareRound()`（换目标、重新点连接、用户停止）把它 +1，`connectOnce` 每次 `++` 取自己
   * 的号；苏醒后的旧轮看到号变了就**静默让位**——否则它会把"已经被换掉的那条连接"装回去。
   *
   * 用户 2026-09-19 实测的 bug 正是缺了这一道：连着外部时外部服务被关掉，用户点
   * 「启动内部 DSH」，上一轮（还挂在外部那个地址的等待里）苏醒后照样建 client、写状态，
   * 界面又被拉回"连接中"，看着像"点了启动也停不下来"。
   *
   * **为什么它不进管理器快照**：它回答的是"**在途的那一轮还算不算数**"——这是发起方的
   * 记账，管理器没有"轮次"这个概念（它的 `ensure()` 是幂等合并的，被合并掉的调用方根本
   * 不知道自己那一轮是不是还算数）。作废也不等于收连接：`prepareRound` 会把号 +1 之后
   * 仍然要用**同一个**后台（见那张「谁该调哪一档」的表）。
   */
  private connectRoundId = 0;
  /**
   * 本轮允不允许自动重试（**这一轮的结算**，不是后台的属性）。
   *
   * 连接类失败（地址连不上、socket 断）→ 真：一轮轮重试到连上或用户点「停止连接」；
   * 启动类（spawn 失败、dsh 起不来）与认证类（要令牌、令牌被拒）→ 假：
   * 重试解决不了，退回按钮态等用户动作（用户 2026-09-18 口径）。
   *
   * 管理器那边没有对应的东西可读：它的 `status.state === "failed"` 只在启动类失败时出现，
   * 而认证类失败（`DshAuthError`）是**控制器这侧**换 cookie 时的产物，管理器一个字都不知道。
   */
  private retryable = false;
  /** 连接阶段：条上"正在启动内部 DSH…"与"正在连接内部 DSH…"的区别。 */
  private connectPhase: ConnectPhase = "connecting";
  /** 正在跑的那一轮连接（并发调用合并；见 `ensureConnected`）。 */
  private connectPromise: Promise<void> | undefined;
  /** 本轮连接尝试有没有拿到"可以拉起后台"的许可（并发时按最宽的那个算）。 */
  private connectMayStart = false;
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

    // 两轴结论的**初值**：外部那一轴现在就能从配置断定（配没配 `dshChat.url` 是配置事实，
    // 不必等一次 HTTP 探测），内部那一轴要等第一次探测——在它之前按"未运行"渲染
    // （按钮态给的是「启动内部 DSH」，点它与「连接内部 DSH」是同一套逻辑，见 §9.4）。
    // 少了这一句，配了外部地址的窗口在首帧快照里会显示"外部 DSH：未配置"
    // 并把「连接外部 DSH」置灰，直到第一轮探测回来。
    this.facts = {
      internalRunning: false,
      externalConfigured: this.server.externalUrl !== undefined,
      externalReachable: false,
    };

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
   * 当前粘性目标（诊断命令用；`autoConnect` 关掉且用户还没点过按钮时为 undefined）。
   *
   * 诊断必须读**这一份**而不是"配没配 url"：内部优先之后，配了 url 也可能正连着内部，
   * 而用户打开诊断要回答的恰恰是"我现在连的到底是哪一个"。
   */
  get connectTarget(): DshTarget | undefined {
    return this.target?.kind;
  }

  /**
   * 心跳的一次体检：两轴探测结论刷新 + 连接还活着吗？不活就按**粘性目标**接着试。
   *
   * 完全异步（探测本身要发 HTTP），所以它**不阻塞** manager 的心跳节拍：
   * 钩子只负责叫起这一轮，结论由这里自己消化。
   */
  private async handleHeartbeat(): Promise<void> {
    const facts = await this.probeFacts();
    this.setFacts(facts);
    if (this.connection === "connected") {
      const probe = await this.probeConnection(this.server.activeBaseUrl);
      if (probe.alive || !probe.info) return;
      // 地址还在但服务器没了：通常是守护进程把 dsh 重起了（端口变了）。
      // 这里**只接上**（start:false）——后台是守护进程在管，扩展不负责起它。
      if (!this.retryable) return;
      await this.reconnectPeer(probe.info);
      return;
    }
    // 未连接：只有"用户没叫停 + 这一轮还能接着试 + 目标已定"才继续。
    // 目标没定 = `autoConnect` 关掉且用户还没点按钮：什么都不做（界面给按钮）。
    if (!this.autoReconnect || !this.retryable || !this.target) return;
    // **外部目标交给客户端自己重连**：它的地址是固定的，`DshClient` 的 ws 退避重连
    // （1s→2s→…→15s）就能恢复；这里再 `ensureConnected` 一轮等于**并发建第二个客户端**
    // ——两个客户端各带一套跟随流，互相打断（2026-09-19 排查"一直反复自动连接"时发现）。
    // 内部目标不能这么放：守护进程重起 dsh 后**端口与令牌都变了**，必须重读会合文件重建。
    if (this.client && this.target.kind === "external") return;
    await this.ensureConnected({ start: this.target.mayStart, target: this.target.kind });
  }

  /**
   * 只读探测两个轴（内部守护进程在不在、外部地址可不可达）。
   *
   * 外部那一次 HTTP 探测**只在未连接时做**（2026-09-19 落实到函数内部）：连上之后连接条
   * 根本不显示，而"连上了"本身就是可达证据——不跳的话每 5 秒都会朝那个地址发一次 GET。
   * 跳的时候**沿用上一次的结论**，不要改写成"不可达"（那是假的：我们正连着它）。
   */
  private async probeFacts(): Promise<TargetFacts> {
    const snapshot = await this.server.probeRunning();
    const externalConfigured = this.server.externalUrl !== undefined;
    const externalReachable =
      externalConfigured && this.connection !== "connected" ? await this.server.probeExternal() : this.facts.externalReachable;
    return { internalRunning: snapshot.supervisorAlive, externalConfigured, externalReachable };
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
    // 后台那一份信息读**快照**（与 `connectionPatch` 同一个来源：不再有第二条读法）
    const info = this.server.snapshot().status.info;
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
      // 与换目标同一条纪律：作废在途轮 + 收掉旧连接（含客户端自己的无限重连）
      this.prepareRound();
      // 后台是守护进程在管、此刻确实在跑：这里只接上，绝不因为"连不上"就自己拉起一套
      await this.ensureConnected({ start: false });
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
    // 会话标题变了：编辑区标签跟着更新。放在投递之前——即使此刻没有任何窗口绑着
    // 这条会话，标签也该跟着走
    if (frame.type === "patch" && frame.patch.session !== undefined) {
      this.syncPanelTitle(sessionId);
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

  /**
   * 取一条 `workspace/changes` 宣告的改动清单，并回帧给**正在看这个会话**的窗口。
   *
   * 清单不在会话事件里（事件只有轮号）：Host 按 `(sessionId, seq)` 在内存里提供，
   * 走认证路由 `GET /api/changes.summary`（`dsh-client-ui-deliverables` 是同一份
   * 契约）。Host 重启过 / Session 已释放 → 404 → 回 `summary: null`：界面据此
   * 不显示卡片（官方同样如此），并且不会再来问。
   *
   * 并发重复（打开会话时的重放与卡片渲染同时问同一个 seq）只是多一次内存读，
   * 不做 in-flight 合并——那点开销不值得再加一张表。
   */
  private async loadChangesSummary(sessionId: string, seq: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    // 换了连接（换目标 / Host）：seq 的含义变了，旧缓存整体作废（见字段注释）
    if (this.changesSummaryOwner !== client) {
      this.changesSummaryOwner = client;
      this.changesSummaries.clear();
    }
    const key = changesSummaryKey(sessionId, seq);
    if (this.changesSummaries.has(key)) {
      this.deliver(sessionId, {
        type: "changes/summary",
        sessionId,
        seq,
        summary: this.changesSummaries.get(key) ?? null,
      });
      return;
    }
    let summary: ChangesSummaryView | null;
    try {
      const raw = await client.getJson(
        `/api/changes.summary?${new URLSearchParams({ sessionId, seq: String(seq) })}`,
      );
      summary = raw === undefined ? null : decodeChangesSummary(raw);
    } catch (error) {
      // 网络 / 认证类失败：**不缓存**，下次重放（切回会话、加载更早）会再试一次
      this.log(`[changes] 改动清单读取失败 seq=${seq}：${this.describeError(error)}`);
      return;
    }
    // 期间换了连接：这份结果属于上一个 Host，丢掉
    if (this.changesSummaryOwner !== client) return;
    this.changesSummaries.set(key, summary);
    this.deliver(sessionId, { type: "changes/summary", sessionId, seq, summary });
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
  snapshotFor(viewId: string | undefined): WireChatState {
    const sessionId = viewId ? this.viewSessions.get(viewId) : undefined;
    const scope = sessionId ? this.scopes.get(sessionId) : undefined;
    /**
     * **整份状态帧只有这一个生产者**。
     *
     * 三处「切会话要换掉哪些字段」的现场（首帧快照、增量 patch、切会话专帧）以前各写
     * 一份，加一个字段只改其中一处，后果是**那个字段在切换后静默复旧/丢失**（`goal`
     * 清不掉、`historyLoading` 永久卡死都是这一族，见 `docs/audit-summary.md`）。
     * 现在字段清单只有 `dsh/sessionView.ts` 一份：外观态（与会话无关的设置）与
     * 会话态（域 + 适配器）各由自己的构造器出，两边都带全字段，`undefined` 折成
     * `null`（`shared/wire.ts` 的过线口径）只在那两个构造器里做。
     */
    return {
      // 首帧快照的**键顺序**刻意保持与原实现一致（连接 → 外观 → 会话 → 输入区）：
      // 键集合与取值由两个构造器决定，但帧的 JSON 形态（`JSON.stringify` 的顺序）
      // 不该因为这次收敛而变——对拍线上帧时那是最容易白费一轮的噪声。
      ...this.connectionPatch(),
      ...appearanceView(this.appearanceSource()),
      ...sessionView(
        sessionSourceOf(
          scope,
          sessionId ? this.sessions.find((session) => session.id === sessionId) : undefined,
          this.models,
        ),
      ),
      // 输入区那两个字段按**窗口**存（未绑会话时）/ 按会话键存，不属于会话状态片段：
      // 它们由输入框那条链单独维护，这里只补进快照（见 `keyForView`）。
      attachments: this.attachmentsBySession.get(sessionId ?? viewId ?? "") ?? [],
      draft: this.drafts.get(sessionId ?? viewId ?? "") ?? "",
    };
  }

  /**
   * 增量 patch 用的取值来源：与首帧快照**同一个** `sessionSourceOf`，只是这里不需要
   * 会话摘要（patch 从不改 `session` 本身，标题那条路有自己的 `sessionWithTitle`）。
   */
  private sessionSource(scope: SessionScope | undefined): SessionViewSource {
    return sessionSourceOf(scope, undefined, this.models);
  }

  /** 首帧快照里「与会话无关」的那一半（语言 / 排版 / 字号 / 批次 / 阈值 / 发送行为）。 */
  private appearanceSource(): AppearanceViewSource {
    return {
      locale: () => readLanguage(),
      diffLayout: () => readDiffLayout(),
      /** 界面字号（px）；undefined = auto，跟随 VS Code 注入的字号。 */
      fontSizePx: () => readFontSize(),
      /** 问卷一次展开几道题（多于它就依次问答；0 = 始终全部展开）。 */
      questionBatch: () => readQuestionBatch(),
      /** 连续过程折叠的阈值（0 = 永不折；1–2 = 永远折，仅一次调用的段除外）。 */
      turnProcessThreshold: () => readTurnProcessThreshold(),
      /**
       * 「繁忙时的发送行为」是**全局部署设置**（不是会话态），但界面要按它显示运行中
       * 发送按钮的文案，所以首帧也得带上——否则重载后按钮文案退回默认，直到
       * `refreshImageCaps` 把它重读出来（连上模型目录时那一次）。
       */
      busyEnter: () => (this.busyEnter === "steer" ? "steer" : "queue"),
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
    // 面板的标签标题要跟着它的会话走：标题设定器在挂窗口时注册（kind 可能晚一步登记），
    // 所以这里补推一次——恢复路径上面板先 `bindViewKind` 再认领会话，也不会漏
    const sessionId = this.viewSessions.get(viewId);
    if (kind === "panel" && sessionId) this.syncPanelTitle(sessionId);
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
    // **自动路径**：跟随 `dshChat.autoConnect`——关掉自动连接时，恢复会话不该顺手
    // 把后台起起来或连上去（用户 2026-09-18 口径：那时界面只显示按钮，等用户点）
    if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: readAutoConnect() });
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
   * 面板恢复会话的认领（优先按 webview 存的会话 id，退回按下标，见 `WindowRestore`）。
   *
   * 缓存键还没绑上时**先排队**：位置就是这个面板的恢复顺序，等键绑好再按序补
   * （见 `flushRestoreClaims`）——提前认领会把顺序用掉，后面的窗口就接错了。
   *
   * `known` 来自 `deserializeWebviewPanel(panel, state)` 的 `state`（webview 用
   * `setState` 存下的会话 id，见 `webview/bridge.ts`）。它是**身份**：即使 VS Code
   * 恢复面板的顺序与当初不一致，也能各自接回自己的会话（用户 2026-09-21 报的
   * 「标签 1/2 的会话交叉」就是只靠顺序对位的固有缺陷）。
   */
  claimPanelRestore(viewId: string, known?: string): void {
    if (!this.windowState.key) {
      this.panelClaimsQueued.push({ viewId, known });
      this.restoreAwaiting.add(viewId);
      this.log(`[restore] 工作区身份未就绪，面板 ${viewId} 的认领先排队`);
      return;
    }
    this.applyPanelClaim(viewId, known);
  }

  /** 面板认领的落点：按身份 / 按下标取会话，记一行日志（排查错位全看它）。 */
  private applyPanelClaim(viewId: string, known?: string): void {
    const claimed = this.windowRestore.classifyPanel(known);
    this.log(
      `[restore] 面板 ${viewId} 认领：${claimed.by === "identity" ? "按身份" : "按顺序"}` +
        `（webview 存的是 ${known ?? "无"}）→ ${claimed.sessionId ?? "空态"}`,
    );
    this.applyRestoreHint(viewId, claimed.sessionId);
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
    for (const claim of this.panelClaimsQueued.splice(0)) {
      this.restoreAwaiting.delete(claim.viewId);
      if (!this.viewKinds.has(claim.viewId)) continue;
      this.applyPanelClaim(claim.viewId, claim.known);
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
  }

  /** 注册「把这个窗口带到前台」的动作（见 `revealers`）。 */
  registerRevealer(viewId: string, reveal: () => void): void {
    this.revealers.set(viewId, reveal);
  }

  /**
   * 注册「设置编辑区标签标题」的动作（只有面板注册，侧栏没有标签可写）。
   *
   * 宿主是唯一知道「这个窗口开着哪条会话」的一侧，标题因此由宿主算好再交出去
   * （见 `syncPanelTitle`）；`chatView.ts` 只负责把它写给 `panel.title`。
   */
  registerTitleSetter(viewId: string, setTitle: (title: string) => void): void {
    this.panelTitles.set(viewId, setTitle);
  }

  /**
   * 编辑区标签的标题：会话标题（还没有标题的空会话显示 `DSH`）。
   *
   * 为什么要它：重载后两条标签都只写 `DSH`，谁是谁只能靠点开看（用户 2026-09-21 口径）。
   * **标签上不带运行状态**（同一天的二次口径：状态后缀与图标标识都撤掉，保持纯静态
   * ——「在不在生成」由会话界面自身表达）。
   *
   * 只在标题真的变了才写（`panel.title` 会重画标签）。
   */
  private syncPanelTitle(sessionId: string): void {
    const title = panelTabTitle(
      this.sessions.find((session) => session.id === sessionId)?.title,
    );
    for (const [viewId, bound] of this.viewSessions) {
      if (bound !== sessionId) continue;
      if (this.viewKinds.get(viewId) !== "panel") continue;
      this.setPanelTitle(viewId, title);
    }
  }

  /** 把算好的标题交给面板（同一个标题不重复写；调用方保证 `viewId` 是面板）。 */
  private setPanelTitle(viewId: string, title: string): void {
    const setter = this.panelTitles.get(viewId);
    if (!setter) return;
    if (this.panelTitleValues.get(viewId) === title) return;
    this.panelTitleValues.set(viewId, title);
    setter(title);
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
    // 标签设定器与「上次写下去的标题」跟着窗口一起清：长期存活的扩展宿主里，
    // 关掉又重开窗口会不断累积这两张按 viewId 建的表
    this.panelTitles.delete(viewId);
    this.panelTitleValues.delete(viewId);
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
   * **恢复未完时用「合并」而不是「跳过」**：VS Code 是「面板第一次变为可见时」才
   * 认领会话的（见 `WindowRestore.pending`），那一刻之前活着的窗口只是**已经恢复的**
   * 那部分——按内存状态整份覆写，缓存里还没露面的面板就会被抹掉（它们的会话随之失联）。
   * 所以这里把**尚未认领**的那一段（`unclaimedPanels` / 还没问过话的侧栏槽位）
   * 原样接在后面，已认领的部分一律用内存里的最新状态覆盖。
   *
   * 为什么不再「整个恢复窗口内都不写」：那样等于把这一轮的窗口状态交给「最后一个窗口
   * 什么时候认领」决定——侧栏容器折叠着（VS Code 根本不会实例化它的视图）或某个面板
   * 一直没被点开时，`pending` 永远为真，**这一整轮的所有变更都写不进去**，缓存停在
   * 上一次运行的值上。用户 2026-09-15 报的「编辑区窗口从会话 A 切到 B，重启后还是
   * 打开 A」正是这个：写盘被无限期押后，`dispose()` 时 store 里还是启动时读到的那份
   * 旧缓存。
   */
  private persistWindowState(): void {
    // 工作区身份可能还没绑（只有编辑区面板、从没有侧栏被实例化的用法）：
    // 惰性补绑一次，否则这条路径永远写不出任何东西（缓存里也就永远没有最终会话）。
    if (!this.windowState.key) this.ensureWindowState();
    if (!this.windowState.key) return;
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
    if (this.pendingRestore) {
      // 恢复未完：内存里那部分照写，**还没认领的**按原位接在后面。
      // 合并规则是纯函数、带断言（`mergeWindowCache`），这里只喂材料。
      const previous = this.windowState.snapshot();
      const merged = mergeWindowCache({
        memory: cache,
        previous,
        panelClaimed: (index) => this.windowRestore.panelClaimed(index),
        restorePending: true,
        slotClaimed: (slot) => this.windowRestore.isSlotClaimed(slot),
      });
      cache.panels = merged.panels;
      cache.primary = merged.primary;
      cache.secondary = merged.secondary;
    }
    this.windowState.load(cache);
    this.windowState.markDirty();
  }

  /**
   * 恢复窗口是否还没结束（还有缓存里的窗口没来认领）。
   *
   * 只用于写缓存时决定「尚未认领的那一段要不要保留」（见 `persistWindowState`）。
   */
  private get pendingRestore(): boolean {
    return this.windowRestore.pending;
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
    // 有窗口盯上这个会话了：把**还没结算**的审批 / 提问交出去（账本见 `interactions`）。
    // 位置很关键——放在这里而不是 `ensureScope`：用户切走又切回来时域早就存在、
    // 不会重新建域（`ensureScope` 直接返回），而这正是卡片必须回来的时刻。
    // 重复投递安全：适配器按 `requestId` 去重（`addQuestion` / `addApproval`
    // 的 existing 分支只更新、不重加）。
    this.replayHeldToScope(sessionId, scope);
    // 编辑区标签跟着换成这条会话（标题，见 `syncPanelTitle`）
    if (this.viewKinds.get(viewId) === "panel") this.syncPanelTitle(sessionId);
    this.log(`[bind] 窗口=${viewId} → 会话=${sessionId}（原=${previous ?? "空态"}）`);
    this.persistWindowState();
  }

  /**
   * 把某个会话**还没结算**的审批 / 提问投进它的适配器（`bindViewToSession` 与
   * 重连后的 `onConnected` 共用）。
   *
   * 取条目走 `PendingInteractions.forSession`，它是**读**：条目要一直留在账上到真正
   * 结算（答复或 Host 撤回）。卡片随时可能随域被回收而消失（切会话就是），留一份
   * 原始请求才能在切回来时复原。
   */
  private replayHeldToScope(sessionId: string, scope: SessionScope): void {
    let replayed = 0;
    for (const held of this.interactions.forSession(sessionId)) {
      this.deliverEventToScope(held, scope);
      replayed += 1;
    }
    // 回放了哪些留一行日志：卡片「回来了没有」与「是不是又被重折吃掉」在输出通道里
    // 能分辨（见 `interactionCards`）
    if (replayed > 0) {
      this.log(`[bind] 回放未结算的审批/提问 ${replayed} 条 → 会话=${sessionId}`);
    }
  }

  // ---------- 连接 ----------

  /**
   * 建立（或恢复）与 dsh 的连接。
   *
   * `options.start` 决定"内部后台不存在时允不允许拉一套"（透传给管理器，见
   * `supervisorManager` 文件头的启动决策）：只有"都没有 → 启动内部"那一支与
   * **用户显式**动作（发消息 / 新建会话 / 点「启动内部 DSH」）为真。
   * 不允许且内部后台不在时，管理器抛 `ServerNotRunningError`，这里切回按钮态
   * （界面按两轴结论给按钮），而不是把"没启动"渲染成"正在连接…"或"连接失败"。
   *
   * `options.target` 是**粘性目标**（见 `target` 字段）：不给时沿用上一次选的那个。
   */
  async ensureConnected(options: EnsureOptions = {}): Promise<void> {
    if (this.disposed) return;
    if (this.client && this.connection === "connected") return;
    // **并发合并**：心跳每 5 秒重试一轮，用户动作可能同时到；两轮叠在一起会建出两个
    // 客户端（两条 WS、两套跟随流，服务端会看到两个"窗口"）。
    // 已经有一轮在跑时：请求"允许启动"而那一轮没有许可 → 等它结束后**补跑一轮**
    // （否则用户点「启动内部 DSH」可能正好被合并进一次"接不上就报没启动"的尝试里，点了没反应）。
    if (this.connectPromise) {
      const inFlight = this.connectPromise;
      const wanted = options.target ?? this.target?.kind;
      const targetChanged = wanted !== undefined && wanted !== this.connectRoundTarget;
      // 目标变了（连接中从命令面板换了入口）：在途那一轮可能正卡在**没有时长上限**的
      // 等待里，先中止它让它让位，再按新目标补跑一轮——否则那一轮会一直等旧目标。
      // 同样是「只中止等待、不收连接」那一档（见 `prepareRound` 顶上那张表）
      if (targetChanged) this.server.stop({ cancelWait: true });
      if ((options.start && !this.connectMayStart) || targetChanged) {
        await inFlight;
        return this.ensureConnected(options);
      }
      return inFlight;
    }
    this.connectRoundTarget = options.target ?? this.target?.kind ?? "internal";
    if (options.start) this.connectMayStart = true;
    this.connectPromise = this.connectOnce().finally(() => {
      this.connectPromise = undefined;
      this.connectMayStart = false;
    });
    return this.connectPromise;
  }

  private async connectOnce(): Promise<void> {
    const roundId = ++this.connectRoundId;
    const roundTarget = this.target?.kind ?? "internal";
    // 阶段：这一轮允许"内部不存在就拉起一套"、而内部此刻确实不在 → 在**启动**它
    // （发消息这类显式动作也会走到这里，文案得说实话，而不是笼统地"正在连接"）
    this.connectPhase =
      roundTarget === "internal" && this.connectMayStart && !this.facts.internalRunning ? "starting" : "connecting";
    this.setConnection("connecting");
    try {
      // 许可按"这一轮里最宽的那个请求"算；目标按粘性目标（见 ensureConnected）
      const info = await this.server.ensure({
        start: this.connectMayStart,
        target: roundTarget,
      });
      if (this.roundStale(roundId)) return;
      if (this.userAskedToStop()) return this.abandonRound();
      // 上一条连接已经不作数（掉线、内部换了地址/令牌、换目标）：**先收掉它再建新的**。
      // `DshClient` 自己带无限重连，覆盖 `this.client` 而不 dispose 就等于把一条
      // 永远重试旧地址的连接丢在后台——它还会继续回调状态（2026-09-19 修）。
      this.teardownStreams();
      this.client?.dispose();
      this.client = undefined;
      // **认证链按"是不是外部服务器"分叉，不按"是不是本窗口拉起的"**（2026-09-14 修）：
      // peer（别的窗口拉起的、或窗口重载后接上的同一套）手里同样有会合文件里的启动
      // 令牌，必须走同一条令牌换 cookie 的路；此前它们被当成外部服务器处理，于是
      // 弹「输入令牌」框——用户报的"内部启动后拿不到 token、连不上"就是这里。
      const client = info.ownership === "external" ? await this.openExternalClient(info) : await this.openOwnedClient(info);
      // 换 cookie / 换令牌也要几秒，期间用户可能已经换了目标或点了停止
      if (this.roundStale(roundId)) {
        client.dispose();
        return;
      }
      client.onDidChangeState((state) => {
        // **旧 client 的回调不许写全局状态**：被换掉的那个客户端自己也带着无限重连，
        // 它的 connecting/disconnected 会把界面反复拉回"连接中"（2026-09-19 实测）。
        if (this.client !== client) return;
        if (state === "connected") {
          this.setConnection("connected");
          void this.onConnected();
          return;
        }
        if (state === "connecting") {
          this.setConnection("connecting");
          return;
        }
        // 掉线 / 传输层报错：**连接类**，按粘性目标一轮轮接着试（不设自动停止时间，
        // 只由用户点「停止连接」结束）——用户 2026-09-18 口径。
        // 用户叫停过就不复活（那时 client 也该已经 dispose，这里是第二道防线）。
        if (!this.autoReconnect) return;
        this.retryable = true;
        this.setConnection("connecting", state === "disconnected" ? "@connectionLost" : undefined);
      });
      this.client = client;
      // 工作区 id 是**服务端注册表**里的东西：换了服务器（或注册表被重置）时
      // 旧 id 会 `workspace/not-found`，所以每次新建 client 都重新解析一次
      this.workspaceId = undefined;
      client.connect();
      await this.loadModels();
      await this.refreshSessions();
      // 用户在这一轮跑着的时候按了「停止连接」，或已换了目标：**刚建好的连接也要收掉**。
      // 到这里才收，是因为上面几步（换 cookie、拉模型、拉会话）都要一两秒，而"停止"
      // 恰恰可能落在这个窗口里；漏掉的话，用户按了停止却照样被连上，而且连上之后
      // 连接条消失，他连个反悔的入口都没有。
      if (this.roundStale(roundId)) {
        if (this.client === client) this.client = undefined;
        client.dispose();
        return;
      }
      if (this.userAskedToStop()) {
        client.dispose();
        this.client = undefined;
        this.teardownStreams();
        return this.abandonRound();
      }
      this.setConnection("connected");
      // 不再自动建会话：每个窗口的会话由它自己的首次动作（发消息/新建/切会话）
      // 按需建立，空窗口保持空态——多窗口各自为政，互不同步。
    } catch (error) {
      this.classifyConnectFailure(error, roundTarget);
    }
  }

  /**
   * 这一轮是不是已经被**顶掉**了（用户换了目标、重新点了连接、或窗口已释放）。
   *
   * 作废方（`prepareRound`）只把号 +1 并同步收掉连接，不等在途轮自己结束——因为那一轮
   * 可能正挂在**没有时长上限**的等待里（外部地址等应答、内部等就绪），等它等于不换目标。
   */
  private roundStale(roundId: number): boolean {
    return this.disposed || roundId !== this.connectRoundId;
  }

  /**
   * 开始新一轮连接前的收场：**作废在途轮 + 中止在途等待 + 收掉上一条连接**。
   *
   * 三件事缺一不可（2026-09-19 修「停止连接停不下来」）：
   * 1. `connectRoundId + 1` —— 让在途轮苏醒后静默让位；
   * 2. `stop({ cancelWait: true })` —— 中止管理器那侧在途的等待（它可能挂在旧目标的地址上）；
   * 3. `client.dispose()` —— **杀掉客户端自己的无限重连**。`DshClient` 在 ws 断开后
   *    会按 1s→2s→…→15s 一直重连，且每次 close/connect 都回调状态；不 dispose 它，
   *    界面就会在"已停止"与"连接中"之间反复跳，用户点了停止也停不下来。
   *
   * 后台（守护进程 + dsh）**一个字都不动**——收掉的只是本窗口的连接。
   *
   * ## 「谁该调哪一档」——控制器四个停止落点对照表（定稿，改之前先看这张）
   *
   * 管理器只有**一个**停止入口（见 `supervisorManager` 文件头「停止入口收敛」）：
   * `stop(options?: { release?, cancelWait?, askSupervisor? })`。下面四处各调其中一档，
   * 而**调错档不会报任何错**，只会在用户那里表现为"点了没反应"或"过一会儿又连上了"：
   *
   * | 控制器落点 | 调哪一档 | 少了它会怎样 |
   * |---|---|---|
   * | `prepareRound()`（换目标 / 重开一轮 / 并发补跑共用） | `stop({ cancelWait: true })` | 那一轮还挂在旧目标**没有时长上限**的等待里，等于没换目标。**这一档不收连接**：马上要重新接上的是**同一个**后台（§9.9），收掉 socket 等于交还占用，`ownership` 从 self 掉成 peer、诊断里"是不是本窗口拉起的"开始说谎 |
   * | `abandonRound()`（用户叫停后放弃这一轮） | `stop({ release: true })` | 一轮排队/重试可能在叫停**之后**才走到 `bringUp`（它会清掉 `detachedByUser`）并在管理器侧把连接建起来，而控制器随后放弃了这一轮——连接就留在管理器手里（幂等，所以再收一次） |
   * | `stopReconnect()`（用户点「停止连接」） | `stop({ release: true })` | 只断不挡 → 5 秒后心跳又接回来；只挡不断 → 守护进程永远认为有人用，内部 dsh 不按空闲退场 |
   * | `stopServer()`（「停止内部 DSH」） | `stop({ cancelWait: true, askSupervisor: true })` | 请求都发出去了，再等一个不会来的就绪没有意义；没有活连接时管理器自己走**临时接入**那条路，回执才不会谎报"没有在运行" |
   *
   * 三个 flag 的完整语义与"少了它会怎样"另见 `StopOptions` 的注释；`askSupervisor` 天然
   * 蕴含 `cancelWait`（管理器里就是这样定的），这里两档都显式写出来，与旧 `stopAndExit()` 同形。
   */
  private prepareRound(): void {
    this.connectRoundId += 1;
    // 只中止在途等待、**不收连接**：这一轮马上要重新接上同一个后台
    void this.server.stop({ cancelWait: true });
    this.teardownStreams();
    this.client?.dispose();
    this.client = undefined;
  }

  /**
   * 连接失败分三类（用户 2026-09-18 口径：**只有"还能接着试"的那类才自动重试**）。
   *
   * | 类别 | 例子 | 界面 | 自动重试 |
   * |---|---|---|---|
   * | 没目标 | `ServerNotRunningError`（外部目标没配地址；或本轮不许启动） | 按钮态 | 否（等用户点） |
   * | 用户叫停 | `WaitCancelledError` | 按钮态 | 否 |
   * | 认证类 | `DshAuthError`（要令牌 / 令牌被拒） | 按钮态 + 「输入令牌」（外部） | 否——重试解决不了凭据问题 |
   * | 启动类 | `@serverSpawnFailed` / `@serverNotReady`（命令错、dsh 起不来） | 按钮态 + 原因 | 否——否则每 5 秒 spawn 一个必死进程、日志被刷爆 |
   * | 连接类 | 地址连不上、socket 断 | 仍在**连接中** + 原因 | **是**，直到连上或用户点「停止连接」 |
   *
   * 拿不到明确证据时按**连接类**处理（继续试），因为"多试几次"的代价只是日志，
   * 而把可恢复的抖动当成终局失败、让用户自己发现要点按钮，代价更大。
   */
  private classifyConnectFailure(error: unknown, roundTarget: DshTarget): void {
    if (error instanceof ServerNotRunningError) {
      this.log("[connect] 没有可连的内部后台，且本次调用不允许启动（界面给按钮）");
      this.retryable = false;
      this.setConnection("stopped");
      return;
    }
    if (error instanceof WaitCancelledError) {
      // 换目标导致的中止：这一轮是被**新的那一轮**顶掉的，界面状态交给它去写，
      // 这里若照旧切按钮态，用户会看到连接条闪一下"已停止"。
      if (this.target?.kind !== roundTarget) {
        this.log("[connect] 换了目标：让位给新的一轮");
        return;
      }
      this.log("[connect] 等待就绪被用户中止（界面给按钮）");
      this.retryable = false;
      this.setConnection("stopped");
      return;
    }
    const detail = this.describeError(error);
    if (error instanceof DshAuthError) {
      // 认证链要到用户动作：外部服务器在连接条上给「输入令牌」入口
      if (roundTarget === "external") this.setNeedsToken(true);
      this.retryable = false;
      this.log(`[connect] 认证失败（需要用户动作，不再自动重试）：${detail}`);
      this.setConnection("error", detail);
      return;
    }
    if (this.isStartFailure(error)) {
      this.retryable = false;
      this.log(`[connect] 启动失败（不再自动重试，避免反复 spawn）：${detail}`);
      this.setConnection("error", detail);
      return;
    }
    this.retryable = true;
    this.log(`[connect] 连接失败（继续按粘性目标重试，直到连上或用户点「停止连接」）：${detail}`);
    this.setConnection("connecting", detail);
  }

  /**
   * 这一轮的异常是不是"**起来就死**"那一类（spawn 失败、或等不出一个可用的会合状态）。
   *
   * 这两条都是 `SupervisorManager` 用 `@serverSpawnFailed` / `@serverNotReady` 开头的
   * detail 抛出来的（见 `startFailure` / `bringUpWith`），识别它们是为了**别自动重试**：
   * 命令写错时每 5 秒 spawn 一个必死进程、日志被刷爆，比"停下来等用户"糟得多。
   */
  private isStartFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith("@serverSpawnFailed") || message.startsWith("@serverNotReady");
  }

  /**
   * 本轮连接是不是"用户已经叫停、且不是他自己发起的"。
   *
   * `autoReconnect === false` ⇔ 用户按过「停止连接」；`connectMayStart` 为真表示这一轮
   * 是用户显式动作（发消息 / 启动内部 DSH / 重启）发起的——**用户显式动作永远算数**，
   * 只有"自动路径的一轮"才该在用户叫停后放弃。用于两个时刻：等待结束之后、以及
   * 连接建好之前，把"停止"真正贯彻到这一轮里（否则停止按钮只改界面不改行为）。
   */
  private userAskedToStop(): boolean {
    return !this.autoReconnect && !this.connectMayStart;
  }

  /** 用户叫停后放弃这一轮：切回按钮态，不写错误详情。 */
  private abandonRound(): void {
    this.log("[connect] 用户已点「停止连接」：本轮不再建连");
    this.retryable = false;
    this.setConnection("stopped");
    // 这一轮可能**刚刚**（或正在）把管理器的内部连接建起来——再收一次（档位见 `prepareRound`
    // 顶上那张表）。少了它，"用户叫停"会被一轮排队/重试的连接偷偷翻过去：`bringUp` 会清掉
    // `detachedByUser`（那是"显式动作"的通行证），而这一轮随后在控制器侧被放弃、连接却留在了
    // 管理器手里（2026-09-19）。幂等：没连着的时候它只是把标记再置一次。
    void this.server.stop({ release: true });
  }

  /** 自管服务器：启动令牌来自会合文件，认证失败只能如实报错。 */
  private async openOwnedClient(info: ServerInfo): Promise<DshClient> {
    try {
      return await this.authenticateWithToken(info.baseUrl, info.token);
    } catch (error) {
      // 令牌可能刚好被换掉（守护进程在我们取令牌与换 cookie 的空档里重起了 dsh）。
      // 会合文件是**唯一权威**，重读一次再用，而不是把用户丢给「输入令牌」。
      const fresh = this.server.freshToken();
      if (!(error instanceof DshAuthError) || !fresh || fresh === info.token) throw error;
      this.log("[auth] 会合文件里的启动令牌被拒，换用刚读到的那一份重试");
      return this.authenticateWithToken(info.baseUrl, fresh);
    }
  }

  /** 用启动令牌换会话 cookie（不成功就把客户端丢掉，别留着半条连接）。 */
  private async authenticateWithToken(baseUrl: string, token: string | undefined): Promise<DshClient> {
    const client = new DshClient(baseUrl, token, this.log);
    try {
      await client.authenticate();
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
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

    // 已建立的连接带着旧会话，重新走一遍连接流程（**用户显式动作**：允许拉起后台）
    this.teardownStreams();
    this.client?.dispose();
    this.client = undefined;
    this.connection = "connecting";
    await this.ensureConnected({ start: true });
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
   * 配置里改了语言、字号、问卷一次展开的题数或折叠阈值：推给界面。
   *
   * 四者都**不需要**重载 webview：语言是纯词典切换（界面用 `locale` 选字典），
   * 其余是三个数字。重载会丢掉滚动位置与展开状态，代价不成比例。
   */
  refreshAppearance(): void {
    this.emitAll({
      type: "patch",
      patch: {
        locale: readLanguage(),
        /** 0（auto）时为 undefined，过线成 null，界面清掉 `--font-size` 回到 VS Code 字号 */
        fontSizePx: readFontSize(),
        questionBatch: readQuestionBatch(),
        turnProcessThreshold: readTurnProcessThreshold(),
      },
    });
  }

  private async onConnected(): Promise<void> {
    // socket 重建后长活流都要重开：每个打开的域重新跟随（适配器整个重建，
    // 新快照会重放最近 60 条），全局流重开一次
    for (const scope of this.scopes.values()) this.openScopeFollow(scope);
    // 适配器刚被整个重建，卡片要重新回放一遍。**不删账本条目**——条目留到真正结算
    // （见 `interactions` 的注释），否则「重连 → 切会话 → 切回来」这条路上卡片又会
    // 消失。服务端重连后重投递的 waterfall 会被去重记账幂等放行，不会重复弹卡片；
    // 回放本身也按 requestId 去重。
    for (const scope of this.scopes.values()) this.replayHeldToScope(scope.sessionId, scope);
    this.openControlStream();
    this.openEventsStream();
    this.openWorkspaceStream();
    // 顺便把 running 与会话列表对齐一次：掉线期间本轮可能已经收尾，而那段时间的状态位
    // 边缘（`api-session/status`）我们没收到；这也是「一切都从服务端重算」的一部分
    // （新的适配器认不出时会保留这里的结论，见 `applyFrame`）。
    await this.refreshSessions();
  }

  /**
   * 连接相关的整组字段（首帧快照与增量 patch **共用这一份**，两处各写一遍必然漂移）。
   *
   * 判定在 `connectionFieldsOf`（模块级纯函数）里一次做完：**管理器那一半读 `snapshot()`**
   * （外部地址、目标、后台在不在——控制器不再存镜像），**本窗口那一半读 `facts` 与
   * `round`**（两轴探测结论、客户端状态机）。这里只负责把三份输入摆好。
   */
  private connectionPatch(): ConnectionFields {
    return connectionFieldsOf({
      snapshot: this.server.snapshot(),
      facts: this.facts,
      round: {
        connection: this.connection,
        detail: this.connectionDetail,
        phase: this.connectPhase,
        target: this.target?.kind,
        needsToken: this.needsToken,
      },
      serverUrl: this.client?.baseUrl,
    });
  }

  private setConnection(state: "connecting" | "connected" | "disconnected" | "error" | "stopped", detail?: string): void {
    this.connection = state;
    this.connectionDetail = detail;
    // 连接状态是所有窗口共享的全局态
    this.emitConnection();
  }

  /** 把连接相关的字段整组推给所有窗口。 */
  private emitConnection(): void {
    this.emitAll({ type: "patch", patch: this.connectionPatch() });
  }

  /**
   * 两轴探测结论（内部在不在跑、外部可不可达）变了就推给界面。
   *
   * 按钮态的按钮集与那半句状态文案都靠它：内部在跑 → 「连接内部 DSH」，不在 → 「启动内部 DSH」。
   * **只在这里整份换掉 `facts`**（外部轴的 `unconfigured` 判定也由它出，见 `externalStateOf`）。
   */
  private setFacts(facts: TargetFacts): void {
    const changed =
      this.facts.internalRunning !== facts.internalRunning ||
      this.facts.externalConfigured !== facts.externalConfigured ||
      this.facts.externalReachable !== facts.externalReachable;
    this.facts = facts;
    if (changed) this.emitConnection();
  }

  /** 只更新内部轴（守护进程退场这类"确定"事件用，不必再探一次外部）。 */
  private setInternalRunning(running: boolean): void {
    if (this.facts.internalRunning === running) return;
    this.facts = { ...this.facts, internalRunning: running };
    this.emitConnection();
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
      // 判据是**当前目标**而不是"配没配 url"（2026-09-18 改）：新机制下配了 url 也
      // 可能正连内部（内部优先），那时凭据来自会合文件、根本没有"输入令牌"这回事，
      // 按 url 判会给外部用户的文案，把内部失败也说成"要令牌"。
      return this.target?.kind === "external" ? "@authNeedsToken" : "@authTokenRejected";
    }
    if (error instanceof DshApiError) return `${error.message}（${error.code}）`;
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 「重启内部 DSH」：请守护进程把 dsh 重起一个（详见 `SupervisorManager.restart`）。
   *
   * 只对**内部**目标有意义：外部那台服务器不归本扩展管，界面
   * （`internalRunning` 为假时不显示这枚按钮）与命令面板两道都拦在这里。
   */
  async restart(): Promise<void> {
    if (this.target?.kind === "external") {
      this.log("[server] 当前目标是外部 DSH，「重启内部 DSH」不适用");
      return;
    }
    this.target = { kind: "internal", mayStart: true };
    this.autoReconnect = true;
    this.retryable = true;
    this.connectPhase = "connecting";
    // 接入的是**别的窗口**拉起的后台时，「重启内部 DSH」会打断所有窗口（supervisor 杀 dsh
    // 再拉起一个，端口通常会变）——那是一次对所有人的中断，必须说出来，不能静默
    const wasPeer = this.server.snapshot().status.info?.ownership === "peer";
    this.log(wasPeer ? "[server] 重启（后台由别的窗口拉起，会打断所有窗口）" : "[server] 重启");
    this.teardownStreams();
    this.client?.dispose();
    this.client = undefined;
    try {
      // 显式传目标：manager 记的上一次目标可能是外部（用户正连着备用），不传的话
      // 「重启」会在那一侧变成静默空转（见 `SupervisorManager.restart`）
      await this.server.restart({ target: "internal" });
    } catch (error) {
      // 用户在"等新地址"期间按了「停止连接」/「停止服务器」：这是一条用户指令，不是重启失败
      if (error instanceof WaitCancelledError) {
        this.log("[server] 重启被用户中止（「停止连接」/「停止服务器」）");
        this.retryable = false;
        this.setConnection("stopped");
        return;
      }
      throw error;
    }
    // 「重启内部 DSH」是用户显式动作：允许拉起一套（关掉自动连接时也算数）
    await this.ensureConnected({ start: true, target: "internal" });
    if (wasPeer) {
      this.emitAll({ type: "toast", level: "warn", text: "@sharedRestarted" });
      return;
    }
    vscode.window.showInformationMessage(vscode.l10n.t("The DSH server has been restarted."));
  }

  /** 服务器状态变化时同步给界面。 */
  onServerStatus(status: ServerStatus): void {
    // **当前目标是外部时，管理器的内部那套状态一律不影响界面**（2026-09-19）：
    // 我们连的不是它。内部那套可能仍在跑（别的窗口在用），但它的换地址 / 退场与本窗口
    // 这条连接无关——从前这里会把界面从"连着外部"拉回按钮态或错误态，看起来就像
    // "切到外部之后还在跟内部守护进程打交道"。内部那一轴（按钮文案用）由 5 秒心跳的
    // 探测结论刷新，不靠这条推送（`detachInternal` 之后管理器还会报一次 stopped，
    // 那只是"我断开了"，不是"内部后台不在了"）。
    if (this.target?.kind === "external") return;
    if (status.state === "failed" && status.detail) {
      // 启动类失败（spawn 不起来、等不出可用状态）：**不自动重试**，退回按钮态 + 原因
      this.retryable = false;
      this.setConnection("error", status.detail);
      return;
    }
    // "还在等"的那一轮如果带着 `@` 详情（外部地址一次都没应答过），把它摆到连接条上：
    // **等到底**不比"到点报错"差，但用户得知道自己在等哪个地址、为什么连不上
    //（`@serverUnreachable`）。管理器的内部一轮用的是英文调试串（"starting server"），
    // 不带 `@`，照旧不往界面送。
    if (status.state === "starting" && status.detail?.startsWith("@")) {
      this.setConnection("connecting", status.detail);
      return;
    }
    // 「停止服务器」/ 守护进程自己退场：内部那套没了 → 左轴立刻变"未运行"、回到按钮态，
    // 而不是继续显示旧的就绪状态（那样用户会以为后台还在）
    if (status.state === "stopped") {
      this.setInternalRunning(false);
      this.retryable = false;
      this.setConnection("stopped");
    }
  }

  // ---------- 启动 / 连接（用户可控，2026-09-18 重写） ----------

  /**
   * 激活期的自动连接（`startup()` 调用）。
   *
   * `dshChat.autoConnect` 开着：**选一次路**——内部后台在跑就接内部；否则外部地址配了
   * 且此刻可达就连外部；两者都没有就拉起一套内部。选完**粘住**（见 `target` 字段），
   * 之后的重试永远只认这一个目标。
   *
   * 关着：**完全不自动连**——只刷新两轴探测结论，把界面切到按钮态等用户点
   * （用户 2026-09-18 口径：这是 `autoStart` 改名 `autoConnect` 后的新含义）。
   */
  async autoConnect(autoConnect: boolean): Promise<void> {
    this.autoReconnect = true;
    // 激活期的这一轮同样先收场（窗口重载后可能还挂着上一条连接）
    this.prepareRound();
    const facts = await this.probeFacts();
    this.setFacts(facts);
    if (!autoConnect) {
      this.target = undefined;
      this.retryable = false;
      this.log(`[connect] 已关闭自动连接（${describeFacts(facts)}）：只显示按钮，等用户点`);
      this.setConnection("stopped");
      return;
    }
    const plan = chooseTarget(facts);
    this.target = { kind: plan.target, mayStart: plan.start };
    this.retryable = true;
    this.connectPhase = plan.start ? "starting" : "connecting";
    this.log(`[connect] 自动选路（${describeFacts(facts)}）→ ${plan.target}${plan.start ? "（先拉起一套内部后台）" : ""}`);
    await this.ensureConnected({ start: plan.start, target: plan.target });
  }

  /**
   * 配置监听（`dshChat.autoConnect` 改动）用：**即时应用新值，不必重载窗口**
   * （用户 2026-09-19 口径：改 autoConnect 不该弹「重载窗口」，只有 `url` / `command` 要）。
   *
   * - **改开**（false → true）：更新自动路径许可；若当前正停在**按钮态且从没定过目标**
   *   （就是"关掉后只显示按钮"的那一档），立即按激活期那套**选一次路**连上——用户改完
   *   开关马上能看到效果。正在连接 / 已连上 / 用户点过按钮（有粘性目标）都不动：
   *   那些是既成事实，配置改动不该打断正在跑的会话，也不该替用户收回他显式停过的连接。
   * - **改关**（true → false）：只更新许可。已建立的连接不打断；之后的自动路径
   *   （心跳"自己拉一套"）按新许可走。
   */
  applyAutoConnect(value: boolean): void {
    this.server.setAutoConnect(value);
    if (!value) {
      this.log("[connect] dshChat.autoConnect 改为关：只影响之后的自动路径，现有连接不动");
      return;
    }
    if (this.connection === "stopped" || this.connection === "error") {
      if (!this.target) {
        this.log("[connect] dshChat.autoConnect 改为开：当前在按钮态，立即按自动选路连接");
        void this.autoConnect(true);
      } else {
        this.log("[connect] dshChat.autoConnect 改为开：已有粘性目标，保持现状");
      }
    } else {
      this.log("[connect] dshChat.autoConnect 改为开：正在连接/已连接，保持现状");
    }
  }

  /**
   * 「启动内部 DSH」：**用户显式要一套内部后台**（内部不在时按钮态里的主动作）。
   *
   * 与「连接内部 DSH」是**同一套逻辑**（都传 `mayStart: true`）：用户点哪一个，得到的都是
   * 「内部后台可用」这个结果。保留两个按钮是因为界面的两轴状态与后台的真实状态之间会有偏差
   * （守护进程刚退场、另一个窗口刚拉起）——显示「启动」时可能其实已经起来，显示「连接」时
   * 可能其实还没起。让它们语义相同，就不会出现「点对了按钮却什么都没发生」。
   *
   * 拉起这条路**不需要扩展额外发指令**：守护进程自己起来就 `bringUp()` 把 dsh 拉起
   * （`supervisor/main.ts`），扩展只要连上它的 socket 并等就绪（见 `bringUpWith`）。
   */
  async startInternal(): Promise<void> {
    this.beginConnect("internal", true, "starting");
    await this.ensureConnected({ start: true, target: "internal" });
  }

  /** 「连接内部 DSH」：有就接上、没有就起一套——与「启动内部 DSH」同一套逻辑（见上）。 */
  async connectInternal(): Promise<void> {
    this.beginConnect("internal", true, "connecting");
    await this.ensureConnected({ start: true, target: "internal" });
  }

  /**
   * 「连接外部 DSH」：去连 `dshChat.url`（备用地址）。
   *
   * 没配地址时界面把这枚按钮置灰，正常到不了这里；真到了（命令面板）就记一条日志、
   * 把界面留在按钮态——而不是随便找个别的东西连。
   */
  async connectExternal(): Promise<void> {
    if (this.server.externalUrl === undefined) {
      this.log("[connect] 没有配置 dshChat.url，「连接外部 DSH」无从连起");
      this.retryable = false;
      this.setConnection("stopped");
      return;
    }
    this.beginConnect("external", false, "connecting");
    await this.ensureConnected({ start: false, target: "external" });
  }

  /** 三个连接入口共用的开场：换粘性目标、重新打开自动重连、进入"连接中"。 */
  private beginConnect(kind: DshTarget, mayStart: boolean, phase: ConnectPhase): void {
    this.autoReconnect = true;
    this.retryable = true;
    this.target = { kind, mayStart };
    this.connectPhase = phase;
    // 换目标 = 上一条连接不再作数：**先收掉它**（含客户端自己的无限重连），
    // 否则旧客户端的回调会把界面拉回"连接中"（见 `prepareRound`）
    this.prepareRound();
    this.setConnection("connecting");
    // 立刻重探两轴，别让按钮态挂着上一轮的结论：`onServerStatus` 在目标为外部时不再改
    // 内部那一轴（那是另一套后台的事），等 5 秒心跳就会有一段"显示的是旧的"窗口
    // （2026-09-19：用户点的按钮正是按这两轴显示的，它得是此刻的事实）
    void this.refreshFacts();
  }

  /** 立刻重探两轴（内部守护进程在不在、外部地址可不可达），并把结论推给界面。 */
  private async refreshFacts(): Promise<void> {
    try {
      this.setFacts(await this.probeFacts());
    } catch (error) {
      this.log(`[connect] 两轴探测失败：${this.describeError(error)}`);
    }
  }

  /**
   * 「停止连接」：停掉**正在进行的连接**——中止在途那一轮、关掉自动重连，并且
   * **不再占用内部后台**（断开与守护进程的连接）。
   *
   * 触发条件绑的是**界面正在连接**（`connecting` / `disconnected` 都渲染成"正在连接…"）。
   * 连接条上它**是连接中唯一的按钮**（另一个是「查看日志」，用户 2026-09-18 口径）——
   * 连接没有总超时，能不能结束只由它说了算。
   *
   * 进程**一个字都不动**（dsh 的生死归守护进程，它按"还有几条活连接"自己裁决），但
   * **占用的那条连接要交还**（用户 2026-09-19 口径：不连就不占用）：留着它，守护进程
   * 就永远认为还有人用——内部 dsh 不会按空闲退场，而它的推送还能把界面从"已停止"拉回
   * "连接中/错误"。交还之后若没有别的窗口在连，后台在空闲阈值（默认 10 秒）后自己退场；
   * 别的窗口还在用就继续服务（那正是正确结果）。
   *
   * 代价说清楚：后台真退场之后，下一次发消息会走"拉起一套"（冷启动 5~8 秒）。
   *
   * 用户叫停**不挡住显式动作**：`userAskedToStop()` 对"用户自己发起的那一轮"放行
   * （发消息 /「启动内部 DSH」/「重启内部 DSH」），只有自动路径才该在叫停后放弃。
   */
  stopReconnect(): void {
    if (this.connection !== "connecting" && this.connection !== "disconnected") return;
    this.autoReconnect = false;
    this.retryable = false;
    this.log("[connect] 用户点了「停止连接」");
    // **真的停下来**：作废在途轮 + 中止管理器的等待 + dispose 客户端（连带停掉它自己的
    // 无限重连）。只改这两个布尔量是不够的——`DshClient` 断线后会自动重连，它的回调
    // 会把界面反复拉回"连接中"，用户看到的就是"点了停止还在连"（2026-09-19 实测）。
    this.prepareRound();
    // 交还内部后台的占用（断开与守护进程的连接，并挡住心跳的自动接回）。
    // 档位是 `release`（见 `prepareRound` 顶上那张表）：那一档做两件事——置 `detachedByUser`
    // 闸 + 收连接，缺任何一件都等于没做（只断不挡 → 5 秒后被接回；只挡不断 → 内部 dsh
    // 永不按空闲退场）。
    void this.server.stop({ release: true });
    // 切回按钮态：条上写的是两轴探测结论（"内部 DSH：… · 外部 DSH：…"），
    // 上一轮为什么没连上在日志里。**顺带重探一次两轴**：刚交还之后"内部还在不在"的
    // 结论已经变了（它可能马上就空闲退场），不能等 5 秒心跳
    void this.refreshFacts();
    this.setConnection("stopped");
  }

  /**
   * 「停止内部 DSH」（命令面板 `dshChat.stopServer`）：请守护进程连 dsh 一起收场并退出。
   *
   * 顺带**收掉本窗口与内部那套的连接**：只发停止请求、不收连接的话，客户端会在 dsh
   * 消失后一直重连、界面反复跳回"连接中"。后台的生死照旧归守护进程，这里只收自己的
   * 连接（`prepareRound` 不碰任何进程）。
   *
   * **当前目标是外部时例外**（2026-09-19）：这条命令停的是**内部**那套，与外部服务器
   * 无关——本窗口连着外部的那条连接（客户端 + 跟随流）一个字都不动，界面也不该被拉回
   * 按钮态。管理器会临时接入内部守护进程把请求发出去（`stopDetachedInternal`）。
   *
   * 返回"停止请求有没有真的发出去"：调用方据此给用户哪句回执（档位见 `prepareRound`
   * 顶上那张表——`askSupervisor` 是唯一会发控制帧的一档）。
   */
  async stopServer(): Promise<boolean> {
    if (this.target?.kind === "external") {
      this.log("[server] 当前目标是外部 DSH：「停止内部 DSH」只停内部后台，这条连接不动");
      return this.server.stop({ cancelWait: true, askSupervisor: true });
    }
    this.autoReconnect = false;
    this.retryable = false;
    this.prepareRound();
    this.setConnection("stopped");
    return this.server.stop({ cancelWait: true, askSupervisor: true });
  }

  // ---------- 会话 ----------

  /** 命令面板入口「DSH: 历史对话」：刷新列表并让**最近活动的窗口**切到历史抽屉。 */
  async openHistory(): Promise<void> {
    await this.refreshSessions();
    const target = this.activeViewId();
    if (target) this.emitToView(target, { type: "ui/openPanel", panel: "history" });
    else this.emitAll({ type: "ui/openPanel", panel: "history" });
  }

  /**
   * 历史会话列表 = **本窗口该看见的那些会话**。
   *
   * 用户 2026-09-15 的设计口径：
   *
   * 1. **打开了文件夹** → 跟随 VS Code，只显示**这个工作区**的会话（dsh web 可能
   *    为多个项目开过会话，跨项目混进来既占列表、又因 cwd 不匹配导致 resume 失败）；
   * 2. **没有打开文件夹** → 视作未分组，显示**未分组**里的会话（不属于任何服务端
   *    工作区注册记录的那些）。
   *
   * 判据按**服务端注册表**（`workspaces` 的 `sessionIds`）而不是自己比较 cwd：
   * `session/list` 不带 workspaceId，而分组本身就是注册表说了算（会话被
   * `session/create` 带 `workspaceId` 建出来时才记进某个工作区）。两条兜底：
   *
   * - 会话 cwd == 当前工作区路径：新会话的 `upsert` 增量可能比这次查询晚到，
   *   只看注册表会让「刚建好的会话」从列表里闪一下；
   * - **任何已打开域**的 cwd：工作区目录与历史会话目录的写法（大小写/分隔符）
   *   可能不一致，恢复窗口时不能因为这点差异把要接回的会话滤掉。
   */
  async refreshSessions(): Promise<void> {
    if (!this.client) return;
    try {
      const value = await this.client.listSessions();
      const folder = vscode.workspace.workspaceFolders?.[0];
      const workspacePath = folder ? normalizePath(folder.uri.fsPath) : undefined;
      // 服务端注册表：这条会话被记在哪个工作区里（同一会话只属于一个工作区）
      const grouped = new Set<string>();
      let ownIds: Set<string> | undefined;
      for (const row of this.workspaces) {
        for (const id of row.sessionIds) grouped.add(id);
        if (workspacePath !== undefined && normalizePath(row.path) === workspacePath) {
          ownIds = new Set(row.sessionIds);
        }
      }
      // 基准放宽到**任何打开的域**的 cwd（见 `visibleForWorkspace` 的注释）
      const openCwds: string[] = [];
      for (const scope of this.scopes.values()) {
        const cwd = normalizePath(this.sessions.find((s) => s.id === scope.sessionId)?.cwd);
        if (cwd) openCwds.push(cwd);
      }
      const views = visibleForWorkspace(
        visibleSessionRows(value.items ?? [])
          // 本地删过的会话若被当前 dsh 进程打开过，仍会留在服务端内存里被
          // session/list 列出——按持久化的删除集合过滤，保证界面干净
          .filter((item) => !this.deletedSessionIds.has(item.sessionId)),
        { workspacePath, workspaceSessionIds: ownIds, groupedSessionIds: grouped, openCwds },
      ).map((item) => this.toSessionView(item));
      // 分支不再缩进（用户 2026-09-19 口径：和普通会话同级，靠标题前缀「分支: 」区分），
      // 所以这里不再算血缘深度——那个字段的唯一用途就是缩进。
      this.sessions = views;
      this.emitSessionLists();
      // running 的**权威打底**：列表是服务端算的（`SessionSummary.running`），域存在时
      // 按它对齐——官方 `ui-session` 的 `reconcileStatus()` 是同一口径。适配器那一路只从
      // durable 轮次边界推导，窗口被截断 + 工具阶段时它**不发帧**（见适配器的注释），
      // 那个缺口就由这里与 `api-session/status` 中继补上。
      for (const scope of [...this.scopes.values()]) {
        const row = views.find((item) => item.id === scope.sessionId);
        if (!row) continue;
        if (!acceptSessionStatus(row.running, scope.adapter?.hasOpenTurn() === true)) continue;
        this.writeScopeRunning(scope, row.running);
      }
      // 会话列表是**标题的权威**（服务端 `session/list`）：恢复窗口时面板先绑上会话、
      // 这一份才到，标签要在这里补一次；删掉的会话也从标签上退掉
      for (const sessionId of new Set(this.viewSessions.values())) this.syncPanelTitle(sessionId);
    } catch (error) {
      this.log(`[sessions] 列表获取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 会话状态位中继（`api-session/status`，`args = [sessionId, running]`）。
   *
   * 官方前端就靠这条维护 running（`ui-session` 的 `observeRunning`），官方 session 层
   * 还把它同步进会话列表的行（`manager.ts` 的 `handleSessionStatus`）——本扩展此前把
   * 这条帧当"不认识的配置事件"丢掉，于是 running 只剩日志边缘一条来源，而那条路在
   * 「窗口截断 + 服务端没有活跃 attempt」时给不出结论（见 `dsh/sessionStatus.ts` 的文件头）。
   *
   * @returns 这条帧认不认。认得就由这里消费掉，不再交给配置变更路由（它不是配置）。
   */
  private applySessionStatus(event: string, args: readonly unknown[]): boolean {
    if (event !== "api-session/status") return false;
    const status = decodeSessionStatus(args);
    if (status === undefined) {
      // 认得但形状不对：记一行日志（服务端换了口径时这是唯一的线索），当无事发生。
      // **不**退化成 false——那就是又一次「不知道说成没在跑」。
      this.log(`[status] api-session/status 参数形状不认识：${JSON.stringify(args)}`);
      return true;
    }
    const scope = this.scopes.get(status.sessionId);
    if (!acceptSessionStatus(status.running, scope?.adapter?.hasOpenTurn() === true)) return true;
    // 列表那一行是**新域的打底值**（见 `ensureScope`），必须与域同一个口径：列表里的
    // 「运行中」标记也靠它，不然用户切走再切回来会拿到一个过期的值。
    this.setSessionRowRunning(status.sessionId, status.running);
    if (scope) this.writeScopeRunning(scope, status.running);
    return true;
  }

  /** 写域里的 running（`scope.running` 是权威副本，界面读的首帧快照/ESC 也都看它）。 */
  private writeScopeRunning(scope: SessionScope, running: boolean): void {
    if (scope.running === running) return;
    scope.running = running;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["running"]),
    });
  }

  /** 会话列表某一行的 running（找不到那一行就不管：它不在本窗口的可见集合里）。 */
  private setSessionRowRunning(sessionId: string, running: boolean): void {
    const row = this.sessions.find((item) => item.id === sessionId);
    if (!row || row.running === running) return;
    this.sessions = this.sessions.map((item) => (item.id === sessionId ? { ...item, running } : item));
    this.emitSessionLists();
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
    // **会话 id 必须是一个纯目录名**：它来自服务端列表（`dshChat.url` 指向别人
    // 的服务器时那份列表是对方给的），而下面要拿它拼路径去 `rmSync(recursive)`。
    // 不拦的话 `..\..\..\Desktop` 这种 id 会删掉会话根目录之外的任意目录
    // （`findSessionDir` 的 containment 是第二道，这里是不该让脏 id 走到那里的第一道）。
    if (!isSafeSessionId(sessionId)) {
      this.log(`[sessions] 拒绝删除：会话 id 不是安全目录名（${sessionId}）`);
      this.reportError(vscode.l10n.t("Failed to delete the session"), new Error("unsafe session id"));
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
    if (!isSafeSessionId(sessionId)) return undefined;
    const root = join(homedir(), ".dsh", "sessions");
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return undefined;
    }
    const rootResolved = resolve(root);
    for (const entry of entries) {
      const candidate = resolve(root, entry, sessionId);
      // 第二道：拼出来的路径必须**真的在会话根目录里面**（`..`、绝对路径、
      // Windows 的盘符跳转都靠这一条兜住）。宁可删不掉，也不删错地方。
      if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) continue;
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
      // 用户显式动作（点「新建对话」）：允许拉起后台
      await this.ensureConnected({ start: true });
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
    // 用户显式动作（点历史里的一条）：允许拉起后台
    if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: true });
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
   * 的 baseline、预取命令目录。
   *
   * 挂起的审批/提问**不在这里回放**（见 `bindViewToSession`）：域建成的这一刻
   * 还没有窗口绑上来，投递出去也没人收。
   */
  private ensureScope(sessionId: string): SessionScope | undefined {
    const existing = this.scopes.get(sessionId);
    if (existing) return existing;
    if (!this.client) return undefined;
    const scope = new SessionScope(sessionId);
    // **running 打底**：会话列表带服务端的权威值（`SessionSummary.running`），新域先按它
    // 起步——官方客户端的 Session 实例同样在建立时用列表摘要喂一次
    // （`manager.ts` 的 `session.handleRunning(summary.running)`，「列表先到」时保持一致）。
    // 这一步不能省：适配器重建后那份快照在「窗口被截断 + 没有活跃 attempt」时**不发**
    // running 帧（见 `applyFrame`），没有打底的话域会停在 `false` 上——明明在生成却给
    // 出发送按钮，消息被按 queue 发出去排进队列（用户 2026-09-22 报的现场）。
    const row = this.sessions.find((item) => item.id === sessionId);
    if (row) scope.running = row.running;
    this.scopes.set(sessionId, scope);
    this.openScopeFollow(scope);
    // 重开控制流拿新会话的 baseline（队列/任务/投影）：baseline 是全量集合，
    // 多取一次是幂等的
    this.openControlStream();
    // 命令目录随会话预取：手打的 `/xxx` 要靠它才能被路由到命令通道，
    // 不能等输入 `/` 弹出候选时才拉（粘贴一行后立刻回车就赶不上了）
    void this.listCommandsFor(scope);
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
    // 未知事件（内核冒出的新词汇）记进输出通道：界面上那条提示条一闪而过，
    // 日志是唯一能回看的落点。带会话 id——多会话并存时要知道是哪个会话冒出来的。
    adapter.log = (line) => this.log(`[event] 会话=${sessionId} ${line}`);
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
        // **顺序在 `replayFollowSnapshot` 里**：先让适配器回放历史记录，再铺开投影值。
        // 投影是「截至 asOfSeq 的折叠结果」，永远比记录里的事件新；反过来先铺投影再回放，
        // 历史里最后一个事件会把折叠值**覆盖回旧状态**——`plan` 就是活例（见
        // `docs/audit-summary.md` 的「快照回放会覆盖投影折叠值」）。这条顺序以前只能靠
        // 正则去比两个 `indexOf` 的大小，现在是一个可以被直接调用的函数。
        replayFollowSnapshot(value as SessionFollowFrame, adapter, (block) => {
          ingestFollowSnapshot(this.projectionHandlers, scope, block);
        });
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
   * 失败时不抛：一张图取不到不该影响整条消息的渲染，**该位留空串**（不是过滤掉——
   * 用户消息的附件按位对齐，见 `SessionAdapter.loadImages` 的契约）。
   */
  private async loadAttachmentImages(
    sessionId: string,
    refs: ImageRef[],
    done: (dataUrls: string[]) => void,
  ): Promise<void> {
    if (!this.client) {
      done(refs.map(() => ""));
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
    done(results);
  }

  /**
   * 加载更早的历史（`session/page`）——**两档语义**（与官方同构，判据见
   * `dsh/historyPaging.ts`）：
   *
   * - 不带 `targetSeq`（**单页档**，对应官方 `ISession.loadOlder()`）：取一页就停。
   *   会话页与轨迹视图的「加载更早」按钮走这一档；
   * - 带 `targetSeq`（**到目标档**，对应官方 `ISession.loadThrough(seq)`）：一页一页
   *   往前取，直到窗口最早的事件覆盖该 seq 为止。右侧轮次横条上「未加载」的刻点走
   *   这一档——点它先把那段历史取回来，锚点行渲染出来后再落位
   *   （见 `webview/turnRailNav.ts` 的 pendingJump）。
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
   * 「正在加载更早的历史…」，也据它判断一页是否落定。发帧顺序必须是
   * `true` →（结算：hasMoreHistory / messages/reset）→ `false`：界面先拿到内容，
   * 再看到「取完了」。所以结算放在 `finally` 里、发 `false` 之前。
   *
   * **生成中也能取**（与官方 Web 端一致：它的「加载更早」只在取的那一下禁用，不看
   * running）。代价只有一次重折——在飞的流式正文/思考与运行中的工具行会在重折前后被
   * 抄送一次，不会塌掉也不会消失（见 `SessionAdapter` 的 `CarriedLiveOverlay`）。
   */
  private async loadMore(viewId: string, targetSeq?: number): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!this.client || !scope || !scope.adapter) return;
    // 一次只跑一条链：滚动式连点与横条连点都会在「historyLoading 帧回到界面」之前
    // 连发好几个请求
    if (scope.historyLoading) return;
    scope.historyLoading = true;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["historyLoading"]),
    });
    try {
      await this.pageBackwards(scope, targetSeq);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to load earlier history"), error);
    } finally {
      // 先结算再报「取完了」：已吸收的页（哪怕中途客户端抛错、或新一轮抢先生成）
      // 必须显示出来，帧序才是「先内容、后取完」
      scope.adapter?.settleHistory();
      scope.historyLoading = false;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["historyLoading"]),
      });
    }
  }

  /**
   * 一页一页往前取。**单页档取一页就停；到目标档取到窗口覆盖目标 seq 为止**
   * （官方 `loadOlder` / `loadThrough` 两条入口，停止条件见 `dsh/historyPaging.ts`）。
   *
   * 每页只**吸收**不结算（见 `SessionAdapter.absorbRecords`）：重折与整份
   * `messages/reset` 由调用方在 `finally` 里做一次。逐页结算的话，一次跨轮跳转
   * （可能连取十几页）就是十几次全量重折 + 十几次全量重渲染——消息列表没有虚拟
   * 滚动，那个代价会直接吃掉跨轮跳转的可用性。
   */
  private async pageBackwards(scope: SessionScope, targetSeq?: number): Promise<void> {
    let pages = 0;
    for (;;) {
      const throughSeq = scope.adapter?.cursor();
      const beforeSeq = scope.adapter?.earliestSeq();
      if (!scope.adapter || throughSeq === undefined || beforeSeq === undefined) {
        this.log("[history] 拿不到分页锚点（缺 snapshot.cursor 或本地无事件）");
        return;
      }
      const page = await this.client!.page(scope.sessionId, throughSeq, beforeSeq);
      const added = scope.adapter.absorbRecords(
        (page.records ?? []) as never[],
        Boolean(page.hasMore),
      );
      pages += 1;
      // 目标档的「覆盖」判据要在**吸收之后**取：earliest 正是这一步被推小的
      const target =
        targetSeq === undefined
          ? undefined
          : { seq: targetSeq, earliest: scope.adapter.earliestSeq() ?? beforeSeq };
      if (shouldContinuePaging(added, Boolean(page.hasMore), pages, target)) {
        continue;
      }
      this.log(
        `[history] ${targetSeq === undefined ? "单页档" : `到目标档 seq=${targetSeq}`}共取 ` +
          `${pages} 页停：本页新并入 ${added} 条事件、hasMore=${Boolean(page.hasMore)}、` +
          `消息 ${scope.adapter.snapshotMessages().length} 条`,
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
    // 连接收掉了，旧的去重记账不作数；**未结算的审批 / 提问照旧留着**（见 `interactions`）
    this.interactions.resetDedupe();
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
        onItem: (value) => this.onWorkspaceFrame(value as WorkspaceFollowFrameWire),
      },
    );
  }

  /**
   * 工作区状态流承载两样东西，都是历史列表的权威判据：
   *
   * 1. **工作区注册表**（baseline 的 `items` + `upsert` / `remove` 增量）：每条
   *    记录带 `sessionIds`，是「这条会话属于哪个工作区」的唯一来源（`session/list`
   *    不带 workspaceId，见 `workspaces` 字段的注释）；不在任何工作区里的会话就是
   *    「未分组」。
   * 2. **已归档会话集合**：每代以一个 `baseline` 开场，其后是 `archived` 增量
   *    （每次都是**完整集合**）。`session/list` 不分归档与否，归档过滤在客户端做。
   */
  private onWorkspaceFrame(frame: WorkspaceFollowFrameWire): void {
    // 先消化注册表增量：`upsert` 换一条记录、`remove` 去掉一条、`order` 只影响
    // 顺序（界面上不展示工作区本身，忽略）。`items` 是完整集合，直接替换。
    let workspacesChanged = false;
    if (frame?.type === "baseline") {
      this.workspaces = workspaceRows(frame.value?.items);
      workspacesChanged = true;
    } else if (frame?.type === "upsert" && frame.workspace) {
      const row = workspaceRow(frame.workspace);
      if (row) {
        const index = this.workspaces.findIndex((item) => item.workspaceId === row.workspaceId);
        if (index >= 0) this.workspaces[index] = row;
        else this.workspaces.push(row);
        workspacesChanged = true;
      }
    } else if (frame?.type === "remove" && frame.workspaceId) {
      const before = this.workspaces.length;
      this.workspaces = this.workspaces.filter((item) => item.workspaceId !== frame.workspaceId);
      workspacesChanged = this.workspaces.length !== before;
    }

    let archivedChanged = false;
    const next = frame?.type === "baseline" ? frame.value?.archivedSessionIds : frame?.type === "archived" ? frame.archivedSessionIds : undefined;
    if (Array.isArray(next)) {
      const nextSet = new Set(next);
      archivedChanged = nextSet.size !== this.archivedSessionIds.size;
      if (!archivedChanged) {
        for (const id of nextSet) {
          if (!this.archivedSessionIds.has(id)) {
            archivedChanged = true;
            break;
          }
        }
      }
      if (archivedChanged) this.archivedSessionIds = nextSet;
    }

    if (!workspacesChanged && !archivedChanged) return;
    // 注册表变了**整份重算**：新会话被记进工作区（或工作区被删）会直接改变
    // 「这条会话该不该出现在这个工作区的历史列表里」，光重发旧列表是不够的。
    if (workspacesChanged) void this.refreshSessions();
    else this.emitSessionLists();
  }

  /**
   * 控制流承载队列、后台任务与**投影**。
   *
   * 投影是会话整体状态的折叠值（模型选择、权限预设、待办、计划模式、标题…），
   * 比客户端自己重放日志省事得多。每次重连以一个 `baseline` 开场，其后是逐条
   * `projection` 增量。
   *
   * **队列有两条通道，都认**（2026-09-18）：
   * - `inbox` 投影（当前服务端）：baseline 的 `projections[sid].values.inbox`
   *   与 `{type:'projection', key:'inbox'}` 增量，走 `applyProjection` 的
   *   `case "inbox"`；
   * - `queues` / `queue` 帧（2026-09-09 之前的服务端，提交 `72f2e71070` 删掉了它）：
   *   baseline 的 `value.queues[sid]` 与 `{type:'queue', items}`，走下面两个
   *   兼容分支与 `queueItemsFromWire`。
   *
   * 两条通道**各自只出现在对应版本上**，所以不需要探测版本；过渡版同时出现时两者
   * 同源同值（旧帧当年就是由 `inbox` 投影派生的），因此「后到者覆盖」是安全的。
   * baseline 里先套 `queues` 再套 `projections`：同时有两份时让新通道权威。
   */
  private onControlFrame(frame: SessionControlFrame): void {
    if (!frame || typeof frame !== "object") return;

    if (frame.type === "baseline") {
      const value = (frame as { value?: { queues?: Record<string, unknown[]>; jobs?: Record<string, unknown[]>; projections?: Record<string, ProjectionBlockWire> } }).value;
      if (!value) return;
      // baseline 是**全量**集合（按会话分键）：逐个套用到已打开的域上。
      // 没打开的会话不建域——它们的状态等窗口打开时由新 snapshot/baseline 重建。
      // 顺序有意为之：旧的 `queues` 在前、新的投影在后（同值时新通道胜）。
      for (const [sessionId, queue] of Object.entries(value.queues ?? {})) {
        const scope = this.scopes.get(sessionId);
        if (scope) this.syncQueue(scope, queueItemsFromWire(queue, (rpcId) => this.originFor(rpcId)));
      }
      for (const [sessionId, block] of Object.entries(value.projections ?? {})) {
        const scope = this.scopes.get(sessionId);
        // 替换型 baseline：内部是 `truncate(asOfSeq)` + `seed({asOfSeq, values})`，
        // 块里没带、且不新于该截止水位的键**清掉**（官方 ProjectionValueStore 的口径）。
        if (scope) ingestControlBaseline(this.projectionHandlers, scope, block);
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
      // 兼容 2026-09-09 之前的服务端：那条通道已被 `inbox` 投影取代。
      this.syncQueue(scope, queueItemsFromWire(frame.items, (rpcId) => this.originFor(rpcId)));
      return;
    }

    if (frame.type === "jobs") {
      this.applyJobs(scope, frame.jobs);
      return;
    }

    if (frame.type === "projection") {
      // `frame.seq` 是官方投影单元送出这个值时的水位（`protocol.ts` 的
      // `SessionControlFrame.seq`）：契约要求「lower-or-equal seq loses」，重放的旧帧
      // 不能把新值顶回去——跟着流与控制流分居两条 socket，重连后这种交错是真的。
      ingestProjection(this.projectionHandlers, scope, String(frame.key ?? ""), frame.value, frame.seq);
    }
  }

  /**
   * 队列（两条通道的任一条）→ 界面状态：同时重建「队列项 id → 原始输入 /
   * 可重发内容」的索引，供「重新编辑」与「ESC 中止并把队首发出去」使用。
   *
   * 传进来的是**已折好的条目**（`queueItemsFromInbox` / `queueItemsFromWire`）——
   * 两条通道在这里合流，下游只认一个视图模型。
   */
  private syncQueue(scope: SessionScope, entries: QueuedItemEntry[]): void {
    scope.queueOrigin.clear();
    for (const entry of entries) {
      scope.queueOrigin.set(entry.view.id, {
        text: entry.view.text,
        attachments: this.originFor(entry.view.rpcId)?.attachments ?? [],
        content: entry.content,
      });
    }
    scope.queueItems = entries.map((entry) => entry.view);
    // patch 的字段名与折返口径与首帧快照**同一张字段表**（`dsh/sessionView.ts`）
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["queueItems"]),
    });
  }

  // ---------- 投影摄入：一个键一条登记 ----------

  /**
   * 投影键 → 效果。**加一个投影键就在这里加一条**。
   *
   * `ProjectionHandlers` 是映射类型（`dsh/projectionIngest.ts`），少一个键**编译不过**——
   * 这就是「一个键一条」的强制手段：改造前这里是一个 226 行的 switch，同时干三件事
   * （解析线格式、判新旧、写状态+发帧），而形状解析那半没有任何测试接缝（`scripts/`
   * 里没有文件 import 本文件）。
   *
   * 现在三件事各有归属：形状解析在 `projections.ts` 的读取表（纯函数、契约驱动、
   * 离线可断言），新旧与清空在 `ProjectionStore`（`dsh/projectionStore.ts`），
   * 这里只回答「这个键的值——或者它的缺失——对界面意味着什么」。
   *
   * `present === false` 表示这个键此刻不在 store 里（能力缺失，或被替换型 baseline 清掉）。
   * 每个键对「没有值」的处置不同，所以它必须单独传进来：
   * - 清空视图：`permissions` / `plan` / `todos` / `tokenUsage` / `turnOutline` /
   *   `contextBreakdown` / `sessionStats` / `goal` / `subagentCatalog` / `imageLimits`；
   * - **保留旧值**：`contextPressure`（占用条按用户口径常驻，拿不到就保留旧值）；
   * - **什么都不做**：`title`（历史抽屉那一行有自己的标题兜着）。
   */
  private readonly projectionHandlers: ProjectionHandlers = {
    inbox: (scope, value) => this.applyInboxProjection(scope, value),
    modelSelection: (scope, value, present) => this.applyModelSelectionProjection(scope, value, present),
    permissions: (scope, value, present) => this.applyPermissionProjection(scope, value, present),
    plan: (scope, value, present) => this.applyPlanProjection(scope, value, present),
    todos: (scope, value) => this.applyTodosProjection(scope, value),
    contextPressure: (scope, value, present) => this.applyContextPressureProjection(scope, value, present),
    tokenUsage: (scope, value, present) => this.applyTokenUsageProjection(scope, value, present),
    turnOutline: (scope, value, present) => this.applyTurnOutlineProjection(scope, value, present),
    imageLimits: (scope, value, present) => this.applyImageLimitsProjection(scope, value, present),
    title: (scope, value) => this.applyTitleProjection(scope, value),
    contextBreakdown: (scope, value, present) => this.applyContextBreakdownProjection(scope, value, present),
    sessionStats: (scope, value, present) => this.applySessionStatsProjection(scope, value, present),
    subagentCatalog: (scope, value, present) => this.applySubagentCatalogProjection(scope, value, present),
    goal: (scope, value, present) => this.applyGoalProjection(scope, value, present),
  };

  /**
   * 队列的权威来源（当前服务端）：`{'next-turn':…,'next-step':…}`。
   *
   * 三个入口都可能走到这里——控制流 baseline 的投影、`projection` 增量帧、以及跟随开帧
   * 的 `projections`（重开会话时重建）。折算要查「这一项是谁提交的」（`submissions` 索引，
   * 供「重新编辑」与 ESC 重发用），那是控制器知识，所以解码留在效果这一半。
   */
  private applyInboxProjection(scope: SessionScope, value: unknown): void {
    this.syncQueue(scope, queueItemsFromInbox(value, (rpcId) => this.originFor(rpcId)));
  }

  /**
   * `modelSelection` 投影 → 模型胶囊。
   *
   * 生效值是 `next ?? lastUsed`（`next` 是「下一轮生效」的待提交值），解析见
   * `projections.modelSelectionFromProjection`。**目录查找与「没有选择时退回部署默认」
   * 留在这里**：id → 展示名/上下文窗口/是否收图要模型目录，退回默认要设置命名空间、
   * 还可能发一次异步请求——都不是形状问题。
   *
   * 没有选择（新会话的投影就是 `{lastUsed:null,next:null}`）与键不存在走同一条路：
   * 部署默认就绪就直接套用，否则异步读一次。
   */
  private applyModelSelectionProjection(
    scope: SessionScope,
    value: ModelSelectionDecoded | undefined,
    present: boolean,
  ): void {
    if (!present || !value) {
      if (this.defaultModel) {
        scope.model = this.defaultModel;
        this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["model"]),
    });
      } else {
        void this.loadDefaultModel();
      }
      return;
    }
    const group = this.models.find((g) => g.id === value.provider);
    const model = group?.models.find((m) => m.id === value.model);
    scope.model = {
      provider: value.provider,
      model: value.model,
      label: model?.name ?? value.model,
      reasoningEffort: value.reasoningEffort || undefined,
      efforts: model?.efforts,
      contextWindow: model?.contextWindow ?? scope.model?.contextWindow,
      acceptsImage: this.acceptsImageFor(value.provider, value.model),
    };
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["model"]),
    });
  }

  /**
   * `{options:[{value,name}], currentValue}`：初始化权限胶囊。
   *
   * 只读 `currentValue`——`options` 至今没有消费点（界面读的是 `scope.permission`），
   * 解析一份没人用的目录只会攒出「解析了但没人用」的死代码。
   * 键不存在时清空：能力缺失，界面不该继续显示上一次的预设。
   */
  private applyPermissionProjection(scope: SessionScope, value: string | undefined, present: boolean): void {
    const next = present ? value : undefined;
    if (scope.permission === next) return;
    scope.permission = next;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["permission"]),
    });
  }

  /**
   * 生效状态是 `pending ? !active : active`，不是裸 `active`：轮次进行中发出的 `/plan`
   * 只会把选择挂起（`active` 仍为 false），只读 active 会让「进入计划模式」看起来没反应
   * （见 `projections.planModeFromProjection`）。键不存在 = 不在计划模式。
   */
  private applyPlanProjection(scope: SessionScope, value: boolean, present: boolean): void {
    const active = present ? value : false;
    scope.planMode = active;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["planMode"]),
    });
  }

  /** 待办清单。`todos` 在 `ChatState` 里是必填数组，所以「没有值」就是空表。 */
  private applyTodosProjection(scope: SessionScope, value: TodoView[]): void {
    scope.todos = value;
    this.deliver(scope.sessionId, { type: "todos", todos: scope.todos });
  }

  /**
   * 占用条的权威来源（官方 `ContextPressureProjection`）：`usedTokens = projectedTokens ??
   * pressureTokens`，分子**不含 output**，且 `projectedTokens` 会跟着压缩下降
   * （见 `adapter.refreshOccupancy`）。
   *
   * 同时把 `contextWindow` 同步到模型胶囊：官方把「最新请求的压力」与「最新已知的路由容量」
   * 放在**同一个投影**里（两个槽各自 last-wins，刻意不保证是一次请求的原子观测），
   * 所以两件事一起处理。
   *
   * 键不存在时**什么都不做**：占用条按用户口径常驻显示，三个来源都拿不到时保留旧值。
   */
  private applyContextPressureProjection(
    scope: SessionScope,
    value: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number },
    present: boolean,
  ): void {
    if (!present) return;
    scope.adapter?.applyContextPressure(value);
    const contextWindow = value.contextWindow;
    if (contextWindow !== undefined && contextWindow > 0 && scope.model) {
      scope.model = { ...scope.model, contextWindow };
      this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["model"]),
    });
    }
  }

  /**
   * 全日志累计的四桶用量（互不重叠：reasoning 已含在 outputTokens 里）。界面用它显示
   * 「这次会话一共花了多少」，与占用条（prompt 侧）不是一回事。
   *
   * 键不存在时要清空而不是发四个 0：读取器对**坏值**给 0（那是它的容忍度），
   * 「用量未知」与「用量为零」在界面上是两件事——`present` 就是为这个区分而传的。
   */
  private applyTokenUsageProjection(
    scope: SessionScope,
    value: NonNullable<ChatState["tokenUsage"]>,
    present: boolean,
  ): void {
    scope.tokenUsage = present ? value : undefined;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["tokenUsage"]),
    });
  }

  /** 轮次横条的数据源（形状与容忍度见 `projections.turnOutlineFromProjection`）。 */
  private applyTurnOutlineProjection(
    scope: SessionScope,
    value: NonNullable<ChatState["turnOutline"]>,
    present: boolean,
  ): void {
    scope.turnOutline = present ? value : undefined;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["turnOutline"]),
    });
  }

  /**
   * 图片准入上限（发送前拦截超限的图，而不是等服务端拒绝）。
   *
   * **不下发给界面**：只有宿主消费它（`attachments.classifyPath` 的内联上限），
   * 这条与改造前一致。
   */
  private applyImageLimitsProjection(
    scope: SessionScope,
    value: NonNullable<ChatState["imageLimits"]>,
    present: boolean,
  ): void {
    scope.imageLimits = present ? value : undefined;
  }

  /**
   * 会话标题（`session/title` 事件是另一条路，见适配器）。
   *
   * 键不存在时**什么都不做**：历史抽屉那一行有自己的标题（来自 `session/list`，契约里
   * 明说那可能是陈旧提示），由它兜着；把标题清成空串反而会把抽屉抹掉。
   */
  private applyTitleProjection(scope: SessionScope, value: string | undefined): void {
    if (!value) return;
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

  /** 上下文构成（启发式估算；三个字段全有或全无，见 `projections.contextBreakdownFromProjection`）。 */
  private applyContextBreakdownProjection(
    scope: SessionScope,
    value: NonNullable<ChatState["contextBreakdown"]> | undefined,
    present: boolean,
  ): void {
    scope.contextBreakdown = present ? value : undefined;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["contextBreakdown"]),
    });
  }

  /** 全日志墙钟统计（`llmMs` / `toolMs` 是承重字段，见 `projections.sessionStatsFromProjection`）。 */
  private applySessionStatsProjection(
    scope: SessionScope,
    value: NonNullable<ChatState["sessionStats"]> | undefined,
    present: boolean,
  ): void {
    scope.sessionStats = present ? value : undefined;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["sessionStats"]),
    });
  }

  /**
   * 子代理目录。
   *
   * 投影里已经带着目录，界面无需再单独请求一次。投影**没有** `kind`/`activity`
   * （那两个字段属于 `subagents/list` RPC 行），所以形状解析在 `projections.ts`，
   * 与已知 RPC 列表的合并（保留 `activity`）在这里——投影不与 RPC 争这个字段。
   * 键不存在 → 空目录。
   */
  private applySubagentCatalogProjection(
    scope: SessionScope,
    value: SubagentCatalogEntryView[],
    present: boolean,
  ): void {
    // 名字与界面状态字段逐字相同（`subagentEntries`，见 shared/chat.ts 与
    // dsh/sessionView.ts）：不再有「宿主一个名、界面另一个名」的跨名桥
    scope.subagentEntries = present ? mergeSubagentActivity(value, scope.subagentEntries) : [];
    this.deliver(scope.sessionId, {
      type: "subagents/list",
      entries: scope.subagentEntries,
      parentAvailable: scope.subagentEntries.length > 0,
    });
  }

  /**
   * 目标条。投影是**嵌套**的、轮次计数在外层（见 `projections.goalFromProjection`）。
   * 以前按扁平形状读，两个字段都取不到，于是 goal 恒被清空、目标条从未渲染
   * （`docs/audit-summary.md` §3）。键不存在 → 清空目标条。
   */
  private applyGoalProjection(scope: SessionScope, value: GoalView | undefined, present: boolean): void {
    scope.goal = present ? value : undefined;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["goal"]),
    });
  }

  /**
   * 后台任务帧 → 界面状态。
   *
   * **只投递一条**：以前这里连着发两条（`jobs/list` 与 `patch.jobs`），同一次刷新的
   * 同一份数据走了两条路，而面板的键集合在 `snapshotFor` / 切会话帧 / 历史 patch
   * 那几条路上**各写一份**——多投的那条不会带来任何新信息（界面侧 `jobs/list` 与
   * `patch.jobs` 落到同一个状态字段），却会让面板按两条帧各渲染一次（闪一下）。
   * 留着 `patch` 那条：它与其它会话字段（队列、目标、模型……）走**同一个字段表**
   * （`dsh/sessionView.ts`），字段名与 `undefined → null` 的折返不再有第二处实现。
   * （`jobs/list` 帧本身没删：面板打开时按需请求的那条路 `case "listJobs"` 仍然发它，
   * 删掉的只是同一次刷新里的第二次投递。）
   */
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
      // 状态**原样保留**（含服务端将来新增的取值）：以前这里把词表外的状态兜底成
      // `"completed"`，等于对未知状态给出「已完成」这个肯定结论——正是 AGENTS.md
      // 禁止的「按否定证据下结论」。界面按查表渲染，查不到就原样显示、不猜色调。
      return {
        id: item.id,
        kind: item.kind ?? "job",
        label: item.label ?? item.id,
        status: typeof item.status === "string" && item.status ? item.status : "unknown",
        detail: item.detail,
        startedAt: item.startedAt ?? Date.now(),
        finishedAt: item.finishedAt,
      };
    });
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["jobs"]),
    });
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
      // `api-session/status` 是**会话状态位**（args = `[sessionId, running]`），不是配置
      // 变更，所以在交给配置路由之前先接住——此前它落进 `ConfigChangeRouter` 的 default
      // 被静默丢掉，而官方前端正是靠这条中继维护 running（见 `dsh/sessionStatus.ts`）。
      if (this.applySessionStatus(frame.event, frame.args ?? [])) return;
      this.configChanges.handle(frame.event, frame.args ?? []);
      return;
    }
    if (frame.type === "cancel") {
      // **Host 撤回了这次 waterfall**（网关 `finishRemoteEvent`）：另一个客户端
      // 答了、轮次被中止、或 Agent Context 释放。这是「这次询问已经不需要本窗口
      // 回答了」的权威信号——收到它**什么都不要回**（回了等于放行），只把本窗口
      // 那张卡收场（用户 2026-09-15：多窗口同时开着，一个窗口答了问卷，别的窗口
      // 还在继续生成，问卷却一直停在页面上）。
      //
      // 「撤回」= 一次结算，走账本的 `withdraw`：账上有这条就把原始请求拿回来
      // （会话 id 在记录里）→ 收场那张卡；账上没有（请求压根没投递到任何域，或
      // 本窗口早结算过）就什么都不做——它已经不需要人回答了，留着只会在用户下次
      // 打开这个会话时凭空弹一张过期的卡。
      const withdrawn = this.interactions.withdraw(frame.eventId);
      if (withdrawn) {
        this.log(
          `[$events] 未结算的${withdrawn.kind === "approval" ? "审批" : "提问"}被 Host 撤回：${frame.eventId}`,
        );
        this.scopes.get(withdrawn.sessionId)?.adapter?.cancelEvent(frame.eventId);
      }
      return;
    }
    if (frame.type !== "waterfall") return;
    const waterfall = frame as RemoteEventWaterfall;
    if (this.interactions.hasSeen(waterfall.eventId)) {
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
      // 先记成「未结算」再投递，而且**一直留到结算**（本窗口答复 / Host 撤回），
      // 不是投递出去就删。这是用户 2026-09-15 现场的根因：卡片已经在一个窗口上
      // 显示着，用户切去看别的会话 → `bindViewToSession` 把上一个会话的域回收掉
      // （`dropViewers` → `destroyScope`，适配器一起丢），这条请求就只剩下在被回收的
      // 适配器里。切回来时域是新建的、卡片没了，而审批/提问**不是 durable 事件**
      // （会话日志里没有它们），重放不回 —— agent 永久卡在 ask 节点，只能中断重问。
      // 账本与去重记账都在 `PendingInteractions` 里（见它的文件头）。
      const held = {
        eventId: waterfall.eventId,
        kind: waterfall.event === "approval/request" ? ("approval" as const) : ("question" as const),
        sessionId,
        request: waterfall.request,
      };
      this.interactions.hold(held);
      // 有域就先投进适配器（卡片立刻显示）；没域就只挂着——**不能回**：
      // 回了等于放行，请求就丢了。回放由 `bindViewToSession` 负责。
      if (scope) this.deliverEventToScope(held, scope);
      // 这条日志是给「问卷丢了」这类现场留证据的：四种到达（首次投递 / 重连重投递 /
      // 窗口重载后重投递 / 另一窗口绑上时的回放）都会在输出通道留一行，能一眼看出
      // 请求到底有没有回到宿主（用户 2026-09-15 / 09-16 两次报的都是这条链路）
      this.log(
        `[$events] 收到${held.kind === "approval" ? "审批" : "提问"} ${waterfall.eventId}` +
          `（会话=${sessionId}，${scope ? "已投递到域" : "先挂起，等窗口绑上再回放"}）`,
      );
      return;
    }

    // 不认识的事件：放行，不能拦着
    await this.replyEvent(waterfall.eventId, { kind: "next" });
  }

  /**
   * 把一条审批 / 提问事件交给域的适配器（即时到达与挂起回放共用）。
   *
   * **只管投递**：账目（未结算、去重）的进出全在 `PendingInteractions` 里；
   * 这里连 `eventId` 都不用另传，它就是 `held.eventId`（卡片主键靠它）。
   */
  private deliverEventToScope(held: HeldInteraction, scope: SessionScope): void {
    const eventId = held.eventId;
    if (held.kind === "approval") {
      const request = held.request as { toolName?: string; callId?: string; reason?: string };
      scope.adapter?.addApproval({
        requestId: eventId,
        // 工具名缺失时给标记而不是中文：审批卡按用户选的界面语言渲染
        toolName: request.toolName ?? "@toolGeneric",
        reason: request.reason,
        detail: request.callId ? `@callId:${request.callId}` : undefined,
        state: "waiting",
        // callId 同时单独记一份：会话日志的 `approval/decided` 靠它把结果
        // 对回这张卡（另一个窗口答的审批，本窗口只能从会话日志知道结果）
        ...(request.callId ? { callId: request.callId } : {}),
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
        // `detail` 是题目的补充正文（`exit_plan_mode` 拿它装**计划正文**），
        // `intent` 声明这道题该用哪种界面（`plan-review`）：两个都原样透传，
        // 界面侧才可能认出「这是一张计划审阅卡」并画出计划来
        detail: item.detail,
        options: item.options ?? [],
        multiSelect: item.multiSelect,
        intent: item.intent,
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
   * 图片输入能力、部署默认模型、以及顺带喂进去的 `busyEnter`（见 `refreshImageCaps`）。
   */
  private async reloadSettings(): Promise<void> {
    // 部署默认模型是**有缓存**的（`agent-default-model` 设置）：不清掉就永远读不到新值
    this.defaultModel = undefined;
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
        this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["model"]),
    });
      }
      if (this.defaultModel) {
        this.defaultModel = {
          ...this.defaultModel,
          acceptsImage: this.acceptsImageFor(this.defaultModel.provider, this.defaultModel.model),
        };
      }
      // 同一份 settings/describe 结果顺带喂「运行中回车行为」。
      //
      // 这里是 `busyEnter` **唯一**的喂入口（本条链路连模型目录时必然会跑）：以前它
      // 还挂在 `describeSettings()` 上，而那个只在**用户打开设置抽屉 / 保存设置 /
      // 外部改了 settings.yaml** 时才跑——于是新开一个窗口后、在碰过一次设置面板
      // 之前，`busyEnter` 恒为 undefined，用户的 `steer` 设置静默退回 queue
      // （本条修复来自审计结论，见 CHANGELOG）。设置面板已删除，入口只剩这一处。
      this.applyBusyEnter(described.namespaces ?? []);
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
        if (!scope.projections.has("modelSelection")) continue;
        // 这是**同一次投影的再消费**（目录刚到，把 id 换成名字），不是新值：直接调效果，
        // 不经过 store 的水位比较——同 seq 会被判负（契约：lower-or-equal seq loses），
        // 值就永远换不上名字了。
        this.applyModelSelectionProjection(
          scope,
          modelSelectionFromProjection(scope.projections.get("modelSelection")),
          true,
        );
        replayed = true;
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
   * 判据是「投影里有没有选择」，不是「域上有没有 model」：
   * 新会话的投影是 `{lastUsed:null,next:null}`（**不是** undefined），
   * 胶囊此时显示的就是部署默认——按旧判据（`scope.model || 原始投影`
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
      // 原始投影在 store 里（`modelSelection` 行的值），解析成「选中的那一份」；
      // 解析不出选择（含「provider 有、model 缺」的半截选择）就走默认值。
      if (modelSelectionFromProjection(scope.projections.get("modelSelection"))) continue;
      scope.model = this.defaultModel;
      this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["model"]),
    });
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
        // 首帧快照**先行**：locale/字号等外观设置全在里面。接回会话要先走
        // `ensureConnected`——整个自动连接期间快照都出不去，界面只能停在词典
        // 缺省（英文）上，直到连接结算才翻成中文（用户报的「启动总是先英文」）。
        // 能收到 `ready` 就说明 webview 的监听已挂上，此刻推帧不会丢。
        this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
        // 然后接回「这个窗口上次开着哪个会话」：绑上后 `openSession` 会再推一份
        // 带会话内容的完整快照，内容照常回填。`resumeRestoreHint` 幂等，兜底
        // 定时器先到也只是空跑一次。
        await this.resumeRestoreHint(viewId);
        break;

      case "send":
        // 未连接时先恢复连接：历史会话切换后跟随流尚未建立时直接 prompt
        // 会触发服务端 resume，冷启动竞态下 resume 可能失败。
        // **用户显式动作**（按了发送）：允许拉起内部后台（关掉自动连接时也算数，
        // 用户口径 2026-09-18：`autoConnect` 只约束扩展自己的自动行为）
        if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: true });
        await this.send(viewId, message.text, message.attachments, message.gesture ?? "enter");
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

      case "queueSteer": {
        // 把队列里的一条改成插话（官方 queue 行的「插话」按钮）。
        // 服务端要求 agent 正在运行；`session/steer-unavailable` 与
        // `session/queue-item-not-found` 按官方口径**静默**处理——那是「状态已经
        // 不是你以为的那样」，队列帧随之会刷新界面，弹一个错误只会让人困惑。
        const scope = this.scopeOfView(viewId);
        if (!this.client || !scope || !message.id) break;
        this.client.updateQueueSteer(scope.sessionId, message.id).catch((error) => {
          const text = error instanceof Error ? error.message : String(error);
          if (/steer-unavailable|queue-item-not-found/.test(text)) return;
          this.reportError(vscode.l10n.t("Failed to steer the queued message"), error);
        });
        break;
      }

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
        this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["model"]),
    });
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
        // 结算掉：这条请求不再需要回放（见 `interactions` 的注释）。答复照旧先回 Host
        // ——`settle` 拿到的是那条记录（含会话 id），据此把卡片状态落回对的域。
        const settled = this.interactions.settle(eventId);
        await this.replyEvent(eventId, {
          kind: "result",
          value: message.approved ? "allowed-once" : "rejected",
        });
        const scope = settled ? this.scopes.get(settled.sessionId) : undefined;
        scope?.adapter?.resolveApproval(eventId, message.approved ? "approved" : "rejected");
        break;
      }

      case "answerQuestion": {
        const eventId = message.requestId;
        if (!eventId) break;
        // 结算掉：这条请求不再需要回放（见 `interactions` 的注释）
        const settled = this.interactions.settle(eventId);
        await this.replyEvent(eventId, {
          kind: "result",
          value: { answers: message.answers },
        });
        const scope = settled ? this.scopes.get(settled.sessionId) : undefined;
        // 回答一并落到卡片上：展开记录要显示「用户当时选了什么」。本窗口自己
        // 答的那份只有界面知道（服务端的答案要等 `ask_user_question` 的工具
        // 结果回来才进日志），所以这里先写进去，工具结果到了再覆盖成权威值。
        scope?.adapter?.resolveQuestion(eventId, answersByQuestionId(message.answers));
        break;
      }

      case "cancelQuestion": {
        const eventId = message.requestId;
        if (!eventId) break;
        // 用户主动撤回（计划审阅卡的「去聊天里说」）：**不是回答**，回 `rejected`
        // 而不是一份空答案——等待方据此抛「用户想直接说话」那条错误。
        // `error` 的形状是网关逐键校验的（`parseRemoteEventRejection`：只认
        // name/message/code/details），照官方客户端的 `UserQuestionError` 发。
        const settled = this.interactions.settle(eventId);
        await this.replyEvent(eventId, {
          kind: "rejected",
          error: {
            name: "UserQuestionError",
            message: "the user cancelled ask_user_question",
            code: "ASK_CANCELLED",
          },
        });
        // 卡片收场（标成「已取消」）：与 Host 撤回走同一条路径，两边都不再是
        // 「待处理」，输入区把位置让出来
        if (settled) this.scopes.get(settled.sessionId)?.adapter?.cancelEvent(eventId);
        break;
      }

      case "addFiles":
        await this.pickFiles(viewId);
        break;

      case "attachBytes":
        // 拖放 / 粘贴进来的文件（只有字节和名字，见 shared/ipc.ts 的 attachBytes）。
        // **粘贴优先问系统剪贴板要真路径**：webview 侧拿不到路径（实测 types 只有
        // "Files"，text/uri-list 与 text/plain 都是空的），而路径这条路才做得到
        // 「目录 → 路径引用、文件 → 与回形针同样不限大小」（用户 2026-09-21 口径）。
        // 拿不到路径（非 Windows / 剪贴板里没有文件——截图就是这样）才退回字节通道。
        //
        // 走路径那一支时界面送来的字节**被丢掉**（它并不知道宿主能拿到路径）。代价是
        // 这一批文件的字节白读了一遍（≤ `ATTACH_BYTES_LIMIT`，超大条目界面侧本来就不读），
        // 换来的是不必再加一轮「先问路径、再要字节」的往返协议——不值得为几百毫秒
        // 把粘贴改成两阶段。
        //
        // 路径里的**目录与文件一起**交给同一条接入管线（`ingestAttachments`）：
        // 目录 → `@dir/` 引用、文件 → 附件，由 `planIntake` 一处决定，这里不再自己分流。
        //
        // **拖放没有路径分支**：VS Code 不把 OS 路径交给 webview——pre 脚本
        // （`webview/browser/pre/index.html` 的 `handleInnerDragEvent`）只转发 shiftKey，
        // 宿主（workbench 的 webview element）只切换 iframe 的 `pointer-events` 再合成
        // 一个不带 dataTransfer 的 DragEvent，Electron 32+ 又移除了 `File.path`。
        // 所以拖放**不支持文件夹**（0 字节条目 → 明确提示），文件走字节通道——
        // 与按钮 / 粘贴最终同一条上传。
        {
          const clipboardPaths = message.source === "paste" ? await readClipboardPaths() : [];
          if (clipboardPaths.length) {
            this.log(`[attach] 粘贴：系统剪贴板里有 ${clipboardPaths.length} 个路径`);
            await this.addPaths(viewId, clipboardPaths, "paste");
            break;
          }
          // `source` 只影响这一批的提示措辞与日志：准入判据完全相同（缺省当拖放，旧帧没有该字段）
          const source: IngestSource = message.source === "paste" ? "paste" : "drop";
          const items: IntakeItem[] = [];
          const rejected: IntakeRejection[] = [
            ...message.unreadable.map((name) => ({ name, reason: "unreadable" as const })),
            ...message.tooLarge.map((name) => ({ name, reason: "too-large" as const })),
          ];
          for (const file of message.files) {
            const decoded = this.decodeAttachBytes(file.base64, file.name, source);
            if (typeof decoded === "string") {
              // `invalid` 只可能是帧被改坏（界面侧的 base64 由 btoa 产出），不提示用户；
              // 超限则是真事，报给用户（界面侧同值拦过，这里是宿主侧的兜底那一半）
              if (decoded === "too-large") rejected.push({ name: file.name, reason: "too-large" });
              continue;
            }
            items.push({ from: "bytes", name: file.name, mimeType: file.mimeType, bytes: decoded });
          }
          this.log(
            `[attach] ${source === "paste" ? "粘贴" : "拖放"}：字节通道 ${items.length} 个条目（拒绝 ${rejected.length}）`,
          );
          await this.ingestAttachments(viewId, source, items, rejected);
          break;
        }

      case "retryUpload":
        this.retryUpload(viewId, message.id);
        break;

      case "branchFrom":
        await this.branchFrom(viewId, message.messageId);
        break;

      case "loadMore":
        await this.loadMore(viewId, message.targetSeq);
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

      case "requestChanges": {
        // 卡片要渲染时才问（见 shared/ipc.ts 的 requestChanges）：宿主按 seq 缓存，
        // 命中直接回帧，没命中才去 Host 读一次
        void this.loadChangesSummary(message.sessionId, message.seq);
        break;
      }

      case "insertText":
        await this.insertIntoEditor(message.text);
        break;

      case "copy":
        // 只写剪贴板，**不发「已复制」toast**（用户 2026-09-17 口径：复制成功从
        // 界面上就能感知——按钮/选中内容还在，信息条反而是打扰）。
        await vscode.env.clipboard.writeText(message.text);
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

      case "listTrajectory": {
        // 轨迹账本：把该窗口会话的**全部 durable 事件**折一遍（官方视图也是
        // 客户端自己折的，没有对应 RPC，见 `dsh/trajectory.ts` 的文件头）。
        // 整份模型走 JSON 字符串，绕开「undefined 键被丢掉」那套线格式语义。
        const adapter = this.scopeOfView(viewId)?.adapter;
        const model = adapter
          ? deriveTrajectoryModel(adapter.trajectoryEvents(), adapter.hasMoreHistory())
          : { turns: [], cellCount: 0, totalSeconds: 0, firstStartedAt: null, hasOlder: false };
        this.emitToView(viewId, { type: "trajectory", json: JSON.stringify(model) });
        break;
      }

      case "listCommands":
        await this.listCommandsForView(viewId);
        break;

      case "queryFiles":
        await this.queryFiles(viewId, message.query);
        break;

      case "resolveImages": {
        // 正文里的本地图（`![](out/chart.png)`）：按**该窗口会话**的工作目录解析。
        // 跨目录一律不读（白名单在 `dsh/localImages.ts`）。
        //
        // 会话 cwd 拿不到时（窗口刚起来、会话还没进列表）**退回当前工作区**：那仍是
        // 用户明确打开的目录，白名单的边界没有放宽，只是基准从「会话目录」换成
        // 「工作区目录」——而两者在绝大多数情况下就是同一个目录。不兜底的话，
        // 这一类失败是**全有全无**的：一张图都显示不出来，且完全静默。
        const scope = this.scopeOfView(viewId);
        const sessionCwd = scope ? this.cwdOf(scope) : undefined;
        const cwd = sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const urls = await readLocalImages(cwd, message.paths);
        const missed = message.paths.filter((path) => !(path in urls));
        if (missed.length) {
          // 这条日志是**诊断的落点**：界面只有一句「图片加载失败」，看不出是
          // 拿不到基准目录、路径越界、扩展名不在图片表里，还是读盘失败。
          this.log(
            `[images] 本地图片未解析 ${missed.length}/${message.paths.length} 张：` +
              `基准=${cwd ?? "（没有会话 cwd，也没有打开的工作区）"}` +
              `${sessionCwd ? "" : "（会话 cwd 缺失，已退回工作区路径）"}；` +
              `未解析：${missed.join(", ")}`,
          );
        }
        this.emitToView(viewId, { type: "images/resolved", requestId: message.requestId, urls });
        break;
      }

      case "openInBrowser":
        await this.openInBrowser();
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
        // 界面按钮「查看日志」：把输出通道（扩展日志）显示出来。
        // 以前这里只写一行空日志，用户点了等于没点——连接失败时用户最需要的
        // 恰恰是"去哪儿看原因"（用户 2026-09-14 口径）。
        await vscode.commands.executeCommand("dshChat.showLogs");
        break;

      case "startInternal":
        await this.startInternal();
        break;

      case "connectInternal":
        await this.connectInternal();
        break;

      case "connectExternal":
        await this.connectExternal();
        break;

      case "stopReconnect":
        this.stopReconnect();
        break;

      case "restartInternal":
        await this.restart();
        break;

      case "setToken":
        await this.setToken();
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

  private async send(
    viewId: string,
    text: string,
    attachments: Attachment[],
    gesture: "enter" | "accelerated" = "enter",
  ): Promise<void> {
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

    // 内容块装配收在 `buildPromptContent`（纯函数，断言在 scripts/attachments.test.ts）：
    // 附件在前、正文最后，附件之间保持列表顺序（官方 `content = [...attachments, text]`）。
    //
    // 文件附件的唯一判据是**上传回执**，不能再看 `path`：拖放 / 粘贴（剪贴板里没有真
    // 路径的那些）进来的字节附件本来就没有路径，早先那道 `!attachment.path` 的门会把
    // 上传成功的文件**整批丢掉**，而且因为门在同一处，连「有附件没传上去」的提示
    // 也不会发（2026-09-21 修）。
    const { content, notUploaded, dropped } = buildPromptContent(text, attachments);
    if (dropped.length) {
      // 表示不出来（图片没有可解析的 data URL）：不再静默，至少留一条日志
      this.log(`[submit] 这些附件无法表示成内容块，已跳过：${dropped.join("、")}`);
    }
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
      // **先**取「发出去的那一刻 agent 还在不在跑」，再乐观置位。顺序反了的话
      // `resolveSubmitMode` 里的 `!running` 这道门永远走不进去，空闲发消息也会带
      // `mode:"steer"`（审计确认的缺陷，见 resolveSubmitMode 的注释）。
      const wasRunning = scope.running;
      scope.running = true;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: { ...sessionPatch(this.sessionSource(scope), ["running"]), attachments: [], draft: "" },
      });
      // requestId 由这里铸造：队列帧会把同一个 id 作为 rpcId 带回来，
      // 「重新编辑」凭它还原成用户当时输入的文本与附件
      const requestId = randomUUID();
      // 队列「重新编辑」要还原用户**原始**输入，所以记的是拼引用之前的正文
      this.rememberSubmission(requestId, text.trim(), content, attachments);
      const mode = this.resolveSubmitMode(wasRunning, gesture);
      this.log(`[submit] 手势=${gesture} 运行中=${wasRunning} → mode=${mode}`);
      await this.client.prompt(scope.sessionId, content, mode, requestId);
      if (notUploaded.length) this.warnUploadIncomplete(viewId, notUploaded);
    } catch (error) {
      scope.running = false;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["running"]),
      });
      this.reportError(vscode.l10n.t("Failed to send"), error);
    }
  }

  /**
   * 提交模式：官方 `resolveSubmitMode` 的逐字移植
   * （`dsh-client-ui-conversation/lib/client.js`）：
   *
   * ```js
   * if (!running || !steeringAvailable) return "queue";
   * if (gesture === "enter") return preferred;                       // 设置值本身
   * return preferred === "queue" ? "steer" : "queue";                // 加速手势取反面
   * ```
   *
   * 三个要点：
   * - **`running` 必须是「手势发生时」的值**，不能是乐观置位之后的（见 send 里
   *   `wasRunning` 的取值顺序）——否则空闲发消息也会带 `mode:"steer"`，队列行被
   *   标成 `steering`；
   * - **主手势（回车 / 发送按钮）用设置值，Cmd/Ctrl+Enter 取反面**：设置项文案
   *   「Cmd/Ctrl+Enter 使用另一行为」说的就是这条；
   * - `steeringAvailable` 在本扩展里**恒为真**：子代理会话不进会话列表
   *   （`dsh/sessionList.ts` 过滤 `origin !== "subagent"`），`openSubagent` 只拉一份
   *   只读快照、不把窗口绑到子代理会话上，所以可发送的会话都不是「一次性子代理
   *   地址」。这是自觉的取值（不是官方等价实现），写在注释里以免将来误读。
   */
  private resolveSubmitMode(running: boolean, gesture: "enter" | "accelerated"): "queue" | "steer" {
    if (!running) return "queue";
    const preferred = this.busyEnter === "steer" ? "steer" : "queue";
    if (gesture === "enter") return preferred;
    return preferred === "queue" ? "steer" : "queue";
  }

  /** `ui-conversation.busyEnter` 设置（`queue` / `steer`），未配置时按 queue。 */
  private busyEnter: string | undefined;

  /** 从设置命名空间里读「运行中回车」的行为；没有该配置就保持 queue。 */
  private applyBusyEnter(settings: { ns?: string; value?: unknown }[]): void {
    const section = settings.find((item) => item?.ns === "ui-conversation");
    const value = (section?.value ?? {}) as { busyEnter?: unknown };
    const next = typeof value.busyEnter === "string" ? value.busyEnter : undefined;
    if (next === this.busyEnter) return;
    this.busyEnter = next;
    // 界面按它决定运行中发送按钮的文案（排队发送 / 插话发送），所以变了要推一帧；
    // 值本身仍然由**宿主**在发送时解析成 `session/prompt.mode`（见 resolveSubmitMode）。
    this.emitAll({ type: "patch", patch: { busyEnter: next === "steer" ? "steer" : "queue" } });
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
   * 目录的显式入口是 `pickFolder`（命令面板 / 资源管理器右键文件夹）。
   *
   * 所以这条路**不需要**文件夹/文件分类：对话框在 Windows/Linux 上不可能返回目录，
   * 选了什么都直接当附件。macOS 的 bundle（`.app`）与目录联接是例外——它们会被
   * 当成"文件"返回，那由接入管线按目录规则收场（`@dir/` 引用），不会有目录芯片。
   *
   * 刻意不再有「只选图片」的对话框：同一个按钮既能给图片也能给代码/日志，
   * 由文件本身决定走哪条路，用户不必先想清楚该点哪个按钮。
   */
  private async pickFiles(viewId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      // 确认按钮的文案说的是**选完会发生什么**：这些文件变成输入框上方的附件芯片
      // （图片按内容块发送、其余逐字节上传），不是插进正文的引用——所以不叫
      // 「添加为上下文」（用户 2026-09-21 指出那句话不准确）
      openLabel: vscode.l10n.t("Add attachments"),
    });
    if (!picked?.length) return;
    await this.addPaths(viewId, picked.map((uri) => uri.fsPath), "button");
  }

  /**
   * 添加目录（单独入口：与文件选择器在 Windows 上互斥，见 pickFiles 注释）。
   *
   * 与「添加文件/选区」统一：选中的目录插成 **`@dir/` 引用**（用户 2026-09-14
   * 口径：目录、文件、文件某行一律走引用，不做附件）。
   */
  private async pickFolder(viewId: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: false,
      canSelectFolders: true,
      // 目录与文件不同：它插进正文成为 `@dir/` **引用**（不是附件芯片），
      // 所以这句保留「引用」的说法
      openLabel: vscode.l10n.t("Add folder reference"),
    });
    if (!picked?.length) return;
    for (const uri of picked) this.addDirectoryReference(viewId, uri.fsPath);
  }

  /**
   * 把一批路径交给接入管线（**附件**入口专用：文件选择器 / 剪贴板真路径）。
   *
   * `@` 那条路不走这里：`@` 选中的文件/目录是正文里的 `@path` **引用** token
   * （纯路径，官方 `@` 的语义），真正逐字节上传只从附件入口发生。
   */
  private async addPaths(viewId: string, paths: readonly string[], source: IngestSource): Promise<void> {
    const items: IntakeItem[] = paths.map((path) => ({
      from: "path",
      path,
      name: this.attachmentName(path),
    }));
    await this.ingestAttachments(viewId, source, items, []);
  }

  /**
   * **三个入口唯一的接入执行层**：添加文件按钮 / 拖放 / 粘贴。
   *
   * 决策全部在纯函数 `attachments.planIntake` 里（条目 → 附件 / 目录引用 / 拒绝），
   * 这里只把结果落到视图上。之所以收成一份：路径与字节两条路曾经各写一遍，
   * 于是漂移出了真 BUG——字节通道的附件没有 `path`，发送装配按 `path` 过滤，
   * 上传成功的文件**根本没进 prompt**，而且连提示都不发（2026-09-21 修）。
   *
   * 三条去向（与官方一致，理由见 `attachments.ts` 文件头）：
   * - **图片** → 图片附件（内容块，官方同样内联图片字节）；
   * - **目录** → `@dir/` **引用文本**（不是附件芯片，见 `addDirectoryReference`）；
   * - **其余文件** → 文件附件并**立即上传**（官方 upload-on-pick：选完就开始传，
   *   发送时只带 `receiptId`；上传按字节发，类型与大小都不挑——官方也不挑，
   *   **不要**在这里加可读性/大小筛子）。
   *
   * 读不出来（选择到读取之间被删的竞态）、或模型不收图片，才退回把带引号的路径插到
   * 光标处——那是最后一道兜底，不再假装「已作为上下文加入」。
   */
  private async ingestAttachments(
    viewId: string,
    source: IngestSource,
    items: readonly IntakeItem[],
    rejected: readonly IntakeRejection[],
  ): Promise<void> {
    // 上传需要会话：窗口还是空态时先建（附件按键是常见的第一步动作）
    if (!this.scopeOfView(viewId)) {
      if (this.client || this.connection === "connected") {
        await this.newSession(viewId);
      }
    }
    const key = this.keyForView(viewId);
    const list = this.attachmentsBySession.get(key) ?? [];
    const scope = this.scopeOfView(viewId);
    const plan = planIntake({
      items,
      // 未拿到模型能力时按「支持」处理，与服务端最终校验一致
      acceptsImage: scope?.model?.acceptsImage !== false,
      // 图片内联上限：优先用服务端自己的 `imageLimits.maxImageBytes`（这正是那份
      // 投影的用途），拿不到时给一个保守硬上限——同步读一张几百 MB 的图会冻住宿主
      maxImageBytes: scope?.imageLimits?.maxImageBytes ?? IMAGE_INLINE_HARD_CAP,
      // 附件按路径去重（同一张图加两次没有意义）；字节条目没有身份可比，不去重
      existingPaths: list.flatMap((attachment) => (attachment.path ? [attachment.path] : [])),
      rejected,
      onError: (message) => this.log(`[attach] ${message}`),
    });

    // 先把芯片落进列表（带 uploading，由 startUpload 写）再起上传：上传是异步的
    // 一条日志把这一批的去向说清楚（排查「我加的东西怎么没进来」全靠它）
    this.log(
      `[attach] ${source}：附件 ${plan.attachments.length}（其中上传 ${plan.uploads.length}）` +
        ` / 目录引用 ${plan.directories.length} / 路径兜底 ${plan.pathOnly.length} / 拒绝 ${plan.rejected.length}`,
    );
    list.push(...plan.attachments);
    this.attachmentsBySession.set(key, list);
    this.pushAttachmentsForView(viewId, list);

    for (const directory of plan.directories) this.addDirectoryReference(viewId, directory);
    for (const upload of plan.uploads) this.startUpload(viewId, upload);
    if (plan.pathOnly.length) {
      this.emitToView(viewId, { type: "ui/insertText", text: formatPathList(plan.pathOnly) });
    }
    // 图片被降级成文件上传时说明原因（否则用户只看到「我加的是图，怎么成了文件」）——
    // 两条通道同一条文案，不再只有路径那条会提示
    for (const name of plan.degradedImages) {
      this.emitToView(viewId, { type: "toast", level: "warn", text: `@imageTooLarge:${name}` });
    }
    if (plan.unsupportedImages > 0) {
      const model = scope?.model;
      const label = model?.label ?? model?.model ?? "";
      this.emitToView(viewId, {
        type: "toast",
        level: "warn",
        text: `@imagePathsInserted:${plan.unsupportedImages}:${label}`,
      });
    }
    // 两条路各一套措辞（字面量写在这里，`scripts/i18n.test.ts` 靠它核对发射点）：
    // 准入判据完全相同，但「拖放上限 8 MB，请改用添加文件」对粘贴来的东西说不通
    // （用户手上没有那个文件）。按钮那条路不会有拒绝（对话框只给读得出来的路径），
    // 所以这里的兜底措辞用不到它。
    const unreadableKey = source === "paste" ? "@pasteUnreadable" : "@dropUnreadable";
    const tooLargeKey = source === "paste" ? "@pasteTooLarge" : "@dropTooLarge";
    for (const item of plan.rejected) {
      const marker = item.reason === "too-large" ? tooLargeKey : unreadableKey;
      this.emitToView(viewId, { type: "toast", level: "warn", text: `${marker}:${item.name}` });
    }
  }

  /**
   * 把一条目录**引用**插到输入框光标处 —— 目录的唯一落点。
   *
   * 附件入口（文件选择器返回的目录联接 / macOS bundle）、粘贴的剪贴板真路径、
   * 以及接入管线判出来的目录条目都走这里：目录**永远**是正文里的 `@dir/` token，
   * 不是附件芯片（用户 2026-09-21 口径：「粘贴文件夹不该变成附件」）。
   * 分隔符归一（`\` → `/`）与结尾斜杠都在 `formatFileMention` 里。
   */
  private addDirectoryReference(viewId: string, path: string): void {
    this.insertMention(viewId, formatFileMention(this.relativePath(path), "directory"));
  }

  /**
   * 界面送来的 base64 → 字节（`attachBytes` 专用）；超限或解不开时给出原因字符串。
   *
   * **宿主这一侧也要拦**：`ATTACH_BYTES_LIMIT` 在界面里判过一次（`attachIntake.ts`），
   * 而帧是界面发来的、形状不受类型系统约束——没有这一道，一条超大的 base64 会让宿主
   * 先分配一份解码后的字节再发现它太大。按 base64 长度先判，连解码都不做
   * （4/3 关系，留 3 字节余量给 padding）。
   */
  private decodeAttachBytes(
    base64: string,
    name: string,
    source: IngestSource,
  ): Uint8Array | "too-large" | "invalid" {
    const label = source === "paste" ? "粘贴" : "拖放";
    if (base64.length > MAX_BASE64_CHARS) {
      this.log(`[attach] ${label}的文件超过 ${ATTACH_BYTES_LIMIT} 字节，已拒绝：${name}`);
      return "too-large";
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(base64, "base64"));
    } catch (error) {
      this.log(`[attach] ${label}解码失败 ${name}：${this.describeError(error)}`);
      return "invalid";
    }
    if (bytes.length > ATTACH_BYTES_LIMIT) {
      this.log(`[attach] ${label}的文件超过 ${ATTACH_BYTES_LIMIT} 字节，已拒绝：${name}`);
      return "too-large";
    }
    return bytes;
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

  /**
   * 起一次上传（路径来源重读磁盘，字节来源用手上这一份），并把 `receiptId` 写回芯片。
   *
   * 字节先存进 `droppedBytes`：上传失败后芯片上的「重试」要能再传一次，而字节那条路
   * 没有任何别的来源（列表里只有名字）。上传成功后立刻丢掉，失败则留到用户重试或
   * 删掉芯片——内存占用因此只跟「在飞 + 失败」的条目走。
   */
  private startUpload(viewId: string, upload: IntakeUpload): void {
    const key = this.keyForView(viewId);
    const attachment = (this.attachmentsBySession.get(key) ?? []).find((a) => a.id === upload.id);
    if (!attachment) return;
    if (upload.source.kind === "bytes") this.droppedBytes.set(upload.id, upload.source.bytes);
    this.setStateForUpload(viewId, upload.id, { status: "uploading", loaded: 0 });
    void this.runUpload(viewId, upload.id, attachment.name, upload.source);
  }

  /** 拖放 / 粘贴字节的暂存（键 = 附件 id）：只为「上传失败后重试」而留。 */
  private readonly droppedBytes = new Map<string, Uint8Array>();

  private async runUpload(
    viewId: string,
    id: string,
    name: string,
    source: IntakeUpload["source"],
  ): Promise<void> {
    const sessionId = this.viewSessions.get(viewId);
    if (!this.client || !sessionId) {
      this.setStateForUpload(viewId, id, { status: "error", message: "@uploadNoSession" });
      return;
    }
    try {
      const bytes = source.kind === "bytes" ? source.bytes : new Uint8Array(readFileSync(source.path));
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

  /** 修改**指定窗口**的附件并下发（键为会话 id；空态窗口用 viewId 做键）。 */
  private mutateAttachmentsForView(viewId: string, fn: (list: Attachment[]) => void): void {
    const key = this.keyForView(viewId);
    const list = this.attachmentsBySession.get(key) ?? [];
    fn(list);
    this.attachmentsBySession.set(key, list);
    this.pushAttachmentsForView(viewId, list);
  }

  /** 重传一个失败的文件附件（字节来源用手上那份暂存，路径来源重读磁盘）。 */
  private retryUpload(viewId: string, id: string): void {
    const key = this.keyForView(viewId);
    const attachment = (this.attachmentsBySession.get(key) ?? []).find((a) => a.id === id);
    if (!attachment) return;
    // 拖放 / 粘贴来的附件没有路径，字节存在 `droppedBytes` 里（见 startUpload）
    const dropped = this.droppedBytes.get(id);
    if (dropped) {
      this.startUpload(viewId, { id, source: { kind: "bytes", bytes: dropped } });
      return;
    }
    if (!attachment.path) return;
    this.startUpload(viewId, { id, source: { kind: "path", path: attachment.path } });
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
      // 界面上那盏「生成中」以**域**为准（`deliver` 的 patch 与这里写的是同一个值，
      // 但域是权威：下一个读 `scope.running` 的地方不该看到与界面不一致的旧值）
      scope.running = false;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["running"]),
      });
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
          this.deliver(scope.sessionId, {
            type: "patch",
            patch: sessionPatch(this.sessionSource(scope), ["running"]),
          });
        }
        await this.client.prompt(scope.sessionId, origin.content ?? [], "queue", requestId);
      } catch (error) {
        scope.running = false;
        this.deliver(scope.sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(scope), ["running"]),
        });
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
   * 把编辑器选区作为 **`@` 引用**加进最近活动窗口的输入框（用户 2026-09-14 口径）。
   *
   * 以前这里塞的是一个 `selection` 附件芯片、发送时把选中的代码整段**内联**进正文。
   * 现在与文件 / 目录统一：插入 `@文件#L12-L40` 这样的**路径引用**，由模型自己用
   * `read` 工具去读那几行。
   *
   * `lines` 是选区覆盖的行号（1 基闭区间）：**部分引用必须带上它**——它是这条引用
   * 与「整文件引用」唯一的区别（不说清楚的话模型只看到一个路径，而用户想的是
   * 「这几行」）。语法偏离官方的说明见 `shared/mentions.ts`。
   */
  addSelection(name: string, lines?: { start: number; end: number }): void {
    const viewId = this.activeViewId();
    if (!viewId) return;
    this.insertMention(viewId, formatFileMentionWithLines(name, lines));
  }

  /**
   * 供资源管理器右键 / 命令调用：把**文件或目录**作为 `@` 引用加到输入框。
   *
   * 与「附件」是两条通道：引用只把路径 token 写进正文，字节一个都不发；
   * 目录以结尾斜杠标记（`@dir/`），模型据此决定要不要 list。
   */
  async addFileContext(path: string): Promise<void> {
    const viewId = this.activeViewId();
    if (!viewId) return;
    // 目录与文件都插成 `@` 引用；目录走唯一的目录落点（与附件入口、粘贴同一条规则）
    if (isDirectoryPath(path)) {
      this.addDirectoryReference(viewId, path);
      return;
    }
    this.insertMention(viewId, formatFileMention(this.relativePath(path), "file"));
  }

  /** 命令面板 / 右键文件夹：选目录加为最近活动窗口的 `@dir/` 引用。 */
  async addFolder(): Promise<void> {
    const viewId = this.activeViewId();
    if (!viewId) return;
    await this.pickFolder(viewId);
  }

  /**
   * 把一条 `@` 引用插到**输入框光标处**。
   *
   * 走界面已有的 `ui/insertText`（界面自己知道光标在哪、按需补空格并移动光标）；
   * 引用不可表示（路径含控制字符或引号）时 `mention` 是 undefined，静默跳过——
   * 那种路径官方语法也表达不了，硬塞一个坏 token 只会让模型读到半截路径。
   */
  private insertMention(viewId: string, mention: string | undefined): void {
    if (!mention) {
      this.log("[mention] 路径无法表示为 @ 引用（含控制字符或引号），已跳过");
      return;
    }
    this.emitToView(viewId, { type: "ui/insertText", text: mention });
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
      scope.subagentEntries = subagentsFromList(result.entries);
      this.deliver(scope.sessionId, {
        type: "subagents/list",
        entries: scope.subagentEntries,
        parentAvailable: result.parentAvailable ?? scope.subagentEntries.length > 0,
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
    const child = scope?.subagentEntries.find((item) => item.id === childSessionId);
    if (!child) {
      // 目录里查不到（列表刚刷新过 / 子代理已经不在目录里）：**也要回一帧空的**。
      // 界面点开时已经把抽屉开到这个 id 并置了 loading，不回帧它就永远停在
      // 「正在读取…」（用户 2026-09-19：点进去看不到内容）。
      this.log(`[subagents] 目录里没有 ${childSessionId}，回一帧空记录`);
      this.emitToView(viewId, { type: "subagent/transcript", id: childSessionId, messages: [] });
      return;
    }
    const mode = child.mode;
    const parentSessionId = scope!.sessionId;
    const adapter = new SessionAdapter(() => {});
    // 子代理记录没有界面出口（`sendFrame` 是空的），日志更是唯一能追溯未知事件的落点
    adapter.log = (line) => this.log(`[event] 子代理=${childSessionId} ${line}`);
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
            // `assistantStream` 在这里**整条不传**：契约里它是字面量 `true`
            // （`readonly assistantStream?: true`）。此前写的 `false` 被网关的边界
            // 校验整条拒掉（`gateway/input-invalid: wire field "request" failed
            // boundary validation`），`onError` 立刻回一帧空记录——用户 2026-09-22
            // 报的「点进去是这个子代理没有可显示的内容」就是它。类型见
            // `SessionFollowRequest`（那条类型就是为拦住这一手而加的）。
          } satisfies SessionFollowRequest,
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
      this.emitToView(viewId, { type: "files/list", query, items: [], sessions: [] });
      return;
    }
    // 官方的 `@` 是**一个源、两组候选**（`dsh-client-ui-reference`）：
    // 文件（`fileReferences/list`）与对话（`sessionReferenceResolver/candidates`）
    // 并行取、各自成组。对话那条失败（老版本服务器没有这个 remote）不该把文件
    // 候选一起拖下水，所以单独兜住。
    const [files, sessions] = await Promise.all([
      this.client
        .request<{ path: string; kind: "file" | "directory" }[]>("fileReferences/list", {
          agentId: scope.sessionId,
          query,
        })
        .catch((error: unknown) => {
          this.log(`[files] 查询失败：${this.describeError(error)}`);
          return [] as { path: string; kind: "file" | "directory" }[];
        }),
      this.client
        .request<SessionReferenceCandidateWire[]>("sessionReferenceResolver/candidates", {
          agentId: scope.sessionId,
          query,
        })
        .catch((error: unknown) => {
          this.log(`[files] 对话引用查询失败：${this.describeError(error)}`);
          return [] as SessionReferenceCandidateWire[];
        }),
    ]);
    this.emitToView(viewId, {
      type: "files/list",
      query,
      items: files ?? [],
      sessions: (sessions ?? []).map(
        (row): SessionRefView => ({
          sessionId: String(row?.sessionId ?? ""),
          label: String(row?.label ?? row?.sessionId ?? ""),
          mention: String(row?.mention ?? ""),
          ...(typeof row?.cwd === "string" && row.cwd ? { cwd: row.cwd } : {}),
          sameWorkspace: row?.sameWorkspace === true,
          ...(typeof row?.createdAt === "number" ? { updatedAt: row.createdAt } : {}),
        }),
      ),
    });
  }

  // ---------- 在浏览器中打开（官方 Web UI 的入口） ----------

  /**
   * 用**系统默认浏览器**打开这个 dsh web 服务器（带上启动令牌）。
   *
   * **只能开到首页，不能指定会话**：Web UI 没有 URL 深链——它唯一读查询串的地方是
   * fixture 测试开关（官方 `dsh-client-connection` 的 `fixtureOptionsFromLocation`），
   * 会话选择存在浏览器本地的持久单元（`dsh.sessions.current`），外部指定不了；
   * 而且令牌换 cookie 那一步是 `303 → 裸 /`，附带的查询串本来就会被丢掉。
   *
   * **必须带令牌**：`index.html` 本身就要认证（官方 `BrowserAuth.authorizeIndex`），
   * 不带令牌打开的是一页 401 文本。令牌是按进程生成的随机值，只有自管服务器能从
   * 会合文件里读到（`freshToken()`）。
   *
   * 外部服务器模式（`dshChat.url`）**刻意开裸地址**：那种模式下的令牌是用户自己
   * 输进来的（`setToken` / 连接失败时的输入框），扩展拿它换完 cookie 就丢掉、不落盘
   * ——令牌按进程生成、重启即失效，存它没有意义（同 `SESSION_SECRET_PREFIX` 那段
   * 注释）。于是这里没得可带，浏览器若已持有那个站点的会话（以前打开过 `dsh web`
   * 打印的 URL）就仍然可用，否则让用户自己把令牌填进地址栏——他手里本来就有。
   */
  private async openInBrowser(): Promise<void> {
    const baseUrl = this.client?.baseUrl ?? this.server.activeBaseUrl ?? this.server.externalUrl;
    if (!baseUrl) {
      this.emitAll({ type: "toast", level: "warn", text: "@openInBrowserOffline" });
      return;
    }
    // 令牌**现读**会合文件：守护进程可能在我们换 cookie 之后重起过 dsh、换了一份令牌
    const token = this.server.freshToken();
    const url = new URL("/", baseUrl);
    if (token) url.searchParams.set("token", token);
    this.log(`[browser] 用默认浏览器打开 ${url.origin}/（token=${token ? "有" : "无"}）`);
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url.href));
    if (!opened) {
      this.log("[browser] 系统没有接受这次打开请求");
      this.emitAll({ type: "toast", level: "warn", text: "@openInBrowserFailed" });
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

