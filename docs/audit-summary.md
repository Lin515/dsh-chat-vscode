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
| 16 | `busyEnter` 被忽略 | ✅ 从 `ui-conversation` 设置读取并作为 `session/prompt.mode` 发出。**2026-09-14 补齐三处缺口**：冷启动也读（随 `settings/describe` 一起喂）、`running` 判定移到乐观置位**之前**、Enter 与 Cmd/Ctrl+Enter 分叉（`resolveSubmitMode(running, gesture)` 逐字移植官方）+ 运行中主按钮标注「排队发送/插话发送」+ 队列行「插话发送」。见 CHANGELOG 未发布第六节 |
| 18 | 未消费投影 | ✅ 新增 `tokenUsage`（四桶累计）、`turnOutline`（轮次导航）、`imageLimits`（图片准入）；`contextPressure`、`plan.pending` 已在 #15、新发现里消费。**注意 `turnOutline` 的字段一度读错**（见「本批新发现」末尾那条）：2026-09-14 按契约改成 `{turn, seq, prompt, response}` 并由右侧轮次横条实际消费 |
| 19 | 附件内联 vs 引用/上传 | ✅ 改为官方模式：图片走内容块；文件走上传拿 `receiptId`；`@` 引用只发 `@path`。不再内联正文。**2026-09-14 细化**：`@` 改为把 token **插进输入框正文**（不再生成附件栏芯片），上传只留给「模型可直接读的文本」，二进制/非 UTF-8/超过 8 MB 一律降级为路径引用 |

### 本批新发现（原审计未列）

| 条目 | 说明 |
|---|---|
| `plan` 投影只读 `active` 是错的 | 生效状态是 `pending ? !active : active`。轮次进行中发 `/plan` 只会挂起（`{active:false,pending:true}`），裸读 active 会让「进入计划模式」看起来毫无反应。契约见 `dsh-plan-mode/lib/types/types.d.ts`，实测见 `scripts/commandE2E.ts` A 组 |
| 快照回放会覆盖投影折叠值 | `follow()` 原来先铺投影、再回放记录 → 历史里最后一个事件把折叠值覆盖回旧状态。`plan` 的 `pending` 是活例（每次重开会话都丢）。已改为**先回放、再铺投影** |
| 会话历史翻不到 | 不是「被清理」，而是**分页从未接上**：跟随流只带 `maxMessages: 60`，更早的内容从未进过客户端；而 `session/page` 的入口（`client.page()`、`loadMore` 消息类型）在协议层有、**没有任何地方调用**。已实现：适配器记住 `snapshot.cursor`（`throughSeq` 的唯一合法来源）与已折叠事件，界面加「加载更早的消息」按钮 |
| 崩溃遗留的 writer 锁会让 `dsh web` 起不来 | 强杀后 `~/.dsh/.credentials.yaml.lock` 留下；`dsh-atomic-write` 刻意不回收孤儿锁，而 boot 等 30 秒后抛错退出整个进程。已实现 `clearStaleDocumentLocks`（按肯定证据判持有者已死），在**每次拉起服务器之前**清理 |
| `contextPressure` **分母先到、分子后到** | 实测（`scripts/pressureProbe.ts`，三轮真实对话）：投影每轮推十来次，`contextWindow` 先就位，而分子要等**下一次请求上报 usage** 才出现。实测表：一轮后只有分母、本地复算已能给出 19206；二轮后官方 pressure=19206 / projected=19215；三轮后 pressure 仍 19206 而 **projected 19844**。两条结论：**①`projectedTokens` 才是逐轮变化的那个**（也是压缩后唯一会降的），必须优先；**②本地 `input + cached` 与官方 `pressureTokens` 逐字相等**（19206 == 19206，且 ≠ totalTokens 19208），可以在投影缺分子时**同口径**兜底。占用条按用户要求**常驻显示**：三个来源都拿不到时保留旧值，不清空 |
| `turnOutline` **字段名读错**（第三次「按猜测的形状写」） | 契约是 `{turn, seq, prompt, response}`（`dsh-session-turn-outline/lib/types/types.d.ts:12-21`），而扩展读的是 `{turn, seq, summary, startedAt}` —— `summary` 恒空串、`startedAt` 恒 0，`prompt`/`response` **从未被读过**。因为没有消费者，这个错误一直没有症状。前两次同类缺陷是 `goal`（嵌套形状）与 `subagentCatalog`（多按 `kind` 过滤）。2026-09-14 按契约改成 `{turn, seq, prompt, response}`（容忍度与官方 `outlineEntry` 同口径：`turn`/`seq` 坏了整条丢弃，预览坏了退化成空串），并由右侧**轮次横条**实际消费——**「解析了但既错又没人用」是最差的状态**，改完之后要么真用、要么别解析 |
| 历史分页的停止判据与服务端分页粒度**对不上** | 早先的口径是「至少取到用户的上一条消息」（消息流顶部变成用户消息就停）。但 `session/page` 的 `paginate()`（`dsh-api-session-controller/lib/index.js:1602-1624`）是按**固定消息条数**（本扩展传 50）从 `beforeSeq` 往前切一刀，切点与轮次边界无关；一轮几十条消息而一页固定 50 条，切点几乎总落在上一轮中间 → 判据不成立 → 接着取 → 一路取到底。**实际行为本来就是「一次触发取回整个历史」**，与设计意图相反，而用户认可这个行为。现按用户口径定成设计（见 `src/dsh/historyPaging.ts`），界面配右侧轮次横条做导航 |

