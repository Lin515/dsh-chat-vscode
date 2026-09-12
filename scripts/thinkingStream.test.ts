/**
 * 验证两个界面缺陷的宿主侧成因：
 *
 * A. **思考完毕后鲸鱼仍发光（蓝）**：`.icon-glow` 只在 `segment.streaming === true`
 *    时渲染，所以「思考结束还发蓝光」意味着某个 thinking 段落的 `streaming`
 *    没有被清掉——大概率是流式叠加层没被 durable 消息正确替换。
 *
 * B. **用户消息没有置顶在本轮顶部**：`user/message` 到达时若本轮助手消息**已经有
 *    段落**（流式正文可能先落盘），旧逻辑就退化成「追加到末尾」，于是用户消息
 *    跑到了助手输出下面。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";
import type { HostToWebview } from "../src/shared/ipc";
import type { MessageView, Segment } from "../src/shared/chat";

/**
 * 收集帧并维护一份消息快照，模拟 webview 的状态归约。
 *
 * 关键：帧要**深拷贝**再应用。真实链路上宿主与 webview 之间隔着
 * `postMessage` 的结构化克隆；若这里共享引用，适配器对 `message.segments`
 * 的原地修改会与快照重复叠加，测出假阳性。
 */
function harness() {
  const messages: MessageView[] = [];
  const adapter = new SessionAdapter((original) => {
    const frame = structuredClone(original);
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
      case "message/segment": {
        const target = messages.find((m) => m.id === frame.messageId);
        if (target) {
          target.segments = target.segments.map((s) => (s.id === frame.segment.id ? frame.segment : s));
        }
        break;
      }
      case "message/delta": {
        const target = messages.find((m) => m.id === frame.messageId);
        const seg = target?.segments.find((s) => s.id === frame.segmentId);
        if (seg && (seg.kind === "text" || seg.kind === "thinking")) {
          seg.text += frame.delta;
        }
        break;
      }
      default:
        break;
    }
  });
  return { adapter, messages };
}

const thinkingSegments = (messages: MessageView[]): Extract<Segment, { kind: "thinking" }>[] =>
  messages.flatMap((m) => m.segments.filter((s): s is Extract<Segment, { kind: "thinking" }> => s.kind === "thinking"));

// ---------- A. 思考时的流式叠加层必须被 durable 消息清掉 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();

  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyAssistantStream({ type: "start", attemptId: "att1", revision: 1, turn: 1, step: 0 });
  // 思考增量：建立一条 streaming: true 的 live 段落
  adapter.applyAssistantStream({
    type: "chunk", attemptId: "att1", revision: 1, index: 0, time: t + 10,
    chunk: { type: "reasoning-delta", index: 0, text: "先看两个文件的初始化路径" },
  });

  const liveDuring = thinkingSegments(messages);
  assert.strictEqual(liveDuring.length, 1, "思考中应有一条 thinking 段落");
  assert.strictEqual(liveDuring[0].streaming, true, "思考中应标记 streaming（界面据此发光）");

  // 持久化的助手消息（含完整 reasoning）：应当替换掉流式叠加层
  adapter.applyEvent({
    type: "assistant/message", seq: 2, time: t + 100,
    data: {
      turn: 1, step: 0,
      message: {
        id: "m1", role: "assistant",
        content: [{ type: "reasoning", text: "先看两个文件的初始化路径，再决定怎么合并。" }],
      },
    },
  });

  const after = thinkingSegments(messages);
  assert.strictEqual(after.length, 1, `durable 替换后应只剩一条 thinking 段落，实际 ${after.length} 条`);
  assert.notStrictEqual(after[0].streaming, true, "思考结束后不能再标记 streaming（否则鲸鱼一直发蓝光）");
  assert.ok(after[0].text.includes("再决定怎么合并"), "应当是 durable 内容");
}
console.log("thinkingStream: durable 消息清掉流式标记 ✓");

