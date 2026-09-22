/**
 * 投影形状的回归防线（`goal` 与 `subagentCatalog`）。
 *
 * 两个 bug 的共同点：**形状读错**，而且失败方式是「恒为空」而不是报错——
 * 界面上看起来只是「这个功能没有」，没人会去查（docs/audit-summary.md「goal 投影嵌套形状读错」
 * 这两段解析现在抽成纯函数（`src/dsh/projections.ts`），本文件按官方契约逐字
 * 构造投影值来钉住形状。
 *
 * 契约来源：
 * - `@deepseek-ai/dsh-goal/lib/types/types.d.ts` 的 `GoalProjection`；
 * - `@deepseek-ai/dsh-subagent/lib/types/projection-types.d.ts` 的
 *   `SubagentCatalogEntry`；
 * - `@deepseek-ai/dsh-subagent/lib/types/control-types.d.ts` 的 `SubagentListEntry`。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
  agentPresetFromProjection,
  agentPresetsFromList,
  contextBreakdownFromProjection,
  contextPressureFromProjection,
  goalFromProjection,
  imageLimitsFromProjection,
  modelSelectionFromProjection,
  permissionFromProjection,
  planModeFromProjection,
  sessionStatsFromProjection,
  subagentCatalogFromProjection,
  subagentsFromCatalog,
  subagentsFromList,
  titleFromProjection,
  todosFromProjection,
  tokenUsageFromProjection,
  turnOutlineFromProjection,
} from "../src/dsh/projections";
import { replayFollowSnapshot } from "../src/dsh/projectionIngest";

// ---------- 0. plan：生效状态要算上 pending，不是裸 active ----------
//
// 契约（`dsh-plan-mode/lib/types/types.d.ts`）：`active` 是**已落日志**的状态，
// `pending` 表示有一次 `/plan` 选择指向与 active 不同的目标、还没被 `plan/mode` 记录。
//
// 端到端实测到的那条路径：**轮次进行中**点「进入计划模式」，服务端返回
// 「Entering plan mode (applies from the next step).」，投影是
// `{active:false, pending:true}`。只读 `active` 会读成「没进入」→ 按钮看起来没反应，
// 用户再点一次，而契约里对同一目标重复选择是 no-op。
{
  // 四种组合的生效值：pending ? !active : active
  assert.strictEqual(planModeFromProjection({ active: false, pending: false }), false, "不在计划模式");
  assert.strictEqual(planModeFromProjection({ active: true, pending: false }), true, "已在计划模式");
  assert.strictEqual(
    planModeFromProjection({ active: false, pending: true }),
    true,
    "轮次进行中刚发出 /plan：已生效（下个 step 起），裸 active 在这里是 false",
  );
  assert.strictEqual(
    planModeFromProjection({ active: true, pending: true }),
    false,
    "轮次进行中刚发出 /plan off：已生效退出",
  );
  // 缺字段/坏值一律按「未生效」处理，不猜
  assert.strictEqual(planModeFromProjection(undefined), false);
  assert.strictEqual(planModeFromProjection(null), false);
  assert.strictEqual(planModeFromProjection({}), false);
  assert.strictEqual(planModeFromProjection({ active: "yes", pending: 0 }), true, "真值按布尔语义");

  // 官方 chip 的表达式就是这一条：`plan.pending ? !plan.active : plan.active`
  const official = (plan: { active: boolean; pending: boolean }) =>
    plan.pending ? !plan.active : plan.active;
  for (const plan of [
    { active: false, pending: false },
    { active: true, pending: false },
    { active: false, pending: true },
    { active: true, pending: true },
  ]) {
    assert.strictEqual(
      planModeFromProjection(plan),
      official(plan),
      `与官方表达式不一致：${JSON.stringify(plan)}`,
    );
  }
}
console.log("projections: plan 生效状态 = pending ? !active : active（与官方一致） ✓");

// ---------- 0b. 快照必须先回放记录、再铺投影（**行为断言**） ----------
//
// 投影是「截至 asOfSeq 的折叠结果」，永远比记录里的历史事件新。反过来先铺投影、
// 再回放记录，历史里最后一个事件会把折叠值覆盖回旧状态——`plan` 就是活例：
// 一次轮次进行中发出的 `/plan` 只留下 `pending`，日志里没有对应的 `plan/mode`，
// 于是回放末尾那条旧的 `plan/mode` 会把界面上的计划模式关掉。
//
// 这条顺序以前只能靠正则去 `controller.ts` 里比两个 `indexOf` 的大小（同一个手法
// 也出现在 styles.test.ts）。那是「测试面是文件字符」：换行、提取成具名函数、包一层
// try 都会打碎它，而失败信息指向的是「找不到 onItem 回调」，不是「顺序错了」。
// 现在顺序住在一个可以被直接调用的函数里（`replayFollowSnapshot`）。
{
  const calls: string[] = [];
  const adapter = { applyFrame: () => calls.push("replay") };
  const snapshot = {
    type: "snapshot",
    cursor: 7,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 7, values: { plan: { active: true, pending: false } } },
  };
  replayFollowSnapshot(snapshot as never, adapter, () => calls.push("projections"));
  assert.deepStrictEqual(
    calls,
    ["replay", "projections"],
    "跟随开帧必须先回放记录、再铺投影：反过来历史事件会覆盖折叠值（plan 的 pending 会丢）",
  );

  // 只有开帧才铺投影：增量帧没有 `projections` 块，硬铺只会把状态清成空
  calls.length = 0;
  replayFollowSnapshot({ type: "event" } as never, adapter, () => calls.push("projections"));
  assert.deepStrictEqual(calls, ["replay"], "事件帧只回放，不铺投影");

  // 帧形状残缺（webview 侧来的东西不可信）也不能抛：`undefined` 只回放
  calls.length = 0;
  replayFollowSnapshot(undefined, adapter, () => calls.push("projections"));
  assert.deepStrictEqual(calls, ["replay"], "残缺帧不该抛，也不该铺投影");
}
console.log("projections: 快照先回放记录、再铺投影（行为断言） ✓");

// ---------- 1. goal：嵌套形状（目标本体在 goal 里，轮次计数在外层） ----------
//
// 官方 GoalProjection 的逐字形状。**扁平读是本文件要防的那个 bug**：
// 扁平读时 `objective` 取不到 → 目标条永远不渲染。
{
  const wire = {
    goal: {
      id: "g-1",
      revision: 3,
      objective: "把审计第一批改完",
      phase: "active",
      maxGoalRounds: 8,
    },
    roundsStarted: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  };
  const view = goalFromProjection(wire);
  assert.ok(view, "嵌套的 goal 投影必须能读出来（扁平读会得到 undefined）");
  assert.strictEqual(view.objective, "把审计第一批改完");
  assert.strictEqual(view.phase, "active");
  assert.strictEqual(view.rounds, 2, "轮次计数来自**外层** roundsStarted");
  assert.strictEqual(view.maxRounds, 8);
  assert.strictEqual(view.id, "g-1");
  assert.strictEqual(view.revision, 3);

  // 反向断言：把外层计数错当成 goal.rounds 会读到 undefined → 0，这里明确钉住来源
  assert.notStrictEqual(
    (wire.goal as { roundsStarted?: number }).roundsStarted,
    2,
    "roundsStarted 不该在 goal 本体里——它在外层，两者位置不能互换",
  );
}
console.log("projections: goal 按嵌套形状读取，轮次取外层 roundsStarted ✓");

// ---------- 2. goal：没有目标 / 清空 ----------

assert.strictEqual(goalFromProjection(null), undefined, "投影为 null = 没有目标");
assert.strictEqual(goalFromProjection(undefined), undefined);
assert.strictEqual(goalFromProjection({ goal: null, roundsStarted: 0 }), undefined);
assert.strictEqual(goalFromProjection({ goal: { objective: "" } }), undefined, "空目标不渲染");
assert.strictEqual(goalFromProjection({ goal: {} }), undefined);
console.log("projections: goal 为空/被清空时返回 undefined ✓");

// ---------- 3. goal：四个 phase 与 blockedReason ----------

{
  const withPhase = (phase: string) =>
    goalFromProjection({ goal: { objective: "x", phase, maxGoalRounds: 4 }, roundsStarted: 0 });
  assert.strictEqual(withPhase("active")?.phase, "active");
  assert.strictEqual(withPhase("paused")?.phase, "paused");
  assert.strictEqual(withPhase("blocked")?.phase, "blocked");
  assert.strictEqual(withPhase("complete")?.phase, "complete");
  // 词表外的值不能让整条不渲染：退回 active，至少有标签可显示
  assert.strictEqual(withPhase("wat")?.phase, "active");

  const blocked = goalFromProjection({
    goal: {
      objective: "x",
      phase: "blocked",
      maxGoalRounds: 4,
      blockedReason: { code: "same-condition", message: "同一条件连续 3 轮" },
    },
    roundsStarted: 3,
  });
  assert.strictEqual(blocked?.blockedReason, "同一条件连续 3 轮");
}
console.log("projections: goal 的四态词表+未知值降级+blockedReason ✓");

// ---------- 4. subagentCatalog 投影：没有 kind/activity ----------
//
// 这是第二个 bug 的核心：投影值是 `{id, createdAt, mode, label?}`，
// 用 RPC 行的 `kind === "child"` 过滤会让目录**恒为空**。
{
  const wire = [
    { id: "s-1", createdAt: 1, mode: "continuable", label: "调研契约" },
    { id: "s-2", createdAt: 2, mode: "one-shot" },
  ];
  const list = subagentsFromCatalog(wire);
  assert.strictEqual(list.length, 2, "投影条目必须全部保留（按 kind 过滤会得到空数组）");
  assert.deepStrictEqual(
    list.map((item) => [item.id, item.mode, item.label]),
    [
      ["s-1", "continuable", "调研契约"],
      ["s-2", "one-shot", "s-2"],
    ],
  );
  // 投影不带 activity：不知道就不下发，界面据此不画状态点（而不是猜「正在运行」）
  assert.strictEqual(list[0].activity, undefined);
  assert.ok(
    !("kind" in (wire[0] as object)),
    "投影条目里根本没有 kind 字段——这正是旧过滤必然为空的原因",
  );
}
console.log("projections: subagentCatalog 投影保留全部条目，不按 kind 过滤 ✓");

// ---------- 5. subagentCatalog 投影：保留上一次 RPC 拿到的 activity ----------

{
  const known = [
    { id: "s-1", label: "调研契约", mode: "continuable" as const, activity: "running" as const },
    { id: "s-9", label: "已消失", mode: "one-shot" as const, activity: "inactive" as const },
  ];
  const list = subagentsFromCatalog([{ id: "s-1", createdAt: 1, mode: "continuable", label: "调研契约" }], known);
  assert.strictEqual(list[0].activity, "running", "同 id 的已知驻留状态要保留（投影刷新不该把它抹掉）");
  assert.strictEqual(list.length, 1, "投影是权威目录：已不在其中的子代理要消失");
}
console.log("projections: 投影刷新保留已知 activity，并按投影收敛列表 ✓");

// ---------- 6. subagents/list RPC 行：kind 过滤在这里才是对的 ----------

{
  const wire = [
    { kind: "child", id: "s-1", activity: "running", hasChildren: false, mode: "continuable", label: "A" },
    { kind: "child", id: "s-2", activity: "inactive", hasChildren: true, mode: "one-shot" },
    { kind: "diagnostic", id: "s-3", reason: "corrupt" },
  ];
  const list = subagentsFromList(wire);
  assert.deepStrictEqual(
    list.map((item) => [item.id, item.mode, item.activity]),
    [
      ["s-1", "continuable", "running"],
      ["s-2", "one-shot", "inactive"],
    ],
    "诊断行要过滤掉，child 行要带上 activity/mode",
  );
  // 两个来源的 mode 取值必须一致：打开子代理时按它选 address.mode，
  // 硬编码 continuable 会被宿主以 subagent/unauthorized 拒绝
  assert.deepStrictEqual(
    subagentsFromCatalog([{ id: "s-9", mode: "one-shot" }]).map((item) => item.mode),
    subagentsFromList([{ kind: "child", id: "s-9", mode: "one-shot" }]).map((item) => item.mode),
    "投影与 RPC 两条路解析出的 mode 必须相同",
  );
}
console.log("projections: subagents/list RPC 行过滤诊断项并带上 mode ✓");

// ---------- 7. 其余投影键的形状（2026-09-19 从 controller.applyProjection 搬进来） ----------
//
// 每个值都按契约构造（`docs/dsh-server-api.md`「投影」一节的键表），断言的是「线格式 →
// 视图值」这一层；效果（写哪个 scope 字段、发哪一帧）在 `scripts/projectionIngest.test.ts`。
//
// 这一节存在的理由就是那三次「按猜测的形状写」：形状读错不报错，只会恒为空，
// 界面上表现为「这个功能没有」（`docs/audit-summary.md` 三、四章对应条目）。

// 7.1 permissions：只读 currentValue（options 没有消费点，不解析）
{
  assert.strictEqual(
    permissionFromProjection({
      options: [{ value: "read-only", name: "只读" }],
      currentValue: "workspace-write",
    }),
    "workspace-write",
  );
  assert.strictEqual(permissionFromProjection({ currentValue: "" }), undefined, "空串 = 没有权限信息");
  assert.strictEqual(permissionFromProjection({ options: [] }), undefined);
  assert.strictEqual(permissionFromProjection(null), undefined);
}
console.log("projections: permissions 只取 currentValue ✓");

// 7.2 todos：`content` / `text` 两种拼写、状态词表、坏值兜底
{
  const view = todosFromProjection([
    { id: "t1", content: "写文档", status: "in_progress" },
    { id: "t2", text: "跑测试", status: "completed" },
    { content: "没有 id 也没有状态" },
    { id: "t4", content: "词表外的状态", status: "cancelled" },
  ]);
  assert.deepStrictEqual(view, [
    { id: "t1", content: "写文档", status: "in_progress" },
    { id: "t2", content: "跑测试", status: "completed" },
    { id: "2", content: "没有 id 也没有状态", status: "pending" },
    { id: "t4", content: "词表外的状态", status: "pending" },
  ]);
  assert.deepStrictEqual(todosFromProjection(null), [], "契约允许 null（= 没有待办）");
  assert.deepStrictEqual(todosFromProjection("坏了"), []);
}
console.log("projections: todos 形状与状态词表 ✓");

// 7.3 contextPressure：三个水位各自可选（缺哪个就是哪个缺失，**不折成 0**）
{
  assert.deepStrictEqual(
    contextPressureFromProjection({ pressureTokens: 19206, projectedTokens: 19844, contextWindow: 65536 }),
    { pressureTokens: 19206, projectedTokens: 19844, contextWindow: 65536 },
  );
  assert.deepStrictEqual(
    contextPressureFromProjection({ contextWindow: 65536 }),
    { pressureTokens: undefined, projectedTokens: undefined, contextWindow: 65536 },
    "实测分子后到：先只有分母时分子必须是 undefined，不是 0",
  );
  assert.deepStrictEqual(contextPressureFromProjection({ pressureTokens: "19206" }).pressureTokens, undefined);
  assert.deepStrictEqual(contextPressureFromProjection(undefined), {
    pressureTokens: undefined,
    projectedTokens: undefined,
    contextWindow: undefined,
  });
}
console.log("projections: contextPressure 三个水位各自可选 ✓");

// 7.4 tokenUsage：四桶互不重叠，坏值补 0（这个键永远给得出完整对象）
{
  assert.deepStrictEqual(
    tokenUsageFromProjection({
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    }),
    { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  );
  assert.deepStrictEqual(tokenUsageFromProjection({ outputTokens: 2 }), {
    uncachedInputTokens: 0,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}
console.log("projections: tokenUsage 四桶 ✓");

// 7.5 turnOutline：承重字段（turn/seq）坏了整条丢弃，两段预览坏了退化成空串
{
  const view = turnOutlineFromProjection([
    { turn: 0, seq: 12, prompt: "问", response: "答" },
    { turn: 1, seq: 40, prompt: 42, response: null },
    { seq: 60, prompt: "缺 turn", response: "x" },
    { turn: 3, prompt: "缺 seq", response: "x" },
    { turn: -1, seq: 70, prompt: "坏 turn", response: "x" },
    { turn: 4, seq: 2.5, prompt: "非整数 seq", response: "x" },
  ]);
  assert.deepStrictEqual(
    view,
    [
      { turn: 0, seq: 12, prompt: "问", response: "答" },
      { turn: 1, seq: 40, prompt: "", response: "" },
    ],
    "只有带合法 turn+seq 的条目留下；预览字段类型不对就是空串",
  );
  assert.deepStrictEqual(turnOutlineFromProjection(null), []);
}
console.log("projections: turnOutline 承重字段与预览的容忍度 ✓");

// 7.6 imageLimits：0 与缺失同义（不能当成「零字节上限」）
{
  assert.deepStrictEqual(imageLimitsFromProjection({ maxImageBytes: 8388608, maxImagesPerMessage: 24 }), {
    maxImagesPerMessage: 24,
    maxImageBytes: 8388608,
    maxMessageImageBytes: undefined,
  });
  assert.deepStrictEqual(imageLimitsFromProjection({ maxImageBytes: 0 }), {
    maxImagesPerMessage: undefined,
    maxImageBytes: undefined,
    maxMessageImageBytes: undefined,
  });
}
console.log("projections: imageLimits 上限取值 ✓");

// 7.7 title：`null` / 空串 / 非字符串都是「没有标题」
{
  assert.strictEqual(titleFromProjection("部署默认模型"), "部署默认模型");
  assert.strictEqual(titleFromProjection(null), undefined);
  assert.strictEqual(titleFromProjection(""), undefined);
  assert.strictEqual(titleFromProjection(42), undefined);
}
console.log("projections: title 取值 ✓");

// 7.8 contextBreakdown：三个字段**全有或全无**（半份构成画出来的占比是错的）
{
  assert.deepStrictEqual(
    contextBreakdownFromProjection({ systemTokens: 1, toolsTokens: 2, messageTokens: 3 }),
    { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
  );
  assert.strictEqual(contextBreakdownFromProjection({ systemTokens: 1, toolsTokens: 2 }), undefined);
  assert.strictEqual(contextBreakdownFromProjection(null), undefined);
}
console.log("projections: contextBreakdown 全有或全无 ✓");

// 7.9 sessionStats：`llmMs` / `toolMs` 承重，其余缺失补 0
{
  assert.deepStrictEqual(sessionStatsFromProjection({ turns: 3, steps: 9, llmMs: 1200, toolMs: 300 }), {
    turns: 3,
    steps: 9,
    llmMs: 1200,
    toolMs: 300,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
  });
  assert.strictEqual(sessionStatsFromProjection({ turns: 3, steps: 9 }), undefined);
}
console.log("projections: sessionStats 承重字段 ✓");

// 7.10 modelSelection：`next ?? lastUsed`；半截选择按「没有选择」处理
{
  assert.deepStrictEqual(
    modelSelectionFromProjection({
      lastUsed: { provider: "p", model: "m1" },
      next: { provider: "p", model: "m2", reasoningEffort: "high" },
    }),
    { provider: "p", model: "m2", reasoningEffort: "high" },
    "胶囊显示「下一次会用什么」，所以 next 优先",
  );
  assert.deepStrictEqual(modelSelectionFromProjection({ lastUsed: { provider: "p", model: "m1" }, next: null }), {
    provider: "p",
    model: "m1",
    reasoningEffort: undefined,
  });
  assert.strictEqual(
    modelSelectionFromProjection({ lastUsed: null, next: null }),
    undefined,
    "新会话的投影**存在**但没有选择——这正是「套部署默认」的判据，不能与「投影缺失」混为一谈",
  );
  assert.strictEqual(modelSelectionFromProjection({ next: { provider: "p" } }), undefined);
  assert.strictEqual(modelSelectionFromProjection(undefined), undefined);
}
console.log("projections: modelSelection 取 next ?? lastUsed ✓");

// 7.11 subagentCatalog 的纯解析（与 RPC 列表的合并见第 6 节）
{
  const entries = subagentCatalogFromProjection([
    { id: "s-1", mode: "continuable", label: "A" },
    { id: "s-2", mode: "one-shot" },
  ]);
  assert.deepStrictEqual(entries, [
    { id: "s-1", label: "A", mode: "continuable" },
    { id: "s-2", label: "s-2", mode: "one-shot" },
  ]);
  assert.ok(!("activity" in entries[0]), "投影里没有 activity——它是 RPC 行的字段（第 4 节的 bug 就是这个）");
}
console.log("projections: subagentCatalog 纯解析（无 activity）✓");

// 7.12 agentPreset：`string | null`，空串与 null 同义（= 这个部署没有组装预设）
{
  assert.strictEqual(agentPresetFromProjection("standard"), "standard");
  assert.strictEqual(agentPresetFromProjection(null), undefined, "null = 没有预设，界面据此不渲染下拉框");
  assert.strictEqual(agentPresetFromProjection(""), undefined);
  assert.strictEqual(agentPresetFromProjection(42), undefined);

  // 7.13 agentPresets/list 的 roster：坏预设滤掉、未开放选择时给空目录
  //
  // 契约逐字：`{presets:[{id,trust,isDefault,name?,description?,broken?}], authorable,
  // modeSelectionEnabled}`。两条判据都只有一处实现（`agentPresetsFromList`），
  // 界面不再自己判第二次。
  assert.deepStrictEqual(
    agentPresetsFromList({
      presets: [
        { id: "standard", trust: "system", isDefault: true, name: "标准模式", description: "完整编码 agent" },
        { id: "broken-one", trust: "user", isDefault: false, broken: "composition cannot be read" },
        { id: "minimal", trust: "system", isDefault: false },
      ],
      authorable: true,
      modeSelectionEnabled: true,
    }),
    {
      options: [
        { id: "standard", trust: "system", name: "标准模式", description: "完整编码 agent", isDefault: true },
        { id: "minimal", trust: "system" },
      ],
      selectable: true,
    },
    "坏掉的预设组装不出会话，列进选择器只会把发现推迟到一次失败的会话上",
  );
  // 服务端没开放选择 = 目录给空表（界面据此什么都不渲染）
  assert.deepStrictEqual(
    agentPresetsFromList({
      presets: [{ id: "standard", trust: "system", isDefault: true }],
      authorable: false,
      modeSelectionEnabled: false,
    }),
    { options: [], selectable: false },
  );
  // id 是承重字段：没有它的行整条丢弃；其余字段类型不对按「没有」处理
  assert.deepStrictEqual(
    agentPresetsFromList({
      presets: [{ name: "没有 id" }, { id: 7 }, { id: "ok", trust: "sideways", name: 42, description: null }],
      modeSelectionEnabled: true,
    }),
    { options: [{ id: "ok" }], selectable: true },
    "trust 只认 system / user 两个取值：别的值不猜（界面按原文展示）",
  );
  // 缺字段 / 坏值（旧服务端、别的实现）一律按「没有」处理
  assert.deepStrictEqual(agentPresetsFromList(undefined), { options: [], selectable: false });
  assert.deepStrictEqual(agentPresetsFromList({ presets: "坏了" }), { options: [], selectable: false });
}
console.log("projections: agentPreset 投影 + roster 目录（坏预设与未开放选择）✓");

console.log("\nprojections: all assertions passed");
