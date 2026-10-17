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
 * `occupied`（被会话窗口拿着时锁住），占用位由 `controller.groupSessionLists` 现算。
 * 挡空会话的只剩 **@ 提及的对话候选**那一侧（`visibleSessionCandidates`）。
 *
 * **发帧那一步还要按窗口收窄**（`visibleForView`）：没有打开文件夹时，每个会话可以
 * 各自选一个工作目录（用户 2026-10-10 口径），历史列表必须跟着**这个窗口当前那条
 * 会话的 cwd**；空态（还没选目录）则只列**未分组**的会话（用户 2026-10-17 口径），
 * 不能把别的窗口打开过的目录里那些**已分组**的会话漏进一个还没选目录的窗口。
 */

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
 * 路径归一：比较工作区路径与会话 cwd 时的唯一口径（Windows 大小写不敏感、
 * 分隔符混用）。**不做 realpath**——那要碰磁盘，而两边的拼写差异只是大小写与斜杠。
 */
export function normalizePath(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
  const open = scope.openCwds.map(normalizePath);
  return rows.filter((row) => {
    if (!row.cwd) return false;
    // 没有打开文件夹：只挡没有 cwd 的行（收窄见 `visibleForView`，理由见函数头）
    if (scope.workspacePath === undefined) return true;
    const cwd = normalizePath(row.cwd);
    if (open.includes(cwd)) return true;
    if (scope.workspaceSessionIds?.has(row.sessionId)) return true;
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
