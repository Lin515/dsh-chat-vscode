/**
 * 投影值存储的契约断言（`src/dsh/projectionStore.ts`）。
 *
 * 钉的是官方 `ProjectionValueStore` 那三条语义（本仓库的契约副本在
 * `docs/dsh-server-api.md` §6.10 的客户端消费规则里逐字引过）：
 *
 * 1. **higher seq wins**：`seq <= 已存水位` 一律丢弃 —— 重放的旧帧不能把新值顶回去；
 * 2. **baseline 在它的 cut 上播种**：块里没带、且不新于该 cut 的键**清掉**；
 * 3. **truncate 丢掉比 cut 新的行**：替换型 baseline 之后，那些行描述的是 Host 在持久化
 *    之前丢掉的进程状态，留着会永远压过重算出来的低水位值。
 *
 * 另有一条本仓库的纪律：拿不到水位时**不比较、也不清空**（按肯定证据写）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { ProjectionStore } from "../src/dsh/projectionStore";

// ---------- 1. higher seq wins ----------

{
  const store = new ProjectionStore();
  assert.strictEqual(store.get("plan"), undefined, "没写入过的键读出来是 undefined（能力缺失）");
  assert.strictEqual(store.apply("plan", { active: false }, 5), true, "第一次写入");
  assert.strictEqual(store.apply("plan", { active: true }, 5), false, "**同 seq 也算负**（契约：lower-or-equal loses）");
  assert.deepStrictEqual(store.get("plan"), { active: false }, "被丢弃的帧不能改动存量");

  assert.strictEqual(store.apply("plan", { active: true }, 4), false, "更低的 seq 一律丢弃");
  assert.strictEqual(store.apply("plan", { active: true }, 6), true, "更高的 seq 胜出");
  assert.deepStrictEqual(store.get("plan"), { active: true });

  // 每个键各自记水位：一个键的旧帧不影响别的键
  assert.strictEqual(store.apply("todos", [], 1), true);
  assert.strictEqual(store.apply("plan", { active: false }, 5), false, "plan 的水位仍是 6");
  assert.deepStrictEqual(store.keys().sort(), ["plan", "todos"]);
}
console.log("projectionStore: higher seq wins（同 seq 也算负）✓");

// ---------- 2. 拿不到水位：不比较、也不抹掉已有水位 ----------

{
  const store = new ProjectionStore();
  assert.strictEqual(store.apply("title", "旧标题", 9), true);
  assert.strictEqual(store.apply("title", "无水位的新标题", undefined), true, "没有水位就照常落地（不凭猜丢数据）");
  assert.strictEqual(store.get("title"), "无水位的新标题");
  assert.strictEqual(
    store.apply("title", "同水位的重放", 9),
    false,
    "无水位写入后**保留旧水位**：同 seq 的重放仍被判负，水位不会退化成 0",
  );
  assert.strictEqual(store.apply("title", "更高的水位", 10), true);
}
console.log("projectionStore: 无水位写入不比较、也不抹掉水位 ✓");

// ---------- 3. seed：在截止水位上播种，块里没带的键要清掉 ----------

{
  const store = new ProjectionStore();
  store.apply("goal", { objective: "旧目标" }, 3);
  store.apply("todos", [{ id: "t", content: "旧待办", status: "pending" }], 3);
  store.apply("plan", { active: true }, 3);

  // 块里只带 `goal`：`todos` 与 `plan` 没带 → 清掉（能力缺失）
  const touched = store.seed({ asOfSeq: 5, values: { goal: { objective: "新目标" } } });
  assert.deepStrictEqual(touched.sort(), ["goal", "plan", "todos"], "改动与被清掉的键都要报出来");
  assert.deepStrictEqual(store.get("goal"), { objective: "新目标" });
  assert.strictEqual(store.has("todos"), false, "块里没带 = 能力缺失：旧值要清");
  assert.strictEqual(store.has("plan"), false);
}
console.log("projectionStore: seed 在 cut 上播种，没带的键清掉 ✓");

// ---------- 4. seed 不能清掉比 cut 更新的值 ----------

{
  const store = new ProjectionStore();
  store.apply("plan", { active: true }, 9); // 比下面的 cut(5) 新
  store.apply("todos", [], 2); // 比 cut 旧

  store.seed({ asOfSeq: 5, values: {} });
  assert.strictEqual(store.has("plan"), true, "比 cut 新的值不能被陈旧的 baseline 清掉");
  assert.strictEqual(store.has("todos"), false, "不新于 cut 的、块里又没带的才清");
}
console.log("projectionStore: 陈旧的 baseline 清不掉更新的值 ✓");

// ---------- 5. seed 拿不到 asOfSeq：逐键落地、一个都不清 ----------

{
  const store = new ProjectionStore();
  store.apply("goal", { objective: "已有目标" }, 3);
  const touched = store.seed({ values: { plan: { active: false } } });
  assert.deepStrictEqual(touched, ["plan"], "只报改动过的键");
  assert.strictEqual(store.has("goal"), true, "没有 cut 就没有「截至哪一刻」这个前提，不许清空");
}
console.log("projectionStore: 没有 asOfSeq 时不清空 ✓");

// ---------- 6. truncate：丢掉比 lastSeq 新的行 ----------

{
  const store = new ProjectionStore();
  store.apply("plan", { active: true }, 12);
  store.apply("todos", [], 4);
  const dropped = store.truncate(5);
  assert.deepStrictEqual(dropped, ["plan"], "只有比 cut 新的行被丢掉");
  assert.strictEqual(store.has("todos"), true);
  assert.deepStrictEqual(store.values(), { todos: [] }, "values() 给的是只读快照");
}
console.log("projectionStore: truncate 丢掉比 cut 新的行 ✓");

// ---------- 7. values / clear ----------

{
  const store = new ProjectionStore();
  store.apply("a", 1, 1);
  store.apply("b", 2, 1);
  assert.deepStrictEqual(store.values(), { a: 1, b: 2 });
  store.clear();
  assert.deepStrictEqual(store.values(), {});
  assert.deepStrictEqual(store.keys(), []);
}
console.log("projectionStore: values / clear ✓");

console.log("\nprojectionStore: all assertions passed");
