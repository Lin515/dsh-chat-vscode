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

/** 助手记录的计时事实（官方 `AssistantMetricDetail`）。 */
export interface TrajectoryAssistantMetrics {
  timingRecorded: boolean;
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

/** 请求用量（详情面板的「用量」页签）。 */
export interface TrajectoryUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  think?: number;
}

/** 记录来源（`user/message` 的 `source`，用于「来源」页签与来源标签）。 */
export interface TrajectoryMessageSource {
  kind?: string;
  plugin?: string;
  round?: number;
  /** 原始 source 对象（原样给 JSON 树）。 */
  raw?: unknown;
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
  /** 原始 Markdown（预览页签用）；没有就不给。 */
  previewMarkdown?: string;
  /** 这条用户消息是否开启了一个新的模型轮次。 */
  opensTurn?: boolean;
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
  /** 该请求的选项（`system` 行的「选项」页签）。 */
  optionsDetail?: TrajectoryRequestOptions;

  /** 工具结果摘要（与 `text` 里的「请求」组成 `请求 → 结果` 两列）。 */
  result?: string;
  /** 工具调用 id（把助手正文里的调用与工具行连起来）。 */
  callId?: string;
  /** 工具名（`tool` / `subtool` 行；Schema 页签按它去当时生效的工具目录里找）。 */
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
  /** 模型标识（详情「提供方 / 模型」）。 */
  provider?: string;
  model?: string;
  /** 重试进度（「重试 2/5」）；`max` 缺失时只显示是第几次。 */
  retry?: { attempt: number; max?: number };
}

/** 一轮（或「轮次之间」的一段）。 */
export interface TrajectoryTurn {
  /** `null` = 不属于任何轮次（官方 `section.betweenTurns`）。 */
  turn: number | null;
  cells: TrajectoryCell[];
}

/** 时间线的泳道（官方只用了三条，且只有标签用到了「输入/模型/工具」）。 */
export type TrajectoryLane = 0 | 1 | 2;

/** 时间线上一段。 */
export interface TrajectorySpan {
  cellIndex: number;
  kind: TrajectoryCellKind;
  lane: TrajectoryLane;
  /** 归一化区间（0..1，相对整个时间线域）。 */
  start: number;
  end: number;
  /** 真正的时间（ms），tooltip 用。 */
  startedAt: number | null;
  timeSeconds: number | null;
  error: boolean;
  /** 助手记录的 TTFT / 解码时长（ms），tooltip 用。 */
  ttftMs?: number | null;
  decodingMs?: number | null;
}

/** 宿主推给界面的整份轨迹模型。 */
export interface TrajectoryModel {
  turns: TrajectoryTurn[];
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

/** 该行在时间线上能不能定位（官方要求 `startedAt` 是有限数）。 */
export function trajectorySpanRange(cell: TrajectoryCell): { start: number; end: number } | null {
  if (cell.startedAt === null || !Number.isFinite(cell.startedAt)) return null;
  const seconds = cell.timeSeconds ?? 0;
  return { start: cell.startedAt, end: cell.startedAt + Math.max(0, seconds) * 1000 };
}
