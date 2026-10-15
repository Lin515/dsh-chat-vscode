/**
 * 自动化任务（DSH `schedule`）的显示与编辑口径 —— 纯函数，离线可断言。
 *
 * 这里放三件与界面无关、却必须与官方同语义的事：
 *
 * 1. **频率与相对时间的措辞**（文案由调用方按当前语言给，见 `ScheduleTexts`）；
 * 2. **运行时间编辑的草稿与提交**：记录 → 草稿（`scheduleDraft`）、草稿 → 线上
 *    `change`（`scheduleChangeFromDraft`）。服务端要求一次提交带上**完整**的新规则，
 *    而且每个种类收的字段名各不相同（`every_seconds` / `daily.time_zone` …），
 *    拼错就是一次静默被拒的保存；
 * 3. **墙钟与时区**：记录存的是 UTC 时刻或「本地时间 + IANA 时区」，编辑时要能双向
 *    转换（`zonedWallClock` / `zonedInstant`），并给出可选时区清单（`zoneChoices`）。
 *
 * 刻意**不做**的事：本扩展的列表行对 `cron` 显示规范表达式本身（官方的句子式描述
 * 在表达式的方言解析失败时也正是退回这个形态）。方言校验仍然做（`cronFieldError`），
 * 否则用户要等一次服务端往返才知道表达式写错了。
 */
import type { ScheduleItemView, ScheduleTimingChangeView } from "./chat";

const SECOND_MS = 1_000;

/** 时间单位，由大到小：显示相对时间与固定间隔时先看大的。 */
export type ScheduleUnit = "day" | "hour" | "minute" | "second";

/** 一个整数幅度加它的单位（措辞由界面按语言拼，见 `ScheduleTexts`）。 */
export interface ScheduleAmount {
  value: number;
  unit: ScheduleUnit;
}

const UNIT_SECONDS: readonly { unit: ScheduleUnit; seconds: number }[] = [
  { unit: "day", seconds: 86_400 },
  { unit: "hour", seconds: 3_600 },
  { unit: "minute", seconds: 60 },
  { unit: "second", seconds: 1 },
];

/**
 * 频率与相对时间要用的文案。
 *
 * 形参里的 `zone` 是**已经本地化好的时区标签**；空串表示「与系统时区相同、不写」
 * （官方口径：日/周/cron 的规则时区等于系统时区时那一行不名时区）。于是每种频率
 * 只有一条文案，不必为「带时区 / 不带时区」各登记一条。
 */
export interface ScheduleTexts {
  scheduleOnce: string;
  scheduleEvery: (value: number, unit: string) => string;
  /**
   * 单位词：**带幅度**，因为英文要分单复数（`in 1 hour` / `in 12 hours`）。
   * 中文不分，两个分支返回同一个词。
   */
  scheduleUnitSec: (value: number) => string;
  scheduleUnitMin: (value: number) => string;
  scheduleUnitHour: (value: number) => string;
  scheduleUnitDay: (value: number) => string;
  scheduleDaily: (time: string, zone: string) => string;
  scheduleWeekly: (weekdays: string, time: string, zone: string) => string;
  scheduleCron: (expression: string, zone: string) => string;
  scheduleWeekday1: string;
  scheduleWeekday2: string;
  scheduleWeekday3: string;
  scheduleWeekday4: string;
  scheduleWeekday5: string;
  scheduleWeekday6: string;
  scheduleWeekday7: string;
  /** 星期列表的连接符（中文用顿号、英文用逗号加空格）。 */
  scheduleWeekdayJoin: string;
  scheduleRelativeFuture: (value: number, unit: string) => string;
  scheduleRelativeOverdue: (value: number, unit: string) => string;
  scheduleRelativeNow: string;
}

/** 与系统时区比较、并本地化一个 IANA 时区所需的上下文。 */
export interface ScheduleZoneContext {
  /** 系统时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）。 */
  system?: string;
  /** 界面语言标识（`Intl` 的 locale，如 `zh-cn`）。 */
  locale?: string;
  /** 计算 UTC 偏移用的时刻（缺省取现在）。 */
  at?: number;
}

