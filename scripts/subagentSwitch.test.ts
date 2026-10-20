/**
 * 子代理切换的**行为级**回归（驱动真 `ChatController`，不是读源码正则）。
 *
 * 用户 2026-09-24 报障的现场：主会话 M 有子代理 A、B——从 M 进 A 时父目录快照是
 * [A, B]（官方口径）；**再从 A 切到 B 时，只剩 B 自己**，同级兄弟不可见（观感上像
 * 又下钻了一层）。根因（离线回路 2026-09-25 实证）：
 *
 * 1. 视图离开会话时域被整个回收（`bindViewToSession` → `dropViewers` →
 *    `destroyScope`）——M 的域在第一跳就没了，建 B 域时父域不在 `scopes` 里，
 *    `subagentSiblings` 只能落空，快照里只剩「兜底自己」那一行（label 还退回会话
 *    id，看起来像一串乱码名字）；
 * 2. 异步的 `fetchParentCatalog` 其实补齐了（日志「父目录（投影）2 条」），但它最后
 *    用 `syncSubagentContext(本会话id)` 通知——那条函数通知的是「正在看它的**子代理**
 *    的窗口」，看 B 的窗口永远收不到修正帧，缺陷不自愈。
 *
 * 修法：切换时把**手里的父目录**随行传给新域（`openSubagent` → `openSession` →
 * `ensureScope` 的 seed）；`fetchParentCatalog` 补齐后把修正的 subagent 上下文直接
 * 发给看这个会话的窗口。这条兄弟切换的回归继续保留。
 *
 * 用户 2026-10-20 追加：标题清单改成**整棵多层树**，从 M 可直接点 A1（A 的下级），
 * 目标父会话必须是 A；只靠 `session/list` 的 `parentSessionId` + 自身 `subagent`
 * 身份投影也要能重建同一棵树（场景三、四）。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、
 * 无网络、无 token、亚秒级）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[subagentSwitch] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");

const ID_M = "session-main";
const ID_A = "child-aaaa";
const ID_B = "child-bbbb";
const ID_A1 = "grandchild-cccc";
const LABEL_A = "子代理A";
const LABEL_B = "子代理B";
const LABEL_A1 = "子代理A1";

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}
type SubagentEntry = { id: string; label: string };
type SubagentContext = { parentSessionId?: string; parentEntries: SubagentEntry[] };
type SessionRow = {
  sessionId: string;
  updatedAt: number;
  cwd: string;
  origin?: string;
  parentSessionId?: string;
  running?: boolean;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
};

/** 静默假客户端：只实现本场景碰到的面；`subagents/list` 按新版口径不存在（HTTP 404）。 */
const fakeClient = (items: SessionRow[] = []) => ({
  async listSessions() {
    return { items };
  },
  async request(method: string) {
    if (method === "commands/list") return [];
    if (method === "subagents/list") throw new Error("subagents/list 失败：HTTP 404");
    return undefined;
  },
  /** 父会话的 `session/projections`：subagentCatalog 投影恒为 [A, B]。 */
  async sessionProjections() {
    return {
      values: {
        subagentCatalog: [
          { id: ID_A, mode: "one-shot", label: LABEL_A },
          { id: ID_B, mode: "one-shot", label: LABEL_B },
        ],
      },
    };
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
});

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

function makeController(items: SessionRow[] = []) {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  const subscription = (
    controller as never as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  const c = controller as unknown as {
    bindView(viewId: string): void;
    openSession(viewId: string, sessionId: string, subagent?: unknown, seed?: unknown): Promise<void>;
    openSubagent(viewId: string, id: string): Promise<void>;
    refreshSessions(): Promise<void>;
    snapshotFor(viewId: string): Record<string, unknown>;
    registerSubagent(scope: unknown, entry: unknown): void;
    client: unknown;
    connection: string;
    scopes: Map<string, unknown>;
  };
  c.client = fakeClient(items) as never;
  c.connection = "connected";
  return { c, frames };
}

/** 最近一帧发给 viewId 的完整状态快照。 */
function lastState(frames: Captured[], viewId: string): Record<string, unknown> | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target === viewId && frame.type === "state") return frame.state as Record<string, unknown>;
  }
  return undefined;
}

function subagentOf(state: Record<string, unknown> | undefined): SubagentContextViewOf {
  const sub = state?.subagent as { parentSessionId?: string; parentEntries?: SubagentEntry[] } | undefined;
  return { parentSessionId: sub?.parentSessionId, parentEntries: sub?.parentEntries ?? [] };
}
type SubagentContextViewOf = { parentSessionId?: string; parentEntries: SubagentEntry[] };

type TreeOf = {
  root: { id: string; title: string };
  nodes: { id: string; label: string; parentSessionId: string; depth: number }[];
};

