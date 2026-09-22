# 附件与引用接入设计规格（添加文件 / 拖放 / 粘贴）

> 本文是附件与 `@` 引用接入的设计规格（三个入口、一条管线、三种落点，含与官方 `dsh` 的
> 逐条对照与平台实测结论）；改附件 / 拖放 / 粘贴 / 上传 / 目录引用相关代码前先读。
> 实现状态（2026-09-21）与代码一致，当天修复见文末附记。
>
> 依据：官方 `dsh` checkout（`D:\dev\deepseek-harness`）与本机 VS Code 1.138.0；官方证据
> 只落文件与函数名（行号易漂移），需要时按名 grep。相关文档：
> `docs/audit-input-queue-attachments.md`（逐条审计与拖放 / 粘贴实测）、
> `docs/audit-summary.md`「7.2 功能 BUG」表 B13、`docs/dsh-server-api.md`（上传路由）。

---

## 0. 结论速览

**三个入口，一条管线，三种落点。**

- 入口：**添加文件按钮**（VS Code 文件对话框）、**拖放**（整页）、**粘贴**（Ctrl+V）。
- 管线：三者都归到纯函数 `planIntake`（`src/dsh/attachments.ts`）这一个决策点，再经
  `ingestAttachments`（`src/dsh/controller.ts`）落到视图。
- 落点：**文件 → 上传**（`{type:'file', receiptId}`）、**图片 → 内容块**
  （`{type:'image', mediaType, data}`）、**目录 → `@dir/` 引用文本**（正文里的路径
  token，不是附件）。

三个被问过的问题，答案先写在最前面：

1. **官方上传辨不辨文件类型？** 上传**本身不辨**：任何字节、任何长度都原样上传（§4.1）。
   但**附件形态**官方按浏览器 MIME 分流——png/jpeg/webp/gif 走内容块，其余一律上传
   （§4.2）。
2. **扩展的上传通道是不是和官方同一条？** 是。同一路由、verb、`content-type`、参数与
   响应信封（§4.7）；差别只在**传输机制**：官方从浏览器 Blob/Worker 流式发并报进度，
   扩展在宿主里整块读入内存后 POST（§5.2 机制差异）。
3. **拖放能取到真实路径吗？** 不能（§6.1 三重证据）。所以**拖放文件夹按"拿不到路径
   就不做"的口径作废**——拖进来的目录只得到一条明确提示；**拖放文件不受影响**，它
   本来就走字节通道（上传不需要路径）。

---

## 1. 术语

| 词 | 含义 |
|---|---|
| **入口** | 用户把东西送进来的动作：按钮 / 拖放 / 粘贴 / `@` 候选 / 右键·命令面板 / 编辑器选区 |
| **条目（IntakeItem）** | 接入管线的输入：`{from:"path"}`（有真路径）或 `{from:"bytes"}`（只有字节与文件名） |
| **附件（Attachment）** | 输入框上方芯片里的东西，只有两种：`file`（上传）与 `image`（内容块） |
| **引用** | 正文里的 `@path` token（目录是 `@dir/`）。**不是附件**，不占芯片位；模型侧语义由系统提示段定义 |
| **字节通道** | webview → 宿主的 `attachBytes` 帧（base64，单文件 8 MB 上限）。拖放只有这一条 |
| **路径通道** | 宿主直接拿到文件系统路径（按钮对话框 / 粘贴时向系统剪贴板取的真路径），不限大小 |

---

## 2. 入口矩阵（规范核心）

「收场」列即用户能看到的结果；**同一列在不同入口必须一致**，不一致就是缺陷。

| 入口 | 文件（非图片） | 图片（模型收图，未超内联上限） | 目录 | 读不出来 / 0 字节 | 超过 8 MB |
|---|---|---|---|---|---|
| **添加文件按钮** | 上传 → 文件芯片 | 内容块 | Windows/Linux 不可能返回目录；macOS bundle / 目录联接 → `@dir/` | 引号路径插到光标处 | 不适用（路径通道不限大小） |
| **拖放** | 上传 → 文件芯片（字节通道） | 内容块 | **不支持**（拿不到路径）→ 提示 | 提示 `@dropUnreadable` | 提示 `@dropTooLarge` |
| **粘贴**（剪贴板里有文件，Windows） | 上传 → 文件芯片（路径通道） | 内容块 | **`@dir/` 引用** | 一般不会（真路径都在），取不到字节时同下一行 | 不适用（路径通道不限大小） |
| **粘贴**（剪贴板里只有位图 / 非 Windows） | 上传 → 文件芯片（字节通道） | 内容块 | 不支持 → 提示 | 提示 `@pasteUnreadable` | 提示 `@pasteTooLarge` |
| **`@` 候选（界面）** | 正文 `@path` token | 同左 | 正文 `@dir/` token | 不适用 | 不适用 |
| **资源管理器右键 / 命令面板 / 编辑器选区** | 正文 `@path` token（选区带 `#L12-L40`） | 同左 | `@dir/` token | 不适用 | 不适用 |

