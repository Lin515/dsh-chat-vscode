# src/vendor/ui-primitives/markdown/ — Markdown 纯文本投影链

上游 `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../../README.md](../../README.md)；改写约束见 [../../AGENTS.md](../../AGENTS.md)。

这条链只做**投影**（Markdown 原文 → 单行纯文本），不渲染任何东西。

| 文件 | 上游对应 | 作用 | 本仓库的改动 |
|---|---|---|---|
| `parse.ts` | 同名文件 | mdast 语法臂：GFM + CJK 友好粗体 + 本地图片恢复 | **只搬了流式臂 `parseGfm`**（省略 `parseGfmWithMath` 与 math 依赖，见下）；去掉 `.ts` 后缀 |
| `plain-text.ts` | 同名文件 | mdast 树 → 纯文本（三种边界：全文 / 首行 / 首段） | 去掉 `.ts` 后缀 |
| `cjkFriendlyStrong.ts` | 同名文件 | micromark 扩展：让星号粗体在「标点后紧接 CJK」时正确闭合 | 去掉 `.ts` 后缀 |
| `local-image-syntax.ts` | 同名文件 | 把「带空格的本地图片路径」那种单图片段落恢复成图片节点（预览时留 alt） | 见下：`classifyFileType` 换成本地 `isImageFilePath()`；去掉 `.ts` 后缀 |

## 两份刻意的省略，都只影响依赖、不影响行为

1. **只搬流式臂**（`parseGfm`）。上游 `parse.ts` 还有一条结算臂
   `parseGfmWithMath`（GFM + TeX math + 兼容分隔符），轨迹的消费方
   （`extractMarkdownPlainText` 的默认 `mode: 'all'`）**零引用**它——那一臂属于
   Markdown 渲染器，不是预览投影。连带省掉 `mathCompatibility.ts`、
   `mdast-util-math`、`micromark-extension-math` 三个依赖。将来若真有消费方需要，
   **整支补回来**（含依赖），不许只搬一半。
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
官方渲染器共用同一套 mdast 语法，投影必然一致。代价是 webview 产物多约 85 KB
（单独打包这部分依赖的实测值；`marked` 不能省——正文渲染还在用它）。
