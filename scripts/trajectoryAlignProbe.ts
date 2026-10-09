/**
 * 【探针定位】工具型 · 零 token —— 读会话日志（默认 `~/.dsh/sessions/**`，也可用
 *   `--source` 指定受控的单份文件，见下方「来源选择」；不连服务不发消息，可自由运行），
 *   把本扩展的轨迹账本与官方 `dsh-client-ui-trajectory` 的**展示口径**对拍。
 *
 * 为什么需要它：轨迹的折叠与展示是我们对官方的一次**手工搬运**，官方那边
 * 「一行显示什么」由 `TrajectoryTable.tsx` 的 `recordDisplayText()` /
 * `isToolCallOnly()` / `RecordPresentation.listDisplayText` 三条纯函数决定，
 * 本扩展曾经把它们内联进组件并自造了一条官方没有的规则（「已结算且没正文 →
 * 仅工具调用」），于是**只要有思考没有正文的助手行**全被写成「仅工具调用」。
 * 合成夹具发现不了这种偏差——只有真实日志的分布能给出量级。
 *
 * 对拍方式：对每条 `assistant/message` durable 事件，一边按官方 layout +
 * 展示函数算出官方那一行会显示什么，一边用本扩展真正的折叠
 * （`deriveTrajectoryModel`）与真正的展示函数（`trajectoryCellContent`）算一遍，
 * 逐条比分类。官方口径在本文件里按源码逐条注释，改官方时要同步。
 *
 * **计量口径（expected / compared / missing / mismatched 必须分开）**：
 * - `expected`：本探针**应当**比较的样本数（`assistant/message` 事件 + steering 用户消息）；
 * - `compared`：真的比过的样本数；
 * - `missing`：应当比较、但因为「来源无法折出」等原因没比成的样本数——**每一条都带原因**；
 * - `mismatched`：比过且不一致的条数（含账本分组这类结构不变量）；
 * - `gaps`：会话级输入缺口（**完全读不到**的会话：解码失败 / 解码为空），与「真匹配」分开计，
 *   并让判定落在 `coverage` 上——读不到的会话里可能正藏着助手消息，不能替它宣称一致。
 *   读得到但没有可比内容的会话（无事件行 / 无助手消息 / 有半截行）只作**观察**报告，不参与判定。
 *
 * **找不到账本行时不允许 `continue` 后宣称「错配 0」**：那会把「没比」冒充成「比对了且一致」。
 * 本探针因此有六个互不相同的退出码（见 `scripts/trajectoryProbeFacts.ts` 的 `PROBE_EXIT`）：
 *
 * | 退出码 | 含义 |
 * |---|---|
 * | 0 | 已比较 > 0、无缺失、无错配、无覆盖缺口 |
 * | 1 | 有错配 |
 * | 2 | 有缺失（应当比较却没能比） |
 * | 3 | 零样本：一条都没比，**不能算通过** |
 * | 4 | 输入覆盖不完整：有会话**完全读不到**，不得宣告全量一致 |
 * | 5 | 参数错误：未知选项 / 选项缺值 / 非法 `--limit` / 重复来源 / 与 `--source` 互斥 / 显式来源不可读，**一个来源都没读** |
 *
 * 用法：
 *   npm run build:scripts
 *   node build/trajectory-align-probe.mjs --source <路径> [--source <路径> ...]  # 受控单文件来源
 *   node build/trajectory-align-probe.mjs              # 全部会话（默认扫描）
 *   node build/trajectory-align-probe.mjs --limit 60   # 只扫最近 60 份
 *   node build/trajectory-align-probe.mjs --verbose    # 打印错配样本
 *
 * **来源选择**：给了 `--source` 就只读显式点名的文件，**完全不调用**默认的会话目录扫描
 * （`findLogs`）——调用方据此只用自己合成的日志复现整套对拍。`--source` 可重复，但同一份
 * 文件（按绝对路径、Windows 折大小写）出现两次即参数错误：重复会让 expected/compared
 * 虚高，而「算了两遍」在汇总输出里看不出来。`--limit` 与 `--source` 互斥。
 * 参数诊断中英各一行，**不回显参数原文**（可能是路径或秘密）。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeSessionLog } from "./sessionLog";
import { PROBE_EXIT, ComparisonTally, parseProbeArgs, verdictText } from "./trajectoryProbeFacts";
import type { ProbeArgErrorCode } from "./trajectoryProbeFacts";
import { deriveTrajectoryModel } from "../src/dsh/trajectory";
import { trajectoryTurnCells } from "../src/shared/trajectory";
import type { TrajectoryCell } from "../src/shared/trajectory";
import { applySplice } from "../src/vendor/ui-trajectory/inbox-state";
import type { InboxState } from "../src/vendor/ui-trajectory/inbox-state";
import { trajectoryCellContent } from "../src/webview/trajectoryDisplay";
import { trajectoryTexts } from "../src/webview/trajectoryTexts";
import type { SessionWireEvent } from "../src/dsh/protocol";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");

/**
 * 参数诊断**中英各一行**（开发者工具的输出不进界面词典，但两种语言都要能独立读懂）。
 * **不回显参数原文**：参数可能是路径或秘密，只报语言中立的错误码与位置。
 */
