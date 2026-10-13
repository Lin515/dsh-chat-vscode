# 投影与面板：消费规则、决策与边界

修改投影解析、模型、权限、目标、任务或子代理前读本文。线格式来源见[服务端契约](<dsh-server-api.md>)，版本与兼容分支见[兼容规则](<dsh-compat.md>)；会话列表、空壳与未读见[会话设计](<design-sessions.md>)。

## 投影值存储与水位

一个会话域持有一份 `ProjectionValueStore`，按键保存 `{value, seq}`：higher seq wins，同 seq 不覆盖。baseline 按 `asOfSeq` 播种；替换型 baseline 截断旧世代并清理切点上缺失的能力键。迟到 follow 快照不能绕过水位写回已折叠值。

形状解析在 `projections.ts`，读取登记在 `projectionIngest.ts` 的 `PROJECTION_READERS`，新旧判断在 `projectionStore.ts`，效果由 controller 的 `ProjectionHandlers` 映射类型表承接，缺一个键编译即失败。解析、水位与效果分开，新增键须完成整条登记，不另建旁路。

### 关键决策与取舍

- 宿主拥有水位，而不是由界面按到达顺序覆盖。丢弃线上 `seq` / `asOfSeq` 会让旧重放帧把新值顶回去；统一存储使这条契约只有一个裁判。
- 适配器不直接读取 `projections.values.title`；投影标题走 controller 效果，`session/title` 事件仍有独立入口。
- `session/list` 携带的投影提示有意不走 store，采用最后到达值。列表契约允许缓存陈旧提示，扩展不为未打开会话建域；为防抽屉标题回退而维护全部会话投影不值得。不能将这条例外当遗漏补齐。

## 模型、计划与目标

- `modelSelection` 读取 `next ?? lastUsed`。模型目录默认值与 `catalog.default` 的关系、`routableProviders` / `failures` 的完整消费仍需核对，不能声称已阻断不可路由输入。
- `plan` 有效目标态为 `pending ? !active : active`。进入与退出走命令通道，不靠发给模型的正文或本地乐观值；发送仲裁见[发送设计](<design-draft.md>)。
- `goal` 是 `{goal: {...}, roundsStarted, createdAt, updatedAt}`：目标在内层，轮次在外层；`null` 清空。形状不对可能不报错而恒为空，解析必须由 `goalFromProjection` 处理。

## permissions（权限）

只解析 `currentValue`；菜单固定 read-only / workspace-write / danger-full-access，不消费投影 `options`。custom 或部署自定义选项可能回退到 workspace-write，不能宣称与服务端目录等价。

Auto review 只在 `permissionPresets/catalog.options` 明确含 auto 时开放，不看 `defaultOptions`（auto 不能成为部署默认）。404 缺端点与暂时失败分开处理，瞬态错误不能抹掉已有能力结论；实验集成卸载会改变目录与命令缓存。目录证据与弹层行为见[工具栏设计](<design-composer.md>)。

## todos（任务清单）

形状为 `TodoItem[] | null`，每条只有 `content` 与 pending / in_progress / completed 三态；null 清空列表。渲染 id 是扩展自造的身份，不是服务端身份，不增加不存在的 priority 等语义。

## 用量与上下文

- `contextPressure` 分子取 `projectedTokens ?? pressureTokens`，只含 prompt 侧，不加 output；压缩等 surface 变化可产生负增量。
- 容量与压力不是原子观测。模型切换可能出现新容量配旧压力，不能用一次静态值证明一致。
- `contextBreakdown` 的 systemTokens / toolsTokens / messageTokens 只是近似构成，不能求和冒充压力值。
- `tokenUsage` 是会话累计的 uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens。缓存命中分母为三个输入桶之和；工具栏 HIT 与悬停共用 `cacheHit.ts`，不取最后一步用量。线格式读取 `cacheReadTokens`，不读视图字段 `cachedTokens`。
- `message.usage` 是最后一步，不代表整轮 attempt 聚合。`sessionStats` 八字段已消费，但主要显示在 tps 悬停，不等于完整的 turns / steps 常驻面板。

## 子代理：目录、身份与活性

| 来源 | 身份与状态 |
|---|---|
| subagentCatalog 投影 | id / createdAt / mode / label；没有 kind、activity |
| subagent/catalog durable 事件 | version=0 / childId / childCreatedAt / mode / label；没有 activity |
| 旧 subagents/list RPC | kind=child 才入表；带 mode、activity；该端点在 0.1.7-alpha.1 删除 |

目录按 id 只增并入，缺失 activity / unread 不覆盖已知值；不同来源不是完整超集。运行状态来自 `api-session/status` 中继，宿主账本处理晚登记回填；unread 是本地已读账本，不是目录字段。继承前缀按 `session/end-seed` 的 inherited 位排除。

