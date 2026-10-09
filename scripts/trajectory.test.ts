/**
 * 「轨迹」宿主侧折叠（`src/dsh/trajectory.ts`）的离线断言。
 *
 * 钉的是官方账本最容易折错、折错了在界面上又看不太出来的地方：
 * 记录种类的判定（用户 vs 上下文）、工具调用与结果的**配对**、压缩的生命周期、
 * 序号连续性、轮次分组（含 turn 0 并进下一组的 prologue 规则）、请求编号。
 *
 * 夹具是**手写的 wire 形状事件**（字段名逐个对着
 * `dsh-session` / `dsh-compaction` / `dsh-tools` 的 `.d.ts` 抄），
 * 不是按扩展内部形状编的——折叠的输入就是这些原始事件。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionWireEvent } from "../src/dsh/protocol";
import { deriveTrajectoryModel, trajectorySummary } from "../src/dsh/trajectory";
import { TRAJECTORY_COMPACTION_INTERRUPTED, trajectoryDomainPosition, trajectoryScreenFraction, trajectoryTurnCells } from "../src/shared/trajectory";
import type { TrajectoryCell, TrajectoryGroup, TrajectoryModel, TrajectoryTurn } from "../src/shared/trajectory";
import { trajectoryCellContent } from "../src/webview/trajectoryDisplay";
import {
  createTrajectoryInteraction,
  EDGE_PAN_STEP_FRACTION,
  EDGE_PAN_ZONE_FRACTION,
  MAXIMUM_EDGE_PAN_PX,
} from "../src/webview/trajectoryInteraction";
import type { TrajectoryInteraction } from "../src/webview/trajectoryInteraction";
import { trajectoryTexts } from "../src/webview/trajectoryTexts";
import { deriveTrajectoryTimeline } from "../src/webview/trajectoryTimeline";

const texts = trajectoryTexts("zh-cn");

/**
 * 端口当前那次滚动请求的目标行号（`undefined` = 没有请求）。
 *
 * 为什么经函数取而不是直接读属性：`assert.strictEqual(port.state.reveal, null, …)` 在
 * `@types/node` 里是**断言签名**，会把 `port.state.reveal` 窄化成 `null`；同一个变量随后
 * 再读 `state.reveal?.index` 就被判成 `never`（本文件开 tsconfig 后实测）。
 */
function revealIndexOf(port: TrajectoryInteraction): number | undefined {
  return port.state.reveal?.index;
}

let seq = 0;
const at = (offset: number) => 1_700_000_000_000 + offset * 1000;
const event = (type: string, data: Record<string, unknown>, offset = seq): SessionWireEvent => {
  seq += 1;
  return { type, seq: seq - 1, time: at(offset), data };
};
const block = (text: string) => [{ type: "text", text }];
const message = (text: string, source: Record<string, unknown>) => ({
  id: `m${seq}`,
  role: "user",
  content: block(text),
  source,
});
/**
 * 手搭一轮账本。时间线的输入只读 `groups[].cells`（组标题在这一层没有意义），
 * 所以这里一律塞进一个消息组。
 */
const turnOf = (turn: number | null, cells: TrajectoryCell[]): TrajectoryTurn => ({
  turn,
  groups: [{ title: { kind: "message" }, cells }],
});
/**
 * `user/message` 的**线格式**：data 就是 UserMessage 本身
 * （`dsh-session`：`'user/message': UserMessage`），**不是** `{message}` 包一层
 * ——包一层的是 `system/message` / `tool/result`。
 *
 * 这个坑真的踩过（用户 2026-09-14 报「用户消息与上下文节点都不出现在轨迹里」）：
 * 折叠按 `data.message` 读，`kind`/`text` 全空 → 整条被丢掉。断言夹具原先也照
 * 错的形状编（`{message}`），两边一起错才没被测试抓住——所以这里专门写个
 * `userMessage()` 把线格式钉住，并在下面第 2 组里显式断言。
 */
const userMessage = (text: string, source: Record<string, unknown>) => message(text, source);

// ---------- 1. 一个完整轮次：系统 → 用户 → 助手 → 工具 → 子工具 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: message("你是 DSH。", { kind: "system" }) }, 0),
    event("user/message", message("帮我看看这个文件", { kind: "user" }), 1),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "read" }] }, reason: "initial" }, 1),
    event("assistant/message", { turn: 0, step: 0, message: message("我看看。", { model: "m" }), usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }, 2),
    event("tool/call", { turn: 0, step: 0, callId: "c1", name: "read", arguments: '{"file_path":"a.ts"}' }, 3),
    event("tool/result", { turn: 0, step: 0, message: { content: block("export {}"), source: { callId: "c1" } } }, 4),
    event("tool/ptc-dispatch-start", { rootCallId: "c1", parentCallId: "c1", subCallId: "c1:ptc:1", name: "grep", arguments: { pattern: "x" } }, 4),
    event("tool/ptc-dispatch", { rootCallId: "c1", parentCallId: "c1", subCallId: "c1:ptc:1", name: "grep", arguments: { pattern: "x" }, isError: false, content: block("a.ts:1") }, 5),
    event("turn/end", { turn: 0, reason: "success" }, 5),
  ];
  const model = deriveTrajectoryModel(events, false);
  const kinds = model.turns.flatMap((turn) => trajectoryTurnCells(turn).map((cell) => cell.kind));
  assert.deepStrictEqual(
    kinds,
    ["system", "user", "message", "tool", "subtool"],
    "七种记录里的五种按事件顺序出现（压缩那两种在下一组测）",
  );
  const cells = model.turns.flatMap(trajectoryTurnCells);
  assert.deepStrictEqual(
    cells.map((cell) => cell.index),
    [1, 2, 3, 4, 5],
    "序号从 1 连续（官方 `#N` 直接用它）",
  );
  // 系统行：正文来自 system/message，工具目录/提供方来自 request/header
  assert.strictEqual(cells[0].systemPromptDetail, "你是 DSH。");
  assert.strictEqual(cells[0].provider, "p");
  assert.deepStrictEqual(cells[0].toolsDetail?.map((tool) => tool.name), ["read"]);
  // 用户行：opensTurn + 来源 + 请求编号
  assert.strictEqual(cells[1].opensTurn, true);
  assert.strictEqual(cells[1].previewMarkdown, "帮我看看这个文件", "正文进 previewMarkdown（列表显示它的预览）");
  assert.strictEqual(cells[1].requestNumber, 1);
  // 助手行：用量按线格式字段名读（inputTokens/cacheReadTokens），不是视图模型的字段
  assert.strictEqual(cells[2].usage?.input, 10);
  assert.strictEqual(cells[2].usage?.cacheRead, 3);
  assert.strictEqual(cells[2].usage?.output, 5);
  assert.strictEqual(cells[2].assistantMetrics?.usageProvided, true);
  // 工具行：call 与 result 合成**一条**（不是两条），有结果、有耗时、状态 complete
  assert.strictEqual(cells[3].callId, "c1");
  assert.strictEqual(cells[3].toolName, "read");
  assert.strictEqual(cells[3].status, "complete");
  // 官方 `summarizeCall()` / `summarizeResult()`：工具名进 `text`、参数进
  // `previewMarkdown`，结果那栏是**原始 Markdown**（`resultPreviewMarkdown`），
  // 不是宿主截好的摘要——截断口径在界面侧（`trajectoryDisplay.ts`）。
  assert.strictEqual(cells[3].text, "read");
  assert.strictEqual(cells[3].previewMarkdown, '{"file_path":"a.ts"}');
  assert.strictEqual(cells[3].resultPreviewMarkdown, "export {}");
  assert.strictEqual(cells[3].result, undefined, "有正文时 result 留空（官方同口径）");
  assert.strictEqual(cells[3].timeSeconds, 1, "调用到结果之间 1 秒");
  // 子工具行：独立一条，kind 是 subtool
  assert.strictEqual(cells[4].toolName, "grep");
  assert.strictEqual(cells[4].status, "complete");
  assert.strictEqual(cells[4].resultPreviewMarkdown, "a.ts:1");
  assert.strictEqual(model.cellCount, 5);
}
console.log("trajectory: 完整轮次的账本折叠 ✓");

// ---------- 2. 用户 vs 上下文：按 `source.kind` 分派 ----------
//
// **线格式**：`user/message` 的 data 就是消息本身（`{id, role, content, source}`），
// 不是 `{message}`。夹具曾经按 `{message}` 编，折叠也按 `data.message` 读，于是
// 两边一起错、测试全绿，而真机上「用户消息 + 上下文节点」整类消失。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("user/message", userMessage("插件注入的上下文", { kind: "plugin", plugin: "dsh-goal" }), 0),
    event("user/message", userMessage("人类说的话", { kind: "user" }), 1),
    event("user/message", userMessage("RPC 发的话", { kind: "user-rpc" }), 2),
    event("turn/end", { turn: 0, reason: "success" }, 2),
  ];
  // 夹具自检：data 必须是消息本身（有 content/source，没有被 message 包一层）
  const sample = events[1].data as Record<string, unknown>;
  assert.strictEqual(sample.message, undefined, "user/message 的 data 不许是 {message} 包装");
  assert.ok(Array.isArray(sample.content), "user/message 的 data 自己就带 content");

  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  assert.deepStrictEqual(
    cells.map((cell) => cell.kind),
    ["context", "user", "user"],
    "插件注入 → context；`user` / `user-rpc` → user（官方只把这两种算人的话）",
  );
  assert.strictEqual(cells.length, 3, "三类来源各出一条记录——一条都不许被吞掉");
  assert.strictEqual(cells[0].messageSource?.plugin, "dsh-goal");
  assert.strictEqual(cells[0].opensTurn, undefined, "上下文注入不开启轮次");
  // 官方 `inputCellDetail()`：`text` 只放附件摘要（本地化，故宿主只给计数），
  // 正文进 `previewMarkdown`，全部文本块进 `inputDetail`。从前 `text` 是宿主截的
  // 160 字首行、`previewMarkdown` 又是同一段全文，界面拼出来正文出现两遍。
  assert.strictEqual(cells[0].text, "", "行文本不再由宿主预截");
  assert.strictEqual(cells[0].previewMarkdown, "插件注入的上下文");
  assert.strictEqual(cells[0].inputDetail, "插件注入的上下文");
  assert.strictEqual(cells[0].attachments, undefined, "没有附件时不给附件摘要");
  assert.strictEqual(cells[1].opensTurn, true);
}
console.log("trajectory: context 与 user 的分派 ✓");

// ---------- 3. 压缩的生命周期（start → summary → end） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("compaction/start", { compactionId: "k1", turn: 0 }, 0),
    event("compaction/summary", { compactionId: "k1", summary: block("摘要正文"), rawOutput: [...block("模型原始输出"), { type: "reasoning", text: "思考片段" }], provider: "p", model: "m", usage: { inputTokens: 7, outputTokens: 2 } }, 1),
    event("compaction/end", { compactionId: "k1", turn: 0 }, 2),
    event("turn/end", { turn: 0, reason: "success" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  assert.strictEqual(cells.length, 1, "一条压缩 = 一条记录（不是三条）");
  assert.strictEqual(cells[0].kind, "compacted");
  assert.strictEqual(cells[0].status, "complete");
  assert.strictEqual(cells[0].outputDetail, "摘要正文");
  assert.strictEqual(cells[0].inputDetail, "模型原始输出", "rawOutput 进「原始输出」页签");
  // 官方 `detailReasoning(rawOutput ?? summary)`：思考块**单独**进 thinkingDetail，
  // 「原始输出」里不留它（`blocksToText` 本来就跳过 reasoning 块）。
  assert.strictEqual(cells[0].thinkingDetail, "思考片段", "rawOutput 的 reasoning 块进「思考」");
  assert.strictEqual(cells[0].provider, "p");
  assert.strictEqual(cells[0].usage?.input, 7);
  assert.strictEqual(cells[0].timeSeconds, 2);
  assert.strictEqual(cells[0].requestNumber, 1, "压缩也是一次请求");
}
// 压缩失败 → status error + error 文案
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("compaction/start", { compactionId: "k1", turn: 0 }, 0),
    event("compaction/end", { compactionId: "k1", turn: 0, error: "boom" }, 1),
    event("turn/end", { turn: 0, reason: "success" }, 1),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  assert.strictEqual(cells[0].status, "error");
  assert.strictEqual(cells[0].error, "boom");
  assert.strictEqual(cells[0].thinkingDetail, undefined, "拿不到 summary / rawOutput 就不合成「思考」");
}
console.log("trajectory: 压缩的生命周期 ✓");

// ---------- 4. 系统提示词的更新（出第二行 + 带上一次的内容） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: message("第一版提示词", { kind: "system" }) }, 0),
    event("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 0),
    event("user/message", message("你好", { kind: "user" }), 1),
    event("assistant/message", { turn: 0, step: 0, message: message("在", {}) }, 1),
    // 第二轮：系统提示词变了（历史内更新）→ 官方在账本里再出一行 SYSTEM
    event("turn/end", { turn: 0, reason: "success" }, 2),
    event("turn/start", { turn: 1 }, 2),
    event("step/start", { turn: 1, step: 0 }, 2),
    event("system/message", { turn: 1, step: 0, message: message("第二版提示词", { kind: "system" }) }, 2),
    event("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "change" }, 2),
    event("user/message", message("再来", { kind: "user" }), 3),
    event("assistant/message", { turn: 1, step: 0, message: message("好", {}) }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  const systems = cells.filter((cell) => cell.kind === "system");
  assert.strictEqual(systems.length, 2, "初始一行 + 更新一行");
  assert.strictEqual(systems[0].systemPromptDetail, "第一版提示词");
  assert.strictEqual(systems[0].previousSystemPromptDetail, undefined);
  assert.strictEqual(systems[1].systemPromptDetail, "第二版提示词");
  assert.strictEqual(systems[1].previousSystemPromptDetail, "第一版提示词", "差异页签要能对照上一版");
  assert.strictEqual(
    systems[0].previousPromptTools,
    undefined,
    "初始那一行没有被替换掉的工具目录（差异页签的「工具」那节因此不出）",
  );
}
console.log("trajectory: 系统提示词的更新 ✓");

// ---------- 4b. 被替换掉的那一份工具目录（差异页签「工具」那一节的对照物） ----------
//
// 少了它，界面只能拿改动前的 system 去比改动后的 tools——那是错的对照，
// 而错的对照在界面上看不出来（两边都是真数据，只是不是同一时刻的）。
{
  seq = 0;
  const read = { name: "read", description: "读文件" };
  const grep = { name: "grep", description: "搜索" };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: message("提示词", { kind: "system" }) }, 0),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [read] }, reason: "initial" }, 0),
    event("assistant/message", { turn: 0, step: 0, message: message("在", {}) }, 1),
    // 第二轮：**只有工具目录变了**（提示词一字未动）→ 同样出一行 SYSTEM
    event("turn/end", { turn: 0, reason: "success" }, 2),
    event("turn/start", { turn: 1 }, 2),
    event("step/start", { turn: 1, step: 0 }, 2),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [read, grep] }, reason: "change" }, 2),
    event("assistant/message", { turn: 1, step: 0, message: message("好", {}) }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const systems = deriveTrajectoryModel(events, false)
    .turns.flatMap(trajectoryTurnCells)
    .filter((cell) => cell.kind === "system");
  assert.strictEqual(systems.length, 2, "工具目录变了也要出一行（官方逐字比 JSON 的判据）");
  assert.strictEqual(systems[1].promptChange, "tools", "这一行的原因只有工具变化");
  assert.deepStrictEqual(
    systems[1].previousPromptTools,
    [read],
    "记下**被替换掉的那一份**目录（差异页签「工具」那一节的 before）",
  );
  assert.deepStrictEqual(systems[1].toolsDetail, [read, grep], "这一行生效的是新目录（after）");
  /**
   * 提示词一字未动，但宿主**仍然带上**了「上一次的正文」——折叠层记的是「上一次见过的
   * system 文本」，不是「上一次真的变过的那一版」。所以界面上「系统提示词」那一节会拿到
   * **两段完全相同**的文本；它由 `PromptDiffSection` 的 `lines.length === 0 → null` 兜住
   * （那一节整节不渲染），断言在 `scripts/trajectoryPromptDiff.test.ts`。
   *
   * 这正是「工具目录那一节必须有**两份**目录才出」的同一条口径：宁可少出一节，
   * 也不拿不同时刻的两样东西拼一份对照。
   */
  assert.strictEqual(
    systems[0].previousSystemPromptDetail,
    undefined,
    "初始那一行没有被替换掉的提示词",
  );
  assert.strictEqual(
    systems[1].previousSystemPromptDetail,
    "提示词",
    "宿主带上一次正文；两段相同时那一节由差分层拦掉（不是靠这里少给字段）",
  );
}
console.log("trajectory: 被替换掉的工具目录（差异页签的 before） ✓");

