import { parseCronExpression } from "../vendor/util-time/cron-fields";
import { RecurrenceInputError } from "../vendor/util-time/recurrence-error";

/** 官方严格五字段方言的规范表达式；这里只适配失败形状，不另写语法或 STAR 归约。 */
export function canonicalCronExpression(expression: string): string | undefined {
  try {
    return parseCronExpression(expression).expression;
  } catch (error: unknown) {
    if (!(error instanceof RecurrenceInputError)) throw error;
    return undefined;
  }
}
