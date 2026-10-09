/**
 * `scripts/trajectoryProbeFacts.ts` 的离线断言：两条正式统计入口
 * （`trajectoryGapProbe` 观察 / `trajectoryAlignProbe` 防线）共用的那套纯口径。
 *
 * 钉住的六件事：
 * 1. **工具结果信封抽取**：现代 / 旧信封统一取内层内容块；混合 text/image/未知、空内容、
 *    非 text、不合法成员、包装块 `content` 不是数组时不回落；形态只按块形状判，
 *    不读 `role` / `source` / `source.model` 这类引用字段。
 * 2. **结果统计的分子分母**：多块 / 图片 / JSON 三项都落在**抽取后**的块上；
 *    JSON **解析成功**、**对象**、**数组**、**候选但解析失败**分别计数，
 *    解析失败**不算 JSON 样本**。
 * 3. **深度与容器字段**的口径。
 * 3b. **合法大尺度 JSON**：20 万成员（宽度）与 2 万层（深度）都不得退化成 JS 调用栈
 *    或实参上限；深度不许被任意 cap 吞掉。
 * 4. **对拍计量**：expected / compared / missing / mismatched / gaps 分开，缺失必须带原因，
 *    零样本与输入覆盖缺口各有独立判定。
 * 5. **命令行参数**：受控 `--source`（可重复、重复即错）、`--limit` 严格正整数、
 *    与 `--source` 互斥、未知选项与缺值一律参数错误。
 *
 * 输入全是本地合成的契约级数据，不读任何用户日志。
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）。
 */
import assert from "node:assert";
import { join } from "node:path";
import {
  PROBE_ARG_ERRORS,
  PROBE_EXIT,
  ComparisonTally,
  addToolResult,
  blockKindOf,
  bucketDepth,
  containerFieldsOf,
  depthOf,
  extractToolResultContent,
  jsonShapeOf,
  looksJson,
  newToolResultStats,
  parseJsonContainer,
  parseProbeArgs,
  resultTextOf,
  verdictText,
} from "./trajectoryProbeFacts";
import type { ProbeArgErrorCode } from "./trajectoryProbeFacts";

// ── 1. 信封抽取 ───────────────────────────────────────────────────────────

const INNER = [{ type: "text", text: '{"nested":{"key":[1]}}' }, { type: "image", attachment: { name: "img" } }];

{
  const modern = extractToolResultContent(INNER);
  assert.strictEqual(modern.envelope, "modern", "无包装块 = 现代形态");
  assert.strictEqual(modern.blocks.length, 2, "现代形态直接用 message.content");
  assert.strictEqual(modern.members, 2);
  assert.strictEqual(modern.wrappers, 0);

  const legacy = extractToolResultContent([{ type: "tool-result", toolCallId: "c1", content: INNER }]);
  assert.strictEqual(legacy.envelope, "legacy", "有 tool-result 包装块 = 旧信封");
  assert.strictEqual(legacy.blocks.length, 2, "旧信封必须取**内层**内容块，外层单块不能取代内层多块");
  assert.strictEqual(legacy.members, 1, "顶层成员数是包装块个数");
  assert.strictEqual(legacy.wrappers, 1);
  assert.deepStrictEqual(legacy.blocks, INNER);
}

{
  // 形态只按块形状判：现代结果即使带 role:'user'（旧信封的角色面）与 source.model 引用，
  // 只要没有包装块就是现代形态。
  const withReferences = extractToolResultContent([
    { type: "text", text: "ok" },
    { type: "image", attachment: { name: "img" }, source: { model: "some-model" } },
  ] as unknown);
  assert.strictEqual(withReferences.envelope, "modern", "不能按 role / source.model 这类引用字段误判形态");

  // 包装块在场就以它为准（与 src/dsh/adapter.ts 的 toolResultParts() 同口径）：
  // 外层其它块不参与统计，避免把包装壳本身当内容重复计入。
  const wrappedWithOuter = extractToolResultContent([
    { type: "text", text: "outer" },
    { type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "inner" }] },
  ]);
  assert.strictEqual(wrappedWithOuter.envelope, "legacy");
  assert.deepStrictEqual(wrappedWithOuter.blocks, [{ type: "text", text: "inner" }]);
}

