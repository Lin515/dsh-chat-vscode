/**
 * 自动化任务详情区的**离线回归**：编辑状态机、变更入口策略、结算账本、选中会话的
 * 渲染与归档目标提示。
 *
 * 这一层钉的是本轮修复的四类事实（都不是字符串断言）：
 *
 * 1. **草稿与基线**：dirty / patch 相对基线；后台只改别的字段不制造 dirty；保存成功
 *    后草稿与基线一起换成权威值，下一次编辑不再误判冲突；切换条目后行重挂也不会因为
 *    操作标识从零重数而把旧结算当成新操作（发号器在 `scheduleOps` 模块级）。
 * 2. **入口策略**：unknown 代际下保存不可用（不是可点但静默返回）；删除与其它变更共用
 *    同一个 busy；目录读取中 / 执行中 / 归档目标的运行禁用条件。
 * 3. **真正的渲染**（`react-dom/server`）：归档提示与禁用属性、`<select>` 在空会话 /
 *    列表外会话时不至于显示成别的会话。
 * 4. **结算匹配**：非创建操作缺 id 的帧不算当前这次；创建允许回帧带新 id。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduleItemView, ScheduleProjectView, SessionSummaryView } from "../src/shared/chat";
import {
  scheduleCreateDraft,
  scheduleDraftDiffers,
  scheduleEditorDraft,
  scheduleInvolvesSession,
  schedulePatchOf,
  scheduleTargetError,
  scheduleTargetSessionId,
  scheduleTimingIssue,
  type ScheduleEditorDraft,
} from "../src/shared/schedule";
import {
  scheduleEditorReducer,
  scheduleEditorState,
  scheduleEditorStateConflict,
  scheduleEditorStateDirty,
} from "../src/webview/scheduleEditorState";
import { scheduleRowControls, type ScheduleRowControlsState } from "../src/webview/scheduleControls";
import {
  scheduleNextOpId,
  scheduleResetOpIds,
  scheduleResultSettles,
  type SchedulePendingOp,
} from "../src/webview/scheduleOps";
import { initialState, reducer, type ScheduleHistoryState } from "../src/webview/state";
import { TextsContext, LocaleContext, dictionaryFor } from "../src/webview/texts";

// `bridge.ts` 在模块求值期挂 `window` 监听；无头环境补一个最小的。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { ScheduleRow, scheduleHistoryShouldLoad } = await import("../src/webview/components/Schedules");
const { ScheduleEditor, cronFieldText, scheduleTargetSessionChoices } = await import("../src/webview/components/ScheduleEditor");

/** 一条新代目录条目的视图模型。 */
function item(overrides: Partial<ScheduleItemView> = {}): ScheduleItemView {
  return {
    id: "task-1",
    sessionId: "s1",
    title: "构建检查",
    prompt: "检查构建",
    kind: "every",
    status: "active",
    scheduledAt: "2026-11-06T02:00:00.000Z",
    everySeconds: 300,
    api: "edit",
    updatedAt: "rev-1",
    target: { kind: "session", sessionId: "s1" },
    involvedSessionIds: ["s1"],
    ...overrides,
  };
}

/** 一项满足「可以操作」的控件事实（各断言按需覆盖）。 */
function controlsState(overrides: Partial<ScheduleRowControlsState> = {}): ScheduleRowControlsState {
  return {
    catalogStatus: "ready",
    capabilityKnown: true,
    editable: true,
    pending: false,
    deleting: false,
    dirty: false,
    invalid: false,
    executionActive: false,
    floorActive: false,
    targetArchived: false,
    ended: false,
    ...overrides,
  };
}

// ---------- 1. 归属：相关会话集合与投递落点是「或」（官方 taskInvolvesSession） ----------
{
  // 空集合 + 落点命中 → 仍属于本会话（官方 OR 语义）
  const detached = item({ involvedSessionIds: [], target: { kind: "session", sessionId: "s1" } });
  assert.equal(scheduleInvolvesSession(detached, "s1"), true, "落点命中就属于本会话，空集合不是「谁都无关」");
  assert.equal(scheduleInvolvesSession(detached, "other"), false, "两边都不命中才为假");
  // 集合命中、落点不同 → 属于（创建者 / 编辑者）
  const involved = item({ involvedSessionIds: ["creator"], target: { kind: "session", sessionId: "target" } });
  assert.equal(scheduleInvolvesSession(involved, "creator"), true);
  assert.equal(scheduleInvolvesSession(involved, "target"), true, "落点本身也算");
  // `new` 目标的落点取最近一次投递的目标会话（目录读取时已折算到 target.sessionId）
  const fanout = item({
    involvedSessionIds: [],
    target: { kind: "new", sessionId: "fresh-1" },
    lastDelivery: { scheduledAt: "2026-11-06T01:00:00.000Z", deliveredAt: "2026-11-06T01:00:01.000Z" },
  });
  assert.equal(scheduleTargetSessionId(fanout), "fresh-1");
  assert.equal(scheduleInvolvesSession(fanout, "fresh-1"), true);
  assert.equal(scheduleInvolvesSession(fanout, "s1"), false, "new 首次投递前没有落点，不退回 involved 以外的会话");
  // 旧代没有 target / involvedSessionIds：退回原始绑定
  const legacy = item({ sessionId: "legacy-1", api: undefined, target: undefined, involvedSessionIds: undefined });
  assert.equal(scheduleInvolvesSession(legacy, "legacy-1"), true);
  assert.equal(scheduleInvolvesSession(legacy, "other"), false);
}
console.log("scheduleEditor: 归属 OR 语义 ✓");