// ---------- 5. 轮次分组：turn 0 的 prologue 并进下一组 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    // turn 0：只有系统提示词（没有用户消息），官方把它并进 turn 1
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: message("提示词", { kind: "system" }) }, 0),
    event("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 0),
    event("turn/end", { turn: 0, reason: "success" }, 1),
    event("turn/start", { turn: 1 }, 1),
    event("step/start", { turn: 1, step: 0 }, 1),
    event("user/message", message("第一句人话", { kind: "user" }), 1),
    event("assistant/message", { turn: 1, step: 0, message: message("答", {}) }, 2),
    event("turn/end", { turn: 1, reason: "success" }, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  assert.strictEqual(model.turns.length, 1, "turn 0 整段并进 turn 1，不出现两个「第 1 轮」");
  assert.strictEqual(model.turns[0].turn, 1);
  assert.deepStrictEqual(
    trajectoryTurnCells(model.turns[0]).map((cell) => cell.kind),
    ["system", "user", "message"],
  );
  /**
   * 初始 system 行归 `firstVisibleTurn()`（助手记录里最小的大于 0 的轮次）之后就落在第 1 轮，
   * 于是 turn 0 里**一个记录都没有**——官方那一支同样不会有 turn 0 段（`turn/start` /
   * `step/start` / `turn/end` 本身不出记录），prologue 的并组无从发生，三条记录共用
   * 第 1 轮的消息组。
   */
  assert.deepStrictEqual(
    model.turns[0].groups.map((group) => group.cells.map((cell) => cell.kind)),
    [["system", "user", "message"]],
    "初始提示词行与第 1 轮自己的记录同属一个消息组",
  );

  /**
   * 官方那条分支是**无条件**的（`layout.ts`：只要 `turns.get(0)` 存在就并进 turn 1），
   * 不看 turn 0 里有没有用户消息。本扩展从前多了一个「turn 0 无用户消息」的条件——
   * 那种输入下会分叉。真实服务端轮号从 1 起，所以这里只有构造出来的输入能验。
   */
  seq = 0;
  const withUser = deriveTrajectoryModel([
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", message("第 0 轮里就说话了", { kind: "user" }), 0),
    event("turn/end", { turn: 0, reason: "success" }, 0),
    event("turn/start", { turn: 1 }, 1),
    event("step/start", { turn: 1, step: 0 }, 1),
    event("assistant/message", { turn: 1, step: 0, message: message("答", {}) }, 2),
    event("turn/end", { turn: 1, reason: "success" }, 2),
  ], false);
  assert.strictEqual(
    withUser.turns.length,
    1,
    "turn 0 里有用户消息也照并（官方那一支是无条件的，不分叉）",
  );
  assert.strictEqual(withUser.turns[0].turn, 1);
  /**
   * 这一支里 turn 0 **有真记录**（用户消息）：官方那台布局把它整组拼在 turn 1 自己的组
   * **之前**（`first.groups = [...prologue.groups, ...first.groups]`），本扩展在**建组之前**
   * 把 turn 0 的记录改号成 1、按显示顺序建组。两种排法只在「事件自己带 turn 0」这种构造
   * 输入下不同（真实服务端轮号从 1 起，实测 377 份日志里含 0 号轮的是 0 份），本扩展保住的
   * 是「初始提示词永远是账本第一行、摊平顺序 = 显示序号」这条不变量——有出处的刻意差异，
   * 见设计文档的排序与合并规则。
   */
  assert.deepStrictEqual(
    trajectoryTurnCells(withUser.turns[0]).map((cell) => [cell.kind, cell.turn]),
    [["user", 1], ["message", 1]],
    "turn 0 的记录改号到第 1 轮，段内仍按显示顺序",
  );
}
console.log("trajectory: 轮次分组与 prologue 合并 ✓");

// ---------- 6. 轮次错误与重试都挂到该轮的助手行上 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", message("问", { kind: "user" }), 0),
    event("llm/retry", { turn: 0, step: 0, retry: 2, maxRetries: 5 }, 1),
    event("assistant/message", { turn: 0, step: 0, message: message("答", {}) }, 2),
    event("turn/end", { turn: 0, reason: "error" }, 3),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  const assistant = cells.find((cell) => cell.kind === "message");
  assert.deepStrictEqual(assistant?.retry, { attempt: 2, max: 5 }, "重试进度挂在该 step 的助手行上");
  assert.strictEqual(assistant?.error, "error", "非正常收尾的原因挂在该轮最后一条助手行上");
  assert.strictEqual(assistant?.status, "error");
}
// `max-tokens` 是「被输出上限截断」，**不是失败**：官方把它折成单独的节点而不是 error
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", message("问", { kind: "user" }), 0),
    event("assistant/message", { turn: 0, step: 0, message: message("半截", {}) }, 1),
    event("turn/end", { turn: 0, reason: "max-tokens" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  const assistant = cells.find((cell) => cell.kind === "message");
  assert.strictEqual(assistant?.error, undefined, "截断不画成失败");
  assert.strictEqual(assistant?.status, "complete");
}
console.log("trajectory: 重试与轮次错误 ✓");

// ---------- 6b. 还在跑的步骤出一行「正在生成」；被中断的旧步骤不臆造正文 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", message("问", { kind: "user" }), 0),
    // 这一步开了但**没有** assistant/message（被中断），随后 turn/end 收尾
    event("turn/end", { turn: 0, reason: "aborted" }, 1),
    // 新一轮已经开跑：这一步同样没有 assistant/message，但它是**当前**在跑的那一步
    event("turn/start", { turn: 1 }, 1),
    event("step/start", { turn: 1, step: 0 }, 1),
    event("tool/call", { turn: 1, step: 0, callId: "c1", name: "read", arguments: "{}" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  const running = cells.filter((cell) => cell.status === "running");
  assert.strictEqual(running.length, 2, "一行是运行中的助手占位，一行是未结算的工具");
  const placeholder = running.find((cell) => cell.kind === "message");
  assert.ok(placeholder, "运行中的助手占位要出（官方那是流式行）");
  assert.strictEqual(placeholder?.text, "", "正文留空（token 还没到，不编造）");
  assert.strictEqual(placeholder?.turn, 1, "只给**最后一次 turn/end 之后**开的步骤出行");
  assert.strictEqual(placeholder?.requestNumber, 2, "它是第二次请求");
  assert.strictEqual(
    cells.some((cell) => cell.turn === 0 && cell.kind === "message"),
    false,
    "被中断的旧步骤不出占位行（那一段正文官方由 assistant/attempt 还原，我们不臆造）",
  );
}
console.log("trajectory: 运行中的占位行 ✓");

// ---------- 7. 中断的助手消息 + 未结算的工具（运行中） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", message("问", { kind: "user" }), 0),
    event("assistant/message", { turn: 0, step: 0, message: message("半截", {}), interrupted: true }, 1),
    event("tool/call", { turn: 0, step: 0, callId: "c9", name: "bash", arguments: "{}" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, true).turns.flatMap(trajectoryTurnCells);
  assert.strictEqual(cells[1].status, "error");
  assert.strictEqual(cells[1].error, "@interrupted", "中断走界面词典的 @interrupted（不是服务端原始串）");
  assert.strictEqual(cells[2].status, "running", "只有调用没有结果 → 仍在运行，不是 complete");
  assert.strictEqual(cells[2].timeSeconds, null, "不知道结束时刻就给 null，不要拿 0 冒充");
  const model = deriveTrajectoryModel(events, true);
  assert.strictEqual(model.hasOlder, true, "hasOlder 要透传给界面（面板顶部的「加载更早」）");
}
console.log("trajectory: 中断与运行中的记录 ✓");

// ---------- 8. 单行摘要：压平空白 + 截断 ----------
{
  assert.strictEqual(trajectorySummary("  第一行\n第二行  "), "第一行 第二行");
  assert.strictEqual(trajectorySummary(""), "");
  assert.strictEqual(trajectorySummary("a".repeat(200)).length, 161, "160 字符 + 省略号");
}
console.log("trajectory: 单行摘要 ✓");

// ---------- 9. 时间线的投影（等宽 / 按耗时 / 按真实时刻） ----------
//
// 这一层现在**不是手抄的**：官方 `deriveTrajectoryTimeline` 已逐字 vendor 进
// `src/vendor/ui-trajectory/timeline.ts`，`src/webview/trajectoryTimeline.ts` 只做
// 「我们账本 → 官方形状」的适配 + 归一化（绝对域 → 0..1）。所以这里钉的是**接线**
// 与几条官方语义（并发不串行化、错误色只看 `isError`、缺时刻不进线）。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", message("问", { kind: "user" }), 0),
    event("assistant/message", { turn: 0, step: 0, message: message("答", {}) }, 2),
    event("tool/call", { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" }, 4),
    event("tool/result", { turn: 0, step: 0, message: { content: block("ok"), source: { callId: "c1" } } }, 5),
    event("turn/end", { turn: 0, reason: "success" }, 5),
  ];
  const turns = deriveTrajectoryModel(events, false).turns;
  const cells = turns.flatMap(trajectoryTurnCells);

  // 等宽：每条记录一格，与时间无关（官方默认）
  const sequence = deriveTrajectoryTimeline(turns, "sequence");
  assert.strictEqual(sequence.spans.length, cells.length, "每条记录都成条");
  assert.deepStrictEqual(
    sequence.spans.map((span) => [Math.round(span.left * 100), Math.round(span.width * 100)]),
    cells.map((_, index) => [Math.round((index / cells.length) * 100), Math.round(100 / cells.length)]),
    "等宽模式下位置只与序号有关",
  );
  // 泳道：用户 → 输入道(0)，助手 → 模型道(1)，工具 → 工具道(2)
  const laneOf = (kind: string) => sequence.spans.find((span) => span.kind === kind)?.lane;
  assert.strictEqual(laneOf("user"), 0);
  assert.strictEqual(laneOf("message"), 1);
  assert.strictEqual(laneOf("tool"), 2);

  // 按耗时：宽度与自身耗时成正比、且扣掉空闲（总宽 100%）
  const duration = deriveTrajectoryTimeline(turns, "duration");
  const totalWidth = duration.spans.reduce((sum, span) => sum + span.width, 0);
  assert.ok(Math.abs(totalWidth - 1) < 0.01, "扣掉空闲后所有条加起来正好铺满");
  const toolSpan = duration.spans.find((span) => span.kind === "tool");
  assert.ok((toolSpan?.width ?? 0) > 0, "有耗时的记录才有宽度");
  // 轮次边界必须与条用**同一套坐标**。这里曾经把原始 Unix 毫秒当域值除以压缩后的
  // 总时长（量级差 1e6 倍），界面的 `left < 0 || left > 1` 把每一根都丢掉——
  // 「时长」模式下概览条一根轮次分隔线都没有，而等宽 / 按真实时刻都正常。
  //
  // 轮号是 **1**（不是这组事件自己写的 0）：官方 prologue 把 turn 0 整段并入 turn 1
  // （`turns.get(0)` → `turns.set(1, …)`），本扩展同口径（见设计文档的排序与合并规则）；
  // 真实服务端轮号从 1 起，事件带 turn 0 只是构造输入。
  assert.deepStrictEqual(
    duration.boundaries,
    [{ turn: 1, left: 0 }],
    "「时长」模式也要出轮次边界，且位置落在域内（0..1）",
  );

  // 两轮各一条记录（1 秒 / 3 秒）：第二轮边界落在第一条结束的位置（域 0.25）
  const twoTurn = [
    turnOf(0, [{ ...cells[0], index: 1, kind: "message" as const, turn: 0, startedAt: at(0), timeSeconds: 1 }]),
    turnOf(1, [{ ...cells[0], index: 2, kind: "message" as const, turn: 1, startedAt: at(2), timeSeconds: 3 }]),
  ];
  assert.deepStrictEqual(
    deriveTrajectoryTimeline(twoTurn, "duration").boundaries,
    [
      { turn: 0, left: 0 },
      { turn: 1, left: 0.25 },
    ],
    "轮次边界与条同一套域坐标（扣掉空闲之后的位置）",
  );

  // 按真实时刻：位置体现空闲（工具比助手晚开始）
  const time = deriveTrajectoryTimeline(turns, "time");
  const userAt = time.spans.find((span) => span.kind === "user")?.left ?? 0;
  const toolAt = time.spans.find((span) => span.kind === "tool")?.left ?? 0;
  assert.ok(toolAt > userAt, "按真实时刻摆时，晚发生的记录在右边");
  assert.ok(
    time.spans.every((span) => span.width === 0),
    "`time` 模式下每条宽度归零（相等宽度让「什么时候发生」成为唯一信息）",
  );

  // 没有时刻的记录不进时间线（拿不到就不画，不塞到最左边假装它在最前）
  const untimed = deriveTrajectoryTimeline(
    [turnOf(0, [{ ...cells[0], index: 1, kind: "system" as const, startedAt: null, timeSeconds: null }])],
    "time",
  );
  assert.strictEqual(untimed.spans.length, 0);

  /**
   * **并发不被串行化**（官方 `deriveTimedTimeline` 按 start 扫描、只扣真实空隙）：
   * 两条重叠的记录在 `duration` 域里必须仍然重叠。从前本扩展那份「等价实现」一律
   * 首尾相接，域被 Σ 拉长、所有条都更窄。
   */
  const overlapped: TrajectoryCell[] = [
    { ...cells[0], index: 1, kind: "tool", turn: 0, startedAt: at(0), timeSeconds: 4 },
    { ...cells[0], index: 2, kind: "tool", turn: 0, startedAt: at(1), timeSeconds: 1 },
  ];
  const overlap = deriveTrajectoryTimeline(
    [turnOf(0, overlapped)],
    "duration",
  );
  const [first, second] = overlap.spans;
  assert.ok(
    second.left < first.left + first.width,
    "并发区间保持重叠（子工具落在父工具区间内）",
  );

  /**
   * 错误色的判据是官方那一条：`isError === true`。**助手行从不置这个字段**——
   * 被中断 / 收尾失败的助手条不该被涂成错误色（用 `status === "error"` 判会把它们全涂红）。
   */
  const interrupted: TrajectoryCell[] = [
    { ...cells[0], index: 1, kind: "message", turn: 0, status: "error", isError: undefined, startedAt: at(0), timeSeconds: 1 },
    { ...cells[0], index: 2, kind: "tool", turn: 0, status: "error", isError: true, startedAt: at(0), timeSeconds: 1 },
  ];
  const errors = deriveTrajectoryTimeline([turnOf(0, interrupted)], "duration");
  assert.strictEqual(
    errors.spans.find((span) => span.cellIndex === 1)?.error,
    false,
    "中断的助手条不涂错误色",
  );
  assert.strictEqual(
    errors.spans.find((span) => span.cellIndex === 2)?.error,
    true,
    "真的失败的工具条涂错误色",
  );
}
console.log("trajectory: 时间线的三种模式 ✓");

// ---------- 10. 时间线顶部条：右键是平移手势，不是弹菜单 ----------
//
// 用户 2026-09-15 报的：官方 Web 的时间线条上右键能拖动（平移视口），扩展里右键
// 只会弹出 VS Code 的原生菜单、拖不动。官方 `TrajectoryTimeline` 的做法是
// `onContextMenu: (event) => event.preventDefault()`（**无条件**吃掉菜单），
// 右键按下则进 pan（`pannable: viewport !== null`，即已缩放时）。
// 这里钉住这条接线：去掉 preventDefault，或把它重新塞回 `if (zoom > 1)` 里，
// 「右键拖动」就又会被原生菜单挡住。
{
  // 时间线本体（含 contextmenu 与两处只拦左键）在 `TrajectoryTimeline.tsx`；
  // 平移手势的实现（document 监听、缩放约束）在交互端口 `trajectoryInteraction.ts`——
  // 2026-10-09 起这条链路的容器 ref 与动作合成同一个对象（AGENTS「一条交互链一个端口」）。
  const source = readFileSync(join(process.cwd(), "src", "webview", "components", "TrajectoryTimeline.tsx"), "utf8");
  const interaction = readFileSync(join(process.cwd(), "src", "webview", "trajectoryInteraction.ts"), "utf8");
  assert.ok(
    /className="trajectory-timeline"[\s\S]{0,600}onContextMenu=\{\(event\) => \{[\s\S]{0,600}event\.preventDefault\(\);/u.test(
      source,
    ),
    "时间线容器必须在 contextmenu 里**无条件** preventDefault（官方同款）",
  );
  assert.ok(
    !/onContextMenu=\{\(event\) => \{[\s\S]{0,200}if \(zoom > 1\) event\.preventDefault\(\)/.test(source),
    "不能再把 preventDefault 塞回 `if (zoom > 1)` 里——未缩放时右键就会弹菜单",
  );
  // 右键**一律**接住（不再只接已缩放的那一支）：轻点不拖 = 清选区（官方
  // `onPointerEnd` 的 `if (!moved) onRangeChange(null)`），拖动才平移。
  assert.ok(
    /if \(event\.button === 2\) \{[\s\S]{0,160}port\.beginPan\(event\.clientX\)/.test(source),
    "右键按下要进平移手势（轻点不拖则清选区），与官方的 `pannable` 同口径",
  );
  assert.ok(
    /beginPan\(clientX: number\): void \{[\s\S]{0,500}if \(zoom <= 1\) return;/.test(interaction),
    "平移的位移仍要受「已缩放」约束（未缩放时右键只是清选区，不动视口）",
  );
  // 平移监听挂在 document 上：拖出时间线（甚至拖出窗口）要继续跟手
  assert.ok(
    /doc\.addEventListener\("mousemove", onMove\)/.test(interaction) &&
      /doc\.addEventListener\("mouseup", onUp\)/.test(interaction),
    "平移期间要在 document 上监听移动 / 抬起，否则一拖出元素就断",
  );
  // span 与「加载更早」只拦左键：拦右键会让「在时间线任意位置右键拖动」失效
  const guards = source.match(/if \(event\.button === 0\) event\.stopPropagation\(\);/g) ?? [];
  assert.strictEqual(guards.length, 2, "时间线里两处（span 与 earlier）只拦左键，右键要放行给平移");

  // 边缘自动平移的三个官方常数（直接读**共享 seam 的值**，不再读源码字样）
  assert.strictEqual(EDGE_PAN_ZONE_FRACTION, 0.08, "边缘区 8%（官方 EDGE_PAN_ZONE_FRACTION）");
  assert.strictEqual(EDGE_PAN_STEP_FRACTION, 0.025, "每步 2.5% 域跨度（官方 EDGE_PAN_STEP_FRACTION）");
  assert.strictEqual(MAXIMUM_EDGE_PAN_PX, 32, "最多 32px（官方 MAXIMUM_EDGE_PAN_PX）");

  // 行为：右键轻点 = 清选择；已缩放才挪视口；抬起（含拖出区外）一定摘监听
  const original = (globalThis as { document?: unknown }).document;
  try {
    for (const [zoomFirst, expectMoved] of [[false, false], [true, true]] as const) {
      const added: string[] = [];
      const removed: string[] = [];
      const listeners: Record<string, (event: { clientX: number }) => void> = {};
      (globalThis as { document?: unknown }).document = {
        addEventListener: (type: string, listener: (event: { clientX: number }) => void) => {
          added.push(type);
          listeners[type] = listener;
        },
        removeEventListener: (type: string) => removed.push(type),
      };
      const port = createTrajectoryInteraction("s1");
      port.plot.current = {
        getBoundingClientRect: () => ({ left: 0, width: 1000, top: 0, height: 50 }),
      } as never;
      if (zoomFirst) {
        port.zoomAtCursor(500, -600, 8);
        port.panTo(0.3);
      }
      const before = port.state.offset;
      port.beginPan(500);
      assert.deepStrictEqual(added, ["mousemove", "mouseup"], "右键按下要在 document 上挂移动 / 抬起监听");
      listeners.mousemove?.({ clientX: 300 });
      if (expectMoved) {
        assert.ok(port.state.offset > before, "已缩放时右键拖动跟着手挪视口");
        assert.strictEqual(port.state.animateViewport, false, "平移不走过渡（有过渡会一直追动画）");
      } else {
        assert.strictEqual(port.state.offset, 0, "未缩放时右键拖动不动视口（整个域已经在视口里）");
      }
      listeners.mouseup?.({ clientX: 300 });
      assert.deepStrictEqual(removed, ["mousemove", "mouseup"], "抬起要摘掉监听（拖出绘图区也走这一条）");
      // 轻点不拖（位移 < 3px）= 清掉选中与选区
      port.selectRecord(2);
      port.beginPan(500);
      listeners.mouseup?.({ clientX: 501 });
      assert.strictEqual(port.state.record, undefined, "右键轻点不拖 = 清选区与选中（官方 `if (!moved)`）");
    }
  } finally {
    if (original === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = original;
  }
}
console.log("trajectory: 顶部条右键平移（不吃菜单、跟手到底）✓");

// ---------- 10b. 时间线的视觉与命中：缝隙 / hover 环 / 竖线互斥 / 视口过渡 ----------
//
// 这一组钉的是 2026-10-04 与官方对齐的那几处**容易悄悄退化**的接线：
// 缝隙与最小宽度是同一个 `max()` 里的两项、hover 环与跟随竖线是**互斥**的两种表达、
// 视口过渡只给「选中跟随」一种场合。都用源码断言（它们都是接线，不是纯计算）。
{
  // 呈现（条怎么画、hover 走 DOM、过渡属性）在 `TrajectoryTimeline.tsx`；
  // 「什么时候动视口」在交互端口里（2026-10-09 起视口与容器几何同属那个对象）。
  const source = readFileSync(join(process.cwd(), "src", "webview", "components", "TrajectoryTimeline.tsx"), "utf8");
  const interaction = readFileSync(join(process.cwd(), "src", "webview", "trajectoryInteraction.ts"), "utf8");
  // 缝隙：左边界加一个 gap、宽度减两个 gap、外面套 `max(最小宽度, …)`
  assert.ok(
    /left: `\$\{\(left \+ gap\) \* 100\}%`[\s\S]{0,200}width: `max\(\$\{dp\(2, scale\)\}px, \$\{\(width - gap \* 2\) \* 100\}%\)`/.test(
      source,
    ),
    "等宽条要让出缝隙（左加一个 gap、宽减两个 gap），且宽度有 2px 兜底",
  );
  // hover 命中走 DOM（`elementFromPoint`），不自己重算条的矩形
  assert.ok(
    /document\.elementFromPoint\(event\.clientX, event\.clientY\)[\s\S]{0,300}closest<HTMLElement>\("\.trajectory-span"\)/.test(
      source,
    ),
    "hover 压在哪条上要**问 DOM**（官方读事件目标），不是自己按域范围推——次像素的缝隙算不准",
  );
  assert.ok(
    /data-hovered=\{hoveredIndex === span\.cellIndex/.test(source),
    "hover 高亮环按 `data-hovered` 挑（官方那个属性选择器）",
  );
  // 跟随竖线与 hover 环互斥：指在条上时不画竖线（官方 `hover.recordIndex === null` 同一条件），
  // 另外**手势进行中也不画**（拖动时 hover 不再更新，竖线必须让位）
  assert.ok(
    /hover !== null && hoveredIndex === null && gesture === null/.test(source),
    "指在某条记录上时**不画**跟随竖线（改由高亮环表达），与官方同一条件",
  );
  // 视口过渡只在选中跟随时开（端口的 `followSelected` 是唯一一处 `animateViewport: true`）
  assert.ok(
    /data-animate-viewport=\{animateViewport/.test(source),
    "视口过渡的开关要挂到绘图区的 `data-animate-viewport` 上",
  );
  const followAt = interaction.lastIndexOf("followSelected(");
  assert.ok(
    followAt > 0 && interaction.slice(followAt, followAt + 1400).includes("animateViewport: true"),
    "选中跟随要开视口过渡（官方 `animateViewport`）",
  );
  for (const [member, why] of [
    ["zoomAtCursor", "滚轮缩放"],
    ["panTo", "右键平移"],
    ["edgePanAt", "边缘自动平移"],
  ] as const) {
    const at = interaction.lastIndexOf(`${member}(`);
    assert.ok(at > 0, `端口里找不到 ${member}`);
    assert.ok(
      interaction.slice(at, at + 1400).includes("animateViewport: false"),
      `${why}（${member}）要显式关掉过渡——有过渡的话缩放与平移会一直在追动画`,
    );
  }
  // 缩放上限：官方的绝对最小窗口（sequence 4 条 / 其余 20ms），不是写死的倍数
  assert.ok(
    /minimumDomain = mode === "sequence" \? 4 : 20/.test(source) &&
      /maxZoom = Math\.max\(1, currentDomain \/ minimumDomain\)/.test(source),
    "缩放上限要由官方的**绝对最小窗口**推出，而不是写死 100 倍",
  );
}
console.log("trajectory: 时间线的缝隙 / hover 环 / 视口过渡 ✓");

// ---------- 11. 缩放后的坐标换算：选区存的是**域位置**，不是屏幕比例 ----------
//
// 用户 2026-09-15 报的：顶条缩放之后左键框选，手划的区域与实际选中的区域对不上。
// 根因就是这里——选区曾经按**屏幕比例**记下来、又当**域位置**画出去（`inRange` 与
// span 的 `left`/`width` 都在域坐标里），缩放越大偏得越离谱。
// 两个方向必须严格互逆：画（域→屏幕）与命中（屏幕→域）。
{
  // 未缩放时两套坐标重合（这也是当初漏掉换算却「不缩放时看着没问题」的原因）
  assert.strictEqual(trajectoryScreenFraction(0.25, 0, 1), 0.25);
  assert.strictEqual(trajectoryDomainPosition(0.25, 0, 1), 0.25);

  // 放大 4 倍、视口左边界在域 0.5：屏幕左缘 = 域 0.5，屏幕右缘 = 域 0.75
  const zoom = 4;
  const offset = 0.5;
  assert.strictEqual(trajectoryScreenFraction(0.5, offset, zoom), 0, "视口左边界贴在屏幕左缘");
  assert.strictEqual(trajectoryScreenFraction(0.75, offset, zoom), 1, "视口右边界贴在屏幕右缘");

  // 往返：屏幕比例 → 域 → 屏幕比例 必须回到原值（框选与绘制用同一对函数）
  for (const fraction of [0, 0.1, 0.5, 0.9, 1]) {
    const domain = trajectoryDomainPosition(fraction, offset, zoom);
    assert.ok(
      Math.abs(trajectoryScreenFraction(domain, offset, zoom) - fraction) < 1e-9,
      `屏幕比例 ${fraction} 往返之后必须不变（域=${domain}）`,
    );
  }
  // 「手划到屏幕正中」在缩放后对应的是**视口正中**的域位置，不是域正中
  assert.strictEqual(
    trajectoryDomainPosition(0.5, offset, zoom),
    0.625,
    "屏幕正中 = 视口正中（域 0.625），不是整个域的正中（0.5）",
  );
  // 越界的鼠标位置夹回 0..1 的域内（拖到绘图区外面时不该算出域外的位置）
  // 域位置夹在 0..1：屏幕比例在 `screenFractionOf` 里已经夹过一次，这里再把**域**
  // 夹一次——视口右端贴到域末尾时，锚点算出来会略微越过 1
  assert.strictEqual(
    trajectoryDomainPosition(0.5, 0.9, 4),
    1,
    "0.9 + 0.125 = 1.025 → 夹回 1（不许给出域外的位置）",
  );
  assert.strictEqual(trajectoryDomainPosition(0.5, 0, 1), 0.5, "未缩放时屏幕比例就是域位置");

  // 结构不变量：顶条那两处（框选与绘制）必须走这两个函数，不许再各写一份换算。
  // 绘制在 `TrajectoryTimeline.tsx`（`screen`），命中 / 框选在交互端口的 `domainAt`。
  const timeline = readFileSync(join(process.cwd(), "src", "webview", "components", "TrajectoryTimeline.tsx"), "utf8");
  const interaction = readFileSync(join(process.cwd(), "src", "webview", "trajectoryInteraction.ts"), "utf8");
  assert.ok(
    /const screen = \(value: number\) => trajectoryScreenFraction\(value, offset, zoom\)/.test(timeline),
    "绘制（域 → 屏幕）走 trajectoryScreenFraction",
  );
  assert.ok(
    /trajectoryDomainPosition\(screenFraction\(clientX\), state\.offset, state\.zoom\)/.test(interaction),
    "框选（屏幕 → 域）走 trajectoryDomainPosition——直接拿屏幕比例当域位置就是那个缺陷",
  );
  // 行为：以光标为锚缩放时，光标下的域位置不动（域 ⇄ 屏幕这一对必须真的互逆）
  const port = createTrajectoryInteraction("s1");
  port.plot.current = {
    getBoundingClientRect: () => ({ left: 0, width: 1000, top: 0, height: 50 }),
  } as never;
  const anchor = port.domainAt(500);
  port.zoomAtCursor(500, -600, 8);
  assert.ok(port.state.zoom > 1, "向上滚 = 放大");
  assert.ok(
    Math.abs(port.domainAt(500) - anchor) < 1e-9,
    "缩放以光标为锚：光标下的域位置不动（直接拿屏幕比例当域位置就会偏）",
  );
}
console.log("trajectory: 缩放后的选区坐标换算（域 ⇄ 屏幕）✓");

// ---------- 12. 顶条选谁，账本跳谁 ----------
//
// 用户 2026-09-15 报的：在顶条里点一个节点、或左键框一块区域，下方账本不会跟着跳。
// 接线有两处，缺一处就少一半：
// - 点某一条 → `onSelect` 里 `revealRow(index)`；
// - 框选结束 → `onRangeCommit={revealRange}`（拖动过程中不滚，见 `endDrag`）；
//   抬起的监听挂在 document 上，所以**拖出绘图区也照样提交**（官方 `setPointerCapture` 的同一目的）；
// - 行上要有 `data-cell-index` 供定位，容器是 `.trajectory-ledger`。
{
  // 接线：账本行要带定位属性（时间线点选 / 框选之后账本靠它找行）
  const view = readFileSync(join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"), "utf8");
  assert.ok(/data-cell-index=\{cell\.index\}/.test(view), "账本行要带 data-cell-index（滚到哪一行靠它定位）");
  // 行为：两条路径都由**同一个端口**完成（组件与测试跨的是同一个对象）。
  // 2026-10-09 起 `onSelect` / `onRangeCommit` / `endDrag` / `revealRange` 那几条内联接线
  // 收敛成端口上的 `openRecord` / `beginSlice+extendSlice+endSlice` / `applyReveal`。
  const plot = { getBoundingClientRect: () => ({ left: 0, width: 1000, top: 0, height: 50 }) };
  const spans = [
    { cellIndex: 1, left: 0, width: 0.1 },
    { cellIndex: 2, left: 0.1, width: 0.1 },
    { cellIndex: 3, left: 0.2, width: 0.1 },
  ];
  // ① 点某一条 → 选中 + 请求把账本滚过去
  const port = createTrajectoryInteraction("s1");
  port.plot.current = plot as never;
  port.syncSpans(spans);
  port.openRecord(2);
  assert.strictEqual(port.state.record, 2, "点时间线上的一条要选中它");
  assert.strictEqual(port.state.reveal?.index, 2, "并请求把账本滚过去（只选中不滚，用户看不到落点）");
  // ② 框选：拖动过程中**不滚**，抬起才提交并滚到选区第一条（判据与高亮同一套：区间相交）
  const drag = createTrajectoryInteraction("s1");
  drag.plot.current = plot as never;
  drag.syncSpans(spans);
  drag.beginSlice(10); // 域 0.01
  drag.extendSlice(250); // 域 0.25 → 选区 [0.01, 0.25]，第 1/2/3 条都落在里面
  assert.strictEqual(drag.state.reveal, null, "拖动过程中每动一下就滚会把账本晃坏（抬手才提交）");
  drag.endSlice(250);
  assert.strictEqual(revealIndexOf(drag), 1, "抬起时提交，并滚到选区里**第一条**");
  // ③ 点一下（位移 < 3px）→ 最小选区 + 聚焦最近记录（不是没反应）
  const click = createTrajectoryInteraction("s1");
  click.plot.current = plot as never;
  click.syncSpans(spans);
  click.beginSlice(215);
  click.endSlice(215);
  assert.ok(
    click.state.range !== null && click.state.range.end > click.state.range.start,
    "点空白要给一条最小选区（不是把选区清掉）",
  );
  assert.strictEqual(click.state.record, 3, "并聚焦离落点最近的那条记录（官方 onRecordFocus）");
  // ④ 落点是**置顶对齐**：直接动账本自己的 scrollTop（不用 scrollIntoView——那会把外层容器一起滚）
  const fakeLedger = {
    scrollTop: 0,
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 235 }) }),
    getBoundingClientRect: () => ({ top: 0 }),
  };
  click.ledger.current = fakeLedger as unknown as HTMLDivElement;
  click.reveal(3);
  assert.strictEqual(
    click.applyReveal(3, click.state.reveal?.nonce ?? -1),
    true,
    "落点由端口消费（同一个 nonce 只消费一次）",
  );
  assert.strictEqual(fakeLedger.scrollTop, 235, "目标行顶边贴住账本视口顶边（置顶对齐）");
  const interaction = readFileSync(join(process.cwd(), "src", "webview", "trajectoryInteraction.ts"), "utf8");
  assert.ok(
    !/scrollIntoView/.test(interaction),
    "滚动落在账本容器自己身上（不用 scrollIntoView——那会把外层容器一起滚）",
  );
  assert.ok(
    !/rect\.top < box\.top|rect\.bottom > box\.bottom/.test(interaction),
    "「最少滚动」的两条分支不许回来（贴边就是被换掉的落点行为）",
  );
}
console.log("trajectory: 顶条选中 → 账本跳转 ✓");

// ---------- 13. 请求表：选项 / 用量含会话累计 / 请求计时 / 重试 / 认证失败 ----------
//
// 官方这一层吃的是 `RequestView[]`（`ui-conversation` 折出来的
// `{startSeq, startedAt, completedAt, status, usage, …}`），本扩展从同一批 durable
// 事件自己折（见 `src/dsh/trajectory.ts` 文件头的「请求表」）。这一组钉的就是那几条
// 判据——它们每一条都对应一个具体的缺陷形状：
//
// - `startedAt` 必须取 **`step/start` 的事件时刻**（从前读 `assistant/message` 的
//   `data.startedAt`，那个字段真实日志里一条都没有 → 计时页签永远「未记录」）；
// - 重试来自 `llm/retry` 的 `retry` / `maxRetries` / `delayMs` / `failure`
//   （真实线格式；夹具原先写的是不存在的 `attempt` / `maxAttempts`，两边一起错）；
// - `AUTH` 码下**文案清空**（提供方的认证失败消息可能回显被掩码的凭据）；
// - 会话累计按请求号顺序逐个相加，重试重发时不留双份。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 1 }, 0),
    event("user/message", userMessage("问", { kind: "user" }), 0),
    event(
      "request/header",
      {
        header: {
          config: { provider: "p", model: "m", reasoningEffort: "high", maxTokens: 4096 },
          tools: [{ name: "read" }],
        },
        reason: "initial",
      },
      0,
    ),
    event("assistant/message", {
      turn: 0,
      step: 1,
      message: message("答", { model: "m" }),
      usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 40, reasoningTokens: 12 },
      /**
       * **合法的 raw 记录信封**（官方 `AssistantStreamRecord` 的
       * `{type:'chunk', time, chunk}`）。从前这里写的是裸 `{ time }`——那不是官方
       * 记录形状，旧读法只认 `.time` 才碰巧通过；F03 起首 token 按
       * `isTokenDelta` / `assistantStreamFirstTokenTime` 读，裸 `{time}` 必须不认。
       */
      stream: [{ type: "chunk", time: at(0.4), chunk: { type: "text-delta", index: 0, text: "答" } }],
    }, 1),
    event("turn/end", { turn: 0, reason: "success" }, 1),
    // 第二次请求：重试过一次（失败 → 重发）后才结算
    event("turn/start", { turn: 1 }, 2),
    event("step/start", { turn: 1, step: 1 }, 2),
    event("user/message", userMessage("再问", { kind: "user" }), 2),
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 2,
      maxRetries: 5,
      delayMs: 480,
      mode: "normal",
      failure: { message: "503 upstream", code: "SERVER" },
    }, 3),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("再答", { model: "m" }),
      usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 30 },
    }, 4),
    event("turn/end", { turn: 1, reason: "success" }, 4),
    // 第三次请求：提供方认证失败（AUTH 码，文案要清空）
    event("turn/start", { turn: 2 }, 5),
    event("step/start", { turn: 2, step: 1 }, 5),
    event("user/message", userMessage("三问", { kind: "user" }), 5),
    event("llm/retry", {
      turn: 2,
      step: 1,
      retry: 1,
      maxRetries: 3,
      delayMs: 900,
      mode: "normal",
      failure: { message: "invalid api key sk-abc123", code: "AUTH" },
    }, 6),
    // 真机上重试失败后这一步会被关掉（`step/end` 收尾），请求才有 completedAt
    event("step/end", { turn: 2, step: 1 }, 6),
    /**
     * 轮次收尾用**固定 rc.2 的结构化形状**（`TurnEndReasonMap` 的 `error` 变体）：
     * 请求表的轮次失败按 `reason.kind === 'error'` + `displayFailure(reason.error)` 读
     * （会话流那一侧一直是这么读的），AUTH 码下文案同样清空。字符串形式是回退口径，
     * 由上面第 6 组的 `reason: "error"` 覆盖，不在这里冒称契约。
     */
    event("turn/end", {
      turn: 2,
      reason: { kind: "error", error: { code: "AUTH", message: "invalid api key sk-abc123" } },
    }, 6),
  ];
  const model = deriveTrajectoryModel(events, false);
  const requests = model.requests;
  assert.strictEqual(requests.length, 3, "三次 step/start 折出三次请求");
  assert.deepStrictEqual(
    requests.map((request) => request.number),
    [1, 2, 3],
    "请求号连续升序（1 基，序号就是数组下标 + 1）",
  );
  assert.deepStrictEqual(
    requests.map((request) => [request.purpose, request.turn, request.step]),
    [["assistant", 0, 1], ["assistant", 1, 1], ["assistant", 2, 1]],
    "用途与 turn/step 逐个对上",
  );

  const first = requests[0];
  assert.strictEqual(first.startedAt, at(0), "startedAt 取 step/start 的事件时刻");
  assert.strictEqual(first.completedAt, at(1), "completedAt 取结算帧（assistant/message）的时刻");
  assert.strictEqual(first.status, "complete");
  assert.deepStrictEqual(
    first.options,
    { provider: "p", model: "m", reasoningEffort: "high", maxTokens: 4096 },
    "request/header 的 config 进选项页签",
  );
  assert.strictEqual(first.provider, "p", "提供方优先取请求头的 config");
  assert.strictEqual(first.model, "m");
  assert.deepStrictEqual(
    first.usage,
    { input: 100, cacheRead: 20, cacheWrite: 5, output: 40, reasoning: 12 },
    "请求级用量的推理桶叫 reasoning（记录级那个叫 think）",
  );
  assert.deepStrictEqual(first.cumulativeUsage, first.usage, "第一次请求的累计等于它自己");
  assert.strictEqual(first.assistantFirstTokenTime, at(0.4), "首个 token 时刻来自 stream 的第一帧");
  assert.deepStrictEqual(first.retry, undefined, "这次没有重试");

  // 计时的三条派生量（官方 `totalTime` / `ttft` / `throughput` 的分子分母）
  assert.strictEqual(
    (first.completedAt as number) - (first.startedAt as number),
    1000,
    "总时长 = completedAt - startedAt",
  );
  assert.strictEqual(
    (first.assistantFirstTokenTime as number) - (first.startedAt as number),
    400,
    "TTFT = 首 token 时刻 - startedAt",
  );

  const second = requests[1];
  assert.deepStrictEqual(
    second.retry,
    { attempt: 2, max: 5 },
    "重试进度取 llm/retry 的 retry / maxRetries（线格式的字段名）",
  );
  assert.strictEqual(second.retryDelayMs, 480, "重试延迟取 delayMs");
  assert.strictEqual(second.error, "503 upstream", "失败文案取 failure.message");
  assert.strictEqual(second.errorCode, "SERVER", "稳定错误码取 failure.code");
  /**
   * 官方 rc.2 `trajectoryAssistantDefinition` 的 `assistantRequest()`：
   *
   *   status = node !== undefined && node.interrupted !== true
   *     ? 'complete'
   *     : state.retry !== undefined || boundary !== undefined ? 'error' : 'running'
   *
   * **非中断的最终节点优先**——`llm/retry` 之后同一步又成功了，这次请求就是 complete
   * （F04 修的正是这里：从前 `status !== 'error'` 的门槛把重试过一次的请求永远钉在
   * error 上，而助手记录已经是 complete）。重试事实（次数 / 上限 / 延迟 / 失败文案）
   * 照旧留在请求上，下面那几条断言不许动。
   */
  assert.strictEqual(second.status, "complete", "重试后同一步成功结算 → 请求是 complete，不是 error");
  assert.deepStrictEqual(
    second.cumulativeUsage,
    { input: 300, cacheRead: 20, cacheWrite: 5, output: 70, reasoning: 12 },
    "会话累计逐个相加（含上一个请求）",
  );

  const third = requests[2];
  assert.strictEqual(third.errorCode, "AUTH", "认证失败的码留下来（界面按它显示本地化文案）");
  assert.strictEqual(third.error, undefined, "AUTH 码下**不留**原始文案（可能回显被掩码的凭据）");
  assert.strictEqual(third.status, "error", "轮次失败（结构化 error）是终态，不被成功状态盖掉");
  assert.strictEqual(third.completedAt, at(6), "没有结算帧时用 step/end 的时刻收尾");
  assert.ok(
    !JSON.stringify(model).includes("sk-abc123"),
    "结构化 AUTH 轮次错误的原文同样不进模型（displayFailure 清空）",
  );

  // 请求表与账本行的对应：每个非 system 行都要能在表里找到它的请求
  const numbers = new Set(requests.map((request) => request.number));
  for (const cell of model.turns.flatMap(trajectoryTurnCells)) {
    if (cell.kind === "system") continue;
    assert.ok(
      cell.requestNumber !== undefined && numbers.has(cell.requestNumber),
      `账本行 #${cell.index}（${cell.kind}）的请求号要落在请求表里`,
    );
  }

  // 助手行的计时事实用的是**请求**的开始时刻（两处必须同源，否则同一个量两个值）
  const assistant = model.turns.flatMap(trajectoryTurnCells).find((cell) => cell.kind === "message");
  assert.strictEqual(
    assistant?.assistantMetrics?.stepStartTime,
    first.startedAt,
    "助手行的 stepStartTime 与请求的 startedAt 同源（都取 step/start 的时刻）",
  );
  assert.strictEqual(assistant?.assistantMetrics?.timingRecorded, true, "有 step/start 就算记过计时");
  assert.strictEqual(assistant?.timeSeconds, 1, "助手行耗时 = 结算时刻 - 请求开始时刻");
}
console.log("trajectory: 请求表（选项 / 用量 / 计时 / 重试）✓");

// ---------- 14. 压缩请求也进请求表（占号 + 用量 + 收尾） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("compaction/start", { turn: null }, 0),
    event("compaction/summary", {
      summary: block("摘要"),
      usage: { inputTokens: 7, outputTokens: 8 },
      provider: "p",
      model: "m",
    }, 1),
    event("compaction/end", {}, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  assert.strictEqual(model.requests.length, 1, "压缩是一次模型请求，也要进表（否则后面的编号全错位）");
  const request = model.requests[0];
  assert.strictEqual(request.purpose, "compaction", "用途标成压缩");
  assert.strictEqual(request.step, 0, "官方压缩请求的 step 固定为 0");
  assert.strictEqual(request.turn, null, "轮次之间的独立压缩没有轮次");
  assert.deepStrictEqual(request.usage, { input: 7, output: 8 }, "压缩请求的用量同样进表");
  assert.strictEqual(request.provider, "p", "压缩请求的提供方来自 summary 帧");
  assert.strictEqual(request.status, "complete");
  assert.strictEqual(request.completedAt, at(2), "compaction/end 收尾");
  assert.strictEqual(
    model.turns.flatMap(trajectoryTurnCells)[0]?.requestNumber,
    1,
    "压缩行的请求号与请求表里的那一号一致",
  );
}
console.log("trajectory: 压缩请求进请求表 ✓");

// ---------- 14b. overflow 恢复：压缩与同一步的助手请求各自结算（F02） ----------
//
// 合法时序（**不是**「一个 step 一次请求」那种常见形状）：
//
//   step/start → assistant/attempt 失败 → compaction/start / summary / end
//   → request/header → **同一步**的 assistant/message 成功 → step/end
//
// 这次恢复**没有新的 `step/start`**（官方 overflow hook 的 `agent/request-error`
// 分支返回同一步重试），而 `compaction/start` 插在 `step/start` 与同一步的
// `assistant/message` 之间。助手请求与压缩请求是**两次模型请求**（官方是两套
// definition 状态机，各自产出 `RequestView`），所以：
//
// - 各自占号、各自结算用量；助手这次请求的开始时刻仍是它自己那次 `step/start`；
// - `request/header` 属于**当前这一步的助手请求**，压缩请求不接这份选项；
// - 助手行挂助手请求号、压缩行挂压缩请求号——归属按 `turn:step` 稳定身份找，
//   不是「最后开的那次请求」（那个值此刻正是压缩请求）。
//
// 从前用一个 `lastRequest` 代表两种请求，压缩把它顶掉：助手请求永远 `running`、
// `completedAt` 与 usage / options 全丢，助手行的计时开始也成了 null。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/attempt", { turn: 1, step: 1, stream: [] }, 1),
    event("compaction/start", { turn: 1, compactionId: "k1" }, 1),
    event("compaction/summary", {
      compactionId: "k1",
      summary: block("溢出摘要"),
      usage: { inputTokens: 5, outputTokens: 1 },
    }, 2),
    event("compaction/end", { compactionId: "k1" }, 2),
    event("request/header", {
      header: {
        config: { provider: "p", model: "m", reasoningEffort: "high", maxTokens: 4096 },
        tools: [],
      },
      reason: "initial",
    }, 2),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("恢复成功", { model: "m" }),
      usage: { inputTokens: 10, outputTokens: 3 },
      // 紧凑流的**真实信封**（官方 `AssistantStreamRecord`：`{type:'chunk', time, chunk}`）：
      // 首个 token 时刻取这一帧的 `time`。F03 起「哪些帧算 token」会按官方
      // `isTokenDelta` 判——写一个只有 `time` 的裸对象就等于固定了一份不合法的输入。
      stream: [{ type: "chunk", time: at(3.5), chunk: { type: "text-delta", index: 0, text: "恢复成功" } }],
    }, 4),
    event("step/end", { turn: 1, step: 1 }, 4),
    event("turn/end", { turn: 1, reason: "success" }, 5),
  ];
  const model = deriveTrajectoryModel(events, false);
  const assistantRequest = model.requests.find((request) => request.purpose === "assistant");
  const compactionRequest = model.requests.find((request) => request.purpose === "compaction");
  assert.ok(assistantRequest !== undefined && compactionRequest !== undefined, "两次模型请求都要在表里");

  assert.deepStrictEqual(
    model.requests.map((request) => [request.number, request.purpose, request.turn, request.step]),
    [[1, "assistant", 1, 1], [2, "compaction", 1, 0]],
    "压缩独立占号，助手请求仍是它自己那次 step/start 的号",
  );
  assert.strictEqual(assistantRequest?.startedAt, at(0), "助手请求的开始时刻取它自己那次 step/start");
  assert.strictEqual(assistantRequest?.completedAt, at(4), "同一步的 assistant/message 把它结算掉");
  assert.strictEqual(assistantRequest?.status, "complete", "结算后不能再停在 running");
  assert.deepStrictEqual(assistantRequest?.usage, { input: 10, output: 3 }, "助手请求的用量不丢");
  assert.deepStrictEqual(
    assistantRequest?.options,
    { provider: "p", model: "m", reasoningEffort: "high", maxTokens: 4096 },
    "压缩之后到的 request/header 挂给这一步的助手请求（不是压缩请求）",
  );
  assert.strictEqual(assistantRequest?.assistantFirstTokenTime, at(3.5), "首个 token 时刻照样落在助手请求上");

  assert.strictEqual(compactionRequest?.startedAt, at(1), "压缩请求有自己的开始时刻");
  assert.strictEqual(compactionRequest?.completedAt, at(2), "压缩请求由 compaction/end 收尾");
  assert.strictEqual(compactionRequest?.status, "complete");
  assert.deepStrictEqual(compactionRequest?.usage, { input: 5, output: 1 }, "压缩请求有自己的用量");
  assert.strictEqual(compactionRequest?.options, undefined, "压缩请求不接助手那份请求选项");
  assert.notStrictEqual(
    compactionRequest?.number,
    assistantRequest?.number,
    "两种请求不许共用同一个号（从前压缩把助手那次顶掉）",
  );

  /**
   * 会话累计按**请求号顺序**相加（官方按 `startSeq` 排序后逐个加）。压缩在事件时间上
   * 早于助手的结算帧，但它的请求号更大，所以累计要从助手那次算起。
   */
  assert.deepStrictEqual(assistantRequest?.cumulativeUsage, { input: 10, output: 3 }, "助手请求是 #1，累计就是它自己");
  assert.deepStrictEqual(
    compactionRequest?.cumulativeUsage,
    { input: 15, output: 4 },
    "压缩请求是 #2，累计含两次；重复结算会得到 20/6（多算一遍助手用量）",
  );

  const flat = model.turns.flatMap(trajectoryTurnCells);
  assert.deepStrictEqual(
    flat.map((cell) => [cell.kind, cell.requestNumber]),
    [["system", undefined], ["compacted", 2], ["message", 1]],
    "助手行挂助手请求号、压缩行挂压缩请求号（请求边界小标记按这个序列走）",
  );
  const assistantCell = flat.find((cell) => cell.kind === "message");
  assert.strictEqual(assistantCell?.requestNumber, 1, "助手行不属于压缩请求");
  assert.strictEqual(
    assistantCell?.assistantMetrics?.stepStartTime,
    at(0),
    "助手行的计时开始取 step/start 的时刻，不是压缩的时刻",
  );
  assert.strictEqual(assistantCell?.assistantMetrics?.timingRecorded, true, "有 step/start 就算记过计时");
  assert.strictEqual(assistantCell?.timeSeconds, 4, "助手行耗时 = 结算时刻 − 步骤开始时刻");
  assert.strictEqual(assistantCell?.status, "complete");
}
console.log("trajectory: overflow 恢复时助手请求照常结算 ✓");

