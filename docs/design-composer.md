# 输入区工具栏：优先级与宽度自适应

修改 `.composer-bar` 元素、次序或布局前读本文。显示档位由同一份 `BAR_ORDER` 与实测宽度分配，不用固定窗口宽度猜隐藏谁。

## 优先级与档位

| 槽位:档位 | rank | 口径 |
|---|---|---|
| `context:ring` | 0 | P0 pinned，占用环最高优先级；精确数值另属 P2 |
| `permission:icon` | 1 | P0 pinned，盾牌入口，title 给全称，无下箭头 |
| `model:full` | 2 | P0 pinned，当前模型名，max-width 150px，无下箭头 |
| `send:full` | 3 | P0 pinned，运行且正文与附件都没有为停止；否则按 busyEnter / 当下 Ctrl、Cmd 手势显示发送模式 |
| `effort:full` | 4 | P1，只读思考等级，点击 toggle 同一模型弹层 |
| `attach:full` | 5 | P1，通用附件入口，不随模型是否收图隐藏 |
| `tps:full` | 6 | P1，会话平均输出速度（Σ 输出 token / Σ 解码窗口），与 hover 同源同格式 |
| `permission:label` | 7 | P2，图标 + 权限名，与 icon 互斥 |
| `preset:full` | 8 | P2，会话开始后的只读预设名 |
| `context:text` | 9 | P2，环 + 44K/128K，与 ring 互斥，环内无百分比 |
| `model:provider` | 10 | P2，提供商/模型名，与 full 互斥 |

P0 四项无条件落位，极窄也留 DOM。P1 / P2 各档按渲染左右次序，左边优先；挪元素必须同步 rank。占用环是有意例外，虽然在右半区仍最高优先级。

分配是**前缀**：某档装不下，后面的这一帧都不显示，不跳过高档贪心填低档。接受空隙以保证宽度增加时元素只进不出、不降档。同槽位逐档升级只付宽度差，不再付 gap；互斥档 rank 必须递增。

## 实测与生命周期

候选档位放到 `.composer-measure`：零尺寸、overflow:hidden、visibility:hidden，量整个控件（图标 / 内边距 / 文字），不是只量文本。模型名、语言、字号和数字位数都可能改变宽度。

- 每项 getBoundingClientRect().width 向上取整，避免临界半像素抖动。
- 可用宽度 = bar.clientWidth − computed 左右 padding；新槽位计 computed column-gap（通常 8px，mini 4px）。
- 提交后的 layout effect 与 ResizeObserver 两处触发。`createFitAnchor` 的 callback ref 随条件渲染替换节点，断旧观察、挂新观察；StrictMode 重新挂载也必须恢复观察。
- `toolbarAvailableWidth` 量不到有效布局盒时不结算，保上一有效档位。真实极窄、扣 padding 后为 0 / 负值仍须分配；visibility:hidden 保布局盒，仍可测，不能靠视口宽度猜。
- 缺数据的档位不进表，null 不占槽位 / gap；签名没变不 render，空结果用稳定 EMPTY_RANKS。

连 P0 都放不下时由 CSS 收窄 / ellipsis，不再另加隐藏门。mini 的 220px 只调间距与 padding，不决定谁显示。新文字需 nowrap + ellipsis，中英都检查。

## 行为约定

发送按钮与 Ctrl/Cmd+Enter 共用 `composerSend`：默认 queue 时加速手势为 steer，默认 steer 时为 queue；按钮在点击当下读修饰键，界面只发手势，宿主解析模式。只有附件、正文为空也能发送（官方 `empty` 把附件算作内容），此时不显示输入框占位文案。文件附件未就绪（上传中 / 上传失败）时发送按钮置灰，悬停说明原因；生成中已有正文或附件时保留排队 / 插话文案、不变成停止，两者都没有才仍是停止（发送门判据见 `shared/attachmentGate.ts`）。

预设标签只在 messages.length 非零时显示，与空态判据一致。目录或当前 id 未到不画空壳；展示共用 presetDisplayText，内置四个走词典，用户自写原文，未知 id 原样。空态的可点预设选择与开轮后的只读标签不能混用。

## 权限弹层

| 来源 | 档位 | 条件 |
|---|---|---|
| 客户端双语词典 | read-only / workspace-write / danger-full-access | 恒有 |
| 服务端目录 | auto（Auto review，实验） | permissionAutoReview 为真，或当前值已是 auto |

Auto 能力与目录失败的判据统一见[投影设计的 permissions](<design-projections.md#permissions权限>)，版本与部署不能替代目录证据。界面当前已是 auto 必须能显示，不能因请求失败伪装成别档；目录变更事件触发重读。

Auto 的七条文字逐字取官方 accessZh / accessEn；官方中文名也为 Auto review。自补 IconShieldReview 以满足最小图标档。danger-full-access / auto 都在弹层内确认，不弹系统模态；auto 必须勾选风险确认才可继续。关弹层 / 再点胶囊 / 换档复位确认态。

## 实现与回归

| 文件 | 职责 |
|---|---|
| [toolbarFit.ts](<../src/webview/toolbarFit.ts>) | BAR_ORDER、pickVariants、观察目标与可用宽度前置 |
| [Composer.tsx](<../src/webview/components/Composer.tsx>) | barNodes、useToolbarFit、渲染次序 |
| [app.css](<../src/webview/styles/app.css>) | 测量层、定位基准与收窄 |
| [messages.ts](<../src/webview/messages.ts>) / [texts.ts](<../src/webview/texts.ts>) | 双语登记与取词典 |
| [projections.ts](<../src/dsh/projections.ts>) / [controller.ts](<../src/dsh/controller.ts>) | 权限目录判据与拉取 |
| [toolbarFit.test.ts](<../scripts/toolbarFit.test.ts>) | 优先级、临界宽度、单调性、互斥、gap、渲染次序与观察生命周期（含负对照） |
| [styles.test.ts](<../scripts/styles.test.ts>) / [previewFixture.test.ts](<../scripts/previewFixture.test.ts>) | 测量层与旧阈值防线、预览覆盖 |

新增元素同步预览夹具；UI 改动再看中英宽度阶梯。本次仅编辑文档时常规验证依[AGENTS](<../AGENTS.md>)，不自动启动真实模型探针。
