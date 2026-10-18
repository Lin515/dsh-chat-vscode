/**
 * `@` 候选里**目录列举**那一路的本地补全（宿主侧，Node 文件系统）。
 *
 * 两件事住在这里：
 *
 * 1. **工作区内的目录列举补全**：服务器一次查询最多回
 *    `DEFAULT_FILE_SEARCH_MAX_RESULTS`（20）条，而官方 `WorkspaceFileSearch.list()` 在
 *    「查询为空串或以 `/` 结尾」时走 `listDirectory` —— 目录列举**同样**过
 *    `rankCandidates(..., maxResults)`，也被截到 20 条。`maxResults` 是 dsh 插件的**配置**
 *    （`LocalFileReferenceService.Config`），不是请求参数：扩展侧只能发 `{ agentId, query }`，
 *    多要不到任何东西。于是「一个目录里文件多一点，`@` 列表就只有前 20 条」——用户
 *    2026-10-10 报的「显示不全，像有个上限值」。本模块把被截掉的尾巴**按同一套语义**
 *    补回来（不重排服务器那 20 条，只往后追加）。
 * 2. **工作区外的发现**（见 `docs/design-mentions.md`「工作区外的发现范围」，M1 / M3）：
 *    信任门（`localAccess.ts` 的 `LocalAccessGate`）通过时，绝对路径与含 `..` 段的相对
 *    查询由本模块自己出清单。越界这一侧**服务器恒为空**（任何含 `/` 的查询都走官方
 *    `resolveDisplayDirectory` 的越界拒绝），所以两份规则不同的清单不会同时存在。
 *
 * 排序与筛选：
 *
 * - **目录列举**（筛选词为空）：官方 `scoreCandidate` 对空查询第一行就返回 0，排序退化成
 *   「目录在前、文件在后」（`kindRank`）再按 path 的**原始 code-unit** 比较（`compareText`
 *   用的是 `<` / `>`，不是 locale 比较）。**没有**长度那一档。
 * - **筛选词查询**（`@D:/dev/other/no`、`@../no`）：本地列目录后按官方 `scoreCandidate`
 *   的**档位顺序近似**筛选——完全相等 > 名字前缀 > 名字包含 > 路径包含 > 子序列；同档内
 *   目录优先、再 code-unit（见 {@link outsideRank}）。与官方的差别是子序列档内没有 gap
 *   分数（次序可能不同）且没有 `query === ''` 的短路。**只作用于越界侧**。
 * - 名字以 `.` 开头的条目跳过（与官方 `!fragment.startsWith('.')` 同判据，所以筛选词本身
 *   以 `.` 开头时照列）；名字命中 `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` 的目录跳过；
 *   目录路径（前缀）的任一段命中时服务器直接回空表，这里也**不补**——否则会把服务器刻意
 *   隐掉的目录（`node_modules` / `.git` 之类）又捞回列表。**要引用具体路径仍然可以**：
 *   把完整路径打全，`mentionResolves` 判「能引用」、列表不弹。
 * - 候选路径一律用正斜杠、目录行**不带**结尾斜杠（界面侧再补，见 `shared/mentions.ts`
 *   的 `formatFileMention`）；越界侧的前缀就是查询里那个目录（绝对或 `../`）。
 *
 * 路径解析（越界侧的 `resolveListingDirectory`）：绝对形态直接当列举根（不做 `relative()`
 * 包含判据，绝对形态天然可跨卷），相对且无 `..` 段仍是工作区内那条逐段检查，相对且含
 * `..` 段允许越出 cwd。**三条都逐段 `lstat`、都拒绝符号链接段**：不跟随目录链接段
 * （跟随会把列举引到网络位置或链接环上），且绝不用 `path.resolve` 先把 `link/..` 吃掉
 * ——那会让待检查的段消失。相对形态退到盘根就停（`path.resolve` 语义），要列盘根以上的
 * 东西只能改用绝对形态。不支持的根 / 盘符形态（Windows 上的单根相对 `/foo/`、驱动器
 * 相对 `D:foo/`、设备命名空间与不完整 UNC）在 `listingTarget` 就判假，三条路都不走
 * （见 `localAccess.unsupportedLocalPathForm`）。
 *
 * 任何失败（目录不存在 / 不可读 / 权限 / 断链 / 超时 / 查询已作废）一律静默回退空表：
 * `@` 列表宁可少几条，也绝不能变空或把错误抛上去。Windows 宿主的 UNC 与映射盘只在用户
 * 显式输入时访问，不扫描网络邻居。
 */
