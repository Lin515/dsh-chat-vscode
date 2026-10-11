# 轨迹面板：契约、口径与实现落点

> 本文是「轨迹」视图的长期契约备忘：官方轨迹的折叠口径、字段语义与本扩展的实现落点。
> 动 `src/dsh/trajectory.ts` / `src/shared/trajectory.ts` / `Trajectory.tsx` /
> `trajectoryDisplay.ts` / `trajectoryTexts.ts`，或改 `src/vendor/` 的消费方式，
> 或排查「账本少了哪类记录」之前先读「核心结论」「官方契约」「行文本的判据」与
> 「纯决策模块的 vendor」栏目。功能存在不代表全部时序和连续交互已验收，规格与差异见
> [宿主折叠](<../src/dsh/trajectory.ts>)文件头，验收范围见「差异管理与验收」。

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
| `text` / `previewMarkdown` | 行内前缀 / markdown 原文（消费方转单行预览，见 3.2.1）。官方在布局层就把本地化文案写进 `text`；本扩展该字段只管**数据**，本地化文案由 `emptySummary` / `attachments` / `resultSummary` / `promptChange` 这几个语义标记在界面侧取 |
| `attachments` | 本扩展特有：用户/上下文行的附件计数（官方 `layout.imageCount` / `layout.fileAttachments` 拼进 `text`，例如「图片 ×2 · 文件 ×1」） |
| `resultSummary` | 本扩展特有：工具结果没有正文时的语义（`images` → 「图片 ×N」、`no-output` → 「无输出」），对应官方 `summarizeResult()` 的两条非正文分支 |
| `emptySummary` | 本扩展特有：没有正文也没有思考时的摘要语义（`tool-call` → 「（仅工具调用）」、`images` → 「图片 ×N」），对应官方 `summarizeAssistantActivity()` |
| `promptChange` | 本扩展特有：系统行出现的原因（`initial` / `system` / `tools` / `system-and-tools`），对应官方 `RequestPromptChange.kind` 的四条文案 |
| `toolUpdate` | 本扩展特有：工具目录变更（官方 `layout.toolAdded` 一族，含「工具已更新 · 新增 N 个」），宿主只给名字与计数 |
| `sourceBlocks` | 原始内容块（官方 `TrajectorySourceBlock`）：工具目录变更行的工具名，以及助手行的**完整原始块**（`type` / `content` / `callId` / `toolName` / `attachment.name`）。`reasoning` 在块里改名叫 `thinking`、`tool-call` 块（`name` + `arguments`）序列化进 `content`——这两条改写是官方 `sourceBlock()` 的口径，搜索索引直接吃它们。`callId` / `toolName` 是**另挂**上去的（官方 `assistantSourceBlock()` 同形），检查器「原始内容」页签靠它们把那一节渲染成跳转按钮并显示工具名；**`content` 里那两个键照旧留着**（从 `content` 摘掉就是丢搜索面）。身份字段在线上叫 **`id`**（不是 `callId`，见 5.2 那条坑） |
| `opensTurn` | 仅**真用户消息**为 true（开新模型轮） |
| `steering` | 生成过程中插进队列、被下一次领取的引导消息（官方节点层的 `kind: 'steering'`）。**不影响外观**：cell 层官方同样渲染成 `kind: 'user'`，差别只有不置 `opensTurn` 与 `steeringPlacement()` 的落组 |
| `requestOnly` | 辅助请求的纯分隔锚点，无可见正文 |
| `messageSource` | 来源（`source.kind/plugin/round`…）；标签只看 kind / plugin / round 三者 |
| `inputDetail` / `outputDetail` / `thinkingDetail` | 详情面板用的全文（参数 / 结果 / 思考） |
| `systemPromptDetail` / `previousPromptDetail` | 系统提示词正文 / 被替换前的正文（diff 页签要两者；`previousPromptTools` 是**被替换掉的那一份工具目录**，与 `toolsDetail` 配对才拼得出「工具目录」那一节的差分——只有一份时不出那一节） |
| `schemaDetail` / `assistantMetrics` | **调用时**生效的工具 Schema（官方 `attachToolSchema()` 的 `JSON.stringify(schema, null, 2)` 原文）/ 助手计时与 token 事实（TTFT、吞吐的输入）。schema 是**逐调用**挂的：目录在这条调用之后变更过也不改写它（回查「这一行之前的目录」会给错的那一份，而界面上看不出来） |
| `result` / `resultPreviewMarkdown` / `isError` / `callId` | 与调用同行显示的工具结果。**三者互斥**（官方 `summarizeResult()` 四条分支）：失败 → `result` 存错误码；有文本块 → `resultPreviewMarkdown` 存**原文**（`result` 留空，显示的是它的预览）；只有图片 / 什么都没有 → `resultSummary` 的语义标记。`isError` 是**唯一**的错误着色判据（助手行从不置这个字段） |
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

**工具目录变更不在这张表里**：它来自 `developer/message`（内容块全是 `tool-addition` /
`tool-removal` 时才算），官方在会话装配层把它折成 `context` 节点，本扩展在折叠层直接
判（`toolCatalogUpdate()`）。判据与文案见 3.2.1。真实样本：本机 438 份会话日志里
52 份含 `tool-addition`、13 份含 `tool-removal`。

### 2.7 排序与合并规则

**排序两层**：贡献按 `anchorSeq` 升序、同级按 key 字典序入账；折账本时
**initial 系统提示词强制排最前**（`-Infinity`——它在事件流里其实晚于第一条
`user/message`），其余按 `seq`。输出侧：`requests` 按 `startSeq`、finalized 节点按
`seq`、turns 按 `firstCellIndex`；初始提示词行的**轮次**按官方 `firstVisibleTurn()` 取
（助手记录里最小的大于 0 的轮次——含「正在生成」占位行与每个 `step/start` 过的步骤——
都没有就是默认轮号 1），**不是**它到达时事件流所在的轮次：跟随窗口带前插历史时，官方把
它归最早可见的那一轮，账本顺序因此是「最早那一轮 → 后面的轮」。prologue 特例：
**turn 0 整段（整组）并无条件并入 turn 1**——上游注释写的是「Orphan turn-0 cells
(orphaned tools) fold into Turn 1」，不看 turn 0 里有什么；本扩展在**建组之前**把
`turn === 0` 的记录改号成 1（官方是删掉 turn 0 的桶、把它的组拼在 turn 1 自己的组之前），
于是保住「初始提示词第一行、摊平顺序 = 显示序号」这条不变量——两种排法只在事件自己带
turn 0 的构造输入下不同（见 5. 差异清单）。真实服务端轮号从 1 起，实测 377 份日志里含
0 号轮的是 **0 份**，所以这一支只在窗口截断之类的异常输入下才会被走到。

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
「正在生成」占位，**会话边界（`session/end-seed`）之前仍在跑的压缩同样标成
`error` + 官方那个合成码**（刻意差异清单见 `src/dsh/trajectory.ts` 文件头）。

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
  （`adapter.trajectoryEvents()`）。**量过之后确认不做**（2026-10-05，理由与数据见
  5.2 的「只折最近 50 个节点」那一条）：真实日志上这笔开销中位 0.4ms、最大 9.5ms，
  而视图开着时每 3 秒才折一次。

## 3. 界面口径（官方基准，`Trajectory.tsx` 跟随）

### 3.1 整页视图与工具栏

轨迹是**整页视图**（会话页整块让位、输入区留在原地），没有标题栏与关闭按钮，进出靠
头部「轨迹 ⇄ 会话」图标。工具栏 sticky、高 32px：时长开关（切 `sequence ⇄ duration`；
官方另有「实际时间」开关但 `hidden` 不可见，四模式里 `time`/`actual` 因此不可达）、
轮次全折/全展、调用全折/全展、搜索框。
可折叠判据：轮次 = 该轮非 system 非 requestOnly 的 cell > 1；
调用 = `message` 行**紧邻下一条**是 `tool/subtool`。

### 3.2 账本的列与行

**只有 2 列**：事件列 122px（中文 96px、窄容器一律 50px，见 5.2 的列宽那一条）+
内容列自适应。
事件格里叠放：请求边界按钮（`requestBoundaryControl`：只在这一请求第一行，绝对定位到
行缝之间，圆点 5px + 悬停浮出「请求 #N」胶囊；失败请求涂红，选中态加环）→ turnRail →
selectionRail（error 变红）→ turnLabel → kindSlot + kindTag（配色按 kind：context 绿、
message 紫、user 蓝、tool/subtool 琥珀且子工具更淡、system/compacted 中性；折叠摘要行与
requestOnly 行不渲染 kindSlot）。
**turnLabel（「第 N 轮」/「轮次之间」）落在这一轮第一条「像样的」记录上**（官方
`flattenRecords()` 的 `turnStart`）：跳过 `requestOnly` 与 `system`，轮内的压缩行也跳过
——「轮次之间」那一段例外，它本来就靠压缩行起头；一轮里一条都不满足时**不出标签**。
判据只在 `trajectoryDisplay.ts` 的 `trajectoryTurnStartsLabel()` 一处，账本与搜索过滤
两条渲染路径都用它（搜索时官方 `filterRecords()` 也是同一套，只是先滤掉未命中行）。
**标签绝对定位**在事件格左上（`top/left: 0`、`width: max-content`），因此**不占行高**——
事件格预留 `padding-left: 36px` 给它让位（窄容器收到 28px）。标签里叠着两枚（官方
`turnLabelFull` / `turnLabelCompact` 的 `grid-area: 1 / 1`）：宽栏出整句文案、窄容器那一档
换成紧凑的 `#N`（轮号原值，与数据格的 `#N` 是两套编号）。外层那个 span 带 `aria-label`、
两枚内层 `aria-hidden`，所以读屏拿到的始终是整句。整轮折叠时摘要行也用同一对标签。

**种类徽章在同一档换成纯图标**（官方 `kindTagIcon` / `kindTagLabel` 那对）：七枚字形是
`icons.tsx` 的 `IconKind*`（`tool` / `subtool` 共用现成的 `IconWrench`，官方也是同一枚）。
宽栏的机制与官方一致——字形那枚宽 0、透明，被文字那枚挤出可视区，**不是 `display: none`**；
窄栏由容器查询把两枚对调，徽章固定 19px。文字那枚收到 0 宽而不是隐藏，所以读屏与搜索
仍拿得到种类词（徽章自己另带 `aria-label`）。
内容格：requestOnly 空；折叠摘要 = `…` + 单行省略（title 给全文）；否则单行省略正文，
**有结果时**换成 2 列 grid（左：工具名 + 参数，右：`→` 结果，error 变红）。
`message` 种类的标签走 `kind.assistant`（`kind.message` 只被上游那个**无人 import 的**
`TrajectoryCell.tsx` 引用，实际渲染的 `TrajectoryTable.tsx` 用的是 `kind.assistant`）。
行高常量：内容行 30 / 折叠摘要 20 / 终止边界 9。

**折叠一轮保留哪些行**（官方 `collapseTurnRecords()`，2026-10-04 对齐）：该轮的 system 行与
requestOnly 请求锚点行照常显示、**第一条内容行**也留着，摘要行只代表它**之后**那批
（`contentRecords.slice(1)`，与 `trajectoryTurnSummary()` 同一个切片）——不是整轮收成一枚
摘要行，那样会把提示词变更、上下文行、全场唯一的助手回复一起收掉。内容行不多于一条时整轮
一行都不收（官方 `contentRecords.length <= 1` 原样返回），`turnCollapsible()` 也按「内容行
多于一条」判。摘要行自己**不顶轮次标签**——留着的那条内容行已经顶着（`renderRow` 按
`trajectoryTurnStartsLabel()` 给），两行都挂就重了；它也不进选中与时间线（没有
`data-cell-index`），点它是展开这一轮。搜索期间不套折叠（官方 `filterRecords()` 那个分支）。

**轮次边界线**：一轮的第一行在事件格上画一条 2px 全宽线（`::before` + `translateY(-50%)`
骑在行缝上），两条取消规则与官方一致——整张表的第一行不画、「加载更早的历史」之后那一行
不画（它是分页控件，不是轮次边界）。事件格因此必须 `overflow: visible`（官方
`tr[data-turn-start] td` 同一条），否则标签底色与那条线都会被单元格自带的裁剪切掉。

**整行的无障碍名字**（官方 `request.rowAria` / `request.rowPrefix` /
`request.rowAriaCompaction`，2026-10-04 落地）：每行挂一句「请求 #N，种类，内容」，取值在
`trajectoryDisplay.ts` 的 `trajectoryRowLabel()`——读屏按行读时拿的是这一句，而不是把事件
格与内容格里那几枚碎片（轮次标签、`#N`、种类徽章、正文）逐个念出来。三个分支：请求锚点行
（`requestOnly`）走官方的专用句「请求 #N，压缩」；没有请求号时前半句整段省略；行文本为空
（仅工具调用那类）用「无内容」兜底。种类词与徽章同一个出处（`trajectoryTexts.kindLabel()`），
免得读屏念的种类与屏幕上看到的悄悄不一致。折叠摘要行挂的是 `collapsedSummary` 那一整句。
**键盘可达性同源**：请求锚点行与「工具目录只变了一项」那种说明行 `tabIndex` 为 -1（点开
也没有检查器内容，留在 Tab 序列里只会多停两下），其余行 0；折叠摘要行必须**可聚焦**并且
响应 Enter / Space——它是折叠态下唯一的展开入口，不给键盘一条路的话折叠一旦用键盘打开就
展不开了。

### 3.2.1 行文本的判据（只在一处实现）

官方「这一行显示什么」是 `TrajectoryTable.tsx` 的三支纯函数（`recordDisplayText()` /
`recordResultText()` / `isToolCallOnly()`）；本扩展的等价实现**只有一处**：
`src/webview/trajectoryDisplay.ts`（`trajectoryDisplayText` / `trajectoryResultText` /
`trajectoryIsToolCallOnly` / `trajectoryCellContent`）。

**预览文本的解析不是手抄的**：`trajectoryPreviewText` 来自 vendor 进来的官方
`trajectory-preview.ts`（mdast + GFM 语法，与官方渲染器同一套），从前那份 marked
近似版已删。极端嵌套语法（表格 / 列表 / 围栏代码 / 裸 HTML 混排）的投影因此与官方一致。

