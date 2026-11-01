/**
 * 正文里链接的悬停说明：**完整目标**（本地文件的绝对路径 / 外链地址），
 * 以及「按住 Alt 打开可编辑的真实文件」「按住 Ctrl/Cmd 在浏览器中打开 HTML」
 * 两档提示。
 *
 * 两条来源分别与点击那条链路同源：
 * - 本地文件先过 `parseFileLink`，再按会话 cwd 归一到绝对路径（`pathDisplay.ts`
 *   的 `resolveDisplayPath`，与 `@` 候选的悬停同一套口径）；拿不到 cwd 时原样给出
 *   链接上的路径，**不猜**绝对位置；
 * - 外链给出 `externalLinkUrl` 认下的那个地址（http / https / mailto）。
 *
 * 锚点由 React 渲染树直接拥有，标题在渲染时由 `mergeHoverTitle` 合到 `<a>` 上，
 * 不在渲染后扫描 DOM 注入；行内代码的文件按钮同理，见 `markdown/render.tsx`。
 *
 * 纯函数与测试：见 `scripts/linkHovers.test.ts`。
 */
import { isBrowserOpenableFile } from "../shared/webFile";
import { altLabel, modifierLabel } from "./modifierLabel";
import { resolveDisplayPath } from "./pathDisplay";

/** 悬停标题需要的文案（只取这一条，避免把整份 `Texts` 拖进纯函数测试）。 */
export interface LinkHoverTexts {
  /** Alt 真实文件那一档（中英文在 `messages.ts` 唯一登记）。 */
  readonly openRealFileHint: (alt: string) => string;
  /** HTML 类文件的 Ctrl/Cmd 浏览器提示。 */
  readonly webFileBrowserHint: (modifier: string) => string;
}

/** 文件 / 目录链接的完整路径（拿不到 cwd 或目标不是绝对形态时原样返回）。 */
export function resolvedFilePath(cwd: string | undefined, path: string): string {
  return resolveDisplayPath(cwd, path) ?? path;
}

/**
 * 文件链接的悬停标题：完整路径、Alt 真实文件提示；HTML 类文件再加一行 Ctrl/Cmd 浏览器提示。
 *
 * @param cwd 会话工作目录（相对路径的解析基准）；没有时保留链接上的原样拼写。
 * @param path 链接目标里的路径（已由 `parseFileLink` 解码）。
 * @param texts 两档提示文案。
 * @param alt Alt 标签；缺省按当前 webview 的平台算（测试可显式给）。
 * @param modifier Ctrl/Cmd 标签；缺省按当前 webview 的平台算（测试可显式给）。
 */
export function fileLinkHoverTitle(
  cwd: string | undefined,
  path: string,
  texts: LinkHoverTexts,
  alt: string = altLabel(),
  modifier: string = modifierLabel(),
): string {
  const lines = [resolvedFilePath(cwd, path), texts.openRealFileHint(alt)];
  if (isBrowserOpenableFile(path)) lines.push(texts.webFileBrowserHint(modifier));
  return lines.join("\n");
}

/** 外链悬停标题：就是**完整地址**本身（用户点开的是它，不是链接文字）。 */
export function externalLinkHoverTitle(url: string): string {
  return url;
}

/**
 * 合并作者写的 `title` 与完整目标提示。
 *
 * 作者写了说明就保留它，把目标追加在后；没写就只给目标。渲染层直接把它放到
 * 锚点上，不再由渲染后的 DOM 注入。
 */
export function mergeHoverTitle(
  authored: string | null | undefined,
  hint: string | undefined,
): string | undefined {
  if (!hint) return authored === null ? undefined : authored;
  return authored !== null && authored !== undefined && authored !== "" && authored !== hint
    ? `${authored}\n${hint}`
    : hint;
}
