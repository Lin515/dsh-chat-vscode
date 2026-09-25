# scripts/ — 断言、探针与工具脚本

本目录没有子目录，全部是顶层文件，按用途分三类（每个文件头部都写明自己的定位与运行方式）：

- **离线断言**（`*.test.ts`）——与被测源文件同名对应，不联网、不起进程（个别起本地 stub），`npm test` 跑的就是它们。**必须登记进 `esbuild.scripts.mjs` 的 `entries` 才会真正被执行**——新建断言后忘了登记，测试就静默落空。
- **端到端探针**（多为 `*Probe.ts`，另有若干防线型脚本）——对真实 `dsh web` 或真实会话日志取证的勘察/防线脚本。文件头的「【探针定位】」块标注类型（勘察型 / 防线型 / 工具型）与是否耗模型 token：**耗 token 的按 AGENTS.md 硬约束不得随构建自动执行，每次运行前须获用户批准（一次批准一次有效）**；零 token 的可自由运行。
- **工具脚本**（`*.mjs`）——打包、安装、发布、测试与类型检查的流水线脚本。

依赖说明：断言与探针共用 `src/` 的纯模块；`vscode` 模块在离线环境由 `vscodeTestStub.ts` 经 esbuild alias 顶替；探针的一次性隔离环境由 `supervisorProbeEnv.ts` 提供。

---

## 离线断言（`*.test.ts`）

### 会话主链路与协议适配

- `wire.test.ts` — 过线语义：宿主 → webview 的帧被 JSON 序列化会丢 `undefined` 键，清空字段必须发 `null`。
- `sessionView.test.ts` — 「一个会话在界面上的状态」只有唯一生产者，字段集合不得在生产者之间漂移。
- `sessionStatus.test.ts` — `api-session/status` 状态位中继的解码与采纳策略（服务端权威的「这轮在不在跑」）。
- `sessionList.test.ts` — 会话列表行可见性与分支呈现（用 `origin` 而非 `parentSessionId` 区分子代理）。
- `parseToolResult.test.ts` — `dsh/adapter.ts` 的 `parseToolResult`（read 信封等工具结果解析）。
- `commandNode.test.ts` — 斜杠命令节点与「本轮文件改动」适配（`command/run`↔`done`、deliverables 呈现、write/edit 推导）。
- `historyReplay.test.ts` — 「加载更早的历史」：重放期间不发帧，避免旧轮次被实时渲染一遍。
- `thinkingStream.test.ts` — 思考完毕鲸鱼仍发光、用户消息未置顶两个缺陷的宿主侧成因。
- `renderOrder.test.ts` — 段顺序：活路径（真流式）与离线重放必须给出同一个顺序。
- `toolView.test.ts` — 工具行运行中数据：长命令要能完整带出供展开区显示。
- `unknownEvent.test.ts` — 「不认识的事件」告警的边界：已知但不渲染的簿记事件不得告警。
- `injected.test.ts` — 自动载入提示词节点（`system/message`、插件注入）的正确呈现。
- `injectedSource.test.ts` — 上下文注入条目 `source` 的按 form 分派解析（全有或全无）。
- `interactionSync.test.ts` — 多窗口下问卷 / 审批的收场判据（`$events` 的 `cancel` 帧）与 `@` 对话引用接线。
- `composerDraft.test.ts` — 草稿在「提交」链路上的顺序契约（界面乐观清空与宿主草稿表时序）。
- `pendingEcho.test.ts` — 乐观回显行为级回归：按下发送那一刻同步产生、只收「已经发出去」的那类。
- `unreadMarker.test.ts` — 「生成完毕未读」行为级回归：只有离开时正在生成才点亮蓝标题。

### 投影

- `projections.test.ts` — 投影形状回归防线（`goal` / `subagentCatalog` 的形状读错防线）。
- `projectionStore.test.ts` — 投影值存储契约：higher seq wins、baseline 语义、低 seq 丢弃。
- `projectionIngest.test.ts` — 投影摄入登记表：键集合与契约双向对齐、一个键一条。

### 连接与后台（supervisor / 连接条 / 队列 / 后台任务）

