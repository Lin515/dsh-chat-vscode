# 第三方归属与复用说明

本文档说明 DSH Chat 在开发过程中参考、借鉴了哪些外部项目，以及具体借鉴到什么程度。
目的是让复用边界一目了然，并履行上游许可证的义务。

DSH Chat 自身以 **MIT** 许可发布（见 `LICENSE`）。

---

## 1. DeepSeek Harness（`@deepseek-ai/dsh`）— MIT

- 上游：https://github.com/deepseek-ai/deepseek-harness
- 版权：Copyright (c) 2026 DeepSeek
- 许可：MIT

**复用方式：作为协议的事实来源（authoritative source）。**

`src/dsh/protocol.ts` 里的线格式类型（RPC 信封、`remote.mux` 流帧、
`session/follow` 的 snapshot / event / assistant-stream 帧、内容块、`TokenUsage`、
`$events` waterfall 等）取自本机安装的官方包里的 `.d.ts` 声明，例如：

- `@deepseek-ai/dsh-api-gateway`（`stream-protocol.d.ts`、`client.js`）
- `@deepseek-ai/dsh-api-session-controller`（`types.d.ts`）
- `@deepseek-ai/dsh-session`（`types.d.ts`、`known-event-types.js`）
- `@deepseek-ai/dsh-llm`（`types.d.ts`、`message.d.ts`）
- `@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-user-approval` 等

`docs/dsh-server-api.md` 全文标注了每一条结论的包名与文件位置，可直接复核。

> 协议类型声明必然与上游一致——它们描述的就是同一个服务端线格式。
> `THIRD-PARTY` 比对中「逐字相同的行」大多属于这一类。

MIT 许可证全文见本文末「附录 A」。

---

## 2. DeepSeek-Harness-for-VS-Code — MIT

- 上游：https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code
- 版权：Copyright (c) 2026 Jager
- 许可：MIT（`package.json` 声明为 MIT）

**复用方式：协议知识 + 传输层的结构继承。这是本项目最主要的外部借鉴，需明确披露。**

该项目是另一个面向 DSH 的 VS Code 扩展，界面风格是 dsh 网页端的复刻（与本项目的
Continue 风格取向不同）。本项目在开发初期阅读了它的以下文件以理解 DSH 客户端接入方式：

| 文件 | 用途 |
| --- | --- |
| `src/dsh/apiClient.ts` | 认证流程（启动令牌换签名 cookie）、`/api/remote.mux` 多路复用、`session/follow` 与 `assistantStream`、`$events` waterfall |
| `src/dsh/types.ts` | 交叉核对帧与事件形状 |
| `src/dsh/serverManager.ts` | 拉起 `dsh web`、从日志解析端口与令牌、就绪探测 |
| `src/webview/channel.ts` | 了解 `session/follow` 快照与投影的消费方式 |

**具体的结构继承（诚实清单）：**

1. 传输层类名与错误类型：`DshApiError`、`DshAuthError`、`ServerManager`。
2. 流注册表模式：`streams` Map + `pendingOpens` 队列（连接建立前排队补发 open 帧）。
3. 重连退避：`retryDelay` 从 1s 起、翻倍、上限 15s；断线时以
   `stream/socket-closed` 结束所有逻辑流。
4. WebSocket 消息分发形状：按 `frame.type` 分派 `item` / `end` / `error`。
5. 就绪判定与令牌解析思路：把子进程输出重定向到文件、按 `dsh web: http://…/?token=` 解析。
6. `commands/execute` 第三个位置参数跨版本改名（`images` → `submittedAttachments`）时
   「新名优先、失败回退并记忆」的兼容写法。

**未复用的部分：** 界面层完全没有采用该项目的实现——它使用自研的 DOM 渲染
（`ui.ts` 约 6000 行 + `chat.css` 约 4000 行，网页端 1:1 复刻），本项目改用
React + 自有 CSS 组件实现 Continue 风格界面。会话管理、面板、设置页、
子代理/后台任务视图、设置 schema 表单化等均为本项目独立实现。

