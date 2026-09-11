/**
 * 思考档位分段控件的列数规则。
 *
 * 用户指定：**4 档及以下一行；5/6 档分两行且分得均匀**（5 → 3+2，6 → 3+3）。
 *
 * 为什么这条要写成代码而不是交给 `flex-wrap`：自然换行折不折、折成几比几
 * 取决于弹层宽度与文案长度。实测 5 档在短英文名下能挤进一行，中文名或更长文案
 * 会折成 4+1——同一个模型在不同语言下排版不一致。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { segmentColumns } from "../src/webview/segment";

/** 按列数把 n 个档位切成每行几个，用于断言实际分布。 */
function layout(count: number): number[] {
  const cols = segmentColumns(count);
  if (!cols) return [count];
  const rows: number[] = [];
  let rest = count;
  while (rest > 0) {
    const take = Math.min(cols, rest);
    rows.push(take);
    rest -= take;
  }
  return rows;
}

// ---------- 4 档及以下：一行 ----------

assert.strictEqual(segmentColumns(1), undefined, "1 档一行");
assert.strictEqual(segmentColumns(2), undefined, "2 档一行");
assert.strictEqual(segmentColumns(3), undefined, "3 档一行");
assert.strictEqual(segmentColumns(4), undefined, "4 档一行");
assert.deepStrictEqual(layout(1), [1]);
assert.deepStrictEqual(layout(2), [2]);
assert.deepStrictEqual(layout(3), [3]);
assert.deepStrictEqual(layout(4), [4]);
console.log("segment: 4 档及以下一行 ✓");

// ---------- 5 / 6 档：两行且均匀 ----------

assert.strictEqual(segmentColumns(5), 3, "5 档：每行 3 个");
assert.deepStrictEqual(layout(5), [3, 2], "5 档应分成 3+2，而不是 4+1");

assert.strictEqual(segmentColumns(6), 3, "6 档：每行 3 个");
assert.deepStrictEqual(layout(6), [3, 3], "6 档应分成 3+3");
console.log("segment: 5/6 档分两行且均匀 ✓");

// ---------- 边界：两行仍放不下时继续排，但每行不超过上限 ----------

assert.deepStrictEqual(layout(7), [4, 3], "7 档 → 4+3");
assert.deepStrictEqual(layout(8), [4, 4], "8 档 → 4+4");
// 极端值：不能出现空行、不能死循环、每行不超过 4
for (const n of [9, 12, 20]) {
  const rows = layout(n);
  assert.strictEqual(rows.reduce((a, b) => a + b, 0), n, `${n} 档不能丢档位`);
  assert.ok(rows.every((r) => r >= 1 && r <= 4), `${n} 档每行应在 1..4，实际 ${JSON.stringify(rows)}`);
  assert.ok(rows.length >= 2, `${n} 档应当分行`);
}
console.log("segment: 大数量的边界 ✓");

// ---------- 非法输入不崩 ----------

assert.strictEqual(segmentColumns(0), undefined, "0 档 → 不约束（界面也不会渲染）");
assert.strictEqual(segmentColumns(-3), undefined);
assert.strictEqual(segmentColumns(Number.NaN), undefined);
console.log("segment: 非法输入安全 ✓");

console.log("\nsegment: all assertions passed");
