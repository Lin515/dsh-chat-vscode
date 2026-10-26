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

import type { DeliverableView, FileChangeKind } from "../shared/chat";
import { workspacePathKey } from "../shared/workspacePath";

/** 交付文件（`deliverables` / `presented`）里判重需要的最小形状。 */
export interface DeliverablePath {
  path: string;
  description?: string;
}

/** 产物条目的最小形状（`MessageView.produced` 的操作或旧版裸路径）。 */
export interface ProducedPath {
  path: string;
}

/**
 * 比较用的路径键：交给跨平台纯字符串判据（见 `shared/workspacePath.ts`）。
 *
 * Windows 形态的路径统一分隔符并去尾分隔符；**不**转小写、**不**消 `.` / `..`：
 * POSIX 上 `A.ts` 与 `a.ts` 是两个文件，符号链接下 `link/../x` 与 `x` 也可能不同。
 * 展示去重只允许合并能证明相同的拼写。
 */
function pathKey(path: string): string {
  return workspacePathKey(path);
}

/**
 * 「本轮文件改动」行最终要列的文件：从 `produced` 里去掉已经申报交付的那些。
 *
 * 产物按**展示路径**首次出现去重（官方 `producedForClosing` 同口径），但产物操作
 * 本身不去重——同一路径的多个参数别名留在 `message.produced` 里供正文行内代码匹配。
 *
 * @param produced 本轮成功的写类调用登记的操作（或旧的裸路径，保持原顺序）。
 * @param deliverables `present` 申报的交付文件。
 * @returns 仍需在「本轮文件改动」里出现的路径；空数组表示这一行不该显示。
 */
export function producedOnly(
  produced: readonly (string | ProducedPath)[] | undefined,
  deliverables: readonly DeliverablePath[] | undefined,
): string[] {
  if (!produced?.length) return [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of produced) {
    const path = typeof entry === "string" ? entry : entry.path;
    if (typeof path !== "string" || path === "") continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path);
  }
  if (!deliverables?.length) return unique;
  const delivered = new Set(deliverables.map((file) => pathKey(file.path)));
  return unique.filter((path) => !delivered.has(pathKey(path)));
}

/**
 * 轮尾交付行要显示的文件：**同一路径只留最后一次申报**。
 *
 * `present` 可以在同一轮里被调用多次，适配器把每次事件的合法文件都累积下来，于是
 * 同一路径可能出现多条。显示口径与官方 `presentedForClosing` 一致：按路径首次出现
 * 的位置排列，值取**最后一次**申报（那次带的说明才是最终的）。
 *
 * 去重键用 `workspacePathKey`（只合并能证明相同的拼写，不转小写、不消点）。
 */
export function deliverablesForClosing(
  deliverables: readonly DeliverableView[] | undefined,
): DeliverableView[] {
  if (!deliverables?.length) return [];
  const byPath = new Map<string, DeliverableView>();
  for (const file of deliverables) {
    if (typeof file?.path !== "string" || file.path === "") continue;
    byPath.set(pathKey(file.path), file);
  }
  return [...byPath.values()];
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