/** 单位 → 界面文案；`value` 只用于英文的单复数（中文不分）。 */
export function unitText(unit: ScheduleUnit, texts: ScheduleTexts, value: number): string {
  switch (unit) {
    case "day":
      return texts.scheduleUnitDay(value);
    case "hour":
      return texts.scheduleUnitHour(value);
    case "minute":
      return texts.scheduleUnitMin(value);
    case "second":
      return texts.scheduleUnitSec(value);
  }
}

/**
 * 固定间隔 → 最大可整除的整数幅度（官方 `formatScheduleFrequency` 的 `every` 分支）。
 *
 * 优先级是「天 → 小时 → 分钟 → 秒」，取第一个能整除的：`86400` 读作「1 天」，
 * `5400` 读作「90 分」（不是 1.5 小时），`90` 读作「90 秒」。
 */
export function everyAmount(everySeconds: number): ScheduleAmount {
  for (const candidate of UNIT_SECONDS) {
    if (everySeconds % candidate.seconds === 0) return { value: everySeconds / candidate.seconds, unit: candidate.unit };
  }
  return { value: everySeconds, unit: "second" };
}

/**
 * 相对时间 → 最大自然单位（官方 `formatScheduleRelative`）。
 *
 * 未来向下取整的幅度一律**向上取整**（还差 61 秒读作「2 分钟」），过去的一律向下
 * 取整；差值为 0 单独一档。绝对单位相同时幅度至少是 1——`0 秒前` 这种读法没有意义。
 */
export function relativeAmount(targetIso: string, now: number): ScheduleAmount | "now" | undefined {
  const at = Date.parse(targetIso);
  if (Number.isNaN(at)) return undefined;
  const difference = at - now;
  if (difference === 0) return "now";
  const absoluteSeconds = Math.abs(difference) / SECOND_MS;
  const selected = UNIT_SECONDS.find((candidate) => absoluteSeconds >= candidate.seconds) ?? UNIT_SECONDS[3];
  const value = Math.max(
    1,
    difference > 0
      ? Math.ceil(absoluteSeconds / selected.seconds)
      : Math.floor(absoluteSeconds / selected.seconds),
  );
  return { value, unit: selected.unit };
}

/**
 * 一条任务的频率文本。
 *
 * - `after` / `at` → 「一次性」；
 * - `every` → 「每 N 单位」；
 * - `daily` / `weekly` / `cron` → 墙上时钟规则；规则时区等于系统时区时不名时区，
 *   否则附上本地化后的时区标签（官方同款）。
 *
 * 认不出的种类、或该种类的关键字段缺失时返回 `undefined`：调用方据此不显示频率行，
 * 而不是编一句「一次性」——那会把一条读不懂的规则说成另一种规则。
 */
export function scheduleFrequency(
  item: ScheduleItemView,
  texts: ScheduleTexts,
  zone: ScheduleZoneContext = {},
): string | undefined {
  switch (item.kind) {
    case "after":
    case "at":
      return texts.scheduleOnce;
    case "every": {
      if (item.everySeconds === undefined) return undefined;
      const amount = everyAmount(item.everySeconds);
      return texts.scheduleEvery(amount.value, unitText(amount.unit, texts, amount.value));
    }
    case "daily": {
      if (item.time === undefined || item.timeZone === undefined) return undefined;
      return texts.scheduleDaily(clockLabel(item.time), zoneText(item.timeZone, zone));
    }
    case "weekly": {
      if (item.time === undefined || item.timeZone === undefined || item.weekdays === undefined) return undefined;
      return texts.scheduleWeekly(formatWeekdays(item.weekdays, texts), clockLabel(item.time), zoneText(item.timeZone, zone));
    }
    case "cron": {
      if (item.expression === undefined || item.timeZone === undefined) return undefined;
      return texts.scheduleCron(item.expression, zoneText(item.timeZone, zone));
    }
    default:
      return undefined;
  }
}

