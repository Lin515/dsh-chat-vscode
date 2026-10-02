/**
 * 正文里本地图片的**水合**断言（Node 侧，用手写的 DOM 桩驱动真模块）。
 *
 * 这条链路此前没有可断言的缝：`hydrateLocalImages` 要 DOM，无头环境里没有，
 * 所以它的行为只在预览页肉眼看过。而它恰好是「本地图明明文件还在却显示加载失败」
 * 的现场——**浏览器对原始引用那次失败比宿主回帧早**：
 *
 * - `<img src="out/chart.png">` 在 webview 里必然加载不了（相对路径落到
 *   `vscode-webview://…`，CSP 的 `img-src` 里也没有它），失败事件毫秒级就到；
 * - 宿主要走「IPC → 读盘 → base64 → 回帧」（一张几十 KB 的图实测 15~60ms）；
 * - 于是降级文案先落地：`replaceWith` 之后 `<img>` 已经不在文档里，数据 URL
 *   回来时改的是那个被换下去的元素——用户永远看不到图，只看到「图片加载失败」。
 *
 * 这里用手写的 DOM 桩把那条时序复现出来（`fireError` 就是浏览器那次失败），
 * 钉住四件事：
 * 1. 回帧之前的失败**不算数**（本文件存在的原因）；
 * 2. 宿主回答「读不到」时照旧降级（降级不能因为 1 而失效）；
 * 3. 换成 data URL 之后再失败才是真失败，照样降级；
 * 4. 外链（不问宿主）的失败照旧即刻降级。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";

// ---------- 手写 DOM 桩 ----------
//
// `bridge.ts` 在模块求值期挂 `window.addEventListener`，并在发送时取
// `acquireVsCodeApi()`；`hydrateLocalImages` 用到 `document.createElement`、
// `image instanceof HTMLImageElement`、`dataset`、`replaceWith`。只补这些面。

type Handler = (event: unknown) => void;

class FakeElement {
  readonly attrs = new Map<string, string>();
  className = "";
  textContent: string | null = null;
  title = "";
  parent: FakeRoot | null = null;
  /** 被 `replaceWith` 换下去时记下换成了谁（断言「有没有降级」的判据）。 */
  replaced: FakeElement | null = null;

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  replaceWith(node: FakeElement): void {
    const parent = this.parent;
    if (parent) {
      const at = parent.images.indexOf(this as unknown as FakeImage);
      if (at >= 0) parent.images.splice(at, 1);
      parent.children.push(node);
    }
    node.parent = parent;
    this.parent = null;
    this.replaced = node;
  }
}

class FakeImage extends FakeElement {
  readonly dataset: Record<string, string> = {};
}

class FakeRoot {
  readonly children: FakeElement[] = [];
  readonly images: FakeImage[] = [];
  private readonly listeners = new Map<string, Handler[]>();

  addEventListener(type: string, handler: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: Handler): void {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((entry) => entry !== handler));
  }

  querySelectorAll(selector: string): FakeImage[] {
    return selector === "img" ? [...this.images] : [];
  }

  /** 模拟浏览器：某张图的加载失败（`img` 的 error 不冒泡，只能在捕获阶段接）。 */
  fireError(target: FakeImage): void {
    for (const handler of this.listeners.get("error") ?? []) handler({ target });
  }

  /** 挂一张 `<img>`（等价于 React 用 innerHTML 放进正文的那一步）。 */
  addImage(src: string): FakeImage {
    const image = new FakeImage();
    image.setAttribute("src", src);
    image.parent = this;
    this.children.push(image);
    this.images.push(image);
    return image;
  }
}

const windowListeners: Handler[] = [];
(globalThis as { window?: unknown }).window = {
  addEventListener: (type: string, handler: Handler) => {
    if (type === "message") windowListeners.push(handler);
  },
  removeEventListener: () => {},
};
(globalThis as { HTMLImageElement?: unknown }).HTMLImageElement = FakeImage;
(globalThis as { document?: unknown }).document = {
  createElement: () => new FakeElement(),
};

/** webview → 宿主的帧（断言「问了宿主什么」）。 */
const sent: { type: string; requestId: number; paths: string[] }[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: { type: string; requestId: number; paths: string[] }) => sent.push(message),
  getState: () => undefined,
  setState: () => {},
});