type CliErrorCode = ProbeArgErrorCode | "source-unreadable";

const USAGE_ZH = "用法：node build/trajectory-align-probe.mjs [--source <路径> ...] [--limit <正整数>] [--verbose]";
const USAGE_EN = "Usage: node build/trajectory-align-probe.mjs [--source <path> ...] [--limit <positive integer>] [--verbose]";
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

const parsed = parseProbeArgs(process.argv.slice(2), { allowVerbose: true });
if (!parsed.ok) failUsage(parsed.error.code, `#${parsed.error.position}`);
const selection = parsed.args;
const verbose = selection.verbose;
/** 受控来源模式：只读 `--source` 点名的文件，**不调用 `findLogs`**。 */
const controlled = selection.sources !== null;
const texts = trajectoryTexts("zh-cn");

/** 官方两个 key：layout 那个进账本行文本，record 那个是列表里的**样式化**标签。 */
const LAYOUT_TOOL_CALL_ONLY = "仅工具调用";
const RECORD_TOOL_CALL_ONLY = "（仅工具调用）";

/** 缺失原因（稳定字符串，离线回归按它断言）。 */
const MISS_NO_LEDGER_CELL = "账本没有该 seq 的助手记录（来源无法折出）";
const MISS_DUPLICATE_SEQ = "同一 seq 的助手事件多于账本记录（无法逐一配对）";
const MISS_NO_LEDGER_USER = "账本没有该 seq 的用户消息记录（来源无法折出）";

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

/** 官方 `trajectoryPreviewText` 的近似：本探针只比分类，不逐字比截断。 */
function previewOf(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>_~\[\]()]/g, " ").replace(/\s+/g, " ").trim();
}

interface OfficialShape {
  messageText: string;
  thinkingText: string;
  toolCalls: number;
  images: number;
  /** 官方 layout 给 message cell 的 `text`。 */
  text: string;
  /** 官方 `isToolCallOnly()`：只有「没正文、没思考、有工具调用」才成立。 */
  toolCallOnly: boolean;
  /** 官方列表里那一行最终显示什么。 */
  listText: string;
}

