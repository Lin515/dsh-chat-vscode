# 投影与面板一致性审计（一次性报告）

> 本文是 projections & panels 专项审计的一次性分报告，判定定格在审计当时；多数「不一致」
> 此后已修，现状以 [`audit-summary.md`](audit-summary.md) 的「零、修复状态」为准，**不要照着
> 本文重复修一遍**。什么时候读：重做三个未做面板（schedule / agentPreset / subagentTiming）
> 取契约（§15、§16、§6）时，或查投影 seq 水位线语义（§17）时。结论按 **一致 / 不一致 /
> 无法确认** 标注，各条附置信度。

## 0. 投影键总表：官方 20 键 vs 扩展消费 10 键

官方 `SessionProjectionMap` 本体 11 键：`inbox`、`agentPreset`、`title`、`todos`、
`sessionListMetadata`、`imageLimits`、`modelSelection`、`subagentCatalog`、`subagentTiming`、
`subagent`、`goal`；另有 9 键由各功能包 `declare module` 合并进来：`permissions`、`plan`、
`tokenUsage`、`contextPressure`、`contextBreakdown`、`sessionStats`、`turnOutline`、`schedule`、
`agentPreset`。合计 **20 个 client 可见键**（原文快照口径）。

扩展的 `applyProjection`（`src/dsh/controller.ts`）只消费 **10 个**：`modelSelection`、
`permissions`、`plan`、`todos`、`title`、`contextPressure`、`contextBreakdown`、`sessionStats`、
`subagentCatalog`、`goal`。`jobs` 不走投影，走 `session/control` 的 jobs 帧（list mirror），
与官方一致。官方 UI 经 `useProjection(` 消费投影；其中 `subagentCatalog` 官方 UI 不直接读
（面板走 `subagent/list` RPC 的同构行）。

**扩展整项丢弃的投影（官方 UI 用户可见）**：`tokenUsage`、`turnOutline`、`imageLimits`、
`schedule`、`sessionListMetadata`、`inbox`、`subagentTiming`、`subagent`（身份）；
`agentPreset` 当时也在其中，2026-09-22 起已消费（§16）。

---

## 1. modelSelection（模型选择）—— 一致（选择值）/ 不一致（默认值与可路由性）

官方 wire 形态 `{lastUsed, next}`，`next` 已在服务端折好（`pending ?? lastUsed`）；官方 UI 取
`next ?? catalog.default`（回退到 `session/modelCatalog` 的默认模型），并把「provider 是否
可路由」记入 `routable`，不可路由时阻断输入区。

扩展读 `next ?? lastUsed`——与官方等价（wire 上 `next` 为 null 时 `lastUsed` 必为 null）。
三处不一致：

- **默认模型来源**：扩展丢弃目录的 `default` / `routableProviders` / `failures`，默认模型改读
  设置命名空间。两处通常同源，但契约不等价：若设置与 `catalog.default` 不一致（例如运行时
  被别的调用方改过），扩展开场显示的模型胶囊可能与实际会用的模型不同；目录缺失的 provider
  也不提示。置信度：中。
- **不可路由阻断**：扩展无对应逻辑，选到不可路由 provider 要等发送后由服务端报错。
  置信度：高。
- **contextWindow 来源**：官方模型目录契约里没有 `contextWindow`；扩展的模型视图该字段从不
  赋值，唯一来源是 `contextPressure.contextWindow`（即官方明确「不必与压力原子配对」的
  字段），悬停/占用条分母偶尔是旧 provider 的容量。置信度：中。

## 2. permissions（权限胶囊）—— 不一致

官方契约：投影为 `{options, currentValue}`，菜单的选项集合、显示名、描述**全部由投影驱动**；
派生的 `custom` 会成为 `currentValue` 但不进菜单；官方默认预设表只有 `workspace-write` 与
`danger-full-access` 两条。

扩展只读 `currentValue`，`options` 整个丢弃，菜单硬编码 `read-only` / `workspace-write` /
`danger-full-access` 三条（`src/webview/components/Composer.tsx`）。后果：

