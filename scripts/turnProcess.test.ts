/**
 * 轮级过程折叠（官方默认的 compact 转写模式）。
 *
 * 这里钉的是**边界与计数口径**，也就是最容易折错、折错了用户还看不太出来的地方：
 * 折多了会把答案藏起来，折少了等于没做。口径来源是官方 `dsh-client-ui-chat` 的
 * `processSpec` / `TURN_PROCESS_INDEPENDENT_KINDS` / `isSubagentDelegationTool`，
 * 逐条对照见 `src/webview/turnProcess.ts` 的文件头。
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

// ---------- 1. 基本折叠：答案步之前的都进去，答案留着 ----------
{
  const segments: Segment[] = [
    think("r0", "先看看文件", 0),
    tool("t0", "read", 0),
    text("m0", "读完了，我再改一下", 1),
    tool("t1", "edit", 1),
    text("a2", "改好了。", 2),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.ok(fold.foldable, "有过程 + 有答案步 → 应当折叠");
  assert.deepStrictEqual(
    fold.folded.map((s) => s.id),
    ["r0", "t0", "m0", "t1"],
    "答案步（step 2）之前的每一段都是过程",
  );
  assert.deepStrictEqual(
    fold.visible.map((s) => s.id),
    ["a2"],
    "答案步的正文必须留着（折进去就等于把回答藏了）",
  );
  assert.deepStrictEqual(
    fold.counts,
    { toolCalls: 2, messages: 1, subagents: 0 },
    "计数：2 次工具调用、1 条中间消息",
  );
}

// ---------- 2. 答案步**自己的**思考也算过程（官方 reasoningHidden） ----------
{
  const segments: Segment[] = [
    tool("t0", "read", 0),
    think("ra", "再想想怎么写", 1),
    text("a1", "答案在这里。", 1),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    fold.folded.map((s) => s.id),
    ["t0", "ra"],
    "答案步自己的 thinking 折起来，正文留下（与官方 reasoningHidden 一致）",
  );
  assert.deepStrictEqual(fold.visible.map((s) => s.id), ["a1"]);
}

// ---------- 3. 豁免段：轮级提示 + **系统提示词**；其余上下文注入照常折叠 ----------
//
// 官方 `TURN_PROCESS_INDEPENDENT_KINDS` = system-prompt / user / steering /
// turn-process / turn-error / turn-max-tokens / turn-tail —— **没有 context 一类**。
// 所以：轮级提示（截断/中止）与系统提示词永不折；插件注入 / 项目指令 / 技能目录 /
// 运行时上下文都算过程成员（用户 2026-09-14 对照 Web 报的「上下文注入也要折进去」）。
{
  const segments: Segment[] = [
    injected("sys1", 0, "system"),
    injected("x1", 0, "plugin"),
    tool("t0", "read", 0),
    notice("n1", 1),
    text("a2", "答案", 2),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.ok(
    fold.visible.some((s) => s.id === "n1"),
    "轮级提示（截断/中止）必须保持可见，不能折进去",
  );
  assert.ok(fold.visible.some((s) => s.id === "sys1"), "系统提示词对应官方的 system-prompt，豁免");
  assert.ok(
    !fold.visible.some((s) => s.id === "x1"),
    "上下文注入要折进过程（官方集合里没有 context 一类）",
  );
  assert.deepStrictEqual(
    fold.folded.map((s) => s.id),
    ["x1", "t0"],
    "折叠成员 = 上下文注入 + 工具行（顺序不变）",
  );
}

// ---------- 4. 流式期间不折叠（官方要求 turnClosed） ----------
{
  const segments: Segment[] = [tool("t0", "read", 0), text("a1", "正在写…", 1)];
  const fold = foldTurnProcess(segments, false);
  assert.strictEqual(fold.foldable, false, "轮次没结束就不能折（成员还在长）");
  assert.strictEqual(fold.folded.length, 0);
}

// ---------- 5. 没有过程 / 没有答案 / 缺 step 时都不折（宁可平铺也不折错） ----------
{
  const onlyAnswer = foldTurnProcess([text("a0", "直接回答", 0)], true);
  assert.strictEqual(onlyAnswer.foldable, false, "答案步就是第一段 → 没有过程可折");

  const noAnswer = foldTurnProcess([tool("t0", "read", 0), think("r0", "想", 1)], true);
  assert.strictEqual(noAnswer.foldable, false, "没有正文就没有答案步，不折");

  // 历史里缺 step/start 时 step 全是 undefined —— 这时**不折**，而不是把整轮折光
  const noStep: Segment[] = [
    { kind: "thinking", id: "r0", text: "想" },
    { kind: "tool", id: "t0", tool: { id: "t0", name: "read", status: "ok" } } as Segment,
    { kind: "text", id: "a0", text: "答案" },
  ];
  const fold = foldTurnProcess(noStep, true);
  assert.strictEqual(fold.foldable, false, "没有 step 信息时不折叠（否则会把答案也折进去）");
  assert.strictEqual(fold.visible.length, 3, "原样平铺");
}

// ---------- 6. 子代理派发单独计数（官方 isSubagentDelegationTool） ----------
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
    { toolCalls: 1, messages: 0, subagents: 2 },
    "subagent / subagent_* 算 subagent，不计入工具调用",
  );
}

// ---------- 7. 空文本段不算「消息」，也不算答案 ----------
{
  const segments: Segment[] = [
    text("empty", "   ", 0),
    tool("t0", "read", 0),
    text("a1", "答案", 1),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.strictEqual(fold.counts.messages, 0, "只有空白的文本段不算一条消息");
  assert.ok(
    fold.folded.some((s) => s.id === "empty"),
    "空文本段也要折起来（它本来就不显示内容）",
  );
}

console.log("turnProcess: 轮级过程折叠（边界 / 计数 / 豁免 / 不折的情形） ✓");
console.log("\nturnProcess: all assertions passed");
