/**
 * 工具行的契约事实（供宿主与界面共用；退出状态直接复用官方纯函数副本）。
 *
 * 三件事此前都是「本仓库自己发明的近似」，与官方不一致，用户可感知：
 * 1. 工具分类用**子串启发**（`includes("web")`、`includes("list")`…）→ 自定义工具名
 *    会被误分类；
 * 2. 终端结果的 `[exit code: N]` / `[killed by signal: X]` 从未解析 → 失败的命令
 *    在界面上和成功长得一样；
 * 3. 工具行的状态语义只有 running/ok/error，缺官方的 `stopped`。
 *
 * 本文件只放**纯数据与纯函数**：图标、文案由界面按当前语言渲染。
 *
 * 依据（`@deepseek-ai/dsh-client-ui-tool/lib/client.js`）：
 * - `TOOL_VARIANTS` / `TOOL_TITLE_KEYS`（:805-849）
 * - 退出状态已改为固定 rc.1 源码摘录（`src/vendor/ui-tool/terminal-status.ts`），不再依赖旧打包行号
 */
import { parseExitStatus, terminalFailed as officialTerminalFailed } from "../vendor/ui-tool/terminal-status";

export { parseExitStatus };

/**
 * 工具分类变体（官方 `ToolRowVariant`）。
 *
 * `others` 是**兜底**，不是「其他工具」的垃圾桶式猜测：官方只对表内 16 个名字做
 * 精确匹配，其余一律 `others`——所以这里也必须是**精确表**，不能用 includes。
 */
export type ToolVariant = "search" | "read" | "bash" | "write" | "edit" | "code" | "others";

/** 官方 `TOOL_VARIANTS` 全表（逐字，16 项）。 */
const TOOL_VARIANTS: Readonly<Record<string, ToolVariant>> = {
  bash: "bash",
  pwsh: "bash",
  read: "read",
  read_image: "read",
  web_fetch: "read",
  web_search: "search",
  grep: "search",
  glob: "search",
  write: "write",
  edit: "edit",
  run_code: "code",
  cordis_package_inspect: "read",
  cordis_runtime_inspect: "read",
  cordis_run: "others",
  cordis_stop: "others",
  cordis_undefine: "others",
};

/**
 * 官方 `TOOL_TITLE_KEYS`：给某个工具**单独命名**，而不是套用它所属变体的通用名。
 *
 * 例：`pwsh` 属于 `bash` 变体，但标题要显示「Pwsh」而不是「Bash」；
 * `read_image` 属于 `read` 变体，标题要显示「读取图片」而不是「读取」。
 */
const TOOL_TITLE_KEYS: Readonly<Record<string, string>> = {
  cordis_package_inspect: "toolInspect",
  cordis_runtime_inspect: "toolInspect",
  cordis_run: "toolRunCordis",
  cordis_stop: "toolStopCordis",
  cordis_undefine: "toolRemoveCordis",
  pwsh: "toolPwsh",
  read_image: "toolReadImage",
  skill: "toolSkill",
};

/** 精确分类（官方 `classifyTool`）。 */
export function classifyTool(name: string): ToolVariant {
  return TOOL_VARIANTS[name] ?? "others";
}

/**
 * 这个工具调用是不是**派发子代理**（官方 `isSubagentDelegationTool`，逐字同口径）。
 *
 * 轮级过程折叠要把「N 次工具调用」与「K 个 subagent」分开数，判据就是这一条。
 */
export function isSubagentDelegationTool(name: string): boolean {
  return name === "subagent" || name.startsWith("subagent_");
}

/**
 * 这个工具是否有**独立的标题键**（官方 `TOOL_TITLE_KEYS`）。
 *
 * 界面据此决定标题栏显示什么；返回 undefined 表示套用变体的通用名。
 */
export function toolTitleKey(name: string): string | undefined {
  return TOOL_TITLE_KEYS[name];
}

/**
 * 官方 `SUMMARY_KEYS`：每个变体从参数里优先取哪些字段做单行摘要。
 *
 * `others` 刻意是空表——官方对未知工具不猜字段，退回「参数里第一个非空字符串」。
 */
const SUMMARY_KEYS: Readonly<Record<ToolVariant, readonly string[]>> = {
  bash: ["description", "command"],
  read: ["path", "file_path", "url"],
  search: ["query", "pattern", "url"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  code: ["description"],
  others: [],
};

export function summaryKeys(variant: ToolVariant): readonly string[] {
  return SUMMARY_KEYS[variant];
}

/**
 * 只有这三个变体的参数里那个字符串是**文件路径**（官方 `FILE_PATH_VARIANTS`）。
 *
 * 注意 `read` 变体包含 `web_fetch`，而它用的是 `url`——官方**刻意**不把 `url`
 * 算作路径键（`FILE_PATH_KEYS = ["path", "file_path"]`），否则 URL 会被当成
 * 可打开的工作区文件。
 */
const FILE_PATH_VARIANTS: ReadonlySet<ToolVariant> = new Set<ToolVariant>(["read", "write", "edit"]);

/**
 * 这个工具名是否属于官方的文件路径变体（`FILE_PATH_VARIANTS`）。
 *
 * 工具行的打开目标与产物别名只对这三类变体有意义；`web_fetch` 虽然落在 `read`
 * 变体里，但它通常用 `url`——调用方还必须只认 `path` / `file_path` 键
 * （见 `shared/toolPath.argumentPathOf`）。
 */
export function isFilePathTool(name: string): boolean {
  return FILE_PATH_VARIANTS.has(classifyTool(name));
}

/** 终端结果的解析产物（官方 `parseExitStatus`）。 */
export type ExitStatus = ReturnType<typeof parseExitStatus>;

/**
 * 终端结果是否算失败（官方 `terminalFailed`）。
 *
 * 关键事实：bash / pwsh 工具对非零退出码**故意不置 isError**——「退出状态是结果
 * 数据，不是工具失败」。所以客户端必须自己把 `ok` 升级成 `error`，否则
 * `exit 1` 和 `exit 0` 在界面上完全一样。
 */
export function terminalFailed(status: { exitCode?: number | null; signal?: string; running?: boolean }): boolean {
  return officialTerminalFailed({ card: status });
}