/**
 * 与系统时区相同则给空串（那一行不名时区），否则给本地化标签。
 *
 * 系统时区未知时**一律给标签**：不知道读者的时区就不能断言「和你一样」。
 */
export function zoneText(zone: string, context: ScheduleZoneContext): string {
  if (context.system !== undefined && context.system === zone) return "";
  return formatZoneLabel(zone, context.locale, context.at);
}

/** 星期集合 → 本地化的连接文本（1 = 周一；顺序原样保留）。 */
export function formatWeekdays(weekdays: readonly number[], texts: ScheduleTexts): string {
  const names = [
    texts.scheduleWeekday1,
    texts.scheduleWeekday2,
    texts.scheduleWeekday3,
    texts.scheduleWeekday4,
    texts.scheduleWeekday5,
    texts.scheduleWeekday6,
    texts.scheduleWeekday7,
  ];
  return weekdays.map((day) => names[day - 1] ?? String(day)).join(texts.scheduleWeekdayJoin);
}

/**
 * 存下来的本地时钟文本 → 给人看的形式（官方 `clockLabel`）。
 *
 * 去掉毫秒，再去掉正好为 `:00` 的秒：`23:00:00.000` 读作 `23:00`，
 * `09:30:15.500` 读作 `09:30:15`。**不改精度之外的任何东西**——存的是几分几秒就
 * 显示几分几秒，不替服务端四舍五入。
 */
export function clockLabel(time: string): string {
  return time.replace(/\.\d+$/, "").replace(/:00$/, "");
}

/** 时钟文本补齐到整秒（`HH:MM` → `HH:MM:SS`）；认不出就原样返回。 */
export function secondPrecision(time: string): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(time);
  if (match === null) return time;
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}

/** 日期文本转成界面上显示的斜杠形态（提交给服务端的仍是 ISO 形态）。 */
export function slashDate(date: string): string {
  return date.replaceAll("-", "/");
}

/** 本机时区；运行时报不出来时退回 `UTC`（不能把 `undefined` 当成一个 IANA 名）。 */
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** UTC 偏移（分钟）；时区不可用时 `undefined`。 */
function zoneOffset(zone: string, at: number): number | undefined {
  try {
    const value = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    if (value === "GMT") return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value ?? "");
    if (match === null) return undefined;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return undefined;
  }
}

/**
 * 一个 IANA 时区的标签：`UTC+08:00 · 中国标准时间`。
 *
 * 名字来自运行时的 ICU/CLDR（浏览器与 Node 都自带），不维护自己的时区译表；名字取不到
 * 时退回 IANA 标识本身。偏移在前是因为它才是可比较的那一半。
 */
export function formatZoneLabel(zone: string, locale: string | undefined, at = Date.now()): string {
  const minutes = zoneOffset(zone, at);
  const offset = minutes === undefined ? undefined : formatOffset(minutes);
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    if (offset === undefined) return name ?? zone;
    return name === undefined || /^GMT(?:[+-]|$)/.test(name) ? offset : `${offset} · ${name}`;
  } catch {
    return offset === undefined ? zone : `${offset} · ${zone}`;
  }
}

function formatOffset(minutes: number): string {
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const rest = String(absolute % 60).padStart(2, "0");
  return `UTC${minutes < 0 ? "-" : "+"}${hours}:${rest}`;
}

/**
 * 可选时区清单：**系统时区在最前**，其余按当前 UTC 偏移、再按 IANA 标识排序。
 *
 * 清单来自 `Intl.supportedValuesOf("timeZone")`（引擎自带的 ICU 数据）；运行时不支持
 * 枚举时只有系统时区、UTC 与规则自己存的那个（清单**永不为空**）。存下来的别名
 * （枚举里没有的老名字）始终追加进去，否则一次编辑就会把用户存的时区改掉。
 */
