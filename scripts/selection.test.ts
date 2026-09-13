/**
 * 编辑器选区 → 行号区间。
 *
 * 用户 2026-09-14 的口径：编辑器右键加进来的**部分引用**要体现出行号（芯片上
 * 显示、提示词里也写明）。这里钉住那条最容易写错的边界——选区在「下一行行首」
 * 结束时不能多报一行，否则用户照着 `:1-3` 回文件里找会对不上。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectionLines } from "../src/dsh/selection";

/** 快速构造一个选区（行/列都是 0 基，与 VS Code 一致）。 */
function pick(startLine: number, startChar: number, endLine: number, endChar: number) {
  return { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } };
}

// ---------- 1. 单行选几个字符 ----------
{
  assert.deepStrictEqual(selectionLines(pick(11, 4, 11, 20)), { start: 12, end: 12 }, "第 12 行（1 基）");
}
console.log("selection: 单行选区 ✓");

// ---------- 2. 跨行选区 ----------
{
  assert.deepStrictEqual(selectionLines(pick(0, 0, 2, 5)), { start: 1, end: 3 }, "1-3 行");
  assert.deepStrictEqual(selectionLines(pick(9, 2, 19, 1)), { start: 10, end: 20 }, "10-20 行");
}
console.log("selection: 跨行选区 ✓");

// ---------- 3. 关键边界：结束在下一行行首（Shift+↓ / 选整行）不算那一行 ----------
{
  assert.deepStrictEqual(
    selectionLines(pick(0, 0, 1, 0)),
    { start: 1, end: 1 },
    "结束落在第 2 行行首时只有第 1 行被选中，不能报成 1-2",
  );
  assert.deepStrictEqual(selectionLines(pick(4, 0, 8, 0)), { start: 5, end: 8 }, "5-8 行");
}
console.log("selection: 「下一行行首」不多报一行 ✓");

// ---------- 4. 空选区没有范围可言 ----------
{
  assert.strictEqual(selectionLines(pick(3, 7, 3, 7)), undefined, "只有光标时不给行号");
}
console.log("selection: 空选区返回 undefined ✓");

// ---------- 5. 结构不变量：命令、芯片、提示词三处都带上了行号 ----------
{
  const extension = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  assert.ok(
    /controller\.addSelection\(name, text, selectionLines\(editor\.selection\)\)/.test(extension),
    "编辑器命令必须把行号一起交给控制器",
  );
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /attachment\.lines \? \(/.test(composer) && /chip-lines/.test(composer),
    "芯片要显示行号（.chip-lines）",
  );
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /attachment\.lines\s*\?[^;]*第 \$\{attachment\.lines\.start\}-\$\{attachment\.lines\.end\} 行/s.test(
      controller,
    ),
    "发给模型的正文也要写明行范围（否则模型只看到一段无出处的代码）",
  );
  const styles = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  assert.ok(/\.chip-lines\s*\{[^}]*flex:\s*0 0 auto/s.test(styles), "行号那一段不可压缩");
}
console.log("selection: 命令 / 芯片 / 提示词三处接线 ✓");

console.log("\nselection: all assertions passed");
