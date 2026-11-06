/**
 * 轨迹 Result 页「选中工具结果」观察通道的**离线行为回归**。
 *
 * 三层：
 * 1. `DshClient.watchToolResult` 的端点 / 位置参数（对官方 `toolResults/watch`）；
 * 2. 宿主 `createTrajectoryResultWatchManager`：每视图唯一、切换即关旧流、旧 token /
 *    旧 client / 旧 session 迟到帧不透出、`suspendAll` + `resume` 的断线 / 换代语义、
 *    不缓存历史值；
 * 3. webview `createTrajectoryResultWatcher`：`watchId` 过滤、`null/false/0/""/{}` 有效、
 *    `images/scope` 切代先清值并释放观察（不把旧 seq 重发到新服务器）、销毁 unwatch；
 * 4. 真 React mount `useTrajectoryResult`：`this` 绑定、切 seq 的 effect 前渲染不闪旧值、
 *    `images/scope` 清值重开、卸载 unwatch（jsdom + 真 bridge）。
 *
 * 仅私有 `.agent` 打包运行；父代理负责登记 `esbuild.scripts.mjs`。
 */
import assert from "node:assert";
import { createRequire } from "node:module";
import type { HostToWebview, TrajectoryResultFrame, WebviewToHost } from "../src/shared/ipc";
import { DshClient } from "../src/dsh/client";
import {
  createTrajectoryResultWatchManager,
  trajectoryResultValueFromWire,
} from "../src/dsh/trajectoryResultWatch";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as typeof import("jsdom");

/**
 * 真 React mount 需要 DOM；必须先于 `webview/trajectoryResult`（它会导入 bridge）建立
 * 全局 window，否则 bridge 在导入期不会挂 `message` 监听。宿主侧测试不依赖这一步。
 */
const webviewPosts: WebviewToHost[] = [];
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://trajectory-result.test.invalid/",
});
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
globals.HTMLElement = dom.window.HTMLElement;
globals.Element = dom.window.Element;
globals.Node = dom.window.Node;
globals.Event = dom.window.Event;
globals.MessageEvent = dom.window.MessageEvent;
globals.MutationObserver = dom.window.MutationObserver;
globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globals.requestAnimationFrame = (callback: FrameRequestCallback): number =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
globals.cancelAnimationFrame = (handle: number): void => clearTimeout(handle);
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.acquireVsCodeApi = () => ({
  postMessage(message: unknown) {
    webviewPosts.push(message as WebviewToHost);
  },
  setState() {},
});


interface StreamCall {
  sessionId: string;
  seq: number;
  callbacks: {
    onItem(value: unknown): void;
    onEnd?(): void;
    onError?(error: unknown): void;
  };
  cancelled: boolean;
}

/** 假连接：`watchToolResult` 每次开流记一条调用，句柄能验证取消。 */
function fakeClient(label: string) {
  const calls: StreamCall[] = [];
  return {
    label,
    calls,
    watchToolResult(sessionId: string, seq: number, callbacks: StreamCall["callbacks"]) {
      const call: StreamCall = { sessionId, seq, callbacks, cancelled: false };
      calls.push(call);
      return {
        cancel() {
          call.cancelled = true;
        },
      };
    },
  };
}

function lastFrame(frames: TrajectoryResultFrame[]): TrajectoryResultFrame | undefined {
  return frames[frames.length - 1];
}

// ---------- 1. 实际 client wrapper：端点与位置参数 ----------
{
  const client = new DshClient("http://127.0.0.1:9", undefined, () => undefined);
  const opened: { endpoint: string; args: unknown; callbacks: unknown }[] = [];
  (
    client as unknown as {
      openStream(endpoint: string, args: unknown, callbacks: unknown): { cancel(): void };
    }
  ).openStream = (endpoint, args, callbacks) => {
    opened.push({ endpoint, args, callbacks });
    return { cancel() {} };
  };
  const handle = client.watchToolResult("s1", 42, { onItem() {} });
  assert.deepEqual(opened, [
    {
      endpoint: "toolResults/watch",
      args: { request: { sessionId: "s1", seq: 42 } },
      callbacks: opened[0].callbacks,
    },
  ]);
  assert.equal(typeof handle.cancel, "function");
  client.dispose();
}

