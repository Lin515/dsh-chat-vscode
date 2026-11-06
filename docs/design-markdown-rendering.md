# Markdown 管线迁移、代码高亮与公式渲染

## 状态与范围

本文覆盖正文 Markdown 的五个阶段：从 marked / HTML 分块迁到官方同源的 micromark → mdast → React 管线（阶段 2），再接入 Shiki 代码高亮（阶段 3）与 KaTeX 公式（阶段 4），最后做安装端验收（阶段 5）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 基线、来源锁定与本文设计 | 已完成 |
| 2 | 解析 / 渲染管线切换，保持标准 Markdown 的视觉与行为；原始 HTML 改为字面文本 | 已落地 |
| 3 | 完成态代码高亮（Shiki） | 正文代码卡已通过既有安装端渲染验收；本轮五类工具节点已过离线 / 受控浏览器，新增节点安装端 / 系统剪贴板 / 真实模型未覆盖 |
| 4 | 完成态数学（KaTeX → React） | 固定来源的官方适配器直接复用；中文 / 表格 / 不换行空格 / 宏隔离 / 安全与选区由完整 DOM 回归覆盖；资源与安装边界见下文 |
| 5 | 安装端 CSP / 字体 / VSIX 资源验收 | 资源包 / 专用目录安装 / CSP / 字体通过；系统剪贴板端到端与屏幕阅读器实际朗读未覆盖 |

实现入口是 `src/webview/markdown/`：`parse.ts` 选择 GFM / settled 数学臂，`source.ts` 用同源 micromark 事件流提取代码源文，`render.tsx` 递归映射 mdast 为 React。`highlight.ts` 提供有界完成态代码 token；`mathRender.ts` 懒调用固定来源的官方 `katex.tsx`，`MathView` 直接挂载其 React 树。正文与公式都没有 `innerHTML` 或渲染后水合，不维护 KaTeX class / style / namespace 白名单。FindBar 只过滤可信辅助层，复制沿用原生选区；本地字体构建与安装边界见下文。

- 正文已从 marked / HTML 分块迁到官方同源的 micromark → mdast → React 管线；阶段 3 已把 Shiki 接进同一棵文档树，阶段 4 再接入 KaTeX。普通 Markdown、代码与数学共享一套节点所有权，不再建设 marked 私有槽、骨架标记和 React portal 方案。
- **迁移不是界面重设计。** 保留标准 Markdown 的字体、间距、代码卡片、折展、复制、链接、图片、脚注、搜索和阅读行为；不整搬官方 UI、CSS Modules、工具栏或主题系统。原始 HTML 按官方作为字面文本显示，是明确接受的兼容差异，不再保留现有有限 HTML 渲染。
- 助手生成期间仍展示普通 Markdown；阶段 3 起，生成结束、停止、失败或截断后的 settled 代码块进入完成态高亮，streaming 期间不初始化引擎、不着色。阶段 4 接入公式后同样只在完成态排版。不做增量解析、增量高亮、自动补围栏或“围栏刚闭合就增强”。
- 历史消息和已确定的计划、工具详情直接使用完成态。阶段 3 起，`run_code` 完整调用参数可立即着色；工具运行状态不等于代码还在生成。
- 用户气泡仍显示原始文本；终端、文件预览、diff、JSON 检查器、轨迹源码与请求差分不纳入。不改协议、持久化消息或宿主权限，不加功能开关。

现有消息约束见[消息设计](<design-messages.md>)；文件访问见[文件路径](<design-paths.md>)；图片与外传边界见[安全设计](<design-security.md>)；尺度与复制分别见[界面尺度](<design-ui-scale.md>)、[右键菜单](<design-context-menu.md>)。

## 决策与官方复用边界

迁移前的 `webview/markdown.ts`（阶段 2 已删除）使用 marked、自有脚注、Windows 路径和中文加粗扩展，再由 DOMPurify 净化；`splitMarkdownBlocks` 只用正则抽取完整三反引号围栏。继续在其上补数学 token、私有槽和来源验证，会同时维护两套树与挂载生命周期。阶段 2 已统一语法基础，成本集中在一次兼容迁移，后续语法、嵌套、代码与公式共享同一 Seam。

官方已有 GFM / 数学解析、中文加粗、图片语法修复、mdast 渲染、Shiki 和 KaTeX；复用其语法与测试输入，而不是将整套组件作为黑盒替换。本扩展不需要官方流式缓存、增量会话、桌面图片路由、链接组件或整套主题依赖。

### 固定来源与适配

- 当前 vendor 基准为 `@deepseek-ai/dsh-client-ui-primitives@0.2.2-rc.1`，tag `dsh-v0.2.2-rc.1`，commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`；来源与锁定流程见[vendor 说明](<../src/vendor/README.md>)。不得把本机 HEAD 或最新文档当作该发布版的证据。
- vendor 的 [parse.ts](<../src/vendor/ui-primitives/markdown/parse.ts>) 已按固定 commit 恢复 `parseGfm` 与 `parseGfmWithMath` 两个语法臂，并补入 [mathCompatibility.ts](<../src/vendor/ui-primitives/markdown/mathCompatibility.ts>) 及配套依赖；轨迹纯文本投影与正文 streaming 仍只用 `parseGfm`，不得为了正文迁移改变轨迹摘要、搜索索引或事件投影。settled 数学由本地 [math.ts](<../src/webview/markdown/math.ts>) 用**同一扩展集合**装配并包装公开 construct / handler，不复制 vendor 的语法规则，也不直接改 vendor 文件。
- **解析与宿主生命周期适配，排版直接复用。** 本地解析层只补金额否决、权威闭合和源码保真；排版由固定来源的官方适配器完成，宿主仅保留 phase、长度 / DOM 守卫、失败原文回退、身份隔离与选区冻结。正文使用 `parseMarkdown(text, phase)`，金额边界见「本地解析适配」。
- vendor 内仅保留获准的原文适配；Windows 目标保真复用官方扩展，扩展资源策略、完成态高亮、安全限额和 UI 差异放在本地 Implementation。新搬文件必须同步原文夹具、文件头、来源锁和第三方声明；变更已有允许适配须说明理由，不能只改摘要求绿。
- 官方 `katex.tsx` 原样 vendor，并用原始上游见证与来源锁固定；`mathRender.ts` 是其唯一生产消费者。官方 `render.tsx` / `highlight.ts` 仍提供遍历、别名与主题参考，链接 / 图片准入保留扩展契约；需要本地行为的派生实现放在 webview 层，不伪称逐字 vendor。
- 官方 Markdown / DOM / 恶意 TeX 夹具可复用输入，断言必须改为本扩展契约，不能直接采用官方 DOM 快照并顺带改变 UI。

## Module、Interface 与 Seam

### 对外 Interface

业务仍只消费 `Markdown` 和 `CodeBlock`，不接触 micromark、mdast、语言注册、字体或渲染内部节点。阶段 2 已按下列 Interface 落地，阶段 3 在 `CodeBlock` 内按 `phase` 接入完成态高亮：

```ts
type MarkdownPhase = "streaming" | "settled";

type MarkdownProps = {
  text: string;
  phase?: MarkdownPhase; // 缺省 settled，静态调用方不必传
  fileLinks?: FileLinkPort;
  cwd?: string;
};

