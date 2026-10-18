/**
 * 消息通知的**宿主侧行为**回归（驱动真 `ChatController`，不是源码字符串断言）。
 *
 * 覆盖宿主那一半的接线与授权；队列自身的合并 / 水位语义由 host 的队列单测覆盖，
 * 目录投影与命令分流也不在这里。六组：
 *
 * 1. **可见范围**：多个窗口绑同一条会话时一次发生只产生一条记录（次数不按窗口虚增）；
 *    共享通知所有窗口可见，会话通知不跨会话，未绑定窗口只看到共享那一份；
 * 2. **确认授权与同步**：确认只认本窗口可见范围内的未确认记录（越界 id / 畸形 count 都不改队列、
 *    但一定回一份权威镜像）；确认状态同步给所有窗口；迟到的旧 count 只确认用户看到的那一份，
 *    剩余部分换新 id 继续未确认，用旧 id 再确认是空操作；
 * 3. **生命周期**：关闭窗口、重新绑定会话队列都保留；同一份 memento 上新起的控制器为空
 *    （队列不落盘）；
 * 4. **命令入口**：没有活动窗口时唤起主侧栏，且只由**主侧栏**的 `ready` 消费（别的窗口先就绪
 *    不许消费）；窗口存在但未 ready 时按窗口暂存，在首帧快照**之后**补发 `ui/openPanel`；
 * 5. **复制失败上报**：形状与「归属必须等于窗口此刻绑定」都先于水位判定——畸形帧与跨会话的
 *    大号帧都不许把水位顶高（顶高了后续合法上报会被当旧号丢掉）；
 * 6. **durable 水位清理**：真正删除会话清掉它的 `seq` 水位，归档不清。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。夹具与 `unreadMarker.test.ts` / `blankRestoreRace.test.ts` 同形。
 */
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { NotificationView } from "../src/shared/chat";

