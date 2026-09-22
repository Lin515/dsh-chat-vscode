# 轨迹面板：契约、口径与实现落点

> 本文是「轨迹」视图的长期契约备忘：官方轨迹的折叠口径、字段语义与本扩展的实现落点。
> 动 `src/dsh/trajectory.ts` / `src/shared/trajectory.ts` / `Trajectory.tsx` /
> `trajectoryTexts.ts`，或排查「账本少了哪类记录」之前先读第 1、2、5 节。
> 轨迹已实现；当初的分步计划已删，规格落点见 `src/dsh/trajectory.ts` 文件头。

## 1. 核心结论：轨迹没有任何服务端接口

**官方的「轨迹」没有 RPC、也没有投影，它是客户端对同一份 durable 会话事件窗口做的
第二次独立折叠。** 依据（`dsh-client-ui-trajectory` 0.1.5-rc.1 安装产物逐行核对）：

- `@deepseek-ai` 全部 `.d.ts` 搜 `trajectory/` 零命中；`session/*` 远程方法枚举里没有
  `trajectory*`；该包 `lib/client.js` 全文 `fetch(` / `WebSocket` / `/api/` / `remote.` 零命中。
- 数据入口是会话本地的**视图目标（view target）**：
  `uiConversation.binding(binding).target("trajectory")`，经
  `uiSession.provide({hooks:["trajectory"]})` 供出，注册进 `conversation.view` 槽
  （`id:"trajectory"`、`order:10`）——所以轨迹是**整页视图**，不是盖在会话上的抽屉。
- 折叠由 5 个注册函数挂上去的 **8 个 `ConversationNodeDefinition`** 承担：各自
  `ctx.uiConversation.events.register(...)` 订阅 durable 事件，用 `buildViewNode()`
  产出 `TrajectoryContribution`。

对本扩展的直接结论：官方轨迹展示的全部内容都来自我们**已经在收**的两条流——
`session/follow`（事件窗口 + 逐 token 帧）与 `session/page`（往前翻页）。
差距只在**折叠**与**字段保留**，不在传输，不需要任何新的服务端调用。

数据流全貌（官方；本扩展等价链路是 `adapter.trajectoryEvents()` →
`deriveTrajectoryModel` → `{type:"trajectory", json}` 帧 → `TrajectoryView`）：

```
session/follow（含 session/page prepend）→ durable 事件窗口 + 客户端瞬时帧
        ▼
各 Definition 折成 TrajectoryContribution → TrajectorySnapshotBuilder 合并成 TrajectorySnapshot
        ▼
deriveTrajectoryLayout() → 账本（turn → group → cell）
deriveTrajectoryTimeline() → 时间线        TrajectoryTable 的本地检查器
```

## 2. 官方契约（字段语义与口径）

### 2.1 权威来源

官方形状的权威来源是**本机安装树的官方 `.d.ts`**（短、可读，是契约；需要逐字形状去那里
查，本文不复录）：
`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-trajectory\lib\types\client\`
下的 `trajectory-record.d.ts`、`trajectory-contract.d.ts`、`layout.d.ts`、`timeline.d.ts`、
`TrajectoryTable.d.ts`、`TrajectoryView.d.ts`；实现体在同包 `lib/client.js`。
本扩展的等价类型在 `src/shared/trajectory.ts`。

### 2.2 记录（`TrajectoryCellProps`；本扩展 `TrajectoryCell`）

种类 `TrajectoryCellKind` 是闭集：`system / user / context / compacted / message / tool /
subtool`。逐条消费的字段（只列语义与坑点）：

| 字段 | 语义 |
|---|---|
| `index` | 1 起的记录序号，账本显示 `#N`；整本账本必须连续 |
| `recordId` | 投影稳定身份；官方 `trajectoryRecordId()` 回退链：`recordId` → `kind\0call\0callId` → `kind\0seq\0sourceSeq` → `kind\0index\0N` |
| `text` / `previewMarkdown` | 非 markdown 单行摘要（CSS 省略号）/ markdown 原文（消费方转单行摘要） |
| `opensTurn` | 仅**真用户消息**为 true（开新模型轮） |
| `requestOnly` | 辅助请求的纯分隔锚点，无可见正文 |
| `messageSource` | 来源（`source.kind/plugin/round`…）；标签只看 kind / plugin / round 三者 |
| `inputDetail` / `outputDetail` / `thinkingDetail` | 详情面板用的全文（参数 / 结果 / 思考） |
| `systemPromptDetail` / `previousPromptDetail` | 系统提示词正文 / 被替换前的正文（diff 页签要两者） |
| `schemaDetail` / `assistantMetrics` | 调用时的工具 Schema / 助手计时与 token 事实（TTFT、吞吐的输入） |
| `result` / `resultPreviewMarkdown` / `isError` / `callId` | 与调用同行显示的工具结果摘要 / 失败标记 / 调用关联 id |
| `timeSeconds` / `startedAt` | 时长秒与开始时刻；**取不到就是 `null`，不能当 0** |
| `input/cacheRead/cacheWrite/output/think` | message 专用 token 计数（缓存读写分两桶） |

