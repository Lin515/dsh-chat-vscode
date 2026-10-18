/**
 * 子代理显示名：目录行**缺 label 时默认显示会话标题**（离线 harness，驱动真 `ChatController`）。
 *
 * 用户 2026-10-11 报障：**workflow 派发的子代理**在标题右侧的目录里默认显示会话 id
 * （一串 uuid），要点进那个子代理才会变成标题，关掉列表再打开又退回 id。
 *
 * 根因两条：
 *
 * 1. workflow 起子代理时**不传描述符 label**（父目录条目里的 label 来自子代理描述符，
 *    见 `dsh-subagent` 的 `establishCatalogChild` 与 `workflow-ptc` 的 `startChild`），
 *    于是目录的三个来源（投影 / durable 事件 / 旧 RPC）都把 label 兜底成会话 id
 *    （`projections.ts` 的三处读取）。而展示名此前只在这条子代理**被打开过**时解析得出
 *    （`subagentDisplayName` = 描述符 label ?? 适配器里的会话标题）。
 * 2. 本地补过的名字会被下一次「label 等于会话 id」的并入覆盖回去（`upsertSubagent`
 *    逐字段覆盖）——这就是「关掉再打开又变回 ID」。
 *
 * 修法：宿主多一本**标题账本**（`subagentTitles`：`session/list` 行的 `title`
 * 投影，以及正在看那条子代理时它自己的 `patch.session.title`），显示名在**发帧那一刻**
 * 统一由 `resolveSubagentDisplay` 现算（真 label → 打开时的显示名 → 标题账本 → 会话 id），
 * 不写回目录。本文件逐条钉住：
 *
 * - ① `session/list` 的标题投影到手后，label 缺失的目录行显示**会话标题**；
 * - ② 同一条 label-less 来源重放 / 再打开一次菜单，名字**不退回** uuid；
 * - ③ 账本为空时，打开菜单这一次刷新就能把标题补到屏上；
 * - ④ 点进去过一次（子代理自己的标题落到宿主）之后，返回父会话、子域被回收，名字
 *   **仍然**是标题——粘性不靠「打开着的域」；子代理页那份父目录快照（面包屑的数据）
 *   同样如此；
 * - ⑤ 来源带了真 label 的行**不被**会话标题顶掉（优先级）；
 * - ⑥ 子代理收尾会防抖补一次账本：不点开菜单也能拿到名字。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、无 token）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[subagentTitle] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");

const ID_M = "session-main";
const ID_A = "child-aaaa";
const ID_B = "child-bbbb";
const TITLE_A = "审计并重构构建脚本";
const TITLE_B = "另一条子代理的标题";
const LABEL_B = "派发时就说好的名字";
/** 与 `controller.ts` 的 `SUBAGENT_TITLES_DEBOUNCE_MS` 同口径（收尾后补账本的防抖）。 */
const TITLES_DEBOUNCE_MS = 800;

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/** 目录行（只列本场景断言用到的字段）。 */
interface Entry {
  id: string;
  label: string;
  mode: string;
  activity?: "running" | "inactive";
  unread?: boolean;
}

/** `session/list` 的原始行（只列本场景用到的字段）。 */
interface SummaryRow {
  sessionId: string;
  updatedAt: number;
  cwd?: string;
  origin?: string;
  parentSessionId?: string;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}

/** 会话行的工作目录（中性虚构名，别写本机路径）。 */
const CWD = "C:/work/demo";