/** 帧（patch 或 state）里的子代理树。 */
function treeOf(state: Record<string, unknown> | undefined): TreeOf | undefined {
  return state?.subagentTree as TreeOf | undefined;
}

const idsOf = (context: SubagentContextViewOf) => context.parentEntries.map((entry) => entry.id);
const hasBoth = (context: SubagentContextViewOf) => idsOf(context).includes(ID_A) && idsOf(context).includes(ID_B);

/** 帧（patch 或 state）里带的子代理上下文目录。 */
function entriesInFrame(frame: Record<string, unknown>): SubagentEntry[] {
  if (frame.type === "patch") {
    return (frame.patch as { subagent?: { parentEntries?: SubagentEntry[] } } | undefined)?.subagent?.parentEntries ?? [];
  }
  if (frame.type === "state") {
    return (frame.state as { subagent?: { parentEntries?: SubagentEntry[] } } | undefined)?.subagent?.parentEntries ?? [];
  }
  return [];
}

console.log("subagentSwitch: 驱动真控制器（offline stub）");

// ---------- 场景一：M → A → B（报障现场） ----------
{
  const { c, frames } = makeController();
  c.bindView("v1");
  await c.openSession("v1", ID_M);
  const mScope = c.scopes.get(ID_M);
  assert.ok(mScope, "M 的域应已建立（回路自身前提）");
  // 目录进册走真实入口 registerSubagent（durable 事件那一路的落点）
  c.registerSubagent(mScope, { id: ID_A, label: LABEL_A, mode: "one-shot", activity: "inactive" });
  c.registerSubagent(mScope, { id: ID_B, label: LABEL_B, mode: "one-shot", activity: "inactive" });
  frames.length = 0;

  await c.openSubagent("v1", ID_A);
  const hop1 = subagentOf(lastState(frames, "v1"));
  assert.ok(
    hasBoth(hop1),
    `第一跳快照下拉应是父层目录 [${ID_A}, ${ID_B}]，实际 [${idsOf(hop1).join(", ")}]`,
  );
  console.log(`  第一跳 parent=${hop1.parentSessionId} entries=[${idsOf(hop1).join(", ")}] ✓`);
  frames.length = 0;

  await c.openSubagent("v1", ID_B);
  const hop2 = subagentOf(lastState(frames, "v1"));
  console.log(
    `  第二跳 parent=${hop2.parentSessionId} entries=[${hop2.parentEntries.map((e) => `${e.label}<${e.id}>`).join(", ")}]`,
  );
  assert.ok(
    hop2.parentSessionId === ID_M,
    `第二跳层级不变深：parent 仍是主会话 ${ID_M}，实际 ${String(hop2.parentSessionId)}`,
  );
  assert.ok(
    hasBoth(hop2),
    `第二跳快照下拉仍应列出父层目录（兄弟 [${ID_A}, ${ID_B}]），实际 [${hop2.parentEntries.map((e) => `${e.label}<${e.id}>`).join(", ")}]`,
  );
  const current = hop2.parentEntries.find((entry) => entry.id === ID_B);
  assert.ok(
    current?.label === LABEL_B,
    `切换入口的显示名取目录行 label（${LABEL_B}），不退回会话 id；实际 ${String(current?.label)}`,
  );
  console.log("  M → A → B：目录随行、兄弟父会话不变、显示名同源 ✓");
}