// ---------- 14c. pre-step 压缩（压缩在 step/start 之前，另一种时序） ----------
//
// 普通 context pressure 的压缩发生在**请求之前**：`compaction/*` 先整段走完，
// 之后才有 `step/start`。它与 overflow 的「同一步内压缩」是两种时序，两种都要对：
// 压缩占它自己的号（这里是 #1），随后的助手请求照常拿自己的 `step/start`、
// 自己的选项与用量，助手行挂自己的号。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("compaction/start", { turn: 1, compactionId: "k1" }, 0),
    event("compaction/summary", {
      compactionId: "k1",
      summary: block("预压缩摘要"),
      usage: { inputTokens: 2, outputTokens: 1 },
    }, 1),
    event("compaction/end", { compactionId: "k1" }, 1),
    event("step/start", { turn: 1, step: 1 }, 1),
    event("request/header", {
      header: { config: { provider: "p", model: "m" }, tools: [] },
      reason: "initial",
    }, 1),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("压缩后照常回答", { model: "m" }),
      usage: { inputTokens: 4, outputTokens: 2 },
    }, 2),
    event("step/end", { turn: 1, step: 1 }, 2),
    event("turn/end", { turn: 1, reason: "success" }, 3),
  ];
  const model = deriveTrajectoryModel(events, false);
  const assistantRequest = model.requests.find((request) => request.purpose === "assistant");
  const compactionRequest = model.requests.find((request) => request.purpose === "compaction");
  assert.deepStrictEqual(
    model.requests.map((request) => [request.number, request.purpose]),
    [[1, "compaction"], [2, "assistant"]],
    "压缩先开始就先占号，助手请求排它后面",
  );
  assert.strictEqual(assistantRequest?.startedAt, at(1), "助手请求的开始时刻是它自己那次 step/start");
  assert.strictEqual(assistantRequest?.completedAt, at(2));
  assert.strictEqual(assistantRequest?.status, "complete");
  assert.deepStrictEqual(assistantRequest?.usage, { input: 4, output: 2 });
  assert.deepStrictEqual(
    assistantRequest?.options,
    { provider: "p", model: "m" },
    "step/start 之后的 request/header 挂在助手请求上",
  );
  assert.deepStrictEqual(compactionRequest?.usage, { input: 2, output: 1 }, "压缩用它自己的用量");
  assert.deepStrictEqual(
    model.requests[1]?.cumulativeUsage,
    { input: 6, output: 3 },
    "累计按请求号顺序：压缩 + 助手",
  );
  assert.deepStrictEqual(
    model.turns.flatMap(trajectoryTurnCells).map((cell) => [cell.kind, cell.requestNumber]),
    [["system", undefined], ["compacted", 1], ["message", 2]],
    "压缩行 1 号、助手行 2 号",
  );
}
console.log("trajectory: pre-step 压缩与随后的助手请求互不顶替 ✓");

// ---------- 14d. 多个步骤 + 同一步多次压缩 + 已完成请求不被回写 ----------
//
// 第 1 步正常跑完（请求 #1，配置 A）之后，第 2 步里**连着两次** overflow 压缩
// （#3 / #4），然后同一步的助手消息才结算（#2，配置 B）。要点：
//
// - 助手请求的身份是 `turn:step`：这一步的助手请求是 #2，而「最后开的请求」是 #4；
// - 已完成请求（#1）的用量 / 选项 / 状态 / 收尾时刻不被后来的 header B 或任何结算改写；
// - 累计用量按请求号顺序逐个相加，不重复（总数是四次之和）也不漏掉任何一次。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", {
      header: { config: { provider: "p", model: "m-a", temperature: 0.2 }, tools: [] },
      reason: "initial",
    }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("第一问的答", { model: "m-a" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    event("step/start", { turn: 1, step: 2 }, 2),
    event("assistant/attempt", { turn: 1, step: 2, stream: [] }, 2),
    event("compaction/start", { turn: 1, compactionId: "k1" }, 2),
    event("compaction/summary", {
      compactionId: "k1",
      summary: block("第一次压缩"),
      usage: { inputTokens: 2, outputTokens: 1 },
    }, 3),
    event("compaction/end", { compactionId: "k1" }, 3),
    event("compaction/start", { turn: 1, compactionId: "k2" }, 3),
    event("compaction/summary", {
      compactionId: "k2",
      summary: block("第二次压缩"),
      usage: { inputTokens: 3, outputTokens: 1 },
    }, 4),
    event("compaction/end", { compactionId: "k2" }, 4),
    event("request/header", {
      header: { config: { provider: "p", model: "m-b", maxTokens: 2048 }, tools: [] },
      reason: "tools",
    }, 4),
    event("assistant/message", {
      turn: 1,
      step: 2,
      message: message("第二问的答", { model: "m-b" }),
      usage: { inputTokens: 20, outputTokens: 5 },
    }, 5),
    event("step/end", { turn: 1, step: 2 }, 5),
    // 收尾**之后**才到的 header（合法的 epoch 变更帧）：它属于**下一个**请求，
    // 不许回写这一步已经收尾的那次请求（选项 / 用量 / 收尾时刻都得保持原样）。
    // 官方按事件落点把它归给后续请求（`headerFor` 的第二条分支）；本扩展这一半是 F01。
    event("request/header", {
      header: { config: { provider: "p", model: "m-c" }, tools: [] },
      reason: "tools",
    }, 5),
    event("turn/end", { turn: 1, reason: "success" }, 6),
  ];
  const model = deriveTrajectoryModel(events, false);
  assert.deepStrictEqual(
    model.requests.map((request) => [request.number, request.purpose, request.turn, request.step]),
    [
      [1, "assistant", 1, 1],
      [2, "assistant", 1, 2],
      [3, "compaction", 1, 0],
      [4, "compaction", 1, 0],
    ],
    "身份按 turn/step：第 2 步的助手请求是 #2，同一步的两次压缩才是 #3 / #4",
  );

  const first = model.requests[0];
  const second = model.requests[1];
  assert.strictEqual(first?.status, "complete");
  assert.deepStrictEqual(first?.usage, { input: 10, output: 1 }, "第 1 步的用量不被后来的结算改写");
  assert.deepStrictEqual(
    first?.options,
    { provider: "p", model: "m-a", temperature: 0.2 },
    "第 1 步的选项不被后来的 header（配置 B）回写",
  );
  assert.strictEqual(first?.startedAt, at(0));
  assert.strictEqual(first?.completedAt, at(1));
  assert.deepStrictEqual(first?.cumulativeUsage, { input: 10, output: 1 }, "它是 #1，累计只有它自己");

  assert.strictEqual(second?.startedAt, at(2), "第 2 步的助手请求从它自己的 step/start 起算");
  assert.strictEqual(second?.completedAt, at(5));
  assert.strictEqual(second?.status, "complete", "同一步压缩两次之后助手请求照样结算");
  assert.deepStrictEqual(second?.usage, { input: 20, output: 5 });
  assert.deepStrictEqual(
    second?.options,
    { provider: "p", model: "m-b", maxTokens: 2048 },
    "新 header 落在这一步的助手请求上（不是最后一次压缩）；这一步收尾后到的 header 也不回写它",
  );

  assert.deepStrictEqual(model.requests[2]?.usage, { input: 2, output: 1 }, "第一次压缩有自己的用量");
  assert.deepStrictEqual(model.requests[3]?.usage, { input: 3, output: 1 }, "第二次压缩有自己的用量");
  assert.deepStrictEqual(
    model.requests.map((request) => request.cumulativeUsage),
    [
      { input: 10, output: 1 },
      { input: 30, output: 6 },
      { input: 32, output: 7 },
      { input: 35, output: 8 },
    ],
    "累计按请求号顺序逐个相加：不漏任何一次请求，也不把某次算两遍",
  );

  const flat = model.turns.flatMap(trajectoryTurnCells);
  assert.deepStrictEqual(
    flat.map((cell) => [cell.kind, cell.requestNumber]),
    [
      ["system", undefined],
      ["message", 1],
      ["compacted", 3],
      ["compacted", 4],
      ["message", 2],
    ],
    "助手行各自挂自己的请求号，压缩行各挂各的（归属不串）",
  );
  assert.strictEqual(
    flat.filter((cell) => cell.kind === "message").map((cell) => cell.assistantMetrics?.stepStartTime).join(","),
    [at(0), at(2)].join(","),
    "两条助手行的计时开始各自取自己的 step/start",
  );
}
console.log("trajectory: 多步多次压缩下请求身份与累计不串 ✓");

// ---------- 14e. 后续步骤继承最近生效的 header（F01） ----------
//
// 触发场景：第一步有 initial header，配置不变、第二步**不再发** header。
// 官方 `TrajectorySnapshotBuilder.headerFor()` 的第二条分支就是这件事：这一步没有
// header 时，取**这个请求开始之前**最后一次生效的 `request-header`
// （`previous.seq < request.startSeq`），`applyHeader()` 把它的 `prompt.config`
// 整份挂到这次请求上。本扩展的等价物是 `options` / `provider` / `model`。
//
// 不继承的话，第二个请求没有 options，请求检查器的「选项」页签整个消失
// （`hasOptions = request.options !== undefined`）；provider / model 就算能从最终
// 消息上读到，也补不回缺的那些字段（temperature / maxTokens / reasoningEffort…），
// 而**从结算帧倒推配置**正是官方没有、也不该有的行为。
{
  seq = 0;
  const config = { provider: "p", model: "m", reasoningEffort: "high", maxTokens: 4096 };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config, tools: [] }, reason: "initial" }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("第一答", { model: "m" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    // 第二步：配置没变，服务端**不会再发**一帧 header
    event("step/start", { turn: 1, step: 2 }, 2),
    event("assistant/message", {
      turn: 1,
      step: 2,
      message: message("第二答", { model: "m" }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, 3),
    event("step/end", { turn: 1, step: 2 }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first, second] = model.requests;
  assert.strictEqual(model.requests.length, 2, "两个 step 两次请求");
  assert.deepStrictEqual(first?.options, config, "第一次请求的选项来自它那一帧 header");
  assert.deepStrictEqual(
    second?.options,
    config,
    "第二步没有 header 也继承最近生效的整份配置（「选项」页签不再消失）",
  );
  assert.strictEqual(second?.provider, "p", "继承的还有提供方");
  assert.strictEqual(second?.model, "m", "与模型");
  assert.strictEqual(second?.startedAt, at(2), "继承配置不改写它自己的开始时刻");
  assert.strictEqual(second?.completedAt, at(3));
  assert.strictEqual(second?.status, "complete");
  assert.deepStrictEqual(second?.usage, { input: 20, output: 2 }, "用量照旧来自各自的结算帧");
  assert.deepStrictEqual(second?.cumulativeUsage, { input: 30, output: 3 }, "累计按请求号顺序");
  assert.deepStrictEqual(
    model.turns
      .flatMap(trajectoryTurnCells)
      .filter((cell) => cell.kind === "message")
      .map((cell) => cell.requestNumber),
    [1, 2],
    "两条助手行各挂自己的请求号",
  );
}
console.log("trajectory: 后续步骤继承最近生效的 header ✓");

// ---------- 14f. 新 header 更新当前未结算请求，并成为后续步骤的配置（F01） ----------
//
// 官方 `headerFor()` 的第一条分支：这一步里有 header，就用**这一步最新的那一帧**
// （`headersByStep` 的键是 `turn\u0000step`）。于是：
// - 它落到当前这一步**还没结算**的助手请求上；
// - 它同时是「最近生效的配置」，之后开的步骤继承它；
// - 已经收尾的请求（第 1 步）一个字都不许被它改（配置 / 用量 / 收尾时刻）。
{
  seq = 0;
  const a = { provider: "p", model: "m-a", temperature: 0.2 };
  const b = { provider: "p2", model: "m-b", maxTokens: 2048 };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config: a, tools: [] }, reason: "initial" }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("第一答", { model: "m-a" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    // 这一步先跑起来（请求还没结算），header 才到
    event("step/start", { turn: 1, step: 2 }, 1),
    event("request/header", { header: { config: b, tools: [] }, reason: "system" }, 2),
    event("assistant/message", {
      turn: 1,
      step: 2,
      message: message("第二答", { model: "m-b" }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, 3),
    event("step/end", { turn: 1, step: 2 }, 3),
    event("step/start", { turn: 1, step: 3 }, 4),
    event("assistant/message", {
      turn: 1,
      step: 3,
      message: message("第三答", { model: "m-b" }),
      usage: { inputTokens: 30, outputTokens: 3 },
    }, 5),
    event("step/end", { turn: 1, step: 3 }, 5),
    event("turn/end", { turn: 1, reason: "success" }, 6),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first, second, third] = model.requests;
  assert.deepStrictEqual(
    model.requests.map((request) => [request.number, request.purpose, request.step]),
    [[1, "assistant", 1], [2, "assistant", 2], [3, "assistant", 3]],
    "三步三次请求",
  );
  assert.deepStrictEqual(first?.options, a, "第 1 步的配置不被后来的 header（配置 B）回写");
  assert.strictEqual(first?.provider, "p", "已完成请求的提供方同样不被回写");
  assert.strictEqual(first?.model, "m-a");
  assert.strictEqual(first?.completedAt, at(1), "已完成请求的收尾时刻不被改写");
  assert.deepStrictEqual(first?.usage, { input: 10, output: 1 }, "已完成请求的用量不被改写");
  assert.deepStrictEqual(
    second?.options,
    b,
    "这一步中途到的 header 落到**当前还没结算**的这次请求上",
  );
  assert.strictEqual(second?.provider, "p2");
  assert.strictEqual(second?.model, "m-b");
  assert.strictEqual(second?.startedAt, at(1), "它仍是自己那次 step/start 起算");
  assert.deepStrictEqual(
    third?.options,
    b,
    "同一步之后的步骤继承**最新**那份配置（不是最初那份）",
  );
  assert.strictEqual(third?.provider, "p2");
  assert.strictEqual(third?.model, "m-b");
  assert.deepStrictEqual(
    model.requests.map((request) => request.cumulativeUsage),
    [{ input: 10, output: 1 }, { input: 30, output: 3 }, { input: 60, output: 6 }],
    "累计按请求号顺序逐个相加",
  );
}
console.log("trajectory: 新 header 更新当前请求并成为后续配置 ✓");

// ---------- 14g. 两步之间到达的 header 由后续 step 继承（F01） ----------
//
// header 落在 `step/end` 之后、下一个 `step/start` 之前（官方的「事件落点」这时是
// **轮**而不是步，`headerStepKey()` 因此返回 undefined → 走 `previousHeader` 分支）。
// 它属于**下一个**请求：已经收尾的那次一个字不改，下一步继承它。
{
  seq = 0;
  const a = { provider: "p", model: "m-a" };
  const c = { provider: "p3", model: "m-c", maxTokens: 1024 };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config: a, tools: [] }, reason: "initial" }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("第一答", { model: "m-a" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    // 两步之间：这一步已经收尾
    event("request/header", { header: { config: c, tools: [] }, reason: "system" }, 2),
    event("step/start", { turn: 1, step: 2 }, 2),
    event("assistant/message", {
      turn: 1,
      step: 2,
      message: message("第二答", { model: "m-c" }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, 3),
    event("step/end", { turn: 1, step: 2 }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first, second] = model.requests;
  assert.deepStrictEqual(first?.options, a, "已收尾的请求不被两步之间的 header 回写");
  assert.strictEqual(first?.provider, "p");
  assert.strictEqual(first?.model, "m-a");
  assert.strictEqual(first?.completedAt, at(1));
  assert.deepStrictEqual(second?.options, c, "两步之间的 header 由后续 step 继承");
  assert.strictEqual(second?.provider, "p3");
  assert.strictEqual(second?.model, "m-c");
  assert.strictEqual(second?.startedAt, at(2));
  assert.strictEqual(second?.status, "complete");
}
console.log("trajectory: 两步之间的 header 由后续 step 继承 ✓");

// ---------- 14h. 截断窗口里没有 header：不许猜出一份不存在的配置（F01） ----------
//
// 跟随窗口可能从一轮中间开始（`step/start` 之前的帧都在窗口外），于是**没有任何
// `request/header`**。这时请求的「选项」必须是**没有**（检查器不画那个页签），
// 不许拿结算帧的 `message.source.provider` / `model` 倒推一份配置——那两个字段是
// 这次请求**自己的身份**（官方 `providerMetadata` 来自节点），不是请求配置。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("step/start", { turn: 5, step: 1 }, 0),
    event("assistant/message", {
      turn: 5,
      step: 1,
      message: message("窗口内的答", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 5, step: 1 }, 1),
    event("step/start", { turn: 5, step: 2 }, 2),
    event("assistant/message", {
      turn: 5,
      step: 2,
      message: message("再答", { provider: "p", model: "m" }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, 3),
    event("step/end", { turn: 5, step: 2 }, 3),
    event("turn/end", { turn: 5, reason: "success" }, 4),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first, second] = model.requests;
  assert.strictEqual(model.requests.length, 2, "两次 step/start 折出两次请求");
  assert.strictEqual(
    first?.options,
    undefined,
    "窗口里没有 header 就没有配置——不许从结算帧倒推一份",
  );
  assert.strictEqual(second?.options, undefined, "后续步骤同样没有可继承的配置");
  assert.strictEqual(first?.provider, "p", "提供方是结算帧自己的身份（官方 providerMetadata），不是配置");
  assert.strictEqual(first?.model, "m");
  assert.strictEqual(second?.provider, "p", "第二次请求的提供方来自它自己的结算帧");
  assert.strictEqual(second?.model, "m");
  assert.strictEqual(second?.startedAt, at(2));
  assert.strictEqual(second?.status, "complete");
  assert.deepStrictEqual(second?.cumulativeUsage, { input: 30, output: 3 });
}
console.log("trajectory: 截断窗口没有 header 就不猜配置 ✓");

// ---------- 14i. 空 / 不可读的 header 不复用上一份已失效的字段（F01） ----------
//
// header 帧本身合法，但载荷不可读（这里连 `header` 都没有）。它照样**整体替换**
// 「最近生效的配置」——上一份（配置 A）不能继续生效，已经落在当前请求上的
// options / provider 也要跟着失效；之后开的步骤同样只继承这份「空」配置。
// 模型这类**结算帧自己的事实**不受影响（它来自消息，不来自配置）。
{
  seq = 0;
  const a = { provider: "p", model: "m-a", temperature: 0.2 };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config: a, tools: [] }, reason: "initial" }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("第一答", { model: "m-a" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    event("step/start", { turn: 1, step: 2 }, 1),
    // 空 / 不可读的 header：载荷里连 `header` 都没有
    event("request/header", {}, 2),
    event("assistant/message", {
      turn: 1,
      step: 2,
      message: message("第二答", { model: "m-b" }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, 3),
    event("step/end", { turn: 1, step: 2 }, 3),
    event("step/start", { turn: 1, step: 3 }, 4),
    event("assistant/message", {
      turn: 1,
      step: 3,
      message: message("第三答", { model: "m-c" }),
      usage: { inputTokens: 30, outputTokens: 3 },
    }, 5),
    event("step/end", { turn: 1, step: 3 }, 5),
    event("turn/end", { turn: 1, reason: "success" }, 6),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first, second, third] = model.requests;
  assert.deepStrictEqual(first?.options, a, "第 1 步照旧有它那一帧 header 的配置");
  assert.strictEqual(first?.provider, "p");
  assert.strictEqual(first?.model, "m-a");
  assert.strictEqual(
    second?.options,
    undefined,
    "空 / 不可读的 header 不许让上一份选项继续生效",
  );
  assert.strictEqual(
    second?.provider,
    undefined,
    "提供方是那份失效配置的一部分，跟着一起失效（不复用配置 A 的 p）",
  );
  assert.strictEqual(second?.model, "m-b", "模型来自它自己的结算帧，不是配置 A 的 m-a");
  assert.strictEqual(third?.options, undefined, "空 header 之后的步骤也不继承更早那份配置");
  assert.strictEqual(third?.provider, undefined);
  assert.strictEqual(third?.model, "m-c");
  assert.deepStrictEqual(
    model.requests.map((request) => request.cumulativeUsage),
    [{ input: 10, output: 1 }, { input: 30, output: 3 }, { input: 60, output: 6 }],
    "字段失效不影响用量累计",
  );
}
console.log("trajectory: 空 / 不可读 header 不复用失效字段 ✓");

// ---------- 14i-1. 晚 header：结算帧已到、step/end 未到时到达的 header 补该步配置（F01 补完） ----------
//
// 官方 `snapshot()` 的 `headersByStep` 是**预扫描**：先把每条落点是步骤的
// `request-header` 收进 `turn\u0000step` 的表，再在助手那一条 contribution 上按
// `headerFor()` 取**这一步最新的一帧**。所以「结算帧先到、header 后到」这种时序里，
// 官方照样把后到的那份 `prompt.config` 当成本步的 `requestConfig`——助手消息结算
// **不等于**步骤关闭（`step/end` 才关闭）。
//
// 但 header 只给**配置**：官方 `applyHeader()` 只换 `prompt` / `requestConfig`，
// 不碰 `providerMetadata`（结算帧自己的身份，来自 `message.source`）、`completedAt`、
// `status`、`usage`。这两类事实必须分清——晚到的 header 不许把身份改成配置里那份。
{
  seq = 0;
  const a = { provider: "p1", model: "m-a", temperature: 0.2 };
  const c = { provider: "p2", model: "m-c", maxTokens: 2048 };
  const d = { provider: "p3", model: "m-d", maxTokens: 4096 };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config: a, tools: [] }, reason: "initial" }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("结算帧先到", { provider: "p-id", model: "m-id" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    // 这一步还没 `step/end`：落点仍在第 1 步，这两份 header 都属于它
    event("request/header", { header: { config: c, tools: [] }, reason: "system" }, 2),
    event("request/header", { header: { config: d, tools: [] }, reason: "system" }, 3),
    event("step/end", { turn: 1, step: 1 }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first] = model.requests;
  assert.strictEqual(model.requests.length, 1, "一次 step/start 一次请求");
  assert.deepStrictEqual(
    first?.options,
    d,
    "晚 header 补上该步最新那份配置（预扫描取本步最后一帧，不是结算前那份）",
  );
  assert.strictEqual(first?.provider, "p-id", "提供方是结算帧自己的身份，不被配置里的 p3 覆盖");
  assert.strictEqual(first?.model, "m-id", "模型同理");
  assert.strictEqual(first?.startedAt, at(0), "开始时刻仍是自己那次 step/start");
  assert.strictEqual(first?.completedAt, at(1), "收尾时刻仍是结算帧那一刻，不被晚 header 改写");
  assert.strictEqual(first?.status, "complete", "状态同样不受 header 影响");
  assert.deepStrictEqual(first?.usage, { input: 10, output: 1 }, "用量不受 header 影响");
}
console.log("trajectory: 晚 header 补该步配置且不覆盖结算身份 ✓");

// ---------- 14i-2. 落点不在步骤上的 header 只做「最近生效的配置」（F01 补完） ----------
//
// `turn/end` 之后到达的 header：官方 `ConversationLocationIndex` 此时给它的落点是**轮**
// 而不是步（`currentStep` 在 `turn/end` 上清掉），`headerStepKey()` 因此返回 undefined
// → 它不进 `headersByStep`，谁都不回写，只作为后续请求继承的配置
// （`headerFor()` 的第二条分支要求 `previous.seq < request.startSeq`，而它的 seq 更大）。
// 从前这一支会退回「最近开的助手请求」，于是**还没收尾**的那次请求被这份 header 改写。
{
  seq = 0;
  const a = { provider: "p1", model: "m-a" };
  const c = { provider: "p2", model: "m-c" };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config: a, tools: [] }, reason: "initial" }, 0),
    // 这一轮在 step/end 之前就结束了（中断 / abort）
    event("turn/end", { turn: 1, reason: "success" }, 1),
    // 落点已经不在任何一步上
    event("request/header", { header: { config: c, tools: [] }, reason: "system" }, 2),
    event("step/start", { turn: 2, step: 1 }, 2),
    event("assistant/message", {
      turn: 2,
      step: 1,
      message: message("下一轮的答", { model: "m-c" }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, 3),
    event("step/end", { turn: 2, step: 1 }, 3),
    event("turn/end", { turn: 2, reason: "success" }, 4),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first, second] = model.requests;
  assert.strictEqual(model.requests.length, 2, "两次 step/start 两次请求");
  assert.deepStrictEqual(first?.options, a, "落点不在步骤上的 header 不回写上一次请求");
  assert.strictEqual(first?.provider, "p1", "它的配置同样一个字不改");
  assert.strictEqual(first?.model, "m-a", "模型同理");
  assert.deepStrictEqual(second?.options, c, "这份 header 成为后续请求继承的配置");
  assert.strictEqual(second?.provider, "p2");
  assert.strictEqual(second?.model, "m-c");
}
console.log("trajectory: 落点不在步骤上的 header 只做后续配置 ✓");

// ---------- 14i-3. 晚到的空 header 照样整份替换（F01 补完） ----------
//
// 与 14i 同一口径，只是时序改到结算之后：空 / 不可读的 header 使上一份配置**整份失效**
// （官方 `applyHeader()` 覆盖 `requestConfig`，不是逐字段合并），而结算帧自己的身份
// （这里消息只带 `model`）不受影响——身份不是配置的一部分。
{
  seq = 0;
  const a = { provider: "p1", model: "m-a", temperature: 0.2 };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config: a, tools: [] }, reason: "initial" }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("结算帧先到", { model: "m-id" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    // 空 / 不可读的 header：载荷里连 `header` 都没有，落点仍在第 1 步
    event("request/header", {}, 2),
    event("step/end", { turn: 1, step: 1 }, 2),
    event("turn/end", { turn: 1, reason: "success" }, 3),
  ];
  const model = deriveTrajectoryModel(events, false);
  const [first] = model.requests;
  assert.strictEqual(
    first?.options,
    undefined,
    "晚到的空 header 让上一份选项整份失效（不复用配置 A）",
  );
  assert.strictEqual(first?.provider, undefined, "配置 A 的提供方跟着失效");
  assert.strictEqual(first?.model, "m-id", "模型来自结算帧自己的身份，不受空 header 影响");
  assert.strictEqual(first?.completedAt, at(1), "收尾时刻不受空 header 影响");
  assert.deepStrictEqual(first?.usage, { input: 10, output: 1 }, "用量不受空 header 影响");
}
console.log("trajectory: 晚到的空 header 整份替换 ✓");

// ---------- 14j. retry 之后同一步成功：请求改判 complete，重试历史照旧保留（F04） ----------
//
// 官方 rc.2 `assistantRequest()` 的判据（逐字见上面请求表那一组）：**非中断的最终节点
// 优先**——`assistant/message` 一到，这一步就是成功，之前那次 `llm/retry` 不再把状态
// 钉死；但它记下的重试事实（次数 / 上限 / 延迟 / 失败文案与错误码）仍留在请求上，
// 官方那份 payload 同样如此（界面靠它画「重试」那一段）。
//
// 从前这里读的是「已经是 error 就不覆盖」，于是「重试一次才成功」的请求永远显示失败，
// 而账本里的助手行是 complete——同一个事实两个状态。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial" }, 0),
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 3,
      delayMs: 250,
      mode: "normal",
      failure: { message: "503 upstream", code: "SERVER" },
    }, 1),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("重试后答出来", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 2 },
      stream: [{ type: "chunk", time: at(2.5), chunk: { type: "text-delta", index: 0, text: "重试后答出来" } }],
    }, 3),
    event("step/end", { turn: 1, step: 1 }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const model = deriveTrajectoryModel(events, false);
  const request = model.requests.find((entry) => entry.purpose === "assistant");
  assert.ok(request !== undefined, "请求进表");
  assert.strictEqual(request?.status, "complete", "同一步成功结算 → 请求 complete（不被 retry 钉死）");
  assert.strictEqual(request?.completedAt, at(3), "收尾时刻取结算帧");
  assert.deepStrictEqual(request?.retry, { attempt: 1, max: 3 }, "重试进度留在请求上");
  assert.strictEqual(request?.retryDelayMs, 250, "重试延迟留在请求上");
  assert.strictEqual(request?.error, "503 upstream", "历史失败文案留在请求上（官方 payload 同形）");
  assert.strictEqual(request?.errorCode, "SERVER", "稳定错误码同样留着");
  assert.strictEqual(request?.assistantFirstTokenTime, at(2.5), "首个 token 时刻不受重试影响");
  assert.deepStrictEqual(request?.usage, { input: 10, output: 2 });
  const assistant = model.turns.flatMap(trajectoryTurnCells).find((cell) => cell.kind === "message");
  assert.strictEqual(assistant?.status, "complete", "助手行本来就是 complete（缺陷的另一半）");
  assert.strictEqual(assistant?.error, undefined, "助手行不挂重试的失败文案");
}
console.log("trajectory: retry 后同一步成功改判 complete ✓");

// ---------- 14k. 没有成功结算的请求仍然是 error（retry / 边界 / 中断） ----------
//
// 官方那支只有在「非中断的最终节点」存在时才给 complete；否则 `retry` 或 `boundary`
// （步骤 / 轮次已关闭）任一个成立就是 error。三种形态各钉一条，防止「改成看节点」
// 之后把真正的失败一起放过：
// ① 重试过、这一步被关掉、始终没有助手消息（轮次也失败：终态失败取轮次那一份）；
// ② 没重试过但步骤被关掉（官方 `boundary` 分支）——不能停在 running；
// ③ 中断的助手消息（`interrupted: true`）不是「非中断的最终节点」，仍 error。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("step/start", { turn: 1, step: 1 }, 0),
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 3,
      maxRetries: 3,
      delayMs: 900,
      mode: "normal",
      failure: { message: "retry boom", code: "SERVER" },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 2),
    event("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { message: "turn boom", code: "SERVER" } },
    }, 3),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "error", "重试耗尽、没有成功消息 → 仍是 error");
  assert.strictEqual(request?.error, "turn boom", "终态失败取轮次那一份（覆盖重试的失败文案）");
  assert.strictEqual(request?.completedAt, at(2), "已有 completedAt（step/end）不被轮次时刻覆写");
  assert.deepStrictEqual(request?.retry, { attempt: 3, max: 3 }, "重试元数据照旧保留");
}
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("step/start", { turn: 1, step: 1 }, 0),
    // 没有 llm/retry、也没有 assistant/message：步骤关闭本身就是失败证据（官方 boundary）
    event("step/end", { turn: 1, step: 1 }, 1),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "error", "没有最终节点、步骤又关闭了 → boundary 判 error（不是 running）");
  assert.strictEqual(request?.completedAt, at(1));
  assert.strictEqual(request?.error, undefined, "没有失败证据就不编一个文案");
}
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("半截", {}),
      usage: { inputTokens: 3, outputTokens: 1 },
      interrupted: true,
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "error", "中断的助手消息不是「非中断的最终节点」");
  assert.strictEqual(request?.completedAt, at(1));
}
console.log("trajectory: 没有成功结算的请求仍是 error ✓");

