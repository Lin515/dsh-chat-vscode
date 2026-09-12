/**
 * `session/list` 行的**可见性**与会话**血缘**。
 *
 * 契约（`dsh-api-session-controller/lib/types/types.d.ts` 的 `SessionSummary`）：
 *
 * ```
 * parentSessionId?: SessionId;   // 分支（fork）与子代理**都会有**
 * origin?: 'subagent';           // 只有子代理有
 * ```
 *
 * 扩展曾经把过滤写成「有 `parentSessionId` 或有 `origin` 就滤掉」，本意是藏起
 * **子代理会话**，结果把**分支出来的会话一起藏了**——用户 2026-09-12 反馈
 * 「创建了分支，但新分支会话不会在会话历史里显示」。判据只能看 `origin`：
 * 实测（`scripts/sessionListProbe.ts`）fork 出来的子会话是
 * `parentSessionId=<源会话>`、`origin=undefined`。
 *
 * 深度用来把分支缩进显示在自己的源会话下面（官方 `flattenLineage` 的
 * `SessionListEntry.depth` 等价物：root = 0，界面乘一个缩进宽度即可）。
 * 分支会**继承源会话的标题**，不做缩进的话两行标题一模一样、看着像重复条目。
 */

/** 只藏**子代理**会话；分支（有 parent、`origin` 为空）必须留着。 */
export function visibleSessionRows<T extends { origin?: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.origin !== "subagent");
}

/**
 * 会话 id → 血缘深度（root = 0，子会话按 `parentSessionId` 链递增）。
 *
 * 源会话不在这一批行里时（被归档、属于别的工作区）按 root 处理；
 * 链上万一出现环，就地截断，绝不无限循环。
 */
export function lineageDepths<T extends { id: string; parentSessionId?: string }>(
  rows: readonly T[],
): Map<string, number> {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentSessionId]));
  const depths = new Map<string, number>();
  for (const row of rows) {
    let depth = 0;
    let cursor = row.parentSessionId;
    const seen = new Set<string>([row.id]);
    while (cursor && parentOf.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor);
    }
    depths.set(row.id, depth);
  }
  return depths;
}
