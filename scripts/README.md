# scripts/ — 断言、探针与工具脚本

本目录是顶层文件，按用途分三类（每个文件头部都写明自己的定位与运行方式）；另有 `tests/` 子目录，
放按被测对象分组的断言与它们共用的测试基础设施（作用见 [tests/README.md](<tests/README.md>)）：

- **离线断言**（`*.test.ts`）——与被测源文件同名对应，不联网、不起进程（个别起本地 stub），`npm test` 跑的就是它们。**必须登记进 `esbuild.scripts.mjs` 的 `entries` 才会真正被执行**——新建断言后忘了登记，测试就静默落空。
- **端到端探针**（多为 `*Probe.ts`，另有若干防线型脚本）——对真实 `dsh web` 或真实会话日志取证的勘察/防线脚本。文件头的「【探针定位】」块标注类型（勘察型 / 防线型 / 工具型）与是否耗模型 token：**耗 token 的按 AGENTS.md 硬约束不得随构建自动执行，每次运行前须获用户批准（一次批准一次有效）**；零 token 仍须遵守当前任务的服务与日志访问范围，不得凭“零 token”扩大读取范围。
- **显式调用的工具 / 量测脚本**（`*.ts`，用 `node build/<名>.mjs` 跑，不走 `npm test`）——夹具生成与离线校验、完整载荷量测那一类，**不在上面的三类里**。文件头的「【脚本定位】」块标注它的类型、是否耗 token、是否读本机会话日志，以及「绝不进 `npm test`」这类调用口径；与【探针定位】同一条纪律：耗 token 或读本机日志的必须当次批准，一次批准一次有效。
- **工具脚本**（`*.mjs`）——打包、安装、发布、测试与类型检查的流水线脚本。

依赖说明：断言与探针共用 `src/` 的纯模块；`vscode` 模块在离线环境由 `vscodeTestStub.ts` 经 esbuild alias 顶替；探针的一次性隔离环境由 `supervisorProbeEnv.ts` 提供。

---

## 离线断言（`*.test.ts`）

### 会话主链路与协议适配

- `wire.test.ts` — 过线语义：宿主 → webview 的帧被 JSON 序列化会丢 `undefined` 键，清空字段必须发 `null`。
- `sessionView.test.ts` — 「一个会话在界面上的状态」只有唯一生产者，字段集合不得在生产者之间漂移。
- `sessionStatus.test.ts` — `api-session/status` 状态位中继的解码与采纳策略（服务端权威的「这轮在不在跑」）。
- `sessionList.test.ts` — 会话列表行可见性与分支呈现（用 `origin` 而非 `parentSessionId` 区分子代理），以及发帧前的**按窗口收窄**判据（无文件夹时跟随该窗口当前会话的 cwd）。
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
- `errorSessionStatus.test.ts` — 报错会话的状态口径：产品语义（离开时界面显示生成中 → 收尾亮未读）与两条错误分支（`session/follow` 单流失败不重开、提交失败无条件回滚覆盖 durable 证据）的行为级回归；驱动真 `ChatController`。

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
- `queueHover.test.ts` — 队列行悬停看全文：截断判据是实测溢出（非字数）、浮层落位 / 限高与接线。
- `queueView.test.ts` — 队列项视图映射：`inbox` 投影与旧线格式折算结果必须一致。
- `queueRestore.test.ts` — 「取回重新编辑」的完整语义（真 `ChatController` + vscode stub）：摘除回显先于 RPC resolve 仍要还原、切换会话写回原会话、remove 失败不回填、**附件还原不了就整条不摘**（durable 文件缺回执 / 图片字节取不到 / 两者混合：队列与草稿原样 + 按会话提示）、纯 durable 图片完全可还原的对照、草稿追加按肯定身份去重（同名同字节不同图、同路径不同回执都不合并）。
- `jobObserve.test.ts` — 后台任务实时输出的累积口径与面板接线。
- `jobsKill.test.ts` — 后台任务停止按钮两段式状态机与接线 / 样式。
- `jobsOrder.test.ts` — 后台任务名册排序口径（官方 `ordered()`）。
- `jobView.test.ts` — job 名册 / 单任务输出流 /「端点不存在」判据（0.1.7 搬运）。

### 附件 / 图片 / 引用

