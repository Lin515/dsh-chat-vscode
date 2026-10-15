/**
 * 自动化任务（DSH `schedule`）：线格式收窄、显示口径、运行时间编辑与接线 / 样式。
 *
 * 为什么逐条钉：这一块的每一处错误都表现为**一句与事实相反的话**——
 * 「没有自动化任务」（其实没读到）、「一次性」（其实是一条读不懂的规则）、
 * 「已保存」（其实服务端回了 `schedule_conflict`）。所以形状读取、频率文本、
 * 草稿比对与变更装配都要有离线断言；接线那几条钉的是「宿主每次请求都回帧」
 * 「界面只交任务 id」「两段式删除」这些肉眼难复查的点。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduleItemView } from "../src/shared/chat";
import {
  clockLabel,
  cronFieldError,
  deviceZone,
  everyAmount,
  formatScheduleStamp,
  formatWeekdays,
  orderSchedules,
  relativeAmount,
  relativeText,
  scheduleChangeFromDraft,
  scheduleDraft,
  scheduleDraftDiffers,
  scheduleFrequency,
  scheduleRuleZone,
  secondPrecision,
  storedZoneOf,
  zoneChoices,
  type ScheduleTexts,
} from "../src/shared/schedule";
import {
  scheduleDeleteOutcome,
  scheduleEntriesFromCatalog,
  scheduleExpectedOf,
  scheduleHistoryFromWire,
  scheduleUpdateOutcome,
} from "../src/dsh/scheduleView";

/** 一份够用的英文词典：断言只关心拼装出的句子，不关心语言。 */
const texts: ScheduleTexts = {
  scheduleOnce: "Once",
  scheduleEvery: (value, unit) => `Every ${value} ${unit}`,
  scheduleUnitSec: () => "sec",
  scheduleUnitMin: () => "min",
  scheduleUnitHour: (value) => (value === 1 ? "hour" : "hours"),
  scheduleUnitDay: (value) => (value === 1 ? "day" : "days"),
  scheduleDaily: (time, zone) => (zone ? `Every day at ${time} (${zone})` : `Every day at ${time}`),
  scheduleWeekly: (weekdays, time, zone) =>
    zone ? `Weekly on ${weekdays} at ${time} (${zone})` : `Weekly on ${weekdays} at ${time}`,
  scheduleCron: (expression, zone) => (zone ? `Cron ${expression} (${zone})` : `Cron ${expression}`),
  scheduleWeekday1: "Mon",
  scheduleWeekday2: "Tue",
  scheduleWeekday3: "Wed",
  scheduleWeekday4: "Thu",
  scheduleWeekday5: "Fri",
  scheduleWeekday6: "Sat",
  scheduleWeekday7: "Sun",
  scheduleWeekdayJoin: ", ",
  scheduleRelativeFuture: (value, unit) => `in ${value} ${unit}`,
  scheduleRelativeOverdue: (value, unit) => `overdue by ${value} ${unit}`,
  scheduleRelativeNow: "now",
};

/** 目录条目（真形状：规则 + 绑定 + 状态；`lastDelivery` 可选）。 */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "schedule-1",
    kind: "every",
    title: "构建检查",
    prompt: "检查构建",
    everySeconds: 300,
    scheduledAt: "2026-10-15T02:00:00.000Z",
    sessionId: "s1",
    status: "active",
    ...overrides,
  };
}

function item(overrides: Partial<ScheduleItemView> = {}): ScheduleItemView {
  return {
    id: "schedule-1",
    sessionId: "s1",
    title: "构建检查",
    prompt: "检查构建",
    kind: "every",
    status: "active",
    scheduledAt: "2026-10-15T02:00:00.000Z",
    everySeconds: 300,
    ...overrides,
  };
}

