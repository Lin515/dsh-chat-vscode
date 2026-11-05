/**
 * 正文本地图片解析的**范围与回帧**断言（Node 侧，真模块 + 假桥）。
 *
 * 旧的 `imageHydrate.test.ts` 靠手写 DOM 桩驱动 `hydrateLocalImages`；正文改成
 * React 叶节点后水合链已删除，组件状态与时序由主验收在真实浏览器里取 DOM 证据。
 * 这里保留仍然属于生产模块的 loader 约束（不依赖 DOM）：
 *
 * 1. 范围未齐（无连接 / 无会话）不发请求、不缓存失败；
 * 2. 回帧按请求身份结算，读不到的引用记空串、不每帧重问；
 * 3. 同范围同引用只发一条请求（`resolveLocalImage` 去重）；
 * 4. 换范围清缓存、在途请求结算为空、旧范围的迟到帧被拒收；
 * 5. 回帧只认本次问过的键，多带的路径不写缓存；
 * 6. 范围变化通知订阅者（正文叶节点据此重挂）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";

type Handler = (event: unknown) => void;

const windowListeners: Handler[] = [];
(globalThis as { window?: unknown }).window = {
  addEventListener: (type: string, handler: Handler) => {
    if (type === "message") windowListeners.push(handler);
  },
  removeEventListener: () => {},
};

interface SentResolve {
  type: "resolveImages";
  requestId: number;
  connectionId: string | null;
  sessionId: string;
  paths: string[];
}

const sent: SentResolve[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: SentResolve) => sent.push(message),
  getState: () => undefined,
  setState: () => {},
});

const { resolveLocalImage, resolveLocalImages, localImageScopeVersion, subscribeLocalImageScope } =
  await import("../src/webview/localImages");

const push = (frame: unknown): void => {
  for (const handler of windowListeners) handler({ data: JSON.parse(JSON.stringify(frame)) });
};
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};
const lastRequest = (): SentResolve => {
  const request = sent[sent.length - 1];
  assert.ok(request, "应当已经向宿主发过 resolveImages");
  return request;
};
const setScope = (connectionId: string | null, session: string): void => {
  push({ type: "images/scope", connectionId });
  push({ type: "state", state: { session: session ? { id: session } : null } });
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const PNG2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---------- 1. 范围未齐：不发请求 ----------
{
  const before = sent.length;
  const value = await resolveLocalImage("before-scope.png");
  assert.strictEqual(value, undefined, "范围未齐时返回 undefined（叶节点保持在 pending）");
  assert.strictEqual(sent.length, before, "范围未齐不该向宿主发请求");
  assert.ok(localImageScopeVersion() >= 0);
}
console.log("local-image-resolve: 范围未齐不发请求 ✓");

setScope("c1", "s1");

// ---------- 2. 回帧结算与空串负缓存 ----------
{
  const pending = resolveLocalImage("chart.png");
  const request = lastRequest();
  assert.deepStrictEqual(
    { connectionId: request.connectionId, sessionId: request.sessionId, paths: request.paths },
    { connectionId: "c1", sessionId: "s1", paths: ["chart.png"] },
    "请求要带发起时的连接与会话",
  );
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: "c1",
    sessionId: "s1",
    urls: { "chart.png": PNG },
  });
  await settle();
  assert.strictEqual(await pending, PNG, "回帧后拿到 data URL");

  const before = sent.length;
  assert.strictEqual(await resolveLocalImage("chart.png"), PNG, "命中缓存");
  assert.strictEqual(sent.length, before, "缓存命中不再问宿主");
}

{
  const pending = resolveLocalImage("missing.png");
  const request = lastRequest();
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: "c1",
    sessionId: "s1",
    urls: { "missing.png": "" },
  });
  await settle();
  assert.strictEqual(await pending, undefined, "宿主说读不到 → undefined");
  const before = sent.length;
  assert.strictEqual(await resolveLocalImage("missing.png"), undefined);
  assert.strictEqual(sent.length, before, "读不到也要记一笔，不能每帧重问");
}
console.log("local-image-resolve: 回帧结算、缓存命中与空串负缓存 ✓");

// ---------- 3. 同引用在途去重 ----------
{
  const first = resolveLocalImage("same.png");
  const second = resolveLocalImage("same.png");
  const requests = sent.filter((request) => request.paths.includes("same.png"));
  assert.strictEqual(requests.length, 1, "同一引用在同一范围只问一次");
  const request = requests[0]!;
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: "c1",
    sessionId: "s1",
    urls: { "same.png": PNG },
  });
  await settle();
  assert.deepStrictEqual([await first, await second], [PNG, PNG]);
}
console.log("local-image-resolve: 同引用在途去重 ✓");

// ---------- 4. 换范围：清缓存、旧请求结算为空、迟到帧拒收 ----------
{
  const before = localImageScopeVersion();
  let notified = 0;
  const unsubscribe = subscribeLocalImageScope(() => {
    notified += 1;
  });
  const old = resolveLocalImage("late.png");
  const oldRequest = lastRequest();
  setScope("c2", "s1");
  unsubscribe();
  assert.ok(localImageScopeVersion() > before, "换连接要让范围版本前进");
  assert.strictEqual(notified, 1, "订阅者要收到一次范围变化");
  assert.strictEqual(await old, undefined, "在途请求按换范围结算为空，不能永远悬着");

  // 旧范围的迟到回帧：请求已被结算、身份也不符，必须拒收且不写新缓存。
  push({
    type: "images/resolved",
    requestId: oldRequest.requestId,
    connectionId: "c1",
    sessionId: "s1",
    urls: { "late.png": PNG2 },
  });
  await settle();
  const next = resolveLocalImage("late.png");
  const nextRequest = lastRequest();
  assert.strictEqual(nextRequest.connectionId, "c2", "新范围要重新向宿主发请求（旧缓存已清）");
  push({
    type: "images/resolved",
    requestId: nextRequest.requestId,
    connectionId: "c2",
    sessionId: "s1",
    urls: { "late.png": PNG },
  });
  await settle();
  assert.strictEqual(await next, PNG, "新范围的结果生效，旧范围的 PNG2 没有顶替它");
}
console.log("local-image-resolve: 换范围清缓存、旧请求结算、迟到帧拒收 ✓");

// ---------- 5. 回帧只认本次问过的键 ----------
{
  const pending = resolveLocalImages(["asked.png"]);
  const request = lastRequest();
  push({
    type: "images/resolved",
    requestId: request.requestId,
    connectionId: "c2",
    sessionId: "s1",
    urls: { "asked.png": PNG, "not-asked.png": PNG2 },
  });
  await settle();
  assert.deepStrictEqual(await pending, { "asked.png": PNG }, "多带的路径不结算");
  const before = sent.length;
  const unknown = resolveLocalImage("not-asked.png");
  assert.strictEqual(sent.length, before + 1, "多带的路径没有被缓存，仍要向宿主问");
  assert.deepStrictEqual(lastRequest().paths, ["not-asked.png"]);
  push({
    type: "images/resolved",
    requestId: lastRequest().requestId,
    connectionId: "c2",
    sessionId: "s1",
    urls: { "not-asked.png": "" },
  });
  await settle();
  assert.strictEqual(await unknown, undefined);
}
console.log("local-image-resolve: 回帧只认本次问过的键 ✓");

// rc.1：同会话换执行目录也必须失效，包括成功/失败缓存与在途请求。
{
  push({ type: "state", state: { session: { id: "s1", cwd: "/creation" }, workingDirectory: "/first" } });
  const first = resolveLocalImage("relative.png");
  const stale = lastRequest();
  const before = localImageScopeVersion();
  push({ type: "patch", patch: { workingDirectory: "/second" } });
  assert.equal(localImageScopeVersion(), before + 1);
  assert.equal(await first, undefined, "旧目录在途请求必须结算");
  const second = resolveLocalImage("relative.png");
  const current = lastRequest();
  push({ ...stale, type: "images/resolved", urls: { "relative.png": PNG2 } });
  push({ ...current, type: "images/resolved", urls: { "relative.png": PNG } });
  assert.equal(await second, PNG, "旧目录迟到帧不污染同会话的新目录");
  const count = sent.length;
  assert.equal(await resolveLocalImage("relative.png"), PNG);
  assert.equal(sent.length, count, "同目录仍有缓存");
  push({ type: "patch", patch: { workingDirectory: null } });
  const fallback = resolveLocalImage("relative.png");
  assert.equal(sent.length, count + 1, "回退创建目录也重取");
  push({ ...lastRequest(), type: "images/resolved", urls: { "relative.png": "" } });
  assert.equal(await fallback, undefined);
  push({ type: "patch", patch: { workingDirectory: "/creation" } });
  assert.equal(await resolveLocalImage("relative.png"), undefined);
  assert.equal(sent.length, count + 1, "有效目录未变，不重复读取失败缓存");
}

console.log("\nlocal-image-resolve: all assertions passed");