### 已修复（第三批：配置文件热重载同步，2026-09-12）

**背景**：`dsh web` 的 web profile 是 `patchReload: live`（`dsh-app-boot` README：随产品
交付的 `web` 模板实时重载，其他随附模板只在启动时应用 patch），改配置文件**不重启**就生效。
宿主把这些变化以 `$events` 流上的 `{type:'emit', event, args}` 帧推给客户端，
但本扩展的 `onEventFrame` 是 `if (frame.type !== "waterfall") return;`——**帧全被丢掉**，
于是「外部改了配置，界面纹丝不动」。

DSH Web 会热重载的配置文件与到达客户端的帧（**[契约]** 类型声明 + 实现逐字）：

| 配置文件 | 宿主侧机制 | 转发给客户端的帧 |
|---|---|---|
| `$DSH_HOME/settings.yaml`（或 `.json`） | `dsh-settings-file` chokidar（`debounceMs` 100）→ `reconcileFromDisk` → `publish` → `bumpRevision` → `emitDocumentUpdated` | `settings/document-updated(ns, revision)` |
| `$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/profiles/<name>/cordis.patch.yml` | `watchUserPatches`（`hmr.registerConfig`）事务性重新组合 | 无专属帧；后果经 `commands/change`、`llm/adapters-updated` 出来 |
| `$DSH_HOME/.credentials.yaml` | `dsh-credentials-local` chokidar → `publish` | `credentials/reference-updated(ref)` |
| skill 根目录（`~/.dsh/skills`、`~/.agents/skills`、项目内） | `dsh-skill-filesystem` chokidar / `watchFile` | **没有**——`skills/change` 不在转发白名单里 |
| 客户端插件 bundle（仅开发时 `pnpm run dev:web`） | `dsh-client-hmr` stat 轮询 + `/plugins/events` SSE | 与本扩展（webview 前端）无关 |

转发白名单是 `dsh-api-remotes` 的 `API_REMOTE_FORWARDED_EVENTS`（20 项，其中 17 个
`emit`、3 个 `waterfall`）；官方前端据此让 settings 镜像失效并重读
（`ui-settings` / `ui-settings-models` / `ui-model-selection` / `ui-agent-preset`
监听 `settings/document-updated`，`ui-commands` 监听 `commands/change`）。

