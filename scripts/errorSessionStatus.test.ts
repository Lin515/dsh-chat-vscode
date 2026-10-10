/**
 * 报错会话的运行与未读状态回归：直接驱动 `ChatController`，离线、无网络。
 *
 * 保留 ADR 0003 的合法语义：离开时显示生成中，随后收尾且无人查看时标为未读；
 * 错误收尾同样属于收尾。开放轮次等待审批时仍保留运行状态。
 *
 * 已复现的两条缺陷：
 * - 跟随流的 error/end 不会关闭 socket，旧实现未重开该流，适配器会保留旧开放轮次，
 *   导致后续权威 false 被拒收，无法接收 durable 收尾。
 * - 提交失败时旧实现无条件清除域上的运行状态，覆盖已有或等待期间到达的 durable 证据；
 *   域、界面与列表因此不一致，隐藏的子代理会话还可能丢失离开标记。
 *
 * 断言覆盖合法对照、流恢复、旧回调隔离、重试上限与清理、提交失败和模型等待边界。
 * vscode 依赖通过 esbuild.scripts.mjs 的 alias 指向 `vscodeTestStub.ts`。
 * 测试包含跟随流退避等待，整体约十秒，不依赖临时探针。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[errorSessionStatus] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");

const A = "session-aaaa";
const B = "session-bbbb";
const SUB = "session-sub1";
const PARENT = "session-par1";
const CWD = "D:/tmp/error-session-status-ws";

interface Row {
  sessionId: string;
  cwd: string;
  updatedAt: number;
  running: boolean;
}

const row = (sessionId: string, running = false): Row => ({ sessionId, cwd: CWD, updatedAt: 1, running });

interface Captured {
  target: "all" | string;
  frame: Record<string, unknown>;
}

type SessionRowView = { id: string; running: boolean; unread?: boolean };

/** 受控的「正在飞的 promise」：`prompt` / `promptSubagent` 用它模拟慢提交与失败。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    // 删键 = 写 `undefined`（与 VS Code 的 Memento 同口径，见 `dsh/unreadStore.ts`）
    update: async (key: string, value: unknown) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

/** 只看**最新一帧**该窗口收得到的会话列表（口径同 `scripts/unreadMarker.test.ts`）。 */
function rowOf(frames: Captured[], sessionId: string, viewId = "v1"): SessionRowView | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (frame.type !== "sessions") continue;
    if (target !== "all" && target !== viewId) continue;
    const rows = (frame.sessions ?? []) as SessionRowView[];
    return rows.find((item) => item.id === sessionId);
  }
  return undefined;
}

/** 界面口径的「在不在跑」：发给本窗口最后一条带 running 的 patch / state 帧。 */
function displayedRunning(frames: Captured[], viewId = "v1"): boolean | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== "all" && target !== viewId) continue;
    if (frame.type === "patch") {
      const patch = frame.patch as { running?: unknown } | undefined;
      if (typeof patch?.running === "boolean") return patch.running;
    }
    if (frame.type === "state") {
      const state = frame.state as { running?: unknown } | undefined;
      if (typeof state?.running === "boolean") return state.running;
    }
  }
  return undefined;
}

interface FollowCall {
  sessionId: string;
  onItem(value: unknown): void;
  onError?(error: unknown): void;
  /** 服务端把这条流**正常结束**（`frame.type === 'end'`）时客户端调的就是它。 */
  onEnd?(): void;
  cancelled: boolean;
}

interface Internals {
  client: unknown;
  connection: string;
  scopes: Map<
    string,
    {
      running: boolean;
      pendingModel?: unknown;
      adapter?: { applyEvent(event: unknown): void; hasOpenTurn(): boolean };
    }
  >;
  leftGeneratingSessionIds: Set<string>;
  pendingStatuses: Map<string, boolean>;
  unreadSessionIds: Set<string>;
  onEventFrame(frame: Record<string, unknown>): Promise<void>;
  onConnected(): Promise<void>;
  bindView(viewId: string): void;
  openSession(viewId: string, sessionId: string, subagent?: unknown): Promise<void>;
  newSession(viewId: string): Promise<void>;
  unbindView(viewId: string): void;
  refreshSessions(): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  isSessionGenerating(sessionId: string | undefined): boolean;
  openScopeFollow(scope: unknown): void;
  teardownStreams(): void;
  applyPendingModel(scope: unknown): Promise<void>;
}

type TurnKind = "completed" | "error";

