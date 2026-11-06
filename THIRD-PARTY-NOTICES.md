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

`src/shared/schedule.ts` 与 `src/dsh/scheduleView.ts` 里自动化任务的新代管理纯函数（下一次运行时刻、投递落点、会话归属、编辑草稿与只提交改过的字段、冲突重放、目录字段与请求体收窄）按官方 `packages/client/ui-schedule` 的同名口径实现（上游 tag `dsh-v0.2.2-rc.1`，commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）：判定规则与边界逐条对齐，但**不是源码逐字副本**——官方实现依赖它自己的 slot / store 与品牌类型，这里改写成本仓库的视图模型与纯函数接口，注释与结构不同。来源与改动边界同时写在[自动化任务设计](docs/design-schedules.md)的「来源与改动边界」。

`src/webview/assets/running-whale@2x.png` 是官方运行态鲸鱼尾动图（APNG，60 帧）的原样副本，用作「深度求索中」前的图标：像素未改动，仅以 CSS 遮罩取字形、由 `currentColor` 上色。

MIT 许可证全文见本文末「附录 A」。

### 1.1 `src/vendor/` 里的**源码逐字副本**（MIT）

与上面的「协议类型取自官方」不同，这一部分是**搬入上游源码或声明过的纯函数 / 类型摘录**（共 22 份）：

- 上游包：`@deepseek-ai/dsh-client-ui-trajectory`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-util-code-language`、`@deepseek-ai/dsh-client-ui-tool`、`@deepseek-ai/dsh-util-time`
- 版本：`0.2.2-rc.1`（上游 tag `dsh-v0.2.2-rc.1`）
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
| `src/vendor/ui-primitives/markdown/parse.ts` | 同名 | 完整搬入两个语法臂（`parseGfm` / `parseGfmWithMath`）；去掉 `.ts` 后缀 |
| `src/vendor/ui-primitives/markdown/mathCompatibility.ts` | 同名 | 文件头补充来源与改动说明；函数体逐字相同 |
| `src/vendor/ui-primitives/markdown/plain-text.ts` | 同名 | 去掉 `.ts` 后缀 |
| `src/vendor/ui-primitives/markdown/cjkFriendlyStrong.ts` | 同名 | 去掉 `.ts` 后缀 |
| `src/vendor/ui-primitives/markdown/local-image-syntax.ts` | 同名 | `classifyFileType` 换成本地等价判定；去掉 `.ts` 后缀 |
| `src/vendor/ui-primitives/markdown/katex.tsx` | 同名 | 逐字搬入 KaTeX → React 适配器；仅文件头补来源说明，函数体与 KaTeX 选项不变 |
| `src/vendor/ui-primitives/markdown/highlight.ts` | 同名 | 逐字搬入客户端语法高亮核心；仅文件头补来源说明，别名表、引擎选项与 token 样式不变 |
| `src/vendor/ui-primitives/markdown/windows-path-destinations.ts` | 同名 | 原文搬入 Windows 目标保真扩展；仅补来源头 |
| `src/vendor/ui-tool/terminal-status.ts` | `terminal-card-model.ts` 的两个纯函数摘录 | 函数体逐字相同；导出解析函数，模型改为最小本地类型壳 |
| `src/vendor/util-time/cron-fields.ts` | `cron.ts` 的字段解析闭包摘录 | 函数体 / 常量逐字相同，仅导出解析入口、调整错误类型 import；不搬时区算术 |
| `src/vendor/util-time/recurrence-error.ts` | `recurrence.ts` 的错误类型 / 类摘录 | 定义逐字相同 |
| `src/vendor/dsh-util-time/rrule.ts` | `packages/util/time/src/rrule.ts` | 完整 RRULE 解析与有界发生时刻引擎；去掉相对 import 的 `.ts` 后缀，并把 `rrule` 默认导入改为同名导出的命名空间导入以兼容 esbuild；函数体 / 常量不变 |
| `src/vendor/dsh-util-time/instant.ts` | `packages/util/time/src/instant.ts` | 完整时刻、日历、时区与 DST 解析；只补来源头 |
| `src/vendor/dsh-util-time/recurrence.ts` | `packages/util/time/src/recurrence.ts` | 完整错误 / 结果与决策闭包；只去掉相对 import 的 `.ts` 后缀 |
| `src/vendor/code-language/index.ts` | 同名（`packages/util/code-language`） | 逐字搬入扩展名 → 语法高亮语言表；仅文件头补来源说明 |

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
| `mdast-util-from-markdown` / `mdast-util-gfm` / `micromark` / `micromark-extension-gfm`（及 `micromark-*` 传递依赖） | MIT | 正文 mdast 渲染与 `src/vendor/` 的 Markdown 纯文本投影（预览文本） |
| `jsdom` / `@types/jsdom` | MIT | 离线测试的完整 DOM 环境（`DOMParser` / `Node` / HTML 与 MathML 解析）；仅开发依赖，不打包进扩展 |
| `katex` | MIT（JS/CSS）；SIL OFL 1.1（字体） | 完成态数学排版；随包只分发本地 WOFF2 字体，不使用 CDN 或网络资源 |
| `shiki` / `@shikijs/langs` | MIT | 完成态代码高亮的细粒度 core、JavaScript 正则引擎与静态精选 grammar；不含 Oniguruma WASM、全量语言包、CDN 或网络资源 |
| `diff` | BSD-3-Clause | 系统提示词变更页签的行级差分（与官方轨迹同一实现） |
| `@js-temporal/polyfill` / `jsbi` | ISC / Apache-2.0 | 官方时间解析器使用的严格日历、时区与 DST 计算；随 webview 和宿主 bundle 分发 |
| `rrule` / `tslib` | BSD-3-Clause / 0BSD | 官方有界 RRULE 解析器依赖；保留 rrule.js / python-dateutil 及 TypeScript helper 的归属与全文 |
| `ws` | MIT | 宿主侧 WebSocket |
| `esbuild` | MIT | 打包 |
| `typescript` | Apache-2.0 | 类型检查 |
| `@vscode/vsce` | MIT | 打包 vsix |

除四档权限图标外，`src/webview/icons.tsx` 中的 SVG 线条图标由本项目自行编写，
风格对齐 heroicons outline（MIT）的观感。

`shiki` 与 `@shikijs/langs` 以 MIT 发布（`Copyright (c) 2021 Pine Wu`；
`Copyright (c) 2023 Anthony Fu <https://github.com/antfu>`）。本扩展只打包
`createHighlighterCore`、JavaScript 正则引擎、CSS 变量主题与显式静态 grammar，
不使用 Oniguruma WASM、全量语言包、CDN 或网络资源；主题颜色由本地 CSS 变量提供，
未分发独立 TextMate 主题文件。MIT 许可证全文见「附录 A」。