1. 部署自定义预设表（改名、加减条目、只配 `read-only`）时，扩展显示的三条与宿主不一致；
2. `currentValue === "custom"` 时（宿主明确会派生该值）胶囊静默回退为 `workspace-write`，
   用户看到**错误**的当前权限；
3. 若部署未配置 `read-only`，扩展仍把它作为可选项发出 `/permission read-only`。

置信度：高（代码级确定）；严重性取决于具体部署的预设表配置。

## 3. plan（计划模式）—— 不一致（`pending` 被丢弃）

官方契约：`{active, pending}`——`active` 是已落地的状态，`pending` 为真表示「已记日志的
`/plan` 选择指向另一状态、尚未失败、且之后没有记录到该状态」。官方 UI 按**有效目标态**
`pending ? !active : active` 显示计划模式 chip，同一谓词也用于输入区。

扩展只取 `active`，`pending` 从未读取，转而用**客户端乐观态**（仅 UI 点击「进入计划模式」
时设置的本地状态）补足。后果：进入计划模式的过渡窗口内官方立刻显示 chip，扩展不显示；
经 `/plan` 命令或另一客户端发起的切换，扩展的乐观态为空，UI 滞后到事件落地才有反应；退出
时扩展在整个 `active` 为真的窗口都显示「已进入」。置信度：高。

（通则：投影里 `pending` / `wanted` 这类待提交值与已提交值成对出现时，生效状态是**两者的
组合**，不是任何单个字段——`plan` 只是一个实例。）

## 4. todos（任务清单）—— 一致

官方投影为 `TodoItem[] | null`（每条仅 `content` + `status` 三态词表，无 id/priority）。
扩展逐字同词表，`null → []` 与官方 UI 等价；`id` 为扩展自造，仅渲染 key 差异，无语义影响。

## 5. 上下文占用 contextPressure / contextBreakdown —— 不一致（分子口径 + `projectedTokens` 丢弃）

官方语义：`pressureTokens` = **prompt 侧**（uncached input + cache read + cache write，
**不含 output**）；`projectedTokens` = 该样本 + 其后 surface 的带符号增量（压缩会使它下降
——这是 `pressureTokens` 单独做不到的）。契约明确三者不是同一次请求的原子观测：切换模型
可能让新容量配旧压力。官方占用条分子取 `projectedTokens ?? pressureTokens`，且必须同时有
分子与 `contextWindow` 才渲染 meter。

扩展只读 `contextWindow`，`pressureTokens` / `projectedTokens` 从未消费；分子自算，用最后
一条消息的 `usage.totalTokens`（**含 output**），分母来自 `request/context` 事件（不是投影）。
三处不一致：

- **A 分子口径**：官方 prompt 侧 vs 扩展 prompt+output，占用条系统性偏高，幅度≈最近一步
  的 output token（典型 0.3%–2%）。置信度：高。
- **B 压缩不可见**：扩展分子只在助手消息到达时更新，压缩后官方占用条立刻下落，扩展仍显示
  压缩前占用，直到下一轮消息落地。置信度：高。
- **C 显示门限**：官方须有分子且有分母才渲染；扩展的 `CtxText` 有第二兜底（用模型目录/
  `request/context` 分母本地重算百分比），可能在官方不显示 meter 的状态下显示。置信度：中。

`contextBreakdown` **一致**：`{systemTokens, toolsTokens, messageTokens}` 字段一一对应；
官方口径「三者相加 ≠ `projectedTokens`，只能当构成近似呈现」，扩展逐行显示、不求和——一致。

## 6. 子代理 subagentCatalog / subagent / subagentTiming —— 三个契约，勿混

**官方契约**：

- 投影 `subagentCatalog`：`SubagentCatalogEntry = {id, createdAt} + mode`——`'one-shot'`
  （`label` 可选）或 `'continuable'`（`label` 必填）。**没有 `kind`，也没有 `activity`。**
- RPC `subagent/list` 的返回行是**另一个契约**：才有 `kind: 'child'` 与
  `activity: 'running'|'inactive'`，另有 `SubagentCatalog {entries, parentAvailable}`。
  官方面板的 activity 来自这里；运行时长来自投影 `subagentTiming`（经 session-list 的
  `projectionValues` 读取）。
