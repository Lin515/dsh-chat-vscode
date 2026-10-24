/**
 * 会话**活动时间**（`api-session/activity` 转发事件，`args = [sessionId, updatedAt]`）的
 * 解码。
 *
 * 这条中继是子代理目录排序里「用户消息」那一半的**实时来路**：Host 在每一条
 * `source.kind === 'user'` 的 `user/message` 落盘时发它（`session-controller` 的
 * `session/event` 分支），`updatedAt` 就是那次消息的 `event.time`——与
 * `sessionListMetadata.lastPromptAt` 是**同一个值**（`session/list` 行的 `updatedAt` =
 * `max(createdAt, lastPromptAt)`）。此前本扩展只从 `session/list` 读这一半，于是标题
 * 清单的先后要等「打开清单那一下的整份列表」回来（约一秒）才纠正，用户看到的是开菜单
 * 后行才跳到位。
 *
 * 形状不可信（socket 推来的值一律当外部输入）：解不出就返回 `undefined`，调用方记一行
 * 日志后忽略这条——不猜时间，也不拿它当 0 用。
 */
export interface SessionActivity {
  readonly sessionId: string;
  readonly updatedAt: number;
}

/**
 * 解一条 `api-session/activity` 的 `args`。
 *
 * @param args 原始参数列表：第一项会话 id（非空字符串），第二项 epoch ms（有限数字）。
 * @returns 形状不成立时 `undefined`。
 */
export function decodeSessionActivity(args: readonly unknown[]): SessionActivity | undefined {
  const sessionId = args[0];
  const updatedAt = args[1];
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
  return { sessionId, updatedAt };
}