### 2.3 贡献与快照（折叠层的契约）

`TrajectoryContribution` 的 8 个 kind（每个 definition 各产其一）：
`system-prompt`（提示词节点）/ `node`（普通会话节点）/ `assistant`（node? + partial +
request?）/ `tool`（ToolCallBlock，含未结算）/ `request-header`（header 状态）/
`compaction`（压缩请求）/ `session-end`（seq + time）/ `turn-end`（turn + time + error?）。

`TrajectorySnapshot`：`systemPrompts?`（header 在窗口外的完整提示词）、
`eventNodes` + `eventLocations`、`requests`、`callSchemas`（callId → 调用时 Schema）、
`partial`（**只保留最后一个**流式助手）、`runningCalls`（未结算工具调用）。

`TrajectoryRequestNumber`（请求编号，普通生成与压缩共用基）：
`group/number/status/startedAt/completedAt/error/errorCode/retry/maxRetries/retryDelayMs/
resultSeq/provider/model/requestConfig/usage/cumulativeUsage`；按 `purpose` 分叉——
`assistant` 带 `seq?/turn/step`，`compaction` 是 `seq` 必填、`turn:null`、`step:0`。
`TrajectoryUsage` 是五个互斥桶：`input/cacheRead/cacheWrite/output/reasoning`。

### 2.4 布局与时间线类型

`deriveTrajectoryLayout()` 把快照折成 `TrajectoryTurnModel[]`（turn → group → cell；
`turn:null` 的独立压缩段自成一段），`appendTrajectoryPartialLayout()` 把流式中的助手
追加进末轮。时间线 `deriveTrajectoryTimeline(turns, mode)` 产
`{start,end,spans,turnBoundaries}`：模式 `sequence | duration | time | actual`；
span 带 `index/isError/kind/lane`；**轮次边界是独立竖线**，仅 `turn !== null` 时产生。
选区坐标是**归一化域位置**（与账本、`inRange` 同一套域），绘制与命中各过一次互逆换算
`trajectoryScreenFraction` / `trajectoryDomainPosition`——缩放之后两套坐标不再相等，
混用就是「框选的区域与手划的对不上」。

### 2.5 外部配套契约的语义与坑点

- `SystemPromptNode{text, update}`：`text` 空 = 「没有系统提示词」；`update:true` =
  「已加载 system 节点之后追加的历史内更新」。
- `ConversationPromptSnapshot.system` 空 = 「该请求没有系统提示词，**或**节点在已加载
  窗口之外」——两种含义共用一个空串。
- `RequestPromptChange{kind: initial|system|tools|system-and-tools, previous?}`。
- `RequestView` 两个 purpose（assistant / compaction）共享
  `{startSeq, startedAt, completedAt, status, error?, requestConfig?, usage?, resultSeq?…}`。
- `ConversationNode` 11 个变体；`ToolResultNode` 与 `RunningToolCall` 都带 `subCalls`
  （嵌套层级的数据源）；`PartialAssistant{turn, step, blocks}`；
  `AssistantTiming{stepStartTime, firstTokenTime, completedTime}`。
