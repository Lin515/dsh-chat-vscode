/**
 * 消息通知的**行为级**回归：队列核心（纯） + 宿主接线（驱真 `ChatController` + `vscodeTestStub`）。
 *
 * 规则见 `docs/design-notifications.md`，实现见 `src/dsh/notificationQueue.ts` 与
 * `controller` 的 `notify` / `publishNotifications` / `applyWorkingDirectoryProjection`。
 * 这里不抄源码字符串——每一条都真的调用实现（队列或控制器），断言的是可观察行为。
 *
 * 覆盖：
 * 1. 合并判据（归属 / 级别 / 类型 / 关键内容）与次数、最近发生的排序（固定时钟）；
 * 2. 确认：整条确认后复发新建、**迟到确认**只吞它看到的那部分（剩余换新 id）；
 * 3. 可见范围（当前会话 + 共享；未绑定只剩共享）与 id 唯一；
 * 4. durable `seq` 水位：重发不计数、1000 条之后老 seq 仍被拒、按会话隔离、
 *    会话真删除时清理；
 * 5. 容量：已确认保留 500、未确认不淘汰；
 * 6. 多视图：一次发生只算一次、镜像按视图隔离、确认跨视图同步、视图关闭重绑后仍在；
 * 7. 界面本地复制失败：归属校验 + 每窗口请求号水位（畸形帧不污染）；
 * 8. 执行目录：只有 live 且真的换了目录才通知（开帧 / baseline / null / 同水位静默）；
 * 9. 命令接线：没有活动窗口时唤起主侧栏，**只**由主侧栏 ready 消费并只向它开抽屉。
 *
 * 运行：npm test（已登记在 esbuild.scripts.mjs 的 entries 里）
 */
import assert from "node:assert";
import { NotificationQueue, ACKED_HISTORY_LIMIT } from "../src/dsh/notificationQueue";
import { executedCommands } from "./vscodeTestStub";

// 控制器在模块顶层 import 时会读 `vscode` 的若干面，stub 已在 esbuild alias 里准备好
// （与 `queueRestore.test.ts` / `attachmentLifecycle.test.ts` 同一条路子）。
const { ChatController } = await import("../src/dsh/controller");

// ============================ 一、队列核心（纯函数） ============================

console.log("notificationQueue: 队列核心");

// ---------- 1. 合并判据与排序（固定时钟） ----------
{
  const queue = new NotificationQueue(() => 1000);
  const first = queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", key: "a", text: "@a" });
  assert.ok(first, "第一条应入队");
  assert.strictEqual(first.id, "n1");
  assert.strictEqual(first.count, 1);

  // 同归属 + 同级别 + 同类型 + 同关键内容：合并、累加、更新最近发生
  const merged = queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", key: "a", text: "@a" });
  assert.strictEqual(merged?.id, "n1", "重复发生合并进同一条");
  assert.strictEqual(merged?.count, 2, "次数累加");
  assert.strictEqual(queue.pendingCount(), 1, "合并后仍只有一条未确认");
  assert.strictEqual(queue.ackedCount(), 0);

  // 不同关键内容：各自成条（`key` 显式给）
  const other = queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", key: "b", text: "@b" });
  assert.notStrictEqual(other?.id, "n1");
  // 不同归属
  const otherSession = queue.enqueue({ sessionId: "s2", level: "warn", kind: "k", key: "a", text: "@a" });
  assert.notStrictEqual(otherSession?.id, "n1");
  // 不同级别
  const otherLevel = queue.enqueue({ sessionId: "s1", level: "error", kind: "k", key: "a", text: "@a" });
  assert.notStrictEqual(otherLevel?.id, "n1");

  // 缺省关键内容 = text：插值过的两条（只有参数不同）**不合并**——这正是
  // `@agentPresetFailed:<reason>` / `@fileNotFound:<path>` 不能错并的保护
  const reasonA = queue.enqueue({ sessionId: "s1", level: "warn", kind: "preset", text: "@p:reasonA" });
  const reasonB = queue.enqueue({ sessionId: "s1", level: "warn", kind: "preset", text: "@p:reasonB" });
  assert.notStrictEqual(reasonA?.id, reasonB?.id, "text 不同且没给 key 时不许合并");
  assert.strictEqual(reasonB?.count, 1, "不合并意味着各自从 1 起算");

  // 固定时钟下：刚合并的那条要置顶（lastAt 相同，靠单调发生序号裁决）
  const order = queue.visible("s1").map((record) => record.id);
  assert.strictEqual(order[0], reasonB?.id, `最近发生的排最前：${order.join(",")}`);
  assert.strictEqual(new Set(order).size, order.length, "可见列表里的 id 必须唯一");
  console.log("  ✓ 合并判据、次数累加、缺省 key=text、固定时钟置顶与 id 唯一");
}

