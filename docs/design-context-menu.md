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
| 图片（缩略图、原图、正文或子代理记录） | 自绘「复制 / 保存」 |
| 会话正文区内有选中文字 | 自绘「复制 / 引用」 |
| 其它区域的落点压在自己的选区上 | 放原生菜单，允许复制选区 |
| 其余 | preventDefault，不弹菜单 |

正文选区必须两端都在 `.chat-scroll`（chatSelectionText）。其它区域用 selectionCovers(target) / Range.intersectsNode 判断落点，不能因正文别处有选区就放行。

「引用」由 composerCompletion.quoteBlock 把选区插成整行 Markdown 引用块，不自动发送：需要时前补换行，后补换行使光标落在块外。

## 图片复制与保存

**复制**在界面完成：[imageClipboard.ts](<../src/webview/imageClipboard.ts>) 将 img 画到 canvas，转 PNG，再 navigator.clipboard.write。宿主只有纯文本剪贴板 API，webview iframe 允许 clipboard-write。

- Chromium 只收 image/png，直接写 image/jpeg 会抛 NotAllowedError。
- 未提供 CORS 的外链图片会污染 canvas，无法复制；如实提示失败。
- 文档失焦可能静默不写、不抛错；不能把无异常推广为系统剪贴板已落地的证明。

**保存**走 saveImage 帧 → [imageBytes.ts](<../src/dsh/imageBytes.ts>) 解 data URL / 拉 http(s) 字节 → [imageFiles.ts](<../src/dsh/imageFiles.ts>) 弹 showSaveDialog 并写盘。界面 CSP 不允许自行 fetch 外链或读写磁盘。

默认名字依次取有效图片 alt、地址文件名、image；扩展名按真实媒体类型，不跟建议名走。默认目录是会话 cwd，取消不报错，成功不弹提示；取字节或写盘失败才提示。

## 回归

- [contextMenu.test.ts](<../scripts/contextMenu.test.ts>)：判定矩阵、引用落点、建议文件名。
- [imageFiles.test.ts](<../scripts/imageFiles.test.ts>)：data URL 白名单、上限与文件名。
- [styles.test.ts](<../scripts/styles.test.ts>)：document 接取、无抽屉重复处理、浮层装配、视口定位、图片层之上与一行截断。