// ---------- 2. 线格式：available:false 与有效 JSON 值严格分开 ----------
{
  assert.deepEqual(trajectoryResultValueFromWire({ available: false }), { available: false });
  assert.deepEqual(trajectoryResultValueFromWire({ available: true, value: null }), {
    available: true,
    value: null,
  });
  assert.deepEqual(trajectoryResultValueFromWire({ available: true, value: false }), {
    available: true,
    value: false,
  });
  assert.deepEqual(trajectoryResultValueFromWire({ available: true, value: 0 }), {
    available: true,
    value: 0,
  });
  assert.deepEqual(trajectoryResultValueFromWire({ available: true, value: "" }), {
    available: true,
    value: "",
  });
  assert.deepEqual(trajectoryResultValueFromWire({ available: true, value: {} }), {
    available: true,
    value: {},
  });
  assert.equal(trajectoryResultValueFromWire({ available: true }), undefined, "缺 value 是坏帧");
  assert.equal(trajectoryResultValueFromWire({ available: true, value: undefined }), undefined);
  assert.equal(trajectoryResultValueFromWire(null), undefined);
  assert.equal(trajectoryResultValueFromWire([]), undefined);
}

// ---------- 3. 宿主观察者：值、切换、迟到帧、suspend/resume、无缓存 ----------
{
  const manager = createTrajectoryResultWatchManager();
  const emitted: TrajectoryResultFrame[] = [];
  const emit = (frame: TrajectoryResultFrame): void => {
    emitted.push(frame);
  };
  const a = fakeClient("a");
  const b = fakeClient("b");

  manager.observe("v1", 1, "s1", 10, a as never, emit);
  assert.equal(manager.activeCount, 1);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].sessionId, "s1");
  assert.equal(a.calls[0].seq, 10);

  a.calls[0].callbacks.onItem({ available: true, value: null });
  a.calls[0].callbacks.onItem({ available: true, value: false });
  a.calls[0].callbacks.onItem({ available: true, value: 0 });
  a.calls[0].callbacks.onItem({ available: true, value: "" });
  a.calls[0].callbacks.onItem({ available: true, value: {} });
  a.calls[0].callbacks.onItem({ available: true });
  a.calls[0].callbacks.onItem({ available: false });
  assert.deepEqual(
    emitted.map((frame) => (frame.available ? frame.value : "unavailable")),
    [null, false, 0, "", {}, "unavailable"],
    "null / false / 0 / 空串 / 空对象都是有效值；缺 value 的坏帧不产出",
  );

  // 换观察：旧句柄取消，旧 callbacks 迟到帧不透出
  const beforeSwitch = emitted.length;
  manager.observe("v1", 2, "s1", 20, a as never, emit);
  assert.equal(a.calls.length, 2);
  assert.equal(a.calls[0].cancelled, true, "换观察取消旧流");
  a.calls[0].callbacks.onItem({ available: true, value: "old" });
  assert.equal(emitted.length, beforeSwitch, "旧观察的迟到帧不得透出");
  a.calls[1].callbacks.onItem({ available: true, value: "new" });
  assert.deepEqual(lastFrame(emitted), {
    type: "trajectory/result",
    seq: 20,
    watchId: 2,
    available: true,
    value: "new",
  });

  // 迟到的 observe（更小的 watchId）不许把当前观察换回去
  manager.observe("v1", 1, "s1", 99, a as never, emit);
  assert.equal(a.calls.length, 2, "旧 watchId 的 observe 不开新流");
  assert.equal(manager.activeCount, 1);
  a.calls[1].callbacks.onItem({ available: true, value: "still-current" });
  assert.equal(lastFrame(emitted)?.watchId, 2, "当前观察仍是新的 watchId");

  // 迟到的 unwatch 不能关掉当前观察
  manager.close("v1", 1);
  assert.equal(manager.activeCount, 1);
  a.calls[1].callbacks.onItem({ available: true, value: "still-new" });
  assert.equal(lastFrame(emitted)?.value, "still-new");

  // 流 error/end 之后：旧回调的迟到 onItem 不得把旧值重新显示出来
  const beforeGone = emitted.length;
  a.calls[1].callbacks.onError?.({ code: "stream/socket-closed" });
  assert.equal(emitted.length, beforeGone + 1);
  assert.equal(lastFrame(emitted)?.available, false);
  a.calls[1].callbacks.onItem({ available: true, value: "late-after-error" });
  assert.equal(emitted.length, beforeGone + 1, "error 之后旧 onItem 已失效");
  a.calls[1].callbacks.onEnd?.();
  assert.equal(emitted.length, beforeGone + 1, "同一 token 的 end 不重复发");

  manager.close("v1", 2);
  assert.equal(manager.activeCount, 0);
  assert.equal(a.calls[1].cancelled, true);
  assert.deepEqual(lastFrame(emitted), {
    type: "trajectory/result",
    seq: 20,
    watchId: 2,
    available: false,
  }, "close 推 available:false 清值");

  // 关闭后没有缓存：新观察不会回放旧值；旧 callbacks 也不再能写入
  const beforeReopen = emitted.length;
  a.calls[1].callbacks.onItem({ available: true, value: "late-after-close" });
  assert.equal(emitted.length, beforeReopen, "关闭后旧帧被丢弃");
  manager.observe("v1", 3, "s1", 30, a as never, emit);
  assert.equal(emitted.length, beforeReopen, "新观察不缓存 / 不回放历史值");
  a.calls[2].callbacks.onItem({ available: true, value: "fresh" });
  assert.equal(lastFrame(emitted)?.seq, 30);
}

