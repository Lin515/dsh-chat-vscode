/**
 * 连续过程折叠（本扩展口径，2026-09-16 收敛后的最终版）。
 *
 * **只留本轮最后一段正文**，其余一切（中途正文、思考、工具、上下文注入、提示、
 * 交互卡、命令、图片、未知块）都是折叠成员；边界把这把刀切成前后两段，每段按
 * **段内工具调用次数**判阈值。所以这里钉的是：
 *
 * 1. 阈值是配置项 `dshChat.turnProcessThreshold`（默认 5）：达到才折；
 *    **只有 1 次工具调用的段永不折**（`1–2` 的「永远折」落地为生效 2），
 *    `0` = 永不折——语义只写在 `src/shared/turnProcessThreshold.ts` 一份里；
 * 2. 唯一留在流里的是**最后一段 `text`**——中途正文照样折进去（不会再出现「两段
 *    不相邻的话被并成一段」的错觉）；被中断的轮没有最终回答时，最后那段话就是它；
 * 3. 判定不看 `step`（历史里缺 `step/start` 时照样折得对）、流式期间不折；
 * 4. 计数：subagent 派发单独计数，但**一样算进阈值**。
 *
 * 与官方的差异（官方按「最后一个定稿答案步」整轮折一枚按钮、按钮报「M 条消息」）见
 * `src/webview/turnProcess.ts` 的文件头。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Segment } from "../src/shared/chat";
import {
  DEFAULT_TURN_PROCESS_THRESHOLD,
  effectiveFoldThreshold,
  normalizeTurnProcessThreshold,
} from "../src/shared/turnProcessThreshold";
import {
  foldTurnProcess,
  type TurnProcessFold,
} from "../src/webview/turnProcess";
import { dictionaryFor } from "../src/webview/texts";

const text = (id: string, body: string, step: number): Segment => ({ kind: "text", id, text: body, step });
const think = (id: string, body: string, step: number): Segment => ({ kind: "thinking", id, text: body, step });
const tool = (id: string, name: string, step: number): Segment =>
  ({ kind: "tool", id, tool: { id, name, status: "ok" }, step }) as Segment;
const notice = (id: string, step: number): Segment =>
  ({ kind: "notice", id, level: "warn", text: "@maxTokens", step }) as Segment;
const injected = (id: string, step: number, sourceKind = "plugin"): Segment =>
  ({ kind: "injected", id, injected: { sourceKind, text: "x" }, step }) as Segment;
const question = (id: string, step: number): Segment =>
  ({ kind: "question", id, question: { requestId: "ev1", items: [], state: "waiting" }, step }) as Segment;
const command = (id: string, step: number): Segment =>
  ({ kind: "command", id, command: { commandId: "c1", name: "plan", state: "ok", text: "Plan mode on." }, step }) as Segment;
const images = (id: string, step: number): Segment => ({ kind: "images", id, images: [], step });
const unknown = (id: string, step: number): Segment =>
  ({ kind: "unknown", id, type: "file", json: "{}", step }) as Segment;

/** 一串工具调用段（`t0`…），默认 step 取下标。 */
const tools = (count: number, prefix = "t"): Segment[] =>
  Array.from({ length: count }, (_, index) => tool(`${prefix}${index}`, "read", index));

/** 被折进按钮的段 id（按段顺序）。 */
const foldedIds = (fold: TurnProcessFold): string[] =>
  fold.runs.flatMap((run) => run.segments.map((segment) => segment.id));

/** 留在流里的段 id（按原顺序）。 */
const visibleIds = (segments: readonly Segment[], fold: TurnProcessFold): string[] =>
  segments.filter((segment) => !fold.bySegment.has(segment.id)).map((segment) => segment.id);

/** 每一段按钮的锚点与成员，便于整表对拍。 */
const runs = (fold: TurnProcessFold) =>
  fold.runs.map((run) => ({ anchor: run.anchorId, members: run.segments.map((s) => s.id), counts: run.counts }));