export function zoneChoices(stored: string | undefined, system: string, at = Date.now()): string[] {
  let inventory: string[] | undefined;
  try {
    inventory = Intl.supportedValuesOf("timeZone");
  } catch {
    inventory = undefined;
  }
  const zones = inventory === undefined ? ["UTC"] : ["UTC", ...inventory];
  const all = [...new Set([...zones, ...(stored ? [stored] : []), system])].filter((zone) => zone !== system);
  // 每个时区只读一次偏移：清单有好几百项，偏移放进比较器里就是 O(n log n) 次
  // `Intl.DateTimeFormat` 构造——那是编辑面板打开时会卡住主线程的量级。
  const ordered = all
    .map((zone) => ({ zone, offset: zoneOffset(zone, at) ?? Number.POSITIVE_INFINITY }))
    .sort((left, right) => (left.offset !== right.offset ? left.offset - right.offset : left.zone < right.zone ? -1 : 1))
    .map((entry) => entry.zone);
  return [system, ...ordered];
}

/**
 * 一个 UTC 时刻在某个时区里的墙上时钟，形如 `YYYY-MM-DDTHH:MM:SS.mmm`。
 *
 * 字段逐项按键取（不解析格式化后的字符串）：语言与字段顺序都不该影响这里。
 */
export function zonedWallClock(instant: string, zone: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return "";
  try {
    const fields = new Map(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map((part) => [part.type, part.value]),
    );
    const date = `${fields.get("year")}-${fields.get("month")}-${fields.get("day")}`;
    const clock = `${fields.get("hour")}:${fields.get("minute")}:${fields.get("second")}.${fields.get("fractionalSecond")}`;
    return `${date}T${clock}`;
  } catch {
    return "";
  }
}

/**
 * 一个目标的绝对时间文本：月日 + 时钟（跨年时才带年份）。
 *
 * 与官方 `formatScheduleNextRun` 同口径，也是投递记录的读法：
 * - 月份由语言的 ICU 数据给（`zh` 出「10月15日」，`en` 出 `Oct 15`），不是零填充数字；
 * - 墙上时钟规则（`daily` / `weekly` / `cron`）**按规则自己的时区**读——那一刻在
 *   那个时区就是规则说的那个钟点；一次性与固定间隔只存 UTC 时刻，用设备时区读；
 * - 年份只在它不属于当前年份时出现：一个几个月后的目标自带年份，当天的目标不啰嗦。
 */
export function formatScheduleStamp(iso: string, locale: string | undefined, timeZone?: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const zone = timeZone === undefined ? {} : { timeZone };
  try {
    const sameYear =
      new Intl.DateTimeFormat("en-US", { year: "numeric", ...zone }).format(at) ===
      new Intl.DateTimeFormat("en-US", { year: "numeric", ...zone }).format(Date.now());
    return new Intl.DateTimeFormat(locale, {
      ...(sameYear ? {} : { year: "numeric" as const }),
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...zone,
    }).format(at);
  } catch {
    return iso;
  }
}

/**
 * 任务自己那条规则的时区（只有墙上时钟规则有）；其余种类返回 `undefined`。
 *
 * 与 `scheduleRuleZone` 不是一回事：那个是**编辑草稿**回退到设备时区后的答案，
 * 这个是**显示**用的事实——一次性任务没有规则时区，显示就该用设备时区。
 */
export function storedZoneOf(item: ScheduleItemView): string | undefined {
  return item.kind === "daily" || item.kind === "weekly" || item.kind === "cron" ? item.timeZone : undefined;
}

/** 相对时间文本（未来 / 过去 / 正好到点）。 */export function relativeText(targetIso: string, now: number, texts: ScheduleTexts): string | undefined {
  const amount = relativeAmount(targetIso, now);
  if (amount === undefined) return undefined;
  if (amount === "now") return texts.scheduleRelativeNow;
  const unit = unitText(amount.unit, texts, amount.value);
  const at = Date.parse(targetIso);
  return texts[
    at > now ? "scheduleRelativeFuture" : "scheduleRelativeOverdue"
  ](amount.value, unit);
}

