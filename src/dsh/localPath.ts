/**
 * 「这个执行世界文件能不能在本机当**真实文件**打开」的纯判据。
 *
 * 宿主在 Alt 打开真实文件前要连过几道门：路径形态是不是扩展宿主平台的本机绝对路径、
 * 原生文件是否存在且与执行世界内容一致。这里只放可以离线断言的字符串 / 字节判断，
 * 不碰 `vscode` 与文件系统；真正的 `stat` / `readFile` 在 `controller.openFile` 的
 * `real` 分支里。
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

/** 两段字节是否完全一致（长度 + 逐字节）。 */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
