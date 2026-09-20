/**
 * 「加载历史」的策略（宿主侧判据）：**两档语义，与官方客户端的两条入口同构**。
 *
 * ## 两档
 *
 * 1. **单页档**（`target === undefined`，对应官方 `ISession.loadOlder()`）：取一页就停。
 *    会话页的「加载更早的历史」按钮与轨迹视图的同一枚按钮走这一档。
 * 2. **到目标档**（带 `target`，对应官方 `ISession.loadThrough(seq)`）：一页一页往前取，
 *    直到**窗口最早的事件 seq 已经覆盖目标**（`earliest <= seq`）。右侧轮次横条上那些
 *    「未加载」的刻点走这一档——点它就能先把那段历史取回来，再落位到该轮。
 *
 * 官方对应物（`@deepseek-ai/dsh` 的 `session-controller`）：
 * `src/client/sessions/session.ts` 的 `loadOlder()`（单页）与 `loadThrough(seq)`
 * （循环翻页直到窗口覆盖目标）；前端触发器只有 `ui-chat` 的「加载更早」按钮与轮次
 * 横条的未加载刻点，**没有**滚动自动加载。
 *
 * ## 停止条件
 *
 * 1. 服务端说没有更早的了（`hasMore === false`）——正常终止；
 * 2. 这一页没有带来新事件（`added === 0`）——防死循环（服务端行为异常时的兜底）；
 * 3. 单页档：取满一页即停；
 * 4. 到目标档：窗口已覆盖目标 seq（`earliest <= seq`）。
 *
 * 外加一个**页数上限**（`MAX_HISTORY_PAGES`）：上面几条都失效时（例如服务端一直回
 * 同一页且 `added` 算非零的病态情形）不至于把扩展宿主拖死。它是安全阀，不是策略
 * ——实测本机最大的会话也只要 25 页。
 *
 * ## 为什么不再「一次触发取完整个历史」
 *
 * 2026-09-14 曾把「一次触发就把窗口外的全部历史取回来」定成设计：当时发现「取到用户的
 * 上一条消息就停」这个判据与服务端的分页粒度对不上——`session/page` 的 `paginate()`
 * 按**固定消息条数**从 `beforeSeq` 往前切一刀，切点与轮次边界无关，判据几乎从不成立，
 * 于是一路取到底。2026-09-20 用户口径改回**按需**：单页档一次一页，跨轮跳转交给
 * 「到目标档」，与官方两条入口一一对应。
 *
 * 纯函数、不引 vscode：断言见 `scripts/historyReplay.test.ts`。
 */

/** 一次「到目标档」最多取多少页（安全阀，不是策略）。 */
export const MAX_HISTORY_PAGES = 200;

/**
 * 这一页落定之后，还要不要接着往前取。
 *
 * @param added 这一页新并入的事件条数（0 = 没带来新东西）。
 * @param hasMore 服务端是否还有更早的记录。
 * @param pages 已经取过的页数（安全阀计数）。
 * @param target 跨轮跳转的目标：`seq` 是要覆盖的 `turn/start` 的 seq，`earliest` 是
 *   当前已折叠事件里最小的 seq。不传 = 单页档（官方 `loadOlder`）。
 */
export function shouldContinuePaging(
  added: number,
  hasMore: boolean,
  pages: number,
  target: { readonly seq: number; readonly earliest: number } | undefined,
): boolean {
  if (added <= 0 || !hasMore) return false;
  if (pages >= MAX_HISTORY_PAGES) return false;
  if (target === undefined) return false;
  // 官方 `loadThrough` 的循环条件：窗口最前面的 seq 还没盖住目标就接着翻
  return target.earliest > target.seq;
}
