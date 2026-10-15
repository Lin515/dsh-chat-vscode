# src/webview/ — 自绘界面

React / 浏览器环境，不使用 Node API。上层边界见[源码导航](<../README.md>)；子目录见[组件](<components/README.md>)、[样式](<styles/README.md>)。本页定位职责，不重复设计规格。

## 应用与文案

- [main.tsx](<main.tsx>) — 挂载 App 与引入样式。
- [App.tsx](<App.tsx>) — 布局、路由与宿主帧分发。
- [state.ts](<state.ts>) — ChatState reducer、patch 与派生状态。
- [bridge.ts](<bridge.ts>) — acquireVsCodeApi 单例、IPC 与状态持久化。
- [texts.ts](<texts.ts>) — 按宿主语言取词典与 Texts 上下文。
- [messages.ts](<messages.ts>) — @key / 中英文案唯一登记，原生通知标 vscode:true。
- [uiScale.ts](<uiScale.ts>) — 设计像素 / 字号倍率与上下文，见[尺度设计](<../../docs/design-ui-scale.md>)。
- [icons.tsx](<icons.tsx>) — SVG 图标，设计像素尺寸、继承色与描边。

## 轨迹

事实、交互与受控验收边界见[轨迹设计](<../../docs/design-trajectory.md>)。

- [trajectoryTexts.ts](<trajectoryTexts.ts>) — 官方轨迹文案。
- [trajectoryDisplay.ts](<trajectoryDisplay.ts>) — 行、组标题、工具结果与轮摘要的显示文字。
- [trajectoryTimeline.ts](<trajectoryTimeline.ts>) — 官方时间线投影到归一化域。
- [trajectoryVendor.ts](<trajectoryVendor.ts>) — vendor 形状与稳定记录身份适配。
- [trajectoryPromptDiff.ts](<trajectoryPromptDiff.ts>) — 系统提示词 / 工具目录行级差分。
- [trajectoryPre.ts](<trajectoryPre.ts>) — 原文换行偏好，只在用户切换时写存储。
- [trajectoryLedgerRows.ts](<trajectoryLedgerRows.ts>) — 查询优先折叠、摘要与工具隐藏的共享行投影。
- [trajectoryInteraction.ts](<trajectoryInteraction.ts>) — ledger / plot 的唯一交互端口、定位回执与资源清理。
- [trajectoryVirtual.ts](<trajectoryVirtual.ts>) — 原位 pin、垫行守恒与一次消费定位。

## 阅读与输入

- [autoScroll.ts](<autoScroll.ts>) — 聊天贴底 / 回底唯一端口。
- [readingPlacement.ts](<readingPlacement.ts>) — 查找 / 横条共用的落位、取历史与过期作废；贴底事实仍由 autoScroll 提供。
- [find.ts](<find.ts>) — 文本节点子串查找与激活下标环绕。
- [escapeOwner.ts](<escapeOwner.ts>) — ESC 唯一仲裁：元素 → 浮层（右键菜单 > 原图 > 抽屉 > 并列浮层）→ 会话页的停止生成（只有会话页占据前景时才存在，判据 `isConversationForeground`）；不按注册先后。
- [composerCompletion.tsx](<composerCompletion.tsx>) — @ / / 触发、完整块查询、已可引用抑制、候选与键盘导航，见[引用设计](<../../docs/design-mentions.md>)。
- [composerSend.ts](<composerSend.ts>) — 键盘 / 按钮同源手势与文案，界面不解析模式。
- [composerSessionDraft.ts](<composerSessionDraft.ts>) — 可见会话标题与确定性 token 的区间绑定、编辑失效与重匹配。
- [composerMention.ts](<composerMention.ts>) — 草稿引用镜像、Ctrl 命中与同排版几何。
- [mentionLinks.ts](<mentionLinks.ts>) — 已发正文的文件 / 目录 / 会话目标，sessionRefs 恢复会话身份。
- [mentionOpen.ts](<mentionOpen.ts>) — 已发链接与草稿 Ctrl 点击的 IPC 分派。
- [mentionNav.ts](<mentionNav.ts>) — 候选 .. 上层目录查询。
- [segment.ts](<segment.ts>) — 思考档位列数。
- [pickerFocus.ts](<pickerFocus.ts>) — 弹层选中项定位、方向键与滚入视野。
- [toolbarFit.ts](<toolbarFit.ts>) — 实测宽度分档、节点观察与有效布局盒，见[工具栏设计](<../../docs/design-composer.md>)。

