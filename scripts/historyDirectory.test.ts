/**
 * 多根工作区的**宿主行为级**回归：每窗口的新会话根、工作区注册缓存、发送 / 落壳竞态，以及
 * 历史抽屉的只读范围（`ChatState.history`）。
 *
 * 全部驱动真 `ChatController`（离线 vscode stub + 假服务端），不启动真实 DSH、不发模型请求。
 * 钉住的口径：
 *
 * 1. **每窗口的根**：另一个窗口换根不覆盖本窗口；`workspaceState` 只记默认偏好；
 * 2. **工作区外目录**：当前宿主内有效、按 cwd 建会话、**不注册**服务端工作区；远端窗口
 *    （系统选择器给的是本机路径）明确禁用；
 * 3. **注册缓存**：按连接 + 目录 + 是否注册分键，切根 / 移除根不会沿用旧 workspaceId；
 * 4. **竞态**：切根后立即发送只落新根；发送先于选择框返回时 `beginSend` 同步冻结目录，
 *    晚返回的选择框不能污染新动作 / 关窗；反过来（选择先完成）发送落新目录；连续换根时
 *    先发起的建会话晚完成也不能把窗口绑回旧根；
 * 5. **历史范围**：默认当前会话创建目录 / 本窗预选目录，`roots` 混合全部根，`directory`
 *    只看指定目录；切换范围不发注册 / 建会话、只发给本窗口；
 * 6. **旧列表帧不变**：`sessions` / `archivedSessions` 仍按旧口径发（jobs 等消费者）；
 * 7. **首帧 / 恢复帧**：`ready` 与打开会话的整份 `state` 都带 `history` 镜像；
 * 8. **工作区文件夹变化**：旧根的空壳在第一个 await 之前失去发送资格，已有历史会话不重绑；
 * 9. **POSIX 大小写**：`directoryPathKey` 在历史范围里保留大小写（Windows 形态才忽略）。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、无 token）。
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.on("unhandledRejection", (error) => {
  console.error("[historyDirectory] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");
const vscode = await import("vscode");

const DIR_A = "C:\\work\\alpha";
const DIR_B = "C:\\work\\beta";
const DIR_C = "C:\\work\\gamma";

interface Row {
  sessionId: string;
  cwd?: string;
  blank?: boolean;
  updatedAt?: number;
  running?: boolean;
  origin?: string;
  parentSessionId?: string;
}

interface Captured {
  target: "all" | string;
  frame: Record<string, unknown>;
}

/**
 * 假服务端：`session/create` 把 `cwd`（或 workspaceId 对应的路径）记成会话 cwd；
 * `workspace/create` 幂等登记目录并返回自增 id（便于断言用了哪一个）。
 */
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
  const workspaces: { workspaceId: string; path: string }[] = [];
  const created: { sessionId: string; cwd?: string; workspaceId?: string }[] = [];
  const prompts: { sessionId: string; content: unknown[] }[] = [];
  return {
    rows,
    calls,
    workspaces,
    created,
    prompts,
    async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string) {
      calls.push("session/create");
      if (reuse !== undefined) {
        const row = rows.find((item) => item.sessionId === reuse);
        if (row) return { sessionId: row.sessionId };
      }
      const sessionId = `created-${rows.length + 1}`;
      const cwd =
        target.cwd ?? workspaces.find((item) => item.workspaceId === target.workspaceId)?.path ?? "";
      rows.push({
        sessionId,
        cwd,
        blank: true,
        updatedAt: Date.now() + rows.length,
        running: false,
        origin: undefined,
        parentSessionId: undefined,
      });
      created.push({ sessionId, cwd, workspaceId: target.workspaceId });
      return { sessionId };
    },
    async createWorkspace(path: string) {
      calls.push("workspace/create");
      const hit = workspaces.find((item) => item.path === path);
      if (hit) return { workspace: { workspaceId: hit.workspaceId } };
      const workspaceId = `ws-${workspaces.length + 1}`;
      workspaces.push({ workspaceId, path });
      return { workspace: { workspaceId } };
    },
    async listSessions() {
      calls.push("session/list");
      return { items: rows.map((row) => ({ ...row })) };
    },
    async selectModel(sessionId: string) {
      calls.push("session/selectModel");
      return { selected: { provider: "p", model: "m" } };
    },
    async prompt(sessionId: string, content: unknown[]) {
      calls.push("session/prompt");
      prompts.push({ sessionId, content });
      const row = rows.find((item) => item.sessionId === sessionId);
      if (row) row.blank = false;
      return { accepted: true };
    },
    async archiveSession() {
      calls.push("session/archive");
    },
    async unarchiveSession() {
      calls.push("session/unarchive");
    },
    async request(method: string) {
      calls.push(method);
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
  commandConfigured: true,
  onHeartbeat() {},
  snapshot() {
    return { status: { info: undefined }, supervisorAlive: false };
  },
});

const fakeMemento = () => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

