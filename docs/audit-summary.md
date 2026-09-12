# 与 DSH Web 端的一致性审计（汇总）

审计对象：本扩展 `src/dsh/` `src/webview/` 的解析与渲染路径。
对照基准：本机安装的官方 Web 前端 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
（先读 `lib/types/**/*.d.ts` 契约，再回 `lib/client.js` 确认实现）。

证据等级标注：
- **[实测]** 起真实 `dsh web` 观察行为（可复现脚本在 `scripts/`）
- **[契约]** 官方类型声明 / 实现代码逐字引用
- **[代码]** 本仓库代码事实（grep / 阅读）
- **[存疑]** 未验证，不下结论

详细分报告：
- `docs/audit-input-queue-attachments.md`（输入 / 提交 / 队列 / 附件）
- `docs/audit-projections-panels.md`（投影 / 面板）

---

## 零、修复状态（2026-09-12 更新）

本章只记「已修 / 未修」，**不改动下面各节的原始判定**——那些是当时的证据，保留原样。

### 已修复（第一批）

| # | 条目 | 结论 |
|---|---|---|
| 1 | `/plan` 双向失效 | ✅ 进出都走 `commands/execute`（退出用 `/plan off`）；`Composer.tsx` 的「下轮生效」前缀机制整体删除 |
| 2 | 手打斜杠命令不执行 | ✅ 行首 `/` + 名字在命令目录里 → 命令通道；并新增**命令节点**渲染（`command/run`↔`command/done`），结果可见 |
| 3 | goal 投影形状读错 + 未渲染 | ✅ 按嵌套形状读（`goalFromProjection`），并新增输入区上方的**目标条** |
| 4 | subagentCatalog 用错契约 | ✅ 投影按 `{id,createdAt,mode,label?}` 读、不按 `kind` 过滤；RPC 行才过滤 `kind:'child'`；`mode` 不再硬编码 |
| 5 | 交付文件完全不可见 | ✅ 新增两种来源的渲染：`produced`（成功 write/edit 推导，`producedPath`）+ `deliverables`（present 申报） |

### 已修复（第二批）

| # | 条目 | 结论 |
|---|---|---|
| 6 | 工具行状态点覆盖图标 + 缺 `stopped` | ✅ 按官方 `leadingFor`：**只有 error/stopped 画点**，running/ok 显示工具图标；`stopped` 用警告色（中断不是失败） |
| 7 | 工具分类用子串启发 | ✅ 换成官方 `TOOL_VARIANTS` **精确名表**（16 项）+ `TOOL_TITLE_KEYS`（`pwsh`→「Pwsh」等）。`shared/toolMeta.ts` |
| 8 | 终端退出码从未解析 | ✅ `parseExitStatus` 剥掉尾部标记行并取退出状态；非零退出/信号**升级为失败**（bash/pwsh 故意不置 isError） |
| 9 | `tool.images` 未赋值 | ✅ 从 `tool-result` 内层内容块取 image 句柄，经 `session/attachment` 换成 data URL 显示 |
| 10 | `max-tokens` 无输出 | ✅ `turn/end` 原因 `max-tokens` → 「回答被截断」提示 |
| 11 | 已知未处理事件弹 warn | ✅ `llm/retry` 改为渲染「正在重试 n/m」，`llm/retry-started` 收掉提示；两者移出静默名单 |
| 12 | 中止后工具行卡「运行中」 | ✅ `turn/end`（aborted/error/max-tokens）为未结算调用**合成**中断结果（官方 `projectBlock` 语义） |
| 13 | 窗口外 `tool/result` 被丢弃 | ✅ 补一张只有结果、头部显示 callId 的占位卡片（与官方 `call: null` 回退一致） |
| 14 | 用户消息非文本块被丢 | ✅ `userMedia()` 保留图片/文件块；纯图片消息不再整条消失 |
| 15 | 占用条分子口径错 | ✅ 改用 `contextPressure`：`projectedTokens ?? pressureTokens`（prompt 侧、不含 output、**压缩后会下降**） |
| 16 | `busyEnter` 被忽略 | ✅ 从 `ui-conversation` 设置读取；`steer` 仅在 agent 运行中生效，否则退回 queue |
| 18 | 未消费投影 | ✅ 新增 `tokenUsage`（四桶累计）、`turnOutline`（轮次导航）、`imageLimits`（图片准入）；`contextPressure`、`plan.pending` 已在 #15、新发现里消费 |
| 19 | 附件内联 vs 引用/上传 | ✅ 改为官方模式：图片走内容块；其余文件**选中即上传**拿 `receiptId`；`@` 引用只发 `@path`。不再内联正文 |