// ---------- 1. 默认阈值 5：正好 5 才折；4 不折；单次工具永不折 ----------
{
  const four = tools(4);
  assert.deepStrictEqual(
    foldTurnProcess(four, true).runs,
    [],
    `默认阈值 ${DEFAULT_TURN_PROCESS_THRESHOLD}：连着 4 次还不够，这一段原样平铺`,
  );
  const five = tools(5);
  assert.deepStrictEqual(
    runs(foldTurnProcess(five, true)),
    [{ anchor: "t0", members: ["t0", "t1", "t2", "t3", "t4"], counts: { toolCalls: 5, messages: 0, subagents: 0 } }],
    "连着 5 次 → 折成一枚按钮，锚在首段",
  );
  assert.deepStrictEqual(visibleIds(five, foldTurnProcess(five, true)), [], "没有正文 → 成员全部折进去");

  assert.deepStrictEqual(
    foldTurnProcess(tools(1), true).runs,
    [],
    "只有 1 次工具调用永不折——一枚按钮只包一行没有意义",
  );
}

// ---------- 2. 只留最后一段正文：中途的话照样折进去 ----------
//
// 这就是用户 2026-09-16 最终要的那条：一轮折完读作「按钮 → 回答」。中途正文进按钮，
// 所以不会再出现「两段不相邻的话被并成一段」的错觉（那是 0513070 报的现象）。
{
  const segments: Segment[] = [
    ...tools(5, "a"),
    text("mid1", "Now let me implement item 9:", 5),
    ...tools(5, "b"),
    text("mid2", "根因是端口被读了两遍。", 6),
    ...tools(5, "c"),
    text("answer", "改好了，端口只读一次。", 7),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    runs(fold),
    [
      {
        anchor: "a0",
        members: [
          "a0", "a1", "a2", "a3", "a4",
          "mid1",
          "b0", "b1", "b2", "b3", "b4",
          "mid2",
          "c0", "c1", "c2", "c3", "c4",
        ],
        counts: { toolCalls: 15, messages: 2, subagents: 0 },
      },
    ],
    "最后那段正文之前的一切（含两条中途正文）合成一枚按钮",
  );
  assert.deepStrictEqual(visibleIds(segments, fold), ["answer"], "留在流里的只有最终回答");
}

// ---------- 3. 边界是「最后一段正文」，它的前后各成一段 ----------
{
  const segments: Segment[] = [
    text("head", "先看一下。", 0),
    ...tools(5, "a"),
    text("mid", "总结一下：先改配置。", 5),
    ...tools(3, "b"),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    runs(fold),
    [{ anchor: "head", members: ["head", "a0", "a1", "a2", "a3", "a4"], counts: { toolCalls: 5, messages: 1, subagents: 0 } }],
    "最后那段正文之前的一段折起来（含它前面的中途正文）",
  );
  assert.deepStrictEqual(
    visibleIds(segments, fold),
    ["mid", "b0", "b1", "b2"],
    "最后那段正文留下；它后面只有 3 次工具调用，够不到阈值，照旧平铺",
  );
}

// ---------- 4. 回答之后的过程也算：尾段够长就跟一枚按钮 ----------
{
  const segments: Segment[] = [...tools(5, "a"), text("answer", "答案", 5), ...tools(5, "b")];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    fold.runs.map((run) => run.anchorId),
    ["a0", "b0"],
    "最后那段正文前后各一枚按钮（尾段是收尾工作，不该留在外面）",
  );
  assert.deepStrictEqual(visibleIds(segments, fold), ["answer"], "回答夹在两枚按钮之间");
}