// ---------- 3b. 同步 onError：回调先于 handle 返回也不漏取消 ----------
{
  const manager = createTrajectoryResultWatchManager();
  const emitted: TrajectoryResultFrame[] = [];
  let cancelled = false;
  let lateCallback: { onItem?(value: unknown): void } | undefined;
  const syncFailingClient = {
    watchToolResult(
      _sessionId: string,
      _seq: number,
      callbacks: { onItem(value: unknown): void; onError?(error: unknown): void },
    ) {
      lateCallback = callbacks;
      // 服务端在 `watchToolResult` 返回句柄之前就报错：此时 manager 还没有 handle。
      callbacks.onError?.({ code: "gateway/not-found" });
      return {
        cancel() {
          cancelled = true;
        },
      };
    },
  };
  manager.observe("v1", 1, "s1", 10, syncFailingClient as never, (frame) => emitted.push(frame));
  assert.equal(cancelled, true, "同步报错后返回的句柄被立即取消");
  assert.deepEqual(lastFrame(emitted), {
    type: "trajectory/result",
    seq: 10,
    watchId: 1,
    available: false,
  });
  const afterError = emitted.length;
  lateCallback?.onItem?.({ available: true, value: "late" });
  assert.equal(emitted.length, afterError, "同步 error 之后旧 onItem 不再透出");
  assert.equal(manager.activeCount, 1, "描述保留等 resume");
}

