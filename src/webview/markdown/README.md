# src/webview/markdown/ — 正文 Markdown 管线

正文入口在 [components/Markdown.tsx](<../components/Markdown.tsx>)；本目录负责解析、代码源文提取、Windows 目标修复、完成态代码高亮、完成态数学**解析事实**与整棵 mdast → React 渲染，业务只传文本、`phase` 与文件词表，不接触 mdast 类型。设计、阶段状态与验收见[Markdown 渲染设计](<../../../docs/design-markdown-rendering.md>)。阶段 3 已接入完成态代码高亮；阶段 4 的本地数学解析事实已落地，KaTeX 排版尚未接线，生产组件仍显式走普通 GFM；原始 HTML 按字面文本输出。

- [parse.ts](<parse.ts>) — `parseMarkdown(source, phase = "settled")` / `parseGfmMarkdown`：按 phase 选择 vendor GFM 或本地数学臂，随后修复 Windows 目标、收集文档级参考 / 脚注定义；缺失定义的脚注引用恢复为 `footnoteReference`，文中有代码时附带 `codeSources`。生产渲染在 KaTeX 接线前显式调用 `parseGfmMarkdown`。
- [math.ts](<math.ts>) — 完成态数学解析适配：与 vendor 同集合单遍装配，包装公开 `math()` 文本 construct 做保守金额否决，包装 `mathFromMarkdown()` 的 `mathFlowFence` 记录权威闭合；`MathSource` 把 `form` / 定界符 / `closed` / 源码 offset / `raw` / 有效 `tex` 写进节点 data。`math` 围栏仍为 code，`mathFenceSource` 预留其后继转换事实。
- [source.ts](<source.ts>) — `collectCodeSources` / `codePayload` / `sourceFallback`：用与解析同源的 micromark 事件流提取代码载荷（容器缩进、tab 虚拟列、NUL 与 CRLF 保真）；未知节点回退为安全源码片段。
- [windowsDestinations.ts](<windowsDestinations.ts>) — `fixWindowsDestinations`：解析后按源码位置恢复行内链接 / 图片的 Windows 绝对目标，把反斜杠编码为 `%5C`，已编码的目标不二次编码。
- [render.tsx](<render.tsx>) — `renderMarkdownDocument`：整棵 mdast 递归映射为 React（段落、列表、表格、引用、脚注、链接、任务列表、代码卡）；`MarkdownImage` 自持图片 pending / ready / failed，链接标题在渲染时合并，不用 `innerHTML`、不做渲染后水合。
- [highlight.ts](<highlight.ts>) — 完成态代码高亮纯模块：Shiki 细粒度 core + JavaScript 正则引擎、21 种静态 grammar、语言别名、源码偏移 token、受控颜色 / 字形与成功 / 失败缓存；模块顶层不初始化引擎。接线与选区冻结在 `components/CodeBlock.tsx`。
- [types.ts](<types.ts>) — `MarkdownPhase`：`streaming` / `settled`，缺省 `settled`；`CodeBlock` 只在 settled 初始化高亮，streaming 与 SSR 保持纯文本。

离线断言见 [markdown.test.ts](<../../../scripts/markdown.test.ts>)、[math.test.ts](<../../../scripts/math.test.ts>)、[markdownSource.test.ts](<../../../scripts/markdownSource.test.ts>)、[footnotes.test.ts](<../../../scripts/footnotes.test.ts>)、[localImageResolve.test.ts](<../../../scripts/localImageResolve.test.ts>)、[fileLinks.test.ts](<../../../scripts/fileLinks.test.ts>)、[highlight.test.ts](<../../../scripts/highlight.test.ts>) 与 [selectionRange.test.ts](<../../../scripts/selectionRange.test.ts>)；真实 DOM 时序由受控浏览器回放。