// ---------- 5. 被中断的轮：没有最终回答时，最后那段话就是它 ----------
{
  const segments: Segment[] = [
    ...tools(5, "a"),
    text("last", "现在开始改 controller.ts。", 5),
    ...tools(10, "b"),
    notice("n1", 15),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    fold.runs.map((run) => run.anchorId),
    ["a0", "b0"],
    "中断轮：正文之前与之后的过程各折一枚（旧口径「尾段没人回收」的缺口不存在）",
  );
  assert.deepStrictEqual(
    visibleIds(segments, fold),
    ["last"],
    "模型最后说的话留在流里（提示折进按钮也不会丢正文）",
  );
}

// ---------- 6. 除正文外全是成员：系统提示词、提示、交互卡、命令、图片、未知块 ----------
{
  const segments: Segment[] = [
    injected("sys", 0, "system"),
    think("r0", "先看看文件", 0),
    question("q1", 0),
    command("cmd1", 0),
    ...tools(5, "t"),
    notice("n1", 6),
    images("img1", 6),
    unknown("u1", 6),
    text("answer", "答案", 7),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    foldedIds(fold),
    ["sys", "r0", "q1", "cmd1", "t0", "t1", "t2", "t3", "t4", "n1", "img1", "u1"],
    "除最后那段正文之外一切都进按钮（含系统提示词、交互卡、提示、命令、图片、未知块）",
  );
  assert.deepStrictEqual(
    fold.runs[0].counts,
    { toolCalls: 5, messages: 0, subagents: 0 },
    "计数三段：工具调用 / 中途消息 / subagent（这一段没有中途正文）",
  );
  assert.deepStrictEqual(visibleIds(segments, fold), ["answer"], "留在流里的只有回答");
}

// ---------- 7. 段不够长就整段平铺（阈值是按段算的，不是按整轮） ----------
{
  const segments: Segment[] = [...tools(3, "a"), text("mid", "到此为止。", 3)];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(fold.runs, [], "3 次工具调用够不到默认阈值 → 不折");
  assert.deepStrictEqual(
    visibleIds(segments, fold),
    segments.map((s) => s.id),
    "整轮原样平铺（正文位置本来就对）",
  );
}

// ---------- 8. 空白文本段：它就是「最后一段正文」时也留下 ----------
{
  const long = `## 阶段小结\n\n${"这一段很长，是模型写给用户看的说明。".repeat(40)}`;
  const emptyLast: Segment[] = [...tools(5, "t"), text("empty", "   ", 5)];
  const foldEmptyLast = foldTurnProcess(emptyLast, true);
  assert.deepStrictEqual(
    runs(foldEmptyLast),
    [{ anchor: "t0", members: ["t0", "t1", "t2", "t3", "t4"], counts: { toolCalls: 5, messages: 0, subagents: 0 } }],
    "空白文本段也是正文：它在最后就它留下（不按内容判定）",
  );
  assert.deepStrictEqual(visibleIds(emptyLast, foldEmptyLast), ["empty"]);

  const emptyMid: Segment[] = [text("empty", "   ", 0), ...tools(5, "t"), text("long", long, 5)];
  const foldEmptyMid = foldTurnProcess(emptyMid, true);
  assert.ok(foldEmptyMid.bySegment.has("empty"), "空白文本段不在最后 → 跟普通中途正文一样折进去");
  assert.deepStrictEqual(visibleIds(emptyMid, foldEmptyMid), ["long"], "长正文是最后一段，留下");
}

