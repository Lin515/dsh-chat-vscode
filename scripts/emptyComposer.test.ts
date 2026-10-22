/**
 * 空态（新会话、还没开始对话）下 `/` 命令栏与 `@` 候选列表的**行为级**回归：
 * 驱动真 `ChatController`（offline stub），只看发给窗口的帧与假服务端收到的调用。
 *
 * 报障现场（用户 2026-09-24 报的现场）：点「+」之后输入 `/` 不弹命令栏、输入 `@`
 * 列表为空。根因是「退回空态」之后**没有域**，而命令目录与文件候选都是会话（agent）
 * 作用域的 RPC——`listCommandsForView` / `queryFiles` 在 `scopeOfView()` 为空时直接回空帧
 * （真服务端也没有无会话端点：两个 RPC 都是 `@RemoteScope('agent')`，按 `agentId`
 * 查活跃 agent）。
 *
 * 2026-10-01 口径调整后（对齐官方 DSH Web：**空态就是一条真会话**），这两个菜单的
 * 前提变了——空态窗口在进空态那一刻就绑在本工作区那条空壳上（见 `newSession`），
 * 菜单只是读它。所以本测试钉住的是：
 *
 * 1. 空态下两个菜单都有内容（用户可见的验收标准），且**不再各建一条**会话；
 * 2. 目录没定（没打开文件夹、也没选过）时**不建会话、也不弹目录选择器**，
 *    空菜单由界面那句「未选择工作区」解释（用户 2026-09-24 拍板的口径 C）；
 * 3. 还没开始对话的空壳**照样进历史列表**（用户 2026-10-17 口径：空壳要能被看见、被删除），
 *    只是被某个会话窗口占着的那一条带上 `occupied` 锁；
 * 4. 并发：`@` 每敲一个字符都会重取候选，同一窗口只落一条会话（`sessionEnsures`）；
 * 5. 菜单只读现成的空壳；当前已经是一条空壳时再点「+」是**完全 no-op**（不删目录、不换 id）；
 *    换了目录则不接（会话的 cwd 是创建事实）。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandView } from "../src/shared/chat";

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
    async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string) {
      calls.push("session/create");
      // 指名复用一条已有会话（`session/create` 的第二个位置参数，认领见 controller 的
      // `adoptBlankShell`）：服务端认得它就**还是那条**，顺手把它的 Agent 激活
      if (reuse !== undefined) {
        const row = rows.find((item) => item.sessionId === reuse);
        if (row) return { sessionId: row.sessionId };
      }
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
      // 命令通道（`/permission` 等命令走它）：认领 / 后续命令链路的通用夹具
      if (method === "commands/execute") {
        return { commandId: "cmd-1", result: { kind: "success", text: String(params?.line ?? "") } };
      }
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      if (method === "skills/list") {
        const request = params?.request as { sessionId?: string } | undefined;
        assert.ok(rows.some((row) => row.sessionId === request?.sessionId), "技能目录按 request.sessionId 寻址");
        return { skills: [{ name: "nav-test", description: "Skill description", path: join(tmpdir(), "skills", "nav-test", "SKILL.md"), modelInvocable: true }] };
      }
      const agentId = String(params?.agentId ?? "");
      if (!rows.some((row) => row.sessionId === agentId)) throw new Error("session not found");
      if (method === "commands/list") {
        return [
          { name: "plan", definitionId: "@deepseek-ai/dsh-plan-mode", description: "Enter plan mode" },
          { name: "compact", description: "压缩上下文" },
        ];
      }
      if (method === "fileReferences/list") return [{ path: "src/index.ts", kind: "file" }];
      if (method === "sessionReferenceResolver/candidates") return [];
      return undefined;
    },
    async scheduleCatalog() {
      // 这个部署有自动化任务能力、但当前会话一条都没有（目录为空）
      return [];
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
    followSession(sessionId: string, handler: { onItem(value: unknown): void }) {
      // 开帧快照（空日志）：与真链路上「刚建 / 刚接回的壳还没有任何记录」一致
      handler.onItem({
        type: "snapshot",
        header: { version: 3, id: sessionId, createdAt: 1, cwd: CWD, isSeeded: false },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: {} },
      });
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
    deletedSessionIds: Set<string>;
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

/**
 * 最近一帧**这个窗口收到**的会话列表。
 *
 * 没有打开文件夹时宿主按窗口各发一份（历史列表跟随该窗口当前会话的 cwd，见
 * `scripts/sessionListScope.test.ts`），所以判据要与 `chatView.deliver` 的过线语义一致：
 * `target === "all"` 是广播，定向帧只有该 viewId 收得到。
 */
