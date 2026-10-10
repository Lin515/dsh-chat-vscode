import type { ChatState } from "../shared/chat";
import type { Texts } from "./texts";

/**
 * 发送手势与主按钮文案的唯一出处：按钮文字、点击手势、按住态监听都由这里给。
 *
 * 用户 2026-10-10 口径：按住 Ctrl（macOS 上 Cmd）时按钮文字换成**这一次真会走的那条路**，
 * 按住修饰键点按钮发的是加速手势 `"accelerated"`。键盘 Ctrl/Cmd + Enter 本来就是加速
 * 手势，那一行在 `composerCompletion.tsx`（不归本模块改）——两处是**同一条判据**。
 *
 * 两个不能动的边界：
 * - **界面只发手势，不发模式**：加速手势最终是 queue 还是 steer，由宿主按
 *   `ui-conversation.busyEnter` + 「按下那一刻在不在跑」解析（官方 `resolveSubmitMode`）。
 *   `busySubmitIntent` 算的只是**给用户看的文字预告**，它的结果绝不进 `send` 帧。
 * - **点击手势读事件当下的修饰键**，不读渲染期那份 `modifierHeld` 快照：按住 / 松开与
 *   点击之间没有重渲染的保证，用快照会点错手势。
 */

/** 发送手势：与官方 `ComposerSubmitGesture` 同名同义（宿主据此解析 queue / steer）。 */
export type SubmitGesture = "enter" | "accelerated";

/** 只读修饰键的**事件最小面**：真事件（`KeyboardEvent` / React 的 `MouseEvent`）都满足它。 */
export interface ModifierEvent {
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * `watchModifierKeys` 需要的最小宿主面（`window` 满足它；离线回归喂一个替身）。
 *
 * 监听参数按 DOM 的 `Event` 收（`window.addEventListener` 的签名如此），内部只读修饰键。
 */
export interface ModifierKeyTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** 「修饰键此刻按着」→ 手势（只给下面两处内部使用）。 */
function heldGesture(held: boolean): SubmitGesture {
  return held ? "accelerated" : "enter";
}

/** 事件 → 手势：按住 Ctrl / Cmd 就是加速手势（与键盘那条路同一条判据）。 */
export function submitGesture(event: ModifierEvent): SubmitGesture {
  return heldGesture(event.ctrlKey === true || event.metaKey === true);
}

/**
 * 点击处理器：手势由**本次事件**决定，再交给发送动作。
 *
 * 组件里就是 `onClick={clickGestureHandler(send)}`——发送动作拿到的永远是这一次点击的手势。
 *
 * @param onSend - 真正的发送入口（`Composer` 的 `send`）。
 * @returns 可直接挂到 `onClick` 上的处理器。
 */
export function clickGestureHandler(
  onSend: (gesture: SubmitGesture) => void,
): (event: ModifierEvent) => void {
  return (event) => onSend(submitGesture(event));
}

/**
 * 运行中的主按钮这一次**实际会走哪条路**（只用于按钮文字 / 悬停预告）。
 *
 * 与宿主 `resolveSubmitMode` 的运行中分支同口径：主手势用设置值、加速手势取反面；
 * 认不出的设置值一律按 queue。空闲不在这里——空闲恒「发送」，见 `sendButtonView`。
 *
 * @param busyEnter - `ui-conversation.busyEnter` 下发的首选值。
 * @param gesture - 这一次按键 / 点击的手势。
 * @returns 预告的提交方式。
 */
export function busySubmitIntent(
  busyEnter: ChatState["busyEnter"],
  gesture: SubmitGesture,
): "queue" | "steer" {
  const preferred = busyEnter === "steer" ? "steer" : "queue";
  if (gesture === "enter") return preferred;
  return preferred === "queue" ? "steer" : "queue";
}

/** 主按钮这一帧长什么样（文字 / 悬停 / 是发送还是停止）。 */
export interface SendButtonView {
  /** `stop` = 运行中且草稿为空（官方 `primaryStops`），`send` = 其余。 */
  kind: "stop" | "send";
  /** 按钮上的文字（停止态没有文字，只有一枚停止图标）。 */
  label: string;
  /** 悬停提示。 */
  title: string;
}

/**
 * 主按钮的显示判定（官方 `primaryStops = running && (empty || blocked)`）：
 * 运行中且草稿为空 → **停止**（按住修饰键也不许变成发送）；空闲 → 「发送」；
 * 运行中 → 按这一次的手势预告走哪条路。
 *
 * @param input - 这一帧的运行状态、草稿可用性、设置值与按住态。
 * @returns 按钮要显示的文字与悬停。
 */
export function sendButtonView(input: {
  running: boolean;
  canSend: boolean;
  busyEnter: ChatState["busyEnter"];
  modifierHeld: boolean;
  texts: Texts;
}): SendButtonView {
  if (input.running && !input.canSend) {
    return { kind: "stop", label: "", title: input.texts.stopTitle };
  }
  if (!input.running) {
    return { kind: "send", label: input.texts.send, title: input.texts.sendTitle };
  }
  const label =
    busySubmitIntent(input.busyEnter, heldGesture(input.modifierHeld)) === "steer"
      ? input.texts.sendSteer
      : input.texts.sendQueue;
  return { kind: "send", label, title: label };
}

/**
 * 订阅「修饰键此刻按着没有」，返回卸载函数。
 *
 * 按住态只有这三个来源：`keydown` / `keyup` 各判一次修饰键，窗口失焦一律按「没按」
 * （切到别的应用后键盘状态不再可靠）。只读 `ctrlKey` / `metaKey`，不看 `key`，
 * 所以任何按键的按下 / 松开都能把状态刷新对。
 *
 * @param target - 事件宿主（`window`，或回归里的最小替身）。
 * @param onChange - 按住态变化时回调（组件接 `setModifierHeld`）。
 * @returns 卸载函数。
 */
export function watchModifierKeys(
  target: ModifierKeyTarget,
  onChange: (held: boolean) => void,
): () => void {
  // 监听参数是 DOM 的 `Event`（`window.addEventListener` 的签名如此），这里只读修饰键
  const onKey = (event: Event) => {
    const modifier = event as ModifierEvent;
    onChange(modifier.ctrlKey === true || modifier.metaKey === true);
  };
  const onBlur = () => onChange(false);
  target.addEventListener("keydown", onKey);
  target.addEventListener("keyup", onKey);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onKey);
    target.removeEventListener("keyup", onKey);
    target.removeEventListener("blur", onBlur);
  };
}