### 本批新发现（原审计未列）

| 条目 | 说明 |
|---|---|
| `plan` 投影只读 `active` 是错的 | 生效状态是 `pending ? !active : active`。轮次进行中发 `/plan` 只会挂起（`{active:false,pending:true}`），裸读 active 会让「进入计划模式」看起来毫无反应。契约见 `dsh-plan-mode/lib/types/types.d.ts`，实测见 `scripts/commandE2E.ts` A 组 |
| 快照回放会覆盖投影折叠值 | `follow()` 原来先铺投影、再回放记录 → 历史里最后一个事件把折叠值覆盖回旧状态。`plan` 的 `pending` 是活例（每次重开会话都丢）。已改为**先回放、再铺投影** |
| 会话历史翻不到 | 不是「被清理」，而是**分页从未接上**：跟随流只带 `maxMessages: 60`，更早的内容从未进过客户端；而 `session/page` 的入口（`client.page()`、`loadMore` 消息类型）在协议层有、**没有任何地方调用**。已实现：适配器记住 `snapshot.cursor`（`throughSeq` 的唯一合法来源）与已折叠事件，界面加「加载更早的消息」按钮 |
| 崩溃遗留的 writer 锁会让 `dsh web` 起不来 | 强杀后 `~/.dsh/.credentials.yaml.lock` 留下；`dsh-atomic-write` 刻意不回收孤儿锁，而 boot 等 30 秒后抛错退出整个进程。已实现 `clearStaleDocumentLocks`（按肯定证据判持有者已死），在**每次拉起服务器之前**清理 |
| `contextPressure` **分母先到、分子后到** | 实测（`scripts/pressureProbe.ts`，三轮真实对话）：投影每轮推十来次，`contextWindow` 先就位，而分子要等**下一次请求上报 usage** 才出现。实测表：一轮后只有分母、本地复算已能给出 19206；二轮后官方 pressure=19206 / projected=19215；三轮后 pressure 仍 19206 而 **projected 19844**。两条结论：**①`projectedTokens` 才是逐轮变化的那个**（也是压缩后唯一会降的），必须优先；**②本地 `input + cached` 与官方 `pressureTokens` 逐字相等**（19206 == 19206，且 ≠ totalTokens 19208），可以在投影缺分子时**同口径**兜底。占用条按用户要求**常驻显示**：三个来源都拿不到时保留旧值，不清空 |

### 仍未修复

- **#17 停止语义**：官方契约说 cancel 后排队工作按 FIFO 继续，UI 只发一次 cancel。
  但实测 `build/queue-continue-probe.mjs` **只 cancel 不会让队列自行接续**（两轮 3/3），
  且「之后再提交会不会唤醒队列项」**不稳定**（同一脚本两次运行 0/3 vs 3/3）。
  这是实测与契约冲突，**刻意保留**现有实现（摘空 → cancel → 重发），
  因为官方做法在本机实测下会让队列卡住。取舍已记入 README 的「已知限制」。
- §四 #18 余项：`schedule`、`agentPreset`、`subagentTiming`、`permissions.options`
  （前三个是面板/展示层功能，未做；`permissions.options` 目前只取 `currentValue`）。

---

## 一、结论概览

| 维度 | 判定 |
|---|---|
| 事件折叠骨架（消息/工具/流式叠加） | **基本一致** |
| surfaceOp 替换事件一律跳过 | **一致（且这正是官方契约要求的做法）**，非缺陷 |
| 工具行的摘要 / 状态语义 | **不一致**（信息丢失 + 图标失效） |
| 投影消费 | **不一致**（20 个投影只消费 10 个，其中 2 个形状读错） |
| 斜杠命令 | **不一致（功能失效）** |
| 提交模式（queue/steer） | **不一致**（用户设置被忽略） |
| 停止语义 | **不一致**（与官方契约相反） |
| 附件表示 | **不一致**（内联正文 vs 引用/上传） |