function lastSessions(frames: Captured[], viewId: string) {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (frame.type !== "sessions") continue;
    if (target !== "all" && target !== viewId) continue;
    return (frame.sessions ?? []) as { id: string; blank?: boolean }[];
  }
  return [];
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
  // 2026-10-01 口径：点「+」就地落到本工作区那条空壳上（空态 = 一条真会话）
  assert.strictEqual(client.rows.length, 1, "点「+」落到本工作区那条空壳上");
  const shell = client.rows[0].sessionId;
  assert.strictEqual(
    c.viewSessions.get("v1"),
    shell,
    "空态窗口必须就地绑在那条空壳上——两个菜单的 RPC 都是会话作用域的，没有域就是报障现场",
  );
  console.log(`  空态就位：空壳 ${shell}（已绑窗口）✓`);

  frames.length = 0;
  await openMenus(c, "v1");
  const commands = (lastFrame(frames, "v1", "commands/list")?.commands ?? []) as CommandView[];
  const items = (lastFrame(frames, "v1", "files/list")?.items ?? []) as { path?: string }[];
  console.log(`  / 命令栏：${commands.length} 条 ${commands.map((row) => row.name).join(", ")}`);
  console.log(`  @ 候选：${items.length} 条 ${items.map((row) => row.path).join(", ")}`);
  assert.ok(commands.length > 0, "空态下输入 `/` 必须弹出命令栏（报障现场：一条都没有）");
  assert.equal(commands.find((row) => row.name === "plan")?.definitionId, "@deepseek-ai/dsh-plan-mode", "命令身份完整过线，供官方双语描述选取");
  assert.equal(commands.find((row) => row.name === "nav-test")?.skillPath, join(tmpdir(), "skills", "nav-test", "SKILL.md"), "技能文件路径不得在目录映射时丢失");
  assert.equal(commands.find((row) => row.name === "nav-test")?.skill, true);
  assert.ok(items.length > 0, "空态下输入 `@` 必须列出文件候选（报障现场：列表为空）");
  assert.strictEqual(client.rows.length, 1, "两个菜单读的是同一条空壳，谁都不再另建会话");
  assert.strictEqual(c.viewSessions.get("v1"), shell, "打开菜单不会把窗口换到别的会话上");
  console.log("  两个菜单都有内容，且没有多出会话 ✓");
}

