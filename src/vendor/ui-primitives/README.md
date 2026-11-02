# src/vendor/ui-primitives/ — 基础组件包的纯决策模块

上游 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../README.md](../README.md)；改写约束见 [../AGENTS.md](../AGENTS.md)。

这里只搬了**一个子目录**：

- `markdown/` — Markdown 解析与纯文本投影链、KaTeX→React 适配器、客户端语法高亮核心 → [markdown/README.md](markdown/README.md)

上游这个包的大头（`MarkdownText.tsx`、`render.tsx`、`CodeBlock.tsx`、`FileTypeIcon.tsx` 等）
**没有搬**：它们是渲染器与图标。本扩展的正文渲染由本地
[webview/markdown/](<../../webview/markdown/README.md>) 适配层复用这里的
`parseGfm` / `cjkFriendlyStrong`；settled 数学由本地 `math.ts` 用相同扩展集合装配，
`parseGfmWithMath` 作为官方语法基准与等价性断言来源。**例外是 `katex.tsx` 与 `highlight.ts`**：
KaTeX → React 适配器与语法高亮核心逐字搬入，`MathView` 直接调用 `renderTexToReact`，
`webview/markdown/highlight.ts` 直接消费 `grammarForHint` / `StreamingHighlightSession`；
高亮所需的扩展名 → 语言映射来自同仓库的 [code-language](<../code-language/README.md>) 副本。
其余 UI 与 React 渲染仍由本地组件承担。

生产正文在 streaming 走 GFM，settled 走本地数学解析，再由 `MathView` 调用 vendor 的
KaTeX→React 适配器排版；失败、超限或未闭合的公式按原文回退。完成态代码高亮同样由 vendor
的语法高亮核心 tokenize，本地适配层只做主题变量映射、原文偏移校验与资源上限。数学排版、
高亮资源与验收边界统一见 [Markdown 渲染设计](<../../../docs/design-markdown-rendering.md>)。