> **`llm/adapters-updated` 不是「模型目录变了」的充分信号**（第一版修完留下的漏网，
> 用户 2026-09-12 实测复现）。它只在提供方**拓扑**提交点发（适配器注册/注销、可配置
> 提供方目录增删）。改一个**已有模型**的 `reasoningEfforts`——路由集合没变——实测
> **只发 `settings/document-updated`**，而 `session/modelCatalog` 的内容确实跟着变。
> 只重读设置、不重取目录，模型选择框里的档位就永远停在旧目录上。官方
> `ui-model-selection` 的写法是对 `settings/document-updated` /
> `credentials/reference-updated` / `llm/adapters-updated` **三者**都
> `this.catalog.refresh()`。

| # | 条目 | 结论 |
|---|---|---|
| 20 | `$events` 的 emit 帧全被丢弃 | ✅ 新增 `dsh/configChanges.ts`：帧 → 重读动作的映射 + 合并闸门（同一批帧合成「在飞 + 一次 rerun」，对齐官方 settings 镜像），`controller.onEventFrame` 接上 |
| 21 | `settings/document-updated` 未同步 | ✅ 重读设置面板（含 `busyEnter`）、图片输入能力、部署默认模型（此前 `defaultModel` 有缓存，不清掉永远读不到新值）**并重取模型目录** |
| 22 | `credentials/reference-updated` 未同步 | ✅ 同上（密钥 set 状态在 `settings/describe` 里；换密钥可能激活提供方，目录也要重取，官方同口径） |
| 23 | `llm/adapters-updated` 未同步 | ✅ 重取 `session/modelCatalog` 并重放各域模型选择；连设置命名空间一起重读（可配置提供方就注册在设置里） |
| 24 | `commands/change` 未同步 | ✅ 重取所有打开域的 `commands/list`（顺带 `skills/list`——技能没有专属帧，只能借这些时机刷新，官方 `ui-skill` 同口径） |
| 25 | `agent-preset/selected` 未消费 | ✅ 按官方 `directory.resetSession(sessionId)` 只重取该会话的目录 |
| 26 | 删模型档位后档位列表不变（第一版漏网） | ✅ 三个事件都同时重读设置与目录（见上方注）；`runRound` 改为**顺序**执行（重读设置要用刚重取的目录，并发会读到旧的） |
| 27 | 新会话（投影 `{lastUsed:null,next:null}`）的部署默认不刷新 | ✅ `applyDefaultModelToScopes` 改判据：旧写法 `scope.model \|\| scope.lastModelSelection` 会跳过所有「已经套过默认值」的域，改档位后它们的 `efforts` 停在旧目录上；现在按「投影里有没有 `next`/`lastUsed`」判，且有未提交的界面选择（`pendingModel`）时仍不动它 |

**实测**：`scripts/configReloadProbe.ts`（新增）用**独立临时 `DSH_HOME`**（临时 home 里
dsh 会按 `PROFILE_TEMPLATES` 自动初始化 web profile）起真实 `dsh web`，直接改磁盘上的
配置文件，抓到真实帧：

```
1) 改 <tmp>/settings.yaml（ui-conversation.busyEnter）
   ✓ settings/document-updated ["ui-conversation", 1]
2) 改 <tmp>/.credentials.yaml（插入 DSH_CHAT_PROBE 引用）
   ✓ credentials/reference-updated ["DSH_CHAT_PROBE"]
3) 改模型的思考档位（llm-pi-ai 探针路由，两档 → 删掉 low）
   写入两档 → 目录读到 ["off","low","high"]
   ✓ 删档后目录读到 ["off","high"]；这一步到达的帧只有
     settings/document-updated ["llm-pi-ai", 2]（**没有** llm/adapters-updated）
4) 真实帧 → ConfigChangeRouter
   ✓ 只把「删档」那批帧喂进干净路由器：动作 = topology, settings
```

