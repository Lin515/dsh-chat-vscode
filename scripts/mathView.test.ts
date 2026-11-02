/**
 * MathView / 正文接线的 SSR 行为与 display 段落所有权（无浏览器）。
 *
 * Node 没有 DOM，也没有真实异步 effect：这里只断言服务端首帧 / 无 DOM 时
 * 渲染层可确定的事实——公式事实被 MathView 接收、原文完整回退、display
 * 从段落中切出且不产生 p 包 div、strong / emphasis / link / footnote 两侧
 * 内容不丢、tex / latex 仍走 CodeBlock、KaTeX 不在 SSR 初始化。
 *
 * 真实 KaTeX 异步渲染、selectionIntersectsElement 的跨段 / 多 Range 冻结、
 * 字体与几何由主代理在受控浏览器验收；本文件不伪造 DOM 证明。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/webview/components/Markdown";
import { readableMentionText } from "../src/webview/mentionLinks";
import { mathViewIdentity } from "../src/webview/components/MathView";
import type { MathRenderSource } from "../src/webview/markdown/mathRender";
import type { MarkdownPhase } from "../src/webview/markdown/types";
import { dictionaryFor, TextsContext } from "../src/webview/texts";

const texts = dictionaryFor("zh");

function render(text: string, phase: MarkdownPhase = "settled"): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: texts },
      createElement(Markdown, { text, phase }),
    ),
  );
}

function views(html: string): ("inline" | "display")[] {
  return [...html.matchAll(/data-math-view="(inline|display)"/gu)]
    .map((match) => match[1] as "inline" | "display");
}

function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p>([\s\S]*?)<\/p>/gu)].map((match) => match[1]!);
}

function assertNoBlockInsideParagraph(html: string, label: string): void {
  for (const paragraph of paragraphs(html)) {
    assert.ok(!paragraph.includes("<div"), `${label}: p 内不能有 div`);
    assert.ok(
      !paragraph.includes('data-math-view="display"'),
      `${label}: display 公式必须切出段落`,
    );
  }
}

// ---------- 1. 四类定界符 / 金额 / 相邻 forms ----------
{
  const html = render("Inline $x+y$ and \\(a+b\\).\n\n$$x^2+y^2$$\n\n\\[\\frac{1}{2}\\]");
  assert.deepStrictEqual(views(html), ["inline", "inline", "display", "display"]);
  assertNoBlockInsideParagraph(html, "four-delimiters");
  for (const source of ["$x+y$", "\\(a+b\\)", "$$x^2+y^2$$", "\\[\\frac{1}{2}\\]"]) {
    assert.ok(html.includes(source) || html.includes(source.replace(/</gu, "&lt;")), `原文保留：${source}`);
  }
  assert.ok(!/class="katex|katex-mathml|<math/u.test(html), "SSR 不初始化 KaTeX");

  const currency = render("Costs $5 and $10.");
  assert.deepStrictEqual(views(currency), [], "金额不生成公式");
  assert.ok(currency.includes("Costs $5 and $10."), "金额原文完整");

  const mixed = render("Pay $5 and $x$");
  assert.deepStrictEqual(views(mixed), ["inline"]);
  assert.ok(mixed.includes("Pay $5 and"), "金额前缀保留");
  assert.ok(mixed.includes("$x$"), "公式原文保留");

  const adjacent = render("$x$ $$y$$ \\(z\\)");
  assert.deepStrictEqual(views(adjacent), ["inline", "display", "inline"]);
  assertNoBlockInsideParagraph(adjacent, "adjacent");
}

console.log("mathView: 四定界符 / 金额 / 相邻 forms 的 SSR 原文与 display 切段 ✓");

// ---------- 2. 未闭合 / 超长 / 失败原文 ----------
{
  const unclosed = render("$$\r\nx+y\r\n");
  assert.deepStrictEqual(views(unclosed), ["display"]);
  assert.ok(unclosed.includes("x+y"), "未闭合 flow 保留原文");
  assert.ok(!/class="katex|<math/u.test(unclosed), "未闭合不初始化引擎");
  assertNoBlockInsideParagraph(unclosed, "unclosed");

  // `\[` 没有闭合时官方语法可能整段按普通文本处理；同样只能原文，不补闭合。
  const unclosedCompat = render("\\[x+y");
  assert.deepStrictEqual(views(unclosedCompat), []);
  assert.ok(unclosedCompat.includes("[x+y"), "未闭合兼容定界符保留文本");
  assert.ok(!/katex|math-view/u.test(unclosedCompat), "未闭合兼容定界符不生成公式");

  const long = render(`$$${"x+".repeat(2001)}y$$`);
  assert.deepStrictEqual(views(long), ["display"]);
  assert.ok(long.includes("x+y"), "超长仍以原文回退");
  assert.ok(!/class="katex|<math/u.test(long), "超长不初始化引擎");
}

console.log("mathView: 未闭合 / 超长保持 raw，不补闭合、不初始化引擎 ✓");

// ---------- 3. math / tex / latex 围栏 ----------
{
  const mathFence = render("```math\r\nx+y  \r\n\r\n```");
  assert.deepStrictEqual(views(mathFence), ["display"]);
  assert.ok(mathFence.includes("x+y"), "math 围栏保留载荷");
  assert.ok(!/class="katex|<math/u.test(mathFence), "math 围栏 SSR 不初始化引擎");
  assertNoBlockInsideParagraph(mathFence, "math-fence");

  const codeFences = render("```tex\nx+y\n```\n\n```latex\nz\n```");
  assert.deepStrictEqual(views(codeFences), [], "tex / latex 不转公式");
  assert.strictEqual([...codeFences.matchAll(/class="code-block"/gu)].length, 2, "两张代码卡");
  assert.ok(codeFences.includes("tex") && codeFences.includes("latex"), "语言标签保留");
}

console.log("mathView: math 围栏进 MathView，tex / latex 仍精确 CodeBlock ✓");

// ---------- 4. 段落 / 容器 / 列表 / 表格 / 脚注所有权 ----------
{
  const middle = render("before$$x+y$$after");
  assert.deepStrictEqual(views(middle), ["display"]);
  assert.ok(middle.includes("<p>before</p>"), "无空格源文也切出前段");
  assert.ok(middle.includes("</p>\n<span class=\"math-view math-view-display"), "p 与 display 之间有逻辑换行");
  assert.ok(middle.includes("</span>\n<p>after</p>"), "display 与后段之间有逻辑换行");
  assert.ok(!middle.includes("before$$x+y$$after"), "跨块逻辑文本不能直接拼接");
  assertNoBlockInsideParagraph(middle, "middle-display");

  const inline = render("$x$");
  assert.ok(inline.includes("<p><span class=\"math-view math-view-inline"), "inline math 不额外插分隔");
  const inlineCode = render("`x+y`");
  assert.ok(inlineCode.includes("<code>x+y</code>"), "行内代码载荷不变");

  const strong = render("before **strong $$x+y$$ tail** after");
  assert.deepStrictEqual(views(strong), ["display"]);
  assert.ok(strong.includes("<strong>strong </strong>"), "strong 前半保留");
  assert.ok(strong.includes("<strong> tail</strong>"), "strong 后半保留");
  assert.ok(strong.includes("before ") && strong.includes(" after"), "strong 外部文本保留");
  assertNoBlockInsideParagraph(strong, "strong-display");

  const emphasis = render("before *em $$x+y$$ tail* after");
  assert.ok(emphasis.includes("<em>em </em>") && emphasis.includes("<em> tail</em>"));
  assertNoBlockInsideParagraph(emphasis, "emphasis-display");

  const link = render("[open $$x+y$$ here](https://example.com)");
  assert.strictEqual([...link.matchAll(/<a href="https:\/\/example\.com"/gu)].length, 2, "链接两侧各保留一个 anchor");
  assert.ok(link.includes("open ") && link.includes(" here"), "链接文字保留");
  assertNoBlockInsideParagraph(link, "link-display");

  const reference = render("[**before $$x+y$$ after**][id]\n\n[id]: https://example.com");
  assert.strictEqual([...reference.matchAll(/<a href="https:\/\/example\.com"/gu)].length, 2, "引用链接两侧各保留一个 anchor");
  assert.ok(reference.includes("<strong>before </strong>") && reference.includes("<strong> after</strong>"));
  assertNoBlockInsideParagraph(reference, "reference-display");

  const quote = render("> before $$x+y$$ after");
  assert.deepStrictEqual(views(quote), ["display"]);
  assert.ok(quote.startsWith("<div class=\"md\"><blockquote>"), "display 留在引用块内");
  assertNoBlockInsideParagraph(quote, "quote-display");

  for (const text of ["- before $$x+y$$ after\n- tail", "- before $$x+y$$ after\n\n- tail"]) {
    const list = render(text);
    assert.deepStrictEqual(views(list), ["display"]);
    assert.ok(list.includes("before ") && list.includes(" after") && list.includes("tail"), "列表两侧与末项保留");
    assertNoBlockInsideParagraph(list, "list-display");
  }

  const table = render("| a | b |\n| - | - |\n| $$x+y$$ | tail |");
  assert.deepStrictEqual(views(table), ["display"]);
  assert.ok(table.includes("<td>\n<span class=\"math-view math-view-display"), "display 留在单元格内");
  assert.ok(table.includes("<td>tail</td>"), "相邻单元格保留");
  assertNoBlockInsideParagraph(table, "table-display");

  const tableText = render("| a | b |\n| - | - |\n| before$$x+y$$after | tail |");
  assert.ok(
    tableText.includes("<td>before\n<span class=\"math-view math-view-display"),
    "单元格内 display 前有逻辑换行",
  );
  assert.ok(tableText.includes("</span>\nafter</td>"), "单元格内 display 后有逻辑换行");
  assert.ok(!tableText.includes("before$$x+y$$after"), "单元格逻辑文本不直接拼接");

  const footnote = render("ref[^a]\n\n[^a]: before $$x+y$$ after");
  assert.deepStrictEqual(views(footnote), ["display"]);
  assert.ok(footnote.includes("ref<sup>1</sup>"), "脚注引用只出现一次");
  assert.strictEqual([...footnote.matchAll(/↩/gu)].length, 1, "回跳箭头不重复");
  assert.ok(footnote.includes("before ") && footnote.includes(" after"), "脚注两侧文本保留");
  assertNoBlockInsideParagraph(footnote, "footnote-display");

  const nestedFence = render("> - before\n>\n>   ```math\n>   x+y\n>   ```\n>\n>   after");
  assert.deepStrictEqual(views(nestedFence), ["display"]);
  assert.ok(nestedFence.includes("before") && nestedFence.includes("after"), "引用列表内围栏两侧保留");
  assertNoBlockInsideParagraph(nestedFence, "nested-fence");
}

console.log("mathView: display 段落切分、strong / em / link / 引用 / 列表 / 表格 / 脚注所有权 ✓");

// ---------- 5. 安全与失败原文 ----------
{
  const href = render("$\\href{javascript:alert(1)}{x}$");
  assert.deepStrictEqual(views(href), ["inline"]);
  assert.ok(href.includes("\\href{javascript:alert(1)}{x}"), "失败原文包含完整命令");
  assert.ok(!/<a[\s>]|href=|onclick=|onerror=/iu.test(href), "原文回退不产生活动链接 / 事件");

  const styles = render("$\\htmlStyle{background:url(javascript:alert(1))}{x}$");
  assert.deepStrictEqual(views(styles), ["inline"]);
  assert.ok(!/<span[^>]*\sstyle=/iu.test(styles), "原文回退不写 style 属性");
  assert.ok(!/<(?:a|img|script|iframe)\b/iu.test(styles), "危险命令不生成活动元素");

  const markup = render("$x<y$");
  assert.ok(markup.includes("&lt;"), "原文里的 < 按文本转义");
  assert.ok(!/<y\b/u.test(markup), "不生成未知标签");
}

console.log("mathView: 失败 / 安全原文只做文本回退 ✓");

// ---------- 6. 渲染身份 key：五个事实、NUL 不碰撞 ----------
{
  const base: MathRenderSource = { form: "inline", closed: true, raw: "$x$", tex: "x" };
  const identity = (
    patch: Partial<MathRenderSource> = {},
    phase: MarkdownPhase = "settled",
  ): string => mathViewIdentity({ ...base, ...patch }, phase);

  assert.strictEqual(identity(), identity(), "同一事实得到同一身份");
  assert.notStrictEqual(identity(), identity({ raw: "$y$" }), "raw 变化换身份");
  assert.notStrictEqual(identity(), identity({ tex: "y" }), "tex 变化换身份");
  assert.notStrictEqual(identity(), identity({ form: "display" }), "form 变化换身份");
  assert.notStrictEqual(identity(), identity({ closed: false }), "closed 变化换身份");
  assert.notStrictEqual(identity(), identity({}, "streaming"), "phase 变化换身份");

  // 朴素 NUL 拼接下列两组会得到同一个字符串；JSON 元组必须分开。
  const lead = identity({ raw: "a", tex: "b\u0000c" });
  const split = identity({ raw: "a\u0000b", tex: "c" });
  assert.notStrictEqual(lead, split, "raw / tex 中的 NUL 不制造身份碰撞");
}

console.log("mathView: 渲染身份覆盖五个事实且 NUL 不碰撞 ✓");

// ---------- 7. 用户整条 / 助手末尾正文复制原文，不取 DOM ----------
// 源码接线 + `readableMentionText` 纯变换断言，不冒充 DOM 点击或系统剪贴板证明。
// 复制按钮统一走 `CopyButton`（1s 成功态在 webview/copyFeedback.ts），载荷不变。
{
  const source = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Message.tsx"),
    "utf8",
  );
  assert.match(
    source,
    /text=\{readableMentionText\(message\.text \?\? ""\)\}/,
    "用户消息复制载荷来自 message.text 的纯变换",
  );
  assert.match(
    source,
    /const replyText = lastTextSegment\(message\.segments\)\?\.text \?\? ""/,
    "助手轮尾复制取本轮最后一段正文的 Markdown 原文",
  );
  assert.match(source, /<CopyButton text=\{replyText\} title=\{texts\.copy\} size=\{14\} \/>/, "轮尾复制的载荷就是该段原文");
  assert.doesNotMatch(source, /const fullText|text=\{fullText\}/, "不把忽略工具的文本拼接冒充整条消息复制");
  assert.doesNotMatch(source, /segment-copy-actions/, "中间正文不各自挂复制按钮");

  const raw = "含行内 $x+y$ 与分式 \\frac{a}{b} 的原始消息";
  assert.strictEqual(
    readableMentionText(raw),
    raw,
    "复制载荷的纯变换不丢 $x+y$ / \\frac 的源字符串",
  );
}

console.log("mathView: 用户整条 / 助手末尾正文复制原文、数学源文逐字保留 ✓");

console.log("\nmathView: all assertions passed");