// ---------- 场景二：恢复路径直接落到子代理页（父域不在），异步回填要能到屏 ----------
{
  const { c, frames } = makeController();
  c.bindView("v2");
  // 不清帧：假 RPC 在微任务里就落回，回填帧可能先于 await 恢复到达——
  // 断言看「整段里有没有回填 patch + 最终态」，不依赖帧的绝对时序
  await c.openSession("v2", ID_B, { parentSessionId: ID_M, mode: "one-shot" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const subagentFrames = frames.filter(
    ({ target, frame }) => target === "v2" && entriesInFrame(frame).length > 0,
  );
  const lastEntries = subagentFrames.length ? entriesInFrame(subagentFrames[subagentFrames.length - 1].frame) : [];
  const backfilledByPatch = frames.some(
    ({ target, frame }) => target === "v2" && frame.type === "patch" && entriesInFrame(frame).some((entry) => entry.id === ID_A),
  );
  console.log(
    `  恢复路径：subagent 帧 ${subagentFrames.length} 条，最终 entries=[${lastEntries.map((e) => e.id).join(", ")}]`,
  );
  assert.ok(
    backfilledByPatch,
    "父域不在时 fetchParentCatalog 补齐的父目录（含兄弟）必须发到看这个会话的窗口（不自愈就是报障现场）",
  );
  assert.ok(
    lastEntries.some((entry) => entry.id === ID_A) && lastEntries.some((entry) => entry.id === ID_B),
    `回填收敛后界面上的目录应是 [${ID_A}, ${ID_B}]，实际 [${lastEntries.map((e) => e.id).join(", ")}]`,
  );
  console.log("  恢复路径：回填到屏、最终态含兄弟 ✓");
}

// ---------- 场景三：多层树（用户 2026-10-20 口径） ----------
//
// M → A → A1：标题点击后的清单要同时列出 A（第 1 层，与 M 同级对齐）与 A1
// （第 2 层）。从 M 直接点 A1 也要能进——父会话是它的**真实父会话 A**，不是 M。
{
  const { c, frames } = makeController();
  c.bindView("v3");
  await c.openSession("v3", ID_M);
  const mScope = c.scopes.get(ID_M);
  assert.ok(mScope, "M 的域应已建立（多层树前提）");
  c.registerSubagent(mScope, { id: ID_A, label: LABEL_A, mode: "continuable", activity: "inactive" });

  await c.openSubagent("v3", ID_A);
  const aScope = c.scopes.get(ID_A);
  assert.ok(aScope, "A 的域应已建立（先注册它的下级）");
  c.registerSubagent(aScope, { id: ID_A1, label: LABEL_A1, mode: "one-shot", activity: "inactive" });

  // 回到顶层会话：此时树必须已经包含 A 与 A1（A1 是 A 的下级）
  await c.openSession("v3", ID_M);
  const top = treeOf(lastState(frames, "v3"));
  assert.ok(top, "顶层会话也要收到 subagentTree（标题入口的数据）");
  assert.strictEqual(top.root.id, ID_M, "树根是顶层会话 M");
  assert.deepStrictEqual(
    top.nodes.map((node) => `${node.id}@${String(node.depth)}<${node.parentSessionId}>`),
    [`${ID_A}@1<${ID_M}>`, `${ID_A1}@2<${ID_A}>`],
    "树节点先序、A 是第 1 层（与 M 同级）、A1 是第 2 层且父是 A",
  );

  // 从顶层直接点第 2 层：真实父会话必须是 A（点任意一层都算切换）
  frames.length = 0;
  await c.openSubagent("v3", ID_A1);
  const state = lastState(frames, "v3");
  const context = subagentOf(state);
  assert.strictEqual(context.parentSessionId, ID_A, "A1 的父会话是 A（不是顶层 M）");
  assert.strictEqual(treeOf(state)?.root.id, ID_M, "看子代理页时树根仍是顶层会话");
  const a1 = treeOf(state)?.nodes.find((node) => node.id === ID_A1);
  assert.strictEqual(a1?.label, LABEL_A1, "当前子代理在树里的显示名来自目录 / 标题账本");
  console.log("  M → A → A1：多层树、真实父会话、点任意一层可切换 ✓");
}

// ---------- 场景四：仅凭 session/list 重建多层树（不打开任何子代理） ----------
//
// 跨进程 / 别的窗口建出来的子代理只会出现在会话列表里：每一行带 `parentSessionId`
// 与自身的 `subagent` 身份投影。标题清单必须能只靠这份列表画出多层树。
{
  const cwd = "C:/work/demo";
  const rows: SessionRow[] = [
    { sessionId: ID_M, updatedAt: 1, cwd, projections: { asOfSeq: 1, values: { title: "主会话" } } },
    {
      sessionId: ID_A,
      updatedAt: 2,
      cwd,
      origin: "subagent",
      parentSessionId: ID_M,
      projections: {
        asOfSeq: 2,
        values: { subagent: { mode: "continuable", label: LABEL_A, seq: 1 }, title: "A 的标题" },
      },
    },
    {
      sessionId: ID_A1,
      updatedAt: 3,
      cwd,
      origin: "subagent",
      parentSessionId: ID_A,
      projections: {
        asOfSeq: 3,
        values: { subagent: { mode: "one-shot", label: LABEL_A1, seq: 1 } },
      },
    },
  ];
  const { c } = makeController(rows);
  c.bindView("v4");
  await c.refreshSessions();
  await c.openSession("v4", ID_M);
  const tree = treeOf(c.snapshotFor("v4"));
  assert.strictEqual(tree?.root.id, ID_M, "列表里主会话是树根");
  assert.strictEqual(tree?.root.title, "主会话", "树根标题来自会话列表");
  assert.deepStrictEqual(
    tree?.nodes.map((node) => `${node.id}@${String(node.depth)}<${node.parentSessionId}>`),
    [`${ID_A}@1<${ID_M}>`, `${ID_A1}@2<${ID_A}>`],
    "只看 session/list 也能画出 A → A1 的多层树",
  );
  assert.strictEqual(
    tree?.nodes.find((node) => node.id === ID_A)?.label,
    LABEL_A,
    "显示名优先取自身子代理身份投影里的 label",
  );
  console.log("  session/list 单源重建多层树 ✓");
}

console.log("subagentSwitch: 切换目录随行、回填到屏、多层树可切换、显示名同源 ✓");
