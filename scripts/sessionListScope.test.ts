/**
 * 「历史列表跟随**当前会话 cwd**」的**行为级**回归：驱动真 `ChatController`（offline
 * stub），只看每个窗口真正收到的那一帧会话列表（`type: "sessions"`）。
 *
 * 用户 2026-10-10 口径：VS Code **没有打开文件夹**时，每个会话可以各自选一个工作目录
 * （空态页那枚目录胶囊，见 `workspaceDirRepick.test.ts`），于是同一个扩展宿主里可以
 * 同时开着两个 cwd 不同的会话。历史列表必须**按窗口当前那条会话的 cwd 隔离**——
 * 否则「两个面板各自开一个目录」时，两个面板的历史里混着对方的会话。
 *
 * 三件事必须同时成立，缺一条这组断言就会红：
 * 1. **按窗口过滤**：无文件夹时，窗口只看见它当前会话 cwd 下的会话（不是「本窗口
 *    打开过的所有 cwd 的并集」，也不是 `activeViewId` 那一个窗口的 cwd）；
 * 2. **跟着切换走**：同一个窗口从 A 切到 B，它的列表要跟着换成 B 的（绑定那一刻就
 *    重发，不必等下一次 `session/list`）；
 * 3. **全局那份不能瘦身**：`this.sessions` 仍是「本窗口该看见的并集」——打开菜单、
 *    空壳复用（`reusableBlank`）、running 打底都要读它；过滤只发生在**发帧**那一步。
 *
 * 打开着文件夹时是另一条口径（目录跟随 VS Code，所有窗口同一份，含「任何已打开域
 * 的 cwd」兜底），本文件最后一段把它原样钉住：那是这次改动**不许动**的旧行为。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[sessionListScope] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");
// 与 controller 同一个模块实例（同一次 esbuild 打包 + alias），所以下面替换
// `workspaceFolders` / `showOpenDialog` 能被 controller 看到。
const vscode = await import("vscode");

const DIR_A = "C:\\work\\alpha";
const DIR_B = "C:\\work\\beta";
const DIR_C = "C:\\work\\gamma";

/** 假服务端 `session/list` 的一行（真形状的子集：cwd 是会话的创建事实）。 */
interface Row {
  sessionId: string;
  cwd?: string;
  blank?: boolean;
  updatedAt?: number;
  running?: boolean;
  /** 子代理会话的标记（`origin: 'subagent'` 全局隐藏，见 `visibleSessionRows`）。 */
  origin?: string;
  parentSessionId?: string;
}

interface Captured {
  target: "all" | string;
  frame: Record<string, unknown>;
}

