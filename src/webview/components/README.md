# src/webview/components/ — React 组件

运行环境：webview（浏览器环境，React）。上一层的说明见 [../README.md](../README.md)。

- `Composer.tsx` — 底部输入框：目标条、附件、发送 / 排队，弹层规则在 `../composerCompletion.tsx`。
- `Message.tsx` — 单条消息：按 `MessageView` 种类装配正文、图片、工具行、折叠过程、轮尾文件。
- `Markdown.tsx` — markdown 正文渲染：块切分 + 本地图片 / 文件链接的注水（hydrate）。
- `CodeBlock.tsx` — 代码块卡片（复制 / 插入按钮；markdown 与工具卡共用，避免工具行被 DOMPurify 牵连）。
- `ToolCards.tsx` — 按工具语义画的卡片（读 / 搜索 / 终端 / 网页），有卡片时不再展示参数 JSON。
- `Rows.tsx` — 通用行组件：审批卡、命令行、文件芯片、注入行、提问卡、思考行、工具行、轮统计等。
- `Diff.tsx` — diff 渲染：单栏 / 双栏两种排版。
- `Images.tsx` — 会话图片的统一呈现（用户 / 模型 / 工具 / 正文引用三处合成一套）+ 图片预览层。
- `ChangesCard.tsx` — 轮尾改动文件卡片（数据来自宿主认证路由 `/api/changes.summary`）。
- [Trajectory.tsx](<Trajectory.tsx>) — 轨迹装配与账本／两个互斥检查器；折叠与搜索规则委托[行投影模块](<../trajectoryLedgerRows.ts>)，所有选择、focus、range、定位与视口通过[同一交互端口](<../trajectoryInteraction.ts>)。请求概述分别计工具／子工具，结果链接定位到助手消息或压缩记录。
- [TrajectoryTimeline.tsx](<TrajectoryTimeline.tsx>) — 时间线呈现层：只接收一个完整交互端口（含 plot ref），负责 ResizeObserver 与归一化跨度绘制，不另持有一套选择／手势状态。
- `TrajectoryPre.tsx` — 轨迹检查器里「一段原文」的统一呈现件（正文 + 复制 / 自动换行那对按钮）；`Trajectory.tsx` 里十几处都用它，新加一处原文就自动带上这两个动作。
- `SourceBlocks.tsx` — 轨迹检查器「原始内容」页签的逐块排版（对齐官方 `SourceBlocks()`）：每块一节（块标题 + 该块原文），块上有 `callId` 时标题变跳转按钮。
- `PromptDiff.tsx` — 轨迹检查器「差异」页签里的一节行级差分（对齐官方 `PromptDiffSection()`）：标题 + 逐行着色；行序列由 `../trajectoryPromptDiff.ts` 算。
- `TurnRail.tsx` — 右侧轮次横条组件：固定间距刻点、悬停预览卡、点击跳轮。
- `Panels.tsx` — 顶栏面板：后台任务详情（实时输出、停止按钮）、子代理等抽屉。
- `History.tsx` — 会话历史抽屉：搜索、删除（二次点击确认）、归档。
- `FindBar.tsx` — 会话查找条（Ctrl+F）：CSS Custom Highlight API 高亮 + 计数 + 上一处/下一处；纯逻辑在 `../find.ts`。
- `EmptyMeta.tsx` — 空态页元信息：会话工作目录与 agent 预设。
- `ContextMenu.tsx` — 自绘右键菜单浮层（根部挂一次，只管画）。
- `CopyButton.tsx` — 复制按钮（工具卡与后台任务详情共用，1s 文案反馈）。
- `primitives.tsx` — 小组件与格式化工具（Popover、`formatClock`、路径拆分展示等）。