| 情形 | 官方 | 本扩展 |
|---|---|---|
| 没有正文、没有思考、**有**工具调用 | `record.toolCallOnly`「（仅工具调用）」+ 弱化色 | 同（`.trajectory-text.is-tool-call-only`） |
| 没有正文与思考、只有图片 | `layout.imageCount` | 同（宿主给 `emptySummary:{kind:"images"}`） |
| 有正文或思考 | 预览：去 markdown 记号、压平空白、读 2048 / 截 512 + `…` | 同（**同一份官方实现**） |
| 正文与思考都有 | 取正文 | 同 |
| 有附件 | `附件摘要 · 正文预览`（`layout.imageCount` / `layout.fileAttachments`） | 同（宿主给 `attachments:{images,files}`） |
| 什么都没有（已结算） | `'—'` | 同 |
| 流式占位行 | 官方是流式正文（`partial`） | 留空（本扩展没有流式正文，刻意差异） |

**每类记录的行文本都由官方那支函数拼**（宿主不再预截 160 字摘要）：

| 种类 | 官方的 `text` / `previewMarkdown` |
|---|---|
| `user` / `context` | `text` = 附件摘要（本地化），`previewMarkdown` = **首个文本块原文**，`inputDetail` = 全部文本块按 `\n` 连接 |
| `tool` / `subtool` | `text` = 工具名，`previewMarkdown` = 参数原文 → 列表侧拼成 `name · preview(args)` |
| `message` | `text` 只在「正文与思考都没有」时才有值（语义见上），正文/思考分别进 `previewMarkdown` / `outputDetail` / `thinkingDetail` |
| 工具目录变更（`context`） | 单条 → 「已添加工具：X」/「已移除工具：X」；多条 → 「工具已更新 · 新增 3 个」（或「新增 2 个，移除 1 个」/「移除 2 个」）。宿主给 `toolUpdate:{added,removed}`，文案由这一层拼；「原始」页签是官方那份 `inputDetail`（「新增：a, b」/「移除：c」两行） |

三条别忘的口径：

1. **「没有正文」不等于「仅工具调用」**。判据是「没有正文、没有思考、**有工具调用**」
   三条同时成立（`trajectoryIsToolCallOnly`）。曾经写成「已结算且 `text` 为空 →
   仅工具调用」——真实会话日志 45486 条助手消息里有 16649 条（36.6%）被这么误判，
   其中绝大多数是**只有思考没有正文**的行（官方那时展示思考摘要）。
2. **宿主只给语义、不给文案**。官方那份折叠跑在浏览器里，`cell.text` 直接就是本地化
   文案；本扩展的折叠跑在扩展宿主（不知道界面语言），所以 `TrajectoryCell` 用
   `emptySummary`（`layout.toolCallOnly` / `layout.imageCount` 的语义）、`attachments`、
   `resultSummary`、`toolUpdate`（`layout.toolAdded` 一族）与 `promptChange`
   （`RequestPromptChange.kind` 的四种情形）这类标记，文案一律在
   `trajectoryDisplay.ts` 取。
3. **口径要能被真实数据对拍**。`npm run build:scripts && node build/trajectory-align-probe.mjs`
   扫本机 `~/.dsh/sessions` 的全部会话日志，逐条 `assistant/message` 比「本扩展渲染的
   那一行」与「按官方规则算出来的那一行」，有错配就退出 1（`--verbose` 打样本）。
   合成夹具发现不了分布问题：只有思考没有正文的助手消息占三成以上，是最大的错配来源。
   **改这一层之前先跑一遍拿基线。**

### 3.3 详情检查器

出现条件：选中了记录或请求。宽度 `clamp(320px, 38%, 440px)` 初值、可拖 320–720，
窄屏（≤760px）变右侧抽屉。页签按记录种类分派：

- **标题是「种类标签 + 落点」**（官方 `detailsTitle`）：种类那一枚与账本行同款配色，
  落点是 `第 M 轮 · 第 K 步`（组标题取自折叠层的语义，见 3.8）。**压缩记录只给轮次**
  （官方那一支就是 `sectionLabel`，不给组）。请求级检查器的标题只有 `请求 #N · 第 M 轮`
  ——官方在那一支**不拼组**，这一条本扩展本来就一致。标题里**没有**记录序号：官方实际
  渲染的那份表里没有它（只有无人 import 的 `TrajectoryCell.tsx` 才画 `#N`）。

- `system`：提示词正文 + 工具目录；带 `previous` 时多一个 diff 页签。**那个页签是行级差分**
  （官方 `PromptDiffSection` 同一套）：`structuredPatch`（`diff` 包，`context: 3`）出
  `@@ -a,b +c,d @@` 头 + 逐行 `+` / `-` 着色，system 与工具目录各一节，**两段相同的那一节
  整节不渲染**。行序列在纯模块 `src/webview/trajectoryPromptDiff.ts` 里（可离线断言），
  渲染在 `components/PromptDiff.tsx`。工具目录那一节的对照要**改动前 vs 改动后**
  （宿主的 `previousPromptTools` + `toolsDetail`），只有一份时**不出这一节**——
  拿改动前的 system 去比改动后的 tools 是错的对照；
- `compacted`：概述（状态 / 时长 / Token 固定 `—` / 原始输出 markdown）；
- markdown 记录（user/context/message）：概述 + 预览 + 原始内容（有 messageSource 再加来源）；
- tool/subtool：概述 + 参数 + 结果 + Schema + 计时。Schema 吃的是**这次调用当时**记下的
  那一份（`cell.schemaDetail`，与官方 `attachToolSchema()` 挂在调用格上的是同一件事实），
  不是回查「这一行之前最近的工具目录」——那个回查在目录变更过之后会给出错的那一份；
  **PTC（`run_code`）那一支两处不同**（官方 `detailTabs()` 现判 `codeProgram(cell)`）：
  参数那一格改叫「代码」、正文换成源码；**结果那一格即使还没有结果也出**（判据是
  `outputDetail || 代码程序存在`）。见 5.2 的「检查器与跳转」；
- 请求级检查器（官方 `REQUEST_TABS`）：概述 / 选项（仅 `requestConfig` 存在时出现）/ 用量
  （本次 + 会话累计）/ 计时。**主入口是账本行左端那枚请求边界小标记**（官方
  `requestBoundaryControl`：只画在请求的第一行、绝对定位到行缝之间，悬停浮出「请求 #N」），
  不是行本身——点行看单条记录，点标记看整次请求，两个入口互斥；另一个入口是助手记录概述
  里那节「请求计时」（它**指定页签**开在「计时」上）。计时面板**与记录面板同源**
  （官方 `RequestTiming` 的第一分支）：该请求有助手记录时整块就是记录级那一份（开始时刻 /
  总时长 / TTFT / 生成 / **吞吐量**，每个值各自判缺哪一种证据、回落各自的「不可用」，而不是
  一句笼统的「未记录」）；拿不到助手记录才用请求表那三行（开始时刻 / 时长 / 计时来源），
  且「计时来源」只在页签里出、概述那一节是缩略（官方 `preview`）。数据来自
  `TrajectoryModel.requests`（见 5.1），**不在账本行上复制一份**；
- **时刻那一格可切换显示形态**（官方 `StartedAtValue`）：本地 `YYYY-MM-DD HH:MM:SS.mmm`
  ↔ Unix 秒（`.toFixed(3)`），悬停说明是「点了会怎样」而不是「现在是什么」；点在有选区
  上不算点击（官方 `clickSelectsText`，见 5.1）。**只有绝对时刻那一格可以切**——
  「首 token 延迟」是**时长**（首个 token 相对步骤开始），跟它同排的「总时长 / 生成」
  一样是时长，不是时刻。
- 记录与请求之间有**双向**跳转：助手记录 →「请求 #N」、工具 / 子工具记录 →
  「助手消息」（按 `callIds` 认，认不出就不给）、请求面板 →「这次请求的记录」、
  助手记录概述里那节「请求计时」→ **该请求的计时页签**（唯一一处直接落在页签上的入口，
  见 5.2）；
- 概述页是**直接摊开的卡片**（官方 overviewSections）：工具 = 参数/结果/Schema/计时，
  markdown = 预览 + 请求计时，压缩 = 摘要正文，请求 = 用量 + 计时；分节标题可点，
  点了切到对应页签（「请求计时」那一节点开的是**另一个检查器**的页签）；
- 切记录时优先保留仍可用的旧页签（tabHistory）。

### 3.4 时间线

固定顶部概览条（绘图区高 50px，左侧泳道标签列 44px）。**分组按记录（cell），不按
轮次**；泳道 `laneFor`：tool/subtool → 2，message/compacted → 1，
system/user/context → 0。四种模式的域：`sequence` 每条可见 cell 占 1 单位；`duration`
用真实毫秒宽并**扣掉操作之间的空闲**（并发区间**保持重叠**）；`actual` 用真实毫秒宽且
保留空闲；`time` 每条宽度归零（等时长）。`startedAt` 非有限的时间段整条不进时间线。

**这套投影是官方实现本身**：`deriveTrajectoryTimeline` / `deriveTimedTimeline` /
`trajectoryTimelineFocusIndexes` 逐字 vendor 在 `src/vendor/ui-trajectory/timeline.ts`，
`src/webview/trajectoryTimeline.ts` 只做「我们账本 → 官方形状」的适配 + 把绝对域
归一化成 0..1。**轮次边界与条必然同一套坐标**（不再是两份算法）；从前那份等价实现
曾在 `duration` 分支拿原始 Unix 毫秒当域值（量级差 1e6 倍），渲染端的域内过滤把每
一根边界都丢掉——「时长」模式下概览条一根轮次线都没有。

交互（本扩展的实际行为）：

- 左键拖 = 选区（**位移 < 3px 算「点一下」**，官方 `MINIMUM_DRAG_PX`）；右键 = 手势，
  无论是否缩放都接住——**拖动 = 平移**（仅已缩放时有位移），**轻点不拖 = 清选区**
  （官方 `onPointerEnd` 的 `if (!moved) onRangeChange(null)`）；
  **`contextmenu` 无条件 `preventDefault`**——右键在这条时间线是手势，
  只拦 `zoom>1` 会弹 VS Code 菜单、看着像「拖不动」；滚轮以光标为锚缩放
  （`exp(deltaY*0.0015)`）；
- **缩放的上下限**：下限 1（全部铺满，不缩到看不全）；上限由官方的**绝对最小窗口**
  推出——`sequence` 4 条操作、其余 20ms，所以 `maxZoom = 域跨度 / 那个绝对值`
  （`sequence` 的域跨度就是可见格数，其余是毫秒）。长会话因此能放得比旧版深得多
  （从前写死 100 倍）；
- 拖动期间**拖到左右 8% 边缘区会自动平移视口**（官方 `EDGE_PAN_*` 三常数：边缘区
  最多 32px、每次指针移动挪 2.5% 视口跨度、按离边缘的远近缩放强度，最远处保留 20%）；
  移动与抬起监听挂在 **`document`** 上，所以**拖出绘图区继续框选**（官方用
  `setPointerCapture`，本扩展用 document 监听达到同一目的——用 pointer capture
  会把 click 重定向到容器，span 的选中就点不动了）；
- **点空白** = 给一条最小选区（`min(视口跨度, 1/记录数)`，居中于点击处）并聚焦最近的
  记录（官方同款；从前点空白完全没反应）；**点 span** = 清旧选区 + 选中该记录，
  并把账本滚过去（目标行**顶边**对齐视口顶——用户 2026-09-15 二次口径）；
- **Escape**（概览条可聚焦）清选区与选中；双击 = 清选区，已无选区时复位缩放；
- **选中的条会留在视口里**：选中变化时若它不在视口内就平移过去（**只有这一种视口变化
  走 180ms 过渡**，官方 `animateViewport` 同口径；滚轮/平移/边缘自动平移都显式关掉），
  且**始终保留选中条**（落在视口外的条不渲染，选中那条例外）；
- **搜索联动**：命中集合来自搜索索引，未命中的条压暗到 14%（官方同值）；
- **光标跟随竖线**（官方 `hoverLine`）：标出鼠标指的时间点；**指在某条记录上时不画**
  （官方同一条件 `hover.recordIndex === null`），那时改由**高亮环**表达
  （两圈 `box-shadow`：内圈底色调、外圈强调色）；
- 等宽条之间让出**缝隙**（`min(宽度 × 0.08%, 1px)`，官方同式）；助手条上有
  **TTFT / 解码两段渐变**（分界 = `ttft / (ttft + decoding)`，两个时长都取到才有）；
  `time`（等时长）模式的条定宽成方块（官方 `data-equal-duration` 的 8px）；
- 选区画**本体 + 两枚把手**：本体是强调色 12% 的淡底、两侧各铺一条 100vw 的
  `box-shadow` **把域外压暗**；把手是两端各 3px 的强调色竖条（官方 `.selectionEdges`）；
- 左端 `…` = 加载更早（只要宿主说还有更早历史就显示；官方仅视口贴住全域左端时显示）；
- span tooltip 是原生 `title` 单行：种类 · 开始时刻｜总时长 · 首 token/解码——**不显示
  起止区间**（官方显示），`startedAt` 为空时那一格是空串；
- 「时长」开关**持久化**在 `localStorage` 的 `dsh.trajectory.duration`（官方那份是
  浏览器级偏好，语义对应）；本扩展另多一颗官方没有的「复位缩放」按钮；
- 缩放平移后选区比较发生在归一化域（见 2.4 的坑）；归一化是单调线性变换，
  官方那条含端点的区间相交判据在归一化坐标下逐字等价。

### 3.5 默认展开与定位

默认**全部展开**、不选中任何记录、页签初值概述；账本默认锚到底部（`anchorTo:"end"`），
且仅贴底（阈值 2px）时继续跟随新行。官方在 records > 100 或还有更早历史时启用虚拟化
（overscan 12 行）——本扩展用**同一组数**（实现细节与两处踩过的坑见 5.2 的「账本虚拟化
已对齐」）；零高的 requestOnly 行官方是挂到下一条内容行上，那是它那套虚拟列表的内部
处理，本扩展的等高垫行方案不需要这一步。跨视图定位 `inspectCallId`（官方
`viewRequest.focus`）：命中前把目标行强留进窗口，命中后展开并滚过去——**已做**（见 5.2
的「从对话跳进轨迹」）。**时间线（概览条）无条件渲染**：一条记录都没有时就是官方的空态
形态（三条泳道 +「没有计时数据」+ 按历史出不出「加载更早」）。