/** 官方 `expandAssistant()` + `summarizeAssistantActivity()` + `recordDisplayText()`。 */
function officialMessageShape(blocks: unknown): OfficialShape {
  const list = Array.isArray(blocks) ? (blocks as { type?: unknown; text?: unknown }[]) : [];
  const textBlocks = list.filter((block) => block?.type === "text");
  const thinkingBlocks = list.filter((block) => block?.type === "reasoning");
  const messageText = textBlocks.map((block) => (typeof block.text === "string" ? block.text : "")).join("\n\n");
  const thinkingText = thinkingBlocks.map((block) => (typeof block.text === "string" ? block.text : "")).join("\n\n");
  const toolCalls = list.filter((block) => block?.type === "tool-call").length;
  const images = list.filter((block) => block?.type === "image").length;
  // layout：有正文或思考时 text 留空（正文走 previewMarkdown），否则才给「仅工具调用」等摘要
  const text =
    messageText !== "" || thinkingText !== ""
      ? ""
      : toolCalls > 0
        ? LAYOUT_TOOL_CALL_ONLY
        : images > 0
          ? `图片 ×${images}`
          : "";
  const toolCallOnly = messageText === "" && thinkingText === "" && toolCalls > 0;
  const preview = previewOf(messageText !== "" ? messageText : thinkingText);
  const listText = toolCallOnly ? RECORD_TOOL_CALL_ONLY : preview !== "" ? preview : text !== "" ? text : "—";
  return { messageText, thinkingText, toolCalls, images, text, toolCallOnly, listText };
}

interface Mismatch {
  file: string;
  seq: number;
  kind:
    | "误判为仅工具调用"
    | "该仅工具调用却不然"
    | "标签少了括号"
    | "有正文却显示空"
    | "steering 分类不符"
    | "分组位次被打乱"
    | "分组与步骤号不符"
    | "压缩没自成一组";
  ours: string;
  official: string;
  blocks: string;
}

const tally = new ComparisonTally();
/**
 * 覆盖面自述：**比较过什么**、**明确不比较什么**。后者不给原因就等于把没比过的
 * 字段当成已经验过——`字段未比较必须显示未比较原因`。
 */
tally.declareCompared("assistant/message → 账本助手行的分类标签", "只比「是否仅工具调用」「是否该有正文却显示空」两档");
tally.declareCompared("user/message(source.kind='user') → 账本用户行的 steering 标记", "官方 inbox 状态机逐条复算 vs 折叠层 steering");
tally.declareCompared("账本分组不变量", "组内位次严格递增 / 每条恰好一组 / step>0 落在同号步骤组 / 压缩自成一组");
tally.declareUncompared("行文本逐字（官方 listText 全文 vs 本扩展行文本）", "本探针只比分类，不逐字比预览截断与标点");
tally.declareUncompared("预览截断点 / 省略号", "本探针只比较分类，不逐字对拍 Markdown 投影的固定截断和界面的视觉省略");
tally.declareUncompared("请求面板字段（选项 / 用量 / 计时）", "不在本探针的比较面内，由离线回归与请求事实矩阵覆盖");

let discoveredFiles = 0;
let decodeFailed = 0;
let decodedEmpty = 0;
let noParsedEvents = 0;
let noAssistantMessage = 0;
let unparsableSessions = 0;
let scannedFiles = 0;
let scannedMessages = 0;
let officialToolOnly = 0;
let oursToolOnly = 0;
/** steering 对拍：真实日志里的人发消息数，与两边认定的 steering 数。 */
let humanMessages = 0;
let referenceSteering = 0;
/** 分组不变量：扫过的记录数与不成组的次数。 */
let groupedCells = 0;
/** 含 0 号轮（`turn/start {turn: 0}`）的日志数——prologue 那条分支只被它触发。 */
let turnZeroFiles = 0;
const blockCombos = new Map<string, number>();
const mismatches: Mismatch[] = [];

/** 来源选择：受控模式只读 `--source` 点名的文件，**完全不调用 `findLogs`**。 */
const files = selection.sources ?? findLogs(selection.limit);

