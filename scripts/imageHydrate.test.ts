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
 * 钉住这些事：
 * 1. 回帧之前的失败**不算数**（本文件存在的原因）；
 * 2. 宿主回答「读不到」时照旧降级（降级不能因为 1 而失效）；
 * 3. 换成 data URL 之后再失败才是真失败，照样降级；
 * 4. 外链（不问宿主）的失败照旧即刻降级；
 * 5. 范围（执行世界连接 + 会话）未齐时不发请求也不降级；齐了才问；
 * 6. 同一会话换连接：旧缓存作废、重新请求（成功与失败两条都钉）；
 * 7. 换范围时在途请求结算成空表——旧闭包不写新缓存，旧帧也拒不进来；
 * 8. 回帧只认本次问过的键，多带的路径不许写进缓存；
 * 9. 回帧带着请求时的 connectionId / sessionId，对不上就拒收。
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

interface SentResolve {
  type: "resolveImages";
  requestId: number;
  connectionId: string | null;
  sessionId: string;
  paths: string[];
}

/** webview → 宿主的帧（断言「问了宿主什么」）。 */
const sent: SentResolve[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: SentResolve) => sent.push(message),
  getState: () => undefined,
  setState: () => {},
});

const { hydrateLocalImages, localImageScopeVersion, subscribeLocalImageScope } = await import(
  "../src/webview/localImages"
);
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

/** 宿主的两条范围帧：连接（`images/scope`）与会话（首次 `state`）。 */
const setScope = (connectionId: string | null, session: string): void => {
  push({ type: "images/scope", connectionId });
  push({
    type: "state",
    state: { session: session ? { id: session } : null },
  });
};

/** 最近一条 `resolveImages`。 */
const lastRequest = (): SentResolve => {
  const request = sent[sent.length - 1];
  assert.ok(request, "应当已经向宿主发过 resolveImages");
  return request;
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const PNG2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// 初始范围：执行世界连接 c1 + 会话 s1
setScope("c1", "s1");

// ---------- 1. 回帧之前的失败不算数（本文件存在的原因） ----------
{
  const root = new FakeRoot();
  const image = root.addImage("out/chart.png");
  const before = sent.length;
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "本地引用要问宿主读字节");
  const request = lastRequest();
  assert.deepStrictEqual(request.paths, ["out/chart.png"], "问的是引用原文");
  assert.strictEqual(request.connectionId, "c1", "请求要带当前执行世界连接");
  assert.strictEqual(request.sessionId, "s1", "请求要带当前会话");

  // 浏览器对原始引用的失败（webview 里必然发生：CSP 拦下 / 404）
  root.fireError(image);
  assert.strictEqual(
    image.replaced,
    null,
    "宿主还没回帧，浏览器这次失败不能降级——降级了数据 URL 回来也贴不上（本地图显示不出来的成因）",
  );

  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: request.connectionId,
    sessionId: request.sessionId,
    urls: { "out/chart.png": PNG },
  });
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
  const request = lastRequest();
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: request.connectionId,
    sessionId: request.sessionId,
    urls: {},
  });
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
  const request = lastRequest();
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: request.connectionId,
    sessionId: request.sessionId,
    urls: { "after.png": PNG },
  });
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

// ---------- 5. 范围未齐：不发请求、不降级；齐了才问 ----------
{
  // 连接刚断（换代会明确发 null）：此时问宿主也不会有结果
  setScope(null, "s1");
  const root = new FakeRoot();
  const image = root.addImage("pending/a.png");
  const before = sent.length;
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before, "范围未齐（没有执行世界连接）时不该发请求");
  root.fireError(image);
  assert.strictEqual(image.replaced, null, "范围未齐时浏览器这次失败同样不是结论，不能先降级");

  // 连接到位：重新水合（正文块换范围时会重设 innerHTML 再调一次）
  setScope("c1", "s1");
  const retry = new FakeRoot();
  const retried = retry.addImage("pending/a.png");
  hydrateLocalImages(retry as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "范围齐了要重新问宿主");
  const request = lastRequest();
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: request.connectionId,
    sessionId: request.sessionId,
    urls: { "pending/a.png": PNG },
  });
  await settle();
  assert.strictEqual(retried.getAttribute("src"), PNG, "范围齐了之后要贴得上 data URL");
  console.log("image-hydrate: 范围未齐不发请求/不降级，齐了重新解析 ✓");
}

