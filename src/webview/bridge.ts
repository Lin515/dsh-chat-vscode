import type { HostToWebview, WebviewToHost } from "../shared/ipc";
import type { PersistedState } from "../shared/chat";

/**
 * webview 侧 IPC 客户端。
 *
 * 与 VS Code 的 `acquireVsCodeApi()` 只允许调用一次，因此这里做单例包装，
 * 并把宿主发来的消息分发给订阅者。
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
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

/**
 * 把「这个窗口开着哪条会话」存进 VS Code 的 webview state。
 *
 * 这是**身份**，不是界面状态：宿主恢复编辑区面板时（`deserializeWebviewPanel` 的
 * `state`）据此认回自己的会话，而不是靠 VS Code 恢复面板的顺序去猜——顺序对不上
 * 就是两个标签的会话交叉（用户 2026-09-21 报的）。webview 无从得知 host 侧的绑定，
 * 所以由界面把当前会话 id 写下来（`App.tsx` 在会话变化时调它）。
 *
 * 正在看**子代理会话**时把它的地址一起写（`subagent`）：子代理不进会话列表，
 * 恢复只有靠这个地址才能重新进入。存成 `{ identity: { sessionId } }` 而不是裸
 * 字符串：以后要加字段（比如草稿）时旧数据仍能被识别成同一个形状。
 */
export function persistIdentity(
  sessionId: string | undefined,
  subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" },
): void {
  const state: PersistedState = {
    identity: { sessionId: sessionId ?? null, ...(subagent ? { subagent } : {}) },
  };
  getApi().setState(state);
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
