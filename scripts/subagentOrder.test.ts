/**
 * 子代理目录的**显示顺序**（纯函数 + 驱动真 `ChatController` 的行为回归）。
 *
 * 用户 2026-10-13 口径：标题右侧「N 个子代理 ▾」下拉里的行**始终**按「用户消息最新的，
 * 或者 agent 轮次结果正文最新的」时间从上到下排；两类消息同等对待（谁新谁在前，不设
 * 优先级）；**agent 的过程消息不在判定条目内**（否则生成中每来一条事件就重排一次，用户
 * 要的就是「避免反复刷新」）。
 *
 * 判定条目的两个来源（见 `src/dsh/subagentOrder.ts` 与 `controller.subagentActivityAt`）：
 *
 * - **用户消息**：`session/list` 行的 `updatedAt`——服务端 `sessionListMetadata.lastPromptAt`
 *   与创建时刻取新，也就是「最后一条人类消息」，agent 的产出不改它；
 * - **一轮收尾**：宿主亲历的 `api-session/status` 由 running 转 false。服务端没有下发
 *   「最后一条助手消息的时间」这种字段（投影与摘要都只有 `lastPromptAt`），所以这一半取
 *   收尾那一刻；「重连后打底的一条 false」不是亲历的收尾，不算判定条目。
 *
 * 本文件逐条钉住：
 *
 * - ① 纯函数：按判定时间从新到旧、不改动入参数组、并列按创建时刻、没有时间证据的排最后；
 * - ② `session/list` 的用户消息时间一到手，目录就按它排（不是发现顺序）；
 * - ③ 一轮收尾把那一行提到最前；**开轮**（running 转 true）不改顺序；
 * - ④ 进子代理再退出来（父域被回收、目录靠重放重建）先后不变——「在跑」不是排序依据，
 *   用户消息最旧的那一行不会被提到前面；
 * - ⑤ 没收尾证据的 `false`（没亲历过 true）不触发重排；
 * - ⑥ 列表 false 穿插不抹掉 status true，重复 false 不续写，收尾后进出顺序一致；
 * - ⑦ 新账本清理覆盖权威消失 / 普通化 / 删除 / 归档 / 连接收线；
 * - ⑧ 列表 true 不制造亲历开轮，连接切代挡住旧在途列表。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、无 token）。
 */
import assert from "node:assert";
import { orderSubagentEntries } from "../src/dsh/subagentOrder";
import type { SubagentView } from "../src/shared/chat";

