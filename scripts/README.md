# scripts/ — 断言、探针与工具脚本

顶层文件分四类；分组断言与基础设施见[tests 导航](<tests/README.md>)。运行方式、访问范围与取证边界以各文件头为准。

- **离线断言**（`*.test.ts`）：`npm test` 运行，不访问真实 DSH / 模型；部分启动本地 stub。新增项须登记到[脚本构建入口](<../esbuild.scripts.mjs>)的 `entries`。
- **探针**（多为 `*Probe.ts`）：真实服务 / 日志上的勘察、防线或取证，不能随构建自动执行。
- **显式工具 / 量测**（`*.ts`）：夹具生成、离线校验与载荷量测，`node build/<名>.mjs` 调用，不进默认测试。
- **流水线工具**（`*.mjs`）：测试、类型检查、打包、安装与发布。

**耗模型 token 或读取本机会话日志须当次批准，一次批准一次运行**；零 token 也不扩大当前任务的服务 / 日志访问范围。常规验证与批准规则见[AGENTS](<../AGENTS.md>)。

断言与探针复用源码纯模块；[vscodeTestStub.ts](<vscodeTestStub.ts>) 经 esbuild alias 替代 vscode，[supervisorProbeEnv.ts](<supervisorProbeEnv.ts>) 提供一次性隔离环境。

**走文件系统解析的夹具路径按宿主平台算绝对**（`join(tmpdir(), …)` 拼），不能写死 Windows 形态：`node:path` 的 `isAbsolute` 是平台相关的，`C:\…` 在 Linux 上会被当成相对路径，缺 cwd 时直接解析不了——断言只看到「什么也没打开」，而不是一条像样的失败。CI 跑在 `ubuntu-latest`，本地 Windows 绿不代表它绿；只做字符串断言的夹具（分隔符清洗之类）不受此限。

---

## 离线断言（`*.test.ts`）

### 会话主链路与协议适配

- [wire.test.ts](<wire.test.ts>) — 过线语义：宿主 → webview 的帧被 JSON 序列化会丢 `undefined` 键，清空字段必须发 `null`。
- [sessionFollow.test.ts](<sessionFollow.test.ts>) — 跟随请求显式激活会话，与官方界面保持一致，同时兼容旧服务端忽略未知字段的行为。
- [sessionView.test.ts](<sessionView.test.ts>) — 「一个会话在界面上的状态」只有唯一生产者，字段集合不得在生产者之间漂移。
- [sessionStatus.test.ts](<sessionStatus.test.ts>) — `api-session/status` 状态位中继的解码与采纳策略（服务端权威的「这轮在不在跑」）。
- [sessionActivity.test.ts](<sessionActivity.test.ts>) — `api-session/activity` 活动时间中继的解码（子代理目录排序里用户消息的实时来路，形状不可信时返回 `undefined`）。
- [sessionList.test.ts](<sessionList.test.ts>) — 会话列表行可见性与分支呈现（用 `origin` 而非 `parentSessionId` 区分子代理），以及发帧前的**按窗口收窄**判据（无文件夹时跟随该窗口当前会话的 cwd）。
- [parseToolResult.test.ts](<parseToolResult.test.ts>) — `dsh/adapter.ts` 的 `parseToolResult`（read 信封等工具结果解析）。
- [commandNode.test.ts](<commandNode.test.ts>) — 斜杠命令节点与「本轮文件改动」适配（`command/run`↔`done`、deliverables 呈现、write/edit 推导）。
- [historyReplay.test.ts](<historyReplay.test.ts>) — 「加载更早的历史」：重放期间不发帧，避免旧轮次被实时渲染一遍。
- [thinkingStream.test.ts](<thinkingStream.test.ts>) — 思考完毕鲸鱼仍发光、用户消息未置顶两个缺陷的宿主侧成因。
- [renderOrder.test.ts](<renderOrder.test.ts>) — 段顺序：活路径（真流式）与离线重放必须给出同一个顺序。
- [steeringPlacement.test.ts](<steeringPlacement.test.ts>) — 用户消息落位：本轮提问（插到轮首）与生成中插话（追加 + 切段）的分界只看 next-step 的**本次领取**，子代理开轮的会话里插话不得被抬到本轮顶部。
- [toolView.test.ts](<toolView.test.ts>) — 工具行打开目标的运行/结算/失败/嵌套矩阵：相对参数只在成功结算的根调用上可用，绝对记录值优先；技能名只从参数取，不构造本机路径。
- [workspacePath.test.ts](<workspacePath.test.ts>) — 跨平台路径纯字符串判据：绝对形态（POSIX / 盘符 / UNC）、只拼接不规范的相对解析、记录值只认绝对字符串、身份键不转小写/不消点、终端标签的点段与 UNC 根折叠。
- [toolPath.test.ts](<toolPath.test.ts>) — 工具行 / 产物 / 终端目录三套独立判据：流式完整 `file_path` 与 `path` 的边界、`mutationResultPath` 三档、`meta.cwd` 原样与运行/嵌套/terminal_send 分档。
- [pathAdapter.test.ts](<pathAdapter.test.ts>) — 适配器接线：`parentCallId` / `meta` / `seq` / `turn` 透传，产物保留全部参数别名与坐标，失败与 PTC 子调用不进根产物，实时与历史重放同路。
- [changesPath.test.ts](<changesPath.test.ts>) — 改动清单坐标关联：根内相对 / 根外绝对、规范化根拼不上就不挂、大小写与点段不作身份、Windows 分隔符与 POSIX 字面反斜杠的边界、多行同目标时只接受唯一命中。
- [skill.test.ts](<skill.test.ts>) — `skill` 节点的文本事实：合法技能名、半截参数不猜、只从结果信封取 `<skill_instructions>` 正文。
- [unknownEvent.test.ts](<unknownEvent.test.ts>) — 「不认识的事件」告警的边界：已知但不渲染的簿记事件不得告警。
- [injected.test.ts](<injected.test.ts>) — 自动载入提示词节点（`system/message`、插件注入）的正确呈现。
- [injectedSource.test.ts](<injectedSource.test.ts>) — 上下文注入条目 `source` 的按 form 分派解析（全有或全无）。
- [interactionSync.test.ts](<interactionSync.test.ts>) — 多窗口下问卷 / 审批的收场判据（`$events` 的 `cancel` 帧）与 `@` 对话引用接线。
- [composerDraft.test.ts](<composerDraft.test.ts>) — 草稿在「提交」链路上的顺序契约（界面乐观清空与宿主草稿表时序）。
- [composerSessionDraft.test.ts](<composerSessionDraft.test.ts>) — 会话标题投影、同名区间绑定、编辑失效与完整标题重匹配、真实补全事件写回和 Ctrl 目标；斜杠扫描不侵入会话标题，镜像与打开目标区间一致；纯离线覆盖中英界面。
- [pendingEcho.test.ts](<pendingEcho.test.ts>) — 乐观回显行为级回归：按下发送那一刻同步产生、只收「已经发出去」的那类。
- [unreadMarker.test.ts](<unreadMarker.test.ts>) — 「生成完毕未读」行为级回归：只有离开时正在生成才点亮蓝标题。
- [notificationQueue.test.ts](<notificationQueue.test.ts>) — 消息通知行为级回归：合并判据（归属 / 级别 / 类型 / 关键内容）、确认后复发新建、迟到确认不吞新发生、每会话 `seq` 水位拒重发（1000 条之后仍拒）、已确认 500 上限与未确认不淘汰、无持久化；驱动真 `ChatController` 覆盖多视图镜像只算一次、按会话过滤、确认跨视图同步、执行目录只在 live 真实变更时通知（开帧 / baseline / null 清空 / 同水位静默）、删除会话清理水位。
- [notificationsView.test.ts](<notificationsView.test.ts>) — 通知界面的接线回归：镜像 reducer、ack 上报帧形状、命令打开抽屉的路由、ESC 关闭不确认不中止。
- [notificationsController.test.ts](<notificationsController.test.ts>) — 通知的宿主接线回归（真 `ChatController`）：多视图镜像只算一次、ack 跨视图同步、视图关闭重绑保留、无窗口命令经主侧栏 ready 消费、复制失败归属与请求号水位、删除会话清理 `seq` 水位。
- [errorSessionStatus.test.ts](<errorSessionStatus.test.ts>) — 报错会话的状态口径：产品语义（离开时界面显示生成中 → 收尾亮未读）与两条错误分支（`session/follow` 单流失败不重开、提交失败无条件回滚覆盖 durable 证据）的行为级回归；驱动真 `ChatController`。