interface Internals {
  client: unknown;
  connection: string;
  workspaces: { workspaceId: string; path: string; sessionIds: string[] }[];
  sessions: { id: string; cwd?: string; blank?: boolean }[];
  historySessions: { id: string; cwd?: string; blank?: boolean }[];
  viewSessions: Map<string, string>;
  newSessionCwd?: string;
  archivedSessionIds: Set<string>;
  viewRootChoices: Map<string, { kind: string; path: string }>;
  deletedSessionIds: Set<string>;
  findSessionDir(sessionId: string): string | undefined;
  applySessionStatus(event: string, args: readonly unknown[]): boolean;
  bindView(viewId: string): void;
  unbindView(viewId: string): void;
  snapshotFor(viewId: string | undefined): Record<string, unknown>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  applyWorkspaceFoldersChange(): Promise<void>;
}

interface Harness {
  c: Internals;
  client: ReturnType<typeof fakeClient>;
  frames: Captured[];
  globalState: ReturnType<typeof fakeMemento>;
  workspaceState: ReturnType<typeof fakeMemento>;
}

function makeHarness(seed: Row[], options: { folders?: string[]; dir?: string } = {}): Harness {
  const workspaceState = fakeMemento();
  const globalState = fakeMemento();
  stubFolders(options.folders ?? []);
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    globalState as never,
    workspaceState as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  (
    controller as never as { subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  const c = controller as unknown as Internals;
  if (options.dir !== undefined) c.newSessionCwd = options.dir;
  const client = fakeClient(seed);
  c.client = client as never;
  c.connection = "connected";
  return { c, client, frames, globalState, workspaceState };
}

function stubFolders(paths: string[]) {
  const workspace = vscode.workspace as unknown as { workspaceFolders: unknown };
  workspace.workspaceFolders = paths.map((path) => ({ uri: { fsPath: path } }));
}

/** 装一次系统目录选择器：`answers` 依次返回；`undefined` = 取消。 */
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
    return [{ fsPath: answer, scheme: "file" }];
  };
  return {
    dialogs,
    restore() {
      (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = original;
    },
  };
}

/** 可手动结算的对话框（晚返回竞态用）。 */
function deferredDialog() {
  let resolve!: (value: { fsPath: string; scheme: string }[] | undefined) => void;
  const promise = new Promise<{ fsPath: string; scheme: string }[] | undefined>((done) => {
    resolve = done;
  });
  const original = vscode.window.showOpenDialog;
  (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = () => promise;
  return {
    resolve(value?: string) {
      resolve(value === undefined ? undefined : [{ fsPath: value, scheme: "file" }]);
    },
    restore() {
      (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = original;
    },
  };
}

const idOf = (row: { id: string }): string => row.id;

/** 某个窗口最近一帧 `history`（patch 或 state 快照）。 */
function historyFor(frames: Captured[], viewId: string): Record<string, unknown> | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target !== "all" && target !== viewId) continue;
    const source =
      frame.type === "patch" ? (frame.patch as Record<string, unknown>) : frame.type === "state" ? (frame.state as Record<string, unknown>) : undefined;
    const history = source?.history as Record<string, unknown> | undefined;
    if (history) return history;
  }
  return undefined;
}

function historyIds(frames: Captured[], viewId: string, archived = false): string[] | undefined {
  const history = historyFor(frames, viewId);
  if (!history) return undefined;
  const rows = (archived ? history.archivedSessions : history.sessions) as { id: string }[];
  return rows.map(idOf);
}

/** 某个窗口最近一帧 `workspace`（patch / state）。 */
function workspaceFor(frames: Captured[], viewId: string): Record<string, unknown> | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target !== "all" && target !== viewId) continue;
    const source =
      frame.type === "patch" ? (frame.patch as Record<string, unknown>) : frame.type === "state" ? (frame.state as Record<string, unknown>) : undefined;
    const workspace = source?.workspace as Record<string, unknown> | undefined;
    if (workspace) return workspace;
  }
  return undefined;
}

async function bindAndRefresh(h: Harness, viewId: string): Promise<void> {
  h.c.bindView(viewId);
  await h.c.handle({ type: "listSessions" }, viewId);
}

async function open(h: Harness, viewId: string, sessionId: string): Promise<void> {
  await h.c.handle({ type: "openSession", sessionId }, viewId);
}

async function send(h: Harness, viewId: string, text = "hello"): Promise<void> {
  await h.c.handle({ type: "send", text, attachments: [], gesture: "enter" }, viewId);
}

function createdCwd(client: ReturnType<typeof fakeClient>, sessionId: string | undefined): string | undefined {
  return client.rows.find((row) => row.sessionId === sessionId)?.cwd;
}

console.log("historyDirectory: 根选择 / 注册缓存 / 竞态 / 历史范围（驱动真控制器）");

