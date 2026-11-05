/**
 * 自动化任务（DSH `schedule`）的线格式读取 —— 纯函数，离线可断言。
 *
 * 抽出来的理由与 `jobView.ts` 相同：形状读错在界面上表现为「这个功能没有」，而不是
 * 报错。这里读三样东西：
 *
 * 1. **目录**（`schedule/catalog` 的 `ScheduleCatalogEntry[]`）→ 界面行 + 编辑基准；
 * 2. **执行记录**（`schedule/history` 的 `ScheduleDeliveryHistoryResult`）；
 * 3. **变更结果**（新代 `schedule/edit`，旧代 `schedule/update` / `schedule/delete`）。
 *
 * 两条纪律贯穿全文：
 *
 * - **认不出就不动手**：`undefined` 表示「这一帧不是我能用的形状」（丢了、不改现有
 *   状态），与「空表 / 空记录」严格分开——后者是服务端明确说「没有」。
 * - 新代用 `updatedAt` 比较并交换；旧代**编辑基准（`expected`）只投影持久化的规则字段**。目录条目比记录多三个成员
 *   （`sessionId` / `status` / `lastDelivery`），把它们原样回传给 `schedule/update`
 *   就是让服务端的比较基准多出三个它不认识的字段。官方的 `timingSnapshot()` 做的
 *   正是同一件事，这里逐字段照做。
 *
 * 新代（0.2.2-rc.1）的目录字段、变更结果、能力探针与外来请求体校验也落在这里：变更结果
 * 只有「能收窄成目录条目」才算成功（`{deleted:true}` 不属于创建 / 运行 / 编辑），能力只按
 * 目录形状与零形参只读的限制读取判代际。代际判据与来源边界见 `docs/design-schedules.md`。
 */
