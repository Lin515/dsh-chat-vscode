/**
 * 轨迹统计探针的**共用纯逻辑**：工具结果信封抽取、内容块普查、结果正文的 JSON 形状，
 * 以及「对拍比较」的 expected / compared / missing / mismatched 计量。
 *
 * 为什么要有这个模块：`scripts/trajectoryGapProbe.ts`（观察）与
 * `scripts/trajectoryAlignProbe.ts`（防线）此前各写各的计数，两处口径会漂；而离线测试
 * 只能对着抄一遍，抓不到「CLI 里少算了一档」。这里把口径收成一处，两个 CLI 与
 * `scripts/trajectoryProbeFacts.test.ts` 共用同一份实现。
 *
 * 本模块**无 I/O 与外部资源副作用**：不读文件、不打印、不退出。
 * 计数函数显式更新传入的统计对象，累计器维护自身状态；调用方决定输出与退出码。
 * （`parseProbeArgs` 只用 `node:path` 的 `resolve()` 做纯字符串归一化，仍不读盘。）
 */
import { resolve } from "node:path";

/**
 * 工具结果内容的**信封形态**。
 *
 * - `modern`（0.1.7-alpha.1 起）：`role:'tool'` 的一等消息，`message.content` 直接就是
 *   内容块数组；
 * - `legacy`（0.1.6-alpha.2 及更早）：`message.content` 是**包装块**数组，真正的内层内容
 *   在 `tool-result.content` 里。官方 v3→v4 迁移（`session-format-v3-to-v4` 的
 *   `liftToolResult`）要求这类消息恰好一个包装块，且内层不含嵌套 `tool-result`；
 * - `absent`：`content` 不是数组（字段缺失或形状不对）。
 *
 * 与 `src/dsh/adapter.ts` 的 `toolResultParts()`、`src/dsh/trajectory.ts` 的 `resultText()`
 * 同口径：**认包装块就用内层，认不出就是现代形态**。判据只看**块形状**，不读
 * `role` / `source` / `source.model` 这些引用字段——两种形态的 `source` 都是
 * `{kind:'tool', callId}`，按引用判形态会把现代结果误判成旧信封。
 */
export type ToolResultEnvelope = "modern" | "legacy" | "absent";

export interface ToolResultContent {
  envelope: ToolResultEnvelope;
  /** 真实内容块（旧信封已拆掉 `tool-result` 包装）。 */
  blocks: readonly unknown[];
  /** 顶层成员数（旧信封里就是包装块个数）。 */
  members: number;
  /** 顶层成员里 `tool-result` 包装块的个数（现代形态恒 0）。 */
  wrappers: number;
}

/** 统一抽取工具结果的内容块；见 `ToolResultEnvelope`。 */
export function extractToolResultContent(content: unknown): ToolResultContent {
  if (!Array.isArray(content)) {
    return { envelope: "absent", blocks: [], members: 0, wrappers: 0 };
  }
  let wrappers = 0;
  let inner: readonly unknown[] | undefined;
  for (const member of content) {
    if (member === null || typeof member !== "object" || Array.isArray(member)) continue;
    if ((member as { type?: unknown }).type !== "tool-result") continue;
    wrappers += 1;
    if (inner === undefined) {
      const nested = (member as { content?: unknown }).content;
      // 包装块的 `content` 不是数组时**不回落**到包装块本身：那是畸形数据，
      // 回落会把包装壳当成内容（长度、图片、JSON 三项全算错）。
      inner = Array.isArray(nested) ? nested : [];
    }
  }
  if (wrappers > 0) {
    return { envelope: "legacy", blocks: inner ?? [], members: content.length, wrappers };
  }
  return { envelope: "modern", blocks: content, members: content.length, wrappers: 0 };
}

/**
 * 内容块的种类。
 *
 * `unknown` = 是对象、但没有字符串 `type`（或其 `type` 不在已知清单里）；
 * `invalid` = 成员根本不是对象（`null`、字符串、数字…）。两者分开数：前者可能是
 * 新协议块，后者一定是畸形数据。
 */
export type BlockKind =
  | "text"
  | "image"
  | "file"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "unknown"
  | "invalid";

