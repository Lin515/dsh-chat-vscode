# 按下发送那一下的乐观状态（草稿 / 附件 / 回显）与提交顺序契约

> 这份文档是「输入框里那串字归谁管、什么时候被清、什么时候还回去、消息什么时候画出来、
> 失败的那条长什么样」的口径。动 `Controller.beginSend` / `submitMessage` / `send` /
> `failEcho` / `commitDraft` / `commitAttachments` / `retireEcho`、
> `webview/pendingMessage.ts` 或界面「发送」那条链路之前先读这一份。
> 2026-09-23 立：用户报的「消息发出后输入框先清空、又闪回一下、再消失」违反了第三节的顺序契约。
> 2026-09-25 三次修订：先加「按下发送那一刻就画出来」（乐观回显），随后按用户口径重定
> **失败态**（不撤回、红框 + 重发 / 撤回 + 原因）与**交接无闪烁**（见第四、五节）；
> 同一天再收窄一次：**账本只管「已经发出去」的那一类**——运行中发送（排队 / 插话）
> 一个字都不进这个账本；最后把「ESC 中止后把排队消息摘出来接着发」并进**同一条发送通道**
> （见第二节的 `source` 与第八节）。

## 一、谁拥有这些状态

- **权威表在宿主**：`ChatController.drafts` / `attachmentsBySession` / `pendingMessages`
  （都是内存 Map）。界面只持有乐观镜像（`AppState.draft` / `attachments` / `pendingMessages`），
  改完立刻渲染、不等往返。
- **同一套键**：还没有会话的窗口按 `viewId` 存，绑定会话之后按会话 id 存（`keyForView`）。
  绑定与退回空态各有一条迁移——`bindViewToSession`（窗口键 → 会话键）、`detachView`（会话键 → 窗口键）。
  草稿/附件的迁移判据是「值不是 `undefined`」（**空串也是草稿**）；回显的迁移判据是「取到数组」。
- **整份状态快照读的也是这几张表**（`snapshotFor`），所以宿主的表就是
  「界面重载 / 切会话 / 建会话之后看到什么」。

## 二、写点清单

**「把一条消息发给服务端」只有一条通道**：`Controller.submitMessage`。它有四个调用点
（用户按发送、失败行上的「重发」、ESC 中止后把排队消息接着发出去、摘不动队列时的回滚），
差别只在 `source` 这一个参数——它回答「这段内容是谁的」：

| `source` | 谁的内容 | 提交即清空输入框？ | 提交模式 |
|---|---|---|---|
| `composer` | 输入框里那份（用户按发送） | **是**（`beginSend` 于任何 await 之前清，`send` 里按会话键复述一次） | `resolveSubmitMode(按下那刻在不在跑, 手势)` |
| `retry` | 失败那一行里那份（点「重发」） | **否** | 同上（重发就是「再发一次」） |
| `queue` | 排队区里那份（ESC 后接着发 / 回滚） | **否** | 固定 `queue`（见第八节） |

`retry` / `queue` 不许碰输入框：用户此刻可能正打着另一句话、挂着别的附件，清它就是数据丢失。

| 时机 | 入口 | 动作 |
|---|---|---|
| 打字、补全选中、引用插入 | 界面 `writeDraft` | 两次写：本地 `ui/setDraft` + `setDraft` 帧（宿主持久化） |
| 按下发送（**任何 await 之前**） | `Controller.beginSend`（由 `submitMessage` 调用） | ① 铸 `requestId`；② **只在「这一刻 agent 空闲」时**写回显并推 `pendingMessages`；③ 仅 `composer`：`commitDraft` 清草稿、`commitAttachments` 清附件芯片 |
| 按下发送 / 重发（真正提交） | `Controller.submitMessage` → `send` | 连接（必要时拉起后台）→ `ensureSession` → `prompt`（带 `beginSend` 铸的 `requestId`） |
| 运行中发送（排队 / 插话） | `send` 里的 `resolveSubmitMode` + 服务端队列 | **与改动前完全相同**：不进账本、不占界面；成功由服务端队列 / 插话接管，失败走老口径（正文回输入框 + 原生提示） |
| 服务端队列里出现这一条 | `syncQueue` | 真实队列行照旧进排队区（这一层没动） |
| ESC 中止后接着发队首 | `stopRunning` → `resubmit` → **`submitMessage(source:"queue")`** | 见第八节 |
| durable 承认了这条消息 | `adapter.onUserMessage` → `noteUserAdmitted` | 按 `source.rpcId` 收回回显（服务端不回它时按正文兜底）——**落位帧之后**才发生，重放路径同样如此（`adapter.notifyAdmitted` / `flushAdmitted`） |
| 没真的发出去 | `failEcho`（有回显：行留在对话流里）、`retireEcho` + `appendDraft`（用户主动取消选目录） | 见第四节 |
| 队列项被取回编辑 / 取消 | `editQueuedMessage` / `handle("queueRemove")` | 正文回输入框（编辑）或直接丢弃（取消）——**不参与**发送通道（这些条目压根不在账本里） |
| 新建对话（`+`） | `detachView` + 整份快照 | 草稿/附件跟着**窗口**走；回显按会话键留着（失败的要能切回来接着操作） |
| 建会话 / 切会话 / 窗口就绪 | `snapshotFor` 的整份快照 | 带着当前草稿、附件与回显 |