// ---------- 4. suspendAll + resume：同 client 重连重开；换 client / 切会话丢弃 ----------
{
  const manager = createTrajectoryResultWatchManager();
  const emitted: TrajectoryResultFrame[] = [];
  const emit = (frame: TrajectoryResultFrame): void => {
    emitted.push(frame);
  };
  const a = fakeClient("a");
  const b = fakeClient("b");

  manager.observe("v1", 1, "s1", 10, a as never, emit);
  manager.observe("v2", 2, "s2", 20, a as never, emit);
  assert.equal(a.calls.length, 2);
  a.calls[0].callbacks.onItem({ available: true, value: "v1-value" });

  manager.suspendAll();
  assert.equal(manager.activeCount, 2, "suspend 保留描述");
  assert.equal(a.calls[0].cancelled, true);
  assert.equal(a.calls[1].cancelled, true);
  assert.deepEqual(
    emitted.filter((frame) => frame.available === false).map((frame) => frame.watchId),
    [1, 2],
    "suspend 给每条观察推 available:false 清值",
  );
  // 旧流在 suspend 后的迟到帧不能写回
  const beforeLate = emitted.length;
  a.calls[0].callbacks.onItem({ available: true, value: "late" });
  assert.equal(emitted.length, beforeLate);

  // 同 client、仍绑定原会话 → 重开；v2 已切到别的会话 → 关闭
  manager.resume(a as never, (viewId) => (viewId === "v1" ? "s1" : "other"));
  assert.equal(manager.activeCount, 1);
  assert.equal(a.calls.length, 3, "只重开 v1 一条");
  assert.equal(a.calls[2].seq, 10);
  a.calls[2].callbacks.onItem({ available: true, value: "resumed" });
  assert.equal(lastFrame(emitted)?.value, "resumed");

  // 换 client：旧描述必须丢弃，不能把旧 sessionId/seq 订阅到新服务器
  manager.suspendAll();
  manager.resume(b as never, () => "s1");
  assert.equal(manager.activeCount, 0, "换 client 后旧描述全部丢弃");
  assert.equal(b.calls.length, 0, "不向新 client 开旧观察");
  assert.equal(a.calls[2].cancelled, true);

  // closeSession / closeAll
  manager.observe("v3", 3, "s3", 30, a as never, emit);
  manager.observe("v4", 4, "s4", 40, a as never, emit);
  manager.closeSession("s3");
  assert.equal(manager.activeCount, 1);
  assert.equal(a.calls[3].cancelled, true);
  assert.equal(a.calls[4].cancelled, false);
  assert.deepEqual(lastFrame(emitted), {
    type: "trajectory/result",
    seq: 30,
    watchId: 3,
    available: false,
  }, "closeSession 清掉该会话的值");
  manager.closeAll();
  assert.equal(manager.activeCount, 0);
  assert.equal(a.calls[4].cancelled, true);
  assert.deepEqual(lastFrame(emitted), {
    type: "trajectory/result",
    seq: 40,
    watchId: 4,
    available: false,
  }, "closeAll 清掉剩余值");

  // 无连接时 observe：保留描述并立即回 false；恢复时因为描述没有当前 client，必须丢弃，
  // 不能把旧 sessionId/seq 猜着订阅到新连接（界面会按新 scope 重新发观察）。
  const before = emitted.length;
  manager.observe("v5", 5, "s5", 50, undefined, emit);
  assert.equal(manager.activeCount, 1);
  assert.deepEqual(lastFrame(emitted), {
    type: "trajectory/result",
    seq: 50,
    watchId: 5,
    available: false,
  });
  assert.equal(emitted.length, before + 1);
  const callsBeforeResume = a.calls.length;
  manager.resume(a as never, () => "s5");
  assert.equal(manager.activeCount, 0, "没有 client 的描述在 onConnected 丢弃");
  assert.equal(a.calls.length, callsBeforeResume, "不猜旧描述订阅新连接");

  // 界面随后（例如 images/scope 复位后）重新发观察，就能正常接上。
  manager.observe("v5", 6, "s5", 50, a as never, emit);
  assert.equal(manager.activeCount, 1);
  assert.equal(a.calls.length, callsBeforeResume + 1);
  assert.equal(a.calls[callsBeforeResume].seq, 50);

  // 非法参数回一帧 false，不占描述
  manager.observe("", 6, "s6", 60, a as never, emit);
  assert.equal(manager.activeCount, 1);
  assert.equal(lastFrame(emitted)?.available, false);
}

