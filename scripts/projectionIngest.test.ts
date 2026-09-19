/**
 * 投影摄入登记表的断言（`src/dsh/projectionIngest.ts`）。
 *
 * 钉三件事：
 *
 * 1. **键集合双向对齐**：本扩展消费的键与契约那份清单对拍——契约新增一个客户端可见的
 *    键时，要么进登记表、要么在这里显式登记「有意不消费」，不允许静默漏掉
 *    （`@key` 的 MARKERS 清单是同一个手法）；
 * 2. **一个键一条**：每个键的值被正确解析后派发给它自己的效果；没有效果可派的键
 *    （契约里有、本扩展不消费的）照样入 store，但不派发；
 * 3. **清空语义**：替换型 baseline 会清掉块里没带的键，**被清掉的键也要派发一次**
 *    （`present === false`），否则 store 清了、界面还留着旧值——那正是
 *    `shared/wire.ts` 那套 `null` 语义踩过的坑。
 *
 * 「少一个键编译不过」这条由 `ProjectionHandlers` 的映射类型保证（类型层，不是运行时），
 * 所以这里的手写 handlers 必须列全 14 个——它同时也是接口的一份活文档。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionScope } from "../src/dsh/scope";
import {
  PROJECTION_KEYS,
  ingestControlBaseline,
  ingestFollowSnapshot,
  ingestProjection,
  isProjectionKey,
  readProjection,
  type ProjectionHandlers,
  type ProjectionKey,
} from "../src/dsh/projectionIngest";

interface Recorded {
  key: ProjectionKey;
  value: unknown;
  present: boolean;
}

/** 记录每一次派发的假 handlers（14 个键一个不少）。 */
function recorder(): { handlers: ProjectionHandlers; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const track =
    (key: ProjectionKey) =>
    (_scope: SessionScope, value: unknown, present: boolean): void => {
      seen.push({ key, value, present });
    };
  const handlers: ProjectionHandlers = {
    inbox: track("inbox"),
    modelSelection: track("modelSelection"),
    permissions: track("permissions"),
    plan: track("plan"),
    todos: track("todos"),
    contextPressure: track("contextPressure"),
    tokenUsage: track("tokenUsage"),
    turnOutline: track("turnOutline"),
    imageLimits: track("imageLimits"),
    title: track("title"),
    contextBreakdown: track("contextBreakdown"),
    sessionStats: track("sessionStats"),
    subagentCatalog: track("subagentCatalog"),
    goal: track("goal"),
  };
  return { handlers, seen };
}

// ---------- 1. 键集合：与契约的 19 键对拍（双向） ----------

{
  // 契约里**本扩展消费**的键（`docs/dsh-server-api.md` §6.10）。
  const CONSUMED: ProjectionKey[] = [
    "title",
    "turnOutline",
    "plan",
    "permissions",
    "modelSelection",
    "tokenUsage",
    "contextPressure",
    "contextBreakdown",
    "sessionStats",
    "todos",
    "goal",
    "inbox",
    "subagentCatalog",
    "imageLimits",
  ];
  assert.deepStrictEqual([...PROJECTION_KEYS].sort(), [...CONSUMED].sort(), "登记表与这份清单必须逐键对齐");

  // 契约里存在、但本扩展**有意不消费**的键。它们不是「忘了做」：
  // - `agentPreset` / `subagent` / `subagentTiming` / `schedule` 是四个还没做的面板
  //   （见 docs/audit-summary.md「仍未修复」），解析一份没人用的形状只会攒死代码；
  // - `sessionListMetadata` 是冷列表提示，本扩展的列表走自己的排序。
  const NOT_CONSUMED = ["agentPreset", "schedule", "subagent", "subagentTiming", "sessionListMetadata"];
  for (const key of NOT_CONSUMED) {
    assert.strictEqual(isProjectionKey(key), false, `${key} 有意不消费，不该进登记表`);
    assert.strictEqual(readProjection(key, { anything: true }), undefined, `${key} 没有读取器`);
  }
}
console.log(`projectionIngest: 键集合 ${PROJECTION_KEYS.length} 个与契约对齐（5 个有意不消费）✓`);

// ---------- 2. 一个键一条：逐个键解析 + 派发 ----------

