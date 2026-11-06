/**
 * 自动化任务的**管理面**离线回归：手动创建、立即运行、暂停恢复、名称 / 指令 / 目标
 * 编辑、全局目录与会话过滤、运行状态（执行中 / 投递间隔）。
 *
 * 这一层钉的是「界面说的那句话是否与载荷、状态、结算对得上」：
 *
 * - 载荷：`schedule/create` / `schedule/run` / `schedule/edit` 的字段名与基准（含 `null`）；
 * - 解码：新目录字段（target / executionActive / deliveryFloorEndsAt）、变更结果的
 *   严格收窄（不能把删除形状当成功）、能力探针与失败原因；
 * - 并发：编辑基准不被后台刷新覆盖、迟到结算帧被丢弃、宿主读取代号覆盖旧读；
 * - 界面：立即运行必须先本地确认、只提交改过的字段、全局 / 本会话两种视图共用一份目录。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduleItemView } from "../src/shared/chat";
import { DshClient } from "../src/dsh/client";
import {
  scheduleBaselineStale,
  scheduleCreateDraft,
  scheduleCreateRequestOf,
  scheduleEditorDraft,
  scheduleEditorDirty,
  scheduleForSession,
  scheduleInvolvesSession,
  scheduleIsActive,
  scheduleNextRunAt,
  schedulePatchOf,
  scheduleReapplyDraft,
  scheduleStatusOf,
  scheduleTargetRequest,
  scheduleTargetSessionId,
} from "../src/shared/schedule";
import {
  scheduleCapabilityOf,
  scheduleCreateRequestFromWire,
  scheduleEntriesFromCatalog,
  scheduleFailureCode,
  scheduleLimitsFromWire,
  scheduleMutationOutcome,
  schedulePatchFromWire,
  scheduleTargetView,
} from "../src/dsh/scheduleView";
import { scheduleNextOpId, scheduleResetOpIds, scheduleResultSettles } from "../src/webview/scheduleOps";
import { initialState, reducer } from "../src/webview/state";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

/** 新代目录条目（`ScheduleCatalogEntry` 的真实形状）。 */
function modernEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    kind: "every",
    title: "构建检查",
    prompt: "检查构建",
    everySeconds: 300,
    scheduledAt: "2026-11-06T02:00:00.000Z",
    target: { kind: "session", sessionId: "s1" },
    involvedSessionIds: ["s1", "creator"],
    status: "active",
    updatedAt: "2026-11-06T01:00:00.000Z",
    ...overrides,
  };
}

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
    ...overrides,
  };
}

// ---------- 1. 目录字段收窄：目标、执行中、投递间隔、创建时刻 ----------
{
  const entry = modernEntry({
    target: { kind: "new_once", sessionId: "reserved-1", create: { cwd: "D:/work", agentPreset: "p1" } },
    executionActive: true,
    deliveryFloorEndsAt: "2026-11-06T01:30:00.000Z",
    createdAt: "2026-11-05T00:00:00.000Z",
    lastDelivery: { scheduledAt: "2026-11-06T01:00:00.000Z", deliveredAt: "2026-11-06T01:00:01.000Z" },
  });
  const parsed = scheduleEntriesFromCatalog([entry])[0];
  assert.equal(parsed.item.api, "edit");
  assert.deepEqual(parsed.item.target, {
    kind: "new_once",
    sessionId: "reserved-1",
    cwd: "D:/work",
    agentPreset: "p1",
  });
  assert.equal(parsed.item.executionActive, true);
  assert.equal(parsed.item.deliveryFloorEndsAt, "2026-11-06T01:30:00.000Z");
  assert.equal(parsed.item.createdAt, "2026-11-05T00:00:00.000Z");
  assert.deepEqual(parsed.item.lastDelivery, {
    scheduledAt: "2026-11-06T01:00:00.000Z",
    deliveredAt: "2026-11-06T01:00:01.000Z",
  });

  // `new` 目标的落点取最近一次投递的目标会话（官方 taskSessionId 口径）
  const fanout = scheduleEntriesFromCatalog([
    modernEntry({
      target: { kind: "new", create: {} },
      involvedSessionIds: ["creator"],
      lastDelivery: {
        scheduledAt: "2026-11-06T01:00:00.000Z",
        deliveredAt: "2026-11-06T01:00:01.000Z",
        messageId: "msg-1",
        targetSessionId: "fresh-1",
      },
    }),
  ])[0];
  assert.equal(fanout.item.target?.kind, "new");
  assert.equal(scheduleTargetSessionId(fanout.item), "fresh-1");

  // 空数组照实保留（归属判定还会看投递落点，见第 3 节）；`new` 目标首次投递前没有落点
  const detached = scheduleEntriesFromCatalog([
    modernEntry({ target: { kind: "new", create: {} }, involvedSessionIds: [] }),
  ])[0];
  assert.deepEqual(detached.item.involvedSessionIds, []);
  assert.equal(detached.item.sessionId, "");
  assert.equal(detached.item.target?.sessionId, undefined);

  // 认不出的 target：不丢行，退回相关会话的第一条
  const unknownTarget = scheduleEntriesFromCatalog([
    modernEntry({ target: { kind: "future-kind" }, involvedSessionIds: ["a", "b"] }),
  ])[0];
  assert.equal(unknownTarget.item.target, undefined);
  assert.equal(unknownTarget.item.sessionId, "a");
  assert.equal(parsed.item.editable, true, "规则读得出基准才能编辑");
}
console.log("scheduleManage: 目录字段收窄 ✓");

