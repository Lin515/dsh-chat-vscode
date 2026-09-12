/**
 * 「这个文件有没有可对比的改动」——决定点文件芯片时是开 VS Code 的对比窗口，
 * 还是回落成普通打开。
 *
 * 为什么要在宿主侧自己判定：git 扩展的命令 `git.openChange`（SCM 里的「打开更改」）
 * 对**不在改动清单里的文件是静默无操作**——它内部用 `getSCMResource()` 找资源，
 * 找不到就直接 return，既不报错也不返回失败。所以「点了没反应」是这条命令的默认
 * 表现，靠 try/catch 兜不住，只能先判定。
 *
 * 判定只认**工作区 / 暂存区 / 合并**三组——`getSCMResource()` 正是只查这三组
 * （VS Code 1.137 `extensions/git/dist/main.js`，`workingTreeGroup` /
 * `indexGroup` / `mergeGroup`）。未跟踪文件（模型新建、还没 `git add` 的）在
 * `untrackedGroup` 里，`git.openChange` 对它们同样什么也不做，所以这里**刻意
 * 不算改动**：交给调用方回落成普通打开，至少文件会打开。把未跟踪也算成改动，
 * 换来的是「点了什么也不发生」——比「打开文件而不是对比窗口」糟得多。
 *
 * 纯函数、不引 `vscode`：断言见 `scripts/fileChange.test.ts`。
 */

/** git 扩展 API 里一条改动的**结构**视图（`@types/vscode` 不含 git API）。 */
export interface GitChangeLike {
  readonly uri?: { readonly fsPath?: string };
}

/**
 * git 扩展 API 里 `Repository.state` 的**结构**视图：只取判定用得到的三个清单。
 *
 * 刻意不列 `untrackedChanges`：列了就会有人顺手传进来（见文件头注释）。
 */
export interface GitChangeStateLike {
  readonly workingTreeChanges?: readonly GitChangeLike[];
  readonly indexChanges?: readonly GitChangeLike[];
  readonly mergeChanges?: readonly GitChangeLike[];
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
