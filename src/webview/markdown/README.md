# src/webview/markdown/ — 正文 Markdown 管线

正文入口在 [components/Markdown.tsx](<../components/Markdown.tsx>)；本目录负责解析、代码源文提取、Windows 目标修复与整棵 mdast → React 渲染，业务只传文本、`phase` 与文件词表，不接触 mdast 类型。设计、阶段状态与验收见[Markdown 渲染设计](<../../../docs/design-markdown-rendering.md>)。阶段 2 只切换管线：不含代码高亮与数学排版，原始 HTML 按字面文本输出。

- [parse.ts](<parse.ts>) — `parseMarkdown`：调用 vendor `parseGfm` 后修复 Windows 目标、收集文档级参考 / 脚注定义；缺失定义的脚注引用恢复为 `footnoteReference`，文中有代码时附带 `codeSources`。
- [source.ts](<source.ts>) — `collectCodeSources` / `codePayload` / `sourceFallback`：用与解析同源的 micromark 事件流提取代码载荷（容器缩进、tab 虚拟列、NUL 与 CRLF 保真）；未知节点回退为安全源码片段。
- [windowsDestinations.ts](<windowsDestinations.ts>) — `fixWindowsDestinations`：解析后按源码位置恢复行内链接 / 图片的 Windows 绝对目标，把反斜杠编码为 `%5C`，已编码的目标不二次编码。
- [render.tsx](<render.tsx>) — `renderMarkdownDocument`：整棵 mdast 递归映射为 React（段落、列表、表格、引用、脚注、链接、任务列表、代码卡）；`MarkdownImage` 自持图片 pending / ready / failed，链接标题在渲染时合并，不用 `innerHTML`、不做渲染后水合。
- [types.ts](<types.ts>) — `MarkdownPhase`：`streaming` / `settled`，缺省 `settled`；阶段 2 只透传，供代码高亮与数学阶段使用。

离线断言见 [markdown.test.ts](<../../../scripts/markdown.test.ts>)、[markdownSource.test.ts](<../../../scripts/markdownSource.test.ts>)、[footnotes.test.ts](<../../../scripts/footnotes.test.ts>)、[localImageResolve.test.ts](<../../../scripts/localImageResolve.test.ts>) 与 [fileLinks.test.ts](<../../../scripts/fileLinks.test.ts>)；真实 DOM 时序由受控浏览器回放。