补充规则：

- **图片超内联上限**（`imageLimits.maxImageBytes`，缺省 64 MB 硬上限）→ 降级成
  **文件上传**，并发 `@imageTooLarge:<名字>` 提示。**两条通道都判**（此前只有路径通道判）。
- **模型不收图**（`acceptsImage === false`）：路径条目 → 引号路径插到光标处 +
  `@imagePathsInserted` 提示；字节条目 → 按文件上传（没有路径可插，上传是唯一不退化的收场）。
- **添加文件对话框不需要文件夹/文件分类**：`canSelectFiles: true` + `canSelectFolders: false`
  （`controller.ts` 的 `pickFiles`）。同时置 true 在 Windows/Linux 上只会弹目录选择器
  （`@types/vscode` 的 `OpenDialogOptions` 明写），断言在 `scripts/attachments.test.ts` §3。
- **去重**：路径条目按路径去重（同一份文件加两次没有意义，`planIntake` 的 `seen`）；
  **字节条目不去重**（只有名字，没有身份可比）。官方两者都不去重——这里刻意多一道，
  不影响"同一份输入同一收场"。

---

## 3. 数据流

```
界面（webview）三入口：回形针按钮 post addFiles；window drop（整页投放区）/ window paste
  → attachFiles()：读成字节（0 字节 / 超限的只报名字）→ attachBytes 帧
    { source, files:[{name, mimeType, base64}], unreadable, tooLarge }

宿主（controller）：
  addFiles → pickFiles()（showOpenDialog，只选文件）→ addPaths(paths, "button")
  attachBytes 且 source === "paste" → 先 readClipboardPaths()（系统剪贴板真路径，Windows）
    有路径 → addPaths(paths, "paste")              ← 目录与文件一起，不再自己分流
    无路径（截图 / 非 Windows / 剪贴板被占）→ decodeAttachBytes() 逐个解码
      → ingestAttachments(source, 字节条目, 拒绝项)

决策唯一在纯函数 planIntake：文件 → uploads；图片 → 内容块 data URL；
  目录 → @dir/ 引用文本；拒绝 → toast（按 source 分措辞）

上传：startUpload → runUpload → DshClient.uploadFile
  POST /api/session/uploadFileBinary?sessionId&name（application/octet-stream）
  → upload.status = { ready, receiptId }（失败 = error，可点芯片重试）

发送（send，controller.ts）：buildPromptContent
  content = [ ...附件（按列表顺序）, {type:"text", text} ]     ← 官方同序
  notUploaded → @uploadIncomplete 提示（上传中 / 失败 / 状态丢失）
  dropped → 宿主日志（图片没有可解析的 data URL）
  → session/prompt
```

---

## 4. 官方口径（逐条）

### 4.1 上传不做任何类型 / 大小筛选

- `packages/client/file-upload/src/client/runtime.ts` 的 `upload()` 只按 body 形状
  （Blob / ReadableStream / Uint8Array）选传输载体，没有类型或大小判据。
- `file-upload/src/http-route.ts` 的路由只校验 `content-type: application/octet-stream`
  与 `sessionId`，body 以流的形式交给附件存储。
- `attachment/attachment/src/admission.ts` 只校验 canonical base64，**空文件也是合法载荷**；
  没有扩展名、MIME、内容判定。
- 结论：`exe`、二进制、无扩展名、几百 MB —— 官方全都不拦。用户在 Web 端上传 exe 实测过。

### 4.2 但"图片 vs 其它"是按**浏览器 MIME** 分的

- `ui-conversation/src/client/service.ts` 的 `createDrafts()` 用 `isImageMediaType(file.type)`
  分流：图片 → 草稿图（预览 + 提交时内联），其余 → 文件草稿并**立即上传**（upload-on-pick）。
- `isImageMediaType` 只认 `image/png`、`image/jpeg`、`image/webp`、`image/gif`——
  **`image/bmp` / `image/svg+xml` 都不算图片**，按普通文件上传。
- 图片提交时 `encodeImage` → `{type:"image", mediaType, data, name}`。
- 结论：官方的判据是**声明式 MIME**，不是扩展名、也不是内容嗅探。

### 4.3 图片准入上限在 intake 就整批拒绝

