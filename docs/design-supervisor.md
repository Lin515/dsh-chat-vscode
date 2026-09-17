# 独立守护进程（supervisor）托管 DSH 后台 —— 设计

> 状态：**已实现并生效**（写于 2026-09-13，2026-09-14 落地；此后 §8 记录了历次实测修正）。
> 取代 `docs/design-shared-server.md`（那份描述的是"窗口之间自己协商"的会合租约模型，
> 本文 §1 说明它为什么必须被换掉；那份文档保留作历史记录，不再作为实现依据）。
> 代码落点：守护进程 `src/supervisor/main.ts`；客户端侧
> `src/dsh/supervisor{Manager,Client,Runner,Protocol,Wire,Errors}.ts`。
>
> 阅读顺序：§1 为什么要换 → §2 验收标准 → §3 形态与协议 → §4 时序与边界 →
> §5 与现有代码的关系（保留 / 删除 / 新增）→ §6 测试计划 → §7 已定决策与待定项。

## 1. 为什么要换掉会合租约模型

`d7030dc`（及后续 4 个提交）用一套"窗口之间自己协商"的机制来回答三个问题：
**谁起后台、还有谁在用、什么时候该杀**。协商的载体是
`~/.dsh-chat/servers/<配置指纹>/` 下的会合租约 + 每实例心跳文件 + 跨进程启动锁。

它的**结构性缺陷**是：协商要求"在场的每一方都投得了票"，而 VS Code 会在任意时刻
杀掉扩展宿主，新实例又不可能替旧实例投票。由此长出的竞态都不是实现瑕疵，而是模型的死角：

| 症状 | 机理 |
|---|---|
| **每次窗口重载后台必死** | 旧实例 `release()` 时新实例还没出生，`otherLiveHost()` 看到"没有别的活心跳"就无条件杀掉 dsh；VS Code 打开文件夹、装扩展、改配置都会重载窗口，于是每次都要 5~8 秒冷启 |
| 新窗口干等 90 秒 | `findStarting()` 只判 `pid 是否活着`，而 pid 是 `cmd` 外壳；窗口在启动中途被关掉时外壳还活着、真 dsh 已死 → 新窗口认定"别人正在启动"，改为等待一条永远不会就绪的租约 |
| 关窗后残留 dsh（2026-09-13 用户实测） | `release()` 的第一条语句就是写日志，关窗期通道已关闭 → 抛异常 → 下面杀进程的代码执行不到 |
| 残留 dsh 不被接管（同日实测） | 接管要求**先证明**"写心跳的实例已经不在"，而这条证明依赖进程表查询；心跳丢失、pid 被回收都会让它误判成"还有人用" |
| 崩溃后"该接管还是该回收"难判 | 同一件事分散在 `findAttachable` / `findAdoptable` / `findAdoptCandidates` / `findServingLeftoverLease` / `findStarting` / `isOrphanLease` 六个判据里，任一失真就误杀或漏杀 |

**根因一句话**：把"后台的生死"绑定在"扩展宿主"这个由 VS Code 随时创建/销毁的对象上，
再用多方协商去补它的洞。正确做法是把生命周期交给一个**独立于 VS Code 的进程**，
让"还有没有人在用"变成一个**单一裁决者读得到的事实**（有没有人 ping），而不是一场投票。

## 2. 验收标准（用户口径）

| # | 需求 | 验收标准 |
|---|---|---|
| R1 | **重载窗口不打断后台** | 打开文件夹 / 装扩展 / 手动重载窗口后，dsh 进程不重启（pid 与端口不变），连接断点只是"握一次手" |
| R2 | 多窗口共用一个后台 | 同时开 3 个窗口，机器上只有 1 个 supervisor、1 个 `dsh web` |
| R3 | **没人用就自己退场** | 所有窗口关闭（或崩溃）后，超过空闲阈值（默认 10s）→ supervisor 先关 dsh 再关自己，**不留孤儿、不留僵尸** |
| R4 | 找不到就启动、启动不重复 | 首个窗口启动 supervisor（并发时靠 OS 锁保证只有一个赢）；后续窗口只连接 |
| R5 | supervisor 崩了能自愈 | 强杀 supervisor 后，任一窗口在下一次自检时发现并重新拉起；强杀后遗留的 dsh 被回收（不占端口） |
| R6 | 用户仍能掌控 | `DSH: 停止服务器`（立刻停 dsh+supervisor）、`DSH: 重启服务器`、`DSH: 清理残留进程`、诊断命令都保留 |
| R7 | 配置生效路径不变 | `dshChat.command` / `url` / `supervisorIdleSec` 语义不变；`autoStart` 的**语义在 2026-09-14 被明确并收紧**（见 §8，用户口径） |
| R8 | **关掉自动启动时不乱启动**（§8） | 扩展激活后先判断后台在不在跑：在跑就一直重连（**没有总超时、也没有单次超时**，用户按「停止连接」才停），没跑就只显示「启动服务器」按钮 |
| R9 | **多窗口复用会合文件里的令牌**（§8.2） | 非启动窗口（peer）也用 `supervisor.json` 里的 `token` 换 cookie，不再弹「输入令牌」 |

## 3. 形态与协议

### 3.0 传输层：**socket 管信号与控制，文件管会合**（用户 2026-09-13 定 A）

初版设计把心跳也做成"每秒写文件"，用户质疑"写文件太 low"——这个质疑是对的，
但要点不是"不许用文件"，而是**高频信号不该塞进文件**。定案：

| 用途 | 载体 | 理由 |
|---|---|---|
| **持续信号 + 控制请求**（ping / 重启 / 停止 / 查状态 / supervisor 主动通知） | **AF_UNIX socket 长连接**（Windows 走 `\\.\pipe\...` 形态的 path；失败自动退化命名管道） | 连接断开即知"这个窗口没了"（liveness 从"轮询+超时"升级成事件）；控制请求是结构化消息，不需要再造"stop 请求文件"；supervisor 退场前能主动通知各窗口 |
| **跨世代会合信息**（`baseUrl` / `token` / `supervisorPid` / `command` / 分组） | **文件**（`supervisor.json`，原子写：tmp + rename） | 新窗口必须在 supervisor 未起、或刚崩溃时就有东西可读；且它可读、可 diff、排查时一眼看得见（本轮定位几个坑全靠能直接看这些文件）。项目本身也是这个范式（`.credentials.yaml` / `settings.yaml` / 热重载） |
| **诊断输出** | `supervisor.log` | 进程没了之后唯一的事后线索 |

