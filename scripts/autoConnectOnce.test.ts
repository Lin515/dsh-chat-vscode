/**
 * 离线断言：**自动连接只在扩展启动时做一次**（用户 2026-10-18 口径）。
 *
 * 报障现场：A 窗口点「停止内部 DSH」之后，B 窗口过一会儿又拉起一套新 supervisor。
 * 根因不止一处，本文件钉**控制器这一侧**的三条来路（管理器那一侧的心跳由
 * `supervisorNoRespawn.test.ts` 用真 socket 假守护进程钉）：
 *
 * 1. `autoConnect()` 原来每调一次就重新选路 + `ensureConnected(plan.start)`——而
 *    `startup()` 的清文档锁是异步的、`ready`/恢复 hint 可能更早、激活期里用户也可能
 *    自己动过连接，于是"启动时那一次"有机会变成好几次；
 * 2. `handleHeartbeat()` 未连接时原先沿用 `this.target.mayStart`（激活期那次"允许拉起"的
 *    许可），于是后台没了之后每 5 秒 spawn 一次。现在心跳只按**原目标接着接**：发出去的
 *    是 `start: false`，暂缺内部后台时一个字都不发起（重连意图留着，下个心跳再探）；
 * 3. `dshChat.autoConnect` 改开时立刻 `autoConnect(true)`——用户改配置不是"我要起一套"。
 *
 * 另钉两条**收场**语义（用户 2026-10-18 澄清）：使用过程中的普通断连**保留对原端点的自动
 * 重连**（不重新选路、不 spawn），只有守护进程亲口告别（`cause` 为 `stop`/`idle`）或用户点了
 * 停止才算终结、才回按钮态；同一个守护进程换了端点才重建客户端。
 *
 * 还有一条**时序**：`startup()` 要先异步清完文档锁才发起激活期那次连接，而聊天页面
 * （webview）的 `ready` 完全可能更早。那一趟必须**不消费**恢复 hint：烧掉它，连接落地后
 * `onConnected` 只会补一条空壳，用户的历史会话再没有人接回来。
 *
 * 驱动的是**真 `ChatController`**（`vscode` 由 esbuild alias 指到 `vscodeTestStub`），
 * 只有管理器与客户端是假的：`createClient` 是控制器里唯一的造客户端 seam（见
 * `connectionAttempts.ts`）。全程离线、不起真实 DSH、不发真实模型消息、不消耗 token。
 *
 * 运行：npm test（必须登记到 `esbuild.scripts.mjs` 的 entries，否则静默不跑）
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[autoConnectOnce] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 让所有已经排上队的微任务跑完（这些链几乎全是同步代码 + 立即 resolve 的假 RPC）。 */
async function settle(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

const CWD = "C:\\work\\demo";
/** 关闭窗口前那条历史会话（已经说过话，`blank=false`）：恢复认领会把它接回来。 */
const HISTORY = "session-history";
const INTERNAL_INFO = { baseUrl: "http://127.0.0.1:41001/", token: "token-from-file", ownership: "self" as const };

/**
 * 假客户端：只实现控制器连接链会碰到的成员。
 *
 * 会话行那部分与 `blankRestoreRace.test.ts` 同形（`session/create` 造 blank 行、
 * `session/list` 只在被查时才交出新值），因为本文件最后一条断言要走
 * 「连接落地 → 唤醒恢复 hint → 接回历史会话」。
 *
 * `emit()` 是假客户端自己的：真实的 `DshClient` 由 ws 状态变化回调，
 * 这里由断言直接推，才能把"连接落地"这一刻摆在指定位置上。
 */
class FakeClient {
  disposed = 0;
  /** 生产里 `DshClient` 也留着一份（已去尾斜杠）——心跳靠它判"端点变没变"。 */
  readonly baseUrl: string;
  readonly calls: string[] = [];
  readonly rows: { sessionId: string; cwd: string; blank: boolean; updatedAt: number; running: boolean }[];
  private readonly listeners: ((state: string) => void)[] = [];

  constructor(baseUrl: string, seed: { sessionId: string; blank?: boolean }[] = []) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.rows = seed.map((row, index) => ({
      sessionId: row.sessionId,
      cwd: CWD,
      blank: row.blank !== false,
      updatedAt: Date.now() + index,
      running: false,
    }));
  }

  emit(state: string): void {
    for (const listener of [...this.listeners]) listener(state);
  }

  async authenticate(): Promise<void> {}
  connect(): void {}
  onDidChangeState(listener: (state: string) => void): void {
    this.listeners.push(listener);
  }
  dispose(): void {
    this.disposed += 1;
  }
  async modelCatalog(): Promise<{ groups: unknown[] }> {
    return { groups: [] };
  }
  async permissionCatalog(): Promise<unknown> {
    return undefined;
  }
  async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string): Promise<{ sessionId: string }> {
    this.calls.push("session/create");
    // 指名复用一条已有会话：服务端认得它就**还是那条**（见 controller 的 adoptBlankShell）
    if (reuse !== undefined && this.rows.some((row) => row.sessionId === reuse)) return { sessionId: reuse };
    const sessionId = `session-${this.rows.length + 1}`;
    this.rows.push({ sessionId, cwd: target.cwd ?? "", blank: true, updatedAt: Date.now() + this.rows.length, running: false });
    return { sessionId };
  }
  async listSessions(): Promise<{ items: unknown[] }> {
    this.calls.push("session/list");
    return { items: this.rows.map((row) => ({ ...row })) };
  }
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push(method);
    if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
    if (method === "agentPresets/list") return { presets: [] };
    if (method === "subagents/list") return { entries: [] };
    if (method === "session/projections") return { values: {} };
    const agentId = String(params?.agentId ?? "");
    if (this.rows.some((row) => row.sessionId === agentId)) {
      if (method === "commands/list") return [{ name: "plan", description: "切换计划模式" }];
      if (method === "fileReferences/list") return [];
      if (method === "sessionReferenceResolver/candidates") return [];
      if (method === "skills/list") return { skills: [] };
      return undefined;
    }
    return undefined;
  }
  async sessionProjections(): Promise<{ values: Record<string, unknown> }> {
    return { values: {} };
  }
  async getJson(): Promise<undefined> {
    return undefined;
  }
  async settingsDescribe(): Promise<{ namespaces: unknown[] }> {
    return { namespaces: [] };
  }
  followSession(): { cancel(): void } {
    return { cancel() {} };
  }
  followJobs(): { cancel(): void } {
    return { cancel() {} };
  }
  followControl(): { cancel(): void } {
    return { cancel() {} };
  }
  openStream(): { cancel(): void } {
    return { cancel() {} };
  }
  openEvents(): { cancel(): void } {
    return { cancel() {} };
  }
}

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