- `InputBar.tsx`：图片数量（`maxImagesPerMessage`）、单张（`maxImageBytes`）、总量
  （`maxMessageImageBytes`）三项超限时**整批拒绝**并提示，不进入草稿。Host 侧对绕过
  这个 composer 的调用方同样把关。
- 契约字段还有 `maxImagePixels` / `maxImageDimension`（`attachment/src/types.ts`）。

### 4.4 文件对话框：没有 `accept`，也不能选目录

- `<input type="file" multiple hidden>` —— 没有 `accept`（不按类型过滤），没有
  `webkitdirectory`（不能选目录）。与扩展的结论一致：按钮这条路**不需要**文件夹/文件
  分类（§2）。

### 4.5 上传未完成时官方**禁用发送**

- `uploadsPending = attachments.some(a => a.kind === "file" && uploads[a.id]?.status !== "ready")`
  —— 注释写明「上传中与失败都握在门上，失败要么重试要么移除，绝不静默丢弃」；
  `primaryDisabled` 含 `uploadsPending`。

### 4.6 内容块的顺序 = 附件顺序 + 文本最后

- `serializeAttachments()` 由 `attachments.map(...)` 产出（顺序保持），图片内联、文件只带
  `receiptId`；`content = [...uploaded, ...(text === "" ? [] : [{type:"text", text}])]`。

### 4.7 上传通道

- 路由常量 `/api/session/uploadFileBinary`（`file-upload/src/protocol.ts`）。浏览器侧
  Blob/流走后台 Worker（XHR 上传进度 / `fetch` + `duplex:"half"`），精确字节走 Remote
  回退（base64）。
- 扩展打的是**同一个**路由与 content-type（`client.ts` 的 `uploadFile`），走二进制那条
  （不吃 base64 的 300 MiB JSON body 上限，见 `docs/dsh-server-api.md` 的上传路由）。

### 4.8 拖放与粘贴在官方也是同一个 intake

- 粘贴：`input/editor/keymap.ts` 把 `clipboardData.items` 里 `kind === "file"` 的交给
  `handlers.intakeFiles(files)`；纯文本另走 `pasteText`（两者可以同时发生）。
- 拖放：document 级 `drop`（`ui-attachment/src/client/drop-events.ts`）→
  `onAddFiles([...dataTransfer.files])`；选择文件：同一个 `intakeFiles`。
- 结论：官方**三个入口一个函数**。本扩展 2026-09-21 才收敛到同一形态（见文末附记）。

---

## 5. 与官方的差异

### 5.1 保留（有理由，不再改）

| 差异 | 理由 |
|---|---|
| 路径条目按路径去重 | 同一份文件重复添加没有意义；官方不去重也不受影响 |
| 目录 → `@dir/` 引用（官方会把目录当 0 字节文件上传） | 扩展能在宿主侧拿到真路径，比"上传一个空文件"有用得多；用户 2026-09-21 明确「粘贴文件夹不该变成附件」 |
| 模型不收图时字节条目改为上传 | 字节通道没有路径可插；丢弃更差 |
| 发送不因"上传中"而禁用（改为提示 `@uploadIncomplete`） | 用户已表达"能发就先发"；提示保证不静默（官方是禁用） |
| webview 字节通道 8 MB 上限 | base64 过线要 4/3 膨胀 + 字符串拷贝；官方流式没有这个限制，但扩展的拖放拿不到路径，只能交换 |
| 图片内联上限缺省 64 MB 硬上限 | 兜住"同步读一个巨大文件"的最坏情况（`imageLimits.maxImageBytes` 通常小得多） |

### 5.2 机制差异（不是判据差异）

官方从浏览器把 Blob 交给后台 Worker/XHR 流式上传，草稿在浏览器内存里持原始 `File`，
后台上传在会话切换后继续；扩展在宿主里整块读入内存再 POST（`runUpload`），图片来源是
宿主读成的 data URL、发送时从 webview 再带回宿主（JSON 往返），字节暂存 `droppedBytes`
（按附件 id，成功后释放、失败留到重试或删除）。功能等价，内存/带宽开销更大。

---

## 6. 平台事实与不可得能力

### 6.1 拖放拿不到 OS 路径（三重证据）

1. **webview 的 pre 脚本不转发路径**：`…\out\vs\workbench\contrib\webview\browser\pre\index.html`
   —— `handleInnerDragEvent` 只 `postMessage('drag', {shiftKey})`，`handleInnerDropEvent`
   只 `preventDefault()`；没有 ResourceURLs、没有 `text/uri-list` 注入。
