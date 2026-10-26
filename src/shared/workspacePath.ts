/**
 * Workspace 路径的**纯字符串**判据（宿主与 webview 共用，浏览器安全）。
 *
 * 为什么不能直接用 `node:path`：本扩展的界面跑在 webview 里，而远端 / WSL / 容器
 * 部署时这些路径根本不属于扩展宿主的本机文件系统。`node:path.isAbsolute` 还是
 * **平台相关**的：`C:\x` 在 Linux 上会被判成相对路径。官方客户端同样用
 * `@deepseek-ai/dsh-util-workspace-path` 的字符串判据，本文件逐条对齐它。
 *
 * 这里只回答「这个拼写本身说明什么」，不查盘、不 realpath、不按本机平台改写大小写。
 * 路径身份的比较见 {@link workspacePathKey}：它**不**消 `.` / `..`，也**不**统一小写，
 * 因为那两件事都可能把远端两个不同的文件错误地合并成一个。
 *
 * 官方出处：`dsh-util-workspace-path` 的 `isAbsoluteWorkspacePath` /
 * `resolveWorkspacePath` / `basename` / `relativizeToCwd`，以及
 * `ui-tool` 的 `terminal-card-model.normalizeSegments`。
 */

/** 盘符（`C:/`、`C:\`）或 UNC（`\\server`）形态。 */
export function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}

/**
 * 是否按绝对路径处理（官方 `isAbsoluteWorkspacePath`）。
 *
 * 只认两种拼写：POSIX 的 `/a/b`，以及 Windows 盘符 / UNC。单个反斜杠开头的
 * `\a\b` **不算**绝对路径——官方也不认，它是相对拼写。
 */
export function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith("/") || isWindowsStylePath(path);
}

/**
 * 把相对路径拼到工作目录上（官方 `resolveWorkspacePath`）。
 *
 * 只做字符串拼接，**不**消 `.` / `..`、不转分隔符、不校验存在性：最终规范化由
 * 执行世界的 provider 完成。工作目录缺失时原样返回相对拼写，绝不猜绝对位置。
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (isAbsoluteWorkspacePath(path)) return path;
  if (cwd === undefined || cwd === "") return path;
  const separator = isWindowsStylePath(cwd) && cwd.includes("\\") ? "\\" : "/";
  const base = cwd.replace(/[/\\]+$/, "");
  const relative = path.replace(/^[/\\]+/, "");
  return `${base}${separator}${relative}`;
}

/** 路径末段（官方 `basename`：按任一分隔符切，不做归一化）。 */
export function basenameWorkspacePath(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * 去掉工作目录前缀（官方 `relativizeToCwd`，只用于展示）。
 *
 * 前缀必须逐字匹配（含分隔符）；拼写不同（realpath、符号链接、大小写）时不改，
 * 因为字符串层面证明不了它们是同一个根。
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return text;
  const root = cwd.replace(/[/\\]+$/, "");
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
  return text;
}

/**
 * 路径身份比较键：**只**做能确定不改变目标的字符串处理。
 *
 * - Windows 形态（盘符 / UNC）的路径：两种分隔符在 provider 里等价，统一成 `/`，
 *   并去掉结尾分隔符；
 * - 其它形态（POSIX、相对拼写）：原样保留，只去结尾分隔符。POSIX 上反斜杠是
 *   **文件名的一部分**，相对拼写又拿不到路径家族——把它们转成 `/` 会把两个不同
 *   文件合成一个；
 * - **不转小写**：Windows 上通常不区分大小写，但 POSIX 上 `A.ts` 与 `a.ts` 是两个
 *   文件；「多半是同一个」不能作为合并身份的依据；
 * - **不消 `.` / `..`**：符号链接下 `link/../x` 与 `x` 可能不是同一目标，规范化
 *   只能由执行世界做。
 */
export function workspacePathKey(path: string): string {
  const key = isWindowsStylePath(path) ? path.replace(/\\/g, "/") : path;
  return key.replace(/\/+$/, "");
}

/** 两个拼写能否证明是同一路径（见 {@link workspacePathKey} 的边界）。 */
export function sameWorkspacePath(left: string, right: string): boolean {
  return workspacePathKey(left) === workspacePathKey(right);
}

/**
 * 从结算结果的**不透明元数据**里读一个记录时的绝对位置（官方 `recordedAbsolutePath`）。
 *
 * 只认记录对象上的 `path` / `cwd` 字段（与官方一致，不额外要求自有键），且值必须
 * 已经是绝对形态；旧的、残缺的或相对拼写一律返回 undefined——**绝不**按当前目录补齐。
 */
export function recordedAbsolutePath(meta: unknown, field: "path" | "cwd"): string | undefined {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const value = (meta as Record<string, unknown>)[field];
  return typeof value === "string" && isAbsoluteWorkspacePath(value) ? value : undefined;
}

/**
 * 折叠 `.` / `..` 段，用于**终端提示里的目录标签**（官方
 * `terminal-card-model.normalizeSegments`）。
 *
 * 只用于展示：执行器在跑命令前已经把 workdir 解成真实目录，所以 join 出来的
 * `/w/app/..` 应显示成 `w`。分隔符按作者写法保留（Windows 路径仍是反斜杠）；
 * 根以上的 `..` 丢弃（文件系统也是这么处理的）。UNC 的 server 与 share 是根的一部分，
 * 不能被 `..` 弹掉（Windows 无法越过共享根）。
 */
export function normalizeWorkspaceSegments(path: string): string {
  if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path)) return path;
  const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path);
  if (unc !== null) {
    const [matched, server, share] = unc;
    const root = `\\\\${String(server)}\\${String(share)}`;
    const rest = collapseSegments(path.slice(matched.length), true);
    return rest === "" ? root : `${root}\\${rest}`;
  }
  const backslashed = path.includes("\\") && !path.includes("/");
  const separator = backslashed ? "\\" : "/";
  const rooted = /^[/\\]/.test(path);
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const body = collapseSegments(path.slice(drive.length), rooted || drive !== "", separator);
  const leading = rooted ? separator : "";
  return drive === "" ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`;
}

/** 按已知根状态折叠段（官方 `collapse`）。 */
function collapseSegments(body: string, rooted: boolean, separator = "/"): string {
  const kept: string[] = [];
  for (const segment of body.split(/[/\\]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
      else if (!rooted) kept.push(segment);
      continue;
    }
    kept.push(segment);
  }
  return kept.join(separator);
}