interface Harness {
  api: {
    open(viewId: string, sessionId: string, subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" }): Promise<void>;
    leave(viewId: string, sessionId: string): Promise<void>;
    detach(viewId: string): Promise<void>;
    unbind(viewId: string): void;
    bind(viewId: string): void;
    refresh(): Promise<void>;
    send(viewId: string, text: string): Promise<unknown>;
    rejectPrompt(error: unknown): void;
    resolvePrompt(): void;
    /** `$events` 上的权威状态位。 */
    status(sessionId: string, running: boolean): Promise<void>;
    /** durable 轮次边界（走真适配器）。 */
    turn(sessionId: string, type: "turn/start" | "turn/end", turnNo: number, kind?: TurnKind): void;
    /** 模拟 `session/follow` **单流**失败（帧 error / 流结束，不是 socket 断开）。 */
    failFollow(sessionId: string): void;
    /** 模拟服务端把这条流**正常结束**（`frame.type === 'end'`）——客户端调的是 `onEnd`。 */
    endFollow(sessionId: string): void;
    /** 该会话历次开流的回调（按顺序），用来模拟「旧流迟到的 error / item」。 */
    followCalls(sessionId: string): FollowCall[];
    /** 下一次开这条流时**同步**触发 onError（替身；真客户端的回调恒为异步）。 */
    syncFollowErrorOnOpen(sessionId: string, enabled: boolean): void;
    /** 直接按当前域重开这条跟随流（模拟「句柄被替换」的竞态，不走 `onConnected` 清场）。 */
    reopenFollow(sessionId: string): void;
    /** 模拟 socket 重连成功（`onConnected`：重开全部域的流）。 */
    reconnect(): Promise<void>;
    /** 模拟连接收线（`teardownStreams`：只取消句柄，域保留）。 */
    teardown(): void;
    /** 重开时服务端会重放的 durable 记录。 */
    setReplay(sessionId: string, events: Record<string, unknown>[]): void;
    /** 带手势（`enter` / `accelerated`）发一条消息：`session/prompt.mode` 的判据要用到它。 */
    sendWithGesture(viewId: string, text: string, gesture: "enter" | "accelerated"): Promise<unknown>;
    /** 各次 `session/prompt` 用的 `mode`（按调用顺序）。 */
    modes(): (string | undefined)[];
    /** 让「下一轮要用的模型」有待应用值：`send` 会先 `await applyPendingModel`。 */
    setPendingModel(sessionId: string): void;
    /** 在飞的那次 `selectModel` 成功返回。 */
    releaseSelectModel(): void;
    /** 把 `applyPendingModel` 换成一个注入实现（故障注入：这一步的异常会逃到 `send` 的 catch）。 */
    injectApplyPendingModel(run: (scope: unknown) => Promise<void>): void;
    /** 恢复真实的 `applyPendingModel`。 */
    restoreApplyPendingModel(): void;
  };
  observe(sessionId: string): {
    scopeRunning: boolean | undefined;
    scopeAlive: boolean;
    openTurn: boolean;
    rowRunning: boolean | undefined;
    displayed: boolean | undefined;
    generating: boolean;
    marker: boolean;
    pending: boolean | undefined;
    unread: boolean;
    unreadAccount: boolean;
  };
  /** 服务端 `session/list` 的那份行（可变：重连后列表是权威值）。 */
  rows: Row[];
  followsFor(sessionId: string): number;
  /** 该会话的跟随流重试状态（计数 + 有没有待触发的重开）。 */
  retryState(sessionId: string): { count: number; timer: boolean };
}

function makeHarness(rows: Row[]): Harness {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame }));
  const internals = controller as unknown as Internals;
  const follows: FollowCall[] = [];
  const replays = new Map<string, Record<string, unknown>[]>();
  const syncErrorOnOpen = new Set<string>();
  const modes: (string | undefined)[] = [];
  let live: ReturnType<typeof deferred<{ requestId: string }>> | undefined;
  let liveModel: ReturnType<typeof deferred<void>> | undefined;
  const realApplyPendingModel = internals.applyPendingModel.bind(controller);
  internals.client = {
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
    /** 「下一轮要用的模型」真要 selectModel 时才走这里：受控在飞，供 await 期间插事件。 */
    selectModel() {
      liveModel = deferred<void>();
      return liveModel.promise;
    },
    prompt(_sessionId: string, _content: unknown, mode?: string) {
      modes.push(mode);
      live = deferred<{ requestId: string }>();
      return live.promise;
    },
    promptSubagent(_parent: string, _sessionId: string, _content: unknown, mode?: string) {
      modes.push(mode);
      live = deferred<{ requestId: string }>();
      return live.promise;
    },
    followSession(
      sessionId: string,
      callbacks: { onItem(value: unknown): void; onError?(error: unknown): void; onEnd?(): void },
    ) {
      const call: FollowCall = {
        sessionId,
        onItem: callbacks.onItem,
        onError: callbacks.onError,
        onEnd: callbacks.onEnd,
        cancelled: false,
      };
      follows.push(call);
      const opened = follows.filter((item) => item.sessionId === sessionId).length;
      const replay = replays.get(sessionId);
      // 重开的那几次：服务端按当前日志重放窗口（含已落盘的 turn/end）
      if (opened > 1 && replay?.length) {
        queueMicrotask(() =>
          callbacks.onItem({
            type: "snapshot",
            cursor: 9_999,
            hasMore: false,
            records: replay.map((event) => ({ type: "event", event })),
          }),
        );
      }
      // 替身：同步回调（真客户端恒为异步，见 client.ts 的 `openStream` 只登记回调）；
      // 用来钉「同步回调 + 句柄随后被替换」时旧重开不许靠 undefined 绕过身份检查。
      if (syncErrorOnOpen.has(sessionId)) callbacks.onError?.({ code: "gateway/internal", message: "sync failure" });
      return {
        cancel: () => {
          call.cancelled = true;
        },
      };
    },
    followJobs() {
      return { cancel() {} };
    },
    followControl() {
      return { cancel() {} };
    },
    // 下面这几个只有「重连」（`onConnected`）那条路会碰：够用就行，行为不影响本文件断言
    openEvents() {
      return { cancel() {} };
    },
    openStream() {
      return { cancel() {} };
    },
    async listAgentPresets() {
      return { presets: [] };
    },
    async permissionCatalog() {
      return undefined;
    },
    async modelCatalog() {
      return { models: [] };
    },
  } as never;
  internals.connection = "connected";
  internals.bindView("v1");

  let turnSeq = 100;
  const api: Harness["api"] = {
    open: (viewId, sessionId, subagent) => internals.openSession(viewId, sessionId, subagent),
    leave: (viewId, sessionId) => internals.openSession(viewId, sessionId),
    detach: (viewId) => internals.newSession(viewId),
    unbind: (viewId) => internals.unbindView(viewId),
    bind: (viewId) => internals.bindView(viewId),
    refresh: () => internals.refreshSessions(),
    send: (viewId, text) => internals.handle({ type: "send", text, attachments: [], gesture: "enter" }, viewId),
    rejectPrompt: (error) => {
      if (!live) throw new Error("没有在飞的 prompt");
      live.reject(error);
    },
    resolvePrompt: () => {
      if (!live) throw new Error("没有在飞的 prompt");
      live.resolve({ requestId: "r" });
    },
    status: (sessionId, running) =>
      internals.onEventFrame({ type: "emit", event: "api-session/status", args: [sessionId, running] }),
    turn: (sessionId, type, turnNo, kind) => {
      turnSeq += 1;
      internals.scopes.get(sessionId)?.adapter?.applyEvent({
        type,
        seq: turnSeq,
        time: turnSeq * 1000,
        data:
          type === "turn/end"
            ? { turn: turnNo, reason: kind === "error" ? { kind, error: { message: "boom" } } : { kind: kind ?? "completed" } }
            : { turn: turnNo },
      });
    },
    failFollow: (sessionId) => {
      // 真实路径：客户端收到单流 error 帧后调 `stream.onError`（socket 不关，不触发重连）
      [...follows].reverse().find((item) => item.sessionId === sessionId)?.onError?.({ code: "gateway/internal", message: "stream failed" });
    },
    endFollow: (sessionId) => {
      // 真实路径：`frame.type === 'end'`（client.ts 的 ws.on("message")）只调 `stream.onEnd`
      [...follows].reverse().find((item) => item.sessionId === sessionId)?.onEnd?.();
    },
    followCalls: (sessionId) => follows.filter((item) => item.sessionId === sessionId),
    syncFollowErrorOnOpen: (sessionId, enabled) => {
      if (enabled) syncErrorOnOpen.add(sessionId);
      else syncErrorOnOpen.delete(sessionId);
    },
    reopenFollow: (sessionId) => {
      const scope = internals.scopes.get(sessionId);
      if (scope) internals.openScopeFollow(scope);
    },
    reconnect: () => internals.onConnected(),
    teardown: () => internals.teardownStreams(),
    setReplay: (sessionId, events) => replays.set(sessionId, events),
    sendWithGesture: (viewId, text, gesture) =>
      internals.handle({ type: "send", text, attachments: [], gesture }, viewId),
    modes: () => modes,
    setPendingModel: (sessionId) => {
      const scope = internals.scopes.get(sessionId);
      // 形状够 `applyPendingModel` 用（provider / model / reasoningEffort）
      if (scope) scope.pendingModel = { provider: "p", model: "m", label: "M" };
    },
    releaseSelectModel: () => {
      if (!liveModel) throw new Error("没有在飞的 selectModel");
      liveModel.resolve();
    },
    injectApplyPendingModel: (run) => {
      internals.applyPendingModel = (scope: unknown) => run(scope);
    },
    restoreApplyPendingModel: () => {
      internals.applyPendingModel = realApplyPendingModel;
    },
  };
  return {
    api,
    rows,
    followsFor: (sessionId) => follows.filter((item) => item.sessionId === sessionId).length,
    retryState: (sessionId) => {
      const internalsState = controller as unknown as {
        followRetries: Map<string, number>;
        followRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
      };
      return {
        count: internalsState.followRetries.get(sessionId) ?? 0,
        timer: internalsState.followRetryTimers.has(sessionId),
      };
    },
    observe: (sessionId) => ({
      scopeRunning: internals.scopes.get(sessionId)?.running,
      scopeAlive: internals.scopes.has(sessionId),
      openTurn: internals.scopes.get(sessionId)?.adapter?.hasOpenTurn() === true,
      rowRunning: rowOf(frames, sessionId)?.running,
      displayed: displayedRunning(frames),
      generating: internals.isSessionGenerating(sessionId),
      marker: internals.leftGeneratingSessionIds.has(sessionId),
      pending: internals.pendingStatuses.get(sessionId),
      unread: rowOf(frames, sessionId)?.unread === true,
      unreadAccount: internals.unreadSessionIds.has(sessionId),
    }),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function harnessWith(rows: Row[] = [row(A), row(B)]): Promise<Harness> {
  const harness = makeHarness(rows);
  await harness.api.refresh();
  return harness;
}

console.log("errorSessionStatus: 驱动真控制器（offline stub）");

// ---------- ① 产品语义（合法正例）：离开时界面说它在生成，报错收尾没人看 → 未读 ----------
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  api.turn(A, "turn/start", 1);
  await api.leave("v1", B); // 切走 = 离开生成中的 A
  await api.status(A, false); // 报错 / 收尾的权威值落地
  const seen = observe(A);
  assert.strictEqual(seen.marker, true, "离开时它在生成：必须记离开标记");
  assert.strictEqual(seen.unread, true, "收尾时没人看着它：亮未读（报错收尾同样是收尾）");
  console.log("  ① 离开生成中 + 收尾落地 → 未读（产品语义）✓");
}