process.on("unhandledRejection", (error) => {
  console.error("[notificationsController] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");

/** 两条**照不出真实会话**的合成 id：删除路径的目录由本脚本自己 stub 出来的临时目录承担。 */
const A = "session-notif-a";
const B = "session-notif-b";
/** 夹具里的会话工作目录：按宿主平台算**绝对**路径（`node:path` 的 `isAbsolute` 平台相关）。 */
const CWD = join(tmpdir(), "notifications-ws");
const COPY_TEXT = "@imageCopyFailed";

/** 记录 `executeCommand`：命令入口那条无窗口路径靠它证明真的唤起了主侧栏。 */
const commandCalls: string[] = [];
const commands = vscode.commands as unknown as {
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
};
commands.executeCommand = (command: string) => {
  commandCalls.push(command);
  return Promise.resolve(undefined);
};

/** 服务端 `session/list` 的一行（只给本场景用到的字段）。 */
interface Row {
  sessionId: string;
  cwd: string;
  blank: boolean;
  updatedAt: number;
  running: boolean;
}

const row = (sessionId: string): Row => ({
  sessionId,
  cwd: CWD,
  blank: false,
  updatedAt: 1,
  running: false,
});

interface Captured {
  target: "all" | string;
  frame: Record<string, unknown>;
}

/** 静默假客户端：本场景碰到的面（与 `blankRestoreRace.test.ts` 同一套打底 + 归档两条）。 */
function fakeClient(rows: Row[]) {
  const calls: string[] = [];
  return {
    calls,
    rows,
    async createSession(target: { cwd?: string }, reuse?: string) {
      calls.push("session/create");
      if (reuse !== undefined && rows.some((item) => item.sessionId === reuse)) {
        return { sessionId: reuse };
      }
      const sessionId = `session-created-${rows.length + 1}`;
      rows.push({ ...row(sessionId), cwd: target.cwd ?? "" });
      return { sessionId };
    },
    async listSessions() {
      return { items: rows.map((item) => ({ ...item })) };
    },
    async archiveSession(sessionId: string) {
      calls.push(`archive:${sessionId}`);
    },
    async unarchiveSession(sessionId: string) {
      calls.push(`unarchive:${sessionId}`);
    },
    async request(method: string, params?: Record<string, unknown>) {
      calls.push(method);
      if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (rows.some((item) => item.sessionId === agentId)) {
        if (method === "commands/list") return [{ name: "plan", description: "切换计划模式" }];
        if (method === "fileReferences/list") return [];
        if (method === "sessionReferenceResolver/candidates") return [];
        if (method === "skills/list") return { skills: [] };
        return undefined;
      }
      return undefined;
    },
    async sessionProjections() {
      return { values: {} };
    },
    async getJson() {
      return undefined;
    },
    async settingsDescribe() {
      return { namespaces: [] };
    },
    followSession() {
      return { cancel() {} };
    },
    followJobs() {
      return { cancel() {} };
    },
    followControl() {
      return { cancel() {} };
    },
    openStream() {
      return { cancel() {} };
    },
    openEvents() {
      return { cancel() {} };
    },
  };
}

/** `externalUrl` / `activeBaseUrl` 都不给：`openInBrowser` 走「没有可用地址」那一支（共享通知）。 */
const fakeServer = () => ({
  externalUrl: undefined,
  activeBaseUrl: undefined,
  onHeartbeat() {},
  freshToken() {
    return undefined;
  },
  dispose() {},
  snapshot() {
    return { status: { info: undefined }, supervisorAlive: false };
  },
});

const fakeMemento = (seed: Record<string, unknown> = {}) => {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

type Memento = ReturnType<typeof fakeMemento>;

/** 队列实例上本回归用到的观察面（真实例，不另造一份语义）。 */
interface QueueProbe {
  enqueue(input: Record<string, unknown>): unknown;
  watermarkCount(): number;
  pendingCount(): number;
  ackedCount(): number;
}

interface Harness {
  controller: InstanceType<typeof ChatController>;
  frames: Captured[];
  client: ReturnType<typeof fakeClient>;
  queue: QueueProbe;
  state: Memento;
  workspace: Memento;
}

function makeHarness(
  rows: Row[],
  options: { state?: Memento; workspace?: Memento } = {},
): Harness {
  const state = options.state ?? fakeMemento();
  const workspace = options.workspace ?? fakeMemento();
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    state as never,
    workspace as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const client = fakeClient(rows);
  const internals = controller as unknown as { client: unknown; connection: string };
  internals.client = client as never;
  internals.connection = "connected";
  const frames: Captured[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame: frame as unknown as Record<string, unknown> }));
  return {
    controller,
    frames,
    client,
    queue: (controller as unknown as { notifications: QueueProbe }).notifications,
    state,
    workspace,
  };
}

/** 一帧里携带的通知镜像（`state` 快照或 `patch` 的顶层字段）。 */
function mirrorOf(frame: Record<string, unknown>): NotificationView[] | undefined {
  const holder = frame.type === "state" ? frame.state : frame.type === "patch" ? frame.patch : undefined;
  if (!holder || typeof holder !== "object") return undefined;
  const value = (holder as { notifications?: unknown }).notifications;
  return Array.isArray(value) ? (value as NotificationView[]) : undefined;
}

/**
 * 某个窗口此刻的权威镜像：取它（或广播）**最后一帧**带通知的帧。
 *
 * 与 `unreadMarker.test.ts` 的 `rowOf` 同一口径：只看那一片、不往旧帧回溯——
 * 回溯会把上一状态的列表当成当前界面。
 */
function mirror(frames: Captured[], target: string): NotificationView[] {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target: to, frame } = frames[index];
    if (to !== "all" && to !== target) continue;
    const value = mirrorOf(frame);
    if (value !== undefined) return value;
  }
  return [];
}

/** 这个窗口收到的、属于指定类型的帧（广播也算）。 */
function framesOf(frames: Captured[], target: string, type: string): Captured[] {
  return frames.filter(
    (item) => (item.target === "all" || item.target === target) && item.frame.type === type,
  );
}

/** 这个窗口镜像里的复制失败记录（断言只有一条，避免多条时静默取第一条）。 */
function copyNotice(frames: Captured[], target: string): NotificationView {
  const hits = mirror(frames, target).filter((item) => item.text === COPY_TEXT);
  assert.strictEqual(hits.length, 1, `${target} 的镜像里应恰有一条复制失败通知（实际 ${hits.length} 条）`);
  return hits[0];
}

const reportCopy = (viewId: string, sessionId: string | undefined, requestId: number) =>
  sessionId === undefined
    ? { type: "reportImageCopyFailure", requestId }
    : { type: "reportImageCopyFailure", sessionId, requestId };

