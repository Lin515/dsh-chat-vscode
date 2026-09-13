import DOMPurify from "dompurify";
import { Marked } from "marked";
import { beginFootnotes, endFootnotes, footnoteExtensions, footnoteSection } from "./footnotes";

/**
 * Markdown → 安全 HTML。
 *
 * 模型输出不可信，因此渲染前一律经 DOMPurify 过滤；代码块交给 React 组件
 * 渲染（带复制/插入按钮），这里只保留基础排版标签。
 */

const marked = new Marked({
  gfm: true,
  /**
   * **CommonMark 软换行**（官方同一口径）：正文里的单个换行按「空格」处理，
   * 只有硬换行（行尾两个空格或反斜杠）才断行。
   *
   * 此前是 `breaks: true`（单个换行 → `<br>`），那是本扩展自己的选择：模型输出里
   * 不带 markdown 标记的短行会被并成一段。与官方对齐后，正文段落的换行语义完全由
   * markdown 决定——这也让「模型给的 markdown 长什么样，界面上就长什么样」成立。
   */
  breaks: false,
  // 脚注（`markdown.footnotes`）：marked 不带这套语法，由 `footnotes.ts` 补
  extensions: footnoteExtensions(),
});

/**
 * `input` 只放行 GFM 任务列表的**复选框**。
 *
 * 白名单一旦允许 `input` 标签，模型输出里的 `<input type="text">`、`type="file"`
 * 之类也会一起活下来，在消息正文里长出一个可交互的控件——那不是我们要的东西。
 * 所以这里挂一个 DOMPurify 钩子把 type 不是 checkbox 的 input 整个删掉。
 *
 * 钩子在模块加载时注册**一次**（DOMPurify 的钩子是全局的，每次渲染都 addHook
 * 会不断累积）。这个模块只进 webview bundle，Node 侧的断言不会 import 它。
 */
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName !== "input") return;
  const type = (node as Element).getAttribute?.("type");
  if (type !== "checkbox") node.parentNode?.removeChild(node);
});

/** 渲染选项。 */
export interface RenderMarkdownOptions {
  /**
   * 脚注区的无障碍标题（视觉上隐藏，见 `.sr-only`）。
   *
   * 由界面把词典里的 `markdownFootnotes`（官方 `markdown.footnotes` 同名的键）
   * 传进来——宿主与渲染器都不写死文案，换语言才会跟着变。
   */
  footnoteLabel?: string;
}

/** 缺省标题：只有不关心语言的调用方（Node 断言）会走到这里。 */
const DEFAULT_FOOTNOTE_LABEL = "Footnotes";

/** 一份 HTML 走一遍白名单。脚注区（`section` / `sup` / `id` / `data-footnotes`）在列。 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
      "a", "img", "hr", "table", "thead", "tbody", "tr", "th", "td", "span",
      // GFM 任务列表的复选框：marked 会渲染 `<input type="checkbox" disabled>`，
      // 而白名单里没有 `input` —— 整个复选框被静默剥掉，`- [x] 做完的事` 与
      // `- 没做的事` 在界面上长得一模一样（官方渲染链带了 taskList 扩展，
      // 复选框是真的画出来的）。只放行 checkbox 由上面的钩子兜住。
      "input",
      // 脚注：官方脚注区的容器是 `section.footnotes > ol > li`，引用是 `sup`。
      // 漏掉 `section`/`sup` 时脚注会被静默剥成一堆裸文本（同一类静默失效）。
      "section", "sup",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "type", "checked", "disabled",
      // 脚注区的锚点与标记：`id="user-content-fn-1"` / `data-footnotes`
      "id", "data-footnotes"],
    // 复选框保持 disabled：消息里的框不该是能点的交互控件（官方亦然）
    // 注意：`ALLOW_DATA_ATTR: false` 只关掉**通配**放行，`ALLOWED_ATTR` 里
    // 显式列出的 `data-footnotes` 仍然有效（DOMPurify 的判定顺序：先看白名单）
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * 渲染一份 markdown 文本（含文末脚注区）。
 *
 * @param source markdown 源码。
 * @param options 脚注标题等渲染选项。
 */
export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  const state = beginFootnotes();
  try {
    const html = renderBody(source);
    const notes = footnoteSection(state, options.footnoteLabel ?? DEFAULT_FOOTNOTE_LABEL);
    return notes ? `${html}\n${sanitize(notes)}` : html;
  } finally {
    endFootnotes();
  }
}

/**
 * 一段正文 → 已净化的 HTML。
 *
 * **不碰脚注状态**：状态由整篇文档持有（见 `splitMarkdownBlocks`），渲染器从
 * `footnotes.ts` 的 module 级 `active` 里读它。
 */
function renderBody(source: string): string {
  const html = marked.parse(source ?? "", { async: false }) as string;
  return sanitize(html);
}

export interface MarkdownBlock {
  kind: "html" | "code";
  /** html 块的内容，或 code 块的源码。 */
  content: string;
  /** code 块的语言标签。 */
  lang?: string;
}

/**
 * 把 markdown 切成「HTML 片段」与「代码块」两类，便于用 React 渲染带工具栏的
 * 代码卡片，而不是在 HTML 里塞按钮。
 *
 * **脚注是整篇文档级的**：分块渲染时各块共用一份脚注状态（编号按引用出现的先后
 * 排），脚注区在全部块渲染完之后拼在**最末尾**——按块各拼一次会得到好几个
 * `section.footnotes`，编号还会从 1 重新开始。
 */
export function splitMarkdownBlocks(
  source: string,
  options: RenderMarkdownOptions = {},
): MarkdownBlock[] {
  const text = source ?? "";
  const blocks: MarkdownBlock[] = [];
  const fence = /^```([^\n`]*)\n?([\s\S]*?)^```[ \t]*$/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const state = beginFootnotes();
  try {
    while ((match = fence.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const html = renderBody(text.slice(lastIndex, match.index));
        if (html.trim()) blocks.push({ kind: "html", content: html });
      }
      blocks.push({
        kind: "code",
        lang: (match[1] ?? "").trim(),
        content: match[2].replace(/\n$/, ""),
      });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      const html = renderBody(text.slice(lastIndex));
      if (html.trim()) blocks.push({ kind: "html", content: html });
    }

    // 脚注区：整篇一次（引用与定义可能分处代码块两侧）
    const notes = footnoteSection(state, options.footnoteLabel ?? DEFAULT_FOOTNOTE_LABEL);
    if (notes) blocks.push({ kind: "html", content: sanitize(notes) });
  } finally {
    endFootnotes();
  }
  return blocks;
}