2. **宿主侧也不转发**：`…\out\vs\workbench\workbench.desktop.main.js` 的 webview element
   对 `drag-start` 只阻塞 iframe 拖拽（`pointer-events: none`），对 `drag` 只合成**不带
   dataTransfer** 的 `DragEvent` 再派发到主窗口。
3. **iframe 里只剩 Chromium 的标准文件载荷**：`File.path` 自 Electron 32 起移除，webview
   的 `window.vscode` 只有 `acquireVsCodeApi`（没有 `webUtils.getPathForFile`）；扩展 API
   里唯一能拿到 URI 的 drop 入口是 `DocumentDropEditProvider`（`@types/vscode`），但它只对
   **TextDocument** 生效，够不着 webview 里的 textarea。既有实测（VS Code 1.138 + 真实
   剪贴板/拖放）见 `docs/audit-input-queue-attachments.md`：`dataTransfer.types` 只有
   `["Files"]`，`text/uri-list` 与 `text/plain` 都是空串。

**推论**：拖放文件夹**作废**（读不出字节，也拿不到路径）。不要用 `webkitGetAsEntry()`
拿到目录名再去工作区里猜一个同名目录——猜错就是把引用指到别的目录（"拿不到证据就不动手"）。

### 6.2 拖放还要按住 Shift（VS Code 的阻挡）

workbench 在主窗口上盯着 drag/dragover，没按 Shift 就给 webview iframe 挂
`pointer-events: none`（`windowDidDragStart`），事件根本到不了界面，松手后 VS Code 把文件
在编辑器里打开。按住 Shift 是唯一的放行手势（VS Code 1.138 逐字核对过，没有按 webview
配置的豁免开关）。所以整页拖放都监听 `dragover` 并 `preventDefault`，`dragActive` 时亮浮层
提示"松开即添加为附件"（`App.tsx` 的 `usePageFileDrop`）。

### 6.3 粘贴为什么可能有真路径

webview 拿不到路径（同 §6.1 的实测），但**宿主**可以问**系统剪贴板**要：
`clipboardPaths.ts` 的 `readClipboardPaths` 在 Windows 上跑 `powershell.exe -Sta` + WinForms
`Clipboard::GetFileDropList()`（显式 UTF-8 输出、5 秒超时、`windowsHide`；找不到 shell 时
退回 `pwsh.exe`）。非 Windows、shell 缺失、剪贴板被别的程序占住 → 返回空数组，上层随即
退回字节通道。**读取失败不是错误路径**，只是"这次没有路径可用"。

### 6.4 剪贴板里的目录条目长什么样（实测）

复制目录后粘贴，Chromium 给的是一个 `size = 0`、`type = ""`、名字为目录名的 `File`
（`arrayBuffer()` 抛 IO 错误）。所以界面侧**0 字节条目一律不读**，直接按"读不出来"上报
（`attachIntake.ts`），宿主侧 `planIntake` 再拦一道。没有这两道，界面上会多出一个
0 字节的假附件（曾经就是这样）。

---

## 7. 实现地图

| 文件 | 职责与关键函数 |
|---|---|
| `src/webview/attachIntake.ts` | 界面侧接取：拖放 / 粘贴 → 字节、补名字、8 MB 上限、发 `attachBytes`（`clipboardFiles` / `attachFiles` / `attachDroppedFiles` / `attachPastedFiles`） |
| `src/webview/App.tsx` | 全页 drop / paste 监听（只注册一次）与拖放浮层（`usePageFileDrop` / `usePagePaste`） |
| `src/shared/ipc.ts` | `attachBytes` 帧定义（`source` / `files[{name,mimeType,base64}]` / `unreadable` / `tooLarge`） |
| `src/dsh/attachments.ts` | **纯逻辑**：判据、上限、去重、拒绝、内容块装配（`classifyPath` / `imageMediaTypeForEntry` / `classifyDroppedBytes` / `ATTACH_BYTES_LIMIT` / `planIntake` / `buildPromptContent`） |
| `src/dsh/controller.ts` | 接入执行与上传；目录引用的唯一落点；发送装配（`pickFiles` / `pickFolder` / `addPaths` / `ingestAttachments` / `addDirectoryReference` / `decodeAttachBytes` / `startUpload` / `runUpload` / `retryUpload` / `send`） |
| `src/dsh/clipboardPaths.ts` | 系统剪贴板真路径（Windows，`readClipboardPaths`） |
| `src/dsh/client.ts` | 上传，与官方同一路由（`uploadFile`） |
| `src/webview/components/Composer.tsx` | 芯片（上传中 / 失败可重试 / 名字）与附件入口按钮（`composer-chips`） |
| `src/shared/mentions.ts` | `@path` token 的唯一拼写规则：分隔符归一、目录尾斜杠、成对引号（`formatFileMention` / `normalizeMentionPath`） |

