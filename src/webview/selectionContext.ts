/**
 * 「编辑器当前选区」芯片的发送拼接口径（纯函数，断言见 `scripts/selectionContext.test.ts`）。
 *
 * 芯片是**发送时**附带的上下文（用户 2026-11-23 口径）：平时不碰草稿，点发送的
 * 那一刻把 `@` 引用 token 追加到正文末尾，发完即清芯片（一次性）。拼接只有一条
 * 规则：正文与 token 之间空一行（token 独占一行），正文为空时直接就是 token——
 * 空白正文 + 附件的场景（只发文件不配话）在发送门那边本来就放行。
 */

/**
 * 把选区引用 token 追加到正文末尾。
 *
 * `draft` 由调用方先 `trim()`（与 `send` 帧同口径）；这里不重复 trim，
 * 保证「同一份草稿拼出的正文」只有一种结果。
 */
export function appendSelectionReference(draft: string, token: string): string {
  return draft === "" ? token : `${draft}\n\n${token}`;
}