// ---------- 9. 折叠不看 step：历史里缺 step/start 时照样折得对 ----------
{
  const noStep: Segment[] = [
    { kind: "thinking", id: "r0", text: "想" },
    { kind: "tool", id: "t0", tool: { id: "t0", name: "read", status: "ok" } } as Segment,
    { kind: "tool", id: "t1", tool: { id: "t1", name: "grep", status: "ok" } } as Segment,
    { kind: "tool", id: "t2", tool: { id: "t2", name: "edit", status: "ok" } } as Segment,
    { kind: "tool", id: "t3", tool: { id: "t3", name: "pwsh", status: "ok" } } as Segment,
    { kind: "tool", id: "t4", tool: { id: "t4", name: "read", status: "ok" } } as Segment,
    { kind: "text", id: "a0", text: "答案" },
  ];
  const fold = foldTurnProcess(noStep, true);
  assert.deepStrictEqual(
    runs(fold),
    [{ anchor: "r0", members: ["r0", "t0", "t1", "t2", "t3", "t4"], counts: { toolCalls: 5, messages: 0, subagents: 0 } }],
    "缺 step 的历史同样折（阈值只看工具次数，不看 step）",
  );
  assert.deepStrictEqual(visibleIds(noStep, fold), ["a0"], "正文留下");
}

// ---------- 10. 流式期间不折（官方要求 turnClosed） ----------
{
  const segments = tools(12);
  const fold = foldTurnProcess(segments, false);
  assert.deepStrictEqual(fold.runs, [], "轮次没结束就不能折（成员还在长，折了会闪）");
  assert.deepStrictEqual(visibleIds(segments, fold), segments.map((s) => s.id), "全部平铺");
}

// ---------- 11. 子代理派发单独计数，但一样算进阈值 ----------
{
  const segments: Segment[] = [
    tool("t0", "read", 0),
    tool("t1", "read", 1),
    tool("t2", "read", 2),
    tool("s0", "subagent", 3),
    tool("s1", "subagent_explore", 4),
  ];
  const fold = foldTurnProcess(segments, true);
  assert.deepStrictEqual(
    runs(fold),
    [
      {
        anchor: "t0",
        members: ["t0", "t1", "t2", "s0", "s1"],
        counts: { toolCalls: 3, messages: 0, subagents: 2 },
      },
    ],
    "3 次工具 + 2 个 subagent = 连着 5 次 → 默认阈值下也折；按钮照官方口径分开报",
  );
}

// ---------- 12. 按钮文案：三段计数，照官方 `message.turnProcess.*`（用户 2026-09-16 报缺「条消息」） ----------
{
  const zh = dictionaryFor("zh");
  const en = dictionaryFor("en");
  assert.strictEqual(
    zh.turnProcessLabel({ toolCalls: 5, messages: 2, subagents: 1 }),
    "5 次工具调用 · 2 条消息 · 1 个 subagent",
    "中文三段（官方 zh 就是这三句 + 「 · 」）",
  );
  assert.strictEqual(
    en.turnProcessLabel({ toolCalls: 1, messages: 1, subagents: 1 }),
    "1 tool call · 1 message · 1 subagent",
    "英文单数（官方 .one / .other 两套）",
  );
  assert.strictEqual(
    en.turnProcessLabel({ toolCalls: 5, messages: 2, subagents: 0 }),
    "5 tool calls · 2 messages",
    "英文复数；没有 subagent 就不出那一段",
  );
  assert.strictEqual(
    zh.turnProcessLabel({ toolCalls: 0, messages: 0, subagents: 0 }),
    "已思考",
    "三段皆 0 读「已思考」（官方 thoughtForAWhile）",
  );
  assert.strictEqual(
    en.turnProcessLabel({ toolCalls: 0, messages: 0, subagents: 0 }),
    "Thought for a while",
  );
}

