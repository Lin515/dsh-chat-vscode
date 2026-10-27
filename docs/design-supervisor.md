# 后台与连接：supervisor 设计

修改后台生命周期、启动许可、认证或连接链路前读本文。扩展只做客户端，独立 supervisor 持有 DSH；后台是否存活由控制连接与显式停止请求决定，不由窗口之间协商。

## 生命周期与进程拓扑

**窗口负责使用或停止使用，supervisor 负责启动、看护和回收 DSH。关闭窗口不等于立即关闭后台。**

```text
VS Code 窗口 A ──控制 socket──┐
                            ├──→ supervisor
VS Code 窗口 B ──控制 socket──┘        │
                                      │ 启动、看护、回收
                                      ▼
                                  dsh web
                                      ▲
窗口中的聊天客户端 ──HTTP / WebSocket──┘
```

- 一条控制长连接代表一个窗口正在使用后台。多个窗口可以共用一套后台；聊天直接连接 DSH，不经 supervisor 转发。
- 分组只按有效 command（sha256 前 12 位），url 不改变内部后台身份；不同命令对应不同的内部后台。
- supervisor 以 detached + unref 启动，启动它的窗口关闭后，其他窗口仍可使用，启动在途也能继续完成。
- 控制协议只有 restart / stop，没有「启动 DSH」控制帧。`ensure({start:true})` 允许启动不存在的 supervisor，DSH 由 supervisor 自启；不提供脱离 DSH 单独常驻的形态。
- 扩展不直接杀 DSH。整套退场和 DSH 重启均由 supervisor 执行，进程回收遵守「运行时与安全约束」。

## 启动协议

### 有则复用，没有才启动

```text
窗口需要内部 DSH
       │
       ▼
读取会合状态，检查 supervisor
       │
       ├─ 正常存活 ──→ 先接控制 socket ──→ 等 DSH 就绪 ──→ 使用
       │
       ├─ 正在退场 ──→ 等旧世代清理或被替换 ──→ 重新判断
       │
       └─ 不存在
              │
              ├─ 本次不允许启动 ──→ 不启动，保留适用的重连意图
              │
              └─ 本次允许启动 ──→ 抢启动锁 ──→ 启动 supervisor
                                                  │
                                                  ▼
                                            supervisor 自启 DSH
                                                  │
                                                  ▼
                                            发布地址 / token
                                                  │
                                                  ▼
                                                窗口接入
```

1. supervisor 活着时先接 socket，再等可用状态。控制连接本身表示使用，DSH 已退出时 supervisor 也据此决定重启它；不能因 HTTP 暂不可达就另起一套。
2. supervisor 不存在且本次允许启动时抢独占锁；赢家启动，其他窗口读取同一会合文件等待。
3. supervisor 先监听、发布 starting，再启动 DSH；解析公告行 `dsh web: http://…/?token=…` 后发布地址 / token。公告行是地址与令牌的唯一真相。
4. 发现 `stopping` 的启动入口先等旧世代退场，具体上限见「等待与时间边界」。不能把退场中的后台当成可用，也不能因等不及而另起第二套。等待期间的每轮就绪检查也须排除 `stopping`；「不能就绪」不等于「可以另起后台」，启动锁内的复查同样不能把仍活着的退场世代当成不存在。

管理器的启动入口与 supervisor 的 `bringUp()` 都合并并发。DSH 重启先回收旧进程、清旧地址再发布 starting，正常完成时先清 starting 再 publish；所有退出路径复位在飞状态。socket 连续失败但进程活着时可核对状态文件新鲜度，不能困在失效 socket。

### 能不能启动后台是一条显式许可

`autoConnect` 只约束自动路径，而且只作 `ensure()` 省略 `start` 时的默认值。关掉时激活期只探测 / 显示按钮；用户显式动作不受它限制，也不因它关闭而失去已选连接。