// ---------- ② 产品语义（合法正例）：离开时它空闲，之后才跑起来 → 不未读 ----------
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.leave("v1", B);
  await api.status(A, true);
  await api.status(A, false);
  const seen = observe(A);
  assert.strictEqual(seen.marker, false, "离开时它没在生成：不许留标记");
  assert.strictEqual(seen.unread, false, "别处跑起来的会话跑完不该亮蓝");
  console.log("  ② 空闲时离开、之后才收尾 → 不未读 ✓");
}

// ---------- ③ 误判防线：看着 durable 报错收尾之后再离开，三个入口都不许留标记 ----------
{
  for (const entry of ["switch", "detach", "unbind"] as const) {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", A);
    await api.status(A, true);
    api.turn(A, "turn/start", 1);
    api.turn(A, "turn/end", 1, "error"); // durable 报错收尾：行与域都回落空闲
    assert.strictEqual(observe(A).rowRunning, false, `[${entry}] durable 报错收尾必须把那一行改回空闲`);
    if (entry === "switch") await api.leave("v1", B);
    else if (entry === "detach") await api.detach("v1");
    else api.unbind("v1");
    await api.refresh();
    const seen = observe(A);
    assert.strictEqual(seen.marker, false, `[${entry}] 离开时它已经收尾：不许记标记`);
    assert.strictEqual(seen.unread, false, `[${entry}] 更不许亮未读`);
  }
  console.log("  ③ 看着报错收尾后再离开（三入口）→ 不未读 ✓");
}

