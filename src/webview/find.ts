/**
 * 会话查找（Ctrl+F）的**纯逻辑**（无 DOM，无 react；断言见 `scripts/find.test.ts`）。
 *
 * VS Code 的 webview 拿不到编辑器的原生查找部件（microsoft/vscode#173643 还开着），
 * 与官方 Chat 1.134 的「Find in chat」一样自绘：查找条 + 计数 + 上一处 / 下一处。
 * 本扩展不做替换、不做正则（用户口径），所以纯逻辑只剩两件事——
 * 在文本节点序列上定位子串、以及环绕式的激活下标推进。
 *
 * 匹配口径：**原样子串、大小写不敏感、从左往右不重叠**（与 VS Code 编辑器查找
 * 同一条）。不做 trim：查找条里的空格是查找内容的一部分。
 *
 * DOM 那一半（TreeWalker 采文本节点、构造 Range、登记 CSS Custom Highlight）
 * 在 `components/FindBar.tsx`——高亮只登记 Range 不改 DOM，React 流式重渲染
 * 不会被高亮标记冲掉。
 */

/** 一处命中落在单个文本节点上的区间（`end` 不含）。 */
export interface MatchSpan {
  /** 文本节点在节点序列里的下标。 */
  node: number;
  /** 在该节点文本里的起止。 */
  start: number;
  end: number;
}

/**
 * 一处命中 = 它横跨的每一段文本节点上各一个区间。
 *
 * 命中可以跨节点（比如 `foo**bar**` 里查 `foobar`，粗体标签把文本劈成两段），
 * 所以一处命中是**一组**区间；DOM 侧给每段各造一个 Range。
 */
export type TextMatch = MatchSpan[];

/** CSS Custom Highlight API 里「全部命中」的登记名（`::highlight()` 选择器同字面）。 */
export const FIND_ALL_HIGHLIGHT = "dsh-find-all";
/** 「当前命中」的登记名（与编辑器查找的当前项同一个语义，配色更深）。 */
export const FIND_CURRENT_HIGHLIGHT = "dsh-find-current";

/**
 * 在文本节点序列里找出 `needle` 的全部出现。
 *
 * `nodeTexts` 必须按**文档序**（TreeWalker 的产出序）：拼接顺序才是阅读顺序，
 * 跨节点的命中才能对回正确的节点。大小写折叠用 `toLowerCase`（与轨迹页的
 * 过滤搜索同一口径）；`needle` 为空串返回空表。
 */
export function computeMatches(nodeTexts: readonly string[], needle: string): TextMatch[] {
  if (needle.length === 0) return [];
  const lowerNodes = nodeTexts.map((text) => text.toLowerCase());
  /** 每个节点在拼接串里的起点。 */
  const offsets: number[] = [];
  let total = 0;
  for (const text of lowerNodes) {
    offsets.push(total);
    total += text.length;
  }
  const haystack = lowerNodes.join("");
  const lowerNeedle = needle.toLowerCase();
  if (lowerNeedle.length > haystack.length) return [];

  const matches: TextMatch[] = [];
  let at = haystack.indexOf(lowerNeedle);
  while (at >= 0) {
    matches.push(spansFor(offsets, lowerNodes, at, at + lowerNeedle.length));
    // 不重叠：下一轮从这一处结尾之后继续（"aaa" 查 "aa" 只有一处）
    at = haystack.indexOf(lowerNeedle, at + lowerNeedle.length);
  }
  return matches;
}

/** 把拼接串上的区间 `[from, to)` 摊回各文本节点（命中跨节点时逐段给）。 */
function spansFor(
  offsets: readonly number[],
  lowerNodes: readonly string[],
  from: number,
  to: number,
): TextMatch {
  const spans: MatchSpan[] = [];
  for (let node = 0; node < lowerNodes.length; node += 1) {
    const start = offsets[node];
    const end = start + lowerNodes[node].length;
    if (end <= from) continue;
    if (start >= to) break;
    const span = { node, start: Math.max(from, start) - start, end: Math.min(to, end) - start };
    // 空文本节点上不落零长区间（对不上的高亮没有意义）
    if (span.start < span.end) spans.push(span);
  }
  return spans;
}

/**
 * 激活下标推进（环绕）：`delta` 正负都行，越界从另一头绕回来。
 * `total <= 0` 时恒返回 0（调用方以「有没有命中」为准，不以下标为准）。
 */
export function stepActive(current: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const next = (current + delta) % total;
  return next < 0 ? next + total : next;
}
