/**
 * 「有个交互在等你回答」的选举（官方 `uiSession.registerPendingInteraction`）。
 *
 * 官方把审批卡与提问卡注册进 `conversation.composer` 槽，`select` 拿到的是**待处理**
 * 的那个 → 卡片接管输入区。规则里唯一有取舍的是**同时有多张待处理卡时给谁**：
 * 官方按注册优先级（`dsh-client-ui-user-questions` 注册 1、plan-review 注册 2；
 * `dsh-client-ui-approval` 注册 0），所以**提问优先于审批**。
 * 我们分不出 plan-review 提问（线格式里没有这个标记），只实现「提问 > 审批」；
 * 同优先级取最后一条。这些口径在这里钉住。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import type { ApprovalView, MessageView, QuestionView } from "../src/shared/chat";
import { isTakenOverByComposer, pendingInteractionOf } from "../src/webview/pendingInteraction";

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

const message = (segments: MessageView["segments"]): MessageView => ({
  id: "a:1",
  role: "assistant",
  ts: 0,
  segments,
});

// ---------- 1. 待处理的才接管；已答过的不接管 ----------
{
  const pending = pendingInteractionOf([
    message([{ kind: "approval", id: "s1", approval: approval("r1", "waiting") }]),
  ]);
  assert.strictEqual(pending?.kind, "approval", "待处理的审批要接管输入区");

  const answered = pendingInteractionOf([
    message([{ kind: "approval", id: "s1", approval: approval("r1", "approved") }]),
  ]);
  assert.strictEqual(answered, undefined, "已经答过的审批不该再占着输入区（它留在流里当记录）");

  for (const state of ["rejected", "expired"] as const) {
    assert.strictEqual(
      pendingInteractionOf([message([{ kind: "approval", id: "s", approval: approval("r", state) }])]),
      undefined,
      `${state} 同样不算待处理`,
    );
  }
  assert.strictEqual(
    pendingInteractionOf([message([{ kind: "question", id: "s", question: question("r", "answered") }])]),
    undefined,
    "已回答的提问也不算待处理",
  );
  // 被 Host 撤回的提问（另一个窗口答了 / 轮次中止）：同样必须让出输入区，
  // 否则多窗口下这张卡会永远停在页面上（用户 2026-09-15 报的）
  assert.strictEqual(
    pendingInteractionOf([message([{ kind: "question", id: "s", question: question("r", "cancelled") }])]),
    undefined,
    "已撤回的提问不算待处理",
  );
}

// ---------- 2. 提问优先于审批（官方的注册优先级 1 > 0） ----------
{
  const both = pendingInteractionOf([
    message([
      { kind: "question", id: "q", question: question("rq", "waiting") },
      { kind: "approval", id: "a", approval: approval("ra", "waiting") },
    ]),
  ]);
  assert.strictEqual(both?.kind, "question", "两张同时待处理时，提问优先（官方优先级）");

  // 顺序反过来结论不变（优先级是绝对的，不是先到先得）
  const reversed = pendingInteractionOf([
    message([
      { kind: "approval", id: "a", approval: approval("ra", "waiting") },
      { kind: "question", id: "q", question: question("rq", "waiting") },
    ]),
  ]);
  assert.strictEqual(reversed?.kind, "question", "与它们在流里的先后无关");
}

// ---------- 3. 同优先级取最后一条 ----------
{
  const last = pendingInteractionOf([
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
  const pending = pendingInteractionOf([
    message([{ kind: "text", id: "t", text: "先做点事" }]),
    message([{ kind: "tool", id: "tool", tool: { id: "c", name: "read", status: "ok" } } as never]),
    message([{ kind: "question", id: "q", question: question("rq", "waiting") }]),
  ]);
  assert.strictEqual(pending?.kind, "question", "要扫完整个消息流，不能只看最后一条");
}

// ---------- 5. 界面对齐：待处理的在流里**不渲染**，已答过的照常渲染 ----------
{
  assert.strictEqual(
    isTakenOverByComposer({ kind: "approval", approval: approval("r", "waiting") }),
    true,
    "待处理 → 由输入区渲染（流里跳过，避免同一张卡出现两次）",
  );
  assert.strictEqual(
    isTakenOverByComposer({ kind: "approval", approval: approval("r", "approved") }),
    false,
    "已答过 → 留在流里当记录",
  );
  assert.strictEqual(
    isTakenOverByComposer({ kind: "question", question: question("r", "waiting") }),
    true,
  );
  assert.strictEqual(
    isTakenOverByComposer({ kind: "question", question: question("r", "answered") }),
    false,
  );
  assert.strictEqual(isTakenOverByComposer({ kind: "text" }), false, "其它段不受影响");
}

console.log("pendingInteraction: 待处理交互的选举与接管 ✓");
console.log("\npendingInteraction: all assertions passed");
