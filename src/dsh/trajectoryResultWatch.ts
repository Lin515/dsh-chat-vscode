/**
 * 轨迹 Result 页「选中工具结果」的**每视图唯一观察者**（宿主侧）。
 *
 * 数据源是官方 `toolResults/watch` 流（`ui-trajectory` 的
 * `SessionToolResultRequest` / `SessionToolResultValue`）：请求
 * `{request: {sessionId, seq}}`，帧只有两档——`{available:false}`（清空）或
 * `{available:true, value}`（`value` 可以是 JSON null / false / 0 / 空串 / 空对象）。
 *
 * 三条硬约束：
 *
 * 1. **每 view 只留一个观察**：`observe` 换观察时立即取消上一条流；同一窗口不可能
 *    同时把两个 `seq` 的结果接进界面。
 * 2. **不缓存历史**：这里只保留「当前该看哪一条」的描述与它那条流的句柄，没有
 *    `seq → value` 表；流一断、观察一换或页面一关，值就没了。
 * 3. **回调身份三重校验**：旧 token、旧 client、旧 session 的任何迟到帧都不得透出。
 *    取消句柄挡不住已经排进事件循环的回调，所以每个回调都带上开流时的 token 与
 *    client，落地时逐项比对（session / seq / watchId 属于描述对象本身）。
 *
 * 生命周期与 controller 的对应关系（controller 负责调用）：
 * - 打开 / 换行 / 换 seq → `observe`；关闭 Result 页 / 卸载 → `close(viewId)`；
 * - 窗口解绑 / 换绑会话 / 关 view → `close(viewId)`；
 * - 会话域被回收 → `closeSession(sessionId)`；
 * - 断线 / 换 client（`teardownStreams`）→ `suspendAll()`：取消流并推
 *   `available:false`，**保留描述**；
 * - 连上（`onConnected`）→ `resume(client, sessionOf)`：只恢复「同 client 且仍绑定
 *   原 session」的描述；client 已换或会话已切走的直接丢弃（绝不把旧服务器的
 *   sessionId / seq 订阅到新服务器）。
 */
import type { TrajectoryResultFrame } from "../shared/ipc";
import { isRecord } from "../shared/jsonValue";
import type { DshClient, StreamHandle } from "./client";
import type { SessionToolResultValue } from "./protocol";

/** 把解析后的结果帧送到该视图（controller 用 `emitToView` 包一层）。 */
export type TrajectoryResultEmitter = (frame: TrajectoryResultFrame) => void;

/** `toolResults/watch` 一帧的收窄；认不出返回 `undefined`（整帧丢弃）。 */
export function trajectoryResultValueFromWire(value: unknown): SessionToolResultValue | undefined {
  if (!isRecord(value)) return undefined;
  if (value.available === false) return { available: false };
  if (value.available === true && Object.prototype.hasOwnProperty.call(value, "value")) {
    // JSON 里不存在 undefined；坏帧（或宿主侧的 undefined）整帧丢弃，不能当成清空。
    if (value.value === undefined) return undefined;
    // 这里**不做 truthiness 判空**：null / false / 0 / "" 都是合法结果。
    return { available: true, value: value.value };
  }
  return undefined;
}

interface WatchDescriptor {
  readonly viewId: string;
  watchId: number;
  readonly sessionId: string;
  readonly seq: number;
  readonly emit: TrajectoryResultEmitter;
  /** 当前这条流属于哪个 client；`undefined` = 观察时还没有连接。 */
  client: DshClient | undefined;
  /** 每次开流自增；回调凭它识别「这是不是当前那条」。 */
  token: number;
  handle: StreamHandle | undefined;
  closed: boolean;
}

export interface TrajectoryResultWatchManager {
  /**
   * 为视图登记一个观察（同一视图只保留最后一个）。
   *
   * @param viewId 窗口身份（controller 的 viewId）。
   * @param watchId 界面铸造的观察号，原样回带；旧号不得覆盖新观察。
   * @param sessionId 该视图当前绑定的会话（不是请求里带来的）。
   * @param seq durable `tool/result` 事件序号。
   * @param client 当前连接；没有连接时描述保留并立即回 `available:false`。
   * @param emit 直接发该视图的回帧函数（帧不带 sessionId）。
   */
  observe(
    viewId: string,
    watchId: number,
    sessionId: string,
    seq: number,
    client: DshClient | undefined,
    emit: TrajectoryResultEmitter,
  ): void;

