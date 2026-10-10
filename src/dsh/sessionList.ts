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
 * **历史列表也挡空会话**（服务端的 `blank` 位 = 还没开始过对话）：菜单（`/`、`@`）
 * 会在空态按需建一条这样的会话，露在列表里就是「点一下多一条空会话」（用户
 * 2026-09-22 报的现场）。那条过滤住在 `controller.emitSessionLists`（它要读窗口态与
 * 未读集合），这里的 `visibleSessionCandidates` 只负责对应的 @ 候选那一侧。
 *
 * **发帧那一步还要按窗口收窄**（`visibleForView`）：没有打开文件夹时，每个会话可以
 * 各自选一个工作目录（用户 2026-10-10 口径），历史列表必须跟着**这个窗口当前那条
 * 会话的 cwd**，而不是把本窗口打开过的所有 cwd 并成一份发出去。
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
   * 当前工作区路径（**归一后**）。`undefined` = VS Code 没有打开文件夹，
   * 这时按用户口径（2026-09-15）只显示**未分组**的会话。
   */
  workspacePath?: string;
  /** 服务端工作区注册表里**当前工作区**那条记录的 `sessionIds`。 */
  workspaceSessionIds?: ReadonlySet<string>;
  /** 注册表里**所有**工作区记账的会话 id（判「未分组」用）。 */
  groupedSessionIds: ReadonlySet<string>;
  /** 本窗口**任何已打开域**的 cwd（归一后）。 */
  openCwds: readonly string[];
}

/**
 * 历史会话列表的可见性（用户 2026-09-15 的设计口径）。
 *
 * 1. **打开了文件夹** → 跟随 VS Code，只显示这个工作区的会话；
 * 2. **没有打开文件夹** → 只显示未分组的会话（不属于任何服务端工作区）。
 *
 * 判据按**服务端注册表**而不是自己比较 cwd：`session/list` 的 `SessionSummary`
 * 不带 workspaceId，而「一条会话属于哪个工作区」本身就是注册表说了算（只有
 * `session/create` 带 `workspaceId` 建出来的会话才会被记进去）。两条兜底：
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
    const cwd = normalizePath(row.cwd);
    if (open.includes(cwd)) return true;
    if (scope.workspaceSessionIds?.has(row.sessionId)) return true;
    if (scope.workspacePath !== undefined) return cwd === scope.workspacePath;
    return !scope.groupedSessionIds.has(row.sessionId);
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
}

/**
 * 一个窗口该看见的历史行：在 {@link visibleForWorkspace} 的**全局**结论之上再按窗口收窄。
 *
 * 用户 2026-10-10 口径：没有打开文件夹时，每个会话可以各自选一个工作目录，历史列表
 * 必须跟着**这个窗口当前那条会话的 cwd**——两个面板各开一个目录时，各自的历史里不许
 * 混进对方的会话。
 *
 * 三档，判据都是肯定证据：
 *
 * 1. **打开了文件夹** → 原样放行：目录跟随 VS Code，所有窗口同一份（旧口径不动，
 *    含「任何已打开域的 cwd」那条兜底）；
 * 2. **没打开文件夹、窗口有目录** → 只留 cwd 相同的行（`normalizePath` 是唯一比较口径，
 *    大小写与斜杠写法不同算同一个目录）；
 * 3. **没打开文件夹、窗口没有目录**（空态、还没落壳，或服务端没给这条会话 cwd）→
 *    原样放行 = 按「未分组」列全。**不拿别的目录去猜**：收紧会把「没有文件夹的新窗口
 *    从历史里接回会话」这条路径堵死，而那时本来就没有可隔离的对象。
 *
 * `rows` 应当是全局那一份（`this.sessions`），本函数只做减法——全局那份还要给打开
 * 菜单、空壳复用、running 打底用（见 `controller.refreshSessions`）。返回的数组在
 * 第 1、3 档就是入参本身，调用方不许改它。
 */
export function visibleForView<T extends { cwd?: string }>(
  rows: readonly T[],
  scope: ViewScope,
): readonly T[] {
  if (scope.folderOpen) return rows;
  const cwd = normalizePath(scope.cwd);
  if (!cwd) return rows;
  return rows.filter((row) => normalizePath(row.cwd) === cwd);
}
