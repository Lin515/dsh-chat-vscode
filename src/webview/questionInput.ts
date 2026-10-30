/**
 * 问卷「自定义回答」输入框的自增高口径。
 *
 * 输入框跟着内容**自动长高**，最多到 5 行；超过 5 行才在框内出现垂直滚动条。
 * 两行由 `rows` 兜底，所以只有一两个字时不会缩成一行。
 *
 * 为什么高度要量出来而不是交给 CSS：`field-sizing: content` 在部分 Electron / 浏览器
 * 版本上不可用，而文本域的高度由行高、内边距与边框共同决定，写死 `max-height` 容易在
 * 字号倍率变化后差半行。这里把「内容高度 → 盒子高度」的算术抽成纯函数，
 * `Rows.tsx` 只负责量 `scrollHeight` 等实际尺寸。
 *
 * 纯函数、不引 React：断言见 `scripts/questionInput.test.ts`。
 */

/** 自定义回答最多自动长到几行；再多就在输入框内部滚动。 */
export const CUSTOM_ANSWER_MAX_LINES = 5;

/** 量出来的输入框几何（单位 px）。 */
export interface CustomAnswerMetrics {
  /** 文本域内容高度（含内边距、不含边框）；未超过下限时是 `rows` 给的基准高度。 */
  scrollHeight: number;
  /** 一行的实际高度（`getComputedStyle` 解析出的 px）。 */
  lineHeight: number;
  paddingTop: number;
  paddingBottom: number;
  borderTopWidth: number;
  borderBottomWidth: number;
}

/** 自增高的结果。 */
export interface CustomAnswerSize {
  /** 该给文本域的 `height`（border-box，取整到 CSS 像素）。 */
  height: number;
  /** 内容是否超过了行数上限——是才出现垂直滚动条。 */
  scroll: boolean;
}

/**
 * 内容高度 → 文本域高度。
 *
 * `scrollHeight` 含内边距，`height` 是 border-box，所以边框要另加；上限按
 * `maxLines` 行内容加内边距、边框算。`scrollHeight` 会取整到整数，而行高可能是
 * 19.5px 这种小数——「正好 5 行」时量出来可能比理论上限多 0.5px，因此判滚动时留
 * 1px 容差，避免第五行刚写满就冒出滚动条。
 */
export function customAnswerSize(
  metrics: CustomAnswerMetrics,
  maxLines: number = CUSTOM_ANSWER_MAX_LINES,
): CustomAnswerSize {
  const lines = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : CUSTOM_ANSWER_MAX_LINES;
  const lineHeight = metrics.lineHeight > 0 ? metrics.lineHeight : 0;
  const padding = metrics.paddingTop + metrics.paddingBottom;
  const border = metrics.borderTopWidth + metrics.borderBottomWidth;
  const maxContent = lineHeight * lines + padding;
  return {
    height: Math.ceil(Math.min(metrics.scrollHeight + border, maxContent + border)),
    scroll: metrics.scrollHeight > maxContent + 1,
  };
}
