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

此外，`src/webview/messages.ts` 的六项内置斜杠命令描述取自 `@deepseek-ai/dsh-client-ui-commands@0.2.1-alpha.2` 的中英文 `description.*` 词条；`src/webview/commandLinks.tsx` 按其官方命令定义身份选择描述，未复用上游组件实现。

`src/webview/assets/running-whale@2x.png` 是官方运行态鲸鱼尾动图（APNG，60 帧）的原样副本，用作「深度求索中」前的图标：像素未改动，仅以 CSS 遮罩取字形、由 `currentColor` 上色。

MIT 许可证全文见本文末「附录 A」。

### 1.1 `src/vendor/` 里的**源码逐字副本**（MIT）

与上面的「协议类型取自官方」不同，这一部分是**把上游源码整份复制进本仓库**：

- 上游包：`@deepseek-ai/dsh-client-ui-trajectory`、`@deepseek-ai/dsh-client-ui-primitives`
- 版本：`0.2.0-rc.2`（上游 tag `dsh-v0.2.0-rc.2`）
- 版权：Copyright (c) 2026 DeepSeek
- 许可：MIT

| 本仓库文件 | 上游文件 | 改动 |
| --- | --- | --- |
| `src/vendor/ui-trajectory/trajectory-preview.ts` | 同名 | import 指向同仓库副本 |
| `src/vendor/ui-trajectory/trajectory-record.ts` | 同名 | 抽掉 React / 附件 / conversation / locales 类型壳；函数体逐字相同 |
| `src/vendor/ui-trajectory/timeline.ts` | 同名 | import 路径（类型摘录 + 去掉 `.ts` 后缀） |
| `src/vendor/ui-trajectory/trajectory-turn-model.ts` | `layout.ts` 的类型摘录 | 只有接口，无实现体 |
| `src/vendor/ui-trajectory/trajectory-search-index.ts` | 同名 | import 路径 |
| `src/vendor/ui-trajectory/inbox-state.ts` | `trajectory-message-definitions.ts` 的状态机摘录 | 参数类型换成本地形状；函数体逐字相同 |
| `src/vendor/ui-trajectory/code-program.ts` | 同名 | 去掉 `.ts` import 后缀；函数体与常量逐字相同 |
| `src/vendor/ui-primitives/markdown/parse.ts` | 同名 | **只搬流式臂**（省略 math 臂与其依赖）；去掉 `.ts` 后缀 |
| `src/vendor/ui-primitives/markdown/plain-text.ts` | 同名 | 去掉 `.ts` 后缀 |
| `src/vendor/ui-primitives/markdown/cjkFriendlyStrong.ts` | 同名 | 去掉 `.ts` 后缀 |
| `src/vendor/ui-primitives/markdown/local-image-syntax.ts` | 同名 | `classifyFileType` 换成本地等价判定；去掉 `.ts` 后缀 |

每个文件头部都注明来源、版本与「本仓库改了哪几处」；逐处改动的理由与同步流程见
`src/vendor/README.md`。

---

## 2. DeepSeek-Harness-for-VS-Code — MIT

- 上游：https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code
- 版权：Copyright (c) 2026 Jager
- 许可：MIT（`package.json` 声明为 MIT）

**复用方式：协议知识 + 传输层的结构继承。这是本项目最主要的外部借鉴，需明确披露。**

该项目是另一个面向 DSH 的 VS Code 扩展，界面风格是 dsh 网页端的复刻。本项目在开发初期
阅读了它的以下文件以理解 DSH 客户端接入方式：

| 文件 | 用途 |
| --- | --- |
| `src/dsh/apiClient.ts` | 认证流程（启动令牌换签名 cookie）、`/api/remote.mux` 多路复用、`session/follow` 与 `assistantStream`、`$events` waterfall |
| `src/dsh/types.ts` | 交叉核对帧与事件形状 |
| `src/dsh/serverManager.ts` | 拉起 `dsh web`、从日志解析端口与令牌、就绪探测 |
| `src/webview/channel.ts` | 了解 `session/follow` 快照与投影的消费方式 |

**具体的结构继承（诚实清单）：**

1. 传输层类名与错误类型：`DshApiError`、`DshAuthError`（当时的 `ServerManager` 已在
   2026-09 的 supervisor 架构里整份替换为本项目自己的 `SupervisorManager` +
   `src/supervisor/main.ts`，见 `docs/design-supervisor.md`）。
2. 流注册表模式：`streams` Map + `pendingOpens` 队列（连接建立前排队补发 open 帧）。
3. 重连退避：`retryDelay` 从 1s 起、翻倍、上限 15s；断线时以
   `stream/socket-closed` 结束所有逻辑流。
