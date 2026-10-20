# 附件与引用接入设计

修改添加文件、拖放、粘贴、上传或目录引用前读本文。队列还原与提交时序见[发送设计](<design-draft.md>)，补全查询见[引用设计](<design-mentions.md>)；上传契约见[API 参考](<dsh-server-api.md>)。平台证据取自 VS Code 1.138 的既有实测，不代表所有版本。

## 三个入口、一条管线、三种落点

按钮、拖放、粘贴共用 `attachments.ts` 的纯函数 `planIntake`，由 `controller.ts` 的 `ingestAttachments` 执行：

- 文件 → 上传，提交 `{type:"file",receiptId}`。
- 图片 → 内容块 `{type:"image",mediaType,data}`。
- 目录 → 正文 `@dir/` 引用，不是附件、不占芯片。

`IntakeItem` 分有真路径的 `from:"path"` 与只有名字 / 字节的 `from:"bytes"`。路径通道来自宿主文件对话框或系统剪贴板，无 8 MB 限制；webview 字节通道经 base64 的 `attachBytes` 帧，单文件限 8 MB。

## 入口矩阵

| 入口 | 非图片文件 | 模型收图且未超内联上限 | 目录 | 读不出 / 0 字节 | 超过 8 MB |
|---|---|---|---|---|---|
| 添加文件 | 上传芯片 | 图片内容块 | Windows/Linux 不返回目录；macOS bundle / 目录联接转引用 | 引号路径插到光标处 | 路径通道不受限 |
| 拖放 | 字节上传 | 图片内容块 | 无真路径，不支持并提示 | `@dropUnreadable` | `@dropTooLarge` |
| Windows 粘贴文件 | 路径上传 | 图片内容块 | `@dir/` | 无路径时回退字节通道 | 路径通道不受限 |
| 截图 / 非 Windows 粘贴 | 字节上传 | 图片内容块 | 不支持并提示 | `@pasteUnreadable` | `@pasteTooLarge` |
| `@` 候选 / 资源管理器 / 选区 | 正文引用 | 正文引用 | `@dir/` | 不适用 | 不适用 |

同一份输入在不同入口应有同一落点，通道能力差异除外：

- 图片判据 MIME 优先、后缀兜底，仅 png/jpeg/webp/gif；表外 `image/*`（bmp/svg 等）上传为文件。
- **图片进不了内容块时按文件上传**（附件变文件、立即上传），**不**用正文里的 `@` 引用当退路。五项判据（内联字节 `maxImageBytes`、像素 `maxImagePixels` 默认 64,000,000、单边 `maxImageDimension` 默认 8192、张数 `maxImagesPerMessage`、单条消息图片总字节 `maxMessageImageBytes`）在接入那一刻判：像素与单边按**图片头部**读数（`imageSize.ts`，四种格式都在固定偏移上，不解码整图；读不出来就放行），张数与总字节是**整批**判据，连同草稿里已有的图片一起算；顺序与服务端一致（先像素、后单边）。
  为什么退路是上传而不是引用：`@` 引用只在**模型的执行世界能读到那个路径**时成立，而会话是用本地工作区路径当 `cwd` 建的——同机 DSH 成立，容器 / 另一台机器上那个路径根本不存在，用户却会看到「已改为 @ 引用插入」。上传副本不受这个假设约束（字节是搬过去的，宿主自己把句柄路径解析到执行世界），还是快照（本地文件之后被移动 / 删除都不影响）并按 sha256 去重。官方 `dsh web` 的做法是越限**整批拒**（`InputBar.intakeFiles`：「refused … and never enters the rail」），本扩展多给一个副本，因为文件通道**没有任何准入限制**（`AttachmentStore.saveFile` 的契约原文 "Files carry no admission limits: any byte content and length is accepted"）。
