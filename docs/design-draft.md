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

## 编辑器选区随发送附带（`dshChat.autoSelection`）

按评审口径（2026-11-24）收敛后的行为：

- **事件冻结选区和目标，防抖只延迟投递**：扩展以选区事件的编辑器及主选区生成 `SelectionFacts`（文件绝对路径、行号、预览）；控制器同步冻结目标 `{ viewId, sessionId, cwdKey }` 和引用，300ms 后只投递仍匹配当前目标的那一帧，不重新读编辑器或按新目标折算。同来源、同目标的合法新事件到达后，旧芯片仅作占位、不能随发送附带；防抖结束后直接替换（不先发 `null`），若回到相同 token 和预览，则恢复原标识的发送资格，不重发展示帧。`selection` 档鼠标拖过锚点暂时为空也可保留旧芯片占位，若持续为空则在防抖结束时撤下；没有旧芯片时直接取消待投递。其他折叠、切换到不支持的编辑器、来源编辑器变化、关闭来源标签 / 文档时立即撤下行引用。`selection` 档不在启动、恢复焦点或可见性变化时重新发布旧选区；`file` 档可用整文件引用，焦点或配置变化不会复活旧行选区。
- **三档开关**：`off`（不自动附带，手动 `@` 不受影响）/ `selection`（默认，仅选中几行才显示；只有光标不显示、不退回整文件引用）/ `file`（无选区引用整个文件）。旧布尔设置按 `true → file`、`false → off` 迁移。
- **活动目标变化即清除**：切换活动窗口（`noteActiveView`）、切换会话、关闭活动窗口或改变执行目录 / 连接环境时，撤下旧芯片并使待投递选区失效。仅首次开窗可接收同执行目录的暂存选区；自动绑定同目录空会话时只更新归属，不重投选区。仅回到同一对话不清除；`ready` 只重放活动窗口的展示态（包括仍在防抖的占位），不抢跑。点 × 或发送后收起当前芯片时同时取消待投递，不因 `ready` 或防抖结束而复活；新的编辑器选区事件可产生新投递。
- **只有主动交互能切换活动窗口**：显式打开并聚焦、编辑器中的 Webview 面板从非活动变为 `active`、或者网页根节点捕获可信指针 / 键盘操作（包括侧栏空白处和键盘 / 辅助技术生成的可信点击）。`ChatViewProvider` 独占处理 `view/activity`；普通消息（包括 `ready`、轮询、确认）、侧栏或标签的可见性、初次恢复、挂载与程序化聚焦都不记活动。编辑器标题栏普通单击在当前分组打开，VS Code 原生 `Alt` 备选命令并排打开；从已有对话切到新窗口时两者都清除旧引用。
- **按目标会话的执行目录折引用**：`selectionCwd` 优先用已绑定会话的 `workingDirectory`，其次用该会话的 `cwdOf`；未绑定时取 `captureSessionTarget` 的路径。`selectionDirectoryKey` 要求有根且可用的目录路径；`relativeMentionPath` 归一分隔符及 Windows 盘符大小写，按路径段边界匹配，其他目录段大小写必须相同，不跨盘、UNC 根或 `..`。路径不匹配或目录未知就不自动附带。这里只做字面路径比较，不查文件可读性、符号链接或连接两端是否为同一个文件系统。
- **发送安全（命令不被引用改写）**：Webview 把原始正文与引用分别传给宿主（`send.autoReference` / `send.autoReferenceId`）；宿主先用原始 `text` 识别 `/xxx`，只有普通消息且没有待投递、标识和 token 均与当前展示匹配时才追加（`appendAutoReference`：正文与引用之间空一行，空正文直接是引用）。`/compact` 等命令不混进引用；命令不留回显。点 × 或发送后的 `selectionContextDismiss` 也必须匹配投递标识，旧界面帧不能影响同 token 的新投递。
- **原始草稿与提交正文分开记账**：提交记录（`SubmissionRecord`）同时记 `text`（实际提交，含当时的引用）与 `draft`（拼引用之前的草稿）。取消目录选择 / 落点被占回填的是 `draft`；队列「重新编辑」与回滚回填同样只还原 `draft`；「ESC 中止把队首重新发出」与失败行「重发」按 `text` 原样重发，保留当时附带的引用，不重取当前选区。
- **芯片显示的是发送引用**：`ui/selectionContext` 带 `{ id, token, preview }`（`null` 表示撤下）。芯片不加「已选」前缀，空间不足时从开头省略以尽量保留文件名和行号；悬停提示和发送仍使用完整 `token`（含单行 `#L12` 或带空格路径的成对引号）。悬停也会显示选区原文预览，整文件无预览时仍可查看完整引用。
- 离线覆盖：`composerSend.test.ts` 检查 send 帧，`selectionContext.test.ts` 检查折算 / 拼接 / 三档 / reducer / 芯片渲染，`selectionSend.test.ts` 驱动真控制器验证投递与发送，`editorColumn.test.ts` 驱动真 provider 验证活动信号与标签组落点；真实编辑器的选中、切面板与发送附带仍属安装端验收。

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

