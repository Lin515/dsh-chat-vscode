/**
 * 「空壳会话记着的 agent 预设后来被删掉了」的**行为级**回归（用户 2026-10-16 报障）。
 *
 * 现场：新会话复用（`reuseOrCreateBlank`）接回的是一条**以前建的空壳**，它的日志里
 * 记着当时选的**自定义预设**，而那个预设后来从部署里删掉了。这时两条事实叠成死局：
 *
 * - 服务端激活这条会话要按**日志里记着的**预设组装（`agent-preset-registry` 的
 *   `session.ts`：重建读 `agentPreset` 投影，不读 header），解析不到就整条 resume 失败；
 * - 预设切换走 `agentPresets/select`，而它的 `agent` 形参是**只认活着的 Agent** 的查找
 *   （`packages/core/agent` 的 `lookups.register('agent', …)` → `agents.get`）。
 *
 * 于是会话看得见、用不了：空态页那枚预设胶囊点下去只会弹「切换失败」，第一条消息也发不出去。
 *
 * 官方同一处怎么活的：`ui-workspace` 的 `createInWorkspace` / `restoreBlank` 接回空壳时
 * **总是走一次 `session/create`**（`sessionId` 指名复用），并在服务端回
 * `agent-preset/not-found` / `agent-preset/invalid` 时**不带预设再认领一次**——服务端
 * 于是按部署默认重新组装，那条会话就活了（`restoreBlank` 的注释逐字如此）。
 *
 * 本断言钉住五件事：
 * 1. 接回一条空壳必须**指名认领**（`session/create` 带 `sessionId`），否则它的 Agent
 *    永远不会被服务端激活；
 * 2. 认领时**先照日志里记着的预设报一次**（还在的话服务端什么都不改——「复用不动它的
 *    预设」这条口径不许被顺手改掉）；不在了才退回部署默认；
 * 3. 修好之后**预设切得动**（用户报的那件事本身）；
 * 4. 已经在一条空壳上再点「+」：**完全 no-op**（用户 2026-10-17 21:00 口径）——目录保留、
 *    id 不变、绑定不动，它记着的预设 / 模型也原样留着；
 * 5. 两个窗口进空态**不共用**同一条空壳（同上口径：空壳按窗口独占）。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）；假的 `session/create` / `agentPresets/select` 按真服务端那两条
 * 规则写：**指名认领才会激活**、**认不出记着的预设就整条失败**。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[blankPresetAdopt] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");
const { DshApiError } = await import("../src/dsh/client");

const CWD = "C:\\work\\demo";
/** 部署里现在还有的预设（roster）与它的默认档。 */
const ROSTER = ["standard", "ptc"];
const DEFAULT_PRESET = "standard";
/** 空壳日志里记着、但部署里已经删掉的自定义预设。 */
const GONE = "my-custom-preset";
/**
 * 假服务端那条空壳。
 *
 * id 刻意是**不可能存在的**目录名：`deleteSession` 会按会话 id 去 `~/.dsh/sessions` 下
 * 找同名目录并 `rmSync`，这条断言绝不许碰到真会话（找不到就是「日志目录已不存在」那条路）。
 */
const SHELL = "probe-blank-shell-1";

interface Row {
  sessionId: string;
  cwd: string;
  blank: boolean;
  running: boolean;
  /** 会话日志里记着的预设（服务端的 `agentPreset` 投影）。 */
  preset: string;
  updatedAt: number;
}

/**
 * 假服务端：只实现这条链路要用的那几条 RPC，但**形状与规则照真服务端写**。
 *
 * @param seed 预置的会话行（这里用来摆出「以前建的空壳」）。
 */
