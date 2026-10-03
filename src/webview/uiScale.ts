import { createContext, useContext } from "react";

/**
 * 界面尺度（见 `docs/adr/0004-ui-scale-design-pixels.md`）：
 *
 * - **设计像素**是「在基准字号下量出来的尺寸」。CSS 侧由 `tokens.css` 的 `.app` 从
 *   `--font-size` 推导 `--dp`，几何量一律写成 `calc(N * var(--dp))`；
 * - JS 侧（响应式阈值、拖动范围、按序号算出来的刻点位置）算不出 CSS 的倍率，
 *   所以由 `App` 把同一个倍率放进 context，要用的组件 `useUiScale()` 取。
 *
 * 两边必须是同一个数：`UI_SCALE_BASE_PX` 与 `tokens.css` 里那条
 * `--ui-scale: calc(var(--font-size) / 13px)` 的分母由断言看守
 * （`scripts/styles.test.ts`）。
 */

/** 基准字号（px）：13 既是设计基准，也是 VS Code 给 webview 注入的 `--vscode-font-size`。 */
export const UI_SCALE_BASE_PX = 13;

/** 字号配置 → 界面倍率。auto（`0`／拿不到值）是 1，即与基准字号下完全一致。 */
export function uiScaleOf(fontSizePx: number | null | undefined): number {
  return typeof fontSizePx === "number" && fontSizePx >= 8 ? fontSizePx / UI_SCALE_BASE_PX : 1;
}

/** 设计像素 → 实际像素。JS 里算尺寸（阈值、范围、位置）一律从它过一道。 */
export function dp(designPx: number, scale: number): number {
  return designPx * scale;
}

/**
 * 设计像素 → CSS 长度，给 inline style 用。SVG 的尺寸只能这么给：`width` 属性收不下
 * `calc()`，写成 px 又钉死了。`--dp` 是「一个设计像素」的实际长度，见 tokens.css。
 */
export function dpLength(designPx: number): string {
  return `calc(${String(designPx)} * var(--dp))`;
}

/** `App` 提供的倍率；不在 provider 之下时是 1（与 auto 同义）。 */
export const UiScaleContext = createContext(1);

export function useUiScale(): number {
  return useContext(UiScaleContext);
}