type CodeBlockProps = {
  code: string;
  lang?: string;
  phase?: MarkdownPhase; // 完整工具调用参数可直接 settled
};
```

- 助手正文由 `message.streaming` 显式推导 phase，不能靠闭合围栏、工具是否运行或文档是否命中缓存推断。阶段 2 已接入 `StreamText` 与 `useSelectionFreeze`。
- `StreamText` 将 `{ text, phase }` 作为不可变显示快照交给选区冻结；冻结期间两者都不更新，释放后一次追上最新状态。扩展 `useSelectionFreeze` 时保持思考等现有字符串调用方行为不变，避免每次 render 新建对象造成无意义更新。
- 复制一律取原文，不能从 DOM、着色 token 或 KaTeX 文本反向生成源数据：用户消息的整条复制取原始消息文本；助手消息只在**轮尾**给一枚入口，取本轮最后一段正文的 Markdown 原文（`turnProcess` 的 `lastTextSegment`，与折叠边界同一条），不跨越工具节点拼接——拼接会忽略工具内容、丢语义，中间正文也没有各自的按钮；代码复制取 `code`。
- 未知语言、无效 TeX、超限和增强失败原位回落可读源码，不吞整条消息、不弹全局通知；日志不包含整份正文、TeX 或可能带秘密的异常片段。
- 普通父级重渲染不能重新初始化引擎；streaming 不调用 Shiki / KaTeX。改变词表、cwd 或语言只更新对应交互 / 文案，不应重新做无关的代码着色。

这是一个 deep Module：小 Interface 隐藏语法、来源、安全、主题、缓存与降级；同一实现服务正文和工具，带来 Leverage，规则和测试集中维护以保持 Locality。不是转发参数的浅包装，也不建立没有第二个真实 Adapter 的引擎插件框架。

### 内部职责

| 职责 | Implementation 与边界 |
|---|---|
| 解析适配 | 在现有 markdown 模块附近封装官方解析入口、扩展特有路径兼容与源码位置；外部不导出 vendor 类型 |
| 文档渲染 | 统一收集参考定义和脚注，再递归映射 mdast 到现有 React / HTML 元素；无整篇 HTML 骨架与 portal |
| 原始 HTML | mdast 的 html 节点按官方输出为 React 文本；不导入 HTML、不提供标签白名单或模型属性驱动的富组件 |
| 代码 / 数学叶节点 | 代码复用现有 `CodeBlock`；数学进入私有 MathView；各自管理增强失败与有界缓存 |
| 文件 / 图片接入 | 复用现有路径判据、宿主动作和图片作用域，只调整 DOM 所有权与挂载方式 |
| 搜索 / 选择 / 阅读 | 通过现有查找、选区复制、readingPlacement / autoScroll Seam 整合，不另建全局管理器 |

阶段 2 按上述职责拆成 `src/webview/markdown/` 的 `parse.ts`、`source.ts`、`render.tsx` 与 `types.ts`（原本地 Windows 目标回扫已由官方解析扩展替代），文件清单见该目录 README；组件入口仍是 `components/Markdown.tsx`。阶段 3 新增 `markdown/highlight.ts`（引擎 / 缓存 / 受控 token）与 `webview/selectionRange.ts`（选区相交 / 脱树判据），沿用同一分层，不建没有第二个真实 Adapter 的注册平台。

## 消费面与影响清单

以下是当前入口；迁移时已再次搜索调用方，后续改动仍须防止新增消费面遗漏。

| 消费面 | 接入与必须保留的内容 |
|---|---|
| [Message.tsx](<../src/webview/components/Message.tsx>) 的 `StreamText` | 助手正文显式 phase，保留 `md-wrapper`、本轮 `fileLinks`、cwd、消息身份与选区冻结；正文段本身不带复制入口（轮尾那一枚取最后一段原文，见 `lastTextSegment`）；历史回放直接 settled |
| [Rows.tsx](<../src/webview/components/Rows.tsx>) 的 `run_code` | 复用相同 CodeBlock、默认 settled；不改工具折展、参数提取、按钮帧与执行状态 |
| Rows 的 `review.plan`、`item.detail` | 审阅计划与思考详情继续走 Markdown；默认 settled，不把问卷、审批或计划动作搬进渲染 Module |
| [ToolCards.tsx](<../src/webview/components/ToolCards.tsx>) 的 `card.answer` | 网页搜索答案与正文采用同一语法 / 安全链；不凭空获得助手本轮文件词表 |
| [Trajectory.tsx](<../src/webview/components/Trajectory.tsx>) 的 `previewMarkdown`、`outputDetail` | 已投影的 Markdown 按完成态显示；不改 ledger、虚拟化、定位回执、源记录视图和纯文本摘要算法 |
| [Markdown.tsx](<../src/webview/components/Markdown.tsx>) / [CodeBlock.tsx](<../src/webview/components/CodeBlock.tsx>) | 统一文档树和叶节点入口；阶段 2 已移除旧分块、整篇 innerHTML 与水合所有权，`Markdown.tsx` 只做 `parseMarkdown` + `renderMarkdownDocument` 的薄包装 |
| [FindBar.tsx](<../src/webview/components/FindBar.tsx>)、[contextMenu.ts](<../src/webview/contextMenu.ts>) | 着色 span 跨节点搜索、FindBar 辅助层过滤、复制 / 引用（原生选区，不做数学去重）及边界判定；不扩大快捷键接管区域 |
| [markdown/render.tsx](<../src/webview/markdown/render.tsx>) 的链接 / 图片叶节点、[linkHovers.ts](<../src/webview/linkHovers.ts>)、[localImages.ts](<../src/webview/localImages.ts>) | 目标判据与作用域保留，节点由 React 拥有；旧 `hydrateFileMentions` / `hydrateLocalImages` 已删除，不能再对 React 树做命令式 DOM 改写 |
| [app.css](<../src/webview/styles/app.css>)、[tokens.css](<../src/webview/styles/tokens.css>) | 适配树结构引起的选择器差异，保留现有视觉 token 与尺度；限定高亮、数学新增样式的作用域 |
| [chatView.ts](<../src/chatView.ts>)、[esbuild.mjs](<../esbuild.mjs>)、[package.json](<../package.json>) | 本地字体、CSS URL、发布白名单、依赖裁剪及 CSP 验证；无协议和宿主能力新增 |
| [markdown.test.ts](<../scripts/markdown.test.ts>)、[footnotes.test.ts](<../scripts/footnotes.test.ts>)、[markdownSource.test.ts](<../scripts/markdownSource.test.ts>)、[localImageResolve.test.ts](<../scripts/localImageResolve.test.ts>) 等 | 已迁到真实新入口：SSR 行为、代码源文逐字符、图片解析范围与回帧；保留原夹具表达的安全与行为不变量 |

## 整篇解析与 React 文档树

阶段 2 / 4 已落地的主链（阶段 4 补 `MathView` 叶节点）：

```text
原始 Markdown + phase
  → 扩展解析适配（官方 micromark / mdast 语法）
  → 整篇 mdast + 文档级参考定义 / 脚注上下文 + 源码位置
  → 递归 React 树（现有样式、链接 / 图片组件、CodeBlock / MathView）
  → 现有搜索、选区和阅读端口