离线断言 `scripts/configChanges.test.ts` 钉住映射与合并：不认识的帧零动作、
4 条设置帧合并成 2 轮（每轮都重取目录 + 重读设置）、**只有
`settings/document-updated` 也要重取模型目录**（删档现场）、`runRound` 顺序执行、
一轮内某个动作失败不拖垮其余动作、`applyDefaultModelToScopes` 的判据不被改回旧写法。

### 已修复（第四批：会话内容绘制对齐 DSH Web，2026-09-14）

背景：把「一轮对话在界面上怎么画」按官方逐条对齐。原始差异清单在
`docs/continue-ui-spec.md` 之外的审计记录里（本轮由子代理逐条对照官方包产出，
高 4 / 中 6 / 低 3），下表是结果。

| 维度 | 结论 |
|---|---|
| 轮级过程折叠 | ✅ 官方默认 compact（`DEFAULT_TRANSCRIPT_VIEW_MODE = "compact"`）：一轮结束后折成一枚按钮（「N 次工具调用 · K 个 subagent」，皆 0 读「已思考」），点开铺回；流式期间不折（官方 `turnClosed`）。**2026-09-16 改口径（有意偏离官方）**：成员只收**机器噪声**——思考 / 工具 / 非 system 的上下文注入；**正文与提示永不折**，也不看段所属 step。官方把「最后一个定稿答案步」之前的**一切**都折起来（含中间正文，按钮因此多一段「M 条消息」，`client.js:6756-6786`），代价是①中途的长说明会被藏起来（用户报「容易被忽略」）②尾步不是答案时（中断/报错轮）**整轮不折**，而旧口径「只折边界之前」会让边界之后的一大截工具行平铺（用户报「大量工具没有折叠进去」）。豁免保持不变：中止/截断提示（官方 `turn-error` / `turn-max-tokens`）与**系统提示词**（官方 `system-prompt`）永不折；**上下文注入照常折叠**（2026-09-14 修正：官方 `TURN_PROCESS_INDEPENDENT_KINDS` 里没有 context 一类） |
| 思考段 | ✅ 恒默认折叠（官方 `useState(false)`），摘要**流式中取最后一行、结束后取第一行**并剥 `**` |
| 运行中文案 | ✅ 「生成中」→「深度求索中」。**不加**官方那套扫光 + ≥15s 实时用时：鲸鱼发光已是活动证据，工具行本就各自显示耗时（用户 2026-09-14 拍板） |
| 中断 | ✅ 不再画成红色报错（官方是冻结正文末尾的 tertiary 色小胶囊） |
| 轮尾用时 | ✅ 「用时 X」胶囊 + 明细（本轮总用时 / TPS / TTFT）。速度为**整轮累加**（官方 `deriveStats` 口径），TTFT 取第一步、十秒内一位小数（官方 `formatLatencySeconds`） |
| 工具行 | ✅ IN/OUT 分区（仅非 diff 工具，官方的 diff 类直接给 DiffBlock）、折叠行 `+N -M`（官方 `diffTotals`）、路径可点（官方 `fileLink`） |
| 代码块 | ✅ 自动换行（官方 `pre-wrap` + `break-all`），不再横向滚动 |
| markdown | ✅ 任务列表复选框（白名单放行 + 钩子只放行 checkbox）、软换行改 CommonMark（`breaks: false`） |
| 未知内容块 | ✅ 官方 default 分支的「未知内容块」记录（同时补掉 V6：`file` 块） |
| 上下文条目 | ✅ 按 form 分派正文（instructions 的变更列表 / catalog 的条目 / snapshot 的分节 / relay 的会话 / recall 的计数），形状判据**全有或全无** |
| 审批 / 提问卡 | ✅ 待处理的**接管输入区**（官方 `conversation.composer` 槽 + `pendingInteraction` 选举，提问优先于审批）；已答过的留在对话流里当记录 |
| 目标条 | ✅ 正文默认一行截断 + 展开按钮切全文、内联编辑（`/goal edit`）、展开时正文与按钮垂直居中、悬停给「目标 + 受阻原因」 |
| 文件芯片 | ✅ `[新增]` / 删除线（官方没有改动词类记号，这是本扩展的信息增量） |

