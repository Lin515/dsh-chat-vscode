import { createContext, useContext } from "react";

/**
 * 界面尺度（见 `docs/design-ui-scale.md`）：
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
 * 线宽（刻线、描边这类一两个像素厚的几何量）：设计像素 → **整 CSS 像素**，至少 1px。
 *
 * `lineThickness(2, 16 / 13)` → `2`（设计值 2.4615）。为什么必须取整：小数线宽落到光栅化器
 * 手里，会**按每一枚所在的位置**就近取整——同一串刻线于是有的画 2 个设备像素、有的画 3 个，
 * 看上去粗细不匀（用户 2026-10-13 报「轮次多了以后每根目录条厚度有点不一致」）。取整到
 * 整 CSS 像素后，同一档位的每一枚都画成同样厚。
 *
 * 取舍（有实测的像素证据，不是猜）：也可以取整到「整设备像素」，但那在 DPR 2 上更差——
 * 设计值 2.4615 CSS px 就近取整到 5 个设备像素（2.5 CSS px），实测同一档位画成 4～6 个
 * 设备像素；整 CSS 像素的 2px（= 4 个设备像素）则每一枚都是 4。DPR 1.25／1.75 这类
 * 非整数缩放下属两难：1 个设备像素 = 51.2/64 CSS px，布局单位（1/64 CSS px）表达不出，
 * 落格的值反而差出一整像素，所以这里一律走整 CSS 像素，代价是小数缩放下仍有
 * 约 0.2～0.4 个设备像素的边缘差异（远小于取整前的整像素跳变）。
 */
export function lineThickness(designPx: number, scale: number): number {
  return Math.max(1, Math.round(designPx * scale));
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
