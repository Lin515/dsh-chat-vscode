# src/webview/styles/ — 样式

webview 的两份 CSS，上层见[界面导航](<../README.md>)。

- [tokens.css](<tokens.css>) — 设计 token：语义色先解析到 VS Code 主题变量，无主题变量时落硬编码回退。
- [app.css](<app.css>) — 顶栏、消息流、输入框等各分区外观。

[main.tsx](<../main.tsx>) 在 `tokens.css` 之后、`app.css` 之前引入 `katex/dist/katex.min.css`；构建时每个 `@font-face` 只保留 WOFF2，字体产物在 `dist/fonts/`，本目录不维护这份上游样式。

字号档位、设计像素、换算例外、断点、根 token、测量顺序与滚动条决策统一见[界面尺度](<../../../docs/design-ui-scale.md>)，本页不维护第二套规则。

## 节点内容框与字号

节点展开区里的每一段阅读内容都套一次 `.row-body`（`.row-exit` 与问卷记录共用同一组声明）：相同的 margin、8/10dp 内边距、1px 边框、`--radius-sm` 与 `--node-body-bg`。同节点有多段（IN/OUT、diff 与输出、注入结构字段与原文）时各段各有一个 `.row-body`，保留各自的 ref、限高与贴底；不要为了“看起来是一张卡”合并多个阅读盒。

外框只归 `.row-body`：工具卡 `.tool-card` 与节点直系代码卡 `.row-body > .code-block` 不再画自己的边框 / 底色 / 圆角。正文 Markdown 里的 `.code-block` 不是节点的直接子元素，继续保留自己的卡片分区。`.row-body.is-action` 是动作行（inspect 按钮），不是阅读内容，保持无框。

内容字号只取 `--font-size`（来自 `dshChat.fontSize`），等宽内容只换 `--mono` 字族并使用 1.5 行高；不再有 `--mono-size`，也不读取 `--vscode-editor-font-size`。路径、行号、计数等辅助标注仍可用更小的档位；Markdown 标题与数学保持相对字号。任务态审批 / 待答问卷 / 输入区计划审阅是交互面板，不使用节点阅读框。

## 代码高亮配色

`.code-block` 与 `.md-code-surface` 上的 `--md-code-*` 变量只给代码 token 上色：语法色（keyword / string / constant / comment / function / parameter）按 base / dark / light / high-contrast / high-contrast-light 各用一组固定受控值，**不得改取 `--vscode-symbolIcon-*`**——那是大纲 / 补全图标色，不是 TextMate tokenColors，主题可把它设成与正文相同，于是 span 存在也看不出高亮。只有 `--vscode-editor-foreground`、`textLink-foreground` 与 git 增删色这类有真正语义的主题变量可以透传。四主题 + 预览浅色都要同步；[styles 回归](<../../../scripts/styles.test.ts>)在「图标色全部等于正文」的模拟下断言语法角色仍互相分色。

## 残影：状态高亮不许越出行盒 / 刻线盒

撤掉高亮时可能原地留薄残影：旧像素落在新状态盒外，按新盒子清帧时失去归属。两条已知通路：

- **透明边框吃掉高亮**：background-clip 初值 border-box，背景涂满透明边框。将边框折入内边距，让行盒与高亮矩形重合（`.popover-item`）。
- **状态切换改几何**：刻线从 18dp 缩回 12dp，旧像素越出新盒。盒宽恒定在最宽档，各状态只用 scaleX 改绘制长度（`.turn-rail-mark::before`）。

滚动层 `contain: paint` 提供绘制边界（`.trigger-popover .popover-list`、`.model-popover-list`、`.turn-rail-scroller`）。新增状态高亮须保证新盒罩住旧画；[styles 回归](<../../../scripts/styles.test.ts>)的「候选行高亮不越出行盒」与「右侧轮次横条」固定相应写法。

## 预览默认样式层

[预览页](<../../../test/preview.html>)不只要复刻 VS Code 主题变量，还要补 `@layer vscode-default` 规则；否则容易产生预览生效、真机无效的假验证。

例如 html 的 `scrollbar-color` 会继承，令 Chromium 忽略 `::-webkit-scrollbar*`。本项目不自绘滚动条，预览也必须保留这项默认规则；详见[尺度决策](<../../../docs/design-ui-scale.md#滚动条交给-vs-code>)，styles 回归检查两端约束。