/**
 * 显示顺序：**过期的排最前**，其余按目标时刻升序；目标相同时保持服务端给的顺序。
 *
 * 与官方 `orderScheduleRecords` 同口径：过期的意味着「已经该发生但还没落定」，
 * 比任何未来的目标都更值得先看。
 */
export function orderSchedules(items: readonly ScheduleItemView[], now: number): ScheduleItemView[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftAt = Date.parse(left.item.scheduledAt);
      const rightAt = Date.parse(right.item.scheduledAt);
      const leftOverdue = leftAt <= now;
      const rightOverdue = rightAt <= now;
      if (leftOverdue !== rightOverdue) return Number(rightOverdue) - Number(leftOverdue);
      return leftAt - rightAt || left.index - right.index;
    })
    .map(({ item }) => item);
}

// ---------- 运行时间编辑 ----------

/** 运行时间卡片上的「重复」档（与官方 Repeat 菜单的常用档一一对应）。 */
export type ScheduleRepeat = "once" | "every" | "daily" | "weekly" | "cron";

/** 一次编辑会话里的原生输入值（全部是**字符串**：输入框里就是文本）。 */
export interface ScheduleTimingDraft {
  repeat: ScheduleRepeat;
  /** `once` 的日期，`YYYY-MM-DD`。 */
  date: string;
  /** `once` / `daily` / `weekly` 的时钟文本。 */
  time: string;
  /** 墙上时钟规则（`once` / `daily` / `weekly` / `cron`）用的时区。 */
  timeZone: string;
  /** `every` 的数量（整数文本）。 */
  amount: string;
  /** `every` 的单位。 */
  unit: "second" | "minute" | "hour";
  /** `weekly` 的 ISO 星期集合（1–7，升序）。 */
  weekdays: number[];
  /** `cron` 的五段表达式。 */
  expression: string;
}

const UNIT_SECONDS_OF: Record<ScheduleTimingDraft["unit"], number> = {
  second: 1,
  minute: 60,
  hour: 3_600,
};

/**
 * 记录的规则时区：只有墙上时钟规则存了它；一次性与固定间隔只存 UTC 时刻。
 *
 * 于是「编辑时用哪个时区解释这一次性时刻」只能由设备时区回答（官方 `draftZone`
 * 同口径）——那个时刻本身没有任何创建时的时区信息可依。
 */
export function scheduleRuleZone(item: ScheduleItemView): string {
  return item.kind === "daily" || item.kind === "weekly" || item.kind === "cron"
    ? (item.timeZone ?? deviceZone())
    : deviceZone();
}

/** 记录 → 编辑草稿（官方 `timingDraft` 同口径，含 `after` 折成一次性那一支）。 */
export function scheduleDraft(item: ScheduleItemView): ScheduleTimingDraft {
  const base: ScheduleTimingDraft = {
    repeat: "once",
    date: "",
    time: "",
    timeZone: deviceZone(),
    amount: "60",
    unit: "second",
    weekdays: [1],
    expression: "0 9 * * *",
  };
  switch (item.kind) {
    case "after":
    case "at": {
      const zone = scheduleRuleZone(item);
      const clock = zonedWallClock(item.scheduledAt, zone);
      return { ...base, date: clock.slice(0, 10), time: clock.slice(11), timeZone: zone };
    }
    case "every": {
      const seconds = item.everySeconds ?? 60;
      // 种子按「能被整除的最大单位」给：`3600` 读作 1 小时，而不是 3600 秒——用户改
      // 的是数量，单位错了会让「把它改成 2 小时」变成一次心算。
      const unit: ScheduleTimingDraft["unit"] =
        seconds % 3_600 === 0 ? "hour" : seconds % 60 === 0 ? "minute" : "second";
      return { ...base, repeat: "every", amount: String(seconds / UNIT_SECONDS_OF[unit]), unit };
    }
    case "daily":
      return {
        ...base,
        repeat: "daily",
        time: secondPrecision(item.time ?? "00:00:00"),
        timeZone: scheduleRuleZone(item),
      };
    case "weekly":
      return {
        ...base,
        repeat: "weekly",
        time: secondPrecision(item.time ?? "00:00:00"),
        timeZone: scheduleRuleZone(item),
        // 空集合在服务端不是合法规则；读不出星期时给周一，让用户自己改
        weekdays: item.weekdays?.length ? [...item.weekdays] : [1],
      };
    case "cron":
      return {
        ...base,
        repeat: "cron",
        expression: item.expression ?? "0 9 * * *",
        timeZone: scheduleRuleZone(item),
      };
    default:
      return base;
  }
}

