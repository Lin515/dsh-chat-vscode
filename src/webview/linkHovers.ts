/**
 * 正文里链接的悬停说明：**完整目标**（本地文件的绝对路径 / 外链地址），
 * 以及「这个文件可以在浏览器里直接打开」时的修饰键提示。
 *
 * 两条来源分别与点击那条链路同源：
 * - 本地文件先过 `parseFileLink`，再按会话 cwd 归一到绝对路径（`pathDisplay.ts`
 *   的 `resolveDisplayPath`，与 `@` 候选的悬停同一套口径）；拿不到 cwd 时原样给出
 *   链接上的路径，**不猜**绝对位置；
 * - 外链给出 `externalLinkUrl` 认下的那个地址（http / https / mailto）。
 *
 * 锚点是 `dangerouslySetInnerHTML` 注入的，不在 React props 树里，所以标题只能在
 * **渲染之后**补（`hydrateLinkTitles`）。行内代码的文件链接同理，那一份在
 * `fileMentions.ts` 里与按钮一起补。
 *
 * 纯函数与 DOM 变换各就各位：断言见 `scripts/linkHovers.test.ts`。
 */
import { isBrowserOpenableFile } from "../shared/webFile";
import { externalLinkUrl, parseFileLink } from "./fileLinks";
import { resolveDisplayPath } from "./pathDisplay";

/** 悬停标题需要的文案（只取这一条，避免把整份 `Texts` 拖进纯函数测试）。 */
export interface LinkHoverTexts {
  /** HTML 类文件的修饰键提示（中英文在 `messages.ts` 唯一登记）。 */
  readonly webFileBrowserHint: string;
}

/** 文件 / 目录链接的完整路径（拿不到 cwd 或目标不是绝对形态时原样返回）。 */
export function resolvedFilePath(cwd: string | undefined, path: string): string {
  return resolveDisplayPath(cwd, path) ?? path;
}

/**
 * 文件链接的悬停标题：完整路径；HTML 类文件再加一行浏览器打开提示。
 *
 * @param cwd 会话工作目录（相对路径的解析基准）；没有时保留链接上的原样拼写。
 * @param path 链接目标里的路径（已由 `parseFileLink` 解码）。
 */
export function fileLinkHoverTitle(
  cwd: string | undefined,
  path: string,
  texts: LinkHoverTexts,
): string {
  const full = resolvedFilePath(cwd, path);
  return isBrowserOpenableFile(path) ? `${full}\n${texts.webFileBrowserHint}` : full;
}

/** 外链悬停标题：就是**完整地址**本身（用户点开的是它，不是链接文字）。 */
export function externalLinkHoverTitle(url: string): string {
  return url;
}

/**
 * 给已渲染的正文锚点补 `title`。
 *
 * 只碰三档里**认得出来**的两档（本地文件 / 外链）：`javascript:`、页内锚点之类
 * 保持原样，不编一个会误导人的标题。锚点上原本就有 markdown 自己写的标题时
 * **保留它、把完整目标追加在后面**——悬停既要能确认目标，也不能吞掉作者写的说明。
 *
 * @returns 清理函数：把标题还原成 hydrate 之前的样子（词表 / cwd 变化后会重新跑）。
 */
export function hydrateLinkTitles(
  root: HTMLElement,
  cwd: string | undefined,
  texts: LinkHoverTexts,
): () => void {
  const restore: (() => void)[] = [];
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (href === "" || href.startsWith("#")) continue;
    const file = parseFileLink(href);
    const hint = file ? fileLinkHoverTitle(cwd, file.path, texts) : externalLinkUrl(href);
    if (hint === undefined) continue;
    const previous = anchor.getAttribute("title");
    const title = previous && previous !== hint ? `${previous}\n${hint}` : hint;
    anchor.setAttribute("title", title);
    restore.push(() => {
      if (previous === null) anchor.removeAttribute("title");
      else anchor.setAttribute("title", previous);
    });
  }
  return () => {
    for (const undo of restore) undo();
  };
}
