/**
 * 只读资源观察的**宿主核心**：版本 → 稳定 mtime、按 URI 引用计数观察、删除后
 * 保留观察并在重新出现时恢复、观察失败后的轮询兜底，以及全部表的容量上限。
 *
 * 为什么抽出来：`remoteFileSystem.ts` 直接依赖 `vscode`，离线测试跑不起来，而这里
 * 的规则恰恰最容易回归（同一 URI 的两次 watch、Deleted 之后的重建、慢 stat 与
 * 10 秒轮询重叠、版本表无界增长）。本模块**不 import `vscode`**，只描述
 * 「什么时候该发哪种变化」；provider 把事件翻成 `vscode.FileChangeType`。
 *
 * 状态规则：
 * - 版本是 opaque 字符串，**不是时间**。同一版本必须给出同一 mtime；版本变化用
 *   单调递增的逻辑时钟给新 mtime（至少 +1），同大小更新也会让 VS Code 重新读取。
 * - `not-found` 才发 deleted；权限 / 离线 / 未知错误不发任何状态变化。
 * - deleted 之后**不回收观察**：轮询继续，文件重新出现时发 created。
 * - 观察是**引用计数**的：同一 URI 的多个 holder 各自 dispose，最后一个才取消
 *   流与 timer。
 * - 单飞：slow stat 期间到期的下一次检查只记一个 pending，绝不会并发跑两个 stat。
 * - 轮询只是兜底（watch 不可用 / 流失效 / 删除期间）；`ready` 之后补一次检查，
 *   覆盖「stat 到订阅之间文件又变了」的窗口。
 */

import type { HostFileWatchEvent } from "./remoteFiles";

/** 交给 VS Code 的变化种类（provider 原样映射到 `FileChangeType`）。 */
export type RemoteChange = "changed" | "created" | "deleted";

/** 一个可观察目标：stat 与 watch 都绑定建立时的连接 / 会话 / 路径。 */
export interface RemoteFileWatchTarget {
  /** 该连接已关闭：立即收线，不向它询问任何东西。 */
  readonly closed: boolean;
  stat(): Promise<{ readonly version: string; readonly absolutePath: string }>;
  watch(
    absolutePath: string,
    onEvent: (event: HostFileWatchEvent) => void,
  ): { cancel(): void } | undefined;
}

/** 调用方持有的观察句柄；同一个 URI 的多次 `watch` 各自独立释放。 */
export interface RemoteFileWatchHandle {
  dispose(): void;
}

/** 定时器句柄（注入以便测试与 provider 共用一套清理语义）。 */
export interface RemoteTimer {
  cancel(): void;
}

export interface RemoteFileSyncOptions {
  /** 一个 URI 一次变化时通知（provider 据此 `onDidChangeFile.fire`）。 */
  readonly emit: (key: string, change: RemoteChange) => void;
  /** 同时观察的 URI 上限；超出的 watch 返回空句柄（文件仍可读）。 */
  readonly maxWatchers?: number;
  /** 版本 → mtime 表的上限（LRU 淘汰；stat / read 每次都会触碰）。 */
  readonly maxVersions?: number;
  /** 兜底 restat 间隔。 */
  readonly pollIntervalMs?: number;
  /** 逻辑时钟的墙钟下界；测试可注入固定值。 */
  readonly now?: () => number;
  /** 定时器工厂；默认 `setInterval`（unref，避免拖住扩展宿主退出）。 */
  readonly setInterval?: (callback: () => void, ms: number) => RemoteTimer;
}

const DEFAULT_MAX_WATCHERS = 32;
const DEFAULT_MAX_VERSIONS = 1_024;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** 默认定时器：与旧 provider 一致，不阻止进程退出。 */
function defaultSetInterval(callback: () => void, ms: number): RemoteTimer {
  const timer = setInterval(callback, ms);
  timer.unref?.();
  return { cancel: () => clearInterval(timer) };
}

/** 结构化的删除判据：只认 HostFileError 的 `absent`。 */
function isAbsentFailure(error: unknown): boolean {
  return (error as { reason?: unknown } | undefined)?.reason === "absent";
}

/** 结构化的连接关闭判据。 */
function isClosedFailure(error: unknown): boolean {
  return (error as { reason?: unknown } | undefined)?.reason === "closed";
}

/**
 * 版本 → mtime 的有界映射。
 *
 * 同一版本稳定返回同一个 mtime（VS Code 据此不重载）；版本变化返回严格更大的
 * 值，哪怕 Content-Length 没变、墙钟没走。LRU 淘汰只影响已关闭文档的旧资源。
 */
