/**
 * 「VS Code 没打开文件夹时，空白页那枚目录胶囊**能反复改目录**」的**行为级**回归：
 * 驱动真 `ChatController`（offline stub），只看假服务端建出来的会话落在哪个 cwd、
 * 以及发自 webview 的那条 `pickWorkspace` 到底弹没弹系统目录选择器。
 *
 * 报障现场（用户 2026-10-10）：「VSCode 未打开文件夹时，空白页可以自己选择目录，
 * 但是目录选择完后还没有发送消息真实创建会话，视觉效果上还是能点击，但实际没有反应，
 * 目录无法修改。」两半根因：
 *
 * 1. **第二次点不弹框**：`askWorkspaceDir` 第一行拿 `hasWorkspaceDir()` 提前返回，
 *    而它的判据里含 `newSessionCwd`——第一次选完目录之后 `newSessionCwd` 有值，
 *    之后再点 `pickWorkspace` 连对话框都不弹（选目录的**唯一**反馈就是那个对话框）；
 * 2. **选完不生效**：就算弹了框、`newSessionCwd` 换成了新目录，`pickWorkspace` 走的
 *    `ensureSession` 见到域就直接返回（「这个窗口已经有会话了」），窗口仍绑在旧目录
 *    那条壳上——界面上写着新目录，会话的 cwd 却还是旧的。目录是**会话的创建事实**
 *    （服务端没有改 cwd 的 API），所以换目录只能换一条壳（见 `rebindWorkspaceDir`）。
 *
 * 钉住五件事：
 * 1. 没打开文件夹时，点那枚胶囊**每次都弹**选择框（第二次、第三次都弹）；
 * 2. 换目录后窗口落到**新目录**那条空壳上（没有就建），旧壳留在服务端不复用；
 * 3. 之后发消息真的发给新目录那条会话（用户报的「还没有真实创建会话」）；
 * 4. 真·工作区（VS Code 打开着文件夹）仍然是锁定口径：不弹框、界面不可改；
 *    已经说过话的会话不因换目录被改写（cwd 是创建事实）；
 * 5. 选中的目录要过**本机身份**门（与「选择其他文件夹…」同一条 `LocalAccessGate`，
 *    见 `localAccess.ts`）：本机不存在的路径被拒绝且**保持原目录**；门那次 await
 *    期间用户又动了手（动作代号 / 关窗 / 文件夹打开 / 提交在飞）则整条选择作废。
 *    这道门是启发式证据，不宣称能识别所有远端部署。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.on("unhandledRejection", (error) => {
  console.error("[workspaceDirRepick] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");
// 与 controller 同一个模块实例（同一次 esbuild 打包 + alias），所以下面替换
// `showOpenDialog` / `workspaceFolders` 能被 controller 看到。
const vscode = await import("vscode");

// 工作区根目录只是字符串（VS Code 的文件夹集合），不必真实存在。
const ROOT_A = "C:\\work\\alpha";
const ROOT_B = "C:\\work\\beta";
// 系统选择器选中的目录必须在本机**真实存在**：宿主用与工作区外 `@` 同一个本机身份门
// 验证后才接受（见 `askWorkspaceDir` / `pickOtherRoot`）。夹具按宿主平台拼绝对路径。
const DIR_A = mkdtempSync(join(tmpdir(), "dsh-chat-dir-a-"));
const DIR_B = mkdtempSync(join(tmpdir(), "dsh-chat-dir-b-"));
process.on("exit", () => {
  for (const dir of [DIR_A, DIR_B]) rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/**
 * 假服务端：`session/create` 把传进来的 `cwd` 记成会话的 cwd（真服务端同源——
 * 会话 header 的 cwd 就是创建参数），`session/list` 只交出现在还留着的行。
 */
