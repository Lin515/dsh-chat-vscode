/**
 * 完成态数学的 KaTeX 引擎 seam、安全选项与净化纯函数。
 *
 * 这里不伪造 DOM：真实 DOMPurify 的浏览器行为由主代理在受控浏览器里验收；
 * Node 侧只测可确定的事实：
 *
 * - 模块导入 / 无 DOM / 未闭合 / 超长不会初始化 KaTeX，公开入口回退 undefined；
 * - 真实 KaTeX 0.16.47 在固定安全选项下能排版 37 条有效语料中的代表性输入；
 * - `maxExpand` 超限、未知命令失败，`maxSize` 把 100em 夹到 10em；
 * - 每次渲染使用新宏表、`globalGroup: false`，`\gdef` 不跨公式泄漏；
 * - `trust: false` 的真实行为是可信命令降级成普通文本而非抛错，输出没有
 *   `<a>` / `href` / 事件能力；`\text{katex-error}` 不因字样被误判成错误；
 * - `sanitizeMathStyle` 只保留排版属性与合法值，拒绝 fixed / url / var / env /
 *   expression / 注释 / 转义 / `!important`，不误删 400em、400000 viewBox、
 *   calc、text-shadow 与命名颜色；
 * - 属性白名单按 namespace + tag 校验，拒绝 script / 事件 / href / xlink /
 *   img / data 等，接受 KaTeX 真实的 MathML / SVG 属性；不换行空格的真实
 *   span class 均通过白名单，混入项目类或换到其他 namespace / tag 仍拒绝；
 * - 真实 KaTeX 的 `\mathop{lim}` 产生 `<mo><mi>…`，HTML parser 会把这些 token
 *   建成 HTML namespace；只允许零属性纯文本的直接 `mo` token 折叠成文本，
 *   其余混入的 HTML 元素一律判为不可信（真实 DOM 净化由主代理验收）。
 *
 * 真实 HTML 结构、DOMPurify 净化结果与浏览器样式对拍不在本文件冒充。
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import {
  MAX_MATH_TEX_LENGTH,
  renderKatexHtml,
  renderMath,
  type MathRenderSource,
} from "../src/webview/markdown/mathRender";
import {
  flattenableMisnamespacedMoTokenText,
  isAllowedMathAttribute,
  MATH_SANITIZE_TAGS,
  sanitizeMathHtml,
  sanitizeMathStyle,
  type MisnamespacedMoTokenFacts,
} from "../src/webview/markdown/mathSanitize";

function source(tex: string, form: "inline" | "display" = "inline"): MathRenderSource {
  return { form, closed: true, tex, raw: form === "display" ? `$$${tex}$$` : `$${tex}$` };
}

const VALID_TEX = [
  "\\frac{x+1}{y+2}",
  "\\sqrt[3]{x^2+\\sqrt{y}}",
  "\\int_0^1 x^2\\,dx=\\frac13",
  "\\sum_{n=1}^{\\infty} \\frac{1}{n^2}",
  "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
  "f(x)=\\begin{cases}x^2 & x>0\\\\0 & x\\le0\\end{cases}",
  "\\overbrace{x_1+\\cdots+x_n}^{n\\text{ terms}}",
  "\\xrightarrow[below]{above}\\overrightarrow{AB}",
  "\\cancel{x}+\\bcancel{y}+\\xcancel{z}",
  "\\mathbb{R}\\quad\\mathcal{F}\\quad\\mathbf{x}\\quad\\mathtt{abc}",
  "\\text{a < b \\& c > d}",
  "\\pmb{x+y}",
  "\\boxed{\\frac{x}{y}}",
  "\\colorbox{red}{\\text{A}}",
  "\\fbox{\\text{A}}",
  "\\xleftrightharpoons{a}",
  "\\mathop{lim}\\limits_{x\\to0} x",
  "\\left\\langle\\frac{x}{y}\\right\\rangle",
  "\\smash[t]{x}",
  "\\llap{x}y\\rlap{z}",
  "\\color{RebeccaPurple}{x}",
  "\\color{transparent}{x}",
  "\\Huge x \\small y \\scriptsize z",
  "\\mathsf{x}\\mathtt{y}\\mathbb{R}\\mathfrak{g}\\mathcal{F}",
  "\\text{katex-error composer context-menu}",
];

// 无 DOM 时公开入口直接回退，不加载引擎；未闭合与超长同样先拒。
assert.equal(await renderMath(source("x^2")), undefined);
assert.equal(await renderMath({ ...source("x^2"), closed: false }), undefined);
assert.equal(await renderMath(source("x".repeat(MAX_MATH_TEX_LENGTH + 1))), undefined);
assert.equal(await renderKatexHtml("x".repeat(MAX_MATH_TEX_LENGTH + 1), false), undefined);
assert.equal(await sanitizeMathHtml("<span>x</span>", undefined as unknown as Document), undefined);

// 文本节点必须显式允许：DOMPurify 的文本 tag 是 `#text`，只给元素白名单时
// 元素壳还在但 mi / mtext / annotation / 视觉层文字会被 KEEP_CONTENT:false 删空。
assert.ok(MATH_SANITIZE_TAGS.includes("#text"));
for (const tag of ["span", "math", "annotation", "svg", "path", "line"]) {
  assert.ok(MATH_SANITIZE_TAGS.includes(tag), `缺少允许 tag：${tag}`);
}
for (const tag of ["script", "style", "a", "img", "foreignObject", "use", "form", "input", "iframe"]) {
  assert.equal(MATH_SANITIZE_TAGS.includes(tag), false, `不应允许 tag：${tag}`);
}

// 真实 KaTeX 触发片段：\mathop{lim}\limits 的 MathML 是 mo 内直接嵌 mi。
// HTML parser 会把 mo（MathML text integration point）里的 mi 按 HTML
// namespace 建树，DOMPurify 按 namespace 拒绝它们；纯函数只接受这种
// “父级 MathML mo + 零属性 + 纯文本”的直接 token，折叠后保留 lim 文本。
const limitsHtml = await renderKatexHtml("\\mathop{lim}\\limits_{x\\to0} x", false);
assert.ok(limitsHtml !== undefined);
assert.match(limitsHtml, /<munder><mo><mi>l<\/mi><mi>i<\/mi><mi>m<\/mi><\/mo>/u);

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

function moToken(overrides: Partial<MisnamespacedMoTokenFacts> = {}): MisnamespacedMoTokenFacts {
  return {
    namespace: HTML_NS,
    localName: "mi",
    parentNamespace: MATHML_NS,
    parentLocalName: "mo",
    attributeCount: 0,
    childNodeTypes: [3],
    textContent: "l",
    ...overrides,
  };
}

assert.equal(flattenableMisnamespacedMoTokenText(moToken()), "l");
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ localName: "mn", textContent: "12" })), "12");
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ localName: "mo", textContent: "+" })), "+");
assert.equal(
  flattenableMisnamespacedMoTokenText(moToken({ localName: "mtext", textContent: "lim" })),
  "lim",
);
assert.equal(
  flattenableMisnamespacedMoTokenText(moToken({ childNodeTypes: [3, 3], textContent: "li" })),
  "li",
);
for (const localName of ["span", "mrow", "mfrac", "script", "img", "foreignObject"]) {
  assert.equal(
    flattenableMisnamespacedMoTokenText(moToken({ localName })),
    undefined,
    `不应折叠 ${localName}`,
  );
}
// 不是在 HTML parser 的 integration point 里产生的节点、带属性或带元素
// 子节点的 token 都不能折叠；这些分支让调用方整体判失败，而不是剥空成功。
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ namespace: MATHML_NS })), undefined);
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ parentNamespace: HTML_NS })), undefined);
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ parentLocalName: "mi" })), undefined);
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ parentLocalName: "mrow" })), undefined);
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ attributeCount: 1 })), undefined);
assert.equal(
  flattenableMisnamespacedMoTokenText(moToken({ childNodeTypes: [3, 1, 3] })),
  undefined,
);
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ childNodeTypes: [] })), undefined);
assert.equal(flattenableMisnamespacedMoTokenText(moToken({ textContent: "" })), undefined);
assert.equal(
  flattenableMisnamespacedMoTokenText(moToken({ textContent: "x".repeat(2048) })),
  undefined,
);

// 真实引擎：有效语料在固定选项下都能排版，display 形态有 katex-display。
for (const tex of VALID_TEX) {
  const html = await renderKatexHtml(tex, true);
  assert.ok(html !== undefined, `KaTeX 未排版有效语料：${tex}`);
  assert.match(html, /class="katex/u);
  assert.match(html, /<math/u);
  assert.match(html, /class="katex-html"/u);
  assert.match(html, /class="katex-display"/u);
}
const inline = await renderKatexHtml("x^2", false);
assert.ok(inline !== undefined);
assert.doesNotMatch(inline, /class="katex-display"/u);
assert.match(inline, /class="katex-mathml"/u);

// 不换行空格：真实 KaTeX 的 span class 必须全部通过净化属性校验。
for (const tex of ["~~~\nx", "x~y", "x\\nobreakspace y"]) {
  for (const display of [false, true]) {
    const html = await renderKatexHtml(tex, display);
    assert.ok(html !== undefined, `KaTeX 未排版不换行空格：${tex}`);
    assert.match(html, /class="mspace nobreak"/u);
    for (const match of html.matchAll(/<span\b[^>]*\bclass="([^"]*)"/gu)) {
      assert.equal(
        isAllowedMathAttribute("html", "span", "class", match[1]!),
        true,
        `KaTeX 排版 class 应通过净化：${match[1]}`,
      );
    }
  }
}
assert.equal(isAllowedMathAttribute("html", "span", "class", "mspace nobreak composer"), false);
assert.equal(isAllowedMathAttribute("mathml", "mtd", "class", "nobreak"), false);

// 失败与限额：不可恢复的宏展开、未知命令、超大尺寸。
assert.equal(await renderKatexHtml("\\def\\a{\\a}\\a", false), undefined);
assert.equal(await renderKatexHtml("\\notacommand", false), undefined);
const clamped = await renderKatexHtml("\\rule{100em}{1em}", true);
assert.ok(clamped !== undefined);
assert.match(clamped, /border-right-width:10em/u);
assert.doesNotMatch(clamped, /(?:width|border-right-width):100em/u);

// 每次渲染 fresh macros + globalGroup:false：前式的 \gdef 不污染后式。
const defined = await renderKatexHtml("\\gdef\\foo{1}\\foo", false);
assert.ok(defined !== undefined);
assert.match(defined, />1</u);
assert.equal(await renderKatexHtml("\\foo", false), undefined);
const local = await renderKatexHtml("\\def\\local{q}\\local^2", false);
assert.ok(local !== undefined);
assert.match(local, />q</u);

// trust:false 的真实行为：可信命令不抛错，降级为普通文本，不产生链接能力。
const href = await renderKatexHtml("\\href{javascript:alert(1)}{x}", false);
assert.ok(href !== undefined);
assert.doesNotMatch(href, /<a[\s>]/u);
assert.doesNotMatch(href, /\bhref=/u);
assert.doesNotMatch(href, /onclick=/u);
for (const tex of ["\\url{javascript:alert(1)}", "\\includegraphics[width=1em]{x.png}"]) {
  const html = await renderKatexHtml(tex, false);
  assert.ok(html !== undefined);
  assert.doesNotMatch(html, /<a[\s>]/u);
  assert.doesNotMatch(html, /\bhref=/u);
  assert.doesNotMatch(html, /\bsrc=/u);
}
// 正文出现 katex-error 字样不是错误 class：不能靠 includes 猜失败。
const textError = await renderKatexHtml("\\text{katex-error}", false);
assert.ok(textError !== undefined);
assert.match(textError, /katex-error/u);
assert.doesNotMatch(textError, /class="[^"]*\bkatex-error\b/u);

// style 正向清洗：合法排版值保留，危险声明丢弃或整条失效。
assert.equal(
  sanitizeMathStyle("height:2.2019em;vertical-align:-0.8804em;"),
  "height:2.2019em;vertical-align:-0.8804em;",
);
assert.equal(
  sanitizeMathStyle("border-style:solid;border-width:0.04em;background-color:red;"),
  "border-style:solid;border-width:0.04em;background-color:red;",
);
assert.equal(
  sanitizeMathStyle("text-shadow:0.02em 0.01em 0.04px;"),
  "text-shadow:0.02em 0.01em 0.04px;",
);
assert.equal(sanitizeMathStyle("width:calc(100% - 0.0556em)"), "width:calc(100% - 0.0556em);");
assert.equal(sanitizeMathStyle("width:400em"), "width:400em;");
assert.equal(sanitizeMathStyle("color:RebeccaPurple"), "color:RebeccaPurple;");
assert.equal(sanitizeMathStyle("position:relative;top:-3em"), "position:relative;top:-3em;");
assert.equal(sanitizeMathStyle("position:fixed;inset:0;z-index:99999"), undefined);
assert.equal(sanitizeMathStyle("top:0!important"), undefined);
assert.equal(sanitizeMathStyle("top:env(safe-area-inset-top);color:var(--x)"), undefined);
assert.equal(sanitizeMathStyle("color:r/**/ed;top:1e99em;position:f\\69xed"), undefined);
assert.equal(sanitizeMathStyle("background-image:url(https://x);color:red"), "color:red;");
assert.equal(sanitizeMathStyle("width:expression(evil());height:1em"), "height:1em;");
assert.equal(sanitizeMathStyle("height:100em;min-width:0.888em;"), "height:100em;min-width:0.888em;");
// 正向表不能把继承键当 style 属性（constructor / __proto__ / toString）。
assert.equal(sanitizeMathStyle("constructor:red"), undefined);
assert.equal(sanitizeMathStyle("__proto__:red"), undefined);
assert.equal(sanitizeMathStyle("toString:1em"), undefined);
assert.equal(sanitizeMathStyle("constructor:red;color:red"), "color:red;");