**必须处理的新失败模式（IPC 的真实成本，逐条都要有代码）**

1. supervisor 未起 → 连不上是**正常态**：按 §3.3 的"读文件 → 连 socket → 失败则拉起"走；
2. supervisor 崩了 → socket 立刻断开（比超时快得多）→ 就地重拉，并**按端口回收遗留 dsh**（R5）；
3. socket 残留文件（AF_UNIX 会在磁盘留下节点）→ 先探活再删，**不许盲删**（沿用 `isKillable` 的"按肯定证据"纪律）；
4. 路径长度：AF_UNIX 路径有长度上限 → 非 Windows 上 socket 放分组目录内（`<分组>/sup.sock`）；Windows 直接用命名管道 `\\.\pipe\dsh-chat-<分组>`（全局命名空间，与目录无关——探针隔离时须另带后缀）；
5. **兜底**：socket 连续失败但 supervisor 进程还活着 → 退化成"读 supervisor.json 的新鲜度"再判一次，避免把自己困死。

### 3.0.1 supervisor 用哪个运行时？——**固定用 VS Code 自带的 Node**（用户 2026-09-13 定）

**为什么不能"依赖 PATH 上有 node"**：dsh 是个**社区生态**，发行形态很多——`dsh` 可能是
npm 装的 JS CLI（那时机器上必然有 node），**也可能是别人打包好的独立可执行文件**
（那时机器上可能压根没有 node）。所以"PATH 上有 node"**不是**可以依赖的前提。

**为什么 VS Code 自带的就够**：扩展宿主本身就跑在 VS Code 自带的 Electron/Node 上，
它**必然存在**，与用户装没装 node 无关。实测（本机）：

```
$ set ELECTRON_RUN_AS_NODE=1 && "D:\Software\Microsoft VS Code\Code.exe" -e "…"
{"execPath":"D:\\Software\\Microsoft VS Code\\Code.exe","node":"v24.18.1","abi":"146","electron":"42.10.0"}
```

安装目录里**只有 `Code.exe`**（没有随附的 `node.exe`），所以这就是唯一的自带运行时；
`ELECTRON_RUN_AS_NODE=1` 是唯一入口，也是 VS Code 扩展生态里 spawn Node 子进程的标准手法。

**定案（D8）：只用 VS Code 自带的 Node，不提供配置项**

| | 取值 | 说明 |
|---|---|---|
| 唯一路径 | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | 扩展宿主里 `process.execPath` 通常就是 `Code.exe`；若不是（远程/特殊安装形态），再取 `vscode.env.appRoot` 下的 `Code.exe`，两处都试 |
| 失败 | 写 `supervisor.log` 并给出明确错误 | 不提供 `nodePath`：VS Code 自带的运行时由扩展宿主自己背书，**没有"找不到"的合理场景**；多一个配置项就多一个"用户填错/填了旧版"的故障面（这正是 §1 那类问题的来源） |

**为什么不留手动指定**（用户 2026-09-13 拍板）：加配置项解决的是"运行时可能缺失或版本不对"
——但宿主能跑起来就说明运行时在；版本问题由"**产物降到 `node20`**"消除，而不是靠用户换解释器。
真要排查，`supervisor.log` 里记下 `process.execPath` / `versions.node` / `versions.electron` 即可。

**实现细节（照这条写，别踩坑）**

- spawn 时**清掉** `ELECTRON_RUN_AS_NODE`（防自己又变成 Node 把整个 VS Code 当脚本跑）、
  设 `windowsHide: true`、`detached: true` + `unref()`（**必须与扩展宿主生命周期解耦**，
  否则窗口一关 supervisor 陪葬）；
- 参数形式：`<execPath> [script] args…`（Electron-as-Node 下 `argv` 与 node 一致）；
- supervisor 代码**打进扩展包**（新增打包条目 `dist/supervisor.js`），不额外下载任何东西；
  用 **CJS + 只依赖 node 内置模块**，并 **`target: node20`**（保守下限，避免用到较新
  Electron 才有的 API）——同一份产物在任何 VS Code 自带运行时上都能跑；
- 这条同时让**探针可以完全无头跑**：探针里用同一个解析函数就能拿到"VS Code 自带的 Node"，
  不需要用户装 node，也不需要在测试里启动 VS Code。

### 3.1 进程拓扑

```
VS Code 窗口 1 ─┐
VS Code 窗口 2 ─┼─(各持一条 AF_UNIX 长连接，1s 一次 ping)─┐
VS Code 窗口 3 ─┘                                          │
                                                            ▼
                        dsh-chat-supervisor（独立进程，detached、无窗口；用 VS Code 自带的
                                            Node 运行时跑，见 §3.0.1）
                          ├─ 起点：被第一个找不到它的扩展实例拉起
                          ├─ 唯一持有：`dsh web` 子进程（命令原样来自 dshChat.command）
                          ├─ 只认：socket 上还有没有活连接（+ 会合文件的世代）
                          └─ 退场：连续 idleSec（默认 10s）无活连接 → 按端口杀 dsh 整棵树
                                   → 删 supervisor.json 与 socket → 通知各连接 → 自己退出
```

- **扩展侧只做客户端**：读会合文件 → 连 socket（拿 `baseUrl`/`token`，令牌换 cookie 流程
  与今天完全一致）→ 1s 一次 ping → 退出时只关自己的连接，**任何情况下都不杀 dsh**。
- **supervisor 不感知 VS Code**：它只认 socket 上的连接，因此对 VS Code 的
  创建/销毁/崩溃/重载完全免疫。这也让探针可以在**完全不启动 VS Code** 的情况下测
  （用脚本当 pinger 连接即可）。

### 3.2 磁盘协议（只留会合信息）

