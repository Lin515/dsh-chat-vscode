/**
 * 配置项 `dshChat.agentPreset` 认 id 也认显示名（`src/shared/presetMatch.ts`
 * + `src/webview/presetDisplay.ts` 的 `presetMatchNames`）。
 *
 * 为什么值得单独断言：服务端只按 **id** 查表，名字填错时**不会**在编译期或构建期
 * 报任何东西——会话建出来是 `agent-preset/not-found`，用户看到的是「填了没反应」。
 * 这条路径的两个易错处都只能靠断言钉住：
 *
 * 1. 内置四个的名字**不在协议里**（服务端不发 `name`），只能由客户端词典补中英两名；
 *    少给一种语言，就等于「中文界面填中文名不生效」照旧；
 * 2. id 必须**优先于**名字：用户自写一个名字叫 `standard` 的预设时，配置项里写
 *    `standard` 仍然只能落到那个内置 id 上（作者写下的字不翻译，但也不该抢身份）。
 *
 * 同名不做消歧是**刻意的**：名字不保证唯一（服务端只对 id 查重），目录顺序就是
 * 服务端给的顺序，取第一个命中的即可——所以这里把「取第一个」也钉成事实，
 * 免得日后有人改成「随便挑一个」或「报错不干活」。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { matchPresetInput, type PresetNameCandidate } from "../src/shared/presetMatch";
import { presetMatchNames } from "../src/webview/presetDisplay";
import type { AgentPresetOptionView } from "../src/shared/chat";

// ---------- 1. id 精确命中优先 ----------
{
  const candidates: PresetNameCandidate[] = [
    { id: "standard", names: ["标准模式", "Standard mode"] },
    { id: "my-agent", names: ["standard"] },
  ];
  assert.strictEqual(
    matchPresetInput("standard", candidates),
    "standard",
    "id 与别人发布的名字撞上时，id 优先——身份永远压过展示名",
  );
  // 前后空白忽略（配置项里带一个尾空格不该变成 not-found）
  assert.strictEqual(matchPresetInput("  standard  ", candidates), "standard");
  // 没配、或有空白：整个字段都不传（返回空串，调用方据此不传 agentPreset）
  assert.strictEqual(matchPresetInput("", candidates), "");
  assert.strictEqual(matchPresetInput("   ", candidates), "");
}
console.log("presetMatch: id 精确命中优先，空白与空值不指定 ✓");

// ---------- 2. 名字命中：中英两名都认（内置四个的名字来自词典） ----------
{
  const standard: AgentPresetOptionView = { id: "standard", isDefault: true };
  const names = presetMatchNames(standard);
  assert.ok(names.includes("标准模式"), `内置 standard 的中文名要能匹配：${names.join(" / ")}`);
  assert.ok(names.includes("Standard mode"), `内置 standard 的英文名也要能匹配：${names.join(" / ")}`);

  const candidates = [
    { id: "standard", names: presetMatchNames(standard) },
    { id: "ptc", names: presetMatchNames({ id: "ptc" } as AgentPresetOptionView) },
  ];
  assert.strictEqual(matchPresetInput("标准模式", candidates), "standard", "中文名 → id");
  assert.strictEqual(matchPresetInput("Minimal mode", candidates), "Minimal mode", "目录里没有的内置名照样认不出，原样传");
  assert.strictEqual(matchPresetInput("PTC 模式", candidates), "ptc", "另一个内置的中文名");
}
console.log("presetMatch: 内置四个的中英名都能折成 id ✓");

// ---------- 3. 自写预设：用作者发布的原文，中英两侧同值 ----------
{
  const user: AgentPresetOptionView = { id: "my-agent", name: "我的代理" };
  assert.deepStrictEqual(presetMatchNames(user), ["我的代理"], "作者写下的字只有一个候选");
  const candidates: PresetNameCandidate[] = [
    { id: "my-agent", names: presetMatchNames(user) },
  ];
  assert.strictEqual(matchPresetInput("我的代理", candidates), "my-agent");

  // 没发布名字、又认不出是内置的：没有名字可匹配，只能填 id
  assert.deepStrictEqual(presetMatchNames({ id: "in-house" } as AgentPresetOptionView), []);
  assert.strictEqual(matchPresetInput("in-house", candidates), "in-house", "id 仍然认");

  // 老服务端的 trust 仍然权威：trust === "user" 的 standard 用的是它自己的名字，
  // 不套词典（同一个 id 的两种身份不能互相串味）
  const oldUser: AgentPresetOptionView = { id: "standard", trust: "user", name: "My standard" };
  assert.deepStrictEqual(presetMatchNames(oldUser), ["My standard"]);
}
console.log("presetMatch: 自写预设用原文，trust 缺失/为 user 都不套词典 ✓");

// ---------- 4. 同名：取目录里第一个命中的，不做消歧 ----------
{
  const candidates: PresetNameCandidate[] = [
    { id: "first", names: ["同名预设"] },
    { id: "second", names: ["同名预设"] },
  ];
  assert.strictEqual(matchPresetInput("同名预设", candidates), "first", "撞名取目录顺序的第一个");

  // 名字一名都没命中、又不是 id：原样传下去，由服务端回 `agent-preset/not-found`
  assert.strictEqual(matchPresetInput("查无此名", candidates), "查无此名");
  // 目录为空（服务端不允许选择 / 还没拿到）：只有 id 那一路，其余原样传
  assert.strictEqual(matchPresetInput("标准模式", []), "标准模式");
}
console.log("presetMatch: 撞名取第一个，认不出原样传（不编造 id）✓");

console.log("\npresetMatch: all assertions passed");
