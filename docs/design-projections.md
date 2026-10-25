# 投影与面板：消费规则、决策与边界

修改投影解析、模型、权限、目标、任务或子代理前读本文。线格式来源见[服务端契约](<dsh-server-api.md>)，版本与兼容分支见[兼容规则](<dsh-compat.md>)；会话列表、空壳与未读见[会话设计](<design-sessions.md>)。

## 投影值存储与水位

一个会话域持有一份 `ProjectionValueStore`，按键保存 `{value, seq}`：higher seq wins，同 seq 不覆盖。baseline 按 `asOfSeq` 播种；替换型 baseline 截断旧世代并清理切点上缺失的能力键。迟到 follow 快照不能绕过水位写回已折叠值。

形状解析在 `projections.ts`，读取登记在 `projectionIngest.ts` 的 `PROJECTION_READERS`，新旧判断在 `projectionStore.ts`，效果由 controller 的 `ProjectionHandlers` 映射类型表承接，缺一个键编译即失败。解析、水位与效果分开，新增键须完成整条登记，不另建旁路。

### 关键决策与取舍

- 宿主拥有水位，而不是由界面按到达顺序覆盖。丢弃线上 `seq` / `asOfSeq` 会让旧重放帧把新值顶回去；统一存储使这条契约只有一个裁判。
- 适配器不直接读取 `projections.values.title`；投影标题走 controller 效果，`session/title` 事件仍有独立入口。
- `session/list` 携带的投影提示有意不走 store，采用最后到达值。列表契约允许缓存陈旧提示，扩展不为未打开会话建域；为防抽屉标题回退而维护全部会话投影不值得。不能将这条例外当遗漏补齐。

## 执行目录

`workingDirectory` 是 `string | null`，从 `header.cwd ?? null` 初始化，`working-directory/change` 更新它；执行侧还可使用部署默认目录或恢复失效目录，不保证总与 header 的原始拼写相同。通过同一投影登记表消费 follow 开帧、控制流 baseline 与增量；按水位拒绝旧值，baseline 缺键与 null 清空后退回创建目录，不自行从工具参数推断。

扩展把执行目录用于当前 `@` 查询、标题显示与实时变更的[消息通知](<design-notifications.md>)，不改创建 / 认领目录、工作区归属、空壳复用、历史过滤、权限或既有进程。会话片段包含该值，切会话、重连均沿用快照与投影机制。**不把最新投影用于重算历史目标**：普通相对文件引用使用创建目录，工具文件与终端目录分别采信 `meta.path` / `meta.cwd`，清单按 Host 坐标及固定根定位；文件读取由执行世界提供，不默认落到扩展本机。各消费者的回退与尚未实施项见[文件路径](<design-paths.md>)。

执行目录显示在标题（及子代理计数）右侧：文件夹图标后空一格接目录名，再空一格是所在路径，路径不重复目录名；装不下时先省略所在路径。VS Code 未打开文件夹时显示执行目录；打开文件夹时，仅在执行目录与工作区目录不同时显示。投影缺失时依次回退会话创建目录、窗口目录；比较保留 POSIX 大小写，不因远端路径采用本机 realpath。

投影效果同时区分跟随开帧、控制流 baseline 与实时增量的来源；存储与水位规则不变。只有被接受的实时执行目录实际变化产生绿色通知，初始铺值、重连 baseline、同水位重发、缺键与 null 清空均静默，不能仅凭「已经见过一次该键」猜测是否实时发生。

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

标题点击后的切换清单画的是**整棵多层树**（`subagentTree`，用户 2026-10-20 口径）。宿主维护一份跨域的 `subagentIndex`：`session/list` 原始行的 `parentSessionId` 给出父链，`projections.values.subagent` 给出这条会话自身的模式与 label，各目录并入点再补描述符 label / 创建时刻。树由 `subagentTree.ts` 先序展开：第 1 层是顶层会话直接调用的子代理，与顶层会话行同级对齐；更深层按 `depth` 缩进。普通会话没有子代理、自己也不是子代理时不发这个键，标题保持纯文本；正在看子代理时树根永远是顶层祖先。父链断掉的节点不硬塞到根下，环只出现一次。切换任意一层由同一份索引给出真实父会话与模式，不再限制只能切兄弟。

