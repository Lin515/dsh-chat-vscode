/**
 * mathRender.test.ts 的隔离 DOM 浏览器入口；只使用生产解析 / MathView / 官方排版。
 * 可在真实 Chromium 复用。不是服务探针，不加载资源，不触及宿主或模型。
 */
import { createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderTexToReact } from "../src/vendor/ui-primitives/markdown/katex";
import { MAX_MATH_TEX_LENGTH, renderMath, type MathRenderSource } from "../src/webview/markdown/mathRender";
import { MathView } from "../src/webview/components/MathView";
import { Markdown } from "../src/webview/components/Markdown";
import { isOwnedMathAux } from "../src/webview/mathDom";

const VALID_TEX = [
  String.raw`\frac{x+1}{y+2}`,
  String.raw`\sqrt[3]{x^2+\sqrt{y}}`,
  String.raw`\int_0^1 x^2\,dx=\frac13`,
  String.raw`\sum_{n=1}^{\infty} \frac{1}{n^2}`,
  String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
  String.raw`f(x)=\begin{cases}x^2 & x>0\\0 & x\le0\end{cases}`,
  String.raw`\overbrace{x_1+\cdots+x_n}^{n\text{ terms}}`,
  String.raw`\xrightarrow[below]{above}\overrightarrow{AB}`,
  String.raw`\cancel{x}+\bcancel{y}+\xcancel{z}`,
  String.raw`\mathbb{R}\quad\mathcal{F}\quad\mathbf{x}\quad\mathtt{abc}`,
  String.raw`\text{a < b \& c > d}`,
  String.raw`\pmb{x+y}`,
  String.raw`\boxed{\frac{x}{y}}`,
  String.raw`\colorbox{red}{\text{A}}`,
  String.raw`\fbox{\text{A}}`,
  String.raw`\xleftrightharpoons{a}`,
  String.raw`\mathop{lim}\limits_{x\to0} x`,
  String.raw`\mathop{\mathrm{lim}}\limits_{x\to0} x`,
  String.raw`\mathop{\mathcal{F}} x`,
  String.raw`\left\langle\frac{x}{y}\right\rangle`,
  String.raw`\smash[t]{x}`,
  String.raw`\llap{x}y\rlap{z}`,
  String.raw`\color{RebeccaPurple}{x}`,
  String.raw`\color{transparent}{x}`,
  String.raw`\Huge x \small y \scriptsize z`,
  String.raw`\mathsf{x}\mathtt{y}\mathbb{R}\mathfrak{g}\mathcal{F}`,
  String.raw`\text{katex-error composer context-menu}`,
  String.raw`\text{或}`,
  String.raw`1,800\text{ 年}`,
  String.raw`\frac{1,800\text{ 年}}{4,500\text{ 年}}=40\%\quad\text{或}\quad0.4`,
  "~~~\nx",
  "x~y",
  String.raw`x\nobreakspace y`,
];

function source(tex: string, form: "inline" | "display" = "inline"): MathRenderSource {
  return { form, closed: true, tex, raw: form === "display" ? `$$${tex}$$` : `$${tex}$` };
}