{
  const mixed = extractToolResultContent([{ type: "text", text: "a" }, null, "nope", 42, { type: "weird" }]);
  assert.strictEqual(mixed.envelope, "modern");
  assert.strictEqual(mixed.blocks.length, 5, "抽取保留全部顶层成员（含不合法成员）");
  assert.strictEqual(blockKindOf(null), "invalid");
  assert.strictEqual(blockKindOf("nope"), "invalid");
  assert.strictEqual(blockKindOf(42), "invalid");
  assert.strictEqual(blockKindOf({ type: "weird" }), "unknown", "有对象形状但 type 不认识 = 未知种类");
  assert.strictEqual(blockKindOf({}), "unknown", "没有字符串 type = 未知种类");
  assert.strictEqual(blockKindOf([{ type: "text" }]), "invalid", "数组成员不是内容块");
}

{
  const empty = extractToolResultContent([]);
  assert.strictEqual(empty.envelope, "modern");
  assert.strictEqual(empty.blocks.length, 0, "空内容 = 抽取后 0 块");

  const absent = extractToolResultContent(undefined);
  assert.strictEqual(absent.envelope, "absent", "content 不是数组 = 无内容字段");
  assert.strictEqual(absent.blocks.length, 0);
  assert.strictEqual(extractToolResultContent("nope").envelope, "absent");
}

{
  const badInner = extractToolResultContent([{ type: "tool-result", content: "not-an-array" }]);
  assert.strictEqual(badInner.envelope, "legacy");
  assert.strictEqual(badInner.blocks.length, 0, "包装块 content 不是数组时**不回落**到包装块本身");

  const nestedInvalid = extractToolResultContent([{ type: "tool-result", content: [null, { type: "text", text: "t" }] }]);
  assert.strictEqual(nestedInvalid.blocks.length, 2, "内层不合法成员照样计数");
  assert.strictEqual(blockKindOf(nestedInvalid.blocks[0]), "invalid");
}

// ── 2. 结果统计：分子分母 ────────────────────────────────────────────────

{
  // 同一份内容分别以现代 / 旧信封到达：四项统计**必须相等**（D01 的正确预期）。
  const stats = newToolResultStats();
  addToolResult(stats, INNER);
  addToolResult(stats, [{ type: "tool-result", callId: "legacy", content: INNER }]);
  assert.strictEqual(stats.results, 2, "结果总数 2");
  assert.strictEqual(stats.modern, 1);
  assert.strictEqual(stats.legacy, 1);
  assert.strictEqual(stats.multiblock, 2, "多块结果：两种信封都算 2（旧信封不能只按外层单块算）");
  assert.strictEqual(stats.withImage, 2, "含图片：两种信封都算 2");
  assert.strictEqual(stats.jsonParsed, 2, "JSON 解析成功 2");
  assert.strictEqual(stats.jsonObject, 2, "JSON 对象 2");
  assert.strictEqual(stats.jsonArray, 0, "JSON 数组 0");
  assert.strictEqual(stats.jsonInvalid, 0, "没有解析失败");
  assert.strictEqual(stats.notJsonText, 0);
  assert.strictEqual(stats.depths.get("3"), 2, "深度 3（{nested:{key:[1]}}）两条");
}

{
  const stats = newToolResultStats();
  addToolResult(stats, [{ type: "text", text: '[{"a":1}]' }]);
  assert.strictEqual(stats.jsonParsed, 1);
  assert.strictEqual(stats.jsonArray, 1, "数组单独计，不能混进「JSON 对象」");
  assert.strictEqual(stats.jsonObject, 0);
  assert.strictEqual(stats.depths.get("2（一层嵌套）"), 1, "[{a:1}] 深度 2");
}

{
  const stats = newToolResultStats();
  addToolResult(stats, [{ type: "text", text: "{ 这不是 JSON" }]);
  assert.strictEqual(stats.jsonCandidates, 1, "以 { 开头 = JSON 候选");
  assert.strictEqual(stats.jsonParsed, 0, "解析失败不算 JSON 样本");
  assert.strictEqual(stats.jsonInvalid, 1, "解析失败单独一档");
  assert.strictEqual(stats.jsonObject, 0);
  assert.strictEqual(stats.jsonArray, 0);
  assert.strictEqual(stats.depths.size, 0, "解析失败不进深度分布");
}