// ---------- ④ 误判防线：被拒收的权威 false + durable 报错收尾先到 → 离开不留标记 ----------
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  api.turn(A, "turn/start", 1);
  await api.status(A, false); // 权威值先到：本地还有开放轮次 → 被拒收、记账（规则本身没错）
  assert.strictEqual(observe(A).rowRunning, true, "前置：被拒收那一刻界面上仍是生成中");
  api.turn(A, "turn/end", 1, "error"); // durable 收尾：这才是权威
  await api.leave("v1", B);
  await api.refresh();
  const seen = observe(A);
  assert.strictEqual(seen.marker, false, "durable 已经收尾：离开时它不再生成");
  assert.strictEqual(seen.unread, false, "那条更正不该顺带亮未读");
  console.log("  ④ 权威 false 被拒收 → durable 报错收尾 → 离开：不未读 ✓");
}

// ---------- ⑤ 合法等待对照（ADR 0003）：被拒收的权威 false + 离开后仍留着标记 ----------
// ADR 明说「本地有开放轮次时服务端那句不在跑不被采信……此时离开照样记标记」，标记一直留到
// 用户回来看过——所以在这段窗口里离开，界面上是标记态（还不是未读），之后它再收尾一次才亮，
// 这是**合法等待**、不是延迟误亮。这里把口径钉成断言（不是把红了的东西改绿：这条语义一直成立）。
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  api.turn(A, "turn/start", 1);
  await api.status(A, false); // 被拒收（本地仍有开放轮次）
  await api.leave("v1", B); // 正好在这段窗口里离开
  await api.refresh();
  const left = observe(A);
  assert.strictEqual(left.marker, true, "离开时界面显示生成中：按 ADR 记离开标记");
  await api.status(A, true);
  await api.status(A, false);
  const after = observe(A);
  assert.strictEqual(after.unread, true, "标记活到用户回来看过为止：之后那次收尾亮未读");
  await api.open("v1", A); // 回来看它
  const read = observe(A);
  assert.strictEqual(read.unread, false, "看过了：未读与标记一起结束");
  assert.strictEqual(read.marker, false, "标记也随这次回来作废");
  console.log("  ⑤ 合法等待：标记留到「回来看过」为止 ✓");
}

// ---------- ⑥ 单流失败必须重开：其后权威「不在跑」必须被采纳 ----------
// 单流 error/end 不触发 socket close ⇒ `onConnected` 不跑；onError 不重开的话适配器永远
// 停在旧态、`hasOpenTurn()` 永远为真，此后每条权威 false 都被拒收——界面一直「生成中」。
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  const startSeq = 100 + 1;
  api.turn(A, "turn/start", 1);
  const openedBefore = harness.followsFor(A);
  // 重开时服务端会重放的窗口：这一轮已经以报错落盘收尾
  api.setReplay(A, [
    { type: "turn/start", seq: startSeq, time: startSeq * 1_000, data: { turn: 1 } },
    { type: "turn/end", seq: startSeq + 1, time: (startSeq + 1) * 1_000, data: { turn: 1, reason: { kind: "error" } } },
  ]);
  api.failFollow(A);
  await delay(600); // 给重开的退避留出时间
  assert.ok(
    harness.followsFor(A) > openedBefore,
    "session/follow 单流失败后必须重开这条流（DshClient 的契约：断开由调用方 onError 重开）",
  );
  await api.status(A, false); // 服务端权威：不在跑了
  const seen = observe(A);
  assert.strictEqual(seen.openTurn, false, "重开的新快照重放了 turn/end：本地不该再认为有开放轮次");
  assert.strictEqual(seen.rowRunning, false, "权威「不在跑」必须被采纳：列表那一行回落空闲");
  assert.strictEqual(seen.generating, false, "不许再停在「生成中」");
  assert.strictEqual(seen.scopeRunning, false, "域也必须回落空闲");
  console.log("  ⑥ 单流失败后重开、权威值被采纳 ✓");
}