/** 控制器内部字段（编译产物里没有 `private`；断言要读状态、也要按现场顺序摆位置）。 */
interface ControllerInternals {
  connection: string;
  client: FakeClient | undefined;
  target: { kind: string; mayStart: boolean } | undefined;
  attempts: { autoReconnect: boolean; retryable: boolean };
  userChoseConnection: boolean;
  restoreHints: Map<string, { sessionId: string }>;
  viewSessions: Map<string, string>;
  bindView(viewId: string): void;
  handle(message: { type: "ready" }, viewId: string): Promise<void>;
  onServerStatus(status: { state: string; detail?: string; cause?: string }): void;
}

interface Harness {
  controller: InstanceType<typeof ChatController>;
  internals: ControllerInternals;
  clients: FakeClient[];
  /** 每一次 `server.ensure()` 的调用参数（按发生顺序）——"有没有发起连接/拉起后台"的判据。 */
  ensureCalls: { start?: boolean; target?: string }[];
  /** 每一次 `server.stop()` 的调用参数。 */
  stopCalls: Record<string, unknown>[];
  /** `setAutoConnect` 收到的值（热配置只该动这里）。 */
  autoConnectValues: boolean[];
  /** 两轴探测被执行了几次（"重复调用有没有重新选路"的判据）。 */
  probeCalls(): number;
  resolveEnsure(index: number, info: unknown): void;
  setSupervisorAlive(value: boolean): void;
  /** 管理器快照里那份"内部就绪"的记忆（心跳用它判端点变没变）。 */
  setStatusInfo(info: unknown): void;
  /**
   * 给控制器一个"能用的工作目录"（`hasWorkspaceDir()` 只认打开的文件夹或 `newSessionCwd`）。
   * 建空壳那条自动路径必须有它，否则窗口停在"无会话的空态"，与"有没有连上"无关。
   */
  setWorkspaceDir(dir: string): void;
  /** 卡住下一次 `probeRunning()`（模拟"探测要发一次 HTTP，还没来得及回来"）。 */
  holdProbe(): void;
  releaseProbe(): void;
  heartbeat(): Promise<void>;
}

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeHarness(options: { seed?: { sessionId: string; blank?: boolean }[]; supervisorAlive?: boolean } = {}): Harness {
  const ensureCalls: { start?: boolean; target?: string }[] = [];
  const stopCalls: Record<string, unknown>[] = [];
  const autoConnectValues: boolean[] = [];
  const clientGates: Deferred[] = [];
  const clients: FakeClient[] = [];
  let supervisorAlive = options.supervisorAlive ?? false;
  let statusInfo: unknown;
  let heartbeatHook: (() => void) | undefined;
  let holdNextProbe = false;
  let probeCount = 0;
  const probeGates: Deferred[] = [];

  const server = {
    externalUrl: undefined,
    async probeRunning() {
      probeCount += 1;
      if (holdNextProbe) {
        holdNextProbe = false;
        const gate = deferred();
        probeGates.push(gate);
        await gate.promise;
      }
      return { hasState: supervisorAlive, supervisorAlive, serverAlive: supervisorAlive, starting: false };
    },
    async probeExternal() {
      return false;
    },
    snapshot() {
      return { target: undefined, status: { state: "stopped", info: statusInfo }, connected: false, startAllowed: true };
    },
    onHeartbeat(hook: () => void) {
      heartbeatHook = hook;
    },
    setAutoConnect(value: boolean) {
      autoConnectValues.push(value);
    },
    freshToken() {
      return "token-from-file";
    },
    async ensure(options: { start?: boolean; target?: string } = {}) {
      ensureCalls.push({ ...options });
      const gate = deferred();
      clientGates.push(gate);
      return gate.promise;
    },
    async stop(options: Record<string, unknown> = {}) {
      stopCalls.push({ ...options });
      return false;
    },
    async restart() {
      return INTERNAL_INFO;
    },
    dispose() {},
  };

  const controller = new ChatController(
    server as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
    ((baseUrl: string, _token: string | undefined) => {
      const client = new FakeClient(baseUrl, options.seed ?? []);
      clients.push(client);
      return client as never;
    }) as never,
  );

  return {
    controller,
    internals: controller as unknown as ControllerInternals,
    clients,
    ensureCalls,
    stopCalls,
    autoConnectValues,
    probeCalls: () => probeCount,
    resolveEnsure(index: number, info: unknown) {
      clientGates[index]?.resolve(info);
    },
    setSupervisorAlive(value: boolean) {
      supervisorAlive = value;
    },
    setWorkspaceDir(dir: string) {
      (controller as unknown as { newSessionCwd?: string }).newSessionCwd = dir;
    },
    setStatusInfo(info: unknown) {
      statusInfo = info;
    },
    holdProbe() {
      holdNextProbe = true;
    },
    releaseProbe() {
      for (const gate of probeGates.splice(0)) gate.resolve(undefined);
    },
    async heartbeat() {
      heartbeatHook?.();
      await settle(6);
    },
  };
}

