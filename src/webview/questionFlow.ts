import type { QuestionAnswerView, QuestionItemView } from "../shared/chat";

/**
 * 问卷（`ask_user_question`）的展示口径：**一次展开**还是**依次问答**。
 *
 * 用户 2026-09-14 的口径：题目少（不超过阈值）时保持原样一次全展开；题目多的时候
 * 一次铺开会把输入区顶掉一大截、还容易漏答，改成一次问一道（上一题 / 下一题）。
 * 阈值是 VS Code 配置 `dshChat.questionBatch`（整数 ≥0，`0` 表示始终全部展开），
 * 由宿主下发到 `ChatState.questionBatch`。
 *
 * 官方 `QuestionComposer` 是**恒分页**的（一次一道 + prev/next + skip），这里刻意
 * 不是它的复刻：短问卷一次看完更省事，这是用户明确选了的行为。
 *
 * 已收场的记录卡原先固定收缩（用户 2026-09-14 口径）；2026-11-05 起同一条阈值也
 * 决定它**默认是否展开**：一次铺得下就直接看当时的问答，铺不下才收缩成一行
 * （见 `recordExpanded`）。点开后的正文也必须按 `questionMode` 逐题复看，而非全铺开。
 *
 * 纯函数、不引 React：断言见 `scripts/questionFlow.test.ts`。
 */

/** 配置缺失或坏值时的默认阈值（与 `package.json` 的 default 一致）。 */
export const DEFAULT_QUESTION_BATCH = 1;

/** 一份问卷的展示模式。 */
export type QuestionMode = "all" | "stepped";

/**
 * 决定这份问卷怎么问。
 *
 * @param total 题目数。
 * @param batch 一次展开的上限（`0` = 始终全部展开；坏值/缺省按默认阈值）。
 */
export function questionMode(total: number, batch: number | undefined): QuestionMode {
  const limit =
    typeof batch === "number" && Number.isInteger(batch) && batch >= 0
      ? batch
      : DEFAULT_QUESTION_BATCH;
  return limit > 0 && total > limit ? "stepped" : "all";
}

/**
 * 已收场的问卷记录卡默认是否展开。
 *
 * 用户 2026-11-05 口径：记录卡也听 `dshChat.questionBatch`——题目能在一次里铺完
 * （不超过阈值，或阈值 `0` = 始终一次展开）时默认展开，直接看当时的问答；超过
 * 阈值仍收缩成一行，点行头复看，免得长问卷一答完就占满屏幕。
 *
 * 两种记录不参与：计划审阅（展开体里是整份计划，体积与题数无关）与已撤回
 * （没有回答可看）。它们保持原来的默认收起。
 */
export function recordOpenByDefault(
  total: number,
  batch: number | undefined,
  kind: { planReview?: boolean; cancelled?: boolean } = {},
): boolean {
  if (kind.planReview === true || kind.cancelled === true) return false;
  return questionMode(total, batch) === "all";
}

/**
 * 记录卡**当前**是否展开。
 *
 * 用户手动开合过（`userOpen` 有值）就听用户的；否则每次渲染都按**当前**阈值重算
 * `recordOpenByDefault`。不能把挂载那一刻的判定冻进 state：配置热更新、首帧
 * `questionBatch` 迟到、或记录卡在旧阈值下挂载过，都会让过期的展开态留在屏幕上。
 * 这里只控制外层开合；展开后的正文分页由 `questionMode` 决定，不能用开合代替分页。
 */
export function recordExpanded(
  total: number,
  batch: number | undefined,
  options: { planReview?: boolean; cancelled?: boolean; userOpen?: boolean } = {},
): boolean {
  if (options.userOpen !== undefined) return options.userOpen;
  return recordOpenByDefault(total, batch, options);
}

/** 单题是否已作答：选中过任一选项，或填了自定义回答。 */
export function isAnswered(
  selected: readonly string[] | undefined,
  custom: string | undefined,
): boolean {
  return (selected?.length ?? 0) > 0 || Boolean(custom?.trim());
}

/** 一份问卷里已作答的题数（收缩后的摘要用）。 */
export function answeredCount(
  items: readonly QuestionItemView[],
  selected: Record<string, string[]>,
  custom: Record<string, string>,
): number {
  return items.filter((item) => isAnswered(selected[item.id], custom[item.id])).length;
}

/**
 * 能否提交：**每一题**都已作答。
 *
 * 依次问答时前面几题可能是「跳过来」的（用户从第 3 题往回翻），所以判据是整份
 * 问卷而不是当前这一题——服务端要的是一批完整答案（`QuestionAnswer` 覆盖全部题目）。
 */
export function canSubmit(
  items: readonly QuestionItemView[],
  selected: Record<string, string[]>,
  custom: Record<string, string>,
): boolean {
  return items.length > 0 && answeredCount(items, selected, custom) === items.length;
}

/**
 * 一道题的答案值：选中的选项 label（按原顺序）+ 非空的自定义回答。
 *
 * 顺序与官方 `replyAnswerValues` 一致（选中项在前、自定义答案补在最后），
 * 自定义文本只去首尾空白，不从中间删字符。
 */
export function answerValues(
  item: QuestionItemView,
  answers: Record<string, QuestionAnswerView> | undefined,
): string[] {
  const answer = answers?.[item.id];
  const custom = answer?.custom?.trim() ?? "";
  return [...(answer?.selected ?? []), ...(custom === "" ? [] : [custom])];
}

/**
 * 问卷记录的**剪贴板载荷**：每题「题头 + 回答」，题与题之间空一行。
 *
 * 口径照官方 `question-reply.ts` 的 `replyClipboardText`：
 * - 题头 = `header — question`（header 与 question 不同才带）或 `question`；
 * - 回答 = `回答：值1, 值2`（多选按原顺序、逗号分隔），没答写「已跳过」；
 * - 与气泡展开与否无关：复制的是完整记录，不是当前可见的那几行。
 *
 * 计划审阅卡复用同一份记录形态，「回答」就是当时的选项值（批准 / 拒绝），照常拼。
 * `labels` 由调用方从词典取，纯函数不引 React，断言见 `scripts/questionFlow.test.ts`。
 */
export function questionReplyText(
  items: readonly QuestionItemView[],
  answers: Record<string, QuestionAnswerView> | undefined,
  labels: { answer: string; skipped: string },
): string {
  return items
    .map((item) => {
      const heading =
        item.header !== undefined && item.header !== "" && item.header !== item.question
          ? `${item.header} — ${item.question}`
          : item.question;
      const values = answerValues(item, answers);
      const answer =
        values.length === 0 ? labels.skipped : `${labels.answer}${values.join(", ")}`;
      return `${heading}\n${answer}`;
    })
    .join("\n\n");
}