process.on("unhandledRejection", (error) => {
  console.error("[subagentOrder] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");

const ID_M = "session-main";
const ID_A = "child-aaaa";
const ID_B = "child-bbbb";
const ID_C = "child-cccc";
/** 会话行的工作目录（中性虚构名，别写本机路径）。 */
const CWD = "C:/work/demo";

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/** 目录行（只列本场景断言用到的字段）。 */
interface Entry {
  id: string;
  label: string;
  activity?: "running" | "inactive";
}

/** `session/list` 的原始行（只列本场景用到的字段）。 */
interface SummaryRow {
  sessionId: string;
  updatedAt: number;
  cwd?: string;
  origin?: string;
  parentSessionId?: string;
  running?: boolean;
}

const parentRow = (): SummaryRow => ({ sessionId: ID_M, updatedAt: 1, cwd: CWD });
/** 子代理行：`updatedAt` 就是服务端的「最后一条人类消息」。 */
const childRow = (id: string, updatedAt: number): SummaryRow => ({
  sessionId: id,
  updatedAt,
  cwd: CWD,
  origin: "subagent",
  parentSessionId: ID_M,
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 静默假客户端：只实现本场景碰到的面；`subagents/list` 按新版口径不存在（HTTP 404）。 */
const fakeClient = (state: { items: SummaryRow[] }) => ({
  async listSessions() {
    return { items: state.items };
  },
  async archiveSession() {},
  async request(method: string) {
    if (method === "commands/list") return [];
    if (method === "subagents/list") throw new Error("subagents/list 失败：HTTP 404");
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
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

/** 一台被驱动起来的控制器 + 它发出的帧。 */
function makeDriver(state: { items: SummaryRow[] }) {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  controller.subscribe((target, frame) =>
    frames.push({ target, frame: frame as unknown as Record<string, unknown> }),
  );
  const internals = controller as never as {
    client: unknown;
    connection: string;
    scopes: Map<string, { adapter?: { applyEvent(event: unknown): void } }>;
    onEventFrame(frame: Record<string, unknown>): Promise<void>;
    openSubagent(viewId: string, id: string): Promise<void>;
    subagentActivityAt: Map<string, number>;
    subagentSettlementsPending: Set<string>;
    subagentOrderPruneCandidates: Set<Set<string>>;
    refreshSubagentTitles(): Promise<void>;
    teardownStreams(): void;
    archiveSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    onWorkspaceFrame(frame: unknown): void;
    sessions: { id: string; running: boolean }[];
    findSessionDir(sessionId: string): undefined;
  };
  internals.client = fakeClient(state) as never;
  internals.connection = "connected";
  let seq = 100;
  return {
    frames,
    internals,
    open: (viewId: string, sessionId: string, subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" }) =>
      controller.openSession(viewId, sessionId, subagent),
    /** 点目录里的一行：真实的「进子代理」入口（会话级切换）。 */
    enter: (viewId: string, id: string) => internals.openSubagent(viewId, id),
    refresh: () => controller.refreshSessions(),
    /** 首帧快照（`state` 帧的取值来源）：目录顺序也要与 `subagents/list` 帧同一个。 */
    snapshot: (viewId: string) =>
      controller.snapshotFor(viewId) as unknown as {
        subagentEntries?: Entry[];
        subagent?: { parentEntries?: Entry[] };
      },
    /**
     * 父会话日志里的 `subagent/catalog` durable 事件（`refreshSessions` 之外的第二条目录
     * 来路，重放时走的就是它）。
     */
    catalog: (parentId: string, childId: string) => {
      seq += 1;
      internals.scopes.get(parentId)?.adapter?.applyEvent({
        type: "subagent/catalog",
        seq,
        time: seq * 1000,
        data: { version: 0, childId, childCreatedAt: seq * 1000, mode: "one-shot" },
      });
    },
    /** `api-session/status` 中继（`args = [sessionId, running]`）。 */
    status: (sessionId: string, running: boolean) =>
      internals.onEventFrame({ type: "emit", event: "api-session/status", args: [sessionId, running] }),
  };
}

/** 最近一条发给 viewId 的目录列表帧的 id 序列。 */
function lastIds(frames: Captured[], viewId: string): string[] | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== viewId || frame.type !== "subagents/list") continue;
    return (frame.entries as Entry[]).map((entry) => entry.id);
  }
  return undefined;
}

/** 最近一帧里**子代理页**手上那份父目录（`ChatState.subagent.parentEntries`）。 */
function lastParentIds(frames: Captured[], viewId: string): string[] | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== viewId) continue;
    const source = (frame.type === "patch" ? frame.patch : frame.type === "state" ? frame.state : undefined) as
      | { subagent?: { parentEntries?: Entry[] } }
      | undefined;
    const parentEntries = source?.subagent?.parentEntries;
    if (parentEntries) return parentEntries.map((entry) => entry.id);
  }
  return undefined;
}

const view = (id: string, createdAt?: number): SubagentView => ({
  id,
  label: id,
  mode: "one-shot",
  ...(createdAt === undefined ? {} : { createdAt }),
});
const idsOf = (entries: readonly SubagentView[]) => entries.map((entry) => entry.id);

console.log("subagentOrder: 判定时间排序（纯函数 + 真控制器）");

// ---------- ① 纯函数 ----------
{
  const at = new Map([
    [ID_A, 100],
    [ID_B, 300],
    [ID_C, 200],
  ]);
  const input = [view(ID_A), view(ID_B), view(ID_C)];
  assert.deepStrictEqual(
    idsOf(orderSubagentEntries(input, at)),
    [ID_B, ID_C, ID_A],
    "按判定时间从新到旧（用户消息与 agent 收尾两类同等对待，不设优先级）",
  );
  assert.deepStrictEqual(
    idsOf(input),
    [ID_A, ID_B, ID_C],
    "纯函数：不改动入参数组（调用方手里那份目录还要给别的读取用）",
  );
  assert.deepStrictEqual(
    idsOf(orderSubagentEntries(input, new Map())),
    [ID_A, ID_B, ID_C],
    "并列（含都没有时间证据）时保持发现顺序——什么都不猜",
  );
  assert.deepStrictEqual(
    idsOf(
      orderSubagentEntries(
        [view(ID_A, 10), view(ID_B, 30), view(ID_C, 20)],
        new Map([
          [ID_A, 500],
          [ID_B, 500],
          [ID_C, 500],
        ]),
      ),
    ),
    [ID_B, ID_C, ID_A],
    "判定时间并列时按创建时刻排（更晚建的在前）——先后因此不取决于数组是怎么攒起来的",
  );
  assert.deepStrictEqual(
    idsOf(orderSubagentEntries([view(ID_A), view(ID_C)], new Map([[ID_C, 5]]))),
    [ID_C, ID_A],
    "没有时间证据的行排在最后",
  );
  console.log("  ① 纯函数：从新到旧、并列按创建时刻、不改入参 ✓");
}

// ---------- ② 用户消息时间定序 ----------
{
  const state = { items: [parentRow(), childRow(ID_A, 100), childRow(ID_B, 300), childRow(ID_C, 200)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  // 目录按**发现顺序** A → B → C 进册（durable 事件那一路），排序不能是它
  d.catalog(ID_M, ID_A);
  d.catalog(ID_M, ID_B);
  d.catalog(ID_M, ID_C);

  assert.deepStrictEqual(
    lastIds(d.frames, "v1"),
    [ID_B, ID_C, ID_A],
    "目录按 session/list 的用户消息时间排（不是发现顺序）",
  );
  console.log("  ② 用户消息最新的在前 ✓");
}

// ---------- ③ 一轮收尾把那一行提到最前；开轮不算 ----------
{
  const state = { items: [parentRow(), childRow(ID_A, 100), childRow(ID_B, 300), childRow(ID_C, 200)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  d.catalog(ID_M, ID_B);
  d.catalog(ID_M, ID_C);
  assert.deepStrictEqual(lastIds(d.frames, "v1"), [ID_B, ID_C, ID_A], "前置：初始顺序按用户消息时间");

  await d.status(ID_A, true);
  assert.deepStrictEqual(
    lastIds(d.frames, "v1"),
    [ID_B, ID_C, ID_A],
    "开轮（running 转 true）不是判定条目：顺序不动（生成中不许反复刷新）",
  );

  await d.status(ID_A, false);
  assert.deepStrictEqual(
    lastIds(d.frames, "v1"),
    [ID_A, ID_B, ID_C],
    "一轮收尾是判定条目：那一行按收尾时刻提到最前",
  );
  console.log("  ③ 收尾提最前、开轮不动 ✓");
}

// ---------- ④ 进子代理再退出来：先后不变，「在跑」不是排序依据 ----------
{
  const state = { items: [parentRow(), childRow(ID_A, 100), childRow(ID_B, 300), childRow(ID_C, 200)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  d.catalog(ID_M, ID_B);
  d.catalog(ID_M, ID_C);
  // A 的用户消息最旧、而它正在跑：排序只看判定时间，不看驻留状态
  await d.status(ID_A, true);
  assert.deepStrictEqual(lastIds(d.frames, "v1"), [ID_B, ID_C, ID_A], "前置：在跑的那一行仍在最后");

  await d.enter("v1", ID_B);
  assert.deepStrictEqual(
    lastParentIds(d.frames, "v1"),
    [ID_B, ID_C, ID_A],
    "子代理页的父目录快照与父页面同一个顺序",
  );

  // 退回主会话：视图离开时子代理域被回收，主会话域的目录靠 durable 事件重放重建
  await d.open("v1", ID_M);
  d.catalog(ID_M, ID_A);
  d.catalog(ID_M, ID_B);
  d.catalog(ID_M, ID_C);
  assert.deepStrictEqual(
    lastIds(d.frames, "v1"),
    [ID_B, ID_C, ID_A],
    "进子代理再退出来先后不变——「在跑」不许把用户消息最旧的那一行提到前面",
  );
  // 三个生产者必须给同一个先后：`subagents/list` 帧、会话状态片段的 `subagentEntries`
  // （退回主会话时发的是它）、子代理页的父目录快照。少一处排序，后到的那一帧就会把
  // 界面上的先后改回去
  assert.deepStrictEqual(
    d.snapshot("v1").subagentEntries?.map((entry) => entry.id),
    [ID_B, ID_C, ID_A],
    "会话状态片段里的目录顺序与 subagents/list 帧一致",
  );
  console.log("  ④ 进出子代理：顺序只由判定时间决定（三个生产者一致）✓");
}

// ---------- ⑤ 没收尾证据的 false 不算判定条目 ----------
{
  const state = { items: [parentRow(), childRow(ID_A, 100), childRow(ID_B, 300), childRow(ID_C, 200)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  d.catalog(ID_M, ID_B);
  d.catalog(ID_M, ID_C);

  // 没亲历过 true（重连后打底的那条 false / 迟到的同名 false）：不是一次收尾
  await d.status(ID_A, false);
  assert.deepStrictEqual(
    lastIds(d.frames, "v1"),
    [ID_B, ID_C, ID_A],
    "没亲历过的 false 不改判定时间（否则重连就会把陈旧的子代理提到最前）",
  );
  await tick(1000);
  assert.deepStrictEqual(
    lastIds(d.frames, "v1"),
    [ID_B, ID_C, ID_A],
    "收尾后的防抖标题刷新同样不改顺序（它的 session/list 没有新的用户消息）",
  );
  console.log("  ⑤ 非亲历的 false 不重排 ✓");
}

// ---------- ⑥ 列表 false 不抹掉亲历 true；重复 false 不续写时间 ----------
{
  const state = { items: [parentRow(), childRow(ID_A, 100), childRow(ID_B, 300)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  d.catalog(ID_M, ID_B);
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    await d.status(ID_A, true);
    state.items[1].running = false;
    await d.refresh();
    assert.deepStrictEqual(lastIds(d.frames, "v1"), [ID_B, ID_A], "列表 false 不是收尾：过程不重排");
    await d.status(ID_A, false);
    assert.deepStrictEqual(lastIds(d.frames, "v1"), [ID_A, ID_B], "列表 false 不抹掉已亲历 true 的收尾证据");
    now = 2000;
    await d.status(ID_B, true);
    await d.status(ID_B, false);
    now = 3000;
    await d.status(ID_A, false);
    assert.deepStrictEqual(lastIds(d.frames, "v1"), [ID_B, ID_A], "同名迟到 false 不能重复刷新排序");
    await d.enter("v1", ID_A);
    assert.deepStrictEqual(lastParentIds(d.frames, "v1"), [ID_B, ID_A], "收尾后进入子代理仍保留顺序");
    await d.open("v1", ID_M);
    d.catalog(ID_M, ID_A);
    d.catalog(ID_M, ID_B);
    assert.deepStrictEqual(lastIds(d.frames, "v1"), [ID_B, ID_A], "父域回收重建不丢亲历收尾排序");
    assert.deepStrictEqual(d.snapshot("v1").subagentEntries?.map((entry) => entry.id), [ID_B, ID_A], "三生产者排序一致");
  } finally {
    Date.now = originalNow;
  }
  console.log("  ⑥ 列表穿插、重复 false 与收尾后进出一致 ✓");
}

// ---------- ⑦ 新账本生命周期：权威消失 / 普通化 / 删除 / 归档 / 连接收线 ----------
for (const cleanup of ["absent", "ordinary", "delete", "archive", "workspaceArchive", "workspaceReplace", "teardown"] as const) {
  const state = { items: [parentRow(), childRow(ID_A, 100)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  await d.status(ID_A, true);
  await d.status(ID_A, false);
  await d.status(ID_A, true);
  assert.ok(d.internals.subagentActivityAt.has(ID_A), `${cleanup}: 前置有排序时间`);
  assert.ok(d.internals.subagentSettlementsPending.has(ID_A), `${cleanup}: 前置有待收尾证据`);
  if (cleanup === "absent" || cleanup === "ordinary") {
    state.items = cleanup === "absent" ? [parentRow()] : [parentRow(), { sessionId: ID_A, updatedAt: 100 }];
    await d.refresh();
  } else if (cleanup === "delete") {
    // 离线删除路径：仅注入缺目录与可删列表，不读取 / 删除本机会话日志。
    d.internals.findSessionDir = () => undefined;
    d.internals.sessions.push({ id: ID_A, running: false });
    await d.internals.deleteSession(ID_A);
  } else if (cleanup === "archive") {
    await d.internals.archiveSession(ID_A);
  } else if (cleanup === "workspaceArchive") {
    d.internals.onWorkspaceFrame({ type: "archived", archivedSessionIds: [ID_A] });
  } else if (cleanup === "workspaceReplace") {
    // `replace` 在**增量位**上带完整值（官方 `acceptIncrement` 的 `case 'replace'` → `replaceBaseline`）：
    // 归档集合整份替换，与 `archived` 增量同一条清理路径，不许漏。
    d.internals.onWorkspaceFrame({ type: "replace", value: { items: [], archivedSessionIds: [ID_A] } });
  } else {
    d.internals.teardownStreams();
  }
  assert.ok(!d.internals.subagentActivityAt.has(ID_A), `${cleanup}: 清理排序时间`);
  assert.ok(!d.internals.subagentSettlementsPending.has(ID_A), `${cleanup}: 清理待收尾证据`);
  await d.status(ID_A, false);
  assert.ok(!d.internals.subagentActivityAt.has(ID_A), `${cleanup}: 迟到 false 不复活收尾时间`);
  if (cleanup === "delete" || cleanup === "archive" || cleanup === "workspaceArchive" || cleanup === "workspaceReplace") {
    await d.refresh();
    await d.status(ID_A, true);
    await d.status(ID_A, false);
    assert.ok(!d.internals.subagentActivityAt.has(ID_A), `${cleanup}: 服务端残留行 / status 不复活排序账本`);
    assert.ok(!d.internals.subagentSettlementsPending.has(ID_A), `${cleanup}: 服务端残留行 / status 不复活待结算账本`);
  }
}
console.log("  ⑦ 新账本七条清理路径与迟到帧 ✓");

// ---------- ⑧ 连接切代挡住旧在途列表；列表 true 不制造亲历开轮 ----------
{
  const state = { items: [parentRow(), { ...childRow(ID_A, 100), running: true }] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  await d.status(ID_A, false);
  assert.strictEqual(d.internals.subagentActivityAt.get(ID_A), 100, "列表 true 不是亲历开轮：初次 status false 不记收尾");
  let release!: (value: { items: SummaryRow[] }) => void;
  d.internals.client = { listSessions: () => new Promise((resolve) => { release = resolve; }) };
  const inflight = d.refresh();
  d.internals.teardownStreams();
  release({ items: state.items });
  await inflight;
  assert.strictEqual(d.internals.subagentActivityAt.size, 0, "连接收线后旧列表响应不能重建排序账本");
  assert.strictEqual(d.internals.subagentSettlementsPending.size, 0, "连接收线后亲历证据保持清空");
}
console.log("  ⑧ 重连打底与在途列表切代 ✓");

// ---------- ⑨ 在途旧列表的缺席不能清掉请求期间新到 / 更新的 status 证据 ----------
for (const route of ["sessions", "titles"] as const) for (const existing of [false, true]) {
  const state = { items: [parentRow(), childRow(ID_B, 300), ...(existing ? [childRow(ID_A, 100)] : [])] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  d.catalog(ID_M, ID_B);
  if (existing) await d.status(ID_A, true);
  let release!: (value: { items: SummaryRow[] }) => void;
  const client = d.internals.client;
  d.internals.client = { listSessions: () => new Promise((resolve) => { release = resolve; }) };
  const inflight = route === "sessions" ? d.refresh() : d.internals.refreshSubagentTitles();
  assert.strictEqual(d.internals.subagentOrderPruneCandidates.size, 1, "在途候选已登记");
  await d.status(ID_A, true);
  release({ items: [parentRow(), childRow(ID_B, 300)] });
  await inflight;
  assert.strictEqual(d.internals.subagentOrderPruneCandidates.size, 0, "响应后回收在途候选");
  assert.ok(d.internals.subagentSettlementsPending.has(ID_A), `${route}/${existing}: 旧快照缺席不清请求期间的 status true`);
  await d.status(ID_A, false);
  assert.deepStrictEqual(lastIds(d.frames, "v1"), [ID_A, ID_B], "亲历收尾仍重排");
  // 下一份没有穿插实时更新的完整列表仍能清理，不能把保护变成永久豁免。
  d.internals.client = client;
  state.items = [parentRow(), childRow(ID_B, 300)];
  await d.refresh();
  assert.ok(!d.internals.subagentActivityAt.has(ID_A), "后续权威缺席清理仍生效");
}
console.log("  ⑨ 在途旧快照不清实时新证据，后续权威清理仍生效 ✓");

console.log("\nsubagentOrder: all assertions passed");
