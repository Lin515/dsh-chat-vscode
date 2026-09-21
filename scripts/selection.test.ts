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

// ---------- 5. 结构不变量：命令把行号交给宿主，宿主插成带行号的 `@` 引用 ----------
//
// 用户 2026-09-14 口径：目录、文件、文件某行**一律走 `@` 引用**，不做附件。
// 所以「三处接线」现在是：命令带行号 → 宿主格式化 → 界面插到光标处。
{
  const extension = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  assert.ok(
    /controller\.addSelection\(name, selectionLines\(editor\.selection\)\)/.test(extension),
    "编辑器命令必须把行号一起交给控制器",
  );
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /this\.insertMention\(viewId, formatFileMentionWithLines\(name, lines\)\)/.test(controller),
    "选区要插成带行号的 `@` 引用",
  );
  assert.ok(
    /this\.insertMention\(viewId, formatFileMention\(this\.relativePath\(path\), "file"\)\)/.test(controller),
    "文件右键也要插成 `@` 引用",
  );
  assert.ok(
    /private addDirectoryReference\(viewId: string, path: string\): void \{\s*\n\s*this\.insertMention\(viewId, formatFileMention\(this\.relativePath\(path\), "directory"\)\)/.test(
      controller,
    ),
    "目录（右键 / 粘贴 / 接入管线）走唯一的目录落点，插成带结尾斜杠的 `@` 引用",
  );
  assert.ok(
    /if \(isDirectoryPath\(path\)\) \{\s*\n\s*this\.addDirectoryReference\(viewId, path\);/.test(controller),
    "addFileContext 要按目录/文件分流到上面两条（同一条 `@` 引用规则）",
  );
  assert.ok(
    !/kind: "selection"/.test(controller),
    "不能再产生选区附件（引用替代了它）",
  );

  // 带行号的引用文本本身：单行只写一个行号；含空白的路径把行号写在引号内
  const mention = readFileSync(join(process.cwd(), "src", "shared", "mentions.ts"), "utf8");
  assert.ok(/formatFileMentionWithLines/.test(mention), "带行号的引用有独立实现（供两端共用）");
  const { formatFileMentionWithLines } = await import("../src/shared/mentions");
  assert.strictEqual(
    formatFileMentionWithLines("src/config.ts", { start: 12, end: 40 }),
    "@src/config.ts#L12-L40",
    "GitHub 式锚点：`#` 开头不可能是路径，模型不会把它当路径的一部分",
  );
  assert.strictEqual(formatFileMentionWithLines("src/config.ts", { start: 7, end: 7 }), "@src/config.ts#L7");
  assert.strictEqual(formatFileMentionWithLines("src/config.ts"), "@src/config.ts", "没有行号就是整文件引用");
  assert.strictEqual(
    formatFileMentionWithLines("a b/c.ts", { start: 1, end: 2 }),
    '@"a b/c.ts#L1-L2"',
    "含空白的路径把行号写在引号内，整段仍是一个 token",
  );
  assert.strictEqual(
    /[^"]:[0-9]/.test(formatFileMentionWithLines("src/a.ts", { start: 1, end: 2 }) ?? ""),
    false,
    "不再用编译器的 `:12-40` 写法",
  );
}
console.log("selection: 命令 → 带行号的 `@` 引用 ✓");

console.log("\nselection: all assertions passed");
