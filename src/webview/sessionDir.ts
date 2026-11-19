import type { SessionSummaryView, WorkspaceView } from "../shared/chat";
import { directoryPathKey } from "../shared/workspacePath";

/**
 * 标题右侧的执行目录：只有它与 VS Code 唯一根目录相同时才省略已知目录。
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
  if (!directory) return undefined;
  // `path` 是下次新建目标，可能是外部目录；仅在没有根目录清单的旧帧中沿用锁定语义。
  const soleRoot = workspace.roots
    ? workspace.roots.length === 1 ? workspace.roots[0]?.path : undefined
    : workspace.locked ? workspace.path : undefined;
  return soleRoot && directoryPathKey(directory) === directoryPathKey(soleRoot) ? undefined : directory;
}

/** 标题栏目录的两段展示：末段目录名 + 它所在的路径（**不含**末段）。 */
export interface SessionDirParts {
  /** 目录名（最后一段）。整条路径本身就是一个根时是整条路径。 */
  name: string;
  /** 所在路径：去掉末段；没有上一级（盘根、POSIX 根、UNC 共享根）时是空串。 */
  parent: string;
}

/**
 * 把执行目录拆成「目录名 + 所在路径」两段（用户 2026-10-20 口径）。
 *
 * 界面上读作 `📁 dsh-chat D:\dev`：图标与目录名、目录名与所在路径之间各空一格。
 * 目录名不重复出现在路径里，悬停标题仍给完整路径。根路径没有上一级可写，整条
 * 路径当目录名（`C:\`、`/`、`\\server\share`），不编出一个假的上级。
 */
export function sessionDirParts(path: string): SessionDirParts | undefined {
  const value = (path ?? "").trim();
  if (!value) return undefined;
  const trimmed = value.replace(/[/\\]+$/u, "");
  // 盘根（`C:\`）、POSIX 根（`/`）与 UNC 共享根（`\\server\share`）：整条当名字
  if (!trimmed || /^[A-Za-z]:$/u.test(trimmed) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+$/u.test(trimmed)) {
    return { name: value, parent: "" };
  }
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return { name: trimmed, parent: "" };
  let parent = trimmed.slice(0, cut);
  // 上一级正好是根：把分隔符留在路径里（`/work` → `/`，`C:\work` → `C:\`）
  if (!parent) parent = trimmed[0] as string;
  else if (/^[A-Za-z]:$/u.test(parent)) parent += trimmed[cut];
  return { name: trimmed.slice(cut + 1), parent };
}
