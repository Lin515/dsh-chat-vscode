# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 未发布

### `.chat-scroll` 的端口收成一个 module（2026-09-19）

- **收敛**：自动滚动（贴底 / 放跟随 / 回底胶囊）整条链路从 `App.tsx` + `Composer.tsx` 两处手工穿线收进
  `src/webview/autoScroll.ts` 一个 module：`AutoScrollPort`（`scrollEl`/`contentEl`/`release`/`pin`）是唯一
  端口，`App.tsx` 只剩接线（920 → 703 行），`Composer` 的两个滚动 prop 合成一个 `chatScroll`。
  行为逐条不变（意愿只由手势决定、切会话重置贴底、胶囊按实测距离、轮次跳转显式放跟随、发消息/点胶囊显式
  要最新、钉底仍在 `useLayoutEffect`）。行为断言从 `styles.test.ts` 的源码正则换成真调用（新增
  `scripts/autoScroll.test.ts`：纯状态机 + 假宿主环境真派发事件）。
- **修**：`test/scroll-probe.html` 的 P4/P9 误报失败（2026-09-19 当天修）。那条 I2 断言用
  「消息文本前 40 字」当锚点身份，而场景会往**被锚定的那条消息**追加工具段（`appendTool` 默认发给
  `a:3`），工具行的文字落进消息文本靠前位置就把这个窗口顶掉 → `top()` 找不到节点返回 null →
  报成「锚点 79 → null」。实测同一步里按 `data-msg-id` 找得到、按文本前缀找不到。改身份为
  `data-msg-id`（文本前缀只作兜底），并把身份写进失败文案。修后 **9/9 全过**；并做了一次环境级注入
  （把 `wheel` 监听掐掉）确认**牙齿仍在**：P4/P9 立刻变红，其余 7 个不受影响。夹具本身的问题，
  产品侧无改动。

### 会话状态面收敛为一个生产者（2026-09-19）

- **一个字段表**：新增 `src/dsh/sessionView.ts` —— `SessionView`（23 个字段）+ `SESSION_VIEW_KEYS`
  （声明顺序 = 帧里键的顺序，与原快照逐字一致）+ `SESSION_FIELDS`（唯一字段表，`satisfies` 强制键集完整）
  + 三个入口 `sessionView()`（首帧 / 切会话专帧）、`sessionPatch()`（增量 patch，24 处）、`appearanceView()`。
  以前首帧快照、增量 patch、切会话专帧**各拼一份**，加一个字段只改其中一处会让它在切换会话后
  **静默复旧/丢失**（`goal` 清不掉、「加载更早」卡死都是这一族）。`undefined → null` 的过线折返也只在
  构造器里做一次。
- **修**：子代理目录在宿主与界面两侧**同名**（`subagentEntries`）。此前宿主发 `subagents`、界面读
  `subagentEntries`，改一侧忘另一侧没有任何编译期或断言保护（开着子代理面板切会话时列表停在上一个会话上）。
- **修**：后台任务面板的一次刷新**少投一条重复帧**（同一份数据曾连发 `jobs/list` + `patch.jobs`，面板会闪
  一下）；按需请求（打开面板）那条 `jobs/list` 保留。
- 新增断言 `scripts/sessionView.test.ts`：三个生产者的字段键集合做**通用**比较（同一份输入走三条路，
  `Object.keys` 必须全等 + 值全等 + 键顺序），并对宿主侧接线做反漂移扫描；两次注入验证（字段清单层 /
  生产者层）都确认过「只改一处必然红」。

### `@key` 文案的登记从 7 处收成 1 处（2026-09-19）

新增 `src/webview/messages.ts` 作为**唯一消息表**（286 个键，每条自带中英两份，带参数的登记成函数、
不带参数的登记成字符串）。两份界面词典、`resolveText()` 的解析、宿主标记清单都由这张表派生；
`resolveText` 里那个 37 个 `case` 的长 `switch` 改为查表，不再有「重复 `case` = 后者不可达」这类
工具链看不见的静默故障。

**行为逐字不变**：1598 条标记级 + 572 条字典级快照对拍，zh 侧零差异；3 条英文串是有意对齐
`vscode.l10n` 的英文源串（key 就是英文源串，两处必须一致）——`authTokenRejected` / `serverNotReady`
的 “DSH: Restart Server” 改为 “DSH: Restart Internal DSH”，`serverUnreachable` 改为
“Cannot reach the DSH server at {0} yet…”。同时修掉两处中文指向**已改名/不存在**的命令
（`authTokenRejected` 的「DSH: 重启服务器」→「DSH: 重启内部 DSH」、`serverNotReady` 的「重启服务器」→
「重启内部 DSH」；「查看日志」是 webview 自己的按钮名，**没动**）。

**VS Code 原生通知那一层补上断言**（此前零覆盖）：`hostText` 覆盖的 key 集合必须等于消息表里标了
`vscode: true` 的 6 条、源代码扫描证明英文源串没有手写副本、每条的英文源串在
`l10n/bundle.l10n.zh-cn.json` 里都有**不同**的中文译文。断言在 `scripts/i18n.test.ts`。

### 未结算的审批 / 提问收成一个模块（2026-09-19）

宿主侧「还没结算的审批 / 提问」此前散在 `controller.ts` 的三个集合（`heldEvents` / `eventSessions` /
`handledEvents`）与六个方法里：去重、回放不删、结算清哪些集合全靠调用方记得配对，其中 `eventSessions`
曾经只增不删（跨会话累积），补齐后 Host 撤回那条路仍然漏清。现在四条规则收进
`src/dsh/pendingInteractions.ts` 的 `PendingInteractions`：`hold()` 收下并去重、`forSession()` 只读回放、
`settle()` / `withdraw()` 是**仅有的**两个结算出口（返回原始记录，会话 id 就在记录里，因此不再需要第二份
「事件 → 会话」索引）。控制器只剩「收帧 → 记账 → 投递」与「答复 / 撤回 → 结算 → 回 Host」。

行为一个字没变（重复投递去重、回放不删条目、结算点仍是 `answerApproval` / `answerQuestion` /
`cancelQuestion` / Host 撤回四处、`ensureScope` 仍然不回放、`bindViewToSession` 仍然回放）。
原来靠「读 5000 行源码 + 数字符串」钉住这套生命周期的断言换成了对模块的真 API 断言
（新增 `scripts/pendingInteractions.test.ts`，7 节）。

### 架构收敛：交互选举、停止入口、会合状态（2026-09-19，架构评审落地）

三条都是「同一件事在多处各写一遍」的收敛，**用户可见行为不变**（各自注明例外）：

- **待处理交互的选举与抑制合成一次计算**：`src/webview/pendingInteraction.ts` 现在只暴露
  `resolveInteractions(messages) → { pending, takenOver }`。`pending`（谁接管输入区）仍按官方注册优先级
  plan-review > 普通提问 > 审批、同级取最后一条；`takenOver` 是要交给输入区渲染的**段 id 集合**
  （键是 `segment.id`、不是 `requestId`，最多一个元素）。`App.tsx` 只算这一次，`Composer` 渲染当选那张、
  `Message` 跳过同一段（子代理转写面板不传集合 = 卡片留在流里，那是另一个会话的东西）；`Composer` 里
  「有没有在等审批/提问」的第三份 `.some(...)` 推导随之删除（判据改为 `!pending`，与原条件等价）。
  断言：`scripts/pendingInteraction.test.ts`、`scripts/questionRender.test.ts` 第 7 节（用真实 `Message`
  渲染「两张 waiting 并存」，没被选中的那张必须在 HTML 里）。
- **窗口侧管理器收敛「停止」入口**：新增 `stop({ release, cancelWait, askSupervisor })` 与只读快照
  `snapshot()`（17 个字段，全部取自既有读法）；`detachInternal` / `releaseInternal` / `cancelWaiting` /
  `stopAndExit` / `stopDetachedInternal` 全部变成薄壳（方法名与签名不变，供探针继续调用），连点「停止内部
  DSH」不再重复发控制帧。**不给 `options` 时按旧 `stopAndExit()` 走**（`scripts/smoke.ts` 等仍写
  `server.stop()`），要"只收连接"显式写 `stop({})`。语义与 2026-09-19 口径零改动，设计记在
  `docs/design-supervisor.md` §9.11；断言 `scripts/supervisorPolicy.test.ts` 第 10 组 +
  新增 `scripts/connectSnapshot.test.ts`。
- **连接条的三类状态与按钮矩阵收成一个纯函数**：新增 `src/webview/connectView.ts` 的
  `connectViewOf(state, texts, resolve) → { kind, text, buttons }`（不依赖 React，`resolve` 由界面注入）。
  `App.tsx` 的 `ConnectionBar` 只渲染它的结论，`statusText` / `connectingText` 两个局部判定与
  `state.internalRunning === true` / `state.externalState === …` 的现场判断一并删除（"哪颗按钮发哪条
  指令"留在 `App.tsx` 的 `CONNECT_POST`，界面 DOM 不变）。文案与按钮矩阵**逐字不变**（§9.4 是权威）。
  断言：新增 `scripts/connectView.test.ts`（46 条，三类 × 每种标志逐条）；`scripts/styles.test.ts`
  第 34 组里按渲染分支形状写的两条源码断言迁到了这个新文件。
- **控制器不再镜像管理器**：`internalRunning` / `externalReachable` 两个字段合并成一份两轴观测
  `facts`（两轴是**异步探测**，快照里没有这两个值），`externalState()` / `viewConnection()` 两个私有
  判定删除，连接那组界面字段由模块级纯函数 `connectionFieldsOf(snapshot, facts, round)` 一次算出
  （`externalAddress` 取自 `snapshot().externalUrl`；控制器不再调 `getStatus()`）。四个停止落点改为
  直调 `SupervisorManager.stop({…})` 的对应档（表写在 `controller.ts` 的 `prepareRound` 顶上）：
  `prepareRound` 与 `ensureConnected` 换目标 → `{ cancelWait: true }`（**不收连接**：那一轮要重连
  同一个后台）、`abandonRound` / `stopReconnect` → `{ release: true }`、
  `stopServer` → `{ cancelWait: true, askSupervisor: true }`。断言：`scripts/connectionStop.test.ts`
  第 8、9 组。
- **会合状态一个解码器、一处路径、探针走真入口**：`supervisorProtocol.decodeState(value, opts)` 成为
  文件路与管道公共用的**唯一**份逐字段校验（安全边界只收紧：`baseUrl` 仍必须 http(s)、`command`/`socket`
  收紧成非空、`serverPid` 收紧成正整数）；`rendezvousPaths(directory)` 成为四处路径的唯一产出，socket 名
  只由会合目录派生（删掉了启动器里"切目录字符串反推分组"那段）；四个验收探针改成直接构造
  `SupervisorManager`，不再验手抄副本。唯一的行为收紧：管道路的 `idleSec` 现在也过 `clampIdleSec`。
  见 `docs/design-supervisor.md` §3.8；断言 `scripts/supervisorProtocol.test.ts` 第 3.5 组。

### 两个内部按钮统一为「有就接上、没有就起一套」（2026-09-19 用户口径）

「连接内部 DSH」以前是**只接不启动**：内部不在时它只能回按钮态；而缺省 `autoConnect: true`
时看起来"能起来"，其实是 5 秒后心跳替你起的。现在两个内部按钮走**同一套逻辑**（都允许拉起）——
界面的两轴状态与后台真实状态之间必然有偏差（守护进程刚退场、另一个窗口刚拉起、探测的 5 秒节拍），
显示哪个只是措辞，点哪个都能把内部后台用起来，不会出现"点对了按钮却什么都没发生"。
拉起来这条路**不需要扩展发任何指令**：守护进程启动就无条件拉起 dsh（这条不变量与
「协议里没有也不需要『启动后台』控制帧」一起记在 `docs/design-supervisor.md` §3.7）。

`autoConnect` 的边界同时重申：它只决定 VS Code 启动后要不要**自动**连接，
**不拦任何用户点击**（发消息 / 新建 / 切会话 / 启动内部 DSH / 连接内部 DSH / 重启内部 DSH 一律允许启动）。
配套同步 `AGENTS.md`、`docs/design-supervisor.md` §9.2/§9.4/§9.9、README；
断言见 `scripts/autoConnectConfig.test.ts` 第 4 节。

### 待处理交互卡：只撤下被输入区接管的那一条（防御性加固）

官方框架按会话只留一个待处理交互（`ReadonlyMap<SessionId, …>`），所以正常只有一张卡。
但扩展宿主侧的卡片补投（未结算事件的回放、重连时重放进适配器）**有机会**把两条 waiting 段
放进同一份消息流；旧规则是「凡是 waiting 都从流里撤下」而输入区只画一张，于是那张卡
**谁也渲染不了**——用户看不到它、也就答不了它，而 agent 正在等它（实测：用真实
`Message` 渲染两张 waiting 卡，旧行为下 `.segments` 是空的）。

现在只有**被选中的那一条**撤下，其余留在消息流里可答；断言见
`scripts/pendingInteraction.test.ts` 第 5 节与 `scripts/questionRender.test.ts` 第 7 节。

### 投影摄入补上水位契约，形状解析独立成表（2026-09-19）

投影是三次「按猜测的形状写」的现场（`goal` / `subagentCatalog` / `turnOutline`），而解析一直内联在
没有任何测试接缝的 `controller.ts` 里；同时线上带的 `seq` / `asOfSeq` 在三个调用点上全被丢掉，
契约那句「重放的旧帧不能把值顶回去」没有落点。这次一并收掉：

- **形状解析**搬进 `src/dsh/projections.ts` 的读取表（14 个消费键，承重字段与容忍度逐行照搬）；
- **水位**搬进 `src/dsh/projectionStore.ts`：higher seq wins（同 seq 也算负）、baseline 在它的
  截止水位上播种、替换型 baseline 先截断。**拿不到水位时不比较也不清空**（按肯定证据写）；
- **一个键一条**：`src/dsh/projectionIngest.ts` 的 `ProjectionHandlers` 是映射类型，少一个键编译不过；
  键集合与契约 19 键双向对拍（5 个有意不消费的在断言里显式登记）；
- 适配器不再直接读 `projections.values.title`（绕过水位的第二个读点，同一个开帧里标题以前被应用两次）。

**可能被看见的行为差异**（都只在异常路径上）：陈旧的 baseline 不再能把界面拉回旧值（跨两条流交叉
到达时按水位判）；某个投影键从 wire 上消失时界面**清空**而不是保留旧值——目标条、权限胶囊、待办、
用量、轮次横条、上下文构成、会话统计都会跟着「能力缺失」消失。占用条（`contextPressure`）与历史
抽屉的标题**刻意保留旧值**，口径不变。实测真实 baseline 是全量的（18 个键），所以清空那条平时走不到。

实测取证：`scripts/projectionSeqProbe.ts`（baseline `asOfSeq=3`、增量帧 `seq=4/5/6`、开帧
`asOfSeq === cursor === 6`）；断言 `scripts/projectionStore.test.ts` / `scripts/projectionIngest.test.ts`；
`npm test` 61 → 63 套，`command-e2e` A/B/C 与改动前逐条一致。领域词表见新增的 `CONTEXT.md`，
「列表标题不走 store」这条有意偏离记在 `docs/adr/0001-projection-value-store.md`。

### `dshChat.autoConnect` 改动即时生效，不再弹「重载窗口」（2026-09-19 用户口径）

原来 `url` / `command` / `autoConnect` 三项改动都提示重载窗口。收紧为只有 `url` /
`command`（激活期只读一次）需要重载；`autoConnect` 只是自动路径的许可，改动即时应用——
停在按钮态且没定过目标时立即按新值选一次路，已连上的不动。断言见新增
`scripts/autoConnectConfig.test.ts`；README 中英两版与 design-supervisor §4.4/§9.10 同步。

## 0.8.2（2026-09-19）

这一版是「内部 DSH 优先、外部 DSH 备用」连接机制的完整落地：09-18 上线选路与目标粘性，
09-19 按用户实测修掉两处收尾问题（切到外部后内部守护进程还赖着不退场、「停止连接」停不下来）。

### 修复：内外部切换不彻底（切到外部后还在跟内部守护进程打交道）（2026-09-19）

用户实测：本来是内部那套，内部 dsh 崩掉（守护进程又把它拉起来）之后点「连接外部 DSH」
连上了外部——但那个内部 DSH **一直存在**，诊断信息里显示的也还是内部 DSH。

根因是**换目标只换了"决策"，没换"手里握着的东西"**：通往守护进程的那条常驻 socket 一直
开着。守护进程的空闲判据正是"socket 上还有没有活连接"，于是它永远认为还有人用、不断把
dsh 拉回来；它推来的 `state` 也继续把管理器的状态改回内部那一套（诊断读的正是那里）。

- **`SupervisorManager.detachInternal()`**（新增，唯一落点）：目标切到外部时关掉连接、清掉
  内部那套的状态记忆。**断开不碰任何进程**——内部后台退不退场交回守护进程按"还有没有活
  连接"自己裁决（没别的窗口连着 → 空闲阈值后连 dsh 一起收场）；
- 三处各断一次：`ensure()` 的外部分支（换目标主路径）、5 秒心跳（兜底）、连接回调按目标
  守卫（`onState`/`onGoodbye` 只在"目标还是内部"时写状态，收尾帧也不许改写界面）；
- **`peekState()` 不再回落到读磁盘**：从前它会把磁盘上那份（别的窗口在用/正在收场的）内部
  后台当成"本窗口的后台"报出来，诊断里"后台进程：守护进程 X, dsh Y"就是这么来的；
- 控制器两道闸：目标是外部时 `onServerStatus` 提前返回（内部那套的退场/失败不许改界面）、
  `stopServer` 不 `prepareRound()`（外部那条连接一个字都不动）；
- 「DSH: 停止内部 DSH」在分离态下**短暂接入**内部守护进程发完 stop 就断开；回执按"请求有
  没有真的发出去"给——内部守护进程不在时如实说「内部 DSH 没有在运行」，不再谎报已停止；
- 诊断多一行「当前连接目标：内部 DSH（守护进程）/ 外部 DSH（dshChat.url）/ 尚未选定」。

**同一轮的第二半：「停止连接」也彻底交还占用**（用户口径：不连就不占用）

「停止连接」此前只收掉与 **dsh** 的连接与重试循环，守护进程那条 socket 留着——于是它永远
认为还有人用（内部 dsh 不会空闲退场），它的推送还能把界面从"已停止"拉回"连接中/错误"，
而且 socket 一掉心跳还会把它**接回来**。现在：

- 新增 `SupervisorManager.releaseInternal()`：**断**（关连接）+ **挡**（`detachedByUser`，
  心跳不许再接回；这一道必须排在 `connection.connected` 之前，否则断开后 5 秒又被接上）；
- `bringUp()` 清掉该标记——显式动作（发消息 / 连接按钮 / 重启 / 激活期选路）照样能连回来；
- `abandonRound()` 再 release 一次：一轮排队/重试的连接可能在叫停之后才建起连接却被控制器
  放弃，幂等再收一次兜住；
- `peekState()` 在该标记下返回 undefined（占用已交还，不该再报它的 pid）；
- 「DSH: 停止内部 DSH」的短暂接入判据从"目标是不是内部"改成"**手里有没有活连接**"：
  交还占用后守护进程可能还在空闲窗口里活着，按目标判会谎报「内部 DSH 没有在运行」；
- 顺带：`probeFacts()` 落实自己注释里的口径——**已连上就不再探外部**（此前每 5 秒仍会朝
  外部地址发一次 GET），跳的时候沿用上次结论、不改写成"不可达"；
- **交还之后再点「重启内部 DSH」必须真的重启**：那条路径在停止连接之后是常态，而 `restart()`
  原来在"连接不在"时直接 `return this.ensure(...)`——只接上、一个控制帧都没发，界面却照旧弹
  "已重启"。现在先接上再发 `restart`，并把 `previous = this.state?.serverPid` 挪到接上之后读
  （早读时它是 undefined，"还没开始重起就接着等"永远不成立，会把**旧地址**当成"重启完成"）。

代价（已与用户确认）：后台真退场后，下一次发消息走"拉起一套"（冷启动 5~8 秒）；别的窗口
还在连着就继续服务。

**「停止连接」之后还能连上吗**：能，但只由**用户显式动作**触发——「连接内部 DSH」（只接不启动）、
「启动内部 DSH」、发消息 / 新建 / 切会话、「重启内部 DSH」，以及重载窗口或新开窗口；自动路径
（5 秒心跳）不会替你接回去。

断言：`supervisorPolicy.test.ts` 第 7 组起一个**真的**守护进程 socket 服务端数活连接
（接内部 1 条 → 切外部必须 0 条 → 状态仍是外部 → 切回内部重新接上）；第 8 组同法验
「停止连接」（对面 0 条 → **调一次心跳仍是 0 条** → 显式动作重新接上 1 条）；第 9 组验交还之后
重启**真的重启**（假守护进程必须收到 `restart` 控制帧，且返回的是新地址）；
`connectionStop.test.ts` 第 5/6/7 组钉控制器两道闸、心跳兜底的顺序、以及这三处接线；
端到端 `node build/supervisor-manager-probe.mjs` 第 6/7/8 步用真 supervisor + 真 dsh 走
"切外部 / 停止连接 → 内部后台自己退场 / 交还后重启仍是真重启（令牌变了）"。
文档：design-supervisor §4.3 更正 + §9.1 探测口径 + §9.8/§9.9。

### 连接机制：内部 DSH 优先、外部 DSH 备用（2026-09-18）

- **选路自动化且有粘性**：启动后按「内部守护进程在跑 → 连内部；否则 `dshChat.url` 配了且
  此刻可达 → 连外部；都没有 → 拉起一套内部」**选一次**，此后重试只认这个目标——不会因为
  另一个后来起来了就换（换目标 = 换服务器、换会话列表、丢掉正在跑的轮次）。旧的
  「`url` 非空即外部模式、内部相关配置全失效」作废，`url` 退化为备用地址。
- **配置改名 `dshChat.autoStart` → `dshChat.autoConnect`**，含义也变了：关掉 =
  启动后**完全不自动连**，只显示按钮（不再是"后台在跑就自动接上"）。不做旧键兼容。
- **内部后台的分组键只按 `command`**：备用地址不该决定内部后台的身份，否则配了 `url` 的
  窗口会去另一个会合目录找内部后台、判定"内部不存在"再起一套。
- **界面**：连接条按钮改为「启动内部 DSH」/「连接内部 DSH」/「连接外部 DSH」/「重启内部 DSH」；
  **连接中只留「停止连接」+「查看日志」**（目标由系统选，写在文案里）；按钮态文案换成两轴
  探测结论（`内部 DSH：未运行 · 外部 DSH：可达`）。命令面板同步改名，并新增
  **DSH: 连接内部 DSH** / **DSH: 连接外部 DSH**。
