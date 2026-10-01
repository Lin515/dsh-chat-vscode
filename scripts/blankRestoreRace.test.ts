/**
 * 「重载窗口时恢复历史会话」与「连接结算补空壳」并发时的**行为级**回归。
 *
 * 报障现场（用户 2026-10-02）：VS Code 重载窗口后，会话窗口先正确载入关闭前那条
 * 历史会话（内容都出来了），**随后一闪变成空会话**（本工作区那条空壳）。
 *
 * 根因：`onConnected` 尾巴上的「给未绑定窗口补空壳」（`adoptBlankForUnboundViews`，
 * 见 0.9.12 的「空态即一条真会话」口径）与窗口恢复路径**并发**。补壳那条链在
 * `reuseOrCreateBlank` 里从判据（`scopeOfView` 为空）到写绑定跨了至少一个 await
 * （`ensureWorkspace` / `session/create` / `refreshSessions`），最后在末尾**无条件**
 * `bindViewToSession`——不复查「这段时间里窗口是不是已经被恢复路径绑上了」，于是把
 * 历史会话顶掉。用户看到的就是「历史会话先出现、然后一闪变空」。
 *
 * 为什么以前没有：老口径下「窗口就绪」不补壳（`newSession` 只退空态），重载期间没有
 * 任何后台路径会去绑窗口。补壳是 0.9.12 新增的自动路径。
 *
 * 本断言驱动真 `ChatController`（offline stub，见 `vscodeTestStub.ts` 与
 * `esbuild.scripts.mjs` 的 alias），把两条链按**现场的真实顺序**排出来：
 *
 * 1. 连接结算先起（生产里 `void this.onConnected()` 是 fire-and-forget，见
 *    `client.onDidChangeState` 的 connected 分支）；
 * 2. 恢复随后（webview 发 `ready` → `resumeRestoreHint`：重载后它要先走
 *    `ensureConnected` 连上/拉起后台，比补壳链慢）。
 *
 * 断言的是**用户看到的那件事**：这个窗口最终绑的是恢复那条历史会话，且中途没有被
 * 空壳覆盖过（`bindViewToSession` 的调用序列里不许出现空壳）。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[blankRestoreRace] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");

const CWD = "C:\\work\\demo";
/** 关闭窗口前那条历史会话：已经说过话（`blank=false`），恢复认领会把它接回来。 */
const HISTORY = "session-history";

/**
 * 假服务端：与会话相关的那几个 RPC 与 `blankSessionReuse.test.ts` 同形——
 * `session/create` 造出 `blank:true` 的行，`session/list` 只在被查时才交出新值。
 *
 * 多加了三样 `onConnected` 要用的长活流（`openStream` / `openEvents` /
 * `followControl`）：本断言要驱动连接结算那条链，缺了它们 `void onConnected()`
 * 会以未处理的拒绝炸掉测试进程。
 */