const KNOWN_BLOCK_KINDS = new Set<string>([
  "text",
  "image",
  "file",
  "reasoning",
  "tool-call",
  "tool-result",
]);

export function blockKindOf(block: unknown): BlockKind {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return "invalid";
  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string") return "unknown";
  return (KNOWN_BLOCK_KINDS.has(type) ? type : "unknown") as BlockKind;
}

export interface BlockCensus {
  members: number;
  invalid: number;
  text: number;
  image: number;
  file: number;
  reasoning: number;
  toolCall: number;
  toolResult: number;
  unknown: number;
}

export function newBlockCensus(): BlockCensus {
  return { members: 0, invalid: 0, text: 0, image: 0, file: 0, reasoning: 0, toolCall: 0, toolResult: 0, unknown: 0 };
}

export function countBlocks(census: BlockCensus, blocks: readonly unknown[]): void {
  for (const block of blocks) {
    census.members += 1;
    switch (blockKindOf(block)) {
      case "text": census.text += 1; break;
      case "image": census.image += 1; break;
      case "file": census.file += 1; break;
      case "reasoning": census.reasoning += 1; break;
      case "tool-call": census.toolCall += 1; break;
      case "tool-result": census.toolResult += 1; break;
      case "unknown": census.unknown += 1; break;
      default: census.invalid += 1; break;
    }
  }
}

export interface ResultText {
  /** 全部 text 块按 `\n` 连接的正文（非 text 块不含在内）。 */
  text: string;
  textBlocks: number;
  nonTextBlocks: number;
}

/** 结果正文：只取 `text` 块。图片 / 未知 / 不合法成员只计数，不进正文。 */
export function resultTextOf(blocks: readonly unknown[]): ResultText {
  const parts: string[] = [];
  let textBlocks = 0;
  let nonTextBlocks = 0;
  for (const block of blocks) {
    if (blockKindOf(block) === "text") {
      textBlocks += 1;
      const text = (block as { text?: unknown }).text;
      parts.push(typeof text === "string" ? text : "");
    } else {
      nonTextBlocks += 1;
    }
  }
  return { text: parts.join("\n"), textBlocks, nonTextBlocks };
}

/** 容器的孩子表（数组直接用下标访问，不复制）；标量返回 `undefined`。 */
function childrenOf(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>);
  }
  return undefined;
}

/**
 * 最大嵌套深度：标量 0，`{a:1}` / `[1]` 1，`{a:{b:1}}` 2。空容器算 1。
 *
 * **不能写成 JS 递归，也不能展开实参**：旧写法 `Math.max(...value.map(depthOf))` 有两处
 * 会把**合法**数据判成「算不出来」——20 万成员的扁平数组（深度本来就是 1）把 20 万个实参
 * 推进调用栈，2 万层的合法 JSON 数组在递归里爆栈，两者都抛 `RangeError: Maximum call
 * stack size exceeded`。栈溢出不是「这段正文不是 JSON」：调用方一旦把它折成「解析失败」，
 * 合法样本就被静默丢出分母（见 `parseJsonContainer`）。
 *
 * 这里改成**显式栈的后序 DFS**：
 * - 时间 O(nodes)：每个节点恰好进入一次、比较一次；
 * - 空间 O(当前路径上各容器的孩子表总宽)（最坏 O(nodes)，与递归版的实参展开同一量级）；
 * - 语义与旧写法逐字一致（标量 0 / 空容器 1 / 容器 = 1 + 最深孩子），**没有任何深度上限**，
 *   合法深度不会被 cap 吞掉；
 * - 数组不上 `map`（不复制），对象只在进入时 `Object.values` 一次。
 */
export function depthOf(value: unknown): number {
  interface Frame {
    readonly children: readonly unknown[];
    /** 下一个待访问的下标。 */
    index: number;
    /** 已见到的最深孩子深度。 */
    best: number;
  }
  const stack: Frame[] = [];
  /** 当前节点的深度：算完就交给父帧，或作为最终结果返回。 */
  let depth = 0;

  for (let node: unknown = value; ; ) {
    const children = childrenOf(node);
    if (children === undefined) {
      depth = 0;
    } else if (children.length === 0) {
      depth = 1;
    } else {
      // 非空容器：压帧后**先下潜到第一个孩子**，避免把整层孩子一次性铺进栈。
      stack.push({ children, index: 0, best: 0 });
      node = children[0];
      continue;
    }
    // 回溯：把当前深度并进父帧，再走下一个兄弟；没有父帧就结束。
    for (;;) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) return depth;
      if (depth > frame.best) frame.best = depth;
      frame.index += 1;
      if (frame.index < frame.children.length) {
        node = frame.children[frame.index];
        break;
      }
      stack.pop();
      depth = 1 + frame.best;
    }
  }
}