```
<DSH_HOME>/dsh-chat-vscode/supervisors/<配置指纹>/   ← 配置指纹沿用 leaseGroupKey（按有效配置算）；DSH_HOME 缺省 ~/.dsh
  supervisor.json                          ← 由 supervisor 原子写；扩展只读
    { "version": 1, "supervisorPid": 1234, "serverPid": 5678,
      "baseUrl": "http://127.0.0.1:20000", "token": "…",
      "command": "dsh web --port 20000 --no-open",
      "idleSec": 10,            ← 期望空闲阈值（由启动它的扩展写入；supervisor 热读）
      "socket": "…/run/<分组>/sup.sock",
      "startedAt": 1789… ,      ← supervisor 启动时刻
      "serverStartedAt": 1789…, ← dsh 就绪时刻（未就绪时缺省）
      "starting": false }       ← true = 正在拉起 dsh（扩展据此等待而不是自己起）
  supervisor.log                           ← supervisor 与 dsh 的输出（排查唯一线索）
```

**没有心跳文件了**：liveness 由 socket 连接本身表达（§3.0）。
（现有实现里的 `hosts/*.json`、`ownerStartedAt` 那套 pid 复用检测一并退场——
它们都在解决"没有可靠在场信号"这个新形态不再存在的问题。）

### 3.3 启动协议（幂等，防并发）

```
窗口激活：
  ① 读 supervisor.json
       ├─ 有、能 HTTP 连上 baseUrl                        → 连 socket、接上，完事
       ├─ 有、但 starting=true 且未就绪                   → 等它就绪（轮询到就绪；没有超时，
       │                                                   用户可点「停止连接」中断，见 §8.4）
       ├─ 有、但 socket 连不上 / 服务器连不上且过了宽限     → 说明 supervisor 或 dsh 死了：
       │                                                   → 通知/重拉（见 §3.5 与 §3.4-3）
       └─ 没有                                          → 进入 ②
  ② 抢 OS 锁（<分组目录>/supervisor.lock，`wx` 独占 + 持有者 pid 判活）
       ├─ 抢到 → 写 supervisor.json（含 idleSec、command、socket 路径）→ spawn supervisor（detached）
       └─ 没抢到 → 说明别人正在起 → 回到 ① 轮询等待
  ③ 轮询 supervisor.json 直到 serverStartedAt 出现且 baseUrl 可连（同样是等就绪，没有超时）
```

锁只保护"**启动 supervisor**"这一个动作（几十毫秒），不保护 dsh 的启动过程——
后者由 supervisor 自己写 `starting` 字段来表达，扩展不需要为此协商。

### 3.4 长连接与自检（每个窗口）

1. **连上 socket 并保持**：连接本身就是"我在用"的信号（不需要写任何心跳文件）；
   每 1s 发一次 `ping`（兼作保活；连接断了立刻知道）；
2. **连接健康**：收到 `state` 变更通知（`baseUrl` 变了 = supervisor 重启了 dsh）→
   用新令牌重连（cookie 按 authority 绑定，换端口必须换 cookie，这条现有逻辑保留）；
3. **supervisor 健康**：socket 连不上时按顺序判——状态文件缺失 / `supervisorPid` 已死 /
   连接被拒且探活失败 → 回到 §3.3 的 ②（重新拉起）。若此时发现"端口上还有人在监听"
   （遗留 dsh），**先按端口杀掉那个孤儿**再起 supervisor——这正是 R5 的落点，
   也是 `killLeasedServer` 那套"按端口找真正的监听者"必须保留的原因；
4. **不变量**：扩展**只关自己的连接**。杀 dsh 永远是 supervisor 的事，扩展一行都不做
   （这是本次架构改动最重要的一条纪律——今天所有麻烦都源于"扩展也在杀 dsh"）。

### 3.5 supervisor 内部（约 300~400 行）

```
启动：定位配置目录（命令行参数传入）→ 写 socket 监听 → 原子写 supervisor.json(starting=true)
      → 按 §3.0.1 解析出的解释器与 dshChat.command spawn dsh（输出进 supervisor.log）
      → 轮询日志里的公告行 `dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`
      → 就绪：原子回填 baseUrl/token/serverStartedAt、starting=false，并广播 state 给各连接
循环（每 1 秒）：
      ① 活连接计数：socket 上还有几条连接 → 有人用（连接断开立即反映，无需等超时）
      ② 若连续 idleSec（默认 10）无活连接，且没有"正在拉起 dsh"在途：
           → 收尾：按端口把 dsh 整棵树杀掉 → 通知各连接 → 删 supervisor.json 与 socket → exit
      ③ 若 dsh 子进程**真的死了**（判据见下）：
           - 仍有活连接 → 重新 spawn 并重新解析公告行（端口可能变，`--port 0` 时必变）→ 广播
           - 没有连接   → 自己退场
      ④ 热读 supervisor.json 的 idleSec（用户改配置后不必重启 supervisor）
      ⑤ 处理连接上的控制请求：ping / restart / stop / state
```

**"dsh 死了"的判据不是 `!server.child`**（2026-09-15 实测修，见 §8.6）：
`server.child` 是 `spawn` 返回的 ChildProcess 对象，**进程死了它也不会自己变成 undefined**
（`exit` 处理器只管记日志，没人清这个字段）。所以判活必须问进程本身：
`exitCode/signalCode` 已置位，或 `isProcessAlive(child.pid)` 为假。用 `!server.child` 的后果是
**dsh 崩掉之后再也不会被拉起**（重启分支永远进不去），而这一条恰恰是守护进程存在的理由。

**supervisor 自己绝不能没有出口**：任何"没人在用"的判定都必须以"连续 N 秒无活连接"且
"当前没有正在进行的启动"为前提；宁可可多活几秒，也不允许在窗口重载的空档里误退场
（这正是 5 秒太紧、默认取 10 秒的原因）。

### 3.6 一个刻意的取舍：dsh 不会"最后一个窗口关闭立刻死"

按用户口径（方案 A）：所有窗口关闭后，dsh **继续服务到空闲阈值**（默认 10s），
然后与 supervisor 一起退场。理由：重载窗口期间"旧实例已退、新实例未起"的空档
（实测 2~5 秒）必须被容忍，否则又回到"重载即冷启"；10 秒的代价是关掉 VS Code 后
机器上多活 ≤10 秒，可接受。需要"立刻停"的用户用 `DSH: 停止服务器`。

