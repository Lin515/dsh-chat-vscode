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

// ---------- 5. 结构不变量：`..` 排在最前、目录行右侧仍是「整个目录」按钮 ----------
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /return \[up, \.\.\.files, \.\.\.sessions\]/.test(composer),
    "「..」必须排在候选列表**最前**（用户口径：顶部提供返回上一层）",
  );
  assert.ok(
    /return \[\.\.\.files, \.\.\.sessions\]/.test(composer),
    "文件候选在前、对话候选在后（官方 `reference` 源的顺序）",
  );
  assert.ok(
    /const isFolder = !isCommand && !isSession && row\.kind === "directory" && !isParent/.test(composer),
    "「..」是目录行，但不该带「整个目录」按钮（它不是可载入的目录）",
  );
  assert.ok(
    /if \(file\.parent\) \{/.test(composer),
    "选中「..」要走自己的分支：回到上一层，而不是把 `..` 载入成引用",
  );
  // 目录行右侧那个按钮**保持原样**：文案还是「整个目录」，动作用 pick
  // （用户 2026-09-15 的更正：Tab 提示不要占这个位置，按键行为才是要改的）
  assert.ok(
    /title=\{texts\.attachFolder\}[\s\S]{0,220}applyCandidate\(index, "pick"\)/.test(composer),
    "目录行右侧仍是「整个目录」按钮（= pick），不要换成 Tab 徽标",
  );
  assert.ok(
    !/applyCandidate\(index, "drill"\)/.test(composer),
    "行内不该再有「进入目录」的按钮——下钻只由 Tab 触发",
  );
}

// ---------- 6. Tab 提示挂在**文件分组标题栏的最右侧** ----------
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /className="popover-section popover-section-row"/.test(composer),
    "分组标题栏要改成一行布局（左边标题、右边提示）",
  );
  assert.ok(
    /section === texts\.mentionFiles && hasFolderCandidate[\s\S]{0,260}popover-drill-hint/.test(composer),
    "「Tab 进入目录」只挂在**文件组**标题栏的右侧，且只在这一组真有目录时显示",
  );
  assert.ok(
    /hasFolderCandidate = candidates\.some\([\s\S]{0,220}\.parent !== true/.test(composer),
    "判定「有可进入的目录」时要排除 `..`（它是回上一层，Tab 对它没有意义）",
  );
  // 样式：靠右用 spacer，且标题栏的 uppercase 不能把键帽变成 `TAB`
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  assert.ok(
    /\.popover-section-row\s*\{[\s\S]{0,160}display:\s*flex/.test(css),
    "标题栏那一行要 display: flex 才能靠右",
  );
  assert.ok(
    /\.popover-drill-hint\s*\{[\s\S]{0,240}text-transform:\s*none/.test(css),
    "提示不能跟着标题栏 uppercase（`Tab` 会变成 `TAB`）",
  );
  assert.ok(
    /\.popover-item-key\s*\{[\s\S]{0,300}text-transform:\s*none/.test(css),
    "键帽同样要 text-transform: none",
  );
}
console.log("mentionNav: 界面接线（列表顶部 + 整个目录按钮 + 标题栏 Tab 提示） ✓");

// ---------- 7. Tab 进入目录 / Enter 引用整个目录（官方 input-trigger 口径） ----------
//
// 官方 `case "tab"`：`item.drill === true`（目录）才 `pick(..., "drill")`，否则退回普通
// pick；`case "enter"` 永远是普通 pick。扩展此前 Enter 与 Tab 都走同一条（目录默认下钻），
// 与官方相反——用户 2026-09-15 要求对齐。
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /applyCandidate\(highlight, "pick"\)/.test(composer),
    "Enter 必须是普通 pick（目录 = 引用整个目录）",
  );
  assert.ok(
    /applyCandidate\(highlight, "drill"\)/.test(composer),
    "Tab 必须带 drill（进入目录）",
  );
  assert.ok(
    /file\.kind === "directory" && action === "drill"/.test(composer),
    "只有「目录 + drill」才下钻；其余（文件、目录 + pick）一律插入引用",
  );
}
console.log("mentionNav: Tab/Enter 语义（Enter 引用、Tab 进入目录） ✓");

console.log("\nmentionNav: all assertions passed");
