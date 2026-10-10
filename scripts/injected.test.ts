/**
 * 验证「自动载入的提示词节点」被正确呈现。
 *
 * 真实事件形态（取自 `scripts/systemPromptProbe.ts` 对真实会话的 dump）：
 *  - `system/message`：完整系统提示词，source.kind='plugin'，
 *    plugin='@deepseek-ai/dsh-system-prompt'，实测 7046 字符；
 *  - `user/message` 但 source.kind ≠ 'user'：插件注入的上下文，例如
 *    `{kind:'plugin', plugin:'dsh-mcp-manager', form:'mcp-status'}`、
 *    `{kind:'plugin', plugin:'openviking-memory', form:'recall'}`（**每轮都有**）、
 *    `{kind:'agent-instructions', form:'instructions'}`（AGENTS.md）、
 *    `{kind:'skill-catalog', form:'catalog'}`（实测 6908 字符）。
 *
 * 这些此前被整体丢弃，用户看不到模型被喂了什么。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";
import type { HostToWebview } from "../src/shared/ipc";
import type { MessageView, Segment } from "../src/shared/chat";

function harness() {
  const messages: MessageView[] = [];
  const adapter = new SessionAdapter((original) => {
    const frame = structuredClone(original) as HostToWebview;
    switch (frame.type) {
      case "messages/reset":
        messages.length = 0;
        messages.push(...frame.messages);
        break;
      case "message/upsert": {
        const index = messages.findIndex((m) => m.id === frame.message.id);
        if (index < 0) messages.push(frame.message);
        else messages[index] = frame.message;
        break;
      }
      case "message/append": {
        const target = messages.find((m) => m.id === frame.messageId);
        if (target) target.segments = [...target.segments, frame.segment];
        break;
      }
      default:
        break;
    }
  });
  return { adapter, messages };
}

const injected = (messages: MessageView[]): Extract<Segment, { kind: "injected" }>[] =>
  messages.flatMap((m) =>
    m.segments.filter((s): s is Extract<Segment, { kind: "injected" }> => s.kind === "injected"),
  );

const SYSTEM_TEXT = "You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent…";

// ---------- 1. system/message 变成可见节点 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "system/message", seq: 2, time: t + 1,
    data: {
      turn: 1, step: 1,
      message: {
        id: "s1", role: "system",
        content: [{ type: "text", text: SYSTEM_TEXT }],
        source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" },
      },
    },
  });

  const nodes = injected(messages);
  assert.strictEqual(nodes.length, 1, `系统提示词应当可见，实际 ${nodes.length} 个节点`);
  assert.strictEqual(nodes[0].injected.sourceKind, "plugin");
  assert.strictEqual(nodes[0].injected.plugin, "@deepseek-ai/dsh-system-prompt");
  assert.strictEqual(nodes[0].injected.text, SYSTEM_TEXT);
}
console.log("injected: system/message 可见 ✓");

// ---------- 2. 非用户来源的 user/message 变成可见节点（此前全被丢弃） ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });

  const cases = [
    { source: { kind: "plugin", plugin: "dsh-mcp-manager", form: "mcp-status" }, text: "<mcp-status>\nMCP 服务器当前状态…" },
    { source: { kind: "plugin", plugin: "openviking-memory", form: "instructions" }, text: "<openviking-context source=\"profile\">…" },
    { source: { kind: "agent-instructions", form: "instructions", baseline: true }, text: "<system-reminder>\nThe following workspace instructions…" },
    { source: { kind: "skill-catalog", form: "catalog", entries: [] }, text: "<system-reminder>\nA skill is a reusable set…" },
    { source: { kind: "plugin", plugin: "openviking-memory", form: "recall" }, text: "<openviking-context>\nRelevant memory…" },
  ];
  let seq = 2;
  for (const item of cases) {
    adapter.applyEvent({
      type: "user/message", seq: seq++, time: t + seq,
      data: { id: `u${seq}`, role: "user", content: [{ type: "text", text: item.text }], source: item.source },
    });
  }

  const nodes = injected(messages);
  assert.strictEqual(nodes.length, cases.length, `应当有 ${cases.length} 个注入节点，实际 ${nodes.length}`);
  assert.deepStrictEqual(
    nodes.map((n) => n.injected.sourceKind),
    ["plugin", "plugin", "agent-instructions", "skill-catalog", "plugin"],
  );
  assert.strictEqual(nodes[0].injected.form, "mcp-status");
  assert.strictEqual(nodes[2].injected.form, "instructions");
  assert.strictEqual(nodes[3].injected.sourceKind, "skill-catalog");
  assert.strictEqual(nodes[4].injected.form, "recall", "每轮的记忆召回也要显示");
}
console.log("injected: 插件注入（含每轮 recall）可见 ✓");

// ---------- 3. 真正的用户消息仍然是用户消息 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "user/message", seq: 2, time: t + 1,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "真实提问" }], source: { kind: "user", rpcId: "r1" } },
  });

  const users = messages.filter((m) => m.role === "user");
  assert.strictEqual(users.length, 1, "真实用户消息不能被当成注入节点");
  assert.strictEqual(users[0].text, "真实提问");
  assert.strictEqual(injected(messages).length, 0, "真实用户消息不该产生注入节点");
}
console.log("injected: 真实用户消息不受影响 ✓");

// ---------- 4. 顺序：用户提问在顶，注入节点在回答之前 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "user/message", seq: 2, time: t + 1,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "提问" }], source: { kind: "user" } },
  });
  adapter.applyEvent({
    type: "user/message", seq: 3, time: t + 2,
    data: { id: "u2", role: "user", content: [{ type: "text", text: "<mcp-status>…" }], source: { kind: "plugin", plugin: "dsh-mcp-manager", form: "mcp-status" } },
  });
  adapter.applyEvent({
    type: "assistant/message", seq: 4, time: t + 5,
    data: { turn: 1, step: 0, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "回答" }] } },
  });

  const order = messages.map((m) => (m.role === "user" ? `U:${m.text}` : "A"));
  assert.deepStrictEqual(order, ["U:提问", "A"], `实际 ${JSON.stringify(order)}`);
  // 助手消息内：注入节点必须在正文之前
  const assistant = messages.find((m) => m.role === "assistant")!;
  const kinds = assistant.segments.map((s) => s.kind);
  assert.deepStrictEqual(kinds, ["injected", "text"], `助手段落顺序 ${JSON.stringify(kinds)}`);
}
console.log("injected: 提问在顶、注入在回答前 ✓");

// ---------- 5. 重放去重：同一 seq 再来一次不重复堆叠 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  const event = {
    type: "system/message" as const, seq: 7, time: t,
    data: {
      turn: 1, step: 0,
      message: { id: "s1", role: "system", content: [{ type: "text", text: "系统提示词" }], source: { kind: "plugin", plugin: "p" } },
    },
  };
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent(structuredClone(event));
  adapter.applyEvent(structuredClone(event)); // 快照重放

  assert.strictEqual(injected(messages).length, 1, "同一条事件重放不该产生两个节点");
}
console.log("injected: 重放去重 ✓");

// ---------- 6. 空内容的 system/message 不产生节点 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  // 「Empty content means no system prompt」
  adapter.applyEvent({
    type: "system/message", seq: 2, time: t,
    data: { turn: 1, step: 0, message: { id: "s0", role: "system", content: [], source: { kind: "plugin", plugin: "p" } } },
  });
  assert.strictEqual(injected(messages).length, 0, "空内容不该产生空白节点");
}
console.log("injected: 空内容跳过 ✓");

// ---------- 7. 大内容完整保留（界面负责折叠，宿主不该截断） ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  const big = "技能描述".repeat(2000); // 8000 字符
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "system/message", seq: 2, time: t,
    data: { turn: 1, step: 0, message: { id: "s1", role: "system", content: [{ type: "text", text: big }], source: { kind: "skill-catalog" } } },
  });
  const nodes = injected(messages);
  assert.strictEqual(nodes[0].injected.text.length, big.length, "宿主不该截断内容（折叠是界面的事）");
}
console.log("injected: 大内容不截断 ✓");

// ---------- 8. 0.1.7-alpha.1 的**生产者自有 kind** 也要读出人话 ----------
//
// 契约里 `MessageSourceMap` 的通用 `plugin` 成员已被删除，每个生产者声明自己的 kind：
// 系统提示词是 `system-prompt`，沙箱/审批那类运行时上下文是 `runtime-context`，
// 第三方插件落成 `plugin:<包名>`（`rewritePluginSource` 的回退形态，实测形态见
// `@openviking/dsh-memory-plugin` 0.5.2 的 `capture.mjs`）。插件名必须从 kind 里取出来
// ——否则界面副标题会退化成裸 kind，「这条上下文是谁注入的」就看不出来了。
{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "system/message", seq: 2, time: t + 1,
    data: { turn: 1, step: 1, message: { id: "s1", role: "system", content: [{ type: "text", text: "系统提示词" }], source: { kind: "system-prompt" } } },
  });
  const cases = [
    { source: { kind: "runtime-context", form: "snapshot" }, text: "<sandbox>…" },
    // 新版记忆插件：kind 是 `plugin:<包名>`，同时仍带 plugin 字段
    { source: { kind: "plugin:openviking-memory", plugin: "openviking-memory", form: "recall" }, text: "<openviking-context>…" },
    // 只有 kind、没有 plugin 的第三方形态（回退成 `plugin:<包名>` 的老日志）
    { source: { kind: "plugin:dsh-mcp-manager", form: "mcp-status" }, text: "<mcp-status>…" },
  ];
  let seq = 3;
  for (const item of cases) {
    adapter.applyEvent({
      type: "user/message", seq: seq++, time: t + seq,
      data: { id: `u${seq}`, role: "user", content: [{ type: "text", text: item.text }], source: item.source },
    });
  }

  const nodes = injected(messages);
  assert.strictEqual(nodes.length, cases.length + 1, `节点数应当等于事件数，实际 ${nodes.length}`);
  assert.strictEqual(nodes[0].injected.sourceKind, "system-prompt", "系统提示词用自己的 kind");
  assert.strictEqual(nodes[1].injected.sourceKind, "runtime-context");
  assert.strictEqual(nodes[1].injected.form, "snapshot", "form 仍按生产者声明读");
  assert.strictEqual(nodes[2].injected.plugin, "openviking-memory", "插件名从 plugin 字段取");
  assert.strictEqual(nodes[3].injected.plugin, "dsh-mcp-manager", "只有 kind 时从 plugin:<包名> 里取");
}
console.log("injected: 生产者自有 kind（system-prompt / runtime-context / plugin:<包名>） ✓");

// ---------- 9. 跨会话召回：把引用的会话挂回**紧邻在前的**那条用户消息 ----------
//
// 真实落盘形态（取自会话日志）：用户消息正文里 `@[标题](dsh-session:…)` 已被服务端折成
// `@标题`，会话 id 只在紧随其后的召回事件（`kind: "session-reference"`, `form: "recall"`）
// 的 `source.references[]` 里。宿主必须把它挂回前一条消息（`seq - 1`），否则界面只能按
// 形状把 `@标题` 当文件引用——用户 2026-10-10 报的就是这个。
{
  const { adapter, messages } = harness();
  const t = Date.now();
  const reference = {
    sessionId: "session-10263ccf-3e75-4923-bf8a-eea1a86ec30a",
    label: "轨迹四项收口与逐块渲染交接",
    capturedFormatVersion: 4,
    capturedThroughSeq: 3112,
    compacted: false,
    originalMessages: 97,
    retainedMessages: 97,
    omittedMessages: 0,
    omittedBytes: 0,
    truncated: false,
    inputIndex: 0,
  };
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "user/message", seq: 2, time: t + 1,
    data: {
      id: "u1", role: "user",
      content: [{ type: "text", text: "@轨迹四项收口与逐块渲染交接 里出现了大量未知内容块" }],
      source: { kind: "user", rpcId: "r1" },
    },
  });
  // 挂接之前：界面只看到折叠后的标题，这条消息还不带引用
  assert.strictEqual(
    messages.find((m) => m.role === "user")?.sessionRefs,
    undefined,
    "召回还没到，先不凭空造引用",
  );
  adapter.applyEvent({
    type: "user/message", seq: 3, time: t + 2,
    data: {
      id: "u2", role: "user",
      content: [{ type: "text", text: "## Referenced sessions\n\n…" }],
      source: { kind: "session-reference", form: "recall", version: 1, references: [reference] },
    },
  });

  const users = messages.filter((m) => m.role === "user");
  assert.strictEqual(users.length, 1, "召回本身不是用户消息（它是自动载入的上下文）");
  assert.deepStrictEqual(
    users[0]?.sessionRefs,
    [{ label: "轨迹四项收口与逐块渲染交接", sessionId: reference.sessionId }],
    "标题 ↔ 会话 id 要挂到引用它的那条消息上",
  );
  assert.strictEqual(users[0]?.text, "@轨迹四项收口与逐块渲染交接 里出现了大量未知内容块", "只补引用，正文一个字不动");
  assert.strictEqual(injected(messages).length, 1, "召回卡片照旧显示（挂接不影响注入节点）");

  // 重放同一条召回事件：不重复、值不变（跟随窗口重折历史走的就是这条路）
  adapter.applyEvent({
    type: "user/message", seq: 3, time: t + 2,
    data: {
      id: "u2", role: "user",
      content: [{ type: "text", text: "## Referenced sessions\n\n…" }],
      source: { kind: "session-reference", form: "recall", version: 1, references: [reference] },
    },
  });
  assert.strictEqual(messages.filter((m) => m.role === "user").length, 1, "重放不该多出一条消息");
  assert.strictEqual(injected(messages).length, 1, "重放不该多出一个注入节点");
  assert.strictEqual(
    messages.find((m) => m.role === "user")?.sessionRefs?.length,
    1,
    "重放后引用仍在",
  );
}
console.log("injected: 跨会话召回把引用挂回前一条用户消息 ✓");

// ---------- 10. 认不出召回形状：什么都不挂（不猜） ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "user/message", seq: 2, time: t + 1,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "@某个会话 的问题" }], source: { kind: "user" } },
  });
  // 记忆类插件的 `form: "recall"` 不是跨会话引用（kind 不同）；references 形状不对的更不算
  const recalls = [
    { kind: "plugin:openviking-memory", plugin: "openviking-memory", form: "recall", references: [{ label: "某个会话", sessionId: "s1" }] },
    { kind: "session-reference", form: "recall", version: 1, references: [{ sessionId: "s1" }] },
    { kind: "session-reference", form: "recall", version: 1, references: [] },
    { kind: "session-reference", form: "recall", version: 1 },
  ];
  let seq = 3;
  for (const source of recalls) {
    adapter.applyEvent({
      type: "user/message", seq: seq++, time: t + seq,
      data: { id: `u${seq}`, role: "user", content: [{ type: "text", text: "## Referenced sessions\n…" }], source },
    });
  }
  assert.strictEqual(
    messages.find((m) => m.role === "user")?.sessionRefs,
    undefined,
    "拿不到「标题 + 会话 id」就不挂：界面照旧按形状显示，不猜",
  );

  // 召回事件出现在最前面（跟随窗口从一轮中间开始）：没有前一条消息，不能炸也不能乱挂
  const orphan = harness();
  orphan.adapter.applyEvent({
    type: "user/message", seq: 5, time: t,
    data: {
      id: "u5", role: "user",
      content: [{ type: "text", text: "## Referenced sessions\n…" }],
      source: { kind: "session-reference", form: "recall", version: 1, references: [{ sessionId: "s1", label: "x" }] },
    },
  });
  assert.deepStrictEqual(
    orphan.messages.filter((m) => m.role === "user"),
    [],
    "孤儿召回不创出用户消息",
  );
}
console.log("injected: 认不出的召回不挂引用 ✓");

console.log("\ninjected: all assertions passed");
