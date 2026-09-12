/**
 * 投影形状的回归防线（`goal` 与 `subagentCatalog`）。
 *
 * 两个 bug 的共同点：**形状读错**，而且失败方式是「恒为空」而不是报错——
 * 界面上看起来只是「这个功能没有」，没人会去查（docs/audit-summary.md §3、§4）。
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  goalFromProjection,
  planModeFromProjection,
  subagentsFromCatalog,
  subagentsFromList,
} from "../src/dsh/projections";

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

// ---------- 0b. 源码级不变量：快照必须先回放记录、再铺投影 ----------
//
// 投影是「截至 asOfSeq 的折叠结果」，永远比记录里的历史事件新。反过来先铺投影、
// 再回放记录，历史里最后一个事件会把折叠值覆盖回旧状态——`plan` 就是活例：
// 一次轮次进行中发出的 `/plan` 只留下 `pending`，日志里没有对应的 `plan/mode`，
// 于是回放末尾那条旧的 `plan/mode` 会把界面上的计划模式关掉。
// 这类顺序问题读代码很容易看漏，用源码级断言钉住（与 styles.test.ts 同一手法）。
{
  const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const follow = /followSession\([\s\S]*?onItem:\s*\(value\)\s*=>\s*\{([\s\S]*?)\n {6}\},/.exec(source);
  assert.ok(follow, "controller.ts 里找不到 follow() 的 onItem 回调");
  const body = follow[1];
  const replayAt = body.indexOf("adapter.applyFrame");
  const projectionAt = body.indexOf("this.applyProjection");
  assert.ok(replayAt >= 0 && projectionAt >= 0, "onItem 里应当既有回放也有投影铺开");
  assert.ok(
    replayAt < projectionAt,
    "快照到达时必须**先回放记录、再铺投影**：反过来的话历史事件会覆盖折叠值（plan 的 pending 会丢）",
  );
}
console.log("projections: 快照先回放记录、再铺投影（否则折叠值会被历史覆盖） ✓");

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

console.log("\nprojections: all assertions passed");
