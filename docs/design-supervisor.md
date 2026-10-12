# 后台与连接：supervisor 设计

修改后台生命周期、启动许可、认证或连接链路前读本文。扩展只做客户端，独立 supervisor 持有 DSH；不再由窗口协商后台生死。旧租约、心跳文件与实现批次不作为当前规则。

## 生命周期与进程拓扑

多个窗口各持 socket 长连接 → 一个 supervisor → 一个 `dsh web`。分组只按有效 command（sha256 前 12 位），url 不改变内部后台身份。

- 重载窗口只断本窗口连接；其他窗口复用同一后台。窗口关闭 / 崩溃后，连续空闲达到 `supervisorIdleSec` 才退场，默认 10 秒、范围 5–600；启动在途不退场。
- supervisor 启动后立即拉 DSH；DSH 进程消失且仍有客户端则重启，无客户端则退场。stop 与 idle 都先收 DSH 整棵树，再收会合状态与自身。
- 扩展不直接杀 DSH。遗留进程回收与收尾按端口寻找真实监听者，先取得进程身份的肯定证据；shell 外层 PID 不等于服务器 PID。
- `childGone()` 看 `exitCode` / `signalCode` 或进程判活，不能看 ChildProcess 对象是否存在。只覆盖进程消失，不覆盖进程仍在但服务卡死。

### 同生共死

控制协议只有 restart / stop，没有「启动 DSH」控制帧。`ensure({start:true})` 是允许拉起不存在的 supervisor；DSH 由 supervisor 自启。不要添加能脱离 DSH 单独常驻的形态。

## 传输层与磁盘协议

socket 管 ping、控制、状态与错误；文件只管跨世代会合，不每秒写心跳。窗口每 1 秒 ping，管理器自检共用 5 秒心跳，不另起重连节拍。

会合目录为 `<DSH_HOME>/dsh-chat-vscode/supervisors/<指纹>/`，默认 DSH_HOME 为 `~/.dsh`：

| 资源 | 用途 |
|---|---|
| `supervisor.json` | version、PID、baseUrl、token、command、idleSec、socket、启动时刻与 starting；tmp + rename 原子写 |
| `supervisor.lock` | `wx` 独占启动锁，验证持有者身份后才清孤儿锁 |
| `supervisor.log` | supervisor 与 DSH 输出，窗口不在时仍可诊断 |
| socket | 非 Windows 为分组内 `sup.sock`，Windows 为 `\\.\pipe\dsh-chat-<分组>`；残留先探活，不盲删 |

`rendezvousPaths()` 唯一产出路径；`decodeState()` 统一文件与 socket 解码。baseUrl 必须是可解析 http(s)、token 非空、PID / 时刻为整数、command / socket 非空；这些字段决定凭据去向。文件要求版本，socket 缺 idleSec 用显式 0，不替对方编默认值。读不懂的消息忽略。

### 运行时选型

固定用 VS Code 自带 Node（`process.execPath`，必要时 appRoot 兜底），`ELECTRON_RUN_AS_NODE=1`，产物 target node20；不要求 PATH 上有 Node，也不提供运行时配置。supervisor 以 detached + unref 启动并随包分发。启动 DSH 子进程时清掉 Electron 的 Node 模式变量，避免把 VS Code 当 Node 命令跑；记录 execPath / Node / Electron 版本供诊断。

## 启动协议

1. 读会合状态；supervisor 活着时先接 socket，再等可用状态，不能因 HTTP 暂不可达就另起一套。
2. 不存在时抢启动锁；赢家拉 supervisor，其他窗口读取同一会合文件等待。
3. supervisor 监听、发布 starting、启动 DSH，解析公告行 `dsh web: http://…/?token=…` 后发布地址 / token。公告行是地址与令牌的唯一真相。

启动入口合并并发，所有退出路径复位在飞状态；正常路径先清 starting 再 publish。日志写入失败不许掐断停用路径。socket 连续失败但进程活着时可核对状态文件新鲜度，不能困在失效 socket。

### 长连接与自检

地址改变时用新 token 换 cookie 并重建客户端；cookie 绑 authority。supervisor 崩溃时自检重新拉起，遗留 DSH 按肯定身份回收。DSH 自身退出由 supervisor 处理，启动窗口关闭不影响 detached 进程完成启动。

### 能不能启动后台是一条显式许可

`autoConnect` 只约束激活、恢复与心跳等自动路径。关掉时只探测 / 显示按钮，不启动进程；显式发送、新建、切会话、启动、连接或重启内部 DSH 均允许启动。

「启动内部」与「连接内部」同一逻辑：有则连接、无则启动；连接外部不启动任何进程。真实认证 / 启动失败停止自动重试，连接失败则继续等用户叫停。

### 等待没有时长上限

扩展等待就绪不设总 deadline，只以成功或 AbortSignal 结束。`cancelWaiting()` 抛 WaitCancelledError，控制器视作用户叫停而非错误；苏醒后与客户端建好后均检查轮次是否已作废。

单次外部探测的 2 秒 fetch 超时保留；supervisor 的 SPAWN_GRACE_MS=120 秒是内部重试节奏，不是扩展放弃连接的期限。

