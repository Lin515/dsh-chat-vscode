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
import type { SessionWireEvent } from "../src/dsh/protocol";
import { deriveTrajectoryModel, trajectorySummary } from "../src/dsh/trajectory";

let seq = 0;
const at = (offset: number) => 1_700_000_000_000 + offset * 1000;
const event = (type: string, data: Record<string, unknown>, offset = seq): SessionWireEvent => {
  seq += 1;
  return { type, seq: seq - 1, time: at(offset), data };
};
const block = (text: string) => [{ type: "text", text }];
const message = (text: string, source: Record<string, unknown>) => ({
  content: block(text),
  source,
});

// ---------- 1. 一个完整轮次：系统 → 用户 → 助手 → 工具 → 子工具 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: message("你是 DSH。", { kind: "system" }) }, 0),
    event("user/message", { message: message("帮我看看这个文件", { kind: "user" }) }, 1),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "read" }] }, reason: "initial" }, 1),
    event("assistant/message", { turn: 0, step: 0, message: message("我看看。", { model: "m" }), usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }, 2),
    event("tool/call", { turn: 0, step: 0, callId: "c1", name: "read", arguments: '{"file_path":"a.ts"}' }, 3),
    event("tool/result", { turn: 0, step: 0, message: { content: block("export {}"), source: { callId: "c1" } } }, 4),
    event("tool/ptc-dispatch-start", { rootCallId: "c1", parentCallId: "c1", subCallId: "c1:ptc:1", name: "grep", arguments: { pattern: "x" } }, 4),
    event("tool/ptc-dispatch", { rootCallId: "c1", parentCallId: "c1", subCallId: "c1:ptc:1", name: "grep", arguments: { pattern: "x" }, isError: false, content: block("a.ts:1") }, 5),
    event("turn/end", { turn: 0, reason: "success" }, 5),
  ];
  const model = deriveTrajectoryModel(events, false);
  const kinds = model.turns.flatMap((turn) => turn.cells.map((cell) => cell.kind));
  assert.deepStrictEqual(
    kinds,
    ["system", "user", "message", "tool", "subtool"],
    "七种记录里的五种按事件顺序出现（压缩那两种在下一组测）",
  );
  const cells = model.turns.flatMap((turn) => turn.cells);
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
  assert.strictEqual(cells[1].text, "帮我看看这个文件");
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
  assert.strictEqual(cells[3].result, "export {}");
  assert.strictEqual(cells[3].timeSeconds, 1, "调用到结果之间 1 秒");
  // 子工具行：独立一条，kind 是 subtool
  assert.strictEqual(cells[4].toolName, "grep");
  assert.strictEqual(cells[4].status, "complete");
  assert.strictEqual(cells[4].result, "a.ts:1");
  assert.strictEqual(model.cellCount, 5);
}
console.log("trajectory: 完整轮次的账本折叠 ✓");