// ---------- 2. 确认：整条 / 迟到（部分） / 旧 id 幂等 ----------
{
  const queue = new NotificationQueue(() => 500);
  queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", text: "@a" });
  queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", text: "@a" }); // 合并成 count=2

  // 迟到确认：用户看到的是 count=1 的那一份
  const before = queue.visible("s1")[0];
  assert.strictEqual(before.count, 2);
  assert.strictEqual(queue.acknowledge(before.id, 1), true, "看到 1 次就确认那 1 次");
  assert.strictEqual(queue.pendingCount(), 1, "剩余那一次继续未确认");
  assert.strictEqual(queue.ackedCount(), 1, "看到的那部分进历史");
  const rest = queue.visible("s1").find((record) => !record.acknowledged);
  assert.ok(rest, "剩余部分仍在未确认里");
  assert.notStrictEqual(rest.id, before.id, "剩余部分换新 id（旧 id 只存在于历史里）");
  assert.strictEqual(rest.count, 1);
  assert.ok(
    queue.visible("s1").filter((record) => record.id === before.id).length === 1,
    "同一个 id 不许同时出现在未确认与已确认两份里",
  );
  // 第二个视图拿旧 id + 旧次数再确认：空操作（不能吞掉剩余那次）
  assert.strictEqual(queue.acknowledge(before.id, 1), false, "旧 id 的迟到确认是幂等空操作");
  assert.strictEqual(queue.pendingCount(), 1, "剩余发生没被吞掉");

  // 整条确认 + 复发新建
  assert.strictEqual(queue.acknowledge(rest.id, 1), true);
  assert.strictEqual(queue.pendingCount(), 0);
  const again = queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", text: "@a" });
  assert.ok(again, "确认后再次实际发生要新建");
  assert.strictEqual(again.count, 1, "新记录从头计数");
  assert.notStrictEqual(again.id, before.id, "不修改旧的已确认记录");
  assert.strictEqual(queue.ackedCount(), 2, "已确认历史保留两条");
  console.log("  ✓ 部分确认换新 id、旧 ack 幂等、复发新建");
}

// ---------- 3. 可见范围：当前会话 + 共享；未绑定只剩共享 ----------
{
  const queue = new NotificationQueue(() => 0);
  queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", text: "@onlyS1" });
  queue.enqueue({ sessionId: "s2", level: "warn", kind: "k", text: "@onlyS2" });
  queue.enqueue({ level: "info", kind: "k", text: "@shared" });

  const s1 = queue.visible("s1").map((record) => record.text).sort();
  assert.deepStrictEqual(s1, ["@onlyS1", "@shared"], `s1 只该看到自己的 + 共享：${s1.join(",")}`);
  const s2 = queue.visible("s2").map((record) => record.text).sort();
  assert.deepStrictEqual(s2, ["@onlyS2", "@shared"]);
  const none = queue.visible(undefined).map((record) => record.text);
  assert.deepStrictEqual(none, ["@shared"], "没有绑定会话的视图只展示共享通知");
  console.log("  ✓ 可见范围按会话过滤，未绑定只剩共享");
}