- 客户端合成事件 `assistant/live-chunk`：按 `attemptId/turn/step/chunk` 组织、可被
  durable settlement **原子替换**——与「把流式 chunk 累加成字符串」的叠加层语义不同，
  映射不对会出重复行。
- **`user/message` 的线格式**：事件 `data` **就是** `UserMessage`
  （`{id, role, content, source}`），**没有** `{message}` 包一层（包一层的是
  `system/message` / `tool/result`）。按 `data.message` 读会让用户与上下文记录整类消失
  （280 份真实日志 2443 条 user/message 全无包装，踩过）。
- `request/header` 载荷：`{header: EpochHeader{config, tools?}, reason, startsSeries?}`；
  `session/end-seed{inherited?}`；`session/page` 的 `throughSeq` **只能**取自
  `session/follow` 开帧的 `snapshot.cursor`。

### 2.6 各 definition 订阅什么、产出什么

| definition | 订阅 | 产出 |
|---|---|---|
| assistant-step | `step/start`（start）；`assistant/live-chunk` / `assistant/message` / `llm/retry` / `step/end`（update） | `assistant` |
| turn-end | `turn/end` | `turn-end` |
| compaction | `compaction/start`（start）；`compaction/summary` / `compaction/end` / `user/message`（plugin='compact' 且带 compactionId）（update） | `compaction` |
| session-end | `session/end-seed` | `session-end` |
| inbox-next-step | `agent/inbox/spliced(target='next-step')` | 纯状态：把后续 `user/message` 分类成 user / steering |
| input-message | `user/message` | `node`（user / steering / context 三分） |
| system-message | `system/message`，或任何**非 append** 的表层操作 | `request-header` 或 `system-prompt` |
| request-header | `request/header` | `request-header` |
| tool-call | `tool/call`（start）；`tool/result`；`tool/ptc-dispatch-start` / `tool/ptc-dispatch` | `tool` |

`TrajectoryCellKind` 的判据在官方 layout 阶段逐 cell 赋值（不是枚举自带）；
user 与 steering 都渲染成 user 色系。

### 2.7 排序与合并规则

**排序两层**：贡献按 `anchorSeq` 升序、同级按 key 字典序入账；折账本时
**initial 系统提示词强制排最前**（`-Infinity`——它在事件流里其实晚于第一条
`user/message`），其余按 `seq`。输出侧：`requests` 按 `startSeq`、finalized 节点按
`seq`、turns 按 `firstCellIndex`；prologue 特例：**turn 0 里没有用户消息时整组并入
turn 1**。

`TrajectorySnapshotBuilder.snapshot()` 的合并口径：

- `request-header` 自身**不产生事件行**，只更新 previous 状态并建 `headersByStep` 表；
- `system-prompt` 进 `systemPrompts`，但被某个 header 的 `change.seq` **代表过的不重复收**；
- `node` 进 finalized 并记 location；`assistant` 补 `requestConfig`，partial 覆盖式赋值
  （只留最后一个），request 经 `applyHeader` 补 prompt/config/change（同一次 change 只挂一次）；
- `tool`：已结算进 finalized、未结算进 `runningCalls`，并按
  `previousHeader.seq < anchorSeq` 捕获 `callSchemas`（递归 subCalls）；
- `compaction` → `requests`；`session-end` → 会话边界；`turn-end` → 收尾表；
- 后处理：未被 `compaction/end` 收尾的压缩在会话边界标 `error`（compaction-interrupted）；
  轮的 error 挂到该轮**最后一条 assistant request**。

本扩展的等价口径在 `deriveTrajectoryModel`：初始提示词行最后 unshift 到最前（并重排
index）、轮错误挂最后一条助手行、最后一次 `turn/end` 之后仍未结算的步骤出一行
「正在生成」占位（刻意差异清单见 `src/dsh/trajectory.ts` 文件头）。

### 2.8 「加载更早」的语义

