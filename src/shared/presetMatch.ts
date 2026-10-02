/**
 * 配置项 `dshChat.agentPreset` 里写的那段字 → 真正要传给服务端的预设 id。
 *
 * **为什么需要这一折**：服务端只按 **id** 查表（`agentPresetRegistry.resolve` 就是
 * `definitions.get(id)`），填一个显示名会得到 `agent-preset/not-found`，`session/create`
 * 整条失败。而界面上给用户看的一直是显示名（内置四个的中英名来自客户端词典，见
 * `webview/presetDisplay.ts`），所以「照着界面上写的名字填」是最自然的用法。
 *
 * 三条口径：
 * - **id 优先**：能与某个 id 精确相等就用它，名字再怎么像也不抢；
 * - 名字取**第一个**命中的：候选顺序就是服务端给的目录顺序。名字不保证唯一（服务端
 *   只对 id 查重，内置四个甚至不发布 `name`），撞名时按目录顺序取第一个，不做消歧、
 *   不额外提示——同名是用户自己能看出来的事；
 * - **认不出就原样返回**：交给服务端回 `agent-preset/not-found`，与「填错一个 id」的
 *   旧行为一致，不在这里编造一个 id 出来。
 */

/** 一个预设参与名字匹配的两样东西：它的身份，以及它可能被写出来的名字。 */
export interface PresetNameCandidate {
  /** 服务端认的身份（`AgentPresetRow.id`）。 */
  readonly id: string;
  /**
   * 可能被用户写进配置项的名字。内置四个给中英两名（它们是客户端词典给的），
   * 自写预设只有作者发布的那一个名字（作者写下的字不翻译）。
   */
  readonly names: readonly string[];
}

/**
 * @param input 配置项里的原文（前后空白忽略）。
 * @param candidates 当前目录（`agentPresets/list` 折出来的那些；空表就是没有可匹配的名字）。
 * @returns 要传给服务端的 id；认不出时是去掉空白后的原文。
 */
export function matchPresetInput(input: string, candidates: readonly PresetNameCandidate[]): string {
  const wanted = input.trim();
  if (!wanted) return "";
  if (candidates.some((candidate) => candidate.id === wanted)) return wanted;
  const hit = candidates.find((candidate) => candidate.names.includes(wanted));
  return hit ? hit.id : wanted;
}