---

## 二、确认一致的部分（无需改动）

1. **surfaceOp 替换事件跳过** —— `adapter.ts:296`。官方契约要求人类转写**只取 append 来源**，
   替换副本「stays model-only」（`dsh-client-ui-chat/lib/client.js:5686-5699`，
   `dsh-session/lib/types/surface.d.ts:26-38`）。扩展的无条件跳过产生同样结果。
2. **流式叠加层合并** —— durable `assistant/message` 整体替换该 step 的叠加层，被放弃的
   attempt 丢弃：与官方同结果（官方按 `${turn}:${step}` 键控，扩展按 step 丢弃 live 段）。
3. **todos** —— 字段 `{content,status}` 与词表逐字一致，`null → []` 同官方。
4. **title** —— `string|null`，仅非空时更新。
5. **sessionStats / contextBreakdown** —— 八字段与三字段名、语义逐字对应；
   `contextBreakdown` 三方都不求和（是构成占比，不是计费值）。
6. **jobs 数据** —— `SessionJob` 五态词表逐字一致。
7. **modelSelection 取值** —— `next = pending ?? lastUsed` 等价官方。
8. **队列丢弃 `placement:'context'`** —— 与官方一致（官方只取 `queued`/`steering`）。
9. **`requestId` 由客户端铸造** —— 官方同样 `randomUUID()`。
10. **`commands/execute` 参数名 `submittedAttachments`** —— 当前正确名；扩展的
    `images` 回退是死代码（全树唯一出现处在官方 fixture 替身里）。

---

## 三、不一致 —— 功能完全失效（优先修）

### 1. `/plan` 计划模式双向失效 **[实测]**

```
① prompt 正文「/plan 你好」        → plan.active = false   ← 扩展「进入」的做法：无效
② commands/execute「/plan」        → plan.active = true    ← 官方做法：有效
③ commands/execute「/plan off」    → plan.active = false   ← 官方「退出」的做法
④ 返回值 = {"result":{"kind":"success","text":"Plan mode on. Use /plan off to leave."}}
⑤ 命令目录 7 个：compact, export, feedback, goal, mcps, permission, plan
```

- 扩展「进入」= 给正文加 `/plan ` 前缀发普通 prompt（`Composer.tsx:171`）→ **服务端不认**。
- 扩展「退出」= 发正文为 `/plan` 的消息（`Composer.tsx:519`）→ 按官方语义那是**进入**，方向反了。
- 官方退出走 `commands/execute(sessionId, "/plan off", [])`
  （`dsh-client-ui-plan/lib/client.js:126`）。
- 连带：`planMode` 投影几乎恒 false，`plan:policy` 系统提示段也不会挂上。

复现：`npm run build:scripts && node build/plan-command-probe.mjs`

### 2. 手打斜杠命令全部不执行 **[代码]**

扩展只有 `/permission` 走命令通道（`controller.ts:1314`）。用户手打 `/compact`、`/export`、
`/goal` 等一律当**普通消息**发给模型（走 `send()`，无 `/` 分支）。官方 `/xxx` 进
adjudication → `commands/execute`，且 Host 明确「without sending it to the model」。

### 3. goal 投影形状读错 + 界面从未渲染 **[契约][代码]**

wire 是**嵌套**的：`{goal:{id,revision,objective,phase,blockedReason?,maxGoalRounds}, roundsStarted, createdAt, updatedAt}`
（`dsh-goal/lib/types/types.d.ts` 的 `GoalProjection`）。
扩展按**扁平**读 `{objective,phase,rounds,maxRounds}`（`controller.ts:968-985`）
→ `goal?.objective` 恒 undefined → `this.goal` 恒被清空。
且 `src/webview` grep `goal` **零命中** → 目标面板从未渲染。

### 4. subagentCatalog 形状用错 + mode 硬编码 **[契约][代码]**

