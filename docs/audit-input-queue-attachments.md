# 输入、队列与附件：规则与差异

本文保留当前实现边界，删除已失效的历史失败清单。总览见 [审计结论](<audit-summary.md>)，实现见 [输入区](<design-composer.md>)、[草稿](<design-draft.md>) 与 [附件设计](<design-attachments.md>)。

## 提交模式与命令

- 空闲一律 queue；生成中的主手势按 `busyEnter`，Ctrl/Cmd+Enter 取相反模式，忽略按键 repeat。模式判定须在乐观置 running 之前。
- 客户端自铸 UUID requestId，服务端以同 id 幂等；durable `source.rpcId` 与队列 rpcId 用于关联。提交同时上报 clientTimeZone。
- 已认领的手打斜杠命令走 `commands/execute`，不发送给模型；未认领才走 prompt。带附件的输入仍按普通消息发送。`/plan` 进出与 pending 状态已接通，不再是待修问题。
- 行级插话已做；空草稿 + 加速手势的整队插话未做。宿主是否拦截某些快捷键不能由离线测试判断。

## 队列来源

当前队列来自 `inbox` 的 next-turn / next-step；旧服务端 queue 帧为兼容通道，两种形状通过 `queueView.ts` 分别折算。`context` 不显示。

待投递 steering 与 queued 仍合并在输入区队列条计数、可取消或取回；官方将 steering 放在对话流内。这是尚存的呈现与操作差异；取回或停止后按 queue 重发会失去插话语义。轨迹页自己的 steering 分类已实现，不能据此声称聊天队列也已对齐。

## 队列取回重编

官方是在行内提交纯文本 edit，原 id / 位置不变且丢弃附件。本扩展是 remove 成功后把正文追加进原草稿、附件放回芯片；重发进入队尾，不是原位编辑。

`editQueuedMessage` 的必要顺序：

1. await 前捕获原文、附件、原会话与草稿键；队列回显允许早于 remove RPC resolve，并会重建来源索引。
2. 先生成完整还原计划、取齐 durable 图片字节；任一附件还原失败则整条不摘，队列、索引与草稿均不动，提示 `@queueAttachmentsLost`。
3. remove 成功后才回填。失败不改草稿；await 期间切会话仍写原会话草稿，通知不越会话。

只按肯定身份去重：同 id、同上传回执、同 durable 句柄或同图片字节。不能按名称猜同一附件。回归见 `queueRestore.test.ts`，使用真实控制器与 vscode stub，覆盖回显先到、跨会话与整条保留的负面场景。

### 重载与缓存边界

本地提交缓存 TTL 30 分钟、最多 50 条；淘汰后回退权威内容块。

- durable 图片有 attachmentId / mediaType / bytes / name，可经 `session/attachment` 恢复；纯图片项仍可完整取回。
- durable 文件只有字节 sha256，没有发送所需上传回执；不能伪造不可发送的文件芯片。碰到文件块或取不到图片字节，整条留队。
- 长会话或重载后的带文件项可能无法取回；需先备好正文与完整附件，再取消旧项重发。

## 上下文与附件

- 文件引用是正文 `@path`；上传原始文件后只提交 receiptId，不内联全文。目录写成 `@目录/`。
- 会话 token 在进入模型前变成快照，durable 正文折成 `@标题`。id 位于紧随其后的 session-reference 召回事件，按 seq - 1 关联到用户消息；复制与提问预览用可读标题，不能把它误判为路径。
- 编辑器选区是扩展独有的内联代码快照，无官方对应形态；它不是持续跟踪的路径引用，发送前源文件变化不会刷新快照。
- 文件块能否进入 prompt 只看 ready 上传回执，不要求 path。路径与字节入口共用装配，避免“上传成功却没发送”。
- 扩展文本块在图片前，官方附件在文本前；这是线格式差异，不推测所有模型的效果。
- 纯附件发送仍被 Composer 的非空正文判定挡住；宿主能装配附件，不代表 UI 已开放该入口。

## 拖放与粘贴

`attachIntake.ts` 在页面级接收 paste / drop。不要在 webview keydown 抢 Ctrl+V：VS Code 先处理按键，再补发 paste，提前拦截会破坏通道。

Windows 剪贴板路径由宿主 `clipboardPaths.ts` 读取（WinForms GetFileDropList，5 秒超时）：目录转引用，文件进路径附件通道；取不到路径才读字节。非 Windows 仅字节回退。

桌面 webview 不提供可靠 OS 拖放路径：历史实测 uri-list / plain 为空，Electron 32+ 不再提供 File.path；目录 File 无法读出字节。因此拖放目录只提示，不创建附件；文件字节通道单文件 8 MB。VS Code iframe 拖放还需 Shift 手势。

仍未对齐：图片数量 / 总量 / 像素的整批预检、上传进度；路径通道的文件存储不受字节 IPC 的 8 MB 门槛约束。

## 停止与队列

官方只 cancel 并保留 FIFO 待办；本扩展摘空可重发队列 → cancel → 等空闲（8 秒）→ 按序统一提交。

原因与历史证据：`queueContinueProbe.ts` 两輪各 3 次仅 cancel 均未续跑；cancel 后新消息唤醒旧队列分别 0/3、3/3，不稳定，不写硬断言。重新运行需用户当次明确批准。

该流程有多 RPC 失败窗口，不是事务。重发失败由统一发送路径收场，后续未提交项回草稿；回滚尽力重排，不保证崩溃安全、绝不丢失或重复。完整风险见审计结论的「停止语义」。