// ---------- 2. 下一次运行时刻：投递间隔更晚时取间隔 ----------
{
  assert.equal(
    scheduleNextRunAt({ scheduledAt: "2026-11-06T02:00:00.000Z", deliveryFloorEndsAt: "2026-11-06T02:10:00.000Z" }),
    "2026-11-06T02:10:00.000Z",
  );
  assert.equal(
    scheduleNextRunAt({ scheduledAt: "2026-11-06T02:00:00.000Z", deliveryFloorEndsAt: "2026-11-06T01:50:00.000Z" }),
    "2026-11-06T02:00:00.000Z",
  );
  assert.equal(scheduleNextRunAt({ scheduledAt: "2026-11-06T02:00:00.000Z" }), "2026-11-06T02:00:00.000Z");
}
console.log("scheduleManage: 下一次运行时刻 ✓");

// ---------- 3. 归属过滤：相关会话集合或投递落点（官方 OR 口径） ----------
{
  // 官方 `taskInvolvesSession = involvedSessionIds.includes(id) || taskSessionId === id`：
  // 空集合 + 落点命中仍属于本会话；两边都不命中才为假。
  const detached = item({ involvedSessionIds: [], target: { kind: "session", sessionId: "s1" } });
  assert.equal(
    scheduleInvolvesSession(detached, "s1"),
    true,
    "落点命中当前会话就属于本会话（空集合不是「谁都无关」）",
  );
  assert.equal(scheduleInvolvesSession(detached, "other"), false, "集合与落点都不命中才不过滤进来");
  const involved = item({ involvedSessionIds: ["creator", "editor"], target: { kind: "session", sessionId: "target" } });
  assert.equal(scheduleInvolvesSession(involved, "editor"), true);
  assert.equal(scheduleInvolvesSession(involved, "target"), true, "投递落点本身也算相关");
  const legacy = item({ sessionId: "legacy-1" });
  assert.equal(scheduleInvolvesSession(legacy, "legacy-1"), true);
  assert.equal(scheduleInvolvesSession(legacy, "other"), false);
  assert.deepEqual(
    scheduleForSession([involved, legacy], "editor").map((one) => one.id),
    ["task-1"],
  );
  assert.deepEqual(scheduleForSession([involved], undefined), []);
}
console.log("scheduleManage: 归属过滤 ✓");

// ---------- 4. 状态档：旧代 inactive 与 ended 同义 ----------
{
  assert.equal(scheduleStatusOf(item({ status: "inactive" })), "ended");
  assert.equal(scheduleStatusOf(item({ status: "ended" })), "ended");
  assert.equal(scheduleStatusOf(item({ status: "paused" })), "paused");
  assert.equal(scheduleStatusOf(item({ status: "future" })), "future", "未知状态不猜成启用中");
  assert.equal(scheduleIsActive(item({ status: "active" })), true);
  assert.equal(scheduleIsActive(item({ status: "paused" })), false);
}
console.log("scheduleManage: 状态档 ✓");