// ---------- ⑥-b 每一次**新开出的**流都失败：重开次数必须恰好封顶 ----------
// 判据是「新开的流也失败」——只对同一条已经死掉的流反复报错，只会不断替换那个还没触发的
// 定时器，删掉上限逻辑也照样「通过」。这里用同步回调替身让每一次新开流都当场失败，
// 于是重开链真的走完 1 次首发 + 5 次重开，之后再失败也不再开流；一份完整快照成功清零后，
// 重试能力恢复（上限是「连续」失败的上限，不是终身配额）。
{
  const harness = await harnessWith();
  const { api } = harness;
  api.syncFollowErrorOnOpen(A, true); // 每一新开的流都当场失败
  await api.open("v1", A);
  // 退避链：150 + 300 + 450 + 600 + 750 ms = 2250ms 走完 1+5 次；再多等一个重开周期
  // （上限之外的第一次重开落在 2250 + 900 = 3150ms）——上限失效时这里会多出一条流。
  await delay(3_600);
  assert.strictEqual(
    harness.followsFor(A),
    1 + 5,
    `首发 1 条 + 至多 5 次重开：必须恰好 6 条（实际 ${harness.followsFor(A)} 条）`,
  );
  assert.strictEqual(harness.retryState(A).timer, false, "到上限后不许再排新的重开");
  await delay(1_000);
  assert.strictEqual(harness.followsFor(A), 1 + 5, "过了上限不许再开流");
  assert.strictEqual(harness.observe(A).scopeAlive, true, "重试上限只影响跟随流，不许动域");

  // 一份完整快照 = 这条流真的活着：计数清零，此后可以重新开始重试
  api.syncFollowErrorOnOpen(A, false);
  api.followCalls(A).at(-1)?.onItem({ type: "snapshot", cursor: 1, hasMore: false, records: [] });
  assert.strictEqual(harness.retryState(A).count, 0, "完整快照到达即清零连续失败计数");
  assert.strictEqual(harness.retryState(A).timer, false, "清零时也不该留着待触发的重开");
  const beforeRetry = harness.followsFor(A);
  api.failFollow(A); // 清零之后再失败：应当允许重开
  await delay(400);
  assert.strictEqual(harness.followsFor(A), beforeRetry + 1, "清零之后重试能力恢复");
  console.log("  ⑥-b 每次新开流都失败：恰好 1+5 次重开、快照清零后可再重试 ✓");
}

// ---------- ⑥-c 域已回收：旧流迟到的 error 不许重开、不许复活域 ----------
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  api.turn(A, "turn/start", 1);
  const stale = api.followCalls(A).at(-1);
  await api.leave("v1", B); // 离开：域被回收，跟随流被 cancel
  assert.strictEqual(observe(A).scopeAlive, false, "前置：域已回收");
  stale?.onError?.({ code: "stream/socket-closed", message: "连接已断开" });
  await delay(600);
  assert.strictEqual(harness.followsFor(A), 1, "域没了就不许再开流（那会产生一条没有收件人的流）");
  assert.strictEqual(observe(A).scopeAlive, false, "更不许把域复活");
  console.log("  ⑥-c 域回收后旧 error 不重开、不复活 ✓");
}

// ---------- ⑥-d 被替换掉的旧流：迟到的 error / item 都不许复活旧流或污染新适配器 ----------
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  const startSeq = 100 + 1;
  api.turn(A, "turn/start", 1);
  const stale = api.followCalls(A).at(-1);
  // 重连：换一条新流，新快照重放「这一轮还开着」；重连时列表那一行也是权威值
  harness.rows[0].running = true;
  api.setReplay(A, [{ type: "turn/start", seq: startSeq, time: startSeq * 1_000, data: { turn: 1 } }]);
  await api.reconnect();
  await delay(50);
  const openedAfterReconnect = harness.followsFor(A);
  assert.strictEqual(openedAfterReconnect, 2, "重连必须重开这条流");
  assert.strictEqual(observe(A).rowRunning, true, "新快照重放的是开放轮次：仍是运行中");
  // 旧流迟到的 error：不许再排一次重开
  stale?.onError?.({ code: "gateway/internal", message: "stream failed" });
  await delay(600);
  assert.strictEqual(harness.followsFor(A), 2, "旧流的迟到 error 不许再开一条流");
  // 旧流迟到的 item：不许写进新适配器（否则会把已经重算好的状态盖回去）
  stale?.onItem?.({
    type: "event",
    event: { type: "turn/end", seq: startSeq + 1, time: (startSeq + 1) * 1_000, data: { turn: 1, reason: { kind: "error" } } },
  });
  await delay(20);
  assert.strictEqual(observe(A).rowRunning, true, "旧流迟到的收尾事件不许污染新适配器");
  assert.strictEqual(observe(A).scopeRunning, true, "域也不许被旧流改写");
  console.log("  ⑥-d 旧流迟到 error/item 不复活、不污染 ✓");
}

// ---------- ⑥-e 重连清掉还没触发的旧重开（跨重连的 timer 不许再开流） ----------
{
  const harness = await harnessWith();
  const { api } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  api.turn(A, "turn/start", 1);
  api.failFollow(A); // 排下一次重开（150ms 后）
  api.failFollow(A); // 再失败一次，替换掉上一次还没触发的重开
  await api.reconnect(); // 重连：重试状态必须一并作废
  await delay(50);
  const afterReconnect = harness.followsFor(A);
  assert.strictEqual(afterReconnect, 2, "重连本身重开一次");
  await delay(900); // 旧 timer 若还活着，这里会多开一条
  assert.strictEqual(harness.followsFor(A), afterReconnect, "跨重连的旧重开必须失效");
  console.log("  ⑥-e 重连作废未触发的旧重开 ✓");
}

// ---------- ⑥-f 服务端**正常结束**这条流（socket 仍连着）也必须重开 ----------
// `client.ts` 的 `ws.on("message")` 里 `frame.type === 'end'` 只调 `stream.onEnd`，
// **不调** `onError`——所以只注册 onError 的实现对「流被正常结束」这条路径完全没有恢复：
// 适配器停在旧态、`hasOpenTurn()` 永远真，界面一直显示生成中。
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  const startSeq = 100 + 1;
  api.turn(A, "turn/start", 1);
  const openedBefore = harness.followsFor(A);
  // 重开时服务端重放的窗口：这一轮已经以报错落盘收尾
  api.setReplay(A, [
    { type: "turn/start", seq: startSeq, time: startSeq * 1_000, data: { turn: 1 } },
    { type: "turn/end", seq: startSeq + 1, time: (startSeq + 1) * 1_000, data: { turn: 1, reason: { kind: "error" } } },
  ]);
  api.endFollow(A); // 服务端正常结束这条流（不是 error）
  await delay(600);
  assert.ok(
    harness.followsFor(A) > openedBefore,
    "session/follow 被服务端**正常结束**（onEnd）后同样必须重开这条流",
  );
  await api.status(A, false);
  const seen = observe(A);
  assert.strictEqual(seen.openTurn, false, "重开的新快照重放了 turn/end：本地不该再认为有开放轮次");
  assert.strictEqual(seen.rowRunning, false, "权威「不在跑」必须被采纳");
  assert.strictEqual(seen.generating, false, "不许再停在「生成中」");
  console.log("  ⑥-f onEnd（正常结束）后重开、权威值被采纳 ✓");
}

