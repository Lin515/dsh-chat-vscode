/**
 * 「点「+」新建对话」在**用户 2026-10-17 21:00 口径**下的行为级回归：驱动真
 * `ChatController`（offline stub），只看发给窗口的帧与假服务端收到的调用。
 *
 * 口径：**当前已经停在一条空壳上时，点「+」是完全 no-op**——不清输入框 / 附件 / 待发与失败
 * 回显 / 空态页那几项待建选择，不改模型 / 思考强度 / 权限 / 预设 / 工作目录，不换绑定、不认领、
 * 不连后台、不发任何 RPC、不另建也不删，只记一行开发者日志。判据只有一条：`isBlankShell`
 * （服务端 `blank` 位 + 本地 `engagedSessions` 都没说它已经说过话），**不读会话日志脏不脏**：
 * 改过的标题、计划模式、目标 / 待办、自动化任务都不影响这一下。
 *
 * 同一份回归里保留的其它口径（这些不能被上面那条吞掉）：
 * - 内容会话 / 无壳时点「+」照旧落一条空壳：能接回没被占用的现成壳就接回（同步换绑 + 一次
 *   指名认领，见下），否则新建一条；
 * - 空壳按窗口独占：别人拿着的空壳不共享，各自落自己的；
 * - 普通导航的动作代号守卫（`openSession`）与占用账本照旧。
 *
 * 最后一档摆上**真 `workspaceFolders`**、并在会话日志里放上 MCP 状态卡与子代理策略两笔开场
 * 事件、同时让模型目录取失败：现场「目录不可用 / 有开场上下文」在这条口径下同样一笔请求都
 * 不许发。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、无 token、
 * 亚秒级）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[blankSessionNoop] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");

const CWD = "C:\\work\\demo";

interface Row {
  sessionId: string;
  cwd: string;
  blank: boolean;
  running: boolean;
  updatedAt: number;
}

/** 一条 durable 事件（形状照 `SessionWireEvent` 的最小子集）。 */
interface LedgerEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

interface SeedRow {
  sessionId: string;
  blank?: boolean;
  title?: string;
  cwd?: string;
}

/**
 * 假服务端：会话相关 RPC 与 `blankSessionReuse.test.ts` 同形，另加这条链路专用的几样——
 *
 * - **每会话一份 durable 日志**（`logs`）：`append` 一笔就推给跟随流，开帧交整份 `records`；
 * - `commands/execute`（`/permission` 走的通道）、`scheduleCatalog`；
 * - **所有 RPC 都进 `calls`**：no-op 的判据是「`calls` 一条都不涨」；
 * - `modelCatalog` 刻意**抛错**（现场就是「模型目录不可用」），调用同样被记下来。
 */
