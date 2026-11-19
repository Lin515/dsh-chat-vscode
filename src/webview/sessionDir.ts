import type { SessionSummaryView, WorkspaceView } from "../shared/chat";
import { basenameWorkspacePath, directoryPathKey, isWindowsStylePath } from "../shared/workspacePath";

/** 标题目录标签的视图数据；创建目录只有与执行目录不同时才进入详情。 */
export function sessionDirBadge(state: {
  workspace?: WorkspaceView;
  session?: SessionSummaryView;
  workingDirectory?: string;
}): { name: string; directory: string; differentCreationDirectory?: string } | undefined {
  const workspace = state.workspace;
  if (!workspace) return undefined;
  const creation = state.session?.cwd;
  const directory = [state.workingDirectory, creation, workspace.path].find((path) => path?.trim());
  if (!directory) return undefined;
  const key = directoryPathKey(directory);
  const differentCreationDirectory = creation?.trim() && directoryPathKey(creation) !== key ? creation : undefined;
  // workspace.path 是新会话目标，并不一定是 VS Code 根；仅在旧帧没有根清单时沿用 locked。
  const soleRoot = workspace.roots
    ? workspace.roots.length === 1 ? workspace.roots[0]?.path : undefined
    : workspace.locked ? workspace.path : undefined;
  if (soleRoot && key === directoryPathKey(soleRoot) && !differentCreationDirectory) return undefined;

  // POSIX 目录名可以包含反斜杠。盘根和 / 没有末段，保留根的原来拼写。
  const windows = isWindowsStylePath(directory);
  const trimmed = directory.replace(windows ? /[/\\]+$/u : /\/+$/u, "");
  const name = windows
    ? /^[A-Za-z]:$/u.test(trimmed) ? directory : basenameWorkspacePath(trimmed)
    : trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return { name: name || directory, directory, differentCreationDirectory };
}