// ---------- 4. durable seq 水位：重发不计数 / 1000 条后仍拒 / 按会话 / 删除清理 ----------
{
  const queue = new NotificationQueue(() => 0);
  const first = queue.enqueue({ sessionId: "s1", level: "warn", kind: "unknownEvent", key: "x", text: "@u:x", seq: 7 });
  assert.ok(first);
  const replay = queue.enqueue({ sessionId: "s1", level: "warn", kind: "unknownEvent", key: "x", text: "@u:x", seq: 7 });
  assert.strictEqual(replay, undefined, "同一个 seq 再进来不是新的实际发生");
  assert.strictEqual(queue.pendingCount(), 1, "重发不新建");
  assert.strictEqual(queue.visible("s1")[0].count, 1, "重发不累加次数");

  // 确认之后同一条 seq 更不许复活
  queue.acknowledge(first.id, 1);
  assert.strictEqual(
    queue.enqueue({ sessionId: "s1", level: "warn", kind: "unknownEvent", key: "x", text: "@u:x", seq: 7 }),
    undefined,
    "确认后重放同一条 seq 也不许新建",
  );
  assert.strictEqual(queue.ackedCount(), 1);

  // 真实递增的 seq：新的实际发生（合并 / 计数）
  const next = queue.enqueue({ sessionId: "s1", level: "warn", kind: "unknownEvent", key: "x", text: "@u:x", seq: 8 });
  assert.ok(next, "更大的 seq 是新的实际发生");
  assert.strictEqual(next.count, 1, "确认之后是**新记录**，从 1 起算");

  // 1000+ 条之后，老 seq 仍被拒（水位与条数无关）
  for (let seq = 100; seq < 1200; seq += 1) {
    assert.ok(
      queue.enqueue({ sessionId: "s1", level: "warn", kind: "unknownEvent", key: `t${seq}`, text: `@u:t${seq}`, seq }),
      `seq=${seq} 是新发生`,
    );
  }
  assert.strictEqual(
    queue.enqueue({ sessionId: "s1", level: "warn", kind: "unknownEvent", key: "x", text: "@u:x", seq: 9 }),
    undefined,
    "1200 条之后，一个老 seq 仍不许新增（水位不是「记住每条 seq」）",
  );

  // 按会话隔离：别的会话从自己的 0 起算
  assert.ok(
    queue.enqueue({ sessionId: "s2", level: "warn", kind: "unknownEvent", key: "y", text: "@u:y", seq: 1 }),
    "水位按会话记，另一条会话的小 seq 不受影响",
  );

  // 共享通知不传 seq：不参与水位（水位只按会话记，共享那档共用 `""`）
  const shared = queue.enqueue({ level: "warn", kind: "k", text: "@shared" });
  assert.ok(shared);

  const watermarkBefore = queue.watermarkCount();
  assert.strictEqual(watermarkBefore, 2, "只有两条会话各一份水位（共享通知不传 seq，不建水位）");
  queue.forgetSession("s1");
  assert.strictEqual(queue.watermarkCount(), 1, "会话真删除时水位被清理");
  assert.ok(
    queue.enqueue({ sessionId: "s1", level: "warn", kind: "unknownEvent", key: "z", text: "@u:z", seq: 5 }),
    "清理之后这条会话的水位从头开始",
  );
  console.log("  ✓ seq 水位：重发不计数、1000+ 后老 seq 仍拒、按会话隔离、forgetSession 清理");
}