function fakeClient() {
  const rows: {
    sessionId: string;
    cwd: string;
    blank: boolean;
    updatedAt: number;
    running: boolean;
  }[] = [];
  const calls: string[] = [];
  const workspaces: string[] = [];
  const prompts: { sessionId: string; content: unknown[] }[] = [];
  return {
    calls,
    workspaces,
    rows,
    prompts,
    async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string) {
      calls.push("session/create");
      // 指名复用一条已有会话（`session/create` 的第二个位置参数）：服务端认得它就**还是
      // 那条**（顺手激活它的 Agent，见 controller 的 `adoptBlankShell`）
      if (reuse !== undefined) {
        const row = rows.find((item) => item.sessionId === reuse);
        if (row) return { sessionId: row.sessionId };
      }
      const sessionId = `session-${rows.length + 1}`;
      rows.push({
        sessionId,
        // 带 `workspaceId` 建会话时服务端取那个工作区的路径作 cwd（真服务端同源）
        cwd: target.cwd ?? workspaces[Number(String(target.workspaceId ?? "").replace("ws-", "")) - 1] ?? "",
        blank: true,
        updatedAt: Date.now() + rows.length,
        running: false,
      });
      return { sessionId };
    },
    async createWorkspace(path: string) {
      calls.push("workspace/create");
      workspaces.push(path);
      return { workspace: { workspaceId: `ws-${workspaces.length}` } };
    },
    async listSessions() {
      calls.push("session/list");
      return { items: rows.map((row) => ({ ...row })) };
    },
    async selectModel(sessionId: string, provider: string, model: string) {
      calls.push("session/selectModel");
      return { selected: { provider, model } };
    },
    async prompt(sessionId: string, content: unknown[]) {
      calls.push("session/prompt");
      prompts.push({ sessionId, content });
      const row = rows.find((item) => item.sessionId === sessionId);
      if (row) row.blank = false;
      return { accepted: true };
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
  };
}

const fakeServer = () => ({
  externalUrl: undefined,
  commandConfigured: true,
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
  frames: Captured[];
  /** 每次 `bindViewToSession` 的目标会话 id，按发生顺序（观察「换绑到哪条壳」）。 */
  binds: string[];
}

interface ControllerInternals {
  client: unknown;
  connection: string;
  sessions: { id: string; cwd: string; blank?: boolean }[];
  viewSessions: Map<string, string>;
  newSessionCwd?: string;
  /** 身份门（`LocalAccessGate`）：测试里换成挂起版本以制造 await 期间的竞态。 */
  localAccess: { allows(path: string, budget: unknown): Promise<boolean> };
  /** 「提交在飞」名额：> 0 时 `canChangeRoot` 为假（见 controller 的 `pendingSends`）。 */
  pendingSends: Map<string, number>;
  bindView(viewId: string): void;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  bindViewToSession(viewId: string, sessionId: string, scope: unknown): void;
  unbindView(viewId: string): void;
}

function makeHarness(options: { dir?: string } = {}): Harness {
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
  const c = controller as unknown as ControllerInternals;
  const binds: string[] = [];
  const raw = c.bindViewToSession.bind(c);
  c.bindViewToSession = (viewId, sessionId, scope) => {
    binds.push(sessionId);
    raw(viewId, sessionId, scope);
  };
  if (options.dir !== undefined) c.newSessionCwd = options.dir;
  const client = fakeClient();
  c.client = client as never;
  c.connection = "connected";
  return { c, client, frames, binds };
}

/** 装一次系统目录选择器：按顺序吐出给定的「用户选择」，同时记账弹了几次。 */
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

/**
 * 把本机身份门换成「挂起 + 手动放行」：用来复现 `await localAccess.allows(...)` 期间
 * 用户又动了手（换动作 / 关窗 / 打开文件夹 / 提交在飞）。`entered` 在门被调用时 resolve，
 * `release` 决定门最后判通过还是拒绝。
 */
function deferredGate(c: ControllerInternals) {
  const gate = c.localAccess;
  const original = gate.allows;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: (allowed: boolean) => void;
  const outcome = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  gate.allows = () => {
    enter();
    return outcome;
  };
  return {
    entered,
    release,
    restore() {
      gate.allows = original;
    },
  };
}

/** 用户点那枚目录胶囊（`EmptyMeta` 的 `WorkspaceChip` 发的就是这条指令）。 */
async function clickChip(c: ControllerInternals, viewId: string) {
  await c.handle({ type: "pickWorkspace" }, viewId);
}

/** 用户敲一条正文并按发送。 */
async function sendMessage(c: ControllerInternals, viewId: string, text: string) {
  await c.handle({ type: "send", text, attachments: [], gesture: "enter" }, viewId);
}

/** 最近一帧 `workspace`（全局 patch 里那一个字段）。 */
function lastWorkspace(frames: Captured[]): { path?: string; locked?: boolean } | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i].frame;
    if (frame.type !== "patch") continue;
    const workspace = (frame.patch as { workspace?: { path?: string; locked?: boolean } }).workspace;
    if (workspace) return workspace;
  }
  return undefined;
}

