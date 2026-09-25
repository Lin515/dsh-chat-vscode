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
import { PendingInteractions, type HeldInteraction } from "../src/dsh/pendingInteractions";
import type { MessageView, QuestionAnswerView, Segment } from "../src/shared/chat";
import type { HostToWebview } from "../src/shared/ipc";
import { resolveInteractions } from "../src/webview/pendingInteraction";
import { dictionaryFor } from "../src/webview/texts";

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

const toolCall = (callId: string, name: string, seq: number, args = "{}") => ({
  type: "tool/call",
  seq,
  time: 1_700_000_000_000 + seq,
  data: { callId, name, arguments: args, turn: 0, step: 0 },
});

/**
 * `ask_user_question` 的**真实**调用参数与结果正文（形状逐字取自 harness 的真实会话日志：
 * `dsh-tool-ask-user` 的参数是下划线 `multi_select`，结果正文是 `{answers:[…]}` 的 JSON）。
 */
const askArgs = (questions: unknown[]) => JSON.stringify({ questions });
const askAnswers = (answers: unknown[]) => JSON.stringify({ answers });

/** 按段 id 取工具段（`tool:<callId>`）。 */
const toolSegmentById = (messages: MessageView[], segmentId: string) =>
  messages
    .flatMap((m) => m.segments)
    .find((s): s is Extract<Segment, { kind: "tool" }> => s.kind === "tool" && s.id === segmentId);

const toolResult = (callId: string, text: string, seq: number, error?: { name: string; code: string }) => ({
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
    ...(error ? { error } : {}),
  },
});

// ---------- 1. 另一个窗口答了：本窗口收到 cancel → 卡片收场，不再占输入区 ----------
{
  const { adapter, messages } = harness();
  askTwo(adapter);
  assert.strictEqual(resolveInteractions(messages).pending?.kind, "question", "刚开始是待回答，接管输入区");

  adapter.cancelEvent("ev-q1");
  const segment = questionSegment(messages);
  assert.strictEqual(segment?.question.state, "cancelled", "Host 撤回 → cancelled（没人回答过）");
  const taken = resolveInteractions(messages).takenOver;
  assert.strictEqual(
    taken.size,
    0,
    "撤回之后必须把输入区让出来（这就是用户报的「问卷还停在页面上」）",
  );
  assert.ok(
    !taken.has(segment!.id),
    "撤回的那一段也不该再从流里撤下（按段 id 判，它要留在流里当记录）",
  );
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "不再是待处理交互");
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
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "不会再占住输入区");
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
  const taken = resolveInteractions(messages).takenOver;
  assert.strictEqual(taken.size, 0, "答完之后那段不再由输入区渲染（它留在流里当记录）");
  assert.ok(!taken.has(segment!.id), "按段 id 判：没有待处理交互时一段都不撤");
}
console.log("interactionSync: 本窗口提交后记录里有答案 ✓");

// ---------- 6. 审批：会话日志的 approval/decided 按 callId 收场 ----------
{
  const { adapter, messages } = harness();
  adapter.addApproval({ requestId: "ev-a1", toolName: "pwsh", callId: "call_9", state: "waiting" });
  assert.strictEqual(resolveInteractions(messages).pending?.kind, "approval", "待审批接管输入区");

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
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "不再占输入区");

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
  assert.strictEqual(resolveInteractions(cancelled.messages).pending, undefined);
}
console.log("interactionSync: 审批按 approval/decided 与撤回收场 ✓");

// ---------- 7. 结构不变量：宿主真的接了这两条信号 ----------
//
// 这一节只剩**确实只能在源码层表达**的接线（`$events` 的帧分支、IPC 类型、
// adapter 的分支名）——它们没有可调用的 API 接缝。请求本身的记账规则（去重 /
// 回放不删 / 结算才删）已经搬进 `src/dsh/pendingInteractions.ts`，断言改在
// `scripts/pendingInteractions.test.ts` 里**调用真 API**，不再对 5000 行的
// `controller.ts` 做字符切片。
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /if \(frame\.type === "cancel"\) \{/.test(controller) &&
      /this\.interactions\.withdraw\(frame\.eventId\)/.test(controller),
    "$events 的 cancel 帧必须被处理（「另一个窗口答了」的权威信号）——" +
      "而且要走账本的撤回出口，不能只把界面上的卡收掉、账还挂着",
  );
  assert.ok(
    /answersByQuestionId\(message\.answers\)/.test(controller),
    "本窗口提交后要立刻把答案写进卡片（展开记录靠它）",
  );
  // 「回放」这个动作本身只能在源码层确认：它是 `bindViewToSession` 里的一次调用
  // （域的生命周期要真宿主才跑得起来）。`forSession` 是读、条目不删，由
  // `pendingInteractions.test.ts` 的真 API 断言钉住。
  assert.ok(
    /this\.replayHeldToScope\(sessionId, scope\);/.test(controller),
    "绑定窗口时必须回放未结算的审批/提问——用户切回来的那一刻卡片要回来",
  );
  // 建域时**不**回放：那一刻还没有窗口绑上来，投递出去没人收
  const ensureStart = controller.indexOf("private ensureScope(");
  const ensure = controller.slice(ensureStart, controller.indexOf("private ensureDefaultsApplied(", ensureStart));
  assert.ok(ensureStart > 0, "取不到 ensureScope");
  assert.ok(!/interactions\./.test(ensure), "ensureScope 不该回放（域建成时还没有窗口绑定）");

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

