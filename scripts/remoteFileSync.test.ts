/**
 * 只读资源观察核心（`remoteFileSync.ts`）的行为断言：不 import `vscode`，
 * 用脚本化 target 与可控定时器驱动真实现。
 *
 * 覆盖主侧发现的真实缺陷：同一 URI 的两个 watch 各自 dispose、删除后观察不终结
 * 且重建发 Created、权限错误不冒充删除、慢 stat 不重叠、版本变化在同大小下仍
 * 提升 mtime、`ready` 期间 stat/订阅竞态、版本表与 timer 有界清理。
 */
import assert from "node:assert";
import {
  RemoteFileSync,
  type RemoteFileWatchTarget,
  type RemoteTimer,
} from "../src/dsh/remoteFileSync";
import type { HostFileWatchEvent } from "../src/dsh/remoteFiles";

/** 可手动推进的 interval 工厂；每个 timer 计数，便于断言清理。 */
class Scheduler {
  private readonly timers = new Set<{ callback: () => void; cancelled: boolean }>();

  get active(): number {
    return this.timers.size;
  }

  readonly setInterval = (callback: () => void, _ms: number): RemoteTimer => {
    const timer = { callback, cancelled: false };
    this.timers.add(timer);
    return {
      cancel: () => {
        if (timer.cancelled) return;
        timer.cancelled = true;
        this.timers.delete(timer);
      },
    };
  };

  tick(): void {
    for (const timer of [...this.timers]) timer.callback();
  }
}

/** 会话连接替身：stat 可挂起 / 失败 / 改版本；watch 返回可取消句柄。 */
class FakeTarget implements RemoteFileWatchTarget {
  closed = false;
  version = "v1";
  absolutePath = "/w/a.ts";
  failure: unknown;
  manual: Promise<void> | undefined;
  onSubscribe: (() => void) | undefined;
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  subscribeCount = 0;
  cancelCount = 0;
  private onEvent: ((event: HostFileWatchEvent) => void) | undefined;

  async stat(): Promise<{ version: string; absolutePath: string }> {
    // 快照在**进入 stat 那一刻**取：挂起期间版本变化时，返回的仍是旧版本，
    // 这样测试才能模拟「慢 stat 带回事件之前的状态」。
    const version = this.version;
    this.calls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.manual) await this.manual;
      if (this.failure !== undefined) throw this.failure;
      return { version, absolutePath: this.absolutePath };
    } finally {
      this.inFlight -= 1;
    }
  }

  watch(
    _absolutePath: string,
    onEvent: (event: HostFileWatchEvent) => void,
  ): { cancel(): void } {
    this.subscribeCount += 1;
    this.onEvent = onEvent;
    this.onSubscribe?.();
    return {
      cancel: () => {
        this.cancelCount += 1;
        if (this.onEvent === onEvent) this.onEvent = undefined;
      },
    };
  }

  emit(event: HostFileWatchEvent): void {
    this.onEvent?.(event);
  }
}

type Emitted = { key: string; change: string };

function makeSync(
  scheduler: Scheduler,
  options: Partial<ConstructorParameters<typeof RemoteFileSync>[0]> = {},
): { sync: RemoteFileSync; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const sync = new RemoteFileSync({
    emit: (key, change) => emitted.push({ key, change }),
    now: () => 1_000,
    setInterval: scheduler.setInterval,
    ...options,
  });
  return { sync, emitted };
}

/** 让已经排队的微任务 / Promise 链跑完（stat → subscribe → ready → check）。 */
async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------- 1. 版本 → mtime：同版本稳定，版本变了就严格递增（与大小无关） ----------
{
  const scheduler = new Scheduler();
  const { sync } = makeSync(scheduler);
  const first = sync.mtimeFor("u", "v1");
  // 「同 size 版本更新」在协议里只表现为 version 变化；mtime 必须跟着变大。
  assert.strictEqual(sync.mtimeFor("u", "v1"), first, "同一版本必须给同一个 mtime");
  const second = sync.mtimeFor("u", "v2");
  assert.ok(second > first, "版本变化必须给更大的 mtime，哪怕内容大小没变");
  const third = sync.mtimeFor("u", "v1");
  assert.ok(third > second, "版本回退也是一次变化，不能复用旧 mtime");
  sync.dispose();
}
console.log("remote-file-sync: 同版本 mtime 稳定、版本变化严格递增 ✓");