// ---------- 2. 编辑状态机：dirty / patch 相对基线，后台改动不制造修改 ----------
{
  const base = item({ updatedAt: "rev-1" });
  let state = scheduleEditorState(base);
  assert.equal(scheduleEditorStateDirty(state), false);

  // 用户只改名称
  state = scheduleEditorReducer(state, {
    type: "edit",
    draft: { ...state.draft, title: "新名字" },
  });
  assert.equal(scheduleEditorStateDirty(state), true);
  const patch = schedulePatchOf(state.draft, state.base);
  assert.ok("patch" in patch);
  assert.deepEqual(Object.keys(patch.patch), ["title"], "只提交改过的组");
  assert.equal(patch.patch.title, "新名字");

  // 后台只改了指令（另一个组）：草稿与基线都保留，dirty 仍来自名称；patch 仍然只有名称。
  const latest = item({ updatedAt: "rev-2", prompt: "别人改的指令" });
  state = scheduleEditorReducer(state, { type: "catalog", item: latest });
  assert.equal(state.base, base, "有本地修改时基线不动（它是对比的起点）");
  assert.equal(state.draft.prompt, base.prompt, "后台改的另一组不能钻进用户的草稿");
  const patchAfterRefresh = schedulePatchOf(state.draft, state.base);
  assert.ok("patch" in patchAfterRefresh);
  assert.deepEqual(Object.keys(patchAfterRefresh.patch), ["title"], "别人改的指令不会被当成用户的修改提交");
  assert.equal(scheduleEditorStateConflict(state, latest), true, "目录已推进且本地有修改 → 冲突");

  // 没有本地修改时：后台改哪一组都跟着权威目录走，且不产生 dirty。
  let untouched = scheduleEditorState(base);
  untouched = scheduleEditorReducer(untouched, { type: "catalog", item: latest });
  assert.equal(untouched.base, latest);
  assert.equal(untouched.draft.prompt, "别人改的指令");
  assert.equal(scheduleEditorStateDirty(untouched), false, "后台只改别的字段不该制造 dirty");
  assert.equal(scheduleEditorStateConflict(untouched, latest), false);
}
console.log("scheduleEditor: 基线相对 dirty / patch ✓");

// ---------- 2b. 未触碰的坏 RRULE 保持原样（官方 taskDraftIssue 的 changes.timing 短路） ----------
{
  // 坏规则（缺 DTSTART）在官方与本地都不可保存；但只要用户没碰时间那一组，
  // 它就仍是权威值：改名称不应触发一次规则重写，也不应因此禁用保存。
  const stored = item({
    kind: "rrule",
    rrule: "RRULE:FREQ=DAILY",
    updatedAt: "rev-1",
    scheduledAt: "2026-11-07T01:00:00.000Z",
  });
  let state = scheduleEditorState(stored);
  assert.equal(scheduleEditorStateDirty(state), false, "从坏规则生成的草稿本身不算未保存修改");
  state = scheduleEditorReducer(state, { type: "edit", draft: { ...state.draft, title: "改名" } });
  const patch = schedulePatchOf(state.draft, state.base);
  assert.ok("patch" in patch, "只改名称仍可保存");
  assert.deepEqual(patch.patch, { title: "改名" }, "没碰时间就不带 timing（坏规则原样保留）");

  // 真正改了 RRULE 才进入校验：合法的接住，不合法的由同一个 parser 拒绝。
  const edited = { ...state.draft, title: "构建检查", timing: { ...state.draft.timing, rrule: "RRULE:FREQ=WEEKLY" } };
  assert.equal(scheduleDraftDiffers(edited.timing, stored), true);
  assert.deepEqual(schedulePatchOf(edited, stored), { error: "invalid_rule" });
  const valid = schedulePatchOf(
    { ...edited, timing: { ...edited.timing, rrule: "DTSTART:20990101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO" } },
    stored,
  );
  assert.ok("patch" in valid);
  assert.deepEqual(valid.patch.timing, {
    kind: "rrule",
    rrule: "DTSTART:20990101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
  });

  // 行空白噪声与「从目录读到的原文」是同一形态：不制造未保存修改，也不阻止删除。
  const canonical = item({
    kind: "rrule",
    rrule: "DTSTART:20990101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    scheduledAt: "2099-01-05T09:00:00.000Z",
  });
  const noisy = scheduleEditorState(canonical);
  const noiseDraft = {
    ...noisy,
    draft: {
      ...noisy.draft,
      timing: {
        ...noisy.draft.timing,
        rrule: `\n ${canonical.rrule!.replace("\n", " \r\n ")} \n`,
      },
    },
  };
  assert.equal(scheduleDraftDiffers(noiseDraft.draft.timing, canonical), false);
  assert.equal(scheduleRowControls(controlsState({ dirty: scheduleEditorStateDirty(noiseDraft) })).canDelete, true);
}
console.log("scheduleEditor: 未触碰 RRULE 短路与行空白噪声 ✓");

