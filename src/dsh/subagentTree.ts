/**
 * 子代理树的**组装**（用户 2026-10-20 口径：标题点击后展开「顶层会话 + 多层子代理树」）。
 *
 * 输入是宿主手里的两条事实：
 * - 顶层会话的 id / 标题 / 运行态；
 * - `childrenOf(parentId)`：某一级子代理的**直接下级**，已由调用方按判定时间排好序
 *   （排序口径见 `subagentOrder.ts`，这里不重复实现）。
 *
 * 输出先序扁平的 `SubagentTreeNodeView[]`：第 1 层是顶层会话直接调用的子代理，
 * 与顶层会话行同级对齐；更深层逐级缩进。父链断掉（某条子代理的上层不在索引里）
 * 的节点不会被硬塞进根下——宁可少一行，也不把层级画错。
 *
 * 纯函数、不碰 React / vscode：断言见 `scripts/subagentTree.test.ts`。
 */
import type { SubagentTreeView, SubagentTreeNodeView, SubagentView } from "../shared/chat";

export interface SubagentTreeInput {
  root: SubagentTreeView["root"];
  /** 直接下级（已排序）；同一个 id 在树里只出现一次。 */
  childrenOf: (parentId: string) => readonly SubagentView[];
}

/** 先序组装整棵树；环（异常数据）由 `seen` 截断，不会无限递归。 */
export function buildSubagentTree(input: SubagentTreeInput): SubagentTreeView {
  const nodes: SubagentTreeNodeView[] = [];
  const seen = new Set<string>([input.root.id]);

  const walk = (parentId: string, depth: number): void => {
    for (const child of input.childrenOf(parentId)) {
      if (!child.id || seen.has(child.id)) continue;
      seen.add(child.id);
      nodes.push({ ...child, parentSessionId: parentId, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(input.root.id, 1);

  return { root: input.root, nodes };
}
