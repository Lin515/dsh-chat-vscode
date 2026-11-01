/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-primitives` 的
 * `src/markdown/parse.ts`，固定版本 `0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`，
 * commit `639ed015397290b3745d163aafe02ffee4aa3f84`）的完整副本。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 *
 * ## 本仓库的改动
 *
 * - import 路径去掉 `.ts` 后缀（我们的构建不启用 `allowImportingTsExtensions`）。
 * - 文件头补充来源与改动说明；函数体逐字相同。
 *
 * 两个语法臂必须成对保留：`parseGfm` 是 streaming / 轨迹投影的 GFM 语法；
 * `parseGfmWithMath` 是 settled 的 GFM + TeX math 语法，依赖
 * `mathCompatibility()` 与 `math()` 同时注册。
 */
/**
 * The markdown renderer's two mdast grammars, one per rendering arm. Each
 * arm is internally consistent — the incremental tail parses, the one-shot
 * parses, and the plain-text projection of a given grammar always agree on
 * where blocks start and end — and the settled grammar is the streaming one
 * plus the math extensions, so the arms differ only where TeX delimiters
 * begin a math construct (a `$$` block is a paragraph while streaming and a
 * math block once settled, by design).
 */

import type { Root } from 'mdast'
import { recoverLocalImages } from './local-image-syntax'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { cjkFriendlyStrong } from './cjkFriendlyStrong'
import { mathCompatibility } from './mathCompatibility'

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

/**
 * Parse GFM markdown plus TeX math with the compatibility delimiters
 * (the settled arm's grammar).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfmWithMath(text: string): Root {
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong(), mathCompatibility(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }), text)
}