console.log("autoConnectOnce: 自动连接只在扩展启动时做一次（驱动真控制器，offline stub）");

// ---------- 一、激活期那一次：重复调用只返回同一条链，不重新选路 ----------
{
  const h = makeHarness({ supervisorAlive: false });
  const first = h.controller.autoConnect(true);
  await settle(2);
  check(
    "激活期选路：内部后台不在 → 只拉起内部（start:true，这一次允许 spawn）",
    h.ensureCalls.length === 1 && h.ensureCalls[0].start === true && h.ensureCalls[0].target === "internal",
    JSON.stringify(h.ensureCalls),
  );

  const second = h.controller.autoConnect(true);
  const third = h.controller.autoConnect(false);
  await settle(2);
  check("重复调用没有多出任何一轮 ensure", h.ensureCalls.length === 1, JSON.stringify(h.ensureCalls));
  check(
    "重复调用也不再探测（两轴探测只做了一次——「稍后再连一次」的入口已经关上）",
    h.probeCalls() === 1,
    `probe=${h.probeCalls()}`,
  );
  let repeatSettled = 0;
  void second.then(() => {
    repeatSettled += 1;
  });
  void third.then(() => {
    repeatSettled += 1;
  });

  h.resolveEnsure(0, INTERNAL_INFO);
  await first;
  await settle();
  check(
    "重复调用随同一条链一起结算（不是各自一条新链）",
    repeatSettled === 2,
    `settled=${repeatSettled}`,
  );
  check("那唯一一轮连线照常落地（连上了）", h.internals.connection === "connected", h.internals.connection);
  check("只有一条客户端（没有并发建第二条连接）", h.clients.length === 1, `clients=${h.clients.length}`);

  await h.controller.autoConnect(true);
  await settle();
  check(
    "连上之后再调一次也不发起新一轮（连 ensure 都不多一条）",
    h.ensureCalls.length === 1 && h.clients.length === 1,
    `ensure=${JSON.stringify(h.ensureCalls)} clients=${h.clients.length}`,
  );
}