function fakeClient(seed: { sessionId: string; blank?: boolean }[] = []) {
  const rows = seed.map((row, index) => ({
    sessionId: row.sessionId,
    cwd: CWD,
    blank: row.blank !== false,
    updatedAt: Date.now() + index,
    running: false,
  }));
  const calls: string[] = [];
  return {
    calls,
    rows,
    async createSession(target: { workspaceId?: string; cwd?: string }) {
      calls.push("session/create");
      const sessionId = `session-${rows.length + 1}`;
      rows.push({
        sessionId,
        cwd: target.cwd ?? "",
        blank: true,
        updatedAt: Date.now() + rows.length,
        running: false,
      });
      return { sessionId };
    },
    async listSessions() {
      calls.push("session/list");
      return { items: rows.map((row) => ({ ...row })) };
    },
    async request(method: string, params?: Record<string, unknown>) {
      calls.push(method);
      if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (rows.some((row) => row.sessionId === agentId)) {
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

interface Harness {
  c: ControllerInternals;
  client: ReturnType<typeof fakeClient>;
  /** 这个窗口历史上被绑过的会话 id，按发生顺序（`bindViewToSession` 的调用序列）。 */
  binds: string[];
}

interface ControllerInternals {
  client: unknown;
  connection: string;
  sessions: { id: string; blank?: boolean }[];
  viewSessions: Map<string, string>;
  restoreHints: Map<string, { sessionId?: string }>;
  restoreAwaiting: Set<string>;
  readyViews: Set<string>;
  windowState: { key: string | undefined; snapshot(): unknown; load(cache: unknown): void };
  windowRestore: { replace(cache: unknown): void };
  newSessionCwd?: string;
  bindView(viewId: string): void;
  bindViewKind(viewId: string, kind: "panel" | "primary" | "secondary"): void;
  claimPanelRestore(viewId: string, known?: { sessionId: string }): void;
  flushRestoreClaims(): void;
  bindViewToSession(viewId: string, sessionId: string, scope: unknown): void;
  onConnected(): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  resumeRestoreHint(viewId: string): Promise<void>;
}

function makeHarness(seed: { sessionId: string; blank?: boolean }[]): Harness {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const c = controller as unknown as ControllerInternals;
  const client = fakeClient(seed);
  c.client = client as never;
  c.connection = "connected";
  c.newSessionCwd = CWD;
  // 「这个窗口绑定过哪些会话」是本断言的观察面：用户看到的一闪，就是绑定被改写。
  const binds: string[] = [];
  const raw = c.bindViewToSession.bind(c);
  c.bindViewToSession = (viewId, sessionId, scope) => {
    binds.push(sessionId);
    raw(viewId, sessionId, scope);
  };
  return { c, client, binds };
}

/** 让所有已经排上队的微任务跑完（这些链全是同步代码 + 立即 resolve 的假 RPC）。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

console.log("blankRestoreRace: 重载窗口时补壳不许抢恢复（驱动真控制器，offline stub）");

// ---------- 一、现场顺序：连接结算先起，恢复随后 → 窗口必须停在历史会话上 ----------
//
// 这是报障现场的排法：连接建立（重载后要连/起后台，秒级）先结算，补壳链随即在后台
// 开跑；webview 的 `ready` 就在这段时间里到达，恢复链开始接回历史会话。
{
  const { c, client, binds } = makeHarness([{ sessionId: HISTORY, blank: false }]);
  c.bindView("v1");
  // 恢复认领已经落地（`claimPanelRestore` / `claimSidebarRestore` 之后就是这个状态），
  // 只等 `ready` 接回——重载那一刻 `restoreHints` 里就有这个窗口
  c.restoreHints.set("v1", { sessionId: HISTORY });

  const connected = c.onConnected(); // 生产里是 `void this.onConnected()`（fire-and-forget）
  const ready = c.handle({ type: "ready" }, "v1");
  await Promise.all([connected, ready]);
  await settle();

  console.log(
    `  v1 的绑定序列：${binds.join(" → ") || "（无）"}；服务端会话：` +
      client.rows.map((row) => `${row.sessionId}(blank=${row.blank})`).join(", "),
  );
  assert.strictEqual(
    c.viewSessions.get("v1"),
    HISTORY,
    "重载后窗口必须停在恢复回来的历史会话上（用户报的「一闪变空」就是这里被空壳顶掉）",
  );
  assert.ok(
    !binds.some((id) => id !== HISTORY),
    `补壳不许把恢复好的窗口改写掉（绑定序列里出现了别的会话：${binds.join(" → ")}）`,
  );
}

// ---------- 二、恢复还没到：不该被补壳抢先（排队中的认领同理） ----------
//
// `restoreAwaiting` 里的窗口是「认领排着队」：工作区身份未就绪，`resumeRestoreHint`
// 此刻无 hint 可接。补壳必须给这一轮恢复让位——否则先落一条空壳，等认领落下再把
// 历史会话接回来（顺序相反，用户看到的是「空 → 历史」跳一下）。
{
  const { c, binds } = makeHarness([{ sessionId: HISTORY, blank: false }]);
  c.bindView("v1");
  c.restoreAwaiting.add("v1");

  await c.onConnected();
  await settle();

  console.log(`  认领排队中：绑定序列 ${binds.join(" → ") || "（无）"}`);
  assert.deepStrictEqual(
    binds,
    [],
    "这一轮恢复还没结算的窗口不许被补壳（先落空壳再被认领顶掉＝界面跳一下）",
  );
  assert.strictEqual(c.viewSessions.get("v1"), undefined, "窗口停在空态，等认领落下");
}

// ---------- 三、认领比 ready 更晚落下：落下那一刻必须**当场**接回 ----------
//
// 认领可以在工作区身份就绪之前排队（`claimPanelRestore` → `restoreAwaiting`），而页面
// 可能先发 `ready`——那一刻没有 hint 可接。两条要求：
//  1. 不许因为「接不到会话」就先落一条空壳（上面第二条已覆盖补壳那条路，这里覆盖
//     `ready` 尾巴那句）；
//  2. 认领落下时**立刻叫醒**这个窗口（`flushRestoreClaims` → `resumeRestoreHint`）。
//     只把 hint 记下不叫醒，就只能等 `ChatViewProvider` 的 8 秒兜底定时器——它是在挂
//     窗口时排的，早于本次认领烧掉时这次恢复就永远不发生了。
{
  const { c, binds } = makeHarness([{ sessionId: HISTORY, blank: false }]);
  c.bindView("v1");
  c.bindViewKind("v1", "panel");
  // 此刻构造期还没拿到工作区身份（stub 的 workspaceFolders 是空的）→ 认领排队
  c.claimPanelRestore("v1", { sessionId: HISTORY });
  assert.ok(c.restoreAwaiting.has("v1"), "前置：认领排着队");

  await c.handle({ type: "ready" }, "v1");
  await settle();
  assert.deepStrictEqual(binds, [], "认领排着队时 `ready` 不许先落空壳");

  // 工作区身份后来才就绪：缓存读到那份窗口状态，排队的认领按身份对上了
  c.windowState.load({ version: 1, panels: [{ sessionId: HISTORY }], activeOrder: [] });
  c.windowRestore.replace(c.windowState.snapshot());
  c.windowState.key = "windowCache:test";
  c.flushRestoreClaims();
  await settle();

  console.log(`  认领晚于 ready 落下：绑定序列 ${binds.join(" → ") || "（无）"}`);
  assert.strictEqual(
    c.viewSessions.get("v1"),
    HISTORY,
    "认领落下时必须当场叫醒这个窗口把它接回（不许等兜底定时器）",
  );
}

// ---------- 四、补壳链在飞时用户点了历史里的一条：点的那条必须赢 ----------
//
// 这条不依赖恢复状态，是同一个「读状态 → await → 写状态」缺陷的**通用形态**：
// 补壳的判据（`scopeOfView` 为空）在链首，写绑定在链尾，中间隔着
// `ensureWorkspace` / `session/create` / `refreshSessions` 整串往返（真实环境里是
// 几百毫秒）。用户在这段时间里点开历史抽屉选了一条会话、或恢复路径绑上了，补壳链
// 落地时若不复查，就会把用户刚点的那条顶掉。
//
// 插入点刻意选在**判据之后、写绑定之前**：假服务端一被要求建新壳就先把用户那一下
// 落下去，于是补壳链醒来时窗口已经有会话了。
{
  const { c, client, binds } = makeHarness([{ sessionId: HISTORY, blank: false }]);
  c.bindView("v1");
  const create = client.createSession;
  client.createSession = async (target) => {
    const created = await create(target);
    // 用户此刻在历史里点了那条会话（`openSession` 到写绑定为止是同步的）
    await c.openSession("v1", HISTORY);
    return created;
  };

  await c.onConnected();
  await settle();

  console.log(
    `  补壳途中用户点了历史：绑定序列 ${binds.join(" → ") || "（无）"}；服务端会话 ` +
      client.rows.map((row) => row.sessionId).join(", "),
  );
  assert.strictEqual(
    c.viewSessions.get("v1"),
    HISTORY,
    "用户点了历史里的一条之后，后台补壳链不许再把窗口改写成空壳",
  );
  assert.ok(
    !binds.some((id) => id !== HISTORY),
    `绑定序列里出现了用户没点过的会话（补壳把用户的选择顶掉了）：${binds.join(" → ")}`,
  );
}

console.log("blankRestoreRace: 补壳让位恢复、空壳不许顶掉历史会话 ✓");