for (const [sourceIndex, file] of files.entries()) {
  discoveredFiles += 1;
  let decoded: string | undefined;
  try {
    decoded = decodeSessionLog(file);
  } catch {
    // 显式点名却读不出来（不存在 / 是目录 / 权限…）：这是**来源错误**（退出 5），
    // 不是「会话读不到」的覆盖缺口——调用方点名了这份文件，它就该在分母里。
    // 默认扫描模式下照旧记成会话级输入缺口（解码失败）。
    if (controlled) failUsage("source-unreadable", `--source #${sourceIndex + 1}`);
    decodeFailed += 1;
    tally.gap("会话日志解码失败");
    continue;
  }
  if (!decoded) {
    decodedEmpty += 1;
    tally.gap("会话日志解码为空");
    continue;
  }
  const rows: Row[] = [];
  let unparsableLines = 0;
  for (const line of decoded.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      // 半截行跳过——但**要报出来**：这一行里可能有助手消息，静默跳过就是无声的覆盖缺口。
      unparsableLines += 1;
    }
  }
  if (unparsableLines > 0) {
    unparsableSessions += 1;
    tally.note("会话日志里有无法解析的行", unparsableLines);
  }
  const events = rows.filter(
    (row): row is Row & SessionWireEvent => typeof row.type === "string" && typeof row.seq === "number",
  ) as unknown as SessionWireEvent[];
  if (events.length === 0) {
    noParsedEvents += 1;
    tally.note("会话日志解码成功但没有可解析的合法事件行");
    continue;
  }
  if (!events.some((event) => event.type === "assistant/message")) {
    // 没有助手消息的会话没有什么可比：既不是缺失，也不是匹配，单列一档观察。
    noAssistantMessage += 1;
    tally.note("会话里没有 assistant/message（没有可比对的样本）");
    continue;
  }
  scannedFiles += 1;
  const model = deriveTrajectoryModel(events, false);
  /**
   * 账本里的助手行按 **seq 多重集**收：真实日志 seq 唯一，但同一 seq 出现两次时
   * 「一个 seq 一条记录」的 Map 会把两条事件配到同一条账本行上（静默错配）。
   */
  const ledgerCells = new Map<number, TrajectoryCell[]>();
  for (const cell of model.turns.flatMap(trajectoryTurnCells)) {
    if (cell.kind !== "message") continue;
    const bucket = ledgerCells.get(cell.seq);
    if (bucket === undefined) ledgerCells.set(cell.seq, [cell]);
    else bucket.push(cell);
  }
  const assistantSeqs: number[] = [];
  for (const event of events) {
    if (event.type === "assistant/message") assistantSeqs.push(event.seq);
  }
  const assistantCount = new Map<number, number>();
  for (const seq of assistantSeqs) assistantCount.set(seq, (assistantCount.get(seq) ?? 0) + 1);

  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    const data = (event.data ?? {}) as Record<string, any>;
    const blocks = data.message?.content;
    const official = officialMessageShape(blocks);
    scannedMessages += 1;
    tally.expect();
    if (official.toolCallOnly) officialToolOnly += 1;
    const combo = (Array.isArray(blocks) ? blocks : []).map((block: any) => block?.type).join(",");
    if (!official.toolCallOnly && official.messageText === "" && official.thinkingText !== "") {
      blockCombos.set(combo, (blockCombos.get(combo) ?? 0) + 1);
    }
    const bucket = ledgerCells.get(event.seq);
    const cell = bucket?.shift();
    if (cell === undefined) {
      // **不许 continue**：这一条应当比较却没能比，记成缺失并带原因。
      tally.miss((assistantCount.get(event.seq) ?? 0) > 1 ? MISS_DUPLICATE_SEQ : MISS_NO_LEDGER_CELL);
      continue;
    }
    const ours = trajectoryCellContent(cell, texts).text;
    const oursToolCallOnly = ours === texts.recordToolCallOnly || ours === texts.toolCallOnly;
    if (oursToolCallOnly) oursToolOnly += 1;
    tally.compare();
    const record: Mismatch = {
      file,
      seq: event.seq,
      kind: "误判为仅工具调用",
      ours,
      official: official.listText,
      blocks: combo,
    };
    if (official.toolCallOnly && !oursToolCallOnly) {
      mismatches.push({ ...record, kind: "该仅工具调用却不然" });
      tally.mismatch();
    } else if (!official.toolCallOnly && oursToolCallOnly) {
      mismatches.push(record);
      tally.mismatch();
    } else if (!official.toolCallOnly && official.listText !== "—" && (ours === "" || ours === "—")) {
      mismatches.push({ ...record, kind: "有正文却显示空" });
      tally.mismatch();
    }
  }

  /**
   * **turn 0 的观察**：官方的 prologue 规则是无条件把 turn 0 并进 turn 1，本扩展从前多了一个
   * 「turn 0 里没有用户消息」的条件。这条只会被「有 turn 0 的日志」触发，所以顺手量一下
   * 真实日志里有没有 0 号轮——没有就说明两种写法在实践中等价。
   */
  if (events.some((event) => event.type === "turn/start"
    && (event.data as { turn?: unknown } | undefined)?.turn === 0)) {
    turnZeroFiles += 1;
  }

  /**
   * **steering 分类的对拍**：拿官方那台状态机（`src/vendor/ui-trajectory/inbox-state.ts`）
   * 直接跑同一串**原始**事件，与折叠层给出的 `steering` 标记逐条比。
   *
   * 这里刻意**不复用折叠层的形状守卫**（`target` / `start` / `inserted[].id` 都按原始值读），
   * 否则守卫写错时两边一起错、对拍恒绿。它抓的是**接线**：target 过滤、id 取自哪个字段、
   * 「领取集合装被移除的那批」这三处。
   */
  let inbox: InboxState | undefined;
  const reference = new Map<number, boolean>();
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, any>;
    if (event.type === "agent/inbox/spliced") {
      if (data.target !== "next-step") continue;
      inbox = applySplice(inbox, {
        start: data.start,
        ...(data.removedCount === undefined ? {} : { removedCount: data.removedCount }),
        inserted: (Array.isArray(data.inserted) ? data.inserted : []).map(
          // id **按原始字段读**（不复用折叠层的形状守卫，否则守卫写错时两边一起错）；
          // 畸形元素（没有 string id）用空串这个不可能与真实 uuid 相撞的占位——
          // 占位选什么不影响这条对拍要抓的接线（target 过滤 / id 取自哪个字段 / 领取集合）。
          (identity: { id?: string }) => ({ id: typeof identity?.id === "string" ? identity.id : "" }),
        ),
        ...(data.outcome === undefined ? {} : { outcome: data.outcome }),
      });
      continue;
    }
    if (event.type !== "user/message") continue;
    if (data.source?.kind !== "user") continue;
    humanMessages += 1;
    const steering = inbox?.currentClaimed.has(String(data.id)) === true;
    if (steering) referenceSteering += 1;
    reference.set(event.seq, steering);
  }
  const foldSteering = new Map<number, boolean>();
  for (const cell of model.turns.flatMap(trajectoryTurnCells)) {
    if (cell.kind !== "user" || cell.messageSource?.kind !== "user") continue;
    foldSteering.set(cell.seq, cell.steering === true);
  }
  for (const [seq, expected] of reference) {
    tally.expect();
    if (!foldSteering.has(seq)) {
      // 从前这里把「取不到」当 `false`（= 真用户消息），expected=false 时静默算作一致。
      tally.miss(MISS_NO_LEDGER_USER);
      continue;
    }
    tally.compare();
    const actual = foldSteering.get(seq) === true;
    if (actual === expected) continue;
    mismatches.push({
      file,
      seq,
      kind: "steering 分类不符",
      ours: actual ? "steering" : "user",
      official: expected ? "steering" : "user",
      blocks: "-",
    });
    tally.mismatch();
  }

  /**
   * **分组的不变量**。有一条**例外是官方的本意**，不能当成错：
   * steering 被放进**消费它的那一步**的组里（`steeringPlacement()`），如果那一步的组
   * 还没建，组就由它起头；否则追加在组尾（官方 `pushStepInput()` 在没有
   * `requestOnly` 锚点行时走 `push()` 那一支）。两种情形都会让「steering 之后、
   * 它那一步的助手之前」那些消息行另起一个消息组，而这个消息组排在步骤组**之后**
   * ——两条记录的序号因此**故意**不单调。实测本机 155 条 steering 里有 97 条走这一支，
   * 官方那份 `flattenRecords()` 出来的顺序也是这样。
   *
   * 所以判据落在「组内」与「完整性」上，而不是全局单调：
   * 1. 每条记录**恰好**出现一次（`model.cellCount` 对得上）；
   * 2. 每组里的非 steering 记录序号严格递增（追加顺序没错）；
   * 3. `step > 0` 的记录在同号步骤组里、压缩自成一组。
   */
  let grouped = 0;
  for (const turn of model.turns) {
    for (const group of turn.groups) {
      let previous = -1;
      for (const cell of group.cells) {
        grouped += 1;
        groupedCells += 1;
        const inStep = group.title.kind === "step";
        if (cell.steering !== true) {
          if (cell.index <= previous) {
            mismatches.push({
              file, seq: cell.index, kind: "分组位次被打乱",
              ours: `#${cell.index} 在 #${previous} 之后（同组内）`, official: "组内严格递增",
              blocks: "-",
            });
            tally.mismatch();
          }
          previous = cell.index;
        }
        const wantsStep = cell.kind !== "compacted" && (cell.step ?? 0) > 0;
        if (inStep !== wantsStep) {
          mismatches.push({
            file, seq: cell.seq, kind: "分组与步骤号不符",
            ours: `step=${cell.step ?? "-"} 落在 ${group.title.kind} 组`,
            official: wantsStep ? "步骤组" : "消息组",
            blocks: "-",
          });
          tally.mismatch();
        }
        if (inStep && group.title.kind === "step" && group.title.step !== cell.step) {
          mismatches.push({
            file, seq: cell.seq, kind: "分组与步骤号不符",
            ours: `step=${cell.step ?? "-"} 落在第 ${group.title.step} 步组`,
            official: `第 ${cell.step} 步组`,
            blocks: "-",
          });
          tally.mismatch();
        }
        if (cell.kind === "compacted"
          && (group.title.kind !== "compaction" || group.title.seq !== cell.seq)) {
          mismatches.push({
            file, seq: cell.seq, kind: "压缩没自成一组",
            ours: group.title.kind, official: `compaction seq=${cell.seq}`, blocks: "-",
          });
          tally.mismatch();
        }
      }
    }
  }
  if (grouped !== model.cellCount) {
    mismatches.push({
      file, seq: 0, kind: "分组位次被打乱",
      ours: `归组 ${grouped} 条 / 账本 ${model.cellCount} 条`, official: "每条恰好一组",
      blocks: "-",
    });
    tally.mismatch();
  }
}

