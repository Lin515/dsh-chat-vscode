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
  breaks: true,
});

/** 渲染为 HTML 字符串（已净化）。 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
      "a", "img", "hr", "table", "thead", "tbody", "tr", "th", "td", "span",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class"],
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