/** 某个会话 id 在假服务端上的 cwd（认不出就是 undefined）。 */
function cwdOf(client: ReturnType<typeof fakeClient>, sessionId: string | undefined) {
  return client.rows.find((row) => row.sessionId === sessionId)?.cwd;
}

console.log("workspaceDirRepick: 空态页的目录胶囊能反复改目录（驱动真控制器，offline stub）");

// ---------- 一、报障现场：没打开文件夹时，第二次点**照样**要弹选择框 ----------
{
  const dialog = stubDialog([DIR_A, DIR_B]);
  try {
    const { c, client, frames } = makeHarness();
    c.bindView("v1");

    await clickChip(c, "v1");
    const first = c.viewSessions.get("v1");
    console.log(
      `  第一次点击 → 弹框 ${dialog.dialogs.length} 次，窗口落在 ${first}（cwd=${cwdOf(client, first)}）`,
    );
    assert.strictEqual(dialog.dialogs.length, 1, "第一次点击必须弹目录选择框");
    assert.strictEqual(client.rows.length, 1, "选完目录要有本目录那条空壳");
    assert.strictEqual(cwdOf(client, first), DIR_A, "空壳的 cwd 就是刚选的目录");
    assert.deepStrictEqual(
      lastWorkspace(frames),
      { path: DIR_A, locked: false, canPickOther: true },
      "选完目录要把新的工作目录投影回界面（`path` 更新、`locked` 仍是 false = 还能改）",
    );

    // 用户还没发消息（壳还是空的），就想换一个目录：**这一下必须还有反应**
    await clickChip(c, "v1");
    const second = c.viewSessions.get("v1");
    console.log(
      `  第二次点击 → 弹框 ${dialog.dialogs.length} 次，窗口落在 ${second}（cwd=${cwdOf(client, second)}）`,
    );
    assert.strictEqual(
      dialog.dialogs.length,
      2,
      "第二次点击必须**照样**弹目录选择框（用户报的「点了没反应」就是这里被 newSessionCwd 提前返回挡掉）",
    );
    assert.notStrictEqual(second, first, "换了目录就得换到新目录那条壳上（旧壳的 cwd 是创建事实，改不了）");
    assert.strictEqual(cwdOf(client, second), DIR_B, "新壳落在刚选的目录上");
    assert.deepStrictEqual(
      lastWorkspace(frames),
      { path: DIR_B, locked: false, canPickOther: true },
      "界面显示的是新目录，且仍然可改",
    );
    assert.ok(
      client.rows.some((row) => row.sessionId === first && row.blank === true),
      "旧目录那条空壳留在服务端（服务端没有删除 API），只是不再被这个窗口用",
    );
  } finally {
    dialog.restore();
  }
}

// ---------- 二、换目录后发消息：真的发给新目录那条会话 ----------
{
  const dialog = stubDialog([DIR_A, DIR_B]);
  try {
    const { c, client } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    await clickChip(c, "v1");
    await sendMessage(c, "v1", "换目录之后的第一条");

    const target = client.prompts[0]?.sessionId;
    console.log(
      `  换目录后发消息 → prompt 发给 ${target}（cwd=${cwdOf(client, target)}），服务端共 ${client.rows.length} 条会话`,
    );
    assert.strictEqual(client.prompts.length, 1, "第一条消息必须真的发出去");
    assert.strictEqual(
      cwdOf(client, target),
      DIR_B,
      "用户报的「目录选择完后还没有真实创建会话」：这条消息必须落进**新目录**那条会话",
    );
    assert.strictEqual(c.viewSessions.get("v1"), target, "窗口仍绑在它上面");
  } finally {
    dialog.restore();
  }
}

// ---------- 三、取消选择：保持原状，别偷偷换壳 ----------
//
// 点击的反馈就是那个对话框本身（它每次都弹，见第一条）。取消＝用户没改主意，
// 不该顺手建一条会话、也不该把当前这条壳拆掉。
{
  const dialog = stubDialog([DIR_A, undefined]);
  try {
    const { c, client, frames } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    const shell = c.viewSessions.get("v1");
    const creates = client.calls.filter((m) => m === "session/create").length;
    frames.length = 0;

    await clickChip(c, "v1");
    console.log(
      `  取消选择 → 弹框 ${dialog.dialogs.length} 次，会话仍是 ${c.viewSessions.get("v1")}（共 ${client.rows.length} 条）`,
    );
    assert.strictEqual(dialog.dialogs.length, 2, "取消那一次也要弹过框（用户看得见自己的点击有反应）");
    assert.strictEqual(c.viewSessions.get("v1"), shell, "取消之后窗口照旧停在那条壳上");
    assert.strictEqual(
      client.calls.filter((m) => m === "session/create").length,
      creates,
      "取消不许建会话",
    );
    assert.strictEqual(lastWorkspace(frames), undefined, "取消不改工作目录（不推新的 workspace 帧）");
  } finally {
    dialog.restore();
  }
}