## 4. 时序与边界

### 4.1 正常流程

```
开 VS Code（无文件夹）→ 扩展激活 → 没有 supervisor → 起 supervisor → dsh 就绪 → 接上
打开文件夹 → 窗口重载 → 旧实例退出（只关自己的连接）→ 新实例激活后立刻连上
           → 读到 supervisor.json → 直接接上，dsh 从未中断          ← R1
关掉最后一个窗口 → 连接关闭 → 10s 后 supervisor 关 dsh 并退出          ← R3
```

### 4.2 崩溃矩阵

| 崩了什么 | 现象 | 处置 |
|---|---|---|
| 一个窗口崩溃 / 强杀 | 它的 socket 连接断开 | supervisor 不受影响（还有别的连接就继续；没有就按 R3 退场） |
| 扩展宿主被杀、窗口还在（重载） | 连接中断 1~3 秒 | **不触发退场**（阈值 10s 远大于空档） |
| **所有**窗口崩溃 | 连接全断 | 10s 后 supervisor 关 dsh 并退出 → 机器回到干净状态（R3） |
| supervisor 崩溃 | 状态文件还在、pid 已死、socket 断开 | 任一窗口自检发现 → 按端口回收遗留 dsh → 重新起 supervisor（R5） |
| dsh 自己崩了 | 端口没了、子进程退出 | supervisor 重新拉起（还有连接）或退场（没有连接）；端口变化经 socket 广播给所有窗口。**前提是判据正确**——2026-09-15 之前用 `!server.child` 判，句柄不清就永远判不出死亡，实际表现是"崩了不重启"（见 §8.6） |
| 启动 supervisor 的窗口中途关掉 | 锁被持有、supervisor 可能起了一半 | supervisor 是 detached 的、与窗口生命周期无关：它照常完成启动并写状态文件，其余窗口接手使用 |

### 4.3 与"外部服务器"（`dshChat.url`）的关系

完全不变：`url` 非空 = 外部模式，**不启动 supervisor、不写状态文件、不连 socket、
不参与空闲判定**，只连用户给的地址。supervisor 只服务"内部后台"这一种情形。

### 4.4 配置分组

沿用原 `leaseGroupKey` 的算法，但现在住在 `supervisorManager.groupForConfig`（按有效
`url`/`command` 算 sha256 前 12 位）：有效配置不同的窗口用不同的目录、各自一个 supervisor。
配置改了 → 现有"提示重载窗口"的口径不变（改配置不再就地热切换，这条已经定了）。

> 名字里的 "lease" 是个历史包袱：它与被删掉的会合租约**没有关系**，只是"会合目录的分组键"。

## 5. 与现有代码的关系（**实现后已回填**）

### 5.1 保留（这些是踩出来的，别再重踩）

| 资产 | 位置 | 为什么留 |
|---|---|---|
| 公告行是端口/令牌的唯一真相 | `supervisor/main.ts` 的 `parseAnnouncement` / `lastAnnouncement` | 服务器自报地址，扩展与 supervisor 都不猜 |
| 令牌写进用户私有目录 + cookie 换发 | `supervisorProtocol` 的会合文件 + `controller` 的认证链 | 多窗口接入的唯一可行路径（令牌是进程内存值、cookie 绑定 authority） |
| **按端口兜底杀整棵树** | `supervisor/main.ts` 的 `killServer` / `listeningPids` | Windows 上 `dsh web` 经 shell 启动，外层 pid 可能是外壳；收尾与"回收遗留孤儿"都靠它 |
| 异步进程查询（批量）、不拿 pid 当可用性判据 | `processRegistry` 的 `isProcessAlive` / `fetchCommandLines` / `tcpReachableSync` | 同步 `spawnSync` 会冻住扩展宿主约 1.5 秒；pid 判活对僵尸进程假活 |
| `clearStaleDocumentLocks` | `dshLocks.ts`（从 processRegistry 拆出来） | `dsh web` boot 会锁 `.credentials.yaml`，孤儿锁会让它 30 秒后自杀 |
| 清理 / 诊断命令 | `cleanupResidualServers` / `scanServers` / `isKillable` | 用户手动兜底手段；判"允不允许动手"的肯定证据纪律保留下来 |
| 日志写入器（永不抛异常） | `src/dsh/hostLog.ts` | 关窗期日志抛异常会掐断停用路径（已修） |
| 会话/窗口/界面等全部非机制改动 | 其余 30+ 文件 | 与生命周期无关，一行不动 |

### 5.2 删除（**已完成**）

- `src/dsh/serverManager.ts` —— **整份删除**（约 1100 行的协商式生命周期），
  换成 `supervisorManager.ts`（客户端形态，读会合文件 → 确保 supervisor → 长连接自检）；
- `src/dsh/processRegistry.ts` —— 从 1726 行缩到约 300 行：租约读写与锁、hosts 登记与心跳、
  六个接管判据、启动锁、`killLeasedServer*`、`leaseDirectory` 全部删除；
  留下 `isProcessAlive` / `tcpReachableSync` / `fetchCommandLines` / `parseProcessList` /
  `scanServers` / `cleanupResidualServers` / `isKillable`（都是**跨两种架构都成立**的工具），
  以及从它拆出去的 `dshLocks.ts`（writer 锁清理与 `$DSH_HOME`）；
- 随之删除的断言与探针（它们测的是**旧模型**，场景已由新探针覆盖）：
  `sharedLease.test.ts`、`sharedServerProbe`、`crashReuseProbe`、`crashWindow`、
  `gracefulCloseProbe`、`closedChannelProbe`、`orphanDiagnose`、`leaseState`、
  `groupIsolationProbe`、`groupWindow`、`tokenAndCleanup.test.ts`
  （其令牌部分迁入新的 `processRegistry.test.ts`）。

**耦合面（已实测）**：`processRegistry` 的消费者只有 3 个文件
（`extension.ts`、`controller.ts`、`serverManager.ts`），其余 30+ 个源文件零依赖。
所以这是"换一个中间层"，不是"重写扩展"。

