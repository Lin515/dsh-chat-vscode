import type { AgentPresetOptionView } from "../shared/chat";
import type { Texts } from "./texts";

/**
 * 一个预设该显示成什么名字与描述。
 *
 * **与官方同一套折叠**（`@deepseek-ai/dsh-agent-presets/display` 的
 * `presetDisplayText`，逐字对照）：
 *
 * - `trust === "system"` 且 id 是随产品交付的那四个之一 → 文案由**客户端**按当前
 *   语言给（`Texts` 里那八条，抄的是官方 `dsh-client-ui-agent-preset` 的词典）。
 *   服务端为这几个发布的 `name`/`description` 是**不翻译的**文件元数据，直接用会
 *   在中文界面里显示英文；
 * - 其余（用户自己写的预设、或认不出的 system id）→ 用它自己发布的文案，
 *   没有就用 id。**作者写下的字不翻译**。
 *
 * 抽成纯函数是为了可断言：映射写错（把 ptc 的名字挂到 standard 上）不会报任何错，
 * 界面上只是安静地显示另一个模式的名字。
 */

/** 八个展示文案在 `Texts` 里的键（`BUILT_IN` 只许写这八个）。 */
export type PresetCopyKey =
  | "presetStandardName"
  | "presetStandardDescription"
  | "presetPtcName"
  | "presetPtcDescription"
  | "presetMinimalName"
  | "presetMinimalDescription"
  | "presetCordisName"
  | "presetCordisDescription";

/** id → 那两条文案的键（官方的 `BUILT_IN_PRESET_KEYS` 逐字）。 */
const BUILT_IN: Readonly<Partial<Record<string, { name: PresetCopyKey; description: PresetCopyKey }>>> = {
  standard: { name: "presetStandardName", description: "presetStandardDescription" },
  ptc: { name: "presetPtcName", description: "presetPtcDescription" },
  minimal: { name: "presetMinimalName", description: "presetMinimalDescription" },
  cordis: { name: "presetCordisName", description: "presetCordisDescription" },
};

/** 解析结果（`description` 缺省 = 这个预设没有描述，界面上给替代文案）。 */
export interface PresetDisplayText {
  name: string;
  description?: string;
}

/**
 * @param option roster 的一行（已滤掉坏预设）。
 * @param texts 当前语言的词典。
 * @returns 该行在界面上显示的名字与描述。
 */
export function presetDisplayText(option: AgentPresetOptionView, texts: Texts): PresetDisplayText {
  const keys = option.trust === "system" ? BUILT_IN[option.id] : undefined;
  if (keys !== undefined) {
    return { name: texts[keys.name], description: texts[keys.description] };
  }
  return {
    name: option.name ?? option.id,
    ...(option.description ? { description: option.description } : {}),
  };
}