- **失败分类**：连接类（地址连不上、socket 断）一轮轮重试、**不设自动停止时间**（只由用户
  点「停止连接」结束）；启动类（spawn 失败、dsh 起不来）与认证类（要令牌 / 令牌被拒）
  **不自动重试**，退回按钮态并显示原因——避免命令写错时每 5 秒 spawn 一个必死进程刷爆日志。
- 断言：新增 `scripts/connectTarget.test.ts`（选路六种组合 + 外部三态）；`supervisorPolicy`
  与 `styles` 里的连接条断言按新口径更新；`i18n` 的标记清单删掉两个不再发射的标记。

### 修复：连接停不下来（停止连接 / 换目标 / 停止内部 DSH）（2026-09-19）

用户实测：连着外部 DSH 时把外部服务关掉，界面一直反复自动连接；点「停止连接」停不下来；
甚至点了「启动内部 DSH」也停不下来。三处叠加，都属于"点了没反应"这一类：

- **`DshClient` 自带无限重连**（ws 断开后 1s→2s→…→15s），而「停止连接」只把两个布尔量置假
  加 `cancelWaiting()`，**没有 dispose 客户端** → 它继续重连，且每次 close/connect 都回调状态，
  把界面反复拉回"连接中"；
- **换目标不收旧连接**：点「启动内部 DSH」时上一条（外部）客户端仍然活着，它的回调继续写
  全局状态（回调里没有"这个 client 还是不是当前的"守卫），而且被 `this.client = client`
  覆盖之后再也没人 dispose 它；
- **心跳为外部目标并发建第二个客户端**：客户端自己会重连，心跳又 `ensureConnected` 一轮，
  两个客户端各带一套跟随流，互相打断。

修法：新增 `prepareRound()`（作废在途轮 + `cancelWaiting()` + `teardownStreams()` +
`client.dispose()`），`stopReconnect` / `beginConnect` / `autoConnect` / `reconnectPeer` 统一走它；
`connectOnce` 的状态回调加 `this.client !== client` 守卫，并按轮次号放弃被顶掉的旧轮；
心跳在"外部目标且已有客户端"时交给客户端自己重连。另外命令面板
「DSH: 停止内部 DSH」改为经控制器收掉本窗口的连接（原来只发停止请求，客户端会一直重连）。
回归防线：新增 `scripts/connectionStop.test.ts`（源码结构断言——controller 依赖 `vscode`，
离线起不了实例）与 `scripts/clientDispose.test.ts`（真跑一次客户端：对连不上的地址确实会
自己重连，`dispose()` 之后一次状态变化都没有）。

## 0.8.1（2026-09-18）

这一版是 0.8.0 的即时补发：轮次横条重做后回归，外加 README 里两处不实的说明。

### 右侧轮次横条：点击跳轮 + 悬停预览（对齐官方 Web 端 `TurnNavigator`）（2026-09-18）

- **刻度 = `turnOutline` 投影 ∪ 已加载窗口**，但**已加载的轮次必须被大纲确认**：首个
  `turn/start` 之前由斜杠命令行 / 系统提示词注入拼出来的**幻影轮 `a:0`**（适配器
  `currentTurn ?? 0` 的兜底）由此被挡掉——用户只发一条消息时不再冒出「第 0 轮」。
- **显示判据是「用户消息 ≥ 2 且宽度足够」**：横条占的 40px 由正文列表**让出**（不覆盖
  会话内容）；会话区窄于 360px 时横条与那条预留一起撤掉，空间还给正文。
- **跳转**把目标行落在阅读线下 24px；**窗口外的轮次先取历史再落位**（走 `useAutoScroll`
  / `useHistoryPaging` 的同一条链路），跳转时显式放掉「跟随最新」，胶囊可一键回底。
- 文案中英双语；断言 `scripts/turnRail.test.ts` 与 `styles.test.ts` 的横条一节；预览夹具
  新增 `?rail=one` 边界形态，主故事的轮号改为与真实服务端一致的**从 1 起**。
- 这一版是**重做后回归**：2026-09-14 那版按官方 turn rail 做完后被否掉、整体删除（见 0.7.0
  一节「输入通道、历史加载、轮尾与面板的一批对齐」第四条）；当时**保留**下来的 `turnOutline`
  投影解析这次正好直接用上。

### 文档：删掉 README 里不实的 npx 回退与外链 issue 说法（2026-09-18）

README 里两处说法经核实都不成立，中英两版一并删除：扩展对 `dshChat.command` **原样执行**
（默认 `dsh web --port 0 --no-open`），**没有任何 npx 回退**；被引来佐证「依赖解析卡死」的
官方 discussion `#982` 实际是 npx 缓存缺依赖时报 `ERR_MODULE_NOT_FOUND` 直接退出。

## 0.8.0（2026-09-18）

这一版把 0.7.0 之后用户逐个报上来的问题、与官方 Web 端的对齐工作（含第二轮全项目审计）
全部收了进来；下面按提交时间倒序。

### 待发消息列表消失：队列改由 `inbox` 投影承载，扩展改为双读（2026-09-18）

- **现象**：消息确实进了队列、Web 端看得到、也正常自动发出——**只有扩展会话窗口里没有
  「待发送 N 条」那条列表**，而且什么都不报错。
- **原因**：服务端在 2026-09-09（提交 `72f2e71070`）删掉了 `session/control` 的队列通道
  （baseline 的 `queues` 与 `{type:'queue'}` 帧），队列改由 **`inbox` 投影**承载
  （`{'next-turn':…,'next-step':…}`）。扩展只读旧通道，`scope.queueItems` 于是恒为空、
  输入框上方的状态条恒不渲染。队列数据从来没缺过，缺的是这一层读取。
- **修法：两条通道都读**（旧通道原样保留，跑旧服务端的用户不受影响）——
  `src/dsh/queueView.ts` 拆成 `queueItemsFromInbox` / `queueItemsFromWire`（共用条目级折算：
  文本、附件、本地原始输入优先），`controller.applyProjection` 新增 `case "inbox"`，
  baseline 里先套旧 `queues` 再套投影（两份同值时新通道权威）。
  两条通道各只出现在对应版本上，因此不需要探测服务端版本。
- **回归断言**：两份夹具对拍（同一批消息经两种线格式必须折出同一份视图）、`next-step` 里
  非 user source 的环境上下文必须丢弃、顺序仍是排队在前插话在后（ESC 重发按这个顺序）、
  以及「宿主侧两条通道都接着」的接线断言。

### 会话里的图片看得见了：你发的 / 模型给的 / agent 交付的 / 正文引用的（2026-09-18）

- **你发出的图片**此前只显示一个文件名芯片。现在把 durable 句柄（`sha256:…`）经
  `session/attachment` 换成字节，显示为缩略图；字节还没到、或取不回来时仍退回文件名芯片
  （宁可显示名字，也不显示一个碎图图标）。
- **agent 交付/生成的图片文件**（`present` 申报，或本轮 write 出来的 `.png`/`.jpg`/`.svg`）
  现在画成图。此前它们只有一行文件芯片——实测里 agent 被要求"发一张图"时做的正是
  「下载一张 jpg、写一张 svg、再 present 两者」，而界面上**一张都看不见**；
  这也是本地图片解析现在**含 `svg`** 的原因（附件准入那张表没有它，但浏览器画得出来，
  `<img>` 里的 SVG 也不执行脚本）。
- **正文里引用的图片**分两路：会话工作目录内的本地路径（`![](./out/chart.png)`、`file:///…`、
  `C:/…`）由扩展读成 data URL——**只在工作目录内、只认图片扩展名、单张 8 MB 上限、
  单次最多 24 张**；`https://` 外链按原样渲染，带 `referrerpolicy="no-referrer"` 与
  `loading="lazy"`，明文 `http:` 不放行。读不到的图显示「图片加载失败」。
- **工具结果里的图片**（`read_image`、截图这类调用回带的 image 块）此前渲染在工具行的
  展开体里，而展开体默认收起——图确实在，但要点开那一行才看得见。现在图库挪到工具行的
  **下方**，折叠态直接可见（点开仍是原图）。这是实测「agent 用 image 内容块发图」时发现的：
  日志里 `tool/result` 的块类型一直是 `["text","image"]`、句柄完整，数据侧从来是通的，
  缺的就是这层可见性。
- **点击看原图**：四种来源（你的、模型的、agent 交付的、正文里的）共用一个浮层，
  `Esc` 关闭——且不会顺带把正在生成的这一轮中止。
- 都走同一个 `ImageGallery` 组件，缩略图尺寸与失败降级完全一致（此前用户消息、
  助手图片块、工具结果各自画一套）；取字节有并发闸门，打开塞满图片的历史会话不会雪崩。
- **本地图片解析失败不再静默**：宿主把「基准目录 + 哪几张没解析出来」写进输出通道，
  界面上的「图片加载失败」也带上原始路径（悬停可见）。此前这类故障只表现为一句
  「加载失败」、日志里什么都没有——排查只能靠猜（2026-09-18 那次就多花了两轮）。
- 拿不到会话 cwd 时（窗口刚起来、会话还没进 `session/list`）退回**当前工作区路径**再解析：
  白名单边界没有放宽（仍是用户明确打开的目录），但避开了「竞态导致图全失败、且失败结果
  被界面永久缓存、重载前不再重试」这种全有全无的失败。
- 子代理转录面板里的图片仍不显示（那条路没有网络客户端，拿不到字节）。

### 文档与打包：演示图改 GitHub raw 外链、仓库地址修正、配置说明收短（2026-09-18 / 09-15）

- **演示图改名 `docs/demo.png`**（ASCII 名避开 URL 编码坑），README 里保持相对路径，由 vsce
  按 `repository.url` 自动改写成 raw 绝对 URL；`.vscodeignore` 白名单让图**随包内置**兜底
  （仓库须公开且图已推送，详情页才显示得出来）。
- `repository.url` 从不存在的 `NEXTINDIE/dsh-chat` 修正为真实远端 `Lin515/dsh-chat-vscode`。
- 打包脚本加 `--no-gitHubIssueLinking`：README 引的 `#982` 是**官方 dsh 仓库**的 discussion，
  防止被改写成这个仓库的 issue 链接。
- `command` / `url` / `autoStart` / `supervisorIdleSec` / `turnProcessThreshold` 的配置项说明按
  新口径**收短**（见 AGENTS.md 新增的硬性检查项：只写作用与特殊值效果，不写原理，也不写
  「用户级设置；改完需重载窗口」这类套话与设置页并不渲染的 `**` 加粗）。

### 多行草稿打字时会话页闪烁：自适应量高的瞬态在同帧内消化（2026-09-17，用户报的）

**现场**：草稿超过一行时每敲一个字，会话页底部的滚动位置就抖一下（实测贴底时 `scrollTop`
在 1021 ↔ 1000 之间来回）。

**根因**：Composer 的自适应 effect 先把 `textarea` 塌回 `auto` 再量 `scrollHeight`；塌回的那
一瞬输入区矮一行、`.chat-scroll` 的可视端口变高，浏览器立刻把 `scrollTop` 夹小，量完复原端口
后 `scrollTop` **不会自己弹回**，要等下一帧 rAF 才钉底——每敲一个字就落进「底部缺一条 → 钉回」
的一帧振荡。只在 >1 行时出现。

**修法**：量高前先记下贴底距离与 `scrollTop`（瞬态基线），量完仍在**同一个 effect、绘制之前**
把被夹走的 `scrollTop` 补回去；原本贴底而端口变矮时直接钉底（贴底 ≤1px 的意愿必为跟随，与
`onScroll` 的裁定同源）。补回**不推迟**到 rAF / 定时器。App 把会话滚动区的 ref 传给 Composer
以拿到那个容器。回归断言钉在 `scripts/styles.test.ts` 第 38 组。

### 过程折叠阈值改为配置项 `dshChat.turnProcessThreshold`（2026-09-17）

- 连续过程折叠的阈值（默认 5，保持原行为）现在可配：`0` = **永不折叠**；`1–2` = **永远折叠**
  （只有 1 次工具调用的段照旧平铺，生效值钉在 2）；`≥3` 按值生效。
- 语义**单一来源**是 `src/shared/turnProcessThreshold.ts`：宿主归一化后下发，界面
  `foldTurnProcess` 消费；改配置走 `refreshAppearance`，即时生效、不必重载窗口。
- 断言见 `scripts/turnProcess.test.ts` 新增三节（归一化与生效值、阈值驱动折叠、`package.json`
  对拍），`scripts/renderOrderProbe.ts` 同步改用新常量名。

### 全项目审计：安全加固、BUG 修复、死代码清理 + 用户手册重写（2026-09-17）

这轮不对比官方，而是对**本仓库自己**做了一次全量审计（宿主安全 / 会话管线 / webview
三路并行），逐条修复并在断言里留了落点。完整清单与取舍见
`docs/audit-summary.md` 的「七、第二轮全项目审计」。

**安全**（每条都有回归断言）：

- `dshChat.command` / `dshChat.url` 改为 **`machine` 作用域**：`command` 经 shell 原样
  执行、`url` 决定凭据发往哪个 origin，而它们此前可被**工作区**（克隆来的仓库里的
  `.vscode/settings.json`）覆盖——在已信任的工作区里等于一行配置换一次任意命令执行。
  ⚠️ 如果你此前把这两项写在**工作区设置**里，升级后它们会被忽略（VS Code 会在设置页
  标出来），请改到**用户设置**。