- 提示一律报**上限**：像素按语言缩写成「6400万」/「64M」，**不报这张图的实际像素数**（位数量级对用户没有指导意义）；单边是分辨率，报具体数字；张数与总字节各报自己的数，总字节额外报「已用多少」。后半句照实说副本能不能被模型直接读：**逐图**超限（内联字节 / 像素 / 单边）的副本模型也得先缩小才能 `read_image`；**整批**超限（张数 / 总字节）的副本单张本来就在限内，模型可直接读取。
- 模型不收图是**整批**原因（这一批里每一张都进不了内容块），汇总成一条 `@imageFilesUploaded:<张数>:<模型名>`，不按条目刷屏。
- 路径按现有列表去重；字节条目没有可靠身份，不按名字去重。
- 对话框固定 `canSelectFiles:true, canSelectFolders:false`；Windows/Linux 两者都开会变成目录选择器。
- 0 字节由界面与宿主两层拒绝，不能把目录载荷当成空文件附件。纯文本粘贴不进附件流程。
- 粘贴进来的图片在发帧前按**会话内序号**命名：中文界面 `图N.png`、英文界面 `imageN.png`，后缀沿用条目自己的写法。0 字节与超过 8 MB 的条目不编号——它们会被拒，提示里必须报用户认得的原名。名字**不是磁盘文件名**：图片按内容摘要落进附件存储，同名不冲突，编号只为人在对话里指代。
  - 基线取已加载用户消息、乐观回显与草稿芯片里的最大编号（两种前缀都认，切语言不撞号）。图片降级为文件时，编号主干与图片后缀同时匹配的文件名也参与基线，普通文件不占号。
  - 本窗口按会话保留已分配最大编号，A → B → A 不回收已删芯片的编号，连续快粘也不依赖回帧；尚未绑定会话的空态编号在首次绑定时迁移，已绑定会话退回新空态时归零。
  - 最多保留 256 个最近访问的已编号会话，窗口销毁释放；超过保留窗口或重载后只恢复可见基线，已删除且不再可见的编号无法恢复，不按过滤后的会话列表缺席清理。

## 打开附件

输入框芯片与消息里的附件芯片，**单击**就在编辑器里打开（不要求修饰键：芯片上没有别的点击动作），悬停显示的是**原文件完整路径**——可点光标已经说明「点得开」，提示不必再复述一遍动作；路径查不到（拖放 / 粘贴进来的没有原文件、别处发的本机没记过）就不给提示，不拿文件名凑数。**图片缩略图不在此列**：它单击出来的仍是原图浮层，与助手消息、工具行、正文外链的图共用同一套待遇——放大看是缩略图最常见的动作，换成「打开编辑器」只会让用户为了看一眼图去开一个编辑器。界面只交身份（`webview/attachmentOpen.ts`），解析链只有一条（`controller.openAttachment`）：

1. `path`：原文件路径。路径通道进来的附件带着它；回放消息从同一次提交的本地记录借（`adapter.userMedia` 的 `echoAttachments`）。
2. `id`：宿主账本里那一条（`AttachmentLifecycle.find`）——`dataUrl`（粘贴 / 截图的字节）或**还没释放**的暂存字节，从内存落一份临时副本。
3. `attachmentId`：durable 内容身份。先查打开索引（内存：`AttachmentOpenIndex`，路径通道记原路径、字节通道在上传成功时落临时副本）与 `globalState` 里的持久记录（`attachmentOpenStore.ts`，一条身份一把键，跨宿主重启还在）；命中且文件还在就直接开。否则图片再退到 `session/attachment` 换字节（回放的图片只剩这个句柄时走这条，拿到的是服务端**归一化**过的副本，不是原始字节）。
4. 都拿不到 → `@attachmentUnavailable`（不静默）。

临时副本落在系统临时目录的 `dsh-chat-attachments` 下，按内容摘要分目录（`<摘要前 12 位>/<叶子名>`），同一份内容只写一次。**不是**内存虚拟文档：VS Code 内置的图片预览只认真实文件 URI，自定义 scheme 的 `TextDocumentContentProvider` 按文本渲染，一张 PNG 只会是乱码。