// ---------- 1. 目录收窄：身份三件套缺一不可，编辑基准只留规则字段 ----------
{
  const entries = scheduleEntriesFromCatalog([
    entry(),
    // 缺 id / 缺 sessionId / 缺 scheduledAt / 缺 kind：都拼不出一条诚实的行
    entry({ id: undefined }),
    entry({ sessionId: undefined }),
    entry({ scheduledAt: undefined }),
    entry({ kind: undefined }),
    "not an object",
    // 目录条目比记录多三个成员：编辑基准里一个都不许出现
    entry({ lastDelivery: { scheduledAt: "2026-10-15T01:00:00.000Z", deliveredAt: "2026-10-15T01:00:01.000Z" } }),
  ]);
  assert.strictEqual(entries.length, 2, "只有两条读得出身份：一条普通、一条带投递");
  assert.strictEqual(entries[0].item.id, "schedule-1");
  assert.strictEqual(entries[0].item.sessionId, "s1");
  assert.strictEqual(entries[0].item.status, "active");
  assert.strictEqual(entries[0].item.lastDelivery, undefined);
  assert.deepStrictEqual(
    entries[1].item.lastDelivery,
    { scheduledAt: "2026-10-15T01:00:00.000Z", deliveredAt: "2026-10-15T01:00:01.000Z" },
    "最近一次投递读得到（界面据此显示「已结束」的时间）",
  );
  const expected = entries[0].expected;
  assert.deepStrictEqual(expected, {
    id: "schedule-1",
    kind: "every",
    title: "构建检查",
    prompt: "检查构建",
    scheduledAt: "2026-10-15T02:00:00.000Z",
    everySeconds: 300,
  }, "编辑基准只留 ScheduleRecord 自己的字段（官方 timingSnapshot 同口径）");

  // 缺关键规则字段的种类读不出基准 → 不给编辑入口，但**仍然显示这一行**
  const broken = scheduleEntriesFromCatalog([entry({ kind: "weekly", weekdays: [1, "2"] })]);
  assert.strictEqual(broken.length, 1);
  assert.strictEqual(broken[0].expected, undefined, "半张星期表不是「少一天」而是坏帧：不给编辑基准");
  assert.strictEqual(broken[0].item.weekdays, undefined);
  assert.strictEqual(broken[0].item.editable, false, "读不出基准的行要在一开始就标成只读");
  assert.strictEqual(entries[0].item.editable, true, "读得出基准的行可编辑");
}
console.log("schedule: 目录收窄与编辑基准 ✓");

// ---------- 2. 各种规则的编辑基准逐字段对齐 ----------
{
  assert.deepStrictEqual(
    scheduleExpectedOf({
      id: "x", kind: "at", title: "t", prompt: "p", scheduledAt: "2026-10-15T02:00:00.000Z", sessionId: "s1",
    } as never),
    { id: "x", kind: "at", title: "t", prompt: "p", scheduledAt: "2026-10-15T02:00:00.000Z" },
    "一次性的基准不该多出规则字段",
  );
  assert.deepStrictEqual(
    scheduleExpectedOf({
      id: "x", kind: "cron", title: "t", prompt: "p", scheduledAt: "2026-10-15T02:00:00.000Z",
      expression: "0 9 * * *", timeZone: "Asia/Shanghai",
    } as never),
    {
      id: "x", kind: "cron", title: "t", prompt: "p", scheduledAt: "2026-10-15T02:00:00.000Z",
      expression: "0 9 * * *", timeZone: "Asia/Shanghai",
    },
  );
  assert.strictEqual(
    scheduleExpectedOf({ id: "x", kind: "weekly", title: "t", prompt: "p", scheduledAt: "z" } as never),
    undefined,
    "墙上时钟规则缺 time / timeZone / weekdays 就拼不出基准",
  );
  assert.strictEqual(
    scheduleExpectedOf({ id: "x", kind: "after", title: "t", prompt: "p", scheduledAt: "z" } as never),
    undefined,
    "after 必须有 afterSeconds（它决定记录的拼写）",
  );
}
console.log("schedule: 编辑基准逐种类 ✓");