- `pathInsert.test.ts` — 附件归类（`classifyPath`）+ 路径插入光标处 + `@` 目录块的整段替换（含引号空格目录的闭引号边界，真实临时文件）。
- `attachments.test.ts` — 扩展名 → mediaType 纯映射与 `showOpenDialog` 跨平台约束。
- `clipboardPaths.test.ts` — 系统剪贴板路径读取的判据（解析、大小上限、目录粘贴）。
- `references.test.ts` — `@path` 引用文本的拼写规则（对齐官方 `formatFileMention`）。
- `selection.test.ts` — 编辑器选区 → 行号区间（「下一行行首结束要少算一行」边界）。
- `imageAttachments.test.ts` — 图片链路适配器侧：`attachmentId` → data URL 异步补字节。
- `imageFiles.test.ts` — 图片地址 → 字节与保存对话框默认文件名（扩展名按真实媒体类型）。
- `imageRender.test.ts` — 会话图片渲染断言（服务端渲染出 HTML，覆盖三处来源）。
- `localImages.test.ts` — 本地图片引用解析与白名单（工作目录内、图片扩展名、stat + 字节上限、失败文案里缀的引用标签）。

### 视图与界面行为

- `markdown.test.ts` — Markdown 安全与能力边界（DOMPurify 白名单放行 GFM 复选框、外链图片加固、Windows 反斜杠路径的链接 / 图片目标不被 CommonMark 转义吃掉）。
- `footnotes.test.ts` — 脚注 marked 扩展行为断言（真 marked + 真扩展）。
- `fileLinks.test.ts` — 正文文件链接三段链路（判定 / DOM 落地 / 样式）。
- `autoScroll.test.ts` — `.chat-scroll` 自动滚动行为断言（真调用纯状态机）。
- `nodeOpen.test.ts` — 折叠节点展开态 + 过程折叠新口径（主动点开跑完不收回、新盒子贴底）。
- `turnProcess.test.ts` — 连续过程折叠最终版：只留本轮最后一段正文，段内工具次数判阈值。
- `todoCollapse.test.ts` — 「任务清单」面板折叠：默认展开、收起只留当前执行项（没有在执行的则留最后执行过的那条；全 pending / 空清单不挂条目）、抬头箭头展开朝下 / 收起朝上。
- `turnFiles.test.ts` — 轮尾文件两行的去重口径（交付行说了的不再重复）。
- `turnRail.test.ts` — 轮次横条数据层：`turnOutline` 投影铺底 ∪ 已加载窗口。
- `panelTitle.test.ts` — 编辑区标签标题与窗口身份读法（不恒写 `DSH`、重载后不交叉）。
- `pathDisplay.test.ts` — 单行标题里路径拆分与省略口径（文件名不参与压缩）。
- `segment.test.ts` — 思考档位分段控件列数（≤4 档一行、5/6 档均分两行）。
- `pickerFocus.test.ts` — 模型弹层「打开即定位到选中项」：起点判定、方向键移动、两处共用的接线与高亮样式。
- `toolbarFit.test.ts` — 工具栏档位分配、极窄保底与布局盒判据；使用可注入观察者验证节点替换、幂等挂载、StrictMode 重挂与清理，并覆盖旧生命周期的负对照。
- `connectView.test.ts` — 连接条三类状态、文案与按钮矩阵。
- `contextMenu.test.ts` — 会话右键菜单判据、「引用」落点算术、保存建议文件名。
- `questionFlow.test.ts` — 问卷展示口径：一次展开 vs 依次问答（`dshChat.questionBatch`）。
- `questionRender.test.ts` — 问卷卡片渲染断言（答完的问题展开后显示用户回答）。
- `planReview.test.ts` — 计划审阅（`exit_plan_mode`）请求的识别与收窄规则。
- `pendingInteraction.test.ts` — 待处理交互的选举与抑制（官方 `registerPendingInteraction` 优先级）。
- `pendingInteractions.test.ts` — `dsh/pendingInteractions.ts` 的四条内部规则（真 API 断言）。
- `presetDisplay.test.ts` — agent 预设展示文案折叠（内置四个走客户端词典）。
- `presetMatch.test.ts` — 配置项 `dshChat.agentPreset` 认 id 也认显示名（中英两名、撞名取第一个、认不出原样传）。
- `mentionCandidates.test.ts` — `@` 候选两条帧：文件先到先渲染、对话各自结算；判定位 `resolved` 与 `query` 同一批收下、换查询即归零。
- `fileRefListing.test.ts` — `@` 目录列举补全：服务器 20 条上限之外的尾巴按官方同一套排序补齐（真盘临时目录 + 真控制器）。
- `mentionResolve.test.ts` — 「光标所在的 `@` 块已经能引用到内容时不弹列表」的宿主侧判据：路径在盘上 / 带行号区间 / 对话引用 token，以及裸会话 id 必须照旧弹（真控制器 + 真盘临时目录）。
- `mentionNav.test.ts` — `@` / `/` 补全规则集、「返回上一层目录」、`@` 块的两层判定（块认得出来 + 抑制门：浏览入口恒弹、判定说能引用就不弹；带引号空格目录解包整块）、焦点回到输入框算新编辑动作（清「已关闭」记忆 + 重算触发词）与目录块整段替换。
- `mentionLinks.test.ts` — 正文里 `@` 引用的判定：文件 / 目录按形状，会话按「草稿里的原始 token」或「已发出消息的 `sessionRefs` 清单」两种来路。
- `mentionLinksUi.test.ts` — 上面那份判定真的渲染成可点行内按钮（悬停说明按三档目标给），以及 `.mention-link` 的行内样式。
- `emptyComposer.test.ts` — 空态下 `/` 命令栏与 `@` 候选的行为级回归（空态就绑在壳上，菜单读它、不另建）。
- `composerSend.test.ts` — 发送按钮的手势链路：按住 Ctrl / Cmd 时文字换成这一次真会走的那条路、点按钮发加速手势（真事件链 + 真 `Composer` 渲染），空闲仍发送、运行中无草稿仍是停止。
- `blankSessionReuse.test.ts` — 「空态必有壳、首条消息发给谁」：`reusableBlank` 的本地 blank 位（不许把已经说过话的会话当空壳接回来）、两个窗口共用一条壳、空壳上选的模型留得住。
- `subagentPanel.test.ts` — 子代理导航与会话级切换（入口在标题右侧、进子代理 = 切会话）。
- `subagentSwitch.test.ts` — 子代理页切到兄弟的行为级回归（下拉里同级兄弟必须可见）。
- `subagentRowState.test.ts` — 子代理目录行的显示状态（生成中 / 已完成 / 可继续 / 一次性 + 状态点色调）：驻留状态的到达顺序、进出子代理页、已读位与界面口径。
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
- `trajectory.test.ts` — 轨迹宿主侧折叠断言（配对、压缩生命周期、轮次分组、请求编号、**请求表**——选项 / 用量含会话累计 / 请求计时 / 重试与认证失败口径、时间线接线与官方语义）。
- `trajectoryDisplay.test.ts` — 轨迹「一行显示什么」的逐条判据（官方 `recordDisplayText` / `isToolCallOnly` 的等价物）。
- `trajectoryVendor.test.ts` — `src/vendor/` 里那几份官方纯决策模块的判据（预览投影语法、`recordId` 回退链、搜索分词 AND、时间线并发区间与模式语义、PTC 代码程序）。
- `trajectoryVirtual.test.ts` — 账本虚拟化的窗口算术（阈值 100 / overscan 12 / 行高估计、首帧与坏输入、垫行守恒、记录下标 → 行位置的换算）。
- [trajectoryLedgerRows.test.ts](<trajectoryLedgerRows.test.ts>) — 账本布局行投影（flatten／搜索优先过滤／两种折叠／每 section 起点）的离线判据。
- [trajectoryInteraction.test.ts](<trajectoryInteraction.test.ts>) — 真实交互端口的离线判据（选择互斥／reveal 消费与收尾／pending ack／手势与清理）；模拟生命周期绿不替代首次真实 DOM 几何。
- `inspectCall.test.ts` — 跨视图跳转「在轨迹里查看这次调用」（工具行那颗按钮的渲染与入参、轨迹侧按 `callId` 的落点判据、两端接线）。
- `localizedText.test.ts` — 服务端本地化文案的形状校验与按语言取值。

