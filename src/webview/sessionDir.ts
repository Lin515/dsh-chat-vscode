import type { SessionSummaryView, WorkspaceView } from "../shared/chat";

/**
 * 会话标题栏上那段工作目录：**显不显示、显示哪一个**，判据只在这一处。
 *
 * 用户 2026-10-10 口径：VS Code **没有打开文件夹**、目录是给 DSH 会话单独设的时，
 * 标题栏要在标题前补上工作目录路径；打开着文件夹时保持原状——那时目录跟随 VS Code，
 * 资源管理器与 VS Code 自己的标题栏已经说明了这件事，界面再写一遍是噪声。
 *
 * 「没有打开文件夹」只认宿主下发的**肯定证据**（`workspace.locked === false`）：
 * 外观态整份缺失（帧还没到）时返回 undefined，界面上什么都不加。
 *
 * 路径取**当前会话的 cwd**——它是会话的创建事实。切到历史里另一条会话时，显示的
 * 必须是那条会话落在哪个目录，而不是「下一个新会话」的目录。拿不到会话 cwd 时
 * （空态还没建壳；子代理会话的摘要是宿主合成的，本来就不带 cwd）退回
 * `workspace.path`，也就是扩展记下的那个目录。
 *
 * 返回空串一律折成 undefined：没有目录就什么都不显示，不拿宿主的 cwd 冒充
 * （与空态页那行目录同一口径）。
 */
export function sessionDirPath(state: {
  workspace?: WorkspaceView;
  session?: SessionSummaryView;
}): string | undefined {
  const workspace = state.workspace;
  if (workspace?.locked !== false) return undefined;
  return state.session?.cwd || workspace.path || undefined;
}
