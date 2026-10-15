/**
 * 自动化任务（DSH `schedule`）的线格式读取 —— 纯函数，离线可断言。
 *
 * 抽出来的理由与 `jobView.ts` 相同：形状读错在界面上表现为「这个功能没有」，而不是
 * 报错。这里读三样东西：
 *
 * 1. **目录**（`schedule/catalog` 的 `ScheduleCatalogEntry[]`）→ 界面行 + 编辑基准；
 * 2. **执行记录**（`schedule/history` 的 `ScheduleDeliveryHistoryResult`）；
 * 3. **两个变更结果**（`schedule/update` / `schedule/delete`）。
 *
 * 两条纪律贯穿全文：
 *
 * - **认不出就不动手**：`undefined` 表示「这一帧不是我能用的形状」（丢了、不改现有
 *   状态），与「空表 / 空记录」严格分开——后者是服务端明确说「没有」。
 * - **编辑基准（`expected`）只投影持久化的规则字段**。目录条目比记录多三个成员
 *   （`sessionId` / `status` / `lastDelivery`），把它们原样回传给 `schedule/update`
 *   就是让服务端的比较基准多出三个它不认识的字段。官方的 `timingSnapshot()` 做的
 *   正是同一件事，这里逐字段照做。
 */
import type { ScheduleDeliveryView, ScheduleItemView } from "../shared/chat";
import type {
  ScheduleCatalogEntryWire,
  ScheduleDeleteResultWire,
  ScheduleHistoryResultWire,
  ScheduleUpdateResultWire,
} from "./protocol";

/** 目录里的一条：界面行 + 它的编辑基准。 */
export interface ScheduleEntryView {
  item: ScheduleItemView;
  /**
   * 回给 `schedule/update` 的 `expected`（完整规则，逐字段取自目录条目）。
   *
   * `undefined` = 这一条读不出完整规则（缺关键字段）：那时**不给编辑入口**，
   * 而不是拼一份残缺的基准去撞服务端的比较。
   */
  expected: Record<string, unknown> | undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `weekdays` 的收窄：**整表都要是 1–7 的整数**才认。
 *
 * 半张表（例如 `[1, "2"]`）不是「缺一天」而是「这一帧坏了」：拿它去显示会少一天，
 * 拿它去当编辑基准会与服务端存的规则不等——两件坏事都比「没有星期」更糟。
 */
function weekdaysFromWire(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days: number[] = [];
  for (const day of value) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7) return undefined;
    days.push(day);
  }
  return days.length ? days : undefined;
}

/** `lastDelivery` 的两个时间都在才算（缺一个就当作没有这次投递）。 */
function lastDeliveryFromWire(value: unknown): { scheduledAt: string; deliveredAt: string } | undefined {
  const raw = value as { scheduledAt?: unknown; deliveredAt?: unknown } | null | undefined;
  const scheduledAt = nonEmptyString(raw?.scheduledAt);
  const deliveredAt = nonEmptyString(raw?.deliveredAt);
  if (scheduledAt === undefined || deliveredAt === undefined) return undefined;
  return { scheduledAt, deliveredAt };
}

/**
 * 编辑基准：目录条目 → `ScheduleRecord`（只留持久化的规则字段）。
 *
 * 与官方 `timingSnapshot()` 逐条对齐：公共四字段 + 该种类自己的规则字段。
 * 任何一位读不出（种类不在词表里、或该种类的必填字段坏了）就返回 `undefined`。
 */
