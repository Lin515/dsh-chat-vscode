/**
 * 【探针定位】工具型 · 零 token —— 观察轨迹差距清单里那些**形态类**项在真实数据里的
 *   发生率：默认读 `~/.dsh/sessions/**` 的会话日志（也可用 `--source` 指定受控的单份
 *   文件，见下方「来源选择」），量工具调用的**参数**与**结果**里的
 *   JSON 形状、载荷长度、结果信封与内容块分布。
 *
 * 为什么需要它：`JsonTree` 折叠树、`sourceBlocks` / `outputBlocks` 逐块视图这些形态类
 * 项，官方有、本扩展没有，但**值不值得做**取决于真实数据长什么样。判据是「会发生」
 * 而不是「官方有」：
 *   - 参数是一个**扁平**对象（`{"file_path": "…"}`）时，折叠树与一段 pretty JSON 的
 *     可读性没有差别，缺的是「不用滚」而已；
 *   - 参数里**带嵌套对象 / 数组**（`edits: [...]`、`options: {...}`）时，折叠才真的
 *     解决「一眼看不清结构、要滚很久」；
 *   - 结果是**多块**（文本 + 图片 + 其它）时，逐块视图才有东西可展示。
 *
 * 输出的是**观察**（各档计数与占比），不是断言：本探针不改红、不改绿，退出码恒 0。
 * 因此它**不推断本扩展的实现缺口**——`attempt` 首 token、`session/end-seed` 中断压缩
 * 这些都已经落地（见 `docs/design-trajectory.md` 的「请求与时序」），这里只报原始事实计数。
 *
 * **分子分母必须成对读**：`JSON 对象` / `JSON 数组` 的分母是「解析成功的正文」，
 * 而「候选但解析失败」不算 JSON 样本，单独一档。
 *
 * 用法：
 *   npm run build:scripts
 *   node build/trajectory-gap-probe.mjs --source <路径> [--source <路径> ...]   # 受控单文件来源
 *   node build/trajectory-gap-probe.mjs [--limit 60]                          # 默认扫描最近 60 份
 *
 * **来源选择**：给了 `--source` 就只读显式点名的文件，**完全不调用**默认的会话目录扫描
 * （`findLogs`）；调用方可以据此只用一份自己合成的日志复现统计。`--source` 可重复，
 * 但同一份文件（按绝对路径、Windows 折大小写）出现两次即参数错误——重复会让分母虚高。
 * `--limit` 与 `--source` 互斥（「最近 n 份」数的是哪一批没有定义）。
 *
 * **参数错误退出码 5**（`PROBE_EXIT.usage`）：未知选项 / 选项缺值 / 非法 `--limit` /
 * 重复来源 / 互斥组合 / 显式来源读不出来。诊断中英各一行，**不回显参数原文**
 * （它可能是路径或秘密）。本探针是观察型，其余情况退出码恒 0。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeSessionLog } from "./sessionLog";
import {
  PROBE_EXIT,
  addToolResult,
  bucketDepth,
  containerFieldsOf,
  looksJson,
  newToolResultStats,
  parseJsonContainer,
  parseProbeArgs,
} from "./trajectoryProbeFacts";
import type { ProbeArgErrorCode } from "./trajectoryProbeFacts";
import type { SessionWireEvent } from "../src/dsh/protocol";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");

/**
 * 参数诊断**中英各一行**（开发者工具的输出不进界面词典，但两种语言都要能独立读懂）。
 * **不回显参数原文**：参数可能是路径或秘密，只报语言中立的错误码与位置。
 */
type CliErrorCode = ProbeArgErrorCode | "source-unreadable";

const USAGE_ZH = "用法：node build/trajectory-gap-probe.mjs [--source <路径> ...] [--limit <正整数>]";
const USAGE_EN = "Usage: node build/trajectory-gap-probe.mjs [--source <path> ...] [--limit <positive integer>]";
const ARG_ERROR_ZH: Record<CliErrorCode, string> = {
  "unknown-option": "未知选项",
  "missing-value": "选项缺值",
  "invalid-limit": "--limit 只接受正整数",
  "duplicate-source": "同一份来源被指定了两次",
  "limit-with-source": "--limit 不能与 --source 同时使用",
  "source-unreadable": "显式 --source 读不出来（不存在或不是普通文件）",
};
const ARG_ERROR_EN: Record<CliErrorCode, string> = {
  "unknown-option": "unknown option",
  "missing-value": "option requires a value",
  "invalid-limit": "--limit must be a positive integer",
  "duplicate-source": "the same source was given twice",
  "limit-with-source": "--limit cannot be combined with --source",
  "source-unreadable": "an explicit --source could not be read (missing or not a regular file)",
};