// ---------- 5. 容量：已确认 500、未确认不淘汰 ----------
{
  const queue = new NotificationQueue(() => 0);
  for (let index = 0; index < ACKED_HISTORY_LIMIT + 40; index += 1) {
    const record = queue.enqueue({ sessionId: "s1", level: "warn", kind: "k", text: `@n${index}` });
    assert.ok(record);
    queue.acknowledge(record.id, 1);
  }
  assert.strictEqual(queue.ackedCount(), ACKED_HISTORY_LIMIT, "已确认历史最多保留最近 500 条");
  const visible = queue.visible("s1");
  assert.strictEqual(visible.filter((record) => record.acknowledged).length, ACKED_HISTORY_LIMIT);

  // 未确认不淘汰
  const fresh = new NotificationQueue(() => 0);
  for (let index = 0; index < ACKED_HISTORY_LIMIT + 5; index += 1) {
    fresh.enqueue({ sessionId: "s1", level: "warn", kind: "k", text: `@p${index}` });
  }
  assert.strictEqual(fresh.pendingCount(), ACKED_HISTORY_LIMIT + 5, "未确认通知不自动淘汰");
  console.log("  ✓ 已确认 500 上限、未确认不淘汰");
}

// ============================ 二、宿主接线（真控制器） ============================

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}
interface NoticeMirror {
  id: string;
  sessionId?: string;
  level: string;
  text: string;
  count: number;
  acknowledged: boolean;
}
interface Internals {
  client: unknown;
  connection: string;
  sessions: { id: string; title: string; updatedAt: number; running: boolean; cwd?: string }[];
  scopes: Map<string, unknown>;
  viewSessions: Map<string, string | undefined>;
  notifications: {
    visible(sessionId: string | undefined): NoticeMirror[];
    pendingCount(): number;
    ackedCount(): number;
    watermarkCount(): number;
    /** 只为铺一条 durable `seq` 水位用（`deleteSession` 清理它的行为断言）。 */
    enqueue(input: { sessionId?: string; level: string; kind: string; text: string; seq?: number }): unknown;
  };
  subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
  bindView(viewId: string): void;
  bindViewKind(viewId: string, kind: "primary" | "secondary" | "panel"): void;
  unbindView(viewId: string): void;
  openSession(viewId: string, sessionId: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  onControlFrame(frame: Record<string, unknown>): void;
  openNotifications(): void;
  deleteSession(sessionId: string): Promise<void>;
  /** 会话日志目录查找：离线台把它钉成「不存在」，**绝不扫真实 `~/.dsh/sessions`**。 */
  findSessionDir(sessionId: string): string | undefined;
}

const S1 = "session-aaa";
const S2 = "session-bbb";

const fakeServer = () => ({
  externalUrl: undefined,
  onHeartbeat() {},
  snapshot() {
    return { status: { info: undefined }, supervisorAlive: false };
  },
});

const fakeMemento = () => {
  const map = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    keys: () => [...map.keys()],
    /** 断言「队列不落盘」用（键集合里不许出现通知相关的东西）。 */
    dumpKeys: () => [...map.keys()],
  };
};

interface Harness {
  c: Internals;
  frames: Captured[];
  globalState: ReturnType<typeof fakeMemento>;
  workspaceState: ReturnType<typeof fakeMemento>;
  /** 假客户端对 `commands/execute` 的应答（命令分流回归自己设）。 */
  commandReply: unknown;
}

function harness(): Harness {
  const globalState = fakeMemento();
  const workspaceState = fakeMemento();
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    globalState as never,
    workspaceState as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  (
    controller as unknown as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));

  const c = controller as unknown as Internals;
  const h: Harness = { c, frames, globalState, workspaceState, commandReply: undefined };
  const client = {
    request: async (method: string) => {
      if (method === "commands/list") return [];
      if (method === "commands/execute") return h.commandReply;
      return undefined;
    },
    sessionProjections: async () => ({ values: {} }),
    getJson: async () => undefined,
    settingsDescribe: async () => ({ namespaces: [] }),
    followSession: () => ({ cancel() {} }),
    followJobs: () => ({ cancel() {} }),
    followControl: () => ({ cancel() {} }),
  };
  c.client = client as never;
  c.connection = "connected";
  // 删除路径只验证「水位被清理」：目录查找钉成不存在，测试不碰真实会话日志
  c.findSessionDir = () => undefined;
  c.sessions = [
    { id: S1, title: "A", updatedAt: 1, running: false, cwd: process.cwd() },
    { id: S2, title: "B", updatedAt: 1, running: false, cwd: process.cwd() },
  ];
  return h;
}

