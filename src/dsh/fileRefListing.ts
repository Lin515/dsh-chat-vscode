/**
 * `@` 候选里**目录列举**那一路的本地补全（宿主侧，Node 文件系统）。
 *
 * 为什么需要它：服务器一次查询最多回 `DEFAULT_FILE_SEARCH_MAX_RESULTS`（20）条，
 * 而官方 `WorkspaceFileSearch.list()` 在「查询为空串或以 `/` 结尾」时走
 * `listDirectory` —— 目录列举**同样**过 `rankCandidates(..., maxResults)`，也被截到
 * 20 条。`maxResults` 是 dsh 插件的**配置**（`LocalFileReferenceService.Config`），
 * 不是请求参数：扩展侧只能发 `{ agentId, query }`，多要不到任何东西。于是「一个目录
 * 里文件多一点，`@` 列表就只有前 20 条」——用户 2026-10-10 报的「显示不全，像有个上限值」。
 *
 * 本模块把被截掉的尾巴**按同一套语义**补回来（不重排服务器那 20 条，只往后追加）：
 *
 * - 排序：fragment 为空串时官方 `scoreCandidate` 第一行就返回 0，排序退化成
 *   「目录在前、文件在后」（`kindRank`）再按 path 的**原始 code-unit** 比较
 *   （`compareText` 用的是 `<` / `>`，不是 locale 比较）。**没有**长度那一档
 *   （`query === '' ? 0 : …` 被空查询短路），所以这里也不写它。
 * - 名字以 `.` 开头的条目跳过（官方判据是 `!fragment.startsWith('.')`，fragment 在这里
 *   恒为空串，所以一律跳过）。
 * - 名字命中 `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` 的目录跳过；目录路径本身
 *   （displayDirectory）的任一段命中时服务器直接回空表，这里也**不补**——否则会把
 *   服务器刻意隐掉的目录（`node_modules` / `.git` 之类）又捞回列表。
 * - 候选路径一律用正斜杠、目录行**不带**结尾斜杠（界面侧再补，见
 *   `shared/mentions.ts` 的 `formatFileMention`）。
 *
 * **fragment 非空时一律不补**：那种查询由服务器按 fuzzy 分数排序（`scoreCandidate`
 * 的五个档位 + 子序列打分），本地复现不出来，硬拼只会把服务器排好的结果割裂成两段
 * 规则不同的清单。这一半的截断保持原样（它是官方的「模糊搜索」语义，不是目录列举）。
 *
 * 枚举失败（目录不存在 / 不可读 / 越出会话工作目录 / 中间段是符号链接）一律返回空表，
 * 由调用方静默退回服务器结果——`@` 列表宁可少几条，也绝不能变空或把错误抛上去。
 */
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * 补的尾巴）。
 */
const MAX_COMPLETED_ENTRIES = 1000;

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

/** 这次查询的目录与筛选词（前缀 `src/` + 待筛 `a`）。 */
export interface ListingTarget {
  /** 相对会话工作目录的目录前缀，**带**结尾斜杠（工作区根目录是空串）。 */
  directory: string;
  /** 最后的筛选词；目录列举这一路恒为空串。 */
  fragment: string;
}

/**
 * 这次查询是不是**目录列举**（fragment 为空），以及它列的是哪个目录。
 *
 * 判据与官方 `list()` 逐字同源：先做 `\` → `/` 归一，然后
 * - 查询是空串 ⇒ 列工作目录根；
 * - 查询里有 `/` 且以它结尾 ⇒ 列那一段目录；
 * - **其余一律不是**：带 `/` 但不以 `/` 结尾时（`src/we`）服务器按 fuzzy 分数排目录里的
 *   条目，连 `/` 都没有时（`src`）走的是全局模糊查询那条路——两种都不是目录列举。
 *
 * 按**肯定证据**写：返回 `undefined` 表示「这次不是目录列举」，调用方据此**什么都不做**
 * （fuzzy 排序本地复现不出来，见文件头）。
 */
export function listingTarget(query: string): ListingTarget | undefined {
  const normalized = query.replaceAll("\\", "/");
  if (normalized === "") return { directory: "", fragment: "" };
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return undefined;
  const fragment = normalized.slice(slash + 1);
  if (fragment !== "") return undefined;
  return { directory: normalized.slice(0, slash + 1), fragment };
}

/**
 * 列出 `query` 这个目录里**服务器没返回**的条目（按官方顺序，已去重）。
 *
 * @param options.cwd 会话的**工作目录**（服务器那次查询的根；它不一定是 VS Code 打开的
 *                    文件夹——`@` 引用按会话的 cwd 列，见官方 `list()` 的
 *                    `agent.session.header.cwd`）。
 * @param options.query 这次 `@` 的查询串（未归一）。
 * @param options.known 服务器已经返回的条目：一条不动，只在它们之后追加。
 * @returns 要追加在服务器结果之后的条目；不是目录列举、或任何一步失败时是空表。
 */
export async function missingDirectoryEntries(options: {
  cwd: string;
  query: string;
  known: readonly FileRefEntry[];
}): Promise<FileRefEntry[]> {
  const { cwd, query, known } = options;
  try {
    const target = listingTarget(query);
    if (!target) return [];
    // 没有会话工作目录就无从列举（调用方本来也拿不到服务器的路径基准）
    if (!cwd) return [];
    const excluded = new Set(EXCLUDED_DIRECTORY_NAMES);
    // 目录前缀里出现被排除的目录名：服务器对这次查询直接回空表，这里不补
    // （否则等于把服务器刻意隐掉的目录又捞回列表）
    if (target.directory.split("/").some((segment) => excluded.has(segment))) return [];

    const absolute = await resolveInside(cwd, target.directory);
    if (absolute === undefined) return [];

    const entries = await readdir(absolute, { withFileTypes: true });
    const candidates: FileRefEntry[] = [];
    for (const entry of entries) {
      // fragment 恒为空串 ⇒ 点开头的名字一律跳过（官方 listDirectory 同判据）
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        candidates.push({ path: `${target.directory}${entry.name}`, kind: "directory" });
      } else if (entry.isFile()) {
        // 符号链接、设备文件等两类都不是：官方只认 isDirectory / isFile（拿不到证据
        // 就不列，不猜）
        candidates.push({ path: `${target.directory}${entry.name}`, kind: "file" });
      }
    }
    candidates.sort(compareCandidatePaths);

    const listed = new Set(known.map((entry) => entry.path));
    return candidates.filter((entry) => !listed.has(entry.path)).slice(0, MAX_COMPLETED_ENTRIES);
  } catch {
    // 目录不存在 / 不可读 / 权限失败：静默退回服务器结果（调用方原样返回它的列表）
    return [];
  }
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

/**
 * 把「相对工作目录的展示路径」解析成绝对路径，并确认它**没有越出**工作目录。
 *
 * 逐段 `lstat` 而不是直接 `stat`：官方 `resolveDisplayDirectory` 同样逐段检查，
 * 中间任一段是符号链接就整条拒绝。这既挡住「链接到工作目录之外」，也挡住 Windows 上
 * 的跨卷路径——一条都不能放过，否则 `@` 列表会列出工作目录之外的东西。
 */
async function resolveInside(root: string, displayDirectory: string): Promise<string | undefined> {
  const resolvedRoot = resolve(root);
  const absolute = resolve(resolvedRoot, displayDirectory === "" ? "." : displayDirectory);
  const fromRoot = relative(resolvedRoot, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return undefined;
  if (isAbsolute(fromRoot)) return undefined;
  let current = resolvedRoot;
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  return absolute;
}
