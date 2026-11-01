# Markdown 管线迁移、代码高亮与公式渲染

## 状态与范围

本文覆盖正文 Markdown 的五个阶段：从 marked / HTML 分块迁到官方同源的 micromark → mdast → React 管线（阶段 2），再接入 Shiki 代码高亮（阶段 3）与 KaTeX 公式（阶段 4），最后做安装端收尾（阶段 5）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 基线、来源锁定与本文设计 | 已完成 |
| 2 | 解析 / 渲染管线切换，保持标准 Markdown 的视觉与行为；原始 HTML 改为字面文本 | 已落地 |
| 3 | 完成态代码高亮（Shiki） | 已完成离线 / 静态验收；安装端待验 |
| 4 | 完成态数学（KaTeX）与隔离净化 | 引擎 / 净化 / 资源已通过真实 DOM 验收（37×2、24 攻击、20 字体）；MathView / UI / 安装未完成 |
| 5 | 安装端 CSP / 字体 / VSIX 资源验收 | 未完成 |

阶段 2 的实现入口是 `src/webview/markdown/`：`parse.ts` 调用 vendor `parseGfm`，再做本地 Windows 链接目标修复与文档级定义收集；`source.ts` 用 micromark 事件流提取代码源文；`render.tsx` 把整棵 mdast 递归映射为 React。正文不再有整篇 HTML、`innerHTML` 或渲染后水合。阶段 3 已接入完成态代码高亮：`highlight.ts` 提供受控 token 与有界缓存，`CodeBlock` 只在 settled 生效并处理迟到结果与选区冻结；streaming 仍为纯文本。阶段 4 的 settled 解析事实（`math.ts`）已落地；KaTeX 引擎 seam（`mathRender.ts`）、私有净化（`mathSanitize.ts`）与本地 WOFF2 资源构建（`scripts/katexAssets.mjs`）也已就绪并通过真实 DOM 验收，但 `MathView` / 正文接线尚未实施，生产组件仍显式走普通 GFM，公式与 `tex` / `latex` 围栏按原文显示。

- 正文已从 marked / HTML 分块迁到官方同源的 micromark → mdast → React 管线；阶段 3 已把 Shiki 接进同一棵文档树，阶段 4 再接入 KaTeX。普通 Markdown、代码与数学共享一套节点所有权，不再建设 marked 私有槽、骨架标记和 React portal 方案。
- **迁移不是界面重设计。** 保留标准 Markdown 的字体、间距、代码卡片、折展、复制、插入、链接、图片、脚注、搜索和阅读行为；不整搬官方 UI、CSS Modules、工具栏或主题系统。原始 HTML 按官方作为字面文本显示，是明确接受的兼容差异，不再保留现有有限 HTML 渲染。
- 助手生成期间仍展示普通 Markdown；阶段 3 起，生成结束、停止、失败或截断后的 settled 代码块进入完成态高亮，streaming 期间不初始化引擎、不着色。阶段 4 接入公式后同样只在完成态排版。不做增量解析、增量高亮、自动补围栏或“围栏刚闭合就增强”。
- 历史消息和已确定的计划、工具详情直接使用完成态。阶段 3 起，`run_code` 完整调用参数可立即着色；工具运行状态不等于代码还在生成。
- 用户气泡仍显示原始文本；终端、文件预览、diff、JSON 检查器、轨迹源码与请求差分不纳入。不改协议、持久化消息或宿主权限，不加功能开关。

现有消息约束见[消息设计](<design-messages.md>)；文件访问见[文件路径](<design-paths.md>)；图片与外传边界见[安全设计](<design-security.md>)；尺度与复制分别见[界面尺度](<design-ui-scale.md>)、[右键菜单](<design-context-menu.md>)。

## 决策与官方复用边界

迁移前的 `webview/markdown.ts`（阶段 2 已删除）使用 marked、自有脚注、Windows 路径和中文加粗扩展，再由 DOMPurify 净化；`splitMarkdownBlocks` 只用正则抽取完整三反引号围栏。继续在其上补数学 token、私有槽和来源验证，会同时维护两套树与挂载生命周期。阶段 2 已统一语法基础，成本集中在一次兼容迁移，后续语法、嵌套、代码与公式共享同一 Seam。

官方已有 GFM / 数学解析、中文加粗、图片语法修复、mdast 渲染、Shiki 和 KaTeX；复用其语法与测试输入，而不是将整套组件作为黑盒替换。本扩展不需要官方流式缓存、增量会话、桌面图片路由、链接组件或整套主题依赖。

### 固定来源与适配