import type { ScheduleDeliveryView, ScheduleItemView, ScheduleTargetView } from "../shared/chat";
import type {
  ScheduleCatalogEntryWire,
  ScheduleDeleteResultWire,
  ScheduleDeliveryLimitsWire,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** `lastDelivery` 投递记录（含目标会话，用于新代 `new` 目标的落点显示）。 */
interface LastDeliveryWire {
  scheduledAt: string;
  deliveredAt: string;
  targetSessionId: string | undefined;
}

/** `lastDelivery` 的两个时间都在才算（缺一个就当作没有这次投递）。 */
function lastDeliveryFromWire(value: unknown): LastDeliveryWire | undefined {
  if (!isRecord(value)) return undefined;
  const scheduledAt = nonEmptyString(value.scheduledAt);
  const deliveredAt = nonEmptyString(value.deliveredAt);
  if (scheduledAt === undefined || deliveredAt === undefined) return undefined;
  return { scheduledAt, deliveredAt, targetSessionId: nonEmptyString(value.targetSessionId) };
}

/**
 * 新代投递目标（`ScheduleTarget`）→ 界面投影；认不出返回 `undefined`。
 *
 * `new` 目标的 `sessionId` 取**最近一次投递**的目标会话（官方 `taskSessionId` 口径）：
 * 这种目标每次投递都新建会话，没有一个被长期复用的落点。`new_once` 的 `sessionId` 是
 * 创建时预留的会话 id，第一次投递前就存在。
 */
export function scheduleTargetView(
  value: unknown,
  lastDeliverySessionId?: string,
): ScheduleTargetView | undefined {
  if (!isRecord(value)) return undefined;
  const kind = nonEmptyString(value.kind);
  const create = isRecord(value.create) ? value.create : undefined;
  const cwd = nonEmptyString(create?.cwd);
  const agentPreset = nonEmptyString(create?.agentPreset);
  const createFields = { ...(cwd === undefined ? {} : { cwd }), ...(agentPreset === undefined ? {} : { agentPreset }) };
  if (kind === "session") {
    const sessionId = nonEmptyString(value.sessionId);
    return sessionId === undefined ? undefined : { kind, sessionId };
  }
  if (kind === "new_once") {
    const sessionId = nonEmptyString(value.sessionId);
    return { kind, ...(sessionId === undefined ? {} : { sessionId }), ...createFields };
  }
  if (kind === "new") {
    return { kind, ...(lastDeliverySessionId === undefined ? {} : { sessionId: lastDeliverySessionId }), ...createFields };
  }
  return undefined;
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
    case "rrule": {
      const rrule = nonEmptyString(entry.rrule);
      return rrule === undefined ? undefined : { ...common, rrule };
    }
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
 *
 * 代际按**目录形状**判：新代的条目带 `target` / `involvedSessionIds`，旧代只有
 * `sessionId`。不拿「哪条端点还能用」去猜——那是一次有副作用的试错。
 */
export function scheduleEntriesFromCatalog(value: unknown): ScheduleEntryView[] {
  const list = Array.isArray(value) ? value : [];
  const entries: ScheduleEntryView[] = [];
  for (const raw of list) {
    const entry = raw as ScheduleCatalogEntryWire | null;
    if (entry === null || typeof entry !== "object") continue;
    const id = nonEmptyString(entry.id);
    // 新目录以 involvedSessionIds 为归属权威，不将 new 目标误当成本会话绑定。
    const modern = "involvedSessionIds" in entry || "target" in entry;
    const involved = Array.isArray(entry.involvedSessionIds) && entry.involvedSessionIds.every((id) => typeof id === "string" && id !== "")
      ? entry.involvedSessionIds as string[] : undefined;
    if (modern && involved === undefined) continue;
    const delivery = lastDeliveryFromWire(entry.lastDelivery);
    const target = modern ? scheduleTargetView(entry.target, delivery?.targetSessionId) : undefined;
    // 投递落点：新代按 target 折算（官方 taskSessionId），`new` 目标在首次投递前可以是空串；
    // 读不出 target 的新代条目退回相关会话的第一条，而不是丢掉整行。
    const sessionId = modern
      ? target?.sessionId ?? involved?.[0] ?? ""
      : nonEmptyString(entry.sessionId);
    const scheduledAt = nonEmptyString(entry.scheduledAt);
    const kind = nonEmptyString(entry.kind);
    // 身份三件套（id / 目标时刻 / 规则种类）缺一条就整条丢弃；旧代还要求原始会话绑定。
    if (id === undefined || scheduledAt === undefined || kind === undefined) continue;
    if (!modern && sessionId === undefined) continue;
    const expected = scheduleExpectedOf(entry);
    const item: ScheduleItemView = {
      id,
      sessionId: sessionId ?? "",
      ...(modern
        ? {
            api: "edit" as const,
            involvedSessionIds: involved,
            updatedAt: optionalString(entry.updatedAt),
            createdAt: optionalString(entry.createdAt),
            ...(target === undefined ? {} : { target }),
            ...(entry.executionActive === true ? { executionActive: true } : {}),
            ...(optionalString(entry.deliveryFloorEndsAt) === undefined
              ? {}
              : { deliveryFloorEndsAt: optionalString(entry.deliveryFloorEndsAt) }),
          }
        : {}),
      rrule: optionalString(entry.rrule),
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
      ...(delivery === undefined
        ? {}
        : { lastDelivery: { scheduledAt: delivery.scheduledAt, deliveredAt: delivery.deliveredAt } }),
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

/** 一次更新的结果：新代返回目录条目，旧代明确返回 `updated: true`。 */
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
  if (frame?.updated === true || (!code && scheduleEntriesFromCatalog([value]).some((entry) => entry.item.api === "edit"))) return { ok: true, code: undefined };
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

// ---------- 新代管理端点（create / run / edit）的结果 ----------

/** 一次新代变更的结果：成功带最新目录条目，失败带服务端稳定错误码。 */
export interface ScheduleMutationOutcome {
  ok: boolean;
  /** 服务端明确给出的稳定错误码（含 `schedule_execution_pending` / `schedule_not_found`）。 */
  code: string | undefined;
  /** 成功时服务端回的最新目录条目（create / run / edit 都直接回它）。 */
  entry: ScheduleItemView | undefined;
}

/**
 * `schedule/create` / `schedule/run` / `schedule/edit` 的一帧 → 结算。
 *
 * 三者的成功支都直接回目录条目，因此**只有能收窄成目录条目的一帧才算成功**：
 * `{deleted:true}` 是删除端点的形状，出现在这里说明拿错了帧，不能宽收；
 * 给了 `expectedId`（创建除外）时条目身份还必须与请求一致，否则那一条是别的任务。
 * 失败支都带 `code` 且不抛错——先看 `code`。
 *
 * `execution_pending` 是**正常的拒绝**（同一个任务的另一次执行还占着位置），不是故障：
 * 它照样带 `code` 回来，由界面用单独一句「正在执行」说明。
 */
export function scheduleMutationOutcome(
  value: unknown,
  expectedId?: string,
): ScheduleMutationOutcome {
  if (!isRecord(value)) return { ok: false, code: "internal_error", entry: undefined };
  const code = nonEmptyString(value.code);
  if (code !== undefined) return { ok: false, code, entry: undefined };
  if (value.deleted === true) return { ok: false, code: "internal_error", entry: undefined };
  const entry = scheduleEntriesFromCatalog([value])[0]?.item;
  if (entry === undefined) return { ok: false, code: "internal_error", entry: undefined };
  if (expectedId !== undefined && entry.id !== expectedId) {
    return { ok: false, code: "internal_error", entry: undefined };
  }
  return { ok: true, code: undefined, entry };
}

/**
 * `schedule/deliveryLimits` 的一帧 → 「每次新建会话的最小间隔（秒）」。
 *
 * 不在客户端补默认值：这个数只由服务端给（默认 60 仅约束 `target.kind === 'new'`），
 * 本扩展不新增同名扩展配置（`docs/dsh-compat.md` 的口径）。
 */
export function scheduleLimitsFromWire(value: unknown): number | undefined {
  const frame = value as ScheduleDeliveryLimitsWire | null | undefined;
  const seconds = frame?.newSessionIntervalSeconds;
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** 服务端代际：新代有创建 / 立即执行 / 暂停恢复 / 目标编辑，旧代只有查看、改时间与删除。 */
export type ScheduleCapability = "modern" | "legacy" | "unknown";

/**
 * 按目录形状判代际；**目录为空**时才看那次零形参只读探针的结论。
 *
 * 判据分三层，顺序不能反：
 * 1. 目录里有新代条目（带 `target` / `involvedSessionIds`）→ `modern`，无需探针；
 * 2. 目录里有旧代条目 → `legacy`（旧目录不会凭空长出 `target`）；
 * 3. 目录为空 → `deliveryLimits` 成功证明有这组端点（`modern`），只有**明确的
 *    `endpointAbsent`** 才算旧代（`legacy`）；传输失败等一律 `unknown`——把「这次没
 *    拿到」当成旧代，等于把一个新服务端永久锁进只读模式。
 */
export function scheduleCapabilityOf(
  entries: readonly ScheduleEntryView[],
  limitsProbe: "supported" | "absent" | "failed",
): ScheduleCapability {
  if (entries.some((entry) => entry.item.api === "edit")) return "modern";
  if (entries.length > 0) return "legacy";
  if (limitsProbe === "supported") return "modern";
  if (limitsProbe === "absent") return "legacy";
  return "unknown";
}

/**
 * 一次拒绝的稳定原因（界面据此选文案）；**认不出时返回 `undefined`**。
 *
 * 网关把业务错误放在 `code` 里（`DshApiError` 的 `code`），输入类的具体原因在
 * `details.code`（`schedule/input-invalid` → `invalid_rule` / `not_future` / …）。
 * 归档目标的 `schedule/target-archived` 折成 `target_archived`。其余（断线、超时、
 * HTTP 5xx）没有稳定原因，返回 `undefined`，界面说「没落定」而不是编一个原因。
 */
export function scheduleFailureCode(error: unknown): string | undefined {
  if (!isRecord(error) && typeof error !== "object") return undefined;
  const raw = error as { code?: unknown; details?: unknown } | null;
  const code = typeof raw?.code === "string" ? raw.code : undefined;
  if (code === undefined) return undefined;
  if (code === "schedule/input-invalid") {
    const detail = isRecord(raw?.details) ? raw.details.code : undefined;
    return typeof detail === "string" && detail !== "" ? detail : "invalid_rule";
  }
  if (code === "schedule/target-archived") return "target_archived";
  if (code.startsWith("gateway/")) return code;
  if (code.startsWith("schedule/")) return code.slice("schedule/".length).replaceAll("-", "_");
  return undefined;
}

// ---------- 外来到宿主的请求体校验（逐字段验形状，不信任界面） ----------

/** 一次创建 / 编辑请求的校验结果：合法时给出规范化后的线格式。 */
export type ScheduleRequestValidation =
  | { request: Record<string, unknown> }
  | { error: "invalid_prompt" | "invalid_rule" | "invalid_target" };

const TIMING_KINDS: ReadonlySet<string> = new Set(["after", "at", "every", "daily", "weekly", "cron", "rrule"]);

function timingFromWire(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const kind = nonEmptyString(value.kind);
  if (kind === undefined || !TIMING_KINDS.has(kind)) return undefined;
  switch (kind) {
    case "after": {
      const seconds = value.after_seconds;
      return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0
        ? { kind, after_seconds: seconds }
        : undefined;
    }
    case "at": {
      const at = value.at;
      if (typeof at === "string") return at.trim() === "" ? undefined : { kind, at: at.trim() };
      if (!isRecord(at)) return undefined;
      const date = nonEmptyString(at.date);
      const time = nonEmptyString(at.time);
      const zone = nonEmptyString(at.time_zone);
      return date === undefined || time === undefined || zone === undefined
        ? undefined
        : { kind, at: { date, time, time_zone: zone } };
    }
    case "every": {
      const seconds = value.every_seconds;
      // 服务端下限 60 秒；本地先拦，免得一次往返才知道「每 30 秒」不行
      return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 60
        ? { kind, every_seconds: seconds }
        : undefined;
    }
    case "daily":
    case "weekly": {
      if (!isRecord(value[kind])) return undefined;
      const inner = value[kind] as Record<string, unknown>;
      const time = nonEmptyString(inner.time);
      const zone = nonEmptyString(inner.time_zone);
      if (time === undefined || zone === undefined) return undefined;
      if (kind === "daily") return { kind, daily: { time, time_zone: zone } };
      const weekdays = inner.weekdays;
      if (!Array.isArray(weekdays) || weekdays.length === 0) return undefined;
      if (!weekdays.every((day) => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7)) return undefined;
      return { kind, weekly: { time, time_zone: zone, weekdays: [...new Set(weekdays as number[])].sort((a, b) => a - b) } };
    }
    case "cron": {
      if (!isRecord(value.cron)) return undefined;
      const inner = value.cron as Record<string, unknown>;
      const expression = nonEmptyString(inner.expression);
      const zone = nonEmptyString(inner.time_zone);
      return expression === undefined || zone === undefined
        ? undefined
        : { kind, cron: { expression: expression.trim(), time_zone: zone } };
    }
    case "rrule": {
      const rrule = value.rrule;
      return typeof rrule === "string" && rrule.trim() !== "" ? { kind, rrule: rrule.trim() } : undefined;
    }
    default:
      return undefined;
  }
}

function targetFromWire(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const kind = nonEmptyString(value.kind);
  if (kind === "session") {
    const sessionId = nonEmptyString(value.sessionId);
    return sessionId === undefined ? undefined : { kind, sessionId };
  }
  if (kind !== "new_once" && kind !== "new") return undefined;
  if (value.create === undefined) return { kind };
  if (!isRecord(value.create)) return undefined;
  const create: Record<string, unknown> = {};
  if (value.create.cwd !== undefined) {
    const cwd = nonEmptyString(value.create.cwd);
    if (cwd === undefined) return undefined;
    create.cwd = cwd;
  }
  if (value.create.agentPreset !== undefined) {
    const preset = nonEmptyString(value.create.agentPreset);
    if (preset === undefined) return undefined;
    create.agentPreset = preset;
  }
  return Object.keys(create).length === 0 ? { kind } : { kind, create };
}

/**
 * `createSchedule` 的请求体：`{title, prompt, timing, target?}`。
 *
 * 只做**界面能写错**的那几处校验；时区是否存在、目标是否在未来、规则是否过密由服务端
 * 的时钟与时区表裁决（本地拦一道只会挡住合法输入）。
 */
export function scheduleCreateRequestFromWire(value: unknown): ScheduleRequestValidation {
  if (!isRecord(value)) return { error: "invalid_rule" };
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (title === "" || title.length > 120 || prompt === "") return { error: "invalid_prompt" };
  const timing = timingFromWire(value.timing);
  if (timing === undefined) return { error: "invalid_rule" };
  if (value.target === undefined) return { request: { title, prompt, timing } };
  const target = targetFromWire(value.target);
  if (target === undefined) return { error: "invalid_target" };
  return { request: { title, prompt, timing, target } };
}

/**
 * `editSchedule` 的 `patch`：只接受契约里的五个成员，且**至少有一个**。
 *
 * 未知键直接拒绝而不是静默丢弃：界面与宿主对「这次改了什么」必须是同一份事实，
 * 悄悄吞掉一个键会让用户以为保存成功、实际什么都没改。
 */
export function schedulePatchFromWire(value: unknown): ScheduleRequestValidation {
  if (!isRecord(value)) return { error: "invalid_rule" };
  const allowed = ["title", "prompt", "timing", "target", "active"] as const;
  if (Object.keys(value).some((key) => !(allowed as readonly string[]).includes(key))) {
    return { error: "invalid_rule" };
  }
  const patch: Record<string, unknown> = {};
  if (value.title !== undefined) {
    const title = typeof value.title === "string" ? value.title.trim() : "";
    if (title === "" || title.length > 120) return { error: "invalid_prompt" };
    patch.title = title;
  }
  if (value.prompt !== undefined) {
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    if (prompt === "") return { error: "invalid_prompt" };
    patch.prompt = prompt;
  }
  if (value.timing !== undefined) {
    const timing = timingFromWire(value.timing);
    if (timing === undefined) return { error: "invalid_rule" };
    patch.timing = timing;
  }
  if (value.target !== undefined) {
    const target = targetFromWire(value.target);
    if (target === undefined) return { error: "invalid_target" };
    patch.target = target;
  }
  if (value.active !== undefined) {
    if (typeof value.active !== "boolean") return { error: "invalid_rule" };
    patch.active = value.active;
  }
  if (Object.keys(patch).length === 0) return { error: "invalid_rule" };
  return { request: patch };
}