## 状态与展示

- [cacheHit.ts](<cacheHit.ts>) — 会话累计缓存命中格式化；缺数据不返回读数。
- [pathDisplay.ts](<pathDisplay.ts>) — 单行路径拆分与保文件名省略。
- [sessionDir.ts](<sessionDir.ts>) — 标题栏 cwd 判据。
- [connectView.ts](<connectView.ts>) — 连接条状态、文案与按钮矩阵。
- [activity.ts](<activity.ts>) — 子代理 / 任务入口活性（后台任务在跑，或还有待执行的自动化任务）。
- [subagentRow.ts](<subagentRow.ts>) — 运行、已读与生命周期模式合成显示。
- [contextMenu.ts](<contextMenu.ts>) — 原生 / 自绘右键判据，见[右键设计](<../../docs/design-context-menu.md>)。
- [nodeOpen.ts](<nodeOpen.ts>) — 消息持有的节点展开态。
- [turnProcess.ts](<turnProcess.ts>) — 连续过程折叠。
- [todoPanel.ts](<todoPanel.ts>) — 会话单槽位开合与收起时保留项。
- [turnFiles.ts](<turnFiles.ts>) — 交付 / 本轮改动文件去重。
- [pendingInteraction.ts](<pendingInteraction.ts>) — plan-review > 提问 > 审批的输入接管。
- [pendingMessage.ts](<pendingMessage.ts>) — 乐观回显身份、去重与插入位置。
- [questionFlow.ts](<questionFlow.ts>) — questionBatch 分页问答。
- [planReview.ts](<planReview.ts>) — 计划审阅识别与收窄。
- [presetDisplay.ts](<presetDisplay.ts>) — 内置双语 / 自写原文与配置名称匹配。

## 内容、附件、任务与队列

- [markdown.ts](<markdown.ts>) — marked 与 DOMPurify；代码块由组件渲染。
- [footnotes.ts](<footnotes.ts>) — 脚注扩展。
- [linkDestinations.ts](<linkDestinations.ts>) — tokenizer 保护 Windows 反斜杠目标。
- [fileLinks.ts](<fileLinks.ts>) — Markdown 路径锚点与本轮文件 token。
- [fileMentions.ts](<fileMentions.ts>) — 文件 token 到按钮的 DOM 变换。
- [localImages.ts](<localImages.ts>) — 正文图片交宿主读取，缓存按会话隔离。
- [imageClipboard.ts](<imageClipboard.ts>) — canvas 转 PNG 写剪贴板。
- [attachIntake.ts](<attachIntake.ts>) — drop / paste 字节通道，真路径归宿主。
- [attachmentOpen.ts](<attachmentOpen.ts>) — 单击打开附件的 IPC 分派与可点判据。
- [pastedImageNames.ts](<pastedImageNames.ts>) — 粘贴图片的会话内编号名（图N / imageN）。
- [jobObserve.ts](<jobObserve.ts>) — 观察身份与重连锚点的输出累积。
- [jobsKill.ts](<jobsKill.ts>) — armed → pending 停止状态机。
- [jobsOrder.ts](<jobsOrder.ts>) — live / 开始时间顺序，排除 subagent 行。
- [queueOrder.ts](<queueOrder.ts>) — 插话在前，仅改显示顺序。
- [queueHover.ts](<queueHover.ts>) — 实测截断与全文浮层几何。
- [turnRail.ts](<turnRail.ts>) — turnOutline 与已加载窗口的刻点 / 预览。
- [turnRailNav.ts](<turnRailNav.ts>) — 横条策略；时序 / 几何交 readingPlacement。