// ---------- 一、首帧（ready）与打开会话的整份快照都带 history 镜像 ----------
{
  const h = makeHarness(
    [
      { sessionId: "used-A", cwd: DIR_A },
      { sessionId: "arch-A", cwd: DIR_A },
      { sessionId: "used-B", cwd: DIR_B },
    ],
    { folders: [DIR_A] },
  );
  h.c.archivedSessionIds.add("arch-A");
  await bindAndRefresh(h, "v1");
  h.frames.length = 0;
  await h.c.handle({ type: "ready" }, "v1");
  const ready = h.frames.find((item) => item.frame.type === "state")?.frame.state as Record<string, unknown>;
  const mirror = ready?.history as Record<string, unknown>;
  console.log(`  ready 快照 history=${JSON.stringify(mirror?.scope)} sessions=${JSON.stringify((mirror?.sessions as { id: string }[])?.map(idOf))}`);
  assert.ok(mirror, "ready 的首帧必须带 history 镜像（不能等下一次 listSessions）");
  assert.deepStrictEqual(mirror.scope, { kind: "current" }, "默认范围是 current");
  assert.deepStrictEqual((mirror.sessions as { id: string }[]).map(idOf), ["used-A"], "cur 只看当前会话目录");
  assert.deepStrictEqual((mirror.archivedSessions as { id: string }[]).map(idOf), ["arch-A"], "归档那一份也按范围收窄");
  const roots = mirror.roots as { path: string; name: string }[];
  assert.deepStrictEqual(roots, [{ path: DIR_A, name: "alpha" }], "根目录候选带展示名（DirectoryOption）");

  h.frames.length = 0;
  await open(h, "v1", "used-A");
  const opened = h.frames.find((item) => item.frame.type === "state")?.frame.state as Record<string, unknown>;
  assert.ok(opened?.history, "打开 / 恢复会话的整份快照同样带 history");
  assert.deepStrictEqual((opened.history as Record<string, unknown>).scope, { kind: "current" });
}

// 创建成功但名册还没列出新空壳时，历史不应短暂放宽到未分组。
{
  const h = makeHarness([
    { sessionId: "used-A", cwd: DIR_A },
    { sessionId: "used-B", cwd: DIR_B },
  ], { folders: [DIR_A, DIR_B] });
  const list = h.client.listSessions.bind(h.client);
  h.client.listSessions = async () => ({ items: (await list()).items.filter((row) => !row.blank) });
  await bindAndRefresh(h, "v1");
  await h.c.handle({ type: "switchRoot", path: DIR_B }, "v1");
  assert.ok(h.c.viewSessions.get("v1"), "新空壳已经绑定");
  assert.deepStrictEqual(historyIds(h.frames, "v1"), ["used-B"], "名册延迟时仍使用新空壳的创建目录");
}

// ---------- 二、历史默认跟随本窗口当前会话；指定目录只影响本窗口 ----------
{
  const h = makeHarness(
    [
      { sessionId: "used-A", cwd: DIR_A },
      { sessionId: "reg-A2", cwd: DIR_A },
      { sessionId: "used-B", cwd: DIR_B },
      { sessionId: "used-C", cwd: DIR_C },
      { sessionId: "arch-B", cwd: DIR_B },
    ],
    { folders: [DIR_A, DIR_B] },
  );
  h.c.archivedSessionIds.add("arch-B");
  h.c.workspaces = [{ workspaceId: "ws-a", path: DIR_A, sessionIds: ["reg-A2"] }];
  await bindAndRefresh(h, "v1");
  await bindAndRefresh(h, "v2");
  await open(h, "v1", "used-A");
  await open(h, "v2", "used-B");
  assert.deepStrictEqual(historyIds(h.frames, "v1"), ["used-A", "reg-A2"], "v1 只看 A（含注册表记账的会话）");
  assert.deepStrictEqual(historyIds(h.frames, "v2"), ["used-B"], "v2 默认只看 B，看不到 A");

  const v2Before = historyIds(h.frames, "v2");
  const creates = h.client.calls.filter((call) => call === "session/create").length;
  const registers = h.client.calls.filter((call) => call === "workspace/create").length;
  h.frames.length = 0;
  await h.c.handle({ type: "historyScope", scope: { kind: "roots" } }, "v1");
  const roots = historyFor(h.frames, "v1") as Record<string, unknown>;
  console.log(`  roots 范围：v1=${JSON.stringify(historyIds(h.frames, "v1"))} v2=${JSON.stringify(historyIds(h.frames, "v2"))}`);
  assert.deepStrictEqual(historyIds(h.frames, "v1"), ["used-A", "reg-A2", "used-B"], "roots 是全部根的并集");
  assert.strictEqual(roots.mixedDirectories, true, "跨目录时 mixedDirectories 为真");
  assert.deepStrictEqual((roots.scope as unknown), { kind: "roots" });
  assert.deepStrictEqual(
    (roots.archivedSessions as { id: string }[]).map(idOf),
    ["arch-B"],
    "roots 范围的归档列表同样按范围收窄（B 的归档会话在列）",
  );
  assert.deepStrictEqual(v2Before, ["used-B"], "v2 的范围在 v1 切换前是它自己的目录");
  assert.deepStrictEqual((roots.roots as { path: string }[]).map((root) => root.path), [DIR_A, DIR_B]);
  assert.ok(!("otherDirectories" in roots), "服务端的其他目录不下发为历史候选");
  assert.strictEqual(historyIds(h.frames, "v2"), undefined, "v1 切范围不改 v2（没有发给 v2 的新帧）");

  h.frames.length = 0;
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: DIR_B } }, "v1");
  assert.deepStrictEqual(historyIds(h.frames, "v1"), ["used-B"], "directory 只列指定目录");
  assert.strictEqual((historyFor(h.frames, "v1") as Record<string, unknown>).mixedDirectories, false);
  assert.ok(
    h.frames.every((item) => item.target === "v1"),
    "范围帧只发给本窗口，不广播到别的窗口",
  );
  assert.strictEqual(
    h.client.calls.filter((call) => call === "session/create").length,
    creates,
    "浏览历史不建会话",
  );
  assert.strictEqual(
    h.client.calls.filter((call) => call === "workspace/create").length,
    registers,
    "浏览历史不注册服务端工作区",
  );
  assert.strictEqual(
    h.client.calls.filter((call) => call === "session/list").length,
    2,
    "浏览历史不再额外拉列表（只有两次 bindAndRefresh）",
  );
}