// ---------- 二、autoConnect 关着：完全不自动连（只显示按钮） ----------
{
  const h = makeHarness({ supervisorAlive: false });
  await h.controller.autoConnect(false);
  await settle();
  check("关着时不发起任何连接（一次 ensure 都没有）", h.ensureCalls.length === 0, JSON.stringify(h.ensureCalls));
  check("关着时状态是按钮态", h.internals.connection === "stopped", h.internals.connection);
  check("关着时没有选定目标（心跳不许自己接）", h.internals.target === undefined, JSON.stringify(h.internals.target));
}

// ---------- 三、迟到的自动选路让位给用户显式动作 ----------
{
  const h = makeHarness({ supervisorAlive: true });
  h.holdProbe();
  const activation = h.controller.autoConnect(true); // 探测（HTTP）卡在这里
  await settle(2);
  check("前置：激活期选路在探测里，还没发起连接", h.ensureCalls.length === 0, JSON.stringify(h.ensureCalls));

  const userConnect = h.controller.connectInternal(); // 用户此刻自己点了「连接内部 DSH」
  await settle(2);
  check(
    "用户显式连接自己走了一轮（start:true；不受激活期那次影响）",
    h.ensureCalls.length === 1 && h.ensureCalls[0].start === true && h.ensureCalls[0].target === "internal",
    JSON.stringify(h.ensureCalls),
  );
  // 到这一刻为止收到的 `cancelWait` 全是"换目标时作废旧轮次"的记账（用户自己那一下也在内）
  const stopsBeforeLateProbe = h.stopCalls.length;

  h.releaseProbe(); // 迟到的探测结果回来了
  await activation;
  await settle(2);
  check(
    "迟到的自动选路一个字都不改：没有多出第二轮 ensure（连 retarget 都没做）",
    h.ensureCalls.length === 1,
    JSON.stringify(h.ensureCalls),
  );
  check(
    "迟到的自动选路没有把用户那一轮作废（stop 调用数没有增加）",
    h.stopCalls.length === stopsBeforeLateProbe,
    `before=${stopsBeforeLateProbe} after=${h.stopCalls.length}`,
  );
  check("目标仍是用户选的那一个（内部）", h.controller.connectTarget === "internal", String(h.controller.connectTarget));
  check("用户那一轮没有多建客户端（还是只有那一条在飞）", h.clients.length === 0, `clients=${h.clients.length}`);

  // 收场：用户那一轮以「停止连接」结束（避免断言结尾挂着在飞 promise）
  h.controller.stopReconnect();
  h.resolveEnsure(0, INTERNAL_INFO);
  await settle(4);
  await userConnect;
  await settle(2);
}