### 4.1 KaTeX 字体（SIL OFL 1.1，不是 MIT）

KaTeX 的 JS / CSS 以 MIT 发布（`Copyright (c) 2013-2020 Khan Academy and other
contributors`，全文见「附录 A」）；**字体是独立的 SIL Open Font License 1.1 授权，
不能只按 MIT 归属**。本扩展从官方 npm 包 `katex@0.16.47` 的 `dist/fonts/` 原样
复制 WOFF2 字节，仅把 CSS 的 `@font-face` 收敛为该 WOFF2 来源；没有修改字体，
也没有以保留字体名称发布修改版。上游 DeepSeek Harness 客户端的 KaTeX → React
适配器 `katex.tsx` 作为源码副本收录，归属见 1.1 节。

字体版权行（20 份字体文件的 name 表一致）：

```text
Copyright (c) 2009-2010 Design Science, Inc. (<www.mathjax.org>)
Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>)
```

保留字体名称（Reserved Font Name）按字体族列出：

- `KaTeX_AMS`
- `KaTeX_Caligraphic`
- `KaTeX_Fraktur`
- `KaTeX_Main`
- `KaTeX_Math`
- `KaTeX_SansSerif`
- `KaTeX_Script`
- `KaTeX_Size1`、`KaTeX_Size2`、`KaTeX_Size3`、`KaTeX_Size4`
- `KaTeX_Typewriter`

SIL OFL 1.1 全文见「附录 C」。上游对字体与 JS/CSS 许可分界的说明：
<https://github.com/KaTeX/KaTeX/issues/339#issuecomment-135518223>。

四档权限图标直接复用 DeepSeek Harness 的
`packages/client/ui-primitives/src/PermissionIcon.tsx`（MIT，Copyright (c) 2026 DeepSeek），
来源为 tag `dsh-v0.2.1-alpha.2`、提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`。
路径、逐路径填充和描边属性、16×16 视窗以及 Regular 描边保持原样；尺寸接入本项目的
设计像素换算，并补充 SVG props 与 `focusable` 属性。MIT 许可证全文见「附录 A」。

---

## 附录 A：MIT 许可证全文

以下 MIT 文本适用于第 1、2 节所述的上游项目与第 4 节的 `shiki` / `@shikijs/langs`
及 KaTeX JS/CSS（各自版权行见对应章节）。

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
- Shiki：`Copyright (c) 2021 Pine Wu`；`Copyright (c) 2023 Anthony Fu <https://github.com/antfu>`
- KaTeX JS/CSS：`Copyright (c) 2013-2020 Khan Academy and other contributors`

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

---

## 附录 C：SIL Open Font License 1.1 全文（KaTeX 字体）

以下文本适用于第 4.1 节列出的 KaTeX WOFF2 字体。

```
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
```

---

## 附录 D：时间计算依赖的原始许可

### @js-temporal/polyfill@0.5.1（ISC）

```text
Copyright 2017, 2018, 2019, 2020 ECMA International

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### rrule@2.8.1（rrule.js 与 python-dateutil，BSD-3-Clause）

```text
rrule.js: Library for working with recurrence rules for calendar dates.
=======================================================================

Copyright 2010, Jakub Roztocil <jakub@roztocil.name> and Lars Schöning

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    1. Redistributions of source code must retain the above copyright notice,
       this list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright
       notice, this list of conditions and the following disclaimer in the
       documentation and/or other materials provided with the distribution.

    3. Neither the name of The author nor the names of its contributors may
       be used to endorse or promote products derived from this software
       without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE AUTHOR AND CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.



./rrule.js and ./test/tests.js is based on python-dateutil. LICENCE:

python-dateutil - Extensions to the standard Python datetime module.
====================================================================

Copyright (c) 2003-2011 - Gustavo Niemeyer <gustavo@niemeyer.net>
Copyright (c) 2012 - Tomi Pieviläinen <tomi.pievilainen@iki.fi>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of the copyright holder nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### jsbi（Apache-2.0）

```text
                                 Apache License
                           Version 2.0, January 2004
                        https://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

### tslib（0BSD）

```text
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```