### 宿主杂项与工程防线

- `i18n.test.ts` — 宿主发给 webview 的每条文案可翻 + VS Code 原生 UI 层（`hostText.ts` + l10n bundle）不漂移 + 界面按运行时字符串查表的那几处（工具自有标题）在两份词典里都有译文。
- `hostLog.test.ts` — 日志写入器在输出通道已关闭时必须活下来（防 `EADDRINUSE` 级联缺陷）。
- `configChanges.test.ts` — 配置文件热重载：`$events` 的 emit 帧 → 客户端要重读的动作。
- `invariants.test.ts` — 源码级不变量：`switch` 里不得有重复 `case`。
- `manifest.test.ts` — `package.json` 图标口径（编辑器标题栏「新建对话窗口」必须是鲸鱼）。
- `windowState.test.ts` — 工作区窗口状态缓存的跨重启往返语义。
- `readRange.test.ts` — `read` 工具行号区间解析（meta 优先，整篇读取不标注）。
- `sessionCookie.test.ts` — `DshClient` 会话 cookie 语义（跨重启复用的基础）。
- `processRegistry.test.ts` — 外部服务器令牌流程（本地 HTTP stub）+ 进程判活。
- `previewFixture.test.ts` — `test/preview.html` 夹具体检（键重复 / 语法错让预览静默显示旧内容的防线）。