// ---------- 8. `@` 对话引用：两个源并行取、各自发帧，选中插入 mention ----------
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
  const ipc = readFileSync(join(process.cwd(), "src", "shared", "ipc.ts"), "utf8");
  assert.ok(
    /\{ type: "files\/list"; query: string; items: FileRefView\[\] \}/.test(ipc) &&
      /\{ type: "files\/sessions"; query: string; sessions: SessionRefView\[\] \}/.test(ipc),
    "文件与对话候选要分成两条帧（各自带 query，界面按它丢旧批次）",
  );
  assert.ok(
    /this\.menuQueries\.get\(viewId\)\?\.abort\(\)/.test(controller) &&
      /isCurrentMenuQuery\(viewId, controller\)/.test(controller),
    "每一次 @ 候选查询都要作废上一次（官方 stopFetch 同款；不作废就是十次全语料扫描 + 旧盖新）",
  );

  // 界面侧那三样（候选进同一条列表 / mention 插入 / 分组标题）**不再 grep Composer 源码**：
  // 规则已经搬进 `src/webview/composerCompletion.tsx`，直接调它 + 用词典断言
  // （理由见仓库结论：测试面不该是文件字符）。它连带 `bridge.ts` 会在模块求值期挂
  // `window.addEventListener`，所以先补桩再**动态** import（同 `questionRender.test.ts`）。
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const { candidateRows, isSessionCandidate, rankCandidates } = await import(
    "../src/webview/composerCompletion"
  );
  const fileCandidate = { path: "src/a.ts", kind: "file" as const };
  const sessionCandidate = {
    sessionId: "s1",
    label: "s1",
    mention: "@[s1](dsh-session:s1)",
  };
  const ranked = rankCandidates(
    { kind: "mention", start: 0, query: "" },
    [],
    [fileCandidate],
    [sessionCandidate],
  );
  assert.deepStrictEqual(
    [ranked.length, isSessionCandidate(ranked[0]), isSessionCandidate(ranked[1])],
    [2, false, true],
    "界面要把对话候选接进同一个候选列表（文件在前、对话在后，与官方 reference 源同序）",
  );
  assert.ok(
    sessionCandidate.mention.startsWith("@["),
    "选中对话候选插入的是服务端铸好的 mention（`@[标题](dsh-session:…)`）",
  );
  const rows = candidateRows(ranked, "mention", {
    mentionFiles: "文件",
    mentionSessions: "对话",
    commands: "命令",
  });
  assert.strictEqual(rows[1].section, "对话", "对话候选要有自己的分组标题（词典 key，中英各一份）");
  assert.strictEqual(rows[1].showSection, true, "换了分组要显示分组标题");
  assert.strictEqual(dictionaryFor("zh").mentionSessions, "对话");
  assert.strictEqual(dictionaryFor("en").mentionSessions, "Sessions");
}
console.log("interactionSync: @ 对话引用的接线 ✓");

