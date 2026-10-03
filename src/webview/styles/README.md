# src/webview/styles/ — 样式

webview 的两份 CSS。上一层的说明见 [../README.md](../README.md)。

- `tokens.css` — 设计 token：语义色先解析到 VS Code 主题变量，无主题变量时落硬编码回退。
- `app.css` — 界面外观：顶栏、消息流、输入框等各分区样式。

## 字号口径

用户可见文字的字号一律基于基准字号 `--font-size` 换算，不要硬编码 px/em。基准来自
`dshChat.fontSize` 配置（auto 时取 VS Code 注入的字号），档位在 `tokens.css` 的 `.app`
规则里派生：`--font-size-body` = 基准+1、`--font-size-sm` = 基准、`--font-size-xs` =
基准−1、`--font-size-2xs` = 基准−2、`--mono-size` = max(编辑器字号, 基准−1)。
新增文字必须引用这些档位 token；Markdown 内部标题的 em 倍数与个别固定小字（轨迹时间线
的泳道标签等）是存量例外，新增类似取值前先确认无法用档位表达。

