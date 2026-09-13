/**
 * `@` 列表的「返回上一层目录」（`..`）目标计算。
 *
 * 用户 2026-09-14 要求：下钻到某个目录之后，列表顶部给一个回到上一层的入口
 * （纯文本输入框往回删路径段太别扭）。这里钉住「上一层是谁」的算法——
 * 算错了会把用户带到错误的目录，界面上不会有任何报错。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mentionParent } from "../src/webview/mentionNav";

// ---------- 1. 根目录没有上一层 ----------
{
  assert.strictEqual(mentionParent(""), undefined, "空查询 = 工作区根目录");
  assert.strictEqual(mentionParent("src"), undefined, "没有分隔符 = 还在根目录列候选");
  assert.strictEqual(mentionParent("web"), undefined, "正在根目录里打字");
}
console.log("mentionNav: 根目录没有「..」 ✓");

// ---------- 2. 一层层往回 ----------
{
  assert.strictEqual(mentionParent("src/"), "", "src/ 的上一层是根目录（空查询）");
  assert.strictEqual(mentionParent("src/webview/"), "src/", "子目录回到父目录");
  assert.strictEqual(mentionParent("src/webview/components/"), "src/webview/", "深层同理");
  assert.strictEqual(mentionParent("a/b/c/d/"), "a/b/c/");
}
console.log("mentionNav: 逐层回退 ✓");

// ---------- 3. 正在输入某个半截名字时，上一层仍按**当前目录**算 ----------
{
  assert.strictEqual(mentionParent("src/webview/Com"), "src/", "半截名字不影响上一层");
  assert.strictEqual(mentionParent("src/webview"), "", "只打到目录名、没打斜杠：列的是 src 下匹配项 → 上一层是根");
}
console.log("mentionNav: 半截输入下的上一层 ✓");

// ---------- 4. 反斜杠写法（Windows 手输）同样认 ----------
{
  assert.strictEqual(mentionParent("src\\webview\\"), "src\\", "反斜杠分隔符照原样保留");
  assert.strictEqual(mentionParent("src\\"), "", "一层深度的反斜杠写法回到根");
}
console.log("mentionNav: 反斜杠写法 ✓");

// ---------- 5. 结构不变量：`..` 行真的排在候选列表最前面，且不吃「整个目录」按钮 ----------
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /return \[up, \.\.\.items\]/.test(composer),
    "「..」必须排在候选列表**最前**（用户口径：顶部提供返回上一层）",
  );
  assert.ok(
    /const isFolder = !isCommand && row\.kind === "directory" && !isParent/.test(composer),
    "「..」是目录行，但不该带「整个目录」按钮（它不是可载入的目录）",
  );
  assert.ok(
    /if \(file\.parent\) \{/.test(composer),
    "选中「..」要走自己的分支：回到上一层，而不是把 `..` 载入成引用",
  );
}
console.log("mentionNav: 界面接线（列表顶部 + 独立分支） ✓");

console.log("\nmentionNav: all assertions passed");