// ---------- 14l. AUTH 重试之后成功：complete，且失败文案不泄露（F04） ----------
//
// `displayFailure()` 对 `AUTH` 码全清文案（提供方的认证失败消息可能回显被掩码的凭据）。
// 重试成功后状态按官方改成 complete，**清空的那份文案也不许被重新填回来**；错误码留着，
// 界面按它取本地化文案。这条同时钉住「改判 complete 不等于把历史抹掉」。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("step/start", { turn: 2, step: 1 }, 0),
    event("llm/retry", {
      turn: 2,
      step: 1,
      retry: 1,
      maxRetries: 2,
      delayMs: 400,
      mode: "normal",
      failure: { message: "invalid api key sk-abc123", code: "AUTH" },
    }, 1),
    event("assistant/message", {
      turn: 2,
      step: 1,
      message: message("这次通了", { provider: "p", model: "m" }),
      usage: { inputTokens: 5, outputTokens: 1 },
    }, 2),
    event("step/end", { turn: 2, step: 1 }, 2),
    event("turn/end", { turn: 2, reason: "success" }, 3),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "complete", "AUTH 之后重试成功 → complete");
  assert.strictEqual(request?.error, undefined, "AUTH 文案在 llm/retry 那一刻就清空，成功判不把它填回来");
  assert.strictEqual(request?.errorCode, "AUTH", "错误码留着（界面按它显示本地化文案）");
  assert.deepStrictEqual(request?.retry, { attempt: 1, max: 2 }, "重试进度照旧保留");
  assert.strictEqual(request?.retryDelayMs, 400);
  assert.ok(
    !JSON.stringify(request).includes("sk-abc123"),
    "请求序列化后也不许出现被掩码的凭据原文",
  );
}
console.log("trajectory: AUTH 重试成功不泄露文案 ✓");

// ---------- 14m. retry × F02：同一步 overflow 压缩之后成功，助手与压缩各自结算（F04） ----------
//
// 合法时序：`step/start → assistant/attempt 失败 → llm/retry → compaction/start /
// summary / end → request/header → **同一步** assistant/message 成功 → step/end`。
// 两次模型请求各自结算：助手 complete（重试历史留着）、压缩 complete（自己的用量）；
// 编号 / 选项 / 计时 / 累计都不许串（F02 的断言在 14b，这里叠加重试那一层）。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 3 }, 0),
    event("step/start", { turn: 3, step: 1 }, 0),
    event("assistant/attempt", { turn: 3, step: 1, stream: [] }, 1),
    event("llm/retry", {
      turn: 3,
      step: 1,
      retry: 2,
      maxRetries: 4,
      delayMs: 120,
      mode: "normal",
      failure: { message: "上下文溢出", code: "CONTEXT_OVERFLOW" },
    }, 1),
    event("compaction/start", { turn: 3, compactionId: "k9" }, 1),
    event("compaction/summary", {
      compactionId: "k9",
      summary: block("溢出摘要"),
      usage: { inputTokens: 6, outputTokens: 2 },
    }, 2),
    event("compaction/end", { compactionId: "k9" }, 2),
    event("request/header", {
      header: { config: { provider: "p", model: "m", maxTokens: 8192 }, tools: [] },
      reason: "initial",
    }, 2),
    event("assistant/message", {
      turn: 3,
      step: 1,
      message: message("压缩后成功", { provider: "p", model: "m" }),
      usage: { inputTokens: 20, outputTokens: 4 },
      // 首个 token 必须早于结算帧（`assistant/message` 在 at(4)）：用 at(3.5) 这个合法时刻。
      stream: [{ type: "chunk", time: at(3.5), chunk: { type: "text-delta", index: 0, text: "压缩后成功" } }],
    }, 4),
    event("step/end", { turn: 3, step: 1 }, 4),
    event("turn/end", { turn: 3, reason: "success" }, 5),
  ];
  const model = deriveTrajectoryModel(events, false);
  const assistant = model.requests.find((entry) => entry.purpose === "assistant");
  const compaction = model.requests.find((entry) => entry.purpose === "compaction");
  assert.deepStrictEqual(
    model.requests.map((entry) => [entry.number, entry.purpose]),
    [[1, "assistant"], [2, "compaction"]],
    "助手先开号、压缩后开号（重试不改变请求身份）",
  );
  assert.strictEqual(assistant?.status, "complete", "同一步成功 → 助手请求 complete");
  assert.strictEqual(assistant?.errorCode, "CONTEXT_OVERFLOW", "重试事实留在助手请求上");
  assert.deepStrictEqual(assistant?.usage, { input: 20, output: 4 }, "助手用量是它自己那一次");
  assert.deepStrictEqual(
    assistant?.options,
    { provider: "p", model: "m", maxTokens: 8192 },
    "选项挂在助手请求上（不是压缩请求）",
  );
  assert.strictEqual(assistant?.startedAt, at(0), "开始时刻是它自己那次 step/start");
  assert.strictEqual(assistant?.completedAt, at(4));
  assert.strictEqual(assistant?.assistantFirstTokenTime, at(3.5), "首个 token 时刻落在助手请求上（且早于结算帧）");
  assert.deepStrictEqual(compaction?.usage, { input: 6, output: 2 }, "压缩请求有自己的用量");
  assert.strictEqual(compaction?.status, "complete", "压缩请求独立结算");
  assert.strictEqual(compaction?.options, undefined, "压缩请求不接助手那份选项");
  assert.deepStrictEqual(assistant?.cumulativeUsage, { input: 20, output: 4 }, "助手是 #1，累计就是它自己");
  assert.deepStrictEqual(compaction?.cumulativeUsage, { input: 26, output: 6 }, "压缩是 #2，累计含两次");
  assert.deepStrictEqual(
    model.turns.flatMap(trajectoryTurnCells).map((cell) => [cell.kind, cell.requestNumber, cell.status]),
    [["system", undefined, "complete"], ["compacted", 2, "complete"], ["message", 1, "complete"]],
    "助手行挂 #1 且 complete，压缩行挂 #2（归属不串）",
  );
}
console.log("trajectory: retry × overflow 压缩各自结算 ✓");

// ---------- 14n. 结构化 turn/end 失败：覆盖该轮最后一条助手请求（F04 补完） ----------
//
// 固定 rc.2 的 `turn/end.reason` 是**结构化联合**（`packages/core/session/src/types.ts` 的
// `TurnEndReasonMap`：`completed` / `aborted` / `blocked` / `error` / `max-tokens` /
// `interrupted` / `forked`）。官方 `trajectoryTurnEndDefinition` 只认一种失败：
//
//     const failure = reason.kind === 'error' ? displayFailure(reason.error) : undefined
//
// 会话流那一侧一直这么读（`adapter.ts` 的 `turn/end` 分支读 `reason.kind` 与
// `reason.error.message`），账本侧从前只读 string → **真实的结构化错误整类被忽略**。
//
// 官方 `applyTurnErrors()`：该轮**最后一条助手请求**改判 `error`，`error` / `errorCode`
// 覆盖成轮次那一份，`completedAt` 只在缺失时取轮次结束时刻（已有值不覆写）——所以
// 「重试过一次、又成功结算」的请求最后仍是这一轮的失败（terminal failure 是权威）。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 3,
      delayMs: 100,
      mode: "normal",
      failure: { code: "SERVER", message: "retry failure" },
    }, 1),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("看起来成功了", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 2 },
    }, 2),
    event("step/end", { turn: 1, step: 1 }, 2),
    event("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "SERVER", message: "turn failure" } },
    }, 3),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "error", "轮次失败覆盖已经成功的节点（官方 applyTurnErrors）");
  assert.strictEqual(request?.error, "turn failure", "失败文案换成轮次那一份（不是重试那一份）");
  assert.strictEqual(request?.errorCode, "SERVER", "错误码同样换成轮次那一份");
  assert.strictEqual(request?.completedAt, at(2), "已有 completedAt（结算帧）不被轮次结束时刻覆写");
  assert.deepStrictEqual(request?.retry, { attempt: 1, max: 3 }, "重试元数据照旧保留");
  assert.strictEqual(request?.retryDelayMs, 100);
}
console.log("trajectory: 结构化轮次错误覆盖最后助手请求 ✓");

// ---------- 14o. 轮次关闭的边界收尾 + 「只有 error 才算失败」的成功枚举（F04 补完） ----------
//
// 官方 `closedBoundary()` 认两种边界：**step 已关闭**或 **turn 已关闭**
// （`packages/core/session/src/types.ts` 的 `turn/end` 注释也写明「没有进入任何 step 的轮次
// 根本没有 step/start / step/end」）。没有最终节点的助手请求由边界判 `error`，
// 收尾时刻取边界时刻——本扩展先前的边界分支只覆盖 `step/end`，缺 `step/end` 的轮次
// 会永远停在 running。
//
// 另外，`TurnEndReasonMap` 里只有 `error` 是模型失败：`aborted`（取消）/ `max-tokens`
// （截断）/ `blocked` / `interrupted` / `forked` 都不许把请求画成失败。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 2 }, 0),
    event("step/start", { turn: 2, step: 1 }, 0),
    // 没有 step/end、也没有 assistant/message：轮次关闭本身就是失败证据
    event("turn/end", { turn: 2, reason: { kind: "completed" } }, 2),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "error", "没有最终节点、轮次关闭 → 边界判 error");
  assert.strictEqual(request?.completedAt, at(2), "收尾时刻取轮次结束时刻（这一轮没有 step/end）");
  assert.strictEqual(request?.error, undefined, "没有失败证据就不编文案");
}
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 3 }, 0),
    event("step/start", { turn: 3, step: 1 }, 0),
    event("assistant/message", {
      turn: 3,
      step: 1,
      message: message("答", { provider: "p", model: "m" }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }, 1),
    event("turn/end", { turn: 3, reason: { kind: "completed" } }, 2),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "complete", "有成功节点 + 轮次无失败 → 仍 complete（边界不误伤）");
  assert.strictEqual(request?.completedAt, at(1), "收尾时刻仍取结算帧，不被轮次时刻覆写");
}
for (const kind of ["aborted", "max-tokens", "blocked", "interrupted", "forked"] as const) {
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 4 }, 0),
    event("step/start", { turn: 4, step: 1 }, 0),
    event("assistant/message", {
      turn: 4,
      step: 1,
      message: message("半截", { provider: "p", model: "m" }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 4, step: 1 }, 1),
    event("turn/end", {
      turn: 4,
      reason: kind === "aborted" ? { kind, reason: { kind: "user" } } : { kind },
    }, 2),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "complete", `kind=${kind} 不是模型失败（只有 error 才算）`);
  assert.strictEqual(request?.error, undefined, `kind=${kind} 不挂失败文案`);
}
console.log("trajectory: 轮次边界收尾与成功枚举 ✓");

// ---------- 14p. AUTH 轮次错误：失败证据在，文案与凭据不留（F04 补完） ----------
//
// `displayFailure()` 对 `AUTH` 码清空文案（可能回显被掩码的凭据）。轮次错误同样要过它：
// **空文案也是失败证据**——状态判 error、`errorCode` 留着（界面按它取本地化说法），
// 但序列化后的模型里一个字都不许出现。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("答", { provider: "p", model: "m" }),
      usage: { inputTokens: 2, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    event("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "AUTH", message: "invalid api key sk-turn-secret" } },
    }, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  const request = model.requests[0];
  assert.strictEqual(request?.status, "error", "AUTH 依然是失败（不是「没有文案就不算」）");
  assert.strictEqual(request?.errorCode, "AUTH", "错误码留着，界面按它取本地化文案");
  assert.strictEqual(request?.error, undefined, "AUTH 文案清空，不落到请求上");
  assert.strictEqual(request?.completedAt, at(1), "已完成时刻不覆写");
  assert.ok(
    !JSON.stringify(model).includes("sk-turn-secret"),
    "整个模型序列化后都不许出现凭据原文",
  );
  const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
  assert.strictEqual(cell?.status, "error", "账本行同样判失败（行上没有错误码字段）");
  assert.strictEqual(cell?.error, undefined, "空文案不写进行里（界面上不画一条空的错误行）");
}
console.log("trajectory: AUTH 轮次错误不泄露文案 ✓");

// ---------- 14q. 轮次错误只落该轮最后一条助手请求（多步 / 多轮 / 尾部压缩） ----------
//
// 官方 `applyTurnErrors()` 先按 `turn` 建「最后一条助手请求」的索引，再改写它：
// 更早的请求、别的轮次、压缩请求都不受影响。本扩展按**实际 `turn` 身份**找，
// 不拿「最后开的那次请求」代替——尾部压缩时那个值正是压缩请求（F02 同一个坑）。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    // 第 1 轮：两步都成功（该轮最后一条助手请求是第 2 步那次）
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("第一步的答", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    event("step/start", { turn: 1, step: 2 }, 2),
    event("assistant/message", {
      turn: 1,
      step: 2,
      message: message("第二步的答", { provider: "p", model: "m" }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, 3),
    event("step/end", { turn: 1, step: 2 }, 3),
    // 第 1 轮**尾部压缩**：它才是最后开的那次请求，但不是「最后一条助手请求」
    event("compaction/start", { turn: 1, compactionId: "k1" }, 4),
    event("compaction/summary", {
      compactionId: "k1",
      summary: block("尾部压缩"),
      usage: { inputTokens: 3, outputTokens: 1 },
    }, 4),
    event("compaction/end", { compactionId: "k1" }, 4),
    event("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "SERVER", message: "第一轮失败" } },
    }, 5),
    // 第 2 轮：成功，不许被第 1 轮的失败误伤
    event("turn/start", { turn: 2 }, 6),
    event("step/start", { turn: 2, step: 1 }, 6),
    event("assistant/message", {
      turn: 2,
      step: 1,
      message: message("下一轮的答", { provider: "p", model: "m" }),
      usage: { inputTokens: 30, outputTokens: 3 },
    }, 7),
    event("step/end", { turn: 2, step: 1 }, 7),
    event("turn/end", { turn: 2, reason: { kind: "completed" } }, 8),
  ];
  const model = deriveTrajectoryModel(events, false);
  assert.deepStrictEqual(
    model.requests.map((request) => [request.number, request.purpose, request.turn, request.status]),
    [
      [1, "assistant", 1, "complete"],
      [2, "assistant", 1, "error"],
      [3, "compaction", 1, "complete"],
      [4, "assistant", 2, "complete"],
    ],
    "轮次错误只落第 1 轮的最后一条助手请求（更早的、压缩的、下一轮的都不动）",
  );
  assert.strictEqual(model.requests[1]?.error, "第一轮失败");
  assert.strictEqual(model.requests[1]?.errorCode, "SERVER");
  assert.strictEqual(model.requests[0]?.error, undefined, "更早的助手请求不背这一轮的失败");
  assert.strictEqual(model.requests[2]?.error, undefined, "压缩请求不背助手那一份失败");
  assert.deepStrictEqual(model.requests[2]?.usage, { input: 3, output: 1 }, "压缩请求的用量照旧");
  assert.strictEqual(model.requests[3]?.error, undefined, "下一轮的请求不受影响");
  assert.deepStrictEqual(
    model.requests.map((request) => request.cumulativeUsage),
    [
      { input: 10, output: 1 },
      { input: 30, output: 3 },
      { input: 33, output: 4 },
      { input: 63, output: 7 },
    ],
    "累计按请求号顺序（状态改判不影响用量）",
  );
  const cells = model.turns.flatMap(trajectoryTurnCells);
  assert.deepStrictEqual(
    cells.filter((cell) => cell.kind === "message").map((cell) => [cell.requestNumber, cell.status]),
    [[1, "complete"], [2, "error"], [4, "complete"]],
    "账本行同样只改第 1 轮最后那条助手行",
  );
}
console.log("trajectory: 轮次错误只落最后一条助手请求 ✓");

// ---------- 14r. 终态失败真正覆盖前诊断：AUTH 空文案把重试文案清成缺席 ----------
//
// 官方 `applyTurnErrors()` 是**覆盖**：`error: ending.error`。`displayFailure()` 对 AUTH 给出的
// 是空文案，所以公开模型里不能再留着 `llm/retry` 那一份 `error`（`retry failure`）——否则
// 「这一轮最后是认证失败」被伪装成「重试时的服务端错误」。
//
// 关键口径：**「确有终态失败」是肯定证据**（`reason.kind === 'error'`），不能从「文案非空」
// 或「错误码存在」反推——AUTH 恰好两样都不成立（文案空、旧错误码可能已经有了）。落地两步：
// 先记住这份肯定证据，覆盖时再把空文案规范化为**缺席**（公开模型里不写空串）。
// 重试元数据（次数 / 上限 / 延迟）不是诊断，照旧保留。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 3,
      delayMs: 100,
      mode: "normal",
      failure: { code: "SERVER", message: "retry failure" },
    }, 0.1),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("成功了", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 2 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1.1),
    event("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "AUTH", message: "auth-contract-secret" } },
    }, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  const request = model.requests[0];
  assert.strictEqual(request?.status, "error", "终态是失败");
  assert.strictEqual(request?.error, undefined, "终态诊断覆盖前诊断：重试文案被清成缺席");
  assert.strictEqual(request?.errorCode, "AUTH", "错误码换成终态那一份");
  assert.strictEqual(request?.completedAt, at(1), "已有 completedAt 不被轮次结束时刻覆写");
  assert.deepStrictEqual(request?.retry, { attempt: 1, max: 3 }, "重试元数据保留");
  assert.strictEqual(request?.retryDelayMs, 100);
  assert.ok(!JSON.stringify(model).includes("auth-contract-secret"), "AUTH 原文不进公开模型");
}
console.log("trajectory: 终态 AUTH 清除前诊断 ✓");

// ---------- 14s. 边界补收尾时刻与状态判定分开（无 message / 无 step/end） ----------
//
// 官方 `assistantRequest()` 里 `completedAt` 与 `status` 是两条独立判据：时刻取
// `node?.time ?? boundary?.time ?? null`，状态才看「有没有非中断的最终节点」。
// 所以「`llm/retry` 已经把它标成 error」不能成为**不补收尾时刻**的理由——否则这一次请求
// 永远停在 `completedAt: null`，计时面板与时间线把它当成还在跑。
// 没有终态失败时既有诊断（重试那一份）同样不许被抹掉。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 2,
      maxRetries: 4,
      delayMs: 250,
      mode: "normal",
      failure: { code: "SERVER", message: "retry failure" },
    }, 0.1),
    // 没有 assistant/message、也没有 step/end：轮次关闭就是边界
    event("turn/end", { turn: 1, reason: { kind: "completed" } }, 2),
  ];
  const request = deriveTrajectoryModel(events, false).requests[0];
  assert.strictEqual(request?.status, "error", "没有最终成功节点 → 仍 error");
  assert.strictEqual(request?.error, "retry failure", "没有终态失败就不动既有诊断");
  assert.strictEqual(request?.errorCode, "SERVER");
  assert.strictEqual(request?.completedAt, at(2), "缺收尾时刻按边界补上（轮次结束时刻）");
  assert.deepStrictEqual(request?.retry, { attempt: 2, max: 4 }, "重试元数据保留");
  assert.strictEqual(request?.retryDelayMs, 250);
}
console.log("trajectory: 边界补收尾时刻与状态分开 ✓");

// ---------- 14t. 中断的助手消息在步骤关闭之前仍然算「还在跑」（F04 补完） ----------
//
// 官方 `assistantRequest()` 的状态是三分支：**非中断的最终节点** → `complete`；否则
// `state.retry !== undefined || boundary !== undefined` → `error`；**两者都没有 → `running`**。
// 中断的 `assistant/message` 是「节点存在、但不是非中断的最终节点」——它只在步骤/轮次
// 关闭（boundary）或重试（retry）出现之后才判失败，在那之前这一次请求仍在跑。
// 收尾时刻与状态是两条独立判据（`completedAt = node?.time ?? boundary?.time ?? null`），
// 所以边界还没到时它已经有节点自己的时刻。
//
// 账本行是另一件事：那一行就是「被中断」的助手记录（界面词典的 `@interrupted`），
// 与请求状态无关。
{
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", {
      header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial",
    }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      interrupted: true,
      message: message("半截", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    // 这个窗口就停在这一帧：没有 step/end、也没有 turn/end
  ], false);
  const [request] = model.requests;
  assert.strictEqual(
    request?.status,
    "running",
    "中断消息不是「非中断的最终节点」，但又没有重试、也没有关闭边界 → 仍在跑（官方 running）",
  );
  assert.strictEqual(request?.completedAt, at(1), "收尾时刻仍取节点自己的时刻");
  assert.strictEqual(request?.error, undefined, "没有失败证据就不编文案");
  const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
  assert.strictEqual(cell?.status, "error", "账本行仍是「被中断」那一行");
  assert.strictEqual(cell?.error, "@interrupted");
}
{
  // 同样的中断消息，但步骤关掉了：boundary 成立 → 失败
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      interrupted: true,
      message: message("半截", {}),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
  ], false);
  assert.strictEqual(model.requests[0]?.status, "error", "步骤关闭（boundary）之后才判失败");
}
{
  // 中断消息之后又重试：retry 本身就是失败证据
  seq = 0;
  const request = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      interrupted: true,
      message: message("半截", {}),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 2,
      delayMs: 100,
      mode: "normal",
      failure: { message: "again", code: "SERVER" },
    }, 2),
  ], false).requests[0];
  assert.strictEqual(request?.status, "error", "重试出现即判失败");
  assert.strictEqual(request?.error, "again");
  assert.deepStrictEqual(request?.retry, { attempt: 1, max: 2 });
}
console.log("trajectory: 中断消息在边界之前仍算还在跑 ✓");

// ---------- 14u. 同一轮重复 turn/end：先到的失败收尾不被后到的成功收尾抹掉（F04 补完） ----------
//
// 官方 `trajectoryTurnEndDefinition` 的 contribution id 是 `String(event.seq)`——同一轮
// 来两条 `turn/end` 就是**两条** contribution，`snapshot()` 把它们全收进 `turnEndings`，
// 而 `applyTurnErrors()` **逐条**处理：每条带失败的都覆盖该轮最后一条助手请求。
// 成功收尾（`reason.kind === 'completed'`）不带错误，于是它既不新增诊断、也**不撤销**
// 先前那条失败留下的诊断。
//
// 「边界补收尾时刻」那一份边界取**最后一条** `turn/end` 的事件（位置索引里的 `turn.end`
// 被后者覆盖），与失败诊断是两条独立判据。
{
  // ① 先失败、后成功：失败证据必须留下
  seq = 0;
  const request = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("答完了", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 2),
    event("turn/end", { turn: 1, reason: { kind: "error", error: { message: "轮次挂了", code: "SERVER" } } }, 3),
    event("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
  ], false).requests[0];
  assert.strictEqual(request?.status, "error", "后到的成功收尾不许把先到的失败抹成 complete");
  assert.strictEqual(request?.error, "轮次挂了", "失败文案留着");
  assert.strictEqual(request?.errorCode, "SERVER");
  assert.strictEqual(request?.completedAt, at(1), "已有节点时刻不被边界覆写");
  assert.deepStrictEqual(request?.usage, { input: 10, output: 1 }, "用量不受影响");
}
{
  // ② 先成功、后失败：一样判失败（与顺序无关）
  seq = 0;
  const request = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("答完了", {}),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("turn/end", { turn: 1, reason: { kind: "completed" } }, 2),
    event("turn/end", { turn: 1, reason: { kind: "error", error: { message: "轮次挂了", code: "SERVER" } } }, 3),
  ], false).requests[0];
  assert.strictEqual(request?.status, "error", "失败收尾在任何位置都算失败");
  assert.strictEqual(request?.error, "轮次挂了");
  assert.strictEqual(request?.errorCode, "SERVER");
}
{
  // ③ 两条失败收尾：最后一条那一份生效
  seq = 0;
  const request = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("答完了", {}),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("turn/end", { turn: 1, reason: { kind: "error", error: { message: "第一份", code: "A" } } }, 2),
    event("turn/end", { turn: 1, reason: { kind: "error", error: { message: "第二份", code: "B" } } }, 3),
  ], false).requests[0];
  assert.strictEqual(request?.error, "第二份", "后一条失败收尾覆盖前一条的文案");
  assert.strictEqual(request?.errorCode, "B");
}
{
  // ④ 没有结算帧的请求：边界时刻取最后一条 turn/end，失败诊断仍来自前一条失败收尾
  seq = 0;
  const request = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("turn/end", { turn: 1, reason: { kind: "error", error: { message: "第一份", code: "A" } } }, 2),
    event("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
  ], false).requests[0];
  assert.strictEqual(request?.status, "error", "轮次关闭（boundary）→ 没有成功节点的请求判失败");
  assert.strictEqual(request?.completedAt, at(4), "边界时刻取最后一条 turn/end");
  assert.strictEqual(request?.error, "第一份", "成功收尾不带诊断，先前的失败诊断留着");
  assert.strictEqual(request?.errorCode, "A");
}
console.log("trajectory: 同轮重复 turn/end 的失败诊断不被成功收尾抹掉 ✓");

// ---------- 14v. 显式身份查不到请求：不许把结算落到别的请求上（F03） ----------
//
// 官方的节点身份**逐帧来自事件自己**：`trajectoryAssistantDefinition.match()` 对
// `assistant/message` / `assistant/attempt` / `llm/retry` / `step/end` 一律取
// `${data.turn}:${data.step}`；窗口里没有该步的 `step/start`（跟随窗口从半截开始，
// 或流本身把身份指到没开过的步骤）时，官方走 `fallbackState()` 重建一个
// `started: false` 的状态——`assistantRequest()` 立刻返回 `undefined`，**那一步压根
// 没有请求**。官方从不把结算挂到别的步骤上：`fallbackState()` 只看这个身份自己的
// 匹配事件，`llm/retry` 在它里面连分支都没有。
//
// 本扩展的请求表按 `turn:step` 建（`step/start` 开），找不到时从前会回落到「最后
// 一次开的助手请求」——于是越界帧的用量、收尾时刻、提供方身份与状态全落到**另一个
// 步骤**的请求上，那一行也拿到一个不属于它的请求号。
{
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("request/header", {
      header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial",
    }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("第一步的答", { provider: "p", model: "m" }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("step/end", { turn: 1, step: 1 }, 1),
    // 越界帧：整个窗口里没有 `turn 1 / step 2` 的 `step/start`
    event("assistant/message", {
      turn: 1,
      step: 2,
      message: message("没有开始的步骤", { provider: "x", model: "y" }),
      usage: { inputTokens: 999, outputTokens: 99 },
    }, 5),
  ], false);
  assert.strictEqual(
    model.requests.length,
    1,
    "越界帧不新开请求（官方那一步没有 step/start，也就没有请求）",
  );
  const request = model.requests[0];
  assert.strictEqual(request?.completedAt, at(1), "第 1 步请求的收尾时刻不被越界帧改写");
  assert.strictEqual(request?.status, "complete", "状态仍是它自己那一次结算");
  assert.deepStrictEqual(request?.usage, { input: 10, output: 1 }, "用量不落到别的请求上");
  assert.strictEqual(request?.cumulativeUsage?.input, 10, "累计用量同样不受影响");
  assert.strictEqual(request?.provider, "p", "身份不被越界帧覆盖");
  assert.strictEqual(request?.model, "m");
  const stray = model.turns
    .flatMap(trajectoryTurnCells)
    .find((cell) => cell.previewMarkdown === "没有开始的步骤");
  assert.ok(stray, "越界帧自己的记录行照旧要出（官方那时仍然发布助手节点）");
  assert.strictEqual(stray?.step, 2, "行的步骤取帧自己的身份，不是窗口当前步");
  assert.strictEqual(stray?.requestNumber, undefined, "它挂不上请求号——官方那一步没有任何请求");
  assert.strictEqual(stray?.assistantMetrics?.timingRecorded, false, "没有 step/start 就没有步骤开始时刻");
  assert.strictEqual(stray?.assistantMetrics?.stepStartTime, null);
  assert.strictEqual(stray?.usage?.input, 999, "用量留在记录行自己身上");
}
{
  // 同一口径也管 `llm/retry`：官方 `fallbackState()` 里根本没有这一帧的分支，
  // 没有 `step/start` 时它落不到任何节点上，更不会把别的请求判成失败。
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("答完了", {}),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, 1),
    event("llm/retry", {
      turn: 1,
      step: 2,
      retry: 1,
      maxRetries: 2,
      delayMs: 100,
      mode: "normal",
      failure: { message: "越界重试", code: "SERVER" },
    }, 2),
  ], false);
  assert.strictEqual(model.requests.length, 1, "越界 retry 不新开请求");
  assert.strictEqual(model.requests[0]?.status, "complete", "越界 retry 不把别的请求判成失败");
  assert.strictEqual(model.requests[0]?.error, undefined, "失败文案不落到别的请求上");
  assert.strictEqual(model.requests[0]?.retry, undefined, "重试进度同样不落过去");
}
{
  // 兜底只留给**帧自己没带身份**的畸形帧（防御路径：官方契约里这两个字段必带）：
  // 那时才退回「窗口当前步」的请求，`assistant/attempt` 与 `assistant/message` 同口径。
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("assistant/message", {
      message: message("没带坐标", {}),
      usage: { inputTokens: 5, outputTokens: 1 },
    }, 1),
  ], false);
  assert.strictEqual(model.requests.length, 1);
  assert.strictEqual(model.requests[0]?.completedAt, at(1), "没有坐标的帧退回窗口当前步的请求");
  assert.strictEqual(model.requests[0]?.status, "complete");
  assert.deepStrictEqual(model.requests[0]?.usage, { input: 5, output: 1 });
}
console.log("trajectory: 显式身份查不到请求时不回落到别的请求 ✓");

// ---------- 15. 调用在窗口之外的「只有结果」行也要带请求号 ----------
//
// 全量扫描 438 份真实日志时抓到过唯一一条没有请求号的行：一个多出来的 `tool/result`
// （真机上是 `TOOL_NOT_STARTED` 那种失败信封，带 `callId` 但这个 callId 没有对应的
// `tool/call` 在窗口里）。补出来的行从前不带请求号，于是它成了账本里唯一挂不上请求的行
// （请求级检查器点不到它的请求标记）。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 1 }, 0),
    event("user/message", userMessage("问", { kind: "user" }), 0),
    event("assistant/message", {
      turn: 0,
      step: 1,
      message: message("答", {}),
    }, 1),
    // callId 在窗口里没有对应的 tool/call：官方走「只有结果」那一支
    event("tool/result", {
      turn: 0,
      step: 1,
      error: "TOOL_NOT_STARTED",
      message: { content: block("TOOL_NOT_STARTED"), source: { callId: "missing" }, isError: true },
    }, 2),
    event("turn/end", { turn: 0, reason: "error" }, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  const orphan = model.turns.flatMap(trajectoryTurnCells).find((cell) => cell.callId === "missing");
  assert.ok(orphan, "没有对应调用的结果要单独出一行（分页边界也会这样）");
  assert.strictEqual(orphan?.requestNumber, 1, "补出来的结果行同样属于当前请求");
  assert.ok(
    model.requests.some((request) => request.number === orphan?.requestNumber),
    "它的请求号在请求表里找得到",
  );
}
console.log("trajectory: 窗口外的结果行带请求号 ✓");

