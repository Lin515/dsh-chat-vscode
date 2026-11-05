/**
 * 自动化任务一行上所有**变更入口**的可用性判定 —— 纯函数，离线可断言。
 *
 * 规则逐条对齐官方 `TaskDetail`（目标版本 `dsh-v0.2.2-rc.1`，commit
 * `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）：
 *
 * - `busy = pending || deletingTask || (task !== undefined && status === 'loading')`；
 * - `authoritative = status === 'ready' && 代际已判明`，目录读取中 / 读取失败 / 代际未知
 *   时保存与运行都没有可靠基准，按钮不可用（编辑字段仍可继续填）；
 * - 暂停：`busy || dirty || executionActive || status === 'ended' || !authoritative`；
 * - 删除：`busy || dirty || executionActive || !authoritative`（**不**看投递间隔与归档）；
 * - 保存：`busy || !dirty || invalid || conflict || !authoritative || executionActive`；
 * - 立即运行：`busy || dirty || executionActive || targetArchived || !authoritative`
 *   （投递间隔另算，界面把它和这条一起折进按钮禁用与说明）；
 * - 表单字段：`pending || executionActive || deletingTask`——后台刷新目录时字段仍可编辑，
 *   只有真的在等一次操作、或目标会话正在执行时才只读。
 *
 * 所有同一行的变更共用同一个 `busy`：删除按钮不能只看自己的删除阶段，否则保存 / 运行 /
 * 暂停在飞时再点删除，两个操作会各自记账、互相覆盖等待态。串行的判据就放在这里，
 * 组件只渲染结果。
 */
import type { ChatState } from "../shared/chat";

/** 判定要用的全部事实（组件把当前行与目录读取状态摊平传进来）。 */
export interface ScheduleRowControlsState {
  /** 目录读取状态（`undefined` = 还没问过）。 */
  catalogStatus: ChatState["schedulesStatus"];
  /** 服务端代际已判明（`modern` 或 `legacy`）。 */
  capabilityKnown: boolean;
  /** 这一行支持新代详情编辑（`item.api === "edit"`）。 */
  editable: boolean;
  /** 本行有一次变更在等结算。 */
  pending: boolean;
  /** 本行的删除处在等待档。 */
  deleting: boolean;
  /** 草稿相对**编辑基线**有未保存修改。 */
  dirty: boolean;
  /** 草稿本身不合法（名称 / 指令为空、cron 坏、目标会话未选）。 */
  invalid: boolean;
  /** 上一次投递仍在目标会话里排队或执行。 */
  executionActive: boolean;
  /** 投递间隔还没到。 */
  floorActive: boolean;
  /** 目标会话已归档（肯定证据：它在宿主的归档列表里）。 */
  targetArchived: boolean;
  /** 已结束（旧代 `inactive` 同义）。 */
  ended: boolean;
}

/** 一行上四个入口的可用性。 */
export interface ScheduleRowControls {
  /** 等结算、删除中或目录正在读取。 */
  busy: boolean;
  /** 目录是权威的（已读到且代际判明）：新代变更只有在这是真的时候才发得出去。 */
  authoritative: boolean;
  /** 「立即运行」此刻不可用。 */
  runHeld: boolean;
  /** 暂停 / 恢复按钮是否出现（已结束的行不出现）。 */
  pauseVisible: boolean;
  canPause: boolean;
  canDelete: boolean;
  canSave: boolean;
  /** 运行时间 / 基础字段的只读判据。 */
  fieldsDisabled: boolean;
  /** 旧代只有时间编辑：名称 / 指令 / 目标只读。 */
  basicDisabled: boolean;
}

export function scheduleRowControls(state: ScheduleRowControlsState): ScheduleRowControls {
  const busy = state.pending || state.deleting || state.catalogStatus === "loading";
  const authoritative = state.catalogStatus === "ready" && state.capabilityKnown;
  const runHeld =
    busy ||
    state.dirty ||
    state.executionActive ||
    state.targetArchived ||
    state.floorActive ||
    !authoritative;
  return {
    busy,
    authoritative,
    runHeld,
    pauseVisible: state.editable && !state.ended,
    canPause: !busy && !state.dirty && !state.executionActive && !state.ended && authoritative,
    canDelete: !busy && !state.dirty && !state.executionActive && authoritative,
    canSave: state.dirty && !busy && !state.invalid && !state.executionActive && authoritative,
    fieldsDisabled: state.pending || state.deleting || state.executionActive,
    basicDisabled: !state.editable,
  };
}
