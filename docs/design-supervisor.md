# 独立守护进程（supervisor）托管 DSH 后台 —— 设计

> 本文是什么、什么时候读：supervisor 后台生命周期的设计定稿与口径来源，已实现并生效
> （2026-09-13 定、09-14 落地，其后实测修正见下文「启动决策」与「选路」两章；取代已删除的「窗口间
> 协商会合租约」模型）。动 supervisor / DshClient / 后台连接链路，或核对「能否启动后台 /
> 停止 / 自动连接」口径之前先读；原 §8/§9 即下文第 17、18 章。

## 1. 动机：为什么换掉会合租约模型

旧方案用「窗口之间自己协商」（会合租约 + 心跳文件 + 启动锁）回答谁起后台、还有谁在用、
什么时候杀。死角是结构性的：协商要求在场每一方都投得了票，而 VS Code 会随时杀掉扩展
宿主、新实例又替不了旧实例投票——旧实例 release 时新实例未出生就误杀 dsh（每次重载
窗口都冷启 5~8 秒）；新窗口 pid 判据失真干等 90 秒；关窗期通道已关，杀进程代码执行不到；
残留 dsh 的接管判据（共六个）失真而误杀/漏杀。根因：把后台生死绑在扩展宿主上，再用
多方协商去补它的洞。正确做法：生命周期交给独立于 VS Code 的进程，「还有没有人在用」
变成单一裁决者读得到的事实（有没有人 ping），不是一场投票。

## 2. 验收标准（用户口径 R1~R9）

- R1 重载窗口不打断后台：pid 与端口不变，断点只是「握一次手」。
- R2 多窗口共用一个后台：同时开 3 个窗口，也只有 1 个 supervisor、1 个 `dsh web`。
- R3 没人用就退场：全部窗口关闭/崩溃后超过空闲阈值（默认 10s）→ 先关 dsh 再关自己，
  不留孤儿、不留僵尸。
- R4 找不到就启动、启动不重复：首个窗口启动（OS 锁保证并发只一个赢），后续窗口只连接。
- R5 supervisor 崩了自愈：任一窗口自检发现并重新拉起；遗留 dsh 被回收（不占端口）。
- R6 用户仍能掌控：停止 / 重启 / 清理残留 / 诊断命令都保留。
- R7 配置语义不变；`autoStart` 语义 2026-09-14 明确收紧、2026-09-18 改名 `autoConnect`
  并再收紧（见下文第 17、18 章）。
- R8 autoConnect 关着时只显示按钮、一个进程都不起；开着按选路口径走一次。
- R9 非启动窗口（peer）复用会合文件里的 token 换 cookie，不再弹「输入令牌」。

## 3. 传输层纪律：socket 管信号与控制，文件管会合（用户定的方案 A）

- 高频信号（ping/保活）与控制请求（restart/stop/state）、supervisor 主动通知 →
  **AF_UNIX socket 长连接**（Windows 走 `\\.\pipe\...` 形态 path，失败自动退化命名管道）。
  连接断开即知「这个窗口没了」——liveness 从「轮询+超时」升级成事件；不再造 stop 请求
  文件。
- 跨世代会合信息（baseUrl/token/supervisorPid/command/分组）→ **文件**
  （`supervisor.json`，原子写 tmp+rename）：supervisor 未起或刚崩时新窗口也有东西可读；
  可读可 diff，排查一眼看得见。
- 诊断输出 → `supervisor.log`（进程没了之后唯一的事后线索）。**没有心跳文件**。
- IPC 的失败模式逐条有代码：① 连不上是正常态（读文件 → 连 socket → 失败则拉起）；
  ② supervisor 崩则 socket 立断（比超时快）→ 就地重拉并按端口回收遗留 dsh；③ socket
  残留文件先探活再删、**不许盲删**（沿用 isKillable 的「按肯定证据」纪律）；④ AF_UNIX
  路径有长度上限——非 Windows 放分组目录内 `sup.sock`，Windows 直接命名管道
  `\\.\pipe\dsh-chat-<分组>`（探针隔离须另带后缀）；⑤ 兜底：socket 连续失败但 supervisor
  进程还活着 → 退化成读 supervisor.json 新鲜度再判一次，不把自己困死。

## 4. 运行时选型：supervisor 固定用 VS Code 自带的 Node（用户口径，D7/D8）

- dsh 是社区生态、发行形态多（可能是独立可执行文件），**「PATH 上有 node」不是可依赖的
  前提**；扩展宿主本身跑在 VS Code 自带 Electron/Node 上，必然存在。