import { posix, win32 } from "node:path";
import {
  hostPlatform,
  isNativeAbsolutePath,
  nodeFsProbe,
  unsupportedLocalPathForm,
  withinBudget,
  LocalFsBudget,
  type FsProbe,
  type HostPlatform,
} from "./localAccess";

/** 一条候选（与 `fileReferences/list` 的线格式同形，界面侧叫 `FileRefView`）。 */
export interface FileRefEntry {
  path: string;
  kind: "file" | "directory";
}

/**
 * 一次补全最多追加多少条。
 *
 * 这是**兜底**、不是界面口径：界面自己另有一道更小的渲染上限（`composerCompletion.tsx`
 * 的 `CANDIDATE_LIST_LIMIT`，200 行），这里防的是「一个几万条的目录把整份列举塞进一帧」
 * ——服务器那边只回 20 条，一帧的体积从来不是问题，是我们把尾巴补回来之后才需要有个界。
 * 1000 条路径约几十 KB，已经远超界面能渲染的量；真要在几万条的目录里找文件，靠的是再敲
 * 一个字符转全局模糊查询，不是翻列表。服务器已经返回的那几条不受这里影响（我们只截自己
 * 补的尾巴）。上限在**筛选与排序之后**才收：先截断后过滤会丢掉本该匹配的条目。
 */
export const MAX_COMPLETED_ENTRIES = 1000;

/**
 * 官方 `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` 的逐字副本。
 *
 * 为什么要抄一份：这个常量活在 dsh 插件的包里（`file-reference-local`），本扩展不能
 * 依赖它的运行时；而这里的枚举必须与服务器**同一条**排除口径，否则会把服务器刻意
 * 隐掉的目录（`node_modules` / `dist` 之类）当成「被截掉的尾巴」补回列表。
 * 对齐基准与版本追踪口径见 `docs/dsh-compat.md`。
 *
 * 已知边界：用户在 dsh 部署里改过 `excludedDirectories`（增删）时，这份副本不知道——
 * 它带来的偏差只会是「多列出几个目录」，绝不会少列或改序（服务器已经回来的那几条
 * 一条不动）。要精确对齐得去读 dsh 的部署配置，不值得为它把补全停下来。
 */
export const EXCLUDED_DIRECTORY_NAMES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
];

/** 越界列举的三条路（见文件头）；工作区内的工作区根目录是 `inside` + 空前缀。 */
export type ListingScope = "inside" | "absolute" | "up";

/** 这次查询要列哪一层（外加筛选词）。 */
export interface ListingTarget {
  scope: ListingScope;
  /**
   * 列举根：`inside` / `up` 是**相对 cwd 的展示路径**（`/` 归一、带结尾斜杠）；
   * `absolute` 是宿主原生绝对路径。
   */
  directory: string;
  /** 候选路径前缀（`/` 归一、目录带尾斜杠；工作区根目录是空串）。 */
  prefix: string;
  /** 最后的筛选词；`inside` 这条路只有空串才是目录列举。 */
  fragment: string;
}

/**
 * 这次查询要列哪个目录、筛什么词，以及属于哪条路。
 *
 * 判据与官方 `list()` 同源：先做 `\` → `/` 归一，然后
 * - 空串 ⇒ 工作区根目录；
 * - **盘符裸写**（`@D:`）⇒ 按 `D:/`（盘根）列举：不这样归一，用户得到的是一句误导性的
 *   「没有匹配的文件」。只有 Windows 形态才有盘符；
 * - 有 `/` 且以它结尾 ⇒ 列那一段目录（绝对 / 含 `..` 段 / 工作区内三种，见 `scope`）；
 * - 其余是**带筛选词**的查询：工作区内由服务器按 fuzzy 分数排（返回 `undefined`，本地不
 *   复现不同序的清单）；越界侧由本地按 {@link outsideRank} 近似。
 *
 * 按**肯定证据**写：返回 `undefined` 表示「这次不由本地补」，调用方什么都不做。
 */
