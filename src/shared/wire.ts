import type { HostToWebview } from "./ipc";

/**
 * 宿主 → webview 的**过线语义**。
 *
 * VS Code 的 webview 消息是 `JSON.stringify` 过的：实测本机安装目录里的扩展宿主
 * （`extensionHostProcess.js` 里的 `r8()`）两条分支都是
 * `{ message: JSON.stringify(frame) }`，界面上再 `JSON.parse` 回来。
 * 于是**值为 `undefined` 的键会被整条丢掉**：
 *
 * ```
 * 宿主发: { type: "patch", patch: { goal: undefined } }
 * 界面收: { type: "patch", patch: {} }        ← 一个「什么都不改」的空 patch
 * ```
 *
 * 后果不是显示难看，而是**宿主所有「清空某个字段」的意图一个都到不了界面**：
 * 清掉目标、切会话时清掉上一会话的上下文占用/速度/统计……全都静默失效。
 * 用户 2026-09-12 反馈的「目标条一直卡着、切会话也都在、点了清除没反应」就是它：
 * 会话日志里服务端早已回 `Goal cleared.`，界面上那条目标条却纹丝不动，
 * 于是用户又去点「暂停目标」，服务端回 `No goal is currently set`。
 *
 * 所以「清空」必须用一个能过线的值表达 —— `null`：
 * 宿主侧 `jsonSafeFrame` 把顶层 `undefined` 换成 `null`，
 * 界面侧 `mergeWirePatch` 再把它折回「这个键不存在」。
 *
 * 只处理 `patch` / `state` 的**顶层**：界面里所有可选字段的判断都按
 * `undefined` 写，嵌套的可选字段（工具行的 detail 之类）本来就靠「键不存在」
 * 表达缺失，JSON 丢掉它们不改变语义。
 */

/** 顶层 `undefined` → `null`（过线后仍然存在的「清空」）。 */
function nullsForUndefined<T extends object>(value: T): T {
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) next[key] = item === undefined ? null : item;
  return next as T;
}

/** 发帧前调用：保住「清空」意图（见模块注释）。 */
export function jsonSafeFrame(frame: HostToWebview): HostToWebview {
  if (frame.type === "patch") return { ...frame, patch: nullsForUndefined(frame.patch) };
  if (frame.type === "state") return { ...frame, state: nullsForUndefined(frame.state) };
  return frame;
}

/**
 * 界面侧合并一个过线的 patch / snapshot：`null` = 清除该字段（把键删掉，
 * 读的人拿到的仍是 `undefined`），其余照常覆盖。
 */
export function mergeWirePatch<T extends object>(base: T, patch: object): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}