// ---------- 5. 编辑草稿：目标三档、cwd、只提交改过的字段 ----------
{
  const modern = item({
    target: { kind: "new_once", sessionId: "reserved", cwd: "D:/w", agentPreset: "preset-1" },
    involvedSessionIds: ["s1"],
    api: "edit",
    updatedAt: "rev-1",
  });
  let draft = scheduleEditorDraft(modern);
  assert.equal(draft.target, "new_once");
  assert.equal(draft.cwd, "D:/w");
  assert.equal(scheduleEditorDirty(draft, modern), false, "刚种下的草稿不算修改");

  // 只改名称：patch 里只有 title，不重写时间 / 目标
  draft = { ...draft, title: "新名字" };
  const titleOnly = schedulePatchOf(draft, modern);
  assert.ok("patch" in titleOnly);
  assert.deepEqual(Object.keys(titleOnly.patch), ["title"]);
  assert.equal(titleOnly.patch.title, "新名字");

  // 只改目录：目标里保留原来的 agentPreset
  const cwdDraft = { ...scheduleEditorDraft(modern), cwd: "D:/w" };
  assert.equal(
    scheduleEditorDirty(cwdDraft, modern),
    false,
    "目录没变不算修改（否则每次保存都会重写 target）",
  );
  const targetRequest = scheduleTargetRequest({ ...cwdDraft, target: "new" }, modern);
  assert.deepEqual(targetRequest, { kind: "new", create: { cwd: "D:/w", agentPreset: "preset-1" } });
  const changedCwd = scheduleTargetRequest({ ...cwdDraft, target: "new", cwd: "D:/other" }, modern);
  assert.deepEqual(changedCwd, { kind: "new", create: { cwd: "D:/other" } }, "换了目录就不再沿用旧预设");

  // 没有任何修改 → 明确报错（不发明一次空 patch）
  assert.deepEqual(schedulePatchOf(scheduleEditorDraft(modern), modern), { error: "invalid_rule" });

  // 冲突后重放：改过的那一组用用户的值，其余用最新目录的值
  const latest = { ...modern, title: "别人的标题", prompt: "别人的指令", updatedAt: "rev-2" };
  const reapplied = scheduleReapplyDraft(draft, modern, latest);
  assert.equal(reapplied.title, "新名字");
  assert.equal(reapplied.prompt, "别人的指令");
  assert.equal(scheduleBaselineStale(latest, modern.updatedAt), true);
  assert.equal(scheduleBaselineStale(latest, "rev-2"), false);
}
console.log("scheduleManage: 编辑草稿与重放 ✓");

// ---------- 6. 创建草稿与请求体 ----------
{
  const draft = scheduleCreateDraft({ target: "new_once", sessionId: "s1" });
  assert.equal(draft.target, "new_once");
  assert.equal(draft.timing.repeat, "once");
  assert.ok(draft.timing.date >= new Date().toISOString().slice(0, 10), "默认目标在未来");
  const built = scheduleCreateRequestOf({
    ...draft,
    title: "  提醒  ",
    prompt: "  该喝水了  ",
    timing: { ...draft.timing, date: "2099-01-01", time: "09:00" },
  });
  assert.ok("request" in built);
  assert.equal(built.request.title, "提醒");
  assert.equal(built.request.prompt, "该喝水了");
  assert.deepEqual(built.request.timing, {
    kind: "at",
    at: { date: "2099-01-01", time: "09:00:00", time_zone: draft.timing.timeZone },
  });
  assert.deepEqual(built.request.target, { kind: "new_once" });

  const sessionTarget = scheduleCreateRequestOf({
    ...draft,
    title: "t",
    prompt: "p",
    target: "session",
    sessionId: "s9",
  });
  assert.ok("request" in sessionTarget);
  assert.deepEqual(sessionTarget.request.target, { kind: "session", sessionId: "s9" });

  // 空白名称 / 指令 / 未选会话 / 非法规则：本地就该拦住
  assert.deepEqual(scheduleCreateRequestOf({ ...draft, title: " ", prompt: "p" }), { error: "invalid_prompt" });
  assert.deepEqual(scheduleCreateRequestOf({ ...draft, title: "t", prompt: "" }), { error: "invalid_prompt" });
  assert.deepEqual(
    scheduleCreateRequestOf({ ...draft, title: "t", prompt: "p", target: "session", sessionId: "" }),
    { error: "invalid_target" },
  );
  assert.deepEqual(
    scheduleCreateRequestOf({ ...draft, title: "t", prompt: "p", timing: { ...draft.timing, date: "2099/01/01" } }),
    { error: "invalid_rule" },
  );
  assert.deepEqual(
    scheduleCreateRequestOf({ ...draft, title: "t", prompt: "p", timing: { ...draft.timing, repeat: "every", amount: "30", unit: "second" } }),
    { error: "frequency_too_high" },
    "固定间隔下限在本地就拦（服务端 60 秒）",
  );
}
console.log("scheduleManage: 创建草稿与请求体 ✓");

// ---------- 7. 变更结果的严格收窄 ----------
{
  // 成功：必须是能收窄成目录条目的那一支
  const ok = scheduleMutationOutcome(modernEntry());
  assert.equal(ok.ok, true);
  assert.equal(ok.entry?.id, "task-1");

  // 删除形状不能当创建 / 运行 / 编辑的成功
  assert.equal(scheduleMutationOutcome({ id: "task-1", deleted: true }).ok, false);
  // 身份不符：这是别的任务的结果
  assert.equal(scheduleMutationOutcome(modernEntry({ id: "other" }), "task-1").ok, false);
  // 正常的拒绝照实带 code
  assert.deepEqual(scheduleMutationOutcome({ id: "task-1", code: "schedule_execution_pending" }), {
    ok: false,
    code: "schedule_execution_pending",
    entry: undefined,
  });
  assert.deepEqual(scheduleMutationOutcome({}), { ok: false, code: "internal_error", entry: undefined });
  assert.deepEqual(scheduleMutationOutcome(null), { ok: false, code: "internal_error", entry: undefined });
}
console.log("scheduleManage: 变更结果收窄 ✓");