function fakeClient(seed: { sessionId: string; blank?: boolean; preset?: string }[]) {
  const rows: Row[] = seed.map((row, index) => ({
    sessionId: row.sessionId,
    cwd: CWD,
    blank: row.blank !== false,
    running: false,
    preset: row.preset ?? DEFAULT_PRESET,
    updatedAt: Date.now() + index,
  }));
  /** 服务端内存里**活着**的 Agent（只有认领 / 新建才会激活；`agent` 查找只认它）。 */
  const live = new Set<string>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const methods = () => calls.map((call) => call.method);
  const rowOf = (sessionId: unknown) => rows.find((row) => row.sessionId === String(sessionId));

  return {
    rows,
    live,
    calls,
    methods,
    /** 这条会话此刻的预设（服务端记着的那一个）。 */
    presetOf(sessionId: string) {
      return rowOf(sessionId)?.preset;
    },
    async createSession(
      target: {
        workspaceId?: string;
        cwd?: string;
        agentPreset?: string;
      },
      /** 指名复用哪一条（与真客户端的第二个位置参数同形，见 `DshClient.createSession`）。 */
      reuse?: string,
    ) {
      calls.push({ method: "session/create", params: { ...target, ...(reuse === undefined ? {} : { sessionId: reuse }) } });
      if (reuse !== undefined) {
        const row = rowOf(reuse);
        // 真服务端：指名的那条已经开始过对话 / 写者不放手 / 归档了 → 另铸一条新的
        if (!row || !row.blank) {
          return { sessionId: `session-minted-${rows.length + 1}`, agentPreset: target.agentPreset ?? DEFAULT_PRESET };
        }
        // 真服务端：认不出被点名的预设就整条失败（`agent-preset-registry` 的 `resolve`）
        if (target.agentPreset !== undefined && !ROSTER.includes(target.agentPreset)) {
          throw new DshApiError("agent-preset/not-found", `Unknown agent preset: ${target.agentPreset}`, {
            agentPreset: target.agentPreset,
            available: ROSTER,
          });
        }
        // 认领成功：Agent 就此活着；预设按请求走，没点名就是部署默认（服务端 `defaultId`）
        row.preset = target.agentPreset ?? DEFAULT_PRESET;
        live.add(row.sessionId);
        return { sessionId: row.sessionId, agentPreset: row.preset };
      }
      const sessionId = `session-new-${rows.length + 1}`;
      rows.push({
        sessionId,
        cwd: target.cwd ?? "",
        blank: true,
        running: false,
        preset: target.agentPreset ?? DEFAULT_PRESET,
        updatedAt: Date.now() + rows.length,
      });
      live.add(sessionId);
      return { sessionId, agentPreset: target.agentPreset ?? DEFAULT_PRESET };
    },
    /** 真服务端：`agentPresets/select` 的 `agent` 形参走**只认活 Agent** 的查找。 */
    async selectAgentPreset(agentId: string, agentPreset: string) {
      calls.push({ method: "agentPresets/select", params: { agentId, agentPreset } });
      if (!live.has(agentId)) {
        throw new DshApiError("gateway/lookup-not-found", `agent lookup did not find "${agentId}"`, {
          field: "agentId",
        });
      }
      const row = rowOf(agentId);
      if (row) row.preset = agentPreset;
      return agentPreset;
    },
    /** 真客户端的专用方法：`agentPresetFor` 的 roster 默认档靠它（不是那条 `request` 路）。 */
    async listAgentPresets() {
      return {
        presets: ROSTER.map((id) => ({ id, ...(id === DEFAULT_PRESET ? { isDefault: true } : {}) })),
      };
    },
    async listSessions() {
      return {
        items: rows.map((row) => ({
          sessionId: row.sessionId,
          cwd: row.cwd,
          blank: row.blank,
          running: row.running,
          updatedAt: row.updatedAt,
          projections: { asOfSeq: 1, values: { agentPreset: row.preset } },
        })),
      };
    },
    async request(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: { ...(params ?? {}) } });
      if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
      // 命令通道（`/permission` 等命令走它）：认领 / 后续命令链路的通用夹具
      if (method === "commands/execute") {
        return { commandId: "cmd-1", result: { kind: "success", text: String(params?.line ?? "") } };
      }
      if (method === "agentPresets/list") {
        return { presets: ROSTER.map((id) => ({ id, ...(id === DEFAULT_PRESET ? { isDefault: true } : {}) })) };
      }
      if (method === "agentPresets/select") return this.selectAgentPreset(String(params?.agentId), String(params?.agentPreset));
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (rowOf(agentId)) {
        if (method === "commands/list") return [];
        if (method === "fileReferences/list") return [];
        if (method === "sessionReferenceResolver/candidates") return [];
        if (method === "skills/list") return { skills: [] };
        return undefined;
      }
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
      // 真服务端开帧就是一份 snapshot：交点空日志的快照（`cursor: 0`），与真链路上
      // 「刚建 / 刚接回的壳还没有任何记录」一致
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

interface ControllerInternals {
  client: unknown;
  connection: string;
  sessions: { id: string; blank?: boolean }[];
  deletedSessionIds: Set<string>;
  viewSessions: Map<string, string>;
  newSessionCwd?: string;
  bindView(viewId: string): void;
  openSession(viewId: string, sessionId: string): Promise<void>;
  restoreViewSession(viewId: string, sessionId: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
}

function makeController(seed: { sessionId: string; blank?: boolean; preset?: string }[]) {
  const controller = new ChatController(
    fakeServer() as never,
    (line: string) => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: { target: string; frame: Record<string, unknown> }[] = [];
  (
    controller as never as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  const c = controller as unknown as ControllerInternals;
  const client = fakeClient(seed);
  c.client = client as never;
  c.connection = "connected";
  c.newSessionCwd = CWD;
  // 真链路上预设目录由 `onConnected` 取；这些用例从「已连接」起步，补这一趟。
  // 少了它 `agentPresetFor` 认不出部署默认（roster 空），认领那条路报出的预设与
  // 空态胶囊显示的档位就都不是这里要验证的东西。
  void c.loadAgentPresets();
  return { c, client, frames };
}

/** 让排上队的微任务跑完（这些链全是同步代码 + 立即 resolve 的假 RPC）。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 界面收到的失败提示（`@agentPresetFailed:` 那一类）。
 *
 * 通知取代了从前的瞬时 `toast` 帧：取每个窗口**最近一次**收到的镜像，再挑 warn 那档。
 */
function warnings(frames: { target?: string; frame: Record<string, unknown> }[]): string[] {
  const latest = new Map<string, { level: string; text: string }[]>();
  for (const { target, frame } of frames) {
    const patch = (frame as { patch?: { notifications?: { level: string; text: string }[] } }).patch;
    if (patch?.notifications) latest.set(target ?? "", patch.notifications);
  }
  return [...latest.values()]
    .flat()
    .filter((notice) => notice.level === "warn")
    .map((notice) => notice.text);
}

console.log("blankPresetAdopt: 空壳记着的预设被删掉之后还切不切得动（驱动真控制器，offline stub）");

// ---------- 一、报障现场：空壳记着一条已经不存在的预设 ----------
//
// 点「+」把窗口落到这条空壳上：宿主必须**指名认领**它（`session/create` 带 `sessionId`），
// 认领时先报日志里那个预设（服务端回 not-found），再退回部署默认重试一次。之后这条会话
// 是活的、预设切得动——用户报的「无法切换预设」就是这两步都缺。
{
  const { c, client, frames } = makeController([{ sessionId: SHELL, preset: GONE }]);
  c.bindView("v1");
  await c.handle({ type: "newSession" }, "v1");
  await settle();

  console.log(
    `  调用序列：${client.methods().join(" → ")}\n` +
      `  服务端：${SHELL} 预设=${client.presetOf(SHELL)} 活着=${client.live.has(SHELL)}`,
  );
  assert.strictEqual(
    c.viewSessions.get("v1"),
    SHELL,
    "空壳还是那条（认领不等于另建：服务端回的 sessionId 就是它）",
  );
  const adopts = client.calls.filter(
    (call) => call.method === "session/create" && call.params.sessionId === SHELL,
  );
  assert.ok(
    adopts.length >= 1,
    "接回一条已有空壳必须走 `session/create` 指名认领（`sessionId`）——不走这一步，服务端永远不会激活它的 Agent",
  );
  assert.strictEqual(
    adopts[0].params.agentPreset,
    GONE,
    "认领时先照日志里记着的那个预设报一次（还在就什么都不改，这是「复用不动它的预设」那条口径）",
  );
  assert.strictEqual(
    adopts.length,
    2,
    "服务端回 `agent-preset/not-found` 之后要**不带预设再认领一次**（官方 `restoreBlank` 的兜底）",
  );
  assert.strictEqual(adopts[1].params.agentPreset, undefined, "第二次认领不再点名预设，由服务端按部署默认组装");
  assert.strictEqual(client.presetOf(SHELL), DEFAULT_PRESET, "那条空壳的预设换成了部署默认");
  assert.ok(client.live.has(SHELL), "认领之后它的 Agent 必须是活的（`agentPresets/select` 只认活 Agent）");

  // 用户报的那件事：在这个会话里点预设胶囊切到另一档
  await c.handle({ type: "setAgentPreset", id: "ptc" }, "v1");
  await settle();
  console.log(`  切预设之后：预设=${client.presetOf(SHELL)}；告警=${warnings(frames).join(" / ") || "（无）"}`);
  assert.strictEqual(client.presetOf(SHELL), "ptc", "修好之后预设必须切得动（用户报障的正面）");
  assert.deepStrictEqual(warnings(frames), [], "切换不该再弹「切换失败」");
}

// ---------- 二、记着的预设还在：认领一次就好，且不许改它 ----------
//
// 「复用不动它的预设」是**有意**的口径（空态页那几枚胶囊显示的就是这条会话的真实状态）。
// 认领时把日志里那个预设照原样报一次，服务端发现目标与现状相同就什么都不记——既激活了
// Agent，又没动用户当初的选择。
{
  const { c, client } = makeController([{ sessionId: SHELL, preset: "ptc" }]);
  c.bindView("v1");
  await c.handle({ type: "newSession" }, "v1");
  await settle();

  const adopts = client.calls.filter(
    (call) => call.method === "session/create" && call.params.sessionId === SHELL,
  );
  console.log(`  调用序列：${client.methods().join(" → ")}`);
  assert.strictEqual(adopts.length, 1, "预设还在时只认领一次（不必再退回默认）");
  assert.strictEqual(adopts[0].params.agentPreset, "ptc", "报的是它自己那个预设");
  assert.strictEqual(client.presetOf(SHELL), "ptc", "认领不许顺手改掉这条会话记着的预设");
  assert.ok(client.live.has(SHELL), "认领要激活 Agent");
  assert.strictEqual(c.viewSessions.get("v1"), SHELL, "窗口落在它上面");
}

// ---------- 三、打开 / 恢复一条空壳（不走「+」的复用扫描）也要认领 ----------
//
// 窗口状态缓存把窗口接回一条空壳（`restoreViewSession` → `openSession`）是另一条入口：
// 少了这一步，重载 VS Code 之后那条会话照样是死的。
{
  const { c, client } = makeController([{ sessionId: SHELL, preset: GONE }]);
  c.bindView("v1");
  // 恢复那条路会先确认会话还在（列表为空时先拉一份）——这里就走它
  await c.restoreViewSession("v1", SHELL);
  await settle();

  console.log(
    `  调用序列：${client.methods().join(" → ")} 预设=${client.presetOf(SHELL)} 活着=${client.live.has(SHELL)}`,
  );
  assert.ok(client.live.has(SHELL), "打开一条空壳也要让它活过来（否则「能看不能用」）");
  assert.strictEqual(client.presetOf(SHELL), DEFAULT_PRESET, "记着的预设没了就退回部署默认");
  assert.strictEqual(c.viewSessions.get("v1"), SHELL, "窗口仍在这条会话上（认领不换会话）");
}

// ---------- 四、已经在空壳上再点「+」：**完全 no-op**，不删目录、不换 id ----------
//
// 用户 2026-10-17 21:00 口径：停在一条空壳上点「+」什么都不做
// ——目录保留、id 不变、绑定不动，它记着的预设照旧留着（不写回部署默认）。只有窗口**不在**
// 空壳上（内容会话 / 无壳）时才落壳。
{
  const { c, client } = makeController([{ sessionId: SHELL, preset: DEFAULT_PRESET }]);
  c.bindView("v1");
  await c.handle({ type: "newSession" }, "v1");
  await settle();
  assert.strictEqual(c.viewSessions.get("v1"), SHELL, "前置：窗口落在原有的空壳上");
  const createsBefore = client.calls.filter((call) => call.method === "session/create").length;
  // 在壳上改一档预设：no-op 之后照旧留着它（不再写回部署默认）
  await c.handle({ type: "setAgentPreset", id: "ptc" }, "v1");
  await settle();
  assert.strictEqual(client.presetOf(SHELL), "ptc", "前置：这条壳记着的预设被改成 ptc");
  const callsBefore = client.calls.length;

  await c.handle({ type: "newSession" }, "v1");
  await settle();

  console.log(
    `  再点一次「+」：仍是 ${c.viewSessions.get("v1")}；预设=${client.presetOf(SHELL)}；` +
      `已删集合=${[...c.deletedSessionIds].join(", ") || "（空）"}`,
  );
  assert.strictEqual(c.viewSessions.get("v1"), SHELL, "同一窗口再点「+」完全 no-op（不换 id）");
  assert.ok(!c.deletedSessionIds.has(SHELL), "旧会话目录**不删**");
  assert.ok(c.sessions.some((row) => row.id === SHELL), "它仍留在宿主列表里（这一次仍绑着它）");
  assert.strictEqual(client.presetOf(SHELL), "ptc", "no-op 不改写预设（用户刚选的那一档照旧留着）");
  assert.strictEqual(client.calls.length, callsBefore, "no-op 一条 RPC 都不发（连认领也不发）");
  assert.strictEqual(
    client.calls.filter((call) => call.method === "session/create").length,
    createsBefore,
    "no-op 不认领、也不另铸",
  );
}

// ---------- 五、两个窗口都进空态：**不许共用**同一条空壳 ----------
//
// 用户 2026-10-17 口径取代了 2026-10-01 的「多窗口共用一条空壳是官方字面行为」：
// 空壳按窗口独占（运行期占用）。第二个窗口进空态时另建一条，谁都不动别人的会话。
{
  const { c, client } = makeController([{ sessionId: SHELL, preset: DEFAULT_PRESET }]);
  c.bindView("v1");
  c.bindView("v2");
  await c.handle({ type: "newSession" }, "v1");
  await settle();
  assert.strictEqual(c.viewSessions.get("v1"), SHELL, "第一个窗口接回那条现成空壳");

  await c.handle({ type: "newSession" }, "v2");
  await settle();

  const second = String(c.viewSessions.get("v2"));
  console.log(`  两个窗口各自进空态：v1=${c.viewSessions.get("v1")}；v2=${second}`);
  assert.notStrictEqual(second, SHELL, "第二个窗口不许共用第一条空壳（空壳不跨窗口共享）");
  assert.ok(client.rows.some((row) => row.sessionId === second), "第二条是服务端上真实存在的一条");
  assert.strictEqual(c.viewSessions.get("v1"), SHELL, "第一个窗口的绑定不被打扰");
  assert.ok(!c.deletedSessionIds.has(SHELL), "任何一条都不许因此被删");

  // 第一个窗口点「+」：no-op 自己那条，不许把第二个窗口的壳抢过来
  await c.handle({ type: "newSession" }, "v1");
  await settle();
  assert.strictEqual(c.viewSessions.get("v1"), SHELL, "v1 仍在自己那条上（no-op）");
  assert.strictEqual(c.viewSessions.get("v2"), second, "v2 的会话照旧");
}

console.log("blankPresetAdopt: 空壳认领、停在空壳上点「+」的 no-op 与窗口独占 ✓");
