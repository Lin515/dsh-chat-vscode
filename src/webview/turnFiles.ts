/**
 * 轮尾两行文件的**去重口径**。
 *
 * 两行的来源本来就不同（与官方同构）：`produced` 从成功的写类调用推导，
 * `deliverables` 是 `present` 的显式申报。但模型申报交付的**通常正是它刚改过的
 * 那几个文件**，于是同一个文件名在两行里各出现一次，看起来像同一件事被提示了两遍
 * （用户 2026-09-12 反馈）。
 *
 * 现在的口径：**交付行说了的，本轮改动行不再重复**。
 *
 * - 交付行留着：它带说明、带「用什么打开」的语义，信息更全；
 * - 「本轮改动」只补交付行没申报的那些（改了但没申报的文件）；
 * - Bash / 终端建的文件不在 `produced` 里，本来就只在交付行出现，不受影响；
 * - 两边都空时不显示任何一行（调用方按空数组判断）。
 *
 * 另一条与去重并列的口径：**净效果为零的文件两行都不列**（见 `withoutVanished`）。
 */

import type { FileChangeKind } from "../shared/chat";

/** 交付文件（`deliverables` / `presented`）里判重需要的最小形状。 */
export interface DeliverablePath {
  path: string;
  description?: string;
}

/**
 * 比较用的路径键：分隔符统一成 `/`、去掉结尾分隔符、大小写不敏感。
 *
 * 同一个文件在两处可能写成 `D:/dev/app/src/config.ts` 与 `d:\dev\app\src\config.ts`
 * （写类调用与 `present` 申报是两次独立的工具调用，写法不必一致），
 * 直接按字符串比会漏判、让重复又冒出来。
 */
function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 「本轮文件改动」行最终要列的文件：从 `produced` 里去掉已经申报交付的那些。
 *
 * @param produced 本轮成功的写类调用推导出的路径（保持原顺序）。
 * @param deliverables `present` 申报的交付文件。
 * @returns 仍需在「本轮文件改动」里出现的路径；空数组表示这一行不该显示。
 */
export function producedOnly(
  produced: readonly string[] | undefined,
  deliverables: readonly DeliverablePath[] | undefined,
): string[] {
  if (!produced?.length) return [];
  if (!deliverables?.length) return [...produced];
  const delivered = new Set(deliverables.map((file) => pathKey(file.path)));
  return produced.filter((path) => !delivered.has(pathKey(path)));
}

/**
 * 去掉**净效果为零**的文件：磁盘上没有、git 也完全不认识的那些（宿主分类为
 * `gone`，见 `dsh/fileChange.ts`）。
 *
 * 现场：让模型提交时它常把提交信息写进 `commit.msg.txt`，提交完再删掉。这个文件
 * 进过 `write` 调用，于是永远留在 `produced` 里；磁盘上已经没有它，宿主按存在性
 * 归类成删除——界面上就冒出一条带删除线的 `commit.msg.txt`，看着像仓库里挂着一个
 * 待提交的删除（用户 2026-09-14 报的）。它既不在工作区清单里、也不在未跟踪清单里，
 * 说明这一轮对它的净效果就是零：不显示才是诚实的。
 *
 * 真被删掉的文件（git 有记录：跟踪中的删除）**照样显示**——那是仓库里真实存在的
 * 待提交改动，藏起来才是丢信息。
 *
 * @param kinds 宿主的分类表（键 = 芯片上的原样路径）；查不到（还没分类完/
 *   不在 git 仓库）时一律保留：**不确定 ≠ 净效果为零**。
 */
export function withoutVanished<T>(
  files: readonly T[],
  kinds: Record<string, FileChangeKind> | undefined,
  pathOf: (file: T) => string,
): T[] {
  if (!kinds) return [...files];
  return files.filter((file) => kinds[pathOf(file)] !== "gone");
}