### 3.6 搜索索引

**索引本身也是官方实现**（vendor 在 `src/vendor/ui-trajectory/trajectory-search-index.ts`）。
官方 `recordSources` 的字段清单：轮次（`turn N` / `between turns`）、分组标题、kind
（message 记成 `assistant`）、`text`、`previewMarkdown`、input/output/thinking/schema
四个 detail、`result`、`resultPreviewMarkdown`、`callId`、sourceBlocks/outputBlocks
每块的 `type/content/callId/toolName/attachment.name`，再加 `messageSource` 与两个
promptDetail 的 JSON 串；匹配 = 全部字段 join 后 `toLocaleLowerCase()`，按空白切词、
**全部词命中**才算（AND），空查询返回 null；`requestOnly` 行**不进索引**；身份是
`trajectoryRecordId`（稳定，前插历史不串行）。预览截断走
`trajectoryPreviewText`（2048 → 纯文本 → 折空白 → 512 + `…`）。

呈现**与官方一致**：账本在搜索期间是**过滤**（只留命中行，且官方此时**不套用**
轮次/调用折叠——被折叠收走的工具行也照样看得见），时间线把未命中条压暗到 14%。
索引重建**节流 3 秒**（官方 `SEARCH_INDEX_THROTTLE_MS`），按引用同一性跳过无变化的重建。

上面字段表里**每一个字段现在都有输入**（2026-10-04 补齐 `schemaDetail` 与助手行
`sourceBlocks` 之后）；各字段的采集口径与「哪些字段刻意不采」见 5.2 的「搜索」那条。

### 3.7 纯决策模块的 vendor（来源与同步）

轨迹这一页有若干处「一行显示什么 / 参数那一格显示什么 / 时间线怎么摆 / 搜索怎么匹配」的
**纯决策**，它们现在是上游源码的**逐字副本**，放在 `src/vendor/`：

| vendor 文件 | 用在哪 |
|---|---|
| `ui-trajectory/trajectory-preview.ts` + `ui-primitives/markdown/*` | 预览文本（`trajectoryDisplay.ts`） |
| `ui-trajectory/trajectory-record.ts` | 「调用折叠」的稳定身份 `trajectoryRecordId`（`trajectoryVendor.ts`） |
| [trajectory-turn-model.ts](<../src/vendor/ui-trajectory/trajectory-turn-model.ts>) | 账本 → 官方形状的 `TrajectoryTurnModel`／`TrajectoryGroupModel`；固定 `layout.ts` 类型摘录 |
| `ui-trajectory/timeline.ts` | 时间线的四模式投影（`trajectoryTimeline.ts`） |
| `ui-trajectory/trajectory-search-index.ts` | 搜索（`Trajectory.tsx`） |
| `ui-trajectory/inbox-state.ts` | steering 分类（`dsh/trajectory.ts`）——官方 `trajectory-inbox-next-step` 的纯状态机 |
| `ui-trajectory/code-program.ts` | PTC（`run_code`）的代码程序（`trajectoryDisplay.ts` 的行文本、`Trajectory.tsx` 的「代码」那一格） |

**不要手改这些文件**：来源包、版本、每一处允许的偏差、以及「上游升级时怎么重新 diff」
都写在 `src/vendor/README.md`。要点两条：

1. **契约告警与源码漂移分开**：`dsh:watch` / `dsh:check` 仍只追踪消费的服务端契约包，
   不检测官方 UI 单独变化。正式[来源锁](<../scripts/vendorSourceLock.ts>)与[离线回归](<../scripts/vendorSourceLock.test.ts>)
   双向校验 11 个文件集合、固定 tag／commit、原文字节与规范化摘要；完整上游见证在
   [固定来源目录](<../test/fixtures/vendor-sources/README.md>)。
   只允许 import/export 模块说明符适配及注释／排版漂移，不归一普通字符串、模板、正则或 ASI。
   更新来源锁是显式同步动作，不是自动联网升级；自洽校验也不是外部认证。
2. **适配层是唯一的接缝**：`src/webview/trajectoryVendor.ts`（账本 → 官方形状）与
   `trajectoryTimeline.ts`（归一化）。官方若给 `TrajectoryCellProps` / `TrajectoryTurnModel`
   加字段，改这里、不要改 vendor 文件。

代价：webview 产物多约 85 KB（mdast + micromark 系依赖的单独打包实测）。

### 3.8 两处结构性的「没有 vendor」

- **账本的 turn → group 分组**（官方 `layout.ts` 的 `TrajectoryGroupModel`）：官方那份实现体
  需要 `ui-conversation` 折出来的 `TrajectorySnapshot`，我们没有那一层——所以**在自己折叠层里
  按官方同一套推入规则折**（`pushMessage()` / `pushStep()` / 压缩自成一组），而不是搬那份实现。
  组标题在宿主侧只给**语义**（`TrajectoryGroupTitle`），文案在界面侧取。**官方不渲染组头**：
  `TrajectoryGroupHeader` / `TrajectoryTurn` / `TrajectoryTurnHeader` / `TrajectoryCell`
  四个组件在上游**无人 import**，`index.ts` 也不导出，`data-group-start` 属性没有任何 CSS 用它
  ——组结构在官方界面上只落地成**记录检查器的落点**（`第 M 轮 · 第 K 步`）与**搜索索引的组标题字段**，
  所以本扩展同样不画组头与轮次表头四列（画了反而偏离）。
- **流式助手行**：官方 `appendTrajectoryPartialLayout` 依赖 `PartialAssistant`，本扩展的叠加层
  语义不同（映射错会出重复行），继续只出「正在生成」占位行。

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

折叠层 `src/dsh/trajectory.ts`（账本 turn → group → cell + **请求表** + 请求编号 + 重试进度 +
assistantMetrics + steering 分类与落组）；
类型 `src/shared/trajectory.ts`（cell / **group** / turn / **request** + 域坐标互逆换算）；
**vendor 的官方纯决策**（`src/vendor/`：预览投影、`recordId`、时间线、搜索索引、
**inbox 状态机**，见 3.7）；
界面 `src/webview/components/Trajectory.tsx`（工具栏 / 账本 / 时间线 / **记录级与请求级两个
检查器**，含时间线滚轮缩放与右键平移、选中自动滚视口、Escape、hover 竖线、检查器拖宽与
窄屏抽屉、时间线 → 账本联动定位、运行中占位行、搜索过滤与时间线压暗、请求边界小标记）；
检查器里每段原文的呈现件 `src/webview/components/TrajectoryPre.tsx`（复制 + 自动换行）
与其换行偏好 `src/webview/trajectoryPre.ts`；
行文本与结果文本 `src/webview/trajectoryDisplay.ts`；文案 `src/webview/trajectoryTexts.ts`；
断言 `scripts/trajectory.test.ts` / `trajectoryDisplay.test.ts` / `trajectoryVendor.test.ts` /
`trajectoryPre.test.ts`。
数据链路是**拉取制**：视图开着时运行中每 3 秒发一次 `listTrajectory`、停下后再取一次
收尾（视图关着不发；会话 id 进依赖，切会话必重取）；宿主现折全量事件，整份模型走
`{type:"trajectory", json}` **JSON 字符串帧**——账本里 `timeSeconds/startedAt` 的
`null` 是有意义空值，整体字符串绕开了「undefined 键被 JSON 丢掉」的线格式坑。

**请求表**（`TrajectoryModel.requests`）承载官方 `RequestView[]` 的请求事实，与账本在**同一次
遍历**里折出来：`step/start` 开一次请求并给出 `startedAt`（**不是** `assistant/message` 的
`data.startedAt`——那个字段真实日志里一条都没有，438 份日志 3503 条助手消息零命中，
照它读会让 `assistantMetrics.timingRecorded` 恒为 false、计时面板永远「未记录」）、
`request/header` 给选项与提供方/模型、`llm/retry` 给重试进度与失败（文案过
`displayFailure()`，`AUTH` 码下清空）、`assistant/message` 给用量/首 token/身份并结算、
`compaction/*` 同样占号入表。账本行只带 `requestNumber` 一个号，请求级事实不复制到行上。
助手请求按 `turn:step` 稳定身份查找，压缩请求独立记账；同一步 overflow 压缩不会替换
原助手请求，后续助手结算仍使用自己的开始时刻、用量、选项和请求号。**帧带了身份而表里没有
那一步时谁都不写**（`assistant/message` / `llm/retry` / `assistant/attempt` 同一口径）：官方
那一步没有 `step/start`，`assistantRequest()` 的 `!state.started` 就说它没有请求；回落到
「最后开的助手请求」会把用量、收尾时刻、状态与身份写到另一个步骤的请求上，那一行也不该挂上
别人的请求号。只有帧自己没带 `turn`/`step` 的畸形帧才退回窗口当前步。步骤关闭
（`step/end` / `turn/end`）之后到达的 header 不回写该步请求。累计用量在事件折叠结束后按请求
顺序逐个相加，不按结算帧到达顺序累加。回归在[轨迹断言](<../scripts/trajectory.test.ts>)的
overflow 恢复、pre-step 压缩与多步多次压缩场景。

请求配置由 `effectiveHeader` 保存最近生效的整份 header；`step/start` 为新助手请求继承该配置，
本步新 header 再通过 `applyHeaderConfig` 整份替换，不逐字段保留旧值。header 的归属按**事件落点
步骤**（`locationStep`，官方 `ConversationLocationIndex` 口径）：落点在某一步上就整份替换那一步
助手请求的配置——**含「该步助手消息已结算、`step/end` 还没到」这种时序**（官方 `headersByStep`
是预扫描，助手消息结算不等于步骤关闭，落点仍在这一步的 header 就是该步最新配置）；落点不在
步骤上（两步之间、轮次已收尾）则谁都不回写，只作为后续请求继承的配置。空／不可读配置同样让配置
整份失效。窗口没有 header 时不从结算帧的提供方／模型倒推选项。

**配置与身份是两类事实**：`request/header` 只给配置（`options` 整份替换；`provider` / `model`
仅在还没有身份时兜底），`assistant/message` 的 `message.source` 给的是请求自己的身份（官方
`providerMetadata`），逐字段优先——某个字段一旦由结算帧给出过，后到的 header 不许覆盖它；
用量、收尾时刻、状态与重试事实同样不受 header 影响。回归在同一份轨迹断言的 header 继承、
当前配置替换、步骤间配置、截断窗口、空配置，以及晚 header 的三组（结算之后到达、落点不在
步骤上、晚到的空 header）。

尚未关闭的边界：本批只定配置（`requestConfig` 等价物）与身份的归属口径，不同时声明
prompt／promptChange 的官方接线、截断窗口兜底或整页交互已经完成对拍；晚 header 那三组是契约级
断言，没有真实日志对拍样本。

**每一行都要挂得上请求**（包括「调用在窗口之外、只有结果」那种补出来的行——全量扫描
438 份日志时正是它成了唯一一条没有请求号的行）。请求状态与重试事实分开，按官方
`assistantRequest()` 的三分支派生：非中断的助手结算 → `complete`；否则重试或边界（步骤、轮次
已关闭）任一成立 → `error`；两者都没有 → `running`。**中断的助手消息本身不是失败证据**——它
只在重试出现或步骤／轮次关闭之后才让请求判失败，在那之前这一次请求仍在跑（`completedAt` 已由
节点给出，时刻与状态是两条独立判据）。账本行上的「被中断」是另一件事（那一行照旧按
`@interrupted` 标失败）。没有成功结算的请求在步骤或轮次边界收成 `error`。补收尾时刻不按状态筛，
已被重试标为 `error` 的请求也要补齐 `completedAt`，已有结算／步骤结束时刻不被后来的轮次边界
覆写。

官方 `closedBoundary()` 有三种边界来源（状态机看见的 `step/end`、位置索引里已关闭的步骤、
已关闭的轮次）；本扩展每次**全窗口重折**，前两种在窗口里都由 `step/end` 直接落到该请求上，
第三种由轮次收尾后处理覆盖，因此不再区分「状态机是否看见过 `step/end`」。

`turn/end.reason` 按官方结构化联合读取，正常完成为 `completed`；只有 `kind === 'error'`
提供轮次失败事实，由 `turnEndings.failed` 肯定记录，不从文案非空或错误码存在反推。轮次错误
覆盖该轮最后助手请求的终态诊断，不影响其他轮、更早请求或压缩请求。终态 `AUTH` 经
`displayFailure` 清空文案，在公开模型中表示为 `error` 缺席，必须真正清除此前重试留下的文案。
**同一轮可以有多条 `turn/end`**（官方那份 contribution 的 id 是事件 seq，逐条进
`turnEndings` 列表、由 `applyTurnErrors()` 逐条处理），所以收尾事实按「逐条累积」记：失败收尾
整整覆盖文案（空文案 → 缺席）、错误码有值才换，**非失败收尾只推进边界时刻、不撤销已积累的
失败证据**；边界时刻取该轮最后一条 `turn/end`。回归在同一份轨迹断言的 retry 成功、失败边界、
中断消息的中间态、同轮重复 `turn/end`、结构化轮次错误、AUTH 诊断覆盖与尾部压缩隔离场景。

**重试重置与保留差异（2026-10-09）**：官方 `llm/retry` 把步骤状态整份重置，仅保留首 token
与用量。本扩展的**请求表**已采用该语义：旧 final 的收尾时刻清为 `null`，诊断整份替换（AUTH 清
文案但保留码，无码清旧码），身份与已结算身份标记清空后只用**该请求自己**最后生效的 header 配置
兜底，不套别轮当前 header；重试上限仅普通模式保留。新的 final／收尾边界可重新结算。
按「每次结算各出一行」的既定口径，**历史账本行**仍保留每次结算事实，不随请求状态回溯；流式正文
仍是占位差异。旧 `step/end` 后再 retry 的 durable 不可达契约边界未补官方位置索引闭合分支，不声称
等价。正式 16 条与主代理独立诊断九组合等 17 组覆盖列明边界；没有真实样本／IPC／整页对拍证据。

