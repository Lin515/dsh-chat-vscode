/**
 * `skill` 工具节点的文本事实：技能名与 SKILL 正文的提取。
 *
 * 用户口径：
 * 1. 技能节点不显示输入参数、不显示「输出」标题，直接显示 SKILL 内容；
 * 2. 技能文件路径只认服务端 `skills/list` 的 `path`，不能按名字拼本机路径。
 *
 * 第 2 条不在本文件里验证（路径由命令目录下发），这里钉住的是「从工具参数认技能名」
 * 与「从结果信封里取正文」两件纯文本事实——两者都不构造路径、不读盘。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import {
  isSkillName,
  skillInstructions,
  skillNameFromArgs,
} from "../src/shared/skill";

// ---------- 技能名 ----------

{
  assert.strictEqual(isSkillName("build"), true);
  assert.strictEqual(isSkillName("dsh-client-ui-ux"), true);
  assert.strictEqual(isSkillName("a1"), true);
  // 空串、大写、空格、路径片段都不是技能名
  assert.strictEqual(isSkillName(""), false);
  assert.strictEqual(isSkillName("Build"), false);
  assert.strictEqual(isSkillName("build skill"), false);
  assert.strictEqual(isSkillName("../build"), false);
  assert.strictEqual(isSkillName("build/../x"), false);
}
console.log("skill: 技能名语法与官方 SKILL_NAME 同形 ✓");

{
  assert.strictEqual(skillNameFromArgs('{"name":"build"}'), "build");
  // 流式期半截 JSON：等下一帧，不猜
  assert.strictEqual(skillNameFromArgs('{"name":"build'), undefined);
  // 不是对象 / 缺字段 / 非字符串 / 不合技能名语法
  assert.strictEqual(skillNameFromArgs("[]"), undefined);
  assert.strictEqual(skillNameFromArgs("{}"), undefined);
  assert.strictEqual(skillNameFromArgs('{"name":42}'), undefined);
  assert.strictEqual(skillNameFromArgs('{"name":"Build"}'), undefined);
  assert.strictEqual(skillNameFromArgs(""), undefined);
}
console.log("skill: 从参数里只认合法技能名，半截参数不猜 ✓");

// ---------- SKILL 正文 ----------

const rendered = [
  '<skill_content name="build">',
  "<skill_resources>",
  "Base directory for this skill: D:/project/.agents/skills/build",
  "</skill_resources>",
  "",
  "<skill_instructions>",
  "# Build",
  "",
  "先读文档，再构建。",
  "</skill_instructions>",
  "</skill_content>",
].join("\n");

{
  assert.strictEqual(
    skillInstructions(rendered),
    "# Build\n\n先读文档，再构建。",
    "只留 <skill_instructions> 里的正文，去掉模型侧信封与资源说明",
  );
  // CRLF 与标签后没有换行也要认
  assert.strictEqual(
    skillInstructions('<skill_instructions>第一行\r\n第二行</skill_instructions>'),
    "第一行\r\n第二行",
  );
  // 没有信封（错误正文 / 旧结果）：原样显示，不丢信息
  assert.strictEqual(skillInstructions("skill 加载失败：unknown"), "skill 加载失败：unknown");
  assert.strictEqual(skillInstructions(""), "");
  assert.strictEqual(skillInstructions("   "), "");
}
console.log("skill: 只展示 SKILL 正文，信封缺失时原样透出 ✓");

console.log("\nskill: all assertions passed");