// ---------- 9. 切走再切回来，还没答复的问卷/审批必须回到页面上 ----------
//
// 用户 2026-09-15 报的现场：正在等问卷的时候切去看历史会话（或别的页面），
// 回来时卡片没了，agent 永久卡在 ask 节点——只能中断重问。
//
// 根因是**请求的存放位置**：`addQuestion` / `addApproval` 把卡片放进域（scope）的
// 适配器里，而切会话会 `dropViewers` → `destroyScope` 把整个适配器回收；审批/提问
// **不是 durable 事件**（会话日志里没有它们），重放不回，于是只存在于被回收的适配器里
// 的那份请求就永久丢了。修法是把「还没结算的审批/提问」留在宿主的账本里，直到有人
// 答复（`answerApproval` / `answerQuestion`）、用户自己撤回（`cancelQuestion`，
// 计划审阅卡的「去聊天里说」）或 Host 撤回（`cancel` 帧），并在**有窗口绑上这个会话**
// 时回放。
//
// 账本从 `controller.ts` 的 `heldEvents` / `eventSessions` / `handledEvents` 收成了
// `src/dsh/pendingInteractions.ts` 的 `PendingInteractions`。所以这一节改成两步：
//
//   (a) **调真 API** 钉住账本自己的生命周期（回放不删、结算才删、只按会话分桶）；
//   (b) 源码层**只留确实只能在那里表达的**接线（4 个结算点挂在哪、建域时不回放）。
//
// 改造前这里是「读 5000 行源码 → 找字符串位置 → 数 `this.heldEvents.delete(` 出现几次」，
// 改个注释或挪一行就假红/假绿（AGENTS.md「断言只钉确定的事实」）。
{
  // ---------- (a) 账本的生命周期（真 API） ----------
  const ledger = new PendingInteractions();
  const held: HeldInteraction = {
    eventId: "ev-held",
    kind: "approval",
    sessionId: "s1",
    request: { toolName: "pwsh", callId: "call_1" },
  };
  assert.strictEqual(ledger.hold(held), "new", "第一次收下一条请求");
  assert.strictEqual(ledger.hold(held), "duplicate", "同一条重投递只收一次（重连/窗口重载都会重投）");

  // 切走再切回来 = 对同一个会话连续回放两次；卡片必须都还在（回放是读，不删条目）
  assert.deepStrictEqual(ledger.forSession("s1"), [held], "回放要把未结算的条目交出来");
  assert.deepStrictEqual(ledger.forSession("s1"), [held], "第二次回放同一条（切走又切回来）");
  assert.deepStrictEqual(ledger.forSession("s2"), [], "别的会话不拿这条");
  assert.ok(ledger.hasSeen("ev-held"), "重投递判据在回放之后依然成立");

  // Host 撤回（cancel 帧）是**结算**：之后不再回放，而且调用方拿到原始请求去收场卡片
  assert.deepStrictEqual(ledger.withdraw("ev-held"), held, "撤回要把那条记录交还给调用方");
  assert.deepStrictEqual(ledger.forSession("s1"), [], "撤回之后不再回放（否则下次打开会话弹一张过期的卡）");
  assert.strictEqual(ledger.withdraw("ev-held"), undefined, "再撤一次是空操作");

  // 结算之后**重投递**不能被重新收下：账目的是「这次询问结束了」，与服务端还会不会
  // 重投递无关（结算掉的那条留着会让卡片「回来了」并永远占着输入区）
  assert.strictEqual(ledger.hold(held), "duplicate", "结算过的 eventId 仍然算「见过」");

  // 只有 4 个结算点：本窗口答复两处 + 用户自己撤回一处 + Host 撤回一处。
  // 这一条**只能在源码层表达**（控制器起不来，它要 vscode + 一个真连接），所以按
  // 「调用点的条数」数——不按变量的拼写，改个局部名不该让它假红。
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const settleCalls = controller.match(/this\.interactions\.settle\(/g) ?? [];
  const withdrawCalls = controller.match(/this\.interactions\.withdraw\(/g) ?? [];
  assert.strictEqual(
    settleCalls.length + withdrawCalls.length,
    4,
    `结算点应当正好 4 处（answerApproval / answerQuestion / cancelQuestion 各一次 settle，` +
      `cancel 帧一次 withdraw），现在是 ${settleCalls.length} + ${withdrawCalls.length}——` +
      "少一处会让卡片永远复原不回来，多一处会让它在切回来时丢",
  );
  assert.ok(
    /case "answerApproval":[\s\S]{0,300}?this\.interactions\.settle\(eventId\)/.test(controller) &&
      /case "answerQuestion":[\s\S]{0,300}?this\.interactions\.settle\(eventId\)/.test(controller),
    "本窗口答复后要结算掉（否则下次切回来会弹一张已经答过的卡）",
  );
  // 用户自己撤回（计划审阅卡的「去聊天里说」）同样是一次结算：请求已经回掉了
  assert.ok(
    /case "cancelQuestion":[\s\S]{0,500}?this\.interactions\.settle\(eventId\)/.test(controller),
    "用户撤回也要结算掉——留着它下次切回会话会凭空弹一张过期的计划审阅卡",
  );
}
console.log("interactionSync: 未结算的问卷/审批随「绑定窗口」回放 ✓");

// ---------- 9b. 同一张审批卡重复投递不画两遍 ----------
//
// 回放的落点是适配器，而 `addApproval` 原先无条件 push 一个新段：第二个窗口绑上
// 同一个会话（或切走再切回）就会画出两张一模一样的审批卡，两张还都得分别答复。
// 问卷那边本来就有 existing 分支，审批这里补齐同口径。
{
  const { adapter, messages } = harness();
  // 每步都**重新取一遍**段：`message/segment` 在 reducer 里是替换成新对象，
  // 抓住旧引用会读到过期状态（自己踩过）
  const approvalsNow = () =>
    messages
      .flatMap((m) => m.segments)
      .filter((s): s is Extract<Segment, { kind: "approval" }> => s.kind === "approval");

  adapter.addApproval({ requestId: "ev-a9", toolName: "pwsh", callId: "call_9", state: "waiting" });
  adapter.addApproval({ requestId: "ev-a9", toolName: "pwsh", callId: "call_9", state: "waiting" });
  assert.strictEqual(approvalsNow().length, 1, "同一个 requestId 重投递只能有一张卡");

  // 已经收场的那张不能被重投递改回 waiting
  adapter.resolveApproval("ev-a9", "approved");
  adapter.addApproval({ requestId: "ev-a9", toolName: "pwsh", callId: "call_9", state: "waiting" });
  assert.strictEqual(approvalsNow()[0].approval.state, "approved", "已答完的审批不能被重投递改回等待");
  assert.strictEqual(approvalsNow().length, 1, "重投递也不该再加一张");
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "也不会重新占住输入区");
}
console.log("interactionSync: 审批卡重复投递去重 ✓");

// ---------- 9c. 重折（跟随快照 / 重连 / 加载更早）不能吃掉还没答复的卡片 ----------
//
// 上一组钉的是「请求留在宿主手里」；这一组钉的是**卡片重建之后又被打回来**的那一步：
// 审批 / 提问不是 durable 事件（会话日志里没有），而 `refold()` 会把消息流整体折成
// 会话日志的产物 —— 宿主 `replayHeldToScope` 是紧跟 `ensureScope` 同步跑的，跟随流
// 那份 `snapshot` 要等一个网络往返才到，到了就把整袋消息重折一遍，刚补回来的卡片
// 正好被折掉。用户 2026-09-15 在上一轮修复之后仍然报「切走再切回来问卷不见了」，
// 以及「VSCode 窗口重载后问卷丢了」，同一条路径（重载 = 重连 + 服务端重投递水瀑）。
{
  const { adapter, messages } = harness();
  const t = Date.now();
  /** 一轮已经结束的会话：重折时消息会被整袋重建，卡片只能靠锚点补回来。 */
  const endedTurn = (): unknown[] => [
    { type: "event", event: { type: "turn/start", seq: 1, time: t, data: { turn: 1 } } },
    {
      type: "event",
      event: {
        type: "assistant/message",
        seq: 2,
        time: t + 1,
        data: {
          turn: 1,
          step: 0,
          message: { id: "m1", role: "assistant", content: [{ type: "text", text: "我看看" }] },
        },
      },
    },
    { type: "event", event: { type: "turn/end", seq: 3, time: t + 2, data: { turn: 1, reason: { kind: "stop" } } } },
  ];
  const reopen = () =>
    adapter.applyFrame({ type: "snapshot", cursor: 3, hasMore: false, records: endedTurn() } as never);

  reopen();
  askTwo(adapter);
  adapter.addApproval({ requestId: "ev-a10", toolName: "pwsh", callId: "call_10", state: "waiting" });
  assert.ok(questionSegment(messages), "先确认问卷卡已经在页面上");
  assert.ok(approvalSegment(messages), "审批卡同理");

  // 再开一次窗（socket 重连 / 切走再切回来 / 窗口重载后服务端重投递）
  reopen();

  const question = questionSegment(messages);
  assert.ok(question, "重折之后待答问卷必须还在——不在就是「agent 永久卡在 ask 节点」");
  assert.strictEqual(question!.question.state, "waiting", "重折不该改动它的状态");
  assert.strictEqual(resolveInteractions(messages).pending?.kind, "question", "它仍然接管输入区");
  assert.ok(
    resolveInteractions(messages).takenOver.has(question!.id),
    "接管输入区的是**那一段**本身（takenOver 的键是段 id）——它才该从流里撤下",
  );
  const approval = approvalSegment(messages);
  assert.ok(approval, "审批卡同样不能被重折吃掉");
  assert.strictEqual(approval!.approval.state, "waiting", "审批的状态也不该被改动");
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.kind === "question").length,
    1,
    "补回来的是同一张卡，不能变成两张",
  );

  // 答完之后再重折：补回来的是**记录**（带答案），不能又变回一张等答复的卡
  adapter.resolveQuestion("ev-q1", { scope: { selected: ["一起收敛"] }, docs: { selected: ["要"] } });
  adapter.resolveApproval("ev-a10", "approved");
  reopen();
  const answered = questionSegment(messages);
  assert.strictEqual(answered?.question.state, "answered", "已答完的问卷重折后仍是记录");
  assert.deepStrictEqual(
    answered?.question.answers?.scope,
    { selected: ["一起收敛"] },
    "记录里要留着用户当时选了什么（重折不能把答案抹掉）",
  );
  assert.strictEqual(approvalSegment(messages)?.approval.state, "approved", "已收场的审批同理");
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "收场之后不再占输入区");
}
console.log("interactionSync: 重折（快照/重连/重载）后待答卡片仍在 ✓");

