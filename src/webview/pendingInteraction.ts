import type { ApprovalView, MessageView, QuestionView } from "../shared/chat";

/**
 * 「有一个交互在等你回答」——官方 `uiSession.registerPendingInteraction(priority)` 的选举结果。
 *
 * 官方把审批卡与提问卡注册进 `conversation.composer` 槽（`select: ({pendingInteraction}) => …`），
 * 于是**待处理时它接管输入区**：卡片永远在视野里，界面看起来就是「在等你」。
 * 我们此前把它画在对话流里（作为一段），滚上去就看不见了。
 *
 * 优先级沿官方：提问 > 审批（官方 `dsh-client-ui-user-questions` 注册 1、plan-review 注册 2；
 * `dsh-client-ui-approval` 注册 0）。**我们分不出 plan-review 提问**（线格式里没有这个标记），
 * 所以只实现「提问优先于审批」；同优先级取**最后一条**（后到的先处理）。
 *
 * 纯函数、不引 React：断言见 `scripts/pendingInteraction.test.ts`。
 */
export type PendingInteraction =
  | { kind: "approval"; approval: ApprovalView }
  | { kind: "question"; question: QuestionView };

/** 消息流里**当前待处理**的交互；没有就返回 undefined。 */
export function pendingInteractionOf(
  messages: readonly MessageView[],
): PendingInteraction | undefined {
  let approval: ApprovalView | undefined;
  let question: QuestionView | undefined;
  for (const message of messages) {
    for (const segment of message.segments) {
      // 同优先级取最后一条：一轮里先后来了两张卡，用户在等的是后到的那张
      if (segment.kind === "approval" && segment.approval.state === "waiting") {
        approval = segment.approval;
      } else if (segment.kind === "question" && segment.question.state === "waiting") {
        question = segment.question;
      }
    }
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
