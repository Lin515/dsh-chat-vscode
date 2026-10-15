/**
 * 历史列表的多选（纯函数）：哪些行可选、选择集怎么跟当前列表对齐、全选怎么翻转。
 *
 * 为什么抽出来：三个判据都是「看一眼觉得对、改一行就错」的那类，而它们错了以后
 * 现场很难复现——只有点下去那一刻才知道选中的是谁。
 *
 * - **可选判据**：与行内归档 / 删除按钮同源（`sessionLocked`）。运行中的会话服务端
 *   还在往里写、当前窗口正在看的会话删完无处可看，宿主两条都会拒（见 controller 的
 *   `deleteSession`）；批量操作不能把这两类混进去，否则用户点一次删除会连着收到几条
 *   拒绝提示。
 * - **选择集跟随列表**：搜索框改变可见行、切归档视图换了另一份列表、归档 / 删除后
 *   行消失，选中项都要跟着退掉——留下的那些是**看不见却会被操作**的幽灵选择
 *   （`pruneSelection`）。
 * - **全选是翻转不是累加**（用户 2026-10-15 口径）：只要还有没选中的就选中全部，
 *   已经全选则取消全部。写成分支最容易在「部分选中」那一档上错。
 */
import type { SessionSummaryView } from "../shared/chat";

/** 这一行能不能被归档 / 恢复 / 删除：运行中与当前会话都不行（宿主侧同一套保护）。 */
export function sessionLocked(
  row: Pick<SessionSummaryView, "id" | "running">,
  currentId?: string,
): boolean {
  return row.running || row.id === currentId;
}

/** 当前列表里可选的会话 id（顺序照列表）。 */
export function selectableSessionIds(
  rows: readonly SessionSummaryView[],
  currentId?: string,
): string[] {
  return rows.filter((row) => !sessionLocked(row, currentId)).map((row) => row.id);
}

/**
 * 选择集对齐当前可选集：丢掉已经不可见 / 已不可选的 id。
 *
 * 没有变化时**返回入参本身**——调用方在 effect 里 `setState`，每次都新建一个 Set
 * 会让依赖它的渲染再来一轮。
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  selectable: readonly string[],
): ReadonlySet<string> {
  const keep = new Set(selectable);
  let dropped = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (keep.has(id)) next.add(id);
    else dropped = true;
  }
  return dropped ? next : selected;
}

/** 已全选（可选集为空时不算全选——此时全选按钮无意义）。 */
export function allSelected(
  selected: ReadonlySet<string>,
  selectable: readonly string[],
): boolean {
  return selectable.length > 0 && selectable.every((id) => selected.has(id));
}

/** 全选快捷键的翻转：还没全选 → 选中全部；已经全选 → 取消全部。 */
export function toggleAllSelection(
  selected: ReadonlySet<string>,
  selectable: readonly string[],
): ReadonlySet<string> {
  return allSelected(selected, selectable) ? new Set<string>() : new Set(selectable);
}

/** 单行的勾选翻转。 */
export function toggleSelection(selected: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}
