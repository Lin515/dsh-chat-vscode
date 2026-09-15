/**
 * 待发送队列的**显示顺序**（纯函数，便于离线断言）。
 *
 * 口径（用户 2026-09-15）：**插话发送的（`steering`）排在排队发送的（`queued`）上方**。
 * 语义上插话是「立刻进当前轮」的那条、排队是「等下一轮」，先走的排前面；而服务端给的是
 * **提交先后**的顺序，于是后提交的插话反而被压在排队的下面，看起来像插话还没生效。
 *
 * 只改**显示**顺序，**不动数据顺序**：宿主「ESC 中止并把队首发出去」是按
 * `scope.queueItems` 的原顺序重新提交的（见 `dsh/controller.ts` 的 `stopRunning`），
 * 在映射层（`dsh/queueView.ts`）排序会顺手把重发顺序也一起改掉。
 * 两组内部各自保持服务端给的原顺序（`Array.prototype.sort` 自 ES2019 起稳定）。
 */
import type { QueuedMessageView } from "../shared/chat";

/** 显示权重：插话 0、排队 1（同组内保持原顺序）。 */
export function queueRank(item: QueuedMessageView): number {
  return item.placement === "steering" ? 0 : 1;
}

/** 按显示权重排序；返回新数组，不改动入参。 */
export function queueDisplayOrder(items: readonly QueuedMessageView[]): QueuedMessageView[] {
  return [...items].sort((a, b) => queueRank(a) - queueRank(b));
}