// 一次性任务从目录生成草稿后必须仍是干净的；否则删除 / 暂停 / 运行会一起灰掉。
for (const kind of ["at", "after"] as const) {
  for (const milliseconds of ["000", "123"]) {
    const base = item({ kind, scheduledAt: `2026-11-06T11:15:00.${milliseconds}Z` });
    const state = scheduleEditorState(base);
    assert.equal(scheduleEditorStateDirty(state), false, `${kind} .${milliseconds}：未编辑的任务不能被误判 dirty`);
    const controls = scheduleRowControls(controlsState({ dirty: scheduleEditorStateDirty(state) }));
    assert.equal(controls.canDelete, true, "未编辑的一次性任务可以删除");
    assert.equal(controls.canPause, true);
    assert.equal(controls.runHeld, false);
    const secondsOnly = { ...state.draft, timing: { ...state.draft.timing, time: state.draft.timing.time.slice(0, 8) } };
    assert.equal(scheduleEditorStateDirty({ ...state, draft: secondsOnly }), false, "时间控件的整秒文本与目录投影一致");
    for (const timing of [
      { ...state.draft.timing, date: "2026-11-07" },
      { ...state.draft.timing, time: "00:01:02" },
      { ...state.draft.timing, timeZone: state.draft.timing.timeZone === "UTC" ? "Asia/Shanghai" : "UTC" },
    ]) {
      const edited = { ...state, draft: { ...state.draft, timing } };
      assert.equal(scheduleEditorStateDirty(edited), true, "真正修改日期 / 时间 / 时区仍然算 dirty");
      const controls = scheduleRowControls(controlsState({ dirty: scheduleEditorStateDirty(edited) }));
      assert.equal(controls.canDelete, false, "真正未保存的修改仍阻止删除，不能简单移除安全条件");
      assert.equal(controls.canPause, false);
      assert.equal(controls.runHeld, true);
      const patch = schedulePatchOf(edited.draft, base);
      assert.ok("patch" in patch);
      assert.deepEqual(Object.keys(patch.patch), ["timing"]);
    }
    const renamed = schedulePatchOf({ ...state.draft, title: "改名" }, base);
    assert.ok("patch" in renamed);
    assert.deepEqual(renamed.patch, { title: "改名" }, "只改名不能重写一次性时刻");
    const latest = { ...base, title: "后台改名", updatedAt: "rev-2" };
    const refreshed = scheduleEditorReducer(state, { type: "catalog", item: latest });
    assert.equal(refreshed.base, latest, "未改动的一次性草稿能跟进目录刷新");
    assert.equal(scheduleEditorStateDirty(refreshed), false);
  }
}
console.log("scheduleEditor: 一次性任务初始可删除 / 暂停 / 运行 ✓");

// ---------- 3. 保存成功与权威刷新：草稿/基线一起推进，下一次编辑不误判冲突 ----------
{
  const before = item({ updatedAt: "rev-1" });
  let state = scheduleEditorState(before);
  state = scheduleEditorReducer(state, { type: "edit", draft: { ...state.draft, title: "保存后的名字" } });

  // 宿主先读回目录（rev-2、新名称），再发成功结算；`saved` 收到的是刷新后的条目。
  const after = item({ updatedAt: "rev-2", title: "保存后的名字" });
  state = scheduleEditorReducer(state, { type: "catalog", item: after });
  assert.equal(scheduleEditorStateConflict(state, after), true, "刷新先到时仍是冲突态，等成功结算收口");
  state = scheduleEditorReducer(state, { type: "saved", item: after });
  assert.equal(state.base, after, "保存成功后基线推进到权威值");
  assert.equal(state.draft.title, "保存后的名字");
  assert.equal(scheduleEditorStateDirty(state), false, "保存成功后不再有未保存修改");
  assert.equal(scheduleEditorStateConflict(state, after), false, "保存成功后不误判冲突（旧实现会一直亮冲突）");

  // 保存后继续编辑：比较基准是新版本，patch 只带新改动。
  state = scheduleEditorReducer(state, { type: "edit", draft: { ...state.draft, prompt: "下一轮改动" } });
  const patch = schedulePatchOf(state.draft, state.base);
  assert.ok("patch" in patch);
  assert.deepEqual(Object.keys(patch.patch), ["prompt"]);
  assert.equal(scheduleEditorStateConflict(state, after), false);

  // 取消：回到权威值。
  const discarded = scheduleEditorReducer(state, { type: "discard", item: after });
  assert.equal(scheduleEditorStateDirty(discarded), false);
  assert.equal(discarded.draft.prompt, after.prompt);
}
console.log("scheduleEditor: 保存成功推进基线 ✓");

// ---------- 4. 冲突重放：改过的组保留用户值，其余换最新值 ----------
{
  const base = item({ updatedAt: "rev-1" });
  let state = scheduleEditorState(base);
  state = scheduleEditorReducer(state, { type: "edit", draft: { ...state.draft, title: "我的标题" } });
  const latest = item({ updatedAt: "rev-2", title: "别人的标题", prompt: "别人的指令" });
  state = scheduleEditorReducer(state, { type: "reapply", item: latest });
  assert.equal(state.draft.title, "我的标题");
  assert.equal(state.draft.prompt, "别人的指令");
  assert.equal(state.base, latest, "重放后基线跟着最新值，不再报冲突");
  assert.equal(scheduleEditorStateDirty(state), true, "用户的标题仍是未保存修改");
  assert.equal(scheduleEditorStateConflict(state, latest), false);
}
console.log("scheduleEditor: 冲突重放 ✓");

// ---------- 5. 操作标识：模块级唯一单调；重挂 / 重开 / 历史请求不重用 ----------
{
  scheduleResetOpIds(0);
  const ids = new Set<number>();
  // 模拟「行发出保存 → 行卸载 → 重挂后新的创建卡 / 历史请求」
  for (let index = 0; index < 64; index += 1) {
    const id = scheduleNextOpId();
    assert.ok(id > 0);
    assert.ok(!ids.has(id), `操作标识不得重用（${id}）`);
    ids.add(id);
  }
  const ordered = [...ids];
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right), "发号器单调递增");

  const pending: SchedulePendingOp = { op: "update", opId: 3, id: "task-1" };
  assert.equal(scheduleResultSettles(pending, { op: "update", id: "task-1", opId: 3, ok: true }), true);
  assert.equal(scheduleResultSettles(pending, { op: "update", id: "task-1", opId: 2, ok: true }), false, "旧号不结算");
  assert.equal(scheduleResultSettles(pending, { op: "update", id: "task-1", opId: 4, ok: true }), false, "号码必须相等");
  assert.equal(
    scheduleResultSettles(pending, { op: "update", opId: 3, ok: true }),
    false,
    "非创建操作缺 id 不算同一行（旧宿主对 update / delete 本来就有 id）",
  );
  assert.equal(
    scheduleResultSettles(pending, { op: "update", id: "task-2", opId: 3, ok: true }),
    false,
  );
  assert.equal(
    scheduleResultSettles({ op: "update", opId: 5, id: "task-1" }, { op: "update", id: "task-1", ok: true }),
    true,
    "旧宿主不回 opId 时按种类与 id 收下",
  );
  assert.equal(
    scheduleResultSettles({ op: "create", opId: 6 }, { op: "create", id: "fresh", opId: 6, ok: true }),
    true,
    "创建请求侧没有 id，回帧带新 id 也算同一次",
  );
  assert.equal(
    scheduleResultSettles({ op: "create", opId: 6 }, { op: "create", opId: 5, ok: true }),
    false,
    "创建的挂号也必须是同一号",
  );
}
console.log("scheduleEditor: 操作标识与结算匹配 ✓");

