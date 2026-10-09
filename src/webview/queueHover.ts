/**
 * 待发送队列的「单行截断」判据（纯函数，便于离线断言）。
 *
 * 队列每条恒为**单行**（`.queue-text` 的 `white-space: nowrap` + 省略号），正文放不下时
 * 鼠标悬停显示全文。这里只定一件事：**要不要显示**（`queueTextIsClipped`）——判据是
 * **实测溢出**，不是字数阈值：同一段正文在不同字号（`dshChat.fontSize`）、界面倍率、
 * 侧栏宽度下截断点完全不同（用户 2026-10-10 口径）。放得下就**不显示**
 * （没有省略号却弹提示是纯噪音）。
 *
 * 显示形态是**与文件芯片同一套浮窗小字**（原生 `title`，用户 2026-10-10 口径）：
 * 组件只在这一条判为截断时把全文挂上去，没被截断的那条一个字符都不挂。
 *
 * 注意「测量」这一步由调用方注入：jsdom 里 `scrollWidth` / `clientWidth` 恒为 0，
 * 组件注入的是 Range 实测（与 `primitives.tsx` 的 `useClipped`、`Composer.tsx` 的
 * `GoalBar` 截断判定同一套），单测注入固定结果。
 *
 * 拿不到证据（未挂载 / 未布局 / 量不出宽度）一律按「没截断」处理：不显示，而不是猜着显示。
 */

/** 判为「真的被裁」的最小溢出量（px）：亚像素抖动不算截断，与 `primitives.tsx` 的 `useClipped` 同一口径。 */
const CLIP_TOLERANCE_PX = 1;

/**
 * 这条队列消息的正文是否**真的**放不下（需要悬停看全文）。
 *
 * @param text 这一行渲染的文本（纯附件那条是空串，没有可看的全文）。
 * @param available 可见宽度（`clientWidth`）；未布局时是 0。
 * @param measureText 量出该文本的**自然布局宽度**；量不到（未挂载 / 元素不存在）返回 `undefined`。
 *   只在前面几道闸门都过了之后才调用——测量会强制一次同步布局，空正文不值得量。
 */
export function queueTextIsClipped(
  text: string,
  available: number,
  measureText: () => number | undefined,
): boolean {
  if (!text) return false;
  // 可用宽度量不到（未挂载 / 未布局 / 元素被隐藏）：拿不到证据，不显示
  if (!Number.isFinite(available) || available <= 0) return false;
  const natural = measureText();
  if (typeof natural !== "number" || !Number.isFinite(natural) || natural <= 0) return false;
  return natural - available > CLIP_TOLERANCE_PX;
}