**一段原文的呈现**（`src/webview/components/TrajectoryPre.tsx`）是检查器里那十几处裸
`<pre>` 的**唯一落点**：动作条（自动换行开关 + 复制）在正文**上方占一行**，正文按
`data-wrap` 在 `white-space: pre`（默认，官方 JSON 树打底同款）与 `pre-wrap` + `break-all`
（官方 `[data-wrap='true']` 同款）之间切；换行偏好在 `src/webview/trajectoryPre.ts`
（`localStorage` 的 `dsh.trajectory.jsonStringWrapping`，与官方那个 store 同名），
口径是**渲染时采样一次的全局默认 + 各自可拨**（官方每个 `ProgramInput` 各自 `useState`），
且**只有拨开关才落盘**。动作条刻意不做浮层：早先的绝对定位版会把两颗按钮压在正文首行上
（「不换行 + 长首行」是最常见的形态）。概述页里那几节仍只露开头（外层滚、正文 `overflow: hidden`）。

**Tier A 的四项对齐**（2026-10-04，逐条对着官方源码核过）：
1. **首个 token 时刻的两条来源**：`assistant/attempt` 与 `assistant/message` 都按官方
   `isTokenDelta` / `runFirstTokenTime` / `assistantStreamFirstTokenTime` 读取 `data.stream`，
   不是任取第一帧的时刻。raw `chunk` 只计合格 delta；packed 文本、思考与工具参数按
   `time0 + Σdt` 找首个非空片段，工具 delta 有 `name` 即计 token（raw 空名字也算），
   空白文本不是空片段。两条来源**先到者胜**，不是取最小时刻；晚到 attempt 补首 token 时，
   请求与助手记录同步，明确指向其他步骤或轮次的 attempt 不回落到当前请求。
   正式回归在[轨迹断言](<../scripts/trajectory.test.ts>)的首 token 官方读法场景，包含
   开始 1000、非 token 1100、真 token 1700、结算 2000 的 TTFT 700／解码 300。
   帧带了身份而请求表里查不到那一步时**谁都不写**（官方 `fallbackState()` 用该身份自己的事件
   重建 `started: false` 的状态，`assistantRequest()` 的 `!state.started` 就是「那一步没有
   请求」；官方那时仍发布助手节点，只是 `timing.stepStartTime` 为 null）——`assistant/message`
   与 `assistant/attempt` 同形，越界帧的记录行取**帧自己的**坐标且不挂请求号；只有帧自己没带
   `turn`/`step` 的畸形帧才退回窗口当前步。重试徽章与请求表按**同一帧身份**记账；显式身份
   没有请求时不借当前步的徽章。无请求的步骤也按身份保留首 token：attempt／message 先到者胜，
   后来的合法 token 回填该身份已经产出、首 token 仍空的记录；重复结算及乱序结算不跨身份，
   已结算步骤不再补「正在生成」占位。
   **适配边界加强**：官方 stream readers 信任静态类型，本扩展对未知输入只认字符串片段与
   字符串工具名字（空串名字、空白正文仍合法），跳过缺字段／非字符串成员；这不是官方非法
   输入等价。正式回归覆盖 raw／packed 非法形状、缺 step/start、重复／乱序结算与晚 token
   同步，共 27 条列明判据；不是整页或所有可能截断窗口的穷尽证明。
2. **会话边界中断压缩**：`session/end-seed` 之前仍在 `running` 的压缩请求以
   `error` + 合成码 `trajectory.compaction-interrupted` 收尾（官方
   `interruptCompactions()`，常量在 `src/shared/trajectory.ts`，界面据此取那句专用文案）。
3. **检查器的双向层级跳转**：助手记录 →「请求 #N」；工具 / 子工具记录 →「助手消息」；
   请求面板 →「这次请求的记录」。工具到助手那条**按 `cell.callIds` 认**——助手消息的
   `tool-call` 块身份在折叠时摘出来（`callIds` 是轻量形态，界面只读它；同一份块也进了
   `sourceBlocks`，那里另有官方式的 `callId` / `toolName`，见 5.2）；认不出就不给链接。
4. **时刻可切换显示形态**（官方 `StartedAtValue`）：本地时间 ↔ Unix 时间戳，
   见 3.3 那一节。

**Tier B 的两项对齐**（2026-10-04 同轮，与官方 `0.2.0-rc.2` 源码逐条核过）：

1. **steering 分类**：`agent/inbox/spliced(target='next-step')` 喂官方那台状态机
   （`src/vendor/ui-trajectory/inbox-state.ts` 是逐字副本），人发消息的 id 命中
   **本次领取集合**即为 steering。界面上它与真用户消息**没有标签差异**（官方 cell 层同样
   是 `kind: 'user'`），差别只有**不置 `opensTurn`**——这一点连官方都是如此。

   > 落地前用两份零 token 探针量过（`trajectoryShapeProbe` 442 份日志 /
   > `trajectoryAlignProbe` 377 份日志）：
   > - `inserted[]` 元素 **全部**带 string `id`，官方 `.map(x => x.id)` 直译安全。
   >   「一半的 insert 没有 id」是把**帧数**当**元素数**读出来的错觉——5539 条 splice 帧里
   >   2615 条的 `inserted` 是空数组，那些帧贡献 0 个元素。
   > - **必须按 `target === 'next-step'` 过滤**（官方 `match` 的语义）：只吃 next-step 时
   >   1685 条人发消息里 **155 条（9.2%）** 归 steering；把 `next-turn` 也喂进同一台状态机
   >   会得到 85%，显然不是官方语义。
   > - 领取集合装的是**被移除**的那批 id，不是 `inserted` 的那批（搬反会让 85% 的人发消息
   >   变成 steering，而界面上两者长得一样）。
   > - 折叠层与对拍探针里各跑一遍同一串原始事件，**逐条零错配**。
2. **steering 落组**：官方 `steeringPlacement()` 的两条分支都照搬——领取发生在某一步
   进行中（落点就是那一步）就放那一步的组，否则放**它之后那条助手消息**所在的步骤组
   （领取写在两次 `step/start` 之间，所以后者才是日常形态）。落点步骤的判据照抄官方
   `ConversationLocationIndex`：`step/start` 置、**`step/end` 在收尾那一步上清**、
   `turn/end` 全清（与 `currentStep` 的差别只有 `step/end` 这一条）。落点以 durable 事件 `seq`
   关联，不以会被系统行前插与历史前插重编号的显示 `index` 关联；同号轮次只保留一个段，避免
   初始系统行把同一轮拆出空壳。回归在同一份轨迹断言的系统行前插、历史前插及相邻领取场景。
   初始系统行按官方 `firstVisibleTurn()` 归轮：当前助手贡献与当前 partial 中最小的正轮号，
   缺少候选时为 1；不把每个已开始步骤或 retry 失效的旧 final 当当前助手贡献。
   系统**更新**行按 `enclosingPromptTurn()`：依 seq 找随后第一条 `step > 0` 的当前助手节点，
   否则当前 partial 的轮号或 1，不取 `currentTurn`，也不是取随后节点最小轮号。
   retry 在有 start 的身份上撤销旧 final／partial；孤儿 fallback 不重放 retry。
   已闭合且有块证据的身份贡献中断节点 `boundary.seq - 0.9`（文本／思考须非空白，工具块包括空块
   都是证据，同 index 重建／block-end 替换会撤销旧证据）；重复 step/start 不重建该身份流状态。
   历史账本行仍按逐次结算保留，而布局判据只看当前贡献，二者不是同一张表。
   正式[轨迹回归](<../scripts/trajectory.test.ts>)覆盖跨轮更新、无 start partial、retry 生命周期、
   步骤／轮次闭合、块覆盖与重复 start；代表性边界不是全部输入穷尽。
3. **账本 turn → group 分组**：见 3.8。组标题（`消息` / `第 K 步` / `压缩 N`）是用户可见
   文案，宿主只给语义、界面侧取词。
4. **记录检查器的标题**改成官方的「种类标签 + 落点」：`助手` + `第 3 轮 · 第 2 步`
   （压缩记录只给轮次，官方那一支就是如此）。从前这里写的是 `#12 助手`——那是官方
   **无人 import 的死组件** `TrajectoryCell.tsx` 的形态，不是它实际渲染的样子。
5. **轮次折叠摘要的步骤数**改成官方口径：只数**带请求的步骤组 / 压缩组**，不数消息组
   （判据与理由写在 `trajectoryDisplay.ts` 的 `trajectoryTurnSummary()`）。
6. **搜索索引的组标题字段**从此有值（索引本来就是官方那份，现在喂进去的是真组标题）。
7. **轮次标签的落点**改成官方口径：落在这一轮**第一条像样的记录**上（跳过 `requestOnly` /
   `system`，轮内压缩行也跳过），见 3.2 与 `trajectoryDisplay.ts` 的
   `trajectoryTurnStartsLabel()`。
8. **prologue 并入改成无条件**（官方那一支不看 turn 0 里有什么）。本扩展在**建组之前**把
   `turn === 0` 的记录改号成 1，于是按显示顺序建组得到同一段、段号是 1；官方是删掉 turn 0
   的桶、把它的**组**拼在 turn 1 自己的组**之前**。两种排法只在事件自己带 turn 0 的构造输入
   下不同（实测 378 份日志里含 0 号轮的是 0 份）：官方那个角落里系统行不再是摊平后的第一行，
   本扩展保住「初始提示词永远第一行、摊平顺序 = 显示序号」这条不变量。
9. **「轮次起点那一族视觉」三条一起落地**：① 轮次首行 2px 全宽分隔线（含两条取消规则）；
   ② 轮次标签绝对定位到事件格左上、与 `#N`/kind 标签同一行（事件格预留 `padding-left: 36px`）；
   ③ 窄容器那一档换成紧凑形态：标签出 `#N`、种类标签出**纯图标**（`KIND_ICON` 七枚已补进
   `icons.tsx`，按本仓库图标家族口径重画，见该文件那一族 `IconKind*` 的注释）。详见 3.2。
   紧凑形态与事件列收窄**挂在同一条容器查询（420）上**——照官方另加一条 620 会让
   420~620 之间出现「列还宽着、标签已经缩成 `#N`」的中间态（试过，比不改更差）。

**2026-10-05 收口的四项**（细节都在 5.2 对应那几条里）：压缩行的思考进 `thinkingDetail`、
「来源」页签补标题、概览条无条件渲染（空态形态）、请求面板的计时改走记录级面板
（连带把记录面板本身对齐到官方 `RecordTiming`）。

### 5.2 差异管理与验收

> 下列 2026-10-03～05 的全库数字是历史调查，保留用于解释当时的产品决策；
> 原临时脚本与旧读取口径不构成当前可复现基线。当前只准入三份明确授权的停止源，
> 新统计／完整夹具／整链量测机制见「当前可复现验收边界」。不为复现历史全库数字扩读其他日志。

**形态差异、功能缺陷与证据缺口分别管理。** 请求结算、配置继承、首 token 计时、
稳定归属、搜索折叠和定位生命周期属于正确性，不适用形态功能的收益准入门槛。
发现可重复的契约／功能缺陷时，必须建立正确预期回归并修复，不能以样本频率低拒绝。

| 类别 | 含义 | 关闭规则 |
|---|---|---|
| 待修复缺陷 | 已复现的契约、时序或交互错误 | 原触发不再复现，正式断言覆盖正确预期，连续交互由实际 DOM 验收 |
| 已定刻意差异 | 与官方不同，且已有明确产品取舍 | 保留理由和重新评估条件；不自动重开，也不能用于掩盖丢记录等缺陷 |
| 已否决形态功能 | 有代价但尚无足够收益的新呈现能力 | 观察须标明读取口径与样本数；修正统计后重新评估受影响的结论 |
| 未确认 | 尚无稳定证据的候选 | 先取证，不按静态猜测改行为，不宣称已验证 |

只对新增**形态能力**先衡量收益，不把官方存在某个组件作为必须搬入的理由。
统计工具需同时报告缺失与已比较的样本；缺样本、错读现代信封或局部测试全绿，均不能证明等价。
两条统计入口与[共用统计模块](<../scripts/trajectoryProbeFacts.ts>)复用同一口径：结果先按新旧信封
抽取内容块，JSON 候选、解析成功、对象、数组与解析失败分别计数并明确分母；展示对拍分别报告
应比、已比、缺失、错配与输入覆盖缺口，并披露不比较的字段及原因。零样本不再视为通过。
在当前成功派生且输入具有有效 seq／身份的路径，每个助手或人发消息事件都贡献同 seq 记录，
逐事件 missing 分支自然不可达；不推广到畸形输入、抛异常或未来派生改动。
正式[真实 CLI 受控回归](<../scripts/trajectoryProbeCli.test.ts>)在私有打包中转发真实派生后丢一条
指定记录，先证明注入命中，再断言 4/3/1 与退出 2；对照 4/4/0 退出 0。
它同时钉住受控来源不得偷扫默认目录、缺失不得被静默吞成「一致」，不向生产加入故障开关。
历史全库比例尚未按新口径重算，特别是旧结果 JSON 与多块比例，不得当作当前收益判断依据；
JsonTree 与 `outputBlocks` 的既有产品取舍保持不变，后续只能在获授权重新取证后评估。
目前请求事实和账本连续交互的审计缺陷正逐项修复验收；本文件只保留长期契约和验证机制，
过程待办与红绿日志记录在项目临时目录，不再用“待办 0 条”代替正确性证明。

#### 当前可复现验收边界（2026-10-09）

**输入准入先于派生与计量。** [日志库](<../scripts/sessionLog.ts>)保留旧宽松入口兼容历史消费者；
[夹具提取入口](<../scripts/trajectoryFixtureBuild.ts>)必须显式走严格入口：完整 zstd 帧与尾部消费、
原生解压／校验和、各帧字节拼接后的 fatal UTF-8、逐行 JSON 对象验证。合法 U+FFFD 不等于坏 UTF-8，
可以跨帧；完整末行无需换行。源摘要和派生消费同一份字节快照，不二次读取源制造 TOCTOU。
秘密扫描在临时写盘前执行，写后完整读回再 rename；用法／完整性／秘密失败分别退出 2／3／4。
[离线校验](<../scripts/trajectoryFixtureVerify.ts>)只验证既有登记、脱敏与结构自洽，不认证历史源身份。
内部完整性、来源授权、来源认证是三件事，不能用自洽 hash 替代后两者。