const counts = tally.counts;
const verdict = tally.verdict();
const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);

if (controlled) {
  console.log(`来源：受控 --source 模式，显式 ${files.length} 份文件（不扫描默认会话目录）`);
  console.log(`Source: controlled --source mode, ${files.length} explicit file(s); the default session directory is not scanned`);
} else {
  console.log(`来源：默认会话目录扫描（--limit ${selection.limit === Number.POSITIVE_INFINITY ? "未给" : selection.limit}）`);
}
console.log(`发现 ${discoveredFiles} 份会话日志；进入对拍 ${scannedFiles} 份 `
  + `（无 assistant/message ${noAssistantMessage} 份）`);
console.log(`输入覆盖缺口：解码失败 ${decodeFailed} / 解码为空 ${decodedEmpty}`
  + `（完全读不到的会话，一条也没比较，与匹配分开计）`);
if (counts.gaps > 0) {
  for (const { reason, count } of tally.gapsByReason) console.log(`    ${String(count).padStart(5)}  ${reason}`);
}
if (tally.notesByReason.length > 0) {
  console.log(`会话级观察（读得到但没有可比较的东西；不改变判定）：`
    + `无合法事件 ${noParsedEvents} 份 / 有无法解析的行 ${unparsableSessions} 份`);
  for (const { reason, count } of tally.notesByReason) console.log(`    ${String(count).padStart(5)}  ${reason}`);
}
console.log(`\n应当比较 ${counts.expected} 条（其中 assistant/message ${scannedMessages} 条）`);
console.log(`  已比较 ${counts.compared} 条（${pct(counts.compared, counts.expected)} of 应当比较）`);
console.log(`  未比较（缺失） ${counts.missing} 条`);
for (const { reason, count } of tally.missingByReason) console.log(`    ${String(count).padStart(5)}  ${reason}`);
if (counts.missing === 0) console.log("    0（没有应当比较却没能比较的样本）");
if (counts.gaps > 0) {
  console.log(`  输入覆盖缺口 ${counts.gaps} 条（完全读不到的会话；不是匹配，也不是缺失）`);
  for (const { reason, count } of tally.gapsByReason) console.log(`    ${String(count).padStart(5)}  ${reason}`);
}
console.log(`\n错配 ${counts.mismatched} 条：`);
const byKind = new Map<string, number>();
for (const mismatch of mismatches) byKind.set(mismatch.kind, (byKind.get(mismatch.kind) ?? 0) + 1);
for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${kind}`);
}

console.log(`\n官方认定为「仅工具调用」的 ${officialToolOnly} 条；本扩展渲染成「仅工具调用」的 ${oursToolOnly} 条`);
console.log(`只有思考、没有正文的助手消息（官方展示思考摘要）分布：`);
for (const [combo, count] of [...blockCombos.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${combo}`);
}
// steering 与分组：这两个数**只作观察**，判据在上面那些错配与缺失里。
console.log(
  `\n人发消息 ${humanMessages} 条，其中 steering ${referenceSteering} 条`
  + `（${humanMessages === 0 ? "—" : `${((referenceSteering / humanMessages) * 100).toFixed(1)}%`}）；`
  + `按组归位的记录 ${groupedCells} 条`,
);
console.log(`含 0 号轮的日志 ${turnZeroFiles} 份（prologue 那条无条件分支只被它触发）`);

