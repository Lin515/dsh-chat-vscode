# src/vendor/ui-primitives/markdown/ — Markdown 解析、纯文本投影与语法高亮

上游 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../../README.md](../../README.md)；改写约束见 [../../AGENTS.md](../../AGENTS.md)。

这条链以**投影**（Markdown 原文 → 单行纯文本）与**解析语法**为主，同时包含完成态数学与
代码高亮的官方实现：
`webview/markdown/parse.ts` 消费 `parseGfm`；`settled` 数学由
`webview/markdown/math.ts` 以**相同扩展集合**装配，并在公开 construct / handler
外补金额否决与围栏事实。`parseGfmWithMath` 仍保留为官方语法基准与等价性断言来源，
本地适配不复制语法规则。`katex.tsx` 是完成态数学的 **KaTeX→React 适配器**原文，
`MathView` 经 [mathRender.ts](<../../../webview/markdown/mathRender.ts>) 消费它，不再自写元素树映射。
`highlight.ts` 是客户端唯一的**语法高亮核心**，
`webview/markdown/highlight.ts` 只在其上做宿主适配，不另维护别名表或 token 样式。

| 文件 | 上游对应 | 作用 | 本仓库的改动 |
|---|---|---|---|
| `parse.ts` | 同名文件 | mdast 两个语法臂：streaming 的 `parseGfm` 与 settled 的 `parseGfmWithMath`（GFM + CJK 友好粗体 + 本地图片恢复 + TeX math） | 完整搬入两个臂；去掉 `.ts` 后缀，文件头补来源说明 |
| `mathCompatibility.ts` | 同名文件 | micromark 扩展：`\(...\)` / `\[...\]` 与同行 `$$...$$` 复用 math token 词汇 | 逐字搬入；仅文件头补来源说明 |
| `plain-text.ts` | 同名文件 | mdast 树 → 纯文本（三种边界：全文 / 首行 / 首段） | 去掉 `.ts` 后缀 |
| `cjkFriendlyStrong.ts` | 同名文件 | micromark 扩展：让星号粗体在「标点后紧接 CJK」时正确闭合 | 去掉 `.ts` 后缀 |
| `local-image-syntax.ts` | 同名文件 | 把「带空格的本地图片路径」那种单图片段落恢复成图片节点（预览时留 alt） | 见下：`classifyFileType` 换成本地 `isImageFilePath()`；去掉 `.ts` 后缀 |
| `katex.tsx` | 同名文件 | TeX → React：`katex.renderToString` 的 HTML 经 `DOMParser` 转 DOM，再映射为 React 元素树（严格渲染 / `strict: 'ignore'` 重试 / 错误 span 三臂） | 逐字搬入；仅文件头补来源说明；来源锁按 TSX / JSX 解析 |
| `highlight.ts` | 同名文件 | 客户端唯一的语法高亮：shiki core 同步细粒度高亮（JS 正则引擎、grammar 白名单、CSS 变量主题），含别名表、懒加载 grammar 与流式增量会话 | 逐字搬入；仅文件头补来源说明 |

## KaTeX 适配器

`katex.tsx` **不改任何 KaTeX 选项**：仍用默认的 `throwOnError: true` 严格渲染、
`strict: 'ignore'` 重试与 `#cc0000` 错误色。模块内不做 HTML 净化，信任边界与上游一致
（KaTeX 只输出静态 span / MathML / SVG 词汇，没有原始用户 HTML）。React 18 没有 MathML
命名空间支持，`.katex-mathml` 子树落在 HTML 命名空间的行为也按上游注释保持原样。

## 语法高亮核心

`highlight.ts` 是**客户端唯一的语法高亮器**，逐字搬入，本仓库不改任何选项：

- **引擎**：`createJavaScriptRegexEngine` 的同步细粒度模式（JavaScript 正则，运行时不含
  oniguruma WASM）。`forgiving: true` 与 `lazyCompileLength: Number.POSITIVE_INFINITY`
  是官方为宿主争用下的稳定 token 流做的选择，本地适配层不得重设。
- **启动 grammar**：只有 TypeScript / shell / JSON 三份在模块加载时注册；其余语言按
  `LAZY_GRAMMARS` 首次请求时动态 import，未就绪的首次渲染回退纯文本，语法注册后由
  `subscribeGrammarLoaded` / `grammarLoadCount` 触发重渲染。
- **别名表**：`LANG_ALIASES` 同时覆盖 Markdown 围栏别名、文件扩展名语言 id 与 read 卡片
  持久化的短 id；JS 家族（`js` / `jsx` / `ts` / `tsx`）都解析到 TypeScript grammar，
  这是官方对 JSX / TSX 近似 tokenize 的既有取舍。
- **主题**：`createCssVariablesTheme` 的 token 颜色全部走 `--shiki-*` 自定义属性，
  `highlight.ts` 内不写具体色值；本地适配层负责把这些变量映射到既有调色板。
- **输出**：`highlightToHtml`（单 `<pre>`）、`highlightLines`（逐行 token，供行号视图）、
  `StreamingHighlightSession`（按行缓存 + grammar state 的增量会话，非追加输入或 grammar
  切换会重置并全量重算）。未知或缺失语言返回 `undefined`，由调用方渲染纯文本。

扩展名 → 语言映射不在这份文件里：它是同仓库 [code-language](<../../code-language/README.md>)
的 `languageForPath` / `readLangHintForPath`。两边的语言 id 与别名表必须对齐，因此消费方
只经 `webview/markdown/highlight.ts` 调用，不在本地另写第二份表。

## 两处本地差异

1. **两臂完整搬入**。阶段 2 只搬流式臂；阶段 4 解析接线按固定上游把
   `parseGfmWithMath`、`mathCompatibility.ts`、`mdast-util-math` 与
   `micromark-extension-math` 成对补回。轨迹纯文本投影仍只用 `parseGfm`，语义不变；
   正文 streaming 继续 `parseGfm`，settled 由本地 `webview/markdown/math.ts` 用
   相同扩展集合装配（包装公开 construct / handler 记录金额与围栏事实），
   `parseGfmWithMath` 作为官方语法基准保留。
2. **`classifyFileType` 换成本地判定**。上游那里是
   `classifyFileType(path) === 'image'`，而 `classifyFileType` 住在
   `FileTypeIcon.tsx`（连同十几个 React 图标组件），搬它等于搬整个图标模块。
   判据等价：上游那个函数先过「代码文件名规则」（按名字匹配，`code-file-types.ts`
   里没有任何图片扩展名）、再过 `NAME_TYPES`（changelog/contributing/readme）、
   最后才是扩展名表，所以对「以图片扩展名结尾」的路径它只可能是 `'image'` 或 `'other'`；
   `isImageFilePath()` 就是把扩展名表里 `'image'` 那一档逐条抄下来。

## 为什么值得为它付出体积

`trajectoryPreviewText` 从前是本仓库照着官方注释手写的 **marked 近似版**：极端嵌套
语法（表格、列表、围栏代码与 HTML 混排）的投影与官方**可能不同**。搬进来之后预览与
正文共用同一套 mdast 语法，投影必然一致。代价是 webview 产物多约 85 KB
（单独打包这部分依赖的实测值）；阶段 2 起正文也共用这套语法，`marked` 依赖已删除。