**代码层面的实际差异：** 本项目的 `client.ts` 是独立重写的——认证更简化
（不做懒认证重试）、`request()` 重写、流句柄与错误传播重新组织、注释与结构不同。
按「长度 > 25 的非平凡行」比对，与该项目逐字相同的行共 94 行，
其中协议类型声明 19 行、通用惯用法 14 行，其余 61 行多为 `import` 语句、
`if (this.disposed) return;` 这类必然雷同的样板，以及上述第 2–4 点的结构性写法。

MIT 许可证全文见本文末「附录 A」。

---

## 3. Continue — Apache-2.0

- 上游：https://github.com/continuedev/continue
- 版权：Copyright 2023 Continue Dev, Inc.
- 许可：Apache License 2.0

**复用方式：仅视觉与交互设计规格，未拷贝任何代码。**

Continue 使用 React + Redux Toolkit + Tailwind + styled-components + TipTap；
本项目界面使用 React + 手写 CSS（无 Tailwind、无 Redux、无 styled-components、
无 TipTap），组件与类名均为自建。设计规格由 `docs/continue-ui-spec.md` 逐条记录
（含上游文件路径与行号），实现按该规格重写。

**借鉴的具体设计值：**

- 语义色板到 `--vscode-*` 变量的回退映射思路（`gui/src/styles/theme.ts` 的
  `THEME_COLORS` + `varWithFallback`）。本项目的 `src/webview/styles/tokens.css`
  用同样的「CSS 变量优先、硬编码回退」方式定义了自有的 token 集合。
- 几何尺度：全局圆角 `0.5rem`、最小标签字号 `11px`、代码块用 `outline` 而非
  `border`（`outline-offset: -0.5px`）、消息最后一条 `min-height: 200px`、
  缺口条（Lump）比输入框每侧窄 `7px` 且只保留上圆角。
- 招牌视觉：流式时输入框外壳的七彩渐变描边——渐变值逐字取自上游
  `repeating-linear-gradient(101.79deg, #1BBE84 0%, #331BBE 16%, #BE1B55 33%,
  #A6BE1B 55%, #BE1B55 67%, #331BBE 85%, #1BBE84 99%)`，6s 一圈。
- 交互模式：消息操作条悬停才淡入、过程信息压成单行可折叠行、
  「仅在贴底时才自动跟随滚动」。

Apache-2.0 的义务说明：

- 本项目**未拷贝 Continue 的源代码文件**，因此不涉及「修改过的文件需显著标注」；
- 未使用 Continue 的名称、Logo 或其它商标（Apache-2.0 §6 不授予商标许可）。
  「Continue 风格」在本项目中仅用于描述视觉取向，不代表与 Continue 项目的任何关联；
- 上文列出的设计值属于事实性数值，其出处已在 `docs/continue-ui-spec.md` 中逐条标注。

---

## 4. 其它第三方组件

界面与宿主代码依赖的运行时/构建期组件均通过 npm 安装，各自遵循其自身许可：

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| `react` / `react-dom` | MIT | webview 界面 |
| `marked` | MIT | Markdown 解析 |
| `dompurify` | Apache-2.0 / MPL-2.0 双许可 | 渲染前净化 HTML |
| `ws` | MIT | 宿主侧 WebSocket |
| `esbuild` | MIT | 打包 |
| `typescript` | Apache-2.0 | 类型检查 |
| `@vscode/vsce` | MIT | 打包 vsix |

图标为项目自绘的 SVG 线条图标（`src/webview/icons.tsx`），风格对齐
heroicons outline（MIT）的观感，但路径由本项目自行编写。

---

## 附录 A：MIT 许可证全文

以下 MIT 文本适用于第 1、2 节所述的上游项目（各自版权行见对应章节）。

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

对应版权行：

- DeepSeek Harness：`Copyright (c) 2026 DeepSeek`
- DeepSeek-Harness-for-VS-Code：`Copyright (c) 2025 dsh-chat contributors`

Continue（Apache-2.0）的版权行为 `Copyright 2023 Continue Dev, Inc.`，
许可证全文见 https://www.apache.org/licenses/LICENSE-2.0 。