### 补充专项断言

- [sessionListScope.test.ts](<sessionListScope.test.ts>) — 历史列表跟随**当前会话 cwd**：没有打开文件夹时两个面板各开一个目录，历史按各自的 cwd 隔离（切换 / 换选目录 / 空态未绑 / 无 cwd 兜底逐条覆盖），打开着文件夹时仍是「所有窗口同一份 + 注册表 + 已打开域兜底」的旧口径；还覆盖**绑在子代理会话**上的窗口（它的 cwd 只在权威 `session/list` 里、不在可见历史里）与权威 cwd 账本的生命周期（列表里消失即淘汰、换连接清空）。
- [find.test.ts](<find.test.ts>) — 会话查找的跨文本节点匹配与命中位置环绕；不替代真实 DOM 高亮验收。
- [blankRestoreRace.test.ts](<blankRestoreRace.test.ts>) — 恢复历史会话与自动补空会话并发时，驱动真实控制器验证绑定不被覆盖。
- [workspaceDirRepick.test.ts](<workspaceDirRepick.test.ts>) — 未打开文件夹时空态页的目录胶囊：每次都弹选择框、换目录真的落到新目录那条壳上（先切后建、取消保持原状、换回复用旧壳）；打开着文件夹时仍是锁定口径。
- [imageHydrate.test.ts](<imageHydrate.test.ts>) — 驱动本地图片水合模块，验证宿主回帧之前的失败不提前替换图片，回帧后的真实失败正常降级。
- [trajectoryPre.test.ts](<trajectoryPre.test.ts>) — 轨迹原文呈现的默认不换行、渲染不写偏好以及复制与换行入口。
- [trajectoryPromptDiff.test.ts](<trajectoryPromptDiff.test.ts>) — 系统提示词和工具目录的行级差分、上下文窗口与相同内容省略规则。
- [sessionLog.test.ts](<sessionLog.test.ts>) — 受控合成 zstd 材料上的字节与路径入口对照、帧内部魔数以及非零字节视图边界；不读取用户日志。
- [trajectoryProbeFacts.test.ts](<trajectoryProbeFacts.test.ts>) — 新旧工具结果信封、JSON 解析与深度统计，以及对拍缺失、错配、零样本和输入缺口的纯断言。
- [trajectoryProbeCli.test.ts](<trajectoryProbeCli.test.ts>) — 受控替换下真实 CLI 的缺失退出与读路径闸门；先证注入命中，不把受控 missing 视为自然可达，不扫描默认目录。
- `tests/` 子目录下的断言按被测对象分组，逐文件说明见 [tests/README.md](<tests/README.md>)。

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
- `workspaceProbe.ts` — 零 token：工作区分组要用 `workspaceId` 建会话（临时 DSH_HOME，成功时自清理）。
- `configReloadProbe.ts` — 零 token：设置文档（**当前 profile 的 `cordis.patch.yml`**，不是 `$DSH_HOME/settings.yaml`）与 credentials 的外部编辑以转发帧到达客户端；改的是数组层里的 `- id:` 行，追加前必须剔掉模板的空数组 `[]`。
- `railJumpProbe.ts` — 零 token：点轮次横条未加载刻点 → 取回用户消息 → 落位的数据侧全链路（纯离线读日志）。

### 工具型（诊断 / 取证，零 token；读取真实会话须先取得本次范围授权）