投影值是 `SubagentCatalogEntry{id,createdAt,mode,label?}`——**没有 `kind`/`activity`**
（`dsh-subagent/lib/types/projection-types.d.ts`）。那两个字段属于 `subagents/list` RPC 行。
扩展把 RPC 行的过滤套在投影上：`controller.ts:951` `.filter(e => e.kind === "child")`
→ **恒为空**，面板每次投影刷新被清空。
另 `controller.ts:2025` 硬编码 `mode:"continuable"`，宿主会以 `subagent/unauthorized`
拒绝 one-shot 子代理。

### 5. 交付文件完全不可见 **[代码]**

`adapter.ts:471` 写入 `message.deliverables`，但全仓**唯一出现处就是这行写入**：
webview 不渲染它；`ToolCallView.files` 有渲染分支（`Rows.tsx:135`）却从未被赋值。
官方在轮尾列出产出文件。

---

## 四、不一致 —— 行为偏差（用户可感知）

### 6. 工具行：状态点覆盖了图标，且缺 `stopped` 态 **[契约][代码]**

官方 `leadingFor(state, icon)`（`dsh-client-ui-tool/lib/client.js:1188-1194`）：
**error/stopped 才画状态点，running/ok 显示工具图标**。
扩展 `Row` 只要传了 `tone` 就画点（`primitives.tsx:40`），而 `ToolRow` 总是传 tone
→ **工具图标（读取/搜索/终端…）全部不可见**，`useDescribeTool` 的 icon 是死代码。
官方还有 **`stopped`** 态（`block.error?.code === "interrupted"` → StateDot warning +
「已停止」），扩展只有 running/ok/error。

### 7. 工具分类：官方用精确名表，扩展用子串启发 **[契约]**

官方 `TOOL_VARIANTS` 是**精确匹配表**（`client.js:936-953`）：`bash/pwsh→bash`、
`read/read_image/web_fetch→read`、`web_search/grep/glob→search`、`write`、`edit`、
`run_code→code`，其余 `others`；且有每工具的标题覆盖（`pwsh→tool.title.pwsh`）。
扩展用 `includes("web")`、`includes("list")` 等子串启发（`Rows.tsx:32-47`）
→ 自定义工具名会被误分类（例如含 "web" 的非 web 工具）。

### 8. 终端退出码 / 信号从未解析 **[契约]**

官方 `parseExitStatus` 从结果尾部提取 `\n[exit code: N]` 与 `\n[killed by signal: X]`
并**剥掉**该行，用于终端的成败呈现（`client.js:1046-1067`）。
扩展把整段结果原样当文本渲染 —— 失败的非零退出码在扩展里和成功长得一样。

### 9. 工具结果里的图片从未显示 **[代码]**

`ToolCallView.images`（`chat.ts`）在 `Rows.tsx:135` 有渲染分支，但 `adapter.ts` 从未赋值
（grep `.images` 在 `src/dsh` 零命中）→ `read_image` 只显示文字信封，看不到图。
官方 `imageCardModel` 用附件引用渲染图库。

### 10. `turn/end` reason `max-tokens` 完全无输出 **[契约][代码]**

官方建 `turn-max-tokens` 节点，文案「已达到输出 token 上限」+「回答被截断…发送『继续』」。
扩展 `case "turn/end"` 只处理 `error` 与 `aborted`（`adapter.ts:311-333`）
→ 截断静默发生。

### 11. 已知但未处理的事件触发 warn 提示条 **[契约][代码]**

`RENDERED_EVENT_TYPES` 不含 `llm/retry`（每次模型重试）、`tool/ptc-dispatch*`
（每次 `run_code` 子派发）、`command/*` 等已知类型；`ignorable` 只对**未知**类型生效
（`dsh-session/lib/index.js:270`）→ 落入 default 分支弹
「不认识的事件『llm/retry』」（`adapter.ts:491-501`）。

### 12. 中止后工具行永远卡在「运行中」 **[契约][代码]**

官方在 step/turn 关闭后为未结算的调用**合成** interrupted 结果
（`client.js:6434-6451`）。扩展 `finishToolCall` 只能由 `tool/result` 触发，
`settleStreaming`（`adapter.ts:769`）**只清 text/thinking 标记、不碰 tool.status**。