// ---------- 四、连上之后的失联：按原目标接着接（不重建第二个客户端、绝不拉起） ----------
//
// 用户口径：使用过程中断连，**自动重连要保留**，但只重连原来那条连接——不重新选路、
// 不因为"内部后台这一刻不在"就去 spawn 一套新的。
{
  const h = makeHarness({ supervisorAlive: false });
  const activation = h.controller.autoConnect(true); // 激活期允许拉起（mayStart:true）
  await settle(2);
  h.resolveEnsure(0, INTERNAL_INFO);
  await activation;
  await settle();
  check("前置：激活期那一次连上了", h.internals.connection === "connected", h.internals.connection);
  check(
    "前置：粘性目标是内部，且「允许启动」还挂在上面",
    h.internals.target?.kind === "internal" && h.internals.target?.mayStart === true,
    JSON.stringify(h.internals.target),
  );

  h.clients[0].emit("disconnected"); // 掉线：连接类，仍可重试
  await settle();
  check(
    "前置：掉线后回到 connecting 且这一轮仍可重试",
    h.internals.connection === "connecting" && h.internals.attempts.retryable,
    `${h.internals.connection} retryable=${h.internals.attempts.retryable}`,
  );

  // 会合状态此刻读不到（守护进程换代 / dsh 正在重启）：管理器报 stopped，但 cause 是 `gone`
  h.controller.onServerStatus({ state: "stopped", detail: "server not running", cause: "gone" } as never);
  await settle();
  check(
    "一般失联不切按钮态：连接条仍停在「连接中」（后台可能马上就回来）",
    h.internals.connection === "connecting",
    h.internals.connection,
  );
  check(
    "一般失联不动重连意图",
    h.internals.attempts.retryable && h.internals.attempts.autoReconnect,
    `retryable=${h.internals.attempts.retryable} autoReconnect=${h.internals.attempts.autoReconnect}`,
  );
  check(
    "……手里那条客户端没有被收掉（它的 ws 自己在退避重连）",
    h.clients[0].disposed === 0,
    `disposed=${h.clients[0].disposed}`,
  );

  h.setSupervisorAlive(false); // 整套后台这一刻不在
  await h.heartbeat();
  await h.heartbeat();
  check(
    "心跳：后台这一刻不在也**一个字都不发起**（绝不 spawn，也不重建第二个客户端）",
    h.ensureCalls.length === 1,
    JSON.stringify(h.ensureCalls),
  );
  check(
    "……客户端仍留在手里（下个心跳再来问）",
    h.clients.length === 1 && h.clients[0].disposed === 0,
    `clients=${h.clients.length} disposed=${h.clients[0].disposed}`,
  );

  h.setSupervisorAlive(true); // 后台回来了
  h.setStatusInfo(INTERNAL_INFO);
  await h.heartbeat();
  check(
    "后台回来、端点没变：仍不重建（让手里那条 ws 自己接回去）",
    h.ensureCalls.length === 1,
    JSON.stringify(h.ensureCalls),
  );

  h.clients[0].emit("connected"); // ws 自己接回来了（生产里由 DshClient 推来）
  await settle(12);
  check("恢复后回到 connected", h.internals.connection === "connected", h.internals.connection);
  h.controller.stopReconnect();
  await settle(2);
}

// ---------- 五、改 dshChat.autoConnect 只改许可，不触发连接 ----------
{
  const h = makeHarness({ supervisorAlive: true });
  h.controller.applyAutoConnect(false);
  h.controller.applyAutoConnect(true);
  await settle(2);
  check(
    "改开关只是把许可交给管理器（setAutoConnect 收到 false、true）",
    h.autoConnectValues.join(",") === "false,true",
    h.autoConnectValues.join(",") || "（一次都没收到）",
  );
  check("改开关**不发起任何连接**（ensure 一次都没有）", h.ensureCalls.length === 0, JSON.stringify(h.ensureCalls));
  check("改开关不打断已有连接（没有 stop 调用）", h.stopCalls.length === 0, JSON.stringify(h.stopCalls));
}