// ---------- 16. 首个 token 时刻的第二条来源：assistant/attempt ----------
//
// 官方 `settleTiming()` 对 `assistant/message` 与 `assistant/attempt` **都**取
// `data.stream` 的首个 `time`，且是「先到者胜」（`state.firstTokenTime ?? 新值`）。
// 只读助手消息的话，「模型调用失败重试、只留下 attempt」那些 step 的 TTFT 就一直是
// 不可用——实测本机 161 个带 attempt 的 step 里有 52 个正是这种。
{
  /**
   * 合法的 raw 记录信封。从前这里是 `[{ type: 'text', text: 'x', time }]`——那不是
   * 官方 `AssistantStreamRecord`（时刻在记录上、chunk 在 `chunk` 里），旧读法只认
   * `.time` 才碰巧通过；F03 按官方判据读之后夹具必须是合法信封，期望值一个不改。
   */
  const streamAt = (time: number) => [
    { type: "chunk", time, chunk: { type: "text-delta", index: 0, text: "x" } },
  ];

  // 16a. 只有 attempt 带时刻：照样要能补出 TTFT
  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 0 }, 0),
      event("step/start", { turn: 0, step: 0 }, 0),
      event("request/header", {
        header: { config: { provider: "p", model: "m" } },
        reason: "initial",
      }, 0),
      event("assistant/attempt", { turn: 0, step: 0, stream: streamAt(at(2)) }, 1),
      event("assistant/message", {
        turn: 0,
        step: 0,
        message: message("答", {}),
        usage: { inputTokens: 1, outputTokens: 1 },
      }, 3),
      event("turn/end", { turn: 0, reason: "success" }, 3),
    ];
    const model = deriveTrajectoryModel(events, false);
    const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
    assert.strictEqual(
      cell?.assistantMetrics?.firstTokenTime,
      at(2),
      "助手消息不带 stream 时刻时，要用 assistant/attempt 补上（否则 TTFT 永远「不可用」）",
    );
    assert.strictEqual(
      model.requests[0]?.assistantFirstTokenTime,
      at(2),
      "请求表里那一份也要跟着补（请求级计时面板吃它）",
    );
  }

  // 16b. 两边都带：**先到的 attempt 胜**，助手消息不覆盖
  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 0 }, 0),
      event("step/start", { turn: 0, step: 0 }, 0),
      event("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 0),
      event("assistant/attempt", { turn: 0, step: 0, stream: streamAt(at(2)) }, 1),
      event("assistant/message", {
        turn: 0,
        step: 0,
        message: message("答", {}),
        stream: streamAt(at(9)),
        usage: { inputTokens: 1, outputTokens: 1 },
      }, 3),
      event("turn/end", { turn: 0, reason: "success" }, 3),
    ];
    const model = deriveTrajectoryModel(events, false);
    const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
    assert.strictEqual(
      cell?.assistantMetrics?.firstTokenTime,
      at(2),
      "首个 token 时刻「先到者胜」（官方 `firstTokenTime ?? 新值`），后到的助手消息不许覆盖",
    );
  }

  // 16c. 只有助手消息带时刻：那条路仍然要能取到（别把原来源改坏）


  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 0 }, 0),
      event("step/start", { turn: 0, step: 0 }, 0),
      event("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 0),
      event("assistant/message", {
        turn: 0,
        step: 0,
        message: message("答", {}),
        stream: streamAt(at(4)),
        usage: { inputTokens: 1, outputTokens: 1 },
      }, 5),
      event("turn/end", { turn: 0, reason: "success" }, 5),
    ];
    const model = deriveTrajectoryModel(events, false);
    const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
    assert.strictEqual(cell?.assistantMetrics?.firstTokenTime, at(4), "没有 attempt 时照旧取助手消息里的时刻");
    assert.strictEqual(model.requests[0]?.assistantFirstTokenTime, at(4), "请求表同样");
  }
}
console.log("trajectory: 首个 token 时刻的两条来源（attempt 优先） ✓");

// ---------- 16d. 首个 token 的官方读法（F03） ----------
/**
 * 官方 `packages/llm/llm/src/assistant-stream.ts`（固定提交 `639ed015…`，
 * 即 `refs/tags/dsh-v0.2.0-rc.2`）的三条判据：
 *
 * - `isTokenDelta`：`text-delta` / `reasoning-delta` 判 `text !== ''`——**空白字符串
 *   也算 token**，不 trim；`tool-call-delta` 判 `argumentsDelta !== '' || name !== undefined`
 *   （只带名字的片段照样算，名字是空串也算「带了名字」；连名字都没有且参数为空才跳过）；
 *   其余块（`block-start` / `block-end` / `usage` / `finish`）一律不算。
 * - `runFirstTokenTime`：packed run 的成员时刻是 `time0 + Σdt`；带 `name` 的工具 run
 *   从 `time0` 起就是 token，否则取首个**非空**片段。
 * - `assistantStreamFirstTokenTime`：按记录顺序取第一个命中；裸 `{time}` 不是合法
 *   记录，不能拿它冒充首 token 时刻。
 *
 * 从前这里只读 `stream[0].time`：非 token 帧与空片段被当成首 token，而 packed run
 * （记录里根本没有 `time` 字段）永远折不出时刻——那些请求的 TTFT / 生成 / 吞吐
 * 一直是「不可用」。判据不是「界面上看不看得见」（那是 `isVisibleChunk`）。
 */
{
  /** 合法的 raw 记录信封（`{type:'chunk', time, chunk}`）。 */
  const raw = (offset: number, chunk: Record<string, unknown>) => ({ type: "chunk", time: at(offset), chunk });
  const text = (offset: number, value = "答") => raw(offset, { type: "text-delta", index: 0, text: value });
  const blockStart = (offset: number) => raw(offset, { type: "block-start", index: 0, blockType: "text" });
  const usageChunk = (offset: number) => raw(offset, { type: "usage", usage: { inputTokens: 1, outputTokens: 0 } });
  const finish = (offset: number) => raw(offset, { type: "finish", reason: "stop" });
  const toolDelta = (offset: number, value: Record<string, unknown>) =>
    raw(offset, { type: "tool-call-delta", index: 0, id: "call-1", ...value });

  /** 一个 step 的结算时序：`step/start` 在 at(1)、`assistant/message` 在 at(2)。 */
  const settle = (stream?: unknown, attempt?: unknown, attemptFirst = true): TrajectoryModel => {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 0 }, 0.5),
      event("step/start", { turn: 0, step: 1 }, 1),
      event("user/message", userMessage("问", { kind: "user" }), 1),
      event("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 1),
    ];
    const messageEvent = () => event("assistant/message", {
      turn: 0,
      step: 1,
      message: message("答", { model: "m" }),
      usage: { inputTokens: 10, outputTokens: 3 },
      ...(stream === undefined ? {} : { stream }),
    }, 2);
    const attemptEvent = () => event("assistant/attempt", { turn: 0, step: 1, stream: attempt ?? [] }, attemptFirst ? 1.9 : 2.1);
    if (attemptFirst) {
      if (attempt !== undefined) events.push(attemptEvent());
      events.push(messageEvent());
    } else {
      events.push(messageEvent());
      if (attempt !== undefined) events.push(attemptEvent());
    }
    events.push(
      event("step/end", { turn: 0, step: 1 }, 2.5),
      event("turn/end", { turn: 0, reason: "success" }, 3),
    );
    return deriveTrajectoryModel(events, false);
  };
  const metricsOf = (model: TrajectoryModel) => {
    const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
    assert.ok(cell?.assistantMetrics !== undefined, "账本里要有带计时的助手行");
    return cell.assistantMetrics;
  };
  /** 记录级计时与请求级计时**必须同值**（官方同一个 step 一份 state）。 */
  const tokenPair = (model: TrajectoryModel): [number | null, number | null] => [
    metricsOf(model).firstTokenTime,
    model.requests[0]?.assistantFirstTokenTime ?? null,
  ];
  const expectToken = (model: TrajectoryModel, expected: number | null, label: string) =>
    assert.deepStrictEqual(tokenPair(model), [expected, expected], label);

  // 基准：非 token 的 1100 不误计，首个真 token 1700、结算 2000 → TTFT 700 / 解码 300
  {
    const model = settle([blockStart(1.1), usageChunk(1.2), text(1.3, ""), text(1.7)]);
    expectToken(model, at(1.7), "非 token 帧与空片段不算，首个真 token 在 1700");
    const metrics = metricsOf(model);
    assert.strictEqual(metrics.stepStartTime, at(1), "步骤开始时刻取 step/start");
    assert.strictEqual(metrics.completedTime, at(2), "收尾时刻取结算帧");
    assert.strictEqual(metrics.firstTokenTime! - metrics.stepStartTime!, 700, "TTFT = 首个 token − 步骤开始 = 700");
    assert.strictEqual(metrics.completedTime! - metrics.firstTokenTime!, 300, "解码 = 收尾 − 首个 token = 300");
  }

  // packed run：成员时刻 = time0 + Σdt
  expectToken(
    settle([{ type: "text-chunks", time0: at(1.2), index: 0, dt: [200, 300], texts: ["", "", "答"] }]),
    at(1.7),
    "packed 文本：首个非空片段按 time0 + Σdt（1200+200+300）",
  );
  expectToken(
    settle([{ type: "reasoning-chunks", time0: at(1.1), index: 0, dt: [250, 350], texts: ["", "", "思"] }]),
    at(1.7),
    "packed 思考：与文本同一口径",
  );
  expectToken(
    settle([{ type: "tool-call-chunks", time0: at(1.1), index: 0, id: "call-1", dt: [250, 350], args: ["", "", "{"] }]),
    at(1.7),
    "packed 工具参数：首个非空参数按 dt 累加",
  );
  expectToken(
    settle([{ type: "tool-call-chunks", time0: at(1.4), index: 0, id: "call-1", name: "read", dt: [], args: [""] }]),
    at(1.4),
    "packed 工具 run 带 name：time0 起就是 token（参数还没来也算）",
  );

  // raw 工具片段：name 存在（含空串）就是 token；没名字且参数为空才跳过
  expectToken(
    settle([toolDelta(1.3, { name: "", argumentsDelta: "" }), text(1.7)]),
    at(1.3),
    "raw 空名字也算 name-bearing token（不能按空名字过滤）",
  );
  expectToken(
    settle([blockStart(1.1), toolDelta(1.3, { argumentsDelta: "" }), finish(1.8)]),
    null,
    "既没有 name、参数也为空 → 不算 token（首帧的 1100 同样不许顶替）",
  );

  // 空白也算 token；裸 {time} / 只有元数据 / 全空 packed / 空流都不可用
  expectToken(settle([text(1.5, " \n"), text(1.7)]), at(1.5), "空白字符串不是空片段（官方只判 !== ''）");
  expectToken(settle([{ time: at(1.7) }]), null, "裸 {time} 不是合法 chunk");
  expectToken(settle([blockStart(1.1), usageChunk(1.2), finish(1.8)]), null, "只有元数据 → 首 token 不可用");
  expectToken(
    settle([
      { type: "text-chunks", time0: at(1.2), index: 0, dt: [100], texts: ["", ""] },
      { type: "tool-call-chunks", time0: at(1.4), index: 0, id: "call-1", dt: [], args: [""] },
      finish(1.8),
    ]),
    null,
    "全空 packed run → 不算 token",
  );
  expectToken(settle([]), null, "空流 → 首 token 不可用（有 step/start 仍算记过计时）");

  // 先到者胜（官方 `firstTokenTime ?? 新值`），且两条来源都要能补
  expectToken(settle([text(1.5)], [text(1.7)]), at(1.7), "attempt 先到者胜：后到的更早时刻不覆盖");
  expectToken(settle([text(1.7)], [text(1.5)], false), at(1.7), "message 先到者胜：后到的 attempt 不覆盖");
  expectToken(settle([], [text(1.7)], false), at(1.7), "message 先到但没 token → 后到的 attempt 把两份都补齐");
  expectToken(settle([text(1.7)], [text(1.2, "")]), at(1.7), "空 attempt（空片段）不锁住后到的真 token");
  expectToken(
    settle([text(1.9)], [{ type: "tool-call-chunks", time0: at(1.1), index: 0, id: "call-1", dt: [300, 300], args: ["", "", "x"] }]),
    at(1.7),
    "packed attempt 先到：缺 name 的参数 run 按 dt 累加",
  );

  // 多 step 隔离：两步各自的首 token 与请求不串（帧自带 turn/step，按身份归位）
  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 2 }, 0.9),
      event("step/start", { turn: 2, step: 1 }, 1),
      event("assistant/attempt", { turn: 2, step: 1, stream: [text(1.6)] }, 1.5),
      event("assistant/message", { turn: 2, step: 1, message: message("一", { model: "m" }), stream: [text(1.7)] }, 2),
      event("step/end", { turn: 2, step: 1 }, 2.1),
      event("step/start", { turn: 2, step: 2 }, 3),
      event("assistant/attempt", { turn: 2, step: 2, stream: [text(3.6)] }, 3.5),
      event("assistant/message", { turn: 2, step: 2, message: message("二", { model: "m" }), stream: [text(3.7)] }, 4),
      event("step/end", { turn: 2, step: 2 }, 4.1),
      event("turn/end", { turn: 2, reason: "success" }, 4.2),
    ];
    const model = deriveTrajectoryModel(events, false);
    assert.deepStrictEqual(
      model.requests
        .filter((request) => request.purpose === "assistant")
        .map((request) => [request.step, request.assistantFirstTokenTime]),
      [[1, at(1.6)], [2, at(3.6)]],
      "两步各自的首 token 挂在各自的请求上（先到者胜在步内生效，不跨步）",
    );
    assert.deepStrictEqual(
      model.turns.flatMap(trajectoryTurnCells)
        .filter((cell) => cell.kind === "message")
        .map((cell) => cell.assistantMetrics?.firstTokenTime),
      [at(1.6), at(3.6)],
      "记录级同样各归各步",
    );
  }

  // 重试隔离：`llm/retry` 之后本步的首 token 仍按先到者胜保留
  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 2 }, 0.9),
      event("step/start", { turn: 2, step: 1 }, 1),
      event("assistant/attempt", { turn: 2, step: 1, stream: [text(1.7)] }, 1.6),
      event("llm/retry", {
        turn: 2,
        step: 1,
        retry: 1,
        maxRetries: 3,
        delayMs: 100,
        mode: "normal",
        failure: { message: "503", code: "SERVER" },
      }, 1.8),
      event("assistant/message", { turn: 2, step: 1, message: message("答", { model: "m" }), stream: [text(1.9)] }, 2),
      event("step/end", { turn: 2, step: 1 }, 2.2),
      event("turn/end", { turn: 2, reason: "success" }, 2.3),
    ];
    expectToken(deriveTrajectoryModel(events, false), at(1.7), "重试不改这一步已经记下的首 token（先到者胜）");
  }

  // 显式身份指向别的步骤 / 轮次：查不到就不写，绝不回落到当前请求
  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 2 }, 0.9),
      event("step/start", { turn: 2, step: 2 }, 1),
      event("assistant/attempt", { turn: 2, step: 1, stream: [text(1.5)] }, 1.6),
      event("assistant/message", { turn: 2, step: 2, message: message("答", { model: "m" }), stream: [text(1.7)] }, 2),
    ];
    const model = deriveTrajectoryModel(events, false);
    assert.strictEqual(
      model.requests[0]?.assistantFirstTokenTime,
      at(1.7),
      "帧自带 step=1、窗口里没有那一步的请求时，不许把它的时刻填给当前 step=2 的请求",
    );
    assert.strictEqual(
      model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message")?.assistantMetrics?.firstTokenTime,
      at(1.7),
      "记录级同样只认这一步自己的结算帧",
    );
  }
  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 2 }, 0.9),
      event("step/start", { turn: 2, step: 1 }, 1),
      event("assistant/attempt", { turn: 1, step: 1, stream: [text(1.5)] }, 1.6),
      event("assistant/message", { turn: 2, step: 1, message: message("答", { model: "m" }), stream: [text(1.7)] }, 2),
    ];
    const model = deriveTrajectoryModel(events, false);
    assert.strictEqual(
      model.requests[0]?.assistantFirstTokenTime,
      at(1.7),
      "帧自带 turn=1、窗口里没有那一轮的请求时，不许把它的时刻填给当前 turn=2 的请求",
    );
  }
}
console.log("trajectory: 首 token 按官方 isTokenDelta / packed run 读（F03） ✓");

// ---------- 17. 会话边界让还在跑的压缩「被中断」 ----------
//
// 官方 `interruptCompactions()`：`session/end-seed` 之前仍在 running 的压缩请求，
// 以 `trajectory.compaction-interrupted` 收尾（界面据此显示那一句专用文案）。
// 少了这条规则，这种请求在账本里永远停在「正在压缩…」——会话都结束了。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("compaction/start", { turn: 0, step: 0 }, 0),
    // 会话到此结束：没有 compaction/end
    event("session/end-seed", { inherited: false }, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  const request = model.requests.find((entry) => entry.purpose === "compaction");
  assert.ok(request, "压缩要占一个请求号");
  assert.strictEqual(request?.status, "error", "会话边界之前还开着的压缩要以 error 收尾");
  assert.strictEqual(
    request?.error,
    TRAJECTORY_COMPACTION_INTERRUPTED,
    "错误码是官方那个合成码（客户端合成，不是服务端报的）",
  );
  assert.strictEqual(request?.completedAt, at(2), "收尾时刻取会话边界的时刻");
  const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "compacted");
  assert.strictEqual(cell?.status, "error", "账本那一行同样要改判（否则一直画成「正在压缩」）");
  assert.strictEqual(cell?.error, TRAJECTORY_COMPACTION_INTERRUPTED, "行上也挂同一个合成码");
  assert.strictEqual(
    trajectoryCellContent(cell as TrajectoryCell, texts).text,
    texts.compactionInterrupted,
    "界面按合成码取「被中断」那句专用文案，而不是笼统的「压缩失败」",
  );
}
console.log("trajectory: 会话边界中断压缩 ✓");

// ---------- 18. 助手消息带上它的工具调用 id（界面侧「层级」反向链接的判据） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("assistant/message", {
      turn: 0,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "text", text: "查一下" },
          // **线上形状**：身份字段是 `id`（`@deepseek-ai/dsh-llm` 的 ToolCallBlock）。
          // 别照 `tool/call` 事件上的 `callId` 写这里——那是另一个键（夹具曾经写错，
          // 于是 callIds 在真实日志上恒为空而断言照绿）
          { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
          { type: "tool-call", id: "c2", name: "grep", arguments: "{}" },
          // 没有 id 的调用块：**不挂**（拿不到证据就不给链接）
          { type: "tool-call", name: "glob" },
        ],
        source: {},
      },
    }, 1),
    event("tool/call", { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" }, 2),
    event("turn/end", { turn: 0, reason: "success" }, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  const cell = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
  assert.deepStrictEqual(cell?.callIds, ["c1", "c2"], "助手行要记下它发起的调用 id（顺序即发出顺序）");
  const tool = model.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "tool");
  assert.ok(
    cell?.callIds?.includes(tool?.callId ?? ""),
    "工具行能用 callId 找回发起它的那条助手消息（界面侧「层级」跳转就这么认）",
  );

  /**
   * 原始块（官方 `sourceBlocks`）——**搜索索引的输入**，也是检查器「原始内容」页签
   * 逐块渲染的输入。
   *
   * 判据逐条照官方 `sourceBlock()`：`reasoning` 改名成 `thinking`、`text` 块直接给原文、
   * 没有 `text` 的块（`tool-call`）把整个块**序列化进 `content`**——工具名与调用参数
   * 就是这样进搜索面的。实测 58776/58776 个 `tool-call` 块都带 `name` + `arguments`。
   *
   * `callId` / `toolName` 是官方 `assistantSourceBlock()` **额外挂上**的那两个键
   * （界面侧靠它们把那一节画成跳转按钮并显示工具名）；`content` 里那两个键**照旧留着**
   * ——从 `content` 里摘掉就是丢搜索面。
   */
  assert.deepStrictEqual(
    cell?.sourceBlocks,
    [
      { type: "text", content: "查一下" },
      {
        type: "tool-call",
        content: '{\n  "type": "tool-call",\n  "id": "c1",\n  "name": "read",\n  "arguments": "{}"\n}',
        callId: "c1",
        toolName: "read",
      },
      {
        type: "tool-call",
        content: '{\n  "type": "tool-call",\n  "id": "c2",\n  "name": "grep",\n  "arguments": "{}"\n}',
        callId: "c2",
        toolName: "grep",
      },
      // 没有 id 的调用块**照样进** sourceBlocks：它是原始内容的事实，
      // 缺席的只是「层级跳转」那条链接（那一条要 callId 才给）、以及块标题上那枚
      // 跳转按钮（`SourceBlocks` 对没有 callId 的块只画标题 + 正文，官方同一判据）。
      // **块本身仍进 sourceBlocks**：搜索索引按 `content` 收它，工具名照样搜得到。
      { type: "tool-call", content: '{\n  "type": "tool-call",\n  "name": "glob"\n}', toolName: "glob" },
    ],
    "助手行的原始块按顺序留下，工具的 name / arguments 序列化进 content（搜索索引靠它），callId / toolName 另挂一份（界面跳转靠它）",
  );

  /**
   * 身份字段两个名字都认（`id` 优先）。
   *
   * `callId` 是**工具调用自己**的名字（`tool/call` 事件上那个），不是内容块上的；留这一
   * 路是为了老的合成夹具与将来换名时不至于全断，`id` 则是在线上真实出现的那一个。
   */
  seq = 0;
  const legacyModel = deriveTrajectoryModel([
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("assistant/message", {
      turn: 0,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "tool-call", callId: "legacy", name: "read", arguments: "{}" }],
        source: {},
      },
    }, 1),
    event("turn/end", { turn: 0, reason: "success" }, 1),
  ], false);
  const legacyCell = legacyModel.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
  assert.deepStrictEqual(
    legacyCell?.callIds,
    ["legacy"],
    "块上写 `callId`（老名字）时也认——两个名字都读，`id` 优先",
  );
  assert.strictEqual(
    legacyCell?.sourceBlocks?.[0]?.callId,
    "legacy",
    "原始块上挂的 callId 同样两个名字都认（逐块渲染的跳转按钮靠它）",
  );

  // `reasoning` → `thinking`，`text` 块给原文而不是序列化（官方同名改写）
  seq = 0;
  const thinkingModel = deriveTrajectoryModel([
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("assistant/message", {
      turn: 0,
      step: 0,
      message: { id: "m1", role: "assistant", content: [{ type: "reasoning", text: "先想一下" }], source: {} },
    }, 1),
    event("turn/end", { turn: 0, reason: "success" }, 1),
  ], false);
  const thinkingCell = thinkingModel.turns.flatMap(trajectoryTurnCells).find((entry) => entry.kind === "message");
  assert.deepStrictEqual(
    thinkingCell?.sourceBlocks,
    [{ type: "thinking", content: "先想一下" }],
    "`reasoning` 块在原始块里改名叫 `thinking`（官方 sourceBlock 的那个改写）",
  );
}
console.log("trajectory: 助手行记下工具调用 id 与原始块 ✓");

// ---------- 18b. 调用时的 Schema（官方 attachToolSchema：逐调用记下来，不回查目录） ----------
{
  seq = 0;
  const readSchema = { name: "read", description: "读文件", parameters: { type: "object" } };
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [readSchema] }, reason: "initial" }, 0),
    event("tool/call", { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" }, 1),
    /**
     * 目录**换了**：`read` 的 schema 变了、新增 `write`。
     *
     * 这条是这一段的关键——「回查这一行之前最近一次目录」的做法会把 `write` 的 schema
     * 或者新版的 `read` 给到旧调用上（界面上看不出来）。官方在调用那一刻就把当时那份
     * 记在调用格上，所以后面怎么变都不影响。
     */
    event("request/header", {
      header: {
        config: { provider: "p", model: "m" },
        tools: [
          { name: "read", description: "读文件（新版）", parameters: { type: "object", required: ["path"] } },
          { name: "write", description: "写文件", parameters: { type: "object" } },
        ],
      },
      reason: "tools",
    }, 2),
    event("tool/call", { turn: 0, step: 0, callId: "c2", name: "write", arguments: "{}" }, 2),
    // 目录里没有这个名字：**不给** schemaDetail（拿不到证据就不臆造）
    event("tool/call", { turn: 0, step: 0, callId: "c3", name: "还没注册的工具", arguments: "{}" }, 3),
    event("tool/ptc-dispatch-start", {
      rootCallId: "c1", parentCallId: "c1", subCallId: "c1:ptc:1", name: "write", arguments: {},
    }, 3),
    event("turn/end", { turn: 0, reason: "success" }, 3),
  ];
  const model = deriveTrajectoryModel(events, false);
  const all = model.turns.flatMap(trajectoryTurnCells);
  const byCall = (callId: string) => all.find((entry) => entry.callId === callId);

  assert.strictEqual(
    byCall("c1")?.schemaDetail,
    JSON.stringify(readSchema, null, 2),
    "调用时记的是**那一刻**目录里的 schema（缩进与官方 attachToolSchema 一致）",
  );
  assert.ok(
    byCall("c1")?.schemaDetail?.includes('"读文件"')
      && !byCall("c1")?.schemaDetail?.includes("新版"),
    "目录随后变更**不改写**已经记下的那一条（回查目录会给错的那份）",
  );
  assert.ok(byCall("c2")?.schemaDetail?.includes("写文件"), "之后的新调用拿的是新目录");
  assert.strictEqual(byCall("c3")?.schemaDetail, undefined, "目录里没有这个名字就不给 schemaDetail");
  assert.ok(
    all.find((entry) => entry.kind === "subtool")?.schemaDetail?.includes("写文件"),
    "子工具（ptc 派发）与普通调用同一条判据",
  );
}
console.log("trajectory: 调用时的 Schema 逐调用记下 ✓");

/**
 * 带显式 id 的人发消息。
 *
 * `message()` 那个夹具的 id 由 `seq` 拼出来（`m${seq}`），而 `event()` 自己会推进
 * `seq`——想让它与 `agent/inbox/spliced` 里的 id 对上就没法用了，所以这一支自己给 id。
 */
const userWithId = (id: string, text: string) => ({
  id,
  role: "user",
  content: block(text),
  source: { kind: "user" },
});
const identity = (id: string) => ({ id, role: "user", content: block(""), source: { kind: "user" } });

/**
 * 领取一条 steering 的三帧，顺序与真实事件一致：spliced 插入 → spliced 领取（本次
 * 领取集合就是被移除的那批 id）→ `user/message` 落盘。`offset` 是 `at()` 的偏移。
 */
