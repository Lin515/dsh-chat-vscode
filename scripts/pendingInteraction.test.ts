/**
 * 「有个交互在等你回答」的选举与抑制（官方 `uiSession.registerPendingInteraction`）。
 *
 * 官方把审批卡与提问卡注册进 `conversation.composer` 槽，`select` 拿到的是**待处理**
 * 的那个 → 卡片接管输入区。规则里唯一有取舍的是**同时有多张待处理卡时给谁**：
 * 官方按注册优先级（`dsh-client-ui-user-questions` 里 plan-review 注册 2、普通提问
 * 注册 1；`dsh-client-ui-approval` 注册 0），所以 **plan-review > 提问 > 审批**。
 *
 * plan-review 与普通提问是**同一条线格式**（都走 `user-questions/request`），
 * 区分它的是题目上的 `intent.kind === "plan-review"`（收窄规则见
 * `scripts/planReview.test.ts`）：所以这里也要一起钉住「认得出」与「认不出就退回
 * 普通提问」两条。同优先级取最后一条。这些口径在这里钉住。
 *
 * 选举与抑制现在是**一次计算**（`resolveInteractions`）的两半：`pending` 是「谁接管
 * 输入区」，`takenOver` 是「哪些**段**交给输入区渲染」（键是 `segment.id`，最多一个
 * 元素）。这里断言的是这个公开入口的行为，不碰内部实现。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import type { ApprovalView, MessageView, QuestionView } from "../src/shared/chat";
import { resolveInteractions, type PendingInteraction } from "../src/webview/pendingInteraction";

const approval = (id: string, state: ApprovalView["state"]): ApprovalView => ({
  requestId: id,
  toolName: "pwsh",
  reason: "需要提权",
  state,
});
const question = (id: string, state: QuestionView["state"]): QuestionView => ({
  requestId: id,
  state,
  items: [{ id: "q1", header: "确认", question: "继续吗？", options: [{ label: "继续" }] }],
});
/** `exit_plan_mode` 形状的待处理请求（真实形状见 `scripts/planReview.test.ts`）。 */
const planReview = (id: string, state: QuestionView["state"]): QuestionView => ({
  requestId: id,
  state,
  items: [
    {
      id: "plan-review",
      header: "Plan review",
      question: "Approve this plan and leave plan mode?",
      detail: "# 计划\n\n做这件事。",
      options: [{ label: "Approve" }, { label: "Keep planning" }],
      intent: { kind: "plan-review", approve: "Approve" },
    },
  ],
});

const message = (segments: MessageView["segments"], id = "a:1"): MessageView => ({
  id,
  role: "assistant",
  ts: 0,
  segments,
});

/** 选举结果那一半（公开入口 `resolveInteractions` 的 `pending`）。 */
const elected = (messages: MessageView[]): PendingInteraction | undefined =>
  resolveInteractions(messages).pending;

// ---------- 1. 待处理的才接管；已答过的不接管 ----------
{
  const pending = elected([
    message([{ kind: "approval", id: "s1", approval: approval("r1", "waiting") }]),
  ]);
  assert.strictEqual(pending?.kind, "approval", "待处理的审批要接管输入区");

  const answered = elected([
    message([{ kind: "approval", id: "s1", approval: approval("r1", "approved") }]),
  ]);
  assert.strictEqual(answered, undefined, "已经答过的审批不该再占着输入区（它留在流里当记录）");

  for (const state of ["rejected", "expired"] as const) {
    assert.strictEqual(
      elected([message([{ kind: "approval", id: "s", approval: approval("r", state) }])]),
      undefined,
      `${state} 同样不算待处理`,
    );
  }
  assert.strictEqual(
    elected([message([{ kind: "question", id: "s", question: question("r", "answered") }])]),
    undefined,
    "已回答的提问也不算待处理",
  );
  // 被 Host 撤回的提问（另一个窗口答了 / 轮次中止）：同样必须让出输入区，
  // 否则多窗口下这张卡会永远停在页面上（用户 2026-09-15 报的）
  assert.strictEqual(
    elected([message([{ kind: "question", id: "s", question: question("r", "cancelled") }])]),
    undefined,
    "已撤回的提问不算待处理",
  );
}

