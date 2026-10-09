/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-primitives` 的
 * `src/markdown/local-image-syntax.ts`，随 `@deepseek-ai/dsh-client-ui-trajectory@0.2.0-rc.2`
 * 同步（检出 tag `dsh-v0.2.0-rc.2`）。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 *
 * 本仓库的两处改动（都只影响依赖，不影响这里的行为）：
 *
 * 1. import 路径去掉 `.ts` 后缀；
 * 2. 上游的 `classifyFileType(path) === 'image'` 换成下面的 `isImageFilePath()`。
 *    上游那个函数在 `FileTypeIcon.tsx` 里（连同十几个 React 图标组件）——搬它等于把
 *    整个图标模块搬进来。**判据等价**：`classifyFileType` 先过「代码文件名规则」
 *    （`Dockerfile`、`package.json` 这类按名字匹配，`code-file-types.ts` 里没有任何
 *    图片扩展名），再过 `NAME_TYPES`（changelog/contributing/readme），最后才是扩展名表；
 *    所以对一个「以图片扩展名结尾」的路径，它只可能返回 `'image'` 或 `'other'`。
 *    这里把上游扩展名表里 `'image'` 那一档逐条抄下来。
 */

import type { Root, RootContent, PhrasingContent } from 'mdast'

/**
 * 上游 `FileTypeIcon.tsx` 的 `EXTENSION_TYPES` 里映射到 `'image'` 的全部扩展名。
 * @param path - 文件路径或文件名（两种分隔符都认）。
 * @returns 该路径是否被上游判为图片。
 */
function isImageFilePath(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1))
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif',
])

/**
 * Recover only unambiguous, unescaped image-only paragraphs containing a local path with spaces.
 * @param root - Parsed Markdown tree, modified in place.
 * @param source - Original source used to distinguish authored syntax from escaped examples.
 * @returns The same root with recovered image nodes.
 */
export function recoverLocalImages(root: Root, source: string): Root {
  const visit = (node: Root | RootContent): void => {
    if (node.type === 'paragraph' && node.children.length === 1) {
      const [child] = node.children as [PhrasingContent]
      if (child.type === 'text' && child.position !== undefined
        && source.slice(child.position.start.offset, child.position.end.offset) === child.value) {
        const pattern = /^!\[([^\]\n]*)\]\(((?:\/(?!\/)|\.{1,2}\/|[a-z]:[\\/])[^\n<>()[\]"']+\.[a-z\d]+)\)$/iu
        const match = pattern.exec(child.value) as [string, string, string] | null
        if (match !== null && match[2].includes(' ') && isImageFilePath(match[2])) {
          node.children = [{ type: 'image', alt: match[1], url: match[2], position: child.position }]
        }
      }
    } else if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(root)
  return root
}