const claimSteering = (id: string, offset: number): SessionWireEvent[] => [
  event("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [identity(id)] }, offset),
  event("agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1 }, offset + 0.1),
  event("user/message", userWithId(id, id), offset + 0.2),
];

// ---------- steering：只有 next-step 的「本次领取」才算 ----------
/**
 * 官方 `trajectory-input-message` 的第三分支：人发消息的 id 命中 inbox 状态机的
 * **本次领取**集合 → `kind: 'steering'`（界面上仍渲染成 user 色系、不带标签，
 * 差别只有**不置 `opensTurn`**）。这里有两条容易搬错的地方，各钉一条：
 * 1. `next-turn` 的帧**不进**这台状态机（官方 `match` 只认 `next-step`）——
 *    实测本机 442 份日志，混进去会把近 85% 的普通用户消息误判成 steering；
 * 2. 领取集合装的是**被移除**的 id，不是 `inserted` 的（见 `trajectoryVendor.test.ts`）。
 */
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", userWithId("u1", "开新轮"), 1),
    event("assistant/message", { turn: 0, step: 0, message: message("答", {}) }, 2),
    // 生成过程中插进队列，在下一次 step 边界被领取
    event("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [identity("u2")] }, 3),
    event("agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1 }, 4),
    event("user/message", userWithId("u2", "插话"), 5),
    // 排队到下一轮的普通消息：同样是 spliced 帧，但不该影响分类
    event("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [identity("u3")] }, 6),
    event("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 1 }, 7),
    event("user/message", userWithId("u3", "排队的新轮"), 8),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  const of = (text: string) => cells.find((cell) => cell.previewMarkdown === text);
  const steering = of("插话");
  assert.strictEqual(steering?.steering, true, "被领取的 id → steering");
  assert.strictEqual(steering?.opensTurn, undefined, "steering 不置 opensTurn（官方 layout 就不置）");
  assert.strictEqual(steering?.kind, "user", "steering 在 cell 层仍然是 user（官方同口径，没有新 kind）");
  const fresh = of("开新轮");
  assert.strictEqual(fresh?.opensTurn, true);
  assert.strictEqual(fresh?.steering, undefined);
  const queued = of("排队的新轮");
  assert.strictEqual(queued?.opensTurn, true, "next-turn 的帧不许影响分类");
  assert.strictEqual(queued?.steering, undefined, "next-turn 的领取不算 steering");
}
console.log("trajectory: steering 只看 next-step 的本次领取 ✓");

// ---------- steering 的落组（官方 steeringPlacement 的两条分支） ----------
/**
 * 官方的落点规则（`steeringPlacement()` + `ConversationLocationIndex`）：
 * 1. 领取发生在**某一步进行中**（落点就是那一步）→ 放那一步的组；
 * 2. 否则看**它之后那条助手消息**在哪一步 → 放那一步的组（这正是它的日常形态：
 *    领取写在两次 `step/start` 之间，所以落点里没有 step）。
 *
 * 两条都要钉住：搞错第 2 条会让 steering 掉进消息组，检查器落点写成「第 M 轮 · 消息」。
 */
{
  seq = 0;
  const spliced = (data: Record<string, unknown>) => event("agent/inbox/spliced", { target: "next-step", ...data }, seq);
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", userWithId("u1", "第一句"), 1),
    event("assistant/message", { turn: 0, step: 0, message: message("第 0 步", {}) }, 2),
    // 落点里没有 step（两步之间）→ 走「之后那条助手」的分支
    event("step/end", { turn: 0, step: 0 }, 2),
    spliced({ start: 0, inserted: [identity("u2")] }),
    spliced({ start: 0, removedCount: 1 }),
    event("user/message", userWithId("u2", "两步之间插的话"), 3),
    event("step/start", { turn: 0, step: 1 }, 3),
    event("assistant/message", { turn: 0, step: 1, message: message("第 1 步", {}) }, 4),
    // 落点里**有** step（这一步还在跑）→ 直接用它
    event("step/start", { turn: 0, step: 2 }, 5),
    spliced({ start: 0, inserted: [identity("u3")] }),
    spliced({ start: 0, removedCount: 1 }),
    event("user/message", userWithId("u3", "步骤中插的话"), 6),
    event("assistant/message", { turn: 0, step: 2, message: message("第 2 步", {}) }, 7),
  ];
  const model = deriveTrajectoryModel(events, false);
  const groups = model.turns[0].groups;
  assert.deepStrictEqual(
    groups.map((group) => [group.title, group.cells.map((cell) => cell.previewMarkdown ?? cell.kind)]),
    [
      [{ kind: "message" }, ["第一句", "第 0 步"]],
      [{ kind: "step", step: 1 }, ["两步之间插的话", "第 1 步"]],
      [{ kind: "step", step: 2 }, ["步骤中插的话", "第 2 步"]],
    ],
    "steering 落进**消费它的那一步**的组（落点有 step 用落点，没有则用之后那条助手的那一步）",
  );
  const steering = trajectoryTurnCells(model.turns[0]).filter((cell) => cell.steering === true);
  assert.deepStrictEqual(
    steering.map((cell) => cell.step),
    [1, 2],
    "steering 记录带上它落组用的步骤号（分组与检查器落点都按它算）",
  );
}
console.log("trajectory: steering 落进消费它的那一步 ✓");

// ---------- steering 的落点：初始 system 行前插 + 前插历史（F05） ----------
/**
 * 两条独立缺陷，各钉一条：
 *
 * 1. **轮次归属**：初始系统提示词那一行在事件流里的轮次是**后面**那一轮，而官方按
 *    `firstVisibleTurn()`（助手记录里最小的 `turn > 0`）把它归到第一个可见轮次。
 *    照事件当时归轮，账本会先排「第 2 轮（只有这一行）」再排「第 1 轮」——同一个
 *    轮号被拆成两段，按轮号取那一轮的调用方只会拿到空壳。
 * 2. **稳定身份**：它在最后 `unshift` 到账本第一行并给全表重编号，所以 steering 的
 *    落点**不能按显示序号 `cell.index` 关联**（会错位一格、查到后一条 steering 的
 *    落点，官方同款是按事件 `seq`，见 `ConversationLocationIndex.locationOf`）。
 */
{
  seq = 0;
  const events: SessionWireEvent[] = [
    // 前插的更早历史（第 1 轮）
    event("turn/start", { turn: 1 }, 0.1),
    event("user/message", userWithId("historical", "历史提问"), 0.2),
    event("step/start", { turn: 1, step: 1 }, 0.3),
    event("assistant/message", { turn: 1, step: 1, message: message("历史回答", {}) }, 0.4),
    event("step/end", { turn: 1, step: 1 }, 0.5),
    event("turn/end", { turn: 1, reason: "success" }, 0.6),
    // 当前轮：初始 system 行晚于 turn/start 到达，最后被 unshift 到账本第一行
    event("turn/start", { turn: 2 }, 1),
    event("user/message", userWithId("fresh", "本轮提问"), 1.1),
    event("step/start", { turn: 2, step: 1 }, 1.2),
    event("system/message", { turn: 2, step: 1, message: message("中立提示词", { kind: "system" }) }, 1.3),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial" }, 1.4),
    ...claimSteering("steer-in-step-1", 1.5),
    event("assistant/message", { turn: 2, step: 1, message: message("回答一", {}) }, 1.8),
    event("step/end", { turn: 2, step: 1 }, 1.9),
    ...claimSteering("steer-between", 2),
    event("step/start", { turn: 2, step: 2 }, 2.2),
    ...claimSteering("steer-in-step-2", 2.3),
    event("assistant/message", { turn: 2, step: 2, message: message("回答二", {}) }, 2.6),
    event("step/end", { turn: 2, step: 2 }, 2.7),
    event("turn/end", { turn: 2, reason: "success" }, 2.8),
  ];
  const model = deriveTrajectoryModel(events, false);
  assert.strictEqual(
    model.turns.filter((turn) => turn.turn === 2).length,
    1,
    "同一个轮号只许有一段（初始 system 行归第一个可见轮次，不许另开一个第 2 轮）",
  );
  const target = model.turns.find((turn) => turn.turn === 2);
  assert.ok(target !== undefined, "第 2 轮要在账本里");
  for (const [id, step] of [["steer-in-step-1", 1], ["steer-between", 2], ["steer-in-step-2", 2]] as const) {
    // 变量名与上面那次 `groups` 区分开：同名遮蔽会让 `filter` 的类型推断绕回自己，
    // 报 TS7022（`'groups' implicitly has type 'any'`）而不是给出元素类型。
    const matched: TrajectoryGroup[] = target.groups.filter((group) =>
      group.cells.some((cell) => cell.previewMarkdown === id));
    assert.strictEqual(matched.length, 1, `${id} 恰好落一组`);
    assert.deepStrictEqual(matched[0]?.title, { kind: "step", step }, `${id} 落进第 ${step} 步的组`);
    const cell = matched[0]?.cells.find((candidate) => candidate.previewMarkdown === id);
    assert.strictEqual(cell?.step, step, `${id} 的落点是官方语义里的那一步`);
    assert.strictEqual(cell?.turn, 2, `${id} 不许被错归到别的轮次`);
  }
  const indexes = model.turns.flatMap(trajectoryTurnCells).map((cell) => cell.index);
  assert.deepStrictEqual(
    [...indexes].sort((left, right) => left - right),
    indexes.map((_, index) => index + 1),
    "前插重编号后行号仍从 1 连续",
  );
  assert.strictEqual(new Set(indexes).size, indexes.length, "行号唯一");
}
console.log("trajectory: 初始 system 行前插不改 steering 落点与轮号（F05） ✓");

// ---------- 初始 system 行的归轮与前插顺序（F05 补完） ----------
/**
 * 官方 `deriveTrajectoryLayout()` 对「初始」系统提示词那一行用的是
 * `firstVisibleTurn(nodes, partial)`：**助手记录里最小的大于 0 的轮次**（没有在跑的流时
 * 就轮到它；都没有就是 **1**）——不是「它到达时事件流正在哪一轮」。它在
 * `layoutEntryOrder()` 里被强制成 `-Infinity`，记账序号永远是 1，于是它落的轮次
 * 排在最前（官方输出侧最后按 `firstCellIndex` 排 turns）。
 *
 * 窗口带前插历史时这一点最明显：初始 header 在第 2 轮到达，而窗口里已经有第 1 轮的助手
 * 记录——官方把提示词行归**第 1 轮**、账本顺序是「第 1 轮 → 第 2 轮」；照到达时归轮会得到
 * 「第 2 轮（只有提示词行）→ 第 1 轮」，同一个第 2 轮还会被拆成两段。
 */
{
  seq = 0;
  const model = deriveTrajectoryModel([
    // 前插的更早历史（第 1 轮）
    event("turn/start", { turn: 1 }, 0.1),
    event("user/message", userWithId("historical", "历史提问"), 0.2),
    event("step/start", { turn: 1, step: 1 }, 0.3),
    event("assistant/message", { turn: 1, step: 1, message: message("历史回答", {}) }, 0.4),
    event("step/end", { turn: 1, step: 1 }, 0.5),
    event("turn/end", { turn: 1, reason: "success" }, 0.6),
    // 当前轮：初始 system 行在第 2 轮到达，最后被前插到账本第一行
    event("turn/start", { turn: 2 }, 1),
    event("user/message", userWithId("fresh", "本轮提问"), 1.1),
    event("step/start", { turn: 2, step: 1 }, 1.2),
    event("system/message", { turn: 2, step: 1, message: message("中立提示词", { kind: "system" }) }, 1.3),
    event("request/header", {
      header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial",
    }, 1.4),
    event("assistant/message", { turn: 2, step: 1, message: message("本轮回答", {}) }, 1.5),
    event("step/end", { turn: 2, step: 1 }, 1.6),
    event("turn/end", { turn: 2, reason: "success" }, 1.7),
  ], false);
  assert.deepStrictEqual(
    model.turns.map((turn) => turn.turn),
    [1, 2],
    "轮次顺序按它里面第一个记录的位置（官方按 firstCellIndex 排）：第 1 轮在前",
  );
  const front = model.turns[0]?.groups[0]?.cells[0];
  assert.strictEqual(front?.kind, "system", "账本第一行是初始系统提示词");
  assert.strictEqual(front?.index, 1, "它的显示序号是 1");
  assert.strictEqual(front?.promptChange, "initial");
  assert.strictEqual(
    front?.turn,
    1,
    "归轮取最早可见的助手轮次（firstVisibleTurn），不是到达时所在的第 2 轮",
  );
  assert.deepStrictEqual(
    model.turns.map((turn) => trajectoryTurnCells(turn).map((cell) => cell.kind)),
    [["system", "user", "message"], ["user", "message"]],
    "提示词行进了第 1 轮，第 2 轮的记录一行不少",
  );
  assert.strictEqual(
    model.turns.filter((turn) => turn.turn === 2).length,
    1,
    "第 2 轮仍是一段",
  );
}
{
  // 没有任何「大于 0 的助手轮次」时，官方 `firstVisibleTurn()` 返回 **1**（官方默认轮号），
  // 事件自己带的 turn 0 记录再由 prologue 那一支整段并入第 1 轮（官方 `turns.get(0)` →
  // 并进 `turns.get(1) ?? 空段` → `turns.set(1, …)`），所以最终只有一段、段号是 1。
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", userWithId("u1", "第一句"), 1),
    event("request/header", {
      header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial",
    }, 1),
    event("assistant/message", { turn: 0, step: 0, message: message("第 0 步的答", {}) }, 2),
    event("turn/end", { turn: 0, reason: "success" }, 3),
  ], false);
  assert.deepStrictEqual(
    model.turns.map((turn) => turn.turn),
    [1],
    "turn 0 整段并入第 1 轮（官方 prologue 的无条件分支），段号就是 1",
  );
  const cells = trajectoryTurnCells(model.turns[0]);
  assert.deepStrictEqual(cells.map((cell) => cell.index), [1, 2, 3], "并入后仍按显示序号排");
  assert.strictEqual(cells[0]?.promptChange, "initial", "初始提示词仍是第一行");
}
{
  // 官方那条分支的最后一种：窗口里既没有助手记录、也没有在跑的步骤 → 默认 **1**。
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 7 }, 0),
    event("user/message", userWithId("u7", "第七轮的问题"), 0.5),
    event("request/header", {
      header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial",
    }, 1),
  ], false);
  assert.deepStrictEqual(model.turns.map((turn) => turn.turn), [1, 7], "提示词行的第 1 轮排在前面");
  assert.strictEqual(model.turns[0]?.groups[0]?.cells[0]?.promptChange, "initial");
  assert.strictEqual(model.turns[0]?.groups[0]?.cells[0]?.turn, 1, "没有助手记录时用官方默认轮号 1");
}
{
  // 窗口里**没有 `request/header`**（分页把初始 header 留在窗口外，只剩 `system/message`）时
  // 补的那条兜底初始行，归轮同样走 `firstVisibleTurn()`——官方那两条支（`input.systemPrompts`
  // 的初始提示词与带 `promptChange` 的请求）都走同一个函数。
  seq = 0;
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 7 }, 0),
    event("user/message", userWithId("u7", "第七轮的问题"), 0.5),
    event("system/message", { turn: 7, step: 1, message: message("窗口里只剩它", { kind: "system" }) }, 0.8),
  ], true);
  assert.deepStrictEqual(
    model.turns.map((turn) => turn.turn),
    [1, 7],
    "兜底初始行归第 1 轮，第 7 轮仍是它自己那一段",
  );
  const front = model.turns[0]?.groups[0]?.cells[0];
  assert.strictEqual(front?.promptChange, "initial", "兜底行标成初始提示词");
  assert.strictEqual(front?.index, 1, "它仍是账本第一行");
  assert.strictEqual(front?.turn, 1, "归轮用 firstVisibleTurn()，不是窗口里第一行的轮次");
}
console.log("trajectory: 初始 system 行的归轮与前插顺序（F05） ✓");

// ---------- steering 的落点：相邻领取不得借用后一条的落点（F05） ----------
/**
 * 上一条身份缺陷需要一个能真正触发的形状：初始 system 行前插把全表序号后移一格
 * 之后，按 `cell.index` 查会命中**后一条** steering 的落点。这里把两条领取排成相邻
 * ——第 1 步领取 A 之后没有第 1 步的助手消息，紧接着在两 step 之间领取 B——A 的落点
 * 本来只有它自己那次领取有（第 1 步），旧实现会拿 B 的「无 step 落点」走「之后那条
 * 助手」分支，把 A 判进第 2 步。
 */
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 2 }, 0.9),
    event("user/message", userWithId("fresh", "本轮提问"), 0.95),
    event("step/start", { turn: 2, step: 1 }, 1),
    event("system/message", { turn: 2, step: 1, message: message("中立提示词", { kind: "system" }) }, 1.05),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial" }, 1.1),
    event("assistant/message", { turn: 2, step: 1, message: message("回答一", {}) }, 1.2),
    ...claimSteering("steer-in-step-1", 1.3),
    event("step/end", { turn: 2, step: 1 }, 1.5),
    ...claimSteering("steer-between", 1.6),
    event("step/start", { turn: 2, step: 2 }, 1.9),
    event("assistant/message", { turn: 2, step: 2, message: message("回答二", {}) }, 2.1),
    event("step/end", { turn: 2, step: 2 }, 2.2),
    event("turn/end", { turn: 2, reason: "success" }, 2.3),
  ];
  const steering = deriveTrajectoryModel(events, false)
    .turns.flatMap(trajectoryTurnCells)
    .filter((cell) => cell.steering === true);
  assert.deepStrictEqual(
    steering.map((cell) => [cell.previewMarkdown, cell.turn, cell.step]),
    [["steer-in-step-1", 2, 1], ["steer-between", 2, 2]],
    "A 用自己那次领取的落点（第 1 步），不借用后一条 B 的落点",
  );
}
console.log("trajectory: 相邻领取各用各的落点（F05） ✓");

// ---------- 分组：官方 turn → group（组标题只有三档） ----------
/**
 * 官方 `deriveTrajectoryLayout` 的三条推入规则：
 * `pushMessage()`（只在最后一组也是消息组时并入）、`pushStep()`（按 step 号找已有组）、
 * 压缩自成一组。组标题在宿主侧是**语义**（界面侧取「消息」/「第 N 步」/「压缩 N」）。
 *
 * 另一条同样重要的不变量：**分组不许打乱位次**——请求边界小标记、轮次标签、
 * 时间线全按 `trajectoryTurnCells()` 的顺序画。
 */
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: message("提示词", { kind: "system" }) }, 0),
    event("user/message", userWithId("u1", "第一句"), 1),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [] }, reason: "initial" }, 1),
    event("assistant/message", { turn: 0, step: 0, message: message("第 0 步的答", {}) }, 2),
    event("step/start", { turn: 0, step: 1 }, 3),
    event("assistant/message", { turn: 0, step: 1, message: message("第 1 步的答", {}) }, 4),
    event("tool/call", { turn: 0, step: 1, callId: "c1", name: "read", arguments: "{}" }, 5),
    event("turn/end", { turn: 0, reason: "success" }, 6),
  ];
  const model = deriveTrajectoryModel(events, false);
  assert.strictEqual(model.turns.length, 1, "一轮");
  const groups = model.turns[0].groups;
  assert.deepStrictEqual(
    groups.map((group) => group.title),
    [{ kind: "message" }, { kind: "step", step: 1 }],
    "第 0 步的记录走消息组（官方 node.step > 0 才 pushStep），step 1 自成一组",
  );
  assert.deepStrictEqual(
    groups.map((group) => group.cells.map((cell) => cell.kind)),
    [["system", "user", "message"], ["message", "tool"]],
    "助手与它发起的工具行同组（官方 pushStep(call.turn, call.step, …)）",
  );
  assert.deepStrictEqual(
    trajectoryTurnCells(model.turns[0]).map((cell) => cell.index),
    [1, 2, 3, 4, 5],
    "摊平之后仍是折叠顺序（分组只是容器，不许打乱位次）",
  );
  assert.deepStrictEqual(
    groups.map((group) => group.cells.map((cell) => cell.step)),
    [[undefined, undefined, 0], [1, 1]],
    "只有助手 / 工具行带步骤号（官方节点层同样如此），分组就按它分",
  );
}
console.log("trajectory: turn → group 分组（prologue 那条在轮次分组里）✓");

// ---------- 压缩段自成一组 ----------
{
  seq = 0;
  const model = deriveTrajectoryModel([
    event("compaction/start", { turn: null }, 0),
  ], false);
  assert.deepStrictEqual(
    model.turns.map((turn) => ({
      turn: turn.turn,
      groups: turn.groups.map((group) => group.title),
    })),
    [{ turn: null, groups: [{ kind: "compaction", seq: 0 }] }],
    "轮次之间的压缩自成一段一组，标题带它的 startSeq（界面取「压缩 N」）",
  );
}
console.log("trajectory: 独立压缩段自成一组 ✓");