- 官方轨迹不发自己的请求：走会话同一条 `session.loadOlder()`（底层 `session/page`，
  每页 50），View 层先查「本地是否还有未显示节点」，有就**不再打 RPC**；成功后本地
  节点窗口 +50（`HISTORY_PAGE_NODES = 50`，`historyTailSeq` 钉在挂载时的最新 seq）。
  槽注入的 `loadOlder` 以「快照是否变化」为返回值。Chat 侧另有 `loadThrough(seq)`
  到目标档（单页 200）。
- 官方**轨迹表**另有「向上滚 48px 自动加载 + prepend 后 scrollTop 补偿」；官方**会话页**
  没有自动加载、只有按钮。本扩展两侧一致：只有按钮。
- 本扩展：轨迹的「加载更早」与会话页**共用同一条 `loadMore`**（不带目标 = 单页档；
  `targetSeq` = 到目标档）；宿主只回填会话侧、**不重推账本**，界面在 `historyLoading`
  true→false 后自己再要一份（App 的收尾 effect）。**生成中也能取**：重折前后抄送
  在飞叠加层（`CarriedLiveOverlay`——流式正文/思考、在流里的工具行、在飞 step 的
  首 token 时刻），否则生成中翻历史会把在飞内容毁掉。
- 本扩展没有官方那层本地节点窗口：账本每次折**全量** durable 事件窗口
  （`adapter.trajectoryEvents()`），这是与官方的已知差异。

## 3. 界面口径（官方基准，`Trajectory.tsx` 跟随）

### 3.1 整页视图与工具栏

轨迹是**整页视图**（会话页整块让位、输入区留在原地），没有标题栏与关闭按钮，进出靠
头部「轨迹 ⇄ 会话」图标。工具栏 sticky、高 32px：时长开关（切 `sequence ⇄ duration`；
官方另有「实际时间」开关但 `hidden` 不可见，四模式里 `time`/`actual` 因此不可达）、
轮次全折/全展、调用全折/全展、搜索框。
可折叠判据：轮次 = 该轮非 system 非 requestOnly 的 cell > 1；
调用 = `message` 行**紧邻下一条**是 `tool/subtool`。

### 3.2 账本的列与行

**只有 2 列**：事件列 122px（窄容器 50px）+ 内容列自适应。
事件格里叠放：请求边界按钮（仅 request 行）→ turnRail → selectionRail（error 变红）→
turnLabel（「第 N 轮」/「轮次之间」，窄容器换 `#N`）→ kindSlot + kindTag
（配色按 kind：context 绿、message 紫、user 蓝、tool/subtool 琥珀且子工具更淡、
system/compacted 中性；折叠摘要行与 requestOnly 行不渲染 kindSlot）。
内容格：requestOnly 空；折叠摘要 = `…` + 单行省略（title 给全文）；否则单行省略正文，
**有结果时**换成 2 列 grid（左：工具名 + 参数，右：`→` 结果，error 变红）。
`message` 种类的标签走 `kind.assistant`（`kind.message` 全库零引用）。
行高常量：内容行 30 / 折叠摘要 20 / 终止边界 9。

### 3.3 详情检查器

出现条件：选中了记录或请求。宽度 `clamp(320px, 38%, 440px)` 初值、可拖 320–720，
窄屏（≤760px）变右侧抽屉。页签按记录种类分派：

- `system`：提示词正文 + 工具目录；带 `previous` 时多一个 diff 页签（对 system 文本与
  工具目录 JSON 各出一段结构化补丁）；
- `compacted`：概述（状态 / 时长 / Token 固定 `—` / 原始输出 markdown）；
- markdown 记录（user/context/message）：概述 + 预览 + 原始内容（有 messageSource 再加来源）；
- tool/subtool：概述 + 参数 + 结果 + Schema（按**调用时**的目录查——本扩展取选中行之前
  最近的 system 行的目录，对应官方 `previousHeader.seq < anchorSeq` 的时序）+ 计时；
- 请求级页签（官方 REQUEST_TABS）：概述 / 选项（仅 requestConfig 存在时出现）/ 用量
  （本次 + 会话累计）/ 计时——本扩展尚未做请求级检查器（见第 5 节）；