/** 参数/来源错误：中英两行 + 两行用法，退出 5（一个来源都没读）。 */
function failUsage(code: CliErrorCode, at: string): never {
  console.error(`参数错误（${at}）：${ARG_ERROR_ZH[code]}`);
  console.error(`Invalid arguments (${at}): ${ARG_ERROR_EN[code]}`);
  console.error(USAGE_ZH);
  console.error(USAGE_EN);
  process.exit(PROBE_EXIT.usage);
}

const parsed = parseProbeArgs(process.argv.slice(2));
if (!parsed.ok) failUsage(parsed.error.code, `#${parsed.error.position}`);
const selection = parsed.args;
/** 受控来源模式：只读 `--source` 点名的文件，**不调用 `findLogs`**。 */
const controlled = selection.sources !== null;

interface Row {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, any>;
}

/**
 * 默认来源发现：扫 `~/.dsh/sessions/**` 取最近 `limit` 份。
 * **只在没有 `--source` 时被调用**（受控模式完全不进这里）。
 */
function findLogs(limit: number): string[] {
  const found: { file: string; mtime: number }[] = [];
  let wsNames: string[] = [];
  try {
    wsNames = readdirSync(SESSIONS_ROOT);
  } catch {
    return [];
  }
  for (const ws of wsNames) {
    let names: string[] = [];
    try {
      names = readdirSync(join(SESSIONS_ROOT, ws));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(SESSIONS_ROOT, ws, name);
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry)) continue;
        const file = join(dir, entry);
        found.push({ file, mtime: statSync(file).mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((entry) => entry.file);
}

/**
 * `data.stream[0].time`：**原始流首帧**的时刻。
 *
 * 与 `src/dsh/trajectory.ts` 的 `streamFirstTime()` 读同一个字段，但本探针**只把它当
 * 原始首帧时刻**报计数——它**不是**首 token 时刻，也不与官方 F03 的 `settleTiming()`
 * 等价（那套口径另有 packed token 的判据）。本探针不复制那份实现：同一个口径出现两个
 * 所有者，改一边另一边就会静默过期。
 */
function firstStreamFrameTime(data: Record<string, unknown>): number | undefined {
  const stream = data.stream;
  if (!Array.isArray(stream) || stream.length === 0) return undefined;
  const first = stream[0] as { time?: unknown } | undefined;
  return typeof first?.time === "number" ? first.time : undefined;
}

const ARG_LEN_EDGES: [number, string][] = [
  [8, "≤8"],
  [32, "9–32"],
  [128, "33–128"],
  [512, "129–512"],
  [Number.POSITIVE_INFINITY, ">512"],
];

/** 按阈值分档计数（先到先得，故 edges 必须升序）。 */
function bucket(counts: Map<string, number>, value: number, edges: [number, string][]): void {
  for (const [edge, label] of edges) {
    if (value <= edge) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
      return;
    }
  }
}

let scannedFiles = 0;
/** 显式来源（受控模式）里的解码失败 / 解码为空：必须报出来，否则「显式选了 3 份、
 *  实际一份都没进统计」会看起来像「扫过 0 份」的安静结果。 */
let decodeFailed = 0;
let decodedEmpty = 0;
let calls = 0;
let callsWithoutArgs = 0;
let callsWithArgs = 0;
/** 参数 JSON：候选 → 解析成功（对象 / 数组）/ 解析失败；失败不当 JSON 样本。 */
let argsNotJson = 0;
let argsJsonParsed = 0;
let argsJsonObject = 0;
let argsJsonArray = 0;
let argsJsonInvalid = 0;
let argsNested = 0;
let argsNestedAndLong = 0;
/** 请求选项：官方「选项」页签也是 JsonTree（`options.json`），本扩展是一段裸 JSON。 */
let requestsWithOptions = 0;
let optionsNested = 0;
/** 用户消息总数（steering 那一项的分母）。 */
let userMessages = 0;
/**
 * 原始流首帧时刻口径（`data.stream[0].time`）的分母与分子：
 * `stepsWithAttempt` = 带 `assistant/attempt` 的 step 数；
 * `stepsWithoutMessageFirstFrameTime` = 其中没有带该时刻的 `assistant/message` 的 step 数。
 * **不是首 token 时刻**（见 `firstStreamFrameTime`）。
 */
let stepsWithAttempt = 0;
let stepsWithoutMessageFirstFrameTime = 0;
/** 压缩事件与边界，只作原始计数。 */
let sessionsWithBoundary = 0;
let compactionStarts = 0;
let compactionEnds = 0;
let openCompactionsAtBoundary = 0;

const argLengths = new Map<string, number>();
const argDepths = new Map<string, number>();
const byTool = new Map<string, { calls: number; nested: number }>();
/** 参数里**最常见的顶层容器字段名**：折叠树最常被用在哪几个字段上。 */
const containerFieldNames = new Map<string, number>();
/** 服务端 `header.config` 的**顶层键**分布：本扩展只挑 7 个标量，其余一律丢掉。 */
const configKeys = new Map<string, number>();
const results = newToolResultStats();

/** 来源选择：受控模式只读 `--source` 点名的文件，**完全不调用 `findLogs`**。 */
const files = selection.sources ?? findLogs(selection.limit);

for (const [sourceIndex, file] of files.entries()) {
  let decoded: string | undefined;
  try {
    decoded = decodeSessionLog(file);
  } catch {
    // 显式点名却读不出来（不存在 / 是目录 / 权限…）：**不是**安静的跳过，
    // 而是参数/来源错误（退出 5）。默认扫描模式下照旧容错跳过。
    if (controlled) failUsage("source-unreadable", `--source #${sourceIndex + 1}`);
    decodeFailed += 1;
    continue;
  }
  if (!decoded) {
    decodedEmpty += 1;
    continue;
  }
  const events: SessionWireEvent[] = [];
  for (const line of decoded.split("\n")) {
    if (!line.trim()) continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      continue;
    }
    if (typeof row.type === "string" && typeof row.seq === "number") {
      events.push(row as unknown as SessionWireEvent);
    }
  }
  if (events.length === 0) continue;
  scannedFiles += 1;

  /**
   * 会话级的**原始事实**计数（见文件头：只报事实，不推断本扩展缺什么）：
   *
   * 1. **原始流首帧时刻**：`assistant/message` 与 `assistant/attempt` 的 `data.stream[0].time`。
   *    官方 `settleTiming()` 读同一个字段，但那套口径的首 token 事实由 packed token 判据
   *    给出；本探针**只**量「有多少 step 只有 attempt、没有带该时刻的助手消息」，
   *    报的是原始首帧计数，**不得**读成「首 token 时刻缺失」。
   * 2. 压缩与 `session/end-seed` 会话边界：量边界处还开着、没收到 `compaction/end`
   *    的压缩有多少条。
   */
  let sessionBoundarySeq: number | undefined;
  for (const event of events) {
    if (event.type === "session/end-seed" && sessionBoundarySeq === undefined) sessionBoundarySeq = event.seq;
    if (event.type === "user/message") userMessages += 1;
    if (event.type === "compaction/start") compactionStarts += 1;
    if (event.type === "compaction/end") compactionEnds += 1;
  }
  if (sessionBoundarySeq !== undefined) sessionsWithBoundary += 1;
  // 每个会话边界处仍在开启的压缩：数一遍「边界时没有对应 compaction/end 的 start」
  {
    let openSeq: number | undefined;
    for (const event of events) {
      if (event.type === "compaction/start") openSeq = event.seq;
      if (event.type === "compaction/end") openSeq = undefined;
      if (event.type === "session/end-seed" && openSeq !== undefined) {
        openCompactionsAtBoundary += 1;
        openSeq = undefined;
      }
    }
  }
  // 「这一步有 assistant/attempt，但没有带**原始流首帧时刻**的 assistant/message」的 step 数。
  // 口径声明：这一块读的是 `data.stream[0].time`（见 `firstStreamFrameTime`），
  // **不是**首 token 时刻——真实首 token 事实不在本探针的比较面内。
  {
    const stepsWithMessageFirstFrameTime = new Set<string>();
    const attemptSteps = new Set<string>();
    for (const event of events) {
      const stepKey = `${(event.data as { turn?: unknown })?.turn}:${(event.data as { step?: unknown })?.step}`;
      if (event.type === "assistant/message"
        && firstStreamFrameTime((event.data ?? {}) as Record<string, unknown>) !== undefined) {
        stepsWithMessageFirstFrameTime.add(stepKey);
      }
      if (event.type === "assistant/attempt") attemptSteps.add(stepKey);
    }
    for (const key of attemptSteps) {
      stepsWithAttempt += 1;
      if (!stepsWithMessageFirstFrameTime.has(key)) stepsWithoutMessageFirstFrameTime += 1;
    }
  }

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, any>;

    if (event.type === "tool/call") {
      calls += 1;
      const name = typeof data.name === "string" ? data.name : "?";
      const raw = typeof data.arguments === "string" ? data.arguments : "";
      const stat = byTool.get(name) ?? { calls: 0, nested: 0 };
      stat.calls += 1;
      if (raw === "") {
        callsWithoutArgs += 1;
        byTool.set(name, stat);
        continue;
      }
      callsWithArgs += 1;
      bucket(argLengths, raw.length, ARG_LEN_EDGES);
      // 参数口径与结果一致：先看前缀是不是 JSON 候选，再看能不能解析；失败不当 JSON 样本。
      if (!looksJson(raw)) {
        argsNotJson += 1;
        byTool.set(name, stat);
        continue;
      }
      const parsed = parseJsonContainer(raw);
      if (parsed === undefined) {
        argsJsonInvalid += 1;
        byTool.set(name, stat);
        continue;
      }
      argsJsonParsed += 1;
      if (parsed.kind === "object") argsJsonObject += 1;
      else argsJsonArray += 1;
      bucketDepth(argDepths, parsed.depth);
      if (parsed.containers > 0) {
        argsNested += 1;
        stat.nested += 1;
        if (raw.length > 512) argsNestedAndLong += 1;
        for (const [key, value] of Object.entries(parsed.value as Record<string, unknown>)) {
          if (value !== null && typeof value === "object") {
            containerFieldNames.set(key, (containerFieldNames.get(key) ?? 0) + 1);
          }
        }
      }
      byTool.set(name, stat);
      continue;
    }

    if (event.type === "request/header") {      // 官方的「选项」页签把整个 `header.config` 丢进 JsonTree（`options.json`），
      // 本扩展只挑出几个标量字段（`headerConfig()`），所以这一项要量**服务端原始 config**
      // 的形状——拿我们折出来的那份量不出折叠树有没有用（它本来就没有嵌套）。
      const config = (data.header as { config?: unknown } | undefined)?.config;
      if (config !== null && typeof config === "object") {
        requestsWithOptions += 1;
        if (containerFieldsOf(config) > 0) optionsNested += 1;
        for (const key of Object.keys(config as Record<string, unknown>)) {
          configKeys.set(key, (configKeys.get(key) ?? 0) + 1);
        }
      }
      continue;
    }

    if (event.type === "tool/result") {
      // 两种信封（现代 `role:'tool'` 一等消息 / 旧 `tool-result` 包装）统一抽取内层内容块；
      // 多块、图片、正文 JSON 三项都落在**抽取后**的块上，否则旧信封的外层单块会把
      // 内层的多块 / 图片整体掩盖掉。
      const message = data.message as { content?: unknown } | undefined;
      addToolResult(results, message?.content);
      continue;
    }
  }
}

