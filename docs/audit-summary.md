# 与 DSH Web 端的一致性审计（汇总）

**本文是什么**：本扩展 `src/dsh/`、`src/webview/` 解析与渲染路径对照官方 Web 前端的一致性审计
汇总。**什么时候读**：动投影、工具行、附件、斜杠命令、supervisor 等相关代码前先读；细节看
分报告 `docs/audit-input-queue-attachments.md`（输入/提交/队列/附件）、
`docs/audit-projections-panels.md`（投影/面板）；落地口径见 `docs/design-attachments.md`、
`docs/design-supervisor.md`、`docs/design-trajectory.md`。
对照基准：本机官方包 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`，
先读 `lib/types/**/*.d.ts` 契约、再回 `lib/client.js` 确认实现。证据等级：[实测] 起真
`dsh web` 观察（脚本在 `scripts/`）、[契约] 官方声明逐字、[代码] 本仓库事实、
[存疑] 未验证不下结论。

---

## 零、修复状态（截至 2026-09-22）

本章只记已修/未修，不改后面各节的原始判定（那是当时证据）。八批修复压成一览表（含两项
单项修复），修复过程细节见原审计与 CHANGELOG。

### 修复一览（第一~第八批 + 两项单项）

| 批次 | 一句结论 |
|---|---|
| 第一批 | `/plan` 双向（走 `commands/execute`）、手打斜杠命令（命令通道 + 命令节点渲染）、goal 投影嵌套形状（`goalFromProjection` + 目标条）、subagentCatalog 契约、交付文件渲染（`produced` + `deliverables`）全部修复 |
| 第二批 | 工具行按官方对齐（状态点只画 error/stopped、精确名表、退出码非零升级为失败）、图片 / 截断 / 重试提示、中止后合成中断结果、窗口外结果占位卡、用户非文本块保留、占用条改 `contextPressure`、`busyEnter` 接入、补消费 `tokenUsage` / `turnOutline` / `imageLimits`、附件改官方模式（图片走内容块、文件走上传、`@` 只发正文 token） |
| 第三批（配置热重载，09-12） | `$events` 的 emit 帧接入 `dsh/configChanges.ts`（含合并闸门）：settings / credentials / adapters / commands / agent-preset 各类帧触发「重读设置 + 重取模型目录」（skills 无专属帧，只能借 `commands/list` 等时机刷新）；**坑**：`llm/adapters-updated` 不是「模型目录变了」的充分信号——改已有模型档位只发 `settings/document-updated`，所以三个事件都要重取目录（官方同口径） |
| 第四批（绘制对齐，09-14） | 会话绘制逐条对齐官方：连续过程折叠（一轮只留最后正文段、其余皆折叠成员，按段内工具数判阈值 `dshChat.turnProcessThreshold`，用户点开且开着的节点不折）、思考段折叠、运行中文案、中断胶囊、轮尾用时、官方工具卡（有卡片不再渲染 IN/OUT）、代码块换行、markdown 任务列表与软换行、未知内容块、上下文条目、审批 / 提问接管卡（限高内滚；非 durable 事件，适配器单独留档并在每次 `refold()` 后补回）、目标条、文件芯片 |
| 第五批（投影摄入，09-19） | 15 个消费键集中进 `dsh/projections.ts` 读取表、新增 `projectionStore.ts`（higher seq wins、同 seq 亦负、`asOfSeq` 播种，拿不到水位不比较不清空）、`projectionIngest.ts` 映射类型（少一个键编译不过）、「先回放记录再铺投影」改为可断言；有意偏离：历史抽屉的列表标题仍 last-wins（数据自述可能是缓存） |
| 第六批（同族收敛，09-19） | 8 处「同一件事多处各写一遍」各收进一个模块：`pendingInteraction.ts`、`pendingInteractions.ts`、停止入口 `snapshot()`、会合 `decodeState` / `rendezvousPaths`、`MESSAGES` 唯一文案表、`composerCompletion.tsx`、`sessionView.ts`（跨名桥 `subagents` → `subagentEntries` 拆掉）、`autoScroll.ts` |
| 第七批（流式叠加，09-21） | 生成中离开会话再回来，思考分裂成两条：根因是对在跑的 attempt 重开 follow 不重发 start 帧与已发增量，进行中内容只在开帧 `snapshot.assistantStream.activeAttempt` 里而适配器声明了不消费；修复 = 展开器 `assistantStream.ts` + `replayActiveAttempt` 重建基线 + 增量落到模型 + 通配认领 |
| 第八批（是否在生成，09-22） | 生成中离开再回来显示成空闲且不自愈：「在跑」原只有 durable 轮次边界一条来源（长轮次 `turn/start` 会被最近 60 条消息的窗口截掉）；修复 = 截断窗口且整窗无轮次边界时不发 running 帧、接住 `api-session/status`、新建域用列表 `running` 打底，采纳策略在 `sessionStatus.ts`：有肯定证据就拒绝「不在跑」 |
| 段顺序（09-14 单项） | durable 思考 / 正文插到本 step 最早的工具行之前（官方按内容块顺序渲染），不再追加到消息末尾；只有真实流式会话看得出 |
| 分页（09-14 单项） | 翻页进展判据改为适配器返回的真实新增事件数 + `hasMore` + 顶部角色、连取由宿主驱动（`src/dsh/historyPaging.ts`），不再按「首条消息 id 变没变」判进展 |

> 第四批**刻意保留的偏离**（用户口径，别「顺手对齐」掉）：工具行实时耗时；用户消息非右对齐
> 气泡；两行文件行去重；`+N −M` 按最终结果统计（官方按编辑块计）。
> 第六批附带的**探针教训**：`queue-continue-probe` 不 import `supervisorProbeEnv`，会连生产
> 会合目录下用户真实后台（曾挂 31 分钟无输出，未修）；探针元素身份用稳定属性（如
> `data-msg-id`），别拿会变文本——夹具问题可能长得像产品缺陷。

### 占用率会「卡着不动」的时刻（本批新发现坑点，保留）

`contextPressure` **分母先到、分子后到**：投影每轮推十来次，`contextWindow` 先就位，分子要等
**下一次请求上报 usage** 才出现——期间占用条不动。结论：①逐轮变化（也是压缩后唯一会降）的是
`projectedTokens`，必须优先；②本地 `input + cached` 与官方 `pressureTokens` 逐字相等，可在投影
缺分子时同口径兜底。占用条按用户要求**常驻显示**：三个来源都拿不到时保留旧值、不清空。

### 仍未修复

> 2026-09-14 用户报的一批（问卷依次问答 / 答完收缩、`@` 列表 `..`、滚到顶自动翻页、选区行号
> 与焦点窗口、目标条展开按钮、`commit.msg.txt` 幽灵条目、工作区分组、令牌说明、扩展说明、
> 脚注、tps 口径澄清）不在分批表内，逐条见 `CHANGELOG.md`「未发布 → 用户报的一批
> （2026-09-14）」；其中工作区分组的端到端证据是探针 `scripts/workspaceProbe.ts`。

- **#17 停止语义**：官方契约说 cancel 后排队工作按 FIFO 自行接续、UI 只发一次 cancel；实测
  只 cancel 不会接续（两轮 3/3），「再提交唤醒队列项」不稳定（0/3 vs 3/3）。实测与契约冲突，
  **刻意保留**现有实现（摘空 → cancel → 重发），取舍记入 README「已知限制」。
- **§四 #16 余项**：`schedule`、`subagentTiming`（面板 / 展示层功能未做）；`permissions.options`
  目前只取 `currentValue`。
- **markdown 能力缺口**：脚注已补（`src/webview/footnotes.ts`）；**公式（KaTeX）**与
  **代码高亮（Shiki）刻意不做**——都要第三方依赖并同步 `THIRD-PARTY-NOTICES.md`，知情取舍，
  界面上公式按纯文本显示、代码块不着色。

> **编号约定**：三 / 四章的编号是**原始审计**条目号（1–19）；零章修复表的编号是本表自己的
> 顺序，两处不对齐（零章 #16 = 四章 #17、
> 零章 #18 = 四章 #16）。

### 未验证 / 未覆盖（**别当成已完成**）

不是已知缺陷，而是**没验证过**——无端到端证据，只有契约推断或单测。

- **V1** 目标条官方 inline 编辑（`/goal edit`）未实现；且 `blocked` 时 `blockedReason` 只进
  悬停 title，界面上看不见原因。
- **V2** `subagentCatalog` 真实形状：只有契约 + 离线断言，没端到端（没真跑子代理看投影）。
- **V3** 崩溃恢复链（强杀 → 重启 → 服务器起来）：只有 `clearStaleDocumentLocks` 单测，没端到端。
- **V4** 占用条 `projectedTokens` 的长对话 / 压缩后行为：pressureProbe 只跑过三轮短对话
  （三轮内 pressure 没动），长对话与压缩触发后没实测。
- **V5** `upload.message`（服务端给的上传失败原因）字段在线格式里，但界面只渲染通用文案、
  **从不读这个字段**——用户永远看不到真正的失败原因。
- **V6（已解决）** 助手消息里的 `file` 内容块现折成 `unknown` 段、按官方口径画一条 JSON 记录，
  与官方一致；`tool-call` / `tool-result` 仍**故意**不在此渲染（各有自己的事件）。

> `log()` 里成片的中文是开发者可见的输出通道日志，不受「用户可见文字必须双语」约束
> （例外已写进 `AGENTS.md`）。

---

## 一、结论概览（审计当时的原始判定，非当前状态）

「不一致」项绝大多数已修复（见零章一览表），保留只为记录当时差在哪。

- 事件折叠骨架（消息 / 工具 / 流式叠加）：**基本一致**。
- surfaceOp 替换事件一律跳过：**一致**，且这正是官方契约要求的做法，非缺陷。
- 当时**不一致**：工具行摘要 / 状态语义（信息丢失 + 图标失效）；投影消费（20 个投影只消费
  10 个，`plan`、`turnOutline` 形状读错——均已修）；斜杠命令（功能失效）；停止语义（与官方
  契约相反）。
- 当时**已修**：提交模式（`resolveSubmitMode` 逐字移植 + 冷启动读取 + 手势分叉）；附件表示
  （图片内容块 / 文本上传 / 其余降级路径引用，`@` 为正文 token）。

---

## 二、确认一致的部分（无需改动，一行清单）

surfaceOp 替换跳过（官方要求人类转写只取 append 来源）、流式叠加层合并（durable
`assistant/message` 整体替换该 step 的叠加层、被放弃的 attempt 丢弃）、todos 字段与词表、
title（`string|null` 仅非空更新）、sessionStats / contextBreakdown 字段名与语义逐字对应
（`contextBreakdown` 三方都不求和，是构成占比非计费值）、jobs 五态词表、modelSelection
（`next = pending ?? lastUsed` 等价官方）、队列丢弃 `placement:'context'`、`requestId` 由
客户端 `randomUUID()` 铸造、`commands/execute` 参数名 `submittedAttachments`（扩展的
`images` 回退是死代码）。


## 三、不一致 —— 功能完全失效

> 下文的状态标注已按零章一览表回填：标「已修（第 N 批）」的条目修复后的现行做法见代码与测试，正文保留的是审计当时的契约结论与为什么。

### 1. `/plan` 计划模式双向失效 —— 已修（第一批）

- 契约：进入与退出都走 `commands/execute`——`/plan` 进入、`/plan off` 退出；命令目录共
  7 个：compact / export / feedback / goal / mcps / permission / plan。
- 现状：扩展「进入」是给正文加 `/plan ` 前缀发普通 prompt，服务端不认；「退出」发正文
  `/plan`，按官方语义恰是**进入**——两个方向都反了。
- 连带：`planMode` 投影几乎恒 false，`plan:policy` 系统提示段也挂不上。

### 2. 手打斜杠命令全部不执行 —— 已修（第一批）

- 契约：官方 `/xxx` 进 adjudication → `commands/execute`，且 Host 明确**不发给模型**。
- 现状：扩展只有 `/permission` 走命令通道；手打 `/compact`、`/export`、`/goal` 等一律当
  普通消息发给模型——命令不生效，命令文本反而进了模型上下文。

### 3. goal 投影嵌套形状读错，目标面板从未渲染 —— 已修（第一批）

- 契约：goal 投影是嵌套结构
  `{goal:{id,revision,objective,phase,blockedReason?,maxGoalRounds},`
  `roundsStarted, createdAt, updatedAt}`（`dsh-goal` 的 `GoalProjection`）。
- 现状：扩展按扁平 `{objective,phase,rounds,maxRounds}` 读 → `goal?.objective` 恒
  undefined → goal 状态恒被清空（投影里键读不到就等于清空目标条）；webview 侧 grep
  `goal` 零命中，目标面板从未渲染过。

### 4. subagentCatalog 形状用错 + mode 硬编码 —— 已修（第一批；`mode` 硬编码仍未修）

- 契约：投影值是 `SubagentCatalogEntry{id,createdAt,mode,label?}`——**没有** `kind` 与
  `activity`，那两个字段属于 `subagents/list` RPC 行。
- 现状：扩展把 RPC 行的过滤（`e.kind === "child"`）套在投影上 → 结果恒为空，面板每次
  投影刷新被清空；另把 `mode` 硬编码 `"continuable"`，宿主会以 `subagent/unauthorized`
  拒绝 one-shot 子代理。

### 5. 交付文件完全不可见 —— 已修（第一批）

- 契约：官方在轮尾列出本轮产出的文件。
- 现状：扩展把交付文件写进 `message.deliverables`，但全仓唯一出现处就是这行写入——
  webview 不渲染；`ToolCallView.files` 有渲染分支却从未被赋值。agent 交付的文件用户
  完全看不到。

## 四、不一致 —— 行为偏差（用户可感知）

### 6. 工具行状态点覆盖图标，且缺 `stopped` 态 —— 已修（第二批）

- 契约：官方 `leadingFor(state, icon)` 只有 error/stopped 才画状态点，running/ok 显示
  工具图标；另有 `stopped` 态（`block.error?.code === "interrupted"` → 警告点 +
  「已停止」）。
- 现状：扩展 `ToolRow` 恒传 tone，而 `Row` 只要传 tone 就画点 → 工具图标（读取/搜索/
  终端…）全部不可见，`useDescribeTool` 的 icon 成死代码；状态只有 running/ok/error，
  没有 stopped。

### 7. 工具分类：官方精确名表 vs 扩展子串启发 —— 已修（第二批）

- 契约：官方 `TOOL_VARIANTS` 是精确匹配表（bash/pwsh→bash；read/read_image/web_fetch→
  read；web_search/grep/glob→search；write；edit；run_code→code；其余 others），并带
  每工具标题覆盖（pwsh→`tool.title.pwsh`）。
- 现状：扩展用 `includes("web")`、`includes("list")` 等子串启发 → 自定义工具名会被误
  分类（如含 "web" 的非 web 工具）。

### 8. 终端退出码 / 信号从未解析 —— 已修（第二批）

- 契约：官方 `parseExitStatus` 从结果尾部提取 `\n[exit code: N]`、
  `\n[killed by signal: X]` 并剥掉该行，供终端的成败呈现。
- 现状：扩展把整段结果原样当文本渲染——失败的非零退出码与成功长得一样。

### 9. 工具结果里的图片从未显示 —— 已修（第二批）

- 现状：`ToolCallView.images` 有渲染分支，但宿主从未赋值 → `read_image` 只显示文字
  信封，看不到图。
- 契约：官方 `imageCardModel` 用附件引用渲染图库。

### 10. `turn/end` reason=max-tokens 完全无输出 —— 未修（契约 + 代码）

- 契约：官方建 `turn-max-tokens` 节点，文案「已达到输出 token 上限」+「回答被截断…
  发送『继续』」。
- 现状：扩展 `turn/end` 只处理 `error` 与 `aborted` → 截断静默发生，界面毫无提示。

### 11. 已知未处理的事件反复触发 warn 提示条 —— 已修（已知事件知情静默）

- 契约：官方已知但不渲染的事件类型（`llm/retry` 每次模型重试、`tool/ptc-dispatch*`
  每次 run_code 子派发、`command/*` 等）会照常送达；官方的 `ignorable` 抑制只对
  **未知**类型生效，挡不住这类已知类型。
- 现状：扩展的 `RENDERED_EVENT_TYPES` 不含它们，落进 default 分支 → 反复弹
  「不认识的事件『llm/retry』」warn 提示条。

### 12. 中止后工具行永远卡「运行中」 —— 已修（第二批）

- 契约：官方在 step/turn 关闭后为未结算的调用**合成** interrupted 结果。
- 现状：扩展 `finishToolCall` 只能由 `tool/result` 触发，`settleStreaming` 只清
  text/thinking 标记、不碰 tool.status → ESC 中止后未返回结果的工具行永远停在
  「运行中」。

### 13. `tool/call` 落在窗口外时结果被丢弃 —— 已修（第二批）

- 现状：按 callId 找不到记录就直接丢弃结果；扩展跟随窗口 `maxMessages: 60`，跨窗口
  截断可达 → 工具结果凭空消失。
- 契约：官方回退构造孤立结果卡片（call 为 null 时显示 callId）。
- 注：7.2 的 B3 已把「找不到对应调用记录的 tool/result」改为退回孤立结果卡片收场。

### 14. 用户消息的非文本内容被丢弃 —— 已修（第二批）

- 现状：用户消息只经 `blocksToText` 取 text 块，无文本即整条丢弃 → 纯图片用户消息
  渲染为空，图片 / 文件块全部丢失。

### 15. 占用条分子口径错 —— 已修（第二批）

- 契约：官方分子 = `projectedTokens ?? pressureTokens`——prompt 侧、**不含 output**、
  含压缩增量。
- 现状：扩展用 `usage.totalTokens`（含 output）且不读 pressure/projected → 占用系统性
  偏高，且**压缩后不下降**。

### 16. 未消费的投影 —— 部分已修

- 原始清单（逐个确认 case 数为 0）：`tokenUsage`（全会话累计四桶）、`turnOutline`、
  `imageLimits`、`schedule`、`agentPreset`、`subagentTiming`、`subagent`、
  `permissions.options`、`plan.pending`、`modelCatalog` 三字段（default /
  routableProviders / failures）。
- 已补：`turnOutline` 曾连字段名都读错，现按契约解析并由右侧轮次横条消费（2026-09-14）；
  `agentPreset` 已消费（2026-09-22，新会话页预设下拉 + `session/create` 参数）。
- 仍未消费：`subagentTiming`（成对字段，子代理「活跃耗时」列）、`subagent`（身份投影，
  决定子代理会话的只读输入框）、`schedule`、`permissions.options`、`modelCatalog`
  其余字段。

### 17. 提交模式：`busyEnter: steer` 被忽略 —— 已修（2026-09-14）

- 契约：官方 `resolveSubmitMode(preferred, running, gesture, steeringAvailable)` 按设置
  与手势决定 queue / steer。
- 曾状：`"queue"` 被写死、设置面板改了「保存成功但不生效」、Cmd/Ctrl+Enter 不分叉。
- 修复：逐字移植 `resolveSubmitMode`，并补四处缺口——冷启动不读设置、`running` 判定
  晚于乐观置位、Cmd/Ctrl+Enter 未分叉、发送按钮恒为停止。
- steer 生效范围：agent 运行中且主手势（回车 / 发送按钮）用设置值；Cmd/Ctrl+Enter 取
  相反值；空闲一律 queue。

### 18. 停止语义与官方契约相反 —— 未修（有意取舍）

- 契约：官方 cancel 后「Pending queued work remains and resumes in FIFO order」，UI
  停止只发一次 cancel、不碰队列。
- 现状：扩展 `stopRunning` 摘空整条队列 → cancel → 等空闲（最多 8s）→ 按序重发；一次
  ESC = N 次 remove + 1 次 cancel + N 次 prompt。
- 为什么不照官方：实测「中止后再提交新消息会不会顺带唤醒保留的队列项」不稳定（同一
  探针 0/3 与 3/3 相反，见五），照官方只 cancel 无法保证队列语义可靠。

### 19. 附件表示：内联正文 vs 引用 / 上传 —— 已修（第二批）

- 契约（官方两条路，从不内联文件正文）：① `@` 引用——模型侧就是 `@path`，语义由系统
  提示段定义「用 read 工具自己读」；② 拖入文件——逐字节上传拿 `receiptId`，模型看到
  句柄 + 只读副本路径。
- 现状：扩展 `buildContextText` 把文件正文塞进 prompt（上限 512KB）→ token 成本高、
  二进制读不到、`@` 语义消失，并使队列「重新编辑」随正文膨胀退化。

## 五、本次审计暴露的自身缺陷（要点）

- **悬空引用**：ESC 设计注释引用的实测探针（`scripts/queueContinueProbe.ts`）一度被删，
  立论依据不可复现；配套 e2e 只验证扩展自己的三步实现、从未测「只 cancel」分支。探针
  已恢复并登记进 `esbuild.scripts.mjs` 的 entries（`README.md` 与 `stopRunning` 注释
  均引用它）。
- **硬断言纪律**：只 `cancel` 不会让队列自动接续——3/3，可硬断言；中止后再提交新消息
  会不会顺带唤醒保留的队列项**不稳定**（同一脚本两次运行 0/3 与 3/3 相反）——只作
  观察打印、不写硬断言，否则是随机器负载飘的假防线。
- 正是后一条不稳定，使 §18 无法照官方契约「只发一次 cancel」。

## 六、无法确认（未验证，不猜测）

1. `request/header` 是否在典型会话造成可见的系统提示词卡片缺失（取决于官方去重逻辑
   运行结果）。
2. turn-process 折叠在用户真实 transcript-view 设置下的视觉体量。
3. 官方工作区列表对 `depth` / `completed` 的渲染器位置（未在已安装产物中定位）。
4. 本部署 `permission-presets.presets` 的实际配置（故「read-only 是否真不存在」不确定）。
5. VS Code webview 的拖放 / 粘贴文件能力——**已实测**（2026-09-21，Playwright + 真实
   Windows 剪贴板）：粘贴的 `clipboardData.types` 只有 `["Files"]`，`text/uri-list` 与
   `text/plain` 均为空串 → webview 侧拿不到路径；目录是 `size=0`、`type=""`、字节读
   不出的 File。因此实现是「宿主去系统剪贴板取真路径 → 走添加文件那条路」，取不到才
   退回字节通道（`src/dsh/clipboardPaths.ts`；证据表见
   `audit-input-queue-attachments.md` §3.4）。
6. `images` 参数名是否曾在历史版本被接受（只能证明当前唯一出现处在 fixture）。

## 七、第二轮全项目审计（2026-09-17：漏洞 / BUG / 死代码）

这轮不对比官方，而是**对本仓库自己**做全量审计（宿主安全、会话管线、webview 三层，
三路并行）并当场修复。以下是修完之后的清单——每条都在代码或断言里有落点，便于复核。

### 7.1 安全

| # | 问题 | 处置 | 落点 |
|---|---|---|---|
| S1 | `dshChat.command` 是默认 `window` 作用域，且经 `shell` 原样执行：**已信任**的工作区里，一个 `.vscode/settings.json` 就能在激活时执行任意命令（`url` 同理会把凭据指向别的服务器） | 两项都改 `"scope": "machine"` | `package.json`；断言 `scripts/invariants.test.ts` §5.1 |
| S2 | 会话 id 由服务端给出，却直接拼进 `~/.dsh/sessions/<ws>/<id>` 去 `rmSync(recursive)`（`..\..\..\Desktop` 这类 id 能删到根之外） | 加 `isSafeSessionId`（纯目录名）+ `resolve()` 包含性检查两道 | `controller.deleteSession` / `findSessionDir`；断言 §5.2 |
| S3 | `killServer` 的端口兜底会 `taskkill /T /F` **端口上任何监听者**，而端口来自上一次公告（`--port 0` 是临时端口，可能已被无关程序接管） | 先查身份（`tasklist` / `/proc/<pid>/cmdline` → `looksLikeDsh`），拿不到证据就不动手 | `src/supervisor/main.ts`；断言 §5.3 |
| S4 | 会合文件（含启动令牌）按默认权限落盘 | 目录 `0o700`、文件 `0o600`（POSIX；Windows 由 profile ACL 兜） | `supervisorProtocol.PRIVATE_*`、`supervisorRunner`、`supervisor/main.ts` |
| S5 | socket 推来的状态只判「是个对象」，`baseUrl`/`token` 原样被采用（决定后续令牌与 cookie 发往哪个 origin） | `decodeServerMessage` 逐字段验形状（`checkState`） | `src/dsh/supervisorWire.ts` |
| S6 | 启动令牌会顺着「日志尾巴」（`supervisor.log` 里有 dsh 的 stdout 公告行）印进连接条、诊断弹窗与输出通道 | `logTail()` 过 `redactSecrets` | `supervisorManager.ts`；断言 §5.4 |
| S7 | 对端可一直发不含换行的数据 → 行缓冲无限增长（守护进程是长期存活的） | `LineDecoder` 加 1 MiB 上限 + 溢出标记，两侧据此断开连接 | `supervisorWire.ts`、`supervisorClient.ts`、`supervisor/main.ts`；断言在 `supervisorProtocol.test.ts` |
| S8 | `control:restart` 未防重入：两个窗口同时重启（或撞上崩溃重起）会 spawn 两个 dsh，前一个的 pid 再也找不回来 | `bringUp` 合并并发调用（在飞 promise） | `src/supervisor/main.ts`；断言 §5.5 |
| S9 | 扩展被 dispose 后，在途的心跳仍能「复活」管理器（重开连接 + 重挂心跳） | `bringUp` 不再重置 `disposed`；`connect()` 在 await 回来后再查一次 | `supervisorManager.ts` |
| S10 | CSP nonce 用 `Math.random()`；webview 帧无 try/catch（残缺帧 → 未处理 rejection）；宿主侧没有拖放字节上限 | `randomBytes`；`handle()` 加 catch + 日志；宿主按 base64 长度先拦 8 MB | `chatView.ts`、`controller.applyBytesForView` |
| S11 | `tcpReachableSync` 把 URL 主机名插进 PowerShell `-Command`（`'`、`;` 都是合法主机码点） | 主机改走环境变量传入 | `processRegistry.ts` |
| S12 | 图片内联走同步 `readFileSync`，无上限；`imageLimits` 投影解析了却没人消费 | 用 `imageLimits.maxImageBytes`（缺省 64 MB 硬上限）作内联上限，超限改按文件上传并提示 | `attachments.classifyPath` + `controller`；新 `@imageTooLarge` 标记 |

### 7.2 功能 BUG

| # | 现象 | 处置 |
|---|---|---|
| B1 | 「加载更早」永久卡死：`historyLoading` 只在取历史那条链上发 patch，**会话切换后**新会话的快照不带这个键（`mergeWirePatch` 只在收到 `null` 时删键），界面于是永远显示「正在加载更早消息…」 | `snapshotFor()` 带上 `historyLoading` |
| B2 | `cordis_*` 工具行显示裸 id：`TOOL_TITLE_KEYS` 映射出的 4 个词典键在 `texts.ts` 里根本不存在，界面侧 `as unknown as Record<...>` + `?? name` 把失效吞掉了 | 补 `toolInspect` / `toolRunCordis` / `toolStopCordis` / `toolRemoveCordis` 两语言条目 |
| B3 | `tool/result` 找不到对应调用记录时被**静默丢弃**，那一行永远停在「运行中」（`refold()` 重建 `byId`、流式合成 callId 都会触发） | 退回孤立结果卡片（与「call 落在窗口外」同一种收场） |
| B4 | 提示条永不消失：`NoticeBar` 的计时器依赖里有一个每次渲染都新建的 `onDismiss`，流式期间每个 token 都重开计时 | 计时只跟 `notice.id`，回调走 ref |
| B5 | 目标条里按 `Esc` 取消编辑时把**正在跑的这一轮也中止**了（ESC 优先级链没被消费）；问卷自定义答案框同理 | 两处都 `preventDefault` + `stopPropagation`（问卷的 Esc = 取消选中该自定义答案） |
| B6 | `eventSessions`（事件 → 会话）只增不删，跨会话累积；结算过的事件不再需要它 | 结算/撤回的四处一并删除 |
| B7 | 开着子代理面板切换会话，列表停在上一个会话（宿主快照键 `subagents` 与界面读的 `subagentEntries` 不是同一个名字） | **已修（2026-09-19，会话状态面单一生产者）**：线格式与视图模型统一叫 `subagentEntries`，跨名桥拆掉；字段清单收进 `src/dsh/sessionView.ts` |
| B8 | `activity` 未知（投影没有这个字段）时界面画成确定的「未运行」，与「不知道就不画状态点」的契约相反 | 未知时改显示生命周期模式（`one-shot` / `continuable`） |
| B9 | 工具展开区最多 5 个元素共用同一个 `ref`，React 只保留最后一个 → diff 段拿不到「打开回顶」与「划选冻结」 | diff 段用独立的 `diffRef` |
| B10 | 轨迹：概述里「输出」画的是时长而不是 token 数；`Diff` 页签是硬编码英文；平移的 document 监听在卸载时不摘；`model?.turns ?? []` 每次新数组使两个 `useMemo` 失效 | 逐条修（`usageOutput` 给 token 数、新增 `tabDiff`、卸载兜底摘监听、稳定空数组常量） |
| B11 | 扩展输出通道在第一次落日志后会变成**两个**「DSH Chat」（`output ?? create()` 的返回值没有回写） | 改走会赋值的 `outputChannel()` |
| B12 | 一轮结束后无条件抢焦点（用户正在历史搜索框 / 目标编辑框里打字时被打断） | 焦点不在输入框且不空闲时不抢 |
| B13 | **拖放 / 粘贴进来的文件附件上传成功后不进 prompt**（2026-09-21）：字节通道的附件没有 `path`，而发送装配按 `attachment.path` 过滤，于是上传照做、内容块却一个都没有；同一道门还吞掉了「有附件没传上去」的提示。根因是字节通道（`attachBytes`）在后一轮才加，没接进老的路径管线 | 内容块装配抽成纯函数 `attachments.buildPromptContent`：文件只认 `upload.status === "ready"`（与 `path` 无关），未就绪进 `notUploaded`；顺手把两条平行通道合并（`planIntake` + `ingestAttachments`）。断言 `scripts/attachments.test.ts` §7。详见 `docs/design-attachments.md` |
| B14 | **点开子代理永远是「这个子代理没有可显示的内容」**（用户 2026-09-22 报，从该链路上线起就没好过）：follow 请求写了 `assistantStream: false`，而契约里它是**字面量 `true`**（`readonly assistantStream?: true`）——网关边界校验把整条 request 拒掉（`gateway/input-invalid`），`onError` 立刻回一帧空记录。失败被折成**空态而不是报错**，既看不出坏了、也没有日志线索 | 请求体整条过 `satisfies SessionFollowRequest`（新类型，`assistantStream?: true` 字面量），`openStream` 收 `unknown` 的那道缝由此补上；顺手删掉 `followSession` 里没人传过的 `beforeSeq` 选项（它属于 `session/page`，同一道校验的下一个坑）。复现：同一子代理地址带 `false` → `gateway/input-invalid`，去掉后 → `snapshot(records=35)` 并折出消息。断言 `scripts/subagentPanel.test.ts` §6 |

### 7.3 死代码（已删）

- **整份模块**：`src/dsh/textFile.ts`（「附件按 UTF-8 内联进提示词」时代的字节判定）
  及其测试与 esbuild 条目。
- **未用导出**：`bridge.getPersistedState/setPersistedState`（那条「面板重建后恢复草稿」
  的能力从未实现，文档承诺一并删掉）、`icons.IconSettings/IconUndo/IconBulb/IconList`
  （自绘设置页的残留）、`supervisorClient.awaitFirstState`、
  `supervisorProtocol.socketNodeExists/createExclusive`、`supervisorManager.waitForSocket`、
  `controller` 里 `stamp` 的转出、`shared/trajectory.TrajectorySpan`、
  `scripts/sessionLog.readSessionLogRows`。
- **死 IPC 帧 + 处理器**：`message/remove`、`addMention`、`addFolderReference`、
  `runCommandLine`（`@` 改成写正文 token 之后，界面上再也没有发射点）；随之删掉只被
  它们调用的 `controller.addReference`。
- **引用芯片整条链（2026-09-21 删）**：`AttachmentKind` 的 `reference` / `context`、
  `Attachment.referenceKind`、`dsh/references.composeWithReferences` 与 `Reference`、
  `controller.applyPathsForView` 里的目录分支、`Composer.tsx` 的芯片分支、`.chip-glyph`、
  `icons.IconAt`、`test/preview.html` 里的两条 `reference` 夹具。目录现在一律是正文里的
  `@dir/` 引用文本（唯一落点 `controller.addDirectoryReference`），附件里只有 `file` /
  `image`。
- **死词典键**：`texts.ts` 29 个 + `trajectoryTexts.ts` 17 个（自绘设置页与早期对齐的
  残留）。
- **死文案标记**：`serverExited`、`switchingServer`（有词典、有 `resolveText` 分支、有
  `hostText` 译文，但没有任何发射点）。同时**新增反方向断言**：`MARKERS` 里每个标记都
  必须真有发射点，避免这类「看起来做完了」的死文案再攒起来。
- **死 CSS 自定义属性**：`tokens.css` 7 个（`--command-bg/-fg`、`--terminal`、
  `--radius-lg`、`--gap`、`--pad`、`--font-size-lg`）。
- **`docs/continue-ui-spec.md`**（1128 行的「复刻 Continue 界面」规格）整份删除：界面
  早已按自己的 token 与组件演进，留着这份文档才是误导；许可归属的说明保留在
  `THIRD-PARTY-NOTICES.md`。

### 7.4 明确不改（记录取舍）

- **CSP 仍允许 `img-src https:`**（用户 2026-09-17 拍板）：宿主自己产生的图片全是
  `data:` URL，这条只对**模型输出里的外链图片**生效；去掉它就能堵住「提示注入把内容
  编进图片 URL」的外传通道，但回答里的外链图也就不显示了。取舍是「保留渲染能力」。
  **2026-09-18 补上三条加固**（`markdown.ts` 的 `afterSanitizeAttributes` 钩子 + CSP）：
  外链图一律带 `referrerpolicy="no-referrer"`（不带来源）与 `loading="lazy"`（不滚到的
  图不拉），且**明文 `http:` 不放行**（`img-src` 只列 `data:` 与 `https:`）——外传面
  因此收窄到「https 且真的显示出来」的那几张，渲染能力不受影响。
- **正文里的本地图片按会话工作目录白名单读**（2026-09-18）：模型写的 `![](out/chart.png)`
  由宿主读成 data URL。这是**模型可控的路径**，所以判据全按肯定证据写：解析后的绝对
  路径必须落在会话 cwd 内（`relative` 结果以 `..` 开头、是绝对路径或为空一律拒）、
  扩展名必须是图片、先 `stat` 再读、单张 8 MB、单次最多 24 张。越界的引用不读，界面
  退回原样文本。断言在 `scripts/localImages.test.ts`。扩展名表**含 `svg`**
  （`shared/imageRef.ts`），与服务端附件准入那张表分开：那张管「模型能不能读字节」，
  这张管「浏览器能不能画」；`<img>` 里的 SVG 不执行脚本，所以不引入 XSS 面。同一套
  解析也服务于 `present` 申报 / 本轮生成的图片文件（`LocalImageGallery`）——agent 交付
  图片走的就是这条路，不经过 markdown。**失败不再静默**：宿主把基准目录与未解析的路径
  写进输出通道，界面的降级文案也带原始路径（悬停可见）。定位「图一直显示不出来」那次
  时，病根**不在**这条链路里（探针实测 cwd 与解析全程正常），而是**宿主侧装的是旧
  产物**：webview 发了 `resolveImages`，宿主旧代码没有这个分支，请求落进 `default`
  静默无响应，界面只剩自己那句「加载失败」。教训记在 `AGENTS.md` 的「构建与验证」节。
- **回形针选图仍可能一次读入大文件**：现在的上限来自服务端 `imageLimits`（缺省 64 MB），
  没有做像素级校验——服务端最终也会拒，但宿主这一读仍是同步的。
- **`imageLimits` 的另外两个字段**（`maxImagesPerMessage` / `maxMessageImageBytes`）
  仍未消费：发送前的整批校验还没做。