// ---------- 二b、roots 范围只认根目录本身，严格子目录不算（精确匹配） ----------
{
  const childA = DIR_A + "\\\\sub";
  const childB = DIR_B + "\\\\nested";
  const h = makeHarness(
    [
      { sessionId: "root-A", cwd: DIR_A },
      { sessionId: "child-A", cwd: childA },
      { sessionId: "root-B", cwd: DIR_B },
      { sessionId: "child-B", cwd: childB },
    ],
    { folders: [DIR_A, DIR_B] },
  );
  await bindAndRefresh(h, "v1");
  await open(h, "v1", "root-A");
  assert.deepStrictEqual(historyIds(h.frames, "v1"), ["root-A"], "current 只看当前会话的创建目录本身");
  h.frames.length = 0;
  await h.c.handle({ type: "historyScope", scope: { kind: "roots" } }, "v1");
  console.log(`  roots 严格子目录：${JSON.stringify(historyIds(h.frames, "v1"))}`);
  assert.deepStrictEqual(
    historyIds(h.frames, "v1"),
    ["root-A", "root-B"],
    "roots 是各根目录的精确匹配，严格子目录不进列表",
  );
  assert.strictEqual(
    (historyFor(h.frames, "v1") as Record<string, unknown>).mixedDirectories,
    true,
    "跨两个根仍是混合目录",
  );
  h.frames.length = 0;
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: DIR_A } }, "v1");
  assert.deepStrictEqual(historyIds(h.frames, "v1"), ["root-A"], "directory 同样精确匹配，不含子目录");
}

// ---------- 三、无效 / 迟到的范围整条拒绝 ----------
{
  const h = makeHarness([{ sessionId: "used-A", cwd: DIR_A }, { sessionId: "used-C", cwd: DIR_C }], { folders: [DIR_A, DIR_B] });
  await bindAndRefresh(h, "v1");
  await open(h, "v1", "used-A");
  h.frames.length = 0;
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: DIR_C } }, "v1");
  assert.strictEqual(historyFor(h.frames, "v1"), undefined, "已有会话的外部目录也不是历史候选");
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: DIR_B } }, "v1");
  assert.deepStrictEqual(historyFor(h.frames, "v1")?.scope, { kind: "directory", path: DIR_B });
  stubFolders([DIR_A]);
  await h.c.applyWorkspaceFoldersChange();
  assert.deepStrictEqual(historyFor(h.frames, "v1")?.scope, { kind: "current" }, "改单根后立即回到当前范围");
  h.frames.length = 0;
  await h.c.handle({ type: "historyScope", scope: { kind: "roots" } }, "v1");
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: DIR_A } }, "v1");
  assert.strictEqual(historyFor(h.frames, "v1"), undefined, "单根不能显式切换范围");
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: "relative/dir" } }, "v1");
  assert.strictEqual(historyFor(h.frames, "v1"), undefined, "相对路径范围被拒绝，不推帧");
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: DIR_B } }, "v1");
  assert.strictEqual(historyFor(h.frames, "v1"), undefined, "未知目录范围被拒绝，不推帧");
  await h.c.handle({ type: "historyScope", scope: { kind: "bogus" } }, "v1");
  assert.strictEqual(historyFor(h.frames, "v1"), undefined, "未知 kind 被拒绝");
  h.c.unbindView("v1");
  await h.c.handle({ type: "historyScope", scope: { kind: "roots" } }, "v1");
  assert.strictEqual(historyFor(h.frames, "v1"), undefined, "窗口下线后迟到的范围切换丢弃");
}