目录行的**显示顺序**按判定时间从新到旧（`subagentOrder.ts`）：用户消息（`sessionListMetadata.lastPromptAt`，实时来路是 `api-session/activity` 的 `updatedAt`，`session/list` 行的 `updatedAt` 作整份打底）与一轮收尾（宿主亲历的 `api-session/status` running→false）两者取新、不加优先级，agent 的过程消息不参与判定；并列按创建时刻（更晚建的在前），再并列才退回发现顺序。创建时刻来自投影 / durable 事件的 `createdAt`，对两条路径是同一份事实，所以父会话目录与子代理页的父目录快照永远给出同一个顺序。排序键在下发与父目录快照两处**现算**，不写回目录——否则重放会用旧顺序盖回去。用户消息的实时中继让顺序在后台当场跟上，打开标题清单不再等约一秒的整份列表才跳位。

收尾证据独立于展示用 running：仅 `api-session/status` 的 true 登记待结算证据，false 一次性消费。列表 true 只是打底，不算亲历开轮；列表 false 不抹掉已经亲历的 true，也不直接记收尾，因此列表刷新穿插与同名迟到 false 都不会漏记或重复刷新顺序。

排序时间、待结算证据与跨域血缘索引都属于当前连接：完整原始列表中消失、变成普通会话、删除或归档时清理。两条完整列表读取路径只清请求前已有、且等待期间未被 status / activity / catalog / 父目录新事实更新的记录；清理旧父节点不连带删除等待期新注册的后代；请求候选在完成或失败时回收。并发列表按已采纳水位整份拒收先发后到的旧快照，缺席与在场都不能覆盖更新的证据。连接收线清空索引并拒收旧在途列表，迟到的父目录 / 目录 RPC 不回填。父域回收不清理，返回后重放目录仍保留顺序。删除 / 归档后的服务端残留列表行、status 与 activity 不重新填账。读树是纯读，不登记也不复活节点。离线回归由 `subagentOrder.test.ts` 驱动真实 controller 覆盖上述时序与三处目录生产者。

### 父域回收与显示名

离开父视图后父域可能已销毁。兄弟切换须同步携带父目录种子；异步恢复补齐后直接通知当前子会话窗口，不能误发给“看其子代理”的窗口。

无 label 时发帧现算显示名：真 label → 打开时描述符 / 会话标题 → 标题账本 → id。不写回目录，避免重放将本地标题覆回 uuid。标题账本来自 session/list 与已打开会话 title patch，由列表刷新、菜单打开与子代理收尾防抖维护时效。

## jobs、inbox 与轮次大纲

- jobs 名册来自 `job/list` 流的整表 rows，旧服务端兼读 control baseline / jobs 帧，不走投影。输出单独走 `job/follow`；五态为 running / stopping / completed / killed / failed。打开面板只重发宿主内存，不刷新服务端，不能把“点击后出现”直接归因为取数时机。
- inbox 与旧 queue 帧经各自解析入口折算，context 不显示；queued / steering 的呈现与操作差异见[发送设计](<design-draft.md>)。
- turnOutline 已登记消费，大纲独立于本地分页窗口，含未加载轮次的预览与跳转。
- imageLimits 的已消费项和整批准入缺口见[附件设计](<design-attachments.md>)，不在这里维护第二份限额表。

jobs 的入口计数、可见性与状态色差异须按当前 UI 核对，不把历史视觉观察当新缺陷。旧报告的“完全不读 inbox”“完全丢弃 turnOutline”不是现状。

## 自动化任务（schedule）

DSH 的定时任务由模型工具 `schedule_create` 建立，服务端把「规则 + 原始会话绑定 + 状态 + 最近一次投递」存成一条持久记录。本扩展把它并进后台任务抽屉的**自动化任务**分区（`webview/components/Schedules.tsx`），三种视图状态各自独立，**不许**合并成一句「没有任务」：

| 视图 | 状态来源 | 不许折成什么 |
|---|---|---|
| 清单 | `schedulesStatus`：`undefined`（没问过）/ `loading` / `ready`（可能是空表）/ `unsupported`（端点不存在）/ `error`（这次没拿到） | 「没有自动化任务」 |
| 执行记录 | 帧上的 `code`（任务不存在 / 游标失效）、`error`（这次没拿到）、`hostUnavailable`（宿主连问都没问出去）与「成功读到的空历史」四者分开 | 空表 |
| 变更结算 | `schedules/result` 的 `ok` 与稳定错误码；`code` 缺失 = 请求根本没发出去 | 「已保存」 |

清单读的是**全局目录**（`schedule/catalog`）按当前会话过滤，不是 `schedule/list`：后者只回**活跃**任务，一条一次性任务投递完就变成 `inactive` 并从它里面消失——用户再也看不到、也删不掉自己那条。目录带回 `status` 与 `lastDelivery`，正是「跑完的还在不在」要的信息。刷新时机有四处：**会话域建起来时预取**（静默）、面板打开（`listSchedules`）、`schedule/changed` 广播（只刷**有人等过**的域，`schedulesWanted`）、socket 重连（广播没有重放，不补读就会一直显示掉线前的任务集）。预取不是可选项：抽屉入口的指示灯要在**从没打开过面板**的会话上就亮得起来（见下），而背景刷新失败**保留上次结果**、连状态都不动——一次抖动不该把「已读到 3 条」改写成「读取失败」。

