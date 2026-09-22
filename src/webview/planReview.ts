import type { QuestionItemView, QuestionOption } from "../shared/chat";

/**
 * 计划审阅（`exit_plan_mode`）请求的识别：**官方 `planReviewOf` 的逐字移植**。
 *
 * 模型在计划模式里调 `exit_plan_mode` 请人放行，服务端把它变成一次
 * `user-questions/request`——**不是**独立的审批事件。辨认它靠题目上的
 * `intent.kind === "plan-review"`（提问方 = `dsh-plan-mode`，见
 * `docs/dsh-server-api.md`「计划模式」一节）。
 *
 * 收窄规则（`dsh-client-ui-user-questions/lib/client.js:38-56`）：卡片只在
 * **能发出这份请求允许的每一个答案**时才接管，意图只换布局、不改可达的答案，
 * 所以下列任一条不成立就退回通用问卷流程（宁可画成普通问卷，也不能出现
 * 「两个按钮表达不出的答案」）：
 *
 * - 恰好一道题；
 * - 声明了 `plan-review` 意图、且 `detail` 里真有计划正文；
 * - 非多选；
 * - 选项不超过两个（批准 + 最多一个拒绝）；
 * - 选项里**逐字**存在意图点名的那个批准 label。
 *
 * 纯函数、不引 React：断言见 `scripts/planReview.test.ts`。
 */

/** 收窄后的一张计划审阅卡。 */
export interface PlanReviewView {
  /** 那道题的 id（回答按它归档；`dsh-plan-mode` 用的是 `plan-review`）。 */
  id: string;
  /** 提问正文（卡片的无障碍标题，官方拿它当 `aria-label`）。 */
  question: string;
  /** 计划正文（题目的 `detail`，markdown）。 */
  plan: string;
  /** 批准项：回答时必须逐字回它的 label。 */
  approve: QuestionOption;
  /** 拒绝项（提问方只给了一个「批准」时没有它，卡片就不画这个按钮）。 */
  decline?: QuestionOption;
}

/**
 * 把一份请求收窄成可渲染的计划审阅，收窄不了就返回 undefined（交给通用问卷流程）。
 */
export function planReviewOf(items: readonly QuestionItemView[]): PlanReviewView | undefined {
  if (items.length !== 1) return undefined;
  const item = items[0];
  const intent = item.intent;
  if (intent?.kind !== "plan-review") return undefined;
  // 计划正文缺失时不能接管：那张卡的全部意义就是把计划摊开给人看
  // （与官方同判据：只看 `undefined`，空串不拦——提问方本来就要求计划非空）
  if (item.detail === undefined) return undefined;
  if (item.multiSelect === true) return undefined;
  const options = item.options ?? [];
  if (options.length > 2) return undefined;
  const approveLabel = intent.approve;
  if (typeof approveLabel !== "string" || approveLabel === "") return undefined;
  const approve = options.find((option) => option.label === approveLabel);
  if (approve === undefined) return undefined;
  const decline = options.find((option) => option.label !== approveLabel);
  return {
    id: item.id,
    question: item.question,
    plan: item.detail,
    approve,
    ...(decline === undefined ? {} : { decline }),
  };
}

/**
 * 计划审阅卡上点「批准 / 拒绝」时要发的那份答案。
 *
 * 判定在提问方那里是**严格的**（`dsh-plan-mode/lib/index.js:286`）：`selected`
 * 必须**恰好一项**、且逐字等于意图点名的批准 label、且**不能带 `custom`**——
 * 任何别的形状（包括把自定义文本塞进去）都会被读成「继续规划」，文本还会被
 * 当成反馈回给模型。所以这里只回选中 label，一个多余字段都不加。
 */
export function planReviewAnswer(
  review: PlanReviewView,
  label: string,
): { id: string; selected: string[] } {
  return { id: review.id, selected: [label] };
}
