/**
 * 用户消息的落位：**本轮提问**（插到轮首）与**生成中插话**（追加 + 切段）的分界。
 *
 * 用户 2026-10-11 报的现场（`高效指导子代理完成任务`）：子代理会话里自己发出去的消息
 * 显示在**本轮开头**——本轮前几步的工具行与助手正文全跑到它下面；官方 Web 端把同一条
 * 消息放在它真正的时刻上（前一步的工具行之后、本轮的后续生成之前），所以是扩展折错了。
 *
 * 根因：分界用的是「紧邻助手消息的前一条是不是用户消息」（`alreadyHasTurnPrompt`）。
 * 子代理 / 队列驱动的会话里，一轮常常**没有人发消息开启**——`agent-message`、
 * `subagent-settled`、`tool-jobs`、队列派发都能开一轮，那个前提不成立，插话于是走了
 * 「本轮提问迟到」那条路，被插到本轮助手消息之前。
 *
 * 修法：分界改问 next-step inbox 的**本次领取**——官方 `ui-chat` 的
 * `conversation-nodes/message.ts` 就是这么判 `steering` 的（状态机逐字 vendor 在
 * `src/vendor/ui-trajectory/inbox-state.ts`，线格式换算与查询见 `src/dsh/inboxClaim.ts`）。
 * 旧启发式保留为后备，覆盖日志里没有 splice 帧的旧服务端。
 *
 * 附带一条：插话**只有在这一段已产出内容时**才切段——空壳（`turn/start` 刚建出来、
 * 模型还没吐任何东西）切出来的第一段是空的，会在气泡上方留一条只有时刻的空行，
 * 而官方按事件顺序铺节点时那里什么都没有。
 *
 * 真实日志证据（会话 `712c4d0c`，1065 条事件）：此后 `u:895` 落在 `a:12`（17 段，
 * 插话前的生成）与 `a:12:2`（52 段，插话后的生成）之间；修前它排在 `a:12` **之前**。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";
import {
  applyNextStepSplice,
  claimedByNextStep,
  nextStepSpliceOf,
  type InboxState,
} from "../src/dsh/inboxClaim";
import type { MessageView } from "../src/shared/chat";
import type { HostToWebview } from "../src/shared/ipc";

/**
 * 收集帧并维护一份消息快照（与界面同一套归约）。
 *
 * 帧**深拷贝**再应用：真实链路上隔着 `postMessage` 的结构化克隆，共享引用会让适配器的
 * 原地修改与快照重复叠加，测出假阳性。
 */
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

/** 消息顺序的摘要：用户行按正文、助手行按 id。 */
function order(messages: MessageView[]): string[] {
  return messages.map((message) => (message.role === "user" ? `U:${message.text}` : `A:${message.id}`));
}

const turnStart = (seq: number, turn: number, time: number) =>
  ({ type: "turn/start", seq, time, data: { turn } }) as never;

const assistant = (seq: number, turn: number, step: number, text: string, time: number) =>
  ({
    type: "assistant/message",
    seq,
    time,
    data: {
      turn,
      step,
      message: { id: `m${seq}`, role: "assistant", content: [{ type: "text", text }] },
    },
  }) as never;