const top = (map: Map<string, number>, count = 12) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);

// 来源与覆盖：受控模式把「显式选了几份 / 其中几份真的进了统计」摆出来，
// 否则「显式选了 3 份、一份都没解析成事件」看起来只是一个安静的「扫过 0 份」。
if (controlled) {
  console.log(`来源：受控 --source 模式，显式 ${files.length} 份文件（不扫描默认会话目录）`);
  console.log(`Source: controlled --source mode, ${files.length} explicit file(s); the default session directory is not scanned`);
  console.log(`  进入统计 ${scannedFiles} 份 / 解码失败 ${decodeFailed} 份 / 解码为空 ${decodedEmpty} 份 / 无可解析事件 ${files.length - scannedFiles - decodeFailed - decodedEmpty} 份\n`);
} else {
  console.log(`扫过 ${scannedFiles} 份会话日志（默认扫描模式，--limit ${selection.limit === Number.POSITIVE_INFINITY ? "未给" : selection.limit}）\n`);
}

console.log(`工具调用 ${calls} 次（无参数 ${callsWithoutArgs} / 带参数 ${callsWithArgs}）`);
console.log(`  参数不是 JSON 候选（trim 后不以 { 或 [ 开头） ${argsNotJson}`);
console.log(`  参数是 JSON 候选 ${argsJsonParsed + argsJsonInvalid}`);
console.log(`    解析成功         ${argsJsonParsed}  (${pct(argsJsonParsed, callsWithArgs)} of 带参数)`);
console.log(`      JSON 对象      ${argsJsonObject}`);
console.log(`      JSON 数组      ${argsJsonArray}`);
console.log(`    解析失败         ${argsJsonInvalid}  (不算 JSON 样本)`);
console.log(`  参数**带嵌套容器**  ${argsNested}  (${pct(argsNested, argsJsonParsed)} of 解析成功)`);
console.log(`    其中序列化 >512 字符 ${argsNestedAndLong}  (这些才真的「一眼看不清、要滚」)`);
console.log("  参数长度分布：");
for (const [label, value] of top(argLengths, 10)) console.log(`    ${label.padEnd(10)} ${value}`);
console.log("  参数嵌套深度分布（分母 = 解析成功）：");
for (const [label, value] of top(argDepths, 10)) console.log(`    ${label.padEnd(14)} ${value}`);