export function scheduleExpectedOf(entry: ScheduleCatalogEntryWire): Record<string, unknown> | undefined {
  const id = nonEmptyString(entry.id);
  const kind = nonEmptyString(entry.kind);
  const title = nonEmptyString(entry.title);
  const prompt = typeof entry.prompt === "string" ? entry.prompt : undefined;
  const scheduledAt = nonEmptyString(entry.scheduledAt);
  if (id === undefined || kind === undefined || title === undefined || prompt === undefined || scheduledAt === undefined) {
    return undefined;
  }
  const common = { id, kind, title, prompt, scheduledAt };
  switch (kind) {
    case "at":
      return common;
    case "after": {
      const afterSeconds = optionalNumber(entry.afterSeconds);
      return afterSeconds === undefined ? undefined : { ...common, afterSeconds };
    }
    case "every": {
      const everySeconds = optionalNumber(entry.everySeconds);
      return everySeconds === undefined ? undefined : { ...common, everySeconds };
    }
    case "daily": {
      const time = nonEmptyString(entry.time);
      const timeZone = nonEmptyString(entry.timeZone);
      return time === undefined || timeZone === undefined ? undefined : { ...common, time, timeZone };
    }
    case "weekly": {
      const time = nonEmptyString(entry.time);
      const timeZone = nonEmptyString(entry.timeZone);
      const weekdays = weekdaysFromWire(entry.weekdays);
      return time === undefined || timeZone === undefined || weekdays === undefined
        ? undefined
        : { ...common, time, timeZone, weekdays };
    }
    case "cron": {
      const expression = nonEmptyString(entry.expression);
      const timeZone = nonEmptyString(entry.timeZone);
      return expression === undefined || timeZone === undefined
        ? undefined
        : { ...common, expression, timeZone };
    }
    // 词表外的种类：读得出一部分也不当成可编辑的规则——基准必须与服务端存的完全
    // 一致，猜一份出来只会在保存时被拒（`schedule_conflict`）。
    default:
      return undefined;
  }
}

/**
 * 目录的一帧 → 界面行（**整条丢弃读不出身份的条目**，不编 id）。
 *
 * 顺序原样保留：服务端按 `scheduledAt` 升序、再按 id 字典序给（`catalog` 的契约），
 * 界面按「过期的在前、其余按目标时间」重排，两边不冲突。
 */
export function scheduleEntriesFromCatalog(value: unknown): ScheduleEntryView[] {
  const list = Array.isArray(value) ? value : [];
  const entries: ScheduleEntryView[] = [];
  for (const raw of list) {
    const entry = raw as ScheduleCatalogEntryWire | null;
    if (entry === null || typeof entry !== "object") continue;
    const id = nonEmptyString(entry.id);
    const sessionId = nonEmptyString(entry.sessionId);
    const scheduledAt = nonEmptyString(entry.scheduledAt);
    const kind = nonEmptyString(entry.kind);
    // 身份三件套（id / 归属会话 / 目标时刻）缺一条就整条丢弃：面板的行键、编辑与
    // 删除的定位、以及「下次运行」都靠它们，少一个都拼不出一个诚实的行。
    if (id === undefined || sessionId === undefined || scheduledAt === undefined || kind === undefined) continue;
    const expected = scheduleExpectedOf(entry);
    const item: ScheduleItemView = {
      id,
      sessionId,
      title: nonEmptyString(entry.title) ?? id,
      prompt: typeof entry.prompt === "string" ? entry.prompt : "",
      kind,
      status: nonEmptyString(entry.status) ?? "unknown",
      scheduledAt,
      afterSeconds: optionalNumber(entry.afterSeconds),
      everySeconds: optionalNumber(entry.everySeconds),
      time: optionalString(entry.time),
      timeZone: optionalString(entry.timeZone),
      weekdays: weekdaysFromWire(entry.weekdays),
      expression: optionalString(entry.expression),
      lastDelivery: lastDeliveryFromWire(entry.lastDelivery),
      // 基准拼不出来就没有可编辑的余地：这一位让界面一开始就把规则区做成只读，
      // 而不是等用户改完再撞一次 `schedule_conflict`。
      editable: expected !== undefined,
    };
    entries.push({ item, expected });
  }
  return entries;
}

