/**
 * diff 两侧源码重建的离线断言（无 DOM、无 React）：
 *
 * - 旧侧 = context + del，新侧 = context + add，顺序保持 hunk 原序；
 * - 只重建当前 hunk 的连续片段，不跨片段拼整文件；
 * - 行文本逐字保留（CRLF 已在上游归一化，但 tab / NUL / 尾空白不丢）；
 * - 只有删除 / 只有新增时另一侧为空文本。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { diffLineSides } from "../src/webview/diffHighlight";

// ---------- 1. 混合 hunk：两侧下标与文本 ----------
{
  const sides = diffLineSides([
    { kind: "context", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "c" },
    { kind: "context", text: "d" },
  ]);
  assert.strictEqual(sides.oldText, "a\nb\nd");
  assert.strictEqual(sides.newText, "a\nc\nd");
  assert.deepStrictEqual(sides.oldLine, [0, 1, undefined, 2]);
  assert.deepStrictEqual(sides.newLine, [0, undefined, 1, 2]);

  // 同一份上下文行在两侧都存在，但各自是独立的连续片段。
  assert.strictEqual(sides.oldText.split("\n")[sides.oldLine[0]!], "a");
  assert.strictEqual(sides.newText.split("\n")[sides.newLine[0]!], "a");
}

// ---------- 2. 只有新增 / 只有删除 / 空 hunk ----------
{
  const added = diffLineSides([
    { kind: "add", text: "x" },
    { kind: "add", text: "y" },
  ]);
  assert.strictEqual(added.oldText, "");
  assert.deepStrictEqual(added.oldLine, [undefined, undefined]);
  assert.strictEqual(added.newText, "x\ny");
  assert.deepStrictEqual(added.newLine, [0, 1]);

  const removed = diffLineSides([
    { kind: "del", text: "x" },
    { kind: "del", text: "y" },
  ]);
  assert.strictEqual(removed.newText, "");
  assert.deepStrictEqual(removed.newLine, [undefined, undefined]);
  assert.strictEqual(removed.oldText, "x\ny");

  const empty = diffLineSides([]);
  assert.strictEqual(empty.oldText, "");
  assert.strictEqual(empty.newText, "");
  assert.deepStrictEqual(empty.oldLine, []);
  assert.deepStrictEqual(empty.newLine, []);
}

// ---------- 3. 文本逐字保留：tab / NUL / 尾空白 / 空行 ----------
{
  const lines = [
    { kind: "context" as const, text: "\tconst a = 1;  " },
    { kind: "del" as const, text: "A\u0000B" },
    { kind: "add" as const, text: "" },
    { kind: "context" as const, text: "  " },
  ];
  const sides = diffLineSides(lines);
  assert.deepStrictEqual(sides.oldText.split("\n"), ["\tconst a = 1;  ", "A\u0000B", "  "]);
  assert.deepStrictEqual(sides.newText.split("\n"), ["\tconst a = 1;  ", "", "  "]);
  assert.strictEqual(sides.oldText.split("\n")[1], "A\u0000B");
  assert.strictEqual(sides.newText.split("\n")[0], "\tconst a = 1;  ");
}

console.log("diffHighlight: 两侧重建、行序、空侧与文本逐字保真 ✓");
