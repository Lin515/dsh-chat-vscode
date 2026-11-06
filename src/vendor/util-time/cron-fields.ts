/**
 * 【vendor】@deepseek-ai/dsh-util-time，dsh-v0.2.2-rc.1，commit 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db。
 * 来源 packages/util/time/src/cron.ts。
 * 不要手改：纯字段解析摘录，不搬 Temporal 时区/发生时刻算术；函数体和常量逐字相同；仅导出 parseCronExpression 并把 RecurrenceInputError 的导入指向同目录原文摘录。
 */
import { RecurrenceInputError } from './recurrence-error'

/** Field bounds of the supported five-field cron dialect, in evaluation order. */
interface CronFieldSpec {
  /** Field name used in diagnostics. */
  readonly name: string
  /** Lowest value accepted in the input dialect. */
  readonly min: number
  /** Highest value accepted in the input dialect; Sunday accepts both 0 and 7. */
  readonly max: number
  /** Highest value retained after folding Sunday 7 onto 0. */
  readonly canonicalMax: number
}

const CRON_FIELDS: readonly [CronFieldSpec, CronFieldSpec, CronFieldSpec, CronFieldSpec, CronFieldSpec] = [
  { name: 'minute', min: 0, max: 59, canonicalMax: 59 },
  { name: 'hour', min: 0, max: 23, canonicalMax: 23 },
  { name: 'day-of-month', min: 1, max: 31, canonicalMax: 31 },
  { name: 'month', min: 1, max: 12, canonicalMax: 12 },
  { name: 'day-of-week', min: 0, max: 7, canonicalMax: 6 },
]

/** One parsed cron field: its matched values, canonical spelling, and Vixie star flag. */
interface ParsedCronField {
  /** Unique ascending matched values after Sunday folding. */
  readonly values: readonly number[]
  /** Canonical spelling of exactly those values. */
  readonly canonical: string
  /** Whether the field text starts with `*`, which is Vixie's DOM_STAR/DOW_STAR test. */
  readonly star: boolean
}

/** Build the stable diagnostic for one malformed cron field element. */
function invalidCronField(spec: CronFieldSpec, element: string): RecurrenceInputError {
  return new RecurrenceInputError(
    'syntax',
    `cron.expression ${spec.name} field element ${JSON.stringify(element)} must be *, a value, a-b, */n, a-b/n, `
    + 'or a comma-separated list of those.',
  )
}

/** Read one in-range cron field value. */
function cronFieldValue(text: string, spec: CronFieldSpec): number {
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new RecurrenceInputError(
      'syntax',
      `cron.expression ${spec.name} field value ${text} is outside ${spec.min}-${spec.max}.`,
    )
  }
  return value
}

/** Read one positive cron field step. */
function cronFieldStep(text: string, spec: CronFieldSpec): number {
  const step = Number(text)
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new RecurrenceInputError('syntax', `cron.expression ${spec.name} field step must be a positive integer.`)
  }
  return step
}

