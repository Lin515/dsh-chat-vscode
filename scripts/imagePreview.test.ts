/**
 * 原图浮层的缩放 / 拖动几何与接线。
 *
 * 用户 2026-10-25 口径：会话里打开图片后，滚轮向上放大、向下缩小，左键按住可拖动，
 * 右键菜单多一条「复原」。几何是纯函数，能在无头环境里逐条断言；DOM 事件那几条
 * （滚轮必须非被动、拖动只在放大后接管、复原端口真的接到菜单）用源码断言钉住。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMAGE_SCALE_MAX,
  IMAGE_SCALE_MIN,
  bindImagePreviewReset,
  closeImagePreview,
  clampImageView,
  imagePreviewValue,
  openImagePreview,
  panImageView,
  resetImagePreviewView,
  resetImageView,
  subscribeImagePreview,
  zoomImageView,
  type ImagePreviewValue,
  type ImageView,
  type ImageViewGeometry,
} from "../src/webview/imagePreview";

// ---------- 1. 纯几何 ----------

/** 图片在倍率 1 时正好铺满可用区域。 */
const geometry: ImageViewGeometry = {
  width: 1000,
  height: 800,
  viewportWidth: 1000,
  viewportHeight: 800,
};

function view(scale: number, x = 0, y = 0): ImageView {
  return { scale, x, y };
}

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}（实际 ${actual}，期望 ${expected}）`);
}

assert.deepStrictEqual(resetImageView(), { scale: 1, x: 0, y: 0 }, "复原 = 适配视口并居中");

// 滚轮向上（deltaY < 0）放大、向下缩小；0 不改变视角
const wheelUp = zoomImageView(view(1), { x: 0, y: 0 }, -100, geometry);
assert.ok(wheelUp.scale > 1, "滚轮向前 = 放大");
const wheelDown = zoomImageView(view(1), { x: 0, y: 0 }, 100, geometry);
assert.ok(wheelDown.scale < 1, "滚轮向后 = 缩小（适配视口以下也允许）");
assert.ok(wheelDown.scale >= IMAGE_SCALE_MIN, "缩小有下限");
assert.deepStrictEqual(
  zoomImageView(view(1), { x: 0, y: 0 }, 0, geometry),
  { scale: 1, x: 0, y: 0 },
  "deltaY = 0 不动",
);

// 上下限
assert.strictEqual(
  zoomImageView(view(1), { x: 0, y: 0 }, -100000, geometry).scale,
  IMAGE_SCALE_MAX,
  "放大夹在上限",
);
assert.strictEqual(
  zoomImageView(view(1), { x: 0, y: 0 }, 100000, geometry).scale,
  IMAGE_SCALE_MIN,
  "缩小夹在下限",
);

// 锚定光标：缩放前后，光标下的图片细节应留在同一屏幕坐标
{
  const point = { x: 120, y: -60 };
  const before = view(1);
  const after = zoomImageView(before, point, -100, geometry);
  const imageX = (point.x - before.x) / before.scale;
  const imageY = (point.y - before.y) / before.scale;
  near(after.x + after.scale * imageX, point.x, "x 方向锚定光标");
  near(after.y + after.scale * imageY, point.y, "y 方向锚定光标");
}

// 拖动边界：最多把图片多出来的那一半平移出去，两边不会露出空背景
assert.deepStrictEqual(panImageView(view(2), 5000, -5000, geometry), { scale: 2, x: 500, y: -400 });
assert.deepStrictEqual(panImageView(view(2), -5000, 5000, geometry), { scale: 2, x: -500, y: 400 });
assert.deepStrictEqual(
  panImageView(view(1), 120, 80, geometry),
  { scale: 1, x: 0, y: 0 },
  "适配视口时没有可拖余量",
);

// 某个方向放大后仍小于可用区域：该方向必须保持居中
{
  const small: ImageViewGeometry = {
    width: 400,
    height: 300,
    viewportWidth: 1000,
    viewportHeight: 800,
  };
  assert.deepStrictEqual(panImageView(view(2), 300, 300, small), { scale: 2, x: 0, y: 0 });
}

// 非法 / 越界的旧视角在读入时一并夹回合法范围
assert.deepStrictEqual(clampImageView(view(99, 9999, -9999), geometry), {
  scale: IMAGE_SCALE_MAX,
  x: (1000 * IMAGE_SCALE_MAX - 1000) / 2,
  y: -(800 * IMAGE_SCALE_MAX - 800) / 2,
});

// ---------- 2. 开合订阅与「复原」端口 ----------

const seen: (ImagePreviewValue | null)[] = [];
const stop = subscribeImagePreview((next) => seen.push(next));
openImagePreview("data:image/png;base64,abc", "shot.png");
assert.deepStrictEqual(imagePreviewValue(), { src: "data:image/png;base64,abc", alt: "shot.png" });
closeImagePreview();
assert.strictEqual(imagePreviewValue(), null);
assert.deepStrictEqual(seen, [
  { src: "data:image/png;base64,abc", alt: "shot.png" },
  null,
]);
stop();

let resets = 0;
const unbind = bindImagePreviewReset(() => {
  resets += 1;
});
resetImagePreviewView();
assert.strictEqual(resets, 1, "右键「复原」调用浮层登记的动作");
unbind();
resetImagePreviewView();
assert.strictEqual(resets, 1, "浮层卸载后旧的动作不再被调用");

// ---------- 3. 接线：滚轮 / 指针 / 菜单 / 样式 ----------

const root = process.cwd();
const images = readFileSync(join(root, "src", "webview", "components", "Images.tsx"), "utf8");
assert.ok(
  /addEventListener\("wheel", onWheel, \{ passive: false \}\)/.test(images),
  "滚轮要用原生非被动监听：React 的 onWheel 拦不住 webview 滚动",
);
assert.ok(/event\.preventDefault\(\)/.test(images), "滚轮缩放必须吃掉默认滚动 / 缩放");
assert.ok(
  /onPointerDown=\{onPointerDown\}[\s\S]{0,300}onPointerMove=\{onPointerMove\}[\s\S]{0,300}onPointerUp=\{finishDrag\}/.test(
    images,
  ),
  "左键拖动接在图片的指针事件上",
);
assert.ok(
  /if \(event\.button !== 0 \|\| viewRef\.current\.scale <= 1\) return;/.test(images),
  "只接管左键，且只在放大后有可拖余量时才接管",
);
assert.ok(
  /transform: `translate3d\(\$\{view\.x\}px, \$\{view\.y\}px, 0\) scale\(\$\{view\.scale\}\)`/.test(images),
  "视角要通过 transform 落到图片上",
);
assert.ok(/bindImagePreviewReset\(reset\)/.test(images), "浮层要把「复原」动作登记给右键菜单");

const menu = readFileSync(join(root, "src", "webview", "contextMenu.ts"), "utf8");
assert.ok(
  /const inPreview = !!target\.closest\("\.image-preview"\)/.test(menu),
  "只有原图浮层里的图片才给「复原」",
);
assert.ok(
  /\.\.\.\(inPreview[\s\S]{0,200}label: texts\.imageReset[\s\S]{0,120}run: resetImagePreviewView/.test(menu),
  "「复原」接在原图菜单的最前面，并调用浮层端口",
);
assert.ok(!/openContextMenu\(\{[\s\S]{0,200}imageReset/.test(menu), "缩略图的菜单不该出现「复原」");

const css = readFileSync(join(root, "src", "webview", "styles", "app.css"), "utf8");
assert.ok(
  /\.image-preview\s*\{[^}]*cursor:\s*default/s.test(css),
  "浮层背景点一下会关闭预览，光标应是普通箭头，不是缩放光标（用户 2026-10-25 口径）",
);
assert.ok(
  /\.image-preview img\s*\{[^}]*transform-origin:\s*center center/s.test(css),
  "缩放要围绕中心，否则锚点算术对不上",
);
assert.ok(
  /\.image-preview\.is-zoomed img\s*\{[^}]*cursor:\s*move/s.test(css),
  "放大后给可拖动光标（不用被点过名的手掌光标）",
);
assert.ok(
  /\.image-preview\.is-dragging img\s*\{[^}]*cursor:\s*move/s.test(css),
  "拖动期间沿用可移动光标",
);

const messages = readFileSync(join(root, "src", "webview", "messages.ts"), "utf8");
assert.ok(/imageReset: \{ zh: "复原", en: "Reset" \}/.test(messages), "右键「复原」需要中英两份文案");

console.log("imagePreview: 缩放 / 拖动 / 复原与接线 ✓");
