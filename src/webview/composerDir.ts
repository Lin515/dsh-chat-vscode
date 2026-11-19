import type { DirectoryOption, WorkspaceView } from "../shared/chat";
import { basenameWorkspacePath, directoryPathKey } from "../shared/workspacePath";

/**
 * 空态页那行工作目录的纯判据（离线可断言，见 `scripts/composerDir.test.ts`）。
 *
 * 目录只在这里改：输入栏不再常驻目录胶囊——已有对话的目录是创建事实，没有可改的入口；
 * 空会话页才是「这条会话将落在哪」真正有用的地方（与 agent 预设同一句理由）。
 *
 * 三种形态：
 * - `roots`：VS Code 打开着文件夹（`roots` 非空）。列出全部根目录作为新会话的预设；
 *   `canPickOther` 不为 false 时再给「选择其他文件夹…」（工作区外目录）；
 * - `pick`：没有打开文件夹、也没选过目录，或用户选过一个可改目录——沿用原来的
 *   系统目录选择器（`pickWorkspace`）；
 * - `locked`：老宿主只给了 `locked` 与 `path`（没有根目录列表）——跟随 VS Code，
 *   静态只读，与旧界面一致；
 * - `disabled`：宿主明确禁用外部目录（`canPickOther === false`）且没有根目录列表。
 *   此时系统选择器同样只能给出工作区外目录，不能退回去发 `pickWorkspace`。
 */

export type WorkspaceDirMode = "roots" | "pick" | "locked" | "disabled";

export interface WorkspaceDirView {
  /** 新会话当前的 cwd（显示在胶囊上）。 */
  path: string;
  /** 胶囊上的目录名（最后一段）；与 `current` 同名时取宿主给的展示名。 */
  name: string;
  /** 工作区的全部根目录（没打开文件夹为空数组）。 */
  roots: readonly DirectoryOption[];
  /** `path` 命中某个根目录时的那一项。 */
  current: DirectoryOption | undefined;
  /** `path` 是否在工作区根目录里（工作区外目录选过之后为 false）。 */
  currentInRoots: boolean;
  mode: WorkspaceDirMode;
  /** 打开着文件夹且宿主没禁用时，给不给「选择其他文件夹…」。 */
  canPickOther: boolean;
}

/**
 * 路径比较键：**与宿主同一份实现**（`shared/workspacePath.ts` 的 `directoryPathKey`）。
 * Windows 形态不区分盘符大小写与斜杠方向，POSIX 保留大小写（且根 `/` 不能归一成空串）。
 */
export const dirKey = directoryPathKey;

/** 目录末段；空路径返回空串（调用方据此决定是否显示占位文案）。 */
function dirName(path: string): string {
  return path ? basenameWorkspacePath(path.replace(/[/\\]+$/u, "")) || path : "";
}

/**
 * 算出空态页目录行的形态。
 *
 * `roots` 非空就一定有入口（即使 `locked` 为真——打开文件夹时宿主本来就把 `locked`
 * 设为 true，那是「跟随 VS Code」而不是「不能换」）；没有根目录列表时才退回旧的
 * `locked` / `pick` 两档，老宿主因此照旧工作。
 */
export function workspaceDirView(workspace?: WorkspaceView): WorkspaceDirView | undefined {
  if (!workspace) return undefined;
  const roots = workspace.roots ?? [];
  const path = workspace.path;
  const current = roots.find((root) => dirKey(root.path) === dirKey(path));
  const name = current?.name || dirName(path);
  if (roots.length > 0) {
    return {
      path,
      name: name || path,
      roots,
      current,
      currentInRoots: current !== undefined,
      mode: "roots",
      // 契约：只有宿主明确说 false 才不给外部目录；缺省（老宿主）按可用处理
      canPickOther: workspace.canPickOther !== false,
    };
  }
  return {
    path,
    name: name || path,
    roots,
    current: path ? { path, name: name || path } : undefined,
    currentInRoots: false,
    // 老宿主（没有 `canPickOther`）保持原来的系统选择器；明确 false 时连它也不能用
    // （宿主禁用外部目录的理由通常同样适用于系统选择器给出的本地路径）。
    mode: workspace.locked ? "locked" : workspace.canPickOther === false ? "disabled" : "pick",
    canPickOther: false,
  };
}