// ---------- 六、ready 早于激活期连接：hint 留着，连接落地后接回历史会话 ----------
//
// 现场顺序：`startup()` 要先异步清完文档锁才发起激活期那次连接，而 webview 的 `ready`
// 更早到。这一刻接不了——但"用户上次开的就是这条会话"仍然有效，不许烧掉 hint。
{
  const h = makeHarness({ supervisorAlive: false, seed: [{ sessionId: HISTORY, blank: false }] });
  h.internals.bindView("v1");
  h.internals.restoreHints.set("v1", { sessionId: HISTORY });

  await h.internals.handle({ type: "ready" }, "v1");
  await settle();
  check(
    "ready 早于激活期连接：这一刻**不消费**恢复 hint（留着等连接落地）",
    h.internals.restoreHints.has("v1"),
    h.internals.restoreHints.has("v1") ? "hint 还留着" : "hint 被烧掉了",
  );
  check("……也没有趁机自己连一次（一次 ensure 都没发起）", h.ensureCalls.length === 0, JSON.stringify(h.ensureCalls));
  check("……窗口也没有被补成空壳", h.internals.viewSessions.get("v1") === undefined, String(h.internals.viewSessions.get("v1")));

  const activation = h.controller.autoConnect(true);
  await settle(2);
  check("激活期连接照常发起（唯一一轮）", h.ensureCalls.length === 1, JSON.stringify(h.ensureCalls));
  h.resolveEnsure(0, INTERNAL_INFO);
  await activation;
  await settle(2);
  h.clients[0].emit("connected"); // 连接落地（生产里由 DshClient 的 ws 状态推来）
  await settle(16);

  check(
    "连接落地后 hint 被消费，并接回**历史**会话",
    h.internals.viewSessions.get("v1") === HISTORY,
    String(h.internals.viewSessions.get("v1")),
  );
  check("hint 已经消费掉了（不再排着队）", !h.internals.restoreHints.has("v1"));
  check(
    "没有被空壳顶掉：服务端没有多出会话（仍只有那条历史会话）",
    h.clients[0].rows.length === 1 && h.clients[0].rows[0].sessionId === HISTORY,
    h.clients[0].rows.map((row) => row.sessionId).join(","),
  );
}

// ---------- 七、已知终结（守护进程亲口告别 stop）：当场收场，不再被旧回调推回连接中 ----------
//
// 这里刻意**不靠探测**下结论：守护进程退场途中，`probeRunning()` 仍可能读到即将消失的会合
// 状态（`supervisorAlive: true`）——按探测判据那一趟就不敢收，此后管理器也不会再报一次
// stopped，旧客户端自己的 ws 退避重连就把连接条永远按在"连接中"。终结信号是结构化的
// （`ServerStatus.cause`），所以这一档是确定的。
{
  const h = makeHarness({ supervisorAlive: false });
  const activation = h.controller.autoConnect(true);
  await settle(2);
  h.resolveEnsure(0, INTERNAL_INFO);
  await activation;
  await settle();
  check("前置：激活期那一次连上了", h.internals.connection === "connected", h.internals.connection);

  h.controller.onServerStatus({ state: "stopped", detail: "supervisor stop", cause: "stop" } as never);
  await settle(4);
  check(
    "守护进程亲口告别（stop）：立刻收掉连接、回按钮态",
    h.internals.connection === "stopped",
    h.internals.connection,
  );
  check(
    "……重连意图一起关掉（自动重连与重试都不再继续）",
    !h.internals.attempts.retryable && !h.internals.attempts.autoReconnect,
    `retryable=${h.internals.attempts.retryable} autoReconnect=${h.internals.attempts.autoReconnect}`,
  );
  check(
    "……客户端当场 dispose（不由它的 ws 退避重连把界面推回连接中）",
    h.clients[0].disposed === 1,
    `disposed=${h.clients[0].disposed}`,
  );

  h.clients[0].emit("connecting"); // 旧客户端的迟到回调
  await settle(4);
  check(
    "旧客户端的迟到回调写不进状态（轮次判据）：界面仍停在按钮态",
    h.internals.connection === "stopped",
    h.internals.connection,
  );

  h.setSupervisorAlive(true); // 即使这一刻探测仍说后台还在
  await h.heartbeat();
  check(
    "终结之后心跳也不再接回（不给按钮态偷偷续命，也不 spawn）",
    h.ensureCalls.length === 1 && h.internals.connection === "stopped",
    `ensure=${JSON.stringify(h.ensureCalls)} connection=${h.internals.connection}`,
  );

  const again = h.controller.connectInternal(); // 用户随后自己点了「连接内部 DSH」
  await settle(2);
  check(
    "用户随后显式连接照常发起（start:true；终结不是永久封锁）",
    h.ensureCalls.length === 2 && h.ensureCalls[1].start === true && h.ensureCalls[1].target === "internal",
    JSON.stringify(h.ensureCalls),
  );
  h.resolveEnsure(1, INTERNAL_INFO);
  await again;
  await settle(4);
  check(
    "显式重连真的建起了一条新连接（新客户端，旧的那条不再复用）",
    h.clients.length === 2 && h.internals.connection === "connected",
    `clients=${h.clients.length} connection=${h.internals.connection}`,
  );
  h.controller.stopReconnect();
  await settle(2);
}