## 三、顺序契约（坑点）

界面在按下发送那一刻就清空了自己的输入框，并立刻显示这条消息。由此推出三条不变量，
**都落在宿主**，因为只有宿主知道「这条到底发出去了没有」：

1. **「按下发送那一刻的乐观动作」必须早于任何 await。**
   `submitMessage` 里 `beginSend(...)` 排在 `ensureConnected(...)` **之前**——连接可能要拉起
   内部 DSH（秒级，第一条消息最慢），期间任何一份整份快照都会把刚发出去的正文塞回输入框
   （快照里的 `draft`/`attachments`/`pendingMessages` 读的都是宿主那几张表），把回显抹掉。
   因此 `beginSend` **必须是同步方法**（`scripts/composerDraft.test.ts` 按源码钉住这三条）。
2. **空态发第一条消息时，回显必须跟着草稿一起从窗口键迁到会话键。**
   `submitMessage` → `ensureSession` → `createSession` 在绑定窗口后会推一份整份快照，而快照里的
   回显读的是**会话键**：不迁移，那一条就被这一帧抹掉（「消息闪一下又没了」）。
   （会话也可能**在发送之前就被建出来了**——输入 `/` 或 `@` 时按需建，见 `ensureSessionForMenu`；
   那时没有迁移这一步，但清空与回显的口径不变。）
3. **没真的发出去时，界面上必须留下一条"这条没发出去"的完整记录。**
   2026-09-23 那版是「把草稿还回输入框」；2026-09-25 改成**留在原地标成失败**（见第四节）：
   正文就在那一行里，回填输入框只会变成「输入框一份 + 消息流一份」。
   唯一例外是用户**主动取消**目录选择（`ensureSession` 返回 undefined）——那不是失败，
   正文回输入框，回显收回。

## 四、乐观回显（`pendingMessages`）：只管「已经发出去」的那一类

**它解决什么**：没有它，**空闲发送**的消息要等「拉起后台 → 建会话 → `prompt` → 服务端落盘 →
follow 流推事件」整条链走完才出现在对话流里。官方的对应物是 `ISession.beginSubmission`
往会话快照里塞的 `PendingSubmission`（`dsh-api-session-controller`）。

**只收「已经发出去」的那一类**（用户 2026-09-25 口径）：按下发送那一刻 agent 空闲 ⇒
这一次会立刻 `session/prompt`，那一条就该即刻出现在对话流里（插在本轮助手行之前，
`pendingInsertIndex` 与 `adapter` 的落位分支同判据，真实行将来落在哪它就插在哪）。

| 这一条 | 归哪管 |
|---|---|
| 按下那一刻 agent 空闲（这一条真发出去了） | 进账本 → **对话流**里的一行 |
| 按下那一刻 agent 在跑（排队 / 插话：这条**还没发出去**） | **不进账本**。它唯一的去处是输入框上方的排队区，由**服务端名册**驱动（`syncQueue` 那条老路径：真实队列行 + 取消 / 编辑 / 插话）。成功走队列/插话那条老路，失败也走老口径（正文回输入框 + 原生提示）——本次改动一概不碰 |
| 失败（账本里那条） | 留在**对话流**里（红框 + 重发 / 撤回 + 原因） |

于是 `PendingMessageView` 里没有「落点」这种字段：账本里的每一条都进对话流。

**没有回显的那两档**（运行中发送那条、子代理会话）走完整的老口径：失败时正文回输入框 +
原生错误提示，子代理不收文件附件时照旧弹 toast——`failEcho` 返回「有没有一条回显被标成失败」，
调用方据此决定走哪条收场路（见 `submitMessage` / `send`）。

### 失败态（用户 2026-09-25 口径）

- **不撤回显示**：`failEcho` 只改状态，把那一行留在**对话流**里（气泡走 `--error` 描边 + 淡红底）。
- 操作行**最左侧**给「重发」「撤回」，后面写失败原因（单行 + 省略号，全文在 `title` 里）。
  动作与原因都在 `Message.tsx` 的用户消息分支里，由 `sendState` / `sendError` 驱动；
  两个动作都凭 `rpcId` 指认那一条回显（它就是 requestId），没有它就不画按钮。