// ---------- 5. webview 观察器：watchId / 有效值 / images-scope / 销毁 ----------
const { createTrajectoryResultWatcher, useTrajectoryResult } = await import("../src/webview/trajectoryResult");
{
  const posts: WebviewToHost[] = [];
  const listeners = new Set<(message: HostToWebview) => void>();
  const watcher = createTrajectoryResultWatcher({
    post: (message) => posts.push(message),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const deliver = (message: HostToWebview): void => {
    for (const listener of listeners) listener(message);
  };
  const watchPosts = (): { type: string; seq?: number; watchId?: number }[] =>
    posts as { type: string; seq?: number; watchId?: number }[];

  watcher.bind(10);
  assert.equal(posts.length, 1);
  const firstWatch = watchPosts()[0];
  assert.deepEqual(firstWatch, { type: "watchTrajectoryResult", seq: 10, watchId: firstWatch.watchId });
  assert.equal(watcher.getSnapshot().available, false);

  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: true, value: null });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: null });
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: true, value: false });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: false });
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: true, value: 0 });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: 0 });
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: true, value: "" });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: "" });
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: true, value: {} });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: {} });

  // 迟到的旧 watchId / 旧 seq 不得覆盖
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId! + 1, available: true, value: "stale" });
  deliver({ type: "trajectory/result", seq: 11, watchId: firstWatch.watchId!, available: true, value: "stale" });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: {} });

  // 缺 value 的坏帧不把有效值清成 undefined
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: true });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: {} });

  // available:false 清值
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: false });
  assert.deepEqual(watcher.getSnapshot(), { available: false });

  // 切 seq：先 unwatch 旧观察、清值、发新观察
  const beforeSeq = posts.length;
  watcher.bind(20);
  assert.equal(posts.length, beforeSeq + 2);
  assert.deepEqual(watchPosts()[beforeSeq], { type: "unwatchTrajectoryResult", watchId: firstWatch.watchId! });
  const secondWatch = watchPosts()[beforeSeq + 1];
  assert.deepEqual(secondWatch, { type: "watchTrajectoryResult", seq: 20, watchId: secondWatch.watchId });
  assert.equal(watcher.getSnapshot().available, false, "切 seq 立刻清旧值，不闪上一条结果");

  // 旧观察的迟到帧不得写进新观察
  deliver({ type: "trajectory/result", seq: 10, watchId: firstWatch.watchId!, available: true, value: "old" });
  assert.equal(watcher.getSnapshot().available, false);
  deliver({ type: "trajectory/result", seq: 20, watchId: secondWatch.watchId!, available: true, value: "new" });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: "new" });

  // images/scope 首帧只记认；换代先清值再重开
  deliver({ type: "images/scope", connectionId: "c1" });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: "new" }, "首个 scope 不清值");
  const beforeScope = posts.length;
  deliver({ type: "images/scope", connectionId: "c2" });
  assert.equal(watcher.getSnapshot().available, false, "换代同一刻清旧值（无过期 flash）");
  assert.equal(posts.length, beforeScope + 1, "换代只 unwatch 旧观察，不把旧 seq 订阅到新连接");
  assert.deepEqual(watchPosts()[beforeScope], { type: "unwatchTrajectoryResult", watchId: secondWatch.watchId });
  deliver({ type: "trajectory/result", seq: 20, watchId: secondWatch.watchId!, available: true, value: "old-connection" });
  assert.equal(watcher.getSnapshot().available, false, "旧连接 / 旧 watchId 帧被丢弃");

  // 新连接必须由界面重新选择才会重新订阅（这里模拟 Inspector 先清空再选中）。
  watcher.bind(undefined);
  watcher.bind(20);
  const thirdWatch = watchPosts()[posts.length - 1];
  assert.deepEqual(thirdWatch, { type: "watchTrajectoryResult", seq: 20, watchId: thirdWatch.watchId });
  deliver({ type: "trajectory/result", seq: 20, watchId: thirdWatch.watchId!, available: true, value: "fresh" });
  assert.deepEqual(watcher.getSnapshot(), { available: true, value: "fresh" });

  // 同一连接号重复通知不重开
  const beforeSameScope = posts.length;
  deliver({ type: "images/scope", connectionId: "c2" });
  assert.equal(posts.length, beforeSameScope, "同连接号不清值、不重开");

  // bind(undefined) / dispose：清值并 unwatch
  const beforeUnbind = posts.length;
  watcher.bind(undefined);
  assert.equal(watcher.getSnapshot().available, false);
  assert.equal(posts.length, beforeUnbind + 1);
  assert.deepEqual(watchPosts()[beforeUnbind], { type: "unwatchTrajectoryResult", watchId: thirdWatch.watchId });

  watcher.bind(30);
  const finalWatch = watchPosts()[posts.length - 1];
  watcher.dispose();
  assert.deepEqual(watchPosts()[posts.length - 1], { type: "unwatchTrajectoryResult", watchId: finalWatch.watchId });
  const afterDispose = posts.length;
  deliver({ type: "trajectory/result", seq: 30, watchId: finalWatch.watchId!, available: true, value: "late" });
  assert.equal(posts.length, afterDispose, "dispose 后不再发帧");
  watcher.bind(40);
  assert.equal(posts.length, afterDispose, "dispose 后 bind 不再开观察（迟到的回调也不能复活）");
  deliver({ type: "trajectory/result", seq: 40, watchId: finalWatch.watchId!, available: true, value: "late-bind" });
  assert.equal(watcher.getSnapshot().available, false, "dispose 后的 onMessage 被忽略");
}

