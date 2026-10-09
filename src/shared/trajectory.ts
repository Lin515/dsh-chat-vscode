/**
 * 「轨迹」（trajectory）视图的**线格式与视图模型**。
 *
 * 官方的轨迹视图**不是**一个服务端接口、也不是投影：它是客户端对**同一份
 * durable 会话事件窗口**做的**第二次独立折叠**（`dsh-client-ui-trajectory` 的
 * 8 个 `ConversationNodeDefinition` 各自把事件折成 `TrajectoryContribution`，
 * `TrajectorySnapshotBuilder` 合并，`TrajectoryView` 再折成 turn → group → cell
 * 的账本 + 时间线 + 详情检查器）。所以本扩展要做的是**同一件事的第二遍折叠**，
 * 而不是新增调用——我们已经收到全部需要的 durable 事件（见 `dsh/trajectory.ts`）。
 *
 * 记录种类（`TrajectoryCellKind`）与各字段语义**逐字对齐**官方契约
 * （`dsh-client-ui-trajectory/lib/types/client/trajectory-record.d.ts`），
 * 去掉 React 相关的部分。空值语义也照抄：`timeSeconds` / `startedAt` 用 `null`
 * 表示「不知道」，不是 0。
 */

/** 一行的种类（官方 `TrajectoryCellKind`）。 */
export type TrajectoryCellKind =
  | "system"
  | "user"
  | "context"
  | "compacted"
  | "message"
  | "tool"
  | "subtool";

/**
 * 「这次压缩在完成前被中断」的**合成错误码**（官方 `copy-codes.ts` 的
 * `COMPACTION_INTERRUPTED`，逐字同值）。
 *
 * 会话在压缩跑到一半时结束（`session/end-seed`）就会得到它——这不是服务端报的错，
 * 而是客户端按官方 `interruptCompactions()` 的规则**合成**的：边界之前仍在跑的
 * 压缩请求要以它为 `error` 收尾。界面按它取那一句专用文案（而不是笼统的「压缩失败」）。
 */
export const TRAJECTORY_COMPACTION_INTERRUPTED = "trajectory.compaction-interrupted";

/** 助手记录的计时事实（官方 `AssistantMetricDetail`）。 */
export interface TrajectoryAssistantMetrics {  timingRecorded: boolean;
  stepStartTime: number | null;
  firstTokenTime: number | null;
  completedTime: number | null;
  usageProvided: boolean;
  outputTokens: number | null;
}

/** 调用时模型看到的工具 Schema（详情面板的 Schema 页签）。 */
export interface TrajectoryToolSchema {
  name: string;
  description?: string;
  /** 原始 JSON Schema（原样传给界面，由 JSON 树渲染）。 */
  parameters?: unknown;
}

/** 请求选项（详情面板的「选项」页签）。 */
export interface TrajectoryRequestOptions {
  provider?: string;
  model?: string;
  purpose?: string;
  thinking?: string;
  reasoningEffort?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

/**
 * 记录级用量（官方 `TrajectoryCellProps` 的 `input` / `cacheRead` / `cacheWrite` /
 * `output` / `think` 五个散字段）。字段名与官方**记录**契约一致（注意官方的
 * **请求级**用量 `TrajectoryUsage` 把推理那桶叫 `reasoning`，两者不是同一个形状）。
 */
export interface TrajectoryUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  think?: number;
}

/**
 * 请求级用量（官方 `TrajectoryUsage`，`TrajectoryTable.d.ts`）。
 *
 * 与记录级那个形状的差别只有推理桶的名字（`reasoning` ↔ `think`）——官方自己
 * 就是两套：记录走 `TrajectoryCellProps` 的散字段，请求走这个对象。
 */
export interface TrajectoryRequestUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
}

/** 请求的用途：普通生成，或上下文压缩。 */
export type TrajectoryRequestPurpose = "assistant" | "compaction";

