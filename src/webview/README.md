# src/webview/ — 自绘界面（React，浏览器环境）

运行环境：webview（浏览器环境，React，不能碰 Node）。
上一层的说明见 [../README.md](../README.md)。

子目录（各有自己的 README，此处不展开）：

- `components/` — React 组件 → [components/README.md](components/README.md)
- `styles/` — 样式 → [styles/README.md](styles/README.md)

## 应用骨架

- `main.tsx` — webview 入口：挂载 `App`，引入两份样式。
- `App.tsx` — 应用装配：布局、路由状态、宿主帧分发到各子系统。
- `state.ts` — 界面状态归约（`useReducer`）：`ChatState` 的接收、patch 合并与派生数据。
- `bridge.ts` — IPC 客户端：`acquireVsCodeApi()` 单例包装、`post` / `subscribe` / 状态持久化。
- `texts.ts` — 界面文案的取词典侧：按宿主下发的语言选词典，`Texts` 上下文；文案本体在 `messages.ts`。
- `messages.ts` — 宿主 → 界面文案的唯一登记表（`@key` 标记 → 中英两份词典由此派生；可外溢 VS Code 通知的条目标 `vscode: true`）。
- `trajectoryTexts.ts` — 轨迹视图的专用文案（逐字取自官方 locales，只在 webview 内部消费）。
- `trajectoryDisplay.ts` — 轨迹账本「一行显示什么」的唯一出处（官方 `recordDisplayText` / `recordResultText` / `isToolCallOnly` / `group.*` 组标题 / `summarizeTurn` 折叠摘要的等价实现；宿主只给语义标记，文案在这一层取）。
- `trajectoryTimeline.ts` — 轨迹时间线的视图模型：调 vendor 的官方投影，把绝对域归一化成 0..1（界面绘制与命中都在归一化域里）。
- `trajectoryVendor.ts` — 账本 → vendor 官方形状的适配层（`vendorCell` / `vendorTurns`）与稳定身份 `trajectoryCellRecordId`。
- `trajectoryPromptDiff.ts` — 系统提示词 / 工具目录的行级差分（官方 `promptDiffLines()` 的同一套：`diff` 包的 `structuredPatch`、context 3、hunk 头 + 逐行标记）。
- [trajectoryPre.ts](<trajectoryPre.ts>) — 轨迹原文段落的换行偏好：渲染时读取默认值，只有用户切换时才持久化。
- [trajectoryLedgerRows.ts](<trajectoryLedgerRows.ts>) — 账本行投影的共享 seam：查询优先于折叠、每段起点、工具隐藏与原助手后的非 primary 摘要；真实组件与正式回归同调此规则，不复制镜像实现。
- [trajectoryInteraction.ts](<trajectoryInteraction.ts>) — 一条交互链的唯一端口：同时拥有 ledger／plot 容器 ref、记录／请求／range 选择、一次消费定位、成功 focus 回执、视口与手势资源；切会话清理公开状态和闭包监听，已排队旧回调也失效。
- [trajectoryVirtual.ts](<trajectoryVirtual.ts>) — 账本分段窗口计划：按原位次插入 pin，垫行与呈现行数量守恒；定位 nonce 只消费一次，不能让旧 reveal 拉回手工滚动。
- [uiScale.ts](<uiScale.ts>) — 基准字号、设计像素与界面倍率的共享换算及 React 上下文。
- [icons.tsx](<icons.tsx>) — 内联 SVG 图标集；尺寸按设计像素换算，描边与颜色跟随界面。

## 布局与交互子系统

- `autoScroll.ts` — 聊天区自动滚动（贴底 / 回底胶囊）：一个模块一个端口（`AutoScrollPort` 范例）。
- `find.ts` — 会话查找（Ctrl+F）的纯逻辑：文本节点序列上的子串定位与激活下标环绕推进；DOM 胶水在 `components/FindBar.tsx`。
- `composerCompletion.tsx` — 输入框 `@` / `/` 补全的唯一归属地：触发判定、候选取用与优先级、键盘导航、弹层 JSX。
- `mentionNav.ts` — `@` 候选里的 `..` 上一层目录导航（只算目标查询串）。
- `segment.ts` — 思考档位分段控件的列数（≤4 档一行、5/6 档均分两行）。
- `toolbarFit.ts` — 底部工具栏按优先级 + 实测宽度决定本帧显示哪些元素（量出来而不是猜阈值）。
- `pathDisplay.ts` — 单行标题里路径的拆分与省略（保住文件名，目录部分从左裁）。
- `connectView.ts` — 连接条的纯函数：三类状态 + 文案 + 按钮集合（按钮矩阵的判定只有这一处）。
- `activity.ts` — 顶栏子代理 / 后台任务入口的活性判据（运行中才亮）。
- `contextMenu.ts` — 会话里自绘右键菜单的判据（复制 / 引用 / 图片操作，原生菜单全局接管）。
- `nodeOpen.ts` — 折叠节点的展开态：由消息持有而非各行自持（过程折叠卸载成员后状态不丢）。
- `turnProcess.ts` — 连续过程折叠：一轮只留最后一段正文，其余折成按钮。
- `turnFiles.ts` — 轮尾两行文件的去重（交付行说了的，本轮改动行不再重复）。
- `pendingInteraction.ts` — 「有交互在等你回答」的选举结果（优先级沿官方：plan-review > 提问 > 审批），接管输入区。
- `pendingMessage.ts` — 乐观回显的行身份、去重与插入位置（纯函数）。
- `questionFlow.ts` — 问卷展示口径：题目少一次展开、题目多按 `dshChat.questionBatch` 分页问答。
- `planReview.ts` — 计划审阅（`exit_plan_mode`）请求的识别与收窄规则（官方 `planReviewOf` 移植）。
- `presetDisplay.ts` — agent 预设的名字与描述显示（内置四个由客户端按语言给文案）；另给配置项按名字匹配用的候选名（中英两名，宿主也引用这一份）。
- `markdown.ts` — Markdown → 安全 HTML：DOMPurify 过滤 + marked 配置，代码块交给 React 组件。
- `footnotes.ts` — 脚注语法的 marked 扩展（marked 不自带，结构逐字对齐官方渲染器产出）。
- `fileLinks.ts` — 正文文件链接：markdown 链接目标（带 `#L12` 锚点）+ 行内代码 token（仅命中本轮文件词表）。
- `fileMentions.ts` — 行内代码文件链接的 DOM 变换（换成内层按钮，官方同构）。
- `localImages.ts` — 本地图片引用的界面侧解析：交给宿主读 data URL 后换 `src`，缓存按会话隔离。
- `imageClipboard.ts` — 界面图片写进系统剪贴板（先过 canvas 转 PNG，Chromium 只认 `image/png`）。
- `attachIntake.ts` — 附件接取（拖放 + 粘贴）的字节通道：读成字节发 `attachBytes`，路径归宿主。
- `jobObserve.ts` — 后台任务实时输出的累积口径（观察代号对号入座，重连续传锚点帧）。
- `jobsKill.ts` — 后台任务停止按钮的两段式状态机（armed → pending，对齐官方 `pressKill`）。
- `jobsOrder.ts` — 后台任务名册的显示顺序（live 在前按开始时间升序；subagent 行不进该面板）。
- `queueOrder.ts` — 待发送队列显示顺序（插话排在排队上方；只改显示不动数据顺序）。
- `turnRail.ts` — 右侧轮次横条的数据层：`turnOutline` 投影铺底 + 已加载窗口折锚点与预览。
- `turnRailNav.ts` — 轮次横条的导航行为（点击跳轮、未加载先取历史再落位、滚动同步高亮）。
