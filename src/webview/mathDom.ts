/**
 * 可信 MathView 辅助层的判据（webview，无 React）。
 *
 * 识别数学只能看组件写在根上的 `data-math-view`，不能看 `.math-view` / `.katex`
 * 这类 class：class 可以出现在任意字符串里，根属性才是 React 自持的来源。KaTeX
 * 的辅助层由净化链保证结构（`.katex-mathml` 里的 `math` / `annotation`），所以
 * 判据仍要求它落在带来源标识的根内。
 *
 * 不按 `aria-hidden` 判断辅助层：KaTeX 的**视觉层** `.katex-html` 恰好也带
 * `aria-hidden`，泛化排除会把真正显示出来的公式文字也删掉。这里只认结构。
 * 查找采文本时跳过辅助层，保留视觉层；没有第二条消费者。
 */

/** MathView 根上的来源标识；MathView 组件与这里必须使用同一个属性名。 */
const MATH_ROOT_SELECTOR = "[data-math-view]";

function elementOf(node: Node | null): Element | null {
  if (node === null) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * 节点是否位于可信 MathView 的辅助层。
 *
 * 优先 `.katex-mathml`：选区端点落进 `annotation` / `math` 时也仍能认出整个隐藏层
 * 属于辅助文本。没有 `.katex-mathml` 的异常结构再退到 `math` / `annotation`，但
 * 三者都必须位于可信 MathView 根内。
 */
export function isOwnedMathAux(node: Node | null): boolean {
  const element = elementOf(node);
  if (element === null) return false;
  const root = element.closest(MATH_ROOT_SELECTOR);
  if (root === null) return false;

  const mathml = element.closest(".katex-mathml");
  if (mathml !== null && root.contains(mathml)) return true;

  const math = element.closest("math");
  if (math !== null && root.contains(math)) return true;

  const annotation = element.closest("annotation");
  return annotation !== null && root.contains(annotation);
}
