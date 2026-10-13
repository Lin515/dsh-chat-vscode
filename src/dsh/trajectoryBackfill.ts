/**
 * 「轨迹折叠缺 `request/header`」时**按需回补更早事件**的策略（宿主侧判据 + 循环）。
 *
 * ## 为什么需要它
 *
 * 轨迹账本里每条工具行的「Schema」来自 `request/header` 事件里那一份**调用当时**的工具
 * 目录（`dsh/trajectory.ts` 的 `schemaDetailOf()`）。而 `request/header` 是**稀少**的事件
 * （一个会话常常只有一帧），且服务端分页是**按消息对齐**的（`session/page` 的
 * `paginate()` 把切点落在那条消息的 `sourceEventSeqs` 最小 seq 上）——`request/header`
 * 不属于任何消息，只要落在这道刀口之外就被整个切掉。跟随开窗只带
 * `maxMessages` 条消息（见 `dsh/client.ts` 的 `followSession`），于是**窗口一开就可能
 * 没有表头**：窗口内所有工具行都取不到目录，界面上整片「Schema 不可用」。
 *
 * 官方客户端开窗是 500 条消息 + `turnWindow`（`session-controller` 的
 * `HISTORY_PAGE_OPTIONS`），窗口大得多所以少见；本扩展为了让聊天流少渲染（消息列表
 * 没有虚拟滚动）只带一小段，缺口就明显。**修法不是把聊天窗口拉大**（那会把开窗成本
 * 转嫁给聊天流），而是**只给轨迹补它缺的那一段**：本模块一页一页往前取，直到窗口里
 * 出现了那条工具行之前的表头，或到「没有更早的了 / 没有新事件 / 页数上限」为止。
 *
 * ## 与聊天流、与账本的分界
 *
 * 回补来的那一页只抽走其中的 `request/header`，存成**轨迹专用的表头**一份
 * （`SessionAdapter.absorbTrajectoryBackfill` → `trajectoryCallCatalogs()`）：
 * - 不碰聊天流的事件集与消息折叠：聊天的开窗、`hasMoreHistory`、「加载更早」的分页
 *   锚点都不受影响；
 * - **也不进账本**：窗口里能看见的记录一行都不多。表头只参与「这条调用当时的目录是
 *   哪一份」这一个判断；把回补的事件整页并进折叠输入，等于在用户正看着的账本**上方**
 *   插进几千行（轨迹的滚动归应用自己管、`overflow-anchor: none`），视图会被顶走。
 *
 * ## 停止条件（三条都是必需的）
 *
 * 1. **判据不再成立**：窗口里已经有一条表头落在那条工具行之前 —— 剩下的缺席是真的
 *    （那一帧目录里本来就没有这个工具名，例如 `resume` 表头早于 MCP 工具连上来）。
 *    这时候回补再多也没用，必须停。
 * 2. 服务端说没有更早的了（`hasMore === false`），或这一页没带来新事件（`added === 0`）
 *    —— 防死循环。
 * 3. **页数上限**（{@link MAX_SCHEMA_BACKFILL_PAGES}）：安全阀，不是策略。轨迹面板
 *    打开时每 3 秒会重折一次，这一轮取到上限就停下，下一轮接着取（进度是单调的）。
 *
 * 纯策略 + 一个依赖注入的循环（`fetchPage` / `absorb` 由调用方给），所以本文件不引
 * vscode、不碰网络：断言见 `scripts/trajectorySchemaBackfill.test.ts`。
 */
import type { SessionWireEvent } from "./protocol";
import { trajectoryTurnCells } from "../shared/trajectory";
import type { TrajectoryModel } from "../shared/trajectory";
import type { TrajectoryCallCatalog } from "./trajectory";

/**
 * 一轮回补最多取几页（安全阀）。
 *
 * 取到上限不算失败：下一轮 `listTrajectory` 会从**已经取到的位置**接着往前取，
 * 进度单调，直到判据不再成立或服务端说没有更早的。
 */
export const MAX_SCHEMA_BACKFILL_PAGES = 6;

/**
 * 回补时一页要多少条消息。
 *
 * 比聊天流的「加载更早」大（那边 50）：回补**不渲染**，只折叠，所以宁可一页多拿一点、
 * 少几次往返。`session/page` 只校验它是正整数（`history.ts` 的 `validateHistoryWindow`）。
 */
export const SCHEMA_BACKFILL_PAGE_MESSAGES = 200;

