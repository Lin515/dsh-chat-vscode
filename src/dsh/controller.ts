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
  PendingMessageView,
  ProviderGroupView,
  QuestionAnswerView,
  QuestionView,
  SessionRefView,
  SessionSummaryView,
  SubagentContextView,
  SubagentView,
  TodoView,
  UploadState,
} from "../shared/chat";
import type { HostToWebview, WebviewToHost } from "../shared/ipc";
import { SessionAdapter, type ImageRef } from "./adapter";
import { decodeChangesSummary } from "./changes";
import { changesSummaryKey } from "../shared/changesSummary";
import { localizedTextFrom } from "../shared/localizedText";
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
  type PromptContentPart,
} from "./attachments";
import { readClipboardPaths } from "./clipboardPaths";
import { saveChatImage } from "./imageFiles";
import { ConfigChangeRouter } from "./configChanges";
import { fileChangeKind, hasWorkingChange, isNotFoundError, resolveChipPath, splitPathLineSuffix, type FileExistence, type GitChangeStateLike } from "./fileChange";
import { readLocalImages } from "./localImages";
import { shouldContinuePaging } from "./historyPaging";
import { formatFileMention } from "./references";
import { formatFileMentionWithLines } from "../shared/mentions";
import { resolveForVsCode } from "./hostText";
import { normalizeTurnProcessThreshold } from "../shared/turnProcessThreshold";
import { chooseTarget, describeFacts, externalStateOf, type TargetFacts } from "./connectTarget";
import { DshApiError, DshAuthError, DshClient, endpointAbsent, type SessionReferenceCandidateWire, type SessionSummaryWire } from "./client";
import type { ProjectionBlockWire } from "./projectionStore";
import { PendingInteractions, type HeldInteraction } from "./pendingInteractions";
import type {
  RemoteEventFrame,
  RemoteEventWaterfall,
  SessionControlFrame,
  SessionFollowFrame,
} from "./protocol";
import { jobFollowFrameFromWire, jobItemsFromWire, jobRowsFromFrame } from "./jobView";
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
import { modelSelectionFromProjection, subagentCatalogFromProjection, subagentsFromList, upsertSubagent, withSubagentActivity, agentPresetsFromList } from "./projections";
import type { ModelSelectionDecoded, SubagentCatalogEntryView } from "./projections";
import {
  ingestControlBaseline,
  ingestFollowSnapshot,
  ingestProjection,
  replayFollowSnapshot,
  type ProjectionHandlers,
} from "./projectionIngest";
import { deriveTrajectoryModel } from "./trajectory";
import { normalizePath, visibleForWorkspace, visibleSessionCandidates, visibleSessionRows } from "./sessionList";
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

/**
 * 恢复期暂存的一条会话认领：会话 id + 它是不是子代理（子代理带父会话与模式）。
 * 形状与 `windowState.WindowEntry` 的可恢复字段一致。
 */
type RestoreHint = {
  sessionId: string;
  subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" };
};

/** 类型守卫：这个域正在查看**子代理会话**（有子代理地址）。 */
function selfScopeHasAddress(scope: SessionScope | undefined): boolean {
  return scope?.subagentAddress !== undefined;
}

/** 提交记录（用于队列「重新编辑」还原原文）的保留时长与条数上限。 */
const SUBMISSION_TTL_MS = 30 * 60 * 1000;
const MAX_SUBMISSIONS = 50;

/**
 * 一个键（窗口 / 会话）下同时留着的乐观回显条数上限。
 *
 * 回显只活到「被承认 / 被证伪」，正常情况下同一键下最多一两条；上限是给
 * 「服务端既不承认也不报错」那类异常兜底的。淘汰**只从没失败的那些里挑**：
 * 已经标成失败的那一行是用户正看着、要能重发 / 撤回的（用户 2026-09-25 口径），
 * 悄悄删掉它就等于替用户撤回；全是失败行时宁可多留，也不动它们。
 */
const MAX_PENDING_MESSAGES = 8;

/**
 * 回显账本的**键数**上限（键 = 窗口 / 会话）。
 *
 * 失败的回显跨会话切换保留（切回来还能重发 / 撤回，`destroyScope` 刻意不动它们），
 * 所以键会随用过的会话增长；超了按插入顺序丢最旧的键（最新用过的那个键在 `putPending`
 * 里被顶到队尾，不会被自己这一轮清掉）。
 */
const MAX_PENDING_KEYS = 64;

/** 读取编辑节点 diff 的排版设置（auto / unified / split，缺省自适应）。 */
function readDiffLayout(): DiffLayout {
  const value = vscode.workspace.getConfiguration("dshChat").get<string>("diffLayout");
  return value === "unified" || value === "split" ? value : "auto";
}

/**
 * 行号是不是可用的 **1 基正整数**。
 *
 * 行号可能来自模型写的链接（`[…](src/a.ts#L0)`、`#Labc` 都能写出来），而
 * `vscode.Position` 对越界值是**抛异常**而不是夹取——所以进 `Position` 之前
 * 一律先过这里（`revealLine` 会把超出行数的夹到最后一行，但 0 / 负数 / 小数
 * 直接当没给）。
 */
function isLineNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1;
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

/**
 * 新会话默认使用的 agent 预设（`dshChat.agentPreset`）。
 *
 * 空串 / 空白 / 非字符串一律当「没配」——那时**不往 `session/create` 里传
 * `agentPreset`**，由服务端按它自己的默认预设组装（部署配置里那一个）。传一个
 * 空串会被服务端当非法 id 拒绝，所以这里必须收窄而不是原样透传。
 *
 * 这条配置在 `package.json` 里是 `machine` 作用域（与 `dshChat.command` 同一条口径）：
 * 预设决定一个会话组装哪些插件，也就是**执行哪段代码**；克隆来的仓库里一行
 * `.vscode/settings.json` 不该能替用户挑一个别的组装。
 */