### 5.3 新增

| 新增 | 说明 |
|---|---|
| `src/dsh/supervisorProtocol.ts` | 会合文件（原子读写的纯函数）+ socket 寻址 + 启动锁：**纯文件，可离线断言** |
| `src/supervisor/main.ts` | supervisor 进程本体（被 `esbuild.mjs` 打成 `dist/supervisor.js`，随扩展分发；CJS + 只用 node 内置模块） |
| `src/dsh/supervisorClient.ts` | 扩展侧：`readState()` / `ensureSupervisor()` / 长连接（ping/restart/stop/state） |
| `src/dsh/runtimeResolve.ts` | 取 VS Code 自带的运行时（§3.0.1：`process.execPath` / `vscode.env.appRoot` + `ELECTRON_RUN_AS_NODE=1`）+ spawn 参数的正确姿势（清 `ELECTRON_RUN_AS_NODE` 再设、detached、unref） |
| `dshChat.supervisorIdleSec` | 配置项（整数，默认 **10**，范围 5~600），中英双语说明。**本次只新增这一个配置项** |
| `DSH: 停止服务器` 语义 | 走 socket 控制请求：supervisor 收尾并退出（不引"stop 请求文件"） |

## 6. 测试（**实现后已回填实际结果**）

### 6.1 离线断言（进 `npm test`，44 套全绿）

- `supervisorProtocol.test.ts`：会合文件的原子写、**坏数据逐条丢弃**、世代
  （pid+startedAt）判定、启动锁的独占创建与"持有者已死"的回收、阈值收敛、运行时解析
  （含一次真跑 `-e` 的自检）；
- `processRegistry.test.ts`：令牌 401/403 → `DshAuthError`、进程列表解析（对象/数组/坏数据）、
  命令行判定（npm 装的 dsh / 打包的 dsh.exe / 无关进程）、**杀进程的许可只认肯定证据**、
  进程判活（真实子进程）；
- `hostLog.test.ts`：日志写入器永不抛异常（含"已关闭的通道确实会抛"的对照）。

### 6.2 端到端探针（无头跑，**不必启动 VS Code**）—— 全部 PASS

| 探针（实际文件名） | 覆盖 | 实际判据 |
|---|---|---|
| `supervisor-reload-probe` | **R1**：pinger A 起 → 强杀 A → 隔 3 秒 B 起 | dsh `pid` 与地址**完全不变**、世代不变、B 非启动者；末了会合文件与端口都清干净 |
| `supervisor-idle-probe` | **R3** | 阈值内会合文件/端口/进程三者都在；过阈值后三者全清 |
| `supervisor-scenarios-probe` | **R2/R4/R5/R6** | 3 窗口并发**启动者=1**、同一地址；关两个不影响第三个；`stop` 干净退场；强杀 supervisor 后**遗留 dsh 被回收**（端口释放） |
| `supervisor-manager-probe` | 扩展**真正用的那个管理器** | 拉起 / 接入（peer）/ 活连接数=2 / `restart()` 换新 dsh（令牌变）/ `stopAndExit()` 清场 |

`pinger` 的实现方式：一个脚本走 §3.3/§3.4 的扩展侧流程（读会合文件 → 需要则拉起
supervisor → 连 socket 并 ping → 退出时关连接），行为与扩展一致——所以探针**全部无头可跑**，
这是新形态比旧的好验的地方。

> **踩过的坑（写下来免得再犯）**：探针的会合目录必须隔离，而隔离模块只靠"副作用设环境变量"
> 时会被 esbuild **摇掉**（导出没被使用 → 整份删除），于是探针静默跑进用户的真实目录。
> 现在每个探针都有一条"必须是临时目录"的硬断言。

### 6.3 手动验收（R1/R6 的真验收）

装 vsix 后：开窗口（无文件夹）→ 记录 dsh pid/端口 → 打开文件夹（触发重载）→
再看 pid/端口（必须不变）；关掉全部窗口 → 10 秒后确认 dsh 与 supervisor 都没了；
改 `dshChat.supervisorIdleSec` 为 30 验证生效。

## 7. 已定决策与待定项
**已定（用户 2026-09-13）**

- **D1 空闲阈值默认 10 秒**，可通过配置文件自行控制（`dshChat.supervisorIdleSec`，
  建议范围 5~600；下限取 5 是因为再小会与"窗口重载空档 2~5 秒"打架）。
- **D2 方案 A**：最后一个窗口关闭后 dsh **不立刻停**，与 supervisor 一起等到空闲阈值再退场；
  需要立刻停用 `DSH: 停止服务器`。
- **D3 ping 就够**：只监测"有没有扩展在 ping"，不去拦扩展与 dsh 之间的流量。
- **D4 不做整体回退**：保留 `d7030dc` 之后的非机制成果（配置热重载、窗口状态、界面修复），
  只替换后台生命周期这一层（§5.2/§5.3）。
- **D5 版本号不动**（仍 0.6.0），是否发版由用户决定。
- **D6 传输层 = A（AF_UNIX socket 优先，失败退化命名管道）**：高频信号与控制走 socket，
  文件只放跨世代会合信息（§3.0）。用户明确否掉了"每秒写文件当心跳"的做法。
- **D7 supervisor 的运行时不额外要求用户装 Node，只用 VS Code 自带的运行时**
  （§3.0.1）：dsh 是社区生态、发行形态很多，**"PATH 上有 node"不是可依赖的前提**；
  扩展宿主本身跑在 VS Code 自带的 Electron/Node 上，那个必然存在。
- **D8 不提供运行时配置项**（用户 2026-09-13 拍板）：宿主能跑起来就说明运行时在，
  没有"找不到"的合理场景；版本差异用"产物降到 `node20`"消除，而不是让用户换解释器。
  排查靠 `supervisor.log` 里记下的 `execPath` / `versions.node` / `versions.electron`。
- **D9 `autoStart` 只约束"自动"路径，且关掉后以"后台在不在跑"为唯一判据**
  （用户 2026-09-14，见 §8.1）：在跑就自动重连（无总超时、可手动停/重试），
  没跑就只给「启动服务器」按钮；用户显式动作（发消息 / 启动 / 重启）不受它约束。
