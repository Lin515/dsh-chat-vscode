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
 * ## 选举与抑制合成**一次计算**
 *
 * 从前这里是两个公开入口：`pendingInteractionOf` 选「谁接管输入区」，
 * `isTakenOverByComposer(段, requestId)` 判断「某段撤不撤」——调用方得把选举结果
 * **正确传进来**（传漏、传了过期的 id，症状是同一张卡两边都画、或两边都不画）。
 * 现在合成 `resolveInteractions` 一次扫描同时给出两者：两者出自同一次遍历，
 * 对不上这件事从结构上就不可能发生。
 *
 * 纯函数、不引 React：断言见 `scripts/pendingInteraction.test.ts`。
 */
export type PendingInteraction =
  | { kind: "approval"; approval: ApprovalView }
  | { kind: "question"; question: QuestionView }
  | { kind: "plan-review"; question: QuestionView; review: PlanReviewView };

/**
 * 没有任何交互接管输入区时的空集合。
 *
 * **模块级常量**：`Message` 是 `memo` 的，流式期间 App 每帧都重渲染——没有待处理交互
 * 是绝大多数帧的状态，这里每次都新建 `Set` 会让所有消息的 props 每帧都变，memo 白做。
 */
const NO_TAKEN_OVER: ReadonlySet<string> = new Set();

/**
 * 一次算出「谁接管输入区」与「哪些段交给输入区渲染」。
 *
 * - `pending`：与旧的 `pendingInteractionOf` **完全同语义**——plan-review > 普通提问 >
 *   审批，同级取最后一条；没有待处理交互时 `undefined`。
 * - `takenOver`：要**交给输入区渲染**的那些段的 id。键是 **`segment.id`**，不是
 *   `requestId`——抑制是按段做的（同一张卡的 `requestId` 与段 id 是两回事）。
 *   最多一个元素：官方框架按会话只留一个待处理交互（见文件头）。
 *   判据仍然是两条一起要：「**还在等**」且「**就是被选中的那一条**」——前一条由下面的
 *   候选收集保证（审批卡只有等待态，提问要 `waiting`，见各自的候选分支），后一条由选举
 *   保证。所以已答过（`answered` / `cancelled`）的提问段**永远不会**出现在集合里，
 *   调用方用 `takenOver.has(segment.id)` 直接判即可。
 */
export function resolveInteractions(messages: readonly MessageView[]): {
  pending: PendingInteraction | undefined;
  takenOver: ReadonlySet<string>;
} {
  // 选举的候选：交互视图 + 它所在**那一段**的 id（抑制按段做，所以这里就要一起记）
  let approval: { segmentId: string; approval: ApprovalView } | undefined;
  let question: { segmentId: string; question: QuestionView } | undefined;
  let pendingReview: { segmentId: string; question: QuestionView; review: PlanReviewView } | undefined;
  for (const message of messages) {
    for (const segment of message.segments) {
      // 同优先级取最后一条：一轮里先后来了两张卡，用户在等的是后到的那张。
      // 「还在等」这条判据在两种卡上落点不同：审批卡**只有等待态**（答完即整段摘掉，
      // 见 adapter 的 `dropApprovalCard`），提问卡则以记录形态留在流里、要挑 `waiting`。
      if (segment.kind === "approval") {
        approval = { segmentId: segment.id, approval: segment.approval };
      } else if (segment.kind === "question" && segment.question.state === "waiting") {
        const narrowed = planReviewOf(segment.question.items);
        if (narrowed) pendingReview = { segmentId: segment.id, question: segment.question, review: narrowed };
        else question = { segmentId: segment.id, question: segment.question };
      }
    }
  }
  if (pendingReview) {
    return {
      pending: { kind: "plan-review", question: pendingReview.question, review: pendingReview.review },
      takenOver: new Set([pendingReview.segmentId]),
    };
  }
  if (question) {
    return {
      pending: { kind: "question", question: question.question },
      takenOver: new Set([question.segmentId]),
    };
  }
  if (approval) {
    return {
      pending: { kind: "approval", approval: approval.approval },
      takenOver: new Set([approval.segmentId]),
    };
  }
  return { pending: undefined, takenOver: NO_TAKEN_OVER };
}