原生引擎的宽容度是运行期 Node 的版本行为，不是契约：Node 24.19 及更早把「魔数 + 垃圾」当完整空帧
接受（`zstdDecompressSync` 不抛错、buffer 为 0 字节），24.20 起改抛 `Z_BUF_ERROR`。因此帧头合法性与
「垃圾不得被读成空内容」由日志库自己判，断言只钉产物契约（非法帧头 → `undefined`）与「引擎不得解出
内容」，不钉这一次引擎偏宽还是偏严。

当前三份[真实脱敏夹具](<../test/fixtures/trajectory/README.md>)均以无上限 `--limit 0` 生成：
`payloadReduced=false`、`payloadMeasurementEligible=true`、`provenance.truncatedFields={}`，派生源码固定 SHA-256 为
`922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb`。
自由文本保 UTF-16 长度，不保 UTF-8 字节等长；脱敏模型字节不得冒充原始 wire 字节。

| 夹具 | durable 事件（不含 metadata 行） | 轮／组／记录／请求 | 脱敏模型 JSON 字节 | 夹具文件字节 |
|---|---:|---|---:|---:|
| [real-small](<../test/fixtures/trajectory/real-small.json>) | 63 | 3／9／21／6 | 206721 | 280131 |
| [real-long](<../test/fixtures/trajectory/real-long.json>) | 5141 | 20／985／2047／926 | 13485165 | 15166299 |
| [real-compaction](<../test/fixtures/trajectory/real-compaction.json>) | 732 | 4／107／297／84 | 3714411 | 4069664 |

这里 durable 数为登记 `sourceEventCounts` 合计减去一条 `session` 元数据行：合计分别为 64／5142／733；不要把带元数据的 JSONL 行数与 durable 分母混用。

**统计分母与最终态分开。** 用[共用统计模块](<../scripts/trajectoryProbeFacts.ts>)逐源复算，
不是把三个从头编号的 seq 窗口拼起来再派生。工具结果共 1178 帧：现代信封 176、旧信封 1002、
无内容字段 0；JSON 候选 64、解析成功 9、失败 55。逐源结果帧为 3／999／176，JSON 候选为
3／54／7，成功为 3／1／5。三源探针与当前完整模型的工具名／内容块名字枚举未观察到 PTC；
这不是登记 `capabilities` 已包含 PTC 计数。subtool 登记及模型枚举均为零，long 有 20 条 steering；
v4 样本有 2 条压缩记录、2 个压缩请求、1 条工具目录更新。零样本不证明全库不存在。
当前[对拍入口](<../scripts/trajectoryAlignProbe.ts>)逐源应比 9／949／83（合计 1041，助手 1010），
列明消息／用户判据没有 missing 或 mismatch；这不是全部字段等价。

本轮字段审计采用**先完整枚举候选、冻结键集合、再具名判定**：键包含规则／来源／事件身份或 occurrence／字段；
未知键、重复判定、残留 pending 都失败。每个 rule×source 包括零样本行，满足
`candidate = compared + notCompared`，`mismatched` 是 `compared` 的子集；源预言机、模型自洽与 API
传参分别标记。此次 33 条规则为 33435 = 32694 + 741，仍保留历史事件口径的 13 条错配，
不能写成「全字段 0 错配」。缺源字段的 `header.system`（5）和 `compaction/start.turn`（2）全未比较，
三源没有边界前仍开着的压缩实例。该字段矩阵是有限一次性审计，不是标准 CLI 已有的全部字段断言。

其中工具结果必须区分**历史事件**与**同 callId 最终态**：固定官方 trajectory 目标自身接受 replace，
更新 `calls.set(rootId, result)`；固定布局对同 callId 取末条。chat 目标的 append-only 过滤不能外推到
trajectory。long 的 999 帧 = 985 个最终结果 + 14 次重复；三源 1178 = 1164 + 14。
历史起点对最终模型的 13 条错配（11 条 append 正文、2 条 trim 空正文）不删除；另列最终态 1164 条、
错配 0。定义／更新与固定布局已实际对照，不声称官方 event-registry 全文装配或官方浏览器端到端通过。

**真实消费者跨同一 seam。** [账本投影模块](<../src/webview/trajectoryLedgerRows.ts>)拥有
flatten／search-first filter／两种 collapse／每 section 起点；非空查询临时覆盖折叠而不改折叠集合，
清查询恢复。调用摘要是布局行，`cellIndex=-1`、不写 `data-cell-index`、不顶轮次标签。
[交互端口](<../src/webview/trajectoryInteraction.ts>)由账本与[时间线组件](<../src/webview/components/TrajectoryTimeline.tsx>)
共同消费，拥有互斥 record/request、reveal nonce、pending focus、最新 viewport 与 document 拖动监听；
不是两个组件各自复制状态机。focus 命中必须 ack，refresh 不重播，未命中保留到目标抵达，离开／切会话清理。
新 reveal 可以重复同一目标，已消费旧票不能因手滚或普通 render 再滚动。
[虚拟规划](<../src/webview/trajectoryVirtual.ts>)按布局行位置分段垫高，插入 pinned 行后也不乱序；
摘要与记录同属布局行单位，padding 不计真实行，不能拿 DOM 窗口数当逻辑总数。

完整 long 的连续 DOM 已验证完整 2047 条输入不裁、不改正文：选择／搜索／折叠／20 段起点、
真实 chat 的 Inspect 入口与 ack、原生 wheel／右键／区外抬起／最新 viewport／切会话清理。
受控历史投影保原 index／seq／callId，用生产 loadMore 按钮恢复完整模型，只证明分页入口与身份保留，
不冒充源自然分页或完整载荷量测。英文与中文 420px 均隐藏 index、种类不越事件格；
请求 Summary 的计数／retry／结果均可读，长错误保完整 title。首次 reveal 的几何另以完整 long
从尾部 2046 跳到工具 5 验证：原生滚动锚定会在窗口重排时把写下的 116px 改成 117px，
超过 0.5px 位置守卫而弃票，26px 行只见 13.5px。账本容器用 `overflow-anchor: none`
把位置所有权交还应用与用户；未放宽守卫、不加轮询。当前生产原触发首次见 25.5／26px（1px 边框容差），
重复同目标仍可见，手滚 2000px 保持 2000px；随后同页九组连续 DOM 通过。
计划追上与有界收尾仍由同一交互端口负责，不能拿理想化重排模拟或源级 CSS 断言代替真实可视几何。

**完整链计量协议，而非单个 folding 微基准。** [核心量测](<../scripts/trajectoryPayloadBench.ts>)
与[薄 CLI](<../scripts/trajectoryPayloadBenchCli.ts>)、[浏览器装配／runner](<../scripts/trajectoryPayloadBenchBrowser.ts>)
共用资格门：登记完整、严格 `payloadReduced === false`、完整资格为真、无任何截断，指定 derive hash
贯穿 Node 与 emit。默认 warmup=2、samples=11；报告原值及 min／median／nearest-rank p95／max，
`n=11` 时 p95 就是最大观测。缺依赖、零工件、失败写盘、端口未监听都必须失败，不 skip 成通过。

- Node 覆盖 fixture read／parse／validate、wire stringify／hash／parse、vendor、ledger、timeline、search、
  allocation／virtual。`fold.rebuild` 是由模型合成事件后的**下界**，不是原始日志解码／派生。
  真源前段须另以一次授权字节快照量 decode／对象 JSONL／DTO／derive／stringify，IO 单读不报 11 次分布。
- 浏览器使用生产 CSS 原字节与主题桥、实际生产消费点的打点见证。首载与 11 次刷新同步阶段和异步索引
  分开：保原始 `schedule → fire → index.update`，同 timer／nonce 配对与 landed，取消／合并单列。
   索引执行判据选首载真实模型那一次完整 timer；刷新尾部 `afterRefreshExecuted`／`updatesDuringRefresh`
   只是观察，允许合并，不能单凭尾部等待结果声称执行失败或已落地。timer 绑定负例仍须通过正式判据拒绝，不能只输出诊断标志。
  从真实 schedule 到 fire 的延迟判节流，不用首载之后取得的 `modelSetAt` 冒充 timer 起点；
  原始 schedule 必须包含首载 commit 中的调度，缺 schedule 仍失败。requestedDelay=3000ms，
  最低观测延迟 2500ms；不为修计量脚手架而放宽生产判据。
- 滚动按每个 sweep 判单调，跨 sweep 回起点正常；从组件取逻辑 ledger/allRows 数与 DOM 渲染行用同单位。
  small 的 21 行非虚拟分支标 not-applicable，不当虚拟性能证据；长／压缩样本必须真滚动、真 padding、
  未全量 DOM 渲染。保存滚动帧原值，idle rAF 不能冒充滚动流畅。
- 同时等 `window.__M06_DONE__ === true` 与 `window.__M06__.done === true` 后才读最终 status／checks。
  量测 passed 只说明协议完成，不等于速度达标；历史真实滚动曾观测 long 多数帧 590–675ms、
  compaction 116–132ms，应保留为慢帧信号，不拿折叠微基准覆盖。产品冻结后须专用 CPU 窗口重新量测。
- JSON wire clone／React DOM 是离线桥，不是已安装 VS Code IPC；本轮没有启动模型或耗模型 token 的验证。

##### 本轮最终完整载荷量测与决策

2026-10-09 的最终前景重复使用 Windows x64、Node `v24.19.0`、Chrome `154.0.0.0`、
1249×1277 CSS 像素、DPR=1；产品与夹具冻结，未与构建、Node 量测或其他浏览器采样并行。
三夹具均等到双 DONE，21 项量测协议检查通过；这不是交互流畅的认证。
浏览器重复预热 2 次、采样 11 次；以下时间单位均为 ms，`中位／p95` 的 p95 在 n=11 时等于 max。
滚动帧有 132 个原始观测，median 取较低中央秩（不是偶数样本中央两值平均）。

| 夹具 | 首载墙钟（单次） | 刷新墙钟 中位／p95 | 滚动帧间隔 中位／p95 | 12 步 sweep 中位／p95 | 索引真实 timer 延迟／CPU（单次） |
|---|---:|---:|---:|---:|---:|
| [real-small](<../test/fixtures/trajectory/real-small.json>) | 40.2 | 9.7／10.9 | 5.9／7.7（非虚拟，N/A） | 70.5／87.8（无滚动） | 3001.3／5.8 |
| [real-long](<../test/fixtures/trajectory/real-long.json>) | 1185.6 | 573.2／620.3 | 570.7／591.1 | 6300.1／6406.6 | 3007.5／373.9 |
| [real-compaction](<../test/fixtures/trajectory/real-compaction.json>) | 210.8 | 98.5／113.4 | 102.3／110.5 | 1142.7／1185.0 | 3000.8／78.9 |

long／compaction 的逻辑行分别为 2047／297，实际 DOM 行 40–53、padding=2，最大 scrollTop
58439／7694；两者各有 156 次非零 applied scroll，预热与采样每个 sweep 都单调。
small 为 21 行、没有 padding 或实际滚动，不把它计为虚拟化性能证据。
60 个空闲 rAF 的中位／p95／max 是 5.9／7.2／14.4ms，远低于 long 的滚动帧间隔，
因此本轮慢刷新／滚动信号不能再被约 1 秒的空闲调度基线解释。
第一次同字节重复的空闲中位为 1005.6ms，与滚动同阶；仅 `bringToFront()` 后空闲恢复，
故第一次只保留为受调度影响的历史，不据其约 1 秒帧间隔判定产品开销，也不删除原报告。
尚未唯一定位具体浏览器／操作系统节流机制。

不同载荷与阶段必须分表，不能相加构造一个不存在的 VS Code IPC 关键路径：

| 夹具 | 未脱敏源模型 JSON 字节 | 真源 decode／parse／derive／stringify 中位 | 真源顺序总量 中位／p95 | 脱敏 wire stringify 中位／p95 | 脱敏 wire parse 中位／p95 |
|---|---:|---:|---:|---:|---:|
| [real-small](<../test/fixtures/trajectory/real-small.json>) | 177200 | 0.99／0.37／0.16／0.45 | 2.02／2.49 | 0.55／0.61 | 0.35／0.37 |
| [real-long](<../test/fixtures/trajectory/real-long.json>) | 11079437 | 89.58／33.11／12.33／29.44 | 165.30／180.25 | 29.26／31.25 | 16.23／17.39 |
| [real-compaction](<../test/fixtures/trajectory/real-compaction.json>) | 3240047 | 13.03／6.18／1.38／7.14 | 27.89／35.86 | 7.78／8.20 | 4.67／5.79 |

真源前段仅三授权停止日志，一次字节快照 IO（0.13／1.25／0.73ms），总量还包含事件 DTO 映射；
逐阶段中位不要求相加等于总量中位。脱敏 wire 是此前登记的 206721／13485165／3714411 字节，
不是本表的未脱敏源模型字节。Node 独立阶段覆盖 fixture 准入、vendor／ledger／timeline、完整 search、
allocation 与 virtual plan；互斥折叠／搜索分支不能相加，orderedPass 只有 cold／warm 两个顺序观测，
不冒充 11 个完整生产刷新样本。完整性／秘密准入成本也不冒充每次 UI 刷新的必要成本。

**先测后的决策**：下一次性能优化应优先检查[组件](<../src/webview/components/Trajectory.tsx>)中
虚拟裁窗口之前的 `allRows = ledgerRows.map(...)` 全量 JSX／行展示构造，而不是先截掉模型历史或扩大 folding。
本轮刷新窗口 `view.allRows` 总 CPU 中位 small／long／compaction 为 9.0／566.5／96.5ms；
long 11 个刷新窗口共 12 次调用，单调用中位／p95 为 563.5／611.3ms，个别窗口含两次调用，
其 1115ms 合计不能与单次刷新墙钟相除。首载窗口同样可含多次调用，不能将累计 CPU 当一次首载耗时。
DOM 已虚拟化并不意味着窗口外行尚未构造；这为“先规划窗口、再构造可见／pinned 行”提供明确优化候选。
第二优先级是完整搜索索引的重建 CPU（long 单次 373.9ms）；3 秒节流本身不能消除执行时阻塞。
以上是定位范围与优先级，不是已实施或已证实收益的优化。优化时必须保留查询覆盖折叠、摘要、pin 顺序、
首次定位、互斥选择及完整来源语义，并重新以同消费 seam 的红→修→独验量测；本轮不追加性能重构，
不恢复最近 N 条截断，不新增既定不采用的 outputBlocks，也不宣称流畅、全部字段等价或安装真机通过。