- **撤回** = 删掉那一行（`retractPending`），不回填输入框。
- **重发** = 先撤回再按普通发送重走一遍（`resendPending` → `submitMessage(source:"retry")`），
  新的 requestId。撤回那一步**不单独推帧**（`removeEcho`）：紧接着 `beginSend` 会推一份带
  最终状态的，否则中间那一帧两行都不在、界面上就是重发时闪一下。连点两次是安全的：
  第二下找不到那条回显（`echoOfView` 按**调用窗口自己的键**找，别人的 id 撞上也动不了它）。
  它**不清输入框**：失败那一行的内容不是输入框里那份（见第二节的 `source`）。
- 失败原因可能是宿主发的 `@key:arg`（`@sendFailed:<服务端原文>` / `@sendNoConnection` /
  `@sendEmpty` / `@sendUnconfirmed`），界面按当前语言解析；服务端原文那一段**不翻译**。
  **有回显**的失败不弹 VS Code 原生错误框（原因就在那一行里写着，弹窗只是把同一句话再说一遍）；
  **没有回显**的那些（尚未发出的那条 / 子代理会话）走老口径，那里的弹窗照旧，日志两种情况都照旧。
- 失败的行是**纯界面对象**：宿主账本之外没有任何地方引用它，`buildPromptContent` 也从不读它
  ——所以「后续会话继续」永远不会把失败的消息带上；唯一的再发路径是那颗「重发」。
  宿主重启（内存态消失）后它才消失；**切会话再切回来仍在**（账本按会话键保留，
  `destroyScope` 刻意不动它）。
- 域回收（切走 / 新建对话 / 关窗口）**不许**替用户下结论：既不许丢（切回来还得能重发 / 撤回），
  也不许把还在飞的那条（`sending`）改写成失败——那条很可能已经发出去了，画成红框会诱导用户
  点「重发」把同一条内容发两遍。它由 live 流或重开时的 durable 承认收回，那才是权威证据。

## 五、交接为什么不会闪（五件小事，缺一不可）

1. **durable 用户行带 `rpcId`**（`MessageView.rpcId`，来自 `source.rpcId`）——回显与真实行
   的同一个身份。
2. **承认回调在落位帧之后触发**：`adapter` 先把 durable 行放进消息表**并发帧**，再
   `onUserMessage` → 收回回显。反过来的话，中间会有一帧两边都不在（那就是「闪一下」）。
   **重放路径**（follow 开窗快照 / 「加载更早的历史」）里落位帧被 `replaying` 静默压住，
   只有收尾那一份整份 `messages/reset` 才带给界面——所以那里的承认通知要**攒到 reset
   发出去之后**再补发（`notifyAdmitted` / `flushAdmitted`）。这是「按源码推不出闪烁」的那个坑。
3. **durable 行借用回显的图片字节**（`adapter.resolveEchoAttachments` → `submissions` 里那份）：
   不借的话图会从缩略图退回文件名芯片、等 `hydrateUserMedia` 换回字节再变回缩略图。
   借的时候要按**位置**对齐，而内容块里只有「真的进了块」的那些附件（文件没传完、图片没有
   可解析字节的不在），所以本地那份要先过 `includedAttachments`（与 `buildPromptContent`
   同一个判据、同一个顺序）——不过这一遍就会整体错位，把字节借给另一张图。
4. **界面按 `rpcId` 去重 + 稳定 key**：`pendingVisible` 把已被承认的回显剔掉；
   两边的 React key 都用 `p:<rpcId>`（`pendingMessage.messageRowKey`），React 复用同一个
   DOM 节点，不卸载重建。
5. **插入位置跟着落位规则走**（第四节）。服务端不回 `rpcId` 的老版本上第 4 条不成立，
   靠宿主按正文兜底收回（`retireEchoByText`），最坏多画一帧。

## 六、界面为什么不自己补一帧清空

界面只做乐观清空，**不**额外补发 `setDraft ""` 帧：那等于把顺序押在两条 postMessage 的到达
顺序上，而宿主仍可能在处理 `send` 之前推出快照（不变量落在没人守的那一侧）。
宿主侧的 `commitDraft` 是唯一入口，两处重复的清空（斜杠分支、提交补丁里的 `draft: ""`）
已经收进它；附件与回显同样各只有一个写入口（`commitAttachments` / `beginSend`）。

## 七、ESC 中止后把排队消息接着发出去（`stopRunning` → `resubmit`）

**为什么要先摘空**：只 `cancel` 不会让队列自动接续（实测结论，见
`docs/audit-input-queue-attachments.md` 的停止一节），而且中止后立刻提交的新消息会被
「abort 后唤醒」锁存，排到仍留在队列里的消息之后（顺序倒置）。做法是先整条摘空 → `cancel`
→ 等本轮真正结束（上限 8 秒）→ 按原顺序重新提交。

