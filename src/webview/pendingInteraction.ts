import type { ApprovalView, MessageView, QuestionView } from "../shared/chat";
import { planReviewOf, type PlanReviewView } from "./planReview";

/**
 * 「有一个交互在等你回答」——官方 `uiSession.registerPendingInteraction(priority)` 的选举结果。
 *
 * 官方把审批卡与提问卡注册进 `conversation.composer` 槽（`select: ({pendingInteraction}) => …`），
 * 于是**待处理时它接管输入区**：卡片永远在视野里，界面看起来就是「在等你」。
 * 我们此前把它画在对话流里（作为一段），滚上去就看不见了。
 *
 * 优先级沿官方：plan-review 提问 > 普通提问 > 审批（官方 `dsh-client-ui-user-questions`
 * 里 plan-review 注册 2、普通提问注册 1；`dsh-client-ui-approval` 注册 0）。
 * plan-review 与普通提问是**同一条线格式**（都走 `user-questions/request`），
 * 区分它的是题目上的 `intent.kind`（见 `planReviewOf`）——所以这里先收窄再定优先级。
 * 同优先级取**最后一条**（后到的先处理）。
 *
 * 纯函数、不引 React：断言见 `scripts/pendingInteraction.test.ts`。
 */
export type PendingInteraction =
  | { kind: "approval"; approval: ApprovalView }
  | { kind: "question"; question: QuestionView }
  | { kind: "plan-review"; question: QuestionView; review: PlanReviewView };

/** 消息流里**当前待处理**的交互；没有就返回 undefined。 */
export function pendingInteractionOf(
  messages: readonly MessageView[],
): PendingInteraction | undefined {
  let approval: ApprovalView | undefined;
  let question: QuestionView | undefined;
  let pendingReview: { question: QuestionView; review: PlanReviewView } | undefined;
  for (const message of messages) {
    for (const segment of message.segments) {
      // 同优先级取最后一条：一轮里先后来了两张卡，用户在等的是后到的那张
      if (segment.kind === "approval" && segment.approval.state === "waiting") {
        approval = segment.approval;
      } else if (segment.kind === "question" && segment.question.state === "waiting") {
        const narrowed = planReviewOf(segment.question.items);
        if (narrowed) pendingReview = { question: segment.question, review: narrowed };
        else question = segment.question;
      }
    }
  }
  if (pendingReview) {
    return { kind: "plan-review", question: pendingReview.question, review: pendingReview.review };
  }
  if (question) return { kind: "question", question };
  if (approval) return { kind: "approval", approval };
  return undefined;
}

/**
 * 这条段是否应当**由输入区**渲染（而不是留在对话流里）。
 *
 * 待处理的卡片归输入区（接管），已经答过的留在对话流里当记录——
 * 两边都画一次就是重复，两边都不画就是丢信息。
 */
export function isTakenOverByComposer(segment: {
  kind: string;
  approval?: ApprovalView;
  question?: QuestionView;
}): boolean {
  if (segment.kind === "approval") return segment.approval?.state === "waiting";
  if (segment.kind === "question") return segment.question?.state === "waiting";
  return false;
}