```

### 语法与来源

- 阶段 2 使用 `fromMarkdown` 的成对 GFM 扩展（`gfm()` + `gfmFromMarkdown()`）并注册官方 `cjkFriendlyStrong`；数学的 `mathCompatibility()` / `math()` + `mathFromMarkdown()` 已按固定来源成对恢复依赖。settled 由本地 `math.ts` 以相同扩展集合装配并补金额否决与事实记录，streaming 仍不注册数学；只注册词法扩展而不接树编译扩展不算完成迁移，版本以锁文件为准。
- 阶段 2 的流式与完成态都用官方 `parseGfm`，没有增量解析器；阶段 4 把 settled 改为本地同集合装配（语法等价于 `parseGfmWithMath`，另加公开 construct / handler 包装），结构变化只允许发生在数学等有意的增强边界。两者都对当前整篇文本解析。生成中的反斜杠仍可能按 CommonMark 转义显示；“公式原文”表示不排版，不承诺每个定界符逐字可见，也不另写一套实时数学扫描器。
- Windows 目标保真直接复用官方 `windows-path-destinations.ts`，streaming / settled 两臂都装配该扩展，不再二次回扫目标。覆盖行内链接 / 图片和参考式定义，保留反斜杠并解码实体，不改变 URL scheme、代码与标签文本；宿主文件 / 媒体准入仍独立。GFM 两臂同样沿用官方 `singleTilde: false`：单波浪线保持字面量。
- 中文强强调沿用官方 `cjkFriendlyStrong`，已用迁移前的中文标点、西文、单星、三星、代码内星号夹具对拍；不能以“官方如此”为理由静默扩大既有偏差。
- 代码依赖 `code` 节点，不再全文围栏正则切分；较长围栏、波浪、未闭合、缩进代码以及列表 / 引用 / 脚注内代码均保留所属容器。未知树节点按 `sourceFallback` 回退为安全源码片段，不沿用官方“默认返回空”吞内容。
- 文档级定义统一收集在 `MarkdownDocument.definitions` / `footnotes`：参考链接与图片可跨代码块解析，脚注编号与重复引用计数只属于本次文档。脚注定义重复时 last-wins，参考定义 first-wins，沿用迁移前口径。
- 使用稳定的文档身份和节点 key；同一代码块从 streaming 到 settled、着色初始化完成、主题或词表变化时，不重建卡片而丢失用户折展选择；阶段 3 已按此保持卡片 DOM 与折展状态。源码 offset 不能单独作为跨消息身份，不能跨连接复用交互闭包。

### 代码原文保真

mdast 的 `code.value` 会经过语法规范化，不能默认等同旧 CodeBlock 接到的源代码。实现须分清“带围栏的原始片段”“去掉围栏和容器缩进的代码载荷”“着色 token”。

阶段 2 的 `source.ts` 用与解析同源的 micromark 事件流（`codeFenced` / `codeIndented` 的 `codeFlowValue` + `lineEnding`）定位每行内容：内容字符从源码切片取，`context.sliceSerialize(token)` 只补“部分消费 tab”的虚拟空格（比较时把源码 NUL 按 micromark 规范映射成 U+FFFD，避免 raw 含 NUL 时丢失 padding；补回的仍是源码字符）。每份文档只在确实有代码时多解析一次，不按代码块数重复。

既有顶层三反引号的复制结果作为基线；末尾换行、连续空行、空代码、CRLF、tab、缩进和行尾空格不得因 AST 迁移或 Shiki 按行输出丢失。新支持的嵌套代码应去掉 Markdown 列表 / 引用前缀，而非将其复制为代码。源位置切片须结合语法 token / 容器规则提取，不能直接 slice 整个 code 节点，也不能用 trim / split-join 猜回原文。高亮显示文本、code prop 与复制载荷须逐字符一致；同一载荷的行数判定保持 `code.split("\n").length > 20` 的现有边界。以上由 `markdownSource.test.ts` 逐字符覆盖。

### 原始 HTML 跟随官方显示为文字

扩展没有向 agent 约定额外的 HTML 渲染能力，不为低收益的历史白名单增加 HTML 导入器、跨节点拼接、二次解析或双引擎。mdast 的 `html` 节点直接在 `render.tsx` 里作为 React 文本子节点输出，不删除内容、不解释标签，也不提供兼容开关。无需改变 agent 提示词。阶段 2 已按此实现。

- 标准 Markdown 生成的表格、加粗、链接、图片、任务列表等仍正常渲染；它们来自已知语法节点，不是开放原始 HTML。Markdown 的硬换行继续有效，直接写的 `<br>` 则显示标签文字。
- 原始 `<span>`、`<a>`、`<img>`、`<pre><code>` 等不生成排版、导航、网络请求、代码卡片或文件按钮；模型提供的 class、id、data 属性不生成任何 DOM 属性或内部身份。代码围栏中的 HTML 始终仍为代码。
- 标签周围的 Markdown 按官方语法解析，不另做浏览器式 HTML 嵌套修复；只要求 html 节点的原始内容不被当作 DOM。混排夹具覆盖行内 / 块级、注释、危险标签和伪造组件标记。
- **有意的兼容差异：** 少量历史回答中原来可显示的有限 HTML 会变成标签文字，不做历史数据迁移、不按消息新旧分叉。该变化在对应版本的 CHANGELOG 与根 README 中说明，不能将其误报为所有旧输出完全等价。
- KaTeX 的内部 HTML / MathML 是私有 MathView 的排版产物，只能从数学节点经官方适配器转为 React 树，不意味着允许回答中的任意 HTML。普通 Markdown 不再经过整篇 HTML 净化 / 导入链。

## 视觉与行为不变量

阶段 2 的有意变化只有两处：正确呈现旧正则未覆盖的合法嵌套代码，以及原始 HTML 改为字面文字；阶段 3 再增加完成态代码颜色，阶段 4 增加完成态数学排版。其余标准 Markdown 内容不得借迁移重排、换肤或改操作，已由静态浏览器回放逐项对拍。

| 区域 | 保持要求与容易遗漏的差异 |
|---|---|
| 正文根与边距 | 保留 `md-wrapper` / `.md` 语义；多个旧 HtmlBlock 合成一个文档根后，首尾 margin 归零、代码前后段距、相邻列表与脚注不得改变。不能直接把旧 `.md > *` 假定为等价 |
| 基础排版 | 段落、标题层级、列表缩进 / 起始序号、紧凑 / 松散列表、引用边框、分隔线、删除线、实体、软 / 硬换行维持现状；表格继续局部横向滚动，不撑宽会话 |
| 行内代码与文件按钮 | 保留代码芯片底色、圆角、字号和 `code > button.file-mention`，长路径左对齐和整体底色；锚点内不再嵌可交互按钮 |
| 任务列表 | 已完成 / 未完成有可见区别，checkbox 只读且 disabled；模型不能藉 HTML 引入 text / file 等输入控件 |
| 代码卡片 | 沿用 `.code-block*`、编辑器底色、outline、标题和悬停 / focus-within 按钮；不增加行号、工具栏或逐行操作，不换官方卡片。正文里的代码卡保持这张独立卡片；被工具节点直接包住的代码卡只保留内部排版，阅读外框归节点的 `.row-body` |
| 代码换行与折展 | 继续 `pre-wrap` + `break-all` 自动换行，不改为横向滚动；超过 20 行默认收起，160dp 裁切和 48dp 渐隐、箭头方向 / 120ms 过渡、用户展开选择保留；变短强制展开 |
| 代码字体 | 继续 `--mono` 与 1.5 行高；字号取 `--font-size`（跟随 `dshChat.fontSize`），不再使用 `--mono-size` 或编辑器字号。高亮 span 只改受控颜色 / 字形修饰，不覆盖字号、背景、padding、换行或行高；必须检查 `.md code` 对新嵌套卡片的级联 |
| 图片 | 尺寸上限仍为 `min(100%, 640dp)` × 360dp，按比例缩放，点击原图、zoom-in 光标、右键复制 / 保存、失败占位和替代文本一致 |
| 脚注 | 首次引用编号、重复引用同号、仅有定义不输出、缺定义不输出空脚注区；`sup`、`.footnotes`、`.sr-only` 标题、文末箭头及重复上标保持，不顺便加可点击回跳链接；中英标题随语言切换 |
| 主题与尺度 | 保留 VS Code 明 / 暗 / 高对比和 `--dp`；内容字号跟随 `dshChat.fontSize`，不读编辑器字号；不写覆盖全局的 KaTeX reset，不改变主题滚动条，不另用 zoom；非默认字号验证窄栏布局 |
| 可访问性 | 保留按钮焦点 / title / aria-expanded、键盘操作和只读任务语义；新增数学辅助层可读但不重复朗读，不能为美观隐藏全部 MathML |

GFM 对多段脚注、重复定义、复杂分隔符等边缘输入可能与迁移前的自有解析器不同；阶段 2 已用迁移前夹具对拍新旧输出，差异逐项确认（脚注重复定义 last-wins、参考定义 first-wins）。新增标准语法支持可以有意扩展，但不能以“遵循标准”掩盖丢文本、改已有编号或现有夹具退化。

## 链接、图片与生命周期

- 复用 `parseFileLink`、`fileOpenIntent`、现有悬停文本和宿主帧。普通单击只读、Alt 打开校验后的真实文件、Ctrl/Cmd + HTML 家族走系统浏览器；校验失败的只读回退与提示不改。`#` 页内锚点保持原路，危险 / 未认可 scheme 不导航。
- 外链仍只发一次 `openExternal`，必须 `preventDefault` + `stopPropagation` 防止 VS Code 外层再开一次。不能复制官方 URL 白名单而丢相对路径、盘符路径、带行号目标、`%5C` 或邮件链接等现有判据。
- 行内代码的文件目标继续由 `FileLinkPort` 精确 / 唯一别名判定，不能按“像路径”猜。词表晚于正文到达、cwd 变化、语言变化时按钮与悬停必须更新，悬停和点击持有同一个解析目标，歧义时不挂动作。
- 图片沿用 `localImages` 的执行世界读取、连接 + 会话缓存、有限并发和失败占位。HTTPS 图保留 no-referrer / lazy / async，HTTP 图仍拒绝；不增加远端 fetch、桌面文件路由、本机读盘回退或认证重定向。
- React 渲染的图片 / 按钮由 React 叶节点完全拥有。旧 `hydrateFileMentions`（replaceChildren）与 `hydrateLocalImages`（换 src / 失败节点）已在阶段 2 删除；图片 pending / ready / failed 由 `markdown/render.tsx` 的 `MarkdownImage` 自持，链接 title 在渲染时合并，不再有渲染后 DOM 改写。
- scope 改变即使 text 不变，也要清掉旧 data URL、失败占位和目标闭包，按新连接 / 会话重新请求；迟到 Promise / 回帧不得写新树。回帧前浏览器加载失败不是最终失败。卸载 / 重挂、同内容换会话、重连与重试都已回归。
- SSR / Node 测试导入不能在模块顶层强制访问 DOM 或加载字体；代码高亮沿用官方无 DOM 的延迟预热。普通 React Markdown 和直接 CodeBlock 可被无头测试导入；阶段 4 的公式排版须在无 DOM 时安全回退，不在导入期初始化排版；原始 HTML 本来就只输出文字。

