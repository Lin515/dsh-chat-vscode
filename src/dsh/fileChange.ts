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
 * 就走 `getSCMResource(e)`）。未跟踪文件没有可对比的基线，所以不标成「有改动」。
 *
 * **未跟踪文件在哪张清单里，取决于 `git.untrackedChanges`**（用户报的
 * 「纯新增文件不标 [new]」的根因）：默认的 `"mixed"` 下 git 扩展把 `??` 文件塞进
 * **工作区清单**，只有显式设成 `"separate"` 才进 `untrackedChanges`（`"hidden"` 直接
 * 丢弃）。本机 VS Code 1.137.0 的 `extensions/git/dist/main.js` 实测，`getStatus()`
 * 里就是这段分流：
 *
 * ```js
 * case "??": switch (r) {                        // r = git.untrackedChanges
 *   case "mixed":    return D.push(…E.UNTRACKED…);  // D = workingTreeGroup
 *   case "separate": return x.push(…E.UNTRACKED…);  // x = untrackedGroup
 *   default:         return;                        // "hidden"：git 压根不报
 * } }
 * ```
 *
 * 所以判「新文件」必须**两条路都认**（见 `isUntracked`）；只查 `untrackedChanges`
 * 会让默认配置下的 [新增] 记号永远不出现。区分它和工作区里的普通改动的唯一依据是
 * `Change.status`（公开 API）：未跟踪 = `Status.UNTRACKED`(7)，改过 = `MODIFIED`(5)。
 *
 * `hasWorkingChange`（= 能不能开对比窗口）**照旧**包含未跟踪条目——它在默认配置下
 * 就在工作区组里，`getSCMResource()` 找得到；而 git 自己对 `UNTRACKED` 解析出的左侧
 * 是空的（`getLeftResource` 对它返回 `{}` → `leftUri` 为 undefined），命令最终执行的
 * 是 `vscode.open`，即**打开文件本身而不是 diff**。也就是说未跟踪文件点下去本来就
 * 会打开文件，[新增] 记号只是把「为什么它和别的芯片不一样」显示出来。
 *
 * 纯函数、不引 `vscode`：断言见 `scripts/fileChange.test.ts`。
 */

import { isAbsolute, join } from "node:path";
import type { FileChangeKind } from "../shared/chat";

/** git 扩展 API 里一条改动的**结构**视图（`@types/vscode` 不含 git API）。 */
export interface GitChangeLike {
  readonly uri?: { readonly fsPath?: string };
  /**
   * 改动种类（公开 API 的 `Change.status`，取值见 `Status` 枚举）。
   *
   * 只为**认出未跟踪**而读：默认配置（`git.untrackedChanges: "mixed"`）下新文件
   * 混在工作区清单里，不看 status 就分不出它是「新建」还是「改过」（见 `isUntracked`）。
   */
  readonly status?: number;
}

/**
 * git 扩展 `Status.UNTRACKED` 的数值。
 *
 * 本机 VS Code 1.137.0 的 `extensions/git/dist/main.js` 实测（冻结的枚举字面量）：
 *
 * ```js
 * E = Object.freeze({ INDEX_MODIFIED:0, INDEX_ADDED:1, INDEX_DELETED:2, INDEX_RENAMED:3,
 *   INDEX_COPIED:4, MODIFIED:5, DELETED:6, UNTRACKED:7, IGNORED:8, INTENT_TO_ADD:9,
 *   INTENT_TO_RENAME:10, TYPE_CHANGED:11, … })
 * ```
 *
 * 与公开 API `Status` 枚举同序。扩展的模块导出里没有 `GitStatus` 这个名字
 * （`getAPI(1)` 只给 API 对象），所以这里按数值判，并把实测值钉在断言里。
 */
const STATUS_UNTRACKED = 7;

