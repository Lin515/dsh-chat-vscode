/**
 * 改动清单的缓存键（宿主与界面两边共用同一份算法）。
 *
 * **必须带会话 id**：事件 seq 是**每个会话各自编号**的，只用 seq 做键会让两个会话的
 * 同号事件互相串清单——界面上表现为「这个会话的卡片显示的是另一个会话改的文件」，
 * 而它恰好只在两个会话都跑过、且改动轮次的 seq 编号撞上时出现，极难现场复现。
 */
import type { ChangedFileView } from "./chat";
import {
  isAbsoluteWorkspacePath,
  resolveWorkspacePath,
  workspacePathKey,
} from "./workspacePath";

export function changesSummaryKey(sessionId: string, seq: number): string {
  return `${sessionId}\u0000${seq}`;
}

/** 卡片折叠前铺出来的行数（官方 `ui-deliverables` 的同一口径：先 3 行）。 */
export const CHANGES_CARD_VISIBLE = 3;

/**
 * 卡片当前该显示哪些文件行。
 *
 * 折叠只看 `files`（Host 已按 `display` 排好序），`total` 只用于标题里的计数——
 * 被 Host 上限截掉的文件根本没进 `files`，展开也变不出来。
 */
export function visibleChangeFiles<T>(files: readonly T[], expanded: boolean): T[] {
  return expanded ? [...files] : files.slice(0, CHANGES_CARD_VISIBLE);
}

/** `turnsWithChangesCard` 需要的最小形状（`MessageView` 与测试夹具都满足）。 */
export interface ChangesCardMessage {
  changes?: { turn: number; seq: number };
}

/**
 * 哪些**轮次**真的会显示改动文件卡片。
 *
 * 让位判定必须按轮、不能按消息：一轮被插话切成多段时（`a:N` / `a:N:2`…），卡片挂在
 * 最后一段，而 `produced` 往往挂在前一段——按消息判定就成了「这一段显示卡片、那一段
 * 显示本轮改动」，同一轮尾部同时冒出好几样（用户 2026-09-21 报告的混乱）。
 *
 * 判据与卡片自己的渲染条件一致（清单到手且至少列了一个文件）：拿不到清单的那一轮
 * 不该把「本轮改动」行顶掉，否则那一轮的文件就两头都没了。
 */
export function turnsWithChangesCard<T extends ChangesCardMessage>(
  messages: readonly T[],
  summaryFor: (seq: number) => { files: readonly unknown[] } | null | undefined,
): Set<number> {
  const turns = new Set<number>();
  for (const message of messages) {
    const coordinates = message.changes;
    if (!coordinates) continue;
    const summary = summaryFor(coordinates.seq);
    if (summary && summary.files.length > 0) turns.add(coordinates.turn);
  }
  return turns;
}

/**
 * 一个候选路径在「改动清单的固定根」下的等价拼写。
 *
 * 清单里的 `path` 由 Host 的 `durablePathOf` 生成：**根内相对、根外绝对**，根是
 * recorder 确定的规范化创建目录。这里的候选来自产物 / 交付（`present` 由服务端
 * 规范成绝对路径，旧产物可能是相对参数）。字符串层面只能做两种比较：
 *
 * - 原样键：绝对对绝对、相对对相对；
 * - 相对路径拼上**创建目录**后的键：让根内相对行能与绝对候选对上。
 *
 * 拼接不做 realpath、不消 `.` / `..`：规范化根与 header 原始拼写可能不同（符号链接），
 * 拼不上就说明**证明不了**，此时宁可不挂坐标。交给执行世界验证的那一步仍由清单
 * 自身的 `seq` / `index` 完成。
 */
function comparableChangeSpellings(cwd: string | undefined, path: string): string[] {
  const spellings = new Set<string>();
  const direct = workspacePathKey(path);
  if (direct !== "") spellings.add(direct);
  if (!isAbsoluteWorkspacePath(path) && cwd !== undefined && isAbsoluteWorkspacePath(cwd)) {
    spellings.add(workspacePathKey(resolveWorkspacePath(cwd, path)));
  }
  return [...spellings];
}

/**
 * 芯片路径 → 本轮改动清单里的下标；证明不了同一目标时返回 undefined。
 *
 * 这是**展示关联**，不是文件身份：真正打开时只用清单自己的 `seq` / `index`。因此
 * 只做能确定目标的字符串比较——不用 basename、不转小写、不消点、不拿最新执行目录
 * 猜。大小写不同的 POSIX 路径因此保持为两行，不会被错误地挂到彼此的快照上。
 *
 * @param files Host 清单里的文件（`path` 根内相对、根外绝对）。
 * @param cwd 会话**创建目录**（header.cwd 的原始拼写）。
 * @param path 候选（产物记录值或交付路径）。
 */
export function changeIndexForPath(
  files: readonly ChangedFileView[],
  cwd: string | undefined,
  path: string,
): number | undefined {
  const target = comparableChangeSpellings(cwd, path);
  if (target.length === 0) return undefined;
  const wanted = new Set(target);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    const fileSpellings = comparableChangeSpellings(cwd, file.path);
    if (fileSpellings.some((spelling) => wanted.has(spelling))) return index;
  }
  return undefined;
}