- 概述页是**直接摊开的卡片**（官方 overviewSections）：工具 = 参数/结果/Schema/计时，
  markdown = 预览，压缩 = 摘要正文；分节标题可点，点了切到对应页签；
- 切记录时优先保留仍可用的旧页签（tabHistory）。

### 3.4 时间线

固定顶部概览条（绘图区高 50px，左侧泳道标签列 44px）。**分组按记录（cell），不按
轮次**；泳道 `laneFor`：tool/subtool → 2，message/compacted → 1，
system/user/context → 0。四种模式的域：`sequence` 每条可见 cell 占 1 单位；`duration`
用真实毫秒宽并**扣掉操作之间的空闲**；`time` 每条宽度归零（等时长）；`actual`
真实毫秒不扣空闲。`startedAt` 非有限的时间段整条不进时间线。交互：

- 左键拖 = 选区；右键拖 = 平移（仅已缩放时；**`contextmenu` 无条件
  `preventDefault`**——右键在这条时间线是手势，只拦 `zoom>1` 会弹 VS Code 菜单、
  看着像「拖不动」）；滚轮以光标为锚缩放（`exp(deltaY*0.0015)`，上限 100 倍）；
- Escape / 双击 = 清选区；点 span = 选中该记录并让账本滚过去（**时间线选谁，账本就
  滚到谁**；目标行**顶边**对齐视口顶——用户 2026-09-15 二次口径）；点空白 = 聚焦最近记录；
- 左端 `…` = 加载更早（仅视口贴住全域左端时显示）；
- span tooltip：种类 + 开始时间（或起止区间）+ 总时长 + 首 token/解码；
- 本扩展多一颗官方没有的「复位缩放」按钮（双击清选区之外的出路）；
- 缩放平移后选区比较发生在归一化域（见 2.4 的坑）。

### 3.5 默认展开与定位

默认**全部展开**、不选中任何记录、页签初值概述；账本默认锚到底部（`anchorTo:"end"`），
且仅贴底（阈值 2px）时继续跟随新行。官方在 records > 100 或还有更早历史时启用虚拟化
（overscan 12 行），零高的 requestOnly 行挂到下一条内容行上；跨视图定位
`inspectCallId`（官方 `viewRequest.focus`）：命中前自动扩容本地窗口，命中后展开并平滑
滚动居中——本扩展未做（见第 5 节）。

### 3.6 搜索索引

官方 `recordSources` 的字段清单（照抄参考）：轮次（`turn N` / `between turns`）、分组
标题、kind（message 记成 `assistant`）、`text`、`previewMarkdown`、input/output/thinking/
schema 四个 detail、`result`、`resultPreviewMarkdown`、`callId`、sourceBlocks/outputBlocks
每块的 `type/content/callId/toolName/attachment.name`，再加 `messageSource` 与两个
promptDetail 的 JSON 串；匹配 = 全部字段 join 后小写，按空白切词、**全部词命中**才算，
空查询返回 null。预览截断：源 2048 字符 → 抽纯文本 → 折空白 → 512 字符（被截加 `…`）。
本扩展按 `Trajectory.tsx` 的 `matches()` 逐 cell 现算（不预建索引），字段是其中主要
字段的子集（kind 标签、text、preview、input/output、result、toolName、callId、error）。

## 4. 文案

官方 175 key 的逐条对照已删；唯一登记表是 `src/webview/trajectoryTexts.ts`
（`TrajectoryTexts` 接口就是 key 清单，`zh`/`en` 两本词典按接口齐全、由 TS 强制；
`trajectoryTexts(locale)` 按 `dshChat.language` 取词典——这些文案只在 webview 内部
消费，不走宿主的 `@key` 标记）。代码里看不出来的两条口径：

1. **带参数的 key 必须登记成函数**（接口里就是函数类型），禁止字符串拼接——中英语序不同。
2. **时间/时长格式化**：取不到一律「不可用」文案（不是 0 也不是空串）；不足 1 秒显示
   毫秒（四舍五入整数），否则显示秒——10 秒内保留 2 位小数、更长保留 1 位（都四舍五入）；
   秒入参先 ×1000 再走同一函数；时刻显示本地 `HH:MM:SS.mmm`（毫秒 3 位补零）。
   官方另有一版「整数毫秒 + 千分位」的时长（`formatDurationMillis`）与带日期的
   `formatStartedAt`（`YYYY-MM-DD HH:mm:ss.SSS`），本扩展未采用。

