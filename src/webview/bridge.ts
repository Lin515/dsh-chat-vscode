import type { HostToWebview, WebviewToHost } from "../shared/ipc";

/**
 * webview 侧 IPC 客户端。
 *
 * 与 VS Code 的 `acquireVsCodeApi()` 只允许调用一次，因此这里做单例包装，
 * 并把宿主发来的消息分发给订阅者。
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

function getApi(): VsCodeApi {
  api ??= acquireVsCodeApi();
  return api;
}

/** 向宿主发送一条请求。 */
export function post(message: WebviewToHost): void {
  getApi().postMessage(message);
}

type Listener = (message: HostToWebview) => void;
const listeners = new Set<Listener>();

/** 订阅宿主消息，返回取消订阅函数。 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type FrameListener = () => void;
const frameListeners = new Set<FrameListener>();

/**
 * 订阅「宿主来过一帧」。
 *
 * 只表示"内容可能变了"，不携带数据——给自动滚动之类"变了就重新判定一次"的场景用：
 * 帧到达是**早于渲染**的信号，不必等 ResizeObserver 的时序（那条路会漏掉"内容变了
 * 但容器高度没变"以及某些没被观察到的布局变动）。
 */
export function onHostFrame(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as HostToWebview | undefined;
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  for (const listener of frameListeners) listener();
  for (const listener of listeners) listener(message);
});