/** Expand one comma-separated cron field into its matched value set. */
function cronFieldValues(raw: string, spec: CronFieldSpec): number[] {
  const matched = new Set<number>()
  for (const element of raw.split(',')) {
    if (element.length === 0) {
      throw new RecurrenceInputError(
        'syntax', `cron.expression ${spec.name} field must not contain an empty list element.`,
      )
    }
    if (element === '*') {
      for (let value = spec.min; value <= spec.max; value += 1) matched.add(value)
      continue
    }
    if (element.startsWith('*')) {
      const stepped = /^\*\/(?<step>\d+)$/.exec(element)
      const groups = stepped?.groups
      if (groups === undefined) throw invalidCronField(spec, element)
      const stepText = groups['step']
      /* v8 ignore next -- a successful fixed regex always provides the step group. */
      if (stepText === undefined) throw invalidCronField(spec, element)
      const step = cronFieldStep(stepText, spec)
      for (let value = spec.min; value <= spec.max; value += step) matched.add(value)
      continue
    }
    const parsed = /^(?<start>\d+)(?:-(?<end>\d+))?(?:\/(?<step>\d+))?$/.exec(element)
    const groups = parsed?.groups
    if (groups === undefined) throw invalidCronField(spec, element)
    const startText = groups['start']
    /* v8 ignore next -- a successful fixed regex always provides the start group. */
    if (startText === undefined) throw invalidCronField(spec, element)
    const start = cronFieldValue(startText, spec)
    const end = groups['end']
    const stepText = groups['step']
    if (end === undefined) {
      if (stepText !== undefined) throw invalidCronField(spec, element)
      matched.add(start)
      continue
    }
    const last = cronFieldValue(end, spec)
    if (start > last) {
      throw new RecurrenceInputError(
        'syntax', `cron.expression ${spec.name} field range ${start}-${last} is inverted.`,
      )
    }
    const step = stepText === undefined ? 1 : cronFieldStep(stepText, spec)
    for (let value = start; value <= last; value += step) matched.add(value)
  }
  const values = new Set<number>()
  for (const value of matched) {
    values.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  }
  return [...values].sort((left, right) => left - right)
}

/**
 * Read one value the encoder already proved present.
 * @param values - matched value set the parser always fills.
 * @param index - index the caller derived from that set.
 * @returns the value at that index.
 */
function cronFieldValueAt(values: readonly number[], index: number): number {
  const value = values[index]
  /* v8 ignore next -- a parsed cron field always matches at least one value. */
  if (value === undefined) throw new Error('cron field encoding requires a non-empty value set')
  return value
}

/** Encode one matched value set as the shortest equivalent comma-separated cron field.
 * @param values - Matched values in ascending order.
 * @returns Field text that re-parses to exactly `values`, never spelled with a leading `*`.
 */
function encodeCronField(values: readonly number[]): string {
  const first = cronFieldValueAt(values, 0)
  if (values.length === 1) return String(first)
  const last = cronFieldValueAt(values, values.length - 1)
  const step = cronFieldValueAt(values, 1) - first
  let uniform = true
  for (let index = 2; index < values.length; index += 1) {
    if (cronFieldValueAt(values, index) - cronFieldValueAt(values, index - 1) !== step) {
      uniform = false
      break
    }
  }
  if (uniform) {
    if (step === 1) return `${first}-${last}`
    return `${first}-${last}/${step}`
  }
  const parts: string[] = []
  let runStart = first
  for (let index = 1; index < values.length; index += 1) {
    const current = cronFieldValueAt(values, index)
    const previous = cronFieldValueAt(values, index - 1)
    if (current === previous + 1) continue
    parts.push(runStart === previous ? String(runStart) : `${runStart}-${previous}`)
    runStart = current
  }
  const final = cronFieldValueAt(values, values.length - 1)
  parts.push(runStart === final ? String(runStart) : `${runStart}-${final}`)
  return parts.join(',')
}

/**
 * One uniform walk from a field's minimum, folded exactly as a parsed field folds.
 * @param spec - Field range and canonical maximum.
 * @param step - Positive step of the walk.
 * @returns Ascending values `step` produces from the minimum.
 */
function starWalk(spec: CronFieldSpec, step: number): number[] {
  const walked = new Set<number>()
  for (let value = spec.min; value <= spec.max; value += step) {
    walked.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  }
  return [...walked].sort((left, right) => left - right)
}

/**
 * Canonical spelling of a field whose text started with `*`.
 *
 * Only a `*`-prefixed spelling keeps the star flag, and only the bare star or a star-step
 * (a `*` followed by `/n`) admits a leading `*`, so the encoding is the bare star for every
 * value, otherwise the widest star-step walk plus any remaining values as a list.
 * Re-parsing therefore reproduces both the star flag and the matched set, which is what
 * keeps day-of-month/day-of-week AND/OR selection stable across a stored canonical
 * expression.
 * @param values - Matched values in ascending order.
 * @param spec - Field range and canonical maximum.
 * @returns Canonical field text that starts with `*`.
 */