- 唯一路径：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`（若 execPath 不是 Code.exe，
  再试 `vscode.env.appRoot` 下那份，两处都试）；失败写 supervisor.log 给明确错误。
- **不提供运行时配置项**（D8 拍板）：宿主能跑起来就说明运行时在，没有「找不到」的合理
  场景，多一个配置项多一个「用户填错/填旧版」的故障面；版本差异用**产物 target: node20**
  消除，排查靠 supervisor.log 记 execPath / versions.node / versions.electron。
- spawn 姿势（照写别踩坑）：**清掉** `ELECTRON_RUN_AS_NODE`（防把自己变成 Node 去跑整个
  VS Code）、`windowsHide: true`、`detached: true` + `unref()`（必须与扩展宿主生命周期
  解耦，否则窗口一关 supervisor 陪葬）；代码打进扩展包 `dist/supervisor.js`（CJS +
  只依赖 node 内置模块）；这条同时让探针完全无头可跑（不必装 node、不必启动 VS Code）。

## 5. 进程拓扑与职责

- 多个 VS Code 窗口各持一条 socket 长连接（1s 一次 ping）→ supervisor（独立进程、
  detached、无窗口、VS Code 自带 Node 运行）→ 唯一持有 `dsh web` 子进程（命令原样来自
  `dshChat.command`）。
- supervisor：被第一个找不到它的扩展实例拉起；只认 socket 上有没有活连接（+ 会合文件的
  世代）；退场 = 连续 idleSec（默认 10s）无活连接 → 按端口杀 dsh 整棵树 → 删
  supervisor.json 与 socket → 通知各连接 → 自己退出。
- 扩展侧只做客户端：读会合文件 → 连 socket 拿 baseUrl/token（令牌换 cookie 与今天一致）
  → ping → 退出只关自己的连接，**任何情况下都不杀 dsh**（本次架构最重要的一条纪律——
  今天所有麻烦都源于「扩展也在杀 dsh」）。
- supervisor 不感知 VS Code，对其创建/销毁/崩溃/重载完全免疫；探针可用脚本当 pinger，
  完全不启动 VS Code。

## 6. 磁盘协议：只留会合信息

- 目录 `<DSH_HOME>/dsh-chat-vscode/supervisors/<配置指纹>/`（指纹沿用 leaseGroupKey、按
  有效配置算；DSH_HOME 缺省 `~/.dsh`），里面只有：
  - `supervisor.json`（supervisor 原子写、扩展只读）：version / supervisorPid /
    serverPid / baseUrl / token / command / idleSec（期望阈值，热读）/ socket /
    startedAt / serverStartedAt / starting。`starting=true` = 正在拉起 dsh，扩展据此
    等待而不是自己起。
  - `supervisor.log`：supervisor 与 dsh 的输出，排查唯一线索。
- liveness 由 socket 连接本身表达；旧实现的 `hosts/*.json`、`ownerStartedAt` 那套 pid
  复用检测一并退场（它们解决的是新形态不再存在的问题）。

## 7. 启动协议：幂等防并发

1. 读 supervisor.json：能 HTTP 连上 baseUrl → 连 socket 接上；`starting=true` 且未就绪 →
   轮询等待（无超时，用户可点「停止连接」中断）；连不上 / 服务器连不上且过宽限 → 判
   supervisor 或 dsh 已死，通知/重拉；文件没有 → 进入 2。
2. 抢 OS 锁（分组目录 `supervisor.lock`，`wx` 独占 + 持有者 pid 判活）：抢到 → 写
   supervisor.json（含 idleSec、command、socket 路径）→ spawn supervisor（detached）；
   没抢到 → 别人正在起，回到 1 轮询等待。
3. 轮询 supervisor.json 直到 `serverStartedAt` 出现且 baseUrl 可连（同样等就绪、无超时）。

锁只保护「启动 supervisor」这一个动作（几十毫秒）；dsh 的启动过程由 supervisor 自己写
`starting` 表达，扩展不需要为此协商。

## 8. 长连接与自检（每个窗口）

- 连上 socket 并保持：连接本身就是「我在用」的信号，每 1s 一次 ping 兼保活，断了立刻
  知道。
- 连接健康：收到 state 变更（baseUrl 变了 = supervisor 重启了 dsh）→ 用新令牌重连
  （cookie 按 authority 绑定，换端口必须换 cookie，这条现有逻辑保留）。
- supervisor 不健康（状态文件缺失 / supervisorPid 已死 / 连接被拒且探活失败）→ 回启动
  协议重拉；若端口上还有人在监听（遗留 dsh）→ **先按端口杀掉孤儿再起 supervisor**
  （R5 的落点，也是「按端口找真正监听者」必须保留的原因）。
- 不变量：扩展只关自己的连接，杀 dsh 永远是 supervisor 的事，扩展一行都不做。

## 9. supervisor 内部结构

- 启动：定位配置目录（命令行参数传入）→ 监听 socket → 原子写 supervisor.json
  (starting=true) → spawn dsh（输出进 supervisor.log）→ 轮询日志公告行
  `dsh web: http://…/?token=…` → 就绪：原子回填 baseUrl/token/serverStartedAt、
  starting=false，并广播 state 给各连接。
- 循环（每 1s）：① 数活连接（断开立即反映）；② 连续 idleSec 无活连接且无启动在途 →
  收尾：按端口杀 dsh 整棵树 → 通知各连接 → 删 supervisor.json 与 socket → exit；
  ③ dsh 真死了：有活连接 → 重 spawn 并重解析公告行（`--port 0` 时端口会变）→ 广播；
  无连接 → 自己退场；④ 热读 idleSec（改配置不必重启 supervisor）；⑤ 处理控制请求
  （ping/restart/stop/state）。
- **「dsh 死了」的判据不是 `!server.child`**（2026-09-15 实测修）：ChildProcess 对象在
  进程死了之后不会自己变 undefined（exit 处理器只记日志，没人清字段）。判活必须问进程
  本身：`exitCode/signalCode` 已置位，或 `isProcessAlive(pid)` 为假。用错判据的后果是
  dsh 崩掉之后再也拉不起来，而守护进程存在的理由恰恰是这一条。
- supervisor 绝不能没有出口：任何「没人在用」判定必须以「连续 N 秒无活连接」且「没有
  正在进行的启动」为前提；宁可可多活几秒，也不在窗口重载空档误退场（5 秒太紧、默认
  10 秒的原因）。
- 刻意取舍：所有窗口关闭后 dsh 继续服务到空闲阈值再与 supervisor 一起退场——重载空档
  实测 2~5 秒必须被容忍；代价是关掉 VS Code 后机器上多活 ≤10s，可接受。要立刻停用
  `DSH: 停止服务器`。

## 10. 同生共死不变量：协议里没有「启动后台」控制帧

- 守护进程存在的唯一理由是**端着一套可用的 dsh 后台**（用户 2026-09-19 口径）：dsh 不该
  在守护进程活着时缺席，守护进程也不该在 dsh 不需要时独自赖着。落成三句：
  1. **起来就自启**：监听之后就拉起 dsh（bringUp），不等任何窗口连上；
  2. **崩了就重起**：主循环发现 dsh 死了且还有活连接 → 重新拉起。零客户端不救——那种
     情况这一对本该退场（空闲判定随即收场），顺带防命令写错时的 spawn 风暴；
  3. **收场就一起收**：stop（用户点「停止内部 DSH」）与 idle（空闲超阈值）都走同一套
     收尾：先杀 dsh 整棵树，再通知各连接、自己退出。
- **因此控制协议里没有也不需要「启动 dsh 后台」这一帧**：客户端控制动作只有 restart
  与 stop（`dsh/supervisorWire.ts` 的 ClientMessage）。扩展侧 `ensure({start:true})` 是
  「守护进程不在就把它拉起来」，**不是**「叫守护进程去起 dsh」；dsh 的启动/重启/收场
  只有守护进程会做。以后别为「更灵活」加 start 帧，也别让守护进程能不绑 dsh 地活着。
- 分清：「停止连接」（连接条按钮）只交还本窗口的占用、断开 socket，一个进程都不碰；
  「停止内部 DSH」（命令面板）才是上面的整套收场。

## 11. 「能不能启动后台」是一条显式许可（口径，完整保留）

- 「能不能启动后台」是一条**显式许可**：`autoConnect` 只约束**自动**路径（激活期选路、
  窗口恢复、5 秒心跳自检），用户显式动作（发消息 / 新建 / 切换会话 / 启动 / 连接 /
  重启内部 DSH）一律允许启动。
- 「启动内部 DSH」与「连接内部 DSH」是同一套逻辑（有就接上、没有就起一套），按钮同义
  才不会「点对了却没反应」；只有「连接外部 DSH」不启动任何东西。
- autoConnect 关着时：扩展激活后只判两条轴（内部在不在跑、外部可不可达），只显示按钮，
  一个进程都不起。

## 12. 一份状态、一处路径、一个探针入口（2026-09-19 收敛）

- 问题：同一份 SupervisorState 从前被三处解码（文件路、管道路、写侧），宽容规则互不
  一致——代价不是啰嗦而是**改一处忘两处**：加字段时只有一处认得，另一条路静默丢掉。
- **一个解码器**：`supervisorProtocol.decodeState`，两条读路都调它；逐字段校验只有一份
  且**只许收紧**（baseUrl 必须 http(s) 且能解析、token 非空、pid 与时刻整数、
  command/socket 非空——socket 推来的 baseUrl/token 决定凭据发往哪个 origin，是安全
  边界）。两条路的差异只剩两个显式参数：文件路 requireVersion（旧世代文件整份作废）、
  管道路 idleSecWhenMissing: 0（不替对面编默认值）。
- **一处路径**：`rendezvousPaths()` 是目录/状态/锁/日志/socket 五个路径的唯一产出；
  socket 名只由会合目录派生（`socketPathIn` 取目录最后一段）。判据：src 下产生
  `\\.\pipe\dsh-chat-…` / `sup.sock` 字面量的只有这一个函数。
- `goodbye.reason` 联合类型只有一份（supervisorWire.GoodbyeReason），客户端与守护进程
  共用。
- **探针走真入口**：四个验收探针直接构造扩展真正用的 `SupervisorManager`（ProbeWindow），
  不再手抄「读文件→抢锁→等就绪→连 socket」流程——从前验的是副本，副本漂移了探针照样
  全绿；分组指纹 3 份、usable 2 份、PingerInfo/startPinger 3 份全部收敛；pinger.ts 只剩
  手工排查薄壳。**已知未覆盖**：R1 探针间隔 3 秒 < 守护进程启动宽限（idleSec+10=15s），
  没考到「空闲退场」；严格版应改成「关 A 后等 idleSec+1 秒再起 B，仍接上同一个 dsh」，
  这一条没做，勿当已验证。

## 13. 时序与边界

正常流程：扩展激活（无 supervisor）→ 起 supervisor → dsh 就绪 → 接上；窗口重载 → 旧
实例只关自己的连接 → 新实例读 supervisor.json 直接接上，dsh 从未中断（R1）；关掉最后
一个窗口 → 10s 后 supervisor 关 dsh 并退出（R3）。

崩溃矩阵：

| 崩了什么 | 现象与处置 |
|---|---|
| 一个窗口崩溃 / 强杀 | 它的连接断开；supervisor 不受影响（没别的连接就按 R3 退场） |
| 扩展宿主被杀、窗口还在（重载） | 中断 1~3 秒，不触发退场（阈值 10s 远大于空档） |
| 所有窗口崩溃 | 连接全断 → 10s 后 supervisor 关 dsh 退出，机器回干净状态（R3） |
| supervisor 崩溃 | 文件还在、pid 已死、socket 断开 → 任一窗口自检发现：按端口回收遗留 dsh、重起 supervisor（R5） |
| dsh 自己崩了 | 有活连接 → 重拉；没有 → 退场；端口变化经 socket 广播。前提：判活判据正确（见下文「dsh 崩了却不再被拉起」的教训） |
| 启动 supervisor 的窗口中途关掉 | supervisor 是 detached 的：照常完成启动并写状态文件，其余窗口接手 |

## 14. 与外部服务器（dshChat.url）及配置分组

- `url` 只是**备用地址**，是否走外部由**选路**决定（内部优先、外部备用，见下文「选路」章）；
  supervisor 只服务「内部后台」这一种情形，这条不变。
- 修正过的坑：目标判 external 时「决策」不走内部逻辑成立，但「手里那条 socket」并不
  随之关——换目标后守护进程一直把 dsh 拎着、状态推送继续改写管理器状态；修法与不变量
  见下文「换目标的彻底性」。
- 分组键**只按 command**（sha256 前 12 位），它是**内部后台**的身份；「url 非空时只按
  url 分组」的旧口径已随「内部优先、外部备用」作废——否则配了 url 的窗口会去另一个
  会合目录判「内部不存在」再起一套，用户改一次 url 也与既有后台失联。
- 名字里的 "lease" 是历史包袱：与被删掉的会合租约无关，只是「会合目录的分组键」。
- 配置改了 → 提示重载窗口（不就地热切换，已定）；**autoConnect 例外**：它只是自动路径
  的许可，改动**即时生效、不必重载窗口**（停在按钮态会立刻按新值自动连接）。只有
  url / command 改了才需要重载。

## 15. 与现有代码的关系（教训清单，实现后已回填）

保留（踩出来的，别重踩，一行一条）：

- 公告行是端口/令牌的唯一真相（supervisor/main.ts 的 parseAnnouncement）——服务器自报
  地址，扩展与 supervisor 都不猜。
- 令牌写进用户私有目录 + cookie 换发——令牌是进程内存值、cookie 绑 authority，多窗口
  接入的唯一可行路径。
- 按端口兜底杀整棵树（killServer / listeningPids）——dsh web 经 shell 启动，外层 pid
  可能是外壳；收尾与回收遗留孤儿都靠它。
- 异步进程查询（批量）、不拿 pid 当可用性判据——同步 spawnSync 冻住扩展宿主约 1.5 秒；
  pid 判活对僵尸进程假活。
- `clearStaleDocumentLocks`（dshLocks.ts）——dsh web boot 会锁 .credentials.yaml，孤儿
  锁会让它 30 秒后自杀。
- 清理 / 诊断命令与 isKillable——用户手动兜底；判「允不允许动手」的肯定证据纪律。
- 日志写入器永不抛异常（hostLog.ts）——关窗期日志抛异常会掐断停用路径。

删除（已完成）：serverManager.ts 整份删除（约 1100 行的协商式生命周期），换成客户端
形态的 supervisorManager.ts；processRegistry 从 1726 行缩到约 300 行（租约读写与锁、
hosts 登记与心跳、六个接管判据、启动锁、killLeasedServer* 全删，留下跨两种架构成立的
工具）；随之删掉测旧模型的断言与探针（sharedLease.test.ts、各 crash/graceful/orphan/
group 探针等；令牌部分迁入 processRegistry.test.ts）。耦合面实测：processRegistry 的
消费者只有 3 个文件，其余 30+ 源文件零依赖——是换一个中间层，不是重写扩展。

新增：supervisorProtocol.ts（会合文件原子读写 + socket 寻址 + 启动锁，纯函数可离线
断言）；src/supervisor/main.ts（打成 dist/supervisor.js 随包分发）；supervisorClient.ts
（扩展侧）；runtimeResolve.ts（VS Code 自带运行时解析）；配置项
`dshChat.supervisorIdleSec`（整数、默认 10、范围 5~600，唯一新增配置项）；「停止服务器」
走 socket 控制请求（不引 stop 请求文件）。

测试回填一句：44 套离线断言进 npm test 全绿，四个端到端探针（R1 重载 / R3 空闲 /
R2-R5-R6 场景 / 管理器本体）无头跑（不启动 VS Code）全部 PASS——探针的「窗口」就是
扩展真正用的那个 SupervisorManager。坑：探针的目录隔离若只靠副作用设环境变量会被
esbuild 摇掉（导出未被使用→整份删除），探针静默跑进真实目录；现每个探针都有「必须是
临时目录」的硬断言。

## 16. 已定决策与待定项

已定（用户 2026-09-13 起，一句一条）：

- D1 空闲阈值默认 10 秒，`dshChat.supervisorIdleSec` 可调（建议 5~600；下限 5 因再小会
  与「窗口重载空档 2~5 秒」打架）。
- D2 方案 A：最后窗口关闭后 dsh 不立刻停，与 supervisor 一起等到空闲阈值再退场；要
  立刻停用「停止服务器」。
- D3 ping 就够：只监测「有没有扩展在 ping」，不拦扩展与 dsh 之间的流量。
- D4 不做整体回退：保留非机制成果（配置热重载、窗口状态、界面修复），只换后台生命周期
  这一层。
- D5 版本号不动，是否发版由用户决定。
- D6 传输层 = 方案 A：socket 管高频信号与控制，文件只放跨世代会合信息；用户明确否掉
  「每秒写文件当心跳」。
- D7 supervisor 运行时不要求用户装 Node，只用 VS Code 自带的运行时（PATH 上有 node
  不是可依赖的前提）。
- D8 不提供运行时配置项：宿主能跑起来就说明运行时在；版本差异用产物 node20 消除，
  排查靠 supervisor.log 的记录。
- D9 autoStart（2026-09-18 改名 autoConnect）只约束「自动」路径，用户显式动作（发消息/
  启动/重启等）不受它约束；关掉后以「后台在不在跑」为唯一判据。
- D10 令牌只认会合文件那一份：self 与 peer 走同一条认证链，内部模式不再有「输入令牌」
  入口。
- D11 自动重连由 5 秒心跳驱动、不另起定时器：管理器心跳常驻（不再「连上才开」）、控制
  器自检挂同一节拍——「起来了要接上」与「掉了要重连」是同一个循环，不会两套节奏打架。

待定：

- P1 ping 间隔建议 1 秒（兼保活；只影响「多久发现对端死了」，1 秒足够，不必更密）。
- P2 已由 D6 解决：stop 走 socket 控制请求，不再有「stop 请求文件」。
- P3 已作废（2026-09-14）：「启动超时」这一档时长判定本身不该存在——startTimeoutSec
  配置与对应标记已删，改为「等到就绪，或用户点停止连接」。

实现顺序（已按此完成，留作背景）：① 协议与运行时解析 + 离线断言 → ② socket 协议与
扩展侧客户端 → ③ supervisor 本体 + 两条核心探针（先红后绿）→ ④ 管理器换客户端形态 +
其余探针 → ⑤ 删旧实现、改文档、全量回归 → ⑥ 打包 vsix、手动验收。

## 17. 启动决策、自动重连与多窗口令牌（2026-09-14 实现）

> 本节当时的按钮口径与"外部服务器"写法已被「内部优先 / 外部备用」一节取代（autoStart 改名
> autoConnect、按钮换成内部/外部口径）。保留的是实测出来的机制结论——令牌来自会合文件、
> 只接入不另起、等待没有时长上限——它们仍然成立。旧版连接条按钮矩阵（2026-09-15 三档状态
> 版）已删除，被下文「连接条按钮矩阵（最新版）」取代；其中仍成立的两条口径——「停止连接」
> 绑"在不在连接"而非 reconnecting 标志（reconnecting 只回答"重连循环还在不在跑"，供文案用；
> stopReconnect 的守卫是"当前是 connecting/disconnected 才动手"）、「查看日志」恒显——在新
> 矩阵里同样是硬约束。

### 17.1 autoStart（现名 autoConnect）关掉之后的决策表（用户口径，逐格保留）

> 用户口径：扩展启动后不要无脑重连——先判断后台 dsh 是否已启动；没启动就直接显示启动服务
> 器按钮；有守护进程和 DSH 后台进程在时才自动尝试重连（去掉重连超时时间，提供停止重连/
> 尝试重连按钮，由用户手动调整）；外部 DSH 不判进程问题，只做重连尝试；重连失败时提示用户
> 打开日志。另：内部启动后无法自动获取 token，token 应保存到文件中，供多个 VSCode 窗口
> 复用。

| 情形 | 扩展怎么做 |
|---|---|
| 后台（守护进程 + dsh）在跑 | 自动接上，一轮一轮重试到成功为止（没有任何时长判定；等待只由"真的就绪"或「停止连接」结束） |
| 后台不在跑 | 什么都不启动，连接条显示「启动服务器」；守护进程后来起来了（别的窗口拉的）会自动接上 |
| 用户点「停止连接」 | 停掉正在进行的连接（中止在途那一轮 + 关掉自动重连），并交还内部后台的占用（断开与守护进程的连接、心跳不许再接回，见「停止连接 = 不再占用内部后台」）；进程一个都不动（杀 dsh 永远是守护进程的事），条上给按钮态 |
| 外部服务器（dshChat.url） | 不判进程，只重连（那条地址不归本扩展管，"启动"这个动作不存在）；同样等到底，一次都没应答过就把 @serverUnreachable 摆在条上 |
| 连不上 | 条上显示原因 + 「尝试连接」/「重启服务器」/「查看日志」（输出通道「DSH Chat」） |

「能不能启动」是一条显式许可（SupervisorManager 的 autoConnect + ensure({start})）：autoConnect
只约束自动路径（激活期自动连接、窗口恢复会话、5 秒心跳自检）；用户显式动作一律覆盖它——
发消息、新建/切换会话、「启动服务器」「重启服务器」、输入令牌，用户要后台的时候不该被配置
挡住。界面侧因此多一档状态：stopped（没启动，给「启动服务器」）与 error（连不上，给原因与
重试）必须分开——把"没启动"渲染成"正在连接…"会让用户以为卡住了。

### 17.2 令牌就是会合文件里的那一份；守护进程活着只接入、不另起一套

- token 由 supervisor 原子写进 supervisor.json，这是多窗口接入的唯一凭据。认证链按
  ownership === "external" 分叉：self / peer 都走"令牌换 cookie"（此前按 info.owned 分叉，只有
  启动者能用令牌，其余窗口被当成外部服务器弹「输入令牌」）；令牌被拒时重读一次会合文件再用
  （守护进程可能刚好重起了 dsh、换了新令牌）；内部模式不出现「输入令牌」入口（那是外部服务
  器才有的东西）。
- bringUp() 的顺序：读到会合文件且守护进程活着 → 先接上它的 socket（连接本身就是"我在用"，
  守护进程据此把崩掉的 dsh 重新拉起）→ 等它写出一份可用状态。不要"地址不可达就去抢锁 +
  再 spawn 一个 supervisor"：Windows 命名管道只能被一个进程监听，第二个 supervisor 会在
  listen 处失败自杀，而 spawn 开销已经付掉，原守护进程又因"没人连着"在空闲阈值后收场。

### 17.3 等待就绪没有时长上限、不由时长决定（用户口径，完整保留）

> 用户口径：通过提供停止连接、开始连接、启动服务器等按钮，完全由用户手动操作，而不是通过
> 时长控制——这个时长控制不应该还在。

- dshChat.startTimeoutSec 配置项、ManagerOptions.startTimeoutMs、@serverStartTimeout 标记一并
  删除（@serverNotReady 取代后者）；waitForReadyState 不再有 deadline：等到真的就绪，或
  AbortSignal 被 abort。
- 「停止连接」/「停止服务器」调 SupervisorManager.cancelWaiting() 中断在途那一轮等待（只中断
  等待，不碰任何进程）；中断抛 WaitCancelledError，controller 把它当"用户叫停"：界面停在
  stopped（给「尝试连接」），不写错误详情。
- 「重启服务器」与等新地址同样没有 deadline；外部服务器统一到同一条口径——一轮轮探测到底
  （连上，或用户点「停止连接」），单次探测自己的 2 秒 fetch 超时保留（那是"这一次探测等多
  久"）；第一次探不通时把 @serverUnreachable 摆到连接条上，用户看到的是"连不上 <url>（会一直
  重试，可点「停止连接」）"而不是转圈的空条。真正的失败（守护进程起不来、会合文件缺地址/
  令牌）照旧如实报错：@serverNotReady + "缺哪一样" + 日志尾部。
- "开关只由按钮翻"补掉的两处洞（同一条口径）：① handleHeartbeat 在 stopped 分支必须读
  autoReconnect，否则「停止连接」只维持到下一个心跳（≤5 秒）就被自动接回去；② 一轮连接已经
  在跑时按「停止连接」必须拦得下——等待结束之后、以及客户端建好之后各一道 userAskedToStop()
  检查，后者把刚建好的客户端收掉。
- 唯一仍按秒计时的是 supervisor 内部等 dsh 宣布地址的 SPAWN_GRACE_MS（120 秒、一轮轮重跑）
  ——它是 supervisor 内部的重试节奏，不是扩展侧"等多久就放弃"的状态判定。

### 17.4 「dsh 崩了却不再被拉起」的教训：判活要问进程本身（2026-09-15 修）

主循环曾写 if (!serverStarting && !server.child && clients.size > 0)：server.child 是
spawn(..., {shell:true}) 返回的 ChildProcess 对象，进程死了它不会变成 undefined（exit 处理器
只记日志、没人清这个字段），dsh 一死后重启分支永远进不去——实测 supervisor.log 里 exit 事件
确实到了、之后几十个 tick 里 server.child 一直停在那具死掉的 pid 上。修法：判活问进程本身
（exitCode/signalCode 已置位，或 isProcessAlive(child.pid) 为假），见 src/supervisor/main.ts 的
childGone()；把判据退回旧写法，探针 A/B 两组立刻转红。能力边界（尚未做、用户未表态）：判据
只覆盖"进程消失"，卡死（进程在、外壳也在、不再应答）不会重启——supervisor 与 dsh 之间只有
启动时读公告行那条管道，没有探活。平台事实（探针实测，别再重新猜）：spawn(command, [],
{shell:true}) 返回的句柄是 cmd.exe 外壳，真 dsh 是它的子进程；杀掉真 node，外壳约 100ms 内
跟着退出（exit code=1），"只杀 node 不动外壳"的担心不成立；killServer 的"按端口兜底"仍值得
留着（外壳先死、node 成孤儿的情形存在，例如 supervisor 被强杀）。

### 17.5 守护进程内部抛错要有处可看（2026-09-15）

起因：事件回调里引用了不存在的变量，ReferenceError 冒到顶层，守护进程以 code=1 消失（窗口
侧只看到"连不上"）。两层结论：

- 错误不能弄死守护进程（已修）：所有事件回调/处理器（tick、socket、dsh 的 exit/error、
  control 请求、shutdown、SIGTERM）都套守卫，process.on(uncaughtException /
  unhandledRejection) 兜底，原则是记下来、活下去（守护进程死了没有任何东西能接替它）。两处
  真死锁一并修：bringUp 中途抛错会让 serverStarting 卡在 true，"崩了要重起"与"没人用要退场"
  两条路同时瘫痪 → try/finally 复位；startServer 的轮询回调一抛，那个 promise 永不 settle →
  出错即 finish(undefined)（"本轮失败"）并把异常交给 onError。
- 错误必须有人看得见（已修）：守护进程日志在 ~/.dsh/dsh-chat-vscode/supervisors/<分组>/
  supervisor.log，用户不会去翻。两级上报：文件是底线（没有窗口连着时唯一的收件人，写不进去
  退 stderr）；socket 广播 {"t":"error","kind","message"} → 扩展侧转发进输出通道「DSH Chat」
  （连接条「查看日志」就是入口）。实测细节：上报器保留最近 16 条、新连接先补发再推状态
  （最要命的错误恰恰发生在"一个窗口都还没连上"的时刻）；旧扩展不认识 t:"error"，协议
  "读不懂就忽略"保证向后兼容（有专门断言钉住）。
- 顺带教训：加 try/finally 时把 serverStarting = false 从 publish() 之前挪到了之后，会合文件
  永远写着 starting: true，新窗口/重载后的窗口会一直等一个"正在启动"的后台——正常路径的复位
  必须排在 publish() 之前。

### 17.6 验证（一行）

supervisorPolicy.test.ts（无许可不 spawn、守护进程活着只接入、令牌来自会合文件、等就绪无上限
与 cancelWaiting 立即生效、外部地址一直等）、auth-chain-probe（真实 dsh 的认证链）、
styles.test.ts（连接条换行、按钮 nowrap）、test/preview.html（连接条按钮组合中英肉眼核对）、
supervisor-child-exit-probe（dsh 死了被自动拉起，三种故障形态）、supervisorErrors.test.ts +
supervisorProtocol.test.ts（错误上报与 t:"error" 协议向后兼容）+ supervisor-error-bridge-probe
（端到端）。

## 18. 内部优先 / 外部备用：选路、粘性目标与按钮矩阵（2026-09-18 实现）

> 用户口径（要点）：autoConnect 开着 → 启动后先判断有无内部 DSH，有则自动连内部；没有内部
> 有外部则自动连外部；二者都没有则启动内部 DSH。autoConnect 关着 → 启动后检查内部与外部：
> 内部不存在显示「启动内部 DSH」，存在显示「连接内部 DSH」；外部 DSH 不论存不存在均显示
> 「连接外部 DSH」，反正连接失败会输出到日志。「配了外部 url 则内部配置均无效」的旧逻辑
> 失效：内部 DSH 优先，外部 DSH 相当于备用。

### 18.1 两条存在性判据（随 5 秒心跳刷新，都不与守护进程"通讯"）

| 轴 | 判据 | 为什么 |
|---|---|---|
| 内部 | 守护进程进程活着（probeRunning().supervisorAlive） | dsh 正在起或刚崩也算"内部存在"，接上去等就好，守护进程会把 dsh 拉回来；用"dsh 在监听"判会把正在重启的内部后台误判成不存在，于是去起第二套（Windows 命名管道只允许一个监听者）或误连外部 |
| 外部 | dshChat.url 配了 且 那个地址此刻有应答 | 配了地址 ≠ 服务器活着，"备用"只有在能用时才算数；探测就是一次 HTTP GET（401/403 也算有东西），单次 2 秒超时 |

内部轴：读会合文件 + isProcessAlive(pid)（process.kill(pid, 0)），纯只读，对方不参与；唯一用途
是按钮态那句"内部 DSH：运行中/未运行"。外部轴：只在未连接时探测（连上之后连接条根本不显示，
"连上了"本身就是可达证据）；已连上时沿用上一次的结论、不改写成"不可达"——那是假的。这道
门槛必须真正落在 probeFacts() 内部，否则调用方没按它调，连上之后每 5 秒仍会朝那个地址发一次
GET。

### 18.2 选路是纯函数、目标粘性、自动路径永不换目标

src/dsh/connectTarget.ts 的 chooseTarget(facts)：内部在跑 → 内部；否则外部配了且可达 → 外部；
否则内部 + start: true（拉起一套）。六种组合在 connectTarget.test.ts 里逐条钉住。
粘性（用户明确选了"自动路径永不换目标"）：目标只在激活期选路或用户点按钮时改变，心跳/重试
永远重试同一个目标。理由：换目标的代价被低估了——另一台服务器有自己的一套会话，一次切换 =
换会话列表 + 丢掉正在跑的轮次。代价是"备用"只在启动那一刻生效：内部崩了不会自动走外部，要
用户点「连接外部 DSH」。控制器侧 target: { kind, mayStart }（mayStart = 这一轮允不允许"内部
不存在就拉起一套"）：激活期选路取 chooseTarget 的结论（仅"都没有"那支为 true）；「启动内部
DSH」internal/true；「连接内部 DSH」internal/true（有就接上、没有就起一套，与「启动内部 DSH」
同一套逻辑）；「连接外部 DSH」external/false；发消息/新建/切会话沿用当前目标（没定过就是
internal）/true（"用户要后台时不该被配置挡住"）。

### 18.3 失败分三类，只有"还能接着试"的连接类自动重试

| 类别 | 例子 | 界面 | 自动重试 |
|---|---|---|---|
| 连接类 | 地址连不上、socket 断、客户端掉线 | 仍在连接中 + 原因 | 是（没有自动停止的时间限制，只由用户点「停止连接」） |
| 启动类 | @serverSpawnFailed、@serverNotReady（命令写错、dsh 起不来） | 按钮态 + 原因 | 否 |
| 认证类 | DshAuthError（要令牌 / 令牌被拒） | 按钮态 + 原因（外部再给「输入令牌」） | 否 |

后两类不重试的理由是重试解决不了：命令写错时每 5 秒 spawn 一个必死进程、日志被刷爆；凭据
不对更是重试一万次也一样。识别方式：错误身份（DshAuthError）与 detail 前缀（controller 的
isStartFailure）；拿不到明确证据时按连接类处理（多试几次的代价只是日志）。

### 18.4 连接条按钮矩阵（最新版，取代旧版矩阵）

连接条只在未就绪时渲染（ready 时整条消失），所以按钮只在"没连上"的语境里讨论。三档状态 +
四个标志（serverRunning / externalServer / reconnecting / needsToken）决定给哪几个：

| 状态 | 什么时候 | 文案 | 按钮 |
|---|---|---|---|
| ready | 连上了 | — | 整条不渲染 |
| connecting | 首轮连接、掉线后的重试、外部地址的等待 | 目标 + 阶段（"正在启动内部 DSH…"/"正在连接内部 DSH…"/"正在连接外部 DSH（地址）…"）；有失败详情时详情优先 | 停止连接 + 查看日志 |
| 按钮态（stopped / error） | 关掉自动连接、用户点过停止、内部不在而外部不可用（stopped）；启动/认证类失败（error，文案改用原因） | 两轴短语併一行：内部 DSH：未运行 · 外部 DSH：可达（分隔符 ·） | 内部在跑 → 连接内部 DSH，不在 → 启动内部 DSH；连接外部 DSH（恒显，没配 url 时置灰 + 悬停提示）；内部在跑时 重启内部 DSH；needsToken 时 输入令牌；查看日志（恒显） |

实现：一个纯函数 src/webview/connectView.ts 的 connectViewOf(state, texts, resolve) 给出三类
状态、文案与按钮集合（顺序即渲染顺序，disabled 与悬停提示也在里面）；App.tsx 的
ConnectionBar 只渲染它的结论（"哪颗按钮发哪条指令"留在 App.tsx 的 CONNECT_POST）。状态字段
（internalRunning / externalState / externalAddress / connectTarget / connectPhase）由控制器的
connectionFieldsOf(snapshot, facts, round) 统一推送（首帧快照与增量 patch 同源，避免两处漂移），
外部地址来自 SupervisorManager.snapshot()。「启动内部 DSH」与「连接内部 DSH」是同一套逻辑
（都传 mayStart: true，用户 2026-09-19 口径）：界面显示的是两轴探测的结论，与后台真实状态之间
必然有偏差（守护进程刚退场、另一个窗口刚拉起、探测的 5 秒节拍），让两者语义相同，用户点哪个
都能把内部后台用起来，不会"点对了按钮却什么都没发生"。拉起这条路不需要扩展额外发指令：
守护进程自己起来就 bringUp() 把 dsh 拉起，扩展只要连上它的 socket 并等就绪。autoConnect 与
这条无关——它只决定激活期要不要自动连，不拦任何用户点击。

### 18.5 配置与命名的连带改动

- dshChat.autoStart → dshChat.autoConnect（含义也变了：关掉 = 完全不自动连，只给按钮），发布
  不久不做旧键兼容（用户 2026-09-18 定）。
- dshChat.url 的描述改成"备用地址"；supervisorIdleSec 去掉"配了外部 Url 时无作用"。
- 命令面板：启动/重启/停止服务器 → 启动/重启/停止内部 DSH（命令 ID 不动），新增
  dshChat.connectInternal / dshChat.connectExternal。
- "要不要令牌"的判据从 externalUrl 非空改成当前目标是不是 external（describeError、
  setNeedsToken）：内部优先之后，配了 url 也可能正连着内部，按 url 判会把内部失败说成"要输入
  令牌"。
- @serverNotRunning / @serverStopped 两个标记删除：按钮态文案改由两轴字段拼，管理器内部改用
  普通英文串（不再有界面发射点，留着会被 i18n 断言判成死文案）。

### 18.6 连接的收场：停止与换目标必须收掉客户端（2026-09-19 修）

用户实测：连着外部 DSH 时把外部服务关掉 → 界面一直反复自动连接；点「停止连接」停不下来；
点「启动内部 DSH」也停不下来。三处叠加：① DshClient 自己带无限重连（ws close → 1s→2s→…→15s
一直重连），从前的「停止连接」只做了"两个布尔量置假 + cancelWaiting()"，没有 dispose 客户端
——它照样重连、照样回调；cancelWaiting() 停的是管理器那侧的等待（waitForHttp /
waitForReadyState），与客户端自己的 ws 重连是两条独立循环，只停一条等于没停。② 换目标没收
旧连接：beginConnect 只改目标与显示状态，旧客户端回调继续写 connection/retryable（没有"这个
client 还是不是当前的"守卫），被 this.client = client 覆盖之后再见没人 dispose——一条永远重试
旧地址的循环留在后台。③ 心跳为外部目标并发建第二个客户端（客户端自己会重连，心跳的"未连接
就再 ensure 一轮"又建一个），两个客户端各带一套跟随流，互相打断。

现在的纪律（connectionStop.test.ts 逐条钉住）：

- prepareRound() = 作废在途轮（connectRoundId + 1）+ cancelWaiting() + teardownStreams() +
  client.dispose()；stopReconnect / beginConnect / autoConnect / reconnectPeer 统一走它。后台
  （守护进程 + dsh）一个字都不动——收掉的只是本窗口的连接。其中「停止连接」在这之上还要交还
  内部后台的占用（releaseInternal，见「停止连接 = 不再占用内部后台」）：prepareRound 收的是与
  dsh 的连接，守护进程那条 socket 归 releaseInternal 管。
- 轮次号：connectOnce 每次取自己的号，苏醒后 roundStale(roundId) 为真就静默让位——不能只靠
  "用户叫停"判据（换目标时用户并没有叫停，但那一轮已经不作数）；作废方不等旧轮结束，它可能
  正挂在没有时长上限的等待里，等它等于不换目标。
- 客户端回调属于某个客户端：回调第一句 if (this.client !== client) return；掉线回调在
  autoReconnect 为假（用户叫停）时不复活 retryable/状态。
- 外部目标的掉线交给客户端自己重连（地址固定，退避重连就能恢复），心跳不再插一脚；内部目标
  必须由扩展重建客户端——守护进程重起 dsh 后端口与令牌都变了。
- 命令面板「DSH: 停止内部 DSH」也经控制器收连接：只发停止请求不收连接的话，dsh 消失后客户端
  会一直重连。

已知取舍/遗留：粘性目标 = 内部崩了不会自动降级到外部（用户明确选择），只给按钮；分组键改成
只按 command 后，旧版本起过的内部后台会落在旧分组目录里、新版本看不见（那套后台没人连着，
会在空闲阈值后自己退场，不需人工清理）；外部可达性是"有 HTTP 应答"，不验证它是不是 dsh
（地址填错时用户从连接失败的日志里看出来）。

### 18.7 换目标是彻底的：切到外部就断开内部那条 socket（2026-09-19 修）

用户实测：内部 dsh 崩掉（守护进程又把它拉起来）之后点「连接外部 DSH」连上了外部，但守护
进程自动重启的那个内部 DSH 一直存在，诊断信息显示的也还是内部 DSH。根因：换目标只换了
"决策"，没换"手里握着的东西"——ensure({target:"external"}) 改了 target、等外部地址、报就绪，
而那条通往守护进程的常驻 socket 一直开着。两个后果：内部 dsh 永远不退场（守护进程的空闲判据
就是"socket 上还有没有活连接"）；诊断显示"用的是内部"（那条连接照旧收 state 推送，onStatePush
把 status 改回内部那一套，诊断命令读的正是 status / peekState()）。

纪律一句话：目标不是内部 ⇒ 与守护进程之间没有任何连接、也没有任何内部状态记忆。

- SupervisorManager.detachInternal(reason) 是唯一落点：关连接 + 清 state + 清 launched/
  clientCount + 作废指向内部那份 status.info。断开不碰任何进程——内部后台退不退场由守护进程
  按"还有没有活连接"自己裁决（没有别的窗口连着 → 空闲阈值后连 dsh 一起收场）。这正是"换到
  外部之后内部该消失、别的窗口还在用就该继续"的正确答案。
- 三个地方各断一次（不靠单一入口的记忆）：ensure() 的外部分支（换目标的主路径）、5 秒心跳
  （兜底，覆盖"还没连上那一轮"、autoConnect 关掉这类路径）、连接回调按目标守卫（onState /
  onGoodbye 都要求"这条连接还是当前的、且目标是内部"才写状态——收尾帧可能正好在断开过程中
  到达，若照旧写，界面会被推回"内部退场/换地址"）。
- peekState() 不再回落到读磁盘：从前 this.state ?? readState(...) 会把磁盘上那份（别的窗口在用
  的、或正在收场的）内部后台当成"本窗口的后台"报出来。
- 控制器两道闸：onServerStatus 在目标为外部时提前返回（内部那套的退场/失败不许改写界面状态）；
  stopServer 在目标为外部时不 prepareRound()（外部那条客户端 + 跟随流一个字都不动，界面也不被
  拉回按钮态）。
- 「停止内部 DSH」在分离态下短暂接入（stopDetachedInternal：不写进 this.connection、onState 是
  空实现、发完 stop 就断）——不接入的话这条命令只能记一条日志。回执按"请求到底有没有发出去"
  给：内部守护进程不在时如实说「内部 DSH 没有在运行」，不再谎报"已停止"。
- 诊断连带改动：多一行「当前连接目标：内部 DSH（守护进程）/ 外部 DSH（dshChat.url）/ 尚未
  选定」——内部优先之后，"地址 + 是不是本扩展启动的"已不足以回答"我现在连的是哪一个"，而这
  恰是用户打开诊断要问的第一个问题。
- 测试写法实测事实：服务端 socket 必须挂了 data 监听才会收到对端 destroy() 的 close——paused
  的 socket 不跑读循环；真实守护进程本来就挂了 data（解析 control 请求），假服务端要照它写，
  否则数的不是同一件事。

### 18.8 「停止连接」= 不再占用内部后台（2026-09-19 用户口径）

口径：不连就不占用。此前「停止连接」只收掉与 dsh 的连接（客户端 + 跟随流）与重试循环，守护
进程那条 socket 留着——它永远认为"还有人在用"：内部 dsh 不会按空闲退场，它的推送还能把界面
从"已停止"拉回"连接中/错误"；更糟的是那条 socket 掉了之后，心跳会 readState + isProcessAlive
再 connect() 把它接回来（接入分支排在 stoppedByUser 检查之前，那个标志只管"不许拉起"，挡不住
"接上已经在跑的"）。现在两件事必须同时做（少任何一件等于没做）：

| 动作 | 落点 | 少了它的后果 |
|---|---|---|
| 断：关掉与守护进程的连接 | SupervisorManager.releaseInternal() → detachInternal() | 守护进程一直把本窗口算作"还有人用"，内部 dsh 永不空闲退场 |
| 挡：置位 detachedByUser，心跳不许自动接回 | heartbeatTick 里那道必须排在 connection.connected 之前 | 断开后 5 秒，心跳发现"会合文件里那套还活着"又接上了——用户看到"点了停止，过一会儿又连上了" |

配套三处（不一致就会露馅）：bringUp() 清掉 detachedByUser——它是"有人显式要这套后台"的通行证
（发消息 / 三个连接按钮 / 重启 / 激活期选路），少了它用户叫停之后就再也连不回来；
abandonRound() 再 release 一次——一轮排队/重试的连接可能在叫停之后才走到 bringUp（那会清掉
标记）并在管理器侧把连接建起来，而控制器随后因为"用户叫停"放弃这一轮，连接就留在了管理器
手里（幂等，所以无脑再收一次）；peekState() 在 detachedByUser 时返回 undefined——占用已交还、
随时会退场，这时再报它的 pid 就是在说"我在用它"（诊断命令读的就是这里）。

代价说清楚：内部后台真退场之后，下一次发消息走"拉起一套"（冷启动 5~8 秒）；别的窗口还在连着
时它继续服务——那正是正确的结果。进程一个都不动这条纪律不变：退不退场由守护进程按"还有没有
活连接"自己裁决。

顺带修掉一个判据错误：stopAndExit()（「停止内部 DSH」）原来按"目标是不是内部"决定要不要短暂
接入，现在按"手里有没有活连接"——按目标判会把"交还占用后守护进程仍在空闲窗口里活着"误当成
"没有可停的东西"，回执谎报「内部 DSH 没有在运行」——而它明明在跑。

交还之后再点「重启内部 DSH」也必须真的重启：这条路径在停止连接之后是常态，而 restart() 原来
在"连接不在"时直接 return this.ensure(...)——只接上、一个控制帧都没发，控制器与扩展却照旧弹
"DSH 服务器已重启。"。现在先接上、再照旧发 restart；同时 previous = this.state?.serverPid（判
supervisor 是不是还没开始重起）必须挪到接上之后——早读时 this.state 是空的、previous 为
undefined，那句 state.serverPid === previous 永远不成立，会把旧地址当成"重启完成"报出去（症状：
令牌没变、地址照旧）。

回答"停止连接之后还能不能连上这个守护进程"：能，但只由用户显式动作触发——「连接内部 DSH」/
「启动内部 DSH」（同一套逻辑：有就接上、没有就起一套）、发消息/新建/切会话、「重启内部 DSH」，
以及重载窗口或新开窗口（新管理器不继承这两个标记，按激活期选路自动接上）。自动路径（5 秒
心跳）不会替你接回去——那正是 detachedByUser 存在的意义。

### 18.9 autoConnect 改动即时生效，只有 url / command 要重载窗口（2026-09-19 用户口径）

autoConnect 只是自动路径的许可，改完不该弹「重载窗口」；url / command 决定"连哪个服务器、怎么
拉起"，只在激活期读一次，才是真正要重载的。生效路径：

- 配置监听拆开（extension.ts）：dshChat.url / dshChat.command 改动照旧 promptServerReload()；
  dshChat.autoConnect 改动走 ChatController.applyAutoConnect() 即时应用，不再提示重载窗口。
- applyAutoConnect(value)：先 SupervisorManager.setAutoConnect(value) 更新自动路径许可
  （canStart() 即时反映，心跳"自己拉一套"、省略 start 的 ensure() 立刻按新值走）；改开
  （false → true）时，若当前正停在按钮态且从没定过目标（stopped/error 且 target 未定——正是
  "关掉后只显示按钮"那一档），按激活期那套选一次路连上，正在连接 / 已连上 / 用户点过按钮
  （有粘性目标）都不动——配置改动不该打断正在跑的会话，也不该替用户收回他显式停过的连接；
  改关（true → false）只更新许可，已建立的连接一个字都不动，用户想立即断开照旧用「停止连接」。

### 18.10 停止入口收敛 + 管理器只读快照：一份状态，控制器只渲染（2026-09-19）

同一个"收掉/停止"曾散在六个方法里（detachInternal / releaseInternal / cancelWaiting /
stopAndExit / stopDetachedInternal / stop），各自做不同子集，正确性靠配对：漏置闸 → 5 秒后心跳
自己接回来；漏 cancelWaiting → 点了停止还在等一个永不来的就绪；漏断连接 → 守护进程以为有人
用、dsh 不按空闲退场。现在管理器只有一个入口 stop(options?: { release?, cancelWait?,
askSupervisor? })：

| flag | 含义 | 少了它会怎样 |
|---|---|---|
| release | 交还本窗口的占用（「停止连接」那一档）：置 detachedByUser 闸，再收连接 | 守护进程永远认为有人用，内部 dsh 不按空闲退场 |
| cancelWait | 中止所有在途等待（单独给出时不收连接） | 用户点了停止还在等一个不会来的就绪 |
| askSupervisor | 请守护进程连 dsh 一起收场（没有活连接时走临时接入） | 命令面板上的「停止内部 DSH」只能记一条日志 |

不给 options 时按旧 stopAndExit() 走（cancelWait + askSupervisor）——smoke 与若干探针还写着
server.stop()，要"只收连接"必须显式写 stop({})。旧方法名一个都没删（薄壳，方法名与签名不变，
供探针继续调用）；连点合并（在飞标记）只覆盖"发控制帧"那一支，两道闸与中止等待在合并之前
落地，所以第二次调用不会漏掉自己那组 flag。

控制器侧四个落点各调哪一档（调错档不报错，只会在用户那里表现为"点了没反应"）：

| 控制器落点 | 调哪一档 | 少了它会怎样 |
|---|---|---|
| prepareRound()（换目标 / 重开一轮 / 并发补跑）与 ensureConnected() 换目标那一支 | stop({ cancelWait: true }) | 那一轮还挂在旧目标没有时长上限的等待里。这一档不收连接：马上要重新接上的是同一个后台，收掉 socket 等于交还占用、ownership 从 self 掉成 peer |
| abandonRound()（用户叫停后放弃这一轮） | stop({ release: true }) | 一轮排队/重试可能在叫停之后才走到 bringUp（清掉 detachedByUser）并把连接建起来，而控制器随后放弃了这一轮 |
| stopReconnect()（「停止连接」） | stop({ release: true }) | 只断不挡 → 5 秒后被接回；只挡不断 → 内部 dsh 不按空闲退场 |
| stopServer()（「停止内部 DSH」，两条分支） | stop({ cancelWait: true, askSupervisor: true }) | 请求都发出去了再等就绪没有意义；没有活连接时管理器走临时接入那条路 |

配套的另一半是只读快照 snapshot()（17 个字段，全部取自既有读法）：控制器不再镜像管理器。
连接那组界面字段由 controller.ts 的模块级纯函数 connectionFieldsOf(snapshot, facts, round) 一次
算出——管理器那一半（外部地址）读快照、本窗口那一半（客户端状态机：连上没有、详情、令牌
入口）读 round、两轴探测结论（内部守护进程在不在、外部可不可达）读 facts（不在快照里：判据是
probeRunning() 与一次 HTTP GET，都是异步探测）。internalRunning / externalReachable 两个镜像
字段合成一份 facts，externalState() / viewConnection() 两个判定删除；autoReconnect / target /
connectRoundId / retryable / needsToken 留下，关键理由两条：① detachedByUser 只挡"接回内部那
套"，不挡"重试外部那条连接"——用户点过「停止连接」后再点「连接外部 DSH」时 ensure() 的外部
分支不经过 bringUp，闸仍是 true；② 快照的 target 回不到 undefined，而 autoConnect 改关时控制
器要清空它、改开时靠"从没定过目标"重新选路。界面侧同样只有一处判定：connectViewOf（见按钮
矩阵一节）。

### 18.11 验证（一行）

connectTarget.test.ts（选路六组合、外部三态、纯函数）；supervisorPolicy.test.ts（没许可不
spawn、守护进程活着只接入、外部那轮必须显式传 target、换目标彻底断开（真 socket 数活连接）、
releaseInternal 后心跳不接回、交还后再 restart 收到控制帧并拿到新地址/新令牌）；
connectView.test.ts + styles.test.ts（矩阵逐格、查看日志恒显、四颗目标按钮仍有指令）；
i18n.test.ts（标记双向对齐、删除的标记不复活）；connectionStop.test.ts + clientDispose.test.ts
（prepareRound 四件事、客户端回调身份守卫、dispose 后零状态变化，真实 ws）；
connectSnapshot.test.ts（快照 17 字段）；autoConnectConfig.test.ts（applyAutoConnect 三件事）；
supervisor-manager-probe.mjs（真 supervisor + 真 dsh 端到端：连内部 → 切外部 → 内部后台自己
退场；releaseInternal 后退场；交还后再 restart 拿到变了的新令牌）。
