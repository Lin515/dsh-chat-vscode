/**
 * 思考档位分段控件的列数。
 *
 * 规则（用户指定）：
 * - **4 档及以下 → 一行**；
 * - **5 / 6 档 → 两行**，且两行要**分得均匀**（5 → 3+2，6 → 3+3）。
 *
 * 为什么要显式定列数，而不是交给 `flex-wrap` 自然换行：
 * 自然换行只保证「放不下就折」，折不折、折成几比几完全取决于弹层宽度与文案长度。
 * 实测 5 档在短英文名（off/minimal/low/high/max）下能挤进一行，而中文名或稍长的
 * 文案会折成 4+1 这种一头重的分布——同一个模型在不同语言下排版还不一样。
 * 显式定列数后行为可预期。
 *
 * 与 vscode / React 无关，便于离线测试。
 */

/** 一行最多放几个（超过就分两行；两行仍放不下时按这个上限继续排第三行）。 */
const MAX_PER_ROW = 4;

/** 一行的分界：不超过它就用一行。 */
const SINGLE_ROW_MAX = 4;

/**
 * 返回每行放几个；`undefined` 表示「不约束，交给自然布局」（即一行）。
 *
 * @param count 档位总数
 */
export function segmentColumns(count: number): number | undefined {
  if (!Number.isFinite(count) || count <= SINGLE_ROW_MAX) return undefined;
  // 分两行：向上取整让第一行不少于第二行（5 → 3+2），视觉上更稳
  return Math.min(MAX_PER_ROW, Math.ceil(count / 2));
}
