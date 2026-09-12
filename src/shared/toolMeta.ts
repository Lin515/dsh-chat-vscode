/**
 * 工具行的契约事实（与官方客户端逐字对齐，供宿主与界面共用）。
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
 * - `parseExitStatus`（:656-677）与 `terminalFailed`（:513-525）
 */

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
};

/** 精确分类（官方 `classifyTool`）。 */
export function classifyTool(name: string): ToolVariant {
  return TOOL_VARIANTS[name] ?? "others";
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
const FILE_PATH_KEYS = ["path", "file_path"] as const;

/** 从工具参数里取出「可打开的工程文件路径」；不是文件类变体时返回 undefined。 */
export function filePathFrom(name: string, args: Record<string, unknown>): string | undefined {
  if (!FILE_PATH_VARIANTS.has(classifyTool(name))) return undefined;
  for (const key of FILE_PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** 终端结果的解析产物（官方 `parseExitStatus`）。 */
export interface ExitStatus {
  /** 剥掉标记行之后的正文。 */
  output: string;
  /** 退出码；没有标记时官方给 0（干净退出）。 */
  exitCode?: number;
  /** 被信号杀死时的信号名（存在时**优先于**退出码）。 */
  signal?: string;
}

/**
 * 从终端结果尾部提取退出状态，并把标记行**剥掉**。
 *
 * 标记是 dsh-shell 自己写的最后一行：
 * - `\n[killed by signal: X]`——先判，信号优先于退出码；
 * - `\n[exit code: N]`；
 * - 两者都没有 → 干净退出，正文原样、`exitCode` 为 0。
 *
 * 为什么要剥掉：这一行是给机器读的，界面上另有「退出码 N」的呈现；
 * 留在正文里会和用户真正想看的输出混在一起。
 *
 * 注意**持久 shell** 用的是另一套词汇（`[shell exited: code N]` 等），
 * 刻意不匹配这里——所以对它们本函数返回原样文本 + exitCode 0。
 */
export function parseExitStatus(text: string): ExitStatus {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
  if (signal?.[1] !== undefined) {
    return { output: text.slice(0, signal.index), signal: signal[1] };
  }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text);
  if (exit?.[1] !== undefined) {
    return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) };
  }
  return { output: text, exitCode: 0 };
}

/**
 * 终端结果是否算失败（官方 `terminalFailed`）。
 *
 * 关键事实：bash / pwsh 工具对非零退出码**故意不置 isError**——「退出状态是结果
 * 数据，不是工具失败」。所以客户端必须自己把 `ok` 升级成 `error`，否则
 * `exit 1` 和 `exit 0` 在界面上完全一样。
 */
export function terminalFailed(status: { exitCode?: number; signal?: string; running?: boolean }): boolean {
  if (status.running === true) return false;
  return (status.exitCode !== undefined && status.exitCode !== 0) || status.signal !== undefined;
}
