/**
 * 「生成完毕未读」的**行为级**回归（驱动真 `ChatController`，不是读源码正则）。
 *
 * 用户 2026-09-24 定的口径：**只有**「我离开时它正在生成」这一件事能点亮历史列表里那条
 * 蓝标题——离开时记一个离开标记（`controller.leftGeneratingSessionIds`），这条会话收尾
 * 时把标记投影成未读；标记一直留到用户回来看它（`bindViewToSession` 里作废），所以离开
 * 之后它连跑几轮、每轮收尾都还会亮。其它任何情形都不许点亮，尤其是旧口径下必然误亮的两条：
 *
 * - 会话在**别处**跑起来（另一个窗口 / dsh web / CLI），本窗口从没打开过它；
 * - 本窗口开着它，但它是**空闲**的，离开之后才跑起来。
 *
 * 三条「离开」入口（切到别的会话 / 新建对话 / 关闭视图）都要覆盖，两条收尾入口
 * （`api-session/status` 中继与会话列表差分）也都要覆盖——它们是同一个结算函数的两条路。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[unreadMarker] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");

const A = "session-aaaa";
const B = "session-bbbb";
const CWD = "D:/tmp/unread-marker-ws";

/** 服务端 `session/list` 的一行（只给本场景用到的字段）。 */
interface Row {
  sessionId: string;
  cwd: string;
  updatedAt: number;
  running: boolean;
}

const row = (sessionId: string, running = false): Row => ({
  sessionId,
  cwd: CWD,
  updatedAt: 1,
  running,
});

interface Captured {
  target: "all" | string;
  frame: Record<string, unknown>;
}

type SessionRowView = { id: string; running: boolean; unread?: boolean };

/** 静默假客户端：只实现本场景碰到的面（与 `subagentSwitch.test.ts` 同一套打底）。 */
const fakeClient = (rows: Row[]) => ({
  async listSessions() {
    return { items: rows.map((item) => ({ ...item })) };
  },
  async request(method: string) {
    if (method === "commands/list") return [];
    if (method === "subagents/list") throw new Error("subagents/list 失败：HTTP 404");
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
  /** 发消息那条路（场景 ⑩：发送即乐观置位，此刻服务端的 status 还没到）。 */
  async prompt() {
    return { requestId: "r" };
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
});

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
  };
};

interface Driver {
  openSession(viewId: string, sessionId: string): Promise<void>;
  unbindView(viewId: string): void;
  newSession(viewId: string): Promise<void>;
  refreshSessions(): Promise<void>;
  /** 用户发了一条消息（`controller.send`：域上**乐观**置为生成中）。 */
  send(viewId: string, text: string): Promise<void>;
  /** `$events` 流上的 `api-session/status`（`args = [sessionId, running]`）真帧。 */
  status(sessionId: string, running: boolean): Promise<void>;
}

function makeDriver(rows: Row[]) {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame }));
  const internals = controller as never as {
    client: unknown;
    connection: string;
    applySessionStatus: unknown;
    onEventFrame(frame: Record<string, unknown>): Promise<void>;
  };
  internals.client = fakeClient(rows) as never;
  internals.connection = "connected";
  const c = controller as unknown as {
    openSession(viewId: string, sessionId: string): Promise<void>;
    unbindView(viewId: string): void;
    newSession(viewId: string): Promise<void>;
    refreshSessions(): Promise<void>;
    send(viewId: string, text: string, attachments: never[]): Promise<void>;
  };
  const driver: Driver = {
    openSession: (viewId, sessionId) => c.openSession(viewId, sessionId),
    unbindView: (viewId) => c.unbindView(viewId),
    newSession: (viewId) => c.newSession(viewId),
    refreshSessions: () => c.refreshSessions(),
    send: (viewId, text) => c.send(viewId, text, []),
    status: (sessionId, running) =>
      internals.onEventFrame({ type: "emit", event: "api-session/status", args: [sessionId, running] }),
  };
  return { driver, frames };
}

/**
 * 界面口径的未读：最近一帧会话列表（`target === "all"`）里那一行的 `unread`。
 *
 * 断言走帧而不是直接读 `unreadSessionIds`：界面看到的才是这条功能的事实，集合只是内部账。
 */
function unreadInList(frames: Captured[], sessionId: string): boolean | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== "all" || frame.type !== "sessions") continue;
    const rows = (frame.sessions ?? []) as SessionRowView[];
    const hit = rows.find((item) => item.id === sessionId);
    if (hit) return hit.unread === true;
  }
  return undefined;
}

console.log("unreadMarker: 驱动真控制器（offline stub）");

