/**
 * 多窗口下「问卷 / 审批」的收场判据，以及 `@` 对话引用的接线。
 *
 * 用户 2026-09-15 报的现场：同一个会话在多个窗口打开时，其中一个窗口答了问卷，
 * 别的窗口照旧继续生成，**但那张问卷还停在页面上**（输入区被它占着）。
 *
 * 判据不能只看「本窗口有没有点过提交」。服务端有两条**与窗口无关**的权威信号：
 *
 * 1. `$events` 的 `cancel` 帧——网关 `finishRemoteEvent` 在请求被结算（另一个
 *    客户端答了 / 轮次中止 / Agent Context 释放）之后推给**所有还没答复的投递方**。
 *    收到它什么都不要回，只把本窗口那张卡收场。
 * 2. 会话日志里的工具结果——`ask_user_question` 的返回值就是
 *    `{answers:[{id,selected,custom?}]}`（`dsh-tool-ask-user` 的 `output.render`），
 *    与是哪个窗口答的无关。审批另有专门的审计对 `approval/asked` / `approval/decided`。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import type { MessageView, QuestionAnswerView, Segment } from "../src/shared/chat";
import type { HostToWebview } from "../src/shared/ipc";
import { isTakenOverByComposer, pendingInteractionOf } from "../src/webview/pendingInteraction";

const DRAFT = "src/webview/components/Composer.tsx";

/** 把帧折进一份消息列表（与 webview 的 reducer 同一批帧类型，够用即可）。 */
function harness() {
  const messages: MessageView[] = [];
  const adapter = new SessionAdapter((original) => {
    const frame = structuredClone(original) as HostToWebview;
    if (frame.type === "messages/reset") {
      messages.length = 0;
      messages.push(...frame.messages);
      return;
    }
    if (frame.type === "message/upsert") {
      const index = messages.findIndex((m) => m.id === frame.message.id);
      if (index < 0) messages.push(frame.message);
      else messages[index] = frame.message;
      return;
    }
    const applySegment = (messageId: string, segment: Segment) => {
      const target = messages.find((m) => m.id === messageId);
      if (!target) return;
      const index = target.segments.findIndex((s) => s.id === segment.id);
      if (index < 0) target.segments = [...target.segments, segment];
      else {
        target.segments = target.segments.slice();
        target.segments[index] = segment;
      }
    };
    if (frame.type === "message/append") applySegment(frame.messageId, frame.segment);
    else if (frame.type === "message/segment") applySegment(frame.messageId, frame.segment);
  });
  return { adapter, messages };
}

const questionSegment = (messages: MessageView[]): Extract<Segment, { kind: "question" }> | undefined =>
  messages.flatMap((m) => m.segments).find((s): s is Extract<Segment, { kind: "question" }> => s.kind === "question");

const approvalSegment = (messages: MessageView[]): Extract<Segment, { kind: "approval" }> | undefined =>
  messages.flatMap((m) => m.segments).find((s): s is Extract<Segment, { kind: "approval" }> => s.kind === "approval");

/** 两条题的问卷（答案要覆盖全部题目 id 才会被认领）。 */
const askTwo = (adapter: SessionAdapter, requestId = "ev-q1") =>
  adapter.addQuestion({
    requestId,
    items: [
      { id: "scope", question: "覆盖到哪一层？", options: [{ label: "只改入口文件" }, { label: "一起收敛" }] },
      { id: "docs", question: "要不要更新 README？", options: [{ label: "要" }, { label: "不要" }] },
    ],
    state: "waiting",
  });

const toolCall = (callId: string, name: string, seq: number) => ({
  type: "tool/call",
  seq,
  time: 1_700_000_000_000 + seq,
  data: { callId, name, arguments: "{}", turn: 0, step: 0 },
});

const toolResult = (callId: string, text: string, seq: number) => ({
  type: "tool/result",
  seq,
  time: 1_700_000_000_000 + seq,
  data: {
    message: {
      id: `r${seq}`,
      role: "assistant",
      content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }],
      source: { kind: "tool", callId },
    },
  },
});