**刻意保留的偏离**（都是用户口径，不要「顺手对齐」掉）：

- **工具行的实时耗时**：官方 `ToolRowProps` 没有耗时字段。用户明确说「实时用时每个工具就会显示」，
  所以保留——这是信息增量，不是漏抄。
- **用户消息不是右对齐气泡**：沿用输入框样式，见 `app.css` 里的注释。
- **两行文件行之间去重**：官方不去重（同一路径两行都列），我们去掉交付行里已申报的重复。
- **`+N −M` 的计数口径**：官方 Web 按**编辑块**统计（块内没真正变化的行也计入），
  本扩展按**最终结果**统计（只算真正变化的行）。用户 2026-09-14 确认本扩展的口径更贴近
  直觉，**保持不动**——不要为了「跟 Web 一致」而改（这是本扩展的信息增量之一）。

### 段顺序（2026-09-14 修的活路径缺陷）

`applyAssistantMessage` 此前把 durable 的思考/正文**追加到消息末尾**。模型是边说边吐
工具调用的：`tool-call-delta` 会先把工具行建出来，durable 消息随后才到 → 思考/正文被排到
自己那个 step 的工具行**后面**（「编辑 → 思考 → 编辑…」）。离线重放路径顺序本来就是对的，
所以只有真实流式会话看得出。现在插在**本 step 最早的工具行之前**（官方按内容块顺序渲染）。
复现与证据：`scripts/renderOrder.test.ts`（修复前失败）、`scripts/renderOrderProbe.ts`
（真实日志的事件序 vs 段序）、`scripts/liveOrderProbe.ts --live`（真实服务器上验证
`tool-call-delta` 早于 durable `assistant/message` 到达）。

### 分页（2026-09-14：没取到上一条用户消息就停）

「取到一轮的开头就停」这条规则没错，错在**进展判据**：当时界面拿「首条消息 id 变没变」
判断这一页有没有进展，而更早的事件常常只是把现有的第一条助手消息**补长**（消息 id 是按
轮次派生的 `a:<turn>`，不会变）→ 第一页并入了 250 条事件却被判成「没进展」，在半轮中间
收手。现在连取由**宿主**驱动，判据是适配器返回的**真实新增事件数** + `hasMore` + 顶部
角色（`src/dsh/historyPaging.ts`）。现场：`scripts/pageLoopProbe.ts --session <id>`
（修复前第 1 页就停，修复后一直取到 `u:14` 那条用户消息）。

### 仍未修复

> 2026-09-14 用户报的一批（问卷依次问答 / 答完收缩、`@` 列表 `..`、滚到顶自动翻页、
> 选区行号与焦点窗口、目标条展开按钮、`commit.msg.txt` 幽灵条目、工作区分组、令牌
> 说明、扩展说明、脚注、tps 口径澄清）不在本章的分批表里，逐条记录见 `CHANGELOG.md`
> 的「未发布 → 用户报的一批（2026-09-14）」。其中**工作区分组**的端到端证据是新加的
> 探针 `scripts/workspaceProbe.ts`。

- **#17 停止语义**：官方契约说 cancel 后排队工作按 FIFO 继续，UI 只发一次 cancel。
  但实测 `build/queue-continue-probe.mjs` **只 cancel 不会让队列自行接续**（两轮 3/3），
  且「之后再提交会不会唤醒队列项」**不稳定**（同一脚本两次运行 0/3 vs 3/3）。
  这是实测与契约冲突，**刻意保留**现有实现（摘空 → cancel → 重发），
  因为官方做法在本机实测下会让队列卡住。取舍已记入 README 的「已知限制」。
- §四 #16（本表 #18「未消费的投影」）的余项：`schedule`、`agentPreset`、
  `subagentTiming`、`permissions.options`
  （前三个是面板/展示层功能，未做；`permissions.options` 目前只取 `currentValue`）。
