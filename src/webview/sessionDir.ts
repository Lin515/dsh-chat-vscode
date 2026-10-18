import type { SessionSummaryView, WorkspaceView } from "../shared/chat";

/**
 * 标题前的执行目录：未打开 VS Code 文件夹时始终显示；打开时只显示不同的目录。
 * 投影未到 / 能力缺失时退回创建目录，最后才是窗口目录，不拿宿主 cwd 冒充。
 * 该判据只影响显示，不改变工作区归属、创建目录或历史列表。
 */
export function sessionDirPath(state: {
  workspace?: WorkspaceView;
  session?: SessionSummaryView;
  workingDirectory?: string;
}): string | undefined {
  const workspace = state.workspace;
  if (!workspace) return undefined;
  const directory = state.workingDirectory || state.session?.cwd || workspace.path || undefined;
  if (!directory || (workspace.locked && sameDirectory(directory, workspace.path))) return undefined;
  return directory;
}

/** 只做展示比较：Windows 形态忽略大小写与分隔符差别，POSIX 保留大小写；不猜远端 realpath。 */
function sameDirectory(left: string, right: string): boolean {
  const key = (path: string): string => {
    const windows = /^[A-Za-z]:[/\\]|^[\\/]{2}/u.test(path);
    const normalized = (windows ? path.replace(/\\/gu, "/") : path).replace(/\/+$/u, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  return key(left) === key(right);
}
