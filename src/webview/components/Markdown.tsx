import { memo, useLayoutEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { splitMarkdownBlocks, type MarkdownBlock } from "../markdown";
import { useTexts } from "../texts";
import { hydrateLocalImages } from "../localImages";
import { hydrateFileMentions } from "../fileMentions";
import { browserOpenRequested, externalLinkUrl, parseFileLink, type FileLinkPort } from "../fileLinks";
import { hydrateLinkTitles } from "../linkHovers";
import { post } from "../bridge";
import { CodeBlock } from "./CodeBlock";
import { openImagePreview } from "./Images";

/**
 * 打开正文里点到的一个文件。
 *
 * 界面只交**原样拼写**：相对路径的基准是会话工作目录，那只有宿主知道
 * （`controller.openFile` 经 `resolveChipPath` 解析，与文件芯片同一条路）。
 *
 * `link` 标记这条帧来自**正文里的文件链接**：打不开时的措辞与文件芯片不同
 * （见 `shared/ipc.ts` 的 `openFile`）。
 *
 * 给了鼠标事件且目标是可以直接用浏览器打开的 HTML 文件、又按住 Ctrl/Cmd 时，
 * 改发 `openFileInBrowser`（唯一一份分流；锚点与行内代码共用这个入口）。
 */
function openFile(
  path: string,
  line?: number,
  event?: { readonly ctrlKey: boolean; readonly metaKey: boolean },
): void {
  if (event && browserOpenRequested(event, path)) {
    post({ type: "openFileInBrowser", path });
    return;
  }
  post({ type: "openFile", path, line, link: true });
}

/**
 * 正文里锚点的点击委托。
 *
 * 注入的 HTML 不在任何组件的 props 树里，点击只能从容器上接回来（图片那条路同）。
 * 三分类**按肯定证据**：是本地文件就开文件、是 http(s)/mailto 就交给系统浏览器、
 * 其余（`javascript:`、`command:` 之类，以及页内锚点之外的 scheme）一律拦下不动手——
 * webview 里让链接自己导航会把整个聊天界面换掉。
 *
 * 本地文件里，HTML 家族按住 Ctrl/Cmd 时改走系统浏览器（`browserOpenRequested`）；
 * 普通单击仍交给 VS Code 按资源类型打开，与文件芯片一致。
 */
function activateAnchor(event: ReactMouseEvent<HTMLDivElement>): void {
  const target = event.target;
  const anchor = target instanceof Element ? target.closest("a[href]") : null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  // 页内锚点（模型写的 `[小节](#锚点)`）交给浏览器自己滚，不抢
  if (href === "" || href.startsWith("#")) return;
  event.preventDefault();
  const file = parseFileLink(href);
  if (file) {
    // 流式期间也开（用户 2026-09-26 口径，见 fileLinks.ts）：目标要等 markdown
    // 语法写完整才会渲染成锚点，此刻点到的目标已经是完整的
    openFile(file.path, file.line, event);
    return;
  }
  const external = externalLinkUrl(href);
  if (external) post({ type: "openExternal", url: external });
}

const HtmlBlock = memo(function HtmlBlock({
  html,
  fileLinks,
  cwd,
}: {
  html: string;
  /** 文件链接词表（只有助手正文有；其余调用方缺省，锚点照旧可点）。 */
  fileLinks?: FileLinkPort;
  /** 会话工作目录：正文里的相对路径悬停时补成完整路径（缺省给链接原样拼写）。 */
  cwd?: string;
}) {
  const texts = useTexts();
  const ref = useRef<HTMLDivElement>(null);
  // html 已在 markdown.ts 里经 DOMPurify 过滤。
  //
  // `useLayoutEffect` 而不是 `useEffect`：正文里的本地图片要**在绘制前**换成
  // data URL。等到 paint 之后才换，浏览器会先画一帧破图；流式期间 html 每个
  // token 都变（innerHTML 被 React 整体重置），这一帧每帧都会出现。
  // 行内代码的文件链接同在绘制前换成按钮，理由相同。
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const undoImages = hydrateLocalImages(root, texts);
    const undoTitles = hydrateLinkTitles(root, cwd, texts);
    const undoMentions = hydrateFileMentions(
      root,
      fileLinks,
      cwd,
      texts,
      (path, event) => openFile(path, undefined, event),
    );
    return () => {
      undoImages();
      undoTitles();
      undoMentions();
    };
  }, [html, fileLinks, cwd, texts.imageLoadFailed, texts.imageLoadFailedAt, texts.webFileBrowserHint]);
  return (
    <div
      ref={ref}
      className="md"
      // 正文里的图片（外链、本地图、解析后的 data URL）都点得开：注入的 HTML
      // 不在任何组件的 props 树里，只能用事件委托把点击接回浮层；文件链接同。
      onClick={(event) => {
        const target = event.target;
        if (target instanceof HTMLImageElement && target.src) {
          openImagePreview(target.src, target.alt || texts.messageImageAlt);
          return;
        }
        activateAnchor(event);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/**
 * 助手正文。按代码围栏切块，HTML 段交给净化后的 innerHTML，
 * 代码段用 React 渲染以附带工具栏（`CodeBlock` 与工具卡共用，见它的文件头）。
 */
export const Markdown = memo(function Markdown({
  text,
  fileLinks,
  cwd,
}: {
  text: string;
  /** 文件链接词表（助手正文由 `Message` 按本轮文件给出，见 `fileLinks.ts`）。 */
  fileLinks?: FileLinkPort;
  /** 会话工作目录：相对路径的悬停标题按它补全；缺省保留链接上的原样拼写。 */
  cwd?: string;
}) {
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
          <HtmlBlock key={index} html={block.content} fileLinks={fileLinks} cwd={cwd} />
        ),
      )}
    </>
  );
});
