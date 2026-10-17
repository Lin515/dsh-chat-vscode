/**
 * 「历史列表跟随**当前会话 cwd**」的**行为级**回归：驱动真 `ChatController`（offline
 * stub），只看每个窗口真正收到的那一帧会话列表（`type: "sessions"`）。
 *
 * 用户 2026-10-10 口径：VS Code **没有打开文件夹**时，每个会话可以各自选一个工作目录
 * （空态页那枚目录胶囊，见 `workspaceDirRepick.test.ts`），于是同一个扩展宿主里可以
 * 同时开着两个 cwd 不同的会话。历史列表必须**按窗口当前那条会话的 cwd 隔离**——
 * 否则「两个面板各自开一个目录」时，两个面板的历史里混着对方的会话。
 *
 * 用户 2026-10-17 追加：没有打开文件夹、窗口还停在**空态**（没选目录）时，列的是
 * **未分组**的会话（不在任何服务端工作区注册记录里）——别的窗口打开过的目录里那些
 * 已分组会话不许漏进来；而这个窗口一旦选了某个目录，**该目录下**的历史（已分组与否）
 * 都要看见。收窄只发生在发帧那一步，全局那份 `this.sessions` 是完整候选：上游先滤掉的话，
 * 「刚选一个还没有已打开域的目录」就再也拿不回该目录里已分组的会话。
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
    async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string) {
      calls.push("session/create");
      // 指名复用一条已有会话（`session/create` 的第二个位置参数）：服务端认得它就**还是
      // 那条**（顺手激活它的 Agent，见 controller 的 `adoptBlankShell`）
      if (reuse !== undefined) {
        const row = rows.find((item) => item.sessionId === reuse);
        if (row) return { sessionId: row.sessionId };
      }
      const sessionId = `created-${rows.length + 1}`;
      rows.push({
        sessionId,
        cwd: target.cwd,
        blank: true,
        updatedAt: Date.now() + rows.length,
        running: false,
        origin: undefined,
        parentSessionId: undefined,
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
  /** 已归档的会话 id（界面上的第二份列表）。 */
  archivedSessionIds: Set<string>;
  /** 权威 cwd 账本（会话 id → cwd，`session/list` 原始行的投影）。 */
  sessionCwds: Map<string, string>;
  bindView(viewId: string): void;
  openSession(viewId: string, sessionId: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  /** 退回空态（「新建对话」的第一步；只解绑，窗口照旧活着）。 */
  detachView(viewId: string): void;
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

/** 归档那一份列表（与 {@link sessionIdsFor} 同一套过线语义）。 */
function archivedIdsFor(frames: Captured[], viewId: string): string[] | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (frame.type !== "archivedSessions") continue;
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
    ["used-A", "blank-A"],
    "没有打开文件夹时，窗口 v1 的历史只许有它当前会话 cwd 下的会话——别人的目录不许混进来；" +
      "同目录那条空壳照旧在列（用户 2026-10-17 口径：空壳不再整行藏起来）",
  );
  assert.deepStrictEqual(
    v2,
    ["used-B", "blank-B"],
    "窗口 v2 同理（两个面板同时开着不同 cwd 时，各自的历史必须互不串）",
  );
  assert.strictEqual(
    (v1 ?? []).includes("blank-B") || (v2 ?? []).includes("blank-A"),
    false,
    "空壳也按 cwd 收窄：别的目录那条空壳不许混进本窗口的列表",
  );
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
    ["used-A", "used-B", "used-C", "reg-C", "blank-A", "blank-B"],
    "全局 this.sessions 是**完整候选**：两个窗口各自 cwd 的会话、所有已分组会话（按窗口收窄" +
      "只在发帧那一步，上游先滤会让「刚选一个还没有已打开域的目录」看不到该目录里已分组的会话）、" +
      "以及**空壳**（复用判据要扫它）都在里面；没有 cwd 的会话照旧不进（它 resume 不了）",
  );
}

