/**
 * `session/list` 行的**可见性**与会话**血缘**。
 *
 * 契约（`dsh-api-session-controller/lib/types/types.d.ts` 的 `SessionSummary`）：
 *
 * ```
 * parentSessionId?: SessionId;   // 分支（fork）与子代理**都会有**
 * origin?: 'subagent';           // 只有子代理有
 * ```
 *
 * 扩展曾经把过滤写成「有 `parentSessionId` 或有 `origin` 就滤掉」，本意是藏起
 * **子代理会话**，结果把**分支出来的会话一起藏了**——用户 2026-09-12 反馈
 * 「创建了分支，但新分支会话不会在会话历史里显示」。判据只能看 `origin`：
 * 实测（`scripts/sessionListProbe.ts`）fork 出来的子会话是
 * `parentSessionId=<源会话>`、`origin=undefined`。
 *
 * 分支会**继承源会话的标题**，所以列表里靠标题前缀区分（`texts.forkedTitle`，
 * 界面读 `parentSessionId`）。这里曾经还算过一份血缘深度用来缩进显示，
 * 用户 2026-09-19 改成「分支和普通会话同级」，深度随之删掉——它唯一的用途就是缩进。
 *
 * 同样的判据也用在 **@ 提及的对话候选**上（用户 2026-09-22 口径：@ 列表不显示
 * 子代理会话）。但候选 RPC（`sessionReferenceResolver/candidates`）的行
 * （`SessionReferenceMentionCandidate`）**不带** `origin`，藏不掉就只能在客户端
 * 拿「已知的子代理会话 id 集合」去对——集合由调用方维护（`controller` 的
 * `subagentSessionIds`），这里只出纯函数。
 *
 * **空壳会话照常进历史列表**（用户 2026-10-17 口径）：它是一条普通可管理行，只多一位
 * `occupied`（正被某个窗口用时锁住；空壳由窗口共享，见用户 2026-11-02 口径），这一位由
 * `controller.groupSessionLists` 现算。挡空会话的只剩 **@ 提及的对话候选**那一侧
 * （`visibleSessionCandidates`）。
 *
 * **发帧那一步还要按窗口收窄**（`visibleForView`）：没有打开文件夹时，每个会话可以
 * 各自选一个工作目录（用户 2026-10-10 口径），历史列表必须跟着**这个窗口当前那条
 * 会话的 cwd**；空态（还没选目录）则只列**未分组**的会话（用户 2026-10-17 口径），
 * 不能把别的窗口打开过的目录里那些**已分组**的会话漏进一个还没选目录的窗口。
 */

import { basenameWorkspacePath, directoryPathKey, isAbsoluteWorkspacePath } from "../shared/workspacePath";
import type { DirectoryOption, HistoryScope } from "../shared/chat";

/** 只藏**子代理**会话；分支（有 parent、`origin` 为空）必须留着。 */
export function visibleSessionRows<T extends { origin?: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.origin !== "subagent");
}

/**
 * @ 提及的「对话候选」里不出现子代理会话（用户 2026-09-22 口径），也不出现**还没开始
 * 对话**的空会话（它们连标题都没有，候选行只能拿会话 id 当名字；判据同历史列表）。
 *
 * 候选行不带 `origin`、也不带 `blank`（见文件头），两种身份都由调用方维护的 id 集合
 * 判断：`session/list` 原始行的 `origin === 'subagent'` 与 `blank` 打底，子代理目录
 * （catalog 事件、RPC 与投影的并入点 `controller.mergeSubagentEntries`）实时补充。
 */
export function visibleSessionCandidates<T extends { sessionId: string }>(
  rows: readonly T[],
  subagentSessionIds: ReadonlySet<string>,
  /** 空会话 id（`SessionSummaryView.blank`，见 controller 的 `blankSessionIds`）。 */
  blankSessionIds: ReadonlySet<string> = new Set(),
): T[] {
  return rows.filter(
    (row) => !subagentSessionIds.has(row.sessionId) && !blankSessionIds.has(row.sessionId),
  );
}