### 投影

- [projections.test.ts](<projections.test.ts>) — 投影形状回归防线（`goal` / `subagentCatalog` 的形状读错防线）。
- [projectionStore.test.ts](<projectionStore.test.ts>) — 投影值存储契约：higher seq wins、baseline 语义、低 seq 丢弃。
- [projectionIngest.test.ts](<projectionIngest.test.ts>) — 投影摄入登记表：键集合与契约双向对齐、一个键一条；执行目录开帧 / 增量 / 清空与旧水位拒绝。

### 连接与后台（supervisor / 连接条 / 队列 / 后台任务）

- [connectTarget.test.ts](<connectTarget.test.ts>) — 内部 / 外部 DSH 选路的分支组合（内部优先、外部备用须可达、目标粘性）。
- [browserSession.test.ts](<browserSession.test.ts>) — 自铸浏览器会话凭据：票名（按 authority 算的固定向量）、v1 载荷与 HMAC 口径（独立重算）、有效期上限阶梯，以及从 `.credentials.yaml` 里扫签名密钥（块作用域、记录缺失、格式非法、别的记录里的 `secret` 不误取）。
- [desktopAttach.test.ts](<desktopAttach.test.ts>) — DSH 桌面端内置服务的发现与接入：认人（命令行签名 + 可执行文件收窄）、找口（回环筛选 / 多端口逐个确认 / 四个平台解析器）、发现与鉴权的四种结论、有效期阶梯、拉起并等就绪的四档收场（就绪 / 超时 / 用户叫停 / 刚起来就退出）、启动前及发现中的取消优先于副作用和迟到成功，以及给桌面端准备的干净子进程环境（清掉 `ELECTRON_RUN_AS_NODE` 等换角色的变量）。
- [desktopOpen.test.ts](<desktopOpen.test.ts>) — 顶栏「打开 DSH 桌面端」的宿主接线（真 `ChatController`）：`desktopConnected` 的判据（归属 desktop 且这一轮已连上，其余一律保持浏览器）、切会话那一帧仍带它、点击只拉起桌面端且不动连接、起不来时给一条共享通知、没配可执行文件时不 spawn。
- [connectSnapshot.test.ts](<connectSnapshot.test.ts>) — `SupervisorManager.snapshot()` 只读快照；其中一组钉住「收掉内部连接只作废内部那一份，外部与桌面端的就绪信息留着」（`status.info.ownership` 是界面那颗「打开」按钮的判据）。
- [connectionStop.test.ts](<connectionStop.test.ts>) — 连接收场的**接线**：档位只在一个地方拼（控制器不直接调管理器的停止入口）、四个落点各走哪个收场意图、回调身份判据走轮次、两道闸归账本；另一半是管理器侧的心跳兜底顺序与 `release` 同时断与挡。
- [connectionAttempts.test.ts](<connectionAttempts.test.ts>) — 连接收场的**行为**（真 `ChatController` + 假客户端 / 假服务端）：等待中停止、换目标留着同后台占用、旧客户端迟到回调不许写状态、收场不重复 dispose、迟到完成不覆盖新连接、外部目标下停内部后台不动本窗口连接、叫停后心跳不接回、显式动作重连，以及模块面的终止顺序与「放弃一轮不动不属于它的连接」。
- [clientDispose.test.ts](<clientDispose.test.ts>) — `DshClient.dispose()` 真能停掉自己的无限重连。
- [autoConnectConfig.test.ts](<autoConnectConfig.test.ts>) — `dshChat.autoConnect` 改动即时生效、只更新自动路径的许可，不提示重载窗口，也不再触发连接。
- [autoConnectOnce.test.ts](<autoConnectOnce.test.ts>) — **自动连接只在扩展启动时做一次**（真 `ChatController` + 假客户端 / 假服务端）：重复调用只一条链、关掉不自动连、迟到的激活期选路给用户动作让位、心跳只接上（`start: false`）不拉起、改开关不触发连接、`ready` / 恢复早于激活期连接时先留着 hint 并在连上后接回历史会话；首次手动新建保存桌面端粘性目标，换端口后只接上新端点、不启动。
- [supervisorPolicy.test.ts](<supervisorPolicy.test.ts>) — 启动 / 重连决策：没许可不许拉起、复用优先；等待途中排除退场状态，启动决策遇到仍存活的退场后台不另起；停止世代绑定实际发送对象，并发合并不改记账、同代不回连而新代可接入；切桌面端立即交还内部 socket，初始发现期间停止 / 释放后的迟到结果不得启动应用或发布就绪，释放后不能复活。
- [supervisorNoRespawn.test.ts](<supervisorNoRespawn.test.ts>) — 管理器级**不被自动拉起**（真 socket 假守护进程、假启动器、隔离会合目录）：多窗口同生共死（A 窗口 `stop()` 后 B 收到 `goodbye(stop)` 且三轮心跳 0 次 spawn）、socket 瞬断只复接现有那套、后台终结后回按钮态不复活、许可与显式 `start: true` 语义不变。
- [supervisorProtocol.test.ts](<supervisorProtocol.test.ts>) — supervisor 会合协议（状态文件 / 启动锁 / socket 寻址）与运行时解析。
- [supervisorClose.test.ts](<supervisorClose.test.ts>) — 控制连接主动关闭先冲刷写队列：真 socket 验证 hello 后的 stop 完整送达，且不触发意外断线回调。
- [supervisorErrors.test.ts](<supervisorErrors.test.ts>) — 守护进程错误上报器的三条纪律（两处都发、互不影响）。
- [queueOrder.test.ts](<queueOrder.test.ts>) — 待发送队列显示形态：插话排在排队上方、带附件的行首芯片。
- [queueHover.test.ts](<queueHover.test.ts>) — 队列行实测溢出时用原生 title 展示全文，不加展开按钮或自绘浮层。
- [queueView.test.ts](<queueView.test.ts>) — 队列项视图映射：`inbox` 投影与旧线格式折算结果必须一致。
- [queueRestore.test.ts](<queueRestore.test.ts>) — 「取回重新编辑」的完整语义（真 `ChatController` + vscode stub）：摘除回显先于 RPC resolve 仍要还原、切换会话写回原会话、remove 失败不回填、**附件还原不了就整条不摘**（durable 文件缺回执 / 图片字节取不到 / 两者混合：队列与草稿原样 + 按会话提示）、纯 durable 图片完全可还原的对照、草稿追加按肯定身份去重（同名同字节不同图、同路径不同回执都不合并）。
- [jobObserve.test.ts](<jobObserve.test.ts>) — 后台任务实时输出的累积口径与面板接线。
- [jobsKill.test.ts](<jobsKill.test.ts>) — 后台任务停止按钮两段式状态机与接线 / 样式。
- [jobsOrder.test.ts](<jobsOrder.test.ts>) — 后台任务名册排序口径（官方 `ordered()`）。
- [jobView.test.ts](<jobView.test.ts>) — job 名册 / 单任务输出流 /「端点不存在」判据（0.1.7 搬运）。
- [schedule.test.ts](<schedule.test.ts>) — 自动化任务（`schedule`）：目录与编辑基准收窄 / 执行记录与变更结算 / 频率与相对时间 / 运行时间草稿与提交 / cron 方言 / 时区清单 / 接线与样式。

