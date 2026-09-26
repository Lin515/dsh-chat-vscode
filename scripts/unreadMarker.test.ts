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

const fakeMemento = (seed: Record<string, unknown> = {}) => {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    // 删键 = 写 `undefined`（与 VS Code 的 Memento 同口径，见 `dsh/unreadStore.ts`）：
    // 键必须真的从 `keys()` 里消失，否则「清掉」会被读侧的键扫描当成还在
    update: async (key: string, value: unknown) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

/**
 * 共享的 globalState（多窗口的现场）：各窗口**构造时读一份副本**，写回共享单元、此后不再
 * 同步——VS Code 不跨窗口实时同步 `globalState`，所以「整份数组互相覆写」才会把别人清掉的
 * 旗标写回来。按会话分键之后就没有这条通道了（见 `dsh/unreadStore.ts`）。
 */
function sharedGlobalState() {
  const shared = new Map<string, unknown>();
  return {
    shared,
    memento: () => {
      const view = new Map(shared);
      return {
        get: (key: string, fallback?: unknown) => (view.has(key) ? view.get(key) : fallback),
        update: async (key: string, value: unknown) => {
          if (value === undefined) {
            view.delete(key);
            shared.delete(key);
          } else {
            view.set(key, value);
            shared.set(key, value);
          }
        },
        keys: () => [...view.keys()],
      };
    },
  };
}

interface Driver {
  openSession(viewId: string, sessionId: string): Promise<void>;
  unbindView(viewId: string): void;
  newSession(viewId: string): Promise<void>;
  refreshSessions(): Promise<void>;
  /** 用户发了一条消息（`controller.send`：域上**乐观**置为生成中）。 */
  send(viewId: string, text: string): Promise<void>;
  /** `$events` 流上的 `api-session/status`（`args = [sessionId, running]`）真帧。 */
  status(sessionId: string, running: boolean): Promise<void>;
  /** durable 轮次边界（`session/follow` 上的事件），走真适配器。 */
  turn(sessionId: string, type: "turn/start" | "turn/end", turnNo: number): void;
  /** 会话列表那一行此刻的 `running`（界面口径）。 */
  rowRunning(sessionId: string): boolean;
  /** 这个窗口那份 globalState 的键（存储口径断言用）。 */
  stateKeys(): string[];
}

function makeDriver(rows: Row[], options: { state?: () => ReturnType<typeof fakeMemento> } = {}) {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    (options.state ?? fakeMemento)() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame }));
  const internals = controller as never as {
    client: unknown;
    connection: string;
    state: { keys(): string[] };
    scopes: Map<string, { adapter?: { applyEvent(event: unknown): void } }>;
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
  let turnSeq = 100;
  const driver: Driver = {
    openSession: (viewId, sessionId) => c.openSession(viewId, sessionId),
    unbindView: (viewId) => c.unbindView(viewId),
    newSession: (viewId) => c.newSession(viewId),
    refreshSessions: () => c.refreshSessions(),
    send: (viewId, text) => c.send(viewId, text, []),
    status: (sessionId, running) =>
      internals.onEventFrame({ type: "emit", event: "api-session/status", args: [sessionId, running] }),
    turn: (sessionId, type, turnNo) => {
      turnSeq += 1;
      internals.scopes.get(sessionId)?.adapter?.applyEvent({
        type,
        seq: turnSeq,
        time: turnSeq * 1000,
        data: type === "turn/end" ? { turn: turnNo, reason: { kind: "completed" } } : { turn: turnNo },
      });
    },
    rowRunning: (sessionId) => rowOf(frames, sessionId)?.running === true,
    stateKeys: () => internals.state.keys(),
  };
  return { driver, frames };
}

/**
 * 界面口径的未读：最近一帧会话列表（`target === "all"`）里那一行的 `unread`。
 *
 * 断言走帧而不是直接读 `unreadSessionIds`：界面看到的才是这条功能的事实，集合只是内部账。
 */
function unreadInList(frames: Captured[], sessionId: string): boolean | undefined {
  const row = rowOf(frames, sessionId);
  return row ? row.unread === true : undefined;
}

/** 最近一帧会话列表里那一行（找不到说明这一代列表里没有它）。 */
function rowOf(frames: Captured[], sessionId: string): SessionRowView | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== "all" || frame.type !== "sessions") continue;
    const rows = (frame.sessions ?? []) as SessionRowView[];
    const hit = rows.find((item) => item.id === sessionId);
    if (hit) return hit;
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