- 投影 `subagent`（身份，`SubagentIdentityProjection | null`）：宿主用它校验地址模式——
  打开子代理时 `identity.mode` 必须与 `address.mode` 一致，否则报 `subagent/unauthorized`。

**扩展当时的错误**（形状混用 + `mode` 丢弃）：

- 把 RPC 行的过滤（`kind === "child"`）套在**投影**上——投影条目没有 `kind`，结果**恒为
  空数组**，且每次（重）连接、每次投影变化都会把子代理列表重置为空并广播
  `parentAvailable: false`；同一扩展在 RPC 路径上用的却是正确形状——两处混用。面板表现为
  「无子代理」，直到用户再点一次按钮走 RPC。
- `mode` 两条路径都丢弃，打开子代理一律发 `mode: "continuable"`：打开 `one-shot` 子代理必被
  宿主拒绝，界面上只表现为面板内容为空。置信度：高（两处都是代码级确定）。
- 不读 `subagentTiming`（导航下拉没有运行时长），也不读 `subagent` 身份投影。
- ~~刻意差异（非缺陷）：子代理对话是静态快照（无实时流 + 定时收尾），官方是实时流的只读
  输入区。~~ **已于 2026-09-24 消除**：子代理对话改为**会话级切换**（`openSession` 带子
  代理地址，`session/follow` / `session/page` 都按地址打开），与官方同为实时流；可继续
  子代理可继续对话（`subagents/prompt`），一次性子代理输入区换成只读说明（官方
  `SubagentReadOnlyComposer` 同款选举）。入口同步对齐官方：标题右侧的计数触发器 /
  面包屑（`SubagentHeaderLineage` 同款），独立按钮与只读快照抽屉已删。

**2026-09-25 同级切换缺陷**（已修，行为级回归在 `scripts/subagentSwitch.test.ts`）：
从子代理页切到另一个兄弟时，切换下拉里只剩自己、兄弟不可见。根因是**会话域的生命周期**
（视图离开即回收，`dropViewers` → `destroyScope`），不是目录取数——`parentCatalogOf`
读父域目录的口径一直是对的，但切到第二个子代理时**父域已经不在**：

- 新域的兄弟快照落空，首帧快照里只剩「兜底自己」那一行（label 还退回会话 id）；
  修法：`openSubagent` 把手里命中的那份父目录**随行**传给新域（`openSession` /
  `ensureScope` 的 seed 参数），切换后的第一帧就有完整兄弟清单；`running` 打底也改读
  刚落好的种子（原写法先读后写，父域不在时读恒空）。
- 异步的 `fetchParentCatalog`（恢复路径唯一来源）补齐后**通知发错对象**：
  `syncSubagentContext(本会话id)` 的参数语义是父会话 id，通知的是「看它子代理的窗口」，
  看本会话的窗口一条都收不到——缺陷永不自愈。补齐后必须把重算的 `subagent` patch
  **直接发给看本会话的窗口**。
- 推论：任何「进入时从父域取数」的路径都要按「父域可能不在」设计——同步给种子、
  异步有回填、回填的通知对象是看本会话的窗口。

## 7. jobs（后台任务面板）—— 一致（数据词表）/ 不一致（入口与状态色）

数据**一致**：官方五态 `running/stopping/completed/killed/failed`，扩展逐个枚举、字段一一
对应（未知状态扩展兜底为 `completed`、官方直接抛错，生产上词表不会不匹配，视为一致）。

两处不一致：

- **入口可见性**：官方按钮只在会话有任务时渲染并带 live/idle 计数；扩展常驻、无计数徽标，
  空态显示「无后台任务」。视觉噪音，无数据错误。置信度：高。
- **状态色**：官方 `stopping` 与 `killed` 共用警告（attention）色；扩展 `stopping` 画成运行
  蓝、`killed` 无色——被取消/正在停止的任务看起来仍在正常运行。置信度：高。

## 8. sessionStats（会话统计）—— 一致（数据）/ 不一致（呈现）

数据**一致**：官方八字段 `turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens`，
扩展全读、语义逐字对应。