// ---------- A2. turn/end 之后也绝不能残留 streaming ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyAssistantStream({ type: "start", attemptId: "att1", revision: 1, turn: 1, step: 0 });
  adapter.applyAssistantStream({
    type: "chunk", attemptId: "att1", revision: 1, index: 0, time: t + 10,
    chunk: { type: "reasoning-delta", index: 0, text: "只思考，不产出正文" },
  });
  // 服务端没有回 durable 正文（例如只有思考、随后中止）：仍要收掉发光
  adapter.applyEvent({
    type: "turn/end", seq: 2, time: t + 200,
    data: { turn: 1, reason: { kind: "completed" } },
  });

  const leftover = thinkingSegments(messages).filter((s) => s.streaming === true);
  assert.strictEqual(
    leftover.length,
    0,
    `turn/end 后仍有 ${leftover.length} 条 thinking 段落标记为 streaming（鲸鱼会一直发光）`,
  );
}
console.log("thinkingStream: turn/end 收掉所有 streaming ✓");

// ---------- B. 用户消息必须置顶在本轮顶部 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "user/message", seq: 2, time: t + 1,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "第一轮问题" }], source: { kind: "user" } },
  });
  adapter.applyEvent({
    type: "assistant/message", seq: 3, time: t + 50,
    data: { turn: 1, step: 0, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "第一轮回答" }] } },
  });

  // 第二轮：流式正文先于 durable user/message 到达（真实场景里很常见）
  adapter.applyEvent({ type: "turn/start", seq: 4, time: t + 100, data: { turn: 2 } });
  adapter.applyAssistantStream({ type: "start", attemptId: "att2", revision: 1, turn: 2, step: 0 });
  adapter.applyAssistantStream({
    type: "chunk", attemptId: "att2", revision: 1, index: 0, time: t + 110,
    chunk: { type: "text-delta", index: 0, text: "第二轮的回答正在流式输出" },
  });
  // 用户消息此刻才到：本轮助手消息已经**有段落**了
  adapter.applyEvent({
    type: "user/message", seq: 5, time: t + 120,
    data: { id: "u2", role: "user", content: [{ type: "text", text: "第二轮问题" }], source: { kind: "user" } },
  });

  const order = messages.map((m) => (m.role === "user" ? `U:${m.text}` : `A:${m.id}`));
  const userIndex = messages.findIndex((m) => m.role === "user" && m.text === "第二轮问题");
  const assistant2Index = messages.findIndex((m) => m.id === "a:2");
  assert.ok(userIndex >= 0, `第二轮用户消息应当存在，实际顺序 ${JSON.stringify(order)}`);
  assert.ok(
    userIndex < assistant2Index,
    `第二轮用户消息必须排在本轮助手消息之前，实际顺序 ${JSON.stringify(order)}`,
  );
}
console.log("thinkingStream: 用户消息置顶本轮 ✓");

// ---------- B2. 多轮：每轮的用户消息都在自己那轮顶部 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  let seq = 1;
  for (let turn = 1; turn <= 3; turn++) {
    adapter.applyEvent({ type: "turn/start", seq: seq++, time: t + turn * 100, data: { turn } });
    adapter.applyAssistantStream({ type: "start", attemptId: `att${turn}`, revision: 1, turn, step: 0 });
    adapter.applyAssistantStream({
      type: "chunk", attemptId: `att${turn}`, revision: 1, index: 0, time: t + turn * 100 + 5,
      chunk: { type: "text-delta", index: 0, text: `回答 ${turn}` },
    });
    adapter.applyEvent({
      type: "user/message", seq: seq++, time: t + turn * 100 + 10,
      data: { id: `u${turn}`, role: "user", content: [{ type: "text", text: `问题 ${turn}` }], source: { kind: "user" } },
    });
  }

  const order = messages.map((m) => (m.role === "user" ? `U${m.text?.slice(-1)}` : `A${m.id.slice(2)}`));
  assert.deepStrictEqual(
    order,
    ["U1", "A1", "U2", "A2", "U3", "A3"],
    `每轮应是「用户消息 → 助手输出」，实际 ${JSON.stringify(order)}`,
  );
}
console.log("thinkingStream: 多轮顺序 ✓");

