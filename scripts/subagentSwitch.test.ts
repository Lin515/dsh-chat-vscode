/**
 * 子代理页切换到兄弟的**行为级**回归（驱动真 `ChatController`，不是读源码正则）：
 *
 * 用户 2026-09-24 报障的现场：主会话 M 有子代理 A、B——从 M 进 A 时切换下拉是
 * 父层目录 [A, B]（官方口径）；**再从 A 切到 B 时，下拉里只剩 B 自己**，同级兄弟
 * 不可见（观感上像又下钻了一层）。根因（离线回路 2026-09-25 实证）：
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
 * 发给看这个会话的窗口。本测试在修复前必须红（第二跳目录/显示名、恢复路径回填），
 * 修复后全绿。
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
const LABEL_A = "子代理A";
const LABEL_B = "子代理B";

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}
type SubagentEntry = { id: string; label: string };
type SubagentContext = { parentSessionId?: string; parentEntries: SubagentEntry[] };

/** 静默假客户端：只实现本场景碰到的面；`subagents/list` 按新版口径不存在（HTTP 404）。 */
const fakeClient = () => ({
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

function makeController() {
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
    registerSubagent(scope: unknown, entry: unknown): void;
    client: unknown;
    connection: string;
    scopes: Map<string, unknown>;
  };
  c.client = fakeClient() as never;
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
  console.log("  M → A → B：目录随行、层级不变深、显示名同源 ✓");
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

console.log("subagentSwitch: 切换目录随行、回填到屏、层级不变深、显示名同源 ✓");