// ---------- 6. 执行记录：回帧必须属于最近一次请求，旧页整帧丢弃 ----------
{
  scheduleResetOpIds(0);
  let state = initialState;
  const first = scheduleNextOpId();
  state = reducer(state, { type: "ui/scheduleHistoryRequest", id: "task-1", reset: true, opId: first });
  state = reducer(state, {
    type: "schedules/history",
    id: "task-1",
    opId: first,
    mode: "replace",
    records: [{ scheduledAt: "2026-11-06T01:00:00.000Z", deliveredAt: "2026-11-06T01:00:01.000Z" }],
    earlierRecordsUnavailable: false,
    earlierRecordsPruned: false,
  });
  assert.equal(state.scheduleHistory?.["task-1"]?.records.length, 1);

  const second = scheduleNextOpId();
  state = reducer(state, { type: "ui/scheduleHistoryRequest", id: "task-1", opId: second });
  // 迟到的第一页回来：号码不等 → 整帧丢弃（既不是追加，也不清空）。
  const late = reducer(state, {
    type: "schedules/history",
    id: "task-1",
    opId: first,
    mode: "append",
    records: [{ scheduledAt: "2026-11-05T01:00:00.000Z", deliveredAt: "2026-11-05T01:00:01.000Z" }],
    earlierRecordsUnavailable: false,
    earlierRecordsPruned: false,
  });
  assert.equal(late, state, "旧请求的回帧不改变状态");
  // 第二轮请求自己的回帧照常追加。
  const settled = reducer(state, {
    type: "schedules/history",
    id: "task-1",
    opId: second,
    mode: "append",
    records: [{ scheduledAt: "2026-11-05T02:00:00.000Z", deliveredAt: "2026-11-05T02:00:01.000Z" }],
    earlierRecordsUnavailable: false,
    earlierRecordsPruned: false,
  });
  assert.equal(settled.scheduleHistory?.["task-1"]?.records.length, 2);
  // 请求侧的号码不允许回退（即使调用方传了旧号）。
  const regressed = reducer(settled, { type: "ui/scheduleHistoryRequest", id: "task-1", opId: first });
  assert.equal(regressed.scheduleHistory?.["task-1"]?.opId, second, "请求动作不会把已登记的号退回去");
  assert.equal(regressed.scheduleHistory?.["task-1"]?.loading, true);
}
console.log("scheduleEditor: 执行记录迟到帧 ✓");

// ---------- 6b. 执行记录何时自动读：`code` 是终点，重新展开才放行一次 ----------
{
  const entry = (overrides: Partial<ScheduleHistoryState> = {}): ScheduleHistoryState => ({
    records: [],
    unavailable: false,
    pruned: false,
    loading: false,
    loaded: true,
    ...overrides,
  });
  assert.equal(scheduleHistoryShouldLoad(false, undefined, false), false, "收起时不读");
  assert.equal(scheduleHistoryShouldLoad(true, undefined, false), true, "展开且没有记录：读第一页");
  assert.equal(scheduleHistoryShouldLoad(true, entry({ loading: true, loaded: false }), false), false, "正在读时不重复发");
  assert.equal(scheduleHistoryShouldLoad(true, entry(), false), false, "成功读过：同一段展开里不再重发");
  assert.equal(scheduleHistoryShouldLoad(true, entry({ code: "schedule_not_found" }), false), false, "`code` 是终点，不能每次回帧都再发一次（旧实现的无上限往返）");
  assert.equal(scheduleHistoryShouldLoad(true, entry({ code: "delivery_cursor_not_found" }), false), false);
  assert.equal(scheduleHistoryShouldLoad(true, entry({ code: "schedule_not_found", loaded: false }), true), true, "重新展开时放行一次重读");
  assert.equal(scheduleHistoryShouldLoad(true, entry({ error: "boom" }), true), false, "失败仍由手动重试收场，不随展开自动重发");
  assert.equal(scheduleHistoryShouldLoad(true, entry({ hostUnavailable: true }), true), false);
  // 手动重试 / 重新展开都走 reset 请求：模拟消费掉展开意图之后，下一次回帧不能再自触发。
  assert.equal(scheduleHistoryShouldLoad(true, entry({ code: "schedule_not_found" }), false), false);
}
console.log("scheduleEditor: 执行记录读取终点与重展开 ✓");

