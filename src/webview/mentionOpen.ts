/**
 * 点到一条 `@` 引用之后**做什么**（唯一一份打开动作）。
 *
 * `mentionLinks.ts` 只回答「哪一段文字指向哪个目标」，这里回答「点下去发哪条帧」——
 * 已发出消息里的链接（`components/Message.tsx` 的 `renderMentionText`）与草稿区的
 * Ctrl/Cmd+单击（`components/Composer.tsx`）共用这一份分派，三档目标各一条帧：
 *
 * - 文件 → `openFile`（`link: true`，与正文里助手那条文件链接同口径，见
 *   `components/Markdown.tsx` 的 `openFile`：打不开时的措辞按「正文链接」那一档给）；
 * - 目录 → `revealPath`（宿主在资源管理器里展开它）；
 * - 会话 → `openInEditor` + `sessionId`（宿主**新开一个标签页**打开那条会话；不是
 *   `openSession`——那条会把**当前窗口**切走，点一条引用就换掉正在看的对话太唐突）。
 *
 * 路径与行号一律**原样**交给宿主：相对路径的基准是会话工作目录，只有宿主知道
 * （`controller.openFile` 经 `resolveChipPath` 解析，与文件芯片同一条路）。
 */
import { post } from "./bridge";
import { mentionAt, type MentionLinkTarget } from "./mentionLinks";

/** 按目标种类打开一条引用。 */
export function openMentionTarget(target: MentionLinkTarget): void {
  switch (target.kind) {
    case "file":
      post({ type: "openFile", path: target.path, line: target.line, link: true });
      return;
    case "directory":
      post({ type: "revealPath", path: target.path });
      return;
    case "session":
      post({ type: "openInEditor", sessionId: target.sessionId });
  }
}

/**
 * 草稿区的 Ctrl/Cmd+单击：光标（`selectionStart`）落在哪条引用上就打开哪条。
 *
 * `index` 按 `mentionAt` 的闭区间口径判定——点在 token 最后一个字符的右边缘时
 * 光标落在 `end` 上，那一下显然还是冲着这条引用来的。不可点的段（会话 id 解不开）
 * 不算命中，于是这里**既不发帧也不给提示**。
 *
 * @returns 是否真的打开了。调用方据此决定要不要拦下这一下（当前不拦：光标照旧
 *   落位，不按 Ctrl 时的普通定位行为一个字都不受影响）。
 */
export function openMentionAt(text: string, index: number): boolean {
  const span = mentionAt(text, index);
  if (span?.target === undefined) return false;
  openMentionTarget(span.target);
  return true;
}
