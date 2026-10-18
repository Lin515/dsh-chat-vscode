/**
 * 离线断言：**连接尝试的账本与收场**（`src/dsh/connectionAttempts.ts`）。
 *
 * 为什么是行为断言：这类缺陷从来不会让 typecheck 或别的断言变红——「点了停止过一会儿
 * 又连上了」「停止内部 DSH 把外部那条连接也收掉了」「停止之后心跳又接回来」都只在
 * 真实顺序里显形。所以这里**驱动真的 `ChatController`**（`vscode` 由 stub 顶替），
 * 只把两样东西换成替身：
 *
 * - **客户端**（构造函数的 `createClient` seam）：假客户端记下自己被 dispose 几次、
 *   能手动触发状态回调，于是「收了几次」「迟到的回调有没有写状态」都可断言；
 * - **管理器**（窄的假服务端）：记下 `stop()` 收到哪一档、`ensure()` 什么时候返回，
 *   于是「等待中的停止」「同后台占用有没有被误交还」都可断言。
 *
 * 覆盖的是长期不变量（逐条对着 `connectionAttempts.ts` 的意图表读）：等待中停止不建连接、
 * 换目标只中止等待（占用留着）、**当前客户端**的回调仍更新界面而**旧客户端**的回调一律被拒、
 * 收场不重复 dispose、迟到的完成与**迟到的失败**都不许覆盖/改写新连接、过期轮次不许接管客户端、
 * 过期轮次被放弃时只收它自己那条、外部目标下停内部后台不动本窗口连接、叫停之后心跳不许
 * 自动接回、显式动作能重新接上；模块面另钉终止动作的顺序与「放弃一轮不动不属于它的连接」。
 *
 * 运行：npm test（必须登记到 `esbuild.scripts.mjs` 的 entries，否则静默不跑）
 */
import assert from "node:assert";
import type { DshClient } from "../src/dsh/client";
import type { ConnectionRound } from "../src/dsh/connectionAttempts";

const { ChatController } = await import("../src/dsh/controller");
const { createConnectionAttempts } = await import("../src/dsh/connectionAttempts");
const { DshAuthError } = await import("../src/dsh/client");

type StopCall = { release?: boolean; cancelWait?: boolean; askSupervisor?: boolean };

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 等排下的微任务跑完（替身的 promise 都是立刻 settle 的）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 假客户端：**不镜像 `DshClient`**，只在适配处按用到的面接上（`as unknown as DshClient`）。
 *
 * 连接这一路真正会碰到的只有：换 cookie（`authenticate`）、建连（`connect`）、
 * 状态回调、拉目录（`modelCatalog`）、拉会话列表（`listSessions`）、收自己（`dispose`）。
 */
class FakeClient {
  disposed = 0;
  /** 非空时 `authenticate` 卡在这道闸上（模拟"换 cookie 要几秒"）。 */
  holdAuth: Promise<void> | undefined;
  /** 换 cookie 迟到失败（模拟"这一轮已经不作数了，auth 才 reject"）。 */
  authFailure: unknown;
  private readonly listeners: ((state: string) => void)[] = [];

  constructor(readonly baseUrl: string) {}

  async authenticate(): Promise<void> {
    if (this.holdAuth) await this.holdAuth;
    if (this.authFailure !== undefined) throw this.authFailure;
  }

  connect(): void {}

  onDidChangeState(listener: (state: string) => void): void {
    this.listeners.push(listener);
  }

  /** 模拟服务端/传输层推来的状态（含被收掉之后迟到的那些）。 */
  emit(state: string): void {
    for (const listener of [...this.listeners]) listener(state);
  }

  async modelCatalog(): Promise<{ groups: unknown[] }> {
    return { groups: [] };
  }

  async listSessions(): Promise<{ items: unknown[] }> {
    return { items: [] };
  }

  useSessionCookie(): void {}