- **markdown 的能力缺口**：脚注**已补**（2026-09-14）——官方 `markdown.footnotes` 真实
  存在，我们补的是自家的 marked 扩展（`src/webview/footnotes.ts`，无需新依赖），结构
  逐字对齐官方渲染器，见 CHANGELOG 的「markdown 脚注」一节与 `scripts/footnotes.test.ts`。
  **公式**（要 **KaTeX**）与**代码高亮**（官方是 **Shiki** 增量高亮）仍是**刻意不做**：
  两者都要引入第三方依赖并同步 `THIRD-PARTY-NOTICES.md`，用户决定**暂不引入**。
  这是**知情取舍**，不是漏抄：官方有的这两项，我们在本版本里不做，界面上表现为
  公式按纯文本显示、代码块不着色。日后要补，照官方口径加依赖即可。

> **编号约定**：§三 / §四的编号是**原始审计**的条目号（1–19），源码注释里的
> `§12`、`§19` 这种引用指的就是它们；§零两张修复表的编号是**本表自己的顺序**，
> 第 16–18 项与 §四的 16–18 并不对齐（本表 #16 = §四 #17，本表 #18 = §四 #16）。
> 引用时带上「§四 #N」或「§零 #N」以免歧义。

### 未验证 / 未覆盖（**别当成已完成**）

这几条不是「已知缺陷」，而是**我们没验证过**——没有端到端证据，只有契约推断或
单测。原样记在这里，免得下一轮被当成已经做过。

| # | 事项 | 现有证据 | 缺什么 |
|---|---|---|---|
| V1 | 目标条的官方 inline 编辑（`/goal edit`）未实现 | — | 整项未做；另外 `blocked` 时 `blockedReason` 只进悬停 `title`（`Composer.tsx` 的 goal-bar），界面上看不见原因 |
| V2 | `subagentCatalog` 的真实形状 | 只有契约（官方 `projection-types.d.ts`）+ 离线断言 | 没有端到端——要真跑一个子代理，看投影实际长什么样 |
| V3 | 崩溃恢复链（强杀 → 重启 → 服务器起来） | 只有 `clearStaleDocumentLocks` 的单测 | 没有端到端：没真强杀过再拉起来 |
| V4 | 占用条 `projectedTokens` 的长对话 / 压缩后行为 | `scripts/pressureProbe.ts` 只跑了三轮短对话（三轮内 pressure 没动） | 长对话与压缩触发后的实测 |
| V5 | `upload.message`（服务端给的上传失败原因） | 字段在线格式里（`shared/chat.ts` 的 `UploadState` error 变体） | 界面只渲染通用文案 `texts.uploadFailed`，**从不读这个字段**——用户永远看不到真正的失败原因 |
| V6 | ~~助手消息里的 **`file` 内容块**不渲染~~ **已解决** | 适配器折 `text`、`reasoning`、`image`，其余块走「未知内容块」记录（官方 default 分支同此） | `file` 块现在折成 `unknown` 段、按官方口径画一条 JSON 记录——与官方一致（官方也没给 `file` 专属分支）。`tool-call` / `tool-result` 仍**故意**不在这里渲染（各有自己的事件） |

> `log()` 里成片的中文是**开发者可见**的输出通道日志，不受「用户可见文字必须
> 双语」约束——这条例外已写进 `AGENTS.md` 的双语节。

---

## 一、结论概览

> ⚠️ **下表是审计当时的原始判定，读之前先看上面的「零、修复状态」。** 表中标
> 「不一致」的项绝大多数已修复（见 §零的三批表格）；保留这张表是为了留住
> 「当时差在哪」的差异清单，**不是当前状态**。