// ---------- 三b、跨根删除：历史镜像里的会话按历史行找到并真的删除 ----------
{
  const h = makeHarness(
    [
      { sessionId: "used-A", cwd: DIR_A },
      { sessionId: "used-B", cwd: DIR_B },
    ],
    { folders: [DIR_A, DIR_B] },
  );
  await bindAndRefresh(h, "v1");
  await open(h, "v1", "used-A");
  await h.c.handle({ type: "historyScope", scope: { kind: "roots" } }, "v1");
  assert.ok(!h.c.sessions.some((row) => row.id === "used-B"), "前置：B 在按当前根收窄的旧列表里不可见");
  const mirrorB = (historyFor(h.frames, "v1")?.sessions as { id: string; running?: boolean }[]).find(
    (row) => row.id === "used-B",
  );
  assert.ok(mirrorB && mirrorB.running === false, "B 只出现在历史镜像里，且是停止态");

  // 删日志目录要全盘扫描 `~/.dsh/sessions`：跨根会话必须真的走到这条路，而不是按旧列表扑空
  let touchedDeletePath = false;
  h.c.findSessionDir = () => {
    touchedDeletePath = true;
    return undefined;
  };
  await h.c.handle({ type: "deleteSession", sessionId: "used-B" }, "v1");
  console.log(
    `  跨根删除：touched=${touchedDeletePath} 仍可见=${(historyIds(h.frames, "v1") ?? []).includes("used-B")}`,
  );
  assert.strictEqual(touchedDeletePath, true, "跨根会话按历史行找到，真的进入日志目录删除路径");
  assert.ok(!(historyIds(h.frames, "v1") ?? []).includes("used-B"), "删除后历史镜像不再列出 B");
  assert.ok(h.c.deletedSessionIds.has("used-B"), "删除记入本地删除集合，后续拉取不会让它回来");

  // 删除后迟到的状态帧仍然认得，但不许把已删除的会话复活成历史行
  h.frames.length = 0;
  assert.strictEqual(
    h.c.applySessionStatus("api-session/status", ["used-B", true]),
    true,
    "状态帧仍被认下（不交给配置路由）",
  );
  assert.strictEqual(
    h.c.historySessions.some((row) => row.id === "used-B"),
    false,
    "已删除的会话不会被状态帧复活",
  );
  assert.strictEqual(historyFor(h.frames, "v1"), undefined, "没有可见变化就不推帧");
}

// ---------- 三c、陈旧历史空壳：开过一轮就清占用标记，不需要重新拉列表 ----------
{
  const h = makeHarness([{ sessionId: "blank-A", cwd: DIR_A, blank: true }], { folders: [DIR_A, DIR_B] });
  await bindAndRefresh(h, "occupier");
  await bindAndRefresh(h, "observer");
  await open(h, "occupier", "blank-A");
  interface RowView {
    id: string;
    running?: boolean;
    blank?: boolean;
    occupied?: boolean;
  }
  const rowOf = () =>
    (historyFor(h.frames, "observer")?.sessions as RowView[] | undefined)?.find(
      (row) => row.id === "blank-A",
    );
  const shape = (row: RowView | undefined) => ({
    running: row?.running,
    blank: row?.blank,
    occupied: row?.occupied,
  });
  console.log(`  历史空壳：${JSON.stringify(shape(rowOf()))}`);
  assert.deepStrictEqual(
    shape(rowOf()),
    { running: false, blank: true, occupied: true },
    "前置：窗口停在真正的空壳上，历史行的占用标记锁住垃圾桶",
  );
  const listsBefore = h.client.calls.filter((call) => call === "session/list").length;

  // 在这条空壳里开一轮（别的窗口 / dsh web 都行）：状态中继先 true 后 false，**不拉整份列表**
  assert.strictEqual(h.c.applySessionStatus("api-session/status", ["blank-A", true]), true);
  assert.strictEqual(h.c.applySessionStatus("api-session/status", ["blank-A", false]), true);
  console.log(`  空壳开轮后：${JSON.stringify(shape(rowOf()))}`);
  assert.strictEqual(
    h.client.calls.filter((call) => call === "session/list").length,
    listsBefore,
    "占用标记的清理不依赖重新拉整份列表",
  );
  assert.deepStrictEqual(
    shape(rowOf()),
    { running: false, blank: true, occupied: false },
    "跑过一轮的陈旧空壳只剩服务端的 blank 位，占用标记必须清掉（垃圾桶解锁）",
  );
  assert.strictEqual(
    h.c.sessions.find((row) => row.id === "blank-A")?.blank,
    false,
    "旧列表里的空位已按 `markSessionEngaged` 翻假",
  );
}

// ---------- 四、每窗口的根互不覆盖；换根后发送 / 落壳只用新根 ----------
{
  const h = makeHarness(
    [
      { sessionId: "used-A", cwd: DIR_A },
      { sessionId: "used-B", cwd: DIR_B },
    ],
    { folders: [DIR_A, DIR_B] },
  );
  await bindAndRefresh(h, "v1");
  await bindAndRefresh(h, "v2");
  // 先让 v2 有明确的根（默认 A）；这里不发消息，避免把空会话变成「已经说过话」
  h.c.snapshotFor("v2");
  assert.strictEqual(h.c.viewRootChoices.get("v2")?.path, DIR_A, "前置：v2 的根是默认 A");

  // v1 切到 B：立即发送（不 await switchRoot 完成）必须落 B
  const switching = h.c.handle({ type: "switchRoot", path: DIR_B }, "v1");
  const sending = send(h, "v1", "after-switch");
  await Promise.all([switching, sending]);
  const v1After = h.c.viewSessions.get("v1");
  assert.strictEqual(createdCwd(h.client, v1After), DIR_B, "切 B 后立即发送只落 B");
  assert.strictEqual(h.c.viewRootChoices.get("v1")?.path, DIR_B, "v1 的根是 B");

  await send(h, "v2", "v2-after");
  console.log(
    `  两窗口：v1=${createdCwd(h.client, v1After)} v2=${createdCwd(h.client, h.c.viewSessions.get("v2"))}`,
  );
  assert.strictEqual(
    createdCwd(h.client, h.c.viewSessions.get("v2")),
    DIR_A,
    "v1 换根不覆盖 v2 的当前根（v2 仍落 A）",
  );
  assert.ok(
    h.client.created.some((item) => item.cwd === DIR_B),
    "B 目录确实落了一条会话",
  );
  assert.strictEqual(
    h.client.created.filter((item) => item.cwd === DIR_A).length,
    1,
    "A 只有 v2 那一条，v1 切根后没有回到 A",
  );
}