console.log("\n本探针**实际比较**的字段：");
for (const { field, reason } of tally.comparedFields) console.log(`  · ${field}（${reason}）`);
console.log("本探针**明确不比较**的字段（未比较原因）：");
for (const { field, reason } of tally.uncomparedFields) console.log(`  · ${field}：${reason}`);

if (verbose) {
  console.log("\n样本：");
  for (const mismatch of mismatches.slice(0, 10)) {
    console.log(`\n  ${mismatch.kind} @ seq=${mismatch.seq} blocks=${mismatch.blocks}`);
    console.log(`    本扩展: ${JSON.stringify(mismatch.ours.slice(0, 90))}`);
    console.log(`    官方  : ${JSON.stringify(mismatch.official.slice(0, 90))}`);
  }
}

console.log(`\n判定：${verdictText(verdict)}（退出码 ${verdict}）`);
if (verdict === PROBE_EXIT.mismatched) {
  console.log("轨迹账本展示口径与官方不一致（加 --verbose 看样本）");
} else if (verdict === PROBE_EXIT.missing) {
  console.log("有应当比较却没能比较的样本：不得据此宣称「错配 0 即等价」");
} else if (verdict === PROBE_EXIT.zeroSample) {
  console.log("零样本：没有可比较的助手消息，不能视为通过");
} else if (verdict === PROBE_EXIT.coverage) {
  console.log("输入覆盖不完整：有会话没能进入比较，不得宣告全量一致");
} else {
  console.log("轨迹账本展示口径与官方一致 ✓");
}
process.exit(verdict);