const parentRow = (): SummaryRow => ({ sessionId: ID_M, updatedAt: 1, cwd: CWD });
/** 子代理行：标题就挂在 `projections.values.title`（官方 `SessionProjectionHints` 契约）。 */
const childRow = (id: string, title: string): SummaryRow => ({
  sessionId: id,
  updatedAt: 2,
  cwd: CWD,
  origin: "subagent",
  parentSessionId: ID_M,
  projections: { asOfSeq: 7, values: { title } },
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 静默假客户端：只实现本场景碰到的面；`subagents/list` 按新版口径不存在（HTTP 404）。 */
const fakeClient = (state: { items: SummaryRow[] }) => ({
  async listSessions() {
    return { items: state.items };
  },
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
    registerSubagent(scope: unknown, entry: unknown): void;
    applySubagentCatalogProjection(scope: unknown, value: unknown, present: boolean): void;
    refreshSubagents(viewId: string): Promise<void>;
    deliver(sessionId: string, frame: unknown): void;
  };
  internals.client = fakeClient(state) as never;
  internals.connection = "connected";
  let seq = 100;
  return {
    frames,
    open: (viewId: string, sessionId: string, subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" }) =>
      controller.openSession(viewId, sessionId, subagent),
    refresh: () => controller.refreshSessions(),
    /** 标题右侧那枚目录触发器被点开（`listSubagents`）。 */
    menu: (viewId: string) => internals.refreshSubagents(viewId),
    /** 目录行进册（旧 RPC 那一路的落点；本文件用来自造带真 label 的行）。 */
    register: (parentId: string, entry: Entry) =>
      internals.registerSubagent(internals.scopes.get(parentId), entry),
    /**
     * 父会话日志里的 `subagent/catalog` durable 事件，**刻意不带 label**——workflow 派发的
     * 子代理就是这个形状（适配器读出来 label 等于会话 id，与投影/RPC 三路一致）。
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
    projection: (parentId: string, entries: unknown[]) =>
      internals.applySubagentCatalogProjection(internals.scopes.get(parentId), entries, true),
    /** 正在看的子代理自己的标题落到宿主（真实来路：适配器的 `session/title` → `patch.session`）。 */
    childTitle: (sessionId: string, title: string) =>
      internals.deliver(sessionId, {
        type: "patch",
        patch: { session: { id: sessionId, title, updatedAt: Date.now(), running: false } },
      }),
    /** `api-session/status` 中继（`args = [sessionId, running]`）。 */
    status: (sessionId: string, running: boolean) =>
      internals.onEventFrame({ type: "emit", event: "api-session/status", args: [sessionId, running] }),
  };
}

/** 最近一条发给 viewId 的目录列表帧。 */
function lastEntries(frames: Captured[], viewId: string): Entry[] | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== viewId || frame.type !== "subagents/list") continue;
    return frame.entries as Entry[];
  }
  return undefined;
}

/** 最近一条发给 viewId 的目录列表帧里那一行。 */
function lastRow(frames: Captured[], viewId: string, id: string): Entry | undefined {
  return lastEntries(frames, viewId)?.find((entry) => entry.id === id);
}

/** 最近一帧里**子代理页**手上那份父目录（`ChatState.subagent.parentEntries`，面包屑的数据）。 */
function lastParentEntries(frames: Captured[], viewId: string): Entry[] | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== viewId) continue;
    const source = (frame.type === "patch" ? frame.patch : frame.type === "state" ? frame.state : undefined) as
      | { subagent?: { parentEntries?: Entry[] } }
      | undefined;
    const parentEntries = source?.subagent?.parentEntries;
    if (parentEntries) return parentEntries;
  }
  return undefined;
}

console.log("subagentTitle: 驱动真控制器（offline stub）");

