/**
 * 轨迹 Result 页「选中工具结果」的 webview 侧观察。
 *
 * 界面只持有一条观察：`useTrajectoryResult(seq)` 在 `seq` 变化时向宿主发
 * `watchTrajectoryResult`，旧观察先 `unwatchTrajectoryResult`；组件卸载 / Result 页
 * 关闭同样释放。宿主回 `trajectory/result`，`watchId` 与 `seq` 不匹配的迟到帧整帧
 * 丢弃（旧连接、旧行、旧观察都进不来）。
 *
 * 值不在界面缓存：这里只有**当前这一条**的值，没有 `seq → value` 表；换行 / 切代 /
 * 销毁立即把快照换成 `available:false`，不会先闪一下上一条结果。`null` / `false` /
 * `0` / 空串 / 空对象都是有效结果，不能用 truthiness 判空。
 *
 * `images/scope` 是执行世界（连接）换代：收到的同一刻清空当前值、**释放**观察并把
 * `scopeGeneration` +1，不把旧 seq 重发到新服务器。界面按这个代次复位选中项（见
 * `useTrajectoryScopeGeneration`），用户重新选中后 `bind` 才订阅；同一 client 的短线
 * 重连由宿主 `resume` 重开，既不改代次也不经过这里。
 */
import { useEffect, useSyncExternalStore } from "react";
import type { HostToWebview, TrajectoryResultFrame, WebviewToHost } from "../shared/ipc";
import { post as postToHost, subscribe as subscribeHost } from "./bridge";

/** Result 页当前拿到的值；`value` 只在 `available` 为真时存在。 */
export interface TrajectoryResultView {
  available: boolean;
  value?: unknown;
}

const UNAVAILABLE: TrajectoryResultView = { available: false };

/** 观察所需的两个宿主端口：测试可注入假实现，生产用 `bridge`。 */
export interface TrajectoryResultPorts {
  post(message: WebviewToHost): void;
  subscribe(listener: (message: HostToWebview) => void): () => void;
}

/** 纯观察器：不依赖 React，可离线断言（`createTrajectoryResultWatcher` 的产物）。 */
export interface TrajectoryResultWatcher {
  /** 当前快照（引用稳定；只在值 / 可用性变化时换新对象）。 */
  getSnapshot(): TrajectoryResultView;
  subscribe(listener: () => void): () => void;
  /** 观察一个 `seq`；`undefined` = 当前没有可看的 Result（不订阅、清空旧值）。 */
  bind(seq: number | undefined): void;
  /** 当前绑定的是哪个 `seq`（React 渲染期用来拒绝「effect 还没跑」时的上一 seq 值）。 */
  currentSeq(): number | undefined;
  /**
   * 执行世界（连接）的代次：`images/scope` 换到**另一个**连接时 +1。
   *
   * 首个连接号只记认、重复通知不换代，所以它表达的是「旧世界的选中 / 序号已经作废」，
   * 而不是「刚连上」。界面用它复位选中项；同一 client 的短线重连不改它。
   */
  scopeGeneration(): number;
  /** 释放观察并取消宿主订阅（页面销毁 / 测试收尾）。 */
  dispose(): void;
}

let nextWatchId = 0;

function createWatchId(): number {
  nextWatchId += 1;
  return nextWatchId;
}

/** `seq` 的唯一合法形态；其它值（含 undefined）都表示「没有选中结果」。 */
function watchedSeq(seq: number | undefined): number | undefined {
  return seq !== undefined && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
}

class Watcher implements TrajectoryResultWatcher {
  private snapshot: TrajectoryResultView = UNAVAILABLE;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;
  private seq: number | undefined;
  private watchId = 0;
  private connectionId: string | null | undefined;
  /** 执行世界代次；只在连接号真的换了一条时 +1（首个连接号与重复通知都不算）。 */
  private generation = 0;
  private disposed = false;

  constructor(private readonly ports: TrajectoryResultPorts) {
    this.off = ports.subscribe((message) => this.onMessage(message));
  }

  // `useSyncExternalStore` 会把这两个方法拿出来裸调用；箭头属性保证 `this` 不丢。
  readonly getSnapshot = (): TrajectoryResultView => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly currentSeq = (): number | undefined => this.seq;

  readonly scopeGeneration = (): number => this.generation;