- **D10 令牌只认会合文件那一份**（§8.2）：`self` 与 `peer` 走同一条认证链，
  内部模式不再有「输入令牌」入口。
- **D11 自动重连由 5 秒心跳驱动、不另起定时器**：`SupervisorManager` 的心跳常驻
  （不再"连上才开"），控制器的自检挂在同一节拍上——这样"后台起来了要接上"和
  "掉了要重连"是同一个循环，不会出现两套节奏互相打架。

**待定（实现前需确认）**

- **P1 ping 间隔**：建议 1 秒（同时兼作保活）。连接是长连接，ping 频率只影响
  "多久发现对端死了"——1 秒足够，也不必更密。
- **P2 已由 D6 解决**：`stop` 走 socket 控制请求，不再有"stop 请求文件"。
- **P3 已作废（2026-09-14）**：原议题是"'启动超时'提示的文案"。用户口径是**这一档
  时长判定本身不该存在**，所以 `dshChat.startTimeoutSec` 配置项与 `@serverStartTimeout`
  标记一并删除，改为"等到就绪，或用户点「停止连接」"（见 §8.4）。

**实现顺序**（每步都可独立验证，探针先行）

1. `supervisorProtocol`（会合文件 + 锁）+ `runtimeResolve`（解释器解析链）+ 离线断言
   （纯文件与纯函数，不起进程）；
2. socket 协议（编解码 + `supervisorClient`）与 `supervisorProtocol.test.ts` /
   `supervisorClient.test.ts`；
3. `src/supervisor/main.ts` + `supervisorReloadProbe` / `supervisorIdleProbe`
   （这两条是核心，先让它们红 → 绿）；
4. `serverManager` 换成客户端形态（读会合 → 确保 supervisor → 长连接自检）+ 
   `supervisorRaceProbe` / `supervisorCrashProbe` / `supervisorShareProbe` / `supervisorStopProbe`；
5. 删除 §5.2 的旧实现与旧断言，改 `docs`，跑 `command-e2e` 与 `npm test` 全量回归；
6. 打包 vsix（版本号等用户发话），手动验收 R1/R6。

## 8. 启动决策、自动重连与多窗口令牌（2026-09-14 实现）

> 用户口径（原文要点）：**"扩展启动后，不要无脑重连，而是应当先判断后台 dsh 是否已经
> 启动；若没有启动，则应直接显示启动服务器按钮……在有守护进程和 DSH 后台进程在的时候，
> 才自动尝试重连（去掉重连超时时间，并提供停止重连/尝试重连按钮，由用户手动调整）。
> 如果是外部 DSH，则无需判断进程相关问题，只进行重连尝试即可。重连失败时可提示用户打开
> 日志查看信息。"** 以及：**"内部启动后无法自动获取 token，token 应当保存到文件中，
> 可供多个 VSCode 窗口复用。"**

### 8.1 决策表（`autoStart` 关掉之后）

| 情形 | 扩展怎么做 |
|---|---|
| 后台（守护进程 + dsh）在跑 | **自动接上**，并且一轮一轮重试到成功为止（**没有任何时长判定**；等待只由"真的就绪"或「停止连接」结束，见 §8.4） |
| 后台不在跑 | **什么都不启动**，连接条显示「启动服务器」；守护进程后来起来了（别的窗口拉的）会自动接上 |
| 用户点「停止连接」 | 停掉**正在进行的连接**（中止在途那一轮 + 关掉自动重连），后台**一个字都不动**（杀 dsh 永远是守护进程的事），条上给「尝试连接」 |
| 外部服务器（`dshChat.url`） | 不判进程，只重连（那条地址不归本扩展管，"启动"这个动作不存在）；**同样等到底**（没有"到点报连不上"），一次都没应答过就把 `@serverUnreachable` 摆在条上 |
| 连不上 | 条上显示原因 + 「尝试连接」/「重启服务器」/「查看日志」（输出通道「DSH Chat」） |

**"能不能启动"是一条显式许可**（`SupervisorManager` 的 `autoStart` + `ensure({start})`）：

- `options.autoStart`（配置项）约束**自动**路径：激活期自动连接、窗口恢复会话、5 秒心跳自检；
- 用户**显式**动作一律覆盖它：发消息、新建/切换会话、「启动服务器」、「重启服务器」、
  输入令牌——用户要后台的时候不该被配置挡住（用户 2026-09-14 定）。

界面侧因此多了一档状态：`stopped`（**没启动**，给「启动服务器」）与 `error`（**连不上**，
给原因与重试）必须分开——把"没启动"渲染成"正在连接…"会让用户以为卡住了。

### 8.2 令牌就是会合文件里的那一份（R9）

`token` 由 supervisor 原子写进 `supervisor.json`，**这是多窗口接入的唯一凭据**。
controller 的认证链此前按 `info.owned`（"是不是本窗口拉起的"）分叉，于是只有启动者能用令牌，
其余窗口被当成"外部服务器"去弹「输入令牌」——用户报的"内部启动后拿不到 token、连不上"
就是这条路径。现在：

- 分叉判据改成 `ownership === "external"`：`self` / `peer` 都走"令牌换 cookie"；
- 令牌被拒时**重读一次会合文件**再用（守护进程可能刚好重起了 dsh、换了新令牌）；
- 内部模式不再出现「输入令牌」入口（那是外部服务器才有的东西）。

### 8.3 守护进程还活着时**只接入、不另起一套**

`bringUp()` 现在的顺序：读到会合文件且守护进程活着 → **先接上它的 socket**
（连接本身就是"我在用"，守护进程据此把崩掉的 dsh 重新拉起）→ 等它写出一份可用状态。
此前是"地址不可达就去抢锁 + 再 spawn 一个 supervisor"：Windows 上命名管道只能被一个进程
监听，第二个 supervisor 会在 `listen` 处失败自杀，而 spawn 开销已经付掉，且原守护进程
因为"没人连着"会在空闲阈值后收场——白折腾一场。