/**
 * 路径归一：比较工作区路径与会话 cwd 时的唯一口径。**不做 realpath**——那要碰磁盘，
 * 而两边的拼写差异只是大小写与斜杠。
 *
 * Windows 形态（盘符 / UNC）统一分隔符并忽略大小写；POSIX 形态**保留大小写**——
 * `/work/A` 与 `/work/a` 在 POSIX 上是两个目录，按主机平台或「多半相同」去合并会
 * 把两条历史错误地并成一条。形态由拼写判定（与 `shared/workspacePath` 同口径），
 * 不读本机平台：远端执行世界的 POSIX 路径在 Windows 宿主上也必须保留大小写。
 */
export function normalizePath(value: string | undefined): string {
  // 唯一实现放在 `shared/workspacePath.ts`：界面与宿主必须用同一个目录身份键
  return directoryPathKey(value);
}

/**
 * Windows 盘符统一成大写（`d:/x` → `D:/x`），其余原样。
 *
 * 盘符在 Windows 上大小写等价，但**给人看**的路径应该是大写盘符（`D:\dev`）——
 * VS Code 以小写盘符打开文件夹（命令行 `code d:\dev`）时 `fsPath` 原样保留小写，
 * 界面照抄就会显示小写。只动开头那个盘符，路径其余部分的大小写是有意义的，不碰。
 */