  readonly bind = (seq: number | undefined): void => {
    if (this.disposed) return;
    const next = watchedSeq(seq);
    if (next === this.seq) {
      // 同一 seq 的显式重绑（例如 Inspector 重挂）：连接换代后 watchId 已归零，
      // 这时才允许重新订阅；平时的重复渲染不会发多余请求。
      if (next !== undefined && this.watchId === 0) this.postWatch();
      return;
    }
    this.releaseWatch();
    this.seq = next;
    this.setSnapshot(UNAVAILABLE);
    if (next !== undefined) this.postWatch();
  };

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseWatch();
    this.seq = undefined;
    this.setSnapshot(UNAVAILABLE);
    this.off();
    this.listeners.clear();
  };

  private onMessage(message: HostToWebview): void {
    if (this.disposed) return;
    if (message.type === "trajectory/result") {
      this.onResult(message);
      return;
    }
    if (message.type !== "images/scope") return;
    const next = message.connectionId;
    if (this.connectionId === undefined) {
      // 本页第一次拿到连接号：观察若已经发出去，它本来就是针对这条连接的；
      // 不清值、不重发，避免把刚收到的首帧抹掉。
      this.connectionId = next;
      return;
    }
    if (next === this.connectionId) return;
    this.connectionId = next;
    // 连接换代（新 client / 另一台服务器）：**只清值、释放旧观察并推进代次，不重发**。
    // 旧 seq 属于旧服务器的会话实例，直接订阅到新服务器同名 session 就是读错对象。
    // 界面按代次复位选中项；用户重新选中后由 `bind(seq)`（watchId 已归零）重新订阅。
    // 同一 client 的短线重连不经过这里，由宿主 `resume` 在原连接上重开。
    this.generation += 1;
    this.releaseWatch();
    // 代次变化必须**无条件**通知：当前值可能已经是 `available:false`（快照引用不变），
    // 只靠 `setSnapshot` 会漏掉这次换代，界面就不会复位选择。
    this.snapshot = UNAVAILABLE;
    this.notify();
  }

  private onResult(message: TrajectoryResultFrame): void {
    if (this.seq === undefined || message.watchId !== this.watchId || message.seq !== this.seq) return;
    if (message.available === true) {
      // `available:true` 必须带值；缺 value 是坏帧（与 null / false / 0 / "" 不同），整帧丢弃。
      if (!Object.prototype.hasOwnProperty.call(message, "value") || message.value === undefined) return;
      this.setSnapshot({ available: true, value: message.value });
      return;
    }
    if (message.available === false) this.setSnapshot(UNAVAILABLE);
  }

  private postWatch(): void {
    if (this.disposed || this.seq === undefined) return;
    this.watchId = createWatchId();
    this.ports.post({ type: "watchTrajectoryResult", seq: this.seq, watchId: this.watchId });
  }

  private releaseWatch(): void {
    if (this.watchId === 0) return;
    const watchId = this.watchId;
    this.watchId = 0;
    this.ports.post({ type: "unwatchTrajectoryResult", watchId });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private setSnapshot(next: TrajectoryResultView): void {
    if (this.snapshot.available === next.available && Object.is(this.snapshot.value, next.value)) return;
    this.snapshot = next;
    this.notify();
  }
}

/** 造一个观察器（测试注入假端口；生产用模块底部的 singleton）。 */
export function createTrajectoryResultWatcher(ports: TrajectoryResultPorts): TrajectoryResultWatcher {
  return new Watcher(ports);
}

const shared = createTrajectoryResultWatcher({ post: postToHost, subscribe: subscribeHost });

/**
 * 执行世界（连接）的代次：`images/scope` 换到另一个连接时 +1，首个连接号与重复通知不变。
 *
 * 界面（`TrajectoryView`）在本代世界换代时复位选中项：旧世界的记录序号对新服务器没有
 * 意义，检查器因此卸载、结果观察随卸载释放；等新轨迹和用户重新选中，才由
 * `useTrajectoryResult` 重新订阅。同一 client 的短线重连不改代次。
 * @returns 当前代次（`0` = 还没发生过换代）。
 */
export function useTrajectoryScopeGeneration(): number {
  return useSyncExternalStore(shared.subscribe, shared.scopeGeneration, shared.scopeGeneration);
}

/**
 * Result 页当前选中结果的实时值。
 *
 * @param seq durable 的 `tool/result` 事件序号；`undefined` = 没有选中可看的结果，
 *   不订阅、返回 `{available:false}`。
 */
export function useTrajectoryResult(seq: number | undefined): TrajectoryResultView {
  useEffect(() => {
    shared.bind(seq);
    return () => {
      shared.bind(undefined);
    };
  }, [seq]);
  const snapshot = useSyncExternalStore(shared.subscribe, shared.getSnapshot, shared.getSnapshot);
  // 渲染可能发生在 effect 之前：此时 watcher 还绑在上一个 seq 上。返回值必须与本次
  // 渲染要的 seq 匹配，否则会先闪一下上一条结果（`seq === undefined` 时同样不能给旧值）。
  return shared.currentSeq() === watchedSeq(seq) ? snapshot : UNAVAILABLE;
}