// ---------- 八、同一个守护进程重起了 dsh（端点变了）才重建客户端 ----------
{
  const h = makeHarness({ supervisorAlive: false });
  const activation = h.controller.autoConnect(true);
  await settle(2);
  h.resolveEnsure(0, INTERNAL_INFO);
  await activation;
  await settle();
  h.clients[0].emit("disconnected");
  await settle();

  const moved = { baseUrl: "http://127.0.0.1:41002/", token: "token-from-file", ownership: "self" as const };
  h.setSupervisorAlive(true);
  h.setStatusInfo(moved);
  await h.heartbeat();
  check(
    "端点变了（新端口）：心跳发起新一轮，而且仍是 start:false——只接上，不拉起",
    h.ensureCalls.length === 2 && h.ensureCalls[1].start === false && h.ensureCalls[1].target === "internal",
    JSON.stringify(h.ensureCalls),
  );
  h.resolveEnsure(1, moved);
  await settle(6);
  check(
    "旧客户端被收掉、另起了第二个（换地址 = 上一条不再作数）",
    h.clients.length === 2 && h.clients[0].disposed === 1,
    `clients=${h.clients.length} disposed=${h.clients[0].disposed}`,
  );
  check("新一轮按新地址落地", h.internals.connection === "connected", h.internals.connection);
  h.controller.stopReconnect();
  await settle(2);
}

// ---------- 九、用户在激活期选路落地前就停过：迟到的自动选路让位 ----------
{
  // 甲：停止发生在激活期那次调用**之前**（`startup()` 要等清文档锁，用户手更快）
  const h = makeHarness({ supervisorAlive: false });
  h.controller.stopServer();
  await settle(2);
  const activation = h.controller.autoConnect(true);
  await settle(4);
  check(
    "用户抢先停过：迟到的激活期选路让位（一次 ensure 都没有，绝不把刚停的后台拉回来）",
    h.ensureCalls.length === 0,
    JSON.stringify(h.ensureCalls),
  );
  const again = h.controller.connectInternal();
  await settle(2);
  check(
    "……用户随后显式连接内部仍照常发起（start:true）",
    h.ensureCalls.length === 1 && h.ensureCalls[0].start === true,
    JSON.stringify(h.ensureCalls),
  );
  h.resolveEnsure(0, INTERNAL_INFO);
  await again;
  await activation;
  await settle(4);
  h.controller.stopReconnect();
  await settle(2);
}
{
  // 乙：停止发生在**探测等待中**（两轴探测要发一次 HTTP，用户就在那一下点了停止）
  const h = makeHarness({ supervisorAlive: false });
  h.holdProbe();
  const activation = h.controller.autoConnect(true);
  await settle(2);
  h.controller.stopReconnect();
  await settle(2);
  h.releaseProbe();
  await activation;
  await settle(4);
  check(
    "探测期间用户点过「停止连接」：迟到的选路让位（0 ensure）",
    h.ensureCalls.length === 0,
    JSON.stringify(h.ensureCalls),
  );
  check("……目标也没被它写下去", h.internals.target === undefined, JSON.stringify(h.internals.target));
}