- 删除会话前先验证会话 id 是**纯目录名**，并对拼出的路径做 `resolve()` 包含性检查
  （服务端给的 id 以前能直接 `..\..\` 出去，而下一步是 `rmSync(recursive)`）。
- `killServer` 的端口兜底先验身份（`looksLikeDsh`）：端口是上一次公告里的临时端口，
  可能已被无关程序接管，`taskkill /T /F` 一棵无关进程树是不可逆的事故。
- 会合文件（含启动令牌）按 `0o700`/`0o600` 落盘；socket 推来的状态逐字段验形状；
  日志尾巴里的 `?token=` 一律隐去；行缓冲加 1 MiB 上限；`control:restart` 合并并发调用
  （同时重启会 spawn 两个 dsh，前一个的 pid 再也找不回来）；dispose 后不再被在途心跳复活。
- CSP nonce 改 `randomBytes`；webview 帧处理加 try/catch；宿主侧补拖放字节上限；
  图片内联改用服务端 `imageLimits.maxImageBytes`（缺省 64 MB 硬上限），超限改按文件上传
  并提示（新标记 `@imageTooLarge`）。

**BUG**：`historyLoading` 缺在快照里导致切会话后「加载更早」永久卡死；`cordis_*` 工具行
显示裸 id（4 个 `TOOL_TITLE_KEYS` 目标键在词典里不存在）；`tool/result` 找不到调用记录时
被静默丢弃（那一行永远停在「运行中」）；提示条因计时器依赖不稳定而永不消失；目标条与
问卷里的 `Esc` 会连带中止正在跑的这一轮；`eventSessions` 只增不删；子代理面板跨会话不刷新
且把「未知状态」画成「未运行」；工具展开区多个元素共用同一个 `ref`；轨迹的「输出」行画的是
时长、「Diff」页签硬编码英文、平移监听卸载不摘、空数组使 `useMemo` 失效；输出通道会变成两份；
一轮结束后无条件抢焦点。

**死代码**：`src/dsh/textFile.ts` 整份模块（含测试与 esbuild 条目）、`bridge` 的
持久化包装、4 个自绘设置页残留图标、`awaitFirstState` / `socketNodeExists` /
`createExclusive` / `waitForSocket` / `TrajectorySpan` / `readSessionLogRows` 等未用导出、
4 条死 IPC 帧与处理器、46 个死词典键、7 个死 CSS 变量、2 条"有词典没发射点"的死文案标记。
`scripts/i18n.test.ts` 新增**反方向**断言（登记过的标记必须有真实发射点），这类死文案不会再攒。

**文档**：`README.md` 重写为面向用户的精简手册（前置条件明确写出"必须先装 dsh"并给出官方
地址；`url` 留空 = 自管理内部 DSH、填了 = 只连外部，以及多窗口共用同一后端的关键口径；
界面自绘、与 Web UI 对齐一句话带过），并入演示截图；不再用 Continue 作类比——
`docs/continue-ui-spec.md`（1128 行的"复刻规格"）整份删除，许可归属说明保留在
`THIRD-PARTY-NOTICES.md`。`AGENTS.md` 补「安全口径」一节并修正构建姿势描述。

### 复制按钮归属收敛：成功不弹信息条、工具串不给复制、生成中不画操作行（2026-09-17，用户口径）

- **复制成功不再弹「已复制」信息条**：宿主不再发 `@copied`（`resolveMarker` 的 case 与
  `scripts/i18n.test.ts` 的登记一并删掉），改由按钮自己换 1s 文案作反馈——复制成功从界面上
  就能感知，信息条反而是打扰。
- **「工具串」不给复制**：整轮只有连续工具调用、**一段正文都没有**时，轮尾不画复制按钮；
  单张工具卡展开的内容仍有各自的复制按钮。
- **网页搜索卡补上复制按钮**，放在内容右上角；复制内容 = 答案 + 编号来源（标题 + 链接），
  摘要片段与发布时间是展示细节、不进剪贴板。
- **生成过程中整条轮尾操作行都不画**（`streaming === false` 才出现）：流式期间时间在跳、
  分支不可点、复制的内容也没定稿，右下角那一排是噪音。
- 断言在 `scripts/styles.test.ts` 新增的「复制按钮归属」一组（工具卡 4 处复制按钮、轮尾复制
  必须包在 `fullText !== ""` 里、操作行必须包在 `!message.streaming` 里）。

### 扩展运行时数据根迁入 `~/.dsh/dsh-chat-vscode`（2026-09-17）

- 默认会合根改为 `$DSH_HOME/dsh-chat-vscode/supervisors`（复用 `dshHome()`，跟随 `DSH_HOME`
  覆盖），不再占用 `~/.dsh-chat`；断言、各处路径注释与 `docs/design-supervisor.md` 同步。
- **升级注意**：旧的 `~/.dsh-chat/supervisors` 不再被读取——升级后第一次启动会在新目录下另起
  一套会合；老目录里的残留（会合文件、MB 级日志）可以手动删，旧守护进程在没人连之后按空闲
  阈值自己退场。
- README 中英两节改写为 supervisor 守护口径：旧的「残留进程检测」（会合租约 + 扫描）机制已
  随 supervisor 架构删除，说明不该再留着。

### 贴底自动滚动失效：意愿只由手势决定，并补「回到最新」胶囊（2026-09-17，用户报的）

**现场**：正常贴着底生成着，会**突然不再贴底**——最新内容留在视野下方、胶囊亮着、没有任何
面板 / 排队条变化，而且**一直不恢复**，要手动滚或点胶囊。用户直觉「判定与实际底部错位」
是对的。

**根因**（Playwright 对预览夹具实测确认，两条都出自同一件事——**从滚动几何推断用户意愿**）：

1. `scroll` 事件是**异步**派发的：处理器当场读的 `scrollTop` 可能来自**已经过去的布局**
   （位置被浏览器夹过），而 `scrollHeight` 来自**当前布局**。旧实现用「`scrollTop` 变小 ⇒
   用户上滑了」翻贴底标志，于是生成期间任何一次「瞬态塌缩 → 恢复」的重渲染（过程折叠、
   中途插消息搬 DOM、消息整体替换…）都被误判成用户上滑；而 `stick=false` 之后**没有任何
   机制会翻回来**。
2. 贴底判定只由「内容长高」触发：端口变矮（插话排队条 / 提示条 / 待办面板 / 变高的输入框）
   时 `scrollTop` 不变、连 `scroll` 事件都没有；展开豁免又把 500ms 内的整批增长吞掉，
   窗口过后也不补判定。

**修法**（机制收敛为两条）：

- **意愿只由输入决定**：置假必须「近 400ms 内**有滚动手势**（滚轮上滑 / 触摸 /
  `PageUp`·`Home`·`ArrowUp` / 拖滚动条）**且**确实离底」，两者同时成立；没有手势的离底一律
  按布局事故处理（不脱贴，继续钉底自愈）。置真：位置回到容差内、发消息 / 插话、切会话、
  点胶囊。
- **想跟就把视口幂等钉到底**：宿主帧到达、内容 RO、端口 RO、可见性 / 焦点变化都只置一个脏
  标记，rAF 里合并成一次判定。没有「之前是否在底部」的记忆值，因此不存在「某次判定被跳过
  之后永久停在错误一侧」。
- 删除：`stickRef` 几何推断、500ms 展开豁免与 `aria-expanded` 点击捕获、划选豁免。
- 新增**「回到最新」胶囊**（中英双语）：脱贴且距底超阈值时出现，点击回底并重新贴上；锚在
  只包滚动区的 `.chat-pane` 上，不叠待办面板。

**证据**：新增 `test/scroll-probe.html`（9 个场景、自驱动、无依赖）——改前 4 红（位置被夹 /
端口变矮 / 贴底展开 / 面板隐藏再显示），改后全绿；`scripts/styles.test.ts` 第 37 组按新口径
重写（含「不许再有 `stickRef` / 展开豁免」的负断言）。`npm run typecheck` / `npm test`
（53 套）/ `npm run build` 全绿。

> 这一版把 2026-09-16「展开工具调用不再把内容『向上挤』」里的**展开识别**整套换掉了——那版
> 靠捕获点击 + 500ms 豁免，仍是从几何与时序猜意愿；上面这两条是现行口径。

### 渲染 `exit_plan_mode` 请求（计划审阅卡）（2026-09-17）

**现场**：计划模式里模型把整份计划交上来请人放行（`exit_plan_mode`），界面上只有一句
英文问句「Approve this plan and leave plan mode?」和两个按钮——**计划正文一个字都看不到**，
也没法把这张卡与普通问卷区分开。

**根因**：确认走的是**普通提问**那条线（`user-questions/request`），而宿主
`deliverEventToScope` 按 `id/header/question/options/multiSelect` 白名单重建题目对象，
把两个关键字段整个丢掉了：`detail`（计划正文）与 `intent`（`kind: "plan-review"`）。
界面既没有正文可画，也没有标记可判。

**修法**（语义全部对官方 `dsh-client-ui-user-questions` + `dsh-plan-mode`）：

- **契约**：`QuestionItemView` 补 `detail` / `intent`；`ipc.ts` 补 `cancelQuestion`。
- **宿主**：两个字段原样透传；新增 `cancelQuestion` → `rejected` +
  `UserQuestionError`/`ASK_CANCELLED`（网关 `parseRemoteEventRejection` 逐键校验，
  形状不能自创）。用户撤回**也是一次结算**：`heldEvents` 一并删掉，否则切走再切回来
  会凭空弹一张过期的审阅卡。
- **界面**：`webview/planReview.ts` 逐字移植官方 `planReviewOf` 的收窄规则——恰好一题、
  `intent.kind = "plan-review"`、`detail` 存在、非多选、选项 ≤ 2、批准 label 逐字存在；
  任一条不成立就退回通用问卷流程（意图只换布局，不改可达的答案）。
  `pendingInteractionOf` 按官方注册优先级认它（plan-review 2 > 普通提问 1 > 审批 0）。
  `Composer` 渲染 `PlanReviewCard`（warn 条带 + 内滚计划正文 + 底部决定行），
  并给外层容器挂 `is-plan-review` 让限高只有一处（否则决定按钮会被外层滚走）。
  `QuestionCard` 顺带补上 `detail` 渲染（对所有问卷生效，此前这个字段被整个丢掉）。
- **两条容易读反的口径**：按钮上显示**界面语言**、提交的是**提问方自己的 label**
  （`dsh-plan-mode` 那边是逐字严格比较，把「确认执行」发回去只会被读成「继续规划」）；
  「去聊天里说」是**撤回**（`ASK_CANCELLED`）而不是一份空答案。

**证据**（Playwright 驱动 `test/preview.html`，真实浏览器 + 真 DOMPurify）：

- 记录卡展开：整份计划按 markdown 渲染（`h1`/`h2`/有序列表 + `CodeBlock` 代码卡），
  选项高亮落在 `Approve`。
- 待处理卡（`__planReview()`）：卡片 `max-height: 520px`、正文内滚
  （`scrollHeight 653 > clientHeight 445`）、外层 `max-height: none` / `overflow: visible`
  （单层滚动），底部决定行仍在视口内。
- 三个动作发出的帧逐字核对：`确认执行` → `{answerQuestion, answers:[{id:"plan-review",
  selected:["Approve"]}]}`（**不带 custom**）、`拒绝` → `["Keep planning"]`、
  `去聊天里说` → `{cancelQuestion, requestId}`。
- 双语版面：英文 420px / 300px 不溢出，240px 时决定行折到第二行且不裁。

验证：`npm run typecheck` ✓；`npm test` 54/54 套 ✓；`npm run build` ✓ 且无 esbuild 警告。
新增断言 `scripts/planReview.test.ts`（收窄规则 + 答案形状 + 两端接线）；`pendingInteraction`、
`styles`（第 19 组）、`interactionSync`（结算点 3 → 4）、`previewFixture` 同步更新。

### 拖放文件：整页接取，不再被 VS Code「打开文件」抢走（2026-09-16，用户报的）

**现场**：把文件拖进会话页面，总被 VS Code 捕获为「打开文件」，而不是被会话识别为
附件上传。

**根因**（两层叠加）：

1. **平台门（改不掉，要按 Shift）**：webview 是 iframe，VS Code 在**主窗口 DOM** 上
   监听 drag/dragover，没按 `Shift` 就给 iframe 挂 `pointer-events: none`
   （`workbench.desktop.main.js` 的 `windowDidDragStart`），事件根本到不了界面；
   按住 `Shift` 才放行。监听在主窗口上，所以**从系统资源管理器拖同样会中招**——
   只要拖拽路径扫过任何 workbench 界面（标题栏 / 活动栏 / 视图头，甚至被阻塞的
   iframe 本身），阻塞就激活并持续到 dragend。旧文档写的「系统资源管理器拖不受此限」
   只在路径全程不碰这些界面时才成立。
2. **接取面太小（本轮修的）**：此前只有输入框接 drop，拖到消息区（页面的大头）没有
   任何 drop 目标，浏览器走默认行为——导航到被拖的文件，被 VS Code 拦下变成「打开」。
   Playwright 合成拖拽实测（改前）：拖到消息区 `dragover.defaultPrevented === false`、
   `attachBytes` 发出 0 条。

**修法**：拖放逻辑迁到 `src/webview/dropAttach.ts`，App 挂 window 级
dragenter/dragover/dragleave/drop 监听（`usePageFileDrop`）：**整页**都是投放目标，
任何位置松手都进附件；dragover 的 `preventDefault` 是「本页接受投放」的声明，缺了它
必被 VS Code 捕获。只拦文件拖拽（`dataTransfer.types` 含 `Files`），文本拖拽不再被
劫持（textarea 的原生插入恢复）。拖拽期间整页亮出「松开即添加」浮层；输入框自己的
drop 处理移除——两处都接会双发 `attachBytes`（同一份文件出两条附件）。

**证据**（Playwright 驱动 `test/preview.html`，合成 DragEvent + 真实 DataTransfer）：
改后拖到消息区 `dragover`/`drop` 均 preventDefault、overlay 显隐正确、`attachBytes`
恰好 1 条；拖到输入框同样恰好 1 条（无双发）。

### 展开工具调用不再把内容「向上挤」（2026-09-16，用户报的）

**现场**：会话滚动条在最底部时，展开工具调用（或任何节点）会让内容向上挤——刚展开的
那一块被顶到视野上方，而不是在点击处往下长出来。

**根因**（两条机制在做同一件坏事，都是「保持可见内容不动」）：

1. **浏览器滚动锚定**（`overflow-anchor: auto`，Chrome 默认）：往视口上方插内容时它自动
   加大 `scrollTop`。实测（Playwright 驱动预览页）：贴底展开 5 行工具 → `scrollTop` +120、
   按钮上移 120px；视口在中间时往上插 200px，`scrollTop` 也自动 +200——**与贴不贴底
   无关**。顺带发现 `useHistoryPaging` 的注释写着「浏览器保持 scrollTop 不变」，这个假设
   不成立：顶部插内容时浏览器已经加过一次，代码再按高度差补一次就是双份。
2. `useAutoScroll` 的贴底跟随：`ResizeObserver` 看到**任何**高度变化都
   `scrollTop = scrollHeight`，于是「用户展开」与「新内容到达」被当成同一件事。

**修法**：

- `.chat-scroll` 加 `overflow-anchor: none`：跟随由 `useAutoScroll` 自己管，不需要浏览器
  再插手；`useHistoryPaging` 的补偿也回到它写明的那个假设上。
- 跟随把「展开」识别出来（用户 2026-09-16 口径：**展开是用户操作，他此刻就是要看内容**）：
  在 `.chat-scroll` 上用**捕获**阶段听点击，点到某个**当前还没展开**的 `[aria-expanded]`
  控件（工具行 / 思考行 / 折叠按钮 / 注入行 / 问卷卡…全是它）→ 那一次高度变化**不跟随**
  （免得刚展开的那块被顶到视野上方）**并且取消贴底**——此后生成中的新输出停在他的视野
  之外，不再强行拽回底部；滚回底部即恢复跟随。**收起**（点的是已展开的控件）、复制 /
  分支 / 划选这些不改高度的点击都不影响跟随；**没人点东西时**跟随路径一行都没变。

**证据**（Playwright 驱动 `test/preview.html`；无头 Chromium 里原生 `ResizeObserver` 不投递
回调、rAF 又被节流到 ~1fps，所以用**变异驱动**的 RO 垫片激活 JS 跟随、并给程序化滚动留足
滚动事件的投递时间）：

- 浏览器锚定（关掉 JS 跟随）：向上插 200px → 改前 `scrollTop` +200，改后 **0**
  （`getComputedStyle` 确认 `overflow-anchor: none`）。
- 展开那一下：把 `EXPAND_READ_GRACE_MS` 临时改 `0`（= 关掉识别）→ 展开折叠按钮
  `scrollTop` +120、按钮上移 120px（红）；改回 500 → `scrollTop` 不动、按钮不动（绿）。
- **正常生成的下滚没被动过**（用户口径里的硬要求）：无点击时连续 4 次新输出，距底
  **0 / 0 / 0 / 0 px**（每次都贴着最新输出）。
- **展开后不再强行贴底**：展开折叠按钮后视口不动（距底 884px），继续生成 3 次 →
  距底 984 / 1034 / 1084 px（只增加新内容的量，**没有被拽回底部**）；手动滚回底部后
  再生成 3 次 → 0 / 0 / 0 px（跟随恢复）。对照组：贴底时点一个**已展开**的控件（= 收起）
  后再生成 → 0 / 0 / 0 px（跟随照常）。
- 断言：`scripts/styles.test.ts` 第 37 组钉住「关锚定」「只认展开态点击」「展开即取消
  贴底」「跟随本体与 `stickRef` 只有两个写 false 的入口」。

验证：`npm run typecheck` ✓；`npm test` 53/53 套 ✓；`npm run build` ✓ 且无 esbuild 警告。

> **本节已被取代（2026-09-17）**：这里描述的「捕获 `aria-expanded` 点击 + 500ms 展开豁免 +
> `stickRef` 几何推断」整套判据在同一天被换掉——现在**意愿只由滚动手势决定**、跟随时把视口
> **幂等钉到底**（`overflow-anchor: none` 保留）。现场与证据留在本节只作历史，现行口径见 0.8.0
> 一节的「贴底自动滚动失效」。

### 轨迹打开就占用整个会话窗口（输入区让位，但不丢问卷）（2026-09-16，用户口径）

**现场**：上一轮把轨迹从「整页」改成「整页 + 底部留输入区」是**读反了**用户的意思。
用户 2026-09-16 明确：轨迹页面打开就应当**占用整个会话窗口**；切回会话时问卷要照常
显示出来；有问卷时点轨迹也要是占满整窗的轨迹页——而不是问卷一直占着会话底部空间。

**修法**：轨迹视图下给 `.app` 加 `is-trajectory`，`.composer` 用
**「绝对定位（移出文档流）+ `visibility: hidden` + `pointer-events: none`」**让位，
轨迹视图因此拿到 header 以下的全部高度。

为什么**不是** `display: none` / 不卸载组件（这条是硬约束，写进了 `styles.test.ts`）：
待答问卷里**填了一半的选择**（选项 / 自定义文本 / 展开态）是 `QuestionCard` 的本地
state——卸载就丢，`display: none` 还会跳过布局（输入框的自增高会算成 0 高）。
绝对定位只把它移出文档流：宽度仍与面板一致（工具栏宽度测量照常有效）、隐藏元素不进
无障碍树与 Tab 序列、`pointer-events: none` 让它不挡轨迹区的点击。

**证据**：预览实测（420×900，带一张待答问卷）——点轨迹后 `trajectory-view` 从 349px
变成 **866px**（header 以下全部），账本 771px；在输入区原来的位置上
`document.elementFromPoint` 命中的是 `trajectory-ledger`（不是隐藏的输入区）；
切回会话后问卷仍在，**切换前选中的那个选项原样保留**（`只改入口文件…`），输入框高度
32px 没有被压成 0。`scripts/styles.test.ts` 第 16d 组钉住这套写法（含「不许用
display: none」）。

### 节点展开后默认停在顶部（2026-09-16，用户报的）

**现场**：「各类节点打开后，如果有垂直滚动条，默认应当居于最顶部」。

**根因**：`useStickyBody` 展开时无条件 `scrollTop = scrollHeight`（贴底）——那套语义
本来是给**流式**内容写的（思考逐 token 增长，跟着最新一行走），但它被工具行、注入行、
命令行的 body 一起共用，于是打开一张长 diff、一段长输出时停在**末尾**，得自己往上翻。

**修法**：展开时先 `scrollTop = 0`；**只有还在增长（`streaming`）且盒子还装得下**
（`scrollHeight - clientHeight < 40`，此时本来没有滚动条）才跟随最新，装不下就不抢用户的
滚动位置——用户自己滑到底部即恢复跟随（与主对话区同一套贴底判定）。静态内容
（工具 / 注入 / 命令）干脆不注册观察者，后续更新也不会再动滚动位置。四个可展开节点里
只有**思考行**传 `streaming`。

**证据**：`scripts/styles.test.ts` 第 16c 组（展开先回顶部、旧的无条件跟随不能回来、
只有思考行传 `streaming`）；预览实测（夹具里的终端卡输出补到 40 行，展开后 body
`320/832` **确有滚动条**，`scrollTop = 0`——旧行为会停在 512）。

### 写入节点固化单栏；命令行节点不再有两层滚动条（2026-09-16，用户报的）

**现场**：①「如果是写入节点，固化为单栏，因为是写入节点必定是新建文件吧？双栏没有
意义」；②「命令行节点怎么会出现两层垂直滚动条？」

**根因**：① 双栏由「容器够宽 + `diffLayout` 设置」决定，而 `write` 是整篇新建——
实测 831px 宽的面板里写入节点的 8 个格子里 **4 个是空的**（左栏整列空白）；
② 外层 `.row-body` 本来就有 `max-height: 320px; overflow: auto`（所有工具行共用的
滚动区），而昨天给终端卡又加了 `.tool-card-body { max-height: 420px; overflow-y: auto }`
——80 行输出下**两个可滚动容器嵌套**，用户看到的就是两条竖滚动条。

**修法**：① 判据抽成 `shared/diff.splitDiffEnabled`（纯函数、带断言）：写入节点一律
单栏，**整段没有任何删除行**的差异同样单栏（`write` 的新建预览、结果 meta 里
`oldText: null` 的 hunk 都是这个形状），其余仍按设置与宽度走 `auto`；`Rows.tsx` 对
`classifyTool(name) === "write"` 传 `unified`。② 删掉终端卡自己的限高/滚动，只留外层
`.row-body` 那一层（官方在会话行里也把 `TerminalBlock` 的 `maxLines` 设成 `Infinity`）。

**证据**：`scripts/diff.test.ts` 第 16 组（7 条，含「显式 `split` 设置也不覆盖写入
节点」）；`scripts/styles.test.ts` 第 16b 组（`.tool-card-body` 不许自己限高/滚动）。
预览实测（900px 宽、`auto` 模式）：编辑节点仍双栏（1 个空位=正常配对），写入节点
**单栏、0 个空位**；终端卡注入 80 行输出后**可滚动容器只有 1 个**
（`.row-body card-body`，320/1599），修复前是 2 个嵌套。

### 工具行对齐 Web 端：展开区给「卡片」，不再摊开完整参数（2026-09-16，用户报的）

**现场**：「会话页面的工具调用内容渲染还是和 Web 端有所不同，工具不需要显示出 agent
的完整具体输入内容，重在可读性和渲染输出内容……读取、搜索等工具和 Web 端不一致」。

**根因**：官方的工具行有一层**按工具语义折好的卡**（`dsh-client-ui-tool` 的
`models/` 下各 `card-model` + `ToolRow` 的 card 槽），而本扩展对**所有**非 diff 工具
一律渲染「IN（缩进后的参数 JSON）+ OUT（原始结果正文）」两段。后果有两个：
① 参数 JSON 白占一大块（读取工具把 `{"file_path":"…","offset":3201,"limit":20}` 摊开）；
② 结果正文是**模型侧信封**——读取给的是 `<path>…</path><type>file</type><content>` +
`3201: …` 的编号行，搜索给的是带 `include` 回显的纯文本，都不如官方那张卡可读。

**修法**（数据在宿主侧折好，界面只负责画；判据与官方逐条对照见
`src/shared/toolCard.ts` 的文件头）：

| 工具 | Web 端（官方 card） | 本扩展现在 |
|---|---|---|
| `read` | `ReadBlock`：路径 + `显示 X / Y 行` + 语言 + 复制，正文是**行号槽 + 内容** | ✅ 同（行号取 `meta.lines` 的权威行号） |
| `grep` / `glob` | `SearchBlock`：`N 处匹配 · M 个文件` / `N 个路径`（截断时 `显示 X / 共 Y`），命中按文件分组（文件头带条数、可折叠） | ✅ 同（含截断时的 recovery 说明与「无结果」空态） |
| `bash` / `pwsh` | `TerminalBlock`：状态 + `$ cwd` + 命令 + 退出码胶囊 + 输出；**没有 description 的调用按持久 shell 走通用 IN/OUT** | ✅ 同 |
| `web_search` / `web_fetch` | `WebBlock`：答案（markdown）+ 来源列表 / URL + `HTTP N` | ✅ 同 |
| `run_code` | `CodeBlock` + OUT（`cardBody = null`：只省掉 IN 段） | ✅ 同 |
| `todo_write` | `TodoRow`：标题「更新任务清单」+ `N/M 已完成 · 正在做 X` + 右侧 `+K` | ✅ 同（正文仍是 IN/OUT，与官方一致） |
| `edit` / `write` | `DiffBlock`（一直是对的） | ✅ 不变 |
| `read_image` | 图片卡：标签 + 图库 + 信封一行 | ⚠️ 保持本扩展的图库 + OUT（信封那行是给模型看的，界面上是噪音） |
| 其余（`subagent`、`present`、MCP 工具、未知工具…） | `GenericToolCard`：IN/OUT | ✅ 不变（`subagent` / `present` 另有专属呈现，见下） |

顺带对齐的两处**摘要**口径（官方 `deriveSummary`）：`web_search` 的参数是
`queries[]` **数组**，此前这里什么都取不到（搜索行只有标题没有内容），现在按官方的
「数组拼接」处理；未知工具的兜底从「一小撮精选字段」补齐为官方的两级
（参数里第一个非空字符串 → 原始参数首行）。宿主侧**不再自己截断**摘要（旧实现把
bash 摘要砍到 72 字符），省略一律交给界面按宽度做。

**证据**：新增 `scripts/toolCard.test.ts`（8 组，夹具形状来自本机 265 份真实会话日志
里扫出来的 `tool/result.meta`：`read` 的 `{path,offset,lines:[{number,text}],totalLines}`、
`grep` 的 `{shape:"matches",files:[{path,matches:[{lineNumber,line}]}]}` 等）；
`scripts/styles.test.ts` 第 15 组改钉「有卡片/代码卡时 IN/OUT 的渲染条件」；
`scripts/toolView.test.ts` 的摘要断言按官方口径更新。**真实数据回放**：把本机 40 份
真实会话日志（6242 次工具调用）灌进适配器，3861 次折出了卡片，五种都有
（terminal / search / read / web_search / web_fetch），样本与 `meta` 形状逐条核对过。
预览实测（`npm run preview`，夹具里补了 6 条真实形态的卡片）：读取卡 6 行不截断、
只读一段的那张显示 `显示 20 / 4610 行` 且中间给「… 其余 12 行」（点开铺满 20 行）、
搜索卡 `4 处匹配 · 3 个文件` 带 3 个文件头、网页卡答案 + 2 条来源、终端卡
`已完成 / $ dsh-chat / git status --short / 2 行输出`、`run_code` 是代码块 + OUT；
未给卡片的行（运行中、出错、无 description 的 pwsh）仍走 IN/OUT。

**与官方刻意不同的两处**（都写进了 `toolCard.ts` 的文件头）：① 卡片标签里的路径
**不做「相对会话 cwd 缩短」**，沿用本扩展「标题给完整路径、界面按宽度省略前段」的
既有口径（`webview/pathDisplay.ts`）；② `read` 卡不校验结果正文的信封格式（官方要求
严格匹配 `<path>…</path><type>file</type>`），因为本扩展的 `output` 已经过
`parseToolResult` 剥壳，meta 合法就足以保证卡片正确。

### 问卷真的不会再丢了；问卷在的时候轨迹页也不会被压扁（2026-09-16，用户报的）

**现场**：

1. 「从其它会话回到这个会话的时候，会看不到问卷，agent 一直卡在问卷步骤」——
   2026-09-15 那轮修完仍然复现，VSCode 窗口重载同样丢。
2. 「问卷出来时如果再去点击轨迹按钮，轨迹页面会显示不正常」。

**根因**（两个独立缺陷）：

1. **卡片被重折吃掉**。审批 / 提问**不是 durable 事件**（会话日志里没有），
   上一轮的修法是把「还没结算」的请求留在宿主 `heldEvents` 里、在有窗口绑上这个
   会话时回放——但回放是**紧跟 `ensureScope` 同步执行**的，而新开的跟随流那份
   `snapshot` 要等一个网络往返才到；快照一到就走 `reset()` + `refold()`，把消息流
   整体重折成 durable 事件的产物，**刚补回来的卡片正好被折掉**。窗口重载走的是
   同一条路（重连 → 服务端重投递 waterfall → 卡片显示 → 快照折掉），所以上一轮
   的修复看起来「没生效」。
2. **问卷卡把上面那半屏挤没了**。`.composer` 是 `flex: 0 0 auto`，一张多题问卷能
   长到 1500+px。900px 高的面板里实测（6 题全展开的最坏情形，`questionBatch=0`）：
   问卷卡 1538px、`.composer` 整块 1695px —— **轨迹视图被压成 0px**，输入框跑到
   可视区外（top 1603 / 面板高 900，`.app` 自己又不滚动，够不着），也就是
   「问卷出来时别的功能都不能用了」。

**修法**：

- `SessionAdapter` 把非 durable 的交互卡**单独留一份**（`interactionCards`：卡片副本 +
  它当初落在哪条助手消息上），`refold()` 折完 durable 事件后按锚点补回去——锚点不在
  重折结果里时，**还在等答复的卡**改挂当前回合（那是一张必须被看见的卡），已收场的
  记录只在锚点还在时按原位补（挂错轮次比少一条记录更容易误导）。收场（答复 / 撤回）
  会刷新副本，所以补回来的是**记录**而不是一张又能编辑的卡。
- 顺带把去重口径从「当前回合那条消息」改成**跨消息**（`findInteractionCard`）：请求
  重投时那个回合往往已经结束，`ensureAssistantMessage` 给出的是新回合的消息，只在
  那一条里找就会画出第二张卡，而第一张永远没人点。
- `.composer-interaction` 限高 `min(50vh, 360px)` + 内部滚动：卡片自己滚，会话 /
  轨迹 / 输入区都照常可用（输入区本来就在卡片下方，不参与这次压缩）。

**证据**：`scripts/interactionSync.test.ts` 新增两组——9c「重折（快照/重连/重载）后
待答卡片仍在」（把 `restoreInteractionCards()` 临时注释掉时这一组会红，已实测）与
9d「跨消息的重投递去重」；`scripts/styles.test.ts` 第 17 组钉住限高与内滚。
预览实测（`npm run preview`，420×900）：夹具那张待答问卷下会话区 107 → 274px、
轨迹视图 182 → 349px、账本 87 → 254px；6 题全展开时（去掉限高即为修复前）轨迹
0px / 输入框被顶出可视区，限高后轨迹 349px、卡片内部可滚到底（360/1538）、
输入框 774–891 正常可见。轨迹页上选项可点、提交照常发出 `answerQuestion`，
边等问卷边打字发送也不受影响。

### 轮级过程折叠改成「只折机器噪声」（2026-09-16，用户报的）

**现场**：一个被上游 520 打断的长轮（454 步 / 531 次工具调用）里，**135 行工具**
平铺在折叠按钮外面；同时用户担心「中间的长消息被折进去、容易被忽略」。

**根因**（一条规则的两个副作用）：折叠边界取「**最后一个产出正文的 step**」，只折
边界**之前**的段，于是 ①边界之后的过程没有回收路径——那一轮的正文停在 step 334，
之后还有 119 步工具循环才撞上 520，全留在外面；②边界之前的**中间正文**被当成过程
成员折掉（官方也是这样：`processSpec` 的 `messageCount` 数它们，按钮因此读
「M 条消息」）。

**修法**：判据从**位置**换成**性质**——成员只收 `thinking` / `tool` / 非 system 的
`injected`；**正文、提示、交互卡一律留在流里**（豁免口径不变）。按钮文案相应去掉
「M 条消息」，只报「N 次工具调用 · K 个 subagent」（皆 0 读「已思考」）。三个收益：
中途正文（可能很长）永远不会被藏起来；尾步被中断的那一截过程照折（缺口不复存在）；
**折叠不再依赖 `step`**，历史里缺 `step/start` 时同样折得对（旧口径只能整轮平铺）。

与官方的差异是**有意**的（官方连中间正文一起折），理由见 `src/webview/turnProcess.ts`
文件头；`docs/audit-summary.md` 的对照表同步。断言重写在 `scripts/turnProcess.test.ts`
（10 组，含「尾部过程」「长正文」「缺 step」「整轮只有噪声」），`scripts/historyReplay.test.ts`
的旧轮次可见正文断言一并更新。

> 折的口径在**同一天**收敛了两次：整轮一枚 → 「正文全留、按连续段各折一枚」→
> **只留最后那段正文**。下面这条是最终口径（前两次都被用户否掉，理由记在条目里）。

### 折叠口径收敛：只留最后那段正文（2026-09-16，用户口径）

**现场**（三段演进，前两段都被否）：

1. 0513070「整轮一枚按钮」：噪声全折进**一枚**按钮，而**按钮跨过了中途正文**——噪声一藏，
   留在流里的中途正文彼此贴到一起，看起来像被并进了最后那段回答（用户报「中间的 agent
   消息会被塞进回答正文，展开才恢复穿插」）。
2. 「正文全留、按连续段各折一枚」：穿插关系对了，但一轮变成「正文／按钮／正文／按钮」
   交替，读起来又碎（用户：「感觉还是怪怪的」）。
3. **最终口径（本条目）**：中途那些话大多是进度叙述，真有价值的信息会在最终回答里复述；
   要保证的只有一条——**用户读的那段回答留在流里**。

**修法**：规则收敛成一句话：**边界 = 本轮最后一段 `text`**，其余**一切**都是折叠成员
（中途正文、思考、工具、subagent、上下文注入含系统提示词、轮级提示、交互卡、命令、图片、
未知块）。边界把它切成前后两段，各按**段内工具调用次数**判阈值（固定 5，**只有 1 次的
工具调用永不折**；不设配置项——没有用户需要调它的场景，固定值让折叠行为可预期）。
折完读作「按钮 → 回答」（尾段够长时后面再跟一枚）。

被中断 / 报错的轮没有最终回答时，**模型最后说的那段话就是留下的那段**——0513070 现场
那类长轮因此不会丢内容。**失败原因不受影响**：它是 `message.error`（含中断的
`@interrupted`），由消息尾部单独渲染，本来就不在段集合里。

**按钮文案补齐三段**（用户 2026-09-16 当天追加报的「只显示工具调用次数，而没有总结有多少次
消息」）：既然中途正文现在也折进按钮，就把官方那三段一起报出来——`message.turnProcess.toolCalls`
/ `messages` / `subagents` + 「 · 」分隔，皆 0 读「已思考」（官方 `client.js:2678-2685`、
`:3282-3285`，en 走 `.one` / `.other` 单复数）。中段数的是**折进去的中途消息条数**
（`TurnProcessCounts.messages`），不含留在流里的最后那段正文。实测预览页按钮读作
「12 次工具调用 · 4 条消息」（en「12 tool calls · 4 messages」，标签不溢出）。

**证据**：

- 预览夹具 a:0（37 段里的 12 次工具调用 + 4 条中途消息 + 提示 + 6 条注入 + 2 条命令）合成
  **一枚**按钮（27 段成员，文案「12 次工具调用 · 4 条消息」），流里只剩「按钮 → 最后那段
  正文 → 图片 → 文件行」（Playwright 无障碍树实测）；中英两语言标签都不溢出
  （`scrollWidth - clientWidth = 0`）。
- 真实会话复算（`node build/render-order-probe.mjs` 折叠摘要）：
  被上游 520 打断的长轮（session-81f16907 turn 1，748 段 / **531 次工具调用**）折成
  **2 枚**按钮（最后那段正文前后各一枚：554 段/396 次 + 193 段/135 次），**0 行平铺**；
  同一会话的 turn 2 / 3 / 4 各折 **1 枚**、0 行平铺（正常轮就是「按钮 → 回答」）。
- 断言：`scripts/turnProcess.test.ts` 重写为 12 组（阈值固定 5 与单次工具永不折、只留最后正文、
  前后两段、中断轮、除正文外全为成员、段不够长就平铺、空白文本段、缺 step、流式不折、
  subagent 计入阈值、**三段按钮文案的中英单复数**），`scripts/previewFixture.test.ts`
  （夹具必须留「一枚按钮 + 最后正文 + 三段计数」形态）与 `scripts/historyReplay.test.ts` 同步。

验证：npm run typecheck ✓；npm test 53/53 套 ✓；npm run build ✓ 且无 esbuild 警告。

### 界面语言不再等自动连接结算（2026-09-16，用户报的）

**现场**：「启动总是先英文」，自动连接结算之后才翻成中文。

**根因**：`ready` 分支先 `resumeRestoreHint`（接回上次的会话），而它要先走 `ensureConnected`
——整个自动连接期间它不结算，**首帧快照（locale / 字号等外观设置都在里面）排在它后面就发不
出去**，界面只能停在词典缺省（英文）上。另一半是起步值：`initialState.locale` 缺省
`undefined`，词典归一化落英文。

**修法**：`ready` **先推首帧快照**（能收到 `ready` 就说明 webview 的监听已挂上，此刻推帧不会
丢），再接回会话；绑上后 `openSession` 会再推一份带会话内容的完整快照，内容照常回填
（`resumeRestoreHint` 幂等）。起步 locale 取 `navigator.language`（webview 里跟随 VS Code
显示语言，与宿主 `readLanguage()` 的 `auto` 分支同源），只撑「首帧快照到来之前」，宿主首帧
带的权威值（`dshChat.language` 固定选择优先）到了即覆盖。

**证据**：`scripts/i18n.test.ts` 第 8 组（`initialState.locale` 必须取 `navigator.language`，
缺省成 `undefined` 就是英文起步）、`scripts/windowState.test.ts` 第 4e 组（`ready` 分支里
`snapshotFor` 必须**先于** `resumeRestoreHint`）。

### 切走再切回来，还没答复的问卷 / 审批不再丢（2026-09-15，用户报的）

**现场**：等问卷的时候切去看历史会话（或别的页面），回来时卡片不见了，agent
永久卡在 ask 节点，只能中断重问。

**根因**：卡片是放进**会话域**（`SessionScope.adapter`）里的，而切会话会
`dropViewers` → `destroyScope` 把整个适配器回收；审批 / 提问**不是 durable 事件**
（会话日志里没有它们），重放不回，于是只活在那个适配器里的请求就永久丢了。
`heldEvents` 原先的语义是「该会话还没有窗口时才挂起」，投递出去就删条目——挡不住
这种「先显示、再被回收」。

**修法**：`heldEvents` 改成「**还没结算**的审批 / 提问」，条目**留到真正结算**
（本窗口答复的 `answerApproval` / `answerQuestion`，或 Host 撤回的 `cancel` 帧）；
回放时机从「建域」（`ensureScope`）挪到「**有窗口绑上这个会话**」
（`bindViewToSession`）——用户切回来走的正是后者。重连路径（`onConnected`，适配器
会整个重建）同样不再删条目。回放必须幂等，所以 `addApproval` 补上了与 `addQuestion`
同口径的 `requestId` 去重（原先无条件 push：第二个窗口绑上同一个会话会画出两张
一样的审批卡，两张还都得分别答复）。回归断言见 `scripts/interactionSync.test.ts`
第 9 / 9b 组。

### 设置页改为「在浏览器中打开」（2026-09-15，用户口径）

自绘的 DSH 服务端设置面板（抽屉式）连同协议链路一起删除，顶部那颗齿轮换成
**「在浏览器中打开 DSH Web」**：用系统默认浏览器打开带启动令牌的首页
（`GET /?token=` 换 cookie），Web 专属的设置（模型编辑器、插件配置、外观…）在官方
页面里改。原因见上一轮调查：官方设置页是各功能插件用 `settings.section` 槽自绘的
页面组合，没有任何数据契约可以复刻。图标用**地球**（`IconGlobe`，VS Code 自己的
Simple Browser 同款）——别跟「在编辑器中打开」的方框箭头撞，两者原先长得一模一样
（用户 2026-09-15 报），断言钉在 `scripts/styles.test.ts` 第 36 组。

- **只开到首页，不能指定会话**（所以按钮不叫「打开此会话」）。Web UI 没有任何 URL
  深链——全厂唯一读查询串的地方是 fixture 测试开关（`dsh-client-connection` 的
  `fixtureOptionsFromLocation`）；会话选择存在浏览器本地的 `dsh.sessions.current`；
  而且令牌换 cookie 那一步是 `303 → 裸 /`，查询串本来就会被丢掉。
  「内嵌 Web UI」这条路也被实测否掉：VS Code webview（含 Simple Browser）是跨站
  iframe，`SameSite=Strict` 的认证 cookie 连存都存不下 → 401。
- **令牌**现读 supervisor 会合文件（`freshToken()`，守护进程可能刚重起过 dsh）。
  外部服务器模式（`dshChat.url`）**刻意开裸地址**：那种模式的令牌是用户自己输进来的，
  扩展换完 cookie 就丢掉、不落盘（令牌按进程生成、重启即失效），所以这里没得可带；
  浏览器以前打开过那个站点就仍然可用，否则用户自己把令牌填进地址栏——他手里就有。
- `busyEnter` 的喂入口现在只剩 `refreshImageCaps`（连模型目录时必跑 + 配置热重载）。
  它以前还挂在 `describeSettings()` 上，那个函数随设置面板一起删了。
- 删掉的东西：`ipc` 的 6 条设置消息与 `settings/describe` 帧、`shared/chat` 的两个设置
  视图类型、`dsh/settingsSchema.ts`（schema → 表单转换）、`scripts/schemaDebug.ts`、
  设置面板组件与 22 条 CSS 规则、18 条设置文案（双语，`settingBusyEnter*` 也随之作废）。

### 用户报的一批（2026-09-15，用户口径）

**一、历史会话跟随工作区；没有文件夹时只给「未分组」。** 可见性判据改成按**服务端
工作区注册表**（`workspace/follow` 的 `items[].sessionIds`）——`session/list` 的
`SessionSummary` **不带 workspaceId**，所以「这条会话属于哪个工作区」只能从注册表读，
不在任何工作区里的就是未分组。两条兜底：会话 cwd == 当前工作区路径（新会话的 `upsert`
增量可能比这次查询晚到）、以及**任何已打开域**的 cwd（恢复窗口时不能因为路径写法差异
把要接回的会话滤掉）。此前没有文件夹时拿 `process.cwd()` 当工作区，未分组的会话一条
都看不见。判据抽成 `sessionList.visibleForWorkspace`（纯函数，带断言）。

**二、答完的问卷展开后要显示用户当时选了什么。** `QuestionView` 补 `answers`
（按题目 id 归档的 `{selected, custom}`），来源两处：本窗口提交时宿主立刻回填、
会话日志里 `ask_user_question` 的工具结果（`{answers:[{id,selected,custom?}]}`）。
卡片渲染**以 `question.answers` 为准**，组件本地 state 只作回退——重挂载、换会话回来、
另一个窗口答的，本地 state 都是空的，只看它就复现「展开后一片空白」。

**三、多窗口下问卷 / 审批要跟着收场。** 判据改成**与会话无关的两条权威信号**
（这正是用户问的「检测标准」）：
1. `$events` 的 `cancel` 帧——网关 `finishRemoteEvent` 在请求被**结算**（另一个客户端
   答了 / 轮次中止 / Agent Context 释放）后推给所有还没答复的投递方，收到它什么都不要回，
   只把本窗口那张卡收场（提问 → `cancelled`，审批 → `expired`；还在 `heldEvents` 里
   挂着的直接丢掉，否则下次打开会话会凭空弹一张过期的卡）。
2. 会话日志：审批有 `approval/asked {id, callId?}` / `approval/decided {id, outcome}`
   审计对（按 `callId` 对回卡片，四档 outcome 映射到 approved / rejected / expired）；
   提问则从问卷工具的结果里取答案。
先收到 `cancel`、随后才拿到答案时，状态要从 `cancelled` **纠正回 `answered`**——
记录里不能一边写「已取消」一边列着答案。回归断言见 `scripts/interactionSync.test.ts`。

**四、问卷的自定义回答是一个组合组件，与普通选项同权。** 它是选项列表里的最后一行
（同一套 `.question-option` 外观），行里两件东西：标题「自定义回答」+ **多行**输入框
（`textarea`，Enter 换行、Ctrl/Cmd+Enter 才是「答完前进 / 提交」）。整行是一个整体：
点它（或在里面打字）即选中它，单选时与选项互斥，**再点一下取消选中**；**选中别的选项
只取消它的选中态、不清空已经写好的内容**（用户 2026-09-15 口径；官方 `choose` /
`draftCustom` 是互相清空的，这里刻意不照做——「选中态」与「有没有字」因此是两件事，
`Rows.tsx` 里由 `customChosen` 单独记）。断言见 `scripts/questionRender.test.ts`
（渲染出「标题 + textarea」这一行）与 `scripts/questionFlow.test.ts`（选中态与内容分开）。

**五、`@` 的按键语义与官方对齐（Enter 引用 / Tab 进入目录），并补上引用对话。**
Enter（或点击行）= 载入整条候选（目录 → `@dir/`）；**Tab = 进入目录**。界面**不动既有
按钮**：目录行右侧仍是「整个目录」（同一件事的显式入口——用户 2026-09-15 更正不要占
那个位置），`Tab 进入目录`的键帽提示挂在**「文件」分组标题栏的最右侧**（只在这一组
真有可下钻的目录时显示，`..` 不算）。候选列表另补上
**「对话」组**，取自官方的 `sessionReferenceResolver/candidates`（确认过生成式描述符：
`scope.wire = 'agentId'`、参数 `agentId + query`，与已经在用的 `fileReferences/list`
同一套约定），选中把服务端铸好的 `@[标题](dsh-session:…)` mention 写进正文，服务端在
消息进入模型前换成被引用会话的快照。**转写里看到的仍是可读的 `@标题`**：落盘的 durable
事件保留原始 token（服务端只给模型那一份副本做替换），所以宿主按官方同一个正则把它折
回去（`shared/mentions.ts` 的 `displaySessionMentions`）。

**六、工作区缓存保存的是「当时的会话」，不是「初始会话」。** 根因：恢复期内**整个不写**
（旧实现只记「待写」标记，等最后一个窗口认领），而 `pending` 可能永远为真——侧栏容器
折叠着时它的视图这一代根本不会被实例化，于是这一轮的变更加起来一次都没落盘，
`dispose()` 时 store 里还是启动时读到的那份旧缓存（用户报的「A 切到 B，重启还是 A」）。
改成**合并写**（`windowState.mergeWindowCache`，纯函数）：已认领的部分用内存里的最新
状态，尚未认领的按原位接在后面；写之前**惰性绑一次工作区身份**（只用编辑区面板、
从没有侧栏被实例化时，键不绑就一个字节都写不出去）。

**七、界面上的三处对齐。**
- 轨迹时间线的右键是**平移手势**：`contextmenu` 无条件 `preventDefault`（此前只在
  `zoom > 1` 时拦，未缩放时右键弹宿主菜单、看着像拖不动），平移监听挂在 `document`
  上，拖出元素也继续跟手；span 与「加载更早」只拦左键。
- 编辑框下方的 tps **始终**取明细里那条「平均输出速度」（会话统计的 Σ输出 ÷ Σ解码
  窗口），与 Web 同口径；此前取「最近一条助手消息的解码窗口吞吐」，与明细里写的本来就
  不是同一个数。两处共用同一个格式化函数与词典 key。
- 删掉配置项 `dshChat.openPanelOnStartup`（连同两份 `package.nls*`、README 中英两表、
  以及 `extension.ts` 里的读取点）。

**八、连接条按钮：只要在连接就能停，「尝试重连」改名「尝试连接」，「查看日志」恒显。**
- 「停止连接」原来只在 `reconnecting`（重连循环在跑）时出现——首轮连接、外部地址等待这些
  "正在连接"的档位反而没有停止入口，而等待本身**没有时长上限**（用户 2026-09-14 口径）。
  现在它绑 `connection === "connecting"`；宿主侧 `stopReconnect()` 的守卫从
  `if (!this.reconnecting) return` 改成"当前处于 `connecting`/`disconnected` 才动手"，
  免得出现"按钮点了没反应"。语义不变：只中止在途那一轮 + 关掉自动重连，**后台一个字不动**。
- 「尝试重连」→「尝试连接」（英文 `Reconnect` → `Connect`），`reconnectStopped` 文案同步；
  `reconnecting` 字段保留，但降级为**只描述"循环还在不在跑"**（连接条文案用），不再是按钮开关。
- 「查看日志」不再只在 `error`/`stopped`/重连时出现，而是**连接条上恒显**。
- 空出的那条断言补上了：`scripts/styles.test.ts` 第 34 组按源码钉住"停止连接绑 `connecting`、
  日志按钮不包三元"（改回去就是功能消失，而 typecheck 与既有断言都看不出来）。

**九、守护进程：dsh 崩了却永远不再被拉起（判据用错对象）。** 主循环原来写
`if (!serverStarting && !server.child && clients.size > 0)`，而 `server.child` 是 `spawn`
返回的 **ChildProcess 对象**——进程死了它不会变成 `undefined`（`exit` 处理器只记日志，
没人清这个字段）。于是 dsh 一死 `!server.child` 永远为假，重启分支再也进不去：实测日志里
`exit` 事件到了，之后每拍打印的 `server.child` 都停在那具死 pid 上，窗口侧表现是"连着连着
没了，再也接不回来"。改成问进程本身（`exitCode`/`signalCode` 已置位，或
`isProcessAlive(child.pid)` 为假，见 `src/supervisor/main.ts` 的 `childGone()`）。
新增端到端探针 `scripts/supervisor-child-exit-probe.mjs`（杀真 node / 强杀 / 卡死三种形态，
按假 dsh 自述的 boot 记录数重启次数，含反向验证）。

**已知边界（未做）**：判据只覆盖"进程消失"。**卡死**（进程在、但不再应答）不会被重启——
守护进程与 dsh 之间只有那条启动时读公告行的管道，没有任何探活。用户那侧要靠
「重启服务器」恢复。详见 `docs/design-supervisor.md` §8.6。

**十、守护进程内部抛错不再"静默死掉"，错误会被发进 VS Code 的日志。**
起因是一次自伤：我在 `child.on("exit")` 里加的一行诊断引用了不存在的变量，
`ReferenceError` 从事件回调冒到顶层 → 守护进程以 code=1 消失（窗口侧只看到"连不上"）。
- **不让它死**：所有事件回调/处理器套守卫，`process.on("uncaughtException"|"unhandledRejection")`
  兜底——原则是"记下来、活下去"（守护进程死了没有任何东西能接替它）。顺带修掉两处**真死锁**：
  `bringUp` 抛错会让 `serverStarting` 卡死（"崩了重起"与"空闲退场"同时瘫痪）→ `try/finally`；
  `startServer` 的轮询回调一抛，promise **永不 settle** → 出错即按"本轮失败"终结。
- **让错误看得见**：新增协议报文 `{"t":"error","kind","message"}`；守护进程把错误
  **写进日志（底线，写不进去退 stderr）+ 经 socket 广播给窗口**，扩展侧转发进输出通道
  「DSH Chat」。用户不用再去翻 `~/.dsh-chat/supervisors/<分组>/supervisor.log`。
- **补发**：最要命的错误恰恰发生在"一个窗口都还没连上"的时候（刚起、日志不可写、dsh 起来就退），
  那一刻广播给的是空集合。上报器保留最近 16 条，新连接先补发历史错误再推状态
  （探针第一次跑就抓到了这条丢消息）。
- 顺带修掉一个**自己引入的回归**：加 `try/finally` 时把 `serverStarting = false` 挪到了
  `publish()` 之后，会合文件里**永远写着 `starting: true`**，新窗口会一直等一个"正在启动"的后台。
- 断言/探针：`scripts/supervisorErrors.test.ts`（上报器本体，离线）、
  `supervisorProtocol.test.ts` 第 5.5 组（报文往返 + 旧扩展兼容）、
  `node build/supervisor-error-bridge-probe.mjs`（端到端）、`supervisorChildExitProbe`（真故障下仍活着）。

**十一、轨迹顶条：缩放后框选错位、选中后账本不跟过去。**
- **框选区域与手划的区域不符（缩放之后）**：选区存的是**归一化域位置**（与账本的
  `left`/`width`、`inRange` 同一套坐标），而左键框选当时是直接拿**屏幕比例**当域位置记的，
  画的时候又过一次缩放变换——不缩放时两套坐标重合（所以此前看着没问题），一放大就偏，
  偏得越大越离谱。修法是把换算抽成一对互逆的纯函数
  （`trajectoryScreenFraction` / `trajectoryDomainPosition`，`shared/trajectory.ts`），
  绘制与命中各走一侧；断言钉了往返一致 + 「屏幕正中 = 视口正中」。
- **顶条点了谁、框了哪一段，下方账本要跟着跳过去**：账本行加 `data-cell-index`，
  点某一条 → 滚到那一行；框选**结束**（鼠标抬起 / 拖出绘图区）→ 滚到选区里的第一条
  （用 `inRange` 挑，保证「跳到的就是高亮的」）。滚动只动账本自己，落点是**置顶对齐**
  （后来按 2026-09-15 二次口径改过，见十七）；拖动过程中不滚（每移动一像素就滚一次
  会把账本晃坏）。同一条记录反复点也要重新滚，所以请求里带 `nonce`
  （state 不变 effect 不跑，看起来就像「点了没反应」）。
- 头部那颗「轨迹 ⇄ 会话」按钮**不再显示选中态**：轨迹视图下它画的是「会话」图标，
  选中态属于「当前显示的视图」，而当前显示的是轨迹——图标与选中态必须指同一件事。
- 工具栏那三个开关（时长 / 轮次 / 调用）**按下要有按下的样子**：状态本来就挂在
  `aria-pressed` 上（无障碍树一直是对的），但画面上**什么都没有**——按下去分不出
  生效没（用户 2026-09-15 报的）。按下态用与 `.icon-btn.is-active`、账本选中行同一套
  `--active`；`:hover` 再显式写一条（同特异性下后者胜，不靠源码顺序兜底）。断言见
  `scripts/styles.test.ts` 第 36 组。

**十二、编辑器标题栏新增「在本分组新建对话窗口」**（`editor/title` 贡献点，任何文件 /
标签页打开时都在编辑器右上角，命令面板里同一条）。它与「在编辑器中打开」**刻意不同**：
`openPanel` 现在接受 `ViewColumn` 并返回 `viewId`，这条命令传 `ViewColumn.Active`
（**就在用户当前所在的分组里**开一个标签页，不另开分组）并接着 `controller.newSession(viewId)`
起一个新会话——用户 2026-09-15 口径是「点一下，本分组里多一个 DSH 新会话窗口并跳过去」。
新会话是显式动作，允许拉起后台（与既有口径一致）。

**十三、滚动条拐角 / 右下角拉伸角的白底。** 用户 2026-09-15 报的：问卷自定义回答的
编辑框一出现垂直滚动条，右下角那块「可拉动」的标志就变成白底。实测预览页取像素，
修复前那一块是 **`#efefef` 实心方块**（Chromium 在深色主题下给 resizer 画的就是它，
而本项目的滚动条轨道是透明的，所以特别扎眼）。修法两条一起：`::-webkit-scrollbar-corner`
与 `::-webkit-resizer` 底色清成透明（自定义了 `::-webkit-scrollbar` 却不给拐角清底，
就是一块白方块），**再用主题色自己画两道斜线**当拉伸标记——只清底的话那个角会彻底
看不见，等于把「可以拉」这个提示删掉。断言见 `scripts/styles.test.ts` 第 35 组。