### 附件 / 图片 / 引用

- [pathInsert.test.ts](<pathInsert.test.ts>) — 附件归类（`classifyPath`，含**进不了内容块的图**＝ 变成文件附件 + `notInlined` 原因）+ 路径插入光标处 + `@` 目录块的整段替换（含引号空格目录的闭引号边界，真实临时文件）。
- [attachments.test.ts](<attachments.test.ts>) — 扩展名 → mediaType 纯映射、`showOpenDialog` 跨平台约束、拖放 / 粘贴两条字节通道、**图片去向**（进不了内容块改按文件上传、五项判据与整批额度、提示标记形状）、三个入口共用的 `planIntake` 与发送装配、**发送门与装配同源**（允许发送 ⇔ 文件都会进 prompt）。
- [attachmentLifecycle.test.ts](<attachmentLifecycle.test.ts>) — 附件草稿的归属、上传生命周期与**提交租约**：账本 module 的移走 / 归还 / 交接 / 释放（含越过告警阈值只记日志不销毁）与真控制器的受控 Promise 上传链（切会话结算、就绪才提交、未就绪 send 被拦、失败回填、失败行重发带真回执、窗口下线与撤回的回收口径），以及图片读取协议的缓存、升级 / 回滚重协商与非格式错误不重试。
- [attachIntakeGate.test.ts](<attachIntakeGate.test.ts>) — 附件接入的**会话门**：点附件时没有目录 / 后台未连接 / 会话未就绪三档直接拒收（连文件框都不弹）与对应提示、断线拒收通知按会话隔离（未绑定时共享）、混批一并拒收、正常空态只弹文件选择框并照旧上传、宿主 `send` 兜底重推草稿。
- [clipboardPaths.test.ts](<clipboardPaths.test.ts>) — 系统剪贴板路径读取的判据（解析、大小上限、目录粘贴、shell 顺序：7 优先以免每次粘贴付 5.1 的一秒启动）。
- [pastedImageNames.test.ts](<pastedImageNames.test.ts>) — 粘贴图片的会话内编号名（`图N.png` / `imageN.png`）：编号识别、起始编号的基线、只改图片、被拒条目不编号。
- [imageSize.test.ts](<imageSize.test.ts>) — 四种图片格式的头部宽高解析（含截断 / 0 边长 / 未知格式一律返回 undefined 的放行口径）。
- [references.test.ts](<references.test.ts>) — `@path` 引用文本的拼写规则（对齐官方 `formatFileMention`）。
- [selection.test.ts](<selection.test.ts>) — 编辑器选区 → 行号区间（「下一行行首结束要少算一行」边界）。
- [imageAttachments.test.ts](<imageAttachments.test.ts>) — 图片链路适配器侧：`attachmentId` → data URL 异步补字节。
- [imageFiles.test.ts](<imageFiles.test.ts>) — 图片地址 → 字节与保存对话框默认文件名（扩展名按真实媒体类型）。
- [imageRender.test.ts](<imageRender.test.ts>) — 会话图片渲染断言（服务端渲染出 HTML，覆盖三处来源）。
- [imagePreview.test.ts](<imagePreview.test.ts>) — 原图浮层的缩放方向 / 上下限 / 光标锚定 / 拖动边界 / 复原端口，以及滚轮、指针、右键菜单与样式的接线。
- [localImages.test.ts](<localImages.test.ts>) — 正文图片经执行世界 `stat` + 认证 `/api/file` 取字节：同形同名不读本机、根外/缺 cwd 交 Host、UNC/控制字符拒绝、权限未知不伪装删除、全部引用只限并发不截断、单图大小交 Host。

