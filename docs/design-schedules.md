# 自动化任务（DSH `schedule`）的管理面

**本文是什么**：本扩展对官方自动化任务的**消费口径**与**界面管理能力**——数据来自哪一条
请求、代际怎么判、编辑的乐观并发怎么走、哪些动作必须先取得用户确认。**什么时候读**：
改动 `src/dsh/scheduleView.ts`、`src/shared/schedule.ts`、`src/webview/components/Schedule*`
或 `src/dsh/controller.ts` 里 `schedule` 那几段之前。契约原文见
[DSH API 参考的自动化任务管理](<dsh-server-api.md>)，版本对齐与兼容层登记见
[版本兼容](<dsh-compat.md>)。

## 一条数据流，两种视图

宿主只读官方**零形参**的 `schedule/catalog`，把**整份全局目录**落进会话域
（`scope.schedules`），再用同一张字段表推给界面。理由：

- 全局管理（不只是「我这条会话有哪些」）需要整份目录；按会话在宿主侧过滤会把全局视图
  与全局操作一起挡住。
- 目录参数里没有会话，服务端每次返回的都已经是权威全量；再发一次「全局」请求只会多出
  两份互相打脸的清单（各自的读取状态、各自的迟到帧）。

「本会话」因此是**界面上的派生过滤**：`scheduleForSession(items, sessionId)` 按
`scheduleInvolvesSession` 判断——与官方 `taskInvolvesSession` 同口径，**相关会话集合与
投递落点是「或」**：`involvedSessionIds.includes(sessionId) || taskSessionId(item) === sessionId`。
空的相关集合不是「与任何会话都无关」：目标落点恰好是当前会话时，这条任务仍属于这里；
只有两边都不匹配才为假。`new` 目标的落点是最近一次投递的目标会话（服务端首次投递前为空），
`new_once` 是预留的会话 id，`session` 是目标会话本身；旧代目录没有 `target` 时退回原始绑定
`sessionId`。相关会话集合描述「谁的相关任务」（创建者、编辑过的人等），投递落点描述
「投给谁」——两者都算这条任务在这个会话里可见。

## 代际：按形状判，空目录才探针

任务管理端点分两代：

| 能力 | 新代（0.2.2-rc.1 起） | 旧代 |
|---|---|---|
| 目录 / 执行记录 | `schedule/catalog`、`{request:{id,…}}` 的 history | 同左，但条目带 `sessionId` / `inactive` |
| 改时间 | `schedule/edit` 的 `patch.timing` + `expectedUpdatedAt` | `schedule/update` 的完整 `expected` |
| 删除 | `schedule/edit` 的 delete 分支 | `schedule/delete` |
| 创建 / 立即运行 / 暂停恢复 / 名称 / 指令 / 目标编辑 | `schedule/create`、`schedule/run`、`schedule/edit` 的完整 patch | **没有** |

判据（`scheduleCapabilityOf`）：

1. 目录里任何一条带 `target` / `involvedSessionIds` → `modern`；
2. 目录非空但没有这些成员 → `legacy`；
3. 目录为空 → 用**零形参只读**的 `schedule/deliveryLimits` 探一次：拿到有效的
   `newSessionIntervalSeconds` 才算 `modern`；只有**明确的 `endpointAbsent`**（404/405 一类
   网关证据）才算 `legacy`；传输失败、超时、5xx 一律 `unknown`。

`unknown` 不下结论：界面允许试一次创建（真 404 会被宿主降级为 `legacy`，入口随之消失），
但不声称「这个版本不支持」。**不许**用有副作用的请求（创建 / 编辑一次）去试代际——那会把
一次能力探测变成一次真实的写入。

旧代目录不暴露创建、立即运行、暂停恢复与目标编辑；既有「改时间 / 删除 / 执行记录」保留。
这条规则由 `scheduleCapability` 与每条的 `api === 'edit'` 双重把关。