- 当前 vendor 基准为 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`，tag `dsh-v0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`；来源与锁定流程见[vendor 说明](<../src/vendor/README.md>)。不得把本机 HEAD 或最新文档当作该发布版的证据。
- vendor 的 [parse.ts](<../src/vendor/ui-primitives/markdown/parse.ts>) 已按固定 commit 恢复 `parseGfm` 与 `parseGfmWithMath` 两个语法臂，并补入 [mathCompatibility.ts](<../src/vendor/ui-primitives/markdown/mathCompatibility.ts>) 及配套依赖；轨迹纯文本投影与正文 streaming 仍只用 `parseGfm`，不得为了正文迁移改变轨迹摘要、搜索索引或事件投影。settled 数学由本地 [math.ts](<../src/webview/markdown/math.ts>) 用**同一扩展集合**装配并包装公开 construct / handler，不复制 vendor 的语法规则，也不直接改 vendor 文件。
- **解析适配已落地不等于数学排版完成。** 本地已能单遍产出金额否决后的公式候选、权威闭合事实与源码 / 有效 TeX 分离；KaTeX 引擎 seam、私有 DOMPurify 净化与本地 WOFF2 资源也已就绪并通过真实 DOM 验收，但 `MathView`、正文接线、display 拆 p、FindBar 与选区去重尚未实现，正文组件在接线前仍显式走 GFM。阶段 4 验收前不得把候选事实或引擎 seam 当作可用功能；金额规则的真实边界见下文「本地解析适配」。
- vendor 内仅保留获准的原文适配；Windows 链接修复、扩展资源策略、完成态高亮、安全限额和 UI 差异放在本地 Implementation。新搬文件必须同步原文夹具、文件头、来源锁和第三方声明；变更已有允许适配须说明理由，不能只改摘要求绿。
- 官方 `render.tsx`、`highlight.ts`、`katex.tsx` 可提供遍历、别名、CSS 变量主题和排版参考，但不原样复制。原始 HTML 显示为字面文本的规则直接对齐；链接与图片准入保留扩展契约，KaTeX 输出另做独立净化和资源限制。需要本地行为的派生实现放在 webview 层，注明固定来源及差异，不假称逐字 vendor。
- 官方 Markdown / DOM / 恶意 TeX 夹具可复用输入，断言必须改为本扩展契约，不能直接采用官方 DOM 快照并顺带改变 UI。

## Module、Interface 与 Seam

### 对外 Interface

业务仍只消费 `Markdown` 和 `CodeBlock`，不接触 micromark、mdast、语言注册、字体、净化器或渲染内部节点。阶段 2 已按下列 Interface 落地，阶段 3 在 `CodeBlock` 内按 `phase` 接入完成态高亮：

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
- 整条消息复制仍取原始消息文本；代码复制与插入仍取 `code`，不能从 DOM、着色 token 或 KaTeX 文本反向生成源数据。
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

阶段 2 按上述职责拆成 `src/webview/markdown/` 的 `parse.ts`、`source.ts`、`windowsDestinations.ts`、`render.tsx` 与 `types.ts`，文件清单见该目录 README；组件入口仍是 `components/Markdown.tsx`。阶段 3 新增 `markdown/highlight.ts`（引擎 / 缓存 / 受控 token）与 `webview/selectionRange.ts`（选区相交 / 脱树判据），沿用同一分层，不建没有第二个真实 Adapter 的注册平台。

## 消费面与影响清单

以下是当前入口；迁移时已再次搜索调用方，后续改动仍须防止新增消费面遗漏。

| 消费面 | 接入与必须保留的内容 |
|---|---|
| [Message.tsx](<../src/webview/components/Message.tsx>) 的 `StreamText` | 助手正文显式 phase，保留 `md-wrapper`、本轮 `fileLinks`、cwd、消息身份与选区冻结；历史回放直接 settled |
| [Rows.tsx](<../src/webview/components/Rows.tsx>) 的 `run_code` | 复用相同 CodeBlock、默认 settled；不改工具折展、参数提取、按钮帧与执行状态 |
| Rows 的 `review.plan`、`item.detail` | 审阅计划与思考详情继续走 Markdown；默认 settled，不把问卷、审批或计划动作搬进渲染 Module |
| [ToolCards.tsx](<../src/webview/components/ToolCards.tsx>) 的 `card.answer` | 网页搜索答案与正文采用同一语法 / 安全链；不凭空获得助手本轮文件词表 |
| [Trajectory.tsx](<../src/webview/components/Trajectory.tsx>) 的 `previewMarkdown`、`outputDetail` | 已投影的 Markdown 按完成态显示；不改 ledger、虚拟化、定位回执、源记录视图和纯文本摘要算法 |
| [Markdown.tsx](<../src/webview/components/Markdown.tsx>) / [CodeBlock.tsx](<../src/webview/components/CodeBlock.tsx>) | 统一文档树和叶节点入口；阶段 2 已移除旧分块、整篇 innerHTML 与水合所有权，`Markdown.tsx` 只做 `parseMarkdown` + `renderMarkdownDocument` 的薄包装 |
| [FindBar.tsx](<../src/webview/components/FindBar.tsx>)、[contextMenu.ts](<../src/webview/contextMenu.ts>) | 着色 span 跨节点搜索、数学去重、复制 / 引用及边界判定；不扩大快捷键接管区域 |
| [markdown/render.tsx](<../src/webview/markdown/render.tsx>) 的链接 / 图片叶节点、[linkHovers.ts](<../src/webview/linkHovers.ts>)、[localImages.ts](<../src/webview/localImages.ts>) | 目标判据与作用域保留，节点由 React 拥有；旧 `hydrateFileMentions` / `hydrateLocalImages` 已删除，不能再对 React 树做命令式 DOM 改写 |
| [app.css](<../src/webview/styles/app.css>)、[tokens.css](<../src/webview/styles/tokens.css>) | 适配树结构引起的选择器差异，保留现有视觉 token 与尺度；限定高亮、数学新增样式的作用域 |
| [chatView.ts](<../src/chatView.ts>)、[esbuild.mjs](<../esbuild.mjs>)、[package.json](<../package.json>) | 本地字体、CSS URL、发布白名单、依赖裁剪及 CSP 验证；无协议和宿主能力新增 |
| [markdown.test.ts](<../scripts/markdown.test.ts>)、[footnotes.test.ts](<../scripts/footnotes.test.ts>)、[markdownSource.test.ts](<../scripts/markdownSource.test.ts>)、[localImageResolve.test.ts](<../scripts/localImageResolve.test.ts>) 等 | 已迁到真实新入口：SSR 行为、代码源文逐字符、图片解析范围与回帧；保留原夹具表达的安全与行为不变量 |

## 整篇解析与 React 文档树

阶段 2 已落地的主链（阶段 4 再补 `MathView` 叶节点）：

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
- Windows 路径修复在本地解析 Seam 完成：`windowsDestinations.ts` 在解析后按链接 / 图片节点的源码位置回原文取目标，仅对呈 Windows 绝对路径形状的 `\` 编码为 `%5C`。上游 `recoverLocalImages` 先跑、本地修复后跑，已用含 `%5C` 的重叠夹具验证不会二次编码；不能对全文替换反斜杠。代码、标签、参考定义、非 Windows 目标和 UNC 访问边界不变。
- 中文强强调沿用官方 `cjkFriendlyStrong`，已用迁移前的中文标点、西文、单星、三星、代码内星号夹具对拍；不能以“官方如此”为理由静默扩大既有偏差。
- 代码依赖 `code` 节点，不再全文围栏正则切分；较长围栏、波浪、未闭合、缩进代码以及列表 / 引用 / 脚注内代码均保留所属容器。未知树节点按 `sourceFallback` 回退为安全源码片段，不沿用官方“默认返回空”吞内容。
- 文档级定义统一收集在 `MarkdownDocument.definitions` / `footnotes`：参考链接与图片可跨代码块解析，脚注编号与重复引用计数只属于本次文档。脚注定义重复时 last-wins，参考定义 first-wins，沿用迁移前口径。
- 使用稳定的文档身份和节点 key；同一代码块从 streaming 到 settled、着色初始化完成、主题或词表变化时，不重建卡片而丢失用户折展选择；阶段 3 已按此保持卡片 DOM 与折展状态。源码 offset 不能单独作为跨消息身份，不能跨连接复用交互闭包。

### 代码原文保真

mdast 的 `code.value` 会经过语法规范化，不能默认等同旧 CodeBlock 接到的源代码。实现须分清“带围栏的原始片段”“去掉围栏和容器缩进的代码载荷”“着色 token”。

阶段 2 的 `source.ts` 用与解析同源的 micromark 事件流（`codeFenced` / `codeIndented` 的 `codeFlowValue` + `lineEnding`）定位每行内容：内容字符从源码切片取，`context.sliceSerialize(token)` 只补“部分消费 tab”的虚拟空格（比较时把源码 NUL 按 micromark 规范映射成 U+FFFD，避免 raw 含 NUL 时丢失 padding；补回的仍是源码字符）。每份文档只在确实有代码时多解析一次，不按代码块数重复。

既有顶层三反引号的复制 / 插入结果作为基线；末尾换行、连续空行、空代码、CRLF、tab、缩进和行尾空格不得因 AST 迁移或 Shiki 按行输出丢失。新支持的嵌套代码应去掉 Markdown 列表 / 引用前缀，而非将其复制为代码。源位置切片须结合语法 token / 容器规则提取，不能直接 slice 整个 code 节点，也不能用 trim / split-join 猜回原文。高亮显示文本、code prop 与复制载荷须逐字符一致；同一载荷的行数判定保持 `code.split("\n").length > 20` 的现有边界。以上由 `markdownSource.test.ts` 逐字符覆盖。

### 原始 HTML 跟随官方显示为文字

扩展没有向 agent 约定额外的 HTML 渲染能力，不为低收益的历史白名单增加 HTML 导入器、跨节点拼接、二次解析或双引擎。mdast 的 `html` 节点直接在 `render.tsx` 里作为 React 文本子节点输出，不删除内容、不解释标签，也不提供兼容开关。无需改变 agent 提示词。阶段 2 已按此实现。

- 标准 Markdown 生成的表格、加粗、链接、图片、任务列表等仍正常渲染；它们来自已知语法节点，不是开放原始 HTML。Markdown 的硬换行继续有效，直接写的 `<br>` 则显示标签文字。
- 原始 `<span>`、`<a>`、`<img>`、`<pre><code>` 等不生成排版、导航、网络请求、代码卡片或文件按钮；模型提供的 class、id、data 属性不生成任何 DOM 属性或内部身份。代码围栏中的 HTML 始终仍为代码。
- 标签周围的 Markdown 按官方语法解析，不另做浏览器式 HTML 嵌套修复；只要求 html 节点的原始内容不被当作 DOM。混排夹具覆盖行内 / 块级、注释、危险标签和伪造组件标记。
- **有意的兼容差异：** 少量历史回答中原来可显示的有限 HTML 会变成标签文字，不做历史数据迁移、不按消息新旧分叉。该变化在对应版本的 CHANGELOG 与根 README 中说明，不能将其误报为所有旧输出完全等价。
- KaTeX 的内部 HTML / MathML 是私有 MathView 的排版产物，只能从数学节点进入隔离净化流程，不意味着允许回答中的任意 HTML。普通 Markdown 不再经过整篇 HTML 净化 / 导入链。

## 视觉与行为不变量

阶段 2 的有意变化只有两处：正确呈现旧正则未覆盖的合法嵌套代码，以及原始 HTML 改为字面文字；阶段 3 再增加完成态代码颜色，阶段 4 增加完成态数学排版。其余标准 Markdown 内容不得借迁移重排、换肤或改操作，已由静态浏览器回放逐项对拍。

| 区域 | 保持要求与容易遗漏的差异 |
|---|---|
| 正文根与边距 | 保留 `md-wrapper` / `.md` 语义；多个旧 HtmlBlock 合成一个文档根后，首尾 margin 归零、代码前后段距、相邻列表与脚注不得改变。不能直接把旧 `.md > *` 假定为等价 |
| 基础排版 | 段落、标题层级、列表缩进 / 起始序号、紧凑 / 松散列表、引用边框、分隔线、删除线、实体、软 / 硬换行维持现状；表格继续局部横向滚动，不撑宽会话 |
| 行内代码与文件按钮 | 保留代码芯片底色、圆角、字号和 `code > button.file-mention`，长路径左对齐和整体底色；锚点内不再嵌可交互按钮 |
| 任务列表 | 已完成 / 未完成有可见区别，checkbox 只读且 disabled；模型不能藉 HTML 引入 text / file 等输入控件 |
| 代码卡片 | 沿用 `.code-block*`、编辑器底色、outline、标题和悬停 / focus-within 按钮；不增加行号、工具栏或逐行操作，不换官方卡片 |
| 代码换行与折展 | 继续 `pre-wrap` + `break-all` 自动换行，不改为横向滚动；超过 20 行默认收起，160dp 裁切和 48dp 渐隐、箭头方向 / 120ms 过渡、用户展开选择保留；变短强制展开 |
| 代码字体 | 继续 `--mono`、`--mono-size` 与 1.5 行高，高亮 span 只改受控颜色 / 字形修饰，不覆盖字号、背景、padding、换行或行高；必须检查 `.md code` 对新嵌套卡片的级联 |
| 图片 | 尺寸上限仍为 `min(100%, 640dp)` × 360dp，按比例缩放，点击原图、zoom-in 光标、右键复制 / 保存、失败占位和替代文本一致 |
| 脚注 | 首次引用编号、重复引用同号、仅有定义不输出、缺定义不输出空脚注区；`sup`、`.footnotes`、`.sr-only` 标题、文末箭头及重复上标保持，不顺便加可点击回跳链接；中英标题随语言切换 |
| 主题与尺度 | 保留 VS Code 明 / 暗 / 高对比、编辑器字号联动和 `--dp`；不写覆盖全局的 KaTeX reset，不改变主题滚动条，不另用 zoom；非默认字号验证窄栏布局 |
| 可访问性 | 保留按钮焦点 / title / aria-expanded、键盘操作和只读任务语义；新增数学辅助层可读但不重复朗读，不能为美观隐藏全部 MathML |

GFM 对多段脚注、重复定义、复杂分隔符等边缘输入可能与迁移前的自有解析器不同；阶段 2 已用迁移前夹具对拍新旧输出，差异逐项确认（脚注重复定义 last-wins、参考定义 first-wins）。新增标准语法支持可以有意扩展，但不能以“遵循标准”掩盖丢文本、改已有编号或现有夹具退化。

## 链接、图片与生命周期

- 复用 `parseFileLink`、`fileOpenIntent`、现有悬停文本和宿主帧。普通单击只读、Alt 打开校验后的真实文件、Ctrl/Cmd + HTML 家族走系统浏览器；校验失败的只读回退与提示不改。`#` 页内锚点保持原路，危险 / 未认可 scheme 不导航。
- 外链仍只发一次 `openExternal`，必须 `preventDefault` + `stopPropagation` 防止 VS Code 外层再开一次。不能复制官方 URL 白名单而丢相对路径、盘符路径、带行号目标、`%5C` 或邮件链接等现有判据。
- 行内代码的文件目标继续由 `FileLinkPort` 精确 / 唯一别名判定，不能按“像路径”猜。词表晚于正文到达、cwd 变化、语言变化时按钮与悬停必须更新，悬停和点击持有同一个解析目标，歧义时不挂动作。
- 图片沿用 `localImages` 的执行世界读取、连接 + 会话缓存、有限并发和失败占位。HTTPS 图保留 no-referrer / lazy / async，HTTP 图仍拒绝；不增加远端 fetch、桌面文件路由、本机读盘回退或认证重定向。
- React 渲染的图片 / 按钮由 React 叶节点完全拥有。旧 `hydrateFileMentions`（replaceChildren）与 `hydrateLocalImages`（换 src / 失败节点）已在阶段 2 删除；图片 pending / ready / failed 由 `markdown/render.tsx` 的 `MarkdownImage` 自持，链接 title 在渲染时合并，不再有渲染后 DOM 改写。
- scope 改变即使 text 不变，也要清掉旧 data URL、失败占位和目标闭包，按新连接 / 会话重新请求；迟到 Promise / 回帧不得写新树。回帧前浏览器加载失败不是最终失败。卸载 / 重挂、同内容换会话、重连与重试都已回归。
- SSR / Node 测试导入不能在模块顶层强制访问 DOM、创建引擎或加载字体。普通 React Markdown 和直接 CodeBlock 可被无头测试导入；阶段 4 的公式排版须在无 DOM / 净化不可用时安全回退，不假造净化结果；原始 HTML 本来就只输出文字。