// ---------- 二、同一个窗口从 A 切到 B：列表跟着换（不必等下一次拉取） ----------
{
  const { c, frames } = makeHarness(commonRows());
  c.bindView("v1");
  await c.openSession("v1", "used-A");
  await openHistory(c, "v1");
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "blank-A"],
    "先绑 A：只看见 A 的会话（含那条空壳）",
  );

  await c.openSession("v1", "used-B");
  console.log(`  切到 B 之后的 v1：${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-B", "blank-B"],
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
    assert.deepStrictEqual(sessionIdsFor(frames, "v1"), ["used-A", "blank-A"], "换目录之前：看见 A 的历史");

    await c.handle({ type: "pickWorkspace" }, "v1");
    const bound = c.viewSessions.get("v1");
    console.log(
      `  换到 ${DIR_B} 之后 v1 绑在 ${bound}（cwd=${client.rows.find((r) => r.sessionId === bound)?.cwd}），列表：${JSON.stringify(sessionIdsFor(frames, "v1"))}`,
    );
    assert.strictEqual(bound, "blank-B", "换目录落到新目录那条空壳上（复用，不新建）");
    assert.deepStrictEqual(
      sessionIdsFor(frames, "v1"),
      ["used-B", "blank-B"],
      "换选目录之后历史列表跟到新目录（旧目录的会话不再出现）",
    );
  } finally {
    dialog.restore();
  }
}

// ---------- 四、新建空页还没绑会话：按**选定目录**列；没有目录时列「未分组」 ----------
{
  const { c, frames } = makeHarness(commonRows(), { dir: DIR_A });
  c.bindView("v1");
  await openHistory(c, "v1");
  console.log(`  空态未绑会话（选定 ${DIR_A}）：${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "blank-A"],
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
    ["used-A", "used-B", "used-C", "blank-A", "blank-B"],
    "拿不到目录证据时按「未分组」列：不在任何服务端工作区注册记录里的行照列" +
      "（used-* 与空壳），分组过的行挡在外面；不拿另一个目录去猜",
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
      "同目录里那条**注册表记账**的会话照样可见——没打开文件夹、窗口有目录时只按 cwd 过滤，不看注册表分组",
  );
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "blank-A"],
    "新窗口的加入不改变别的窗口那一份",
  );
}

// ---------- 七、绑在**子代理会话**上：cwd 只在权威 session/list 里（全局 history 仍藏它） ----------
//
// 子代理会话被 `visibleSessionRows` 全局藏起来（`origin === 'subagent'`），所以它**不在**
// `this.sessions` 里；但它的 cwd 是权威事实（`session/list` 的原始行里带着），窗口切进
// 子代理页时「当前会话的 cwd」必须照样成立——否则这个窗口的历史读不到目录证据，会退回「未分组」那一档。
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
    "账本条目淘汰后回到「未分组」兜底（拿不到当前会话 cwd 就按未分组列），而不是按一个过期目录继续收窄",
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

// ---------- 九、空态窗口不许漏出**别的窗口开着**的已分组目录 ----------
//
// 用户 2026-10-17 口径：没打开文件夹时，空会话（还没选目录）的历史列**未分组**的会话。
// 「别的窗口此刻开着 DIR_C 的域」不是这个窗口该看它的理由——上游那份 `openCwds` 兜底只
// 属于「打开着文件夹」那一档；漏出去的表现就是空态窗口里冒出别人的项目会话。
{
  const { c, frames } = makeHarness(commonRows(), {
    workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
  });
  c.bindView("v1");
  c.bindView("v2");
  // v2 打开 DIR_C 里那条**已分组**的会话（此刻它的域是活的，cwd 进了 openCwds）
  await c.openSession("v2", "reg-C");
  await openHistory(c, "v1");
  await openHistory(c, "v2");
  const v1 = sessionIdsFor(frames, "v1") ?? [];
  const v2 = sessionIdsFor(frames, "v2") ?? [];
  console.log(`  别的窗口开着 ${DIR_C}：v1（空态）=${JSON.stringify(v1)} v2=${JSON.stringify(v2)}`);
  assert.deepStrictEqual(
    v1,
    ["used-A", "used-B", "used-C", "blank-A", "blank-B"],
    "空态窗口（没有目录）只列**未分组**的会话：已分组的那条由它的目录决定，不是由别人开着它决定",
  );
  assert.ok(!v1.includes("reg-C"), "别的窗口开着 DIR_C 的域，不许把那条已分组会话漏进空态窗口");
  assert.ok(v2.includes("reg-C"), "开着它的那个窗口照旧看得见（按窗口收窄，不是全局藏掉）");
}