{
  const stats = newToolResultStats();
  addToolResult(stats, [{ type: "image", attachment: { name: "only-image" } }]);
  addToolResult(stats, [{ type: "text", text: "   " }]);
  addToolResult(stats, [{ type: "text", text: "纯文本" }, { type: "weird" }]);
  assert.strictEqual(stats.nonTextOnly, 1, "只有非 text 块的结果单独一档");
  assert.strictEqual(stats.textBearing, 2);
  assert.strictEqual(stats.notJsonText, 3, "空正文（无 text 块 / 空白 / 纯文本）都不是 JSON 候选");
  assert.strictEqual(stats.jsonCandidates, 0);
  assert.strictEqual(stats.jsonParsed, 0);
  assert.strictEqual(stats.blocks.unknown, 1, "未知种类块进普查");
  assert.strictEqual(stats.blocks.image, 1);
  assert.strictEqual(stats.emptyContent, 0);
}

{
  const stats = newToolResultStats();
  addToolResult(stats, undefined);
  addToolResult(stats, []);
  addToolResult(stats, [{ type: "tool-result", content: [] }]);
  assert.strictEqual(stats.results, 3);
  assert.strictEqual(stats.absent, 1);
  assert.strictEqual(stats.emptyContent, 3, "无内容字段 / 空数组 / 旧信封空内层都算「一个内容块都没有」");
  assert.strictEqual(stats.multiblock, 0);
  assert.strictEqual(stats.withImage, 0);
}

// ── 3. 正文 / 深度 / 容器字段 ────────────────────────────────────────────

{
  const text = resultTextOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]);
  assert.strictEqual(text.text, "a\nb", "非 text 块不进正文");
  assert.strictEqual(text.textBlocks, 2);
  assert.strictEqual(text.nonTextBlocks, 1);

  assert.strictEqual(depthOf(1), 0);
  assert.strictEqual(depthOf({ a: 1 }), 1);
  assert.strictEqual(depthOf({ a: { b: 1 } }), 2);
  assert.strictEqual(depthOf({ nested: { key: [1] } }), 3);
  assert.strictEqual(depthOf([]), 1, "空容器算 1");
  assert.strictEqual(containerFieldsOf({ a: { b: 1 }, c: [1], d: "s" }), 2, "只有对象/数组算容器字段");
  assert.strictEqual(containerFieldsOf([1, 2]), 0, "数组本身不是「顶层容器字段」");

  assert.strictEqual(looksJson("  {\"a\":1} "), true, "trim 后判前缀");
  assert.strictEqual(looksJson("plain"), false);
  assert.strictEqual(looksJson(undefined), false);
  const parsed = parseJsonContainer('{"a":{"b":1}}');
  assert.ok(parsed !== undefined);
  assert.strictEqual(parsed.kind, "object");
  assert.strictEqual(parsed.depth, 2);
  assert.strictEqual(parsed.containers, 1);
  assert.strictEqual(jsonShapeOf("{oops"), undefined, "解析失败没有形状");
  assert.strictEqual(jsonShapeOf("42"), undefined, "不以 { 或 [ 开头不是候选");

  const depths = new Map<string, number>();
  bucketDepth(depths, 0);
  bucketDepth(depths, 1);
  bucketDepth(depths, 4);
  assert.strictEqual(depths.get("0（标量）"), 1);
  assert.strictEqual(depths.get("1（扁平对象）"), 1);
  assert.strictEqual(depths.get("≥4"), 1);
}