呈现**不一致**：官方是输入区常驻胶囊（turns/steps + tok/s）+ 点击对话框，投影缺失时还有
派生回退；扩展只塞在 tps 悬停标题里——tps 拿不到时整个入口消失，且从不显示 turns/steps
（官方胶囊的主标签就是这两个计数），全日志统计没有常驻可见入口。置信度：高。

## 9. tokenUsage（会话累计用量）—— 完全丢弃

官方契约：全会话**累计**用量，四桶不相交（`uncachedInputTokens / outputTokens /
cacheReadTokens / cacheWriteTokens`）；官方渲染用量胶囊 + 分桶对话框（计费输入 = 三桶输入
之和，总计再加 output）。

扩展不消费该键；唯一用量展示是 `CtxText` 悬停里的**单步**缓存命中率。注意：扩展的
`message.usage` 是**最后一步**用量且每次覆盖，官方单轮用量是整轮所有 attempt 的聚合——
扩展连「本轮总量」也拿不到。置信度：高。

## 10. turnOutline（轮次大纲）—— 完全丢弃

官方契约：整份日志每个已开始轮次的大纲 `{turn, seq, prompt, response}`，与客户端分页进来
多少无关；官方用它拼轮次导航轨，未加载轮次也能显示 prompt/response 预览并跳转。

扩展未消费，也没有任何轮次导航/大纲 UI。长会话无法按轮跳转、看不到未加载轮次预览。
置信度：高。

## 11. imageLimits（附件限额）—— 完全丢弃

官方契约：`{maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, maxImagePixels,
maxImageDimension, mediaTypes}`；官方 UI 用它做**入队前**校验（张数、单图字节、总字节），并
用同一投影把服务端 `session/attachment-invalid` 的 reason 翻成带具体限额的本地化文案。

扩展不消费；图片准入只看扩展名映射与「当前模型是否接受图片」（外加非图片文本 512 KiB 内联
上限），**没有任何字节/张数/总大小上限**。超限图片会被加进输入框并编码成 base64，直到发送
才被宿主拒绝，错误文案是原始 reason。置信度：高。

## 12. title / sessionListMetadata / 会话列表

- `title` **一致**：RPC 列表行与投影推送两处都读。小差异：`title` 变 `null` 时扩展不清旧标题。
- `sessionListMetadata`（`{blank, lastPromptAt}`）：扩展不读该投影键，但用的是服务端已折算
  好的 `SessionSummary.blank`——**数据本身不丢**。
- **blank 会话可见性**：官方隐藏非当前的 blank 行并把标题本地化为「新建会话」。**✅ 2026-09-22
  已修**：会话改为**惰性建立**——「新建对话」只把窗口退回空态，第一条真正需要会话的动作
  （发消息 / 加附件 / 跑命令）才 `session/create`（不变量见 `scripts/invariants.test.ts`）。
  **✅ 2026-09-24 补齐配套两条**：① `/` 与 `@` 菜单也要会话（命令目录与文件候选都是
  `@RemoteScope('agent')`，没有无会话端点），所以它们进了「按需建会话」那张名单
  （`ensureSessionForMenu`；目录没定时不建也不弹目录选择器，界面用「未选择工作区」解释空菜单）；
  ② 服务端的 `blank` 位终于被消费——历史列表与 `@` 对话候选都挡掉没开始过对话的行
  （`emitSessionLists` / `visibleSessionCandidates`），否则菜单按需建的那条会在列表里留一行
  空记录（正是 2026-09-22 报的现场）。同一窗口重复建会话会**复用**自己建出来的那条空会话
  （`reusableBlank`，官方 `ui-workspace` 的 `reuseOrCreateBlank` 同一口径）。
  **一处有意的差异**：官方是「隐藏 blank，但显示**当前选中的**那一条」，扩展挡掉全部 blank
  ——列表是所有窗口共享的一份（`emitAll`），「当前那条」按窗口各不相同，要那条语义就得先有
  按窗口发出的列表；挡掉全部在观感上等价（正在编辑的会话本来就在正文里，不靠列表指认）。
- 子代理会话过滤**一致**：官方 `origin !== "subagent"`，扩展等价。
- 归档与 cwd 过滤：官方按 `archived` 集合；扩展是本地删除集 + 只显示 `cwd === 当前工作区`，
  其他 cwd 的会话不可见——行为确定，是否符合扩展定位属设计判断。