console.log("notificationsController: 通知的宿主侧接线与授权（真控制器，offline stub）");

// ---------- 一、多窗口同一会话：一次发生一条记录，次数不按窗口虚增 ----------
{
  const harness = makeHarness([row(A)]);
  const { controller, frames, queue } = harness;
  controller.bindView("v1");
  controller.bindView("v2");
  await controller.openSession("v1", A);
  await controller.openSession("v2", A);

  await controller.handle(reportCopy("v1", A, 1) as never, "v1");

  assert.strictEqual(queue.pendingCount(), 1, "一次发生只许入队一条（入队若写在按窗口投递的循环里会虚增）");
  for (const viewId of ["v1", "v2"]) {
    const notice = copyNotice(frames, viewId);
    assert.strictEqual(notice.count, 1, `${viewId} 看到的次数必须是 1`);
    assert.strictEqual(notice.sessionId, A, "会话通知带发起会话的归属");
    assert.strictEqual(notice.acknowledged, false, "新通知是未确认的");
  }
  console.log("  多窗口同一会话：一条记录、次数 1、两个窗口都可见 ✓");
}

// ---------- 二、共享通知与会话隔离（未绑定窗口只看到共享那一份） ----------
{
  const harness = makeHarness([row(A), row(B)]);
  const { controller, frames } = harness;
  controller.bindView("onA");
  controller.bindView("onB");
  controller.bindView("loose");
  await controller.openSession("onA", A);
  await controller.openSession("onB", B);

  // A 上的一次会话通知
  await controller.handle(reportCopy("onA", A, 1) as never, "onA");
  // 共享通知（窗口级动作，没有可用地址）：未绑定的 window 也能看到
  await controller.handle({ type: "openInBrowser" } as never, "loose");

  const onA = mirror(frames, "onA");
  assert.strictEqual(onA.filter((item) => item.text === COPY_TEXT).length, 1, "A 的窗口看得到自己会话的通知");
  const sharedOnA = onA.find((item) => item.text === "@openInBrowserOffline");
  assert.ok(sharedOnA, "A 的窗口也看得到共享通知");
  assert.strictEqual("sessionId" in sharedOnA, false, "共享通知不带会话归属");

  for (const viewId of ["onB", "loose"]) {
    const list = mirror(frames, viewId);
    assert.strictEqual(
      list.filter((item) => item.text === COPY_TEXT).length,
      0,
      `${viewId} 不许看到别的会话的通知`,
    );
    assert.strictEqual(
      list.filter((item) => item.text === "@openInBrowserOffline").length,
      1,
      `${viewId} 必须看到共享通知`,
    );
  }
  console.log("  共享可见、会话隔离、未绑定只看共享 ✓");
}