// ---------- 四b、另一个窗口已经在 B：本窗口照样能切 B（根是窗口级，不是全局占用） ----------
{
  const h = makeHarness([{ sessionId: "used-B", cwd: DIR_B }], { folders: [DIR_A, DIR_B] });
  await bindAndRefresh(h, "v1");
  await bindAndRefresh(h, "v2");
  await open(h, "v2", "used-B");
  assert.strictEqual(createdCwd(h.client, h.c.viewSessions.get("v2")), DIR_B, "前置：v2 已在 B");
  await h.c.handle({ type: "switchRoot", path: DIR_B }, "v1");
  await send(h, "v1", "also-b");
  assert.strictEqual(createdCwd(h.client, h.c.viewSessions.get("v1")), DIR_B, "v2 开着 B 不妨碍 v1 切 B");
  assert.strictEqual(h.c.viewSessions.get("v2"), "used-B", "v2 的绑定不受 v1 换根影响");
}

// ---------- 四c、连续换根：早发起的 B 建会话晚完成，不能把窗口从 C 绑回 B ----------
{
  const h = makeHarness([], { folders: [DIR_A, DIR_B, DIR_C] });
  await bindAndRefresh(h, "v1");
  await h.c.handle({ type: "newSession" }, "v1");
  const original = h.client.createSession.bind(h.client);
  const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  };
  const gates = new Map([
    [DIR_B, { entered: gate(), proceed: gate() }],
    [DIR_C, { entered: gate(), proceed: gate() }],
  ]);
  const gateFor = (cwd: string) => {
    const found = gates.get(cwd);
    assert.ok(found, `前置：${cwd} 的建会话闸存在`);
    return found;
  };
  h.client.createSession = async (target, reuse) => {
    const cwd =
      target.cwd ?? h.client.workspaces.find((item) => item.workspaceId === target.workspaceId)?.path;
    const blocked = cwd === undefined ? undefined : gates.get(cwd);
    if (blocked) {
      blocked.entered.open();
      await blocked.proceed.wait;
    }
    return original(target, reuse);
  };
  // 切 B 的建会话先卡住；切 C 在 B 还没完成时发起，也卡住；然后先放行 B。
  const toB = h.c.handle({ type: "switchRoot", path: DIR_B }, "v1");
  await gateFor(DIR_B).entered.wait;
  const toC = h.c.handle({ type: "switchRoot", path: DIR_C }, "v1");
  await gateFor(DIR_C).entered.wait;
  gateFor(DIR_B).proceed.open();
  await toB;
  const bShell = h.client.created.find((item) => item.cwd === DIR_B)?.sessionId;
  assert.ok(bShell, "B 的空壳最终建了出来");
  assert.notStrictEqual(h.c.viewSessions.get("v1"), bShell, "晚完成的 B 不能把窗口绑回 B");
  gateFor(DIR_C).proceed.open();
  await toC;
  const cShell = h.c.viewSessions.get("v1");
  assert.strictEqual(createdCwd(h.client, cShell), DIR_C, "后发起的 C 才是窗口的根");
  await send(h, "v1", "race-send");
  const sent = h.client.prompts.at(-1)?.sessionId;
  console.log(
    `  连续换根：绑定=${createdCwd(h.client, cShell)} 发送=${createdCwd(h.client, sent)}`,
  );
  assert.strictEqual(createdCwd(h.client, sent), DIR_C, "消息落后发起的 C，不回到 B");
}

// ---------- 五、发送先于选择框返回：beginSend 同步冻结目录；晚返回不污染新动作 ----------
{
  const dialog = deferredDialog();
  try {
    const h = makeHarness([], { folders: [DIR_A, DIR_B] });
    await bindAndRefresh(h, "v1");
    const picking = h.c.handle({ type: "pickOtherRoot" }, "v1");
    // 用户没等选择框，直接发送
    await send(h, "v1", "send-before-picker");
    const target = h.c.viewSessions.get("v1");
    assert.strictEqual(createdCwd(h.client, target), DIR_A, "发送冻结的是按下那一刻的根 A");
    const rootBefore = workspaceFor(h.frames, "v1")?.path;
    dialog.resolve(DIR_C);
    await picking;
    console.log(
      `  发送先于选择框：会话 cwd=${createdCwd(h.client, target)}，晚返回后根=${workspaceFor(h.frames, "v1")?.path}`,
    );
    assert.strictEqual(createdCwd(h.client, target), DIR_A, "晚返回的选择框不许把已发出的消息搬到 C");
    assert.strictEqual(workspaceFor(h.frames, "v1")?.path, rootBefore, "晚返回的选择框不改本窗口的根");
    assert.ok(!h.client.created.some((item) => item.cwd === DIR_C), "没有按迟到目录建会话");
  } finally {
    dialog.restore();
  }
}