## 两条存在性判据

| 轴 | 判据 | 边界 |
|---|---|---|
| 内部 | `probeRunning().supervisorAlive` | DSH 正在启动 / 重启仍算内部存在，避免另起一套 |
| 外部 | 配了 url 且当前有 HTTP 应答 | 401 / 403 也算可达，不证明对端是 DSH；仅未连接时探测 |

内部探测只读文件与进程，不参与占用。两轴异步事实由 `probeFacts()` 统一维护，不能把磁盘上别的窗口的后台当成本窗口已连接的后台。

## 选路与粘性目标

`connectTarget.chooseTarget()`：内部存在 → 内部；否则外部已配置且可达 → 外部；否则启动内部。自动选路只在激活或从未选过目标时发生，心跳 / 重试不切服务器。

这是有意取舍：换目标会换会话列表并离开当前轮次，因此内部故障不自动降级到外部。显式按钮才能换目标。发送 / 新建 / 切会话沿用目标，未定则内部；外部 always mayStart=false。

认证按 `ownership === "external"` 分叉，不按是否配了 url 或是否本窗口启动。内部 self / peer 都以会合 token 换 cookie，被拒时重读一次状态；内部不出现输入令牌入口。

## 连接条按钮矩阵

界面判定只在 `connectViewOf()`；宿主字段只在 `connectionFieldsOf(snapshot, facts, round)`，控制器不镜像管理器状态。

| 状态 | 文案 / 按钮 |
|---|---|
| ready | 不渲染连接条 |
| connecting | 目标 / 阶段或失败详情；停止连接 + 查看日志 |
| stopped / error | 两轴短语或明确错误；内部运行则连接内部，否则启动内部；连接外部恒显、未配置置灰；内部运行可重启；外部需要凭据时可输入令牌；查看日志恒显 |

连接类失败自动重试；启动类与 DshAuthError 不重试，避免错误命令 spawn 风暴或反复使用无效凭据。缺明确证据时按连接类处理。

## 停止与换目标

`connectionAttempts` 统一作废轮次、取消等待、收跟随流与 dispose 客户端。回调先核对当前客户端身份；旧轮不等自己结束就让位。外部固定地址由客户端重连，内部端口 / token 会变，由扩展重建客户端。

### 换目标的彻底性

目标不是内部，就没有内部 socket、内部状态记忆或推送写权限。外部分支、心跳与回调身份守卫都落实这条规则；`peekState()` 不回落磁盘。切外部不杀内部进程，是否空闲退场由其他窗口的占用决定。

### 停止连接的语义

「停止连接」同时断内部 socket 与置 detachedByUser 闸，心跳不得接回；只断不断闸会 5 秒后复连，只挡不断会永不空闲。显式 bringUp 清闸；迟到轮被放弃时再幂等交还一次。诊断不再报已交还占用的 PID。

「停止内部 DSH」请 supervisor 整套收场；没有常驻连接时短暂接入发 stop，不污染当前外部客户端。回执按请求是否发出，不谎报成功。交还后重启须先接上再发 restart，接上后再读旧 PID，等待新地址 / token。

### 停止入口与只读快照

`stop(options?: { release?, cancelWait?, askSupervisor? })`：

| 调用 | 用途 |
|---|---|
| `stop({})` | 仅收连接 |
| `stop({cancelWait:true})` | 换轮取消等待，不交还同一后台占用 |
| `stop({release:true})` | 用户停止或迟到轮放弃，交还占用并挡自动接回 |
| `stop({cancelWait:true,askSupervisor:true})` | 停止内部 DSH，必要时临时接入 |
| `stop()` | 兼容旧入口，等同取消等待 + 请求 supervisor 收场，不是仅收连接 |

控制帧在飞合并不吞后续调用的 flag；置闸与取消等待先落实。`snapshot()` 是管理器只读出口；客户端轮次、两轴探测与管理器快照仍是不同事实，不合成错误镜像。

## 配置生效

url / command 改动提示重载，不热切服务器。autoConnect 即时生效：开启且当前按钮态从未选过目标时选路；关闭只撤自动许可，不打断已建连接，也不收回用户显式选择。idleSec 热读。

## 验证与未覆盖边界

离线入口：connectTarget / connectView / connectSnapshot / autoConnectConfig、supervisorPolicy / supervisorProtocol / supervisorErrors、connectionStop / clientDispose，以及 i18n / styles。真 socket 假服务端必须读 data，否则 paused socket 不触发预期 close，不能假称测了占用释放。

真实 supervisor / DSH 探针按[验证约定](<../AGENTS.md>)另获当次批准，使用真 Manager 入口与临时目录硬断言，不能用手抄流程替代。历史 R1 探针间隔 3 秒小于启动宽限（idleSec+10），未证明超宽限后的同 PID 复接；不要把它当空闲退场边界已覆盖。进程存活但服务卡死亦未实现自动重启。

回收仍保留公告行解析、令牌私有目录、异步进程查询、孤儿 writer lock 清理、身份肯定证据与永不抛错的 hostLog。已删除旧架构的规模、实现步骤与过往通过套数不作为当前验收结果。