// ---------- ⑪ 收尾的 durable 真相必须落到会话列表那一行 ----------
// 真机现场：收尾的权威状态位（`api-session/status`）先到、durable `turn/end` 随后到（两条流
// 之间隔上百毫秒到上百秒都出现过）。前者那一刻被拒收（本地还有开放轮次，这条规则本身没错），
// 后者若只改域不改**行**，列表就一直显示「生成中」——离开时被误判成生成中，下一次列表刷新
// 翻回 false 时亮出假未读。
{
  const { driver, frames } = makeDriver([row(A), row(B)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.status(A, true); // 权威中继：开始生成
  driver.turn(A, "turn/start", 1); // durable：本轮开始
  await driver.status(A, false); // 收尾的权威值先到——此刻本地有开放轮次，被拒收
  assert.strictEqual(driver.rowRunning(A), true, "被拒收的那一刻那一行仍是运行中（拒收本身没错）");
  driver.turn(A, "turn/end", 1); // durable：本轮真的收尾了
  assert.strictEqual(driver.rowRunning(A), false, "durable 收尾必须同时把那一行改回空闲");
  await driver.openSession("v1", B); // 用户此刻离开（界面看它是空闲的）
  await driver.refreshSessions(); // 打开历史抽屉 → 列表整份刷新
  assert.strictEqual(unreadInList(frames, A), false, "离开时它已经收尾：不许记未读");
  console.log("  ⑪ 收尾后 durable 真相落到列表那一行：离开不误判 ✓");
}

// ---------- ⑫ 被拒收的权威状态位要复查，不能丢 ----------
// 拒收那一刻的「本轮还开着」可能永远不再变化（跟随流断了、durable 收尾没到）。那条权威值
// 留在账上，等本地证据消失（域被回收）时按它纠正那一行——否则它就是一条谁也不管的假 true。
{
  const { driver, frames } = makeDriver([row(A), row(B)]);
  await driver.refreshSessions();
  await driver.openSession("v1", A);
  await driver.status(A, true);
  driver.turn(A, "turn/start", 1);
  await driver.status(A, false); // 被拒收 → 记账
  assert.strictEqual(driver.rowRunning(A), true, "前置：那一行还停在运行中");
  await driver.newSession("v1"); // 离开 → 域被回收，本地「本轮还开着」的证据随之消失
  assert.strictEqual(driver.rowRunning(A), false, "域没了以后要按那条权威值纠正那一行");
  await driver.refreshSessions();
  assert.strictEqual(unreadInList(frames, A), false, "纠正陈旧的「运行中」不该顺带记出未读");
  console.log("  ⑫ 被拒收的权威状态位在域回收时复查 ✓");
}

// ---------- ⑬ 存储口径：旧集合作废、按会话分键、多窗口不互相复活 ----------
{
  // 旧口径那份整份数组（判据改过，里面每一条都无法用新规则解释）在构造时作废
  const legacy = fakeMemento({ unreadSessionIds: [A] });
  const stale = makeDriver([row(A)], { state: () => legacy });
  await stale.driver.refreshSessions();
  assert.strictEqual(unreadInList(stale.frames, A), false, "旧口径留下的旗标不许再亮");
  assert.deepStrictEqual(
    stale.driver.stateKeys().filter((key) => key === "unreadSessionIds"),
    [],
    "旧键要真的删掉，不能只是不读它",
  );

  // 新口径：一个会话一把键（写＝建键，读掉＝删键）
  const single = fakeMemento();
  const one = makeDriver([row(A), row(B)], { state: () => single });
  await one.driver.refreshSessions();
  await one.driver.openSession("v1", A);
  await one.driver.status(A, true);
  await one.driver.openSession("v1", B); // 离开正在生成的 A
  await one.driver.status(A, false); // A 收尾 → 未读
  assert.strictEqual(unreadInList(one.frames, A), true, "前置：A 记了未读");
  assert.strictEqual(single.get("unread:" + A), true, "未读只写它自己那把键");
  await one.driver.openSession("v1", A); // 回来看它
  assert.strictEqual(single.get("unread:" + A), undefined, "看过了：那把键要删掉");
  assert.deepStrictEqual(
    single.keys().filter((key) => key.startsWith("unread:")),
    [],
    "清掉之后 `keys()` 里也不许再出现它",
  );

  // 多窗口：各自只写自己刚改的那一条，别人的旗标不会被整份覆写带走或复活
  const shared = sharedGlobalState();
  const first = makeDriver([row(A), row(B)], { state: shared.memento });
  const second = makeDriver([row(A), row(B)], { state: shared.memento });
  await first.driver.refreshSessions();
  await second.driver.refreshSessions();
  for (const [window, target, other] of [
    [first, A, B],
    [second, B, A],
  ] as const) {
    await window.driver.openSession("v1", target);
    await window.driver.status(target, true);
    await window.driver.openSession("v1", other); // 离开正在生成的它
    await window.driver.status(target, false); // 收尾 → 该窗口记未读
    assert.strictEqual(unreadInList(window.frames, target), true, `前置：${target} 记了未读`);
  }
  assert.strictEqual(shared.shared.get("unread:" + A), true, "另一个窗口写盘不许把 A 那条带走");
  assert.strictEqual(shared.shared.get("unread:" + B), true, "另一个窗口写盘不许把 B 那条带走");
  console.log("  ⑬ 未读按会话分键：旧集合作废、多窗口互不覆写 ✓");
}

console.log("unreadMarker: 只有「离开生成中的会话」会点亮未读 ✓");