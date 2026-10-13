# DSH Chat

![DSH Chat 在 VS Code 中 / DSH Chat in VS Code](docs/demo.png)

在 VS Code 中使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的第三方前端。扩展自绘 webview，不嵌入官方网页；会话、模型与工具能力由 DSH 提供，数据语义与官方 Web UI 对齐。

[English](#english) | 简体中文

## 安装

先安装 DSH 并按首次使用引导配置模型凭据：

```bash
npm i -g @deepseek-ai/dsh
```

需要 VS Code ≥ 1.101；辅助侧栏容器需要 ≥ 1.106，旧版回退到活动栏。

从源码打包：

```bash
npm install
npm run package  # Releases/dsh-chat-<version>.vsix
```

在 VS Code「扩展 → … → 从 VSIX 安装」中选择产物，然后重载窗口。源码调试用 `npm run watch`，打开仓库后按 `F5`。

## 连接

开启 `dshChat.autoConnect` 时，自动选路为：

| 条件 | 行为 |
|---|---|
| 内部 DSH 已运行 | 连接扩展托管的守护进程与 `dsh web`，自动取得启动令牌 |
| 内部未运行、外部可达 | 连接 `dshChat.url`；需要授权时输入启动 URL 的 `?token=` 值，也可用「DSH: 输入访问令牌」 |
| 两者均不可用 | 按 `dshChat.command` 启动内部 DSH |

- 关闭自动连接后只显示按钮；显式连接内部仍会在必要时启动后台。「启动内部」与「连接内部」是同一逻辑；连接外部不启动进程，未配置 URL 时置灰。
- 选定目标后重连只重试该目标，不自动切换服务器。切换目标须手动操作，会切换会话列表。
- 连接中提供「停止连接」与「查看日志」，持续重试没有自动时限；启动或认证失败则回到按钮态，原因见连接条与日志。
- 相同启动命令的 VS Code 窗口共用后台；最后一个窗口断开后默认空闲 10 秒才退出。在此宽限期内重载不会中断后台。
- `url` 与 `command` 只能在用户设置中修改，工作区不能覆盖，修改后须重载窗口；其它设置即时生效。

## 配置

| 键 | 默认 | 作用 |
|---|---|---|
| `dshChat.url` | `http://127.0.0.1:3080` | 外部 DSH 的备用地址 |
| `dshChat.command` | `dsh web --port 0 --no-open` | 内部启动命令，原样执行，不追加参数 |
| `dshChat.supervisorIdleSec` | `10` | 无窗口连接后的退出宽限期，5–600 秒 |
| `dshChat.autoConnect` | `true` | 自动连接；关闭后等待手动操作 |
| `dshChat.diffLayout` | `auto` | 编辑 diff：窄单栏 / 宽双栏，或固定 `unified` / `split` |
| `dshChat.language` | `auto` | 聊天语言：跟随 VS Code，或 `zh-cn` / `en` |
| `dshChat.fontSize` | `0` | 整数 px；`0` 跟随 VS Code，非零值至少按 8 px 显示 |
| `dshChat.questionBatch` | `3` | 一次展开的题数；超出时依次问答，`0` 全部展开 |
| `dshChat.turnProcessThreshold` | `5` | 结束后的过程段达到该工具数才折叠；含子代理派发；`0` 不折，`1–2` 总折，单调用段仍平铺 |
| `dshChat.agentPreset` | 空 | 新会话预设 id 或中英文显示名；空值使用服务端默认预设 |

## 使用

### 面板与会话

可在活动栏、辅助侧栏或编辑器中使用。命令「DSH: 在编辑器中打开对话」与界面头部按钮将对话开到已有编辑器分组；来源已在编辑器时沿用同一分组。编辑器标题栏的鲸鱼按钮在当前分组新建会话。

历史列表只显示当前工作区的会话，支持新建、归档、删除与「从这里分支」；分支标题带「分支: 」前缀。子代理入口可查看执行记录，一次性子代理只读，可继续子代理支持续聊。后台任务可展开输出；轨迹提供账本、时间线与详情检查器。服务端设置通过「在浏览器中打开」进入官方 Web UI。

### 输入、引用与附件

- `/` 打开命令与技能菜单；`@` 引用文件、目录或历史会话，写入 `@path`、`@dir/` 或 `@[标题](dsh-session:…)`，由模型自行读取，不占附件通道。
- 目录行主体进入目录，右侧「整个目录」按钮引用目录；键盘用 Enter 引用、Tab 进入。已发送的引用直接点击；草稿引用按住 `Ctrl` 点击。会话引用在新标签页打开，沿用编辑器分组规则。
- `Alt+Shift+2` 将编辑器选区加入为 `@path#L12-L40` 引用。
- 回形针选择文件：图片发送为内容块，其余文件上传，芯片显示上传状态。此路径通道不受拖放的 8 MB 限制。
- 拖放须按住 `Shift`：文件走字节通道，单文件最多 8 MB，不支持目录。Windows 复制文件或目录后粘贴可由宿主取回真路径：文件走附件、目录变成正文引用；其它平台与截图粘贴回退到同一字节通道。纯文本粘贴不变。粘贴进来的图片按会话内序号命名（中文界面 `图1.png`、英文界面 `image1.png`），编号只增不回收，便于在对话里直接指代。
- 用户、模型与工具返回的图片，以及交付或本轮生成的图片文件均可预览。正文本地图片仅在会话工作目录内读取；HTTPS 图片不发送 referrer。点击看原图，`Esc` 关闭。

### 生成与交互

工具行可展开完整参数、结果与结构化 diff，运行时显示耗时。审批、问卷和计划审阅有专属卡片；问卷可放弃整组回答。未被图片、菜单或编辑操作消费的 `Esc` 停止当前轮；队列非空时会按原序重发待发消息。

界面提供中英双语、上下文占用、目标条与轮次导航。窗口布局与会话身份存于 VS Code 工作区缓存，不写入项目；消息记录从 DSH 恢复，展开状态保留在界面内存中，不保证跨重载恢复。Markdown 支持任务列表、表格与脚注，不提供公式渲染或代码高亮。

## 开发与验证

先读 [AGENTS.md](AGENTS.md)。设计与契约入口见 [docs/README.md](docs/README.md)，测试与诊断入口见 [scripts/README.md](scripts/README.md)。常规验证不调用模型：

```bash
npm run typecheck
npm test
npm run build
```

`npm run preview` 预览 webview；`npm run package` 打包。`smoke`、真实探针与 e2e 会启动 DSH 或调用模型，运行前须取得用户当次明确批准。

## 已知限制

- 无协议版本协商；当前核对基准与兼容边界见 [dsh-compat.md](docs/dsh-compat.md)。
- 停止刻意采用「摘空队列 → cancel → 按原序重发」：历史实测中只 cancel 不可靠地接续队列。
- 生成中的正文会重建 DOM，点击文件链接可能被增量刷新吞掉；轮次结束后再点。后台任务分区、ANSI 着色与部分官方统计展示尚未实现。
- 拖放受 VS Code iframe 门控与字节通道限制；其它平台的大文件请用回形针，目录请用 `@`。
- 面板恢复依赖 VS Code 工作区缓存与 `window.restoreWindows`。

## 许可与归属

[MIT](LICENSE)。来源与取舍详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：协议类型来自 DeepSeek Harness，传输层结构继承自 DeepSeek-Harness-for-VS-Code；早期视觉参考 Continue，未复制其源码。

---

<a id="english"></a>

# DSH Chat

A third-party VS Code frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It draws its own webview rather than embedding the official page. DSH supplies sessions, models and tools; data semantics follow the official Web UI.

## Install

Install DSH and follow its first-use credential setup:

```bash
npm i -g @deepseek-ai/dsh
```

Requires VS Code ≥ 1.101. The secondary-sidebar container requires ≥ 1.106; older versions fall back to the activity bar.

Build from source:

```bash
npm install
npm run package  # Releases/dsh-chat-<version>.vsix
```

Choose Extensions → … → Install from VSIX, then reload. For source debugging, run `npm run watch`, open the repository in VS Code and press `F5`.

## Connection

With `dshChat.autoConnect` enabled:

| Condition | Action |
|---|---|
| Internal DSH is running | Connect to the extension-managed guardian and `dsh web`; obtain the launch token automatically |
| No internal DSH, external is reachable | Connect to `dshChat.url`; when required, enter the launch URL's `?token=` value, or use **DSH: Enter Access Token** |
| Neither is available | Start internal DSH using `dshChat.command` |

- When auto-connect is off, wait for manual action. Explicitly connecting internally still starts a backend if needed; “start” and “connect” share this logic. Connecting externally never starts a process; its button is disabled without a URL.
- Reconnection sticks to the chosen server. Switch targets manually; doing so changes the session list.
- While connecting, use “Stop connecting” or “Show logs”. Retries have no automatic deadline; launch and authentication failures return to the buttons with an error reason.
- Windows with the same launch command share a backend. It exits after the last connection has been idle for 10 seconds by default; reloading within that grace period leaves it running.
- `url` and `command` are user-only, machine-scoped settings and require a window reload. Other settings apply immediately.

## Settings

| Key | Default | Purpose |
|---|---|---|
| `dshChat.url` | `http://127.0.0.1:3080` | Fallback external DSH address |
| `dshChat.command` | `dsh web --port 0 --no-open` | Internal launch command, executed verbatim |
| `dshChat.supervisorIdleSec` | `10` | Exit grace period with no connected windows, 5–600 seconds |
| `dshChat.autoConnect` | `true` | Connect automatically; when off, wait for manual action |
| `dshChat.diffLayout` | `auto` | Narrow unified / wide split diff, or fixed `unified` / `split` |
| `dshChat.language` | `auto` | Follow VS Code, or use `zh-cn` / `en` |
| `dshChat.fontSize` | `0` | Integer px; `0` follows VS Code, nonzero values display at least 8 px |
| `dshChat.questionBatch` | `3` | Questions shown together; larger sets run sequentially, `0` shows all |
| `dshChat.turnProcessThreshold` | `5` | Fold a finished process segment at this many tool calls, including subagent dispatches; `0` never folds, `1–2` always folds, single-call segments stay flat |
| `dshChat.agentPreset` | empty | New-session preset id or Chinese/English display name; empty uses the server default |

## Use

### Panels and sessions

Use the activity bar, secondary sidebar or editor area. **DSH: Open in Editor** and the header button open a tab in an existing editor group; an editor source keeps its own group. The whale button in the editor title bar creates a session in the current group.

History is scoped to the current workspace and supports new, archive, delete and branch-from-here; branch titles have a “Branch: ” prefix. Open subagents to view their records: one-shot agents are read-only, continuable agents support follow-up chat. Jobs expose output, and Trajectory provides a ledger, timeline and inspector. “Open in browser” leads to the official server settings.

### Input, references and attachments

- `/` opens commands and skills; `@` references files, folders or past sessions using `@path`, `@dir/` or `@[title](dsh-session:…)`. The model reads references itself; they are not attachments.
- A folder row navigates into it; its “Entire folder” button references it. Enter references, Tab navigates. Click references in sent messages directly; hold `Ctrl` to click draft references. Session links open a new tab using the same editor-group rules.
- `Alt+Shift+2` inserts an editor selection as `@path#L12-L40`.
- The paperclip sends images as content blocks and uploads other files, showing upload status on their chips. This path channel is not subject to the drop channel's 8 MB cap.
- Hold `Shift` to drop files. Drops use bytes, allow up to 8 MB per file and do not support folders. On Windows, pasting copied files/folders retrieves their paths: files become attachments, folders become text references. Other platforms and pasted screenshots use the same byte channel. Plain-text paste is unchanged. Pasted images are named by session order (`图1.png` in the Chinese interface, `image1.png` in the English one); numbers only grow and are never reused, so you can refer to an image by name in the conversation.
- Preview images from users, models, tools, deliverables and files generated this turn. Local answer images are read only inside the session working directory; HTTPS images send no referrer. Click for the original; `Esc` closes it.

### Generation and interaction

Expand tool rows for full arguments, results and structured diffs; running tools show elapsed time. Approvals, questionnaires and plan reviews have dedicated cards, and a questionnaire can be abandoned as a group. An `Esc` not consumed by an image, menu or edit stops the turn; queued messages are then resent in their original order.

The UI offers Chinese/English, context usage, goals and turn navigation. Window layout and session identity are cached per workspace by VS Code, not written to project files. Message history is restored from DSH; expansion state is held in UI memory and is not guaranteed to survive a reload. Markdown supports task lists, tables and footnotes, but not math rendering or code highlighting.

## Development

Read [AGENTS.md](AGENTS.md) first. See [docs/README.md](docs/README.md) for designs and contracts, and [scripts/README.md](scripts/README.md) for tests and diagnostics. Routine validation makes no model calls:

```bash
npm run typecheck
npm test
npm run build
```

Use `npm run preview` for the webview and `npm run package` for a VSIX. Smoke tests, live probes and e2e may start DSH or call models; obtain explicit user approval for each invocation.

## Limitations

- No protocol version negotiation; see [dsh-compat.md](docs/dsh-compat.md) for the current checked baseline and compatibility boundaries.
- Stop intentionally drains the queue, cancels and resends in order: historical probes did not reliably resume queued work after a bare cancel.
- Streaming text rebuilds its DOM, so an incremental update may swallow a file-link click; retry after the turn ends. Job sections, ANSI coloring and some upstream statistics remain unimplemented.
- Drops are constrained by VS Code's iframe gate and the byte channel. On other platforms, use the paperclip for large files and `@` for folders.
- Panel restoration depends on VS Code's workspace cache and `window.restoreWindows`.

## Licence and attribution

[MIT](LICENSE). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for sources and design choices: protocol types come from DeepSeek Harness; transport structure derives from DeepSeek-Harness-for-VS-Code; early visuals referenced Continue without copying its source.