// ---------- 四、重复选同一个目录：不重建、不换绑 ----------
{
  const dialog = stubDialog([DIR_A, DIR_A]);
  try {
    const { c, client } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    const shell = c.viewSessions.get("v1");
    const creates = client.calls.filter((m) => m === "session/create").length;
    await clickChip(c, "v1");
    console.log(
      `  重复选同一目录 → 会话仍是 ${c.viewSessions.get("v1")}（共 ${client.rows.length} 条，create ${creates} → ${client.calls.filter((m) => m === "session/create").length}）`,
    );
    assert.strictEqual(c.viewSessions.get("v1"), shell, "目录没变就留在原壳上");
    assert.strictEqual(
      client.calls.filter((m) => m === "session/create").length,
      creates,
      "目录没变不该再建一条会话",
    );
  } finally {
    dialog.restore();
  }
}

// ---------- 五、真·工作区（VS Code 打开着文件夹）：锁定口径不变 ----------
//
// 「只对真工作区早退」是这次改动的界限：打开着文件夹时目录跟随 VS Code，那枚胶囊
// 在界面上是静态文字（`locked === true`），点它也不该弹框。
{
  const folder = stubFolder(ROOT_A);
  const dialog = stubDialog([ROOT_B]);
  try {
    const { c, client, frames } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    console.log(`  打开着文件夹 → 弹框 ${dialog.dialogs.length} 次，workspace=${JSON.stringify(lastWorkspace(frames))}`);
    assert.strictEqual(dialog.dialogs.length, 0, "打开着文件夹时没有可选目录，不许弹框");
    assert.deepStrictEqual(client.rows, [], "目录由 VS Code 给，这里是 stub（没有真文件夹）——不建会话");
    assert.deepStrictEqual(
      lastWorkspace(frames),
      {
        path: ROOT_A,
        locked: true,
        roots: [{ path: ROOT_A, name: "alpha" }],
        canPickOther: true,
      },
      "真工作区必须锁成不可改（空态页那行据此渲染成静态文字）；根目录列表交给输入栏目录胶囊作候选",
    );
  } finally {
    dialog.restore();
    folder.restore();
  }
}

// ---------- 六、已经说过话的会话不因换目录被改写 ----------
//
// 会话的 cwd 是**创建事实**（与 `refreshWorkspace` 的口径一致）：换目录只影响
// 「下一个新会话落在哪」，不该把一条已经在用的对话搬走。这种窗口本来也不在空态页上
// （空态页只在没有消息时渲染），这道判据是防呆。
{
  const dialog = stubDialog([DIR_A, DIR_B]);
  try {
    const { c, client } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    await sendMessage(c, "v1", "先说一句");
    const used = c.viewSessions.get("v1");
    await clickChip(c, "v1");
    console.log(`  已经说过话的会话 → 窗口仍在 ${c.viewSessions.get("v1")}（cwd=${cwdOf(client, c.viewSessions.get("v1"))}）`);
    assert.strictEqual(c.viewSessions.get("v1"), used, "已经开始的会话不因换目录被改写");
    assert.strictEqual(cwdOf(client, used), DIR_A, "它的 cwd 照旧（创建事实）");
  } finally {
    dialog.restore();
  }
}

// ---------- 七、先切、后建：建新壳之前窗口已经退回空态 ----------
//
// 与点「+」同一口径（见 `newSession` 的「先切、后建」）：解绑与推那一帧是**同步**的，
// `session/create` / 拉列表那串往返不许挡在前面——否则换目录要等一整圈往返界面才动。
// 这条失败起来很安静：界面照样会切过去，只是慢半拍，没有报错、没有红断言。
{
  const dialog = stubDialog([DIR_A, DIR_B]);
  try {
    const { c, client, frames } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    frames.length = 0;
    // 建新壳那一刻的现场：窗口应当已经解绑（空态），且空态那一帧已经推给界面
    let boundAtCreate: string | undefined = "（还没建）";
    let stateFramesAtCreate = -1;
    const create = client.createSession;
    client.createSession = async (target, reuse) => {
      boundAtCreate = c.viewSessions.get("v1");
      stateFramesAtCreate = frames.filter(
        ({ target: to, frame }) => to === "v1" && frame.type === "state",
      ).length;
      return create(target, reuse);
    };
    await clickChip(c, "v1");
    console.log(
      `  换目录建新壳那一刻：窗口=${boundAtCreate === undefined ? "空态" : boundAtCreate}，此前已推 ${stateFramesAtCreate} 帧空态`,
    );
    assert.strictEqual(boundAtCreate, undefined, "建新壳之前窗口必须先解绑（先切、后建）");
    assert.ok(stateFramesAtCreate >= 1, "解绑之后要立刻推一帧空态，不许等建壳的往返");
  } finally {
    dialog.restore();
  }
}

