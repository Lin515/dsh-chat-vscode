/**
 * 自动化任务操作的**结算账本** —— 纯函数，离线可断言。
 *
 * 一次变更请求发出后，界面进入「正在保存 / 正在投递」的等待态，只有**这一次**
 * 的结算帧能收场。下面两种迟到帧必须被认出来并丢掉：
 *
 * - 用户已经翻篇（换了行、换了操作、行被卸载后重挂）之后才回来的旧结算；
 * - 同一行先后两次操作，先发的那次后回（服务端响应乱序）。
 *
 * 判据不能用「帧本身长什么样」猜，只能用界面**发请求时记下的操作标识**（`opId`，
 * 宿主原样回显）。旧宿主不回声 `opId` 时退回按操作种类与任务 id 匹配——那是这一层
 * 兼容旧宿主的唯一退路。
 *
 * 操作标识必须是**整个 webview 生命周期内唯一且单调递增**的：行组件卸载重挂、新建卡
 * 关闭再打开、同一任务的历史记录与详情各自请求，都会重新发号。若号码从每个组件的
 * `useRef(0)` 重新数，卸载前发出的 `opId=1` 会与重挂后新请求的 `opId=1` 撞号，
 * 于是迟到的旧结算被当成新操作的结果。发号因此放在模块级序号里（见 `scheduleNextOpId`），
 * 历史请求也走同一个发号器；测试用 `scheduleResetOpIds` 复位。
 */

/** 一次变更操作的五档（与 `schedules/result` 的 `op` 一一对应）。 */
export type ScheduleOpKind = "update" | "delete" | "create" | "run" | "active";

/** 界面正在等待的那一次操作。 */
export interface SchedulePendingOp {
  op: ScheduleOpKind;
  opId: number;
  /** 创建还没有 id；其余操作在发请求时就有。 */
  id?: string;
}

/** 宿主回的那一帧结算。 */
export interface ScheduleResultFrame {
  op: ScheduleOpKind;
  id?: string;
  opId?: number;
  ok: boolean;
  code?: string;
}

/**
 * 模块级的操作序号：进程内复用的同一个计数器，跨组件、跨重挂、跨历史请求都只增不减。
 *
 * 不放进 React state / ref：行组件卸载后那份本地计数会随实例消失，重挂的新实例从 0
 * 重新数，就会重用旧号。
 */
let scheduleOpSequence = 0;

/** 下一个操作标识：整个 webview 生命周期唯一、单调递增（1 起）。 */
export function scheduleNextOpId(): number {
  scheduleOpSequence += 1;
  return scheduleOpSequence;
}

/**
 * 把发号器复位到 `value`（默认 0，下一次发 1）。
 *
 * 只给离线回归用：测试进程里同一个模块实例会被多段断言共用，编号从零开始才能断言
 * 具体号码；产品代码不调用。
 */
export function scheduleResetOpIds(value = 0): void {
  scheduleOpSequence = value;
}

/**
 * 这一帧是否结算**正在等待的这一次**操作。
 *
 * 顺序即优先级：
 * 1. 种类不同一定不是；
 * 2. 非创建操作必须与请求侧的**同一个任务 id**（创建在请求时还没有 id，回帧才带新
 *    id，因此不比较）；旧宿主对 update / delete 的结算帧本来就有 id，缺 id 的帧不能
 *    被当成「同一行」的证据；
 * 3. 带 `opId` 的帧必须与等待中的号相等；没有 `opId` 的旧宿主帧按种类与 id 收下。
 */
export function scheduleResultSettles(
  pending: SchedulePendingOp | undefined,
  frame: ScheduleResultFrame,
): boolean {
  if (pending === undefined) return false;
  if (frame.op !== pending.op) return false;
  if (pending.op !== "create" && (pending.id === undefined || frame.id !== pending.id)) return false;
  if (frame.opId !== undefined) return frame.opId === pending.opId;
  return true;
}
