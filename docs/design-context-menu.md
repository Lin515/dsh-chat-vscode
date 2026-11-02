# 会话右键菜单

接取见[contextMenu.ts](<../src/webview/contextMenu.ts>)，浮层见[ContextMenu.tsx](<../src/webview/components/ContextMenu.tsx>)。统一接管，不让抽屉或面板另维护一套规则。

## 事件接取

VS Code 在内层 iframe 的 window 提前注册 contextmenu 监听；只有 defaultPrevented 才不弹原生菜单。扩展挂在同一 window 会排在它后面，拦截太晚。

接取必须挂 **document 冒泡阶段**：先于 window，晚于 React root。轨迹时间线等已 preventDefault 的特化处理优先，统一接取读到它就让路。

## 判据

contextMenuKind 按下表优先级判断：

| 落点 | 处理 |
|---|---|
| input / textarea / contenteditable | 放原生菜单；自绘不能替代粘贴 |
| 图片（缩略图、原图、正文或子代理记录） | 自绘「复制 / 保存」；原图浮层另加「复原」 |
| 会话正文区内有选中文字 | 自绘「复制 / 引用」 |
| 其它区域的落点压在自己的选区上 | 放原生菜单，允许复制选区 |
| 其余 | preventDefault，不弹菜单 |

正文选区必须两端都在 `.chat-scroll`（chatSelectionText）。其它区域用 selectionCovers(target) / Range.intersectsNode 判断落点，不能因正文别处有选区就放行。选区文本按原生 `Selection.toString()` 读取；公式的 MathML / annotation 副本可能进入文本，属本次接受的边界，不做数学选区去重。

「引用」由 composerCompletion.quoteBlock 把选区插成整行 Markdown 引用块，不自动发送：需要时前补换行，后补换行使光标落在块外。

## 会话选区快捷复制

`handleChatCopy` 与右键接取一起在 document 冒泡阶段登记、卸载时一起清理：晚于 React 已处理的按键，早于 VS Code 的 window 快捷键转发。仅接管未处理、非组字、非重复的 Ctrl+C / Cmd+C（无 Alt / Shift，也不同时按 Ctrl 与 Cmd）。

- 选区非折叠且两端都在 `.chat-scroll` 时，保留原始空白与换行，经 `copyFeedback.ts` 的 `copyText()` 写 `copy` 帧交给宿主 `vscode.env.clipboard.writeText`，随后阻止默认行为与继续冒泡，避免重复转发。成功后由 `flashCopied()` 在选区末尾闪一条「已复制到剪贴板」（见下节）。
- 事件目标或当前焦点在 input / textarea / contenteditable 时保留原生编辑；无有效选区、跨正文边界、其它快捷键及已处理事件全部让路。不会接管剪切、粘贴或菜单复制。
- `chatSelectionText` 返回原始选区；右键的「复制 / 引用」仍在菜单入口去首尾空白，不改变既有菜单语义。
- 复制与引用不做数学选区去重：可能连同 KaTeX 的 MathML / annotation 辅助文本或不同格式的空白进入剪贴板 / 引用块，这是与官方对齐后接受的边界；不克隆副本、不写临时 style、不改 live DOM / Selection。
- 静态预览可以核验按键到 `copy` 帧的链路；只有安装端验收才能证明 VS Code 宿主已将内容写入系统剪贴板。

## 复制反馈

所有复制入口共用 [copyFeedback.ts](<../src/webview/copyFeedback.ts>)：`copyText()` 是唯一的 `copy` 帧发射点，成功反馈分两档。