function readAgentPreset(): string | undefined {
  const value = vscode.workspace.getConfiguration("dshChat").get<unknown>("agentPreset");
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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
 * 两轴结论"（管理器的快照里没有这两个值：它们是**异步探测**，见 `docs/design-supervisor.md`「两条存在性判据」），
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
 * 一个窗口正在看的一条后台任务输出（`job/follow`）。
 *
 * 观察流**按窗口**跟踪，不按会话共享：界面上同一时刻只有一行是展开的
 * （官方 `expandedKey` 也是单个键），所以「一个窗口一条流」就是精确模型——
 * 两个窗口看同一个任务时各看各的，谁也不会把别人的续传游标推着走。
 *
 * `from` 是续传游标（服务端上一帧的 `next`）：断线重连时从它接着读，界面那边
 * 已累积的文本不用清、也不会重复。第一次观察是 `undefined`（服务端从环里最旧的
 * 保留字节锚起，`opened.from > 0` 才是「开头已淘汰」的信号）。
 */
interface JobWatch {
  sessionId: string;
  jobId: string;
  /** 界面铸造的观察代号：每次展开都换一个，宿主原样回带（界面据此丢弃旧流残余帧）。 */
  watchId: number;
  handle: { cancel(): void };
  /** 断线重连时的续传游标（最后一次收到的 `next`）。 */
  from: number | undefined;
}

/**
 * **连接那组界面字段 = 上面三个输入的纯函数映射**（首帧快照与增量 patch 共用这一份，
 * 两处各写一遍必然漂移）。
 *
 * 两种"单一来源"各归各位：
 * - **管理器那一半**（外部地址、目标、后台在不在）只读 `snapshot()`——控制器不再存一份镜像。
 *   删掉的那两个镜像字段（`internalRunning` / `externalReachable`）在这里由 `facts` 出，
 *   而 `facts` 是**本窗口的探测结论**（快照里没有：内部那一轴要问"守护进程进程还在吗"、
 *   外部那一轴要发一次 HTTP，都是异步探测，见 `docs/design-supervisor.md`「两条存在性判据」）；
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
   * 正好把这个会话写进它的首帧快照里。子代理会话带它的地址（不进会话列表，
   * 只有地址能重新进入）。
   */
  private readonly restoreHints = new Map<string, RestoreHint>();
  /**
   * 工作区身份还没就绪时排队的**编辑区面板**认领（按 VS Code 的恢复顺序入队）。
   * 顺序就是位置，所以必须按原序补（见 `flushRestoreClaims`）；`known` 是面板
   * 自己存下来的窗口身份（身份认领用，见 `claimPanelRestore`）。
   */
  private readonly panelClaimsQueued: { viewId: string; known?: RestoreHint }[] = [];
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
  /**
   * 子代理目录 RPC 的在飞请求（会话 id → promise）：**单飞**。
   *
   * 域创建、socket 重连、面板打开三个入口常常挨着发生，同一会话并发发两次请求既浪费
   * 又会用两份先后到达的响应互相覆盖。条目在 `finally` 里删——它是「按会话为键的 Map」，
   * 必须有自己的清理路径（涨上去就是永久泄漏）。
   */
  private readonly subagentRefreshes = new Map<string, Promise<void>>();
  /**
   * 窗口（viewId）→ 它正在看的那条后台任务输出流（`job/follow`）。
   *
   * 一个窗口同时最多一条（面板只展开一行），所以这张表的键是**视图**而不是任务：
   * 展开另一行、收起、关面板、关窗口、切会话都会把上一条收掉（见 `closeJobWatch`）。
   * 按任务为键的 Map 在这里会长出一堆没人负责的条目，而观察流是长活 socket 流
   * ——漏一条就是一条永远不结束的流。
   */
  private readonly jobWatches = new Map<string, JobWatch>();
  /**
   * 这个服务端**没有** `subagents/list` 这个端点（0.1.7-alpha.1 起官方已删除它）。
   *
   * 判据是网关回 HTTP 404（路由不存在）——肯定证据，不是猜。记住之后目录只由
   * `subagentCatalog` 投影与 `subagent/catalog` 事件两路承载，不再白发请求。
   * 每次重建连接（`teardownStreams`）清零：换一个服务端就重新问一次。
   */
  private subagentListMissing = false;
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
   * 用户在新会话页上选定的工作目录（**只在 VS Code 没有打开文件夹时有意义**）。
   *
   * 打开文件夹时一律跟随 VS Code（`workspacePath()` 先看 folder），这个值被忽略；
   * 没有文件夹时才用它——没有它的话 `workspacePath()` 是扩展宿主的 `process.cwd()`，
   * 那是个用户既没选、也无从知道的目录。**刻意不持久化**：它是这一次窗口里的选择，
   * 重载窗口后回到与今天一致的行为（没有文件夹就按宿主 cwd 建会话）。
   */
  private newSessionCwd: string | undefined;
  /**
   * **待建会话**的界面选择（按窗口）：会话还没建出来，但用户已经点过预设 / 模型。
   *
   * 值只喂给 `sessionSourceOf` 的 `pending` 那一路（空态页的预览），建会话时一次性
   * 落到新会话上然后忘掉——「新会话从配置项重新开始」这条口径（见 CHANGELOG）靠的就是
   * 这里的删除，而不是别处的判断。绑到一个**已有**会话时也清（那笔选择不再有意义）。
   */
  private readonly viewAgentPreset = new Map<string, string>();
  private readonly viewModel = new Map<string, ModelSelectionView>();
  /**
   * **待建会话**的权限预设选择（按窗口）：会话还没建出来，但用户已经在空态页的
   * 权限菜单里点过一次。
   *
   * 与 `viewModel` 同一口径：值只喂给 `sessionSourceOf` 的 `pending` 那一路（空态页的
   * 预览），建会话时一次性落到新会话上然后忘掉（与部署默认相同就不发，见
   * `createSession`）。绑到一个**已有**会话时也清（那笔选择不再有意义）。
   */
  private readonly viewPermission = new Map<string, string>();
  /**
   * 每个窗口**正在进行**的那次建会话尝试（`ensureSession` 的单飞壳子）。
   *
   * `@` 候选是**每敲一个字符**重取一次的（`composerCompletion` 的 effect 依赖查询串），
   * 两次请求同时走到 `ensureSession` 时，两边都会看到「还没有域」——不合并就会各建一条
   * 会话（用户 2026-09-24 报的现场是菜单空；这条是同一个改动带来的并发入口）。键是窗口，
   * 因为「建会话」这件事本身就是按窗口的（草稿、待建参数都按窗口存）。
   */
  private readonly sessionEnsures = new Map<string, Promise<SessionScope | undefined>>();
  /**
   * **扩展自己建出来的空会话**（`/`、`@` 菜单在空态按需建的那条）→ 它的落脚目录与预设。
   *
   * 只为**复用**存在：菜单是「打开就建」，用户按 Esc 走开时那条会话还没开始对话，
   * 下次在这个窗口里建会话时把它接回来，而不是再堆一条（官方 Web 端也是这个口径：
   * `ui-workspace` 的 `reuseOrCreateBlank`）。服务端说它已经开始对话了就不再可复用
   * （`refreshSessions` 里按 `blank` 清）。
   */
  private readonly createdBlankSessions = new Map<
    string,
    {
      /** 建它时的落脚目录（归一后，比较用）。 */
      cwd: string;
      /** 建它时**传过去**的预设（`undefined` = 没传，由服务端按默认组装），复用要比对它。 */
      requestedPreset: string | undefined;
      /** 服务端定下来的预设（`session/create` 的返回值），复用时给域一个初值。 */
      preset: string | undefined;
    }
  >();
  /**
   * 部署提供的 agent 预设目录（`agentPresets/list`），连上后取一次。
   *
   * 空表 = 这个部署没有预设（插件没装、或根目录里一个都没有），界面据此什么都不
   * 渲染。允许不允许选择由 `agentPresetSelectable` 单独表示，两者合成界面上的那份
   * 外观态。
   */
  private agentPresetOptions: NonNullable<ChatState["agentPresets"]>["options"] = [];
  private agentPresetSelectable = false;
  /** roster 的**原始值**：可见性判据有两个输入，两条到齐再折算一次（见 `publishAgentPresets`）。 */
  private agentPresetRoster: unknown;
  /** 上一次折算结果的签名：两个输入各自到达时都折算，结果没变就不发帧。 */
  private agentPresetSignature = "";
  /**
   * 客户端这一侧的「允许选择预设」偏好（宿主 `ui-settings` 的 `enabled`，官方前端内部叫
   * developer tools、rc.2 的界面名是「代码工作工具」）。`undefined` = 还没读到，按**允许**
   * 处理——官方 schema 的默认值就是 `true`，而官方前端在值到达前按 `false`；本扩展刻意
   * fail-open，免得连接初期那枚胶囊闪一下。0.1.7-rc.2 起服务端不再有选择策略，这个偏好
   * 就是唯一还读得到的信号。
   */
  private developerToolsEnabled: boolean | undefined;
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
   * 已知的**子代理会话 id** 集合（不持久化，内存即可：两路来源都会很快重建）。
   *
   * 用途只有 @ 提及的「对话候选」过滤（`queryFiles`，用户 2026-09-22 口径：@ 列表
   * 不显示子代理会话）——候选 RPC 的行不带 `origin`，只能客户端自己对。两路来源：
   *
   * - `session/list` 原始行 `origin === 'subagent'`（`refreshSessions` 打底，
   *   覆盖别的窗口/进程建出来的子代理）；
   * - 子代理目录的并入点 `mergeSubagentEntries`（catalog durable 事件、
   *   `subagents/list` RPC、`subagentCatalog` 投影都走它，实时补充）。
   */
  private readonly subagentSessionIds = new Set<string>();
  /**
   * 子代理会话的**驻留状态**（`session/list` 原始行的 `running`，随每次刷新覆盖）。
   *
   * 子代理不进界面列表（`sessionList.ts` 滤掉），但「恢复到子代理页」时域的 running
   * 打底需要它——那是唯一不依赖父会话域开着的来源（`api-session/status` 中继只在
   * 状态变化时发，重载窗口前的最后一次变化早过去了）。
   */
  private readonly subagentRunning = new Map<string, boolean>();
  /**
   * 本地已删除的会话 id 集合（持久化于 globalState 的 `deletedSessionIds`）。
   *
   * 服务端**没有**会话删除/detach API：当前 dsh 进程打开过的会话常驻服务端内存
   * 直到进程退出，删掉本地日志目录后 `session/list` 仍会列出它们。扩展因此把
   * 删除过的 id 持久化下来，从历史/归档两个列表里永久过滤，界面不再显示。
   */
  private readonly deletedSessionIds: Set<string>;
  /**
   * 「生成完毕还没看过」的会话 id 集合（持久化于 globalState 的 `unreadSessionIds`）。
   *
   * **只有一条来路**：离开标记 `leftGeneratingSessionIds`——我离开时那条会话正在生成，
   * 它收尾的那一刻（见 `settleRunningChange`）记成未读。任一窗口打开它
   * （`bindViewToSession`）即清除；新一轮开始时先让位给「运行中」，那一轮收尾后再亮。
   * 历史列表里这些行的标题与运行中一样显示蓝色，提醒「它已经生成完了，结果还没看」。
   * 持久化是为了跨扩展重载保留——服务端的 `session/list` 不知道这个概念，列表整份替换时
   * 也由这里回填。
   */
  private readonly unreadSessionIds: Set<string>;
  /**
   * 「离开标记」：**我离开过一条正在生成的会话，且还没回来看**（用户 2026-09-24 口径）。
   *
   * 「离开」＝一条视图与**正在生成**的会话解绑，且解绑后本窗口再没有别的视图开着它。
   * 三个入口都走 `noteSessionLeft`：切到别的会话（`bindViewToSession`）、新建对话
   * （`detachView`）、关闭视图（`unbindView`）。任何视图重新绑上它即作废标记——回来看过
   * 它结束就不算撇下。
   *
   * **未读只有这一条来路**：没有标记就什么都不记。此前那条口径是「观察到某条会话从运行中
   * 落到结束、且此刻没人在看」，它会把**别处跑起来（另一个窗口 / dsh web / CLI）、本窗口
   * 从没打开过**的会话也点亮，「离开」这个动作本身反而不在判据里。
   *
   * 标记描述的是「我离开过这条会话的生成、且还没回来看」这件事，**一直留到用户回来**
   * （`bindViewToSession` 里作废）：离开之后它连跑几轮，每一次收尾都还会亮蓝，直到被看过。
   *
   * **只在内存里，不持久化**：扩展重载后「我离开过」这件事无从谈起（那一次的收尾也没被
   * 观察到），重载期间跑完的不补记未读。兑现的投影在 `settleRunningChange`。
   */
  private readonly leftGeneratingSessionIds = new Set<string>();
  /**
   * 草稿与附件按会话隔离：切换会话时输入框文本与附件芯片一起切换。
   * 已绑定会话的窗口用会话 id 做键（同会话的多窗口共享）；**未绑定**的窗口用
   * 自己的 viewId 做键（各自暂存，建会话时迁移到会话键，见 `bindViewToSession`）。
   */
  private readonly drafts = new Map<string, string>();
  private readonly attachmentsBySession = new Map<string, Attachment[]>();
  /**
   * 乐观回显账本（见 `shared/chat.ts` 的 `PendingMessageView`）。
   *
   * **只收「已经发出去」的那一类**：按下发送那一刻 agent 空闲 = 这一次会立刻
   * `session/prompt`。运行中发送（排队 / 插话）不进这张表——它还没发出去，唯一的去处是
   * 输入框上方的排队区（服务端队列名册驱动，`syncQueue` 那条路本次一个字没动），
   * 它的成功与失败都走改动前那条老路（用户 2026-09-25 口径）。
   *
   * 键与草稿 / 附件**同一套**（`keyForView`）：已绑定会话的窗口用会话 id，未绑定的
   * 用 viewId；绑定那一刻在 `bindViewToSession` 里跟着迁移——**第一条消息必须迁**，
   * 否则 `createSession` 绑定后立刻推的那份整份快照会把回显抹掉（快照里的
   * `pendingMessages` 读的正是这张表）。
   *
   * 条目在三条路上被收回（都在 `retireEcho` / `retireEchoByText` 收口）：durable
   * `user/message` 承认、这条没能发出去、用户撤回。没有 TTL：正常寿命是「一个发送往返」，
   * 而按时间清会把正在等承认的那一条误伤；跨会话切换**不丢**（失败的那行要能切回来
   * 接着操作，见 `destroyScope`），只有窗口下线与上限淘汰会清。
   */
  private readonly pendingMessages = new Map<string, PendingMessageView[]>();
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
   * 部署默认的权限预设（配置文件 `permission.defaultPreset`，经 `settings/describe`）。
   * 空态页的权限胶囊在会话建出来之前退回这个值——它正是服务端给新会话装的初始预设，
   * 所以「界面显示什么」与「新会话实际以什么权限启动」同源。全局一份：它是部署配置。
   */
  private defaultPermission: string | undefined;
  /**
   * 上面两个部署级默认是否已经读过（一次 `settings/describe` 同时取两样）。
   * 读过了就不再发 RPC；配置热重载（`reloadSettings`）清掉它强制重读。
   * 没有这道闸，「配置里恰好没有 `agent-default-model`」的部署会每次建域都白打一次 RPC。
   */
  private defaultsLoaded = false;
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
   * 外部连接一掉线就再也不重试（`DshClient` 自己也带退避重连）。
   */
  private autoReconnect = true;
  /**
   * **两轴探测结论**：内部守护进程在不在跑、外部备用地址可不可达（同一次心跳刷新）。
   *
   * 这是**本窗口的观测**，不是管理器快照的镜像：快照里没有这两个值（内部那一轴要
   * `probeRunning()` 问"守护进程进程还在吗"、外部那一轴要发一次 HTTP，都是异步的，
   * 见 `docs/design-supervisor.md`「两条存在性判据」）。它们只在 `probeFacts()` / `setFacts()` / `setInternalRunning()` 三处写入，
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
    this.unreadSessionIds = new Set(this.state.get<string[]>("unreadSessionIds") ?? []);
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
    // （按钮态给的是「启动内部 DSH」，点它与「连接内部 DSH」是同一套逻辑，见 `docs/design-supervisor.md`「连接条按钮矩阵」）。
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
    // 这条会话，标签也该跟着走。子代理面包屑的左半（父会话标题）也在这里跟进
    if (frame.type === "patch" && frame.patch.session !== undefined) {
      this.syncPanelTitle(sessionId);
      this.syncSubagentContext(sessionId);
      // **正在看子代理**的页面：它自己的标题（描述符 label / 自动标题）刚落进来，
      // 它在父目录里那一行的 label、以及触发器上的名字要跟着重推——否则切换列表
      // 与标题各显示一个名字（2026-09-24 的现场：列表 uuid、标题自动名）
      const selfScope = this.scopes.get(sessionId);
      if (selfScopeHasAddress(selfScope)) {
        this.deliver(sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(selfScope), ["subagent"]),
        });
      }
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

  /**
   * 新会话落在哪个目录。
   *
   * **只用在「已经确定有目录」的时刻**：建会话之前 `ensureSession` 已经问过了
   * （打开着文件夹、或用户选过一个）。最后那一级 `process.cwd()` 是兜底——它是
   * 扩展宿主的 cwd（VS Code 的安装路径），**不该**被当成用户的工作目录，所以
   * 新会话那条路绝不会走到它（见 `askWorkspaceDir`）；这里留着只是给别的调用点
   * （会话 cwd 解析等）一个字符串。
   */
  private workspacePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return folder.uri.fsPath;
    return this.newSessionCwd ?? process.cwd();
  }

  /**
   * 空态页上那一行工作目录提示（`locked` = 跟随 VS Code 打开的文件夹，不可改）。
   *
   * `locked` 为真时**没有可选目录**；为假时 `path` 可能还是空的（用户没打开文件夹、
   * 也没选过目录）——那时界面显示「未选择工作区」，不再拿宿主的 `process.cwd()` 冒充
   * （那会变成 VS Code 的安装路径，用户 2026-09-22 报的现场）。
   */
  private workspaceView(): NonNullable<ChatState["workspace"]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return { path: folder.uri.fsPath, locked: true };
    // 没有打开文件夹：用户选过的那个目录；**没选过就是空串**——界面显示
    // 「未选择工作区」。绝不拿宿主的 `process.cwd()`（= VS Code 安装路径）冒充一个
    // 工作目录（用户 2026-09-22 报的现场）。
    return { path: this.newSessionCwd ?? "", locked: false };
  }

  /** 部署的 agent 预设目录（外观态那一份；空表表示这个部署没有可选项）。 */
  private agentPresetsView(): NonNullable<ChatState["agentPresets"]> {
    return { options: this.agentPresetOptions, selectable: this.agentPresetSelectable };
  }

  /**
   * 一个窗口要建的会话用哪个 agent 预设：**用户点过的 > 配置项 > 服务端默认**。
   *
   * 没有窗口（命令面板等）时只认后两级。返回 undefined 表示「不指定」——调用方
   * 整个字段都不传，由服务端组装它自己的默认预设。
   */
  private agentPresetFor(viewId: string | undefined): string | undefined {
    if (viewId) {
      const picked = this.viewAgentPreset.get(viewId);
      if (picked) return picked;
    }
    const configured = readAgentPreset();
    if (configured) return configured;
    // 服务端在 roster 里标了哪个是默认（`isDefault`）；认不出就不指定
    return this.agentPresetOptions.find((option) => option.isDefault)?.id;
  }

  /**
   * 还没有会话的窗口要显示的那几项**待建会话**预览值（喂给 `sessionSourceOf` 的
   * `pending` 那一路）。
   *
   * 只有会话建出来之前就有意义的三项：
   * - **预设 / 模型**：用户点过的优先——否则点完像没反应；
   * - **权限 / 模型**：没有用户选择时退回部署默认（配置文件读出来的
   *   `defaultPermission` / `defaultModel`）——空态页显示的就是新会话将要以什么
   *   权限、什么模型、什么思考强度启动，而不是词典里编出来的某个档位。
   *
   * 别的字段一个都不掺——它们要么不属于窗口（工作目录走外观态），要么离开会话
   * 就没有意义。
   */
  private pendingViewFields(viewId: string | undefined): Parameters<typeof sessionSourceOf>[3] {
    if (!viewId) return undefined;
    return {
      model: () => this.viewModel.get(viewId) ?? this.defaultModel,
      permission: () => this.viewPermission.get(viewId) ?? this.defaultPermission,
      agentPreset: () => this.agentPresetFor(viewId),
    };
  }

  /** 未绑定窗口的会话片段来源（推补丁时用：域必然为空，只有待建预览值）。 */
  private pendingSessionSource(viewId: string): SessionViewSource {
    return sessionSourceOf(undefined, undefined, this.models, this.pendingViewFields(viewId));
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
          sessionId ? this.summaryOfSession(sessionId) : undefined,
          this.models,
          // 空态（未绑定窗口）：预设与模型两枚胶囊显示**待建会话**的预览值，
          // 因为那时会话还不存在（见 `pendingViewFields`）
          scope ? undefined : this.pendingViewFields(viewId),
          this.subagentContextOf(scope),
        ),
      ),
      // 输入区那三个字段按**窗口**存（未绑会话时）/ 按会话键存，不属于会话状态片段：
      // 它们由输入框那条链单独维护，这里只补进快照（见 `keyForView`）。
      attachments: this.attachmentsBySession.get(sessionId ?? viewId ?? "") ?? [],
      draft: this.drafts.get(sessionId ?? viewId ?? "") ?? "",
      // 乐观回显同理按窗口键存：**空表也要发**，否则切会话时上一条会话的回显留在界面
      pendingMessages: [...(this.pendingMessages.get(sessionId ?? viewId ?? "") ?? [])],
    };
  }

  /**
   * 增量 patch 用的取值来源：与首帧快照**同一个** `sessionSourceOf`，只是这里不需要
   * 会话摘要（patch 从不改 `session` 本身，标题那条路有自己的 `sessionWithTitle`）。
   * 子代理上下文（`subagent` 键）由域上的地址现算：父目录 / 父标题变了，下一次
   * patch 自然带上新值。
   */
  private sessionSource(scope: SessionScope | undefined): SessionViewSource {
    return sessionSourceOf(scope, undefined, this.models, undefined, this.subagentContextOf(scope));
  }

  /**
   * 会话摘要：会话列表行优先；**子代理会话不在列表里**（`sessionList.ts` 滤掉了），
   * 用子代理目录行合成一份（标题 = 目录里的 label，父会话 id 来自地址）。
   * 首帧快照与编辑区标签标题共用这一个读法，两者看到的子代理名字必然一致。
   */
  private summaryOfSession(sessionId: string): SessionSummaryView | undefined {
    const row = this.sessions.find((session) => session.id === sessionId);
    if (row) return row;
    const scope = this.scopes.get(sessionId);
    const address = scope?.subagentAddress;
    if (!scope || !address) return undefined;
    return {
      id: sessionId,
      title: this.subagentLabelOf(scope),
      updatedAt: Date.now(),
      running: scope.running,
      parentSessionId: address.parentSessionId,
    };
  }

  /** 子代理会话的显示名：目录行里的 label；目录里找不到时退回会话 id。 */
  private subagentLabelOf(scope: SessionScope): string {
    const siblings = this.parentCatalogOf(scope);
    return siblings.find((entry) => entry.id === scope.sessionId)?.label ?? scope.sessionId;
  }

  /**
   * 子代理域的**父目录**（兄弟行）：父会话域还开着时用它的实时目录，否则用进入时
   * 抄下的快照。两者都空时至少要含自己——自己的地址必然成立（进得来就说明成立）。
   *
   * 兜底行的 label 用**描述符 label**（适配器记的目录条）而不是会话 id：id 是一串
   * uuid，用户没法把它和真实标题对上（切换列表与标题不一致的现场，2026-09-24）。
   * 描述符 label 由 follow 流重放注册进本域（`subagent/descriptor` → `selfEntry`），
   * 它就是官方目录行显示的那个名字。
   */
  private parentCatalogOf(scope: SessionScope): SubagentView[] {
    if (!scope.subagentAddress) return [];
    const parentScope = this.scopes.get(scope.subagentAddress.parentSessionId);
    const entries = parentScope ? parentScope.subagentEntries : scope.subagentSiblings;
    const existing = entries.find((entry) => entry.id === scope.sessionId);
    if (existing) {
      // 目录行缺 label（旧事件 / 投影没带）时用本会话已知的显示名补齐——
      // 触发器、列表行与标签标题三处读到的是同一个名字
      if (existing.label === scope.sessionId) {
        const known = this.subagentDisplayName(scope);
        if (known && known !== existing.label) {
          const next = entries.map((entry) =>
            entry.id === scope.sessionId ? { ...entry, label: known } : entry,
          );
          if (parentScope) parentScope.subagentEntries = next;
          else scope.subagentSiblings = next;
          return next;
        }
      }
      return entries;
    }
    return upsertSubagent(entries, {
      id: scope.sessionId,
      label: this.subagentDisplayName(scope) ?? scope.sessionId,
      mode: scope.subagentAddress.mode,
      activity: scope.running ? "running" : "inactive",
    });
  }

  /**
   * 当前子代理会话的**显示名**，按权威程度取：
   * 1. **描述符 label**（本会话日志里的 `subagent/descriptor`，派生时的 `description`
   *    ——官方目录行显示的就是它，continuable 必带）；
   * 2. 会话标题投影 / `session/title`（自动标题）；
   * 3. 都拿不到（刚进会话、流还没开）→ undefined，调用方退回会话 id。
   */
  private subagentDisplayName(scope: SessionScope): string | undefined {
    return scope.adapter?.selfDescriptorLabel() ?? scope.adapter?.sessionTitle() ?? undefined;
  }

  /**
   * 父会话域不在时（恢复路径直接落到子代理页），用 `session/projections` 把父目录
   * 补进兄弟快照——那是一条**单发 RPC**，不像开父会话域那样要拉起整条 follow 流。
   * 失败（含旧服务端没有这条路由的 404）只是下拉里少几个兄弟行，面包屑与返回
   * 不受影响（它们靠地址本身，不靠目录）。
   */
  private async fetchParentCatalog(scope: SessionScope): Promise<void> {
    const parentId = scope.subagentAddress?.parentSessionId;
    if (!this.client || !parentId) return;
    try {
      const value = await this.client.sessionProjections(parentId);
      const entries = subagentCatalogFromProjection(value?.values?.subagentCatalog);
      if (!entries.length) return;
      // **并入，不清表**（与目录三条来源同一条纪律）：本地已知的行（切换种子、
      // status 中继带来的驻留状态、label 回填）投影里没有就不该丢——投影按
      // asOfSeq 折叠，可能落后于本地刚发生的变化。投影行优先（较新），本地
      // 多出来的行原样保留。
      const known = scope.subagentSiblings;
      const merged = [
        ...entries.map((entry) => {
          const local = known.find((item) => item.id === entry.id);
          return local?.activity ? { ...entry, activity: local.activity } : entry;
        }),
        ...known.filter((item) => !entries.some((entry) => entry.id === item.id)),
      ];
      scope.subagentSiblings = merged;
      this.log(`[subagents] 会话=${scope.sessionId} 父目录（投影）${entries.length} 条`);
      // 补齐的是**本会话域**的父目录快照：把重算后的上下文直接发给看这个会话的窗口。
      // 不能写 syncSubagentContext(本会话id)——那条的参数语义是「父会话 id」，通知的
      // 是正在看它的**子代理**的窗口；看本会话的窗口一条都收不到，缺陷永不自愈
      // （2026-09-25 报障的根因之二，回归见 scripts/subagentSwitch.test.ts 场景二）。
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["subagent"]),
      });
    } catch (error) {
      this.log(`[subagents] 父目录投影读取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 界面上的子代理上下文（`ChatState.subagent`）：普通会话恒 `undefined`，
   * 子代理会话由地址 + 父会话摘要 + 父目录快照合成。
   */
  private subagentContextOf(scope: SessionScope | undefined): SubagentContextView | undefined {
    const address = scope?.subagentAddress;
    if (!scope || !address) return undefined;
    return {
      parentSessionId: address.parentSessionId,
      parentTitle: this.sessions.find((session) => session.id === address.parentSessionId)?.title ?? address.parentSessionId,
      mode: address.mode,
      parentEntries: this.parentCatalogOf(scope),
    };
  }

  /**
   * 父会话的目录变了：把新的上下文推给**正在看它子代理**的窗口。
   *
   * 界面上那条切换下拉的数据就是这里推的——用户停在子代理页时，父会话新注册了
   * 子代理（`registerSubagent`）、兄弟行跑了/停了（`syncSubagentActivity`）、投影或
   * RPC 刷新了目录（`deliverSubagentList` 的全部调用点），下拉都要跟上。
   */
  private syncSubagentContext(parentSessionId: string): void {
    for (const scope of this.scopes.values()) {
      if (scope.subagentAddress?.parentSessionId !== parentSessionId) continue;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["subagent"]),
      });
    }
  }

  /** 首帧快照里「与会话无关」的那一半（语言 / 排版 / 字号 / 批次 / 阈值 / 发送行为 / 新会话页）。 */
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
      /** 新会话的工作目录：空态页那一行提示（没有打开文件夹时界面可改）。 */
      workspace: () => this.workspaceView(),
      /** 部署的 agent 预设目录（空表 = 没有可选项，界面什么都不渲染）。 */
      agentPresets: () => this.agentPresetsView(),
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
  /**
   * 把一个已有的窗口绑到某个会话（恢复路径用：刷新会话列表 + 建域 + 推快照）。
   *
   * 与 `openSession` 的分工：那边是「用户点了历史里的一条」，只做重绑；这边是
   * 「工作区刚打开，这个窗口上次开的就是它」，多一步**先确认会话还在**——
   * 缓存是上一次运行留下的，会话可能已经被删掉或归档（服务端没有删除 API，
   * 本地删除只记了 id）。会话不在了就什么都不做，窗口保持空态。
   *
   * `subagent` 给出时目标是**子代理会话**：它不在会话列表里（列表是过滤过的），
   * 「还在不在」的判断跳过，能不能进由子代理地址的鉴权说了算——打不开时
   * `openSession` 的 follow 流会报错，域里是空记录，面包屑仍能点回父会话。
   */
  async restoreViewSession(
    viewId: string,
    sessionId: string,
    subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" },
  ): Promise<void> {
    if (this.viewSessions.get(viewId) === sessionId) return;
    // **自动路径**：跟随 `dshChat.autoConnect`——关掉自动连接时，恢复会话不该顺手
    // 把后台起起来或连上去（用户 2026-09-18 口径：那时界面只显示按钮，等用户点）
    if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: readAutoConnect() });
    if (!this.client || this.connection !== "connected") {
      this.log(`[restore] 未连接，跳过 ${sessionId}`);
      return;
    }
    if (subagent) {
      // 子代理会话：没有列表可查（也查不到），地址就是全部凭据
      this.log(`[restore] 窗口=${viewId} 接回子代理会话=${sessionId}（父会话=${subagent.parentSessionId}）`);
      await this.openSession(viewId, sessionId, subagent);
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
   * `setState` 存下的窗口身份，见 `webview/bridge.ts`）。它是**身份**：即使 VS Code
   * 恢复面板的顺序与当初不一致，也能各自接回自己的会话（用户 2026-09-21 报的
   * 「标签 1/2 的会话交叉」就是只靠顺序对位的固有缺陷）。
   */
  claimPanelRestore(viewId: string, known?: RestoreHint): void {
    if (!this.windowState.key) {
      this.panelClaimsQueued.push({ viewId, known });
      this.restoreAwaiting.add(viewId);
      this.log(`[restore] 工作区身份未就绪，面板 ${viewId} 的认领先排队`);
      return;
    }
    this.applyPanelClaim(viewId, known);
  }

  /** 面板认领的落点：按身份 / 按下标取会话，记一行日志（排查错位全看它）。 */
  private applyPanelClaim(viewId: string, known?: RestoreHint): void {
    const claimed = this.windowRestore.classifyPanel(known);
    this.log(
      `[restore] 面板 ${viewId} 认领：${claimed.by === "identity" ? "按身份" : "按顺序"}` +
        `（webview 存的是 ${known?.sessionId ?? "无"}）→ ${claimed.sessionId ?? "空态"}`,
    );
    this.applyRestoreHint(
      viewId,
      claimed.sessionId ? { sessionId: claimed.sessionId, subagent: claimed.subagent } : undefined,
    );
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
    const entry = this.windowRestore.slot(slot);
    this.applyRestoreHint(
      viewId,
      entry?.sessionId ? { sessionId: entry.sessionId, subagent: entry.subagent } : undefined,
    );
  }

  /** 该窗口有没有待接回的会话（`ChatViewProvider` 发 `ready` 前用它决定等多久）。 */
  hasRestoreHint(viewId: string): boolean {
    return this.restoreHints.has(viewId);
  }

  private applyRestoreHint(viewId: string, hint: RestoreHint | undefined): void {
    if (hint?.sessionId) this.restoreHints.set(viewId, hint);
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
    const hint = this.restoreHints.get(viewId);
    if (!hint) return;
    this.restoreHints.delete(viewId);
    await this.restoreViewSession(viewId, hint.sessionId, hint.subagent);
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
    // 子代理会话不在会话列表里：`summaryOfSession` 会用目录行合成标题（label）
    const title = panelTabTitle(this.summaryOfSession(sessionId)?.title);
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
    // 关掉的窗口也可能正是「看着它生成」的那个：先取状态，`dropViewers` 之后域就没了
    const wasGenerating = this.isSessionGenerating(sessionId);
    // 窗口关掉时它那条后台任务观察流必须一起收（否则流会跟着扩展宿主一直活着）
    this.closeJobWatch(viewId);
    this.viewSessions.delete(viewId);
    // 未绑定会话的窗口按 viewId 存回显：viewId 是每个 webview 实例现铸的（`chatView.attach`），
    // 这个键不会再有人用，连同清掉。绑过会话的那一份挂在**会话键**上、刻意留着（用户口径：
    // 失败的那行要能重新打开这条会话继续操作），窗口下线不构成删它的理由
    if (!sessionId) this.pendingMessages.delete(viewId);
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
    if (sessionId) this.noteSessionLeft(sessionId, wasGenerating);
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
    // 子代理地址跟着窗口走：正在看子代理的窗口重载后只有靠它才能重新进入
    const addressOf = (sessionId: string | undefined) =>
      sessionId ? this.scopes.get(sessionId)?.subagentAddress : undefined;
    // 编辑区面板：按 `viewOrder` 里出现的先后（= 创建顺序）逐条记，
    // 与 VS Code 恢复编辑器时的顺序一致
    for (const viewId of this.viewOrder) {
      if (this.viewKinds.get(viewId) !== "panel") continue;
      const sessionId = this.viewSessions.get(viewId);
      cache.panels.push({ sessionId: sessionId ?? null, subagent: addressOf(sessionId), lastActiveAt: now });
    }
    for (const [viewId, kind] of this.viewKinds) {
      if (kind === "panel") continue;
      const sessionId = this.viewSessions.get(viewId);
      cache[kind] = { sessionId: sessionId ?? null, subagent: addressOf(sessionId), lastActiveAt: now };
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
    scope.jobsHandle?.cancel();
    scope.jobsHandle = undefined;
    // 兜底：域回收时把这个会话下还挂着的观察流一起收（正常路径下视图离开会话时
    // 已经收过了，这里是「表里不许留没有归属的条目」的第二道）
    for (const [viewId, watch] of [...this.jobWatches]) {
      if (watch.sessionId === scope.sessionId) this.closeJobWatch(viewId);
    }
    scope.adapter = undefined;
    // 乐观回显**不跟着域一起丢**（用户 2026-09-25 口径）：账本里只有「已经发出去」的那一类，
    // 而它此刻要么还在等承认、要么已经失败——失败的那一行必须能"切走再切回来接着重发 /
    // 撤回"，而它不在会话内容里，删了就再也回不来。
    // 刻意**不动**状态：还在飞的那条本来就会由 live 流或重开的 durable 承认收回；凭「域没了」
    // 就把它改写成失败是替用户下结论（那条很可能已经发出去了，用户若据此点重发，同一条会发两遍）。
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
    // 换会话：这个窗口的后台任务观察流是**上一个会话**的，跟着一起收
    // （同一会话的重入在上面那行就返回了，展开中的面板不会被这次绑定打断）
    this.closeJobWatch(viewId);
    // 打开即已读：历史列表里那条「生成完毕未读」的蓝标题到此结束
    this.setSessionUnread(sessionId, false);
    // 回来看它了：离开标记作废（哪怕它还在生成——此刻用户就盯着它，收尾时不算撇下）。
    // 之后再离开会由下面那次 `noteSessionLeft` 重新记上
    this.leftGeneratingSessionIds.delete(sessionId);
    // 被换掉的那条会话「刚才在不在生成」必须在 `dropViewers` **之前**问：它是最后一个
    // 观察者时域会被整个销毁，之后再问就问不到了（见 `isSessionGenerating`）
    const previousWasGenerating = this.isSessionGenerating(previous);
    // 「待建会话」的参数到此为止：绑定之后预设/模型都由这条会话自己的状态说话，
    // 下次「新建对话」重新从配置项开始（见 `viewAgentPreset` 的字段注释）
    this.viewAgentPreset.delete(viewId);
    this.viewModel.delete(viewId);
    this.viewPermission.delete(viewId);
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
      // 乐观回显跟着迁：空态发第一条消息时它先落在窗口键上，而 `createSession`
      // 绑定之后立刻推的那份整份快照读的是**会话键**（见 `snapshotFor`）——
      // 不迁这一下，回显就被那一帧抹掉，正是「消息闪一下又没了」。
      // 绑定前会话键上不可能有回显（那条会话还没有窗口用过），直接搬即可。
      const pending = this.pendingMessages.get(viewId);
      if (pending) {
        this.pendingMessages.set(sessionId, pending);
        this.pendingMessages.delete(viewId);
      }
    }
    this.viewSessions.set(viewId, sessionId);
    scope.viewers += 1;
    // 「谁还在看哪条会话」此刻才是真相，离开标记必须在这之后判：切走时它若还在生成，
    // 且没有别的视图接着看，就记一笔（见 `noteSessionLeft`）
    if (previous) this.noteSessionLeft(previous, previousWasGenerating);
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
   * | `prepareRound()`（换目标 / 重开一轮 / 并发补跑共用） | `stop({ cancelWait: true })` | 那一轮还挂在旧目标**没有时长上限**的等待里，等于没换目标。**这一档不收连接**：马上要重新接上的是**同一个**后台（见 design-supervisor.md「停止连接的语义」），收掉 socket 等于交还占用，`ownership` 从 self 掉成 peer、诊断里"是不是本窗口拉起的"开始说谎 |
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

  /**
   * VS Code 打开 / 关掉了文件夹：空态页那一行工作目录要跟着变（含「可不可改」）。
   *
   * 目录本身由 `workspacePath()` 现读，所以这里只推一帧；**不**去动已经建好的会话
   * ——会话 header 的 cwd 是创建事实，换文件夹不该改写既有会话。
   */
  refreshWorkspace(): void {
    this.emitAll({ type: "patch", patch: { workspace: this.workspaceView() } });
  }

  /**
   * 取一次部署的 agent 预设目录（`agentPresets/list`），推给所有窗口。
   *
   * 两条口径：
   * - 插件没装（`gateway/invocation-unavailable`）时**当成空目录**而不是错误：
   *   「这个部署不提供预设」是合法部署，界面该什么都不显示，而不是弹一个失败提示；
   * - 其他失败只记日志、同样落成空目录：目录是**装饰性**的（拿不到就不给选择入口），
   *   为它打断连接流程或弹错误都不成比例。
   *
   * 目录只是判据的一半（另一半是客户端的开发者工具偏好），所以这里只负责把原始值
   * 记下来，折算与发帧统一走 `publishAgentPresets`。
   */
  private async loadAgentPresets(): Promise<void> {
    if (!this.client) return;
    let value: unknown;
    try {
      value = await this.client.listAgentPresets();
    } catch (error) {
      if (error instanceof DshApiError && error.code === "gateway/invocation-unavailable") {
        // 插件没装 = 这个部署没有预设目录，按「空目录」折算（形状认不出时
        // `agentPresetsFromList` 给的正是 `{options: [], selectable: false}`）
        this.agentPresetRoster = undefined;
        this.publishAgentPresets();
        return;
      }
      this.log(`[preset] 预设目录获取失败：${this.describeError(error)}`);
      return;
    }
    this.agentPresetRoster = value;
    this.publishAgentPresets();
  }

  /**
   * 用当前的两个输入（roster 原始值 + 客户端偏好）折算预设目录，变了才推给窗口。
   *
   * 两个输入**到达顺序不定**（目录在一次 RPC 之后、偏好在 `settings/describe` 之后，
   * 两者都由连接流程并发发起），所以两边各自到达时都调这里；判据本身只有
   * `agentPresetsFromList` 一处实现。折算结果没变就一个帧都不发——设置热重载
   * （`settings/document-updated` 会让偏好重新读一遍）不会无谓刷界面。
   */
  private publishAgentPresets(): void {
    const view = agentPresetsFromList(this.agentPresetRoster, this.developerToolsEnabled !== false);
    const signature = JSON.stringify(view);
    if (signature === this.agentPresetSignature) return;
    this.agentPresetSignature = signature;
    this.agentPresetOptions = view.options;
    this.agentPresetSelectable = view.selectable;
    this.log(
      `[preset] 预设目录：${
        view.selectable ? `${view.options.length} 个` : "不可选择（服务端策略或客户端偏好）"
      }`,
    );
    this.emitAll({ type: "patch", patch: { agentPresets: this.agentPresetsView() } });
    this.pushPendingPresets();
  }

  /**
   * 给每个**空态**窗口补一帧 `agentPreset`。
   *
   * 空态页上那枚胶囊显示的是「待建会话会用哪个预设」，而它的最后一级是 roster 里标了
   * `isDefault` 的那条——目录没到之前算不出来（首帧快照发的是 null，之后又没有别的
   * 机会重推）。所以目录一到就把这份结论补发给还没绑定会话的窗口。
   */
  private pushPendingPresets(): void {
    for (const viewId of this.unboundViews()) {
      this.emitToView(viewId, {
        type: "patch",
        patch: sessionPatch(this.pendingSessionSource(viewId), ["agentPreset"]),
      });
    }
  }

  /** 当前处于空态（没有绑定会话）的窗口。 */
  private unboundViews(): string[] {
    return this.viewOrder.filter((viewId) => !this.viewSessions.has(viewId));
  }

  /**
   * 给当前**空白会话**换 agent 预设（`agentPresets/select`）。
   *
   * 失败一律如实报出来（服务端对已开始的会话回 `agent-preset/locked`，对不存在的
   * id 回 `agent-preset/not-found`，两者都带 `details.reason`）：这是用户刚刚做的
   * 一次明确选择，静默回退会让标签莫名其妙地弹回原值（官方也因此把拒绝做成横幅）。
   */
  private async selectAgentPreset(viewId: string, id: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!scope) {
      // 还没有会话：这是**待建会话**的参数（用户 2026-09-22 口径），不建记录、
      // 也不发 RPC——建会话时随 `session/create` 一起指定（见 `createSession`）。
      this.viewAgentPreset.set(viewId, id);
      this.emitToView(viewId, {
        type: "patch",
        patch: sessionPatch(this.pendingSessionSource(viewId), ["agentPreset"]),
      });
      return;
    }
    if (scope.agentPreset === id) return;
    if (!this.client) return;
    try {
      const applied = await this.client.selectAgentPreset(scope.sessionId, id);
      scope.agentPreset = applied;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["agentPreset"]),
      });
    } catch (error) {
      const details = error instanceof DshApiError ? error.details : undefined;
      const reason =
        details && typeof (details as { reason?: unknown }).reason === "string"
          ? (details as { reason: string }).reason
          : error instanceof Error
            ? error.message
            : String(error);
      this.log(`[preset] 切换失败（${id}）：${reason}`);
      this.emitToView(viewId, { type: "toast", level: "warn", text: `@agentPresetFailed:${reason}` });
    }
  }

  private async onConnected(): Promise<void> {
    // socket 重建后长活流都要重开：每个打开的域重新跟随（适配器整个重建，
    // 新快照会重放最近 60 条），全局流重开一次
    for (const scope of this.scopes.values()) {
      this.openScopeFollow(scope);
      this.openScopeJobs(scope);
    }
    // 后台任务的观察流也要重开（它不是域上的流，是按窗口跟踪的）：用**原 watchId**
    // 与**原续传游标**重开，界面那边已累积的文本接着往后长——换了号界面会把它当成
    // 另一轮观察，先前那段输出就白看了
    for (const [viewId, watch] of [...this.jobWatches]) {
      if (!this.scopes.has(watch.sessionId)) {
        this.closeJobWatch(viewId);
        continue;
      }
      this.openJobWatch(viewId, watch.sessionId, watch.jobId, watch.watchId, watch.from);
    }
    // 适配器刚被整个重建，卡片要重新回放一遍。**不删账本条目**——条目留到真正结算
    // （见 `interactions` 的注释），否则「重连 → 切会话 → 切回来」这条路上卡片又会
    // 消失。服务端重连后重投递的 waterfall 会被去重记账幂等放行，不会重复弹卡片；
    // 回放本身也按 requestId 去重。
    for (const scope of this.scopes.values()) this.replayHeldToScope(scope.sessionId, scope);
    // 子代理目录也跟着重拉一次（官方 `handleConnected` 同款）：掉线期间建立的子代理
    // 在那段时间没有任何帧能到，而重放只覆盖跟随窗口——不重拉就漏掉窗口外的那些。
    for (const scope of this.scopes.values()) void this.refreshSubagentCatalog(scope);
    this.openControlStream();
    this.openEventsStream();
    this.openWorkspaceStream();
    // 预设目录与工作目录提示都是空态页要用的东西，连上就取一次（目录是部署级的，
    // 与具体会话无关；工作目录直接现读 VS Code，不发请求）
    void this.loadAgentPresets();
    this.refreshWorkspace();
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
      // @ 提及候选过滤的打底（判据与用途见 `subagentSessionIds` 与 sessionList.ts）
      for (const item of value.items ?? []) {
        if (item.origin === "subagent") {
          this.subagentSessionIds.add(item.sessionId);
          // 子代理会话不在界面列表里，但它的 running 服务端照样给：
          // 恢复到子代理页时域要拿它打底（见 ensureScope 的 running 打底注释）
          if (typeof item.running === "boolean") {
            this.subagentRunning.set(item.sessionId, item.running);
          }
        }
      }
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
      // 列表整份替换也会造成 running 变化（服务端算的权威值落下来），同样要结算
      // 「生成完毕未读」——上面的 `setSessionRowRunning` 只覆盖 `api-session/status`
      // 中继那一条路。比较基准是替换前的旧行；启动时旧列表为空，没有可结算的。
      const oldRunning = new Map(this.sessions.map((item) => [item.id, item.running]));
      for (const view of views) {
        const was = oldRunning.get(view.id);
        if (was === undefined || was === view.running) continue;
        this.settleRunningChange(view.id, view.running);
      }
      this.sessions = views;
      // 复用名册按**服务端**的 `blank` 位清理：它一说这条会话已经开始过对话（或它
      // 不在列表里了），就不再是可复用的空会话。判据只认服务端，不认本地计数器。
      for (const id of [...this.createdBlankSessions.keys()]) {
        const row = views.find((item) => item.id === id);
        if (!row || row.blank !== true) this.createdBlankSessions.delete(id);
      }
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
    // 子代理的驻留状态**先同步**：这条中继对每个 agent 都发，子代理也在内。它与下面那条
    // `acceptSessionStatus` 判断无关（那条规则是给「窗口绑定的会话」用的，子代理没有本地
    // 日志证据可依），所以放在前面、不受它拦截。
    this.syncSubagentActivity(status.sessionId, status.running);
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
    this.settleRunningChange(sessionId, running);
    this.emitSessionLists();
  }

  /**
   * running 变化时的**未读结算**（两个入口共用：`api-session/status` 中继与
   * `refreshSessions` 的列表差分）。
   *
   * 未读只有一条来路——离开标记（见 `leftGeneratingSessionIds`）：
   *
   * - 新一轮开始（false→true）：旧未读让位给「运行中」——蓝色此刻由 running 负责。
   *   **标记留着**：用户还没回来看过，这一轮收尾时它还得亮（离开后连跑几轮的情形，
   *   比如离开前发了两条、后一条排在队列里自动接续）；
   * - 收尾（true→false）：有标记、且此刻没有视图开着它，才记未读。
   *
   * 没有标记就什么都不做：会话在别处跑起来（另一个窗口 / dsh web / CLI）、或离开时它
   * 本来空闲，都不该在列表里亮蓝。
   */
  private settleRunningChange(sessionId: string, running: boolean): void {
    if (running) {
      this.setSessionUnread(sessionId, false);
      return;
    }
    if (!this.leftGeneratingSessionIds.has(sessionId)) return;
    if (this.isSessionViewed(sessionId)) return;
    this.setSessionUnread(sessionId, true);
  }

  /**
   * 离开一条会话时的记账（在 `viewSessions` 已不再指向它之后调用）。
   *
   * `wasGenerating` 必须由调用方在**域被回收之前**取好：`dropViewers` 会把最后一个观察者
   * 离开的域整个销毁，之后再问「它刚才在不在生成」就问不到了（见 `isSessionGenerating`）。
   * 本窗口还有别的视图开着它就不算离开——那只是换了个窗口看。
   */
  private noteSessionLeft(sessionId: string, wasGenerating: boolean): void {
    if (!wasGenerating || this.isSessionViewed(sessionId)) return;
    if (this.leftGeneratingSessionIds.has(sessionId)) return;
    this.leftGeneratingSessionIds.add(sessionId);
    this.log(`[unread] 离开生成中的会话=${sessionId}：它收尾时记成未读`);
  }

  /**
   * 这条会话此刻在不在生成。
   *
   * 域上的值优先：**发送即乐观置位**（见 `send` 里的 `scope.running = true`），那一刻
   * 服务端的 `api-session/status` 还没到、会话列表那一行也还是 false——只读行上的值，
   * 「发完消息立刻切走」这个最常见的场景就会漏掉离开标记。行上的值只是兜底（域不存在时：
   * 别的窗口先开过它、或它的域已被回收）。
   */
  private isSessionGenerating(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    if (this.scopes.get(sessionId)?.running === true) return true;
    return this.sessions.some((item) => item.id === sessionId && item.running);
  }

  /** 本窗口还有没有视图开着这条会话。 */
  private isSessionViewed(sessionId: string): boolean {
    for (const bound of this.viewSessions.values()) {
      if (bound === sessionId) return true;
    }
    return false;
  }

  /** 记/清一条「生成完毕未读」，有变化才持久化并刷新两个列表。 */
  private setSessionUnread(sessionId: string, unread: boolean): void {
    if (this.unreadSessionIds.has(sessionId) === unread) return;
    if (unread) this.unreadSessionIds.add(sessionId);
    else this.unreadSessionIds.delete(sessionId);
    void this.state.update("unreadSessionIds", [...this.unreadSessionIds]);
    this.emitSessionLists();
  }

  /** 真正展示给界面的两个列表（所有窗口共享同一份会话列表）。 */
  private emitSessionLists(): void {
    const active: SessionSummaryView[] = [];
    const archived: SessionSummaryView[] = [];
    for (const session of this.sessions) {
      // **还没开始对话**的空会话不进历史列表（服务端的 `blank` 位，官方会话列表同一
      // 口径：`api/session-controller` 的 `SessionSummary.blank` 由消费者过滤）。
      // `/`、`@` 菜单会在空态按需建一条这样的会话（见 `ensureSessionForMenu`），不挡住
      // 它就会在列表里留一行空记录——正是用户 2026-09-22 报的现场。它仍留在
      // `this.sessions` 里：cwd 解析、恢复窗口、复用都要读这一行。
      if (session.blank === true) continue;
      // unread 不落在行对象上（列表整份替换时行是新建的），按权威集合现算
      const row: SessionSummaryView = {
        ...session,
        unread: this.unreadSessionIds.has(session.id),
      };
      (this.archivedSessionIds.has(session.id) ? archived : active).push(row);
    }
    this.emitAll({ type: "sessions", sessions: active });
    this.emitAll({ type: "archivedSessions", sessions: archived });
  }

  /**
   * 已知的**空会话 id** 集合（服务端的 `blank` 位）。
   *
   * 用途只有一个：`@` 提及的对话候选过滤（见 `queryFiles`）。候选 RPC 会给全量会话，
   * 而列表里被挡住的空会话不该从 `@` 那条路漏出来。
   */
  private blankSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const row of this.sessions) {
      if (row.blank === true) ids.add(row.id);
    }
    return ids;
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
    if (this.isSessionViewed(sessionId)) {
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
    // 只有**VS Code 打开的文件夹**才注册成工作区：没有文件夹时用户挑的那个目录
    // （`newSessionCwd`）只是个落脚点，把它注册进服务端的工作区注册表是另一回事
    // （那会长期留在 Web 的侧栏里），会话按 cwd 建、落在「未分组」——与用户口径
    // 「和以前一样，是未分组会话」一致。
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
   * 「新建对话」：把这个窗口**退回空态**，**不建会话记录**。
   *
   * 用户 2026-09-22 口径：没有发出第一条消息之前不该在列表/服务端留下会话记录——
   * 此前点一次「+」就建一条空会话，选个目录又建一条，列表里攒一串没人用过的空会话。
   * 现在会话在**第一次真正需要它**的时候才建（发消息、加附件、跑命令，见 `ensureSession`），
   * 预设 / 模型 / 工作目录这些空态页上的选择都只是**待建会话的参数**。
   *
   * 没有窗口可退（命令面板入口且没有活动窗口）时什么都不做：没有窗口就没有「下一次
   * 发送」，建出来的记录没人用得上。
   */
  async newSession(viewId?: string): Promise<void> {
    if (!viewId) {
      this.log("[new] 没有活动窗口，「新建对话」不建会话（会话在发第一条消息时建）");
      return;
    }
    this.detachView(viewId);
    // 整份快照：空态要把上一个会话的消息/队列/目标/计划模式/投影一次归零
    // （增量 patch 没覆盖 model/goal/jobs/planMode/permission，残留会漏过去）
    this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
  }

  /**
   * 把窗口落到一条**真实会话**上（已经有就原样返回，没有就建一条并绑上）。
   *
   * 只有真正要跟服务端打交道的地方才调它——发消息、加附件、执行命令，以及
   * **打开 `/` 或 `@` 菜单**（这两个菜单的内容都是会话作用域的服务端目录，
   * 见 `ensureSessionForMenu`）。空态页上的预览型选择（预设、模型）**不**走这里，
   * 它们只记进 `viewAgentPreset` / `viewModel`。
   *
   * 建会话要先有工作目录：打开着文件夹就是它，否则用用户选过的那个；两个都没有时
   * **就地弹一次目录选择器**（用户 2026-09-22 拍板：不编造默认路径，也不封死发送）。
   * 这一步是**用户显式动作**的一环，允许拉起后台。菜单那条路不弹这个框——它走
   * `ensureSessionForMenu` 先判目录。
   *
   * **同一个窗口的并发调用共用一次尝试**：`@` 候选每敲一个字符重取一次，不合并就会
   * 各建一条会话（见 `sessionEnsures`）。
   *
   * @returns 会话域；用户取消了目录选择、或客户端不可用 → undefined（调用方什么都不做，
   *          草稿留在输入框里）。
   */
  private async ensureSession(viewId: string): Promise<SessionScope | undefined> {
    const existing = this.scopeOfView(viewId);
    if (existing) return existing;
    const inflight = this.sessionEnsures.get(viewId);
    if (inflight) return await inflight;
    const attempt = (async (): Promise<SessionScope | undefined> => {
      if (!this.client || this.connection !== "connected") {
        await this.ensureConnected({ start: true });
      }
      if (!this.client) return undefined;
      // 连接与目录这两步都可能让**别的路径**先把这个窗口绑到一条会话上（用户点了历史
      // 里的一条）：绑定是既成事实，就按它走，不再自己建一条把它顶掉
      const bound = this.scopeOfView(viewId);
      if (bound) return bound;
      if (!(await this.askWorkspaceDir())) return undefined;
      return await this.createSession(viewId);
    })();
    this.sessionEnsures.set(viewId, attempt);
    try {
      return await attempt;
    } finally {
      this.sessionEnsures.delete(viewId);
    }
  }

  /**
   * 菜单（`/` 命令栏、`@` 候选）要的那份目录同样是**会话作用域**的：服务端的
   * `commands/list` 与 `fileReferences/list` 都是 `@RemoteScope('agent')`，按
   * `agentId` 查活跃 agent，没有会话就没有目录可列（harness 侧见
   * `api/session-controller/src/agent.ts` 的 `resolveAgent`，没有无会话端点）。
   * 所以空态下打开菜单 = **按需建会话**，与发消息走同一条 `ensureSession`。
   *
   * 与 `ensureSession` 只差一条口径（用户 2026-09-24 拍板）：**不弹目录选择器**。
   * 菜单是随手打开的，弹一个系统对话框打断输入不合理；目录没定就回空菜单，
   * 由界面那句「未选择工作区」把原因说清楚（`menuNoWorkspace`），选目录留在
   * 空态页那一行按钮上。
   *
   * 其余一律与发消息同路——包括**允许拉起后台**（「显式动作才许启动」那一档：
   * 用户要看命令栏/文件列表，菜单空着等于这条能力不存在）。
   */
  private async ensureSessionForMenu(viewId: string): Promise<SessionScope | undefined> {
    const existing = this.scopeOfView(viewId);
    if (existing) return existing;
    if (!this.hasWorkspaceDir()) return undefined;
    return await this.ensureSession(viewId);
  }

  /**
   * 真正建一条会话并绑到窗口（`session/create`）。
   *
   * 待建会话的几样参数在这里一次性落实：**工作目录**（`workspacePath()`）、
   * **agent 预设**（用户点过的 > 配置项 > 服务端默认，见 `agentPresetFor`）、
   * **模型**（记成域上的 `pendingModel`，由第一次发送前的 `selectModel` 提交）、
   * **权限**（空态页选过的、与部署默认不同的那笔，绑定后补发一次 `/permission`）。
   * 落实完就把待建状态清掉——下一次「新建对话」重新从配置项开始。
   *
   * 建之前先看有没有**可复用的空会话**（`reusableBlank`）：菜单打开过一次就留下一条
   * 记录，用户按 Esc 走开时那条还没开始对话，接回来比再堆一条好。
   */
  private async createSession(viewId: string): Promise<SessionScope | undefined> {
    if (!this.client) return undefined;
    try {
      const preset = this.agentPresetFor(viewId);
      const workspaceId = await this.ensureWorkspace();
      const reusable = this.reusableBlank(preset);
      const created =
        reusable !== undefined
          ? { sessionId: reusable, agentPreset: this.createdBlankSessions.get(reusable)?.preset }
          : await this.createSessionInWorkspace(workspaceId, preset);
      // 域是「窗口打开会话」的产物：这里总是有窗口要绑
      const scope = this.ensureScope(created.sessionId);
      // 空态页选过的权限在**绑定前**读走（`bindViewToSession` 会清掉它）
      const wantedPermission = scope ? this.viewPermission.get(viewId) : undefined;
      // 投影帧要晚一点才到，先用创建结果给域一个初值（`agentPreset` 那条路见
      // `applyAgentPresetProjection`）
      if (scope) {
        scope.agentPreset = created.agentPreset;
        // 界面上显示的模型在这里落实：用户点过的优先；没点过就是空态页展示着的
        // 部署默认（`agent-default-model` 配置）——记成 `pendingModel` 后第一次发送
        // 前由 `selectModel` 提交，会话实际用的就是胶囊上那一个，而不是「服务端
        // 自己再默认一次」。
        const model = this.viewModel.get(viewId) ?? this.defaultModel;
        if (model) {
          scope.pendingModel = model;
          scope.model = model;
        }
      }
      await this.refreshSessions();
      // 记下这条**还没开始对话**的会话（复用名册，见 `reusableBlank`）。放在
      // `refreshSessions` 之后：那次刷新会按服务端的 `blank` 位清理名册，先记后刷
      // 会被它顺手清掉。服务端定的预设名（`created.agentPreset`）一并记下，复用时
      // 给域一个初值，免得空态页上的预设显示闪一下空。
      this.createdBlankSessions.set(created.sessionId, {
        cwd: normalizePath(this.workspacePath()),
        requestedPreset: preset,
        preset: created.agentPreset,
      });
      if (scope) {
        this.bindViewToSession(viewId, created.sessionId, scope);
        // 待建会话的权限选择到此落实（会话启动后以界面显示的设定运行）。与部署默认
        // 相同就不发：那个值服务端建会话时本来就会装上，再发一次只会在新会话里留下
        // 一条没人点的 `/permission` 命令节点
        if (wantedPermission && wantedPermission !== this.defaultPermission) {
          await this.runCommand(viewId, `/permission ${wantedPermission}`);
        }
        this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
      }
      return scope;
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to create a session"), error);
      return undefined;
    }
  }

  /**
   * 把窗口退回空态（「新建对话」的第一步）：只解绑会话，窗口本身照旧活着
   * （与 `unbindView` 的「窗口下线」是两件事——那个连窗口的登记一起清）。
   *
   * 与会话域的最后一个观察者解绑时域被回收（状态从服务端重算），草稿与附件按
   * **窗口键**搬回去——与 `bindViewToSession` 的迁移严格对称，否则输入框里的话
   * 会在点「+」的那一刻消失（它们跟着会话键走了）。编辑区标签的标题也回到 `DSH`。
   */
  private detachView(viewId: string): void {
    const previous = this.viewSessions.get(viewId);
    if (previous === undefined) return;
    // 点「新建对话」也是离开：正在生成就记一笔离开标记（域随后被回收，先取状态）
    const wasGenerating = this.isSessionGenerating(previous);
    // 这个窗口的后台任务观察流属于**上一个会话**：留着它会让新会话的面板收到
    // 旧任务的输出（帧里只有 jobId，界面认不出这是别人的）
    this.closeJobWatch(viewId);
    this.viewSessions.delete(viewId);
    const draft = this.drafts.get(previous);
    if (draft !== undefined) {
      this.drafts.set(viewId, draft);
      this.drafts.delete(previous);
    }
    const attachments = this.attachmentsBySession.get(previous);
    if (attachments) {
      this.attachmentsBySession.set(viewId, attachments);
      this.attachmentsBySession.delete(previous);
    }
    this.dropViewers(previous);
    this.noteSessionLeft(previous, wasGenerating);
    if (this.viewKinds.get(viewId) === "panel") this.setPanelTitle(viewId, panelTabTitle(undefined));
    this.log(`[bind] 窗口=${viewId} → 空态（原=${previous}，会话记录保留）`);
    this.persistWindowState();
  }

  /**
   * 按工作区建会话；工作区 id 失效（注册表被重置 / 换了 DSH home）时清掉缓存、
   * 退化成按 cwd 建——**一次重试**，不再递归（见 `ensureWorkspace`）。
   */
  private async createSessionInWorkspace(
    workspaceId: string | undefined,
    agentPreset: string | undefined,
  ): Promise<{ sessionId: string; agentPreset?: string }> {
    if (!this.client) throw new Error("no client");
    // 预设只在**创建时**能指定（之后换要走 `agentPresets/select`，且只在会话还没有
    // 轮次时有效）。没有就不传这个字段——服务端按它自己的默认预设组装。
    const target = agentPreset ? { agentPreset } : {};
    if (!workspaceId) return this.client.createSession({ cwd: this.workspacePath(), ...target });
    try {
      return await this.client.createSession({ workspaceId, ...target });
    } catch (error) {
      this.workspaceId = undefined;
      this.log(`[workspace] 按工作区建会话失败，回退 cwd：${this.describeError(error)}`);
      return this.client.createSession({ cwd: this.workspacePath(), ...target });
    }
  }

  /**
   * 找一个**可以接回来**的空会话（官方 Web 端 `ui-workspace` 的 `reuseOrCreateBlank`
   * 同一口径）。只认扩展自己建出来的那批（`createdBlankSessions`）：
   *
   * - 服务端还说它是 `blank`（没开始过对话）、还在列表里；
   * - 落脚目录与新会话一致（换个目录就不该接）；
   * - 建它时**传的预设**与这次要传的相同——预设决定会话组装哪些插件，不同就不能顶替
   *   （空态页上那枚胶囊显示的是这次要用的预设，接一条别的组装会让它变成假话）；
   * - 现在没有任何窗口开着它（`viewSessions` 里没有），子代理会话与归档会话不算。
   *
   * 找不到就返回 undefined，调用方照常 `session/create`。
   */
  private reusableBlank(preset: string | undefined): string | undefined {
    const target = normalizePath(this.workspacePath());
    const bound = new Set(this.viewSessions.values());
    for (const row of this.sessions) {
      if (row.blank !== true || bound.has(row.id)) continue;
      if (this.archivedSessionIds.has(row.id) || this.subagentSessionIds.has(row.id)) continue;
      const record = this.createdBlankSessions.get(row.id);
      if (!record || record.requestedPreset !== preset) continue;
      if (record.cwd !== target) continue;
      return row.id;
    }
    return undefined;
  }

  /**
   * 现在能不能确定新会话落在哪个目录：打开着文件夹，或用户在新会话页上选过一个。
   *
   * 判据与 `askWorkspaceDir` 的前两道完全一致，抽出来是因为**菜单那条路**（见
   * `ensureSessionForMenu`）要先问一句「有没有目录」，而没有目录时它**不弹**选择器。
   */
  private hasWorkspaceDir(): boolean {
    return Boolean(vscode.workspace.workspaceFolders?.[0] ?? this.newSessionCwd);
  }

  /**
   * 空态页上改工作目录：弹系统目录选择器并记下来。
   *
   * **不建会话**（用户 2026-09-22 口径）：会话要等第一条消息才建，选目录只是把
   * 「新会话落在哪儿」定下来。已绑定的会话也不动——它的 cwd 是创建事实。
   *
   * 只在没有打开文件夹时才可能被调用（界面那行在 locked 时不发这条指令）；这里仍
   * 再判一次——界面状态可能滞后于 VS Code 的实际文件夹。
   */
  private async pickWorkspace(viewId: string): Promise<void> {
    if (vscode.workspace.workspaceFolders?.[0]) {
      this.refreshWorkspace();
      return;
    }
    // viewId 用不上：会话要等第一条消息才建，选目录只改「新会话落在哪儿」
    void viewId;
    await this.askWorkspaceDir();
  }

  /**
   * 问一次工作目录（系统目录选择器），选中就记下来并推一帧。
   *
   * 两个入口共用：空态页上点那行目录，以及**要建会话却还没有目录时**（见
   * `ensureSession`——那时弹的也是同一个对话框，用户只需要面对一种问法）。
   *
   * @returns 现在有目录了（本来就打开着文件夹、或选了一个）就是 true；用户取消 → false。
   */
  private async askWorkspaceDir(): Promise<boolean> {
    if (this.hasWorkspaceDir()) return true;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: vscode.l10n.t("Select the working directory for new sessions"),
      openLabel: vscode.l10n.t("Use This Folder"),
    });
    const path = picked?.[0]?.fsPath;
    if (!path) return false;
    this.newSessionCwd = path;
    this.emitAll({ type: "patch", patch: { workspace: this.workspaceView() } });
    return true;
  }

  /**
   * 把指定窗口切到给定会话（域不存在则创建；其他窗口不受影响）。
   *
   * `subagent` 给出时目标是一个**子代理会话**（不进会话列表、只能用子代理地址
   * 打开）：面包屑返回父会话、切换下拉换兄弟、恢复路径都走这条。不带时是普通
   * 会话——包括从子代理页点面包屑回来那一刻。
   */
  async openSession(
    viewId: string,
    sessionId: string,
    subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" },
    /** 子代理域的父目录种子（切换时随行，见 `openSubagent` 与 `ensureScope`）。 */
    seedSiblings?: readonly SubagentView[],
  ): Promise<void> {
    // 已经在这个会话上（历史抽屉里点了当前选中的那条）：什么都不做，
    // 避免重绑把粘性显示值清掉后等不到回填
    if (this.viewSessions.get(viewId) === sessionId) return;
    // 用户显式动作（点历史里的一条 / 点面包屑）：允许拉起后台
    if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: true });
    if (!this.client) return;
    const scope = this.ensureScope(sessionId, subagent, seedSiblings);
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
  /**
   * 取（或创建）给定会话的域：建视图模型、开 follow 流、重开控制流拿该会话
   * 的 baseline、预取命令目录。
   *
   * `subagent` 给出时这是一个**子代理会话**：域记下地址（follow / page / 发送 /
   * 停止全部按它路由），`running` 用父目录里那一行的驻留状态打底（子代理不在
   * 会话列表里，列表打不了底；正在跑的子代理开进来必须立刻是「生成中」）。
   *
   * 挂起的审批/提问**不在这里回放**（见 `bindViewToSession`）：域建成的这一刻
   * 还没有窗口绑上来，投递出去也没人收。
   */
  private ensureScope(
    sessionId: string,
    subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" },
    /**
     * 子代理域的**父目录种子**（切换时随行，见 `openSubagent`）：此刻手里最近的一份
     * 父目录快照。父会话域**很可能已经被回收**（视图离开就回收，见 `dropViewers`），
     * 等不到投影 RPC 回来快照就要发出去——种子让切换后的第一帧就有完整的兄弟清单。
     */
    seedSiblings?: readonly SubagentView[],
  ): SessionScope | undefined {
    const existing = this.scopes.get(sessionId);
    if (existing) {
      // 地址是**持久事实**；与请求不一致时按调用方给的纠正（此前版本可能带着
      // 错误层级建过域——域名下只有 id，错的地址会一直把返回/切换算错层）。
      // 同一子代理的真实父会话不会变（durable 事实），改它只是收敛到真相。
      if (existing.subagentAddress || subagent) existing.subagentAddress = subagent;
      if (existing.subagentAddress && subagent) {
        this.log(`[subagents] 会话=${sessionId} 地址对齐：父会话=${subagent.parentSessionId}（原=${existing.subagentAddress.parentSessionId}）`);
      }
      if (existing.subagentAddress) {
        // 上下文是现算的：地址变了就重推（面包屑 / 切换下拉立即正确）
        this.deliver(sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(existing), ["subagent"]),
        });
      }
      return existing;
    }
    if (!this.client) return undefined;
    const scope = new SessionScope(sessionId);
    scope.subagentAddress = subagent;
    if (subagent) {
      const parent = this.scopes.get(subagent.parentSessionId);
      // 父目录快照：种子（切换时随行的最新一份）优先；没有种子才读父会话域——
      // 它此刻**多半已被回收**（视图离开就回收，见 `dropViewers`），读不到就是 []。
      scope.subagentSiblings = seedSiblings?.length
        ? [...seedSiblings]
        : parent
          ? [...parent.subagentEntries]
          : [];
      // **running 打底**：普通会话用会话列表里的权威值（`SessionSummary.running`）；
      // 子代理会话不在列表里，用父目录里那一行的 `activity`（官方客户端的 Session
      // 实例同样在建立时用列表摘要喂一次——`manager.ts` 的 `session.handleRunning`）。
      // 这一步不能省：适配器重建后那份快照在「窗口被截断 + 没有活跃 attempt」时**不发**
      // running 帧（见 `applyFrame`），没有打底的话域会停在 `false` 上——明明在生成却给
      // 出发送按钮，消息被按 queue 发出去排进队列（用户 2026-09-22 报的现场）。
      // 打底读**刚落好的兄弟快照**（种子或父域目录），不是先读后写：切进一个正在跑的
      // 兄弟时父域已不在，唯一带驻留状态的就是种子。
      const seeded =
        scope.subagentSiblings.find((entry) => entry.id === sessionId)?.activity === "running"
          ? true
          : (this.subagentRunning.get(sessionId) ?? false);
      scope.running = seeded;
      // 父会话域不在（恢复路径直接落到子代理页）：用投影 RPC 把父目录补进来，
      // 面包屑旁的切换下拉才有兄弟行（有种子时是并入补差，见 fetchParentCatalog）
      if (!parent) void this.fetchParentCatalog(scope);
    } else {
      const row = this.sessions.find((item) => item.id === sessionId);
      if (row) scope.running = row.running;
    }
    this.scopes.set(sessionId, scope);
    this.openScopeFollow(scope);
    this.openScopeJobs(scope);
    // 子代理目录**打底**：投影与 durable 事件那两路只覆盖「跟随窗口里的记录」，
    // 而 RPC 是服务端按会话语料做的完整检索（见 `refreshSubagentCatalog`）。
    // 少了这一下，重载窗口/切会话回来必须点开面板才有列表（用户 2026-09-23 报的现场）。
    void this.refreshSubagentCatalog(scope);
    // 重开控制流拿新会话的 baseline（队列/任务/投影）：baseline 是全量集合，
    // 多取一次是幂等的
    this.openControlStream();
    // 命令目录随会话预取：手打的 `/xxx` 要靠它才能被路由到命令通道，
    // 不能等输入 `/` 弹出候选时才拉（粘贴一行后立刻回车就赶不上了）
    void this.listCommandsFor(scope);
    // 新建的域没有 `modelSelection` 投影（首次对话前），给它填部署默认模型；
    // 服务端真给了投影时，baseline 到达会覆盖这里的默认值
    this.ensureDefaultsApplied();
    return scope;
  }

  /**
   * 确保部署默认（模型与权限）已读取并铺开：模型填进仍缺选择的域，两个默认一起
   * 推给空态窗口。连接路径与建域路径都要调：`loadModels` 只在连接时跑一次，其后
   * 新建的域不会再被 `applyDefaultModelToScopes` 覆盖。
   */
  private ensureDefaultsApplied(): void {
    if (this.defaultsLoaded) {
      this.applyDefaultModelToScopes();
      this.refreshPendingDefaults();
      return;
    }
    void this.loadDefaults();
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
    // 子代理「注册」：父会话的 `subagent/catalog` durable 事件（直播与重放都会到）→
    // 立刻并入目录并发帧，不必等面板打开那一下 RPC（见 `registerSubagent`）
    adapter.onSubagentEstablished = (entry) => this.registerSubagent(scope, entry);
    // 一条人的用户消息被 durable 承认：收回它的乐观回显。重放期间这条回调会被适配器
    // **攒到那一份整份 `messages/reset` 发出去之后再补**（见 `adapter.notifyAdmitted`）
    // ——重连 / 重载窗口后既不留下幽灵回显，也不会先收回、后落位（那就是"闪一下"）
    adapter.onUserMessage = (message) => this.noteUserAdmitted(sessionId, message);
    // durable 用户行的图片借**同一次提交的本地附件**（`submissions` 里那份，图片带 dataUrl）：
    // 不借的话交接时会从缩略图退回文件名芯片、等字节换回来再变回缩略图（闪两下）
    adapter.resolveEchoAttachments = (rpcId) => this.originFor(rpcId)?.attachments;
    // 轮次结束时先推一次 Git 重扫：否则刚写完的文件还没进改动清单，用户第一次
    // 点芯片看到的是完整文件而不是 diff（见 refreshGitState 的注释）
    adapter.refreshFiles = () => this.refreshGitState();
    adapter.setSession(
      // 子代理会话不在会话列表里：用目录行（label）合成头部信息，标题由此正确
      this.summaryOfSession(sessionId) ?? {
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
    }, scope.subagentAddress);
  }

  /**
   * 给域开（或 socket 重连后重开）`job/list` 流：本会话看得见的后台任务名册。
   *
   * **为什么单独一条流**：0.1.7-alpha.1 把 job 观察从 `session/control` 搬到了
   * `dsh-api-job-controller` 的 `job` 命名空间（`job/list` / `job/follow` / `job/kill`），
   * 控制流的 `jobs` 字段与 `type:'jobs'` 帧在那版消失（`SessionJob` 类型也没了）。
   * 旧服务端没有这条流，`onControlFrame` 里的旧通道继续读——两条通道写同一个字段。
   */
  private openScopeJobs(scope: SessionScope): void {
    if (!this.client) return;
    scope.jobsHandle?.cancel();
    scope.jobsHandle = this.client.followJobs(scope.sessionId, {
      onItem: (value) => this.onJobFrame(scope, value),
      onError: () => {
        // socket 断开重连后会由 onConnected 重开（同 follow 流）
      },
    });
  }

  /**
   * `job/list` 的一帧 → 会话状态。
   *
   * 帧是**整表替换**（`{type:'rows', jobs}`），所以直接交给 `applyJobs`；`type` 认不出
   * 就整帧丢掉——把未知帧当名册用会把面板清空，而「认不出」不等于「没有任务」。
   */
  private onJobFrame(scope: SessionScope, value: unknown): void {
    const rows = jobRowsFromFrame(value);
    // 认不出的帧类型返回 `undefined`（不动现有列表）：把「认不出」当成「空名册」
    // 会让面板凭空清空——判据与兜底都在 `jobView.ts` 的读取器里。
    if (rows === undefined) return;
    this.applyJobs(scope, rows);
  }

  /**
   * 打开（或重开）某个窗口正在看的那条后台任务输出流。
   *
   * 三条纪律：
   * - **先收旧的**：一个窗口同时只有一行展开，换行/重开都先把上一条取消，
   *   否则旧流的帧会写进新一轮（`onItem` 里还有一道「这一条还是该视图当前那条吗」
   *   的判据，两道一起挡住交错）；
   * - **续传只带上一帧的 `next`**：第一次观察不带 `from`（服务端从环里最旧的
   *   保留字节锚起，`opened.from > 0` 才是「开头已淘汰」的信号）；
   * - **失败如实回帧**：连不上 / 没绑定会话时回一句概括（不带 `detail`），
   *   流自己报错时把原始错误当 `detail` 回给界面——展开区不能停在「还没有输出」。
   */
  private openJobWatch(
    viewId: string,
    sessionId: string,
    jobId: string,
    watchId: number,
    from: number | undefined,
  ): void {
    this.closeJobWatch(viewId);
    const client = this.client;
    if (!client) {
      this.emitToView(viewId, { type: "jobs/observeFailed", jobId, watchId });
      return;
    }
    const watch: JobWatch = {
      sessionId,
      jobId,
      watchId,
      from,
      handle: { cancel: () => {} },
    };
    this.jobWatches.set(viewId, watch);
    watch.handle = client.followJob(
      sessionId,
      jobId,
      {
        onItem: (value) => {
          // 旧流的在途帧不许写进新一轮：换行/重开时 `jobWatches` 里已经不是这一条了
          if (this.jobWatches.get(viewId) !== watch) return;
          const frame = jobFollowFrameFromWire(value);
          if (frame === undefined) return;
          if (frame.kind === "opened") {
            watch.from = frame.from;
            this.emitToView(viewId, {
              type: "jobs/opened",
              jobId,
              watchId,
              from: frame.from,
              earliest: frame.earliest,
            });
            return;
          }
          if (frame.kind === "output") {
            watch.from = frame.next;
            this.emitToView(viewId, {
              type: "jobs/output",
              jobId,
              watchId,
              text: frame.text,
              gapBefore: frame.gapBefore,
            });
            return;
          }
          // 终态：名册行自己会变成收场态，这里没有要转给界面的东西；
          // 流随即正常结束，条目由 `onEnd` 收掉
        },
        onEnd: () => {
          if (this.jobWatches.get(viewId) === watch) this.closeJobWatch(viewId);
        },
        onError: (error) => {
          // **断线不报错**：socket 断开时所有流一起 errored，那一刻报错会让
          // 「网络抖一下」看起来像这个任务坏了。条目留着，`onConnected` 用原
          // watchId + 原续传游标重开，界面那边文本接着长。
          if (this.connection !== "connected") return;
          if (this.jobWatches.get(viewId) !== watch) return;
          this.closeJobWatch(viewId);
          this.log(`[jobs] 实时输出流中断（jobId=${jobId}）：${error.code} ${error.message}`);
          this.emitToView(viewId, {
            type: "jobs/observeFailed",
            jobId,
            watchId,
            detail: `${error.code}: ${error.message}`,
          });
        },
      },
      from,
    );
  }

  /**
   * 收掉某个窗口的观察流（幂等）。
   *
   * 五条路都要到这里：收起/换行（界面指令 `unobserveJob`）、关面板（同一条指令）、
   * 关窗口（`unbindView`）、切会话（`bindViewToSession` / `detachView`）、
   * 回收会话域（`destroyScope`，兜底——正常路径下视图离开时已经收过了）。
   * 另外流**正常结束**（服务端送完终态）也走这里清条目，别让表里留下死句柄。
   */
  private closeJobWatch(viewId: string): void {
    const watch = this.jobWatches.get(viewId);
    if (!watch) return;
    this.jobWatches.delete(viewId);
    watch.handle.cancel();
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
      const page = await this.client!.page(scope.sessionId, throughSeq, beforeSeq, 50, scope.subagentAddress);
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
      scope.jobsHandle?.cancel();
      scope.jobsHandle = undefined;
    }
    this.controlHandle?.cancel();
    this.eventsHandle?.cancel();
    this.workspaceHandle?.cancel();
    this.controlHandle = undefined;
    this.eventsHandle = undefined;
    this.workspaceHandle = undefined;
    this.eventsClientId = undefined;
    // 换了连接（可能是另一个服务端）：端点可用性的结论作废，下次开域重新问
    this.subagentListMissing = false;
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
   *   `contextBreakdown` / `sessionStats` / `goal` / `subagentCatalog` / `imageLimits` /
   *   `agentPreset`；
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
    agentPreset: (scope, value) => this.applyAgentPresetProjection(scope, value),
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
      // 界面上有一笔**还没提交**的选择（用户刚点的模型，见 `setModel`）：投影说
      // 「没有选择」不等于该把它抹掉——那笔选择会在下一次发送前真正提交。少了这道
      // 判断，会话刚建出来（跟随开帧铺投影）时胶囊会弹回部署默认，用户刚点的那下
      // 看起来被吞了。与 `applyDefaultModelToScopes` 里 `if (scope.pendingModel) continue`
      // 是同一条口径：待提交值在提交之前不动它。
      if (scope.pendingModel) return;
      if (this.defaultModel) {
        scope.model = this.defaultModel;
        this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["model"]),
    });
      } else {
        void this.loadDefaults();
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
   * 子代理目录（投影那一路）。
   *
   * 投影里已经带着目录，界面无需再单独请求一次。投影**没有** `kind`/`activity`
   * （那两个字段属于 `subagents/list` RPC 行），所以形状解析在 `projections.ts`。
   *
   * **并入，不整表替换**（`upsertSubagent`）：投影的完整度不如 RPC——进程外 provider
   * 不写 `subagent/catalog`，投影里就没有那些子代理；整表替换会把 RPC 刚拿到的行丢掉，
   * 每次投影刷新丢一次。同 id 的 `activity` 原样保留（投影没有这个字段，不知道就不动手）。
   * 键不存在时**也不清空**：子代理会话只增不删，清空只会让面板闪空。
   */
  private applySubagentCatalogProjection(
    scope: SessionScope,
    value: SubagentCatalogEntryView[],
    present: boolean,
  ): void {
    if (!present) return;
    const before = scope.subagentEntries.length;
    if (!this.mergeSubagentEntries(scope, value)) return;
    // 只在条目数真的变了时记一行：投影刷新很频繁（每次重连/开窗），逐次记会淹掉日志
    if (scope.subagentEntries.length !== before) {
      this.log(`[subagents] 会话=${scope.sessionId} 投影目录 ${before} → ${scope.subagentEntries.length} 条`);
    }
    this.deliverSubagentList(scope);
  }

  /**
   * 把若干目录条并入本域（`upsertSubagent` 的写回顾问点）。
   *
   * @returns 有没有**真的**变化。没有变化就什么都不做——重放（快照 / 加载更早）会把同一条
   *   `subagent/catalog` 反复送进来，每次照发一帧会让面板无谓重渲染；日志同理（否则
   *   「注册子代理」那行会在每次重连时刷一遍）。
   */
  private mergeSubagentEntries(scope: SessionScope, entries: readonly SubagentView[]): boolean {
    let next = scope.subagentEntries;
    let changed = false;
    for (const entry of entries) {
      // catalog 的三个来源（事件 / RPC / 投影）都汇到这里：顺带记进 @ 提及候选的
      // 过滤集合（见 `subagentSessionIds`），与「已在册」无关、每次都要记
      this.subagentSessionIds.add(entry.id);
      const existing = next.find((item) => item.id === entry.id);
      // 同 id 且 label/mode 都没变就是「已在册」：`upsertSubagent` 只更新这两项
      // （`activity` 由它自己保留），所以这里可以直接跳过
      if (existing && existing.label === entry.label && existing.mode === entry.mode) continue;
      next = upsertSubagent(next, entry);
      changed = true;
    }
    if (!changed) return false;
    scope.subagentEntries = next;
    return true;
  }

  /**
   * 一条子代理建立事实（`subagent/catalog` durable 事件，适配器转交）→ 注册进目录。
   *
   * 这条路的**价值是即时**：事件在子代理建立那一刻就落日志，直播时立刻到，不必等
   * RPC（用户 2026-09-23 报的「子代理启动后要点开面板才看得到」）。它没有 `activity`
   * ——状态随后由 `api-session/status` 中继补齐（见 `syncSubagentActivity`）。
   */
  private registerSubagent(scope: SessionScope, entry: SubagentView): void {
    if (!this.mergeSubagentEntries(scope, [entry])) return;
    this.log(`[subagents] 会话=${scope.sessionId} 注册子代理 ${entry.label}（${entry.id}, ${entry.mode}）`);
    this.deliverSubagentList(scope);
  }

  /**
   * 子代理驻留状态（`api-session/status` 中继）→ 就地改一条的 `activity`。
   *
   * 官方同款（`dsh-api-session-controller` 客户端的 `updateCatalogActivity`）：这条中继
   * 对**每个 agent** 都发，子代理也在内，所以状态点与头部按钮的呼吸可以在**不点开面板**
   * 时就是对的。子代理没有本地日志证据，所以不走 `acceptSessionStatus` 那套「有肯定证据
   * 就拒绝不在跑」的判断——那条规则是给窗口绑定的会话用的。
   */
  private syncSubagentActivity(childSessionId: string, running: boolean): void {
    for (const scope of this.scopes.values()) {
      const { entries, changed } = withSubagentActivity(scope.subagentEntries, childSessionId, running);
      if (!changed) continue;
      scope.subagentEntries = entries;
      this.deliverSubagentList(scope);
    }
  }

  /**
   * 目录变了就下发（唯一的列表帧，见 `shared/ipc.ts`）。
   *
   * 同时把**父目录快照**同步进正在看这个会话子代理的窗口（切换下拉的数据，
   * 见 `syncSubagentContext`）——目录的三条来源（事件 / 投影 / RPC）都汇到
   * `deliverSubagentList`，这里就是唯一的扇出点。
   */
  private deliverSubagentList(scope: SessionScope): void {
    this.deliver(scope.sessionId, {
      type: "subagents/list",
      entries: scope.subagentEntries,
    });
    this.syncSubagentContext(scope.sessionId);
  }

  /**
   * 目标条。投影是**嵌套**的、轮次计数在外层（见 `projections.goalFromProjection`）。
   * 以前按扁平形状读，两个字段都取不到，于是 goal 恒被清空、目标条从未渲染
   * （`docs/audit-summary.md`「goal 投影嵌套形状读错」一条）。键不存在 → 清空目标条。
   */
  private applyGoalProjection(scope: SessionScope, value: GoalView | undefined, present: boolean): void {
    scope.goal = present ? value : undefined;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["goal"]),
    });
  }

  /**
   * 本会话运行的 agent 预设（`agentPreset` 投影）。
   *
   * 与 `permissions` 同口径：键不存在（插件没装 / 被 baseline 清掉）时**清空**——
   * 界面据此不渲染那个下拉框，而不是继续显示上一次的预设名。
   */
  private applyAgentPresetProjection(scope: SessionScope, value: string | undefined): void {
    if (scope.agentPreset === value) return;
    scope.agentPreset = value;
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["agentPreset"]),
    });
  }

  /**
   * 后台任务名册 → 界面状态（**两条通道共用**：`job/list` 流与旧的 `session/control` 帧）。
   *
   * **只投递一条**：以前这里连着发两条（`jobs/list` 与 `patch.jobs`），同一次刷新的
   * 同一份数据走了两条路，而面板的键集合在 `snapshotFor` / 切会话帧 / 历史 patch
   * 那几条路上**各写一份**——多投的那条不会带来任何新信息（界面侧 `jobs/list` 与
   * `patch.jobs` 落到同一个状态字段），却会让面板按两条帧各渲染一次（闪一下）。
   * 留着 `patch` 那条：它与其它会话字段（队列、目标、模型……）走**同一个字段表**
   * （`dsh/sessionView.ts`），字段名与 `undefined → null` 的折返不再有第二处实现。
   * （`jobs/list` 帧本身没删：面板打开时按需请求的那条路 `case "listJobs"` 仍然发它，
   * 删掉的只是同一次刷新里的第二次投递。）
   *
   * 字段读取对两种线格式同时成立：0.1.7-alpha.1 的 `JobView` 与旧的 `SessionJob`
   * 在前七个字段上同形（新的多 `progress`/`output`/`owner`，本扩展不消费）。
   */
  private applyJobs(scope: SessionScope, jobs: unknown): void {
    scope.jobs = jobItemsFromWire(jobs);
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
      const request = held.request as {
        toolName?: string;
        callId?: string;
        reason?: string;
        displayReason?: unknown;
      };
      scope.adapter?.addApproval({
        requestId: eventId,
        // 工具名缺失时给标记而不是中文：审批卡按用户选的界面语言渲染
        toolName: request.toolName ?? "@toolGeneric",
        reason: request.reason,
        // 本地化展示文案（0.1.7-rc.2 起）：形状不对就当没有，界面退回 `reason`
        displayReason: localizedTextFrom(request.displayReason),
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
    // 部署默认是**有缓存**的（`agent-default-model` 与 `permission` 两个命名空间）：
    // 不清掉就永远读不到新值
    this.defaultModel = undefined;
    this.defaultPermission = undefined;
    this.defaultsLoaded = false;
    await this.refreshImageCaps();
    // 模型目录还没到（首连的那一小段窗口）时不读默认模型：标签会退化成裸 id
    // 并被缓存住；那次连接流程自己会在 loadModels 之后读一遍。
    if (this.models.length > 0) await this.loadDefaults();
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
      // 同一份结果再喂「开发者工具」偏好（预设选择入口的可见性判据，0.1.7-rc.2 起
      // 服务端不再表态，只剩这一条来源）。它一变会重折算预设目录并推帧。
      this.applyDeveloperTools(described.namespaces ?? []);
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
      // 部署默认模型可能早已被读成「裸 id、没有档位表」的缓存——`loadDefaults` 不挑
      // 时机（重载窗口恢复会话的 baseline 那条路就会在目录到达前触发），而
      // `defaultsLoaded` 一旦置位就不再重读。目录到手就在这里把展示名 / 思考档位 /
      // 上下文窗口重新折一遍，再铺给仍缺选择的域与空态窗口，裸 id 不会一直挂着。
      if (this.defaultModel) {
        this.defaultModel = this.resolveModelView(this.defaultModel);
        this.applyDefaultModelToScopes();
        this.refreshPendingDefaults();
      }
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
      if (!replayed) await this.loadDefaults();
    } catch (error) {
      this.log(`[models] 目录获取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 用模型目录把一份模型选择折成「人类可读」的展示形态：展示名、思考档位表、
   * 上下文窗口、图片输入能力都从目录对应条目来。目录里认不出（provider/model
   * 拼错、目录还没到、模型被删）时保留原值——裸 id 至少还是可辨认的身份。
   */
  private resolveModelView(selection: ModelSelectionView): ModelSelectionView {
    const group = this.models.find((item) => item.id === selection.provider);
    const model = group?.models.find((item) => item.id === selection.model);
    return {
      ...selection,
      label: model?.name ?? selection.label,
      efforts: model?.efforts,
      contextWindow: model?.contextWindow,
      acceptsImage: this.acceptsImageFor(selection.provider, selection.model),
    };
  }

  /**
   * 部署默认（配置文件 `~/.dsh/settings.yaml`）的统一读取口，一次
   * `settings/describe` 取两样：
   *
   * - `agent-default-model` 命名空间 → `defaultModel`：新会话在首次对话前没有
   *   modelSelection，但 agent 仍会用部署默认值，开场就显示真实模型与思考强度；
   * - `permission` 命名空间的 `defaultPreset` → `defaultPermission`：空态页的权限
   *   胶囊在会话建出来之前退回它，而不是界面词典里的某个硬编码档位。
   *
   * 两个默认同源同读（`defaultsLoaded` 闸住重复 RPC），读完各自铺开：
   * 域走 `applyDefaultModelToScopes`，空态窗口走 `refreshPendingDefaults`。
   */
  private async loadDefaults(): Promise<void> {
    if (!this.client) return;
    if (this.defaultsLoaded) {
      this.applyDefaultModelToScopes();
      this.refreshPendingDefaults();
      return;
    }
    try {
      const described = await this.client.settingsDescribe();
      this.defaultsLoaded = true;
      const section = described.namespaces?.find((item) => item.ns === "agent-default-model");
      const value = section?.value as { provider?: string; model?: string; reasoningEffort?: string } | undefined;
      if (value?.provider && value.model) {
        this.defaultModel = this.resolveModelView({
          provider: value.provider,
          model: value.model,
          // 初始 label 先放裸 id：目录里找得着就由 resolveModelView 换成展示名，
          // 找不着（provider/model 拼错、目录缺失）时裸 id 至少还是可辨认的身份
          label: value.model,
          reasoningEffort: value.reasoningEffort,
        });
      }
      const permissionSection = described.namespaces?.find((item) => item.ns === "permission");
      const preset = (permissionSection?.value as { defaultPreset?: unknown } | undefined)?.defaultPreset;
      this.defaultPermission = typeof preset === "string" && preset ? preset : undefined;
      this.applyDefaultModelToScopes();
      this.refreshPendingDefaults();
    } catch (error) {
      this.log(`[models] 部署默认读取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 部署默认到位 / 热重载后，刷新**空态窗口**的预览胶囊（权限、模型、思考强度）。
   *
   * 空态页没有域，`pendingViewFields` 的兜底正是刚读到的两个默认；默认值是异步到的
   * （连接后才发 RPC），不补这一下的话首帧快照里那两枚胶囊是空的，直到下次重绑才出现。
   * 已绑定会话的窗口不在这里管：真实状态压过预览值（`sessionSourceOf` 的口径）。
   */
  private refreshPendingDefaults(): void {
    for (const viewId of this.viewKinds.keys()) {
      if (this.viewSessions.has(viewId)) continue;
      this.emitToView(viewId, {
        type: "patch",
        patch: sessionPatch(this.pendingSessionSource(viewId), ["model", "permission"]),
      });
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
        await this.submitMessage(
          viewId,
          message.text,
          message.attachments,
          message.gesture ?? "enter",
          "composer",
        );
        break;

      case "retractPending": {
        // 撤回 = 把那一行删掉（不把正文塞回输入框：用户口径 2026-09-25）。
        // 只认这个窗口自己那份账本：别的会话的 id 就算撞上了也不许动（见 `echoOfView`）
        if (!this.echoOfView(viewId, message.requestId)) break;
        this.retireEcho(message.requestId, "user-retract");
        break;
      }

      case "resendPending": {
        // 重发 = 先撤回，再按普通发送重走一遍（同一个入口，两条路的行为不可能漂）。
        // 撤回**不推帧**：紧接着的 `submitMessage` 会推一份带最终状态的（否则中间那一帧
        // 两行都不在，界面上就是重发时闪一下）。
        const echo = this.echoOfView(viewId, message.requestId);
        if (!echo) break;
        this.removeEcho(message.requestId, "user-resend");
        // 手势按主发送算：重发就是"再发一次"，不继承上一次的加速手势；
        // **来源是 `retry`**：这一段内容不是输入框里的那份，绝不能顺手清掉用户正在写的草稿
        await this.submitMessage(viewId, echo.text, echo.attachments, "enter", "retry");
        break;
      }

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

      case "pickWorkspace":
        await this.pickWorkspace(viewId);
        break;

      case "setAgentPreset":
        await this.selectAgentPreset(viewId, message.id);
        break;

      case "openSession":
        await this.openSession(viewId, message.sessionId, message.subagent);
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
        const group = this.models.find((g) => g.id === message.provider);
        const model = group?.models.find((m) => m.id === message.model);
        const scope = this.scopeOfView(viewId);
        if (!scope) {
          // 窗口还是空态：**不建会话**（用户 2026-09-22 口径：没有第一条消息就不该留
          // 记录），只把这次选择记成「待建会话」的一部分，界面上立刻显示；
          // 建会话时它会落到域上，再由发送前的 `selectModel` 提交。
          const pending: ModelSelectionView = {
            provider: message.provider,
            model: message.model,
            reasoningEffort: message.reasoningEffort,
            label: model?.name ?? message.model,
            efforts: model?.efforts,
            contextWindow: model?.contextWindow,
            acceptsImage: this.acceptsImageFor(message.provider, message.model),
          };
          this.viewModel.set(viewId, pending);
          this.emitToView(viewId, {
            type: "patch",
            patch: sessionPatch(this.pendingSessionSource(viewId), ["model"]),
          });
          break;
        }
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

      case "setPermission": {
        const scope = this.scopeOfView(viewId);
        if (!scope) {
          // 空态：**不建会话**（与模型选择同一口径——没有第一条消息就不留记录），
          // 把这次选择记成「待建会话」的一部分，界面上立刻显示；建会话时与部署默认
          // 不同的那笔会被落实（见 `createSession`）
          this.viewPermission.set(viewId, message.permission);
          this.emitToView(viewId, {
            type: "patch",
            patch: sessionPatch(this.pendingSessionSource(viewId), ["permission"]),
          });
          break;
        }
        await this.runCommand(viewId, `/permission ${message.permission}`);
        break;
      }

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
        await this.openFile(
          message.path,
          message.diff,
          viewId,
          scope ? this.cwdOf(scope) : undefined,
          message.line,
          message.link === true,
        );
        break;
      }

      case "openExternal": {
        await this.openExternal(message.url, viewId);
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

      case "saveImage": {
        // 「保存图片」（图片右键菜单）：解析字节 → 用户选路径 → 写盘。
        // 默认目录与本地图解析同一口径（会话 cwd → 打开的工作区 → 用户目录）：
        // 会话目录拿不到时退回工作区，仍是用户明确打开的目录，只是基准换了。
        // 保存成功**不发 toast**（与「复制成功不弹信息条」同一条口径：结果在界面上
        // 就能感知——路径是用户自己选的）；取不到字节 / 写盘失败才提示。
        const scope = this.scopeOfView(viewId);
        const defaultDir =
          (scope ? this.cwdOf(scope) : undefined) ??
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
          homedir();
        const result = await saveChatImage(message.src, message.name, defaultDir);
        if (result.status === "failed") {
          this.log(`[image] 保存失败：${result.reason}`);
          this.emitToView(viewId, { type: "toast", level: "error", text: "@imageSaveFailed" });
        } else if (result.status === "saved") {
          this.log(`[image] 已保存：${result.path}`);
        }
        break;
      }

      case "listSubagents":
        await this.refreshSubagents(viewId);
        break;

      case "openSubagent":
        await this.openSubagent(viewId, message.id);
        break;

      case "listJobs": {
        const scope = this.scopeOfView(viewId);
        // 这条日志是**诊断的落点**：后台任务只有推送一条来源（控制流），面板打开这条
        // 指令只是把宿主内存里的那份重发一遍——`[jobs]` 与界面上的条数对不上时，
        // 一眼能看出是「宿主就没有」还是「帧没到界面」（用户 2026-09-23 报的
        // 「要点开面板才刷新」需要这个证据才能定责）。
        this.log(`[jobs] 面板打开：宿主侧后台任务 ${scope?.jobs.length ?? 0} 条（会话=${scope?.sessionId ?? "无"}）`);
        this.emitToView(viewId, { type: "jobs/list", jobs: scope?.jobs ?? [] });
        break;
      }

      case "killJob": {
        // 人的停止请求（后台任务面板的两段式按钮）→ `job/kill`。
        // **每条路都要回 `jobs/killResult`**：界面的「请求中」状态只认这一帧收场，
        // 不回帧按钮会永远禁用在那里。`sessionId` 取**当前视图绑定的会话**——
        // 名册就是按会话投的（`applyJobs`），面板里看得到的行必然属于它。
        const scope = this.scopeOfView(viewId);
        if (!this.client || !scope) {
          this.log(`[jobs] 停止请求没法发出：${this.client ? "没有绑定会话" : "未连接"}（jobId=${message.jobId}）`);
          this.emitToView(viewId, { type: "jobs/killResult", jobId: message.jobId, ok: false });
          break;
        }
        this.client
          .killJob(scope.sessionId, message.jobId)
          .then((value) => {
            // 受理即成功（`requested` / `already-finished` 都算）：行状态由名册帧收敛，
            // 这里只负责把「请求已受理」告诉界面。
            this.log(`[jobs] 停止请求已受理（jobId=${message.jobId}，outcome=${value.outcome ?? "?"}）`);
            this.emitToView(viewId, { type: "jobs/killResult", jobId: message.jobId, ok: true });
          })
          .catch((error) => {
            // 旧服务端没有 `job` 命名空间（404）、`job/not-found`（名册里已没有这一行）
            // 都落这里：如实回失败，界面亮「停止失败」，不做静默。
            this.log(`[jobs] 停止请求失败（jobId=${message.jobId}）：${this.describeError(error)}`);
            this.emitToView(viewId, { type: "jobs/killResult", jobId: message.jobId, ok: false });
          });
        break;
      }

      case "observeJob": {
        // 展开一行后台任务 → 开始观察它的实时输出（`job/follow`）。
        // **三条路都必须回帧**（`jobs/opened` 起头，开不了流时回 `jobs/observeFailed`）：
        // 展开区只认这两条帧，不回的话它会永远停在「还没有输出」。
        const scope = this.scopeOfView(viewId);
        if (!this.client || !scope) {
          this.log(`[jobs] 实时输出开不了流：${this.client ? "没有绑定会话" : "未连接"}（jobId=${message.jobId}）`);
          this.emitToView(viewId, {
            type: "jobs/observeFailed",
            jobId: message.jobId,
            watchId: message.watchId,
          });
          break;
        }
        const job = scope.jobs.find((item) => item.id === message.jobId);
        this.log(
          `[jobs] 观察实时输出：会话=${scope.sessionId} jobId=${message.jobId}` +
            `（名册里${job ? `有，状态=${job.status}` : "已没有这一行"}）`,
        );
        this.openJobWatch(viewId, scope.sessionId, message.jobId, message.watchId, undefined);
        break;
      }

      case "unobserveJob":
        this.closeJobWatch(viewId);
        break;

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

  /**
   * 一条窗口 → 宿主的「发送」：按下发送那一刻的乐观动作 + 真正提交。
   *
   * **这是「把一条消息发给服务端」的唯一入口**，四个调用点共用（用户按发送、失败行上的
   * 「重发」、ESC 中止后把摘出的排队消息重新发出 / 放回队列），行为不可能漂：
   * - `beginSend` 先做乐观动作（回显、清草稿、清附件），**早于任何 await**；
   * - 连接（必要时拉起内部 DSH）→ `send`；
   * - 连不上时那条回显标成 `failed`（原因写在上面），正文**不回**输入框；
   *   这条提交本来就没有回显时（尚未发出的那条、子代理会话）退回老口径：正文回输入框。
   *
   * `source` 只回答一个问题：**这段内容是谁的**——输入框里的（`composer`，提交即清空）、
   * 失败那一行里的（`retry`）、还是从排队区捞回来的（`queue`，它本来就是排队区里那条，
   * 提交模式固定 `queue`）。后两者**不许碰输入框**：用户那里可能正打着别的字，
   * 清它是一种数据丢失。它不是「另一条发送通道」——通道只有这一条，差别只在从哪读内容。
   *
   * @returns 服务端受理了没有。调用方只在需要按条继续/收场时用它（`resubmit` 的循环）。
   */
  private async submitMessage(
    viewId: string,
    text: string,
    attachments: Attachment[],
    gesture: "enter" | "accelerated",
    source: "composer" | "retry" | "queue" = "composer",
    prebuiltContent?: readonly PromptContentPart[],
  ): Promise<boolean> {
    const requestId = this.beginSend(viewId, text, attachments, source);
    // 未连接时先恢复连接：历史会话切换后跟随流尚未建立时直接 prompt
    // 会触发服务端 resume，冷启动竞态下 resume 可能失败。
    // **用户显式动作**（按了发送）：允许拉起内部后台（关掉自动连接时也算数，
    // 用户口径 2026-09-18：`autoConnect` 只约束扩展自己的自动行为）
    if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: true });
    if (!this.client) {
      if (!this.failEcho(requestId, "@sendNoConnection")) {
        this.appendDraft(viewId, text, attachments);
      }
      return false;
    }
    return this.send(viewId, text, attachments, gesture, requestId, source, prebuiltContent);
  }

  /**
   * 把一条**已经乐观回显过**的消息真正提交给服务端。
   *
   * 与 `beginSend` 的分工：乐观动作（回显、清草稿、清附件芯片）都在 `beginSend` 里、
   * 早于任何 await 做完；本函数只负责「真的发出去，或者把那一行标成失败」。`requestId`
   * 也由 `beginSend` 铸造（它是回显与 durable 事件的关联身份），这里只负责带给 prompt。
   *
   * 两条收场口径：
   * - **没发出去** → `failEcho`（那一行留在原地、红框、可重发/撤回，见 `failEcho` 的注释）；
   *   `failEcho` 说这条没有回显时（尚未发出的那条 / 子代理会话）退回老口径：正文回输入框 +
   *   原生提示，别把失败咽下去；唯一不算失败的是用户主动取消目录选择（正文也回输入框）；
   * - **发出去了** → 回显留着，等 durable `user/message` 承认再收——那才是
   *   「这条消息已经是历史了」的证据。
   */
  private async send(
    viewId: string,
    text: string,
    attachments: Attachment[],
    gesture: "enter" | "accelerated",
    requestId: string,
    source: "composer" | "retry" | "queue",
    prebuiltContent?: readonly PromptContentPart[],
  ): Promise<boolean> {
    if (!this.client) {
      if (!this.failEcho(requestId, "@sendNoConnection")) {
        this.appendDraft(viewId, text, attachments);
      }
      return false;
    }
    // 窗口还没有会话（空态）：**首条消息才建立它**。没有工作目录时会先问一次
    // （取消 → 不建会话也不发送，草稿留在输入框里）
    let scope = this.scopeOfView(viewId);
    if (!scope) {
      scope = await this.ensureSession(viewId);
    }
    if (!scope) {
      // 用户**主动取消**了目录选择：这不是"发送失败"，而是这条消息收回输入框
      // （唯一一条不回显失败态的路径——把用户自己的取消画成红框是误导）
      this.retireEcho(requestId, "workspace-cancelled");
      this.appendDraft(viewId, text, attachments);
      return false;
    }

    // 斜杠命令走命令通道，**不发给模型**：官方客户端的 enter 列把 `/xxx` 交给
    // `commands/execute`，宿主也明确「without sending it to the model」。
    // 以前只有 `/permission` 走命令通道，手打的 `/compact`、`/goal` 等一律当普通
    // 消息发给模型（docs/audit-summary.md「手打斜杠命令全部不执行」一条）。附带附件时仍按普通消息发：
    // 命令若不能带附件，服务端会拒绝，而用户此刻显然是想发这批内容。
    const slash = attachments.length === 0 ? this.slashCommandOf(scope, text) : undefined;
    if (slash) {
      // 草稿与附件已在 beginSend 里清掉（提交那一刻，早于建会话），这里只剩执行命令。
      // 回显要收回：命令不是用户消息，它的执行记录由命令节点承载。
      this.retireEcho(requestId, "slash");
      const outcome = await this.runCommand(viewId, slash.line);
      if (outcome && !outcome.ok) {
        this.emitToView(viewId, {
          type: "toast",
          level: "error",
          text: outcome.text ?? `@commandFailed:${slash.line}`,
        });
      }
      return outcome?.ok === true;
    }

    // 空态那条 `/xxx` 的正文：按下那一刻还没有会话、没有命令目录，`beginSend` 判不了
    // 它是不是命令，所以没画回显（见它的注释）。走到这里会话已经建好、上面刚用命令目录
    // 确认「它不是命令、要按普通消息发出去」——**技能调用就是这一类**（`/skill-name …`，
    // 技能不进命令目录）。补上这条回显：它在真正发出的这一刻就出现在消息流里，
    // 而不是等 durable 事件回来。
    //
    // 判据用「这个 requestId 还没有回显」而不是「刚才是不是判不了」：已经有回显的那些
    // （普通正文、带附件、重发 / 排队重发）在这里天然是空操作，两条路画不出第二条。
    // `running` 与子代理两道门与 `beginSend` 完全同口径：运行中发出的那条还在排队，
    // 不进账本。
    if (
      !this.echoOfView(viewId, requestId) &&
      !scope.subagentAddress &&
      !scope.running &&
      (text.trim().length > 0 || attachments.length > 0)
    ) {
      this.addEcho(this.keyForView(viewId), {
        requestId,
        ts: Date.now(),
        text,
        attachments: [...attachments],
        status: "sending",
      });
    }

    // 内容块装配收在 `buildPromptContent`（纯函数，断言在 scripts/attachments.test.ts）：
    // 附件在前、正文最后，附件之间保持列表顺序（官方 `content = [...attachments, text]`）。
    //
    // 文件附件的唯一判据是**上传回执**，不能再看 `path`：拖放 / 粘贴（剪贴板里没有真
    // 路径的那些）进来的字节附件本来就没有路径，早先那道 `!attachment.path` 的门会把
    // 上传成功的文件**整批丢掉**，而且因为门在同一处，连「有附件没传上去」的提示
    // 也不会发（2026-09-21 修）。
    const plan = buildPromptContent(text, attachments);
    const { notUploaded, dropped } = plan;
    // **排队来源自带一份内容块**（`prebuiltContent`）：那条消息当初就是这么提交的
    // （本地提交记录没了时，这一份来自 `inbox` 投影），里面可能含内联的图片字节——
    // 按文本重建会丢它们，所以有就原样用（与改动前的 `resubmit` 逐字相同）。
    const content: PromptContentPart[] = prebuiltContent?.length ? [...prebuiltContent] : plan.content;
    if (dropped.length && !prebuiltContent?.length) {
      // 表示不出来（图片没有可解析的 data URL）：不再静默，至少留一条日志
      this.log(`[submit] 这些附件无法表示成内容块，已跳过：${dropped.join("、")}`);
    }
    if (content.length === 0) {
      // 拼不出内容块（什么都没带）＝什么都没发出去：那一行标成失败（原因写在上面）；
      // 这条本来就没有回显时（尚未发出的那条 / 子代理会话）照旧把正文还回去
      if (!this.failEcho(requestId, "@sendEmpty")) {
        this.appendDraft(viewId, text, attachments);
      }
      return false;
    }

    /**
     * 「这条已经交给服务端」。
     *
     * 留在 `false` 上的所有分支（含 `try` 里那些提前 return）都由 `finally` 收网，
     * 把回显标成失败（`failEcho` 幂等、不覆盖 `catch` 里那条更具体的原因）。
     */
    let admitted = false;
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
      // 草稿与附件在 beginSend 里已清（空态那一步清的是窗口键，绑定后由
      // `bindViewToSession` 迁到会话键）；这里按会话键复述一次，不依赖迁移链路的细节。
      // **只对输入框来源做**：重发 / 排队重发的内容不是输入框里那份，清它等于擦掉用户的草稿
      if (source === "composer") {
        const key = this.keyForView(viewId);
        this.attachmentsBySession.set(key, []);
        this.drafts.set(key, "");
      }
      // 子代理会话不收文件附件（官方同一条硬规则：`subagent/attachment-invalid`，
      // 「subagent continuation does not accept files」）——有文件芯片就直接不发，
      // 把正文还回输入框让用户去掉附件再发，而不是让服务端拒绝一整轮。
      // （尚未发出的那条与子代理会话都**不回显**，所以这里没有能承载失败的那一行，
      // 沿用老口径：提示 + 回填。）
      const address = scope.subagentAddress;
      if (address && content.some((part) => part.type === "file")) {
        this.emitToView(viewId, { type: "toast", level: "warn", text: "@subagentFilesUnsupported" });
        this.appendDraft(viewId, text, attachments);
        return false;
      }
      // **先**取「发出去的那一刻 agent 还在不在跑」，再乐观置位。顺序反了的话
      // `resolveSubmitMode` 里的 `!running` 这道门永远走不进去，空闲发消息也会带
      // `mode:"steer"`（审计确认的缺陷，见 resolveSubmitMode 的注释）。
      const wasRunning = scope.running;
      scope.running = true;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["running"]),
      });
      // 队列「重新编辑」要还原用户**原始**输入，所以记的是拼引用之前的正文。
      // requestId 是 `beginSend` 铸的那一个：队列帧把同一个 id 作为 rpcId 带回，
      // 「重新编辑」凭它还原，乐观回显也凭它收回。
      this.rememberSubmission(requestId, text.trim(), content, attachments);
      // 排队来源**一律按 queue 提交**：它本来就是排队区里那条，摘出来重发要么是派发
      // （那时 agent 空闲，`resolveSubmitMode` 也会给 queue），要么是回滚（agent 还在跑，
      // 那时必须回队列，插话进当前轮不是回滚）。所以这里不猜手势，与改动前逐字相同。
      const mode = source === "queue" ? "queue" : this.resolveSubmitMode(wasRunning, gesture);
      this.log(`[submit] 来源=${source} 手势=${gesture} 运行中=${wasRunning} → mode=${mode}${address ? "（子代理）" : ""}`);
      // 子代理地址走 `subagents/prompt`（普通 `session/prompt` 对子代理会话
      // 不成立），`delivery` 就是官方 prompt `mode` 在这条端点上的名字
      if (address) {
        await this.client.promptSubagent(address.parentSessionId, scope.sessionId, content, mode, requestId);
      } else {
        await this.client.prompt(scope.sessionId, content, mode, requestId);
      }
      admitted = true;
    } catch (error) {
      scope.running = false;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["running"]),
      });
      // 这一轮没提交成功：那一行标成失败并带上服务端 / 传输层的原因（**不回填输入框**，
      // 用户口径 2026-09-25：正文留在那一行里，重发用行上的按钮）。
      // 这条提交**没有回显**时（尚未发出的那条 / 子代理会话）没有能承载失败的那一行，
      // 退回老口径：正文回输入框 + 原生错误提示。日志两种情况都照旧。
      const detail = this.describeError(error);
      this.log(`[submit] 发送失败：${detail}`);
      if (!this.failEcho(requestId, `@sendFailed:${detail}`)) {
        this.appendDraft(viewId, text, attachments);
        // 排队来源这一档的正文刚被 `appendDraft` 放回输入框，报错文案就说清这一点
        this.reportError(
          source === "queue"
            ? vscode.l10n.t("Failed to send the queued message (its content is back in the box)")
            : vscode.l10n.t("Failed to send"),
          error,
        );
      }
    } finally {
      // 兜底：`try` 里提前 return 的分支也走这里收网。`failEcho` 幂等且不覆盖更具体的
      // 原因，所以这里用最泛的那一句；没有回显时它什么都不做（上面已经按老口径收场）。
      if (!admitted) this.failEcho(requestId, "@sendUnconfirmed");
    }
    // 上传不完整的提示**放在 try 之外**：它是成功之后的告知，抛在这里不该被上面的
    // catch 当成「没发出去」（那会把已经发出去的那条标成失败，还会把 running 置回 false）
    if (admitted && notUploaded.length) this.warnUploadIncomplete(viewId, notUploaded);
    return admitted;
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
   * - `steeringAvailable` 在本扩展里**恒为真**：可发送的会话（含可继续子代理——
   *   官方对它的后续消息同样进 FIFO 收件箱、同样接受 queue/steer）都不缺插话
   *   语义；一次性子代理界面只读、根本走不到发送。
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

  /**
   * 读客户端的「代码工作工具」偏好（命名空间 `ui-settings` 的 `enabled`；官方内部标识
   * 仍叫 developer tools，rc.2 的界面名是「代码工作工具」，它的说明里就写着会控制
   * 「新对话中的 Agent 预设切换」）。
   *
   * 三条口径：
   * - **只有显式的 `false` 才算关闭**：命名空间缺席（没有 settings provider、
   *   老服务端、另一个实现）或值形状不对一律按「允许」——官方 schema 的默认值就是
   *   `true`，官方的 `DeveloperToolsPreference` 在本地模式下缺省也是 `true`；
   * - 与 `applyBusyEnter` / 图片能力 / 部署默认三处一样从同一份 `settings/describe`
   *   结果里取，读取留在控制器、判据留在纯函数（`agentPresetsFromList`）里；
   * - 值一变就重折算预设目录：用户在官方界面里关掉这个开关，本扩展那枚胶囊跟着消失
   *   （`settings/document-updated` → `reloadSettings` → `refreshImageCaps` 会再读一遍）。
   */
  private applyDeveloperTools(settings: { ns?: string; value?: unknown }[]): void {
    const section = settings.find((item) => item?.ns === "ui-settings");
    const value = (section?.value ?? {}) as { enabled?: unknown };
    const next = value.enabled === false ? false : true;
    if (next === this.developerToolsEnabled) return;
    this.developerToolsEnabled = next;
    this.publishAgentPresets();
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
    // 命令按会话执行：还没有会话时先建一个（点按钮时用户并没有先发过消息；
    // 没有工作目录时会先问一次，取消则整条命令不执行）
    let scope = this.scopeOfView(viewId);
    if (!scope) {
      scope = await this.ensureSession(viewId);
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
    // 先把会话落下来再弹文件框：附件要上传到某个会话（回执是按会话铸造的），
    // 而建会话可能还要先问一次工作目录——那个对话框必须**先**出来，否则用户会连着
    // 面对两个框，还不知道第二个在问什么（见 `ensureSession`）。
    if (!this.scopeOfView(viewId) && !(await this.ensureSession(viewId))) return;
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
    // 上传需要会话：窗口还是空态时先建（附件按键是常见的第一步动作；
    // 没有工作目录时会先问一次，取消则整批附件都不接）
    if (!this.scopeOfView(viewId)) {
      await this.ensureSession(viewId);
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
        await this.requeue(viewId, removed);
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
      await this.requeue(viewId, removed);
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@queueDispatchFailed" });
      return;
    }

    // 3) 按原顺序重新提交（首条即是「接着发出去」的那条）
    await this.resubmit(viewId, removed);
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

  /**
   * 把一批已摘出的消息按顺序重新提交。
   *
   * **走 `submitMessage` 那条统一路径**（用户 2026-09-25 口径：「队列消息发出到会话」
   * 与「用户空闲主动发出到会话」是同一条路线）——所以这一步不再自己铸 requestId、
   * 自己调 `prompt`：
   * - 这一刻 agent 空闲（ESC 中止后把队首接着发出去，是最常见的那一档）= 这条**真的
   *   发出去了** ⇒ 立刻产生乐观回显并画进对话流，与用户手按发送完全一致；
   * - agent 还在跑（`requeue` 的回滚：队列摘不动 / 等本轮结束超时）= 它**仍是排队中**，
   *   不产生回显（唯一去处还是排队区），提交模式固定 `queue`（见 `send` 的 `source`）；
   * - 失败时由统一收场接管：有回显 → 留在原地标成失败（红框 + 重发 / 撤回）；
   *   没有回显 → 正文回输入框 + 原生提示。两者都不再需要这里各写一份。
   *
   * 这里只剩「按条继续 / 按条收场」这两件只有批处理才知道的事：**这一条**失败时后面
   * 还没发的那些统一还回输入框（它们连提交都没走到），并提示一次。
   */
  private async resubmit(viewId: string, entries: { origin: QueueOrigin }[]): Promise<void> {
    for (let index = 0; index < entries.length; index++) {
      const { origin } = entries[index];
      const accepted = await this.submitMessage(
        viewId,
        origin.text,
        origin.attachments,
        "enter",
        "queue",
        // 内容块用**当初提交的那一份**：本地没有提交记录时（扩展重载过 / 记录被上限淘汰），
        // 它是从 `inbox` 投影带回来的，里面可能含内联图片字节——按文本重建会丢它们
        origin.content as PromptContentPart[] | undefined,
      );
      if (accepted) continue;
      // 这一条已经由统一路径收场（`failEcho` 标失败，或正文已回输入框）：
      // 它**后面**还没提交的那些在这里统一还回去（`submitMessage` 只管它自己那一条）
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@queueDispatchFailed" });
      for (const rest of entries.slice(index + 1)) {
        this.appendDraft(viewId, rest.origin.text, rest.origin.attachments);
      }
      return;
    }
  }

  /** 把已摘出的消息按顺序放回队列（回滚用：那一刻 agent 还在跑，所以走的是排队那条口径）。 */
  private async requeue(viewId: string, entries: { origin: QueueOrigin }[]): Promise<void> {
    if (!entries.length) return;
    await this.resubmit(viewId, entries);
  }

  /**
   * 中止当前轮。
   *
   * 刻意**不**在这里乐观地置 `running: false`：那会骗过下面的 `waitUntilIdle`，
   * 让我们在本轮真正结束前就重新提交（于是那条消息被排进队列且不会自动接续）。
   * 界面上的「生成中」由服务端回 `turn/end` 时适配器发的 patch 收掉。
   */
  /**
   * 中止当前轮。子代理会话走 `subagents/interruptByParent`（官方对子代理地址的
   * 停止路由：父地址是持久事实，父 Agent 不在线也停得了）；普通会话照旧
   * `session/cancel`。
   */
  private async cancelTurn(scope: SessionScope): Promise<void> {
    if (!this.client) return;
    try {
      const address = scope.subagentAddress;
      if (address) {
        await this.client.interruptSubagentByParent(scope.sessionId, address.parentSessionId);
      } else {
        await this.client.cancel(scope.sessionId);
      }
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

  /**
   * 按下发送那一刻的**全部乐观动作**：乐观回显 + 提交即清空（草稿与附件芯片）。
   *
   * 这是 `send` 这条链路里唯一一个**必须早于任何 await** 的入口（官方同位置的是
   * `ISession.beginSubmission`）：没有它，用户消息要等「拉起后台 → 建会话 → prompt →
   * 服务端落盘 → follow 流推事件」整条链走完才出现在消息流里（第一条消息最慢）。
   *
   * 三件事各自的口径：
   * - **回显**（见 `shared/chat.ts` 的 `PendingMessageView`）：**只在「这一刻 agent
   *   空闲」时建**——那一条会立刻以 `session/prompt` 发出去。运行中发送（排队 / 插话）
   *   不进账本：它还没发出去，唯一的去处是输入框上方的排队区，而那里由服务端名册驱动
   *   （用户 2026-09-25 口径：本次改动只针对已经发出去的消息）。于是「插在对话流的哪个
   *   位置」就是唯一要算的东西——真实行将来落在哪，它就插在哪，交接时不跳位。
   *   这条判据对**四个调用点一视同仁**：ESC 中止后把排队消息摘出来重发时，agent 空闲
   *   = 那一条真的发出去了 → 同样立刻画出来；回滚（agent 还在跑）→ 它仍是排队中的，
   *   一个字段都不进账本（见 `submitMessage` 的 `source`）；
   * - **草稿**：`commitDraft` 的调用点由此提前到「连接之前」——`ensureConnected` 可能要
   *   拉起内部 DSH（秒级），期间任何一份整份快照（窗口恢复、别的窗口切会话触发的
   *   重建）都会把刚发出去的正文塞回输入框（见 `docs/design-draft.md` 的顺序契约）；
   * - **附件**：同理。界面在按下发送那一刻还照着宿主下发的芯片渲染（它自己不清附件），
   *   而回显里已经带着同样的图片/文件——不清就会看到「芯片一份 + 回显一份」。
   *
   * 后两件事**只对输入框来源做**（`source === "composer"`）：重发 / 排队重发的那段内容
   * 不是输入框里那份，输入框里此刻可能是用户正打着的另一句话——清它就是把那句话擦掉。
   *
   * @returns 本次提交的 requestId（回显与 durable 事件的关联身份，由 `send` 带给 prompt）。
   */
  private beginSend(
    viewId: string,
    text: string,
    attachments: Attachment[],
    source: "composer" | "retry" | "queue",
  ): string {
    const requestId = randomUUID();
    const key = this.keyForView(viewId);
    const scope = this.scopeOfView(viewId);
    // 斜杠命令走命令通道（`commands/execute`），它不是用户消息，不该占一行回显。
    // 判据只能用**这一刻手里那份命令目录**（`slashCommandOf`，同步读域上的快照）：
    // 会话在的时候目录就在（会话打开时预取，见 `openScopeFollow` 旁的 `listCommandsFor`），
    // 空态第一条消息连会话都还没有，目录**无从查起**。
    //
    // 空态这里**不猜**（早先按「正文以 `/` 开头」一刀切，代价见下）：先不回显，
    // 由 `send` 建好会话、用它自己的精确判据确认「这不是命令」之后再补一次。
    // 一刀切漏掉的正是**技能调用**——`/skill-name …` 是普通消息（技能不进命令目录，
    // 见 `skillCommands`），它整类消息因此永远要等 durable 事件才出现在消息流里
    // （用户 2026-09-25 报的现场）；而反向的「先回显再收回」是一次肉眼可见的闪现。
    const slashish = attachments.length === 0 && text.trim().startsWith("/");
    const isCommand = slashish && scope !== undefined && this.slashCommandOf(scope, text) !== undefined;
    const commandUnknown = slashish && scope === undefined;
    const worthEchoing =
      (text.trim().length > 0 || attachments.length > 0) && !isCommand && !commandUnknown;
    // 子代理会话不回显（官方 `sendSession` 的 subagent 分支同样绕过 beginSubmission）：
    // 子代理转写是次要视图，不为它多养一份本地状态
    const goesOutNow = !(scope?.running ?? false);
    if (worthEchoing && goesOutNow && !scope?.subagentAddress) {
      this.addEcho(key, {
        requestId,
        ts: Date.now(),
        text,
        attachments: [...attachments],
        status: "sending",
      });
    }
    if (source === "composer") {
      this.commitDraft(viewId);
      this.commitAttachments(viewId);
    }
    return requestId;
  }

  /**
   * 往账本里放一条回显并推帧（超上限丢最旧的**未失败**一条）。
   *
   * 两个调用点，分工是「这条消息什么时候才**确定**要作为用户消息发出去」：
   * - `beginSend`：按下发送那一刻就确定（正常正文、带附件、重发 / 排队重发）；
   * - `send`：按下那一刻判不了的那一类（空态第一条 `/xxx`）——建好会话、按命令目录
   *   确认它不是命令之后立刻补上。
   *
   * 超上限只丢**没失败**的那些：失败的行是用户正看着、要能重发 / 撤回的。
   */
  private addEcho(key: string, echo: PendingMessageView): void {
    const list = this.pendingMessages.get(key) ?? [];
    list.push(echo);
    while (list.length > MAX_PENDING_MESSAGES) {
      const victim = list.findIndex((entry) => entry.status !== "failed");
      if (victim < 0) break;
      const [dropped] = list.splice(victim, 1);
      this.log(`[echo] 回显条数超过上限，丢弃最旧的未失败一条 requestId=${dropped?.requestId ?? ""}`);
    }
    this.putPending(key, list);
    this.trimPendingKeys();
    this.pushPending(key);
  }

  /**
   * 写账本：**先删再插**，把这个键顶到队尾。
   *
   * Map 对已存在的键 `set` **不改变插入序**，而插入序就是 `trimPendingKeys` 的淘汰顺序
   * ——不刷新的话，正在用的这个键可能被当成最旧的丢掉，刚产生的回显会被自己这一轮清掉。
   */
  private putPending(key: string, list: PendingMessageView[]): void {
    this.pendingMessages.delete(key);
    this.pendingMessages.set(key, list);
  }

  /**
   * 账本**键数**的全局上限（每键条数另有 `MAX_PENDING_MESSAGES`）。
   *
   * 失败的回显会跨会话切换保留（用户要能切回来接着重发 / 撤回），所以键会随
   * 「用过的会话」增长；超了淘汰最旧的键——那些会话早就没人看了。
   */
  private trimPendingKeys(): void {
    while (this.pendingMessages.size > MAX_PENDING_KEYS) {
      const oldest = this.pendingMessages.keys().next().value;
      if (oldest === undefined) break;
      this.pendingMessages.delete(oldest);
      this.log(`[echo] 回显键数超过上限，丢弃最旧的键 key=${oldest}`);
    }
  }

  /**
   * 「这条没能发出去」的收场：把那一行标成 `failed`。
   *
   * 口径（用户 2026-09-25）：失败**不撤回显示**——行留在原地、气泡红色，操作行给
   * 「重发 / 撤回」并写出原因。所以这里**不**把正文与附件塞回输入框：
   * 正文已经在那一行里了，回填只会变成「输入框一份 + 消息流一份」。
   *
   * **幂等且不覆盖具体原因**：`send` 的 `catch` 先带上服务端原文，`finally` 再用
   * 兜底原因收一次网（`@sendUnconfirmed`），后者必须让前者赢。
   *
   * @returns 有没有一条回显被标成失败。`false` = 这条提交**本来就没有回显**（运行中
   *   发送那条、子代理会话、正文长成斜杠命令但又不是命令）：那时界面上没有能承载失败的
   *   那一行，调用方要退回老口径（正文回输入框 + 原生错误提示），别把失败咽下去。
   */
  private failEcho(requestId: string, reason: string): boolean {
    for (const [key, list] of this.pendingMessages) {
      const echo = list.find((entry) => entry.requestId === requestId);
      if (!echo) continue;
      if (echo.status === "failed") return true;
      echo.status = "failed";
      echo.error = reason;
      this.putPending(key, list);
      this.log(`[echo] 回显标记为失败 requestId=${requestId} 原因=${reason}`);
      this.pushPending(key);
      return true;
    }
    return false;
  }

  /**
   * 按 requestId 取**这个窗口自己那份账本**里的一条回显（`resendPending` 要用它的正文
   * 与附件原样重发）。
   *
   * **按窗口的键找，不做全局扫描**：撤回 / 重发是界面发来的指令，只有「这条回显属于
   * 这个窗口正在看的会话」才准动它——全局按 id 找的话，一个撞上别的会话 id 的请求就能
   * 把别人那条删掉。查找仍按 requestId 认条目（提交过程中键会从 viewId 迁到会话 id，
   * 但那之后界面看到的每一行都来自它自己那个键）。
   */
  private echoOfView(viewId: string, requestId: string): PendingMessageView | undefined {
    const key = this.keyForView(viewId);
    return (this.pendingMessages.get(key) ?? []).find((entry) => entry.requestId === requestId);
  }

  /**
   * 推一份乐观回显给这个键对应的窗口。
   *
   * `key` 是**窗口键**（未绑定会话的窗口用 viewId）或**会话键**（已绑定用会话 id）——
   * 按域在不在分流投递，与 `pushAttachmentsForView` 同一套：已绑定的窗口按会话投递
   * （同一会话的多窗口看到同一份回显，与草稿/附件的现行口径一致），未绑定的定向发给它自己。
   */
  private pushPending(key: string): void {
    const frame: HostToWebview = {
      type: "patch",
      // 永远发数组（空表也是真值）：清了就是 `[]`，不需要 `null` 那套折返
      patch: { pendingMessages: [...(this.pendingMessages.get(key) ?? [])] },
    };
    if (this.scopes.has(key)) this.deliver(key, frame);
    else this.emitToView(key, frame);
  }

  /**
   * 从账本里删掉一条回显（幂等），返回它原先挂在哪个键上。
   *
   * **按 requestId 全局扫**而不是按调用方给的键：提交过程中键会从 viewId 迁到会话 id
   * （`bindViewToSession`），按 requestId 找就没有键的时序问题，调用方也不必知道当前在哪个键上。
   * 找不到就返回 `undefined`——失败路径可以放心重复调。
   *
   * 只改账本、**不推帧**：调用方要么紧接着自己推（`retireEcho`），要么下一步就会推一份
   * 带最终状态的（`resendPending`：撤回后立刻按普通发送重走一遍，`beginSend` 会推新回显）。
   */
  private removeEcho(requestId: string, reason: string): string | undefined {
    for (const [key, list] of this.pendingMessages) {
      const index = list.findIndex((echo) => echo.requestId === requestId);
      if (index < 0) continue;
      list.splice(index, 1);
      this.putPending(key, list);
      this.log(`[echo] 收回乐观回显 requestId=${requestId} 原因=${reason}`);
      return key;
    }
    return undefined;
  }

  /** 收回一条乐观回显并推给界面（幂等；找不到就什么都不做）。 */
  private retireEcho(requestId: string, reason: string): void {
    const key = this.removeEcho(requestId, reason);
    if (key !== undefined) this.pushPending(key);
  }

  /**
   * 按正文收回回显（durable 承认那条路的兜底）。
   *
   * 服务端**不保证**把 `requestId` 回写在 `source.rpcId` 上（旧版本 / 插件差异，
   * 见 `dsh/client.ts` 的 `prompt` 注释）。没有它就只能按内容对：收回该会话下**最旧的一条**
   * 文本相同的回显——最旧优先是为了「同样一句话发两次」时也对得上先后。
   * 对不上（正文里带 `@` 引用会被折写、附件消息正文为空）就不收：宁可多留一条，
   * 也不能把另一条正在等的回显误收掉。
   */
  private retireEchoByText(sessionId: string, text: string): void {
    const wanted = text.trim();
    if (!wanted) return;
    const list = this.pendingMessages.get(sessionId);
    if (!list?.length) return;
    const index = list.findIndex((echo) => echo.text.trim() === wanted);
    if (index < 0) return;
    const [echo] = list.splice(index, 1);
    this.putPending(sessionId, list);
    this.log(`[echo] 按正文收回乐观回显 requestId=${echo?.requestId ?? ""}`);
    this.pushPending(sessionId);
  }

  /**
   * 一条**人的**用户消息被 durable 承认（适配器的 `onUserMessage` 回调）。
   *
   * 有 `rpcId` 就按它收（权威、精确）；没有才退回按正文（见 `retireEchoByText`）。
   */
  private noteUserAdmitted(sessionId: string, message: { rpcId?: string; text: string }): void {
    if (message.rpcId) {
      this.retireEcho(message.rpcId, "admitted");
      return;
    }
    this.retireEchoByText(sessionId, message.text);
  }

  /** 清空这个窗口（或它绑定的会话）的附件芯片，并把「清空」推给界面（与 `commitDraft` 对称）。 */
  private commitAttachments(viewId: string): void {
    this.attachmentsBySession.set(this.keyForView(viewId), []);
    this.pushAttachmentsForView(viewId, []);
  }

  /**
   * 提交草稿：清空这个窗口（或它绑定的会话）的草稿，并把「清空」推给界面。
   *
   * **调用点必须早于任何可能推整份状态快照的 await**：空态第一次发消息时
   * `ensureSession` → `createSession` 会在绑定窗口后推一份整份快照，而快照里的 `draft`
   * 读的就是这张表（见 `snapshotFor`）。晚清一步，那一帧就把用户刚发出去的正文塞回
   * 输入框——界面上是「清空 → 闪回 → 消失」。这条顺序由 `beginSend` 保证（它排在
   * `ensureConnected` 之前）。
   *
   * 它清掉的那份草稿本来也不该留着：界面在按下发送那一刻就乐观清空了自己的输入框，
   * 所以「收到 `send` 帧」等价于「界面里已经是空的」。于是**没真的发出去**的每条路径都
   * 必须收场，否则等于吞掉用户那句话：有回显的那条标成失败（`failEcho`，正文留在那一行里），
   * 本来就没有回显的那条（运行中发送 / 子代理会话）用 `appendDraft` 把正文还回去。
   *
   * 顺序契约与两个键（窗口 / 会话）的迁移见 `docs/design-draft.md`。
   */
  private commitDraft(viewId: string): void {
    const key = this.keyForView(viewId);
    this.drafts.set(key, "");
    // 绑着会话时按会话广播（草稿按会话键存，同会话的其他窗口也按今天的口径跟着清）；
    // 还没绑（空态第一次发消息）时这个键只有这个窗口在用，定向推给它
    const sessionId = this.viewSessions.get(viewId);
    if (sessionId) this.deliver(sessionId, { type: "patch", patch: { draft: "" } });
    else this.emitToView(viewId, { type: "patch", patch: { draft: "" } });
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
   *
   * `line` 是正文里带行号的链接给的**1 基起始行**：打开后把光标落在那一行。
   * 只有普通打开这条路才用得上（要看改动时开的是对比窗口，行号在那儿没有落点）；
   * 不是正整数、或超出文件行数时按没给处理（越界的位置 `Position` 会抛）。
   */
  private async openFile(
    path: string,
    diff?: boolean,
    viewId?: string,
    cwd?: string,
    line?: number,
    fromLink = false,
  ): Promise<void> {
    // 芯片路径可能是相对会话工作目录的拼写：先解析成绝对路径再动手，
    // 不解析的话 Uri.file 拼不出可解析的 URI，「已删除」提示与打开失败
    // 都会对无辜文件发生（与 classifyFiles 同一口径，见 resolveChipPath）
    let resolved = resolveChipPath(cwd, path);
    if (!resolved) {
      // 只可能发生在「相对路径 + 拿不到会话工作目录」时（会话还没进列表）。
      // 以前这里只写日志 → 用户点了完全没反应，不知道发生了什么。
      this.log(`[open] 路径解析不了（相对且缺会话工作目录），放弃打开：${path}`);
      if (viewId) {
        this.emitToView(viewId, { type: "toast", level: "warn", text: "@chipPathUnresolved" });
      }
      return;
    }
    let effectiveLine = line;
    let existence = await this.fileExistence(vscode.Uri.file(resolved));
    // **字面路径不存在时，再试一次「路径:行号」**：链接目标里的行号有两种写法，
    // 模型常把 `#L24` 写成 `:24` / `:24-40`（标签约定串进了目标），那样整条
    // `src/a.ts:24` 会当成文件名去查盘，必然找不到——用户看到的「文件不存在」
    // 有一大半是这一条。**字面优先**：真有一个叫 `a:12` 的文件时先开它。
    if (existence === "absent" && !isLineNumber(effectiveLine)) {
      const split = splitPathLineSuffix(path);
      const retry = split ? resolveChipPath(cwd, split.path) : undefined;
      if (split && retry && (await this.fileExistence(vscode.Uri.file(retry))) === "present") {
        this.log(`[open] 「${path}」按文件找不到，按「路径:行号」重试：${split.path}:${split.line}`);
        resolved = retry;
        effectiveLine = split.line;
        existence = "present";
      }
    }
    const uri = vscode.Uri.file(resolved);
    if (diff === true) {
      if (await this.openChanges(uri)) return;
      if (existence === "absent") {
        // 磁盘上没有了、git 也没有记录 → 内容找不回。明确说一声，别静默。
        this.reportMissingFile(viewId, resolved, fromLink);
        return;
      }
    } else if (existence === "absent") {
      // 按住修饰键 = 「直接打开文件本身」，但磁盘上已经没有这个文件了，
      // 打开必然失败。这里退化成和普通点击同一条链（先试改动对比），
      // 而不是静默失败：对被删除的文件来说，能看到删除前的内容已经是最好的结果。
      if (await this.openChanges(uri)) return;
      this.reportMissingFile(viewId, resolved, fromLink);
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const position = this.revealLine(document, effectiveLine);
      await vscode.window.showTextDocument(document, {
        preview: true,
        ...(position ? { selection: new vscode.Range(position, position) } : {}),
      });
    } catch (error) {
      this.log(`[open] 打开失败 ${path}：${this.describeError(error)}`);
    }
  }

  /**
   * 「这个文件打不开」要说什么。
   *
   * **两种来路的话不一样**：芯片/交付行来自工具调用，文件确实存在过，说「已删除」
   * 是诚实的；正文里点的**链接**却常常从一开始就没指对地方（相对的不是会话工作目录、
   * 或者把行号写进了目标），这时说「文件已删除」是误导——用户会去 git 里找一个
   * 根本没删过的文件。链接这条路因此**把解析出来的绝对路径说出来**：
   * 「怎么算出来的」一眼可见，用户才能自己判断基准对不对。
   */
  private reportMissingFile(viewId: string | undefined, resolved: string, fromLink: boolean): void {
    if (!viewId) return;
    this.emitToView(viewId, {
      type: "toast",
      level: "warn",
      // 带 `:` 的绝对路径照旧整条当参数（`@key:arg` 只按第一个 `:` 切，见 i18n 断言）
      text: fromLink ? `@fileNotFound:${resolved}` : "@chipFileDeleted",
    });
  }

  /**
   * 把「正文里给的行号」落成一个可用的文档位置，拿不到就返回 undefined。
   *
   * 行号来自模型写的链接（`[…](src/a.ts#L1200)`），而文件可能比模型以为的短——
   * 越界的 `Position` 在 VS Code 里是**抛异常**，不是夹取，所以这里先自己夹到
   * 最后一行（打开文件本身仍然是对的，比整条链路失败强）。
   */
  private revealLine(document: vscode.TextDocument, line?: number): vscode.Position | undefined {
    if (!isLineNumber(line)) return undefined;
    const row = Math.min(line - 1, Math.max(0, document.lineCount - 1));
    return new vscode.Position(row, 0);
  }

  /**
   * 用系统默认程序打开一条外链（正文里点到的 http(s) / mailto 链接）。
   *
   * 界面侧已经按白名单判过一次（`webview/fileLinks.ts` 的 `externalLinkUrl`），
   * 这里再判一次：webview 发来的帧不该被当成可信输入，多认一个 scheme 就等于
   * 多开一条宿主动作（`file:` 这类会把本地路径交给系统程序）。
   *
   * 系统拒绝打开时**明确告知**用户（`openExternal` 返回 false），不静默——
   * 「点了没反应」正是这条链路要避免的失败。提示只发给**点它的那个窗口**
   * （同文件芯片：多个面板开着时，别的会话不该弹这条）。
   */
  private async openExternal(url: string, viewId: string): Promise<void> {
    const refuse = (): void => {
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@openExternalFailed" });
    };
    const allowed = ["http:", "https:", "mailto:"];
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      this.log(`[open] 链接不是合法地址，放弃打开：${url}`);
      refuse();
      return;
    }
    if (!allowed.includes(protocol)) {
      this.log(`[open] 不打开这个 scheme 的链接：${protocol}`);
      refuse();
      return;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) {
      this.log(`[open] 系统没有接受这次打开请求：${url}`);
      refuse();
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

  /**
   * 拉取子代理目录（旧服务端的 RPC 那一路：带 `activity` 的**权威状态**）。
   *
   * **0.1.7-alpha.1 起官方已删除 `subagents/list`**，这条 RPC 只在旧服务端上存在；
   * 新服务端的目录完全由 `subagentCatalog` 投影与 `subagent/catalog` 事件承载
   * （两条路都已在用），活动状态由 `api-session/status` 中继补齐。端点不存在时
   * 记住一次（`subagentListMissing`）就不再请求——见 `endpointAbsent`。
   *
   * 三个入口共用它：域创建时打底（重载窗口/切会话后**不用点开面板**就有列表）、
   * socket 重连后重拉、面板打开时按需刷新。**单飞**：同一会话同时只发一次请求
   * （重连与域创建常常挨着发生），`finally` 里删表——它是「按会话为键的 Map」，
   * 必须有自己的清理路径。
   *
   * 服务端这一路是按**会话语料**做的完整检索（`dsh-subagent` 的 `listChildren`，
   * 不加载也不唤醒任何 Agent），但返回行**不保证是超集**（见下面的并入注释），
   * 所以结果是并入而不是替换。
   */
  private refreshSubagentCatalog(scope: SessionScope): Promise<void> {
    const client = this.client;
    if (!client) return Promise.resolve();
    // 这一版服务端**没有**这个端点（见字段注释）：不再重复请求，目录由投影与
    // durable 事件两路承载——每次开域/重连都白发一次 404 只会刷日志。
    if (this.subagentListMissing) return Promise.resolve();
    const inflight = this.subagentRefreshes.get(scope.sessionId);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const result = await client.request<{ entries?: unknown[] }>(
          "subagents/list",
          { parentSessionId: scope.sessionId },
        );
        // `subagents/list` 返回的是 RPC 行 `SubagentListEntry`：`kind:'child'` 才是
        // 可用子代理，`kind:'diagnostic'` 是「有候选但读不出身份」的诊断行——这里
        // 过滤掉是对的（**投影**那边没有这个字段，别把这段照搬过去）。
        //
        // **也是并入，不整表替换**：这一路是唯一带 `activity` 的权威值，但它**不保证
        // 是超集**——服务端对冷子代理逐个解析身份，读不出来（暂时失败 / 身份坏了）时
        // 给的是我们要滤掉的诊断行（dsh-subagent 的 `listChildren` → `resolveColdIdentity`）。
        // 整表替换会把这类行连同事件/投影那两路已有的条目一起丢掉，重载后列表又空了。
        const entries = subagentsFromList(result.entries);
        const listChanged = this.mergeSubagentEntries(scope, entries);
        if (listChanged) this.deliverSubagentList(scope);
        this.log(`[subagents] 会话=${scope.sessionId} 目录 ${scope.subagentEntries.length} 条（RPC）`);
      } catch (error) {
        // 0.1.7-alpha.1 起这个端点已从 dsh-subagent 删除（`subagentCatalog` 投影与
        // `subagent/catalog` 事件成为唯一来源）。网关对不存在的路由回 HTTP 404——
        // 那是**肯定证据**（这一版没有它），据此记住一次、不再重试，而不是每轮都报错。
        if (endpointAbsent(error)) {
          this.subagentListMissing = true;
          this.log(`[subagents] 服务端没有 subagents/list（已删除的端点），目录改由投影与事件提供`);
          return;
        }
        // **保留现有列表**，不发空帧：这条 RPC 失败只是「没拿到权威值」，把面板清空
        // 等于把一次瞬时故障说成「这个会话没有子代理」（而事件/投影那两路来的条目
        // 本来是好的）。
        this.log(`[subagents] 会话=${scope.sessionId} 目录获取失败：${this.describeError(error)}`);
      }
    })().finally(() => {
      this.subagentRefreshes.delete(scope.sessionId);
    });
    this.subagentRefreshes.set(scope.sessionId, task);
    return task;
  }

  /**
   * 标题旁导航打开时的按需刷新（按该窗口绑定的会话）。
   *
   * **刷新的是「列表根部」的目录**（官方同款：展开行调 `refreshProjection(parentId)`）：
   * 普通会话刷自己的目录；**正在看子代理时刷父会话的**——切换下拉列出的是父目录
   * （兄弟行），刷当前会话（子代理）自己的目录对那份清单没有任何帮助，反而会在
   * 子代理会话上白发一次 RPC。
   */
  private async refreshSubagents(viewId: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!this.client || !scope) {
      this.emitToView(viewId, { type: "subagents/list", entries: [] });
      return;
    }
    if (scope.subagentAddress) {
      // 子代理页：清单是父目录（兄弟行），要最新就把父目录刷一遍（父域开着时
      // RPC 那条完整检索会并入父域并回推上下文；父域不在时投影 RPC 直接补快照）
      const parent = this.scopes.get(scope.subagentAddress.parentSessionId);
      if (parent) await this.refreshSubagentCatalog(parent);
      else await this.fetchParentCatalog(scope);
      return;
    }
    await this.refreshSubagentCatalog(scope);
  }

  /**
   * 进入某个子代理的对话——**会话级切换**，与官方 Web 的 `openSession(address)`
   * 同构：窗口整个绑到子代理会话上，消息流、生成状态、输入框都换成它的（可继续
   * 子代理可以接着对话，不再只读）。
   *
   * 目标子代理的**父会话**由当前视图推出——**层级不能因为切换而变深**（用户
   * 2026-09-24 口径）：
   * - 当前在普通会话上 → 目录里那一行的父会话就是本会话；
   * - 当前在子代理上 → 只在**父目录**（兄弟行）里找目标，父会话还是原父会话。
   *   刻意**不去**搜当前会话自己的目录——那是「本会话的下级」，把它当查找空间
   *   就等于把切换变成「进入更深一层」（先查自身目录的写法就有这个歧义）。
   *
   * 地址的 `mode` 来自目录行：硬编码 `continuable` 打开 one-shot 子代理会被宿主以
   * `subagent/unauthorized` 拒绝（address 是宿主鉴权的一部分，不是提示）。
   */
  private async openSubagent(viewId: string, childSessionId: string): Promise<void> {
    if (!this.client) return;
    const scope = this.scopeOfView(viewId);
    if (!scope) return;
    // 已经在这个子代理上：什么都不做（重绑会把粘性显示值清掉后等不到回填）
    if (scope.sessionId === childSessionId) return;
    // 目标行与它的父会话。查找空间**只有一份**：普通会话查自己的目录（目标 = 自己
    // 的子代理）；子代理会话查父目录（目标 = 兄弟），父会话保持不变。两条空间互斥，
    // 「从子代理页切换」永远不可能把父会话算成当前会话（层级不变）。
    // 命中的那份目录同时作为**父目录种子**随行（`openSession` → `ensureScope`）：
    // 切换会回收当前域、新域建好那一刻父域多半已被回收，等不到投影 RPC 快照就要发——
    // 种子让切换后的第一帧就有完整的兄弟清单（2026-09-25 报障的根因之一）。
    const resolve = (): { entry: SubagentView; parentId: string; catalog: SubagentView[] } | undefined => {
      const address = scope.subagentAddress;
      if (address) {
        const catalog = this.parentCatalogOf(scope);
        const sibling = catalog.find((entry) => entry.id === childSessionId);
        if (sibling) return { entry: sibling, parentId: address.parentSessionId, catalog };
        return undefined;
      }
      const own = scope.subagentEntries.find((entry) => entry.id === childSessionId);
      return own ? { entry: own, parentId: scope.sessionId, catalog: [...scope.subagentEntries] } : undefined;
    };
    let hit = resolve();
    if (!hit) {
      // 刷新的也是**查找空间所属**的目录（子代理页 = 父目录；见 refreshSubagents
      // 同一条口径），而不是当前会话自己的目录——兄弟行的 label / activity 靠它补齐
      if (scope.subagentAddress) {
        const parent = this.scopes.get(scope.subagentAddress.parentSessionId);
        if (parent) await this.refreshSubagentCatalog(parent);
        else await this.fetchParentCatalog(scope);
      } else {
        await this.refreshSubagentCatalog(scope);
      }
      hit = resolve();
    }
    if (!hit) {
      this.log(`[subagents] 目录里没有 ${childSessionId}，进入失败`);
      this.emitToView(viewId, { type: "toast", level: "warn", text: "@subagentNotFound" });
      return;
    }
    this.log(`[subagents] 进入子代理 ${hit.entry.label}（${childSessionId}, ${hit.entry.mode}），父会话=${hit.parentId}`);
    // 地址的 mode 来自目录行：硬编码 `continuable` 打开 one-shot 子代理会被宿主以
    // `subagent/unauthorized` 拒绝（address 是宿主鉴权的一部分，不是提示）。
    // 父目录随行（第四参）：新域建好那一刻父域多半已被回收，快照里就得有兄弟行。
    await this.openSession(viewId, childSessionId, {
      parentSessionId: hit.parentId,
      mode: hit.entry.mode,
    }, hit.catalog);
  }

  // ---------- 斜杠命令与文件提及 ----------

  /**
   * 窗口侧「列出命令」。
   *
   * 空态下先按需建会话（命令目录是会话作用域的，见 `ensureSessionForMenu`）——
   * 这是用户 2026-09-24 报的现场：`newSession` 改成「只退回空态」之后没有域，
   * 输入 `/` 一条命令都列不出来，命令栏根本不弹。
   *
   * 拿不到会话（目录没定、连不上）时回空菜单。界面那边不需要额外的「为什么空」字段：
   * 目录没定这件事在窗口快照的 `workspace.path` 里（空串 = 未选择），界面据此显示
   * 「未选择工作区」那句提示（`webview/composerCompletion`）。
   */
  private async listCommandsForView(viewId: string): Promise<void> {
    const scope = await this.ensureSessionForMenu(viewId);
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

  /**
   * @ 提及：查询文件引用候选（按该窗口绑定的会话查）。
   *
   * 与命令目录同一个前提：候选是**会话作用域**的（`fileReferences` 按 agent 的工作目录
   * 列，没有会话就没有候选），所以空态下先按需建会话——见 `ensureSessionForMenu`。
   * 目录没定、连不上时回空列表（界面据窗口快照里的空工作目录显示「未选择工作区」）。
   */
  private async queryFiles(viewId: string, query: string): Promise<void> {
    const scope = await this.ensureSessionForMenu(viewId);
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
      // @ 列表不显示子代理会话（用户 2026-09-22 口径）：候选行不带 origin，
      // 按 `subagentSessionIds` 客户端自己过滤（判据见 sessionList.ts）。
      // 还没开始对话的空会话同样不列——它在历史列表里也被挡着（`emitSessionLists`），
      // 拿它做引用没有意义（连标题都还没有），身份只在客户端知道。
      sessions: visibleSessionCandidates(
        sessions ?? [],
        this.subagentSessionIds,
        this.blankSessionIds(),
      ).map(
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

