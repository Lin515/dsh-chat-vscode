/**
 * `skill` 工具调用的展示事实：加载了哪个技能、结果里哪一段是 SKILL 正文。
 *
 * 只做**文本解析**，不构造路径、不读盘：技能文件路径来自服务端 `skills/list`
 * 的 `path`（文件系统 provider 给绝对 `SKILL.md` 路径，其它 provider 可以省略），
 * 界面只使用那份路径打开文件；缺失路径的技能不给可点击反馈，也不按名字拼本机路径。
 *
 * 工具结果固定是 `renderSkillContent()` 产出的 `<skill_content>` 块：
 *
 * ```text
 * <skill_content name="build">
 * <skill_resources>
 * Base directory for this skill: …
 * </skill_resources>
 *
 * <skill_instructions>
 * …SKILL.md 正文…
 * </skill_instructions>
 * </skill_content>
 * ```
 *
 * 用户在技能节点上要看到的是 `<skill_instructions>` 里的正文，而不是给模型看的
 * 整块信封；信封缺失（出错文本、旧结果）时原样返回，不猜。
 */

import { parseToolArgs } from "./toolCard";

/** 技能名的公开语法（与 `dsh-skill` 的 `SKILL_NAME` 同形）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 技能名是否合法（宿主与界面共用，避免把任意文本当技能名）。 */
export function isSkillName(value: string): boolean {
  return SKILL_NAME.test(value);
}

/**
 * 从一次 `skill` 调用的参数里取技能名。
 *
 * 流式期参数可能是半截 JSON：解析不了、或名字还没长全（不满足技能名语法）时
 * 返回 undefined，等下一帧补全后再给——与 `parseToolArgs` 的容错口径一致。
 */
export function skillNameFromArgs(argsRaw: string): string | undefined {
  const args = parseToolArgs(argsRaw);
  const name = args?.name;
  return typeof name === "string" && isSkillName(name) ? name : undefined;
}

/**
 * 工具结果里的 SKILL 正文。
 *
 * 只取 `<skill_instructions>` 之间那一份；没有这层信封（错误正文、旧结果）时
 * 原样返回整段输出。正文两端空白去掉，内部换行与缩进保持原样。
 */
export function skillInstructions(output: string): string {
  if (!output) return "";
  const match = /<skill_instructions>\r?\n?([\s\S]*?)\r?\n?<\/skill_instructions>/.exec(output);
  return match ? match[1]!.trim() : output.trim();
}