// ---------- 二、空会话进历史列表，且被本窗口占着时带上锁 ----------
{
  const { c, frames, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  await openMenus(c, "v1");
  const id = client.rows[0].sessionId;
  const listed = lastSessions(frames, "v1") as { id: string; occupied?: boolean }[];
  const row = listed.find((item) => item.id === id);
  console.log(
    `  界面列表：${listed.length} 条${listed.length ? ` ${listed.map((item) => item.id).join(", ")}` : ""}` +
      `（域里那条是 ${id}，occupied=${row?.occupied}）`,
  );
  assert.ok(row, "还没开始对话的空会话照样要进历史列表（用户 2026-10-17 口径：空壳可见、可删）");
  assert.strictEqual(row?.occupied, true, "被某个会话窗口占着的空壳要带上占用位（界面上锁住它）");
  assert.ok(
    c.sessions.some((item) => item.id === id && item.blank === true),
    "空会话必须留在宿主自己的列表里（cwd 解析、恢复窗口、复用都要读它）",
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

// ---------- 四、并发：@ 每敲一个字符重取一次，同一窗口只落一条会话 ----------
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  // 刻意**不先点「+」**：窗口刚上线 / 刚恢复、还没走到落壳那一步的那一瞬，正是几个
  // 并发入口最容易撞上的时刻（它们都会看到「还没有域」）
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
    "同一窗口的并发落壳必须合并成一次（否则一次 @ 补全就堆出好几条空会话）",
  );
  assert.strictEqual(
    c.viewSessions.get("v1"),
    client.rows[0].sessionId,
    "并发之后窗口仍然只绑在那一条上",
  );
}

// ---------- 五、菜单只读现成的空壳；再点「+」则**完全 no-op** ----------
//
// 两条口径叠在这一段里：①打开 `/` 或 `@` 菜单**不建会话**——窗口早就绑在一条真空壳上，
// 菜单只是读它（用户 2026-09-24 / 2026-10-01 口径）；②当前已经是一条新的空会话时再点
// 「+」，用户 2026-10-17 21:00 口径是**什么都不做**——id 不变、目录不删、绑定不动，连它
// 记着的模型 / 预设 / 权限也不写回默认（见 `newSession` 的入口判据）。
{
  const { c, frames, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  const first = client.rows[0]?.sessionId;
  const created = client.calls.filter((method) => method === "session/create").length;
  await openMenus(c, "v1");
  assert.strictEqual(
    client.calls.filter((method) => method === "session/create").length,
    created,
    "打开菜单不建会话（窗口早就落在一条空壳上，菜单只是读它）",
  );
  // 用户没发消息就再点一次「+」：完全 no-op
  await c.newSession("v1");
  frames.length = 0;
  await openMenus(c, "v1");
  const commands = (lastFrame(frames, "v1", "commands/list")?.commands ?? []) as unknown[];
  const second = c.viewSessions.get("v1");
  console.log(
    `  空壳 ${first} → 再点「+」→ ${second}（服务端内存里 ${client.rows.length} 条，命令 ${commands.length} 条）`,
  );
  assert.strictEqual(second, first, "同一窗口再点「+」完全 no-op（id 不变、目录不删）");
  assert.ok(!c.deletedSessionIds.has(String(first)), "旧会话目录不删（用户 2026-10-17 口径）");
  assert.ok(
    c.sessions.some((row) => row.id === first),
    "它还在宿主那份列表里（这一次仍绑着它）",
  );
  assert.ok(commands.length > 0, "no-op 之后那条空壳的菜单照常有内容");
  assert.strictEqual(client.rows.length, 1, "没有多出会话（no-op 不另铸）");
}

// ---------- 六、空壳上换过目录标记之后再点「+」：照旧 no-op（换目录本身走 `pickWorkspace`） ----------
//
// 会话的 cwd 是创建事实，所以换目录**不能**沿用旧目录那条壳——但那条路是空态页上的目录胶囊
// （`pickWorkspace` → `rebindWorkspaceDir`：先解绑、再落到新目录那条壳上），不是「+」。
// 点「+」在一条空壳上是完全 no-op（用户 2026-10-17 21:00 口径），`newSessionCwd` 变了也一样：
// 它什么都不做，旧目录那条壳留在原地等真正的换目录动作。
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await c.newSession("v1");
  const first = c.viewSessions.get("v1");
  await openMenus(c, "v1");
  c.newSessionCwd = "C:\\work\\other";
  const callsBefore = client.calls.length;
  await c.newSession("v1");
  console.log(`  换目录标记后点「+」：服务端 ${client.rows.length} 条会话（cwd 分别是 ${client.rows.map((row) => row.cwd).join(" / ")}）`);
  assert.strictEqual(c.viewSessions.get("v1"), first, "空壳上的「+」是 no-op：不换壳、不换目录");
  assert.strictEqual(client.rows.length, 1, "no-op 不新建（换目录由 `pickWorkspace` 那条路落壳）");
  assert.strictEqual(client.calls.length, callsBefore, "no-op 一条 RPC 都不发");
}

console.log("emptyComposer: 空态必有壳、菜单读壳不另建、空壳进列表并上锁、不弹目录框、并发合并、停在空壳上点「+」no-op ✓");