- 列表顺序：官方按 `updatedAt` 降序且服务端已把 `lastPromptAt` 折进 `updatedAt`，扩展直接用
  该字段——**实际等价（经服务端折算）**。

## 13. inbox（排队消息）与 steering 呈现

**状态更新（2026-09-18）**：审计当时「扩展不消费 inbox 投影」——服务端 2026-09-09 起删掉了
`session/control` 的队列帧通道，队列只剩 `inbox` 投影这一条来源，扩展当时只读旧通道，待发
列表**整体消失**（用户报的现场）。现在扩展**双读**（inbox 投影 + 旧 queues/queue 帧），折算
在 `src/dsh/queueView.ts`（`queueItemsFromInbox` / `queueItemsFromWire`）。

**契约**：`session/control` 队列帧的 `SessionQueuedItem {placement: 'queued'|'steering'|
'context', rpcId?, message}` 是投递前的权威快照；`inbox` 投影是持久化 splice 折出的两段待
投递列表（`'next-turn'` / `'next-step'`）——**两个东西，勿混**。

- **`context` 丢弃：一致**。官方两个呈现面都不渲染 `context`（排队坞只取 `queued`，steering
  面只取 `steering`），扩展同样丢弃。
- **steering 呈现位置与计数：不一致**。官方把待投递 steering 作为**对话流内联气泡**，出现在
  对应轮次的位置；扩展把 `queued` 与 `steering` 合并成输入框上方一条「排队中」状态条并计入
  条数——插话显示成「排队的用户消息」。置信度：高。
- **user/message 的 steering 分类：不一致**。官方按 inbox `'next-step'` 认领集把
  `user/message` 分成 `steering` 或普通 `user`；扩展只有「user / 其余」两分法，**没有
  steering 分类**，历史里的插话与普通用户消息完全同形。附注：`'user-rpc'` 是消息来源映射的
  **键**，其 `kind` 字段是 `'user'`，扩展按 `kind === "user-rpc"` 的判断在线上不会命中，属
  多余分支（不构成可见差异）。置信度：高。

## 14. context 注入节点（durable 非用户消息）—— 不一致（字段名与派生标签）

官方节点契约：`kind: 'context'` + `provenance {role: 'inject'|'recall', label}` + `form`（六个
已知形态 `instructions/catalog/snapshot/notice/relay/recall`，**未知形态一律置 null 走不透明
呈现**）；`role` / `label` 按来源分派，recall 的 label 是会话标题列表。

扩展：`form` **不做白名单校验**（未知形态当已知透传）；没有 `role`/`label` 概念，界面按
`sourceKind`/`plugin` 硬映射少数几个 kind（`system` / `agent-instructions` / `skill-catalog` /
`plugin` 等）。后果：跨会话 recall 与普通注入同样显示为「自动载入」；未知 `form` 被原样显示
成 detail 文本而不是「不透明」。置信度：高。

## 15. schedule 契约（面板未做，重做必读）

- 官方契约：投影 `schedule: readonly ScheduleRecord[]`；`ScheduleRecord` 是 `After | At |
  Every` 三种调度记录（含 `id / prompt / scheduledAt / state`），由 `schedule/change` 事件
  折叠。
- 官方两处用户可见：① 定时提醒目录（`useProjection("schedule")`）；② 工作区列表的「有待
  触发提醒」指示（`projectionValues.schedule.length > 0`）。完成提醒（`completed`）的具体
  呈现未定位到渲染代码，见文末「无法确认」。
- 扩展当时：**完全未消费**——模型经调度工具创建的提醒在扩展里没有任何入口可查看。
  置信度：高。

## 16. agentPreset 契约（✅ 2026-09-22 已修；含落地细节，改动时按这套走）

官方契约：投影 `agentPreset: string | null`，注释强调**「重建读取 `agentPreset` 会话投影，
绝不只看 header」**。官方 UI 读它显示会话的 preset 标签，并有新会话的 preset 选择入口。

审计当时：扩展只是**声明过未使用**（header / `createSession` / wire 类型里都有字段，但不传、
不读）；`agent-preset/selected` 事件进了渲染白名单但适配器 switch 没有 case——落在 default
且因在白名单里而不报警。用户看不到当前会话跑在哪个 preset 下，也无法在新建时选择。