export function upperDriveLetter(value: string): string {
  return value.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/** 一条会话「该不该出现在本窗口的历史列表里」所需的全部上下文。 */
export interface WorkspaceScope {
  /**
   * 当前工作区路径（**归一后**）。`undefined` = VS Code 没有打开文件夹，这一层**不做
   * 目录 / 分组收窄**（只挡没有 cwd 的行）；按窗口收窄交给 {@link visibleForView}。
   */
  workspacePath?: string;
  /** 服务端工作区注册表里**当前工作区**那条记录的 `sessionIds`。 */
  workspaceSessionIds?: ReadonlySet<string>;
  /** 本窗口**任何已打开域**的 cwd（归一后）。 */
  openCwds: readonly string[];
}

/**
 * 历史会话列表的**全局**可见性（用户 2026-09-15 的设计口径）。
 *
 * 1. **打开了文件夹** → 跟随 VS Code，只显示这个工作区的会话；
 * 2. **没有打开文件夹** → 这一层**不做目录 / 分组收窄**，只挡「没有 cwd」的行。
 *    收窄留到最后那一层（`visibleForView`）：每个窗口可以各自选一个目录，空态又是第三档；
 *    上游先按「未分组」或「已打开域」滤一遍，会把下游真正要用的行提前丢掉——用户刚选
 *    一个目录（那个目录还没有任何已打开域）时，该目录里**已分组**的会话就再也找不回来。
 *
 * 打开了文件夹时判据按**服务端注册表**而不是自己比较 cwd：`session/list` 的
 * `SessionSummary` 不带 workspaceId，而「一条会话属于哪个工作区」本身就是注册表说了算
 * （只有 `session/create` 带 `workspaceId` 建出来的会话才会被记进去）。两条兜底：
 *
 * - 会话 cwd == 当前工作区路径：新会话的 `upsert` 增量可能比这次查询晚到，
 *   只看注册表会让「刚建好的会话」从列表里闪一下；
 * - **任何已打开域**的 cwd：工作区目录与历史会话目录的写法（大小写/分隔符）
 *   可能不一致，恢复窗口时不能因为这点差异把要接回的会话滤掉。
 *
 * 没有 cwd 的会话一律不显示（服务端总会给一个：建会话时必须给 `cwd` 或
 * `workspaceId`；真拿不到时列表里那条也没法 resume）。
 */
export function visibleForWorkspace<T extends { sessionId: string; cwd?: string }>(
  rows: readonly T[],
  scope: WorkspaceScope,
): T[] {
  return workspaceVisible(rows, scope, (row) => row.sessionId, (row) => row.cwd);
}

/**
 * 同一套「打开了文件夹 → 只留本工作区」判据，喂给已经是视图行的列表（键名是 `id`）。
 *
 * `this.sessions` 的旧帧与内部复用判据继续用 `session/list` 原始行（`visibleForWorkspace`），
 * 历史候选镜像则是已经折成 `SessionSummaryView` 的行；两者必须同一条判据，不能各写一份。
 */
export function visibleForWorkspaceViews<T extends { id: string; cwd?: string }>(
  rows: readonly T[],
  scope: WorkspaceScope,
): T[] {
  return workspaceVisible(rows, scope, (row) => row.id, (row) => row.cwd);
}

function workspaceVisible<T>(
  rows: readonly T[],
  scope: WorkspaceScope,
  idOf: (row: T) => string,
  cwdOf: (row: T) => string | undefined,
): T[] {
  const open = scope.openCwds.map(normalizePath);
  return rows.filter((row) => {
    const cwdText = cwdOf(row);
    if (!cwdText) return false;
    // 没有打开文件夹：只挡没有 cwd 的行（收窄见 `visibleForView`，理由见函数头）
    if (scope.workspacePath === undefined) return true;
    const cwd = normalizePath(cwdText);
    if (open.includes(cwd)) return true;
    if (scope.workspaceSessionIds?.has(idOf(row))) return true;
    return cwd === scope.workspacePath;
  });
}

/** 一个**窗口**当前该看见哪些历史行所需的上下文（收窄的输入）。 */
export interface ViewScope {
  /** VS Code 打开了文件夹（目录跟随 VS Code）：所有窗口同一份，不收窄。 */
  folderOpen: boolean;
  /**
   * 这个窗口**当前**的工作目录（原样字符串，不必先归一）：它绑定那条会话的 cwd，
   * 或新会话页上选定的目录。`undefined` = 拿不到目录证据。
   */
  cwd?: string;
  /**
   * 服务端工作区注册表里**所有**工作区记账的会话 id（判「未分组」用）：没有打开文件夹、
   * 窗口也还没有目录时，只列不属于任何工作区的那些行。
   */
  groupedSessionIds: ReadonlySet<string>;
}

/**
 * 一个窗口该看见的历史行：在 {@link visibleForWorkspace} 的**全局**结论之上再按窗口收窄。
 *
 * 用户 2026-10-10 与 2026-10-17 口径：没有打开文件夹时，每个会话可以各自选一个工作目录，
 * 历史列表必须跟着**这个窗口当前那条会话的 cwd**——两个面板各开一个目录时，各自的历史里
 * 不许混进对方的会话；窗口还停在空态（没选目录）时，列的是**未分组**（不属于任何服务端
 * 工作区）的会话，别的窗口打开过的目录里那些已分组的会话不许漏进来。
 *
 * 三档，判据都是肯定证据：
 *
 * 1. **打开了文件夹** → 原样放行：目录跟随 VS Code，所有窗口同一份（旧口径不动，
 *    含「任何已打开域的 cwd」那条兜底，见 `visibleForWorkspace`）；
 * 2. **没打开文件夹、窗口有目录** → 只留 cwd 相同的行（`normalizePath` 是唯一比较口径，
 *    大小写与斜杠写法不同算同一个目录；**不看注册表分组**——用户口径是这个目录下的历史，
 *    注册进工作区的那条会话同样属于这个目录）；
 * 3. **没打开文件夹、窗口没有目录**（空态、还没落壳）→ 只留**未分组**的行（不在任何
 *    工作区注册记录里）。收窄的依据是「目录还没选」这件事本身：已分组的会话属于某个具体
 *    目录，此刻没有证据说明用户想看它。
 *
 * `rows` 应当是全局那一份（`this.sessions`），本函数只做减法——全局那份还要给打开
 * 菜单、空壳复用、running 打底用（见 `controller.refreshSessions`）。返回的数组在
 * 第 1 档就是入参本身，调用方不许改它。
 */
export function visibleForView<T extends { id: string; cwd?: string }>(
  rows: readonly T[],
  scope: ViewScope,
): readonly T[] {
  if (scope.folderOpen) return rows;
  const cwd = normalizePath(scope.cwd);
  if (cwd) return rows.filter((row) => normalizePath(row.cwd) === cwd);
  return rows.filter((row) => !scope.groupedSessionIds.has(row.id));
}

/**
 * 多根工作区里「新会话落在哪个根目录」：返回 `folders` 中被选中那一项的下标。
 *
 * - 没换过（`active` 为空）、只有一个根、或记着的路径已不在工作区里 → 第一个（默认口径）；
 * - 记着的路径还在 `folders` 里 → 它（比较走 `normalizePath`，不区分盘符大小写与尾斜杠）。
 *
 * `folders` 为空时返回 -1（没有打开文件夹）。纯函数：记着哪个根的存取在控制器里。
 */
export function activeRootIndex(folders: readonly string[], active: string | undefined): number {
  if (!folders.length) return -1;
  if (folders.length > 1 && active) {
    const wanted = normalizePath(active);
    const hit = folders.findIndex((folder) => normalizePath(folder) === wanted);
    if (hit >= 0) return hit;
  }
  return 0;
}

/**
 * 逐字段校验界面发来的历史范围。
 *
 * 只认三种已登记的 `kind`；`directory` 必须有非空、无控制字符的**绝对**路径。这里只做
 * 形状校验——「这个目录现在还可选吗」属于控制器，要结合工作区根与当前连接已知目录判断。
 * 未知字段忽略（向前兼容），未知 `kind` / 半截对象整条拒绝。
 */
export function parseHistoryScope(value: unknown): HistoryScope | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "current") return { kind: "current" };
  if (record.kind === "roots") return { kind: "roots" };
  if (record.kind !== "directory") return undefined;
  const path = record.path;
  if (typeof path !== "string" || !path.trim() || /[\u0000-\u001f]/.test(path)) return undefined;
  if (!isAbsoluteWorkspacePath(path)) return undefined;
  return { kind: "directory", path };
}

