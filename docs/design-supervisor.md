# 独立守护进程（supervisor）托管 DSH 后台 —— 设计

> 状态：**设计待评审，尚未实现**。写于 2026-09-13。
> 取代 `docs/design-shared-server.md`（那份描述的是"窗口之间自己协商"的会合租约模型，
> 本文 §1 说明它为什么必须被换掉；那份文档保留作历史记录，不再作为实现依据）。
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
| R7 | 配置生效路径不变 | `dshChat.command` / `url` / `autoStart` 语义不变；空闲阈值可配 |

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
4. 路径长度：Windows 的 pipe/AF_UNIX 名有长度上限 → socket 放 `~/.dsh-chat/run/<分组>/sup.sock`（短路径，不复用长哈希目录）；
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

### 3.2 磁盘协议（沿用现有目录，只留会合信息）

```
~/.dsh-chat/servers/<配置指纹>/            ← 配置指纹沿用现有 leaseGroupKey（按有效配置算）
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
       ├─ 有、但 starting=true 且未超时                   → 等它就绪（轮询 ≤ 启动超时）
       ├─ 有、但 socket 连不上 / 服务器连不上且过了宽限     → 说明 supervisor 或 dsh 死了：
       │                                                   → 通知/重拉（见 §3.5 与 §3.4-3）
       └─ 没有                                          → 进入 ②
  ② 抢 OS 锁（<分组目录>/supervisor.lock，`wx` 独占 + 持有者 pid 判活）
       ├─ 抢到 → 写 supervisor.json（含 idleSec、command、socket 路径）→ spawn supervisor（detached）
       └─ 没抢到 → 说明别人正在起 → 回到 ① 轮询等待
  ③ 轮询 supervisor.json 直到 serverStartedAt 出现且 baseUrl 可连（≤ 启动超时）
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
      ③ 若 dsh 子进程退出（崩了）：
           - 仍有活连接 → 重新 spawn 并重新解析公告行（端口可能变，`--port 0` 时必变）→ 广播
           - 没有连接   → 自己退场
      ④ 热读 supervisor.json 的 idleSec（用户改配置后不必重启 supervisor）
      ⑤ 处理连接上的控制请求：ping / restart / stop / state
```

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
| dsh 自己崩了 | 端口没了、子进程退出 | supervisor 重新拉起（还有连接）或退场（没有连接）；端口变化经 socket 广播给所有窗口 |
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

**待定（实现前需确认）**

- **P1 ping 间隔**：建议 1 秒（同时兼作保活）。连接是长连接，ping 频率只影响
  "多久发现对端死了"——1 秒足够，也不必更密。
- **P2 已由 D6 解决**：`stop` 走 socket 控制请求，不再有"stop 请求文件"。
- **P3 是否需要"启动超时"提示的用户可见文案**（沿用现有 `@serverStartTimeout` 标记即可，暂定不改）。

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