// ---------- 八、换回原目录：接回那条还没说过话的旧壳 ----------
//
// 旧壳只是「不再被这个窗口用」，没有被丢掉（服务端没有删除 API）。换回它的目录时
// `reusableBlank` 按 **cwd** 匹配，把这条还空着的壳接回来是对的：反复换目录不该每条都
// 堆一条壳（空壳由窗口共享，用户 2026-11-02 口径）。这条同时证明「按 cwd 复用」不会把
// 新目录的窗口带回旧目录。
{
  const dialog = stubDialog([DIR_A, DIR_B, DIR_A]);
  try {
    const { c, client } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    const shellA = c.viewSessions.get("v1");
    await clickChip(c, "v1");
    const shellB = c.viewSessions.get("v1");
    await clickChip(c, "v1");
    const back = c.viewSessions.get("v1");
    console.log(
      `  A → B → A：${shellA} → ${shellB} → ${back}（服务端共 ${client.rows.length} 条会话）`,
    );
    assert.strictEqual(client.rows.length, 2, "来回换目录不该每条都堆一条壳（同目录那条还空着就接回来）");
    assert.strictEqual(back, shellA, "换回原目录接回那条还没说过话的旧壳");
    assert.strictEqual(cwdOf(client, back), DIR_A, "复用回来的那条 cwd 就是原目录");
    assert.notStrictEqual(back, shellB, "不许把新目录那条壳带回来");
  } finally {
    dialog.restore();
  }
}

// ---------- 九、输入栏目录胶囊：工作区的根目录与「选择其他文件夹…」 ----------
//
// 用户 2026-11-17 口径：打开着文件夹时，空会话也能换到别处——工作区里的另一个根，或系统文件夹
// 选择器选的**任意**目录（不能只给工作区里那几个，否则是半成品）。工作区外的目录不注册成服务端
// 工作区（会长期留在 Web 侧栏），会话按 cwd 建；选回工作区里的根才注册。已有对话不许换。
{
  // 工作区外目录必须真实存在：宿主用与 `@` 同一个本机身份门验证后才接受
  const OUTSIDE = mkdtempSync(join(tmpdir(), "dsh-chat-outside-"));
  const workspace = vscode.workspace as unknown as { workspaceFolders: unknown };
  const originalFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: ROOT_A } }, { uri: { fsPath: ROOT_B } }];
  const dialog = stubDialog([OUTSIDE]);
  try {
    const { c, client, frames } = makeHarness();
    c.bindView("v1");
    await c.handle({ type: "pickOtherRoot" }, "v1");
    const shell = c.viewSessions.get("v1");
    const ws = lastWorkspace(frames) as { path?: string; roots?: string[] } | undefined;
    console.log(`  选其他文件夹 → 会话 ${shell} cwd=${cwdOf(client, shell)}，workspace=${JSON.stringify(ws)}`);
    assert.strictEqual(dialog.dialogs.length, 1, "点「选择其他文件夹…」弹一次系统文件夹选择器");
    assert.ok(shell, "空会话落到新目录那条壳上");
    assert.strictEqual(cwdOf(client, shell), OUTSIDE, "新会话的 cwd 就是选的那个工作区外目录");
    assert.ok(!client.calls.includes("workspace/create"), "工作区外的目录不注册成服务端工作区（会长期留在 Web 侧栏）");
    assert.strictEqual(ws?.path, OUTSIDE, "目录提示显示所选的工作区外目录");
    assert.deepStrictEqual(
      ws?.roots,
      [
        { path: ROOT_A, name: "alpha" },
        { path: ROOT_B, name: "beta" },
      ],
      "工作区的根目录仍作候选交给界面（带展示名）",
    );

    // 选回工作区里的根：注册、cwd 回到那个根
    await c.handle({ type: "switchRoot", path: ROOT_B }, "v1");
    const shellB = c.viewSessions.get("v1");
    console.log(`  选回根 B → 会话 ${shellB} cwd=${cwdOf(client, shellB)}`);
    assert.strictEqual(cwdOf(client, shellB), ROOT_B, "选回工作区里的根：新会话落在那个根");
    assert.deepStrictEqual(client.workspaces, [ROOT_B], "工作区里的根照旧注册成服务端工作区（且只注册这一个）");
    assert.strictEqual((lastWorkspace(frames) as { path?: string }).path, ROOT_B, "目录提示回到所选的根");

    // 不在工作区里的路径不能走 switchRoot（那条只认根目录；工作区外的目录走选择器）
    const before = c.viewSessions.get("v1");
    await c.handle({ type: "switchRoot", path: OUTSIDE }, "v1");
    assert.strictEqual(c.viewSessions.get("v1"), before, "switchRoot 不接受工作区外的路径");

    // 已有对话：不许换（会话 header 的 cwd 是创建事实），且不弹选择器
    await sendMessage(c, "v1", "开始聊");
    const dialogsBefore = dialog.dialogs.length;
    const bound = c.viewSessions.get("v1");
    await c.handle({ type: "pickOtherRoot" }, "v1");
    await c.handle({ type: "switchRoot", path: ROOT_A }, "v1");
    assert.strictEqual(dialog.dialogs.length, dialogsBefore, "已有对话时点「选择其他文件夹…」不弹框");
    assert.strictEqual(c.viewSessions.get("v1"), bound, "已有对话不会被换到别的目录");
  } finally {
    dialog.restore();
    workspace.workspaceFolders = originalFolders;
    rmSync(OUTSIDE, { recursive: true, force: true });
  }
}

