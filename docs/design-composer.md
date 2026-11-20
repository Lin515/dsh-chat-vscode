# 输入区工具栏：优先级与宽度自适应

修改 `.composer-bar` 元素、次序或布局前读本文。`toolbarOrder` 把固定档与用户偏好组合成候选表，再用实测宽度分配，不用固定窗口宽度猜隐藏谁。

## 优先级与档位

| 槽位:档位 | 默认保留顺序 | 口径 |
|---|---|---|
| `context:ring` | 固定 | 上下文占用环；没有有效数据时显示中性圆环，不冒充 0% |
| `permission:icon` | 固定 | 盾牌入口，title 给全称，无下箭头 |
| `model:full` | 固定 | 当前模型名，max-width 150px，无下箭头 |
| `send:full` | 固定 | 发送 / 停止入口 |
| `effort:full` | 1 | 只读思考等级，点击切换模型弹层 |
| `attach:full` | 2 | 通用附件入口，不随模型是否收图隐藏 |
| `tps:full` | 3 | 会话平均输出速度（Σ 输出 token / Σ 解码窗口），与悬停同源同格式 |
| `permission:label` | 4 | 权限图标 + 权限名，升级图标档 |
| `preset:full` | 5 | 会话开始后的只读预设名 |
| `context:text` | 6 | 环 + 紧凑用量 / 容量（如 44K/128K），升级圆环档；悬停明细按界面语言显示精确用量与容量 |
| `model:provider` | 7 | 提供商/模型名，升级模型名档 |
| `cache:full` | 8 | 独立的缓存命中率 |
| `tokens:full` | 默认不显示 | 会话累计 Token（官方计费输入 + 输出）；底栏只显示紧凑数值（如 `2.4M`），悬停与上下文圆环共用明细；无数据不显示 |

命令面板的「工具栏保留优先级」打开设置。显示项按保留先后排序，可移动、移出底栏、重新加入列表末尾或恢复默认。**优先级不改变视觉位置**：底栏右侧仍是速度 → 上下文 → Token 用量 → 缓存命中率 → 发送；隐藏上下文数值后，Token 用量直接跟在圆环旁。固定四项不参加设置，极窄时也留在 DOM。

偏好由扩展宿主的 `globalState` 保存，不随会话或工作区切换。webview 发送单个动作，宿主按顺序应用到最新值，保存成功才向已打开视图同步；视图就绪时读取当前权威值。归一化保留已记录的顺序，未记录的新档位按默认状态追加。

分配是**前缀**：先跳过未启用或没有数据的档位；某个实际候选装不下，之后的候选在这一帧都不显示。接受空隙以保证宽度增加时元素只进不出、不降档。同槽位升级只付宽度差，不再付 gap。

## 实测与生命周期

候选档位放到 `.composer-measure`：零尺寸、overflow:hidden、visibility:hidden，量整个控件（图标 / 内边距 / 文字），不是只量文本。模型名、语言、字号和数字位数都可能改变宽度。

- 每项 getBoundingClientRect().width 向上取整，避免临界半像素抖动。
- 可用宽度 = bar.clientWidth − computed 左右 padding；新槽位计 computed column-gap（通常 8px，mini 4px）。
- 提交后的 layout effect 与 ResizeObserver 两处触发。`createFitAnchor` 的 callback ref 随条件渲染替换节点，断旧观察、挂新观察；StrictMode 重新挂载也必须恢复观察。
- `toolbarAvailableWidth` 量不到有效布局盒时不结算，保上一有效档位。真实极窄、扣 padding 后为 0 / 负值仍须分配；visibility:hidden 保布局盒，仍可测，不能靠视口宽度猜。
- 缺数据的档位不进表，不占槽位 / gap；测量和选中结果用稳定档位标识，不用可变化的优先级当键。

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

## 模型弹层（搜索与焦点）

弹层三段：搜索栏、可滚的模型列表、常驻的思考档位。搜索栏与档位区都在滚动容器之外，列表滚到哪里它们都看得见；目录为空时不渲染搜索栏。

| 动作 | 行为 |
|---|---|
| 打开（模型胶囊 / 思考强度胶囊） | 焦点落进搜索框（`preventScroll`，不抢滚动定位）；列表仍定位并高亮当前模型 |
| 输入 | 按模型名 / 模型 id / 提供商名 / 提供商 id 做不区分大小写的子串过滤，多个词须同时命中；搜到提供商名时该组模型全部保留 |
| ↑ / ↓ | 焦点在搜索框时也归列表高亮，输入法组字中不抢 |
| Enter | 选中高亮行；档位只在目标模型支持时带上，否则退回该模型默认档位 |
| 关闭 | 焦点交还最后一次打开弹层的按钮（`Esc` 之后回车仍能重开）；过滤词清空 |
| 无命中 | 列表区显示「没有匹配的模型」，不留空分组标题 |

过滤规则在 [modelSearch.ts](<../src/webview/modelSearch.ts>)（纯函数），高亮与滚动定位在 [pickerFocus.ts](<../src/webview/pickerFocus.ts>)，焦点交接与接线在 [Composer.tsx](<../src/webview/components/Composer.tsx>)。

## 空态页的工作目录