4. WebSocket 消息分发形状：按 `frame.type` 分派 `item` / `end` / `error`。
5. 就绪判定与令牌解析思路：把子进程输出重定向到文件、按 `dsh web: http://…/?token=` 解析。
6. `commands/execute` 第三个位置参数跨版本改名（`images` → `submittedAttachments`）时
   「新名优先、失败回退并记忆」的兼容写法。

**未复用的部分：** 界面层完全没有采用该项目的实现——它使用自研的 DOM 渲染
（`ui.ts` 约 6000 行 + `chat.css` 约 4000 行，网页端 1:1 复刻），本项目改用
React + 自有 CSS 组件实现。会话管理、面板、子代理/后台任务视图等均为本项目独立实现。

**代码层面的实际差异：** 本项目的 `client.ts` 是独立重写的——认证更简化
（不做懒认证重试）、`request()` 重写、流句柄与错误传播重新组织、注释与结构不同。
按「长度 > 25 的非平凡行」比对，与该项目逐字相同的行共 94 行，
其中协议类型声明 19 行、通用惯用法 14 行，其余 61 行多为 `import` 语句、
`if (this.disposed) return;` 这类必然雷同的样板，以及上述第 2–4 点的结构性写法。

MIT 许可证全文见本文末「附录 A」。

---

## 3. Continue — Apache-2.0（**早期设计参考，现已不再是本扩展的定位**）

- 上游：https://github.com/continuedev/continue
- 版权：Copyright 2023 Continue Dev, Inc.
- 许可：Apache License 2.0

**复用方式：早期仅参考视觉与交互取向，未拷贝任何代码。**

2026-09 之前，本扩展的界面刻意朝着 Continue 的视觉取向做，并写了一份逐条记录
其 px 级规格的文档（`docs/continue-ui-spec.md`）。那份文档与"复刻 Continue"的定位
**已随 2026-09-17 的清理一并删除**：界面早就按本项目自己的设计 token 与组件演进
（无 Tailwind、无 Redux、无 styled-components、无 TipTap），把它继续当作类比会误导。

留在代码里的、**至今仍可追溯到那次参考**的具体值（都会在注释里注明来源）：

- 语义色板到 `--vscode-*` 变量的「变量优先、硬编码回退」映射思路
  （`src/webview/styles/tokens.css`）；
- 少数几何尺度：全局圆角 `0.5rem`、最小标签字号 11px、代码块用 `outline` 而非
  `border`、消息最后一条的 `min-height`、缺口状态条（Lump）比输入框窄几像素且只保留上圆角；
- 交互模式：过程信息压成单行可折叠行、「仅在贴底时才自动跟随滚动」。

Apache-2.0 的义务说明：

- 本项目**未拷贝 Continue 的源代码文件**，因此不涉及「修改过的文件需显著标注」；
- 未使用 Continue 的名称、Logo 或其它商标（Apache-2.0 §6 不授予商标许可），
  也不再以「Continue 风格」描述自己；上一条列出的是事实性的设计数值，不是关联声明。

---

## 4. 其它第三方组件

界面与宿主代码依赖的运行时/构建期组件均通过 npm 安装，各自遵循其自身许可：

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| `react` / `react-dom` | MIT | webview 界面 |
| `marked` | MIT | Markdown 解析 |
| `mdast-util-from-markdown` / `mdast-util-gfm` / `micromark-extension-gfm`（及 `micromark-*` 传递依赖） | MIT | `src/vendor/` 的 Markdown 纯文本投影（预览文本） |
| `dompurify` | Apache-2.0 / MPL-2.0 双许可 | 渲染前净化 HTML |
| `diff` | BSD-3-Clause | 系统提示词变更页签的行级差分（与官方轨迹同一实现） |
| `ws` | MIT | 宿主侧 WebSocket |
| `esbuild` | MIT | 打包 |
| `typescript` | Apache-2.0 | 类型检查 |
| `@vscode/vsce` | MIT | 打包 vsix |

除四档权限图标外，`src/webview/icons.tsx` 中的 SVG 线条图标由本项目自行编写，
风格对齐 heroicons outline（MIT）的观感。

四档权限图标直接复用 DeepSeek Harness 的
`packages/client/ui-primitives/src/PermissionIcon.tsx`（MIT，Copyright (c) 2026 DeepSeek），
来源为 tag `dsh-v0.2.1-alpha.2`、提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`。
路径、逐路径填充和描边属性、16×16 视窗以及 Regular 描边保持原样；尺寸接入本项目的
设计像素换算，并补充 SVG props 与 `focusable` 属性。MIT 许可证全文见「附录 A」。

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

---

## 附录 B：BSD 3-Clause 许可证全文（`diff`）

`diff` 以 **BSD-3-Clause** 发布，该许可要求随二进制分发保留版权声明与许可全文
（本扩展把它打包进 `dist/webview.js`，所以全文必须随包发布）：

```
BSD 3-Clause License

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