/** 顶层**容器**字段（值是对象或数组）的个数：折叠树的价值就落在这几个字段上。 */
export function containerFieldsOf(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value as Record<string, unknown>).filter(
    (entry) => entry !== null && typeof entry === "object",
  ).length;
}

export type JsonKind = "object" | "array";

export interface ParsedJsonText {
  value: unknown;
  kind: JsonKind;
  depth: number;
  containers: number;
}

export type JsonShape = Omit<ParsedJsonText, "value">;

/**
 * 正文的 JSON 解析。**先看前缀，再解析**（官方 `parseJsonContainer` 就是这个判据）：
 * trim 后不以 `{` / `[` 开头的正文根本不是 JSON 候选，返回 `undefined`；
 * 以它开头但 `JSON.parse` 失败的同样返回 `undefined`——**解析失败不算 JSON 样本**，
 * 计数侧另记一档「候选但解析失败」。
 *
 * 因此解析成功只可能是对象或数组两种 `kind`，不会出现标量。
 */
export function parseJsonContainer(text: unknown): ParsedJsonText | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  /**
   * **形状与深度计算刻意留在 `try` 之外**：`catch` 只认 `JSON.parse` 自己的失败。
   * 把深度遍历的异常也折成 `undefined`，等于把「算不出来」冒充成「这段正文不是 JSON」，
   * 计数侧会把合法样本记进「候选但解析失败」那一档——无声的数据丢失。
   * （`depthOf` 现在是指针遍历，不再有栈溢出这条路径，见它的注释。）
   */
  return {
    value,
    kind: Array.isArray(value) ? "array" : "object",
    depth: depthOf(value),
    containers: containerFieldsOf(value),
  };
}

/** 只要形状、不要值的那一半（`parseJsonContainer` 的投影）。 */
export function jsonShapeOf(text: unknown): JsonShape | undefined {
  const parsed = parseJsonContainer(text);
  if (parsed === undefined) return undefined;
  return { kind: parsed.kind, depth: parsed.depth, containers: parsed.containers };
}

/** 正文是不是 JSON **候选**（trim 后以 `{` / `[` 开头）；解析成败另说。 */
export function looksJson(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export interface DepthBucket {
  edge: number;
  label: string;
}

export const DEPTH_EDGES: readonly DepthBucket[] = [
  { edge: 0, label: "0（标量）" },
  { edge: 1, label: "1（扁平对象）" },
  { edge: 2, label: "2（一层嵌套）" },
  { edge: 3, label: "3" },
  { edge: Number.POSITIVE_INFINITY, label: "≥4" },
];

/** 按阈值分档计数（先到先得，故 edges 必须升序）。 */
export function bucketDepth(counts: Map<string, number>, value: number, edges = DEPTH_EDGES): void {
  for (const { edge, label } of edges) {
    if (value <= edge) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
      return;
    }
  }
}

/** 结果口径的累计器：一次 `add()` 记一条 `tool/result`。 */
export interface ToolResultStats {
  results: number;
  modern: number;
  legacy: number;
  absent: number;
  /** 抽取后一个块都没有的结果（信封形态另计）。 */
  emptyContent: number;
  /** 抽取后多于一个块的结果（逐块视图的用武之地）。 */
  multiblock: number;
  withImage: number;
  /** 至少一个 text 块。 */
  textBearing: number;
  /** 有内容块、但一个 text 块都没有。 */
  nonTextOnly: number;
  /** 正文是 JSON 候选。 */
  jsonCandidates: number;
  /** 候选里解析成功的（= 对象 + 数组）。 */
  jsonParsed: number;
  jsonObject: number;
  jsonArray: number;
  /** 候选里解析失败的——**不算 JSON 样本**。 */
  jsonInvalid: number;
  /** 正文不是 JSON 候选。 */
  notJsonText: number;
  blocks: BlockCensus;
  depths: Map<string, number>;
}