| 入口 | 是否允许启动 |
|---|---|
| 激活期自动连接 | 按 `autoConnect` 与选路结果决定；不一定启动内部，也可能连接现有内部、外部或桌面端 |
| 用户显式发送 / 新建 / 切会话 | `start: true`，沿用目标；目标未定才选路，不代表每次都启动内部 |
| 「启动内部」「连接内部」 | 同一逻辑：有则连接、无则启动，均为 `start: true` |
| 重启内部 DSH | 允许启动；现有 supervisor 上的 restart 只重启 DSH，不替换 supervisor |
| 连接外部 | `start: false`，只连接指定服务，永不启动进程 |
| 激活期之后的心跳 / 自动重试 | 只接已有后台，不启动新的 supervisor |

### 自动连接只做一次

自动探测、选路与必要时启动后台，一个扩展宿主只做激活期那一趟：`startup()` 清完文档锁后调用 `ChatController.autoConnect`，`activationConnect` 保存闸与在飞结果，重复调用只返回同一条链。

真正的 VS Code「重载窗口」会重开扩展宿主，新宿主仍执行自己的激活期连接；聊天页面（webview）重载不会重开宿主，不再选路或启动后台。

| 自动路径 | 行为 |
|---|---|
| 管理器心跳（5 秒） | 只接入已在跑的内部后台；会合文件 / 进程不在时不 spawn；遵守目标、交还占用与停止世代检查 |
| 控制器心跳 | 未连接时只 `ensureConnected({start:false})`；暂缺内部后台时不发起连接，保留适用的重连意图 |
| webview 重载 / `ready` / 恢复 hint / 补空壳 | 只消费激活期在飞结果与现有连接，不发起新连接 |
| `dshChat.autoConnect` 热改 | 只更新默认许可，不触发连接，不打断已建连接 |

webview 的 `ready` / 恢复可能早于清锁收尾。此时 `awaitActivationConnect` 只等待激活期结果，保留恢复 hint，待 `onConnected` 接回历史会话，不得补成空壳。

## 存活、看护与自动退出

```text
                    supervisor 运行中
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
            还有控制连接              没有控制连接
                │                       │
         ┌──────┴──────┐                ▼
         ▼             ▼             等空闲期限
      DSH 正常      DSH 进程退出         │
         │             │          ┌─────┴─────┐
         ▼             ▼          ▼           ▼
      继续保留      自动重启 DSH  窗口又接入   到期仍无人使用
                                   │           │
                                   ▼           ▼
                                继续保留     整套退场
```

**占用看控制连接，不看有没有聊天消息。** 窗口长时间不聊天，只要控制连接还在，后台就继续保留。

supervisor 主循环约每秒检查一次：

- DSH 进程消失且仍有控制连接：重启 DSH，发布新地址 / token；各窗口重新认证、重建客户端。
- 没有控制连接：不因 DSH 退出而重启它，等待空闲退出。
- 自动空闲退出必须同时满足：不在启动 DSH、控制连接数为 0、已过启动保护期、距最后活动达到 `supervisorIdleSec`。

`lastActiveAt` 由接入、收到控制数据（含 ping）和 DSH 启动成功刷新；并非最后一条连接断开的精确时刻。空闲阈值默认 10 秒、范围 5–600，热读生效。启动保护期固定按启动时阈值计算，为 supervisor 启动时刻加 `idleSec + 10` 秒，避免窗口还未来得及接入就自动退场；启动 DSH 在途时也不做空闲退出。

`childGone()` 看 `exitCode` / `signalCode` 或进程判活，不能看 ChildProcess 对象是否存在。看护只覆盖进程消失，不覆盖进程仍活着但服务卡死。supervisor 自己崩溃后，没有另一个后台负责复活它；窗口心跳也不会启动替代 supervisor，一般失联处理见「已知终结与一般失联」。

## 停止与换目标

### 用户动作与影响范围

| 操作 | 本窗口 | 其他窗口与后台 |
|---|---|---|
| 停止连接 | 断控制连接，设置 `detachedByUser`，不自动接回 | 其他窗口不受影响；无人使用时等待空闲退出 |
| 关闭窗口 / 扩展宿主退出 | dispose 管理器，取消等待、停止心跳、断本窗口连接 | 其他窗口继续使用；无人使用时等待空闲退出 |
| 切换外部或桌面端 | 交还内部连接，连接新目标 | 不杀内部进程；是否空闲退出由剩余占用决定 |
| 停止内部 DSH | 向对应分组的 supervisor 请求整套退场 | 不等待空闲期限，不考虑其他窗口是否仍在使用；共用后台的窗口也会断开 |
| 重启内部 DSH | 接上 supervisor 后发 restart，等待新地址 / token | supervisor 保留，只重启 DSH；其他窗口短暂断连后跟随新端点 |