// ---------- 三、确认授权、跨窗口同步、迟到 count 保留后发生 ----------
{
  const harness = makeHarness([row(A), row(B)]);
  const { controller, frames, queue } = harness;
  controller.bindView("onA");
  controller.bindView("onB");
  controller.bindView("onA2");
  await controller.openSession("onA", A);
  await controller.openSession("onB", B);
  await controller.openSession("onA2", A);

  await controller.handle(reportCopy("onA", A, 1) as never, "onA");
  const first = copyNotice(frames, "onA");

  // 越界的 id（B 的窗口去确认 A 的通知）与畸形 count 都是空操作，但必须回权威镜像
  for (const bad of [
    { id: first.id, count: 1 },
    { id: 42, count: 1 },
    { id: first.id, count: 0 },
    { id: first.id, count: 1.5 },
    { id: first.id },
  ]) {
    const before = frames.length;
    await controller.handle({ type: "acknowledgeNotification", ...bad } as never, "onB");
    assert.ok(frames.length > before, "空操作也要回一帧权威镜像（否则界面卡在点不掉的提示上）");
    const mirrors = framesOf(frames.slice(before), "onB", "patch");
    assert.strictEqual(mirrors.length, 1, "空操作只回一帧");
  }
  assert.strictEqual(queue.pendingCount(), 1, "越界 / 畸形确认都不许改变队列");
  assert.strictEqual(queue.ackedCount(), 0, "越界确认不许写进已确认历史");
  assert.strictEqual(copyNotice(frames, "onA").acknowledged, false, "A 的通知仍然未确认");

  // 合法确认：另一个看着同一会话的窗口必须收到「已确认」
  await controller.handle({ type: "acknowledgeNotification", id: first.id, count: 1 } as never, "onA");
  assert.strictEqual(queue.pendingCount(), 0, "确认后从未确认里移出");
  assert.strictEqual(queue.ackedCount(), 1, "确认后进入已确认历史");
  assert.strictEqual(copyNotice(frames, "onA2").acknowledged, true, "确认状态同步到同一会话的另一个窗口");
  assert.strictEqual(
    mirror(frames, "onB").filter((item) => item.text === COPY_TEXT).length,
    0,
    "确认的同步帧不许把会话通知泄漏给别的会话",
  );

  // 迟到 count：又合并进来一次发生（count=2），界面只确认了看到的 1 次
  const second = makeHarness([row(A)]);
  second.controller.bindView("w1");
  await second.controller.openSession("w1", A);
  await second.controller.handle(reportCopy("w1", A, 1) as never, "w1");
  const record = copyNotice(second.frames, "w1");
  await second.controller.handle(reportCopy("w1", A, 2) as never, "w1");
  assert.strictEqual(copyNotice(second.frames, "w1").count, 2, "前置：两次发生合并成 count=2");
  await second.controller.handle(
    { type: "acknowledgeNotification", id: record.id, count: 1 } as never,
    "w1",
  );
  assert.strictEqual(second.queue.pendingCount(), 1, "剩余的发生继续未确认");
  assert.strictEqual(second.queue.ackedCount(), 1, "看到的那一份进历史");
  const visible = mirror(second.frames, "w1").filter((item) => item.text === COPY_TEXT);
  assert.strictEqual(visible.length, 2, "历史一条 + 未确认一条");
  const acked = visible.find((item) => item.acknowledged);
  const live = visible.find((item) => !item.acknowledged);
  assert.ok(acked && live, "两份都要在镜像里");
  assert.strictEqual(acked.count, 1, "历史那条只有用户看到的 1 次");
  assert.strictEqual(live.count, 1, "剩余 1 次继续提醒");
  assert.notStrictEqual(live.id, acked.id, "剩余部分换新 id（旧 id 只留在历史里）");
  assert.strictEqual(live.sessionId, A, "剩余部分保留归属");
  await second.controller.handle(
    { type: "acknowledgeNotification", id: record.id, count: 1 } as never,
    "w1",
  );
  assert.strictEqual(second.queue.pendingCount(), 1, "用旧 id 再确认是空操作，不许吞掉剩余的发生");
  console.log("  确认授权 / 跨窗口同步 / 迟到 count 保留后发生 ✓");
}

// ---------- 四、关闭重绑保留；同一份 memento 上新控制器为空 ----------
{
  const state = fakeMemento();
  const workspace = fakeMemento();
  const first = makeHarness([row(A)], { state, workspace });
  first.controller.bindView("v1");
  await first.controller.openSession("v1", A);
  await first.controller.handle(reportCopy("v1", A, 1) as never, "v1");
  assert.strictEqual(first.queue.pendingCount(), 1, "前置：队列里有一条");

  first.controller.unbindView("v1");
  assert.strictEqual(first.queue.pendingCount(), 1, "关闭窗口不丢队列（内存里没人动它）");

  first.controller.bindView("v2");
  await first.controller.openSession("v2", A);
  await first.controller.handle({ type: "ready" } as never, "v2");
  assert.strictEqual(
    copyNotice(first.frames, "v2").count,
    1,
    "重新绑定会话后仍看得到那条通知（镜像随快照回来）",
  );

  const second = makeHarness([row(A)], { state, workspace });
  second.controller.bindView("n1");
  await second.controller.openSession("n1", A);
  await second.controller.handle({ type: "ready" } as never, "n1");
  assert.strictEqual(second.queue.pendingCount(), 0, "新控制器（新扩展宿主）队列为空");
  assert.deepStrictEqual(mirror(second.frames, "n1"), [], "首帧快照里的通知为空表");
  const persisted = [...state.keys(), ...workspace.keys()].filter((key) => /notif/i.test(key));
  assert.deepStrictEqual(persisted, [], "持久化单元里不许出现通知键（队列不落盘）");
  console.log("  关闭重绑保留、新控制器为空、持久化无通知 ✓");
}

