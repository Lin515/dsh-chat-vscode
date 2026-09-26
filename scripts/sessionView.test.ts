/**
 * 「一个会话在界面上的状态」只有**一个生产者**的断言（`src/dsh/sessionView.ts`）。
 *
 * 这套改动的核心风险不是「某个字段算错了」，而是**字段集合在生产者之间漂**：首帧快照、
 * 增量 patch、切会话专帧各写一份时，加一个字段只改其中一处，症状是那个字段在切换会话后
 * 静默复旧或丢失（`goal` 清不掉、`historyLoading` 永久卡死都是这一族，见
 * `docs/audit-summary.md`）。所以这里的断言是**通用**的、按字段集合比较，不是逐字段
 * 手写：
 *
 * 1. 声明式键清单：`SessionView` 的键**写死在测试里**（不是从源码里读回来——读回来
 *    就成了自证）。往视图加字段而忘了同步，这里先红；
 * 2. **三个生产者**（全字段构造 / 增量 patch / 切会话帧）取同一份输入，断言
 *    `Object.keys` 全等——它们共用一张字段表，任何一条路少给一个字段都会在这里现形；
 * 3. 折返口径：`undefined` 必须过线成 `null`（`shared/wire.ts`），清空才到得了界面；
 * 4. 接线与反漂移：宿主侧那几条路只准调 `sessionPatch` / `sessionView`，且每个会话字段
 *    都要有一个「取值来自会话域」的读点——加字段时忘了加进控制器的取值处，这条先红。
 *
 * 运行（本文件登记进 `esbuild.scripts.mjs` 的 entries 之前，用临时打包单跑）：
 * ```
 * npx esbuild scripts/sessionView.test.ts --bundle --platform=node --format=esm \
 *   --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
 *   --outfile="$env:TEMP\sessionView.test.mjs" && node "$env:TEMP\sessionView.test.mjs"
 * ```
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPEARANCE_VIEW_KEYS,
  SESSION_VIEW_KEYS,
  appearanceView,
  sessionPatch,
  sessionSourceOf,
  sessionView,
  wireOf,
  type AppearanceViewSource,
  type SessionViewSource,
} from "../src/dsh/sessionView";
import { SessionScope } from "../src/dsh/scope";

/**
 * 声明的会话字段清单（**手写**）。
 *
 * 它与 `SESSION_VIEW_KEYS` 必须键集相同：往 `SessionView` 加字段时，改一处不够——
 * 这里是一道**独立的**人工清点，防止「构造器与字段表一起改、生产者没跟上」。
 * **顺序也要一致**：`SESSION_VIEW_KEYS` 的声明顺序就是帧里键的顺序（与原快照逐字
 * 相同），改顺序同样是可观察的差异。
 */
const EXPECTED_SESSION_KEYS = [
  "session",
  "messages",
  "running",
  "queueItems",
  "models",
  "model",
  "permission",
  "planMode",
  "todos",
  "subagentEntries",
  "subagent",
  "jobs",
  "goal",
  "contextWindow",
  "contextOccupancy",
  "lastSpeed",
  "fileKinds",
  "hasMoreHistory",
  "historyLoading",
  "contextBreakdown",
  "sessionStats",
  "tokenUsage",
  "turnOutline",
  "imageLimits",
  "agentPreset",
];

/** 声明的外观态字段清单（手写，同上）。 */
const EXPECTED_APPEARANCE_KEYS = [
  "locale",
  "diffLayout",
  "fontSizePx",
  "questionBatch",
  "turnProcessThreshold",
  "busyEnter",
  "permissionAutoReview",
  "workspace",
  "agentPresets",
];