/**
 * 一次**模型请求**（官方 `TrajectoryRequestNumber`，`TrajectoryTable.d.ts`）。
 *
 * 官方这份数据来自客户端会话层的 `RequestView[]`（`ui-conversation` 折出来的
 * `{startSeq, startedAt, completedAt, status, usage, …}`），本扩展没有那一层，
 * 所以按官方同一份判据从 durable 事件自己折：`step/start` 的开帧时刻是
 * `startedAt`、`llm/retry` 给重试进度与失败、`assistant/message` 的 `usage`
 * 与 `message.source` 给用量与提供方身份、`step/end` 给收尾。
 *
 * 与官方的**已知差异**：官方 `usage` 在流式过程中由 `assistant/live-chunk` 的
 * usage 分片累加，本扩展只在结算帧（`assistant/message`）拿一次；重试被
 * `llm/retry` 重置过的那一段用量因此不计入。
 */
export interface TrajectoryRequest {
  /** 会话内**全局**请求编号（「请求 #N」）；压缩请求也占号。 */
  number: number;
  purpose: TrajectoryRequestPurpose;
  /** 所属轮次；`null` = 轮次之间（独立压缩段）。 */
  turn: number | null;
  /** 轮内步骤号；压缩请求官方固定为 0。 */
  step: number;
  /** 开帧事件的 seq（跨记录定位；流式中的请求官方缺席，本扩展用它当身份）。 */
  seq: number;
  /** 请求真正开始的时刻（官方取 `step/start` 的事件时刻）。 */
  startedAt: number | null;
  /** 收尾时刻；`null` = 还在跑。 */
  completedAt: number | null;
  status: "running" | "complete" | "error";
  /** 错误文案（`llm/retry` 的失败消息；`AUTH` 码下官方会抹掉文案）。 */
  error?: string;
  /** 稳定的提供方错误码（官方按它把 `AUTH` 归成「API 密钥无效」）。 */
  errorCode?: string;
  /** 重试进度：第几次、最多几次。 */
  retry?: { attempt: number; max?: number };
  /** 下一次重试的延迟（毫秒）。 */
  retryDelayMs?: number;
  /** 该请求的用量合计。 */
  usage?: TrajectoryRequestUsage;
  /** 从会话开头到这个请求为止的累计用量（官方 `cumulativeUsage`）。 */
  cumulativeUsage?: TrajectoryRequestUsage;
  /** 提供方 / 模型（`request/header` 的 config，或助手消息的 `source`）。 */
  provider?: string;
  model?: string;
  /** 请求选项（`request/header` 的 config；没有那一帧时缺席）。 */
  options?: TrajectoryRequestOptions;
  /**
   * 这次请求的首个 token 时刻（TTFT / 吞吐量的分子）。
   *
   * 官方那一份挂在**助手记录**上（`AssistantMessageNode.timing.firstTokenTime`），
   * 请求级计时面板也是从那条记录取的（官方 `RequestTiming` 的第一分支），
   * 本扩展从 2026-10-05 起同样如此（`Trajectory.tsx` 的 `RequestTimingPanel`）。
   * 所以这一份**界面已经不再消费**，留着的原因是：`assistant/attempt` 与
   * `assistant/message` 两条来源「先到者胜」的结算口径要在宿主侧独立钉住
   * （`scripts/trajectory.test.ts` 直接断言它），而账本行的
   * `assistantMetrics.firstTokenTime` 走的是同一段结算。
   */
  assistantFirstTokenTime?: number | null;
}

/** 记录来源（`user/message` 的 `source`，用于「来源」页签与来源标签）。 */
export interface TrajectoryMessageSource {
  kind?: string;
  plugin?: string;
  round?: number;
  /** 原始 source 对象（原样给 JSON 树）。 */
  raw?: unknown;
}

/**
 * 「既没有正文也没有思考」时官方 `summarizeAssistantActivity()` 算出的摘要。
 *
 * **传语义、不传文案**：官方那份折叠跑在浏览器里，`text` 直接就是本地化后的
 * 「仅工具调用」；本扩展的折叠跑在扩展宿主，不知道界面语言（宿主 → 界面的用户可见
 * 文字一律走语义 / `@key` 标记，见 AGENTS.md）。界面侧按这里的分支取对应词条。
 */