// ---------- 2. 用户 vs 上下文：按 `source.kind` 分派 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("user/message", { message: message("插件注入的上下文", { kind: "plugin", plugin: "dsh-goal" }) }, 0),
    event("user/message", { message: message("人类说的话", { kind: "user" }) }, 1),
    event("user/message", { message: message("RPC 发的话", { kind: "user-rpc" }) }, 2),
    event("turn/end", { turn: 0, reason: "success" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap((turn) => turn.cells);
  assert.deepStrictEqual(
    cells.map((cell) => cell.kind),
    ["context", "user", "user"],
    "插件注入 → context；`user` / `user-rpc` → user（官方只把这两种算人的话）",
  );
  assert.strictEqual(cells[0].messageSource?.plugin, "dsh-goal");
  assert.strictEqual(cells[0].opensTurn, undefined, "上下文注入不开启轮次");
  assert.strictEqual(cells[1].opensTurn, true);
}
console.log("trajectory: context 与 user 的分派 ✓");

// ---------- 3. 压缩的生命周期（start → summary → end） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("compaction/start", { compactionId: "k1", turn: 0 }, 0),
    event("compaction/summary", { compactionId: "k1", summary: block("摘要正文"), rawOutput: block("模型原始输出"), provider: "p", model: "m", usage: { inputTokens: 7, outputTokens: 2 } }, 1),
    event("compaction/end", { compactionId: "k1", turn: 0 }, 2),
    event("turn/end", { turn: 0, reason: "success" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap((turn) => turn.cells);
  assert.strictEqual(cells.length, 1, "一条压缩 = 一条记录（不是三条）");
  assert.strictEqual(cells[0].kind, "compacted");
  assert.strictEqual(cells[0].status, "complete");
  assert.strictEqual(cells[0].outputDetail, "摘要正文");
  assert.strictEqual(cells[0].inputDetail, "模型原始输出", "rawOutput 进「原始输出」页签");
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
  const cells = deriveTrajectoryModel(events, false).turns.flatMap((turn) => turn.cells);
  assert.strictEqual(cells[0].status, "error");
  assert.strictEqual(cells[0].error, "boom");
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
    event("user/message", { message: message("你好", { kind: "user" }) }, 1),
    event("assistant/message", { turn: 0, step: 0, message: message("在", {}) }, 1),
    // 第二轮：系统提示词变了（历史内更新）→ 官方在账本里再出一行 SYSTEM
    event("turn/end", { turn: 0, reason: "success" }, 2),
    event("turn/start", { turn: 1 }, 2),
    event("step/start", { turn: 1, step: 0 }, 2),
    event("system/message", { turn: 1, step: 0, message: message("第二版提示词", { kind: "system" }) }, 2),
    event("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "change" }, 2),
    event("user/message", { message: message("再来", { kind: "user" }) }, 3),
    event("assistant/message", { turn: 1, step: 0, message: message("好", {}) }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap((turn) => turn.cells);
  const systems = cells.filter((cell) => cell.kind === "system");
  assert.strictEqual(systems.length, 2, "初始一行 + 更新一行");
  assert.strictEqual(systems[0].systemPromptDetail, "第一版提示词");
  assert.strictEqual(systems[0].previousSystemPromptDetail, undefined);
  assert.strictEqual(systems[1].systemPromptDetail, "第二版提示词");
  assert.strictEqual(systems[1].previousSystemPromptDetail, "第一版提示词", "差异页签要能对照上一版");
}
console.log("trajectory: 系统提示词的更新 ✓");

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
    event("user/message", { message: message("第一句人话", { kind: "user" }) }, 1),
    event("assistant/message", { turn: 1, step: 0, message: message("答", {}) }, 2),
    event("turn/end", { turn: 1, reason: "success" }, 2),
  ];
  const model = deriveTrajectoryModel(events, false);
  assert.strictEqual(model.turns.length, 1, "turn 0 没有用户消息 → 并进下一组，不出现两个「第 1 轮」");
  assert.strictEqual(model.turns[0].turn, 1);
  assert.deepStrictEqual(
    model.turns[0].cells.map((cell) => cell.kind),
    ["system", "user", "message"],
  );
}
console.log("trajectory: 轮次分组与 prologue 合并 ✓");

// ---------- 6. 轮次错误与重试都挂到该轮的助手行上 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", { message: message("问", { kind: "user" }) }, 0),
    event("llm/retry", { attempt: 2, maxAttempts: 5 }, 1),
    event("assistant/message", { turn: 0, step: 0, message: message("答", {}) }, 2),
    event("turn/end", { turn: 0, reason: "error" }, 3),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap((turn) => turn.cells);
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
    event("user/message", { message: message("问", { kind: "user" }) }, 0),
    event("assistant/message", { turn: 0, step: 0, message: message("半截", {}) }, 1),
    event("turn/end", { turn: 0, reason: "max-tokens" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap((turn) => turn.cells);
  const assistant = cells.find((cell) => cell.kind === "message");
  assert.strictEqual(assistant?.error, undefined, "截断不画成失败");
  assert.strictEqual(assistant?.status, "complete");
}
console.log("trajectory: 重试与轮次错误 ✓");

// ---------- 7. 中断的助手消息 + 未结算的工具（运行中） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", { message: message("问", { kind: "user" }) }, 0),
    event("assistant/message", { turn: 0, step: 0, message: message("半截", {}), interrupted: true }, 1),
    event("tool/call", { turn: 0, step: 0, callId: "c9", name: "bash", arguments: "{}" }, 2),
  ];
  const cells = deriveTrajectoryModel(events, true).turns.flatMap((turn) => turn.cells);
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

console.log("\ntrajectory: all assertions passed");