export function listingTarget(
  query: string,
  platform: HostPlatform = hostPlatform(),
): ListingTarget | undefined {
  const normalized = (query ?? "").replaceAll("\\", "/");
  if (normalized === "") return { scope: "inside", directory: "", prefix: "", fragment: "" };
  if (platform === "win32" && /^[A-Za-z]:$/u.test(normalized)) {
    const root = `${normalized}/`;
    return { scope: "absolute", directory: root, prefix: root, fragment: "" };
  }
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return undefined;
  const fragment = normalized.slice(slash + 1);
  const directory = normalized.slice(0, slash + 1);
  if (isNativeAbsolutePath(directory, platform)) {
    return { scope: "absolute", directory, prefix: directory, fragment };
  }
  // 不支持的根 / 盘符形态（单根相对 `/foo/`、驱动器相对 `D:foo/`、设备命名空间、
  // 不完整的 UNC `//server/`）：**三条路一条都不走**。
  //
  // 放它们进 `inside` / `up` 会得到两种错误解释：`win32.resolve` 把 `/foo/` 接到当前盘
  // 根、把 `D:foo/` 接到 D 盘当前目录；另一种情况是 cwd 恰好有同名祖先时，`/foo/` 被
  // 当成 `cwd/foo` 列出一份根本不是用户指的那一层的清单。这里是纯字符串判据，所以
  // 「一次 FS 调用都不发」——「不探测未输入的共享」也在这一层成立。
  if (unsupportedLocalPathForm(directory, platform)) return undefined;
  if (directory.split("/").some((segment) => segment === "..")) {
    return { scope: "up", directory, prefix: directory, fragment };
  }
  // 相对、无 `..` 段：只有目录列举（筛选词为空）由本地补；带筛选词那一半是服务器的
  // 模糊搜索语义，本地复现不出来（见文件头）
  if (fragment !== "") return undefined;
  return { scope: "inside", directory, prefix: directory, fragment: "" };
}

/**
 * 列出 `query` 这个目录里**服务器没返回**的条目（按官方顺序，已去重）。
 *
 * @param options.cwd 会话的**工作目录**（服务器那次查询的根；它不一定是 VS Code 打开的
 *                    文件夹——`@` 引用按会话的 cwd 列，见官方 `list()` 的
 *                    `agent.session.header.cwd`）。
 * @param options.query 这次 `@` 的查询串（未归一）。
 * @param options.known 服务器已经返回的条目：一条不动，只在它们之后追加。
 * @param options.budget 本次查询的本地 FS 预算（与信任门共用一条，见 `localAccess.ts`）。
 * @param options.outsideAllowed 信任门是否通过；**不通过时越界（绝对 / 含 `..` 段）一律
 *                    不参与**——那种部署下本机列出的东西不能保证执行世界读得到。
 * @param options.platform / options.fs 测试注入（形态与 FS）。
 * @returns 要追加在服务器结果之后的条目；不由本地补、或任何一步失败时是空表。
 */
export async function missingDirectoryEntries(options: {
  cwd: string;
  query: string;
  known: readonly FileRefEntry[];
  budget?: LocalFsBudget;
  outsideAllowed?: boolean;
  platform?: HostPlatform;
  fs?: FsProbe;
}): Promise<FileRefEntry[]> {
  const { cwd, query, known } = options;
  const platform = options.platform ?? hostPlatform();
  const fs = options.fs ?? nodeFsProbe;
  const budget = options.budget ?? new LocalFsBudget();
  try {
    const target = listingTarget(query, platform);
    if (!target) return [];
    if (!budget.usable()) return [];
    if (target.scope !== "inside" && options.outsideAllowed !== true) return [];
    if (target.scope === "inside" && !cwd) return [];
    const excluded = new Set(EXCLUDED_DIRECTORY_NAMES);
    // 目录前缀里出现被排除的目录名：服务器对这次查询直接回空表，这里不补
    // （否则等于把服务器刻意隐掉的目录又捞回列表）
    if (target.prefix.split("/").some((segment) => excluded.has(segment))) return [];

    const absolute = await resolveListingDirectory({ cwd, target, budget, fs, platform });
    if (absolute === undefined) return [];
    const listing = await withinBudget(budget, () => fs.readdir(absolute));
    if (!listing.ok) return [];

    const candidates: FileRefEntry[] = [];
    const includeDot = target.fragment.startsWith(".");
    for (const entry of listing.value) {
      // 筛选词以 `.` 开头时照列点开头的名字（与官方 `!fragment.startsWith('.')` 同判据）
      if (!includeDot && entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        candidates.push({ path: `${target.prefix}${entry.name}`, kind: "directory" });
      } else if (entry.isFile()) {
        // 符号链接、设备文件等两类都不是：官方只认 isDirectory / isFile（拿不到证据
        // 就不列，不猜）
        candidates.push({ path: `${target.prefix}${entry.name}`, kind: "file" });
      }
    }

    const ranked = rankOutsideCandidates(candidates, target.fragment);
    const listed = new Set(known.map((entry) => entry.path));
    return ranked.filter((entry) => !listed.has(entry.path)).slice(0, MAX_COMPLETED_ENTRIES);
  } catch {
    // 目录不存在 / 不可读 / 权限失败：静默退回服务器结果（调用方原样返回它的列表）
    return [];
  }
}

