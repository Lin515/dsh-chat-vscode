/**
 * 段顺序：**活路径**（真流式）与「离线重放」必须给出同一个顺序。
 *
 * 用户 2026-09-14 报的现场：连续工具调用里，助手说过的中间话与思考会**错位**——
 * DSH Web 上是「思考 → 4 次编辑 → 正文 → 编辑…」，本扩展却把工具行排到了那段
 * 思考/正文前面。
 *
 * 根因（`scripts/renderOrderProbe.ts` 对着真实会话日志比对过：离线重放顺序是**对的**，
 * 只有活路径错）：模型是**边说边吐工具调用**的，`tool-call-delta` 流式帧会**先**
 * 建出工具行（`upsertToolCall`），而该 step 的 durable `assistant/message`（思考/正文）
 * 随后才到——`applyAssistantMessage` 当时是**追加到末尾**，于是思考/正文被排到了
 * 自己那个 step 的工具行**后面**。
 *
 * 修法：durable 的思考/正文插在**本 step 最早的工具行之前**（官方按内容块顺序渲染，
 * 工具调用在内容里总是排在思考/正文之后）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageView, Segment } from "../src/shared/chat";
import type { HostToWebview } from "../src/shared/ipc";

function harness() {
  const messages: MessageView[] = [];
  const adapter = new SessionAdapter((original) => {
    const frame = structuredClone(original) as HostToWebview;
    if (frame.type === "messages/reset") {
      messages.length = 0;
      messages.push(...frame.messages);
    } else if (frame.type === "message/upsert") {
      const index = messages.findIndex((m) => m.id === frame.message.id);
      if (index < 0) messages.push(frame.message);
      else messages[index] = frame.message;
    } else if (frame.type === "message/append") {
      const target = messages.find((m) => m.id === frame.messageId);
      if (target) target.segments = [...target.segments, frame.segment];
    }
  });
  return { adapter, messages };
}

/** 段顺序的摘要：`thinking/step, tool:edit, text/step…`。 */
function shape(message: MessageView | undefined): string[] {
  return (message?.segments ?? []).map((segment) => {
    const step = segment.step ?? "?";
    if (segment.kind === "tool") return `tool:${segment.tool.name}@${step}`;
    if (segment.kind === "text") return `text@${step}`;
    if (segment.kind === "thinking") return `thinking@${step}`;
    return `${segment.kind}@${step}`;
  });
}

/** 一段流式帧：start → 若干 chunk → end。 */
function stream(
  adapter: SessionAdapter,
  turn: number,
  step: number,
  attemptId: string,
  chunks: unknown[],
) {
  adapter.applyAssistantStream({
    type: "start",
    attemptId,
    revision: 1,
    turn,
    step,
  } as never);
  for (const chunk of chunks) {
    adapter.applyAssistantStream({
      type: "chunk",
      attemptId,
      revision: 1,
      index: 0,
      time: Date.now(),
      chunk,
    } as never);
  }
}

// ---------- 1. 思考 + 边说边吐的工具调用（活路径的真实顺序） ----------
{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({ type: "step/start", seq: 2, time: t + 1, data: { turn: 1, step: 0 } });

  // 模型先思考……
  stream(adapter, 1, 0, "att-1", [{ type: "reasoning-delta", index: 0, text: "Two changes: 先改 A 再改 B" }]);
  // ……然后**边吐工具调用**（这一帧就建出了工具行）
  stream(adapter, 1, 0, "att-1", [
    { type: "tool-call-delta", index: 1, id: "call_1", name: "edit", argumentsDelta: '{"file_path":"a.ts"}' },
  ]);
  // 该 step 的 durable 消息随后才到（里面同时有 reasoning 与 tool-call 块）
  adapter.applyEvent({
    type: "assistant/message",
    seq: 3,
    time: t + 2,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "Two changes: 先改 A 再改 B" },
          { type: "tool-call", id: "call_1", name: "edit", arguments: '{"file_path":"a.ts"}' },
        ],
      },
    },
  });
  // 工具结果
  adapter.applyEvent({
    type: "tool/call",
    seq: 4,
    time: t + 3,
    data: { callId: "call_1", name: "edit", arguments: '{"file_path":"a.ts"}' },
  });
  adapter.applyEvent({
    type: "tool/result",
    seq: 5,
    time: t + 4,
    data: { message: { source: { callId: "call_1" }, content: [{ type: "tool-result", content: [{ type: "text", text: "ok" }] }] } },
  });

  assert.deepStrictEqual(
    shape(messages.find((m) => m.id === "a:1")),
    ["thinking@0", "tool:edit@0"],
    "思考必须排在自己那个 step 的工具行**前面**（活路径此前会反），" +
      `实际 ${JSON.stringify(shape(messages.find((m) => m.id === "a:1")))}`,
  );
  const thinking = messages
    .find((m) => m.id === "a:1")
    ?.segments.find((s): s is Extract<Segment, { kind: "thinking" }> => s.kind === "thinking");
  assert.strictEqual(thinking?.streaming, undefined, "durable 内容替换掉叠加层后不该还留着 streaming 标记");
}
console.log("renderOrder: 活路径「思考 → 工具行」（边说边吐工具调用） ✓");