**十四、插话发送的消息排在排队发送的消息上方。** 服务端给的队列顺序是**提交先后**，
于是「先排三条队、最后插一句」时插话显示在最下面，看着像插话还没生效。口径（用户
2026-09-15）：`steering`（马上进当前轮）排在 `queued`（等下一轮）上面，两组内部各自
保持原顺序。**只改显示顺序**——宿主「ESC 中止并把队首发出去」是按 `scope.queueItems`
的原顺序重发的（`controller.stopRunning`），所以排序放在界面侧的纯函数
`src/webview/queueOrder.ts` 里，映射层 `dsh/queueView.ts` 的数据顺序一字不动；
断言见 `scripts/queueOrder.test.ts`（含「入参数组不许被改动」）。

**十五、轨迹顶条的光标：框选区域用文本 I 字，不用手掌。** 绘图区的光标从十字线
（未缩放）/ 手掌 `grab`（缩放后）统一改成 `text`——「框选一段时间」的隐喻就是选文本；
手掌原本是右键平移的暗示，但压在「想框选」的手势上只会误导。平移手势保留，
只是不再有光标提示；只为那颗光标存在的 `is-zoomed` 类一并删掉。断言见
`scripts/styles.test.ts` 第 37 组。

**十六、编辑器标题栏「在本分组新建对话窗口」换成鲸鱼图标。** 此前是
`$(comment-discussion)` 会话气泡，与旁边一排 codicon 并排时读不出「这是 DSH」。
换成品牌鲸鱼（`media/whale-light.svg` / `whale-dark.svg`，与活动栏、扩展图标同一只
DeepSeek 鲸鱼的单色 16×16 派生，深浅主题各一份——VS Code 1.83.1 起命令文件图标
按 SVG 原色渲染、不再 mask 着色，见 microsoft/vscode#194710）。断言见
`scripts/manifest.test.ts`（图标指向、两份 SVG 在场且与 `media/icon.svg` 同形）。