/**
 * 工作区根的**「上一层」行**（M2，`{ path, kind: "directory", parent: true }` 的 path）。
 *
 * 只在裸 `@`（查询为空串）且信任门通过时由宿主下发，作为那一层候选的第一条；`cwd` 就是
 * 盘根（或 UNC 共享根）时没有上一层，返回 `undefined`。父目录是盘根时照发——`@D:/` 是
 * 可浏览的一层。父目录用**绝对形态**（用户在那儿看到的路径就是真路径）。
 */
export async function parentDirectoryEntry(options: {
  cwd: string;
  budget?: LocalFsBudget;
  platform?: HostPlatform;
  fs?: FsProbe;
}): Promise<FileRefEntry | undefined> {
  const platform = options.platform ?? hostPlatform();
  const fs = options.fs ?? nodeFsProbe;
  const budget = options.budget ?? new LocalFsBudget();
  const { cwd } = options;
  if (!cwd || !isNativeAbsolutePath(cwd, platform)) return undefined;
  const ops = pathOps(platform);
  const current = ops.resolve(cwd);
  const parent = ops.dirname(current);
  // 盘根 / 共享根没有上一层（`dirname` 在根处返回它自己）
  if (parent === current) return undefined;
  const outcome = await withinBudget(budget, () => fs.stat(parent));
  if (!outcome.ok || !outcome.value.isDirectory()) return undefined;
  return { path: parent.replaceAll("\\", "/"), kind: "directory" };
}

/**
 * 越界筛选词的**档位**（官方 `scoreCandidate` 的顺序近似）：完全相等 > 名字前缀 >
 * 名字包含 > 路径包含 > 子序列；不匹配返回 `undefined`。大小写不敏感（与官方同口径），
 * 子序列档**不做 gap 评分**（那是与官方的已知差异，次序可能不同）。
 *
 * 只作用于工作区外的候选：那些查询服务器从不返回任何行（见文件头）。
 */
export function outsideRank(entry: FileRefEntry, query: string): number | undefined {
  const needle = (query ?? "").toLowerCase();
  if (needle === "") return 0;
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1).toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  const path = entry.path.toLowerCase();
  if (path.includes(needle)) return 3;
  return isSubsequence(path, needle) ? 4 : undefined;
}

/** 筛选 + 排序（筛选词为空时退化成官方目录列举的「目录在前 + code-unit」）。 */
function rankOutsideCandidates(candidates: FileRefEntry[], fragment: string): FileRefEntry[] {
  if (fragment === "") return [...candidates].sort(compareCandidatePaths);
  const scored: { entry: FileRefEntry; rank: number }[] = [];
  for (const entry of candidates) {
    const rank = outsideRank(entry, fragment);
    if (rank !== undefined) scored.push({ entry, rank });
  }
  scored.sort((left, right) => left.rank - right.rank || compareCandidatePaths(left.entry, right.entry));
  return scored.map((row) => row.entry);
}

/** 官方的排序：目录在前、文件在后，同组内按 path 的原始 code-unit 比较。 */
function compareCandidatePaths(left: FileRefEntry, right: FileRefEntry): number {
  return kindRank(left.kind) - kindRank(right.kind) || compareText(left.path, right.path);
}