{
  const scope = new SessionScope("s-1");
  const { handlers, seen } = recorder();

  // 每个键都用**契约形状**的值喂进去，断言派发出去的是解析后的视图值。
  const cases: { key: ProjectionKey; wire: unknown; expect: unknown }[] = [
    { key: "permissions", wire: { options: [], currentValue: "workspace-write" }, expect: "workspace-write" },
    { key: "plan", wire: { active: false, pending: true }, expect: true },
    { key: "todos", wire: [{ id: "t", content: "写文档", status: "completed" }], expect: [{ id: "t", content: "写文档", status: "completed" }] },
    { key: "tokenUsage", wire: { outputTokens: 7 }, expect: { uncachedInputTokens: 0, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { key: "turnOutline", wire: [{ turn: 0, seq: 3, prompt: "问", response: "答" }], expect: [{ turn: 0, seq: 3, prompt: "问", response: "答" }] },
    { key: "imageLimits", wire: { maxImageBytes: 1024 }, expect: { maxImagesPerMessage: undefined, maxImageBytes: 1024, maxMessageImageBytes: undefined } },
    { key: "title", wire: "标题", expect: "标题" },
    { key: "contextBreakdown", wire: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 }, expect: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 } },
    { key: "sessionStats", wire: { llmMs: 5, toolMs: 6 }, expect: { turns: 0, steps: 0, llmMs: 5, toolMs: 6, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 } },
    { key: "modelSelection", wire: { lastUsed: { provider: "p", model: "m" }, next: null }, expect: { provider: "p", model: "m", reasoningEffort: undefined } },
    { key: "subagentCatalog", wire: [{ id: "s-9", mode: "one-shot" }], expect: [{ id: "s-9", label: "s-9", mode: "one-shot" }] },
    { key: "goal", wire: { goal: { objective: "目标" }, roundsStarted: 2 }, expect: { id: undefined, revision: undefined, objective: "目标", phase: "active", rounds: 2, maxRounds: undefined, blockedReason: undefined } },
    { key: "inbox", wire: { "next-turn": [] }, expect: { "next-turn": [] } },
    { key: "contextPressure", wire: { pressureTokens: 5 }, expect: { pressureTokens: 5, projectedTokens: undefined, contextWindow: undefined } },
  ];

  for (const item of cases) {
    seen.length = 0;
    const accepted = ingestProjection(handlers, scope, item.key, item.wire, 10);
    assert.strictEqual(accepted, true, `${item.key} 应当被接受`);
    assert.strictEqual(seen.length, 1, `${item.key} 应当恰好派发一次`);
    assert.strictEqual(seen[0].key, item.key);
    assert.strictEqual(seen[0].present, true);
    assert.deepStrictEqual(seen[0].value, item.expect, `${item.key} 的视图值不对`);
    // store 里存的是**原始值**（水位属于它，解析不属于它）：
    // 模型目录后到时的「重放原始投影」就靠这一条
    assert.deepStrictEqual(scope.projections.get(item.key), item.wire, `${item.key} 在 store 里应当是原始值`);
  }
}
console.log("projectionIngest: 14 个键各自的解析与派发 ✓");

// ---------- 3. 水位：旧帧被丢弃，且不派发 ----------

{
  const scope = new SessionScope("s-2");
  const { handlers, seen } = recorder();
  assert.strictEqual(ingestProjection(handlers, scope, "plan", { active: true }, 8), true);
  seen.length = 0;
  assert.strictEqual(ingestProjection(handlers, scope, "plan", { active: false }, 8), false, "同水位算负");
  assert.strictEqual(ingestProjection(handlers, scope, "plan", { active: false }, 7), false, "更低的水位算负");
  assert.strictEqual(seen.length, 0, "被丢弃的帧不许派发效果");
  assert.deepStrictEqual(scope.projections.get("plan"), { active: true }, "存量不许被旧帧改动");
  assert.strictEqual(ingestProjection(handlers, scope, "plan", { active: false }, 9), true, "更高的水位胜出");
  assert.deepStrictEqual(seen.map((item) => item.value), [false]);
}
console.log("projectionIngest: 重放的旧帧被丢弃（且不派发）✓");

// ---------- 4. 契约里有、本扩展不消费的键：入 store，不派发 ----------

