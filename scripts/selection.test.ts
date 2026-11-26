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
import {
  manualDirectoryReference,
  manualFileReference,
  selectionLines,
  selectionPreview,
} from "../src/dsh/selection";

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
  const addToChat = extension.split('registerCommand("dshChat.addToChat",')[1]?.split("registerCommand(")[0];
  assert.ok(addToChat, "添加引用的命令必须注册");
  assert.match(addToChat, /const\s+lines\s*=\s*selectionLines\(editor\.selection\)/,
    "编辑器命令必须从当前选区提取行号");
  assert.match(addToChat,
    /if\s*\(lines\)\s*controller\.addSelection\(source\.filePath,\s*lines\);\s*else\s+void\s+controller\.addFileContext\(source\.filePath\)/,
    "普通文件把**绝对路径**交给控制器，由它按目标会话执行目录折算");
  assert.doesNotMatch(addToChat, /vscode\.workspace\.asRelativePath\s*\(/,
    "多根工作区的 asRelativePath 会带上工作区文件夹名，不能再用来生成引用");
  // 实际的插入与发送在 selectionSend.test.ts 用真控制器验证，这里只钉住编辑器分派。
  assert.match(addToChat, /if\s*\(source\.remoteFile\)\s*\{[\s\S]*?controller\.addRemoteFileContext\(source\.remoteFile,\s*lines\);\s*return;/,
    "只读文档必须把原文件身份与可选行号一起交给控制器，不落入本地文件分支");
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /manualFileReference\(filePath, this\.selectionCwd\(viewId\), lines\)/.test(controller),
    "选区要插成带行号的 `@` 引用，并和自动引用共用按会话执行目录折算的函数",
  );
  assert.ok(
    /manualFileReference\(path, this\.selectionCwd\(viewId\)\)/.test(controller),
    "文件右键也要插成 `@` 引用，同样按会话执行目录折算",
  );
  assert.ok(
    /manualDirectoryReference\(path, this\.selectionCwd\(viewId\)\)/.test(controller),
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

// ---------- 手动引用与自动引用同一条链：目标会话执行目录优先，目录外退绝对路径 ----------
//
// 手动命令的 token 在插入时就得定下来，之后只会跟着草稿走；所以必须按**插入那一刻**
// 目标窗口会话的执行目录折算。多根工作区的 workspace.asRelativePath 会带上工作区
// 文件夹名（demo/src/a.ts），那个拼写不是执行世界路径——按会话目录再解释一次就指到
// <cwd>/demo/src/a.ts。这里钉住「相对优先、绝对兜底、无法表示就不插」三条。
{
  const cwd = "C:/work/demo";
  assert.strictEqual(
    manualFileReference("C:/work/demo/src/a.ts", cwd, { start: 12, end: 40 }),
    "@src/a.ts#L12-L40",
    "执行目录之下折相对路径，与自动引用同一个折算函数",
  );
  assert.strictEqual(
    manualFileReference("C:/work/other/src/a.ts", cwd, { start: 1, end: 2 }),
    "@C:/work/other/src/a.ts#L1-L2",
    "多根工作区的另一个根退回可表示的绝对路径，绝不带工作区文件夹名",
  );
  assert.strictEqual(
    manualFileReference("C:/work/demo/my dir/a.ts", cwd, { start: 1, end: 2 }),
    '@"my dir/a.ts#L1-L2"',
    "目录内的带空格路径仍是引号内的单 token",
  );
  assert.strictEqual(
    manualFileReference("demo/src/a.ts", cwd, { start: 1, end: 2 }),
    undefined,
    "工作区相对拼写不是执行世界路径，不猜它相对谁",
  );
  assert.strictEqual(
    manualFileReference("C:/work/demo/src/a.ts", undefined),
    "@C:/work/demo/src/a.ts",
    "还没有执行目录证据时才按绝对路径引用",
  );
  assert.strictEqual(
    manualDirectoryReference("C:/work/demo/src", cwd),
    "@src/",
    "目录同样按执行目录折算",
  );
  assert.strictEqual(
    manualDirectoryReference("C:/work/other/src", cwd),
    "@C:/work/other/src/",
    "目录在另一个根时退绝对路径并保留结尾斜杠",
  );
}
console.log("selection: 手动引用的折算与回退 ✓");

// ---------- 选区芯片的悬停预览（selectionPreview） ----------
{
  assert.strictEqual(selectionPreview("const x = 1;"), "const x = 1;", "短原文原样保留");
  assert.strictEqual(selectionPreview("  \nconst x = 1;\n"), "const x = 1;", "首尾空白去掉");
  assert.strictEqual(selectionPreview("a\r\nb\r\nc"), "a\nb\nc", "Windows 换行归一成 \\n");
  assert.strictEqual(selectionPreview("    if (x) {\n      return;\n    }"), "    if (x) {\n      return;\n    }", "缩进保留——代码预览丢了缩进就认不出是哪段");
  assert.strictEqual(selectionPreview("x".repeat(500)), `${"x".repeat(400)}…`, "超长截断到 400 字符加省略号");
  assert.strictEqual(selectionPreview("x".repeat(400)), "x".repeat(400), "恰好 400 不截断");
  assert.strictEqual(selectionPreview("   \n  "), "", "只有空白：预览是空串（芯片仍显示，行号还在）");
}
console.log("selection: 选区预览（归一 / 截断 / 保留缩进）✓");

console.log("\nselection: all assertions passed");
