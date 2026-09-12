import DOMPurify from "dompurify";
import { Marked } from "marked";

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

/** 渲染为 HTML 字符串（已净化）。 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source ?? "", { async: false }) as string;
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
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "type", "checked", "disabled"],
    // 复选框保持 disabled：消息里的框不该是能点的交互控件（官方亦然）
    ALLOW_DATA_ATTR: false,
  });
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
 */
export function splitMarkdownBlocks(source: string): MarkdownBlock[] {
  const text = source ?? "";
  const blocks: MarkdownBlock[] = [];
  const fence = /^```([^\n`]*)\n?([\s\S]*?)^```[ \t]*$/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const html = renderMarkdown(text.slice(lastIndex, match.index));
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
    const html = renderMarkdown(text.slice(lastIndex));
    if (html.trim()) blocks.push({ kind: "html", content: html });
  }
  return blocks;
}