function kindRank(kind: FileRefEntry["kind"]): number {
  return kind === "directory" ? 0 : 1;
}

/** 官方 `compareText`：**不是** `localeCompare`（本地化排序会让顺序随语言变）。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `query` 是不是 `path` 的子序列（两侧都已小写；不评分，只判有无）。 */
function isSubsequence(text: string, needle: string): boolean {
  let at = 0;
  for (const character of text) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return at === needle.length;
}

/** 平台路径算术（形态判据的另一半：切段、拼段、`..` 的语义都按宿主平台来）。 */
type PathOps = typeof win32;

function pathOps(platform: HostPlatform): PathOps {
  return platform === "win32" ? win32 : (posix as unknown as PathOps);
}

interface WalkContext {
  budget: LocalFsBudget;
  fs: FsProbe;
  ops: PathOps;
}

/**
 * 逐段 `lstat` 走一串**原始**段，任一段是符号链接 / 非目录 / 不存在 / 超时 / 作废 →
 * `undefined`。
 *
 * 为什么是原始段而不是先 `path.resolve`：`resolve` 会把 `link/..` 里的 `link` 直接吃掉，
 * 于是「中间段是符号链接就拒绝」这条判据在含 `..` 的路径上形同不存在。`..` 在这里按
 * `dirname` 处理（到根就停，`path.resolve` 语义），并且**父目录本身也要 `lstat`**——
 * 父级是符号链接时同样拒绝。
 */
async function walkSegments(
  context: WalkContext,
  segments: readonly string[],
  start: string,
): Promise<string | undefined> {
  let current = start;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    const next = segment === ".." ? context.ops.dirname(current) : context.ops.join(current, segment);
    const outcome = await withinBudget(context.budget, () => context.fs.lstat(next));
    if (!outcome.ok) return undefined;
    const status = outcome.value;
    if (status.isSymbolicLink() || !status.isDirectory()) return undefined;
    current = next;
  }
  return current;
}

/**
 * 把这次查询的目标解析成本机绝对路径（越界侧的三条路，见文件头）。
 *
 * 工作区内那一条与从前的 `resolveInside` 同判据（逐段 `lstat`、拒符号链接、拒越出），
 * 只是多了一层「先按 `relative()` 兜一道包含判据」的保险；越界那两条不再做包含判据
 * （绝对形态天然可跨卷，`..` 形态本来就允许越出）。
 */
async function resolveListingDirectory(options: {
  cwd: string;
  target: ListingTarget;
  budget: LocalFsBudget;
  fs: FsProbe;
  platform: HostPlatform;
}): Promise<string | undefined> {
  const { cwd, target, budget, fs, platform } = options;
  const ops = pathOps(platform);
  const context: WalkContext = { budget, fs, ops };

  if (target.scope === "absolute") {
    if (!isNativeAbsolutePath(target.directory, platform)) return undefined;
    const root = ops.parse(target.directory).root;
    // UNC 要求至少到共享名（形态判据已挡掉 `//` / `\\server`）：根本身也得是目录，
    // 否则一个写错的共享名会一路走到 readdir 才失败
    if (!root) return undefined;
    const rootStatus = await withinBudget(budget, () => fs.lstat(root));
    if (!rootStatus.ok || rootStatus.value.isSymbolicLink() || !rootStatus.value.isDirectory()) return undefined;
    return walkSegments(context, target.directory.slice(root.length).split("/"), root);
  }

  if (!cwd || !isNativeAbsolutePath(cwd, platform)) return undefined;
  const resolvedRoot = ops.resolve(cwd);

  if (target.scope === "up") {
    // 相对且含 `..` 段：允许越出 cwd，仍逐段走原始段（`..` 由 walkSegments 处理），
    // 退到盘根就停
    return walkSegments(context, target.directory.split("/"), resolvedRoot);
  }

  // 工作区内：先兜一道包含判据（`resolve` 只在没有 `..` 段的查询上用，不会吃掉链接段），
  // 再按**原始段**逐段检查
  const absolute = ops.resolve(resolvedRoot, target.directory === "" ? "." : target.directory);
  const fromRoot = ops.relative(resolvedRoot, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${ops.sep}`)) return undefined;
  if (ops.isAbsolute(fromRoot)) return undefined;
  return walkSegments(context, target.directory.split("/"), resolvedRoot);
}
