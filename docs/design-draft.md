# 发送、草稿与队列：提交顺序和恢复边界

修改 `beginSend` / `submitMessage` / `send`、草稿迁移、队列取回、停止续发或 `pendingMessage` 前读本文。附件归属见[附件设计](<design-attachments.md>)，按钮与快捷键显示见[输入区设计](<design-composer.md>)，计划状态见[投影设计](<design-projections.md>)。

## 状态归属

宿主的 drafts / pendingMessages 内存 Map 是权威表，附件由 `attachmentLifecycle` 管理；界面持乐观镜像。`snapshotFor` 读取这些表，因此它们决定切会话、重载界面、建会话后看见什么。

- 未绑定窗口按 viewId，绑定后按 sessionId。`bindViewToSession` 与 `detachView` 负责迁移。
- 草稿以值不是 undefined 为迁移判据，空串也是草稿；附件有记录就搬，空表也搬，两份相遇合并；回显按数组迁移。
- 新建对话先同步切空态，再后台落壳；已有空壳可零往返切换。草稿 / 附件跟窗口走，失败回显按会话键留着。
- 这些表不是落盘持久化：宿主重启会丢内存态，切会话或回收域不能擅自丢失败行或把在飞行标成失败。

## 提交模式与命令

- 空闲一律 queue；生成中的主手势按 `busyEnter`，Ctrl/Cmd+Enter 取相反模式，忽略按键 repeat。模式判定须在乐观置 running 之前。
- 客户端自铸 UUID requestId，服务端以同 id 幂等；durable `source.rpcId` 与队列 rpcId 用于关联。提交同时上报 clientTimeZone。
- 已认领的手打斜杠命令走 `commands/execute`，未认领才走 prompt。带附件仍按普通消息发送；技能不在命令目录，也是用户消息。`/plan` 进出与 pending 已接通，不是待修问题。
- 行级插话已做；空草稿 + 加速手势的整队插话未做。宿主是否拦截某些快捷键不能由离线测试判断。

## 唯一发送通道

所有真正提交走 `submitMessage`，内容来源决定是否清输入框：

| source | 来源 | 清草稿 / 芯片 | 提交模式 |
|---|---|---|---|
| composer | 输入框 | beginSend 同步清空，send 按会话键复述 | 当下运行状态 + 手势 |
| retry | 失败行重发 | 不清，用户可能在写另一条 | 当下运行状态 + 手势 |
| queue | ESC 后续发或回滚 | 不清 | 固定 queue |

队列取回编辑与取消不参与回显账本。界面写草稿同时更新本地与宿主，但按发送时不额外 post `setDraft ""` 押注两条 IPC 的顺序；清空唯一入口是 `commitDraft`，附件是 `commitAttachments`，回显是 `addEcho`。

## 顺序契约

1. `beginSend` 必须同步且在任何 await（尤其 ensureConnected）之前铸 requestId、更新回显与 composer 草稿 / 附件。否则连接 / 建会话期间快照会把已清草稿塞回、把回显抹掉。附件的**来源是宿主账本**（`send` 帧不再回传 `Attachment[]`：图片的 `dataUrl` 是几 MB 的 base64，回传等于让它再走一趟单程），取账本就在这一步，早于 `commitAttachments` 把芯片移进租约。
2. 首条消息落壳时，回显与草稿一起从窗口键迁到会话键；快照读会话键，漏迁移就会闪失。空态通常已有真会话，但 ready 前抢发与发送时选目录仍可能走这条窄路。
3. 真提交失败保完整失败行，不再复制回输入框。唯一主动取消目录选择例外：回收回显并归还草稿。

## 回显判据

回显只管「当下 agent 空闲，且内容会作为用户消息提交」的那类，不代表服务端已承认：

| 情形 | 归属 |
|---|---|
| 空闲用户消息 | 对话流 pendingMessages，插在真实用户行将来的位置 |
| 运行中排队 / 插话 | 不进账本，仅服务端队列区；失败归还正文并原生提示 |
| 真斜杠命令 | commands/execute，不回显 |
| 子代理发送等无回显路径 | 失败沿既有正文回填与原生提示 |

斜杠判断按会话 commandCatalog，不按 `/` 外观。正文普通 / 带附件立即回显；目录已加载时按目录判；无壳或未加载目录时不猜，send 落壳确认非命令后、prompt 前补 `addEcho`。补判看这个 requestId 是否已有回显，不能画第二条。

## 失败态与重发

- failEcho 留原行，红框 + 最左重发 / 撤回 + 单行失败原因，全文在 title。以 rpcId 指认；无 rpcId 不画动作。
- 撤回只删行，不回填；重发先静默 removeEcho，再 `submitMessage(source:"retry")` 铸新 requestId。中途不推两行都不存在的帧，连点第二次找不到旧行即空操作。
- `echoOfView` 按调用窗口自己的键检查所有权，不能操作别的会话同 id；retry 不清当前输入框 / 芯片。
- @key 原因按界面语言解析，服务端原文不翻译。有失败行时不重复弹原生错误框；无回显时保原生提示，日志两者都保留。
- 失败行是纯界面对象，buildPromptContent 不读取它，后续继续不会自动带它；只有重发会再次提交。回收域不替在飞提交下失败结论，防用户重发造成重复。