## 代码高亮

当前验收：typecheck 4/4、190/190 离线断言（并发 8）、vendor 15/15、build 与 diff-check 通过。官方核心对拍覆盖路径语言、逐字符颜色 / 字形及原文保真；同一 DOM 入口在隔离 jsdom 和标准模式 Chromium 覆盖正文代码卡与 read / write / edit / workflow / inspect 五类工具节点，验证语法就绪、选区节点保护及旧结果隔离。各工具继续共用 `src/webview/markdown/highlight.ts`、`useCodeHighlight` / `HighlightedText` / `.md-code-surface`，不另造引擎。安装端 / 字体视觉 / 系统剪贴板 / 真实模型不由这些断言证明；安装端总体验收见「安装端验收（最终）」。

### 引擎、语言与主题

- 高亮核心逐字复用固定来源的官方 `src/vendor/ui-primitives/markdown/highlight.ts`；文件语言表逐字复用 `src/vendor/code-language/index.ts`，与其余 vendor 一起锁定 tag / commit、原始见证字节及规范化摘要。不在宿主适配层重写 grammar、别名表、引擎、主题规则或 token 样式计算。
- 官方核心使用细粒度同步 Shiki core、JavaScript 正则引擎与 CSS 变量主题；TypeScript / Shell / JSON 三种启动 grammar，其余由官方显式清单异步导入。既有单文件 IIFE 构建会内联这些模块，运行时注册仍按需，不新增网络请求、WASM 或动态代码求值。官方启动定时预热照用（Node 定时器 unref）；SSR 不访问 DOM、输出仍为纯文，但不再宣称导入后绝不预热引擎。
- 语言语义跟随官方：JS / JSX / TSX 统一使用 TypeScript grammar（JSX 近似），JSONC 使用 JSON grammar；宿主不另造专用引擎臂。`normalizeLang` 仅提取 info string 首个标识，兼容 VS Code 的 `typescriptreact` / `javascriptreact` 及既有 `pwsh`、`c++`、`c#` 提示，随后委托官方别名或官方扩展名表。路径映射包括 .env、jsonl、toml、psm1、vue 等，未知语言仍纯文。`resolveLanguage` 保留提示优先、未知提示回退路径、显式 text / plaintext 不反悔的宿主规则。
- 宿主使用官方 `StreamingHighlightSession.update` 的结构化 span 臂，单次完整输入；**不因此启用产品流式高亮，也不改变数学 streaming 行为**。官方懒加载完成通知驱动重试，10 秒未就绪则解除订阅并回退。`highlightToHtml` 不进入宿主 DOM。
- 仅将官方 `var(--shiki-foreground|token-*)` 映射到已有 `--md-code-*` 四主题变量；字形保留斜体 / 粗体 / 下划线 / 删除线，其他任意样式不透传。`.md-code-surface` 不增加卡片几何，字号 / 行高 / 背景 / padding / 换行不变。语法色仍用固定受控值，不取可能等于正文色的 `symbolIcon.*`，不承诺匹配任意 TextMate 主题。

### 缓存、限额与文本保真

- 缓存 key = 主题策略版本 + 官方归一化语言 + 原 code；成功 / 失败缓存与同 key 并发合并保留。条数上限 64、总字符上限 200000、单块 50000 字符、单行 4000 字符，均由宿主在请求前判断；最多 4000 段。tokenize 的选项使用锁定官方核心。未知 / 空 / 超限 / 引擎失败均原位纯文。
- 官方提供逐行文本 run；宿主使用相同的 LF / CRLF 行界转成原文偏移，孤立 CR 作为行内容保留，不额外切行；单行 4000 字符上限也采用同一分行规则，不能用孤立 CR 拆短引擎实际处理的行。每行拼接必须逐字符一致（仅允许 NUL → U+FFFD 的引擎差异），否则整块回退，绝不猜偏移。行间分隔符与未着色部分仍切原 code，保留 CR、CRLF、空行、tab、NUL、尾空白与末尾换行。复制仍读取原 code，折展行数规则不变。
- `highlight.test.ts` 对照官方完整语言后缀表，并用 TS / JSON / Python / TOML / Markdown 的真实官方结果逐字符对照主题与字形；原有缓存、上限、多行、原文保真断言继续执行。DOM 回归还覆盖正文 / 工具共用接线、语法就绪、选区屏障与旧请求隔离；来源锁防止官方副本漂移，不能由功能断言代替。

### React 接线与生命周期

- `CodeBlock` 只在 `phase === "settled"` 的 effect 里调 `highlightCode`；streaming / SSR 只输出纯文本，effect 不跑就不请求着色；官方模块可独立预热引擎。普通父级重渲染、locale / cwd / 文件词表变化不触发着色；只有 `code`、归一化语言与 `phase` 变化重新请求。
- 每个请求带取消标记与 key；卸载、代码或语言变化时取消旧结果，渲染前再核对当前 key，避免旧高亮覆盖新代码。`code` 改变的第一帧即退回纯文本，不等异步结果。
- 结果抵达时若活动选区与 `<code>` 相交（`selectionIntersectsElement` 用 `Range.intersectsNode`，含从段落拖进代码、跨两张卡；没有该 API 时回退到共同祖先双向包含），先暂存该结果，监听 `selectionchange`；选区清空 / 移开后再应用最新一份。请求被新代码 / 语言 / phase 取代或组件卸载时丢弃暂存，不应用旧结果。
- span 文本由原 `code` 切片生成，不拼 `innerHTML`；复制仍用原 `code`。卡片 DOM 身份、折展状态和完整选择文本在着色前后保持不变。

### 工具节点扩展

同一套纯模块与受控 span 已接入五类工具节点，范围仅为基础语法 token 着色，不做语义分析、LSP 或诊断，也不重做工具布局：

