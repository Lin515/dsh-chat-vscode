/**
 * 空态（新会话、还没开始对话）下 `/` 命令栏与 `@` 候选列表的**行为级**回归：
 * 驱动真 `ChatController`（offline stub），只看发给窗口的帧与假服务端收到的调用。
 *
 * 报障现场（用户 2026-09-24 报的现场）：点「+」之后输入 `/` 不弹命令栏、输入 `@`
 * 列表为空。根因是 `newSession` 退化成「退回空态」之后**没有域**，而命令目录与文件
 * 候选都是会话（agent）作用域的 RPC——`listCommandsForView` / `queryFiles` 在
 * `scopeOfView()` 为空时直接回空帧（真服务端也没有无会话端点：两个 RPC 都是
 * `@RemoteScope('agent')`，按 `agentId` 查活跃 agent）。
 *
 * 修法是**按需建会话**（`ensureSessionForMenu`），本测试钉住它的四条口径：
 *
 * 1. 空态下两个菜单都有内容（用户可见的验收标准）；
 * 2. 目录没定（没打开文件夹、也没选过）时**不建会话、也不弹目录选择器**，
 *    空菜单由界面那句「未选择工作区」解释（用户 2026-09-24 拍板的口径 C）；
 * 3. 菜单按需建的会话**不进历史列表**（服务端 `blank` 位；否则又是「点一下就多一条
 *    空会话」，用户 2026-09-22 报过的现场）；
 * 4. 并发与复用：`@` 每敲一个字符都会重取候选，同一窗口只建一条；按 Esc 走开再回来
 *    时**接回**那条空会话，不再堆一条。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[emptyComposer] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");
// 与 controller 同一个模块实例（同一次 esbuild 打包 + alias），所以下面替换
// `showOpenDialog` 能被 controller 看到——用来证明**菜单路径不弹目录选择器**。
const vscode = await import("vscode");

const CWD = "C:\\work\\demo";

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/**
 * 假服务端：会话作用域的 RPC 只认**它自己创建过的** agent id。
 *
 * 这条约束是测试的关键——真服务端的 `commands/list` / `fileReferences/list` 都是
 * `@RemoteScope('agent')`，host 侧按 `agentId` 查活跃 agent，查不到就报错
 * （`api/session-controller/src/agent.ts` 的 `resolveAgent`）。所以「随便找个已有会话
 * 糊一份目录」在这条回路里也会红。
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
  return {
    calls,
    rows,
    async createSession(target: { workspaceId?: string; cwd?: string }) {
      calls.push("session/create");
      const sessionId = `session-blank-${rows.length + 1}`;
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
      if (method === "agentPresets/list") return { presets: [], modeSelectionEnabled: false };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (!rows.some((row) => row.sessionId === agentId)) throw new Error("session not found");
      if (method === "commands/list") {
        return [
          { name: "plan", description: "切换计划模式" },
          { name: "compact", description: "压缩上下文" },
        ];
      }
      if (method === "fileReferences/list") return [{ path: "src/index.ts", kind: "file" }];
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

/** 建一个控制器并把假客户端接上（`client` / `connection` 与真实绑定路径同形）。 */
function makeController(options: { dir?: string } = {}) {
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
  const c = controller as unknown as {
    client: unknown;
    connection: string;
    sessions: { id: string; blank?: boolean }[];
    viewSessions: Map<string, string>;
    newSessionCwd?: string;
    bindView(viewId: string): void;
    newSession(viewId?: string): Promise<void>;
    handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  };
  // 目录已知的那一档：`newSessionCwd` 就是「用户在新会话页上选过目录」那个值
  // （`workspacePath()` 与 `hasWorkspaceDir()` 都读它），而 vscode 的 stub 里
  // `workspaceFolders` 是空的——正好用来区分「打开着文件夹」与「选过目录」两种
  // 已知形态里的后一种。
  if (options.dir !== undefined) c.newSessionCwd = options.dir;
  const client = fakeClient();
  c.client = client as never;
  c.connection = "connected";
  return { c, frames, client };
}

/** 最近一帧发给 viewId 的某类型帧。 */
function lastFrame(frames: Captured[], viewId: string, type: string): Record<string, unknown> | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target === viewId && frame.type === type) return frame;
  }
  return undefined;
}

/** 最近一帧发给所有窗口的会话列表。 */
function lastSessions(frames: Captured[]) {
  const frame = lastFrame(frames, "all", "sessions");
  return (frame?.sessions ?? []) as { id: string; blank?: boolean }[];
}

/** 打两个菜单，把量到的候选数打印出来（哪个窗口、假服务端建了几条会话都要看得见）。 */
async function openMenus(c: ReturnType<typeof makeController>["c"], viewId: string) {
  await c.handle({ type: "listCommands" }, viewId);
  await c.handle({ type: "queryFiles", query: "" }, viewId);
}

console.log("emptyComposer: 空态下的 / 命令栏与 @ 候选（驱动真控制器，offline stub）");