/** 某个窗口**最近一次**收到的通知镜像（宿主按视图过滤后下发）。 */
function mirrorOf(h: Harness, target: string): NoticeMirror[] {
  let latest: NoticeMirror[] = [];
  for (const captured of h.frames) {
    if (captured.target !== target) continue;
    const patch = captured.frame.patch as { notifications?: NoticeMirror[] } | undefined;
    if (patch?.notifications) latest = patch.notifications;
  }
  return latest;
}

function textsOf(h: Harness, target: string): string[] {
  return mirrorOf(h, target).map((notice) => notice.text);
}

/** 打开会话并等它绑好。 */
async function open(h: Harness, viewId: string, sessionId: string): Promise<void> {
  h.c.bindView(viewId);
  await h.c.openSession(viewId, sessionId);
}

// ---------- 6. 多视图：一次发生只算一次、镜像隔离、确认同步、关闭重绑保留 ----------
{
  const h = harness();
  await open(h, "v1", S1);
  await open(h, "v2", S1);
  await open(h, "v3", S2);
  h.frames.length = 0;

  // 一次「实际发生」：界面本地复制图片失败（归属 S1）
  await h.c.handle({ type: "reportImageCopyFailure", sessionId: S1, requestId: 1 }, "v1");

  assert.strictEqual(h.c.notifications.pendingCount(), 1, "两个窗口看同一条会话，次数只算一次");
  assert.deepStrictEqual(textsOf(h, "v1"), ["@imageCopyFailed"], "发起窗口看得到");
  assert.deepStrictEqual(textsOf(h, "v2"), ["@imageCopyFailed"], "同一会话的另一个窗口也看得到（镜像）");
  assert.deepStrictEqual(textsOf(h, "v3"), [], "别的会话的窗口看不到（归属过滤）");

  // 确认跨视图同步：v2 用**同一份镜像**的 id/count 确认
  const fromV2 = mirrorOf(h, "v2")[0];
  await h.c.handle({ type: "acknowledgeNotification", id: fromV2.id, count: fromV2.count }, "v2");
  assert.strictEqual(h.c.notifications.pendingCount(), 0, "任一视图确认即生效");
  assert.strictEqual(h.c.notifications.ackedCount(), 1);
  const v1Acked = mirrorOf(h, "v1").find((notice) => notice.id === fromV2.id);
  assert.strictEqual(v1Acked?.acknowledged, true, "同步到**所有**视图（v1 那份也标成已确认）");
  assert.strictEqual(mirrorOf(h, "v1").filter((notice) => !notice.acknowledged).length, 0, "确认后顶部不再占位");

  // 空操作确认（旧 id）也要回一份权威镜像，不能无响应
  h.frames.length = 0;
  await h.c.handle({ type: "acknowledgeNotification", id: "n-does-not-exist", count: 1 }, "v1");
  assert.strictEqual(mirrorOf(h, "v1").length, 1, "过期确认也回权威镜像（界面不本地改列表）");
  assert.strictEqual(mirrorOf(h, "v1")[0].acknowledged, true);

  // 视图关闭再重绑：通知仍在（队列在宿主内存里，不随视图走）
  h.c.unbindView("v2");
  h.frames.length = 0;
  h.c.bindView("v4");
  await h.c.handle({ type: "ready" }, "v4");
  // v4 还没绑会话：只看到共享通知，所以这里是空
  assert.deepStrictEqual(textsOf(h, "v4"), [], "未绑定会话的新视图只展示共享通知");
  await h.c.openSession("v4", S1);
  assert.strictEqual(h.c.notifications.ackedCount(), 1, "重新打开会话后队列与已确认历史都还在");
  assert.deepStrictEqual(
    mirrorOf(h, "v4").map((notice) => notice.id),
    [fromV2.id],
    "重绑后拿到同一份记录（id 稳定）",
  );
  console.log("  ✓ 多视图单次发生、镜像隔离、确认同步、关窗重绑保留");
}

