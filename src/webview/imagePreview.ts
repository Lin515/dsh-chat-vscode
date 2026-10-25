/**
 * 原图浮层的状态与缩放 / 拖动几何。
 *
 * 浮层挂在 App 根部一次，打开它的入口却有两个（缩略图与 markdown 里注入的图片），
 * 所以开合状态走模块级订阅，而不是组件的 props 树。**几何只在 `Images.tsx` 的浮层里
 * 执行**，这里只放不碰 DOM 的纯函数，便于离线断言滚轮方向、边界与复位。
 *
 * 三个约定的理由：
 * - **1 = 适配视口**：浮层里的 `<img>` 受 `max-width/height: 100%` 约束，所以倍率 1
 *   就是「整张图刚好放进可用区域」。复原回到 1，而不是回到图片的固有像素尺寸。
 * - **允许缩到 1 以下**：滚轮向下永远有反馈（用户 2026-10-25 口径「前滚放大、后滚
 *   缩小」）。缩小时图片仍居中，不产生可拖动余量。
 * - **放大时锚定光标**：以光标在图片上的那一点为中心缩放，避免每滚一格都要再把图
 *   拖回来。平移范围限制在「放大后的图片仍铺满可用区域」以内，图不会被拖丢。
 */

/** 打开浮层的那张图。 */
export interface ImagePreviewValue {
  src: string;
  /** 无障碍文本（也是右键菜单建议文件名的来源之一）。 */
  alt: string;
}

/** 浮层视角：`x` / `y` 是相对居中的平移量（CSS 像素），`scale` 是倍率。 */
export interface ImageView {
  scale: number;
  x: number;
  y: number;
}

/**
 * 缩放 / 平移所需的几何。
 *
 * `width` / `height` 是图片在倍率 1 时的**布局尺寸**（未受 transform 影响）；
 * `viewportWidth` / `viewportHeight` 是浮层内容区（去掉内边距）的尺寸。
 */
export interface ImageViewGeometry {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** 缩放下限：仍能辨认图片，同时保证「滚轮向下」在适配视口后也有反馈。 */
export const IMAGE_SCALE_MIN = 0.25;
/** 缩放上限：再大只会看到插值放大的马赛克。 */
export const IMAGE_SCALE_MAX = 8;

/** 滚轮灵敏度：一格（约 100）约 16%，触控板的小增量会自然累加。 */
const WHEEL_SENSITIVITY = 0.0015;

/** 复原视角：适配视口、居中。 */
export function resetImageView(): ImageView {
  return { scale: 1, x: 0, y: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把视角收进合法范围：倍率夹在上下限内，平移量不超过图片放大后多出来的那一半。
 *
 * 某个方向放大后仍小于可用区域时，该方向只能居中（`x` / `y` 为 0）——否则会出现
 * 图片被拖到角落、另一侧留一大片空背景的观感。
 */
export function clampImageView(view: ImageView, geometry: ImageViewGeometry): ImageView {
  const scale = clamp(view.scale, IMAGE_SCALE_MIN, IMAGE_SCALE_MAX);
  const maxX = Math.max(0, (geometry.width * scale - geometry.viewportWidth) / 2);
  const maxY = Math.max(0, (geometry.height * scale - geometry.viewportHeight) / 2);
  return {
    scale,
    x: clamp(view.x, -maxX, maxX),
    y: clamp(view.y, -maxY, maxY),
  };
}

/**
 * 滚轮缩放。
 *
 * `point` 是光标相对**图片基准中心**（也就是可用区域中心）的坐标。缩放后同一个图片
 * 细节仍停在光标下：
 *
 * `x' = point.x - (scale' / scale) * (point.x - x)`
 *
 * 向上滚（`deltaY < 0`）放大，向下滚缩小；到上下限时视角原样返回（不产生无意义的重绘）。
 */
export function zoomImageView(
  view: ImageView,
  point: { x: number; y: number },
  deltaY: number,
  geometry: ImageViewGeometry,
): ImageView {
  const current = clampImageView(view, geometry);
  if (!Number.isFinite(deltaY) || deltaY === 0) return current;
  const scale = clamp(
    current.scale * Math.exp(-deltaY * WHEEL_SENSITIVITY),
    IMAGE_SCALE_MIN,
    IMAGE_SCALE_MAX,
  );
  if (scale === current.scale) return current;
  const ratio = scale / current.scale;
  return clampImageView(
    {
      scale,
      x: point.x - ratio * (point.x - current.x),
      y: point.y - ratio * (point.y - current.y),
    },
    geometry,
  );
}

/** 左键拖动：`dx` / `dy` 是本次指针移动的增量，结果仍受合法范围约束。 */
export function panImageView(
  view: ImageView,
  dx: number,
  dy: number,
  geometry: ImageViewGeometry,
): ImageView {
  return clampImageView({ ...view, x: view.x + dx, y: view.y + dy }, geometry);
}

// ---------- 浮层开合（模块级订阅） ----------

let value: ImagePreviewValue | null = null;
const listeners = new Set<(value: ImagePreviewValue | null) => void>();

/** 打开原图浮层。 */
export function openImagePreview(src: string, alt: string): void {
  value = { src, alt };
  for (const listener of listeners) listener(value);
}

/** 关掉原图浮层（点背景 / 关闭按钮 / ESC 都走这里）。 */
export function closeImagePreview(): void {
  value = null;
  for (const listener of listeners) listener(null);
}

export function subscribeImagePreview(listener: (value: ImagePreviewValue | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function imagePreviewValue(): ImagePreviewValue | null {
  return value;
}

// ---------- 「复原」端口 ----------

let resetAction: (() => void) | null = null;

/**
 * 登记浮层的「复原」动作（原图浮层挂载期间有效）。
 *
 * 右键菜单在页面级接取，拿不到浮层组件的 state，所以由浮层把动作登记到这里；
 * 返回的清理函数与 React effect 的生命周期对齐，卸载后菜单不会再调到一个旧实例。
 */
export function bindImagePreviewReset(action: () => void): () => void {
  resetAction = action;
  return () => {
    if (resetAction === action) resetAction = null;
  };
}

/** 复原当前原图的缩放与平移（右键菜单「复原」）。 */
export function resetImagePreviewView(): void {
  resetAction?.();
}
