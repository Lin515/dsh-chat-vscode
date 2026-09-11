import type { HostToWebview, WebviewToHost } from "../shared/ipc";

/**
 * webview 侧 IPC 客户端。
 *
 * 与 VS Code 的 `acquireVsCodeApi()` 只允许调用一次，因此这里做单例包装，
 * 并把宿主发来的消息分发给订阅者。
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
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

/** 读取 VS Code 为 webview 保留的会话状态（面板重建后恢复草稿等）。 */
export function getPersistedState<T>(): T | undefined {
  return getApi().getState() as T | undefined;
}

export function setPersistedState(state: unknown): void {
  getApi().setState(state);
}

type Listener = (message: HostToWebview) => void;
const listeners = new Set<Listener>();

/** 订阅宿主消息，返回取消订阅函数。 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as HostToWebview | undefined;
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  for (const listener of listeners) listener(message);
});
