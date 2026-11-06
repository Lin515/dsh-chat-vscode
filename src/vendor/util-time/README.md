# src/vendor/util-time/ — 官方 Cron 字段纯解析摘录

来源：`@deepseek-ai/dsh-util-time@0.2.2-rc.1`，commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
来源锁 / 许可 / 同步流程见[上级索引](<../README.md>)；不得手改的约束见[AGENTS.md](<../AGENTS.md>)。

- [cron-fields.ts](<cron-fields.ts>) — 从官方 `cron.ts` 摘录 `parseCronExpression` 及完整字段解析 / 规范化闭包；函数体、常量与类型逐字相同，仅导出解析入口、调整错误类型 import。保留 Vixie 的 DOM_STAR / DOW_STAR，不能以值集合相等替代语义相等。
- [recurrence-error.ts](<recurrence-error.ts>) — 从官方 `recurrence.ts` 摘录拒绝类型与错误类，定义逐字相同。

[shared/cron.ts](<../../shared/cron.ts>) 只把官方语法拒绝转为 `undefined`，供任务草稿比较与提交使用。不搬发生时刻 / 时区算术，不新增 Temporal 依赖，不冒充完整 `Cron.parse` 的时区校验。两份完整官方原文均登记离线来源见证；回归见[scheduleEditor.test.ts](<../../../scripts/scheduleEditor.test.ts>)。