2026-09-22 落地：

- 投影进登记表：`src/dsh/projectionIngest.ts` 的 `agentPreset`（`projections.agentPresetFromProjection`）；
  域名段 `SessionScope.agentPreset`；线格式字段 `ChatState.agentPreset`（会话片段）。
- 界面：空态页一枚下拉框（`components/EmptyMeta.tsx`）；目录来自 `agentPresets/list`
  （`agentPresetsFromList`，坏预设与未开放选择的都在那里滤掉）；选择走 `agentPresets/select`。
- 新会话默认预设由设置 `dshChat.agentPreset` 决定，在 `session/create` 里带上；留空则不传，
  由服务端组装它自己的默认预设。
- 展示名照官方折叠：`trust === 'system'` 的四个用客户端词典，其余用原文
  （`src/webview/presetDisplay.ts`，断言 `scripts/presetDisplay.test.ts`）。
- `agent-preset/selected` **事件**仍不进适配器 switch（留在白名单只为不报「不认识的事件」）：
  状态走投影帧；切换成功后宿主自己也写一次域字段（`selectAgentPreset`），两条路不打架；
  命令目录的失效另由 `configChanges` 处理。

## 17. 投影消费框架语义：seq 水位线

**官方语义**（projection store 三条规则）：

1. **按 seq 丢弃过期值**：每键记 `(value, seq)`，应用时 `seq` 更小**或相等**都不覆盖
   （higher seq wins；重放与过期帧直接丢弃）。
2. **基线播种**：baseline 以 `asOfSeq` 为切点播种各键，并**清掉基线未携带、且 seq 不高于
   asOfSeq 的键**——「基线里没有的键 = 该切点上能力不存在」。
3. **世代替换**：新基线到来时丢掉水位高于新切点的旧行。

**扩展当时**：设计注释宣称有第 1 条规则，代码没有——projection 帧不读 `seq`，baseline 与
follow snapshot 只遍历 `values`、不读 `asOfSeq`、也不清理缺失键；`seq` 字段声明了但全仓
未用。

**要不要紧**：`session/follow` 的快照（带自己的 `asOfSeq` 切点）与实时 projection 帧是两条
流，投递顺序无保证；旧快照后到会把更旧的 `permissions` / `plan` / `modelSelection` / `todos` /
`contextBreakdown` / `goal` 写回界面，直到同键下一次变更才纠正；重连（新 baseline）也不会
清掉已消失的能力键。置信度：中高（代码级差异确定；触发需要具体的流交错时机，未实测）。

## 18. 排序：真正重要的差异

1. **goal 双向失效**：契约是**嵌套**的 `{goal: {...}, roundsStarted, createdAt, updatedAt}`
   （wire view 即 `state.current`），扩展按扁平读，`goal?.objective` 恒 undefined → 恒清空；
   且 webview 里根本没有目标面板/条。两处叠加＝目标功能完全不可见。置信度：高。
2. **subagentCatalog 形状用错 + mode 硬编码**：投影上按 `kind` 过滤恒空；`mode` 两路丢弃，
   打开 one-shot 子代理固定发 continuable → 宿主拒绝。置信度：高。
3. **交付文件完全不可见**：presented 解析了但无人渲染，工具行 files 有渲染分支但从未赋值，
   也没有官方「从 write/edit 参数派生本轮产物」的逻辑。置信度：高。
4. **占用条分子口径错**：官方 `projectedTokens ?? pressureTokens`（prompt 侧 + 压缩增量），
   扩展用 `totalTokens`（含 output）且丢弃 `projectedTokens`——系统性偏高且对压缩无反应。
   置信度：高。
5. **imageLimits 未消费**：无张数/单图/总量预校验，超限图片一路编码到发送才被拒。置信度：高。
6. **permissions.options 未消费 + custom 静默误显示**：硬编码三条；custom 回退成
   workspace-write。置信度：高。
7. **tokenUsage 未消费**：没有全会话累计/缓存命中率；连「本轮聚合用量」也没有（扩展的
   usage 是最后一步）。置信度：高。
