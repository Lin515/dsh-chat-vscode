/**
 * agent 预设展示文案的折叠（`src/webview/presetDisplay.ts`）。
 *
 * 与官方 `@deepseek-ai/dsh-agent-presets/display` 的 `presetDisplayText` **同一套
 * 口径**，这条断言把两半都钉住：
 *
 * 1. 随产品交付的四个 id（`trust === "system"`）走**客户端词典**——服务端给的那几个
 *    `name`/`description` 是不翻译的文件元数据，直接用会在中文界面里显示英文；
 * 2. 其余（用户自己写的、或认不出的 system id）用它自己发布的文案，没有就用 id
 *    ——作者写下的字**不翻译**。
 *
 * 为什么值得单独断言：映射写错（把 ptc 的名字挂到 standard 上）不会报任何错，
 * 界面上只是安静地显示另一个模式的名字；而「官方词典该长什么样」在
 * `scripts/i18n.test.ts` 里查不到（那边只管键与解析，不管**哪一条**对哪个 id）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { presetDisplayText } from "../src/webview/presetDisplay";
import { dictionaryFor } from "../src/webview/texts";
import type { AgentPresetOptionView } from "../src/shared/chat";

const zh = dictionaryFor("zh");
const en = dictionaryFor("en");

// ---------- 1. 随产品交付的四个：名字与描述都来自词典 ----------
{
  // 服务端**也**给了一份 name/description（文件里的元数据，不翻译）：
  // 它必须被忽略，否则中文界面里会出现英文名
  const standard: AgentPresetOptionView = {
    id: "standard",
    trust: "system",
    name: "Standard mode",
    description: "Full coding agent…",
  };
  for (const [texts, expected] of [
    [zh, { name: "标准模式", description: zh.presetStandardDescription }],
    [en, { name: "Standard mode", description: en.presetStandardDescription }],
  ] as const) {
    const text = presetDisplayText(standard, texts);
    assert.strictEqual(text.name, expected.name, `standard 的名字该走词典：${text.name}`);
    assert.strictEqual(text.description, expected.description);
  }

  // id → 文案的映射逐个对拍（错挂会安静地显示另一个模式的名字）
  const cases: [string, string, string][] = [
    ["standard", "标准模式", "Standard mode"],
    ["ptc", "PTC 模式", "PTC mode"],
    ["minimal", "极简模式", "Minimal mode"],
    ["cordis", "创造模式", "Creator mode"],
  ];
  for (const [id, zhName, enName] of cases) {
    const option: AgentPresetOptionView = { id, trust: "system" };
    assert.strictEqual(presetDisplayText(option, zh).name, zhName, `${id} 的中文名`);
    assert.strictEqual(presetDisplayText(option, en).name, enName, `${id} 的英文名`);
    // 描述也必须真的存在（四个都有官方描述）；英文描述不比中文短是常态，不做长度断言
    assert.ok(presetDisplayText(option, zh).description, `${id} 应当有中文描述`);
    assert.ok(presetDisplayText(option, en).description, `${id} 应当有英文描述`);
  }
}
console.log("presetDisplay: 随产品交付的四个走词典（服务端元数据不翻译）✓");

// ---------- 2. 用户自己写的：用原文；认不出的 system id 也退回原文 ----------
{
  const user: AgentPresetOptionView = {
    id: "my-agent",
    trust: "user",
    name: "我的代理",
    description: "只跑测试",
  };
  // 用户写的名字中英两份都一样——**作者写下的字不翻译**
  assert.deepStrictEqual(presetDisplayText(user, zh), { name: "我的代理", description: "只跑测试" });
  assert.deepStrictEqual(presetDisplayText(user, en), { name: "我的代理", description: "只跑测试" });

  // 认不出的 system id（部署自己加的内置预设）：没有词典条目，照样用原文
  const unknownSystem: AgentPresetOptionView = { id: "in-house", trust: "system", name: "In-house" };
  assert.deepStrictEqual(
    presetDisplayText(unknownSystem, zh),
    { name: "In-house" },
    "没有描述时**不带这个键**（不是带一个 undefined）——界面按「有没有」给替代文案",
  );
  // 没有发布名字就用 id（那是唯一还认得出的身份）
  assert.strictEqual(presetDisplayText({ id: "bare", trust: "user" }, zh).name, "bare");
  // trust 缺失（旧服务端 / 别的实现）：**不猜**它是内置的，按原文走
  assert.strictEqual(
    presetDisplayText({ id: "standard", name: "Server name" }, zh).name,
    "Server name",
    "trust 缺失时不该套词典：那会让用户自己写的预设被静默改名",
  );
  // 空描述当「没有描述」（界面给替代文案），不显示一个空行
  assert.deepStrictEqual(presetDisplayText({ id: "x", trust: "user", description: "" }, zh), { name: "x" });
}
console.log("presetDisplay: 用户写的与认不出的走原文，trust 缺失不猜 ✓");

console.log("\npresetDisplay: all assertions passed");