**入口指示灯**：有待执行（`status: 'active'`）的自动化任务时，顶栏的后台任务按钮**亮起**——与后台任务在跑时同一个入口、同一种活动色，但**不呼吸**（判据在 `webview/activity.ts` 的 `jobsEntrySignal`，用户 2026-10-15 口径；三档 `off` / `pending` / `busy`）。两条来源合在一个判据里，因为它们指向同一个抽屉的两个分区；已结束与词表外的状态都不点亮，与后台任务那边同一条「不认识就不认领」的纪律。档位分开的理由是这只界面把「呼吸」当作活动的专用信号（运行圆点 / 思考鲸鱼 / 待办刻点）：`pending` 时并没有任何东西在执行，而一条每日或固定间隔任务会让入口长期亮着——给它配一段永远跑的动画是谎报活动，与用户抱怨过的「会话早停了、那点还在闪」是同一类错。

改运行时间是**比较并交换**：提交的 `expected` 必须是读取时看到的那份完整规则。视图模型已经把原始拼写丢掉了（`everyAmount` 之类的显示折算不可逆），所以基准由宿主按目录原文保留（`scope.scheduleExpected`，投影口径与官方 `timingSnapshot` 一致，见 `dsh/scheduleView.ts`）；界面只回任务 id 与新的运行时间。服务端拒绝时按码分档显示（`schedule_conflict` / `schedule_ended` / `schedule_not_found` / `not_future` / `frequency_too_high` …），并重读一次权威值——拿着一份过期基准反复重试只会一直撞冲突。已结束（`inactive`）的任务在界面上只读：服务端会以 `schedule_ended` 拒绝。

执行记录按需读取、一次 20 条（与官方详情页同口径），`before` 是上一页最旧一条的 messageId（排他游标）。`earlierRecordsUnavailable`（旧记录没有指令快照）与 `earlierRecordsPruned`（确实被保留窗口裁掉过）是两件事，只有后者配显示保留口径。

删除是**硬删**（任务行与已保存的投递记录一起没）；界面只有任务 id，原始会话绑定由宿主按目录原文拼。两段式确认与后台任务的停止按钮共用同一台状态机（`webview/jobsKill.ts`）。

有意差异（不当作缺陷补齐）：只列**当前会话**的任务（因此也没有官方详情里那个「回到原会话」入口——面板本来就是按会话打开的），全局任务页与会话头部的提醒时钟未做；`cron` 显示规范表达式本身，不渲染官方那句自然语言描述。删除不会取消已经在途的那一次投递——服务端契约如此。

## 会话视图字段一致性

`sessionView.ts` 是快照与 patch 的共同字段登记表。切会话须带 `historyLoading`、`subagentEntries`、`subagentTree` 等清空值；宿主字段与视图字段不能混用。JSON 清空发 `null`，不发会被序列化丢弃的 `undefined`，与 `jsonSafeFrame` / `mergeWirePatch` 配套。

## 验证与未覆盖边界

离线回归入口：projectionIngest、projections、sessionView、wire、subagentSwitch、subagentTitle、cacheHit 与 schedule。真实 plan / goal / subagent 探针须按[验证约定](<../AGENTS.md>)获得当次批准；离线解析正确不证明完整产品能力或安装端时序。

- 会话累计用量胶囊与分桶对话框、自动化任务在**官方那几处**的活跃指示（会话头部提醒时钟、会话行时钟标记、全局任务页与 `schedule_create` 卡片）、subagentTiming 时长未做（本扩展的等价信号是抽屉入口那颗指示灯，见上文）。提醒目录 / 执行记录 / 运行时间编辑 / 删除已并入后台任务抽屉，真实服务端上的时区与 DST 边界、`schedule/changed` 的跨客户端联动仍只有离线断言与契约证据，没有安装端验收。
- 模型目录默认值、可路由性与 failures 的完整消费，部署权限 options，未知 context form 的呈现仍有差异；未知 form 不能猜成已知六种之一。
- 官方 depth / completed 的实际渲染、部署 permission-presets 配置、两种容量来源在真实会话中的分歧频率，以及典型会话 header 去重效果与真实 transcript 下的流程体量，既有证据不足。
- 功能缺口是否跟进是产品决策。零样本、局部测试与接通地址均不证明面板完成或官方等价。
