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
- 两条通道都检查 `imageLimits.maxImageBytes`，缺省硬上限 64 MB。超限降级上传并提示 `@imageTooLarge:<名字>`。
- 模型不收图：有路径则插引号路径并提示 `@imagePathsInserted`；无路径则文件上传。
- 路径按现有列表去重；字节条目没有可靠身份，不按名字去重。
- 对话框固定 `canSelectFiles:true, canSelectFolders:false`；Windows/Linux 两者都开会变成目录选择器。
- 0 字节由界面与宿主两层拒绝，不能把目录载荷当成空文件附件。纯文本粘贴不进附件流程。
- 粘贴进来的图片在发帧前按**会话内序号**命名：中文界面 `图N.png`、英文界面 `imageN.png`，后缀沿用条目自己的写法。0 字节与超过 8 MB 的条目不编号——它们会被拒，提示里必须报用户认得的原名。名字**不是磁盘文件名**：图片按内容摘要落进附件存储，同名不冲突，编号只为人在对话里指代。
  - 基线取已加载用户消息、乐观回显与草稿芯片里的最大编号（两种前缀都认，切语言不撞号）。图片降级为文件时，编号主干与图片后缀同时匹配的文件名也参与基线，普通文件不占号。
  - 本窗口按会话保留已分配最大编号，A → B → A 不回收已删芯片的编号，连续快粘也不依赖回帧；尚未绑定会话的空态编号在首次绑定时迁移，已绑定会话退回新空态时归零。
  - 最多保留 256 个最近访问的已编号会话，窗口销毁释放；超过保留窗口或重载后只恢复可见基线，已删除且不再可见的编号无法恢复，不按过滤后的会话列表缺席清理。

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

`buildPromptContent` 保附件列表顺序，再放文本。文件是否进入 prompt 只看上传回执，不看 path；未就绪的报 `@uploadIncomplete` 名字，图片 data URL 不可解析则进 dropped 并记宿主日志。上传未完成不禁发送是有意差异，不是漏做按钮门。

## 官方证据与差异

下列符号是既有对照的定位线索，换版本后按名字复核，不按旧行号：

| 官方位置 / 符号 | 事实 |
|---|---|
| `packages/client/file-upload/src/client/runtime.ts` 的 upload；`file-upload/src/http-route.ts`；`attachment/attachment/src/admission.ts` | 上传不筛类型 / 大小，body 流交附件存储，只校验协议与 canonical base64；空文件合法 |
| `ui-conversation/src/client/service.ts` 的 createDrafts / isImageMediaType / encodeImage | 浏览器 MIME 分图与文件；文件选中即上传，图片内联；bmp/svg 不是图，无内容嗅探 |
| InputBar 的图片准入与 Host 把关 | 数量、单张、总量超限整批拒绝；契约还有像素 / 边长上限 |
| 文件 input | multiple，无 accept / webkitdirectory |
| uploadsPending / primaryDisabled | 文件上传中或失败都禁发送，须重试或移除 |
| serializeAttachments | 附件同序，文本最后，空文本不放块 |
| `file-upload/src/protocol.ts` 与浏览器 Worker | 同一二进制路由；Blob/流由 XHR 报进度或 fetch duplex，精确字节可回退 Remote base64 |
| `input/editor/keymap.ts`、`ui-attachment/src/client/drop-events.ts` | 粘贴文件、拖放、文件选择都进 intakeFiles；粘贴文本可同时发生 |

本扩展保留路径去重、目录转引用、无路径且模型不收图时上传、上传未完成可发送并提示、字节 8 MB 与内联图 64 MB 硬上限。前两者避免无意义重复 / 空目录附件；后两项限制兜住 base64 膨胀、字符串拷贝与同步大文件读取。

传输机制不等价：官方持浏览器 File、Worker 流式上传；扩展宿主整块读入内存再 POST，图片 data URL 还经历 JSON 往返，内存与带宽更高。二进制路由不吃 Remote base64 的 300 MiB JSON body 上限，但不代表宿主内存无限。

## 平台事实与不可得能力

### 拖放拿不到 OS 路径