## 5. 本扩展现状与差距

### 5.1 已落地

折叠层 `src/dsh/trajectory.ts`（账本 + 请求编号 + 重试进度 + assistantMetrics）；
类型 `src/shared/trajectory.ts`（cell / turn / 时间线 + 域坐标互逆换算）；
界面 `src/webview/components/Trajectory.tsx`（工具栏 / 账本 / 时间线 / 检查器，含时间线
滚轮缩放与右键平移、检查器拖宽与窄屏抽屉、时间线 → 账本联动定位、运行中占位行）；
文案 `src/webview/trajectoryTexts.ts`；断言 `scripts/trajectory.test.ts`。
数据链路是**拉取制**：视图开着时运行中每 3 秒发一次 `listTrajectory`、停下后再取一次
收尾（视图关着不发；会话 id 进依赖，切会话必重取）；宿主现折全量事件，整份模型走
`{type:"trajectory", json}` **JSON 字符串帧**——账本里 `timeSeconds/startedAt` 的
`null` 是有意义空值，整体字符串绕开了「undefined 键被 JSON 丢掉」的线格式坑。

### 5.2 仍缺（与官方的差距清单）

- **流式正文**：不出官方那种流式助手行，只出「正在生成」占位（刻意差异，防重复行；
  官方 live-chunk 可被 durable settlement 原子替换，我们的叠加层语义不同）。
- **steering 不区分**：官方靠 `agent/inbox/spliced(target='next-step')` 的 claim 集合把
  部分 `user/message` 归为 steering；本扩展该事件仍静默，非 user 的 `user/message`
  全归 context。
- **系统提示词面替换的完整语义**：`system/message` 自己的多次改写不单独出行，按
  `request/header` 的变化合并（刻意差异；官方会出独立更新行）。
- **检查器**：请求级检查器（选项 / 用量含会话累计 / 请求计时）、层级跳转（hierarchy）、
  逐块 `sourceBlocks`/`outputBlocks`（含块级「打开工具调用概述」）未做；
  `optionsDetail` 已存但无选项页。
- **从对话跳进轨迹**（官方 `viewRequest.focus` 的 `inspectCallId` 链路）。
- **请求边界小标记**（官方账本事件列顶上的 requestBoundaryControl）。
- **本地节点窗口**：官方只折最近 50 节点并有短路判断；本扩展每次折全量事件窗口。

### 5.3 服务端调用

**不需要任何新的 RPC**：官方轨迹的全部输入都在 `session/follow` + `session/page` 里，
`session/*` 远程方法里没有 `trajectory*`。唯一实现细节：`session/page` 的 `throughSeq`
只能取自 `session/follow` 开帧的 `snapshot.cursor`；本扩展用「固定开帧 cursor + 动态
`earliestSeq()` 作 `beforeSeq`」，与官方等价（官方侧由 gateway 内部管理，是否同构未确认）。

## 6. 证据不足 / 无法确认

- 时间线 lane0 内部是否还有排序 / 分层规则未见（重叠处理在 CSS，不在 JS）。
- 官方 7 个零引用 key（`kind.message`、`kind.sub`、`column.output/think/time`、
  `record.json`、`record.parametersJson`）是留给未来还是死键，无法判定。
- 官方按 `callId` 跳工具概述对 subtool 不成立（subtool 的 callId 与父 tool 不同），
  是缺陷还是有意，未确认。
- `session/page` 之后官方 `throughSeq` 是否变化未确认（gateway 内部）。
- `assistant/attempt` 在轨迹里的角色未确认（assistant-step 的 match 不含它）。
- 官方账本行的 `data-*` 属性是跟随实现而非声明的公开契约，样式 / 测试挂钩时自担风险。
- `AssistantMetricDetail.usageProvided/outputTokens` 的单位无注释（从用法读是 token 数）。