export type TrajectoryEmptySummary =
  /** 只有工具调用 → 账本行显示 `record.toolCallOnly`（「（仅工具调用）」）。 */
  | { kind: "tool-call" }
  /** 只有图片 → 账本行显示 `layout.imageCount`。 */
  | { kind: "images"; count: number };

/** 系统提示词变更的四种情形（官方 `RequestPromptChange.kind`）。 */
export type TrajectoryPromptChange = "initial" | "system" | "tools" | "system-and-tools";

/**
 * 用户/上下文行的**附件摘要**语义（官方布局层把 `layout.imageCount` 与
 * `layout.fileAttachments` 拼成 `text`，例如「图片 ×2 · 文件 ×1」）。
 *
 * 与 `emptySummary` 同一个理由：宿主不知道界面语言，只传计数。
 */
export interface TrajectoryAttachmentSummary {
  images: number;
  files: number;
}

/**
 * 工具结果的**语义摘要**（官方 `summarizeResult` 的两条非正文分支：
 * 只有图片 → `layout.imageCount`；什么都没有 → `record.noOutput`）。
 *
 * 有正文时官方给 `resultPreviewMarkdown`（原文），不用这个标记。
 */
export type TrajectoryResultSummary = { kind: "images"; count: number } | { kind: "no-output" };

/**
 * 工具目录变更的**语义**（官方 `layout.toolAdded` 那一族）。
 *
 * 官方在这个位置放的是**本地化文案**（「已添加工具：X」/「工具已更新 · 新增 3 个」），
 * 而本扩展的折叠跑在扩展宿主、不知道界面语言——所以只给名字与计数，文案在
 * `trajectoryDisplay.ts` 按官方那张表拼。
 */
export interface TrajectoryToolUpdate {
  added: string[];
  removed: string[];
}

/**
 * 附件引用在原始块里的**结构子集**（官方 `ImageAttachmentRef` / `FileAttachmentRef`）。
 *
 * 只声明我们这侧用得上的那一面（`name`，索引签名留给其余字段），与
 * `src/vendor/ui-trajectory/trajectory-record.ts` 里那两个就地声明的类型**结构一致**
 * ——适配层要把这个形状直接交给 vendor 的 `TrajectoryCellProps`，多一层不兼容就编译不过。
 */
export interface TrajectoryAttachmentRef {
  name?: string;
  [key: string]: unknown;
}

/**
 * 原始内容块（官方 `TrajectorySourceBlock`；详情面板与搜索索引用）。
 *
 * 官方的 `sourceBlock()` 只从块里取 `type` 与 `text`，**其余字段序列化进 `content`**；
 * `callId` / `toolName` 是**别处**写进去的（工具目录变更那一支），普通内容块上没有。
 * `attachment` 只在 `image` / `file` 块上出现，这里保留原对象、不做形状校验。
 */
export interface TrajectorySourceBlock {
  type: string;
  content: string;
  /** `image` 块的附件引用。 */
  attachment?: TrajectoryAttachmentRef;
  /** `file` 块的附件引用。 */
  file?: TrajectoryAttachmentRef;
  callId?: string;
  toolName?: string;
}