- **有按钮的位置**（工具卡、工具 IN / OUT、diff 头部、写入预览、问卷记录、后台任务详情、历史会话 ID、代码块、消息操作行、轨迹原文）由 `useCopyFeedback` 亮 1s：文字版换「已复制到剪贴板」文案与对勾，图标版换对勾并上成功色（`components/CopyButton.tsx`）。
- **没有按钮可换文案的位置**（右键菜单「复制」、会话选区 Ctrl+C / Cmd+C）由 `flashCopied()` 在触发点右下闪一条「已复制到剪贴板」；拿不到选区矩形时回落到视口底部中间。提示层 `CopyFlashLayer` 挂在 App 根部一次，整层不接收指针事件，1s 后自己收掉。
- 菜单的「复制」按 **菜单弹出点** 定位提示（菜单先收、提示后出现），图片复制要等 `copyImageElement` 真的成功才闪；失败仍走 `reportImageCopyFailure` 的宿主通知，不闪成功提示。
- 三类内容的复制载荷都是纯函数，不从 DOM 或着色 token 反向拼：diff 走 `shared/diff.ts` 的 `diffClipboardText`（路径行 + `- ` / `+ ` / 两个空格前缀，覆盖全部 hunk 与被折叠的行）；问卷记录走 `questionFlow.ts` 的 `questionReplyText`（每题「题头 + 回答」，没答写「已跳过」，与官方 `replyClipboardText` 同口径）；IN / OUT 直接取原文。
- 工具 IN / OUT 的复制是本扩展**有意多给**的入口：官方通用 IN/OUT 不出复制，它的复制落在详情卡的 code 段里。两枚按钮的文案区分为「复制输入」「复制输出」，读屏能分开听。
- 图片的「保存」不在此列：路径由用户自己在系统对话框里选，取消与成功都不提示，只有取字节或写盘失败才入通知队列。

## 图片复制与保存

**复制**在界面完成：[imageClipboard.ts](<../src/webview/imageClipboard.ts>) 将 img 画到 canvas，转 PNG，再 navigator.clipboard.write。宿主只有纯文本剪贴板 API，webview iframe 允许 clipboard-write。

- Chromium 只收 image/png，直接写 image/jpeg 会抛 NotAllowedError。
- 未提供 CORS 的外链图片会污染 canvas，无法复制；如实提示失败。
- 文档失焦可能静默不写、不抛错；不能把无异常推广为系统剪贴板已落地的证明。

**保存**走 saveImage 帧 → [imageBytes.ts](<../src/dsh/imageBytes.ts>) 解 data URL / 拉 http(s) 字节 → [imageFiles.ts](<../src/dsh/imageFiles.ts>) 弹 showSaveDialog 并写盘。界面 CSP 不允许自行 fetch 外链或读写磁盘。

默认名字依次取有效图片 alt、地址文件名、image；扩展名按真实媒体类型，不跟建议名走。默认目录是会话 cwd，取消不报错，成功不弹提示；取字节或写盘失败才提示。

## 原图浮层的缩放、拖动与复原

原图浮层（[Images.tsx](<../src/webview/components/Images.tsx>)）支持滚轮缩放与左键拖动，纯几何在 [imagePreview.ts](<../src/webview/imagePreview.ts>)。

- 倍率 1 = 图片适配浮层内容区；向上滚放大、向下滚缩小，倍率夹在 0.25–8。缩到 1 以下时图片仍居中，只是变小。
- 缩放以光标为锚点：滚轮之后，光标下的图片细节留在原处。平移受边界约束，最多把放大后多出来的那一半移出去，不会把图拖丢或让一侧露出大片背景。
- 左键拖动只在放大后成立；缩到适配视口或更小时没有可拖余量，指针按下不接管。拖动结束补发的 click 不关闭浮层。
- 右键菜单的「复原」只在原图浮层里出现，把倍率与平移一起清零；缩略图菜单没有这一项。菜单只调 `resetImagePreviewView` 端口，不直接持有浮层组件状态。

滚轮监听必须用原生 `addEventListener(..., { passive: false })` 并 `preventDefault`：React 的 `onWheel` 在根节点上是被动监听，拦不住 webview 的滚动与浏览器缩放。

## 回归

- [contextMenu.test.ts](<../scripts/contextMenu.test.ts>)：判定矩阵、引用落点、建议文件名；调用真实快捷复制处理器，覆盖 Ctrl / Cmd、跨消息空白换行保真、编辑焦点、组合键、组字、重复事件、选区包含性与空选区让路。
- [copyFeedback.test.ts](<../scripts/copyFeedback.test.ts>)：`copy` 帧唯一发射点、复制按钮与 `CopyButton` / `IconCopyButton` 的清点、状态机只有一份，以及非按钮入口提示的落点、替换与自动消失。
- [imagePreview.test.ts](<../scripts/imagePreview.test.ts>)：缩放方向与上下限、光标锚定、拖动边界、复原端口，以及滚轮 / 指针 / 菜单 / 样式接线。
- [imageFiles.test.ts](<../scripts/imageFiles.test.ts>)：data URL 白名单、上限与文件名。
- [styles.test.ts](<../scripts/styles.test.ts>)：document 接取、无抽屉重复处理、浮层装配、视口定位、图片层之上与一行截断。