/** 一个历史范围要看哪些目录所需的上下文。 */
export interface HistoryScopeFilter {
  scope: HistoryScope;
  /** `current` 的目录证据：绑定会话的创建目录 / 本窗预选的新目录。 */
  currentCwd?: string;
  /** VS Code 工作区的全部根目录。 */
  roots: readonly string[];
  /** 服务端工作区注册表里所有记账的会话 id（`current` 无目录时判「未分组」）。 */
  groupedSessionIds: ReadonlySet<string>;
}

/**
 * 按历史范围过滤**完整候选**（`historySessions`，不是按窗口收窄过的 `sessions`）。
 *
 * 三档语义与旧历史列表一致，只是范围更宽：
 *
 * 1. `current`：有目录证据就只留 cwd 相同的行；没有证据时只留未分组行（旧口径）；
 * 2. `roots`：cwd 落在任一工作区根里（多个根取并集）；
 * 3. `directory`：cwd 与指定目录相同。
 *
 * 子代理会话已被上游滤掉；没有 cwd 的行一律不出现（resume 不了）。保持入参顺序，
 * 归档切分与时间顺序由调用方沿用旧规则。返回新数组，不改入参。
 */
export function historyRowsForScope<T extends { id: string; cwd?: string }>(
  rows: readonly T[],
  filter: HistoryScopeFilter,
): T[] {
  const usable = rows.filter((row) => Boolean(row.cwd));
  if (filter.scope.kind === "directory") {
    const wanted = normalizePath(filter.scope.path);
    return usable.filter((row) => normalizePath(row.cwd) === wanted);
  }
  if (filter.scope.kind === "roots") {
    const roots = new Set(filter.roots.map(normalizePath).filter(Boolean));
    if (!roots.size) return [];
    return usable.filter((row) => roots.has(normalizePath(row.cwd)));
  }
  const cwd = normalizePath(filter.currentCwd);
  if (cwd) return usable.filter((row) => normalizePath(row.cwd) === cwd);
  return usable.filter((row) => !filter.groupedSessionIds.has(row.id));
}

/**
 * 「其他目录」候选：当前连接已知会话所属、但不在工作区根里的目录（含已经移出工作区的），
 * 按会话顺序（最近活动优先）去重；`extra` 里的目录（本窗选中的工作区外目录）即使还没有
 * 会话也补在最前。目录名取末段，取不到时退回完整路径。
 */
export function otherHistoryDirectories(
  rows: readonly { cwd?: string }[],
  roots: readonly string[],
  extra: readonly string[] = [],
): DirectoryOption[] {
  const rootKeys = new Set(roots.map(normalizePath).filter(Boolean));
  const seen = new Set<string>();
  const options: DirectoryOption[] = [];
  const add = (path: string): void => {
    const key = normalizePath(path);
    if (!key || rootKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    const name = basenameWorkspacePath(path.replace(/[/\\]+$/, "")) || path;
    options.push({ path, name });
  };
  for (const path of extra) add(path);
  for (const row of rows) {
    if (row.cwd) add(row.cwd);
  }
  return options;
}

/** 这一份历史是否跨了不止一个目录（按归一后的 cwd 去重）。 */
export function historyIsMixed(rows: readonly { cwd?: string }[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.cwd) continue;
    seen.add(normalizePath(row.cwd));
    if (seen.size > 1) return true;
  }
  return false;
}