### 8.4 等就绪**没有时长上限**（2026-09-14 用户口径）

> 用户口径：*"控制自动重连状态通过提供停止连接、开始连接、启动服务器等按钮，以完全由
> 用户手动操作，而不是通过时长控制……这个时长控制不应该还在。"*

2026-09-14 那一版只删掉了"重连的**总**超时"，单次等待仍受 `dshChat.startTimeoutSec`
（默认 90 秒）约束，于是每 90 秒就会把界面从"正在连接…"改写成一次"启动超时"错误、
再由心跳拉回重试——**状态依然由时钟决定**，用户看到的是一条条假失败。现在：

- `dshChat.startTimeoutSec` 配置项、`ManagerOptions.startTimeoutMs`、
  `@serverStartTimeout` 标记**一并删除**（`@serverNotReady` 取代后者）；
- `waitForReadyState` 不再有 deadline：等到**真的就绪**，或 `AbortSignal` 被 abort；
- 「停止连接」/「停止服务器」调用 `SupervisorManager.cancelWaiting()` **中断在途的那一轮
  等待**（只中断等待，不碰任何进程）。中断抛 `WaitCancelledError`，controller 把它当
  "用户叫停"：界面停在 `stopped`（给「尝试连接」），**不写错误详情**；
- 「重启服务器」等新地址同样没有 deadline（原来 90 秒后报 `@serverStartTimeout`）；
- 顺手补掉两处"按钮说了不算"的洞（都属于同一条口径：**开关只由按钮翻**）：
  ① `handleHeartbeat` 在 `stopped` 那一支原本不读 `autoReconnect`，于是「停止连接」
  只维持到下一个心跳（≤5 秒）就被自动接了回去；② 一轮连接**已经在跑**时按「停止连接」，
  它照样会把连接建起来（等待结束之后、以及客户端建好之后各有一道
  `userAskedToStop()` 检查，后者会把刚建好的客户端收掉）；
- 真正的失败（守护进程起不来、会合文件缺地址/令牌）照旧如实报错，文案是
  `@serverNotReady` + "缺哪一样" + 日志尾部；
- **外部服务器也统一到同一条口径**：原来 `waitForHttp(url, 5_000)` 到点就报
  `@serverUnreachable` 并抛错，现在同样**一轮轮探测到底**（连上，或用户点「停止连接」）。
  单次探测自己的 2 秒 fetch 超时保留——那是"这一次探测等多久"。第一次探不通时把
  `@serverUnreachable` 摆到连接条上（controller 会把带 `@` 的 `starting` 详情透给界面），
  用户看到的是"连不上 `<url>`（会一直重试，可点「停止连接」）"，而不是一个转圈的空条。

**还按秒计时的只剩 supervisor 自己那一处**：等 dsh 宣布地址的 `SPAWN_GRACE_MS`
（120 秒，且它会一轮轮重跑）。它是 **supervisor 内部的重试节奏**，不是扩展侧
"等多久就放弃"的状态判定。

### 8.5 验证
| 断言 / 探针 | 覆盖 |
|---|---|
| `scripts/supervisorPolicy.test.ts`（`npm test`） | 没有许可时 `ensure()` 抛 `ServerNotRunningError` 且**启动器调用 0 次**；有许可才拉起；守护进程活着时不重复拉起（peer）；地址/令牌来自会合文件；`probeRunning()` 的三个事实判据；**第 5 组**：等就绪没有时长上限、期间一次 spawn 都没有、`cancelWaiting()` 后立刻以 `WaitCancelledError` 结束；**第 6 组**：外部地址没人应答时同样一直等（详情 `@serverUnreachable:<url>`）、叫停同样立刻生效 |
| `node build/auth-chain-probe.mjs` | **真实 dsh**：启动者与接入者各走一遍 `authenticate()` + `listSessions()`（= controller 的认证链） |
| `scripts/styles.test.ts`（第 16 组） | 连接条允许换行、按钮 nowrap、说明文字可省略——窄侧栏下按钮不会被裁掉 |
| `test/preview.html?conn=…&running=1&locale=en` | 六种连接状态的按钮组合可直接肉眼核对（中英各一遍） |
| `node build/supervisor-child-exit-probe.mjs` | **dsh 死了会不会被自动拉起**（§8.6）：杀真 node / 强杀 / 卡死三种形态，各起一套隔离的 supervisor + 假 dsh，按假 dsh 自述的 boot 记录数重启次数 |
| `scripts/supervisorErrors.test.ts`（`npm test`） | 上报器：两处都发（文件 + 广播）、任何一处炸了都不外抛、累计提示、**给晚连上的窗口补发**（§8.8） |
| `scripts/supervisorProtocol.test.ts` 第 5.5 组 | `t:"error"` 的编解码往返与坏数据丢弃；**旧扩展遇到新报文只忽略、连接不受影响** |
| `node build/supervisor-error-bridge-probe.mjs` | 这条桥的端到端：迷你 socket 服务端按 supervisor 的报文形状发 error，用**真的** `SupervisorConnection` 收（§8.8） |

### 8.7 连接条按钮矩阵（2026-09-15 用户口径调整）

连接条只在**未就绪**时渲染（`ready` 时整条消失），所以按钮只在"没连上"的语境里讨论。
三档状态 + 四个标志（`serverRunning` / `externalServer` / `reconnecting` / `needsToken`）决定给哪几个：

| 状态 | 什么时候 | 按钮 |
|---|---|---|
| `stopped` + 后台不在跑 | 关掉 `autoStart` 的常态、「停止服务器」、守护进程退场 | **启动服务器** |
| `stopped` + 后台在跑（或外部地址） | 用户点过「停止连接」；或「停止服务器」但后台还在 | **尝试连接** |
| `connecting` | 首轮连接、掉线后的重连循环、外部地址的等待 | **停止连接** |
| `error` | 连不上（客户端断开、认证失败、守护进程 failed） | **尝试连接** + 内部模式的**重启服务器** |
| 任意分支持续 | 外部服务器缺令牌 | **输入令牌** |
| 任意分支 | — | **查看日志**（恒显） |

两条与 2026-09-14 那版不同的口径：

