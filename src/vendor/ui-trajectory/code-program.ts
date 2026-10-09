/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-trajectory`（`0.2.0-rc.2`，检出 tag
 * `dsh-v0.2.0-rc.2`）的 `src/client/code-program.ts` 逐字副本：从录制下来的
 * `run_code` 工具参数与**调用时**的 schema 里读出可重放的 PTC 源码与语言提示。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 *
 * ## 本仓库的改动（只有 import 一行）
 *
 * | 上游 | 这里 |
 * |---|---|
 * | `import type { TrajectoryCellProps } from './trajectory-record.ts'` | 去掉 `.ts` 后缀（同上游其余文件的写法），类型本身来自 vendor 的 `trajectory-record.ts` |
 *
 * 函数体与常量**逐字相同**。
 */

/** Read replayable PTC source and language hints from recorded tool arguments and schemas. */
import type { TrajectoryCellProps } from './trajectory-record'

/** Recorded name of the programmatic tool-calling entry point. */
export const PTC_TOOL_NAME = 'run_code'

/** Validated source and original arguments for one recorded run_code call. */
export interface CodeProgram {
  rawInput: string
  source: string
  description: string
  arguments: Record<string, unknown>
  language: 'typescript' | 'python' | undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function recordedLanguage(schemaRaw: string | undefined): CodeProgram['language'] {
  const schema = parseRecord(schemaRaw)
  const properties = record(record(schema?.parameters)?.properties)
  const description = record(properties?.code)?.description
  if (typeof description !== 'string') return undefined
  const typescript = /\bTypeScript\b/i.test(description)
  const python = /\bPython\b/i.test(description)
  if (typescript === python) return undefined
  return typescript ? 'typescript' : 'python'
}

/**
 * Resolve a PTC program without guessing its language from source or current runtime settings.
 * @param cell - Recorded tool arguments and the schema visible at call time.
 * @returns The program, or undefined for another tool or unsupported arguments.
 */
export function codeProgram(cell: TrajectoryCellProps): CodeProgram | undefined {
  if (cell.kind !== 'tool' && cell.kind !== 'subtool') return undefined
  if (cell.toolName !== PTC_TOOL_NAME || cell.inputDetail === undefined) return undefined
  const args = parseRecord(cell.inputDetail)
  if (typeof args?.code !== 'string') return undefined
  if (args.description !== undefined && typeof args.description !== 'string') return undefined
  return {
    rawInput: cell.inputDetail,
    source: args.code,
    description: typeof args.description === 'string' && args.description.trim() !== ''
      ? args.description
      : args.code.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? '',
    arguments: args,
    language: recordedLanguage(cell.schemaDetail),
  }
}