## 代码高亮

阶段 3 已完成离线 / 静态验收：typecheck、184 套离线断言、build、diff-check，以及受控浏览器下的严格 CSP、断网组件、跨段 / 跨卡选区、精确桥帧、语言别名切换、四主题、全 App FindBar 与增强前后几何一致性均通过。安装端 CSP / 字体 / VSIX 与系统剪贴板仍未验收。实现分为纯模块 `src/webview/markdown/highlight.ts` 与 `CodeBlock` 的接线两部分。

### 引擎、语言与主题

- 细粒度 `createHighlighterCore` + `createJavaScriptRegexEngine` + `createCssVariablesTheme`；无 Oniguruma WASM、CDN、网络或 unsafe-eval。单文件 IIFE 首版不复制官方动态分包 / 增量会话。
- 显式静态语言集合：JavaScript / TypeScript / JSX / TSX、JSON / JSONC、Python、Shell、PowerShell、C / C++、C#、Go、Rust、Java、HTML、CSS、SQL、YAML、Markdown、diff。语言模块按 `name` 去重（HTML 模块自带 JS / CSS、TSX 复用 TS / JSX 依赖）；嵌入语法依赖显式登记。JS 引擎不能准确支持的 grammar 纯文本回退，不用宽松模式制造看似正确的颜色。最终集合在实现验证后锁定，不自动猜语言。
- `normalizeLang` 取首个语言标识并用显式 `Map` 归一化 js / ts / py / sh / ps1 / yml 等别名；`constructor` / `__proto__` / `toString` 不命中对象继承成员。显示仍保留原标签；高亮身份与请求使用归一化语言，因此 `ts` / `TypeScript` / `ts title=x` 之间切换不拆已有 span、不重新请求。
- 每 webview 一个按需初始化实例；初始化失败不让卡片消失。结构化 token 生成 React span，不将 `codeToHtml` 拼回普通 HTML；主题变量只接受 `var(--md-code-foreground|token-*)`。CSS 在 `.code-block` 定义四类 `body.vscode-light/dark/high-contrast/high-contrast-light` 回退，并用 `@media (prefers-color-scheme: light)` 覆盖无 VS Code 主题类的预览浅色；高亮 span 只改受控颜色与 `is-italic` / `is-bold` / `is-underlined` 字形修饰，不改字号、字体、行高、背景、padding、换行或卡片布局。不承诺匹配所有用户 TextMate 主题。