// ---------- 一、报障现场：目录已知时空态两个菜单都有内容 ----------
{
  const { c, frames, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  assert.deepStrictEqual(client.calls.filter((m) => m === "session/create"), [], "前置：点「+」不建会话");
  console.log("  空态就位：会话记录 0 条 ✓");

  frames.length = 0;
  await openMenus(c, "v1");
  const commands = (lastFrame(frames, "v1", "commands/list")?.commands ?? []) as { name?: string }[];
  const items = (lastFrame(frames, "v1", "files/list")?.items ?? []) as { path?: string }[];
  console.log(`  / 命令栏：${commands.length} 条 ${commands.map((row) => row.name).join(", ")}`);
  console.log(`  @ 候选：${items.length} 条 ${items.map((row) => row.path).join(", ")}`);
  assert.ok(commands.length > 0, "空态下输入 `/` 必须弹出命令栏（报障现场：一条都没有）");
  assert.ok(items.length > 0, "空态下输入 `@` 必须列出文件候选（报障现场：列表为空）");
  assert.strictEqual(client.rows.length, 1, "两个菜单共用同一条按需建出来的会话");
  // 窗口**绑在**这条会话上：随后发送走的是「已有域」那条路，不会再建一条（否则
  // 菜单打开过的那条就成了孤儿，一次 `/` 加一次发送就是两条记录）
  assert.strictEqual(
    c.viewSessions.get("v1"),
    client.rows[0].sessionId,
    "菜单按需建的会话要立刻绑到这个窗口上",
  );
  console.log(`  按需建的会话：${client.rows[0].sessionId}（已绑窗口）✓`);
}

// ---------- 二、空会话不进历史列表（否则「点一下就多一条空会话」又回来了） ----------
{
  const { c, frames, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  await openMenus(c, "v1");
  const id = client.rows[0].sessionId;
  const listed = lastSessions(frames).map((row) => row.id);
  console.log(`  界面列表：${listed.length} 条${listed.length ? ` ${listed.join(", ")}` : ""}（域里那条是 ${id}）`);
  assert.ok(
    !listed.includes(id),
    "还没开始对话的空会话不许进历史列表（服务端 blank 位，官方列表同一口径）",
  );
  assert.ok(
    c.sessions.some((row) => row.id === id && row.blank === true),
    "空会话必须仍留在宿主自己的列表里（cwd 解析、恢复窗口、复用都要读它）",
  );
}

// ---------- 三、目录没定：不建会话、不弹目录选择器，菜单回空 ----------
{
  const dialogs: string[] = [];
  const original = vscode.window.showOpenDialog;
  (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => {
    dialogs.push("showOpenDialog");
    return undefined;
  };
  try {
    const { c, frames, client } = makeController();
    c.bindView("v1");
    await c.newSession("v1");
    await openMenus(c, "v1");
    const commands = (lastFrame(frames, "v1", "commands/list")?.commands ?? []) as unknown[];
    const items = (lastFrame(frames, "v1", "files/list")?.items ?? []) as unknown[];
    console.log(`  无目录：命令 ${commands.length} 条、候选 ${items.length} 条、目录选择器 ${dialogs.length} 次`);
    assert.strictEqual(
      dialogs.length,
      0,
      "菜单路径不许弹目录选择器（用户 2026-09-24 口径：把选目录留在空态页那颗按钮上）",
    );
    assert.deepStrictEqual(client.rows, [], "目录没定就不建会话（会话的 cwd 是创建事实）");
    assert.strictEqual(commands.length, 0, "没有会话就没有命令目录");
    assert.strictEqual(items.length, 0, "没有会话就没有文件候选");
    // 界面那一侧的判据：窗口快照里的工作目录是空串（`workspace.path === ""`），
    // 弹层据此把空菜单说成「未选择工作区」而不是「没有可用命令」
    const workspace = (lastFrame(frames, "v1", "state")?.state as { workspace?: { path?: string } })?.workspace;
    assert.strictEqual(workspace?.path, "", "空态快照里的工作目录必须是空串（界面据此解释空菜单）");
  } finally {
    (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = original;
  }
}

// ---------- 四、并发：@ 每敲一个字符重取一次，同一窗口只建一条会话 ----------
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  await Promise.all([
    c.handle({ type: "listCommands" }, "v1"),
    c.handle({ type: "queryFiles", query: "" }, "v1"),
    c.handle({ type: "queryFiles", query: "s" }, "v1"),
    c.handle({ type: "queryFiles", query: "sr" }, "v1"),
  ]);
  console.log(`  四次并发菜单请求 → 建会话 ${client.calls.filter((m) => m === "session/create").length} 次`);
  assert.strictEqual(
    client.calls.filter((m) => m === "session/create").length,
    1,
    "同一窗口的并发建会话必须合并成一次（否则一次 @ 补全就堆出好几条空会话）",
  );
}

// ---------- 五、复用：按 Esc 走开（点「+」退回空态）再打开菜单，接回同一条空会话 ----------
{
  const { c, frames, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  await openMenus(c, "v1");
  const first = client.rows[0]?.sessionId;
  // 用户没发消息就点了「+」（= 窗口退回空态），再打开一次菜单
  await c.newSession("v1");
  frames.length = 0;
  await openMenus(c, "v1");
  const commands = (lastFrame(frames, "v1", "commands/list")?.commands ?? []) as unknown[];
  console.log(`  走开再回来：服务端共 ${client.rows.length} 条会话（首条 ${first}），命令 ${commands.length} 条`);
  assert.strictEqual(client.rows.length, 1, "没开始对话的空会话要接回来复用，不再堆一条");
  assert.ok(commands.length > 0, "复用那条会话后菜单照常有内容");
}

// ---------- 六、换了目录就不复用（会话的 cwd 是创建事实，不能张冠李戴） ----------
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  await openMenus(c, "v1");
  await c.newSession("v1");
  c.newSessionCwd = "C:\\work\\other";
  await openMenus(c, "v1");
  console.log(`  换目录后：服务端 ${client.rows.length} 条会话（cwd 分别是 ${client.rows.map((row) => row.cwd).join(" / ")}）`);
  assert.strictEqual(client.rows.length, 2, "换了工作目录就该建新会话，不能接旧目录那条");
}

console.log("emptyComposer: 空态菜单按需建会话、空会话不进列表、不弹目录框、并发合并、可复用 ✓");