打开、follow、page、prompt 与 stop 均按真实地址路由：continuable 可继续，one-shot 只读，unknown 模式不得猜成 continuable。

目录行的**显示顺序**按判定时间从新到旧（`subagentOrder.ts`）：用户消息（`sessionListMetadata.lastPromptAt`，经 session/list 行的 `updatedAt`）与一轮收尾（宿主亲历的 `api-session/status` running→false）两者取新、不加优先级，agent 的过程消息不参与判定；并列按创建时刻（更晚建的在前），再并列才退回发现顺序。创建时刻来自投影 / durable 事件的 `createdAt`，对两条路径是同一份事实，所以父会话目录与子代理页的父目录快照永远给出同一个顺序。排序键在下发与父目录快照两处**现算**，不写回目录——否则重放会用旧顺序盖回去。

收尾证据独立于展示用 running：仅 `api-session/status` 的 true 登记待结算证据，false 一次性消费。列表 true 只是打底，不算亲历开轮；列表 false 不抹掉已经亲历的 true，也不直接记收尾，因此列表刷新穿插与同名迟到 false 都不会漏记或重复刷新顺序。

排序时间与待结算证据属于当前连接：完整原始列表中消失、变成普通会话、删除或归档时清理。两条完整列表读取路径仅清请求前已有且等待期间未被 status 更新的记录，旧快照的缺席不能抹掉实时新证据；请求候选在完成或失败时回收。连接收线清空并拒收旧在途列表。父域回收不清理，返回后重放目录仍保留顺序。删除 / 归档后的服务端残留列表行与 status 不重新填账。离线回归由 `subagentOrder.test.ts` 驱动真实 controller 覆盖上述时序与三处目录生产者。

### 父域回收与显示名

离开父视图后父域可能已销毁。兄弟切换须同步携带父目录种子；异步恢复补齐后直接通知当前子会话窗口，不能误发给“看其子代理”的窗口。

无 label 时发帧现算显示名：真 label → 打开时描述符 / 会话标题 → 标题账本 → id。不写回目录，避免重放将本地标题覆回 uuid。标题账本来自 session/list 与已打开会话 title patch，由列表刷新、菜单打开与子代理收尾防抖维护时效。

## jobs、inbox 与轮次大纲

- jobs 名册来自 `job/list` 流的整表 rows，旧服务端兼读 control baseline / jobs 帧，不走投影。输出单独走 `job/follow`；五态为 running / stopping / completed / killed / failed。打开面板只重发宿主内存，不刷新服务端，不能把“点击后出现”直接归因为取数时机。
- inbox 与旧 queue 帧经各自解析入口折算，context 不显示；queued / steering 的呈现与操作差异见[发送设计](<design-draft.md>)。
- turnOutline 已登记消费，大纲独立于本地分页窗口，含未加载轮次的预览与跳转。
- imageLimits 的已消费项和整批准入缺口见[附件设计](<design-attachments.md>)，不在这里维护第二份限额表。

jobs 的入口计数、可见性与状态色差异须按当前 UI 核对，不把历史视觉观察当新缺陷。旧报告的“完全不读 inbox”“完全丢弃 turnOutline”不是现状。

## 会话视图字段一致性

`sessionView.ts` 是快照与 patch 的共同字段登记表。切会话须带 `historyLoading`、`subagentEntries` 等清空值；宿主字段与视图字段不能混用。JSON 清空发 `null`，不发会被序列化丢弃的 `undefined`，与 `jsonSafeFrame` / `mergeWirePatch` 配套。

## 验证与未覆盖边界

离线回归入口：projectionIngest、projections、sessionView、wire、subagentSwitch、subagentTitle 与 cacheHit。真实 plan / goal / subagent 探针须按[验证约定](<../AGENTS.md>)获得当次批准；离线解析正确不证明完整产品能力或安装端时序。

- 会话累计用量胶囊与分桶对话框、schedule 提醒目录 / 活跃指示、subagentTiming 时长未做。旧 After / At / Every 摘录不是新版契约，实现前重新核对目标类型。
- 模型目录默认值、可路由性与 failures 的完整消费，部署权限 options，未知 context form 的呈现仍有差异；未知 form 不能猜成已知六种之一。
- 官方 depth / completed 的实际渲染、部署 permission-presets 配置、两种容量来源在真实会话中的分歧频率，以及典型会话 header 去重效果与真实 transcript 下的流程体量，既有证据不足。
- 功能缺口是否跟进是产品决策。零样本、局部测试与接通地址均不证明面板完成或官方等价。
