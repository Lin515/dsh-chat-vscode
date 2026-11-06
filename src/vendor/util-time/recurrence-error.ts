/**
 * 【vendor】@deepseek-ai/dsh-util-time，dsh-v0.2.2-rc.1，commit 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db。
 * 来源 packages/util/time/src/recurrence.ts。
 * 不要手改：仅摘录 RecurrenceRejection 类型与 RecurrenceInputError 类；定义逐字相同。
 */

/** Why recurrence content cannot be evaluated by the bounded engine. */
export type RecurrenceRejection = 'syntax' | 'time_zone' | 'density'

/** Internal validation failure, contained by the public parsers. */
export class RecurrenceInputError extends Error {
  constructor(readonly reason: RecurrenceRejection, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}