/** 一份完整的会话取值来源（形状与 `sessionSourceOf` 的返回值一致）。 */
function fullSessionSource(): SessionViewSource {
  return {
    session: () => ({ id: "s1", title: "标题", updatedAt: 1, running: false }),
    messages: () => [],
    running: () => true,
    queueItems: () => [],
    models: () => [],
    model: () => undefined,
    permission: () => "workspace-write",
    planMode: () => false,
    todos: () => [],
    subagentEntries: () => [],
    subagent: () => undefined,
    jobs: () => [],
    goal: () => undefined,
    contextWindow: () => undefined,
    contextOccupancy: () => undefined,
    lastSpeed: () => undefined,
    fileKinds: () => undefined,
    hasMoreHistory: () => false,
    historyLoading: () => false,
    contextBreakdown: () => undefined,
    sessionStats: () => undefined,
    tokenUsage: () => undefined,
    turnOutline: () => undefined,
    imageLimits: () => undefined,
    agentPreset: () => undefined,
  };
}

/** 「首帧 / 切会话」那条路：`sessionView(sessionSourceOf(...))`。 */
function snapshotProducer(source: SessionViewSource): Record<string, unknown> {
  return { ...sessionView(source) };
}

/**
 * 「增量 patch」那条路：控制器与适配器每次只取变了的键，但取法必须与快照**同一张表**
 * ——这里模拟"每个键都变了一次"的最坏情况，键集必须与快照逐字相同。
 */
function patchProducer(source: SessionViewSource): Record<string, unknown> {
  const keys = SESSION_VIEW_KEYS.filter((key) => source[key] !== undefined);
  return { ...sessionPatch(source, keys) };
}

/** 「切会话专帧」那条路：与首帧共用 `snapshotFor`，即同一个 `sessionView` 调用。 */
function switchProducer(source: SessionViewSource): Record<string, unknown> {
  return { ...sessionView(source) };
}

console.log("sessionView: 装配完成 ✓");

// ---------- 1. 声明式键清单：视图类型、键元组、生产的字段集三者一致 ----------
{
  assert.deepStrictEqual(
    [...EXPECTED_SESSION_KEYS].sort(),
    [...SESSION_VIEW_KEYS].sort(),
    `会话字段清单与构造器声明的键不一致：\n  测试声明=${JSON.stringify(EXPECTED_SESSION_KEYS)}\n` +
      `  构造器声明=${JSON.stringify([...SESSION_VIEW_KEYS])}\n` +
      "（往 SessionView 加字段时：接口、SESSION_VIEW_KEYS、这份清单、以及控制器的取值处要一起改）",
  );
  assert.deepStrictEqual(
    [...EXPECTED_APPEARANCE_KEYS].sort(),
    [...APPEARANCE_VIEW_KEYS].sort(),
    "外观态字段清单与构造器声明不一致",
  );
}
console.log("sessionView: 字段清单（视图 / 键元组 / 测试声明）一致 ✓");

// ---------- 2. 通用键集合断言：三个生产者取同一份输入，键集必须全等 ----------
{
  const source = fullSessionSource();
  const snapshot = snapshotProducer(source);
  const patch = patchProducer(source);
  const switched = switchProducer(source);

  const snapshotKeys = Object.keys(snapshot).sort();
  const patchKeys = Object.keys(patch).sort();
  const switchKeys = Object.keys(switched).sort();

  assert.deepStrictEqual(
    patchKeys,
    snapshotKeys,
    "增量 patch 与首帧快照的键集合必须逐字相同（同一个字段表产出）",
  );
  assert.deepStrictEqual(
    switchKeys,
    snapshotKeys,
    "切会话专帧与首帧快照的键集合必须逐字相同（同一个字段表产出）",
  );
  assert.deepStrictEqual(
    snapshotKeys,
    [...EXPECTED_SESSION_KEYS].sort(),
    "快照生产者产出的键集合必须等于声明的字段清单（少一个字段就是「切换后那个字段复旧」）",
  );
  // 键的**顺序**也钉住：快照那一步是 `{...connection, ...appearance, ...sessionView(...)}`，
  // 会话片段在帧里保持 `SESSION_VIEW_KEYS` 的声明顺序（= 收敛之前那份快照的顺序），
  // 键序一变，线上帧的 JSON 文本就变——对拍时全是噪声
  assert.deepStrictEqual(
    Object.keys(snapshot),
    [...EXPECTED_SESSION_KEYS],
    "会话片段的键顺序必须与声明顺序一致（帧的 JSON 形态不变）",
  );

  // 值也要逐键相同：同一份来源走两条路，结果必须是同一份（含 undefined → null 的折返）
  assert.deepStrictEqual(patch, snapshot, "同一份来源经 patch 与快照两条路必须产出同一份值");
}
console.log("sessionView: 三个生产者的键集合全等 ✓");

