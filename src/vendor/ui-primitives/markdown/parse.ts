/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-primitives` 的
 * `src/markdown/parse.ts`，随 `@deepseek-ai/dsh-client-ui-trajectory@0.2.0-rc.2`
 * 同步（检出 tag `dsh-v0.2.0-rc.2`）。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 *
 * ## 本仓库的改动（省略了一个渲染臂）
 *
 * 上游这份文件导出**两个**语法臂：`parseGfm`（流式臂，不含 math）与
 * `parseGfmWithMath`（结算臂，GFM + TeX math + 兼容分隔符）。**这里只搬了
 * `parseGfm`**：轨迹的全部消费方（`extractMarkdownPlainText` 的默认 `mode: 'all'`，
 * 经 `trajectory-preview.ts`）走的就是流式臂——上游 `ui-trajectory` 里
 * `parseGfmWithMath` **零引用**（那一臂属于 markdown 渲染器，不是预览投影）。
 *
 * 连带省掉的依赖：`mathCompatibility.ts`、`mdast-util-math`、`micromark-extension-math`。
 * 若将来有消费方需要结算臂，照上游补回这两行 import 与 `parseGfmWithMath`，
 * 并把这几个依赖加进 `package.json`——**不要**在这里只用一半。
 *
 * 另：import 路径去掉 `.ts` 后缀（我们的构建不启用 `allowImportingTsExtensions`）。
 */

import type { Root } from 'mdast'
import { recoverLocalImages } from './local-image-syntax'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { cjkFriendlyStrong } from './cjkFriendlyStrong'

/**
 * Parse GFM markdown (the streaming arm's grammar: no math, so incomplete
 * TeX never flashes KaTeX errors mid-stream).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfm(text: string): Root {
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong()],
    mdastExtensions: [gfmFromMarkdown()],
  }), text)
}