// ---------- 五、命令入口：无窗口唤起主侧栏，只由主侧栏 ready 消费；未 ready 按窗口暂存 ----------
{
  const harness = makeHarness([row(A)]);
  const { controller, frames } = harness;

  // (1) 一个窗口都没有：唤起主侧栏 + 记成待开
  const before = commandCalls.length;
  controller.openNotifications();
  assert.deepStrictEqual(
    commandCalls.slice(before),
    ["dshChat.view.focus"],
    "没有活动窗口时必须显式唤起主侧栏（只发帧的话没人挂着收）",
  );
  assert.strictEqual(framesOf(frames, "any", "ui/openPanel").length, 0, "此刻还没有窗口可发");

  // 编辑区面板先就绪：不许消费那条意图（用户按的是主侧栏那个入口）
  controller.bindView("panel-view");
  controller.bindViewKind("panel-view", "panel");
  await controller.handle({ type: "ready" } as never, "panel-view");
  assert.strictEqual(
    frames.filter((item) => item.frame.type === "ui/openPanel").length,
    0,
    "非主侧栏的 ready 不许消费那条待开意图",
  );

  // 主侧栏就绪：首帧快照之后补发 ui/openPanel
  controller.bindView("primary-view");
  controller.bindViewKind("primary-view", "primary");
  await controller.handle({ type: "ready" } as never, "primary-view");
  const stateAt = frames.findIndex(
    (item) => item.target === "primary-view" && item.frame.type === "state",
  );
  const openAt = frames.findIndex(
    (item) => item.target === "primary-view" && item.frame.type === "ui/openPanel",
  );
  assert.ok(stateAt >= 0, "主侧栏必须收到首帧快照");
  assert.ok(openAt > stateAt, "开抽屉必须排在首帧快照之后（否则界面还没有状态）");
  assert.strictEqual(
    (frames[openAt].frame as { panel?: unknown }).panel,
    "notifications",
    "补发的正是通知抽屉",
  );

  // (2) 窗口存在但未 ready：按窗口暂存，ready 时补发；这一档不该再唤起容器
  const late = makeHarness([row(A)]);
  late.controller.bindView("late-primary");
  late.controller.bindViewKind("late-primary", "primary");
  const callsBefore = commandCalls.length;
  late.controller.openNotifications();
  assert.strictEqual(
    commandCalls.length,
    callsBefore,
    "已有活动窗口时走定向帧，不再唤起主侧栏",
  );
  assert.strictEqual(
    framesOf(late.frames, "late-primary", "ui/openPanel").length,
    0,
    "页面还没 ready：先记成待开，不直接发帧",
  );
  await late.controller.handle({ type: "ready" } as never, "late-primary");
  const lateState = late.frames.findIndex(
    (item) => item.target === "late-primary" && item.frame.type === "state",
  );
  const lateOpen = late.frames.findIndex(
    (item) => item.target === "late-primary" && item.frame.type === "ui/openPanel",
  );
  assert.strictEqual(framesOf(late.frames, "late-primary", "ui/openPanel").length, 1, "ready 时补发一帧");
  assert.ok(lateOpen > lateState, "补发也排在首帧快照之后");
  console.log("  命令入口：无窗口唤起主侧栏、只 primary 消费、未 ready 暂存后补发 ✓");
}

