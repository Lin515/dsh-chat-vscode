/**
 * 模型弹层搜索栏的过滤规则。
 *
 * 用户口径：模型列表里要有搜索栏，打开弹层就能直接输入过滤。这里钉住「哪些行算命中」，
 * 现场很难逐条回归的部分都在纯函数里：不区分大小写、多个词同时命中、提供商名 / id 也
 * 算命中面、保持目录原有次序、分不出内容的组整组丢掉。
 *
 * 「搜索栏在列表之外」「打开即聚焦」「关闭交还焦点」属于接线与样式，钉在
 * `pickerFocus.test.ts`（同一份结构与样式契约的延续）。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { filterModelGroups, modelQueryTokens, modelRows } from "../src/webview/modelSearch";

const groups = [
  {
    id: "deepseek-official",
    name: "DeepSeek",
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
      { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
    ],
  },
  {
    id: "opencode-go",
    name: "OpenCode",
    models: [
      { id: "glm-5", name: "GLM-5" },
      { id: "qwen-3-coder", name: "Qwen3 Coder" },
    ],
  },
];

/** 过滤结果拍平成「提供商/模型」，断言只关心还看得见哪些行。 */
function visible(query: string): string[] {
  return filterModelGroups(groups, query).flatMap((group) =>
    group.models.map((model) => `${group.id}/${model.id}`),
  );
}

// ---------- 1. 搜索词的切分 ----------

assert.deepStrictEqual(modelQueryTokens("  DeepSeek   V4 "), ["deepseek", "v4"], "去首尾空白、转小写、按空白切词");
assert.deepStrictEqual(modelQueryTokens(""), [], "空串没有词");
assert.deepStrictEqual(modelQueryTokens("   "), [], "只有空白等于没搜索");
// 标点不是分隔符：`v4.1` 必须作为一个词整体去比，否则「搜 v4.1」与「搜 v4 1」会变成两回事
assert.deepStrictEqual(modelQueryTokens("v4.1"), ["v4.1"]);
console.log("modelSearch: 搜索词切分（小写 / 去空白 / 保留标点）✓");

// ---------- 2. 空搜索原样返回整份目录（不复制、不丢组） ----------

assert.strictEqual(filterModelGroups(groups, ""), groups, "空搜索词原样返回目录（同一个数组）");
assert.strictEqual(filterModelGroups(groups, "  "), groups, "只有空白也是空搜索");
assert.deepStrictEqual(visible(""), [
  "deepseek-official/deepseek-v4-pro",
  "deepseek-official/deepseek-v4.1-flash",
  "opencode-go/glm-5",
  "opencode-go/qwen-3-coder",
]);
console.log("modelSearch: 空搜索 / 只有空白都回到整份目录 ✓");

// ---------- 3. 命中面：模型名、模型 id、提供商名、提供商 id，且不区分大小写 ----------

assert.deepStrictEqual(visible("flash"), ["deepseek-official/deepseek-v4.1-flash"], "按模型名子串命中");
assert.deepStrictEqual(visible("qwen-3"), ["opencode-go/qwen-3-coder"], "按模型 id 命中");
assert.deepStrictEqual(
  visible("v4"),
  ["deepseek-official/deepseek-v4-pro", "deepseek-official/deepseek-v4.1-flash"],
  "同一个词可以命中组内多行",
);
// 提供商命中 → 它下面的模型整组留下（用户打的是「OpenCode」，要的是这一家的全部模型）
assert.deepStrictEqual(visible("opencode"), ["opencode-go/glm-5", "opencode-go/qwen-3-coder"]);
assert.deepStrictEqual(visible("official"), ["deepseek-official/deepseek-v4-pro", "deepseek-official/deepseek-v4.1-flash"], "提供商 id 也算命中面");
assert.deepStrictEqual(visible("DEEPSEEK"), visible("deepseek"), "大小写不影响命中");
assert.deepStrictEqual(visible("V4.1"), ["deepseek-official/deepseek-v4.1-flash"], "标点按原样比对，不做归一");
console.log("modelSearch: 名 / id / 提供商四层命中面、大小写不敏感 ✓");

// ---------- 4. 多个词必须同时命中，且次序与分组原样保留 ----------

assert.deepStrictEqual(visible("deepseek flash"), ["deepseek-official/deepseek-v4.1-flash"]);
assert.deepStrictEqual(visible("flash deepseek"), ["deepseek-official/deepseek-v4.1-flash"], "词序不影响结果");
assert.deepStrictEqual(visible("deepseek zzz"), [], "有一个词不命中就整行不命中");
assert.deepStrictEqual(visible("deepseek 5"), [], "词不能拼到两行上去（glm-5 不在 DeepSeek 名下）");

// 分组顺序 = 目录顺序；组内顺序也不重排，键盘导航的扁平序号因此仍与画面同序
const twoGroups = filterModelGroups(groups, "-");
assert.deepStrictEqual(
  twoGroups.map((group) => group.id),
  ["deepseek-official", "opencode-go"],
  "过滤不重排分组",
);
assert.deepStrictEqual(
  twoGroups.flatMap((group) => group.models.map((model) => model.id)),
  ["deepseek-v4-pro", "deepseek-v4.1-flash", "glm-5", "qwen-3-coder"],
  "过滤不重排组内次序",
);
console.log("modelSearch: 多词同时命中、次序原样保留 ✓");

// ---------- 5. 无命中：整组丢掉，不留空分组标题 ----------

assert.deepStrictEqual(filterModelGroups(groups, "zzz"), [], "没有命中时结果为空");
assert.deepStrictEqual(visible("glm"), ["opencode-go/glm-5"], "没命中的 DeepSeek 组整个消失");
console.log("modelSearch: 无命中时不留空组 ✓");

// ---------- 6. 中文（非 ASCII）同样按子串命中 ----------

const localized = [
  {
    id: "local",
    name: "本地模型",
    models: [{ id: "deepseek-local", name: "深度求索·本地版" }],
  },
];
assert.deepStrictEqual(
  filterModelGroups(localized, "本地").flatMap((group) => group.models.map((model) => model.id)),
  ["deepseek-local"],
  "中文名称按子串命中",
);
assert.deepStrictEqual(
  filterModelGroups(localized, "深度求索").flatMap((group) => group.models.map((model) => model.id)),
  ["deepseek-local"],
  "中文模型名按子串命中",
);
console.log("modelSearch: 中文名称同样命中 ✓");

// ---------- 7. 扁平条目：顺序与画面一致，并带上提供商身份 ----------

assert.deepStrictEqual(
  modelRows(groups).map((row) => `${row.providerName}/${row.provider}:${row.model.id}`),
  [
    "DeepSeek/deepseek-official:deepseek-v4-pro",
    "DeepSeek/deepseek-official:deepseek-v4.1-flash",
    "OpenCode/opencode-go:glm-5",
    "OpenCode/opencode-go:qwen-3-coder",
  ],
);
assert.deepStrictEqual(modelRows([]), [], "空目录没有条目");
console.log("modelSearch: 扁平条目（含提供商身份）✓");

console.log("\nmodelSearch: all assertions passed");
