# Markdown 管线迁移、代码高亮与公式渲染

## 状态与范围

本文覆盖正文 Markdown 的五个阶段：从 marked / HTML 分块迁到官方同源的 micromark → mdast → React 管线（阶段 2），再接入 Shiki 代码高亮（阶段 3）与 KaTeX 公式（阶段 4），最后做安装端收尾（阶段 5）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 基线、来源锁定与本文设计 | 已完成 |
| 2 | 解析 / 渲染管线切换，保持标准 Markdown 的视觉与行为；原始 HTML 改为字面文本 | 已落地 |
| 3 | 完成态代码高亮（Shiki） | 未实施 |
| 4 | 完成态数学（KaTeX）与隔离净化 | 未实施 |
| 5 | 安装端 CSP / 字体 / VSIX 资源验收 | 未完成 |

阶段 2 的实现入口是 `src/webview/markdown/`：`parse.ts` 调用 vendor `parseGfm`，再做本地 Windows 链接目标修复与文档级定义收集；`source.ts` 用 micromark 事件流提取代码源文；`render.tsx` 把整棵 mdast 递归映射为 React。正文不再有整篇 HTML、`innerHTML` 或渲染后水合。streaming 与 settled 目前只差 `phase` 取值，代码高亮与公式排版都未接入，因此界面仍不显示语法高亮，数学与 `tex` / `latex` 围栏按原文显示。

- 正文已从 marked / HTML 分块迁到官方同源的 micromark → mdast → React 管线；后续阶段再把 Shiki 与 KaTeX 接进同一棵文档树。普通 Markdown、代码与数学共享一套节点所有权，不再建设 marked 私有槽、骨架标记和 React portal 方案。
- **迁移不是界面重设计。** 保留标准 Markdown 的字体、间距、代码卡片、折展、复制、插入、链接、图片、脚注、搜索和阅读行为；不整搬官方 UI、CSS Modules、工具栏或主题系统。原始 HTML 按官方作为字面文本显示，是明确接受的兼容差异，不再保留现有有限 HTML 渲染。
- 助手生成期间仍展示普通 Markdown；阶段 2 尚无完成态增强，代码始终不着色、公式不排版。阶段 3 / 4 接入后，生成结束、停止、失败或截断才进入完成态增强。不做增量解析、增量高亮、自动补围栏或“围栏刚闭合就增强”。
- 历史消息和已确定的计划、工具详情直接使用完成态。阶段 3 起，`run_code` 完整调用参数可立即着色；工具运行状态不等于代码还在生成。
- 用户气泡仍显示原始文本；终端、文件预览、diff、JSON 检查器、轨迹源码与请求差分不纳入。不改协议、持久化消息或宿主权限，不加功能开关。

现有消息约束见[消息设计](<design-messages.md>)；文件访问见[文件路径](<design-paths.md>)；图片与外传边界见[安全设计](<design-security.md>)；尺度与复制分别见[界面尺度](<design-ui-scale.md>)、[右键菜单](<design-context-menu.md>)。

## 决策与官方复用边界

迁移前的 `webview/markdown.ts`（阶段 2 已删除）使用 marked、自有脚注、Windows 路径和中文加粗扩展，再由 DOMPurify 净化；`splitMarkdownBlocks` 只用正则抽取完整三反引号围栏。继续在其上补数学 token、私有槽和来源验证，会同时维护两套树与挂载生命周期。阶段 2 已统一语法基础，成本集中在一次兼容迁移，后续语法、嵌套、代码与公式共享同一 Seam。

官方已有 GFM / 数学解析、中文加粗、图片语法修复、mdast 渲染、Shiki 和 KaTeX；复用其语法与测试输入，而不是将整套组件作为黑盒替换。本扩展不需要官方流式缓存、增量会话、桌面图片路由、链接组件或整套主题依赖。

### 固定来源与适配

