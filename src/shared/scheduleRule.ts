/**
 * 运行时间规则的**本地预校验**：直接消费官方 `@deepseek-ai/dsh-util-time` 的原文副本。
 *
 * 这里不重写语法：RRULE 的完整校验（DTSTART/TZID、UNTIL、FREQ、COUNT、BY* 组合、
 * BYSETPOS 与 10080 密度上限、DST 缺口）来自 [vendor 的 `rrule.ts`](../vendor/dsh-util-time/rrule.ts)
 * 原文，时区规范名与本地时刻解析来自同目录的 [`instant.ts`](../vendor/dsh-util-time/instant.ts)
 * 原文。本文件只做三件官方 `taskDraftIssue` 里也有的适配：
 *
 * 1. 把官方拒绝结果 `{reason}` 映射成界面用的三档（`syntax` / `time_zone` / `density`）；
 * 2. 一次性草稿按官方 `timingFromDraft` 的同一形态（`DTSTART;TZID=…` +
 *    `FREQ=DAILY;COUNT=1`）交给 `RRule.parse`，而不是另写一套日历判断；
 * 3. cron 表达式复用既有的官方字段解析摘录，时区复用 `canonicalizeTimeZone`。
 *
 * 服务端仍是权威：本地拦下的是官方 parser 判得准的规则，未来时刻、发生时刻枚举与
 * 「下一次触发不存在」留给服务端（官方 `taskDraftIssue` 同样把未来判据交给 Host）。
 */
import { canonicalizeTimeZone } from "../vendor/dsh-util-time/instant";
import { RRule } from "../vendor/dsh-util-time/rrule";

/** 规则拒绝档（与官方 `RecurrenceInputError` / `RecurrenceRejection` 同名）。 */
export type ScheduleRuleIssue = "syntax" | "time_zone" | "density";

/**
 * 时区是否被官方 `canonicalizeTimeZone` 接受（`UTC` 或 IANA Area/Location）。
 *
 * 与 `Cron.parse` / `RRule.parse` 用的是同一个函数，因此不另维护一份时区形态表。
 */
export function scheduleRuleZoneIssue(value: string): ScheduleRuleIssue | undefined {
  return canonicalizeTimeZone(value).kind === "rejected" ? "time_zone" : undefined;
}

/**
 * 一条 RRULE 文本会不会被官方 `RRule.parse` 拒绝。
 *
 * 使用 `rejectIneffectiveSetPositions: true`，与官方 `taskDraftIssue` 完全相同：一个 FREQ
 * 周期只有一个候选时，BYSETPOS 属于无效写法而不是可运行规则。
 */
export function rruleIssue(value: string): ScheduleRuleIssue | undefined {
  const parsed = RRule.parse(value, { rejectIneffectiveSetPositions: true });
  return parsed.kind === "rejected" ? parsed.reason : undefined;
}

/** 官方解析后的两行规范文本（`RRule.expression`）；不合法时 `undefined`。 */
export function normalizedRrule(value: string): string | undefined {
  const parsed = RRule.parse(value);
  return parsed.kind === "accepted" ? parsed.rule.expression : undefined;
}

/**
 * 提交 / 比较用的 RRULE 文本（官方 `timingFromDraft` 的取舍）。
 *
 * 解析成功时发官方归一化后的两行文本——只是行首尾空白与空行的归一化，不是表达式
 * 重写；解析失败时退回原文，让 dirty 比较仍看得出用户改了什么，保存由校验拒绝。
 */
export function submittedRrule(value: string): string {
  return normalizedRrule(value) ?? value;
}

/**
 * 一次性草稿（本地日期 + 时钟 + 显式时区）会不会被官方拒绝。
 *
 * 官方 `taskDraftIssue` 把一次性草稿转成 `DTSTART;TZID=…` + `FREQ=DAILY;COUNT=1` 再交给
 * `RRule.parse`。这里用同一形态、同一个 parser：TZID 必须是 UTC/IANA（`time_zone`），
 * 日期必须是真实日历值且年份在官方 RRULE 的 0100–9999 内，时刻必须在所选时区存在
 * （DST 缺口即 `syntax`；重叠取较早，由 parser 的 `resolveLocalInstant` 决定）。
 *
 * @param date - `YYYY-MM-DD`。
 * @param time - 已补齐到整秒的 `HH:mm:ss`。
 * @param timeZone - 草稿里选中的时区（原样写进 DTSTART 的 TZID）。
 */
export function localAtIssue(date: string, time: string, timeZone: string): ScheduleRuleIssue | undefined {
  if (scheduleRuleZoneIssue(timeZone) !== undefined) return "time_zone";
  const start = `${date.replaceAll("-", "")}T${time.replaceAll(":", "")}`;
  return rruleIssue(`DTSTART;TZID=${timeZone}:${start}\nRRULE:FREQ=DAILY;COUNT=1`);
}
