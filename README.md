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
- 审批与提问卡片：允许 / 拒绝；未识别的交互事件一律放行，避免把 Agent 挂住
- 代码块卡片：复制、插入当前编辑器、语言标注、长块折叠
- 停止生成（按钮或 Esc），排队消息计数

**输入与上下文**

- 输入 `/` 弹出斜杠命令菜单，继续输入即过滤，↑↓ 选择、Enter 确认
- 输入 `@` 弹出文件候选（含目录），选中即作为上下文附件
- 图片、选区、文件、文件夹作为上下文；`@` 与拖拽入口
- 模型与思考档位切换（档位少时铺满、多时自动换行）
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
| `dshChat.defaultReasoningEffort` | 空 | 新会话默认思考深度 |
| `dshChat.openPanelOnStartup` | `false` | 启动时在编辑器区打开对话面板 |
| `dshChat.showUsageStats` | `true` | 折叠行里显示 token 与耗时 |

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
npm run typecheck      # 宿主与 webview 两套 tsconfig
npm run build          # 生产构建
npm run package        # 打成 vsix
```

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
in its own collapsible block; tool calls collapsed to one line with full arguments and
results on click; approval and question cards (unknown interaction events are always
passed through so the agent never hangs); code blocks with copy/insert, language label and
collapsing for long blocks; stop generation (button or Esc).

**Input and context** — type `/` for a slash-command menu that filters as you type
(↑↓ to move, Enter to confirm); type `@` for file mentions (files *and* folders); images,
selections, files and folders as context; model and thinking-effort switching (the effort
segments stretch to fill when few, wrap when many); permission mode switching
(Read Only / Workspace Write / Full Access, with a risk confirmation before Full Access).

**Panels** — **History** (grouped, searchable), **Subagents** (list the session's
subagents and open their full transcripts), **Background jobs** (state, start/end, duration
and detail), **Settings** (every namespace rendered from the server schema: string/number/
boolean/enum forms, JSON editing for complex structures, per-field save, per-group reset,
secret writes without echo, "needs restart" badges).

**Other** — bilingual UI following the VS Code display language; activity bar and
secondary sidebar containers plus a standalone editor-area panel; dsh-specific stats
(token usage, turn duration) tucked into collapsible rows.

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

Point `dshChat.url` at an existing server if you would rather manage it yourself.

## Licence and attribution

MIT — see `LICENSE`. This project builds on the work of others; the full itemised
disclosure is in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). In short: protocol
types come from DeepSeek Harness (MIT); the DSH transport layer inherits its structural
approach from DeepSeek-Harness-for-VS-Code (MIT); the interface follows Continue's design
(Apache-2.0) and was re-implemented from a specification without copying its source.
