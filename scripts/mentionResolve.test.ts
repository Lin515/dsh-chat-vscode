/**
 * 「光标所在的 `@` 块**已经能引用到内容**时列表整块不弹」这条产品口径（用户 2026-10-11）
 * 的宿主侧判据：`controller.mentionResolves` 与它落在 `files/list` 帧上的 `resolved` 位。
 *
 * 用户报的现场：以前在输入框里打 `@` + 会话 id，候选列表能自动匹配到那条会话；某个
 * 版本之后一条都不出来。根因在界面侧的触发判定（`findTrigger` 只认裸 `@` 与目录块，
 * 见 `scripts/mentionNav.test.ts`），而**口径**是这一条：块本身已经是一条能引用到内容
 * 的引用（路径在盘上 / 对话引用指向的会话还在）就不弹，否则才弹——判据要查盘与查会话
 * 列表，只有宿主给得出，所以它随 `files/list` 那帧回来。
 *
 * 这一组断言钉四件事（第 1–4 节驱动**真** `ChatController`，真盘临时目录，offline stub）：
 *
 * 1. **路径**：盘上有的文件 / 目录 → `resolved: true`，且这一次**一个查询都不发**
 *    （不查是响应快的关键：界面靠它当场拿到判定，不必先闪一个列表出来）；
 * 2. **行号区间**：`@src/a.ts#L12-L40` 指的仍是那个文件（用户点名的那一条）；
 * 3. **浏览入口恒不抑制**：裸 `@` 与以分隔符结尾的路径照旧查、照旧弹（目录在不在都要
 *    能进去）；
 * 4. **对话引用**：`@[标题](dsh-session:…)` 指向的会话还在 → 不弹；**裸会话 id**
 *    （`@session-…`）不是引用形态 → 照旧弹——那条路正是用户报的「打会话 id 没列表」。
 *
 * 拿不到证据（路径解析不了、查盘报未知错误）一律按「不抑制」：宁可弹列表，也不能因为
 * 判不出来就把用户的候选整块按住（见 `mentionResolves` 的注释）。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`；那里的
 * `workspace.fs.stat` 一律抛（它只服务另一条链路），本文件把它接到 node 的 stat 上，
 * 并按 VS Code 的 `FileNotFound` 口径报「找不到」。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { stat } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { ChatController } from "../src/dsh/controller";
import type { FileRefEntry } from "../src/dsh/fileRefListing";
import { hostPlatform } from "../src/dsh/localAccess";
import { visibleForView } from "../src/dsh/sessionList";
import type { SessionScope } from "../src/dsh/scope";
import { ingestControlBaseline, ingestProjection, type ProjectionHandlers } from "../src/dsh/projectionIngest";
import { reducer, initialState } from "../src/webview/state";

process.on("unhandledRejection", (error) => {
  console.error("[mentionResolve] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// `vscodeTestStub` 的 stat 一律抛：这里换成真盘的 stat，并让「找不到」带上
// `FileNotFound`（`isNotFoundError` 认的就是这个 code；node 的 ENOENT 会被当成
// 「未知错误」→ 不抑制，那是另一条分支，本文件第 5 节单独钉）。
let statCalls = 0;
(vscode.workspace.fs as { stat: (uri: { fsPath: string }) => Promise<unknown> }).stat = async (uri) => {
  statCalls += 1;
  try {
    await stat(uri.fsPath);
    return {};
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      const missing = new Error(`not found: ${uri.fsPath}`) as Error & { code?: string };
      missing.code = "FileNotFound";
      throw missing;
    }
    throw error;
  }
};

/** 会话引用 token（官方 `formatSessionReferenceMention` 的形态：base64url 的 JSON 字符串）。 */
const sessionToken = (sessionId: string): string =>
  `[标题](dsh-session:${Buffer.from(JSON.stringify(sessionId), "utf8").toString("base64url")})`;

const root = await mkdtemp(join(tmpdir(), "dsh-mention-resolve-"));
await mkdir(join(root, "sub"), { recursive: true });
await writeFile(join(root, "alpha.ts"), "x\n");
await writeFile(join(root, "sub", "beta.ts"), "x\n");

