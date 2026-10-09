/**
 * 轨迹**时间线的视图模型**：把 vendor 进来的官方 `deriveTrajectoryTimeline`
 * （`src/vendor/ui-trajectory/timeline.ts`）接到本扩展的账本上，并把官方那套
 * **绝对域坐标**（`sequence` 是「第几格」，其余是 Unix 毫秒 / 压缩后的毫秒）
 * 归一化成界面直接能画的 **0..1 域位置**。
 *
 * 为什么要有这一层、而不是直接用官方输出：本扩展的时间线是自绘的（官方那份带
 * 自己的 CSS 与虚拟化），绘制与命中都在 0..1 的归一化域里（缩放之后再乘视口，
 * 见 `shared/trajectory.ts` 的 `trajectoryScreenFraction` / `trajectoryDomainPosition`）。
 * 归一化是一次单调线性变换，**不改变**任何跨度比较的结果，所以官方那条
 * 「选区命中」的判据（`span.start <= range.end && span.end >= range.start`，
 * 含端点）在归一化坐标下逐字等价——`Trajectory.tsx` 的 `inRange` 就按它写。
 *
 * 界面要的**视图事实**（`startedAt` / `timeSeconds` / TTFT / 解码时长，tooltip 用）
 * 官方那条时间线里没有（它只有位置），所以按 `cell.index` 回填一次。
 */
import {
  deriveTrajectoryTimeline as deriveOfficialTimeline,
  type TrajectoryTimelineModel,
} from "../vendor/ui-trajectory/timeline";
import { trajectoryLane, trajectoryTurnCells, type TrajectoryCell, type TrajectoryCellKind, type TrajectoryLane, type TrajectoryTimelineMode, type TrajectoryTurn } from "../shared/trajectory";
import { vendorTurns } from "./trajectoryVendor";

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
  /** 官方判据：`isError === true`。**助手行从不置这个字段**——被中断 / 收尾失败的
   *  助手条不该被涂成错误色（曾经按 `status === "error"` 判，把它们全涂红了）。 */
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

/** 时间线的完整视图模型。 */
export interface TrajectoryTimeline {
  spans: TrajectoryTimelineSpan[];
  boundaries: TrajectoryTimelineBoundary[];
  /** 该模式下的域总跨度（归一化前；`sequence` 是格数，其余是毫秒）。 */
  domainMs: number;
}

const EMPTY: TrajectoryTimeline = { spans: [], boundaries: [], domainMs: 0 };

/** 助手记录的 TTFT / 解码时长（官方 `assistantMetrics` 的两个差值）。 */
function metricsOf(cell: TrajectoryCell): { ttftMs: number | null; decodingMs: number | null } {
  const metrics = cell.assistantMetrics;
  return {
    ttftMs:
      metrics?.firstTokenTime != null && metrics.stepStartTime != null
        ? metrics.firstTokenTime - metrics.stepStartTime
        : null,
    decodingMs:
      metrics?.completedTime != null && metrics.firstTokenTime != null
        ? metrics.completedTime - metrics.firstTokenTime
        : null,
  };
}

/**
 * 账本 → 时间线（官方 `deriveTrajectoryTimeline` + 归一化）。
 *
 * 四种模式与官方的对应关系见 `src/vendor/ui-trajectory/timeline.ts` 的文件头：
 * `sequence` 每条等宽一格；`duration` 按耗时并**扣掉空闲**（并发区间保持重叠）；
 * `actual` 按耗时但保留空闲；`time` 宽度归零。缺 `startedAt` 的记录不进时间线。
 *
 * @param turns - 账本的轮次列表（轮次边界要它，光有扁平 cells 判不出来）。
 * @param mode - 官方工具栏两个开关组合出来的模式。
 * @returns 归一化后的视图模型；没有可画的记录时是空模型。
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurn[],
  mode: TrajectoryTimelineMode,
): TrajectoryTimeline {
  const model = deriveOfficialTimeline(vendorTurns(turns), mode);
  if (model === null) return EMPTY;
  return normalizeTimeline(model, turns);
}

/**
 * 官方模型 → 归一化视图模型。
 * @param model - 官方 `deriveTrajectoryTimeline` 的输出。
 * @param turns - 同一份账本（回填界面要的视图事实）。
 * @returns 0..1 域位置的时间线。
 */
function normalizeTimeline(
  model: TrajectoryTimelineModel,
  turns: readonly TrajectoryTurn[],
): TrajectoryTimeline {
  const byIndex = new Map<number, TrajectoryCell>();
  for (const turn of turns) for (const cell of trajectoryTurnCells(turn)) byIndex.set(cell.index, cell);
  // 域跨度可能为 0（`time` 模式下只有一条瞬时记录）：那时所有条落在左端、
  // 宽度为零——不是除以零，也不是把它们摊开假装有跨度。
  const domain = Math.max(1, model.end - model.start);
  const at = (value: number) => (value - model.start) / domain;
  return {
    spans: model.spans.map((span) => {
      const cell = byIndex.get(span.index);
      const metrics = cell === undefined ? { ttftMs: null, decodingMs: null } : metricsOf(cell);
      return {
        cellIndex: span.index,
        kind: span.kind,
        lane: trajectoryLane(span.kind) as TrajectoryLane,
        left: at(span.start),
        width: (span.end - span.start) / domain,
        startedAt: cell?.startedAt ?? null,
        timeSeconds: cell?.timeSeconds ?? null,
        error: span.isError,
        ...metrics,
      };
    }),
    boundaries: model.turnBoundaries.map((boundary) => ({
      turn: boundary.turn,
      left: at(boundary.time),
    })),
    domainMs: model.end - model.start,
  };
}