console.log(`\n工具结果 ${results.results} 条（以下各档分母都是它）`);
console.log(`  信封形态：现代 ${results.modern} / 旧信封 ${results.legacy} / 无内容字段 ${results.absent}`);
console.log(`  一个内容块都没有的结果  ${results.emptyContent}`);
console.log(`  抽取后多于一个块        ${results.multiblock}  (${pct(results.multiblock, results.results)})`);
console.log(`  含图片的结果            ${results.withImage}  (${pct(results.withImage, results.results)})`);
console.log(`  有内容块但没有 text 块  ${results.nonTextOnly}  (${pct(results.nonTextOnly, results.results)})`);
console.log(`  内容块 ${results.blocks.members} 个：不合法成员 ${results.blocks.invalid} / text ${results.blocks.text}`
  + ` / image ${results.blocks.image} / file ${results.blocks.file} / reasoning ${results.blocks.reasoning}`
  + ` / tool-call ${results.blocks.toolCall} / tool-result ${results.blocks.toolResult}`
  + ` / 未知种类 ${results.blocks.unknown}`);
console.log(`  正文是 JSON 候选        ${results.jsonCandidates}  (${pct(results.jsonCandidates, results.results)})`);
console.log(`    解析成功              ${results.jsonParsed}  (${pct(results.jsonParsed, results.results)})`);
console.log(`      JSON 对象           ${results.jsonObject}  (分母 = 解析成功)`);
console.log(`      JSON 数组           ${results.jsonArray}  (分母 = 解析成功)`);
console.log(`    解析失败              ${results.jsonInvalid}  (不算 JSON 样本)`);
console.log("  结果 JSON 深度分布（分母 = 解析成功）：");
for (const [label, value] of top(results.depths, 10)) console.log(`    ${label.padEnd(14)} ${value}`);

