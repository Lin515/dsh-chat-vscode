/**
 * 子代理树的**界面侧读法**（标题点击后的清单用）。
 *
 * 宿主已经把树先序展开成扁平节点（见 `dsh/subagentTree.ts`），这里只做两件不会
 * 画错层级的小事：
 * - 数「当前会话下面一共有多少子代理」——按 `parentSessionId` 沿树往下圈，包含
 *   多层后代，不是只数直接下级；
 * - 找当前节点（标题 / 高亮用）。
 *
 * 纯函数、不引 React：断言见 `scripts/subagentTree.test.ts`。
 */
import type { SubagentTreeNodeView } from "../shared/chat";

/** 当前会话的**全部后代**（先序，含多层嵌套；不含当前自己）。 */
export function subagentDescendants(
  sessionId: string | undefined,
  nodes: readonly SubagentTreeNodeView[],
): SubagentTreeNodeView[] {
  if (!sessionId) return [];
  const ids = new Set<string>([sessionId]);
  const found: SubagentTreeNodeView[] = [];
  // 节点已经是先序：父一定在子之前，所以顺着一遍就能圈完；`found` 的顺序也就是
  // 树里的显示顺序。
  for (const node of nodes) {
    if (!ids.has(node.parentSessionId)) continue;
    ids.add(node.id);
    found.push(node);
  }
  return found;
}

/** 当前会话在树里的那一行（顶层会话没有对应节点时返回 `undefined`）。 */
export function subagentCurrentNode(
  sessionId: string | undefined,
  nodes: readonly SubagentTreeNodeView[],
): SubagentTreeNodeView | undefined {
  if (!sessionId) return undefined;
  return nodes.find((node) => node.id === sessionId);
}