// ── 3b. 合法大尺度 JSON：宽度与深度都不许退化成 JS 调用栈／参数上限 ──────
//
// 为什么单列一节：深度遍历的旧写法是 `Math.max(...value.map(depthOf))`（递归 + 展开），
// 于是**合法**数据会被判成「算不出来」——20 万成员的扁平数组深度本来就是 1，却因为把
// 20 万个实参展开进调用栈而抛 `Maximum call stack size exceeded`；2 万层的合法 JSON
// 数组同样在递归里撞栈。这类红线不是「这段正文不是 JSON」：栈溢出被折成 `undefined`
// 就是把合法样本静默丢出分母（`parseJsonContainer` 的解析失败档会因此虚高）。
//
// 统计必须可解释成 O(nodes)：时间与空间都只随节点数走，不用任何「深度上限」把合法深度
// 吞掉，也不用递归。脚手架**不递归造深数据**：文本直接 `repeat` 出来交给原生 `JSON.parse`
// （`JSON.stringify` 造 2 万层会先在脚手架里撞栈）。

{
  // A 宽度：20 万成员的合法数组，深度仍是 1。
  const wide = Array.from({ length: 200000 }, (_, index) => index);
  assert.strictEqual(depthOf(wide), 1, "20 万成员数组的深度是 1（宽度不是深度）");
  assert.strictEqual(jsonShapeOf(JSON.stringify(wide))?.depth, 1, "同一份正文走解析路径也是 1");
  assert.strictEqual(containerFieldsOf(wide), 0, "数组本身没有「顶层容器字段」");
}

{
  // B 深度：2 万层合法 JSON 数组，逐层精确计量（任何 cap 都会在这条上露馅）。
  const deepText = "[".repeat(20000) + "0" + "]".repeat(20000);
  assert.strictEqual(depthOf(JSON.parse(deepText)), 20000, "2 万层逐层精确，不能被任意上限截断");
  const deepShape = jsonShapeOf(deepText);
  assert.ok(deepShape !== undefined, "合法 JSON 必须解析成功（栈溢出不得被当成「不是 JSON」）");
  assert.strictEqual(deepShape.depth, 20000);
  assert.strictEqual(deepShape.kind, "array");
  assert.strictEqual(deepShape.containers, 0);
  assert.strictEqual(parseJsonContainer(deepText)?.depth, 20000);
}

{
  // B2 深度走**对象**路径：2 万层合法对象同样精确（两条容器分支各自覆盖）。
  const deepObjectText = '{"k":'.repeat(20000) + "0" + "}".repeat(20000);
  const deepObject = jsonShapeOf(deepObjectText);
  assert.ok(deepObject !== undefined, "2 万层合法对象必须解析成功");
  assert.strictEqual(deepObject.depth, 20000);
  assert.strictEqual(deepObject.kind, "object");
}

{
  // C 宽 + 深同时出现，仍按节点数算完（既不递归也不展开实参）。
  const mixedText = `[${"[".repeat(5000)}0${"]".repeat(5000)},${"[1,2,3],".repeat(50000)}0]`;
  const mixed = jsonShapeOf(mixedText);
  assert.ok(mixed !== undefined, "宽深混合的合法 JSON 必须解析成功");
  assert.strictEqual(mixed.depth, 5001, "最深一支 5000 层 + 外层 = 5001");
  assert.strictEqual(mixed.containers, 0);
}

{
  // 深度语义的三条边：标量 0 / 空容器 1 / 容器层数 = 1 + 最深子节点（与上面的既有口径一致）。
  assert.strictEqual(depthOf(null), 0, "null 是标量");
  assert.strictEqual(depthOf("s"), 0);
  assert.strictEqual(depthOf({}), 1, "空对象 1");
  assert.strictEqual(depthOf([[]]), 2, "空数组套一层按容器层数算");
  assert.strictEqual(depthOf({ a: [] }), 2);
  assert.strictEqual(depthOf([{ a: [1] }]), 3);
}

// ── 4. 对拍计量 ──────────────────────────────────────────────────────────

{
  const fresh = new ComparisonTally();
  assert.deepStrictEqual(fresh.counts, { expected: 0, compared: 0, missing: 0, mismatched: 0, gaps: 0 });
  assert.strictEqual(fresh.verdict(), PROBE_EXIT.zeroSample, "零样本不能算通过");
  assert.strictEqual(fresh.verdict(), 3);
}