无需用户日志的复现入口（先执行标准构建；三夹具读取不扩来源授权）：

```powershell
npm run typecheck
npm test
npm run build
node build/trajectory-fixture-verify.mjs --fixture test/fixtures/trajectory/real-long.json
node build/trajectory-payload-bench.mjs --fixture test/fixtures/trajectory/real-small.json --fixture test/fixtures/trajectory/real-long.json --fixture test/fixtures/trajectory/real-compaction.json --expect-derive-sha256 922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb --samples 11 --warmup 2 --out bench-node.json
node build/trajectory-payload-bench.mjs --fixture test/fixtures/trajectory/real-small.json --fixture test/fixtures/trajectory/real-long.json --fixture test/fixtures/trajectory/real-compaction.json --expect-derive-sha256 922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb --emit-browser bench-browser
node build/trajectory-payload-bench.mjs --serve-browser bench-browser --port 8780
```

浏览器使用 CLI 宣告的 URL；预览真实面板使用 `test/preview.html?locale=en&trajectory=long`
（中文用 `locale=zh`），点「Trajectory／轨迹」。它是项目预览，不是 Harness GUI 或安装验收。
正式测试只读受控夹具，不自动消费用户日志；获准新源时用提取 CLI 的显式来源参数另行授权。

**当前差异分桶表**（列明产品形态差异，非全部字段等价证明；历史统计只解释当时决策）：

| 项 | 桶 | 依据 / 重新评估的触发条件 |
|---|---|---|
| 流式助手正文（官方 `PartialAssistant` 行） | 已定刻意差异 | 本扩展的流式叠加层语义与官方 live-chunk 不同，映射错会出**重复行**，只出「正在生成」占位（`dsh/trajectory.ts` 文件头差异 1）。触发：官方 live-chunk 语义变化，或本扩展重做叠加层 |
| `system/message` 的独立更新行 | 已定刻意差异 | 按 `request/header` 的变化合并出行（文件头差异 2）。触发：用户要求看到提示词的每一次改写 |
| prologue 桶内的组顺序（事件自带 turn 0 时） | 已定刻意差异 | 官方把 turn 0 的组拼在 turn 1 自己的组**之前**，那个角落里系统行不再是摊平后的第一行；本扩展把 turn 0 改号后按显示顺序建组，保住「初始提示词第一行、摊平顺序 = 显示序号」（§2.7）。触发：真实日志出现 0 号轮（实测 377 份里 **0 份**） |
| 轨迹页「向上滚自动加载更早」（官方 48px + prepend 补偿） | 已定刻意差异 | 与会话页保持一致，只有按钮（§2.8）。触发：用户反馈轨迹页滚动加载缺失 |
| 轮次表头四列与组头行 | 已定刻意差异 | 上游 `TrajectoryTurnHeader` / `TrajectoryGroupHeader` 无人 import、官方界面上不存在，做了反而偏离（§3.8） |
| 时间线多一颗「复位缩放」、双击语义（先清选区、无选区时复位） | 已定刻意差异 | 本扩展是官方的超集 / 微差（§3.4） |
| 记录检查器里的「错误」行 | 已定刻意差异 | 官方记录检查器**没有**这一行（错误只在请求检查器），本扩展自定口径（§5.2 末） |
| `promptDetail` 快照不带 `config` | 已定刻意差异 | `config` 四个键已在 `provider` / `model` 与选项面板里，搜索面无增量（§5.2 搜索） |
| `AssistantToolCalls`（预览页签里每个 tool-call 一枚入口） | 已定刻意差异 | 账本行右侧与工具行已是同一信息的两个落点；跳转由「原始内容」页签那枚按钮给（§5.2） |
| JsonTree 折叠树 + PTC 的「原始 JSON」开关 | 已否决 | 代价：`JsonTree` 850 行 + CSS 345 行 + `Menu` 564 行 + 8 个我们没有的 `--dsw-*` 令牌；收益：只有 2.2% 的调用真有嵌套容器（§5.2 代价核算） |
| PTC 源码块的行号与语法高亮 | 已否决 | 本机 450 份日志里 `run_code` **0 例**，且要引入语法高亮器。触发：PTC 在真实会话里被用起来且被要求 |
| `outputBlocks` 不采（连带结果里的图片渲染、单 text 块的结果判据） | 已否决 | 与 `outputDetail` / `resultPreviewMarkdown` 重复，实测 35k 块 / 7400 万字符；界面那两处用处未做（§5.2 搜索） |
| `RecordAttachments`（附件 / 图片块） | 已否决 | 455 份日志 101640 个块里 image / file 块 **0 例**；`SourceBlocks` 里已留兜底分支（§5.2） |
| 本地节点窗口 /「只折最近 50 个节点」 | 已否决 | 探针 452 份日志：中位 0.4ms、p90 2.1ms、最大 9.5ms（§5.2） |

> 2026-10-03 复核：曾在这里的「助手行退化成仅工具调用」已修（见 3.2.1），
> 「系统提示词更新只有一个标签」已修（现在按 `promptChange` 分四种，含只有工具变化的
> 「工具已更新」，且工具目录逐字相同不再重复出行）。
> **2026-10-04 复核（第一次）**：4 个纯决策模块已 vendor（见 3.7），连带消掉了一批差距——
> 行文本层（`user`/`context`/`tool`/`subtool` 走官方 `preview` / `name · preview(args)`、
> 附件摘要、`resultPreviewMarkdown` 与两条结果语义、**工具目录变更行**）、「调用折叠」的
> 状态键（改用 `recordId`）、**轮次折叠摘要**（「N 个步骤 · M 个工具调用」）、
> 时间线的错误色判据 / 并发串行化 / 选中滚视口 / 选区生命周期 / 搜索联动 / Escape 与
> 键盘可达 / hover 竖线 /「时长」持久化、搜索的匹配语义与呈现（分词 AND、官方字段表、
> 索引身份、过滤 + 压暗、不再索引 `requestOnly`）、来源标签的 `source.unknown` 分支。
> **2026-10-04 复核（第二次）**：**请求级检查器**（概述 / 选项 / 用量含会话累计 / 计时）
> 与**请求边界小标记**已落地（见 3.3 与 5.1 的请求表），连带的计时口径也一起收了——
> 计时面板从「一句 `timingNotRecorded`」变成官方那一族分开的「不可用」+ 吞吐量 + 计时来源，
> `assistantMetrics.stepStartTime` 改取 `step/start` 的时刻（这一条影响的不止请求面板：
> 助手记录的 `timeSeconds` 与时间线的总时长同样受益）。
> **2026-10-04 复核（第三次）**：检查器里各段原文的**复制 + 自动换行**已落地
> （`TrajectoryPre`，见 5.1）——顺带修掉一处**默认口径写反**的老缺陷（`.trajectory-pre`
> 从前是常开 `pre-wrap`，把参数 / Schema 的 JSON 缩进结构打散）。
> **2026-10-05 复核**：**A 档三项**（从对话跳进轨迹、账本虚拟化、本地节点窗口量过后不做）
> 与下列四项都已收口——压缩行的思考、`source.messageJson` 标题、空态概览条、
> 请求面板的计时口径（连带记录面板对齐）。下面按层列这些差异的**依据与细节**——它们
> 是功能落点的历史说明，不等于请求时序与连续交互已经通过验收。

**行文本层**：

- **压缩行的思考已对上官方口径**（2026-10-05）：官方那一支是
  `thinkingDetail = detailReasoning(rawOutput ?? summary)`、正文（`text` 块）另走
  `outputDetail` / `sourceBlocks`；本扩展照同一支折（`src/dsh/trajectory.ts` 的
  `compaction/summary`）。**从前那段思考在界面上完全没有落点**：`blocksToText` 会跳过
  `reasoning` 块，而当时也没有别的地方取它。本机 8 份含压缩的日志里 `rawOutput` 的块
  类型只有 `text`（另 1 份带 `tool-call`）、**reasoning 块 0 例**，所以这一条在真实
  数据上暂时看不出差别，是契约级对齐（判据在 `scripts/trajectory.test.ts`）。
  （**2026-10-04 更正**：这里曾把「不合成中断码」也列为差距——那条已补：
  `session/end-seed` 现在会把边界前仍在跑的压缩标成 `error` + 官方那个合成码
  `trajectory.compaction-interrupted`，界面取「上下文压缩在完成前被中断。」那句专用文案。）

**折叠与列表结构**：

- **流式正文**：不出官方那种流式助手行，只出「正在生成」占位（刻意差异，防重复行；
  官方 live-chunk 可被 durable settlement 原子替换，我们的叠加层语义不同）。
- **系统提示词面替换的完整语义**：`system/message` 自己的多次改写不单独出行，按
  `request/header` 的变化合并（刻意差异；官方会出独立更新行）。
- **本地节点窗口**：官方只折最近 50 节点并有短路判断；本扩展每次折全量事件窗口
  ——**量过后决定不做**（2026-10-05，数据与理由见下面「检查器与跳转」之后那条，
  与 `outputBlocks` 同一套「值不值得」的口径）。
- **账本虚拟化已对齐**（2026-10-05）：官方 `records.length > 100` 或还有更早历史时启用
  （overscan 12 行），本扩展同一组数——细节见下面「检查器与跳转」里的那条。
- **账本行的位次与官方同源地「不单调」**：steering 落进某一步的组之后，排在它后面、
  但属于消息组的记录会另起一组并排在**该步骤组之后**（官方 `flattenRecords()` 同样如此）。
  实测本机 155 条 steering 里 97 条是这种形态；`scripts/trajectoryAlignProbe.ts` 因此把
  「全局位次递增」这条判据换成「组内递增 + 每条恰好一组」。
- **列宽：英文 122 / 中文 96，窄面板一律 50**（2026-10-04 落地）。事件列宽度按语言分档，
  语言由界面写在根元素的 `lang` 上（`App.tsx` 的 insertion effect，值取归一化后的
  `zh` / `en`，`:lang(zh)` 按子标签前缀覆盖全部中文变体）。中文档位取 **96** 而不是官方
  的 84：官方那个 84 是配它自己的内容定的——它的账本表里**没有 `#N`**（index 只在
  `TrajectoryCell`，账本表不渲染），种类标签又是 10px，而本扩展 index 与种类标签同格、
  标签字号是「基准 − 2」。按预览页实测（文本自然宽用 canvas 量，`scrollWidth` 会把 flex 项
  的右内边距拆出去、不可靠）：index 15.4 + 间隙 4 + 最长徽章 43.7 + 事件格左右内边距 40
  = **103.1**，84 下徽章被压到 32.4、文字走省略号（比不改更差）。96 是刚好装下那一档向上
  取整。官方的 `.kindSlot`（76 / 44）本扩展没有对应物——它那套是「槽定宽 + 徽章靠右」，
  本扩展是「内容条 + 徽章按内容」，宽度上的对应关系只体现在事件列这一档。
- **紧凑阈值（420）与语言无关**：官方把「收列 + 换 `#N` + 换纯图标」放在它自己的 620 上，
  而 620 是它按自己的表宽手调的、**不是**「中文能更早收」的依据——收列要看的是事件列自己
  放不放得下那一格的内容（index + 种类徽章），这与语言无关；本扩展的面板（420~900）比
  官方表宽窄得多，所以这条线本来就是照自己的面板定的。窄栏那一档因此**不分语言**收成 50：
  `.trajectory-col-event` 与 `.trajectory-col-event:lang(zh)` 两条都写在容器查询里（只写
  前者的话中文下收列会静默失效——同特异性下源序在后的 `:lang(zh)` 赢）。
- **折叠一轮时保留哪些行**（2026-10-04 落地）：与官方 `collapseTurnRecords()` 同口径——
  该轮的 system 行与 requestOnly 请求锚点行照常显示、**第一条内容行**也留着，摘要行只代表
  它**之后**那批（`contentRecords.slice(1)`，与 `trajectoryTurnSummary()` 同一个切片）。
  内容行不多于一条时整轮一行都不收（官方 `contentRecords.length <= 1` 原样返回），
  `turnCollapsible()` 也按「内容行多于一条」判。摘要行自己**不顶轮次标签**——留着的那条
  内容行已经顶着（`renderRow` 按 `trajectoryTurnStartsLabel()` 给），两行都挂就重了；
  它也不进选中与时间线（没有 `data-cell-index`），点它是展开这一轮。
- 官方的轮次表头四列（`column.input` / `output` / `think` / `time`）与组头行**没有实现，
  也不该实现**：它们在上游是无人 import 的死组件（`TrajectoryTurnHeader` /
  `TrajectoryGroupHeader`），官方界面上并不存在这两样东西。


**时间线（顶部概览条）**：

- **缩放深度已与官方同口径**（2026-10-04）：上限由官方的**绝对最小窗口**推出
  （`sequence` 4 条操作 / 其余 20ms），所以长会话能放得更深；从前写死 100 倍，
  几十秒的会话最多看到几百毫秒一格、放不到官方的细粒度。
- **视觉与交互细节已补齐**（2026-10-04）：等宽条之间的**缝隙**
  （`min(width × 0.08%, 1px)`，官方同式）、助手条上的 **TTFT / 解码渐变**、
  **hover 高亮环**（两圈 `box-shadow`）、**hover 时不再画跟随竖线**（与官方同一条件：
  指在条上时改由高亮环表达）、选中条的**视口过渡**（180ms，只在「选中跟随」时开）、
  选区的**两枚把手**与**域外压暗**（两条 100vw `box-shadow`）、右键**轻点清选区**、
  拖到左右 8% 边缘的**自动平移**（步长按离边缘的距离缩放）、拖出绘图区靠
  **document 监听**继续框选（官方用 `setPointerCapture`，同一目的）、
  等时长模式的条定宽成方块（`data-equal-duration`）。