---

## 8. 不变量与回归门

每条不变量都要有断言（零 token 命令内）：`npm run typecheck && npm test && npm run build`。

| # | 不变量 | 断言落点 |
|---|---|---|
| 1 | 文件附件是否进 prompt **只看上传回执**，与有没有 `path` 无关；未就绪的必须报出名字 | `scripts/attachments.test.ts` §7①③ |
| 2 | 内容块顺序 = 附件列表顺序 + 文本最后（官方同序） | §7④ |
| 3 | 图片没有可解析 data URL 时不静默（进 `dropped`，宿主记日志） | §7⑤ |
| 4 | 同一份输入在路径通道与字节通道得到**同一种**内容块（同判据） | §8① |
| 5 | 图片判据 **MIME 优先、后缀兜底**；表外 `image/*`（bmp/svg…）按文件上传 | §1、§8② |
| 6 | 图片内联上限**两条通道都判**，超限降级为上传并报 `degradedImages` | §8③ |
| 7 | 目录 → 引用（附件列表里不出现目录），且同一路径只插一次 | §8⑤ |
| 8 | 路径条目按已有列表去重、字节条目不去重 | §8⑥ |
| 9 | 0 字节条目（拖进来的目录）→ 拒绝，不是假附件 | §8⑦ |
| 10 | 帧里必须带 `mimeType`；纯文本粘贴不进附件 | §5（帧断言）、§5①（纯文本） |
| 11 | 三个入口只有一份实现（不存在 `applyPathsForView` / `applyBytesForView` / `runUploadBytes`），目录只有一个落点 | §6、`scripts/selection.test.ts` §5 |
| 12 | 添加文件对话框不得同时允许文件与目录 | §3 |
| 13 | 拖放 / 粘贴只在认出文件时才 `preventDefault`，且监听挂在 window | §4（源码断言） |
| 14 | 芯片形态与夹具同步（没有"引用芯片"这种形态） | `scripts/previewFixture.test.ts`、`test/preview.html` |

**跨 webview ↔ 宿主的改动**（本设计里就是 `attachBytes` 帧）必须**两边一起打包**：
`npm run package && npm run install:vsix`，并确认安装目录下 `dist/webview.js` 与
`dist/extension.js` 两份产物都是新的。旧宿主 + 新界面时 `mimeType` 被忽略（退回后缀判定），
新宿主 + 旧界面时没有 MIME（同样退回后缀判定）——**帧扩展是双向兼容的**，这是刻意的。

---

## 9. 待办清单（按价值排序）

1. **图片整批准入预检**：`maxImagesPerMessage` / `maxMessageImageBytes` / `maxImagePixels` /
   `maxImageDimension` 均未消费——`projections.ts` 只解析前三个字段，其中只有
   `maxImageBytes` 有使用点（内联上限，§5.1）。官方语义是**整批拒绝 + 立刻提示**（§4.3），
   目前超限只能等服务端在提交时报错。落点建议：`planIntake` 入口按批校验（保持"整批"
   语义），新增 2–3 条 i18n 标记。（`docs/audit-summary.md`「7.4 明确不改」记的是同一件事。）
2. **上传进度**：官方逐字节报进度（Worker `upload.onprogress`），扩展恒为
   `{status:"uploading", loaded:0}`（`controller.ts` 的 `startUpload`）。需把宿主上传改成
   流式（Node fetch + `ReadableStream`）并在 `uploadFile` 里回传进度。
3. **内容嗅探或 MIME 获取**：路径通道只有文件名后缀可用——一个内容是文本的 `a.png` 会被
   当图片内联，到提交时被服务端**整批拒绝**。官方按 MIME 也不嗅探，但官方拿到 MIME 的
   场合比扩展多。选项：宿主嗅探魔数（多一次 IO）或接受现状（文档 + 报错可见）。
4. **拖放文件夹**：等平台给出路径通道（现状不可得，§6.1）。若将来有了，接入点是
   `attachBytes` 帧加一个可选路径字段，与粘贴共用 `addPaths`——**不要再开一条新管线**。

---

## 附记：2026-09-21 修复

当天修掉"拖放 / 粘贴文件附件上传成功后不进 prompt"的 BUG，并把两条平行通道合并为
`planIntake` + `ingestAttachments` 单管线（帧加 `mimeType`、删无生产方的目录引用芯片链、
拖放文件夹作废只留提示）；细节已进代码与 `CHANGELOG.md`。
