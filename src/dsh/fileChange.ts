/**
 * 「这个文件处于哪种改动状态」——决定点文件芯片时开 VS Code 的对比窗口，
 * 还是回落成普通打开，以及界面上给芯片标什么（[新增] / 删除线）。
 *
 * 为什么要在宿主侧自己判定：git 扩展的命令 `git.openChange`（SCM 里的「打开更改」）
 * 对**不在改动清单里的文件是静默无操作**——它内部用 `getSCMResource()` 找资源，
 * 找不到就直接 return，既不报错也不返回失败。所以「点了没反应」是这条命令的默认
 * 表现，靠 try/catch 兜不住，只能先判定。
 *
 * 「有没有改动」只认**工作区 / 暂存区 / 合并**三组——`getSCMResource()` 正是只查
 * 这三组（本机 VS Code 的 `extensions/git/dist/main.js` 实测，`openChange(e)` 一进来
 * 就走 `getSCMResource(e)`）。未跟踪文件在 `untrackedGroup` 里，`git.openChange` 对
 * 它们同样什么也不做，所以这里**刻意不算改动**：未跟踪 = 模型新建的文件 = 没有可
 * 对比的基线，调用方按「新文件」回落成普通打开——至少文件会打开。
 *
 * `untrackedChanges` 在公开 API（`RepositoryState`）上存在（git 扩展 dist/main.js
 * 的 ApiRepository 有 `get untrackedChanges()`），但它**只用于分类**（标 [新文件]），
 * 不进 `hasWorkingChange` 的判定——那条边界不能动。
 *
 * 纯函数、不引 `vscode`：断言见 `scripts/fileChange.test.ts`。
 */

import type { FileChangeKind } from "../shared/chat";

/** git 扩展 API 里一条改动的**结构**视图（`@types/vscode` 不含 git API）。 */
export interface GitChangeLike {
  readonly uri?: { readonly fsPath?: string };
}

/**
 * git 扩展 API 里 `Repository.state` 的**结构**视图：判定用得到的四个清单。
 *
 * `untrackedChanges` 只给分类（`fileChangeKind` 认「新文件」）用；
 * `hasWorkingChange`（= 能不能开对比窗口）仍然只认前三组。
 */
export interface GitChangeStateLike {
  readonly workingTreeChanges?: readonly GitChangeLike[];
  readonly indexChanges?: readonly GitChangeLike[];
  readonly mergeChanges?: readonly GitChangeLike[];
  readonly untrackedChanges?: readonly GitChangeLike[];
}

/**
 * 比较用的路径键：分隔符统一成 `/`、去掉结尾分隔符、统一小写。
 *
 * 同一个文件在两处可能写成 `D:\dev\app\src\a.ts` 与 `d:/dev/app/src/a.ts`
 * （改动清单里的路径来自 git，芯片上的路径来自工具调用参数，写法不保证一致），
 * 直接按字符串比会漏判 → 又变回「点了没反应」。
 *
 * Windows 与 macOS 的文件系统不区分大小写，统一小写只会**更宽松**一点：最坏
 * 情况是把「仅大小写不同的兄弟文件」认成改动文件，代价是对比窗口里显示的是那个
 * 兄弟文件——比漏判轻。
 */
function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 该文件在三个改动清单里出现过 → 有可对比的改动。
 *
 * @param state git 仓库状态（`api.getRepository(uri)?.state`）；拿不到时传 undefined。
 * @param fsPath 目标文件的宿主路径。
 */
export function hasWorkingChange(state: GitChangeStateLike | undefined, fsPath: string): boolean {
  if (!state || !fsPath) return false;
  const key = pathKey(fsPath);
  if (!key) return false;
  const lists = [state.workingTreeChanges, state.indexChanges, state.mergeChanges];
  return lists.some((list) =>
    (list ?? []).some((change) => pathKey(change?.uri?.fsPath ?? "") === key),
  );
}

/**
 * 文件芯片的**改动种类**：界面据此标 `[新增]` / 画删除线，宿主据此决定点击行为。
 *
 * 判定顺序就是语义的优先级：
 * - 文件在磁盘上不存在 → `deleted`（被删了；git 有没有记录只影响「还能不能点开看」）；
 * - 在三个改动清单里 → `edited`（git.openChange 能开对比窗口）；
 * - 在未跟踪清单里 → `new`（模型新建的文件，没有基线可比，点开就是看文件）；
 * - 都不是 → `undefined`（无改动 / 不在 git 仓库 / 被忽略）：不标任何记号，
 *   点击行为由调用方回落成普通打开。
 *
 * @param state git 仓库状态；拿不到（无仓库）时传 undefined。
 * @param fsPath 目标文件的宿主路径。
 * @param existsOnDisk 文件当前是否存在于磁盘（调用方先 `fs.stat`）。
 */
export function fileChangeKind(
  state: GitChangeStateLike | undefined,
  fsPath: string,
  existsOnDisk: boolean,
): FileChangeKind | undefined {
  if (!fsPath) return undefined;
  if (!existsOnDisk) return "deleted";
  if (hasWorkingChange(state, fsPath)) return "edited";
  if (isUntracked(state, fsPath)) return "new";
  return undefined;
}

/** 该文件是否在 git 的未跟踪清单里（= 模型新建、还没进过版本库）。 */
export function isUntracked(state: GitChangeStateLike | undefined, fsPath: string): boolean {
  if (!state || !fsPath) return false;
  const key = pathKey(fsPath);
  if (!key) return false;
  return (state.untrackedChanges ?? []).some(
    (change) => pathKey(change?.uri?.fsPath ?? "") === key,
  );
}