### 缓存、限额与文本保真

- 缓存 key = 主题策略版本 + 归一化语言 + 原 code；成功与失败都缓存，同 key 的并发请求共享一次 tokenize 与一次记账。条数上限 `MAX_CACHE_ENTRIES = 64`、总字符上限 `MAX_CACHE_CHARS = 200000`；单块超过 `MAX_HIGHLIGHT_CHARS = 50000` 字符跳过增强；单行超过 `MAX_HIGHLIGHT_LINE_CHARS = 4000` 字符时先于引擎整块回退纯文本（JavaScript 正则单行耗时随行长近似平方增长），单行 tokenize 另设 `tokenizeTimeLimit = 500ms`；单块最多 `MAX_SPANS = 4000` 段。空代码、未知 / 不支持语言、映射缺失与引擎或 token 校验失败都原位显示纯文本。
- token 偏移必须是源码上的安全整数、单调、不越界；每段显示文本用原 `code` 切片，token 间缺口（CRLF / 空行 / 尾部空白）与末尾由原 code 补齐。唯一允许的内容差异是 Shiki 把 NUL 规范化为 U+FFFD，显示仍取源码。任何偏移或长度校验失败整块回退，不输出错位颜色。CRLF、空行、尾空白、NUL、空代码与末尾换行逐字保真；显示文本、code prop 与复制载荷一致，行数判定仍是 `code.split("\n").length > 20`。

### React 接线与生命周期