// ---------- 3. 执行记录的三种「没有」分开，变更结果两支分明 ----------
{
  const page = scheduleHistoryFromWire({
    id: "schedule-1",
    records: [{ scheduledAt: "2026-10-15T01:00:00.000Z", deliveredAt: "2026-10-15T01:00:02.000Z", prompt: "检查构建" }],
    earlierRecordsUnavailable: true,
    earlierRecordsPruned: false,
    retention: { days: 30, records: 200 },
    nextBefore: "msg-1",
  });
  assert.ok(page);
  assert.strictEqual(page.records.length, 1);
  assert.strictEqual(page.records[0].prompt, "检查构建");
  assert.strictEqual(page.code, undefined);
  assert.strictEqual(page.nextBefore, "msg-1");
  assert.strictEqual(page.earlierRecordsUnavailable, true);
  assert.strictEqual(page.earlierRecordsPruned, false);
  assert.deepStrictEqual(page.retention, { days: 30, records: 200 });

  // 旧记录没有 prompt 快照：不许拿当前指令顶替（读出来就是 undefined）
  const legacy = scheduleHistoryFromWire({ id: "x", records: [{ scheduledAt: "a", deliveredAt: "b" }] });
  assert.strictEqual(legacy?.records[0].prompt, undefined);

  // 失败支：任务不存在 / 游标失效——两者都**不是**「空历史」
  const missing = scheduleHistoryFromWire({ id: "x", code: "schedule_not_found" });
  assert.strictEqual(missing?.code, "schedule_not_found");
  const lost = scheduleHistoryFromWire({ id: "x", code: "delivery_cursor_not_found" });
  assert.strictEqual(lost?.code, "delivery_cursor_not_found");
  // 既没有 code 也没有 records 数组：整帧认不出（丢掉，不动现有记录）
  assert.strictEqual(scheduleHistoryFromWire({ id: "x" }), undefined);
  assert.strictEqual(scheduleHistoryFromWire(null), undefined);

  assert.deepStrictEqual(scheduleUpdateOutcome({ id: "x", updated: true, record: {} }), { ok: true, code: undefined });
  assert.deepStrictEqual(
    scheduleUpdateOutcome({ id: "x", updated: false, code: "schedule_conflict" }),
    { ok: false, code: "schedule_conflict" },
    "没改成一律带稳定错误码回来",
  );
  assert.deepStrictEqual(
    scheduleUpdateOutcome({ code: "not_future", message: "…" }),
    { ok: false, code: "not_future" },
    "工具错误那一支没有 updated 字段，同样算没改成",
  );
  assert.deepStrictEqual(scheduleUpdateOutcome({}), { ok: false, code: "internal_error" });
  assert.deepStrictEqual(scheduleDeleteOutcome({ id: "x", deleted: true }), { ok: true, code: undefined });
  assert.deepStrictEqual(scheduleDeleteOutcome({ id: "x", deleted: false, code: "schedule_not_found" }), {
    ok: false,
    code: "schedule_not_found",
  });
}
console.log("schedule: 执行记录与变更结算 ✓");