// ---------- 7. 复制失败：归属校验 + 每窗口请求号水位（畸形帧不污染） ----------
{
  const h = harness();
  await open(h, "v1", S1);
  h.frames.length = 0;

  // 归属不符（说的是 S2、窗口绑的是 S1）：拒绝，且**不许**动水位
  await h.c.handle({ type: "reportImageCopyFailure", sessionId: S2, requestId: 99 }, "v1");
  assert.strictEqual(h.c.notifications.pendingCount(), 0, "跨会话的畸形帧不入队");
  // 畸形帧之后，合法的第一次报告（比它小的号）必须照常生效——水位没被顶高
  await h.c.handle({ type: "reportImageCopyFailure", sessionId: S1, requestId: 1 }, "v1");
  assert.strictEqual(h.c.notifications.pendingCount(), 1, "归属校验先于水位更新（畸形帧不锁死后续）");

  // 重复投递同一号：不累加
  await h.c.handle({ type: "reportImageCopyFailure", sessionId: S1, requestId: 1 }, "v1");
  assert.strictEqual(h.c.notifications.visible(S1)[0].count, 1, "重复投递同一 requestId 不累加");
  // 真实的第二次失败：新的号 → 合并计数（同 kind + 同文案）
  await h.c.handle({ type: "reportImageCopyFailure", sessionId: S1, requestId: 2 }, "v1");
  assert.strictEqual(h.c.notifications.visible(S1)[0].count, 2, "真实第二次失败累加次数");

  // 形状坏的帧（非整数 / 0 / 负数）：一律拒绝
  for (const bad of [0, -1, 1.5, Number.NaN, "3", null]) {
    await h.c.handle({ type: "reportImageCopyFailure", sessionId: S1, requestId: bad }, "v1");
  }
  assert.strictEqual(h.c.notifications.visible(S1)[0].count, 2, "畸形 requestId 不入队");

  // 页面重建：水位清掉，新页面的 1 号照常生效
  await h.c.handle({ type: "ready" }, "v1");
  await h.c.handle({ type: "reportImageCopyFailure", sessionId: S1, requestId: 1 }, "v1");
  assert.strictEqual(h.c.notifications.visible(S1)[0].count, 3, "ready 之后界面计数从头开始，1 号重新生效");
  console.log("  ✓ 复制失败：归属校验先于水位、重复不累加、畸形帧不污染、ready 重置水位");
}