export function newToolResultStats(): ToolResultStats {
  return {
    results: 0,
    modern: 0,
    legacy: 0,
    absent: 0,
    emptyContent: 0,
    multiblock: 0,
    withImage: 0,
    textBearing: 0,
    nonTextOnly: 0,
    jsonCandidates: 0,
    jsonParsed: 0,
    jsonObject: 0,
    jsonArray: 0,
    jsonInvalid: 0,
    notJsonText: 0,
    blocks: newBlockCensus(),
    depths: new Map<string, number>(),
  };
}

/** 记一条工具结果的 `message.content`。 */
export function addToolResult(stats: ToolResultStats, content: unknown): ToolResultContent {
  const extracted = extractToolResultContent(content);
  stats.results += 1;
  if (extracted.envelope === "modern") stats.modern += 1;
  else if (extracted.envelope === "legacy") stats.legacy += 1;
  else stats.absent += 1;

  const blocks = extracted.blocks;
  if (blocks.length === 0) stats.emptyContent += 1;
  if (blocks.length > 1) stats.multiblock += 1;
  countBlocks(stats.blocks, blocks);
  let hasImage = false;
  for (const block of blocks) if (blockKindOf(block) === "image") hasImage = true;
  if (hasImage) stats.withImage += 1;

  const { text, textBlocks } = resultTextOf(blocks);
  if (textBlocks > 0) stats.textBearing += 1;
  else if (blocks.length > 0) stats.nonTextOnly += 1;

  if (!looksJson(text)) {
    stats.notJsonText += 1;
    return extracted;
  }
  stats.jsonCandidates += 1;
  const shape = jsonShapeOf(text);
  if (shape === undefined) {
    stats.jsonInvalid += 1;
    return extracted;
  }
  stats.jsonParsed += 1;
  if (shape.kind === "object") stats.jsonObject += 1;
  else stats.jsonArray += 1;
  bucketDepth(stats.depths, shape.depth);
  return extracted;
}

/** 探针退出码。**必须互不相同**：缺失与错配不是同一件事，零样本更不是「全绿」。 */
export const PROBE_EXIT = {
  /** 有比较、无缺失、无错配、无覆盖缺口。 */
  aligned: 0,
  /** 有错配（mismatched > 0）。 */
  mismatched: 1,
  /** 有缺失（missing > 0）且无错配。 */
  missing: 2,
  /** 零样本：一条都没比（不能算通过）。 */
  zeroSample: 3,
  /** 输入覆盖缺口：会话**完全读不到**（解码失败 / 解码为空），不得宣告全量一致。 */
  coverage: 4,
  /** 参数错误（未知选项 / 缺值 / 非法 `--limit` / 重复来源）：**一个来源都没读**。 */
  usage: 5,
} as const;

export interface TallyCounts {
  expected: number;
  compared: number;
  missing: number;
  mismatched: number;
  gaps: number;
}

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface FieldDisclosure {
  field: string;
  reason: string;
}

/**
 * 对拍计量：**expected / compared / missing / mismatched 分开**。
 *
 * 关键纪律：`compared` **只**在真的比过一个字段时才加；`missing` 必须带原因
 * （「来源折不出」「字段未比较」），不允许用 `continue` 把它吞掉再宣称「错配 0」。
 */
export class ComparisonTally {
  #expected = 0;
  #compared = 0;
  #mismatched = 0;
  #gaps = 0;
  readonly #missing = new Map<string, number>();
  readonly #gapReasons = new Map<string, number>();
  readonly #notes = new Map<string, number>();
  readonly #uncompared = new Map<string, string>();
  readonly #comparedFields = new Map<string, string>();

  /** 声明一条**应当**比较的样本。 */
  expect(count = 1): void {
    this.#expected += count;
  }

  /** 一条样本真的比过了（字段可解析、两边都有）。 */
  compare(count = 1): void {
    this.#compared += count;
  }

  /** 一条应当比较的样本没能比：必须给原因。 */
  miss(reason: string, count = 1): void {
    this.#missing.set(reason, (this.#missing.get(reason) ?? 0) + count);
  }

