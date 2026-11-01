/**
 * 代码块**源文保真**的逐字符断言。
 *
 * 复制 / 插入载荷必须等于用户写进围栏或缩进的代码原文：CRLF、tab、行尾空白、
 * 闭合围栏前的空行、未闭合围栏的尾换行、容器前缀（引用 / 列表）、以及 tab 的
 * 视觉列（部分消费的 tab 变成空格）都不能丢或多吃。这里穿过真实解析入口
 * `parseMarkdown`，从 `codeSources` 取事件流结果，逐字符比较。
 *
 * 另钉住：内容字符以源码为准，不被 micromark 的 NUL → U+FFFD 规范化改写。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { parseMarkdown } from "../src/webview/markdown/parse";
import { codePayload } from "../src/webview/markdown/source";

type RootContent = { type: string; children?: RootContent[] };

const codeNodes = (node: RootContent, out: RootContent[] = []): RootContent[] => {
  if (node.type === "code") out.push(node);
  for (const child of node.children ?? []) codeNodes(child, out);
  return out;
};

const cases: [string, string, string][] = [
  ["fenced-crlf", "```ts\r\n\talpha  \r\nbeta\r\n```", "\talpha  \r\nbeta"],
  ["fenced-trailing-blank", "```ts\r\nalpha  \r\n\r\n```", "alpha  \r\n"],
  ["fenced-mixed-eol", "```text\nalpha\r\nbeta\n\r\n```", "alpha\r\nbeta\n"],
  ["unclosed-crlf", "```ts\r\nalpha\r\n", "alpha\r\n"],
  ["unclosed-multiple-blank", "```ts\nalpha\n\n", "alpha\n\n"],
  ["tilde", "~~~~text\nalpha\n~~~\n~~~~", "alpha\n~~~"],
  ["long-backtick", "````js\nconst x = `a`;\n```\n````", "const x = `a`;\n```"],
  ["blockquote-crlf", "> ```ts\r\n> alpha  \r\n> \tbeta\r\n> ```", "alpha  \r\n\tbeta"],
  ["list-crlf", "- label\r\n\r\n  ```ts\r\n  alpha  \r\n  \tbeta\r\n  ```", "alpha  \r\n\tbeta"],
  ["nested-list-quote", "- label\n\n  > ```ts\n  > alpha  \n  > \tbeta\n  > ```", "alpha  \n\tbeta"],
  ["empty-fenced", "```\n```", ""],
  ["spaces-before-closer", "```ts\nalpha\n   ```", "alpha"],
  ["indented-crlf", "    a\r\n    b\r\n", "a\r\nb\r\n"],
  ["indented-trailing-blank", "    a\n    b\n\n", "a\nb\n"],
  ["indented-internal-blank", "    a\n\n    b\n", "a\n\nb\n"],
  ["quote-indented", ">     a\r\n>     b\r\n", "a\r\nb\r\n"],
  ["list-indented", "- label\r\n\r\n      a\r\n      b\r\n", "a\r\nb\r\n"],
  ["indented-quote-blank", ">     a\r\n>\r\n>     b\r\n", "a\r\n\r\nb\r\n"],
  ["indented-list-blank", "- label\r\n\r\n      a\r\n\r\n      b\r\n", "a\r\n\r\nb\r\n"],
  ["quote-two-tabs", "> \t\ta\r\n> \t\tb\r\n", "  a\r\n  b\r\n"],
  ["tab-two", "\t\ta\r\n\t\tb\r\n", "\ta\r\n\tb\r\n"],
  ["space-tab", "  \ta\r\n  \tb\r\n", "a\r\nb\r\n"],
  ["tab-space", "\t a\r\n\t b\r\n", " a\r\n b\r\n"],
  ["five-spaces", "     a\r\n", " a\r\n"],
  ["nested", "- a\r\n  - b\r\n\r\n        x\r\n        y\r\n", "x\r\ny\r\n"],
  ["fenced-list-tab-unclosed", "-\t```ts\r\n    a\r\n", "a\r\n"],
  ["fenced-list-tab-closed", "-\t```ts\r\n    a\r\n    ```", "a"],
  ["fenced-ordered-tab", "1.\t```ts\r\n    a\r\n", "a\r\n"],
  ["fenced-list-tab-quote", "> -\t```ts\r\n>   a\r\n", "a\r\n"],
  ["fenced-indented", "  ```\n  a\n  ```", "a"],
  ["fenced-list-indent", "-   ```\n    a\n    ```", "a"],
  ["spaces-line", "```\n   \n\t\n```", "   \n\t"],
  ["code-only-fence", "```", ""],
  [
    "nul-and-replacement",
    "```text\r\nA\u0000\uFFFD😀e\u0301\u200D\r\n```",
    "A\u0000\uFFFD😀e\u0301\u200D",
  ],
  ["nul-indented", "    A\u0000B\n", "A\u0000B\n"],
  [
    "partial-tab-nul-replacement",
    "> \t\tA\u0000\uFFFD\r\n> \t\tB\r\n",
    "  A\u0000\uFFFD\r\n  B\r\n",
  ],
];

for (const [name, source, expected] of cases) {
  const document = parseMarkdown(source);
  const nodes = codeNodes(document.root as unknown as RootContent);
  assert.strictEqual(nodes.length, 1, `${name}: 应当只有一个代码节点`);
  const node = nodes[0]! as never;
  const payload = codePayload(node, source, document.codeSources);
  assert.strictEqual(payload.origin, "source", `${name}: 合法代码必须走源码边界，不能回落 node.value`);
  assert.deepStrictEqual(payload.text, expected, `${name}: 代码载荷逐字符相等`);
}
console.log(`markdown-source: ${cases.length} 条代码原文（容器 / tab 视觉列 / EOL / NUL）逐字符相等 ✓`);

// 同一文档内多个代码块各自取自己的源码，不串行、不互相污染。
{
  const source = "```\r\nfirst\r\n```\r\n\r\n>     second\r\n";
  const document = parseMarkdown(source);
  const nodes = codeNodes(document.root as unknown as RootContent);
  assert.strictEqual(nodes.length, 2);
  assert.deepStrictEqual(
    nodes.map((node) => codePayload(node as never, source, document.codeSources).text),
    ["first", "second\r\n"],
  );
}
console.log("markdown-source: 同一文档多个代码块各取各的源文 ✓");

console.log("\nmarkdown-source: all assertions passed");