// ---------- 4. 频率与相对时间的措辞 ----------
{
  assert.strictEqual(scheduleFrequency(item({ kind: "at" }), texts), "Once");
  assert.strictEqual(scheduleFrequency(item({ kind: "after", afterSeconds: 600 }), texts), "Once");
  assert.strictEqual(scheduleFrequency(item(), texts), "Every 5 min", "300 秒读作 5 分（不是 300 秒）");
  assert.strictEqual(
    scheduleFrequency(item({ kind: "every", everySeconds: 43_200 }), texts),
    "Every 12 hours",
    "英文单位分单复数（12 小时不是 12 hour）",
  );
  assert.strictEqual(scheduleFrequency(item({ kind: "every", everySeconds: 86_400 }), texts), "Every 1 day");
  assert.deepStrictEqual(everyAmount(86_400), { value: 1, unit: "day" });
  assert.strictEqual(everyAmount(5_400).value, 90, "5400 秒读作 90 分，不做小数小时");
  assert.strictEqual(everyAmount(90).unit, "second");
  assert.strictEqual(
    scheduleFrequency(item({ kind: "daily", time: "23:00:00.000", timeZone: "Asia/Shanghai" }), texts, {
      system: "Asia/Shanghai",
    }),
    "Every day at 23:00",
    "规则时区与系统时区相同 → 不名时区",
  );
  const dailyOther = scheduleFrequency(
    item({ kind: "daily", time: "09:30:15.000", timeZone: "UTC" }),
    texts,
    { system: "Asia/Shanghai", locale: "en" },
  );
  assert.ok(dailyOther?.startsWith("Every day at 09:30:15 ("), `别的时区要名出来：${dailyOther}`);
  assert.strictEqual(
    scheduleFrequency(item({ kind: "weekly", time: "09:00:00.000", timeZone: "UTC", weekdays: [1, 3, 5] }), texts, {
      system: "UTC",
    }),
    "Weekly on Mon, Wed, Fri at 09:00",
  );
  assert.strictEqual(
    scheduleFrequency(item({ kind: "cron", expression: "*/15 9-17 * * 1-5", timeZone: "UTC" }), texts, { system: "UTC" }),
    "Cron */15 9-17 * * 1-5",
    "本扩展对 cron 显示规范表达式本身（官方解析失败时的退回形态）",
  );
  // 关键字段缺失 / 词表外的种类：**不猜**，返回 undefined
  assert.strictEqual(scheduleFrequency(item({ kind: "every", everySeconds: undefined }), texts), undefined);
  assert.strictEqual(scheduleFrequency(item({ kind: "weekly", weekdays: undefined }), texts), undefined);
  assert.strictEqual(scheduleFrequency(item({ kind: "future-kind" }), texts), undefined);

  assert.strictEqual(clockLabel("23:00:00.000"), "23:00");
  assert.strictEqual(clockLabel("09:30:15.500"), "09:30:15");
  assert.strictEqual(secondPrecision("09:30"), "09:30:00");
  assert.strictEqual(secondPrecision("09:30:15"), "09:30:15");
  assert.strictEqual(formatWeekdays([7, 1], texts), "Sun, Mon", "顺序原样保留（服务端给的是升序）");

  const now = Date.parse("2026-10-15T02:00:00.000Z");
  assert.deepStrictEqual(relativeAmount("2026-10-15T02:00:00.000Z", now), "now");
  assert.deepStrictEqual(relativeAmount("2026-10-15T02:05:00.000Z", now), { value: 5, unit: "minute" });
  assert.deepStrictEqual(
    relativeAmount("2026-10-15T01:59:30.000Z", now),
    { value: 30, unit: "second" },
    "过去的一律向下取整",
  );
  assert.deepStrictEqual(
    relativeAmount("2026-10-15T02:01:30.000Z", now),
    { value: 2, unit: "minute" },
    "未来的一律向上取整（还差 90 秒读作 2 分钟）",
  );
  assert.deepStrictEqual(
    relativeAmount("2026-10-15T03:01:00.000Z", now),
    { value: 2, unit: "hour" },
    "单位取「幅度不小于它」的最大者（61 分钟读作 2 小时，不是 61 分）",
  );
  assert.strictEqual(relativeAmount("not a time", now), undefined);
  assert.strictEqual(relativeText("2026-10-15T02:05:00.000Z", now, texts), "in 5 min");
  assert.strictEqual(relativeText("2026-10-15T01:55:00.000Z", now, texts), "overdue by 5 min");
  assert.strictEqual(relativeText("2026-10-15T02:00:00.000Z", now, texts), "now");
}
console.log("schedule: 频率与相对时间 ✓");

// ---------- 5. 排序：过期在前，其余按目标升序 ----------
{
  const at = (iso: string, id: string) => item({ scheduledAt: iso, id });
  const now = Date.parse("2026-10-15T02:00:00.000Z");
  const ordered = orderSchedules(
    [
      at("2026-10-15T05:00:00.000Z", "future-late"),
      at("2026-10-15T01:00:00.000Z", "overdue"),
      at("2026-10-15T03:00:00.000Z", "future-soon"),
      at("2026-10-15T02:00:00.000Z", "due-now"),
    ],
    now,
  );
  assert.deepStrictEqual(
    ordered.map((one) => one.id),
    ["overdue", "due-now", "future-soon", "future-late"],
    "过期的排最前（含正好到点），其余按目标时刻升序",
  );
}
console.log("schedule: 显示顺序 ✓");