### 13. `tool/call` 落在窗口外时结果被丢弃 **[契约][代码]**

`adapter.ts:832` `const entry = this.toolSegments.get(callId); if (!entry) return;`
官方则回退构造卡片（call 为 null 时显示 callId）。扩展跟随窗口 `maxMessages: 60`，
跨窗口截断可达。

### 14. 用户消息的非文本内容被丢弃，纯图片消息整条消失 **[代码]**

`adapter.ts:344` `if (!text) break;` —— 用 `blocksToText` 只取 text 块
→ **纯图片用户消息渲染为空**；图片/文件块丢失。

### 15. 占用条分子口径错 **[契约][代码]**

官方 `projectedTokens ?? pressureTokens`（prompt 侧、**不含 output**、含压缩增量）。
扩展用 `usage.totalTokens`（含 output）且不读 `pressureTokens/projectedTokens`
→ 系统性偏高，且**压缩后不下降**。

### 16. 未消费的投影 **[代码]**

`tokenUsage`（全会话累计四桶）、`turnOutline`（轮次导航）、`imageLimits`（图片准入校验）、
`schedule`、`agentPreset`、`subagentTiming`、`subagent`、`permissions.options`、
`plan.pending`、`modelCatalog.default/routableProviders/failures` —— 逐个确认
`case` 数为 0。

### 17. 提交模式：用户设置 `busyEnter: steer` 被忽略 **[契约][实测环境]**

本机 `~/.dsh/settings.yaml` 就是 `ui-conversation.busyEnter: steer`。
官方 `resolveSubmitMode(preferred, running, gesture, steeringAvailable)` 据此决定 queue/steer；
扩展把 `"queue"` 写死（`controller.ts:1484`、`1819`），且设置面板里改它「保存成功但不生效」。
Ctrl+Enter 也未区分（`Composer.tsx:241` 只判 `!shiftKey`）。

### 18. 停止语义与官方契约相反 **[契约][代码]**

官方契约：cancel 后「Pending queued work remains and resumes in FIFO order」
（`contract/session.d.ts:102-109`），UI 停止只发**一次** cancel、不碰队列。
扩展 `stopRunning` 摘空整条队列 → cancel → 等空闲（最多 8s）→ 按序重发
→ 一次 ESC = N 次 remove + 1 次 cancel + N 次 prompt。

### 19. 附件表示：内联正文 vs 引用/上传 **[契约][代码]**

官方从不内联文件正文：`@` 引用在模型侧就是 `@path`（语义由系统提示段定义「用 read 工具
自己读」）；拖入文件走逐字节上传拿 `receiptId`，模型看到的是句柄 + 只读副本路径。
扩展 `buildContextText`（`controller.ts:1502-1537`）把正文塞进 prompt（上限 512KB）
→ token 成本高、二进制读不到、`@` 语义消失，并使队列「重新编辑」退化。

---

## 五、本次审计暴露的自身缺陷

**悬空引用 [代码]**：`controller.ts:1741` 注释引用
「实测（`scripts/queueContinueProbe.ts`，两轮各 3 次）」——该脚本**在我此前的工作中已删除**，
仓库内不存在。ESC 设计的立论依据因此**当前不可复现**。
（`scripts/queueEscE2E.ts` 只验证了扩展自己的三步实现，从未测「只 cancel」分支。）

这不影响功能正确性（e2e 覆盖了实际路径），但注释引用了不存在的证据，应当修正：
要么恢复该探针，要么改写注释。

---

## 六、无法确认（未验证，不猜测）

1. `request/header` 是否在典型会话造成可见的系统提示词卡片缺失（取决于官方去重逻辑运行结果）。
2. turn-process 折叠在用户真实 transcript-view 设置下的视觉体量。
3. 官方工作区列表对 `depth`/`completed` 的渲染器位置（未在已安装产物中定位）。
4. 本部署 `permission-presets.presets` 的实际配置（故「read-only 是否真不存在」不确定）。
5. VS Code webview 的拖放/粘贴文件能力（可证「扩展未实现」，不可证「官方做法可否等价实现」）。
6. `images` 参数名是否曾在历史版本被接受（只能证明当前唯一出现处在 fixture）。