// ---------- 2. 提问优先于审批（官方的注册优先级 1 > 0） ----------
{
  const both = elected([
    message([
      { kind: "question", id: "q", question: question("rq", "waiting") },
      { kind: "approval", id: "a", approval: approval("ra", "waiting") },
    ]),
  ]);
  assert.strictEqual(both?.kind, "question", "两张同时待处理时，提问优先（官方优先级）");

  // 顺序反过来结论不变（优先级是绝对的，不是先到先得）
  const reversed = elected([
    message([
      { kind: "approval", id: "a", approval: approval("ra", "waiting") },
      { kind: "question", id: "q", question: question("rq", "waiting") },
    ]),
  ]);
  assert.strictEqual(reversed?.kind, "question", "与它们在流里的先后无关");
}

// ---------- 3. 同优先级取最后一条 ----------
{
  const last = elected([
    message([{ kind: "approval", id: "a1", approval: approval("r1", "waiting") }]),
    message([{ kind: "approval", id: "a2", approval: approval("r2", "waiting") }]),
  ]);
  assert.strictEqual(
    last?.kind === "approval" ? last.approval.requestId : undefined,
    "r2",
    "两张同类型待处理卡：后到的那张才是用户在等的",
  );
}

// ---------- 4. 跨消息、跨段扫描：不在第一条里也能找到 ----------
{
  const pending = elected([
    message([{ kind: "text", id: "t", text: "先做点事" }]),
    message([{ kind: "tool", id: "tool", tool: { id: "c", name: "read", status: "ok" } } as never]),
    message([{ kind: "question", id: "q", question: question("rq", "waiting") }]),
  ]);
  assert.strictEqual(pending?.kind, "question", "要扫完整个消息流，不能只看最后一条");
}

// ---------- 4b. plan-review 认得出、且优先级最高 ----------
//
// plan-review 与普通提问走同一条线格式，只有 `intent.kind` 不同——认不出来
// 就会把「计划审阅」画成一张普通问卷（计划正文也看不见）。
{
  const pending = elected([
    message([{ kind: "question", id: "q", question: planReview("r", "waiting") }]),
  ]);
  assert.strictEqual(pending?.kind, "plan-review", "intent 是 plan-review 的提问要单独当选");
  assert.strictEqual(
    pending?.kind === "plan-review" ? pending.review.plan : undefined,
    "# 计划\n\n做这件事。",
    "选举结果里要带上收窄后的计划（界面直接用，不再自己判一次）",
  );
  assert.strictEqual(
    pending?.kind === "plan-review" ? pending.review.approve.label : undefined,
    "Approve",
    "批准项要一起带过来",
  );

  // 优先级：plan-review > 普通提问 > 审批（官方注册优先级 2 / 1 / 0）
  const all = elected([
    message([
      { kind: "approval", id: "a", approval: approval("ra", "waiting") },
      { kind: "question", id: "q", question: question("rq", "waiting") },
      { kind: "question", id: "p", question: planReview("rp", "waiting") },
    ]),
  ]);
  assert.strictEqual(all?.kind, "plan-review", "三张同待处理时给 plan-review（官方优先级 2）");

  // 认不出来的（这里：多给了一个选项，两个按钮表达不完）退回普通提问
  const notNarrowable = elected([
    message([
      {
        kind: "question",
        id: "p",
        question: {
          ...planReview("rp", "waiting"),
          items: [
            {
              ...planReview("rp", "waiting").items[0],
              options: [{ label: "Approve" }, { label: "Keep planning" }, { label: "再说" }],
            },
          ],
        },
      },
    ]),
  ]);
  assert.strictEqual(notNarrowable?.kind, "question", "收窄不了就退回通用问卷流程，不能丢答案");

  // 已答完的 plan-review 同样不占输入区
  assert.strictEqual(
    elected([message([{ kind: "question", id: "p", question: planReview("rp", "answered") }])]),
    undefined,
    "已答完的计划审阅不是待处理交互",
  );
}
console.log("pendingInteraction: plan-review 优先级最高、收窄不了退回问卷 ✓");