// ---------- ① 离开正在生成的会话 → 收尾 → 未读 ----------
{
  const { driver, frames } = makeDriver([row(A), row(B)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.status(A, true); // 开始生成
  await driver.openSession("v1", B); // 切到别的会话＝离开 A
  await driver.status(A, false); // A 收尾
  assert.strictEqual(unreadInList(frames, A), true, "离开时它正在生成，收尾后必须记未读");
  assert.strictEqual(unreadInList(frames, B), false, "没碰过的会话不该有未读");
  console.log("  ① 切走后收尾：A 未读 ✓");
}

// ---------- ② 从没打开过的会话跑完 → 不未读（旧口径会误亮） ----------
{
  const { driver, frames } = makeDriver([row(A)]);
  await driver.refreshSessions();
  await driver.status(A, true);
  await driver.status(A, false);
  assert.strictEqual(unreadInList(frames, A), false, "本窗口从没打开过它，跑完也不该亮蓝");
  console.log("  ② 别处跑起来的会话：不未读 ✓");
}

// ---------- ③ 开着它看它收尾 → 不未读 ----------
{
  const { driver, frames } = makeDriver([row(A)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.status(A, true);
  await driver.status(A, false);
  assert.strictEqual(unreadInList(frames, A), false, "人在看着它结束，不算未读");
  console.log("  ③ 看着它收尾：不未读 ✓");
}

// ---------- ④ 离开时它空闲，之后才跑起来 → 不未读 ----------
{
  const { driver, frames } = makeDriver([row(A), row(B)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.openSession("v1", B); // 离开时 A 空闲 → 不留标记
  await driver.status(A, true);
  await driver.status(A, false);
  assert.strictEqual(unreadInList(frames, A), false, "离开时它没在生成，之后跑完也不该算我的未读");
  console.log("  ④ 空闲时离开、之后才跑：不未读 ✓");
}

// ---------- ⑤ 离开后又回来看着它收尾 → 不未读（标记作废） ----------
{
  const { driver, frames } = makeDriver([row(A), row(B)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.status(A, true);
  await driver.openSession("v1", B); // 离开（此刻它在生成）
  await driver.openSession("v1", A); // 回来看它
  await driver.status(A, false);
  assert.strictEqual(unreadInList(frames, A), false, "回来看过它结束，离开标记必须作废");
  console.log("  ⑤ 离开又回来：不未读 ✓");
}

// ---------- ⑥ 另一个视图还开着它 → 不算离开 ----------
{
  const { driver, frames } = makeDriver([row(A), row(B)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.openSession("v2", A);
  await driver.status(A, true);
  await driver.openSession("v1", B); // v2 还在看 A
  await driver.status(A, false);
  assert.strictEqual(unreadInList(frames, A), false, "还有窗口开着它，不算离开");
  console.log("  ⑥ 另一视图仍开着：不未读 ✓");
}

// ---------- ⑦ 关掉视图也算离开；新建对话也算 ----------
{
  const closed = makeDriver([row(A)]);
  await closed.driver.refreshSessions();
  await closed.driver.openSession("v1", A);
  await closed.driver.status(A, true);
  closed.driver.unbindView("v1");
  await closed.driver.status(A, false);
  assert.strictEqual(unreadInList(closed.frames, A), true, "关掉视图＝离开，收尾要记未读");

  const fresh = makeDriver([row(A)]);
  await fresh.driver.refreshSessions();
  await fresh.driver.openSession("v1", A);
  await fresh.driver.status(A, true);
  await fresh.driver.newSession("v1"); // 点「新建对话」
  await fresh.driver.status(A, false);
  assert.strictEqual(unreadInList(fresh.frames, A), true, "新建对话＝离开，收尾要记未读");
  console.log("  ⑦ 关闭视图 / 新建对话：都算离开 ✓");
}

// ---------- ⑧ 列表差分那条收尾入口同样兑现标记 ----------
{
  const rows = [row(A), row(B)];
  const { driver, frames } = makeDriver(rows);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.status(A, true);
  await driver.openSession("v1", B); // 离开
  rows[0].running = false; // 服务端算的权威值落下来（不再走 status 中继）
  await driver.refreshSessions();
  assert.strictEqual(unreadInList(frames, A), true, "列表差分那条路也要兑现离开标记");
  console.log("  ⑧ 列表差分收尾：A 未读 ✓");
}

// ---------- ⑨ 未读跟着「我有没有回来看过」走，不跟着单轮走 ----------
{
  const { driver, frames } = makeDriver([row(A), row(B)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.status(A, true);
  await driver.openSession("v1", B); // 离开（此刻它在生成）
  await driver.status(A, false);
  assert.strictEqual(unreadInList(frames, A), true, "前置：离开后收尾，得到一条未读");
  await driver.status(A, true); // 离开期间又跑了一轮（比如队列里的下一条自动接续）
  assert.strictEqual(unreadInList(frames, A), false, "运行中的蓝由 running 负责，未读先让位");
  await driver.status(A, false);
  assert.strictEqual(
    unreadInList(frames, A),
    true,
    "用户一直没回来，离开标记还活着：这一轮收尾照样亮",
  );
  await driver.openSession("v1", A); // 回来看它
  assert.strictEqual(unreadInList(frames, A), false, "看过了：未读与标记一起结束");
  await driver.openSession("v1", B); // 再看它已经空闲 → 不留标记
  await driver.status(A, true);
  await driver.status(A, false);
  assert.strictEqual(unreadInList(frames, A), false, "标记已作废：这条生成不是我离开的那次，不亮");
  console.log("  ⑨ 未读活到「回来看过」为止 ✓");
}

// ---------- ⑩ 发完消息立刻切走：域上的乐观值就要能立起标记 ----------
{
  const rows = [row(A), row(B)];
  const { driver, frames } = makeDriver(rows);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.send("v1", "跑一个长任务"); // 域上乐观置为生成中；服务端的 status 还没到
  assert.strictEqual(rows[0].running, false, "前置：此刻列表那一行还没被服务端点亮（判据只能看域）");
  await driver.openSession("v1", B); // 立刻切走
  await driver.status(A, true); // 服务端的权威值这才到
  await driver.status(A, false);
  assert.strictEqual(
    unreadInList(frames, A),
    true,
    "「发完立刻切走」必须记上离开标记：只读列表那一行会漏掉这一场景",
  );
  console.log("  ⑩ 发送后立刻切走：A 未读 ✓");
}

console.log("unreadMarker: 只有「离开生成中的会话」会点亮未读 ✓");