/**
 * 折叠输入里最老的一条「**没有前驱表头**的工具行」的 seq。
 *
 * 判据是「这条工具行之前有没有 `request/header`」而不是「取没取到 schema」：
 * 前者才是窗口的锅，后者可能是真的没有（表头在、目录里就是没有这个工具名，官方
 * `captureSchemas()` 同样是 `schema !== undefined` 才写，不臆造）。
 *
 * 表头有两个来源，缺一不可：窗口里的事件，以及**已经补进来的那一份目录**
 * （`catalogs`，补过之后判据才会消失——否则每一轮都会把同样几页再取一遍）。
 *
 * @param model 当前折叠输入折出来的账本。
 * @param events 同一份折叠输入（按 seq 升序）。
 * @param catalogs 已经补进来的表头（`seq` + 那一帧的目录）。
 * @returns 需要回补的锚点 seq；不需要回补（或全部都能解释）就是 `undefined`。
 */
export function missingSchemaAnchor(
  model: TrajectoryModel,
  events: readonly SessionWireEvent[],
  catalogs: readonly TrajectoryCallCatalog[] = [],
): number | undefined {
  let oldest: number | undefined;
  for (const turn of model.turns) {
    for (const cell of trajectoryTurnCells(turn)) {
      if (cell.kind !== "tool" && cell.kind !== "subtool") continue;
      if (cell.schemaDetail !== undefined) continue;
      const seq = cell.seq;
      if (typeof seq !== "number") continue;
      if (oldest === undefined || seq < oldest) oldest = seq;
    }
  }
  if (oldest === undefined) return undefined;
  // 有表头落在这条之前：这一条的目录确实不在窗口外，回去翻历史也翻不出新东西
  for (const event of events) {
    if (event.type === "request/header" && (event.seq ?? 0) < oldest) return undefined;
  }
  for (const catalog of catalogs) {
    if (catalog.seq < oldest) return undefined;
  }
  return oldest;
}

/**
 * 这一页落定之后还要不要接着往前取。
 *
 * @param added 这一页新并入的事件条数（0 = 没带来新东西）。
 * @param hasMore 服务端是否还有更早的记录。
 * @param pages 这一轮已经取过的页数。
 */
export function shouldContinueSchemaBackfill(added: number, hasMore: boolean, pages: number): boolean {
  if (added <= 0 || !hasMore) return false;
  return pages < MAX_SCHEMA_BACKFILL_PAGES;
}

/** 回补循环要用到的几个动作（由控制器把真的适配器 / 客户端接进来）。 */
export interface SchemaBackfillSeam {
  /**
   * 当前还缺 schema 且**窗口里没有前驱表头**的最老工具行的 seq。
   * `undefined` = 不需要回补（全都解释得通）。
   */
  missingAnchor(): number | undefined;
  /** 轨迹折叠输入里最小的 seq（`session/page` 的 `beforeSeq`）。 */
  earliestSeq(): number | undefined;
  /** 跟随开帧的 `snapshot.cursor`（`throughSeq` 的唯一合法来源）。 */
  throughSeq(): number | undefined;
  fetchPage(request: {
    readonly throughSeq: number;
    readonly beforeSeq: number;
    readonly maxMessages: number;
  }): Promise<{ readonly records: readonly unknown[]; readonly hasMore: boolean }>;
  /** 把这一页并入**轨迹专用**的表头那一份，返回这一页新见到的**事件**条数（不结算聊天流）。 */
  absorb(records: readonly unknown[], hasMore: boolean): number;
}

/**
 * 一页一页往前取，直到不需要再补或撞上停止条件。
 *
 * @returns 这一轮是否**真的补进来了事件**（调用方据此决定要不要重折再发一帧）。
 */
export async function backfillTrajectorySchemas(seam: SchemaBackfillSeam): Promise<boolean> {
  let absorbed = 0;
  let pages = 0;
  for (;;) {
    if (seam.missingAnchor() === undefined) return absorbed > 0;
    const throughSeq = seam.throughSeq();
    const beforeSeq = seam.earliestSeq();
    if (throughSeq === undefined || beforeSeq === undefined) return absorbed > 0;
    const page = await seam.fetchPage({
      throughSeq,
      beforeSeq,
      maxMessages: SCHEMA_BACKFILL_PAGE_MESSAGES,
    });
    const added = seam.absorb(page.records ?? [], Boolean(page.hasMore));
    absorbed += added;
    pages += 1;
    if (!shouldContinueSchemaBackfill(added, Boolean(page.hasMore), pages)) return absorbed > 0;
  }
}
