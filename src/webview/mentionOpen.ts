/**
 * 点到一条 `@` 引用之后**做什么**（唯一一份打开动作）。
 *
 * `mentionLinks.ts` 只回答「哪一段文字指向哪个目标」，这里回答「点下去发哪条帧」——
 * 已发出消息里的链接（`components/Message.tsx` 的 `renderMentionText`）与草稿区的
 * Ctrl/Cmd+单击（`components/Composer.tsx`）共用这一份分派，三档目标各一条帧：
 *
 * - 文件 → 按 `FileOpenIntent` 三档：普通 `openFile`（只读虚拟资源）、
 *   `real: true`（Alt，可编辑的真实文件）、`openFileInBrowser`（Ctrl/Cmd + HTML，
 *   原有系统浏览器动作）；
 * - 目录 → `revealPath`（宿主在资源管理器里展开它）；
 * - 会话 → `openInEditor` + `sessionId`（宿主**新开一个标签页**打开那条会话；不是
 *   `openSession`——那条会把**当前窗口**切走，点一条引用就换掉正在看的对话太唐突）。
 *
 * 路径与行号一律**原样**交给宿主：相对路径的基准是会话工作目录，只有宿主知道
 * （`controller.openFile` 经 `resolveChipPath` 解析，与文件芯片同一条路）。
 */
import { post } from "./bridge";
import type { FileOpenIntent } from "./fileLinks";
import { mentionAt, type MentionLinkTarget } from "./mentionLinks";

/**
 * 按目标种类打开一条引用。
 *
 * @param intent 只对文件目标有意义：`"read"` 普通只读、`"real"` Alt 可编辑真实文件、
 *   `"browser"` Ctrl/Cmd + HTML 交系统浏览器。目录 / 会话 / 命令目标忽略它。
 */
export function openMentionTarget(
  target: MentionLinkTarget,
  openCommand?: (name: string) => void,
  intent: FileOpenIntent = "read",
): void {
  switch (target.kind) {
    case "command":
      openCommand?.(target.name);
      return;
    case "file":
      if (intent === "browser") {
        post({ type: "openFileInBrowser", path: target.path });
      } else {
        post({
          type: "openFile",
          path: target.path,
          line: target.line,
          link: true,
          ...(intent === "real" ? { real: true } : {}),
        });
      }
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
 * @returns 是否真的打开了。
 */
export function openMentionAt(text: string, index: number): boolean {
  const span = mentionAt(text, index);
  if (span?.target === undefined) return false;
  openMentionTarget(span.target, undefined, "read");
  return true;
}
