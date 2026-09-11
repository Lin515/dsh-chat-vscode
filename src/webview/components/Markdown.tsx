import { memo, useMemo, useState } from "react";
import { post } from "../bridge";
import { IconChevronDown, IconChevronRight, IconCopy, IconPencil } from "../icons";
import { splitMarkdownBlocks, type MarkdownBlock } from "../markdown";
import { useTexts } from "../texts";

/**
 * 代码块卡片：Continue 用 `--vscode-editor-background` 作底、outline 而非
 * border，头部 12px，右侧一组悬停才出现的图标按钮。
 */
function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const texts = useTexts();
  const lines = useMemo(() => code.split("\n"), [code]);
  const long = lines.length > 20;

  return (
    <div className={`code-block${collapsed ? " is-collapsed" : ""}`}>
      <div className="code-block-head">
        <span className="code-block-lang">{lang || "text"}</span>
        <span className="code-block-actions">
          <button
            className="icon-btn"
            title={texts.insertToEditor}
            onClick={() => post({ type: "insertText", text: code })}
          >
            <IconPencil size={13} />
          </button>
          <button
            className="icon-btn"
            title={texts.copy}
            onClick={() => post({ type: "copy", text: code })}
          >
            <IconCopy size={13} />
          </button>
        </span>
      </div>
      <div className="code-block-body">
        <pre>
          <code>{code}</code>
        </pre>
      </div>
      {long ? (
        <button className="code-block-expand" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </button>
      ) : null}
    </div>
  );
}

const HtmlBlock = memo(function HtmlBlock({ html }: { html: string }) {
  // html 已在 markdown.ts 里经 DOMPurify 过滤
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * 助手正文。按代码围栏切块，HTML 段交给净化后的 innerHTML，
 * 代码段用 React 渲染以附带工具栏。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: MarkdownBlock[] = useMemo(() => splitMarkdownBlocks(text), [text]);
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