「停止连接」必须同时断 socket 和置闸：只断不断闸会被心跳接回，只挡不断连接则后台永不空闲。显式 `bringUp()` 清闸；迟到轮被放弃时再幂等交还一次。dispose 是单向终结，不允许在途回调复活管理器。

「停止内部 DSH」没有常驻连接时临时接入发 stop，随即断开，不保留占用、不污染当前外部客户端。回执只说明请求是否发出，不代表后台已退出。本窗口没配 `dshChat.command` 时命令直接忽略，回执是「没有配置」而非「没有在运行」；不同命令分组的后台不是本窗口可停止的内部后台。

用户停止后，管理器用 `stoppedGeneration`（supervisor PID + 启动时刻）阻止心跳接回被要求停止的同一代，为请求未生效时的空闲退出保留机会。记账必须绑定本次 stop 选定的发送对象：已有连接时用该连接所属世代，没有常驻连接时用同一份磁盘快照完成记账和临时接入；不能简单地总取内存或总取磁盘。即使临时接入失败，也保留选定世代以免心跳重新占用；这不表示请求已经送达或执行。并发合并的请求不覆盖在途请求的停止世代。它不是禁止内部这一轴：目标仍为内部、没有 `detachedByUser` 等阻断时，后来启动的新一代仍可接入；显式 `bringUp()` 清除停止世代限制。

### 手动停止与空闲退出共用收尾

```text
收到 stop / SIGTERM / SIGINT ──┐
                              ├──→ shutdown：只执行一次
无人使用且满足空闲条件 ───────┘              │
                                            ▼
                                将 stopping 写入会合文件
                                            │
                                            ▼
                                 回收 DSH 进程树及遗留监听者
                                            │
                                            ▼
                                 向现有窗口发送 goodbye
                                            │
                                            ▼
                                 清会合状态、socket，关闭日志
                                            │
                                            ▼
                                  supervisor 自己退出
```

`stopping` 表示已开始退场，不是仍可使用。`shutdown()` 在回收进程前先落盘；`probeRunning()` 将其判为内部未运行，启动入口遇到它先等待，心跳不接入。退场时不主动广播这份 state，随后以 `goodbye(stop / idle)` 告别。

发送 stop / restart 后断开也有顺序要求：`SupervisorConnection.close()` 先 `end()` 冲刷排队数据，对端迟迟不关闭才由 2 秒兜底 `destroy()`。禁止 `end()` 后立即 `destroy()`，否则 hello 后排队的控制帧可能丢失，表现为窗口已停止而后台没有收到 stop。冲刷不是业务确认，不能据此承诺进程已退出。

收尾日志失败不能掐断停用路径。`shutdown()` 的副作用须立即执行，不能只创建守卫回调而不调用；完成清理后给 socket 短暂发送 goodbye 的机会再退出。

### 已知终结与一般失联

| 证据 | 控制器行为 |
|---|---|
| 收到 `goodbye(stop / idle)`，或用户明确停止 | 已知终结；收掉当前连接与重连意图，回按钮态 |
| `gone`：会合状态暂缺、socket 断开、supervisor 崩溃等 | 一般失联；保持原目标的重连意图，不重选路、不启动新 supervisor |
| `replaced`：被另一连接替换但后台仍活着 | 不视为后台终结，继续按原目标处理 |

是否已知终结取自 `ServerStatus.cause`，不靠一次进程或端口探测推断。某窗口发 stop 后，其他窗口收到告别不会靠心跳重新启动后台；后续要再启动，需用户显式动作或新扩展宿主自己的激活期连接。

`connectionAttempts` 统一作废轮次、取消等待、收跟随流并 dispose 客户端。回调先核对轮次和客户端身份，旧轮不等自己结束就让位；迟到回调不得覆盖新目标。外部固定地址由客户端重连；内部端口 / token 改变时由扩展重建客户端；桌面端重建前必须重新发现，不能只重试原 `baseUrl`。