- `connectTarget.test.ts` — 内部 / 外部 DSH 选路的分支组合（内部优先、外部备用须可达、目标粘性）。
- `connectSnapshot.test.ts` — `SupervisorManager.snapshot()` 只读快照。
- `connectionStop.test.ts` — 连接收场：停止 / 换目标必须真的停下来（无限重连 dispose 三处）。
- `clientDispose.test.ts` — `DshClient.dispose()` 真能停掉自己的无限重连。
- `autoConnectConfig.test.ts` — `dshChat.autoConnect` 改动即时生效，不提示重载窗口。
- `supervisorPolicy.test.ts` — 启动 / 重连决策：没许可不许拉起、复用优先。
- `supervisorProtocol.test.ts` — supervisor 会合协议（状态文件 / 启动锁 / socket 寻址）与运行时解析。
- `supervisorErrors.test.ts` — 守护进程错误上报器的三条纪律（两处都发、互不影响）。
- `queueOrder.test.ts` — 待发送队列显示形态：插话排在排队上方、带附件的行首芯片。
- `queueView.test.ts` — 队列项视图映射：`inbox` 投影与旧线格式折算结果必须一致。
- `jobObserve.test.ts` — 后台任务实时输出的累积口径与面板接线。
- `jobsKill.test.ts` — 后台任务停止按钮两段式状态机与接线 / 样式。
- `jobsOrder.test.ts` — 后台任务名册排序口径（官方 `ordered()`）。
- `jobView.test.ts` — job 名册 / 单任务输出流 /「端点不存在」判据（0.1.7 搬运）。

### 附件 / 图片 / 引用

- `pathInsert.test.ts` — 附件归类（`classifyPath`）+ 路径插入光标处（含真实临时文件）。
- `attachments.test.ts` — 扩展名 → mediaType 纯映射与 `showOpenDialog` 跨平台约束。
- `clipboardPaths.test.ts` — 系统剪贴板路径读取的判据（解析、大小上限、目录粘贴）。
- `references.test.ts` — `@path` 引用文本的拼写规则（对齐官方 `formatFileMention`）。
- `selection.test.ts` — 编辑器选区 → 行号区间（「下一行行首结束要少算一行」边界）。
- `imageAttachments.test.ts` — 图片链路适配器侧：`attachmentId` → data URL 异步补字节。
- `imageFiles.test.ts` — 图片地址 → 字节与保存对话框默认文件名（扩展名按真实媒体类型）。
- `imageRender.test.ts` — 会话图片渲染断言（服务端渲染出 HTML，覆盖三处来源）。
- `localImages.test.ts` — 本地图片引用解析与白名单（工作目录内、图片扩展名、stat + 字节上限、失败文案里缀的引用标签）。

### 视图与界面行为

- `markdown.test.ts` — Markdown 安全与能力边界（DOMPurify 白名单放行 GFM 复选框等）。
- `footnotes.test.ts` — 脚注 marked 扩展行为断言（真 marked + 真扩展）。
- `fileLinks.test.ts` — 正文文件链接三段链路（判定 / DOM 落地 / 样式）。
- `autoScroll.test.ts` — `.chat-scroll` 自动滚动行为断言（真调用纯状态机）。
- `nodeOpen.test.ts` — 折叠节点展开态 + 过程折叠新口径（主动点开跑完不收回、新盒子贴底）。
- `turnProcess.test.ts` — 连续过程折叠最终版：只留本轮最后一段正文，段内工具次数判阈值。
- `turnFiles.test.ts` — 轮尾文件两行的去重口径（交付行说了的不再重复）。
- `turnRail.test.ts` — 轮次横条数据层：`turnOutline` 投影铺底 ∪ 已加载窗口。
- `panelTitle.test.ts` — 编辑区标签标题与窗口身份读法（不恒写 `DSH`、重载后不交叉）。
- `pathDisplay.test.ts` — 单行标题里路径拆分与省略口径（文件名不参与压缩）。
- `segment.test.ts` — 思考档位分段控件列数（≤4 档一行、5/6 档均分两行）。
- `toolbarFit.test.ts` — 底部工具栏按优先级分配的纯函数断言（挤掉顺序、同槽互斥、pinned 保底）。
- `connectView.test.ts` — 连接条三类状态、文案与按钮矩阵。
- `contextMenu.test.ts` — 会话右键菜单判据、「引用」落点算术、保存建议文件名。
- `questionFlow.test.ts` — 问卷展示口径：一次展开 vs 依次问答（`dshChat.questionBatch`）。
- `questionRender.test.ts` — 问卷卡片渲染断言（答完的问题展开后显示用户回答）。
- `planReview.test.ts` — 计划审阅（`exit_plan_mode`）请求的识别与收窄规则。
- `pendingInteraction.test.ts` — 待处理交互的选举与抑制（官方 `registerPendingInteraction` 优先级）。
- `pendingInteractions.test.ts` — `dsh/pendingInteractions.ts` 的四条内部规则（真 API 断言）。
- `presetDisplay.test.ts` — agent 预设展示文案折叠（内置四个走客户端词典）。
- `mentionCandidates.test.ts` — `@` 候选两条帧：文件先到先渲染、对话各自结算。
- `mentionNav.test.ts` — `@` / `/` 补全规则集与「返回上一层目录」。
- `emptyComposer.test.ts` — 空态下 `/` 命令栏与 `@` 候选的行为级回归（newSession 退空态后没有域）。
- `subagentPanel.test.ts` — 子代理导航与会话级切换（入口在标题右侧、进子代理 = 切会话）。
- `subagentSwitch.test.ts` — 子代理页切到兄弟的行为级回归（下拉里同级兄弟必须可见）。
- `activity.test.ts` — 顶栏子代理 / 后台任务入口「有东西在跑」判据（只认活的那份数据）。
- `occupancy.test.ts` — 上下文占用环：常驻显示、每轮刷新、口径唯一。
- `changesCard.test.ts` — 改动文件卡片三段链路（`workspace/changes` 事件 → `/api/changes.summary` → 渲染）。
- `produced.test.ts` — 「本轮产出文件」推导（`producedPath`，按成功的写类调用）。
- `fileChange.test.ts` — 「哪些文件算有改动」判定（`git.openChange` 静默无操作防线）。
- `diff.test.ts` — `shared/diff.ts`（`diffLines` / `hunkFromTexts` / `hunksFromMeta` 等）。
- `styles.test.ts` — 样式不变量：`app.css` 上关键声明的文本断言（CSS 布局结果无头环境测不了）。