// ---------- 9d. 重投递落到**另一条**消息上，也不能变成两张卡 ----------
//
// 去重不能只看「当前回合那条消息」：请求重投时那个回合往往早已结束，而
// `ensureAssistantMessage` 给出的是**新回合**的消息——在那里找不到旧卡就会
// 再画一张，而旧的那张永远没人点（多窗口 / 重连后重投递都会走到这里）。
{
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } } as never);
  adapter.addApproval({ requestId: "ev-a11", toolName: "pwsh", callId: "call_11", state: "waiting" });
  askTwo(adapter, "ev-q11");
  const ownerOf = (id: string) =>
    messages.find((m) => m.segments.some((s) => s.id === id))?.id;
  assert.strictEqual(ownerOf("ap:ev-a11"), "a:1", "卡片落在第 1 轮的助手消息上");
  assert.strictEqual(ownerOf("q:ev-q11"), "a:1", "问卷同理");

  // 这一轮结束、下一轮开始（并且没有重折）：重投递落到新回合的消息上
  adapter.applyEvent({ type: "turn/end", seq: 2, time: t + 1, data: { turn: 1, reason: { kind: "stop" } } } as never);
  adapter.applyEvent({ type: "turn/start", seq: 3, time: t + 2, data: { turn: 2 } } as never);
  adapter.addApproval({ requestId: "ev-a11", toolName: "pwsh", callId: "call_11", state: "waiting" });
  askTwo(adapter, "ev-q11");

  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.id === "ap:ev-a11").length,
    1,
    "重投递的审批仍然只有一张卡",
  );
  assert.strictEqual(ownerOf("ap:ev-a11"), "a:1", "而且是原来那张（不搬家）");
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.id === "q:ev-q11").length,
    1,
    "问卷同理：重投递不能变成两张",
  );
  assert.strictEqual(ownerOf("q:ev-q11"), "a:1", "问卷也不搬家");
}
console.log("interactionSync: 跨消息的重投递去重 ✓");