每条本地来路经 `controller.tryOpenAttachmentPath`：消息或账本中的路径无法解析、确认不存在、或编辑器拒绝打开时，继续尝试账本字节、上传索引与服务端图片副本，全部失败才提示一次。`stat` 不确定时仍尝试编辑器，不能当成确认缺失。原件可打开时始终优先，不用上传快照替换用户修改后的内容。附件链不走 `openFile` 的 git 删除文件对比或中途文件缺失提示；普通文件点击仍保留那条退路。

附件与普通文件都**不按文件类型分流**：普通打开只有一句 `vscode.open` 命令，编辑器交给 VS Code 按资源类型自己挑（图片进内置预览、文本进文本编辑器、其余进它自己的对应编辑器），与在资源管理器里双击同一个行为。**唯一自己动手的是「带行号打开」**（正文链接的 `#L24`）：`controller.openFile` 按文件真实行数夹取光标，那条路取一次文本文档再 `showTextDocument`，失败就退回普通打开。

这里踩过一次坑：早先用 `openTextDocument` 直接打开，它对一张 PNG 抛「文件似乎是二进制文件，不能作为文本打开」，日志里只留一行 `[open] 打开失败`，用户看到的就是「单击没有反应」（2026-10-13 实测）；随后一度补了一句「先判是不是图片」，那是把同一件事判了第二遍——加类型判据不如把打开动作整个交出去。

字节通道（拖放 / 截图）的本地留底发生在**上传成功那一刻**（账本的 `rememberOpenTarget` 端口）：那是宿主最后一次同时握着内容身份与字节，此后再无机会。图片不靠它：草稿芯片按账本 `id` 取字节，发出之后图片以缩略图呈现（单击是原图浮层），只有取不到字节、退回芯片的那一张才又落到这条链上，那时借来的本地路径与 durable 句柄仍可一试。

打不开的两类都会明确提示：**重开扩展之后**的历史文件附件（索引在内存里，随扩展退出消失），以及**别的客户端**（如官方 Web UI）发出的文件附件——服务端没有「按句柄读文件字节」的端点。图片不受这两条限制。

## 引用与快照

文件引用是正文 `@path`，目录写成 `@dir/`；上传文件则提交 receiptId，不内联全文，不能把两种入口混为一谈。

