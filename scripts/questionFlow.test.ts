/**
 * 问卷展示口径：一次展开 vs 依次问答（`dshChat.questionBatch`）。
 *
 * 用户 2026-09-14 的口径：题目不超过阈值时保持原来的一次全展开；超过时改成一题
 * 一题（`0` 表示始终全部展开）。判据与「能不能提交」都在这里钉住——这些是纯函数，
 * 界面只做渲染，改坏了不会报错、只会静默改变问答流程。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuestionItemView } from "../src/shared/chat";
import { DEFAULT_QUESTION_BATCH, answeredCount, canSubmit, isAnswered, questionMode } from "../src/webview/questionFlow";

const items: QuestionItemView[] = [
  { id: "q1", question: "一?", options: [{ label: "A" }, { label: "B" }] },
  { id: "q2", question: "二?", options: [{ label: "C" }] },
  { id: "q3", question: "三?", options: [] },
  { id: "q4", question: "四?", options: [{ label: "D" }] },
];

// ---------- 1. 阈值语义：正好等于阈值仍一次展开，多一道就依次问 ----------
{
  assert.strictEqual(questionMode(3, 3), "all", "题目数 == 阈值：一次展开（用户口径是「> 3 才依次问答」）");
  assert.strictEqual(questionMode(4, 3), "stepped", "题目数 > 阈值：依次问答");
  assert.strictEqual(questionMode(1, 3), "all", "只有一道题当然一次展开");
  assert.strictEqual(questionMode(12, 0), "all", "配置 0 = 始终展开全部题目");
  assert.strictEqual(questionMode(12, undefined), "stepped", `缺省阈值是 ${DEFAULT_QUESTION_BATCH}`);
  // 坏值（手写 settings.json 能绕过设置页校验）一律回退默认阈值，不猜意图
  for (const bad of [-1, 2.5, Number.NaN]) {
    assert.strictEqual(
      questionMode(12, bad),
      "stepped",
      `坏值 ${String(bad)} 回退默认阈值（12 > ${DEFAULT_QUESTION_BATCH} → 依次问答）`,
    );
  }
}
console.log("questionFlow: 阈值语义（含 0 与坏值） ✓");

// ---------- 2. 单题作答判据 ----------
{
  assert.strictEqual(isAnswered(["A"], undefined), true, "选中选项即已作答");
  assert.strictEqual(isAnswered([], "  "), false, "只有空白不算作答");
  assert.strictEqual(isAnswered([], "自定义"), true, "自定义回答算作答");
  assert.strictEqual(isAnswered(undefined, undefined), false, "什么都没填");
}
console.log("questionFlow: 单题作答判据 ✓");

// ---------- 3. 提交闸门：整份问卷都要有答案（依次问答时可能是跳着答的） ----------
{
  const all = { q1: ["A"], q2: [], q3: [], q4: [] } as Record<string, string[]>;
  const custom = { q2: "C", q3: "自己写", q4: "D" } as Record<string, string>;
  assert.strictEqual(answeredCount(items, all, custom), 4, "四题都答了");
  assert.strictEqual(canSubmit(items, all, custom), true, "答全了才能提交");

  const missing = { ...all, q4: [] as string[] };
  const missingCustom = { ...custom, q4: "" };
  assert.strictEqual(canSubmit(items, missing, missingCustom), false, "漏一题就不能提交");
  assert.strictEqual(answeredCount(items, missing, missingCustom), 3);
  assert.strictEqual(canSubmit([], {}, {}), false, "没有题目时不该有可提交状态");
}
console.log("questionFlow: 提交闸门覆盖全部题目 ✓");

// ---------- 4. 结构不变量：界面真的按这套口径走 ----------
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(/questionMode\(items\.length, batch\)/.test(rows), "QuestionCard 必须用 questionMode 决定形态");
  assert.ok(
    /canSubmit\(items, effectiveSelected, effectiveCustom\)/.test(rows),
    "提交按钮的可用性走 canSubmit（喂的是「宿主答案 + 本地草稿」折出来的两张表）",
  );
  // 已答完的卡片必须**优先读宿主的 answers**：本地 state 在重挂载 / 另一个窗口答的
  // 情况下是空的，只看它就复现「展开后没有用户的回答」（用户 2026-09-15 报的）
  assert.ok(
    /question\.answers\?\.\[itemId\]\?\.selected/.test(rows) &&
      /question\.answers\?\.\[itemId\]\?\.custom/.test(rows),
    "已答完的问卷要以 question.answers 为准（本地 state 只作回退）",
  );
  assert.ok(
    /if \(!waiting\)[\s\S]{0,400}open=\{expanded\}/.test(rows),
    "已答完的问卷必须默认收缩成一行（可再展开）",
  );
  // 自定义回答与普通选项**同一列表**：它必须是 `.question-option` 那一行，
  // 单选点它时清空已选（互斥），选普通选项时清掉自定义回答（官方 choose/draftCustom）
  assert.ok(
    /className=\{`question-option question-custom\$\{customActive \? " is-selected" : ""\}`\}/.test(rows),
    "自定义回答必须是选项列表里的一行（.question-option.question-custom）",
  );
  assert.ok(
    /if \(!multi\) setCustom\(\(prev\) => \(\{ \.\.\.prev, \[itemId\]: "" \}\)\)/.test(rows),
    "单选：选中普通选项要清掉自定义回答（两者是同一问题的两种答法）",
  );
  assert.ok(
    /if \(!multi\) setSelected\(\(prev\) => \(\{ \.\.\.prev, \[itemId\]: \[\] \}\)\)/.test(rows),
    "单选：写自定义回答 / 点它都要清掉已选选项（互斥）",
  );
  const composer = readFileSync(join(process.cwd(), "src", "webview", "components", "Composer.tsx"), "utf8");
  assert.ok(
    /<QuestionCard question=\{pending\.question\} batch=\{state\.questionBatch\} \/>/.test(composer),
    "待回答的问卷要把宿主下发的阈值传进卡片",
  );
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, { type?: string; minimum?: number; default?: unknown }> } };
  };
  const config = pkg.contributes.configuration.properties["dshChat.questionBatch"];
  assert.ok(config, "package.json 必须有 dshChat.questionBatch 配置项");
  assert.strictEqual(config.type, "integer", "配置项是整数");
  assert.strictEqual(config.minimum, 0, "限定参数 >= 0");
  assert.strictEqual(config.default, DEFAULT_QUESTION_BATCH, "默认值与代码里的缺省阈值一致");
}
console.log("questionFlow: 界面与配置接上了口径 ✓");

console.log("\nquestionFlow: all assertions passed");