三重证据：VS Code webview pre 的 `handleInnerDragEvent` 只转 shiftKey、`handleInnerDropEvent` 只阻默认；宿主 webview element 合成 DragEvent 不带 dataTransfer；iframe 只剩标准 File。Electron 32 起无 File.path，webview 没有 webUtils；DocumentDropEditProvider 只对 TextDocument 生效，不覆盖 textarea。

既有实测 `dataTransfer.types` 只有 `["Files"]`，text/uri-list 与 text/plain 为空。目录读不出字节，也无真路径；不能拿目录名去工作区猜同名路径。

### Shift 与粘贴路径

- workbench 的 `windowDidDragStart` 不按 Shift 就令 iframe pointer-events:none，文件会在编辑器打开；Shift 才放行。整页 dragover 阻默认，dragActive 显示投放浮层。
- Windows 宿主 `readClipboardPaths` 用 powershell.exe -Sta + WinForms GetFileDropList，UTF-8、5 秒超时、windowsHide；无 shell 时试 pwsh.exe。非 Windows / shell 缺失 / 剪贴板占用返回空表，正常回退字节，不作为错误。
- 复制目录后 Chromium File 为 size=0、type=""，arrayBuffer 抛 IO 错误；两层 0 字节拒绝不能删。不要拦 Ctrl+V keydown，否则截图粘贴也被吞。

## 实现地图与回归

- [attachments.ts](<../src/dsh/attachments.ts>)：planIntake、分类 / 上限 / 去重、buildPromptContent。
- [attachmentLifecycle.ts](<../src/dsh/attachmentLifecycle.ts>)：唯一归属表、上传轮次、提交租约。
- [controller.ts](<../src/dsh/controller.ts>)：接入 IO、唯一目录引用落点、上传与提交租约接线；[client.ts](<../src/dsh/client.ts>)：uploadFile。
- [attachIntake.ts](<../src/webview/attachIntake.ts>) / [App.tsx](<../src/webview/App.tsx>)：字节提取、整页 drop / paste 与浮层；[pastedImageNames.ts](<../src/webview/pastedImageNames.ts>)：粘贴图片的会话内编号名；[ipc.ts](<../src/shared/ipc.ts>)：帧。
- [clipboardPaths.ts](<../src/dsh/clipboardPaths.ts>)：Windows 真路径；[mentions.ts](<../src/shared/mentions.ts>)：引用拼写；[Composer.tsx](<../src/webview/components/Composer.tsx>)：芯片与重试。

离线回归：attachments（回执、内容顺序、同管线 / 同 MIME、上限与拒绝）、pastedImageNames（编号识别、起始编号、只改图片、被拒条目不改名、降级图片文件的消息 / 回显 / 草稿恢复、删除后跨会话续号、快粘与切语言、空态绑定迁移、有界保留窗口）、attachmentLifecycle（切会话、旧轮、归还 / 交接 / 释放）、selection、previewFixture。跨宿主 / webview 的帧改动须双端构建；交付安装版时确认两端产物都更新。mimeType 可选兼容旧帧，不能把混合产物验证当完整验收。常规命令与真实测试批准见[AGENTS](<../AGENTS.md>)。

## 未覆盖边界与重评条件

- 图片只消费 maxImageBytes；maxImagesPerMessage / maxMessageImageBytes / maxImagePixels / maxImageDimension 未消费，当前只能等服务端提交时报错，不能假称完整整批预检。
- uploading 的 loaded 恒为 0，只有状态、无逐字节进度；跟进需改宿主传输并回传进度。
- 路径仅后缀兜底，文本内容的 a.png 可能被误当图片并遭服务端整批拒绝；内容嗅探与额外 IO 的取舍尚未定。
- 大图路径读取仍有同步占用扩展宿主的风险；准入上限与离线测试通过不证明该路径无阻塞，改变读取管线时须单独量测。
- 纯附件发送仍被 Composer 的非空正文判定挡住；宿主能装配附件，不代表界面已开放该入口。
- 拖放目录缺平台真路径，不是可靠名称猜测修复的问题；平台开放后应加可选路径字段、复用 addPaths，不另开管线。

可跟进能力集中在[待评估清单](<../ToDo.md>)；以上边界不等于已决定实现。