// ---------- 13. 阈值配置项（`dshChat.turnProcessThreshold`）的归一化与生效值 ----------
{
  assert.strictEqual(normalizeTurnProcessThreshold(undefined), 5, "缺省（首帧未到）用默认 5");
  assert.strictEqual(normalizeTurnProcessThreshold("7"), 5, "非数字回退默认");
  assert.strictEqual(normalizeTurnProcessThreshold(2.5), 5, "小数回退默认（手写 settings.json 能绕开设置页校验）");
  assert.strictEqual(normalizeTurnProcessThreshold(-1), 5, "负数不是任何合法语义，回退默认");
  assert.strictEqual(normalizeTurnProcessThreshold(0), 0, "0 是合法值：永不折叠");
  assert.strictEqual(normalizeTurnProcessThreshold(9), 9, "合法整数原样通过");

  assert.strictEqual(effectiveFoldThreshold(0), Number.POSITIVE_INFINITY, "0 = 永不折（∞ 谁也够不到）");
  assert.strictEqual(effectiveFoldThreshold(1), 2, "1 的「永远折」落地为 ≥2：仅 1 次工具调用的段平铺");
  assert.strictEqual(effectiveFoldThreshold(2), 2, "2 原样生效（也是 1 的落地值，两者同义）");
  assert.strictEqual(effectiveFoldThreshold(5), 5, "≥3 原样生效");
  assert.strictEqual(effectiveFoldThreshold(undefined), 5, "缺省走默认");
}
console.log("turnProcess: 阈值配置项的归一化与生效值（0 永不折 / 1–2 永远折落地 ≥2） ✓");

// ---------- 14. 配置阈值驱动 foldTurnProcess：0 永不折 / 1·2 等价（单次调用平铺） ----------
{
  assert.deepStrictEqual(foldTurnProcess(tools(15), true, 0).runs, [], "阈值 0：15 次调用也不折（永不折叠）");
  assert.deepStrictEqual(
    foldTurnProcess(tools(1), true, 1).runs,
    [],
    "阈值 1（永远折）：只有 1 次工具调用的段照旧平铺——一枚按钮只包一行没有意义",
  );
  assert.deepStrictEqual(
    runs(foldTurnProcess(tools(2), true, 1)),
    [{ anchor: "t0", members: ["t0", "t1"], counts: { toolCalls: 2, messages: 0, subagents: 0 } }],
    "阈值 1：2 次调用就折（「永远折」的实际下限）",
  );
  assert.deepStrictEqual(foldTurnProcess(tools(1), true, 2).runs, [], "阈值 2：1 次不折");
  assert.ok(foldTurnProcess(tools(2), true, 2).runs.length === 1, "阈值 2：2 次折");
  assert.deepStrictEqual(foldTurnProcess(tools(2), true, 3).runs, [], "阈值 3：2 次不够");
  assert.ok(foldTurnProcess(tools(3), true, 3).runs.length === 1, "阈值 3：3 次折");
  // 阈值只数工具调用：阈值 1 的「永远折」也不折纯中途正文的段
  const textsOnly: Segment[] = [text("m0", "先说一句。", 0), text("m1", "再说一句。", 1)];
  assert.deepStrictEqual(
    foldTurnProcess(textsOnly, true, 1).runs,
    [],
    "没有工具调用的段永远不折（阈值是工具调用次数，不是段长）",
  );
}
console.log("turnProcess: 配置阈值驱动折叠（0 永不折 / 1·2 等价 / ≥3 按值） ✓");

// ---------- 15. package.json 的配置项声明与代码里的默认值对拍（questionBatch 同款） ----------
{
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    contributes?: { configuration?: { properties?: Record<string, { type?: string; minimum?: number; default?: unknown }> } };
  };
  const config = pkg.contributes?.configuration?.properties?.["dshChat.turnProcessThreshold"];
  assert.ok(config, "package.json 必须有 dshChat.turnProcessThreshold 配置项");
  assert.strictEqual(config.type, "integer", "配置项是整数");
  assert.strictEqual(config.minimum, 0, "限定参数 >= 0");
  assert.strictEqual(config.default, DEFAULT_TURN_PROCESS_THRESHOLD, "默认值与代码里的缺省阈值一致");
}
console.log("turnProcess: package.json 配置项声明与默认值对拍 ✓");

console.log("turnProcess: 连续过程折叠（只留最后正文 / 阈值 / 计数 / 文案 / 不折的情形） ✓");
console.log("\nturnProcess: all assertions passed");