// ---------- 7. 变更入口策略（官方 TaskDetail 条件） ----------
{
  const baseline = scheduleRowControls(controlsState());
  assert.equal(baseline.authoritative, true);
  assert.equal(baseline.busy, false);
  assert.equal(baseline.canPause, true);
  assert.equal(baseline.canDelete, true);
  assert.equal(baseline.canSave, false, "没有修改时不亮保存");
  assert.equal(baseline.runHeld, false);
  assert.equal(baseline.fieldsDisabled, false);

  // unknown 代际：保存 / 删除 / 暂停 / 运行全部不可用；字段仍可填（等待才能改）
  const unknown = scheduleRowControls(controlsState({ capabilityKnown: false }));
  assert.equal(unknown.authoritative, false);
  assert.equal(unknown.canSave, false, "代际未知时保存不可用（不是可点但静默返回）");
  assert.equal(unknown.canDelete, false);
  assert.equal(unknown.canPause, false);
  assert.equal(unknown.runHeld, true);
  assert.equal(unknown.fieldsDisabled, false, "目录还没判明时字段仍可继续填");

  // 目录读取中：busy 覆盖所有入口；字段仍可填
  const loading = scheduleRowControls(controlsState({ catalogStatus: "loading", dirty: true }));
  assert.equal(loading.busy, true);
  assert.equal(loading.canSave, false);
  assert.equal(loading.canDelete, false);
  assert.equal(loading.canPause, false);
  assert.equal(loading.fieldsDisabled, false);

  // 读取失败同样不是权威目录
  const failed = scheduleRowControls(controlsState({ catalogStatus: "error" }));
  assert.equal(failed.authoritative, false);
  assert.equal(failed.canDelete, false);

  // 有本地修改：保存可用、运行与删除 / 暂停不可用
  const dirty = scheduleRowControls(controlsState({ dirty: true }));
  assert.equal(dirty.canSave, true);
  assert.equal(dirty.canDelete, false);
  assert.equal(dirty.canPause, false);
  assert.equal(dirty.runHeld, true);
  // 非法草稿（名称为空 / cron 坏 / 未选会话）不亮保存
  assert.equal(scheduleRowControls(controlsState({ dirty: true, invalid: true })).canSave, false);

  // 执行中：字段与运行禁用，保存也禁用
  const executing = scheduleRowControls(controlsState({ executionActive: true, dirty: true }));
  assert.equal(executing.fieldsDisabled, true);
  assert.equal(executing.runHeld, true);
  assert.equal(executing.canSave, false);
  assert.equal(executing.canDelete, false);
  assert.equal(executing.canPause, false);

  // 投递间隔未到：只挡运行，不挡保存 / 删除 / 暂停
  const floored = scheduleRowControls(controlsState({ floorActive: true, dirty: true }));
  assert.equal(floored.runHeld, true);
  assert.equal(floored.canSave, true);
  assert.equal(floored.canDelete, false, "dirty 仍挡删除");
  assert.equal(scheduleRowControls(controlsState({ floorActive: true })).canDelete, true);

  // 目标归档：挡运行，不挡保存 / 暂停 / 删除（与官方一致）
  const archived = scheduleRowControls(controlsState({ targetArchived: true, dirty: true }));
  assert.equal(archived.runHeld, true);
  assert.equal(archived.canSave, true);
  assert.equal(archived.canDelete, false);
  assert.equal(scheduleRowControls(controlsState({ targetArchived: true })).canPause, true);

  // 已结束：不出现暂停
  const ended = scheduleRowControls(controlsState({ ended: true }));
  assert.equal(ended.pauseVisible, false);
  assert.equal(ended.canPause, false);

  // 删除等待 / 保存等待共用同一个 busy：删除按钮不再只看自己的阶段
  assert.equal(scheduleRowControls(controlsState({ deleting: true })).canDelete, false);
  assert.equal(scheduleRowControls(controlsState({ pending: true, dirty: true })).canSave, false);
  assert.equal(scheduleRowControls(controlsState({ pending: true })).fieldsDisabled, true);
}
console.log("scheduleEditor: 变更入口策略 ✓");

// ---------- 8. 目标会话校验与下拉占位 ----------
{
  const create = scheduleCreateDraft();
  assert.equal(scheduleTargetError({ ...create, target: "new_once" }), undefined);
  assert.deepEqual(scheduleTargetError({ ...create, target: "session", sessionId: "" }), "invalid_target");
  assert.equal(scheduleTargetError({ ...create, target: "session", sessionId: "s1" }), undefined);
}

// ---------- 8b. 目标会话候选：blank 会话不再被跳过（官方用全部 sessions.ids） ----------
{
  const session = (id: string, title: string, blank = false): SessionSummaryView => ({
    id,
    title,
    updatedAt: 0,
    running: false,
    ...(blank ? { blank: true } : {}),
  });
  const sessions = [session("blank-1", "新对话", true), session("filled-1", "构建")];
  const choices = scheduleTargetSessionChoices(sessions, "current", "stored");
  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["current", "stored", "blank-1", "filled-1"],
    "空壳会话与内容会话一样可选（投递到空壳是服务端允许的目标）",
  );
  assert.deepEqual(
    scheduleTargetSessionChoices([], "current", "stored").map((choice) => choice.value),
    ["current", "stored"],
    "当前与会话原落点即使在列表外也保留",
  );
}

/** 按指定词典渲染一段界面，默认英文（与真实链路同一个 provider）。 */
const render = (element: ReturnType<typeof createElement>, locale: "zh" | "en" = "en"): string =>
  renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor(locale) },
      createElement(LocaleContext.Provider, { value: locale }, element),
    ),
  );

/** 取一个带指定 aria-label 的按钮开始标签，用来断言 disabled。 */
function buttonTag(html: string, aria: string): string {
  const match = new RegExp(`<button[^>]*aria-label="${aria.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`).exec(html);
  assert.ok(match, `渲染结果里找不到 ${aria}`);
  return match[0];
}

