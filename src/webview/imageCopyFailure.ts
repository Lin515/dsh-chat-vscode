import { post } from "./bridge";

/**
 * 「界面本地复制图片失败」的归属上报（宿主入队入口，见 `shared/ipc.ts` 的
 * `reportImageCopyFailure`）。
 *
 * 复制图片是界面自己做的（`imageClipboard.ts` 的 canvas → 剪贴板），失败时宿主根本
 * 不知情；这条帧就是把它交给**宿主权威**的通知队列。三条纪律，缺一条都会归错：
 *
 * 1. **捕获发起时的会话**：`reportImageCopyFailure` 的形参由调用方在**手势那一刻**
 *    （菜单打开 / 点击「复制」）取好，绝不在这里读「此刻的会话」——复制是异步的，
 *    用户可以在这段时间切走；
 * 2. **回帧前再核对一次**：与此刻登记的会话不一致就**丢弃**（不 post）。这是界面这
 *    一侧的过期判据，宿主另有一道「与窗口此刻绑定一致」的校验；
 * 3. **请求号在失败落定、即将 post 的那一刻铸造**（不是手势时）：两个并发的复制可能
 *    乱序完成，只有按**上报顺序**给号，宿主的每窗口单调水位才是「按 FIFO 去重」——
 *    重复投递同一号是空操作，真正一次新的失败一定带更大的号。
 *
 * 帧里只有归属与请求号：失败文案与级别都是**固定的宿主文案**（`@imageCopyFailed`），
 * 界面没有携带任意 level / text / path 的通道。
 *
 * 「此刻是哪条会话」用模块级登记：`App` 在会话变化时登记一次，`contextMenu.ts`
 * 在菜单打开时读它来捕获手势归属（与图片解析范围 `localImages.ts` 分开：那一个
 * 由帧同步、带连接身份，见 `images/scope`）。
 */

/** 此刻这个窗口绑定的会话（`App` 登记；未登记 = 没有绑定会话）。 */
let scope: string | undefined;

/** 失败报告序号（每 webview 一份；页面重建时从 0 开始，宿主在 `ready` 清水位）。 */
let requestId = 0;

/** `App` 在会话变化时登记「此刻绑着哪条会话」。 */
export function setImageCopyFailureScope(sessionId: string | undefined): void {
  scope = sessionId;
}

/** 手势发起那一刻的归属（`contextMenu.ts` 在菜单打开时读）。 */
export function imageCopyFailureSession(): string | undefined {
  return scope;
}

/**
 * 上报一次真实失败。
 *
 * @param sessionId 这次复制**发起时**窗口绑定的会话（`undefined` = 那时没有绑定会话）。
 */
export function reportImageCopyFailure(sessionId: string | undefined): void {
  // 过期：发起时那个会话已经不是当前会话了，这次失败不该画到新会话上
  if (sessionId !== scope) return;
  requestId += 1;
  if (!Number.isSafeInteger(requestId)) requestId = 1;
  // 无绑定会话时**不带** `sessionId` 键：宿主拿到的就是 `undefined`，与它此刻的绑定
  // （也是 `undefined`）相等才入队，入的是共享通知。
  post(
    sessionId === undefined
      ? { type: "reportImageCopyFailure", requestId }
      : { type: "reportImageCopyFailure", sessionId, requestId },
  );
}