// ---------- 2. 同一 URI 的两次 watch：各自 dispose，最后一个才取消流 ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  const { sync, emitted } = makeSync(scheduler);
  const first = sync.watch("u", target);
  await settle();
  assert.strictEqual(target.subscribeCount, 1, "首次 watch 要订阅一次");
  assert.strictEqual(scheduler.active, 1, "一个 URI 只应有一个轮询 timer");
  const second = sync.watch("u", target);
  assert.strictEqual(scheduler.active, 1, "第二个 holder 不应再建 timer");
  assert.strictEqual(target.subscribeCount, 1, "第二个 holder 复用同一观察");

  first.dispose();
  assert.strictEqual(target.cancelCount, 0, "第一个 holder 释放时不能取消另一个 holder 的观察");
  assert.strictEqual(sync.watcherCount, 1);
  target.emit({ kind: "changed", version: "v2" });
  assert.deepStrictEqual(emitted, [{ key: "u", change: "changed" }]);

  second.dispose();
  assert.strictEqual(target.cancelCount, 1, "最后一个 holder 释放时才取消流");
  assert.strictEqual(sync.watcherCount, 0);
  assert.strictEqual(scheduler.active, 0, "timer 必须随最后一个 holder 一起清掉");
  // 重复 dispose 同一句柄不能多减引用 / 多取消一次
  second.dispose();
  assert.strictEqual(target.cancelCount, 1);
  sync.dispose();
}
console.log("remote-file-sync: 双 watch 引用计数、首个 dispose 不影响另一个 ✓");

// ---------- 3. 明确 absent：Deleted 不终结观察，重建发 Created ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  const { sync, emitted } = makeSync(scheduler);
  const handle = sync.watch("u", target);
  await settle();
  assert.strictEqual(emitted.length, 0, "首次 stat 不是一次变化");

  target.emit({ kind: "absent" });
  target.emit({ kind: "absent" });
  assert.deepStrictEqual(emitted, [{ key: "u", change: "deleted" }], "重复 absent 不重复发删除");
  assert.strictEqual(target.cancelCount, 0, "删除后观察必须继续，不能 dispose");
  assert.strictEqual(scheduler.active, 1, "删除期间 timer 仍在，等待重建");

  // 流失效后由轮询恢复：文件重新出现 → Created，并重新订阅。
  target.emit({ kind: "end" });
  target.version = "v2";
  scheduler.tick();
  await settle();
  assert.deepStrictEqual(emitted, [
    { key: "u", change: "deleted" },
    { key: "u", change: "created" },
  ]);
  assert.strictEqual(target.subscribeCount, 2, "重建后要重新订阅 Host 变更");
  handle.dispose();
  sync.dispose();
}
console.log("remote-file-sync: absent 不终结 watch、重建发 Created ✓");

// ---------- 4. 权限 / 未知错误不冒充删除；连接关闭才收观察 ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  const { sync, emitted } = makeSync(scheduler);
  sync.watch("u", target);
  await settle();

  target.failure = { reason: "denied" };
  scheduler.tick();
  await settle();
  assert.deepStrictEqual(emitted, [], "权限错误不是删除证据");
  assert.strictEqual(sync.watcherCount, 1, "观察必须保留，等下一次成功");
  assert.strictEqual(scheduler.active, 1);

  target.closed = true;
  const callsBeforeClose = target.calls;
  scheduler.tick();
  await settle();
  assert.strictEqual(sync.watcherCount, 0, "连接关闭后收掉观察");
  assert.strictEqual(scheduler.active, 0, "连接关闭后 timer 必须清理");
  assert.strictEqual(target.calls, callsBeforeClose, "已关闭的连接不再发请求");
  assert.deepStrictEqual(emitted, []);
  sync.dispose();
}
console.log("remote-file-sync: 权限未知不 Deleted、关闭连接不跨域读取 ✓");

// ---------- 5. ready 竞态：stat 与订阅之间变化也能补上 ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  target.onSubscribe = () => {
    // 第一次 stat 之后、订阅生效之前文件变了：只有 ready 补检查能发现。
    target.version = "v2";
    target.onSubscribe = undefined;
    target.emit({ kind: "ready" });
  };
  const { sync, emitted } = makeSync(scheduler);
  sync.watch("u", target);
  await settle(6);
  assert.deepStrictEqual(
    emitted,
    [{ key: "u", change: "changed" }],
    "ready 之后要重新 stat，不能漏掉订阅前的变化",
  );
  assert.strictEqual(target.maxInFlight, 1, "ready 的补检查不能与在飞的 stat 重叠");
  sync.dispose();
}
console.log("remote-file-sync: ready 后补 stat，覆盖订阅前变化 ✓");

// ---------- 6. 轮询单飞：slow stat 期间多个 tick 只排一次 ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  let release!: () => void;
  target.manual = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { sync } = makeSync(scheduler);
  sync.watch("u", target);
  await settle(1);
  assert.strictEqual(target.calls, 1);
  scheduler.tick();
  scheduler.tick();
  scheduler.tick();
  assert.strictEqual(target.calls, 1, "stat 未返回前不能并发再发");
  assert.strictEqual(target.maxInFlight, 1);
  target.manual = undefined;
  release();
  await settle(6);
  assert.strictEqual(target.calls, 2, "pending 只补一次检查");
  assert.strictEqual(target.maxInFlight, 1, "始终单飞");
  sync.dispose();
}
console.log("remote-file-sync: slow stat 单飞、pending 合并 ✓");

