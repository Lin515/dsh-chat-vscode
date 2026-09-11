/**
 * 在光标的插入点插入一段文本，并给出插入后的新光标位置。
 *
 * 纯字符串函数（不碰 DOM），便于离线测试——光标处理很容易写错，而错了以后
 * 表现是「文字粘在一起」或者「光标跑掉」，都很难在代码审查时看出来。
 */

/** 需要在插入内容前补空格吗：前面有内容、且既不是空白结尾。 */
function needPrefix(before: string): boolean {
  return before.length > 0 && !/\s$/.test(before);
}

/** 需要在插入内容后补空格吗：后面还有内容、且不是空白开头。 */
function needSuffix(after: string): boolean {
  return after.length > 0 && !/^\s/.test(after);
}

export interface InsertResult {
  /** 插入后的完整文本。 */
  value: string;
  /** 插入内容之后的光标位置。 */
  caret: number;
}

/**
 * 把 `insert` 放到 `caret` 处。
 *
 * - `caret` 会被夹到 `[0, value.length]`，越界不抛错（调用方可能传来过期的位置）；
 * - 前后按需补一个空格，让插入结果与已有文字自然分开（避免 `text"C:\x"` 粘连）；
 * - 返回的新光标落在插入内容之后，用户可以直接接着打字。
 */
export function insertAtCaret(value: string, insert: string, caret: number): InsertResult {
  const at = Number.isFinite(caret) ? Math.min(Math.max(0, Math.trunc(caret)), value.length) : value.length;
  const before = value.slice(0, at);
  const after = value.slice(at);
  const body = `${needPrefix(before) ? " " : ""}${insert}${needSuffix(after) ? " " : ""}`;
  return { value: `${before}${body}${after}`, caret: before.length + body.length };
}