// ---------- 10. 问卷记录挂在 `ask_user_question` 工具节点上（会话重载后必须还在） ----------
//
// 用户 2026-09-24 报的现场：会话重载之后**答过的问卷节点整个消失**，只剩一个
// `ask_user_question` 工具行，展开是「输入 = 问句 JSON / 输出 = 答案 JSON」。
//
// 根因：那张卡只由 waterfall 建（`addQuestion`），而 waterfall **不是 durable 事件**
// （会话日志里没有它）——重载后跟随流只重放日志，卡片折不出来；`interactionCards`
// 只救得回同一个适配器实例里的那一次重折。
//
// 修法（用户口径：把答案和问卷合并）：题目取自**调用参数**、答案取自**工具结果**，
// 两份都是 durable 事件，记录直接画在那个工具节点上——于是重载后自然还在，
// 而且不用再单独开一个节点。
//
// 题目与答案逐字取自真实日志（`dsh-tool-ask-user` 的参数是下划线 `multi_select`，
// 结果正文是 `{answers:[…]}`；见 harness 的 `snapshots/web/question-composer`）。
const ASK_QUESTIONS = [
  {
    id: "color",
    question: "Which color do you prefer?",
    header: "Pick one",
    multi_select: true,
    options: [
      {
        label: "Blue",
        description: "A cool recessive hue that reads as calm and trustworthy in long reading sessions and dense dashboards.",
      },
      {
        label: "Green",
        description: "A restful mid-spectrum hue with the highest perceived brightness, easiest on the eye over long sessions.",
      },
    ],
  },
  { id: "notes", question: "要不要同时补测试？", header: "回归", options: [{ label: "要" }, { label: "不要" }] },
];
const ASK_RESULT = [
  { id: "color", selected: ["Blue"], custom: "Include accessibility notes" },
  { id: "notes", selected: ["要"] },
];

