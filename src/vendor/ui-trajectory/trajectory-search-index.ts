/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-trajectory`（`0.2.0-rc.2`，检出 tag
 * `dsh-v0.2.0-rc.2`）的 `src/client/trajectory-search-index.ts` **逐字副本**。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 * 本仓库唯一的改动是 import 路径：`./layout.ts` → `./trajectory-turn-model`
 * （上游 `layout.ts` 的类型摘录）、去掉 `.ts` 后缀。
 *
 * 匹配语义（与「整串子串比较」的区别都在这里）：
 * `recordSources()` 列出的字段全部 join 后 `toLocaleLowerCase()`，查询按**空白分词**、
 * 要求**每个词都命中**（AND），空查询返回 `null`；身份用 `trajectoryRecordId`
 * （稳定，前插历史不会串行）；`requestOnly` 行**不索引**；Markdown 源字段
 * （`previewMarkdown` / `resultPreviewMarkdown`）走 `trajectoryPreviewText` 投影后入库。
 */

import type { TrajectoryTurnModel } from './trajectory-turn-model'
import type { TrajectoryCellProps } from './trajectory-record'
import { trajectoryRecordId } from './trajectory-record'
import { trajectoryPreviewText } from './trajectory-preview'

interface SearchEntry {
  readonly sources: readonly string[]
  readonly text: string
}

function searchableJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function markdownPreview(cell: TrajectoryCellProps): string {
  if (cell.previewMarkdown === undefined) return ''
  const preview = trajectoryPreviewText(cell.previewMarkdown)
  if (cell.text === '') return preview
  return preview === '' ? cell.text : `${cell.text} · ${preview}`
}

function resultPreview(cell: TrajectoryCellProps): string {
  return cell.resultPreviewMarkdown === undefined
    ? cell.result ?? ''
    : trajectoryPreviewText(cell.resultPreviewMarkdown)
}

function recordSources(
  turn: number | null,
  group: string,
  cell: TrajectoryCellProps,
): readonly string[] {
  const blocks = [
    ...(cell.sourceBlocks ?? []),
    ...(cell.outputBlocks ?? []),
  ]
  return [
    turn === null ? 'between turns' : `turn ${turn}`,
    group,
    cell.kind,
    cell.kind === 'message' ? 'assistant' : '',
    cell.text,
    cell.previewMarkdown ?? '',
    cell.inputDetail ?? '',
    cell.outputDetail ?? '',
    cell.thinkingDetail ?? '',
    cell.schemaDetail ?? '',
    cell.result ?? '',
    cell.resultPreviewMarkdown ?? '',
    cell.callId ?? '',
    ...blocks.flatMap(block => [
      block.type,
      block.content,
      block.callId ?? '',
      block.toolName ?? '',
      block.attachment?.name ?? '',
    ]),
    searchableJson(cell.messageSource),
    searchableJson(cell.promptDetail),
    searchableJson(cell.previousPromptDetail),
  ]
}

/** Session-view-local index that reparses Markdown only when one record's source changes. */
export class TrajectorySearchIndex {
  private readonly entries = new Map<string, SearchEntry>()
  private layouts: readonly (readonly TrajectoryTurnModel[])[] | undefined

  /**
   * Incrementally synchronize one or more current trajectory layout slices.
   * @param layouts - Finalized and optional streaming layouts from the same view.
   * @returns Whether the indexed layout version changed.
   */
  update(layouts: readonly (readonly TrajectoryTurnModel[])[]): boolean {
    if (this.layouts === layouts) return false
    this.layouts = layouts
    const seen = new Set<string>()
    for (const turns of layouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const cell of group.cells) {
            if (cell.requestOnly === true) continue
            const id = trajectoryRecordId(cell)
            const sources = recordSources(turn.turn, group.title, cell)
            const previous = this.entries.get(id)
            const entry = previous !== undefined && sameSources(previous.sources, sources)
              ? previous
              : {
                sources,
                text: [
                  ...sources,
                  markdownPreview(cell),
                  resultPreview(cell),
                ].join('\n').toLocaleLowerCase(),
              }
            this.entries.set(id, entry)
            seen.add(id)
          }
        }
      }
    }
    for (const id of this.entries.keys()) {
      if (!seen.has(id)) this.entries.delete(id)
    }
    return true
  }

  /**
   * Match a query against the latest committed index version.
   * @param query - Space-separated case-insensitive search terms.
   * @returns Matching stable record identities, or `null` without a query.
   */
  search(query: string): ReadonlySet<string> | null {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return null
    const matches = new Set<string>()
    for (const [id, entry] of this.entries) {
      if (terms.every(term => entry.text.includes(term))) matches.add(id)
    }
    return matches
  }
}