/**
 * git 扩展 API 里 `Repository.state` 的**结构**视图：判定用得到的四张清单。
 *
 * `untrackedChanges` 只是「新文件」的**一条**来路（`"separate"` 配置）：默认的
 * `"mixed"` 下新文件在工作区清单里、靠 `status === UNTRACKED` 认出来（见
 * `isUntracked`）。`hasWorkingChange`（= 能不能开对比窗口）仍然只认前三组。
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
 * 该文件在三个改动清单里出现过 → `git.openChange` 找得到它的资源。
 *
 * 判据是**清单名字**，不是「有没有基线」：默认配置下未跟踪文件也在工作区清单里，
 * 所以新文件这里同样返回 true——这是对的，`getSCMResource()` 查的就是这三组、
 * 找得到；只是 git 对 `UNTRACKED` 解析出的左侧为空，最终打开的是文件本身。
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
 * 文件在磁盘上的存在性——**三态**，不是布尔。
 *
 * 为什么不是 boolean：`vscode.workspace.fs.stat` 抛错的原因不止「文件不在」，
 * 还有权限不足、离线共享盘、路径含非法字符、虚拟/远程文件系统不支持……把
 * 「stat 抛错」直接当「不存在」，就会给一个好好的文件画上删除线、还会在点击时
 * 弹出「内容找不回来了」。按本仓库的判据纪律（拿不到证据时**不动**），这些
 * 一律只是 `unknown`：
 *
 * - `present`：stat 成功（肯定证据）；
 * - `absent`：stat 明确报「找不到」（肯定证据，见 `isNotFoundError`）；
 * - `unknown`：其余一切——**不知道**，调用方按「不确定」处理（不标记号、
 *   点击不宣称已删除）。
 */
export type FileExistence = "present" | "absent" | "unknown";

/**
 * 文件芯片的**改动种类**：界面据此标 `[新增]` / 画删除线 / **整条不渲染**。
 *
 * 判定顺序就是语义的优先级：
 * - 明确不在磁盘上（`absent`）且 git 有记录（工作区/暂存/合并/未跟踪任一）→
 *   `deleted`（真被删了；git 有记录只影响「还能不能点开看」）；
 * - 明确不在磁盘上、git **完全不知道**它 → `gone`：本轮「写了又删、净效果为零」
 *   的临时文件（模型提交时写的 `commit.msg.txt` 就是典型）。它不代表任何改动，
 *   界面不渲染这一条；
 * - **未跟踪 → `new`**（两种 `git.untrackedChanges` 配置都认，见 `isUntracked`）：
 *   模型新建的文件没有基线，`git.openChange` 对它最终执行的是打开文件本身；
 *   这一步必须排在 `edited` **前面**——默认配置下新文件就在工作区清单里，
 *   排在后面会被 `hasWorkingChange` 截胡、[新增] 永远不出现（用户报的）；
 * - 在三个改动清单里 → `edited`（git.openChange 能开对比窗口）；
 * - 都不是，或存在性 `unknown` → `undefined`（无改动 / 不在 git 仓库 / 被忽略 /
 *   查不出来）：不标任何记号，点击行为由调用方回落成普通打开。
 *
 * **刻意不算 new 的两种**（它们点下去确实开得出对比窗口，标 [新增] 就自相矛盾）：
 * `git add` 过的（`INDEX_ADDED`）与 `git add -N` 的（`INTENT_TO_ADD`）——它们在
 * 索引里有位子，git 能拿空树当基线给出 diff。
 *
 * @param state git 仓库状态；拿不到（无仓库）时传 undefined。
 * @param fsPath 目标文件的宿主路径。
 * @param existence 文件在磁盘上的存在性（调用方先 stat，见 `FileExistence`）。
 */
export function fileChangeKind(
  state: GitChangeStateLike | undefined,
  fsPath: string,
  existence: FileExistence,
): FileChangeKind | undefined {
  if (!fsPath) return undefined;
  // 查不出来 ≠ 已删除：宁可不标记号，也不要给无辜文件画删除线
  if (existence === "unknown") return undefined;
  if (existence === "absent") return hasGitRecord(state, fsPath) ? "deleted" : "gone";
  if (isUntracked(state, fsPath)) return "new";
  if (hasWorkingChange(state, fsPath)) return "edited";
  return undefined;
}

/**
 * git 是否**知道**这个路径：四张清单里出现过任意一张即可。
 *
 * 用于区分两种「磁盘上没有」：git 有记录（跟踪中的删除 = 仓库里真实的待提交改动）
 * 与 git 完全不知道（这一轮写出来又删掉的临时文件）。没有记录时，删除这件事在
 * 版本库层面**不存在**，界面上列它只会让人以为仓库脏了。
 */
export function hasGitRecord(state: GitChangeStateLike | undefined, fsPath: string): boolean {
  return hasWorkingChange(state, fsPath) || isUntracked(state, fsPath);
}

