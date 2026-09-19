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
 * ## 每个会话**只有一张**（下面那条抑制规则的依据）
 *
 * 官方框架把「接管输入区」按会话存成一份 Map：
 * `SessionPendingInteractionSnapshot = ReadonlyMap<SessionId, SessionPendingInteraction>`
 * （`dsh-client-ui-session`），插件用 `PendingInteractionPublisher` 发布一个并拿到注销函数
 * ——同一域的新请求要换 key，也就是**替换**而不是并存。所以「两张卡同时等」在框架层
 * 不是一个合法状态。
 *
 * 但那是框架的保证，不是我们能依赖的事实：扩展自己的宿主侧（`heldEvents` 的补投、
 * 断线重连时把卡片回放进适配器）**有机会**把两条 waiting 段放进同一份消息流。
 * 所以抑制规则收窄成「**只撤下被选中的那一条**」：万一真出现两张，另一张留在对话流里
 * 照样能答，而不是谁也渲染不了它（`Message` 撤下 + `Composer` 只画一张 = 那张卡彻底消失）。
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

/** 被选中的那条交互的 `requestId`——只有它该从消息流里撤下。 */
export function pendingRequestId(pending: PendingInteraction | undefined): string | undefined {
  if (!pending) return undefined;
  return pending.kind === "approval" ? pending.approval.requestId : pending.question.requestId;
}

/**
 * 这条段是否应当**由输入区**渲染（而不是留在对话流里）。
 *
 * 判据是「它**就是**被选中的那一条」，**不是**「它是 waiting」——后者会在两张卡并存时
 * 把两张都撤下，而输入区只画一张（见文件头「每个会话只有一张」那节）。
 *
 * @param electedRequestId 选举结果（`pendingRequestId(pending)`）；没有待处理交互时传 `undefined`
 */
export function isTakenOverByComposer(
  segment: {
    kind: string;
    approval?: ApprovalView;
    question?: QuestionView;
  },
  electedRequestId: string | undefined,
): boolean {
  if (electedRequestId === undefined) return false;
  // 两个条件都要：**还在等**（`waiting`）且**就是被选中的那一条**。
  // 只看 `requestId` 会在调用方给了一个过期的 id 时把已答过的卡撤下——那条记录就丢了。
  if (segment.kind === "approval") {
    return segment.approval?.state === "waiting" && segment.approval.requestId === electedRequestId;
  }
  if (segment.kind === "question") {
    return segment.question?.state === "waiting" && segment.question.requestId === electedRequestId;
  }
  return false;
}
