import type { MessageView } from "../shared/chat";

/**
 * 「加载更早的历史」**取到哪儿为止**（宿主侧判据）。
 *
 * 服务端的 `session/page` 按消息条数分页（一页 50 条），页边界**不认轮次**：停在哪就
 * 在哪，于是往前翻一页很可能正好切在一轮中间——最上面半截助手消息（几条工具行 +
 * 一段没有开头的回答）孤零零地挂着，看不出它属于哪一轮。
 *
 * 用户口径（2026-09-15）：**至少取到用户的上一条消息**（也就是取到一轮的开头），
 * 一次触发就把这一段取完。所以循环的停止条件有三个：
 *
 * 1. **取到轮次边界**：消息流顶部变成**用户消息**（消息流是 `用户 → 助手 → 用户 →
 *    助手…`，头部只可能是用户消息）；
 * 2. **服务端说没有更早的了**（`hasMore` 变 false）；
 * 3. **这一页没有带来新事件**（`added === 0`）——再取也没意义，防死循环。
 *
 * 第 3 条必须用**真实的新增事件数**，不能拿「首条消息 id 变没变」当判据：更早的事件
 * 常常只是把现有的第一条助手消息**补长**（它的 id 是按轮次派生的 `a:<turn>`，不会变），
 * 于是「没换首条」会被误判成「没进展」而在半轮中间停下——那正是用户 2026-09-15 报的
 * 「并没有加载到上一条消息就已经停了」（现场见 `scripts/pageLoopProbe.ts`）。
 *
 * 纯函数、不引 vscode：断言见 `scripts/historyReplay.test.ts`。
 */

/** 顶部是不是一轮的开头（或压根没有消息 / 角色缺失 → 不再往下取）。 */
export function atTurnBoundary(messages: readonly MessageView[]): boolean {
  const first = messages[0];
  if (!first) return true;
  // 角色缺失（历史缺字段）时不再取：宁可停在半轮，也不要无限往前翻
  return first.role !== "assistant";
}

/**
 * 这一页落定之后，还要不要接着往前取。
 *
 * @param added 这一页新并入的事件条数（0 = 没带来新东西）。
 * @param hasMore 服务端是否还有更早的记录。
 * @param messages 当前消息流（判断顶部是不是轮次边界）。
 */
export function shouldContinuePaging(
  added: number,
  hasMore: boolean,
  messages: readonly MessageView[],
): boolean {
  if (added <= 0 || !hasMore) return false;
  return !atTurnBoundary(messages);
}