/** 一组测试题目（与 ASK_QUESTIONS 同 id）——用来建本窗口那张待答卡。 */
const askCard = (adapter: SessionAdapter, requestId: string) =>
  adapter.addQuestion({
    requestId,
    items: ASK_QUESTIONS.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options,
      ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select === true }),
    })),
    state: "waiting",
  });

{
  // (a) **只有 durable 事件**（重载后的样子：跟随流重放日志，没有 waterfall）
  const { adapter, messages } = harness();
  adapter.applyEvent(toolCall("q1", "ask_user_question", 1, askArgs(ASK_QUESTIONS)) as never);
  adapter.applyEvent(toolResult("q1", askAnswers(ASK_RESULT), 2) as never);

  const tool = toolSegmentById(messages, "tool:q1");
  assert.strictEqual(
    tool?.tool.question?.state,
    "answered",
    "重载（只重放会话日志）之后，问卷记录必须挂在 ask_user_question 节点上——" +
      "它不在了就是用户 2026-09-24 报的「问卷回答节点消失」",
  );
  assert.strictEqual(tool?.tool.question?.items.length, 2, "题目取自调用参数（含标题与选项）");
  assert.strictEqual(
    tool?.tool.question?.items[0]?.multiSelect,
    true,
    "参数里的 `multi_select` 要折成视图里的 `multiSelect`",
  );
  assert.deepStrictEqual(
    tool?.tool.question?.answers?.color,
    { selected: ["Blue"], custom: "Include accessibility notes" },
    "答案取自工具结果（含自定义回答）",
  );
  assert.deepStrictEqual(tool?.tool.question?.answers?.notes, { selected: ["要"] });
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.kind === "question").length,
    0,
    "不另外开一个问卷节点：记录就在工具节点里",
  );
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "已收场，不占输入区");

  // 迟到的重放（同一条 `tool/call` 又到一次）不能把已结算的记录改写回「运行中」
  adapter.applyEvent(toolCall("q1", "ask_user_question", 3, askArgs(ASK_QUESTIONS)) as never);
  assert.strictEqual(
    toolSegmentById(messages, "tool:q1")?.tool.question?.state,
    "answered",
    "重复的 tool/call 不清掉已折出来的记录",
  );

  // 顺序颠倒（服务端先给结果、waterfall 后到）：记录已经在工具节点上，不能再开一条
  // 独立段、也不能重新占住输入区（旧那段「答案先到、卡片后建 → 直接建成已答完」的
  // 口径现在由工具节点承担）
  askCard(adapter, "ev-q1");
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.kind === "question").length,
    0,
    "结果先到、waterfall 后到 → 记录仍在工具节点上，不再开一条段",
  );
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "也不会重新占住输入区");
}
console.log("interactionSync: 只重放 durable 事件也有问卷记录（重载后节点不消失） ✓");

{
  // (b) 本窗口答复 → 独立那一段退出消息流，记录并进工具节点
  const { adapter, messages } = harness();
  adapter.applyEvent(toolCall("q2", "ask_user_question", 1, askArgs(ASK_QUESTIONS)) as never);
  askCard(adapter, "ev-q2");
  assert.strictEqual(resolveInteractions(messages).pending?.kind, "question", "答复前由输入区接管");
  assert.ok(questionSegment(messages), "答复前那张卡在流里（等待态）");

  adapter.resolveQuestion("ev-q2", {
    color: { selected: ["Blue"], custom: "Include accessibility notes" },
    notes: { selected: ["要"] },
  });

  const tool = toolSegmentById(messages, "tool:q2");
  assert.strictEqual(tool?.tool.question?.state, "answered", "本窗口答复后记录写进工具节点");
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.kind === "question").length,
    0,
    "原来那条独立问卷段要摘掉——同一份问卷只留一个节点",
  );
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "答复后输入区让位");
}
console.log("interactionSync: 本窗口答复 → 记录并进工具节点、独立段消失 ✓");