/** 草稿 → 线上 `change`；**不合法时返回错误码**（与 `schedule/update` 的稳定错误码同名）。 */
export type ScheduleDraftResult =
  | { change: ScheduleTimingChangeView }
  | { error: "invalid_rule" | "frequency_too_high" | "invalid_time_zone"; field?: CronField };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?$/;

/**
 * 草稿 → 提交给 `schedule/update` 的 `change`。
 *
 * 校验只做**本地判得准**的那几条（字段形态、间隔下限、cron 方言、星期非空）：
 * 「目标必须晚于现在」「时区必须被运行时认识」这类要在服务端的时钟与时区表上才有
 * 定论，本地拦一道只会把合法的输入挡掉（服务端拒绝时界面照实显示它的错误码）。
 */
export function scheduleChangeFromDraft(draft: ScheduleTimingDraft): ScheduleDraftResult {
  if (draft.timeZone.trim() === "") return { error: "invalid_time_zone" };
  const zone = draft.timeZone.trim();
  switch (draft.repeat) {
    case "once": {
      if (!DATE_PATTERN.test(draft.date) || !TIME_PATTERN.test(draft.time)) return { error: "invalid_rule" };
      return {
        change: {
          kind: "at",
          at: { date: draft.date, time: secondPrecision(draft.time), time_zone: zone },
        },
      };
    }
    case "every": {
      const amount = Number(draft.amount);
      if (!Number.isSafeInteger(amount) || amount < 1) return { error: "invalid_rule" };
      const seconds = amount * UNIT_SECONDS_OF[draft.unit];
      // 服务端的下限是 60 秒（`MIN_EVERY_INTERVAL_SECONDS`）：本地先拦，「每 30 秒」
      // 这种输入不必走一次往返才知道不行
      if (!Number.isSafeInteger(seconds) || seconds < 60) return { error: "frequency_too_high" };
      return { change: { kind: "every", every_seconds: seconds } };
    }
    case "daily": {
      if (!TIME_PATTERN.test(draft.time)) return { error: "invalid_rule" };
      return { change: { kind: "daily", daily: { time: secondPrecision(draft.time), time_zone: zone } } };
    }
    case "weekly": {
      if (!TIME_PATTERN.test(draft.time)) return { error: "invalid_rule" };
      const weekdays = [...new Set(draft.weekdays)].filter((day) => Number.isInteger(day) && day >= 1 && day <= 7).sort((a, b) => a - b);
      if (weekdays.length === 0) return { error: "invalid_rule" };
      return {
        change: { kind: "weekly", weekly: { time: secondPrecision(draft.time), time_zone: zone, weekdays } },
      };
    }
    case "cron": {
      const field = cronFieldError(draft.expression);
      if (field !== undefined) return { error: "invalid_rule", field };
      return { change: { kind: "cron", cron: { expression: draft.expression.trim(), time_zone: zone } } };
    }
  }
}