**重新提交走的就是第二节那条唯一通道**（`submitMessage(..., "enter", "queue", origin.content)`）——
不再自己铸 requestId、自己记 submissions、自己调 `prompt`（那会是第二条发送通道，行为与
手按发送迟早漂）。于是这一刻的两档各自落回已有口径，判据仍是**「这一刻 agent 在不在跑」**：

| 这一刻 | 它到底发出去了没有 | 表现 |
|---|---|---|
| agent 已空闲（ESC 后接着发队首，最常见） | **发出去了** | 立刻产生乐观回显、画进对话流；失败 → 留在原地标成失败（红框 + 重发 / 撤回），不弹原生框 |
| agent 还在跑（`requeue` 回滚：队列摘不动 / 等本轮结束超时） | **还没发出去** | 不进账本（唯一去处仍是排队区）；提交模式固定 `queue`；失败 → 正文回输入框 + 原生提示 + 一次提示 |

三个细节：

- **提交模式固定 `queue`**（`source === "queue"` 不参与 `resolveSubmitMode`）：回滚那次 agent
  还在跑，必须回队列，插话进正在跑的那一轮不是回滚；派发那次 agent 空闲，
  `resolveSubmitMode(false, ·)` 给的也是 `queue`，两者与改动前逐字相同。
- **内容块用当初提交的那一份**（`origin.content`）：本地提交记录不在时（扩展重载过 /
  记录被上限淘汰）这一份来自 `inbox` 投影，里面可能含内联图片字节——按文本重建会丢它们。
- **失败时只有「已摘出但还没提交」的那些**被还回输入框（`resubmit` 里 `entries.slice(index + 1)`）：
  摘不动的那条仍在服务端队列里，还回去会让同一条既在队列又在输入框。

## 八、回归门

`scripts/composerDraft.test.ts`（按源码钉顺序）：

- §0 是**对照**：用真实的 `reducer` 把「整份快照会把已提交的草稿塞回输入框」跑一遍；
- §1 钉「乐观动作早于任何 await」：`beginSend` 里必须有 `commitDraft` / `commitAttachments`
  且**不含 `await`**，`submitMessage` 里 `beginSend(` 早于 `ensureConnected(`；
- §2 钉失败路径都落到 `failEcho`（唯一例外是用户取消目录选择那条回填）、
  `try` 里的提前 return 由 `finally` 收网；
- §3 钉连不上时那一行标成失败并写明原因；
- §4 钉「谁的内容决定动不动输入框」与「发送只有一条通道」：`beginSend` / `send` 里的两处
  清空都在 `source === "composer"` 门内，重发按 `retry`、排队重发按 `queue` 且不许自己
  `prompt` / 自己记 submissions，撤回与重发都过 `echoOfView` 的所有权门，上传提示在
  `try` 之外。

`scripts/pendingEcho.test.ts`（**行为级**，驱动真 `ChatController` + offline stub）钉这些 +
纯函数与接线：回显帧早于 `session/create`、`createSession` 快照里回显仍在（迁移生效）、
**交接帧序（落位早于收回）+ durable 行带 rpcId + 图片借用本地字节**（**直播与重放两条路各一条**）、
失败留在**对话流**里且原因/状态正确且不回填草稿、**切会话再切回失败行仍在且仍是失败态**、
撤回与重发（连点幂等、重发只推一帧、**重发不许碰输入框里的草稿与芯片**、
**别人的 id 动不了别的会话那条**）、**运行中发送不进账本**（排队区拿到的仍是服务端真实
队列项、入队失败走老口径回填草稿）、**ESC 后接着发队首走统一路径**（空闲 ⇒ 产生回显 +
不清输入框；回滚 ⇒ 不进账本 + mode 仍是 queue + 失败回填；**本地无提交记录时内容块原样重发**）、
无 `rpcId` 兜底、斜杠命令不回显；
另有 `pendingVisible` / `pendingInsertIndex` / `pendingPlacement` / `pendingAsMessage` 的
纯函数断言，以及 App / Message / Composer 的接线断言（含「排队区不吃乐观回显」）。

`scripts/attachments.test.ts`：`buildPromptContent` 的 `included` 与 `includedAttachments`
同序（按下标借字节靠它，见第五节第 3 条）。

`scripts/styles.test.ts`：失败气泡走 `--error`、「重发 / 撤回」顶到最左、失败原因单行截断。

`scripts/previewFixture.test.ts`：夹具里两种回显数据形态（带图的一条在飞、`failed` 红框的一条）
都在（账本里只有已发出的那一类，所以不再有「排队中的那条不画」这一档）。