{
  // (c) 先撤回收场（另一个窗口答了 / 用户放弃），随后 durable 结果带答案到达
  const { adapter, messages } = harness();
  adapter.applyEvent(toolCall("q3", "ask_user_question", 1, askArgs(ASK_QUESTIONS)) as never);
  askCard(adapter, "ev-q3");
  adapter.cancelEvent("ev-q3");
  assert.strictEqual(
    toolSegmentById(messages, "tool:q3")?.tool.question?.state,
    "cancelled",
    "撤回之后节点是「已取消」记录（只有题目，没有答案）",
  );
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.kind === "question").length,
    0,
    "撤回同样并进工具节点",
  );
  assert.strictEqual(resolveInteractions(messages).pending, undefined, "撤回后不再占输入区");

  // 另一个窗口答完的真实顺序：先撤回、工具结果带着答案随后到 → 纠正为「已答完」
  adapter.applyEvent(toolResult("q3", askAnswers(ASK_RESULT), 2) as never);
  assert.strictEqual(
    toolSegmentById(messages, "tool:q3")?.tool.question?.state,
    "answered",
    "答案到了就是答过了（记录不能一边写「已取消」一边列着答案）",
  );
  assert.deepStrictEqual(toolSegmentById(messages, "tool:q3")?.tool.question?.answers?.notes, { selected: ["要"] });
}
console.log("interactionSync: 撤回收场 → durable 答案到达纠正为已答完 ✓");

{
  // (d) 本窗口答复之后立刻重折（durable 结果还没到）：记录不能被打回「运行中」
  const { adapter, messages } = harness();
  const t = Date.now();
  adapter.applyEvent({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } } as never);
  adapter.applyEvent(toolCall("q4", "ask_user_question", 2, askArgs(ASK_QUESTIONS)) as never);
  askCard(adapter, "ev-q4");
  adapter.resolveQuestion("ev-q4", {
    color: { selected: ["Green"] },
    notes: { selected: ["不要"] },
  });
  adapter.applyFrame({
    type: "snapshot",
    cursor: 2,
    hasMore: false,
    records: [
      { type: "event", event: { type: "turn/start", seq: 1, time: t, data: { turn: 1 } } },
      {
        type: "event",
        event: toolCall("q4", "ask_user_question", 2, askArgs(ASK_QUESTIONS)),
      },
    ],
  } as never);

  const tool = toolSegmentById(messages, "tool:q4");
  assert.strictEqual(tool?.tool.question?.state, "answered", "重折（还只有 tool/call）之后记录仍是已答完");
  assert.deepStrictEqual(tool?.tool.question?.answers?.color, { selected: ["Green"] });
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.kind === "question").length,
    0,
    "重折也不该把那张独立卡补回来",
  );
}
console.log("interactionSync: 答复后立刻重折不丢记录 ✓");

{
  // (e) 不误编卡：形状对不上、或失败码不是「没人回答」时，退回通用工具行
  const { adapter, messages } = harness();
  // 参数认不出题目（模型给了半截/坏 JSON）→ 没有记录，但工具行本身还在
  adapter.applyEvent(toolCall("q5", "ask_user_question", 1, '{"questions":[]}') as never);
  adapter.applyEvent(toolResult("q5", askAnswers(ASK_RESULT), 2) as never);
  assert.strictEqual(toolSegmentById(messages, "tool:q5")?.tool.question, undefined, "空题目不编卡");

  // 失败码不是「用户没答」：错误原文必须留在通用行里，不能被记录卡盖掉
  adapter.applyEvent(toolCall("q6", "ask_user_question", 3, askArgs(ASK_QUESTIONS)) as never);
  adapter.applyEvent(
    toolResult("q6", "Error: human interaction is unavailable", 4, {
      name: "UserQuestionError",
      code: "DELEGATED_CALLER",
    }) as never,
  );
  assert.strictEqual(
    toolSegmentById(messages, "tool:q6")?.tool.question,
    undefined,
    "DELEGATED_CALLER 这类失败不编「已取消」记录（那是工具的失败，不是没人回答）",
  );

  // 轮次中止（合成 interrupted 结果）→ 「已取消」记录（与今天的文案同口径）
  adapter.applyEvent(toolCall("q7", "ask_user_question", 5, askArgs(ASK_QUESTIONS)) as never);
  adapter.applyEvent({ type: "turn/end", seq: 6, time: Date.now(), data: { turn: 0, reason: { kind: "aborted" } } } as never);
  assert.strictEqual(
    toolSegmentById(messages, "tool:q7")?.tool.question?.state,
    "cancelled",
    "轮次中止 → 那条问卷记录落成「已取消」",
  );

  // 已经投到界面上的那张卡 + 非「没人回答」的失败：工具节点不编卡，但那条段**不能**
  // 被摘掉——摘了等于把这次提问从界面上抹掉（宁可留一张没人接的卡，也不丢记录）
  adapter.applyEvent(toolCall("q8", "ask_user_question", 7, askArgs(ASK_QUESTIONS)) as never);
  askCard(adapter, "ev-q8");
  adapter.applyEvent(
    toolResult("q8", "Error: no user-questions answerer accepted the request", 8, {
      name: "UserQuestionError",
      code: "NO_PROVIDER",
    }) as never,
  );
  assert.strictEqual(toolSegmentById(messages, "tool:q8")?.tool.question, undefined, "NO_PROVIDER 不编卡");
  assert.ok(questionSegment(messages), "那张已经投出去的卡要留着，不能被误摘");
}
console.log("interactionSync: 认不出题目 / 非「没人回答」的失败都不误编卡 ✓");

