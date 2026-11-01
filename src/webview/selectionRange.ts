/**
 * 选区和 DOM Range 的安全判据（webview）。
 *
 * 异步增强（代码高亮）落地时会替换代码卡内部的文本节点；只要用户的活动选区与这段
 * DOM 相交，替换就会破掉选区。判据不能只看 anchor/focus 是否都在元素内：用户可以从
 * 段落拖到代码、跨两张代码卡，Range 仍然跨过本元素。
 *
 * 两个函数都只做只读检查；detach、跨 document 或运行环境没有 `intersectsNode` 时
 * 走安全回退（contains）或返回 false，不抛错。
 */

/** `Selection` 的最小子集，便于无 DOM 的离线断言。 */
export interface SelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  getRangeAt(index: number): RangeLike;
}

/** `Range` 的最小子集。 */
export interface RangeLike {
  readonly commonAncestorContainer: Node;
  readonly startContainer: Node;
  readonly endContainer: Node;
  intersectsNode?(node: Node): boolean;
}

function currentSelection(): SelectionLike | null {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
  return window.getSelection();
}

/**
 * 活动选区是否与 `element` 相交（含选区一端在外、跨过本元素的场景）。
 *
 * 折叠选区不算；多 Range 逐一判断，任一相交即算。取不到 Range、Range 已脱树或
 * 接口抛错时返回 false。
 *
 * 没有 `intersectsNode` 时不能只看 `element.contains(commonAncestor)`：从段落拖进
 * 代码、或跨两张代码卡的选区，共同祖先在元素**外面**，那样会漏掉相交。回退判据
 * 同时接受「共同祖先包含本元素」——可能多冻结一段选区，但不会破坏用户选区。
 */
export function selectionIntersectsElement(
  element: Element,
  selection: SelectionLike | null = currentSelection(),
): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  try {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      if (typeof range.intersectsNode === "function") {
        if (range.intersectsNode(element)) return true;
        continue;
      }
      const ancestor = range.commonAncestorContainer;
      if (ancestor === element || element.contains(ancestor) || ancestor.contains(element)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Range 两端是否仍在文档里；脱树的旧 Range 不能再导航或绘制。 */
export function rangeConnected(range: RangeLike): boolean {
  try {
    return range.startContainer.isConnected && range.endContainer.isConnected;
  } catch {
    return false;
  }
}