  /** 关闭一个视图的观察；给了 `watchId` 时只关**同一个观察**（迟到的 unwatch 是空操作）。 */
  close(viewId: string, watchId?: number): void;

  /** 关闭某个会话下的全部观察（会话域回收时用）。 */
  closeSession(sessionId: string): void;

  /** 关闭全部视图的观察（窗口销毁 / 宿主 dispose）。 */
  closeAll(): void;

  /**
   * 断线 / 换 client：取消全部流并推 `available:false`，但**保留描述**。
   *
   * 保留描述才有 `resume` 的「同 client 重连重新开流」；值本身已经清掉，不会在
   * 界面上留下过期值。换 client 时 `resume` 会把描述丢掉（见下）。
   */
  suspendAll(): void;

  /**
   * onConnected：恢复仍有效的观察。
   *
   * 只恢复 `client` **就是当前这个 client**、且 `sessionOf(viewId)` 仍等于描述里的
   * `sessionId` 的那些；旧 client、断开期间没有 client 的描述、已切走的会话一律
   * `close`——绝不把旧服务器的 `sessionId/seq` 猜着订阅到新服务器。
   */
  resume(client: DshClient, sessionOf: (viewId: string) => string | undefined): void;

  /** 当前保留的描述数（含已 suspend、等待 resume 的；用于有界性断言）。 */
  readonly activeCount: number;
}

class WatchManager implements TrajectoryResultWatchManager {
  private readonly watches = new Map<string, WatchDescriptor>();

  get activeCount(): number {
    return this.watches.size;
  }

  observe(
    viewId: string,
    watchId: number,
    sessionId: string,
    seq: number,
    client: DshClient | undefined,
    emit: TrajectoryResultEmitter,
  ): void {
    const previous = this.watches.get(viewId);
    // 迟到的 observe（旧 watchId）不许把当前观察换回去；界面重发同一号才允许刷新。
    if (previous !== undefined && Number.isSafeInteger(watchId) && watchId < previous.watchId) return;
    if (viewId === "" || sessionId === "" || !Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(watchId) || watchId < 0) {
      // 形参不合法也回一帧，界面不会永远停在「读取中」；非法的 watchId 由界面自己忽略。
      emit({ type: "trajectory/result", seq, watchId, available: false });
      return;
    }
    // 换观察时旧号即将失效：界面已经按新 watchId 过滤，这里不必再发一帧旧号。
    if (previous !== undefined) this.drop(previous, false);
    const watch: WatchDescriptor = {
      viewId,
      watchId,
      sessionId,
      seq,
      emit,
      client,
      token: 0,
      handle: undefined,
      closed: false,
    };
    this.watches.set(viewId, watch);
    this.open(watch, client);
  }

  close(viewId: string, watchId?: number): void {
    const watch = this.watches.get(viewId);
    if (watch === undefined) return;
    // 迟到的 unwatch（用户已经换到另一条结果）不许关掉当前观察。
    if (watchId !== undefined && watch.watchId !== watchId) return;
    this.drop(watch, true);
  }

  closeSession(sessionId: string): void {
    for (const watch of [...this.watches.values()]) {
      if (watch.sessionId === sessionId) this.drop(watch, true);
    }
  }

  closeAll(): void {
    for (const watch of [...this.watches.values()]) this.drop(watch, true);
  }

  suspendAll(): void {
    for (const watch of [...this.watches.values()]) {
      if (watch.closed) continue;
      watch.token += 1;
      watch.handle?.cancel();
      watch.handle = undefined;
      this.emitUnavailable(watch);
    }
  }

  /**
   * onConnected：恢复仍有效的观察。
   *
   * 只恢复 `client` **就是当前这个 client**、且 `sessionOf(viewId)` 仍等于描述里的
   * `sessionId` 的那些；其余（旧 client、断开期间登记的、已切走的会话）一律 `close`。
   * 旧服务器上的 `sessionId/seq` 即使在新服务器同名，也不是同一条会话实例。
   */
  resume(client: DshClient, sessionOf: (viewId: string) => string | undefined): void {
    for (const watch of [...this.watches.values()]) {
      if (watch.closed) continue;
      // 旧 client 的描述不能订阅到新服务器；观察时还没有 client 的描述同样不能猜。
      if (watch.client !== client) {
        this.drop(watch, true);
        continue;
      }
      // 窗口已经切走 / 解绑：这条观察不再属于当前界面。
      if (sessionOf(watch.viewId) !== watch.sessionId) {
        this.drop(watch, true);
        continue;
      }
      this.open(watch, client);
    }
  }

