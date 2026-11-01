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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function render(code: string, phase?: "streaming" | "settled"): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(CodeBlock, { lang: "ts", code, phase }),
    ),
  );
}

// ---------- 1. 超过 20 行：默认收起 ----------
{
  const html = render(codeWith(21));
  assert.match(html, /class="code-block is-collapsed"/, "超过 20 行的代码块必须默认收起");
  assert.match(html, /aria-expanded="false"/, "默认收起时箭头读作「已收起」");
  assert.match(html, /aria-label="展开代码块全文"/, "收起态的入口是「展开」，不是「收起」");
  assert.ok(html.includes("const v21 = 21;"), "收起只是视觉折叠，完整正文仍要留在 DOM 里（复制读整份）");
}

// ---------- 2. 阈值内：没有箭头，必须展开 ----------
{
  const html = render(codeWith(20));
  assert.match(html, /class="code-block"/, "20 行没有折展入口，必须保持展开");
  assert.ok(!html.includes("is-collapsed"), "阈值内的块不进入收起态");
  assert.ok(!html.includes("code-block-expand"), "短块不画折展箭头");
}

console.log("codeBlock: 长代码块默认收起、短块保持展开 ✓");

// ---------- 3. SSR：不初始化高亮引擎，settled / streaming 都输出纯文本 ----------
for (const phase of ["settled", "streaming"] as const) {
  const html = render(codeWith(3), phase);
  assert.ok(!html.includes("md-code-token"), `${phase} 的 SSR 输出不能有高亮 span`);
  assert.ok(!html.includes("var(--md-code-"), `${phase} 的 SSR 输出不能出现主题变量`);
  assert.ok(html.includes("const v3 = 3;"), `${phase} 的 SSR 输出保留完整代码文本`);
}
console.log("codeBlock: SSR 不初始化高亮、输出纯文本 ✓");

// ---------- 4. 复制取精确 code，数学源文逐字保留 ----------
// 源码接线 + SSR 文本断言，不冒充 DOM 点击或系统剪贴板证明。
{
  const source = readFileSync(
    join(process.cwd(), "src", "webview", "components", "CodeBlock.tsx"),
    "utf8",
  );
  assert.match(
    source,
    /onClick=\{\(\) => post\(\{ type: "copy", text: code \}\)\}/,
    "复制按钮载荷是组件收到的原 code",
  );

  // 头部只留复制一枚按钮：用户 2026-11-02 口径是「插入到当前编辑器」没有用处
  // （插入位置由当时的活动编辑器决定，与该代码块无关；没有编辑器时又退化成复制）。
  assert.ok(!source.includes("insertText"), "卡片头部不再有「插入到当前编辑器」按钮");
  const header = render(codeWith(2));
  assert.strictEqual(
    header.split('class="icon-btn"').length - 1,
    1,
    "代码块头部只有一枚图标按钮（复制）；不许残留第二枚",
  );

  const mathSource = "行内 $x+y$ 与分式 \\frac{a}{b}";
  const html = render(mathSource);
  assert.ok(html.includes("$x+y$"), "代码块里的 $x+y$ 逐字保留");
  assert.ok(html.includes("\\frac{a}{b}"), "代码块里的 \\frac 逐字保留");
  assert.ok(!html.includes("data-math-view"), "代码块不把数学源码解析成公式");
}
console.log("codeBlock: 复制取精确 code、数学源文不解析 ✓");