**十七、账本跳转的落点：目标行「置顶」对齐，不是最少滚动。** 用户 2026-09-15
二次口径：顶条点选（= 点的那条）或框选（= 选区里第一条，`inRange` 挑的那条）之后，
那一行要被**顶到账本视口的顶边**；原实现是「最少滚动」——从账本顶部点下去，目标行
总是**贴着底边**进来。改为 `scrollTop += rect.top - box.top` 的置顶对齐（反复点同一条
也会重新对齐，`nonce` 那套不变）；尾部最后几行下面内容不够、贴不了顶，`scrollTop`
赋值被浏览器夹在滚动上限，效果就是「尽量靠上」。断言见 `scripts/trajectory.test.ts`
第 12 组（置顶对齐在场、最少滚动两条分支不许回来）。

**开发侧（本批）：三个坑——守护进程退不了场、探针撞管道名、探针跑完不退。**
- **守护进程收到 stop / 空闲也永不退场（最严重，用户能直接感觉到）**：`guard(kind, fn)`
  是**工厂**（返回包装函数），而 `shutdown` 的收尾体被写成了语句位置的
  `guard("shutdown", () => {…});`——回调没人调用，收尾一行都没跑，`stopping` 却已置真：
  守护进程变成僵尸，`tick` 从此直接 return（连「dsh 崩了要重起」都不再做），
  会合文件与 socket 也都不清。「停止服务器」/关掉所有窗口之后后台一直留着，就是这个。
  上一轮加 `guard` 时漏掉的调用（c7ef97b，2026-09-15 21:05）。
  修法不只是补一个 `()`：加一个**显式名字** `runGuarded`（= 立即执行）把这种写法变得
  写不出来，断言钉在 `invariants.test.ts` 第 4 组（**语句位置**的 `guard(…)` 一律不许
  出现——`createServer(guard(…))` 这类实参写法照旧允许；`runGuarded` 必须真的调用
  `guard` 返回的包装函数）。这条断言用**注入**验过：把 `runGuarded` 改回裸
  `guard("shutdown", …)`，它以 `src/supervisor/main.ts:562 …（上一行：stopping = true;）`
  变红。验证：
  `node build/supervisor-idle-probe.mjs` 全绿（关窗后阈值内照旧活着 → 阈值后 6 秒左右
  端口、会合文件、supervisor 三者清干净）；`npm run smoke` 的 supervisor 日志里出现了
  完整的「退场（stop）→ 收尾：停止 dsh → dsh 进程退出」。
- **管道名没被隔离**：`DSH_CHAT_SUPERVISOR_DIR` 只隔离了会合**目录**，而 socket 在
  Windows 上是全局命名空间里的 `\\.\pipe\dsh-chat-<分组>`（`socketPathIn` 从前只看分组）。
  于是只要用户窗口里那套 supervisor 在跑（本机常态），探针的 supervisor 一起来就
  `EADDRINUSE` 退出、被无限重起，`npm run smoke` 卡在「1) 启动服务器」刷屏
  （日志：`%TEMP%\dsh-chat-sup-probe-*\*\supervisor.log`）。
  修法：目录**不是默认会合根**时，把规范化后的目录哈希 8 位接在管道名后面
  （`isolatedScope`）；默认根算出来的名字与从前**逐字节相同**，生产零影响。
  断言见 `supervisorProtocol.test.ts` 第 1 组（生产名字不变 / 隔离目录带后缀 /
  两个隔离目录互不相同 / 大小写与尾斜杠不影响判定）。顺带把
  `supervisorProbeEnv.ts` 里「环境变量必须在模块求值前设好，因为它只在模块初始化时读
  一次」这句过时注释改成事实（`supervisorRoot()` 是每次调用现读）。
- **探针跑完不退**：`server.stop()` **有意保留心跳**（扩展语义：别的窗口把后台重新起来
  时本窗口要能自动接上），而心跳是个 `setInterval`——探针因而永远退不出去：打印完
  「端到端通过」之后，探针、supervisor、它拉起的 dsh 三个进程还挂在机器上（实测，
  只能手工杀）。`smoke.ts` 的 finally 补一句 `server.dispose()`（关连接 + 停心跳）。
  这个坑以前看不到：探针此前根本走不到那一步。

**验证（含一条不稳定的探针断言）**：`npm run typecheck`、`npm test`（51 套，本批新增
`scripts/interactionSync.test.ts`（多窗口收发场判据 + `@` 对话引用接线）、
`scripts/questionRender.test.ts`（用 `react-dom/server` 真渲染问卷卡）与
`scripts/queueOrder.test.ts`（待发队列的显示顺序））、`npm run build`
全绿；十一~十三这一轮另在 `npm run preview` 的预览页上**用浏览器实测**过（不是看源码
推断）：缩放后左键框选出的 `.trajectory-range` 与手划区间逐点一致（屏幕 30%→70% 拖出来
就是 30%/40%）、点最后一条 span 后账本 `scrollTop` 从 70 走到 174 且那一行完整可见、
问卷自定义回答的四种交互（打字即选中 / 点普通选项**内容仍在**且取消选中 / 点标题选回 /
再点一次取消）逐条核对，以及拉伸角**取像素对照**：修复前是 `#efefef` 实心方块，修复后
与所在行底色一致且右下角有两道 `--muted` 斜线；工具栏三个开关按下前后的底色取像素
对照是 `[30,30,30]` → `[35,49,71]`（按下后再悬停仍是 `[35,49,71]`，没被 hover 吃掉）；
待发队列的渲染顺序也核过：夹具里排在最后的 `steering` 那条显示在**最上面**，条数仍是
「待发送 3 条」（只换顺序、不增删）。
`npm run smoke` 端到端**全部通过**（1–12 全绿，含此前一轮判为环境问题的 **9c**：这次
`turn/end = {"kind":"aborted","reason":{"kind":"user"}}`）。**9c 仍按不稳定处理**：上一轮
在改动前的 HEAD（77cd70a）上复跑时它以 `turn/end = undefined`（30 秒等不到事件）失败，
这次同样的断言过了——两次观察结论相反，所以不写硬断言，只记观察。
在此之前它在本机**根本起不来**：探针的 supervisor 与用户那套撞管道名、无限重起（见上）。

### 输入通道、历史加载、轮尾与面板的一批对齐（2026-09-14，用户口径）

**零、「轨迹」与官方对齐（账本 + 详情检查器 + 工具栏 + 时间线）。**
先纠正一个事实：上一版把面板**改名**成「工具调用」以「不冒充官方视图」——用户否掉
了这条路（「我要的效果就是要和官方一样，请对齐实现」），所以**名字保持「轨迹」**，
改为真做。调研结论（完整规格见 `docs/design-trajectory.md`）：

- 官方的轨迹视图**没有任何服务端接口、也没有投影**：它是客户端对**同一份 durable
  事件窗口**做的**第二次折叠**（8 个 definition 各自贡献记录 → snapshot → 账本）。
  `session/follow` + `session/page` 就是它的全部输入，所以本扩展**不需要新 RPC**，
  需要的只是同一份事件的另一套折叠（聊天流那套在 `adapter.ts`，口径是「人类转写」）。
- 落地：宿主新增 `src/dsh/trajectory.ts`（`deriveTrajectoryModel`，纯函数，输入是
  `adapter.trajectoryEvents()` 的**全部** durable 事件——chat 折叠刻意忽略的
  `request/header`、`compaction/*`、`tool/ptc-dispatch*` 正是账本的原料）；
  线格式 `{type:"trajectory", json}`（整段 JSON 字符串，绕开「undefined 键被丢掉」
  那套语义，也不必给几十个轨迹字段登记 `wire.ts`）；界面 `components/Trajectory.tsx`
  = 工具栏 + 两列账本（event / content）+ **时间线** + 详情检查器（页签按记录种类
  派生，与官方 `detailTabs()` 同一套分支）；文案逐字取官方，单独放
  `webview/trajectoryTexts.ts`（只在 webview 内消费，不走 `@key` 标记）。
- **时间线**（`deriveTrajectoryTimeline`，纯函数在 `shared/trajectory.ts`）：三条泳道
  （输入 / 模型 / 工具，官方 `laneFor` 逐字）、轮次边界竖线、三种成条模式
  （`sequence` 等宽 = 官方默认 / `duration` 按自身耗时且**扣掉空闲** / `time` 按真实
  时刻且宽度归零）、点一条选中该记录、拖动框选在账本里高亮那一段、双击清空、
  左端 `…` 加载更早。
- **时间线交互**（对齐官方那两样）：**滚轮以光标为锚缩放**（官方
  `Math.exp(deltaY * 0.0015)` 乘在域跨度上，我们的 `zoom` 是倍数所以要取倒数——
  照抄原式符号会让向上滚变成缩小，第一次实现就是这么错的）、**右键拖动平移**
  （仅在已放大时，官方 `pannable`）。另加一个缩放复位按钮与双击复位：官方只有
  「双击清选区」，缩进去之后没有别的出路。
- **运行中的记录**：最后一次 `turn/end` **之后**开过的步骤（有 `step/start`、
  没有 `assistant/message`）出一行 **`status: "running"`** 的助手占位（正文留空，
  带呼吸点）——官方那里是流式正文行；更早的未结算步骤不臆造正文（官方由
  `assistant/attempt` 还原）。面板开着且 agent 在跑时**每 3 秒重取一次账本**
  （官方是事件流增量更新，我们按需整份下发，所以用这个节奏）。
- **详情检查器**：默认宽度按官方 `clamp(320px, 38%, 440px)` 算，**左边缘可拖动**
  调宽（280–720，双击复位）；面板窄于 760px 时改成盖在账本上的抽屉（官方同款）。
- **刻意没做的**（都写在 `dsh/trajectory.ts` 的文件头，免得下次当成 bug 查）：
  流式正文本身（只出空占位行）、系统提示词的独立更新按 `request/header` 变化合并、
  请求编号按 `step/start` 递增、检查器里的 `hierarchy` 跳转 / `usage` 会话累计 /
  `options` 页签 / 从对话跳进轨迹（官方 `viewRequest.focus`）。
- 验证：`scripts/trajectory.test.ts`（十个断言组：七种记录的顺序与序号连续性、
  用户 vs 上下文的分派、工具 call↔result 合成一条、压缩生命周期、系统提示词更新带
  上一版、轮次分组与 prologue 合并、重试与轮次错误、运行中的占位行、中断、
  时间线三模式）；夹具 + `npm run preview` 用 Playwright 实测（七种标签、三种记录的
  页签集合、轮次折叠 9→2→9、搜索高亮、时间线三泳道与等宽/耗时切换、点选联动、
  拖动框选高亮 5 行并在双击后清空、滚轮缩放 2.46× 后 9 条只剩 5 条可见、右键平移
  改视口、双击复位、检查器 440 → 590 → 440）。

**零之二、添加文件 / 选区 / 目录**一律走 `@` 引用（用户 2026-09-14 口径：
「不论是目录、文件、文件某行，均以 @ 引用形式而不是附件形式添加」）。

- 编辑器选区不再塞 `selection` 附件芯片、不再把选中的代码整段内联进正文，改为插入
  **`@文件#L12-L40`**（单行只写 `#L12`）。行号是这条引用与「整文件引用」唯一的区别；
  官方语法里**没有**行号（`dsh-file-reference` 的 `FILE_REFERENCE_PROMPT` 只定义
  `@path` / `@dir/` / `@"含空格的路径"`），这条偏离与理由写在 `shared/mentions.ts`。
  锚点用 GitHub 的 `#L12-L40` 而不是编译器的 `:12-40`：`#` 开头**不可能是文件路径**，
  所以「模型把行号当成路径的一部分去 read」这条误读路径根本不存在。
- 资源管理器右键文件 / 目录、命令面板「添加文件夹到对话」同样插成 `@路径` / `@目录/`。
- `selection` 附件种类连同它的提示词内联分支、芯片行号样式一起**删除**（没有入口会
  再产生它）；附件通道只剩「回形针 / 拖放」这条，且与官方一致地**不筛内容**
  （见第一节）。

**零之三、轨迹改成*整页*视图（不再弹侧边抽屉），并修两处与官方不一致的地方**
（用户 2026-09-14 口径）。

- **图标重画**：旧的「三个圆点 + 两小段连线」在 15px 下只剩三个点，既不美观也看不出
  「轨迹」。现在按「路线」画：两端各一个端点圆、中间一段 S 形折线（与相邻的历史
  「时钟回绕」、分支「git 分叉」都不撞形状）。
- **整页切换**：点轨迹按钮 → **会话页整块让位**（消息列表 + 待办卸载，输入区留在
  原地——官方同样在底部给输入区留位），那颗图标同时变成**会话图标**（点它回来）。
  迷你模式下这颗按钮**不跟着收起**：它是唯一的退路，收起来就出不来了。
- **「加载更早」的 `…` 挪到时间线左端**（官方 `earlierHistory`：贴住绘图区左缘、
  向右渐隐、z-index 5），同时**删掉标题栏里那个重复的「加载更早」按钮**——它标的是
  「左边界之外还有内容」这个方向，排在绘图区右侧是反的；标题栏那个按钮还是弹出来
  之后才突然冒出来的。现在左边那个是**唯一**入口，另外「没有计时数据」时它也照样在
  （有没有更早的历史与有没有计时无关）。
- 顺带修两个跟着暴露的问题：①聊天区被整页视图顶掉后 `loadMore` 不再要求滚动容器
  在场（否则轨迹里的 `…` 点了没反应）；②切会话 / 新建对话时丢掉上一会话的账本并
  重取（整份快照里没有轨迹模型，只有 `listTrajectory` 现折）。另外**会话页卸载后
  要能原样回来**：`chat-scroll` 是新元素（scrollTop 归零），所以两个滚动 hook 吃一个
  `active` 重挂监听，并按离开前的贴底状态复原滚动位置（贴底 → 跟到底，否则回到原处）。
- 回归断言：`scripts/styles.test.ts` 第 17–18 节（整页而非抽屉、`…` 在绘图区内部且贴
  左缘、头部按钮的图标随视图切换且迷你模式不收、取历史走同一条链路并在取完后刷新、
  概述摊开参数/结果/Schema/计时、正文只写一份、分节限高自滚、账本与检查器不换行）；
  Playwright 实测：整页切换后 `chat-scroll` 卸载 / 无 `[role=dialog]`、9 条记录
  9 条 span、`…` 与绘图区左缘 x 坐标相同、点 `…` 发出 `loadMore` 且不起选区、
  迷你模式（200px）下按钮仍在、来回切换后滚动位置复原（上滑到 300 → 回来仍 300；
  贴底 → 回来仍贴底）。

**零之四、轨迹补上「用户 / 上下文」记录，配色对齐官方**（用户 2026-09-14 口径）。

- **`user/message` 的线格式读错了**（真机上「用户消息与上下文节点都不出现在轨迹里」的
  根因）：契约是 `'user/message': UserMessage`——**事件 data 就是消息本身**
  （`{id, role, content, source}`），不是 `{message}` 那种包法（包一层的是
  `system/message` 与 `tool/result`）。折叠却按 `data.message` 读，于是 `kind`/`text`
  全空、整条被 `if (!text && !isHuman) break` 丢掉——用户说的两类记录同时消失。
  核对方式：扫 **280 份真实会话日志里的全部 2443 条 `user/message`**，data 的键一律是
  `content,id,role,source`，带 `message` 包装的**一条都没有**；
  来源 kind 的实际分布 = plugin 1414 / user 535 / agent-instructions 213 /
  skill-catalog 201 / agent-message 34 / subagent-settled 31 / goal 13 /
  skill-invocation 2（**没有 `user-rpc`**，那个分支只是与本扩展聊天侧口径保持一致）。
- **测试夹具也在同一个坑里**：`scripts/trajectory.test.ts` 原先照错的形状编
  （`{ message: ... }`），折叠按错的字段读，两边一起错所以全绿。现在夹具走线格式，
  并显式断言「data 不许是 `{message}` 包装」。注入式验证：把折叠改回 `data.message`，
  断言立刻变红。
- **配色对齐官方**（「输入绿、模型紫」）：七种记录的色调逐条对官方 `kindTag`——
  `context` → 绿（官方 `contextGreen`，输入侧最常看到的就是它）、`message`（助手）→
  紫（官方 `assistantVioletBright`）、`user` → 蓝、`tool` → 琥珀、`subtool` → 更淡的
  琥珀（官方 warn 62% + label-tertiary 的配方）、`system` / `compacted` → 中性
  （此前 `compacted` 占着紫色，助手反而是青色）。种类标签的底色改成**自己色调的
  14% 淡色**（官方 kindTag 的 tertiary 底），时间线的条与之同一套，并按官方口径
  中性档 78% 不透明度、有色调的拉满。
- 回归断言：`scripts/trajectory.test.ts` 第 2 组（线格式 + 三类来源各出一条，一条都
  不许被吞）、`scripts/styles.test.ts` 第 19 节（色相：`--node-read` 必须是
  `charts-green`、`--node-edit` 必须是 `charts-purple`；接线：上下文=绿、助手=紫；
  七种记录一个不漏；标签底色跟色调走）。注入式验证：`message` 改回 `--node-code`
  立刻变红。Playwright 实测九行账本的 computed color：系统灰 / 用户蓝 /
  **助手紫 rgb(171,71,188)** / 工具橙 / 子工具淡橙 / **上下文绿 rgb(137,209,133)** /
  已压缩灰 / 失败工具红；时间线九条 span 的底色与不透明度逐条对上官方口径。

**零之五、轨迹取历史改成与会话页同一条链路，概述页摊开后几张卡片**（用户 2026-09-14 口径）。

- **取历史的链路**：轨迹的「加载更早」此前点了**没有下一步**——它发的是同一个
  `loadMore`（会话页那条：宿主一次取到底、逐页回填消息），但宿主只回填会话侧，
  不会顺手重推账本，于是取完什么都不会变。现在：点 → 会话去取（同一条链路）→
  **宿主把 `historyLoading` 落回 false 时界面自己重取账本**（`App` 里一个
  「true→false 收尾」的 effect，`panel === "trajectory"` 才发）。这条判据只在
  轨迹视图开着时生效，关着时一个请求都不多发。
- **加载中看得见**：账本最上面加了官方那行「加载更早的历史」
  （`historyLoadRow` + `historyLoadButton`）：取的过程中显示 spinner +
  「正在加载更早的历史…」并禁用；时间线左端那个 `…` 同时禁用。两个入口是同一个动作。