  /**
   * 丢弃描述。
   *
   * `notify` 时先推一帧 `available:false` 再删：窗口解绑 / 换会话 / 关页面这些路径
   * 需要**清值**，而调用方只拿到 `viewId`，不能自己拼 watchId。换观察（`observe`）
   * 不通知：界面已经换了新 watchId，旧号的 false 只会是噪声。
   */
  private drop(watch: WatchDescriptor, notify = true): void {
    if (watch.closed) return;
    if (notify) {
      watch.emit({
        type: "trajectory/result",
        seq: watch.seq,
        watchId: watch.watchId,
        available: false,
      });
    }
    watch.closed = true;
    watch.token += 1;
    watch.handle?.cancel();
    watch.handle = undefined;
    if (this.watches.get(watch.viewId) === watch) this.watches.delete(watch.viewId);
  }

  private open(watch: WatchDescriptor, client: DshClient | undefined): void {
    if (watch.closed || this.watches.get(watch.viewId) !== watch) return;
    watch.token += 1;
    watch.handle?.cancel();
    watch.handle = undefined;
    watch.client = client;
    if (client === undefined) {
      this.emitUnavailable(watch);
      return;
    }
    const token = watch.token;
    let handle: StreamHandle;
    try {
      handle = client.watchToolResult(watch.sessionId, watch.seq, {
        onItem: (value) => this.onItem(watch, client, token, value),
        onEnd: () => this.onStreamGone(watch, client, token),
        onError: () => this.onStreamGone(watch, client, token),
      });
    } catch {
      // `watchToolResult` 本身不抛（断线由回调报），但连接刚被 dispose 等边界可能抛；
      // 描述保留，等下一次 resume / observe。
      this.emitUnavailable(watch);
      return;
    }
    // 开流期间可能已被 close / 换观察 / 再次 resume：迟到的句柄立即取消。
    if (watch.closed || watch.token !== token || this.watches.get(watch.viewId) !== watch) {
      handle.cancel();
      return;
    }
    watch.handle = handle;
  }

  /** 回调仍然属于「这个视图的当前观察、这个 client、这次开流」。 */
  private isCurrent(watch: WatchDescriptor, client: DshClient, token: number): boolean {
    return (
      !watch.closed &&
      watch.token === token &&
      watch.client === client &&
      this.watches.get(watch.viewId) === watch
    );
  }

  private onItem(watch: WatchDescriptor, client: DshClient, token: number, raw: unknown): void {
    if (!this.isCurrent(watch, client, token)) return;
    const value = trajectoryResultValueFromWire(raw);
    if (value === undefined) return;
    if (value.available) {
      watch.emit({
        type: "trajectory/result",
        seq: watch.seq,
        watchId: watch.watchId,
        available: true,
        value: value.value,
      });
    } else {
      this.emitUnavailable(watch);
    }
  }

  /**
   * 流被服务端收掉 / 传输出错：当前值不可用，但**保留描述**——同 client 的 socket
   * 重连由 `resume` 重新开流。旧 client / 旧 token 的收尾在这里已被 `isCurrent` 拒绝。
   */
  private onStreamGone(watch: WatchDescriptor, client: DshClient, token: number): void {
    if (!this.isCurrent(watch, client, token)) return;
    // 这条流已经收场：先作废 token（之后排队的 onItem 一律失效），再取消句柄并清值；
    // 描述保留等 resume。同步 onError（还没返回 handle）时 handle 还是 undefined，
    // `open` 返回后由 token 不符把刚拿到的句柄取消。
    const handle = watch.handle;
    watch.token += 1;
    watch.handle = undefined;
    handle?.cancel();
    this.emitUnavailable(watch);
  }

  private emitUnavailable(watch: WatchDescriptor): void {
    if (watch.closed || this.watches.get(watch.viewId) !== watch) return;
    watch.emit({
      type: "trajectory/result",
      seq: watch.seq,
      watchId: watch.watchId,
      available: false,
    });
  }
}

/** 造一个每视图唯一的选中结果观察者（controller 持有单例）。 */
export function createTrajectoryResultWatchManager(): TrajectoryResultWatchManager {
  return new WatchManager();
}