// ---------- 16e/16f/16g. F03 剩余：越界 retry 徽章、非法 stream 形状、截断窗口时序 ----------
/**
 * 这一批钉三件事，官方来源都是固定提交 `639ed015…`（`refs/tags/dsh-v0.2.0-rc.2`）：
 *
 * 1. **越界 `llm/retry` 的重试徽章**：官方 `trajectoryAssistantDefinition.match()` 给
 *    `llm/retry` 的身份是 `${data.turn}:${data.step}`（与 `assistant/message` /
 *    `assistant/attempt` / `step/end` 同一个 definition id）；那一步在窗口里没有
 *    `step/start` 时，官方 `fallbackState()` 只重放 `assistant/live-chunk` /
 *    `assistant/attempt` / `assistant/message` / `step/end` —— **`llm/retry` 连分支
 *    都没有**，重试事实落不到任何节点上，更不会落到别的步骤。所以助手行上的徽章
 *    （`cell.retry`）只能写在「帧自己那一步、且那一步在窗口里开过 `step/start`」
 *    （官方的 `state.started`）的键上。
 * 2. **非法 `stream` 形状的安全首 token 读取**：官方 `packages/llm/llm/src/assistant-stream.ts`
 *    的 `isTokenDelta` / `runFirstTokenTime` / `assistantStreamFirstTokenTime` **信任
 *    静态类型**（文件头写明「Readers trust the static record type」），契约里
 *    `text-delta.text` / `tool-call-delta.argumentsDelta` / run 的 `texts` / `args`
 *    都是 string、`name?: string`。缺字段或非字符串的畸形帧在官方判据下会
 *    `undefined !== ''` 为真、被当成 token——本扩展是适配层，必须**按肯定证据**读：
 *    只有 `typeof … === 'string'` 的片段才算 token 候选，**这是适配边界加强，不是
 *    官方等价**（合法输入上两套判据逐字同值，见下面成对的合法/非法判据）。
 * 3. **截断窗口的请求/助手行同步**：官方一个 step 的状态由**该身份自己的任意一帧**
 *    建起来（`fallbackState()` 按事件顺序重放），`settleTiming()` 是
 *    `state.firstTokenTime ?? 新值`。窗口从半截开始（没有该步 `step/start`）时，
 *    attempt 先到、message 后到的首 token 仍取 attempt 那个时刻；同一步重复结算的
 *    各次都读同一份。本扩展请求表只在 `step/start` 上建，没有请求的步骤另有一份
 *    按帧身份的「先到者胜」记忆——记录级与请求级**必须同值**。
 *
 * 收集器：每条判据单独跑、失败只记不抛，一次运行就能看到这一批**全部**行为断言的
 * 红（裸 `assert` 第一条抛出后后面的判据都跑不到，红日志只能证明第一条）。全绿时
 * 逐条打印，有红就在末尾整批抛出。
 */
{
  const checks: { name: string; run: () => void }[] = [];
  const check = (name: string, run: () => void): void => {
    checks.push({ name, run });
  };
  const runChecks = (title: string): void => {
    const failed: string[] = [];
    for (const entry of checks) {
      try {
        entry.run();
        console.log(`  ✓ ${entry.name}`);
      } catch (error) {
        failed.push(`${entry.name} —— ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`${title}（${failed.length}/${checks.length} 条不成立）\n  - ${failed.join("\n  - ")}`);
    }
  };
  /** 账本里唯一那条已结算的助手行。 */
  const assistantCell = (model: TrajectoryModel): TrajectoryCell | undefined =>
    model.turns.flatMap(trajectoryTurnCells).find((cell) => cell.kind === "message");

  // ---- 16e. 越界 `llm/retry` 的徽章 ----
  check("越界 retry 的徽章不落到窗口当前步的行上", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0),
      event("step/start", { turn: 1, step: 1 }, 0),
      // turn 1 / step 2 在整个窗口里没有 `step/start`（官方那一步没有节点、也没有请求）
      event("llm/retry", {
        turn: 1,
        step: 2,
        retry: 2,
        maxRetries: 5,
        mode: "normal",
        delayMs: 100,
        failure: { message: "越界重试", code: "SERVER" },
      }, 1),
      event("assistant/message", { turn: 1, step: 1, message: message("第一步的答", {}) }, 2),
    ], false);
    assert.strictEqual(model.requests.length, 1, "越界 retry 不新开请求");
    assert.strictEqual(model.requests[0]?.retry, undefined, "请求级不写（帧自己那一步没有请求）");
    assert.strictEqual(assistantCell(model)?.retry, undefined, "行级徽章同样不写：两处必须同一身份");
  });

  check("越界 retry 的徽章不顶掉本步已有的徽章", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0),
      event("step/start", { turn: 1, step: 1 }, 0),
      event("llm/retry", {
        turn: 1,
        step: 1,
        retry: 1,
        maxRetries: 3,
        mode: "normal",
        delayMs: 100,
        failure: { message: "第一次失败", code: "SERVER" },
      }, 1),
      event("llm/retry", {
        turn: 1,
        step: 2,
        retry: 9,
        maxRetries: 9,
        mode: "normal",
        delayMs: 900,
        failure: { message: "越界重试", code: "SERVER" },
      }, 2),
      event("assistant/message", { turn: 1, step: 1, message: message("重试后成功", {}) }, 3),
    ], false);
    assert.deepStrictEqual(assistantCell(model)?.retry, { attempt: 1, max: 3 }, "第 1 步自己的徽章留着");
    assert.deepStrictEqual(model.requests[0]?.retry, { attempt: 1, max: 3 }, "请求级与行级同值");
    assert.strictEqual(model.requests[0]?.retryDelayMs, 100, "越界帧的延迟不落到这一步的请求上");
    assert.strictEqual(assistantCell(model)?.error, undefined, "越界帧不是这一行的失败证据");
  });

  check("窗口无 step/start：那一步的徽章谁都不给", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 5 }, 0),
      event("llm/retry", {
        turn: 5,
        step: 2,
        retry: 2,
        maxRetries: 5,
        mode: "normal",
        delayMs: 100,
        failure: { message: "半截窗口", code: "SERVER" },
      }, 1),
      event("assistant/message", {
        turn: 5,
        step: 2,
        message: message("半截窗口的答", {}),
        stream: [{ type: "chunk", time: at(1.7), chunk: { type: "text-delta", index: 0, text: "答" } }],
      }, 2),
    ], false);
    const cell = assistantCell(model);
    assert.strictEqual(model.requests.length, 0, "没有 step/start 就没有请求");
    assert.strictEqual(cell?.retry, undefined, "行上没有徽章（官方那一步没有 started 状态）");
    assert.strictEqual(cell?.requestNumber, undefined, "行也不挂请求号");
    assert.strictEqual(cell?.step, 2, "行取帧自己的坐标");
    assert.strictEqual(cell?.assistantMetrics?.firstTokenTime, at(1.7), "首 token 仍取这一帧自己的 stream");
  });

  check("畸形 retry 帧（没带坐标）沿用窗口当前步的兜底键", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0),
      event("step/start", { turn: 1, step: 1 }, 0),
      event("llm/retry", {
        retry: 1,
        maxRetries: 2,
        mode: "normal",
        delayMs: 50,
        failure: { message: "无坐标", code: "SERVER" },
      }, 1),
      event("assistant/message", { turn: 1, step: 1, message: message("答", {}) }, 2),
    ], false);
    assert.deepStrictEqual(assistantCell(model)?.retry, { attempt: 1, max: 2 }, "防御路径照旧（与 message 读徽章同源）");
    assert.deepStrictEqual(model.requests[0]?.retry, { attempt: 1, max: 2 }, "请求级同样");
  });

  // ---- 16f. 非法 `stream` 形状的安全读取 ----
  /** 合法的 raw 记录信封。 */
  const raw = (offset: number, chunk: Record<string, unknown>) => ({ type: "chunk", time: at(offset), chunk });
  const text = (offset: number, value = "答") => raw(offset, { type: "text-delta", index: 0, text: value });
  const toolDelta = (offset: number, value: Record<string, unknown>) =>
    raw(offset, { type: "tool-call-delta", index: 0, id: "call-1", ...value });
  /** 一个完整 step 的结算时序（`step/start` → `assistant/message` → `step/end`）。 */
  const settle = (stream: unknown): TrajectoryModel => {
    seq = 0;
    return deriveTrajectoryModel([
      event("turn/start", { turn: 0 }, 0.5),
      event("step/start", { turn: 0, step: 1 }, 1),
      event("assistant/message", {
        turn: 0,
        step: 1,
        message: message("答", { model: "m" }),
        usage: { inputTokens: 10, outputTokens: 3 },
        stream,
      }, 2),
      event("step/end", { turn: 0, step: 1 }, 2.5),
      event("turn/end", { turn: 0, reason: "success" }, 3),
    ], false);
  };
  /** 「请求/助手行同步」的成对判据：记录级与请求级必须同值。 */
  const tokenPair = (model: TrajectoryModel): [number | null, number | null] => {
    const cell = assistantCell(model);
    assert.ok(cell?.assistantMetrics !== undefined, "账本里要有带计时的助手行");
    return [cell.assistantMetrics.firstTokenTime, model.requests[0]?.assistantFirstTokenTime ?? null];
  };
  const checkToken = (label: string, stream: unknown, expected: number | null): void => {
    check(label, () => {
      assert.deepStrictEqual(tokenPair(settle(stream)), [expected, expected], label);
    });
  };

  checkToken("raw text-delta 缺 text 字段不算 token（官方的 `undefined !== ''` 会误判）",
    [raw(1.3, { type: "text-delta", index: 0 }), text(1.7)], at(1.7));
  checkToken("raw text-delta 的 text 非字符串不算 token",
    [raw(1.3, { type: "text-delta", index: 0, text: 5 }), text(1.7)], at(1.7));
  checkToken("只有缺字段的 text-delta → 首 token 不可用",
    [raw(1.3, { type: "text-delta", index: 0 })], null);
  checkToken("raw tool-call-delta 缺 argumentsDelta 又没有 name → 不算 token",
    [toolDelta(1.3, {}), text(1.7)], at(1.7));
  checkToken("raw tool-call-delta 的 name 非字符串（null）不算 name-bearing",
    [toolDelta(1.3, { name: null, argumentsDelta: "" }), text(1.7)], at(1.7));
  checkToken("合法：raw tool-call-delta 的空串 name 仍算 token",
    [toolDelta(1.3, { name: "", argumentsDelta: "" }), text(1.7)], at(1.3));
  checkToken("合法：空白 text 仍是 token（官方只判 `!== ''`）",
    [text(1.5, " \n"), text(1.7)], at(1.5));
  checkToken("packed：首个成员非字符串不算 token，取其后首个合法片段",
    [{ type: "text-chunks", time0: at(1.2), index: 0, dt: [200], texts: [null, "答"] }], at(1.4));
  checkToken("packed：工具 run 的 name 非字符串不算 name-bearing、参数全空 → 不可用",
    [{ type: "tool-call-chunks", time0: at(1.2), index: 0, id: "call-1", name: null, dt: [100], args: [""] }], null);
  checkToken("packed：成员全是非字符串 → 不可用",
    [{ type: "text-chunks", time0: at(1.2), index: 0, dt: [100, 100], texts: [null, 5, false] }], null);
  checkToken("packed：dt 里有非数字间隔 → 整条 run 不可用（不拿半截累加值冒充）",
    [{ type: "text-chunks", time0: at(1.2), index: 0, dt: ["200"], texts: ["", "答"] }], null);
  checkToken("packed：合法 run 照旧按 time0 + Σdt 折（合法输入不受加强影响）",
    [{ type: "text-chunks", time0: at(1.2), index: 0, dt: [200, 300], texts: ["", "", "答"] }], at(1.7));
  check("stream 不是数组 → 首 token 不可用，不抛错", () => {
    for (const shape of [{ 0: text(1.3) }, "chunk", null, 42]) {
      assert.deepStrictEqual(tokenPair(settle(shape)), [null, null], `形状 ${JSON.stringify(shape)}`);
    }
  });
  check("记录不是对象（字符串 / 数组 / null）→ 跳过它继续找", () => {
    assert.deepStrictEqual(tokenPair(settle(["chunk", [text(1.3)], null, text(1.7)])), [at(1.7), at(1.7)]);
  });

  // ---- 16g. 截断窗口与乱序结算：请求 / 助手行同步 ----
  check("窗口无 step/start：attempt 先到，行取它那个时刻（官方 settleTiming 的先到者胜）", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 5 }, 0.5),
      event("assistant/attempt", { turn: 5, step: 2, stream: [text(1.5)] }, 1.2),
      event("assistant/message", {
        turn: 5,
        step: 2,
        message: message("半截窗口的答", {}),
        stream: [text(1.7)],
      }, 2),
    ], false);
    const cell = assistantCell(model);
    assert.strictEqual(model.requests.length, 0, "没有 step/start，请求表里就没有这一步");
    assert.strictEqual(cell?.assistantMetrics?.firstTokenTime, at(1.5), "attempt 先到：行取 1500 而不是 1700");
    assert.strictEqual(cell?.assistantMetrics?.stepStartTime, null, "没有 step/start → 步骤开始时刻仍是 null（TTFT 不可用）");
    assert.strictEqual(cell?.assistantMetrics?.timingRecorded, false);
    assert.strictEqual(cell?.requestNumber, undefined, "不挂别人的请求号");
  });

  check("窗口无 step/start：同一步重复结算的行读同一份首 token", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 5 }, 0.5),
      event("assistant/attempt", { turn: 5, step: 2, stream: [text(1.5)] }, 1.2),
      event("assistant/message", { turn: 5, step: 2, message: message("第一次", {}), stream: [text(1.7)] }, 2),
      event("assistant/message", { turn: 5, step: 2, message: message("第二次", {}), stream: [text(1.9)] }, 3),
    ], false);
    assert.deepStrictEqual(
      model.turns.flatMap(trajectoryTurnCells)
        .filter((cell) => cell.kind === "message")
        .map((cell) => cell.assistantMetrics?.firstTokenTime),
      [at(1.5), at(1.5)],
      "官方一个 step 只有一份 state：两行读同一份先到者胜",
    );
  });

  check("窗口无 step/start：message 先到、晚 attempt 不覆盖", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 5 }, 0.5),
      event("assistant/message", { turn: 5, step: 2, message: message("先结算", {}), stream: [text(1.7)] }, 2),
      event("assistant/attempt", { turn: 5, step: 2, stream: [text(1.5)] }, 2.1),
    ], false);
    assert.strictEqual(assistantCell(model)?.assistantMetrics?.firstTokenTime, at(1.7), "先到者胜：晚到的更早时刻不覆盖");
  });

  check("乱序结算：晚 attempt 只补它自己那一步，请求与行同步", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 2 }, 0.5),
      event("step/start", { turn: 2, step: 1 }, 0.9),
      event("step/start", { turn: 2, step: 2 }, 0.95),
      event("assistant/message", { turn: 2, step: 2, message: message("第二步", {}), stream: [text(2.5)] }, 2),
      event("assistant/attempt", { turn: 2, step: 1, stream: [text(1.5)] }, 2.1),
      event("assistant/message", { turn: 2, step: 1, message: message("第一步", {}), stream: [text(1.7)] }, 3),
    ], false);
    const rows = new Map(
      model.turns.flatMap(trajectoryTurnCells)
        .filter((cell) => cell.kind === "message")
        .map((cell) => [cell.step, cell]),
    );
    assert.deepStrictEqual(
      model.requests.map((request) => [request.step, request.assistantFirstTokenTime]),
      [[1, at(1.5)], [2, at(2.5)]],
      "两步各自的首 token 不串（请求级）",
    );
    assert.deepStrictEqual(
      [rows.get(1)?.assistantMetrics?.firstTokenTime, rows.get(2)?.assistantMetrics?.firstTokenTime],
      [at(1.5), at(2.5)],
      "记录级与请求级同值",
    );
    assert.deepStrictEqual([rows.get(1)?.requestNumber, rows.get(2)?.requestNumber], [1, 2], "各挂各的请求号");
  });

  check("显式未命中 + 同身份的 attempt/message：行只带自己那一步的首 token，不碰别人的请求", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0.5),
      event("step/start", { turn: 1, step: 1 }, 0.9),
      // 越界的两帧：turn 1 / step 2 没有 step/start
      event("assistant/attempt", { turn: 1, step: 2, stream: [text(1.4)] }, 1.2),
      event("assistant/message", { turn: 1, step: 2, message: message("越界的答", {}), stream: [text(1.6)] }, 1.8),
      event("assistant/message", { turn: 1, step: 1, message: message("窗口当前步的答", {}), stream: [text(2.0)] }, 2),
    ], false);
    const rows = new Map(
      model.turns.flatMap(trajectoryTurnCells)
        .filter((cell) => cell.kind === "message")
        .map((cell) => [cell.step, cell]),
    );
    assert.strictEqual(model.requests.length, 1, "越界帧不新开请求");
    assert.strictEqual(model.requests[0]?.assistantFirstTokenTime, at(2.0), "第 1 步请求只认自己的结算帧");
    assert.strictEqual(rows.get(1)?.requestNumber, 1, "第 1 步行挂第 1 个请求");
    assert.strictEqual(
      rows.get(2)?.assistantMetrics?.firstTokenTime,
      at(1.4),
      "越界那一步的行仍取该身份自己的先到者胜（官方 fallbackState 按事件顺序重放这两帧）",
    );
    assert.strictEqual(rows.get(2)?.requestNumber, undefined, "越界行不挂任何请求号");
  });

  check("缺 turn/step 回落：畸形帧退回窗口当前步，请求与行同步", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0.5),
      event("step/start", { turn: 1, step: 1 }, 0.9),
      event("assistant/message", {
        message: message("没带坐标", {}),
        stream: [text(1.7)],
        usage: { inputTokens: 5, outputTokens: 1 },
      }, 2),
    ], false);
    const cell = assistantCell(model);
    assert.strictEqual(model.requests.length, 1, "退回窗口当前步的请求");
    assert.strictEqual(cell?.requestNumber, 1, "行挂当前步的请求号");
    assert.strictEqual(model.requests[0]?.assistantFirstTokenTime, at(1.7), "请求级首 token");
    assert.strictEqual(cell?.assistantMetrics?.firstTokenTime, at(1.7), "记录级同值");
  });

  check("孤儿行先结算且没有 token：同身份晚 attempt 要回填已经产出的行", () => {
    /**
     * 官方 `fallbackState()` 对同一身份的事件按顺序重放：`assistant/message`
     * （`settleMessage`，stream 缺省 / null / 只有非 token 帧时 `settleTiming` 不写值）
     * 之后 `assistant/attempt`（`settleTiming` 的 `state.firstTokenTime ?? 2200`），
     * `finalNode()` 读到的就是 2200。**行读的是同一份 state**，所以先产出的那一行也必须
     * 回填——与有请求那条路径的 `publishFirstToken()` 对称，不能只补请求表。
     */
    const orphanSettle = (stream?: unknown): TrajectoryModel => {
      seq = 0;
      return deriveTrajectoryModel([
        event("turn/start", { turn: 5 }, 0.5),
        event("assistant/message", {
          turn: 5,
          step: 2,
          message: message("先结算但没 token", {}),
          ...(stream === undefined ? {} : { stream }),
        }, 2),
        event("assistant/attempt", { turn: 5, step: 2, stream: [text(2.2)] }, 2.1),
      ], false);
    };
    for (const stream of [undefined, null, [], [raw(1.9, { type: "block-start", index: 0 })]] as unknown[]) {
      const model = orphanSettle(stream);
      assert.strictEqual(model.requests.length, 0, "没有 step/start 就没有请求");
      assert.strictEqual(
        assistantCell(model)?.assistantMetrics?.firstTokenTime,
        at(2.2),
        `message.stream = ${JSON.stringify(stream) ?? "缺省"} 时，晚 attempt 的 2200 要落回已经产出的孤儿行`,
      );
    }
  });

  check("孤儿行重复结算：后续行带来 token 时，先前各行同值", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 5 }, 0.5),
      event("assistant/message", { turn: 5, step: 2, message: message("第一次", {}), stream: [] }, 2),
      event("assistant/message", { turn: 5, step: 2, message: message("第二次", {}), stream: [text(1.9)] }, 3),
    ], false);
    assert.deepStrictEqual(
      model.turns.flatMap(trajectoryTurnCells)
        .filter((cell) => cell.kind === "message")
        .map((cell) => cell.assistantMetrics?.firstTokenTime),
      [at(1.9), at(1.9)],
      "同一步各行读同一份先到者胜（官方一个 step 一份 state）",
    );
  });

  check("有请求的同一步重复结算：后到的 token 同样回填先前各行（与孤儿路径同一口径）", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0.5),
      event("step/start", { turn: 1, step: 1 }, 0.9),
      event("assistant/message", { turn: 1, step: 1, message: message("第一次", {}), stream: [] }, 2),
      event("assistant/message", { turn: 1, step: 1, message: message("第二次", {}), stream: [text(1.9)] }, 3),
    ], false);
    const rows = model.turns.flatMap(trajectoryTurnCells).filter((cell) => cell.kind === "message");
    assert.deepStrictEqual(
      rows.map((cell) => cell.assistantMetrics?.firstTokenTime),
      [at(1.9), at(1.9)],
      "先产出的那一行不能停在 null：官方那份 state 只有一个首 token",
    );
    assert.strictEqual(model.requests[0]?.assistantFirstTokenTime, at(1.9), "请求级同值");
    assert.deepStrictEqual(rows.map((cell) => cell.requestNumber), [1, 1], "两行挂同一个请求号");
  });

  runChecks("F03 剩余三项");
}
console.log("trajectory: 越界 retry 徽章 / 非法 stream 形状 / 截断窗口时序（F03） ✓");

// ---------- 17. F04：`llm/retry` 的整份状态重置与诊断替换组合 ----------
/**
 * 官方 `trajectory-assistant-definition.ts`（固定 `639ed015…` = `refs/tags/dsh-v0.2.0-rc.2`）
 * 的 `update` 里 `llm/retry` 那一支是**整份重置**：
 *
 *     return { ...initialState(state.turn, state.step, state.startSeq, state.startTime, true),
 *              firstTokenTime: state.firstTokenTime, usage: state.usage, retry: {…} }
 *
 * 即「回到刚 `step/start` 的状态、再挂这一条新 retry」，只把**首 token 与用量**带过去。
 * 于是那一帧之后官方 `assistantRequest()` 看到的是：
 *
 * - `state.final` 没了 → `node` 为 `undefined`：`completedAt = boundary?.time ?? null`
 *   （旧 final 的收尾时刻作废）、`providerMetadata` 没有来源（身份随节点一起消失）；
 * - `state.retry !== undefined` → 状态 `error`；
 * - `error` / `errorCode` 就是**这一条** retry 的（`displayFailure(AUTH)` 给
 *   `{code:'AUTH', message:''}`——空文案在公开模型里规范化为缺席；没有 `code` 就没有该键，
 *   都不保留上一条）；
 * - `retry` / `maxRetries` / `retryDelayMs` 同样是这一条的（`maxRetries` 只在
 *   `mode === 'normal'` 时记）。
 *
 * `requestConfig` 是快照层 `applyHeader()` 另挂的（`header.latest.prompt.config`，也就是
 * 线格式 `request/header` 的 `event.data.header.config`），**不属于 state 重置**；本扩展
 * 对应「身份见 `provider`/`model`、配置见 `options`」两条线：身份被重置后，这一请求最后一次
 * 生效的 header 配置重新作为兜底（`applyHeaderConfig` 的既有口径「还没有身份时兜底」）。
 *
 * 台账行不跟着重置：本扩展的既定口径是「每次结算各出一行」，旧行保留它自己那一次的结算事实
 * （官方一个 step 只发布一个节点，没有这个形态）。
 */
{
  const checks: { name: string; run: () => void }[] = [];
  const check = (name: string, run: () => void): void => {
    checks.push({ name, run });
  };
  const runChecks = (title: string): void => {
    const failed: string[] = [];
    for (const entry of checks) {
      try {
        entry.run();
        console.log(`  ✓ ${entry.name}`);
      } catch (error) {
        failed.push(`${entry.name} —— ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`${title}（${failed.length}/${checks.length} 条不成立）\n  - ${failed.join("\n  - ")}`);
    }
  };
  /** `EpochHeader` 的**线格式**：`request/header` 的 `data` 是 `{header: {config, tools?}, reason}`。 */
  const header = (config: Record<string, unknown>, reason = "initial", offset = 0): SessionWireEvent =>
    event("request/header", { header: { config, tools: [] }, reason }, offset);
  /** 一条 `llm/retry`（第 1 轮第 1 步）。 */
  const retry = (
    failure: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    offset = 1.4,
  ): SessionWireEvent =>
    event("llm/retry", {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 3,
      mode: "normal",
      delayMs: 40,
      failure,
      ...extra,
    }, offset);
  /** 第 1 轮第 1 步的一次结算（`stream` 的首 token 固定在 `at(1.5)`）。 */
  const settled = (
    source: Record<string, unknown> = { provider: "p1", model: "m1" },
    extra: Record<string, unknown> = {},
    offset = 2,
  ): SessionWireEvent =>
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: message("答", source),
      usage: { inputTokens: 8, outputTokens: 5 },
      stream: [{ type: "chunk", time: at(1.5), chunk: { type: "text-delta", index: 0, text: "答" } }],
      ...extra,
    }, offset);
  const stepStart = (): SessionWireEvent[] => [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 1.1),
  ];
  const assistant = (events: SessionWireEvent[]) =>
    deriveTrajectoryModel(events, false).requests.find((entry) => entry.purpose === "assistant");

  check("final 后 retry：旧收尾时刻作废、状态 error、首 token 与用量保留", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      settled(),
      retry({ code: "SERVER", message: "failed" }, {}, 3),
    ]);
    assert.strictEqual(request?.status, "error", "retry 出现即 error（官方 state.retry !== undefined）");
    assert.strictEqual(
      request?.completedAt,
      null,
      "旧 final 的收尾时刻随 state 重置作废：官方那支此时 node 为 undefined，completedAt = boundary?.time ?? null",
    );
    assert.strictEqual(request?.startedAt, at(1.1), "startTime 由 initialState 原样带过");
    assert.strictEqual(request?.assistantFirstTokenTime, at(1.5), "firstTokenTime 由重置原样带过");
    assert.deepStrictEqual(request?.usage, { input: 8, output: 5 }, "usage 由重置原样带过");
    assert.strictEqual(request?.error, "failed", "诊断是这一条 retry 的");
    assert.strictEqual(request?.errorCode, "SERVER");
    assert.deepStrictEqual(request?.retry, { attempt: 1, max: 3 });
    assert.strictEqual(request?.retryDelayMs, 40);
    const cell = deriveTrajectoryModel([...stepStart(), settled(), retry({ code: "SERVER", message: "failed" }, {}, 3)], false)
      .turns.flatMap(trajectoryTurnCells)
      .find((entry) => entry.kind === "message");
    assert.strictEqual(cell?.status, "complete", "账本行不因后来的 retry 改写（每次结算各出一行）");
    assert.strictEqual(cell?.assistantMetrics?.completedTime, at(2), "旧行保留它自己那一次的结算时刻");
  });

  check("final 后 retry：身份随 final 一起消失（没有 header 兜底时缺席）", () => {
    seq = 0;
    const request = assistant([...stepStart(), settled(), retry({ code: "SERVER", message: "failed" }, {}, 3)]);
    assert.strictEqual(request?.provider, undefined, "providerMetadata 只来自当前 final，旧身份不残留");
    assert.strictEqual(request?.model, undefined);
    assert.strictEqual(request?.options, undefined, "没有 header 就没有配置兜底");
  });

  check("interrupted 结算后 retry：同样作废已结算时刻", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      settled({ provider: "p1", model: "m1" }, { interrupted: true }),
      retry({ code: "RATE_LIMIT", message: "retry" }, {}, 3),
    ]);
    assert.strictEqual(request?.completedAt, null, "中断节点也是 final，state 重置后同样作废");
    assert.strictEqual(request?.status, "error");
    assert.strictEqual(request?.assistantFirstTokenTime, at(1.5), "首 token 保留");
    assert.strictEqual(request?.errorCode, "RATE_LIMIT");
  });

  check("AUTH retry 整份替换此前文案与码", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      retry({ code: "SERVER", message: "old" }, {}, 1.2),
      retry({ code: "AUTH", message: "private" }, { retry: 2, mode: "unlimited", maxRetries: 9, delayMs: 90 }, 1.6),
    ]);
    assert.strictEqual(request?.status, "error");
    assert.strictEqual(request?.error, undefined, "AUTH 的空文案规范化为缺席，不许留着上一条的 old");
    assert.strictEqual(request?.errorCode, "AUTH", "码换成这一条的");
    assert.deepStrictEqual(request?.retry, { attempt: 2 }, "mode !== normal 不记 maxRetries");
    assert.strictEqual(request?.retryDelayMs, 90, "延迟也整份换成这一条的");
    assert.strictEqual(request?.completedAt, null, "没有 final、也没有边界 → 收尾缺席");
  });

  check("无码 retry 不遗留旧码", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      retry({ code: "SERVER", message: "old" }, {}, 1.2),
      retry({ message: "new" }, { retry: 2 }, 1.6),
    ]);
    assert.strictEqual(request?.error, "new");
    assert.strictEqual(request?.errorCode, undefined, "这一条没有 code，旧的 SERVER 必须清掉");
    assert.deepStrictEqual(request?.retry, { attempt: 2, max: 3 });
  });

  check("有码多次 retry：诊断整份换成最后一条", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      retry({ code: "RATE_LIMIT", message: "a" }, { retry: 1 }, 1.2),
      retry({ code: "SERVER", message: "b" }, { retry: 2 }, 1.4),
      retry({ code: "AUTH", message: "c" }, { retry: 3 }, 1.6),
    ]);
    assert.strictEqual(request?.error, undefined, "最后一条是 AUTH → 文案缺席");
    assert.strictEqual(request?.errorCode, "AUTH");
    assert.deepStrictEqual(request?.retry, { attempt: 3, max: 3 });
  });

  check("retry 后新结算：按当前 final 判 complete、身份取当前 final、收尾取新时刻", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      ...stepStart(),
      header({ provider: "header-provider", model: "header-model" }, "initial", 1.2),
      settled({ provider: "old-provider", model: "old-model" }, {}, 2),
      retry({ code: "SERVER", message: "again" }, {}, 3),
      settled({ model: "new-model" }, {}, 4),
    ], false);
    const request = model.requests.find((entry) => entry.purpose === "assistant");
    assert.strictEqual(request?.status, "complete", "新 final 是非中断节点 → complete（complete 优先）");
    assert.strictEqual(request?.completedAt, at(4), "收尾取当前 final 的时刻，不是旧 final 的 at(2)");
    assert.strictEqual(request?.provider, "header-provider", "新 source 没带 provider → 身份清空后配置兜底");
    assert.strictEqual(request?.model, "new-model", "新 final 逐字段优先于配置兜底");
    assert.strictEqual(request?.error, "again", "重试诊断在成功结算后照旧保留（官方 state.retry 不随 settle 清）");
    assert.strictEqual(request?.errorCode, "SERVER");
    assert.deepStrictEqual(request?.retry, { attempt: 1, max: 3 });
    assert.strictEqual(request?.assistantFirstTokenTime, at(1.5), "首 token 仍是先到者胜那一份");
    assert.deepStrictEqual(request?.usage, { input: 8, output: 5 }, "用量取当前 state 那一份");
    assert.deepStrictEqual(
      request?.options,
      { provider: "header-provider", model: "header-model" },
      "配置是另一条线：线上的 request/header 的 config",
    );
  });

  check("retry 之后到达的 header 能重新兜底身份（settled 标记随重置清掉）", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      header({ provider: "h1", model: "m1" }, "initial", 1.15),
      settled({ provider: "old-p", model: "old-m" }, {}, 2),
      retry({ code: "SERVER", message: "x" }, {}, 3),
      header({ provider: "h2", model: "m2" }, "tools", 3.5),
    ]);
    assert.strictEqual(request?.provider, "h2", "身份重置后，后到的 header 配置重新成为兜底");
    assert.strictEqual(request?.model, "m2");
    assert.deepStrictEqual(request?.options, { provider: "h2", model: "m2" });
    assert.strictEqual(request?.status, "error");
    assert.strictEqual(request?.completedAt, null);
  });

  check("显式越界 retry 不重置任何请求（身份查不到就谁都不写）", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      settled(),
      retry({ message: "foreign" }, { turn: 9, step: 4 }, 3),
    ]);
    assert.strictEqual(request?.completedAt, at(2), "收尾时刻不被越界帧清掉");
    assert.strictEqual(request?.status, "complete", "状态不被越界帧改判");
    assert.strictEqual(request?.provider, "p1", "身份不被越界帧清掉");
    assert.strictEqual(request?.error, undefined, "诊断不被越界帧写");
    assert.strictEqual(request?.retry, undefined);
  });

  check("跨轮与压缩隔离：retry 只重置自己那一步的请求", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0),
      event("step/start", { turn: 1, step: 1 }, 1.1),
      settled(),
      event("step/end", { turn: 1, step: 1 }, 2.1),
      event("turn/end", { turn: 1, reason: "completed" }, 2.2),
      event("compaction/start", { turn: null }, 2.5),
      event("turn/start", { turn: 2 }, 3),
      event("step/start", { turn: 2, step: 1 }, 3.1),
      event("assistant/message", {
        turn: 2,
        step: 1,
        message: message("第二轮的答", { provider: "p2", model: "m2" }),
        usage: { inputTokens: 20, outputTokens: 7 },
      }, 4),
      // 晚到的（乱序）retry：只认它自己那条身份
      retry({ code: "SERVER", message: "late" }, {}, 5),
      // 压缩请求的身份不在助手那张表里（turn 为 null）→ 谁都不写
      event("llm/retry", {
        turn: null,
        step: 0,
        retry: 1,
        maxRetries: 3,
        mode: "normal",
        delayMs: 40,
        failure: { code: "SERVER", message: "null-turn" },
      }, 5.5),
    ], false);
    const first = model.requests.find((entry) => entry.purpose === "assistant" && entry.turn === 1);
    const second = model.requests.find((entry) => entry.purpose === "assistant" && entry.turn === 2);
    const compaction = model.requests.find((entry) => entry.purpose === "compaction");
    /**
     * 第 1 轮那一步在这个窗口里**先** `step/end` / `turn/end` 过、晚到的 retry 才来——
     * 这正是上面那条契约标注的 durable 不可能序列，所以这里只钉「重置发生了」与
     * 「别的请求没被动」：旧 final 的结算时刻必须不残留，具体落到哪个边界（state 分支
     * 已随重置清掉、位置索引那一支本扩展没有）不在本判据里声明。
     */
    assert.notStrictEqual(first?.completedAt, at(2), "旧 final 的收尾时刻不残留（边界分支见上一条契约标注）");
    assert.strictEqual(first?.status, "error", "第 1 轮那一步被自己的 retry 重置");
    assert.strictEqual(first?.error, "late");
    assert.deepStrictEqual(first?.retry, { attempt: 1, max: 3 });
    assert.strictEqual(first?.provider, undefined, "旧身份随 final 一起清掉");
    assert.strictEqual(second?.completedAt, at(4), "第 2 轮的请求不受影响");
    assert.strictEqual(second?.status, "complete");
    assert.strictEqual(second?.provider, "p2");
    assert.strictEqual(second?.error, undefined);
    assert.strictEqual(compaction?.status, "running", "压缩请求不被 llm/retry 触碰");
    assert.strictEqual(compaction?.error, undefined);
    assert.strictEqual(compaction?.retry, undefined);
    assert.strictEqual(compaction?.completedAt, null);
  });

  check("旧 step/end 的契约标注：重置只认 state 分支，不回溯 closedStep（durable 不可能序列）", () => {
    /**
     * 顺序 `step/end` → 同一 step 的 `llm/retry` 在 durable 流里不可能出现（重试发生在这次
     * 模型调用**期间**，`step/end` 是它收尾之后才写的），所以这里只标契约、**不声称官方等价**：
     * 官方 `initialState()` 把 `state.stepEnd` 清掉，`closedBoundary()` 的第一支随之失效；
     * 它另有位置索引那一支（`location.step.status === 'closed'`）会给出同一步的 `step/end`，
     * 本扩展没有那一层，重置后不再回溯这个旧边界。
     */
    seq = 0;
    const request = assistant([
      ...stepStart(),
      settled(),
      event("step/end", { turn: 1, step: 1 }, 2.5),
      retry({ code: "SERVER", message: "after-end" }, {}, 3),
    ]);
    assert.strictEqual(request?.completedAt, null, "重置后旧 step/end 不再是边界（契约标注）");
    assert.strictEqual(request?.status, "error");
    assert.strictEqual(request?.error, "after-end");
  });

  check("合法 mode / maxRetries：只有 mode === 'normal' 才记上限", () => {
    const attemptsFor = (extra: Record<string, unknown>): unknown => {
      seq = 0;
      return assistant([...stepStart(), retry({ code: "SERVER", message: "x" }, extra, 1.4)])?.retry;
    };
    assert.deepStrictEqual(attemptsFor({ retry: 1, maxRetries: 5, mode: "normal" }), { attempt: 1, max: 5 });
    assert.deepStrictEqual(attemptsFor({ retry: 1, maxRetries: 5, mode: "unlimited" }), { attempt: 1 });
    assert.deepStrictEqual(attemptsFor({ retry: 1, maxRetries: 5, mode: undefined }), { attempt: 1 });
  });

  check("final → retry → turn/end：收尾取边界（轮次结束时刻）", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      settled(),
      retry({ message: "failed" }, {}, 3),
      event("turn/end", { turn: 1, reason: { kind: "completed" } }, 4.5),
    ]);
    assert.strictEqual(request?.completedAt, at(4.5), "重置后 completedAt 为 null，边界补上轮次结束时刻");
    assert.strictEqual(request?.status, "error", "没有非中断的最终节点 → 仍 error");
    assert.strictEqual(request?.assistantFirstTokenTime, at(1.5));
    assert.strictEqual(request?.provider, undefined, "身份仍随旧 final 消失");
  });

  check("retry → turn/end 终态失败：诊断按终态那一份覆盖（与 state 重置分开）", () => {
    seq = 0;
    const request = assistant([
      ...stepStart(),
      retry({ code: "SERVER", message: "old" }, {}, 1.2),
      event("turn/end", {
        turn: 1,
        reason: { kind: "error", error: { code: "AUTH", message: "private" } },
      }, 4.5),
    ]);
    assert.strictEqual(request?.status, "error");
    assert.strictEqual(request?.error, undefined, "终态 AUTH 空文案覆盖掉 retry 那一份");
    assert.strictEqual(request?.errorCode, "AUTH", "终态码有值才换");
    assert.strictEqual(request?.completedAt, at(4.5));
  });

  check("诊断 3×3 矩阵：后一条 retry 整份替换前一条（SERVER / AUTH / 无码）", () => {
    /**
     * 官方诊断只来自 `state.retry`（每次重置后整份换成新的那一份），所以「旧 → 新」的
     * 九种组合必须处处等于**后一条**的投影：`AUTH` 的空文案规范化为缺席、没有 `code`
     * 就没有该键。主代理在冻结件上实跑同一矩阵时其中四组红（SERVER→AUTH、
     * SERVER→无码、AUTH→无码、无码→AUTH），这里把九组一起钉住。
     */
    const kinds: Record<string, { failure: Record<string, unknown>; error: string | undefined; code: string | undefined }> = {
      SERVER: { failure: { code: "SERVER", message: "server-fail" }, error: "server-fail", code: "SERVER" },
      AUTH: { failure: { code: "AUTH", message: "auth-secret" }, error: undefined, code: "AUTH" },
      无码: { failure: { message: "no-code-fail" }, error: "no-code-fail", code: undefined },
    };
    for (const first of Object.keys(kinds)) {
      for (const second of Object.keys(kinds)) {
        seq = 0;
        const request = assistant([
          ...stepStart(),
          retry(kinds[first].failure, { retry: 1 }, 1.2),
          retry(kinds[second].failure, { retry: 2 }, 1.6),
        ]);
        const expected = kinds[second];
        assert.deepStrictEqual(
          [request?.error, request?.errorCode, request?.retry, request?.status],
          [expected.error, expected.code, { attempt: 2, max: 3 }, "error"],
          `${first} → ${second}：诊断与状态必须整份等于后一条`,
        );
        assert.ok(!JSON.stringify(request).includes("auth-secret"), `${first} → ${second}：AUTH 原文不进模型`);
      }
    }
  });

  check("重置恢复身份只认这一请求自己的 header 配置（不套当前另一轮的 effectiveHeader）", () => {
    /**
     * 官方 `headerFor()` 按 `turn:step` 归属（`headersByStep` 预扫描，否则继承
     * `previous.seq < request.startSeq` 的那一份），**不是**「窗口里最新的那份配置」。
     * 本扩展对应的内部记录是 `appliedHeader`（每个请求最后一次实际生效的配置）：
     * 显式指向旧步的晚 retry 到来时，窗口当前生效的 header 已经是下一轮的 pB/mB，
     * 恢复出来的身份仍必须是旧步自己那份 pA/mA。
     */
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }, 0),
      event("step/start", { turn: 1, step: 1 }, 1.1),
      header({ provider: "pA", model: "mA" }, "initial", 1.15),
      settled(),
      event("step/end", { turn: 1, step: 1 }, 2.1),
      event("turn/end", { turn: 1, reason: "completed" }, 2.2),
      event("turn/start", { turn: 2 }, 3),
      event("step/start", { turn: 2, step: 1 }, 3.1),
      header({ provider: "pB", model: "mB" }, "tools", 3.15),
      event("assistant/message", {
        turn: 2,
        step: 1,
        message: message("第二轮的答", { model: "m2" }),
        usage: { inputTokens: 20, outputTokens: 7 },
      }, 4),
      retry({ code: "SERVER", message: "late" }, {}, 5),
    ], false);
    const first = model.requests.find((entry) => entry.purpose === "assistant" && entry.turn === 1);
    const second = model.requests.find((entry) => entry.purpose === "assistant" && entry.turn === 2);
    assert.strictEqual(first?.provider, "pA", "恢复的是这一请求自己那份配置");
    assert.strictEqual(first?.model, "mA");
    assert.deepStrictEqual(first?.options, { provider: "pA", model: "mA" }, "选项同样是这一请求自己那份");
    assert.strictEqual(second?.provider, "pB", "另一轮的请求不受这次重置影响");
    assert.strictEqual(second?.model, "m2", "第二轮结算帧的身份逐字段优先");
    assert.deepStrictEqual(second?.options, { provider: "pB", model: "mB" });
  });

  runChecks("F04 retry 状态重置");
}
console.log("trajectory: llm/retry 整份状态重置与诊断替换（F04） ✓");