### 视图与界面行为

- [permissionIcons.test.ts](<permissionIcons.test.ts>) — 四档官方权限 SVG 的渲染断言：路径与属性指纹、Regular 描边、设计像素尺寸和权限档位接线。

- [markdown.test.ts](<markdown.test.ts>) — Markdown 安全与能力边界（DOMPurify 白名单放行 GFM 复选框、外链图片加固、Windows 反斜杠路径的链接 / 图片目标不被 CommonMark 转义吃掉）。
- [footnotes.test.ts](<footnotes.test.ts>) — 脚注 marked 扩展行为断言（真 marked + 真扩展）。
- [fileLinks.test.ts](<fileLinks.test.ts>) — 正文文件链接三段链路（判定 / DOM 落地 / 样式）。
- [linkHovers.test.ts](<linkHovers.test.ts>) — 链接悬停标题（完整路径 / 完整地址）与 HTML 文件的浏览器打开判据（扩展名白名单、Ctrl/Cmd 分流与两端接线）。
- [autoScroll.test.ts](<autoScroll.test.ts>) — `.chat-scroll` 自动滚动行为断言（真调用纯状态机）；末尾一节把阅读定位端口接到真 `AutoScrollPort` 上验「先放跟随再落位」。
- [readingPlacement.test.ts](<readingPlacement.test.ts>) — 阅读定位端口行为断言：release 在写 `scrollTop` 之前、无效目标 no-op、取历史前后各放一次、300 帧跟踪与手势让位、查找两帧等待期的手势 / 切会话 / 换元素竞争（可注入 DOM 与帧源，真调用）。
- [nodeOpen.test.ts](<nodeOpen.test.ts>) — 折叠节点展开态 + 过程折叠新口径（主动点开跑完不收回、新盒子贴底）。
- [turnProcess.test.ts](<turnProcess.test.ts>) — 连续过程折叠最终版：只留本轮最后一段正文，段内工具次数判阈值。
- [todoCollapse.test.ts](<todoCollapse.test.ts>) — 「任务清单」面板折叠：默认展开、收起只留当前执行项（没有在执行的则留最后执行过的那条；全 pending / 空清单不挂条目）、抬头箭头展开朝下 / 收起朝上。
- [turnFiles.test.ts](<turnFiles.test.ts>) — 轮尾文件两行的去重口径（交付行说了的不再重复）。
- [turnRail.test.ts](<turnRail.test.ts>) — 轮次横条数据层：`turnOutline` 投影铺底 ∪ 已加载窗口；跳转策略（首枚刻点置顶、no-op 闸门、无 running、动作全走阅读定位端口）在末节接线断言。
- [panelTitle.test.ts](<panelTitle.test.ts>) — 编辑区标签标题与窗口身份读法（不恒写 `DSH`、重载后不交叉）。
- [pathDisplay.test.ts](<pathDisplay.test.ts>) — 单行标题里路径拆分与省略口径（文件名不参与压缩），以及候选 / 「上一层」行悬停标题的完整绝对路径解析（绝对与 cwd 两侧都按根锚定语义消掉 `..`）。
- [segment.test.ts](<segment.test.ts>) — 思考档位分段控件列数（≤4 档一行、5/6 档均分两行）。
- [pickerFocus.test.ts](<pickerFocus.test.ts>) — 模型弹层「打开即定位到选中项」：起点判定、方向键移动（只走模型列表这一段）、高亮样式可见，以及「滚动只归模型列表、思考档位区常驻在滚动容器之外、模型不支持可选档位时整块（含分隔线）不渲染」的结构与样式契约。
- [toolbarFit.test.ts](<toolbarFit.test.ts>) — 工具栏档位分配、极窄保底与布局盒判据；使用可注入观察者验证节点替换、幂等挂载、StrictMode 重挂与清理，并覆盖旧生命周期的负对照。
- [connectView.test.ts](<connectView.test.ts>) — 连接条三类状态、文案与按钮矩阵。
- [contextMenu.test.ts](<contextMenu.test.ts>) — 会话右键菜单判据、「引用」落点算术、保存建议文件名；真实快捷复制处理器覆盖 Ctrl / Cmd、跨消息空白换行保真、编辑焦点、修饰键、组字、重复与已处理事件、选区包含性和空选区让路。
- [questionFlow.test.ts](<questionFlow.test.ts>) — 问卷展示口径：一次展开 vs 依次问答（`dshChat.questionBatch`）。
- [questionRender.test.ts](<questionRender.test.ts>) — 问卷卡片渲染断言（答完的问题展开后显示用户回答）。
- [toolRowRender.test.ts](<toolRowRender.test.ts>) — 工具节点渲染断言：技能节点只显示 SKILL 正文（无参数 / 输出标题），读 / 写 / 编辑与技能只在真有可打开目标时提示 Ctrl/Cmd 单击打开。
- [codeBlock.test.ts](<codeBlock.test.ts>) — 代码块默认折展：超过 20 行默认收起（含 `aria-expanded` 与完整正文），20 行及以内没有折展入口、保持展开。
- [modifierHeld.test.ts](<modifierHeld.test.ts>) — Ctrl/Cmd 全局修饰键状态：按住时给可打开文件节点加下划线的根类来源、指针事件补键盘焦点缺席、失焦 / 页面隐藏清理与引用计数卸载。
- [planReview.test.ts](<planReview.test.ts>) — 计划审阅（`exit_plan_mode`）请求的识别与收窄规则。
- [pendingInteraction.test.ts](<pendingInteraction.test.ts>) — 待处理交互的选举与抑制（官方 `registerPendingInteraction` 优先级）。
- [pendingInteractions.test.ts](<pendingInteractions.test.ts>) — `dsh/pendingInteractions.ts` 的四条内部规则（真 API 断言）。
- [presetDisplay.test.ts](<presetDisplay.test.ts>) — agent 预设展示文案折叠（内置四个走客户端词典）。
- [presetMatch.test.ts](<presetMatch.test.ts>) — 配置项 `dshChat.agentPreset` 认 id 也认显示名（中英两名、撞名取第一个、认不出原样传）。
- [mentionCandidates.test.ts](<mentionCandidates.test.ts>) — `@` 候选两条帧：文件先到先渲染、对话各自结算；判定位 `resolved` 与 `query` 同一批收下、换查询即归零；宿主下发的「上一层」行保持首行且不重复合成；工作区外筛选的五档近似与两道上限的关系。
- [fileRefListing.test.ts](<fileRefListing.test.ts>) — `@` 目录列举补全与工作区外发现：服务器 20 条上限之外的尾巴按官方同一套排序补齐、信任门关时不扩越界、绝对路径（M1）与相对 `..`（M3）的列举与档位筛选、宿主下发的「上一层」行（M2，帧内 `items[0]` 与门关不发）、不支持的根 / 盘符形态零 FS 调用，以及注入 fs 的 UNC / 符号链接段 / 盘根边界（真盘临时目录 + 真控制器）。
- [localAccess.test.ts](<localAccess.test.ts>) — 本地 FS 访问层：一条查询一条 1500ms 预算（不逐步重置）、全局未完成操作上限（挂死操作只放弃等待、槽位等底层结算）、排队者的接棒与「作废 / 预算耗尽后不启动」、作废 / 过期后的 ok 结果不写缓存，以及信任门的形态、只缓存肯定通过与「哪些路径写法不做本地解释」。
- [mentionResolve.test.ts](<mentionResolve.test.ts>) — 「光标所在的 `@` 块已经能引用到内容时不弹列表」的宿主侧判据：路径在盘上 / 带行号区间 / 对话引用 token，裸会话 id 必须照旧弹，信任门关时不凭本机 stat 抑制，盘符裸写是浏览入口且不查对话候选，不支持的根形态（`/foo`）不按 cwd 推断（真控制器 + 真盘临时目录）。
- [mentionNav.test.ts](<mentionNav.test.ts>) — `@` / `/` 补全规则集、「上一层」导航（工作区内回退、M2 宿主下发行、M3 含 `..` 的段算术与根止步、陈旧帧不掺入其候选）、`@` 块的两层判定（块认得出来 + 抑制门：浏览入口恒弹、判定说能引用就不弹；带引号空格目录解包整块）、刷新期间原地留屏（只换一次内容、留屏期间键位与点击冻结、换块与触发词消失后不复用）、焦点回到输入框算新编辑动作、目录块整段替换与候选行的悬停完整路径；斜杠链接定位草稿或插入命令后复用原生补全，无额外筛选框，官方描述双语；完整命令 / 技能块内（含名字中间与末尾、从参数区移回）不主动弹，半截前缀仍弹，显式请求例外；执行真实请求 effect 验证包装标点命令的定位、聚焦与筛选，真实 hook 与同一 nativeEvent 的 ESC 兜底链覆盖组字放行。
- [mentionLinks.test.ts](<mentionLinks.test.ts>) — 正文里 `@` 引用的判定：文件 / 目录按形状，会话按「草稿里的原始 token」或「已发出消息的 `sessionRefs` 清单」两种来路。
- [mentionLinksUi.test.ts](<mentionLinksUi.test.ts>) — 引用与目录确认的斜杠渲染成行内链接，覆盖命令筛选/技能文件打开分派、路径与会话区间排除、官方六项双语及原文回退、包装标点与路径边界、`.mention-link` 行内样式。
- [emptyComposer.test.ts](<emptyComposer.test.ts>) — 空态下 `/` 命令栏与 `@` 候选的行为级回归（空态就绑在壳上，菜单读它、不另建），以及官方命令身份与技能 Markdown 路径过线。
- [composerSend.test.ts](<composerSend.test.ts>) — 发送按钮的手势链路：按住 Ctrl / Cmd 时文字换成这一次真会走的那条路、点按钮发加速手势（真事件链 + 真 `Composer` 渲染），空闲仍发送、运行中正文与附件都没有仍是停止，只有附件也能发；**附件未就绪只置灰**（保留排队 / 插话文案、外层悬停给原因），不把生成中的发送变成停止。
- [escapeOwner.test.ts](<escapeOwner.test.ts>) — ESC 归属链：手写事件链驱动真处理器（轨迹绘图区 `timelineEscape` + window 兜底 `escapeFallbackListener`），钉住菜单 > 原图 > 抽屉 > 并列浮层的先后、元素层消费后不停止生成、**只有会话页占据前景才停止**（轨迹页与抽屉在前景时不中止会话）、兜底唯一挂点与注销清理；原生 / 合成事件组字标记均放行，不关闭浮层、不停止、不阻止输入法默认行为。
- [blankSessionReuse.test.ts](<blankSessionReuse.test.ts>) — 「空态必有壳、首条消息发给谁」：`reusableBlank` 的本地 blank 位（不许把已经说过话的会话当空壳接回来）、空壳上选的模型留得住、已经在一条空壳上再点「+」是完全 no-op（不写回模型、也不另接一条别人的壳）。
- [blankSessionNoop.test.ts](<blankSessionNoop.test.ts>) — 「点「+」」在用户 2026-10-17 21:00 口径下的行为级回归（真 `ChatController` + 假服务端）：当前已经停在一条**空壳**上时**完全 no-op**——不清输入框 / 附件 / 待发与失败回显、不改模型 / 思考强度 / 权限 / 预设 / 工作目录，不换绑定、不认领、不连后台、不发任何 RPC、不另建也不删（改过标题 / 计划 / 目标 / 挂着自动化任务、甚至断连的壳同样 no-op）；无壳 / 内容会话则照旧落壳：接回没人占用的现成空壳（同步换绑 + 一次指名认领）或真新建；空壳按窗口独占，两个窗口并发点「+」互不干扰。
- [blankPresetAdopt.test.ts](<blankPresetAdopt.test.ts>) — 空壳日志里记着的 agent 预设被删掉之后还切不切得动：接回要指名 `sessionId`、先照原样报一次预设、服务端回 not-found 时不带预设再认领一次（退回部署默认），以及已在空壳上再点「+」完全 no-op、空壳被别的窗口拿着时不共享。
- [subagentPanel.test.ts](<subagentPanel.test.ts>) — 子代理切换入口在标题上：标题点击展开「顶层会话 + 多层子代理树」，计数提示保留，当前行不可再点。
- [subagentSwitch.test.ts](<subagentSwitch.test.ts>) — 子代理页切换的行为级回归：兄弟 / 多层树任意一层都能切，目标父会话与真实模式来自血缘索引，父目录随行且回收后回填到屏；树行显示名（list-only 标题 / 真 label 优先 / 后续标题变化）、索引节点完成未读与读后消除的最后一帧 wire patch，以及旧连接迟到的父目录 / 目录 RPC 不回填索引。
- [subagentTree.test.ts](<subagentTree.test.ts>) — 子代理树的组装与界面计数：先序 / 层级、父链断开与环截断、当前会话多层后代计数、`subagentTree` 走会话状态片段。
- [subagentRowState.test.ts](<subagentRowState.test.ts>) — 子代理目录行的显示状态（生成中 / 已完成 / 可继续 / 一次性 + 状态点色调）：驻留状态的到达顺序、进出子代理页、已读位与界面口径。
- [subagentTitle.test.ts](<subagentTitle.test.ts>) — 子代理显示名：目录条目缺 label（workflow 派发的子代理）时默认显示会话标题，且来源重放 / 重新打开菜单 / 子域回收后都不退回会话 id。
- [subagentOrder.test.ts](<subagentOrder.test.ts>) — 子代理目录的显示顺序：用户消息时间（`api-session/activity` 实时来路 + `session/list` 打底）与一轮收尾取新、agent 过程消息不参与、进子代理再退出来不改变先后；血缘索引随完整列表缺席 / 普通化 / 删除 / 归档 / 连接收线清理，等待期新 catalog / status / activity 受保护，旧父节点不误删新后代，并发列表拒收先发后到的旧快照。
- [activity.test.ts](<activity.test.ts>) — 顶栏子代理 / 后台任务入口「有东西在跑」判据（只认活的那份数据）。
- [occupancy.test.ts](<occupancy.test.ts>) — 上下文占用环：常驻显示、每轮刷新、口径唯一。
- [cacheHit.test.ts](<cacheHit.test.ts>) — 会话累计缓存命中率、缺数据隐藏与工具栏 / 悬停读数同源。
- [composerMention.test.ts](<composerMention.test.ts>) — 草稿引用镜像逐字还原、可解析目标上色与文本域排版一致。
- [editorColumn.test.ts](<editorColumn.test.ts>) — 打开聊天与会话引用的标签组落点：来源组、活动组与无分组兜底。
- [sessionDir.test.ts](<sessionDir.test.ts>) — 无文件夹时标题右侧显示会话 cwd（目录名 + 所在路径），证据不足隐藏，窄栏收缩与迷你模式收起。
- [changesCard.test.ts](<changesCard.test.ts>) — 改动文件卡片三段链路（`workspace/changes` 事件 → `/api/changes.summary` → 渲染）。
- [changesDiff.test.ts](<changesDiff.test.ts>) — 本轮快照对比（`/api/changes.diff`）的 hunk 校验、两侧文本拼装与「看改动」接线。
- [produced.test.ts](<produced.test.ts>) — 「本轮产出文件」推导（`producedPath`，按成功的写类调用）。
- [fileChange.test.ts](<fileChange.test.ts>) — 执行世界存在性三态、本机附件 source 边界、创建目录权威账本优先，以及 controller / provider 不再走本机 stat / git 的接线。
- [remoteFiles.test.ts](<remoteFiles.test.ts>) — 执行世界文件访问：fake transport 驱动 stat / 分页 / 普通文件二进制 `readBytes`（offset/eof/完整性与 range 核对）/ 媒体 `/api/file`、连接关闭、权限不等于 absent、change feed 目标校验与资源地址身份。
- [binaryRpc.test.ts](<binaryRpc.test.ts>) — Connection 二进制 RPC 的 multipart 解码：附件回填、嵌套路径，以及重复字段 / 重复 part / 原型链路径 / 非 null 占位 / 多余字段整份拒绝。
- [remoteFileSync.test.ts](<remoteFileSync.test.ts>) — 只读资源观察核心的行为级回归：同版本 mtime 稳定、双 watch 引用计数、删除后 Created 恢复、权限不 Deleted、慢 stat 单飞与事件竞态、ready 补查、版本/timer 有界清理。
- [diff.test.ts](<diff.test.ts>) — `shared/diff.ts`（`diffLines` / `hunkFromTexts` / `hunksFromMeta` 等）。
- [styles.test.ts](<styles.test.ts>) — 样式不变量：`app.css` 上关键声明的文本断言，包括链接的行内布局、普通 / 悬停 / 修饰键与不可点击态覆盖顺序；声明断言不替代浏览器 computed style 验收。