// 属性按 namespace + tag 校验：真实 KaTeX 属性与值保留，危险能力拒绝。
assert.equal(isAllowedMathAttribute("html", "span", "class", "katex"), true);
assert.equal(isAllowedMathAttribute("html", "span", "class", "mord mathnormal"), true);
assert.equal(isAllowedMathAttribute("html", "span", "class", "composer"), false);
assert.equal(isAllowedMathAttribute("html", "span", "class", "context-menu backdrop"), false);
assert.equal(isAllowedMathAttribute("html", "span", "aria-hidden", "true"), true);
assert.equal(isAllowedMathAttribute("html", "span", "aria-hidden", "false"), false);
assert.equal(isAllowedMathAttribute("html", "span", "style", "position:fixed"), false);
assert.equal(isAllowedMathAttribute("html", "span", "style", "height:1em"), true);
assert.equal(isAllowedMathAttribute("html", "span", "href", "javascript:evil()"), false);
assert.equal(isAllowedMathAttribute("html", "span", "onclick", "evil()"), false);
assert.equal(isAllowedMathAttribute("html", "span", "data-command", "open"), false);
assert.equal(isAllowedMathAttribute("html", "span", "id", "x"), false);
assert.equal(isAllowedMathAttribute("html", "span", "name", "x"), false);
assert.equal(isAllowedMathAttribute("html", "constructor", "class", "katex"), false);
assert.equal(isAllowedMathAttribute("html", "__proto__", "class", "katex"), false);
assert.equal(isAllowedMathAttribute("html", "span", "constructor", "x"), false);
assert.equal(isAllowedMathAttribute("mathml", "mtd", "class", "mtr-glue"), true);
assert.equal(isAllowedMathAttribute("mathml", "mtd", "class", "composer"), false);
assert.equal(isAllowedMathAttribute("mathml", "math", "xmlns", "http://www.w3.org/1998/Math/MathML"), true);
assert.equal(isAllowedMathAttribute("mathml", "math", "xmlns", "http://www.w3.org/1999/xhtml"), false);
assert.equal(isAllowedMathAttribute("mathml", "math", "display", "block"), true);
assert.equal(
  isAllowedMathAttribute("mathml", "annotation", "encoding", "application/x-tex"),
  true,
);
assert.equal(
  isAllowedMathAttribute("mathml", "annotation", "encoding", "text/html"),
  false,
);
assert.equal(isAllowedMathAttribute("mathml", "mpadded", "lspace", "-1width"), true);
assert.equal(isAllowedMathAttribute("mathml", "mtable", "width", "100%"), true);
assert.equal(isAllowedMathAttribute("mathml", "mo", "fence", "true"), true);
assert.equal(isAllowedMathAttribute("mathml", "mo", "fence", "yes"), false);
assert.equal(isAllowedMathAttribute("svg", "svg", "xmlns", "http://www.w3.org/2000/svg"), true);
assert.equal(isAllowedMathAttribute("svg", "svg", "viewBox", "0 0 400000 1080"), true);
assert.equal(isAllowedMathAttribute("svg", "svg", "viewBox", "0 0 1e999 1"), false);
assert.equal(isAllowedMathAttribute("svg", "svg", "width", "400em"), true);
assert.equal(isAllowedMathAttribute("svg", "svg", "width", "100%"), true);
assert.equal(isAllowedMathAttribute("svg", "svg", "preserveAspectRatio", "xMinYMin slice"), true);
assert.equal(isAllowedMathAttribute("svg", "svg", "preserveAspectRatio", "url(x)"), false);
assert.equal(isAllowedMathAttribute("svg", "path", "d", "M0 0 L1 1"), true);
assert.equal(
  isAllowedMathAttribute("svg", "path", "d", "M0 0 url(javascript:evil())"),
  false,
);
assert.equal(isAllowedMathAttribute("svg", "line", "x1", "100%"), true);
assert.equal(isAllowedMathAttribute("svg", "line", "stroke-width", "0.046em"), true);
assert.equal(isAllowedMathAttribute("svg", "use", "href", "https://x"), false);
assert.equal(isAllowedMathAttribute("html", "img", "src", "https://x"), false);
