# src/dsh/ — 宿主侧协议与控制

扩展宿主环境，可用 vscode / Node API；上层边界见[源码导航](<../README.md>)。本页只定位职责，规则见[设计与契约](<../../docs/README.md>)。

## 会话主链路

- [controller.ts](<controller.ts>) — 会话域生命周期、IPC 接线、状态合流、单流失败重开与回调身份守卫。
- [adapter.ts](<adapter.ts>) — durable 事件折为聊天 MessageView。
- [client.ts](<client.ts>) — RPC / WebSocket 流；业务、认证与端点不存在的错误分类。
- [protocol.ts](<protocol.ts>) — 客户端消费的线格式类型。
- [assistantStream.ts](<assistantStream.ts>) — activeAttempt 紧凑记录展开与重开 follow 恢复。
- [scope.ts](<scope.ts>) — 会话投影、适配器与视图装配容器。
- [sessionView.ts](<sessionView.ts>) — 会话视图字段唯一生产者，快照 / patch / 切会话共用。
- [sessionList.ts](<sessionList.ts>) — 工作区 / 窗口 cwd 可见性与子代理、分支血缘。
- [sessionStatus.ts](<sessionStatus.ts>) — api-session/status 的解码与采纳。
- [sessionActivity.ts](<sessionActivity.ts>) — api-session/activity 的解码（子代理目录排序里「用户消息」的实时来路）。
- [historyPaging.ts](<historyPaging.ts>) — 单页 loadOlder 与到目标 loadThrough。
- [inboxClaim.ts](<inboxClaim.ts>) — next-step 领取账本，提问 / steering 的共同判据。
- [submissionReceipts.ts](<submissionReceipts.ts>) — 提交在服务端收件箱里的回执：判定「受理了却没落盘」。
- [pendingInteractions.ts](<pendingInteractions.ts>) — 非 durable 审批 / 提问的托管、去重、重投与收场。

## 投影与视图折叠

- [projectionStore.ts](<projectionStore.ts>) — seq 单调的权威值表，见[投影设计](<../../docs/design-projections.md>)。
- [projectionIngest.ts](<projectionIngest.ts>) — 投影键的形状读取 / 效果唯一登记。
- [projections.ts](<projections.ts>) — goal / subagent / todo 等形状解析纯函数。
- [subagentOrder.ts](<subagentOrder.ts>) — 子代理目录的显示顺序（用户消息与一轮收尾取新，过程消息不参与）。
- [subagentTree.ts](<subagentTree.ts>) — 跨域血缘索引到多层子代理树的先序组装（第 1 层与顶层会话同级，父链断开 / 环不画错）。
- [produced.ts](<produced.ts>) — 成功第一方变更调用产生的本轮文件。
- [queueView.ts](<queueView.ts>) — 两代队列形状、附件还原计划与肯定身份去重；不可还原时禁止摘队列。
- [jobView.ts](<jobView.ts>) — 任务新旧帧与单任务输出。
- [scheduleView.ts](<scheduleView.ts>) — 自动化任务的目录 / 执行记录 / 变更结果读取，以及编辑基准（`expected`）的字段投影。
- [trajectory.ts](<trajectory.ts>) — 同份 durable 的账本 / 请求表折叠；身份、时序与验收边界见[轨迹设计](<../../docs/design-trajectory.md>)。
- [trajectoryBackfill.ts](<trajectoryBackfill.ts>) — 窗口没带进 `request/header` 时按需回补更早事件（判据 + 循环）。
- [readRange.ts](<readRange.ts>) — read 工具的整文件 / 片段行号区间。
- [changes.ts](<changes.ts>) — workspace/changes 形状校验。
- [changesDiff.ts](<changesDiff.ts>) — 本轮改动的逐文件对比（hunk 校验与两侧文本拼装）。
- [agentDiffDocuments.ts](<agentDiffDocuments.ts>) — 「Agent 改动」对比窗口的只读虚拟文档。
- [fileChange.ts](<fileChange.ts>) — 执行世界文件存在性分类（只有 Host not-found 才算已删除）、本机附件 source 的路径解析，以及创建目录「权威账本优先」的纯判据；不查本机 git。
- [binaryRpc.ts](<binaryRpc.ts>) — Connection 二进制一元 RPC 的 multipart 响应解码（metadata 信封 + 字节附件回填，坏形状整份拒绝）。
- [remoteFiles.ts](<remoteFiles.ts>) — 执行世界文件访问的唯一边界：`workspaceFiles.stat` / 分页 `read` / 普通文件二进制 `readBytes`、媒体认证 `/api/file`、连接身份、错误三态与有界 change feed。
- [remoteFileAddress.ts](<remoteFileAddress.ts>) — 资源 URI 的「连接 + 会话 + 路径」编码与 basename（纯字符串）。
- [remoteFileSync.ts](<remoteFileSync.ts>) — 资源观察核心（不依赖 vscode）：版本→稳定递增 mtime、同 URI 引用计数、删除后保留观察并可恢复、单飞轮询与有界表。
- [remoteFileSystem.ts](<remoteFileSystem.ts>) — VS Code 只读虚拟文件系统 provider：按原连接 id 解析、普通文件走二进制 RPC、change feed + 有界 restat。
- [localImages.ts](<localImages.ts>) — 正文图片经执行世界读取成 data URL；全部引用都处理（只限并发），不设创建目录/扩展名/本地字节授权门，UNC 与控制字符在客户端拒绝。

