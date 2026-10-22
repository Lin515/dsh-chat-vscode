import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { panelTabTitle } from "../shared/chat";
import { attachmentUploadBlock } from "../shared/attachmentGate";
import type {
  Attachment,
  ChangesSummaryView,
  ChatState,
  CommandView,
  ConnectPhase,
  DiffLayout,
  DshTarget,
  FileChangeKind,
  FileRefView,
  GoalView,
  ModelSelectionView,
  NotificationView,
  PendingMessageView,
  ProviderGroupView,
  QuestionAnswerView,
  QuestionView,
  SessionRefView,
  SessionSummaryView,
  SubagentContextView,
  SubagentTreeView,
  SubagentView,
  TodoView,
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
  imageMediaTypeForEntry,
  planIntake,
  withoutAttachmentDataUrls,
  type ImageUnavailable,
  type IntakeItem,
  type IntakeRejection,
  type IntakeUpload,
  type PromptContentPart,
} from "./attachments";
import { readClipboardPaths } from "./clipboardPaths";
import { AttachmentLifecycle, type UploadReceipt } from "./attachmentLifecycle";
import { AttachmentOpenIndex, attachmentTempRoot, materializeAttachment, parseBase64DataUrl } from "./attachmentOpen";
import { readAttachmentTarget, readOriginalTarget, writeAttachmentTarget } from "./attachmentOpenStore";
import { saveChatImage } from "./imageFiles";
import { ConfigChangeRouter } from "./configChanges";
import { fileChangeKind, hasWorkingChange, isNotFoundError, resolveChipPath, splitPathLineSuffix, type FileExistence, type GitChangeStateLike } from "./fileChange";
import { missingDirectoryEntries, parentDirectoryEntry } from "./fileRefListing";
import {
  hostPlatform,
  isNativeAbsolutePath,
  LocalAccessGate,
  LocalFsBudget,
  probeExistence,
  unsupportedLocalPathForm,
} from "./localAccess";
import { readLocalImages } from "./localImages";
import { shouldContinuePaging } from "./historyPaging";
import { formatFileMention } from "./references";
import {
  formatFileMentionWithLines,
  isBrowseQuery,
  isDirectoryQuery,
  mentionPathOf,
  referenceSessionIdOf,
} from "../shared/mentions";
import { matchPresetInput } from "../shared/presetMatch";
import { presetMatchNames } from "../webview/presetDisplay";
import { resolveForVsCode } from "./hostText";
import { normalizeTurnProcessThreshold } from "../shared/turnProcessThreshold";
import { chooseTarget, describeFacts, externalStateOf, type TargetFacts } from "./connectTarget";
import { DesktopCredentialError, DesktopStartError } from "./desktopAttach";
import { DshApiError, DshAuthError, DshClient, endpointAbsent, type SessionReferenceCandidateWire, type SessionSummaryWire } from "./client";
import { createConnectionAttempts, type ConnectionAttempts, type ConnectionRound, type DshClientFactory } from "./connectionAttempts";
import type { ProjectionBlockWire } from "./projectionStore";
import { PendingInteractions, type HeldInteraction } from "./pendingInteractions";
import type {
  RemoteEventFrame,
  RemoteEventWaterfall,
  SessionControlFrame,
  SessionFollowFrame,
} from "./protocol";
import { SCHEDULE_CHANGED_EVENT } from "./protocol";
import { jobFollowFrameFromWire, jobItemsFromWire, jobRowsFromFrame } from "./jobView";
import {
  scheduleDeleteOutcome,
  scheduleEntriesFromCatalog,
  scheduleHistoryFromWire,
  scheduleUpdateOutcome,
} from "./scheduleView";
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
import {
  appendRestoredAttachments,
  queueItemsFromInbox,
  queueItemsFromWire,
  queueRestoreAttachments,
  type QueuedItemEntry,
  type QueueOrigin,
} from "./queueView";
import { modelSelectionFromProjection, subagentCatalogFromProjection, subagentIdentityFromProjection, subagentsFromList, sameSubagentRow, upsertSubagent, withSubagentActivity, withSubagentUnread, agentPresetsFromList, permissionCatalogHasAuto } from "./projections";
import type { ModelSelectionDecoded, SubagentCatalogEntryView } from "./projections";
import {
  ingestControlBaseline,
  ingestFollowSnapshot,
  ingestProjection,
  replayFollowSnapshot,
  type ProjectionHandlers,
  type ProjectionSource,
} from "./projectionIngest";
import { NotificationQueue, type NoticeInput, type NoticeRecord } from "./notificationQueue";
import { deriveTrajectoryModel } from "./trajectory";
import { backfillTrajectorySchemas, missingSchemaAnchor } from "./trajectoryBackfill";
import { normalizePath, upperDriveLetter, visibleForView, visibleForWorkspace, visibleSessionCandidates, visibleSessionRows } from "./sessionList";
import { acceptSessionStatus, decodeSessionStatus } from "./sessionStatus";
import { orderSubagentEntries } from "./subagentOrder";
import { buildSubagentTree } from "./subagentTree";
import { dropLegacyUnreadState, loadUnreadSessionIds, writeUnreadSession } from "./unreadStore";
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

/**
 * 子代理树索引的一条：父子关系 + 画树需要的显示字段。
 *
 * 与 `SessionScope.subagentEntries` 的分工：目录是**每个父会话一份**的显示清单；
 * 这份索引是**跨父会话**的血缘账本，用来画整棵树（含没打开过的祖先 / 兄弟）。
 * 两个来源的字段完整度不同（`session/list` 有父子关系与身份投影，目录事件有
 * 描述符 label 与创建时刻），并入时缺什么就保留已知值。
 */
interface IndexedSubagent {
  id: string;
  parentSessionId: string;
  label?: string;
  mode: "one-shot" | "continuable";
  createdAt?: number;
}

/** 类型守卫：这个域正在查看**子代理会话**（有子代理地址）。 */
function selfScopeHasAddress(scope: SessionScope | undefined): boolean {
  return scope?.subagentAddress !== undefined;
}

/** 提交记录（用于队列「重新编辑」还原原文）的保留时长与条数上限。 */
const SUBMISSION_TTL_MS = 30 * 60 * 1000;
const MAX_SUBMISSIONS = 50;

/**
 * 一次提交的本地记录（`submissions` 的值）。
 *
 * `sessionId` 是**提交那一刻**那条会话：`lost` 收场要把正文与附件还回输入框时必须按它，
 * 不能读「此刻窗口绑定着谁」——提交之后用户完全可以切走，那条会话域也可能已被回收
 * （见 `settleLostSubmission`）。
 *
 * `settled` = 这条提交已经收场（内容还回了输入框 / 已被 durable 承认 / 被有意取消）：
 * 同一 rpcId 的重复或迟到回执靠它挡住——重连重放会把入队 / 领取 / 收网三帧再走一遍，
 * 回执表因此会被重建。
 */
interface SubmissionRecord {
  text: string;
  attachments: Attachment[];
  content: unknown[];
  at: number;
  sessionId: string;
  settled?: boolean;
}

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

/**
 * 一条 `session/follow` 流连续失败时最多重开几次（见 `reopenScopeFollow`）。
 *
 * 达到上限后停止自动重开，由 socket 重连后的 `onConnected` 恢复全部域的流。
 * 持续失败的原因未必可知，但必须避免无限重试。
 */
const FOLLOW_RETRY_MAX = 5;

/**
 * 子代理收尾后补一次标题账本的**尾随防抖**（见 `scheduleSubagentTitles`）。
 *
 * 一次 workflow 派发会有很多个子代理依次收尾，逐个发 `session/list` 就是风暴；
 * 800ms 足够把同一批收尾合到一次请求里，而用户几乎察觉不到这点延迟。
 */
const SUBAGENT_TITLES_DEBOUNCE_MS = 800;

/**
 * 一次执行记录读取多少条。
 *
 * 20 与官方详情页「打开记录时请求最新 20 条」同口径：投递记录只有发生时刻与当时的
 * 指令，一页够铺满一屏；更早的由「加载更早」按游标续取。服务端允许 1–100，
 * 这里取小值是因为**读取次数**比单页体积更值得省（一次点击一页）。
 */
const SCHEDULE_HISTORY_PAGE = 20;

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
 * 两个后台地址是不是**同一个端点**。
 *
 * 比的是"要不要重建客户端"：会合文件里的地址带尾斜杠（`http://127.0.0.1:41001/`），
 * `DshClient` 收下时就把它去掉了（`client.ts` 的 `baseUrl`），所以必须先归一化再比——
 * 否则每次心跳都会判成"端点变了"，把一条还在重试的连接 dispose 掉另起一个。
 */
function sameEndpoint(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
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
 * 这里读到的还是**原文**：它可以写 id，也可以写界面上显示的名字，折成 id 的活由
 * `configuredAgentPreset` 干（要等 `agentPresets/list` 的目录到手才有候选可比）。
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

/** `workspace/follow` 的线格式（只取本地用得到的字段；`value` 是 `baseline` 与 `replace` 共用的完整值）。 */
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
 * `files/list` 帧里的 `cwd` 字段（没有会话工作目录时整个字段不出现）。
 *
 * 界面拿它把候选与「上一层」行的展示路径解析成完整绝对路径（悬停标题），见
 * `webview/pathDisplay.ts` 的 `resolveDisplayPath`。
 */
function frameCwd(cwd: string | undefined): { cwd?: string } {
  return cwd ? { cwd } : {};
}

/**
 * 服务端说「你点名的这个预设这条会话用不了」的那几个错误码。
 *
 * 三个都来自 `session/create` 认领一条已有会话那一路（服务端的 `rejectCreation`）：
 * - `agent-preset/not-found`：注册表里没有这个定义（自定义预设被删掉了）；
 * - `agent-preset/invalid`：定义在，但装不起来（它自己声明的插件坏了）；
 * - `agent-preset/conflict`：部署**整个**没有预设注册表，而请求又点名了一个预设。
 *
 * 三种结局都只有一条出路：**不带预设再认领一次**，由服务端按部署默认组装（见
 * `adoptBlankShell`）。别的码（目录冲突、网络、会话已被别人写住）不属于这一类，照原样抛。
 */
const PRESET_UNAVAILABLE_CODES = new Set(["agent-preset/not-found", "agent-preset/invalid", "agent-preset/conflict"]);

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
  | "internalConfigured"
  | "externalState"
  | "externalAddress"
  | "desktopConfigured"
  | "desktopRunning"
  | "desktopConnected"
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
    /**
     * 内部那一轴存不存在（`dshChat.command` 配了才算）。
     *
     * 留空 = 没有内部 DSH：界面**不给**那两颗按钮，状态短语写「内部 DSH：未配置」——
     * 与外部那半句的三态口径一致（用户 2026-10-19 口径）。
     */
    internalConfigured: facts.internalConfigured,
    /** 外部备用地址的状态：`unconfigured` 时「连接外部 DSH」置灰。 */
    externalState: externalStateOf(facts),
    /** 外部地址本身（连接中那条文案要写出"在连哪个地址"）——**来自快照**。 */
    externalAddress: snapshot.externalUrl,
    /** 配了桌面端可执行文件：按钮态据此多给一颗「启动/连接 DSH 桌面端」。 */
    desktopConfigured: facts.desktopConfigured || undefined,
    /** 桌面端进程在不在跑：只决定上面那颗按钮的措辞（选路看的是 `desktopAttachable`）。 */
    desktopRunning: facts.desktopRunning || undefined,
    /**
     * **当前这条连接**是不是桌面端内置的那套服务。
     *
     * 判据是"这一轮建起客户端的那份 `ServerInfo` 归属为 `desktop`"（`snapshot.status.info`
     * 就是 `ensure()` 最近一次的结果），**不是**目标是不是桌面端：目标粘在桌面端但这一轮
     * 还没连上时，界面不该按"已经连上桌面端"给动作。顶栏那颗「打开」按钮据此二分
     * （浏览器 / 桌面端应用窗口），理由见 `docs/design-desktop.md`「浏览器访问」。
     */
    desktopConnected:
      (round.connection === "connected" && snapshot.status.info?.ownership === "desktop") || undefined,
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
  /**
   * 连接尝试的账本与收场（见 `connectionAttempts.ts`）：轮次号、当前客户端、用户叫停的闸，
   * 以及「换目标 / 停止连接 / 放弃这一轮 / 停止内部 DSH」四个收场意图要做的全部动作。
   *
   * 它必须在**构造期**建立（要读 `log` 与 `client` 两个参数），不能写成字段初始化
   * ——那会跑在参数属性赋值之前。
   */
  private readonly attempts: ConnectionAttempts;
  /**
   * 当前这条连接。控制器里一百多处 RPC 调用点读的就是这个字段，而它的**写路径**都由
   * `attempts` 经 `clientSlot` 经手（接管 / 收场都在那边按定死的顺序做，绕不过去）。
   */
  private client: DshClient | undefined;
  private sessions: SessionSummaryView[] = [];
  /**
   * **会话落在哪个目录**的权威账本（会话 id → cwd），来自 `session/list` 的**原始行**。
   *
   * 与 `this.sessions` 的分工：那份是**界面该看见的历史**（子代理会话被
   * `visibleSessionRows` 全局藏掉、blank 位也折过），这份只回答「这条会话的 cwd 是
   * 什么」，不参与任何可见性判断。存在的理由只有一个：窗口切进**子代理会话**时，那条
   * 会话不在 `this.sessions` 里，但「这个窗口当前会话的 cwd」仍然成立——否则按 cwd
   * 收窄历史那一步读不到目录证据，这一档会退成「未分组」列表（见 `viewCwd`）。
   *
   * 生命周期：`refreshSessions` 每次**整份替换**（它是那一份列表的投影，条目数与列表
   * 同阶，单一写入口）；换连接 / 断线收场时在 `teardownStreams` 里清空，下次列表到达
   * 重建。
   */
  private sessionCwds = new Map<string, string>();
  /**
   * **会话日志里记着的 agent 预设**（会话 id → preset id），同样来自 `session/list`
   * 的**原始行**（`projections.values.agentPreset`）。
   *
   * 与 `this.sessions` 的分工和 `sessionCwds` 同一套：那份是界面该看见的历史，这份只
   * 回答「这条会话的日志记着哪个预设」。用它的地方只有一处：**指名认领一条已有空壳**
   * （`adoptBlankShell`）时把它照原样报给服务端——服务端发现目标与现状相同就什么都不
   * 记（`preset.select` 的早退分支），这条会话「自己的预设」因此原封不动；只有在服务端
   * 认不出它（定义已被删掉）时，才退回部署默认再认领一次。
   *
   * 为什么读**投影**而不是 header：服务端重建一条会话读的就是 `agentPreset` 投影
   * （`agent-preset-registry` 的 `session.ts`：header 只是创建事实，空壳期改过预设要
   * 靠 `agent-preset/selected` 事件）。列表里的投影值是**提示**（可能比活会话旧），所以
   * 它只用来「照原样再报一次」，权威判定留给服务端。
   *
   * 生命周期与 `sessionCwds` 逐条相同：`refreshSessions` 整份替换，换连接时在
   * `teardownStreams` 里清空。
   */
  private sessionPresets = new Map<string, string>();
  /**
   * 打开的会话域（sessionId → 域）。每个窗口绑定一个域；域内产生的帧只发给
   * 绑定该会话的窗口（见 `deliver`），全局帧走 `emitAll`。域在窗口首次绑定时
   * 惰性创建，最后一个绑定窗口解绑时回收。
   */
  private readonly scopes = new Map<string, SessionScope>();
  /**
   * 会话 id → 该域 `session/follow` 的**连续**失败次数（见 `reopenScopeFollow`）。
   *
   * 收到一份完整快照即清零（流真的活了）；域被回收 / socket 重连 / 扩展卸载时由
   * `closeFollowRetry` 清掉，不在表里留没有归属的条目。
   */
  private readonly followRetries = new Map<string, number>();
  /** 会话 id → 待触发的那一次跟随流重开（`closeFollowRetry` 负责取消）。 */
  private readonly followRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 会话 id → 这个域**当前这一次**开流的代号（取自 `followGenerationSeq`）。
   *
   * 回调按它认身份（见 `followIsCurrent`）：比“句柄是不是同一个”更早可用——句柄要等
   * `followSession` 返回才拿得到，而回调（含同步替身的极端时序）可能在返回之前就发生。
   * 域被回收 / 收线 / 扩展卸载时删掉条目；**代号本身不复用**（见 `followGenerationSeq`）。
   */
  private readonly followGenerations = new Map<string, number>();
  /**
   * 开流代号的全局面发号器：只增不减，**跨回收 / 收线 / 重连都不复用**。
   *
   * 不能按会话「从 0 重新发号」：收线只取消句柄，域对象照旧留在 `scopes` 里，重连后会在
   * **同一个域对象**上再开一条流——若两次都发到 1，收线前那条流的迟到 item / error / end
   * 就会通过身份判据，改写新适配器或再排一次重开（见 `followIsCurrent`）。
   */
  private followGenerationSeq = 0;
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
   * 正在接回会话的窗口（`resumeRestoreHint` 从取下 hint 到 `restoreViewSession`
   * 结算之间）。期间 `restoreHints` 里已经没有这个窗口了，但**这一轮恢复仍未结算**
   * ——后台补壳必须照样让位（见 `hasRestorePending`）。
   */
  private readonly restoreInFlight = new Set<string>();
  /**
   * 已经发过 `ready` 的窗口。
   *
   * 恢复接回必须在 `ready` 之后（那一刻推的快照才不会丢，见 `resumeRestoreHint`），
   * 而认领可能比 `ready` 更晚才落下（工作区身份未就绪时排队，见 `flushRestoreClaims`）。
   * 没有这一位，那一批窗口落地后没人唤醒，只能等 `ChatViewProvider` 的兜底定时器——
   * 定时器早于认领落下烧掉时，这次恢复就永远不发生了。
   */
  private readonly readyViews = new Set<string>();
  /**
   * 「这个窗口还没就绪时收到的开面板指令」（viewId → panel）。
   *
   * `ui/openPanel` 是**定向帧**：webview 还没发 `ready` 时它落在空处，用户点了
   * 「查看消息通知」却什么都没发生。所以先记在这里，`ready` 首帧（快照）之后补发；
   * 窗口下线时一起清掉（见 `unbindView`）。**不广播**：广播会把抽屉开到所有视图上。
   */
  private readonly pendingPanelOpens = new Map<string, string>();
  /**
   * 「命令在没有任何窗口时按下的通知入口」：先唤起主侧栏，等它的 `ready` 到了再开抽屉。
   *
   * 与 `pendingPanelOpens` 分开是因为这一刻**还不知道 viewId**——侧栏视图可能还没被
   * VS Code 实例化（`dshChat.view.focus` 才刚让它出现），所以只能记一个意图。
   */
  private pendingNotificationsOpen = false;
  /**
   * 每窗口「界面本地复制失败」请求号的已见水位（见 `reportImageCopyFailure`）。
   *
   * 与 durable `seq` 的水位**不是一回事**：这个号由 webview 自己铸造、页面重建就从头
   * 开始，所以 `ready`（新页面）与窗口下线时必须清掉，否则新页面的第一次失败会被当成
   * 「旧的重复投递」吃掉。窗口数有界，条目随 `unbindView` 清理。
   */
  private readonly copyFailureWatermarks = new Map<string, number>();
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
   * 空态页上的**待建会话**选择（按窗口）：预设与模型。
   *
   * 2026-10-01 对齐官方之后，空态窗口一进来就绑在本工作区那条空壳会话上（见
   * `newSession`），预设 / 模型都直接写在**那条会话**上——这两张表因此只剩一种用法：
   * **窗口连壳都还没有**的时候，也就是没有工作目录、`session/create` 无从下手的那一段
   * （用户还没打开文件夹、也还没选目录）。那时它们喂给 `sessionSourceOf` 的 `pending`
   * 那一路，让空态页仍能显示/修改「会话会用哪个预设、哪个模型」；目录一确定、壳建出来，
   * 值一次性落到它上面然后忘掉（见 `reuseOrCreateBlank`）。绑到**已有**会话时也清。
   */
  private readonly viewAgentPreset = new Map<string, string>();
  private readonly viewModel = new Map<string, ModelSelectionView>();
  /**
   * 空态页上的**待建会话**权限选择（按窗口）：与上面两张表同一来路、同一去路——
   * 只在「连壳都还没有」的那一段有意义（没有工作目录），且只在用户于空态页的权限菜单里
   * 点过一次时才有值。
   *
   * 有壳之后权限走的是会话自己的通道（`/permission`，见 `setPermission`），这张表用不上：
   * 空态页那枚胶囊显示的就是会话的真实值。落壳时与部署默认相同的那笔不发
   * （见 `reuseOrCreateBlank`）。
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
   * 每个窗口**当前那一次** `@` 候选查询的取消句柄。
   *
   * `@` 候选是每敲一个字符（以及每次下钻）重取一次的，新的一次必须作废上一次：
   *
   * - **省服务端的活**：对话候选那一半要扫全部会话日志（本机 339 条会话实测
   *   130ms 以上），不作废的话敲一个 10 字符的路径就会同时压出十次全语料扫描；
   * - **防旧盖新**：两次请求的往返时间不同，旧批次后到会把新列表盖掉（混出
   *   「文件是这一层的、对话是上一层的」）。
   *
   * 句柄同时是「这一次还是不是当前那一次」的判据（`isCurrentMenuQuery`），
   * 所以不需要另开一个序号表。窗口下线时一并作废（`unbindView`）。
   */
  private readonly menuQueries = new Map<string, AbortController>();
  /**
   * `@` 工作区外发现的**信任门**（宿主独家持有）。
   *
   * `@` 的承诺是「执行世界能读到这个路径」；`dshChat.url` 指向别的机器、或
   * `dshChat.command` 跑的是 WSL 时，本机列出的路径在那边可能不存在、或是另一个同名
   * 文件。门关时不扩越界发现、不发根目录的「上一层」行、也不凭本机 `stat` 抑制文件
   * 候选（仍可手写引用并正常发送）；会话引用不经过文件系统信任门。完整口径见
   * `docs/design-mentions.md`「工作区外的发现范围」。结果按 cwd 串缓存，见
   * `localAccess.ts` 的 `LocalAccessGate`。
   */
  private readonly localAccess = new LocalAccessGate();
  /**
   * 本客户端**亲眼见过它在说话**的会话 id（官方 `api-session-controller` 的
   * `engagedSessions`，见 `client/sessions/manager.ts`）。
   *
   * 会话列表行上的 `blank` 是**拉的快照**，而空壳会话的复用判据需要实时：
   *
   * - 官方客户端有事件流：`blankBit` 在 prompt 受理那一刻就翻假并 `onEngaged`；
   *   本扩展只有 `session/list` 这条通道，而建会话那一次拉取发生在第一条消息
   *   **之前**——判据于是停在「它还没开始过对话」上，下一个人点「+」时会把这条
   *   **已经用过的**会话当成空壳接回去（用户 2026-10-01 报的现场）；
   * - 服务端也要等到 `turn/start` 才把 header 里的 `blank` 翻假，与 prompt 受理之间
   *   隔着一整轮往返。
   *
   * 两个写入点，都是**肯定证据**：`markSessionEngaged`（本窗口发出去的消息被受理），
   * 以及它经 `setSessionRowRunning` 的那一路（服务端说这条会话在跑——比前一条宽：
   * 别的窗口或 dsh web 在一条扩展建出来的空壳里说话，这里同样算数）。
   *
   * 读法是官方的 `effectiveBlank`：列表行说它空、本地这一位说它不空 → **不空**
   * （见 `refreshSessions` 里折进列表行的那一步）。收敛也在那里：服务端自己翻假了、
   * 或这条已经不在列表里，本地这一位就没有留下的理由。
   */
  private readonly engagedSessions = new Set<string>();
  /**
   * 已被某个窗口**当作当前会话**绑着的空壳：`会话 id → 窗口 id`。
   *
   * 一条空壳同一时刻只属于一个窗口：别的窗口再进空态时另建一条，不接别人的壳。
   * 内容会话不受影响——两个窗口看同一条已经开始的对话照旧。
   *
   * **只在运行期存在**（宿主内存，不落盘）：扩展重启后表是空的，任何会话被打开之前
   * 一律没有占用。
   *
   * 与 `blankReservations` 的分工：这一张是**已经绑上**的事实（用来算界面上的 `occupied`
   * 与删除保护），那一张是**还没绑上**的预留（防并发窗口在 await 期间挑同一条）。
   */
  private readonly blankOccupants = new Map<string, string>();
  /**
   * 已经被某个窗口**预留**的空壳（异步落壳期间）：`会话 id → {窗口, 代号}`。
   *
   * 为什么需要它：`reuseOrCreateBlank` 从判据到写绑定跨了至少一个 await
   * （`ensureWorkspace` / `session/create` / `refreshSessions`），两个窗口同时点「+」
   * 会各自扫到**同一条**空壳，于是两个窗口最后绑到同一条上——正是「不同会话窗口不可
   * 共享」要挡的现场。判据与预留在**同一个同步步骤**里完成（`reserveReusableBlank`），
   * 之后那条壳对其他窗口就不可见了。
   *
   * **代号（token）是给释放用的身份**：一次预留被放弃（失败 / 窗口被别人绑走 /
   * 换绑）后，迟到的 finally 不许把**后来者**的预留删掉——释放只认自己那一号的条目
   * （见 `releaseBlankReservation`）。只增不减的 `blankReservationSeq` 保证代号不复用。
   */
  private readonly blankReservations = new Map<string, { viewId: string; token: number }>();
  private blankReservationSeq = 0;
  /**
   * 每个窗口**最近一次用户动作**的代号：点「+」、打开 / 恢复一条会话、关窗各占一号。
   *
   * 为什么需要它：几次用户动作串起来会跨好几串 await（`ensureConnected`、`session/create`、
   * 认领、拉列表），期间用户完全可能切到历史里的一条、关掉窗口、或者又点一次「+」。这些动作
   * **改变了这个窗口的意图**，迟到的动作必须收手——不守卫就会把用户刚切过去的那条会话从脚下
   * 抽走。
   *
   * 只看 `viewSessions.get(viewId) === sessionId` **不够**：用户切走再切回来会得到同一个值
   * （ABA）。代号是只增不减的全局序号，比较它同时覆盖「换过绑定」「关过窗口」「又点过一次」。
   *
   * 只由**用户动作入口**占号：`newSession`、`openSession`、`unbindView`。`detachView` /
   * `bindViewToSession` 这些内部步骤不占号——否则同一次动作里自己那步换绑就把自己作废了。
   * 窗口关闭时条目随 `unbindView` 删掉（比留着更省：删掉之后任何旧代号都对不上，
   * 同 id 重建也拿不到旧号）。
   */
  private readonly viewActions = new Map<string, number>();
  private viewActionSeq = 0;
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
   * 这个部署有没有实验性的 Auto review 权限档（`permissionPresets/catalog`）。
   *
   * 连上后取一次，`permission-presets/catalog-changed` 再重取。`false` 是**默认值**，
   * 也是「拿不到证据」的取值——按肯定证据写（老服务端没有这个 remote 时不列那一档）。
   */
  private permissionAutoReview = false;
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
   * 子代理树的**血缘索引**（`childId → { parentSessionId, mode, label… }`）。
   *
   * 与各会话域里的 `subagentEntries` 分开：那份目录只看得见「当前父会话的直接下级」，
   * 标题点击后的清单要画**整棵多层树**（含没打开过的祖先 / 兄弟），所以宿主得有一份
   * 跨域的血缘账本。写入口：
   * - `session/list` 原始行（`origin === 'subagent'` + `parentSessionId`）：跨进程 /
   *   跨窗口的权威血缘；
   * - 每条目录的并入点（`mergeSubagentEntries`，含 durable 事件 / 投影 / 旧 RPC）：
   *   即时补齐 label / 模式 / 创建时刻；
   * - `ensureScope` / 进入子代理：恢复路径直接落到一条子代理时，它的地址就是血缘。
   *
   * 清理路径：`session/list` 明确说某 id 不再是子代理、删除 / 归档时退掉；父链断掉
   * 的节点不硬塞进树（见 `dsh/subagentTree.ts`）。
   */
  private readonly subagentIndex = new Map<string, IndexedSubagent>();
  /**
   * 子代理会话的**驻留状态**账本（两个写入口，读入口只有一个）。
   *
   * 子代理不进界面列表（`sessionList.ts` 滤掉），但「恢复到子代理页」时域的 running
   * 打底需要它——那是唯一不依赖父会话域开着的来源（`api-session/status` 中继只在
   * 状态变化时发，重载窗口前的最后一次变化早过去了）。
   *
   * 写入口两条：`refreshSessions`（`session/list` 原始行的 `running`，服务端的权威完整
   * 视图）与 `syncSubagentActivity`（`api-session/status` 中继，实时但只报变化）。
   * 读入口只有 `knownSubagentActivity` 一处：目录行**登记时**回填 `activity`——
   * 两条路径的到达顺序因此不再决定成败（见 `decorateSubagent`）。
   *
   * 清理路径：`refreshSessions` 把被认成普通会话的 id 从账本上退掉，归档 / 删除会话
   * 也各退一条（那张表不能只增不删）。
   */
  private readonly subagentRunning = new Map<string, boolean>();
  /**
   * 子代理目录的**判定时间**账本（`childSessionId → epoch ms`）：标题清单里那一行的排序键。
   *
   * 口径（用户 2026-10-13）：清单始终按「用户消息最新的，或者 agent 轮次结果正文最新的」
   * 从上到下排（见 `subagentOrder.ts`）。判定条目只有两类，**agent 的过程消息**（思考、
   * 工具调用、逐段正文）不进这个账本——否则生成中每来一条事件就要重排一次。
   *
   * 写入口两条，都取**新**、不互相覆盖：
   *
   * - `noteSubagentTimes`（`session/list` 的原始子代理行）：服务端
   *   `sessionListMetadata.lastPromptAt`（`SessionSummary.updatedAt` =
   *   `max(createdAt, lastPromptAt)`）——**用户消息**那一半，服务端时间戳，不随 agent 的
   *   产出变化；
   * - `syncSubagentActivity`（`api-session/status` 由 running 转 false，且我们此前知道它
   *   在跑）：**一轮收尾**那一半。服务端没有「最后一条助手消息的时间」这种字段
   *   （投影与摘要都只有 `lastPromptAt`），所以这一半取宿主**亲历**的收尾时刻——中继就是
   *   服务端在收尾那一刻发的，与会话列表 `updatedAt` 一样按「两端时钟同源」读。
   *
   * 读入口只有 `orderedCatalog` 一处（下发与父目录快照都在那里排序）。
   * 生命周期属于连接而不是父域：权威列表中消失 / 变普通、删除、归档与连接收线时清理；
   * 父域回收不清，返回后重放目录仍保留同一个顺序。
   */
  private readonly subagentActivityAt = new Map<string, number>();
  /** 仅 status true 登记的亲历开轮证据；列表打底不写，status false 一次性消费。与排序账本同寿命。 */
  private readonly subagentSettlementsPending = new Set<string>();
  /** 连接收线使在途列表失效，避免旧列表响应重新填入已清理的排序账本。 */
  private subagentOrderGeneration = 0;
  /**
   * 完整列表的请求序号与**已采纳水位**：并发请求里先发后到的旧快照必须整份丢弃。
   *
   * 只比较连接代号挡不住同一连接上的并发列表：后发的列表已经删掉一条，先发的那份
   * 迟到回来仍会把它（以及标题、running）重新填回去。两个调用者都按 `applied` 拒收，
   * 不是只在索引里做一次局部保护。
   */
  private subagentListSeq = 0;
  private subagentListAppliedSeq = 0;
  /** 每份在途完整列表只可清请求前已有且等待期间未被 status 更新的记录；finally 回收。 */
  private readonly subagentOrderPruneCandidates = new Set<Set<string>>();
  /**
   * 每份在途完整列表的**血缘索引**裁剪候选（请求前已有、等待期间未被实时事实更新的 id）。
   *
   * 与排序账本那份候选同一套纪律：列表是索引生命周期的权威，但旧快照不能抹掉等待期间
   * 新到的 catalog / status / 父目录 / 新目录注册；`finally` 回收，连接收线整表清空。
   */
  private readonly subagentIndexPruneCandidates = new Set<Set<string>>();
  /**
   * 子代理会话的**标题**账本（`childSessionId → 会话标题`）：目录行缺 label 时的显示名兜底。
   *
   * 为什么需要：workflow 派发的子代理**没有描述符 label**（父目录条目里的 label 来自
   * 子代理描述符，而 workflow 起子代理时不传它），于是目录的三个来源都把 label 兜底成
   * 会话 id——一串 uuid，用户没法把它和任何东西对上。会话标题本来就有，而且**不必打开
   * 那个子代理**：`session/list` 每一行带 `projections.values.title`（官方客户端就是拿
   * 它给目录子行当 `displayTitle`：`dsh-api-session-controller` 的
   * `client/sessions/service.ts` 的 `projectList`）。
   *
   * 两个写入口：`collectSubagentTitles`（`session/list` 的原始子代理行）与 `deliver`
   * （正在看那条子代理时它自己的 `patch.session.title`——这一路让「进去过一次」成为
   * **跨域回收**的粘性事实，否则退出子代理页就再也读不到那个名字）。
   *
   * 清理路径：`session/list` 明确给出「这一行不是子代理」（`origin` 非 `subagent`）时
   * 删一条——按肯定证据动手，与 `subagentRunning` 的清理同形。
   */
  private readonly subagentTitles = new Map<string, string>();
  /** 标题账本的尾随防抖计时器（子代理收尾时补一次，见 `scheduleSubagentTitles`）。 */
  private subagentTitlesTimer: ReturnType<typeof setTimeout> | undefined;
  /** 标题账本刷新在途：同一时刻只发一次 `session/list`（见 `refreshSubagentTitles`）。 */
  private subagentTitlesInflight: Promise<void> | undefined;
  /**
   * 本地已删除的会话 id 集合（持久化于 globalState 的 `deletedSessionIds`）。
   *
   * 服务端**没有**会话删除/detach API：当前 dsh 进程打开过的会话常驻服务端内存
   * 直到进程退出，删掉本地日志目录后 `session/list` 仍会列出它们。扩展因此把
   * 删除过的 id 持久化下来，从历史/归档两个列表里永久过滤，界面不再显示。
   *
   * 唯一来路是历史抽屉里删一条（用户显式动作，空壳与内容会话都可以）：点「+」不删任何
   * 目录（停在空壳上时是完全 no-op，见 `newSession`）。刻意**不留**清理路径：唯一可靠的清理判据是
   * 「服务端已经不再列出它」，而那要等 dsh 进程重启；在列表里做减法风险更大（一次被
   * `remoteAccess` 收窄的响应就会把还该过滤的 id 放回来）。
   */
  private readonly deletedSessionIds: Set<string>;
  /**
   * 「生成完毕还没看过」的会话 id 集合（持久化于 globalState，**一个会话一把键**）。
   *
   * **只有一条来路**：离开标记 `leftGeneratingSessionIds`——我离开时那条会话正在生成，
   * 它收尾的那一刻（见 `settleRunningChange`）记成未读。任一窗口打开它
   * （`bindViewToSession`）即清除；新一轮开始时先让位给「运行中」，那一轮收尾后再亮。
   * 历史列表里这些行的标题与运行中一样显示蓝色，提醒「它已经生成完了，结果还没看」。
   * 持久化是为了跨扩展重载保留——服务端的 `session/list` 不知道这个概念，列表整份替换时
   * 也由这里回填。存放口径（为什么按会话分键、旧集合为什么作废）在 `unreadStore.ts`。
   */
  private readonly unreadSessionIds: Set<string>;
  /**
   * 消息通知队列（**宿主权威的单一内存队列**，见 `notificationQueue.ts` 与
   * `docs/design-notifications.md`）。
   *
   * 一个扩展宿主 = 一个 VS Code 窗口，所以「窗口共享」天然成立，不需要跨窗口同步；
   * webview 只是镜像（`publishNotifications` 按各视图的会话过滤后下发）。**不落盘**：
   * 队列只活在这份内存里，重载窗口或退出即清空，关面板 / 切会话 / 断线重连都保留。
   */
  private readonly notifications = new NotificationQueue();
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
   * **被拒收的权威状态位**（`api-session/status` 说「不在跑」、而本地适配器还有开放轮次）。
   *
   * 拒收本身是对的（`$events` 与 `session/follow` 两条流不同源，乱序的旧 `false` 会把停止
   * 按钮和 `waitUntilIdle` 一起骗掉），但**丢掉不复查**会留下一条谁也不纠正的假 true：随后
   * durable 收尾只改域、不改会话列表那一行，于是列表显示「生成中」，离开时被误判成生成中，
   * 下一次列表刷新把那一行翻回 false 时结算出一条假未读（用户 2026-09-30 报的现场，
   * 真机日志里两处：收尾后 2 分 13 秒 / 85 秒仍被记成「离开生成中的会话」）。
   *
   * 因此拒收时把值记在这里，等「本地有没有开放轮次」这条证据变了再重判一次（域被回收，
   * 见 `settlePendingStatus`）；durable 的 `running` 结论到达时它直接作废——那条比这条
   * 中继值新，照旧留存只会留下一条已经失效的记账（见 `openScopeFollow` 的帧回调）。列表整份刷新
   * 被采纳时同理。
   * 值只可能是 `false`——`true` 永远被采纳。
   */
  private readonly pendingStatuses = new Map<string, boolean>();
  /**
   * 域上**最近一次权威 running 结论**的版本号与值（见 `noteAuthorityRunning`）。
   *
   * 只由权威来源写：`api-session/status` 中继、会话列表整份刷新、以及适配器给出的 durable
   * 轮次边界。`send` 的乐观置位**不写这里**——提交失败收场要靠版本号把「本次自己写的 true」
   * 与「等待期间到达的权威 true」区分开：两者布尔值相同，只看 `scope.running` 分不出来。
   * 版本号取自全局单调计数，**值与乐观写入相同也照记**（权威再次确认同样是一条新证据）。
   * 用 `WeakMap` 按域对象存：域被回收即随之消失，不必另设清理点。
   */
  private readonly authorityRunning = new WeakMap<SessionScope, { version: number; running: boolean }>();
  private authoritySeq = 0;
  /**
   * 草稿与附件按会话隔离：切换会话时输入框文本与附件芯片一起切换。
   * 已绑定会话的窗口用会话 id 做键（同会话的多窗口共享）；**未绑定**的窗口用
   * 自己的 viewId 做键（各自暂存，建会话时迁移到会话键，见 `bindViewToSession`）。
   */
  private readonly drafts = new Map<string, string>();
  /**
   * 附件草稿的**归属与上传生命周期**（唯一权威表，见 `dsh/attachmentLifecycle.ts`）。
   *
   * 键与草稿 / 回显**同一套**（`keyForView`）：已绑定会话的窗口用会话 id，未绑定的
   * 用 viewId；绑定与退回空态各有一条迁移（`move`）。归属按**记录身份**保持稳定：
   * 上传的结算落在开轮那一刻那条记录上，**切换查看会话不改变已有附件的归属**，也不向
   * 当前会话推帧。字节暂存、在飞轮次、作废判据都在那边，控制器只注入一次 IO 与一次
   * 「列表变了」（回归见 `scripts/attachmentLifecycle.test.ts`）。
   */
  private readonly attachments = new AttachmentLifecycle({
    performUpload: (input) => this.performUpload(input),
    describeError: (error) => this.describeError(error),
    publish: (key, list) => this.publishAttachments(key, list),
    rememberOpenTarget: (input) => this.rememberOpenTarget(input),
    log: (message) => this.log(message),
  });
  /**
   * 「附件内容身份 → 本地能打开的那个文件」：路径通道记原文件路径，字节通道在上传成功
   * 那一刻落一份内容寻址的临时副本（见 `dsh/attachmentOpen.ts`）。
   *
   * 键是 durable 句柄，所以回放的消息（只带内容块里的句柄）也能命中——只要那份附件是
   * 这套扩展上传的。这份内存表只管**本次宿主生命周期内**的快查（含「临时副本正在落盘」
   * 那种在途状态）；跨重启靠 `globalState` 里那条持久记录续上（见 `dsh/attachmentOpenStore.ts`）：
   * 文件附件没有「回服务端取字节」这条路，路径一忘就只能提示打不开。
   */
  private readonly attachmentTargets = new AttachmentOpenIndex();
  /**
   * 乐观回显账本（见 `shared/chat.ts` 的 `PendingMessageView`）。
   *
   * **只收「已经发出去」的那一类**：按下发送那一刻 agent 空闲 = 这一次会立刻
   * `session/prompt`。运行中发送（排队 / 插话）不进这张表——它还没发出去，唯一的去处是
   * 输入框上方的排队区（服务端队列名册驱动，`syncQueue` 那条路本次一个字没动），
   * 它的成功与失败都走改动前那条老路（用户 2026-09-25 口径）。
   *
   * 键与草稿 / 附件**同一套**（`keyForView`）：已绑定会话的窗口用会话 id，未绑定的
   * 用 viewId；绑定那一刻在 `bindViewToSession` 里跟着迁移——**空态那条回显必须迁**，
   * 否则 `reuseOrCreateBlank` 绑定后立刻推的那份整份快照会把回显抹掉（快照里的
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
   *
   * 它同时是「没有回显的提交被判 `lost`」时唯一还能还原内容的地方（见
   * `settleLostSubmission`）：那一条没有能承载失败的行，正文只能凭这份记录还回输入框。
   */
  private readonly submissions = new Map<string, SubmissionRecord>();
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
   * **探测结论**：内部守护进程在不在跑、外部备用地址可不可达、桌面端内置服务在不在/可不可连
   * （同一次心跳刷新）。
   *
   * 这是**本窗口的观测**，不是管理器快照的镜像：快照里没有这几个值（内部那一轴要
   * `probeRunning()` 问"守护进程进程还在吗"、外部那一轴要发一次 HTTP、桌面端那一轴要查进程表
   * 与凭据，都是异步的，见 `docs/design-supervisor.md`「存在性判据」）。它们只在
   * `probeFacts()` / `setFacts()` / `setInternalRunning()` 三处写入，界面侧由
   * `connectionFieldsOf` 一次映射成 `internalRunning` / `internalConfigured` / `externalState` /
   * `desktopConfigured` / `desktopRunning`。
   *
   * 此前是两个字段（`internalRunning` / `externalReachable`）各自被赋值的：一个值两处
   * 镜像，"改了内部忘了外部"就会让按钮态那半句与按钮集各说各话。现在只有这一份，
   * 且外部那一轴只有 `externalStateOf(facts)` 一个读法（它本来就在 `connectTarget` 里）。
   */
  private facts: TargetFacts = {
    internalRunning: false,
    internalConfigured: false,
    externalConfigured: false,
    externalReachable: false,
    desktopConfigured: false,
    desktopRunning: false,
    desktopAttachable: false,
  };
  /**
   * **粘性目标**：这一轮连内部还是外部，以及激活期那一次允不允许"内部不存在就拉起一套"。
   *
   * 用户 2026-09-18 口径：自动路径**选一次就不再换**（换目标 = 换服务器、换会话列表、
   * 丢掉正在跑的轮次），只有用户点按钮才换。`undefined` = 还没选过——激活期的自动选路
   * 还没落地，或扩展启动时 `dshChat.autoConnect` 本就关着；这一档心跳什么都不做（界面给按钮）。
   *
   * `mayStart` 是**激活期那一次**的许可（用户 2026-10-18 口径：自动连接只做一次，见
   * `docs/design-supervisor.md`「自动连接只做一次」）：之后心跳只按 `start: false` 接着试
   * ——只能接上还活着的后台，要拉起新的一套必须由用户显式动作发起。
   *
   * **为什么它不读快照的 `target`**：管理器那份是"上一轮 `ensure()` 记下的目标"，
   * 它**回不到 `undefined`**；而"从没定过目标"正是控制器判断"这次自动选路还没做过"的判据。
   */
  private target?: { kind: DshTarget; mayStart: boolean };
  /**
   * 激活期那一次自动连接（`startup()` → `autoConnect()`）的闸与在飞结果。
   *
   * **一个扩展宿主生命周期只做一次**（用户 2026-10-18 口径）：闸在第一个 `await` 之前落下
   * （`startup()` 是在异步清文档锁的 `finally` 里调 `autoConnect()` 的，用户完全可能在这几
   * 毫秒里自己动手），此后自动路径只许**消费**它——要连就 `await` 它，已经结束就照现状用。
   */
  private activationConnect: Promise<void> | undefined;
  /**
   * 用户在激活期里**自己动过连接**（点按钮、发送、新建/切会话、重启、停止）：迟到的自动选路让位。
   *
   * 只用于让位判断，不参与任何连接语义：`autoConnect()` 的探测是异步的（外部可达性要一次
   * HTTP），用户抢在它落地之前动手时，"内部没在跑"这类结论已经过期，不许覆盖既成事实。
   */
  private userChoseConnection = false;
  /** 连接阶段：条上"正在启动内部 DSH…"与"正在连接内部 DSH…"的区别。 */
  private connectPhase: ConnectPhase = "connecting";
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
    /**
     * 造客户端的 seam（见 `connectionAttempts`）：不给就是真实的 `DshClient`
     * ——生产路径的行为与从前逐字相同，只有离线测试会换掉它来驱动连接行为。
     */
    createClient?: DshClientFactory,
  ) {
    // 连接尝试的账本与收场：管理器那一下、跟随流清理、界面回按钮态三处是窄回调，
    // 客户端创建走 seam、当前客户端存在本类那个字段里（单一存放点）；四个收场意图的
    // 档位与顺序都在模块里（见 `connectionAttempts.ts`）
    this.attempts = createConnectionAttempts({
      stop: (options) => this.server.stop(options),
      teardownFollows: () => this.teardownStreams(),
      markStopped: () => this.setConnection("stopped"),
      clientSlot: {
        get: () => this.client,
        set: (client) => {
          this.client = client;
        },
      },
      createClient: createClient ?? ((baseUrl, token) => new DshClient(baseUrl, token, log)),
      log,
    });
    this.deletedSessionIds = new Set(this.state.get<string[]>("deletedSessionIds") ?? []);
    // 未读游标一个会话一把键（见 `unreadStore.ts`）：整份数组在多窗口下会互相覆写，
    // 把别人清掉的旗标写回来。旧口径那份整份集合连同它的判据一起作废。
    dropLegacyUnreadState(this.state);
    this.unreadSessionIds = loadUnreadSessionIds(this.state);
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
        reloadPermissionCatalog: () => this.loadPermissionCatalog(),
      },
      log,
    );
    // 早期版本存过启动令牌；令牌每次启动都会刷新，留着只会误导，直接清掉
    void this.secrets.delete(LEGACY_TOKEN_SECRET);

    // 两轴（+ 桌面端那一轴）结论的**初值**：外部与桌面端现在就能从配置断定（配没配
    // `dshChat.url` / `dshChat.desktopExecutable` 是配置事实，不必等一次探测），内部与
    // 桌面端"在不在跑"要等第一次探测——在它之前按"未运行"渲染（按钮态给的是「启动…」，
    // 点它与「连接…」是同一套逻辑，见 `docs/design-supervisor.md`「连接条按钮矩阵」）。
    // 少了这一句，配了外部地址的窗口在首帧快照里会显示"外部 DSH：未配置"
    // 并把「连接外部 DSH」置灰，直到第一轮探测回来。
    this.facts = {
      internalRunning: false,
      internalConfigured: this.server.commandConfigured,
      externalConfigured: this.server.externalUrl !== undefined,
      externalReachable: false,
      desktopConfigured: this.server.desktopConfigured,
      desktopRunning: false,
      desktopAttachable: false,
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
      // **桌面端目标**：它的端点每次启动都变（安装更新还会替换宿主，端口与凭据一起换），
      // 所以"端点变了没有"只能按**刚探到**的那一份比。管理器那份 `status.info` 是本窗口
      // `ensure()` 时写下的旧值，拿它比会永远"端点没变"，手里的客户端就会一直重连一个
      // 已经不存在的端口（用户看到的是一直"正在连接…"）。
      if (this.target?.kind === "desktop") {
        const current = await this.server.probeDesktop(false);
        // 这一刻探不到（正在启动 / 刚被关掉）：什么都不发起，下个心跳重探；手里那条
        // 客户端自己退避重连（它连的正是刚消失的那个端点）
        if (current.kind !== "attached") return;
        if (this.client && sameEndpoint(current.baseUrl, this.client.baseUrl)) return;
        if (!this.attempts.retryable) return;
        // 只借它那句"按原目标重建"：`ensure()` 会在桌面端那一支重新发现、重新签票
        await this.reconnectPeer({ baseUrl: current.baseUrl, owned: false, ownership: "desktop" });
        return;
      }
      const probe = await this.probeConnection(this.server.activeBaseUrl);
      if (probe.alive || !probe.info) return;
      // 端点没变：手里这条 ws 才是权威（这一次 HTTP 可能只是抖），让它自己退避重连恢复；
      // 这里再 ensure 一轮等于把一条还在重试的连接 dispose 掉、另起第二个。
      if (this.client && sameEndpoint(probe.info.baseUrl, this.client.baseUrl)) return;
      // 端点变了：通常是守护进程把 dsh 重起了（端口与令牌都换了），必须重建。
      // 这里**只接上**（start:false）——后台是守护进程在管，扩展不负责起它。
      if (!this.attempts.retryable) return;
      await this.reconnectPeer(probe.info);
      return;
    }
    // 未连接：只有"用户没叫停 + 这一轮还能接着试 + 目标已定"才继续。
    // 目标没定 = 激活期的自动选路没落地、或启动时 `autoConnect` 就关着：什么都不做（界面给按钮）。
    if (!this.attempts.autoReconnect || !this.attempts.retryable || !this.target) return;
    // **外部目标交给客户端自己重连**：它的地址是固定的，`DshClient` 的 ws 退避重连
    // （1s→2s→…→15s）就能恢复；这里再 `ensureConnected` 一轮等于**并发建第二个客户端**
    // ——两个客户端各带一套跟随流，互相打断（2026-09-19 排查"一直反复自动连接"时发现）。
    if (this.client && this.target.kind === "external") return;
    // **内部目标：只接上、不再拉起**（自动连接只在扩展启动时做一次）：`mayStart` 只在激活期
    // 那一次有效，这里一律 `start: false`。而"这一刻没有内部后台"（会合状态刚被清、守护进程
    // 换代、dsh 正在重启）**不等于这一套终结**：什么都不发起、也不改重连意图，下一个心跳重新
    // 探测，后台回来就按原目标接上。绝不 `start: true`——那正是"启动时那一次自动连接"的来路，
    // 别的窗口停掉后台后本窗口 5 秒内又 spawn 一个新 supervisor 要根治的正是它。
    if (this.target.kind === "internal" && !facts.internalRunning) return;
    // **桌面端目标**：这一刻连不上就什么都不发起（桌面端可能正在启动，或已被用户关掉），
    // 下个心跳重新探测。可连接时才比对端点——这里的端点取**刚探到的那一份**：端口每次
    // 启动都变（安装更新会替换宿主，端口与凭据一起换），而管理器那份 `status.info` 是
    // 上一次 `ensure()` 留下的，拿它比对会永远"端点没变"。
    if (this.target.kind === "desktop") {
      if (!facts.desktopAttachable) return;
      const probe = await this.server.probeDesktop(false);
      const baseUrl = probe.kind === "attached" ? probe.baseUrl : undefined;
      if (this.client && baseUrl && sameEndpoint(baseUrl, this.client.baseUrl)) return;
      await this.ensureConnected({ start: false, target: "desktop" });
      return;
    }
    // 端点没变就让手里的客户端自己恢复（同一个断口，别重建第二个）；变了才必须重建。
    const info = this.server.snapshot().status.info;
    if (this.client && info && sameEndpoint(info.baseUrl, this.client.baseUrl)) return;
    await this.ensureConnected({ start: false, target: this.target.kind });
  }

  /**
   * 只读探测三轴（内部守护进程在不在、外部地址可不可达、桌面端内置服务在不在/可不可连）。
   *
   * 外部那一次 HTTP 探测**只在未连接时做**（2026-09-19 落实到函数内部）：连上之后连接条
   * 根本不显示，而"连上了"本身就是可达证据——不跳的话每 5 秒都会朝那个地址发一次 GET。
   * 跳的时候**沿用上一次的结论**，不要改写成"不可达"（那是假的：我们正连着它）。
   *
   * 桌面端那一轴同一套口径，理由更硬：它的探测要查一次进程表（Windows 上是秒级的 CIM
   * 查询），未连接时也交给管理器缓存 `DESKTOP_PROBE_TTL_MS`。它的结论分**两轴**：
   * `desktopRunning`（认人成功，只给按钮文案用）与 `desktopAttachable`（鉴权也通过，
   * 选路看它）。
   */
  private async probeFacts(): Promise<TargetFacts> {
    const snapshot = await this.server.probeRunning();
    const externalConfigured = this.server.externalUrl !== undefined;
    const externalReachable =
      externalConfigured && this.connection !== "connected" ? await this.server.probeExternal() : this.facts.externalReachable;
    const desktopConfigured = this.server.desktopConfigured;
    let desktopRunning = this.facts.desktopRunning;
    let desktopAttachable = this.facts.desktopAttachable;
    if (desktopConfigured && this.connection !== "connected") {
      const probe = await this.server.probeDesktop(false);
      desktopRunning = probe.kind !== "not-running";
      desktopAttachable = probe.kind === "attached";
    }
    return {
      // 没配启动命令 = 没有内部那一轴，**恒为假**（探测层已经短路，这里是第二道：
      // 界面据此不给那两颗按钮，选路据此不选内部）
      internalRunning: this.server.commandConfigured && snapshot.supervisorAlive,
      internalConfigured: this.server.commandConfigured,
      externalConfigured,
      externalReachable,
      desktopConfigured,
      desktopRunning,
      desktopAttachable,
    };
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
   * 端点已经不作数了，按**原目标**重建连接。
   *
   * 两种来路：心跳发现我们连的是**别的窗口**的后台而它换了地址（或刚被重起）；桌面端目标
   * 的内置宿主被替换（安装更新会换端口与凭据）。两者都是"会话还在服务端，只是连接要重来
   * 一次"，所以走同一条路：作废在途轮 + 收掉旧客户端（含它自己的无限重连） + `start: false`
   * 重接——**绝不因此拉起任何东西**。
   *
   * `info` 只用到地址（重建时由 `ensure()` 重新发现真实端点，桌面端还会重新签票）。
   *
   * `inFlight` 去重是必须的：心跳每 5 秒一次，而重连要起 PowerShell/HTTP 好几轮，
   * 不去重就会并发建出多个客户端，每个都开一套跟随流。
   */
  async reconnectPeer(info: ServerInfo): Promise<void> {
    if (this.peerReconnect) return;
    this.peerReconnect = true;
    try {
      this.log(`[server] 端点已变，按原目标重建连接：${info.baseUrl}`);
      // 与换目标同一条纪律：作废在途轮 + 收掉旧连接（含客户端自己的无限重连）
      this.attempts.retarget();
      // 后台是守护进程在管、此刻确实在跑：这里只接上，绝不因为"连不上"就自己拉起一套
      await this.ensureConnected({ start: false });
    } catch (error) {
      this.log(`[server] 按原目标重建连接失败：${this.describeError(error)}`);
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
        // 顺手把这条子代理自己的标题记进账本：「进去过一次」于是成为**跨域回收**的
        // 粘性事实——返回父会话（子域被回收）之后目录里仍是这个名字，不退回 uuid
        this.rememberSubagentTitle(sessionId, frame.patch.session?.title);
        this.deliver(sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(selfScope), ["subagent", "subagentTree"]),
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

  // ---------- 消息通知 ----------

  /**
   * 把一个**实际发生**放进通知队列，并把新的镜像推给所有窗口。
   *
   * 这是通知的唯一入口（`docs/design-notifications.md` 的分级与准入）：调用点都在
   * **逻辑事件发生的那一处**，绝不在 `deliver` / `emitAll` 的收件人循环里——那条路
   * 对每个绑定该会话的窗口各投一份，在循环里入队会把次数按窗口数虚增。
   *
   * `sessionId` 必须是**发起这一刻的归属**（耗时操作在 await 之后仍用捕获的那个），
   * 不能在这里读「当前视图绑定着谁」：保存图片 / 打开文件这类动作发起后用户可以切走，
   * 通知不该泄漏到新会话。
   */
  private notify(input: NoticeInput): void {
    const record = this.notifications.enqueue(input);
    if (!record) return; // 重发（seq 不比水位新）：不是新的实际发生
    this.publishNotifications();
  }

  /**
   * 把队列镜像推给**每个活着的窗口**：各发它自己可见的那一份（当前会话 + 共享）。
   *
   * 只遍历收件人、不改队列，所以多少窗口看同一条会话都不会影响次数；确认与合并都
   * 只发生在宿主这一份上。视图重建（`ready`）拿到的是 `snapshotFor` 里同一份快照。
   */
  private publishNotifications(): void {
    for (const viewId of this.liveViewIds()) {
      this.emitToView(viewId, {
        type: "patch",
        patch: { notifications: this.notificationMirror(viewId) },
      });
    }
  }

  /** 某个窗口可见的通知镜像（归属取**这个窗口此刻绑着的会话**）。 */
  private notificationMirror(viewId: string | undefined): NotificationView[] {
    const sessionId = viewId ? this.viewSessions.get(viewId) : undefined;
    return this.notifications.visible(sessionId).map((record) => this.notificationView(record));
  }

  /** 队列记录 → 界面镜像项（`order` 这类排序内部量不过线）。 */
  private notificationView(record: NoticeRecord): NotificationView {
    return {
      id: record.id,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      level: record.level,
      text: record.text,
      count: record.count,
      firstAt: record.firstAt,
      lastAt: record.lastAt,
      acknowledged: record.acknowledged,
    };
  }

  /**
   * 确认一条通知（界面按它**看到的那个 id 与次数**回帧）。
   *
   * 只认这个窗口**可见**范围里的未确认记录（归属取它此刻绑定的会话，未绑定就是共享那
   * 一份——不拿 `activeSessionId` 兜底，那是别的窗口的事实）；`id` / `count` 逐字段验
   * 形状，不信任 webview 传来的任意会话。
   *
   * 用户没看到的发生不会被这次点击吞掉（见 `notificationQueue.acknowledge`）；确认成功
   * 后镜像推给**所有**窗口（确认状态在任一视图确认后同步）。空操作（过期 id、重复点击、
   * 别的视图已确认）也回这个窗口一份权威镜像——界面不本地改列表，不回帧就会卡在一条
   * 永远点不掉的提示上。
   */
  private acknowledgeNotification(viewId: string, id: unknown, seenCount: unknown): void {
    const bound = this.viewSessions.get(viewId);
    const valid =
      typeof id === "string" &&
      id.length > 0 &&
      typeof seenCount === "number" &&
      Number.isSafeInteger(seenCount) &&
      seenCount > 0;
    const visible = this.notifications.visible(bound);
    const target = valid ? visible.find((record) => record.id === id && !record.acknowledged) : undefined;
    if (!target) {
      this.emitToView(viewId, {
        type: "patch",
        patch: { notifications: this.notificationMirror(viewId) },
      });
      return;
    }
    this.notifications.acknowledge(target.id, seenCount as number);
    this.publishNotifications();
  }

  /**
   * 让某个窗口打开右侧抽屉。
   *
   * 窗口**已就绪**才直接发帧；否则先记成待开（`ready` 首帧之后补发）——
   * 命令面板入口可能在 webview 还没加载完时被按下，直接发帧会落在空处。
   */
  private openPanelTo(viewId: string, panel: string): void {
    if (this.readyViews.has(viewId)) {
      this.emitToView(viewId, { type: "ui/openPanel", panel });
      return;
    }
    this.pendingPanelOpens.set(viewId, panel);
  }

  /**
   * 命令面板入口「DSH: 查看消息通知」：让**最近活动的窗口**打开通知抽屉。
   *
   * 有活动窗口就走定向帧（与 `openHistory` 同一条路由）；一个窗口都没有时**先唤起
   * 主侧栏**并把抽屉记成待开——不能广播（那会把抽屉开到所有视图上），也不能什么都不做
   * （从未实例化过任何视图时，原来那条 `emitAll` 兜底是彻底的空操作）。
   * 队列为空时同样可打开：抽屉自己渲染空态与已确认历史。
   */
  openNotifications(): void {
    const target = this.activeViewId();
    if (target) {
      this.openPanelTo(target, "notifications");
      return;
    }
    // 一个窗口都没有：唤起主侧栏，并把抽屉记成「它的 `ready` 之后要开」。
    // `executeCommand` 会 reject（贡献点被禁用 / 视图容器没注册），不接住就是宿主里的
    // unhandled rejection，而且这个意图会一直留着、等下一个不相干的 ready 才意外打开——
    // 失败就作废并留日志。
    this.pendingNotificationsOpen = true;
    this.log("[notify] 没有活动窗口，唤起主侧栏并登记待开通知抽屉");
    vscode.commands.executeCommand("dshChat.view.focus").then(
      () => {},
      (error: unknown) => {
        this.pendingNotificationsOpen = false;
        this.log(`[notify] 唤起主侧栏失败，撤下待开的通知抽屉：${this.describeError(error)}`);
      },
    );
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
    if (folder) return upperDriveLetter(folder.uri.fsPath);
    return this.newSessionCwd ? upperDriveLetter(this.newSessionCwd) : process.cwd();
  }

  /**
   * 空态页上那一行工作目录提示（`locked` = 跟随 VS Code 打开的文件夹，不可改）。
   *
   * `locked` 为真时**没有可选目录**；为假时 `path` 可能还是空的（用户没打开文件夹、
   * 也没选过目录）——那时界面显示「未选择工作区」，不再拿宿主的 `process.cwd()` 冒充
   * （那会变成 VS Code 的安装路径，用户 2026-09-22 报的现场）。
   *
   * 没有打开文件夹时 `path` **按窗口**取（`viewId` 给出时）：先看这个窗口当前那条会话的
   * cwd，再退回用户选定的目录（`viewCwd`）——两个窗口各停在各目录的空壳上时，各自显示
   * 各自那个目录。打开着文件夹时与窗口无关（目录跟随 VS Code）。
   */
  private workspaceView(viewId?: string): NonNullable<ChatState["workspace"]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return { path: upperDriveLetter(folder.uri.fsPath), locked: true };
    // 没有打开文件夹：用户选过的那个目录；**没选过就是空串**——界面显示
    // 「未选择工作区」。绝不拿宿主的 `process.cwd()`（= VS Code 安装路径）冒充一个
    // 工作目录（用户 2026-09-22 报的现场）。
    const path = (viewId ? this.viewCwd(viewId) : undefined) ?? this.newSessionCwd;
    return { path: path ? upperDriveLetter(path) : "", locked: false };
  }

  /**
   * 空态页那行工作目录**按窗口**推：每个窗口显示的是它自己那条会话的目录。
   *
   * 没有打开文件夹时才有差别；打开着文件夹时每份都一样（目录跟随 VS Code），逐窗口
   * 发只是把同一份值多发几下——保持一条发射路径，比两套分支少一处会漂的地方。
   */
  private emitWorkspaceViews(): void {
    for (const viewId of this.liveViewIds()) {
      this.emitToView(viewId, { type: "patch", patch: { workspace: this.workspaceView(viewId) } });
    }
  }

  /** 部署的 agent 预设目录（外观态那一份；空表表示这个部署没有可选项）。 */
  private agentPresetsView(): NonNullable<ChatState["agentPresets"]> {
    return { options: this.agentPresetOptions, selectable: this.agentPresetSelectable };
  }

  /**
   * 配置项里的值 → 要传给服务端的预设 id：**id 优先，认不出就按名字取目录里第一个命中的**
   * （规则与「同名怎么办」都在 `shared/presetMatch.ts`）。
   *
   * 名字来自 `presetMatchNames`：内置四个的中英两名出自客户端词典，自写预设用它发布的
   * 原文。目录还没到手、或服务端不允许选择（`agentPresetsFromList` 给空表）时没有候选，
   * 那就把原文原样传下去——与「填错一个 id」的旧行为一致，由服务端回
   * `agent-preset/not-found`，不在这里编造一个 id。
   */
  private configuredAgentPreset(): string | undefined {
    const raw = readAgentPreset();
    if (!raw) return undefined;
    const candidates = this.agentPresetOptions.map((option) => ({ id: option.id, names: presetMatchNames(option) }));
    return matchPresetInput(raw, candidates) || undefined;
  }

  /**
   * 一个窗口要建的会话用哪个 agent 预设：**用户点过的 > 配置项 > 服务端默认**。
   *
   * 没有窗口（命令面板等）时只认后两级。返回 undefined 表示「不指定」——调用方
   * 整个字段都不传，由服务端组装它自己的默认预设。配置项那一路可以写 id 也可以写
   * 显示名，折成 id 见 `configuredAgentPreset`。
   */
  private agentPresetFor(viewId: string | undefined): string | undefined {
    if (viewId) {
      const picked = this.viewAgentPreset.get(viewId);
      if (picked) return picked;
    }
    const configured = this.configuredAgentPreset();
    if (configured) return configured;
    // 服务端在 roster 里标了哪个是默认（`isDefault`）；认不出就不指定
    return this.agentPresetOptions.find((option) => option.isDefault)?.id;
  }

  /**
   * **还没有壳**的窗口要显示的那几项值（喂给 `sessionSourceOf` 的 `pending` 那一路）。
   *
   * 2026-10-01 对齐官方之后，空态窗口一进来就有会话（本工作区那条空壳），显示的一律是
   * **那条会话的真实值**；这一路只剩一种用法：**没有工作目录、连壳都建不出来**的那一段
   * （用户还没打开文件夹、也还没选目录）。那时：
   *
   * - **预设 / 模型**：用户点过的优先——否则点完像没反应；
   * - **权限 / 模型**：没有用户选择时退回部署默认（配置文件读出来的
   *   `defaultPermission` / `defaultModel`）——空态页显示的就是壳建出来时会以什么权限、
   *   什么模型、什么思考强度启动，而不是词典里编出来的某个档位。
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

  /** 未绑定窗口的会话片段来源（推补丁时用：域必然为空，只有上面那几项待建值）。 */
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
     * 清不掉、`historyLoading` 永久卡死都是这一族，见 `docs/design-projections.md`）。
     * 现在字段清单只有 `dsh/sessionView.ts` 一份：外观态（与会话无关的设置）与
     * 会话态（域 + 适配器）各由自己的构造器出，两边都带全字段，`undefined` 折成
     * `null`（`shared/wire.ts` 的过线口径）只在那两个构造器里做。
     */
    return {
      // 首帧快照的**键顺序**刻意保持与原实现一致（连接 → 外观 → 会话 → 输入区）：
      // 键集合与取值由两个构造器决定，但帧的 JSON 形态（`JSON.stringify` 的顺序）
      // 不该因为这次收敛而变——对拍线上帧时那是最容易白费一轮的噪声。
      ...this.connectionPatch(),
      ...appearanceView(this.appearanceSource(viewId)),
      // 窗口级事实（不属于会话片段，也不属于部署设置）：本窗口是不是编辑区标签组里
      // 的会话，见 `ChatState.inEditorTab`
      inEditorTab: this.viewKinds.get(viewId ?? "") === "panel",
      ...sessionView(
        sessionSourceOf(
          scope,
          sessionId ? this.summaryOfSession(sessionId) : undefined,
          this.models,
          // 空态（未绑定窗口）：预设与模型两枚胶囊显示**待建会话**的预览值，
          // 因为那时会话还不存在（见 `pendingViewFields`）
          scope ? undefined : this.pendingViewFields(viewId),
          this.subagentContextOf(scope),
          // 目录的先后同样在这一层现算（`orderedCatalog`）：会话片段与 `subagents/list`
          // 帧必须给同一个顺序，否则后到的那一帧会把界面上的先后改回去
          scope ? this.orderedCatalog(scope.subagentEntries) : undefined,
          this.subagentTreeOf(scope),
        ),
      ),
      // 输入区那三个字段按**窗口**存（未绑会话时）/ 按会话键存，不属于会话状态片段：
      // 它们由输入框那条链单独维护，这里只补进快照（见 `keyForView`）。
      // 草稿附件剥掉 `dataUrl`：图片的 base64 只该在需要它的地方过线（见
      // `withoutAttachmentDataUrls`），回显那条 `pendingMessages` 保留。
      attachments: withoutAttachmentDataUrls(this.attachments.list(sessionId ?? viewId ?? "")),
      draft: this.drafts.get(sessionId ?? viewId ?? "") ?? "",
      // 乐观回显同理按窗口键存：**空表也要发**，否则切会话时上一条会话的回显留在界面
      pendingMessages: [...(this.pendingMessages.get(sessionId ?? viewId ?? "") ?? [])],
      // 通知队列的镜像：与增量帧（`publishNotifications`）同一份取值口径——视图重建、
      // 恢复编辑区面板、切会话都靠这一份把「谁能看到哪些通知」重新对齐
      notifications: this.notificationMirror(viewId),
    };
  }

  /**
   * 增量 patch 用的取值来源：与首帧快照**同一个** `sessionSourceOf`，只是这里不需要
   * 会话摘要（patch 从不改 `session` 本身，标题那条路有自己的 `sessionWithTitle`）。
   * 子代理上下文（`subagent` 键）由域上的地址现算：父目录 / 父标题变了，下一次
   * patch 自然带上新值。
   */
  private sessionSource(scope: SessionScope | undefined): SessionViewSource {
    return sessionSourceOf(
      scope,
      undefined,
      this.models,
      undefined,
      this.subagentContextOf(scope),
      // 目录的先后与快照同源（见 `orderedCatalog`）：两个生产者给同一个顺序
      scope ? this.orderedCatalog(scope.subagentEntries) : undefined,
      this.subagentTreeOf(scope),
    );
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

  /**
   * 子代理会话的显示名：目录行经过 `resolveSubagentDisplay` 解析后的 label
   * （真 label → 会话标题 → 会话 id，见那条函数）；目录里找不到时退回会话 id。
   */
  private subagentLabelOf(scope: SessionScope): string {
    const siblings = this.parentCatalogOf(scope);
    const entry = siblings.find((item) => item.id === scope.sessionId);
    return entry ? this.resolveSubagentDisplay(entry).label : scope.sessionId;
  }

  /**
   * 子代理域的**父目录**（兄弟行）：父会话域还开着时用它的实时目录，否则用进入时
   * 抄下的快照。两者都空时至少要含自己——自己的地址必然成立（进得来就说明成立）。
   *
   * 这里**不再**就地回填显示名：目录行可以重放（投影 / 事件 / 重连），写回的名字会被
   * 下一次「label 等于会话 id」的并入覆盖回去（「关掉再打开又变回 ID」）。显示名统一
   * 在发帧那一刻由 `resolveSubagentDisplay` 现算。
   */
  private parentCatalogOf(scope: SessionScope): SubagentView[] {
    if (!scope.subagentAddress) return [];
    const parentScope = this.scopes.get(scope.subagentAddress.parentSessionId);
    const entries = parentScope ? parentScope.subagentEntries : scope.subagentSiblings;
    const existing = entries.find((entry) => entry.id === scope.sessionId);
    // 顺序在**读**这一层统一（`orderedCatalog`）：父域不在时用的是进入时抄下的那份快照，
    // 它记的是那一刻的先后，而判定时间随时在变。
    if (existing) return this.orderedCatalog(entries);
    return this.orderedCatalog(
      upsertSubagent(
        entries,
        this.decorateSubagent({
          id: scope.sessionId,
          label: this.subagentDisplayName(scope) ?? scope.sessionId,
          mode: scope.subagentAddress.mode,
          activity: scope.running ? "running" : "inactive",
        }),
      ),
    );
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
    const client = this.client;
    const parentId = scope.subagentAddress?.parentSessionId;
    if (!client || !parentId) return;
    // 这一跳是异步 RPC：它回来时域可能已换绑 / 被回收，连接也可能已经收线。
    // 迟到的旧连接结果不许写进当前目录，更不许把已清理的血缘索引重新登记回来。
    const generation = this.subagentOrderGeneration;
    try {
      const value = await client.sessionProjections(parentId);
      if (this.client !== client || generation !== this.subagentOrderGeneration) return;
      if (this.scopes.get(scope.sessionId) !== scope) return;
      if (scope.subagentAddress?.parentSessionId !== parentId) return;
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
          // 本地已知的驻留状态优先；投影没有的两项（`activity` / `unread`）由
          // `decorateSubagent` 按宿主账本补齐
          return this.decorateSubagent(local?.activity ? { ...entry, activity: local.activity } : entry);
        }),
        ...known.filter((item) => !entries.some((entry) => entry.id === item.id)),
      ];
      scope.subagentSiblings = merged;
      // 父目录投影同样是血缘证据：这些行都是 parentId 的直接下级
      for (const entry of merged) this.noteSubagentIndex(parentId, entry);
      this.log(`[subagents] 会话=${scope.sessionId} 父目录（投影）${entries.length} 条`);
      // 补齐的是**本会话域**的父目录快照：把重算后的上下文直接发给看这个会话的窗口。
      // 不能写 syncSubagentContext(本会话id)——那条的参数语义是「父会话 id」，通知的
      // 是正在看它的**子代理**的窗口；看本会话的窗口一条都收不到，缺陷永不自愈
      // （2026-09-25 报障的根因之二，回归见 scripts/subagentSwitch.test.ts 场景二）。
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["subagent", "subagentTree"]),
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
      // 每一行都过一遍显示名解析：缺 label 的行在这一刻拿到会话标题（见
      // `resolveSubagentDisplay`），触发器 / 列表行 / 编辑区标签三处同源
      parentEntries: this.parentCatalogOf(scope).map((entry) => this.resolveSubagentDisplay(entry)),
    };
  }

  /**
   * 父会话的目录变了：把新的上下文推给**正在看它子代理**的窗口。
   *
   * 界面上那条父子上下文的快照就是这里推的——用户停在子代理页时，父会话新注册了
   * 子代理（`registerSubagent`）、兄弟行跑了/停了（`syncSubagentActivity`）、投影或
   * RPC 刷新了目录（`deliverSubagentList` 的全部调用点），上下文都要跟上；整棵树的
   * 变化另行由 `redeliverSubagentTrees` 扇出。
   */
  private syncSubagentContext(parentSessionId: string): void {
    for (const scope of this.scopes.values()) {
      if (scope.subagentAddress?.parentSessionId !== parentSessionId) continue;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["subagent", "subagentTree"]),
      });
    }
  }

  /** 首帧快照里「与会话无关」的那一半（语言 / 排版 / 字号 / 批次 / 阈值 / 发送行为 / 新会话页）。 */
  private appearanceSource(viewId?: string): AppearanceViewSource {
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
      /** 权限列表里那一档实验性的 Auto review（进程级事实，见 `loadPermissionCatalog`）。 */
      permissionAutoReview: () => this.permissionAutoReview,
      /** 新会话的工作目录：空态页那一行提示（没有打开文件夹时界面可改、且按窗口取值）。 */
      workspace: () => this.workspaceView(viewId),
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
    // **自动路径**：只消费激活期那一次自动连接——那次还没落地就等它，已经落地就照现状用
    // （接上了就恢复，停在按钮态就跳过）。这里**不自己发起连接**（用户 2026-10-18 口径：
    // 自动连接只在扩展启动时做一次），否则一次窗口重载就能把用户刚停掉的后台又拉起来。
    //
    // 这一趟占一号（与 `openSession` 同源）：`awaitActivationConnect` / `refreshSessions` 都是
    // 往返，期间用户自己的动作（点历史里的一条、「+」、关窗）才是他现在的意图——
    // 恢复回来时对不上就收手，绝不覆盖用户刚选的那条。
    const action = this.beginViewAction(viewId);
    if (!this.client || this.connection !== "connected") await this.awaitActivationConnect();
    if (!this.viewActionIsCurrent(action)) {
      this.log(`[restore] 窗口=${viewId} 接回 ${sessionId} 的期间用户已经自己选了：这一次不落地`);
      return;
    }
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
    if (!this.viewActionIsCurrent(action)) {
      this.log(`[restore] 窗口=${viewId} 拉列表的期间用户已经自己选了：${sessionId} 不接回`);
      return;
    }
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
      // 认领落下时这个窗口可能早就发过 `ready` 了（那一刻没有 hint 可接）：当场唤醒它。
      // 不唤醒就只能等 `ChatViewProvider` 的兜底定时器，而那个定时器是在**挂窗口时**
      // 按 8 秒排的——它若早于本次认领烧掉，这次恢复就永远不发生了。
      if (this.readyViews.has(claim.viewId)) void this.resumeRestoreHint(claim.viewId);
    }
  }

  /**
   * 窗口的页面就绪（或兜底超时）时把暂存的会话接回去。
   *
   * 为什么必须等 `ready`：`restoreViewSession` 会推一份完整快照，而网页还没加载完
   * 时推的快照会丢（webview 的 message 监听是在 bundle 执行后才挂上的）。
   * 绑在这一刻，会话内容正好出现在它的首帧快照里。
   *
   * 还没连上时它**不消费 hint**：`ready` 完全可能早于激活期那次自动连接（`startup()` 要先
   * 异步清完文档锁）。那一趟接不了就把 hint 留在这里，等连接落地后 `onConnected` 回来接。
   */
  async resumeRestoreHint(viewId: string): Promise<void> {
    const hint = this.restoreHints.get(viewId);
    if (!hint) return;
    // **先把 hint 认领走**（从「等 ready」挪到「正在接回」）：`ready`、认领落下与 `onConnected`
    // 都会来敲这一趟，谁先认领谁接，后到的看到已经没有 hint 就什么都不做——同一条 hint
    // 绝不接两遍。接不了时按身份还回去（见下），等下一次唤醒再来。
    this.restoreHints.delete(viewId);
    this.restoreInFlight.add(viewId);
    // 记下**这一刻**窗口的动作代号（只读，不占新号——自动恢复不该把用户的动作作废）：
    // 等激活期那次连接期间用户自己点了历史里的一条 / 「+」，代号就变了，这一趟作废。
    const action = { viewId, epoch: this.viewActions.get(viewId) };
    try {
      if (!this.client || this.connection !== "connected") {
        await this.awaitActivationConnect();
        if (!this.client || this.connection !== "connected") {
          // **接不了就还回去**：这一刻接不上（激活期那次还没发起、或它落地时停在按钮态），
          // 但"用户上次开的就是这条会话"仍然有效。烧掉它，连接落地后 `onConnected` 只会补
          // 一条空壳，用户的历史会话再没有人接回来——聊天页面先就绪、激活期那次自动连接
          // 随后才结算时就会这样。
          // 只还这一条：期间若已有新的 hint 落下，那是更新的意图。
          if (!this.restoreHints.has(viewId)) this.restoreHints.set(viewId, hint);
          this.log(
            `[restore] 窗口=${viewId} 还没连上，恢复到 ${hint.sessionId} 的这次先留着（连接落地后再接）`,
          );
          return;
        }
      }
      if (!this.viewActionIsCurrent(action) || this.viewSessions.get(viewId) !== undefined) {
        // 等连接期间用户自己选了（点历史里的一条 / 「+」/ 关窗）：他现在的意图才算数，
        // 这条 hint 作废——绝不许回来把用户刚选的那条盖掉。
        this.log(`[restore] 窗口=${viewId} 等连接期间用户已经自己选了：恢复到 ${hint.sessionId} 作废`);
        return;
      }
      await this.restoreViewSession(viewId, hint.sessionId, hint.subagent);
    } finally {
      this.restoreInFlight.delete(viewId);
    }
  }

  /**
   * 这个窗口这一轮的恢复**还没结算**：认领还排着队（`restoreAwaiting`）、hint 已在手
   * 等 `ready`（`restoreHints`）、或正在接回（`restoreInFlight`）。
   *
   * 后台补壳（`adoptBlankForUnboundViews`）与 `ready` 尾巴那句「落空壳」都要先问它：
   * 恢复是这一轮「这个窗口该开哪条会话」的**唯一权威**，结算之前补壳都是猜——猜错就是
   * 把已经接好的历史会话顶掉，用户 2026-10-02 报的「重载后历史会话一闪变成空会话」
   * 正是这么来的（另一道兜底见 `reuseOrCreateBlank` 末尾的复查）。
   */
  private hasRestorePending(viewId: string): boolean {
    return (
      this.restoreHints.has(viewId) ||
      this.restoreAwaiting.has(viewId) ||
      this.restoreInFlight.has(viewId)
    );
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
    // 关窗是一次**用户动作**：正在飞的落壳回来时必须收手（绑定已经不是它的了）。
    // 条目在这里删掉：窗口的键不会再有人用，删掉同时保证「同 id 重建」也拿不到旧代号
    // （代号是只增不减的全局序号，重建会 `beginViewAction` 取新号）。
    this.viewActions.delete(viewId);
    // 关掉的窗口也可能正是「看着它生成」的那个：先取状态，`dropViewers` 之后域就没了
    const wasGenerating = this.isSessionGenerating(sessionId);
    // 窗口关掉时它那条后台任务观察流必须一起收（否则流会跟着扩展宿主一直活着）
    this.closeJobWatch(viewId);
    this.viewSessions.delete(viewId);
    // 这个窗口不再占着那条空壳（关窗 = 释放占用，界面上的行随之解锁、别人可以再用它）。
    // 只放**这一条**的占用；预留按窗口整体放掉（关窗时可能还飞着一次落壳，那张表按会话
    // 建、会一直留着，`releaseBlankReservation` 不带代号即按窗口兜底）。
    // `unbindView` 不经过 `emitViewScopedState`（那条路只在绑定 / 解绑会话时走），所以这里
    // 要自己重发一次列表帧：别的窗口那一行的占用锁必须跟着解开
    this.freeBlank(viewId, sessionId);
    this.releaseBlankReservation(viewId);
    // 未绑定会话的窗口按 viewId 存回显：viewId 是每个 webview 实例现铸的（`chatView.attach`），
    // 这个键不会再有人用，连同清掉。绑过会话的那一份挂在**会话键**上、刻意留着（用户口径：
    // 失败的那行要能重新打开这条会话继续操作），窗口下线不构成删它的理由
    if (!sessionId) {
      // 这个窗口的键不会再有人用：它名下每条回显持有的**附件租约**先放掉，再清表与草稿。
      // 只认这个键自己的回显——别的会话的失败行（与它们的租约）按现行口径跨窗口保留。
      for (const echo of this.pendingMessages.get(viewId) ?? []) {
        this.attachments.releaseLease(echo.requestId);
      }
      this.pendingMessages.delete(viewId);
      // 同理：窗口键上的附件草稿跟着这个 webview 实例走，viewId 不会再有人用
      // （绑过会话的那一份挂在会话键上、刻意留着，见 `attachmentLifecycle.release`）
      this.attachments.release(viewId);
    }
    this.revealers.delete(viewId);
    this.viewKinds.delete(viewId);
    // 标签设定器与「上次写下去的标题」跟着窗口一起清：长期存活的扩展宿主里，
    // 关掉又重开窗口会不断累积这两张按 viewId 建的表
    this.panelTitles.delete(viewId);
    this.panelTitleValues.delete(viewId);
    this.restoreHints.delete(viewId);
    // 这一轮的恢复表都按 viewId 建，窗口下线就一起清：`restoreInFlight` 那条由它自己的
    // `finally` 收尾（仍在飞的接回不打断，只是不再算进 `hasRestorePending`），
    // `restoreAwaiting` 那条则再没有人来 flush
    this.readyViews.delete(viewId);
    this.restoreAwaiting.delete(viewId);
    // 窗口下线：待开的面板与「界面复制失败」请求号水位都不再有收件人，一起清
    // （viewId 是每个 webview 实例现铸的，这个键不会再有人用）
    this.pendingPanelOpens.delete(viewId);
    this.copyFailureWatermarks.delete(viewId);
    // 这个窗口那次 `@` 候选查询一并作废：句柄按 viewId 建，不作废就是「关掉窗口后
    // 服务端还在为它扫会话日志」，表也跟着一直涨（见 `menuQueries`）
    this.menuQueries.get(viewId)?.abort();
    this.menuQueries.delete(viewId);
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
    // 这张表按会话建：域没了就没有「这个域的跟随流连续失败几次」可言，待触发的那次
    // 重开也必须作废——留存只会得到一条永远不会被清除的条目，重开还会产生一条没有收件人的流
    this.closeFollowRetry(scope.sessionId);
    this.followGenerations.delete(scope.sessionId);
    // 子代理域回收 = 用户离开这条子代理：把**这一份域上最新的**驻留状态记进宿主账本再丢。
    // 域上的值比外部那两本账都新——发送即乐观置位（见 `send`）与 durable 轮次边界
    // （见 `deliver`）都写在它上面，而用户报障的流程正是「进子代理页看一眼再回主会话」：
    // 离开这一刻不记，父会话稍后重建目录时那一行就只剩「不知道」，于是显示成「可继续」。
    // 记进去的旧结论照样由两条权威路径覆盖（`syncSubagentActivity` 的状态中继、
    // `refreshSessions` 的会话列表），所以下次进它、或者任何一条权威帧到，都会纠正。
    if (scope.subagentAddress) this.subagentRunning.set(scope.sessionId, scope.running);
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
    // 适配器没了 ⇒ 「本轮还开着」这条本地证据也就没了：被拒收过的权威状态位到这里可以
    // 定论了（见 `pendingStatuses`）。放在这一句之后——重判看的正是适配器还在不在。
    this.settlePendingStatus(scope.sessionId);
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
    // 空态那几张「还没落壳」的表到此为止：绑定之后预设 / 模型 / 权限都由这条会话自己的
    // 状态说话（空态页显示的也是它的真实值）。下次「新建对话」重新从配置项开始
    // （见 `viewAgentPreset` 的字段注释）。
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
      // 附件草稿跟着窗口键搬（**空表也算一份**：提交后的空表必须一起搬，否则会话键下
      // 读到的是更早的值——判据与草稿那句「值不是 undefined」同源，只是收进了账本）
      this.attachments.move(viewId, sessionId);
      // 乐观回显跟着迁：没有壳的空态（无工作目录那一段）发第一条消息时它先落在窗口键上，
      // 而 `reuseOrCreateBlank` 绑定之后立刻推的那份整份快照读的是**会话键**（见
      // `snapshotFor`）——不迁这一下，回显就被那一帧抹掉，正是「消息闪一下又没了」。
      // 绑定前会话键上不可能有回显（那条会话还没有窗口用过），直接搬即可。
      const pending = this.pendingMessages.get(viewId);
      if (pending) {
        this.pendingMessages.set(sessionId, pending);
        this.pendingMessages.delete(viewId);
      }
    }
    this.viewSessions.set(viewId, sessionId);
    scope.viewers += 1;
    // 空壳占位：**按窗口先把旧的收干净**——换绑走了的占用、以及这次落壳用的预留
    // （它到这一刻的使命结束，壳由「预留」转成「占用」）。顺序是先清旧的、再记新的；
    // 判据用同步的 `this.sessions`，绑定是同步步骤，不引入任何 await
    this.freeBlank(viewId);
    this.releaseBlankReservation(viewId);
    if (this.sessions.find((item) => item.id === sessionId)?.blank === true) {
      this.blankOccupants.set(sessionId, viewId);
    }
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
    // 换会话可能换了 cwd：这个窗口的历史列表与空态页那行目录都要跟着同一刻换
    this.emitViewScopedState();
  }

  /**
   * 按**窗口**发的两样东西：历史列表（没有打开文件夹时按这个窗口当前会话的 cwd 收窄，
   * 见 `emitSessionLists`）与空态页那行工作目录（`emitWorkspaceViews`）。
   *
   * 两者是同一件事（「这个窗口现在的目录是哪个」）的两面，绑定 / 解绑时缺一发就会
   * 露出上一个目录的口径：列表里是 A 的会话、目录胶囊写着 B，或者反过来。
   */
  private emitViewScopedState(): void {
    this.emitSessionLists();
    this.emitWorkspaceViews();
    // 通知是**按窗口**过滤的（当前会话 + 共享）：切会话 / 解绑之后可见范围变了，
    // 必须跟着重推一次，否则顶部会继续展示上一个会话的通知
    this.publishNotifications();
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
   * `supervisorManager` 文件头的启动决策）：只有**激活期那一次**自动选路（"都没有 → 启动内部"
   * 那一支，见 `autoConnect()`）与**用户显式**动作（发消息 / 新建会话 / 点「启动内部 DSH」/
   * 重启）为真。不允许且内部后台这一刻不在时，管理器抛 `ServerNotRunningError`：这里**保留
   * "按原目标接着接"的意图**（界面仍是"正在连接…"），而不是把"没启动"渲染成终局失败——
   * 后台完全可能马上回来（见 `classifyConnectFailure` 的表）。
   *
   * **带上 `start: true` 就记一笔"用户动过"**（见 `userChoseConnection`）：激活期的自动
   * 选路是异步的，用户在它落地之前自己发起连接时，迟到的自动结论不许覆盖既成事实。
   *
   * `options.target` 是**粘性目标**（见 `target` 字段）：不给时沿用上一次选的那个。
   */
  async ensureConnected(options: EnsureOptions = {}): Promise<void> {
    if (this.disposed) return;
    if (options.start === true) this.userChoseConnection = true;
    if (this.client && this.connection === "connected") return;
    // **并发合并**：心跳每 5 秒重试一轮，用户动作可能同时到；两轮叠在一起会建出两个
    // 客户端（两条 WS、两套跟随流，服务端会看到两个"窗口"）。
    // 已经有一轮在跑时：请求"允许启动"而那一轮没有许可 → 等它结束后**补跑一轮**
    // （否则用户点「启动内部 DSH」可能正好被合并进一次"接不上就报没启动"的尝试里，点了没反应）。
    const inFlight = this.attempts.inFlight;
    if (inFlight) {
      const wanted = options.target ?? this.target?.kind;
      const targetChanged = wanted !== undefined && wanted !== inFlight.target;
      // 目标变了（连接中从命令面板换了入口）：在途那一轮可能正卡在**没有时长上限**的
      // 等待里，先中止它让它让位，再按新目标补跑一轮——否则那一轮会一直等旧目标。
      // 同样是「只中止等待、不收连接」那一档（见 `connectionAttempts.ts` 的意图对照表）
      if (targetChanged) this.attempts.cancelWait();
      if ((options.start && !inFlight.mayStart) || targetChanged) {
        await inFlight.finished;
        return this.ensureConnected(options);
      }
      return inFlight.finished;
    }
    // 许可按"这一轮里最宽的那个请求"算；目标按粘性目标（见 `target` 字段）。
    // **没定过目标时走同一套选路**（不再硬编码内部）：那条硬编码在"命令留空"的窗口里
    // 就是"拿空命令去连内部"（用户 2026-10-19 报的自动启动，一处来路就是它）。
    const target = options.target ?? this.target?.kind ?? this.preferredTarget();
    if (!target) {
      this.log("[connect] 没有任何可用的目标（内部 DSH 没配启动命令，也没有配桌面端），不发起连接");
      this.attempts.markRetry(false);
      this.setConnection("stopped");
      return;
    }
    // 通用入口首次选路也要留下粘性目标：断线后心跳据此重新发现桌面端的新端口。
    this.target = { kind: target, mayStart: options.start === true };
    return this.attempts.run({ target, mayStart: options.start === true }, (round) => this.connectOnce(round));
  }

  /**
   * 没定过粘性目标时，按当前探测结论选一个（`chooseTarget`）；没有任何可选项时 `undefined`。
   *
   * 只在"从没选过目标"的入口用得上（发消息 / 新建 / 切会话这类显式动作赶在激活期自动选路
   * 落地之前）。**命中"内部那一轴不存在"时绝不能兜底成内部**：那正是一条拿空命令 spawn 的路。
   */
  private preferredTarget(): DshTarget | undefined {
    return chooseTarget(this.facts)?.target;
  }

  private async connectOnce(round: ConnectionRound): Promise<void> {
    // 目标取**这一轮自己记下的那个**（`ensureConnected` 选好后交给账本），不再读可能被
    // 后续用户动作改写的粘性目标：旧轮次只能处理自己的目标。
    const roundTarget = round.target;
    // 阶段：这一轮允许"内部不存在就拉起一套"、而内部此刻确实不在 → 在**启动**它
    // （发消息这类显式动作也会走到这里，文案得说实话，而不是笼统地"正在连接"）
    this.connectPhase =
      roundTarget === "internal" && round.mayStart && !this.facts.internalRunning ? "starting" : "connecting";
    this.setConnection("connecting");
    try {
      // 许可按"这一轮里最宽的那个请求"算；目标按粘性目标（见 ensureConnected）
      const info = await this.server.ensure({
        start: round.mayStart,
        target: roundTarget,
      });
      if (round.stale()) return;
      if (round.userStopped()) return this.attempts.abandon(round);
      // 上一条连接已经不作数（掉线、内部换了地址/令牌、换目标）：**先收掉它再建新的**。
      // `DshClient` 自己带无限重连，覆盖当前那条而不 dispose 就等于把一条永远重试旧地址的
      // 连接丢在后台——它还会继续回调状态（2026-09-19 修）。收跟随流与客户端是同一个动作，
      // 顺序由 `ConnectionAttempts.detach` 定。
      this.attempts.detach();
      // **认证链按"是不是外部服务器"分叉，不按"是不是本窗口拉起的"**（2026-09-14 修）：
      // peer（别的窗口拉起的、或窗口重载后接上的同一套）手里同样有会合文件里的启动
      // 令牌，必须走同一条令牌换 cookie 的路；此前它们被当成外部服务器处理，于是
      // 弹「输入令牌」框——用户报的"内部启动后拿不到 token、连不上"就是这里。
      const client =
        info.ownership === "external"
          ? await this.openExternalClient(info)
          : info.ownership === "desktop"
            ? await this.openDesktopClient(info)
            : await this.openOwnedClient(info);
      // 换 cookie / 换令牌也要几秒，期间用户可能已经换了目标或点了停止
      if (round.stale()) {
        round.discard(client);
        return;
      }
      client.onDidChangeState((state) => {
        // **旧 client 的回调不许写全局状态**：被换掉的那个客户端自己也带着无限重连，
        // 它的 connecting/disconnected 会把界面反复拉回"连接中"（2026-09-19 实测）。
        // 判据是"这一轮的账本里还是不是它"，而不是某个全局字段恰好等于它。
        if (!round.isCurrent(client)) return;
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
        if (!this.attempts.autoReconnect) return;
        this.attempts.markRetry(true);
        this.setConnection("connecting", state === "disconnected" ? "@connectionLost" : undefined);
      });
      // 接管这一轮建好的客户端。**接管失败 = 这一轮已经不作数**（换目标 / 用户叫停 /
      // 窗口释放）：客户端已被账本收掉，当前那条连接一个字都没动，这里立刻放弃。
      if (!round.adopt(client)) return;
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
      if (round.stale()) {
        round.discard();
        return;
      }
      if (round.userStopped()) {
        this.attempts.abandon(round);
        return;
      }
      this.setConnection("connected");
      // 不再自动建会话：每个窗口的会话由它自己的首次动作（发消息/新建/切会话）
      // 按需建立，空窗口保持空态——多窗口各自为政，互不同步。
    } catch (error) {
      // **这一轮已经不作数**（换目标 / 用户叫停 / 窗口释放）：迟到的失败不许当成当前错误。
      // 认证 / 拉目录 / 拉会话都可能在这个窗口里 reject，而界面与两道闸现在归新的那一轮——
      // 照旧分类会把它拉进错误档、写一条属于旧目标的详情，甚至复活重试。
      if (round.stale()) return;
      this.classifyConnectFailure(error, roundTarget);
    }
  }

  /**
   * 连接失败分三类（用户 2026-09-18 口径：**只有"还能接着试"的那类才自动重试**）。
   *
   * | 类别 | 例子 | 界面 | 自动重试 |
   * |---|---|---|---|
   * | 没后台 | `ServerNotRunningError`（本轮不许启动，或后台这一刻正好不在） | 仍在**连接中** + 原因 | 是——但只"接着接"，`start: false`，绝不自行拉起 |
   * | 用户叫停 | `WaitCancelledError` | 按钮态 | 否 |
   * | 认证类 | `DshAuthError`（要令牌 / 令牌被拒） | 按钮态 + 「输入令牌」（外部） | 否——重试解决不了凭据问题 |
   * | 桌面端凭据类 | `DesktopCredentialError`（读不到密钥 / 票被拒） | 按钮态 + 原因（**没有**令牌入口） | 否——同上，且桌面端没有可输入的东西 |
   * | 启动类 | `@serverSpawnFailed` / `@serverNotReady`（命令错、dsh 起不来）、`@desktopSpawnFailed` / `@desktopNotReady` / `@desktopExited`（桌面端起不来 / 等不到就绪 / 刚起来就退出） | 按钮态 + 原因 | 否——否则每 5 秒 spawn 一个必死进程、日志被刷爆 |
   * | 连接类 | 地址连不上、socket 断 | 仍在**连接中** + 原因 | **是**，直到连上或用户点「停止连接」 |
   *
   * 拿不到明确证据时按**连接类**处理（继续试），因为"多试几次"的代价只是日志，
   * 而把可恢复的抖动当成终局失败、让用户自己发现要点按钮，代价更大。
   */
  private classifyConnectFailure(error: unknown, roundTarget: DshTarget): void {
    if (error instanceof ServerNotRunningError) {
      // 目标**这一刻**不可用（会合状态刚被清、守护进程换代、别的窗口正把它拉起来、
      // 桌面端刚退出 / 正在启动，或这一轮本来就不许启动）：这**不是**这一套的终结。
      // 保留"按原目标接着接"的意图，下一轮心跳/重试再试；绝不 `start: true`——自动路径
      // 不负责起后台（见 `handleHeartbeat`），桌面端也不由心跳拉起。
      this.attempts.markRetry(true);
      this.log(
        roundTarget === "desktop"
          ? "[connect] 这一刻连不上桌面端内置服务（不会自行拉起）：按原目标接着等它回来"
          : "[connect] 这一刻没有可连的内部后台（不会自行拉起）：按原目标接着等它回来",
      );
      this.setConnection("connecting");
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
      this.attempts.markRetry(false);
      this.setConnection("stopped");
      return;
    }
    const detail = this.describeError(error);
    if (error instanceof DshAuthError) {
      // 认证链要到用户动作：外部服务器在连接条上给「输入令牌」入口
      if (roundTarget === "external") this.setNeedsToken(true);
      this.attempts.markRetry(false);
      this.log(`[connect] 认证失败（需要用户动作，不再自动重试）：${detail}`);
      this.setConnection("error", detail);
      return;
    }
    if (error instanceof DesktopCredentialError) {
      // 桌面端凭据不可用（读不到本机密钥 / 票被拒）：重试解决不了，回按钮态 + 原因。
      // **不置 needsToken**——桌面端没有可输入的令牌，给了入口等于骗用户去输一个不存在的东西
      this.attempts.markRetry(false);
      this.log(`[connect] 桌面端凭据不可用（需要用户动作，不再自动重试）：${detail}`);
      this.setConnection("error", detail);
      return;
    }
    if (this.isStartFailure(error)) {
      this.attempts.markRetry(false);
      this.log(`[connect] 启动失败（不再自动重试，避免反复 spawn）：${detail}`);
      this.setConnection("error", detail);
      return;
    }
    this.attempts.markRetry(true);
    this.log(`[connect] 连接失败（继续按粘性目标重试，直到连上或用户点「停止连接」）：${detail}`);
    this.setConnection("connecting", detail);
  }

  /**
   * 这一轮的异常是不是"**起来就死**"那一类（spawn 失败、或等不出一个可用的就绪状态）。
   *
   * 前两条是 `SupervisorManager` 用 `@serverSpawnFailed` / `@serverNotReady` 开头的 detail
   * 抛出来的；后三条是桌面端那一支（`desktopAttach.ts` 的 `DesktopStartError` /
   * `DesktopNotReadyError` / `DesktopExitedError`）。识别它们是为了**别自动重试**：
   * 命令/路径写错时每 5 秒 spawn 一个必死进程、日志被刷爆，比"停下来等用户"糟得多。
   */
  private isStartFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.startsWith("@serverSpawnFailed") ||
      message.startsWith("@serverNotReady") ||
      message.startsWith("@desktopSpawnFailed") ||
      message.startsWith("@desktopNotReady") ||
      message.startsWith("@desktopExited")
    );
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
    // 客户端从 `attempts` 那道 seam 出（生产就是 `new DshClient`；测试换成假客户端）
    const client = this.attempts.newClient(baseUrl, token);
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
      const client = this.attempts.newClient(info.baseUrl, undefined);
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
      const client = this.attempts.newClient(info.baseUrl, token);
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
   * 桌面端内置服务（`dshChat.desktopExecutable`）：凭据是扩展**自铸的浏览器会话票**。
   *
   * 与外部服务器那条链的区别：**没有令牌入口**。桌面端的启动令牌是 `randomBytes(32)` 按
   * 进程生成的、只经 IPC 交给 Electron 主进程（见 `docs/design-desktop.md`），用户手里
   * 根本没有可输入的东西——所以票被拒时只如实报错，不弹输入框。
   *
   * 票由管理器在 `ensure()` 里签好（发现 + 鉴权都在那一趟做，含"被拒就重签一次"），
   * 这里只负责装进客户端并做一次真实调用确认：`listSessions()` 是最轻的只读端点，
   * 也正是这条连接马上要用的那个。
   */
  private async openDesktopClient(info: ServerInfo): Promise<DshClient> {
    const cookie = info.cookie;
    const client = this.attempts.newClient(info.baseUrl, undefined);
    if (!cookie) {
      client.dispose();
      throw new DesktopCredentialError("missing");
    }
    client.useSessionCookie(cookie);
    try {
      await client.listSessions();
      this.setNeedsToken(false);
      return client;
    } catch (error) {
      client.dispose();
      // 票被拒（两边解析到不同的 DSH 主目录时就会这样）：作废缓存结论，下次重新发现重签
      if (error instanceof DshAuthError) {
        this.server.dropDesktopProbe();
        throw new DesktopCredentialError("rejected");
      }
      throw error;
    }
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

    const probe = this.attempts.newClient(baseUrl, entered);
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
    // 收跟随流 + 收客户端是同一个动作（顺序由 `ConnectionAttempts.detach` 定）
    this.attempts.detach();
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
   * ——会话 header 的 cwd 是创建事实，换文件夹不该改写既有会话。没有打开文件夹时
   * 这个值按窗口取（各看各的会话 cwd），所以逐窗口推。
   */
  refreshWorkspace(): void {
    this.emitWorkspaceViews();
  }

  /**
   * VS Code 打开 / 关掉了文件夹（`extension.ts` 的 `onDidChangeWorkspaceFolders`）。
   *
   * 除了推那一帧工作目录提示，还要给**还停在「无会话的空态」**的窗口补空壳——它们多半
   * 就是原先没有工作目录、建不出壳的那些（见 `ensureSession` 与
   * `adoptBlankForUnboundViews`）。列表先按**新的**工作区重拉一份再补：空壳的判据里
   * 就有 cwd（见 `reusableBlank`），拿旧工作区那份列表扫会扫不进新目录。
   */
  async applyWorkspaceFoldersChange(): Promise<void> {
    this.refreshWorkspace();
    if (!this.client) return;
    await this.refreshSessions();
    await this.adoptBlankForUnboundViews();
  }

  /**
   * 给还停在**「无会话的空态」**的窗口补一条空壳。
   *
   * 这种窗口只有一种来路：进空态时**没有工作目录**，`session/create` 无从下手
   * （见 `ensureSession`）。所以目录一确定（VS Code 打开文件夹、用户选了一个）就要
   * 把它们补上——两处入口：`onConnected`（连接结算、列表刚拉完）与 `pickWorkspace`
   * （用户刚选完目录）。
   *
   * 这是**自动路径**：只消费激活期那一次自动连接（`awaitActivationConnect`），既不起后台、
   * 也不自己发起连接——补壳不该成为"再连一次"的来路（用户 2026-10-18 口径）。
   */
  private async adoptBlankForUnboundViews(): Promise<void> {
    for (const viewId of this.unboundViews()) {
      // 这一轮恢复还没结算的窗口**让位**：它马上要被接回历史会话，此刻补壳纯属抢跑
      // （抢赢就是「历史会话一闪变成空会话」）。恢复结算之后：接上了会话的窗口不再是
      // `unboundViews`；没接上的则由 `ready` 尾巴那句补壳兜底，或等它第一次发 `ready`
      // 时补——被跳过的窗口都是「这一轮还没发过 ready」的那些，那也正是用户在看的
      // 那一刻（见 `armRestoreFallback`）。
      if (this.hasRestorePending(viewId)) continue;
      await this.ensureSession(viewId, { start: false, askDir: false });
    }
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
   * 取一次进程级权限目录（`permissionPresets/catalog`），把「有没有实验性的
   * Auto review 档」这一点记下来并推给窗口。
   *
   * 失败分两类，和「按肯定证据写」同一条口径：
   * - **拿得到肯定证据的「没有」**：老服务端没有这个 remote（`endpointAbsent`：
   *   404/405）、插件没装（`gateway/invocation-unavailable`）——那时这个部署确实
   *   没有这一档，落成「不可用」，并且**不记错误日志**（那是合法部署，不是故障）；
   * - **这次没拿到**（超时、断线、5xx）：**保留原结论**，只记一行日志。把一次抖动
   *   当成「没有」会让停在 Auto review 上的会话在界面上退回别的档位显示（假结论），
   *   而 `permission-presets/catalog-changed` 之后还会再取。
   *
   * 判据本身只有一处实现（`permissionCatalogHasAuto`，纯函数、离线可断言）；
   * 这里只负责取、记、推。
   */
  private async loadPermissionCatalog(): Promise<void> {
    if (!this.client) return;
    let value: unknown;
    try {
      value = await this.client.permissionCatalog();
    } catch (error) {
      const absent =
        endpointAbsent(error) ||
        (error instanceof DshApiError && error.code === "gateway/invocation-unavailable");
      if (absent) this.publishPermissionCatalog(false);
      else this.log(`[permission] 权限目录获取失败（保留上一次结论）：${this.describeError(error)}`);
      return;
    }
    this.publishPermissionCatalog(permissionCatalogHasAuto(value));
  }

  /**
   * 把「有没有 Auto review 档」推给所有窗口，**变了才发帧**。
   *
   * 与 `publishAgentPresets` 同款：`settings/document-updated` 这类无关刷新也会走到
   * 这里的话，每轮都发一帧会让界面无谓重渲染。
   */
  private publishPermissionCatalog(available: boolean): void {
    if (available === this.permissionAutoReview) return;
    this.permissionAutoReview = available;
    this.log(`[permission] Auto review 档位：${available ? "可用" : "不可用"}`);
    this.emitAll({ type: "patch", patch: { permissionAutoReview: available } });
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
   * 给**还没落壳**的窗口补一帧 `agentPreset`。
   *
   * 那几枚胶囊的最后一级是 roster 里标了 `isDefault` 的那条——目录没到之前算不出来
   * （首帧快照发的是 null，之后又没有别的机会重推），所以目录一到就把这份结论补发给
   * 还没绑定会话的窗口。有壳的窗口不在这里：它们显示的是那条会话自己的预设（见
   * `pendingViewFields`）。
   */
  private pushPendingPresets(): void {
    for (const viewId of this.unboundViews()) {
      this.emitToView(viewId, {
        type: "patch",
        patch: sessionPatch(this.pendingSessionSource(viewId), ["agentPreset"]),
      });
    }
  }

  /** 当前**还没有壳**（没有绑定会话）的窗口：只可能是没有工作目录的那一段。 */
  private unboundViews(): string[] {
    return this.viewOrder.filter((viewId) => !this.viewSessions.has(viewId));
  }

  /**
   * 换 agent 预设：有壳就直接换在那条会话上（`agentPresets/select`）。
   *
   * 失败一律如实报出来（服务端对已开始的会话回 `agent-preset/locked`，对不存在的
   * id 回 `agent-preset/not-found`，两者都带 `details.reason`）：这是用户刚刚做的
   * 一次明确选择，静默回退会让标签莫名其妙地弹回原值（官方也因此把拒绝做成横幅）。
   */
  private async selectAgentPreset(viewId: string, id: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!scope) {
      // 连壳都还没有（没有工作目录，见 `viewAgentPreset` 的字段注释）：记成「落壳时
      // 要用的预设」，不建记录、也不发 RPC——建壳时随 `session/create` 一起指定
      // （见 `reuseOrCreateBlank`）。
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
      // 归属取**发起那一刻**那个会话（`scope` 就是发起时的域，切走也不会画到新会话）
      this.notify({
        sessionId: scope.sessionId,
        level: "warn",
        kind: "agentPresetFailed",
        text: `@agentPresetFailed:${reason}`,
      });
    }
  }

  private async onConnected(): Promise<void> {
    // socket 重建后长活流都要重开：每个打开的域重新跟随（适配器整个重建，
    // 新快照会重放最近 60 条），全局流重开一次
    // 重开是全新的开始：失败计数与还没触发的旧重开一并作废（跨重连的旧 timer 不许再开流）
    for (const sessionId of [...this.followRetryTimers.keys(), ...this.followRetries.keys()]) {
      this.closeFollowRetry(sessionId);
    }
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
    // 自动化任务同理，而且更必要：`schedule/changed` 是**广播**，掉线期间的那几次
    // 广播没有任何重放机制——不重拉就会一直显示掉线前的任务集（官方客户端同样在
    // 连接重置后刷新目录）。判据是「有没有人在等」（`schedulesWanted`），不是「上次
    // 读到了没有」：断开时打开面板的域状态会是 `error`，但它同样需要补这一次读取。
    for (const scope of this.scopes.values()) {
      if (scope.schedulesWanted) void this.loadSchedules(scope, true);
    }
    this.openControlStream();
    this.openEventsStream();
    this.openWorkspaceStream();
    // 预设目录与工作目录提示都是空态页要用的东西，连上就取一次（目录是部署级的，
    // 与具体会话无关；工作目录直接现读 VS Code，不发请求）；权限目录同理——它决定
    // 权限列表里列不列 Auto review 那一档。
    void this.loadAgentPresets();
    void this.loadPermissionCatalog();
    this.refreshWorkspace();
    // 顺便把 running 与会话列表对齐一次：掉线期间本轮可能已经收尾，而那段时间的状态位
    // 边缘（`api-session/status`）我们没收到；这也是「一切都从服务端重算」的一部分
    // （新的适配器认不出时会保留这里的结论，见 `applyFrame`）。
    await this.refreshSessions();
    // 列表到手之后才补空壳：`reusableBlank` 扫的就是这份列表，先补会看不到已经存在的
    // 那条（见 `reuseOrCreateBlank`）。顺序与 `refreshWorkspace` 的调用位置无关紧要，
    // 但必须在这次拉取**之后**。
    //
    // 补壳之前先唤醒**还留着的恢复**：`ready`（或认领落下）早于激活期那次自动连接时，
    // hint 就留在 `restoreHints` 里等这一刻（见 `resumeRestoreHint`）。每一条唤醒都会**同步**
    // 落进 `restoreInFlight`，所以下面那趟补壳照样给它们让位（`hasRestorePending`）。
    for (const viewId of [...this.restoreHints.keys()]) {
      if (this.readyViews.has(viewId)) void this.resumeRestoreHint(viewId);
    }
    await this.adoptBlankForUnboundViews();
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
   * 探测结论（内部在不在跑、外部可不可达、桌面端在不在跑/可不可连）变了就推给界面。
   *
   * 按钮态的按钮集与那半句状态文案都靠它：内部在跑 → 「连接内部 DSH」，不在 → 「启动内部 DSH」；
   * 桌面端那一轴决定多出来的那颗按钮是「启动」还是「连接 DSH 桌面端」。
   * **只在这里整份换掉 `facts`**（外部轴的 `unconfigured` 判定也由它出，见 `externalStateOf`）。
   */
  private setFacts(facts: TargetFacts): void {
    const changed =
      this.facts.internalRunning !== facts.internalRunning ||
      this.facts.internalConfigured !== facts.internalConfigured ||
      this.facts.externalConfigured !== facts.externalConfigured ||
      this.facts.externalReachable !== facts.externalReachable ||
      this.facts.desktopConfigured !== facts.desktopConfigured ||
      this.facts.desktopRunning !== facts.desktopRunning ||
      this.facts.desktopAttachable !== facts.desktopAttachable;
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
   * 只对**内部**目标有意义：外部那台服务器与桌面端内置的那套都不归本扩展管，界面
   * （`internalRunning` 为假时不显示这枚按钮）与命令面板两道都拦在这里。
   */
  async restart(): Promise<void> {
    if (this.target?.kind === "external" || this.target?.kind === "desktop") {
      this.log(`[server] 当前目标是${this.target.kind === "desktop" ? "DSH 桌面端" : "外部 DSH"}，「重启内部 DSH」不适用`);
      return;
    }
    // 内部那一轴不存在时同样不适用：命令面板那一条也要拦在这里，否则会拿一条空命令去"重启"
    // （用户 2026-10-19 口径）。
    if (!this.internalAxisExists("重启内部 DSH")) return;
    this.target = { kind: "internal", mayStart: true };
    this.userChoseConnection = true;
    this.attempts.reopen();
    this.connectPhase = "connecting";
    // 接入的是**别的窗口**拉起的后台时，「重启内部 DSH」会打断所有窗口（supervisor 杀 dsh
    // 再拉起一个，端口通常会变）——那是一次对所有人的中断，必须说出来，不能静默
    const wasPeer = this.server.snapshot().status.info?.ownership === "peer";
    this.log(wasPeer ? "[server] 重启（后台由别的窗口拉起，会打断所有窗口）" : "[server] 重启");
    // 这一次要的是「只收连接」：不作废轮次、不中止等待（`server.restart` 自己会叫醒等待），
    // 也不交还占用——重启完还要接上同一套后台
    this.attempts.detach();
    try {
      // 显式传目标：manager 记的上一次目标可能是外部（用户正连着备用），不传的话
      // 「重启」会在那一侧变成静默空转（见 `SupervisorManager.restart`）
      await this.server.restart({ target: "internal" });
    } catch (error) {
      // 用户在"等新地址"期间按了「停止连接」/「停止服务器」：这是一条用户指令，不是重启失败
      if (error instanceof WaitCancelledError) {
        this.log("[server] 重启被用户中止（「停止连接」/「停止服务器」）");
        this.attempts.markRetry(false);
        this.setConnection("stopped");
        return;
      }
      throw error;
    }
    // 「重启内部 DSH」是用户显式动作：允许拉起一套（关掉自动连接时也算数）
    await this.ensureConnected({ start: true, target: "internal" });
    if (wasPeer) {
      // 共享后台的重启：本窗口接管了重起这件事，而**别的窗口**看不到这个动作
      // （它们没有发起，界面也不会变）——这是绿色「重要变化」，共享归属（用户 2026-10-18 口径）。
      // 发起端（非 peer）走下面那条原生回执，两者互斥，不做统一。
      this.notify({ level: "info", kind: "sharedRestarted", text: "@sharedRestarted" });
      return;
    }
    vscode.window.showInformationMessage(vscode.l10n.t("The DSH server has been restarted."));
  }

  /** 服务器状态变化时同步给界面。 */
  onServerStatus(status: ServerStatus): void {
    // **当前目标不是内部时，管理器的内部那套状态一律不影响界面**（2026-09-19 建立，
    // 2026-10-18 扩到桌面端）：我们连的不是它。内部那套可能仍在跑（别的窗口在用），
    // 但它的换地址 / 退场与本窗口这条连接无关——从前这里会把界面从"连着外部"拉回按钮态
    // 或错误态，看起来就像"切到外部之后还在跟内部守护进程打交道"。内部那一轴（按钮文案用）
    // 由 5 秒心跳的探测结论刷新，不靠这条推送（`detachInternal` 之后管理器还会报一次
    // stopped，那只是"我断开了"，不是"内部后台不在了"）。
    if (this.target?.kind === "external" || this.target?.kind === "desktop") return;
    if (status.state === "failed" && status.detail) {
      // 启动类失败（spawn 不起来、等不出可用状态）：**不自动重试**，退回按钮态 + 原因
      this.attempts.markRetry(false);
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
    // 「停止服务器」/ 守护进程自己退场：内部那套没了 → 左轴立刻变"未运行"。
    // 接着分两条路：**它亲口告的别**（stop / idle：连 dsh 一起收场了）是已知终结，收掉连接与
    // 重连意图、回按钮态等用户动作；其余（`gone` / `replaced`，以及没带 cause 的旧来时路）
    // 只是一般失联——按原目标接着接（`start: false`，绝不自行拉起），所以这里**不动重试意图**。
    if (status.state === "stopped") {
      this.setInternalRunning(false);
      if (status.cause === "stop" || status.cause === "idle") {
        this.finalizeTerminalStop(status.detail);
        return;
      }
      if (!this.attempts.retryable) this.setConnection("stopped");
    }
  }

  /**
   * 后台这一套**已知终结**（守护进程亲口告别 stop / idle）：收掉连接与重连意图，回按钮态。
   *
   * 与"一般失联"的分界在调用方，不在探测：只有结构化的终结信号（`ServerStatus.cause`）才走
   * 这一档。曾经这里靠一次 `probeRunning` 探测下结论，而**退场途中那一次探测仍可能读到将消失
   * 的会合状态**（`supervisorAlive` 还是 true），那一趟就不敢收；此后管理器不会再报一次
   * stopped（状态已经是 stopped），旧客户端自己的 WS 退避重连于是把连接条永远按在"连接中"。
   * 现在终结信号是确定的，不用猜。
   *
   * 收尾走账本自己的 `stopByUser()`：关掉自动重连与重试意图、作废在途的那一轮（连跟随流一起
   * 收）、把客户端幂等 dispose（`markStopped` 落到按钮态）。旧客户端的迟到回调因为轮次判据
   * 写不进状态，界面停住等用户动作。
   */
  private finalizeTerminalStop(detail?: string): void {
    if (this.client || this.attempts.retryable || this.attempts.autoReconnect) {
      this.log(`[connect] 后台已终结（${detail ?? "supervisor goodbye"}）：收掉连接与重连意图，界面给按钮`);
    }
    this.attempts.stopByUser();
  }

  // ---------- 启动 / 连接（用户可控，2026-09-18 重写） ----------

  /**
   * 激活期的自动连接（`startup()` 调用）：**一个扩展宿主生命周期只做一次**。
   *
   * 闸与在飞结果都落在 `activationConnect` 上：重复调用（激活期清文档锁的 `finally` 迟到、
   * 或别处误叫）一律忽略并返回同一条链——不会再重新选路，更不会拉起第二套后台。
   *
   * `dshChat.autoConnect` 开着：**选一次路**——内部后台在跑就接内部；否则外部地址配了
   * 且此刻可达就连外部；两者都没有就拉起一套内部。选完**粘住**（见 `target` 字段），
   * 之后所有自动路径只认这一个目标、且只许接上、不许再拉起（见 `handleHeartbeat`）。
   *
   * 关着：**完全不自动连**——只刷新两轴探测结论，把界面切到按钮态等用户点
   * （用户 2026-09-18 口径：这是 `autoStart` 改名 `autoConnect` 后的新含义）。
   */
  async autoConnect(autoConnect: boolean): Promise<void> {
    if (this.activationConnect) {
      this.log("[connect] 自动连接只在扩展启动时做一次，这次调用忽略");
      return this.activationConnect;
    }
    // 先落下"已经发起过"这件事，再让它自己跑：`startup()` 在异步地清完文档锁之后才调到这里，
    // 而用户可能已经抢先自己点了连接——那个窗口里的自动选路必须让位（见下面的让位判据）。
    //
    // 这条链**不把异常抛给调用方**（`startup()` 那边是 fire-and-forget 的 `void`）：记一笔就
    // 结束，界面停在按钮态等用户动作。也让"在飞的那一次"永远是一条约得上的正常链。
    this.activationConnect = this.chooseAtActivation(autoConnect).catch((error) => {
      this.log(`[connect] 激活期的自动连接没有走完：${this.describeError(error)}`);
    });
    return this.activationConnect;
  }

  /**
   * 激活期自动选路的本体（唯一调用方是 `autoConnect()`，闸在那里）。
   *
   * **两道让位判据**：用户在激活期里自己动过连接
   * （`userChoseConnection`，任何带 `start: true` 的显式动作都会记上）或已经选定了目标
   * （`target`）时，迟到的自动选路**一个字都不改**——连 `retarget()` 都不做，那会把用户
   * 刚发起的那一轮作废掉。判据在 `probeFacts()` 前后各查一次：外部可达性那一步要发一次
   * HTTP，探测期间用户完全可能点下去。
   */
  private async chooseAtActivation(autoConnect: boolean): Promise<void> {
    if (!this.activationConnectStillWanted()) {
      this.log("[connect] 用户已经自己动过连接，激活期的自动选路让位");
      return;
    }
    this.attempts.reopen();
    // 激活期的这一轮同样先作废可能还在飞的那一轮：只此一次，旧轮的结果不许再写状态
    this.attempts.retarget();
    const facts = await this.probeFacts();
    if (!this.activationConnectStillWanted()) {
      this.log("[connect] 探测期间用户已经自己动过连接，激活期的自动选路让位");
      return;
    }
    this.setFacts(facts);
    if (!autoConnect) {
      this.target = undefined;
      this.attempts.markRetry(false);
      this.log(`[connect] 已关闭自动连接（${describeFacts(facts)}）：只显示按钮，等用户点`);
      this.setConnection("stopped");
      return;
    }
    const plan = chooseTarget(facts);
    // 没有任何可选项（内部那一轴不存在——没配 `dshChat.command`——又没有可用的桌面端）：
    // **不选路、不启动任何东西**，落按钮态等用户配。这里绝不能兜底成"启动内部"：那会拿
    // 一条空命令去 spawn（用户 2026-10-19 口径；空命令启动出来的进程谁也认不出是谁的）。
    if (!plan) {
      this.target = undefined;
      this.attempts.markRetry(false);
      this.log(
        `[connect] 没有可选的目标（${describeFacts(facts)}）：` +
          "内部 DSH 需要配置 dshChat.command，或配置 dshChat.desktopExecutable 用桌面端",
      );
      this.setConnection("stopped");
      return;
    }
    this.target = { kind: plan.target, mayStart: plan.start };
    this.connectPhase = plan.start ? "starting" : "connecting";
    this.log(
      `[connect] 自动选路（${describeFacts(facts)}）→ ${plan.target}` +
        `${plan.start ? (plan.target === "desktop" ? "（先拉起 DSH 桌面端）" : "（先拉起一套内部后台）") : ""}；此后只接上、不再自动拉起`,
    );
    await this.ensureConnected({ start: plan.start, target: plan.target });
  }

  /**
   * 激活期这次自动选路还该不该做：用户动过连接、或已经定过目标 → 不做了。
   *
   * 判据只认这两样，**刻意不看连接状态**：连接条被别的路径改掉（后台终结回按钮态、掉线转
   * 「正在连接…」）都是既成事实，不代表"用户动过"，不该让激活期的选路因此放弃
   * （探测结论本来就是它要用的）。
   */
  private activationConnectStillWanted(): boolean {
    return !this.userChoseConnection && !this.target;
  }

  /**
   * 自动路径**只消费激活期那一次自动连接**：那一次还在飞就等它结算，已经落地就照现状用。
   *
   * 三档判据，顺序不能换：
   *  1. 已经连着 → 立刻返回。这一档同时挡住**自等**：`onConnected` 的尾巴会回到自动补壳
   *     （`adoptBlankForUnboundViews`），而那一刻激活期这条链还在飞，等它就是把链接到自己身上。
   *  2. 激活期那一次**还没发起**（`startup()` 要先异步清完文档锁，而聊天页面（webview）的
   *     `ready` / 恢复 hint 可能更早）→ 如实返回，**什么都不做也不消费**。调用方据此决定
   *     "这一趟先不做"（恢复 hint 就是这么留着的，见 `resumeRestoreHint`），而不是当成一次
   *     失败的连接。
   *  3. 在飞 → 等它结算（失败也是结算：这一趟不重来；"接着按原目标接"归心跳管，
   *     见 `handleHeartbeat`）。
   *
   * 这里**永远不自己发起连接**：那正是"聊天页面（webview）重载 / 心跳把用户刚停掉的后台
   * 又拉起来"的老路（真正的 VS Code「重载窗口」会重开扩展宿主，按"一个宿主激活一次"，
   * 那一次自动连接是**该做**的）。
   */
  private async awaitActivationConnect(): Promise<void> {
    if (this.client && this.connection === "connected") return;
    const pending = this.activationConnect;
    if (!pending) return;
    await pending;
  }

  /**
   * 配置监听（`dshChat.autoConnect` 改动）用。
   *
   * **改这个开关不触发任何自动连接**（自动连接只做一次），无论改开
   * 还是改关——它只更新自动路径的许可（`SupervisorManager` 那份，供 `ensure()` 的默认值），
   * 新值从**下一次窗口激活**开始生效。正在跑的连接一个字都不动：配置改动不该打断会话，
   * 也不该替用户收回他显式停过的连接。要现在就连，用连接条上的按钮。
   *
   * 之所以不再"改开就立刻自动连一次"：那正是"停掉后台之后又被自动拉起来"的另一条来路
   * ——用户改配置的动作与"我要起一套后台"不是一回事。
   */
  applyAutoConnect(value: boolean): void {
    this.server.setAutoConnect(value);
    this.log(
      `[connect] dshChat.autoConnect 改为${value ? "开" : "关"}：只改自动路径的许可，不触发连接`,
    );
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
    if (!this.internalAxisExists("启动内部 DSH")) return;
    this.beginConnect("internal", true, "starting");
    await this.ensureConnected({ start: true, target: "internal" });
  }

  /** 「连接内部 DSH」：有就接上、没有就起一套——与「启动内部 DSH」同一套逻辑（见上）。 */
  async connectInternal(): Promise<void> {
    if (!this.internalAxisExists("连接内部 DSH")) return;
    this.beginConnect("internal", true, "connecting");
    await this.ensureConnected({ start: true, target: "internal" });
  }

  /**
   * 内部那一轴存在吗（配了 `dshChat.command`）？
   *
   * 不存在时记一条日志、把界面留在按钮态并返回 `false`——与 `connectExternal()` 的"没配地址"
   * 那一支同一口径：**不发起连接，更不拿空命令去 spawn**（用户 2026-10-19 口径：命令留空
   * 就等于没有内部 DSH，与 `desktopExecutable` 留空时整条支路关闭同一副样子）。
   */
  private internalAxisExists(action: string): boolean {
    if (this.server.commandConfigured) return true;
    this.log(`[connect] 没有配置 dshChat.command（内部那一轴已关闭），「${action}」无从做起`);
    this.attempts.markRetry(false);
    this.setConnection("stopped");
    return false;
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
      this.attempts.markRetry(false);
      this.setConnection("stopped");
      return;
    }
    this.beginConnect("external", false, "connecting");
    await this.ensureConnected({ start: false, target: "external" });
  }

  /**
   * 「启动 DSH 桌面端」：**用户显式要那套内置服务可用**（桌面端不在时按钮态里的主动作）。
   *
   * 与「连接 DSH 桌面端」是**同一套逻辑**（都传 `mayStart: true`）：桌面端不在就把它拉起来，
   * 在就接上它。保留两个按钮与内部那两颗同一个理由——按钮的措辞来自"认人"那一次探测，
   * 与真实状态之间会有偏差（可能刚启动、也可能刚退出），语义相同才不会"点对了按钮却什么都
   * 没发生"。**扩展不关停桌面端**：它的进程生死归它自己（见 `docs/design-desktop.md`）。
   */
  async startDesktop(): Promise<void> {
    if (!this.server.desktopConfigured) {
      this.log("[connect] 没有配置 dshChat.desktopExecutable，「启动 DSH 桌面端」无从拉起");
      this.attempts.markRetry(false);
      this.setConnection("stopped");
      return;
    }
    this.beginConnect("desktop", true, "starting");
    await this.ensureConnected({ start: true, target: "desktop" });
  }

  /** 「连接 DSH 桌面端」：有就接上、没有就拉起一个——与「启动 DSH 桌面端」同一套逻辑（见上）。 */
  async connectDesktop(): Promise<void> {
    if (!this.server.desktopConfigured) {
      this.log("[connect] 没有配置 dshChat.desktopExecutable，「连接 DSH 桌面端」无从连起");
      this.attempts.markRetry(false);
      this.setConnection("stopped");
      return;
    }
    this.beginConnect("desktop", true, "connecting");
    await this.ensureConnected({ start: true, target: "desktop" });
  }

  /** 所有连接入口共用的开场：换粘性目标、重新打开自动重连、进入"连接中"。 */
  private beginConnect(kind: DshTarget, mayStart: boolean, phase: ConnectPhase): void {
    this.attempts.reopen();
    this.target = { kind, mayStart };
    this.connectPhase = phase;
    // 换目标 = 上一条连接不再作数：**先收掉它**（含客户端自己的无限重连），
    // 否则旧客户端的回调会把界面拉回"连接中"（见 `ConnectionAttempts.retarget`）
    this.attempts.retarget();
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
   * 用户叫停**不挡住显式动作**：`ConnectionRound.userStopped()` 对"用户自己发起的那一轮"
   * 放行（发消息 /「启动内部 DSH」/「重启内部 DSH」），只有自动路径才该在叫停后放弃。
   */
  stopReconnect(): void {
    // 用户按下「停止连接」就是一次**显式表态**：即便下面这一档因为"没在连接中"而早退，
    // 也必须挡住激活期那次迟到的自动选路（见 `activationConnectStillWanted`）——否则
    // 探测回来仍会按 `start:true` 把用户刚叫停的后台拉起来。
    this.userChoseConnection = true;
    if (this.connection !== "connecting" && this.connection !== "disconnected") return;
    this.log("[connect] 用户点了「停止连接」");
    // **真的停下来**：关闸 + 作废在途轮 + 中止管理器的等待 + 收跟随流 + dispose 客户端
    // （连带停掉它自己的无限重连）+ 交还内部后台的占用，全部按定死的顺序在模块里做。
    // 只改两个布尔量是不够的——`DshClient` 断线后会自动重连，它的回调会把界面反复拉回
    // "连接中"，用户看到的就是"点了停止还在连"（2026-09-19 实测）。
    // 交还那一档（`release`）做两件事：置 `detachedByUser` 闸 + 收连接，缺任何一件都等于
    // 没做（只断不挡 → 5 秒后被接回；只挡不断 → 内部 dsh 永不按空闲退场）。
    this.attempts.stopByUser();
    // 切回按钮态由模块收口（`markStopped`）。**顺带重探一次两轴**：刚交还之后"内部还在
    // 不在"的结论已经变了（它可能马上就空闲退场），不能等 5 秒心跳
    void this.refreshFacts();
  }

  /**
   * 「停止内部 DSH」（命令面板 `dshChat.stopServer`）：请守护进程连 dsh 一起收场并退出。
   *
   * 顺带**收掉本窗口与内部那套的连接**：只发停止请求、不收连接的话，客户端会在 dsh
   * 消失后一直重连、界面反复跳回"连接中"。后台的生死照旧归守护进程，这里只收自己的连接。
   *
   * **当前目标是外部时例外**（2026-09-19）：这条命令停的是**内部**那套，与外部服务器
   * 无关——本窗口连着外部的那条连接（客户端 + 跟随流）一个字都不动，界面也不该被拉回
   * 按钮态。这一档的判据与动作全在 `ConnectionAttempts.stopInternal(target)` 里
   * （管理器会临时接入内部守护进程把请求发出去，见 `stopDetachedInternal`）。
   *
   * 返回"停止请求有没有真的发出去"：调用方据此给用户哪句回执（只有 `askSupervisor`
   * 那一档会发控制帧）。
   *
   * **本窗口没有内部那一轴时（`dshChat.command` 留空）直接忽略、返回 `false`**（用户
   * 2026-10-19 口径）：不同的内部 DSH 是按各自的命令行辨认的，别的窗口跑着的那套不是本窗口
   * 的，也没有"本窗口的内部 DSH"可停——不去替别人收场，也不走"临时接入去停别的窗口的后台"
   * 那条路（空命令的窗口连会合分组都与别人不同，本来也接不上）。回执由命令面板按这个
   * `false` 给，并**不许**说成"内部 DSH 没有在运行"（那是另一回事，见 `extension.ts`）。
   */
  async stopServer(): Promise<boolean> {
    // 同上：这是一次显式表态。`stopInternal` 只管作废在途轮与关自动重连，管不住**还没发起**
    // 的激活期自动选路——那一次回来照样会按 `start:true` 拉起一套用户刚停掉的后台。
    this.userChoseConnection = true;
    if (!this.server.commandConfigured) {
      this.log("[server] 没有配置 dshChat.command（内部那一轴已关闭），「停止内部 DSH」忽略");
      return false;
    }
    return this.attempts.stopInternal(this.target?.kind);
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
   * 历史会话列表的**全局那一份**（`this.sessions`）＝ 本窗口可能看见的所有会话。
   *
   * 用户 2026-09-15 的设计口径：
   *
   * 1. **打开了文件夹** → 跟随 VS Code，只显示**这个工作区**的会话（dsh web 可能
   *    为多个项目开过会话，跨项目混进来既占列表、又因 cwd 不匹配导致 resume 失败）；
   * 2. **没有打开文件夹** → **这一层不收窄**：保留**完整候选**，只挡没有 cwd 的行。
   *    按窗口 / 目录收窄留到发帧那一步（`emitSessionLists`）——每个窗口可以各自选一个
   *    目录（用户 2026-10-10 口径），窗口还停在空态时才只列**未分组**的会话（用户
   *    2026-10-17 口径，见 `visibleForView`）。上游先按「未分组」或「已打开域」滤一遍
   *    会把下游真正要用的行提前丢掉：用户刚选一个目录（那个目录还没有任何已打开域）时，
   *    该目录里**已分组**的会话就再也找不回来。
   *
   * 打开了文件夹时，判据按**服务端注册表**（`workspaces` 的 `sessionIds`）而不是自己
   * 比较 cwd：
   * `session/list` 不带 workspaceId，而分组本身就是注册表说了算（会话被
   * `session/create` 带 `workspaceId` 建出来时才记进某个工作区）。两条兜底：
   *
   * - 会话 cwd == 当前工作区路径：新会话的 `upsert` 增量可能比这次查询晚到，
   *   只看注册表会让「刚建好的会话」从列表里闪一下；
   * - **任何已打开域**的 cwd：工作区目录与历史会话目录的写法（大小写/分隔符）
   *   可能不一致，恢复窗口时不能因为这点差异把要接回的会话滤掉。这条 cwd 取自
   *   **本次取回的权威列表**（而不是上一份 `this.sessions`）：刚打开的会话可能
   *   还没进过上一份快照，用旧数据会把它的 cwd 漏掉。
   *
   * **这一份刻意是「全局候选」而不是任何一个窗口该看见的列表**：打开会话（`reusableBlank`
   * 扫空壳）、空壳判据（`isBlankShell`）、running 打底（`ensureScope`）、`blankSessionIds`
   * 都读它，收窄了就会丢数据。真正发给界面的列表在 `emitSessionLists` 里按窗口收窄
   * （没有打开文件夹时，窗口有目录就只看那条 cwd 下的会话，停空态则只看未分组，
   * 见 `visibleForView`）。
   */
  async refreshSessions(): Promise<void> {
    if (!this.client) return;
    try {
      const { value, applied, generation, requestSeq, activityChanges } =
        await this.listSessionsForSubagentOrder(this.client);
      // 回到调用者续体时**重新验证**：helper 返回与这里恢复之间可能发生连接收线或
      // 另一份更新的完整列表被采纳，此刻的布尔快照已经过期。旧快照整份丢弃，不再
      // 往下写会话列表、cwd / 预设 / 标题 / running 账本。
      if (!applied || generation !== this.subagentOrderGeneration || requestSeq !== this.subagentListAppliedSeq) {
        return;
      }
      // **权威 cwd 账本**：从**原始行**整份重建（任何可见性过滤之前）。子代理会话被
      // `visibleSessionRows` 全局藏掉、不进 `this.sessions`，但它的 cwd 是权威事实——
      // 窗口切进子代理页时「当前会话的 cwd」还要靠它（见 `sessionCwds` 与 `viewCwd`）。
      const cwds = new Map<string, string>();
      for (const item of value.items ?? []) {
        if (typeof item.cwd === "string" && item.cwd) cwds.set(item.sessionId, item.cwd);
      }
      this.sessionCwds = cwds;
      // **权威预设账本**：与 cwd 同一份原始行（`agentPreset` 投影的 wire 值），同样整份
      // 重建。只收非空字符串：能力缺失（部署没装预设注册表）时那个键根本不在，别记一个
      // 空串进账，否则认领时会递一个 `agentPreset: ""` 出去（见 `sessionPresets`）。
      const presets = new Map<string, string>();
      for (const item of value.items ?? []) {
        const value = item.projections?.values?.agentPreset;
        if (typeof value === "string" && value) presets.set(item.sessionId, value);
      }
      this.sessionPresets = presets;
      // 子代理显示名的**标题账本**：同一份原始行顺带收下（workflow 派发的子代理没有
      // 描述符 label，目录里只拿得到会话 id，见 `subagentTitles`）。变化在列表整份
      // 装好之后再推（`sweepSubagentTitles` 要读新的会话列表算父会话标题）。
      const titleChanges = this.collectSubagentTitles(value.items ?? []);
      // 血缘索引已由 `listSessionsForSubagentOrder` 用同一份原始行重建（含完整列表缺席的
      // 权威裁剪与在途候选保护）；这里不再重复并入，避免旧回调绕过裁剪。
      // 判定时间账本（用户消息那一半）与标题同一份原始行：会话列表就是它的权威来路，
      // 变化在列表整份装好之后再推（那时父会话标题也才是新的）
      // @ 提及候选过滤的打底（判据与用途见 `subagentSessionIds` 与 sessionList.ts）
      for (const item of value.items ?? []) {
        if (item.origin === "subagent") {
          this.subagentSessionIds.add(item.sessionId);
          // 子代理会话不在界面列表里，但它的 running 服务端照样给：
          // 恢复到子代理页时域要拿它打底（见 ensureScope 的 running 打底注释），
          // 目录行登记时也要靠它回填 activity（见 decorateSubagent）
          if (typeof item.running === "boolean") {
            this.subagentRunning.set(item.sessionId, item.running);
          }
        } else {
          // 状态账本的**清理路径**：这张表还收 `api-session/status` 中继那条路
          // （它不区分是不是子代理），而普通会话的状态这里用不着——列表这一份是权威的
          // 完整视图，凡是被它认成普通会话的 id 就从账本上退掉，别只增不删。
          this.subagentRunning.delete(item.sessionId);
        }
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      const workspacePath = folder ? normalizePath(folder.uri.fsPath) : undefined;
      // 服务端注册表：这条会话被记在哪个工作区里（同一会话只属于一个工作区）
      let ownIds: Set<string> | undefined;
      for (const row of this.workspaces) {
        if (workspacePath !== undefined && normalizePath(row.path) === workspacePath) {
          ownIds = new Set(row.sessionIds);
        }
      }
      // 基准放宽到**任何打开的域**的 cwd（见 `visibleForWorkspace` 的注释）。cwd 从
      // **这次刚取回的权威列表**里读（`sessionCwds`，任何可见性过滤之前建的账本），
      // 而不是上一份 `this.sessions`：刚建好 / 刚打开的会话可能还没进过上一份列表，
      // 用旧快照会把它自己的 cwd 漏掉——那份列表里没有它，按窗口收窄那一步也就读不到
      // 它的 cwd（见 `visibleForView`）。
      const openCwds: string[] = [];
      for (const scope of this.scopes.values()) {
        const cwd = normalizePath(this.sessionCwds.get(scope.sessionId));
        if (cwd) openCwds.push(cwd);
      }
      const raw = visibleForWorkspace(
        visibleSessionRows(value.items ?? [])
          // 本地删过的会话若被当前 dsh 进程打开过，仍会留在服务端内存里被
          // session/list 列出——按持久化的删除集合过滤，保证界面干净
          .filter((item) => !this.deletedSessionIds.has(item.sessionId)),
        { workspacePath, workspaceSessionIds: ownIds, openCwds },
      ).map((item) => this.toSessionView(item));
      // 本地 blank 位（`engagedSessions`）在这里**收敛**（见它的字段注释）：服务端自己
      // 已经把这条翻成不空、或它已经不在列表里，本地这一位就没有留下的理由——它只负责
      // 顶住两次拉取之间的空档。判据用**服务端那一行**，不是折过之后的行。
      for (const id of [...this.engagedSessions]) {
        const row = raw.find((item) => item.id === id);
        if (!row || row.blank !== true) this.engagedSessions.delete(id);
      }
      // 官方的 `effectiveBlank`：列表行说它空、本地这一位说它不空 → **不空**。少了这一步，
      // 刚发出第一条消息的会话会随下一次拉取（服务端的 `blank` 还没随 `turn/start` 翻假）
      // 从历史列表里消失一下再回来。
      const views = raw.map((item) =>
        item.blank === true && this.engagedSessions.has(item.id) ? { ...item, blank: false } : item,
      );
      // **空壳登记的清理路径**：服务端**明确说它已经不是空壳**（有人说过话）时，占用与
      // 预留都没有留下的理由。判据按肯定证据写——**列表里找不到那一行时一律保留**：
      // 列表是拉的，刚建好的壳与正在飞的预留可能还没出现（`blankReservations`），
      // 按「不在列表里就清」会把它们误杀，那条壳接着就能被别的窗口抢走。
      // 只增不减不是问题：条目由绑定 / 预留自己收（两张表都按会话建、条数与窗口同阶）。
      for (const id of [...this.blankOccupants.keys(), ...this.blankReservations.keys()]) {
        const row = views.find((item) => item.id === id);
        if (row === undefined || row.blank === true) continue;
        this.blankOccupants.delete(id);
        this.blankReservations.delete(id);
      }
      // 发霉的占位条目（记着的窗口已经不绑它了）在这里收敛：这张表的判据是「他还在看」，
      // 清掉它不影响任何**有效**占用（`blankHolder` 本来就不认它）
      for (const [id, occupant] of [...this.blankOccupants]) {
        if (this.viewSessions.get(occupant) !== id) this.blankOccupants.delete(id);
      }
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
      this.emitSessionLists();
      // running 的**权威打底**：列表是服务端算的（`SessionSummary.running`），域存在时
      // 按它对齐——官方 `ui-session` 的 `reconcileStatus()` 是同一口径。适配器那一路只从
      // durable 轮次边界推导，窗口被截断 + 工具阶段时它**不发帧**（见适配器的注释），
      // 那个缺口就由这里与 `api-session/status` 中继补上。
      for (const scope of [...this.scopes.values()]) {
        const row = views.find((item) => item.id === scope.sessionId);
        if (!row) continue;
        if (!acceptSessionStatus(row.running, scope.adapter?.hasOpenTurn() === true)) continue;
        // 列表比中继那条更晚、也是权威：它一旦被采纳，先前拒收的那条就没有留下的理由了
        this.pendingStatuses.delete(scope.sessionId);
        // 会话列表也是权威来源：记版本 + 值（见 `authorityRunning`）
        this.noteAuthorityRunning(scope, row.running);
        this.writeScopeRunning(scope, row.running);
      }
      // 会话列表是**标题的权威**（服务端 `session/list`）：恢复窗口时面板先绑上会话、
      // 这一份才到，标签要在这里补一次；删掉的会话也从标签上退掉
      for (const sessionId of new Set(this.viewSessions.values())) this.syncPanelTitle(sessionId);
      // 标题账本变了 → 重推受影响的那几条子代理目录（放在列表装好之后：重推的上下文里
      // 带父会话标题，见 `sweepSubagentTitles`）
      this.sweepSubagentTitles(titleChanges, "会话列表");
      // 顺序变了也要重推：目录内容没变但先后变了的话，界面会停在旧顺序上
      this.redeliverSubagentRows(activityChanges);
      // 血缘索引来自同一份列表：已绑定的窗口（含子代理页）都可能是第一次拿到完整的树
      this.redeliverSubagentTrees();
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
    if (!acceptSessionStatus(status.running, scope?.adapter?.hasOpenTurn() === true)) {
      // 拒收 ≠ 忘记：这条权威结论先记下，等本地「本轮还开着」的证据消失时再重判
      // （见 `pendingStatuses`）。直接丢掉的话，随后 durable 收尾只会改域、不会改会话
      // 列表那一行——假 true 活到下一次列表刷新，离开时就记出假未读。
      this.pendingStatuses.set(status.sessionId, status.running);
      return true;
    }
    this.pendingStatuses.delete(status.sessionId);
    // 列表那一行是**新域的打底值**（见 `ensureScope`），必须与域同一个口径：列表里的
    // 「运行中」标记也靠它，不然用户切走再切回来会拿到一个过期的值。
    this.setSessionRowRunning(status.sessionId, status.running);
    if (scope) {
      // 权威结论到了（中继被采纳）：记版本 + 值（不可省略——见 `authorityRunning`）
      this.noteAuthorityRunning(scope, status.running);
      this.writeScopeRunning(scope, status.running);
    }
    return true;
  }

  /**
   * 把一条**被拒收**的权威状态位重新过一遍采纳策略（见 `pendingStatuses`）。
   *
   * 调用点只有一个：域被回收时（适配器随之消失 = 本地「本轮还开着」的证据没了）。重判通过
   * 就按它纠正会话列表那一行——**必须赶在离开标记之前**，那条纠正本身不该结算出未读
   * （`dropViewers` 在三个离开入口里都排在 `noteSessionLeft` 前面）。
   */
  private settlePendingStatus(sessionId: string): void {
    const pending = this.pendingStatuses.get(sessionId);
    if (pending === undefined) return;
    const scope = this.scopes.get(sessionId);
    if (!acceptSessionStatus(pending, scope?.adapter?.hasOpenTurn() === true)) return;
    this.pendingStatuses.delete(sessionId);
    this.setSessionRowRunning(sessionId, pending);
    if (scope) this.writeScopeRunning(scope, pending);
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

  /**
   * 记下一条**权威** running 结论（见 `authorityRunning`）。
   *
   * 由三个权威来源调用：`api-session/status` 中继被采纳时、会话列表整份刷新被采纳时、
   * 适配器给出的 durable 轮次边界。**值没有变化也要记**：权威在等待期间再次确认「在跑」，
   * 本身就是一条新证据，不能因为与乐观写入的布尔值相同而被忽略。
   */
  private noteAuthorityRunning(scope: SessionScope, running: boolean): void {
    this.authoritySeq += 1;
    this.authorityRunning.set(scope, { version: this.authoritySeq, running });
  }

  /** 域上权威 running 的当前版本号（一次都没收到过权威结论时为 0）。 */
  private authorityVersion(scope: SessionScope): number {
    return this.authorityRunning.get(scope)?.version ?? 0;
  }

  /**
   * 一条会话「在不在跑」的落地：会话列表那一行的 running + **未读结算**。
   *
   * 不在本窗口可见列表里的会话（**子代理会话**、别的工作区的会话）没有行可写，但未读
   * 结算必须照做——子代理目录行上的「已完成 ↔ 已读」全靠这一条：它既不在
   * `visibleSessionRows` 里（`sessionList.ts` 把 `origin === 'subagent'` 滤掉），也不在
   * `emitSessionLists` 里，从前被这一行的早退挡在门外，于是「离开正在生成的子代理、
   * 它收尾时记未读」永远不发生（用户 2026-10-10 报的「一次性行分不出已完成」）。
   */
  private setSessionRowRunning(sessionId: string, running: boolean): void {
    const row = this.sessions.find((item) => item.id === sessionId);
    if (!row) {
      // 行不在可见列表里：只做未读结算（`settleRunningChange` 自己按「离开标记 + 没有
      // 窗口看着它」判断，重复调用是幂等的）
      this.settleRunningChange(sessionId, running);
      return;
    }
    if (row.running === running) return;
    this.sessions = this.sessions.map((item) => (item.id === sessionId ? { ...item, running } : item));
    // 服务端说它在跑 ⇒ 这条会话一定不是空壳了（`blank` 位在 `turn/start` 翻假，但那条
    // 帧要比这里的判断晚一整轮）。这条证据比「本窗口发过消息」宽：别的窗口 / dsh web 在
    // 一条扩展建出来的空壳里说话，只有这里看得见（见 `markSessionEngaged`）
    if (running) this.markSessionEngaged(sessionId);
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
    // 只写这一条自己的键：整份数组在多窗口下会互相覆写（见 `unreadStore.ts`）
    writeUnreadSession(this.state, sessionId, unread);
    this.emitSessionLists();
    // 子代理目录行上也有这一位（已完成 ↔ 可继续 / 一次性）：同一条权威值，两个界面
    this.syncSubagentUnread(sessionId, unread);
  }

  /**
   * 真正展示给界面的两个列表（`sessions` / `archivedSessions`）——**按窗口各发一份**。
   *
   * 发帧是唯一按窗口收窄的地方（`this.sessions` 是全局候选，见 `refreshSessions`）：
   *
   * - **打开了文件夹**：目录跟随 VS Code，所有窗口同一份 → 仍走**广播**（一条帧发给
   *   全部窗口，与旧口径逐字相同；也保证任何已挂上的窗口都收得到，不依赖窗口名册）；
   * - **没有打开文件夹**：每个窗口只看见**它当前那条会话 cwd**下的会话（用户
   *   2026-10-10 口径：不同会话可以各自选目录，历史必须跟着各自的目录隔离）；窗口还停在
   *   空态（没选目录）时只列**未分组**的会话（用户 2026-10-17 口径）——「未分组」的判据
   *   是**服务端注册表**里没有任何工作区记过它，而不是「别的窗口没打开过」；收件人取
   *   `liveViewIds()`（此刻活着的窗口名册，见那里）。
   */
  private emitSessionLists(): void {
    if (vscode.workspace.workspaceFolders?.[0]) {
      const { active, archived } = this.groupSessionLists(this.sessions);
      this.emitAll({ type: "sessions", sessions: active });
      this.emitAll({ type: "archivedSessions", sessions: archived });
      return;
    }
    // 「未分组」的判据：不在**任何**工作区注册记录里的会话（注册表是权威，见
    // `visibleForView`）。每次发帧现算——注册表随时可能随 `workspace/*` 帧变。
    const groupedSessionIds = new Set<string>();
    for (const row of this.workspaces) {
      for (const id of row.sessionIds) groupedSessionIds.add(id);
    }
    for (const viewId of this.liveViewIds()) {
      const { active, archived } = this.groupSessionLists(
        visibleForView(this.sessions, { folderOpen: false, cwd: this.viewCwd(viewId), groupedSessionIds }),
      );
      this.emitToView(viewId, { type: "sessions", sessions: active });
      this.emitToView(viewId, { type: "archivedSessions", sessions: archived });
    }
  }

  /**
   * 此刻**活着的窗口**名册（按窗口发帧时的收件人）。
   *
   * 三个来源取并集，每一个都是「这个 viewId 现在存在」的肯定证据，且都在 `unbindView`
   * 里一起清掉：`bindView` 登记的活动顺序表（`viewOrder`）、绑过会话的窗口
   * （`viewSessions`）、登记过种类的窗口（`viewKinds`）。真实链路上挂窗口时前两样都会
   * 走到（`ChatViewProvider.attach` 先 `bindView`，绑定会话时再写 `viewSessions`），
   * 并集只是把「只走了其中一条」的路径也覆盖住——**漏一个窗口，它的历史列表就收不到帧**。
   * 发往不存在窗口是空操作（`chatView.deliver` 查不到就不发），所以并集宁宽勿窄。
   */
  private liveViewIds(): string[] {
    const ids = new Set<string>(this.viewOrder);
    for (const viewId of this.viewSessions.keys()) ids.add(viewId);
    for (const viewId of this.viewKinds.keys()) ids.add(viewId);
    return [...ids];
  }

  /**
   * 这个窗口**当前**的工作目录（按窗口收窄历史列表的判据）。
   *
   * - 绑了会话：以**那条会话的 cwd** 为准——它是会话的创建事实，也是这个窗口此刻
   *   在看的目录。判据读**权威账本** `sessionCwds` 而不是 `this.sessions` 那一行：
   *   后者是界面该看见的历史，**子代理会话根本不在里面**（`visibleSessionRows` 全局
   *   藏掉），切进子代理页时读它就会退化成「拿不到 cwd」；
   * - 没绑会话（空态页、还没落壳）：退回**新会话页上选定的目录**（`newSessionCwd`）——
   *   空态页那枚胶囊显示的就是它，窗口接下来也会落到这个目录的空壳上；
   * - 账本里没有这条（列表还没到、服务端没给 cwd）：返回 `undefined` = 这个窗口**没有
   *   目录证据**，发帧那一档就按**未分组**列（`visibleForView` 第 3 档）。不拿另一个
   *   目录去猜（判据按肯定证据写）。
   */
  private viewCwd(viewId: string): string | undefined {
    const sessionId = this.viewSessions.get(viewId);
    if (sessionId === undefined) return this.newSessionCwd;
    return this.sessionCwds.get(sessionId);
  }

  /**
   * 把全局列表折成界面的两个列表：归档过的进归档那一份。
   *
   * **空壳照样进列表**：它是一条普通的可管理行，只是多一位 `occupied`——被会话窗口拿着
   * （绑着或正在落壳）的空壳在界面上锁住（不可勾选、不给归档 / 删除按钮，见
   * `sessionSelection.sessionLocked`），没被拿着的照常可删。
   *
   * 仍然留在 `this.sessions` 里：cwd 解析、恢复窗口、复用都要读这一行。
   */
  private groupSessionLists(rows: readonly SessionSummaryView[]): {
    active: SessionSummaryView[];
    archived: SessionSummaryView[];
  } {
    const active: SessionSummaryView[] = [];
    const archived: SessionSummaryView[] = [];
    for (const session of rows) {
      // unread 不落在行对象上（列表整份替换时行是新建的），按权威集合现算；
      // occupied 同理，按**当下这一刻**的占用表现算（不落进 `this.sessions`）
      const row: SessionSummaryView = {
        ...session,
        unread: this.unreadSessionIds.has(session.id),
        occupied: session.blank === true ? this.occupiedBlank(session.id) : false,
      };
      (this.archivedSessionIds.has(session.id) ? archived : active).push(row);
    }
    return { active, archived };
  }

  /**
   * 已知的**空会话 id** 集合（服务端的 `blank` 位）。
   *
   * 用途只有一个：`@` 提及的对话候选过滤（见 `queryFiles`）。候选 RPC 会给全量会话，
   * 而列表里空会话不该从 `@` 那条路漏出来（它们连标题都没有，候选行只能拿会话 id 当
   * 名字）。**这一条不随「历史列表放开空壳」而变**：历史是用户主动去管的东西，`@` 是
   * 「引用一条对话」——引一条还没有内容的新建壳没有意义。
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
      // 归档＝用户把这条收起来了，不再要求提醒：留着那条未读就是归档列表里一条**永远清不掉
      // 的蓝**（只有亲手打开它才会清，而归档会话通常不会再打开）。同上，离开标记一起作废。
      this.setSessionUnread(sessionId, false);
      this.leftGeneratingSessionIds.delete(sessionId);
      this.subagentRunning.delete(sessionId);
      this.clearSubagentOrder(sessionId);
      this.forgetSubagentIndex(sessionId);
      this.emitSessionLists();
      this.redeliverSubagentTrees();
      setTimeout(() => void this.refreshSessions(), 500);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to archive the session"), error);
    }
  }

  /**
   * 恢复归档：服务端把会话移回工作区分组（`workspace/unarchiveSession`，与归档同一个
   * `WorkspaceArchiveValue`）。权威状态同样经 workspace/follow 流的 `archived` 增量回来，
   * 列表自动刷新；兜底再拉一次列表（增量延迟时）。
   */
  private async unarchiveSession(sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.unarchiveSession(sessionId);
      this.archivedSessionIds.delete(sessionId);
      this.emitSessionLists();
      setTimeout(() => void this.refreshSessions(), 500);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to restore the session"), error);
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
   * （删完无处可看，且服务端内存里还开着它）；**被任何窗口拿着的空壳**也不能删
   * （界面上那颗垃圾桶本就不给这种行，见 `sessionSelection.sessionLocked`，这里是
   * 宿主侧的第二道）。
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
    // **被窗口拿着的空壳不能删**：它正被某个窗口当作「新会话」用着（或马上要用），删掉
    // 等于从别人脚下抽走会话。这一条对**本窗口**也成立（`isSessionViewed` 那条只挡
    // 「当前这个窗口」）——界面上那颗垃圾桶本来就不给这种行（`sessionLocked`），这里是
    // 宿主侧的第二道。
    if (this.occupiedBlank(sessionId)) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("This blank session is in use and cannot be deleted."),
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
    // 删掉的会话在未读账上也不该留一条：`deletedSessionIds` 让它从列表里永远消失（连归档
    // 列表都不进），那条旗标就成了永远不会被清掉的死重量（真机 globalState 里见过实例）。
    this.setSessionUnread(sessionId, false);
    this.leftGeneratingSessionIds.delete(sessionId);
    // 状态账本同理：这条会话不可能再出现在任何目录里
    this.subagentRunning.delete(sessionId);
    this.forgetSubagentIndex(sessionId);
    this.clearSubagentOrder(sessionId);
    // 这条会话的占位登记一并收掉（它已经不在任何列表里了）。上面那条占用保护保证此刻
    // 没有窗口绑着它，这里清的是可能残留的**预留**（另一个窗口正飞在落壳路上）——
    // 它的下一次检查会发现条目没了，然后另建一条，不会把一条已删的会话接回来
    this.blankReservations.delete(sessionId);
    this.blankOccupants.delete(sessionId);
    this.emitSessionLists();
    this.redeliverSubagentTrees();
    if (!removed) {
      this.log(
        `[sessions] 会话 ${sessionId} 的日志目录已不存在，已从列表中移除（服务端内存中的副本仍存活到 dsh 进程退出）`,
      );
    }
  }

  /**
   * 记住一个已删除的会话 id 并持久化（跨扩展重载，列表保持干净）。
   *
   * 真正删除是终结性的：通知队列里那条会话的 `seq` 水位到这里收掉（归档 / 恢复 /
   * 关闭视图都不清——那条会话还会回来，水位留着才挡得住重发）。这也是水位表的
   * **唯一**清理路径，所以必须挂在这里，不能只写在注释里。
   */
  private rememberDeleted(sessionId: string): void {
    if (this.deletedSessionIds.has(sessionId)) return;
    this.deletedSessionIds.add(sessionId);
    this.notifications.forgetSession(sessionId);
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
   * 记下这个窗口的一次**用户动作**（点「+」、打开 / 恢复一条会话、关窗），返回它的代号。
   *
   * 代号只增不减，比较它就能回答「从我出发到现在，这个窗口的意图变过没有」——覆盖换绑定、
   * 关窗、以及切走再切回来（ABA）这三种只看 `viewSessions` 看不出来的变化。
   */
  private beginViewAction(viewId: string): { viewId: string; epoch: number } {
    this.viewActionSeq += 1;
    this.viewActions.set(viewId, this.viewActionSeq);
    return { viewId, epoch: this.viewActionSeq };
  }

  /**
   * 这一次动作还是不是这个窗口**最近**的那一次（不看绑定，只看意图）。
   *
   * `epoch` 允许是 `undefined`：自动恢复会**只读**记下这一刻的代号（不占新号），
   * 而那时这个窗口可能一次动作都还没有（`viewActions` 里没有条目）——`undefined` 与
   * "仍然没有"相等，''之后真有人动了就比不上了。
   */
  private viewActionIsCurrent(action: { viewId: string; epoch: number | undefined }): boolean {
    return this.viewActions.get(action.viewId) === action.epoch;
  }

  /**
   * 「新建对话」：把这个窗口退到**本工作区那条空壳会话**上。
   *
   * 用户 2026-10-01 拍板，从 2026-09-22 的「点「+」不落会话记录、第一条消息才建」改成
   * **对齐官方 DSH Web 的口径：空态就是一条真的会话**（一条还没开始过对话的空壳）。
   * 所以点「+」不是「什么会话都没有」，而是回到工作区当前那条空壳上——没有就建一条
   * （`ui-workspace` 的 `startSession` → `openWorkspace` → `reuseOrCreateBlank`）。
   *
   * 这条口径反过来让原先为「还没有会话」维护的一整套客户端机制整体消失：空态页从第一帧
   * 起就绑在真会话上，模型 / 权限 / 预设直接写在它上面（见 `setModel`、`setPermission`、
   * `selectAgentPreset` 各自走的就是有会话那一路）。
   *
   * 没有窗口可退（命令面板入口且没有活动窗口）时什么都不做：没有窗口就没有「下一次
   * 发送」，建出来的记录没人用得上。
   *
   * **先切、后建**（用户 2026-10-01 口径）：落壳那串动作（连后台 → `session/create` →
   * 拉列表）都是往返，绝不能挡在切换前面——那样点「+」要等一两秒界面才动，而界面此刻
   * 该做的就是「立刻变成空态」。所以先同步把窗口退回空态并推那一帧，再让落壳在后台走完
   * （`reuseOrCreateBlank` 落好之后自己会补一份带会话的快照）。手里已经有一条现成空壳时
   * 更快：域与换绑都是同步的，连那一帧空态都不必先推（见 `switchToBlankSync`）。
   *
   * **当前就停在一条空壳上时完全 no-op**（用户 2026-10-17 口径）：
   * 什么都不做——不清输入框 / 附件 / 待发与失败回显 / 空态页那几项待建选择，不改模型 / 思考
   * 强度 / 权限 / 预设 / 工作目录，不换绑定、不认领、不连后台、不发任何 RPC、不另建也不删，
   * 只记一行开发者日志。判据只有一条：窗口此刻绑着的那条是空壳（`isBlankShell`——服务端
   * `blank` 位与本地 `engagedSessions` 都没说它已经说过话）。
   *
   * **判据不做任何加料**：既不排除「正在生成」，也不排除「日志里有别的状态」。生成中的会话
   * 会被 `markSessionEngaged` 翻掉 blank 位（说上话就不再是空壳），所以再叠一道 running 闸只会
   * 给「已经判成空壳、但状态位还在路上」的边缘帧留下另建 / 换绑的分支——那正是这条口径要
   * 消灭的东西。同理不读日志脏不脏：改过的标题、计划模式、目标 / 待办、自动化任务都不影响
   * 这一下。
   *
   * **一次点击是一次动作**（`beginViewAction`）：下面那条落壳路跨了好几串 await，期间用户再点
   * 一次「+」、点开历史里的一条、或关掉窗口，都让这一次动作作废（后到的动作自己会走完整套）。
   * 占号这一步在 no-op 判据**之后**：什么都不做的那一下不该把别人在飞的动作作废。
   */
  async newSession(viewId?: string): Promise<void> {
    if (!viewId) {
      this.log("[new] 没有活动窗口，「新建对话」不建会话");
      return;
    }
    // **当前绑着的就是一条空壳：完全 no-op**。判据与返回都在占号 / 任何 await 之前——
    // 这一下不改任何状态、不发任何帧、也不动动作代号（见上面那条注释）。
    const bound = this.viewSessions.get(viewId);
    if (bound !== undefined && this.isBlankShell(bound)) {
      this.log(`[new] 窗口=${viewId} 已经停在空壳 ${bound} 上：新建对话不做任何事`);
      return;
    }
    // 点「+」本身占一号：同一次点击的这一趟是唯一有权写绑定 / 做兜底的那一趟；也是让别的
    // 路径（`openSession` 的 `ensureConnected` 往返）回来时发现意图已经换人的那一下。
    this.beginViewAction(viewId);
    // 手里已经有一条现成的空壳（且没被别的窗口拿着）：**先预留、再同步换过去**
    // （0 往返），界面下一帧就是空态。判据与预留是同一个同步步骤，否则两个窗口同时点
    // 「+」会挑中同一条壳（见 `blankReservations`）
    const reusable = this.reserveReusableBlank(viewId);
    if (reusable !== undefined) {
      if (this.switchToBlankSync(viewId, reusable.sessionId)) return;
      this.releaseBlankReservation(viewId, reusable);
    }
    // 还没有现成的壳（列表还没拉过、或这个工作区还没建过），或预留拿到的壳在这中间被别人
    // 认走了：先退回空态，再去建。
    // 「+」是用户显式动作（`AGENTS.md` 的「能不能启动后台」那一档明确列了「新建」），
    // 所以允许拉起后台；但**不弹目录选择器**——没有工作目录时窗口就停在「无会话的空态」，
    // 界面那句「未选择工作区」说清原因，选目录留在那一行的按钮上（用户 2026-09-24 口径）。
    //
    // 这一帧是**整份快照**（不是增量 patch）：空态要把上一个会话的消息 / 队列 / 目标 /
    // 计划模式 / 投影一次归零（patch 没覆盖 model / goal / jobs / planMode / permission，
    // 残留会漏过去）。
    this.detachView(viewId);
    this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
    await this.ensureSession(viewId, { start: true, askDir: false });
  }

  /**
   * **同步**把窗口换到一条已知的空壳上（0 往返）：解绑 → 建域 → 换绑 → 推整份快照。
   *
   * 四步都是同步的（域是内存对象，跟随流是随后才开的），所以点「+」时界面下一帧就是空态。
   * 顺带把空态页那几项「待建参数」在 `bindViewToSession` 里清掉——与异步那条路完全同构
   * （那里绑完后推的也是同一份 `snapshotFor`）。
   *
   * 空壳的值由投影帧回填（这条路上不落实任何待建参数，理由见 `reuseOrCreateBlank`）。
   * 认领（让服务端激活它、顺带弄清它记着的预设还在不在）由 `adoptBlankInBackground`
   * 随后补上——它是一趟往返，绝不能挡在切换前面。
   *
   * 空壳由调用方**先预留**（`reserveReusableBlank`）：`bindViewToSession` 把它从「预留」
   * 转成「占用」，别的窗口在这中间不会挑走它。
   *
   * @returns 换绑成功 → true；拿不到域（客户端已经不在了）→ false，调用方退回异步那条路。
   */
  private switchToBlankSync(viewId: string, sessionId: string): boolean {
    this.detachView(viewId);
    const scope = this.ensureScope(sessionId);
    if (!scope) return false;
    this.bindViewToSession(viewId, sessionId, scope);
    this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
    this.adoptBlankInBackground(sessionId);
    return true;
  }

  /**
   * 把窗口落到一条**真实会话**上（已经有就原样返回，否则落到本工作区那条空壳上）。
   *
   * 两条用法，`options` 就是它们的差别：
   *
   * - **用户显式动作**（发消息、点「+」、打开菜单）：`start: true`（允许拉起后台）、
   *   `askDir` 按场景定——发消息没有工作目录时**就地弹一次目录选择器**（用户 2026-09-22
   *   拍板：不编造默认路径，也不封死发送），「+」与菜单不弹（见 `newSession`、
   *   `listCommandsForView`）。**附件入口不走这里**：它不建会话、不连后台，没有可用会话
   *   就直接拒收并提示（见 `intakeBlockMarker`）；
   * - **自动路径**（窗口就绪、VS Code 打开/关掉文件夹、连接结算后的补壳）：`start: false`——
   *   只消费激活期那一次自动连接（`awaitActivationConnect`），**既不起后台、也不自己发起连接**。
   *   窗口重载（聊天页面那一层）不该把用户刚停掉的后台又拉起来（用户 2026-10-18 口径）。
   *
   * 空壳本身由 `reuseOrCreateBlank` 找或建（官方口径，见那里），所以「打开 `/` 或 `@`
   * 菜单要先建一条会话」这件事不再是一条特殊路径：那时窗口早就绑在空壳上了。
   *
   * **同一个窗口的并发调用共用一次尝试**：`@` 候选每敲一个字符重取一次，不合并就会
   * 各建一条会话（见 `sessionEnsures`）。
   *
   * `options.avoid` 点名这次**绝不能再挑回来**的那条壳（`openSession` 打开一条被别的窗口
   * 拿着的空壳时传它的 id）：它刚被解绑，`blankHolder` 已经看不到它的占用，不显式排除就会
   * 被立刻复用回来，「落一条本窗口自己的新壳」根本不成立。
   *
   * @returns 会话域；用户取消了目录选择、没有工作目录、或客户端不可用 → undefined
   *          （调用方什么都不做，草稿留在输入框里）。
   */
  private async ensureSession(
    viewId: string,
    options: {
      start: boolean;
      askDir: boolean;
      avoid?: string;
    },
  ): Promise<SessionScope | undefined> {
    const existing = this.scopeOfView(viewId);
    if (existing) return existing;
    const inflight = this.sessionEnsures.get(viewId);
    if (inflight) {
      // **显式请求要能把在飞的这条链升档**：在飞的多半是 `ready` 尾巴 / 补壳那条**自动路径**
      // （`start: false`），它可能正卡在"等激活期那次自动连接"上。用户这时点「+」/发消息若只是
      // 并进去，`ensureConnected({ start: true })` 与 `userChoseConnection` 都不会发生——
      // `dshChat.autoConnect` 关着、或激活期探测还没落地时，这枚按钮就按不动了。
      // 所以先把许可与连接落下来（与那条链的等待无关），会话落地仍由共享的那条链收口。
      if (options.start) await this.ensureConnected({ start: true });
      // **同窗口共用一次尝试**（`@` 候选每敲一个字符重取、附件、自动补壳都会并发调到这里）：
      // 共享的那条链失败时不能变成 N 个等待者各建一次（那正好把合并承诺反过来了）。
      const settledScope = await inflight;
      const bound = this.scopeOfView(viewId);
      if (bound) return bound;
      return settledScope;
    }
    const attempt = (async (): Promise<SessionScope | undefined> => {
      if (!this.client || this.connection !== "connected") {
        // `start: true` 是**用户显式动作**（发消息、点「+」、打开菜单）：允许拉起后台。
        // 其余（`ready` 尾巴、`onConnected` 的自动补壳）是**自动路径**：只消费激活期那一次
        // 自动连接（`awaitActivationConnect`），绝不自己发起连接——否则聊天页面重载一次就能把
        // 用户刚停掉的后台又拉起来（用户 2026-10-18 口径）。
        if (options.start) await this.ensureConnected({ start: true });
        else await this.awaitActivationConnect();
      }
      if (!this.client) return undefined;
      // 连接与目录这两步都可能让**别的路径**先把这个窗口绑到一条会话上（用户点了历史
      // 里的一条）：绑定是既成事实，就按它走，不再自己建一条把它顶掉
      const bound = this.scopeOfView(viewId);
      if (bound) return bound;
      if (options.askDir) {
        // 「要目录」的判据是**有没有一个能用的目录**（`hasWorkspaceDir`），不是
        // 「有没有真工作区」：用户已经在新会话页上选过目录时，发消息不该再问一遍
        // （`askWorkspaceDir` 每次都弹，见那里的注释）。
        if (!this.hasWorkspaceDir() && !(await this.askWorkspaceDir())) return undefined;
      } else if (!this.hasWorkspaceDir()) {
        // 建空壳必须先有工作目录：`session/create` 要么给 `workspaceId`、要么给 `cwd`，
        // 而 `workspacePath()` 在两者都没有时给的是**扩展宿主**的 `process.cwd()`
        // ——那是 VS Code 的安装路径，用户既没选、也无从知道（见 `workspacePath`）。
        // 这条路上不弹选择器，窗口就停在「无会话的空态」。
        return undefined;
      }
      // 挑选与预留放在这里（而不是函数开头）：上面那条 `await ensureConnected` 之后
      // 列表可能才第一次到手，而「判据 + 预留」必须在**同一个同步步骤**里完成。
      // 这一次尝试只持有这一个预留，由下面的 `finally` 按代号释放（迟到的收尾删不掉
      // 后来者的预留）。
      if (!this.sessions.length) await this.refreshSessions();
      const reserved = this.reserveReusableBlank(viewId, options.avoid);
      // 「这一次尝试手里最终占着哪一条壳」由落壳链回报（`onHold`）：新建出来的那条 id 与
      // 认领那条不同，预留要跟着换过去，而释放**只认代号**（见 `releaseBlankReservation`），
      // 换过 key 也能放得掉。
      let held = reserved;
      try {
        return await this.reuseOrCreateBlank(viewId, reserved, (next) => {
          held = next;
        });
      } finally {
        if (held !== undefined) this.releaseBlankReservation(viewId, held);
      }
    })();
    this.sessionEnsures.set(viewId, attempt);
    try {
      return await attempt;
    } finally {
      // **只清新自己的那一份**：按对象身份比对，避免把期间可能换成的另一条尝试删掉
      // （换掉了就说明有更新的那一条在飞，删它会让别人另起一条、重复建壳）。
      if (this.sessionEnsures.get(viewId) === attempt) this.sessionEnsures.delete(viewId);
    }
  }

  /**
   * 让窗口落到一条**空壳会话**上：本工作区里已经有一条还没开始过对话的就认领它，
   * 没有就 `session/create` 建一条（官方 `ui-workspace` 的同名方法，两半都抄：
   * `reuseOrCreateBlank` 的扫描见 `reusableBlank`）。
   *
   * 两条路都要**过服务端**（新建与认领都是 `session/create`，认领见 `adoptBlankShell`）：
   * 自己把一条已有会话绑上是不够的——服务端不会为它激活 Agent，而 `agentPresets/select`、
   * 第一条消息这些 RPC 都要求那条会话活着。
   *
   * 两条路的差别只在「要不要落实空态页上的待建参数」：
   *
   * - **真新建**：**工作目录**（`workspacePath()`）、**agent 预设**（用户点过的 > 配置项 >
   *   服务端默认，见 `agentPresetFor`）、**模型**（记成域上的 `pendingModel`，由第一次
   *   发送前的 `selectModel` 提交）在这里一次性落实；
   * - **认领**：它本来就有自己的预设与模型，照搬这次的待建值等于把那条会话上的选择改掉，
   *   所以**不动**——它的值由投影帧回填（空态页那几枚胶囊显示的就是这条会话的真实状态，
   *   「预览值」这个语义随之消失）。认领**会**把它日志里记着的预设照原样再报一次，那正是
   *   「不动」的手段（服务端见目标与现状相同就什么都不记）。
   *
   * **权限**两条路都落实（与部署默认不同的那笔在绑定后补发一次 `/permission`）：它是
   * 「这次要用的权限」，用户刚在空态页上点过。
   *
   * `reserved` 是 `ensureSession` 在判据那一刻**同步**占下的那条可复用空壳（见
   * `blankReservations`）。它只对本窗口可见，所以这里直接认领它；认领失败（预设被删、
   * 服务端不接受这条空壳）时清掉它上面的选择再认领一次（见 `adoptBlankShell`），
   * **认领不了就另建一条**——用户点这一下要的是一条能用的新会话，不该卡在一条坏壳上。
   *
   * **拿到 id 就当场占住它**（`onHold` 回报最终那一份预留）：认领那条路上 id 可能就是它，
   * 而**新建**那条路上我们手里原本什么都没有——不占的话，下面那次 `refreshSessions` 的
   * 往返期间另一个窗口（B）就能在列表里看到这条新壳、预留并绑走它，等我们回来再一绑，
   * 两个窗口共享同一条壳、占用表还被覆盖成后来者。
   *
   * **绑定临界区还要再确认 holder**：预留表只保护「还没人拿起」的壳，一旦 B 已经**绑上**
   * 就是占用表说话。不是自己就让位（另铸一条），绝不绑别人的壳。
   */
  private async reuseOrCreateBlank(
    viewId: string,
    reserved?: { sessionId: string; token: number },
    onHold?: (held: { sessionId: string; token: number }) => void,
  ): Promise<SessionScope | undefined> {
    if (!this.client) return undefined;
    try {
      const preset = this.agentPresetFor(viewId);
      const workspaceId = await this.ensureWorkspace();
      // 预留仍归本窗口时认领它；这中间被释放 / 被别人接管了就当没有预留
      const reusable = reserved !== undefined && this.reservationIsMine(viewId, reserved)
        ? reserved.sessionId
        : undefined;
      if (reusable !== undefined) this.log(`[new] 窗口=${viewId} 复用空壳 ${reusable}`);
      const created =
        reusable !== undefined
          ? await this.adoptBlankShell(reusable)
          : await this.createSessionInWorkspace(workspaceId, preset);
      // 「这条会话是这次**真新建**的吗」：认领那条路上服务端也可能回一条**另铸**的会话
      // （点名的空壳已经不是空壳 / 写者不放手，见服务端的 `claim`），那条就等同于新建
      let fresh = reusable === undefined || created.sessionId !== reusable;
      // **当场占住它**（这一步是同步的，后面那次 `refreshSessions` 之前完成）：占住之后
      // 别的窗口在列表里看到它也挑不走它（`reusableBlank` 跳过 `blankHolder` 非空的）。
      let target = created.sessionId;
      let hold = this.reserveBlankFor(viewId, target, reserved?.token);
      onHold?.(hold);
      const occupant = this.blankHolder(target);
      if (occupant !== undefined && occupant !== viewId) {
        // B 在我们创建之后把它绑走了：这条壳不再是我们的。另铸一条，绝不共享
        this.log(`[new] 窗口=${viewId} 刚拿到的空壳 ${target} 已被窗口 ${occupant} 占用：另铸一条`);
        const again = await this.createSessionInWorkspace(workspaceId, preset);
        target = again.sessionId;
        fresh = true;
        hold = this.reserveBlankFor(viewId, target);
        onHold?.(hold);
      }
      // 空态页选过的权限在**绑定前**读走（`bindViewToSession` 会清掉它）
      const wantedPermission = this.viewPermission.get(viewId);
      // 拉一次列表：新壳要出现在 `this.sessions` 里才找得到（`reusableBlank` 扫的就是它），
      // 本地 blank 位也在这里与服务端对齐一次
      await this.refreshSessions();
      // **写绑定前复查**：从上面的判据走到这里跨了至少一个 await（`ensureWorkspace` /
      // `session/create` / 这次 `refreshSessions`），期间恢复路径或用户点历史里的一条
      // 完全可能已经把这个窗口绑走了。绑定是既成事实——让位，不要把它顶掉：顶掉的表现
      // 就是「会话内容先出现、随后一闪变成空会话」（用户 2026-10-02 报的现场）。
      // 本次真新建的那条空壳留着（服务端没有删除 API，它本来就该给以后进空态的窗口
      // 复用），只是不绑给这个窗口。
      const bound = this.scopeOfView(viewId);
      if (bound) return bound;
      // **窗口在 await 期间关掉了**（用户关掉编辑区面板 / 收起侧栏）：落壳链回来时
      // webview 已经不在了，绑定它只会在这张表里留一条永远没人看的记录（恢复、持久化
      // 缓存都读它）。判据用窗口名册的当前快照——`viewOrder` 是「这个 viewId 还在」的
      // 肯定证据（`bindView` 登记、`unbindView` 摘掉），比时间戳可靠
      if (!this.viewOrder.includes(viewId)) {
        this.log(`[new] 窗口=${viewId} 已在落壳期间关闭：不写绑定（会话 ${target} 留作以后复用）`);
        this.freeBlank(viewId, target);
        return undefined;
      }
      // 这条壳在 `refreshSessions` 期间有没有被别的窗口**绑上**（占用表比预留表晚说话）：
      // 是别人就让位，不共享、也不覆盖占用账本
      const lateOccupant = this.blankHolder(target);
      if (lateOccupant !== undefined && lateOccupant !== viewId) {
        this.log(`[new] 窗口=${viewId} 要绑的 ${target} 已被窗口 ${lateOccupant} 占用：不绑，留作以后复用`);
        this.releaseBlankReservation(viewId, hold);
        return undefined;
      }
      // **域到这里才建**（`ensureScope` 会开 follow / jobs 两条长活流）：上面任何一条早退
      // 路径都不该留下一个 `viewers === 0`、没人看的域——那两条流会跟着扩展宿主一直活着
      const scope = this.ensureScope(target);
      if (!scope) return undefined;
      // 投影帧要晚一点才到，先用服务端的答复给域一个初值（`agentPreset` 那条路见
      // `applyAgentPresetProjection`）。认领那条路这一笔尤其有用：服务端回的正是那条
      // 会话**最终**认下的预设（照日志记着的那个，或退回的部署默认）。
      if (created.agentPreset !== undefined && target === created.sessionId) scope.agentPreset = created.agentPreset;
      if (fresh) {
        // 界面上显示的模型在这里落实：用户点过的优先；没点过就是空态页展示着的
        // 部署默认（`agent-default-model` 配置）——记成 `pendingModel` 后第一次发送
        // 前由 `selectModel` 提交，会话实际用的就是胶囊上那一个，而不是「服务端
        // 自己再默认一次」。认领回来的那条有它自己的模型，不动。
        const model = this.viewModel.get(viewId) ?? this.defaultModel;
        if (model) {
          scope.pendingModel = model;
          scope.model = model;
        }
      }
      this.bindViewToSession(viewId, target, scope);
      // 待建会话的权限选择到此落实（会话启动后以界面显示的设定运行）。与部署默认
      // 相同就不发：那个值服务端建会话时本来就会装上，再发一次只会在新会话里留下
      // 一条没人点的 `/permission` 命令节点
      if (wantedPermission && wantedPermission !== this.defaultPermission) {
        await this.runCommandOnSession(target, `/permission ${wantedPermission}`);
      }
      this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
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
    // 这个窗口不再占着那条空壳（退回空态 = 释放占用，界面上的行随之解锁、别人可以再用它）
    this.freeBlank(viewId, previous);
    const draft = this.drafts.get(previous);
    if (draft !== undefined) {
      this.drafts.set(viewId, draft);
      this.drafts.delete(previous);
    }
    // 附件草稿按**窗口键**搬回去（与 `bindViewToSession` 的迁移严格对称）：点「+」
    // 之后输入框上那几枚芯片还在，用户接着发不需要重加
    this.attachments.move(previous, viewId);
    this.dropViewers(previous);
    this.noteSessionLeft(previous, wasGenerating);
    if (this.viewKinds.get(viewId) === "panel") this.setPanelTitle(viewId, panelTabTitle(undefined));
    this.log(`[bind] 窗口=${viewId} → 空态（原=${previous}，会话记录保留）`);
    this.persistWindowState();
    // 退回空态 = 这个窗口不再有当前会话的 cwd（历史列表随之放宽到「未分组」那一档，
    // 空态页那行目录退回用户选定的目录，见 `viewCwd`）
    this.emitViewScopedState();
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
   * **指名认领**一条已经存在的空壳会话：`session/create` 带上它的 `sessionId`
   * （官方 `ui-workspace` 的 `createInWorkspace` 复用现成空壳、`restoreBlank` 重开保存过的
   * 空壳，两条都这么走）。
   *
   * 为什么非走这一趟不可：服务端**只为它在册的会话激活 Agent**，而
   * - `agentPresets/select`（空态页那枚预设胶囊）的 `agent` 形参是**只认活 Agent** 的查找
   *   （`packages/core/agent` 的 `lookups.register('agent', …)` → `agents.get`）；
   * - 客户端过去只把这条会话绑上，激活全靠 follow 流的**后台提升**（`promote`）。
   *
   * 那条后台提升在「会话日志里记着的预设已经不存在」时必然失败：服务端重建一条会话要按
   * `agentPreset` 投影组装（`agent-preset-registry` 的 `session.ts`），解析不到就整条 resume
   * 失败。于是这条会话看得见、用不了——点预设胶囊弹「切换失败」，第一条消息也发不出去
   * （用户 2026-10-16 报障）。官方那两条路用**显式 create** 激活，绕开了这个死局。
   *
   * 预设：照**日志里记着的**那一个再报一次（`sessionPresets`）。服务端发现目标与现状相同
   * 就什么都不记，所以「复用不动它的预设」这条口径原封不动；它已经不存在 / 装不起来时
   * 服务端直接失败（`agent-preset/not-found` / `agent-preset/invalid`，注册表整个不在时是
   * `agent-preset/conflict`），这时**不带预设再认领一次**，让它按部署默认重新组装——那条会话
   * 就活了。官方 `restoreBlank` 的兜底逐字如此（`restoreBlank` 的注释：*Reopen a saved blank
   * Session under the preset its log recorded, or under the Host default once that preset no
   * longer activates*）。
   *
   * 目录用**服务端自己报的那条 cwd**（`sessionCwds` 账本，取自同一份 `session/list`）：
   * 逐字节相同，不依赖客户端这边的写法归一，也不需要工作区注册表里有这条会话（按 cwd 建
   * 的路只要求 cwd 一致）。账本里没有它时退回 `workspacePath()`。
   *
   * @returns 服务端**最终认下的**会话身份与预设：点名的空壳在这中间已经不是空壳时，服务端
   *          会另铸一条新的（`claim` 的既有语义），调用方要用返回值，不能用入参。
   */
  private async adoptBlankShell(sessionId: string): Promise<{ sessionId: string; agentPreset?: string }> {
    if (!this.client) throw new Error("no client");
    const cwd = this.sessionCwds.get(sessionId) ?? this.workspacePath();
    const recorded = this.sessionPresets.get(sessionId);
    const target = { cwd, ...(recorded === undefined ? {} : { agentPreset: recorded }) };
    try {
      return await this.client.createSession(target, sessionId);
    } catch (error) {
      // 认不出被点名的预设：它对应的定义已经从部署里删掉了（或装不起来 / 注册表整个不在）。
      // 这是**正常的一种结局**（不是异常状态）：会话日志里那个 id 是过去某次的选择，会话不可能
      // 再按它组装。不带预设再认领一次，服务端按部署默认组装。
      const code = error instanceof DshApiError ? error.code : undefined;
      if (recorded === undefined || !PRESET_UNAVAILABLE_CODES.has(code ?? "")) throw error;
      this.log(`[preset] 空壳 ${sessionId} 记着的预设「${recorded}」已经用不了（${code}），退回部署默认认领`);
      return await this.client.createSession({ cwd }, sessionId);
    }
  }

  /**
   * 后台认领一条**已经绑上**的空壳（`switchToBlankSync` / `openSession` 两条路用）。
   *
   * 那两条路都是「界面先到、往返在后」（同步换绑是 2026-10-01 的口径：点「+」不许等
   * 落壳的往返），所以认领只能排在他们之后——但**必须发**：少了它，这条会话的 Agent 永远
   * 不会活，预设切不动（见 `adoptBlankShell`）。
   *
   * 认领结果里服务端可能改掉了预设（日志里那个已经不存在 → 退回了部署默认），那就把域上的
   * 值与界面同步一次。**失败只记日志**：界面上已经在这条会话上，把用户推走或不推都不对，
   * 而它「活不过来」这件事由用户下一次动作（切预设 / 发消息）如实报出来。
   */
  private adoptBlankInBackground(sessionId: string): void {
    if (!this.isBlankShell(sessionId)) return;
    void this.adoptBlankShell(sessionId)
      .then((created) => {
        if (created.sessionId !== sessionId) {
          // 服务端没认这条（它已经不是空壳了）而是另铸了一条：那条新会话没人绑，留在
          // 列表里给下一次进空态的窗口复用；这个窗口仍停在原会话上
          this.log(`[preset] 认领空壳 ${sessionId} 被服务端拒绝，另铸了 ${created.sessionId}（窗口不动）`);
          return;
        }
        const scope = this.scopes.get(sessionId);
        if (!scope || created.agentPreset === undefined || scope.agentPreset === created.agentPreset) return;
        scope.agentPreset = created.agentPreset;
        this.deliver(sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(scope), ["agentPreset"]),
        });
      })
      .catch((error: unknown) => {
        this.log(`[preset] 认领空壳 ${sessionId} 失败：${this.describeError(error)}`);
      });
  }

  /**
   * 找一个**可以接回来**的空壳会话（官方 Web 端 `ui-workspace` 的 `reuseOrCreateBlank`
   * 的扫描那半，判据逐条照搬）。
   *
   * - 服务端说它还没开始过对话（`blank === true`）——**这就是空壳的定义**；
   * - 且本地 blank 位没标它已经说过话（`engagedSessions`）：列表是拉的，服务端的
   *   `blank` 会晚到，缺了这条就会把已经用过的会话当空壳接回去（见那张表的注释）；
   * - 且它落在**本工作区**（`normalizePath` 后相同）——换个目录不能顶替；
   * - 且不是归档 / 子代理会话；
   * - 且**当前没有窗口拿着它**（占用或预留：空壳不跨窗口共享）。同一个窗口自己用过、
   *   此刻没人接着的壳**仍然可以拿**（换目录换回来就是这一档：那条壳空着，接回来比每条
   *   目录堆一条壳好）。
   * - 且不是 `avoid`（调用方点名**这次绝不能再挑回来**的那条：它刚被解绑，这里已经看不到
   *   它的占用，不显式排除就会被立刻复用回去——点「+」判定要另开一条时正是这种情形）。
   *
   * 找不到就返回 undefined，调用方照常 `session/create`。
   */
  private reusableBlank(avoid?: string): string | undefined {
    const target = normalizePath(this.workspacePath());
    for (const row of this.sessions) {
      if (row.blank !== true) continue;
      if (row.id === avoid) continue;
      if (this.engagedSessions.has(row.id)) continue;
      if (this.archivedSessionIds.has(row.id) || this.subagentSessionIds.has(row.id)) continue;
      if (normalizePath(row.cwd) !== target) continue;
      if (this.blankHolder(row.id) !== undefined) continue;
      return row.id;
    }
    return undefined;
  }

  /**
   * 这条壳**此刻被谁拿着**：已经绑上的窗口（占用），或正在落壳的窗口（预留）。
   *
   * 占位表里记的窗口**必须真的还绑着它**——`bindViewToSession` / `detachView` / `unbindView`
   * 都会同步清，所以这条判据是「他还在看」的肯定证据，而不是一张可能发霉的名册；
   * 发霉的条目在这里**不参与任何判定**（连同 `blankHolder` 的返回值一起被忽略）。
   */
  private blankHolder(sessionId: string): string | undefined {
    const occupant = this.blankOccupants.get(sessionId);
    if (occupant !== undefined && this.viewSessions.get(occupant) === sessionId) return occupant;
    return this.blankReservations.get(sessionId)?.viewId;
  }

  /**
   * **同步**挑一条可用的空壳并为这个窗口预留它（0 往返，见 `blankReservations`）。
   *
   * 判据与预留必须在同一个同步步骤里完成——先判后预留（中间隔着 await）正是并发窗口
   * 挑中同一条壳的根因。`avoid` 是**这一次绝不能再挑回来**的壳（点「+」判定要另开一条时
   * 那条旧壳：它刚被解绑，`blankHolder` 已经看不到它，不显式排除就会被立刻复用）。
   *
   * 预留是「这条壳马上有人用」，会改变 `occupiedBlank` 与界面上的锁，所以这里要重发列表帧。
   *
   * @returns 预留到的壳与它的**代号**；没有可用的（本工作区没有空壳、或都被拿着）→ undefined
   */
  private reserveReusableBlank(
    viewId: string,
    avoid?: string,
  ): { sessionId: string; token: number } | undefined {
    const found = this.reusableBlank(avoid);
    if (found === undefined) return undefined;
    this.blankReservationSeq += 1;
    const token = this.blankReservationSeq;
    this.blankReservations.set(found, { viewId, token });
    this.emitSessionLists();
    return { sessionId: found, token };
  }

  /** 这次预留**还是不是我的那一次**（代号对得上，见 `blankReservations` 的注释）。 */
  private reservationIsMine(viewId: string, reserved: { sessionId: string; token: number }): boolean {
    const entry = this.blankReservations.get(reserved.sessionId);
    return entry !== undefined && entry.viewId === viewId && entry.token === reserved.token;
  }

  /**
   * **把一条具体的壳当场占住**（判据已经由调用方负责）：落壳链拿到 id 之后立刻做这一步，
   * 否则下面那次 `refreshSessions` 的往返期间别的窗口就能把这条刚出现的壳挑走。
   *
   * 一个窗口名下至多一份预留：旧的（认领那条路上原来那份）随新的一次作废。
   *
   * @param token 沿用哪一号（`ensureSession` 按**代号**释放，换了 key 也放得掉）；省略则新铸
   * @returns 这一次占住的预留（调用方要把它回报给 `ensureSession` 的 `finally`）
   */
  private reserveBlankFor(
    viewId: string,
    sessionId: string,
    token?: number,
  ): { sessionId: string; token: number } {
    this.blankReservationSeq += 1;
    const held = { sessionId, token: token ?? this.blankReservationSeq };
    this.releaseBlankReservation(viewId);
    this.blankReservations.set(sessionId, { viewId, token: held.token });
    this.emitSessionLists();
    return held;
  }

  /**
   * 释放预留。**只认自己那一号**：`token` 给出时条目必须还是那一次预留，否则什么都不做
   * ——迟到的 `finally` 不许把后来者的预留删掉（那正是「只存不比」会踩的坑）。
   *
   * 判据**只看代号**，不看会话 id：落壳链会把同一份预留从「认领的那条壳」换 key 到
   * 「新建出来的那条壳」（见 `reserveBlankFor`），会话 id 换了、这一次预留的身份没变。
   * 代号是只增不减的全局序号，不会重复，所以按它比较仍然等价于「只认自己那一号」。
   *
   * @param reserved 这次要放的预留（省略 = 这个窗口名下**所有**预留一起放：窗口下线）
   */
  private releaseBlankReservation(viewId: string, reserved?: { sessionId: string; token: number }): void {
    let changed = false;
    for (const [id, entry] of [...this.blankReservations]) {
      if (entry.viewId !== viewId) continue;
      if (reserved !== undefined && entry.token !== reserved.token) continue;
      this.blankReservations.delete(id);
      changed = true;
    }
    if (changed) this.emitSessionLists();
  }

  /**
   * 这个窗口不再用这条空壳了：把占用放掉（绑到别处、退回空态、窗口下线）。
   *
   * 只放**自己**那一份：别的窗口拿着的那条纹丝不动（`blankHolder` 已经保证同样的壳不会
   * 被两个窗口同时拿到，这里是它的第二道）。预留由 `releaseBlankReservation` 单独收
   * （它有代号守卫）。
   *
   * @param sessionId 省略 = 这个窗口名下**所有**占用一起放（关窗、换绑到别处时用）
   */
  private freeBlank(viewId: string, sessionId?: string): void {
    let changed = false;
    for (const [id, occupant] of [...this.blankOccupants]) {
      if (occupant !== viewId) continue;
      if (sessionId !== undefined && id !== sessionId) continue;
      this.blankOccupants.delete(id);
      changed = true;
    }
    if (changed) this.emitSessionLists();
  }

  /**
   * 这条空壳**此刻有人拿着**（绑着或正被预留）：界面上那一行锁住，删除 / 归档也拒。
   *
   * 两个消费点，判据同源：界面行上的 `occupied` 投影（`groupSessionLists`）与删除的实时
   * 保护（`deleteSession`）——列表帧可能有延迟，而删除是破坏性动作，取当下这一刻。
   * **预留也算**：预留是「马上就有窗口要它」，此刻删掉它等于把那次落壳抽空。
   */
  private occupiedBlank(sessionId: string): boolean {
    return this.blankHolder(sessionId) !== undefined;
  }

  /**
   * 这条会话是不是**还没开始过对话的空壳**（服务端的 `blank` 位与本地 blank 位一起看，
   * 与 `reusableBlank` 同一条判据）。
   *
   * 列表里查不到那一行（子代理、别的工作区的会话）时按「不是空壳」算：宁可走保守那条路。
   */
  private isBlankShell(sessionId: string): boolean {
    if (this.engagedSessions.has(sessionId)) return false;
    return this.sessions.find((row) => row.id === sessionId)?.blank === true;
  }

  /**
   * 把域上**待生效**的模型选择提交给服务端（`session/selectModel`），失败只记日志。
   *
   * 两个调用点，差别是「什么时候提交」：`send`（这条会话已经开始了，切换要在下一次请求
   * 之前落到服务端）与 `setModel`（空壳会话说不上「本轮」，当场提交，见那里的注释）。
   * 先清 `pendingModel` 再 await：重复提交同一笔没有意义，而并发的两次提交会让服务端
   * 收到两条（第二条覆盖第一条，结果不一定停在用户最后点的那一个）。
   */
  private async applyPendingModel(scope: SessionScope): Promise<void> {
    if (!this.client || !scope.pendingModel) return;
    const { provider, model, reasoningEffort } = scope.pendingModel;
    scope.pendingModel = undefined;
    try {
      await this.client.selectModel(scope.sessionId, provider, model, reasoningEffort);
    } catch (error) {
      this.log(`[model] 应用模型选择失败：${this.describeError(error)}`);
    }
  }

  /**
   * 这条会话**已经说过话**了：点亮本地 blank 位，本地那一行按事实翻面。
   *
   * 官方的同一件事是 `client/sessions/session.ts` 的 `blankBit`：prompt **受理**那一刻
   * 翻假（被拒时不动，`Rejection must leave a first prompt blank and eligible for
   * workspace reuse`），并 `onEngaged` 通知管理器记进 `engagedSessions`。本扩展没有那条
   * 事件流，只有这里与 `setSessionRowRunning` 两个写入点（见 `engagedSessions` 的注释）。
   *
   * 两个落点分工不同，别把后者当成复用判据：
   *
   * - **点亮本地 blank 位**：这才是复用门槛——`reusableBlank` 折的就是它，而服务端的
   *   `blank` 要等 `turn/start`、再等一次 `session/list` 才到得了；
   * - **把本地那一行 `blank` 翻面**：只服务显示侧（`emitSessionLists` 挡不挡这一行、
   *   `blankSessionIds` 挡不挡 `@` 对话候选），所以这一句刻意**不推帧**——界面下一次列表帧
   *   自然收敛（发出去的那一刻服务端的 status 帧就会来一趟）。**但释放了占用 / 预留时要推**：
   *   别的窗口那一行的占用锁得跟着解开，那不能等下一次列表。
   */
  private markSessionEngaged(sessionId: string): void {
    this.engagedSessions.add(sessionId);
    // 说过话的会话不再是空壳：占位与预留登记到此为止（`refreshSessions` 那条清理路径的
    // 提前版——本地 blank 位是**实时**的，服务端的 blank 还要等一轮往返才翻）
    const dropped = this.blankOccupants.delete(sessionId);
    const released = this.blankReservations.delete(sessionId);
    if (dropped || released) this.emitSessionLists();
    const row = this.sessions.find((item) => item.id === sessionId);
    if (row?.blank !== true) return;
    this.sessions = this.sessions.map((item) =>
      item.id === sessionId ? { ...item, blank: false } : item,
    );
  }

  /**
   * 现在能不能确定新会话落在哪个目录：打开着文件夹，或用户在新会话页上选过一个。
   *
   * **空壳会话的创建也要它**——没有目录时 `session/create` 只能拿到扩展宿主的
   * `process.cwd()`（见 `workspacePath`），所以那条路上不建壳、窗口停在「无会话的空态」，
   * 等目录确定再补（见 `adoptBlankForUnboundViews`）。
   *
   * 它**不是** `askWorkspaceDir` 的早退判据（那个只认「真工作区」，见那里的注释）：
   * 这里问的是「有没有一个能用的目录」，而用户自己选的目录就是能用的——发消息时不该
   * 因为他已经选过就再问一遍；而空态页那枚胶囊问的是「要不要换个目录」，那是另一件事。
   */
  private hasWorkspaceDir(): boolean {
    return Boolean(vscode.workspace.workspaceFolders?.[0] ?? this.newSessionCwd);
  }

  /**
   * 空态页上改工作目录：弹系统目录选择器并记下来，然后把窗口落到**新目录**那条壳上。
   *
   * 用户 2026-10-10 口径：**这个目录必须能反复更改**。所以这一下**每次都弹**选择框
   * （见 `askWorkspaceDir`），与「有没有选过目录」无关；选中的目录由
   * `rebindWorkspaceDir` 真正落到会话上（官方口径：打开一个工作区就有一条 blank 会话）。
   *
   * 只在没有打开文件夹时才可能被调用（界面那行在 locked 时不发这条指令）；这里仍
   * 再判一次——界面状态可能滞后于 VS Code 的实际文件夹。
   */
  private async pickWorkspace(viewId: string): Promise<void> {
    if (vscode.workspace.workspaceFolders?.[0]) {
      this.refreshWorkspace();
      return;
    }
    // 用户取消 → 保持原状（点击的反馈就是那个对话框本身，不再另外弹提示）
    if (!(await this.askWorkspaceDir())) return;
    // 用户显式选了一个目录 ⇒ 允许拉起后台（与发消息同一档）
    await this.rebindWorkspaceDir(viewId);
  }

  /**
   * 把窗口落到**当前工作目录**那条空壳上（用户刚在新会话页上选了 / 换了目录）。
   *
   * 为什么不能只调 `ensureSession`：它见到域就直接返回（「这个窗口已经有会话了」），
   * 于是界面上写着新目录、窗口却仍绑在旧目录那条壳上——用户 2026-10-10 报的
   * 「选完目录实际没有反应」正是这一半。
   *
   * 目录是**会话的创建事实**（服务端没有改 cwd 的 API），所以换目录只能是**换一条壳**：
   *
   * - 还绑着**空壳**（`isBlankShell`：没说过话）且它的 cwd 与新目录不同 → 解绑 → 立刻
   *   推一帧空态（**先切、后建**，与 `newSession` 同一口径：落壳那串往返不许挡住切换）
   *   → 由 `ensureSession` 落到新目录那条壳上（`reuseOrCreateBlank` 会复用该目录里
   *   已有的空壳，没有才建）。旧壳**留在服务端**（没有删除 API），以后切回那个目录时
   *   `reusableBlank` 还会复用它是它最好的去处；
   * - 目录没变 → 什么都不做（重复点同一个目录不该重建会话）；
   * - 已经绑着**说过话**的会话 → 不动它（换目录不该改写一条已经在用的对话；这种窗口
   *   本来也不在空态页上——空态页只在没有消息时渲染）。判据按肯定证据写：**拿不到
   *   「它是空壳」的证据就不动手**（`isBlankShell` 对查不到的会话返回 false）。
   */
  private async rebindWorkspaceDir(viewId: string): Promise<void> {
    const bound = this.viewSessions.get(viewId);
    if (bound !== undefined) {
      if (!this.isBlankShell(bound)) return;
      // 空壳一定在 `this.sessions` 里（`isBlankShell` 就是查它），所以这里读得到 cwd
      const row = this.sessions.find((item) => item.id === bound);
      if (row && normalizePath(row.cwd) === normalizePath(this.workspacePath())) return;
      this.detachView(viewId);
      this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
    }
    await this.ensureSession(viewId, { start: true, askDir: false });
  }

  /**
   * 弹一次系统目录选择器，选中就记下来并推一帧（**只有打开着文件夹时才不弹**）。
   *
   * 两个入口共用，但**要不要问**由调用方定：
   *
   * - 空态页上点那行目录（`pickWorkspace`）：**每次都问**——那枚胶囊的语义是
   *   「选择 / 更改工作目录」，用户点它就是要换一个；
   * - 要落会话却还没有目录时（`ensureSession`）：**只有完全没有目录才问**
   *   （`hasWorkspaceDir` 为假），选过的目录不该在发消息时被再问一遍。
   *
   * 早退判据只认**真工作区**（VS Code 打开着文件夹）：那种情况下目录跟随 VS Code，
   * 没有第二个口径。**绝不能**拿 `newSessionCwd` 早退——它正是「第二次点那枚胶囊
   * 不弹框、目录改不了」的根因（用户 2026-10-10 报的现场）：第一次选完目录之后
   * `hasWorkspaceDir()` 就为真，之后再点连对话框都不弹，而对话框是这一下点击唯一的反馈。
   *
   * @returns 现在有目录了（本来就打开着文件夹、或选了一个）就是 true；用户取消 → false。
   */
  private async askWorkspaceDir(): Promise<boolean> {
    if (vscode.workspace.workspaceFolders?.[0]) return true;
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
    // 目录变了：空态页那行目录与这个窗口的历史列表（没有打开文件夹时按选定目录收窄，
    // 见 `viewCwd`）必须同一刻换——两者是同一件事（「这个窗口现在的目录是哪个」）的两面
    this.emitViewScopedState();
    return true;
  }

  /**
   * 把指定窗口切到给定会话（域不存在则创建；其他窗口不受影响）。
   *
   * `subagent` 给出时目标是一个**子代理会话**（不进会话列表、只能用子代理地址
   * 打开）：面包屑返回父会话、切换下拉换兄弟、恢复路径都走这条。不带时是普通
   * 会话——包括从子代理页点面包屑回来那一刻。
   * 目标是一条**空壳**（还没开始过对话）时，绑上之后由 `adoptBlankInBackground` 补一次
   * 指名认领：窗口状态缓存把窗口接回一条空壳（`restoreViewSession` 走的也是这里）时，
   * 少了它这条会话的 Agent 不会活——预设切不动、消息发不出去（见 `adoptBlankShell`）。
   * 认领是往返，排在**推完快照之后**（先切、后建那条口径的同一件事）。
   *
   * 目标是一条**被别的窗口拿着的空壳**时**不共享**：它此刻是那个窗口的「新会话」，从别人
   * 脚下抽走不行——这里改成给本窗口落一条自己的新壳。**内容会话照旧共享**（两个窗口看
   * 同一条已开始的对话是容许的）。
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
    //
    // 这一趟先占一号（`beginViewAction`）：`ensureConnected` 是往返，期间用户可能又点了
    // 另一条（第二次点击会占新号）——那一次才是他现在的意图，这一次回来就收手，不许把
    // 后点的覆盖掉。
    const action = this.beginViewAction(viewId);
    if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: true });
    if (!this.viewActionIsCurrent(action)) {
      this.log(`[bind] 窗口=${viewId} 打开 ${sessionId} 的期间用户又选了别的：这一次不落地`);
      return;
    }
    if (!this.client) return;
    // 被**别的窗口**拿着（绑着或正预留）的空壳：不共享，改落一条本窗口的新壳。
    // 判据只看 `blankHolder`（绑定 + 预留两张表），**不要求列表里那一行说 blank**：
    // 列表可能还没拉到那条行（`isBlankShell` 因此为 false），而占用 / 预留表已经证明它是
    // 别人正在用的空壳——缺行正是预留要覆盖的那一档。这个窗口自己拿着它的情形走不到这里：
    // 函数开头已经把「已经在这条会话上」挡掉了。
    if (!subagent && this.blankHolder(sessionId) !== undefined) {
      this.log(`[bind] 窗口=${viewId} 要打开的空壳 ${sessionId} 已被别的窗口占用：改落一条新壳`);
      this.detachView(viewId);
      this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
      await this.ensureSession(viewId, { start: true, askDir: false, avoid: sessionId });
      return;
    }
    const scope = this.ensureScope(sessionId, subagent, seedSiblings);
    if (!scope) return;
    this.bindViewToSession(viewId, sessionId, scope);
    // 给这个窗口推**完整状态快照**（不是增量 patch）：域可能早已存在（别的窗口
    // 先打开过它），它的历史重放只发生在 follow 流开窗那一刻，这个窗口当时没绑上、
    // 收不到——不补快照，它的内容就永远是空的。域是刚建的时快照近似为空，
    // follow 流开帧随后回填，两条路径行为一致。
    this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
    // 子代理会话没有「空壳」这个概念（它不进会话列表，`isBlankShell` 也查不到它）
    if (!subagent) this.adoptBlankInBackground(sessionId);
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
        // 这里只能登记**真描述符 label**；会话标题是 resolver 的显示名兜底，绝不能
        // 写进索引冒充真 label，否则后续标题变化会被这条旧值挡住。
        // 建域时描述符可能还没读出来，那就先不登记 label（resolver 会现算显示名）。
        this.noteSubagentIndex(subagent.parentSessionId, {
          id: sessionId,
          label: existing.adapter?.selfDescriptorLabel() ?? sessionId,
          mode: subagent.mode,
        });
      }
      if (existing.subagentAddress) {
        // 上下文是现算的：地址变了就重推（面包屑 / 切换下拉立即正确）
        this.deliver(sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(existing), ["subagent", "subagentTree"]),
        });
      }
      return existing;
    }
    if (!this.client) return undefined;
    const scope = new SessionScope(sessionId);
    scope.subagentAddress = subagent;
    if (subagent) {
      // 地址就是血缘：恢复路径直接落到子代理页、列表与父目录都还没回来时，树也要
      // 至少画得出「顶层会话 → 自己」这一条
      this.noteSubagentIndex(subagent.parentSessionId, {
        id: sessionId,
        label: sessionId,
        mode: subagent.mode,
      });
      const parent = this.scopes.get(subagent.parentSessionId);
      // 父目录快照：种子（切换时随行的最新一份）优先；没有种子才读父会话域——
      // 它此刻**多半已被回收**（视图离开就回收，见 `dropViewers`），读不到就是 []。
      scope.subagentSiblings = seedSiblings?.length
        ? [...seedSiblings]
        : parent
          ? [...parent.subagentEntries]
          : [];
      // 种子里的兄弟行也补进血缘索引（它们的父就是这条子代理的直接父会话）
      for (const sibling of scope.subagentSiblings) {
        this.noteSubagentIndex(subagent.parentSessionId, sibling);
      }
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
    // 自动化任务也**预取**一次（用户 2026-10-15 口径）：抽屉入口的指示灯要在
    // **从没打开过面板**的会话上就亮得起来，而它吃的正是这份清单——面板只是同一份
    // 数据的详细视图。静默读（不动 `schedulesStatus`），失败就当没读到、下次再试。
    scope.schedulesWanted = true;
    void this.loadSchedules(scope, true);
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
    const streamClient = this.client;
    if (!streamClient) return;
    scope.followHandle?.cancel();
    // 这一次开流的**代号**：回调只认「还是这个 client、还是这个域、还是这一次开流」的那一份。
    // 被取消 / 被替换 / 断线重连之后的旧流还可能送来迟到的 item / error / end——它们既不许
    // 复活旧流，也不许把帧写进新的适配器（见 `followIsCurrent`）。代号从全局发号器取，
    // 不复用，收线 + 重连这种「同一个域对象再开一次」的时序才不会与新流拿到同一个代号。
    const generation = (this.followGenerationSeq += 1);
    this.followGenerations.set(sessionId, generation);
    // **这一段开窗的证据作废**：重开 / 新开跟随流意味着即将收到一份新快照，旧窗口折出来的
    // 结论都属于**上一段日志**。适配器整个重建（下一行），状态从服务端重算。
    const isCurrent = (): boolean => this.followIsCurrent(scope, streamClient, generation);
    const adapter = new SessionAdapter((frame) => {
      // 被替换掉的那一次开流的适配器：它的帧不再算数（否则旧快照/旧 patch 会污染新域）
      if (!isCurrent()) return;
      // **durable 的「在不在跑」要同时落到会话列表那一行**（2026-09-30 修）：收尾的
      // 权威状态位（`api-session/status`）可能比本轮的 durable `turn/end` **先到**，
      // 那一刻本地还有「本轮开着」的肯定证据，它会被 `acceptSessionStatus` 拒收（那条
      // 规则本身没错），而随后 durable 收尾只把域改回 false —— 行上的假 true 就此没人
      // 纠正：历史列表显示「生成中」，离开时 `isSessionGenerating`（域 **or** 行）据此
      // 记了离开标记，下一次列表刷新把那一行翻回 false 时结算成未读，就是用户报的
      // 「明明已读却亮蓝」。列表与域从此同一个来源（对账见 `scripts/unreadMarker.test.ts`）。
      if (frame.type === "patch" && typeof frame.patch.running === "boolean") {
        // durable 的结论比先前被拒收的那条中继值**新**：账没有必要再留着
        // （与列表整份刷新被采纳时的口径一致，见 `refreshSessions`）
        this.pendingStatuses.delete(sessionId);
        // durable 轮次边界同样是权威来源：记版本 + 值（值没变也要记，见 `authorityRunning`）
        this.noteAuthorityRunning(scope, frame.patch.running);
        this.setSessionRowRunning(sessionId, frame.patch.running);
      }
      this.deliver(sessionId, frame);
    });
    // 图片句柄 → 字节：`read_image` 的 image 块只给不透明 attachmentId，
    // 要经 `session/attachment` 换成 base64 才能显示。适配器不持有网络客户端，
    // 所以在这里注入。
    adapter.loadImages = (refs, done) => {
      void this.loadAttachmentImages(sessionId, refs, done);
    };
    // 文件芯片种类（[新增] / 删除线）的分类回调：适配器交路径，宿主查 git 与磁盘。
    // 带上会话 cwd：芯片路径可能是相对会话工作目录的拼写，解析不了会误判 deleted
    adapter.classifyFiles = (paths) => this.classifyFiles(this.cwdOf(scope), paths);
    // 未知事件（内核冒出的新词汇）记进输出通道：用户侧那条通知会进队列（确认之后还能在
    // 通知历史里回看），日志那一份则是可追溯的诊断细节（含事件数据摘要）。
    // 带会话 id——多会话并存时要知道是哪个会话冒出来的。
    adapter.log = (line) => this.log(`[event] 会话=${sessionId} ${line}`);
    // 子代理「注册」：父会话的 `subagent/catalog` durable 事件（直播与重放都会到）→
    // 立刻并入目录并发帧，不必等面板打开那一下 RPC（见 `registerSubagent`）
    adapter.onSubagentEstablished = (entry) => this.registerSubagent(scope, entry);
    // 一条人的用户消息被 durable 承认：收回它的乐观回显。重放期间这条回调会被适配器
    // **攒到那一份整份 `messages/reset` 发出去之后再补**（见 `adapter.notifyAdmitted`）
    // ——重连 / 重载窗口后既不留下幽灵回显，也不会先收回、后落位（那就是"闪一下"）
    adapter.onUserMessage = (message) => this.noteUserAdmitted(sessionId, message);
    // 一条**已经交给服务端**的提交永远到不了 durable（判定见 `dsh/submissionReceipts.ts`）：
    // 「被领走却没落盘」是真的没发出去（标失败留行），「被有意取消」只撤回收显。
    adapter.onSubmissionLost = (rpcId, reason) => this.settleLostSubmission(rpcId, reason);
    // 一条本客户端不认识、又不是 ignorable 的会话事件 → 黄色通知（`@unknownEvent:<type>`）。
    // 适配器在重放期间不回调，所以历史重放不会重新产出旧通知；`seq` 一起带过来，
    // 队列按**每会话水位**拒绝重发（不是新的实际发生，见 notificationQueue 文件头）。
    adapter.onUnknownEvent = (event) =>
      this.notify({
        sessionId,
        level: "warn",
        kind: "unknownEvent",
        key: event.type,
        text: `@unknownEvent:${event.type}`,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      });
    // durable 用户行的图片借**同一次提交的本地附件**（`submissions` 里那份，图片带 dataUrl）：
    // 不借的话交接时会从缩略图退回文件名芯片、等字节换回来再变回缩略图（闪两下）
    adapter.resolveEchoAttachments = (rpcId) => this.originFor(rpcId)?.attachments;
    // 回放的用户消息带上「本机那个原文件在哪」：芯片悬停显示它，点开也是它。跨宿主重启
    // 之后只能靠持久记录（`attachmentOpenStore.ts`）——那一层只认原文件，临时副本不算。
    adapter.originalPathFor = (attachmentId) => readOriginalTarget(this.state, attachmentId);
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
    scope.followHandle = streamClient.followSession(sessionId, {
      onItem: (value) => {
        if (!isCurrent()) return;
        // **顺序在 `replayFollowSnapshot` 里**：先让适配器回放历史记录，再铺开投影值。
        // 投影是「截至 asOfSeq 的折叠结果」，永远比记录里的事件新；反过来先铺投影再回放，
        // 历史里最后一个事件会把折叠值**覆盖回旧状态**——`plan` 就是活例（见
        // `docs/design-projections.md`）。这条顺序以前只能靠
        // 正则去比两个 `indexOf` 的大小，现在是一个可以被直接调用的函数。
        const frame = value as SessionFollowFrame;
        replayFollowSnapshot(frame, adapter, (block) => {
          ingestFollowSnapshot(this.projectionHandlers, scope, block);
        });
        // 一份完整快照 = 这条流真的活着：连续失败计数与待触发的重开一并清掉
        if (frame?.type === "snapshot") this.closeFollowRetry(sessionId);
      },
      onError: () => {
        // **单流**失败（帧 error）不会触发 socket 的 close，`onConnected` 也就不会跑；
        // 按 `DshClient` 的契约（见 `client.ts` 的 `connect`）由这里重开这条流。
        // 迟到的旧流 error 在这里被 `isCurrent` 挡掉：不重开、不复活。
        if (!isCurrent()) return;
        this.reopenScopeFollow(scope, streamClient, generation);
      },
      onEnd: () => {
        // 服务端把这条流**正常结束**（帧类型 `end`）时客户端只调 `onEnd`、**不调**
        // `onError`（见 `client.ts` 的 `ws.on("message")`）：同一条恢复路径，漏了它这条
        // 路径就完全没有恢复——适配器同样停在旧态、`hasOpenTurn()` 永远真。
        if (!isCurrent()) return;
        this.reopenScopeFollow(scope, streamClient, generation);
      },
    }, scope.subagentAddress);
  }

  /**
   * 这条跟随流的回调还属于「当前这一次开流」吗（`openScopeFollow` 的流身份）。
   *
   * 三个都相同才算数：同一个客户端实例、`scopes` 里还是这个域对象、这个域的
   * **开流代号**还是这一次。用代号而不是比较句柄：句柄要等 `followSession` 返回才拿得到，
   * 开流调用**还没返回**时它是 undefined——把 undefined 当作通过条件，会使「同步回调排下的
   * 重开」在句柄已被新的一次开流替换之后仍然越权开流（真客户端的回调恒为异步，见
   * `client.ts` 的 `openStream`；但身份判据不该靠这个前提成立）。
   */
  private followIsCurrent(scope: SessionScope, client: DshClient, generation: number): boolean {
    if (this.client !== client) return false;
    if (this.scopes.get(scope.sessionId) !== scope) return false;
    return this.followGenerations.get(scope.sessionId) === generation;
  }

  /**
   * 清掉一条会话的跟随流重试状态（计数 + 待触发的那次重开）。
   *
   * 四个清理点：收到完整快照（流活了）、域被回收、连接收线（`teardownStreams`）、
   * socket 重连（重开是全新的开始）。不清理就是「旧 timer 还能再开一条流」和
   * 「按会话建的表只增不删」。
   */
  private closeFollowRetry(sessionId: string): void {
    const timer = this.followRetryTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.followRetryTimers.delete(sessionId);
    this.followRetries.delete(sessionId);
  }

  /**
   * 一条 `session/follow` **单流**失败或**被服务端正常结束**后的重开
   * （`openScopeFollow` 的 onError / onEnd 两个调用点）。
   *
   * 为什么必须自己重开：socket 断开时 `DshClient` 会在 `close` 分支把每条流都 `onError`
   * 一次并重连，重连成功由 `onConnected` 重开全部域的流；而**单流**结束（帧类型的
   * `error`，或服务端把这条流 `end` 掉——后者客户端只调 `onEnd`，连 `onError` 都没有）
   * 只把这一条流从客户端的流表里删掉，socket 照旧——`onConnected` 不会跑；若不在这里
   * 重开，这个域就再也没有跟随流了。
   *
   * 后果不是「少几帧」：适配器停在旧态 ⇒ `hasOpenTurn()` 永远为真 ⇒ 此后每一条权威
   * 「不在跑」（`api-session/status`）都被 `acceptSessionStatus` 拒收，界面一直显示
   * 生成中，durable 的收尾也永远到不了（用户 2026-10-10 报的「报错的会话有时似被误判
   * 生成」）。重开的新快照会重放跟随窗口，`turnRunning` 于是从 durable 事实**重算**：
   * 收尾在窗口里就是结论，不在窗口里则按既有规则「认不出就不发帧」——这里**不**猜 running。
   *
   * 退避与上限：连续失败按次数线性退避（150ms 起、封顶 1.5s），超过 `FOLLOW_RETRY_MAX`
   * 只记一行日志、不再重开（再开也只会变成热循环，攒着等 socket 重连那条路）。
   * 定时器与计数都由 `closeFollowRetry` 清理；等待期间域被回收、客户端被换掉、或这条流
   * 已被别的开流替换（`followIsCurrent` 不成立）时，那一次重开直接作废。
   */
  private reopenScopeFollow(scope: SessionScope, client: DshClient, generation: number): void {
    const sessionId = scope.sessionId;
    const attempts = (this.followRetries.get(sessionId) ?? 0) + 1;
    this.followRetries.set(sessionId, attempts);
    if (attempts > FOLLOW_RETRY_MAX) {
      if (attempts === FOLLOW_RETRY_MAX + 1) {
        this.log(`[follow] 会话=${sessionId} 已重试 ${FOLLOW_RETRY_MAX} 次，停止自动重开（等待 socket 重连）`);
      }
      return;
    }
    const timer = setTimeout(() => {
      this.followRetryTimers.delete(sessionId);
      if (!this.followIsCurrent(scope, client, generation)) return;
      this.openScopeFollow(scope);
    }, Math.min(150 * attempts, 1_500));
    // 同一会话同时只留一个待触发的重开：后到的 error 以前一个为准
    const previous = this.followRetryTimers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    this.followRetryTimers.set(sessionId, timer);
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
      refs.map((ref) => this.fetchAttachmentDataUrl(sessionId, ref.attachmentId, ref.mediaType)),
    );
    done(results);
  }

  /**
   * 一个 durable 附件句柄 → data URL（取不到返回空串）。
   *
   * 两个消费方共用这一处 RPC：回放的图片（`loadAttachmentImages`）与「队列消息取回
   * 重新编辑」时从内容块还原的图片（`editQueuedMessage`）。
   */
  private async fetchAttachmentDataUrl(
    sessionId: string,
    attachmentId: string,
    mediaType: string | undefined,
  ): Promise<string> {
    const fetched = await this.fetchAttachmentBytes(sessionId, attachmentId);
    if (!fetched) return "";
    // 服务端只回 base64 与字节，媒体类型在句柄里（拿不到就按 png——
    // 浏览器对 data URL 的 MIME 很宽容，错的类型仍会渲染）
    return `data:${mediaType ?? fetched.mediaType ?? "image/png"};base64,${fetched.bytes.toString("base64")}`;
  }

  /**
   * 一个 durable 附件句柄 → **字节**（取不到返回 undefined）。
   *
   * `session/attachment` 只服务图片（服务端按会话日志里的图片块授权，见
   * `docs/dsh-server-api.md` 的其他端点速查）：文件没有这条回头路，只能靠本地上传时
   * 记下的那一份（`attachmentTargets`）。
   *
   * 第三个消费方是「打开附件」：回放的历史图片本地已经没有字节，只能换回来落临时副本。
   */
  private async fetchAttachmentBytes(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ bytes: Buffer; mediaType?: string } | undefined> {
    if (!this.client) return undefined;
    try {
      const value = await this.client.request<{ attachment?: unknown; data?: unknown }>(
        "session/attachment",
        { request: { sessionId, attachmentId } },
      );
      const data = typeof value?.data === "string" ? value.data : "";
      if (!data) return undefined;
      const mediaType = (value?.attachment as { mediaType?: unknown } | undefined)?.mediaType;
      return {
        bytes: Buffer.from(data, "base64"),
        ...(typeof mediaType === "string" ? { mediaType } : {}),
      };
    } catch (error) {
      this.log(`[attachment] 读取图片失败：${this.describeError(error)}`);
      return undefined;
    }
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
   * 轨迹账本一帧：把该窗口会话**当时看得见的全部 durable 事件**折一遍发出去
   * （官方视图也是客户端自己折的，没有对应 RPC，见 `dsh/trajectory.ts` 的文件头）；
   * 整份模型走 JSON 字符串，绕开「`undefined` 键被丢掉」那套线格式语义。
   *
   * 之后再看这一折有没有「**表头不在窗口里**」的工具行（`missingSchemaAnchor`）：
   * 有就按需往前补页（`dsh/trajectoryBackfill.ts`），补到东西再折一遍补发一帧。
   * 为什么要补：跟随开窗只带 `maxMessages` 条消息，而 `request/header` 不属于任何
   * 消息、分页切点是按消息对齐的，于是它**很容易被切在窗口外**——窗口里所有工具行
   * 就都取不到目录，界面上整片「Schema 不可用」。官方开窗是 500 条消息所以少见，
   * 本扩展为了让聊天流少渲染（消息列表没有虚拟滚动）只带一小段，缺口就明显。
   *
   * 帧序是「**先内容、后修正**」：补页要走一次网络往返（长会话可能好几页），第一帧
   * 不该等它——先给现状，补完再刷新。不需要补（判据一开始就不成立）时只发一帧，
   * 与从前逐字相同。
   */
  private async sendTrajectory(viewId: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    const adapter = scope?.adapter;
    const fold = (): string =>
      JSON.stringify(
        adapter
          ? deriveTrajectoryModel(
              adapter.trajectoryEvents(),
              adapter.hasMoreHistory(),
              adapter.trajectoryCallCatalogs(),
            )
          : { turns: [], cellCount: 0, totalSeconds: 0, firstStartedAt: null, hasOlder: false },
      );
    this.emitToView(viewId, { type: "trajectory", json: fold() });
    if (!adapter || !scope || !this.client) return;
    // 一次只跑一条链：轨迹面板在运行中每 3 秒发一次 `listTrajectory`，没有这道闸门
    // 就会并发好几条回补链（同一个 beforeSeq 被请求多次，各自还会重折一遍）
    if (scope.trajectoryBackfilling) return;
    scope.trajectoryBackfilling = true;
    try {
      const client = this.client;
      const added = await backfillTrajectorySchemas({
        missingAnchor: () => {
          const events = adapter.trajectoryEvents();
          const catalogs = adapter.trajectoryCallCatalogs();
          return missingSchemaAnchor(
            deriveTrajectoryModel(events, adapter.hasMoreHistory(), catalogs),
            events,
            catalogs,
          );
        },
        earliestSeq: () => adapter.trajectoryEarliestSeq(),
        throughSeq: () => adapter.cursor(),
        fetchPage: (request) =>
          client.page(
            scope.sessionId,
            request.throughSeq,
            request.beforeSeq,
            request.maxMessages,
            scope.subagentAddress,
          ),
        absorb: (records) => adapter.absorbTrajectoryBackfill(records as never[]),
      });
      if (!added) return;
      this.emitToView(viewId, { type: "trajectory", json: fold() });
    } catch (error) {
      // 回补是机会性的：取不到就保持现状（那些工具行继续显示「Schema 不可用」），
      // 不能因为一次分页失败把轨迹面板弄坏，也不必拿原生通知打断用户。
      this.log(`[trajectory] schema 回补失败：${String(error)}`);
    } finally {
      scope.trajectoryBackfilling = false;
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
      this.notify({ sessionId: source, level: "warn", kind: "branchNoAnchor", text: "@branchNoAnchor" });
      return;
    }
    try {
      const value = await this.client.request<{ sessionId?: string }>("session/fork", {
        request: { sessionId: source, atSeq },
      });
      const childId = value?.sessionId;
      if (!childId) {
        this.notify({ sessionId: source, level: "warn", kind: "branchFailed", text: "@branchFailed" });
        return;
      }
      await this.refreshSessions();
      // 分支结果落在点击的那个窗口：它切到新会话，其他窗口保持不动。
      // **成功不入队**（用户 2026-10-18 口径）：视图已经切到新分支，这就是原位反馈。
      await this.openSession(viewId, childId);
    } catch (error) {
      this.reportError(vscode.l10n.t("Failed to create the branch"), error);
    }
  }

  private teardownStreams(): void {
    // 每个域的 follow 流单独取消（域本身保留，重连时由 onConnected 重开）
    // **重试状态与开流代号一并作废**：只取消句柄的话，已经排下的那次重开、以及旧流迟到的
    // error / end，都还会按这个域再开一条流（域对象仍在 `scopes` 里，只看域的身份判据
    // 照旧成立）——收线 / 换连接之后会多出一条没人收的流。清掉代号即让旧回调一律失效。
    for (const sessionId of [...this.followRetryTimers.keys(), ...this.followRetries.keys()]) {
      this.closeFollowRetry(sessionId);
    }
    for (const scope of this.scopes.values()) {
      scope.followHandle?.cancel();
      scope.followHandle = undefined;
      this.followGenerations.delete(scope.sessionId);
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
    // 会话列表的权威账本同理作废：它记的是**上一个连接那台服务端**的 cwd，换连接后
    // 那批 id 的含义不再保证（下次 `refreshSessions` 到达时整份重建）。清掉只是让
    // 「拿不到 cwd」这一段回到**未分组**兜底（`visibleForView` 第 3 档），不会遗留错目录。
    this.sessionCwds.clear();
    // 同一份原始行上的预设账本一并作废（`adoptBlankShell` 照它报预设：另一台服务端上
    // 那个 id 的含义不再保证，宁可退回部署默认也不要递一个别处的预设过去）
    this.sessionPresets.clear();
    // **预留**作废：这一次连接尝试可能就此结束，留着一条「预留」会让那条壳永远不可用
    // （释放要靠发起它的那条落壳链，而它已经断了）。
    // **占用刻意不清**：它由 `viewSessions` 里仍然成立的绑定支撑（`blankHolder` 要求
    // 占用者真的还绑着它），重连后各窗口还看着同一条会话，清了它们占的空壳会被别的窗口
    // 抢走。扩展重启是另一回事：控制器是新的，两张表天然是空的（用户口径「重启后任何会话
    // 打开前均 false」）。
    if (this.blankReservations.size > 0) {
      this.blankReservations.clear();
      this.emitSessionLists();
    }
    this.subagentOrderGeneration += 1;
    this.subagentOrderPruneCandidates.clear();
    this.subagentActivityAt.clear();
    this.subagentSettlementsPending.clear();
    // 血缘索引属于**这一次连接**（父链 / 身份都来自这台服务端的列表与目录）：
    // 收线后整表作废，旧连接的在途列表由代号检查拒收，不能回填。
    this.subagentIndex.clear();
    this.subagentIndexPruneCandidates.clear();
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
   * 1. **工作区注册表**（`baseline` / `replace` 的 `items` + `upsert` / `remove` 增量）：每条
   *    记录带 `sessionIds`，是「这条会话属于哪个工作区」的唯一来源（`session/list`
   *    不带 workspaceId，见 `workspaces` 字段的注释）；不在任何工作区里的会话就是
   *    「未分组」。
   * 2. **已归档会话集合**：每代以一个 `baseline` 开场，其后是 `archived` 增量
   *    （每次都是**完整集合**）。`session/list` 不分归档与否，归档过滤在客户端做。
   *
   * `replace` 落在**增量位**上（`WorkspaceFollowIncrement`），值却是一整份 `baseline`：
   * 同一代内替换此前交付的全部状态，不是新一代的开帧，只由服务端的访问过滤补发
   * （官方客户端 `acceptIncrement` 的 `case 'replace'` 直接走 `replaceBaseline`）。
   */
  private onWorkspaceFrame(frame: WorkspaceFollowFrameWire): void {
    // 完整值帧：`baseline` 与 `replace` 共用这条应用路径（缺 `value` 的 `replace` 按既有
    // 边界当作坏帧忽略，不误清空）。
    const appliesFullValue = frame?.type === "baseline" || (frame?.type === "replace" && !!frame.value);
    // 先消化注册表增量：`upsert` 换一条记录、`remove` 去掉一条、`order` 只影响
    // 顺序（界面上不展示工作区本身，忽略）。`items` 是完整集合，直接替换。
    let workspacesChanged = false;
    if (appliesFullValue) {
      this.workspaces = workspaceRows(frame?.value?.items);
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
    // 缺 `archivedSessionIds` 时照旧**不动**归档集合（旧服务端 / 旧夹具只给 `items`）。
    const next = appliesFullValue
      ? frame?.value?.archivedSessionIds
      : frame?.type === "archived"
        ? frame.archivedSessionIds
        : undefined;
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
      if (archivedChanged) {
        this.archivedSessionIds = nextSet;
        for (const id of nextSet) {
          this.clearSubagentOrder(id);
          // 归档是肯定证据：树里立刻退掉这条及其下级（其他窗口归档时这里就是唯一来路）
          this.forgetSubagentIndex(id);
        }
      }
    }

    if (!workspacesChanged && !archivedChanged) return;
    // 注册表变了**整份重算**：新会话被记进工作区（或工作区被删）会直接改变
    // 「这条会话该不该出现在这个工作区的历史列表里」，光重发旧列表是不够的。
    if (workspacesChanged) void this.refreshSessions();
    else {
      this.emitSessionLists();
      // 归档集合变了也要重推树：否则标题清单 / 计数停在归档前的节点上
      this.redeliverSubagentTrees();
    }
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
    workingDirectory: (scope, value, present, source) =>
      this.applyWorkingDirectoryProjection(scope, value, present, source),
  };

  /**
   * 执行目录变化只影响当前输入与标题；创建目录、分组和历史路径保持原语义。
   *
   * **只有 live 且真的换了一个目录才进通知队列**（绿色，见
   * `docs/design-notifications.md`）：follow 开帧、控制流 baseline 与重连都会把同一批
   * 投影值重铺一遍，那不是「用户在会话里改了目录」；同一水位的重发会被投影存储拒掉，
   * 根本走不到这里。基准取**上一个有效目录**（没有投影值时退回会话创建目录——契约里
   * baseline 缺键与 `null` 清空都按创建目录兜底），所以：
   * - 域刚建起来、开帧就带着值 → `source !== "live"`，静默铺值；
   * - 开帧没带这个键、随后来的第一次 live 值 → 与创建目录比较，不同就是真实变化；
   * - 清空（`null` / 缺键）与相同值 → 不出通知。
   */
  private applyWorkingDirectoryProjection(
    scope: SessionScope,
    value: string | undefined,
    present: boolean,
    source: ProjectionSource,
  ): void {
    const next = present ? value : undefined;
    // 基准：上一个已提交的投影值；没有就退回会话创建目录（回退口径见 design-projections）
    const previous = scope.workingDirectory ?? this.cwdOf(scope);
    if (scope.workingDirectory === next) return;
    scope.workingDirectory = next;
    // 在发补丁之前作废旧目录的查询；即使查询串没变，界面也会按新目录重取。
    for (const [viewId, sessionId] of this.viewSessions) {
      if (sessionId === scope.sessionId) this.menuQueries.get(viewId)?.abort();
    }
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["workingDirectory"]),
    });
    if (source !== "live") return;
    // 清空不是「改到了某个目录」：这一条不出绿色通知（界面退回创建目录即可感知）
    if (next === undefined) return;
    // 没有基准（会话还没进列表、创建目录也拿不到）时不吞：宁可报一次，也不把真实变化
    // 静默掉——「初始能力缺失 + 第一次 live 值」正是这条要覆盖的场景
    if (previous !== undefined && previous === next) return;
    this.notify({
      sessionId: scope.sessionId,
      level: "info",
      kind: "workingDirectory",
      key: next,
      text: `@executionDirChanged:${next}`,
    });
  }

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
      // 过滤集合（见 `subagentSessionIds`）与跨域血缘索引（标题点击后的树要画到
      // 没打开过的祖先 / 兄弟）
      this.subagentSessionIds.add(entry.id);
      this.noteSubagentIndex(scope.sessionId, entry);
      // 目录来源给不出驻留状态与「用户已读」，两项都由宿主账本补齐（见 `decorateSubagent`）
      const known = this.decorateSubagent(entry);
      const existing = next.find((item) => item.id === known.id);
      // 等价判据按**合并之后的生效值**（`sameSubagentRow`）：同一条 durable 事件重放时
      // 不能白推一帧，也不能白记一行日志
      if (existing && sameSubagentRow(existing, known)) continue;
      next = upsertSubagent(next, known);
      changed = true;
    }
    if (!changed) return false;
    scope.subagentEntries = next;
    return true;
  }

  /**
   * 目录行 → 补齐**只有宿主才知道**的两个字段：驻留状态与「用户已读」。
   *
   * 这两项都不在目录的来源里（`subagentCatalog` 投影与 `subagent/catalog` 事件都没有
   * 它们，`subagents/list` 只在新版之前的服务端上存在），所以宿主各留了一本账：
   *
   * - `subagentRunning`：`session/list` 的原始行与 `api-session/status` 中继都往里写；
   * - `unreadSessionIds`：既有的「生成完毕未读」账本（离开正在生成的会话才记，打开即清）。
   *
   * **在登记时回填是这条链的关键**：状态可能比注册先到（`syncSubagentActivity` 在目录里
   * 找不到那一行，什么也改不了），若不在登记时补上，那次更新就永久丢了——用户报的
   * 「明明还在生成却显示可继续」正是这一条（诊断与回归见 `scripts/subagentRowState.test.ts`）。
   *
   * 行自己带的 `activity` 优先（它可能来自更权威的一次 RPC）；账本读不到就**不下发**，
   * 不猜「正在跑」（见 `SubagentView.activity` 的注释）。
   */
  private decorateSubagent(entry: SubagentView): SubagentView {
    const activity = entry.activity ?? this.knownSubagentActivity(entry.id);
    return { ...entry, ...(activity ? { activity } : {}), unread: this.unreadSessionIds.has(entry.id) };
  }

  /** 宿主账本上「这条子代理此刻在不在跑」；没有结论时返回 `undefined`（不知道 ≠ 没在跑）。 */
  private knownSubagentActivity(childSessionId: string): SubagentView["activity"] {
    const running = this.subagentRunning.get(childSessionId);
    return running === undefined ? undefined : running ? "running" : "inactive";
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
   * 子代理驻留状态（`api-session/status` 中继）→ 记进账本 + 就地改一条的 `activity`。
   *
   * 官方同款（`dsh-api-session-controller` 客户端的 `updateCatalogActivity`）：这条中继
   * 对**每个 agent** 都发，子代理也在内，所以状态点与头部按钮的呼吸可以在**不点开面板**
   * 时就是对的。子代理没有本地日志证据，所以不走 `acceptSessionStatus` 那套「有肯定证据
   * 就拒绝不在跑」的判断——那条规则是给窗口绑定的会话用的。
   *
   * **账本先落**（这一步不能省）：中继可能比目录行先到（父域刚重建、目录靠 follow 流重放
   * 才回来），那一刻 `withSubagentActivity` 找不到 id、什么都不改——账本是那次更新的唯一
   * 去处，目录行登记时由 `decorateSubagent` 从它回填。
   */
  private syncSubagentActivity(childSessionId: string, running: boolean): void {
    // 收尾那一下同时是一条判定条目（一轮的结果，见 subagentActivityAt）：顺序变了就得重推目录，
    // 所以先记时间再改状态（下面那次扇出用的已经是新顺序）
    const orderChanged = this.noteSubagentSettlement(childSessionId, running);
    for (const scope of this.scopes.values()) {
      const { entries, changed } = withSubagentActivity(scope.subagentEntries, childSessionId, running);
      if (!changed) continue;
      scope.subagentEntries = entries;
      // 顺序也变了的话交给下面那一次重推：同一条目录不连发两帧
      if (!orderChanged) this.deliverSubagentList(scope);
    }
    if (orderChanged) this.redeliverSubagentRows(new Set([childSessionId]));
    // 树里的深层节点可能不在任何打开域的目录里（只存在于血缘索引）：状态变化同样
    // 要刷新整棵树，否则标题清单里的状态点停在旧的
    this.redeliverSubagentTrees();
    // 收尾那一刻标题已经落地（它是这条会话自己的首轮产出的）→ 补一次标题账本。
    // 界面因此既不必点开这个子代理、也不必等下一次菜单打开就能看到它的名字。
    if (!running && this.isKnownSubagent(childSessionId)) this.scheduleSubagentTitles();
  }

  /**
   * 记下一条驻留状态，并判断它是不是**一次收尾**；是就同时记下判定时间。
   *
   * 「收尾」的判据是**亲历**：status true 留下一条待结算证据，status false 消费它。
   * 展示用的 running 可被列表打底覆盖，但不能抹掉这条证据；列表 true 也不能创造证据。
   * 同名迟到 false 已无证据可消费，重连打底 false 也不会把陈旧子代理当成刚收尾。
   *
   * @returns 判定时间有没有变新（变新 = 目录顺序要重推）。
   */
  private noteSubagentSettlement(childSessionId: string, running: boolean): boolean {
    for (const candidates of this.subagentOrderPruneCandidates) candidates.delete(childSessionId);
    // 状态中继同样是「等待期间的新事实」：在途完整列表按旧快照缺席时不能把它裁掉
    for (const candidates of this.subagentIndexPruneCandidates) candidates.delete(childSessionId);
    this.subagentRunning.set(childSessionId, running);
    if (this.deletedSessionIds.has(childSessionId) || this.archivedSessionIds.has(childSessionId)) return false;
    if (running) {
      this.subagentSettlementsPending.add(childSessionId);
      return false;
    }
    const settled = this.subagentSettlementsPending.delete(childSessionId);
    // 服务端没有下发「最后一条助手消息的时间」，收尾时刻只能由这条中继亲历（见 subagentActivityAt）
    if (!settled) return false;
    return this.noteSubagentTime(childSessionId, Date.now());
  }

  /** 这个 id 是不是已知的子代理（目录并入点与 `session/list` 的子代理行两处账本）。 */
  private isKnownSubagent(sessionId: string): boolean {
    if (this.subagentSessionIds.has(sessionId)) return true;
    for (const scope of this.scopes.values()) {
      if (scope.subagentEntries.some((entry) => entry.id === sessionId)) return true;
      if (scope.subagentSiblings.some((entry) => entry.id === sessionId)) return true;
    }
    return false;
  }

  /**
   * 目录行在**界面上**的显示名（唯一的解析点，发帧的每条路都走它）。
   *
   * 目录来源**给了真 label** 就原样用（`subagent` 派发与分支类子代理走这条，显示名
   * 不变）；只给了会话 id（= 三个来源都没有 label，workflow 派发的子代理就是这样）
   * 时，按权威程度取：当前**打开着**这条子代理时的显示名（描述符 label → 会话标题）、
   * 标题账本里的会话标题、最后才是会话 id。
   *
   * 解析**不写回** `scope.subagentEntries`：目录是可以重放的（投影 / 事件 / 重连），
   * 写回的名字会被下一次「label 等于会话 id」的并入用 `upsertSubagent` 覆盖回去
   * （用户 2026-10-11 报的「关掉再打开又变回 ID」）。发帧时现算则永远算得出最新的
   * 那个名字，也不干扰 `sameSubagentRow` 的「同一条不重复发帧」判据。
   *
   * 活读的那个名字**等于会话 id 时不算数**：子代理页的会话摘要标题是这里现算出来的
   * （目录里没有 label 时它自己就是会话 id），读回去等于拿 uuid 顶掉账本里的标题。
   */
  private resolveSubagentDisplay(entry: SubagentView): SubagentView {
    if (entry.label && entry.label !== entry.id) return entry;
    const own = this.scopes.get(entry.id);
    const live = own ? this.subagentDisplayName(own) : undefined;
    const named = live && live !== entry.id ? live : undefined;
    const label = named ?? this.subagentTitles.get(entry.id) ?? entry.id;
    return label === entry.label ? entry : { ...entry, label };
  }

  /**
   * `session/list` 的原始行 → 标题账本。
   *
   * 只认子代理行，而且只认**有** `title` 投影的行：投影没有这个键时**不动**账本
   * （「这一版不知道标题」不等于「它没有标题」，抹掉已知值只会让名字退回 uuid）。
   *
   * @returns 真的变了的会话 id（没有变化就不发帧，见 `sweepSubagentTitles`）。
   */
  private collectSubagentTitles(items: readonly SessionSummaryWire[]): Set<string> {
    const changed = new Set<string>();
    for (const item of items) {
      if (item.origin !== "subagent") {
        // 肯定证据：这一行不是子代理（同一个 id 不可能是两者）→ 退掉留下的标题
        if (this.subagentTitles.delete(item.sessionId)) changed.add(item.sessionId);
        continue;
      }
      const title = item.projections?.values?.title;
      const trimmed = typeof title === "string" ? title.trim() : "";
      if (!trimmed || this.subagentTitles.get(item.sessionId) === trimmed) continue;
      this.subagentTitles.set(item.sessionId, trimmed);
      changed.add(item.sessionId);
    }
    return changed;
  }

  /**
   * 一条子代理会话自己的标题（`session/list` 那一路之外的第二条来路：它自己的
   * `patch.session`）→ 记进标题账本，变化就重推目录。
   */
  private rememberSubagentTitle(sessionId: string, title: string | undefined): void {
    const trimmed = typeof title === "string" ? title.trim() : "";
    if (!trimmed || this.subagentTitles.get(sessionId) === trimmed) return;
    this.subagentTitles.set(sessionId, trimmed);
    this.sweepSubagentTitles(new Set([sessionId]), "子代理会话标题");
  }

  /**
   * 目录行变了 → 把受影响的那几条目录重推一遍。
   *
   * 普通会话的清单走 `deliverSubagentList`（唯一的列表扇出点，顺带把父目录快照同步给
   * 正在看它子代理的窗口）；子代理页手里那份**父目录快照**（`subagentSiblings`）只由
   * `subagent` patch 承载，所以那条要单独补发（与 `fetchParentCatalog` 同一手法）。
   *
   * 两个账本共用它：标题（`sweepSubagentTitles`）与判定时间（顺序变了也要重推，否则
   * 界面停在旧顺序上直到下一次目录内容变化）。只推**真的包含这些 id** 的域——账本里
   * 记着别的会话，不该让所有窗口重渲染。
   */
  private redeliverSubagentRows(changed: ReadonlySet<string>): void {
    if (!changed.size) return;
    for (const scope of this.scopes.values()) {
      if (scope.subagentEntries.some((entry) => changed.has(entry.id))) {
        this.deliverSubagentList(scope);
        continue;
      }
      if (!scope.subagentSiblings.some((entry) => changed.has(entry.id))) continue;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["subagent", "subagentTree"]),
      });
    }
    // 显示名 / 排序变了，标题清单里对应的树节点也要跟上（深层节点可能没有打开域）
    this.redeliverSubagentTrees();
  }

  /**
   * 标题账本变了 → 重推受影响的目录。
   *
   * @param source 这次标题是从哪条路来的（只进日志，便于分辨「会话列表」与「子代理自己
   *   的标题」两条来路）。
   */
  private sweepSubagentTitles(changed: ReadonlySet<string>, source: string): void {
    if (!changed.size) return;
    this.redeliverSubagentRows(changed);
    this.log(`[subagents] 标题补齐 ${changed.size} 条（${source}）`);
  }

  /**
   * 单独取一份 `session/list`，**只**补标题账本（不重跑 `refreshSessions` 的
   * blank / running 结算，也不整份替换会话列表）。
   *
   * 两个触发点：子代理菜单打开（那一下就是「把最新的名字要一遍」，与目录本身的按需
   * 刷新同一取舍）与子代理收尾（见 `scheduleSubagentTitles`）。**单飞**：同一时刻
   * 只发一次请求。
   */
  private refreshSubagentTitles(): Promise<void> {
    const client = this.client;
    if (!client) return Promise.resolve();
    if (this.subagentTitlesInflight) return this.subagentTitlesInflight;
    const task = (async () => {
      try {
        const { value, applied, generation, requestSeq, activityChanges } =
          await this.listSessionsForSubagentOrder(client);
        // helper 返回后、这里恢复前可能已经收线或采纳了更新的列表：按**当前代号**复查，
        // 过期快照不许写标题账本，也不许重推目录 / 树。
        if (!applied || generation !== this.subagentOrderGeneration || requestSeq !== this.subagentListAppliedSeq) {
          return;
        }
        const items = value.items ?? [];
        // 同一份 `session/list` 顺带把判定时间账本（用户消息那一半）刷新到最新：菜单打开
        // 就是要「把最新的要一遍」，先后也应该按最新的算。血缘索引已随这次请求的
        // 候选保护在 `listSessionsForSubagentOrder` 内更新。
        this.sweepSubagentTitles(this.collectSubagentTitles(items), "会话列表");
        this.redeliverSubagentRows(activityChanges);
        // 菜单打开那一下正是「把整棵树的最新血缘要一遍」：新层级 / 新兄弟要在这次
        // 回来后就出现在标题清单里
        this.redeliverSubagentTrees();
      } catch (error) {
        // 拿不到就保持现状（名字停在会话 id 或上一次算出来的那一个），只记一行
        this.log(`[subagents] 标题补齐失败：${this.describeError(error)}`);
      }
    })().finally(() => {
      this.subagentTitlesInflight = undefined;
    });
    this.subagentTitlesInflight = task;
    return task;
  }

  /**
   * 子代理收尾后补一次标题账本，**尾随防抖**。
   *
   * 一次 workflow 派发会有很多个子代理依次收尾；逐个发 `session/list` 就是风暴，
   * 合到一次请求里即可（后到的收尾把计时器往后推，最后那一次覆盖整批）。
   */
  private scheduleSubagentTitles(): void {
    if (this.subagentTitlesTimer !== undefined) clearTimeout(this.subagentTitlesTimer);
    this.subagentTitlesTimer = setTimeout(() => {
      this.subagentTitlesTimer = undefined;
      void this.refreshSubagentTitles();
    }, SUBAGENT_TITLES_DEBOUNCE_MS);
  }

  /**
   * 目录变了就下发（唯一的列表帧，见 `shared/ipc.ts`）。
   *
   * 同时把**父目录快照**同步进正在看这个会话子代理的窗口（子代理上下文的数据，
   * 见 `syncSubagentContext`）——目录的三条来源（事件 / 投影 / RPC）都汇到
   * `deliverSubagentList`，这里就是唯一的扇出点。
   *
   * 下发的每一行都过一遍 `resolveSubagentDisplay`：目录里缺 label 的行在这一刻拿到
   * 会话标题，而不是永远停在 uuid。顺序也在这里统一（`orderedCatalog`）——父会话域的
   * 目录与子代理页的父目录快照都读它，两处看到的先后才是同一个。
   */
  private deliverSubagentList(scope: SessionScope): void {
    this.deliver(scope.sessionId, {
      type: "subagents/list",
      entries: this.orderedCatalog(scope.subagentEntries).map((entry) => this.resolveSubagentDisplay(entry)),
    });
    this.syncSubagentContext(scope.sessionId);
    // 目录变了，整棵树也可能多 / 少节点或层级（标题清单与目录共用同一份血缘）
    this.redeliverSubagentTrees();
  }

  /**
   * 目录行的**下发顺序**（唯一的排序点，口径见 `subagentOrder.ts`）。
   *
   * 排序键是**现算**的，不写回目录：账本会随用户消息与收尾变化，写回的话目录的重放
   * （投影 / durable 事件 / 重连）会用旧顺序盖回去——与显示名「发帧那一刻现算」同一条
   * 纪律（见 `resolveSubagentDisplay`）。
   */
  private orderedCatalog(entries: readonly SubagentView[]): SubagentView[] {
    return orderSubagentEntries(entries, this.subagentActivityAt);
  }

  /**
   * 记一条**跨域血缘**（父子关系 + 画树要用的显示字段）。
   *
   * 与 `mergeSubagentEntries` 的区别：那里只维护「某个父会话自己的目录」，这里维护
   * 整棵树。两个来源缺的字段不同（`session/list` 有父链、事件 / 投影有 label 与
   * 创建时刻），所以是并入而不是覆盖：新来源没带的 label / createdAt 保留已知值。
   */
  private noteSubagentIndex(parentSessionId: string, entry: SubagentView): void {
    if (!parentSessionId || !entry.id || parentSessionId === entry.id) return;
    // 删除 / 归档是肯定证据：任何来路（含迟到的目录重放）都不能把这条重新画回树里。
    if (this.deletedSessionIds.has(entry.id) || this.archivedSessionIds.has(entry.id)) return;
    // 一条实时血缘事实到了：本份（或别的在途）完整列表不能再按「请求时它不在」裁掉它。
    for (const candidates of this.subagentIndexPruneCandidates) candidates.delete(entry.id);
    for (const candidates of this.subagentOrderPruneCandidates) candidates.delete(entry.id);
    const existing = this.subagentIndex.get(entry.id);
    const label = entry.label && entry.label !== entry.id ? entry.label : existing?.label;
    const createdAt = entry.createdAt ?? existing?.createdAt;
    this.subagentIndex.set(entry.id, {
      id: entry.id,
      parentSessionId,
      mode: entry.mode,
      ...(label ? { label } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
    });
  }

  /**
   * `session/list` 的原始行 → 血缘索引。
   *
   * 这是**跨进程 / 跨窗口**的权威来路：会话列表带 `parentSessionId` 与
   * `projections.values.subagent`（自身子代理身份），所以不必打开任何子代理会话
   * 就能知道多层树长什么样。显式不是子代理的行按「肯定证据」退掉索引；
   * 已删除 / 归档的行同样不画进树。
   *
   * @param pruneCandidates 这份请求**发出前**已有的索引 id（见
   *   `subagentIndexPruneCandidates`）。完整列表里缺席的那些才是被删 / 归档的候选；
   *   等待期间新注册的节点不在候选里，不会被旧父节点的缺席连带清掉。
   */
  private noteSubagentIndexFromList(
    items: readonly SessionSummaryWire[],
    pruneCandidates?: ReadonlySet<string>,
  ): void {
    const listed = new Set(items.map((item) => item.sessionId));
    for (const item of items) {
      const id = item.sessionId;
      if (this.deletedSessionIds.has(id) || this.archivedSessionIds.has(id)) {
        // 只有**索引里确实是子代理**的 id 才连带清理下级；顶层会话不在索引里，
        // 不能因为它的状态变化把无辜的下级一起删掉。同一条列表里的普通化 / 归档行
        // 也走候选裁剪，等待期间新登记的后代不被旧快照连带误删。
        this.pruneSubagentIndexAtList(id, pruneCandidates, listed);
        continue;
      }
      if (item.origin !== "subagent") {
        // 肯定证据：同一个 id 不可能是两种身份。目录可能先到、列表后到时才纠正；
        // 同样只处理索引里已经登记的 id（顶层会话不在索引里，迭代它的下级是误伤）
        this.pruneSubagentIndexAtList(id, pruneCandidates, listed);
        continue;
      }
      const parentSessionId = typeof item.parentSessionId === "string" && item.parentSessionId
        ? item.parentSessionId
        : this.subagentIndex.get(id)?.parentSessionId;
      if (!parentSessionId) continue;
      const identity = subagentIdentityFromProjection(item.projections?.values?.subagent);
      const existing = this.subagentIndex.get(id);
      this.noteSubagentIndex(parentSessionId, {
        id,
        label: identity?.label ?? existing?.label ?? id,
        mode: identity?.mode ?? existing?.mode ?? "one-shot",
      });
    }
    if (!pruneCandidates) return;
    // 完整列表是索引生命周期的权威：请求前已知、这次整份缺席、等待期间也没有新事实
    // 的节点退掉。候选在实时事实到达时已被摘除（见 `noteSubagentIndex`），所以这里
    // 只处理真正「一直没再出现」的那些。
    for (const id of [...pruneCandidates]) {
      if (listed.has(id)) continue;
      this.pruneSubagentIndexAtList(id, pruneCandidates, listed);
    }
  }

  /**
   * 列表驱动的删除入口：有候选集时按候选裁剪（保护等待期新事实），没有时退回递归删除。
   *
   * 列表是旧快照时，显式「普通 / 归档 / 缺席」也只能作废旧快照里已知的那一支；
   * 等待期间另一路登记进来的新后代理应作为更新事实保留，交给下一次列表或实时事实收敛。
   */
  private pruneSubagentIndexAtList(
    sessionId: string,
    candidates: ReadonlySet<string> | undefined,
    listed: ReadonlySet<string>,
  ): void {
    if (!this.subagentIndex.has(sessionId)) return;
    if (!candidates) {
      this.forgetSubagentIndex(sessionId);
      return;
    }
    // 等待期间这一条本身已收到新事实（catalog / status 等）→ 已从候选摘除：
    // 旧列表的普通 / 归档 / 缺席结论不能删掉它（不只是保护它的后代）。
    if (!candidates.has(sessionId)) return;
    this.pruneSubagentIndexBranch(sessionId, candidates, listed);
  }

  /**
   * 缺席裁剪：只删**候选**里的节点。
   *
   * 递归到下级时只碰同一份请求发出前就已知、且这次也缺席的候选；等待期间新注册的
   * 后代（例如旧父节点正在被清时另一路 catalog 刚登记的子代理）留着——它的父链
   * 随后由下一份完整列表或实时事实收敛，不能在这里被旧快照连带误杀。
   */
  private pruneSubagentIndexBranch(
    sessionId: string,
    candidates: ReadonlySet<string>,
    listed: ReadonlySet<string>,
  ): void {
    if (!this.subagentIndex.has(sessionId)) return;
    this.subagentIndex.delete(sessionId);
    for (const entry of [...this.subagentIndex.values()]) {
      if (entry.parentSessionId !== sessionId) continue;
      if (listed.has(entry.id) || !candidates.has(entry.id)) continue;
      this.pruneSubagentIndexBranch(entry.id, candidates, listed);
    }
  }

  /** 退掉一条子代理及其所有下级（删除 / 归档 / 列表明确说它不再是子代理）。 */
  private forgetSubagentIndex(sessionId: string): void {
    const queue = [sessionId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      this.subagentIndex.delete(id);
      for (const entry of this.subagentIndex.values()) {
        if (entry.parentSessionId === id) queue.push(entry.id);
      }
    }
  }

  /**
   * 索引行 → 目录行（`activity` / `unread` 由宿主账本补齐）。
   *
   * 显示名走与目录行同一个解析点 `resolveSubagentDisplay`（真 label → 打开着的描述符 /
   * 会话标题 → 标题账本 → id），**发帧时现算**：索引只存真 label，回退标题不写回，
   * 否则后续标题变化会被旧值挡住。
   */
  private subagentRowOfIndex(entry: IndexedSubagent): SubagentView {
    const activity = this.knownSubagentActivity(entry.id);
    return this.resolveSubagentDisplay({
      id: entry.id,
      label: entry.label ?? entry.id,
      mode: entry.mode,
      ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
      ...(activity ? { activity } : {}),
      unread: this.unreadSessionIds.has(entry.id),
    });
  }

  /**
   * 某一级子代理的**直接下级**（已按判定时间排序）。
   *
   * 树与切换清单共用它：顺序口径只能有一处（见 `subagentOrder.ts`）。
   */
  private subagentChildrenOf(parentId: string): SubagentView[] {
    const rows: SubagentView[] = [];
    for (const entry of this.subagentIndex.values()) {
      if (entry.parentSessionId !== parentId) continue;
      if (this.deletedSessionIds.has(entry.id) || this.archivedSessionIds.has(entry.id)) continue;
      rows.push(this.subagentRowOfIndex(entry));
    }
    return orderSubagentEntries(rows, this.subagentActivityAt);
  }

  /** 从当前会话往上找顶层祖先；父链缺失时退回子代理地址里的直接父会话。 */
  private subagentRootId(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = this.subagentIndex.get(current)?.parentSessionId
        ?? this.scopes.get(current)?.subagentAddress?.parentSessionId;
      if (!parent || parent === current) break;
      current = parent;
    }
    return current;
  }

  /**
   * 当前窗口所在会话的**子代理树**（顶层会话 + 先序扁平节点）。
   *
   * 普通会话没有任何子代理、自己也不是子代理时返回 `undefined`（标题不变成可点，
   * 界面上也不占位）。正在看子代理时至少要含它自己——恢复路径直接落到子代理页时，
   * 上层目录可能还没从列表回来，`ensureScope` 已把它的地址记进索引，树因此画得出来。
   *
   * 这里是**纯读**：地址在建域 / 对齐时（`ensureScope`）登记，不能每次读树再把
   * `subagentAddress` 写回索引——否则被完整列表确认删除的节点会立刻复活，读树本身
   * 还会变成在途裁剪的假「实时证据」。
   */
  private subagentTreeOf(scope: SessionScope | undefined): SubagentTreeView | undefined {
    if (!scope) return undefined;
    const rootId = this.subagentRootId(scope.sessionId);
    const summary = this.sessions.find((session) => session.id === rootId);
    const rootScope = this.scopes.get(rootId);
    const title = summary?.title
      || (rootScope ? this.subagentDisplayName(rootScope) : undefined)
      || this.subagentTitles.get(rootId)
      || rootId;
    const tree = buildSubagentTree({
      root: {
        id: rootId,
        title,
        running: rootScope?.running ?? summary?.running ?? this.subagentRunning.get(rootId) ?? false,
      },
      childrenOf: (parentId) => this.subagentChildrenOf(parentId),
    });
    if (!tree.nodes.length && !scope.subagentAddress) return undefined;
    return tree;
  }

  /** 只带 `subagentTree` 的补丁（不碰目录 / 上下文，避免白算一遍兄弟快照）。 */
  private subagentTreePatch(scope: SessionScope) {
    return sessionPatch({ subagentTree: () => this.subagentTreeOf(scope) }, ["subagentTree"]);
  }

  /** 树变了：把新的树推给**每个已绑定窗口**（同一棵树下的不同子代理页都要看到）。 */
  private redeliverSubagentTrees(): void {
    for (const [viewId, sessionId] of this.viewSessions) {
      const scope = this.scopes.get(sessionId);
      if (!scope) continue;
      this.emitToView(viewId, { type: "patch", patch: this.subagentTreePatch(scope) });
    }
  }

  /**
   * 记一条子代理的判定时间（取新，旧值不回退）。
   *
   * @returns 有没有真的变新——只有变新才重推目录（同一条 `session/list` 反复来不该白推帧）。
   */
  private noteSubagentTime(sessionId: string, at: number): boolean {
    if (!Number.isFinite(at) || at <= 0) return false;
    const known = this.subagentActivityAt.get(sessionId) ?? 0;
    if (at <= known) return false;
    this.subagentActivityAt.set(sessionId, at);
    return true;
  }

  /**
   * `session/list` 的原始行 → 判定时间账本（**用户消息**那一半）。
   *
   * 完整原始列表是生命周期的权威：消失、变普通、已删除或归档的 id 从排序与待结算账本退掉。
   * 行的 `updatedAt` 是服务端算的 `max(createdAt, lastPromptAt)`，也就是「最后一条人类
   * 消息」——agent 的产出不改它，正合判定条目的口径。
   *
   * @returns 真的变新的会话 id（账本变了才重推目录，见 `redeliverSubagentRows`）。
   */
  private noteSubagentTimes(items: readonly SessionSummaryWire[], pruneCandidates: ReadonlySet<string>): Set<string> {
    const changed = new Set<string>();
    const retained = new Set(items.filter((item) => item.origin === "subagent"
      && !this.deletedSessionIds.has(item.sessionId) && !this.archivedSessionIds.has(item.sessionId))
      .map((item) => item.sessionId));
    for (const id of pruneCandidates) {
      if (retained.has(id)) continue;
      if (this.subagentActivityAt.has(id)) changed.add(id);
      this.clearSubagentOrder(id);
    }
    for (const item of items) {
      if (!retained.has(item.sessionId)) continue;
      if (typeof item.updatedAt === "number" && this.noteSubagentTime(item.sessionId, item.updatedAt)) {
        changed.add(item.sessionId);
      }
    }
    return changed;
  }

  /** 只给排序账本提供请求前的清理候选，旧快照不能抹掉等待期间亲历的实时证据。 */
  private async listSessionsForSubagentOrder(client: DshClient) {
    const generation = this.subagentOrderGeneration;
    const requestSeq = (this.subagentListSeq += 1);
    const pruneCandidates = new Set([...this.subagentActivityAt.keys(), ...this.subagentSettlementsPending]);
    // 血缘索引与排序账本吃同一份完整列表：索引也记下「请求前已有」的候选，等待期间
    // 新注册 / 更新的节点由 `noteSubagentIndex` 从候选里摘掉（见 `subagentIndexPruneCandidates`）。
    const indexCandidates = new Set(this.subagentIndex.keys());
    this.subagentOrderPruneCandidates.add(pruneCandidates);
    this.subagentIndexPruneCandidates.add(indexCandidates);
    try {
      const value = await client.listSessions();
      const items = value.items ?? [];
      // 连接已换代，或**比已采纳的完整列表更旧**（同一连接的并发请求）：整份丢弃。
      // 两个调用者都据此拒收，标题 / running / 索引都不会被旧快照污染。
      const applied = generation === this.subagentOrderGeneration && requestSeq > this.subagentListAppliedSeq;
      let activityChanges = new Set<string>();
      if (applied) {
        // 同一段同步续体内先结算再注销候选，避免返回调用者的 await 空档漏掉实时更新。
        activityChanges = this.noteSubagentTimes(items, pruneCandidates);
        // 索引裁剪也在候选仍登记时完成：候选只有在响应到达的同一段同步代码里才可信。
        this.noteSubagentIndexFromList(items, indexCandidates);
        this.subagentListAppliedSeq = requestSeq;
      }
      return { value, generation, requestSeq, activityChanges, applied };
    } finally {
      this.subagentOrderPruneCandidates.delete(pruneCandidates);
      this.subagentIndexPruneCandidates.delete(indexCandidates);
    }
  }

  /** 清理新增排序账本；不跟父域销毁绑定，以保留进出子代理的排序契约。 */
  private clearSubagentOrder(sessionId: string): void {
    this.subagentActivityAt.delete(sessionId);
    this.subagentSettlementsPending.delete(sessionId);
  }

  /**
   * 子代理行的「用户已读」变了 → 就地覆盖已下发的目录行并重发。
   *
   * 这一位没有别的帧会顺带带上（目录的三条来源都没有它），所以不在这里补一发，界面就会
   * 停在旧文案上（已完成 ↔ 可继续 / 一次性）直到下一次目录刷新。
   *
   * 两处都要盖：**父会话域**的目录（普通会话的清单）与子代理域手里那份**父目录快照**
   * （`subagentSiblings`——父域已被回收时，子代理上下文读的就是它）。
   */
  private syncSubagentUnread(childSessionId: string, unread: boolean): void {
    let treeChanged = false;
    let listDelivered = false;
    for (const scope of this.scopes.values()) {
      const own = withSubagentUnread(scope.subagentEntries, childSessionId, unread);
      if (own.changed) {
        scope.subagentEntries = own.entries;
        // 唯一的扇出点：连正在看它子代理的窗口一起通知（见 `deliverSubagentList`）
        this.deliverSubagentList(scope);
        listDelivered = true;
        continue;
      }
      const siblings = withSubagentUnread(scope.subagentSiblings, childSessionId, unread);
      if (!siblings.changed) continue;
      scope.subagentSiblings = siblings.entries;
      treeChanged = true;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["subagent", "subagentTree"]),
      });
    }
    // 纯索引里的孙代（没有任何打开域的目录 / 父目录快照包含它）也必须收到新树：
    // 它的 unread 只由 `subagentRowOfIndex` 现算，没有别的帧会顺带带上。
    // 已经走过 `deliverSubagentList` 的域在那一帧里带的就是最新树，不重复发。
    if (!listDelivered && (treeChanged || this.subagentIndex.has(childSessionId))) {
      this.redeliverSubagentTrees();
    }
  }

  /**
   * 目标条。投影是**嵌套**的、轮次计数在外层（见 `projections.goalFromProjection`）。
   * 以前按扁平形状读，两个字段都取不到，于是 goal 恒被清空、目标条从未渲染
   * （`docs/design-projections.md`）。键不存在 → 清空目标条。
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

  // ---------- 自动化任务（DSH schedule） ----------

  /**
   * 读一次自动化任务目录，按**本会话**过滤后落进域。
   *
   * 为什么要全局目录而不是 `schedule/list`：`list` 只回当前会话的**活跃**任务，于是
   * 一条一次性任务投递完就从这个面板里消失了（它变成 `inactive`），用户再也看不到、
   * 也删不掉它。目录同时带回 `status` 与最近一次投递，正是「跑完的还在不在」要的信息。
   *
   * `silent` 是给「后台刷新」（`schedule/changed` 广播、socket 重连）用的：那时**不动**
   * `schedulesStatus`，界面停在已读到的内容上，刷新失败也不把面板打回空态。
   *
   * 两条在途纪律与 `refreshSubagentCatalog` 同款：域可能已经被回收（或客户端被换掉），
   * 迟到的响应不许写进别人的域。
   */
  private async loadSchedules(scope: SessionScope, silent = false): Promise<void> {
    const client = this.client;
    if (!client) {
      // 没连上：这不是「没有任务」也不是「服务端不支持」。把状态落成 `error`，
      // 面板如实说「读取失败」；`schedulesWanted` 让断线重连后自动补读一次。
      if (!silent) {
        scope.schedulesStatus = "error";
        this.deliver(scope.sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(scope), ["schedulesStatus"]),
        });
      }
      return;
    }
    if (!silent) {
      scope.schedulesStatus = "loading";
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["schedulesStatus"]),
      });
    }
    let value: unknown;
    try {
      value = await client.scheduleCatalog();
    } catch (error) {
      if (this.scopes.get(scope.sessionId) !== scope || this.client !== client) return;
      // 端点不存在 = 这个部署没有自动化任务能力（≤ 0.1.7-rc.1）：这是一个**结论**，
      // 与「这次没拿到」不同，界面据此显示能力缺失而不是空态。其余失败保留下一次机会。
      if (endpointAbsent(error)) {
        scope.schedulesStatus = "unsupported";
        scope.schedules = [];
        scope.scheduleExpected.clear();
        this.log(`[schedule] 这个服务端没有 schedule 端点（会话=${scope.sessionId}）：${this.describeError(error)}`);
      } else if (!silent) {
        scope.schedulesStatus = "error";
        this.log(`[schedule] 目录读取失败（会话=${scope.sessionId}）：${this.describeError(error)}`);
      } else {
        // 后台刷新（预取 / 广播 / 重连）失败：**保留上次读到的那份**，连状态也不动——
        // 一次网络抖动不该把「已读到 3 条」改写成「读取失败」，更不该让入口的指示灯
        // 因为一次失败就熄掉（那是替一次没落定的读取下结论）。
        this.log(`[schedule] 后台刷新失败，保留上次结果（会话=${scope.sessionId}）：${this.describeError(error)}`);
        return;
      }
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["schedules", "schedulesStatus"]),
      });
      return;
    }
    if (this.scopes.get(scope.sessionId) !== scope || this.client !== client) return;
    const entries = scheduleEntriesFromCatalog(value).filter((entry) => entry.item.sessionId === scope.sessionId);
    scope.schedules = entries.map((entry) => entry.item);
    scope.scheduleExpected.clear();
    for (const entry of entries) {
      if (entry.expected) scope.scheduleExpected.set(entry.item.id, entry.expected);
    }
    scope.schedulesStatus = "ready";
    this.log(
      `[schedule] 本会话自动化任务 ${scope.schedules.length} 条（会话=${scope.sessionId}` +
        `${silent ? "，后台刷新" : ""}）`,
    );
    this.deliver(scope.sessionId, {
      type: "patch",
      patch: sessionPatch(this.sessionSource(scope), ["schedules", "schedulesStatus"]),
    });
  }

  /**
   * 回一页执行记录。
   *
   * **每条请求都要回帧**（连不上 / 没绑定会话 / 服务端拒绝都算）：详情区的「正在读取」
   * 只认这一帧收场。三种「没有记录」分开表达，见 `shared/ipc.ts` 的帧注释。
   */
  private async sendScheduleHistory(
    viewId: string,
    scope: SessionScope | undefined,
    id: string,
    before: string | undefined,
  ): Promise<void> {
    const mode = before === undefined ? "replace" : "append";
    const client = this.client;
    if (!client || !scope) {
      this.emitToView(viewId, {
        type: "schedules/history",
        id,
        mode,
        records: [],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        hostUnavailable: true,
      });
      return;
    }
    // 任务的**原始绑定**才是这条读取的会话（契约要求 `{sessionId, id}`）：目录里
    // 那一条带着它，拿当前窗口绑的会话去问在跨会话的场景下会查不到（`schedule_not_found`）。
    const binding = scope.schedules.find((entry) => entry.id === id)?.sessionId ?? scope.sessionId;
    try {
      const value = await client.scheduleHistory(binding, id, SCHEDULE_HISTORY_PAGE, before);
      const page = scheduleHistoryFromWire(value);
      if (!page) {
        this.emitToView(viewId, {
          type: "schedules/history",
          id,
          mode,
          records: [],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
          error: "schedule/history: 认不出的响应",
        });
        return;
      }
      this.emitToView(viewId, {
        type: "schedules/history",
        id,
        mode,
        records: page.records,
        nextBefore: page.nextBefore,
        earlierRecordsUnavailable: page.earlierRecordsUnavailable,
        earlierRecordsPruned: page.earlierRecordsPruned,
        retention: page.retention,
        code: page.code,
      });
    } catch (error) {
      this.log(`[schedule] 执行记录读取失败（id=${id}）：${this.describeError(error)}`);
      this.emitToView(viewId, {
        type: "schedules/history",
        id,
        mode,
        records: [],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        error: this.describeError(error),
      });
    }
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
      // 自动化任务集变了（另一个窗口改了时间、删了任务，或某个任务到点投递后状态
      // 变了）：只刷新**已经读过**的会话域。从没打开过面板的会话不因此多打一次 RPC，
      // 它下次打开时会现读一次（`listSchedules`）。
      if (frame.event === SCHEDULE_CHANGED_EVENT) {
        for (const scope of this.scopes.values()) {
          // `unsupported` 不在此列：那个部署根本没有这条广播的来源，真收到也只说明
          // 结论过期，等用户下次打开面板现读即可（不为一个已判定的缺失反复打请求）。
          if (scope.schedulesWanted && scope.schedulesStatus !== "unsupported") void this.loadSchedules(scope, true);
        }
        return;
      }
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
        // 记下「这个窗口的页面已经就绪」：认领可能比 `ready` 更晚才落下，那一刻要回来
        // 叫醒它（见 `flushRestoreClaims`）
        this.readyViews.add(viewId);
        // 新页面：界面的「复制失败请求号」从头开始，宿主那份水位跟着清掉
        // （否则新页面的第一次失败会被当成旧号重复投递而丢掉）
        this.copyFailureWatermarks.delete(viewId);
        // 首帧快照**先行**：locale/字号等外观设置全在里面。接回会话要先等激活期那次自动
        // 连接（`awaitActivationConnect`）——整个连接期间快照都出不去，界面只能停在词典
        // 缺省（英文）上，直到连接结算才翻成中文（用户报的「启动总是先英文」）。
        // 能收到 `ready` 就说明 webview 的监听已挂上，此刻推帧不会丢。
        this.emitToView(viewId, { type: "state", state: this.snapshotFor(viewId) });
        // 这个窗口在就绪之前收到的开面板指令（命令面板入口可能比页面加载更早按下）：
        // 放在快照**之后**补发，抽屉打开时界面已经有全量状态了。
        // 「没有任何窗口」时那条通知意图（`pendingNotificationsOpen`）**只由主侧栏消费**：
        // 那一刻 VS Code 可能同时把编辑区面板恢复起来，谁先 ready 就把抽屉开到谁上面是错的
        // （用户按的是主侧栏那个入口）；secondary / panel 的 ready 不消费、也不清除它。
        const consumeGlobal = this.pendingNotificationsOpen && this.viewKinds.get(viewId) === "primary";
        const pendingPanel = consumeGlobal ? "notifications" : this.pendingPanelOpens.get(viewId);
        if (consumeGlobal) {
          this.pendingNotificationsOpen = false;
          this.log(`[notify] 主侧栏 ${viewId} 就绪，补发待开的通知抽屉`);
        }
        if (pendingPanel !== undefined) {
          this.pendingPanelOpens.delete(viewId);
          this.emitToView(viewId, { type: "ui/openPanel", panel: pendingPanel });
        }
        // 然后接回「这个窗口上次开着哪个会话」：绑上后 `openSession` 会再推一份
        // 带会话内容的完整快照，内容照常回填。`resumeRestoreHint` 幂等，兜底
        // 定时器先到也只是空跑一次。
        await this.resumeRestoreHint(viewId);
        // 这一轮恢复还没结算（认领还排着队，`resumeRestoreHint` 因此空跑）→ **不许**
        // 先落一条空壳：认领落下时 `flushRestoreClaims` 会回来叫醒接回。在这里抢跑
        // 只会得到「空壳先出现、历史会话随后接回来」的反序。
        if (this.hasRestorePending(viewId)) break;
        // 恢复不出会话（新开的窗口，或缓存里那条已经不在了）→ 落到本工作区那条空壳上
        // （官方口径：打开一个工作区就有一条 blank 会话）。这是**自动路径**：只消费激活期
        // 那一次自动连接（`start: false`），既不起后台、也不自己发起连接——聊天页面重载一次
        // 不该把用户刚停掉的后台又拉起来（用户 2026-10-18 口径）。那一次没连上时窗口就停在
        // 按钮态等用户点，而连接落地后 `onConnected` 会回来补这条空壳。
        await this.ensureSession(viewId, { start: false, askDir: false });
        break;

      case "acknowledgeNotification":
        this.acknowledgeNotification(viewId, message.id, message.count);
        break;

      case "reportImageCopyFailure": {
        // 界面本地复制图片失败（`webview/imageClipboard.ts`）：界面自己不知道宿主那份
        // 通知队列，这一帧就是它的入队入口。
        //
        // 逐字段验形状 + **归属必须与这个窗口此刻绑定的会话一致**：复制是耗时动作，
        // 发起后用户可以切走，迟到的失败不该画进新会话；也不信任任意 sessionId
        // （`undefined` 只在空态窗口成立，那时入的是共享通知）。
        const requestId = message.requestId;
        if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId <= 0) break;
        // 归属必须与这个窗口此刻绑定的会话一致：**先验归属、再动水位**——顺序反了的话，
        // 一条跨会话的畸形高号帧会把水位顶高，之后这个窗口所有合法的失败报告都被当旧号拒掉。
        // （`undefined` 只在空态窗口成立，那时入的是共享通知。）
        const bound = this.viewSessions.get(viewId);
        if (message.sessionId !== bound) break;
        // 每窗口一个**独立**的请求号水位（与 durable `seq` 的水位是两回事，不能混用）：
        // 重复投递同一号是空操作，真实的第二次复制会带更大的号。
        // 水位在 `ready`（页面重建、界面的计数器从头开始）与窗口下线时清掉。
        const watermark = this.copyFailureWatermarks.get(viewId);
        if (watermark !== undefined && requestId <= watermark) break;
        this.copyFailureWatermarks.set(viewId, requestId);
        this.notify({ sessionId: bound, level: "warn", kind: "imageCopy", text: "@imageCopyFailed" });
        break;
      }

      case "send": {
        // 附件取**宿主账本**里那一份（界面那份只是它的投影）：帧里不再回传副本——
        // 图片附件的 `dataUrl` 有几 MB，回传等于让它从 webview 再走一趟单程。
        // 取的时刻早于 `beginSend` 里的 `commitAttachments`（那一步把芯片移进租约），
        // 所以这里拿到的是用户此刻看到的那一批。
        const key = this.keyForView(viewId);
        const attachments = [...this.attachments.list(key)];
        // **宿主兜底**：文件还没传完 / 传失败时不许提交。界面按钮已经拦了一次，
        // 这里防的是新入口漏判、投影漂移与夹具 / 旧协议直发 `send`。命中时不建回显、
        // 不动芯片，把宿主账本里的草稿原样重新镜像一帧——界面在按下发送那一刻已经
        // 清掉了自己的输入框，不推回去就等于吞掉用户那句话。命中即 bug 信号，只记日志，
        // 不弹原生错误（用户原位看得到上传状态）。
        const block = attachmentUploadBlock(attachments);
        if (block !== undefined) {
          this.log(`[send] 文件附件未就绪（${block}），拒绝提交：窗口=${viewId}`);
          this.emitToView(viewId, {
            type: "patch",
            patch: {
              draft: this.drafts.get(key) ?? message.text,
              attachments: withoutAttachmentDataUrls(attachments),
            },
          });
          break;
        }
        await this.submitMessage(
          viewId,
          message.text,
          attachments,
          message.gesture ?? "enter",
          "composer",
        );
        break;
      }

      case "retractPending": {
        // 撤回 = 把那一行删掉（不把正文塞回输入框：用户口径 2026-09-25）。
        // 只认这个窗口自己那份账本：别的会话的 id 就算撞上了也不许动（见 `echoOfView`）
        if (!this.echoOfView(viewId, message.requestId)) break;
        this.retireEcho(message.requestId, "user-retract");
        // 撤回是这条提交的**最终收场**：它的附件租约跟着释放（字节与在飞轮次一起收）。
        // 记录也一并标成收场——用户明确丢掉了这一条，此后即使服务端还回一条「受理了
        // 却没落盘」，也不许把正文再塞回输入框（那等于撤回后又变出来）
        this.attachments.releaseLease(message.requestId);
        this.settleSubmissionRecord(message.requestId);
        break;
      }

      case "resendPending": {
        // 重发 = 先撤回，再按普通发送重走一遍（同一个入口，两条路的行为不可能漂）。
        // 撤回**不推帧**：紧接着的 `submitMessage` 会推一份带最终状态的（否则中间那一帧
        // 两行都不在，界面上就是重发时闪一下）。
        const echo = this.echoOfView(viewId, message.requestId);
        if (!echo) break;
        this.removeEcho(message.requestId, "user-resend");
        // 旧那次提交到此收场：租约交给新 requestId 继续持有（`handoffLeaseFrom`），
        // 而旧记录标成收场——旧 rpcId 的「没落盘」回执不许再把这同一段正文还回输入框
        // （新那一次已经把内容带走了，还回去就是凭空多一份）
        this.settleSubmissionRecord(message.requestId);
        // 手势按主发送算：重发就是"再发一次"，不继承上一次的加速手势；
        // **来源是 `retry`**：这一段内容不是输入框里的那份，绝不能顺手清掉用户正在写的草稿。
        // 附件草稿走**租约交接**（`handoffLeaseFrom`）：换到新提交的 requestId 上继续持有——
        // 不取消仍在飞的上传、不重启、也不放回输入框；重发再失败时新那一行同样持有它。
        await this.submitMessage(
          viewId,
          echo.text,
          echo.attachments,
          "enter",
          "retry",
          undefined,
          message.requestId,
        );
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

      case "unarchiveSession":
        await this.unarchiveSession(message.sessionId);
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
          // 连壳都还没有（没有工作目录，见 `viewModel` 的字段注释）：只把这次选择记成
          // 「落壳时要用的模型」，界面上立刻显示；建壳时它会落到域上，再由发送前的
          // `selectModel` 提交。
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
        // 立即更新胶囊显示（已经开始过对话的会话里，实际 selectModel 在下次发送前执行）
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
        // **空壳会话当场提交**（`session/selectModel`）：它说不上「本轮」，延迟到下次发送
        // 没有任何好处，反倒会把选择丢掉——走去别的会话再点「+」会**复用**这条还没用过的
        // 空壳（`reuseOrCreateBlank`），那一下域整个重建，只活在域上的 `pendingModel`
        // 到那时就没了，胶囊会莫名其妙地弹回部署默认。
        // （当前就停在它上面再点「+」是 no-op：什么都不做，这条壳连它记着的模型一起原样
        //   留着，见 `newSession`。）
        //
        // 服务端的 `selectForNextRequest` 本来就是「下一次请求生效」，写在壳上与官方
        // 客户端同一口径（模型是**会话**的属性，不是窗口的待建参数）。
        if (this.isBlankShell(scope.sessionId)) await this.applyPendingModel(scope);
        break;
      }

      case "setPermission": {
        const scope = this.scopeOfView(viewId);
        if (!scope) {
          // 连壳都还没有（没有工作目录，见 `viewPermission` 的字段注释）：把这次选择记成
          // 「落壳时要用的权限」，界面上立刻显示；与部署默认不同的那笔会在落壳后落实
          // （见 `reuseOrCreateBlank`）
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
        // 归属在**发起这一刻**捕获：命令是异步执行的，完成时窗口可能已经切走，
        // 那时再读绑定就会把别的会话的失败画到新会话上（用户 2026-10-18 口径）。
        const sessionId = this.viewSessions.get(viewId);
        const outcome = await this.runCommand(viewId, message.line);
        // 只有「压根没进处理器」才入队（红色）：执行过但结果是 error 的那种，适配器已经
        // 折成红色命令节点、原文就在正文里，再通知一次就是重复
        if (outcome?.unhandled === true) {
          this.notify({
            sessionId,
            level: "error",
            kind: "commandFailed",
            key: message.line,
            text: outcome.text ?? `@commandFailed:${message.line}`,
          });
        }
        break;
      }

      case "answerApproval": {
        const eventId = message.requestId;
        if (!eventId) break;
        // 结算掉：这条请求不再需要回放（见 `interactions` 的注释）。答复照旧先回 Host
        // ——`settle` 拿到的是那条记录（含会话 id），据此把卡片从对的域里摘掉。
        const settled = this.interactions.settle(eventId);
        await this.replyEvent(eventId, {
          kind: "result",
          value: message.approved ? "allowed-once" : "rejected",
        });
        const scope = settled ? this.scopes.get(settled.sessionId) : undefined;
        // 允许 / 拒绝在看得到的层面上没有差别：卡片整段摘掉（见 `dropApprovalCard`）
        scope?.adapter?.dropApprovalCard(eventId);
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
          // 字节通道自己就能完整处理这一批时**不必去要真路径**。四个条件全满足才跳过：
          // 真的读到了东西（不是空批）、没有任何读不出来的（复制目录给的 0 字节条目就在
          // `unreadable` 里）、没有超 8 MB 的、而且每一枚都是图片。图片走路径通道与走字节
          // 通道的结果相同（都内联成内容块、芯片名都取 basename），跳过不改变归宿；而那次
          // 查询要付一次 PowerShell 进程启动（7 约 0.4 秒、5.1 约 1.3 秒，见
          // `clipboardPaths.ts`），它正卡在「粘贴 → 芯片出现」的路径上——粘截图是最常见的
          // 那条路。有任何一枚可能损失（读不出 / 超限 = 只有路径通道兜得住）就照旧去问。
          const bytesAreEnough =
            message.files.length > 0 &&
            message.unreadable.length === 0 &&
            message.tooLarge.length === 0 &&
            message.files.every(
              (file) => imageMediaTypeForEntry(file.mimeType, file.name) !== undefined,
            );
          const clipboardPaths =
            message.source === "paste" && !bytesAreEnough ? await readClipboardPaths() : [];
          if (clipboardPaths.length) {
            this.log(`[attach] 粘贴：系统剪贴板里有 ${clipboardPaths.length} 个路径`);
            await this.addPaths(viewId, clipboardPaths, "paste");
            break;
          }
          // 读不到路径就退回字节通道（截图、非 Windows、剪贴板被占、shell 缺失都是这条）。
          // 这条日志是排查「粘贴大文件为什么被 8 MB 挡住 / 目录为什么成了 0 字节条目」的
          // 唯一线索——没有它只能看出「走了字节通道」，看不出为什么没走路径
          if (message.source === "paste") this.log("[attach] 粘贴：系统剪贴板里没有可用路径，走字节通道");
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

      case "revealPath": {
        // 目录引用（用户消息里的 `@目录`）：解析口径与 openFile 完全一致
        // （引用上原样拼写 + 会话工作目录），只是动作换成 VS Code 自己的「在资源管理器
        // 中展开」。不复用 openFile——那条路是开文件，拿目录去开会报「文件不存在」。
        await this.revealPath(viewId, message.path);
        break;
      }

      case "openAttachment": {
        await this.openAttachment(viewId, message);
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
        // 保存成功**不发通知**（与「复制成功不入队」同一条口径：结果在界面上就能感知
        // ——路径是用户自己选的）；取不到字节 / 写盘失败才入队（黄色：局部操作失败）。
        // 归属在**发起这一刻**捕获：保存要等用户选路径，期间用户可以切走。
        const sessionId = this.viewSessions.get(viewId);
        const scope = this.scopeOfView(viewId);
        const defaultDir =
          (scope ? this.cwdOf(scope) : undefined) ??
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
          homedir();
        const result = await saveChatImage(message.src, message.name, defaultDir);
        if (result.status === "failed") {
          this.log(`[image] 保存失败：${result.reason}`);
          this.notify({ sessionId, level: "warn", kind: "imageSaveFailed", text: "@imageSaveFailed" });
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

      case "listSchedules": {
        // 面板打开（或用户手动刷新）：读一次目录。没绑定会话就没有可读的东西——
        // 界面那边此时整条面板都是空态，不必回任何帧。
        const scope = this.scopeOfView(viewId);
        this.log(`[schedule] 面板打开：读取会话=${scope?.sessionId ?? "无"} 的自动化任务`);
        if (scope) {
          // 「有人在等这份数据」：断线重连后要补读的正是这些域（见 `onConnected`）
          scope.schedulesWanted = true;
          await this.loadSchedules(scope);
        }
        break;
      }

      case "scheduleHistory":
        await this.sendScheduleHistory(viewId, this.scopeOfView(viewId), message.id, message.before);
        break;

      case "updateSchedule": {
        // 运行时间编辑（比较并交换）。**每条路都要回 `schedules/result`**：界面的
        // 「正在保存」只认这一帧收场。`expected` 与原始会话绑定都取自读取时留下的
        // 原文——界面那份视图模型已经丢掉了原始拼写（见 `scope.scheduleExpected`）。
        const scope = this.scopeOfView(viewId);
        const expected = scope?.scheduleExpected.get(message.id);
        const item = scope?.schedules.find((entry) => entry.id === message.id);
        if (!this.client || !scope || !expected || !item) {
          this.log(
            `[schedule] 修改没法发出：${this.client ? "" : "未连接"}${
              scope ? (expected ? (item ? "" : "，名册里已没有这一条") : "，没有可用的比较基准") : "没有绑定会话"
            }（id=${message.id}）`,
          );
          this.emitToView(viewId, {
            type: "schedules/result",
            op: "update",
            id: message.id,
            ok: false,
            // 名册里已经没有这一条 → 任务不存在；名册里有、但基准读不出来（词表外的
            // 种类 / 缺字段）→ 按冲突报：界面会说「重新打开详情再改」，而重读一次
            // 正是能拿到可用基准的那条路。
            code: scope === undefined ? undefined : item === undefined ? "schedule_not_found" : "schedule_conflict",
          });
          break;
        }
        try {
          const value = await this.client.scheduleUpdate(
            item.sessionId,
            message.id,
            expected,
            message.change,
          );
          const outcome = scheduleUpdateOutcome(value);
          this.log(
            `[schedule] 修改${outcome.ok ? "已提交" : "未生效"}（id=${message.id}` +
              `${outcome.code ? `，code=${outcome.code}` : ""}）`,
          );
          this.emitToView(viewId, {
            type: "schedules/result",
            op: "update",
            id: message.id,
            ok: outcome.ok,
            code: outcome.code,
          });
          // 成功要读回权威值（重锚后的目标时刻只有服务端算得出）；没生效的三种
          // 「基准过期」类也要重读，否则用户会拿着同一份过期基准反复撞冲突。
          if (outcome.ok || outcome.code === "schedule_conflict" || outcome.code === "schedule_ended" || outcome.code === "schedule_not_found") {
            void this.loadSchedules(scope, true);
          }
        } catch (error) {
          this.log(`[schedule] 修改请求失败（id=${message.id}）：${this.describeError(error)}`);
          this.emitToView(viewId, { type: "schedules/result", op: "update", id: message.id, ok: false });
        }
        break;
      }

      case "deleteSchedule": {
        const scope = this.scopeOfView(viewId);
        const item = scope?.schedules.find((entry) => entry.id === message.id);
        if (!this.client || !scope || !item) {
          this.log(
            `[schedule] 删除没法发出：${this.client ? "" : "未连接"}${
              scope ? (item ? "" : "，名册里已没有这一条") : "没有绑定会话"
            }（id=${message.id}）`,
          );
          this.emitToView(viewId, {
            type: "schedules/result",
            op: "delete",
            id: message.id,
            ok: false,
            code: item ? undefined : "schedule_not_found",
          });
          break;
        }
        try {
          const value = await this.client.scheduleDelete(item.sessionId, message.id);
          const outcome = scheduleDeleteOutcome(value);
          this.log(
            `[schedule] 删除${outcome.ok ? "已完成" : "未生效"}（id=${message.id}` +
              `${outcome.code ? `，code=${outcome.code}` : ""}）`,
          );
          this.emitToView(viewId, {
            type: "schedules/result",
            op: "delete",
            id: message.id,
            ok: outcome.ok,
            code: outcome.code,
          });
          // 删掉了要读回权威值（列表里那一行才会消失）；「本来就没有」也读一次——
          // 那说明本地的名册已经过期，正好借这一下对齐。
          if (outcome.ok || outcome.code === "schedule_not_found") void this.loadSchedules(scope, true);
        } catch (error) {
          this.log(`[schedule] 删除请求失败（id=${message.id}）：${this.describeError(error)}`);
          this.emitToView(viewId, { type: "schedules/result", op: "delete", id: message.id, ok: false });
        }
        break;
      }

      case "listTrajectory":
        await this.sendTrajectory(viewId);
        break;

      case "listCommands":
        await this.listCommandsForView(viewId);
        break;

      case "queryFiles":
        await this.queryFiles(viewId, message.query, message.sessionOnly === true);
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

      case "openDesktop":
        await this.openDesktop();
        break;

      case "openInEditor": {
        // 「在编辑器中打开」：把这个窗口当前的会话带进编辑器窗口；
        // 未绑会话（空态）就不带，新窗口从空态起。
        //
        // 帧上带 `sessionId` 时开的是**那一条**（用户消息里的 `@会话` 引用走这条：
        // 用户 2026-10-10 口径是「开一个新标签页显示该会话」，而不是把当前窗口切过去
        // ——后者是 `openSession` 的行为，点引用就换掉当前窗口里的对话会很唐突）。
        //
        // 第二个参数是**来源窗口**：落点是哪个标签组由它决定（自己就在某个标签组里
        // 就开在同一组的新标签里，否则用活动分组），见 `ChatViewProvider.editorColumnFor`。
        const sessionForEditor = message.sessionId ?? this.viewSessions.get(viewId);
        this.log(`[openInEditor] 窗口=${viewId} 会话=${sessionForEditor ?? "（空态）"}`);
        await vscode.commands.executeCommand("dshChat.openInEditor", sessionForEditor, viewId);
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

      case "startDesktop":
        await this.startDesktop();
        break;

      case "connectDesktop":
        await this.connectDesktop();
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
    /** 「重发」专用：把上一行的附件租约交给这次提交继续持有（见 `beginSend`）。 */
    handoffLeaseFrom?: string,
  ): Promise<boolean> {
    const requestId = this.beginSend(viewId, text, attachments, source, handoffLeaseFrom);
    // 未连接时先恢复连接：历史会话切换后跟随流尚未建立时直接 prompt
    // 会触发服务端 resume，冷启动竞态下 resume 可能失败。
    // **用户显式动作**（按了发送）：允许拉起内部后台（关掉自动连接时也算数，
    // 用户口径 2026-09-18：`autoConnect` 只约束扩展自己的自动行为）
    if (!this.client || this.connection !== "connected") await this.ensureConnected({ start: true });
    if (!this.client) {
      if (!this.failEcho(requestId, "@sendNoConnection")) {
        this.appendDraft(viewId, text, attachments, requestId);
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
        this.appendDraft(viewId, text, attachments, requestId);
      }
      return false;
    }
    // 窗口还没有会话（空态）：落到本工作区那条空壳上（没有就建一条）。没有工作目录
    // 时会先问一次（取消 → 不建会话也不发送，草稿留在输入框里）
    let scope = this.scopeOfView(viewId);
    if (!scope) {
      scope = await this.ensureSession(viewId, { start: true, askDir: true });
    }
    if (!scope) {
      // 用户**主动取消**了目录选择：这不是"发送失败"，而是这条消息收回输入框
      // （唯一一条不回显失败态的路径——把用户自己的取消画成红框是误导）
      this.retireEcho(requestId, "workspace-cancelled");
      this.appendDraft(viewId, text, attachments, requestId);
      return false;
    }

    // 斜杠命令走命令通道，**不发给模型**：官方客户端的 enter 列把 `/xxx` 交给
    // `commands/execute`，宿主也明确「without sending it to the model」。
    // 以前只有 `/permission` 走命令通道，手打的 `/compact`、`/goal` 等一律当普通
    // 消息发给模型（docs/design-draft.md）。附带附件时仍按普通消息发：
    // 命令若不能带附件，服务端会拒绝，而用户此刻显然是想发这批内容。
    const slash = attachments.length === 0 ? this.slashCommandOf(scope, text) : undefined;
    if (slash) {
      // 草稿与附件已在 beginSend 里清掉（提交那一刻，早于建会话），这里只剩执行命令。
      // 回显要收回：命令不是用户消息，它的执行记录由命令节点承载。**这次提交到此收场**，
      // 附件租约（提交那一刻移走的那一份）跟着释放——命令不再引用它。
      this.retireEcho(requestId, "slash");
      this.attachments.releaseLease(requestId);
      const outcome = await this.runCommand(viewId, slash.line);
      // 同 `runCommand` 那条：只有未进处理器的命令才入队（红色）；
      // 执行过但 error 的结果由正文里的红色命令节点承接
      if (outcome?.unhandled === true) {
        // 归属是这个域（`scope` 在发送那一刻定下），不用「完成时视图绑定了谁」
        this.notify({
          sessionId: scope.sessionId,
          level: "error",
          kind: "commandFailed",
          key: slash.line,
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
        ...this.echoAnchorField(viewId),
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
        this.appendDraft(viewId, text, attachments, requestId);
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
    /**
     * 本次提交**有没有做过乐观置位**（`scope.running = true`）、置位那一刻域上的值，
     * 以及那一刻**权威 running 的版本号**。
     *
     * 三个变量都必须在 `try` 之外声明，失败收场（`catch`）才看得见（见那里的回滚判据）；
     * 但**赋值留在原来的位置**：`await applyPendingModel` 期间 durable 证据完全可能把
     * running 翻面，而提交模式（`resolveSubmitMode`）读的必须是「乐观置位那一刻」的值——
     * 提到 `try` 之前就会读到一个过期的值。版本号用来分辨「等待期间到达的权威结论」：
     * 权威在等待期间确认过运行状态（哪怕布尔值与乐观写入相同），失败收场就不得回滚它。
     */
    let optimistic = false;
    let wasRunning = false;
    let authorityAtSubmit = 0;
    try {
      // 发送前应用待生效的模型选择（切换即时生效于"下一轮"）
      await this.applyPendingModel(scope);
      // 草稿与附件在 beginSend 里已清（空态那一步清的是窗口键，绑定后由
      // `bindViewToSession` 迁到会话键）；这里按会话键复述一次，不依赖迁移链路的细节。
      // **只对输入框来源做**：重发 / 排队重发的内容不是输入框里那份，清它等于擦掉用户的草稿。
      // 附件这一次**并入同一个租约、不下发**：beginSend 那道移走已经把「空」推给界面了，
      // 这里防的是「共享空壳：别的窗口的芯片在迁移合并时并进来」，没有新变化可广播。
      if (source === "composer") {
        const key = this.keyForView(viewId);
        this.commitAttachments(viewId, requestId, { publish: false });
        this.drafts.set(key, "");
      }
      // 子代理会话不收文件附件（官方同一条硬规则：`subagent/attachment-invalid`，
      // 「subagent continuation does not accept files」）——有文件芯片就直接不发，
      // 把正文还回输入框让用户去掉附件再发，而不是让服务端拒绝一整轮。
      // （尚未发出的那条与子代理会话都**不回显**，所以这里没有能承载失败的那一行，
      // 沿用老口径：提示 + 回填。）
      const address = scope.subagentAddress;
      if (address && content.some((part) => part.type === "file")) {
        // 正文回填只是「东西还在输入框里」，没有说明**为什么**没发出去 —— 原因入队
        // （黄色：局部操作问题；用户 2026-10-18 口径：没有说清原因的原位反馈不算承接）
        this.notify({
          sessionId: scope.sessionId,
          level: "warn",
          kind: "subagentFilesUnsupported",
          text: "@subagentFilesUnsupported",
        });
        this.appendDraft(viewId, text, attachments, requestId);
        return false;
      }
      // **先**取「发出去的那一刻 agent 还在不在跑」，再乐观置位。顺序反了的话
      // `resolveSubmitMode` 里的 `!running` 这道门永远走不进去，空闲发消息也会带
      // `mode:"steer"`（审计确认的缺陷，见 resolveSubmitMode 的注释）。
      // 读到的这个值同时是失败收场的回滚基准（见 catch）：域上那个 `true` 是不是本次
      // 写的，由 `optimistic` 记着。
      wasRunning = scope.running;
      authorityAtSubmit = this.authorityVersion(scope);
      scope.running = true;
      optimistic = true;
      this.deliver(scope.sessionId, {
        type: "patch",
        patch: sessionPatch(this.sessionSource(scope), ["running"]),
      });
      // 队列「重新编辑」要还原用户**原始**输入，所以记的是拼引用之前的正文。
      // requestId 是 `beginSend` 铸的那一个：队列帧把同一个 id 作为 rpcId 带回，
      // 「重新编辑」凭它还原，乐观回显也凭它收回。
      this.rememberSubmission(requestId, text.trim(), content, attachments, scope.sessionId);
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
      // 这条会话收到人的消息了：空会话复用名册与本地那一行立刻跟上，别等下一次
      // `session/list`（那正是「新对话的首条消息落进上一个对话」的成因，见
      // `markSessionEngaged`）
      this.markSessionEngaged(scope.sessionId);
    } catch (error) {
      // 失败收场：**只回滚本次提交的乐观置位**，绝不覆盖已有的真实证据。
      //
      // 无条件置 `false`（改动前的写法）在「本轮真在跑」时是错的——`await prompt(...)`
      // 期间完全可能到了 durable 证据（`turn/start`）或权威值（`api-session/status`），
      // 网络层的 reject 也不能推出「服务端没接受」。实测过的三种现场：域与界面说空闲、
      // 会话列表那一行说运行中（三个口径互相矛盾）；列表里没有那一行的会话（子代理）更会
      // 因此判成空闲，用户离开时记不出离开标记，那一轮真收尾时不亮未读。
      //
      // 判据按**肯定证据**写（拿不到证据才回滚），而且只回滚**本次真的置过位**的那一次：
      // - `optimistic` 为假 = 本次提交在乐观置位之前就失败了（模型应用那一步），域上那个值
      //   根本不是本次写的 —— 不许动（那是替用户下结论）；
      // - 等待期间到达过**权威**结论（`authorityVersion` 变了，含布尔值与乐观写入相同的
      //   「权威再次确认在跑」）—— 权威优先，不许动；
      // - 提交前它就在跑（`wasRunning`）、适配器还有开放轮次、会话列表那一行说在跑
      //   —— 三者任一成立也什么都不动；
      // - 真的空闲提交失败（本次置了位、又没有任何证据）照旧回落空闲，否则会一直停在「生成中」。
      const evidence =
        this.authorityVersion(scope) !== authorityAtSubmit ||
        wasRunning ||
        scope.adapter?.hasOpenTurn() === true ||
        this.sessions.some((item) => item.id === scope.sessionId && item.running);
      if (optimistic && !evidence && scope.running) {
        scope.running = false;
        this.deliver(scope.sessionId, {
          type: "patch",
          patch: sessionPatch(this.sessionSource(scope), ["running"]),
        });
      }
      // 这一轮没提交成功：那一行标成失败并带上服务端 / 传输层的原因（**不回填输入框**，
      // 用户口径 2026-09-25：正文留在那一行里，重发用行上的按钮）。
      // 这条提交**没有回显**时（尚未发出的那条 / 子代理会话）没有能承载失败的那一行，
      // 退回老口径：正文回输入框 + 原生错误提示。日志两种情况都照旧。
      const detail = this.describeError(error);
      this.log(`[submit] 发送失败：${detail}`);
      if (!this.failEcho(requestId, `@sendFailed:${detail}`)) {
        // 跟随流与控制流分居两条 socket：**回执可能先到**——这条提交已经被判 `lost`，
        // 那一刻就按老口径把正文还回输入框并提示过一次（`restoreLostSubmission`）。
        // 本地 `prompt` 随后才 reject 时不许再还第二份（那会是同一句话两份）。
        if (this.submissionSettled(requestId)) {
          this.log(`[submit] 正文已由 lost 收场还回输入框，不重复回填：requestId=${requestId}`);
        } else {
          this.appendDraft(viewId, text, attachments, requestId);
          // 排队来源这一档的正文刚被 `appendDraft` 放回输入框，报错文案就说清这一点
          this.reportError(
            source === "queue"
              ? vscode.l10n.t("Failed to send the queued message (its content is back in the box)")
              : vscode.l10n.t("Failed to send"),
            error,
          );
        }
      }
    } finally {
      // 兜底：`try` 里提前 return 的分支也走这里收网。`failEcho` 幂等且不覆盖更具体的
      // 原因，所以这里用最泛的那一句；没有回显时它什么都不做（上面已经按老口径收场）。
      if (!admitted) this.failEcho(requestId, "@sendUnconfirmed");
    }
    // 这条提交**没有回显**（排队口径 / 子代理会话 / 判成命令但没走命令通道那类）却发出去
    // 了：界面上没有能承载它的那一行，提交那一刻移走的附件租约到此收场——不靠上限兜底。
    // 这条提交之后若被判 `lost`（受理了却没落盘），内容由 `restoreLostSubmission` 按
    // `submissions` 里的提交记录放回输入框：租约没了就放记录里那份芯片，租约还在
    // （回执先于 `session/prompt` resolve 到达）则整份归还。
    if (admitted && !this.echoFor(requestId)) this.attachments.releaseLease(requestId);
    // 上传不完整的提示**放在 try 之外**：它是成功之后的告知，抛在这里不该被上面的
    // catch 当成「没发出去」（那会把已经发出去的那条标成失败，还会把 running 置回 false）。
    // 芯片上**已经明确标成上传失败**的那些，用户原位就看得到，不再入队（用户 2026-10-18
    // 口径：按实际可见反馈判断，不是「正文有没有回填」）；其余才补一条黄色通知。
    if (admitted && notUploaded.length) {
      const silentlySkipped = notUploaded.filter((name) => {
        const attachment = attachments.find((item) => item.name === name);
        return attachment?.upload?.status !== "error";
      });
      if (silentlySkipped.length) this.warnUploadIncomplete(scope.sessionId, silentlySkipped);
    }
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

  /**
   * 提示：有文件附件没上传成功、发送时被跳过（内容没丢，仍在芯片上）。
   *
   * 只对**芯片上看不出失败**的那些调用（见 `submitMessage` 的判据）；归属是发起发送
   * 的那个会话，不是「完成时视图绑定了谁」。级别是黄色：不影响会话进程，但用户必须
   * 知道这批内容没跟着发出去。
   */
  private warnUploadIncomplete(sessionId: string | undefined, names: string[]): void {
    // `、` 是中文顿号，英文里得用 `, `——所以预览串只做「取前几个 + 省略号」，
    // 分隔符与「等 N 个」都交给词典按语言拼（见 texts.ts 的 uploadIncomplete）。
    const preview = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? "…" : "";
    this.notify({
      sessionId,
      level: "warn",
      kind: "uploadIncomplete",
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
  private async runCommand(
    viewId: string,
    line: string,
  ): Promise<{ ok: boolean; text?: string; unhandled?: boolean } | undefined> {
    if (!this.client) return undefined;
    // 命令按会话执行：还没有会话时先落到本工作区那条空壳上（点按钮时用户并没有先发过
    // 消息；没有工作目录时会先问一次，取消则整条命令不执行）
    let scope = this.scopeOfView(viewId);
    if (!scope) {
      scope = await this.ensureSession(viewId, { start: true, askDir: true });
    }
    if (!scope) return undefined;
    const agentId = scope.sessionId;
    // **再确认一次这个窗口此刻还绑着这条会话**：`ensureSession` 那一趟是往返，期间用户
    // 完全可能切到别的会话（点历史里的一条 / 关掉窗口）——那时再拿旧 scope 的命令打到
    // 别人的会话上就是改错对象。绑定变了就整条不执行（调用方拿 undefined 当"没执行"）。
    if (this.viewSessions.get(viewId) !== agentId) {
      this.log(`[commands] 窗口=${viewId} 在命令落到会话之前换了绑定：${line} 不执行`);
      return undefined;
    }
    return await this.executeCommandOn(agentId, line);
  }

  /**
   * 一条斜杠命令打到**指定的会话**上（不经过窗口 → 会话的解析）。
   *
   * 给「走了一串 await、又必须钉死会话」的路径用：它们不能按 `viewId` 再解析一次——那期间
   * 绑定可能已经变了，命令会打到用户刚切过去的那条新会话上。
   */
  private async runCommandOnSession(
    sessionId: string,
    line: string,
  ): Promise<{ ok: boolean; text?: string; unhandled?: boolean } | undefined> {
    if (!this.client) return undefined;
    return await this.executeCommandOn(sessionId, line);
  }

  /** `commands/execute` 的实际调用（参数名回退见 `runCommand`）。 */
  private async executeCommandOn(
    agentId: string,
    line: string,
  ): Promise<{ ok: boolean; text?: string; unhandled?: boolean } | undefined> {
    if (!this.client) return undefined;
    const attempt = (attachmentsKey: "submittedAttachments" | "images") =>
      this.client!.request<{ result?: { kind?: string; text?: string } } | undefined>("commands/execute", {
        agentId,
        line,
        [attachmentsKey]: [],
      });

    const interpret = (value: { result?: { kind?: string; text?: string } } | undefined) => {
      // `value === undefined`：**压根没进处理器**，界面上没有命令节点可看 → 调用方要入队
      // `unhandled` 与「执行过但结果是 error」分开：后者已由适配器折成红色命令节点、
      // 原文就在正文里（用户 2026-10-18 口径：不重复通知）
      if (value === undefined) return { ok: false, text: `@unknownCommand:${line}`, unhandled: true };
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
    // 没有可用会话就**直接拒收**，连文件选择框都不弹：附件要上传到某个会话，而用户
    // 点的是「添加附件」，这时再冒出目录选择 / 后台连接之类的框，既像上一个动作的
    // 回声，又说不清为什么（用户 2026-10-20 口径）。原因走黄色通知，入口只做一件事。
    const blocked = this.intakeBlockMarker(viewId);
    if (blocked !== undefined) {
      this.rejectIntakeWithoutSession(viewId, blocked, "button");
      return;
    }
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
   * 决策全部在纯函数 `attachments.planIntake` 里（条目 → 附件 / 引用 / 拒绝），
   * 这里只把结果落到视图上。之所以收成一份：路径与字节两条路曾经各写一遍，
   * 于是漂移出了真 BUG——字节通道的附件没有 `path`，发送装配按 `path` 过滤，
   * 上传成功的文件**根本没进 prompt**，而且连提示都不发（2026-09-21 修）。
   *
   * 三条去向（与官方一致，理由见 `attachments.ts` 文件头）：
   * - **图片**（五项判据全过）→ 图片附件（内容块，官方同样内联图片字节）；
   * - **目录** → `@dir/` **引用文本**（不是附件芯片，见 `addDirectoryReference`）；
   * - **其余文件** → 文件附件并**立即上传**（官方 upload-on-pick：选完就开始传，
   *   发送时只带 `receiptId`；上传按字节发，类型与大小都不挑——官方也不挑，
   *   **不要**在这里加可读性/大小筛子）。
   *
   * 进不了内容块的**图片**另走一条：改按文件上传（附件变文件、立即上传），原因用一条
   * 提示说清。不走 `@` 引用——引用依赖「执行世界能读到本地路径」，远端部署下是空头支票
   * （见 `attachments.ts` 文件头）。读不出来的**非图片**条目（选择到读取之间被删的竞态）
   * 仍旧退回带引号的路径——那是最后一道兜底，不再假装「已作为上下文加入」。
   *
   * **没有可用会话就整批拒收**：上传没有目标，收下来只会变成一枚 `@uploadNoSession`
   * 的失败芯片，而它连重试都没有意义。这里不替用户建会话 / 连后台（入口本身已经把
   * 这件事拒掉了，按钮那条连文件框都不弹），只按原因发黄色通知。
   */
  private async ingestAttachments(
    viewId: string,
    source: IngestSource,
    items: readonly IntakeItem[],
    rejected: readonly IntakeRejection[],
  ): Promise<void> {
    const blocked = this.intakeBlockMarker(viewId);
    // 只拒“有内容要接”的批次：空批（例如拖进来的 0 字节目录）照旧走下面的拒绝提示，
    // 免得把“读不出来”误报成“会话没准备好”。
    if (blocked !== undefined && items.length > 0) {
      this.rejectIntakeWithoutSession(viewId, blocked, source, items.length);
      return;
    }
    const key = this.keyForView(viewId);
    const existing = this.attachments.list(key);
    const scope = this.scopeOfView(viewId);
    const plan = planIntake({
      items,
      // 未拿到模型能力时按「支持」处理，与服务端最终校验一致
      acceptsImage: scope?.model?.acceptsImage !== false,
      // 图片内联上限：优先用服务端自己的 `imageLimits.maxImageBytes`（这正是那份
      // 投影的用途），拿不到时给一个保守硬上限——同步读一张几百 MB 的图会冻住宿主
      maxImageBytes: scope?.imageLimits?.maxImageBytes ?? IMAGE_INLINE_HARD_CAP,
      // 图片判据（像素 / 单边 / 张数 / 总字节）：在接入那一刻判出来，不再等服务端在提交时
      // 整批拒（那时用户看到的是一句英文原文报错）
      admission: {
        maxImagePixels: scope?.imageLimits?.maxImagePixels,
        maxImageDimension: scope?.imageLimits?.maxImageDimension,
        maxImagesPerMessage: scope?.imageLimits?.maxImagesPerMessage,
        maxMessageImageBytes: scope?.imageLimits?.maxMessageImageBytes,
      },
      // 张数与总字节是整批判据：草稿里已有的附件同样占额度
      existing,
      // 附件按路径去重（同一张图加两次没有意义）；字节条目没有身份可比，不去重
      existingPaths: existing.flatMap((attachment) => (attachment.path ? [attachment.path] : [])),
      rejected,
      onError: (message) => this.log(`[attach] ${message}`),
    });

    // 先把芯片落进列表（带 uploading，由 `attachments.start` 写）再起上传：上传是异步的
    // 一条日志把这一批的去向说清楚（排查「我加的东西怎么没进来」全靠它）
    this.log(
      `[attach] ${source}：附件 ${plan.attachments.length}（其中上传 ${plan.uploads.length}）` +
        ` / 目录引用 ${plan.directories.length} / 图片改文件 ${plan.degradedImages.length}` +
        ` / 路径兜底 ${plan.pathOnly.length} / 拒绝 ${plan.rejected.length}`,
    );
    this.attachments.add(key, plan.attachments);

    for (const directory of plan.directories) this.addDirectoryReference(viewId, directory);
    // 传入这一趟**已经验证过**的会话 id，不在开轮那一刻再读一次绑定：从判据到开轮
    // 之间用户可能切走 / 断线，再读一次就会把「刚验过的会话」换成 undefined。
    for (const upload of plan.uploads) this.startUpload(viewId, upload, scope?.sessionId);
    if (plan.pathOnly.length) {
      this.emitToView(viewId, { type: "ui/insertText", text: formatPathList(plan.pathOnly) });
    }
    // 图片的去向逐条说明（进不了内容块 → 按文件上传；文案后半句照实说模型能不能直接读）。
    // 这里没有别的原位反馈（芯片只是换成了文件附件，看不出**为什么**），所以入队黄色通知；
    // 归属用这次接入的会话（`scope` 在上面已成定局，不是完成时视图绑着谁）。
    for (const image of plan.degradedImages) {
      const marker = this.imageUnavailableMarker(image.name, image.unavailable);
      if (marker) {
        this.notify({
          sessionId: scope?.sessionId,
          level: "warn",
          kind: "imageDegraded",
          key: image.name,
          text: marker,
        });
      }
    }
    // 「模型不收图片输入」是**整批**原因（这一批里每一张都进不了内容块），按条发提示会
    // 刷屏：汇总成一条
    const unsupported = plan.degradedImages.filter(
      (image) => image.unavailable.reason === "image-unsupported",
    ).length;
    if (unsupported > 0) {
      const model = scope?.model;
      const label = model?.label ?? model?.model ?? "";
      this.notify({
        sessionId: scope?.sessionId,
        level: "warn",
        kind: "imageFilesUploaded",
        text: `@imageFilesUploaded:${unsupported}:${label}`,
      });
    }
    // 两条路各一套措辞（字面量写在这里，`scripts/i18n.test.ts` 靠它核对发射点）：
    // 准入判据完全相同，但「拖放上限 8 MB，请改用添加文件」对粘贴来的东西说不通
    // （用户手上没有那个文件）。按钮那条路不会有拒绝（对话框只给读得出来的路径），
    // 所以这里的兜底措辞用不到它。拒收的条目在输入框里不留痕迹，只有这条通知能说清。
    const unreadableKey = source === "paste" ? "@pasteUnreadable" : "@dropUnreadable";
    const tooLargeKey = source === "paste" ? "@pasteTooLarge" : "@dropTooLarge";
    for (const item of plan.rejected) {
      const marker = item.reason === "too-large" ? `${tooLargeKey}:${item.name}` : `${unreadableKey}:${item.name}`;
      // `kind` 按原因分开：同一次接入里「太大」与「读不出来」是两回事，不该合并成一条
      this.notify({
        sessionId: scope?.sessionId,
        level: "warn",
        kind: item.reason === "too-large" ? "dropTooLarge" : "dropUnreadable",
        key: item.name,
        text: marker,
      });
    }
  }

  /**
   * 附件入口此刻能不能接：能接返回 `undefined`，不能接返回要提示的原因标记。
   *
   * 判据按**肯定证据**分档：
   * - 连接不在 `connected`（或干脆没有客户端）→ 后台未连接；
   * - 已经绑着会话 → **放行**（上传要的是会话 id，与窗口有没有文件夹无关）；
   * - 还没有会话、也没有可用工作目录 → 请先选目录（没目录就建不出这条会话）；
   * - 还没有会话、目录已知（落壳在飞 / 建会话失败）→ 会话未就绪；那条路已经由
   *   `reuseOrCreateBlank` 的 `catch` 报过一次原生错误，这里只补一句“附件没加进来”。
   *
   * **不在这里替用户建会话 / 连后台**：附件入口只做附件，原因用一条黄色通知说清
   * （用户 2026-10-20 口径：文件选择框之后再来一个目录选择框会让用户莫名其妙）。
   */
  private intakeBlockMarker(viewId: string): string | undefined {
    if (!this.client || this.connection !== "connected") return "@attachBackendOffline";
    // 已经绑着会话就一定能传：上传要的是会话 id，不是「这个窗口有没有文件夹」。
    // `hasWorkspaceDir` 只用来区分「还没有会话」的那一档该提示什么（它不读会话 cwd）。
    if (this.scopeOfView(viewId)) return undefined;
    return this.hasWorkspaceDir() ? "@attachSessionUnavailable" : "@attachNeedsWorkspace";
  }

  /**
   * 整批拒收没有会话可落的附件接入（见 `ingestAttachments` 与 `pickFiles` 的会话门）。
   *
   * 归属取拒收发生时的会话绑定：断线不清绑定，已有会话的提示仍只归该会话；
   * 只有未绑定会话时才发共享通知，让未绑定窗口也能看到原因。
   *
   * @param marker - `intakeBlockMarker` 给出的原因标记。
   * @param count - 这一批的条目数；按钮入口还没选文件时不给（只记入口）。
   */
  private rejectIntakeWithoutSession(viewId: string, marker: string, source: IngestSource, count = 0): void {
    const sessionId = this.viewSessions.get(viewId);
    const detail = count > 0 ? `${count} 个条目` : "入口";
    this.log(`[attach] ${source}：${detail}整批拒收（没有可用会话：${marker.slice(1)}）`);
    this.notify({ sessionId, level: "warn", kind: marker.slice(1), text: marker });
  }

  /**
   * 图片进不了内容块（改按文件上传）时的提示标记。
   *
   * 五种原因各一条，数字由判据算出的原样带上（提示层不重算）；**像素只报上限**（实测的
   * 位数量级对用户没有指导意义）。文案的后半句在词典里按原因分：逐图三条（内联字节 /
   * 像素 / 单边）的副本模型也得先缩小才能 `read_image`，整批两条（张数 / 总字节）的副本
   * 单张都在限内、模型可以直接读。`image-unsupported` 返回 `undefined`：那是整批原因，
   * 由 `ingestAttachments` 汇总成一条。
   */
  private imageUnavailableMarker(name: string, unavailable: ImageUnavailable): string | undefined {
    switch (unavailable.reason) {
      case "image-over-limit":
        return `@imageTooLarge:${name}:${unavailable.limit}`;
      case "image-pixels":
        return `@imagePixelsTooLarge:${name}:${unavailable.limit}`;
      case "image-dimension":
        return `@imageDimensionTooLarge:${name}:${unavailable.measured}:${unavailable.limit}`;
      case "image-count":
        return `@imageCountTooLarge:${name}:${unavailable.limit}`;
      case "image-bytes":
        return `@imageBytesTooLarge:${name}:${unavailable.bytes}:${unavailable.limit}`;
      default:
        return undefined;
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

  /**
   * 账本里那份列表变了：**按归属键**决定这一帧发给谁。
   *
   * 有窗口正绑在这个键上（它是会话 id）→ 按会话广播，同会话的多窗口共享同一份芯片；
   * 这个键就是某个还没绑定会话的窗口自己（viewId）→ 定向发给它；**没人看这条会话时
   * 什么都不发**——结算只落在归属那条记录上，不按「此刻在看哪条会话」投递。
   */
  private publishAttachments(key: string, list: readonly Attachment[]): void {
    // 剥 `dataUrl` 再下发（见 `withoutAttachmentDataUrls`）：芯片不显示图，而这份列表
    // 每次变化都整份重发，带着图片 base64 就变成几 MB × 已有张数的过线量
    const frame: HostToWebview = {
      type: "patch",
      patch: { attachments: withoutAttachmentDataUrls(list) },
    };
    for (const sessionId of this.viewSessions.values()) {
      if (sessionId === key) {
        this.deliver(key, frame);
        return;
      }
    }
    // 空态窗口的键就是它自己的 viewId；已经绑走（`move` 搬过）或已经下线的都不发
    if (this.viewOrder.includes(key) && this.viewSessions.get(key) === undefined) {
      this.emitToView(key, frame);
    }
  }

  /**
   * 账本唯一的上传 IO：路径来源重读磁盘、字节来源用账本留的那一份，再走
   * `DshClient.uploadFile`（与官方同一条路由）。
   *
   * 生命周期（开轮 / 结算 / 旧轮作废 / 失败重试的来源）全在
   * `dsh/attachmentLifecycle.ts` 里：这里只做这一次 IO，`sessionId` 由账本在**开轮
   * 那一刻**抓给它，之后与窗口切到哪条会话无关。
   */
  private async performUpload(input: {
    sessionId: string;
    source: IntakeUpload["source"];
    name: string;
  }): Promise<UploadReceipt> {
    if (!this.client) throw new Error("@uploadNoSession");
    const bytes =
      input.source.kind === "bytes" ? input.source.bytes : new Uint8Array(readFileSync(input.source.path));
    const value = await this.client.uploadFile(input.sessionId, bytes, input.name);
    // 内容身份一并回带（账本写进芯片，并据此记「本地能打开什么」，见 rememberOpenTarget）
    return { receiptId: value.receiptId, attachmentId: value.file.attachmentId };
  }

  /**
   * 上传成功那一刻记下「这枚附件以后能在本地打开什么」（账本的 `rememberOpenTarget` 端口）。
   *
   * 两条来源分开处理，因为「打开什么」本来就不同：
   * - **路径来源**：记用户自己那个文件的路径（打开的是原件，不是拷贝，之后他改了也看得见）；
   * - **字节来源**（拖放 / 截图粘贴）：磁盘上没有原件，落一份内容寻址的临时副本
   *   （见 `dsh/attachmentOpen.ts`）——这是这套附件唯一还能被打开的机会，字节马上要释放。
   *
   * 写盘是**后台**的：上传成功这一刻不该为了「以后可能点开」再阻塞一次 IO。落盘失败
   * （临时目录不可写等）只记日志，之后点开会落到「取字节 / 说打不开」那条路上。
   */
  private rememberOpenTarget(input: {
    attachmentId: string;
    name: string;
    source: IntakeUpload["source"];
  }): void {
    if (input.source.kind === "path") {
      // 用户自己那个文件：既能打开，也是芯片悬停要显示的「文件路径」
      this.rememberLocalTarget(input.attachmentId, input.source.path, false);
      return;
    }
    const bytes = input.source.bytes;
    const pending = materializeAttachment({
      root: attachmentTempRoot(tmpdir()),
      bytes,
      name: input.name,
    }).catch((error: unknown) => {
      this.log(`[open] 附件临时副本落盘失败（${input.name}）：${this.describeError(error)}`);
      return undefined;
    });
    // 磁盘上从来没有过这个文件，落下来的副本只用于打开，不当「原文件路径」展示
    this.rememberLocalTarget(input.attachmentId, pending, true);
  }

  /**
   * 记下「这枚内容身份以后在本地打开什么」：内存索引（含在途落盘）+ **持久记录**。
   *
   * 持久化那一半是给下一次宿主启动用的（口径见 `dsh/attachmentOpenStore.ts`）：durable
   * 消息里只有内容摘要，而文件附件没有「回服务端取字节」这条路——路径一忘，历史消息里
   * 那枚芯片就只剩一句打不开，用户的文件却还在原处。
   *
   * `copy` 区分两条通道：路径来源记的是用户自己那个文件，字节来源记的是本扩展落的临时
   * 副本。字节通道要等副本落盘才有路径，所以在承诺上续一笔（落盘失败就没有可记的）。
   */
  private rememberLocalTarget(id: string, target: string | Promise<string | undefined>, copy: boolean): void {
    this.attachmentTargets.remember(id, target);
    if (typeof target === "string") {
      writeAttachmentTarget(this.state, id, { path: target, copy });
      return;
    }
    void target.then((path) => {
      if (path) writeAttachmentTarget(this.state, id, { path, copy });
    });
  }

  /**
   * 起一次上传（`planIntake` 判出来要上传的那几枚）。
   *
   * `sessionId` 是接入层**这一趟已经验证过**的会话（调用方在上面过了会话门）。上传的
   * 归属在**这一刻**取定，之后用户切走也不改这次上传的归属；这里不再读一次窗口绑定。
   * 没有 id 只可能是别的调用点（重试）或竞态，账本会落 `@uploadNoSession` 作为最后防线。
   */
  private startUpload(viewId: string, upload: IntakeUpload, sessionId: string | undefined): void {
    this.attachments.start(this.keyForView(viewId), upload.id, sessionId, upload.source);
  }

  /** 重传一个失败的文件附件：来源（暂存字节 / 附件路径）由账本自己取。 */
  private retryUpload(viewId: string, id: string): void {
    this.attachments.retry(
      this.keyForView(viewId),
      id,
      this.client ? this.viewSessions.get(viewId) : undefined,
    );
  }

  /**
   * 附件的展示名：图片与目录取文件名（芯片里更好读），其余取工作区相对路径。
   * 三个入口（选文件 / 选目录 / 右键 / `@`）共用，避免各自写一份而走样。
   */
  private attachmentName(path: string): string {
    return isImagePath(path) || isDirectoryPath(path) ? basename(path) : this.relativePath(path);
  }

  /** 删掉一枚芯片：账本顺手作废它在飞的那一轮、释放它的暂存字节（迟到的完成不再复活它）。 */
  private removeAttachment(viewId: string, id: string): void {
    this.attachments.remove(this.keyForView(viewId), id);
  }

  /**
   * 按 requestId 取回用户原始输入，并顺手缓存到 `queueOrigin`（供「重新编辑」）。
   * 取不到返回 undefined，调用方退回线上文本。
   *
   * **没有内容块的记录不算原文**：`restoreLostSubmission` 在记录被淘汰后会补一条空内容
   * 的占位（只为挡住重复回执），那条不能当可还原的原文——否则「取回重编」会拿它顶掉
   * 队列项里真正的正文（`origin?.text ?? item.text` 对空串不成立）。
   */
  private originFor(rpcId: string | undefined): QueueOrigin | undefined {
    if (!rpcId) return undefined;
    const record = this.submissions.get(rpcId);
    if (!record?.content.length) return undefined;
    return { text: record.text, attachments: record.attachments, content: record.content };
  }

  /**
   * 记下这次提交的原文、附件与内容块，供队列「重新编辑」还原、
   * 以及「ESC 中止后把队首重新发出」使用（后者需要原样内容块才能带上图片）。
   *
   * `sessionId` 是**提交那一刻**那条会话，`lost` 收场要把内容还回哪个输入框按它（见
   * `restoreLostSubmission`）——不能等到收场时再读「此刻窗口绑定着谁」。
   *
   * 服务端不保证会回 `rpcId`（插件/版本差异），所以这只是尽力而为的记录。
   */
  private rememberSubmission(
    requestId: string,
    text: string,
    content: unknown[],
    attachments: Attachment[],
    sessionId: string,
  ): void {
    this.putSubmissionRecord(requestId, {
      text,
      attachments: [...attachments],
      content: [...content],
      at: Date.now(),
      sessionId,
    });
  }

  /**
   * 提交记录表的**唯一插入口**：先按时间淘汰过期项，再按条数上限淘汰最旧的（插入序）。
   *
   * 上限必须只在这一处：`restoreLostSubmission` 给「记录已被淘汰的未知 rpcId」补占位
   * 记录也走这里——绕过裁剪的话，每来一条不同的未知回执就能长一条，与「有界」的承诺相反。
   * 淘汰**不**连带释放附件租约：租约挂在回显 / 在飞提交上，由它们自己的生命周期收场
   * （见 `dsh/attachmentLifecycle.ts`；回显那条另有 `addEcho` / `trimPendingKeys` 收）。
   */
  private putSubmissionRecord(requestId: string, record: SubmissionRecord): void {
    const now = Date.now();
    for (const [key, value] of [...this.submissions]) {
      if (now - value.at > SUBMISSION_TTL_MS) this.submissions.delete(key);
    }
    while (this.submissions.size >= MAX_SUBMISSIONS) {
      const oldest = this.submissions.keys().next().value;
      if (oldest === undefined) break;
      this.submissions.delete(oldest);
    }
    this.submissions.set(requestId, record);
  }

  /**
   * 摘空可恢复的队列 → cancel → 等真空闲 → 按原序走 submitMessage。
   * 历史探针中仅 cancel 两轮均未接续；追加 prompt 唤醒旧队列分别为 3/3 与 0/3，不能依赖。
   * 先捕获 origin.content 保留附件；摘取失败 / 等待超时回滚，提交失败归还尚未提交的余项。
   * 这不是事务，不能保证竞态下绝不丢失 / 重复；边界见 docs/design-draft.md。
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
        // 有排队消息但拿不到可重发内容（理论上不会发生）：只中止，别把消息弄丢。
        // 队列区会随着中止被清空，这条通知是唯一还能说明「刚才那些没重发」的地方
        this.notify({ sessionId, level: "warn", kind: "queueContentLost", text: "@queueContentLost" });
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
      // 原生那条（上面 `reportError`）说的是底层超时；这条说的是**用户的那些消息现在
      // 去哪儿了**（放回队列、没发出去），信息不同，不属于重复提示
      this.notify({
        sessionId,
        level: "error",
        kind: "queueDispatchFailed",
        text: "@queueDispatchFailed",
      });
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
    // 归属在**这一批开始重发之前**捕获：提交是异步的，用户在等待期间可以切走
    const sessionId = this.viewSessions.get(viewId);
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
      this.notify({
        sessionId,
        level: "error",
        kind: "queueDispatchFailed",
        text: "@queueDispatchFailed",
      });
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
   * 子代理用持久父地址走 subagents/interruptByParent；普通会话走 session/cancel。
   * 不乐观置 running:false，须等服务端收尾，否则 waitUntilIdle 会提前重发进未续跑的队列。
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
   * 提交的同步入口，必须早于连接等任何 await，避免快照回填已发送草稿与重复芯片。
   * 空闲且非命令才建回显；运行中排队 / 插话不进账本，目录未到时延后补判。
   * 仅 source=composer 清草稿与附件；retry / queue 不能擦掉用户当前输入。
   * handoffLeaseFrom 将旧提交的附件租约交给新提交，保在飞上传，不重启或回填输入框。
   * 顺序与 durable 交接见 docs/design-draft.md。
   * @returns prompt 与 durable 回显关联的 requestId。
   */
  private beginSend(
    viewId: string,
    text: string,
    attachments: Attachment[],
    source: "composer" | "retry" | "queue",
    handoffLeaseFrom?: string,
  ): string {
    const requestId = randomUUID();
    if (handoffLeaseFrom) this.attachments.transferLease(handoffLeaseFrom, requestId);
    const key = this.keyForView(viewId);
    const scope = this.scopeOfView(viewId);
    // 斜杠命令走命令通道（`commands/execute`），它不是用户消息，不该占一行回显。
    // 判据只能用**这一刻手里那份命令目录**（`slashCommandOf`，同步读域上的快照）：
    // 目录是异步拉的（域打开时预取、开 `/` 菜单时重取，见 `listCommandsFor`）。
    //
    // 目录**还没到**时这里**不猜**（早先按「正文以 `/` 开头」一刀切，代价见下）：先不回显，
    // 由 `send` 用处理好的目录确认「这不是命令」之后再补一次。一刀切漏掉的正是**技能调用**
    // ——`/skill-name …` 是普通消息（技能不进命令目录，见 `skillCommands`），它整类消息
    // 因此永远要等 durable 事件才出现在消息流里（用户 2026-09-25 报的现场）；而反向的
    // 「先回显再收回」是一次肉眼可见的闪现。
    //
    // 「目录还没到」的判据是域上的 `commandsLoaded`，**不能**再用「有没有域」代替：空态
    // 窗口现在一进来就绑在本工作区那条空壳上（见 `newSession`），域有了、目录却可能还在飞。
    const slashish = attachments.length === 0 && text.trim().startsWith("/");
    const commandUnknown = slashish && (scope === undefined || !scope.commandsLoaded);
    const isCommand =
      slashish && !commandUnknown && scope !== undefined && this.slashCommandOf(scope, text) !== undefined;
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
        ...this.echoAnchorField(viewId),
      });
    }
    if (source === "composer") {
      this.commitDraft(viewId);
      this.commitAttachments(viewId, requestId);
    }
    return requestId;
  }

  /**
   * 这条回显的**落位锚点**：提交那一刻对话流里最后一条 durable 行的 id。
   *
   * 只有失败行会用到它（见 `shared/chat.ts` 的 `PendingMessageView.anchor`）：失败那条的
   * 真实行永远不会来，「真实行将来落在哪」那条判据对它不成立，没有锚点它就被排到会话最底部。
   * 取适配器的消息表——它就是对话流的权威顺序（界面那份是它的窗口投影，末行一致）。
   *
   * 提交那一刻没有会话、或那条会话还没有任何 durable 行（空态第一条消息）时**没有锚点**：
   * 那一行本来就该在末尾，不需要锚。
   */
  private echoAnchorField(viewId: string): { anchor?: string } {
    const last = this.scopeOfView(viewId)?.adapter?.snapshotMessages().at(-1);
    return last ? { anchor: last.id } : {};
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
      // 被淘汰的那一行不再被任何人引用：它持有的附件租约（提交那一刻移走的那一份）一起放掉
      if (dropped) this.attachments.releaseLease(dropped.requestId);
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
      // 整个键被淘汰 = 它名下每一条回显都不再被引用：各自的附件租约一起放掉
      for (const echo of this.pendingMessages.get(oldest) ?? []) {
        this.attachments.releaseLease(echo.requestId);
      }
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
   * 按域在不在分流投递，与附件账本那条 `publishAttachments` 同一套：已绑定的窗口按会话
   * 投递（同一会话的多窗口看到同一份回显，与草稿/附件的现行口径一致），未绑定的定向发给它自己。
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
  private retireEchoByText(sessionId: string, text: string): string | undefined {
    const wanted = text.trim();
    if (!wanted) return undefined;
    const list = this.pendingMessages.get(sessionId);
    if (!list?.length) return undefined;
    const index = list.findIndex((echo) => echo.text.trim() === wanted);
    if (index < 0) return undefined;
    const [echo] = list.splice(index, 1);
    this.putPending(sessionId, list);
    this.log(`[echo] 按正文收回乐观回显 requestId=${echo?.requestId ?? ""}`);
    this.pushPending(sessionId);
    return echo?.requestId;
  }

  /**
   * 一条**人的**用户消息被 durable 承认（适配器的 `onUserMessage` 回调）。
   *
   * 有 `rpcId` 就按它收（权威、精确）；没有才退回按正文（见 `retireEchoByText`）。
   * 承认 = 这条提交**真的成了历史**：它的附件租约到此收场（服务端已经拿到内容块，
   * 本地那份芯片与字节没有必要再留着）。
   */
  private noteUserAdmitted(sessionId: string, message: { rpcId?: string; text: string }): void {
    if (message.rpcId) {
      this.retireEcho(message.rpcId, "admitted");
      this.attachments.releaseLease(message.rpcId);
      // 这条提交真的成了历史：本地记录标成收场。此后同一 rpcId 若还有 `lost` 回执
      // （重连重放）也不许再把这份正文塞回输入框——它已经是会话里的一行了
      this.settleSubmissionRecord(message.rpcId);
      return;
    }
    const retired = this.retireEchoByText(sessionId, message.text);
    if (retired) {
      this.attachments.releaseLease(retired);
      // 旧服务端不回 rpcId 时这条就是「已经成了历史」的唯一证据（按正文对上的那一条）：
      // 记录一并标成收场——它的收件箱回执还在，后面 `turn/end` 完全可能再判它一次
      // 「受理了却没落盘」，那时不许把正文塞回输入框（它已经在会话里了）
      this.settleSubmissionRecord(retired);
    }
  }

  /**
   * 一条**已经交给服务端**的提交永远到不了 durable 时的收场（判定见
   * `dsh/submissionReceipts.ts`，来路是适配器的 `onSubmissionLost`）。
   *
   * `session/prompt` 的 accepted 只说明那句话进了服务端收件箱；那一轮若在把它写成
   * durable `user/message` 之前就失败（真实例子：所选模型没有对应的思考档位），
   * 收显就永远等不到承认——以前它会一直停在 `sending`，界面画成一条正常消息、
   * 被 `pendingInsertIndex` 甩到会话最底部（用户 2026-10-16 报的现场）。
   *
   * 两种来路分开收场：
   * - `lost`：**真的没发出去**。有回显的那条按既有失败口径留在原地（红框 + 重发 /
   *   撤回 + 原因），正文不回输入框；**没有回显的那条**（运行中排队发送 / 子代理会话，
   *   内容块见 `beginSend` 的两道门）按 `failEcho` 的契约退回老口径：正文与附件回
   *   原会话的输入框 + 原生提示（见 `restoreLostSubmission`）——提交那一刻它们已经
   *   被清掉，不还回去就等于静默吞掉用户那句话；
   * - `canceled`：这条待发消息是被**有意丢掉**的（官方 `Session.clear()` / 队列取消），
   *   用户自己取消的东西不该变成红框失败行，也不该把正文塞回输入框；但它必须离开账本，
   *   否则同样会永远挂在底部。
   */
  private settleLostSubmission(rpcId: string, reason: "lost" | "canceled"): void {
    if (reason === "lost") {
      // 有回显：那一行留在原地标失败（正文不回输入框，既有口径不变），到此收场
      if (this.failEcho(rpcId, "@sendNotPersisted")) return;
      this.restoreLostSubmission(rpcId);
      return;
    }
    const key = this.removeEcho(rpcId, "inbox-canceled");
    this.attachments.releaseLease(rpcId);
    // 收场标记对**两种来路公共**：有回显的那条同样要标——重放再判一次 `lost` 时，
    // 记录若还是「没收场」，那条被有意取消的正文会被当成没落盘又塞回输入框
    this.settleSubmissionRecord(rpcId);
    if (key === undefined) return;
    this.pushPending(key);
  }

  /**
   * **没有回显**的提交被判 `lost` 的收场（`failEcho` 返回 `false`）。
   *
   * 界面上没有能承载失败的那一行，所以退回 `failEcho` 注释里那条老口径：内容块
   * （`rememberSubmission` 记的原文与附件）回到**提交那一刻那条会话**的输入框，
   * 并弹一次原生错误提示。归还走附件账本的租约——租约还在时（回执先于
   * `session/prompt` resolve 到达）整份还回可见草稿，在飞上传与暂存字节都不取消；
   * 已经由 `send` 收尾释放过时（受理已 resolve）就按记录里那份芯片放回去。
   *
   * 记录被 TTL / 条数上限淘汰后没有正文可还：仍然报原生提示（不许静默），并且塞一条
   * **空内容**的占位记录标成 `settled`——同一 rpcId 的重复 / 迟到回执因此也被同一道门
   * 挡住，去重不另建无界集合（上限就由 `submissions` 这张表兜）。
   */
  private restoreLostSubmission(rpcId: string): void {
    const record = this.submissions.get(rpcId);
    if (!record) {
      this.log(`[submit] 无回显的提交未落盘，但本地提交记录已被淘汰，无法回填：requestId=${rpcId}`);
      // 走同一处有界插入（TTL / 条数上限）：未知 rpcId 也能长记录的话，这张表就没有上限了
      this.putSubmissionRecord(rpcId, {
        text: "",
        attachments: [],
        content: [],
        at: Date.now(),
        sessionId: "",
        settled: true,
      });
      this.reportLostSubmission();
      return;
    }
    if (record.settled === true) return; // 已经收场过（重复 / 迟到回执）：不重复回填、不重复提示
    record.settled = true;
    this.log(`[submit] 无回显的提交未落盘，正文与附件回到会话输入框：requestId=${rpcId} 会话=${record.sessionId}`);
    if (record.sessionId) this.appendDraftForSession(record.sessionId, record.text, record.attachments, rpcId);
    this.reportLostSubmission();
  }

  /**
   * 「服务端受理了、这一轮却没在落盘之前写成 durable」的原生提示。
   *
   * 只有 `detail` 会过 `resolveForVsCode`（见 `reportError`），所以前缀必须是已经本地化的
   * 现成文案，不能塞 `@key`；原因用 `@sendNotPersisted` 标记（界面那份词典与 VS Code 那份
   * l10n 都登记了它）。
   */
  private reportLostSubmission(): void {
    this.reportError(vscode.l10n.t("Failed to send"), new Error("@sendNotPersisted"));
  }

  /**
   * 把**某条会话**的输入框补上正文与附件（`lost` 收场专用）。
   *
   * 与 `appendDraft` 同一套口径（追加不覆盖、附件按 id 去重），区别只有归属：
   * 它的键是**提交那一刻那条会话**，帧也按会话投递（`deliver`）——同一会话的每个窗口
   * 都看到这份回填，而当前正看着别的会话的窗口收不到；那时状态留在草稿 / 附件账本里，
   * 切回那条会话的整份快照会带上它（见 `snapshotFor`）。
   */
  private appendDraftForSession(
    sessionId: string,
    text: string,
    attachments: Attachment[],
    requestId?: string,
  ): void {
    this.deliver(sessionId, { type: "patch", patch: this.fillDraft(sessionId, text, attachments, requestId) });
  }

  /**
   * 把正文与附件并回某个键（窗口 / 会话）的输入框，返回那一帧 `patch`——**投递给谁由
   * 调用方定**（`appendDraft` 定向发窗口，`appendDraftForSession` 按会话镜像）。
   *
   * 正文用换行追加，绝不覆盖：`lost` 收场发生时用户可能已经在那条会话里写了下一句
   * （切走再切回来也照样）。附件先归还这次提交的租约（那份活条目带着上传状态与在飞轮次），
   * 再补记录里那份界面副本——重复的 id 在这一步被跳过。
   *
   * `requestId` 给出时顺手把提交记录标成收场：内容已经还回去了，同一 rpcId 的 `lost`
   * 回执（重连重放会再来一遍）不许再追加第二份。
   */
  private fillDraft(
    key: string,
    text: string,
    attachments: Attachment[],
    requestId?: string,
  ): { draft: string; attachments: Attachment[] } {
    const existing = this.drafts.get(key) ?? "";
    const next = existing.trim() ? `${existing.replace(/\s+$/, "")}\n${text}` : text;
    this.drafts.set(key, next);
    if (requestId) {
      this.settleSubmissionRecord(requestId);
      // 附件走账本（按 id 去重），但这一帧由这里**合成**（正文与附件一次推给界面）：
      // 账本先推一帧、这里再推一帧的话，界面上是两帧连续的同字段补丁
      this.attachments.returnLease(requestId, key, { publish: false });
    }
    this.attachments.add(key, attachments, { publish: false });
    return { draft: next, attachments: withoutAttachmentDataUrls(this.attachments.list(key)) };
  }

  /**
   * 把一条提交记录标成**已经收场**（幂等；记录不在时什么都不做）。
   *
   * 落点：内容已经还回输入框（`appendDraft`）、已被 durable 承认（`noteUserAdmitted`）、
   * 被用户撤回 / 重发（`retractPending` / `resendPending`，那一段内容用户已经明确丢掉或
   * 交给新那次提交带走了）、被有意取消（`settleLostSubmission` 的 `canceled` 档）。
   * 标记之后，同一 rpcId 的 `lost` 回执（重连重放会把它再放一遍）不再回填第二次。
   * 记录本身照旧留着：durable 行还要借它的附件字节（见 `resolveEchoAttachments`），
   * 淘汰仍由 `submissions` 的 TTL / 条数上限管。
   */
  private settleSubmissionRecord(rpcId: string | undefined): void {
    if (!rpcId) return;
    const record = this.submissions.get(rpcId);
    if (record) record.settled = true;
  }

  /**
   * 这条提交的内容是不是**已经收场**（还回了输入框 / 已被承认 / 被有意丢掉）。
   *
   * 调用方拿它避免二次回填：同一 rpcId 的 `lost` 回执与本地 `prompt` reject 谁先到都
   * 可能（两条 socket），先到的那条已经把内容安置好，后到的不许再动。
   */
  private submissionSettled(rpcId: string): boolean {
    return this.submissions.get(rpcId)?.settled === true;
  }

  /** 按 requestId 找一条回显（**全局扫**：key 会随绑定迁移，按 id 找没有时序问题）。 */
  private echoFor(requestId: string): PendingMessageView | undefined {
    for (const list of this.pendingMessages.values()) {
      const echo = list.find((entry) => entry.requestId === requestId);
      if (echo) return echo;
    }
    return undefined;
  }

  /**
   * 提交那一刻把可见芯片**移进这次提交的租约**（并推一份空表），有回显的那条失败行改引用
   * 租约里那一份活条目——它的上传状态会继续被结算，于是「重发」拿得到真回执。
   *
   * **移走而不是销毁**（见 `dsh/attachmentLifecycle.ts`）：字节与在飞那一次上传都留着，
   * 失败回填（`appendDraft`）能把原来那些对象整份还回输入框；成功 / 撤回 / 命令 / 无回显的
   * 提交成功才由 `releaseLease` 最终释放。
   *
   * `publish: false` 给 `send` 里那次按会话键的复述：`beginSend` 已经下发过「空」了，
   * 那次只是防「共享空壳：别的窗口的芯片在迁移合并时并进来」，没有新变化要广播。
   */
  private commitAttachments(viewId: string, requestId: string, options?: { publish?: boolean }): void {
    const key = this.keyForView(viewId);
    const leased = this.attachments.detach(key, requestId, options);
    if (!leased) return;
    const echo = this.echoFor(requestId);
    if (echo) echo.attachments = [...leased];
  }

  /**
   * 提交草稿：清空这个窗口（或它绑定的会话）的草稿，并把「清空」推给界面。
   *
   * **调用点必须早于任何可能推整份状态快照的 await**：还没有壳的空态发消息时
   * `ensureSession` → `reuseOrCreateBlank` 会在绑定窗口后推一份整份快照，而快照里的
   * `draft` 读的就是这张表（见 `snapshotFor`）。晚清一步，那一帧就把用户刚发出去的正文
   * 塞回输入框——界面上是「清空 → 闪回 → 消失」。这条顺序由 `beginSend` 保证（它排在
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

  /**
   * 把文本与附件追加回**这个窗口**的输入框（发送失败时的兜底，尽量不丢内容）。
   *
   * `requestId` 给出时先**归还这次提交的租约**：原先那几枚（上传状态 / 回执 / 暂存字节 /
   * 在飞那一次结算）整份回到可见草稿；紧接着 `add` 的界面副本按 id 去重自动跳过。没有租约
   * 的来源（重发 / 排队重发）按老口径把手上这一批放回去。附件与正文的合并、去重与收场标记
   * 都在 `fillDraft` 里（`appendDraftForSession` 走同一份，只是投递口径不同）。
   */
  private appendDraft(viewId: string, text: string, attachments: Attachment[], requestId?: string): void {
    const key = this.keyForView(viewId);
    this.emitToView(viewId, { type: "patch", patch: this.fillDraft(key, text, attachments, requestId) });
  }

  /**
   * 队列消息「重新编辑」：把它从队列里摘掉，内容放回输入框。
   *
   * ## 顺序：**先抓好、先把附件预备齐，再摘**
   *
   * 三步都不许提前动队列：
   *
   * 1. **抓好**——原文 / 附件 / 草稿键必须在 `await` 之前抓。摘除一旦生效，服务端会
   *    立刻重推队列（新通道是 `inbox` 投影，旧服务端是 `queue` 帧），那条重推经
   *    `syncQueue` **整表重建** `queueOrigin`（先 `clear()`），被摘掉的这一项自然不在
   *    里面；等 await 回来再读，附件与原文双双落空——用户报障的「带附件的排队消息取回
   *    重编，附件没了」就是这个（跟随流与控制流分居两条 socket，回显**允许**先于 RPC 的
   *    resolve 到达，该排列已由离线回路复现；回归见 `scripts/queueRestore.test.ts`）。
   *    草稿键同理：await 期间用户可能切了会话，那时 `keyForView` 指向的是**新**会话。
   * 2. **预备还原**——附件还原计划与图片字节（durable 句柄经 `session/attachment` 换回）
   *    全部先算出来。**只要有一枚还原不了就不摘**：用户的硬目标是「取回重编不能丢附件」，
   *    摘了再只回填一部分，等于把那一枚从队列里抹掉。宁可这次不取回（消息原样留在队列里，
   *    需修改时应先备好完整内容，再取消旧消息并重发），并按会话提示一句。
   * 3. **摘除成功才回填**——摘不动（服务端回 `session/queue-item-not-found`）时**不回填**：
   *    那多半是这条已经开始发送了，回填会让用户以为它还没发出去，接着一发送就变成重复
   *    消息；这一路草稿与 `queueOrigin` 也都不动，用户还能再点一次。
   *
   * 正文用客户端自己存的原文（`submissions`）而不是队列回显：提交给服务端的
   * 正文已经把文件上下文内联进去了，把回显倒回输入框会是一大坨内容。
   */
  private async editQueuedMessage(viewId: string, itemId: string): Promise<void> {
    if (!this.client) return;
    const scope = this.scopeOfView(viewId);
    if (!scope) return;
    const sessionId = scope.sessionId;
    // 抓取一律在 await 之前（见函数注释）。`queueOrigin` 是队列折算时建的索引；
    // 它若恰好没有这一项，用同一个 requestId 的提交记录兜底（`submissions` 还没被
    // 淘汰时两者同源，这里只是不漏掉原文）
    const key = this.keyForView(viewId);
    const item = scope.queueItems.find((entry) => entry.id === itemId);
    const origin = scope.queueOrigin.get(itemId) ?? this.originFor(item?.rpcId);

    // 附件：本地提交记录最权威；重载 / 记录被淘汰后退回内容块——其中的图片能用
    // durable 句柄换回字节，文件块没有上传回执（发送只认回执，不伪造）所以计入「还原不了」
    const plan = queueRestoreAttachments(origin?.attachments ?? [], origin?.content);
    const restoredAttachments = [...plan.attachments];
    let unrestorable = plan.unrestorable;
    for (const pending of plan.pendingImages) {
      const dataUrl = await this.fetchAttachmentDataUrl(
        sessionId,
        pending.attachmentId,
        pending.attachment.mediaType,
      );
      if (dataUrl) restoredAttachments.push({ ...pending.attachment, dataUrl });
      else unrestorable += 1;
    }

    // 还原不了就**不摘**（见函数注释第 2 步）。通知按**会话**归属：还在看这条会话的
    // 窗口照常看到；切走了的窗口不该收到——它会把别的会话的失败画进当前界面
    if (unrestorable > 0) {
      this.notify({
        sessionId,
        level: "warn",
        kind: "queueAttachmentsLost",
        text: "@queueAttachmentsLost",
      });
      return;
    }

    try {
      await this.client.updateQueueRemove(sessionId, itemId);
    } catch (error) {
      this.reportError(
        vscode.l10n.t("Failed to restore the queued message (it may already be sending)"),
        error,
      );
      return;
    }
    scope.queueOrigin.delete(itemId);
    const restored = origin?.text ?? item?.text ?? "";
    // 输入框里可能已经有草稿：追加而不是覆盖，避免把用户正在写的内容弄丢
    const existing = this.drafts.get(key) ?? "";
    const next = existing.trim()
      ? restored
        ? `${existing.replace(/\s+$/, "")}\n${restored}`
        : existing
      : restored;
    this.drafts.set(key, next);

    // 附件的身份判据（同回执 / 同 durable 句柄 / 图片同字节）仍只有 `queueView` 一份，
    // 合并在这里做；账本只负责「掉出列表的那些枚释放字节与轮次」，这一帧由这里合成
    const list = [...this.attachments.list(key)];
    appendRestoredAttachments(list, restoredAttachments);
    this.attachments.replace(key, list, { publish: false });

    // 只在「这个窗口还看着这条会话」时定向推给它：await 期间用户切走了的话，这帧会把
    // **别的会话**的草稿画进当前输入框（内容仍留在原会话的草稿表里，切回去就看得到）
    if (this.viewSessions.get(viewId) === sessionId) {
      this.emitToView(viewId, {
        type: "patch",
        patch: { draft: next, attachments: withoutAttachmentDataUrls(list) },
      });
    } else {
      this.deliver(sessionId, {
        type: "patch",
        patch: { draft: next, attachments: withoutAttachmentDataUrls(list) },
      });
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
   * **打开动作本身不按文件类型分流**：普通打开一律是 `vscode.open` 命令，由 VS Code
   * 按资源类型挑编辑器。唯一自己动手的是「带行号打开」（见方法末尾那一支的注释）。
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
    // 归属在**发起这一刻**捕获（下面有 await：文件存在性检查、编辑器打开），
    // 用户在等待期间切走之后，这些失败不该画进新会话
    const notifySession = viewId ? this.viewSessions.get(viewId) : undefined;
    let resolved = resolveChipPath(cwd, path);
    if (!resolved) {
      // 只可能发生在「相对路径 + 拿不到会话工作目录」时（会话还没进列表）。
      // 以前这里只写日志 → 用户点了完全没反应，不知道发生了什么。
      this.log(`[open] 路径解析不了（相对且缺会话工作目录），放弃打开：${path}`);
      if (viewId) {
        this.notify({
          sessionId: notifySession,
          level: "warn",
          kind: "chipPathUnresolved",
          text: "@chipPathUnresolved",
        });
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
        this.reportMissingFile(viewId, notifySession, resolved, fromLink);
        return;
      }
    } else if (existence === "absent") {
      // 按住修饰键 = 「直接打开文件本身」，但磁盘上已经没有这个文件了，
      // 打开必然失败。这里退化成和普通点击同一条链（先试改动对比），
      // 而不是静默失败：对被删除的文件来说，能看到删除前的内容已经是最好的结果。
      if (await this.openChanges(uri)) return;
      this.reportMissingFile(viewId, notifySession, resolved, fromLink);
      return;
    }
    // **不按文件类型分流**：打开就是「把这个资源交给 VS Code」，由它按资源类型挑编辑器
    // ——图片进内置预览、文本进文本编辑器、其余进它自己的对应编辑器，与在资源管理器里
    // 双击同一个行为。这里曾经用 `openTextDocument` 打开，它对一张 PNG 直接抛「文件似乎
    // 是二进制文件，不能作为文本打开」，日志里只留一行 `[open] 打开失败`，用户看到的就是
    // 「单击没有反应」（2026-10-13 实测踩中）；也曾经在这里按 `isImagePath` 自己分流，
    // 那只是把同一件事判了第二遍。
    //
    // **唯一需要自己动手的是「带行号打开」**（正文链接的 `#L24`，只有它会给 `line`）：
    // 光标位置要按文件真实行数夹取（越界的 `Position` 是抛异常，不是夹取），所以那一条
    // 仍走文本文档。它失败（链接指到一个二进制上）就退到普通打开，不静默。
    if (isLineNumber(effectiveLine)) {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const position = this.revealLine(document, effectiveLine);
        await vscode.window.showTextDocument(document, {
          preview: true,
          ...(position ? { selection: new vscode.Range(position, position) } : {}),
        });
        return;
      } catch (error) {
        this.log(
          `[open] 带行号打开失败（${path}）：${this.describeError(error)}；退回普通打开`,
        );
      }
    }
    try {
      await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
    } catch (error) {
      this.log(`[open] 打开失败 ${path}：${this.describeError(error)}`);
    }
  }

  /**
   * 「在资源管理器中展开这个目录」（用户消息里的 `@目录` 引用点开时走这条）。
   *
   * 与 `openFile` 同一口径的两件事：`path` 是引用上的**原样拼写**（可能相对会话工作
   * 目录），先经 `resolveChipPath` 用会话 cwd 解析成绝对路径再动手；解析不了（相对
   * 拼写 + 拿不到会话工作目录）时**明确告知**用户，不静默（见 `openFile` 的同段注释）。
   *
   * **目录不在那儿必须说一声**：VS Code 的 `revealInExplorer` 对不存在的路径只是什么
   * 都不做，静默就退化成「点了没反应」——本文件反复要避免的那种失败。措辞走界面词典的
   * `folderNotFound`，并带上**解析出来的绝对路径**（相对拼写对用户没有意义，他要的是
   * 宿主到底去哪儿找了）。
   *
   * 不复用 `openFile`：那条路是「打开文件」，拿目录去开会把目录当文件读，报的是
   * 「文件不存在」。这里只借它的路径解析口径，动作是 VS Code 自己的命令。
   */
  private async revealPath(viewId: string, path: string): Promise<void> {
    // 归属在发起这一刻捕获（下面有 await 的存在性检查），切走之后不该画进新会话
    const sessionId = this.viewSessions.get(viewId);
    const scope = this.scopeOfView(viewId);
    const resolved = resolveChipPath(scope ? this.cwdOf(scope) : undefined, path);
    if (!resolved) {
      this.log(`[reveal] 路径解析不了（相对且缺会话工作目录），放弃展开：${path}`);
      this.notify({
        sessionId,
        level: "warn",
        kind: "chipPathUnresolved",
        text: "@chipPathUnresolved",
      });
      return;
    }
    if ((await this.fileExistence(vscode.Uri.file(resolved))) === "absent") {
      this.log(`[reveal] 目录不存在，放弃展开：${resolved}`);
      // 目录路径是「关键内容」：不同目录各成一条，不会被合并成第一次那个
      this.notify({
        sessionId,
        level: "warn",
        kind: "folderNotFound",
        key: resolved,
        text: `@folderNotFound:${resolved}`,
      });
      return;
    }
    try {
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(resolved));
    } catch (error) {
      this.log(`[reveal] 展开失败 ${path}：${this.describeError(error)}`);
    }
  }

  /**
   * 「打开这枚附件」（界面上的芯片与用户消息里的图片缩略图点一下就走这里）。
   *
   * 界面只交身份，四步解析**从「最接近原件」到「最兜底」**，全在这一处：
   *
   * 1. `path`：原文件路径（路径通道进来的附件；回放消息也能从本地提交记录借到它）。
   *    打开的就是用户自己那个文件，之后他改了什么，这里看得见。
   * 2. 账本里那一条（`id` 命中草稿或提交租约）：`dataUrl`（粘贴 / 截图的字节）或
   *    **还没释放**的暂存字节，落一份临时副本再打开——这是「磁盘上从来没有过这个文件」
   *    的那一类唯一的机会（见 `dsh/attachmentOpen.ts` 的文件头）。
   * 3. `attachmentId`（durable 句柄）：先查宿主的上传索引与 `globalState` 里的持久记录
   *    （路径通道记原路径、字节通道上传成功时留的临时副本；记录跨宿主重启还在，见
   *    `dsh/attachmentOpenStore.ts`），命中且文件还在就直接开；否则图片再经 `session/attachment`
   *    换一次字节落临时副本（回放的历史图片走这条；服务端返回的是**归一化**过的副本，
   *    不是原始字节）。
   * 4. 都拿不到 → `@attachmentUnavailable`。**不静默**：点了没反应是最难查的失败。
   */
  private async openAttachment(
    viewId: string,
    message: { name: string; kind: "file" | "image"; path?: string; id?: string; attachmentId?: string; mediaType?: string },
  ): Promise<void> {
    const scope = this.scopeOfView(viewId);
    const cwd = scope ? this.cwdOf(scope) : undefined;
    // 归属在发起这一刻捕获：下面全是 await（字节换算、临时副本落盘），
    // 用户切走之后这条失败不该画进新会话
    const sessionId = scope?.sessionId;

    if (message.path && await this.tryOpenAttachmentPath(message.path, cwd)) return;

    // 账本里那一枚：只有草稿与乐观回显的 id 在这个命名空间里（durable 行的 `m<序号>` 落空）
    const entry = message.id ? this.attachments.find(message.id) : undefined;
    if (entry) {
      if (entry.attachment.path && await this.tryOpenAttachmentPath(entry.attachment.path, cwd)) return;
      const inline = entry.attachment.dataUrl ? parseBase64DataUrl(entry.attachment.dataUrl) : undefined;
      const bytes = inline?.bytes ?? entry.bytes;
      if (bytes) {
        const path = await this.materializeAttachmentCopy({
          bytes,
          name: entry.attachment.name,
          mediaType: inline?.mediaType ?? entry.attachment.mediaType,
        });
        if (path && await this.tryOpenAttachmentPath(path, cwd)) return;
      }
    }

    const durable = message.attachmentId ?? entry?.attachment.attachmentId;
    if (durable) {
      // 两处都查：内存索引里可能还挂着「临时副本正在落盘」，而这份记录也可能是**上一个
      // 宿主进程**留下的——那条就在 `globalState` 里，点一次现查一次（见
      // `dsh/attachmentOpenStore.ts`，文件附件没有回服务端取字节的第二条路）。
      const candidates = [
        await this.attachmentTargets.pathFor(durable),
        readAttachmentTarget(this.state, durable)?.path,
      ];
      for (const candidate of new Set(candidates)) {
        if (candidate && await this.tryOpenAttachmentPath(candidate, cwd)) return;
      }
      if (message.kind === "image" && scope) {
        const fetched = await this.fetchAttachmentBytes(scope.sessionId, durable);
        if (fetched) {
          const path = await this.materializeAttachmentCopy({
            bytes: fetched.bytes,
            name: message.name,
            mediaType: message.mediaType ?? fetched.mediaType,
          });
          if (path) {
            // 落下来的副本同样是「这条句柄的本地那一份」：下次点击不必再问一次线上
            // （但它不是用户的文件，悬停提示不拿它当路径，见 `readOriginalTarget`）
            this.rememberLocalTarget(durable, path, true);
            if (await this.tryOpenAttachmentPath(path, cwd)) return;
          }
        }
      }
    }

    this.log(
      `[open] 附件没有可打开的本地内容：name=${message.name} kind=${message.kind} ` +
        `path=${message.path ?? "-"} id=${message.id ?? "-"} attachmentId=${message.attachmentId ?? "-"}`,
    );
    this.notify({
      sessionId,
      level: "warn",
      kind: "attachmentUnavailable",
      text: "@attachmentUnavailable",
    });
  }

  /**
   * 附件的一条本地来路：解析不了、确认缺失或编辑器拒绝都交回解析链继续尝试。
   * 不借 openFile 的 void 判断成功，也不走它的 git 删除文件对比与中途提示。
   * stat 不确定不是缺失证据：仍可交给编辑器，只有命令完成才算打开成功。
   */
  private async tryOpenAttachmentPath(path: string, cwd: string | undefined): Promise<boolean> {
    const resolved = resolveChipPath(cwd, path);
    if (!resolved) return false;
    const uri = vscode.Uri.file(resolved);
    if (await this.fileExistence(uri) === "absent") return false;
    try {
      await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
      return true;
    } catch (error) {
      this.log(`[open] 附件路径打开失败 ${resolved}：${this.describeError(error)}`);
      return false;
    }
  }

  /**
   * 字节 → 内容寻址的临时副本 → 绝对路径（写盘失败给 undefined）。
   *
   * 临时目录取系统临时目录下的固定子目录：这份东西不是会话产物、不该进工作区，也不该
   * 落进扩展的持久状态。同一份内容重复点开只会写一次（路径由摘要决定）。
   */
  private async materializeAttachmentCopy(input: {
    bytes: Uint8Array;
    name: string;
    mediaType?: string;
  }): Promise<string | undefined> {
    try {
      return await materializeAttachment({
        root: attachmentTempRoot(tmpdir()),
        bytes: input.bytes,
        name: input.name,
        mediaType: input.mediaType,
      });
    } catch (error) {
      this.log(`[open] 附件临时副本落盘失败（${input.name}）：${this.describeError(error)}`);
      return undefined;
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
  private reportMissingFile(
    viewId: string | undefined,
    sessionId: string | undefined,
    resolved: string,
    fromLink: boolean,
  ): void {
    if (!viewId) return;
    // 归属是**发起打开那一刻**的会话（`sessionId` 由调用方捕获），不是完成时视图绑着谁；
    // 链接那条按文件成 key，同一份文件失败多次合并，不同文件各自成条
    this.notify({
      sessionId,
      level: "warn",
      kind: fromLink ? "fileNotFound" : "chipFileDeleted",
      key: fromLink ? resolved : "",
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
   * 「点了没反应」正是这条链路要避免的失败。归属是**点它的那个窗口当前那个会话**
   * （同文件芯片：多个面板开着时，别的会话不该看到这条）；这个函数里唯一的 await 之后
   * 不再读绑定，所以在这里捕获一次即可。
   */
  private async openExternal(url: string, viewId: string): Promise<void> {
    const sessionId = this.viewSessions.get(viewId);
    const refuse = (): void => {
      this.notify({
        sessionId,
        level: "warn",
        kind: "openExternalFailed",
        text: "@openExternalFailed",
      });
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
    const generation = this.subagentOrderGeneration;
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
        // 迟到的旧连接 / 旧域结果不许写目录，也不许经 `mergeSubagentEntries` 把
        // 已清理的血缘索引重新登记回来。
        if (this.client !== client || generation !== this.subagentOrderGeneration) return;
        if (this.scopes.get(scope.sessionId) !== scope) return;
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
      // 单飞表只删**自己这一条**：连接换代后同会话可能已经有新的请求在飞，
      // 旧任务收场时不能把新任务的登记一起抹掉。
      if (this.subagentRefreshes.get(scope.sessionId) === task) {
        this.subagentRefreshes.delete(scope.sessionId);
      }
    });
    this.subagentRefreshes.set(scope.sessionId, task);
    return task;
  }

  /**
   * 标题点击展开时的按需刷新（按该窗口绑定的会话）。
   *
   * 清单现在是**整棵多层树**（`subagentTree`，来自跨域血缘索引），所以打开时先补
   * 一份 `session/list`（不 await，不拖慢菜单）——那是父链与自身子代理身份的权威
   * 来路；同时刷新当前视图所属的那级目录，label / activity 也能更到最新：
   * 普通会话刷自己的目录；正在看子代理时刷父会话的（直接兄弟行）。
   */
  private async refreshSubagents(viewId: string): Promise<void> {
    const scope = this.scopeOfView(viewId);
    if (!this.client || !scope) {
      this.emitToView(viewId, { type: "subagents/list", entries: [] });
      return;
    }
    void this.refreshSubagentTitles();
    if (scope.subagentAddress) {
      // 子代理页：父域开着时 RPC 那条完整检索会并入父域并回推上下文；
      // 父域不在时投影 RPC 直接补快照
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
   * 用户 2026-10-20 口径：标题清单是整棵多层树，**点哪一层都算切换**（不再限定
   * 只能切兄弟）。目标的父会话与 `mode` 都从跨域血缘索引读：父层由
   * `session/list` 的 `parentSessionId` / 目录事件的父域给出，模式来自真实目录行。
   * 硬编码 `continuable` 打开 one-shot 子代理会被宿主以 `subagent/unauthorized`
   * 拒绝（address 是鉴权的一部分，不是提示）。
   */
  private async openSubagent(viewId: string, childSessionId: string): Promise<void> {
    if (!this.client) return;
    const scope = this.scopeOfView(viewId);
    if (!scope) return;
    // 已经在这个子代理上：什么都不做（重绑会把粘性显示值清掉后等不到回填）
    if (scope.sessionId === childSessionId) return;
    /**
     * 目标行、它的**真实父会话**与父目录种子。
     *
     * 用户 2026-10-20 口径：标题清单是整棵多层树，点任何一层都算切换（不再限制
     * 「只能切兄弟、层级不能变深」）。父会话与模式都从**跨域血缘索引**读——
     * 那里有 `session/list` 的 `parentSessionId` 与目录事件的真实 mode；硬编码
     * 模式会被 `subagent/unauthorized` 拒绝，猜父层则会把树画错。
     *
     * 命中的父目录同时作为 `openSession` 的种子随行：切换会回收当前域、新域建好
     * 那一刻父域多半已被回收，等不到投影 RPC 快照就要发（见 `ensureScope`）。
     */
    const resolve = (): { entry: SubagentView; parentId: string; catalog: SubagentView[] } | undefined => {
      const indexed = this.subagentIndex.get(childSessionId);
      if (indexed) {
        const parentId = indexed.parentSessionId;
        const catalog = this.orderedCatalog(this.subagentChildrenOf(parentId))
          .map((entry) => this.resolveSubagentDisplay(entry));
        const entry = catalog.find((item) => item.id === childSessionId)
          ?? this.resolveSubagentDisplay(this.subagentRowOfIndex(indexed));
        return { entry, parentId, catalog };
      }
      // 兜底：索引还没建立时沿用当前视图手里那份目录（旧路径的种子语义不变）
      const address = scope.subagentAddress;
      if (address) {
        const catalog = this.parentCatalogOf(scope);
        const sibling = catalog.find((entry) => entry.id === childSessionId);
        return sibling ? { entry: sibling, parentId: address.parentSessionId, catalog } : undefined;
      }
      const own = scope.subagentEntries.find((entry) => entry.id === childSessionId);
      return own
        ? { entry: own, parentId: scope.sessionId, catalog: this.orderedCatalog(scope.subagentEntries) }
        : undefined;
    };
    let hit = resolve();
    if (!hit) {
      // 索引缺这条：先按 `session/list` 重建整份血缘（跨进程 / 多层子代理都在那里），
      // 再按旧口径刷新当前视图所属的目录（label / activity 也要最新）
      await this.refreshSubagentTitles();
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
      // 归属是**发起时**那个会话（`scope` 在函数开头捕获），不是刷新之后的绑定
      this.notify({
        sessionId: scope.sessionId,
        level: "warn",
        kind: "subagentNotFound",
        key: childSessionId,
        text: "@subagentNotFound",
      });
      return;
    }
    this.log(`[subagents] 进入子代理 ${hit.entry.label}（${childSessionId}, ${hit.entry.mode}），父会话=${hit.parentId}`);
    // 地址的 mode 来自目录行 / 血缘索引：硬编码 `continuable` 打开 one-shot 子代理
    // 会被宿主以 `subagent/unauthorized` 拒绝（address 是鉴权的一部分，不是提示）。
    await this.openSession(viewId, childSessionId, {
      parentSessionId: hit.parentId,
      mode: hit.entry.mode,
    }, hit.catalog);
  }

  // ---------- 斜杠命令与文件提及 ----------

  /**
   * 窗口侧「列出命令」。
   *
   * 命令目录是**会话作用域**的（服务端 `commands/list` 按 `agentId` 查活跃 agent），所以
   * 空态也必须有会话——而空态窗口在进空态那一刻就绑在本工作区那条空壳上了
   * （见 `newSession` 与 `ensureSession`），这里只是兜一道「窗口就绪时还没连上」的底。
   * 这条兜底**不弹目录选择器**（用户 2026-09-24 拍板：菜单是随手打开的，弹一个系统
   * 对话框打断输入不合理），目录没定就回空菜单，由界面那句「未选择工作区」把原因说清楚
   * （`menuNoWorkspace`），选目录留在空态页那一行按钮上。
   *
   * 拿不到会话（目录没定、连不上）时回空菜单。界面那边不需要额外的「为什么空」字段：
   * 目录没定这件事在窗口快照的 `workspace.path` 里（空串 = 未选择），界面据此显示
   * 「未选择工作区」那句提示（`webview/composerCompletion`）。
   *
   * 允许拉起后台：「显式动作才许启动」那一档——用户要看命令栏，菜单空着等于这条能力
   * 不存在。
   */
  private async listCommandsForView(viewId: string): Promise<void> {
    const scope = await this.ensureSession(viewId, { start: true, askDir: false });
    if (!scope) {
      this.emitToView(viewId, { type: "commands/list", commands: [] });
      return;
    }
    await this.listCommandsFor(scope);
  }

  /** 斜杠命令目录；冷会话也能列。目录存到域上（各会话的菜单可以不同）。 */
  private async listCommandsFor(scope: SessionScope): Promise<void> {
    if (!this.client) {
      scope.commandsLoaded = true;
      this.deliver(scope.sessionId, { type: "commands/list", commands: [] });
      return;
    }
    try {
      const rows = await this.client.request<
        { name: string; definitionId?: string; description?: string; input?: { hint?: string } }[]
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
            definitionId: typeof row.definitionId === "string" ? row.definitionId : undefined,
            description: row.description ?? "",
            hint: row.input?.hint,
          })),
          ...(await this.skillCommands(scope)),
        ],
      });
    } catch (error) {
      this.log(`[commands] 列表获取失败：${this.describeError(error)}`);
      this.deliver(scope.sessionId, { type: "commands/list", commands: [] });
    } finally {
      // 「问过了」——成功或失败都算（失败的结论就是「手上这份目录是空的」，
      // 判据见 `SessionScope.commandsLoaded`）。失败不重试：目录会随连接的
      // `listCommandsFor` 那一轮重取。
      scope.commandsLoaded = true;
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
        skills?: { name?: string; path?: string; description?: string; whenToUse?: string }[];
      }>("skills/list", { request: { sessionId: scope.sessionId } });
      return (value?.skills ?? [])
        .filter((skill) => typeof skill?.name === "string" && skill.name)
        .map((skill) => ({
          name: skill.name!,
          description: skill.description ?? "",
          hint: skill.whenToUse,
          skillPath: typeof skill.path === "string" && skill.path.trim() ? skill.path : undefined,
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
   * 列，没有会话就没有候选），所以空态窗口同样得先绑在本工作区那条空壳上（见
   * `ensureSession`；这条兜底不弹目录选择器，理由与 `listCommandsForView` 同一条）。
   * 目录没定、连不上时回空列表（界面据窗口快照里的空工作目录显示「未选择工作区」）。
   *
   * **每次查询作废上一次**（`menuQueries`）：`@` 是每敲一个字符重取一次的，不作废
   * 就会同时压出一串全语料扫描，而且旧批次回来会把新列表盖掉。
   *
   * **两个源各自发帧**（官方 `dsh-client-ui-reference` 的 `@` 源同构）：文件那半是
   * 一次 `readdir`，对话候选要扫全部会话日志，两者差三个数量级（实测见 `ipc.ts`
   * 的 `files/list` 帧注释）。几毫秒就能画出来的目录内容不该等百毫秒级的对话候选。
   *
   * **对话候选只在工作区根目录列**（用户 2026-09-25 口径，刻意偏离官方 `@` 源：
   * 官方拿查询串去筛历史对话，于是进了目录也照样列）。进了某个目录时这一组连查都不查
   * ——那趟是全语料扫描，查了也只能丢掉；界面侧有同一条判据（`rankCandidates`），
   * 所以已经在飞的那一批也不会渲染出来。
   *
   * **这一块已经能引用到内容时，两个源都不查**（用户 2026-10-11 口径）：光标落在一条
   * 已经写好的引用里（`@src/a.ts`、`@[标题](dsh-session:…)`），宿主只回一条
   * `resolved: true` 的空帧，界面据此整块不弹（判据见 `mentionResolves`）——不查既省下
   * 那一趟，也让界面**当场**拿到判定、不必先闪一个列表出来。
   */
  private async queryFiles(viewId: string, query: string, sessionOnly = false): Promise<void> {
    this.menuQueries.get(viewId)?.abort();
    const controller = new AbortController();
    this.menuQueries.set(viewId, controller);

    const scope = await this.ensureSession(viewId, { start: true, askDir: false });
    // 落会话可能等了一会儿，期间用户又敲了字：这一次已经被作废，一个字节都不发
    if (!this.isCurrentMenuQuery(viewId, controller)) return;
    const client = this.client;
    // 一次查询冻结同一个执行目录：抑制、补列、信任门与回帧不能各自在 await 后读新值。
    const cwd = scope ? scope.workingDirectory ?? this.cwdOf(scope) : undefined;
    const queryScope = { ...(scope ? { sessionId: scope.sessionId } : {}), ...frameCwd(cwd) };
    const isCurrent = (): boolean => this.isCurrentMenuQuery(viewId, controller) &&
      (!scope || this.viewSessions.get(viewId) === scope.sessionId);
    // 本地 FS 预算**在首次本地 FS 操作之前**才开始计时：启动 / 恢复会话那几趟 RPC 的
    // 时间不该吃掉本地预算。一次查询只有这一条预算，信任门、抑制判定与目录读取共用，
    // 不逐步重新计时（见 `localAccess.ts`）。
    const budget = new LocalFsBudget(undefined, { signal: controller.signal });
    /**
     * 这次的本地发现许可（形状 + cwd 是本机目录的肯定证据）。
     *
     * **懒算且只算一次**：会话引用块与块已能引用的判定都不需要它，浏览入口也只在下发
     * 候选那一帧才需要——早算就会让一次纯会话查询白等一趟本机 stat。
     */
    let allowed: Promise<boolean> | undefined;
    const localAllowed = (): Promise<boolean> => {
      allowed ??= cwd && !sessionOnly ? this.localAccess.allows(cwd, budget) : Promise.resolve(false);
      return allowed;
    };
    // 编辑过的会话标题不能再按同名文件判断「已引用」，也不具有目录浏览语义。
    const resolves = !sessionOnly && scope
      ? await this.mentionResolves(query, budget, localAllowed, cwd)
      : false;
    if (!isCurrent()) return;
    if (resolves) {
      this.emitToView(viewId, { type: "files/list", query, items: [], resolved: true, ...queryScope });
      return;
    }
    const wantsSessions = sessionOnly || !isDirectoryQuery(query);
    if (!client || !scope) {
      this.emitToView(viewId, { type: "files/list", query, items: [], resolved: false, ...queryScope });
      if (wantsSessions) this.emitToView(viewId, { type: "files/sessions", query, sessions: [], ...queryScope });
      return;
    }
    // 两个源并行取。对话那条失败（老版本服务器没有这个 remote）不该把文件候选
    // 一起拖下水，所以各自兜住；作废导致的失败是**正常结果**，不进日志。
    const files = sessionOnly ? Promise.resolve([]) : client
      .request<{ path: string; kind: "file" | "directory" }[]>(
        "fileReferences/list",
        { agentId: scope.sessionId, query },
        60_000,
        controller.signal,
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.log(`[files] 查询失败：${this.describeError(error)}`);
        return [] as { path: string; kind: "file" | "directory" }[];
      });
    const sessions = !wantsSessions
      ? undefined
      : client
          .request<SessionReferenceCandidateWire[]>(
            "sessionReferenceResolver/candidates",
            { agentId: scope.sessionId, query },
            60_000,
            controller.signal,
          )
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              this.log(`[files] 对话引用查询失败：${this.describeError(error)}`);
            }
            return [] as SessionReferenceCandidateWire[];
          });

    // 文件那一帧是界面认「这是哪一次查询」的锚，所以它**永远先发**：这里只串起发帧
    // 顺序，两个 RPC 仍是并行的（对话候选慢，不影响文件那一帧什么时候出去）。
    const filesFrame = files.then(async (items) => {
      // 服务器一次最多回 20 条（`maxResults` 是插件配置，多要不到），目录列举那一路
      // 由这里把被截掉的尾巴按同一套排序补回来（见 `completeFileListing`）
      const complete = sessionOnly
        ? []
        : await this.completeFileListing(cwd, query, items ?? [], budget, localAllowed);
      if (!isCurrent()) return;
      this.emitToView(viewId, { type: "files/list", query, items: complete, resolved: false, ...queryScope });
    });
    await Promise.all([
      filesFrame,
      ...(sessions === undefined
        ? []
        : [
            filesFrame.then(() => sessions).then((rows) => {
              if (!isCurrent()) return;
              this.emitToView(viewId, {
                type: "files/sessions",
                query,
                ...queryScope,
                // @ 列表不显示子代理会话（用户 2026-09-22 口径）：候选行不带 origin，
                // 按 `subagentSessionIds` 客户端自己过滤（判据见 sessionList.ts）。
                // 还没开始对话的空会话同样不列：`@` 引用要的是**有内容的对话**，
                // 拿一条空壳做引用没有意义（连标题都还没有），身份只在客户端知道。
                sessions: visibleSessionCandidates(
                  rows ?? [],
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
            }),
          ]),
    ]);
  }

  /** 这一次 `@` 候选查询还是不是**当前那一次**（新的一次会 abort 旧的，见 `menuQueries`）。 */
  private isCurrentMenuQuery(viewId: string, controller: AbortController): boolean {
    return this.menuQueries.get(viewId) === controller && !controller.signal.aborted;
  }

  /**
   * 光标所在那个 `@` 块**是不是已经能引用到内容**（用户 2026-10-11 口径）。
   *
   * 是的话这一块就是一条现成的引用（不是待补全的查询），界面整块不弹候选列表、
   * 这里也不去查（见 `queryFiles`）。三条判据，按块的形态分派：
   *
   * 1. **浏览入口**（裸 `@`、以 `/` 或 `\` 结尾的路径）恒为「否」——那种形态的意思就是
   *    「进去看这一层」，目录在不在都要能进去（`shared/mentions.ts` 的 `isBrowseQuery`）；
   * 2. **对话引用 token**（`[标题](dsh-session:…)` 或裸 `dsh-session:…`）→ 解出会话 id，
   *    看这条会话还在不在。判据用**两份**账本：`sessionCwds` 是 `session/list` 原始行建的
   *    权威账本（**任何可见性过滤之前**），`sessions` 是按窗口收窄之后的历史列表——只认
   *    后者会漏掉**别的项目**的会话引用，而 `@` 候选来自服务端全量会话（按 cwd 亲缘排序，
   *    不按窗口收窄），引用一条别的项目的会话完全合法。**打一个裸会话 id
   *    （`@session-…`）不算**：它不是服务端认的引用形态，那仍然是「在检索会话」，列表该弹
   *    ——用户 2026-10-11 报的现场正是它不弹了；
   * 3. **其余按路径**：去掉行号区间（`@src/a.ts#L12-L40` 指的仍是那个文件），绝对路径
   *    原样、相对路径按**会话工作目录**解析，`stat` 得到才算在（判据与文件芯片分类同源：
   *    只有明确报「找不到」才算不在，其它异常一律按「不确定」→ 弹列表，见
   *    `probeExistence` 的三态）。**不支持的根 / 盘符形态**（Windows 上的单根相对
   *    `/foo`、驱动器相对 `D:foo`，POSIX 宿主上的盘符 / 设备命名空间写法）不参与本地
   *    推断——它们不相对会话 cwd，`join(cwd, …)` 会拼出用户没指的路径（见
   *    `localAccess.isNativeAbsolutePath` 的相邻判据 `unsupportedLocalPathForm`）。
   *
   * **文件路径这一条新增同一道信任门**（用户 2026-10-18 口径）：门关时不凭本机 `stat`
   * 抑制候选——远端 / WSL 部署下本机看到的「这个文件在」对执行世界没有意义，那种部署里
   * 列表宁可照旧弹（`@` 仍可手写、照旧能发）。会话引用那一条不过门，继续按会话账本判。
   *
   * 拿不到证据（门关、没有会话工作目录、路径解析不了、`stat` 报的是未知错误）一律返回
   * `false`：**宁可弹列表**——那块本来就可能是个要检索的片段，而把列表按住的代价是
   * 用户彻底看不到候选。
   */
  private async mentionResolves(
    query: string,
    budget: LocalFsBudget,
    localAllowed: () => Promise<boolean>,
    cwd: string | undefined,
  ): Promise<boolean> {
    if (isBrowseQuery(query)) return false;
    const sessionId = referenceSessionIdOf(query);
    if (sessionId !== undefined) {
      // 会话列表由 `ensureSession` 保证已拉过（空表时它会先 refreshSessions，见
      // `reuseOrCreateBlank`）：两份账本里都没有，就是这条会话已经不在了。
      return this.sessionCwds.has(sessionId) || this.sessions.some((row) => row.id === sessionId);
    }
    const path = mentionPathOf(query);
    if (path === "") return false;
    // 不支持的根 / 盘符形态（Windows 上的单根相对 `/foo`、驱动器相对 `D:foo`，以及
    // POSIX 宿主上的盘符 / 设备命名空间写法）：**不做本地推断**。它们不是相对会话 cwd
    // 的路径（`join(cwd, "/foo")` 会拼出一个用户没指的 `cwd/foo`），本机恰好同名的文件
    // 会把它误抑制成一条已解析引用。宁可弹列表：服务器候选与手写引用照旧。
    if (unsupportedLocalPathForm(path, hostPlatform())) return false;
    if (!(await localAllowed())) return false;
    const absolute = isNativeAbsolutePath(path, hostPlatform()) ? path : cwd ? join(cwd, path) : undefined;
    if (absolute === undefined) return false;
    return (await probeExistence(absolute, budget)) === "present";
  }

  /**
   * 目录列举的**补全**：服务器只回前 20 条，这里把被截掉的尾巴补在它们后面。
   *
   * 为什么会有这个上限：官方 `WorkspaceFileSearch.list()` 在「查询是空串或以 `/` 结尾」
   * 时走 `listDirectory`，而它末尾同样过 `rankCandidates(candidates, fragment, maxResults)`
   * ——目录列举也被 `DEFAULT_FILE_SEARCH_MAX_RESULTS`（20）截断；全局模糊查询同样是 20 条。
   * `maxResults` 是 dsh 插件的**配置**，不是每次请求的参数（扩展侧只能发
   * `{ agentId, query }`），所以多要不到，只能自己补齐（见 `dsh/fileRefListing.ts`）。
   *
   * **服务器那 20 条一条不动、顺序不动**：只按 path 去重后往后追加。fragment 为空时
   * 每条候选的分数都是 0（官方 `scoreCandidate` 对空查询第一行就返回 0），排序退化为
   * 「目录在前、文件在后」+ 路径的 code-unit 比较，是确定性的——所以「服务器排好的前
   * 20 条」正是正确顺序的前缀，拼接之后整体仍是这一个正确的字母序。
   *
   * **fragment 非空（用户在目录里打了筛选字）时一律不补**：那种查询服务器按 fuzzy 分数
   * 排序，本地复现不出来，硬拼只会得到两段规则不同的清单（那一半保持原样，见
   * `listingTarget` 的肯定证据判据）。
   *
   * 枚举用的是这次查询冻结的**执行目录**（服务器那次查询的根，它不一定是 VS Code 打开的文件夹）；
   * 任何一步失败都静默退回服务器结果，`@` 列表绝不会因此变空或把错误抛上去。
   *
   * **工作区外的发现**（M1 绝对路径 / M3 相对 `..`）由同一趟补进来，但只在信任门通过
   * （`outsideAllowed`）时参与。
   */
  private async completeFileListing(
    cwd: string | undefined,
    query: string,
    items: FileRefView[],
    budget: LocalFsBudget,
    localAllowed: () => Promise<boolean>,
  ): Promise<FileRefView[]> {
    if (!cwd) return items;
    const outsideAllowed = await localAllowed();
    // 预算可能已经被信任门那一趟耗尽（不可达的网络 cwd）：保守不补，且**不重建 deadline**
    // ——重建就等于把 1500ms 的总预算变成「每一步各自计时」。
    if (!budget.usable()) return items;
    // M2：裸 `@` 那一层多一行「上一层」（cwd 的父目录，绝对形态）。它由宿主下发、
    // **排在服务器那几条之前**（列表顶部那一行，键盘上下第一下就够得到），只在门通过、
    // 查询为空串、父目录在本机确实是目录时出现；cwd 就是盘根 / 共享根时不发（没有上一层），
    // 父目录是盘根时照发（`@D:/` 是可浏览的一层）。任何一步失败都只是「没有这一行」，
    // 服务器结果一条不动（见 `docs/design-mentions.md`「三种入口」的 M2 口径）。
    const parent = query === "" && outsideAllowed && !items.some((item) => item.parent === true)
      ? await parentDirectoryEntry({ cwd, budget })
      : undefined;
    const extra = await missingDirectoryEntries({ cwd, query, known: items, budget, outsideAllowed });
    const head: FileRefView[] = parent
      ? [{ path: parent.path, kind: parent.kind, parent: true }]
      : [];
    if (!extra.length) return [...head, ...items];
    return [...head, ...items, ...extra.map((entry): FileRefView => ({ path: entry.path, kind: entry.kind }))];
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
      // 「在浏览器中打开」是窗口级动作，不属于任何会话 → 共享通知（所有视图都看得到）
      this.notify({ level: "warn", kind: "openInBrowserOffline", text: "@openInBrowserOffline" });
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
      this.notify({ level: "warn", kind: "openInBrowserFailed", text: "@openInBrowserFailed" });
    }
  }

  /**
   * 「打开 DSH 桌面端」：把桌面端应用拉起来（已在跑时它自己的单实例会聚焦已有窗口）。
   *
   * 这颗按钮只在**当前连的就是桌面端内置服务**时顶替「在浏览器中打开」（见
   * `ChatState.desktopConnected`）：桌面端内置服务对浏览器是关着的——它只认自己那份
   * 按进程生成的启动令牌，浏览器那条路只会得到一页 401（见 `docs/design-desktop.md`
   * 「浏览器访问」）。而桌面端应用本来就在这台机器上，打开它既是对同一件事的正确入口，
   * 也不动连接（连的还是那一个服务进程）。
   *
   * 起不来时只报一次（窗口级动作 → 共享通知）：失败属**启动类**，不自动重试。
   */
  private async openDesktop(): Promise<void> {
    try {
      await this.server.openDesktopApp();
    } catch (error) {
      const detail = error instanceof DesktopStartError ? error.detail : String(error);
      this.log(`[desktop] 打开 DSH 桌面端失败：${detail}`);
      this.notify({ level: "warn", kind: "desktopSpawnFailed", text: `@desktopSpawnFailed:${detail}` });
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
    // 作废在途轮（迟到的完成一律静默让位）+ 收跟随流 + dispose 客户端：三件事的顺序在
    // 模块里定死（见 `ConnectionAttempts.dispose`），这里不再自己排
    this.attempts.dispose();
    // 附件草稿的归属账本（含拖放 / 粘贴那份暂存字节）随停用一起清：长期存活的扩展宿主
    // 里不能留下没有任何窗口能再读到的内存
    this.attachments.dispose();
    // 跟随流的重试状态也一起收：待触发的重开 timer 不许活过扩展卸载
    for (const sessionId of [...this.followRetryTimers.keys(), ...this.followRetries.keys()]) {
      this.closeFollowRetry(sessionId);
    }
    this.followGenerations.clear();
    // 标题账本的防抖 timer 也不许活过扩展卸载（在途的那次请求已由上面的 dispose 收掉）
    if (this.subagentTitlesTimer !== undefined) clearTimeout(this.subagentTitlesTimer);
    this.subagentTitlesTimer = undefined;
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