## 编辑：基线与并发

新代的比较基准是**用户开始编辑那一刻**看到的 `updatedAt`（`base`），不是宿主现读的值：

- 判「有没有改」与装配 `patch` 都相对**基线**（`scheduleEditorDirty(draft, base)` /
  `schedulePatchOf(draft, base)`），不是相对最新目录。后台只改了别的字段时，草稿与基线
  都没变，界面不会凭空出现「有未保存的修改」；用户只改名称时 patch 也只带名称，不会把
  别人刚改的指令 / 目标当成自己的修改再提交回去。状态机在 `webview/scheduleEditorState.ts`。
- 后台刷新（`schedule/changed`、重连）只更新目录；**没有本地修改**时草稿与基线一起跟上
  最新值，有未保存修改时两者都保留（覆盖草稿会吞掉用户输入，替换基线会让他的修改凭空
  变成「相对新值」的差异）。
- 提交时把那份基线随请求带回（缺失明确发 `null`）。宿主不替换它——现读会让「保存时才发现
  别人改过」变成一次静默覆盖。
- 目录里的 `updatedAt` 已经不等于基线且草稿确实改过东西时，界面显示冲突说明与
  「重新应用我的修改」（`scheduleReapplyDraft`）：逐字段组比较草稿与基线，改过的那组保留用户
  的值、没改的那组换用最新值。整份草稿覆盖最新值会把别人刚做的修改悄悄改回去。
- **保存成功**时宿主先读回权威目录、再发结算帧；界面把草稿与基线一起换成刷新后的那一版
  （`scheduleEditorState` 的 `saved` 动作）。只清失败提示、不推进基线，下一次刷新就会把
  「自己刚保存的那一版」误判成冲突。等待结算期间表单只读，因此这次替换不会吞掉新输入。

一次性（`at` / `after`）的时间差异与官方 `taskDraftPatch` 一样，先把当前草稿与从基线生成的
草稿做**相同的提交形态转换**再比较（本扩展用 `scheduleChangeFromDraft`）：编辑器是整秒控件，
目录时钟带毫秒，不能只把一边截成整秒再与另一边的 `.mmm` 文本比较。否则刚读取的任务就会
被误判为有未保存修改，连带禁用删除 / 暂停 / 运行，也阻止后续权威目录更新草稿。
回归覆盖 `at` / `after` 的 `.000` 与非零毫秒、只改名称不重写时间、真实日期 / 时间 / 时区修改，
以及中英文展开 / 折叠状态的三个操作按钮。

`patch` 只带**真正改过的字段**（名称 / 指令 / 目标 / 时间 / `active`），由
`schedulePatchOf` 装配：时间没动就不带 `timing`（否则一次只改名称的保存会把时刻重新锚定），
目录没变就不带 `target`，并保留原来的 `agentPreset`——只改名字的用户不该丢掉他选的预设。

目标切到「发往会话」时必须选中一个会话：下拉框在没有匹配项时只显示第一项、提交的仍是
空 id，因此界面给空值一个占位项并显示 `invalid_target` 说明、同时禁用保存
（`scheduleTargetError`）。已存的目标会话不在当前列表里（归档 / 别的目录）时原样保留为
一项，不让下拉框显示成别的会话。

旧的「改时间」端点仍按原样使用读取时留下的完整规则原文（`scope.scheduleExpected`），
两代在同一界面里并存，互不影响。

## 变更入口的串行与权威条件

所有同一行的变更共用一个 `busy`（等待结算 / 删除等待 / 目录读取中），删除按钮不能只看
自己的删除阶段——否则保存 / 运行 / 暂停在飞时再点删除，两个操作会各自记账、互相覆盖
等待态。可用性判定集中在 `webview/scheduleControls.ts`（纯函数，离线可断言），与官方
`TaskDetail` 同口径：