- **概述页摊开后几张卡片**（对齐官方 `overviewSections`）：工具 / 子工具记录的
  「概述」页现在直接显示**参数 / 结果 / Schema / 计时**四节，用户/上下文/助手记录
  显示**预览**一节，压缩记录直接摊开摘要正文。每节标题可点（带 `›`），点了切到对应
  页签看完整版；分节限高 220px 自己滚，一节几千字也不会把概述撑成一整页。
  各页签正文抽成一份 `bodies`（分节与页签共用），两处不会走样。
  工具行的「开始时间 / 总时长」从概述行里拿掉，只留在「计时」节里（官方也是这个分工），
  免得同一个数据在同一个面板里出现两遍。
- **顺带修的布局坑**：账本与检查器原来是 `flex-wrap: wrap`，检查器拖宽就会折到第二行、
  撑出固定高度的主体（叠到输入区上）。现在不换行，并给检查器加官方那条
  `max-width: calc(100% - 280px)`（`TABLE_MIN_WIDTH`）——拖到最宽也给账本留 280px。
- 回归断言：`scripts/styles.test.ts` 第 18 节；Playwright 实测：`loadMore` →
  （`historyLoading` true→false）→ **恰好一次** `listTrajectory`（且 `running:false`
  时没有轮询干扰）、加载中那行显示「正在加载更早的历史…」且禁用、工具行概述里四节
  标题与正文都在、点「Schema」标题切到 Schema 页签、用户行只有「预览」一节、
  压缩记录直接出摘要、检查器拖到 720px 时账本仍有 272px 且不溢出主体。

**一、`@` 与「附件」是两条通道，界面上一眼可分。** 此前 `@` 选中文件后生成的是
**附件栏里的引用芯片**——和「添加文件」上传出来的芯片长得几乎一样，用户分不出
「我是让它自己读，还是我把文件传上去了」。现在：

- `@` 选中文件 → 把官方的 `@path` token **直接插进输入框正文**（目录是 `@dir/`，
  含空白的路径加引号），发送出去的就是这串文本；系统提示段据此告诉模型「这是用户
  显式引用的工作区路径，需要内容就用 `read` 工具读」。**不再进附件栏**。
  token 的产生规则收敛到 `src/shared/mentions.ts` 一份（宿主拼引用与界面插 token
  必须逐字一致，否则同一次引用会随入口变成两种拼写）。
- 附件通道**与官方一致：只按「是不是图片」分派**。图片 → 内容块；**其余文件
  （含二进制、非 UTF-8、任意大小）一律逐字节上传**。
- **踩过的坑，别再踩**：中途加过一层「模型读不读得了」的筛子（二进制 / 非 UTF-8 /
  超 8 MB → 改成裸路径引用），理由是「给模型读不出的字节没意义」。**这个理由本身是
  错的**，用户实测（Web 端上传一个 exe）推翻了它：官方客户端与上传接口都**不筛**
  （`dsh-client-file-upload/lib/types/client/runtime.js` 的 `upload()` 只做 base64 /
  流式两件事），而**上下文里对任何文件都只放**「路径 + 大小 + sha256」引用
  （`session/prompt` 只带 `{type:'file', receiptId}`，宿主解析成 `FileAttachmentRef`，
  其 `attachmentId` 就是字节的 sha256）——「exe 没进上下文」不是过滤，是**所有文件
  都不进上下文**。上传出来的那份只读副本 + 内容寻址 id 对模型反而有用。扩展自加的
  筛子只会让同一个文件在 Web 上是「已上传的引用」、在扩展里变成一串裸路径文本。
  唯一的真实准入限制在图片那条路上（官方 `IMAGE_ADMISSION_ERROR_CODES`，限额经
  `imageLimits` 投影下发，本扩展已消费）。

**二、「添加选区」与「添加文件」合并成一条命令，并给了默认快捷键。**
`dshChat.addSelection` + `dshChat.addFile` → `dshChat.addToChat`，绑定
**`Alt+Shift+2`**；有选中就加选区，没选中就加整个文件。命令标题**不能**随选中状态
变化（VS Code 的菜单项标题来自 `package.json`，运行期没有 API 可改，菜单贡献项也
不支持逐项 `title` 覆盖），所以命名为「添加文件(或选区)到对话」。

**二之二、右键菜单里「选了代码也加整个文件」——VS Code 的传参坑。**
`editor/context` 的命令**也会**把当前文档的 uri 当第一个参数传进来，和
`explorer/context` 一模一样；当初「有 uri 就当资源管理器点击」的判断于是把编辑器
里的选区吃掉了。判据改成「这个 uri 是不是当前编辑器打开的那份」：是 → 编辑器入口
（按选区分派），不是 → 资源管理器点中的文件。

**三、历史加载定成「一次取全部」。** 审计结论：早先「至少取到用户的上一条消息」
的判据与服务端的分页粒度**对不上**——`session/page` 的 `paginate()` 按**固定条数**
（本扩展传 50）从 `beforeSeq` 往前切，切点与轮次边界无关；一轮几十条消息而一页固定
50 条，切点几乎总落在上一轮中间，于是循环一路取到底——**实际行为本来就是「一次
触发取回整个历史」**，与当初的设计意图相反。既然用户也认可，就把它定成设计：判据
只留「服务端说没有了」与「这一页没进展」，外加一个防病态的页数安全阀
`MAX_HISTORY_PAGES = 200`（`src/dsh/historyPaging.ts` 有完整推导）。按钮文案改为
「加载全部历史」。

**四、右侧轮次横条：做完又被否掉，已整体删除。** 曾按官方 turn rail 实现（投影 +
已加载窗口合并、可点可预览、未加载画虚线），用户试用后判定「有点违和，先删掉，
后续再考虑别的设计」。**代码已全部移除**（`src/webview/turnRail.ts`、断言、
`App.tsx` 里的横条与滚动定位、CSS）。`turnOutline` 投影的**解析保留**——它的形状
上一批刚按契约修对（见第七节），留着给后续的导航设计直接用。

**五、其它界面改动。**

- **用户消息超过 5 行默认收缩**，「展开 / 收起」放在**轮尾操作行的最右侧**
  （时间 → 复制 → 展开，用户口径）。判定按**实测渲染高度**而不是数换行符——一段
  没有换行符的长 prompt 照样会折行占满整屏。折叠行数只写在 `Message.tsx` 的
  `USER_COLLAPSE_LINES`，CSS 经自定义属性读它（两处各写一个 5 迟早对不上）。
  **坑**：把这个 ref 当 prop 传给子组件时**不能叫 `ref`** —— React 18 里它是函数
  组件的保留 prop，传进去不进 props（只有一条警告），`ref.current` 永远 null、
  溢出测不出来，按钮根本不出现。已改名 `nodeRef` 并写在注释里。
- **每轮的复制 / 分支 / 用时常驻显示**（原来 `opacity: 0` + 悬停揭示）。一条轮尾操作
  行本来就是那一轮唯一可点的东西，藏起来只会看着像一段空白；
- **分支图标改成「竖干 + 向右拐出再向下」**：旧版那三段弧线没有接到主干上，
  15px 下看不出哪条是分支、更没有「分出方向」。
  （「轨迹」面板**保留原名**，见第零节。）

**六、`ui-conversation.busyEnter` 从「部分生效」补成完整生效。** 审计发现三处缺口：

- **冷启动读不到**：`applyBusyEnter` 只在 `describeSettings()` 里调用，而它只由
  「打开设置抽屉 / 保存设置 / 外部改 settings.yaml」触发——新窗口在碰过一次设置面板
  之前 `busyEnter` 恒为 undefined，用户的 `steer` 静默退回 queue。现在随
  `settings/describe` 一起喂（`refreshImageCaps` 那条链路），并按变化推一帧给界面；
- **运行中守门失效**：`send()` 先乐观置 `scope.running = true` 再判定模式，于是
  `!running → queue` 这道门永远走不进去，空闲发消息也带 `mode:"steer"`。现在**先取
  `wasRunning` 再置位**；
- **手势与按钮那一半完全没做**：`submitMode(scope)` → `resolveSubmitMode(running,
  gesture)`，逐字移植官方 `resolveSubmitMode`（主手势用设置值、**Cmd/Ctrl+Enter 取
  相反值**、空闲恒 queue）；`send` IPC 增加 `gesture` 字段；运行中草稿非空时主按钮
  不再是「停止」，而是按设置标注的「排队发送 / 插话发送」（草稿为空才是停止，与官方
  `primaryStops` 同口径）；队列行补上「插话发送」（`session/updateQueue` 的
  `{kind:'steer'}`，只对 `queued` 行给出，`steer-unavailable` 按官方口径静默）。
  设置面板里这一项现在有中英双语的人话标题与说明。

**七、`turnOutline` 投影的形状读错了（第三次「按猜测的形状写」）。** 契约是
`{turn, seq, prompt, response}`，扩展读的是 `{turn, seq, summary, startedAt}` ——
`summary` 恒空串、`startedAt` 恒 0，而 `prompt`/`response` **从未被读过**；因为没有
消费者所以一直没显症状。现在按契约逐字解析（容忍度与官方 `outlineEntry` 同口径：
`turn`/`seq` 坏了整条丢弃，预览坏了退化成空串）。它一度由轮次横条消费，横条被否掉
之后**解析保留、暂无消费者**——形状是对的，留着给后续的导航设计直接用（比「解析了
但字段全错」好得多）。

**八、后台任务面板的两处错判。** `stopping` / `killed` 以前画成「运行中」/「没有
状态点」，与官方 `dotState`（两者同为 warning 色）相反——按了停止的任务看起来还在
跑、已被取消的连点都没有；排序也改回官方 `ordered()`（在跑的恒在最前、按开始时间
升序；已结束按结束时间降序）。另外**词表外的状态不再折成「已完成」**（那是对未知
状态给出一个错误的肯定结论），而是原样显示 + 未知色调。

**九、`code --install-extension` 的 `[DEP0169] url.parse()` 警告：不是扩展的问题，
但给了静音办法。** `--trace-deprecation` 的调用栈指向 VS Code 自己的 CLI
（`cliProcessMain.js` → gallery 元数据查询 → `url.parse`），安装阶段扩展根本没被
加载，命令退出码 0。本扩展改不了 VS Code 源码，新增 `npm run install:vsix`
（`scripts/installVsix.mjs`）用 `NODE_OPTIONS=--no-deprecation` 静音；脚本自己解析
`Code.exe` + `out/cli.js` 直接启动，绕开 `.cmd`（Node 不允许直接 spawn `.cmd`，
`shell: true` 又会引入 DEP0190，手拼 `cmd /s /c` 的引号规则会把路径连引号当字面量）。

**验证**：`npm run typecheck` / `npm test`（47 套，新增 `jobsOrder` 与 `trajectory`
两套）/ `npm run build`（无 `[duplicate-case]` 警告）；`scripts/historyReplay.test.ts`
按新口径重写（旧断言「取到用户的上一条消息为止」已被取代）；
`scripts/pathInsert.test.ts` 明确钉住「二进制 / 非 UTF-8 / 超限也要做成附件」
（防止可读性筛子被加回来）；界面改动在 `npm run preview` 里用 Playwright 实测过
（展开按钮的位置与折叠往返、操作行常驻、横条已移除）；`npm run install:vsix`
实测警告消失、安装成功。

### 删掉 `dshChat.startTimeoutSec`：连接状态不再由时长决定（2026-09-14，用户口径）

> 用户口径：*"控制自动重连状态通过提供停止连接、开始连接、启动服务器等按钮，以完全由
> 用户手动操作，而不是通过时长控制……这个时长控制不应该还在。"*

2026-09-14 那一版只删掉了"重连的**总**超时"，单次等待仍受 `dshChat.startTimeoutSec`
（默认 90 秒）约束。于是每 90 秒都会发生一次**由时钟决定的状态改写**：界面从"正在连接…"
被打成"启动超时"，再由心跳拉回重试——用户看到的是一条条假失败，而"要不要继续连"
本该只由按钮决定。现在：

- 删掉配置项 `dshChat.startTimeoutSec`（`package.json`、两份 `package.nls*`、README 的中英
  两张表）与 `ManagerOptions.startTimeoutMs`（22 个脚本里的传参一并去掉）；
- `waitForReadyState` 不再有 deadline：等到**真的就绪**，或 `AbortSignal` 被 abort；
- 「停止连接」/「停止服务器」调 `SupervisorManager.cancelWaiting()` **中断在途那一轮等待**
  （只中断等待，不碰任何进程）：中断以 `WaitCancelledError` 结束，controller 把它当
  "用户叫停"——界面切到 `stopped`（给「尝试重连」），**不写错误详情**；「重启服务器」
  等新地址同理（原来 90 秒后会报超时）；
- **顺手补掉两处"按钮说了不算"**（同一条口径：开关只由按钮翻）：
  ① `handleHeartbeat` 在 `stopped` 那一支原本不看 `autoReconnect`，所以「停止连接」
  只维持到下一个心跳（≤5 秒）就被自动接了回去；② 一轮连接**正在跑**时按「停止连接」，
  它照样会把连接建起来——现在等待结束后与客户端建好后各有一道 `userAskedToStop()` 检查，
  后者会把刚建好的客户端收掉（连上之后连接条就消失了，用户没有反悔的入口）；
- 真失败（守护进程起不来、会合文件缺地址/令牌）照旧如实报错，只是文案由
  `@serverStartTimeout` 换成 `@serverNotReady`（词典中英两套 + `l10n/bundle.l10n.zh-cn.json`）；
- **外部服务器统一到同一条口径**：`ensure()` 里原本 `waitForHttp(url, 5_000)`，5 秒探不通
  就报 `@serverUnreachable` 并抛错、由心跳重试。现在同样一轮轮探测**到底**（连上，或用户
  点「停止连接」）。单次探测自己的 2 秒 fetch 超时保留（那是"这一次探测等多久"）；
  第一次探不通时把 `@serverUnreachable` 摆在连接条上（controller 把带 `@` 的 `starting`
  详情透给界面），文案改成"连不上 `<url>`（会一直重试，可点「停止连接」）"，
  免得用户对着一个转圈的空条猜。

**验证**：`npm run typecheck` 两套 tsconfig 通过、`npm test` 47/47 套断言通过
（`scripts/supervisorPolicy.test.ts` 新增第 5 组：等待期间状态仍是 `starting`、期间一次
spawn 都没有、`cancelWaiting()` 后 **0ms** 就以 `WaitCancelledError` 结束；第 6 组：外部地址
没人应答时同样一直等、详情是 `@serverUnreachable:<url>`、叫停同样立刻生效）、
`npm run build` 无 `[duplicate-case]` 警告、`node build/command-e2e.mjs`（真实 dsh）全绿。

## 0.7.0（2026-09-14）

这一版的主力是**后台生命周期**：dsh 改由独立守护进程持有（重载窗口不再打断后台、关窗不再
留下后台、崩溃遗留的后台能被新窗口接管），并定下「关掉自动启动就不许自动拉起」的口径；
另有一批问卷分页、历史加载与工作区分组的对齐。

### 关掉自动启动后不再"无脑重连"，多窗口共用会合文件里的令牌（2026-09-14，用户口径）

**问题一：关掉 `dshChat.autoStart` 之后扩展还是会自己拉起后台。** 激活期的自动连接、
窗口恢复会话、5 秒一次的心跳自检都会走 `ensure()`，而它对"后台不存在"的处理是
**直接起一套**——用户把自动启动关掉正是为了不被这样对待。现在：

- `autoStart` 只管**自动**路径；用户显式动作（发消息、新建/切换会话、「启动服务器」、
  「重启服务器」）不受它约束——用户要后台的时候不该被配置挡住；
- 关掉之后扩展激活时**先判断后台在不在跑**：在跑就自动接上，并**一轮一轮重试到成功**
  （去掉了重连的总超时，单次尝试当时仍受 `startTimeoutSec` 约束——该配置项与那一档
  "到点就报超时"的判定已在下面「删掉 `dshChat.startTimeoutSec`」里一并删除）；没在跑就只显示
  **「启动服务器」**按钮，一个进程都不会起；
- 连接条按状态给按钮：没启动 → 「启动服务器」；连接中 → 「停止连接」；连不上 →
  原因 + 「尝试重连」/「重启服务器」/「查看日志」（输出通道「DSH Chat」，以前那个
  按钮点了等于没点）。「停止连接」**不碰后台**，只停本窗口的重试循环；
- 外部服务器（`dshChat.url`）不判进程，只做重连尝试。

**问题二：内部启动后"拿不到 token、连不上"。** 会合文件（`supervisor.json`）里
一直有 supervisor 写下的 `token`，但 controller 是按 `info.owned`（**是不是本窗口
拉起的**）分叉认证链的：只有启动者会用它，其余窗口（第二个窗口、窗口重载后接上的
同一个后台）被当成"外部服务器"，于是弹「输入令牌」——而用户手里根本没有那个令牌。
现在按 `external` 分叉：`self` 与 `peer` 都走"令牌换 cookie"；令牌被拒时重读一次
会合文件再试（守护进程可能刚好重起了 dsh）；内部模式不再出现「输入令牌」入口。

**顺带修掉的两处**：

- 守护进程还活着时**只接入、不再另起一套**（此前"地址不可达 → 抢锁 → 再 spawn 一个
  supervisor"；Windows 上管道被占用，第二个必然 `listen` 失败自杀，白付一次 spawn，
  而原守护进程因为没人连着会在空闲阈值后收场）；
- 「查看日志」按钮以前只往日志里写一行空行，现在真的把输出通道调出来。

**验证**：`scripts/supervisorPolicy.test.ts`（离线：没有许可时启动器调用次数必须是 0、
有许可才拉起、守护进程活着时不重复拉起、令牌来自会合文件）、
`node build/auth-chain-probe.mjs`（真实 dsh：启动者与接入者各走一遍真实认证链）、
`scripts/styles.test.ts` 第 16 组（连接条按钮在窄侧栏不被裁切）、
`test/preview.html?conn=…&running=1&locale=en`（六种状态的按钮组合肉眼可核）。

**顺带修好两个跑不起来的端到端探针**（`npm run smoke`、`node build/command-e2e.mjs`）：
它们的启动命令写的是裸露的 `dsh`，而这一版 dsh 需要子命令（`error: --profile <name> is
required`），于是 supervisor 每秒重起一次 dsh、两分钟后只报"启动超时"，真正的原因
压在命令字符串里；同时两者都没有隔离会合目录，会往用户真实的 `~/.dsh-chat/supervisors`
里起后台、留下 MB 级日志。现在命令统一成 `dsh web --port 0 --no-open`、会合目录走
`supervisorProbeEnv` 的临时目录（与其余探针一致），两个探针都能无头跑通。

### 后台改由独立守护进程托管（2026-09-13，用户口径）

**为什么要换**：dsh 的生死原先挂在"扩展宿主"上，而 VS Code 打开文件夹、装扩展、改服务器
配置**都会重载窗口**；旧实例退出时按"还有没有别的活窗口"决定杀不杀，而接替它的新实例
那时还没出生、**投不了票** —— 于是每次重载后台都必死、每次都要 5~8 秒冷启，
并演变出"关窗杀不掉""残留不被接管""幽灵启动租约让新窗口干等 90 秒"一整串竞态。
这不是某个 bug，是"多方协商"模型的死角。

现在：**dsh 由一个独立于 VS Code 的守护进程（supervisor）持有**，扩展只做客户端。

- **重载窗口不再打断后台**：打开文件夹 / 装扩展 / 手动重载之后，dsh 的 pid 与端口
  一个字都不变（`supervisorReloadProbe` 钉住）。
- **没人用就自己退场**：所有窗口都关掉（或崩溃）之后，守护进程等
  `dshChat.supervisorIdleSec`（新增配置项，默认 10 秒、可配 5~600）再把 dsh 关掉并退出，
  不留孤儿、不留僵尸。这一档必须放得下"重载窗口 2~5 秒的空档"，所以下限取 5 秒。
- **多窗口照样共用一个后台**：谁先用谁拉起守护进程，其余窗口接入同一套；
  "还有几个窗口在用"由守护进程数**活连接**得出（不再靠窗口之间互相投票）。
- **扩展退出时什么都不杀**：只关自己的连接。杀 dsh 永远是守护进程的事——
  今天所有麻烦都源于"扩展也在杀 dsh"。
- **用户仍能掌控**：新增命令「DSH: 停止服务器」（请守护进程连 dsh 一起收场并退出）；
  「重启服务器」改成向守护进程发请求，由它重起 dsh。
- **不要求用户装 Node**：守护进程用 **VS Code 自带的 Node** 跑（`ELECTRON_RUN_AS_NODE`），
  产物随扩展分发（`dist/supervisor.js`）。dsh 是社区生态、发行形态很多，
  "机器上有 node"不是可以依赖的前提。
- 传输：**高频信号与控制走 AF_UNIX 长连接**（Windows 上是命名管道），
  文件只放"跨世代会合信息"（`supervisor.json`：地址 / 令牌 / 守护进程 pid），
  两者分工见 `docs/design-supervisor.md`。
- **旧实现退役**：`src/dsh/serverManager.ts`（会合租约 + 心跳判活那套）已删除，
  换成 `supervisorManager.ts`（客户端形态）+ `supervisorProtocol/Client/Wire/Runner`。
  保留下来的是踩出来的资产：公告行是地址与令牌的唯一真相、按端口兜底杀整棵树、
  异步进程查询、崩溃遗留 writer 锁清理、清理/诊断命令。

**验证**（全部可无头重跑，不需要启动 VS Code）：

| 探针 / 断言 | 覆盖 |
|---|---|
| `node build/supervisor-reload-probe.mjs` | 强杀窗口 → 隔 3 秒新窗口接上，**dsh pid 不变** |
| `node build/supervisor-idle-probe.mjs` | 阈值内照旧活着；过阈值后端口、会合文件、守护进程三者全清 |
| `node build/supervisor-scenarios-probe.mjs` | 3 窗口并发（启动者=1）、关掉两个不影响第三个、`stop` 干净退场、强杀守护进程后孤儿被回收 |
| `node build/supervisor-manager-probe.mjs` | 扩展真正用的管理器：拉起 / 接入 / 活连接数 / 重启（令牌换新）/ 停止 |
| `scripts/supervisorProtocol.test.ts` | 会合文件原子读写与宽容解析、启动锁独占、阈值收敛、运行时解析 |

### 关窗不再留下后台（2026-09-13，用户实测报回的三条）

