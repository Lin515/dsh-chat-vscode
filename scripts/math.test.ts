/**
 * 完成态数学的**解析事实**（不接 KaTeX / MathView）。
 *
 * 这里穿过正式解析入口，钉住：
 *
 * - 保守金额规则：三个普通金额例、密集金额、金额后紧接 `$\alpha$` / `$-x$` 公式
 *   不误吞；`$5$`、`$5+10$`、`$5 $`、`$x$2`、`$5,$`、`$5.$` 仍是明确数学；
 * - 单遍解析事实：`raw` 是 `position` 的源码切片，`tex` 是官方去容器标记后的
 *   `node.value`；`closed` 只由 flow 围栏 token 事实决定，`$$\nx+y $$` 未闭合；
 * - 产品形态由定界符决定：`$$` / `\[` 是 display（同线 `$$` 的 inlineMath 也是），
 *   `$` / `\(` 是 inline；
 * - 源码不被改写：PUA、实体、CRLF、NUL、U+FFFD、尾空行原样保留；
 * - `math` 围栏仍是 code，`tex` / `latex` 永不进入数学；未识别 math 节点在渲染层
 *   回退为原文，不吞内容；
 * - 与 vendor `parseGfmWithMath`（非金额语料）去事实键后树等价，防止本地装配漂移。
 *
 * KaTeX → 官方 React 排版、FindBar 辅助层过滤与选区冻结由对应视图测试覆盖。
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Code, Root, RootContent } from "mdast";
import { Markdown } from "../src/webview/components/Markdown";
import type { MarkdownDocument } from "../src/webview/markdown/parse";
import {
  mathFenceSource,
  mathSourceOf,
  parseGfmMarkdown,
  parseMarkdown,
  parseSettledRoot,
  type MathSource,
} from "../src/webview/markdown/parse";
import { renderMarkdownDocument } from "../src/webview/markdown/render";
import { dictionaryFor, TextsContext } from "../src/webview/texts";
import { parseGfmWithMath } from "../src/vendor/ui-primitives/markdown/parse";

type Node = Root | RootContent;

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  if ("children" in node) {
    for (const child of node.children) walk(child, visit);
  }
}

function mathNodes(root: Root): RootContent[] {
  const nodes: RootContent[] = [];
  walk(root, (node) => {
    if (node.type === "math" || node.type === "inlineMath") nodes.push(node as RootContent);
  });
  return nodes;
}

function mathSources(root: Root): MathSource[] {
  const sources: MathSource[] = [];
  walk(root, (node) => {
    const fact = mathSourceOf(node as RootContent);
    if (fact !== undefined) sources.push(fact);
  });
  return sources;
}

function codeNodes(root: Root): Code[] {
  const nodes: Code[] = [];
  walk(root, (node) => {
    if (node.type === "code") nodes.push(node as Code);
  });
  return nodes;
}

function textValues(root: Root): string {
  const values: string[] = [];
  walk(root, (node) => {
    if (node.type === "text") values.push(node.value);
  });
  return values.join("");
}

const parse = (source: string): MarkdownDocument => parseMarkdown(source);
const sourcesOf = (source: string): MathSource[] => mathSources(parse(source).root);

function only(source: string): MathSource {
  const found = sourcesOf(source);
  assert.strictEqual(found.length, 1, `${JSON.stringify(source)}: 应恰好一个公式候选`);
  return found[0]!;
}

function assertPlain(source: string, label: string): void {
  assert.deepStrictEqual(sourcesOf(source), [], `${label}: 不产生公式候选`);
}

// ---------- 1. 普通金额不误吞 ----------
{
  const plain: [string, string, string | undefined][] = [
    ["currency-pair", "Costs $5 and $10.", "Costs $5 and $10."],
    ["currency-cjk", "$5.00、$10.00", "$5.00、$10.00"],
    ["currency-sentence", "Costs $5. It costs $10.", "Costs $5. It costs $10."],
    ["dense-amounts", "Pay $5 and $10 and $20.", "Pay $5 and $10 and $20."],
    ["dense-sentence", "Costs $5.00. Then $10.00 and $20.00.", "Costs $5.00. Then $10.00 and $20.00."],
    ["blockquote-amounts", "> Costs $5 and $10.", "Costs $5 and $10."],
    ["list-amounts", "- Costs $5 and $10.", "Costs $5 and $10."],
    ["link-label-amounts", "[Costs $5 and $10.](https://example.test)", "Costs $5 and $10."],
    ["inline-code-amounts", "`$5 and $10`", undefined],
  ];
  for (const [name, source, text] of plain) {
    assertPlain(source, name);
    assert.strictEqual(parse(source).source, source, `${name}: 文档源文不变`);
    if (text !== undefined) {
      assert.strictEqual(textValues(parse(source).root), text, `${name}: 普通金额原文逐字保留`);
    }
  }
  console.log(`math: ${plain.length} 条普通金额（含引用 / 列表 / 链接标签 / 行内代码）不误吞 ✓`);
}

// 金额后紧接下一段公式：第二公式以 `\alpha` / `-x` / `x` 开头都不能被第一对吞掉。
{
  const cases: [string, string, string, string][] = [
    ["currency-then-command", "Pay $5 and $\\alpha$", "$\\alpha$", "\\alpha"],
    ["currency-then-negative", "Pay $5 and $-x$", "$-x$", "-x"],
    ["currency-then-letter", "Pay $5 and $x$", "$x$", "x"],
    ["dense-then-command", "Pay $5 and $10 and $\\alpha$", "$\\alpha$", "\\alpha"],
    ["dense-then-negative", "Pay $5 and $10 and $-x$", "$-x$", "-x"],
    ["currency-then-plus", "Pay $5 and $+x$", "$+x$", "+x"],
    ["currency-cjk-then-command", "$5.00、$\\alpha$", "$\\alpha$", "\\alpha"],
    ["currency-cjk-then-negative", "$5.00、$-x$", "$-x$", "-x"],
    ["currency-word-then-command", "$5 USD and $\\alpha$", "$\\alpha$", "\\alpha"],
    ["currency-after-formula", "Pay $5 and $x$ and $10.", "$x$", "x"],
  ];
  for (const [name, source, raw, tex] of cases) {
    const fact = only(source);
    assert.deepStrictEqual(
      { raw: fact.raw, tex: fact.tex, form: fact.form, closed: fact.closed },
      { raw, tex, form: "inline", closed: true },
      `${name}: 只保留后一个公式`,
    );
  }
  console.log("math: 金额后的 TeX 命令 / 负号 / 普通变量公式均保留，不被第一对吞掉 ✓");
}

// ---------- 2. 明确数学的既定 counterexamples 不被降级 ----------
{
  const keep: [string, string, string, "inline" | "display"][] = [
    ["single-numeric", "$5$", "5", "inline"],
    ["numeric-expression", "$5+10$", "5+10", "inline"],
    ["math-then-digit", "$x$2", "x", "inline"],
    ["numeric-comma", "$5,$", "5,", "inline"],
    ["numeric-period", "$5.$", "5.", "inline"],
    ["padded-numeric", "$ 5 $", "5", "inline"],
    ["numeric-then-text", "$5$10", "5", "inline"],
    ["paren", "\\(x+y\\)", "x+y", "inline"],
    ["bracket-flow", "\\[x+y\\]", "x+y", "display"],
  ];
  for (const [name, source, tex, form] of keep) {
    const fact = only(source);
    assert.deepStrictEqual(
      { raw: fact.raw, tex: fact.tex, form: fact.form, closed: fact.closed },
      { raw: fact.raw, tex, form, closed: true },
      `${name}: 保留明确数学`,
    );
  }
  const padded = sourcesOf("$5 $ and $x$");
  assert.deepStrictEqual(padded.map((fact) => fact.raw), ["$5 $", "$x$"]);
  assert.deepStrictEqual(padded.map((fact) => fact.form), ["inline", "inline"]);
  const commaFormula = only("$5, $x$");
  assert.strictEqual(commaFormula.raw, "$x$", "金额后的 `$x$` 保留，金额本身保持普通文本");
  console.log("math: $5$ / $5+10$ / $5 $ / $x$2 / $5,$ / $5.$ 等明确数学不被金额规则误伤 ✓");
}

// ---------- 3. 四类定界符、同线 $$ 的 display 契约 ----------
{
  const source = "Inline $x+y$ and \\(a+b\\).\n\n$$x^2+y^2$$\n\n\\[\\frac{1}{2}\\]";
  const facts = sourcesOf(source);
  assert.deepStrictEqual(
    facts.map((fact) => [fact.delimiter, fact.form, fact.closed, fact.raw, fact.tex]),
    [
      ["$", "inline", true, "$x+y$", "x+y"],
      ["\\(", "inline", true, "\\(a+b\\)", "a+b"],
      ["$$", "display", true, "$$x^2+y^2$$", "x^2+y^2"],
      ["\\[", "display", true, "\\[\\frac{1}{2}\\]", "\\frac{1}{2}"],
    ],
    "四类定界符的形态 / 闭合 / 原文 / 有效载荷",
  );

  const middle = only("Before $$x+y$$ after.");
  assert.deepStrictEqual(
    { raw: middle.raw, tex: middle.tex, form: middle.form },
    { raw: "$$x+y$$", tex: "x+y", form: "display" },
    "同线 $$ 官方产 inlineMath，但产品契约是 display",
  );
  assert.strictEqual(mathNodes(parse("Before $$x+y$$ after.").root)[0]?.type, "inlineMath");
  const sameLine = only("same $$5 $$ line");
  assert.deepStrictEqual(
    { raw: sameLine.raw, form: sameLine.form, tex: sameLine.tex },
    { raw: "$$5 $$", form: "display", tex: "5 " },
    "同线多美元仍是 display，不按普通金额处理",
  );
  console.log("math: $ / \\( / $$ / \\[ 的 inline-display 契约由定界符决定 ✓");
}

// ---------- 4. 容器：raw 含前缀，tex 不含容器标记 ----------
{
  const quote = only("> \\[\r\n> x+y\r\n> \\]\r\n");
  assert.deepStrictEqual(
    { raw: quote.raw, tex: quote.tex, form: quote.form, closed: quote.closed },
    { raw: "\\[\r\n> x+y\r\n> \\]", tex: "x+y", form: "display", closed: true },
    "引用内 flow：raw 保容器，tex 取官方去标记载荷",
  );
  assert.ok(!quote.tex.includes(">"), "有效 TeX 不能带引用前缀");

  const list = only("- $$\r\n  x+y\r\n  $$\r\n");
  assert.deepStrictEqual(
    { raw: list.raw, tex: list.tex, closed: list.closed },
    { raw: "$$\r\n  x+y\r\n  $$", tex: "x+y", closed: true },
    "列表内 flow：raw 保缩进，tex 去缩进",
  );
  const listInline = only("- $$a+b$$");
  assert.deepStrictEqual(
    { raw: listInline.raw, tex: listInline.tex, form: listInline.form, closed: listInline.closed },
    { raw: "$$a+b$$", tex: "a+b", form: "display", closed: true },
    "列表项内同行 $$ 是 display",
  );

  const nested = sourcesOf("> Before \\[x^2\\] after.\n\n- $$a+b$$\n- other");
  assert.deepStrictEqual(
    nested.map((fact) => [fact.raw, fact.tex, fact.form]),
    [["$$a+b$$", "a+b", "display"]],
    "引用内同线 \\[ 不是官方 flow（只有行首 \\[ 才是 display），列表内 $$ 是 display 候选",
  );
  const quoteLine = only("> \\[x^2\\]\r\n");
  assert.deepStrictEqual(
    { raw: quoteLine.raw, tex: quoteLine.tex, form: quoteLine.form },
    { raw: "\\[x^2\\]", tex: "x^2", form: "display" },
    "引用行首的 \\[ 才是官方 display flow",
  );
  console.log("math: 引用 / 列表容器的 raw 与有效 TeX 分开，display 由定界符保留 ✓");
}

// ---------- 5. 未闭合 / 假关闭：closed 只信围栏 token ----------
{
  const unclosed = [
    "$$\nx+y $$",
    "$$\nx+y\n",
    "$$\nx+y\n\n",
    "$$\nx+y $\\$",
    "$$\nx+y $$ trailing",
  ];
  for (const source of unclosed) {
    const fact = only(source);
    assert.strictEqual(fact.closed, false, `${JSON.stringify(source)}: 不能凭 raw 后缀判闭合`);
    assert.strictEqual(source.slice(fact.start, fact.end), fact.raw, "未闭合 raw 是源码原样切片");
    assert.strictEqual(fact.form, "display");
  }
  for (const source of ["\\(x+y", "\\[x+y", "Before $x+y"]) {
    assertPlain(source, `unclosed ${source}`);
  }
  const closed = only("$$\nx+y\n$$");
  assert.strictEqual(closed.closed, true);
  console.log("math: EOF flow / 行内 $$ 假关闭均 closed=false，正常关闭才有第二 fence ✓");
}

// ---------- 6. 源码事实：offset / CRLF / NUL / U+FFFD / PUA / 实体 ----------
{
  const offsets = [
    "a\r\n$5 and $x$",
    "\u{1F600} $x$",
    "a\u0000$x$",
    "> $x$",
    "$$\nx+y\n$$",
  ];
  for (const source of offsets) {
    const document = parse(source);
    assert.strictEqual(document.source, source, "文档源文与输入逐字相同");
    for (const fact of mathSources(document.root)) {
      assert.strictEqual(source.slice(fact.start, fact.end), fact.raw, "raw 必须等于 position 切片");
      assert.strictEqual(fact.end - fact.start, fact.raw.length, "offset 与 raw 长度一致");
      assert.ok(Number.isSafeInteger(fact.start) && Number.isSafeInteger(fact.end));
    }
  }

  const nul = "$x\u0000\uFFFDy$";
  const nulFact = only(nul);
  assert.strictEqual(nulFact.raw, nul, "NUL 在 raw 里原样保留");
  assert.strictEqual(parse(nul).source, nul, "NUL 不改写源文");

  const pua = "\uE000 literal $x$";
  const puaDoc = parse(pua);
  assert.strictEqual(puaDoc.source, pua);
  assert.strictEqual(textValues(puaDoc.root), "\uE000 literal ", "PUA 原样留在正文，不被替换成 $");
  assert.strictEqual(only(pua).tex, "x");

  const entity = "&#xE000; literal $x$";
  const entityDoc = parse(entity);
  assert.strictEqual(entityDoc.source, entity, "实体源文不被改写");
  assert.strictEqual(textValues(entityDoc.root), "\uE000 literal ", "实体由官方解码，不参与金额");
  const entityDollar = "&#36;5 and &#36;10.";
  assertPlain(entityDollar, "entity-dollar");
  assert.strictEqual(textValues(parse(entityDollar).root), "$5 and $10.", "实体美元解码后仍是普通文本");

  const mixed = "Costs $5 and $10. \uE000";
  assertPlain(mixed, "currency-pua");
  assert.ok(textValues(parse(mixed).root).endsWith(" \uE000"), "金额与 PUA 混排不改字符");
  console.log("math: offset / CRLF / NUL / U+FFFD / PUA / 实体保持源码事实 ✓");
}

// ---------- 7. math 围栏仍是 code；tex / latex 永不进入 ----------
{
  const source = "```math\r\nx+y  \r\n\r\n```";
  const document = parse(source);
  assert.deepStrictEqual(mathNodes(document.root), [], "math 围栏本轮不转公式候选");
  const codes = codeNodes(document.root);
  assert.strictEqual(codes.length, 1);
  const fact = mathFenceSource(codes[0]!, source, document.codeSources);
  assert.ok(fact !== undefined);
  assert.deepStrictEqual(
    { raw: fact.raw, tex: fact.tex, closed: fact.closed, form: fact.form },
    { raw: source, tex: "x+y  \r\n", closed: true, form: "display" },
    "围栏 raw / 精确载荷 / 闭合事实",
  );

  const unclosedSource = "```math\nx+y";
  const unclosedDoc = parse(unclosedSource);
  const unclosedFact = mathFenceSource(codeNodes(unclosedDoc.root)[0]!, unclosedSource, unclosedDoc.codeSources);
  assert.ok(unclosedFact !== undefined);
  assert.deepStrictEqual(
    { raw: unclosedFact.raw, tex: unclosedFact.tex, closed: unclosedFact.closed },
    { raw: unclosedSource, tex: "x+y", closed: false },
    "未闭合 math 围栏保持原文与 closed=false",
  );

  const tilde = "~~~math\nalpha\n~~~";
  const tildeDoc = parse(tilde);
  const tildeFact = mathFenceSource(codeNodes(tildeDoc.root)[0]!, tilde, tildeDoc.codeSources);
  assert.deepStrictEqual(tildeFact, {
    form: "display",
    closed: true,
    start: 0,
    end: tilde.length,
    raw: tilde,
    tex: "alpha",
  });

  const sourceCode = "```tex\nx+y\n```\n\n```latex\nx+y\n```";
  const sourceDoc = parse(sourceCode);
  assert.deepStrictEqual(mathNodes(sourceDoc.root), [], "tex / latex 不产公式");
  assert.deepStrictEqual(
    codeNodes(sourceDoc.root).map((node) => mathFenceSource(node, sourceCode, sourceDoc.codeSources)),
    [undefined, undefined],
    "tex / latex 永远是普通代码卡",
  );

  const currencyFence = "```math\nCosts $5 and $10.\n```";
  const currencyDoc = parse(currencyFence);
  assert.deepStrictEqual(mathSources(currencyDoc.root), [], "代码围栏内不跑金额规则");
  assert.strictEqual(
    mathFenceSource(codeNodes(currencyDoc.root)[0]!, currencyFence, currencyDoc.codeSources)?.tex,
    "Costs $5 and $10.",
    "闭合 math 围栏的载荷去掉闭合围栏前的行尾，内容逐字保留",
  );
  console.log("math: math 围栏保留 code 身份与权威闭合，tex / latex 不进入数学 ✓");
}

// ---------- 8. 验收输入中的其余解析事实 ----------
{
  const cases: [string, string, string][] = [
    ["unknown-command", "$\\notARealMacro{x}$", "\\notARealMacro{x}"],
    ["invalid-braces", "$\\frac{1}{2$", "\\frac{1}{2"],
    ["href-untrusted", "$\\href{javascript:alert(1)}{x}$", "\\href{javascript:alert(1)}{x}"],
    [
      "includegraphics-untrusted",
      "$\\includegraphics{https://example.invalid/test.png}$",
      "\\includegraphics{https://example.invalid/test.png}",
    ],
    [
      "html-commands-untrusted",
      "$\\htmlClass{evil}{x} \\htmlStyle{background:url(javascript:alert(1))}{x}$",
      "\\htmlClass{evil}{x} \\htmlStyle{background:url(javascript:alert(1))}{x}",
    ],
    ["fresh-macros", "$\\gdef\\shared{M}\\shared$", "\\gdef\\shared{M}\\shared"],
    ["recursive-macro", "$\\def\\a{\\a}\\a$", "\\def\\a{\\a}\\a"],
    ["max-size", "$\\rule{99999em}{99999em}$", "\\rule{99999em}{99999em}"],
    ["partial-selection", "Before $x+y+z$ after.", "x+y+z"],
    ["accessibility-search", "BEFORE\n\n$x+y$\n\nAFTER", "x+y"],
  ];
  for (const [name, source, tex] of cases) {
    const fact = only(source);
    assert.strictEqual(fact.tex, tex, `${name}: 有效载荷逐字保留，失败回退才有原文`);
    assert.strictEqual(source.slice(fact.start, fact.end), fact.raw, `${name}: raw 可原文回退`);
    assert.strictEqual(fact.closed, true);
  }
  assertPlain("`$x+y$` and \\$5 and ```not a fence```", "inline-code-and-escape");
  assertPlain("\\(x+y\n\n\\[x+y", "unclosed-compat");
  console.log("math: 未知命令 / 无效括号 / 危险命令 / 宏 / 巨尺寸等载荷事实保留 ✓");
}

// ---------- 9. phase 与 MathView 接线 ----------
{
  assert.strictEqual(sourcesOf("$x$").length, 1, "settled 缺省解析数学");
  assert.deepStrictEqual(mathSources(parseMarkdown("$x$", "streaming").root), [], "streaming 不解析数学");
  assert.deepStrictEqual(mathSources(parseGfmMarkdown("$x$").root), [], "显式 GFM 臂仍不含数学");

  const texts = dictionaryFor("zh");
  const render = (text: string): string => renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: texts },
      createElement(Markdown, { text }),
    ),
  );
  for (const [text, form] of [["$x$", "inline"], ["$$x$$", "display"]] as const) {
    const html = render(text);
    assert.ok(html.includes(text), `SSR 保留公式原文：${text}`);
    assert.ok(html.includes(`data-math-view="${form}"`), `MathView 标记：${text}`);
    assert.ok(!/class="katex/u.test(html), "SSR 不初始化 KaTeX");
  }
  const currency = render("Costs $5 and $10.");
  assert.ok(currency.includes("Costs $5 and $10."), "金额仍按原文显示");
  assert.ok(!currency.includes("data-math-view"), "金额不生成公式");

  // 即使调用方把 settled 文档直接交给渲染层，未确认的 math 节点也按源码回退。
  const settled = parseMarkdown("$x$");
  const fallback = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: texts },
      createElement("div", null, renderMarkdownDocument(settled, { phase: "settled", texts })),
    ),
  );
  assert.ok(fallback.includes("$x$"), "MathView 首帧 / 无 DOM 回退原文");
  assert.ok(fallback.includes('data-math-view="inline"'), "MathView 来源标识");
  console.log("math: settled 接线 MathView，SSR / streaming 保持原文且不初始化引擎 ✓");
}

// ---------- 10. 与 vendor 官方臂的树等价（防止本地装配漂移） ----------
{
  const stripFacts = (node: Node): void => {
    const data = node.data as Record<string, unknown> | undefined;
    if (data !== undefined && "dshMathSource" in data) {
      delete data.dshMathSource;
      if (Object.keys(data).length === 0) node.data = undefined;
    }
    if ("children" in node) {
      for (const child of node.children) stripFacts(child);
    }
  };
  const corpus = [
    "# 标题\n\n段落 **粗体** 与 `code`、[链接](https://example.test)。\n",
    "| a | b |\n| - | - |\n| 1 | 2 |\n",
    "- [x] 任务\n- [ ] 未完成\n\n1. 有序\n2. 列表\n",
    "脚注[^a] 与引用[^b]\n\n[^a]: 说明\n[^b]: 另一条\n",
    "[t](D:\\a\\b.ts) 与 ![p](D:\\a\\b.png)\n",
    "中文**加粗**，标点收尾。**中文**收尾。\n",
    "$x+y$ 与 \\(a+b\\)\n\n$$c+d$$\n\n\\[e+f\\]\n",
    "> \\[\r\n> x+y\r\n> \\]\r\n",
    "$$\nx+y $$",
    "```math\nx+y\n```\n\n```tex\nx+y\n```\n",
    "$5$ 与 $5+10$ 与 $5 $\n",
  ];
  for (const source of corpus) {
    const local = parseSettledRoot(source);
    const vendor = parseGfmWithMath(source);
    stripFacts(local);
    assert.deepStrictEqual(local, vendor, `本地数学臂与 vendor 树等价：${JSON.stringify(source)}`);
  }
  console.log(`math: ${corpus.length} 份语料与 vendor parseGfmWithMath 去事实键后树等价 ✓`);
}

console.log("\nmath: all assertions passed");