// ---------- 6. 真 React mount：hook 的 this / 切 seq 不闪旧值 / scope / 卸载 ----------
{
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react-dom/test-utils");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const renders: { seq: number | undefined; view: { available: boolean; value?: unknown } }[] = [];

  function Probe({ seq }: { seq: number | undefined }) {
    const view = useTrajectoryResult(seq);
    renders.push({ seq, view });
    return React.createElement("div", null, view.available ? JSON.stringify(view.value) : "unavailable");
  }

  const dispatch = (frame: HostToWebview): void => {
    // 与 webview 里 bridge 的 `window.addEventListener("message")` 同一条路径。
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: frame }));
  };
  const watchMessages = (): Extract<WebviewToHost, { type: "watchTrajectoryResult" }>[] =>
    webviewPosts.filter(
      (message): message is Extract<WebviewToHost, { type: "watchTrajectoryResult" }> =>
        message.type === "watchTrajectoryResult",
    );
  const unwatchMessages = (): Extract<WebviewToHost, { type: "unwatchTrajectoryResult" }>[] =>
    webviewPosts.filter(
      (message): message is Extract<WebviewToHost, { type: "unwatchTrajectoryResult" }> =>
        message.type === "unwatchTrajectoryResult",
    );

  await act(async () => {
    root.render(React.createElement(Probe, { seq: 10 }));
  });
  const firstWatch = watchMessages().at(-1);
  assert.ok(firstWatch, "hook mount 后发出观察");
  assert.equal(firstWatch.seq, 10);
  assert.equal(renders.at(-1)?.view.available, false);

  // 真 bridge 回帧；`this` 没绑定的话 useSyncExternalStore 这里会直接崩。
  await act(async () => {
    dispatch({
      type: "trajectory/result",
      seq: 10,
      watchId: firstWatch.watchId,
      available: true,
      value: null,
    });
  });
  assert.deepEqual(renders.at(-1)?.view, { available: true, value: null });
  assert.equal(container.textContent, "null", "JSON null 也是有效结果");

  // 切 seq：effect 前的首次渲染不得带上一 seq 的旧值（不闪「上一条结果」）
  renders.length = 0;
  await act(async () => {
    root.render(React.createElement(Probe, { seq: 20 }));
  });
  assert.ok(renders.length > 0);
  assert.ok(
    renders.every((render) => render.view.available === false),
    "切 seq 的 effect 前渲染也不得返回上一 seq 的值",
  );
  const secondWatch = watchMessages().at(-1);
  assert.ok(secondWatch);
  assert.equal(secondWatch.seq, 20);
  const watchCountAfterSecond = watchMessages().length;
  assert.ok(
    unwatchMessages().some((message) => message.watchId === firstWatch.watchId),
    "切 seq 先释放旧观察",
  );

  // images/scope：首个连接号只记认；换代同一刻清值并重开
  await act(async () => {
    dispatch({
      type: "trajectory/result",
      seq: 20,
      watchId: secondWatch.watchId,
      available: true,
      value: "twenty",
    });
  });
  assert.equal(renders.at(-1)?.view.value, "twenty");
  await act(async () => {
    dispatch({ type: "images/scope", connectionId: "c1" });
  });
  assert.equal(renders.at(-1)?.view.value, "twenty", "首个 scope 不清值");
  await act(async () => {
    dispatch({ type: "images/scope", connectionId: "c2" });
  });
  assert.equal(renders.at(-1)?.view.available, false, "换代同一刻清值（无过期 flash）");
  assert.equal(watchMessages().length, watchCountAfterSecond, "换代不把旧 seq 订阅到新连接");
  assert.ok(
    unwatchMessages().some((message) => message.watchId === secondWatch.watchId),
    "换代释放旧观察",
  );

  // 新连接必须由界面重新选择（Inspector 先清空再选中）才会重新订阅。
  await act(async () => {
    root.render(React.createElement(Probe, { seq: undefined }));
  });
  await act(async () => {
    root.render(React.createElement(Probe, { seq: 20 }));
  });
  const thirdWatch = watchMessages().at(-1);
  assert.ok(thirdWatch);
  assert.equal(thirdWatch.seq, 20);
  assert.notEqual(thirdWatch.watchId, secondWatch.watchId, "重新选择后用新 watchId");

  await act(async () => {
    dispatch({
      type: "trajectory/result",
      seq: 20,
      watchId: thirdWatch.watchId,
      available: true,
      value: false,
    });
  });
  assert.deepEqual(renders.at(-1)?.view, { available: true, value: false }, "false 也是有效结果");

  // seq undefined：不订阅、不返回上一 seq 的值
  renders.length = 0;
  const watchCountBefore = watchMessages().length;
  await act(async () => {
    root.render(React.createElement(Probe, { seq: undefined }));
  });
  assert.ok(renders.every((render) => render.view.available === false));
  assert.ok(
    unwatchMessages().some((message) => message.watchId === thirdWatch.watchId),
    "seq undefined 释放当前观察",
  );
  await act(async () => {
    dispatch({ type: "images/scope", connectionId: "c3" });
  });
  assert.equal(watchMessages().length, watchCountBefore, "seq undefined 时 scope 变化不订阅");

  // 卸载：释放当前观察
  await act(async () => {
    root.render(React.createElement(Probe, { seq: 30 }));
  });
  const lastWatch = watchMessages().at(-1);
  assert.ok(lastWatch);
  await act(async () => {
    root.unmount();
  });
  assert.ok(
    unwatchMessages().some((message) => message.watchId === lastWatch.watchId),
    "卸载 unwatch",
  );
  dom.window.document.body.removeChild(container);
}