- 仍不同的两处（都刻意保留）：本扩展多一颗官方没有的「复位缩放」按钮；双击是
  「先清选区、已无选区时复位缩放」（官方双击只清选区）。
- 「没有计时数据」的空态提示已有（官方 `timeline.noTimingData` 同位置同文案）；
  **整条概览条无条件渲染**（2026-10-05 对齐）：一条记录都没有时它就是官方的空态形态
  ——三条泳道 + 那句提示，左端的「加载更早」照旧按历史出不出（官方空态分支里
  `EarlierHistoryBoundary` 同样保留）。从前这里是「有记录才渲染」，会话刚建、还没产生
  记录时整条概览条会凭空消失。
- 官方 `TrajectoryTimeline.domainMs` 口径（域跨度）本扩展已用上（缩放上限与它同源）。

**检查器与跳转**：

- **PTC（`run_code`）已对齐**（2026-10-05）：官方对这条调用显示的是**程序描述**而不是
  `run_code · {json 参数}`，参数那一格也改叫「代码」、正文显示源码。三处都按官方 `codeProgram()`
  接线，判据本身就是 vendor 进来的官方原文（`src/vendor/ui-trajectory/code-program.ts`）：
  1. 行文本 = `` `run_code · ${描述压平空白}` ``（官方 `recordDisplayText()` 里在预览那一支**之前**
     返回，所以命中的行不吃 `text · previewMarkdown`）；
  2. 参数页签标签在有程序时换成 `code.source`「代码 / Code」；
  3. **结果页签的出现条件是 `outputDetail || 代码程序存在`**——有程序时即使还没有结果也出那一格
     （最容易漏的一条）。
  语言标记只认调用时 schema 里 `parameters.properties.code.description` 提到的
  **TypeScript / Python 二选一**（两个都提、都不提一律不标），与源码内容无关。
  与官方仍有一处**刻意的形态差异**：官方那个组件另有一颗「原始 JSON」开关（在源码与 JSON 之间
  切，用它们的 `JsonTree`——那一项本扩展明确不做），我们没有那颗开关，只显示源码。
  另有两处**呈现差异**：官方源码块带行号与语法高亮，本扩展走 `TrajectoryPre`（同一页所有
  原文段落都走它，带上复制与自动换行）。
  > **本机零样本**：450 份会话日志、57731 个工具 / 子工具行里 `run_code` **一次都没出现过**
  > （「参数里带 `code` 或 `language` 的调用」那 197 次全部是无关的浏览器工具）。所以这一条
  > 的判据只能来自官方契约与官方单测（`ui-trajectory/tests/code-program.client.spec.ts`），
  > 离线断言在 `scripts/trajectoryVendor.test.ts` 与 `scripts/trajectoryDisplay.test.ts`；
  > 当前真实预览不注入 `run_code`；无真实 PTC 样本的分支只保留显式标记的契约回归。
  > **官方契约单测不等于真实 PTC 或安装真机验证**。
- **从对话跳进轨迹已对齐**（2026-10-05）：官方那条链路是「工具行底部一颗按钮 →
  `inspectCall(callId)` → `viewRequest = {view:'trajectory', focus}` → `TrajectoryTable`
  按 `record.cell.callId === inspectCallId` 找行 → 选中并滚过去」。本扩展逐段对应：
  工具行展开区底部那颗「查看 / Inspect」（官方 `row.inspect`，逐字同文案；**没有
  `callId` 的行不出这颗按钮**——调用在窗口之外那种补出来的行没有 id，给了就是一颗
  点了没反应的按钮）→ 宿主记下目标并切到轨迹视图（同时立刻取一份账本，否则第一次
  跳转会落在可能还没有账本的空白页上）→ `trajectoryCallCellIndex()` 按 `callId`
  **等值**找行（不许前缀匹配：`call_1` 与 `call_1:ptc:1` 是父调用与子调用）→ 选中 +
  滚到那一行。找不到目标时**请求留着**（官方「Not-found leaves the request pending」，
  历史还在往后取时「先点了、那一页随后才到」正是它要活下来的场景）；清空时机是
  离开轨迹视图或切会话（`callId` 只在同一个会话里唯一）。
- **账本虚拟化已对齐**（2026-10-05）：官方 `records.length > 100` 或**上面还有更早的
  历史**时切窗口渲染（overscan 12 行，行高估不出来按 30），本扩展用**同一组数**
  （`src/webview/trajectoryVirtual.ts`）。三处实现细节与官方不同、各有理由：
  官方用虚拟滚动器 + 逐行实测高度，本扩展用行高估计与表格 padding 分段。
  2026-10-09 的规划器把窗口和窗口外 pinned 行按**真实布局位置排序**，在每个未渲染间隙补垫行；
  不再把若干窗口外目标挤到两枚顶／底 padding 之间。官方跳转靠虚拟器 `scrollToIndex`，
  本扩展把目标行强留进窗口、按真实 DOM 定位；新 reveal 的完整可视与一次消费须另以连续 DOM 验证。
  > **踩过两个坑，都由断言钉住了**：① 视口比整份账本还高时窗口的 `end` 会小于
  > `start`（下面垫行数变成负数），表现是「账本少画了十来行」；② 跳转落点与选中
  > 是**记录下标**（`cell.index`），而行列表里混着没有记录下标的折叠摘要行，直接拿
  > 它当数组位置会**补错一行**（实测「选中第 51 条」把第 52 条画了两遍、目标行反而
  > 消失）。换算收在 `trajectoryRowPositions()` 里。
- **「只折最近 50 个节点」不做**（2026-10-05 量过后否决，同 `outputBlocks` 那一条的
  口径）：官方只折最近 50 个节点并带短路判断，本扩展每次 `listTrajectory` 把整份事件
  窗口重折一遍。新增零 token 探针 `build/trajectory-fold-probe.mjs` 量了 452 份真实
  日志：事件窗口中位 424 行（最大 10319 行），**取一份账本中位 0.4ms、p90 2.1ms、
  最大 9.5ms**（其中折叠本身占 99%，其余是摊开 + 按 seq 排序），账本记录数中位 146。
  这些 folding 微基准解释当时不加窗口的决策，不是严格源解码、JSON、索引或 DOM 滚动的整链证明；
  不再由它推导当前视图只耗 0.3% 或长会话流畅。保留完整事件窗口可避免缺记录这一正确性风险，
  后续优化须依据上面的完整载荷协议定位实际慢阶段，不因 UI 慢帧就未经测量裁掉历史。
- **逐块 `sourceBlocks` 的渲染已做**（2026-10-05；`outputBlocks` 那一半不在其中，理由见下）。
  检查器的「原始内容」页签在**有原始块**时整块改用 `SourceBlocks`（`components/SourceBlocks.tsx`）
  ——每块一节：块标题（`块 #{序号} {类型}`，类型串原样不翻译）+ 该块原文；`callId` 在块上时
  那节标题是一颗跳转按钮，点了按 `callId` **等值**选中对应工具记录（认不到就什么都不做）。
  判据与两条排除收在纯函数 `trajectoryUsesSourceBlocks()` 里：

  1. **全是工具目录变更的块**（`tool-addition` / `tool-removal`）→ 照旧显示名字清单
     （官方第一分支优先命中，逐块会排出「块 #1 tool-addition / read」这种比正文还长的形式）；
  2. 没有块 → 落回那段裸文本（老账本、压缩摘要那类）。

  **刻意不做的两处**（都与官方形态有差，各自有理由）：

  - `AssistantToolCalls`（官方在预览页签里给每个 tool-call 块一枚「打开调用概述」）：
    账本行右侧本来就画了每次调用的「摘要 → 结果」，账本里每个调用另有自己的工具行，
    预览页再列一遍是同一份信息的第三个落点。跳转入口由「原始内容」页签那枚按钮给。
  - `RecordAttachments`（附件 / 图片块）：**它在本扩展的数据上没有落点**——2026-10-05 量过
    455 份日志的 101640 个块，`sourceBlocks` 里 `image` / `file` 块是 **0 例**（附件块只出现
    在工具结果里，属于 `outputBlocks`）。`SourceBlocks` 里留了一条兜底分支：真出现了就画
    文件名 + 那段原文，不静默丢弃。

  **块形态实测**（零 token 探针 `.agent/temp/sourceBlocks.mjs`，口径对齐 `sourceBlocksOf()`）：
  49,944 条消息 / 101,640 块，其中 `tool-call` 58,776（57.8%）、`reasoning` 27,242（26.8%）、
  `text` 15,371（15.1%）、目录变更 251（0.2%）；**多块消息占 69.0%**（中位 2 块、最大 36 块）
  ——逐块渲染的对象是绝大多数记录，不是边角形态。调用块 58776/58776 三样齐全
  （`id` / `name` / `arguments`）。

  > **`tool-call` 块的字段名是 `id`，不是 `callId`**（2026-10-05 发现的一处真 bug）。
  > 契约 `@deepseek-ai/dsh-llm` 的 `ToolCallBlock` 是 `{ type, id, name, arguments }`，
  > 官方投影层一律 `String(block.id)`。`callId` 是**工具调用自己**的名字（`tool/call` 事件
  > 与 `tool` 角色的消息上）。`callIdsOf()` 当初按 `callId` 读内容块，于是 `cell.callIds`
  > 在真实日志上**恒为空**——工具行那条「助手消息」层级链接永远不出现，而它是绿的：
  > 合成夹具照着错名字写的。现在两个名字都读、`id` 优先；读取端与夹具都已改。
  > **教训**：内容块的字段名要对着 `@deepseek-ai/dsh-llm` 的类型核，而不是对着事件参数
  > （`tool/call` 的 `data.callId`）或本地那份手写声明推。

  **层级跳转**本身早在 2026-10-04 就有（助手记录 →「请求 #N」、工具 / 子工具记录 →
  「助手消息」（按 `cell.callIds` 认，见 5.1）、请求面板 →「这次请求的记录」）；
  这一轮补的是**块级入口**（「原始内容」页签里那枚按钮）。仍然不同的是**参数 / 结果的
  呈现形态**：本扩展一律是一段裸 `<pre>{JSON}`，没有官方那种可折叠的 JSON 树（`JsonTree`，
  理由见下面那条的代价核算）。

- **系统提示词替换的 diff 页签已做成行级差分**（2026-10-05）。从前它只是把
  `previousSystemPromptDetail` 与 `systemPromptDetail` **并排两段裸文本**（文档还错写成
  「结构化补丁」，已改正）：官方是 `structuredPatch`（`diff` 包，`context: 3`）出的行级补丁
  ——`@@ -a,b +c,d @@` 头 + 逐行 `+` / `-` 着色，system 与工具目录各一节
  （`TrajectoryTable.tsx` 的 `PromptDiffSection`）。本扩展逐字对齐同一套实现
  （`src/webview/trajectoryPromptDiff.ts` 的 `promptDiffLines()` + `components/PromptDiff.tsx`），
  并补上了工具目录那一节的**改动前**快照（`cell.previousPromptTools`，见字段表）。
  **落点实测**（`.agent/temp/systemPromptChanges.mjs`，455 份日志）：含系统提示词的会话
  **314 份（69.0%）**，`system/message` 共 473 条，其中**同会话第 2 条及以后 159 条**
  （这些才会出这个页签）；提示词长度中位 **6877** 字符，相邻两次改写平均差 **731**
  字符（p90 2342 / 最大 6434）——并排两段基本没法用，行级差分才看得出改在哪一行。
  代价与去处：新增运行时依赖 **`diff@^9.0.0`**（与官方同一个包、同一个大版本），它被判进
  `dist/webview.js`（+6.6 KB），许可（BSD-3-Clause）已记进 `THIRD-PARTY-NOTICES.md`
  并附全文——该许可要求随二进制分发保留版权声明与许可全文。

- **`outputBlocks` 不采**（2026-10-04 量过后否决，差的是「值不值得」不是「能不能」）：

  > **2026-10-04 用数据复核过这一项，结论与「用户能感知的缺口是复制」那句不一样**：
  > `node build/trajectory-gap-probe.mjs` 扫本机 440 份日志、55433 次工具调用，量的是
  > 「折叠树到底有没有东西可折叠」——参数是 JSON 对象的占 99.99%，但**带嵌套容器的只有
  > 1229 次（2.2%）**，其中序列化 >512 字符（一眼看不完那种）463 次；而且这 2.2% 几乎
  > 全落在两只工具上（`todo_write` 的 `todos` 507 / `ask_user_question` 的 `questions` 366）。
  > 结果的 JSON 对象 787 条（1.4%）、多块结果 166 条（0.3%）；请求选项的嵌套是 **0**，
  > 因为服务端的 `header.config` 顶层**只有** provider / model / reasoningEffort /
  > maxTokens 四个标量键（我们那份 `headerConfig()` 取的 7 个已是超集，选项面板没有漏字段）。
  >
  > 所以：**97.8% 的参数是扁平对象，折叠树对它们与一段 pretty JSON 没有可见差别**；
  > 真正需要它的只有 2.2%，且集中在两只工具上。这一项仍然算差距（官方有、我们没有），
  > 但优先级应当排在「会发生」的那些之后——**已知会发生的长行问题（>512 字符的 27%）
  > 才是复制 + 换行那一项解决掉的**。
  >
  > 代价侧（也在本机官方源码里核过，比早先记的更大）：`ui-primitives` 的
  > `JsonTree.tsx` **850 行** + `JsonTree.module.css` **345 行**，静态依赖 `Menu.tsx`
  > **564 行**（`JsonTree` 的复制菜单有 5 个条目：复现值 / 紧凑 JSON / 属性路径 /
  > pretty JSON / 对象紧凑 JSON）、`icons/index.tsx`，以及 CSS 里的 **8 个 `--dsw-*`
  > 设计令牌**——我们**一个都没有**（它们由官方 `ui-theme` 的 `design-platform.css`
  > 定义，链接到 VS Code 主题变量需要一个映射层）。即：**不是复制 850 行就完事**。
