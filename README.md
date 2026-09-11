# DSH Chat

在 VS Code 里用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）对话的第三方扩展。

`dsh web` 在后台运行，**界面由扩展自己绘制**——不嵌入浏览器页面，也不是网页端的复刻。
界面语言与交互遵循 [Continue](https://github.com/continuedev/continue) 的设计取向
（无气泡的消息流、单行可折叠的过程信息、带缺口状态条与流式描边的输入框），
会话能力则全部来自 dsh。

[English](#english) | 简体中文

---

## 特性

**会话与对话**

- 自动拉起并连接本机 `dsh web`，断线指数退避重连，长活流自动重开
- 会话列表（按今天/更早分组、可搜索）、新建、切换、历史回放
- 流式对话：正文逐 token 上屏，思考独立成块并在结束后自动收起
- 工具调用压成单行（读取 / 写入 / 编辑 / 运行 / 搜索…），点开查看完整参数与结果
- 读取节点只读了一段时，行号缀在文件名后（`…/controller.ts:100-120`）；该后缀不参与
  压缩，窄侧栏下宁可截断路径也保住行号——一眼看出模型是读了整个文件还是只扫了一段
- **自动载入的提示词可见**：系统提示词、插件注入（MCP 状态、记忆召回…）、项目指令
  （AGENTS.md）、技能目录都作为节点出现在对话里，默认收起、标注来源与字数，点开看全文
- 运行中的节点（构建等长任务）：圆点与思考节点同样呼吸发光，展开区显示完整命令与
  **每秒跳动的实时耗时**，随时能确认它还在跑
- 编辑类节点（`edit` / `write` / `str_replace`）展开时渲染为**结构化 diff**：
  窄对话框单栏、宽对话框左右对照（`dshChat.diffLayout` 可选自适应 / 固定单栏 / 固定双栏）
- 审批与提问卡片：允许 / 拒绝；未识别的交互事件一律放行，避免把 Agent 挂住
- 代码块卡片：复制、插入当前编辑器、语言标注、长块折叠
- 停止生成（按钮或 Esc）；**队列非空时，Esc 会中止当前轮并把队首消息接着发出去**
  （提示文案随之变为「按 ESC 可中止并发出排队消息」）；排队消息逐条列出，可直接
  「取回重新编辑」（内容回到输入框，附件一并还原）或单独取消

**输入与上下文**

- 输入 `/` 弹出斜杠命令菜单，继续输入即过滤，↑↓ 选择、Enter 确认
- 输入 `@` 弹出文件候选（含目录），选中即作为上下文附件
- 回形针按钮是**通用文件入口**，按内容分派：能内嵌的（合法图片 / 合法 UTF-8 文本且
  不过大）成为附件随消息发送；**不能内嵌的（目录 / 二进制 / 非 UTF-8 / 过大 /
  读不出来）把带双引号的路径插到输入框光标处**，而不是做一个读不出内容的芯片
  （模型不支持图片输入时，图片也走这条路径）；选区、拖拽同样归入附件
- 目录单独入口（命令面板「添加文件夹到对话」或资源管理器右键文件夹）：
  VS Code 的文件对话框在 Windows/Linux 上**不能同时**选文件与目录，同时开只会
  变成目录选择器、文件全被过滤，所以两者必须分开
- 二进制 / 非 UTF-8 / 过大的文件不会只发路径给模型了事：路径以双引号包裹插进输入框，
  你能看见、能编辑，模型也拿得到。判定口径与 dsh 自己的 `read` 工具一致
  （前 8KB 含 NUL 即二进制，否则要求严格 UTF-8）
- 模型与思考档位切换：4 档及以下一行；5/6 档固定分两行且均匀（5 → 3+2，6 → 3+3，
  用 grid 定列，上下两行列宽对齐）
- 权限模式切换：仅可查看 / 工作区内修改 / 完全权限（启用完全权限前有风险确认）

**面板**

- **历史对话**：分组、搜索、当前会话高亮
- **子代理**：列出当前会话的子代理，点进去查看它的完整对话记录
- **后台任务**：bash / pwsh / 子代理任务的状态、起止时间、耗时与明细
- **设置**：按服务端 schema 渲染全部命名空间（字符串 / 数字 / 布尔 / 枚举表单，
  复杂结构走 JSON 编辑），支持逐字段保存、整组重置、密钥写入（不回显）、
  「需重启生效」标注

**其它**

- 中英双语界面，跟随 VS Code 显示语言
- 活动栏与辅助侧栏两种容器，另可在编辑器区打开独立面板
- dsh 特有信息（token 用量、回合耗时）收进折叠行，默认不打扰
- VS Code 非正常关闭留下的 dsh 残留进程会在下次启动时被识别并清理

## 安装

### 从 VSIX

```bash
npm install
npm run package        # 产出 Releases/dsh-chat-<version>.vsix
```

VS Code → 扩展 → `…` → 从 VSIX 安装 → 选择产物 → 重载窗口。

### 从源码调试

```bash
npm install
npm run watch          # 增量构建
```

用 VS Code 打开本仓库，按 `F5` 启动扩展开发宿主。

### 前置条件

- VS Code ≥ 1.101（辅助侧栏容器需 ≥ 1.106，旧版本自动回退到活动栏）
- 本机可运行 `dsh`（未安装时扩展会回退到 `npx --yes @deepseek-ai/dsh@latest`）
- dsh 已配置模型凭据

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dshChat.url` | 空 | 已运行的 `dsh web` 地址；留空则由扩展自行启动并管理服务器 |
| `dshChat.autoStart` | `true` | 启动 VS Code 时自动连接 |
| `dshChat.command` | `dsh` | 启动命令（找不到时回退 `npx`） |
| `dshChat.startTimeoutSec` | `90` | 等待服务器就绪的秒数 |
| `dshChat.openPanelOnStartup` | `false` | 启动时在编辑器区打开对话面板 |
| `dshChat.diffLayout` | `auto` | 编辑类节点的 diff 排版：`auto`（窄单栏 / 宽双栏）、`unified`（固定单栏）、`split`（固定双栏） |

### 外部服务器与访问令牌

`dshChat.url` 指向别人启动的 `dsh web` 时，该服务器若要求授权，扩展会弹框要求
输入访问令牌（就是启动 `dsh web` 时打印在 URL 里 `?token=` 之后那一段）。
取消输入时对话面板会给出「输入令牌」按钮，也可以用命令面板的
**DSH: 输入访问令牌** 随时重填。扩展自行启动的服务器不需要手动填：令牌由扩展
从子进程日志里解析。

**关于令牌刷新**：启动令牌是服务端**每次启动随机生成**的，存下来下次必然失效。
所以扩展存进 SecretStorage（不写 `settings.json`）的不是令牌，而是用它换来的
**会话 cookie**——cookie 的签名密钥存在服务端凭据库里，跨重启不变，有效期默认
30 天（由服务端 `cookieMaxAgeDays` 配置）。因此：

- 重启你自己的 `dsh web` 之后**不需要重新输入令牌**；
- 换机器、改端口、清空 DSH home 或 cookie 过期时才会再要一次。

> 实测记录见 `scripts/cookieSurvivesRestart.ts`：同一端口重启后旧令牌失效、旧 cookie 仍可鉴权。

### 残留进程检测

VS Code 正常关闭时扩展会连带结束自己拉起的 `dsh web` 进程树；但崩溃或强杀时
退出钩子不会执行，Windows 上就会留下 `node.exe` 孤儿进程。扩展每次启动服务器
都会写一张进程租约（`~/.dsh-chat/servers/`），下次激活时扫描：宿主进程已经
消失、而 dsh 进程还在的，确认命令行后自动清理并提示。手动入口是命令面板的
**DSH: 清理残留进程**，**DSH: 显示诊断信息** 会列出当前发现的残留进程。

两个实现要点：

- **判定「是不是 dsh」要起 PowerShell，所以整条链路是异步的**。Windows 上一次
  PowerShell 启动约 1.5s，用同步调用会把扩展宿主的主线程整个卡住（启动时表现为
  界面迟滞）。现在同步段只读租约文件，进程查询与 `taskkill` 一律 await；
  并发的扫描共享同一次在途查询，不会因为异步化而起两倍解释器。
- **只有确认命令行里确实是 dsh 才会杀**。拿不到命令行时按「不杀」处理——
  那恰好是最无法排除「pid 已被系统回收」的情形，此时动手等于闭着眼睛杀进程。
  判定写成「肯定证据才杀」（`=== true`）而不是「否定证据才跳过」（`!== false`），
  因为后者会让「拿不到命令行」这一态漏过去。

## 工作原理

1. 扩展启动时运行 `dsh web --port 0 --no-open`：端口交给操作系统分配（不会撞端口），
   也不会抢占你的浏览器。
2. 从子进程输出解析 `dsh web: http://127.0.0.1:<port>/?token=…`，
   用该启动令牌换取签名 cookie——0.1.2 起 `/api` 与 WebSocket 握手都需要它。
3. 一元调用走 `POST /api/<method>`；实时内容走单条 WebSocket `/api/remote.mux`
   上的 `session/follow` 流（带 `assistantStream` 才有逐 token 增量）。
4. 事件流在宿主侧折叠成视图模型后才发给界面，**界面代码不认识 dsh 协议**——
   协议变更只影响适配层。

不想让扩展自行启动服务器：把 `dshChat.url` 指向你已经在跑的 `dsh web` 即可。

### 代码结构

```
src/
  extension.ts          命令注册与激活
  chatView.ts           webview 容器（CSP/nonce/资源加载/消息转发）
  shared/               宿主与界面共用的视图模型与 IPC 协议
  dsh/
    protocol.ts         线格式类型与端点参数名
    client.ts           HTTP RPC + WebSocket 多路复用流 + 认证
    serverManager.ts    拉起/探测/停止 dsh web，解析端口与令牌
    adapter.ts          事件流 → 对话记录（流式叠加层与去重）
    controller.ts       会话总控：连接、发消息、审批、模型、附件、面板
    settingsSchema.ts   设置 schema → 表单字段（纯函数，可离线测试）
  webview/
    App.tsx             界面骨架与顶栏
    components/         Composer / Message / Rows / Panels / History / Markdown
    styles/             tokens.css（设计 token）+ app.css（组件样式）
    texts.ts            中英文案词典
    markdown.ts         Markdown → 净化 HTML + 代码块切分
docs/
  continue-ui-spec.md   Continue 界面规格（px 级，带上游行号）
  dsh-server-api.md     DSH 服务端协议契约（带上游包名与行号）
```

## 开发

```bash
npm run watch          # 增量构建
npm run typecheck      # 宿主与 webview 两套 tsconfig（并行跑）
npm run test           # 离线单元断言（14 套，并行跑）
npm run build          # 生产构建
npm run package        # 打成 vsix
node scripts/bench.mjs # 开发循环耗时分解（哪一步慢）
```

> 构建本身很快（`npm run build` 约 0.7s）。历史上真正拖慢验证循环的是
> `token-cleanup` 那套断言：它在 Windows 上**逐个 pid** 起 PowerShell 取命令行，
> 而每次查询的代价几乎全在解释器启动上（实测单查一个 pid ≈1600ms，
> 一次查全部进程 ≈1800ms）。改成「一次取回全部进程的命令行」并取消固定 sleep、
> 再并行化之后，`npm test` 从约 14.6s 降到约 6s。
> 同样的问题也会拖慢扩展启动时的残留进程清理，所以这是产品与开发共同受益的改动。

### 验证手段

**端到端冒烟测试**（真实拉起 `dsh web`、真实调一次模型，不需要 VS Code）：

```bash
npm run smoke
```

覆盖：启动与令牌解析 → 签名 cookie → 会话列表 → 模型目录 → 新建会话
→ `$events` 审批通道 → 斜杠命令 → 发消息与流式 → 事件→视图转写
→ 历史回放 → 中途停止 → 审批应答 → 权限投影 → 模型切换。
测试会遍历模型目录挑选**本机真正可用**的模型，并在结束时还原被改动的
`agent-default-model` 设置。

**界面预览**（浏览器里加载真实 webview 产物，改样式时最快）：

```bash
npm run preview        # 打开 http://127.0.0.1:8777/test/preview.html
                       # 加 ?locale=en 预览英文界面
```

**专项诊断脚本**（由 `npm run build:scripts` 产出到 `build/`）：

| 脚本 | 用途 |
| --- | --- |
| `node build/probe.mjs <url> <token>` | 对一个运行中的服务器打印会话、投影与控制流状态 |
| `node build/model-switch.mjs` | 模型切换各条路径（跨 provider、沿用档位、不存在的模型） |
| `node build/panels-probe.mjs` | 子代理 / 后台任务 / 命令列表 / `@` 提及 / 设置表单的数据源 |
| `node build/schema-debug.mjs` | 设置 schema → 表单字段的离线转换结果 |
| `node build/dump-settings.mjs` | 转储全部设置命名空间到 `build/settings-schema.json` |
| `node build/set-default-model.mjs …` | 还原部署默认模型 |
| `npm run e2e:queue-esc` | 「Esc 中止并把队首消息发出」的端到端验证（真实起 dsh，断言发出且不重复、顺序正确） |
| `node build/cookie-survives-restart.mjs` | 验证「启动令牌每次刷新，但会话 cookie 跨重启仍有效」 |
| `node build/system-prompt-probe.mjs` | dump 真实会话里自动载入的提示词（系统提示词 / 插件注入 / 项目指令 / 技能目录）的来源、字数与是否重复 |
| `node build/effort-probe.mjs` | 打印各模型真实有几个思考档位（排版依据，别照预览夹具猜） |
| `node build/read-range-probe.mjs` | 真实跑一次 read，验证 `tool/result.meta` 形状与行号标注 |

> `session/selectModel` 会写回 `agent-default-model` 设置（dsh 服务端自身行为）。
> 会切模型的脚本都在结束前自动还原，避免污染本机默认。

## 已知限制

- 不做回合级 Git 回退、子代理追问、计划模式的确认交互、轨迹视图。
- 文件附件以文本内联方式注入上下文（未走 `session/uploadFileBinary` 上传通道）。
- 上下文占用条需要服务端给出 `contextPressure.contextWindow`；没有该投影时不显示。
- 在模型胶囊里换模型会写回部署默认模型（与 dsh 网页端行为一致）。
- 服务端协议无版本协商。本项目针对 DSH **0.1.5-rc.1** 实测；0.1.2 的已知差异
  只有 `commands/execute` 的附件参数名（`images` → `submittedAttachments`），
  已按「新名优先、参数不匹配则回退并记忆」处理。

## 归属与许可

本项目以 **MIT** 许可发布，见 `LICENSE`。

它建立在他人工作之上，**完整、逐项的披露见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)**，
一句话概括：

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**（MIT）——
  线协议类型的事实来源，`src/dsh/protocol.ts` 取自官方包的 `.d.ts` 声明。
- **[DeepSeek-Harness-for-VS-Code](https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code)**（MIT）——
  本项目 DSH 传输层（认证、`remote.mux` 流注册表、重连行为、服务器生命周期）
  是在阅读该扩展的客户端后编写的，**继承其结构写法**；界面层未采用其实现。
- **[Continue](https://github.com/continuedev/continue)**（Apache-2.0）——
  界面遵循其视觉与交互设计，按书面规格重新实现；**未拷贝其源码**，
  也未使用其名称或 Logo。

欢迎 issue 与 PR。提交前请确保 `npm run typecheck` 与 `npm run smoke` 通过。

---

<a id="english"></a>

# DSH Chat

A third-party VS Code extension for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

The `dsh web` server runs in the background and **the extension draws the conversation
itself** — no embedded browser page, and not a replica of the web UI. The interface
follows [Continue](https://github.com/continuedev/continue)'s design language
(bubble-less messages, single-line collapsible process rows, a notched composer with a
rainbow outline while streaming), while every conversational capability comes from dsh.

## Features

**Conversation** — auto-start and connect to a local `dsh web` with exponential-backoff
reconnect and automatic stream recovery; session list (grouped by today/earlier,
searchable), new chat, switching, history replay; token-by-token streaming with reasoning
in its own collapsible block; **auto-loaded prompts are visible** — the system prompt,
plugin injections (MCP status, memory recall …), workspace instructions (AGENTS.md) and the
skill catalog each appear as a node labelled by origin with its size, collapsed by default
and expandable to the full text; tool calls collapsed to one line with full arguments and
results on click — a `read` that covered only part of a file shows the line range after the
filename (`…/controller.ts:100-120`), and that suffix never shrinks, so a narrow sidebar
truncates the path rather than the range; a call that is still running (a build, say) keeps
a breathing glow on its status line like the thinking node, and expanding it shows the
untruncated command plus a **live elapsed timer**, and edit-style calls (`edit` / `write` / `str_replace`) expanding into a
structured diff — single column in a narrow panel, side-by-side when wide
(`dshChat.diffLayout`: adaptive / always single column / always side-by-side); approval and
question cards (unknown interaction events are always
passed through so the agent never hangs); code blocks with copy/insert, language label and
collapsing for long blocks; stop generation (button or Esc) — when messages are queued, Esc
also stops the current turn and sends the frontmost queued message; queued messages are
listed individually so each can be taken back into the composer for editing (text and
attachments restored) or cancelled on its own.

**Input and context** — type `/` for a slash-command menu that filters as you type
(↑↓ to move, Enter to confirm); type `@` for file mentions (files *and* folders). The
paperclip button is a **single file entry point** that routes by content: what can be
inlined (a valid image, or valid UTF-8 text within the size cap) becomes an attachment sent
with the message, while what cannot (a folder, a binary, non-UTF-8 text, an oversized file,
an unreadable one) has its **double-quoted path inserted at the caret in the input box**
instead of becoming an attachment chip whose contents could never be read — images go that
way too when the active model takes no image input. Selections and drag-and-drop land in the
same attachment list; the test is the same one dsh's own `read` tool applies (a NUL byte in
the first 8 KB means binary, otherwise strict UTF-8 is required). Folders have their own
entry point (the **DSH: Add Folder to Chat** command, or right-clicking a folder in the
Explorer), because VS Code's file dialog **cannot** be both a file and a folder selector on
Windows/Linux — enabling both silently degenerates into a folder picker and filters every
file out. Model and thinking-effort switching (4 tiers or fewer stay on one row; 5–6 tiers
are forced onto two evenly split rows — 3+2 and 3+3 — using a fixed-column grid so the two
rows line up); permission mode switching (Read Only / Workspace Write / Full Access, with a
risk confirmation before Full Access).

**Panels** — **History** (grouped, searchable), **Subagents** (list the session's
subagents and open their full transcripts), **Background jobs** (state, start/end, duration
and detail), **Settings** (every namespace rendered from the server schema: string/number/
boolean/enum forms, JSON editing for complex structures, per-field save, per-group reset,
secret writes without echo, "needs restart" badges).

**Other** — bilingual UI following the VS Code display language; activity bar and
secondary sidebar containers plus a standalone editor-area panel; dsh-specific stats
(token usage, turn duration) tucked into collapsible rows; leftover `dsh web` processes from
an unclean VS Code shutdown are detected and cleaned up on the next launch.

## Install

```bash
npm install
npm run package        # produces Releases/dsh-chat-<version>.vsix
```

Then in VS Code: Extensions → `…` → Install from VSIX → reload.

Prerequisites: VS Code ≥ 1.101 (secondary sidebar needs ≥ 1.106, otherwise the activity
bar is used); `dsh` runnable locally (falls back to `npx`); model credentials configured.

## How it works

The extension spawns `dsh web --port 0 --no-open` (the OS picks the port, so it never
collides and never steals your browser), parses the launch token from the child's output to
exchange for a signed cookie, then talks to the server over `POST /api/<method>` for
one-shot calls and a single multiplexed WebSocket at `/api/remote.mux` for streaming.
Events are folded into a view model on the host side before reaching the webview, so **the
UI code knows nothing about the dsh protocol**.

Point `dshChat.url` at an existing server if you would rather manage it yourself. If that
server requires authorization the extension prompts for the access token (the `?token=`
value from the `dsh web` launch URL), verifies it and keeps the resulting **session cookie**
in VS Code's SecretStorage — or use **DSH: Enter Access Token** from the command palette.
Servers the extension starts itself need no manual token: it parses one from the child
process output.

The launch token is regenerated randomly on **every** server start, so it is never worth
persisting; the signed cookie is, because its signing secret lives in the server's
credential store and survives restarts (30 days by default, the server's
`cookieMaxAgeDays`). Restarting your own `dsh web` therefore does not ask for the token
again.

Leftover processes: every launch writes a process lease under `~/.dsh-chat/servers/`; on the
next activation the extension looks for dsh processes whose owning VS Code window is gone,
confirms the command line and kills the tree, and reports what it found. **DSH: Clean Up
Leftover Processes** does it on demand, and **DSH: Show Diagnostics** lists what is
currently detected.

Two things worth knowing about the implementation. The whole chain is **asynchronous**,
because deciding "is this command line dsh?" needs PowerShell and a single Windows PowerShell
start-up costs about 1.5s — a synchronous call would freeze the extension host's main thread
(visible as UI lag during activation), so only the lease-file reads are synchronous and every
process query and `taskkill` is awaited; concurrent scans share one in-flight query so
becoming async does not double the number of interpreters. And a process is killed **only when
its command line is positively confirmed to be dsh**: when the command line cannot be read the
extension does not kill, since that is exactly the case where the PID may already have been
recycled, which is why the check is written as "kill on positive evidence"
(`confirmed === true`) rather than "skip on negative evidence" (`confirmed !== false`).

## Licence and attribution

MIT — see `LICENSE`. This project builds on the work of others; the full itemised
disclosure is in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). In short: protocol
types come from DeepSeek Harness (MIT); the DSH transport layer inherits its structural
approach from DeepSeek-Harness-for-VS-Code (MIT); the interface follows Continue's design
(Apache-2.0) and was re-implemented from a specification without copying its source.