// ---------- ① 冷行补齐：目录里没有 label，但会话标题已经在 session/list 里 ----------
{
  const state = { items: [parentRow(), childRow(ID_A, TITLE_A)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);

  const row = lastRow(d.frames, "v1", ID_A);
  assert.ok(row, "目录进册后应当有这一行（前置：注册本身没问题）");
  assert.strictEqual(
    row.label,
    TITLE_A,
    `缺 label 的目录行要显示会话标题（${TITLE_A}），实际 ${row.label}` +
      "（workflow 派发的子代理没有描述符 label，uuid 用户认不出来）",
  );
  console.log(`  ① 目录缺 label → 显示会话标题「${row.label}」✓`);
}

// ---------- ② 不复退：同一条 label-less 来源重放 + 再打开一次菜单 ----------
{
  const state = { items: [parentRow(), childRow(ID_A, TITLE_A)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  // 投影那一路重放（每条目录条的 label 都会被兜底成会话 id）——改动前这一步会把本地
  // 补好的名字盖回去，用户看到的就是「关掉再打开又变回 ID」
  d.projection(ID_M, [{ id: ID_A, label: ID_A, mode: "one-shot" }]);
  d.catalog(ID_M, ID_A);
  await d.menu("v1");
  await tick(50);

  const row = lastRow(d.frames, "v1", ID_A);
  assert.strictEqual(
    row?.label,
    TITLE_A,
    `目录来源重放、菜单重开后名字不许退回 uuid，实际 ${String(row?.label)}`,
  );
  console.log("  ② 目录重放 + 菜单重开：名字仍是会话标题 ✓");
}

// ---------- ③ 账本为空时，打开菜单这一次刷新就补上名字 ----------
{
  const state = { items: [parentRow()] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  assert.strictEqual(
    lastRow(d.frames, "v1", ID_A)?.label,
    ID_A,
    "前置：标题还没到手时只拿得到会话 id（这一条保证后面的断言不是「本来就有名字」）",
  );

  state.items = [parentRow(), childRow(ID_A, TITLE_A)];
  await d.menu("v1");
  await tick(50);

  assert.strictEqual(
    lastRow(d.frames, "v1", ID_A)?.label,
    TITLE_A,
    "菜单打开那一次刷新要把标题补到屏上（不 await，随后的帧补上）",
  );
  console.log("  ③ 菜单打开：标题补到屏上 ✓");
}

// ---------- ④ 粘性：进去过一次，返回父会话（子域被回收）之后仍是标题 ----------
{
  const state = { items: [parentRow()] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  d.catalog(ID_M, ID_A);
  await d.open("v1", ID_A, { parentSessionId: ID_M, mode: "one-shot" });
  d.childTitle(ID_A, TITLE_A);

  const crumb = lastParentEntries(d.frames, "v1")?.find((entry) => entry.id === ID_A);
  assert.strictEqual(
    crumb?.label,
    TITLE_A,
    `面包屑那一份父目录快照同样要解析显示名，实际 ${String(crumb?.label)}`,
  );
  console.log("  ④a 子代理页的父目录快照：显示名同源 ✓");

  // 回主会话：子代理域随视图离开被回收，父目录靠 follow 流重放重建（这里手动重放那条
  // label-less 的 durable 事件，等价于真实重放）
  await d.open("v1", ID_M);
  d.catalog(ID_M, ID_A);
  assert.strictEqual(
    lastRow(d.frames, "v1", ID_A)?.label,
    TITLE_A,
    "子域被回收后名字仍要是标题——粘性靠宿主账本，不靠打开着的域",
  );
  console.log("  ④b 返回父会话、子域回收：名字不退回 uuid ✓");
}

// ---------- ⑤ 优先级：来源带了真 label 的行不被会话标题顶掉 ----------
{
  const state = { items: [parentRow(), childRow(ID_B, TITLE_B)] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.register(ID_M, { id: ID_B, label: LABEL_B, mode: "one-shot", activity: "inactive" });

  assert.strictEqual(
    lastRow(d.frames, "v1", ID_B)?.label,
    LABEL_B,
    "真 label 优先于会话标题（已带名字的目录行显示名不许变）",
  );
  console.log(`  ⑤ 真 label 优先：仍是「${LABEL_B}」✓`);
}

// ---------- ⑥ 子代理收尾：防抖补一次账本（没点开菜单也能拿到名字） ----------
{
  const state = { items: [parentRow()] };
  const d = makeDriver(state);
  await d.open("v1", ID_M);
  await d.refresh();
  d.catalog(ID_M, ID_A);
  assert.strictEqual(lastRow(d.frames, "v1", ID_A)?.label, ID_A, "前置：收尾之前还没有名字");

  state.items = [parentRow(), childRow(ID_A, TITLE_A)];
  await d.status(ID_A, false);
  await tick(TITLES_DEBOUNCE_MS + 300);

  assert.strictEqual(
    lastRow(d.frames, "v1", ID_A)?.label,
    TITLE_A,
    "子代理收尾后要防抖补一次标题账本（标题由它自己的首轮产出，此刻已经落地）",
  );
  console.log("  ⑥ 子代理收尾：防抖补齐 ✓");
}

console.log("subagentTitle: 缺 label 的目录行默认显示会话标题，且不退回 uuid ✓");