### 工具行 / 工具卡契约

- [toolMeta.test.ts](<toolMeta.test.ts>) — 工具行契约事实：分类、退出码解析、`stopped` 状态。
- [toolCard.test.ts](<toolCard.test.ts>) — 工具卡数据推导：哪些工具、什么条件下给卡片。
- [toolQuestion.test.ts](<toolQuestion.test.ts>) — `ask_user_question` 问卷事实解析（参数 + 工具结果两份 durable 材料）。
- [trajectory.test.ts](<trajectory.test.ts>) — 轨迹宿主侧折叠断言（配对、压缩生命周期、轮次分组、请求编号、**请求表**——选项 / 用量含会话累计 / 请求计时 / 重试与认证失败口径、时间线接线与官方语义）。
- [trajectoryDisplay.test.ts](<trajectoryDisplay.test.ts>) — 轨迹「一行显示什么」的逐条判据（官方 `recordDisplayText` / `isToolCallOnly` 的等价物）。
- [trajectoryVendor.test.ts](<trajectoryVendor.test.ts>) — `src/vendor/` 里那几份官方纯决策模块的判据（预览投影语法、`recordId` 回退链、搜索分词 AND、时间线并发区间与模式语义、PTC 代码程序）。
- [trajectoryVirtual.test.ts](<trajectoryVirtual.test.ts>) — 账本虚拟化的窗口算术（阈值 100 / overscan 12 / 行高估计、首帧与坏输入、垫行守恒、记录下标 → 行位置的换算）。
- [trajectoryLedgerRows.test.ts](<trajectoryLedgerRows.test.ts>) — 账本布局行投影（flatten／搜索优先过滤／两种折叠／每 section 起点）的离线判据。
- [trajectoryInteraction.test.ts](<trajectoryInteraction.test.ts>) — 真实交互端口的离线判据（选择互斥／reveal 消费与收尾／pending ack／手势与清理）；模拟生命周期绿不替代首次真实 DOM 几何。
- [inspectCall.test.ts](<inspectCall.test.ts>) — 跨视图跳转「在轨迹里查看这次调用」（工具行那颗按钮的渲染与入参、轨迹侧按 `callId` 的落点判据、两端接线）。
- [localizedText.test.ts](<localizedText.test.ts>) — 服务端本地化文案的形状校验与按语言取值。

