/**
 * 选区 / Range 安全判据的离线断言（无真实 DOM）。
 *
 * 高亮异步落地前必须判断活动选区是否与代码元素**相交**：只查 anchor/focus 是否都在
 * 元素内会漏掉「从段落拖进代码」「跨两张代码卡」的选区。这里用最小 stub 固定：
 * - 折叠 / 无 Range 不算；
 * - Range.intersectsNode 为真即算（哪怕两端都在元素外）；
 * - 没有 intersectsNode 时回退到共同祖先判据：祖先在本元素内、或祖先包含本元素都算；
 * - 多 Range 任一相交就算；
 * - detach / 跨 document / 接口抛错返回 false，不抛错；
 * - 脱树 Range 的 isConnected 判据拒绝导航。
 */
import assert from "node:assert";
import {
  rangeConnected,
  selectionIntersectsElement,
  type RangeLike,
  type SelectionLike,
} from "../src/webview/selectionRange";

type FakeNode = { isConnected: boolean; contains?: (node: unknown) => boolean };

function selectionOf(
  ranges: RangeLike | RangeLike[] | undefined,
  options: { collapsed?: boolean } = {},
): SelectionLike {
  const list = ranges === undefined ? [] : Array.isArray(ranges) ? ranges : [ranges];
  return {
    isCollapsed: options.collapsed ?? list.length === 0,
    rangeCount: list.length,
    getRangeAt: (index: number) => {
      const range = list[index];
      if (range === undefined) throw new Error("no range");
      return range;
    },
  };
}

const inside = { isConnected: true, contains: () => false } as unknown as FakeNode;
const outside = { isConnected: true, contains: () => false } as unknown as FakeNode;
/** 包住正文与代码卡的共同祖先：element 在它里面，它不在 element 里面。 */
const wrapper = { isConnected: true, contains: (node: unknown) => node === codeElement } as unknown as FakeNode;
const codeElement = {
  contains: (node: unknown) => node === inside,
} as unknown as Element;
const element = codeElement;

function rangeOf(options: { commonAncestor?: Node; intersects?: boolean | "throw"; startConnected?: boolean; endConnected?: boolean }): RangeLike {
  const start = { isConnected: options.startConnected ?? true } as unknown as Node;
  const end = { isConnected: options.endConnected ?? true } as unknown as Node;
  return {
    commonAncestorContainer: options.commonAncestor ?? outside,
    startContainer: start,
    endContainer: end,
    ...(options.intersects === undefined
      ? {}
      : {
          intersectsNode: () => {
            if (options.intersects === "throw") throw new Error("detached");
            return options.intersects;
          },
        }),
  };
}

// 折叠 / 没有 Range：不算活动（用户只是点了光标）。
assert.strictEqual(selectionIntersectsElement(element, selectionOf(undefined, {})), false);
assert.strictEqual(selectionIntersectsElement(element, selectionOf(rangeOf({}), { collapsed: true })), false);
assert.strictEqual(selectionIntersectsElement(element, null), false);

// 跨边界：两端都在元素外，但 Range 跨过元素——必须算活动。
assert.strictEqual(selectionIntersectsElement(element, selectionOf(rangeOf({ intersects: true }))), true);
assert.strictEqual(selectionIntersectsElement(element, selectionOf(rangeOf({ intersects: false }))), false);

// 没有 intersectsNode 时按共同祖先回退。
assert.strictEqual(selectionIntersectsElement(element, selectionOf(rangeOf({ commonAncestor: inside }))), true);
assert.strictEqual(selectionIntersectsElement(element, selectionOf(rangeOf({ commonAncestor: outside }))), false);

// 从段落拖进代码 / 跨两张卡：共同祖先在元素外，但包含本元素——必须算相交。
assert.strictEqual(
  selectionIntersectsElement(element, selectionOf(rangeOf({ commonAncestor: wrapper as unknown as Node }))),
  true,
  "共同祖先包含本元素时按相交处理（宁多冻结，不破选区）",
);

// 多 Range：第一个不相交、第二个相交，仍算活动。
assert.strictEqual(
  selectionIntersectsElement(
    element,
    selectionOf([rangeOf({ intersects: false }), rangeOf({ intersects: true })]),
  ),
  true,
);

// detach / 跨 document / 接口抛错：安全返回 false。
assert.strictEqual(selectionIntersectsElement(element, selectionOf(rangeOf({ intersects: "throw" }))), false);
{
  const broken: SelectionLike = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => {
      throw new Error("detached");
    },
  };
  assert.strictEqual(selectionIntersectsElement(element, broken), false);
}
console.log("selectionRange: 跨边界 / 折叠 / 多 Range / detach 的相交判据 ✓");

// 脱树 Range 拒绝导航。
assert.strictEqual(rangeConnected(rangeOf({})), true);
assert.strictEqual(rangeConnected(rangeOf({ startConnected: false })), false);
assert.strictEqual(rangeConnected(rangeOf({ endConnected: false })), false);
console.log("selectionRange: 脱树 Range 不再导航 ✓");

console.log("\nselectionRange: all assertions passed");