// ---------- ⑥-g（负对照）同步回调替身：句柄被替换后旧重开不许靠 undefined 绕过身份 ----------
// 真客户端的回调恒为异步（`openStream` 只登记回调，触发点都在 ws 事件里），所以这里用替身
// 制造「开流调用还没返回就同步报错」的极端时序——旧 timer 捕获的 handle 还是 undefined，
// 若把 undefined 当作通过条件，它就会在句柄已被新的一次开流替换之后再开一条流。
{
  const harness = await harnessWith();
  const { api } = harness;
  api.syncFollowErrorOnOpen(A, true);
  await api.open("v1", A); // 开流时同步 onError → 排下一次重开（150ms 后）
  api.syncFollowErrorOnOpen(A, false);
  assert.strictEqual(harness.followsFor(A), 1, "前置：只有一次开流");
  api.reopenFollow(A); // 同 client / 同域，句柄被新的一次开流替换
  assert.strictEqual(harness.followsFor(A), 2, "前置：替换已发生");
  await delay(500); // 旧 timer 到点
  assert.strictEqual(harness.followsFor(A), 2, "句柄已被替换：旧 timer 不许再开第三条流");
  console.log("  ⑥-g 同步回调 + 句柄替换：旧重开不越权 ✓");
}

// ---------- ⑥-h 连接收线（teardownStreams）必须清掉重试状态，并让旧回调失效 ----------
// `teardownStreams` 只取消句柄、把 `scope.followHandle` 置空，域对象照旧留在 `scopes` 里。
// 两条判据都要钉：
// ① **真实清理**：该会话的重开计数与待触发的定时器必须当场清掉（否则换连接 / 停用之后
//    仍会保留一份按域排定的重开计划）；
// ② **旧回调失效**：收线之后，旧流迟到的 error / end 不许再开流（句柄已取消、开流代号
//    也不再是它的那一次）。
{
  const harness = await harnessWith();
  const { api } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  api.turn(A, "turn/start", 1);
  const stale = api.followCalls(A).at(-1);
  api.failFollow(A); // 排下一次重开（150ms 后）
  const opened = harness.followsFor(A);
  assert.strictEqual(harness.retryState(A).timer, true, "前置：确实排下了待触发的重开");
  api.teardown(); // 收线：取消句柄
  assert.strictEqual(harness.retryState(A).timer, false, "收线要当场清掉待触发的重开定时器");
  assert.strictEqual(harness.retryState(A).count, 0, "收线要当场清掉连续失败计数");
  stale?.onError?.({ code: "stream/socket-closed", message: "连接已断开" });
  stale?.onEnd?.();
  await delay(500); // 旧定时器若还在，这里会多开一条流
  assert.strictEqual(harness.followsFor(A), opened, "收线之后旧流的迟到回调不许再开流");
  console.log("  ⑥-h 收线清掉重试状态、旧回调失效 ✓");
}

// ---------- ⑥-i 开流代号不许复用：收线 + 重连之后，收线前那条流的回调必须彻底失效 ----------
// 收线只取消句柄、域对象照旧留在 `scopes` 里；重连会按**同一个域对象**再开一条流。
// 若代号按会话从 0 重新发号（收线时删掉、重连又发到 1），收线前那条流的迟到 item / error /
// end 就会与新流撞上同一个代号，从而改写新适配器、或再排一次重开。
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  await api.status(A, true);
  const startSeq = 100 + 1;
  api.turn(A, "turn/start", 1);
  const stale = api.followCalls(A).at(-1); // 收线之前那一次开流
  api.teardown();
  harness.rows[0].running = true; // 重连时列表那一行也是权威值
  api.setReplay(A, [{ type: "turn/start", seq: startSeq, time: startSeq * 1_000, data: { turn: 1 } }]);
  await api.reconnect(); // 同一个客户端、同一个域对象：新开一条流
  await delay(50);
  assert.strictEqual(harness.followsFor(A), 2, "前置：重连重开了一条新流");
  assert.strictEqual(observe(A).rowRunning, true, "前置：新快照重放的是开放轮次");
  // 收线前那条流迟到的 item：不许改写新适配器
  api.followCalls(A)[0]?.onItem?.({
    type: "event",
    event: { type: "turn/end", seq: startSeq + 1, time: (startSeq + 1) * 1_000, data: { turn: 1, reason: { kind: "error" } } },
  });
  await delay(20);
  assert.strictEqual(observe(A).rowRunning, true, "收线前那条流的迟到 item 不许改写新域");
  // 收线前那条流迟到的 error / end：不许再排重开
  stale?.onError?.({ code: "gateway/internal", message: "stream failed" });
  stale?.onEnd?.();
  await delay(600);
  assert.strictEqual(harness.followsFor(A), 2, "收线前那条流的迟到回调不许再开流");
  console.log("  ⑥-i 收线 + 重连：旧流回调彻底失效（代号不复用）✓");
}

