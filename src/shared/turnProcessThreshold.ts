/**
 * 连续过程折叠的阈值（`dshChat.turnProcessThreshold`）。
 *
 * 宿主读配置后归一化下发，界面用它折一段连续过程；默认值与「0 / 1–2」的特殊
 * 语义只写在这一份里，两边共用，避免各自漂移。断言见 `scripts/turnProcess.test.ts`
 * （含与 package.json 默认值的对拍）。
 */

/** 默认阈值：一段过程里连着 ≥5 次工具调用（subagent 派发也算）才折成一枚按钮。 */
export const DEFAULT_TURN_PROCESS_THRESHOLD = 5;

/**
 * 宿主读配置后的归一化：**整数 ≥0**，坏值回退默认。
 *
 * 设置页限了 `integer, minimum 0`，但手写 settings.json 能绕开校验（负数、
 * 小数、非数字）——与 `readFontSize` / `readQuestionBatch` 同一条判据纪律：
 * 拿不到肯定证据就用默认值。
 */
export function normalizeTurnProcessThreshold(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_TURN_PROCESS_THRESHOLD;
}

/**
 * 配置值 → 实际生效的阈值：
 *
 * - `0` = **永不折叠**（返回 `Infinity`，任何计数都够不到）；
 * - `1` / `2` = 语义是「永远折叠」，但落地时**只有 1 次工具调用的段照旧平铺**
 *   （一枚按钮只包一行没有意义），所以生效值钉在 2；
 * - `≥3` = 原样生效（达到该次数才折）。
 */
export function effectiveFoldThreshold(configured: number | undefined): number {
  const value = normalizeTurnProcessThreshold(configured);
  if (value === 0) return Number.POSITIVE_INFINITY;
  return Math.max(2, value);
}
