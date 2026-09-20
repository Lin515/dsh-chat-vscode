/**
 * 改动清单的缓存键（宿主与界面两边共用同一份算法）。
 *
 * **必须带会话 id**：事件 seq 是**每个会话各自编号**的，只用 seq 做键会让两个会话的
 * 同号事件互相串清单——界面上表现为「这个会话的卡片显示的是另一个会话改的文件」，
 * 而它恰好只在两个会话都跑过、且改动轮次的 seq 编号撞上时出现，极难现场复现。
 */
export function changesSummaryKey(sessionId: string, seq: number): string {
  return `${sessionId}\u0000${seq}`;
}

/** 卡片折叠前铺出来的行数（官方 `ui-deliverables` 的同一口径：先 3 行）。 */
export const CHANGES_CARD_VISIBLE = 3;

/**
 * 卡片当前该显示哪些文件行。
 *
 * 折叠只看 `files`（Host 已按 `display` 排好序），`total` 只用于标题里的计数——
 * 被 Host 上限截掉的文件根本没进 `files`，展开也变不出来。
 */
export function visibleChangeFiles<T>(files: readonly T[], expanded: boolean): T[] {
  return expanded ? [...files] : files.slice(0, CHANGES_CARD_VISIBLE);
}

/** `turnsWithChangesCard` 需要的最小形状（`MessageView` 与测试夹具都满足）。 */
export interface ChangesCardMessage {
  changes?: { turn: number; seq: number };
}

/**
 * 哪些**轮次**真的会显示改动文件卡片。
 *
 * 让位判定必须按轮、不能按消息：一轮被插话切成多段时（`a:N` / `a:N:2`…），卡片挂在
 * 最后一段，而 `produced` 往往挂在前一段——按消息判定就成了「这一段显示卡片、那一段
 * 显示本轮改动」，同一轮尾部同时冒出好几样（用户 2026-09-21 报告的混乱）。
 *
 * 判据与卡片自己的渲染条件一致（清单到手且至少列了一个文件）：拿不到清单的那一轮
 * 不该把「本轮改动」行顶掉，否则那一轮的文件就两头都没了。
 */
export function turnsWithChangesCard<T extends ChangesCardMessage>(
  messages: readonly T[],
  summaryFor: (seq: number) => { files: readonly unknown[] } | null | undefined,
): Set<number> {
  const turns = new Set<number>();
  for (const message of messages) {
    const coordinates = message.changes;
    if (!coordinates) continue;
    const summary = summaryFor(coordinates.seq);
    if (summary && summary.files.length > 0) turns.add(coordinates.turn);
  }
  return turns;
}