### 宿主杂项与工程防线

- [i18n.test.ts](<i18n.test.ts>) — 宿主发给 webview 的每条文案可翻 + VS Code 原生 UI 层（`hostText.ts` + l10n bundle）不漂移 + 界面按运行时字符串查表的那几处（工具自有标题）在两份词典里都有译文。
- [hostLog.test.ts](<hostLog.test.ts>) — 日志写入器在输出通道已关闭时必须活下来（防 `EADDRINUSE` 级联缺陷）。
- [configChanges.test.ts](<configChanges.test.ts>) — 配置文件热重载：`$events` 的 emit 帧 → 客户端要重读的动作。
- [invariants.test.ts](<invariants.test.ts>) — 源码级不变量：`switch` 里不得有重复 `case`。
- [manifest.test.ts](<manifest.test.ts>) — `package.json` 图标口径（编辑器标题栏「新建对话窗口」必须是鲸鱼），以及发布包白名单与 Node 版本单一来源（`.nvmrc`）。
- [windowState.test.ts](<windowState.test.ts>) — 工作区窗口状态缓存的跨重启往返语义。
- [readRange.test.ts](<readRange.test.ts>) — `read` 工具行号区间解析（meta 优先，整篇读取不标注）。
- [sessionCookie.test.ts](<sessionCookie.test.ts>) — `DshClient` 会话 cookie 语义（跨重启复用的基础）。
- [processRegistry.test.ts](<processRegistry.test.ts>) — 外部服务器令牌流程（本地 HTTP stub）+ 进程判活。
- [previewFixture.test.ts](<previewFixture.test.ts>) — `test/preview.html` 夹具体检（键重复 / 语法错让预览静默显示旧内容的防线）。

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

