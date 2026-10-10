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

process.on("unhandledRejection", (error) => {
  console.error("[mentionResolve] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// `vscodeTestStub` 的 stat 一律抛：这里换成真盘的 stat，并让「找不到」带上
// `FileNotFound`（`isNotFoundError` 认的就是这个 code；node 的 ENOENT 会被当成
// 「未知错误」→ 不抑制，那是另一条分支，本文件第 5 节单独钉）。
(vscode.workspace.fs as { stat: (uri: { fsPath: string }) => Promise<unknown> }).stat = async (uri) => {
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
    async createSession(target: { workspaceId?: string; cwd?: string }) {
      calls.push({ method: "session/create" });
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
async function query(query: string): Promise<{ frame: Record<string, unknown>; methods: string[] }> {
  frames.length = 0;
  client.calls.length = 0;
  await c.handle({ type: "queryFiles", query }, "v1");
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
  assert.ok(
    !cast.sessions.some((row) => row.id === otherId),
    "前提：它属于别的工作区（cwd 也不是本窗口打开的域）→ 不在本窗口的历史列表里",
  );
  assert.ok(cast.sessionCwds.has(otherId), "前提：权威 cwd 账本（任何可见性过滤之前建的）里还有它");

  const crossWorkspace = await query(sessionToken(otherId));
  assert.strictEqual(
    crossWorkspace.frame.resolved,
    true,
    "别的项目的会话引用同样「能引用到内容」→ 不弹（判据要认过滤前的账本）",
  );
}

await rm(root, { recursive: true, force: true });

console.log("mentionResolve: 「已经能引用到内容」的判定 ✓");
console.log("\nmentionResolve: all assertions passed");