// ---------- 7. 真 controller：会话身份、ready 重置 watchId、生命周期清理、teardown/resume ----------
{
  const { ChatController } = await import("../src/dsh/controller");
  const { SessionScope } = await import("../src/dsh/scope");
  const fakeServer = () => ({
    externalUrl: undefined,
    commandConfigured: true,
    onHeartbeat() {},
    dispose() {},
    snapshot() {
      return { status: { info: undefined }, supervisorAlive: false };
    },
  });
  const fakeMemento = () => {
    const map = new Map<string, unknown>();
    return {
      get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      keys: () => [...map.keys()],
    };
  };
  const makeControllerClient = () => ({
    calls: [] as StreamCall[],
    watchToolResult(sessionId: string, seq: number, callbacks: StreamCall["callbacks"]) {
      const call: StreamCall = { sessionId, seq, callbacks, cancelled: false };
      this.calls.push(call);
      return { cancel() { call.cancelled = true; } };
    },
    followSession: () => ({ cancel() {} }),
    followJobs: () => ({ cancel() {} }),
    followControl: () => ({ cancel() {} }),
    openEvents: () => ({ cancel() {} }),
    openStream: () => ({ cancel() {} }),
    dispose() {},
    async listSessions() {
      return { items: [] };
    },
    async request() {
      return undefined;
    },
    async getJson() {
      return undefined;
    },
    async settingsDescribe() {
      return { namespaces: [] };
    },
    async sessionProjections() {
      return { values: {} };
    },
  });

  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: { target: string; frame: Record<string, unknown> }[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame: frame as never }));
  const c = controller as unknown as {
    client: unknown;
    connection: string;
    viewSessions: Map<string, string>;
    scopes: Map<string, unknown>;
    trajectoryResults: { activeCount: number };
    resumeRestoreHint(viewId: string): Promise<void>;
    ensureSession(...args: unknown[]): Promise<unknown>;
    refreshSessions(): Promise<void>;
    adoptBlankForUnboundViews(): Promise<void>;
    refreshSubagentCatalog(): void;
    readGoalActivation(): void;
    loadAgentPresets(): void;
    loadPermissionCatalog(): void;
    refreshWorkspace(): void;
    openControlStream(): void;
    openEventsStream(): void;
    openWorkspaceStream(): void;
    teardownStreams(): void;
    onConnected(): Promise<void>;
    detachView(viewId: string): void;
    handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  };
  const clientA = makeControllerClient();
  c.client = clientA as never;
  c.connection = "connected";
  c.viewSessions.set("v1", "s1");
  c.scopes.set("s1", new SessionScope("s1"));
  // `ready` 尾巴上与本通道无关的恢复 / 建壳链：这里只验证 ready 先 close 本视图观察。
  c.resumeRestoreHint = async () => undefined;
  c.ensureSession = async () => undefined;

  const trajectoryFrames = (): Record<string, unknown>[] =>
    frames.map((entry) => entry.frame).filter((frame) => frame.type === "trajectory/result");

  await c.handle({ type: "watchTrajectoryResult", seq: 10, watchId: 1 }, "v1");
  assert.equal(clientA.calls.length, 1);
  assert.equal(clientA.calls[0].sessionId, "s1", "会话身份取宿主绑定，不信任消息里没有的 session");
  assert.equal(clientA.calls[0].seq, 10);
  clientA.calls[0].callbacks.onItem({ available: true, value: "old" });
  assert.equal(trajectoryFrames().at(-1)?.value, "old");

  // WebView 重载：URL 不变、viewId 不变，watchId 从 1 重新数。ready 必须先释放旧观察，
  // 否则 manager 看到「新 watchId=1 < 旧 watchId」会把新页面的观察永远拒掉。
  await c.handle({ type: "ready" }, "v1");
  assert.equal(clientA.calls[0].cancelled, true, "ready 释放旧页面的流");
  const afterReady = trajectoryFrames().length;
  clientA.calls[0].callbacks.onItem({ available: true, value: "old-page-late" });
  assert.equal(trajectoryFrames().length, afterReady, "旧页面回调不能写新页面");

  await c.handle({ type: "watchTrajectoryResult", seq: 20, watchId: 1 }, "v1");
  assert.equal(clientA.calls.length, 2);
  assert.equal(clientA.calls[1].sessionId, "s1");
  assert.equal(clientA.calls[1].seq, 20);
  clientA.calls[1].callbacks.onItem({ available: true, value: "new-page" });
  assert.equal(trajectoryFrames().at(-1)?.value, "new-page");

  // 迟到的 unwatch（错号）不能关当前观察
  await c.handle({ type: "unwatchTrajectoryResult", watchId: 99 }, "v1");
  assert.equal(clientA.calls[1].cancelled, false);
  await c.handle({ type: "unwatchTrajectoryResult", watchId: 1 }, "v1");
  assert.equal(clientA.calls[1].cancelled, true);

  // unbindView / detachView：关 view 即释放并清值
  await c.handle({ type: "watchTrajectoryResult", seq: 30, watchId: 2 }, "v1");
  controller.unbindView("v1");
  assert.equal(clientA.calls[2].cancelled, true, "unbindView 释放观察");
  const afterUnbind = trajectoryFrames().at(-1);
  assert.equal(afterUnbind?.watchId, 2);
  assert.equal(afterUnbind?.available, false, "unbindView 清值");

  c.viewSessions.set("v1", "s1");
  c.scopes.set("s1", new SessionScope("s1"));
  await c.handle({ type: "watchTrajectoryResult", seq: 40, watchId: 3 }, "v1");
  c.detachView("v1");
  assert.equal(clientA.calls[3].cancelled, true, "detachView 释放观察");
  assert.equal(trajectoryFrames().at(-1)?.watchId, 3);
  assert.equal(trajectoryFrames().at(-1)?.available, false, "detachView 清值");

  // teardownStreams + onConnected：同一 client 恢复；换 client 不恢复
  c.viewSessions.set("v1", "s1");
  c.scopes.set("s1", new SessionScope("s1"));
  await c.handle({ type: "watchTrajectoryResult", seq: 50, watchId: 4 }, "v1");
  c.scopes.clear();
  const beforeSuspend = clientA.calls.length;
  c.teardownStreams();
  assert.equal(clientA.calls[beforeSuspend - 1].cancelled, true, "teardown 取消观察流");
  assert.equal(trajectoryFrames().at(-1)?.available, false, "teardown 清值");
  assert.equal(c.trajectoryResults.activeCount, 1, "suspendAll 保留描述");

  c.refreshSessions = async () => undefined;
  c.adoptBlankForUnboundViews = async () => undefined;
  c.refreshSubagentCatalog = () => undefined;
  c.readGoalActivation = () => undefined;
  c.loadAgentPresets = () => undefined;
  c.loadPermissionCatalog = () => undefined;
  c.refreshWorkspace = () => undefined;
  c.openControlStream = () => undefined;
  c.openEventsStream = () => undefined;
  c.openWorkspaceStream = () => undefined;
  await c.onConnected();
  assert.equal(clientA.calls.length, beforeSuspend + 1, "同 client 的 onConnected 重开观察");
  assert.equal(clientA.calls.at(-1)?.seq, 50);
  assert.equal(clientA.calls.at(-1)?.sessionId, "s1");

  const clientB = makeControllerClient();
  c.client = clientB as never;
  c.teardownStreams();
  await c.onConnected();
  assert.equal(clientB.calls.length, 0, "换 client 不把旧 seq 订阅到新服务器");
  assert.equal(c.trajectoryResults.activeCount, 0, "换 client 丢弃旧描述");
  controller.dispose();
}

console.log("trajectoryResultWatch: client 端点参数 ✓");
console.log("trajectoryResultWatch: 线格式 null / false / 0 / 空串 / 空对象 ✓");
console.log("trajectoryResultWatch: 切换 / 迟到 token/client/session 隔离 ✓");
console.log("trajectoryResultWatch: suspendAll + resume / closeSession / 无缓存 ✓");
console.log("trajectoryResultWatch: webview watchId / images-scope / 销毁 ✓");
console.log("trajectoryResultWatch: React mount hook / 切 seq 不闪旧值 / 卸载 ✓");
console.log("trajectoryResultWatch: 真 controller ready/watchId / unbind/detach / teardown/resume ✓");
// JSDOM 自己会留消息循环 / 事件目标；React 18 的调度器在 Node 里还会留一个
// MessageChannel。离线脚本没有收尾队列可等，断言全部通过后显式退出，避免
// `npm test` 的 runner 一直等这一套（失败仍会在上面的 assert 处抛非零退出）。
dom.window.close();
console.log("\ntrajectoryResultWatch: all assertions passed");
process.exit(0);
