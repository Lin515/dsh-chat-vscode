/**
 * Markdown 脚注的**可见行为**断言（真实解析 + 服务端渲染）。
 *
 * 迁移后脚注来自 GFM mdast 节点；旧界面（marked + 自有扩展）的语义继续保留：
 * 引用按首次引用编号、重复引用同号；只有引用没有定义的标号照样出上标，但不进
 * 脚注区；重复定义后者覆盖；代码里的标记保持字面。结构仍是
 * `section.footnotes > h2.sr-only + ol > li`，回跳是 `↩` / `↩<sup>2</sup>`。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/webview/components/Markdown";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

const render = (source: string, locale: "zh" | "en" = "zh"): string =>
  renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor(locale) },
      createElement(Markdown, { text: source }),
    ),
  );

// ---------- 1. 引用 + 定义 → 上标数字 + 文末脚注区 ----------
{
  const html = render("结论在这里[^a]。\n\n[^a]: 出处与说明\n");
  assert.ok(html.includes("<sup>1</sup>"), `引用渲染成上标：${html}`);
  assert.ok(!html.includes("[^a]"), `原始标记不该留在正文：${html}`);
  assert.match(html, /<section data-footnotes="" class="footnotes">/);
  assert.match(html, /<h2 id="footnote-label" class="sr-only">脚注<\/h2>/);
  assert.match(html, /<ol><li id="user-content-fn-a"><p>出处与说明 ↩<\/p><\/li><\/ol>/);
  assert.ok(
    render("x[^a]\n\n[^a]: A\n", "en").includes('<h2 id="footnote-label" class="sr-only">Footnotes</h2>'),
    "标题随语言",
  );
}
console.log("footnotes: 引用 + 定义 → 上标 + 脚注区 ✓");

// ---------- 2. 编号按首次引用顺序，重复引用同一个编号 ----------
{
  const html = render("先 b[^b]，再 a[^a]，又 b 一次[^b]。\n\n[^a]: A\n[^b]: B\n");
  const body = html.slice(0, html.indexOf("<section"));
  assert.deepStrictEqual(
    [...body.matchAll(/<sup>(\d)<\/sup>/g)].map((match) => match[1]),
    ["1", "2", "1"],
    `编号按首次引用顺序，重复引用沿用原编号：${html}`,
  );
  assert.ok(html.indexOf('id="user-content-fn-b"') < html.indexOf('id="user-content-fn-a"'), "条目按引用顺序");
  assert.match(html, /↩ <sup>2<\/sup>|↩<sup>2<\/sup>/);
}
console.log("footnotes: 编号按首次引用顺序、重复引用同号 ✓");

// ---------- 3. 只有引用没有定义 → 上标照常、无空脚注区 ----------
{
  const html = render("没有出处的说法[^missing]。\n");
  assert.ok(html.includes("<sup>1</sup>"), "没有定义也照常编号");
  assert.ok(!html.includes("footnotes"), "没有定义时不渲染空壳脚注区");
  assert.ok(!html.includes("[^missing]"), "原始标记不留在正文");
}
console.log("footnotes: 只有引用没有定义 → 上标保留、无脚注区 ✓");

// ---------- 4. 代码块 / 行内代码里的脚注标记不动 ----------
{
  const fenced = render("```\n[^a]: 不是脚注\n```\n\n正文[^a]: 这行才是定义……不，它是段落\n");
  assert.ok(fenced.includes("[^a]: 不是脚注"), "围栏代码里的标记原样保留");
  const inline = render("行内代码 `[^a]` 不该被当成引用。\n\n[^a]: A\n");
  assert.ok(inline.includes("<code>[^a]</code>"), "行内代码里的标记原样保留");
  assert.ok(!/<sup>1<\/sup><\/code>/.test(inline) && !inline.includes("<sup>1</sup>"), "没有真引用时不冒出上标");
  assert.ok(!inline.includes("footnotes"), "没有真引用时没有脚注区");
}
console.log("footnotes: 代码块与行内代码里的标记不受影响 ✓");

// ---------- 5. 定义体支持块级 markdown；缩进续行 ----------
{
  const html = render("看这里[^x]。\n\n[^x]: 第一行\n    第二行\n\n后面还有正文\n");
  assert.ok(
    html.indexOf("第一行") > html.indexOf("footnotes") && html.includes("第二行"),
    `缩进续行算定义体：${html}`,
  );
  assert.ok(html.indexOf("后面还有正文") < html.indexOf("footnotes"), "没缩进的段落不能被吞进脚注");
}
console.log("footnotes: 缩进续行归入定义，普通段落不受影响 ✓");

// ---------- 6. 重复定义后者覆盖；混合编号沿用旧口径 ----------
{
  const single = render("引用重复定义[^d]。\n\n[^d]: first\n[^d]: second\n");
  assert.match(single, /<p>second ↩<\/p>/, `重复定义后者覆盖：${single}`);
  assert.ok(!single.includes("first"), "先出现的定义不生效");
  const mixed = render(
    "无定义[^missing]，有定义[^a]，重复[^missing]。\n\n[^a]: A\n\n[^d]: first\n[^d]: second\n\n引用重复定义[^d]。\n",
  );
  const mixedBody = mixed.slice(0, mixed.indexOf("<section"));
  assert.deepStrictEqual(
    [...mixedBody.matchAll(/<sup>(\d)<\/sup>/g)].map((match) => match[1]),
    ["1", "2", "1", "3"],
    `缺失定义参与编号、重复定义只占一个序号：${mixed}`,
  );
  assert.match(mixed, /<p>A ↩<\/p>/);
  assert.match(mixed, /<p>second ↩<\/p>/);
  assert.ok(mixed.indexOf("user-content-fn-a") < mixed.indexOf("user-content-fn-d"), "脚注区顺序按首次引用");
}
console.log("footnotes: 重复定义后者覆盖、缺失定义参与编号 ✓");

// ---------- 7. 转义引用保持字面；定义里的引用继续编号 ----------
{
  const escaped = render("转义 \\[^missing] 与真实 [^missing]");
  assert.ok(escaped.includes("[^missing]"), "转义的引用保持字面文字");
  assert.ok(escaped.includes("<sup>1</sup>"), "未转义的那个才是引用");

  const nested = render("正文[^a]\n\n[^a]: 注里有 [^b]\n\n[^b]: B\n");
  assert.match(nested, /注里有 <sup>2<\/sup> ↩/);
  assert.match(nested, /<p>B ↩<\/p>/);
}
console.log("footnotes: 转义引用不生效、定义内引用继续编号 ✓");

// ---------- 8. 仅定义不渲染；缺定义不产生空 section ----------
{
  const onlyDefinition = render("[^a]: A\n");
  assert.ok(!onlyDefinition.includes("footnotes"), "没有引用时不渲染脚注区");
  assert.ok(!onlyDefinition.includes("A"), "定义也不在正文原地显示");
}
console.log("footnotes: 仅有定义 / 缺定义都不产生空壳 ✓");

console.log("\nfootnotes: all assertions passed");
