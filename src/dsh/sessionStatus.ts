/**
 * 会话**状态位**（`api-session/status` 转发事件，`args = [sessionId, running]`）的
 * 解码与「要不要采纳」策略。
 *
 * 这条中继是「这一轮在不在跑」的**服务端权威值**：Host 把 `agent/status` 转成它，
 * 经网关的 `broadcastRemoteEvent` 以 `$events` 流上的 `{type:'emit', event, args}` 帧
 * 广播给所有客户端；官方前端正是靠它维护 running（`dsh-api-session-controller` 的
 * `client/index.ts` → `ui-session` 的 `observeRunning`），官方 session 层还会把它同步进
 * 会话列表的行（`manager.ts` 的 `handleSessionStatus`）。
 *
 * 本扩展此前把这条帧当"不认识的配置事件"丢掉（`ConfigChangeRouter.handle` 的 default），
 * 于是 running 只剩一条来源——适配器从 durable 轮次边界推导。而那条路在「跟随窗口被
 * 截断 + 服务端此刻没有活跃 attempt」（工具执行 / 等审批 / 等子代理，`activeAttempt`
 * 只覆盖一次 LLM 调用）时**给不出结论**，此前却硬发了一个 `false`。症状就是用户
 * 2026-09-22 报的：离开会话再回来，明明还在生成却显示发送按钮，发出去的消息进了队列。
 *
 * 现在三条输入互补：适配器的日志边缘（本地）、`api-session/status` 中继（实时权威）、
 * 会话列表（`SessionSummary.running`，域新建时打底 + 每次刷新对齐）。
 *
 * 纯函数、不引 vscode：断言见 `scripts/sessionStatus.test.ts`。
 */

/** 一条中继帧解出来的值。 */
export interface SessionStatus {
  readonly sessionId: string;
  readonly running: boolean;
}

/**
 * 解一条 `api-session/status` 的 `args`。
 *
 * 形状不可信（socket 推来的值一律当外部输入）：`sessionId` 必须是非空字符串、
 * `running` 必须是布尔，否则返回 `undefined`——调用方据此记一行日志，而不是拿
 * `undefined` 当 false 用（那就是又一次「不知道说成没在跑」）。
 */
export function decodeSessionStatus(args: readonly unknown[]): SessionStatus | undefined {
  const sessionId = args[0];
  const running = args[1];
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  if (typeof running !== "boolean") return undefined;
  return { sessionId, running };
}

/**
 * 这条权威值要不要采纳。
 *
 * @param running - 服务端给的「在不在跑」。
 * @param hasOpenTurn - 本地日志有没有「这一轮还开着」的**肯定证据**
 *   （适配器 `hasOpenTurn()`：窗口里 `turn/start` 之后还没等到 `turn/end`）。
 * @returns `false` = 忽略这一条。
 *
 * 规则只有一条：**有肯定证据就拒绝「不在跑」**。`$events` 与 `session/follow` 是两条
 * 不同的流，乱序的一条旧 `false` 会把停止按钮和 `waitUntilIdle`（它等不到本轮结束就会
 * 把队列重新提交，于是那条消息排进去后不会自动接续）一起骗掉；真要收尾时 durable 的
 * `turn/end` 必然到，那一路才是权威。
 *
 * 反方向（本地认不出、外部说在跑）**一律采纳**——认不出时外部的就是唯一的线索，
 * 而这正是本模块修的那个缺口。注意「外部说不在跑、本地也认不出」同样采纳：那是
 * 「重连期间这一轮已经收尾」的正常情形，不采纳的话状态会永远停在生成中。
 */
export function acceptSessionStatus(running: boolean, hasOpenTurn: boolean): boolean {
  if (running) return true;
  return !hasOpenTurn;
}