### 工具行 / 工具卡契约

- `toolMeta.test.ts` — 工具行契约事实：分类、退出码解析、`stopped` 状态。
- `toolCard.test.ts` — 工具卡数据推导：哪些工具、什么条件下给卡片。
- `toolQuestion.test.ts` — `ask_user_question` 问卷事实解析（参数 + 工具结果两份 durable 材料）。
- `trajectory.test.ts` — 轨迹宿主侧折叠断言（配对、压缩生命周期、轮次分组、请求编号）。
- `localizedText.test.ts` — 服务端本地化文案的形状校验与按语言取值。

### 宿主杂项与工程防线

- `i18n.test.ts` — 宿主发给 webview 的每条文案可翻 + VS Code 原生 UI 层（`hostText.ts` + l10n bundle）不漂移。
- `hostLog.test.ts` — 日志写入器在输出通道已关闭时必须活下来（防 `EADDRINUSE` 级联缺陷）。
- `configChanges.test.ts` — 配置文件热重载：`$events` 的 emit 帧 → 客户端要重读的动作。
- `invariants.test.ts` — 源码级不变量：`switch` 里不得有重复 `case`。
- `manifest.test.ts` — `package.json` 图标口径（编辑器标题栏「新建对话窗口」必须是鲸鱼）。
- `windowState.test.ts` — 工作区窗口状态缓存的跨重启往返语义。
- `readRange.test.ts` — `read` 工具行号区间解析（meta 优先，整篇读取不标注）。
- `sessionCookie.test.ts` — `DshClient` 会话 cookie 语义（跨重启复用的基础）。
- `processRegistry.test.ts` — 外部服务器令牌流程（本地 HTTP stub）+ 进程判活。
- `previewFixture.test.ts` — `test/preview.html` 夹具体检（键重复 / 语法错让预览静默显示旧内容的防线）。

## 端到端探针（须按「【探针定位】」头的标注执行）

### 防线型（契约对拍 / 生命周期验收）

- `smoke.ts` — 耗 token：端到端冒烟（连接 → 建会话 → 发消息 → 收流），dsh 演进时抓静默错配。
- `commandE2E.ts` — 耗 token：斜杠命令通道 + 投影形状的契约对拍。
- `queueEscE2E.ts` — 耗 token：ESC 中止并把队首消息发出的端到端语义。
- `supervisorReloadProbe.ts` — 零 token：R1 重载窗口不打断后台（架构核心断言）。
- `supervisorScenariosProbe.ts` — 零 token：R2 共享 / R4 并发 / R5 自愈 / R6 可停。
- `supervisorIdleProbe.ts` — 零 token：R3 空闲退场（超时干净退场不留孤儿）。
- `supervisorChildExitProbe.ts` — 零 token：守护进程判得出 dsh 死并自动重启。
- `supervisorErrorBridgeProbe.ts` — 零 token：守护进程 error → 窗口的协议桥（用假守护进程）。
- `supervisorManagerProbe.ts` — 零 token：扩展真正用的 `SupervisorManager` 端到端（会合 / 接入 / 心跳 / 就绪）。

### 勘察型（钉住一条线上事实，结论固化后只在重开问题时跑）