- `probe.ts` — 直连已有服务只读打印会话列表与控制流 baseline。
- [trajectoryAlignProbe.ts](<trajectoryAlignProbe.ts>) — 授权范围内的展示分类与分组对拍；分别报告应比、已比、缺失、错配、输入缺口和未比较字段。退出码 0 为已比较样本通过，1 错配、2 缺失、3 零样本、4 输入覆盖缺口、5 参数错误（不读取来源）；不得把零样本或未比较当成一致。
- [trajectoryFoldProbe.ts](<trajectoryFoldProbe.ts>) — 只量**宿主侧事件摊开／排序／派生**；历史中位 0.4ms、最大 9.5ms（452 份）不是完整载荷、传输、前端索引与渲染基准，不能据此关闭整链路性能项。
- [trajectoryGapProbe.ts](<trajectoryGapProbe.ts>) — 观察工具参数与结果的 JSON 嵌套、载荷长度及结果块分布；统计结论须明确抽取口径与分母。
- [trajectoryShapeProbe.ts](<trajectoryShapeProbe.ts>) — 观察轨迹所需 durable 字段形态与 inbox 分类输入；输出观察而非正确性断言。
- `pageLoopProbe.ts` — 「加载更早的历史」分页循环真实推演（只读不开写路径）。
- `panelsProbe.ts` — 只读拉取各面板依赖的接口形状（**需要一个既有会话当样本**：隔离 home 里没有会话，会以「样本不存在」失败）。
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
- [sessionLog.ts](<sessionLog.ts>) — 会话日志解码库；字节入口消费同一快照。旧宽松入口保留兼容；夹具生成显式使用严格入口，验证完整 zstd 帧／原生解压与校验和、全帧拼接后的 fatal UTF-8、对象 JSONL。完整末行无需换行；内部完整不认证历史来源。
- [trajectoryProbeFacts.ts](<trajectoryProbeFacts.ts>) — 两条轨迹统计入口与离线测试共用的内容块抽取、JSON 形状与对拍累计器；无文件或网络访问，调用方负责输出和退出。
- `renderOrderProbe.ts` — 事件顺序 vs 渲染顺序并排打印（段排序问题现场工具）。
- `vscodeTestStub.ts` — `vscode` API 的离线 stub（esbuild alias，供 `subagentSwitch.test.ts` / `subagentRowState.test.ts` 驱动真 `ChatController`）。

### S02 夹具工具链（离线；提取 CLI 只在显式调用时运行）

- [trajectoryFixture.ts](<trajectoryFixture.ts>) — 夹具的**纯脱敏变换 / 秘密扫描 / 结构不变量 / 登记校验**；
  **零 Node 依赖**（哈希由调用方注入），读日志与落盘不在这里。
- [trajectoryFixtureBuild.ts](<trajectoryFixtureBuild.ts>) — 提取 CLI：把一份会话日志派生成
  `test/fixtures/trajectory/<name>.json`。**不是 `npm test` 的一部分**（标准测试不得读用户日志目录），
  只在被显式调用时运行；失败与成功输出都是中英两套固定文案。
- [trajectoryFixtureVerify.ts](<trajectoryFixtureVerify.ts>) — **离线校验 CLI**：只读既有夹具文件、
  不读源日志，跑与生成器读回校验同一套判据；成功输出逐条打印三条边界（自洽 ≠ 来源真实 /
  不代表版本语义兼容 / 不代表帧完整性）。
- [fixtureCliText.ts](<fixtureCliText.ts>) — 两个 CLI 的固定文案表（中英两套）与语言中立的脱敏规则 id。
- 回归与受控观察器在 `tests/` 子目录（逐文件说明见 [tests/README.md](<tests/README.md>)）；
  夹具目录契约见 [test/fixtures/trajectory/README.md](../test/fixtures/trajectory/README.md)。

### 完整载荷量测（离线，先量后优化）