- `CodeBlock` 只在 `phase === "settled"` 的 effect 里调 `highlightCode`；streaming / SSR 只输出纯文本，effect 不跑就不会初始化引擎。普通父级重渲染、locale / cwd / 文件词表变化不触发着色；只有 `code`、归一化语言与 `phase` 变化重新请求。
- 每个请求带取消标记与 key；卸载、代码或语言变化时取消旧结果，渲染前再核对当前 key，避免旧高亮覆盖新代码。`code` 改变的第一帧即退回纯文本，不等异步结果。
- 结果抵达时若活动选区与 `<code>` 相交（`selectionIntersectsElement` 用 `Range.intersectsNode`，含从段落拖进代码、跨两张卡；没有该 API 时回退到共同祖先双向包含），先暂存该结果，监听 `selectionchange`；选区清空 / 移开后再应用最新一份。请求被新代码 / 语言 / phase 取代或组件卸载时丢弃暂存，不应用旧结果。
- span 文本由原 `code` 切片生成，不拼 `innerHTML`；复制 / 插入仍用原 `code`。卡片 DOM 身份、折展状态和完整选择文本在着色前后保持不变。

## 数学语法、排版与安全

阶段 4 的**本地解析适配已落地**：vendor 数学语法、保守金额否决、权威围栏闭合与源码事实都在单遍解析里完成；KaTeX 引擎 seam、私有净化与本地 WOFF2 资源也已落地并通过真实 DOM 验收，但 `MathView` / 正文接线、display 拆 p、FindBar / 选区去重与样式尚未接线。生产组件在 KaTeX 接线前显式走普通 GFM，公式与 `tex` / `latex` 围栏仍按原文显示。

### 本地解析适配（已落地，未接排版）

完成态解析入口 `parseMarkdown(source, phase = "settled")` 在 `settled` 时调用 [math.ts](<../src/webview/markdown/math.ts>) 的 `parseSettledRoot`：用与 vendor `parseGfmWithMath` 相同的扩展集合与顺序（`gfm` + `cjkFriendlyStrong` + `mathCompatibility` + `math`）单次 `fromMarkdown`，再做官方同款本地图片恢复；不对源文 mask / 占位 / 二次 parse。`streaming` 仍用 vendor `parseGfm`。正文组件在 KaTeX / `MathView` 接线前显式调用 `parseGfmMarkdown`，生产仍显示原文；未识别 math 节点由 `sourceFallback` 回退，不吞内容。

