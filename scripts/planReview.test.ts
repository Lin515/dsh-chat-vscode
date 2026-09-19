/**
 * 计划审阅（`exit_plan_mode`）请求的识别与答案形状。
 *
 * 这一组钉两件事，两件都直接对应「看不见的计划」这类现场：
 *
 * 1. **收窄规则**（`planReviewOf`）——官方 `planReviewOf` 的逐字移植。判据不是
 *    「像不像计划」，而是「两个按钮能不能表达这份请求允许的每一个答案」；
 *    表达不了就必须退回通用问卷流程（宁可画成普通问卷，也不能有答不出的题）。
 * 2. **接线**——`detail` / `intent` 必须真的从 waterfall 请求透传到界面，
 *    「去聊天里说」必须真的发 `rejected` + `ASK_CANCELLED`。这两个字段此前
 *    在宿主侧被整个丢掉，界面上只剩一句「Approve this plan and leave plan mode?」
 *    和两个按钮——计划正文一个字都看不到。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuestionItemView } from "../src/shared/chat";
import { planReviewAnswer, planReviewOf } from "../src/webview/planReview";

const APP = process.cwd();

/**
 * `exit_plan_mode` 真实发出来的那道题（`dsh-plan-mode/lib/index.js:259-278` 逐字）。
 * 夹具不许自己编形状——这正是文档里记过的坑。
 */
const reviewItem: QuestionItemView = {
  id: "plan-review",
  header: "Plan review",
  question: "Approve this plan and leave plan mode?",
  detail: "# 计划\n\n1. 先读契约\n2. 再改适配器\n",
  options: [
    { label: "Approve", description: "Leave plan mode; the plan is carried out from the next step." },
    { label: "Keep planning", description: "Stay in plan mode; feedback goes back to the model." },
  ],
  intent: { kind: "plan-review", approve: "Approve" },
};

// ---------- 1. 官方形状：收窄成「一份计划 + 两个决定」 ----------
{
  const review = planReviewOf([reviewItem]);
  assert.ok(review, "`intent.kind = plan-review` + `detail` 的单选题必须被认出来");
  assert.strictEqual(review.id, "plan-review", "题 id 原样带过去（回答要按它归档）");
  assert.strictEqual(review.question, reviewItem.question, "提问正文进卡片标题");
  assert.strictEqual(review.plan, reviewItem.detail, "计划正文取 `detail`（卡片的全部意义）");
  assert.strictEqual(review.approve.label, "Approve", "批准项按意图点名的 label 认");
  assert.strictEqual(review.decline?.label, "Keep planning", "另一个选项就是拒绝项");
}
console.log("planReview: 官方形状收窄成计划审阅 ✓");

// ---------- 2. 收窄不了的一律退回通用问卷流程 ----------
//
// 意图只换布局、不改可达的答案：任何「两个按钮表达不完」的请求都不能被接管。
{
  const cases: [string, QuestionItemView[]][] = [
    ["多题请求", [reviewItem, { ...reviewItem, id: "second" }]],
    ["没有 intent", [{ ...reviewItem, intent: undefined }]],
    ["intent 不是 plan-review", [{ ...reviewItem, intent: { kind: "something-else" } }]],
    ["没有计划正文（detail 缺失）", [{ ...reviewItem, detail: undefined }]],
    ["多选", [{ ...reviewItem, multiSelect: true }]],
    [
      "三个选项",
      [{ ...reviewItem, options: [...reviewItem.options, { label: "改天再说" }] }],
    ],
    [
      "选项里没有意图点名的批准 label",
      [
        {
          ...reviewItem,
          options: [{ label: "Sure" }, { label: "Keep planning" }],
        },
      ],
    ],
    ["意图没给批准 label", [{ ...reviewItem, intent: { kind: "plan-review" } }]],
  ];
  for (const [label, items] of cases) {
    assert.strictEqual(planReviewOf(items), undefined, `${label}：必须退回通用问卷流程`);
  }
}
console.log("planReview: 表达不完的请求退回通用流程 ✓");

// ---------- 3. 只有一个「批准」选项时也要能用（不画拒绝按钮） ----------
{
  const review = planReviewOf([
    { ...reviewItem, options: [{ label: "Approve", description: "GO" }] },
  ]);
  assert.ok(review, "只给一个批准项的请求同样能接管");
  assert.strictEqual(review.decline, undefined, "没有拒绝项时不画拒绝按钮");
}
console.log("planReview: 无拒绝项时不画拒绝按钮 ✓");

// ---------- 4. 答案形状：恰好一个选中项、且**不带 custom** ----------
//
// `dsh-plan-mode` 的判定是严格的（`lib/index.js:286`）：多一项、少一项、或者
// 带上一段 `custom` 文本，都会被读成「继续规划」，文本还会当成反馈回给模型。
{
  const review = planReviewOf([reviewItem])!;
  const answer = planReviewAnswer(review, review.approve.label);
  assert.deepStrictEqual(answer, { id: "plan-review", selected: ["Approve"] });
  assert.ok(!("custom" in answer), "批准不能带 custom（带了就被读成「继续规划」）");

  const decline = planReviewAnswer(review, review.decline!.label);
  assert.strictEqual(decline.selected.length, 1, "拒绝同样恰好一项");
  assert.strictEqual(decline.selected[0], "Keep planning", "发出去的是提问方的 label，不是界面语言");
}
console.log("planReview: 答案恰好一项、不带 custom ✓");

// ---------- 5. 接线：宿主透传 detail/intent，界面发 cancelQuestion ----------
//
// 形状对而线断了，等于什么都没做——这一节按源码结构钉住两端。
{
  const controller = readFileSync(join(APP, "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /detail: item\.detail/.test(controller) && /intent: item\.intent/.test(controller),
    "waterfall 请求的 `detail` / `intent` 必须透传到界面（丢了就只剩一句问句）",
  );

  const cancelBranch = controller.slice(controller.indexOf('case "cancelQuestion"'));
  assert.ok(cancelBranch.length > 0, "控制器要有 cancelQuestion 分支");
  const branch = cancelBranch.slice(0, cancelBranch.indexOf('case "addFiles"'));
  assert.ok(
    /kind: "rejected"/.test(branch) && /code: "ASK_CANCELLED"/.test(branch),
    "「去聊天里说」必须回 rejected + ASK_CANCELLED（不是一份空答案）",
  );
  assert.ok(
    /this\.interactions\.settle\(eventId\);/.test(branch),
    "撤回同样要结算掉未结算请求，否则下次切回来会凭空弹一张过期的卡",
  );

  const ipc = readFileSync(join(APP, "src", "shared", "ipc.ts"), "utf8");
  assert.ok(/type: "cancelQuestion"; requestId: string/.test(ipc), "webview → 宿主要有这条消息");
}
console.log("planReview: detail/intent 透传 + cancelQuestion 接线 ✓");

console.log("\nplanReview: all assertions passed");