- 从对话跳进轨迹（官方 `viewRequest.focus` 的 `inspectCallId` 链路）**已做**，见上。
- **计时面板已与 `RecordTiming` 同源**（2026-10-05）：官方 `RequestTiming` 的第一分支是
  「该请求有助手记录 → 整块改用记录级面板」（`RecordTiming` 吃的是那条助手记录，不是请求
  表），只有拿不到助手记录才用请求表自己那三行；本扩展照同一支分派
  （`Trajectory.tsx` 的 `RequestTimingPanel` / `RecordTimingPanel`，助手记录与落点按官方
  `selectedRequestAssistant` / `selectedRequestAnchor` 的判据挑）。连带的**记录面板本身**
  也照官方 `RecordTiming` 补齐了两条：
  1. **助手记录那一支的第五行是「吞吐量」**（官方 `AssistantTimingPanel` 的
     `throughput()`：输出 token 数 ÷ 解码时长，五道守卫按官方顺序）。从前那里画的是
     「输出 N」（token 数）——token 数在用量区本来就有，官方那一格是吞吐量；
  2. **其余记录那一支**是「开始时刻（`cell.startedAt`）/ 时长（`cell.timeSeconds`）/
     计时来源」三行；从前工具行读的是助手那一套 metrics，于是永远显示「未记录」。
  两条判据的纯函数在 `trajectoryDisplay.ts`（`trajectoryRecord*`），断言逐条钉住。
  **助手记录概述里的「请求计时」一节已补**（2026-10-05，官方 `timing.request`）：内容是
  这一格的记录级计时**缩略**（`RecordTimingPanel preview`），点标题跳到**它那次请求**的
  计时页签（官方 `selectRequest(target, 'timing')`）。守卫收在纯函数
  `trajectoryAssistantRequestNumber()` 里，三条与官方同源：只有助手记录给
  （压缩行的请求号是**压缩请求**的号，拿它当「这次请求的计时」是对错了对象）、这一格要有
  请求号、那个号要能在请求表里解析出来（**不兜底到别的请求**）。点进去时请求检查器要
  **同时**拿到目标页签（`requestTab` → `initialTab`），否则用户点了「请求计时」却落在
  概述上，像是没生效；点账本行那枚请求小标记则把这个目标清掉（那个入口一律回概述）。
  （时长标签已于 2026-10-04 分开：请求面板用 `timingDuration`「时长」，与官方的
  `timing.duration` 一致；记录面板仍是 `timingTotalDuration`「总时长」。）
- 来源：`source.unknown`「未知」已登记（来源对象在、但 `kind` 缺失）；`source.messageJson`
  「消息来源 JSON」那句标题**已补**（2026-10-05，「来源」页签的 JSON 上方那一行，
  与「请求选项 JSON」同一枚标题样式——官方是把它交给 JsonTree 当标题）。
- 记录级的「错误」那一行是**本扩展特有**的（核过官方 `TrajectoryTable.tsx`：记录检查器
  里**没有**这一行，错误只在**请求**检查器里显示，走 `requestErrorMessage()` 的
  `AUTH → details.failure.auth`）。所以它没有「与官方一致」的对象，只有一条自定的口径：
  **宿主写的语义记号要换成文案，服务端原话原样显示**（`trajectoryCellError()`，
  2026-10-04）。从前 `@interrupted` 被原样渲染，用户看到的是那个内部符号。

**搜索**：

- 匹配语义与呈现已与官方一致（见 3.6，索引就是 vendor 的那份）。输入侧 2026-10-04 已补齐
  **`schemaDetail`** 与**助手行的 `sourceBlocks`**（对应官方字段表里的 `cell.schemaDetail` 与
  块级 `type` / `content`），现在 **没有字段是空的**——这一条从差距清单里销掉。补齐时量过
  真实日志（446 份），两处都不是「照官方清单补作业」，各有实测依据：
  - **`schemaDetail`**：调用时的工具目录 100% 查得到 schema（57147/57157），采集成本是逐调用
    存一份 JSON 文本。官方也是逐调用挂（`callSchemas` 是 Map、格子逐个引用），但同一份 schema
    平均被挂 **16.6 遍**（985 条工具行的会话只对应 12 份不同 schema），逐调用存共 2285 KB、去重
    只需 20.2 KB。宿主侧已按对象身份复用同一个字符串（见 `schemaDetailOf()` 的 `intern` 参数），
    **线上载荷仍是逐格一份**（不变形状、搜索索引才能逐格取到）。要再省就得改数据流（格子上存
    `{headerSeq, toolName}` 引用、界面按目录回解），代价是多一层间接与一处回解逻辑。
  - **`sourceBlocks`**：助手行的 `tool-call` 块实测 **57095/57095 全部带 `name` + `arguments`**，
    而这些值在 `text` / `previewMarkdown` / `inputDetail` 里一个都没有（`text` 是本地化文案、
    `previewMarkdown` 是正文）——不采就是搜不到工具名与调用参数。`reasoning` 块则与
    `thinkingDetail` 重复，采它是为了形状与官方一致。
- **`outputBlocks` 不采**（2026-10-04 量过后否决，差的是「值不值得」不是「能不能」）：
  官方三处写它——工具结果（35437 处）、压缩摘要（8 处）、助手消息。工具结果那处的内容就是
  内层 text 块的原文再套一层 `tool-result` 信封的 JSON，而那份原文已经原样在 `outputDetail` /
  `resultPreviewMarkdown` 里、搜索面早就有它；再采一遍等于把同一份结果文本存两份（实测 35k 块、
  合计 7400 万字符）。压缩摘要那处同理（8 处里 1 处带 tool-call 块）。真要动手的触发条件是
  **界面要用到它**：官方 `outputBlocks` 在界面上有两个用处（图片块的结果渲染、单 text 块的
  结果判据），本扩展都还没做——**2026-10-05 的逐块渲染（见 5.2 第一条）也没做它们**
  （那一轮只做 `sourceBlocks` 那一半），所以这条否决仍然成立。
- **`promptDetail` / `previousPromptDetail` 已经在喂**：`trajectoryVendor.ts` 的
  `promptSnapshot()` 把 system 行的 `systemPromptDetail` + `toolsDetail` 合成官方那个
  `{system, tools}` 快照。官方那份多带一个 `config`，但 `config` 的四个键（provider / model /
  reasoningEffort / maxTokens，实测 731 个 header 的顶层键就这四个）已经在 `provider` / `model`
  两个散字段里，搜索面上没有增量。
- **请求级的选项不在搜索面上**：官方的搜索索引只吃账本记录（`recordSources()`），
  请求表的 `requestConfig` 官方同样不索引。


### 5.3 「完美搬运」的可行边界（2026-10-03 结论，2026-10-04 落成 vendor）

官方轨迹是一个**客户端插件**（`packages/client/ui-trajectory`，约 250 KB TS/TSX/CSS），
跑在浏览器里，输入是 `TrajectorySnapshot`——由 `dsh-client-ui-conversation` 的
ConversationNode 装配层从同一份 durable 事件折出来的中间层。本扩展没有那一层：宿主直接
从原始事件折（`dsh/trajectory.ts`），界面自绘。结论：

- **整包逐字搬运不可行**。要连带搬节点装配、`ui-slots` 的插件运行时、`ui-primitives`
  的 markdown 与主题，最后还得把它们的 `--dsw-alias-*` 令牌层接到 VS Code 主题变量上；
  代价是整页重写 + 一套外来运行时，收益只有轨迹这一页。
- **该搬的是「纯决策」，而且已经搬了**：行文本、预览截断、时间线投影、搜索索引这四块
  现在是 `src/vendor/` 里的**上游源码逐字副本**（见 3.7），不再有「手工等价实现」。
  这一条曾经是「应当逐个镜像成同名函数 + 断言」，2026-10-04 落成了 vendor——理由正是
  下面第三条：手抄会漂。
- **剩下的差距是「输入」而不是「逻辑」**：官方那份折叠吃的是 `TrajectorySnapshot`
  （`ui-conversation` 折出来的节点层），我们没有那一层。所以 `layout.ts` 搬不动，
  能搬的只有不吃那层输入的纯函数。**喂错的字段照样算错**——差距清单里剩下的项
  （`outputBlocks`、`AssistantToolCalls`、`RecordAttachments` 这些形态类缺口）都是
  输入侧的活，vendor 解决不了；而**字段名读错**这一类更隐蔽：`sourceBlocks` 里的
  `tool-call` 块身份字段是 `id`（不是 `callId`），按错名字读不会报错、只是**恒为空**
  （2026-10-05 修，见 5.2）。**请求表是这条规律的另一面**：
  它同样是输入侧的活，但没有落进这个坑——官方 `RequestView` 的每个字段都能从 durable
  事件直接读出来（`step/start` 的时刻、`llm/retry` 的失败、`assistant/message` 的用量），
  所以「请求级检查器」不需要节点层也能对齐；反倒是**读错了事件**（从助手消息读一个不存在的
  `startedAt`）才会漂。
- **漂移靠机制发现，不靠自觉**：`dsh:watch` / `dsh:check` 只追踪消费的服务端契约包，
  不检测官方轨迹 UI 单独漂移。当前固定官方基准为 `dsh-v0.2.0-rc.2` 的
  `639ed015397290b3745d163aafe02ffee4aa3f84`，不是官方 checkout HEAD。
  [来源锁](<../scripts/vendorSourceLock.json>)与[锁校验](<../scripts/vendorSourceLock.ts>)双向核对
  11 份官方原文字节见证和 vendor；只规范化模块说明符，不压缩空白或改写字符串、模板、正则与 ASI。
  [变异回归](<../scripts/vendorSourceLock.test.ts>)与[适配回归](<../scripts/trajectoryVendor.test.ts>)
  验证来源／输入，展示判据与交互 seam 回归验证真实消费者的规则。上游同步方法见
  [vendor 索引](<../src/vendor/README.md>)。
- **实证与授权分别约束**：[对拍入口](<../scripts/trajectoryAlignProbe.ts>)和
  [观察入口](<../scripts/trajectoryGapProbe.ts>)必须显式使用当次获准的停止源，不默认扫描用户目录。
  普通标准回归不读用户日志、不启动服务端或模型。新旧信封、JSON 候选／成功／失败、
  已比较／未比较／错配各有分母；零样本不等价于一致。历史全库的 2.2%／0.3% 只解释当时产品取舍，
  不是当前读取算法的新比例，也不是日志完整性或性能证明。形态能力先测收益，正确性缺陷不按频率豁免。


### 5.4 服务端调用

**不需要任何新的 RPC**：官方轨迹的全部输入都在 `session/follow` + `session/page` 里，
`session/*` 远程方法里没有 `trajectory*`。唯一实现细节：`session/page` 的 `throughSeq`
只能取自 `session/follow` 开帧的 `snapshot.cursor`；本扩展用「固定开帧 cursor + 动态
`earliestSeq()` 作 `beforeSeq`」，与官方等价（官方侧由 gateway 内部管理，是否同构未确认）。

## 6. 证据不足 / 无法确认

> 这一节就是差距清单里的**未确认**桶：只记「还没查清什么」，不是待办。查清一条，就按
> 结论把它落进上面三个桶并从本节删掉。

- 时间线 lane0 内部是否还有排序 / 分层规则未见（重叠处理在 CSS，不在 JS）。
- 那批「零**渲染**」的 key（`kind.message`、`kind.sub`、`column.*`、`record.json`）是留给
  未来还是死键，仍无法判定。**2026-10-04 更正**：本节曾把它们写成「零引用」——那是错的，
  `kind.message` 在 `TrajectoryCell.tsx`、`column.*` 在 `TrajectoryTurnHeader.tsx` 里都有
  引用，只是那两个组件在上游**无人 import**（`index.ts` 也不导出），所以界面上看不到。
  正确的判据是「组件有没有被装配」，不是「key 有没有被引用」。
  （**2026-10-04 更正**：这里曾把 `record.parametersJson` 也列进来，那是错的——
  它在 `TrajectoryTable.tsx` 的 `ProgramInput` 里是 `JsonTree` 的标题。）
- 官方那一族 key 里哪些是死键：**2026-10-04 更正过一条错的**——本文 §6 曾把
  `kind.message`、`column.output` / `column.think` / `column.time` 列为「零引用」，
  实际它们**都有引用**（`TrajectoryCell.tsx` / `TrajectoryTurnHeader.tsx`），只是那两个
  组件本身在上游无人 import，所以界面上看不到。剩下的 `kind.sub` / `record.json` 同上：
  零渲染 ≠ 零引用，判据要看**组件有没有被装配**，不能只 grep key。
- 官方按 `callId` 跳工具概述对 subtool 不成立（subtool 的 callId 与父 tool 不同），
  是缺陷还是有意，未确认。
- `session/page` 之后官方 `throughSeq` 是否变化未确认（gateway 内部）。
- `assistant/attempt` 与 `assistant/message` 都是首 token 时刻的来源；官方
  `settleTiming()` 以 `firstTokenTime ?? assistantStreamFirstTokenTime(stream)` 保留先到者。
  读取必须识别合格 raw delta 和 packed `time0/dt`，不能把非 token 帧或任意首帧时刻当作 token。
  具体实现与当前未关闭时序见「首个 token 时刻的两条来源」说明及[轨迹回归](<../scripts/trajectory.test.ts>)。
- 官方账本行的 `data-*` 属性是跟随实现而非声明的公开契约，样式 / 测试挂钩时自担风险。
- **时间线的 hover 命中不要自己重算条的矩形**（2026-10-04 踩过）：三条泳道各 8 设计像素高、
  步进 13（`top` 4 / 17 / 30），所以条与条之间横竖都有「缝」；而条的绘制还要再让出
  `min(宽度 × 8%, 1px)` 的次像素缝隙。自己按域范围（首尾相接、没有缝）推命中，会出现
  「指在条上却算在缝里」或反之——表现为跟随竖线永远不出现、高亮环套在**另一条泳道**的
  条上（实测 1104 个采样点里 60 个错）。**正解是问 DOM**（官方读 pointer 事件的 target，
  等价的 `elementFromPoint` + `closest('.trajectory-span')`），实测降到 0.19%，
  且残差全在条边界的次像素列上（浏览器自己的舍入）。
- `AssistantMetricDetail.usageProvided/outputTokens` 的单位无注释（从用法读是 token 数）。