- **read**：一次 tokenize **完整返回窗口**（行文本按 `\n` 连接）后再按行切 token，不能用 `capRows` 的显示子集去 tokenize——否则被折叠的首尾会丢掉多行注释等跨行上下文。语言以结果 `meta.lang` 优先，缺失或未识别时按 `meta.path`（横幅里的路径）扩展名回退；显式 `text` / `plaintext` 仍纯文，未知扩展名也纯文。行文本按契约不含换行，异常时整卡回退纯文。行号槽、折展、复制文本与窗口计数不变。
- **write / edit**：只有工具结算后才着色，`active` / `phase` 由调用方明确传入，不能凭参数 JSON 是否完整推断 settled。write 无 diff 时按参数目标路径扩展名给预览取语言；有 diff 时以 hunk 的 `path` 为准，缺失才回退参数路径。运行中的 edit 即使已有参数级 diff 预览也保持纯文。
- **diff**：每个 hunk 独立把旧侧（context + del）与新侧（context + add）用 `\n` 连接后分别 tokenize，再按原 hunk 行序映射回单栏 / 双栏的每一行。只重建本 hunk 内的连续片段，不跨 hunk / 不连续片段拼整文件；缺上下文是安全近似，不解析 `+` / `-` 前缀为源码，也不改底色、增删计数、截断与符号。
- **workflow**：只认精确工具名，从完整参数取脚本字段（真实现行 schema 的 `script` 优先，旧包 `code` 兜底），以 JavaScript 进代码块；同一份参数去掉该字段后，其余参数仍以 IN JSON 显示并着色，不丢信息也不重复脚本。
- **通用 IN JSON**：参数完整解析为对象 / 数组时，结算后按 JSON 着色；标量参数、半截 JSON、非 JSON 原文与运行中都保持纯文，不猜日志、不拆字段树。IN 从第一帧起由同一个 `CodeText` 承载，只切换 `lang` / `active`，不按 JSON 资格替换宿主；参数原文到缩进 JSON 的既有显示行为不变。
- **inspect / schema JSON**：只对精确身份表（`cordis_inspect_list` / `cordis_inspect_query` / `cordis_inspect_self` / `cordis_package_inspect` / `cordis_runtime_inspect` / `session_event_read`）且**成功、整段可解析为对象 / 数组**的 OUT 按 JSON 着色。显示仍是完整原字符串（含 `inputSchema` / `outputSchema` 等深层字段），不拆字段树、不把所有 OUT 误当 JSON；错误、半截、标量与其它工具原样纯文，`session_event_read` 的标题 + 围栏文本也因整段不可解析而回退。
- **共享样式与文本保真**：新着色面挂 `.md-code-surface` 语义类，只提供 `--md-code-*` 主题变量，不引入卡片几何；高亮 span 的字形修饰规则不再限定在 `.code-block` 内。diff 背景、read 卡布局、IN/OUT 文本排版与 `CodeBlock` 均保持原规则。所有显示文本仍由原字符串切片，复制载荷（read 窗口行、diff 行、完整 OUT、脚本与参数）不变；未知语言、超限、引擎失败与 SSR / 运行中都回退纯文。
- **验收状态**：typecheck 4/4、189/189 离线断言（并发 8）、vendor 12/12、build / diff-check 通过且无 duplicate-case。受控真实浏览器已覆盖五面 token / 文本与状态切换：read 12 行 head/tail 折叠时，隐藏中间关闭注释后 tail 仍保留关键词色；split 同一 context 行旧侧注释色、新侧关键词色不同，且第二个 hunk 不串状态；write / edit running 无 token 且选区保持，read 语言增强与别名切换保持；inspect 资格变化时原 OUT TextNode 保留（稳定宿主），清选区后 87 token；write 无 diff 的 CRLF / tab / 尾 EOL 完整；四主题节点复用、复制三帧精确、FindBar `const total` 跨 span 计数 1/3；未知语言 / 超长 / 换行 / 错误 / JSON 失效等回退通过。本轮 read 缺 `lang` / VS Code language id 回退、通用 IN JSON 与语法 palette 去 `symbolIcon` 化已由主静态 DOM / 四主题 computed 与离线断言复验：图标色全部等于正文时 import / from / export / type 与 JSON key / string / constant 仍分色，15 项资格边界、running→ok 原 TextNode / 选区保持到释放、read 全 6067 字符复制与 JSON Ctrl+C 桥帧通过；本轮未做安装端验收，安装端 / 系统剪贴板 / 真实模型仍未覆盖。

## 数学语法、排版与安全

完成态公式由本地语法事实与固定来源的官方 TeX → React 适配器组成。`math` 围栏在 settled 转公式，`tex` / `latex` 围栏仍为源码；普通代码内部不做数学识别。完整 DOM 测试覆盖中文 `\text{或}`、表格 `$1,800\text{ 年}$`、不换行空格、复杂公式和宿主生命周期，不以分段 class 许可证明最终渲染成功。

### 本地解析适配（已落地）

完成态解析入口 `parseMarkdown(source, phase = "settled")` 在 `settled` 时调用 [math.ts](<../src/webview/markdown/math.ts>) 的 `parseSettledRoot`：用与 vendor `parseGfmWithMath` 相同的扩展集合与顺序（`gfm` + `cjkFriendlyStrong` + `mathCompatibility` + `math`）单次 `fromMarkdown`，再做官方同款本地图片恢复；不对源文 mask / 占位 / 二次 parse。`streaming` 仍用 vendor `parseGfm`。正文组件已调用 `parseMarkdown(text, phase)`，settled 下公式进入 `MathView`；未识别 math 节点由 `sourceFallback` 回退，不吞内容。