// ---------- 8. 执行目录：只有 live 真实变更才通知 ----------
{
  const h = harness();
  await open(h, "v1", S1);
  const dirA = process.cwd();
  const dirB = `${dirA}-moved`;

  // 控制流 baseline（替换型）：开帧式的重铺 —— 静默
  h.c.onControlFrame({
    type: "baseline",
    value: {
      projections: { [S1]: { asOfSeq: 10, values: { workingDirectory: dirA } } },
    },
  });
  assert.deepStrictEqual(textsOf(h, "v1"), [], "baseline 铺值不出通知（初始投影不是变化）");

  // 同一个 baseline 再来一遍（重连重铺）更不许出通知
  h.c.onControlFrame({
    type: "baseline",
    value: { projections: { [S1]: { asOfSeq: 11, values: { workingDirectory: dirA } } } },
  });
  assert.deepStrictEqual(textsOf(h, "v1"), [], "重铺同值不出通知");

  // baseline 把值改成别的：仍然静默（不是 live）
  h.c.onControlFrame({
    type: "baseline",
    value: { projections: { [S1]: { asOfSeq: 12, values: { workingDirectory: dirB } } } },
  });
  assert.deepStrictEqual(textsOf(h, "v1"), [], "baseline 改值也静默（历史重放 / 重连不算实际变化）");

  // live 增量：真的换了目录 → 绿色通知，只一次
  h.c.onControlFrame({ type: "projection", sessionId: S1, key: "workingDirectory", value: dirA, seq: 20 });
  assert.deepStrictEqual(textsOf(h, "v1"), [`@executionDirChanged:${dirA}`], "live 真实变更出绿色通知");
  assert.strictEqual(mirrorOf(h, "v1")[0].level, "info", "执行目录变化是绿色（info）");
  assert.strictEqual(h.c.notifications.pendingCount(), 1, "只一条");

  // 同一条 live 帧重发（相同水位）：投影存储拒掉，不派发 → 不新增
  h.c.onControlFrame({ type: "projection", sessionId: S1, key: "workingDirectory", value: dirA, seq: 20 });
  assert.strictEqual(h.c.notifications.pendingCount(), 1, "同水位重发不新增");
  assert.strictEqual(h.c.notifications.visible(S1)[0].count, 1, "同水位重发不累加");

  // live 同一个目录但水位更新：值没变 → 不出通知
  h.c.onControlFrame({ type: "projection", sessionId: S1, key: "workingDirectory", value: dirA, seq: 21 });
  assert.strictEqual(h.c.notifications.visible(S1)[0].count, 1, "值没变（水位更新）不新增");

  // live 清空（null）：不是「改到了某个目录」→ 不出通知
  h.c.onControlFrame({ type: "projection", sessionId: S1, key: "workingDirectory", value: null, seq: 22 });
  assert.strictEqual(h.c.notifications.pendingCount(), 1, "null 清空不出通知");

  // 清空之后又一次 live 值（与创建目录不同）＝真实变化 → 出通知
  h.c.onControlFrame({ type: "projection", sessionId: S1, key: "workingDirectory", value: dirB, seq: 23 });
  assert.strictEqual(h.c.notifications.pendingCount(), 2, "清空后再次落到别的目录是真实变化");
  assert.deepStrictEqual(
    h.c.notifications.visible(S1).map((notice) => notice.text),
    [`@executionDirChanged:${dirB}`, `@executionDirChanged:${dirA}`],
    "按最近发生排序",
  );
  console.log("  ✓ 执行目录：baseline/重铺/同值/null 静默，live 真实变更只出一次");
}

// ---------- 9. 命令接线：没有活动窗口 → 唤起主侧栏，只由主侧栏消费 ----------
{
  const h = harness();
  executedCommands.length = 0;
  h.c.openNotifications();
  assert.deepStrictEqual(executedCommands, ["dshChat.view.focus"], "没有任何窗口时唤起主侧栏");
  assert.deepStrictEqual(
    h.frames.filter((captured) => captured.frame.type === "ui/openPanel"),
    [],
    "不许广播开面板（会把抽屉开到所有视图上）",
  );

  // 一个编辑区面板先 ready：它不是主侧栏，不消费这条意图
  h.c.bindView("panel-1");
  h.c.bindViewKind("panel-1", "panel");
  await h.c.handle({ type: "ready" }, "panel-1");
  assert.deepStrictEqual(
    h.frames.filter((captured) => captured.target === "panel-1" && captured.frame.type === "ui/openPanel"),
    [],
    "编辑区面板 ready 不消费主侧栏那条意图",
  );

  // 主侧栏 ready：消费，并只向它开抽屉
  h.c.bindView("primary-1");
  h.c.bindViewKind("primary-1", "primary");
  await h.c.handle({ type: "ready" }, "primary-1");
  const opened = h.frames.filter(
    (captured) => captured.frame.type === "ui/openPanel" && (captured.frame as { panel?: string }).panel === "notifications",
  );
  assert.deepStrictEqual(opened.map((captured) => captured.target), ["primary-1"], "只向主侧栏开抽屉");

  // 有活动窗口时走定向帧
  h.frames.length = 0;
  h.c.openNotifications();
  assert.deepStrictEqual(
    h.frames.filter((captured) => captured.frame.type === "ui/openPanel").map((captured) => captured.target),
    ["primary-1"],
    "有活动窗口时定向发帧（activeViewId 是最近活动的那个）",
  );
  console.log("  ✓ 命令路由：无窗口唤起主侧栏、只由 primary 消费、有窗口定向发帧");
}