// ---------- B3. 同轮插话（第二条用户消息）按时间顺序追加，不被抬到顶部 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "user/message", seq: 2, time: t + 1,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "本轮提问" }], source: { kind: "user" } },
  });
  adapter.applyEvent({
    type: "assistant/message", seq: 3, time: t + 50,
    data: { turn: 1, step: 0, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "第一步输出" }] } },
  });
  // 运行中插话：同样是 user 来源，但属于本轮的第二条
  adapter.applyEvent({
    type: "user/message", seq: 4, time: t + 60,
    data: { id: "u2", role: "user", content: [{ type: "text", text: "插一句" }], source: { kind: "user" } },
  });

  const order = messages.map((m) => (m.role === "user" ? `U:${m.text}` : `A:${m.id}`));
  assert.deepStrictEqual(
    order,
    ["U:本轮提问", "A:a:1", "U:插一句"],
    `插话应按时间顺序追加，不该被抬到本轮顶部，实际 ${JSON.stringify(order)}`,
  );
}
console.log("thinkingStream: 同轮插话按时间顺延 ✓");

// ---------- B5. 队列消息被 splice 进**运行中的同一轮**：切开轮次，后续生成在插话下方 ----------
//
// 用户 2026-09-14 报告（会话日志实锤，见 scripts/queueLogInspect.ts）：服务端经
// agent/inbox 把运行中提交的消息直接注入同一轮（user/message 落在 turn/end 之前
// 几十分钟），该轮的后续回答全部进同一条助手消息——旧折叠把插话追加到末尾后，
// 生成继续压在插话上方（「生成内容在其上方继续生成」）。修复 = 在插话处把轮切
// 成多段（a:1 → a:1:2），后续生成进下一段。

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "user/message", seq: 2, time: t + 1,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "第一问" }], source: { kind: "user" } },
  });
  adapter.applyEvent({
    type: "assistant/message", seq: 3, time: t + 50,
    data: { turn: 1, step: 0, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "第一答" }] } },
  });
  // 队列项被 splice 进还在跑的 turn 1（同一条 user 来源消息，本轮第二条）
  adapter.applyEvent({
    type: "user/message", seq: 4, time: t + 60,
    data: { id: "u2", role: "user", content: [{ type: "text", text: "【QUEUED】排队的问题" }], source: { kind: "user" } },
  });
  // 同一轮的后续生成改走流式（step 1）：必须落在插话**下方**的新段 a:1:2
  adapter.applyAssistantStream({ type: "start", attemptId: "att2", revision: 1, turn: 1, step: 1 });
  adapter.applyAssistantStream({
    type: "chunk", attemptId: "att2", revision: 1, index: 0, time: t + 70,
    chunk: { type: "text-delta", index: 0, text: "对插话的回答" },
  });

  const order = messages.map((m) => (m.role === "user" ? `U:${m.text}` : `A:${m.id}`));
  assert.deepStrictEqual(
    order,
    ["U:第一问", "A:a:1", "U:【QUEUED】排队的问题", "A:a:1:2"],
    `插话后同轮的后续生成要进新段（插话下方），实际 ${JSON.stringify(order)}`,
  );
  const part2 = messages.find((m) => m.id === "a:1:2");
  const liveText = part2?.segments.find((s) => s.id === "live:att2:0");
  assert.ok(
    liveText && liveText.kind === "text" && liveText.text === "对插话的回答" && liveText.streaming,
    "切分后流式增量要进新段 a:1:2",
  );

  // durable 内容到达：替换掉叠加层，仍在新段里
  adapter.applyEvent({
    type: "assistant/message", seq: 5, time: t + 100,
    data: { turn: 1, step: 1, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "对插话的回答（完整）" }] } },
  });
  const afterDurable = messages.find((m) => m.id === "a:1:2");
  assert.ok(
    afterDurable?.segments.some((s) => s.kind === "text" && s.text === "对插话的回答（完整）"),
    "durable 替换要落回同一段（跨段清叠加层）",
  );
  // 第一段原样保留
  const part1 = messages.find((m) => m.id === "a:1");
  assert.ok(part1?.segments.some((s) => s.kind === "text" && s.text === "第一答"), "切分前的内容留在第一段");
}
console.log("thinkingStream: 运行中插话切开轮次（生成进插话下方） ✓");

