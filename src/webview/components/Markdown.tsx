import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { splitMarkdownBlocks, type MarkdownBlock } from "../markdown";
import { useTexts } from "../texts";
import { hydrateLocalImages } from "../localImages";
import { CodeBlock } from "./CodeBlock";
import { openImagePreview } from "./Images";

const HtmlBlock = memo(function HtmlBlock({ html }: { html: string }) {
  const texts = useTexts();
  const ref = useRef<HTMLDivElement>(null);
  // html 已在 markdown.ts 里经 DOMPurify 过滤。
  //
  // `useLayoutEffect` 而不是 `useEffect`：正文里的本地图片要**在绘制前**换成
  // data URL。等到 paint 之后才换，浏览器会先画一帧破图；流式期间 html 每个
  // token 都变（innerHTML 被 React 整体重置），这一帧每帧都会出现。
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    return hydrateLocalImages(root, texts.imageLoadFailed);
  }, [html, texts.imageLoadFailed]);
  return (
    <div
      ref={ref}
      className="md"
      // 正文里的图片（外链、本地图、解析后的 data URL）都点得开：注入的 HTML
      // 不在任何组件的 props 树里，只能用事件委托把点击接回浮层。
      onClick={(event) => {
        const target = event.target;
        if (target instanceof HTMLImageElement && target.src) {
          openImagePreview(target.src, target.alt || texts.messageImageAlt);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
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
