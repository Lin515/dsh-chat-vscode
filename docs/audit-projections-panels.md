# 投影与面板：消费规则与缺口

现行消费表是 `projectionIngest.ts` 的 `PROJECTION_READERS`，副作用在 controller，形状解析在 `projections.ts`。本文不复制易失效的键数量或旧失败清单；总览见 [审计结论](<audit-summary.md>)，类型来源见 [服务端契约](<dsh-server-api.md>)。

## 投影水位线

会话控制值逐键 higher seq wins，同 seq 也不覆盖。baseline 按 asOfSeq 替换世代、清理切点上缺失的能力键；不能把迟到 follow 快照绕过登记表写回状态。列表镜像采用最后到达值，是不同的有意语义，见 [ADR](<adr/0001-projection-value-store.md>)。

## 模型、计划与目标

- `modelSelection` 读 next ?? lastUsed；默认模型来源与 catalog.default、routableProviders / failures 的完整消费仍有差异，不能声称已提供不可路由输入阻断。
- `plan` 生效态为 `pending ? !active : active`，不是只读 active，也不是客户端乐观值。
- `goal` 是嵌套对象，roundsStarted 在外层；null 清空。
- 容量与压力非原子观测，模型切换可能新容量配旧压力，不能用单次静态值证明一致。

## permissions（权限）

只解析 currentValue；菜单固定 read-only / workspace-write / danger-full-access，不消费投影 options。custom 或部署自定义选项的显示仍可能回退到 workspace-write，与服务端目录不等价。

Auto review 只在 `permissionPresets/catalog.options` 明确含 auto 时开放；不看 defaultOptions（auto 不能成为部署默认），拿不到肯定证据不展示。404 缺端点与暂时失败分开处理，不能因临时错误抹掉已有能力结论。实验集成卸载会改变目录与命令缓存。

## todos（任务清单）

`TodoItem[] | null`，每条仅 content 与 pending / in_progress / completed 三态；null → 空列表。渲染 id 为扩展自造，不是服务端身份，不应增加不存在的 priority 等语义。

## 用量与上下文

- `contextPressure` 分子为 projectedTokens ?? pressureTokens，仅 prompt 侧，不含 output；projectedTokens 含压缩等带符号 surface 增量。
- `contextBreakdown` 的 systemTokens / toolsTokens / messageTokens 是近似构成，不能求和冒充压力值。
- `tokenUsage` 是会话累计的 uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens。缓存命中分母为三个输入桶之和；工具栏 HIT 与悬停取同一个累计值，格式见 `cacheHit.ts`。
- 会话累计用量胶囊与分桶对话框未做；message.usage 是最后一步，不代表整轮 attempt 聚合。
- `sessionStats` 八字段语义已消费，但显示主要在 tps 悬停；不能当作完整 turns / steps 常驻面板。

## 子代理：目录、身份与活性勿混

三种登记形状：

| 来源 | 身份与状态 |
|---|---|
| subagentCatalog 投影 | id / createdAt / mode / label；没有 kind、activity |
| subagent/catalog durable 事件 | version=0 / childId / childCreatedAt / mode / label；没有 activity |
| 旧 subagents/list RPC | kind=child 才入表；带 mode、activity；该端点在 0.1.7-alpha.1 删除 |

目录按 id 只增并入，缺失 activity / unread 保留原值；不同来源不是完整超集。运行状态由 api-session/status 中继，登记先后无保证，宿主账本负责晚登记回填；unread 来自本地已读账本，不是目录字段。继承前缀按 session/end-seed 的 inherited 位排除。

子代理打开、follow、page、prompt、stop 均按真实地址路由；continuable 可继续，one-shot 只读。unknown 模式不得猜成 continuable。`subagentTiming` 时长尚未消费，不把地址接通当作该面板已完成。

### 父域回收与显示名

离开父视图后父域可能已销毁。兄弟切换要同步携带父目录种子，恢复路径异步补齐后直接通知当前子会话窗口，不能误发给“看其子代理”的窗口。回归在 `subagentSwitch.test.ts`。

缺 label 时展示名在发帧时现算：来源真 label → 打开时描述符 / 会话标题 → 标题账本 → id。不写回目录，防止重放把本地标题覆回 uuid。账本来源为 session/list 的 title 与已打开会话的 title patch；列表刷新、菜单打开与子代理收尾防抖维护时效。回归在 `subagentTitle.test.ts`。

## jobs（后台任务）

名册来自 `job/list` 流的整表 rows，旧服务端兼读 control baseline / jobs 帧，不走投影。任务输出单独走 `job/follow`。五态 running / stopping / completed / killed / failed；打开名册面板只重发内存，不能刷新服务端。入口计数、可见性与状态色的官方差异需按当前 UI 核对，不把历史视觉观察当作新缺陷。

## 会话列表与空壳

- title 从列表与投影两路读取；sessionListMetadata 不直接消费，但列表已给出折算 blank。
- 空态是一条真实空壳，有则复用、无则创建。复用须结合客户端 engagedSessions，不能只信滞后的列表 blank，否则首条消息会落进旧对话。
- 后台补壳必须让位恢复：入口跳过 hasRestorePending，写绑定前再查窗口是否已被恢复或手动打开路径绑定。回归在 `blankSessionReuse.test.ts` / `blankRestoreRace.test.ts`。
- 无 cwd 不建壳；无 VS Code 文件夹时可反复选择目录，换目录是换到该目录的壳，不修改已聊会话的 cwd。回归在 `workspaceDirRepick.test.ts`。
- 列表过滤全部 blank 与 subagent 行；允许多窗口共用空壳。这是与单视图官方 UI 不同的既定取舍。
- 打开文件夹时按工作区登记与 cwd 过滤；未打开文件夹时发帧前按各窗口当前会话 cwd 收窄。按服务端 updatedAt 降序，不另猜 lastPromptAt。

## inbox 与轮次大纲

inbox 与旧 queue 帧通过各自解析入口折算，context 不显示；queued / steering 合并呈现的差异见 [输入审计](<audit-input-queue-attachments.md>)。不能继续引用旧结论“完全不读 inbox”。

turnOutline 已登记消费；大纲独立于本地分页窗口，包含未加载轮次的预览与跳转。不要把旧报告的“完全丢弃”当作现状。

## imageLimits

已消费单图 maxImageBytes，缺省硬上限 64 MB；超过限额按文件上传并提示。maxImagesPerMessage / maxMessageImageBytes 的整批预检、像素预检与上传进度未对齐。路径图片准入表与浏览器本地图片扩展名表是两类约束。

## 未消费能力与未确认

- schedule 提醒目录、活跃提醒指示与 subagentTiming 时长尚未做。旧 After / At / Every 摘录不是新版契约；实现前按目标类型重新核对。
- context 注入的未知 form 与官方不透明呈现仍有差异；不能把未知值猜成已知六种形态之一。
- 官方 depth / completed 的实际渲染、部署 permission-presets 配置，以及两种容量来源在真实会话中的分歧频率，历史审计未确认。
- 功能缺口是否跟进属产品决策；新增形态与契约正确性分开，零样本和局部测试均不证明等价。