console.log("\n参数里最常见的**容器字段**（折叠树真正折叠的东西；分母 = 解析成功且带容器的参数）：");
for (const [key, value] of top(containerFieldNames, 12)) console.log(`  ${key.padEnd(24)} ${value}`);

console.log(`\n请求选项（服务端原始 \`header.config\`）`);
console.log(`  带 config 的 request/header   ${requestsWithOptions}`);
console.log(`  其中带嵌套容器                ${optionsNested}  (${pct(optionsNested, requestsWithOptions)})`);
console.log("  顶层键分布（本扩展只挑 provider / model / thinking / reasoningEffort /");
console.log("  temperature / maxTokens / stop 这 7 个标量，其余键在界面上看不到）：");
for (const [key, value] of top(configKeys, 20)) console.log(`    ${key.padEnd(26)} ${value}`);

console.log("\n输入侧原始事实（只报计数，不推断本扩展的实现状态）：");
console.log("  **原始流首帧时刻**口径：`data.stream[0].time`");
console.log("    （**不是**首 token 时刻；官方 F03 的 settleTiming 另有 packed token 判据，");
console.log("      本探针不复制那份实现，因此这里不给出任何首 token 结论）");
console.log(`    带 assistant/attempt 的 step ${stepsWithAttempt} 个（分母）`);
console.log(`    其中没有带该首帧时刻的 assistant/message 的 ${stepsWithoutMessageFirstFrameTime} 个`);
console.log(`  压缩事件：compaction/start ${compactionStarts} 条、compaction/end ${compactionEnds} 条`);
console.log(`    带会话边界（session/end-seed）的会话 ${sessionsWithBoundary} 份（分母 = 扫过的 ${scannedFiles} 份）`);
console.log(`    session/end-seed 边界处仍开启、未收尾的压缩 ${openCompactionsAtBoundary} 条`);
console.log(`  用户消息 ${userMessages} 条`);

console.log("\n按工具分：调用数 / 其中带嵌套容器");
for (const [name, stat] of [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 15)) {
  console.log(`  ${name.padEnd(24)} ${String(stat.calls).padStart(6)}  ${String(stat.nested).padStart(6)}`);
}