- [trajectoryPayloadBench.ts](<trajectoryPayloadBench.ts>) — 资格门与 Node 量测：登记齐全、`payloadReduced === false`、完整载荷资格为真、登记键 `provenance.truncatedFields` 为空才可测；可固定派生源 SHA-256。重复 `--fixture`，默认预热 2／样本 11，输出 min／median／nearest-rank p95／max 和原值。`fold.rebuild` 是合成事件重建下界，**不是真实源读取／严格解码／派生全链**；JSON wire clone 也不是 VS Code IPC。
- [trajectoryPayloadBenchCli.ts](<trajectoryPayloadBenchCli.ts>) — 薄 IO 入口；量测与 `--emit-browser` 共用资格门、固定摘要贯穿；拒测 exit 3、不得落半成品。`--out` 写失败也是失败；`--serve-browser` 等待真实监听并打印实际端口。
- [trajectoryPayloadBenchBrowser.ts](<trajectoryPayloadBenchBrowser.ts>) — 独立工件装配与真实浏览器 runner：生产 CSS 原字节、13px 主题桥、生产源码打点见证、三类真实脱敏夹具。同步阶段与真实 3 秒异步索引窗口分开记录，允许批次节流合并。索引执行判据使用首载真实生产 timer 的 schedule→fire→landed；刷新尾部落地另报观察，不由 `afterRefreshExecuted` 单独判失败，也不把挂起／取消计为已执行。完成须同时等 `window.__M06_DONE__ === true` 和 `window.__M06__.done === true`，半途 `running` 不是结论；JSON／React 量测不冒充扩展宿主 IPC。
- [trajectoryPayloadBench.test.ts](<trajectoryPayloadBench.test.ts>) — 资格／退出／工件／异步窗口的离线红绿防线，不替代实际浏览器量测。示例命令与分母边界见[轨迹设计](<../docs/design-trajectory.md>)。

### 契约与固定来源追踪（非耗 token 探针）

- `dshContract.ts` — DSH 契约快照与差异分析纯逻辑（官方契约面 × 本扩展消费面 = 影响面）。
- `dshContract.test.ts` — 上述逻辑的离线断言（版本判读、差异分级规则）。
- [dshCompat.ts](<dshCompat.ts>) — `watch`／`snapshot <版本>`／`check` 服务端契约追踪；**不覆盖官方 UI 语义**，远端版本／契约获取可能访问网络，不耗模型 token 不等于断网。
- [vendorSourceLock.ts](<vendorSourceLock.ts>)、[登记表](<vendorSourceLock.json>)、[离线回归](<vendorSourceLock.test.ts>) — 11 份官方原字节见证与 vendor 文件集合双向锁；只归一化模块说明符，保留 literal／template／regex／ASI 语义。基准为固定官方提交，不用本地 HEAD；自洽摘要不能认证历史来源。原字节见证与授权边界见[夹具索引](<../test/fixtures/README.md>)。

## 工具脚本（`*.mjs`）

- `runTests.mjs` — 并行跑全部离线断言（`build/*.test.mjs`），固定顺序缓冲输出（`npm test` 背后）。
- [typecheck.mjs](<typecheck.mjs>) — 并行检查宿主、webview、夹具工具与轨迹工具四个 tsconfig（`--noEmit`）。第三个覆盖正式夹具链；第四个覆盖本批正式 `scripts/**`：M06 量测、D01 探针、M01 源锁、轨迹页的宿主折叠／界面投影／交互端口／账本行／检查器／提示词差分／vendor 适配回归、两条探针 CLI，以及日志、预览夹具体检、样式、流式等相邻回归。覆盖范围以各工程 `include` 为准：**本批相关的 `scripts/**` 已全部纳入，其余历史断言仍不在任何工程里**（本批之前就如此），别把「本批已覆盖」读成「全部 `scripts/**` 已覆盖」。
- `esbuild.scripts.mjs` 之外注意：断言的登记表就在 `esbuild.scripts.mjs` 的 `entries` 里。
- `package.mjs` — 打包 vsix：读 `package.json` 的 version，产出 `Releases/dsh-chat-<version>.vsix`（绕开 npm 在 Windows 上展开 `$npm_package_version` 失败的坑）。
- `installVsix.mjs` — 安装 vsix 到本机 VS Code（顺带压掉 `code` CLI 的 `DEP0169` 弃用警告）。
- `releaseNotes.mjs` — 抽出当前版本 CHANGELOG 作 GitHub Release 正文（找不到该节直接失败）。
- `previewServer.mjs` — UI 预览静态服务器（让 Playwright 加载 `test/preview.html`）。
- `bench.mjs` — 本地构建 / 测试耗时基准（定位开发循环里哪一步慢）。

### 一次性修复脚本

- `setDefaultModel.ts` — 恢复默认模型设置（冒烟测试改写本机 `agent-default-model` 后的一次性还原）。