// ---------- 2. 正文同理：文字 + 工具调用 ----------
{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({ type: "step/start", seq: 2, time: t + 1, data: { turn: 1, step: 0 } });
  stream(adapter, 1, 0, "att-1", [{ type: "text-delta", index: 0, text: "Now the dictionary entries:" }]);
  stream(adapter, 1, 0, "att-1", [
    { type: "tool-call-delta", index: 1, id: "call_1", name: "edit", argumentsDelta: "{}" },
  ]);
  adapter.applyEvent({
    type: "assistant/message",
    seq: 3,
    time: t + 2,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "text", text: "Now the dictionary entries:" },
          { type: "tool-call", id: "call_1", name: "edit", arguments: "{}" },
        ],
      },
    },
  });
  assert.deepStrictEqual(
    shape(messages.find((m) => m.id === "a:1")),
    ["text@0", "tool:edit@0"],
    "正文必须排在自己那个 step 的工具行前面",
  );
  const text = messages
    .find((m) => m.id === "a:1")
    ?.segments.find((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text");
  assert.strictEqual(text?.text, "Now the dictionary entries:", "正文内容不能被叠加层残留顶掉");
}
console.log("renderOrder: 活路径「正文 → 工具行」 ✓");

// ---------- 3. 一个 step 多个工具调用：思考排在最前，工具保持原序 ----------
{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({ type: "step/start", seq: 2, time: t + 1, data: { turn: 1, step: 0 } });
  stream(adapter, 1, 0, "att-1", [{ type: "reasoning-delta", index: 0, text: "看看日志" }]);
  stream(adapter, 1, 0, "att-1", [
    { type: "tool-call-delta", index: 1, id: "call_1", name: "read", argumentsDelta: "{}" },
    { type: "tool-call-delta", index: 2, id: "call_2", name: "grep", argumentsDelta: "{}" },
  ]);
  adapter.applyEvent({
    type: "assistant/message",
    seq: 3,
    time: t + 2,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "看看日志" },
          { type: "tool-call", id: "call_1", name: "read", arguments: "{}" },
          { type: "tool-call", id: "call_2", name: "grep", arguments: "{}" },
        ],
      },
    },
  });
  assert.deepStrictEqual(
    shape(messages.find((m) => m.id === "a:1")),
    ["thinking@0", "tool:read@0", "tool:grep@0"],
    "思考在前，两个工具保持它们自己的先后",
  );
}
console.log("renderOrder: 一个 step 多个工具调用 ✓");

// ---------- 4. 没有流式帧（离线重放 / 中途加入）时顺序不变 ----------
{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({ type: "step/start", seq: 2, time: t + 1, data: { turn: 1, step: 0 } });
  adapter.applyEvent({
    type: "assistant/message",
    seq: 3,
    time: t + 2,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "先看文件" },
          { type: "tool-call", id: "call_1", name: "read", arguments: "{}" },
        ],
      },
    },
  });
  adapter.applyEvent({
    type: "tool/call",
    seq: 4,
    time: t + 3,
    data: { callId: "call_1", name: "read", arguments: "{}" },
  });
  assert.deepStrictEqual(
    shape(messages.find((m) => m.id === "a:1")),
    ["thinking@0", "tool:read@0"],
    "没有叠加层时也要给出同一个顺序（重放的顺序本来就是对的）",
  );
}
console.log("renderOrder: 离线重放顺序不变 ✓");

// ---------- 5. 不越界：step 2 的思考不能插到 step 1 的工具行前面 ----------
{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({ type: "step/start", seq: 2, time: t + 1, data: { turn: 1, step: 0 } });
  stream(adapter, 1, 0, "att-1", [{ type: "reasoning-delta", index: 0, text: "第一步" }]);
  stream(adapter, 1, 0, "att-1", [
    { type: "tool-call-delta", index: 1, id: "call_1", name: "read", argumentsDelta: "{}" },
  ]);
  adapter.applyEvent({
    type: "assistant/message",
    seq: 3,
    time: t + 2,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "第一步" },
          { type: "tool-call", id: "call_1", name: "read", arguments: "{}" },
        ],
      },
    },
  });
  adapter.applyEvent({
    type: "tool/result",
    seq: 4,
    time: t + 3,
    data: { message: { source: { callId: "call_1" }, content: [{ type: "tool-result", content: [{ type: "text", text: "内容" }] }] } },
  });
  // 第二步：只说了一句话
  adapter.applyEvent({ type: "step/start", seq: 5, time: t + 4, data: { turn: 1, step: 1 } });
  stream(adapter, 1, 1, "att-2", [{ type: "reasoning-delta", index: 0, text: "第二步的思考" }]);
  adapter.applyEvent({
    type: "assistant/message",
    seq: 6,
    time: t + 5,
    data: {
      turn: 1,
      step: 1,
      message: { id: "m2", role: "assistant", content: [{ type: "reasoning", text: "第二步的思考" }] },
    },
  });
  assert.deepStrictEqual(
    shape(messages.find((m) => m.id === "a:1")),
    ["thinking@0", "tool:read@0", "thinking@1"],
    "插入锚点只看**同一个 step** 的工具行：第二步的思考要排在第一步之后",
  );
}
console.log("renderOrder: 跨 step 不越界 ✓");

// ---------- 6. 结构不变量：插入锚点在适配器里，而不是界面侧排序 ----------
{
  const adapter = readFileSync(join(process.cwd(), "src", "dsh", "adapter.ts"), "utf8");
  assert.ok(
    /let at = message\.segments\.findIndex\(\(segment\) => segment\.kind === "tool" && segment\.step === step\)/.test(
      adapter,
    ),
    "applyAssistantMessage 要算「本 step 最早的工具行」作为插入锚点（判据必须带 step）",
  );
  assert.ok(
    /if \(at === undefined \|\| at >= message\.segments\.length\) message\.segments\.push\(segment\);/.test(adapter),
    "pushSegment 支持插入位置：越界/未给时照旧追加",
  );
}
console.log("renderOrder: 修法落在适配器（界面的渲染顺序保持 = 段顺序） ✓");

console.log("\nrenderOrder: all assertions passed");