// ---------- 1. 另一个窗口答了：本窗口收到 cancel → 卡片收场，不再占输入区 ----------
{
  const { adapter, messages } = harness();
  askTwo(adapter);
  assert.strictEqual(pendingInteractionOf(messages)?.kind, "question", "刚开始是待回答，接管输入区");

  adapter.cancelEvent("ev-q1");
  const segment = questionSegment(messages);
  assert.strictEqual(segment?.question.state, "cancelled", "Host 撤回 → cancelled（没人回答过）");
  assert.strictEqual(
    isTakenOverByComposer({ kind: "question", question: segment!.question }),
    false,
    "撤回之后必须把输入区让出来（这就是用户报的「问卷还停在页面上」）",
  );
  assert.strictEqual(pendingInteractionOf(messages), undefined, "不再是待处理交互");
}
console.log("interactionSync: cancel 帧收掉问卷 ✓");

// ---------- 1b. 先 cancel 后工具结果：状态要纠正回「已答完」并带上答案 ----------
//
// 另一个窗口答完的真实顺序就是这两步：网关先把请求撤回（本窗口只看到
// 「被撤回」），工具结果带着答案随后进会话日志。记录里不能一边写「已取消」
// 一边列着答案。
{
  const { adapter, messages } = harness();
  askTwo(adapter);
  adapter.cancelEvent("ev-q1");
  assert.strictEqual(questionSegment(messages)?.question.state, "cancelled", "撤回先到");
  adapter.applyEvent(toolCall("call_0", "ask_user_question", 1) as never);
  adapter.applyEvent(
    toolResult(
      "call_0",
      JSON.stringify({ answers: [{ id: "scope", selected: ["一起收敛"] }, { id: "docs", selected: ["要"] }] }),
      2,
    ) as never,
  );
  const segment = questionSegment(messages);
  assert.strictEqual(segment?.question.state, "answered", "答案到了就是答过了，不能停在 cancelled");
  assert.deepStrictEqual(segment?.question.answers?.scope, { selected: ["一起收敛"] });
}
console.log("interactionSync: cancel 之后补上答案 → 纠正为已答完 ✓");

// ---------- 2. 会话日志里的工具结果 = 权威答案，并且回填到卡片上 ----------
{
  const { adapter, messages } = harness();
  askTwo(adapter);
  // 顺序与真实一致：tool/call 先到（卡片是本窗口的 waterfall 建的），
  // 结果带着答案回来——**不论谁答的**都会走这里
  adapter.applyEvent(toolCall("call_1", "ask_user_question", 1) as never);
  adapter.applyEvent(
    toolResult(
      "call_1",
      JSON.stringify({
        answers: [
          { id: "scope", selected: ["一起收敛"] },
          { id: "docs", selected: [], custom: "顺手把分节标题也统一一下" },
        ],
      }),
      2,
    ) as never,
  );
  const segment = questionSegment(messages);
  assert.strictEqual(segment?.question.state, "answered", "工具结果一到就收场（不看本窗口点没点过提交）");
  const answers = (segment?.question.answers ?? {}) as Record<string, QuestionAnswerView>;
  assert.deepStrictEqual(answers.scope, { selected: ["一起收敛"] }, "选项答案回填到卡片（展开记录要显示它）");
  assert.deepStrictEqual(
    answers.docs,
    { selected: [], custom: "顺手把分节标题也统一一下" },
    "自定义回答同样回填",
  );
}
console.log("interactionSync: 工具结果回填答案并收场 ✓");