## 附件、引用与图片

- [references.ts](<references.ts>) — 附件与引用模型，不内联文件正文。
- [fileRefListing.ts](<fileRefListing.ts>) — 本地目录列举：工作区内空查询 / 尾斜杠的尾巴补全，以及信任门通过后的工作区外发现（M1 绝对路径 / M2 根目录「上一层」行 / M3 相对 `..`）；逐段拒绝符号链接段，不支持的根 / 盘符形态（单根相对、驱动器相对、设备命名空间）在纯字符串判据处就拒绝。
- [localAccess.ts](<localAccess.ts>) — `@` 发现的本地访问层：一条查询一条有界预算、全局未完成 FS 操作上限，cwd 原生形态 + 本机目录证据组成的信任门（只缓存肯定通过），以及「哪些路径写法不做本地解释」的形态判据（`unsupportedLocalPathForm`）。
- [attachments.ts](<attachments.ts>) — 接入分类、限额、去重与内容块；进不了内容块的图片在这里判为「按文件上传」（`notInlined` 记原因），见[附件设计](<../../docs/design-attachments.md>)。接入会话门（没有会话整批拒收）与宿主 `send` 兜底在 `controller.ts`。
- [attachmentLifecycle.ts](<attachmentLifecycle.ts>) — 附件唯一归属表、上传轮次与提交租约。
- [attachmentOpen.ts](<attachmentOpen.ts>) — 打开附件的临时副本命名 / 落盘与内容身份索引。
- [attachmentOpenStore.ts](<attachmentOpenStore.ts>) — 同一条「内容身份 → 本地路径」的持久化口径（`globalState`，跨宿主重启；原文件与临时副本分开记）。
- [imageBytes.ts](<imageBytes.ts>) — data / http(s) 图片到字节。
- [imageSize.ts](<imageSize.ts>) — 图片头部（png / jpeg / webp / gif）的宽高读数，供服务端的像素与单边准入预检。
- [imageFiles.ts](<imageFiles.ts>) — 保存图片对话框与写盘。
- [clipboardPaths.ts](<clipboardPaths.ts>) — Windows 系统剪贴板文件 / 目录真路径。

## supervisor 连接链路

生命周期与按钮规则见[supervisor 设计](<../../docs/design-supervisor.md>)。

- [supervisorManager.ts](<supervisorManager.ts>) — 指定目标的连接管理；进程生死由 supervisor 裁决。
- [supervisorClient.ts](<supervisorClient.ts>) — 会合状态、启动器抽象与 socket 长连接。
- [supervisorProtocol.ts](<supervisorProtocol.ts>) — 原子状态文件、启动锁、socket 寻址与统一解码。
- [supervisorWire.ts](<supervisorWire.ts>) — 按行 JSON 的 hello / ping / control / 状态协议。
- [supervisorRunner.ts](<supervisorRunner.ts>) — VS Code Node 的 detached + unref 启动器。
- [supervisorErrors.ts](<supervisorErrors.ts>) — 互不阻断的文件 / 广播错误上报。
- [runtimeResolve.ts](<runtimeResolve.ts>) — VS Code 自带 Node 定位，不依赖 PATH。
- [connectTarget.ts](<connectTarget.ts>) — 内部优先、外部备用、桌面端可连接，以及目标粘性。
- [connectionAttempts.ts](<connectionAttempts.ts>) — 轮次、客户端身份、四种收场意图与创建 seam。
- [browserSession.ts](<browserSession.ts>) — 自铸浏览器会话凭据（名字推导、票构造、密钥扫描）。
- [desktopSession.ts](<desktopSession.ts>) — 桌面端内置服务的认人（命令行签名）与找口（回环端口）。
- [desktopAttach.ts](<desktopAttach.ts>) — 桌面端发现四步的编排、有效期阶梯、拉起并等就绪。

## 进程与杂项

- [processRegistry.ts](<processRegistry.ts>) — 进程与 TCP 可达性查询。
- [processTable.ts](<processTable.ts>) — 进程命令行与监听端口查询（含四个平台的解析器）。
- [dshLocks.ts](<dshLocks.ts>) — writer lock 清理与 DSH_HOME 定位。
- [configChanges.ts](<configChanges.ts>) — 服务端配置热重载到客户端重读的映射。
- [hostLog.ts](<hostLog.ts>) — 包括停用期也不抛异常的宿主日志。
- [hostText.ts](<hostText.ts>) — @key 到原生 UI 文本，跟随 VS Code 语言。
- [selection.ts](<selection.ts>) — 编辑器选区行号边界。
- [windowState.ts](<windowState.ts>) — workspaceState 会话窗口缓存。
- [unreadStore.ts](<unreadStore.ts>) — 每会话一个 globalState 键的未读存储。
- [notificationQueue.ts](<notificationQueue.ts>) — 宿主权威的消息通知队列（合并 / 确认 / seq 水位 / 容量；不 import vscode、不落盘）。
