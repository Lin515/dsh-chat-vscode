# 会话右键菜单：原生菜单全局拦掉，正文与图片各给特化菜单

> 本文是**右键菜单**的口径与链路。改 `webview/contextMenu.ts`、
> `webview/imageClipboard.ts`、`webview/components/ContextMenu.tsx`、
> `dsh/imageBytes.ts`、`dsh/imageFiles.ts` 之前先读这一份。
> 用户 2026-09-23 立的口径（2026-09-12 那条「历史对话里不要右键菜单」是它的前身）。

## 一、为什么必须接管

webview 里的右键菜单是 **VS Code 自己弹的**：`webview/browser/pre/index.html` 监听
`contextmenu`，只有 `e.defaultPrevented` 为真时它才 `return`（否则调用
`did-context-menu` 弹原生菜单）。那份菜单是「剪切 / 复制 / 粘贴」——在这个界面里除了
复制都没有意义（正文不可编辑）。所以拦住它的唯一手段就是 `preventDefault()`，
特化的菜单本体得自己画。

## 二、**挂 `document`，不能挂 `window`**（踩过一次的坑）

VS Code 那个监听挂在**内层 iframe 的 `window`** 上，而且是创建 iframe 时**同步**注册的
（远早于我们的脚本）。同节点同阶段按注册顺序派发，所以挂在 `window` 上的接取**永远排在
它后面**：它先 `preventDefault()` 并弹菜单，我们再读 `defaultPrevented` 只剩「已被处理」，
接取等于没有（现象就是「改了没生效，还是原生那三条」）。

挂 `document` 则天然更靠近目标节点：冒泡时先于 `window` 触发；React 的事件委托在 `#root`
上、仍早于我们，于是轨迹时间线那种自己 `preventDefault()` 的特化处理照旧优先（我们读到
`defaultPrevented` 就让路）。

## 三、判据（`contextMenuKind`，纯函数，顺序即优先级）

| 落点 | 结论 |
|---|---|
| 可编辑元素（`input` / `textarea` / `contenteditable`） | **放行原生菜单**。自绘菜单做不了粘贴，吃掉它等于把粘贴删掉 |
| 图片（缩略图 / 原图浮层 / 正文与子代理记录里的图） | 自绘：「复制 / 保存」 |
| 会话正文区（`.chat-scroll`）里**有选中文字** | 自绘：「复制 / 引用」 |
| 右键落点**压在自己选中的文字上**（不限区域） | **放行原生菜单**（那里的 Copy 才真的有用） |
| 其余一切（正文区里没选区、头部、历史抽屉、子代理 / 后台任务面板、轨迹页……） | 拦掉，什么都不弹 |

细则：

- 选区**两端都必须在正文区里**才算「正文区的选区」（`chatSelectionText`）；放行原生菜单
  那条用的是 `selectionCovers(target)`（`Range.intersectsNode`）——选区在别处、落点没压上去
  时**不算**，否则「在抽屉里右键」会去复制正文里的选区；
- 抽屉**不再自己挂** `onContextMenu`（用户 2026-09-12 那版）：留着就是第二条口径，
  它会连「选中会话标题 → 右键复制」一起吃掉；
- 「引用」把选中文字以 **markdown 引用块**插到输入框光标处，**不自动发送**：引用块自己
  占整行（前面不是行首就补换行、后面补一个换行让光标落在块**之外**），落点算术见
  `composerCompletion.quoteBlock`。

## 三、图片「复制」在界面里做，「保存」在宿主做

**复制**必须是**图片本身**（能粘进微信 / Word），而扩展宿主写不了富剪贴板——扩展 API
只有 `env.clipboard.writeText`（纯文本），Electron 的 `clipboard` 在扩展宿主里拿不到。
VS Code 给 webview 的 iframe 显式开了 `clipboard-write`（同上那个 `index.html` 的 allow
列表），所以这条在界面里完成：`webview/imageClipboard.ts` 把 `<img>` 画到 canvas 上转成
PNG 再 `navigator.clipboard.write`。

- **必须转 PNG**：Chromium 的剪贴板写入只认 `image/png`，塞 `image/jpeg` 直接抛
  `NotAllowedError`；
- **跨域外链图复制不了**：没带 CORS 的图会污染画布，转 PNG 拿不到结果。系统菜单里那条
  「复制图片」是浏览器内部实现的，页面脚本没有这个能力——这里如实失败并提示一句；
- 文档失焦时 Chromium 的 `clipboard.write` 会**静默不写**（不报错）。用户点菜单时
  webview 必然有焦点，所以只当已知限制，不加额外处理。

**保存**必须由宿主做：界面弹不了系统对话框、也读不了磁盘，它的 CSP（`default-src
'none'`，连 `connect-src` 都没有）还 fetch 不了外链图。链路是
`saveImage` 帧 → `dsh/imageBytes.ts` 解析字节（`data:` 直接解码 / `http(s):` 拉一次）
→ `dsh/imageFiles.ts` 弹 `showSaveDialog`（默认落在会话工作目录）→ 写盘。

- 默认文件名的优先级：界面给的 `alt`（看着像图片文件名才给）→ 地址里的文件名 →
  `image`；**扩展名按真实媒体类型定**，不跟建议名走（建议名说 `.png` 而字节是 jpeg 时
  照它写会得到一个打不开的文件）；
- 保存成功**不弹提示**（路径是用户自己选的，与「复制成功不弹信息条」同一条口径），
  取不到字节 / 写盘失败才提示。

## 四、断言

- `scripts/contextMenu.test.ts`：判定矩阵、引用块落点算术、建议文件名的取舍；
- `scripts/imageFiles.test.ts`：data URL 解码白名单与上限、默认文件名规则；
- `scripts/styles.test.ts`（右键菜单两节）：接取挂在 `document` 上（挂 `window` 就等于没接）、
  抽屉不再留第二条口径、视口定位、压在原图浮层之上、条目文字一行截断，以及「挂了接取却
  忘了挂浮层」这种纯函数断言抓不到的静默失效。