  /** `onConnected` 要开三条流；这里给"开了就完事"的替身句柄。 */
  followControl(): { cancel(): void } {
    return { cancel: () => undefined };
  }

  openStream(): { cancel(): void } {
    return { cancel: () => undefined };
  }

  openEvents(): { cancel(): void } {
    return { cancel: () => undefined };
  }

  async permissionCatalog(): Promise<unknown> {
    return undefined;
  }

  async request(): Promise<unknown> {
    return undefined;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

interface Internals {
  connection: string;
  connectionDetail: string | undefined;
  client: unknown;
  attempts: { autoReconnect: boolean; retryable: boolean; inFlight: unknown };
  teardownStreams: () => void;
}

const INTERNAL_INFO = { baseUrl: "http://127.0.0.1:41001/", token: "start-token", ownership: "self" };
const EXTERNAL_INFO = { baseUrl: "https://external.example/", token: undefined, ownership: "external" };

function makeHarness() {
  const clients: FakeClient[] = [];
  const stopCalls: StopCall[] = [];
  const ensureCalls: { start?: boolean; target?: string }[] = [];
  const ensures: { resolve: (info: unknown) => void }[] = [];
  let heartbeatHook: (() => void) | undefined;
  let teardowns = 0;
  let nextHold: Promise<void> | undefined;

  const server = {
    stop: (options: StopCall = {}) => {
      stopCalls.push({ ...options });
      return Promise.resolve(options.askSupervisor === true);
    },
    ensure: (options: { start?: boolean; target?: string }) => {
      ensureCalls.push({ ...options });
      const gate = deferred<unknown>();
      ensures.push({ resolve: gate.resolve });
      return gate.promise;
    },
    probeRunning: async () => ({ supervisorAlive: true }),
    probeExternal: async () => false,
    snapshot: () => ({
      target: undefined,
      status: { state: "stopped" },
      connected: false,
      startAllowed: true,
      stoppedByUser: false,
      detachedByUser: false,
      stopping: false,
      remembered: false,
      externalUrl: undefined,
      commandConfigured: true,
    }),
    onHeartbeat: (hook: () => void) => {
      heartbeatHook = hook;
    },
    externalUrl: "https://external.example/",
    commandConfigured: true,
    activeBaseUrl: undefined,
    freshToken: () => undefined,
    setAutoConnect: () => undefined,
    restart: async () => undefined,
    dispose: () => undefined,
  };

  const memento = () => {
    const map = new Map<string, unknown>();
    return {
      get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
      keys: () => [...map.keys()],
      update: async (key: string, value: unknown) => {
        if (value === undefined) map.delete(key);
        else map.set(key, value);
      },
    };
  };

  const controller = new ChatController(
    server as never,
    () => undefined,
    memento() as never,
    memento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
    (baseUrl: string) => {
      const client = new FakeClient(baseUrl);
      client.holdAuth = nextHold;
      clients.push(client);
      return client as unknown as DshClient;
    },
  );
  const internals = controller as unknown as Internals;
  // 收跟随流的次数：模块经 `teardownFollows` 回调到控制器的这个方法（实例属性优先）
  const realTeardown = internals.teardownStreams.bind(controller);
  internals.teardownStreams = () => {
    teardowns += 1;
    realTeardown();
  };

  return {
    controller,
    internals,
    clients,
    stopCalls,
    ensureCalls,
    /** 让下一个建出来的客户端卡在换 cookie 上。 */
    holdNextAuth: (hold: Promise<void>) => {
      nextHold = hold;
    },
    resolveEnsure: (index: number, info: unknown) => ensures[index].resolve(info),
    heartbeat: async () => {
      heartbeatHook?.();
      await flush();
    },
    teardowns: () => teardowns,
  };
}

// ---------- 1. 等待中的停止：这一轮不再建连接，界面回按钮态 ----------
{
  const h = makeHarness();
  const round = h.controller.connectInternal();
  await flush();
  check("前置：还没建客户端（这一轮还在等后台就绪）", h.clients.length === 0, `clients=${h.clients.length}`);

  h.controller.stopReconnect();
  check(
    "等待中停止：收场落到管理器上（cancelWait 让位 + release 交还占用）",
    h.stopCalls.some((call) => call.cancelWait === true) && h.stopCalls.some((call) => call.release === true),
    JSON.stringify(h.stopCalls),
  );
  check(
    "等待中停止：不请守护进程收场（进程一个都不动）",
    !h.stopCalls.some((call) => call.askSupervisor === true),
    JSON.stringify(h.stopCalls),
  );

  h.resolveEnsure(0, INTERNAL_INFO);
  await round;
  check("迟到的那一轮不再建客户端（作废在途轮生效）", h.clients.length === 0, `clients=${h.clients.length}`);
  check("界面停在按钮态，不被迟到的完成改回连接中", h.internals.connection === "stopped", h.internals.connection);
  check("自动路径的闸关着（心跳不许接回）", h.internals.attempts.autoReconnect === false);
}

// ---------- 2. 换目标：同一个后台的占用必须留着，旧客户端一次收干净 ----------
{
  const h = makeHarness();
  const first = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await first;
  const owned = h.clients[0];
  check("前置：连上内部后台", h.internals.connection === "connected" && h.internals.client === owned);

  const second = h.controller.connectExternal();
  await flush();
  check("换目标把上一条连接收干净（dispose 恰好一次）", owned.disposed === 1, `disposed=${owned.disposed}`);
  check(
    "换目标只中止在途等待，**不交还占用**（马上要接上的可能是同一个后台）",
    h.stopCalls.some((call) => call.cancelWait === true && call.release !== true) &&
      !h.stopCalls.some((call) => call.release === true),
    JSON.stringify(h.stopCalls),
  );

  h.resolveEnsure(1, EXTERNAL_INFO);
  await second;
  const external = h.clients[1];
  check(
    "新目标接上后界面是就绪、连接主体换成新客户端",
    h.internals.connection === "connected" && h.internals.client === external,
  );

  // 被换掉的那个客户端自己也带无限重连：它迟到的回调不许写任何全局状态
  owned.emit("disconnected");
  owned.emit("connecting");
  check(
    "旧客户端的迟到回调不许写状态（连接主体与界面都不动）",
    h.internals.connection === "connected" && h.internals.client === external,
    `${h.internals.connection} / ${h.internals.client === external ? "new" : "old"}`,
  );
}

// ---------- 3. 目标是外部时，「停止内部 DSH」一个字都不许动本窗口的连接 ----------
{
  const h = makeHarness();
  const first = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await first;
  const second = h.controller.connectExternal();
  await flush();
  h.resolveEnsure(1, EXTERNAL_INFO);
  await second;
  const external = h.clients[1];
  const teardownsBefore = h.teardowns();

  const requested = await h.controller.stopServer();

  const last = h.stopCalls[h.stopCalls.length - 1];
  check(
    "停内部后台：请求照发（cancelWait + askSupervisor）",
    last?.cancelWait === true && last?.askSupervisor === true,
    JSON.stringify(last),
  );
  check("回执如实：请求真的发出去了", requested === true);
  check("外部目标下不收本窗口的客户端", external.disposed === 0, `disposed=${external.disposed}`);
  check("外部目标下不收跟随流", h.teardowns() === teardownsBefore, `teardowns=${h.teardowns() - teardownsBefore}`);
  check("外部目标下界面不被拉回按钮态", h.internals.connection === "connected", h.internals.connection);
  check("外部目标下连接主体不变", h.internals.client === external);
  check("外部目标下也不关自动路径的闸（外部那条连接照旧自己重连）", h.internals.attempts.autoReconnect === true);
}

// ---------- 4. 停止之后：迟到的完成不接上，心跳也不许自动接回 ----------
{
  const h = makeHarness();
  const first = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await first;
  const owned = h.clients[0];

  const pending = h.controller.connectExternal();
  await flush();
  h.controller.stopReconnect();
  check("停止连接：交还占用（release 那一档）", h.stopCalls.some((call) => call.release === true));

  const ensureBefore = h.ensureCalls.length;
  await h.heartbeat();
  check(
    "停止之后心跳不许自动接回（不再 ensure 一轮）",
    h.ensureCalls.length === ensureBefore,
    `ensure=${h.ensureCalls.length - ensureBefore}`,
  );

  h.resolveEnsure(1, EXTERNAL_INFO);
  await pending;
  check("迟到的完成不建新连接", h.clients.length === 1, `clients=${h.clients.length}`);
  check("迟到的完成不改界面（停在按钮态）", h.internals.connection === "stopped", h.internals.connection);
  check("停止连接收掉了手里的客户端", owned.disposed === 1, `disposed=${owned.disposed}`);
}

// ---------- 5. 显式动作重新接上：闸重开、新客户端被接管 ----------
{
  const h = makeHarness();
  const first = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await first;
  // 「停止连接」只在"连接中"那一档可点：先换一次目标把界面带回连接中
  const pending = h.controller.connectExternal();
  await flush();
  h.controller.stopReconnect();
  check("前置：叫停之后闸是关的", h.internals.attempts.autoReconnect === false);
  h.resolveEnsure(1, EXTERNAL_INFO);
  await pending;

  const again = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(2, INTERNAL_INFO);
  await again;
  const fresh = h.clients[h.clients.length - 1];
  check("显式动作重开自动路径的闸（用户要后台时不该被配置挡住）", h.internals.attempts.autoReconnect === true);
  check("显式动作接上并接管新客户端", h.internals.connection === "connected" && h.internals.client === fresh);
  check("新客户端没有被误收", fresh.disposed === 0, `disposed=${fresh.disposed}`);
}

// ---------- 6. 收场之后迟到的客户端：恰好收一次，不接管 ----------
{
  const h = makeHarness();
  const gate = deferred<void>();
  h.holdNextAuth(gate.promise);
  const round = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await flush();
  check(
    "前置：客户端已经建出来但还没接管（卡在换 cookie）",
    h.clients.length === 1 && h.internals.client === undefined,
    `clients=${h.clients.length}`,
  );

  h.controller.stopReconnect();
  gate.resolve();
  await round;
  check("迟到的客户端恰好收一次（不 double dispose）", h.clients[0].disposed === 1, `disposed=${h.clients[0].disposed}`);
  check("迟到的客户端不被接管", h.internals.client === undefined);
  check("界面停在按钮态", h.internals.connection === "stopped", h.internals.connection);
}

// ---------- 7. 旧轮迟到 + 新目标补跑：旧轮不许覆盖新连接 ----------
{
  const h = makeHarness();
  const gate = deferred<void>();
  h.holdNextAuth(gate.promise);
  const stale = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await flush();
  check("前置：旧轮的客户端还没接管", h.clients.length === 1 && h.internals.client === undefined);

  h.controller.stopReconnect();
  const next = h.controller.connectExternal();
  await flush();
  gate.resolve();
  await flush();
  check(
    "旧轮结束后补跑一轮新目标（并发合并等的是旧轮结束，不是同时起两个客户端）",
    h.ensureCalls.length === 2 && h.ensureCalls[1].target === "external",
    JSON.stringify(h.ensureCalls),
  );

  h.resolveEnsure(1, EXTERNAL_INFO);
  await next;
  const fresh = h.clients[1];
  check("新轮接上并接管新客户端", h.internals.connection === "connected" && h.internals.client === fresh);
  check(
    "旧轮只收掉它自己那条（不 double dispose、不动新客户端）",
    h.clients[0].disposed === 1 && fresh.disposed === 0,
    `stale=${h.clients[0].disposed} fresh=${fresh.disposed}`,
  );
}

// ---------- 8. 模块面：终止动作的顺序是定死的 ----------
{
  const order: string[] = [];
  const client = new FakeClient("http://order.example/");
  client.dispose = () => {
    order.push("dispose");
  };
  let slot: unknown = client;
  const attempts = createConnectionAttempts({
    stop: async (options = {}) => {
      order.push(options.cancelWait ? "cancelWait" : "stop");
      return false;
    },
    teardownFollows: () => order.push("teardown"),
    markStopped: () => order.push("markStopped"),
    clientSlot: {
      get: () => slot as DshClient | undefined,
      set: (value) => {
        slot = value;
      },
    },
    createClient: () => {
      throw new Error("这一组不建客户端");
    },
    log: () => undefined,
  });

  await attempts.run({ target: "internal", mayStart: true }, async (round) => {
    round.adopt(client as unknown as DshClient);
  });
  order.length = 0;
  attempts.retarget();
  check(
    "终止顺序：作废在途轮 → 中止等待 → 收跟随流 → 收客户端",
    order.join(",") === "cancelWait,teardown,dispose",
    order.join(","),
  );
  check("终止之后账本里没有连接了（不会二次 dispose）", slot === undefined);
}

// ---------- 9. 模块面：放弃一轮不动不属于它的连接 ----------
{
  const stopCalls: StopCall[] = [];
  let teardowns = 0;
  const foreign = new FakeClient("http://foreign.example/");
  let slot: unknown = foreign;
  const attempts = createConnectionAttempts({
    stop: async (options = {}) => {
      stopCalls.push({ ...options });
      return false;
    },
    teardownFollows: () => {
      teardowns += 1;
    },
    markStopped: () => undefined,
    clientSlot: {
      get: () => slot as DshClient | undefined,
      set: (value) => {
        slot = value;
      },
    },
    createClient: () => {
      throw new Error("这一组不建客户端");
    },
    log: () => undefined,
  });

  let round: ConnectionRound | undefined;
  await attempts.run({ target: "internal", mayStart: false }, async (current) => {
    round = current;
  });
  attempts.abandon(round as ConnectionRound);

  check("放弃一轮：不碰账本里那条不属于它的连接", foreign.disposed === 0, `disposed=${foreign.disposed}`);
  check("放弃一轮：它什么都没建起来，就不收跟随流", teardowns === 0, `teardowns=${teardowns}`);
  check(
    "放弃一轮：仍然幂等地再交还一次占用（叫停之后那一轮可能已经把连接建起来了）",
    stopCalls.some((call) => call.release === true),
    JSON.stringify(stopCalls),
  );
  check("放弃一轮：这一轮已经结束", attempts.inFlight === undefined);
}

// ---------- 13. 旧轮的**失败**迟到：不许把已经不作数的失败当成当前错误 ----------
{
  const h = makeHarness();
  const gate = deferred<void>();
  h.holdNextAuth(gate.promise);
  const round = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await flush();
  const stale = h.clients[0];
  stale.authFailure = new DshAuthError("换 cookie 迟到失败");
  check("前置：客户端已经建出来但还没接管（卡在换 cookie）", h.clients.length === 1 && h.internals.client === undefined);

  h.controller.stopReconnect();
  gate.resolve();
  await round;

  check("旧轮的迟到失败不改界面（停在按钮态，不进错误档）", h.internals.connection === "stopped", h.internals.connection);
  check("旧轮的迟到失败不写错误详情", h.internals.connectionDetail === undefined, String(h.internals.connectionDetail));
  check("旧轮的迟到失败不复活自动重试", h.internals.attempts.retryable === false);
  check("旧轮的那条客户端仍被收掉（不泄漏）", stale.disposed === 1, `disposed=${stale.disposed}`);
}

// ---------- 14. 连接正常结束后：**当前**客户端的后续状态回调仍要更新界面 ----------
//
// 这一条是"作废判据"的**正例**：只钉"旧回调被拒"的话，把判据写成"永远为假"也能全绿
// ——那正是这套守卫最容易退化的方向（掉线/恢复不再更新界面，而所有负例测试照样过）。
{
  const h = makeHarness();
  const round = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await round;
  const owned = h.clients[0];
  check("前置：连上内部后台", h.internals.connection === "connected" && h.internals.client === owned);

  owned.emit("disconnected");
  check(
    "当前客户端掉线：界面跟着更新（连接中 + 掉线原因）",
    h.internals.connection === "connecting" && h.internals.connectionDetail === "@connectionLost",
    `${h.internals.connection} / ${String(h.internals.connectionDetail)}`,
  );

  owned.emit("connecting");
  check("当前客户端重连中：界面仍是连接中", h.internals.connection === "connecting", h.internals.connection);

  owned.emit("connected");
  check("当前客户端恢复：界面推回就绪", h.internals.connection === "connected", h.internals.connection);
  check("恢复不建第二个客户端、也不换连接主体", h.clients.length === 1 && h.internals.client === owned);
}

// ---------- 15. 换目标之后：**旧**客户端的回调仍然一律被拒 ----------
{
  const h = makeHarness();
  const first = h.controller.connectInternal();
  await flush();
  h.resolveEnsure(0, INTERNAL_INFO);
  await first;
  const owned = h.clients[0];

  const second = h.controller.connectExternal();
  await flush();
  h.resolveEnsure(1, EXTERNAL_INFO);
  await second;
  const external = h.clients[1];
  check("前置：已经连上外部", h.internals.connection === "connected" && h.internals.client === external);

  owned.emit("disconnected");
  check(
    "旧客户端迟到的掉线不改界面、不改重试闸",
    h.internals.connection === "connected" && h.internals.connectionDetail === undefined,
    `${h.internals.connection} / ${String(h.internals.connectionDetail)}`,
  );
  owned.emit("connected");
  check("旧客户端迟到的恢复也不改界面", h.internals.connection === "connected" && h.internals.client === external);
}

/**
 * 模块面的最小台架：只记「谁被收了几次」「收了几次跟随流」「界面被拉回按钮态几次」
 * 「管理器收到哪些档」。用来钉那些**只有调用顺序错了才显形**的不变量。
 */
function moduleHarness() {
  const disposed: string[] = [];
  const stops: StopCall[] = [];
  let teardowns = 0;
  let stoppedMarks = 0;
  let slot: DshClient | undefined;
  const client = (name: string): DshClient => {
    const fake = new FakeClient(name);
    fake.dispose = () => {
      disposed.push(name);
    };
    return fake as unknown as DshClient;
  };
  const attempts = createConnectionAttempts({
    stop: async (options = {}) => {
      stops.push({ ...options });
      return false;
    },
    teardownFollows: () => {
      teardowns += 1;
    },
    markStopped: () => {
      stoppedMarks += 1;
    },
    clientSlot: {
      get: () => slot,
      set: (value) => {
        slot = value;
      },
    },
    createClient: () => {
      throw new Error("这一组不建客户端");
    },
    log: () => undefined,
  });
  return {
    attempts,
    client,
    count: (name: string) => disposed.filter((item) => item === name).length,
    stops,
    teardowns: () => teardowns,
    stoppedMarks: () => stoppedMarks,
    slot: () => slot,
  };
}

// ---------- 10. 模块面：收过的客户端不再收第二次（幂等） ----------
{
  const h = moduleHarness();
  const old = h.client("old");
  let round: ConnectionRound | undefined;
  await h.attempts.run({ target: "internal", mayStart: true }, async (current) => {
    round = current;
    current.adopt(old);
  });

  h.attempts.retarget();
  check("终止把账本里那条收掉（一次）", h.count("old") === 1 && h.slot() === undefined, `disposed=${h.count("old")}`);

  round?.discard(old);
  round?.discard();
  check("已结束的轮次再收同一个客户端是幂等的（总共只 dispose 一次）", h.count("old") === 1, `disposed=${h.count("old")}`);

  // 窗口释放走两遍（模块卸载与控制器 dispose 都调）也必须幂等
  const release = moduleHarness();
  const only = release.client("only");
  await release.attempts.run({ target: "internal", mayStart: true }, async (current) => {
    current.adopt(only);
  });
  release.attempts.dispose();
  release.attempts.dispose();
  check(
    "重复的窗口释放也幂等（客户端与跟随流各只收一次）",
    release.count("only") === 1 && release.teardowns() === 1,
    `disposed=${release.count("only")} teardowns=${release.teardowns()}`,
  );
}

// ---------- 11. 模块面：过期轮次不许接管客户端（不许覆盖账本里那条） ----------
{
  const h = moduleHarness();
  const current = h.client("current");
  const incoming = h.client("incoming");
  const gate = deferred<void>();
  let stale: ConnectionRound | undefined;
  const running = h.attempts.run({ target: "internal", mayStart: true }, async (round) => {
    stale = round;
    await gate.promise;
  });
  // 换目标：旧轮作废（它还没接管任何东西），新轮接管当前连接
  h.attempts.retarget();
  await h.attempts.run({ target: "external", mayStart: false }, async (round) => {
    round.adopt(current);
  });
  check("前置：账本里是新一轮接管的连接", h.slot() === current);

  const accepted = stale?.adopt(incoming);
  check("过期轮次的接管被拒绝（返回 false）", accepted === false, `accepted=${String(accepted)}`);
  check("它拿来的那条只被收掉", h.count("incoming") === 1, `disposed=${h.count("incoming")}`);
  check("账本里那条不动（当前连接没被换、也没被收）", h.slot() === current && h.count("current") === 0);
  gate.resolve();
  await running;
}

// ---------- 12. 模块面：过期轮次被放弃时不许撕新连接 ----------
{
  const h = moduleHarness();
  const old = h.client("old");
  const fresh = h.client("fresh");
  let oldRound: ConnectionRound | undefined;
  await h.attempts.run({ target: "internal", mayStart: true }, async (round) => {
    oldRound = round;
    round.adopt(old);
  });
  h.attempts.retarget();

  let newRound: ConnectionRound | undefined;
  await h.attempts.run({ target: "external", mayStart: false }, async (round) => {
    newRound = round;
    round.adopt(fresh);
  });
  check("前置：新轮已经接管新客户端", h.slot() === fresh);

  const stopsBefore = h.stops.length;
  const teardownsBefore = h.teardowns();
  h.attempts.abandon(oldRound as ConnectionRound);

  check("过期轮次被放弃：不动新客户端", h.count("fresh") === 0 && h.slot() === fresh, `fresh=${h.count("fresh")}`);
  check("过期轮次被放弃：不收新轮的跟随流", h.teardowns() === teardownsBefore, `teardowns=${h.teardowns() - teardownsBefore}`);
  check(
    "过期轮次被放弃：不交还当前占用（不给管理器发 release）",
    h.stops.length === stopsBefore,
    JSON.stringify(h.stops.slice(stopsBefore)),
  );
  check("过期轮次被放弃：不把界面拉回按钮态", h.stoppedMarks() === 0, `marks=${h.stoppedMarks()}`);
  check("过期轮次被放弃：只收掉它自己那条旧客户端（不重复 dispose）", h.count("old") === 1, `old=${h.count("old")}`);
  void newRound;
}

if (failures > 0) {
  console.error(`\n✗ 连接尝试的账本与收场：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 连接尝试的账本与收场（等待中停止 / 换目标留占用 / 当前客户端回调仍更新界面 / 旧回调不写状态 / 迟到完成不覆盖 / 迟到失败不当当前错误 / 收场恰好一次 / 过期轮次不许接管 / 过期轮次被放弃不撕新连接 / 外部目标不动连接 / 心跳不接回 / 显式重连 / 终止顺序 / 放弃不动别人的连接）全通过",
  );
  assert.ok(true);
}
