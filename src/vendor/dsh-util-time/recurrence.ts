/**
 * 【vendor】@deepseek-ai/dsh-util-time，dsh-v0.2.2-rc.1，commit 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db。
 * 来源 packages/util/time/src/recurrence.ts。
 * 不要手改：结果类型、拒绝类型与决策校验的官方原文；仅去掉同目录相对 import 的 `.ts` 后缀，其余不改。
 */
/** Bounded calendar recurrence shared by consumers of Cron and RRULE. */
import { fourDigitYearEpoch, isFourDigitYearInstant } from './instant'

/** Latest admitted occurrence and the first future occurrence, if one exists. */
export interface RecurrenceOccurrence {
  /** Latest due UTC occurrence, never before the committed lower bound. */
  readonly occurrenceAt: string
  /** First strictly future UTC occurrence, omitted at exhaustion. */
  readonly nextScheduledAt?: string
}

/** Why recurrence content cannot be evaluated by the bounded engine. */
export type RecurrenceRejection = 'syntax' | 'time_zone' | 'density'

/** A parsed recurrence or its validation reason; no consumer-specific error codes. */
export type RecurrenceResult<T> =
  | { readonly kind: 'accepted'; readonly rule: T }
  | { readonly kind: 'rejected'; readonly reason: RecurrenceRejection; readonly detail: string; readonly cause?: unknown }

/** Internal validation failure, contained by the public parsers. */
export class RecurrenceInputError extends Error {
  constructor(readonly reason: RecurrenceRejection, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Contain recurrence validation failures while preserving unexpected implementation errors.
 * @param parse - Synchronous rule constructor whose input failures use RecurrenceInputError.
 * @returns The parsed value or its validation refusal.
 */
export function parseRecurrence<T>(parse: () => T): RecurrenceResult<T> {
  try {
    return { kind: 'accepted', rule: parse() }
  } catch (error: unknown) {
    if (!(error instanceof RecurrenceInputError)) throw error
    return { kind: 'rejected', reason: error.reason, detail: error.message,
      ...(error.cause === undefined ? {} : { cause: error.cause }) }
  }
}

/**
 * Validate the explicit decision and its committed lower bound before calendar arithmetic.
 * @param scheduledAt - Committed canonical four-digit-year UTC occurrence with milliseconds.
 * @param acceptedAt - Explicit epoch milliseconds of the delivery decision.
 * @returns The committed epoch, or throws RangeError for an invalid decision.
 */
export function recurrenceDecision(scheduledAt: string, acceptedAt: number): number {
  const savedTarget = fourDigitYearEpoch(scheduledAt)
  if (!isFourDigitYearInstant(acceptedAt) || savedTarget.kind === 'rejected' || acceptedAt < savedTarget.epoch) {
    throw new RangeError('Recurrence decision must be representable and at or after its committed target')
  }
  return savedTarget.epoch
}