  /** 一条比过了、但结果不一致。 */
  mismatch(count = 1): void {
    this.#mismatched += count;
  }

  /**
   * 会话级**输入缺口**：我们对该会话完全没有可见性（解码失败 / 解码为空）。
   * 这类缺口让「全量一致」不成立，是判定的一部分（退出码 `coverage`）。
   */
  gap(reason: string, count = 1): void {
    this.#gaps += count;
    this.#gapReasons.set(reason, (this.#gapReasons.get(reason) ?? 0) + count);
  }

  /**
   * 会话级**观察**：读得到、但里面没有可比较的东西（没有合法事件行、没有助手消息、
   * 有无法解析的行）。这些**不改变判定**——真实日志里本来就允许存在空会话与半截行，
   * 拿它们判红只会得到一条随数据漂的假防线；但它们必须与「比过且一致」分开报告。
   */
  note(reason: string, count = 1): void {
    this.#notes.set(reason, (this.#notes.get(reason) ?? 0) + count);
  }

  /** 登记实际比较过的字段（跑完打印，便于判断覆盖面）。 */
  declareCompared(field: string, note: string): void {
    this.#comparedFields.set(field, note);
  }

  /** 登记**明确不比较**的字段与原因——「字段未比较」必须显式。 */
  declareUncompared(field: string, reason: string): void {
    this.#uncompared.set(field, reason);
  }

