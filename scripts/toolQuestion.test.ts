/**
 * `ask_user_question` 的问卷**事实**解析（`src/shared/toolQuestion.ts`）。
 *
 * 为什么单独一层：会话重载之后问卷节点还在不在，全看这两份 durable 材料能不能
 * 折出题目与答案——参数是模型侧形状（多选键是下划线 `multi_select`），结果是
 * `output.render` 的 JSON 文本，两边的形状都只能靠**保守判据**认（认不出来就退回
 * 通用工具行，绝不画半截卡）。`scripts/interactionSync.test.ts` 钉的是适配器里
 * 「记录挂到哪个节点」的生命周期，这里钉解析本身。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import {
  questionAnswersFromResult,
  questionItemsFromArgs,
  questionKeyOf,
} from "../src/shared/toolQuestion";

/** 逐条打印，失败即退出（与本仓库其它断言脚本同一风格）。 */
function check(label: string, run: () => void): void {
  run();
  console.log(`  ✓ ${label}`);
}

// ---------- 1. 题目：真实参数（harness 会话日志里的形状，逐字） ----------
check("真实参数解析出题目（含选项描述与 multi_select → multiSelect）", () => {
  const items = questionItemsFromArgs(
    JSON.stringify({
      questions: [
        {
          id: "color",
          question: "Which color do you prefer?",
          header: "Pick one",
          multi_select: true,
          options: [
            { label: "Blue", description: "A cool recessive hue." },
            { label: "Green" },
          ],
        },
      ],
    }),
  );
  assert.deepStrictEqual(items, [
    {
      id: "color",
      question: "Which color do you prefer?",
      header: "Pick one",
      options: [{ label: "Blue", description: "A cool recessive hue." }, { label: "Green" }],
      multiSelect: true,
    },
  ]);
});

check("没给 options / multi_select 时补成空表、不带 multiSelect 键", () => {
  assert.deepStrictEqual(
    questionItemsFromArgs('{"questions":[{"id":"a","question":"继续吗？"}]}'),
    [{ id: "a", question: "继续吗？", options: [] }],
  );
  // 参数里明说 false 要保留（与「没给」是两回事：单选题与「没说」在卡片上同一形态，
  // 但视图字段必须忠于线格式，否则以后想做三态就只能靠猜）
  assert.deepStrictEqual(questionItemsFromArgs('{"questions":[{"id":"a","question":"q","multi_select":false}]}'), [
    { id: "a", question: "q", options: [], multiSelect: false },
  ]);
});

check("认不出来的参数一律 undefined（退回通用工具行）", () => {
  const cases: [string, string][] = [
    ["空题目数组", '{"questions":[]}'],
    ["questions 不是数组", '{"questions":{}}'],
    ["半截 JSON", '{"questions":[{"id":"a"'],
    ["顶层不是对象", "[1,2,3]"],
    ["空参数", ""],
    ["缺 id", '{"questions":[{"question":"q"}]}'],
    ["id 为空串", '{"questions":[{"id":"","question":"q"}]}'],
    ["id 重复", '{"questions":[{"id":"a","question":"q"},{"id":"a","question":"r"}]}'],
    ["question 不是字符串", '{"questions":[{"id":"a","question":1}]}'],
    ["header 不是字符串", '{"questions":[{"id":"a","question":"q","header":1}]}'],
    ["options 不是数组", '{"questions":[{"id":"a","question":"q","options":{}}]}'],
    ["选项缺 label", '{"questions":[{"id":"a","question":"q","options":[{"description":"d"}]}]}'],
    ["选项 label 为空串", '{"questions":[{"id":"a","question":"q","options":[{"label":""}]}]}'],
    ["选项 description 不是字符串", '{"questions":[{"id":"a","question":"q","options":[{"label":"x","description":1}]}]}'],
    ["multi_select 不是布尔", '{"questions":[{"id":"a","question":"q","multi_select":"yes"}]}'],
  ];
  for (const [label, raw] of cases) {
    assert.strictEqual(questionItemsFromArgs(raw), undefined, label);
  }
});

// ---------- 2. 答案：真实结果正文 ----------
check("真实结果解析出答案（含自定义回答）", () => {
  assert.deepStrictEqual(
    questionAnswersFromResult(
      '{"answers":[{"id":"color","selected":["Blue"],"custom":"Include accessibility notes"},{"id":"notes","selected":[]}]}',
    ),
    {
      color: { selected: ["Blue"], custom: "Include accessibility notes" },
      notes: { selected: [] },
    },
  );
});

check("空 custom 不留键（过线时 undefined 会被丢掉，留空串只会让两边形状对不上）", () => {
  assert.deepStrictEqual(questionAnswersFromResult('{"answers":[{"id":"a","selected":["x"],"custom":""}]}'), {
    a: { selected: ["x"] },
  });
});

check("前后有别的行时按首尾花括号截取兜住", () => {
  assert.deepStrictEqual(
    questionAnswersFromResult('Error: something\n{"answers":[{"id":"a","selected":["x"]}]}\ntail'),
    { a: { selected: ["x"] } },
  );
});

check("认不出来的结果一律 undefined（别的工具返回同形状 JSON 也不能被当成答案）", () => {
  const cases: [string, string][] = [
    ["空文本", ""],
    ["没有花括号", "no json here"],
    ["不是 JSON", "{oops}"],
    ["顶层是数组", '[{"answers":[]}]'],
    ["没有 answers", '{"answers":null}'],
    ["answers 不是数组", '{"answers":{}}'],
    ["空 answers", '{"answers":[]}'],
    ["条目不是对象", '{"answers":["x"]}'],
    ["缺 id", '{"answers":[{"selected":["x"]}]}'],
    ["selected 不是数组", '{"answers":[{"id":"a","selected":"x"}]}'],
    ["selected 里有非字符串", '{"answers":[{"id":"a","selected":[1]}]}'],
    ["custom 不是字符串", '{"answers":[{"id":"a","selected":[],"custom":1}]}'],
    ["同一 id 出现两次", '{"answers":[{"id":"a","selected":["x"]},{"id":"a","selected":["y"]}]}'],
  ];
  for (const [label, raw] of cases) {
    assert.strictEqual(questionAnswersFromResult(raw), undefined, label);
  }
});

// ---------- 3. 身份键：题目 id 集合（与顺序无关） ----------
check("questionKeyOf 与题目顺序无关，且能区分不同集合", () => {
  assert.strictEqual(questionKeyOf([{ id: "b" }, { id: "a" }]), questionKeyOf([{ id: "a" }, { id: "b" }]));
  assert.notStrictEqual(questionKeyOf([{ id: "a" }, { id: "b" }]), questionKeyOf([{ id: "a" }]));
  // 键是 JSON 编码的 id 数组：题目 id 里出现分隔符之类的字符也不会与另一组串味
  // （拼字符串时 `["a","b"]` 与 `["a\u0000b"]` 会撞成同一个键）
  assert.notStrictEqual(questionKeyOf([{ id: "a" }, { id: "b" }]), questionKeyOf([{ id: "a\u0000b" }]));
});

console.log("\ntoolQuestion: all assertions passed");