- **金额否决。** 只包 `math()` 公开的 `text[36]` construct：`this.now().offset` 读同一 source，命中保守金额形状才 `nok`，其余原样委托给官方 tokenizer。仅单个 `$`（`$$` 跳过）；在 64 code units 的有界窗口内找关闭 `$`，内容必须以 `^[0-9]+(?:[.,][0-9]+)*` 开头、不含 TeX 记号、无换行；关闭 `$` 后必须紧接非空白字符。自然语言分支要求金额后是 `[ \t]+\p{L}{2,}`（"5 and "）或标点 + 空白 + 词（"5. It costs "），因此 `$\alpha$`、`$-x$` 等后继公式不会被第一对吞掉；仅分隔符尾（"5.00、" / "5, "）更保守，只认字母、数字、`\` 与 `-`。`$5$`、`$5+10$`、`$5 $`、`$x$2`、`$5,$`、`$5.$` 仍是明确数学。**已知边界：** `$5.00$`、`$5-$10`、文末 `$5 USD$`、金额后紧跟括号等情况仍按官方数学；这是有界消歧，不宣称通用货币 / 语言识别。
- **权威闭合。** 包 `mathFromMarkdown().exit.mathFlowFence`：官方 handler 用 `data.mathFlowInside` 区分开 / 关围栏，开事件记录 open token，关事件记录 close token，`closed` 只由关闭 token 是否存在决定。EOF 结束的 flow（`$$\nx+y $$`、`$$\nx+y\n`）只有开事件，一律 `closed: false`，不读 raw 后缀。官方 handler 会把 `fragment` 压到栈顶，找 math 节点须从栈尾向前找最近的 `type === "math"`，不能只看栈顶。
- **候选事实。** `MathSource { form, delimiter, closed, start, end, raw, tex }` 写在节点 data；`form` 由定界符决定：`$` / `\(` 为 inline，`$$` / `\[` 为 display，同线 `$$x+y$$` 即使官方产 `inlineMath` 也记 display。`raw` 是 `position` 的源码切片（含容器前缀），`tex` 是官方 `node.value`（已去 `> ` / 缩进）；两者不能混用。缺位置或无法确认围栏事实时不标候选，渲染层按 `sourceFallback` 原文回退。
- **围栏。** `math` 围栏在 mdast 中仍是 `code` 节点；`mathFenceSource` 用既有 `codeSources.closed`（围栏 token 计数）与 `codePayload` 取 raw / 精确载荷 / 闭合事实，settled 下由 `render.tsx` 转成 `MathView`，streaming 仍走 `CodeBlock`。`tex` / `latex` 永不进入数学。
- **单遍约束。** 金额否决在 tokenizer 内完成，围栏事实在 mdast handler 内记录，解析后只做一次树遍历；没有全文占位符、PUA 恢复、重复 parse 或 module 级活跃上下文。vendor 源码与来源锁不改；本地装配顺序由“非金额语料与 `parseGfmWithMath` 去事实键后树等价”的正式断言守住。

### 官方 KaTeX → React 与本地资源

- **固定来源直接复用。** [vendor katex.tsx](<../src/vendor/ui-primitives/markdown/katex.tsx>) 的 `renderTexToReact(value, displayMode)` 保留上游实现：KaTeX 首次严格排版，失败后按 `strict: "ignore"` / `throwOnError: false` 重试，再由 `DOMParser` 解析库输出并直接映射为 React。没有本地 class / style / tag 白名单、DOMPurify、namespace 折叠或 HTML 注入。源码与 TSX 原文见证由来源锁校验。
- **宿主边界。** [mathRender.ts](<../src/webview/markdown/mathRender.ts>) 只接受解析确认的事实；未闭合、超过 4000 UTF-16 code units 或无 DOM 均在加载适配器前回退。只缓存加载 Promise，不缓存公式、渲染树或宏表。官方错误树中真实的 `katex-error` class token 触发 raw 回退，正文 `\text{katex-error}` 不误判；未知命令的可恢复文本表现保持官方行为。
- **安全与限额。** 不接收模型 options；使用固定 `katex@0.16.47` 与官方选项，默认 `trust: false`、`maxExpand: 1000`、每式独立宏表。没有本地 `maxSize: 10` 夹限或 HTML 长度限额；尺寸采用官方默认，宽公式由 MathView 局部滚动承载。危险命令不能启用链接、图像、任意 HTML / class / style / data 能力。原始 Markdown HTML 始终为 React 文本，不能进入该库输出映射链。
- **DOM 边界。** 与固定官方实现一致，`DOMParser` 读取 KaTeX 输出，React 自行创建 MathML / SVG 子树；不自建 namespace 修补器。视觉层是 `.katex-html`，辅助层标签 / annotation 保留；辅助技术实际朗读不以 DOM 存在冒充。jsdom 未实现 `MathMLElement.style`，带该样式的 `\pmb` 语料留给同一入口的真实 Chromium 验证，不用伪造 style 属性把测试刷绿。
- **本地资源。** [katexAssets.mjs](<../scripts/katexAssets.mjs>) 在 esbuild 读取 `katex.min.css` 时把 20 个 `@font-face` 各收敛为恰好一个 WOFF2，file loader 输出 `dist/fonts/<name>-<hash>.woff2`，CSS URL 为相对 `./fonts/`；构建后核对每个 URL 存在且没有 WOFF / TTF / 远程来源。`main.tsx` 在 `tokens.css` 之后、`app.css` 之前引入同一份 KaTeX CSS，仍只有 `dist/webview.css` 一个样式产物；`dist` 文件白名单、`font-src ${webview.cspSource}` 与 `localResourceRoots: dist` 不变，预览服务器补 `.woff2` MIME。
- **自动化验证。** [mathRender.test.ts](<../scripts/mathRender.test.ts>) 在 Node 验证无 DOM 边界，随后用仅开发依赖 jsdom 的隔离 realm 运行 [mathDomBrowser.ts](<../scripts/mathDomBrowser.ts>)：实际 KaTeX → DOMParser → 官方 React → React DOM，对拍同输入官方树；正文 / 表格中文、四定界符、math fence、普通代码字面、失败 / 超限、宏隔离、危险命令、迟到结果和 raw / 已排版选区冻结均走完整链。jsdom 不证明布局、字体或屏幕阅读器；这些仍需真实浏览器 / 安装端独立验证。

### MathView 接线与生命周期

- 根节点是 React 控制的 `span`，带 `data-math-view="inline" | "display"` 来源标识；该标识只由解析层事实给出，模型提供的 class / 属性不参与。inline 保持行内；display 的 `span` 由 `.math-view-display` 块化，不把 `div` 放进 `p`、heading 或表格单元格。
- 段落内含 display 时，`renderParagraph` 把段落切成多个独立 `p` 与块级公式，不产生空段落；heading、表格单元格、回退引用等不可拆容器无法切 `p`，在 display 两侧放逻辑 `"\n"` 文本节点，避免后继搜索把相邻文本拼成一个词。`strong` / `em` / `delete` / 已解析链接会把公式与两侧内容拆开，不吞内容。
- `phase` 是唯一增强开关：streaming 只走 GFM，不产生数学节点、不初始化 KaTeX；settled 才懒调 `renderMath`。首帧与 SSR 显示 `raw` 原文；成功时直接挂载官方 React 树，未闭合、超长、缺 DOM 或官方排版失败继续显示 `raw`，不补定界符、不拼错误 HTML。
- effect 以 `{form, closed, raw, tex, phase}` 为依赖，变化即取消旧请求，迟到结果不得写新式；`memo` 只比较这些 primitive，普通父级重渲染、词表 / cwd / i18n 变化不重新初始化引擎。
- 结果带渲染身份（phase 与 `form` / `closed` / `raw` / `tex` 的 JSON 元组，NUL 安全）；render 期只显示与当前有效身份一致的结果，source 变为无效时第一帧就回 `raw`，不靠 effect 事后清旧 DOM。选区冻结复用 `useSelectionFreeze` 冻结完整 `{source, phase}` 快照（含 raw / form），而不是只冻结已排版树；释放后才切到新事实并重新排版。
- 主真实浏览器验收（严格 nonce CSP、生产 CSS、本地 WOFF2）：15/15 布局覆盖四类定界符、strong / em / link / reference、tight / loose 列表、引用、表格、脚注、围栏与金额；display 为合法 DOM、无 p 内块且无正文横向溢出，宽公式根 clientWidth 320 / 内容 1168 局部滚动。跨段至公式的选区保持 raw 且不增强；`newsource → invalid` 在首个 layout-effect commit 即为新 raw；raw 或已排版选区遇 source 更新均保留原 TextNode / 完整旧快照到释放，释放后新 source 生效。
- 结果应用前用 `selectionIntersectsElement` 检查根节点：与活动选区相交时暂存最新结果并监听 `selectionchange`，选区清空 / 移开后再应用；请求被新身份取代或组件卸载时丢弃暂存。查找只跳过可信 MathView 的辅助层；复制不做数学去重，Ctrl/Cmd+C、右键复制与引用仍读原生选区（可能含 MathML 或不同格式，属本次接受的边界），见「搜索、复制、选区与阅读」。

### 排版与安全契约

- 完成态使用固定官方数学扩展：行内 `$…$`、`\(...\)`，块级 `$$…$$`、`\[...\]`，以及 `math` 围栏；`latex` / `tex` 围栏仍显示源码。streaming 不调用 KaTeX，math 围栏此时仍为代码。四类定界符遵循各自 grammar：`$` 与 `\(` 是 text；`$$` 在行首是 flow、在正文中间是 size-2 text（产品和事实模型都记 display）；`\[` **只有行首**（含引用 / 列表内容行首）才是 flow。同一行正文中间的 `\[x\]` 官方不解析成数学，本阶段不新增 text construct、不自造规则，列为已知语法边界。
- 金额、转义、空公式、定界符旁空白 / 数字、奇偶反斜杠、同段 `$$`、多行、未闭合和容器边界，先采用固定来源实际规则并移植其夹具；单美元不能把 `$5 and $10` 误认。不得复制上一版文档的手写 tokenizer 规则另建一套“等价语法”。
- 数学只来自语法确认的节点，不用 auto-render 扫描整篇 DOM，不在代码、链接 / 图片目标或 html 节点内容中二次识别；标签周围若被官方语法解析为独立 Markdown / 数学节点，按其节点处理，不另建 HTML 感知规则。未闭合不补齐。用源码位置保留无效公式回退片段及定界符，不能只回退已去定界符的 node.value。
- KaTeX 的选项与三臂错误处理直接沿用固定官方实现；宿主只限制单式源码长度，不传入模型 options、不跨公式共享宏表。失败保留 raw，不显示异常消息或注入错误 HTML。
- 官方适配器保留 HTML 视觉层与 MathML / annotation 辅助层并返回 React 树，MathView 不调用 `dangerouslySetInnerHTML`。仅已确认数学节点可调用，不接收原始 HTML。
- 安全回归检查实际生成的 React DOM：危险 TeX 与伪造项目标记不产生主动元素、事件、链接 / 图像 / data 属性或任意样式能力；不维护第二份 KaTeX 词汇表。
- 块公式独立块容器局部横向滚动，不能 p 包 div、撑宽聊天或缩小整篇；行内公式基线和字号跟随现有正文尺度。分式、根式、矩阵、伸缩括号、重音等须证明与官方输出一致且真实浏览器布局可用。

## 搜索、复制、选区与阅读

- 高亮 span 的合并文本必须等于 code，现有跨文本节点查找继续生效；覆盖跨 token、空白、中文、末行和折叠代码的既有查找策略，不顺便扩大隐藏内容搜索范围。
- FindBar 打开时的种子文字取原生 `Selection.toString()`；辅助层过滤只作用于采集正文的文本节点，不改变种子路径。
- KaTeX HTML、MathML、TeX annotation 有重复文本；查找只采集视觉层，排除可信辅助层 / 注释。内部公式标识由 `data-math-view` 来源属性给出，不由模型 class 触发特殊路径。该辅助层判据只服务查找；复制与选区提取不再共用去重判据。不能泛化为排除所有 aria-hidden，KaTeX 视觉层可能恰带该属性。
- 会话 Ctrl/Cmd+C、右键复制和引用继续共用 `chatSelectionText`（原生 `Selection.toString()`），普通选区空白 / 换行不变；右键入口仍按既有规则去首尾空白。选区可能包含 MathML / annotation 或不同格式的空白，这是本次接受的边界。用户整条消息复制按钮取原始 message text、助手轮尾复制取最后一段正文的 Markdown 原文（都不取 DOM），代码按钮复制取精确 code，三者都不做重复内容清理；MathML 仍保留在渲染输出中供辅助技术使用，不加公式按钮。
- 数学选区去重不列入目标：不克隆副本、不写临时 style、不建哨兵 / 镜像、不改 live DOM / Selection，也不把原生选区替换成视觉层文本。用户已明确该能力复杂、小众且易出 BUG，复制沿用原生读取。焦点在 input / textarea / contenteditable、跨正文边界、组字或特殊组合键时仍让原生处理，不扩展快捷键范围。
- 结束时有选区先冻结 `{text, phase}`，没有选区才统一增强。异步高亮 / 字体 / 图片结果不得改写仍被选中的内容；代码卡在结果抵达时若活动选区与 `<code>` 相交，暂存结果并监听 `selectionchange`，等选区清空 / 移开再应用最新一份。不能只冻结父 props 却让内部异步结果替换 DOM。
- DOM 更新会使旧 Range / 查找高亮失效：查找在 MutationObserver 回调里立即清空旧 Range 与注册表，保留计数与激活位置，再按 150ms 防抖重算；导航前检查 Range 两端 `isConnected`，脱树不导航，不持有已卸载节点。代码折展、公式排版、字体就绪及图片变化引起高度变化时，原本贴底才继续跟随；用户上翻不抢底，不新建第二套 scrollTop 仲裁。
- 轨迹内变化继续服从其现有虚拟化测量、pin 与定位回执；不能只验证聊天正文就假定轨迹摘要 / 详情的高度与锚点也正确。

## 构建、依赖与资源

- 复用 micromark / mdast 与 Shiki 精选入口，数学解析依赖 `micromark-extension-math@3.1.0` / `mdast-util-math@3.0.0`，排版锁定 `katex@0.16.47`。DOMPurify 与自建数学净化模块均已移除；jsdom / 类型声明仅为开发期完整 DOM 回归依赖，不进入产品 bundle。
- 构建为 KaTeX CSS / 字体补本地资源流程，优先 WOFF2，产物在 dist 范围；CSS URL 相对最终样式文件可解析，不留下 node_modules、开发服务器、绝对本机地址。无外部字体、额外脚本分包、WASM 或网络权限。
- 核对既有 font-src、style-src、localResourceRoots 与文件白名单，保持脚本 nonce / 无 unsafe-eval。分别验证静态预览和 VS Code webview 的字体路径 / CSP，前者成功不代表后者已验收。
- 更新锁文件、[第三方声明](<../THIRD-PARTY-NOTICES.md>)、vendor 原文 / 来源锁、资源清单及目录 README。新本地派生源码须披露官方来源；Shiki grammar / theme 与 KaTeX JS/CSS 按 MIT 归属，随包分发的 KaTeX WOFF2 字体按 SIL OFL 1.1 单独归属（保留字体名与完整 OFL 见第三方声明）。
- 实施前后记录 JS / CSS / 字体 / VSIX 体积、首次初始化、长文解析和结算延迟。缓存有界，不全局永久保存整棵文档、敏感正文或宿主闭包。阶段 3 已按实际长行耗时测试收紧单行上限（见「代码高亮」）；首次初始化与结算延迟仍以本地复测为准，不把单机数字写成通用 SLA。有明确阻塞再评估 worker、语言裁剪或分包，不预先引入增量复杂度。阶段 4 本地解析的一次观察：密集金额 100 / 400 / 1600 段约 1.87 / 3.23 / 11.42ms，仍只保留末 `$x$`；该分布仅作观察报告，不设阈值断言。

## 迁移顺序与退出条件

1. **先固定基线与兼容性。** 采集现有真实输出预览夹具、代表性 DOM / computed style / 截图、复制和宿主帧；固定官方来源、原始 HTML 字面输出的有意差异及代码源码保真方案。其余安全 / 普通显示不一致未解决前，不以着色掩盖迁移问题。（已完成）
2. **只切换管线。** 建立官方解析适配与完整 React 渲染，迁移全部消费入口、脚注、路径、图片和节点所有权；此时不接高亮 / 公式排版，用无增强基线证明标准 Markdown 与原界面一致，原始 HTML 则按新契约验证只输出文字。测试阶段可对旧 / 新输出作差分，不保留生产双引擎、功能开关或长期回退分支。（已落地；旧管线、旧测试与已无消费者的依赖一并删除）
3. **接入完成态代码。** 正文和 run_code 共用引擎 / 代码卡，完成主题、别名、原文、折展、缓存、超限和失败回归；streaming 与静态 phase 各自固定。（已完成离线 / 静态与安装端渲染验收）
4. **接入完成态公式。** 同源解析事实、固定来源官方 TeX → React、MathView 生命周期、display 切分、本地 WOFF2 与 FindBar 辅助层过滤形成单一生产链。完整 DOM 回归与真实浏览器布局分别验收，复制不做数学去重。
5. **收尾与安装验收。** 检查会话 / 连接切换、选区延迟、异步高度、轨迹测量、主题 / 尺度与 VSIX 资源；用户功能说明与 CHANGELOG 在版本发布时更新。（资源包 / 专用目录安装 / CSP / 字体通过；系统剪贴板端到端与屏幕阅读器实际朗读未覆盖；功能交付完成）

阶段提交应可定位与回滚；发现安全或现有行为回归优先整体回滚对应阶段，不通过运行时开关保留两套长期管线。系统剪贴板等未覆盖的安装端结果应明确列为未验证，不得用构建成功代替。

## 验收矩阵与证据

测试穿过同一 Interface / Seam，不以 import 文本、CSS class 出现或“没有抛错”证明功能。安全内部 Seam 可以独立测试，但不向业务公开测试开关。

| 层级 | 必须覆盖与判定 |
|---|---|
| 解析 / 源码 | GFM 表格、任务、软硬换行、引用 / 图片定义跨代码、中文加粗、Windows 正反斜杠 / `%5C` / 点目录 / 中文 / 行号 / UNC / 非目标文本；参考定义、嵌套脚注、缺定义与重复引用；已知差异逐项审查 |
| 树结构 / 普通 DOM | 根首尾边距、段落 / 列表 / 引用嵌套、表格容器、脚注结构；三反引号 / 长 / 波浪 / 缩进 / 未闭合代码正确在原容器内；原始 HTML 的行内 / 块级 / 跨节点标签和注释显示为文字，混排时不解释为 DOM、不修复标签嵌套、不吞源码 |
| 代码 Interface | 语言 / 别名 / 未知 / 恶意标签、JS 正则不支持的 grammar；token 文本逐字相等，CRLF / 空代码 / 尾换行 / tab 保真；20 / 21 行、折展状态跨 phase 保持、变短展开；streaming 零增强调用、缓存淘汰 / 超限 / 初始化失败 |
| 数学 Interface | 四类定界符和 math / tex / latex 围栏、金额否决 / 转义 / 未闭合 / 容器；代码字面保真；raw / tex / closed / form 与官方语法等价；中文块式与表格、空格、分式 / 矩阵 / SVG；官方树对拍、宏隔离、失败 / 长度回退 |
| 真实 DOM 安全 | 危险 scheme、事件 / script / style / form / 主动资源与伪造内部标记不能获得能力；任务只读；官方默认不可信 TeX；原始 HTML 字面输出；失败 raw 回退 |
| 文件与图片交互 | 锚点 / 行内代码同目标、外链一次、页内锚点、Alt / Ctrl / Cmd、词表晚到 / 歧义；本地与 HTTPS、HTTP 拒绝、回帧前失败、最终占位、范围更换与迟到结果、原图 / 复制 / 保存 |
| 选择 / 搜索 / 阅读 | 跨 span 命中、查找不重复采集 MathML / annotation、原生复制 / 右键引用（可能含 MathML 或不同格式，接受）、跨消息 / 普通空白保真、编辑焦点让路；结束仍选中不增强，释放后追上；贴底与上翻、旧 Range 作废、轨迹虚拟化高度 |
| 视觉预览 | 同输入 / 主题 / 语言 / 字号 / 宽度前后截图与 computed style 对拍；明 / 暗 / 高对比、窄侧栏、代表性小中大字号，中英标题 / 按钮、代码渐隐和换行、宽表 / 宽公式、字体加载前后与离线加载 |
| 集成 / 发布 | 全部消费入口、SSR / Node 导入、vendor 来源锁、依赖裁剪；构建 CSS URL、字体与声明白名单、无全量语言包 / CDN / WASM；安装端 CSP / 字体、文件打开与系统剪贴板 |

阶段 2 已保留 [markdown.test.ts](<../scripts/markdown.test.ts>)、[footnotes.test.ts](<../scripts/footnotes.test.ts>)、[styles.test.ts](<../scripts/styles.test.ts>) 中的业务断言，并淘汰仅固定 marked 调用形状的断言；同步 fileLinks、localImageResolve、localImages、contextMenu、questionRender、trajectoryVendor、vendorSourceLock、manifest 等关联回归，没有因旧测试不再匹配而整段删除安全要求。阶段 3 新增 [highlight.test.ts](<../scripts/highlight.test.ts>)、[diffHighlight.test.ts](<../scripts/diffHighlight.test.ts>)、[toolSource.test.ts](<../scripts/toolSource.test.ts>) 与 [selectionRange.test.ts](<../scripts/selectionRange.test.ts>)，并扩展 [find.test.ts](<../scripts/find.test.ts>) 的脱树导航判据；阶段 4 新增 [math.test.ts](<../scripts/math.test.ts>) 覆盖金额、围栏闭合、容器源码 / 载荷分离与官方臂树等价，[mathRender.test.ts](<../scripts/mathRender.test.ts>) 及其隔离浏览器入口覆盖官方树对拍、中文 / 表格、限额、宏隔离、安全和选区完整 DOM 链，以及 [mathView.test.ts](<../scripts/mathView.test.ts>) 覆盖 SSR 首帧原文、四类定界符 / 金额、display 脱 p、strong / em / link / footnote 拆段、tex / latex 回退与渲染身份的五个事实 / NUL 不碰撞；真实异步与选区冻结已由主真实浏览器验收通过（15/15 布局、宽公式局部滚动、`newsource → invalid` 首帧 raw、跨段 / 跨公式选区冻结）。用户整条与助手轮尾复制分别取原始 `message.text` 与最后一段正文的 Markdown 原文、代码复制取精确 code，由 `mathView.test.ts` / `codeBlock.test.ts` 的源码接线与纯文本断言固定，不冒充 DOM / 系统剪贴板证明。全部登记在[脚本构建入口](<../esbuild.scripts.mjs>) entries。图片 / 链接 / 选区的真实 DOM 时序由受控浏览器回放，Node 静态源码检查不等同浏览器证据。

阶段 3 的代码高亮已有离线 / 受控浏览器验收。当前数学由 `mathRender.test.ts` 的完整 DOM 链与真实 Chromium 分别验证，来源锁包含 19 份副本。既有资源 / 安装记录见下节，只证明其记录时的资源与宿主环境，不替代当前官方 React 排版的回归。原生复制仍读 `Selection.toString()`；VS Code 系统剪贴板与屏幕阅读器朗读不在本次自动化覆盖内。不启动真实 DSH、不发送真实消息或运行模型探针。

### 安装端验收（已有资源证据）

- **资源包与安装。** `npm run package` 成功：验收时 VSIX 约 2.43 MiB / 39 files（最终打包随 README 变化）；dist JS 3,226,378 / CSS 157,113 / extension 510,403 / supervisor 14,113；20 个 WOFF2 共 259,792 B；包内无 woff / ttf / WASM / `.agent` / `node_modules`。`npm run install:vsix --` 在专用 `VSCODE_EXTENSIONS` / `VSCODE_APPDATA` 安装成功，installed 四产物 SHA256 与 dist 一致。
- **专用目录安装窗口。** 在专用用户配置 / 扩展目录下的 VS Code 1.143.0 窗口预写 `autoConnect=false`、command / url / desktop 为空；隔离的是用户配置与扩展目录，不等同于宿主全部状态隔离，未主动读取或导出宿主数据库 / 凭据。DSH 日志只有关闭自动连接、无 workspace 不恢复与视图实例化，没有真实 DSH 会话或消息。安装 webview 注入人工离线 state 后，经真实 listener 得到 3 公式 / 3 MathML / 10 高亮 span；20 个 `FontFace.load` 全部 loaded 且经 `vscode-resource` 路径；CSP 违规记录为空（`[]`），无 `unsafe-eval` / 放宽。上述为主安装验收报告的测量结论；这是安装渲染 / 资源证据，不是真实模型会话。
- **几何 / 长文 / 阅读（静态人工观察）。** mathless 标准合同与 phase 3 全部 11 块 relative 几何一致，wrapper 325×660.546875（最初误量 inner `.md` 656.546875，纠正为 wrapper，不是产品 bug）。40 math / 40 code、2518 字样本：streaming 68.5ms 零 math → settled 96.7ms 40 式 40 卡；4 主题下 math / token 节点相同、无横向溢出。真实 wheel 上翻 350 后追加公式 scrollTop 仍 350、不抢；贴底 settle 614→700 保持 gap 0。以上为主静态测量报告的结论；均为静态人工，非真实模型，耗时只作观察不设 SLA。
- **未覆盖边界（照实保留）。** 系统剪贴板端到端未做：为避免覆盖用户剪贴板已有 PNG，未点击安装窗口 copy 按钮，也未读取 / 保存该图片数据；系统剪贴板未被修改，不宣称系统复制已通过。静态 copy 三帧与原生 Ctrl+C 已在真实 DOM 通过，宿主 `clipboard.writeText` 代码本次未改。屏幕阅读器实际朗读未验收。功能交付完成，这不是“复制去重待补完”。

## 资料与重评条件

- [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)：语法与树扩展须配对；位置来自实际解析输入，源码适配不得破坏偏移关系。
- [官方源码](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-primitives/src/markdown)：按固定来源核对 parse、render、mathCompatibility、highlight 与 katex，UI 与安全差异按本文适配。
- [Shiki 精简构建](https://shiki.style/guide/best-performance)、[JS 正则引擎](https://shiki.style/guide/regex-engines)；[KaTeX 安全](https://katex.org/docs/security)、[选项](https://katex.org/docs/options)。最新资料只作参考，实际依赖版本和浏览器能力必须另核。

只有实际包体 / 结算卡顿、明确的语言覆盖缺口或可复现数学误识别，才重评对应内部实现；不因官方支持就增加流式复杂度。原始 HTML 按本文有意收敛到官方行为，其余既有视觉与行为不为省实现成本牺牲。