// ---------- 五b、晚返回的选择框不能污染已关掉的窗口 ----------
{
  const dialog = deferredDialog();
  try {
    const h = makeHarness([], { folders: [DIR_A] });
    await bindAndRefresh(h, "v1");
    const picking = h.c.handle({ type: "pickOtherRoot" }, "v1");
    h.c.unbindView("v1");
    dialog.resolve(DIR_C);
    await picking;
    assert.strictEqual(h.c.viewSessions.get("v1"), undefined, "关掉的窗口不会被迟到的选择框绑定");
    assert.ok(!h.client.created.some((item) => item.cwd === DIR_C), "关窗后不按迟到目录建会话");
    assert.strictEqual(h.c.newSessionCwd, undefined, "关窗后也不把迟到目录记成新会话目录");
  } finally {
    dialog.restore();
  }
}

// ---------- 六、单根和多根都能选外部目录，按 cwd 落壳且不加入历史候选 ----------
for (const folders of [[DIR_A], [DIR_A, DIR_B]]) {
  const external = mkdtempSync(join(tmpdir(), "dsh-chat-external-"));
  const dialog = stubDialog([external]);
  try {
    const h = makeHarness([], { folders });
    await bindAndRefresh(h, "v1");
    const registersBefore = h.client.workspaces.length;
    await h.c.handle({ type: "pickOtherRoot" }, "v1");
    const shell = h.c.viewSessions.get("v1");
    assert.strictEqual(createdCwd(h.client, shell), external, "工作区外目录按 cwd 落壳");
    assert.strictEqual(h.client.workspaces.length, registersBefore, "工作区外目录不注册服务端工作区");
    assert.deepStrictEqual(
      h.client.created.find((item) => item.sessionId === shell)?.workspaceId,
      undefined,
      "按 cwd 建会话（没有 workspaceId）",
    );
    const view = workspaceFor(h.frames, "v1") as { path?: string; roots?: { path: string }[]; canPickOther?: boolean };
    assert.strictEqual(view.path, external, "目录胶囊显示工作区外目录");
    assert.deepStrictEqual(
      (view.roots ?? []).map((item) => item.path),
      folders,
      "换到外部目录后，根候选仍与 VS Code 一致",
    );
    assert.strictEqual(view.canPickOther, true, "本机窗口允许选工作区外目录");
    assert.deepStrictEqual(historyFor(h.frames, "v1")?.roots, view.roots);
    h.frames.length = 0;
    await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: external } }, "v1");
    assert.strictEqual(historyFor(h.frames, "v1"), undefined, "本窗刚选的外部目录也不是显式历史选项");
    await send(h, "v1", "external-send");
    assert.strictEqual(createdCwd(h.client, h.c.viewSessions.get("v1")), external, "后续发送仍在外部目录");
  } finally {
    dialog.restore();
    rmSync(external, { recursive: true, force: true });
  }
}

// ---------- 七、远端窗口：系统选择器明确禁用，不猜本地路径 ----------
{
  const env = vscode.env as unknown as { remoteName?: string };
  const original = env.remoteName;
  const dialog = stubDialog([DIR_C]);
  env.remoteName = "ssh-remote";
  try {
    const h = makeHarness([], { folders: [DIR_A] });
    await bindAndRefresh(h, "v1");
    await h.c.handle({ type: "ready" }, "v1");
    assert.strictEqual(workspaceFor(h.frames, "v1")?.canPickOther, false, "远端窗口不给「选择其他文件夹」入口");
    await h.c.handle({ type: "pickOtherRoot" }, "v1");
    assert.strictEqual(dialog.dialogs.length, 0, "远端窗口连对话框都不弹");
    assert.ok(!h.client.created.some((item) => item.cwd === DIR_C), "不把本机路径当执行世界目录");

    // 没有打开文件夹时同一条限制：`pickWorkspace` 也不许收本机路径
    stubFolders([]);
    const h2 = makeHarness([], {});
    await bindAndRefresh(h2, "v2");
    await h2.c.handle({ type: "ready" }, "v2");
    assert.strictEqual(workspaceFor(h2.frames, "v2")?.canPickOther, false, "远端 + 无文件夹同样禁用");
    await h2.c.handle({ type: "pickWorkspace" }, "v2");
    assert.strictEqual(h2.c.newSessionCwd, undefined, "远端窗口不记本机选择的目录");
    assert.strictEqual(dialog.dialogs.length, 0, "远端窗口不弹系统目录选择器");
  } finally {
    dialog.restore();
    env.remoteName = original;
  }
}