- **关窗时会带走后台**——这是「退出后后台 dsh 还在、再启动连不上」的根因修复。
  VS Code 关窗 / 重载窗口时**先关掉扩展的输出通道**，扩展随后才停用；而
  `ServerManager.release()`（唯一负责"关窗杀后台"的地方）的**第一条语句就是写日志**，
  那句 `appendLine` 在真实关窗现场抛 `Error: Channel has been closed`（exthost.log
  里能查到 `An error occurred when disposing the subscriptions for extension
  'Lin515.dsh-chat'`），**下面杀进程的代码根本执行不到**——后台就这么留下来了。
  日志写入现在抽到 `src/dsh/hostLog.ts`：写入失败一律吞掉、失败期间的消息先攒着，
  等通道回来再补写，**任何生命周期阶段都不允许抛异常**。
  离线断言 `scripts/hostLog.test.ts`，端到端 `node build/closed-channel-probe.mjs`
  （带 `--control` 的对照模式证明这条探针抓得住缺陷）。
- **为什么"清理命令有用、重启却连不上"**：残留的后台一直占着租约里的端口。
  配置写死端口（如 `dshChat.command` = `dsh web --port 20000 --no-open`）时，
  新后台 `EADDRINUSE` 起不来，扩展只能报「无法连接 DSH 服务器」；
  手动清理杀掉残留之后自然就正常了。用的是默认 `--port 0` 时症状更隐蔽：
  残留后台不挡新端口，但会一直占着内存与 `$DSH_HOME` 的文件锁。
- **右下角「扩展在磁盘上已被修改，请重新加载窗口」是 VS Code 自己的提示**，
  与连接失败没有因果关系：它出现在**窗口开着的时候重装/覆盖了扩展目录**
  （`renderer.log` 里的 `Installation has been modified on disk`）。
  从 vsix 重装一次就会有；重载之后不再出现。

### 残留的后台会被接管（2026-09-13，同一轮用户实测）

- **没能正常关闭时留下的后台，下一次激活直接接管**（用户口径：能接管就接管）。
  此前"接管决策"要**先证明**写心跳的那个实例已经不在了，而这条证明依赖进程表查询；
  一旦心跳文件丢失（写盘失败 / 被清理）或 pid 复用让查询给出"还活着"的结论，
  判据就把残留当成"有人在用"而跳过它 —— 于是新窗口去起一个新的，
  固定端口下正好撞上残留占着的端口，`EADDRINUSE` 起不来，
  界面只能说「无法连接 DSH 服务器」，而清理命令一跑又好了。
  现在三处补齐：
  - `findServingLeftoverLease()`：**只剩租约**（心跳没了）也能接回去 —— 租约里同样有
    地址与令牌，且没有别的活窗口在用；
  - `findAdoptCandidates()`：首选判据之外再放宽一层，把"记过地址/令牌、命令一致"的
    记录全部作为候选，由**实测 HTTP** 决定接不接（能连上就接管）；
  - 心跳里新增 `ownerStartedAt`（写心跳那个进程的启动时刻）：pid 被回收后
  "启动时刻晚于心跳写入时刻"即可判定原进程已不在，不再被 pid 复用骗过。
  接管的代价只是多挂一个客户端，多起一个后台的代价却是端口冲突 + 会话全丢。
  探针 `node build/orphan-diagnose.mjs --repro [--no-heartbeat|--pid-reused|--delay N]`
  （`--no-heartbeat` 那条在修复前会复现"没有接管、另起一个"），
  现场只读诊断 `node build/lease-state.mjs`。

### 窗口状态跟着工作区走（2026-09-16）

- **重开工作区时，各对话窗口回到各自的会话**：上次关掉工作区时开着的窗口
  （主侧栏 / 辅助侧栏 / 编辑区的对话面板），下次打开这个文件夹时各自接回原来的会话——
  就是 VS Code 记得这个文件夹开过哪些文件的那种效果。没有缓存的工作区一切照旧。
- **存放位置是 VS Code 自己的工作区缓存**（`ExtensionContext.workspaceState`，落在
  `%APPDATA%\Code\User\workspaceStorage\<hash>\state.vscdb`）：**不往项目目录写任何文件**，
  也不进全局存储——换项目不该把上一个项目的窗口带过去。实现见 `src/dsh/windowState.ts`。
- **编辑区面板交给 VS Code 自己恢复**：注册 `WebviewPanelSerializer` 接管面板的
  「重新认识」（此前 VS Code 恢复了面板，但我们不认识它 = 一块白板），再按当初的顺序
  把每个面板接回它原来的会话。为了这次恢复能在扩展刚被激活时就接住，`package.json`
  补了 `onWebviewPanel:dshChat.panel` 激活事件。
- **窗口的「最近活动」顺序也记下来了**：重开之后命令面板入口（新建 / 历史 / 停止 /
  加选区）仍然落在原来那个窗口上。
- 两个刻意的取舍：
  - 恢复的结束判据是**槽位都问过话**，不是某个超时——VS Code 是「面板第一次变为可见」
    时才回调序列化器的，用户没点到的标签页可能很久之后才来认领；在那之前不按内存里的
    窗口覆写缓存，否则还没露面的面板会被抹掉。
  - 缓存里的会话**已经不存在**（被删 / 被归档）时，窗口保持空态，而不是硬接一个死会话。
- 缓存的两个坑按 `shared/wire.ts` 的同一口径处理：Memento 是 JSON 过的，`undefined`
  值的键会被整条丢掉，所以「这个窗口当时是空态」显式写 `null`；缓存是磁盘上的旧数据，
  形状坏的**逐条丢弃**而不是整份丢（一条坏记录不该让另外两个窗口也恢复不了）。
  回归断言见 `scripts/windowState.test.ts`。

### 用户报的一批（2026-09-14）

- **问卷题多时改成依次问答**：题目数**超过** `dshChat.questionBatch`（整数 ≥0，
  默认 3，`0` = 始终一次展开）时，卡片改成一次一道，带「第 N / M 题」与上一题 /
  下一题；单选题点一下就前进（官方 `choose` 对非多选项就是 `index + 1`），最后一题
  的按钮就是提交。**不超过阈值时保持原样一次全展开**——短问卷一次看完更省事，这是
  用户拍板的口径（官方 `QuestionComposer` 是**恒分页**的，我们刻意不照抄）。
  配置项改完即时生效，不必重载窗口。
- **答完的问卷默认收缩**：答过之后整张卡收成过程行里的一行（读作「问题 · 已作答 N 题」），
  点行头可再展开复看当时的问题与选项，再点收起。此前它会一直占着对话流。
- **`@` 列表支持返回上一层目录**：下钻到 `@src/webview/` 之后列表**顶部**多出 `..`
  一行（右侧小字写着回到哪一层），点它／回车就回到上一层，键盘上下也能选中它；
  到工作区根目录时这一行不再出现（没有上一层）。纯文本输入框往回删路径段太别扭，
  这是用户提的入口。
- **滚到顶自动加载更早的历史**：跟随窗口只带 60 条，此前只能靠「加载更早的消息」
  按钮（用户得先意识到上面还有东西、再准确点到它）。现在滚到距顶 64px 以内就自动取
  一页；**一次只飞一页**（在飞的闸门 + 8 秒兜底），并且更早的消息插进 DOM 之后会把
  `scrollTop` 补回同样的高度差——视口里停的还是原来那几行，不会「一加载就被推下去」。
  手动按钮保留，兼作「正在加载」的指示。
- **编辑器右键加进来的部分引用没有行号**：现在选区会带行号（1 基、闭区间），芯片上
  显示成 `src/config.ts:12-40`（那一段**不可压缩**，文件名可以先省略），发给模型的
  正文里也写明「来自 X 第 12-40 行的选中代码」。边界按 VS Code 的实测形状处理：选区在
  **下一行行首**结束（Shift+↓ 选整行）时那一行并没有被选中，不能多报一行。
- **加完引用后焦点被硬拽到侧栏**：编辑器右键入口此前写死 `dshChat.view.focus`，对话
  开在编辑区面板或辅助侧栏时，加完引用视线被拉回主侧栏。现在每个窗口在挂载时注册
  自己的「带到前台」动作（侧栏视图 `show()` / 编辑区面板 `reveal()`），命令把焦点还给
  **最近活动的那个窗口**（也就是引用落进去的那个窗口）。
- **目标条没被截断也显示展开按钮**：正文一行放得下时那个按钮点了什么都不会变、只会把
  整条撑成两行。现在按 `Range` 量出的自然宽度判断是否真的被截断，只有截断过（或已经
  展开）才出现。
- **轮尾「本轮改动」里冒出已被删除的 `commit.msg.txt`**：让模型提交时它常把提交信息
  写进这个临时文件、提交完再删掉。它进过 `write` 调用，于是永远留在 `produced` 里；
  磁盘上已经没有了，宿主按存在性判成「已删除」，界面上就出现一条带删除线的芯片——看着
  像仓库里挂着一个待提交的删除。现在宿主多判一档 `gone`（磁盘上没有 **且** git 的四张
  清单里都没有它 = 这一轮的净效果为零），界面据此**整条不渲染**；git 有记录的删除
  （跟踪中的删除）照旧显示，那是仓库里真实的待提交改动。
- **会话在 DSH Web 上全部「未分组」**：DSH Web 的分组不是按 cwd 推出来的，而是一张
  **持久工作区注册表**——只有 `session/create` 带 `workspaceId` 时服务端才会
  `attachSession`，只给 `cwd` 建出来的会话在 Web 端永远是未分组（`dsh-api-session-controller`
  的 `create`：`accepts workspaceId or cwd, not both`）。扩展此前只给 cwd，所以从没把
  会话记进工作区。现在连接后先幂等注册/取回工作区 id（`workspace/create`，路径经
  realpath 归一），再按它建会话；注册失败或 id 失效时退回按 cwd 建（一次重试），
  不让「新建会话」整体失败。端到端证据见 `scripts/workspaceProbe.ts`（临时 `DSH_HOME`
  起真实服务器：按 workspaceId 建的会话进 `sessionIds`，按 cwd 建的不进）。
  **注意**：此前已经建好的会话不会追溯分组（服务端没有「事后 attach」的 RPC），
  新会话才会。
- **访问令牌的说明说错了**：输入框里此前写「验证通过后本扩展会记住会话」，实际存的是
  用它换来的**会话 cookie**。文案改成「本扩展会把手里的 token 换成会话 cookie 存下来，
  之后不必再次验证」（中英双语同步改）。
- **扩展说明改中文**：`package.json` 的 `description` 改成 `%description%`，英文源串进
  `package.nls.json`、中文进 `package.nls.zh-cn.json`——VS Code 的清单本地化对
  `description` 同样生效（`localizeManifest` 对清单里所有 `%key%` 取值），所以中文界面
  显示中文说明、英文界面仍是英文，不必二选一。
- **tps 的两个数不是一回事（用户提问）**：工具栏上直接显示的 tps 取**最近一条助手消息**
  的解码窗口（逐 token 变化、波动大），悬停明细里的是**全会话累计**（Σ 输出 token ÷
  Σ 解码窗口），点「用时 X」看到的又是**本轮累加**（官方 `deriveStats`）。三个口径都对，
  但界面没说清。现在悬停明细加了标题「会话统计（全日志累计）」，那一行也改读
  「平均输出速度（TPS）」。

### markdown 脚注（官方 `markdown.footnotes`）

- **补上脚注**：`[^label]` 引用渲染成上标数字（编号按**首次引用**顺序，重复引用同一个
  编号），`[^label]: 定义` 收进文末的 `section.footnotes`（结构逐字对齐官方渲染器：
  `h2.sr-only` 标题 + `ol > li#user-content-fn-*` + `↩` 回跳）。marked 本身**不带**脚注
  语法，所以补的是自家的 marked 扩展（`src/webview/footnotes.ts`），**不引入新依赖**；
  定义是 block 级 token，所以围栏代码块与行内代码里的 `[^x]` 原样保留。
  净化白名单同步放行 `section` / `sup` / `id` / `data-footnotes`——漏掉就是「静默剥成
  一堆裸文本」，这一条在真实浏览器里验过（`npm run preview` 的夹具带了一段脚注）。
  标题走词典（`markdownFootnotes`，官方同名的 `markdown.footnotes` 键）。
- 至此 `docs/audit-summary.md` 记的三项 markdown 缺口只剩公式与代码高亮两项
  （都需引入第三方依赖，仍是知情取舍）。

### 开发侧（本批）

- 断言 35 → 41 套：新增 `footnotes`（用真 marked + 真扩展解析，断产出结构、编号顺序、
  代码块不受影响）、`questionFlow`（阈值语义含 `0` 与坏值、作答判据、提交闸门）、
  `mentionNav`（上一层是谁）、`selection`（行号边界：下一行行首不多报一行）、
  `historyReplay`（重放静默 + 更早一轮落盘即折叠态 + 取到轮次边界为止）、
  `renderOrder`（活路径「边说边吐工具调用」时思考/正文必须排在工具行之前）。
- 新增探针 `scripts/workspaceProbe.ts`（工作区分组的端到端证据，含「只给 cwd 就不分组」
  的反证）、`scripts/renderOrderProbe.ts`（真实会话日志的事件序 vs 段序）、
  `scripts/liveOrderProbe.ts`（`--live`：真跑一轮看帧到达顺序与最终段序）。
- 会话日志解码抽成 `scripts/sessionLog.ts`（`sessionLogScan.ts` 既是库又是 CLI，
  被 import 时会把它的扫描输出一起跑出来）。
- 预览夹具补了四块真实形态的样本：脚注段落、**已答完**的问卷、`questionBatch` 字段，
  以及一条带行号的选区附件。

### 用户报的一批（2026-09-14·续）

- **候选列表不跟随上下键滚动**：`/` 与 `@` 的候选弹层是 `max-height: 330px` 可滚动的，
  候选多于一屏时键盘上下键只改高亮、不滚列表——选中项跑到视野外，看着像「按键没反应」，
  回车却选中了一个看不见的条目。现在键盘导航会把选中行滚进视野（回到第一行时滚到最顶，
  顺带把「命令 / 文件」那行分组标题露出来）；**鼠标悬停不滚**（那会把指针底下的内容
  挪走），两条路径用 `keyboardNavRef` 区分。
- **自动加载更早的历史会把旧轮次「实时渲染」一遍**：`prependRecords` 重折历史时，
  适配器把中间态**一帧一帧**发给界面（每条的 `message/append`、每轮开头那个
  `running: true`），于是新加载进来的旧轮次先被画成「运行中 / 展开」的样子，过一会儿
  才收成折叠态；几十上百帧还会让视口锚定漂移。现在**重放期间不发帧**，界面只收到
  「hasMoreHistory 变了」+ 一整份 `messages/reset`，旧轮次**一出现就是折叠好的最终态**
  （断言：`scripts/historyReplay.test.ts` 数帧数与折叠结果）。
- **自动加载没取到上一条用户消息就停了**（用户 2026-09-14 报的，第二轮澄清）：规则
  本身（**取到一轮的开头**、顶部变成用户消息就停）没问题，坏在「这一页有没有进展」的
  判据上——当时拿「首条消息 id 变没变」当判据，而更早的事件往往只是把现有的第一条
  助手消息**补长**（它的 id 是按轮次派生的 `a:<turn>`，不会变），于是第一页明明并入了
  250 条事件，却被判成「没进展」而在半轮中间收手。
  现在：**连取由宿主驱动**（界面只发一次 `loadMore`），停止条件三条——**取到一轮的开头**
  （顶部是用户消息）/ 服务端说没有更早的 / **这一页没带来新事件**（用适配器返回的
  **真实新增事件数**，不再猜）。界面只剩两件事：每落一页按**高度差**把视口钉回原处、
  按钮读宿主发的加载态。
  证据：`scripts/pageLoopProbe.ts` 拿真实长会话逐页推演（修复前第 1 页就停，修复后
  连续取到 `u:14` 这一条用户消息才停、`hasMore=false`），`scripts/historyReplay.test.ts`
  钉住三条停止条件与「零进展」防线。
- **取的过程中按钮自己说明状态**：「加载更早的消息」在整条连取链期间是不可点的
  **「正在加载更早消息…」**，取完恢复。加载态由**宿主**发（`historyLoading` 帧，
  顺序为 `true` → 内容帧 → `false`），宿主侧另有一道并发闸门（滚动事件一秒几十个，
  而帧要一个来回才到界面）。
- **上下文注入也折进「轮级过程」按钮**（用户 2026-09-14 对照 Web 报的）：官方
  `TURN_PROCESS_INDEPENDENT_KINDS` 只有 system-prompt / user / steering / turn-process /
  turn-error / turn-max-tokens / turn-tail —— **没有 context 一类**，所以插件注入、
  项目指令、技能目录、运行时上下文都是过程里的普通节点、照常折叠；我们此前把整类
  `injected` 都豁免了（那是读错口径）。**系统提示词那一条仍然豁免**（官方
  `system-prompt`），中止/截断提示同样照旧豁免。
- **上下文注入节点的标题对齐官方词汇**：官方 `ContextInjectionRow` 的标题只有两种——
  「上下文注入」（`message.contextInjection`）与跨会话召回的「跨会话召回」
  （`message.contextRecall`），系统提示词那条叫「系统提示词」（`message.systemPrompt`）。
  我们此前按来源各起名字（「插件上下文」等），用户要求与 Web 一致，现在标题统一，
  具体来源（项目指令 / 技能目录 / 运行时上下文 / 插件名）退到副标题——**标题一致、
  信息不减**。
- **连续工具调用里，思考/正文与工具行错位**（用户 2026-09-14 报的）：DSH Web 上是
  「思考 → 4 次编辑 → 正文 → 编辑…」，本扩展却把工具行排到了那段思考/正文**前面**。
  根因在**活路径**：模型是边说边吐工具调用的，`tool-call-delta` 流式帧会**先**把工具行
  建出来（`upsertToolCall`），该 step 的 durable `assistant/message`（思考/正文）随后才到，
  而适配器当时是**追加到末尾**——于是思考/正文排到了自己那个 step 的工具行后面。
  离线重放（跟随开窗 / `session/page`）的顺序本来就是对的，所以此前所有断言都没抓到它。
  现在 durable 的思考/正文插在**本 step 最早的工具行之前**（官方按内容块顺序渲染，
  工具调用在内容里永远排在思考/正文之后）。证据三件套：
  - `scripts/renderOrderProbe.ts`：对着**真实会话日志**把事件序与适配器段序并排打出来
    （离线路径本来就对，用它先排除「服务端就是这么发的」）；
  - `scripts/liveOrderProbe.ts`：对着**真实服务器**跑一轮，打印帧到达顺序并断言
    「同一个 step 里没有工具行排在思考/正文之前」——实测 `live-tool@23` 早于
    `assistant/message@25`，这正是错位的来源；
  - `scripts/renderOrder.test.ts`：用真实帧形状复现（**修复前失败、修复后通过**）。
- 记录一条**刻意保留的口径差异**：轮尾文件行的 `+N −M`，官方 Web 按**编辑块**统计
  （块内没真正变化的行也算进去），本扩展按**最终结果**统计（只算真正变化的行）。
  用户 2026-09-14 确认本扩展的口径更贴近直觉，**保持不动**——不要为了「跟 Web 一致」而改
  （已记进 `docs/audit-summary.md` 的刻意偏离清单）。

- **底部工具栏按「实测宽度 + 优先级」自适应**：宽度不再靠写死的像素阈值猜，而是把每个
  候选档位渲染进一个不可见的测量层量出实际宽度，再按优先级取**前缀**（装不下高档时，
  排在它后面的低档这一帧一律不显示，避免「附件显示了、优先级更高的思考强度却没有」，
  也避免拖宽侧栏时元素此起彼伏）。优先级（用户口径）：权限按钮 / 模型切换 / 发送**始终
  显示**；其次思考强度（模型右侧，点它开/关同一个模型弹层）、附件、tps、上下文占用环；最宽裕时
  才把权限名写进权限胶囊、并在占用环右侧补 `44K/128K` 的精确数值（两个数各自按量级挑
  单位，1M 的窗口就写 `1.0M` 而不是 `1000K`）。换语言（英文 "Workspace Write" 比「工作区写入」宽 16px）、换模型、调字号
  都会自动跟上——实测同样内容中文 390px 出权限名、英文要 410px。上下文占用环内不再写
  百分比（百分比与构成仍在悬停明细里）。极窄（<190px）连 P0 都排不下时，由 CSS 收窄
  模型名出省略号，不硬裁。
- **纯新增文件不标 `[新增]`**：git 扩展把未跟踪文件放哪张清单**取决于 `git.untrackedChanges`**
  ——只有设成 `"separate"` 才进 `untrackedChanges`，**默认的 `"mixed"` 是塞进工作区清单**，
  而判定只查了前者，于是默认配置下那条分支永远不成立（`git.untrackedChanges` 出厂值就是
  `"mixed"`，`package.json` 实测）。现在两种配置都认：工作区清单里 `status === UNTRACKED`(7)
  的条目同样判为新文件，判 `new` 也提到判 `edited` 之前（否则先被「在工作区清单里」截胡）。
  `IGNORED`(8) 的忽略文件**不**跟着标（它在版本库里从来不存在，不是本轮新建），`git add`
  过 / `add -N` 的新文件也仍是改动（点下去确实开得出对比窗口，标 `[新增]` 就自相矛盾）。
  点击行为不变：未跟踪文件在默认配置下本来就会被 git 解析成打开文件本身（左侧为空，没有
  可比基线），宿主不必为记号单开分支。唯一标不出来的是 `git.untrackedChanges: "hidden"`
  ——那时 git 压根不上报未跟踪文件，要认这个只能绕过 git 扩展自己问 git，不值当。

## 0.6.0（2026-09-13）

这一版对齐了官方 Web 端的会话内容绘制（工具行三件套、轮级过程折叠、审批 / 提问卡接管输入区、
markdown 软换行…），并修掉一批文件芯片与拖放上传的显示缺陷。

### 会话内容绘制对齐 DSH Web、文件芯片与附件的一批修复（2026-09-13）

- **第一次点文件芯片只看得到完整文件、看不到 diff**：git 扩展按文件系统事件去抖
  刷新，模型刚写完的文件还没进改动清单，于是第一次点被判定成「没改动」、回落成
  普通打开，点第二次才是 diff。现在**轮次结束**（文件都落盘了）时主动推一次
  `repository.status()` 重扫，并且轮尾两行文件等这一轮生成完才出现；用户几秒后
  再点，第一次就是 diff。刷新只发生在轮次结束，**不在点击链路里等**——点击时轮询
  那个方案此前已被否决（真没改动的点击每次白等 1.2s）。
- **轮尾「本轮文件改动」在生成期间就显示**：官方把这两行挂在 turn-tail 节点上，
  `publication` 只在 `turn/end` 时发布，轮次进行中数据在攒但行不画。现在一致了。