// ---------- 十、选目录那一刻就能看见该目录里**已分组**的会话（上游不许先滤掉） ----------
//
// 现场：用户在空态选了目录 D，那个目录**还没有任何已打开域**（第一次进这个项目）。
// 上游若先按「未分组」或「已打开域」收窄，注册表里记在这条工作区下的会话就永远找不回来
// ——纯函数改对了也没用，因为数据在更早那一步就没了。这一档同时钉住两件事：
// 全局候选里有它，且按窗口收窄之后它确实出现在这个目录那一份里。
{
  const dialog = stubDialog([DIR_C]);
  try {
    const { c, frames } = makeHarness(commonRows(), {
      workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
    });
    c.bindView("v1");
    await openHistory(c, "v1");
    assert.deepStrictEqual(
      sessionIdsFor(frames, "v1"),
      ["used-A", "used-B", "used-C", "blank-A", "blank-B"],
      "选目录之前：空态只列未分组（已分组那条属于某个目录，此刻还没有目录证据）",
    );
    assert.ok(
      c.sessions.some((row) => row.id === "reg-C"),
      "全局候选里必须有它——上游先滤掉的话，下面按目录收窄那一步再也拿不到这一行",
    );

    await c.handle({ type: "pickWorkspace" }, "v1");
    const ids = sessionIdsFor(frames, "v1") ?? [];
    console.log(`  选中 ${DIR_C}（此前没有已打开域）：${JSON.stringify(ids)}`);
    assert.ok(ids.includes("used-C"), "该目录里未分组的会话照旧可见");
    assert.ok(ids.includes("reg-C"), "该目录里**已分组**的会话同样可见（用户口径是这个目录下的历史）");
    assert.ok(!ids.includes("used-A") && !ids.includes("used-B"), "别的目录的会话不许混进来");
  } finally {
    dialog.restore();
  }
}

// ---------- 十一、active 与 archived 两份列表都按窗口隔离 ----------
{
  const { c, frames } = makeHarness(commonRows(), {
    workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
  });
  c.bindView("v1");
  c.bindView("v2");
  // 用户把两条不同目录的会话各归档一条
  c.archivedSessionIds.add("used-A");
  c.archivedSessionIds.add("used-B");
  c.archivedSessionIds.add("reg-C");
  await c.openSession("v1", "used-A");
  await c.openSession("v2", "used-B");
  await openHistory(c, "v1");
  await openHistory(c, "v2");
  console.log(
    `  归档也隔离：v1 active=${JSON.stringify(sessionIdsFor(frames, "v1"))} archived=${JSON.stringify(archivedIdsFor(frames, "v1"))}；` +
      `v2 archived=${JSON.stringify(archivedIdsFor(frames, "v2"))}`,
  );
  assert.deepStrictEqual(archivedIdsFor(frames, "v1"), ["used-A"], "归档那一份同样按 cwd 收窄");
  assert.deepStrictEqual(archivedIdsFor(frames, "v2"), ["used-B"], "另一个窗口的归档列表只含它自己目录的");
  assert.deepStrictEqual(sessionIdsFor(frames, "v1"), ["blank-A"], "归档过的会话不再出现在 active 那份里");
  assert.ok(
    !(archivedIdsFor(frames, "v1") ?? []).includes("reg-C"),
    "别的目录里归档的会话不许出现在这个窗口的归档列表里",
  );
}