- [smoke.ts](<smoke.ts>) — 耗 token：端到端冒烟（连接 → 建会话 → 发消息 → 收流），dsh 演进时抓静默错配。
- [commandE2E.ts](<commandE2E.ts>) — 耗 token：斜杠命令通道 + 投影形状的契约对拍。
- [queueEscE2E.ts](<queueEscE2E.ts>) — 耗 token：ESC 中止并把队首消息发出的端到端语义。
- [supervisorReloadProbe.ts](<supervisorReloadProbe.ts>) — 零 token：R1 重载窗口不打断后台（架构核心断言）。
- [supervisorScenariosProbe.ts](<supervisorScenariosProbe.ts>) — 零 token：R2 共享 / R4 并发 / R5 自愈 / R6 可停。
- [supervisorIdleProbe.ts](<supervisorIdleProbe.ts>) — 零 token：R3 空闲退场（超时干净退场不留孤儿）。
- [supervisorChildExitProbe.ts](<supervisorChildExitProbe.ts>) — 零 token：守护进程判得出 dsh 死并自动重启。
- [supervisorErrorBridgeProbe.ts](<supervisorErrorBridgeProbe.ts>) — 零 token：守护进程 error → 窗口的协议桥（用假守护进程）。
- [supervisorManagerProbe.ts](<supervisorManagerProbe.ts>) — 零 token：扩展真正用的 `SupervisorManager` 端到端（会合 / 接入 / 心跳 / 就绪）。

### 勘察型（钉住一条线上事实，结论固化后只在重开问题时跑）

- [goalSessionProbe.ts](<goalSessionProbe.ts>) — 耗 token：goal 投影是会话级的、无目标会话开帧不给 goal 键。
- [liveOrderProbe.ts](<liveOrderProbe.ts>) — 耗 token：活路径上 tool-call-delta 先于 durable 到达的帧序。
- [modelSwitch.ts](<modelSwitch.ts>) — 耗 token：「切换模型失败」的四种操作序列复现。
- [planCommandProbe.ts](<planCommandProbe.ts>) — 耗 token：`/plan` 走命令通道、正文前缀无效。
- [pressureProbe.ts](<pressureProbe.ts>) — 耗 token：`contextPressure` 投影按轮推送且内容变化。
- [projectionSeqProbe.ts](<projectionSeqProbe.ts>) — 耗 token：投影水位（seq / asOfSeq）的线上形状。
- [queueContinueProbe.ts](<queueContinueProbe.ts>) — 耗 token：只 `cancel` 不会让队列接续。
- [queueOrderProbe.ts](<queueOrderProbe.ts>) — 耗 token：队列自动派发的落盘 / 到达帧序。
- [readRangeProbe.ts](<readRangeProbe.ts>) — 耗 token：read 工具 `result.meta` 形状与行号缀写规则。
- [sessionListProbe.ts](<sessionListProbe.ts>) — 耗 token：fork 会话在 `session/list` 里的形状。
- [systemPromptProbe.ts](<systemPromptProbe.ts>) — 耗 token：dump 真实会话的 `system/message`（几条、每轮是否重发）。
- [workspaceProbe.ts](<workspaceProbe.ts>) — 零 token：工作区分组要用 `workspaceId` 建会话（临时 DSH_HOME，成功时自清理）。
- [configReloadProbe.ts](<configReloadProbe.ts>) — 零 token：设置文档（**当前 profile 的 `cordis.patch.yml`**，不是 `$DSH_HOME/settings.yaml`）与 credentials 的外部编辑以转发帧到达客户端；改的是数组层里的 `- id:` 行，追加前必须剔掉模板的空数组 `[]`。
- [railJumpProbe.ts](<railJumpProbe.ts>) — 零 token：点轮次横条未加载刻点 → 取回用户消息 → 落位的数据侧全链路（纯离线读日志）。

### 工具型（诊断 / 取证，零 token；读取真实会话须先取得本次范围授权）

