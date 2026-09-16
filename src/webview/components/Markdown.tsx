import { memo, useMemo } from "react";
import { splitMarkdownBlocks, type MarkdownBlock } from "../markdown";
import { useTexts } from "../texts";
import { CodeBlock } from "./CodeBlock";

const HtmlBlock = memo(function HtmlBlock({ html }: { html: string }) {
  // html 已在 markdown.ts 里经 DOMPurify 过滤
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * 助手正文。按代码围栏切块，HTML 段交给净化后的 innerHTML，
 * 代码段用 React 渲染以附带工具栏（`CodeBlock` 与工具卡共用，见它的文件头）。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const texts = useTexts();
  // 脚注区的无障碍标题走词典（官方键名 `markdown.footnotes`）；语言切换时
  // 词典变了、这里跟着重渲染
  const blocks: MarkdownBlock[] = useMemo(
    () => splitMarkdownBlocks(text, { footnoteLabel: texts.markdownFootnotes }),
    [text, texts.markdownFootnotes],
  );
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <CodeBlock key={index} lang={block.lang} code={block.content} />
        ) : (
          <HtmlBlock key={index} html={block.content} />
        ),
      )}
    </>
  );
});