// ---------- 3. 重投递的顺序反过来（先结果后卡片）：卡片直接建成已答完 ----------
{
  const { adapter, messages } = harness();
  adapter.applyEvent(toolCall("call_2", "ask_user_question", 1) as never);
  adapter.applyEvent(
    toolResult(
      "call_2",
      JSON.stringify({ answers: [{ id: "scope", selected: ["只改入口文件"] }, { id: "docs", selected: ["要"] }] }),
      2,
    ) as never,
  );
  // 水瀑此时才重投递：不能又弹一张「待回答」的卡
  askTwo(adapter);
  const segment = questionSegment(messages);
  assert.strictEqual(segment?.question.state, "answered", "答案先到、卡片后建 → 直接是已答完");
  assert.deepStrictEqual(segment?.question.answers?.docs, { selected: ["要"] });
  assert.strictEqual(pendingInteractionOf(messages), undefined, "不会再占住输入区");
}
console.log("interactionSync: 重投递顺序颠倒也不弹过期问卷 ✓");

// ---------- 4. 不相关的工具结果不能被当成答案 ----------
{
  const { adapter, messages } = harness();
  askTwo(adapter);
  adapter.applyEvent(toolCall("call_3", "read", 1) as never);
  adapter.applyEvent(toolResult("call_3", '{"answers":[{"id":"x","selected":["y"]}]}', 2) as never);
  assert.strictEqual(
    questionSegment(messages)?.question.state,
    "waiting",
    "只有 ask_user_question 的结果才算答案（别的工具恰好返回同形状 JSON 也不能认领）",
  );
  // 答案不覆盖全部题目 id 时也不认领（跟随窗口里可能混着更早一轮的提问结果）
  adapter.applyEvent(toolCall("call_4", "ask_user_question", 3) as never);
  adapter.applyEvent(
    toolResult("call_4", JSON.stringify({ answers: [{ id: "scope", selected: ["一起收敛"] }] }), 4) as never,
  );
  assert.strictEqual(questionSegment(messages)?.question.state, "waiting", "答案不覆盖全部题目 → 不认领");
}
console.log("interactionSync: 不误认领无关结果 ✓");

// ---------- 5. 本窗口自己提交：宿主立刻把答案写进卡片 ----------
{
  const { adapter, messages } = harness();
  askTwo(adapter, "ev-q2");
  adapter.resolveQuestion("ev-q2", { scope: { selected: ["一起收敛"] }, docs: { custom: "写一段就行" } });
  const segment = questionSegment(messages);
  assert.strictEqual(segment?.question.state, "answered");
  assert.strictEqual(segment?.question.answers?.docs?.custom, "写一段就行", "展开记录要显示用户写下的自定义回答");
  assert.strictEqual(isTakenOverByComposer({ kind: "question", question: segment!.question }), false);
}
console.log("interactionSync: 本窗口提交后记录里有答案 ✓");

// ---------- 6. 审批：会话日志的 approval/decided 按 callId 收场 ----------
{
  const { adapter, messages } = harness();
  adapter.addApproval({ requestId: "ev-a1", toolName: "pwsh", callId: "call_9", state: "waiting" });
  assert.strictEqual(pendingInteractionOf(messages)?.kind, "approval", "待审批接管输入区");

  adapter.applyEvent({
    type: "approval/asked",
    seq: 1,
    time: 1,
    data: { id: "ap-1", toolName: "pwsh", callId: "call_9" },
  } as never);
  adapter.applyEvent({
    type: "approval/decided",
    seq: 2,
    time: 2,
    data: { id: "ap-1", outcome: "rejected" },
  } as never);
  assert.strictEqual(approvalSegment(messages)?.approval.state, "rejected", "另一个窗口拒绝 → 本窗口跟着收场");
  assert.strictEqual(pendingInteractionOf(messages), undefined, "不再占输入区");

  // 三档 outcome 的映射：allowed-once → approved，其余（cancelled / unavailable）→ expired
  for (const [outcome, expected] of [
    ["allowed-once", "approved"],
    ["cancelled", "expired"],
    ["unavailable", "expired"],
  ] as const) {
    const one = harness();
    one.adapter.addApproval({ requestId: "ev-a2", toolName: "pwsh", callId: "call_8", state: "waiting" });
    one.adapter.applyEvent({
      type: "approval/asked",
      seq: 1,
      time: 1,
      data: { id: "ap-2", toolName: "pwsh", callId: "call_8" },
    } as never);
    one.adapter.applyEvent({
      type: "approval/decided",
      seq: 2,
      time: 2,
      data: { id: "ap-2", outcome },
    } as never);
    assert.strictEqual(
      approvalSegment(one.messages)?.approval.state,
      expected,
      `outcome=${outcome} 要映射成 ${expected}（契约里的四个收场值）`,
    );
  }

  // Host 撤回（另一个窗口答了 / 轮次中止）→ expired
  const cancelled = harness();
  cancelled.adapter.addApproval({ requestId: "ev-a3", toolName: "pwsh", callId: "call_7", state: "waiting" });
  cancelled.adapter.cancelEvent("ev-a3");
  assert.strictEqual(approvalSegment(cancelled.messages)?.approval.state, "expired", "撤回的审批标 expired");
  assert.strictEqual(pendingInteractionOf(cancelled.messages), undefined);
}
console.log("interactionSync: 审批按 approval/decided 与撤回收场 ✓");