1. **「停止连接」绑 `connecting`，不绑 `reconnecting`**。`reconnecting` 只回答"重连循环还在不在跑"，
   是连接条**文案**用的；而用户在意的是一件事——**只要还在连，我就得能停下来**
   （首轮连接同样可能卡在"等就绪"上没有时长上限）。宿主侧 `stopReconnect()` 的守卫
   也从 `if (!this.reconnecting) return` 改成"当前是 `connecting`/`disconnected` 才动手"。
2. **「尝试重连」→「尝试连接」**（英文 `Reconnect` → `Connect`），并且**「查看日志」恒显**：
   连接条上任何一档都可能是"连不上但说不清"，日志入口不该只在部分状态下出现。

界面侧的对应实现与断言：`src/webview/App.tsx` 的 `ConnectionBar`、`scripts/styles.test.ts` 第 16 组、
`test/preview.html?conn=…&locale=…`（六种连接状态 × 中英各一遍，肉眼可核对按钮组合）。

### 8.6 dsh 崩了却不再被拉起：`!server.child` 判不出死亡（2026-09-15 修）

起因是用户问"守护进程能不能自动重启卡死/卡退消失的 node.exe"。查下去发现两件事，
一件是**真 bug**，另一件是**能力边界**：

1. **真 bug（已修）**：主循环原来写 `if (!serverStarting && !server.child && clients.size > 0)`。
   `server.child` 是 `spawn(..., {shell:true})` 返回的 **ChildProcess 对象**，
   **进程死了它不会变成 undefined**——`exit` 处理器只记日志、没人清这个字段。
   于是 dsh 一死，`!server.child` 永远为假：**重启分支再也进不去**。
   实测证据（修复前的 supervisor.log）：`exit` 事件确实到了、之后 tick#5…tick#80
   里 `server.child` 一直停在那具死掉的 pid 上，窗口侧表现就是"连着连着没了，再也接不回来"。
   修法：判活问进程本身（`exitCode/signalCode` 已置位，或 `isProcessAlive(child.pid)` 为假），
   见 `src/supervisor/main.ts` 的 `childGone()`。
   反向验证：把判据退回旧写法，探针 A/B 两组立刻转红。

2. **能力边界（尚未做，用户未表态）**：判据只覆盖"进程消失"。
   **卡死**（进程在、外壳也在、但不再应答、端口可能还占着）**不会**被重启——
   supervisor 与 dsh 之间只有那条启动时读公告行的管道，没有任何探活。
   用户那侧看到的是连接轮一轮失败、点「重启服务器」才恢复。

3. 顺带记两条平台事实（探针实测，别再重新猜）：
   - `spawn(command, [], {shell:true})` 返回的句柄**是 cmd.exe 外壳**，真 dsh 是它的子进程
     （本机：supervisor `Code.exe` → `cmd.exe /d /s /c "dsh web …"` → `node.exe bin.js web …`）；
   - **杀掉真 node，外壳会跟着退出**（约 100ms 内），`exit` 事件随之到达，`code=1`。
     也就是说"只杀 node 不动外壳"这个担心不成立；`killServer` 里"按端口兜底"那道仍然值得留着
     （外壳先死、node 成孤儿的情形确实存在，例如 supervisor 被强杀）。

### 8.8 守护进程内部抛错：从"静默死掉"到"有处可看"（2026-09-15）

起因是一次自伤：我在 `child.on("exit")` 里加了一行诊断，引用了不存在的变量，
`ReferenceError` 从事件回调冒到顶层 → **守护进程以 code=1 消失**（窗口侧只看到"连不上"）。
用户随即要求："抛错可以捕获，并将错误发回 VSCode 的日志吗？"

**两层问题要分开看**：

1. **错误会弄死守护进程**（已修）：所有事件回调/处理器（tick、socket、dsh 的 exit/error、
   control 请求、shutdown、SIGTERM）都套了守卫，`process.on("uncaughtException" |
   "unhandledRejection")` 兜底；原则是**记下来、活下去**——守护进程死了没有任何东西能接替它。
   两处**真死锁**一并修掉：
   - `bringUp` 中途抛错会让 `serverStarting` 卡在 `true`，主循环"崩了要重起"与"没人用要退场"
     两条路**同时瘫痪** → 改成 `try/finally` 复位；
   - `startServer` 的轮询回调一抛，那个 promise **永不 settle**，`bringUp` 永远挂着 →
     出错即 `finish(undefined)`（"本轮失败"），并把异常交给 `onError`。

2. **错误没人看得见**（已修）：守护进程是独立进程，它的日志在
   `~/.dsh/dsh-chat-vscode/supervisors/<分组>/supervisor.log`——用户不会去翻。现在两级上报：
   - **文件**是底线（没有窗口连着时唯一的收件人），写不进去退 stderr（此前会被静默吞掉）；
   - **socket 广播**（协议新增 `{"t":"error","kind","message"}`）→ 扩展侧转发进
     输出通道「DSH Chat」，连接条的「查看日志」就是入口。
   两个实现细节是**实测踩出来的**：
   - **补发**：最要命的错误恰恰发生在"一个窗口都还没连上"的时候（刚起、日志不可写、
     dsh 起来就退），那一刻广播给的是空集合。所以上报器保留最近 16 条，新连接先补发再推状态；
   - **向后兼容**：旧扩展不认识 `t:"error"`，协议"读不懂就忽略"这条纪律保证了它不受影响
     （有专门断言钉住）。

**顺带修掉一个我自己引入的回归**（探针抓到）：加 `try/finally` 时，`serverStarting = false`
从 `publish()` 之前被挪到了之后，于是会合文件里**永远写着 `starting: true`**——
新窗口/重载后的窗口会一直等一个"正在启动"的后台。正常路径的复位必须排在 `publish()` **之前**。

**验证**：`scripts/supervisorErrors.test.ts`（上报器本体，离线）、
`scripts/supervisorProtocol.test.ts` 第 5.5 组（报文往返与坏数据处理）、
`node build/supervisor-error-bridge-probe.mjs`（这条桥的端到端）、
以及 `supervisorChildExitProbe`（真守护进程 + 真故障下仍然活着并重启 dsh）。