{
  const base = item({ title: "Build check" });
  const text = dictionaryFor("en");
  const renderRow = (
    overrides: Partial<ScheduleItemView>,
    options: {
      catalogStatus?: "ready" | "loading" | "error" | "unsupported";
      capabilityKnown?: boolean;
      modern?: boolean;
      archived?: readonly string[];
      locale?: "zh" | "en";
      open?: boolean;
      history?: ScheduleHistoryState;
    } = {},
  ): string => {
    const row = { ...base, ...overrides };
    const targetId = scheduleTargetSessionId(row);
    return render(
      createElement(ScheduleRow, {
        item: row,
        now: Date.parse(row.scheduledAt) - 60_000,
        open: options.open ?? true,
        modern: options.modern ?? true,
        capabilityKnown: options.capabilityKnown ?? true,
        catalogStatus: options.catalogStatus ?? "ready",
        targetArchived: targetId !== undefined && (options.archived ?? []).includes(targetId),
        sessionId: "s1",
        sessions: [],
        history: options.history,
        result: undefined,
        dispatch: () => {},
        onToggle: () => {},
      }),
      options.locale,
    );
  };

  // 操作条不依赖编辑区展开，所有操作都带中英文可见标签。
  for (const locale of ["zh", "en"] as const) {
    const texts = dictionaryFor(locale);
    const collapsed = renderRow({}, { locale, open: false });
    assert.match(collapsed, /class="job-row schedule-row" data-status="active"/);
    assert.match(collapsed, /class="schedule-row-actions"/);
    assert.ok(collapsed.includes(texts.scheduleRunNow));
    assert.ok(collapsed.includes(texts.schedulePause));
    assert.ok(collapsed.includes(texts.scheduleDelete));
    assert.doesNotMatch(collapsed, /class="job-panel"|schedule-confirm/);
    assert.doesNotMatch(buttonTag(collapsed, texts.scheduleRunAria(base.title)), /disabled/);
    const paused = renderRow({ status: "paused" }, { locale, open: false });
    assert.match(paused, /data-status="paused"/);
    assert.ok(paused.includes(texts.scheduleResume));
    assert.doesNotMatch(buttonTag(paused, texts.scheduleResumeAria(base.title)), /disabled/);
    const legacy = renderRow({}, { locale, open: false, modern: false });
    assert.ok(!legacy.includes(texts.scheduleRunAria(base.title)), "旧代折叠状态也没有运行入口");
  }

  // 复现用户的一次性任务：不论详情展开或折叠，中英文三个入口都应可用。
  for (const kind of ["at", "after"] as const) {
    for (const locale of ["zh", "en"] as const) {
      const texts = dictionaryFor(locale);
      for (const open of [false, true]) {
        const once = renderRow({ kind, scheduledAt: "2026-11-06T11:15:00.000Z" }, { locale, open });
        for (const aria of [texts.scheduleRunAria(base.title), texts.schedulePauseAria(base.title), texts.scheduleDeleteTitle(base.title)]) {
          assert.doesNotMatch(buttonTag(once, aria), /disabled/, `${kind} ${locale} open=${open}：未改动的任务可以操作`);
        }
        assert.ok(!once.includes(texts.scheduleUnsaved), "未编辑的一次性任务不显示未保存提示");
      }
    }
  }

  // 时区口径：列表“下次运行”按读者设备时区读（官方 formatScheduleAbsolute），执行记录按
  // 规则自己的时区读（官方 recordTimeZone → DeliveryHistory）。两处曾共用 storedZoneOf，
  // 列表会给读者看规则时区的钟点，rrule 又会丢掉 DTSTART 的 TZID。
  {
    const instant = Date.UTC(new Date().getFullYear(), 5, 15, 12, 0, 0); // 本年度内，避免跨年带年份
    const iso = new Date(instant).toISOString();
    const stampIn = (zone?: string): string =>
      new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        ...(zone === undefined ? {} : { timeZone: zone }),
      }).format(instant);
    const deviceStamp = stampIn();
    const tokyoStamp = stampIn("Asia/Tokyo");
    const daily = renderRow({ kind: "daily", time: "09:00:00.000", timeZone: "Asia/Tokyo", scheduledAt: iso });
    assert.ok(daily.includes(deviceStamp), "下次运行按设备时区显示");
    if (tokyoStamp !== deviceStamp) {
      assert.ok(!daily.includes(tokyoStamp), "不能把规则时区的钟点当成读者的钟点");
    }

    const recordInstant = instant - 3_600_000;
    const recordIso = new Date(recordInstant).toISOString();
    const historyEntry: ScheduleHistoryState = {
      records: [{ scheduledAt: recordIso, deliveredAt: recordIso }],
      unavailable: false,
      pruned: false,
      loading: false,
      loaded: true,
    };
    const records = renderRow(
      {
        kind: "rrule",
        rrule: "DTSTART;TZID=Asia/Tokyo:20260615T090000\nRRULE:FREQ=DAILY",
        scheduledAt: iso,
      },
      { history: historyEntry },
    );
    const recordStampIn = (zone?: string): string =>
      new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        ...(zone === undefined ? {} : { timeZone: zone }),
      }).format(recordInstant);
    assert.ok(records.includes(recordStampIn("Asia/Tokyo")), "rrule 的执行记录按 DTSTART 的 TZID 读");
    if (recordStampIn("Asia/Tokyo") !== recordStampIn()) {
      assert.ok(!records.includes(recordStampIn()), "规则时区与设备时区不同时，记录不按设备时区显示");
    }
  }

  // 执行中：运行、删除、暂停都禁用，表单只读
  const executing = renderRow({ executionActive: true });
  assert.match(buttonTag(executing, text.scheduleRunAria(base.title)), /disabled/, "执行中不能立即运行");
  assert.match(buttonTag(executing, text.scheduleDeleteTitle(base.title)), /disabled/, "执行中不能删除");
  assert.match(buttonTag(executing, text.schedulePauseAria(base.title)), /disabled/, "执行中不能暂停");
  assert.match(executing, /<input[^>]*id="schedule-edit-task-1-title"[^>]*disabled/, "执行中表单只读");

  // 投递间隔未到不等于仍在执行：中英文悬停说明与详情里的间隔提示一致。
  for (const locale of ["zh", "en"] as const) {
    const texts = dictionaryFor(locale);
    const floor = renderRow({ deliveryFloorEndsAt: "2026-11-06T02:01:00.000Z", executionActive: false }, { locale });
    const run = buttonTag(floor, texts.scheduleRunAria(base.title));
    assert.match(run, /disabled/, "投递间隔未到时不能立即运行");
    assert.ok(!run.includes(texts.scheduleRunPending), "间隔等待不能误报为投递仍在进行");
    assert.ok(!run.includes(texts.scheduleExecutionActive), "间隔等待不能误报为目标会话仍在执行");
    const notice = /<div class="job-notice">([^<]+)<\/div>/.exec(floor)?.[1];
    assert.ok(notice && run.includes(`title="${notice}"`), "悬停与详情共用真实的间隔结束说明");

    const both = renderRow({ deliveryFloorEndsAt: "2026-11-06T02:01:00.000Z", executionActive: true }, { locale });
    assert.ok(buttonTag(both, texts.scheduleRunAria(base.title)).includes(texts.scheduleExecutionActive), "确实执行中时仍说明执行占用");
    const expired = renderRow({ deliveryFloorEndsAt: "2026-11-06T01:58:00.000Z", executionActive: false }, { locale });
    assert.doesNotMatch(buttonTag(expired, texts.scheduleRunAria(base.title)), /disabled|title=/, "间隔到期后恢复运行入口");
  }

  // 目录读取中：三个入口同样禁用
  const loading = renderRow({}, { catalogStatus: "loading" });
  assert.match(buttonTag(loading, text.scheduleRunAria(base.title)), /disabled/, "目录读取中不能立即运行");
  assert.match(buttonTag(loading, text.scheduleDeleteTitle(base.title)), /disabled/, "目录读取中不能删除");
  assert.match(buttonTag(loading, text.schedulePauseAria(base.title)), /disabled/, "目录读取中不能暂停");

  // 目标归档：运行禁用 + 明确说明；删除 / 暂停不受归档影响（官方同口径）
  const archivedItem = item({ title: "Build check", target: { kind: "session", sessionId: "s2" } });
  const archivedRow = renderRow(archivedItem, { archived: ["s2"] });
  const archivedTag = buttonTag(archivedRow, text.scheduleRunAria(archivedItem.title));
  assert.match(archivedTag, /disabled/);
  assert.match(archivedTag, /title="[^"]*archived/i, "归档原因写在悬停说明里");
  assert.ok(archivedRow.includes(text.scheduleErrTargetArchived), "详情里明确说出目标已归档");
  assert.doesNotMatch(
    buttonTag(archivedRow, text.scheduleDeleteTitle(archivedItem.title)),
    /disabled/,
    "归档不挡删除（官方只挡运行）",
  );

  // 代际未知：不渲染立即运行与暂停（能力未判明，不显示无法保证的动作），显示能力
  // 说明；删除禁用。
  const unknown = renderRow({}, { capabilityKnown: false, modern: false });
  assert.ok(unknown.includes(text.scheduleCapabilityUnknown), "unknown 代际要说明原因");
  assert.equal(unknown.includes(text.scheduleRunAria(base.title)), false, "旧代 / 未知代际不渲染立即运行");
  assert.equal(unknown.includes(text.schedulePauseAria(base.title)), false, "未知代际不渲染暂停（能力未判明）");
  assert.match(buttonTag(unknown, text.scheduleDeleteTitle(base.title)), /disabled/);

  // 已结束：不显示暂停
  const ended = renderRow({ status: "ended" });
  assert.equal(ended.includes(text.schedulePauseAria(base.title)), false, "已结束的行不显示暂停按钮");
}
console.log("scheduleEditor: 归档 / 权威 / 禁用属性的真实渲染 ✓");