// ---------- 6. 同一会话换连接：旧缓存作废、重新请求（成功） ----------
{
  const root = new FakeRoot();
  const image = root.addImage("conn/a.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const first = lastRequest();
  push({
    type: "images/resolved",
    requestId: first.requestId,
    connectionId: first.connectionId,
    sessionId: first.sessionId,
    urls: { "conn/a.png": PNG },
  });
  await settle();
  assert.strictEqual(image.getAttribute("src"), PNG);

  // 执行世界换代（会话不变）：同名相对路径在另一条连接里是另一个文件
  push({ type: "images/scope", connectionId: "c2" });
  const next = new FakeRoot();
  const nextImage = next.addImage("conn/a.png");
  const before = sent.length;
  hydrateLocalImages(next as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "换连接后缓存必须清空，同名引用要重新问宿主");
  const second = lastRequest();
  assert.strictEqual(second.connectionId, "c2", "新请求带新连接");
  assert.strictEqual(second.sessionId, "s1", "会话没变");
  push({
    type: "images/resolved",
    requestId: second.requestId,
    connectionId: second.connectionId,
    sessionId: second.sessionId,
    urls: { "conn/a.png": PNG2 },
  });
  await settle();
  assert.strictEqual(nextImage.getAttribute("src"), PNG2, "要用新连接解析出来的字节，不是旧缓存的");
  console.log("image-hydrate: 同会话换连接清缓存并重新解析（成功） ✓");
}

// ---------- 6b. 同一会话换连接：旧成功结果不能顶替新连接的失败 ----------
{
  // 当前范围是 c2 / s1（上一段留下），先让 b.png 在 c2 下成功一次
  const root = new FakeRoot();
  const image = root.addImage("conn/b.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const first = lastRequest();
  push({
    type: "images/resolved",
    requestId: first.requestId,
    connectionId: first.connectionId,
    sessionId: first.sessionId,
    urls: { "conn/b.png": PNG },
  });
  await settle();
  assert.strictEqual(image.getAttribute("src"), PNG);

  // 换代到 c3，且这次宿主读不到
  push({ type: "images/scope", connectionId: "c3" });
  const next = new FakeRoot();
  const nextImage = next.addImage("conn/b.png");
  hydrateLocalImages(next as unknown as HTMLElement, texts);
  const second = lastRequest();
  assert.strictEqual(second.connectionId, "c3");
  push({
    type: "images/resolved",
    requestId: second.requestId,
    connectionId: second.connectionId,
    sessionId: second.sessionId,
    urls: {},
  });
  await settle();
  assert.ok(
    nextImage.replaced,
    "新连接下读不到就要降级——不能拿旧连接那次成功的结果（/cache）充数",
  );
  assert.strictEqual(nextImage.replaced?.textContent, texts.imageLoadFailedAt("conn/b.png"));
  console.log("image-hydrate: 同会话换连接后失败不沿用旧成功结果 ✓");
}

// ---------- 6c. 同一会话换连接：旧连接的失败（空串负缓存）同样作废 ----------
{
  // 当前范围是 c3 / s1（上一段留下）。先让 c3 下读不到（负缓存写空串）
  const root = new FakeRoot();
  const image = root.addImage("conn/c.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const first = lastRequest();
  assert.strictEqual(first.connectionId, "c3");
  push({
    type: "images/resolved",
    requestId: first.requestId,
    connectionId: first.connectionId,
    sessionId: first.sessionId,
    urls: {},
  });
  await settle();
  assert.ok(image.replaced, "c3 下读不到：当场降级");

  // 负缓存确实立住了：同一范围里再水合不会再问
  const cached = new FakeRoot();
  cached.addImage("conn/c.png");
  const beforeCache = sent.length;
  hydrateLocalImages(cached as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, beforeCache, "读不到也长记性（负缓存），同范围不重问");

  // 换代到 c4：空串也必须跟着作废，重新问宿主并贴上新连接的字节
  push({ type: "images/scope", connectionId: "c4" });
  const next = new FakeRoot();
  const nextImage = next.addImage("conn/c.png");
  const before = sent.length;
  hydrateLocalImages(next as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "换连接后负缓存（空串）不能继续命中，要重新问宿主");
  const second = lastRequest();
  assert.strictEqual(second.connectionId, "c4", "新请求带新连接");
  assert.strictEqual(second.sessionId, "s1");
  push({
    type: "images/resolved",
    requestId: second.requestId,
    connectionId: second.connectionId,
    sessionId: second.sessionId,
    urls: { "conn/c.png": PNG },
  });
  await settle();
  assert.strictEqual(nextImage.getAttribute("src"), PNG, "旧连接读不到不等于新连接读不到");
  assert.strictEqual(nextImage.replaced, null, "新连接成功时不该有降级占位");
  console.log("image-hydrate: 同会话换连接后旧失败负缓存作废（失败→成功） ✓");
}

// ---------- 7. 换范围时在途请求结算为空表，旧帧作废 ----------
{
  // 当前范围是 c4 / s1（上一段收尾在 c4）
  const root = new FakeRoot();
  const image = root.addImage("inflight/a.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const stale = lastRequest();
  assert.strictEqual(stale.connectionId, "c4");

  // 换连接：在途请求必须结算（否则调用方的 .then 永远悬着），且结果为空表
  push({ type: "images/scope", connectionId: "c5" });
  await settle();
  assert.ok(image.replaced, "旧范围的请求结算成空表，等它的图要落到降级，而不是一直悬着");

  // 迟到的旧帧：请求号已不在在途表里，不得写进新缓存
  push({
    type: "images/resolved",
    requestId: stale.requestId,
    connectionId: "c4",
    sessionId: "s1",
    urls: { "inflight/a.png": PNG },
  });
  await settle();

  const retry = new FakeRoot();
  const retried = retry.addImage("inflight/a.png");
  const before = sent.length;
  hydrateLocalImages(retry as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "迟到帧不许命中缓存，新范围必须重新问宿主");
  const fresh = lastRequest();
  assert.strictEqual(fresh.connectionId, "c5");
  push({
    type: "images/resolved",
    requestId: fresh.requestId,
    connectionId: fresh.connectionId,
    sessionId: fresh.sessionId,
    urls: { "inflight/a.png": PNG2 },
  });
  await settle();
  assert.strictEqual(retried.getAttribute("src"), PNG2, "新范围用新结果，不被旧帧污染");
  console.log("image-hydrate: 在途结算为空表 + 迟到帧拒收，不污染新缓存 ✓");
}

// ---------- 8. 回帧身份对不上：拒收并按新连接重新问 ----------
{
  // 当前范围是 c5 / s1
  const root = new FakeRoot();
  const image = root.addImage("scope/mismatch.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const request = lastRequest();
  assert.strictEqual(request.connectionId, "c5");
  // 回帧带的是另一条连接：不是这次请求的答案
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: "c1",
    sessionId: request.sessionId,
    urls: { "scope/mismatch.png": PNG },
  });
  await settle();
  assert.ok(image.replaced, "身份对不上的回帧要当空表结算（落到降级），不能贴别人的字节");

  const retry = new FakeRoot();
  const retried = retry.addImage("scope/mismatch.png");
  const before = sent.length;
  hydrateLocalImages(retry as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "被拒收的结果不得进缓存");
  assert.strictEqual(lastRequest().connectionId, "c5");
  assert.strictEqual(retried.replaced, null, "重新问的过程中不该先降级");
  console.log("image-hydrate: 回帧连接不对即拒收、不写缓存 ✓");
}

// ---------- 9. 只缓存本次问过的键（多带的路径不信） ----------
{
  const root = new FakeRoot();
  const image = root.addImage("extra/asked.png");
  hydrateLocalImages(root as unknown as HTMLElement, texts);
  const request = lastRequest();
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: request.connectionId,
    sessionId: request.sessionId,
    urls: { "extra/asked.png": PNG, "extra/other.png": PNG2 },
  });
  await settle();
  assert.strictEqual(image.getAttribute("src"), PNG);

  const other = new FakeRoot();
  const otherImage = other.addImage("extra/other.png");
  const before = sent.length;
  hydrateLocalImages(other as unknown as HTMLElement, texts);
  assert.strictEqual(sent.length, before + 1, "回帧里多带的路径不属于本次请求，不许当缓存命中");
  assert.notStrictEqual(otherImage.getAttribute("src"), PNG2);
  console.log("image-hydrate: 回帧只认本次问过的键 ✓");
}

// ---------- 10. 范围版本通知：订阅者（正文块 / 图库）必须被叫醒 ----------
{
  // 组件侧的重新水合靠这个版本号：`useSyncExternalStore` 订阅它，正文块据它重设
  // innerHTML、图库据它丢弃旧 urls。版本不涨，跨范围就永远停在旧结论上。
  let notified = 0;
  const unsubscribe = subscribeLocalImageScope(() => {
    notified += 1;
  });
  // 先落到一个已知范围（这一段之前的用例停在别的连接上）
  setScope("scope-a", "s1");
  notified = 0;
  const start = localImageScopeVersion();

  // 同一范围重复通知不涨版本（宿主 recovery 会重发 scope）
  push({ type: "images/scope", connectionId: "scope-a" });
  assert.strictEqual(notified, 0, "范围没变不该叫醒订阅者");
  assert.strictEqual(localImageScopeVersion(), start);

  // 换连接：版本 +1 且订阅者被叫醒
  push({ type: "images/scope", connectionId: "scope-b" });
  assert.strictEqual(notified, 1, "换连接要叫醒订阅者");
  assert.strictEqual(localImageScopeVersion(), start + 1, "范围版本必须递增，组件才重新水合");

  // 换会话（patch 帧里带 session）：同样算换范围
  push({ type: "patch", patch: { session: { id: "s2", title: "另一个会话" } } });
  assert.strictEqual(notified, 2, "切会话（patch 帧）也要叫醒订阅者");
  assert.strictEqual(localImageScopeVersion(), start + 2);

  // patch 里没有 session 键：不是换会话，版本不动
  push({ type: "patch", patch: { running: true } });
  assert.strictEqual(localImageScopeVersion(), start + 2, "与范围无关的 patch 不该动版本");

  unsubscribe();
  push({ type: "images/scope", connectionId: "scope-c" });
  assert.strictEqual(notified, 2, "退订之后不再通知");
  console.log("image-hydrate: 范围版本递增并通知订阅者（正文/图库据此重新水合） ✓");
}

console.log("\nimage-hydrate: all assertions passed");