## 受理 ≠ 落盘：收件箱回执

`session/prompt` 回 `accepted` 只说明那句话进了服务端收件箱，**不代表它写进了会话记录**。`agent-loop` 的次序是 `turn/start` → 领取收件箱里那条 → `prepareRequest`（解析模型 / 请求配置）→ 才落盘 durable `user/message`。中间任何一步抛错，这一轮就只剩 `turn/end{reason:{kind:'error'}}`，那句人话永远不落盘——真实例子是所选模型没有对应的思考档位（`UNSUPPORTED_REASONING_EFFORT` 正抛在落盘之前）。

这类提交以前收不了场：回显只在 durable 承认时收回，于是永远停在 `sending`，界面把它画成一条正常消息、`pendingInsertIndex` 又把它甩到会话最底部。判定交给[收件箱回执](<../src/dsh/submissionReceipts.ts>)，口径与官方客户端 Session 的 `settlement.receipt` 同款：

- 入队帧记下目标与位次；领取帧把位次置 `null`；`outcome:'canceled'` 的帧是「有意丢掉」，当场交出去；
- `turn/end` / `request/context` 上仍未承认、位次还是 `null`、且回执水位更旧 ⇒ 这条提交永远到不了 durable；
- 两个事件都排在 `user/message` **之后**，正常提交到那时回执早清了，所以这条判定不会误伤已发出的消息；位次只随带水位的帧平移、水位只许前进，重连重放因此幂等。

**两条兜底**补上 durable splice 掉线时的缺口，口径对应官方 `observeSubmissionInbox` 与 `replaceWindow`：

- **`inbox` 投影**：Host 当前的两条待发队列就是完整名册。投影带水位时（`scope.projections.seqOf('inbox')`；cached 值 / 无水位时返回 `undefined`）按「存在」补回执或推进位次，之后的领取帧与轮次边界仍走同一套数学。**没有水位只跳过位次初始化**（官方 `observeSubmissionInbox` 同样不建位次，末尾的水位收显照跑）。本扩展**不凭投影存在收 chat 回显**：运行中排队发送根本不建回显，官方那一步收的是 `placement:'queued'` 的回显；把 chat 回显按队列存在收掉，会吞掉一条仍在等 durable 承认的消息。**投影里没有某条也不反推领取 / 取消**——取消只认 durable 的 `outcome:'canceled'` 帧，反推会把用户有意丢掉的那条误判成失败。
- **跟随开窗截点**：`snapshot.projections.asOfSeq` 之前已经有回执的提交，Host 已经持有；官方 `replaceWindow` 把它们按 `observed` 退回显，而不是「快照清空即 lost」。即便开窗记录里带着那一轮的 `turn/end`、或它仍排在队列里，也不许在重连时改判成失败。没有截点（缺字段 / 非数）时不做任何判断。
- **只认本客户端的提交身份**：收件箱是共享的，控制器把 `submissions` 账本作为身份边界交给适配器（`ownsSubmission`）。别的窗口 / 客户端的 rpcId 不进本地回执，因此不会触发本机的失败收场、原生提示或草稿回填。

**已承认、等水位**：durable `user/message` 先到、`inbox` 投影还停在领取之前时，回执标成 `admitted` 留在账本里，回显**延迟收起**（官方 `retireAdmittedSubmission`：`receipt.index === null` 且投影水位 `< receipt.seq`）。它不再参与失败判定；等投影推进到领取水位（或开窗截点覆盖它）后才交收显，避免队列旧行在收显之后又冒出来。适配器被回收 / 明确不再重开时，控制器调用 `flushAdmittedSubmissions` 把仍在等待的通知一次交出。

**水位取当前权威值，不取历史最高**：替换型 baseline 可以 truncate 到更低水位，适配器必须跟着降下来；跟随快照的投影块不清缺键，所以快照没带 `inbox` 时不能把 `asOfSeq` 当成 inbox 水位，保留上一次已知值（此前从未有过则仍是未知）。替换型 baseline 把 `inbox` 键清掉时，控制器必须把这次派发（`value` / `seq` 都为空）也交给适配器，否则旧的更高水位会留在适配器里、可能提前放行 admitted 的收显。

适配器重建（重连 / 单流失败重开）会丢掉它持有的回执账本，所以同一会话重开跟随流时由控制器把旧适配器的账本**原样交给新适配器**（`submissionReceipts` / `adoptSubmissionReceipts`）；这是本地提交在重连后还能按截点收场的唯一凭据。只允许同一会话、同一客户端身份搬运，跨会话 / 跨代不通用（带 `admitted` 的回执等水位逻辑也随之一并延续）。