// ---------- 18. F05：系统更新归轮（`enclosingPromptTurn`）、布局 partial 身份与前插编号 ----------
/**
 * 官方 `packages/client/ui-trajectory/src/client/trajectory-layout.ts` 与
 * `trajectory-assistant-definition.ts`（固定基准 `639ed015…` = `refs/tags/dsh-v0.2.0-rc.2`）
 * 里与本批有关的三件事：
 *
 * 1. **提示词那一行归哪一轮**（布局的 system 分支）：
 *    - 初始行 `firstVisibleTurn(nodes, partial)`：`nodes` 里 `kind === 'assistant' && turn > 0`
 *      的轮次取**最小**，`partial.turn > 0` 也并进候选，一个候选都没有就是 **1**；
 *    - 更新行 `enclosingPromptTurn(nodes, change.seq, partial)`：`nodes` 里**第一个**
 *      `node.seq > change.seq && kind === 'assistant' && node.step > 0` 的节点所在轮次，
 *      没有就 `partial?.turn ?? 1`。
 *
 *    两处都**不是**「这一帧到达时事件流正在哪一轮」（从前这里拿窗口的 `currentTurn` 顶）。
 *    窗口带前插历史、整轮收尾之后再改提示词、或在跑的流还没有 node 时，两种读法给出不同答案。
 *
 * 2. **`partial` 是哪个身份**（`buildViewNode()`）：
 *    `node === undefined && boundary === undefined && state.sawChunk` 才是「在跑的流」，
 *    快照层（`trajectory-snapshot-builder.ts`：`if (data.partial !== null) partial = data.partial`）
 *    只留**最后一个**非空的那一个，contributions 按 `anchorSeq` 升序迭代（`anchorSeq` 就是
 *    这个身份第一次出现的 `seq`）。逐条口径：
 *    - `assistant/live-chunk` 的**任何** chunk 都置 `sawChunk`（`usage` / `finish` 走各自分支、
 *      未知 `type` 落 `default`，三支都置位）；
 *    - `settleMessage()` 清 `sawChunk` 并落下 `final`（`node` 从此存在）；
 *    - `llm/retry` 走 `initialState()` **整份重置**（`sawChunk` 与 `final` 一起清）；
 *    - `closedBoundary()` 看见 `step/end`（或位置索引里已关闭的步骤 / 轮次）→ `boundary` 成立
 *      → 同样不发 `partial`；
 *    - `assistant/attempt` 只做 `settleTiming()`：**不置也不清** `sawChunk`。
 *    窗口里没有 `step/start` 时官方那台状态机由 `fallbackState()` 按该身份自己的帧重建
 *    （`live-chunk` / `attempt` / `message` / `step/end`），本扩展的等价物同样按帧自己的
 *    `turn:step` 记状态，且**不出请求**（`assistantRequest()` 第一句 `!state.started`）。
 *
 * 3. **记账顺序 ≠ 显示顺序**：官方 index 是在 `layoutEntryOrder()` 那一趟里递增的
 *    （初始行 -Infinity 先记 1），输出侧又按 `firstCellIndex` 重排轮次、prologue 还把
 *    turn 0 的组拼进 turn 1——两趟顺序可以不同，角落里的 `#N` 因此**不单调**。本扩展的
 *    既定不变量是「摊平顺序 = 显示序号」（见设计文档的排序与合并规则），所以分组定稿后
 *    按摊平顺序**统一重编一次显示序号**：它只改 `#N`，与源事件 `seq`、请求号、归属步骤无关。
 *
 * 本扩展的刻意差异不变：不出流式正文行，`partial` 只用于**归轮**（身份），不发布流式内容。
 * 合法的「未知 `type`」chunk 与畸形帧（没有 `chunk` 对象）分开：前者与官方 `default` 分支
 * 等价（置 `sawChunk`），后者是适配边界（不置），不拿畸形事件替合法等价。
 */
{
  const checks: { name: string; run: () => void }[] = [];
  const check = (name: string, run: () => void): void => {
    checks.push({ name, run });
  };
  const runChecks = (title: string): void => {
    const failed: string[] = [];
    for (const entry of checks) {
      try {
        entry.run();
        console.log(`  ✓ ${entry.name}`);
      } catch (error) {
        failed.push(`${entry.name} —— ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`${title}（${failed.length}/${checks.length} 条不成立）\n  - ${failed.join("\n  - ")}`);
    }
  };
  /** 账本摊平后的记录（**显示顺序**）。 */
  const flat = (model: TrajectoryModel): TrajectoryCell[] => model.turns.flatMap(trajectoryTurnCells);
  const systemCells = (model: TrajectoryModel): TrajectoryCell[] =>
    flat(model).filter((cell) => cell.kind === "system");
  const initialCell = (model: TrajectoryModel): TrajectoryCell | undefined =>
    systemCells(model).find((cell) => cell.promptChange === "initial");
  const updateCell = (model: TrajectoryModel): TrajectoryCell | undefined =>
    systemCells(model).find((cell) => cell.promptChange !== "initial");
  /** `request/header` 的线格式：`{header: {config, tools}, reason}`。 */
  const header = (reason: string, tool: string): SessionWireEvent =>
    event("request/header", {
      header: {
        config: { provider: "fixture", model: "fixture" },
        tools: [{ name: tool, description: "夹具", parameters: { type: "object" } }],
      },
      reason,
    });
  const initialHeader = (): SessionWireEvent => header("initial", "alpha");
  const changeHeader = (): SessionWireEvent => header("tools", "beta");
  /** 一条 `assistant/live-chunk`（`chunkValue` 省略即默认的正文增量）。 */
  const chunk = (turn: number, step: number, chunkValue?: Record<string, unknown>): SessionWireEvent =>
    event("assistant/live-chunk", { turn, step, chunk: chunkValue ?? { type: "text-delta", index: 0, text: "x" } });
  /** 一条已结算的 `assistant/message`。 */
  const settled = (turn: number, step: number): SessionWireEvent =>
    event("assistant/message", { turn, step, message: message("答", {}), stream: [] });
  /** 一条 `llm/retry`（普通模式、带上限）。 */
  const retry = (turn: number, step: number): SessionWireEvent =>
    event("llm/retry", {
      turn,
      step,
      retry: 1,
      maxRetries: 3,
      mode: "normal",
      delayMs: 40,
      failure: { code: "SERVER", message: "boom" },
    });
  const completed = (turn: number): SessionWireEvent =>
    event("turn/end", { turn, reason: { kind: "completed" } });
  const stepEnd = (turn: number, step: number): SessionWireEvent => event("step/end", { turn, step });

  // ---- 18a. 系统更新行的归轮（官方 `enclosingPromptTurn()`） ----
  check("A 更新归随后助手那一轮，不是它到达时所在的轮", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 1 }),
      event("step/start", { turn: 1, step: 1 }),
      initialHeader(),
      settled(1, 1),
      stepEnd(1, 1),
      completed(1),
      changeHeader(),
      event("turn/start", { turn: 2 }),
      event("step/start", { turn: 2, step: 1 }),
      settled(2, 1),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 2, "随后那条助手记录在第 2 轮");
    assert.strictEqual(model.turns.filter((turn) => turn.turn === 2).length, 1, "第 2 轮不因此被拆段");
    assert.strictEqual(initialCell(model)?.turn, 1, "初始行仍归最早可见的第 1 轮");
  });

  check("B 没有随后助手、也没有在跑的流 → 官方默认轮号 1", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 9 }),
      initialHeader(),
      changeHeader(),
      completed(9),
    ], false);
    assert.strictEqual(updateCell(model)?.turn, 1, "`partial?.turn ?? 1` 的兜底");
  });

  check("C 缺 `step/start` 的在跑流参与初始提示词归轮，且不建请求、不出助手行", () => {
    seq = 0;
    const model = deriveTrajectoryModel([initialHeader(), chunk(7, 3)], true);
    assert.strictEqual(initialCell(model)?.turn, 7, "`partial.turn` 并进 `firstVisibleTurn()` 候选");
    assert.strictEqual(model.requests.length, 0, "官方 `!state.started` → 那一步没有请求");
    assert.strictEqual(
      flat(model).filter((cell) => cell.kind === "message").length,
      0,
      "不出流式正文行（本扩展只出「正在生成」占位，且占位要有 `step/start`）",
    );
  });

  check("D 更新没有随后助手节点时回落在跑的流那一轮", () => {
    seq = 0;
    const model = deriveTrajectoryModel([initialHeader(), changeHeader(), chunk(9, 4)], true);
    assert.strictEqual(updateCell(model)?.turn, 9, "`partial?.turn ?? 1`");
    assert.strictEqual(initialCell(model)?.turn, 9, "初始行走 `firstVisibleTurn()`，同一份 partial");
  });

  check("E `enclosingPromptTurn()` 只认 `step > 0` 的随后助手", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 3 }),
      initialHeader(),
      changeHeader(),
      settled(4, 0),
      settled(6, 2),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 6, "`step === 0` 的那条跳过");
  });

  check("F 取第一个随后的助手，不是轮号最小的那个", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 3 }),
      initialHeader(),
      changeHeader(),
      settled(8, 2),
      settled(2, 1),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 8, "官方是 `nodes.find()` 的顺序，不是 `Math.min`");
  });

  check("K 有随后助手节点时优先于在跑的流", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      initialHeader(),
      chunk(7, 3),
      changeHeader(),
      event("turn/start", { turn: 9 }),
      event("step/start", { turn: 9, step: 1 }),
      settled(9, 1),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 9, "随后节点先于 `partial` 兜底（官方两支的顺序）");
  });

  // ---- 18b. `partial` 身份的成立与清除（官方 `buildViewNode` / `settleMessage` / retry / `closedBoundary`） ----
  check("G 结算（`settleMessage`）清掉 `sawChunk`，尾部更新不归旧轮", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      initialHeader(),
      chunk(7, 3),
      settled(7, 3),
      changeHeader(),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 1, "结算之后没有 partial，回落 1");
  });

  check("G2 `step/end` 的闭合边界（`closedBoundary`）同样不发 partial", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      initialHeader(),
      chunk(7, 3),
      stepEnd(7, 3),
      changeHeader(),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 1, "边界成立 → `buildViewNode` 不发 partial");
  });

  check("G3 `turn/end` 关闭整轮后不发 partial", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      initialHeader(),
      chunk(7, 3),
      completed(7),
      changeHeader(),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 1, "轮次闭合也是 `closedBoundary()` 的来源");
  });

  check("G4 有 `step/start` 时 `llm/retry` 整份重置清掉流来源；之后的 chunk 重新武装", () => {
    /**
     * 官方的 `initialState()` 重置只在**这个身份在窗口里开过 `step/start`** 时才发生
     * （装配器：`else if (context.state !== undefined) definition.update(…)`）——
     * 所以这一条必须带 `step/start`，否则测的是 `fallbackState()` 的孤儿路径
     * （那一路根本没有 retry 分支，见下面 18d 的 L 组）。
     */
    seq = 0;
    const afterRetry = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      event("step/start", { turn: 7, step: 3 }),
      initialHeader(),
      chunk(7, 3),
      retry(7, 3),
      changeHeader(),
    ], true);
    assert.strictEqual(updateCell(afterRetry)?.turn, 1, "`initialState()` 清 `sawChunk`");
    seq = 0;
    const rearmed = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      event("step/start", { turn: 7, step: 3 }),
      initialHeader(),
      chunk(7, 3),
      retry(7, 3),
      chunk(7, 3),
      // 更新的到达轮已经走到 9：回落必须来自 partial（7），不是窗口当前轮
      event("turn/start", { turn: 9 }),
      changeHeader(),
    ], true);
    assert.strictEqual(updateCell(rearmed)?.turn, 7, "重置之后新到的 chunk 又是流来源");
  });

  check("G5 结算后再来 chunk 也不复活 partial（`final` 仍在）", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      initialHeader(),
      chunk(7, 3),
      settled(7, 3),
      chunk(7, 3),
      changeHeader(),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 1, "`node` 存在 → 不是 partial");
  });

  check("G6 有 `step/start` 时 retry 重置连 `final` 一起清（重置后 chunk 可再成 partial）", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 7 }),
      event("step/start", { turn: 7, step: 3 }),
      initialHeader(),
      chunk(7, 3),
      settled(7, 3),
      retry(7, 3),
      chunk(7, 3),
      // 同 G4：更新的到达轮已经走到 9，回落必须来自 partial（7）
      event("turn/start", { turn: 9 }),
      changeHeader(),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 7, "重置把 `final` 与 `sawChunk` 一起清掉");
  });

  check("G7 `usage` / `finish` / 未知 `type` 的合法 chunk 都置 `sawChunk`", () => {
    for (const chunkValue of [
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "finish" },
      { type: "mystery" },
    ]) {
      seq = 0;
      const model = deriveTrajectoryModel([initialHeader(), changeHeader(), chunk(9, 4, chunkValue)], true);
      assert.strictEqual(
        updateCell(model)?.turn,
        9,
        `chunk.type=${String(chunkValue.type)} 也算流来源（官方三支都置 sawChunk）`,
      );
    }
  });

  check("G8 只留最后一个 partial（按身份第一次出现的 `seq`）", () => {
    seq = 0;
    const later = deriveTrajectoryModel([initialHeader(), changeHeader(), chunk(7, 3), chunk(9, 4)], true);
    assert.strictEqual(later.requests.length, 0, "在跑的流不建请求");
    assert.strictEqual(updateCell(later)?.turn, 9, "后出现的身份赢（官方按 `anchorSeq` 排 contributions）");
    seq = 0;
    const earlier = deriveTrajectoryModel([initialHeader(), changeHeader(), chunk(9, 4), chunk(7, 3)], true);
    assert.strictEqual(updateCell(earlier)?.turn, 7, "同一个身份重复 chunk 不改变先后");
  });

  check("G9 `assistant/attempt` 不置也不清 `sawChunk`（只做 `settleTiming`）", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      initialHeader(),
      changeHeader(),
      event("assistant/attempt", {
        turn: 7,
        step: 3,
        stream: [{ type: "chunk", time: at(1), chunk: { type: "text-delta", index: 0, text: "x" } }],
      }),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 1, "只有 attempt 的步骤没有 `sawChunk`，不是在跑的流");
  });

  check("J 畸形 live-chunk（没有 `chunk` 对象）不置 `sawChunk`", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      initialHeader(),
      changeHeader(),
      event("assistant/live-chunk", { turn: 9, step: 4 }),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 1, "适配边界：拿不到 chunk 就不当流来源");
  });

  // ---- 18d. retry 的重置只作用于窗口里开过 `step/start` 的身份（官方 `context.state`） ----
  /**
   * 官方装配器（`ui-conversation` 的 `assembler.ts`，固定 `639ed015…`）只在一个 Context
   * **有 `start` 匹配**时才把帧交给 `update`：
   *
   *     const starting = role === 'start' && context.start === undefined
   *     ...
   *     if (starting) this.replayContext(context)
   *     else if (context.state !== undefined) context.state = definition.update(typed, match)
   *
   * `llm/retry` 在 assistant definition 里 role 是 `update`，所以**窗口里没有该步
   * `step/start`** 时这一帧对状态是个空操作：状态由 `buildViewNode()` 的
   * `fallbackState()` 按该身份自己的帧重放，而 `fallbackState()` 只认
   * `live-chunk` / `attempt` / `message` / `step/end`，**没有 retry 分支**。
   * 于是孤儿流的 `sawChunk`（→ `partial`）与孤儿结算的 `final`（→ `node`）都不被它清掉。
   *
   * 反过来，窗口里**开过** `step/start` 的身份才走 `update`：那一支是 `initialState()`
   * 整份重置（`sawChunk` 与 `final` 一起清），之后新到的 chunk 又能重新武装 partial。
   * 本扩展的请求表那一份同样只在找到该步请求时重置（同一条「窗口里开过 `step/start`」
   * 口径）；重试徽章也只在有请求时写。
   *
   * **历史账本行照旧**：被重置作废的只是**当前布局节点**（`node` / `partial` / 请求状态），
   * 「每次结算各出一行」是既定差异，行本身不回溯、不删除。
   */
  check("L1 缺 `step/start` 的孤儿流：retry 不清 fallback 的 partial", () => {
    seq = 0;
    const model = deriveTrajectoryModel([initialHeader(), changeHeader(), chunk(9, 4), retry(9, 4)], true);
    assert.strictEqual(updateCell(model)?.turn, 9, "官方 `update` 不在没有 start 的 Context 上跑");
    assert.strictEqual(model.requests.length, 0, "孤儿步骤没有请求（`assistantRequest()` 的 `!state.started`）");
  });

  check("L2 缺 `step/start` 的孤儿结算：retry 不作废 final，也不让后到的 chunk 复活 partial", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      initialHeader(),
      chunk(9, 4),
      settled(9, 4),
      retry(9, 4),
      chunk(9, 4),
      changeHeader(),
    ], true);
    assert.strictEqual(
      updateCell(model)?.turn,
      1,
      "`final` 仍在（官方 `fallbackState()` 无 retry 分支）→ 后到的 chunk 只置 `sawChunk`，不发 partial",
    );
    assert.strictEqual(model.requests.length, 0, "孤儿步骤没有请求");
  });

  check("L3 有 `step/start` 的 final 被 retry 作废：布局节点消失、更新归新孤儿 partial", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 6, step: 2 }),
      initialHeader(),
      changeHeader(),
      settled(6, 2),
      retry(6, 2),
      chunk(8, 3),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 8, "旧 final 不再是布局节点（官方 `state.final` 随重置清掉）");
    assert.strictEqual(
      flat(model).filter((cell) => cell.kind === "message" && cell.turn === 6).length,
      1,
      "既定差异：每次结算各出的历史账本行照旧保留",
    );
    assert.strictEqual(model.requests[0]?.status, "error", "重试即失败证据（官方 `state.retry !== undefined`）");
    assert.strictEqual(model.requests[0]?.completedAt, null, "旧收尾时刻随重置作废");
  });

  check("L4 有 `step/start` 的 final 被 retry 作废且无 partial：更新归 1 而不是历史 final 的轮", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 6, step: 2 }),
      initialHeader(),
      changeHeader(),
      settled(6, 2),
      retry(6, 2),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 1, "没有随后节点、也没有 partial → 官方默认轮号 1");
    assert.strictEqual(
      flat(model).filter((cell) => cell.kind === "message" && cell.turn === 6).length,
      1,
      "历史账本行仍保留（不拿它当当前节点）",
    );
  });

  check("L5 有 `step/start` 的流：retry 清 partial，之后的 chunk 重武装", () => {
    seq = 0;
    const cleared = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      retry(9, 4),
    ], true);
    assert.strictEqual(updateCell(cleared)?.turn, 1, "有 start 才走官方 `initialState()` 重置");
    assert.strictEqual(cleared.requests.length, 1, "这一步在窗口里开过请求");
    seq = 0;
    const rearmed = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      retry(9, 4),
      chunk(9, 4),
    ], true);
    assert.strictEqual(updateCell(rearmed)?.turn, 9, "重置之后新到的 chunk 又是流来源");
  });

  check("L6 越界 retry（该身份既无 start 也无请求）不动别人的孤儿 partial", () => {
    seq = 0;
    const model = deriveTrajectoryModel([initialHeader(), changeHeader(), chunk(9, 4), retry(10, 4)], true);
    assert.strictEqual(updateCell(model)?.turn, 9, "别的身份的孤儿 partial 照旧");
    assert.strictEqual(model.requests.length, 0, "越界帧不新开请求");
  });

  check("L7 同一身份重复结算也只留一个当前节点：retry 后整条身份从布局退出", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 6, step: 2 }),
      initialHeader(),
      changeHeader(),
      settled(6, 2),
      settled(6, 2),
      retry(6, 2),
      chunk(8, 3),
    ], true);
    assert.strictEqual(
      updateCell(model)?.turn,
      8,
      "官方一个 definition id 一个 Context（`final` 取最后一次结算），重置后整体作废",
    );
    assert.strictEqual(
      flat(model).filter((cell) => cell.kind === "message" && cell.turn === 6).length,
      2,
      "两条历史账本行都保留（既定差异），但都不参与当前归轮",
    );
  });

  check("L8 初始提示词行也只认当前布局节点：被 retry 作废的 final 不再参与归轮", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 6, step: 2 }),
      initialHeader(),
      changeHeader(),
      settled(6, 2),
      retry(6, 2),
      chunk(8, 3),
    ], true);
    assert.strictEqual(
      initialCell(model)?.turn,
      8,
      "`firstVisibleTurn(nodes, partial)` 的 `nodes` 是**当前**助手节点（官方快照每个 key 只留一份贡献）",
    );
  });

  // ---- 18e. 闭合边界上的**合成中断节点**与重复 `step/start` 的布局生命周期 ----
  /**
   * 官方 `finalNode()`（`trajectory-assistant-definition.ts`，固定 `639ed015…`）的两条支：
   *
   *     const final = state.final
   *     if (final?.event.type === 'assistant/message') { …最终结算节点… }
   *     const boundary = closedBoundary(context)
   *     if (boundary === undefined) return undefined
   *     const blocks = compactBlocks(state.blocks)
   *     if (!hasInterruptionEvidence(blocks)) return undefined
   *     return { kind: 'assistant', seq: boundary.seq - 0.9, …, interrupted: true }
   *
   * `closedBoundary()` 的三条来源：状态机的 `stepEnd`（`step/end`）、位置索引里**步骤**已关闭
   * （同一条 `step/end`）、位置索引里**轮次**已关闭（`turn/end`）——所以步骤自己的边界优先，
   * 其次才是它所在轮次。`hasInterruptionEvidence()` 对 text / reasoning 看 `trim()` 后是否非空，
   * 对**其余种类**（工具调用含空 `name` / 空 `args`、图片、未知块）一律算证据。
   * 这个节点进 `eventNodes`，于是 `firstVisibleTurn()` 与 `enclosingPromptTurn()` 都看得到它。
   *
   * 官方自己的用例（同 commit 的 `conversation-definitions.client.spec.ts`）：
   * `live-chunk{text:'second attempt'}` + `step/end` → `eventNodes: [{ seq: 6.1,
   * interrupted: true, blocks: [{ kind: 'text', text: 'second attempt' }] }]`，`6.1 = 7 - 0.9`。
   *
   * 另一侧是重复 `step/start`：装配器 `const starting = role === 'start' &&
   * context.start === undefined`，同身份的第二个 `step/start` 走 `update`，而 assistant
   * definition 的 `update` 对它落到 `return context.state`——`final` / `sawChunk` / `stepEnd`
   * 一个字都不改（`step/start` 只有**第一个**才是状态机的 `start`）。
   *
   * 本扩展不出流式正文行（刻意差异 1），块证据只留「有没有」的判据（`BlockEvidence`），
   * 不复制流内容；布局节点表在整窗折完之后按当前贡献**导出一次**，不增量维护。
   */
  check("M1 闭合 + 文本证据构成合成节点：初始提示词行归它那一轮", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 9 }),
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      chunk(9, 4),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(
      initialCell(model)?.turn,
      9,
      "`eventNodes` 里的合成节点（`seq = boundary.seq - 0.9`、`turn 9`）是 `firstVisibleTurn()` 的候选",
    );
    assert.strictEqual(model.requests.length, 1, "这一步在窗口里开过请求");
    assert.strictEqual(
      flat(model).filter((cell) => cell.kind === "message").length,
      1,
      "本扩展仍不出流式正文行，只留一行「正在生成」占位（刻意差异 1）",
    );
  });

  check("M2 更新行在证据之后、边界之前时看到合成节点（不是到达轮，也不是 `Math.min`）", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(
      updateCell(model)?.turn,
      9,
      "`enclosingPromptTurn()` 取第一个 `seq > change.seq` 的助手节点，合成节点的 `seq` 是 `stepEnd.seq - 0.9`",
    );
    assert.strictEqual(initialCell(model)?.turn, 9, "同一份 nodes 也是初始行的候选");
  });

  check("M3 没有 `step/start` 的孤儿身份：`fallbackState()` 一样给合成节点，且不建请求", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(
      initialCell(model)?.turn,
      9,
      "`closedBoundary()` 的第 2 条来源读位置索引，与状态机是否建起来无关",
    );
    assert.strictEqual(updateCell(model)?.turn, 9);
    assert.strictEqual(model.requests.length, 0, "官方 `assistantRequest()` 的 `!state.started`");
  });

  check("M4 思考增量（`reasoning-delta`）同样是中断证据", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4, { type: "reasoning-delta", index: 0, text: "想" }),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 9, "`hasInterruptionEvidence()` 对 text / reasoning 同判");
    assert.strictEqual(initialCell(model)?.turn, 9);
  });

  check("M5 工具调用块（空 name / 空 args）是证据，但不算首 token", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4, { type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: "" }),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(
      updateCell(model)?.turn,
      9,
      "其余种类一律算证据（`hasInterruptionEvidence()` 只对 text / reasoning 看文本）",
    );
    assert.strictEqual(initialCell(model)?.turn, 9);
    assert.strictEqual(
      model.requests[0]?.assistantFirstTokenTime,
      null,
      "工具调用增量不是 token 增量（官方 `isTokenDelta` 要 `argumentsDelta` 非空或带 `name`）→ 请求在边界停下，首 token 定稿为显式 null",
    );
  });

  check("M6 `block-end` 整份替换成最终块：文本看内容、工具调用一律是证据", () => {
    const cases: [string, Record<string, unknown>, number][] = [
      ["有内容的文本块", { type: "block-end", index: 0, block: { type: "text", text: "答" } }, 9],
      ["纯空白的文本块", { type: "block-end", index: 0, block: { type: "text", text: " \n\t" } }, 1],
      ["空 name / 空 args 的工具调用块", { type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "", arguments: "" } }, 9],
    ];
    for (const [label, value, expected] of cases) {
      seq = 0;
      const model = deriveTrajectoryModel([
        event("step/start", { turn: 9, step: 4 }),
        initialHeader(),
        changeHeader(),
        chunk(9, 4, value),
        stepEnd(9, 4),
      ], true);
      assert.strictEqual(updateCell(model)?.turn, expected, `block-end ${label}`);
      assert.strictEqual(initialCell(model)?.turn, expected, `block-end ${label}（初始行同判）`);
    }
  });

  check("M7 槽位按 `chunk.index` 覆盖：同 index 覆盖会撤销已可见证据，别的 index 不影响", () => {
    const cases: [string, Record<string, unknown>, number][] = [
      ["同 index 的空文本块（撤销已可见证据）", { type: "block-start", index: 0, blockType: "text" }, 1],
      ["同 index 的工具调用块（仍是证据）", { type: "block-start", index: 0, blockType: "tool-call" }, 9],
      ["另一个 index 的空文本块（不碰 index 0）", { type: "block-start", index: 1, blockType: "text" }, 9],
    ];
    for (const [label, value, expected] of cases) {
      seq = 0;
      const model = deriveTrajectoryModel([
        event("step/start", { turn: 9, step: 4 }),
        initialHeader(),
        changeHeader(),
        chunk(9, 4),
        chunk(9, 4, value),
        stepEnd(9, 4),
      ], true);
      assert.strictEqual(updateCell(model)?.turn, expected, label);
      assert.strictEqual(initialCell(model)?.turn, expected, `${label}（初始行同判）`);
    }
  });

  check("M8 空白文本与 usage / finish / 未知 type 都不是中断证据", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["纯空白文本", { type: "text-delta", index: 0, text: " \n\t" }],
      ["空文本块", { type: "block-start", index: 0, blockType: "text" }],
      ["usage", { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }],
      ["finish", { type: "finish" }],
      ["未知 type", { type: "mystery" }],
    ];
    for (const [label, value] of cases) {
      seq = 0;
      const model = deriveTrajectoryModel([
        event("step/start", { turn: 9, step: 4 }),
        initialHeader(),
        changeHeader(),
        chunk(9, 4, value),
        stepEnd(9, 4),
      ], true);
      assert.strictEqual(
        updateCell(model)?.turn,
        1,
        `${label}：边界成立、没有证据 → 既不是节点也不是 partial，回落 1`,
      );
      assert.strictEqual(initialCell(model)?.turn, 1, `${label}（初始行同判）`);
    }
  });

  check("M9 `llm/retry` 的整份重置连块证据一起清；新 chunk 重新武装；孤儿身份不吃这一帧", () => {
    seq = 0;
    const cleared = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      retry(9, 4),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(
      updateCell(cleared)?.turn,
      1,
      "官方 `initialState()` 的 `blocks: []` → 重试前那点正文不再是证据",
    );
    assert.strictEqual(initialCell(cleared)?.turn, 1);
    seq = 0;
    const rearmed = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      retry(9, 4),
      chunk(9, 4),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(updateCell(rearmed)?.turn, 9, "重置之后新到的 chunk 又是证据");
    assert.strictEqual(initialCell(rearmed)?.turn, 9);
    seq = 0;
    const orphan = deriveTrajectoryModel([
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      retry(9, 4),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(
      updateCell(orphan)?.turn,
      9,
      "没有 `step/start` 时 `fallbackState()` 里没有 retry 分支（与 L1/L2 同源），证据不被清",
    );
    assert.strictEqual(initialCell(orphan)?.turn, 9);
  });

  check("M10 `final` 优先于合成分支：节点 `seq` 取结算帧那个，不是边界减 0.9", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      chunk(9, 4),
      settled(9, 4),
      changeHeader(),
      stepEnd(9, 4),
    ], true);
    assert.strictEqual(
      updateCell(model)?.turn,
      1,
      "`finalNode()` 先走 `final` 那一支（节点 `seq` 是结算帧的、早于这次更新）→ 回落 1；误用合成分支会得到 9",
    );
    assert.strictEqual(initialCell(model)?.turn, 9, "节点本身在（`turn 9`），只是 `seq` 更早");
  });

  check("M11 闭合来源优先级：步骤自己的 `step/end` 优先于所在轮次的 `turn/end`", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      chunk(9, 4),
      stepEnd(9, 4),
      changeHeader(),
      completed(9),
    ], true);
    assert.strictEqual(
      updateCell(model)?.turn,
      1,
      "`closedBoundary()` 先取 `stepEnd`（`seq = stepEnd.seq - 0.9`，早于这次更新）；若误取 `turn/end` 会得到 9",
    );
    assert.strictEqual(initialCell(model)?.turn, 9, "节点仍在（`turn 9`）");
  });

  check("M12 重复 `step/start` 一个字都不改：保 final / 保 partial / 保已闭合的中断贡献", () => {
    seq = 0;
    const keptFinal = deriveTrajectoryModel([
      event("turn/start", { turn: 6 }),
      event("step/start", { turn: 6, step: 2 }),
      initialHeader(),
      changeHeader(),
      settled(6, 2),
      event("step/start", { turn: 6, step: 2 }),
    ], true);
    assert.strictEqual(initialCell(keptFinal)?.turn, 6, "第二个 `step/start` 走 `update` → `return context.state`，`final` 不被清");
    assert.strictEqual(updateCell(keptFinal)?.turn, 6);
    assert.strictEqual(
      flat(keptFinal).filter((cell) => cell.kind === "message").length,
      1,
      "历史账本行照旧（这一步已结算过，不再补占位）",
    );
    seq = 0;
    const keptPartial = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      event("step/start", { turn: 9, step: 4 }),
    ], true);
    assert.strictEqual(updateCell(keptPartial)?.turn, 9, "`sawChunk` 不被清 → `partial` 照旧");
    assert.strictEqual(initialCell(keptPartial)?.turn, 9);
    seq = 0;
    const keptInterrupted = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      stepEnd(9, 4),
      event("step/start", { turn: 9, step: 4 }),
    ], true);
    assert.strictEqual(updateCell(keptInterrupted)?.turn, 9, "`stepEnd` 与块证据都不被清 → 合成节点照旧");
    assert.strictEqual(initialCell(keptInterrupted)?.turn, 9);
  });

  check("M13 重复 `step/start` 的请求表差异（诚实登记：另开一行，不等价于官方一份请求）", () => {
    /**
     * 官方的请求视图是**一个 identity 一份**（`assistantRequest()` 由那份 state 投影），
     * 重复 `step/start` 是 update、不改请求的 `startedAt` / 状态。本扩展按**每次
     * `step/start` 各开一行请求**（既定口径，本批不动）：同一个 `turn:step` 会出现两行，
     * 第二行才是 `assistantRequests` 里的当前那一个（后续帧挂它）。这里把它钉住，
     * **不宣称与官方请求表等价**。
     */
    seq = 0;
    const afterSettlement = deriveTrajectoryModel([
      event("turn/start", { turn: 6 }),
      event("step/start", { turn: 6, step: 2 }),
      initialHeader(),
      changeHeader(),
      settled(6, 2),
      event("step/start", { turn: 6, step: 2 }),
    ], true);
    assert.deepStrictEqual(
      afterSettlement.requests.map((request) => [request.number, request.turn, request.step, request.status]),
      [[1, 6, 2, "complete"], [2, 6, 2, "running"]],
      "重复 start 各开一行：第一行保留自己的结算事实，第二行从头 `running`",
    );
    assert.strictEqual(
      afterSettlement.requests[0]?.assistantFirstTokenTime,
      null,
      "结算过的请求：首 token 定稿为显式 null（结算帧没带 token）",
    );
    assert.strictEqual(
      afterSettlement.requests[1]?.assistantFirstTokenTime,
      undefined,
      "还在跑的重复请求：键缺席（宿主还没把它的计时定稿）",
    );
    seq = 0;
    const running = deriveTrajectoryModel([
      event("step/start", { turn: 9, step: 4 }),
      initialHeader(),
      changeHeader(),
      chunk(9, 4),
      event("step/start", { turn: 9, step: 4 }),
    ], true);
    assert.strictEqual(
      flat(running).find((cell) => cell.kind === "message")?.requestNumber,
      2,
      "占位行挂**最后一次** `step/start` 的请求号（按 start 开帧编号的既定口径）",
    );
  });

  check("M14 非法 chunk 形状不产生证据（肯定类型守卫；契约里这些字段必带）", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["text-delta 缺 text", { type: "text-delta", index: 0 }],
      ["text-delta 下标非法", { type: "text-delta", index: -1, text: "x" }],
      ["block-start 缺 blockType", { type: "block-start", index: 0 }],
      ["block-end 的 block 不是对象", { type: "block-end", index: 0, block: "nope" }],
      ["block-end 缺 type", { type: "block-end", index: 0, block: { text: "答" } }],
      ["block-end 的 text 不是字符串", { type: "block-end", index: 0, block: { type: "text" } }],
    ];
    for (const [label, value] of cases) {
      seq = 0;
      const model = deriveTrajectoryModel([
        event("step/start", { turn: 9, step: 4 }),
        initialHeader(),
        changeHeader(),
        chunk(9, 4, value),
        stepEnd(9, 4),
      ], true);
      assert.strictEqual(updateCell(model)?.turn, 1, label);
      assert.strictEqual(initialCell(model)?.turn, 1, `${label}（初始行同判）`);
    }
  });

  // ---- 18c. 前插初始行与压缩段的编号（`turn 0` prologue + 显示序号） ----
  check("H turn 0 压缩并入第 1 轮、前插不改请求身份，显示序号按摊平顺序统一重编", () => {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("compaction/start", { compactionId: "comp-zero", turn: 0 }),
      event("compaction/summary", { compactionId: "comp-zero", summary: [{ type: "text", text: "摘要" }] }),
      event("compaction/end", { compactionId: "comp-zero" }),
      event("turn/start", { turn: 2 }),
      event("step/start", { turn: 2, step: 1 }),
      initialHeader(),
      settled(2, 1),
    ];
    const model = deriveTrajectoryModel(events, true);
    const all = flat(model);
    const compacted = all.find((cell) => cell.kind === "compacted");
    assert.strictEqual(compacted?.turn, 1, "官方 prologue：turn 0 整段并入第 1 轮");
    assert.strictEqual(compacted?.seq, events[0].seq, "源事件 `seq` 不变（显示序号与源落点是两件事）");
    assert.strictEqual(compacted?.requestNumber, 1, "压缩请求号仍是 1");
    assert.deepStrictEqual(
      model.requests.map((request) => [request.number, request.purpose]),
      [[1, "compaction"], [2, "assistant"]],
      "请求表按开帧顺序：压缩 #1、助手 #2",
    );
    assert.strictEqual(
      all.find((cell) => cell.kind === "message")?.requestNumber,
      2,
      "助手行挂助手请求号（不被前插 / 压缩串号）",
    );
    assert.strictEqual(initialCell(model)?.turn, 2, "initial 行走 `firstVisibleTurn()`（助手轮次最小是 2）");
    assert.strictEqual(all[0]?.kind, "system", "初始提示词仍是第一行");
    assert.deepStrictEqual(
      all.map((cell) => cell.kind),
      ["system", "message", "compacted"],
      "显示顺序与官方一致（官方按 `firstCellIndex` 排轮次：第 2 轮的记录在被并入第 1 轮的压缩段之前）",
    );
    assert.ok(
      all.every((cell, index) => cell.index === index + 1),
      "显示序号按摊平顺序**统一重编**（源落点与请求身份另记，不跟着改）",
    );
    assert.strictEqual(new Set(all.map((cell) => cell.index)).size, all.length, "行号唯一");
  });

  check("I 轮内压缩与 header 更新不串助手 / 压缩请求号", () => {
    seq = 0;
    const model = deriveTrajectoryModel([
      event("turn/start", { turn: 5 }),
      event("step/start", { turn: 5, step: 1 }),
      initialHeader(),
      event("compaction/start", { turn: 5, compactionId: "inside" }),
      event("compaction/summary", { compactionId: "inside", summary: [{ type: "text", text: "摘要" }] }),
      event("compaction/end", { compactionId: "inside" }),
      changeHeader(),
      settled(5, 1),
    ], true);
    assert.strictEqual(updateCell(model)?.turn, 5, "更新归第 5 轮（随后助手就在这一轮）");
    assert.deepStrictEqual(
      model.requests.map((request) => [request.number, request.purpose]),
      [[1, "assistant"], [2, "compaction"]],
    );
    assert.strictEqual(flat(model).find((cell) => cell.kind === "compacted")?.requestNumber, 2, "压缩行挂压缩号");
    assert.strictEqual(flat(model).find((cell) => cell.kind === "message")?.requestNumber, 1, "助手行挂助手号");
  });

  runChecks("F05 系统更新归轮与布局 partial");
}
console.log("trajectory: 系统更新归轮 / 布局 partial 身份 / 前插编号（F05） ✓");

console.log("\ntrajectory: all assertions passed");
