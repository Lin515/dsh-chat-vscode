# src/vendor/ui-primitives/markdown/ — Markdown 解析与纯文本投影链

上游 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../../README.md](../../README.md)；改写约束见 [../../AGENTS.md](../../AGENTS.md)。

这条链以**投影**（Markdown 原文 → 单行纯文本）为主，同时是正文渲染的语法来源：
`webview/markdown/parse.ts` 消费 `parseGfm`；`settled` 数学由
`webview/markdown/math.ts` 以**相同扩展集合**装配，并在公开 construct / handler
外补金额否决与围栏事实。`parseGfmWithMath` 仍保留为官方语法基准与等价性断言来源，
本地适配不复制语法规则。

| 文件 | 上游对应 | 作用 | 本仓库的改动 |
|---|---|---|---|
| `parse.ts` | 同名文件 | mdast 两个语法臂：streaming 的 `parseGfm` 与 settled 的 `parseGfmWithMath`（GFM + CJK 友好粗体 + 本地图片恢复 + TeX math） | 完整搬入两个臂；去掉 `.ts` 后缀，文件头补来源说明 |
| `mathCompatibility.ts` | 同名文件 | micromark 扩展：`\(...\)` / `\[...\]` 与同行 `$$...$$` 复用 math token 词汇 | 逐字搬入；仅文件头补来源说明 |
| `plain-text.ts` | 同名文件 | mdast 树 → 纯文本（三种边界：全文 / 首行 / 首段） | 去掉 `.ts` 后缀 |
| `cjkFriendlyStrong.ts` | 同名文件 | micromark 扩展：让星号粗体在「标点后紧接 CJK」时正确闭合 | 去掉 `.ts` 后缀 |
| `local-image-syntax.ts` | 同名文件 | 把「带空格的本地图片路径」那种单图片段落恢复成图片节点（预览时留 alt） | 见下：`classifyFileType` 换成本地 `isImageFilePath()`；去掉 `.ts` 后缀 |

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