{
  const tally = new ComparisonTally();
  tally.expect(2);
  tally.compare();
  tally.miss("账本没有该 seq 的助手记录（来源无法折出）");
  assert.deepStrictEqual(tally.counts, { expected: 2, compared: 1, missing: 1, mismatched: 0, gaps: 0 });
  assert.strictEqual(tally.verdict(), PROBE_EXIT.missing, "有缺失即使错配 0 也不得算通过");
  assert.strictEqual(tally.counts.mismatched, 0, "缺的不是错配，两档必须分开");
  assert.deepStrictEqual(tally.missingByReason, [{ reason: "账本没有该 seq 的助手记录（来源无法折出）", count: 1 }]);
  tally.miss("同一 seq 的助手事件多于账本记录（无法逐一配对）", 2);
  assert.deepStrictEqual(
    tally.missingByReason.map((entry) => entry.count),
    [2, 1],
    "缺失按原因聚合、按条数降序",
  );
  assert.strictEqual(tally.counts.missing, 3);
}

{
  const tally = new ComparisonTally();
  tally.expect(1);
  tally.compare();
  tally.mismatch();
  assert.strictEqual(tally.verdict(), PROBE_EXIT.mismatched, "错配优先于缺失与覆盖缺口");

  const gapOnly = new ComparisonTally();
  gapOnly.expect(1);
  gapOnly.compare();
  gapOnly.gap("会话日志解码失败");
  assert.deepStrictEqual(gapOnly.counts, { expected: 1, compared: 1, missing: 0, mismatched: 0, gaps: 1 });
  assert.strictEqual(gapOnly.verdict(), PROBE_EXIT.coverage, "输入覆盖缺口不得宣告全量一致");
  assert.deepStrictEqual(gapOnly.gapsByReason, [{ reason: "会话日志解码失败", count: 1 }]);

  const gapNoSample = new ComparisonTally();
  gapNoSample.gap("会话日志没有可解析的合法事件行");
  assert.strictEqual(gapNoSample.verdict(), PROBE_EXIT.zeroSample, "零样本优先于覆盖缺口：都是「没结论」");

  // 会话级**观察**（读得到、没有可比内容）与输入缺口分开：它只报告，不改变判定。
  const noted = new ComparisonTally();
  noted.expect(1);
  noted.compare();
  noted.note("会话里没有 assistant/message（没有可比对的样本）", 2);
  assert.strictEqual(noted.verdict(), PROBE_EXIT.aligned, "观察不参与判定，避免得到随数据漂的假防线");
  assert.deepStrictEqual(
    noted.notesByReason,
    [{ reason: "会话里没有 assistant/message（没有可比对的样本）", count: 2 }],
  );
  assert.deepStrictEqual(noted.gapsByReason, [], "观察不进输入缺口那一档");
}

{
  const tally = new ComparisonTally();
  tally.declareCompared("助手行分类标签", "只比两档分类");
  tally.declareUncompared("行文本逐字", "只比分类，不逐字比预览截断");
  assert.deepStrictEqual(tally.comparedFields, [{ field: "助手行分类标签", reason: "只比两档分类" }]);
  assert.deepStrictEqual(tally.uncomparedFields, [{ field: "行文本逐字", reason: "只比分类，不逐字比预览截断" }]);
}

{
  const codes = [
    PROBE_EXIT.aligned,
    PROBE_EXIT.mismatched,
    PROBE_EXIT.missing,
    PROBE_EXIT.zeroSample,
    PROBE_EXIT.coverage,
    PROBE_EXIT.usage,
  ];
  assert.strictEqual(new Set(codes).size, codes.length, "六个退出码必须互不相同");
  assert.deepStrictEqual(codes, [0, 1, 2, 3, 4, 5]);
  for (const code of codes) assert.notStrictEqual(verdictText(code), "", `退出码 ${code} 必须有说明`);
  assert.notStrictEqual(verdictText(99), "", "未知判定也要有兜底文案");
}

// ── 5. 命令行参数：受控来源与参数错误 ────────────────────────────────────

