# src/vendor/ui-tool/ — 工具状态的官方纯函数

来源：`@deepseek-ai/dsh-client-ui-tool@0.2.2-rc.1`，固定 commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
许可、来源锁与升级流程见[上级索引](<../README.md>)；改写约束见[AGENTS.md](<../AGENTS.md>)。

- [terminal-status.ts](<terminal-status.ts>) — 摘录官方 `src/client/tool/models/terminal-card-model.ts` 的 `parseExitStatus` / `terminalFailed`，函数体逐字相同；仅导出解析函数、把模型依赖替换为最小结构类型壳。信号优先，识别负退出码与显式 `null`，运行中不判失败。

[shared/toolMeta.ts](<../../shared/toolMeta.ts>) 只做形状适配 / 转导出，聊天行和终端卡片共享同一份退出状态事实。正式回归见[toolMeta.test.ts](<../../../scripts/toolMeta.test.ts>)；原始完整模型文件也登记为离线来源见证，不依赖本机官方 checkout。
