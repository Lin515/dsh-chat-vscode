import type {
  DirectoryOption,
  HistoryDirectoryView,
  HistoryScope,
  SessionSummaryView,
} from "../shared/chat";
import { basenameWorkspacePath } from "../shared/workspacePath";
import { dirKey } from "./composerDir";
import { shortDirectoryLabels } from "./directoryLabel";

/**
 * 历史抽屉范围选择器的纯判据（离线可断言，见 `scripts/historyDirectoryView.test.ts`）。
 *
 * 范围是**一次读取**：只改这个窗口看到哪一段历史，不建会话、不注册工作区、不改新会话
 * 的默认目录。宿主按窗口下发 `ChatState.history`，两份列表已经按 `scope` 收窄；旧宿主
 * 没有这个键，界面退回顶层 `sessions` / `archivedSessions`（其他消费者仍读那份宽列表，
 * 例如 `@` 会话引用与后台任务的会话选择）。
 */

export interface HistoryScopeLabels {
  current: string;
  roots: string;
}

export interface HistoryScopeOption {
  /** `<select>` 的值（结构化编码，路径里有冒号也不会歧义）。 */
  value: string;
  scope: HistoryScope;
  label: string;
  /** 悬停可读的完整路径（目录选项才有）。 */
  title?: string;
}

/** 一份历史抽屉实际渲染用的列表：有投影就**只**用投影，没有才退回旧顶层帧。 */
export interface HistoryLists {
  projected: boolean;
  sessions: SessionSummaryView[];
  archivedSessions: SessionSummaryView[];
  scope?: HistoryScope;
  /** 投影列表是否跨了不止一个创建目录（只有投影能给这个事实）。 */
  mixedDirectories: boolean;
}

/** 范围的结构化值：`JSON` 编码让路径里的冒号 / 引号不参与解析。 */
export function historyScopeValue(scope: HistoryScope): string {
  return JSON.stringify(scope);
}

/** 解析 `<select>` 的值；形状不完整就返回 `undefined`（界面保持原范围）。 */
export function parseHistoryScopeValue(value: string): HistoryScope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind === "current") return { kind: "current" };
  if (record.kind === "roots") return { kind: "roots" };
  if (record.kind !== "directory") return undefined;
  const path = record.path;
  if (typeof path !== "string" || path.length === 0) return undefined;
  return { kind: "directory", path };
}

/** 范围身份：路径比较走 `dirKey`（Windows 大小写 / 斜杠等价，POSIX 保留大小写）。 */
export function historyScopeKey(scope: HistoryScope): string {
  return scope.kind === "directory" ? `directory:${dirKey(scope.path)}` : scope.kind;
}

export function sameHistoryScope(left: HistoryScope, right: HistoryScope): boolean {
  return historyScopeKey(left) === historyScopeKey(right);
}

/**
 * 范围选择器的选项：当前目录 → 全部工作区根（有根时）→ 各根目录 → 其他目录。
 *
 * 「其他目录」是当前连接已知会话所属、但不在工作区根里的目录；根目录与它可能同名，
 * 所以两段目录统一走 `shortDirectoryLabels` 去重。当前范围是某个目录、但它暂时不在
 * 候选里（宿主尚未刷新）时补一条，避免 `<select>` 显示空白。
 */
export function historyScopeOptions(
  view: Pick<HistoryDirectoryView, "scope" | "roots" | "otherDirectories">,
  labels: HistoryScopeLabels,
): HistoryScopeOption[] {
  const directories: DirectoryOption[] = [];
  const seen = new Set<string>();
  for (const option of [...view.roots, ...view.otherDirectories]) {
    const key = dirKey(option.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    directories.push(option);
  }
  const names = shortDirectoryLabels(directories);
  const out: HistoryScopeOption[] = [
    {
      value: historyScopeValue({ kind: "current" }),
      scope: { kind: "current" },
      label: labels.current,
    },
  ];
  // 当前范围是 roots 时即使根目录刚好暂时为空也保留这一项，避免 `<select>` 的值
  // 匹配不到任何选项而显示空白（宿主的工作区变化与投影帧之间可能有一瞬）。
  if (view.roots.length > 0 || view.scope.kind === "roots") {
    out.push({
      value: historyScopeValue({ kind: "roots" }),
      scope: { kind: "roots" },
      label: labels.roots,
    });
  }
  for (const option of directories) {
    out.push({
      value: historyScopeValue({ kind: "directory", path: option.path }),
      scope: { kind: "directory", path: option.path },
      label: names.get(dirKey(option.path)) ?? option.name,
      title: option.path,
    });
  }
  if (
    view.scope.kind === "directory" &&
    !out.some((option) => sameHistoryScope(option.scope, view.scope))
  ) {
    const fallback =
      basenameWorkspacePath(view.scope.path.replace(/[/\\]+$/u, "")) || view.scope.path;
    out.push({
      value: historyScopeValue(view.scope),
      scope: view.scope,
      label: fallback,
      title: view.scope.path,
    });
  }
  return out;
}

/**
 * 选列表来源：投影存在时**只用投影**（两份都来自同一范围，不能只换一份），
 * 缺席时退回旧的顶层列表；同时带回范围与「混合目录」事实。
 */
export function historyLists(
  history: HistoryDirectoryView | undefined,
  fallbackSessions: readonly SessionSummaryView[],
  fallbackArchived: readonly SessionSummaryView[],
): HistoryLists {
  if (history) {
    return {
      projected: true,
      sessions: history.sessions,
      archivedSessions: history.archivedSessions,
      scope: history.scope,
      mixedDirectories: history.mixedDirectories,
    };
  }
  return {
    projected: false,
    sessions: [...fallbackSessions],
    archivedSessions: [...fallbackArchived],
    mixedDirectories: false,
  };
}

/**
 * 行内的「创建目录」短名（按 `cwd` 去重，按 `dirKey` 索引）。
 *
 * 只有混合目录的投影才需要显示：单一目录的列表里每行都写同一个目录名是噪音。
 * 同名目录由 `shortDirectoryLabels` 逐级补父段；完整路径挂在行内子标题的 `title` 上。
 */
export function historyDirectoryLabels(
  rows: readonly Pick<SessionSummaryView, "cwd">[],
): Map<string, string> {
  const paths: string[] = [];
  for (const row of rows) {
    if (row.cwd) paths.push(row.cwd);
  }
  return shortDirectoryLabels(paths.map((path) => ({ path })));
}