## durable 交接无闪烁

1. durable 用户行带 source.rpcId → MessageView.rpcId，和回显同身份。
2. adapter 先落位并发帧，再通知 onUserMessage 收回回显。重放压住增量帧时，把承认通知攒到 messages/reset 之后（notifyAdmitted / flushAdmitted）。
3. durable 行暂借本地图片字节，避免缩略图退成芯片再复原。先按 `includedAttachments` 过滤，与 buildPromptContent 同判据 / 顺序后按位置对齐，不能借给另一张图。同一次提交的本地路径一并借给图片与文件块，文件块另带上内容块里的 durable 句柄——附件芯片据此可以单击打开本地那一份（见[附件设计](<design-attachments.md#打开附件>)）；图片缩略图本身单击出来的是原图浮层。
4. pendingVisible 去重，两边 React key 均为 `p:<rpcId>`，复用 DOM；pendingInsertIndex 与 adapter 落位规则一致。
5. 老服务端不回 rpcId 时宿主按正文退回兜底（retireEchoByText），最坏多画一帧，不能假称相同身份交接。

## 队列来源与有意差异

当前队列来自 `inbox` 的 next-turn / next-step；旧 queue 帧为兼容通道，两种形状通过 `queueView.ts` 分别折算，context 不显示。

待投递 steering 与 queued 合并在输入区队列条计数、可取消或取回；官方将 steering 放在对话流内。取回或停止后按 queue 重发会失去插话语义。这是尚存的呈现与操作差异；轨迹页自己的 steering 分类已实现，不证明聊天队列也已对齐。

## 队列取回重编

官方是在行内提交纯文本 edit，原 id / 位置不变且丢弃附件。本扩展是 remove 成功后把正文追加进原草稿、附件放回芯片；重发进入队尾，不是原位编辑。保留附件与原草稿是有意取舍，不能顺手改成官方 edit。

`editQueuedMessage` 的必要顺序：

1. await 前捕获原文、附件、原会话与草稿键；队列回显允许早于 remove RPC resolve，并会重建来源索引。
2. 先生成完整还原计划、取齐 durable 图片字节；任一附件还原失败则整条不摘，队列、索引与草稿均不动，提示 `@queueAttachmentsLost`。
3. remove 成功后才回填。失败不改草稿；await 期间切会话仍写原会话草稿，通知不越会话。

只按肯定身份去重：同 id、同上传回执、同 durable 句柄或同图片字节。不能按名称猜同一附件。

### 重载与缓存边界

本地提交缓存 TTL 30 分钟、最多 50 条；淘汰后回退权威内容块。

- durable 图片有 attachmentId / mediaType / bytes / name，可经 `session/attachment` 恢复；纯图片项仍可完整取回。
- durable 文件只有字节 sha256，没有发送所需上传回执；不能伪造不可发送的文件芯片。碰到文件块或取不到图片字节，整条留队。
- 长会话或重载后的带文件项可能无法取回；需先备好正文与完整附件，再取消旧项重发。

## ESC 后队列续发

官方只 cancel 并保留 FIFO 待办。本扩展仅 cancel 不保证队列继续，abort 后马上提交还可能排到旧队列后；`stopRunning` 捕获原 content、顺序摘空 → cancel → 等真空闲（最多 8 秒）→ 原序 `submitMessage(...,"enter","queue",origin.content)`，不自建第二条 prompt 路径。

- 空闲续发产生回显，失败保红行；仍运行的回滚固定 queue，不插话，失败归还正文并提示。
- origin.content 取本地提交记录，否则 inbox 内容块；按文本重建会丢图片。
- 摘失败或空闲超时回滚，提交失败时只归还已摘出且尚未提交的余项；未摘项还在服务端，不能再复制一份草稿。
- 这不是事务：摘队列、cancel、等待和逐条提交之间有多 RPC 失败窗口与竞态。回滚尽力重排，不承诺崩溃安全、绝不丢失或重复；插话项重发为 queue 仍是语义差异。

### 决策证据与重评边界

`queueContinueProbe.ts` 两轮各 3 次仅 cancel 均未自动续跑；cancel 后新提交是否唤醒旧队列分别为 0/3 与 3/3，是不稳定观察，不能写硬断言或推广为所有版本保证。探针已登记构建入口，重跑须当次批准。目标版本队列调度改变时重新取证，不凭历史分布改停止行为。

## 回归门

| 测试 | 覆盖 |
|---|---|
| composerDraft | 真 reducer 快照负对照；beginSend 无 await 且早于连接；统一清空 / 失败入口；source 门与窗口所有权 |
| pendingEcho | 真控制器 + offline stub：首条迁移、直播 / 重放交接、图片借字节、失败留行、切回可操作、连点幂等、运行中不入账、queue 统一续发、命令与技能补判 |
| queueRestore | 真控制器 + vscode stub：回显先到、跨会话与任一附件失败时整条保留的负面场景 |
| attachments | included 与 includedAttachments 同序 |
| styles | 失败气泡、动作顺序、原因截断 |
| previewFixture | 在飞带图与 failed 两种形态，队列区不吃乐观回显 |

常规验证按[AGENTS](<../AGENTS.md>)，不因本文提到历史探针就自动运行真实模型测试。离线全绿不代表安装端快捷键、IPC 或全部时序已验证。