  get counts(): TallyCounts {
    let missing = 0;
    for (const count of this.#missing.values()) missing += count;
    return {
      expected: this.#expected,
      compared: this.#compared,
      missing,
      mismatched: this.#mismatched,
      gaps: this.#gaps,
    };
  }

  get missingByReason(): ReasonCount[] {
    return [...this.#missing.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }

  get gapsByReason(): ReasonCount[] {
    return [...this.#gapReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }

  get notesByReason(): ReasonCount[] {
    return [...this.#notes.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }

  get uncomparedFields(): FieldDisclosure[] {
    return [...this.#uncompared.entries()].map(([field, reason]) => ({ field, reason }));
  }

  get comparedFields(): FieldDisclosure[] {
    return [...this.#comparedFields.entries()].map(([field, note]) => ({ field, reason: note }));
  }

  /**
   * 防线判定。顺序有意：**零样本**最先（一条都没比，谈不上任何结论），
   * 其次错配、缺失，最后才是输入覆盖缺口。
   */
  verdict(): number {
    if (this.#expected === 0) return PROBE_EXIT.zeroSample;
    if (this.#mismatched > 0) return PROBE_EXIT.mismatched;
    let missing = 0;
    for (const count of this.#missing.values()) missing += count;
    if (missing > 0) return PROBE_EXIT.missing;
    if (this.#gaps > 0) return PROBE_EXIT.coverage;
    return PROBE_EXIT.aligned;
  }
}

/** 退出码 → 给用户看的一句话（两个 CLI 共用，措辞保持一致）。 */
export function verdictText(code: number): string {
  switch (code) {
    case PROBE_EXIT.aligned: return "全部已比较样本口径一致";
    case PROBE_EXIT.mismatched: return "有错配";
    case PROBE_EXIT.missing: return "有应当比较却没能比较的样本（缺失）";
    case PROBE_EXIT.zeroSample: return "零样本：没有任何可比较的样本，不能视为通过";
    case PROBE_EXIT.coverage: return "输入覆盖不完整：有会话没能进入比较，不得宣告全量一致";
    case PROBE_EXIT.usage: return "参数错误：一个来源都没有读取";
    default: return "未知判定";
  }
}

/**
 * 探针命令行（`trajectoryGapProbe` / `trajectoryAlignProbe`）的**共用解析**。
 *
 * 为什么不让每个 CLI 各写一份：两条入口的「来源选择」与「参数错误」必须是同一套口径，
 * 否则一个 CLI 收下的参数另一个拒掉、或者两者对重复来源的处理不同，报出来的分母就不可比。
 *
 * 契约：
 * - `--source <路径>` 可重复：**显式受控来源**，按命令行顺序。给了它就**完全不调用**
 *   默认的会话目录扫描（探针里的 `findLogs`），因此这两条 CLI 只读调用方点名的文件；
 * - 同一路径只允许出现一次，重复即参数错误——否则同一份日志被计两次，分母虚高，
 *   而「算了两遍」在汇总输出里看不出来。判重按 `resolve()` 归一化后的路径，
 *   Windows 上再折一次大小写（同一目录下 `C:\A` 与 `c:\a` 是同一个文件）；
 * - `--limit <正整数>` 只对默认扫描模式有效（「最近 n 份」）。与 `--source` 同时出现是
 *   参数错误——两种来源口径混用时「n 份」数的是哪一批没有定义。`0`、负数、小数、
 *   科学计数、前导零、非安全整数一律拒（旧实现把 `--limit abc` 静默变成 `NaN`，
 *   再被 `slice(0, NaN)` 吃成「一份都不扫」，于是探针在零样本上照样往下走）；
 * - `--verbose` 只在该 CLI 声明支持时接受；
 * - 其余一律参数错误。解析器**不回显参数原文**（它可能是路径或秘密），只报语言中立的
 *   错误码与出错位置，由 CLI 印中英两行诊断。
 *
 * 本函数只依赖 `resolve()`（纯字符串归一化，不读盘、不解析符号链接）。
 */
export const PROBE_ARG_ERRORS = [
  "unknown-option",
  "missing-value",
  "invalid-limit",
  "duplicate-source",
  "limit-with-source",
] as const;

export type ProbeArgErrorCode = (typeof PROBE_ARG_ERRORS)[number];

export interface ProbeArgError {
  code: ProbeArgErrorCode;
  /** 出错参数在命令行里的 1 起序号（**不含参数原文**）。 */
  position: number;
}

export interface ProbeArgs {
  /** 显式受控来源；`null` = 没给 `--source`，走默认扫描。 */
  readonly sources: readonly string[] | null;
  /** 默认扫描模式的「最近 n 份」；没给 `--limit` 时是 `Number.POSITIVE_INFINITY`。 */
  readonly limit: number;
  readonly verbose: boolean;
}

export type ProbeArgsResult = { ok: true; args: ProbeArgs } | { ok: false; error: ProbeArgError };

/** `--limit` 只收正整数字面量（无正负号、无小数点、无科学计数、无前导零）。 */
const LIMIT_PATTERN = /^[1-9][0-9]*$/;

/** 来源判重键：绝对路径 +（Windows）折大小写。 */
function sourceKey(value: string): string {
  const absolute = resolve(value);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function parseProbeArgs(
  argv: readonly string[],
  options: { readonly allowVerbose?: boolean } = {},
): ProbeArgsResult {
  const sources: string[] = [];
  const seen = new Set<string>();
  let limit: number | undefined;
  let limitPosition = 0;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const position = index + 1;
    if (token === "--verbose") {
      if (options.allowVerbose !== true) return { ok: false, error: { code: "unknown-option", position } };
      verbose = true;
      continue;
    }
    if (token === "--source") {
      const value = argv[index + 1];
      // 缺值 / 空串 / 下一个选项的形态都不当路径用：那会把 `--limit` 的 5 读成文件名。
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { ok: false, error: { code: "missing-value", position } };
      }
      index += 1;
      const key = sourceKey(value);
      if (seen.has(key)) return { ok: false, error: { code: "duplicate-source", position } };
      seen.add(key);
      sources.push(value);
      continue;
    }
    if (token === "--limit") {
      const value = argv[index + 1];
      if (value === undefined || value === "") return { ok: false, error: { code: "missing-value", position } };
      if (!LIMIT_PATTERN.test(value)) return { ok: false, error: { code: "invalid-limit", position } };
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) return { ok: false, error: { code: "invalid-limit", position } };
      limit = parsed;
      limitPosition = position;
      index += 1;
      continue;
    }
    return { ok: false, error: { code: "unknown-option", position } };
  }

  if (limit !== undefined && sources.length > 0) {
    return { ok: false, error: { code: "limit-with-source", position: limitPosition } };
  }
  return {
    ok: true,
    args: {
      sources: sources.length === 0 ? null : sources,
      limit: limit ?? Number.POSITIVE_INFINITY,
      verbose,
    },
  };
}