class VersionStamps {
  private readonly entries = new Map<string, { version: string; mtime: number }>();
  private clock = 0;

  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  mtimeFor(key: string, version: string): number {
    const previous = this.entries.get(key);
    if (previous?.version === version) {
      // 触碰 = 移到队尾（最近使用）；值本身不变。
      this.entries.delete(key);
      this.entries.set(key, previous);
      return previous.mtime;
    }
    const floor = Math.max(
      this.now(),
      (previous?.mtime ?? 0) + 1,
      this.clock + 1,
    );
    this.clock = floor;
    this.entries.delete(key);
    this.entries.set(key, { version, mtime: floor });
    this.trim();
    return floor;
  }

  private trim(): void {
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.clock = 0;
  }
}

/** 一个 URI 的观察状态；只有最后一个 holder 释放时才停 timer / 取消流。 */
class Endpoint {
  private refs = 1;
  private disposed = false;
  private version: string | undefined;
  private absent = false;
  private stream: { cancel(): void } | undefined;
  private streamGeneration = 0;
  private checking = false;
  private pending = false;
  /**
   * 观察流送来的状态事件代号。
   *
   * `version` 是 opaque 的，不能比较新旧；一次慢 stat 在飞时若先到了 changed /
   * absent，那次 stat 的结论就可能是**事件之前**的旧状态。发请求前记下代号，
   * 返回后不一致就丢弃并补一次 restat（不是把旧 version 写回去）。
   */
  private eventRevision = 0;
  private timer: RemoteTimer | undefined;

  constructor(
    private readonly owner: RemoteFileSync,
    private readonly key: string,
    private readonly target: RemoteFileWatchTarget,
  ) {}

  start(): void {
    this.timer = this.owner.schedule(() => this.requestCheck());
    this.requestCheck();
  }

  retain(): void {
    if (!this.disposed) this.refs += 1;
  }

  release(): void {
    if (this.disposed) return;
    this.refs -= 1;
    if (this.refs <= 0) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timer?.cancel();
    this.timer = undefined;
    this.stream?.cancel();
    this.stream = undefined;
    this.owner.forget(this.key, this);
  }

  /** 已安排的一次检查；请求落在检查期间时只记一个 pending。 */
  requestCheck(): void {
    if (this.disposed) return;
    if (this.checking) {
      this.pending = true;
      return;
    }
    this.checking = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      if (this.disposed) return;
      if (this.target.closed) {
        this.dispose();
        return;
      }
      let stat: { version: string; absolutePath: string };
      const revision = this.eventRevision;
      try {
        stat = await this.target.stat();
      } catch (error) {
        if (this.disposed) return;
        if (this.target.closed || isClosedFailure(error)) {
          this.dispose();
          return;
        }
        // 只有明确的 not-found 是一次删除；权限 / 离线 / 未知错误保持现状。
        if (this.eventRevision === revision && isAbsentFailure(error)) this.markAbsent();
        return;
      }
      if (this.disposed) return;
      if (this.target.closed) {
        this.dispose();
        return;
      }
      // stat 在飞期间收到了更新的状态事件：这次结果属于事件之前，丢弃并补查。
      if (this.eventRevision !== revision) {
        this.pending = true;
        return;
      }
      this.observe(stat.version);
      this.subscribe(stat.absolutePath);
    } finally {
      this.checking = false;
      if (this.pending && !this.disposed) {
        this.pending = false;
        this.requestCheck();
      }
    }
  }

  /** 一次成功的 stat：按版本决定是否通知。首次只登记，不发「刚打开就变了」。 */
  private observe(version: string): void {
    if (this.absent) {
      this.absent = false;
      this.version = version;
      this.owner.stamp(this.key, version);
      this.owner.emit(this.key, "created");
      return;
    }
    if (this.version === undefined) {
      this.version = version;
      this.owner.stamp(this.key, version);
      return;
    }
    if (this.version === version) return;
    this.version = version;
    this.owner.stamp(this.key, version);
    this.owner.emit(this.key, "changed");
  }

  private markAbsent(): void {
    if (this.absent) return;
    this.absent = true;
    this.version = undefined;
    // **不**收观察：删除后重建必须还能恢复；timer 与流都留着。
    this.owner.emit(this.key, "deleted");
  }

  private subscribe(absolutePath: string): void {
    if (this.disposed || this.stream !== undefined) return;
    const generation = (this.streamGeneration += 1);
    const handle = this.target.watch(absolutePath, (event) => {
      if (this.disposed || generation !== this.streamGeneration) return;
      this.onEvent(event);
    });
    if (handle) this.stream = handle;
  }

  private onEvent(event: HostFileWatchEvent): void {
    if (this.disposed) return;
    if (this.target.closed) {
      this.dispose();
      return;
    }
    switch (event.kind) {
      case "ready":
        // stat 与订阅之间可能已经变了：补一次检查，不把 ready 当状态。
        this.requestCheck();
        return;
      case "changed":
        this.eventRevision += 1;
        this.observeVersion(event.version);
        return;
      case "absent":
        this.eventRevision += 1;
        this.markAbsent();
        return;
      case "error":
      case "end":
        // 流失效不推断文件状态；保留轮询，下一轮 stat 会重新订阅。
        this.stream?.cancel();
        this.stream = undefined;
        this.streamGeneration += 1;
        return;
    }
  }

  /** 流事件里的版本：同一版本不重复通知，删除后收到版本视为重新出现。 */
  private observeVersion(version: string): void {
    if (this.absent) {
      this.absent = false;
      this.version = version;
      this.owner.stamp(this.key, version);
      this.owner.emit(this.key, "created");
      return;
    }
    if (this.version === version) return;
    this.version = version;
    this.owner.stamp(this.key, version);
    this.owner.emit(this.key, "changed");
  }
}