- 目录读取中 / 读取失败 / 代际未知时不是权威目录：保存、暂停、删除、立即运行都不可用
  （字段仍可继续填）；代际未知时保存按钮**禁用并显示说明**，不是可点但静默返回。
- 删除与暂停还要求没有未保存修改、没有正在执行；已结束的行不显示暂停。
- 表单字段只在等待结算、删除中、目标会话执行中时只读。

## 迟到帧：三层隔离

一次请求的结果只属于**发它的那个上下文**：

1. **读取代号**：`scope.schedulesEpoch` 每次目录读取自增。同一个域可能同时有正式读 + 后台
   刷新 / 变更后的重读在飞，先发的旧读晚回来不许覆盖后发那次已经落地的结果（成功、失败与
   空目录探针的每条 `await` 之后都比对）。
2. **视图 / 域 / 客户端绑定**：结算帧发出前比对 `scopeOfView(viewId) === scope`、域仍在表里、
   客户端没被换掉；执行记录与投递间隔读取在 `await` 之后同样比对，迟到的结果直接丢弃。
   变更请求 `await` 之后的**副作用**（读回目录、把变更响应并回目录、给域降级）走同一个
   判据（`scheduleMutationCurrent`）：旧连接的一次 404 **不得**给当前域降级成旧代，也不许
   用新客户端去读旧域的目录。界面的投递限制缓存（含端点缺席与读取失败）在切会话或客户端
   身份变化时清空；客户端身份沿用宿主的 `images/scope` 通知，同一身份的重复通知不清空。
   新范围按需重新读取，不能因旧缓存已有值而跳过。
3. **操作标识**：界面每次请求带一个 **webview 生命周期内唯一、单调递增**的 `opId`
   （`webview/scheduleOps.ts` 的模块级发号器；行卸载重挂、新建卡重开、执行记录请求共用
   一个序号），宿主原样回显。界面只让 `scheduleResultSettles(pending, frame)` 为真的那一帧
   结算自己的等待态——种类不同、非创建操作的任务 id 不同、`opId` 不是当前这次，都不结算。
   创建在请求时还没有 id，回帧带新 id 也算同一次；旧宿主不回 `opId` 时退回按种类与 id
   匹配（唯一的兼容退路）。执行记录的回帧必须与**最近一次请求**的 `opId` 相等，迟到或
   对不上号的整帧丢弃。

真到了「帧回来时上下文已经换了」的地步，仍发一帧带 `code: 'stale'` 的失败：界面据此说
「未确认」，而不是把一次没落定的请求说成成功或失败，也不会永远停在「正在保存」。

## 立即运行：不是更改计划

`schedule/run` 立刻投递一次，**不消耗、不移动原计划时刻**；它会在目标会话触发一条用户消息，
可能执行模型并消耗 token。因此：

- 必须由用户在界面里**明确确认**（就地确认块里写明后果），不做任何自动触发；
- 有未保存修改、`executionActive`、投递间隔未到、目标会话已归档、或目录/代际不是权威
  （读取中、读取失败、代际未知）时按钮不可用；旧代**整块不出现**（不是灰一个永远点不动的
  按钮）；
- 归档判据只认**肯定证据**：目标会话出现在宿主的归档列表里（`archivedSessions`）。
  「不在活跃会话列表里」可能只是别的目录，不能据此判归档；`new` 目标每次新建会话，不参与
  归档判定；
- `schedule_execution_pending` 是**正常的等待**（同一任务另一次执行还占着位置），用单独一句
  文案说明，不报成故障；`schedule/target-archived` 单独一句「目标会话已归档」。

宿主只转发与结算，绝不自己发起。

## 运行状态与限制

目录条目自带两位实际状态，界面必须如实展示：

- `executionActive`：最近一次投递仍在目标会话里排队或执行（`new` 目标不设这一位）；
- `deliveryFloorEndsAt`：最小投递间隔的结束时刻。**下一次运行时刻**取它与其计划时刻的较晚者
  （`scheduleNextRunAt`），不能报一个比 floor 更早的时间；面板里的时钟每 30 秒走一次，并在
  floor 结束那一刻额外叫醒一次，让「立即运行」准时恢复可用。