// ---------- 9. 命令分流：只有「没进处理器」才入队；执行过的 error 由正文节点承接 ----------
{
  const h = harness();
  await open(h, "v1", S1);
  h.frames.length = 0;

  // 执行过、结果是 error：适配器**已经**折成红色命令节点（正文里有原文）→ 不许再入队
  h.commandReply = { result: { kind: "error", text: "command blew up" } };
  await h.c.handle({ type: "runCommand", line: "/broken" }, "v1");
  assert.strictEqual(h.c.notifications.pendingCount(), 0, "执行过的 error 命令不重复入通知队列");

  // 压根没进处理器（`value === undefined`）：正文里没有节点可看 → 红色入队
  h.commandReply = undefined;
  await h.c.handle({ type: "runCommand", line: "/nope" }, "v1");
  assert.strictEqual(h.c.notifications.pendingCount(), 1, "没进处理器的命令要入队");
  const queued = h.c.notifications.visible(S1)[0];
  assert.strictEqual(queued.text, "@unknownCommand:/nope", "文案沿用既有标记");
  assert.strictEqual(queued.level, "error", "未被会话界面承接的阻断性错误是红色");
  assert.strictEqual(mirrorOf(h, "v1")[0].count, 1);

  // 成功：不入队
  h.commandReply = { result: { kind: "ok" } };
  await h.c.handle({ type: "runCommand", line: "/fine" }, "v1");
  assert.strictEqual(h.c.notifications.pendingCount(), 1, "成功命令不入队");
  console.log("  ✓ 命令分流：unhandled 红入队、执行过的 error 与成功都不入队");
}

// ---------- 10. 无持久化 + 真删除清理 seq 水位 ----------
{
  const h = harness();
  await open(h, "v1", S1);
  await h.c.handle({ type: "reportImageCopyFailure", sessionId: S1, requestId: 1 }, "v1");

  const notificationsKeys = [...h.globalState.dumpKeys(), ...h.workspaceState.dumpKeys()].filter((key) =>
    key.toLowerCase().includes("notification"),
  );
  assert.deepStrictEqual(notificationsKeys, [], "通知队列不落盘（globalState / workspaceState 里没有它）");
  assert.strictEqual(h.globalState.dumpKeys().length, 0, "这条断言本身有效：全局存储此刻是空的");

  // 铺一条 durable `seq` 水位（未知事件那条路走的就是它——复制失败只记每窗口请求号，
  // 不进这张表）。删除是终结性的：真 `deleteSession` → `rememberDeleted` → 清水位。
  // `findSessionDir` 在本测试的离线台里已钉成 undefined，不会扫真实 `~/.dsh/sessions`。
  h.c.notifications.enqueue({
    sessionId: S1,
    level: "warn",
    kind: "unknownEvent",
    text: "@unknownEvent:weird/x",
    seq: 3,
  });
  assert.ok(h.c.notifications.watermarkCount() >= 1, "水位已铺上（回路自身前提）");

  h.c.unbindView("v1");
  const before = h.c.notifications.watermarkCount();
  await h.c.deleteSession(S1);
  assert.strictEqual(before - h.c.notifications.watermarkCount(), 1, "真删除会话时清掉它的 seq 水位");
  console.log("  ✓ 不落盘；真 deleteSession 清理水位");
}

console.log("\nnotificationQueue: all assertions passed");
