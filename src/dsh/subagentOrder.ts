/**
 * 子代理目录的**显示顺序**（纯函数，便于离线断言）。
 *
 * 口径（用户 2026-10-13）：目录里的行始终按「用户消息最新的，或者 agent 轮次结果正文
 * 最新的」时间从上到下排。两类消息**同等对待**——谁的时间新谁在前，不设优先级。
 *
 * 判定时间并列（同一毫秒建出来的一批子代理、同一刻的两次收尾）时按**创建时刻**（更晚建
 * 的在前），再并列才退回数组的发现顺序。创建时刻是对所有来源都成立的同一份事实
 * （`SubagentView.createdAt`），所以先后不取决于「这个数组是怎么攒起来的」——父会话域的
 * 目录与子代理页的父目录快照因此永远给出同一个顺序，进出子代理不会看到先后变化。
 *
 * 判定条目只有两类：
 *
 * - **用户消息**：服务端 `sessionListMetadata.lastPromptAt`（`session/list` 行的
 *   `updatedAt` 就是 `max(createdAt, lastPromptAt)`，见 `SessionSummary`），由
 *   `controller` 的判定时间账本记下；
 * - **一轮的收尾**（agent 轮次结果正文落地的那一刻）：宿主亲历的 `api-session/status`
 *   由 running 转 false（服务端没有下发「最后一条助手消息的时间」这样的字段，判据与
 *   来路见 `controller.subagentActivityAt`）。
 *
 * **agent 的过程消息不进判定条目**：一轮里的思考、工具调用、逐段正文都不改这个时间，
 * 否则生成中的那一行会随每条事件重排一次（用户口径：「避免反复刷新」）。
 *
 * 没有时间证据的行（账本里查不到）排在最后，并列时保持发现顺序——什么都不猜。
 */

import type { SubagentView } from "../shared/chat";

/**
 * 按判定时间从新到旧重排目录（不改动入参数组，返回新数组）。
 *
 * @param entries 目录行，顺序即发现顺序（最后一级并列时的次序）。
 * @param activityAt 判定时间账本（子代理会话 id → epoch ms）；查不到 = 没有时间证据（按 0 排最后）。
 */
export function orderSubagentEntries(
  entries: readonly SubagentView[],
  activityAt: ReadonlyMap<string, number>,
): SubagentView[] {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      at: activityAt.get(entry.id) ?? 0,
      createdAt: entry.createdAt ?? 0,
    }))
    .sort(
      (left, right) =>
        right.at - left.at ||
        right.createdAt - left.createdAt ||
        left.index - right.index,
    )
    .map((row) => row.entry);
}
