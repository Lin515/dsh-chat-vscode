/**
 * 问卷填写草稿表：切会话回来要能找回半填状态，但**只活在 webview 内存里**。
 *
 * 为什么单独钉这张表：草稿的读写点分别在 `QuestionCard` 的挂载与每次填写，真正的
 * 风险不在界面渲染，而在**键**与**淘汰**——键里少了会话 id，两个会话里同名的问卷
 * 会互相串答案；没有上限，长时间反复切会话会让表一直长。这些都只有纯函数能稳定断言。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import {
  MAX_QUESTION_DRAFTS,
  clearAllQuestionDrafts,
  clearQuestionDraft,
  questionDraftKey,
  readQuestionDraft,
  writeQuestionDraft,
  type QuestionDraft,
} from "../src/webview/questionDraft";

const draft = (index = 0): QuestionDraft => ({
  selected: { scope: ["只改入口文件"] },
  custom: { docs: "README 先不动" },
  customChosen: { docs: true },
  index,
});

// ---------- 1. 键：同一张问卷同一把键，换会话 / 换问卷就换键 ----------
{
  clearAllQuestionDrafts();
  const key = questionDraftKey("session-a", "ev-1");
  assert.strictEqual(key, questionDraftKey("session-a", "ev-1"), "同会话同问卷的键必须稳定（切回来才找得到）");
  assert.notStrictEqual(
    key,
    questionDraftKey("session-b", "ev-1"),
    "不同会话里同名的问卷 id 不能共用一把键（否则串答案）",
  );
  assert.notStrictEqual(key, questionDraftKey("session-a", "ev-2"), "同会话的不同问卷各有各的键");
  // 「没有会话 id」（子代理记录等）要落在一个独立分组里，不能与空字符串会话混用
  assert.notStrictEqual(
    questionDraftKey(undefined, "ev-1"),
    questionDraftKey("", "ev-1"),
    "缺省会话与空字符串会话是不同的键",
  );
}
console.log("questionDraft: 键按会话 + 问卷隔离 ✓");

// ---------- 2. 写入 / 读回 / 覆盖 ----------
{
  clearAllQuestionDrafts();
  const key = questionDraftKey("session-a", "ev-1");
  assert.strictEqual(readQuestionDraft(key), undefined, "没写过就是没有，不凭空造空草稿");

  const first = draft(0);
  writeQuestionDraft(key, first);
  assert.deepStrictEqual(readQuestionDraft(key), first, "写进去的原样读回来");

  const second = draft(2);
  writeQuestionDraft(key, second);
  assert.deepStrictEqual(readQuestionDraft(key), second, "同一把键再写是覆盖（最后一次填写为准）");

  clearQuestionDraft(key);
  assert.strictEqual(readQuestionDraft(key), undefined, "收场后清掉");
  clearQuestionDraft(key); // 幂等：重复清不能炸
}
console.log("questionDraft: 写入、覆盖与清理 ✓");

// ---------- 3. 会话隔离：两个会话各自的半填状态互不影响 ----------
{
  clearAllQuestionDrafts();
  const a = questionDraftKey("session-a", "ev-1");
  const b = questionDraftKey("session-b", "ev-1");
  writeQuestionDraft(a, draft(1));
  writeQuestionDraft(b, { ...draft(0), selected: { scope: ["连同配置读取一起收敛"] } });
  assert.deepStrictEqual(readQuestionDraft(a)?.selected, { scope: ["只改入口文件"] }, "会话 a 的草稿没被 b 改写");
  assert.deepStrictEqual(
    readQuestionDraft(b)?.selected,
    { scope: ["连同配置读取一起收敛"] },
    "会话 b 自己的草稿独立保存",
  );
  assert.strictEqual(readQuestionDraft(a)?.index, 1, "依次问答停在第几题同样按会话隔离");
}
console.log("questionDraft: 会话之间互不串答案 ✓");

// ---------- 4. 上限：只留最近的若干份，重写会把旧条目挪到「最新」 ----------
{
  clearAllQuestionDrafts();
  const keys = Array.from({ length: MAX_QUESTION_DRAFTS }, (_, i) => questionDraftKey("session", `ev-${i}`));
  keys.forEach((key, i) => writeQuestionDraft(key, draft(i)));

  // 第一个最旧，先被淘汰；把最新的重写一遍（内容不变）只应更新「最近使用」顺序
  writeQuestionDraft(keys[0], draft(99));
  writeQuestionDraft(questionDraftKey("session", "ev-extra"), draft(100));

  assert.strictEqual(readQuestionDraft(keys[0])?.index, 99, "重写过的条目保留、且内容已更新");
  assert.strictEqual(readQuestionDraft(keys[1]), undefined, "最早的未重写条目先被淘汰");
  assert.ok(readQuestionDraft(questionDraftKey("session", "ev-extra")), "新写入的条目在表里");
  assert.ok(readQuestionDraft(keys[keys.length - 1]) !== undefined, "其它条目照旧在");
}
console.log(`questionDraft: 最多保留 ${MAX_QUESTION_DRAFTS} 份、按写入先后淘汰 ✓`);

clearAllQuestionDrafts();

console.log("\nquestionDraft: all assertions passed");