// ---------- 六、复制失败上报：形状与归属都先于水位 ----------
{
  const harness = makeHarness([row(A), row(B)]);
  const { controller, frames, queue } = harness;
  controller.bindView("onA");
  controller.bindView("onB");
  controller.bindView("loose");
  await controller.openSession("onA", A);
  await controller.openSession("onB", B);

  // 畸形帧：都不许入队，也不许把水位顶高
  for (const bad of [
    { sessionId: A },
    { sessionId: A, requestId: "1" },
    { sessionId: A, requestId: 0 },
    { sessionId: A, requestId: 1.5 },
    { sessionId: null, requestId: 1 },
  ]) {
    await controller.handle({ type: "reportImageCopyFailure", ...bad } as never, "onA");
  }
  assert.strictEqual(queue.pendingCount(), 0, "畸形帧不许入队");

  // 跨会话的大号帧：先验归属 → 丢弃，且**不许**把水位顶到 5000（顶了后续合法上报全被当旧号）
  await controller.handle(reportCopy("onA", B, 5000) as never, "onA");
  assert.strictEqual(queue.pendingCount(), 0, "跨会话的归属不许入队");
  await controller.handle(reportCopy("onA", A, 1) as never, "onA");
  assert.strictEqual(copyNotice(frames, "onA").count, 1, "水位没被畸形帧顶高：合法的小号仍被受理");

  // 归属必须等于窗口此刻的绑定；同号重复投递是空操作
  await controller.handle(reportCopy("onA", B, 2) as never, "onA");
  assert.strictEqual(copyNotice(frames, "onA").count, 1, "归属与当前绑定不一致 → 丢弃");
  await controller.handle(reportCopy("onA", A, 2) as never, "onA");
  assert.strictEqual(copyNotice(frames, "onA").count, 2, "真实的下一次发生累加次数");
  await controller.handle(reportCopy("onA", A, 2) as never, "onA");
  assert.strictEqual(copyNotice(frames, "onA").count, 2, "同一号重复投递不重复计数");

  // 未绑定窗口：不带 sessionId，入的是共享通知
  await controller.handle(reportCopy("loose", undefined, 1) as never, "loose");
  const shared = mirror(frames, "loose").filter((item) => item.text === COPY_TEXT);
  assert.strictEqual(shared.length, 1, "未绑定窗口只看到那条共享的复制失败通知");
  assert.strictEqual("sessionId" in shared[0], false, "空态窗口的失败报告入的是共享通知");
  assert.strictEqual(
    mirror(frames, "onB").filter((item) => item.text === COPY_TEXT).length,
    1,
    "B 的窗口只看到那条共享的，不许看到 A 的会话通知",
  );
  console.log("  复制失败上报：形状 → 归属 → 水位（水位不被畸形帧污染）✓");
}

// ---------- 七、真正删除会话清水位并真的删掉日志目录；归档既不清水位也不删目录 ----------
//
// 删除是全链路里唯一**真删盘**的一步：不给它指向真实 `~/.dsh/sessions` 的机会——本场景把
// 私有 `findSessionDir` 只对这个 harness 实例 stub 成一个自建临时目录，删除逻辑
// （`deleteSession → rmSync → rememberDeleted → forgetSession`）仍然整条走生产代码。
{
  const root = mkdtempSync(join(tmpdir(), "dsh-notifications-"));
  const sessionDir = join(root, B);
  try {
    mkdirSync(sessionDir, { recursive: true });
    assert.ok(existsSync(sessionDir), "前置：测试会话目录已建出来");

    const harness = makeHarness([row(A), row(B)]);
    const { controller, queue, client } = harness;
    controller.bindView("onA");
    await controller.openSession("onA", A);
    await controller.refreshSessions();
    const internals = controller as unknown as {
      findSessionDir(sessionId: string): string | undefined;
    };
    internals.findSessionDir = (sessionId: string) => (sessionId === B ? sessionDir : undefined);

    // 只有 durable 未知事件会带 `seq`；直接走队列的同一入口铺一条水位，避免为一条水位搭整条适配器链
    queue.enqueue({
      sessionId: B,
      level: "warn",
      kind: "unknownEvent",
      key: "future/event",
      text: "@unknownEvent:future/event",
      seq: 7,
    });
    assert.strictEqual(queue.watermarkCount(), 1, "前置：B 的 seq 水位已铺上");

    await controller.handle({ type: "archiveSession", sessionId: B } as never, "onA");
    assert.ok(client.calls.includes(`archive:${B}`), "前置：归档请求真的发出去了");
    assert.strictEqual(queue.watermarkCount(), 1, "归档不算删除：水位必须留着（那条会话还能恢复）");
    assert.ok(existsSync(sessionDir), "归档不许删会话日志目录");

    await controller.handle({ type: "deleteSession", sessionId: B } as never, "onA");
    assert.strictEqual(existsSync(sessionDir), false, "真正删除要把会话日志目录从盘上删掉");
    assert.strictEqual(queue.watermarkCount(), 0, "真正删除是终结性的：水位必须收掉（否则就是泄漏）");
    console.log("  真正删除清水位并删掉日志目录、归档既不清也不删 ✓");
  } finally {
    // 自建临时根一律回收（删除成功后它已经空了，失败时也把残留带走）
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\nnotificationsController: all assertions passed");