function fakeClient(
  seed: SeedRow[] = [],
  options: { scheduleTask?: boolean; noDefaults?: boolean } = {},
) {
  const rows: Row[] = seed.map((row, index) => ({
    sessionId: row.sessionId,
    cwd: row.cwd ?? CWD,
    blank: row.blank !== false,
    running: false,
    updatedAt: Date.now() + index,
  }));
  const titles = new Map<string, string>();
  for (const row of seed) if (row.title) titles.set(row.sessionId, row.title);
  /** 每条会话的 durable 日志（seq = 下标）。 */
  const logs = new Map<string, LedgerEvent[]>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const models: { sessionId: string; provider: string; model: string; reasoningEffort?: string }[] = [];
  const presets: { sessionId: string; preset: string }[] = [];
  const commands: { agentId: string; line: string }[] = [];
  const follows: { sessionId: string; handler: { onItem(value: unknown): void } }[] = [];
  const controls: { onItem(value: unknown): void }[] = [];
  const workspaces = new Map<string, string>();
  const cwdFor = (target: { workspaceId?: string; cwd?: string }): string =>
    target.workspaceId === undefined ? target.cwd ?? CWD : workspaces.get(target.workspaceId) ?? CWD;
  const rowOf = (sessionId: unknown) => rows.find((row) => row.sessionId === String(sessionId));

  const append = (sessionId: string, type: string, data: Record<string, unknown> = {}): void => {
    const log = logs.get(sessionId);
    if (!log) return;
    const event: LedgerEvent = { type, seq: log.length, time: Date.now(), data };
    log.push(event);
    for (const entry of follows) {
      if (entry.sessionId !== sessionId) continue;
      entry.handler.onItem({ type: "event", event });
    }
  };
  /**
   * 一条**新建**壳在服务端真实写下的开场事件（实测 `session-16a2814f…` 的形状）：权限三笔 +
   * `dsh-mcp-manager` 的 MCP 状态卡注入 + 子代理模型选择策略。no-op 判据只看空壳位、与这五笔
   * 无关，但夹具照真实形状写，才盖得住「有开场上下文时也不许多发一笔」。
   */
  const pinSessionStart = (sessionId: string) => {
    append(sessionId, "permission/preset", { preset: "workspace-write" });
    append(sessionId, "sandbox/mode", { mode: "workspace-write" });
    append(sessionId, "approval/policy", { policy: "ask" });
    append(sessionId, "agent/inbox/spliced", {
      target: "next-step",
      start: 0,
      inserted: [{
        content: [{ type: "text", text: "<mcp-status>\nMCP 服务器当前状态（● 运行中 / ○ 停止）：\n● context7 (mcp-context7)\n</mcp-status>" }],
        source: { kind: "plugin:dsh-mcp-manager", plugin: "dsh-mcp-manager", form: "mcp-status" },
        role: "user",
        id: `mcp-${sessionId}`,
      }],
    });
    append(sessionId, "subagent/model-selection-policy", {
      allowedModels: [{ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" }],
    });
  };
  for (const row of rows) {
    logs.set(row.sessionId, []);
    pinSessionStart(row.sessionId);
    if (row.blank === false) {
      append(row.sessionId, "turn/start", { turn: 0 });
      append(row.sessionId, "user/message", { text: "你好" });
    }
    const title = titles.get(row.sessionId);
    if (title) append(row.sessionId, "session/title", { title });
  }

  const snapshotFor = (sessionId: string) => {
    const row = rowOf(sessionId);
    const log = logs.get(sessionId) ?? [];
    return {
      type: "snapshot",
      header: { version: 3, id: sessionId, createdAt: 1, cwd: row?.cwd ?? CWD, isSeeded: false },
      cursor: log.length,
      records: log.map((event) => ({ type: "event", event })),
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    };
  };

  return {
    rows,
    titles,
    logs,
    calls,
    models,
    presets,
    commands,
    follows,
    controls,
    workspaces,
    rowOf,
    methods: () => calls.map((call) => call.method),
    logTypes: (sessionId: string) => (logs.get(sessionId) ?? []).map((event) => event.type),
    append,
    /** 给某条会话补一条控制流投影帧（标题 / 计划模式这类）。 */
    pushControl(frame: Record<string, unknown>) {
      for (const handler of controls) handler.onItem(frame);
    },
    async createWorkspace(path: string) {
      calls.push({ method: "workspace/create", params: { path } });
      const known = [...workspaces.entries()].find(([, value]) => value === path);
      if (known !== undefined) return { workspace: { workspaceId: known[0], path }, created: false };
      const id = `ws-${workspaces.size + 1}`;
      workspaces.set(id, path);
      return { workspace: { workspaceId: id, path }, created: true };
    },
    async createSession(target: { workspaceId?: string; cwd?: string; agentPreset?: string }, reuse?: string) {
      calls.push({ method: "session/create", params: { ...target, ...(reuse === undefined ? {} : { sessionId: reuse }) } });
      if (reuse !== undefined) {
        const row = rowOf(reuse);
        if (row && row.blank) return { sessionId: row.sessionId, ...(target.agentPreset === undefined ? {} : { agentPreset: target.agentPreset }) };
        // 点名的那条已经不是空壳（或不存在）：服务端另铸一条（真服务端的 `claim` 语义）
        const minted = `session-minted-${rows.length + 1}`;
        rows.push({ sessionId: minted, cwd: cwdFor(target), blank: true, running: false, updatedAt: Date.now() + rows.length });
        logs.set(minted, []);
        pinSessionStart(minted);
        return { sessionId: minted };
      }
      const sessionId = `session-new-${rows.length + 1}`;
      rows.push({ sessionId, cwd: cwdFor(target), blank: true, running: false, updatedAt: Date.now() + rows.length });
      logs.set(sessionId, []);
      pinSessionStart(sessionId);
      return { sessionId, ...(target.agentPreset === undefined ? {} : { agentPreset: target.agentPreset }) };
    },
    async listSessions() {
      calls.push({ method: "session/list", params: {} });
      return {
        items: rows.map((row) => ({
          ...row,
          projections: {
            asOfSeq: 1,
            values: {
              ...(titles.has(row.sessionId) ? { title: titles.get(row.sessionId) } : {}),
              ...(row.blank ? { agentPreset: "standard" } : {}),
            },
          },
        })),
      };
    },
    async selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string) {
      calls.push({ method: "session/selectModel", params: { sessionId, provider, model, reasoningEffort } });
      models.push({ sessionId, provider, model, reasoningEffort });
      append(sessionId, "model/selection", { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
      return { selected: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } };
    },
    async selectAgentPreset(sessionId: string, agentPreset: string) {
      calls.push({ method: "agentPresets/select", params: { sessionId, agentPreset } });
      presets.push({ sessionId, preset: agentPreset });
      append(sessionId, "agent-preset/selected", { agentPreset });
      return agentPreset;
    },
    async listAgentPresets() {
      calls.push({ method: "agentPresets/list", params: {} });
      return { presets: [{ id: "standard", isDefault: true }, { id: "ptc" }] };
    },
    /** 模型目录**取失败**（现场「模型目录不可用」）：调用仍进 `calls`，no-op 必须一条不发。 */
    async modelCatalog(): Promise<never> {
      calls.push({ method: "session/modelCatalog", params: {} });
      throw new Error("model catalog unavailable");
    },
    async scheduleCatalog() {
      calls.push({ method: "schedule/catalog", params: {} });
      if (options.scheduleTask !== true) return [];
      return [{
        id: "sched-1",
        sessionId: rows[0]?.sessionId ?? "unknown",
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        kind: "after",
        title: "check",
        prompt: "check",
        status: "active",
      }];
    },
    async request(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: { ...(params ?? {}) } });
      if (method === "workspace/create") {
        const path = String((params?.request as { path?: unknown } | undefined)?.path ?? "");
        const known = [...workspaces.entries()].find(([, value]) => value === path);
        if (known !== undefined) return { workspace: { workspaceId: known[0], path }, created: false };
        const id = `ws-${workspaces.size + 1}`;
        workspaces.set(id, path);
        return { workspace: { workspaceId: id, path }, created: true };
      }
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      if (method === "commands/execute") {
        const agentId = String(params?.agentId ?? "");
        const line = String(params?.line ?? "");
        const commandId = `cmd-${calls.length}`;
        commands.push({ agentId, line });
        append(agentId, "command/run", { commandId, name: "permission", args: line.replace(/^\/permission\b/, ""), source: { kind: "user" } });
        append(agentId, "command/done", { commandId, kind: "success", text: line });
        return { commandId, result: { kind: "success", text: line } };
      }
      if (method === "commands/list") return [{ name: "plan", description: "切换计划模式" }];
      return undefined;
    },
    async sessionProjections() {
      return { values: {} };
    },
    async getJson() {
      return undefined;
    },
    async settingsDescribe() {
      if (options.noDefaults) return { namespaces: [] };
      return {
        namespaces: [
          { ns: "agent-default-model", value: { provider: "prov", model: "model-default", reasoningEffort: "low" } },
          { ns: "permission", value: { defaultPreset: "workspace-write" } },
        ],
      };
    },
    followSession(sessionId: string, handler: { onItem(value: unknown): void }) {
      follows.push({ sessionId, handler });
      handler.onItem(snapshotFor(sessionId));
      return { cancel() {} };
    },
    followJobs() {
      return { cancel() {} };
    },
    followControl(handler: { onItem(value: unknown): void }) {
      controls.push(handler);
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

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

interface ControllerInternals {
  client: unknown;
  connection: string;
  sessions: { id: string; blank?: boolean }[];
  deletedSessionIds: Set<string>;
  viewSessions: Map<string, string>;
  scopes: Map<string, unknown>;
  drafts: Map<string, string>;
  pendingMessages: Map<string, unknown[]>;
  blankOccupants: Map<string, string>;
  blankReservations: Map<string, { viewId: string; token: number }>;
  viewActions: Map<string, number>;
  attachments: { list(key: string): unknown[] };
  newSessionCwd?: string;
  bindView(viewId: string): void;
  unbindView(viewId: string): void;
  newSession(viewId?: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  refreshSessions(): Promise<void>;
  loadAgentPresets(): Promise<void>;
  occupiedBlank(sessionId: string): boolean;
}

type Fake = ReturnType<typeof fakeClient>;

function makeController(
  seed: SeedRow[] = [],
  options: { dir?: string; scheduleTask?: boolean; noDefaults?: boolean } = {},
) {
  const logs: string[] = [];
  const controller = new ChatController(
    fakeServer() as never,
    (line: string) => logs.push(line),
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  (
    controller as never as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  const c = controller as unknown as ControllerInternals;
  const client = fakeClient(seed, { scheduleTask: options.scheduleTask, noDefaults: options.noDefaults });
  c.client = client as never;
  c.connection = "connected";
  c.newSessionCwd = options.dir ?? CWD;
  void c.loadAgentPresets();
  return { c, client, frames, logs };
}

/** 让排上队的微任务跑完（这些链全是同步代码 + 立即 resolve 的假 RPC）。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 16; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 点「+」（界面发 `newSession`）。 */
async function clickPlus(c: ControllerInternals, viewId: string): Promise<void> {
  await c.handle({ type: "newSession" }, viewId);
}

/** 这个窗口收到过的提示文本（取它**最近一次**收到的通知镜像）。 */
function toasts(frames: Captured[], viewId: string): string[] {
  let latest: { text: string }[] = [];
  for (const { target, frame } of frames) {
    if (target !== viewId) continue;
    const patch = (frame as { patch?: { notifications?: { text: string }[] } }).patch;
    if (patch?.notifications) latest = patch.notifications;
  }
  return latest.map((notice) => notice.text);
}

/** 让窗口落到一条空壳上（第一次「+」只落壳）。 */
async function landOnShell(c: ControllerInternals, client: Fake, viewId: string): Promise<string> {
  await clickPlus(c, viewId);
  await settle();
  const shell = String(c.viewSessions.get(viewId));
  assert.ok(shell.length > 0, "前置：点「+」之后窗口要落在一条会话上");
  assert.ok(client.rows.some((row) => row.sessionId === shell), "前置：那条会话真实存在");
  return shell;
}

/**
 * 这个窗口**此刻能观察到的一切**：绑定、草稿、待发回显、附件账本、域上的模型 / 权限 / 预设、
 * 会话 cwd、动作代号、会话行、RPC 调用数、已删集合。no-op 的判据就是它与点「+」之前**逐字
 * 相同**（比逐个字段断言更难漏项：以后谁再加一条状态，这个快照会自己带上）。
 */
function observable(c: ControllerInternals, client: Fake, viewId: string) {
  const bound = c.viewSessions.get(viewId);
  const scope = bound === undefined
    ? undefined
    : (c.scopes.get(bound) as { model?: unknown; permission?: string; agentPreset?: string } | undefined);
  return {
    bound,
    draft: bound === undefined ? undefined : c.drafts.get(bound),
    pending: bound === undefined ? [] : (c.pendingMessages.get(bound) ?? []),
    attachments: bound === undefined ? [] : c.attachments.list(bound),
    model: scope?.model,
    permission: scope?.permission,
    agentPreset: scope?.agentPreset,
    sessionCwd: client.rowOf(bound)?.cwd,
    action: c.viewActions.get(viewId),
    rows: client.rows.map((row) => row.sessionId),
    calls: client.calls.length,
    deleted: [...c.deletedSessionIds],
  };
}

/** 「点「+」前后逐字相同」+「一帧都没发」+「一条 RPC 都没发」——no-op 的三条硬判据。 */
function assertNoop(c: ControllerInternals, client: Fake, frames: Captured[], before: unknown, label: string): void {
  assert.deepStrictEqual(observable(c, client, "v1"), before, `${label}：点「+」之后状态必须逐字不变`);
  assert.deepStrictEqual(frames, [], `${label}：no-op 不许给窗口发任何帧`);
  assert.deepStrictEqual(toasts(frames, "v1"), [], `${label}：no-op 不许有任何提示`);
}

console.log("blankSessionNoop: 停在空壳上点「+」完全 no-op（驱动真控制器，offline stub）");

// ---------- 一、已经在空壳上：改了预设 / 模型 / 思考强度 / 权限、草稿留在输入框里 —— 仍然 no-op ----------
{
  const { c, client, frames } = makeController([{ sessionId: "shell-1" }]);
  c.bindView("v1");
  const shell = await landOnShell(c, client, "v1");

  // 用户在这条壳上留下真实痕迹（全走界面同一条 IPC）
  await c.handle({ type: "setDraft", text: "打了一半的字" }, "v1");
  await c.handle(
    {
      type: "attachBytes",
      source: "paste",
      files: [{ name: "shot.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }],
      unreadable: [],
      tooLarge: [],
    },
    "v1",
  );
  await settle();
  await c.handle({ type: "setModel", provider: "prov", model: "model-picked", reasoningEffort: "high" }, "v1");
  await settle();
  await c.handle({ type: "setAgentPreset", id: "ptc" }, "v1");
  await settle();
  await c.handle({ type: "setPermission", permission: "danger-full-access" }, "v1");
  await settle();
  assert.strictEqual(c.drafts.get(shell), "打了一半的字", "前置：草稿挂在会话键上");
  assert.strictEqual(c.attachments.list(shell).length, 1, "前置：附件进了宿主账本");
  assert.ok(c.pendingMessages.size === 0, "前置：这一档没有待发回显（那份在另一档里摆）");

  const before = observable(c, client, "v1");
  const callsBefore = client.calls.length;
  const count = (method: string): number => client.calls.filter((call) => call.method === method).length;
  const prior = {
    model: count("session/selectModel"),
    preset: count("agentPresets/select"),
    schedule: count("schedule/catalog"),
    create: count("session/create"),
  };
  frames.length = 0;
  await clickPlus(c, "v1");
  await settle();
  assertNoop(c, client, frames, before, "改过模型 / 思考强度 / 预设 / 权限 + 草稿附件");
  assert.strictEqual(c.viewSessions.get("v1"), shell, "仍然停在同一条空壳上（id 不变）");
  assert.strictEqual(client.calls.length, callsBefore, "no-op 一条 RPC 都不发");
  // 前置里那两笔（改模型 / 改预设）本来就已经提交过，所以这里比的是**增量**
  assert.strictEqual(count("session/selectModel"), prior.model, "不许把模型写回默认");
  assert.strictEqual(count("agentPresets/select"), prior.preset, "不许把预设写回默认");
  assert.strictEqual(count("schedule/catalog"), prior.schedule, "不许为判据去读自动化任务目录");
  assert.strictEqual(count("session/create"), prior.create, "不许认领、也不许另建");
  assert.ok(!c.deletedSessionIds.has(shell), "不许删日志目录");

  // **连续再点两次**：仍然一模一样（no-op 不该在第二次变成别的动作）
  const second = observable(c, client, "v1");
  frames.length = 0;
  await clickPlus(c, "v1");
  await settle();
  await clickPlus(c, "v1");
  await settle();
  assertNoop(c, client, frames, second, "连续第二次 / 第三次");
  assert.strictEqual(client.calls.length, callsBefore, "连续点击也不发任何 RPC");
}

// ---------- 二、待发 / 失败回显留在会话上：no-op 不许把它们退掉 ----------
{
  const { c, client, frames } = makeController([{ sessionId: "shell-1" }]);
  c.bindView("v1");
  const shell = await landOnShell(c, client, "v1");
  c.pendingMessages.set(shell, [
    { requestId: "rq-1", ts: 1, text: "没发出去的一条", attachments: [], status: "failed" },
  ]);

  const before = observable(c, client, "v1");
  frames.length = 0;
  await clickPlus(c, "v1");
  await settle();
  assertNoop(c, client, frames, before, "挂着失败回显");
  assert.strictEqual((c.pendingMessages.get(shell) ?? []).length, 1, "失败回显原地保留");
}

// ---------- 三、带标题 / 计划 / 目标 / 自动化任务、且 blank=true 的壳：照样 no-op ----------
//
// 这四样都不进 no-op 判据（判据只看 `blank` 位），所以它们只能让这一档更有分量。
{
  const { c, client, frames } = makeController([{ sessionId: "shell-1" }], { scheduleTask: true });
  c.bindView("v1");
  const shell = await landOnShell(c, client, "v1");
  // 真 durable 事件：改过的标题、进入计划模式、写下目标；自动化任务在 `schedule/catalog` 里
  client.append(shell, "session/title", { title: "我自己起的名字" });
  client.append(shell, "plan/mode", { active: true });
  client.append(shell, "goal/change", { goal: "把这件事做完" });
  await c.refreshSessions();
  await settle();
  assert.strictEqual(client.rowOf(shell)?.blank, true, "前置：服务端那一位仍然是 blank");

  const before = observable(c, client, "v1");
  frames.length = 0;
  await clickPlus(c, "v1");
  await settle();
  assertNoop(c, client, frames, before, "有标题 / 计划 / 目标 / 自动化任务");
  assert.strictEqual(c.viewSessions.get("v1"), shell, "标题 / 计划 / 目标 / 任务都不影响这一下");
}

// ---------- 四、断连时同样 no-op：不许顺手去连后台 ----------
{
  const { c, client, frames } = makeController([{ sessionId: "shell-1" }]);
  c.bindView("v1");
  const shell = await landOnShell(c, client, "v1");
  c.connection = "stopped";
  frames.length = 0;
  const callsBefore = client.calls.length;
  await clickPlus(c, "v1");
  await settle();
  assert.strictEqual(c.viewSessions.get("v1"), shell, "断连时空壳照旧不动");
  assert.deepStrictEqual(frames, [], "断连时的 no-op 也不发帧");
  assert.strictEqual(client.calls.length, callsBefore, "断连时的 no-op 一条 RPC 都不发（不许拉起后台）");
}

// ---------- 五、真 workspaceFolders + 模型目录不可用：no-op 既不建也不请求目录 ----------
{
  const vscode = await import("vscode");
  const folders = vscode.workspace as unknown as { workspaceFolders: unknown };
  const original = folders.workspaceFolders;
  folders.workspaceFolders = [{ uri: { fsPath: "c:\\work\\demo" } }];
  try {
    const { c, client, frames } = makeController([]);
    c.bindView("v1");
    const shell = await landOnShell(c, client, "v1");
    assert.strictEqual(client.rows.length, 1, "前置：真新建了一条壳");
    assert.deepStrictEqual(
      client.logTypes(shell),
      ["permission/preset", "sandbox/mode", "approval/policy", "agent/inbox/spliced", "subagent/model-selection-policy"],
      "前置：空壳日志里有权限事实与两笔开场上下文",
    );

    const before = observable(c, client, "v1");
    frames.length = 0;
    await clickPlus(c, "v1");
    await settle();
    assertNoop(c, client, frames, before, "真工作区 + 目录不可用");
    assert.ok(!client.methods().includes("session/modelCatalog"), "模型目录取不到也不许为这一下去读它");
    assert.deepStrictEqual(client.rows.map((row) => row.sessionId), [shell], "没有另建会话");
  } finally {
    folders.workspaceFolders = original as never;
  }
}

// ---------- 六、无壳 / 未占用空壳 / 内容会话：照旧正常新建或复用 ----------
{
  // 6a. 全新窗口 + 池子里有一条没人占用的空壳：**接回**它（同步换绑 + 一次指名认领）
  const { c, client, frames } = makeController([{ sessionId: "shell-free" }]);
  c.bindView("v1");
  await clickPlus(c, "v1");
  await settle();
  assert.strictEqual(c.viewSessions.get("v1"), "shell-free", "无壳时点「+」复用了现成的空壳");
  const creates = client.calls.filter((call) => call.method === "session/create");
  assert.strictEqual(creates.length, 1, "复用那条路只发一次指名认领（不铸新的）");
  assert.strictEqual(creates[0].params.sessionId, "shell-free", "认领的就是那条现成空壳");
  assert.strictEqual(client.rows.length, 1, "没有另铸会话");
  assert.ok(frames.length > 0, "落壳要推一份快照");
}
{
  // 6b. 全新窗口 + 池子里只有内容会话：真新建一条
  const { c, client } = makeController([{ sessionId: "chat-1", blank: false }]);
  c.bindView("v1");
  await clickPlus(c, "v1");
  await settle();
  const landed = String(c.viewSessions.get("v1"));
  assert.notStrictEqual(landed, "chat-1", "内容会话不是空壳：不许停在它上面");
  assert.strictEqual(client.rows.length, 2, "另落了一条真正新建的壳");
  assert.ok(client.methods().includes("session/create"), "那一条经 `session/create` 铸出来");
}
{
  // 6c. 窗口停在**内容会话**上再点「+」：解绑 → 落一条空壳（不是 no-op）
  const { c, client } = makeController([{ sessionId: "chat-1", blank: false }]);
  c.bindView("v1");
  await c.handle({ type: "openSession", sessionId: "chat-1" }, "v1");
  await settle();
  assert.strictEqual(c.viewSessions.get("v1"), "chat-1", "前置：窗口停在内容会话上");

  await clickPlus(c, "v1");
  await settle();
  const landed = String(c.viewSessions.get("v1"));
  assert.notStrictEqual(landed, "chat-1", "内容会话上点「+」照旧离开它");
  assert.strictEqual(client.rowOf(landed)?.blank, true, "落到的是空壳");
  assert.strictEqual(client.rows.length, 2, "内容会话保留，另落一条空壳");
  assert.ok(!c.deletedSessionIds.has("chat-1"), "内容会话的日志目录不删");
}

// ---------- 七、空壳按窗口独占：别人拿着的空壳不共享 ----------
{
  const { c, client } = makeController([]);
  c.bindView("v1");
  const first = await landOnShell(c, client, "v1");
  c.bindView("v2");
  const second = await landOnShell(c, client, "v2");
  assert.notStrictEqual(first, second, "两个窗口各落各的空壳（不共享）");
  assert.strictEqual(c.blankOccupants.get(first), "v1", "第一条壳的占用者是 v1");
  assert.strictEqual(c.blankOccupants.get(second), "v2", "第二条壳的占用者是 v2");

  // v2 去打开 v1 手里那条空壳：不共享，改落自己的一条
  await c.handle({ type: "openSession", sessionId: first }, "v2");
  await settle();
  const landed = String(c.viewSessions.get("v2"));
  assert.notStrictEqual(landed, first, "被别人拿着的空壳不共享");
  assert.strictEqual(c.blankOccupants.get(first), "v1", "v1 的占用不被覆盖");
  assert.strictEqual(landed, second, "v2 仍在自己那条上（已有的壳先复用）");
}

// ---------- 八、双窗口并发点「+」之后各自 no-op：互不影响 ----------
{
  const { c, client } = makeController([]);
  c.bindView("v1");
  const a = await landOnShell(c, client, "v1");
  c.bindView("v2");
  const b = await landOnShell(c, client, "v2");

  const beforeA = observable(c, client, "v1");
  const beforeB = observable(c, client, "v2");
  const callsBefore = client.calls.length;
  await Promise.all([clickPlus(c, "v1"), clickPlus(c, "v2")]);
  await settle();
  assert.deepStrictEqual(observable(c, client, "v1"), beforeA, "v1 的 no-op 不改变自己的状态");
  assert.deepStrictEqual(observable(c, client, "v2"), beforeB, "v2 的 no-op 不改变自己的状态");
  assert.strictEqual(c.viewSessions.get("v1"), a, "v1 仍在自己的壳上");
  assert.strictEqual(c.viewSessions.get("v2"), b, "v2 仍在自己的壳上");
  assert.strictEqual(client.calls.length, callsBefore, "两个窗口的 no-op 都不发 RPC");
}

console.log("blankSessionNoop: 停在空壳上点「+」完全 no-op，无壳 / 内容会话照旧落壳 ✓");