输入栏**不常驻**工作目录胶囊：目录只在「会话还没开始」时有得改，已有对话的目录是创建事实。空会话页的元信息行（`EmptyMeta.tsx`，判据在 `composerDir.ts` 的 `workspaceDirView`）承担这件事：

| 状态 | 形态 | 效果 |
|---|---|---|
| 打开着文件夹（`workspace.roots` 非空） | 胶囊可点，菜单列出全部根目录（当前那个打勾）与「选择其他文件夹…」 | 点根目录发 `switchRoot`；`canPickOther` 不为 false 时才显示其他文件夹，点了发 `pickOtherRoot`。根目录用去重短名，同名时逐级补父目录；完整路径在悬停标题与行内副文字里 |
| 没有根目录列表、可改（`canPickOther` 不为 false） | 沿用原来的系统目录选择器 | 发 `pickWorkspace`；没选过时显示「未选择工作区」，不拿宿主 cwd 冒充 |
| 没有根目录列表、`canPickOther === false` | 静态文字 | 宿主禁用外部目录时系统选择器也不能用，不退回 `pickWorkspace`；悬停说明当前环境不能选其他目录 |
| 没有根目录列表、`locked` | 静态文字 | 老宿主的「跟随 VS Code」形态；已有对话同样只读（`HeaderDir` 只是静态说明） |

单根和多根使用同一套选址规则。换根（`switchRoot`）只接受当前 VS Code 工作区根；「选择其他文件夹」（`pickOtherRoot`）与无工作区根时的系统选择器（`pickWorkspace`）共用本机目录身份检查。检查通过不代表远端 DSH 能访问该目录；检查未通过或选择已失效时，不替换原目录。目录操作只改空会话目标，不移走原会话的草稿。服务端注册按目标目录和连接区分；历史浏览范围独立于空会话选址，详见[会话设计](<design-sessions.md>)的「历史抽屉的只读范围」。

**工作区外的目录不注册成服务端工作区**，与没有打开文件夹时选的目录（`newSessionCwd`）同一口径：注册会让它长期留在 Web 侧栏，而它只是个落脚点；会话按 cwd 建、落在「未分组」。它刻意不持久化，重载窗口或工作区文件夹变化后回到工作区里的根。

预览入口：`?empty=1&roots=1` 用[已录制的宿主帧](<../test/preview/multi-root-history-frames.json>)展示根目录菜单；`?roots=1` 同时提供历史抽屉的范围切换帧。默认预览与 `?lock=1` 不加载这些帧。

**有意不做**：对已有对话改执行目录。网页网关没有「改会话目录」的入口（`session/working-directory/set` 属于 SDK 运行时），唯一合规路径是让模型调 `working_directory` 工具，会占一轮对话且结果取决于模型。官方提供入口后再评估。

## 实现与回归

| 文件 | 职责 |
|---|---|
| [toolbarFit.ts](<../src/webview/toolbarFit.ts>) | toolbarOrder、pickVariants、观察目标与可用宽度前置 |
| [toolbarPreference.ts](<../src/shared/toolbarPreference.ts>) / [ToolbarPreferences.tsx](<../src/webview/components/ToolbarPreferences.tsx>) | 默认档位、偏好动作与设置面板 |
| [toolbarPreferencesHost.test.ts](<../scripts/toolbarPreferencesHost.test.ts>) | 命令路由、保存与恢复、多视图同步及失败处理 |
| [Composer.tsx](<../src/webview/components/Composer.tsx>) | barNodes、useToolbarFit、渲染次序；模型弹层的搜索接线与焦点交接 |
| [modelSearch.ts](<../src/webview/modelSearch.ts>) / [modelSearch.test.ts](<../scripts/modelSearch.test.ts>) | 模型弹层搜索的过滤规则与回归 |
| [pickerFocus.ts](<../src/webview/pickerFocus.ts>) / [pickerFocus.test.ts](<../scripts/pickerFocus.test.ts>) | 模型列表的高亮、滚动定位与搜索框方向键例外 |
| [EmptyMeta.tsx](<../src/webview/components/EmptyMeta.tsx>)、[composerDir.ts](<../src/webview/composerDir.ts>) | 空态页目录行、根目录菜单与按状态分档的纯判据 |
| [directoryLabel.ts](<../src/webview/directoryLabel.ts>) | 同名目录的去重短名（根目录菜单与历史混合目录共用） |
| [app.css](<../src/webview/styles/app.css>) | 测量层、定位基准与收窄 |
| [messages.ts](<../src/webview/messages.ts>) / [texts.ts](<../src/webview/texts.ts>) | 双语登记与取词典 |
| [projections.ts](<../src/dsh/projections.ts>) / [controller.ts](<../src/dsh/controller.ts>) | 权限目录判据与拉取 |
| [toolbarFit.test.ts](<../scripts/toolbarFit.test.ts>) | 优先级、临界宽度、单调性、互斥、gap、渲染次序与观察生命周期（含负对照） |
| [styles.test.ts](<../scripts/styles.test.ts>) / [previewFixture.test.ts](<../scripts/previewFixture.test.ts>) | 测量层与旧阈值防线、预览覆盖 |

新增元素同步预览夹具；UI 改动再看中英宽度阶梯。本次仅编辑文档时常规验证依[AGENTS](<../AGENTS.md>)，不自动启动真实模型探针。