// ---------- 6. 运行时间草稿：种子、比对与提交 ----------
{
  // 固定间隔种子按能被整除的最大单位给
  const every = scheduleDraft(item({ kind: "every", everySeconds: 3_600 }));
  assert.strictEqual(every.repeat, "every");
  assert.strictEqual(every.amount, "1");
  assert.strictEqual(every.unit, "hour");
  assert.strictEqual(scheduleDraft(item({ kind: "every", everySeconds: 90 })).unit, "second");

  // 一次性的种子按规则时区展开它已提交的那个时刻（`after` 也折成「一次」）
  const once = scheduleDraft(item({ kind: "at", scheduledAt: "2026-10-15T02:00:00.000Z", timeZone: undefined }));
  assert.strictEqual(once.repeat, "once");
  assert.strictEqual(once.timeZone, deviceZone(), "一次性记录不存时区 → 草稿用设备时区解释");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(once.date));
  assert.strictEqual(once.time.length, 12, "草稿保留毫秒（未改动的行原样提交回去）");

  // 墙上时钟规则保留自己存的时区与时间
  const weekly = scheduleDraft(item({ kind: "weekly", time: "09:00:00.000", timeZone: "UTC", weekdays: [1, 3] }));
  assert.strictEqual(weekly.timeZone, "UTC");
  assert.deepStrictEqual(weekly.weekdays, [1, 3]);
  assert.strictEqual(weekly.time, "09:00:00");
  assert.strictEqual(storedZoneOf(item({ kind: "weekly", timeZone: "UTC" })), "UTC");
  assert.strictEqual(storedZoneOf(item({ kind: "at", timeZone: undefined })), undefined);
  assert.strictEqual(scheduleRuleZone(item({ kind: "cron", timeZone: "UTC" })), "UTC");
  assert.strictEqual(scheduleRuleZone(item({ kind: "after", timeZone: undefined })), deviceZone());

  // 比对：等价的写法（09:00 与 09:00:00）不算改动
  assert.strictEqual(
    scheduleDraftDiffers({ ...weekly, time: "09:00" }, item({ kind: "weekly", time: "09:00:00.000", timeZone: "UTC", weekdays: [1, 3] })),
    false,
    "补齐秒的同义写法不算修改",
  );
  assert.strictEqual(
    scheduleDraftDiffers(weekly, item({ kind: "weekly", time: "09:00:00.000", timeZone: "UTC", weekdays: [1, 3] })),
    false,
  );
  assert.strictEqual(
    scheduleDraftDiffers({ ...weekly, weekdays: [1, 3, 5] }, item({ kind: "weekly", time: "09:00:00.000", timeZone: "UTC", weekdays: [1, 3] })),
    true,
  );
  assert.strictEqual(
    scheduleDraftDiffers(every, item({ kind: "daily", time: "09:00:00.000", timeZone: "UTC" })),
    true,
    "换了种类当然算改动（服务端允许换种类并重锚）",
  );
  assert.strictEqual(
    scheduleDraftDiffers(scheduleDraft(item()), item()),
    false,
    "刚种下的草稿与已存规则一致（不然一展开就亮「有未保存的修改」）",
  );

  // 提交：逐档的字段名要与服务端的 ScheduleTimingChange 一致
  assert.deepStrictEqual(
    scheduleChangeFromDraft({ ...weekly, time: "09:00", date: "", amount: "60", unit: "second", expression: "" }),
    { change: { kind: "weekly", weekly: { time: "09:00:00", time_zone: "UTC", weekdays: [1, 3] } } },
  );
  assert.deepStrictEqual(
    scheduleChangeFromDraft({ ...every, amount: "2", unit: "hour" }),
    { change: { kind: "every", every_seconds: 7_200 } },
  );
  assert.deepStrictEqual(
    scheduleChangeFromDraft({ ...once, date: "2099-01-01", time: "09:00", timeZone: "Asia/Shanghai" }),
    { change: { kind: "at", at: { date: "2099-01-01", time: "09:00:00", time_zone: "Asia/Shanghai" } } },
    "一次性提交本地日历 + 显式时区（LocalAtInput）",
  );
  assert.deepStrictEqual(
    scheduleChangeFromDraft({ ...weekly, repeat: "daily" as const, time: "07:30" }),
    { change: { kind: "daily", daily: { time: "07:30:00", time_zone: "UTC" } } },
    "换种类：daily 只带自己的字段",
  );
  // 下限与形态校验：本地拦得住的不必走一次往返
  assert.deepStrictEqual(
    scheduleChangeFromDraft({ ...every, amount: "30", unit: "second" }),
    { error: "frequency_too_high" },
    "固定间隔下限 60 秒（服务端 MIN_EVERY_INTERVAL_SECONDS）",
  );
  assert.deepStrictEqual(scheduleChangeFromDraft({ ...every, amount: "0" }), { error: "invalid_rule" });
  assert.deepStrictEqual(scheduleChangeFromDraft({ ...weekly, weekdays: [] }), { error: "invalid_rule" });
  assert.deepStrictEqual(scheduleChangeFromDraft({ ...weekly, time: "9:00" }), { error: "invalid_rule" });
  assert.deepStrictEqual(scheduleChangeFromDraft({ ...once, date: "2099/01/01" }), { error: "invalid_rule" });
  assert.deepStrictEqual(scheduleChangeFromDraft({ ...weekly, timeZone: "  " }), { error: "invalid_time_zone" });
  assert.deepStrictEqual(
    scheduleChangeFromDraft({ ...weekly, repeat: "cron" as const, expression: "0 9 * * 1-5" }),
    { change: { kind: "cron", cron: { expression: "0 9 * * 1-5", time_zone: "UTC" } } },
  );
}
console.log("schedule: 运行时间草稿与提交 ✓");