两种收场分开走。`lost`（领走了没落盘，或用户叫停时那一轮还没落盘）**先看有没有回显**：有回显的那条按失败口径留在原地——红框、重发 / 撤回、原因 `@sendNotPersisted`，正文不回输入框；**没有回显的那条**（运行中排队发送 / 子代理会话，见 `beginSend` 的 `goesOutNow` 与 `subagentAddress` 两道门）退回 `failEcho` 注释里那条老口径：内容块（`submissions` 里提交那一刻记下的原文、附件与**原会话**）放回那条会话的输入框，并弹一次原生错误提示。提交那一刻正文与附件芯片已经被清掉，不还回去就等于静默吞掉用户那句话。回填按会话键、追加不覆盖用户新写的内容，`deliver` 镜像到同会话的每个窗口，正看着别的会话的窗口收不到（切回来那份整份快照会带上它）；正文与附件去重后，提交记录标成收场——同一 rpcId 的重复 / 迟到回执（重连重放会把入队与收网再走一遍）不再回填第二份，已被 durable 承认、被用户撤回 / 重发、被有意取消的同样不再回填。记录被 TTL / 条数上限淘汰后没有正文可还，仍报一次原生提示而不是继续静默。`canceled` 只撤回收显并释放附件租约（用户自己取消的待发消息不该变成红框失败行，也不该把正文塞回输入框）。

**排队受理不是 durable 承认**：`inbox` 投影里出现这条只证明 Host 已把它排进队列；本扩展的运行中发送不建回显，所以它**不是**任何 chat 回显的收显凭据。只有 durable `user/message`（或开窗截点证明 Host 已持有）才是承认；承认路径照旧由 `onUserMessage` 收回回显，且 durable `user/message` 先到、投影还没确认领取时按上面的水位门延后收显。回执只由 durable 事件与带水位的投影建立，两条兜底都缺失时只会漏判，不会误判。

**失败行留在原地**：回显带一枚落位锚点（`PendingMessageView.anchor`），值是提交那一刻对话流里**最后一条 durable 行**的 id。还在等承认的那条按「真实行将来落在哪」插位（`pendingInsertIndex`）；失败那条的真实行永远不会来，那条判据对它不成立——没有锚点，后一轮一开始它就被排到会话最底部（同一个现场的另一半）。锚点行不在当前窗口（翻页翻掉了、换了窗口）时退回那条判据。

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
| pendingEcho | 真控制器 + offline stub：首条迁移、直播 / 重放交接、图片借字节、失败留行、受理未落盘（含取消、已落盘不被翻案、叫停、落位锚点）、切回可操作、连点幂等、运行中不入账、queue 统一续发、命令与技能补判；inbox 投影补位、snapshot cut 收显不判失败、inbox 存在不收 chat、durable 承认等水位且先 queue patch 后收显、未知水位不补位、foreign 身份隔离、同 client 重连 / destroy 重开的回执搬运、换 client / TTL / settled 不重建、**控制 baseline 清 inbox / 降水位后 admitted 仍等待、新投影才放行** |
| submissionReceipts | 收件箱回执的纯数学：形状与占位、位次平移、水位单调与重放幂等、领取与取消的分野、两条队列互不干扰、同帧既删又插；`inbox` 投影补位 / 缺位不推断 / 无水位只跳过位次且不收 chat 回显、开窗截点按 Host 已持有收显、只认本客户端身份、`admitted` 回执按投影水位延迟收显、替换型 baseline 降水位 / 第二次 snapshot cut / 快照缺 inbox 不抬水位 / 键清空回未知、适配器重连搬运与 durable 承认优先 |
| queueRestore | 真控制器 + vscode stub：回显先到、跨会话与任一附件失败时整条保留的负面场景 |
| attachments | included 与 includedAttachments 同序 |
| selection | 编辑器选区行号区间边界，以及芯片悬停预览的归一 / 截断 / 保留缩进 |
| selectionContext | 引用按会话执行目录折算（多根 / 越界不附带）、发送拼接、三档开关（含旧布尔迁移）、归约与芯片渲染（显示即发送的 token） |
| selectionSend | 真控制器：只投递活动窗口、切换撤旧、收起后 ready 不复活、`/compact` 与带参数命令不受引用影响 |
| styles | 失败气泡、动作顺序、原因截断 |
| previewFixture | 在飞带图、failed 与 failed 带落位锚点三种形态，队列区不吃乐观回显 |

常规验证按[AGENTS](<../AGENTS.md>)，不因本文提到历史探针就自动运行真实模型测试。离线全绿不代表安装端快捷键、IPC 或全部时序已验证。