// ---------- 十、本机身份门：选中的目录不存在 → 拒绝，原目录不变 ----------
//
// 与「选择其他文件夹…」同一条 `LocalAccessGate`：远端执行世界、本机不存在的路径不许
// 当工作目录（见 `localAccess.ts`）。拒绝**不改** `newSessionCwd`，也不建壳。
{
  const missing = join(tmpdir(), `dsh-chat-missing-${process.pid}-${Date.now()}`);
  const dialog = stubDialog([DIR_A, missing]);
  try {
    const { c, client, frames } = makeHarness();
    c.bindView("v1");
    await clickChip(c, "v1");
    const shell = c.viewSessions.get("v1");
    const rowsBefore = client.rows.length;
    frames.length = 0;
    await clickChip(c, "v1");
    console.log(`  选中不存在的目录 → newSessionCwd=${c.newSessionCwd}，会话仍是 ${c.viewSessions.get("v1")}`);
    assert.strictEqual(c.newSessionCwd, DIR_A, "本机不存在的目录被拒绝，保持原目录");
    assert.strictEqual(c.viewSessions.get("v1"), shell, "窗口不因被拒绝的目录换壳");
    assert.strictEqual(client.rows.length, rowsBefore, "被拒绝的目录不建会话");
    assert.strictEqual(lastWorkspace(frames), undefined, "被拒绝的目录不改工作目录投影");
  } finally {
    dialog.restore();
  }
}

// ---------- 十一、身份门那次 await 期间用户又动了手：这次选择作废 ----------
//
// 门是异步的：等它的来回里用户可能点了「+」（= 同一窗口的新动作代号）。回来时动作代号
// 已经不是这一趟的了，目录与壳都不许落地（与迟到对话框同一口径）。
{
  const dialog = stubDialog([DIR_B]);
  try {
    const { c, client } = makeHarness();
    c.bindView("v1");
    const gate = deferredGate(c);
    try {
      const picking = clickChip(c, "v1");
      await gate.entered;
      await c.handle({ type: "newSession" }, "v1");
      gate.release(true);
      await picking;
      console.log(`  身份检查期间点了「+」 → newSessionCwd=${c.newSessionCwd}，服务端 ${client.rows.length} 条会话`);
      assert.strictEqual(c.newSessionCwd, undefined, "动作代号已换：这次选择作废，不记目录");
      assert.deepStrictEqual(client.rows, [], "作废的选择不建会话");
    } finally {
      gate.restore();
    }
  } finally {
    dialog.restore();
  }
}

console.log("workspaceDirRepick: 目录胶囊每次都弹框、换目录真的换到新目录那条壳上（含先切后建、换回复用与本机身份门）✓");