/** 一页执行记录（已收窄）。`code` 存在即服务端明确说「这次读不到」（不是空记录）。 */
export interface ScheduleHistoryView {
  records: ScheduleDeliveryView[];
  nextBefore: string | undefined;
  earlierRecordsUnavailable: boolean;
  earlierRecordsPruned: boolean;
  retention: { days: number; records: number } | undefined;
  /** `schedule_not_found` / `delivery_cursor_not_found`；成功时没有。 */
  code: string | undefined;
}

/**
 * `schedule/history` 的一帧 → 规范形状；**认不出返回 `undefined`**。
 *
 * 失败那一支必须带 `code` 出去：界面「任务不存在」与「游标失效」的文字不同，
 * 而两者都可能带一张空 `records`——把它们折成同一种空态就是替服务端的回答做假设。
 */
export function scheduleHistoryFromWire(value: unknown): ScheduleHistoryView | undefined {
  const frame = value as ScheduleHistoryResultWire | null | undefined;
  if (frame === null || typeof frame !== "object") return undefined;
  const code = nonEmptyString(frame.code);
  const records: ScheduleDeliveryView[] = [];
  if (Array.isArray(frame.records)) {
    for (const raw of frame.records) {
      const record = raw as { scheduledAt?: unknown; deliveredAt?: unknown; prompt?: unknown } | null;
      const scheduledAt = nonEmptyString(record?.scheduledAt);
      const deliveredAt = nonEmptyString(record?.deliveredAt);
      if (scheduledAt === undefined || deliveredAt === undefined) continue;
      records.push({
        scheduledAt,
        deliveredAt,
        prompt: typeof record?.prompt === "string" ? record.prompt : undefined,
      });
    }
  } else if (code === undefined) {
    // 既没有 `code` 又没有 `records` 数组：这不是契约里的任何一支，整帧丢掉。
    return undefined;
  }
  const retentionRaw = frame.retention as { days?: unknown; records?: unknown } | null | undefined;
  const days = optionalNumber(retentionRaw?.days);
  const cap = optionalNumber(retentionRaw?.records);
  return {
    records,
    nextBefore: nonEmptyString(frame.nextBefore),
    earlierRecordsUnavailable: frame.earlierRecordsUnavailable === true,
    earlierRecordsPruned: frame.earlierRecordsPruned === true,
    retention: days === undefined || cap === undefined ? undefined : { days, records: cap },
    code,
  };
}

/** 一次更新的结果：`ok` = 服务端**确实改成了**（`updated: true`）。 */
export interface ScheduleUpdateOutcome {
  ok: boolean;
  /** 未改成的稳定错误码（`schedule_conflict` / `schedule_ended` / …）。 */
  code: string | undefined;
}

/**
 * `schedule/update` 的一帧 → 结算。
 *
 * `updated: true` 才叫成功；`updated: false` 一律带 `code` 回来（冲突 / 已结束 /
 * 不存在），工具错误那一支只有 `code` 没有 `updated`——**两种都算没改成**。
 */
export function scheduleUpdateOutcome(value: unknown): ScheduleUpdateOutcome {
  const frame = value as ScheduleUpdateResultWire | null | undefined;
  const code = nonEmptyString(frame?.code);
  if (frame?.updated === true) return { ok: true, code: undefined };
  return { ok: false, code: code ?? "internal_error" };
}

/** 一次删除的结果：`ok` = 服务端确实删掉了。 */
export interface ScheduleDeleteOutcome {
  ok: boolean;
  code: string | undefined;
}

/** `schedule/delete` 的一帧 → 结算；`schedule_not_found` 与其它失败分开报出。 */
export function scheduleDeleteOutcome(value: unknown): ScheduleDeleteOutcome {
  const frame = value as ScheduleDeleteResultWire | null | undefined;
  const code = nonEmptyString(frame?.code);
  if (frame?.deleted === true) return { ok: true, code: undefined };
  return { ok: false, code: code ?? "internal_error" };
}