### 换目标的彻底性

目标不是内部，就没有内部 socket、内部状态记忆或推送写权限。外部分支、心跳与回调身份守卫都落实这条规则；`peekState()` 不回落磁盘。诊断不再报已交还占用的 PID。

「收掉与守护进程的连接」只作废内部就绪信息（`status.info.ownership` 为 `self` / `peer`），不能顺手清掉外部或桌面端的 `status.info`；非内部目标下，心跳也会经过内部连接清理。

### 停止入口与只读快照

`stop(options?: { release?, cancelWait?, askSupervisor? })`：

| 调用 | 用途 |
|---|---|
| `stop({})` | 仅收连接，不置闸 |
| `stop({cancelWait:true})` | 只取消等待，不交还同一后台占用 |
| `stop({release:true})` | 用户停止或迟到轮放弃，交还占用并挡自动接回 |
| `stop({cancelWait:true,askSupervisor:true})` | 停止内部 DSH，必要时临时接入 |
| `stop()` | 兼容旧入口，等同取消等待 + 请求 supervisor 收场，不是仅收连接 |

控制帧在飞合并不吞后续调用的 flag；置闸与取消等待先落实。交还后重启须先接上再发 restart，接上后再读旧 PID，等待新地址 / token。

`snapshot()` 是管理器只读出口；客户端轮次、三轴探测与管理器快照是不同事实，不合成错误镜像。`stop({})` 后不再连接或记忆内部后台，但快照仍可能读到磁盘上的共享状态；需要连磁盘回退也屏蔽时用 `release`。

## 等待与时间边界

**等待 DSH 就绪与等待旧 supervisor 退场不是同一种等待。**

| 时长 / 条件 | 用途 | 不代表什么 |
|---|---|---|
| 就绪等待不设总 deadline | 等可用状态，成功、明确失败或 AbortSignal 结束本轮 | 不表示每个内部操作都没有超时 |
| 旧世代退场最多等待 30 秒 | `waitForStopping()` 约每 200ms 检查会合文件、世代与进程；状态消失、换代或进程退出即可重新判断 | 不强杀旧 supervisor，不因到期另起第二套，不是 DSH 启动时限 |
| 空闲阈值默认 10 秒，范围 5–600 | 无控制连接且满足保护条件后自动退场 | 不按聊天消息是否活跃判断 |
| 启动保护期为初始 `idleSec + 10` 秒 | supervisor 刚启动时暂不做空闲退出 | 不限制启动耗时，也不限制显式 stop |
| 控制连接关闭兜底 2 秒 | 先冲刷写队列，再强制销毁迟迟不关闭的 socket | 不是 DSH 进程树回收时限 |
| 单次外部 fetch 探测超时 2 秒 | 约束一轮外部可达性探测 | 不是整个连接过程的期限 |
| `SPAWN_GRACE_MS` 为 120 秒 | `startServer()` 单次启动尝试等待 DSH 公告地址的上限，超时结束本次尝试 | 不是扩展整体连接等待的期限 |

启动入口初次读到旧代退场时，30 秒后若同一套仍在退场，管理器结束本次尝试，报 `ServerNotRunningError`；不把它当成可用后台，也不再启动一套。控制器将此错误保留为可重试的连接态，而非必然回按钮态；自动重试仍不取得启动许可。若在后续就绪轮询或启动决策复查中才遇到退场状态，则继续排除它、等待可用状态，仍可取消，不把 30 秒扩展成就绪等待的总期限。

`cancelWaiting()` 中止在途等待，由等待链抛 `WaitCancelledError`，控制器视作用户叫停而非错误；不是调用 `cancelWaiting()` 时同步抛出。苏醒后与客户端建好后均检查轮次是否已作废。

## 传输层与磁盘协议

socket 管 ping、控制、状态与错误；文件只管跨世代会合，不每秒写心跳。窗口每 1 秒 ping，管理器与控制器自检共用 5 秒心跳，不另起重连节拍。地址改变时用新 token 换 cookie 并重建客户端，cookie 绑定 authority。

