/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-trajectory`（`0.2.0-rc.2`，检出 tag
 * `dsh-v0.2.0-rc.2`）的 `src/client/trajectory-preview.ts` **逐字副本**。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 * 本仓库唯一的改动是 import 指向同仓库的 vendor 副本（上游指 `ui-primitives` 包）。
 */

import { extractMarkdownPlainText } from '../ui-primitives/markdown/plain-text'

/** Bounded Markdown-to-text projection shared by trajectory consumers. */

const PREVIEW_SOURCE_CHARACTERS = 2_048
const PREVIEW_OUTPUT_CHARACTERS = 512

/**
 * Build a bounded one-line preview without parsing the complete Markdown document.
 * @param text - Untrusted message, reasoning, payload, or result text.
 * @returns A compact preview capped independently from the retained source.
 */
export function trajectoryPreviewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS)
  const compact = extractMarkdownPlainText(source).replace(/\s+/g, ' ').trim()
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd()
  return source.length < text.length || preview.length < compact.length
    ? `${preview}…`
    : preview
}