// ---------- 9. 选中会话：空值有占位、列表外会话原样保留、缺会话给出说明 ----------
{
  const draft = scheduleCreateDraft({ target: "session", sessionId: "" });
  const empty = render(
    createElement(ScheduleEditor, {
      idPrefix: "schedule-create",
      draft,
      onChange: () => {},
      disabled: false,
      basicDisabled: false,
      allowRrule: true,
      sessions: [],
      currentSessionId: undefined,
      storedTargetSessionId: undefined,
      texts: dictionaryFor("en"),
    }),
  );
  assert.match(
    empty,
    /<option[^>]*value=""[^>]*>Choose a conversation<\/option>/,
    "空会话有占位项，不会显示成第一个候选",
  );
  assert.ok(empty.includes(dictionaryFor("en").scheduleErrInvalidTarget), "空会话明确说明目标不完整");

  const archivedDraft = { ...draft, sessionId: "archived-9" };
  const outside = render(
    createElement(ScheduleEditor, {
      idPrefix: "schedule-edit",
      draft: archivedDraft,
      onChange: () => {},
      disabled: false,
      basicDisabled: false,
      allowRrule: true,
      sessions: [{ id: "s1", title: "当前会话", updatedAt: 0, running: false }],
      currentSessionId: "s1",
      storedTargetSessionId: "archived-9",
      texts: dictionaryFor("en"),
    }),
  );
  assert.match(
    outside,
    /<option[^>]*value="archived-9"[^>]*>archived-9<\/option>/,
    "已存的列表外会话原样保留为一项",
  );
  assert.match(outside, /<option[^>]*value="s1"/, "其余候选仍在");
}
console.log("scheduleEditor: 选中会话渲染 ✓");

