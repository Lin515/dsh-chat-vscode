# src/dsh/ — 宿主侧（协议适配与控制）

运行环境：扩展宿主（Node 环境，可用 `vscode` 与 Node API）。
上一层的说明见 [../README.md](../README.md)。

## 会话主链路

- `controller.ts` — 会话控制器，宿主侧的核心：管理会话域生命周期、把 `shared/ipc.ts` 的界面请求接到 `adapter` / `client`，下发状态帧与 patch。
- `adapter.ts` — 聊天流适配器：把 durable 会话事件流折成「人类转写」口径的 `MessageView`（聊天流那套折叠；轨迹的账本折叠在 `trajectory.ts`）。
- `client.ts` — DSH 服务端客户端：一元 RPC、`$events` / follow 等流的 WebSocket 订阅；`DshApiError` / `DshAuthError` 区分业务与认证错误，「端点不存在」按肯定证据判定。
- `protocol.ts` — DSH 线上协议的线格式类型（依据 `docs/dsh-server-api.md` 逐字摘录，只保留客户端真正用到的字段）。
- `assistantStream.ts` — 跟随开帧里紧凑记录流（`activeAttempt`）的展开，重开 follow 时把进行中的节点重建回原始 chunk 序列。
- `scope.ts` — 会话域：一个会话的投影存储、适配器与视图装配的容器。
- `sessionView.ts` — 「一个会话在界面上的状态」的唯一生产者：字段清单只在这里（快照 / 增量 patch / 切会话整帧三处共用，避免切会话后字段静默复旧）。
- `sessionList.ts` — `session/list` 行的可见性与会话血缘（区分子代理会话与分支会话，两者都有 `parentSessionId`）。
- `sessionStatus.ts` — `api-session/status` 转发事件（服务端权威的「这一轮在不在跑」）的解码与采纳策略。
- `historyPaging.ts` — 「加载历史」的两档策略：单页档（`loadOlder`）与到目标档（`loadThrough`，轮次横条未加载刻点用）。
- `pendingInteractions.ts` — 宿主侧未结算审批 / 提问的托管账本：事件 id → 原始请求，保证去重、切会话重投、撤回收场（这类 waterfall 不是 durable 事件，必须宿主持有一份）。

## 投影（projection）

- `projectionStore.ts` — 投影值存储：每投影键当前值的权威表，seq 低的帧不能回退高的（契约逐字引官方 `ProjectionValueStore`）。
- `projectionIngest.ts` — 投影摄入：一个投影键一条登记（形状读取 + 效果），`ProjectionHandlers` 映射类型保证加键时编译期就发现漏实现。
- `projections.ts` — 投影值的形状解析纯函数（goal / subagent / todo 等；形状读错在界面上表现为「功能没有」，所以单独抽出可离线断言）。

## 视图折叠（线格式 → 视图模型的纯函数）

- `produced.ts` — 「本轮产生了哪些文件」：按成功的第一方变更调用推导，对齐官方 `mutationPath`。
- `queueView.ts` — 队列里待发送消息的视图：`inbox` 投影两代线格式折成同一个 `QueuedMessageView`（`next-turn` / `next-step`）。
- `jobView.ts` — 后台任务的线格式读取：`job` 命名空间新旧两代帧形状 + `job/follow` 单任务保留输出。
- `trajectory.ts` — 轨迹的宿主侧折叠：同一份 durable 事件的第二次折叠（账本 turn → cell，对齐官方 `dsh-client-ui-trajectory`）。
- `readRange.ts` — `read` 工具的行号区间：判定读了整文件还是片段，把行号缀在文件名后。
- `changes.ts` — 改动文件清单（`workspace/changes`）的形状校验，验不过整份丢弃。
- `fileChange.ts` — 文件改动状态判定（新增 / 删除线 / 开对比窗口还是普通打开），不依赖 git 扩展命令的静默无操作。

## 附件 / 图片 / 剪贴板

- `references.ts` — 附件模型：与官方对齐的两条路（目录 → 引用、图片 → 内容块），不再把文件正文内联进 prompt。
- `attachments.ts` — 路径 → 「附件怎么发」的归类（刻意不依赖 `vscode`，可直接单测）。
- `localImages.ts` — 正文引用的本地图片读成 data URL：路径限制在会话工作目录内（模型可控字符串当外部输入）。
- `imageBytes.ts` — 图片地址 → 字节（`data:` / `http(s):` 两种），纯逻辑可离线断言。
- `imageFiles.ts` — 「保存图片」的宿主一半：`showSaveDialog` + 写盘。
- `clipboardPaths.ts` — 从系统剪贴板读文件 / 目录的真路径（PowerShell），粘贴文件时唯一能拿到路径的地方。

## supervisor 连接链路

- `supervisorManager.ts` — 后台管理器（客户端形态）：找 supervisor、必要时拉起、保持长连接；dsh 的生死裁决权在 supervisor，扩展不杀进程。
- `supervisorClient.ts` — 扩展侧连接：读会合状态、`SupervisorLauncher` 抽象、socket 长连接（ping / 状态推送 / 告别）。
- `supervisorProtocol.ts` — supervisor 的会合协议：状态文件、启动锁、socket 寻址；文件一律原子写、读取宽容，路径由 `rendezvousPaths()` 唯一产出。
- `supervisorWire.ts` — supervisor 的 socket 协议：按行 JSON 的双向消息（hello / ping / control / 状态推送）。
- `supervisorRunner.ts` — supervisor 的真实启动器：VS Code 自带 Node 跑 `dist/supervisor.js`，detached + unref 与宿主解耦。
- `supervisorErrors.ts` — 守护进程的错误上报器：文件 + 广播两处都发，任一处炸不影响另一处。
- `runtimeResolve.ts` — supervisor 运行时：固定用 VS Code 自带的 Node（`ELECTRON_RUN_AS_NODE=1`），不依赖 PATH 上的 node。
- `connectTarget.ts` — 内部 / 外部 DSH 的选路纯函数：内部优先、外部备用且须实测可达，目标粘性（自动路径永不换目标）。

## 进程与杂项

- `processRegistry.ts` — 进程在不在、端口上有没有人听（`isProcessAlive` / `tcpReachableSync`）；历史遗留的生命周期机制已随 supervisor 架构退役。
- `dshLocks.ts` — `dsh` 自己的 writer lock 清理与 `$DSH_HOME` 定位（dsh 起不来的兜底，与后台生命周期无关）。
- `configChanges.ts` — 配置文件热重载 → 客户端要重读什么（settings.yaml / cordis.patch.yml 等 live 重载的映射表）。
- `hostLog.ts` — 扩展日志写入器：任何生命周期阶段（包括输出通道已关闭的停用期）都不得抛异常。
- `hostText.ts` — 宿主产生的 `@key` 标记 → VS Code 原生 UI 文本（通知跟随 VS Code 显示语言，与 `dshChat.language` 无关）。
- `selection.ts` — 编辑器选区 → 行号区间（部分引用要体现行号；「下一行行首结束要少算一行」的边界在这里）。
- `windowState.ts` — 工作区级会话窗口状态缓存（`workspaceState`）：记住上次每个窗口面板开着哪个会话。
