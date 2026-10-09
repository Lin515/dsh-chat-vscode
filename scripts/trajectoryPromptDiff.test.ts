/**
 * 「系统提示词变更」页签的**行级差分**离线断言（`src/webview/trajectoryPromptDiff.ts`）。
 *
 * 这一层逐字对齐官方 `TrajectoryTable.tsx` 的 `promptDiffLines()`：同一个 `diff` 包、
 * 同一个 `structuredPatch`、同一套 hunk 头拼法。**为什么要单独钉**：差分的边界
 * （哪些行算上下文、hunk 头里的行号、多段之间怎么断）在界面上只能靠手点，而它恰恰是
 * 最容易「看着对了」的一类逻辑——注入一条旧规则（比如把 `context` 改成 0、或把 `\`
 * 那行留下）肉眼看不出，断言看得见。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { promptDiffJsonLines, promptDiffLines } from "../src/webview/trajectoryPromptDiff";

// ---------- 基本形状：hunk 头 + 三行上下文 + 逐行标记 ----------
{
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
  const after = ["a", "b", "c", "d", "X", "f", "g", "h", "i"].join("\n");
  const lines = promptDiffLines(before, after);
  assert.deepStrictEqual(
    lines.map((line) => line.kind),
    ["meta", "context", "context", "context", "removed", "added", "context", "context", "context"],
    "改动那一行前后各留 3 行上下文（官方 structuredPatch 的 context: 3），删除行排在新增行前",
  );
  assert.strictEqual(lines[0]?.text, "@@ -2,7 +2,7 @@", "hunk 头是 `@@ -旧,行数 +新,行数 @@`");
  assert.strictEqual(lines[4]?.text, "-e", "删除行带 `-` 前缀（官方原样保留 patch 的前缀字符）");
  assert.strictEqual(lines[5]?.text, "+X", "新增行带 `+` 前缀");
  assert.strictEqual(lines[1]?.text, " b", "上下文行带前导空格（patch 的原文，不自己补）");
}

// ---------- 两段相同 → 空数组（调用方据此不渲染那一节） ----------
{
  assert.deepStrictEqual(
    promptDiffLines("同一段文本", "同一段文本"),
    [],
    "两段一模一样时没有任何 hunk——官方那一节整节不渲染，不能挂一个空标题",
  );
  assert.deepStrictEqual(promptDiffLines("", ""), [], "都是空串同理");
}

// ---------- 纯新增 / 纯删除 ----------
{
  const added = promptDiffLines("", "第一行\n第二行");
  assert.ok(
    added.every((line) => line.kind === "meta" || line.kind === "added"),
    "从一个空提示词到有内容：全是新增行，没有删除行",
  );
  assert.deepStrictEqual(
    added.filter((line) => line.kind === "added").map((line) => line.text),
    ["+第一行", "+第二行"],
  );
  const removed = promptDiffLines("第一行", "");
  assert.deepStrictEqual(
    removed.filter((line) => line.kind === "removed").map((line) => line.text),
    ["-第一行"],
  );
}

// ---------- 多段 hunk：之间用一条空的 meta 行断开 ----------
{
  const before = Array.from({ length: 40 }, (_, i) => `第 ${i} 行`).join("\n");
  const after = before.replace("第 2 行", "第 2 行（改）").replace("第 35 行", "第 35 行（改）");
  const lines = promptDiffLines(before, after);
  const metas = lines.filter((line) => line.kind === "meta");
  assert.strictEqual(metas.length, 3, "两处相距很远的改动 → 两个 hunk + 一条空的分隔 meta");
  assert.strictEqual(metas[0]?.text.startsWith("@@ -"), true, "第一条 meta 是 hunk 头");
  assert.strictEqual(metas[1]?.text, "", "hunk 之间的分隔是一条空文本的 meta 行");
  assert.strictEqual(metas[2]?.text.startsWith("@@ -"), true, "第二条 meta 是第二个 hunk 头");
}

// ---------- `\ No newline at end of file` 那一行要丢掉 ----------
{
  // 末尾有没有换行的差异会被 diff 标成这行；提示词本来就是整段文本，画出来只是噪声
  const lines = promptDiffLines("a\nb", "a\nb\nc");
  assert.ok(
    lines.every((line) => !line.text.startsWith("\\")),
    "以 `\\` 开头的行（「文件末尾没有换行」记号）一律不出现",
  );
}

// ---------- 工具目录那一节：序列化后逐行比 ----------
{
  const before = [{ name: "read", description: "读文件" }];
  const after = [
    { name: "read", description: "读文件" },
    { name: "grep", description: "搜索" },
  ];
  const lines = promptDiffJsonLines(before, after);
  assert.ok(
    lines.some((line) => line.kind === "added" && line.text.includes('"name": "grep"')),
    "新增的工具落在具体行上（官方对工具目录也是「序列化后逐行比」，不是结构化比较）",
  );
  assert.ok(
    !lines.some((line) => line.kind === "removed" && line.text.includes('"name": "read"')),
    "原有工具没变，不该出现与它有关的删除行",
  );
  assert.deepStrictEqual(
    promptDiffJsonLines(before, before),
    [],
    "目录没变 → 空（界面据此不出「工具」那一节）",
  );
  // JSON 序列化用的是两空格缩进：搜索面上「同一个工具的描述改了」也要落到具体行
  const described = promptDiffJsonLines(
    [{ name: "read", description: "读文件" }],
    [{ name: "read", description: "读文件（先看目录）" }],
  );
  assert.ok(
    described.some((line) => line.kind === "removed" || line.kind === "added"),
    "描述变了也是一处行级改动",
  );
}

console.log("\ntrajectoryPromptDiff: all assertions passed");