| 维度 | 判定 |
|---|---|
| 事件折叠骨架（消息/工具/流式叠加） | **基本一致** |
| surfaceOp 替换事件一律跳过 | **一致（且这正是官方契约要求的做法）**，非缺陷 |
| 工具行的摘要 / 状态语义 | **不一致**（信息丢失 + 图标失效） |
| 投影消费 | **不一致**（20 个投影只消费 10 个；形状读错的两处已修：`plan`、`turnOutline`） |
| 斜杠命令 | **不一致（功能失效）** |
| 提交模式（queue/steer） | **已修**（2026-09-14：`resolveSubmitMode` 逐字移植 + 冷启动读取 + 手势分叉 + 按钮/队列行插话） |
| 停止语义 | **不一致**（与官方契约相反） |
| 附件表示 | **已修**（图片内容块 / 文本上传 / 其余降级路径引用；`@` 改为正文里的 `@path` token） |

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

> **2026-09-14 补**：`turnOutline` 虽然早有 `case`，但**字段名读错了**（见下一节），
> 而且从来没有消费者。现在按契约解析并由右侧轮次横条使用。
> 仍未做的还有：`subagentTiming`（成对字段，子代理面板的「活跃耗时」列）、
> `subagent`（身份投影，决定子代理会话的只读输入框）、`schedule`、`agentPreset`、
> `permissions.options`、`modelCatalog` 的另外三个字段。

### 17. 提交模式：用户设置 `busyEnter: steer` 被忽略 **[契约][实测环境]**

> **2026-09-14 已修（本节保留为历史记录 + 修复明细）**：模式判定改成官方
> `resolveSubmitMode` 的逐字移植，并补齐「冷启动不读设置」「`running` 判定晚于乐观
> 置位」「Cmd/Ctrl+Enter 未分叉」「发送按钮恒为停止」四处缺口。修复后 `steer` 的
> **生效范围**是：agent 正在运行、且手势是主手势（回车/发送按钮）时用设置值，
> Cmd/Ctrl+Enter 取相反值，空闲一律 queue。详见 CHANGELOG 未发布第六节。

本机 `~/.dsh/settings.yaml` 就是 `ui-conversation.busyEnter: steer`。
官方 `resolveSubmitMode(preferred, running, gesture, steeringAvailable)` 据此决定 queue/steer；
扩展曾把 `"queue"` 写死（`controller.ts:1484`、`1819`），且设置面板里改它「保存成功但不生效」。
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

**悬空引用 [代码] —— 已解决。** ESC（`stopRunning`）的设计注释引用
「实测（`scripts/queueContinueProbe.ts`，两轮各 3 次）」，而该脚本一度被删除、
仓库内不存在 —— 立论依据当时**不可复现**；`scripts/queueEscE2E.ts` 又只验证扩展
自己的三步实现，从未测「只 cancel」分支。

**现状**：探针已恢复（`scripts/queueContinueProbe.ts`，登记在 `esbuild.scripts.mjs`
的 entries；`README.md`「已知限制」与 `controller.ts` 的 `stopRunning` 注释都引用它），
两个事实重新成为可复现证据：

1. 只 `cancel` 不会让队列自动接续 —— 严格断言 3/3；
2. 中止后**再提交新消息**会不会顺带唤醒保留的队列项**不稳定**（同一脚本两次运行
   得到 0/3 与 3/3 两种相反结果）—— 只作为观察打印，不做硬断言，否则是一条随
   机器负载飘的假防线。

正是事实 2 让客户端无法照官方契约「只发一次 cancel」，取舍与理由见上方
「仍未修复」的停止语义一条。

---

## 六、无法确认（未验证，不猜测）

1. `request/header` 是否在典型会话造成可见的系统提示词卡片缺失（取决于官方去重逻辑运行结果）。
2. turn-process 折叠在用户真实 transcript-view 设置下的视觉体量。
3. 官方工作区列表对 `depth`/`completed` 的渲染器位置（未在已安装产物中定位）。
4. 本部署 `permission-presets.presets` 的实际配置（故「read-only 是否真不存在」不确定）。
5. VS Code webview 的拖放/粘贴文件能力（可证「扩展未实现」，不可证「官方做法可否等价实现」）。
6. `images` 参数名是否曾在历史版本被接受（只能证明当前唯一出现处在 fixture）。