// ---------- 8. 投递限制、代际与失败原因 ----------
{
  assert.equal(scheduleLimitsFromWire({ newSessionIntervalSeconds: 60 }), 60);
  assert.equal(scheduleLimitsFromWire({ newSessionIntervalSeconds: 0 }), undefined);
  assert.equal(scheduleLimitsFromWire({ newSessionIntervalSeconds: "60" }), undefined);
  assert.equal(scheduleLimitsFromWire({}), undefined);

  const modern = scheduleEntriesFromCatalog([modernEntry()]);
  const legacy = scheduleEntriesFromCatalog([{ id: "x", kind: "every", title: "t", prompt: "p", scheduledAt: "z", sessionId: "s", everySeconds: 60, status: "active" }]);
  assert.equal(scheduleCapabilityOf(modern, "failed"), "modern", "非空新代目录不需要探针");
  assert.equal(scheduleCapabilityOf(legacy, "supported"), "legacy", "旧目录不会凭空变新代");
  assert.equal(scheduleCapabilityOf([], "supported"), "modern", "空目录 + 有效限制响应 → 新代");
  assert.equal(scheduleCapabilityOf([], "absent"), "legacy", "只有明确的 404 才是旧代");
  assert.equal(scheduleCapabilityOf([], "failed"), "unknown", "传输失败不能当成旧代");

  assert.equal(
    scheduleFailureCode({ code: "schedule/input-invalid", details: { code: "not_future" } }),
    "not_future",
  );
  assert.equal(
    scheduleFailureCode({ code: "schedule/input-invalid" }),
    "invalid_rule",
    "输入类错误没有具体原因时按规则不合法报",
  );
  assert.equal(scheduleFailureCode({ code: "schedule/target-archived" }), "target_archived");
  assert.equal(scheduleFailureCode({ code: "gateway/not-found" }), "gateway/not-found");
  assert.equal(scheduleFailureCode(new Error("HTTP 500")), undefined, "传输失败没有稳定原因");
}
console.log("scheduleManage: 限制、代际与失败原因 ✓");

// ---------- 9. 宿主边界：外来 patch / 创建请求逐字段验形 ----------
{
  assert.deepEqual(scheduleCreateRequestFromWire({ title: " t ", prompt: " p ", timing: { kind: "every", every_seconds: 300 } }), {
    request: { title: "t", prompt: "p", timing: { kind: "every", every_seconds: 300 } },
  });
  assert.deepEqual(scheduleCreateRequestFromWire({ title: "", prompt: "p", timing: { kind: "every", every_seconds: 300 } }), {
    error: "invalid_prompt",
  });
  assert.deepEqual(
    scheduleCreateRequestFromWire({ title: "t", prompt: "p", timing: { kind: "every", every_seconds: 30 } }),
    { error: "invalid_rule" },
    "间隔下限在宿主侧再拦一次",
  );
  assert.deepEqual(
    scheduleCreateRequestFromWire({ title: "t", prompt: "p", timing: { kind: "every", every_seconds: 300 }, target: { kind: "session" } }),
    { error: "invalid_target" },
  );
  assert.deepEqual(
    scheduleCreateRequestFromWire({ title: "t", prompt: "p", timing: { kind: "weekly", weekly: { time: "09:00:00", time_zone: "UTC", weekdays: [3, 1, 3] } } }),
    { request: { title: "t", prompt: "p", timing: { kind: "weekly", weekly: { time: "09:00:00", time_zone: "UTC", weekdays: [1, 3] } } } },
    "星期去重并升序",
  );

  assert.deepEqual(schedulePatchFromWire({ active: true }), { request: { active: true } });
  assert.deepEqual(schedulePatchFromWire({ title: " 名称 " }), { request: { title: "名称" } });
  assert.deepEqual(schedulePatchFromWire({}), { error: "invalid_rule" });
  assert.deepEqual(
    schedulePatchFromWire({ title: "t", unknownKey: 1 }),
    { error: "invalid_rule" },
    "未知键直接拒绝（不静默吞掉）",
  );
  assert.deepEqual(schedulePatchFromWire({ active: "yes" }), { error: "invalid_rule" });
  assert.deepEqual(schedulePatchFromWire({ title: "x".repeat(121) }), { error: "invalid_prompt" });
  assert.deepEqual(
    schedulePatchFromWire({ target: { kind: "new", create: { cwd: 3 } } }),
    { error: "invalid_target" },
  );

  // target 视图本身也做收窄
  assert.equal(scheduleTargetView({ kind: "session" }), undefined, "会话目标必须有 sessionId");
  assert.deepEqual(scheduleTargetView({ kind: "new_once" }), { kind: "new_once" });
}
console.log("scheduleManage: 宿主边界校验 ✓");