- **两个文件行重复的问题**：查过官方实现，`produced`（成功的 write/edit 推导）与
  `deliverables`（`present` 申报）是**互补**的两条来源，官方两行并存、互不抑制也
  互不去重（bash 生成的文件只进交付行，未申报的改动只进改动行），所以**保留两行**。
- **拖放文件现在真的能加附件了**：此前拖进输入框只有高亮、松手什么都不发生。
  webview 只能拿到字节（VS Code 不给 webview 拖拽资源的路径，`File.path` 自
  Electron 32 起已移除），所以走 base64 字节上传，单文件 8 MB 上限；超限、目录、
  读不出的项都**逐个明确提示**。**从资源管理器拖要先按住 `Shift`**（webview 是
  iframe，拖拽期间被 VS Code 挡住事件），已写进 README 的已知限制。
- **上传失败只说「上传失败」**：服务端/宿主给的真实原因（`upload.message`）此前
  从不渲染。现在失败芯片的悬停里给出真正的原因和「点击重试」。
- **重载或开第二个窗口后，芯片上的 `[新增]` / 删除线全没了**：那张记号表只有
  patch 一条路径，而 patch 侧有「没变化不重发」的去重——重算出的表与缓存相同就
  永远不发。现在表随首帧快照一起下发。
- **文件被误判成「已删除」**：判据此前把 `stat` 的**任何**异常都当「文件不存在」，
  权限不足、离线共享盘、路径含非法字符都会给无辜文件画删除线、点击还弹
  「内容找不回来了」。现在只认明确报「找不到」的错误（本机 VS Code 实测
  `FileSystemError` 的 `code` 是 `FileNotFound` 这类**方法名**，不是
  `FileSystemError.FileNotFound`），其余一律按「不确定」不标记号。
- **点了完全没反应的两处**：相对路径但拿不到会话工作目录时只写日志；按住修饰键
  点已删除的芯片会静默失败。现在两处都有明确提示（后者退化成先试改动对比）。
- **已删除芯片的悬停文案说假话**：被跟踪的文件删除后仍在工作区改动清单里，点开
  对比窗口就能看到删除前的内容，所以悬停改成「文件已从磁盘删除；点击尝试查看删除
  前的内容」，「内容找不回来了」只在真正找不回时（toast）出现。
- 开发侧：`fileChangeKind` 的存在性参数改成三态（`present`/`absent`/`unknown`），
  断言覆盖「查不出来 ≠ 已删除」；新增拖放字节归类的断言与夹具里的「运行中一轮」；
  `scripts/fileChange.test.ts` 修正了一条与实际语义矛盾的断言提示语（被跟踪的删除
  是**会**进 `git.openChange` 那条分支的）。
- **对齐官方：待处理的审批 / 提问卡接管输入区**（官方把两者注册进 `conversation.composer`
  槽、按 `pendingInteraction` 选举）：待处理时卡片出现在**输入框上方**（与目标条同一条
  dock 带），永远在视野里，界面看起来就是「在等你回答」——此前作为一段画在对话流里，
  滚上去就看不见了。选举口径沿官方：**提问优先于审批**（官方注册优先级 1 / 2 对 0），
  同优先级取最后一条。**已经答过的卡仍留在对话流里当记录**，两边不重复也不丢。
  （当时分不出 plan-review 提问——线格式里没有这个标记，所以只实现了「提问 > 审批」；
  2026-09-17 起按题目上的 `intent.kind` 分辨得出，优先级补成「计划审阅 > 提问 > 审批」，
  见本文件顶部「渲染 `exit_plan_mode` 请求」。）
- **对齐官方：上下文条目按 form 分派正文**（官方 `ContextBody` 的 `switch (form)`）：
  之前只留了 `{来源, 插件, form}` 与正文，`source` 里的结构化字段**整个丢掉**，
  界面上只有一段文字、看不出「这轮的指令是新增的还是移除的」。现在按官方谓词逐条解析
  （`shared/injectedSource.ts`）并各自渲染：
  - `instructions` → 逐条「已新增 / 已更新 / 已移除 + 文件路径」；
  - `catalog` → 条目列表（名字 + 说明），超过官方的 200 条上限时给「…还有 N 条」；
  - `snapshot` → 「取代先前的快照」+ 各分节；
  - `relay` → 「来自会话 X」；
  - `recall` → 「保留 N 条 · 省略 M 条」（+「已截断」）。
  形状判据是**全有或全无**（官方同为该口径）：任何一条缺字段就整项退回「正文 + 原样字段」，
  绝不显示半截列表。
- **对齐官方：markdown 软换行**（`breaks: false`，CommonMark 口径）：正文里**单个换行**
  按空格处理，只有硬换行（行尾两个空格或反斜杠）才断行。此前是 `breaks: true`（每个
  单换行 → `<br>`），那是本扩展自己的选择——**这是可见的行为改变**：模型输出里不带
  markdown 标记的短行会被并成一段。空行分段不受影响。
- **知情不做：markdown 的公式与代码高亮**（用户 2026-09-14 决定暂不引入依赖）。
  官方这两项靠 KaTeX 与 Shiki，都要新增第三方依赖并同步 `THIRD-PARTY-NOTICES.md`；
  本版本的表现为：公式按纯文本显示、代码块不着色。脚注同样未做（无需新依赖，
  但要改渲染链）。取舍记在 `docs/audit-summary.md` 的「仍未修复」里，是决定不是遗漏。
- **认不出的内容块不再静默丢弃**（官方渲染链的 default 分支）：留一条「未知内容块」记录
  （标签与官方 `message.unknownBlock` 逐字），detail 是块类型、展开是内容 JSON（超长截断）。
  此前适配器只认 text/reasoning/image，其余块整块消失——**`file` 块就在其中**（官方同样
  没给它专属分支，走的也是这条默认路径，所以这条同时补掉了审计表里的 V6）。
  `tool-call` / `tool-result` 仍**故意**不在这里渲染（它们各有自己的事件、已经折成工具行）。
- **对齐官方：工具行三件套**
  - **IN/OUT 分区**：非 diff 工具的展开体分成「输入 / 输出」两段（官方 `ioCard` 的
    `row.input` / `row.output`），输入是**缩进后的参数 JSON**（官方给的是解析后的
    卡片体）——此前我们**刻意不渲染原始参数**，现在按官方口径补上。
    官方对 diff 类工具直接给 DiffBlock、不套 IN/OUT，所以这里也只在**没有 diff** 时
    分段，避免同一份改动既在输入里露参数、又在下面出 diff。
  - **折叠行右侧的 `+N -M`**（官方 `diffStat` / `diffTotals`）：由 diff hunk 累加而来，
    绿加红减，一眼看出改动量。
  - **路径可点**（官方把摘要做成 `fileLink`）：工具行里的文件路径点一下就预览该文件。
    行内用 `role="link"` + `tabIndex` 而不是嵌套 `<button>`（行头本身已经是按钮），
    点击 `stopPropagation` 免得顺手把行展开；命令行类的 detail 不挂链接（点了会去
    打开一个不存在的文件）。
- **代码块改为自动换行**（官方 `pre { white-space: pre-wrap; word-break: break-all }`）：
  此前是横向滚动，窄侧栏里读一个长行要一路拖到底。
- **对齐官方：轮级过程折叠**（官方默认的 compact 转写模式，`DEFAULT_TRANSCRIPT_VIEW_MODE
  = "compact"`）：一轮**结束后**，答案步之前的一切折成一枚按钮，读作「N 次工具调用 ·
  M 条消息 · K 个 subagent」（皆 0 时「已思考」），点开原样铺回来、再点收起。
  几处刻意的口径：**流式期间不折**（成员还在长）；**中止/截断提示与自动载入的上下文
  永不折**（官方 `TURN_PROCESS_INDEPENDENT_KINDS`，把「回答被截断了」折进按钮里是
  信息损失）；答案步**自己的思考**在折叠态也不显示（官方 `reasoningHidden`）；
  子代理派发（`subagent` / `subagent_*`）单独计数。边界靠段所属的 **step** 判定，
  **拿不到 step 就不折**（宁可平铺，也不要折错——历史里缺 `step/start` 时会这样降级）。
- **对齐官方：思考段与轮尾用时**
  - 思考段**恒默认折叠**（官方 `ReasoningRow` 就是 `useState(false)`，运行中也不展开），
    折叠摘要改成官方口径：**流式中取最后一行、结束后取第一行**，并**去掉 `**`**。
    此前是「流式期间整段展开、摘要恒取首行」——长思考把正文顶出屏幕，摘要里还露着
    markdown 强调符号。
  - 运行中的文案从「生成中」改成**「深度求索中」**（en「Deep diving」）。**没有**跟官方
    那样加渐变扫光与 ≥15 秒实时用时：鲸鱼发光本身就是「还在跑」的证据，而工具行本来
    就各自显示实时耗时，再来一个跳动的秒表只是噪音（用户 2026-09-14 拍板）。
  - 轮尾补**「用时 X」胶囊**（官方 `TurnTimePanel` 在操作条里的位置）：轮次结束时给出
    总用时，点开是「本轮总用时 / 输出速度（TPS）/ 首 token 用时（TTFT）」三行。
    速度为**整轮累加**（各 step 解码窗口与输出 token 相加后再除，官方 `deriveStats`
    的口径），TTFT 取第一步且十秒内保留一位小数（官方 `formatLatencySeconds`）。
- **目标条展开后，正文与右侧按钮都垂直居中**（此前按顶对齐，展开时按钮看着浮在上面）。
- **Markdown 任务列表的复选框此前被静默剥掉**（`- [x] 做完的` 与 `- 没做的` 长得
  一模一样）：净化白名单放行复选框，并加钩子**只**放行 `type="checkbox"`，模型输出里的
  `<input type="text">`/`type="file"` 仍被整个删掉。
- 开发侧：预览夹具里 `a:0` 挂着 `durationMs` / `firstTokenMs` 两个**`MessageView` 上
  根本不存在**的字段（旧设计的遗留），照着一个假形状摆了许久；换成真的 `turnStats`，
  并加了一条「夹具没有幽灵字段」的断言。
- **用户消息也有操作行**：官方 `MessageIconActions` 是用户与助手共用的，用户那一支是
  「时钟 + 复制」、没有分支（分支锚点必须落在 `turn/end` 上）。此前用户消息只有一个
  气泡，想复制自己刚发的长 prompt 只能手动选中。
- **目标条可读性与操作对齐官方**：正文**默认一行截断**（不做「最多两行」那种中间态），
  暂停按钮**左侧**新增展开按钮切全文、可再收起（悬停本来也能看全文）；悬停提示改为
  **目标 + 受阻原因**（此前受阻时只显示原因，把目标顶掉了，等于看不到自己在做什么）；
  新增官方的**内联编辑**（铅笔 → 条内输入框，Enter 保存走 `/goal edit`，Esc 取消）。
- **助手消息里的图片块此前被静默丢弃**：契约里 `assistant/message` 的 `content` 是完整
  的内容块联合（`text / reasoning / image / file / tool-call / tool-result`），适配器只
  折叠了前两种——模型给你看一张图，界面上什么都没有。现在 `image` 块折成一个图片段，
  句柄经 `session/attachment` 换成字节后显示（与 `read_image` 的工具结果图同一套机制）。
  `tool-call` / `tool-result` 块**故意**仍不在这里渲染（它们各有自己的事件、已经折成
  工具行，再画一遍就是重复）；`file` 块的缺口记在 `docs/audit-summary.md` 的未验证表 V6 里。

## 0.5.1

这一版修的是 0.5.0 之后用户逐个报上来的显示缺陷，其中第一条是**架构性**的：
宿主所有「清空某个字段」的指令此前根本到不了界面。

- **目标条清不掉、切会话也一直在**（根因在过线）：VS Code 把 webview 消息
  `JSON.stringify` 过（实测扩展宿主里的 `r8()` 两条分支都是 JSON），于是**值为
  `undefined` 的键会被整条丢掉**——宿主发的「清空」patch 到了界面变成 `{}`，
  界面看到一个什么都不改的空 patch。会话日志显示服务端早已 `Goal cleared.`，
  用户接着点「暂停目标」时服务端只能回 `No goal is currently set`。
  现在过线前把这类字段发成 `null`（`jsonSafeFrame`），界面侧再折回「键不存在」
  （`mergeWirePatch`）。同一根因下**切会话时上一会话的上下文占用 / 速度 / 统计 /
  token 用量 / 轮次大纲 / 图片上限也一并修好**——它们此前同样清不掉。
- **会话历史里看不到分支会话**：过滤判据写成「有 `parentSessionId` 就隐藏」，
  而契约里分支与子代理**都会有** parent，只有 `origin: 'subagent'` 能区分
  （实测见 `scripts/sessionListProbe.ts`），分支因此被连坐。现在分支正常出现在
  历史里，并按血缘深度缩进显示在源会话下面，标题加「分支: 」/「Fork: 」前缀
  ——分支会继承源会话的标题，不区分就是两条一模一样的条目。
- **斜杠命令列表把命令名截断了**：候选行里命令名不再参与收缩，宽度不够时先省略
  右边的描述（权限弹层的档位名同理）；文件路径仍然可以省略。
- **读取节点的行号飘在行尾**：`.row-detail` 此前吃掉整行剩余空间，紧跟其后的行号
  被顶到最右边（实测文件名结束于 x=191、行号起于 x=289）。现在行号在 detail 块
  内部紧贴文件名，空间不够时先让位尾部时长（260px 窄栏下时长让位、行号完整）。
- **「本轮文件改动」与「交付文件」把同一串文件名列两遍**：申报过交付的文件不再在
  本轮改动行重复（判重按规范化路径，分隔符与大小写不敏感）。

### 开发侧

- 预览夹具的消息派发改为**过一遍 JSON**（此前用结构化克隆，上面那条过线 bug
  在预览里根本看不见）。
- 新增探针 `session-list-probe`（分支在 `session/list` 里的真实形状）、
  `session-log-scan`（会话日志体检：多帧 zstd 逐帧解码，查服务端到底怎么认为的）。
- 断言 26 → 28 套：新增 `wire`（过线语义，含 bug 现场对照）、`sessionList`
  （分支可见性 + 血缘深度）、`turnFiles`（轮尾两行去重）；`styles` 加两组
  （弹层主文字优先、行号紧跟文件名）。

## 0.5.0

这一版是**与官方 Web 端对齐**的一次大修：审计报告里第一、二批共 18 条差异全部处理，
附件表示方式整体改成官方模式，并补齐了一批交互缺口。

### 破坏性变更

- **附件不再内联文件正文**。改为官方那两条路径：图片走内容块；其余文件**选中即上传**
  （发送时只带 `receiptId`）；`@` 引用只在正文里放 `@path`（目录是 `@dir/`）。
  内联正文的代价是实打实的：一个源文件吃掉几千 token、二进制根本读不到、
  `@path` 的语义被抹掉、队列「取回重新编辑」退化成几百行文件内容。
  判定「这个文件能不能内联」的旧口径仍然用于**分派**（图片 vs 其余）。

### 新增

- **分支**：任意助手回复左侧（复制按钮旁）可「从这里分支」，以该轮为界开一个新会话，
  原会话不动。生成中禁用——契约要求锚点落在 `turn/end` 上。
- **目标条**：当前目标的阶段、进度与暂停 / 恢复 / 清除，贴在输入框上方。
- **上下文占用环**：环内百分比，60% 起转黄、90% 起转红，悬停给构成明细。
- **「加载更早的消息」**：跟随窗口只带 60 条，更早内容由此往前翻页。
- **斜杠命令节点**：`command/run` ↔ `command/done` 折成一行可展开的命令记录，
  界面上按钮发出的命令（权限预设、计划模式）因此也有可见结果。
- **模型重试提示**：`llm/retry` 显示「正在重试 n/m…」，重试恢复后收掉。
- **输出截断提示**：`turn/end` 原因为 `max-tokens` 时明确告知回答被截断。
- **`/` 菜单列出技能**，并标注「技能」——它不是可执行的命令。
- **设置项**：`dshChat.language`（中 / 英 / 跟随 VS Code）、`dshChat.fontSize`
  （小 / 中 / 大 / 跟随 VS Code）。两者改完即时生效，不需要重载窗口。
- **市场图标**：`media/icon.png`（256×256）。
- `AGENTS.md`：本仓库的 AI 会话强制约束（双语要求、与官方对齐的方法论、构建验证约定）。

### 修复

- **`/plan` 双向失效**：进出都走 `commands/execute`，退出用 `/plan off`。
  此前「进入」是把 `/plan` 拼进消息正文（服务端不认），「退出」发的是 `/plan`
  （按官方语义那是**进入**，方向反了）。
- **手打斜杠命令一律不执行**：现在行首 `/` 且名字在命令目录里就走命令通道，不发给模型。
- **`goal` 投影形状读错**：按嵌套形状读（目标本体在 `goal` 里、`roundsStarted` 在外层），
  此前按扁平读导致目标恒被清空、面板从未渲染。
- **`plan` 投影只读 `active`**：生效状态是 `pending ? !active : active`。
  轮次进行中发 `/plan` 只会挂起，裸读 active 会让按钮看起来毫无反应。
- **快照回放覆盖投影折叠值**：`follow()` 改为先回放记录、再铺投影。
- **`subagentCatalog` 用错契约**：投影条目没有 `kind`/`activity`，按 RPC 行的字段过滤
  会让目录恒为空；`address.mode` 也不再硬编码 `continuable`。
- **交付文件完全不可见**：`produced`（成功的 write/edit 推导）与 `deliverables`
  （`present` 申报）两条来源都渲染成轮尾文件芯片。
- **工具行状态点覆盖了图标**：按官方口径，只有失败 / 已停止才画点，其余显示工具图标；
  分类改用官方精确名表，`pwsh` 等有各自标题；补上 `stopped` 态（警告色，中断不是失败）。
- **终端退出码从未解析**：`[exit code: N]` / `[killed by signal: X]` 从正文剥掉并呈现，
  非零退出升级为失败（bash/pwsh 故意不把非零退出标成错误）。
- **工具结果里的图片看不到**：`read_image` 的图像块此前被整体丢弃。
- **中止后工具行永远卡在「运行中」**：本轮关闭时为未结算的调用合成中断结果。
- **`tool/call` 落在窗口外时结果被丢弃**：补一张只有结果、头部显示 callId 的卡片。
- **纯图片用户消息整条不渲染**：非文本内容块（图片 / 文件）不再被丢弃。
- **占用率口径错**：改用 `contextPressure`（prompt 侧、不含 output、**压缩后会下降**）。
- **`busyEnter` 设置被忽略**：现在按 `ui-conversation.busyEnter` 决定 queue / steer。
- **崩溃后 `dsh web` 起不来**：强杀会留下 `~/.dsh/*.yaml.lock`，而库刻意不回收孤儿锁、
  boot 等 30 秒后退出。扩展现在在每次拉起服务器**之前**按肯定证据清理无主锁。
- **读取节点的行号缀在半截路径后**：路径拆成「目录 + 文件名」，文件名不参与压缩、
  目录从前段省略，行号因此永远紧贴完整文件名。
- **停止按钮悬停无反馈**：`.send-btn.is-stop` 把悬停色吃掉了（特异性相同且它在后面）。
- **`@` 列表里选中目录**：默认改为**打开该目录**（下钻），只有右侧的「整个目录」
  按钮才是把目录本身载入。
- **占用率「卡着不动 / 好几轮不刷新」**：改成官方口径后，刷新只挂在投影上，
  而实测（`scripts/pressureProbe.ts`）投影的分子**要等下一次请求上报 usage 才出现**，
  中间那段窗口没有新值可用 → 显示就停住了。现在：
  - 恢复**每轮都刷新**（`assistant/message` 的 usage 是每轮必到的刷新源）；
  - 分子优先官方 `projectedTokens`（实测这是**唯一逐轮变化**、也是压缩后唯一会降的那个：
    `pressureTokens` 三轮都是 19206，而 `projectedTokens` 19215 → 19844）；
  - 投影还没给分子时，用**同口径**的本地复算兜底：`inputTokens + cachedTokens`。
    实测它与官方 `pressureTokens` **逐字相等**（19206 == 19206），且**不含 output**
    （≠ `totalTokens` 19208）——所以这不是「另算一个近似值」；
  - 占用条**常驻显示**：什么新数据都没有时**保留旧值**，不清空。
  - 百分比没变不再重复下发（投影每轮能推十来次）。
- 宿主侧用户可见文案全部走 `@key` 标记 / `vscode.l10n`，不再有写死的中文。

### 已知限制

- **停止语义与官方契约有一处刻意偏离**。官方契约说 cancel 后排队工作按 FIFO 继续、
  UI 只发一次 cancel；但实测（`node build/queue-continue-probe.mjs`）**只 cancel 不会让
  队列自行接续**（两轮 3/3 都停住），而「之后再提交新消息会不会唤醒队列项」**不稳定**
  （同一脚本两次运行得到 0/3 与 3/3 两种相反结果）。所以仍是「摘空队列 → cancel →
  等空闲 → 按原序重发」：让 ESC 的行为由客户端决定，不依赖服务端那个测不准的分支。
- 未消费投影：`schedule`、`agentPreset`、`subagentTiming`、`permissions.options`
  （前三个属于尚未做的面板功能，`permissions.options` 目前只取 `currentValue`）。

## 0.4.1

- 修复思考与执行节点的状态指示：思考结束后的鲸鱼保持品牌蓝（`.icon-brand`，无动画），
  运行圆点恢复呼吸并加**常驻光晕**；减少动效的抑制名单不再漏掉其中一个。
- 残留进程清理：进程查询改为一次取回全部（此前逐个 pid 各起一次 PowerShell，
  每次约 1.6s），整条链路异步化，并修掉「拿不到命令行反而误杀」的安全缺陷
  （安全谓词改按肯定证据写）。
- 加快开发循环：并行跑 typecheck 与全部断言，新增耗时分解工具 `scripts/bench.mjs`。
- 「不认识的事件」告警只对真正未知的词汇触发；dsh 已知但有意不渲染的事件类型
  改判为知情静默（此前 `agent/inbox/spliced`、`command/*`、`llm/retry` 会把告警刷成噪音）。

## 0.4.0

- 与 DSH Web 端的一致性审计：主报告 + 两份分报告，逐条给出证据等级。
- 编辑类节点渲染结构化 diff（单栏 / 双栏，`dshChat.diffLayout`）。
- 自动载入的提示词（系统提示词 / 插件注入 / 项目指令 / 技能目录）作为节点可见。
- 队列「取回重新编辑」与 ESC 中止并发出队首。
- 通用文件入口：按内容分派内嵌或插入路径。

更早的版本见 git 历史与 `Releases/` 下的 vsix。
