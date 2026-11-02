# src/vendor/ui-primitives/ — 基础组件包的纯决策模块

上游 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../README.md](../README.md)；改写约束见 [../AGENTS.md](../AGENTS.md)。

这里只搬了**一个子目录**：

- `markdown/` — Markdown 解析与纯文本投影链（轨迹预览文本的权威实现，正文解析的语法来源）→ [markdown/README.md](markdown/README.md)

上游这个包的大头（`MarkdownText.tsx`、`render.tsx`、`highlight.ts`、`CodeBlock.tsx`、
`FileTypeIcon.tsx` 等）**没有搬**：它们是渲染器与图标。本扩展的正文渲染由本地
[webview/markdown/](<../../webview/markdown/README.md>) 适配层复用这里的
`parseGfm` / `cjkFriendlyStrong`；settled 数学由本地 `math.ts` 用相同扩展集合装配，
`parseGfmWithMath` 作为官方语法基准与等价性断言来源。**例外是 `katex.tsx`**：
KaTeX → React 适配器逐字搬入，`MathView` 直接调用 `renderTexToReact`，
不再自写元素树映射；其余 UI 与 React 渲染仍由本地组件承担。

生产正文在 streaming 走 GFM，settled 走本地数学解析，再由 `MathView` 调用 vendor 的
KaTeX→React 适配器排版；失败、超限或未闭合的公式按原文回退。完成态代码高亮、数学排版与
资源 / 验收边界统一见 [Markdown 渲染设计](<../../../docs/design-markdown-rendering.md>)。