8. **排队与插话混淆**：steering 并进「排队中」计数与位置；且无 user/message→steering 分类。
   置信度：高。
9. **seq 水位线缺失**：注释宣称有、代码没有；过期快照可覆盖新值。置信度：中高。
10. **turnOutline / schedule / agentPreset / subagentTiming / subagent 未消费**：分别缺轮次
    导航轨、提醒目录与列表指示、preset 标签与选择、运行时长、子代理身份。（agentPreset 已于
    2026-09-22 修复；subagent 身份那条的**地址路由**——follow/page/prompt/stop 按子代理
    地址——已于 2026-09-24 随会话级切换接上，`subagentTiming` 运行时长仍未消费。）
    置信度：高。
11. **blank 会话列表策略**：官方隐藏非当前 blank 行。（✅ 2026-09-22 会话改惰性建立；
    ✅ 2026-09-24 补齐：`blank` 位真的被消费——菜单按需建的会话不进历史列表也不进 `@`
    对话候选，见 §12。）置信度：高。
12. **sessionStats 只在 tps 悬停**：tps 拿不到时入口消失；不显示 turns/steps。置信度：高。
13. **jobs 面板细节**：按钮常驻、无 live/idle 计数、stopping 用运行蓝而非警告色。置信度：高。
14. **模型目录 default / routableProviders / failures 被丢弃**：默认模型走设置命名空间推导；
    不可路由无阻断提示。置信度：中高。

## 19. 官方 UI 展示、扩展整项丢弃的投影

| 投影键 | 官方用途 | 扩展 |
|---|---|---|
| `tokenUsage` | 会话累计用量胶囊 + 分桶对话框 | 无 |
| `turnOutline` | 轮次导航轨（含未加载轮次预览） | 无 |
| `imageLimits` | 附件入队前张数/大小校验 + 限额文案 | 无（改用设置里的模型模态判断） |
| `schedule` | 定时提醒目录；列表「活跃提醒」指示 | 无（§15） |
| `agentPreset` | preset 标签 + 新会话选择位 | ✅ 已消费（2026-09-22，§16） |
| `sessionListMetadata` | 冷会话列表 blank / lastPromptAt 提示源 | 无（读服务端已折算的 `SessionSummary.blank`：2026-09-24 起用于挡空会话） |
| `inbox` | `'next-step'` 认领集把 user/message 分类为 steering | 无 |
| `subagentTiming` | 子代理面板运行时长 | 无（§6） |
| `subagent` | 宿主地址模式校验；会话身份 | 无（因此 mode 被硬编码，§6） |
| `permissions.options` | 权限菜单选项集合/名称/描述 | 只读 currentValue，选项硬编码 |
| `contextPressure.pressureTokens` / `.projectedTokens` | 占用条分子 | 不读，分子自算（§5） |
| `plan.pending` | 计划 chip 的有效目标态 | 不读，改用客户端乐观态（§3） |

## 20. 已确认基本一致（不必再查）

- `todos`（词表与 null 处理）、`sessionStats`（八字段语义）、`title`（取值与列表行）、
  `modelSelection`（`next ?? lastUsed` 选择值）、`jobs`（五态词表与字段名）、
  `contextBreakdown`（三字段名与「不求和」口径）、排队 placement 丢弃 `context` 这一条、
  以及控制帧 `baseline / queue / jobs / projection` 的帧类型与按会话取值的路径。

## 21. 无法确认（保持存疑，勿当结论引用）

- 官方工作区列表对 `depth`（谱系缩进）与 `completed`（完成提醒）的呈现：确认了数据侧产出
  与可见性规则，但没有在已安装产物里定位到消费二者的渲染代码，不下结论。
- 审计部署的 `permission-presets.presets` 实际配置未知，`read-only` 是否真的不在该部署无法
  确认；可确认的是扩展**永不读** `options`，显示必然与宿主配置解耦。
- `contextPressure.contextWindow` 与 `request/context` 分母在真实会话中的分歧频率（静态
  代码无法判定）。
- 官方列表的「活跃定时任务」指示与折叠条数上限（5）扩展都没有——是否算「必要行为」属
  产品判断，不列为严格不一致。