// ---------- B4. 重复事件（重连重放）不产生重复的用户消息 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  const userEvent = {
    type: "user/message", seq: 2, time: t + 1,
    data: { id: "u1", role: "user", content: [{ type: "text", text: "只发一次" }], source: { kind: "user" } },
  };
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent(structuredClone(userEvent));
  adapter.applyEvent(structuredClone(userEvent)); // 同一 seq 再来一次

  const users = messages.filter((m) => m.role === "user");
  assert.strictEqual(users.length, 1, `重复事件不该产生 ${users.length} 条用户消息`);
}
console.log("thinkingStream: 重复事件去重 ✓");

// ---------- C. 本轮关闭时为未结算的工具调用合成中断结果 ----------
//
// 官方语义（`projectBlock` + `interruption(context)`）：只要 step/turn **已关闭**，
// 所有还没结算的调用都会在视图投影阶段被合成一个 `error.code === 'interrupted'`
// 的结果，界面渲染成 stopped（警告色）。不这么做的话，这些行永远停在「运行中」，
// 看起来像任务卡死（docs/audit-summary.md §12）。
//
// 关键：**不按收场原因分支**。官方只看「turn 是否关闭」，所以正常完成但调用没收尾
// 的情形同样要合成（结果被截断、连接抖动都会造成它）。
{
  const tools = (messages: MessageView[]) =>
    messages.flatMap((m) =>
      m.segments.filter((s): s is Extract<Segment, { kind: "tool" }> => s.kind === "tool"),
    );

  for (const reason of [{ kind: "aborted" }, { kind: "completed" }, { kind: "max-tokens" }, { kind: "error" }]) {
    const { adapter, messages } = harness();
    const t = Date.now();
    adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
    adapter.applyEvent({
      type: "tool/call", seq: 2, time: t + 1,
      data: { callId: `c-${reason.kind}`, name: "read", arguments: '{"file_path":"a.ts"}' },
    });
    // 故意**不发** tool/result —— 模拟这一轮结束时调用还没收尾
    adapter.applyEvent({ type: "turn/end", seq: 3, time: t + 2, data: { turn: 1, reason } });

    const list = tools(messages);
    assert.strictEqual(list.length, 1, `${reason.kind}: 应当有一条工具行`);
    assert.strictEqual(
      list[0].tool.status,
      "stopped",
      `${reason.kind}: 未结算的调用必须收成 stopped，而不是永远停在 ${list[0].tool.status}`,
    );
    assert.ok(list[0].tool.endedAt, `${reason.kind}: 合成结果要带上结束时间（否则计时器还在跳）`);
  }
}
console.log("thinkingStream: 本轮关闭后未结算的工具行收成 stopped（不按收场原因分支） ✓");

// ---------- C2. 已结算的调用不被合成覆盖 ----------

{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  adapter.applyEvent({
    type: "tool/call", seq: 2, time: t + 1,
    data: { callId: "c1", name: "read", arguments: '{"file_path":"a.ts"}' },
  });
  adapter.applyEvent({
    type: "tool/result", seq: 3, time: t + 2,
    data: { message: { source: { callId: "c1" }, content: [{ type: "tool-result", content: [{ type: "text", text: "文件内容" }] }] } },
  });
  adapter.applyEvent({ type: "turn/end", seq: 4, time: t + 3, data: { turn: 1, reason: { kind: "aborted" } } });

  const tool = messages
    .flatMap((m) => m.segments)
    .find((s): s is Extract<Segment, { kind: "tool" }> => s.kind === "tool");
  assert.strictEqual(tool?.tool.status, "ok", "已经拿到结果的调用不该被改写成 stopped");
  assert.strictEqual(tool?.tool.output, "文件内容", "结果文本要保住");
}
console.log("thinkingStream: 已结算的调用不被中断合成覆盖 ✓");

console.log("\nthinkingStream: all assertions passed");