- [probe.ts](<probe.ts>) — 直连已有服务只读打印会话列表与控制流 baseline。
- [trajectoryAlignProbe.ts](<trajectoryAlignProbe.ts>) — 授权范围内的展示分类与分组对拍；分别报告应比、已比、缺失、错配、输入缺口和未比较字段。退出码 0 为已比较样本通过，1 错配、2 缺失、3 零样本、4 输入覆盖缺口、5 参数错误（不读取来源）；不得把零样本或未比较当成一致。
- [trajectoryFoldProbe.ts](<trajectoryFoldProbe.ts>) — 只量**宿主侧事件摊开／排序／派生**；历史中位 0.4ms、最大 9.5ms（452 份）不是完整载荷、传输、前端索引与渲染基准，不能据此关闭整链路性能项。
- [trajectoryGapProbe.ts](<trajectoryGapProbe.ts>) — 观察工具参数与结果的 JSON 嵌套、载荷长度及结果块分布；统计结论须明确抽取口径与分母。
- [trajectoryShapeProbe.ts](<trajectoryShapeProbe.ts>) — 观察轨迹所需 durable 字段形态与 inbox 分类输入；输出观察而非正确性断言。
- [pageLoopProbe.ts](<pageLoopProbe.ts>) — 「加载更早的历史」分页循环真实推演（只读不开写路径）。
- [panelsProbe.ts](<panelsProbe.ts>) — 只读拉取各面板依赖的接口形状（**需要一个既有会话当样本**：隔离 home 里没有会话，会以「样本不存在」失败）。
- [dumpSettings.ts](<dumpSettings.ts>) — 只读转储设置 schema JSON（设置面板设计依据）。
- [effortProbe.ts](<effortProbe.ts>) — 打印模型目录思考档位清单（排版依据）。
- [authChainProbe.ts](<authChainProbe.ts>) — 起本地 dsh 验认证链（换 cookie、列会话）。
- [cookieSurvivesRestart.ts](<cookieSurvivesRestart.ts>) — 起两次 dsh 验「cookie 跨重启有效」。
- [queueLogInspect.ts](<queueLogInspect.ts>) — 读本地会话日志取证队列时序。
- [sessionLogScan.ts](<sessionLogScan.ts>) — 会话日志体检 CLI：回答「服务端到底认为这个会话是什么状态」。
- [tailRowsProbe.ts](<tailRowsProbe.ts>) — 轮尾三样（改动卡片 / 本轮文件 / 交付文件）分布体检（离线回放）。
- [pinger.ts](<pinger.ts>) — 手工排查窗口（已收敛成 `supervisorPingerHarness` 的薄壳）。

### 探针支撑（非 CLI，供其它探针使用）

- [supervisorProbeEnv.ts](<supervisorProbeEnv.ts>) — 给无头探针完全隔离的一次性环境（supervisor 会合目录 + `DSH_HOME` 两层隔离）。
- [supervisorPingerHarness.ts](<supervisorPingerHarness.ts>) — supervisor 端到端探针共用的「窗口壳」。
- [sessionLog.ts](<sessionLog.ts>) — 会话日志解码库；字节入口消费同一快照。旧宽松入口保留兼容；夹具生成显式使用严格入口，验证完整 zstd 帧／原生解压与校验和、全帧拼接后的 fatal UTF-8、对象 JSONL。完整末行无需换行；内部完整不认证历史来源。
- [trajectoryProbeFacts.ts](<trajectoryProbeFacts.ts>) — 两条轨迹统计入口与离线测试共用的内容块抽取、JSON 形状与对拍累计器；无文件或网络访问，调用方负责输出和退出。
- [renderOrderProbe.ts](<renderOrderProbe.ts>) — 事件顺序 vs 渲染顺序并排打印（段排序问题现场工具）。
- [vscodeTestStub.ts](<vscodeTestStub.ts>) — `vscode` API 的离线 stub（esbuild alias，供 `subagentSwitch.test.ts` / `subagentRowState.test.ts` 驱动真 `ChatController`）。
- [fakeDsh.cjs](<fakeDsh.cjs>) — 探针用的假 `dsh web`：只宣布地址然后一直开着，`--hang-after` 可切「进程在、端口不响应」的卡死形态。由[子进程生死探针](<supervisorChildExitProbe.ts>)复制到临时目录后用 `node` 拉起，**不 import**；与真 dsh 一致的公告行格式、启动链与 boot 记账契约见文件头。

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

- [dshContract.ts](<dshContract.ts>) — DSH 契约快照与差异分析纯逻辑（官方契约面 × 本扩展消费面 = 影响面）。
- [dshContract.test.ts](<dshContract.test.ts>) — 上述逻辑的离线断言（版本判读、差异分级规则）。
- [dshCompat.ts](<dshCompat.ts>) — `watch`／`snapshot <版本>`／`check` 服务端契约追踪；**不覆盖官方 UI 语义**，远端版本／契约获取可能访问网络，不耗模型 token 不等于断网。
- [vendorSourceLock.ts](<vendorSourceLock.ts>)、[登记表](<vendorSourceLock.json>)、[离线回归](<vendorSourceLock.test.ts>) — 11 份官方原字节见证与 vendor 文件集合双向锁；只归一化模块说明符，保留 literal／template／regex／ASI 语义。基准为固定官方提交，不用本地 HEAD；自洽摘要不能认证历史来源。原字节见证与授权边界见[夹具索引](<../test/fixtures/README.md>)。

## 工具脚本（`*.mjs`）

- [runTests.mjs](<runTests.mjs>) — 并行跑全部离线断言（`build/*.test.mjs`），固定顺序缓冲输出（`npm test` 背后）。
- [typecheck.mjs](<typecheck.mjs>) — 并行检查宿主、webview、夹具工具与轨迹工具四个工程（`--noEmit`）；范围以各 tsconfig 的 `include` 为准，不覆盖全部历史脚本。测试执行登记另见[esbuild.scripts.mjs](<../esbuild.scripts.mjs>)的 `entries`。
- [package.mjs](<package.mjs>) — 打包 vsix：读 `package.json` 的 version，产出 `Releases/dsh-chat-<version>.vsix`（绕开 npm 在 Windows 上展开 `$npm_package_version` 失败的坑）。
- [installVsix.mjs](<installVsix.mjs>) — 安装 vsix 到本机 VS Code（顺带压掉 `code` CLI 的 `DEP0169` 弃用警告）。
- [releaseNotes.mjs](<releaseNotes.mjs>) — 抽出当前版本 CHANGELOG 作 GitHub Release 正文（找不到该节直接失败）。
- [previewServer.mjs](<previewServer.mjs>) — UI 预览静态服务器（让 Playwright 加载 `test/preview.html`）。
- [bench.mjs](<bench.mjs>) — 本地构建 / 测试耗时基准（定位开发循环里哪一步慢）。

### 一次性修复脚本

- [setDefaultModel.ts](<setDefaultModel.ts>) — 恢复默认模型设置（冒烟测试改写本机 `agent-default-model` 后的一次性还原）。