// ---------- 十二、换目录 / 退回空态：那一刻就重发帧（不必等下一次拉取） ----------
{
  const dialog = stubDialog([DIR_B]);
  try {
    const { c, client, frames } = makeHarness(commonRows(), {
      workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
    });
    c.bindView("v1");
    await c.openSession("v1", "used-A");
    await openHistory(c, "v1");
    assert.deepStrictEqual(sessionIdsFor(frames, "v1"), ["used-A", "blank-A"], "前置：先看见 A 的");

    // 退回空态（点「+」的第一步）：列表立刻换成「未分组」那一档
    const before = frames.length;
    c.detachView("v1");
    const afterDetach = frames.slice(before).filter(({ frame }) => frame.type === "sessions" && frame.sessions !== undefined);
    console.log(`  退回空态后立刻发的列表帧：${afterDetach.length} 条 → ${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
    assert.ok(afterDetach.length > 0, "退回空态必须**当场**重发列表帧（否则界面还停在旧目录那一份）");
    assert.deepStrictEqual(
      sessionIdsFor(frames, "v1"),
      ["used-A", "used-B", "used-C", "blank-A", "blank-B"],
      "没有选目录时退回空态 → 换成未分组那一档",
    );

    // 空态里选目录：同样当场重发（`askWorkspaceDir` 走 `emitViewScopedState`）
    await c.handle({ type: "pickWorkspace" }, "v1");
    const bound = c.viewSessions.get("v1");
    const cwd = client.rows.find((row) => row.sessionId === bound)?.cwd;
    console.log(`  空态选 ${DIR_B} → 绑在 ${bound}（cwd=${cwd}）：${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
    assert.ok(
      (sessionIdsFor(frames, "v1") ?? []).includes("used-B"),
      "选目录那一刻跟着换成该目录那一份",
    );
    assert.ok(!(sessionIdsFor(frames, "v1") ?? []).includes("used-A"), "旧目录的会话立刻消失");
  } finally {
    dialog.restore();
  }
}

// ---------- 十三、`replace` 增量：完整值整份替换（含空集合），其后增量照旧 ----------
//
// 官方 `WorkspaceFollowIncrement.replace` 带一整份 `WorkspaceBaseline`，在**同一代内**替换此前
// 交付的全部状态（不是新一代的开帧）；官方客户端 `acceptIncrement` 的 `case 'replace'` 直接走
// `replaceBaseline()` —— `items` 整份替换注册表、`archivedSessionIds` 整份替换归档集合，与
// `baseline` 同一条路径。本段钉四件事：非空 replace 是**替换不是合并**、空集合**真清空**、
// 其后 `upsert` / `remove` / `archived` 增量照旧、同帧缺 `archivedSessionIds` 时照旧不动归档
// 集合（`mentionResolve.test.ts` 旧夹具的分工，见本段最后一段）。
{
  const { c, client, frames } = makeHarness(commonRows(), {
    workspaces: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
  });
  const cast = c as unknown as { onWorkspaceFrame(frame: unknown): void };
  c.bindView("v1");
  await openHistory(c, "v1");
  console.log(`  前置 baseline：${JSON.stringify(sessionIdsFor(frames, "v1"))}`);
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "used-B", "used-C", "blank-A", "blank-B"],
    "前置：注册表里的 reg-C 不算未分组，不出现",
  );

  // 这一段此前的状态：一条归档增量（只有归档变化 → 只重发列表，不查 session/list）
  const listCallsBeforeArchive = client.calls.filter((call) => call === "session/list").length;
  cast.onWorkspaceFrame({ type: "archived", archivedSessionIds: ["used-A"] });
  assert.strictEqual(
    client.calls.filter((call) => call === "session/list").length,
    listCallsBeforeArchive,
    "仅归档变化不查 session/list（手上那份全局候选照旧够用）",
  );
  await openHistory(c, "v1");
  assert.deepStrictEqual(archivedIdsFor(frames, "v1"), ["used-A"], "前置：归档增量生效");
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-B", "used-C", "blank-A", "blank-B"],
    "前置：归档的那条离开活动列表",
  );

  // ★ 非空 replace：注册表与归档集合都换成**另一份**，旧的一条都不留（不是合并、也不是清空）
  const listCallsBeforeReplace = client.calls.filter((call) => call === "session/list").length;
  cast.onWorkspaceFrame({
    type: "replace",
    value: {
      items: [{ workspaceId: "ws-z", path: DIR_B, sessionIds: ["used-B", "blank-B"] }],
      archivedSessionIds: ["used-C"],
    },
  });
  await openHistory(c, "v1");
  console.log(
    `  非空 replace 后：workspaces=${JSON.stringify(c.workspaces)} archived=${JSON.stringify([...c.archivedSessionIds])}`,
  );
  assert.deepStrictEqual(
    c.workspaces,
    [{ workspaceId: "ws-z", path: DIR_B, sessionIds: ["used-B", "blank-B"] }],
    "`items` 整份替换：旧工作区 ws-c 消失、新工作区 ws-z 生效，不是把两份并起来",
  );
  assert.deepStrictEqual(
    [...c.archivedSessionIds],
    ["used-C"],
    "`archivedSessionIds` 整份替换：旧的 used-A 不在新集合里就出局，不是并集",
  );
  assert.ok(
    client.calls.filter((call) => call === "session/list").length > listCallsBeforeReplace,
    "注册表整份替换要**重算**（refreshSessions）：谁属于哪个工作区变了，光重发旧列表不够",
  );
  assert.deepStrictEqual(archivedIdsFor(frames, "v1"), ["used-C"], "归档那一份列表跟着换");
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "reg-C", "blank-A"],
    "ws-z 那两条被记账挡掉、used-C 被归档挡掉，未分组里剩的照列（ws-c 没了 → reg-C 回来）",
  );

  // ★ 空 replace：注册表与归档集合都清掉，先前被记账 / 归档的会话全部回到未分组活动列表
  cast.onWorkspaceFrame({ type: "replace", value: { items: [], archivedSessionIds: [] } });
  await openHistory(c, "v1");
  console.log(
    `  空 replace 后：workspaces=${JSON.stringify(c.workspaces)} archived=${JSON.stringify([...c.archivedSessionIds])}` +
      ` → ${JSON.stringify(sessionIdsFor(frames, "v1"))}`,
  );
  assert.deepStrictEqual(c.workspaces, [], "`items` 是权威全量值：空数组就清空注册表");
  assert.strictEqual(c.archivedSessionIds.size, 0, "`archivedSessionIds` 是权威全量值：空数组就清空归档集合");
  assert.deepStrictEqual(archivedIdsFor(frames, "v1"), [], "归档那一份列表帧也要跟着空");
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "used-B", "used-C", "reg-C", "blank-A", "blank-B"],
    "注册表与归档一起清空 → 原先分组 / 归档的会话全部回到未分组活动列表",
  );

  // `replace` 之后，增量语义照旧：upsert 换一条、archived 只动归档、remove 去掉一条
  cast.onWorkspaceFrame({
    type: "upsert",
    workspace: { workspaceId: "ws-a", path: DIR_A, sessionIds: ["used-A", "blank-A"] },
  });
  await openHistory(c, "v1");
  assert.deepStrictEqual(
    c.workspaces,
    [{ workspaceId: "ws-a", path: DIR_A, sessionIds: ["used-A", "blank-A"] }],
    "replace 之后的 upsert 仍按 workspaceId 换 / 增",
  );
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-B", "used-C", "reg-C", "blank-B"],
    "upsert 那条工作区里的会话随即算「已分组」，离开空态窗口的未分组列表",
  );

  const listCallsBeforeArchived = client.calls.filter((call) => call === "session/list").length;
  cast.onWorkspaceFrame({ type: "archived", archivedSessionIds: ["used-C"] });
  assert.strictEqual(
    client.calls.filter((call) => call === "session/list").length,
    listCallsBeforeArchived,
    "replace 之后「仅归档变化不查 session/list」这条也没被破坏",
  );
  await openHistory(c, "v1");
  assert.deepStrictEqual(archivedIdsFor(frames, "v1"), ["used-C"], "replace 之后的 archived 增量仍整份生效");

  cast.onWorkspaceFrame({ type: "remove", workspaceId: "ws-a" });
  await openHistory(c, "v1");
  assert.deepStrictEqual(c.workspaces, [], "replace 之后的 remove 仍能去掉一条");
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "used-B", "reg-C", "blank-A", "blank-B"],
    "工作区没了 → 那两条回到未分组；归档的 used-C 照旧不在活动列表里",
  );

  // 既有边界：`baseline` 只给 `items`（省略 `archivedSessionIds`）时**不动**归档集合
  cast.onWorkspaceFrame({
    type: "baseline",
    value: { items: [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }] },
  });
  await openHistory(c, "v1");
  assert.deepStrictEqual(
    [...c.archivedSessionIds],
    ["used-C"],
    "baseline 缺 `archivedSessionIds` 时照旧不动（mentionResolve 旧夹具的分工，不许被这次改动收窄）",
  );
  assert.deepStrictEqual(archivedIdsFor(frames, "v1"), ["used-C"], "归档列表那一帧也照旧");
  assert.deepStrictEqual(
    c.workspaces,
    [{ workspaceId: "ws-c", path: DIR_C, sessionIds: ["reg-C"] }],
    "同时 `items` 仍整份替换",
  );
  assert.deepStrictEqual(
    sessionIdsFor(frames, "v1"),
    ["used-A", "used-B", "blank-A", "blank-B"],
    "reg-C 重新被记账 → 又从未分组列表里退出",
  );
}

console.log("sessionListScope: 每窗口按当前会话 cwd 隔离、切换即跟随、文件夹旧口径不变 ✓");