// ---------- 八、注册缓存按目录 + 连接 + 是否注册分键；移除根不沿用旧 workspaceId ----------
{
  const h = makeHarness([], { folders: [DIR_A, DIR_B] });
  await bindAndRefresh(h, "v1");
  await h.c.handle({ type: "newSession" }, "v1");
  const aShell = h.c.viewSessions.get("v1");
  const aWorkspace = h.client.created.find((item) => item.sessionId === aShell)?.workspaceId;
  assert.strictEqual(createdCwd(h.client, aShell), DIR_A, "前置：先在 A 落一条空壳");
  await h.c.handle({ type: "switchRoot", path: DIR_B }, "v1");
  const bShell = h.c.viewSessions.get("v1");
  const bWorkspace = h.client.created.find((item) => item.sessionId === bShell)?.workspaceId;
  console.log(`  A=${aWorkspace} B=${bWorkspace}`);
  assert.ok(aWorkspace && bWorkspace && aWorkspace !== bWorkspace, "不同目录各有自己的注册 id");

  // 移除 B（只剩 A）：下一个新会话必须用 A 的注册 id，不许沿用 B 的
  stubFolders([DIR_A]);
  await h.c.applyWorkspaceFoldersChange();
  const afterRemoval = h.c.viewSessions.get("v1");
  assert.notStrictEqual(afterRemoval, bShell, "B 被移除后不再绑 B 的空壳");
  await send(h, "v1", "after-remove");
  const landed = h.c.viewSessions.get("v1");
  const landedWorkspace = h.client.created.find((item) => item.sessionId === landed)?.workspaceId;
  console.log(`  移除 B 后落 ${createdCwd(h.client, landed)}（workspace=${landedWorkspace}）`);
  assert.strictEqual(createdCwd(h.client, landed), DIR_A, "回退到 A");
  assert.strictEqual(landedWorkspace, aWorkspace, "复用 A 的注册 id，不沿用 B 的");
}

// ---------- 九、工作区注册表快照可复用：不重复 createWorkspace ----------
{
  const h = makeHarness([], { folders: [DIR_A] });
  h.c.workspaces = [{ workspaceId: "known-a", path: DIR_A, sessionIds: [] }];
  await bindAndRefresh(h, "v1");
  await h.c.handle({ type: "newSession" }, "v1");
  assert.strictEqual(
    h.client.calls.filter((call) => call === "workspace/create").length,
    0,
    "快照里已有该目录的注册记录时直接复用",
  );
  const shell = h.c.viewSessions.get("v1");
  assert.strictEqual(
    h.client.created.find((item) => item.sessionId === shell)?.workspaceId,
    "known-a",
    "建会话带的是快照里的 workspaceId",
  );
}

// ---------- 十、工作区文件夹变化：旧空壳在第一个 await 之前失去发送资格；历史会话不重绑 ----------
{
  const h = makeHarness(
    [
      { sessionId: "used-B", cwd: DIR_B },
      { sessionId: "blank-B", cwd: DIR_B, blank: true },
    ],
    { folders: [DIR_A, DIR_B] },
  );
  await bindAndRefresh(h, "v1");
  await open(h, "v1", "used-B");
  const historySession = h.c.viewSessions.get("v1");
  stubFolders([DIR_A]);
  const changing = h.c.applyWorkspaceFoldersChange();
  // 同步段已经跑完：已有历史会话保持绑定（不重绑到 A 的空壳）
  assert.strictEqual(h.c.viewSessions.get("v1"), historySession, "已有历史会话不因文件夹变化被重绑");
  await changing;

  // 另一个窗口停在 DIR_B 的空壳上：文件夹变化后立刻（第一个 await 之前）失去发送资格
  const h2 = makeHarness([{ sessionId: "blank-B", cwd: DIR_B, blank: true }], { folders: [DIR_A, DIR_B] });
  await bindAndRefresh(h2, "v2");
  await open(h2, "v2", "blank-B");
  assert.strictEqual(h2.c.viewSessions.get("v2"), "blank-B");
  stubFolders([DIR_A]);
  const pending = h2.c.applyWorkspaceFoldersChange();
  assert.strictEqual(h2.c.viewSessions.get("v2"), undefined, "不再匹配旧根的空壳在第一个 await 之前解绑");
  await pending;
}

// ---------- 十一、POSIX 大小写：directory 范围保留大小写 ----------
{
  const posixA = "/work/Repo";
  const posixB = "/work/repo";
  const h = makeHarness(
    [
      { sessionId: "upper", cwd: posixA },
      { sessionId: "lower", cwd: posixB },
    ],
    { folders: [posixA, posixB] },
  );
  await bindAndRefresh(h, "v1");
  await open(h, "v1", "upper");
  h.frames.length = 0;
  await h.c.handle({ type: "historyScope", scope: { kind: "directory", path: posixB } }, "v1");
  assert.deepStrictEqual(historyIds(h.frames, "v1"), ["lower"], "POSIX 目录范围保留大小写");
  assert.ok(
    !(historyIds(h.frames, "v1") ?? []).includes("upper"),
    "`/work/Repo` 与 `/work/repo` 不能合并",
  );
}

console.log("historyDirectory: all assertions passed");