/** 假服务端：会话行的 cwd 由 `session/create` 的入参决定（与真服务端同源）。 */
function fakeClient(seed: Row[]) {
  const rows = seed.map((row, index) => ({
    sessionId: row.sessionId,
    cwd: row.cwd,
    blank: row.blank === true,
    updatedAt: row.updatedAt ?? 1000 + index,
    running: row.running === true,
    origin: row.origin,
    parentSessionId: row.parentSessionId,
  }));
  const calls: string[] = [];
  return {
    rows,
    calls,
    async createSession(target: { workspaceId?: string; cwd?: string }) {
      calls.push("session/create");
      const sessionId = `created-${rows.length + 1}`;
      rows.push({
        sessionId,
        cwd: target.cwd,
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
    async selectModel(sessionId: string, provider: string, model: string) {
      calls.push("session/selectModel");
      return { selected: { provider, model } };
    },
    async prompt(sessionId: string) {
      calls.push("session/prompt");
      const row = rows.find((item) => item.sessionId === sessionId);
      if (row) row.blank = false;
      return { accepted: true };
    },
    async request(method: string) {
      calls.push(method);
      if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      if (method === "commands/list") return [];
      if (method === "fileReferences/list") return [];
      if (method === "sessionReferenceResolver/candidates") return [];
      if (method === "skills/list") return { skills: [] };
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
  c: ChatControllerInternals;
  client: ReturnType<typeof fakeClient>;
  frames: Captured[];
}

interface ChatControllerInternals {
  client: unknown;
  connection: string;
  sessions: { id: string; cwd?: string; blank?: boolean }[];
  viewSessions: Map<string, string>;
  newSessionCwd?: string;
  workspaces: { workspaceId: string; path: string; sessionIds: string[] }[];
  /** 权威 cwd 账本（会话 id → cwd，`session/list` 原始行的投影）。 */
  sessionCwds: Map<string, string>;
  bindView(viewId: string): void;
  openSession(viewId: string, sessionId: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  /** 换连接 / 断线收场（真实链路上 prepareRound / 掉线时走它）。 */
  teardownStreams(): void;
}

interface HarnessOptions {
  /** 用户在新会话页上选过的目录（没有打开文件夹时才有意义）。 */
  dir?: string;
  /** 服务端工作区注册表的行（判「这条会话属于哪个工作区」）。 */
  workspaces?: { workspaceId: string; path: string; sessionIds: string[] }[];
}

function makeHarness(seed: Row[], options: HarnessOptions = {}): Harness {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
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
  const c = controller as unknown as ChatControllerInternals;
  if (options.dir !== undefined) c.newSessionCwd = options.dir;
  if (options.workspaces) c.workspaces = options.workspaces;
  const client = fakeClient(seed);
  c.client = client as never;
  c.connection = "connected";
  return { c, client, frames };
}

/** 装一次「VS Code 打开着文件夹」。 */
function stubFolder(path: string | undefined) {
  const workspace = vscode.workspace as unknown as { workspaceFolders: unknown };
  const original = workspace.workspaceFolders;
  workspace.workspaceFolders = path === undefined ? [] : [{ uri: { fsPath: path } }];
  return {
    restore() {
      workspace.workspaceFolders = original;
    },
  };
}

/** 装一次系统目录选择器（按顺序吐出「用户选择」）。 */
function stubDialog(answers: (string | undefined)[]) {
  const dialogs: string[] = [];
  const original = vscode.window.showOpenDialog;
  let at = 0;
  (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => {
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer === undefined) {
      dialogs.push("cancel");
      return undefined;
    }
    dialogs.push(answer);
    return [{ fsPath: answer }];
  };
  return {
    dialogs,
    restore() {
      (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = original;
    },
  };
}

/**
 * **这个窗口**此刻看到的历史列表（会话 id，按帧内顺序）。
 *
 * 过线语义与 `chatView.deliver` 一致：`target === "all"` 是广播（每个窗口都收到），
 * 其余按 viewId 定向——所以找「发给这个窗口的最后一帧」时两种都要认，定向发给了
 * 别的窗口的帧不算它的。返回 undefined 表示这个窗口一帧都没收到过。
 */
function sessionIdsFor(frames: Captured[], viewId: string): string[] | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (frame.type !== "sessions") continue;
    if (target !== "all" && target !== viewId) continue;
    return ((frame.sessions ?? []) as { id: string }[]).map((row) => row.id);
  }
  return undefined;
}

/** 用户点开历史抽屉（界面发 `listSessions`）。 */
async function openHistory(c: ChatControllerInternals, viewId: string): Promise<void> {
  await c.handle({ type: "listSessions" }, viewId);
}

/**
 * **这个窗口**此刻那行工作目录（空态页胶囊 / 标题栏读的就是它）。
 *
 * 取值有两个过线渠道：`patch`（`emitWorkspaceViews`）与整份 `state` 快照
 * （`snapshotFor` 里 `appearanceView` 那一半）。判据同样认 `all` 广播与定向帧。
 */
function workspaceFor(
  frames: Captured[],
  viewId: string,
): { path?: string; locked?: boolean } | undefined {
  const pick = (source: unknown) => (source as { workspace?: { path?: string; locked?: boolean } })?.workspace;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target !== "all" && target !== viewId) continue;
    if (frame.type === "patch") {
      const workspace = pick(frame.patch);
      if (workspace) return workspace;
    }
    if (frame.type === "state") {
      const workspace = pick(frame.state);
      if (workspace) return workspace;
    }
  }
  return undefined;
}

/** 无文件夹场景的公共种子：两个目录各有「说过话的」和「空壳」会话，外加别的目录的。 */
const commonRows = (): Row[] => [
  { sessionId: "used-A", cwd: DIR_A },
  { sessionId: "used-B", cwd: DIR_B },
  { sessionId: "used-C", cwd: DIR_C },
  { sessionId: "reg-C", cwd: DIR_C },
  { sessionId: "blank-A", cwd: DIR_A, blank: true },
  { sessionId: "blank-B", cwd: DIR_B, blank: true },
  { sessionId: "no-cwd" },
];

console.log("sessionListScope: 历史列表跟随当前会话 cwd（驱动真控制器，offline stub）");

// ---------- 一、没打开文件夹：两个面板各绑一条不同 cwd 的会话，历史互不串 ----------
{
  const { c, client, frames } = makeHarness(commonRows(), {
    // 注册表里那条属于 DIR_C：没有打开文件夹时它不是「未分组」，谁的列表里都不该有它
    workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
  });
  c.bindView("v1");
  c.bindView("v2");
  // 两个窗口各自点了历史里的一条（会话就是它们各自的「当前会话」）
  await c.openSession("v1", "used-A");
  await c.openSession("v2", "used-B");
  await openHistory(c, "v1");

  const v1 = sessionIdsFor(frames, "v1");
  const v2 = sessionIdsFor(frames, "v2");
  console.log(`  v1（cwd=${DIR_A}）：${JSON.stringify(v1)}`);
  console.log(`  v2（cwd=${DIR_B}）：${JSON.stringify(v2)}`);
  assert.deepStrictEqual(
    v1,
    ["used-A"],
    "没有打开文件夹时，窗口 v1 的历史只许有它当前会话 cwd 下的会话——别人的目录不许混进来",
  );
  assert.deepStrictEqual(
    v2,
    ["used-B"],
    "窗口 v2 同理（两个面板同时开着不同 cwd 时，各自的历史必须互不串）",
  );
  for (const id of ["blank-A", "blank-B"]) {
    assert.ok(!(v1 ?? []).includes(id), `还没说过话的空壳不进历史（${id}）`);
  }
  assert.ok(
    !(v1 ?? []).includes("no-cwd"),
    "没有 cwd 的会话一律不显示（服务端建会话时必给 cwd 或 workspaceId）",
  );
  assert.strictEqual(client.rows.length, commonRows().length, "过滤发生在发帧那一步，不改服务端会话");
  // **全局那一份不许跟着收窄**：`this.sessions` 还要给打开会话（`reusableBlank` 扫空壳）、
  // `isBlankShell`、running 打底（`ensureScope`）与 `blankSessionIds` 用——按窗口收窄
  // 只发生在发帧那一步（见 `emitSessionLists` 的注释）。收窄了这里会先红。
  assert.deepStrictEqual(
    c.sessions.map((row) => row.id),
    ["used-A", "used-B", "used-C", "blank-A", "blank-B"],
    "全局 this.sessions 仍是并集：两个窗口各自 cwd 的会话、没被任何窗口打开的未分组会话、" +
      "以及**空壳**（复用判据要扫它）都在里面；没有 cwd 的会话照旧不进（它 resume 不了）",
  );
}

// ---------- 二、同一个窗口从 A 切到 B：列表跟着换（不必等下一次拉取） ----------
{
  const { c, frames } = makeHarness(commonRows());
  c.bindView("v1");
  await c.openSession("v1", "used-A");
  await openHistory(c, "v1");
  assert.deepStrictEqual(sessionIdsFor(frames, "v1"), ["used-A"], "先绑 A：只看见 A 的会话");

  await c.openSession("v1", "used-B");
  console.log(`  切到 B 之后的 v1：${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-B"],
    "同一个窗口切到别的 cwd 的会话，历史列表必须立刻跟着换成新 cwd 的（绑定那一帧就重发）",
  );
}

// ---------- 三、无文件夹下换选目录：列表跟到新目录那条壳上 ----------
{
  const dialog = stubDialog([DIR_B]);
  try {
    const { c, client, frames } = makeHarness(commonRows(), { dir: DIR_A });
    c.bindView("v1");
    // 空态页那枚胶囊只在「还绑着空壳」时才换目录，所以这里绑的是 DIR_A 那条空壳
    await c.openSession("v1", "blank-A");
    await openHistory(c, "v1");
    assert.deepStrictEqual(sessionIdsFor(frames, "v1"), ["used-A"], "换目录之前：看见 A 的历史");

    await c.handle({ type: "pickWorkspace" }, "v1");
    const bound = c.viewSessions.get("v1");
    console.log(
      `  换到 ${DIR_B} 之后 v1 绑在 ${bound}（cwd=${client.rows.find((r) => r.sessionId === bound)?.cwd}），列表：${JSON.stringify(sessionIdsFor(frames, "v1"))}`,
    );
    assert.strictEqual(bound, "blank-B", "换目录落到新目录那条空壳上（复用，不新建）");
    assert.deepStrictEqual(
      sessionIdsFor(frames, "v1"),
      ["used-B"],
      "换选目录之后历史列表跟到新目录（旧目录的会话不再出现）",
    );
  } finally {
    dialog.restore();
  }
}

// ---------- 四、新建空页还没绑会话：按**选定目录**列；没有目录时保守兜底 ----------
{
  const { c, frames } = makeHarness(commonRows(), { dir: DIR_A });
  c.bindView("v1");
  await openHistory(c, "v1");
  console.log(`  空态未绑会话（选定 ${DIR_A}）：${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A"],
    "空态页显示着哪个目录，历史就按那个目录列（见 `newSessionCwd`：界面那枚胶囊显示的就是它）",
  );
}
{
  const { c, frames } = makeHarness(commonRows(), {
    workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
  });
  c.bindView("v1");
  await openHistory(c, "v1");
  console.log(`  空态未绑会话（没有目录）：${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "used-B", "used-C"],
    "拿不到目录证据时不收紧：按「未分组」列全（与改动前的口径一致——没有 cwd 就无从隔离，" +
      "收紧会把新窗口恢复历史会话的路堵死）",
  );
  assert.ok(
    !(sessionIdsFor(frames, "v1") ?? []).includes("reg-C"),
    "工作区注册表记账的会话仍按「未分组」口径挡在外面",
  );
}

// ---------- 五、打开着文件夹：所有窗口同一份，注册表 / cwd / 已打开域兜底原样 ----------
{
  const folder = stubFolder(DIR_A);
  try {
    const { c, frames } = makeHarness(
      [
        { sessionId: "used-A", cwd: DIR_A },
        { sessionId: "used-B", cwd: DIR_B },
        { sessionId: "used-C", cwd: DIR_C },
        { sessionId: "reg-A", cwd: DIR_A },
        { sessionId: "reg-B", cwd: DIR_B },
      ],
      {
        workspaces: [
          { workspaceId: "ws-a", path: DIR_A, sessionIds: ["reg-A"] },
          { workspaceId: "ws-b", path: DIR_B, sessionIds: ["reg-B"] },
        ],
      },
    );
    c.bindView("v1");
    c.bindView("v2");
    await c.openSession("v1", "used-A");
    await c.openSession("v2", "used-B");
    await openHistory(c, "v1");

    const v1 = sessionIdsFor(frames, "v1");
    const v2 = sessionIdsFor(frames, "v2");
    console.log(`  打开着文件夹：v1=${JSON.stringify(v1)} v2=${JSON.stringify(v2)}`);
    assert.deepStrictEqual(
      v2,
      v1,
      "打开着文件夹时目录跟随 VS Code：所有窗口同一份列表，不做按窗口收窄",
    );
    assert.ok(v1?.includes("reg-A"), "本工作区注册表记账的会话照旧可见（旧口径不许动）");
    assert.ok(
      v1?.includes("used-B"),
      "**任何已打开域**的 cwd 兜底照旧：别的 cwd 的会话只要本窗口开着它，就不许被 cwd 差异滤掉",
    );
    assert.ok(!v1?.includes("used-C"), "既不属于本工作区、也没有被任何窗口打开的会话照旧不可见");
  } finally {
    folder.restore();
  }
}

// ---------- 六、后挂上的窗口同样收得到（收件人是**活窗口名册**，不是某一帧的快照） ----------
{
  const { c, frames } = makeHarness(commonRows(), {
    workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
  });
  c.bindView("v1");
  await c.openSession("v1", "used-A");
  await openHistory(c, "v1");
  frames.length = 0;
  // 用户又开了一个编辑区面板（真实链路上 `ChatViewProvider.attach` 会 `bindView`）
  c.bindView("v3");
  await c.openSession("v3", "used-C");
  await openHistory(c, "v3");
  console.log(
    `  后挂上的 v3（cwd=${DIR_C}）：${JSON.stringify(sessionIdsFor(frames, "v3"))}；v1：${JSON.stringify(sessionIdsFor(frames, "v1"))}`,
  );
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v3"),
    ["used-C", "reg-C"],
    "后挂上的窗口一样要收到属于它自己 cwd 的那一份（收件人是活窗口名册，不是发射那一刻的某一个窗口）；" +
      "同目录里那条**注册表记账**的会话由「任何已打开域的 cwd」兜底放行——那是旧口径，不在这次收窄里",
  );
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A"],
    "新窗口的加入不改变别的窗口那一份",
  );
}

// ---------- 七、绑在**子代理会话**上：cwd 只在权威 session/list 里（全局 history 仍藏它） ----------
//
// 子代理会话被 `visibleSessionRows` 全局藏起来（`origin === 'subagent'`），所以它**不在**
// `this.sessions` 里；但它的 cwd 是权威事实（`session/list` 的原始行里带着），窗口切进
// 子代理页时「当前会话的 cwd」必须照样成立——否则这个窗口的历史会退回跨 cwd 全列。
{
  const { c, client, frames } = makeHarness([
    { sessionId: "parent-A", cwd: DIR_A },
    { sessionId: "used-B", cwd: DIR_B },
    { sessionId: "child", cwd: DIR_A, origin: "subagent", parentSessionId: "parent-A" },
  ]);
  c.bindView("v1");
  await openHistory(c, "v1");
  await c.openSession("v1", "child");
  await openHistory(c, "v1");
  const ids = sessionIdsFor(frames, "v1");
  console.log(
    `  绑子代理会话 child（cwd=${DIR_A}）：列表=${JSON.stringify(ids)}，目录行=${JSON.stringify(workspaceFor(frames, "v1"))}`,
  );
  assert.deepStrictEqual(
    ids,
    ["parent-A"],
    "切进子代理会话时历史仍按**它自己的 cwd** 收窄（cwd 从权威 session/list 读，不因为它不在可见列表里就丢）",
  );
  assert.ok(
    !(ids ?? []).includes("child"),
    "子代理会话照旧不进历史列表（全局隐藏规则不许因为这次收窄被放开）",
  );
  assert.deepStrictEqual(
    workspaceFor(frames, "v1"),
    { path: DIR_A, locked: false },
    "同一刻那行工作目录也要显示子代理会话的 cwd（没有打开文件夹、`newSessionCwd` 为空时不许显示成「未选择工作区」）",
  );

  // 账本是**这一份列表**的投影（整份替换，不是只增不删）：子代理会话从权威列表里
  // 消失后，它那条 cwd 记账必须跟着消失——否则窗口会一直按一个已经不存在的目录收窄。
  assert.strictEqual(c.sessionCwds.get("child"), DIR_A, "前置：账本里有 child 的 cwd（原始行给的）");
  assert.strictEqual(c.sessionCwds.get("parent-A"), DIR_A, "普通会话同样按原始行记进账本");
  client.rows.splice(
    client.rows.findIndex((row) => row.sessionId === "child"),
    1,
  );
  await openHistory(c, "v1");
  console.log(
    `  child 从权威列表消失后：列表=${JSON.stringify(sessionIdsFor(frames, "v1"))}，账本还有 child=${c.sessionCwds.has("child")}`,
  );
  assert.strictEqual(
    c.sessionCwds.has("child"),
    false,
    "整份替换：列表里已经没有的会话不许留着旧 cwd（条目淘汰）",
  );
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["parent-A", "used-B"],
    "账本条目淘汰后回到保守兜底（拿不到当前会话 cwd → 不收窄），而不是按一个过期目录继续收窄",
  );
}

// ---------- 八、换连接 / 断线：权威账本清空（下次列表到达整份重建） ----------
{
  const { c } = makeHarness([
    { sessionId: "parent-A", cwd: DIR_A },
    { sessionId: "child", cwd: DIR_A, origin: "subagent", parentSessionId: "parent-A" },
  ]);
  c.bindView("v1");
  await openHistory(c, "v1");
  await c.openSession("v1", "child");
  assert.strictEqual(c.sessionCwds.get("child"), DIR_A, "前置：账本里有子代理会话的 cwd");
  c.teardownStreams();
  console.log(`  teardownStreams 之后账本条目数=${c.sessionCwds.size}`);
  assert.strictEqual(
    c.sessionCwds.size,
    0,
    "换连接 / 断线收场必须清空权威 cwd 账本（它记的是上一台服务端的 id→cwd，等下次 refreshSessions 重建）",
  );
}

console.log("sessionListScope: 每窗口按当前会话 cwd 隔离、切换即跟随、文件夹旧口径不变 ✓");
