/**
 * 子代理目录行的**显示状态**（离线 harness，驱动真 `ChatController`）。
 *
 * 用户 2026-10-10 报障的两个症状：
 *
 * - **A**：子代理正在生成时点进它的会话、再回主会话，那一行明明还在跑却显示「可继续」；
 * - **B**：一次性子代理**完全没有状态点**，副文字恒为「一次性」——分不出「生成中」与
 *   「已完成」，用户也没法从列表看出「这条结果是新的、我还没看过」。
 *
 * A 的根因是**两条路径的到达顺序**：驻留状态（`api-session/status` 中继 →
 * `syncSubagentActivity` → `withSubagentActivity`）先到，而目录行（`subagent/catalog`
 * durable 事件 → `registerSubagent` → `mergeSubagentEntries`）后到——那一刻目录里还没有
 * 这一行，`withSubagentActivity` 找不到 id 就原样返回（`changed: false`，连帧都不发），
 * 状态**永久丢失**；随后注册进来的行不带 activity，于是恒显示「可继续」。
 *
 * 同一症状还有第二条来路（场景 ⑦）：驻留状态唯一还留在手上的地方是**子代理域**
 * （`scope.running`——发送即乐观置位、durable 轮次边界都写在它上面），域随视图离开被
 * 回收时若不把这一份值记进宿主账本，下次父会话重建目录又只剩「不知道」。
 *
 * B 的根因是界面在 `activity === undefined` 时**连点都不画**，而「已完成 / 可继续 /
 * 一次性」三档又只按 activity 分——没有「用户已读」这一维，跑完与看过就分不开。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { subagentRowFace } from "../src/webview/subagentRow";
import { dictionaryFor } from "../src/webview/texts";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");

process.on("unhandledRejection", (error) => {
  console.error("[subagentRowState] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");

const ID_M = "session-main";
const ID_A = "child-oneshot";
const LABEL_A = "答复一个 token";

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

/** 静默假客户端：只实现本场景碰到的面；`subagents/list` 按新版口径不存在（HTTP 404）。 */
const fakeClient = () => ({
  async listSessions() {
    return { items: [] };
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
  async prompt() {
    return { requestId: "r" };
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

interface Scope {
  adapter?: { applyEvent(event: unknown): void };
  running: boolean;
}

/** 一台被驱动起来的控制器 + 它发出的帧。 */
function makeDriver() {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame: frame as unknown as Record<string, unknown> }));
  const internals = controller as never as {
    client: unknown;
    connection: string;
    scopes: Map<string, Scope>;
    onEventFrame(frame: Record<string, unknown>): Promise<void>;
    registerSubagent(scope: unknown, entry: unknown): void;
  };
  internals.client = fakeClient() as never;
  internals.connection = "connected";
  const c = controller as unknown as {
    openSession(
      viewId: string,
      sessionId: string,
      subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" },
      seed?: unknown,
    ): Promise<void>;
  };
  let seq = 100;
  return {
    frames,
    open: (viewId: string, sessionId: string, subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" }) =>
      c.openSession(viewId, sessionId, subagent),
    /** `api-session/status` 中继（`args = [sessionId, running]`）。 */
    status: (sessionId: string, running: boolean) =>
      internals.onEventFrame({ type: "emit", event: "api-session/status", args: [sessionId, running] }),
    /** 父会话日志里的 `subagent/catalog` durable 事件（建立即写，直播与重放都会到）。 */
    catalog: (parentSessionId: string, childId: string, mode: "one-shot" | "continuable", label: string) => {
      seq += 1;
      internals.scopes.get(parentSessionId)?.adapter?.applyEvent({
        type: "subagent/catalog",
        seq,
        time: seq * 1000,
        data: { version: 0, childId, childCreatedAt: seq * 1000, mode, label },
      });
    },
    /** 目录行进册：`subagents/list` 的 RPC 那一路自带权威活动位，落点就是这里。 */
    register: (parentSessionId: string, entry: Entry) =>
      internals.registerSubagent(internals.scopes.get(parentSessionId), entry),
    scopeRunning: (sessionId: string) => internals.scopes.get(sessionId)?.running,
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

/**
 * 最近一帧里**子代理页**手上那份父目录（切换下拉的数据，`ChatState.subagent.parentEntries`）。
 *
 * 与上面的 `subagents/list` 是两条不同的帧：普通会话读列表帧，子代理页读这份上下文
 * （`sessionPatch` 的 `subagent` 那一键）——报障流程「点进去看一眼」正是在这条路上。
 */
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

console.log("subagentRowState: 驱动真控制器（offline stub）");

// ---------- ① 顺序：状态先到、目录后到 → 状态不许丢 ----------
//
// 主假设的现场：`api-session/status` 比 `subagent/catalog` 先到。改动前
// `withSubagentActivity` 找不到 id 就静默返回，注册进来的行恒无 activity。
{
  const d = makeDriver();
  await d.open("v1", ID_M);
  await d.status(ID_A, true); // 状态先到：目录里此刻还没有这一行
  d.catalog(ID_M, ID_A, "one-shot", LABEL_A); // 目录后到（注册）

  const row = lastRow(d.frames, "v1", ID_A);
  assert.ok(row, "注册后目录里应当有这一行（前置：注册本身没问题）");
  assert.strictEqual(
    row.activity,
    "running",
    `状态先到、目录后到时那一行必须仍是「生成中」，实际 activity=${String(row.activity)}` +
      "（注册路径要用宿主的状态账本回填，否则那次状态更新永久丢失）",
  );
  console.log("  ① 状态先到、目录后到：行上仍是「生成中」✓");
}

// ---------- ② 反顺序：目录先到、状态后到（原本就对的那条路，不许改坏） ----------
{
  const d = makeDriver();
  await d.open("v1", ID_M);
  d.catalog(ID_M, ID_A, "one-shot", LABEL_A);
  await d.status(ID_A, true);
  assert.strictEqual(lastRow(d.frames, "v1", ID_A)?.activity, "running", "目录先到、状态后到要就地改成 running");
  await d.status(ID_A, false);
  assert.strictEqual(lastRow(d.frames, "v1", ID_A)?.activity, "inactive", "收尾要就地改成 inactive");
  console.log("  ② 目录先到、状态后到：就地更新 ✓");
}

// ---------- ③ 报障现场：点进子代理看它跑、再回主会话，那一行仍要在跑 ----------
//
// 视图切到子代理时父域的目录整个被回收（`dropViewers` → `destroyScope`），回到主会话
// 时父域**新建**、目录靠 follow 流重放 `subagent/catalog` 重建——这一次重建必须带上
// 驻留状态，否则就是用户报的「明明还在生成却显示可继续」。
{
  const d = makeDriver();
  await d.open("v1", ID_M);
  d.catalog(ID_M, ID_A, "one-shot", LABEL_A);
  await d.status(ID_A, true);
  assert.strictEqual(lastRow(d.frames, "v1", ID_A)?.activity, "running", "前置：主会话里它已经显示生成中");

  await d.open("v1", ID_A, { parentSessionId: ID_M, mode: "one-shot" }); // 点进它的会话
  assert.strictEqual(d.scopeRunning(ID_A), true, "前置：进子代理页时域要以 running 打底（否则输入框会给成排队发送）");
  // 子代理页自己那条下拉（父目录快照）同样要报「生成中」——用户就是在这一页看着它跑的
  assert.strictEqual(
    lastParentEntries(d.frames, "v1")?.find((entry) => entry.id === ID_A)?.activity,
    "running",
    "站在子代理页时，切换下拉里它自己也必须是「生成中」（两条帧不能各说一套）",
  );
  await d.open("v1", ID_M); // 回到主会话：父域重建，目录靠 durable 事件重放
  d.catalog(ID_M, ID_A, "one-shot", LABEL_A); // follow 流重放那条 subagent/catalog

  assert.strictEqual(
    lastRow(d.frames, "v1", ID_A)?.activity,
    "running",
    "回到主会话后目录重建，那一行必须仍是「生成中」（报障现场：显示成了「可继续」）",
  );
  console.log("  ③ 进子代理再回主会话：目录重建后仍是「生成中」✓");
}

// ---------- ④ 「用户已读」维度：离开时它在跑 → 收尾记未读 → 看过了就清 ----------
//
// 用**既有**的未读账本（`unreadSessionIds`：离开正在生成的会话才记、打开即清），
// 不新造一套并行的已读状态。目录行要把这一位带给界面，而且它变化时要重发那一帧——
// 界面上「已完成 ↔ 可继续/一次性」的切换全靠它。
{
  const d = makeDriver();
  await d.open("v1", ID_M);
  d.catalog(ID_M, ID_A, "one-shot", LABEL_A);
  await d.status(ID_A, true);

  await d.open("v1", ID_A, { parentSessionId: ID_M, mode: "one-shot" }); // 看它跑
  await d.open("v1", ID_M); // 它还在跑时离开（记离开标记）
  d.catalog(ID_M, ID_A, "one-shot", LABEL_A); // 父域重建后目录重放
  assert.strictEqual(lastRow(d.frames, "v1", ID_A)?.unread, false, "还没收尾：不算未读");

  await d.status(ID_A, false); // 用户不在看它，它收尾了
  const finished = lastRow(d.frames, "v1", ID_A);
  assert.strictEqual(finished?.activity, "inactive", "收尾后 activity 要变成 inactive");
  assert.strictEqual(
    finished?.unread,
    true,
    "收尾时用户不在看它 → 未读（界面据此显示「已完成」而不是「可继续 / 一次性」）",
  );

  await d.open("v1", ID_A, { parentSessionId: ID_M, mode: "one-shot" }); // 用户点进去看了
  const seen = lastRow(d.frames, "v1", ID_A);
  assert.strictEqual(
    seen?.unread,
    false,
    "看过了就是已读：未读位清掉后要重发目录帧（界面据此切到「可继续 / 一次性 + 灰点」）",
  );
  console.log("  ④ 未读：离开时在跑 → 已完成；看过了 → 已读 ✓");
}

// ---------- ⑤ 界面口径：三个维度 → 副文字 + 状态点色调 ----------
//
// 用户 2026-10-10 给的状态表（见 `src/webview/subagentRow.ts` 的文件头）。文案**取自词典**
// 而不是断言里另抄一份，所以「值」只由 `messages.ts` 说了算；这里钉的是**哪一档取哪一条**。
{
  const zh = dictionaryFor("zh");
  const en = dictionaryFor("en");
  /** 一条目录行（只给本段用到的字段）。 */
  const row = (patch: Record<string, unknown>): never =>
    ({ id: "child", label: "子代理", mode: "one-shot", ...patch }) as never;

  // 运行中：两种模式读同一档（「生成中」+ 运行色点）——一次性子代理从前连点都没有
  for (const mode of ["one-shot", "continuable"]) {
    assert.deepStrictEqual(
      subagentRowFace(row({ mode, activity: "running", unread: true })),
      { key: "subagentRunning", tone: "dot-running" },
      `${mode} 在跑时是「生成中 + 运行色点」（已读与否都不影响它正在跑这件事）`,
    );
  }

  // 已完成：收尾了但用户还没看过结果 → 两种模式都读「已完成」
  for (const mode of ["one-shot", "continuable"]) {
    assert.deepStrictEqual(
      subagentRowFace(row({ mode, activity: "inactive", unread: true })),
      { key: "subagentCompleted", tone: "dot-ok" },
      `${mode} 收尾且未读时是「已完成 + 完成色点」`,
    );
  }

  // 已读：普通子代理读「可继续」（完成色点），一次性读「一次性」（**灰点**）
  assert.deepStrictEqual(
    subagentRowFace(row({ mode: "continuable", activity: "inactive", unread: false })),
    { key: "subagentContinuable", tone: "dot-ok" },
    "普通子代理已读后是「可继续」",
  );
  assert.deepStrictEqual(
    subagentRowFace(row({ mode: "one-shot", activity: "inactive", unread: false })),
    { key: "subagentOneShot", tone: "dot-muted" },
    "一次性子代理已完成已读后是「一次性 + 灰点」（用户明确的口径）",
  );

  // 状态缺失（不知道在不在跑）：与官方同口径按静止渲染，且**不另造一档**——
  // 灰点只表示「已读的一次性」，两件事混在一起界面上就分不开了
  assert.strictEqual(
    subagentRowFace(row({ mode: "one-shot", unread: false })).tone,
    "dot-muted",
    "状态未知 + 一次性 + 已读：按静止那一档渲染",
  );
  assert.strictEqual(
    subagentRowFace(row({ mode: "continuable" })).key,
    "subagentContinuable",
    "状态未知 + 普通：静止分支的模式名（不硬编成「已完成」）",
  );

  // 四档文案的中英两套（值由 messages.ts 定，这里顺带钉住它没被改成占位串）
  assert.deepStrictEqual(
    [zh.subagentRunning, zh.subagentCompleted, zh.subagentContinuable, zh.subagentOneShot],
    ["生成中", "已完成", "可继续", "一次性"],
    "子代理目录行的四档中文文案",
  );
  assert.deepStrictEqual(
    [en.subagentRunning, en.subagentCompleted, en.subagentContinuable, en.subagentOneShot],
    ["running", "completed", "continuable", "one-shot"],
    "子代理目录行的四档英文文案",
  );
  console.log("  ⑤ 三态合并（运行 / 已读 / 模式）→ 文案与色调 ✓");
}

// ---------- ⑥ 接线：组件真用这一份判据，且状态点恒画 ----------
//
// 纯函数对了不等于界面接上了（本仓库「测试绿、功能缺」的经典形态）：这里只钉接线本身。
{
  const app = read("src", "webview", "App.tsx");
  assert.ok(
    /const face = subagentRowFace\(entry\);/.test(app),
    "目录行要按 `subagentRowFace` 算显示状态（不要在组件里再写一套 if）",
  );
  // 状态格必须是**无条件的**一颗点。不能只匹配那段 `<span className={`dot ${face.tone}`} />`
  // ——把它包回 `{entry.activity ? … : null}` 也照样含这段文本，断言就白写了。
  assert.ok(
    /<span className="subagent-row-state">\s*<span className=\{`dot \$\{face\.tone\}`\} \/>\s*<\/span>/.test(app),
    "状态格里要**恒画**一颗点（一次性子代理从前是 `entry.activity ? … : null`，整行没有点）",
  );
  assert.ok(
    !/entry\.activity\s*\?/.test(app),
    "目录行不该再按 `entry.activity` 有没有来决定画不画点（有没有点只由 `subagentRowFace` 决定）",
  );
  assert.ok(
    /<span className="subagent-row-sub">\{texts\[face\.key\]\}<\/span>/.test(app),
    "副文字取词典里那一条（不写死中英字符串，四档都由 face.key 决定）",
  );
  assert.ok(
    !/subagentTone|subagentRowSub/.test(app),
    "旧的「按 activity 二选一 + 状态缺失不画点」两个本地函数应当已经删掉（判据只有 subagentRow 一处）",
  );

  // 样式：灰点存在、且三个色调的**动效纪律**一致（只有运行中呼吸）
  const css = read("src", "webview", "styles", "app.css");
  assert.ok(/\.dot-muted\s*\{/.test(css), "app.css 要有 .dot-muted（一次性已读那一档的灰点）");
  for (const name of ["dot-running", "dot-ok", "dot-muted"]) {
    const body = new RegExp(`\\.${name}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1];
    assert.ok(body !== undefined, `app.css 里找不到 .${name}`);
    assert.strictEqual(
      /animation:/.test(body),
      name === "dot-running",
      `只有运行中的点能带动画，而 .${name} ${/animation:/.test(body) ? "带了" : "没带"}——` +
        "点还在呼吸与「还在跑」必须指的是同一件事",
    );
  }
  console.log("  ⑥ 接线：face 恒画点 + 词典取文案 + 只有运行色点呼吸 ✓");
}

// ---------- ⑦ 状态的来路不止「中继 / 会话列表」：进子代理页看一眼再回来，域上的值也要留住 ----------
//
// ①②③ 覆盖的是「账本里已经有结论」的情形。这一条覆盖另一半：账本**还没有**结论
// （`api-session/status` 中继与 `session/list` 都还没到过），而父目录那一行知道它在跑
// （旧服务端的 `subagents/list` 行自带活动位）；用户进它的会话看了一眼再回主会话——
// 这一刻唯一还知道「它还在跑」的地方是**刚被回收的那个子代理域**（`scope.running`：
// 发送即乐观置位、durable 轮次边界也写在这里，见 `controller.ensureScope` 的 running 打底）。
// 域回收时不把它记进账本，父会话重建目录时就只剩「不知道」，那一行显示成「可继续」
// ——与用户报障的现象一模一样。
{
  const d = makeDriver();
  await d.open("v1", ID_M);
  d.register(ID_M, { id: ID_A, label: LABEL_A, mode: "one-shot", activity: "running" });
  await d.open("v1", ID_A, { parentSessionId: ID_M, mode: "one-shot" });
  assert.strictEqual(
    d.scopeRunning(ID_A),
    true,
    "前置：进子代理页时域要以父目录那一行的 running 打底（否则这一条测的不是域上的值）",
  );
  await d.open("v1", ID_M); // 离开子代理页：它的域被回收
  d.catalog(ID_M, ID_A, "one-shot", LABEL_A); // 父域重建，目录靠 durable 事件重放
  assert.strictEqual(
    lastRow(d.frames, "v1", ID_A)?.activity,
    "running",
    "域被回收时要把「它还在跑」记进宿主账本：否则父目录重建后那一行退回「可继续」",
  );
  console.log("  ⑦ 只进去看一眼就回来（账本尚无结论）：状态由被回收的域留住 ✓");
}

console.log("\nsubagentRowState: all assertions passed");