// ---------- 3. 折返：undefined 过线成 null（清空必须到得了界面） ----------
{
  assert.strictEqual(wireOf(undefined), null, "undefined 必须折成 null——发 undefined 会被 JSON 整条丢掉");
  assert.strictEqual(wireOf(false), false, "false 是真值，不能折成 null");
  assert.strictEqual(wireOf(0), 0, "0 是真值，不能折成 null");
  assert.strictEqual(wireOf(""), "", "空串是真值");
  assert.deepStrictEqual(wireOf([]), [], "空数组原样过（truthy 语义不变）");

  const source = fullSessionSource();
  const view = sessionView(source);
  assert.strictEqual(view.goal, null, "没有目标时必须是 null（清空指令的载体）");
  assert.strictEqual(view.model, null, "没有模型选择时是 null");
  assert.strictEqual(view.running, true, "布尔按取值过");
  assert.strictEqual(view.permission, "workspace-write");
  assert.notStrictEqual(view.session, null, "会话摘要在来源里有值时原样过");

  // 必填的数组/布尔在缺来源时按原来的快照口径兜底（空数组 / false），不是 null：
  // 线格式里它们是必填，界面侧的类型也不接受 null
  const empty = sessionView({} as SessionViewSource);
  assert.deepStrictEqual(empty.messages, [], "缺来源时消息是空表（原来快照就是 ?? []）");
  assert.deepStrictEqual(empty.queueItems, [], "队列同理");
  assert.deepStrictEqual(empty.subagentEntries, [], "子代理目录同理");
  assert.deepStrictEqual(empty.jobs, [], "后台任务同理");
  assert.deepStrictEqual(empty.todos, [], "待办同理");
  assert.strictEqual(empty.running, false, "运行态缺来源时为 false");
  assert.strictEqual(empty.planMode, false, "计划模式缺来源时为 false");
  assert.strictEqual(empty.hasMoreHistory, false, "hasMoreHistory 缺来源时为 false");
  assert.strictEqual(empty.historyLoading, false, "historyLoading 缺来源时为 false");
  assert.strictEqual(empty.session, null, "会话摘要缺失时为 null（界面折回 undefined）");
}
console.log("sessionView: undefined → null 的折返只在构造器里 ✓");

// ---------- 4. 外观态：同一套流水线，键集固定 ----------
{
  const source: AppearanceViewSource = {
    locale: () => "zh-cn",
    diffLayout: () => "auto",
    fontSizePx: () => undefined,
    questionBatch: () => 0,
    turnProcessThreshold: () => 3,
    busyEnter: () => "queue",
    permissionAutoReview: () => true,
    workspace: () => ({ path: "D:\\dev\\app", locked: false }),
    agentPresets: () => ({ options: [{ id: "standard" }], selectable: true }),
  };
  const view = appearanceView(source);
  assert.deepStrictEqual(
    Object.keys(view).sort(),
    [...EXPECTED_APPEARANCE_KEYS].sort(),
    "外观态的键集合必须等于声明的清单",
  );
  assert.strictEqual(view.locale, "zh-cn");
  assert.strictEqual(view.fontSizePx, null, "字号 0（auto）过线成 null，界面清掉 CSS 变量");
  assert.strictEqual(view.questionBatch, 0, "0 是真值（不是「没有值」）");
  assert.strictEqual(view.permissionAutoReview, true, "布尔按取值过（Auto review 档可用）");
}
console.log("sessionView: 外观态键集固定 ✓");

