/** 图片执行世界的宿主行为回归；只驱动真控制器方法和 fake transport，不启动 DSH。 */
import assert from "node:assert/strict";
import { ChatController } from "../src/dsh/controller";
import { HostFileAccess } from "../src/dsh/remoteFiles";
import type { HostToWebview, WebviewToHost } from "../src/shared/ipc";

type ImageFrame = Extract<HostToWebview, { type: "images/resolved" }>;
interface Harness {
  client?: object;
  hostFiles?: HostFileAccess;
  hostFileConnections: Map<string, HostFileAccess>;
  listeners: Set<(target: string, frame: HostToWebview) => void>;
  viewSessions: Map<string, string>;
  readyViews: Set<string>;
  copyFailureWatermarks: Map<string, number>;
  pendingNotificationsOpen: boolean;
  viewKinds: Map<string, string>;
  pendingPanelOpens: Map<string, string>;
  scopeOfView(viewId: string): { sessionId: string };
  log(message: string): void;
  snapshotFor(viewId: string): object;
  resumeRestoreHint(viewId: string): Promise<void>;
  hasRestorePending(viewId: string): boolean;
  adoptClient(client: object | undefined): void;
  handle(message: WebviewToHost, viewId: string): Promise<void>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fakeClient(gate?: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }) {
  let reads = 0;
  return {
    get reads() { return reads; },
    async request() {
      reads++;
      return { absolutePath: "/world/chart.png", version: "v1", bytes: 3 };
    },
    async getBytes() {
      gate?.entered.resolve();
      if (gate) await gate.released.promise;
      return { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" };
    },
  };
}
// 跳过构造器的后台依赖，但不替换被测的 adoptClient/handle/emit 方法。
const c = Object.create(ChatController.prototype) as Harness;
const frames: HostToWebview[] = [];
c.listeners = new Set([(_target, frame) => frames.push(frame)]);
c.hostFileConnections = new Map();
c.viewSessions = new Map([["v1", "s1"]]);
c.scopeOfView = () => ({ sessionId: "s1" });
c.log = () => {};
const first = fakeClient();
c.adoptClient(first);
const firstAccess = c.hostFiles!;
assert.equal(frames.at(-1)?.type, "images/scope");
assert.equal((frames.at(-1) as { connectionId: string }).connectionId, firstAccess.connectionId);
const count = frames.length;
c.adoptClient(first);
assert.equal(frames.length, count, "相同客户端不重复换代");
c.adoptClient(undefined);
assert.equal(firstAccess.isClosed, true);
assert.equal((frames.at(-1) as { connectionId: null }).connectionId, null);
const second = fakeClient();
c.adoptClient(second);
const secondId = c.hostFiles!.connectionId;
assert.notEqual(secondId, firstAccess.connectionId);
console.log("image-scope-host: 换连接/断开广播范围，相同client不重复换代 ✓");

const request: Extract<WebviewToHost, { type: "resolveImages" }> = {
  type: "resolveImages", requestId: 1, connectionId: secondId, sessionId: "s1", paths: ["chart.png"],
};
await c.handle(request, "v1");
let response = frames.at(-1) as ImageFrame;
assert.equal(response.urls["chart.png"], "data:image/png;base64,AQID");
assert.equal(response.connectionId, secondId);
assert.equal(response.sessionId, "s1");
const reads = second.reads;
await c.handle({ ...request, requestId: 2, connectionId: firstAccess.connectionId }, "v1");
assert.equal(second.reads, reads, "旧连接请求不得在新执行世界读取");
assert.equal(frames.at(-2)?.type, "images/scope");
response = frames.at(-1) as ImageFrame;
assert.equal(response.connectionId, firstAccess.connectionId);
assert.deepEqual(response.urls, {});
await c.handle({ ...request, requestId: 3, sessionId: "other" }, "v1");
assert.equal(second.reads, reads, "旧会话请求不得读取当前会话");
assert.deepEqual((frames.at(-1) as ImageFrame).urls, {});
console.log("image-scope-host: 请求/回帧绑定连接与会话，旧范围不读取 ✓");
const beforeMalformed = frames.length;
for (const invalid of [
  { ...request, requestId: 0 },
  { ...request, paths: [1] },
  { ...request, connectionId: 7 },
  { ...request, sessionId: null },
]) await c.handle(invalid as unknown as WebviewToHost, "v1");
assert.equal(frames.length, beforeMalformed, "畸形请求不进入图片解析或回帧");
assert.equal(second.reads, reads);
console.log("image-scope-host: 请求号、路径与范围字段逐字段验形状 ✓");

const gate = { entered: deferred(), released: deferred() };
c.adoptClient(fakeClient(gate));
const pendingId = c.hostFiles!.connectionId;
const pending = c.handle({ ...request, requestId: 4, connectionId: pendingId }, "v1");
await gate.entered.promise;
c.adoptClient(fakeClient());
gate.released.resolve();
await pending;
response = frames.at(-1) as ImageFrame;
assert.equal(response.requestId, 4);
assert.equal(response.connectionId, pendingId);
assert.deepEqual(response.urls, {}, "迟到结果只结算原请求，不能泄漏旧图片字节");
console.log("image-scope-host: 在途换代后原请求结算但不回旧字节 ✓");

c.readyViews = new Set();
c.copyFailureWatermarks = new Map();
c.pendingNotificationsOpen = false;
c.viewKinds = new Map();
c.pendingPanelOpens = new Map();
c.snapshotFor = () => ({});
c.resumeRestoreHint = async () => {};
c.hasRestorePending = () => true;
const start = frames.length;
await c.handle({ type: "ready" }, "v1");
assert.equal(frames[start].type, "images/scope");
assert.equal((frames[start] as { connectionId: string }).connectionId, c.hostFiles!.connectionId);
assert.equal(frames[start + 1].type, "state");
console.log("image-scope-host: ready在快照前补发当前连接范围 ✓");
c.adoptClient(undefined);