- **金额否决。** 只包 `math()` 公开的 `text[36]` construct：`this.now().offset` 读同一 source，命中保守金额形状才 `nok`，其余原样委托给官方 tokenizer。仅单个 `$`（`$$` 跳过）；在 64 code units 的有界窗口内找关闭 `$`，内容必须以 `^[0-9]+(?:[.,][0-9]+)*` 开头、不含 TeX 记号、无换行；关闭 `$` 后必须紧接非空白字符。自然语言分支要求金额后是 `[ \t]+\p{L}{2,}`（"5 and "）或标点 + 空白 + 词（"5. It costs "），因此 `$\alpha$`、`$-x$` 等后继公式不会被第一对吞掉；仅分隔符尾（"5.00、" / "5, "）更保守，只认字母、数字、`\` 与 `-`。`$5$`、`$5+10$`、`$5 $`、`$x$2`、`$5,$`、`$5.$` 仍是明确数学。**已知边界：** `$5.00$`、`$5-$10`、文末 `$5 USD$`、金额后紧跟括号等情况仍按官方数学；这是有界消歧，不宣称通用货币 / 语言识别。
- **权威闭合。** 包 `mathFromMarkdown().exit.mathFlowFence`：官方 handler 用 `data.mathFlowInside` 区分开 / 关围栏，开事件记录 open token，关事件记录 close token，`closed` 只由关闭 token 是否存在决定。EOF 结束的 flow（`$$\nx+y $$`、`$$\nx+y\n`）只有开事件，一律 `closed: false`，不读 raw 后缀。官方 handler 会把 `fragment` 压到栈顶，找 math 节点须从栈尾向前找最近的 `type === "math"`，不能只看栈顶。
- **候选事实。** `MathSource { form, delimiter, closed, start, end, raw, tex }` 写在节点 data；`form` 由定界符决定：`$` / `\(` 为 inline，`$$` / `\[` 为 display，同线 `$$x+y$$` 即使官方产 `inlineMath` 也记 display。`raw` 是 `position` 的源码切片（含容器前缀），`tex` 是官方 `node.value`（已去 `> ` / 缩进）；两者不能混用。缺位置或无法确认围栏事实时不标候选，渲染层按 `sourceFallback` 原文回退。
- **围栏。** `math` 围栏仍是 `code` 节点；`mathFenceSource` 用既有 `codeSources.closed`（围栏 token 计数）与 `codePayload` 预留 raw / 精确载荷 / 闭合事实，`tex` / `latex` 永不进入。本轮不转换、不排版。
- **单遍约束。** 金额否决在 tokenizer 内完成，围栏事实在 mdast handler 内记录，解析后只做一次树遍历；没有全文占位符、PUA 恢复、重复 parse 或 module 级活跃上下文。vendor 源码与来源锁不改；本地装配顺序由“非金额语料与 `parseGfmWithMath` 去事实键后树等价”的正式断言守住。

### KaTeX 引擎、私有净化与资源（已通过真实 DOM 验收，未接线）

- **引擎 seam。** [mathRender.ts](<../src/webview/markdown/mathRender.ts>) 的 `renderMath(source)` 只接受已确认的公式事实：`closed !== true`、`tex` 超过 4000 code units、缺少 DOM 都在加载引擎前返回 `undefined`；`renderKatexHtml(tex, display)` 是可在 Node 真实测的内部 seam。固定 `katex@0.16.47`、`output: "htmlAndMathml"`、`trust: false`、`throwOnError: true`、`strict: "ignore"`、`globalGroup: false`、`maxSize: 10`、`maxExpand: 1000`；每次渲染传新的 `macros: {}`，`\gdef` 不跨公式泄漏。模块只缓存引擎加载 Promise，不缓存公式或宏表。
- **失败判定。** KaTeX 抛出错误、输出超过有界 HTML 上限、或真实 `class` 属性中出现 `katex-error` token 时回退 `undefined`；不靠红色或 `html.includes("katex-error")` 判断，避免误伤 `\text{katex-error}`。`trust: false` 下 `\href` / `\url` / `\includegraphics` 的真实行为是降级为普通文本而非抛错，因此危险能力由净化白名单兜底，不把红字猜成错误。
- **私有净化。** [mathSanitize.ts](<../src/webview/markdown/mathSanitize.ts>) 使用私有 DOMPurify 实例（锁 3.4.15），显式 `ALLOWED_TAGS` / `ALLOWED_ATTR` / `ALLOWED_NAMESPACES`，不向正文开放任意 HTML 入口。HTML 只允许 `span`；MathML 只允许辅助语义与排版元素；SVG 只允许 `svg` / `path` / `line`。DOMPurify 的文本节点 tag `#text` 必须显式允许，否则元素壳还在但所有公式文字会被删空；净化后再以非空文本守卫兜底。属性按真实 namespace + tag 校验，拒绝 `href` / `xlink:*` / `src` / 事件 / `data-*` / `id` / `name`；style 只保留排版属性并校验值域（`position` 仅 `relative` / `absolute`，拒绝 `url` / `var` / `env` / `expression` / 转义 / 注释 / `!important`）；class 必须是 0.16.47 的真实集合。结构必须保留 `katex` / `katex-mathml` / `math` / `annotation` / `katex-html`（`aria-hidden`）与 MathML/SVG namespace；未知结构或关键 class 整体回退。合法 400em SVG 与 400000 viewBox 不按 `maxSize` 误删。
- **本地资源。** [katexAssets.mjs](<../scripts/katexAssets.mjs>) 在 esbuild 读取 `katex.min.css` 时把 20 个 `@font-face` 各收敛为恰好一个 WOFF2，file loader 输出 `dist/fonts/<name>-<hash>.woff2`，CSS URL 为相对 `./fonts/`；构建后核对每个 URL 存在且没有 WOFF / TTF / 远程来源。`main.tsx` 在 `tokens.css` 之后、`app.css` 之前引入同一份 KaTeX CSS，仍只有 `dist/webview.css` 一个样式产物；`dist` 文件白名单、`font-src ${webview.cspSource}` 与 `localResourceRoots: dist` 不变，预览服务器补 `.woff2` MIME。
- **验证边界。** `mathRender.test.ts` 覆盖 Node 无 DOM / 超长 / 未闭合、真实引擎 37 条有效语料的代表性输入、`maxExpand` / `maxSize`、宏隔离、trust 真实行为与净化纯函数；37 条有效语料的 class / style / attr 已做纯白名单零误伤核对。真实 Chromium 已对 37 条有效语料 × inline/display 共 74 例完成验收：全文、视觉几何、annotation 与 `aria-hidden` 均保留。HTML parser 会在 MathML text integration point（`mo`）里把 `\mathop{lim}` 的 `mi` 建成 HTML namespace；私有链只把“父级 MathML `mo`、零属性、纯文本、≤512 code units 的 `mi` / `mn` / `mo` / `mtext`”折叠成文本（`<mo>lim</mo>`），嵌套容器或带属性 token（如 `\mathop{\mathrm{lim}}`、`\mathop{\mathcal{F}}`）即使在引擎层排版成功，也让整式净化回退 `undefined`，不输出被剥空的公式。24 条攻击变异（20 条基础 + 4 条 `mo` 分支）在无 CSP 的独立负控中全部通过能力扫描，`pwned` 标记为 0、无远程请求，排除仅依赖 CSP 兜底。生产 CSS 在严格 CSP 的静态预览里 20 个 WOFF2 全部加载成功；该结果只证明静态页资源与 CSP 路径，**不是 VS Code 安装端验收**。生产 `Markdown.tsx` 仍显式 `parseGfmMarkdown`，数学未接 UI。

### 排版与安全契约（接线时执行）

- 完成态使用固定官方数学扩展：行内 `$…$`、`\(...\)`，块级 `$$…$$`、`\[...\]`，以及 `math` 围栏；`latex` / `tex` 围栏仍显示源码。streaming 不调用 KaTeX，math 围栏此时仍为代码。四类定界符遵循各自 grammar：`$` 与 `\(` 是 text；`$$` 在行首是 flow、在正文中间是 size-2 text（产品和事实模型都记 display）；`\[` **只有行首**（含引用 / 列表内容行首）才是 flow。同一行正文中间的 `\[x\]` 官方不解析成数学，本阶段不新增 text construct、不自造规则，列为已知语法边界。
- 金额、转义、空公式、定界符旁空白 / 数字、奇偶反斜杠、同段 `$$`、多行、未闭合和容器边界，先采用固定来源实际规则并移植其夹具；单美元不能把 `$5 and $10` 误认。不得复制上一版文档的手写 tokenizer 规则另建一套“等价语法”。
- 数学只来自语法确认的节点，不用 auto-render 扫描整篇 DOM，不在代码、链接 / 图片目标或 html 节点内容中二次识别；标签周围若被官方语法解析为独立 Markdown / 数学节点，按其节点处理，不另建 HTML 感知规则。未闭合不补齐。用源码位置保留无效公式回退片段及定界符，不能只回退已去定界符的 node.value。
- KaTeX 固定 `trust: false`、有限 `maxSize` / `maxExpand`、单公式长度上限；不接收模型 options，不跨公式共享可变宏表。限额写命名常量并验证临界与超限；失败显示文本，不插异常消息或错误 HTML。
- 默认 HTML + MathML，保留辅助语义。仅在私有 MathView 内独立净化固定版本 KaTeX 输出，再转为 React / 局部受控 DOM；这条私有链不接受原始 HTML 节点，不能将“来自可信库”当作跳过净化的理由。
- 数学净化只允许实际需要的 MathML、SVG 几何、排版元素 / 属性；style 按排版属性及值域校验，拒绝脚本、事件、foreignObject、外链、URL 和任意 CSS。React 18 下 MathML namespace、属性映射与辅助技术行为须实测，不能把普通 createElement 的无异常当作正确渲染证据。
- 块公式独立块容器局部横向滚动，不能 p 包 div、撑宽聊天或缩小整篇；行内公式基线和字号跟随现有正文尺度。分式、根式、矩阵、伸缩括号、重音等须证明净化未破坏排版。

## 搜索、复制、选区与阅读

- 高亮 span 的合并文本必须等于 code，现有跨文本节点查找继续生效；覆盖跨 token、空白、中文、末行和折叠代码的既有查找策略，不顺便扩大隐藏内容搜索范围。
- KaTeX HTML、MathML、TeX annotation 有重复文本；查找只采集视觉层，排除辅助层 / 注释。内部公式标识由组件生成且有来源，不由模型 class 触发特殊路径；搜索和选区提取共用同一去重判据。不能泛化为排除所有 aria-hidden，KaTeX 视觉层可能恰带该属性。
- 会话 Ctrl/Cmd+C、右键复制和引用继续共用 `chatSelectionText`，普通选区空白 / 换行不变；右键入口仍按既有规则去首尾空白。选中公式给一次可读文本，不承诺还原 TeX；整条消息复制是原 Markdown，代码按钮是精确 code，不加公式按钮。
- 数学去重必须按实际 Range 裁切，不能把仅选中部分公式替换成整个公式，也不能吞掉相邻正文、跨消息换行。焦点在 input / textarea / contenteditable、跨正文边界、组字或特殊组合键时仍让原生处理，不扩展快捷键范围。
- 结束时有选区先冻结 `{text, phase}`，没有选区才统一增强。异步高亮 / 字体 / 图片结果不得改写仍被选中的内容；代码卡在结果抵达时若活动选区与 `<code>` 相交，暂存结果并监听 `selectionchange`，等选区清空 / 移开再应用最新一份。不能只冻结父 props 却让内部异步结果替换 DOM。
- DOM 更新会使旧 Range / 查找高亮失效：查找在 MutationObserver 回调里立即清空旧 Range 与注册表，保留计数与激活位置，再按 150ms 防抖重算；导航前检查 Range 两端 `isConnected`，脱树不导航，不持有已卸载节点。代码折展、公式排版、字体就绪及图片变化引起高度变化时，原本贴底才继续跟随；用户上翻不抢底，不新建第二套 scrollTop 仲裁。
- 轨迹内变化继续服从其现有虚拟化测量、pin 与定位回执；不能只验证聊天正文就假定轨迹摘要 / 详情的高度与锚点也正确。

## 构建、依赖与资源

- 复用已有 micromark / mdast 依赖；阶段 3 已补齐 Shiki 精选入口（`shiki@4.5.0`、`@shikijs/langs@4.5.0`）并锁定版本，阶段 4 已补入 `micromark-extension-math@3.1.0` 与 `mdast-util-math@3.0.0` 作为解析依赖，并锁定 `katex@0.16.47` 作为直接依赖；解析事实由本地 settled 适配消费，KaTeX 引擎 / 私有净化 / 本地字体资源已就绪并通过真实 DOM 验收，`MathView` 与正文接线仍未接入。阶段 2 已确认全仓无 marked 消费者并删除该依赖与声明条目；同时删除旧脚注 / 中文加粗 / 目标 tokenizer 与 `imageHydrate` 测试。DOMPurify 仍保留在依赖中，供阶段 4 数学输出净化使用；正文不再有整篇净化入口。
- 构建为 KaTeX CSS / 字体补本地资源流程，优先 WOFF2，产物在 dist 范围；CSS URL 相对最终样式文件可解析，不留下 node_modules、开发服务器、绝对本机地址。无外部字体、额外脚本分包、WASM 或网络权限。
- 核对既有 font-src、style-src、localResourceRoots 与文件白名单，保持脚本 nonce / 无 unsafe-eval。分别验证静态预览和 VS Code webview 的字体路径 / CSP，前者成功不代表后者已验收。
- 更新锁文件、[第三方声明](<../THIRD-PARTY-NOTICES.md>)、vendor 原文 / 来源锁、资源清单及目录 README。新本地派生源码须披露官方来源；Shiki grammar / theme 与 KaTeX JS/CSS 按 MIT 归属，随包分发的 KaTeX WOFF2 字体按 SIL OFL 1.1 单独归属（保留字体名与完整 OFL 见第三方声明）。
- 实施前后记录 JS / CSS / 字体 / VSIX 体积、首次初始化、长文解析和结算延迟。缓存有界，不全局永久保存整棵文档、敏感正文或宿主闭包。阶段 3 已按实际长行耗时测试收紧单行上限（见「代码高亮」）；首次初始化与结算延迟仍以本地复测为准，不把单机数字写成通用 SLA。有明确阻塞再评估 worker、语言裁剪或分包，不预先引入增量复杂度。阶段 4 本地解析的一次观察：密集金额 100 / 400 / 1600 段约 1.87 / 3.23 / 11.42ms，仍只保留末 `$x$`；该分布仅作观察报告，不设阈值断言。

## 迁移顺序与退出条件

1. **先固定基线与兼容性。** 采集现有真实输出预览夹具、代表性 DOM / computed style / 截图、复制和宿主帧；固定官方来源、原始 HTML 字面输出的有意差异及代码源码保真方案。其余安全 / 普通显示不一致未解决前，不以着色掩盖迁移问题。（已完成）
2. **只切换管线。** 建立官方解析适配与完整 React 渲染，迁移全部消费入口、脚注、路径、图片和节点所有权；此时不接高亮 / 公式排版，用无增强基线证明标准 Markdown 与原界面一致，原始 HTML 则按新契约验证只输出文字。测试阶段可对旧 / 新输出作差分，不保留生产双引擎、功能开关或长期回退分支。（已落地；旧管线、旧测试与已无消费者的依赖一并删除）
3. **接入完成态代码。** 正文和 run_code 共用引擎 / 代码卡，完成主题、别名、原文、折展、缓存、超限和失败回归；streaming 与静态 phase 各自固定。（已完成离线 / 静态验收；安装端待验）
4. **接入完成态公式。** 本地解析适配、KaTeX 引擎 seam、私有净化与本地 WOFF2 资源已落地并通过真实 DOM 验收（37×2 全过、24 条攻击无能力残留、20 个字体严格 CSP 加载成功）；`MathView` 接线、display 拆 p、FindBar 与搜索 / 选区去重仍待实现；安装端仍属阶段 5。（引擎 / 净化 / 资源验收完成；UI 未接线）
5. **收尾与安装验收。** 检查会话 / 连接切换、选区延迟、异步高度、轨迹测量、主题 / 尺度与 VSIX 资源；用户功能说明与 CHANGELOG 在版本发布时更新。（未完成）

阶段提交应可定位与回滚；发现安全或现有行为回归优先整体回滚对应阶段，不通过运行时开关保留两套长期管线。字体 / CSP、系统剪贴板等安装端结果未完成时应明确列为未验证，不得用构建成功代替。

## 验收矩阵与证据

测试穿过同一 Interface / Seam，不以 import 文本、CSS class 出现或“没有抛错”证明功能。安全内部 Seam 可以独立测试，但不向业务公开测试开关。

| 层级 | 必须覆盖与判定 |
|---|---|
| 解析 / 源码 | GFM 表格、任务、软硬换行、引用 / 图片定义跨代码、中文加粗、Windows 正反斜杠 / `%5C` / 点目录 / 中文 / 行号 / UNC / 非目标文本；参考定义、嵌套脚注、缺定义与重复引用；已知差异逐项审查 |
| 树结构 / 普通 DOM | 根首尾边距、段落 / 列表 / 引用嵌套、表格容器、脚注结构；三反引号 / 长 / 波浪 / 缩进 / 未闭合代码正确在原容器内；原始 HTML 的行内 / 块级 / 跨节点标签和注释显示为文字，混排时不解释为 DOM、不修复标签嵌套、不吞源码 |
| 代码 Interface | 语言 / 别名 / 未知 / 恶意标签、JS 正则不支持的 grammar；token 文本逐字相等，CRLF / 空代码 / 尾换行 / tab 保真；20 / 21 行、折展状态跨 phase 保持、变短展开；streaming 零增强调用、缓存淘汰 / 超限 / 初始化失败 |
| 数学 Interface | 四类定界符和 math / tex / latex 围栏、金额（含 `$\alpha$` / `$-x$` 后继公式）/ 转义 / 空白 / 数字 / 未配对、容器边界；代码 / URL / HTML 不误识别；raw / tex / closed / form 事实与官方臂等价；无效 TeX / 长度 / 宏展开 / 尺寸降级；分式 / 矩阵 / 根式 / SVG 伸缩排版（引擎 / 净化已通过 37×2 真实 DOM；UI 接线待验） |
| 真实 DOM 安全 | 危险 scheme、编码 / 混淆 URI、事件 / script / style / form / 主动资源、伪造内部 class / 属性 / 标签不能获得组件能力；任务只读；MathML / SVG / style 专用净化，无远程资源与可信 TeX 命令；净化失败安全回退 |
| 文件与图片交互 | 锚点 / 行内代码同目标、外链一次、页内锚点、Alt / Ctrl / Cmd、词表晚到 / 歧义；本地与 HTTPS、HTTP 拒绝、回帧前失败、最终占位、范围更换与迟到结果、原图 / 复制 / 保存 |
| 选择 / 搜索 / 阅读 | 跨 span 命中、MathML / annotation 不重复、部分公式选区 / 跨消息 / 普通空白保真、编辑焦点让路、右键引用；结束仍选中不增强，释放后追上；贴底与上翻、旧 Range 作废、轨迹虚拟化高度 |
| 视觉预览 | 同输入 / 主题 / 语言 / 字号 / 宽度前后截图与 computed style 对拍；明 / 暗 / 高对比、窄侧栏、代表性小中大字号，中英标题 / 按钮、代码渐隐和换行、宽表 / 宽公式、字体加载前后与离线加载 |
| 集成 / 发布 | 全部消费入口、SSR / Node 导入、vendor 来源锁、依赖裁剪；构建 CSS URL、字体与声明白名单、无全量语言包 / CDN / WASM；安装端 CSP / 字体、原生插入 / 文件打开与系统剪贴板 |

阶段 2 已保留 [markdown.test.ts](<../scripts/markdown.test.ts>)、[footnotes.test.ts](<../scripts/footnotes.test.ts>)、[styles.test.ts](<../scripts/styles.test.ts>) 中的业务断言，并淘汰仅固定 marked 调用形状的断言；同步 fileLinks、localImageResolve、localImages、contextMenu、questionRender、trajectoryVendor、vendorSourceLock、manifest 等关联回归，没有因旧测试不再匹配而整段删除安全要求。阶段 3 新增 [highlight.test.ts](<../scripts/highlight.test.ts>) 与 [selectionRange.test.ts](<../scripts/selectionRange.test.ts>)，并扩展 [find.test.ts](<../scripts/find.test.ts>) 的脱树导航判据；阶段 4 新增 [math.test.ts](<../scripts/math.test.ts>) 覆盖金额、围栏闭合、容器源码 / 载荷分离与官方臂树等价，以及 [mathRender.test.ts](<../scripts/mathRender.test.ts>) 覆盖引擎 seam、限额、宏隔离、trust 真实行为与净化纯函数；全部登记在[脚本构建入口](<../esbuild.scripts.mjs>) entries。图片 / 链接 / 选区的真实 DOM 时序由受控浏览器回放，Node 静态源码检查不等同浏览器证据。

阶段 3 已完成离线 / 静态验收（typecheck、184 套离线断言、build、diff-check 与受控浏览器检查）；代码高亮的 SSR / streaming 不初始化由 `CodeBlock` 的 settled effect 保证，静态断言只覆盖纯模块。阶段 4 的本地解析适配、KaTeX 引擎 seam、私有净化与本地字体资源已通过 focused typecheck、`math.test.ts`、`mathRender.test.ts`、临时资源复现构建与真实 Chromium 验收：37 条有效语料 × inline/display 共 74 例全文 / 几何 / annotation / `aria-hidden` 一致，24 条攻击在无 CSP 负控中未留下能力，20 个 WOFF2 在严格 CSP 静态预览中全部加载。但 `MathView` / 正文接线、display 拆 p、FindBar 与搜索 / 选区去重仍未实现，生产组件仍显式走 GFM；安装端 CSP / 字体 / VSIX 与系统剪贴板尚未验证，静态预览成功不等于 VS Code 安装验收，阶段 4 / 5 整体未完成。不启动真实 DSH、不发送真实消息。未经当次批准，不运行模型 smoke / 探针。

## 资料与重评条件

- [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)：语法与树扩展须配对；位置来自实际解析输入，源码适配不得破坏偏移关系。
- [官方源码](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-primitives/src/markdown)：按固定来源核对 parse、render、mathCompatibility、highlight 与 katex，UI 与安全差异按本文适配。
- [Shiki 精简构建](https://shiki.style/guide/best-performance)、[JS 正则引擎](https://shiki.style/guide/regex-engines)；[KaTeX 安全](https://katex.org/docs/security)、[选项](https://katex.org/docs/options)。最新资料只作参考，实际依赖版本和浏览器能力必须另核。

只有实际包体 / 结算卡顿、明确的语言覆盖缺口或可复现数学误识别，才重评对应内部实现；不因官方支持就增加流式复杂度。原始 HTML 按本文有意收敛到官方行为，其余既有视觉与行为不为省实现成本牺牲。
