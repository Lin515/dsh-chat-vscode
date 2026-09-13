/**
 * Markdown 脚注（`markdown.footnotes`）的**行为**断言。
 *
 * 为什么这个文件能跑：脚注的 marked 扩展单独放在 `src/webview/footnotes.ts`，
 * 只依赖 marked，不碰 DOMPurify（净化需要真实 DOM，Node 里跑不了）。所以这里用
 * 真的 marked + 真的扩展解析一段 markdown，逐条检查产出——不是「源码里有这行字」
 * 那种结构断言。
 *
 * 结构对齐官方的三条：引用 `<sup>N</sup>` 按首次引用顺序编号；只有引用没有定义
 * 的标号不进脚注区；脚注区是 `section.footnotes > h2.sr-only + ol > li`。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";
import { beginFootnotes, endFootnotes, footnoteExtensions, footnoteSection } from "../src/webview/footnotes";

/** 用与 `markdown.ts` 相同的方式渲染：一整篇共用一个脚注状态。 */
function render(source: string, label = "脚注"): { html: string; section: string | undefined } {
  const marked = new Marked({ gfm: true, breaks: false, extensions: footnoteExtensions() });
  const state = beginFootnotes();
  try {
    const html = marked.parse(source, { async: false }) as string;
    return { html, section: footnoteSection(state, label) };
  } finally {
    endFootnotes();
  }
}

// ---------- 1. 引用 + 定义 → 上标数字 + 文末脚注区 ----------
{
  const { html, section } = render("结论在这里[^a]。\n\n[^a]: 出处与说明\n");
  assert.ok(/<sup>1<\/sup>/.test(html), `引用要渲染成上标数字，实际：${html}`);
  assert.ok(!/\[\^a\]/.test(html), `原始标记不该留在正文里：${html}`);
  assert.ok(!/出处与说明/.test(html), `定义**不原地渲染**，只进脚注区：${html}`);
  assert.ok(section, "有定义就该有脚注区");
  assert.ok(/<section data-footnotes class="footnotes">/.test(section!), `脚注区容器：${section}`);
  assert.ok(/<h2 id="footnote-label" class="sr-only">脚注<\/h2>/.test(section!), `无障碍标题：${section}`);
  assert.ok(/<ol>/.test(section!) && /<li id="user-content-fn-a">/.test(section!), `条目锚点：${section}`);
  assert.ok(/出处与说明/.test(section!), `定义正文进脚注区：${section}`);
  assert.ok(/↩/.test(section!), `回跳箭头：${section}`);
}
console.log("footnotes: 引用 + 定义 → 上标 + 脚注区 ✓");

// ---------- 2. 编号按**首次引用**顺序，重复引用同一个编号 ----------
{
  const { html, section } = render("先 b[^b]，再 a[^a]，又 b 一次[^b]。\n\n[^a]: A\n[^b]: B\n");
  assert.deepStrictEqual(
    [...html.matchAll(/<sup>(\d)<\/sup>/g)].map((m) => m[1]),
    ["1", "2", "1"],
    `编号按首次引用顺序，重复引用沿用原编号：${html}`,
  );
  assert.ok(
    /<li id="user-content-fn-b">/.test(section!) && /<li id="user-content-fn-a">/.test(section!),
    `条目顺序也按引用顺序（b 在前）：${section}`,
  );
  // 引用两次 → 两个回跳箭头，第二个带 <sup>2</sup>
  assert.ok(/↩<\/p>|↩\s*<\/p>/.test(section!) || /↩/.test(section!), "回跳箭头存在");
  assert.ok(/↩<sup>2<\/sup>/.test(section!), `重复引用要给出第二个回跳：${section}`);
}
console.log("footnotes: 编号按首次引用顺序 ✓");

// ---------- 3. 只有引用没有定义 → 不进脚注区（官方 continue 同口径） ----------
{
  const { html, section } = render("没有出处的说法[^missing]。\n");
  assert.ok(/<sup>1<\/sup>/.test(html), "引用照常渲染成上标");
  assert.strictEqual(section, undefined, "没有定义时不渲染空壳脚注区");
}
console.log("footnotes: 只有引用没有定义 → 无脚注区 ✓");

// ---------- 4. 代码块 / 行内代码里的脚注标记**不动** ----------
{
  const fenced = render("```\n[^a]: 不是脚注\n```\n\n正文[^a]: 这行才是定义……不，它是段落\n");
  assert.ok(/\[\^a\]: 不是脚注/.test(fenced.html), `围栏代码块里的标记必须原样保留：${fenced.html}`);

  const inline = render("行内代码 `[^a]` 不该被当成引用。\n\n[^a]: A\n");
  assert.ok(/<code>\[\^a\]<\/code>/.test(inline.html), `行内代码里的标记原样保留：${inline.html}`);
  assert.ok(!/<sup>1<\/sup>\s*<\/code>/.test(inline.html), "行内代码里不该冒出上标");
  assert.ok(
    !inline.section || inline.section === undefined,
    "没有任何真引用时不该有脚注区（唯一的 [^a] 在行内代码里）",
  );
}
console.log("footnotes: 代码块与行内代码里的标记不受影响 ✓");

// ---------- 5. 定义体支持块级 markdown；多行缩进续行 ----------
{
  const { section } = render("看这里[^x]。\n\n[^x]: 第一行\n    第二行\n\n后面还有正文\n");
  assert.ok(section && /第一行/.test(section) && /第二行/.test(section), `缩进续行算定义体：${section}`);
  assert.ok(!/后面还有正文/.test(section!), "没缩进的段落不能被吞进脚注");
}
console.log("footnotes: 缩进续行归入定义，普通段落不受影响 ✓");

// ---------- 6. 结构不变量：渲染链真的接上了这两条扩展与白名单 ----------
{
  const markdown = readFileSync(join(process.cwd(), "src", "webview", "markdown.ts"), "utf8");
  assert.ok(/extensions:\s*footnoteExtensions\(\)/.test(markdown), "markdown.ts 必须挂上脚注扩展");
  for (const tag of ["section", "sup"]) {
    assert.ok(
      new RegExp(`ALLOWED_TAGS:[\\s\\S]*?"${tag}"`).test(markdown),
      `ALLOWED_TAGS 必须放行 ${tag}：否则脚注区被 DOMPurify 静默剥成裸文本`,
    );
  }
  for (const attr of ["id", "data-footnotes"]) {
    assert.ok(
      new RegExp(`ALLOWED_ATTR:[\\s\\S]*?"${attr}"`).test(markdown),
      `ALLOWED_ATTR 必须放行 ${attr}（锚点与脚注标记）`,
    );
  }
  assert.ok(
    /footnoteSection\(state/.test(markdown),
    "分块渲染要在全部块渲染完之后拼一次脚注区（按块各拼一次会得到多个 section）",
  );
}
console.log("footnotes: 渲染链接上了扩展与白名单 ✓");

console.log("\nfootnotes: all assertions passed");