// ---------- 5. 抑制：**只有被选中的那一条**在流里不渲染 ----------
//
// 官方框架按会话只留一个 pending interaction（`SessionPendingInteractionSnapshot =
// ReadonlyMap<SessionId, …>`），所以正常只有一张卡，`takenOver` 也最多一个元素。
// 这里仍然覆盖「两张 waiting 并存」：那是框架层不合法、但宿主侧的卡片补投**造得出来**
// 的状态——那时必须**只撤下被选中的那一张**，否则 Composer 只画一张、另一张谁也渲染
// 不了（= 用户看不到也答不了）。
//
// 键是 **`segment.id`**（抑制按段做），不是 `requestId`；且只有 `waiting` 的段进得来
// （判据「还在等 **且** 就是被选中的那一条」，缺一半都会丢卡）。
{
  const twoWaiting = [
    message([{ kind: "approval", id: "seg-approval", approval: approval("r-a", "waiting") }], "a:approval"),
    message([{ kind: "question", id: "seg-question", question: question("r-q", "waiting") }], "a:question"),
  ];
  const { pending, takenOver } = resolveInteractions(twoWaiting);
  assert.strictEqual(pending?.kind, "question", "两张 waiting 并存时提问当选（官方优先级）");
  assert.strictEqual(takenOver.size, 1, "takenOver 最多一个元素（框架按会话只留一个待处理交互）");
  assert.ok(
    takenOver.has("seg-question"),
    "被选中的那一段交给输入区渲染（流里跳过它，避免同一张卡出现两次）",
  );
  assert.ok(
    !takenOver.has("seg-approval"),
    "**没被选中的那张必须留在流里**：一起撤下就等于那张卡彻底消失（用户看不到也答不了）",
  );
  assert.ok(!takenOver.has("r-q"), "takenOver 的键是**段 id**，不是 requestId");

  // 反过来：当选的是审批（问卷段这里是已答过的记录，不参与选举）
  const electedApproval = resolveInteractions([
    message(
      [
        { kind: "question", id: "seg-question", question: question("r-q", "answered") },
        { kind: "approval", id: "seg-approval", approval: approval("r-a", "waiting") },
      ],
      "a:mixed",
    ),
  ]);
  assert.strictEqual(electedApproval.pending?.kind, "approval", "只有审批在等 → 它当选");
  assert.strictEqual(electedApproval.takenOver.size, 1);
  assert.ok(electedApproval.takenOver.has("seg-approval"), "当选的那一段才交给输入区");

  // 没有待处理交互：`pending` 为 undefined、`takenOver` 为空集
  const empty = resolveInteractions([]);
  assert.strictEqual(empty.pending, undefined, "空消息流没有待处理交互");
  assert.strictEqual(empty.takenOver.size, 0, "没有待处理交互时 takenOver 是空集");

  // 已答过（answered / cancelled）的段**不在** takenOver 里——否则那条记录就丢了
  const settled = resolveInteractions([
    message([{ kind: "approval", id: "seg-approved", approval: approval("r-a", "approved") }], "a:approved"),
    message([{ kind: "question", id: "seg-answered", question: question("r-q", "answered") }], "a:answered"),
    message([{ kind: "question", id: "seg-cancelled", question: question("r-c", "cancelled") }], "a:cancelled"),
  ]);
  assert.strictEqual(settled.pending, undefined, "answered / cancelled 都不是待处理交互");
  assert.strictEqual(
    settled.takenOver.size,
    0,
    "已答过 / 已撤回的段不在 takenOver 里（它们要留在流里当记录）",
  );

  // 非交互段不受影响：扫描时它们既不参选、也不会进 takenOver
  const withText = resolveInteractions([
    message([
      { kind: "text", id: "seg-text", text: "先做点事" },
      { kind: "question", id: "seg-question", question: question("r-q", "waiting") },
    ]),
  ]);
  assert.strictEqual(withText.takenOver.size, 1, "只有那一段交互被接管");
  assert.ok(withText.takenOver.has("seg-question"), "被接管的是交互段本身");
  assert.ok(!withText.takenOver.has("seg-text"), "非交互段不受影响");
}

console.log("pendingInteraction: 待处理交互的选举与接管 ✓");
console.log("\npendingInteraction: all assertions passed");