- 当前 vendor 基准为 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`，tag `dsh-v0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`；来源与锁定流程见[vendor 说明](<../src/vendor/README.md>)。不得把本机 HEAD 或最新文档当作该发布版的证据。
- vendor 的 [parse.ts](<../src/vendor/ui-primitives/markdown/parse.ts>) 只搬入 `parseGfm`，现在同时服务轨迹纯文本投影与正文解析。数学接入（阶段 4）时按固定 commit 核对并恢复 `parseGfmWithMath`、`mathCompatibility` 及配套依赖；届时保留 `parseGfm` 的投影语义，不得为了正文迁移顺手改变轨迹摘要、搜索索引或事件投影。
- vendor 内仅保留获准的原文适配；Windows 链接修复、扩展资源策略、完成态高亮、安全限额和 UI 差异放在本地 Implementation。新搬文件必须同步原文夹具、文件头、来源锁和第三方声明；变更已有允许适配须说明理由，不能只改摘要求绿。
- 官方 `render.tsx`、`highlight.ts`、`katex.tsx` 可提供遍历、别名、CSS 变量主题和排版参考，但不原样复制。原始 HTML 显示为字面文本的规则直接对齐；链接与图片准入保留扩展契约，KaTeX 输出另做独立净化和资源限制。需要本地行为的派生实现放在 webview 层，注明固定来源及差异，不假称逐字 vendor。
- 官方 Markdown / DOM / 恶意 TeX 夹具可复用输入，断言必须改为本扩展契约，不能直接采用官方 DOM 快照并顺带改变 UI。

## Module、Interface 与 Seam

### 对外 Interface

业务仍只消费 `Markdown` 和 `CodeBlock`，不接触 micromark、mdast、语言注册、字体、净化器或渲染内部节点。阶段 2 已按下列 Interface 落地（`phase` 暂只透传，增强在阶段 3 / 4 接入）：

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

阶段 2 按上述职责拆成 `src/webview/markdown/` 的 `parse.ts`、`source.ts`、`windowsDestinations.ts`、`render.tsx` 与 `types.ts`，文件清单见该目录 README；组件入口仍是 `components/Markdown.tsx`。阶段 3 / 4 新增文件沿用同一分层，不建没有第二个真实 Adapter 的注册平台。

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

- 阶段 2 使用 `fromMarkdown` 的成对 GFM 扩展（`gfm()` + `gfmFromMarkdown()`）并注册官方 `cjkFriendlyStrong`；数学的 `mathCompatibility()` / `math()` + `mathFromMarkdown()` 留到阶段 4。只注册词法扩展而不接树编译扩展不算完成迁移，版本以锁文件为准。
- 阶段 2 的流式与完成态都用官方 `parseGfm`，没有增量解析器；阶段 4 完成后完成态改用 `parseGfmWithMath`，结构变化只允许发生在数学等有意的增强边界。两者都对当前整篇文本解析。生成中的反斜杠仍可能按 CommonMark 转义显示；“公式原文”表示不排版，不承诺每个定界符逐字可见，也不另写一套实时数学扫描器。
- Windows 路径修复在本地解析 Seam 完成：`windowsDestinations.ts` 在解析后按链接 / 图片节点的源码位置回原文取目标，仅对呈 Windows 绝对路径形状的 `\` 编码为 `%5C`。上游 `recoverLocalImages` 先跑、本地修复后跑，已用含 `%5C` 的重叠夹具验证不会二次编码；不能对全文替换反斜杠。代码、标签、参考定义、非 Windows 目标和 UNC 访问边界不变。
- 中文强强调沿用官方 `cjkFriendlyStrong`，已用迁移前的中文标点、西文、单星、三星、代码内星号夹具对拍；不能以“官方如此”为理由静默扩大既有偏差。
- 代码依赖 `code` 节点，不再全文围栏正则切分；较长围栏、波浪、未闭合、缩进代码以及列表 / 引用 / 脚注内代码均保留所属容器。未知树节点按 `sourceFallback` 回退为安全源码片段，不沿用官方“默认返回空”吞内容。
- 文档级定义统一收集在 `MarkdownDocument.definitions` / `footnotes`：参考链接与图片可跨代码块解析，脚注编号与重复引用计数只属于本次文档。脚注定义重复时 last-wins，参考定义 first-wins，沿用迁移前口径。
- 使用稳定的文档身份和节点 key；同一代码块从 streaming 到 settled、着色初始化完成、主题或词表变化时，不重建卡片而丢失用户折展选择（阶段 3 接入着色时按此检查）。源码 offset 不能单独作为跨消息身份，不能跨连接复用交互闭包。

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

阶段 2 的有意变化只有两处：正确呈现旧正则未覆盖的合法嵌套代码，以及原始 HTML 改为字面文字；阶段 3 / 4 再增加代码颜色与完成态数学排版。其余标准 Markdown 内容不得借迁移重排、换肤或改操作，已由静态浏览器回放逐项对拍。

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

阶段 3 尚未实施：当前 `CodeBlock` 接收 `phase` 但不着色，以下为待实现的契约。

- Shiki fine-grained core + JavaScript 正则引擎 + 显式静态语言集合；无 Oniguruma WASM、CDN、网络或 unsafe-eval。单文件 IIFE 首版不复制官方动态分包 / 增量会话。
- 首批目标为 JavaScript / TypeScript / JSX / TSX、JSON / JSONC、Python、Shell、PowerShell、C / C++、C#、Go、Rust、Java、HTML、CSS、SQL、YAML、Markdown、diff。嵌入语法依赖显式登记；JS 引擎不能准确支持或有兼容异常的 grammar 纯文本回退，不用宽松模式制造看似正确的颜色。最终集合在实现验证后锁定，不自动猜语言。
- 用首个语言标识和显式 Map 归一化 js / ts / py / sh / ps1 / yml 等别名，显示仍保留原标签；`constructor` / `__proto__` 不得命中对象继承成员。无语言 / 未知语言均可读。
- 每 webview 一个按需初始化实例；初始化失败不让卡片消失。结构化 token 生成 React span，不将 `codeToHtml` 拼回普通 HTML；主题使用受控 CSS 变量，明暗 / 高对比无需每次重新生成全部 token，不承诺匹配所有用户 TextMate 主题。
- 精确源码、归一化语言及主题策略版本决定缓存；失败也可缓存。条数与总字符量双限，过长代码跳过增强；保留尾部空行 / 换行，不盲抄上游按行输出时裁掉末行的实现。限额在实现时以命名常量登记并验证临界值。

## 数学语法、排版与安全

阶段 4 尚未实施：当前数学与 `tex` / `latex` 围栏都按原文显示，`$…$` 不进入排版；以下为待实现的契约。

- 完成态使用固定官方数学扩展：行内 `$…$`、`\(...\)`，块级 `$$…$$`、`\[...\]`，以及 `math` 围栏；`latex` / `tex` 围栏仍显示源码。streaming 不调用 KaTeX，math 围栏此时仍为代码。
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
- 结束时有选区先冻结 `{text, phase}`，没有选区才统一增强。异步高亮 / 字体 / 图片结果不得改写仍被选中的内容；必要时叶节点延迟提交增强，不能只冻结父 props 却让内部异步结果替换 DOM。
- DOM 更新会使旧 Range / 查找高亮失效，应通过现有查找版本与 readingPlacement 作废 / 重建，不持有已卸载节点。代码折展、公式排版、字体就绪及图片变化引起高度变化时，原本贴底才继续跟随；用户上翻不抢底，不新建第二套 scrollTop 仲裁。
- 轨迹内变化继续服从其现有虚拟化测量、pin 与定位回执；不能只验证聊天正文就假定轨迹摘要 / 详情的高度与锚点也正确。

## 构建、依赖与资源

- 复用已有 micromark / mdast 依赖，阶段 3 / 4 再补齐 math 配对和 Shiki / KaTeX 精选入口并锁定实际版本。阶段 2 已确认全仓无 marked 消费者并删除该依赖与声明条目；同时删除旧脚注 / 中文加粗 / 目标 tokenizer 与 `imageHydrate` 测试。DOMPurify 仍保留在依赖中，供阶段 4 数学输出净化使用；正文不再有整篇净化入口。
- 构建为 KaTeX CSS / 字体补本地资源流程，优先 WOFF2，产物在 dist 范围；CSS URL 相对最终样式文件可解析，不留下 node_modules、开发服务器、绝对本机地址。无外部字体、额外脚本分包、WASM 或网络权限。
- 核对既有 font-src、style-src、localResourceRoots 与文件白名单，保持脚本 nonce / 无 unsafe-eval。分别验证静态预览和 VS Code webview 的字体路径 / CSP，前者成功不代表后者已验收。
- 更新锁文件、[第三方声明](<../THIRD-PARTY-NOTICES.md>)、vendor 原文 / 来源锁、资源清单及目录 README。新本地派生源码须披露官方来源；Shiki grammar / theme 和 KaTeX 字体的许可证按实际发布资源核对。
- 实施前后记录 JS / CSS / 字体 / VSIX 体积、首次初始化、长文解析和结算延迟。缓存有界，不全局永久保存整棵文档、敏感正文或宿主闭包。当前没有首次初始化与长文解析延迟的量测结果，不编造耗时通过数字；有明确阻塞再评估 worker、语言裁剪或分包，不预先引入增量复杂度。

## 迁移顺序与退出条件

1. **先固定基线与兼容性。** 采集现有真实输出预览夹具、代表性 DOM / computed style / 截图、复制和宿主帧；固定官方来源、原始 HTML 字面输出的有意差异及代码源码保真方案。其余安全 / 普通显示不一致未解决前，不以着色掩盖迁移问题。（已完成）
2. **只切换管线。** 建立官方解析适配与完整 React 渲染，迁移全部消费入口、脚注、路径、图片和节点所有权；此时不接高亮 / 公式排版，用无增强基线证明标准 Markdown 与原界面一致，原始 HTML 则按新契约验证只输出文字。测试阶段可对旧 / 新输出作差分，不保留生产双引擎、功能开关或长期回退分支。（已落地；旧管线、旧测试与已无消费者的依赖一并删除）
3. **接入完成态代码。** 正文和 run_code 共用引擎 / 代码卡，完成主题、别名、原文、折展、缓存、超限和失败回归；streaming 与静态 phase 各自固定。（未开始）
4. **接入完成态公式。** 恢复配套数学解析入口，落实隔离净化、字体和局部布局，再打通搜索 / 选区去重；核对辅助语义和 React 18 MathML 行为。（未开始）
5. **收尾与安装验收。** 检查会话 / 连接切换、选区延迟、异步高度、轨迹测量、主题 / 尺度与 VSIX 资源；用户功能说明与 CHANGELOG 在版本发布时更新。（未完成）

阶段提交应可定位与回滚；发现安全或现有行为回归优先整体回滚对应阶段，不通过运行时开关保留两套长期管线。字体 / CSP、系统剪贴板等安装端结果未完成时应明确列为未验证，不得用构建成功代替。

## 验收矩阵与证据

测试穿过同一 Interface / Seam，不以 import 文本、CSS class 出现或“没有抛错”证明功能。安全内部 Seam 可以独立测试，但不向业务公开测试开关。

| 层级 | 必须覆盖与判定 |
|---|---|
| 解析 / 源码 | GFM 表格、任务、软硬换行、引用 / 图片定义跨代码、中文加粗、Windows 正反斜杠 / `%5C` / 点目录 / 中文 / 行号 / UNC / 非目标文本；参考定义、嵌套脚注、缺定义与重复引用；已知差异逐项审查 |
| 树结构 / 普通 DOM | 根首尾边距、段落 / 列表 / 引用嵌套、表格容器、脚注结构；三反引号 / 长 / 波浪 / 缩进 / 未闭合代码正确在原容器内；原始 HTML 的行内 / 块级 / 跨节点标签和注释显示为文字，混排时不解释为 DOM、不修复标签嵌套、不吞源码 |
| 代码 Interface | 语言 / 别名 / 未知 / 恶意标签、JS 正则不支持的 grammar；token 文本逐字相等，CRLF / 空代码 / 尾换行 / tab 保真；20 / 21 行、折展状态跨 phase 保持、变短展开；streaming 零增强调用、缓存淘汰 / 超限 / 初始化失败 |
| 数学 Interface | 四类定界符和 math / tex / latex 围栏、金额 / 转义 / 空白 / 数字 / 未配对、容器边界；代码 / URL / HTML 不误识别；无效 TeX / 长度 / 宏展开 / 尺寸降级；分式 / 矩阵 / 根式 / SVG 伸缩排版 |
| 真实 DOM 安全 | 危险 scheme、编码 / 混淆 URI、事件 / script / style / form / 主动资源、伪造内部 class / 属性 / 标签不能获得组件能力；任务只读；MathML / SVG / style 专用净化，无远程资源与可信 TeX 命令；净化失败安全回退 |
| 文件与图片交互 | 锚点 / 行内代码同目标、外链一次、页内锚点、Alt / Ctrl / Cmd、词表晚到 / 歧义；本地与 HTTPS、HTTP 拒绝、回帧前失败、最终占位、范围更换与迟到结果、原图 / 复制 / 保存 |
| 选择 / 搜索 / 阅读 | 跨 span 命中、MathML / annotation 不重复、部分公式选区 / 跨消息 / 普通空白保真、编辑焦点让路、右键引用；结束仍选中不增强，释放后追上；贴底与上翻、旧 Range 作废、轨迹虚拟化高度 |
| 视觉预览 | 同输入 / 主题 / 语言 / 字号 / 宽度前后截图与 computed style 对拍；明 / 暗 / 高对比、窄侧栏、代表性小中大字号，中英标题 / 按钮、代码渐隐和换行、宽表 / 宽公式、字体加载前后与离线加载 |
| 集成 / 发布 | 全部消费入口、SSR / Node 导入、vendor 来源锁、依赖裁剪；构建 CSS URL、字体与声明白名单、无全量语言包 / CDN / WASM；安装端 CSP / 字体、原生插入 / 文件打开与系统剪贴板 |

阶段 2 已保留 [markdown.test.ts](<../scripts/markdown.test.ts>)、[footnotes.test.ts](<../scripts/footnotes.test.ts>)、[styles.test.ts](<../scripts/styles.test.ts>) 中的业务断言，并淘汰仅固定 marked 调用形状的断言；同步 fileLinks、localImageResolve、localImages、contextMenu、questionRender、trajectoryVendor、vendorSourceLock、manifest 等关联回归，没有因旧测试不再匹配而整段删除安全要求。新增测试已登记[脚本构建入口](<../esbuild.scripts.mjs>) entries；图片 / 链接的真实 DOM 时序由受控浏览器回放，Node 静态源码检查不等同浏览器证据。

阶段 2 运行 typecheck 与离线测试，并由受控浏览器做静态回放；不启动真实 DSH、不发送真实消息。安装端另验 CSP、字体、IPC 和系统剪贴板，分别记录已验证与未验证。未经当次批准，不运行模型 smoke / 探针。

## 资料与重评条件

- [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)：语法与树扩展须配对；位置来自实际解析输入，源码适配不得破坏偏移关系。
- [官方源码](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-primitives/src/markdown)：按固定来源核对 parse、render、mathCompatibility、highlight 与 katex，UI 与安全差异按本文适配。
- [Shiki 精简构建](https://shiki.style/guide/best-performance)、[JS 正则引擎](https://shiki.style/guide/regex-engines)；[KaTeX 安全](https://katex.org/docs/security)、[选项](https://katex.org/docs/options)。最新资料只作参考，实际依赖版本和浏览器能力必须另核。

只有实际包体 / 结算卡顿、明确的语言覆盖缺口或可复现数学误识别，才重评对应内部实现；不因官方支持就增加流式复杂度。原始 HTML 按本文有意收敛到官方行为，其余既有视觉与行为不为省实现成本牺牲。