// ---------- 7. cron 方言：只认契约列出的形态 ----------
{
  for (const ok of ["* * * * *", "0 9 * * *", "*/15 9-17 * * 1-5", "0 0 1,15 * 0", "30 6-8/2 1-31 1,6,12 0-7"]) {
    assert.strictEqual(cronFieldError(ok), undefined, `合法表达式被拒：${ok}`);
  }
  assert.strictEqual(cronFieldError("60 * * * *"), "minute");
  assert.strictEqual(cronFieldError("* 24 * * *"), "hour");
  assert.strictEqual(cronFieldError("* * 0 * *"), "dayOfMonth");
  assert.strictEqual(cronFieldError("* * * 13 *"), "month");
  assert.strictEqual(cronFieldError("* * * * 8"), "dayOfWeek");
  // 明确不支持的写法（L / W / # / 英文名 / 宏 / 六段 / 单值带步长 / 逆序范围 / 零步长）
  for (const bad of ["0 9 L * *", "0 9 * * 1#2", "0 9 * * MON", "@daily", "0 0 1 1 * 0", "5/2 * * * *", "10-1 * * * *", "*/0 * * * *", ""]) {
    assert.notStrictEqual(cronFieldError(bad), undefined, `非法表达式被放行：${bad}`);
  }
  assert.strictEqual(cronFieldError("0 9 * * 1-5"), undefined, "范围 + 逗号列表是合法形态");
}
console.log("schedule: cron 方言校验 ✓");

// ---------- 8. 时区清单：系统时区在最前，存的别名不许丢 ----------
{
  const system = deviceZone();
  const choices = zoneChoices("Pacific/Kiritimati", system);
  assert.strictEqual(choices[0], system, "系统时区排最前（编辑面板的第一个选项就是「本机时区」）");
  assert.ok(choices.includes("UTC"), "UTC 一定在清单里");
  assert.ok(choices.includes("Pacific/Kiritimati"), "存下来的时区始终在清单里（否则一次编辑就把用户的时区改掉）");
  assert.ok(choices.filter((zone) => zone === "UTC").length === 1, "清单去重");
  assert.strictEqual(new Set(choices).size, choices.length);
}
console.log("schedule: 时区清单 ✓");

// ---------- 9. 绝对时间文本：跨年才带年份，墙上时钟按规则时区读 ----------
{
  const stamp = formatScheduleStamp("2026-10-15T02:00:00.000Z", "en", "UTC");
  assert.ok(/Oct 15, 02:00/.test(stamp), `英语的月日与时钟：${stamp}`);
  const nextYear = formatScheduleStamp("2099-01-01T02:00:00.000Z", "en", "UTC");
  assert.ok(/2099/.test(nextYear), `不属于当前年份的目标要带年份：${nextYear}`);
  assert.strictEqual(formatScheduleStamp("bogus", "en"), "bogus", "读不出的时刻原样返回");
}
console.log("schedule: 绝对时间文本 ✓");