// ---------- 6b. 慢 stat 在飞时先到 changed：旧 stat 结果必须丢弃 ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  const { sync, emitted } = makeSync(scheduler);
  sync.watch("u", target);
  await settle();
  assert.strictEqual(target.calls, 1);

  let release!: () => void;
  target.manual = new Promise<void>((resolve) => {
    release = resolve;
  });
  scheduler.tick(); // stat 在飞，快照 = v1
  await settle(1);
  target.version = "v2";
  target.emit({ kind: "changed", version: "v2" });
  assert.deepStrictEqual(emitted, [{ key: "u", change: "changed" }], "事件本身先应用");

  target.manual = undefined;
  release();
  await settle(6);
  // 旧 stat（v1）不得把状态写回去、也不得再发一次 changed 或伪 Created；
  // 补查的 stat 读到 v2，与当前一致，静默。
  assert.deepStrictEqual(emitted, [{ key: "u", change: "changed" }]);
  assert.ok(target.calls >= 3, "事件之后要补一次 restat");
  assert.strictEqual(target.maxInFlight, 1, "补查仍单飞");
  sync.dispose();
}
console.log("remote-file-sync: stat 在飞时的新事件使旧结果作废并补查 ✓");

// ---------- 6c. 慢 stat 在飞时先到 absent：不得用旧 present 冒充重建 ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  const { sync, emitted } = makeSync(scheduler);
  sync.watch("u", target);
  await settle();

  let release!: () => void;
  target.manual = new Promise<void>((resolve) => {
    release = resolve;
  });
  scheduler.tick();
  await settle(1);
  target.emit({ kind: "absent" });
  assert.deepStrictEqual(emitted, [{ key: "u", change: "deleted" }]);
  target.manual = undefined;
  release();
  await settle(6);
  // 补查的 stat 仍是 present：这是一次新事实，发 Created（不是把旧 stat 当创建）。
  assert.deepStrictEqual(emitted, [
    { key: "u", change: "deleted" },
    { key: "u", change: "created" },
  ]);
  sync.dispose();
}
console.log("remote-file-sync: absent 在飞时旧 stat 不冒充状态 ✓");

// ---------- 7. 版本表与观察表有界，dispose 全清 ----------
{
  const scheduler = new Scheduler();
  const first = new FakeTarget();
  const second = new FakeTarget();
  const { sync } = makeSync(scheduler, { maxVersions: 2, maxWatchers: 2 });
  for (let index = 0; index < 6; index++) sync.mtimeFor(`k${index}`, "v1");
  assert.strictEqual(sync.versionCount, 2, "版本表必须有界");
  sync.watch("u1", first);
  sync.watch("u2", second);
  await settle();
  assert.strictEqual(sync.watcherCount, 2);
  assert.strictEqual(scheduler.active, 2);
  const overflow = sync.watch("u3", new FakeTarget());
  assert.strictEqual(sync.watcherCount, 2, "超过观察上限不建新观察");
  overflow.dispose(); // 空句柄：不影响已有观察
  assert.strictEqual(sync.watcherCount, 2);

  sync.dispose();
  assert.strictEqual(sync.watcherCount, 0);
  assert.strictEqual(sync.versionCount, 0, "dispose 清版本表");
  assert.strictEqual(scheduler.active, 0, "dispose 清全部 timer");
  assert.strictEqual(first.cancelCount, 1);
  assert.strictEqual(second.cancelCount, 1);
  // dispose 后新 watch 是空句柄，不再建 timer
  sync.watch("u4", new FakeTarget());
  assert.strictEqual(scheduler.active, 0);
}
console.log("remote-file-sync: 版本/观察/timer 有界并在 dispose 清理 ✓");

// ---------- 8. 已关闭连接：一开始就不发请求 ----------
{
  const scheduler = new Scheduler();
  const target = new FakeTarget();
  target.closed = true;
  const { sync, emitted } = makeSync(scheduler);
  const handle = sync.watch("u", target);
  await settle();
  assert.strictEqual(target.calls, 0, "closed 连接不发送 stat");
  assert.strictEqual(target.subscribeCount, 0);
  assert.deepStrictEqual(emitted, []);
  assert.strictEqual(sync.watcherCount, 0);
  assert.strictEqual(scheduler.active, 0);
  handle.dispose();
  sync.dispose();
}
console.log("remote-file-sync: 关闭连接不发请求、立即收掉观察 ✓");

console.log("\nremote-file-sync: all assertions passed");