/**
 * 草稿与已存规则是否有差异（决定要不要亮出「保存 / 取消」那一行）。
 *
 * 判据是**提交后的形态**与已存字段的比较：`once` 比的是日期与时钟（在规则时区里
 * 展开后的那两个值），其余种类逐字段比。拿「草稿文本」与「原始文本」比会把
 * `09:00` 与 `09:00:00` 这种等价写法误报成有修改。
 */
export function scheduleDraftDiffers(draft: ScheduleTimingDraft, item: ScheduleItemView): boolean {
  switch (draft.repeat) {
    case "once": {
      if (item.kind !== "at" && item.kind !== "after") return true;
      const zone = scheduleRuleZone(item);
      const clock = zonedWallClock(item.scheduledAt, zone);
      return draft.date !== clock.slice(0, 10) || secondPrecision(draft.time) !== clock.slice(11);
    }
    case "every": {
      if (item.kind !== "every") return true;
      const amount = Number(draft.amount);
      if (!Number.isSafeInteger(amount) || amount < 1) return true;
      return amount * UNIT_SECONDS_OF[draft.unit] !== (item.everySeconds ?? 0);
    }
    case "daily":
      if (item.kind !== "daily") return true;
      return secondPrecision(draft.time) !== secondPrecision(item.time ?? "") || draft.timeZone.trim() !== (item.timeZone ?? "");
    case "weekly": {
      if (item.kind !== "weekly") return true;
      const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
      const stored = [...(item.weekdays ?? [])].sort((a, b) => a - b);
      return (
        secondPrecision(draft.time) !== secondPrecision(item.time ?? "") ||
        draft.timeZone.trim() !== (item.timeZone ?? "") ||
        weekdays.join(",") !== stored.join(",")
      );
    }
    case "cron":
      if (item.kind !== "cron") return true;
      return draft.expression.trim() !== (item.expression ?? "") || draft.timeZone.trim() !== (item.timeZone ?? "");
  }
}

// ---------- cron 方言 ----------

/** 五段表达式的字段（报错时要指名哪一段坏了）。 */
export type CronField = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

const CRON_FIELDS: readonly { field: CronField; min: number; max: number }[] = [
  { field: "minute", min: 0, max: 59 },
  { field: "hour", min: 0, max: 23 },
  { field: "dayOfMonth", min: 1, max: 31 },
  { field: "month", min: 1, max: 12 },
  { field: "dayOfWeek", min: 0, max: 7 },
];

/** 一段里的一枚元素：`*`、星号带步长（``*``/n）、`a`、`a-b`、`a-b/n`（Vixie 方言的子集，逐字对照契约）。 */
function cronElementError(text: string, min: number, max: number): boolean {
  if (text === "*") return false;
  const starStep = /^\*\/(\d+)$/.exec(text);
  if (starStep !== null) return Number(starStep[1]) < 1;
  const match = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(text);
  if (match === null) return true;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  const step = match[3] === undefined ? undefined : Number(match[3]);
  if (start < min || start > max || end < min || end > max) return true;
  if (end < start) return true;
  // 单值带步长（`5/2`）不是这个方言的形态：只有范围与 `*` 能带步长
  if (step !== undefined && (step < 1 || match[2] === undefined)) return true;
  return false;
}

/**
 * cron 表达式的方言校验：**返回第一处坏掉的字段**，全部合法时返回 `undefined`。
 *
 * 只认契约列出的形态（`*` / 单值 / `a-b` / 星号带步长 / `a-b/n` / 逗号列表），
 * 明确拒绝 `L`、`W`、`#`、月份与星期的英文名、`@daily` 这类宏、六段表达式。
 * 服务端才是规范化的权威（它会把 `1,2,3` 收成 `1-3`），这里只负责「别把必然被拒的
 * 表达式发出去」。
 */
export function cronFieldError(expression: string): CronField | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => field === "")) return "minute";
  for (const [index, spec] of CRON_FIELDS.entries()) {
    const elements = fields[index].split(",");
    if (elements.some((element) => element === "" || cronElementError(element, spec.min, spec.max))) {
      return spec.field;
    }
  }
  return undefined;
}