// ---------- ⑦ 提交失败不许覆盖肯定证据 ----------
{
  // ⑦-a 本轮真在跑（durable 开放轮次）时提交失败：域/界面/列表三个口径必须都说运行中
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", A);
    await api.status(A, true);
    api.turn(A, "turn/start", 1);
    const sending = api.send("v1", "x");
    await Promise.resolve();
    api.rejectPrompt(new Error("network down"));
    await sending;
    const seen = observe(A);
    assert.strictEqual(seen.openTurn, true, "前置：本轮真的还开着");
    assert.strictEqual(seen.scopeRunning, true, "提交失败不许覆盖 durable 证据：域必须仍是运行中");
    assert.strictEqual(seen.displayed, true, "界面同样是运行中（不能显示成空闲）");
    assert.strictEqual(seen.rowRunning, true, "列表那一行也是运行中：三个口径一致");
    console.log("  ⑦-a 真在跑时提交失败：不覆盖 durable 证据 ✓");
  }

  // ⑦-b await 期间到达的 durable turn/start 同样不许被回滚盖掉
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", A);
    const sending = api.send("v1", "x"); // 空闲提交（乐观置位）
    await Promise.resolve();
    api.turn(A, "turn/start", 1); // await 期间真的开轮了
    api.rejectPrompt(new Error("network down"));
    await sending;
    const seen = observe(A);
    assert.strictEqual(seen.scopeRunning, true, "await 期间到的 durable 证据优先于失败回滚");
    assert.strictEqual(seen.generating, true, "域与界面都不许说成空闲");
    console.log("  ⑦-b await 期间开轮 + 提交失败：durable 证据优先 ✓");
  }

  // ⑦-c 列表里没有那一行（子代理）时：离开必须留下标记，真收尾必须亮未读
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", SUB, { parentSessionId: PARENT, mode: "continuable" });
    await api.status(SUB, true);
    api.turn(SUB, "turn/start", 1);
    const sending = api.send("v1", "x");
    await Promise.resolve();
    api.rejectPrompt(new Error("network down"));
    await sending;
    assert.strictEqual(observe(SUB).rowRunning, undefined, "前置：子代理会话在会话列表里没有那一行");
    assert.strictEqual(observe(SUB).generating, true, "真在跑就不能判成空闲（域上还有开放轮次）");
    await api.leave("v1", B); // 离开子代理页
    assert.strictEqual(observe(SUB).marker, true, "离开一条真在生成的会话：必须记离开标记");
    await api.status(SUB, false); // 那一轮真的收尾
    const seen = observe(SUB);
    assert.strictEqual(seen.unreadAccount, true, "隐藏行也不许丢掉那次未读");
    console.log("  ⑦-c 子代理（隐藏行）提交失败后离开：不丢标记 ✓");
  }

  // ⑦-d 空闲提交失败：没有肯定证据 → 照旧回滚成空闲（现状正例，必须保持）
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", A);
    const sending = api.send("v1", "x");
    await Promise.resolve();
    api.rejectPrompt(new Error("network down"));
    await sending;
    const seen = observe(A);
    assert.strictEqual(seen.scopeRunning, false, "空闲提交失败：域要回落空闲");
    assert.strictEqual(seen.displayed, false, "界面也要回落空闲");
    assert.strictEqual(seen.marker, false, "没有生成过：不留标记");
    console.log("  ⑦-d 空闲提交失败：回滚成空闲 ✓");
  }

  // ⑦-e 提交前就在跑、await 期间那轮已 durable 收尾 → 失败收场必须停在空闲
  //（「提交前是 true」不是永保 true：回滚判据看的是**这一刻**的真实证据）
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", A);
    await api.status(A, true);
    api.turn(A, "turn/start", 1);
    const sending = api.send("v1", "x");
    await Promise.resolve();
    api.turn(A, "turn/end", 1, "error"); // await 期间那一轮真的以报错收尾
    api.rejectPrompt(new Error("network down"));
    await sending;
    const seen = observe(A);
    assert.strictEqual(seen.openTurn, false, "前置：durable 收尾后本地没有开放轮次");
    assert.strictEqual(seen.scopeRunning, false, "提交前的 true 不许被回滚或复活成 true");
    assert.strictEqual(seen.displayed, false, "界面必须停在空闲");
    assert.strictEqual(seen.marker, false, "已经收尾：离开也不该再记标记");
    console.log("  ⑦-e 提交前在跑、await 中收尾 + 失败：停在空闲 ✓");
  }
}