`schedule/deliveryLimits` 的 `newSessionIntervalSeconds` **只约束 `target.kind === 'new'`**
（每次投递都新建会话）：`new_once` 首次建会话之后复用同一个会话，不受这条间隔限制。因此说明
只在目标选为「每次新建会话」时显示并按需读取，本扩展**不新增**同名扩展配置——服务端给的默认
60 秒就是权威值。

## 界面结构

- `SchedulesSection`：视图切换（本会话 / 全部任务）+ 状态筛选 + 新建入口 + 行清单；
- `ScheduleRow`：摘要、暂停恢复、删除（两段式确认）、编辑表单、立即运行确认块与执行记录；
- `ScheduleEditor`：名称、指令、投递目标（会话 / 首次新建 / 每次新建，`new` 类目标可选目录）
  与运行时间规则（一次 / 固定间隔 / 每天 / 每周 / cron / RRULE），创建与编辑共用；
  旧代只放开时间字段（`basicDisabled`）。

样式类在 `src/webview/styles/app.css` 的自动化任务段（`.schedule-toolbar`、`.schedule-tab`、
`.schedule-chip`、`.schedule-confirm` 等），按 flex 布局容纳英文，不按字数定宽。窄侧栏用
`npm run preview` 的真实旧代夹具观察：预览页的根宽度是可配置的（`?width=320`，默认 420 是
模拟侧栏宽度），不要把「视口比默认根窄」当成组件把页面撑宽——旧代夹具在 320 宽、中英文下
的工具条与详情表单都没有横向溢出；「新建任务」卡只在代际未判明时出现，320 宽实测右边缘
仍在根内（306 / 320），其现代字段由离线 SSR 断言覆盖。

## 来源与改动边界

新代纯函数与官方 `packages/client/ui-schedule`（目标版本 `dsh-v0.2.2-rc.1`，commit
`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）的同名口径对齐：`taskNextRunAt`、
`taskSessionId`、`taskInvolvesSession`、`taskDraft`、`taskDraftPatch`、`reapplyTaskDraft`、
`draftTarget`、`taskDraftIssue` 的判定规则逐条保留，落在 `src/shared/schedule.ts`、
`src/dsh/scheduleView.ts` 与 `src/webview/scheduleEditorState.ts` / `scheduleControls.ts`。
其中 `taskInvolvesSession` 是**逐条照搬**的「相关会话集合或投递落点」，不是本扩展的改写；
`TaskDetail` 的 `runHeld` / 保存 / 删除 / 暂停禁用条件也逐条落在 `scheduleControls.ts`。
官方实现依赖它自己的 slot / store 与品牌类型，本扩展改为自己的视图模型与纯函数接口，
不引入官方 UI 组件的运行期依赖；界面按本仓库既有自绘风格实现，没有逐字复制官方组件。

## 验证边界

离线回归在 `scripts/schedule.test.ts`（线格式、频率、时间编辑、旧代兼容）、
`scripts/scheduleManage.test.ts`（目录字段、归属过滤、请求体校验、客户端载荷、宿主接线、
界面接线与文案）与 `scripts/scheduleEditor.test.ts`（编辑状态机、变更入口策略、结算账本、
选中会话的渲染、归档目标提示）以及 `scripts/scheduleConcurrency.test.ts`（驱真控制器 +
假客户端：成功结算前先读回目录、迟到上下文不写当前域 / 不降级 / 不换客户端读旧域）。
这些是**纯离线**断言：不启动真实 DSH、不发送模型消息、不调用真实 `schedule/run`。真实
服务端的端到端行为（限流时序、归档目标、RRULE 的实际推进）不在离线证据范围内，需要时按
当次批准单独验证。