// ---------- 10. 客户端载荷：新端点与比较基准 ----------
{
  const calls: unknown[] = [];
  const client = Object.create(DshClient.prototype) as DshClient;
  client.request = async <T>(method: string, params: unknown): Promise<T> => {
    calls.push({ method, params });
    return undefined as T;
  };
  const request = { title: "t", prompt: "p", timing: { kind: "every", every_seconds: 300 } };
  void client.scheduleCreate(request);
  void client.scheduleRun("task-1");
  void client.scheduleDeliveryLimits();
  void client.scheduleEditPatch("task-1", { active: false }, null);
  void client.scheduleEditPatch("task-1", { timing: { kind: "every", every_seconds: 600 } }, "rev-1");
  void client.scheduleDelete("task-1", "task-1", { updatedAt: "rev-1" });
  void client.scheduleDelete("task-1", "task-1", {});
  assert.deepEqual(calls, [
    { method: "schedule/create", params: { request } },
    { method: "schedule/run", params: { request: { id: "task-1" } } },
    { method: "schedule/deliveryLimits", params: {} },
    {
      method: "schedule/edit",
      params: { request: { id: "task-1", action: "update", patch: { active: false }, expectedUpdatedAt: null } },
    },
    {
      method: "schedule/edit",
      params: { request: { id: "task-1", action: "update", patch: { timing: { kind: "every", every_seconds: 600 } }, expectedUpdatedAt: "rev-1" } },
    },
    { method: "schedule/edit", params: { request: { id: "task-1", action: "delete", expectedUpdatedAt: "rev-1" } } },
    { method: "schedule/edit", params: { request: { id: "task-1", action: "delete", expectedUpdatedAt: null } } },
  ]);
}
console.log("scheduleManage: 客户端载荷 ✓");

// ---------- 11. 结算账本：迟到帧与非当前操作不结算 ----------
{
  // 发号器在模块级：不依赖组件实例，重挂 / 重开也不会从 0 重数
  scheduleResetOpIds(0);
  assert.equal(scheduleNextOpId(), 1);
  assert.equal(scheduleNextOpId(), 2);
  const pending = { op: "update" as const, opId: 2, id: "task-1" };
  assert.equal(scheduleResultSettles(undefined, { op: "update", opId: 2, id: "task-1", ok: true }), false);
  assert.equal(scheduleResultSettles(pending, { op: "update", opId: 2, id: "task-1", ok: true }), true);
  assert.equal(
    scheduleResultSettles(pending, { op: "update", opId: 1, id: "task-1", ok: true }),
    false,
    "先发后回的那一次不许结算当前等待",
  );
  assert.equal(
    scheduleResultSettles(pending, { op: "update", opId: 2, id: "task-2", ok: true }),
    false,
    "别的任务的结果不许结算这一行",
  );
  assert.equal(
    scheduleResultSettles(pending, { op: "run", opId: 2, id: "task-1", ok: true }),
    false,
    "操作种类不同一定不是这一次",
  );
  assert.equal(
    scheduleResultSettles(pending, { op: "update", id: "task-1", ok: true }),
    true,
    "旧宿主不回 opId：按种类与 id 收下",
  );
  assert.equal(
    scheduleResultSettles({ op: "create", opId: 3 }, { op: "create", id: "fresh", opId: 3, ok: true }),
    true,
    "创建没有请求侧 id，回帧带新 id 也算同一次",
  );
}
console.log("scheduleManage: 结算账本 ✓");

