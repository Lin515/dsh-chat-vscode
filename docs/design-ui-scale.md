# 界面尺度：设计像素与测量顺序

修改字号联动、几何尺寸、断点或布局测量前读本文。术语见[领域词表](<../CONTEXT.md>)，工具栏宽度分配见[输入区设计](<design-composer.md>)；样式目录的局部绘制规则见[样式导航](<../src/webview/styles/README.md>)。

## 基准与换算

基准字号为 13px，VS Code 注入的 `--vscode-font-size` 恒为 13px，不随 `editor.fontSize`（后者在 `--vscode-editor-font-size`）。`dshChat.fontSize=0`（auto）采用基准，界面倍率为 1。

CSS 在 `tokens.css` 的 `:root` 推导 `--ui-scale: calc(var(--font-size) / 13px)` 与 `--dp: calc(1px * var(--ui-scale))`，几何量写成 `calc(N * var(--dp))`。JS 几何通过 `uiScale.ts` 的统一入口取得倍率与 `dpLength(N)`；基准 `UI_SCALE_BASE_PX` 与 CSS 分母由 styles 回归对齐，不在组件另定义基准。

倍率用 `@property` 注册为 `<number>`、初值 1，坏值回退不缩放；未注册时坏自定义属性可使整条 width 等声明失效，不能只把它视为局部样式错误。

用户可见文字使用字号档位 token：`--font-size-body` 为基准 + 1、`--font-size-sm` 为基准、`--font-size-xs` 为基准 − 1、`--font-size-2xs` 为基准 − 2。新增文字不硬编码 px / em；Markdown 标题 em 与轨迹泳道固定小字是存量例外，新增例外前先确认档位无法表达。

## 换算边界

| 类型 | 规则 |
|---|---|
| 间距、内外边距、圆角、图标、固定尺寸、阴影与偏移 | 使用设计像素，随倍率换算 |
| 描边与下划线厚度 | 保持发丝线约定，不随倍率 |
| 100% / vw / cqw / JS 实测写回等容器量 | 不随倍率，是布局比较基准 |
| ±1 / ±2px 防抖、贴底容差与时长 | 不随倍率 |
| 内容需要多宽的断点 | 随倍率换算，不按固定物理宽度判断 |

代码块字号为 `max(编辑器字号 × 倍率, 界面字号 − 1px)`，保持代码与正文的相对大小。SVG 的尺寸属性不接受所需 calc，图标尺寸用 inline style 的 `dpLength(N)`，包括品牌标、上下文圆环与 spinner；描边随图标整体等比变化，不加 non-scaling-stroke。新增 CSS svg 尺寸覆盖须考虑 inline style 的优先级。

容器查询用 `calc(N em / 13)`，em 相对查询容器字号。媒体查询的 em 固定相对初始 16px，不能用于字号联动；轨迹断点挂在 `.trajectory-view` 的 inline-size 容器上。JS 中的迷你模式、diff 双栏与检查器宽度阈值按倍率换算，并让倍率进入 effect 依赖。

## 根 token 与测量顺序

- token 与字号覆盖均放在根元素，不只放 `.app`：图片浮层、右键菜单在 `.app` 外；自定义属性 var 在声明处求值，派生声明与覆盖点必须同一级。
- 字号变化后，输入框高度、工具栏档位、气泡超行与路径裁切等 JS 实测状态须重新测量；倍率进入对应 effect 依赖。
- App 写 `--font-size` 必须用 `useInsertionEffect`，早于 layout effect。React layout effect 子先父后，仅把倍率加进依赖仍会让子组件量到旧字号并写死旧高度，直到下一次编辑才恢复。

## 关键决策与取舍

### 不使用 zoom

Chromium 的 zoom 会分裂坐标系：倍率 2 时 getBoundingClientRect 返回缩放后值（如 440），clientWidth / offsetWidth / scrollHeight / computed style 仍是布局值（如 220）。工具栏分配、迷你模式、diff、贴底、检查器拖动与找词定位混用这些量，会静默错判。现有字号已缩放文字，再叠 zoom 还会二次缩放，因此采用显式设计像素而不是整页 zoom。

不另建 `--d-4` / `--d-6` 等刻度 token 层：大量非刻度尺寸仍需 calc，增加第二套选值规则而没有统一收益。

### 滚动条交给 VS Code

VS Code 在 html 写入 `scrollbar-color` 后，Chromium 使用标准滚动条并忽略 `::-webkit-scrollbar*` 整组规则。自绘滚动条在真机无效，宽度与配色交给主题，不列入设计像素换算。

预览必须复刻该默认样式，否则会出现预览生效、真机无效的假验证。styles 回归同时禁止自绘滚动条规则、要求预览有 scrollbar-color。

### 与官方 UI 的关系

非默认字号的断点随倍率变化，不再与官方固定 px 逐像素对齐；这是扩展自己的尺度特性，不改变能力与数据语义。物理面板宽度不变但字号增大时，更早进入轨迹抽屉是有意选择。

## 验证边界

styles 回归检查 CSS / JS 基准一致、几何裸 px 白名单、变量写入顺序与测量依赖。倍率 1（auto / 13px）须保持基准几何；代表性小、中、大字号需人工检查布局、定位与中英文溢出。

既有倍率 1 的 529 元素计算样式对拍未发现非噪声几何差异，只是该次样本的证据，不代表后来改动自动通过；预览滚动条保真度修正也不能算作尺度改写差异。安装端主题与实际 webview 的检查不能由 CSS 源码断言代替。
