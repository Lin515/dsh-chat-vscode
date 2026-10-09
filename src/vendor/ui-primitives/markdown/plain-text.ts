/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-primitives` 的
 * `src/markdown/plain-text.ts`，随 `@deepseek-ai/dsh-client-ui-trajectory@0.2.0-rc.2`
 * 同步（检出 tag `dsh-v0.2.0-rc.2`）。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 * 本仓库唯一的改动是 import 路径去掉 `.ts` 后缀。
 *
 * 它是**轨迹预览文本的权威实现**：解析共用渲染器的流式 GFM 语法
 * （{@link parseGfm}），所以剥掉的记号正好是渲染器会画出来的那些；裸 HTML 原样保留、
 * 链接留标签、图片留 alt、代码留源文本。
 */

import { parseGfm } from './parse'

/** Amount of parsed Markdown content returned by the extractor. */
export type MarkdownPlainTextMode = 'all' | 'first-line' | 'first-paragraph'

/** Options for {@link extractMarkdownPlainText}. */
export interface MarkdownPlainTextOptions {
  /** Projection boundary; defaults to the complete document. */
  mode?: MarkdownPlainTextMode
}

interface MarkdownNode {
  type: string
  value?: string
  alt?: string
  children?: MarkdownNode[]
}

function inlineText(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return node.value ?? ''
    case 'image':
    case 'imageReference':
      return node.alt ?? ''
    case 'break':
      return '\n'
    case 'html':
      return node.value ?? ''
    default:
      return node.children?.map(inlineText).join('') ?? ''
  }
}

function compactInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function blockText(node: MarkdownNode): string {
  switch (node.type) {
    case 'root':
    case 'blockquote':
      return node.children?.map(blockText).filter(Boolean).join('\n\n') ?? ''
    case 'paragraph':
    case 'heading':
      return compactInline(inlineText(node))
    case 'code':
      return node.value?.trim() ?? ''
    case 'list':
      return node.children?.map(blockText).filter(Boolean).join('\n') ?? ''
    case 'listItem':
      return node.children?.map(blockText).filter(Boolean).join(' ') ?? ''
    case 'table':
      return node.children?.map(blockText).filter(Boolean).join('\n') ?? ''
    case 'tableRow':
      return node.children?.map(blockText).join('\t') ?? ''
    case 'tableCell':
      return compactInline(inlineText(node))
    case 'html':
      return node.value ?? ''
    case 'thematicBreak':
    case 'definition':
      return ''
    default:
      return compactInline(inlineText(node))
  }
}

function findFirstParagraph(node: MarkdownNode): string | undefined {
  if (node.type === 'paragraph') {
    const text = compactInline(inlineText(node))
    if (text !== '') return text
  }
  for (const child of node.children ?? []) {
    const text = findFirstParagraph(child)
    if (text !== undefined) return text
  }
  return undefined
}

function fullText(root: MarkdownNode): string {
  return blockText(root)
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Parse GFM Markdown, remove its presentation markup, and preserve raw HTML literally.
 * @param markdown - Markdown source.
 * @param options - Optional extraction boundary.
 * @returns Plain text for the whole document, first visible line, or first semantic paragraph.
 */
export function extractMarkdownPlainText(
  markdown: string,
  options: MarkdownPlainTextOptions = {},
): string {
  const { mode = 'all' } = options
  const root = parseGfm(markdown) as MarkdownNode
  const all = fullText(root)
  switch (mode) {
    case 'all':
      return all
    case 'first-line':
      return all.split('\n').find(line => line !== '') ?? ''
    case 'first-paragraph':
      return findFirstParagraph(root) ?? all.split('\n').find(line => line !== '') ?? ''
  }
}