// ---------- 十、自动补壳在等激活期时用户点「+」：显式请求能把这一轮升档 ----------
{
  const h = makeHarness({ supervisorAlive: false });
  h.setWorkspaceDir(CWD);
  h.internals.bindView("v1");
  h.holdProbe();
  const activation = h.controller.autoConnect(true); // 激活期卡在探测里
  await settle(2);

  const ready = h.internals.handle({ type: "ready" }, "v1"); // 自动补壳：等激活期那次连接
  await settle(4);
  check("前置：自动补壳在等激活期，自己没发起 ensure", h.ensureCalls.length === 0, JSON.stringify(h.ensureCalls));

  const userNew = h.controller.newSession("v1"); // 用户点「+」
  await settle(2);
  check(
    "用户显式新建把在飞的自动补壳**升档**：发出的是 start:true（改前会并进自动的 start:false，按钮就按不动了）",
    h.ensureCalls.length === 1 && h.ensureCalls[0].start === true && h.ensureCalls[0].target === "internal",
    JSON.stringify(h.ensureCalls),
  );
  check("……并且记下了「用户动过连接」", h.internals.userChoseConnection, String(h.internals.userChoseConnection));

  h.resolveEnsure(0, INTERNAL_INFO);
  await settle(6);
  h.releaseProbe();
  await activation;
  await userNew;
  await ready;
  await settle(8);
  check(
    "用户的新建落地：窗口绑到一条会话上（不是空等）",
    h.internals.viewSessions.get("v1") !== undefined,
    String(h.internals.viewSessions.get("v1")),
  );
}

// ---------- 十一、恢复在等连接期间用户自己选了：迟到的恢复不许盖掉他 ----------
{
  const OTHER = "session-other";
  const h = makeHarness({
    supervisorAlive: false,
    seed: [
      { sessionId: HISTORY, blank: false },
      { sessionId: OTHER, blank: false },
    ],
  });
  h.setWorkspaceDir(CWD);
  h.internals.bindView("v1");
  h.internals.restoreHints.set("v1", { sessionId: HISTORY });

  h.holdProbe();
  const activation = h.controller.autoConnect(true);
  await settle(2);
  const ready = h.internals.handle({ type: "ready" }, "v1"); // 认领 hint，卡在等激活期连接
  await settle(4);
  check(
    "前置：恢复还在等连接（hint 已认领、还没有落地）",
    !h.internals.restoreHints.has("v1") && h.internals.viewSessions.get("v1") === undefined,
    `hint=${h.internals.restoreHints.has("v1")} view=${String(h.internals.viewSessions.get("v1"))}`,
  );

  const userNew = h.controller.newSession("v1"); // 用户此刻自己点了「+」（显式选择）
  await settle(2);
  h.resolveEnsure(0, INTERNAL_INFO);
  await settle(6);
  h.releaseProbe();
  await activation;
  await ready;
  await userNew;
  await settle(8);

  check(
    "迟到的恢复作废：窗口没有被拉回那条历史会话",
    h.internals.viewSessions.get("v1") !== HISTORY && h.internals.viewSessions.get("v1") !== undefined,
    String(h.internals.viewSessions.get("v1")),
  );
  check("恢复也不再挂在账上（认领已收口）", !h.internals.restoreHints.has("v1"));
}

if (failures > 0) {
  console.error(`\n✗ 自动连接只在扩展启动时做一次：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 自动连接只在扩展启动时做一次（重复调用只一条链 / 关掉不自动连 / 迟到选路让位 / 用户先停则一次都不连 / 普通断连按原目标接着接、绝不重建与拉起 / 热配置不触发连接 / 已知终结才回按钮态 / 换端点才重建 / ready 早于连接仍能接回历史会话 / 自动补壳不压用户动作 / 迟到的恢复作废）全通过",
  );
  assert.ok(true);
}
