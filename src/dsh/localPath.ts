/**
 * 「这个执行世界文件能不能在本机当**真实文件**打开」的纯判据。
 *
 * 宿主在 Alt 打开真实文件前要连过几道门：端点是不是本机、路径形态是不是
 * 扩展宿主平台的本机绝对路径、本机副本是否存在且与执行世界同一份字节。这里只放
 * 可以离线断言的字符串 / 字节判断，不碰 `vscode` 与文件系统；真正的 `stat` /
 * `readFile` 在 `controller.openFile` 的 `real` 分支里。
 *
 * 为什么需要这一层：执行世界的绝对路径可能是 POSIX、盘符、WSL 或容器里的路径，
 * 而扩展宿主的 `Uri.file` 只解释**它自己这台机器**的路径。不能因为字符串以 `/`
 * 开头就当成本机文件，也不能因为本机同路径存在就认定为同一个文件。
 */
import { isWindowsStylePath } from "../shared/workspacePath";

export type LocalPlatform = "win32" | "posix";

/** `process.platform` → 两种本机路径家族。 */
export function localPlatform(platform: NodeJS.Platform): LocalPlatform {
  return platform === "win32" ? "win32" : "posix";
}

/**
 * 路径是否像**当前平台的本机绝对路径**。
 *
 * - Windows：只认盘符（`C:\` / `C:/`）与 UNC；
 * - POSIX：只认 `/` 根，且排除盘符拼写（`C:/x` 在 POSIX 上是相对文件名）。
 *
 * 不查盘、不 realpath、不转大小写：存在性与内容另由调用方验证。
 */
export function isLocalAbsolutePath(path: string, platform: LocalPlatform): boolean {
  if (platform === "win32") return isWindowsStylePath(path);
  return path.startsWith("/") && !isWindowsStylePath(path);
}

/**
 * 主机名是不是回环地址。
 *
 * `external` 端点可能是用户在本机手动起的 `dsh web`（`127.0.0.1` / `localhost` /
 * `[::1]`），这时执行世界仍在本机；端口转发到远端的场景则由后面的存在性与字节
 * 校验兜底，不会仅凭回环就认定可编辑。
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(normalized);
}

/** 端点 URL 的主机是不是回环；坏 URL 一律不是。 */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (url === undefined || url === "") return false;
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 两段字节是否完全一致（长度 + 逐字节）。 */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
