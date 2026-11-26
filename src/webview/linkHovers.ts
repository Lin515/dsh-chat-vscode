/**
 * 正文里链接的悬停说明：**完整目标**（本地文件的绝对路径 / 外链地址），
 * 以及「按住 Alt 打开可编辑的真实文件」「按住 Ctrl/Cmd 在浏览器中打开 HTML」
 * 两档提示。文件链接的单击档（`dshChat.openRealFileOnClick`）打开后，单击本身
 * 已经走真实文件，Alt 那一行不再出现（动作仍保留；见 `fileLinks.showsAltFileHint`）。
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
import {
  DEFAULT_FILE_OPEN_POLICY,
  showsAltFileHint,
  type FileOpenPolicy,
} from "./fileLinks";
import { altLabel, modifierLabel } from "./modifierLabel";
import { resolveDisplayPath } from "./pathDisplay";

/** 悬停标题需要的文案（只取这两条，避免把整份 `Texts` 拖进纯函数测试）。 */
export interface LinkHoverTexts {
  /** Alt 真实文件那一档（中英文在 `messages.ts` 唯一登记）。 */
  readonly openRealFileHint: (alt: string) => string;
  /** HTML 类文件的 Ctrl/Cmd 浏览器提示。 */
  readonly webFileBrowserHint: (modifier: string) => string;
}

/** 悬停标题的可选项：平台标签与当前单击档。 */
export interface FileLinkHoverOptions {
  /** Alt 标签；缺省按当前 webview 的平台算（测试可显式给）。 */
  readonly alt?: string;
  /** Ctrl/Cmd 标签；缺省按当前 webview 的平台算（测试可显式给）。 */
  readonly modifier?: string;
  /** 文件链接单击档；缺省 = 单击只读副本。 */
  readonly policy?: FileOpenPolicy;
}

/** 文件 / 目录链接的完整路径（拿不到 cwd 或目标不是绝对形态时原样返回）。 */
export function resolvedFilePath(cwd: string | undefined, path: string): string {
  return resolveDisplayPath(cwd, path) ?? path;
}

/**
 * 文件链接的悬停标题：完整路径、Alt 真实文件提示；HTML 类文件再加一行 Ctrl/Cmd
 * 浏览器提示。单击已经是真实文件时省掉 Alt 那一行（见 `showsAltFileHint`）。
 *
 * @param cwd 会话工作目录（相对路径的解析基准）；没有时保留链接上的原样拼写。
 * @param path 链接目标里的路径（已由 `parseFileLink` 解码）。
 * @param texts 两档提示文案。
 * @param options 平台标签与单击档；都缺省时按当前平台与「单击只读副本」处理。
 */
export function fileLinkHoverTitle(
  cwd: string | undefined,
  path: string,
  texts: LinkHoverTexts,
  options: FileLinkHoverOptions = {},
): string {
  const policy = options.policy ?? DEFAULT_FILE_OPEN_POLICY;
  const lines = [resolvedFilePath(cwd, path)];
  if (showsAltFileHint(policy)) lines.push(texts.openRealFileHint(options.alt ?? altLabel()));
  if (isBrowserOpenableFile(path)) {
    lines.push(texts.webFileBrowserHint(options.modifier ?? modifierLabel()));
  }
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