const { hydrateLocalImages } = await import("../src/webview/localImages");
const { dictionaryFor } = await import("../src/webview/texts");

const texts = dictionaryFor("zh");
/** 宿主回帧（过一遍 JSON，与真实线格式同）。 */
const push = (frame: unknown): void => {
  for (const handler of windowListeners) handler({ data: JSON.parse(JSON.stringify(frame)) });
};
/** 让 `resolveLocalImages` 的 promise 结算。 */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

// ---------- 1. 回帧之前的失败不算数（本文件存在的原因） ----------
{
  const root = new FakeRoot();
  const image = root.addImage("out/chart.png");
  const before = sent.length;
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "本地引用要问宿主读字节");
  assert.deepStrictEqual(sent[sent.length - 1].paths, ["out/chart.png"], "问的是引用原文");

  // 浏览器对原始引用的失败（webview 里必然发生：CSP 拦下 / 404）
  root.fireError(image);
  assert.strictEqual(
    image.replaced,
    null,
    "宿主还没回帧，浏览器这次失败不能降级——降级了数据 URL 回来也贴不上（本地图显示不出来的成因）",
  );

  const requestId = sent[sent.length - 1].requestId;
  push({ type: "images/resolved", requestId, urls: { "out/chart.png": PNG } });
  await settle();
  assert.strictEqual(image.getAttribute("src"), PNG, "宿主回帧后 `src` 要换成 data URL");
  assert.strictEqual(image.replaced, null, "换成了 data URL 就不该有降级文案");
  console.log("image-hydrate: 宿主回帧之前的失败不降级 ✓");
}

// ---------- 1b. 缓存命中：不再问宿主，直接贴 data URL ----------
{
  const root = new FakeRoot();
  const image = root.addImage("out/chart.png");
  const before = sent.length;
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before, "同一引用已在缓存里，不该再问一遍宿主");
  assert.strictEqual(image.getAttribute("src"), PNG, "缓存命中要当场换 src");
  console.log("image-hydrate: 缓存命中直接换 src ✓");
}

// ---------- 2. 宿主说读不到：照旧降级 ----------
{
  const root = new FakeRoot();
  const image = root.addImage("gone.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const requestId = sent[sent.length - 1].requestId;
  push({ type: "images/resolved", requestId, urls: {} });
  await settle();
  assert.ok(image.replaced, "宿主读不到（越界/被删/超上限）必须降级，而不是留一个破图");
  assert.strictEqual(
    image.replaced.textContent,
    texts.imageLoadFailedAt("gone.png"),
    "降级文案要说清是哪一张",
  );
  assert.strictEqual(image.replaced.title, "gone.png", "悬停仍给原样的引用");
  assert.strictEqual(image.replaced.className, "image-failed", "复用既有的降级样式");
  console.log("image-hydrate: 宿主读不到照旧降级（带引用） ✓");
}

// ---------- 3. data URL 之后再失败：那才是真失败 ----------
{
  const root = new FakeRoot();
  const image = root.addImage("after.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const requestId = sent[sent.length - 1].requestId;
  push({ type: "images/resolved", requestId, urls: { "after.png": PNG } });
  await settle();
  root.fireError(image);
  assert.ok(image.replaced, "已经贴了 data URL 还失败（字节坏了）就该降级——等待期只是免死金牌，不是永久豁免");
  assert.strictEqual(image.replaced.textContent, texts.imageLoadFailedAt("after.png"));
  console.log("image-hydrate: 贴了字节之后的失败照旧降级 ✓");
}

// ---------- 4. 外链：不问宿主，失败即刻降级 ----------
{
  const root = new FakeRoot();
  const image = root.addImage("https://example.com/a.png");
  const before = sent.length;
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before, "外链由浏览器/CSP 管，不该问宿主读盘");
  root.fireError(image);
  assert.ok(image.replaced, "外链被 CSP 拦 / 404 要降级（这条待遇没被上面的免死金牌改掉）");
  assert.strictEqual(image.replaced.textContent, texts.imageLoadFailedAt("https://example.com/a.png"));
  console.log("image-hydrate: 外链失败即刻降级 ✓");
}

console.log("\nimage-hydrate: all assertions passed");