会合目录为 `<DSH_HOME>/dsh-chat-vscode/supervisors/<指纹>/`，默认 DSH_HOME 为 `~/.dsh`：

| 资源 | 用途 |
|---|---|
| `supervisor.json` | version、PID、baseUrl、token、command、idleSec、socket、启动时刻、starting 与 stopping；tmp + rename 原子写 |
| `supervisor.lock` | `wx` 独占启动锁，验证持有者身份后才清孤儿锁 |
| `supervisor.log` | supervisor 与 DSH 输出，窗口不在时仍可诊断 |
| socket | 非 Windows 为分组内 `sup.sock`，Windows 为 `\\.\pipe\dsh-chat-<分组>`；残留先探活，不盲删 |

`rendezvousPaths()` 唯一产出路径；`decodeState()` 统一文件与 socket 解码。baseUrl 必须是可解析 http(s)、token 非空、PID / 时刻为整数、command / socket 非空；这些字段决定凭据去向。文件要求版本，socket 缺 idleSec 用显式 0，不替对方编默认值。读不懂的消息忽略。

### 运行时与安全约束

固定用 VS Code 自带 Node（`process.execPath`，必要时 appRoot 兜底），`ELECTRON_RUN_AS_NODE=1`，产物 target node20；不要求 PATH 上有 Node，也不提供运行时配置。supervisor 随包分发。启动 DSH 子进程时清掉 Electron 的 Node 模式变量，避免把 VS Code 当 Node 命令跑；记录 execPath / Node / Electron 版本供诊断。

进程回收不能只看 shell 外层 PID：重启、退场与遗留进程清理按端口寻找真实监听者，并先取得进程身份的肯定证据，证据不足不操作。保留公告行解析、令牌私有目录、异步进程查询、孤儿 writer lock 清理与永不抛错的 hostLog。

## 存在性判据

| 轴 | 判据 | 边界 |
|---|---|---|
| 内部 | `probeRunning().supervisorAlive` | DSH 正在启动 / 重启仍算内部存在，避免另起一套；`stopping` 不算内部运行 |
| 外部 | 配了 url 且当前有 HTTP 应答 | 401 / 403 也算可达，不证明对端是 DSH；仅未连接时探测 |
| 桌面端 | 配了 `desktopExecutable`，且发现与鉴权都通过 | 进程在不等于可连接；机制见[桌面端接入](<design-desktop.md>) |

内部探测只读文件与进程，不参与占用。三轴异步事实由 `probeFacts()` 统一维护，不能把磁盘上别的窗口的后台当成本窗口已连接的后台。

## 选路与粘性目标

`connectTarget.chooseTarget()` 按以下优先级选路：

```text
内部已配置且在跑 → 连接内部
        否则    → 外部已配置且可达 → 连接外部
        否则    → 桌面端已配置且可连接 → 连接桌面端
        否则    → 内部已配置 → 启动内部
        否则    → 桌面端已配置 → 启动桌面端
        否则    → 无可选目标，显示按钮并记日志
```

前三支 `start: false`，后两支才允许启动。`dshChat.command` 留空时内部整条轴跳过，绝不兜底拿空命令 spawn。桌面端的发现、鉴权与可连接判据见[桌面端接入](<design-desktop.md>)。

自动选路只发生在激活期那一趟。心跳、重试与 webview 重载不切服务器，不重新选路；显式发送 / 新建 / 切会话沿用已有目标，未定时才按同一规则选路。外部恒 `mayStart=false`；桌面端的启动 / 连接按钮与内部同口径，有则接入、无则启动，单实例桌面端重复启动只聚焦已有窗口。

这是有意取舍：换目标会换会话列表并离开当前轮次，所以内部故障不自动降级到外部；换既有目标必须由用户显式选择。

认证按 `ownership` 三向分叉，不按是否配了 url 或是否本窗口启动：内部 self / peer 都以会合 token 换 cookie，被拒时重读一次状态；外部走「保存的会话 cookie → 启动令牌 → 输入令牌」链；桌面端用扩展自铸的浏览器会话票，凭据不可用时只报错。内部与桌面端均不出现输入令牌入口。

## 连接条按钮矩阵