// ---------- 7. 结构不变量：宿主真的接了这两条信号 ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /if \(frame\.type === "cancel"\) \{/.test(controller) && /this\.cancelHeldEvent\(frame\.eventId\)/.test(controller),
    "$events 的 cancel 帧必须被处理（这是「另一个窗口答了」的权威信号）",
  );
  assert.ok(
    /this\.heldEvents\.delete\(eventId\)/.test(controller),
    "还挂着的请求被撤回时要直接丢掉——否则用户下次打开会话会凭空弹一张过期的卡",
  );
  assert.ok(
    /answersByQuestionId\(message\.answers\)/.test(controller),
    "本窗口提交后要立刻把答案写进卡片（展开记录靠它）",
  );

  const protocol = readFileSync(join(process.cwd(), "src", "dsh", "protocol.ts"), "utf8");
  assert.ok(
    /\{ type: "cancel"; eventId: string \}/.test(protocol),
    "线格式类型里要有 cancel 帧（网关 parseRemoteEventFrame 的契约）",
  );

  const adapter = readFileSync(join(process.cwd(), "src", "dsh", "adapter.ts"), "utf8");
  assert.ok(/case "approval\/decided":/.test(adapter), "adapter 要消费 approval/decided");
  assert.ok(
    /if \(toolName === "ask_user_question"\) this\.applyQuestionAnswers\(text\)/.test(adapter),
    "adapter 要在问卷工具的结果上取答案",
  );
}
console.log("interactionSync: 宿主侧接线正确 ✓");

// ---------- 8. `@` 对话引用：候选一起取、选中插入 mention ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /"sessionReferenceResolver\/candidates"/.test(controller),
    "对话候选要取官方的 sessionReferenceResolver/candidates（与 Web 同一个数据源）",
  );
  assert.ok(
    /Promise\.all\(/.test(controller) && /queryFiles/.test(controller),
    "文件与对话候选并行取（与官方 reference 源同构）",
  );

  const composer = readFileSync(join(process.cwd(), DRAFT), "utf8");
  assert.ok(
    /const sessions: MentionCandidate\[\] = state\.fileRefs\.sessions/.test(composer),
    "界面要把对话候选接进同一个候选列表",
  );
  assert.ok(
    /if \(isSessionCandidate\(candidate\)\) \{/.test(composer) && /insertMentionText\(mention\)/.test(composer),
    "选中对话候选要把服务端铸好的 mention 插进正文",
  );
  assert.ok(
    /texts\.mentionSessions/.test(composer),
    "对话候选要有自己的分组标题（词典 key，中英各一份）",
  );

  const ipc = readFileSync(join(process.cwd(), "src", "shared", "ipc.ts"), "utf8");
  assert.ok(/sessions\?: SessionRefView\[\]/.test(ipc), "files/list 帧要带上对话候选");
}
console.log("interactionSync: @ 对话引用的接线 ✓");

console.log("\ninteractionSync: all assertions passed");
