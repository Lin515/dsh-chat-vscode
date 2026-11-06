# src/vendor/dsh-util-time/ — 官方时间库原文（RRULE / 时刻 / 周期结果）

来源：`@deepseek-ai/dsh-util-time@0.2.2-rc.1`，固定 commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
来源锁、许可与同步流程见[上级索引](<../README.md>)；不得手改的约束见[AGENTS.md](<../AGENTS.md>)。

- [rrule.ts](<rrule.ts>) — 官方 `packages/util/time/src/rrule.ts` 全文：DTSTART/TZID、UNTIL、
  FREQ/COUNT/BY* 的校验，BYSETPOS 与密度上限，以及有界的发生时刻算术。
- [instant.ts](<instant.ts>) — 官方 `packages/util/time/src/instant.ts` 全文：严格 RFC 3339 /
  本地日历 / IANA 时区解析，`resolveLocalInstant` 的 DST 缺口与重叠取舍。
- [recurrence.ts](<recurrence.ts>) — 官方 `packages/util/time/src/recurrence.ts` 全文：解析结果
  类型、拒绝类型与决策时刻校验。

三份都是完整原文；允许的偏差只有：

- 相对 import 去掉 `.ts` 后缀；
- `rrule.ts` 的 `import rrulePackage from 'rrule'` 改为 `import * as rrulePackage from 'rrule'`。
  原因是 esbuild 对带 `__esModule` 的 CJS 产物（`rrule@2.8.1` 的 `dist/es5`）不补 `default`，
  而 webview 的 browser 构建又会取该包无 `default` 的 ESM 入口；命名空间导入在两端都能取到
  官方同名导出 `Weekday` / `rrulestr`，函数、常量与校验体不变。
- 文件头的来源声明。

运行期依赖是 `@js-temporal/polyfill@0.5.1` 与 `rrule@2.8.1`（与官方
`packages/util/time/package.json` 的精确版本一致）。

消费方是 [shared/scheduleRule.ts](<../../shared/scheduleRule.ts>)：它只把官方拒绝档映射成界面错误码，
并用官方 parser 校验一次性草稿，不另写日历或时区判断。既有
[util-time/cron-fields.ts](<../util-time/cron-fields.ts>) 仍是 cron 字段的窄摘录；本文三份不替代它。