/**
 * 这个 stat 错误是不是**明确**的「找不到」。
 *
 * `code` 的取值来自本机 VS Code 的实测（`extensionHostProcess.js` 里
 * `FileSystemError` 的构造函数是 `this.code = n?.name ?? "Unknown"`，`n` 传的是
 * 静态工厂函数本身，所以 `code` 正好是 `FileNotFound` / `NoPermissions` /
 * `Unavailable` 这些**方法名**——**不是** `FileSystemError.FileNotFound`，
 * 也不是内部那个 `EntryNotFound`）。`@types/vscode` 只说「names of errors,
 * like FileNotFound」，光看契约会写错，所以这里按实测值判。
 *
 * 其余任何错误（含 `Unknown` / `NoPermissions` / `Unavailable` 与非
 * `FileSystemError` 的异常）都返回 false → 上层退化为 `unknown`。
 */
export function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "FileNotFound";
}

/**
 * 把文件芯片上的路径**解析成可查盘 / 可查 git 的绝对路径**。
 *
 * 芯片上的路径取自工具调用参数（`produced`）或 `present` 申报（`deliverables`），
 * 两者都可能是**相对路径**——模型常写 `src/webview/Composer.tsx` 这种相对会话
 * 工作目录的拼写（本扩展自己发起的 edit / write 调用就是相对路径）。`produced.ts`
 * 刻意保留原样拼写（界面直接显示它），但宿主要拿它去 `vscode.Uri.file` +
 * `workspace.fs.stat` / `getRepository` 时，相对路径会拼出一个**无法解析的
 * URI**：`stat` 抛错 → `existsOnDisk=false` → `fileChangeKind` 误判成
 * `deleted`（明明刚改过的文件被画上删除线——用户报的 Composer.tsx 正是这条）。
 *
 * 规则（按「能不能解析出肯定证据」的优先级）：
 * - 空路径 → undefined（调用方本就不该传空，这里不猜）；
 * - 已是绝对路径 → 原样返回；
 * - 相对路径且有会话工作目录（cwd） → 拼到 cwd 下；
 * - 相对路径但拿不到 cwd → undefined（解析不了 ≠ 已删除：调用方把它当
 *   「不确定」处理——分类退化为无记号、点击放弃打开，而不是误判 deleted）。
 *
 * 纯函数、不引 `vscode`：断言见 `scripts/fileChange.test.ts`。
 *
 * @param cwd 会话工作目录（`session.cwd`）；拿不到时传 undefined。
 * @param path 芯片上的原样路径（绝对或相对）。
 * @returns 可查盘 / 可查 git 的绝对路径；解析不了时 undefined。
 */
export function resolveChipPath(cwd: string | undefined, path: string): string | undefined {
  if (!path) return undefined;
  if (isAbsolute(path)) return path;
  if (!cwd) return undefined;
  return join(cwd, path);
}

/**
 * 该文件是否在 git 眼里的「未跟踪」状态（= 模型新建、还没进过版本库）。
 *
 * **两条来路都要认**，因为 `git.untrackedChanges` 决定了清单往哪儿放（见文件头）：
 *
 * - `untrackedChanges` 清单里有它 —— 用户把该配置设成 `"separate"` 时的口径；
 * - **工作区清单**里有它、且 `status === UNTRACKED` —— 默认 `"mixed"` 时的口径。
 *
 * 只看第一条是原来的写法，症状就是用户报的「纯新增文件不标 [新增]」：默认配置下
 * 那张清单永远是空的，新文件全在工作区清单里。
 *
 * `status` 必须**精确等于** 7：被 `.gitignore` 的文件同样躺在工作区清单里
 * （`IGNORED`(8)）——它在版本库里从来不存在，不是本轮新建，标 [新增] 是撒谎。
 * 拿不到 `status`（旧版本 / 结构变了）时不认，按「不确定」处理（不标记号），
 * 符合本仓库「拿不到证据就不动」的判据纪律。
 */
export function isUntracked(state: GitChangeStateLike | undefined, fsPath: string): boolean {
  if (!state || !fsPath) return false;
  const key = pathKey(fsPath);
  if (!key) return false;
  const listedIn = (list: readonly GitChangeLike[] | undefined, onlyUntracked: boolean): boolean =>
    (list ?? []).some(
      (change) =>
        pathKey(change?.uri?.fsPath ?? "") === key &&
        (!onlyUntracked || change?.status === STATUS_UNTRACKED),
    );
  return listedIn(state.untrackedChanges, false) || listedIn(state.workingTreeChanges, true);
}