界面判定只在 `connectViewOf()`；宿主字段只在 `connectionFieldsOf(snapshot, facts, round)`，控制器不镜像管理器状态。

| 状态 | 文案 / 按钮 |
|---|---|
| ready | 不渲染连接条 |
| connecting | 目标 / 阶段或失败详情；停止连接 + 查看日志 |
| stopped / error | 各轴短语或明确错误；内部运行则连接内部，否则启动内部；连接外部恒显、未配置置灰；配置了 `dshChat.desktopExecutable` 时另给桌面端按钮，按认人结果二分「启动 / 连接 DSH 桌面端」；内部运行可重启；外部需要凭据时可输入令牌；查看日志恒显 |
| stopped / error（内部未配置） | 没配 `dshChat.command` 时写「内部 DSH：未配置」，不提供内部启动 / 连接 / 重启按钮，主按钮位让给其他轴（桌面端优先，其次外部）；其余同上一行 |

连接类失败自动重试；启动类与凭据类（`DshAuthError`、桌面端的 `DesktopCredentialError`）不重试，避免错误命令 spawn 风暴或反复使用无效凭据。缺明确证据时按连接类处理。

桌面端失败口径见[桌面端接入](<design-desktop.md>)「失败与回落」：票被拒 / 读不到本机密钥 → 按钮态 + 原因，不给输入令牌；没找到服务 → 按连接类接着试；拉起失败 / 等不到就绪 → 按启动类停下。

## 配置生效

url / command / desktopExecutable 改动提示重载，不热切服务器。autoConnect 热改只更新默认许可，不触发连接、不打断已建连接，新值用于下一次宿主激活那趟自动连接。idleSec 热读。

`dshChat.command` 留空表示没有内部轴，不探测会合状态、不接入、不启动，也不提供内部按钮，与 `dshChat.desktopExecutable` 留空同口径。扩展不给它回落默认命令；清单 default 只用于从未设置过的用户，不能抹掉用户清空配置表达的意图。

## 验证与未覆盖边界

离线入口按职责分组：

- 选路与视图：connectTarget / connectView / connectSnapshot，以及 i18n / styles。
- 管理器与协议：supervisorPolicy / supervisorProtocol / supervisorErrors、connectionStop / clientDispose。
- 控制帧投递：supervisorClose 使用真 socket 与迷你服务端，验证 hello 后的 stop 在主动断开前完整送达，且不触发意外断线回调。
- 激活与重连：autoConnectConfig / autoConnectOnce 驱动真控制器，覆盖激活期并发合并、关闭自动连接、迟到选路让位、普通失联只重连原目标、已知终结回按钮态、换端点重建、热配置不触发连接、显式停止与启动升档，以及早到 ready 后恢复历史会话。
- 不自动复活：supervisorNoRespawn 使用真 socket 假守护进程，覆盖多窗口、瞬断只复接现有后台、终结后心跳不 spawn。supervisorPolicy 另覆盖 stopping 探测与用户停止后的同代不回连、新代可接入。

`supervisorPolicy` 还覆盖以下并发边界：

- 等待途中会合状态变为 `stopping`，即使仍带地址、端口仍可达，也不判为 ready，并可取消等待；启动决策途中遇到仍存活的退场后台，不另起第二套。
- 缓存旧代、磁盘新代且没有活连接时，临时 stop 与停止记账使用同一份磁盘快照；有活连接时，按该连接的世代记账，不受缓存被磁盘新代覆写影响。
- 并发合并的 stop 不重新选择对象或覆盖停止世代；各次调用的取消等待、释放占用等标志仍立即落实。

真 socket 假服务端必须读 data，否则 paused socket 不触发预期 close，不能假称测了占用释放。离线断言不等于真实进程回收已验证；用假守护进程不执行 stop 的场景验证兜底，也不等于正常停止仍会失效。

真实 supervisor / DSH 探针按[验证约定](<../AGENTS.md>)另获当次批准，使用真 Manager 入口与临时目录硬断言，不能手抄流程替代。历史短间隔复接未跨越启动保护期，不证明超保护期后的同 PID 复接；进程存活但服务卡死也未实现自动重启。历史通过套数与一次性采样不作为当前验收结果。