/** 账本里的一行。 */
export interface TrajectoryCell {
  /** 1 基序号，官方在「#N」里显示的就是它。 */
  index: number;
  kind: TrajectoryCellKind;
  /** 所属轮次；`null` = 轮次之间（例如会话结束、独立压缩段）。 */
  turn: number | null;
  /** 本源事件的 seq（跨记录定位用）。 */
  seq: number;
  time: number;
  /** 单行摘要（超出省略号）。 */
  text: string;
  /** 没有正文也没有思考时的摘要语义（官方 `layout.toolCallOnly` / `layout.imageCount`）。 */
  emptySummary?: TrajectoryEmptySummary;
  /** 附件计数摘要（官方把图片/文件计数拼在预览前面）。 */
  attachments?: TrajectoryAttachmentSummary;
  /** 系统提示词这一行为什么出现（官方 `RequestPromptChange.kind`），文案在界面侧取。 */
  promptChange?: TrajectoryPromptChange;
  /** 工具目录变更（官方 `layout.toolAdded` 一族）；文案在界面侧取。 */
  toolUpdate?: TrajectoryToolUpdate;
  /** 原始内容块（官方 `TrajectorySourceBlock`；搜索索引与详情面板用）。 */
  sourceBlocks?: TrajectorySourceBlock[];
  /** 原始 Markdown（预览页签用）；没有就不给。 */
  previewMarkdown?: string;
  /** 这条用户消息是否开启了一个新的模型轮次。 */
  opensTurn?: boolean;
  /**
   * 这条用户消息是**生成过程中插进队**的引导消息（官方节点层的 `kind: 'steering'`）。
   *
   * 分类由 `src/vendor/ui-trajectory/inbox-state.ts`（官方那台状态机）判定：命中
   * 「本次领取」的 id 集合即为 steering。官方在**布局层**把它与真用户消息一视同仁地
   * 渲染成 `kind: 'user'`（同样走 `inputCellDetail`），差别只有**不置 `opensTurn`**——
   * 所以这个标记在本扩展里同样不改变一行的外观，它是**模型事实**（供断言与后续的
   * 轮/步摆放使用）。
   */
  steering?: boolean;
  /** 请求边界锚点（官方在 event 列左侧画一枚小标记）；无需可见记录的辅助请求用。 */
  requestOnly?: boolean;
  /** 该行所属的请求编号（「请求 #N」）。 */
  requestNumber?: number;
  /** 轮内步骤号。 */
  step?: number;
  /** 来源（`user` 与 `context` 行会显示来源标签）。 */
  messageSource?: TrajectoryMessageSource;

  /** 完整输入（详情面板）。 */
  inputDetail?: string;
  /** 完整输出 / 工具结果（详情面板）。 */
  outputDetail?: string;
  /** 助手的思考正文（详情面板）。 */
  thinkingDetail?: string;
  /** 系统提示词正文（`system` 行）。 */
  systemPromptDetail?: string;
  /** 「上一次」的系统提示词（`system` 行是更新时用于差异对照）。 */
  previousSystemPromptDetail?: string;
  /** 该请求生效的工具目录（`system` 行）。 */
  toolsDetail?: TrajectoryToolSchema[];
  /**
   * 这次系统行**替换掉的那一份**工具目录（官方 `previousPromptDetail.tools`）。
   *
   * 与 `previousSystemPromptDetail` 配对——两者合起来才是官方那个 `{system, tools}` 快照。
   * 「对照」页签的工具目录那一节要**改动前 vs 改动后**：拿改动前的 system 与改动后的
   * tools 拼一份是错的对照，所以宿主记下了才有（初始那一行、或上一次没带目录时缺席，
   * 界面按「缺席就不出这一节」处理）。
   */
  previousPromptTools?: TrajectoryToolSchema[];
  /**
   * 调用时模型看到的这个工具的 Schema，**已序列化成 JSON 文本**（官方 `schemaDetail`）。
   *
   * 官方在装配层按「这次调用之前最近一次 `request/header`」的目录把 schema 挂到**调用格**
   * 上（`attachToolSchema()`），所以它是**逐调用**的事实；列表上那条「调用时的目录」回查
   * 会在目录变更后给出错的那一份。序列化交给宿主做，界面不再自己 `JSON.stringify`。
   *
   * 搜索索引按它索引（工具名 / 描述 / 参数名都能搜到）。
   */
  schemaDetail?: string;
  /** 该请求的选项（`system` 行的「选项」页签）。 */
  optionsDetail?: TrajectoryRequestOptions;