- `goalSessionProbe.ts` — 耗 token：goal 投影是会话级的、无目标会话开帧不给 goal 键。
- `liveOrderProbe.ts` — 耗 token：活路径上 tool-call-delta 先于 durable 到达的帧序。
- `modelSwitch.ts` — 耗 token：「切换模型失败」的四种操作序列复现。
- `planCommandProbe.ts` — 耗 token：`/plan` 走命令通道、正文前缀无效。
- `pressureProbe.ts` — 耗 token：`contextPressure` 投影按轮推送且内容变化。
- `projectionSeqProbe.ts` — 耗 token：投影水位（seq / asOfSeq）的线上形状。
- `queueContinueProbe.ts` — 耗 token：只 `cancel` 不会让队列接续。
- `queueOrderProbe.ts` — 耗 token：队列自动派发的落盘 / 到达帧序。
- `readRangeProbe.ts` — 耗 token：read 工具 `result.meta` 形状与行号缀写规则。
- `sessionListProbe.ts` — 耗 token：fork 会话在 `session/list` 里的形状。
- `systemPromptProbe.ts` — 耗 token：dump 真实会话的 `system/message`（几条、每轮是否重发）。
- `workspaceProbe.ts` — 零 token：工作区分组要用 `workspaceId` 建会话（临时 DSH_HOME）。
- `configReloadProbe.ts` — 零 token：settings / credentials 外部编辑以转发帧到达客户端。
- `railJumpProbe.ts` — 零 token：点轮次横条未加载刻点 → 取回用户消息 → 落位的数据侧全链路（纯离线读日志）。

### 工具型（诊断 / 取证，零 token，可自由运行）

- `probe.ts` — 直连已有服务只读打印会话列表与控制流 baseline。
- `pageLoopProbe.ts` — 「加载更早的历史」分页循环真实推演（只读不开写路径）。
- `panelsProbe.ts` — 只读拉取各面板依赖的接口形状。
- `dumpSettings.ts` — 只读转储设置 schema JSON（设置面板设计依据）。
- `effortProbe.ts` — 打印模型目录思考档位清单（排版依据）。
- `authChainProbe.ts` — 起本地 dsh 验认证链（换 cookie、列会话）。
- `cookieSurvivesRestart.ts` — 起两次 dsh 验「cookie 跨重启有效」。
- `queueLogInspect.ts` — 读本地会话日志取证队列时序。
- `sessionLogScan.ts` — 会话日志体检 CLI：回答「服务端到底认为这个会话是什么状态」。
- `tailRowsProbe.ts` — 轮尾三样（改动卡片 / 本轮文件 / 交付文件）分布体检（离线回放）。
- `pinger.ts` — 手工排查窗口（已收敛成 `supervisorPingerHarness` 的薄壳）。

### 探针支撑（非 CLI，供其它探针 import）

- `supervisorProbeEnv.ts` — 给无头探针完全隔离的一次性环境（supervisor 会合目录 + `DSH_HOME` 两层隔离）。
- `supervisorPingerHarness.ts` — supervisor 端到端探针共用的「窗口壳」。
- `sessionLog.ts` — 会话日志解码库（多帧 zstd → JSONL 文本）。
- `renderOrderProbe.ts` — 事件顺序 vs 渲染顺序并排打印（段排序问题现场工具）。
- `vscodeTestStub.ts` — `vscode` API 的离线 stub（esbuild alias，供 `subagentSwitch.test.ts` 驱动真 `ChatController`）。

### 契约追踪（非探针的独立工具）

- `dshContract.ts` — DSH 契约快照与差异分析纯逻辑（官方契约面 × 本扩展消费面 = 影响面）。
- `dshContract.test.ts` — 上述逻辑的离线断言（版本判读、差异分级规则）。
- `dshCompat.ts` — CLI 入口：`watch`（未核对的官方版本）/ `snapshot <版本>`（抓契约面落盘 `docs/dsh-contract/`）/ `check` 等命令，全部离线。

## 工具脚本（`*.mjs`）

- `runTests.mjs` — 并行跑全部离线断言（`build/*.test.mjs`），固定顺序缓冲输出（`npm test` 背后）。
- `typecheck.mjs` — 并行跑两个 tsconfig 的 `--noEmit`（`npm run typecheck` 背后）。
- `esbuild.scripts.mjs` 之外注意：断言的登记表就在 `esbuild.scripts.mjs` 的 `entries` 里。
- `package.mjs` — 打包 vsix：读 `package.json` 的 version，产出 `Releases/dsh-chat-<version>.vsix`（绕开 npm 在 Windows 上展开 `$npm_package_version` 失败的坑）。
- `installVsix.mjs` — 安装 vsix 到本机 VS Code（顺带压掉 `code` CLI 的 `DEP0169` 弃用警告）。
- `releaseNotes.mjs` — 抽出当前版本 CHANGELOG 作 GitHub Release 正文（找不到该节直接失败）。
- `previewServer.mjs` — UI 预览静态服务器（让 Playwright 加载 `test/preview.html`）。
- `bench.mjs` — 本地构建 / 测试耗时基准（定位开发循环里哪一步慢）。

### 一次性修复脚本

- `setDefaultModel.ts` — 恢复默认模型设置（冒烟测试改写本机 `agent-default-model` 后的一次性还原）。
