/**
 * 会话查找（Ctrl+F）**纯逻辑**的断言：`src/webview/find.ts`。
 *
 * 覆盖两块：`computeMatches` 的定位口径（大小写、跨节点、不重叠、空词）与
 * `stepActive` 的环绕推进。DOM 那一半（TreeWalker / Highlight 登记）在
 * FindBar.tsx 里，无头环境测不了，靠 `npm run preview` 人工看。
 *
 * 运行：先打包再跑（与其它断言脚本同一条路）。已登记到 `esbuild.scripts.mjs`：
 *
 *   npm run build:scripts && node build/find.test.mjs
 */
import assert from "node:assert";
import { computeMatches, stepActive, type TextMatch } from "../src/webview/find";

// ---------- 1. 基本定位 ----------

// 单节点多处命中：区间从左往右、不重叠
{
  const matches = computeMatches(["abcabc"], "abc");
  assert.deepStrictEqual(matches, [
    [{ node: 0, start: 0, end: 3 }],
    [{ node: 0, start: 3, end: 6 }],
  ]);
}
console.log("find: 单节点多处命中（不重叠） ✓");

// ---------- 2. 大小写不敏感（对双方都折叠） ----------

{
  const matches = computeMatches(["Foo BAR baz"], "bar");
  assert.deepStrictEqual(matches, [[{ node: 0, start: 4, end: 7 }]]);
  const reverse = computeMatches(["foo"], "FOO");
  assert.deepStrictEqual(reverse, [[{ node: 0, start: 0, end: 3 }]]);
}
console.log("find: 大小写不敏感 ✓");

// ---------- 3. 跨节点命中：一处命中摊成多段 ----------

// 粗体把 "world" 劈成两段（"hello w" + "orld"）：命中横跨两个节点
{
  const matches = computeMatches(["hello w", "orld"], "world");
  assert.deepStrictEqual(matches, [
    [
      { node: 0, start: 6, end: 7 },
      { node: 1, start: 0, end: 4 },
    ],
  ]);
}

// 劈成三段也一样
{
  const matches = computeMatches(["a", "b", "c"], "abc");
  assert.deepStrictEqual(matches, [
    [
      { node: 0, start: 0, end: 1 },
      { node: 1, start: 0, end: 1 },
      { node: 2, start: 0, end: 1 },
    ],
  ]);
}

// 命中只在节点边界两侧各沾一点（"ab" + "cd" 查 "bc"）
{
  const matches = computeMatches(["ab", "cd"], "bc");
  assert.deepStrictEqual(matches, [
    [
      { node: 0, start: 1, end: 2 },
      { node: 1, start: 0, end: 1 },
    ],
  ]);
}
console.log("find: 跨节点命中摊成多段 ✓");

// ---------- 4. 边界：空词、查无、比拼接串还长 ----------

{
  assert.deepStrictEqual(computeMatches(["abc"], ""), []);
  assert.deepStrictEqual(computeMatches(["abc"], "abcd"), []);
  assert.deepStrictEqual(computeMatches([], "a"), []);
  assert.deepStrictEqual(computeMatches(["aaa"], "aa"), [[{ node: 0, start: 0, end: 2 }]]);
}
console.log("find: 空词 / 查无 / 不重叠步进 ✓");

// ---------- 5. 中文（大小写折叠是恒等变换，不能因此出错） ----------

{
  const matches = computeMatches(["你好世界，世界"], "世界");
  assert.deepStrictEqual(matches, [
    [{ node: 0, start: 2, end: 4 }],
    [{ node: 0, start: 5, end: 7 }],
  ]);
}
console.log("find: 中文子串 ✓");

// ---------- 6. stepActive：环绕推进 ----------

{
  assert.strictEqual(stepActive(0, 3, 1), 1);
  assert.strictEqual(stepActive(2, 3, 1), 0); // 向后绕
  assert.strictEqual(stepActive(0, 3, -1), 2); // 向前绕
  assert.strictEqual(stepActive(1, 3, -2), 2);
  assert.strictEqual(stepActive(0, 3, 7), 1); // 大步长取模
  assert.strictEqual(stepActive(2, 0, 1), 0); // 没有命中：恒 0
  assert.strictEqual(stepActive(0, 0, -1), 0);
}
console.log("find: 环绕推进 ✓");

// ---------- 7. 契约：TextMatch 的形状是「区间数组」（跨节点时长度 > 1） ----------

{
  const matches: TextMatch[] = computeMatches(["x", "y"], "xy");
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].length, 2);
}
console.log("find: TextMatch 形状 ✓");

console.log("\nfind: all assertions passed");