// ---------- 10. 接线与样式：宿主回帧、界面只交 id、两段式删除、分区渲染 ----------
{
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

  const controller = read("src", "dsh", "controller.ts");
  assert.ok(
    /scheduleCatalog\(\)/.test(controller) && /scheduleEntriesFromCatalog\(value\)\.filter\(\(entry\) => entry\.item\.sessionId === scope\.sessionId\)/.test(controller),
    "宿主读全局目录后按当前会话过滤（left: 会显示跑完的 inactive 任务）",
  );
  assert.ok(
    /scope\.schedulesStatus = "unsupported"/.test(controller) && /endpointAbsent\(error\)/.test(controller),
    "端点不存在要单独判定（能力缺失 ≠ 这次没拿到）",
  );
  assert.ok(
    /frame\.event === SCHEDULE_CHANGED_EVENT/.test(controller),
    "收到 schedule/changed 广播要重读已读过的会话（掉线期间的广播没有重放）",
  );
  assert.ok(
    /scope\.schedulesWanted = true;\s*\n\s*void this\.loadSchedules\(scope, true\);/.test(controller),
    "会话域建起来就静默预取一次：抽屉入口的指示灯要在没打开过面板的会话上也亮得起来",
  );
  assert.ok(
    /else if \(!silent\) \{\s*\n\s*scope\.schedulesStatus = "error";/.test(controller),
    "后台刷新失败要保留上次结果（一次抖动不许把「已读到」改写成「读取失败」）",
  );
  assert.ok(
    /case "deleteSchedule"[\s\S]*?scheduleDelete\(item\.sessionId, message\.id\)/.test(controller),
    "删除请求要带原始会话绑定（界面只给 id）",
  );
  assert.ok(
    /case "updateSchedule"[\s\S]*?scope\?\.scheduleExpected\.get\(message\.id\)/.test(controller),
    "更新用读取时留下的原文当比较基准",
  );
  assert.ok(
    /schedules\/result/.test(controller) && /schedules\/history/.test(controller),
    "宿主每条路都要回帧——界面「正在保存 / 正在读取」只认它们收场",
  );

  const client = read("src", "dsh", "client.ts");
  for (const method of ["scheduleCatalog", "scheduleHistory", "scheduleUpdate", "scheduleDelete"]) {
    assert.ok(new RegExp(`\\n  ${method}\\(`).test(client), `客户端要封装 ${method}`);
  }
  assert.ok(
    /METHODS\.scheduleCatalog/.test(client) &&
      /METHODS\.scheduleHistory/.test(client) &&
      /METHODS\.scheduleUpdate/.test(client) &&
      /METHODS\.scheduleDelete/.test(client),
    "四个端点都要走 METHODS 的登记名（不写字面量）",
  );
  assert.ok(
    /request: \{ sessionId, id, limit, \.\.\.\(before !== undefined \? \{ before \} : \{\}\) \}/.test(client),
    "执行记录的 limit 必填、before 是排他游标（不给就不带这个字段）",
  );

  const ipc = read("src", "shared", "ipc.ts");
  for (const frame of ['"listSchedules"', '"scheduleHistory"', '"updateSchedule"', '"deleteSchedule"', '"schedules/history"', '"schedules/result"']) {
    assert.ok(ipc.includes(frame), `IPC 协议要登记 ${frame}`);
  }

  const schedules = read("src", "webview", "components", "Schedules.tsx");
  assert.ok(
    /post\(\{ type: "updateSchedule", id: item\.id, change: built\.change \}\)/.test(schedules),
    "界面只交任务 id 与新的运行时间（expected 由宿主拼）",
  );
  assert.ok(
    /next\.state !== "pending"\) return;[\s\S]{0,80}post\(\{ type: "deleteSchedule", id: item\.id \}\)/.test(schedules),
    "删除是两段式：只有第二下确认（pressKill 返回 pending）才真的发请求",
  );
  assert.ok(
    /entry\?\.code === "schedule_not_found"/.test(schedules) && /entry\?\.error !== undefined/.test(schedules),
    "「任务不存在」与「这次没拿到」要分开显示",
  );
  assert.ok(
    /scheduleDraftDiffers\(previous, item\) \? previous : scheduleDraft\(item\)/.test(schedules),
    "服务端刷新不许覆盖用户正在编辑的草稿（没有未保存修改时才换成新值）",
  );
  assert.ok(
    /editable=\{item\.editable !== false\}/.test(schedules) &&
      /const disabled = !active \|\| !editable \|\| saving;/.test(schedules),
    "读不出规则基准的行只读（不让用户改完再撞一次冲突）",
  );
  assert.ok(
    /seenDelivery[\s\S]{0,200}post\(\{ type: "scheduleHistory", id: item\.id \}\)/.test(schedules),
    "又投递过一次要重读最新一页（记录是按需读的，不跟着刷新就会少掉刚发生的那次）",
  );

  const panels = read("src", "webview", "components", "Panels.tsx");
  assert.ok(/<SchedulesSection/.test(panels), "后台任务抽屉里要渲染自动化任务分区");
  assert.ok(/status=\{schedulesStatus\}/.test(panels), "分区要拿到清单的读取状态（三态分开）");

  const app = read("src", "webview", "App.tsx");
  assert.ok(
    /schedules=\{state\.schedules\}[\s\S]{0,400}sessionId=\{state\.session\?\.id\}/.test(app),
    "App 要把清单、状态、执行记录与结算一并交给 JobsPanel",
  );

  const state = read("src", "webview", "state.ts");
  assert.ok(
    /case "schedules\/history":[\s\S]*?const replacing = action\.mode === "replace"/.test(state),
    "replace / append 由宿主的 mode 决定（同一时刻可能两次请求在飞）",
  );
  assert.ok(
    /case "schedules\/result":/.test(state) && /scheduleResult: \{ op: action\.op, id: action\.id, ok: action\.ok, code: action\.code \}/.test(state),
    "变更结算整对象替换（连着两次失败也要各推进一次）",
  );

  const css = read("src", "webview", "styles", "app.css");
  const block = (selector: string) => {
    const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
    assert.ok(match, `app.css 里找不到选择器 ${selector}`);
    return match[1];
  };
  assert.ok(
    /white-space:\s*nowrap/.test(block(".schedule-field > .schedule-field-label")),
    "字段标签不许折行（英文 Time zone 比中文长）",
  );
  assert.ok(/max-height:/.test(block(".schedule-record-prompt")), "记录里的指令限高内滚（长指令不许把面板撑长）");
  assert.ok(/overflow-wrap:\s*anywhere/.test(block(".schedule-record-prompt")), "长 token 也要能断行");
  assert.ok(/nowrap/.test(block(".schedule-btn")), "按钮文案不许折行");
}
console.log("schedule: 接线与样式 ✓");