// ---------- 10. 规则提示与目录候选的真实 SSR：坏 RRULE / DST 缺口 / cron 字段 / 注册表 ----------
{
  const renderEditor = (
    draft: ScheduleEditorDraft,
    texts: ReturnType<typeof dictionaryFor>,
    options: {
      locale?: "zh" | "en";
      timingBase?: ScheduleItemView;
      projects?: readonly ScheduleProjectView[];
      sessions?: readonly SessionSummaryView[];
    } = {},
  ): string =>
    render(
      createElement(ScheduleEditor, {
        idPrefix: "schedule-render",
        draft,
        onChange: () => {},
        disabled: false,
        basicDisabled: false,
        allowRrule: true,
        projects: options.projects,
        sessions: options.sessions ?? [],
        currentSessionId: undefined,
        storedTargetSessionId: undefined,
        timingBase: options.timingBase,
        texts,
      }),
      options.locale ?? "en",
    );

  const noticeOf = (html: string): string | undefined =>
    /<div class="job-notice is-error">([^<]*)<\/div>/.exec(html)?.[1];

  const en = dictionaryFor("en");
  const storedBroken = item({ kind: "rrule", rrule: "RRULE:FREQ=DAILY", updatedAt: "rev-broken" });
  const seededBroken = scheduleEditorDraft(storedBroken);

  // 官方 parser 判定的坏 RRULE：在真实渲染里给出规则级提示，而不是「间隔小于 60 秒」。
  const brokenDraft: ScheduleEditorDraft = {
    ...seededBroken,
    timing: { ...seededBroken.timing, rrule: "not a rule" },
  };
  assert.equal(noticeOf(renderEditor(brokenDraft, en)), en.scheduleRuleInvalid, "坏 RRULE 显示规则级提示");

  // 一次性 DST 缺口：官方 DTSTART 校验拒绝；重叠时刻合法，不显示提示。
  const gapDraft: ScheduleEditorDraft = {
    ...seededBroken,
    timing: {
      ...seededBroken.timing,
      repeat: "once",
      date: "2026-03-08",
      time: "02:30",
      timeZone: "America/New_York",
    },
  };
  assert.equal(noticeOf(renderEditor(gapDraft, en)), en.scheduleRuleInvalid, "DST 缺口里的本地时刻给出规则级提示");
  const overlapDraft: ScheduleEditorDraft = {
    ...gapDraft,
    timing: { ...gapDraft.timing, date: "2026-11-01", time: "01:30" },
  };
  assert.equal(noticeOf(renderEditor(overlapDraft, en)), undefined, "DST 重叠时刻存在，不显示提示");

  // 时区错误单独走时区文案（不混进规则级提示）。
  const zoneDraft: ScheduleEditorDraft = {
    ...seededBroken,
    timing: { ...seededBroken.timing, repeat: "daily", time: "09:00", timeZone: "Invalid/Zone" },
  };
  assert.equal(noticeOf(renderEditor(zoneDraft, en)), en.scheduleErrZone, "无效时区显示时区文案");

  // 编辑传 base：时间组没改就不提示，只改名称仍可保存；改了规则才提示。
  const keptDraft: ScheduleEditorDraft = { ...seededBroken, title: "Renamed" };
  assert.equal(
    noticeOf(renderEditor(keptDraft, en, { timingBase: storedBroken })),
    undefined,
    "未触碰的坏 RRULE 不产生提示（官方 changes.timing 短路）",
  );
  const keptPatch = schedulePatchOf(keptDraft, storedBroken);
  assert.ok("patch" in keptPatch, "只改名称仍可保存");
  assert.deepEqual(keptPatch.patch, { title: "Renamed" }, "只提交名称，不重写坏规则");
  assert.equal(
    scheduleRowControls(controlsState({
      dirty: true,
      invalid: scheduleTimingIssue(keptDraft.timing, storedBroken) !== undefined,
    })).canSave,
    true,
    "未触碰坏规则时保存入口可用",
  );
  assert.equal(
    scheduleRowControls(controlsState({
      dirty: true,
      invalid: scheduleTimingIssue(brokenDraft.timing, storedBroken) !== undefined,
    })).canSave,
    false,
    "真正改坏规则时保存入口禁用",
  );
  assert.equal(
    noticeOf(renderEditor(brokenDraft, en, { timingBase: storedBroken })),
    en.scheduleRuleInvalid,
    "真正改了规则才提示",
  );

  // cron 的字段级提示保持不变：仍然指出具体坏字段，而不是泛化为规则级提示。
  const storedCron = item({
    kind: "cron",
    expression: "0 9 * * 1-5",
    timeZone: "UTC",
    updatedAt: "rev-cron",
  });
  const cronDraft: ScheduleEditorDraft = {
    ...scheduleEditorDraft(storedCron),
    timing: { ...scheduleEditorDraft(storedCron).timing, expression: "0 9 * * 1-" },
  };
  const cronNotice = noticeOf(renderEditor(cronDraft, en, { timingBase: storedCron }));
  assert.equal(
    cronNotice,
    en.scheduleCronInvalid(cronFieldText("dayOfWeek", en)).replaceAll("'", "&#x27;"),
    "cron 字段错误保留字段级提示",
  );
  assert.notEqual(cronNotice, en.scheduleRuleInvalid, "cron 字段错误不折成规则级提示");

  // 注册表有 Workspace、会话列表为空：候选仍出现，默认标题按语言本地化。
  for (const locale of ["zh", "en"] as const) {
    const texts = dictionaryFor(locale);
    const html = renderEditor(scheduleCreateDraft(), texts, {
      locale,
      sessions: [],
      projects: [
        { path: "C:\\work", title: "default-workspace" },
        { path: "D:\\other", title: "Other" },
      ],
    });
    assert.ok(html.includes('value="C:\\work"'), `${locale}：零会话时注册目录仍在候选里`);
    assert.ok(html.includes(`>${texts.scheduleDefaultWorkspace}</option>`), `${locale}：默认标题已本地化`);
    assert.ok(html.includes(">Other</option>"), `${locale}：普通标题原样显示`);
    assert.ok(!html.includes(">default-workspace</"), `${locale}：不把官方内部标题直接呈现给用户`);
  }
}
console.log("scheduleEditor: 规则提示与注册目录候选的真实渲染 ✓");

console.log("\nscheduleEditor: all assertions passed");
