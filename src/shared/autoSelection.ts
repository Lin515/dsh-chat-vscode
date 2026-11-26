/**
 * `dshChat.autoSelection` 的三档口径（评审 2026-11-24 第 7 条）。
 *
 * - `off`：关闭自动引用（手动 `@` 不受影响，芯片永不出现）；
 * - `selection`（默认）：**仅引用选区**——只有真的选中了几行才显示芯片；只有光标
 *   时不显示，明确取消选区后自动撤下，不退回整文件引用；
 * - `file`：允许引用无选区的文件——只有光标时引用整个文件（`@路径`），选中时仍带
 *   行号。仅把焦点移到聊天框不算取消选区（那一档由「来源文件还开着」判据管，
 *   见 `extension.ts` 的快照逻辑）。
 *
 * 旧版本是布尔开关：`true` 的行为即今天的 `file`（选区或整文件），`false` 即
 * `off`。设置类型已改成字符串枚举，但用户 settings.json 里残留的旧值仍按上表
 * 迁移，不让他们被静默改行为。
 */
export type AutoSelectionMode = "off" | "selection" | "file";

/** 读配置用：合法档位原样收下，旧布尔按迁移表翻，其余（未设置 / 拼错）回默认。 */
export function parseAutoSelectionMode(value: unknown): AutoSelectionMode {
  if (value === true) return "file";
  if (value === false) return "off";
  return value === "off" || value === "selection" || value === "file" ? value : "selection";
}
