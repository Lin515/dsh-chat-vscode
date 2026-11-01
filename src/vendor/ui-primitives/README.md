# src/vendor/ui-primitives/ — 基础组件包的纯决策模块

上游 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../README.md](../README.md)；改写约束见 [../AGENTS.md](../AGENTS.md)。

这里只搬了**一个子目录**：

- `markdown/` — Markdown → 纯文本的投影链（轨迹预览文本的权威实现）→ [markdown/README.md](markdown/README.md)

上游这个包的大头（`MarkdownText.tsx`、`render.tsx`、`highlight.ts`、`CodeBlock.tsx`、
`FileTypeIcon.tsx` 等）**没有搬**：它们是渲染器与图标，本扩展的正文渲染走自己的
[markdown.ts](<../../webview/markdown.ts>)（marked + DOMPurify），两者目前互不替代。

待实施的正文迁移将按固定上游来源复用 micromark / mdast 解析，仍由本地 React 渲染适配保留扩展 UI 与安全行为；不整搬官方组件，也不改变现有轨迹纯文本投影语义。范围、来源锁与验收见[Markdown 渲染设计](<../../../docs/design-markdown-rendering.md>)。