export async function run(options: { mathmlStyles?: boolean } = {}): Promise<{ checks: number; parityCases: number }> {
  let checks = 0;
  function check(value: unknown, message: string): asserts value {
    checks += 1;
    if (!value) throw new Error(message);
  }
  const host = document.createElement("div");
  const officialHost = document.createElement("div");
  document.body.append(host, officialHost);
  const root = createRoot(host);
  const officialRoot = createRoot(officialHost);
  const render = (node: ReactNode): void => { flushSync(() => root.render(node)); };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  async function eventually(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) { check(true, message); return; }
      await tick();
    }
    check(false, message);
  }
  function assertInert(element: Element): void {
    check(!element.querySelector("script,style,a,img,iframe,object,embed,form,input,foreignObject,use"), "TeX 不产生主动元素");
    for (const node of element.querySelectorAll("*")) {
      for (const attr of node.attributes) {
        check(!/^(?:on|href$|src$|xlink:|data-)/iu.test(attr.name), `无主动属性：${attr.name}`);
        if (attr.name === "style") check(!/url\s*\(|expression\s*\(|position\s*:\s*fixed/iu.test(attr.value), "无主动样式");
      }
    }
  }
  try {
    // 每条都走实际 DOMParser → 官方 React 树 → React DOM，不以 class 许可替代排版证明。
    // jsdom 不实现 MathMLElement.style；该样式语料留给同入口的真实 Chromium 验收。
    const corpus = options.mathmlStyles === false
      ? VALID_TEX.filter((tex) => tex !== String.raw`\pmb{x+y}`)
      : VALID_TEX;
    for (const tex of corpus) {
      for (const form of ["inline", "display"] as const) {
        const result = await renderMath(source(tex, form));
        check(result !== undefined, `有效 TeX 必须成功：${tex}`);
        try {
          render(result.content);
          flushSync(() => officialRoot.render(renderTexToReact(tex, form === "display")));
        } catch (error) {
          throw new Error(`React DOM 排版失败：${tex}`, { cause: error });
        }
        check(host.innerHTML === officialHost.innerHTML, `逐树复用官方排版：${tex}`);
        check(host.querySelector(".katex-html")?.textContent, `视觉层非空：${tex}`);
        check(host.querySelector("annotation")?.textContent === tex, "辅助层保留精确 TeX");
        check(Boolean(host.querySelector(".katex-display")) === (form === "display"), "inline/display 形态正确");
        assertInert(host);
      }
    }

    check(await renderMath({ ...source("x"), closed: false }) === undefined, "未闭合不排版");
    check(await renderMath(source("x".repeat(MAX_MATH_TEX_LENGTH + 1))) === undefined, "超长回退");
    check(await renderMath(source("x".repeat(MAX_MATH_TEX_LENGTH))) !== undefined, "长度临界可用");
    for (const tex of [String.raw`\def\a{\a}\a`, String.raw`\frac{`, String.raw`\sqrt{`]) {
      check(await renderMath(source(tex)) === undefined, "语法/宏展开错误保留 raw");
    }
    check(await renderMath(source(String.raw`\gdef\privateMacro{1}\privateMacro`)) !== undefined, "单式允许局部宏");
    const next = await renderMath(source(String.raw`\privateMacro`));
    // 官方重试可能把未知命令显示为文本；无论哪一支都不能继承上一个公式的宏。
    if (next !== undefined) {
      render(next.content);
      check(host.querySelector(".katex-html")?.textContent !== "1", "宏不跨公式共享");
    }
    for (const tex of [
      String.raw`\href{javascript:alert(1)}{x}`,
      String.raw`\url{https://attack.invalid/}`,
      String.raw`\includegraphics{https://attack.invalid/image.png}`,
      String.raw`\htmlClass{composer}{x}`,
      String.raw`\htmlStyle{position:fixed;inset:0}{x}`,
      String.raw`\htmlData{command=run}{x}`,
      String.raw`\htmlId{owned}{x}`,
      String.raw`\text{<img src=x onerror=alert(1)>}`,
    ]) {
      const result = await renderMath(source(tex));
      render(result === undefined ? tex : result.content);
      assertInert(host);
      check(!host.querySelector(".composer,#owned"), "不授予项目 class/id 能力");
    }

    // Issue #2：带中文的 $$、表格内 $、四定界符与 math fence 都穿过正文生产链。
    const ratio = VALID_TEX[29]!;
    const sample = `$$\n${ratio}\n$$\n\n| 项目 | 时间 |\n| --- | --- |\n| 寿命 | $1,800\\text{ 年}$ |\n\n$\\text{或}$\n\n\\(x~y\\)\n\n\\[\nx\\nobreakspace y\n\\]\n\n~~~math\n\\text{中文}\n~~~`;
    render(createElement(Markdown, { text: sample, phase: "streaming" }));
    check(host.querySelectorAll(".math-view,.katex").length === 0, "streaming 不排版公式");
    render(createElement(Markdown, { text: sample, phase: "settled" }));
    await eventually(() => host.querySelectorAll(".katex").length === 6, "正文六类公式全部完成排版");
    check(host.querySelectorAll(".math-view-source").length === 0, "合法公式无原文回退");
    check(host.querySelector("td .cjk_fallback")?.textContent?.includes("年"), "表格中文公式实际可见");
    check(host.querySelector(".math-view-display .cjk_fallback")?.textContent, "块公式保留中文");
    check(!host.querySelector("p .math-view-display"), "块公式不留在 p 中");
    check(isOwnedMathAux(host.querySelector("annotation")!.firstChild), "FindBar 排除官方树辅助文本");
    check(!isOwnedMathAux(host.querySelector(".cjk_fallback")!.firstChild), "FindBar 保留可见中文文本");
    const literal = "$$\nx~y\n$$\n";
    render(createElement(Markdown, { text: `~~~js\n${literal}~~~`, phase: "settled" }));
    check(host.querySelector("code")?.textContent === literal.slice(0, -1), "普通代码仍为精确字面源码");
    check(!host.querySelector(".math-view,.katex"), "代码内部不识别公式");
    render(createElement(Markdown, { text: '<span class="katex"><img src=x onerror="alert(1)"></span>', phase: "settled" }));
    check(!host.querySelector("img,.katex"), "模型原始 HTML 只显示文本");

    // 首次排版 Promise 的迟到结果不得覆盖新身份的 invalid raw。
    render(createElement(MathView, { source: source("x+1"), phase: "settled" }));
    const invalid = { ...source(String.raw`\frac{`), raw: "$$\\frac{$$", form: "display" as const };
    render(createElement(MathView, { source: invalid, phase: "settled" }));
    check(host.textContent === invalid.raw, "新身份首帧即 raw");
    await tick(); await tick();
    check(host.textContent === invalid.raw && !host.querySelector(".katex"), "迟到成功不覆盖失败原文");

    // raw 选区跨 props 更新/结束增强仍保留原 TextNode，释放后再排版最新 source。
    render(createElement(MathView, { source: source("x~y"), phase: "streaming" }));
    const rawNode = host.querySelector(".math-view")!.firstChild!;
    const range = document.createRange(); range.selectNodeContents(rawNode);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    flushSync(() => document.dispatchEvent(new Event("selectionchange")));
    render(createElement(MathView, { source: source(String.raw`\text{或}`), phase: "settled" }));
    await tick(); await tick();
    check(rawNode.isConnected && host.textContent === "$x~y$", "选区冻结完整原文/phase 快照");
    selection.removeAllRanges();
    flushSync(() => document.dispatchEvent(new Event("selectionchange")));
    await eventually(() => Boolean(host.querySelector(".cjk_fallback")), "释放选区后追上最新中文公式");
    check(!rawNode.isConnected, "释放后才替换原 TextNode");

    // 已排版树同样冻结，不能因新 source 或异步增强破坏原选区。
    const oldVisual = host.querySelector(".katex-html")!;
    const renderedRange = document.createRange(); renderedRange.selectNodeContents(oldVisual);
    selection.addRange(renderedRange);
    flushSync(() => document.dispatchEvent(new Event("selectionchange")));
    render(createElement(MathView, { source: source("z^2"), phase: "settled" }));
    await tick();
    check(oldVisual.isConnected, "已排版选区保留旧树");
    selection.removeAllRanges(); flushSync(() => document.dispatchEvent(new Event("selectionchange")));
    await eventually(() => host.querySelector("annotation")?.textContent === "z^2", "释放后应用新排版");
    return { checks, parityCases: corpus.length * 2 };
  } finally {
    window.getSelection()?.removeAllRanges();
    flushSync(() => { root.unmount(); officialRoot.unmount(); });
    host.remove(); officialHost.remove();
  }
}