const human = (seq: number, id: string, text: string, time: number) =>
  ({
    type: "user/message",
    seq,
    time,
    data: { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
  }) as never;

/** 非人来源的注入（子代理 / 队列 / 运行时上下文都走这条），它们会开出一轮。 */
const injected = (seq: number, kind: string, text: string, time: number) =>
  ({
    type: "user/message",
    seq,
    time,
    data: { id: `i${seq}`, role: "user", content: [{ type: "text", text }], source: { kind } },
  }) as never;

/** 队列帧：插入（没有 `removedCount`）与领取（`removedCount > 0`）两半。 */
const splice = (seq: number, target: string, data: Record<string, unknown>, time: number) =>
  ({ type: "agent/inbox/spliced", seq, time, data: { target, start: 0, ...data } }) as never;

const T = Date.now();

// ---------- 1. 子代理开轮 + 本次领取：插话必须落在轮中间（本轮报告的那条） ----------

{
  const { adapter, messages } = harness();
  adapter.applyEvent(turnStart(1, 1, T));
  // 本轮**没有人发消息开启**：开轮的是子代理注入（真实日志里 turn 12 正是这样）
  adapter.applyEvent(injected(2, "agent-message", "子代理送来的消息", T + 1));
  adapter.applyEvent(assistant(3, 1, 0, "第一答", T + 2));
  // 人发消息：先进 next-step 队列（插入），再被下一步领取
  adapter.applyEvent(splice(4, "next-step", { inserted: [{ id: "u2" }] }, T + 3));
  adapter.applyEvent(splice(5, "next-step", { removedCount: 1, inserted: [] }, T + 4));
  adapter.applyEvent(human(6, "u2", "插一句", T + 5));
  adapter.applyEvent(assistant(7, 1, 1, "对插话的回答", T + 6));

  assert.deepStrictEqual(
    order(messages),
    ["A:a:1", "U:插一句", "A:a:1:2"],
    `插话必须留在它真正的时刻上（本轮顶部是「提问迟到」那条路，` +
      `子代理开轮时不能走），实际 ${JSON.stringify(order(messages))}`,
  );
  const part1 = messages.find((message) => message.id === "a:1");
  const part2 = messages.find((message) => message.id === "a:1:2");
  assert.ok(
    part1?.segments.some((segment) => segment.kind === "text" && segment.text === "第一答"),
    "插话前的生成留在第一段",
  );
  assert.ok(
    part2?.segments.some((segment) => segment.kind === "text" && segment.text === "对插话的回答"),
    "插话后的生成进新段（在插话下方）",
  );
}
console.log("steeringPlacement: 子代理开轮时插话落在轮中间 ✓");

// ---------- 2. 没有被领取的迟到提问：照旧插到本轮顶部 ----------

{
  const { adapter, messages } = harness();
  adapter.applyEvent(turnStart(1, 1, T));
  // 流式正文先落盘（真实服务端会在 turn/start 之后才给提问的 durable 事件）
  adapter.applyEvent(assistant(2, 1, 0, "先说话", T + 1));
  adapter.applyEvent(human(3, "u1", "本轮提问", T + 2));

  assert.deepStrictEqual(
    order(messages),
    ["U:本轮提问", "A:a:1"],
    `开启本轮的提问仍要插到轮首（这条没被领取，不是插话），实际 ${JSON.stringify(order(messages))}`,
  );
}
console.log("steeringPlacement: 迟到的本轮提问仍插到轮首 ✓");

// ---------- 2b. 插话落在一个**还没产出内容的空壳**上：不切段，也不留空行 ----------

{
  const { adapter, messages } = harness();
  adapter.applyEvent(turnStart(1, 1, T));
  // 模型还没吐任何东西（这一步在真实日志里约占插话的六分之一）：`turn/start`
  // 已经建出 a:1，但它是空的
  adapter.applyEvent(splice(2, "next-step", { inserted: [{ id: "u1" }] }, T + 1));
  adapter.applyEvent(splice(3, "next-step", { removedCount: 1, inserted: [] }, T + 2));
  adapter.applyEvent(human(4, "u1", "立刻插一句", T + 3));
  adapter.applyEvent(assistant(5, 1, 0, "对插话的回答", T + 4));

  assert.deepStrictEqual(
    order(messages),
    ["U:立刻插一句", "A:a:1"],
    `空壳上没有可留在上面的生成：插话落本轮顶部、内容仍进同一段，` +
      `实际 ${JSON.stringify(order(messages))}`,
  );
  assert.ok(
    messages.find((message) => message.id === "a:1")?.segments.some(
      (segment) => segment.kind === "text" && segment.text === "对插话的回答",
    ),
    "没有切段（切了会在气泡上方留一条只有时刻的空行）",
  );
}
console.log("steeringPlacement: 空壳上的插话不切段、不留空行 ✓");

// ---------- 3. 只有 next-step 的「本次领取」才算插话 ----------

{
  // next-turn 的领取不算（两类帧共用同一个队列索引空间，混着吃会把普通排队消息
  // 大面积误判成插话，实测 9.2% → 85%）
  let state: InboxState | undefined;
  state = applyNextStepSplice(state, { target: "next-turn", start: 0, removedCount: 1, inserted: [] });
  assert.strictEqual(state, undefined, "next-turn 的帧不进这台状态机");
  assert.strictEqual(claimedByNextStep(state, "u1"), false, "排队消息不是插话");

  // 取消的领取不算
  state = applyNextStepSplice(state, { target: "next-step", start: 0, inserted: [{ id: "u1" }] });
  state = applyNextStepSplice(state, {
    target: "next-step",
    start: 0,
    removedCount: 1,
    inserted: [],
    outcome: "canceled",
  });
  assert.strictEqual(claimedByNextStep(state, "u1"), false, "取消的领取不构成插话");

  // 领取是**本次**：下一批被领取时，上一批的 id 不再算
  state = applyNextStepSplice(state, { target: "next-step", start: 0, inserted: [{ id: "u1" }] });
  state = applyNextStepSplice(state, { target: "next-step", start: 0, removedCount: 1, inserted: [] });
  assert.strictEqual(claimedByNextStep(state, "u1"), true, "本次领取命中");
  state = applyNextStepSplice(state, { target: "next-step", start: 0, inserted: [{ id: "u2" }] });
  state = applyNextStepSplice(state, { target: "next-step", start: 0, removedCount: 1, inserted: [] });
  assert.strictEqual(claimedByNextStep(state, "u1"), false, "上一次领取的手下败将不再是插话");
  assert.strictEqual(claimedByNextStep(state, "u2"), true, "新的一批被领取");

  // 形状不可用的帧一律**不动状态**（不猜）
  assert.strictEqual(nextStepSpliceOf(null), undefined, "不是对象：不认");
  assert.strictEqual(nextStepSpliceOf({ target: "next-step", inserted: [] }), undefined, "没有数字 start：不认");
  const kept = applyNextStepSplice(state, { target: "next-step", inserted: [] });
  assert.strictEqual(kept, state, "形状不可用时原样返回上一次的状态");

  // 畸形元素**保留槽位**：丢掉会让后面的位次整体前移，领取就领错了人
  let slots: InboxState | undefined;
  slots = applyNextStepSplice(slots, {
    target: "next-step",
    start: 0,
    inserted: [{ id: "a" }, {}, { id: "c" }],
  });
  slots = applyNextStepSplice(slots, { target: "next-step", start: 1, removedCount: 1, inserted: [] });
  assert.strictEqual(claimedByNextStep(slots, "c"), false, "位次按原始槽位算（畸形元素不能挤掉它的位置）");
}
console.log("steeringPlacement: 只认 next-step 的本次领取 ✓");

// ---------- 4. 重放（跟随开窗 / 加载更早历史）与活路径同序，且重折后仍认得领取 ----------

{
  const events = [
    turnStart(1, 1, T),
    injected(2, "agent-message", "子代理送来的消息", T + 1),
    assistant(3, 1, 0, "第一答", T + 2),
    splice(4, "next-step", { inserted: [{ id: "u2" }] }, T + 3),
    splice(5, "next-step", { removedCount: 1, inserted: [] }, T + 4),
    human(6, "u2", "插一句", T + 5),
    assistant(7, 1, 1, "对插话的回答", T + 6),
  ];

  const live = harness();
  for (const event of events) live.adapter.applyEvent(event);

  // 重开窗口：这些事件整份经跟随开帧回放（`refold` 会把领取账本从头重建）
  const replay = harness();
  replay.adapter.applyFrame({
    type: "snapshot",
    cursor: 7,
    hasMore: false,
    records: events.map((event) => ({ type: "event", event })),
  } as never);

  assert.deepStrictEqual(
    order(replay.messages),
    order(live.messages),
    `重放必须给出与活路径同一个顺序，活=${JSON.stringify(order(live.messages))} ` +
      `重放=${JSON.stringify(order(replay.messages))}`,
  );

  // 回放之后再来的插话仍要认得（重折后的账本没有丢）
  replay.adapter.applyEvent(splice(8, "next-step", { inserted: [{ id: "u3" }] }, T + 7));
  replay.adapter.applyEvent(splice(9, "next-step", { removedCount: 1, inserted: [] }, T + 8));
  replay.adapter.applyEvent(human(10, "u3", "再插一句", T + 9));
  replay.adapter.applyEvent(assistant(11, 1, 2, "再答一句", T + 10));
  assert.deepStrictEqual(
    order(replay.messages),
    ["A:a:1", "U:插一句", "A:a:1:2", "U:再插一句", "A:a:1:3"],
    `重放之后的插话同样落在轮中间，实际 ${JSON.stringify(order(replay.messages))}`,
  );
}
console.log("steeringPlacement: 重放与活路径同序、重折后仍认得领取 ✓");

console.log("\nsteeringPlacement: all assertions passed");