{
  const defaults = parseProbeArgs([]);
  assert.ok(defaults.ok);
  assert.strictEqual(defaults.args.sources, null, "没给 --source 就是默认扫描模式");
  assert.strictEqual(defaults.args.limit, Number.POSITIVE_INFINITY, "默认不截断「最近 n 份」");
  assert.strictEqual(defaults.args.verbose, false);

  const one = parseProbeArgs(["--source", "a/session.v4.jsonl.zstd"]);
  assert.ok(one.ok);
  assert.deepStrictEqual(one.args.sources, ["a/session.v4.jsonl.zstd"], "受控来源按命令行顺序");
  assert.strictEqual(one.args.limit, Number.POSITIVE_INFINITY);

  const repeatable = parseProbeArgs(["--source", "a.jsonl", "--source", "b.jsonl"]);
  assert.ok(repeatable.ok);
  assert.deepStrictEqual(repeatable.args.sources, ["a.jsonl", "b.jsonl"], "--source 可重复");

  // 同一份文件的两种写法归一化后是同一个路径 → 参数错误（重复来源会让分母虚高，
  // 而「算了两遍」在汇总输出里看不出来）。两种写法的**字符串必须不同**，否则测的是
  // 「同一个字符串出现两次」，归一化那一层没被覆盖。
  const firstSpelling = join("root", "x.jsonl");
  const secondSpelling = "root/sub/../x.jsonl";
  assert.notStrictEqual(firstSpelling, secondSpelling, "两种写法必须字符串不同");
  const duplicate = parseProbeArgs(["--source", firstSpelling, "--source", secondSpelling]);
  assert.ok(!duplicate.ok);
  assert.strictEqual(duplicate.error.code, "duplicate-source");
  assert.strictEqual(duplicate.error.position, 3, "报第二次出现的位置");

  const withLimit = parseProbeArgs(["--limit", "60"]);
  assert.ok(withLimit.ok);
  assert.strictEqual(withLimit.args.limit, 60);
  assert.strictEqual(withLimit.args.sources, null);

  // `--verbose` 只在声明的 CLI 上合法：Gap 不印错配样本，收到它就是未知选项。
  const verbose = parseProbeArgs(["--verbose"], { allowVerbose: true });
  assert.ok(verbose.ok);
  assert.strictEqual(verbose.args.verbose, true);
  const verboseRejected = parseProbeArgs(["--verbose"]);
  assert.ok(!verboseRejected.ok);
  assert.strictEqual(verboseRejected.error.code, "unknown-option");

  const rejected: [string[], ProbeArgErrorCode][] = [
    [["--nope"], "unknown-option"],
    [["--source"], "missing-value"],
    [["--source", "--limit", "5"], "missing-value"],
    [["--source", ""], "missing-value"],
    [["--limit"], "missing-value"],
    [["--limit", "0"], "invalid-limit"],
    [["--limit", "-3"], "invalid-limit"],
    [["--limit", "1.5"], "invalid-limit"],
    [["--limit", "1e3"], "invalid-limit"],
    [["--limit", "007"], "invalid-limit"],
    [["--limit", "abc"], "invalid-limit"],
    [["--limit", String(Number.MAX_SAFE_INTEGER + 1)], "invalid-limit"],
    [["--source", "a.jsonl", "--limit", "5"], "limit-with-source"],
    [["--limit", "5", "--source", "a.jsonl"], "limit-with-source"],
  ];
  for (const [argv, code] of rejected) {
    const result = parseProbeArgs(argv);
    assert.ok(!result.ok, `必须失败：${argv.join(" ")}`);
    assert.strictEqual(result.error.code, code, `错误码不符：${argv.join(" ")}`);
  }

  // 出错位置是 1 起的参数序号；**解析器不保留参数原文**（它可能是路径或秘密）。
  const missingAtEnd = parseProbeArgs(["--source", "a.jsonl", "--limit"]);
  assert.ok(!missingAtEnd.ok);
  assert.strictEqual(missingAtEnd.error.position, 3);
  assert.ok(!("value" in missingAtEnd.error), "错误对象里不得回显参数值");
}

{
  assert.strictEqual(PROBE_ARG_ERRORS.length, 5);
  assert.strictEqual(new Set(PROBE_ARG_ERRORS).size, PROBE_ARG_ERRORS.length, "错误码互不相同");
  for (const code of PROBE_ARG_ERRORS) assert.ok(/^[a-z-]+$/.test(code), `语言中立的稳定错误码：${code}`);
}

console.log("trajectoryProbeFacts.test.ts: 全部断言通过");