// ---------- 11. 文案登记：条目齐全，且一律走词典 ----------
{
  const messages = readFileSync(join(process.cwd(), "src", "webview", "messages.ts"), "utf8");
  const keys = messages.match(/^\s{2}(schedule[A-Za-z0-9]+):/gm) ?? [];
  assert.ok(keys.length >= 60, `自动化任务的文案条目太少（${keys.length}）——是不是漏登记了`);
  // 关键条目必须在（少了任何一条，界面上就会出现原始 key 或英文兜底）
  for (const key of ["scheduleSection", "scheduleEmpty", "scheduleUnsupported", "scheduleSave", "scheduleDeleteConfirmAction", "scheduleRecordsMore"]) {
    assert.ok(keys.some((line) => line.trim().startsWith(`${key}:`)), `消息表缺 ${key}`);
  }
  // 组件里不许出现写死的中文文案（一律走 texts，见根 AGENTS 的中英双语约定）
  const schedules = readFileSync(join(process.cwd(), "src", "webview", "components", "Schedules.tsx"), "utf8");
  const hardcoded = schedules
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => /["'>][^"'<>]*[\u4e00-\u9fa5][^"'<>]*["'<]/.test(line));
  assert.deepStrictEqual(hardcoded, [], "组件里不许写死中文文案（一律走 texts）");
}
console.log("schedule: 文案登记 ✓");

console.log("\nschedule: all assertions passed");
