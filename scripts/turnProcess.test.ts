/**
 * 轮级过程折叠（官方默认的 compact 转写模式）。
 *
 * 本扩展的口径：**只折机器噪声**——思考 / 工具 / 非 system 的上下文注入；
 * **正文与提示永不折**。所以这里钉的是：
 *
 * 1. 正文（含过程中途的长说明、空文本段）、提示（中止/截断/失败）与交互卡一律
 *    **不进**折叠集合，位置不变；
 * 2. 思考 / 工具 / 上下文注入一律**进**折叠集合，**不管它在轮的哪个位置**——
 *    尾步被中断的那一截过程同样要折进去（2026-09-16 用户报的「大量工具没有折叠
 *    进去」就是旧口径「只折边界之前」漏掉的）；
 * 3. 折叠**不依赖 `step`**：历史里缺 `step/start` 时照样折得对（旧口径只能整轮平铺）；
 * 4. 流式期间不折、计数只数工具与 subagent。
 *
 * 与官方的差异（官方连中间正文一起折、按钮报「M 条消息」）见
 * `src/webview/turnProcess.ts` 的文件头，那里逐条列了理由。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import type { Segment } from "../src/shared/chat";
import { foldTurnProcess } from "../src/webview/turnProcess";

const text = (id: string, body: string, step: number): Segment => ({ kind: "text", id, text: body, step });
const think = (id: string, body: string, step: number): Segment => ({ kind: "thinking", id, text: body, step });
const tool = (id: string, name: string, step: number): Segment =>
  ({ kind: "tool", id, tool: { id, name, status: "ok" }, step }) as Segment;
const notice = (id: string, step: number): Segment =>
  ({ kind: "notice", id, level: "warn", text: "@maxTokens", step }) as Segment;
const injected = (id: string, step: number, sourceKind = "plugin"): Segment =>
  ({ kind: "injected", id, injected: { sourceKind, text: "x" }, step }) as Segment;

// ---------- 1. 正文永不折：过程里的中间话留在流里，工具与思考折进去 ----------
{
  const segments: Segment[] = [
    think("r0", "先看看文件", 0),
    tool("t0", "read", 0),
    text("m0", "读完了，我再改一下", 1),
    tool("t1", "edit", 1),
    text("a2", "改好了。", 2),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.ok(fold.foldable, "有工具/思考 → 应当折叠");
  assert.deepStrictEqual(
    fold.folded.map((s) => s.id),
    ["r0", "t0", "t1"],
    "折叠成员 = 思考 + 工具；中间正文 m0 不进集合",
  );
  assert.deepStrictEqual(
    fold.visible.map((s) => s.id),
    ["m0", "a2"],
    "中间正文与答案都留在流里（按原序）",
  );
  assert.deepStrictEqual(
    fold.counts,
    { toolCalls: 2, subagents: 0 },
    "计数只数工具调用与 subagent（正文不进按钮，所以没有「M 条消息」）",
  );
}

// ---------- 2. 尾步被中断的那一截过程也要折（2026-09-16 报的缺口） ----------
{
  // 一轮：过程 → 中途正文 → **再也没有正文**的 119 步工具循环 → 失败提示。
  // 旧口径把边界钉在「最后一个有正文的 step」，边界之后的工具行全平铺。
  const segments: Segment[] = [
    tool("t0", "read", 0),
    text("mid", "Now let me implement item 9 (tps = average output speed):", 1),
    think("r1", "继续查", 2),
    tool("t1", "read", 2),
    think("r2", "再查", 3),
    tool("t2", "grep", 3),
    tool("t3", "pwsh", 4),
    notice("n1", 5),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    fold.folded.map((s) => s.id),
    ["t0", "r1", "t1", "r2", "t2", "t3"],
    "中途正文之后的过程同样折进去（没有「边界之后没人回收」这回事）",
  );
  assert.deepStrictEqual(
    fold.visible.map((s) => s.id),
    ["mid", "n1"],
    "中途正文与失败提示留在外面（提示折起来就是信息损失）",
  );
  assert.deepStrictEqual(fold.counts, { toolCalls: 4, subagents: 0 });
}

// ---------- 3. 长正文不折（用户口径：中间的长消息不能被忽略） ----------
{
  const long = `## 阶段小结\n\n${"这一段很长，是模型写给用户看的说明。".repeat(40)}`;
  const segments: Segment[] = [tool("t0", "read", 0), text("long", long, 0), tool("t1", "edit", 1)];
  const fold = foldTurnProcess(segments, true);
  assert.ok(
    fold.visible.some((s) => s.id === "long"),
    "长正文必须留在流里（它是内容，不是过程噪声）",
  );
  assert.ok(!fold.folded.some((s) => s.id === "long"), "长正文不进折叠集合——不设长度阈值");
}

// ---------- 4. 折叠不看 step：历史里缺 step/start 时照样折得对 ----------
{
  const noStep: Segment[] = [
    { kind: "thinking", id: "r0", text: "想" },
    { kind: "tool", id: "t0", tool: { id: "t0", name: "read", status: "ok" } } as Segment,
    { kind: "text", id: "a0", text: "答案" },
  ];
  const fold = foldTurnProcess(noStep, true);
  assert.ok(fold.foldable, "缺 step 的历史同样折叠（正文永不折，所以不可能折错答案）");
  assert.deepStrictEqual(fold.folded.map((s) => s.id), ["r0", "t0"], "思考与工具照折");
  assert.deepStrictEqual(fold.visible.map((s) => s.id), ["a0"], "正文留下");
}

// ---------- 5. 流式期间不折叠（官方要求 turnClosed） ----------
{
  const segments: Segment[] = [tool("t0", "read", 0), text("a1", "正在写…", 1)];
  const fold = foldTurnProcess(segments, false);
  assert.strictEqual(fold.foldable, false, "轮次没结束就不能折（成员还在长）");
  assert.strictEqual(fold.folded.length, 0);
}

// ---------- 6. 没有噪声可折时不折（只有正文 / 只有提示） ----------
{
  const onlyAnswer = foldTurnProcess([text("a0", "直接回答", 0)], true);
  assert.strictEqual(onlyAnswer.foldable, false, "只有正文 → 没东西可折，不画按钮");

  const onlyNotice = foldTurnProcess([notice("n0", 0), text("a0", "回答", 1)], true);
  assert.strictEqual(onlyNotice.foldable, false, "只有提示与正文 → 不画按钮");
}

// ---------- 7. 一轮只有噪声（没有正文）也折得起来，按钮读计数 ----------
{
  const fold = foldTurnProcess([think("r0", "想", 0), tool("t0", "read", 0), tool("t1", "read", 1)], true);
  assert.strictEqual(fold.foldable, true, "整轮都是过程 → 折成一枚按钮");
  assert.deepStrictEqual(fold.visible, [], "没有正文就没有留在外面的段");
  assert.deepStrictEqual(fold.counts, { toolCalls: 2, subagents: 0 });

  const onlyThinking = foldTurnProcess([think("r0", "想", 0)], true);
  assert.deepStrictEqual(onlyThinking.counts, { toolCalls: 0, subagents: 0 }, "两者皆 0 → 文案读「已思考」");
}

// ---------- 8. 豁免与交互卡：系统提示词、提示、问卷/审批卡一律不折；上下文注入照折 ----------
//
// 官方 `TURN_PROCESS_INDEPENDENT_KINDS` = system-prompt / user / steering /
// turn-process / turn-error / turn-max-tokens / turn-tail —— **没有 context 一类**。
// 所以：系统提示词与轮级提示永不折；插件注入 / 项目指令 / 技能目录 / 运行时上下文
// 折进过程（用户 2026-09-14 对照 Web 报的「上下文注入也要折进去」）。
{
  const segments: Segment[] = [
    injected("sys1", 0, "system"),
    injected("x1", 0, "plugin"),
    tool("t0", "read", 0),
    notice("n1", 1),
    text("a2", "答案", 2),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.ok(fold.visible.some((s) => s.id === "n1"), "中止/截断提示必须保持可见");
  assert.ok(fold.visible.some((s) => s.id === "sys1"), "系统提示词对应官方的 system-prompt，豁免");
  assert.ok(!fold.visible.some((s) => s.id === "x1"), "上下文注入折进过程（官方集合里没有 context 一类）");
  assert.deepStrictEqual(fold.folded.map((s) => s.id), ["x1", "t0"], "折叠成员 = 上下文注入 + 工具行（顺序不变）");
}

// ---------- 9. 空白文本段算正文（可见、且不进计数） ----------
{
  const segments: Segment[] = [
    text("empty", "   ", 0),
    tool("t0", "read", 0),
    text("a1", "答案", 1),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.ok(fold.visible.some((s) => s.id === "empty"), "空白文本段按性质算正文，留在流里（它本来就不显示内容）");
  assert.deepStrictEqual(fold.counts, { toolCalls: 1, subagents: 0 });
}

// ---------- 10. 子代理派发单独计数（官方 isSubagentDelegationTool） ----------
{
  const segments: Segment[] = [
    tool("t0", "read", 0),
    tool("t1", "subagent", 0),
    tool("t2", "subagent_explore", 0),
    text("a1", "答案", 1),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    fold.counts,
    { toolCalls: 1, subagents: 2 },
    "subagent / subagent_* 算 subagent，不计入工具调用",
  );
}

console.log("turnProcess: 轮级过程折叠（只折噪声 / 正文豁免 / 豁免段 / 计数 / 不折的情形） ✓");
console.log("\nturnProcess: all assertions passed");