编辑器选区插入带行号的正文路径引用，例如 `@path#L12-L40`，由模型读取对应文件行；不内联代码，也不保存选区内容快照。会话引用的快照与 durable 身份恢复见[消息设计](<design-messages.md#用户消息与引用身份>)。

## 数据流与归属

```text
回形针 → pickFiles → addPaths
拖放 / 粘贴 → attachFiles → attachBytes {source,files[{name,mimeType,base64}],unreadable,tooLarge}
  粘贴图片先按会话内序号命名（pastedImageNames：图N.png / imageN.png）
  粘贴先问系统剪贴板真路径；没有路径才 decodeAttachBytes
→ planIntake → ingestAttachments → 芯片 / 引用 / 提示
   整份下发的附件列表剥掉 dataUrl（芯片只显示名字与上传状态）
→ beginSend → 附件取宿主账本（send 帧不回传 Attachment[]）
→ startUpload → attachmentLifecycle.start → performUpload → uploadFile
→ POST /api/session/uploadFileBinary?sessionId&name，application/octet-stream
→ ready + receiptId 或 error（芯片可重试）
```

上传结算只写开轮那一刻的持有者：切会话不改归属，不向当前会话推旧上传帧；迟到完成不复活删除项、不覆盖新轮，重复 start / 连点重试合并。在飞上传不是随界面切换销毁的对象。

附件列表的权威表是 `attachmentLifecycle`，未绑定按 viewId、绑定后按 sessionId。换键整份迁移（空表也搬、相遇合并）；窗口回收只收 viewId 那份，会话键留着。

提交租约按 requestId：

| 时机 | 操作 |
|---|---|
| beginSend / commitAttachments | detach 可见草稿到提交租约，保原对象、字节、回执与在飞结算 |
| 无回显失败 / appendDraft | returnLease 整份归还输入框 |
| 有回显失败 | 红行引用活条目，上传完成后重发可拿真回执 |
| resendPending | transferLease 给新提交，不取消上传、不重启、不放回输入框 |
| durable 承认 / 撤回 / 命令 / 无回显成功 / 回显淘汰 | releaseLease 最终释放 |

按键回收不连带租约，越过告警阈值也不能按数量销毁；dispose 全清。草稿与回显时序见[发送设计](<design-draft.md>)。

`buildPromptContent` 保附件列表顺序，再放文本。文件是否进入 prompt 只看上传回执，不看 path；未就绪的报 `@uploadIncomplete` 名字，图片 data URL 不可解析则进 dropped 并记宿主日志。

文件附件未就绪（上传中或上传失败）**禁用发送**，空闲与生成中一致，Enter 与 Ctrl/Cmd+Enter 走同一个发送入口早退；生成中且有正文时按钮保留「排队 / 插话」文案、只置灰，不变成停止。悬停说明原因（上传中 / 上传失败）；禁用的原生 button 收不到 hover，提示挂在外层容器。判据只有 `shared/attachmentGate.ts` 的 `attachmentUploadBlock` 一份，`buildPromptContent` 的就绪判据同源；图片内联、不参与这道门。宿主在 `send` 入口按同一判据兜底：命中时不动芯片、不建回显，把宿主账本里的草稿原样重新镜像一帧并记日志。

**没有可用会话就整批拒收接入**：附件入口不替用户建会话、连后台或弹目录选择器（用户 2026-10-20 口径：文件选择框之后再来一个目录选择框会让用户莫名其妙）。判据是「连接已就绪 + 窗口已绑会话」；还没有会话时再看有没有工作目录，决定提示「请选择工作目录」还是「会话尚未就绪」。不满足时按钮入口连文件选择框都不弹，直接发黄色通知；拖放与粘贴同样整批拒收，也不落 `@uploadNoSession` 芯片。拒收通知归属发起时绑定的会话，断线不改变归属；仅未绑定会话时使用共享通知。

## 官方证据与差异

下列符号是既有对照的定位线索，换版本后按名字复核，不按旧行号：

| 官方位置 / 符号 | 事实 |
|---|---|
| `packages/client/file-upload/src/client/runtime.ts` 的 upload；`file-upload/src/http-route.ts`；`attachment/attachment/src/admission.ts` | 上传不筛类型 / 大小，body 流交附件存储，只校验协议与 canonical base64；空文件合法 |
| `ui-conversation/src/client/service.ts` 的 createDrafts / isImageMediaType / encodeImage | 浏览器 MIME 分图与文件；文件选中即上传，图片内联；bmp/svg 不是图，无内容嗅探 |
| InputBar 的图片准入与 Host 把关 | 数量、单张、总量超限整批拒绝；契约还有像素 / 边长上限 |
| 文件 input | multiple，无 accept / webkitdirectory |
| uploadsPending / primaryDisabled | 文件上传中或失败都禁发送，须重试或移除 |
| addFiles 的会话绑定检查 | 没有会话绑定直接返回 `file.sessionUnavailable`，整批不收 |
| serializeAttachments | 附件同序，文本最后，空文本不放块 |
| `file-upload/src/protocol.ts` 与浏览器 Worker | 同一二进制路由；Blob/流由 XHR 报进度或 fetch duplex，精确字节可回退 Remote base64 |
| `input/editor/keymap.ts`、`ui-attachment/src/client/drop-events.ts` | 粘贴文件、拖放、文件选择都进 intakeFiles；粘贴文本可同时发生 |

本扩展保留路径去重、目录转引用、无路径且模型不收图时上传、字节 8 MB 与内联图 64 MB 硬上限。前两者避免无意义重复 / 空目录附件；后两项限制兜住 base64 膨胀、字符串拷贝与同步大文件读取。发送门与接入会话门已按官方口径补齐：文件未就绪不许发，没有会话不接附件。

传输机制不等价：官方持浏览器 File、Worker 流式上传；扩展宿主整块读入内存再 POST，图片 data URL 还经历 JSON 往返，内存与带宽更高。二进制路由不吃 Remote base64 的 300 MiB JSON body 上限，但不代表宿主内存无限。

## 平台事实与不可得能力

### 拖放拿不到 OS 路径

三重证据：VS Code webview pre 的 `handleInnerDragEvent` 只转 shiftKey、`handleInnerDropEvent` 只阻默认；宿主 webview element 合成 DragEvent 不带 dataTransfer；iframe 只剩标准 File。Electron 32 起无 File.path，webview 没有 webUtils；DocumentDropEditProvider 只对 TextDocument 生效，不覆盖 textarea。

既有实测 `dataTransfer.types` 只有 `["Files"]`，text/uri-list 与 text/plain 为空。目录读不出字节，也无真路径；不能拿目录名去工作区猜同名路径。

### Shift 与粘贴路径

- workbench 的 `windowDidDragStart` 不按 Shift 就令 iframe pointer-events:none，文件会在编辑器打开；Shift 才放行。整页 dragover 阻默认，dragActive 显示投放浮层。
- Windows 宿主 `readClipboardPaths` 用 PowerShell 的 `-Sta` + WinForms GetFileDropList，UTF-8、5 秒超时、windowsHide；**PowerShell 7（`pwsh.exe`）优先、5.1 兜底**——5.1 的进程启动本机实测 1.0～1.5 秒，7 只有 0.4 秒，而这次查询串在「粘贴 → 芯片出现」的路径上。非 Windows / shell 缺失 / 剪贴板占用返回空表，正常回退字节，不作为错误。
- 这次查询**只在这一批字节通道兜不住时才做**：全部读出、全在 8 MB 内且每一枚都是图片时直接走字节通道（图片走两条通道结果相同：都内联成内容块、芯片名都取 basename）。复制目录（0 字节条目进 `unreadable`）与任何超限条目照旧去要真路径——只有路径通道兜得住它们。
- 复制目录后 Chromium File 为 size=0、type=""，arrayBuffer 抛 IO 错误；两层 0 字节拒绝不能删。不要拦 Ctrl+V keydown，否则截图粘贴也被吞。

## 实现地图与回归

- [attachments.ts](<../src/dsh/attachments.ts>)：planIntake、分类 / 上限 / 去重、`admissionVerdict`（像素与单边）、buildPromptContent。
- [imageSize.ts](<../src/dsh/imageSize.ts>)：图片头部宽高（png / jpeg / webp / gif），给准入预检用。
- [attachmentLifecycle.ts](<../src/dsh/attachmentLifecycle.ts>)：唯一归属表、上传轮次、提交租约；成功时写回内容身份并把打开目标交给宿主。
- [attachmentOpen.ts](<../src/dsh/attachmentOpen.ts>)：临时副本命名 / 落盘与内容身份索引（纯逻辑，可离线断言）。
- [attachmentOpenStore.ts](<../src/dsh/attachmentOpenStore.ts>)：同一条对应关系的持久化口径（`globalState`，一条身份一把键 + 按写入时间有界淘汰；原文件与临时副本分开记，前者才当「文件路径」展示；不 import vscode）。
- [attachmentGate.ts](<../src/shared/attachmentGate.ts>)：发送门的唯一判据（文件就绪 / 阻塞原因），宿主与界面共用。
- [controller.ts](<../src/dsh/controller.ts>)：接入 IO、接入会话门、唯一目录引用落点、上传与提交租约接线、`send` 兜底、`openAttachment` 解析链；[client.ts](<../src/dsh/client.ts>)：uploadFile。
- [attachIntake.ts](<../src/webview/attachIntake.ts>) / [App.tsx](<../src/webview/App.tsx>)：字节提取、整页 drop / paste 与浮层；[pastedImageNames.ts](<../src/webview/pastedImageNames.ts>)：粘贴图片的会话内编号名；[attachmentOpen.ts](<../src/webview/attachmentOpen.ts>)：打开的 IPC 分派与可点判据；[ipc.ts](<../src/shared/ipc.ts>)：帧。
- [clipboardPaths.ts](<../src/dsh/clipboardPaths.ts>)：Windows 真路径；[mentions.ts](<../src/shared/mentions.ts>)：引用拼写；[Composer.tsx](<../src/webview/components/Composer.tsx>)：芯片、重试与发送按钮置灰；[composerSend.ts](<../src/webview/composerSend.ts>)：按钮档位与悬停原因。

离线回归：attachments（回执、内容顺序、同管线 / 同 MIME、上限与拒绝、图片准入四项、`withoutAttachmentDataUrls` 只读不改、FileReader 前缀与并发顺序、剪贴板查询的四条件跳过、发送取账本、**发送门与装配同源**）、attachIntakeGate（无目录取消 / 后台未连接 / 建会话失败三档整批拒收与提示、正常空态照旧上传、混批整批拒收、宿主 `send` 兜底重推草稿）、composerSend（附件未就绪只置灰、不把运行中的发送变成停止、真渲染外层悬停）、attachmentOpen（叶子名与扩展名、data URL 解码、内容寻址落盘、索引等待与淘汰、打开记录的取值 / 形状校验 / 有界淘汰）、imageSize（四种格式头部读数与放行边界）、pastedImageNames（编号识别、起始编号、只改图片、被拒条目不改名、降级图片文件的消息 / 回显 / 草稿恢复、删除后跨会话续号、快粘与切语言、空态绑定迁移、有界保留窗口）、clipboardPaths（解析、脚本形状、shell 顺序）、attachmentLifecycle（切会话、旧轮、归还 / 交接 / 释放、内容身份与打开目标、**重开宿主后按持久记录打开历史文件附件**）、selection、previewFixture。跨宿主 / webview 的帧改动须双端构建；交付安装版时确认两端产物都更新。mimeType 可选兼容旧帧，不能把混合产物验证当完整验收。常规命令与真实测试批准见[AGENTS](<../AGENTS.md>)。

## 未覆盖边界与重评条件

- 图片准入已消费 `maxImageBytes` / `maxImagePixels` / `maxImageDimension` / `maxImagesPerMessage` / `maxMessageImageBytes` 五项；投影里剩下的 `mediaTypes` 未消费（本扩展的图片表与它同是 png/jpeg/webp/gif 四种，没有第二个消费点）。判据只在**接入那一刻**做一次：上限中途变化（投影刷新）不会回头清理已进草稿的图片，最终裁决仍在服务端。
- uploading 的 loaded 恒为 0，只有状态、无逐字节进度；跟进需改宿主传输并回传进度。
- 路径仅后缀兜底，文本内容的 a.png 可能被误当图片并遭服务端整批拒绝；内容嗅探与额外 IO 的取舍尚未定。
- 大图路径读取仍有同步占用扩展宿主的风险；准入上限与离线测试通过不证明该路径无阻塞，改变读取管线时须单独量测。
- 纯附件发送仍被 Composer 的非空正文判定挡住；宿主能装配附件，不代表界面已开放该入口。
- 拖放目录缺平台真路径，不是可靠名称猜测修复的问题；平台开放后应加可选路径字段、复用 addPaths，不另开管线。
- 打开记录跨宿主重启保留，但**只对本扩展自己上传的附件**成立：别的客户端（如官方 Web UI）发的文件附件，本机从没记过路径，也没有「按句柄读文件字节」的端点，只能提示打不开。原文件被移走或删掉、临时副本被系统清掉，同样落到那条提示。
- 打开记录与内存索引各有一份，上限都是 256 条：越过就丢最旧的。丢记录只影响「还能不能打开」，不丢用户数据——原件仍在原处，下次上传会重新记上。
- 临时副本不主动清理：路径由内容摘要决定，同一份内容只写一次，其余交给系统清理临时目录。丢记录不删文件（那个文件可能正开在编辑器里），但反过来说，副本被系统清掉之后那条记录也就打不开东西了——它会一直留到被淘汰为止，不在打开失败时就地删（网络盘、临时拔掉的盘都会让「不存在」是暂时的）。

可跟进能力集中在[待评估清单](<../ToDo.md>)；以上边界不等于已决定实现。
