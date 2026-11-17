import type { ChatState } from "../shared/chat";
import { basenameWorkspacePath } from "../shared/workspacePath";

/**
 * 输入栏「工作目录」胶囊与弹层的纯判据（离线可断言，见 `scripts/composerDir.test.ts`）。
 *
 * 术语见 `CONTEXT.md`：**创建目录**决定会话归属、创建后不可变；**执行目录**是会话当前实际工作的
 * 目录，可以被模型切换。胶囊显示的是**执行目录**（没有就退回创建目录、最后才是窗口目录），
 * 弹层把两者都摆出来；空会话时给出「怎么改」，已有对话只读。
 */

/** 弹层里「更改」那一段的形态。 */
export type DirChangeMode =
  /** 空会话 + 打开着文件夹：在工作区的根目录之间切换，或选一个工作区外的文件夹（换的是新会话的创建目录，不占对话）。 */
  | "switch-root"
  /** 空会话 + 没打开文件夹：沿用空态页那条「选择目录」的系统目录选择器。 */
  | "pick-folder"
  /** 已有对话：只读（目录是创建时定下的事实，扩展没有可用的接口改它）。 */
  | "started"
  /** 没有可改的入口（空会话 + 单个文件夹：目录跟随 VS Code）。 */
  | "none";

export interface ComposerDirView {
  /** 胶囊上的目录名（最后一段）。 */
  name: string;
  /** 当前执行目录的完整路径（胶囊悬停与弹层都显示它）。 */
  path: string;
  /** 创建目录（会话归属）；缺失时为 undefined。 */
  created: string | undefined;
  /** 执行目录与创建目录不同（弹层里要把「已切换」标出来）。 */
  switched: boolean;
  /** 工作区的全部根目录（没打开文件夹为空数组）。 */
  roots: readonly string[];
  mode: DirChangeMode;
}

/** 路径比较键：Windows 形态不区分大小写与斜杠方向，POSIX 保留大小写（与 `sessionDir` 同口径）。 */
export function dirKey(path: string): string {
  const windows = /^[A-Za-z]:[/\\]|^[\\/]{2}/u.test(path);
  const normalized = (windows ? path.replace(/\\/gu, "/") : path).replace(/\/+$/u, "");
  return windows ? normalized.toLowerCase() : normalized;
}

/**
 * 算出胶囊 / 弹层要显示的内容；拿不到任何目录就返回 `undefined`（胶囊整个不出现，
 * 不拿宿主 cwd 冒充）。子代理会话与只读页不给入口：它们没有可用的输入框。
 */
export function composerDirView(
  state: Pick<ChatState, "workspace" | "session" | "workingDirectory" | "messages" | "subagent">,
): ComposerDirView | undefined {
  if (state.subagent) return undefined;
  const created = state.session?.cwd || state.workspace?.path || undefined;
  const path = state.workingDirectory || created;
  if (!path) return undefined;
  const name = basenameWorkspacePath(path.replace(/[/\\]+$/u, "")) || path;
  const roots = state.workspace?.roots ?? [];
  const blank = state.messages.length === 0;
  let mode: DirChangeMode;
  if (!blank) mode = "started";
  else if (roots.length > 0) mode = "switch-root";
  else if (state.workspace && !state.workspace.locked) mode = "pick-folder";
  else mode = "none";
  return {
    name,
    path,
    created,
    switched: created !== undefined && dirKey(created) !== dirKey(path),
    roots,
    mode,
  };
}