{
  // (f) 计划审阅（`exit_plan_mode`）不在合并范围内：它没有 `ask_user_question` 承载者，
  // 记录照旧是流里那一段（题目的 detail/intent 只存在于 waterfall，durable 参数里只有计划正文）
  const { adapter, messages } = harness();
  adapter.addQuestion({
    requestId: "ev-plan",
    items: [
      {
        id: "plan-review",
        header: "Plan review",
        question: "Approve this plan and leave plan mode?",
        detail: "# 计划\n\n1. 做一件事",
        options: [{ label: "确认执行" }, { label: "拒绝" }],
        intent: { kind: "plan-review", approve: "确认执行" },
      },
    ],
    state: "waiting",
  });
  adapter.resolveQuestion("ev-plan", { "plan-review": { selected: ["确认执行"] } });
  const record = questionSegment(messages);
  assert.ok(record, "计划审阅的记录仍然留在流里（本次不合并它）");
  assert.strictEqual(record?.question.state, "answered");
  assert.deepStrictEqual(record?.question.answers?.["plan-review"], { selected: ["确认执行"] });
}
console.log("interactionSync: 计划审阅记录行为不变 ✓");

// ---------- 11. 同一组题目 id 被问了第二次 ----------
//
// 承载者只能按**题目 id 集合**匹配（提问请求里没有 callId），所以「节点上已经有记录」
// 这条判据必须精确：否则第二次提问会被第一次的记录挡掉——卡片永远不弹，agent 干等。
{
  const { adapter, messages } = harness();
  adapter.applyEvent(toolCall("qa", "ask_user_question", 1, askArgs(ASK_QUESTIONS)) as never);
  adapter.applyEvent(toolResult("qa", askAnswers(ASK_RESULT), 2) as never);

  // 第二次提问：同一个 id 集合，新那次调用还在跑
  adapter.applyEvent(toolCall("qb", "ask_user_question", 3, askArgs(ASK_QUESTIONS)) as never);
  askCard(adapter, "ev-qb");
  assert.strictEqual(resolveInteractions(messages).pending?.kind, "question", "新的一次提问照常接管输入区");
  assert.ok(questionSegment(messages), "新的一次提问要有自己的卡（不能被旧记录的 id 集合挡掉）");

  adapter.resolveQuestion("ev-qb", { color: { selected: ["Green"] }, notes: { selected: ["不要"] } });
  assert.strictEqual(
    toolSegmentById(messages, "tool:qb")?.tool.question?.state,
    "answered",
    "这次答复写进**第二次**提问的那个节点",
  );
  assert.deepStrictEqual(
    toolSegmentById(messages, "tool:qa")?.tool.question?.answers?.color,
    { selected: ["Blue"], custom: "Include accessibility notes" },
    "上一次的记录保留它自己的答案",
  );
  assert.strictEqual(
    messages.flatMap((m) => m.segments).filter((s) => s.kind === "question").length,
    0,
    "答复之后独立段照旧并进节点",
  );
}
console.log("interactionSync: 同一组题目 id 的第二次提问不被旧记录挡掉 ✓");

console.log("\ninteractionSync: all assertions passed");
