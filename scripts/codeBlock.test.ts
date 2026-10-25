/**
 * 代码块卡片的默认折展状态。
 *
 * 用户 2026-10-25 口径：长代码块默认收起。阈值与折展入口共用同一个判据——
 * 超过 20 行的块才画箭头，所以「短块也必须展开」：它们没有可点的入口，
 * 一旦默认收起就再也打不开了。
 *
 * 用 `react-dom/server` 的 `renderToStaticMarkup` 断言**组件初始状态**，
 * 不是源码正则；`aria-expanded` 与无障碍名一并钉住。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `bridge.ts` 在模块求值期挂 `window` 监听；无头环境补最小实现，见 questionRender。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { CodeBlock } = await import("../src/webview/components/CodeBlock");
const { TextsContext, dictionaryFor } = await import("../src/webview/texts");

const codeWith = (lineCount: number): string =>
  Array.from({ length: lineCount }, (_, index) => `const v${index + 1} = ${index + 1};`).join("\n");

function render(code: string): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(CodeBlock, { lang: "ts", code }),
    ),
  );
}

// ---------- 1. 超过 20 行：默认收起 ----------
{
  const html = render(codeWith(21));
  assert.match(html, /class="code-block is-collapsed"/, "超过 20 行的代码块必须默认收起");
  assert.match(html, /aria-expanded="false"/, "默认收起时箭头读作「已收起」");
  assert.match(html, /aria-label="展开代码块全文"/, "收起态的入口是「展开」，不是「收起」");
  assert.ok(html.includes("const v21 = 21;"), "收起只是视觉折叠，完整正文仍要留在 DOM 里（复制 / 插入读整份）");
}

// ---------- 2. 阈值内：没有箭头，必须展开 ----------
{
  const html = render(codeWith(20));
  assert.match(html, /class="code-block"/, "20 行没有折展入口，必须保持展开");
  assert.ok(!html.includes("is-collapsed"), "阈值内的块不进入收起态");
  assert.ok(!html.includes("code-block-expand"), "短块不画折展箭头");
}

console.log("codeBlock: 长代码块默认收起、短块保持展开 ✓");