/** 假文件候选源：服务器「回」的那几条（用来证明抑制时它们根本不被取）。 */
const SERVER_ITEMS: FileRefEntry[] = [{ path: "alpha.ts", kind: "file" }];

/** 假服务端（同 `scripts/fileRefListing.test.ts` 的手法）：只认自己建过的 agent id。 */
function fakeClient(serverItems: FileRefEntry[]) {
  const rows: { sessionId: string; cwd: string; blank: boolean; updatedAt: number; running: boolean }[] = [];
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  return {
    rows,
    calls,
    async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string) {
      calls.push({ method: "session/create" });
      // 指名复用一条已有会话（`session/create` 的第二个位置参数，见 controller 的
      // `adoptBlankShell`）：服务端认得它就**还是那条**
      if (reuse !== undefined && rows.some((row) => row.sessionId === reuse)) return { sessionId: reuse };
      const sessionId = `session-${rows.length + 1}`;
      rows.push({ sessionId, cwd: target.cwd ?? "", blank: true, updatedAt: Date.now() + rows.length, running: false });
      return { sessionId };
    },
    async listSessions() {
      calls.push({ method: "session/list" });
      return { items: rows.map((row) => ({ ...row })) };
    },
    async request(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (!rows.some((row) => row.sessionId === agentId)) throw new Error("session not found");
      if (method === "fileReferences/list") return serverItems.map((entry) => ({ ...entry }));
      if (method === "sessionReferenceResolver/candidates") return [];
      if (method === "commands/list") return [];
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

function makeController(cwd: string) {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: { target: string; frame: Record<string, unknown> }[] = [];
  (
    controller as never as { subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  const c = controller as unknown as {
    client: unknown;
    connection: string;
    newSessionCwd?: string;
    bindView(viewId: string): void;
    newSession(viewId?: string): Promise<void>;
    handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  };
  c.newSessionCwd = cwd;
  const client = fakeClient(SERVER_ITEMS);
  c.client = client as never;
  c.connection = "connected";
  return { c, frames, client };
}

/** 某次查询的那条 `files/list` 帧（取最后一条：同一 query 可能被查过多次）。 */
function frameOf(
  frames: { target: string; frame: Record<string, unknown> }[],
  query: string,
): Record<string, unknown> | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target === "v1" && frame.type === "files/list" && frame.query === query) return frame;
  }
  return undefined;
}

const { c, frames, client } = makeController(root);
c.bindView("v1");
await c.newSession("v1");
const existingSessionId = client.rows[0]?.sessionId ?? "";
assert.ok(existingSessionId, "前提：绑定后有一条会话（用来验对话引用的判定）");

/** 一次 `@` 查询：清掉旧帧与调用表，返回这一次的帧与这一次发出去的方法名。 */
async function query(query: string, sessionOnly = false): Promise<{ frame: Record<string, unknown>; methods: string[] }> {
  frames.length = 0;
  client.calls.length = 0;
  await c.handle({ type: "queryFiles", query, ...(sessionOnly ? { sessionOnly: true } : {}) }, "v1");
  const frame = frameOf(frames, query);
  assert.ok(frame, `应当发出 query="${query}" 的 files/list 帧`);
  return { frame, methods: client.calls.map((call) => call.method) };
}

console.log("mentionResolve: 「已经能引用到内容」的判定（真控制器 + 真盘临时目录）");

// ---------- 1. 盘上有的文件 / 目录：不弹，且一个查询都不发 ----------
{
  const file = await query("alpha.ts");
  assert.strictEqual(file.frame.resolved, true, "盘上有的文件 → 这一块已经能引用到内容");
  assert.deepStrictEqual(file.frame.items, [], "抑制时不给候选（界面整块不弹，给了也没人看）");
  assert.strictEqual(file.frame.query, "alpha.ts", "帧要带回这一次的查询串（界面按它认判定属于哪一块）");
  assert.ok(
    !file.methods.includes("fileReferences/list") && !file.methods.includes("sessionReferenceResolver/candidates"),
    `抑制时不许再发查询（省下那一趟，也让界面当场拿到判定）：发了 ${file.methods.join("、")}`,
  );

  // 目录（不带尾分隔符）同样是「能引用到内容」：模型按路径读它就行
  const directory = await query("sub");
  assert.strictEqual(directory.frame.resolved, true, "盘上有的目录（无尾分隔符）同样不弹");
  assert.ok(!directory.methods.includes("fileReferences/list"), "目录这一条也不查");
}

// ---------- 2. 行号区间：指的仍是那个文件 ----------
//
// `formatFileMentionWithLines` 把 `#L12` / `#L12-L40` 附在路径末尾，界面插进正文的就是
// 这个形态。不去掉区间就会去查一个不存在的名字，于是光标一进这条引用列表就弹出来
// （用户 2026-10-11 口径里点名的那一条）。
{
  const ranged = await query("alpha.ts#L12-L40");
  assert.strictEqual(ranged.frame.resolved, true, "带行号区间的引用仍指向那个文件");
  assert.ok(!ranged.methods.includes("fileReferences/list"), "带行号的引用也不查");
}

// ---------- 3. 浏览入口恒不抑制（照旧查、照旧弹） ----------
{
  for (const browse of ["", "sub/", "sub\\"]) {
    const result = await query(browse);
    assert.strictEqual(
      result.frame.resolved,
      false,
      `"${browse}" 是浏览入口（裸 \`@\` / 尾分隔符）：目录在不在都要能进去`,
    );
    assert.ok(
      result.methods.includes("fileReferences/list"),
      `"${browse}" 照旧查文件候选（浏览入口不做存在性判定）`,
    );
  }
}

// ---------- 4. 不存在的路径：照旧弹，候选照旧来自服务器 ----------
{
  const missing = await query("nope.ts");
  assert.strictEqual(missing.frame.resolved, false, "盘上没有的路径 → 这是一次待补全的查询");
  assert.deepStrictEqual(missing.frame.items, SERVER_ITEMS, "抑制与否不影响候选那一路（服务器结果原样下发）");
  assert.ok(missing.methods.includes("fileReferences/list"), "不抑制时要查");

  const nested = await query("src/webview");
  assert.strictEqual(nested.frame.resolved, false, "盘上没有的相对路径照旧弹（模糊查询那一路）");
}

// ---------- 4b. 不支持的根 / 盘符形态：不做本地推断 ----------
//
// Windows 宿主上的单根相对写法（`/foo`）**不相对会话 cwd**：`path.join(cwd, "/foo")`
// 拼出的是 `cwd/foo`，于是本机恰好存在同名文件时它会被误抑制成一条已解析引用。
// 判据收在 `localAccess.unsupportedLocalPathForm`（命中即放弃本地推断，服务器候选与
// 手写引用照旧）。POSIX 宿主上 `/foo` 是原生绝对路径，这条用例在那里退化成「本机没有
// 这个文件 → absent」，两种宿主都断言 `resolved: false`——所以夹具要在 Windows 上真的
// 造出那个同名文件，否则这条断言在 Windows 上也是空转。
{
  if (hostPlatform() === "win32") await writeFile(join(root, "foo"), "x\n");
  const rootRelative = await query("/foo");
  assert.strictEqual(
    rootRelative.frame.resolved,
    false,
    "单根相对形态（`/foo`）不做本地推断：不许被 cwd 下的同名文件抑制",
  );
  assert.ok(rootRelative.methods.includes("fileReferences/list"), "不抑制时就照旧查候选（列表该弹）");
}

// ---------- 5. 对话引用：token 指向的会话还在 → 不弹 ----------
{
  const token = await query(sessionToken(existingSessionId));
  assert.strictEqual(token.frame.resolved, true, "会话还在 → 这条引用本身就能用，不该弹列表");
  assert.ok(!token.methods.includes("sessionReferenceResolver/candidates"), "抑制时连候选都不查");

  const gone = await query(sessionToken("session-does-not-exist"));
  assert.strictEqual(gone.frame.resolved, false, "会话已经不在了 → 那不是一条能引用到内容的引用");

  // **裸会话 id 不是引用形态**（官方 `parseSessionReferenceText` 只认 token）：打进去仍然
  // 是在检索会话，列表必须弹——用户 2026-10-11 报的现场就是它不弹
  const bareId = await query(existingSessionId);
  assert.strictEqual(bareId.frame.resolved, false, "裸会话 id 是检索、不是引用 → 必须弹列表");
  assert.ok(
    bareId.methods.includes("sessionReferenceResolver/candidates"),
    "裸会话 id 那一路要查对话候选（列表里就是靠它匹配到目标会话）",
  );
  assert.ok(
    client.calls.some(
      (call) => call.method === "sessionReferenceResolver/candidates" && call.params?.query === existingSessionId,
    ),
    "查询串就是那一整块（服务端按会话 id / cwd / 标题做子串匹配）",
  );
}

// ---------- 6. 别的项目的会话引用也要认（判定用过滤前的权威账本） ----------
//
// `@` 的对话候选来自服务端**全量**会话（按 cwd 亲缘排序），引用一条别的项目的会话完全
// 合法；而 `this.sessions` 是历史列表，按窗口的 cwd 收窄过。判据只认后者的话，这种引用
// 会被判成「引用不到内容」，于是光标一移进去列表就弹——正是本轮要治的现场。
{
  const cast = c as unknown as {
    onWorkspaceFrame(frame: unknown): void;
    refreshSessions(): Promise<void>;
    sessions: { id: string }[];
    sessionCwds: Map<string, string>;
  };
  // 服务端多一条**别的项目**的会话（cwd 不同），并把它归到一个工作区里
  const otherId = "session-other-project";
  client.rows.push({
    sessionId: otherId,
    cwd: "D:/other-project",
    blank: false,
    updatedAt: Date.now(),
    running: false,
  });
  cast.onWorkspaceFrame({
    type: "baseline",
    value: { items: [{ workspaceId: "w-other", path: "D:/other-project", sessionIds: [otherId] }] },
  });
  await cast.refreshSessions();
  // 前置换成了两句：全局候选（`this.sessions`）里现在**有**它——那一份是完整候选，
  // 按窗口收窄只发生在发帧那一步（`visibleForView`）；界面上看不见它是因为它既不在本窗口
  // 当前会话的 cwd 下、又已分组。判据若读「界面那一份」，这条引用就会被误判成引用不到内容。
  assert.ok(
    cast.sessions.some((row) => row.id === otherId),
    "前提：它在全局候选里（收窄在发帧那一步，见 `visibleForView`）",
  );
  assert.ok(
    !visibleForView(cast.sessions as { id: string; cwd?: string }[], {
      folderOpen: false,
      cwd: root,
      groupedSessionIds: new Set([otherId]),
    }).some((row) => row.id === otherId),
    "前提：按窗口收窄之后它不在这个窗口的历史列表里（别的目录 + 已分组）",
  );
  assert.ok(cast.sessionCwds.has(otherId), "前提：权威 cwd 账本（任何可见性过滤之前建的）里还有它");

  const crossWorkspace = await query(sessionToken(otherId));
  assert.strictEqual(
    crossWorkspace.frame.resolved,
    true,
    "别的项目的会话引用同样「能引用到内容」→ 不弹（判据要认过滤前的账本）",
  );
}

// 编辑失效的会话标题独立查询：同名文件、斜杠或空白不改变会话语义，也不查盘。
{
  for (const title of ["alpha.ts", "sub/", "my title / sub"]) {
    const before = statCalls;
    const result = await query(title, true);
    assert.strictEqual(result.frame.resolved, false, "失效标题不得按同名文件抑制");
    assert.deepStrictEqual(result.frame.items, [], "会话标题查询不提供文件候选");
    assert.strictEqual(statCalls, before, "会话标题不做路径存在性查询");
    assert.ok(!result.methods.includes("fileReferences/list"), "只查会话候选，不查文件候选");
    assert.ok(result.methods.includes("sessionReferenceResolver/candidates"), "斜杠标题也必须查询会话");
    assert.ok(client.calls.some((call) => call.method === "sessionReferenceResolver/candidates" && call.params?.query === title));
    assert.deepStrictEqual(frames.filter(({ frame }) => frame.query === title).map(({ frame }) => frame.type),
      ["files/list", "files/sessions"], "仍先发查询锚帧，再发会话候选");
  }
}
console.log("mentionResolve: 编辑后的完整标题只查询会话，不受文件存在性或分隔符影响 ✓");

// ---------- 7. 信任门关：不凭本机 stat 抑制文件候选 ----------
//
// 用户 2026-10-18 口径：文件路径的抑制判定复用**工作区外发现**的同一道信任门。门关时
// （远端 / WSL / 拿不到「执行世界就是本机」的肯定证据）本机看到的「这个文件在」没有
// 意义，于是**不抑制**——列表照旧弹、手写引用照旧能发。这里用「会话 cwd 指向一个本机
// 不存在的位置」造门关，再问一条**本机确实存在**的绝对路径：旧判据会说「已经能引用
// 到内容」（于是整块不弹），新判据必须说不能。
{
  const { ChatController } = await import("../src/dsh/controller");
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const seeing: { target: string; frame: Record<string, unknown> }[] = [];
  (controller as never as { subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown })
    .subscribe((target, frame) => seeing.push({ target, frame }));
  const inner = controller as unknown as {
    client: unknown;
    connection: string;
    newSessionCwd?: string;
    bindView(viewId: string): void;
    newSession(viewId?: string): Promise<void>;
    handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  };
  // cwd 是一个**本机不存在**的原生绝对路径：形状过得去，证据拿不到 → 门关
  const missingCwd = join(tmpdir(), "dsh-mention-resolve-missing-cwd");
  inner.newSessionCwd = missingCwd;
  inner.client = fakeClient(SERVER_ITEMS) as never;
  inner.connection = "connected";
  inner.bindView("v2");
  await inner.newSession("v2");

  const existing = join(root, "alpha.ts");
  seeing.length = 0;
  await inner.handle({ type: "queryFiles", query: existing }, "v2");
  const frame = seeing.find(({ frame: value }) => value.type === "files/list" && value.query === existing)?.frame;
  assert.ok(frame, "应当发出这条查询的 files/list 帧");
  assert.strictEqual(
    frame.resolved,
    false,
    "门关时不凭本机 stat 抑制候选（这个文件确实在本机，但执行世界不一定是本机）",
  );
  assert.ok(
    seeing.some(({ frame: value }) => value.type === "files/list" && value.query === existing && Array.isArray(value.items)),
    "不抑制时照旧给候选那一帧（列表照旧弹）",
  );
}
console.log("mentionResolve: 信任门关时不凭本机 stat 抑制候选 ✓");

// ---------- 8. 盘符裸写（`@D:`）：浏览入口 + 目录查询，不是会话检索 ----------
//
// 见 docs/design-mentions.md「三种入口」的 M1 补充口径：`@D:` 按 `D:/` 列盘根。于是它
// 既是浏览入口（不等待抑制判定、恒弹列表），又是目录查询（这一层不列对话候选）。
// 判据在 `shared/mentions.ts`（`isDriveQuery` 并入 `isDirectoryQuery` / `isBrowseQuery`），
// 这里钉宿主侧的接线。
{
  const drive = await query("D:");
  assert.strictEqual(drive.frame.resolved, false, "盘符裸写是浏览入口：不做存在性判定");
  assert.ok(
    !drive.methods.includes("sessionReferenceResolver/candidates"),
    "盘符裸写算「进了目录」：宿主连对话候选那趟扫描都不发",
  );
  assert.ok(drive.methods.includes("fileReferences/list"), "文件那一路照常问服务器（它回空表，本地补盘根）");
}
console.log("mentionResolve: 盘符裸写是浏览入口且不查对话候选 ✓");

// ---------- 执行目录适配：真投影入口 + 查询链路，创建目录始终不变 ----------
{
  const inner = c as unknown as {
    scopes: Map<string, SessionScope>;
    projectionHandlers: ProjectionHandlers;
    sessionCwds: Map<string, string | undefined>;
    snapshotFor(viewId: string): { workingDirectory?: string | null; session?: { cwd?: string } | null };
  };
  const scope = inner.scopes.get(existingSessionId)!;
  assert.ok(scope);
  const move = (value: unknown, seq: number) => ingestProjection(inner.projectionHandlers, scope, "workingDirectory", value, seq);
  move(join(root, "sub"), 10);
  assert.equal(inner.snapshotFor("v1").workingDirectory, join(root, "sub"));
  assert.equal(inner.sessionCwds.get(existingSessionId), root, "执行目录不改认领账本");
  assert.equal(inner.snapshotFor("v1").session?.cwd, root, "不改会话创建目录");
  assert.equal((await query("beta.ts")).frame.resolved, true, "相对抑制判定使用执行目录");
  assert.equal((await query("alpha.ts")).frame.resolved, false, "不再按创建目录误抑制");
  const list = await query("");
  assert.equal(list.frame.cwd, join(root, "sub"));
  assert.equal(list.frame.sessionId, existingSessionId);
  assert.ok((list.frame.items as FileRefEntry[]).some((item) => item.path === "beta.ts"), "补列使用执行目录");
  assert.equal(move(root, 9), false, "旧投影不能回退目录");

  // 在旧目录查询未结算时切目录，再切回：即使 cwd 相同也不能复活旧批次（ABA）。
  const request = client.request.bind(client);
  let release!: (items: FileRefEntry[]) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<FileRefEntry[]>((resolve) => { release = resolve; });
  client.request = async (method, params) => {
    if (method === "fileReferences/list") { started(); return held; }
    return request(method, params);
  };
  frames.length = 0;
  const pending = c.handle({ type: "queryFiles", query: "" }, "v1");
  await waiting;
  move(root, 11);
  move(join(root, "sub"), 12);
  release([{ path: "stale.txt", kind: "file" }]);
  await pending;
  assert.ok(!frames.some(({ frame }) => frame.type === "files/list" || frame.type === "files/sessions"), "已作废目录查询的两路迟到结果均不下发");
  client.request = request;
  assert.equal((await query("")).frame.cwd, join(root, "sub"), "新查询按当前目录重取");

  ingestControlBaseline(inner.projectionHandlers, scope, { asOfSeq: 13, values: {} });
  assert.equal(inner.snapshotFor("v1").workingDirectory, null, "清空必须过线为 null");
  assert.equal((await query("alpha.ts")).frame.resolved, true, "baseline 缺键退回创建目录");
  move(join(root, "sub"), 14);
  move(null, 15);
  assert.equal((await query("")).frame.cwd, root, "null 清空后不会残留执行目录");

  // 界面双源回帧也按会话与执行目录验归属（同 query 不足以判断新鲜度）。
  const state = { ...initialState, session: { id: existingSessionId, title: "", updatedAt: 0, running: false, cwd: root }, workingDirectory: join(root, "sub") };
  const old = { type: "files/list" as const, query: "", items: SERVER_ITEMS, cwd: root, sessionId: existingSessionId };
  assert.equal(reducer(state, old), state, "界面拒绝旧目录文件帧");
  assert.equal(reducer(state, { ...old, sessionId: "other", cwd: state.workingDirectory }), state, "界面拒绝其它会话文件帧");
  const current = reducer(state, { ...old, cwd: state.workingDirectory });
  assert.equal(current.fileRefs.cwd, state.workingDirectory);
  assert.equal(reducer(current, { type: "files/sessions", query: "", sessions: [], cwd: root, sessionId: existingSessionId }), current, "界面拒绝旧目录对话帧");
}
console.log("mentionResolve: 执行目录投影、补列、抑制、ABA 迟到丢弃与清空回退 ✓");

await rm(root, { recursive: true, force: true });

console.log("mentionResolve: 「已经能引用到内容」的判定 ✓");
console.log("\nmentionResolve: all assertions passed");
