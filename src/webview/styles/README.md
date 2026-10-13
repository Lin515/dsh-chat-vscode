# src/webview/styles/ — 样式

webview 的两份 CSS，上层见[界面导航](<../README.md>)。

- [tokens.css](<tokens.css>) — 设计 token：语义色先解析到 VS Code 主题变量，无主题变量时落硬编码回退。
- [app.css](<app.css>) — 顶栏、消息流、输入框等各分区外观。

字号档位、设计像素、换算例外、断点、根 token、测量顺序与滚动条决策统一见[界面尺度](<../../../docs/design-ui-scale.md>)，本页不维护第二套规则。

## 残影：状态高亮不许越出行盒 / 刻线盒

撤掉高亮时可能原地留薄残影：旧像素落在新状态盒外，按新盒子清帧时失去归属。两条已知通路：

- **透明边框吃掉高亮**：background-clip 初值 border-box，背景涂满透明边框。将边框折入内边距，让行盒与高亮矩形重合（`.popover-item`）。
- **状态切换改几何**：刻线从 18dp 缩回 12dp，旧像素越出新盒。盒宽恒定在最宽档，各状态只用 scaleX 改绘制长度（`.turn-rail-mark::before`）。

滚动层 `contain: paint` 提供绘制边界（`.trigger-popover .popover-list`、`.turn-rail-scroller`）。新增状态高亮须保证新盒罩住旧画；[styles 回归](<../../../scripts/styles.test.ts>)的「候选行高亮不越出行盒」与「右侧轮次横条」固定相应写法。

## 预览默认样式层

[预览页](<../../../test/preview.html>)不只要复刻 VS Code 主题变量，还要补 `@layer vscode-default` 规则；否则容易产生预览生效、真机无效的假验证。

例如 html 的 `scrollbar-color` 会继承，令 Chromium 忽略 `::-webkit-scrollbar*`。本项目不自绘滚动条，预览也必须保留这项默认规则；详见[尺度决策](<../../../docs/design-ui-scale.md#滚动条交给-vs-code>)，styles 回归检查两端约束。