{
  const scope = new SessionScope("s-3");
  const { handlers, seen } = recorder();
  assert.strictEqual(ingestProjection(handlers, scope, "schedule", [{ id: "x" }], 4), true);
  assert.strictEqual(scope.projections.has("schedule"), true, "store 不认识键，只认水位：未知键照样存");
  assert.strictEqual(seen.length, 0, "没有效果可派发——「插件没加载 = 能力缺失，不是错误」");
}
console.log("projectionIngest: 不消费的键入 store 但不派发 ✓");

// ---------- 5. 跟随开帧：逐键 apply、**不清**块里没带的键 ----------

{
  const scope = new SessionScope("s-4");
  const { handlers, seen } = recorder();
  ingestProjection(handlers, scope, "goal", { goal: { objective: "先前已有的目标" } }, 3);
  seen.length = 0;

  const touched = ingestFollowSnapshot(handlers, scope, {
    asOfSeq: 9,
    values: { plan: { active: true, pending: false }, todos: null },
  });
  assert.deepStrictEqual([...touched].sort(), ["plan", "todos"]);
  assert.deepStrictEqual([...seen.map((item) => item.key)].sort(), ["plan", "todos"]);
  assert.strictEqual(scope.projections.has("goal"), true, "跟随开帧不清块里没带的键（官方的 snapshot 分支就是逐键 apply）");
  assert.deepStrictEqual(seen.find((item) => item.key === "todos")!.value, [], "`todos: null` → 空表");
  // 块的 asOfSeq 就是这批值的水位：比它旧的重放进不来
  assert.strictEqual(ingestProjection(handlers, scope, "plan", { active: false }, 9), false);
  assert.strictEqual(ingestProjection(handlers, scope, "plan", { active: false }, 10), true);
}
console.log("projectionIngest: 跟随开帧逐键 apply、不清空 ✓");

// ---------- 6. 替换型 baseline：truncate + seed，清掉的键也要派发 ----------

{
  const scope = new SessionScope("s-5");
  const { handlers, seen } = recorder();
  ingestProjection(handlers, scope, "goal", { goal: { objective: "要被清掉的目标" } }, 3);
  ingestProjection(handlers, scope, "plan", { active: true }, 3);
  seen.length = 0;

  const touched = ingestControlBaseline(handlers, scope, { asOfSeq: 5, values: { plan: { active: false } } });
  assert.deepStrictEqual([...touched].sort(), ["goal", "plan"]);
  const goal = seen.find((item) => item.key === "goal");
  assert.ok(goal, "被清掉的键必须派发一次——否则 store 清了、界面还留着旧目标条");
  assert.strictEqual(goal.present, false);
  assert.strictEqual(goal.value, undefined);
  assert.strictEqual(scope.projections.has("goal"), false);
  assert.deepStrictEqual(seen.find((item) => item.key === "plan"), { key: "plan", value: false, present: true });

  // 比 cut 新的行先被 truncate 丢掉，再由块里的值接管（替换型 baseline 的用途）
  const scope2 = new SessionScope("s-6");
  const rec2 = recorder();
  ingestProjection(rec2.handlers, scope2, "plan", { active: true }, 20);
  rec2.seen.length = 0;
  ingestControlBaseline(rec2.handlers, scope2, { asOfSeq: 5, values: { plan: { active: false } } });
  assert.deepStrictEqual(
    rec2.seen,
    [{ key: "plan", value: false, present: true }],
    "比 cut 新的行（Host 在持久化前丢掉的进程状态）被丢掉，块里的值接管",
  );
}
console.log("projectionIngest: 替换型 baseline 清空并派发「不存在」✓");

// ---------- 7. 拿不到 asOfSeq：退化成不清空 ----------

{
  const scope = new SessionScope("s-7");
  const { handlers } = recorder();
  ingestProjection(handlers, scope, "goal", { goal: { objective: "已有的目标" } }, 3);
  const touched = ingestControlBaseline(handlers, scope, { values: { plan: { active: false } } });
  assert.deepStrictEqual([...touched], ["plan"]);
  assert.strictEqual(scope.projections.has("goal"), true, "没有截止水位就不许清空（按肯定证据写）");
}
console.log("projectionIngest: 没有 asOfSeq 的 baseline 不清空 ✓");

console.log("\nprojectionIngest: all assertions passed");
