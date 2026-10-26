/**
 * 文件芯片的**执行世界存在性**分类，以及**本机附件来源**的路径解析。
 *
 * 这里刻意不再查 git、不再用本机 `workspace.fs.stat`：芯片路径来自模型的工具调用 /
 * 交付申报，属于 DSH 执行世界。本机同名文件、同目录存在与 git 清单都不能证明
 * 它们指同一个文件（见 `docs/design-paths.md`）。存在性由 `HostFileAccess`
 * （`workspaceFiles.stat`）裁决：
 *
 * - `present`：Host 明确读到普通文件；
 * - `absent`：只有 `workspace-file/not-found`（`FileNotFound`）才算；
 * - `unknown`：权限、离线、连接失效、形状不合规等一律不算删除。
 *
 * 由于没有经过验证的本机映射，**不据本机 git 判改动记号**；只保留
 * 「明确不存在」的删除线。点击时的改动对比只走 Host 的 `changes.diff` 快照。
 *
 * 本文件同时保留给**用户上传前的本机附件来源**用的 `resolveChipPath`：那不是模型
 * 输出路径，不能与执行世界路径混用。
 */

import { isAbsolute, join } from "node:path";
import type { FileChangeKind } from "../shared/chat";

/** 文件在执行世界的存在性——三态，不是布尔。 */
export type FileExistence = "present" | "absent" | "unknown";

/**
 * 芯片种类：只把**明确不存在**画成删除线。
 *
 * `present` 不标记号：没有本机映射能证明它「变过」，产物清单里出现不等于任何改动；
 * `unknown` 同样不标记号（拿不到证据时不动）。
 */
export function fileChangeKind(existence: FileExistence): FileChangeKind | undefined {
  return existence === "absent" ? "deleted" : undefined;
}

/**
 * 会话的创建目录：**权威账本优先**，可见列表只作账本尚未到达时的回退。
 *
 * `session/list` 的原始行会建一份过滤前的 cwd 账本；子代理 / 被折叠的会话不进
 * 可见列表，但它们的创建目录仍是权威事实。绝不能用执行目录（`workingDirectory`）
 * 或窗口 cwd 兜底——那些不是「会话创建时确定的身份」。
 */
export function sessionCreationCwd(
  authority: ReadonlyMap<string, string> | undefined,
  visible: readonly { readonly id: string; readonly cwd?: string }[],
  sessionId: string,
): string | undefined {
  const known = authority?.get(sessionId);
  if (known) return known;
  return visible.find((row) => row.id === sessionId)?.cwd;
}

/**
 * 本机附件来源路径的解析（**不是**模型路径）。
 *
 * 用户上传前的本地附件原件属于已记录的本地来源：相对拼写按扩展宿主 cwd / 工作区
 * 解析是合理的。模型输出 / 交付 / 芯片路径不得经过这里，它们由 Host 的
 * `workspaceFiles.stat` 解析。
 *
 * 纯函数、不碰磁盘；断言见 `scripts/fileChange.test.ts`。
 */
export function resolveChipPath(cwd: string | undefined, path: string): string | undefined {
  if (!path) return undefined;
  if (isAbsolute(path)) return path;
  if (!cwd) return undefined;
  return join(cwd, path);
}

/**
 * VS Code `FileSystemError` 的「找不到」判据，**只用于本机附件来源**。
 *
 * 实测 code 是 `FileNotFound`（方法名），不是 `FileSystemError.FileNotFound`。
 * 执行世界路径不得经过这里；那里的 absent 只由 Host 的 `workspace-file/not-found` 决定。
 */
export function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "FileNotFound";
}

/**
 * 从「路径 + 尾部行号」里拆出行号：`src/a.ts:12`、`src/a.ts:12-40`、`src/a.ts:12:5`。
 *
 * 行号是导航参数，不是文件身份。只做拆分，不做存在性判断：调用方先在字面路径上
 * 问 Host，只有 not-found 时才用这里的结果重试。
 */
export function splitPathLineSuffix(value: string): { path: string; line: number } | undefined {
  const match = /^(.*?):(\d{1,9})(?:[-:](\d{1,9}))?$/u.exec(value);
  if (!match) return undefined;
  const path = match[1];
  // 空路径、裸盘符（`C:12` 是盘符相对路径，不是「文件 C 的第 12 行」）都不算
  if (!path || /^[A-Za-z]$/u.test(path)) return undefined;
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  return { path, line };
}
