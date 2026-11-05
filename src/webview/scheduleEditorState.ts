/**
 * 自动化任务详情的**草稿与编辑基线**状态机 —— 纯函数，离线可断言。
 *
 * 这里钉住三条容易写错的规则（与官方 `TaskDetail` / `TaskEditorFields` 的
 * `base = cached?.base ?? task`、`taskDraftPatch(draft, existingBase)` 同口径）：
 *
 * 1. **判「有没有改」、提交什么，都相对编辑基线（`base`）**，不是相对最新目录。
 *    后台刷新只改了别的字段时，草稿与基线都没变，界面不该凭空出现「有未保存的修改」；
 *    用户只改了名称时，patch 也只带名称，不能把别人刚改的指令 / 目标当成自己的修改
 *    再提交回去。
 * 2. **没有本地修改时跟着权威目录走**：基线一起换到最新条目，下一次编辑的比较基准
 *    才是用户此刻看到的那一版。
 * 3. **保存成功之后把草稿与基线一起换成权威值**：宿主成功结算发生在权威目录刷新
 *    之后（见 `controller` 的变更路由），因此这里拿到的是保存后的条目。只清失败
 *    提示、不推进基线，会让下一次目录刷新把「自己刚保存的那一版」误判成冲突。
 *
 * 表单在等待结算期间是只读的，所以「保存成功 → 换成权威值」不会吞掉用户在保存
 * 途中的输入；而等待期间到达的后台刷新由 `catalog` 动作保留（草稿有修改就不覆盖）。
 */
import type { ScheduleItemView } from "../shared/chat";
import {
  scheduleEditorDraft,
  scheduleEditorDirty,
  scheduleReapplyDraft,
  type ScheduleEditorDraft,
} from "../shared/schedule";

/** 详情区的一份草稿与它开始编辑时看到的目录条目。 */
export interface ScheduleEditorState {
  draft: ScheduleEditorDraft;
  base: ScheduleItemView;
}

/** 详情区状态机的四种输入。 */
export type ScheduleEditorAction =
  /** 用户改了表单（只换草稿；基线保持「开始编辑那一刻」）。 */
  | { type: "edit"; draft: ScheduleEditorDraft }
  /** 权威目录刷新（后台改动 / 广播 / 重连补读）。 */
  | { type: "catalog"; item: ScheduleItemView }
  /** 宿主确认保存成功（`item` 是刷新后的权威条目）。 */
  | { type: "saved"; item: ScheduleItemView }
  /** 取消未保存修改 / 冲突解决后放弃。 */
  | { type: "discard"; item: ScheduleItemView }
  /** 冲突后「重新应用我的修改」到最新条目。 */
  | { type: "reapply"; item: ScheduleItemView };

/** 一份条目的初始状态：草稿由条目种出，基线就是它。 */
export function scheduleEditorState(item: ScheduleItemView): ScheduleEditorState {
  return { draft: scheduleEditorDraft(item), base: item };
}

/** 有没有**本地**未保存修改（相对基线；后台改动不算）。 */
export function scheduleEditorStateDirty(state: ScheduleEditorState): boolean {
  return scheduleEditorDirty(state.draft, state.base);
}

/** 编辑基线是否已被服务端刷新（只在确实有本地修改时才算冲突）。 */
export function scheduleEditorStateConflict(state: ScheduleEditorState, latest: ScheduleItemView): boolean {
  return (
    scheduleEditorStateDirty(state) &&
    (latest.updatedAt ?? undefined) !== (state.base.updatedAt ?? undefined)
  );
}

export function scheduleEditorReducer(
  state: ScheduleEditorState,
  action: ScheduleEditorAction,
): ScheduleEditorState {
  switch (action.type) {
    case "edit":
      return { ...state, draft: action.draft };
    case "catalog":
      // 有本地修改就草稿与基线都保留：覆盖草稿会吞掉用户正在写的东西，替换基线会让
      // 他的修改凭空变成「相对新值」的差异（下一次保存就可能改掉别人的字段）。
      return scheduleEditorStateDirty(state) ? state : scheduleEditorState(action.item);
    case "saved":
      // 成功结算在权威刷新之后（controller 先重读目录、再发结算帧），这里整份换成
      // 权威值：保存成功后既不残留「有未保存的修改」，也不让下一次刷新误判冲突。
      return scheduleEditorState(action.item);
    case "discard":
    case "reapply":
      return action.type === "discard"
        ? scheduleEditorState(action.item)
        : { draft: scheduleReapplyDraft(state.draft, state.base, action.item), base: action.item };
  }
}
