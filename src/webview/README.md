# src/webview/ — 自绘界面

React / 浏览器环境，不使用 Node API。上层边界见[源码导航](<../README.md>)；子目录见[组件](<components/README.md>)、[样式](<styles/README.md>)、[资源](<assets/README.md>)。本页定位职责，不重复设计规格。

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
- [escapeOwner.ts](<escapeOwner.ts>) — ESC 唯一仲裁：输入法组字中的按键先放行，再按元素 → 浮层（右键菜单 > 原图 > 抽屉 > 并列浮层）→ 会话页停止生成（仅 `isConversationForeground` 为真时存在）；并列浮层后注册者优先。
- [composerCompletion.tsx](<composerCompletion.tsx>) — @ / / 触发、完整块查询、已可引用抑制、完整命令 / 技能块不主动弹（半截前缀与显式请求例外）、候选与键盘导航、命令链接请求 effect 的区间复核与筛选菜单打开（候选行的悬停标题是解析出来的完整绝对路径）；刷新期间上一份候选原地留屏、整个刷新只换一次内容，留屏期间键位与点击一并冻结；「上一层」行有宿主下发与界面合成两个来源，宿主已有条目保持原序且不重复合成，Enter / Tab 同为回上一层（`hasDrillableFolder` 仍不把它算作可下钻目录），见[引用设计](<../../docs/design-mentions.md>)。
- [composerSend.ts](<composerSend.ts>) — 键盘 / 按钮同源手势与文案，界面不解析模式。
- [composerSessionDraft.ts](<composerSessionDraft.ts>) — 可见会话标题与确定性 token 的区间绑定、编辑失效与重匹配；引用与斜杠命令的镜像分段和 Ctrl/Cmd 点击目标，绑定会话区间优先。
- [composerMention.ts](<composerMention.ts>) — 草稿引用与斜杠命令的镜像分段、Ctrl/Cmd 命中与同排版几何，引用区间不被命令覆盖。
- [mentionLinks.ts](<mentionLinks.ts>) — 已发正文的文件 / 目录 / 会话目标，sessionRefs 恢复会话身份。
- [mentionOpen.ts](<mentionOpen.ts>) — 已发链接与草稿 Ctrl/Cmd 点击的分派：文件 / 会话走 IPC，命令通过菜单端口定位输入框。
- [commandLinks.tsx](<commandLinks.tsx>) — 斜杠目录识别、扫描与补全共用的词法边界、官方内置命令双语描述与筛选菜单端口；技能只打开服务端提供的指令文件，无路径时仅高亮。
- [mentionNav.ts](<mentionNav.ts>) — 候选「上一层」的查询串：工作区内逐层回退、绝对形态（盘符 / UNC / POSIX 根）回退与盘根回工作区的回路，以及含 `..` 段相对查询按会话 cwd 深度的段算术（退到根就停）。
- [pathDisplay.ts](<pathDisplay.ts>) — 路径的展示口径：单行标题的拆分省略，以及把候选 / 「上一层」行的展示路径解析成完整绝对路径（悬停标题，绝对与相对两侧都按根锚定语义消掉 `..`）。
- [segment.ts](<segment.ts>) — 思考档位列数。
- [pickerFocus.ts](<pickerFocus.ts>) — 模型弹层选中项定位（打开即滚到当前模型）、方向键与滚入视野；定位范围只有可滚的模型列表，常驻的思考档位区不参与键盘导航。
- [toolbarFit.ts](<toolbarFit.ts>) — 实测宽度分档、节点观察与有效布局盒，见[工具栏设计](<../../docs/design-composer.md>)。

## 状态与展示

- [cacheHit.ts](<cacheHit.ts>) — 会话累计缓存命中格式化；缺数据不返回读数。
- [pathDisplay.ts](<pathDisplay.ts>) — 单行路径拆分与保文件名省略。
- [sessionDir.ts](<sessionDir.ts>) — 标题栏执行目录取值与工作区差异显示判据。
- [sessionSelection.ts](<sessionSelection.ts>) — 历史列表多选：可选判据、选择集跟随列表、全选翻转。
- [connectView.ts](<connectView.ts>) — 连接条状态、文案与按钮矩阵。
- [notifications.ts](<notifications.ts>) — 消息通知的展示口径（顶部取哪条、抽屉列表与时间格式化、级别到 `.notice` 修饰类），宿主权威队列见 `dsh/notificationQueue.ts`。
- [imageCopyFailure.ts](<imageCopyFailure.ts>) — 界面本地复制图片失败的归属上报端口（捕获发起会话、过期丢弃、失败报告序号），宿主入队见[消息通知设计](<../../docs/design-notifications.md>)。
- [activity.ts](<activity.ts>) — 子代理 / 任务入口活性（后台任务在跑，或还有待执行的自动化任务）。
- [subagentRow.ts](<subagentRow.ts>) — 运行、已读与生命周期模式合成显示。
- [subagentTree.ts](<subagentTree.ts>) — 标题清单的界面读法：当前会话的多层后代计数与当前节点定位。
- [contextMenu.ts](<contextMenu.ts>) — 原生 / 自绘右键判据与会话选区 Ctrl+C / Cmd+C 的宿主复制桥；编辑区快捷键让路，见[右键设计](<../../docs/design-context-menu.md>)。
- [nodeOpen.ts](<nodeOpen.ts>) — 消息持有的节点展开态。
- [turnProcess.ts](<turnProcess.ts>) — 连续过程折叠。
- [todoPanel.ts](<todoPanel.ts>) — 会话单槽位开合与收起时保留项。
- [turnFiles.ts](<turnFiles.ts>) — 交付 / 本轮改动文件去重。
- [pendingInteraction.ts](<pendingInteraction.ts>) — plan-review > 提问 > 审批的输入接管。
- [pendingMessage.ts](<pendingMessage.ts>) — 乐观回显身份、去重与插入位置。
- [questionFlow.ts](<questionFlow.ts>) — questionBatch 分页问答。
- [questionDraft.ts](<questionDraft.ts>) — 问卷半填草稿的内存表：按会话 + 问卷 id 归档、上限淘汰、收场即清；只用于切会话恢复，不落盘。
- [planReview.ts](<planReview.ts>) — 计划审阅识别与收窄。
- [presetDisplay.ts](<presetDisplay.ts>) — 内置双语 / 自写原文与配置名称匹配。

## 内容、附件、任务与队列

- [markdown.ts](<markdown.ts>) — marked 与 DOMPurify；代码块由组件渲染。
- [footnotes.ts](<footnotes.ts>) — 脚注扩展。
- [cjkStrong.ts](<cjkStrong.ts>) — tokenizer 放宽中文标点收尾的加粗闭合（官方 cjkFriendlyStrong 口径）。
- [linkDestinations.ts](<linkDestinations.ts>) — tokenizer 保护 Windows 反斜杠目标。
- [fileLinks.ts](<fileLinks.ts>) — Markdown 路径锚点与本轮文件 token；另给「修饰键 + HTML 文件才换走浏览器」的唯一判据。
- [linkHovers.ts](<linkHovers.ts>) — 正文链接的悬停标题（完整路径 / 完整地址、HTML 修饰键提示）与锚点 title 的渲染后注入。
- [fileMentions.ts](<fileMentions.ts>) — 文件 token 到按钮的 DOM 变换；按钮带上完整路径悬停，点击把事件交给调用方分流浏览器。
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