/**
 * 多个 URI 的观察表 + 版本表。
 *
 * provider 只持有这一个对象：`watch` 建观察，`mtimeFor` 给 stat / read 的
 * FileStat 用，`dispose` 收掉全部 timer / 流 / 表。
 */
export class RemoteFileSync {
  private readonly watchers = new Map<string, Endpoint>();
  private readonly stamps: VersionStamps;
  private readonly maxWatchers: number;
  private readonly pollIntervalMs: number;
  private readonly emitChange: (key: string, change: RemoteChange) => void;
  private readonly startTimer: (callback: () => void, ms: number) => RemoteTimer;
  private disposed = false;

  constructor(options: RemoteFileSyncOptions) {
    this.emitChange = options.emit;
    this.maxWatchers = Math.max(1, options.maxWatchers ?? DEFAULT_MAX_WATCHERS);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.startTimer = options.setInterval ?? defaultSetInterval;
    this.stamps = new VersionStamps(
      Math.max(1, options.maxVersions ?? DEFAULT_MAX_VERSIONS),
      options.now ?? Date.now,
    );
  }

  /** 当前观察的 URI 数（测试与诊断）。 */
  get watcherCount(): number {
    return this.watchers.size;
  }

  /** 版本表的条目数（有界；测试用）。 */
  get versionCount(): number {
    return this.stamps.size;
  }

  /** 同一版本稳定、版本变化严格递增的 mtime。 */
  mtimeFor(key: string, version: string): number {
    return this.stamps.mtimeFor(key, version);
  }

  /** 供 Endpoint 用的定时器工厂（同一个注入实现，测试可手动 tick）。 */
  schedule(callback: () => void): RemoteTimer {
    return this.startTimer(callback, this.pollIntervalMs);
  }

  stamp(key: string, version: string): void {
    this.stamps.mtimeFor(key, version);
  }

  emit(key: string, change: RemoteChange): void {
    if (!this.disposed) this.emitChange(key, change);
  }

  forget(key: string, endpoint: Endpoint): void {
    if (this.watchers.get(key) === endpoint) this.watchers.delete(key);
  }

  watch(key: string, target: RemoteFileWatchTarget): RemoteFileWatchHandle {
    const noop: RemoteFileWatchHandle = { dispose: () => {} };
    if (this.disposed) return noop;
    const existing = this.watchers.get(key);
    if (existing) {
      existing.retain();
      return handleFor(existing);
    }
    if (this.watchers.size >= this.maxWatchers) return noop;
    const endpoint = new Endpoint(this, key, target);
    this.watchers.set(key, endpoint);
    endpoint.start();
    return handleFor(endpoint);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const endpoint of [...this.watchers.values()]) endpoint.dispose();
    this.watchers.clear();
    this.stamps.clear();
  }
}

/**
 * 每个 holder 一份独立句柄：重复 dispose 不会多减引用。
 */
function handleFor(endpoint: Endpoint): RemoteFileWatchHandle {
  let released = false;
  return {
    dispose: () => {
      if (released) return;
      released = true;
      endpoint.release();
    },
  };
}