function encodeStarCronField(values: readonly number[], spec: CronFieldSpec): string {
  if (values.length === spec.canonicalMax - spec.min + 1) return '*'
  const present = new Set(values)
  let bestStep: number | undefined
  let bestWalk: number[] = []
  for (let step = 1; step <= spec.max - spec.min + 1; step += 1) {
    const walk = starWalk(spec, step)
    if (walk.length > bestWalk.length && walk.every(value => present.has(value))) {
      bestStep = step
      bestWalk = walk
    }
  }
  /* v8 ignore next -- the widest step yields the single minimum, which every `*`-led field matches. */
  if (bestStep === undefined) throw new RecurrenceInputError('syntax', `${spec.name} cannot keep a leading \`*\`.`)
  const walked = new Set(bestWalk)
  const remaining = values.filter(value => !walked.has(value))
  const walkText = `*/${bestStep}`
  return remaining.length === 0
    ? walkText
    : `${walkText},${encodeCronField(remaining)}`
}

/**
 * Parse one cron field into its matched values, canonical spelling, and star flag.
 *
 * The star flag tests the field text's first character, which is how Vixie sets
 * `DOM_STAR`/`DOW_STAR`: a stepped star (`*` followed by `/2`) is a star although
 * it matches half the range, while an explicit full range such as `1-31` is
 * restricted. Canonicalization preserves the flag: a `*`-led field keeps a `*`-led
 * spelling, and a field that did not start with `*` is never spelled as a star-step.
 */
function parseCronField(raw: string, spec: CronFieldSpec): ParsedCronField {
  const values = cronFieldValues(raw, spec)
  const star = raw.startsWith('*')
  return Object.freeze({
    values: Object.freeze(values),
    canonical: star ? encodeStarCronField(values, spec) : encodeCronField(values),
    star,
  })
}

/** Parsed five-field cron rule: canonical text plus every field's matched values. */
export interface CronFields {
  /** Canonical expression stored in the durable record. */
  readonly expression: string
  /** Unique ascending matched minutes. */
  readonly minutes: readonly number[]
  /** Unique ascending matched hours. */
  readonly hours: readonly number[]
  /** Unique ascending matched days of the month. */
  readonly daysOfMonth: readonly number[]
  /** Unique ascending matched months. */
  readonly months: readonly number[]
  /** Unique ascending matched cron weekdays, Sunday 0 through Saturday 6. */
  readonly daysOfWeek: readonly number[]
  /** Whether the day-of-month field text starts with `*` (Vixie `DOM_STAR`). */
  readonly dayOfMonthStar: boolean
  /** Whether the day-of-week field text starts with `*` (Vixie `DOW_STAR`). */
  readonly dayOfWeekStar: boolean
}

/** Parse and canonicalize one strict five-field cron expression. */
export function parseCronExpression(expression: string): CronFields {
  if (typeof expression !== 'string' || expression.length === 0 || expression.trim() !== expression) {
    throw new RecurrenceInputError('syntax', 'cron.expression must be a non-empty trimmed string.')
  }
  const fields = expression.split(/\s+/)
  if (fields.length !== 5) {
    throw new RecurrenceInputError(
      'syntax',
      'cron.expression must contain exactly five whitespace-separated fields: '
      + 'minute hour day-of-month month day-of-week.',
    )
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(
    (field, index) => {
      const fieldSpec = CRON_FIELDS[index]
      /* v8 ignore next -- the five-field split bounds this index. */
      if (fieldSpec === undefined) throw new Error('cron field specification is missing')
      return parseCronField(field, fieldSpec)
    },
  ) as [ParsedCronField, ParsedCronField, ParsedCronField, ParsedCronField, ParsedCronField]
  return Object.freeze({
    expression: [minute, hour, dayOfMonth, month, dayOfWeek].map(field => field.canonical).join(' '),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthStar: dayOfMonth.star,
    dayOfWeekStar: dayOfWeek.star,
  })
}
