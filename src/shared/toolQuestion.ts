/**
 * `ask_user_question` 的**问卷事实**：从「调用参数 + 工具结果」两份 durable 材料里
 * 折出题目与答案。
 *
 * 为什么要单独一份：这张问卷记录此前只由 waterfall 建（`adapter.addQuestion`），
 * 而 waterfall 不是 durable 事件——会话重载（窗口重载 / 切走再切回 / 重连）之后
 * 跟随流只重放会话日志，卡片折不出来，界面上只剩一个工具行（用户 2026-09-24 报的
 * 「问卷回答节点消失」）。而**题目在调用参数里、答案在工具结果里**，两份都在日志里，
 * 所以记录可以、也应该从它们折出来。
 *
 * 线格式（`@deepseek-ai/dsh-tool-ask-user`）：
 * - 参数：`{questions:[{id, question, header?, options?:[{label, description?}], multi_select?}]}`
 *   —— 注意参数里的多选键是**下划线** `multi_select`，视图里叫 `multiSelect`；
 * - 结果正文：`JSON.stringify({answers:[{id, selected, custom?}]})`（工具的 `output.render`）。
 *
 * 两份都按**保守**解析：形状不对一律 `undefined`（宁可退回通用工具行，也不画半截卡）。
 * 模型的参数只带这四个字段——工具 `execute` 把它们映射进提问请求时**丢掉了**别的键
 * （`detail` / `intent` 不会到服务端），所以这里也不从参数里读它们。
 *
 * 纯函数、不引宿主：断言见 `scripts/toolQuestion.test.ts`。
 */
import type { QuestionAnswerView, QuestionItemView, QuestionOption } from "./chat";
import { parseToolArgs } from "./toolCard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 一组题目的**身份**：题目 id 排序后 JSON 编码（顺序无关，且 id 里出现任何字符
 * 都不会与另一组串味——拼接字符串时 `["a","b"]` 与 `["a\u0000b"]` 会撞成同一个键）。
 *
 * 结果里只有题目 id 与答案，没有提问本身的身份，所以「这份答案属于哪次提问」
 * 只能按 id 集合对上（`adapter` 的问答收场与承载者匹配都用它）。
 */
export function questionKeyOf(items: readonly { id: string }[]): string {
  return JSON.stringify(items.map((item) => item.id).sort());
}

/** 选项数组；没给算空表，形状不对返回 null（整份参数作废）。 */
function optionsOf(value: unknown): QuestionOption[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const options: QuestionOption[] = [];
  for (const option of value) {
    if (!isRecord(option)) return null;
    const { label, description } = option;
    if (typeof label !== "string" || label === "") return null;
    if (description !== undefined && typeof description !== "string") return null;
    options.push({ label, ...(description === undefined ? {} : { description }) });
  }
  return options;
}

/**
 * 解析调用参数里的题目；认不出来返回 `undefined`（调用方据此退回通用工具行）。
 *
 * 题目 id 必须非空且**不重复**：id 是答案的唯一对位方式，重复就没法把答案配回题目。
 */
export function questionItemsFromArgs(argsRaw: string): QuestionItemView[] | undefined {
  const args = parseToolArgs(argsRaw);
  const questions = args?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const items: QuestionItemView[] = [];
  const ids = new Set<string>();
  for (const question of questions) {
    if (!isRecord(question)) return undefined;
    const { id, question: text, header, options, multi_select } = question;
    if (typeof id !== "string" || id === "" || ids.has(id)) return undefined;
    if (typeof text !== "string") return undefined;
    if (header !== undefined && typeof header !== "string") return undefined;
    if (multi_select !== undefined && typeof multi_select !== "boolean") return undefined;
    const parsedOptions = optionsOf(options);
    if (parsedOptions === null) return undefined;
    ids.add(id);
    items.push({
      id,
      question: text,
      ...(header === undefined ? {} : { header }),
      options: parsedOptions,
      ...(multi_select === undefined ? {} : { multiSelect: multi_select }),
    });
  }
  return items;
}

/**
 * 解析工具结果里的答案（按题目 id 归档）；认不出来返回 `undefined`。
 *
 * 与「结果里恰好没有答案」分开：`{answers:[]}` 与形状不对都算认不出来——调用方
 * 据此不认领这次结果（别的工具恰好返回同形状 JSON 也不能被当成答案）。
 * 空字符串的 `custom` 不留这个键：过线时 `undefined` 会被丢掉，留一个
 * `custom: ""` 只会让两边的形状对不上（与既有的 `answersByQuestionId` 同口径）。
 */
export function questionAnswersFromResult(text: string): Record<string, QuestionAnswerView> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // 结果正文整体就是一个 JSON 对象；前后可能包着别的行，按首尾花括号截取兜住
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.answers)) return undefined;
  const answers: Record<string, QuestionAnswerView> = {};
  for (const item of value.answers) {
    if (!isRecord(item)) return undefined;
    const { id, selected, custom } = item;
    if (typeof id !== "string" || id === "" || answers[id] !== undefined) return undefined;
    if (!Array.isArray(selected) || !selected.every((label) => typeof label === "string")) return undefined;
    if (custom !== undefined && typeof custom !== "string") return undefined;
    answers[id] = {
      selected: [...(selected as string[])],
      ...(typeof custom === "string" && custom ? { custom } : {}),
    };
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}