// ---------- ⑨ 提交模式的判据必须读「乐观置位那一刻」的真实 running ----------
// `resolveSubmitMode` 的输入是「手势发生时 agent 在不在跑」。发送链路里第一件事是
// `await applyPendingModel`（模型选择要落下去），这段时间里 durable 证据完全可能翻面——
// 若把 running 的读取挪到那个 await 之前，模式就会读到一个过期的值。
{
  // ⑨-a1 await 期间这一轮开始（false → true）：加速手势应判成「插话」= steer
  {
    const harness = await harnessWith();
    const { api } = harness;
    await api.open("v1", A);
    api.setPendingModel(A);
    const sending = api.sendWithGesture("v1", "x", "accelerated");
    await Promise.resolve(); // 走到 await selectModel
    api.turn(A, "turn/start", 1); // await 期间：这一轮真的开始了
    api.releaseSelectModel();
    await delay(0); // 让 send 一路走到 prompt（此时 mode 已记下）
    api.resolvePrompt();
    await sending;
    assert.strictEqual(
      api.modes().at(-1),
      "steer",
      "await 期间变成「在跑」：加速手势必须按发出去那一刻的 running 判成 steer（不得沿用提交前的旧值）",
    );
    console.log("  ⑨-a1 await 中开轮：mode 用当下 running 判 ✓");
  }

  // ⑨-a2 await 期间这一轮收尾（true → false）：加速手势应判成 queue
  {
    const harness = await harnessWith();
    const { api } = harness;
    await api.open("v1", A);
    await api.status(A, true);
    api.turn(A, "turn/start", 1); // 提交前它真的在跑
    api.setPendingModel(A);
    const sending = api.sendWithGesture("v1", "x", "accelerated");
    await Promise.resolve();
    api.turn(A, "turn/end", 1, "completed"); // await 期间收尾了
    api.releaseSelectModel();
    await delay(0); // 让 send 一路走到 prompt（此时 mode 已记下）
    api.resolvePrompt();
    await sending;
    assert.strictEqual(
      api.modes().at(-1),
      "queue",
      "await 期间已经收尾：加速手势必须按当下的空闲判成 queue",
    );
    console.log("  ⑨-a2 await 中收尾：mode 用当下 running 判 ✓");
  }

  // ⑨-b 提交在乐观置位**之前**就失败：不许动域上不是本次写的运行证据（故障注入）
  // 这一步（模型应用）失败时 `scope.running = true` 还没执行过；此刻域上的 true 来自
  // 权威状态位，把它清掉就是「替用户下结论」。判据要按「本次有没有做过乐观置位」分。
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", SUB, { parentSessionId: PARENT, mode: "continuable" });
    api.injectApplyPendingModel(async () => {
      // 这一步自己失败之前，域上出现了一条**不是本次提交写的**运行证据（权威状态位；
      // 子代理没有会话列表那一行，也没有开放轮次，所以别的证据都拿不到）
      await api.status(SUB, true);
      throw new Error("model apply failed");
    });
    await api.send("v1", "x");
    api.restoreApplyPendingModel();
    const seen = observe(SUB);
    assert.strictEqual(seen.openTurn, false, "前置：没有开放轮次");
    assert.strictEqual(seen.rowRunning, undefined, "前置：列表里没有这一行");
    assert.strictEqual(
      seen.scopeRunning,
      true,
      "本次提交还没做过乐观置位，失败收场不许清掉另一条真实运行证据",
    );
    console.log("  ⑨-b 乐观置位之前就失败：不动别人的运行证据 ✓");
  }

  // ⑨-c 等待期间收到**权威** true（值与乐观写入相同）→ 失败收场不得回滚它
  // 隐藏子代理：没有会话列表那一行、也还没有 durable 开放轮次，域上那个 true 同时来自
  // 乐观写入与权威确认——两者值相同，不能只看 `scope.running` 的布尔值，否则会把权威结论
  // 当成「本次自己写的」清掉。
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", SUB, { parentSessionId: PARENT, mode: "continuable" });
    assert.strictEqual(observe(SUB).scopeRunning, false, "前置：初始空闲");
    const sending = api.send("v1", "x"); // 乐观置位 true
    await delay(0); // 走到 await prompt
    assert.strictEqual(observe(SUB).scopeRunning, true, "前置：乐观置位后域为 true");
    assert.strictEqual(observe(SUB).openTurn, false, "前置：还没有 durable 开放轮次");
    assert.strictEqual(observe(SUB).rowRunning, undefined, "前置：隐藏行没有会话列表那一行");
    await api.status(SUB, true); // 等待期间权威确认：这一轮真的在跑
    assert.strictEqual(observe(SUB).scopeRunning, true, "前置：权威 true 已生效");
    api.rejectPrompt(new Error("network down"));
    await sending;
    assert.strictEqual(
      observe(SUB).scopeRunning,
      true,
      "等待期间收到的权威 true 不得被失败回滚覆盖",
    );
    console.log("  ⑨-c 等待期间权威 true + 提交失败：不回滚 ✓");
  }

  // ⑨-d 权威 true 之后那一轮**真的**收尾（durable turn/end）→ 失败必须停在 false
  // （不许因为「曾经收到过权威 true」就永远保留 true；判据看的是最新权威结论）
  {
    const harness = await harnessWith();
    const { api, observe } = harness;
    await api.open("v1", SUB, { parentSessionId: PARENT, mode: "continuable" });
    const sending = api.send("v1", "x");
    await delay(0);
    await api.status(SUB, true); // 等待期间：权威说在跑
    api.turn(SUB, "turn/end", 1, "error"); // 随后那一轮真的收尾了
    assert.strictEqual(observe(SUB).scopeRunning, false, "前置：durable 收尾后域已回落空闲");
    api.rejectPrompt(new Error("network down"));
    await sending;
    const seen = observe(SUB);
    assert.strictEqual(seen.scopeRunning, false, "最新权威结论是空闲：失败收场不许复活旧 true");
    assert.strictEqual(seen.openTurn, false, "本地也没有开放轮次");
    console.log("  ⑨-d 权威 true 后真收尾 + 提交失败：停在空闲 ✓");
  }
}

// ---------- ⑧ 既有正例：发送后立刻切走（域上的乐观值就要能立起标记） ----------
{
  const harness = await harnessWith();
  const { api, observe } = harness;
  await api.open("v1", A);
  const sending = api.send("v1", "跑一个长任务");
  await Promise.resolve();
  await api.leave("v1", B); // 立刻切走（服务端的 status 还没到）
  api.resolvePrompt();
  await sending;
  await api.status(A, true);
  await api.status(A, false);
  assert.strictEqual(observe(A).unread, true, "「发完立刻切走」必须记上离开标记并兑现");
  console.log("  ⑧ 发送后立刻切走 → 未读 ✓");
}

console.log("errorSessionStatus: 报错分支与产品语义口径全部符合 ✓");