// ---------- 5. 接线不变量：宿主侧只准走构造器，且每个字段都有会话域读点 ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");

  // （a）所有 `state` 帧只由 snapshotFor 发（切会话专帧与首帧同源）
  const stateFrames = [...controller.matchAll(/type: "state", state: ([^}]+)\}/g)].map((m) =>
    m[1].trim(),
  );
  assert.ok(stateFrames.length >= 3, `应当有 ready / 新建 / 切换 / 恢复几条 state 帧，实际 ${stateFrames.length}`);
  for (const expression of stateFrames) {
    assert.strictEqual(
      expression,
      "this.snapshotFor(viewId)",
      `state 帧必须整份来自 snapshotFor（现场手拼的状态帧就是我们刚拆掉的那种漂移来源）：${expression}`,
    );
  }

  // （b）快照里两个构造器都在（少一个 → 那一半字段整体消失）
  assert.ok(
    /\.\.\.appearanceView\(this\.appearanceSource\(\)\)/.test(controller) &&
      /\.\.\.sessionView\(\s*sessionSourceOf\(/.test(controller),
    "snapshotFor 必须由 appearanceView + sessionView 两份构造器拼出",
  );

  // （c）会话字段的 patch 只准走 sessionPatch：宿主侧不再出现手写的会话字段字面量
  const literalPatches = [
    ...controller.matchAll(/patch: \{ (session|messages|running|queueItems|models|model|permission|planMode|todos|subagentEntries|jobs|goal|contextWindow|contextOccupancy|lastSpeed|fileKinds|hasMoreHistory|historyLoading|contextBreakdown|sessionStats|tokenUsage|turnOutline|imageLimits)[:,}]/g),
  ].map((m) => m[1]);
  assert.deepStrictEqual(
    literalPatches,
    [],
    `会话字段的 patch 必须走 sessionPatch（同一张字段表），手写的：${literalPatches.join(", ")}`,
  );

  // （d）反漂移的那一半：**取值来源**由 `sessionSourceOf` 统一提供（快照与 patch 都从
  //     它取），这里按源码扫一次「每个会话字段都有一条 `键: () => …`」——加字段时只加到
  //     类型与字段表、忘了给取值来源，这条先红（类型那一层同样会报，见文件头）
  const moduleSource = readFileSync(join(process.cwd(), "src", "dsh", "sessionView.ts"), "utf8");
  const sourceBody = moduleSource.slice(
    moduleSource.indexOf("export function sessionSourceOf("),
    moduleSource.indexOf("export function", moduleSource.indexOf("export function sessionSourceOf(") + 10),
  );
  const missingSources = EXPECTED_SESSION_KEYS.filter(
    (key) => !new RegExp(`^\\s*${key}: \\(\\) =>`, "m").test(sourceBody),
  );
  assert.deepStrictEqual(
    missingSources,
    [],
    `这些会话字段没有取值来源（加进 SessionView 却没人给它值）：${missingSources.join(", ")}`,
  );
}
console.log("sessionView: 宿主侧接线（只走构造器 + 每个字段有取值来源）✓");

// ---------- 6. 跨名桥已拆：会话状态那个字段只剩一个名字 ----------
//
// 两处**不许被这条断言误伤**的同名物（都不是会话状态字段）：
// - 导航的文案（`texts.subagents`，那是触发器的 title，不是状态字段）；
// - 过程折叠的计数（`counts.subagents`，那是一次轮次里有几次子代理派发）。
{
  const files = {
    "controller.ts": join("src", "dsh", "controller.ts"),
    "scope.ts": join("src", "dsh", "scope.ts"),
    "shared/chat.ts": join("src", "shared", "chat.ts"),
    "webview/state.ts": join("src", "webview", "state.ts"),
    "webview/App.tsx": join("src", "webview", "App.tsx"),
  } as const;

  for (const [name, path] of Object.entries(files)) {
    const text = readFileSync(join(process.cwd(), path), "utf8");
    // 对象字面量里以 `subagents` 为键（旧字段名），以及把它当属性读（`x.subagents`）
    assert.ok(
      !/(^|[{,\s])subagents\s*:/.test(text),
      `${name} 里还有以 subagents 为键的字面量：会话状态字段必须叫 subagentEntries`,
    );
    assert.ok(
      !/\b(state|scope|merged|session|patch)\??\.subagents\b/.test(text),
      `${name} 里还在读状态字段 \`…subagents\`：跨名桥必须拆掉（宿主与界面都叫 subagentEntries）`,
    );
  }

  const app = readFileSync(files["webview/App.tsx"], "utf8");
  assert.ok(
    /child \? child\.parentEntries : state\.subagentEntries/.test(app),
    "App.tsx 的子代理导航必须直接消费 state.subagentEntries（不再有跨名桥）",
  );
  const chat = readFileSync(files["shared/chat.ts"], "utf8");
  assert.ok(
    /^\s*subagentEntries: SubagentView\[\];$/m.test(chat),
    "线格式里的字段名必须是 subagentEntries（与界面状态字段逐字相同）",
  );
}
console.log("sessionView: 子代理目录只剩一个名字（subagentEntries）✓");

// ---------- 7. 空态窗口的「待建会话」预览值（pending） ----------
//
// 会话在第一条消息之前不存在（用户 2026-09-22 口径），但预设 / 模型 / 权限三枚胶囊
// 在空态页上就得显示用户刚点的选择。那三项只有这一条读法（`sessionSourceOf` 的
// `pending`），所以在这里钉两件事：**没有域时**它生效；**有域时**真实状态压过预览值。
{
  const pending = {
    model: () => ({ provider: "p", model: "m", label: "M" }),
    permission: () => "danger-full-access",
    agentPreset: () => "ptc",
  };
  const unbound = sessionSourceOf(undefined, undefined, [], pending);
  assert.strictEqual(unbound.agentPreset?.(), "ptc", "空态窗口要显示待建会话的预设");
  assert.deepStrictEqual(unbound.model?.(), { provider: "p", model: "m", label: "M" });
  assert.strictEqual(
    unbound.permission?.(),
    "danger-full-access",
    "空态窗口要显示待建会话的权限（用户点过的，或配置文件的默认预设）",
  );
  // 没有 pending 时是 undefined（界面据此不渲染那枚胶囊）
  assert.strictEqual(sessionSourceOf(undefined, undefined, []).agentPreset?.(), undefined);
  assert.strictEqual(
    sessionSourceOf(undefined, undefined, []).permission?.(),
    undefined,
    "没有 pending 时权限也是 undefined（不渲染成任何具体档位）",
  );

  // 有域：pending 一律不参与——真实会话的状态永远压过预览值
  const scope = new SessionScope("s-1");
  scope.agentPreset = "standard";
  scope.model = { provider: "p", model: "real", label: "Real" };
  scope.permission = "workspace-write";
  const bound = sessionSourceOf(scope, undefined, [], pending);
  assert.strictEqual(bound.agentPreset?.(), "standard", "绑着会话时不许被预览值顶掉");
  assert.strictEqual(bound.model?.()?.model, "real");
  assert.strictEqual(bound.permission?.(), "workspace-write");

  // 有域但该字段还没有真实值时也不许拿预览值补：投影没到的窗口里胶囊显示空，
  // 等 `applyDefaultModelToScopes` / 投影帧来填——预览值只属于「会话还不存在」的窗口
  const scope2 = new SessionScope("s-2");
  const bound2 = sessionSourceOf(scope2, undefined, [], pending);
  assert.strictEqual(bound2.permission?.(), undefined, "有域时权限的预览值一律不参与");
  assert.strictEqual(bound2.model?.(), undefined);
}
console.log("sessionView: 空态预览值（pending）只在没有会话时生效 ✓");

console.log("\nsessionView: all assertions passed");