  /** 工具结果摘要（与 `text` 里的「请求」组成 `请求 → 结果` 两列）。 */
  result?: string;
  /**
   * 工具结果的**原始 Markdown**（官方 `resultPreviewMarkdown`）。
   *
   * 官方列表里那一栏显示的是它的预览（`trajectoryPreviewText`），不是宿主截好的
   * 摘要——宿主只存原文，截断口径在界面侧（`trajectoryDisplay.ts`）。错误结果
   * 用 `result` 存错误码、不给这一项。
   */
  resultPreviewMarkdown?: string;
  /** 工具结果没有正文可用时的语义摘要（只有图片 / 什么都没有）。 */
  resultSummary?: TrajectoryResultSummary;
  /** 工具调用 id（把助手正文里的调用与工具行连起来）。 */
  callId?: string;
  /** 工具名（`tool` / `subtool` 行；行文本与检查器标题用。Schema 页签吃的是逐调用的 `schemaDetail`）。 */
  toolName?: string;
  /** 工具是否失败。 */
  isError?: boolean;

  /** 自身耗时（秒）；`null` = 不知道。 */
  timeSeconds: number | null;
  /** 操作真正开始的时刻（Unix ms）；`null` = 不知道。 */
  startedAt: number | null;
  /** 请求状态（时间线着色与详情「状态」）。 */
  status?: "running" | "complete" | "error";
  /** 错误文案（`turn/end` 的 error / 压缩中断 / 工具失败原因）。 */
  error?: string;

  usage?: TrajectoryUsage;
  /** 助手记录的计时事实。 */
  assistantMetrics?: TrajectoryAssistantMetrics;
  /**
   * 这条助手消息发起的工具调用 id（顺序即模型发出的顺序）。
   *
   * 界面侧「层级跳转」的反向链接用它：工具记录 → 它是哪条助手消息发起的
   * （官方 `parentRecords()` 吃助手格的 `sourceBlocks[].callId`，我们只摘 id——
   * 那个字段是搜索索引的大件，见 `docs/design-trajectory.md`）。
   */
  callIds?: string[];
  /** 模型标识（详情「提供方 / 模型」）。 */
  provider?: string;
  model?: string;
  /** 重试进度（「重试 2/5」）；`max` 缺失时只显示是第几次。 */
  retry?: { attempt: number; max?: number };
}

/**
 * 一组的**标题语义**（官方 `group.message` / `group.step` / `group.compaction` 三条文案）。
 *
 * 传语义而不是文案：官方那份折叠跑在浏览器里，`group.title` 直接就是本地化后的
 * 「消息」/「第 2 步」；本扩展的折叠跑在扩展宿主，不知道界面语言（宿主 → 界面的
 * 用户可见文字一律走语义，见 AGENTS.md）。界面侧按 `kind` 取对应词条。
 */
export type TrajectoryGroupTitle =
  | { kind: "message" }
  | { kind: "step"; step: number }
  | { kind: "compaction"; seq: number };

/**
 * 一轮里的一组（官方 `TrajectoryGroupModel`）。
 *
 * 组是**连续同类记录**的容器：`message` 组装用户 / 上下文 / 系统 / 轮内第 0 步的助手
 * 记录，每个 `step` 各成一组（助手记录与它发起的工具行），独立压缩段自成一组。
 * 官方**不渲染组头**（`TrajectoryGroupHeader` 是无人 import 的死组件），组标题只用在
 * 检查器落点与搜索索引字段上——所以这一层没有 `description`（官方那个组描述同样只被
 * 死组件消费）。
 */
export interface TrajectoryGroup {
  title: TrajectoryGroupTitle;
  cells: TrajectoryCell[];
}

/** 一轮（或「轮次之间」的一段）。 */
export interface TrajectoryTurn {
  /** `null` = 不属于任何轮次（官方 `section.betweenTurns`）。 */
  turn: number | null;
  groups: TrajectoryGroup[];
}