// ---------- 12. 界面状态机：结算 / 限制 / 迟到的执行记录 ----------
{
  const pending = reducer(
    reducer(initialState, { type: "ui/scheduleHistoryRequest", id: "task-1", reset: true, opId: 2 }),
    {
      type: "schedules/history",
      id: "task-1",
      opId: 2,
      mode: "replace",
      records: [{ scheduledAt: "2026-11-06T01:00:00.000Z", deliveredAt: "2026-11-06T01:00:01.000Z" }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
    },
  );
  assert.equal(pending.scheduleHistory?.["task-1"]?.records.length, 1);
  assert.equal(pending.scheduleHistory?.["task-1"]?.opId, 2);

  // 迟到的旧页（opId 更小）整帧丢弃
  const late = reducer(pending, {
    type: "schedules/history",
    id: "task-1",
    opId: 1,
    mode: "append",
    records: [{ scheduledAt: "2026-11-05T01:00:00.000Z", deliveredAt: "2026-11-05T01:00:01.000Z" }],
    earlierRecordsUnavailable: false,
    earlierRecordsPruned: false,
  });
  assert.equal(late, pending, "旧 opId 的帧不改变状态");

  // 变更结算带 opId 与操作种类
  const settled = reducer(initialState, {
    type: "schedules/result",
    op: "run",
    id: "task-1",
    opId: 9,
    ok: false,
    code: "schedule_execution_pending",
  });
  assert.deepEqual(settled.scheduleResult, {
    op: "run",
    id: "task-1",
    opId: 9,
    ok: false,
    code: "schedule_execution_pending",
  });

  // 投递限制三种结果分开
  assert.deepEqual(
    reducer(initialState, { type: "schedules/limits", newSessionIntervalSeconds: 60 }).scheduleLimits,
    { newSessionIntervalSeconds: 60 },
  );
  assert.deepEqual(
    reducer(initialState, { type: "schedules/limits", unsupported: true }).scheduleLimits,
    { unsupported: true },
  );
  assert.deepEqual(
    reducer(initialState, { type: "schedules/limits", error: "offline" }).scheduleLimits,
    { error: "offline" },
  );
}
console.log("scheduleManage: 界面状态机 ✓");

// 投递限制属于原连接 / 会话；首帧、同范围刷新不丢缓存，换范围必须重读。
{
  for (const reply of [
    { type: "schedules/limits", newSessionIntervalSeconds: 60 },
    { type: "schedules/limits", unsupported: true },
    { type: "schedules/limits", error: "offline" },
  ] as const) {
    const connected = reducer(initialState, { type: "images/scope", connectionId: "connection-a" });
    const first = reducer(connected, { type: "state", state: { session: { id: "s1", title: "A", updatedAt: 0, running: false } } });
    const cached = reducer(first, reply);
    const refreshed = reducer(cached, { type: "state", state: { session: first.session } });
    assert.equal(refreshed.scheduleLimits, cached.scheduleLimits, "同一会话快照不丢缓存");
    assert.equal(
      reducer(cached, { type: "images/scope", connectionId: "connection-a" }).scheduleLimits,
      cached.scheduleLimits,
      "同一连接的范围通知不丢缓存",
    );
    assert.equal(
      reducer(cached, { type: "state", state: { session: { id: "s2", title: "B", updatedAt: 0, running: false } } }).scheduleLimits,
      undefined,
      "换会话后不保留旧值、端点缺席或读取失败结论",
    );
    assert.equal(
      reducer(cached, { type: "state", state: { session: null } }).scheduleLimits,
      undefined,
      "离开会话后不保留投递限制",
    );
    assert.equal(
      reducer(cached, { type: "images/scope", connectionId: "connection-b" }).scheduleLimits,
      undefined,
      "即使会话 id 相同，换连接也必须重读投递限制",
    );
    assert.equal(
      reducer(cached, { type: "images/scope", connectionId: null }).scheduleLimits,
      undefined,
      "旧连接被释放时立即作废投递限制",
    );
  }
}
console.log("scheduleManage: 投递限制按连接与会话隔离 ✓");

// ---------- 13. 宿主接线：一条目录、读取代号、视图绑定、每条路都回帧 ----------
{
  const controller = read("src", "dsh", "controller.ts");
  assert.ok(
    /scope\.schedules = entries\.map\(\(entry\) => entry\.item\)/.test(controller),
    "目录整份落进域（不在宿主侧过滤会话）",
  );
  assert.ok(
    !/scheduleEntriesFromCatalog\(value\)\.filter\(/.test(controller),
    "宿主不再按会话过滤目录（全局操作不能被当前会话拦住）",
  );
  assert.ok(
    /scope\.schedulesEpoch === epoch/.test(controller) && /scheduleReadCurrent\(/.test(controller),
    "同一域的并发读取按代号丢弃旧读",
  );
  assert.ok(
    /scheduleCapabilityOf\(entries, "failed"\)/.test(controller) &&
      /capability = seconds === undefined \? "unknown" : "modern"/.test(controller),
    "只有有效的限制响应才建立新代能力",
  );
  assert.ok(
    /const bound = this\.scopeOfView\(viewId\)/.test(controller) && /bound !== scope/.test(controller),
    "结算帧按视图当前绑定的域判迟到（旧域仍存在也不够）",
  );
  for (const net of ['case "createSchedule"', 'case "runSchedule"', 'case "setScheduleActive"', 'case "editSchedule"', 'case "scheduleLimits"']) {
    assert.ok(controller.includes(net), `宿主路由缺 ${net}`);
  }
  assert.ok(
    /scheduleCreateRequestFromWire\(message\.request\)/.test(controller) &&
      /client\.scheduleCreate\(validation\.request\)/.test(controller) &&
      /client\.scheduleRun\(message\.id\)/.test(controller),
    "创建与立即运行走各自的新端点",
  );
  assert.ok(
    /client\.scheduleEditPatch\(message\.id, \{ active: message\.active \}, message\.expectedUpdatedAt\)/.test(controller),
    "暂停恢复走 edit 的 patch.active，基准取自请求",
  );
  assert.ok(
    /const validation = schedulePatchFromWire\(message\.patch\);/.test(controller),
    "编辑先验形状再转发",
  );
  assert.ok(
    /const revision =\s*\n\s*item\.api === "edit" \? \{ updatedAt: message\.expectedUpdatedAt \?\? undefined \} : undefined;/.test(controller),
    "删除的比较基准取自用户开始操作时看到的那一版",
  );
  assert.ok(
    /this\.scopeOfView\(viewId\) !== scope \|\| this\.client !== client/.test(controller),
    "执行记录与限制读取在 await 之后隔离视图 / 客户端",
  );
  assert.ok(
    /private scheduleMutationCurrent\([\s\S]{0,400}?this\.scopeOfView\(viewId\) === scope[\s\S]{0,200}?this\.scopes\.get\(scope\.sessionId\) === scope[\s\S]{0,200}?this\.client === client/.test(controller),
    "变更请求 await 之后的副作用统一按视图 / 域 / 客户端判当前上下文",
  );
  assert.ok(
    /if \(current && endpointAbsent\(error\)\) this\.markSchedulesLegacy\(scope\);/.test(controller),
    "只有当前上下文里整组端点缺席才降级为旧代",
  );
  assert.ok(
    /case "scheduleLimits"[\s\S]{0,1400}?if \(this\.scopeOfView\(viewId\) !== scope \|\| this\.client !== client\)/.test(controller),
    "投递间隔的迟到失败帧不得给当前域降级",
  );
  assert.ok(
    /this\.applyMutatedSchedule\(scope, outcome\.entry\)/.test(controller) &&
      /await this\.loadSchedules\(scope, true\)/.test(controller),
    "成功的变更先把权威条目并回目录、再读回整份目录（成功结算在刷新之后）",
  );
}
console.log("scheduleManage: 宿主接线 ✓");

// ---------- 14. 界面：视图切换、确认门、只提交改过的字段、冲突重放 ----------
{
  const schedules = read("src", "webview", "components", "Schedules.tsx");
  assert.ok(/texts\.scheduleViewSession/.test(schedules) && /texts\.scheduleViewAll/.test(schedules), "两种视图入口");
  assert.ok(/scheduleForSession\(schedules, sessionId\)/.test(schedules), "本会话只是派生过滤");
  assert.ok(
    /scopeView === "all" \? schedules : scheduleForSession/.test(schedules),
    "全局视图直接用整份目录",
  );
  assert.ok(/texts\.scheduleRunConfirmNote/.test(schedules), "立即运行必须说明后果");
  assert.ok(
    /post\(\{ type: "runSchedule", id: item\.id, opId \}\)/.test(schedules) &&
      /disabled=\{controls\.runHeld\}/.test(schedules),
    "立即运行在确认后才发请求，并在执行中 / 间隔未到 / 有未保存修改 / 目标归档时不可用",
  );
  assert.ok(
    /post\(\{\s*type: "setScheduleActive"/.test(schedules),
    "暂停 / 恢复走 setScheduleActive",
  );
  assert.ok(
    /post\(\{\s*type: "editSchedule",\s*id: item\.id,\s*patch: built\.patch,\s*expectedUpdatedAt: base\.updatedAt \?\? null,/.test(schedules),
    "编辑提交只带改过的字段，基准是用户开始时看到的那一版",
  );
  assert.ok(
    /schedulePatchOf\(draft, base\)/.test(schedules) &&
      /dispatchEditor\(\{ type: "reapply", item \}\)/.test(schedules),
    "冲突时提供重新应用（不静默覆盖）",
  );
  const editorState = read("src", "webview", "scheduleEditorState.ts");
  assert.ok(
    /scheduleReapplyDraft\(state\.draft, state\.base, action\.item\)/.test(editorState) &&
      /case "saved":/.test(editorState) &&
      /scheduleEditorStateDirty\(state\) \? state : scheduleEditorState\(action\.item\)/.test(editorState),
    "状态机：保存成功与权威刷新后的草稿 / 基线推进、后台刷新不覆盖本地修改",
  );
  const controls = read("src", "webview", "scheduleControls.ts");
  assert.ok(
    /const busy = state\.pending \|\| state\.deleting \|\| state\.catalogStatus === "loading"/.test(controls) &&
      /state\.executionActive && authoritative/.test(controls),
    "一行的变更共用 busy，且目录不是权威时不放行",
  );
  assert.ok(
    /const opId = scheduleNextOpId\(\);/.test(schedules) &&
      !/useRef\(0\)[\s\S]{0,200}?scheduleNextOpId/.test(schedules),
    "操作标识来自模块级发号器，不按组件实例从零重数",
  );
  assert.ok(
    /post\(\{ type: "createSchedule", request: built\.request, opId \}\)/.test(schedules),
    "手动创建走 schedule/create",
  );
  assert.ok(
    /scheduleResultSettles\(pending, result\)/.test(schedules),
    "界面按操作标识只收自己那一次的结算",
  );
  assert.ok(
    /scheduleNextRunAt\(item\)/.test(schedules),
    "显示的下一次运行时刻考虑投递间隔（不比 floor 早）",
  );
  assert.ok(
    /item\.executionActive === true/.test(schedules) && /item\.deliveryFloorEndsAt/.test(schedules),
    "展示执行中与投递间隔两类实际状态",
  );
  assert.ok(
    /draft\.target === "new"/.test(schedules) && /post\(\{ type: "scheduleLimits" \}\)/.test(schedules),
    "只有「每次新建会话」才显示并读取投递间隔",
  );

  const editor = read("src", "webview", "components", "ScheduleEditor.tsx");
  for (const field of ["scheduleFieldTitle", "scheduleFieldPrompt", "scheduleFieldTarget", "scheduleFieldCwd"]) {
    assert.ok(editor.includes(`texts.${field}`), `编辑表单缺 ${field}`);
  }
  assert.ok(/basicDisabled/.test(editor), "旧代只读基础字段、仍可改时间");

  const ipc = read("src", "shared", "ipc.ts");
  for (const frame of ['"createSchedule"', '"runSchedule"', '"setScheduleActive"', '"editSchedule"', '"scheduleLimits"', '"schedules/limits"']) {
    assert.ok(ipc.includes(frame), `IPC 协议缺 ${frame}`);
  }
  assert.ok(/opId\?: number/.test(ipc), "请求与结算都带操作标识");

  const state = read("src", "webview", "state.ts");
  assert.ok(
    /if \(action\.opId !== undefined && previous\?\.opId !== undefined && action\.opId !== previous\.opId\) return state;/.test(state),
    "执行记录的回帧必须属于最近一次请求（迟到 / 错配整帧丢弃）",
  );
  assert.ok(/case "schedules\/limits":/.test(state), "投递间隔帧有落点");

  const app = read("src", "webview", "App.tsx");
  for (const prop of [
    "schedulesCapability={state.schedulesCapability}",
    "archivedSessionIds={archivedSessionIds}",
    "newSessionIntervalSeconds={state.newSessionIntervalSeconds}",
    "scheduleLimits={state.scheduleLimits}",
    "sessions={state.sessions}",
  ]) {
    assert.ok(app.includes(prop), `App 没有把 ${prop} 交给面板`);
  }

  const css = read("src", "webview", "styles", "app.css");
  for (const selector of [".schedule-toolbar", ".schedule-tab", ".schedule-chip", ".schedule-confirm"]) {
    assert.ok(css.includes(selector), `样式缺 ${selector}`);
  }
}
console.log("scheduleManage: 界面接线 ✓");

// ---------- 15. 文案：新增条目中英齐全 ----------
{
  const messages = read("src", "webview", "messages.ts");
  for (const key of [
    "scheduleViewSession",
    "scheduleViewAll",
    "scheduleNew",
    "scheduleCreateTitle",
    "scheduleRunNow",
    "scheduleRunConfirmNote",
    "scheduleRunConfirmAction",
    "scheduleRunPending",
    "scheduleExecutionActive",
    "scheduleDeliveryFloor",
    "schedulePause",
    "scheduleResume",
    "scheduleConflictNotice",
    "scheduleReapply",
    "scheduleErrUnsupported",
    "scheduleErrStale",
    "scheduleErrTargetArchived",
    "scheduleCapabilityLegacy",
    "scheduleCapabilityUnknown",
    "scheduleEmptyFilter",
  ]) {
    assert.ok(new RegExp(`\\n  ${key}: \\{`).test(messages), `消息表缺 ${key}`);
  }
  // 组件里不许写死中文（一律走 texts）
  const schedules = read("src", "webview", "components", "Schedules.tsx");
  const editor = read("src", "webview", "components", "ScheduleEditor.tsx");
  for (const [file, source] of [
    ["Schedules.tsx", schedules],
    ["ScheduleEditor.tsx", editor],
  ] as const) {
    const hardcoded = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter((line) => /["'>][^"'<>]*[\u4e00-\u9fa5][^"'<>]*["'<]/.test(line));
    assert.deepStrictEqual(hardcoded, [], `${file} 里不许写死中文文案`);
  }
}
console.log("scheduleManage: 文案 ✓");

console.log("\nscheduleManage: all assertions passed");
