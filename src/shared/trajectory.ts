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

/** 时间线上的一段（位置已归一化到 0..1，界面直接乘宽度）。 */
export interface TrajectoryTimelineSpan {
  cellIndex: number;
  kind: TrajectoryCellKind;
  lane: TrajectoryLane;
  /** 左边界与宽度，都是 0..1 的归一化值。 */
  left: number;
  width: number;
  startedAt: number | null;
  timeSeconds: number | null;
  error: boolean;
  /** 助手记录的 TTFT / 解码时长（ms），tooltip 用。 */
  ttftMs: number | null;
  decodingMs: number | null;
}

/** 轮次边界竖线（官方只在 `turn !== null` 时画）。 */
export interface TrajectoryTimelineBoundary {
  turn: number;
  left: number;
}

export interface TrajectoryTimeline {
  spans: TrajectoryTimelineSpan[];
  boundaries: TrajectoryTimelineBoundary[];
  /** 该模式下的域总跨度（毫秒）；`sequence` 模式是「单位数」。 */
  domainMs: number;
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
 * 把账本折成时间线（官方 `deriveTrajectoryTimeline` / `deriveTimedTimeline` 的等价物）。
 *
 * 四种模式（官方工具栏的两个开关组合出来的）：
 * - `sequence`：**每条记录占等宽一格**，与时间无关（默认；官方 `toolbar.duration`
 *   未按下时就是这个）；
 * - `duration`：宽度按记录自身耗时，并**扣掉操作之间的空闲**（官方 `compressIdle`）；
 * - `time` / `actual`：按真实时刻摆放（含空闲），`time` 模式下每条宽度归零
 *   （官方 `data-equal-duration` 的读法）。
 *
 * 缺 `startedAt` 的记录不参与时间线（官方同样跳过）——拿不到时刻就不画，
 * 而不是塞到左边 0 的位置假装它在最前面。
 */
export function deriveTrajectoryTimeline(
  cells: readonly TrajectoryCell[],
  mode: TrajectoryTimelineMode,
): TrajectoryTimeline {
  const visible = cells;
  const spans: TrajectoryTimelineSpan[] = [];

  const decorate = (
    cell: TrajectoryCell,
    left: number,
    width: number,
    startedAt: number | null,
  ): TrajectoryTimelineSpan => {
    const metrics = cell.assistantMetrics;
    const ttftMs =
      metrics?.firstTokenTime != null && metrics.stepStartTime != null
        ? metrics.firstTokenTime - metrics.stepStartTime
        : null;
    const decodingMs =
      metrics?.completedTime != null && metrics.firstTokenTime != null
        ? metrics.completedTime - metrics.firstTokenTime
        : null;
    return {
      cellIndex: cell.index,
      kind: cell.kind,
      lane: trajectoryLane(cell.kind),
      left,
      width,
      startedAt,
      timeSeconds: cell.timeSeconds,
      error: cell.status === "error",
      ttftMs,
      decodingMs,
    };
  };

  if (mode === "sequence") {
    const total = Math.max(1, visible.length);
    visible.forEach((cell, index) => {
      spans.push(decorate(cell, index / total, 1 / total, cell.startedAt));
    });
    return { spans, boundaries: sequenceBoundaries(visible, total), domainMs: total };
  }

  // 时间模式：先用「有 startedAt」的记录定位
  const timed = visible
    .map((cell) => ({ cell, range: trajectorySpanRange(cell) }))
    .filter((entry): entry is { cell: TrajectoryCell; range: { start: number; end: number } } => entry.range !== null)
    // 没有耗时的记录给一个 0 宽度的瞬时点（官方 `time` 模式也是这样）
    .map((entry) => ({ ...entry, duration: Math.max(0, entry.range.end - entry.range.start) }));

  if (timed.length === 0) return { spans: [], boundaries: [], domainMs: 0 };

  if (mode === "duration" || mode === "actual") {
    // 扣掉空闲：每条紧接上一条摆放
    const total = Math.max(1, timed.reduce((sum, entry) => sum + entry.duration, 0));
    let cursor = 0;
    for (const entry of timed) {
      spans.push(decorate(entry.cell, cursor / total, entry.duration / total, entry.range.start));
      cursor += entry.duration;
    }
    return { spans, boundaries: timedBoundaries(timed, total, (entry) => entry.range.start), domainMs: total };
  }

  // `time`：按真实时刻摆放，宽度归零（相等的宽度让「什么时候发生」成为唯一信息）
  const first = Math.min(...timed.map((entry) => entry.range.start));
  const last = Math.max(...timed.map((entry) => entry.range.end));
  const total = Math.max(1, last - first);
  for (const entry of timed) {
    spans.push(decorate(entry.cell, (entry.range.start - first) / total, 0, entry.range.start));
  }
  return { spans, boundaries: timedBoundaries(timed, total, (entry) => entry.range.start, first), domainMs: total };
}

/** 等宽模式下的轮次边界（每组第一格的位置）。 */
function sequenceBoundaries(cells: readonly TrajectoryCell[], total: number): TrajectoryTimelineBoundary[] {
  const boundaries: TrajectoryTimelineBoundary[] = [];
  let lastTurn: number | null | undefined;
  cells.forEach((cell, index) => {
    if (cell.turn === null || cell.turn === lastTurn) {
      lastTurn = cell.turn;
      return;
    }
    boundaries.push({ turn: cell.turn, left: index / total });
    lastTurn = cell.turn;
  });
  return boundaries;
}

/** 时间模式下的轮次边界（每组第一条有时刻的记录的位置）。 */
function timedBoundaries(
  entries: readonly { cell: TrajectoryCell; range: { start: number } }[],
  total: number,
  at: (entry: { cell: TrajectoryCell; range: { start: number } }) => number,
  origin?: number,
): TrajectoryTimelineBoundary[] {
  const boundaries: TrajectoryTimelineBoundary[] = [];
  let lastTurn: number | null | undefined;
  for (const entry of entries) {
    if (entry.cell.turn === null || entry.cell.turn === lastTurn) {
      lastTurn = entry.cell.turn;
      continue;
    }
    boundaries.push({ turn: entry.cell.turn, left: (at(entry) - (origin ?? 0)) / total });
    lastTurn = entry.cell.turn;
  }
  return boundaries;
}