/** 一轮里的全部记录（按组顺序摊平）——官方各处都是 `turn.groups.flatMap(g => g.cells)`。 */
export function trajectoryTurnCells(turn: TrajectoryTurn): TrajectoryCell[] {
  return turn.groups.flatMap((group) => group.cells);
}

/** 时间线的泳道（官方只用了三条，且只有标签用到了「输入/模型/工具」）。 */
export type TrajectoryLane = 0 | 1 | 2;

/** 宿主推给界面的整份轨迹模型。 */
export interface TrajectoryModel {
  turns: TrajectoryTurn[];
  /**
   * 请求表（官方 `TrajectoryRequestNumber[]`），**按 `number` 升序**。
   *
   * 账本行只带 `requestNumber`（一个号），请求级事实（选项 / 用量含会话累计 /
   * 计时）都在这张表里——界面点开某一行的请求标记时按键取；不在行上复制一份，
   * 免得同一份事实两处漂移。
   */
  requests: TrajectoryRequest[];
  /** 记录总数（工具栏/计数用）。 */
  cellCount: number;
  /** 时间线模式 `duration` 下的域：总时长（秒）。 */
  totalSeconds: number;
  /** 最早一条记录的时刻（时间线 `time` 模式的域起点）。 */
  firstStartedAt: number | null;
  /** 是否还有更早的记录没加载进来。 */
  hasOlder: boolean;
}

/** 时间线模式：官方工具栏的「时长」开关与「实际时间」开关的组合。 */
export type TrajectoryTimelineMode = "sequence" | "duration" | "actual" | "time";

/** 行在时间线上属于哪条泳道（官方 `laneFor` 逐字）。 */
export function trajectoryLane(kind: TrajectoryCellKind): TrajectoryLane {
  if (kind === "tool" || kind === "subtool") return 2;
  if (kind === "message" || kind === "compacted") return 1;
  return 0;
}

/**
 * 时间线视口的坐标换算：**归一化域位置 ⇄ 屏幕比例**。
 *
 * `zoom` 是放大倍数（1 = 整个域正好铺满绘图区），`offset` 是视口左边界在域里的位置；
 * `screen = (value - offset) * zoom`。
 *
 * 缩放过之后这两套坐标**不再相等**：选区存的是**域位置**（与账本行、与 `left`/`width`
 * 同一套坐标），画的时候过一次 `trajectoryScreenFraction`，而左键框选是从鼠标位置反向
 * 算出域位置。**必须**这么分——2026-09-15 用户报的「缩放后左键框选的区域与手划的区域
 * 对不上」就是漏了这一步：选区按屏幕比例记下来、又当域位置画出去，缩放越大偏得越离谱。
 *
 * 纯函数，断言见 `scripts/trajectory.test.ts`。
 */
export function trajectoryScreenFraction(value: number, offset: number, zoom: number): number {
  return (value - offset) * zoom;
}

/** 屏幕比例 → 归一化域位置（上面那个的逆运算，夹在 0..1 的域内）。 */
export function trajectoryDomainPosition(fraction: number, offset: number, zoom: number): number {
  return Math.min(1, Math.max(0, offset + fraction / zoom));
}

/**
 * 时间线的投影**不在这里**：官方那份（`deriveTrajectoryTimeline` / `deriveTimedTimeline` /
 * `trajectoryTimelineFocusIndexes`）已逐字 vendor 进 `src/vendor/ui-trajectory/timeline.ts`，
 * 本扩展的账本经 `src/webview/trajectoryTimeline.ts` 适配 + 归一化后使用。
 *
 * 从前这里有一份「等价实现」，它的 `duration` 分支曾经把**原始 Unix 毫秒**当域值除以压缩
 * 后的总时长（量级差 1e6 倍），渲染端的域内过滤把每一根轮次边界都丢掉——「时长」模式下
 * 概览条一根轮次线都没有。这类「手工搬运」的漂移正是 vendor 要消掉的东西：现在只有一份
 * 实现，且它是上游逐字副本。
 */
