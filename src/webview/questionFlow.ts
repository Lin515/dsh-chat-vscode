import type { QuestionItemView } from "../shared/chat";

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
 * 纯函数、不引 React：断言见 `scripts/questionFlow.test.ts`。
 */

/** 配置缺失或坏值时的默认阈值（与 `package.json` 的 default 一致）。 */
export const DEFAULT_QUESTION_BATCH = 3;

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
