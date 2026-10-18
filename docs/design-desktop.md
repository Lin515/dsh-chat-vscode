# DSH 桌面端：接入内置服务

桌面端不是"另一个前端"，而是一个**已经有 DSH 在跑的宿主**：Electron 壳之外还有一个 DSH 子进程，扩展要连的是它，不另起一套。本文定这条接入路径的机制、判据与边界。

状态：**已落地**（2026-10-18）。机制、落点与判据见下；实机联调仍属需当次批准的探针。

## 实现落点

| 关注点 | 落点 |
|---|---|
| 认人（命令行 + 可执行文件收窄）、找口（回环筛选、权威构造） | `src/dsh/desktopSession.ts` |
| 进程表 / 监听端口查询与四个平台解析器 | `src/dsh/processTable.ts` |
| 票的名字推导、构造、签名、凭据文本扫描 | `src/dsh/browserSession.ts` |
| 发现四步的编排、有效期阶梯、拉起并等就绪（含干净子进程环境与早退判据）、生产依赖 | `src/dsh/desktopAttach.ts` |
| 目标那一支（`ensure` 的桌面端分支、认人结论缓存、拉起与等就绪、`openDesktopApp`） | `src/dsh/supervisorManager.ts` |
| 选路三轴与优先级链 | `src/dsh/connectTarget.ts` |
| 建客户端（装票 + 一次只读调用）、失败分类、心跳重发现 | `src/dsh/controller.ts` |
| 三向认证分叉（内部 / 外部 / 桌面端）与「停止内部 DSH」不碰它 | `src/dsh/connectionAttempts.ts`、`controller.ts` |
| 配置项 `dshChat.desktopExecutable`（machine 作用域） | `package.json`、`package.nls*.json`、`src/extension.ts`、`scripts/invariants.test.ts` |
| 连接条按钮与文案（双语） | `src/webview/connectView.ts`、`messages.ts`、`texts.ts`、`App.tsx`、`src/shared/{chat,ipc}.ts` |
| 顶栏那颗「打开」按钮的第二种形态（`openDesktop` / `desktopConnected`） | `App.tsx`、`src/webview/icons.tsx`、`messages.ts`、`src/shared/{chat,ipc}.ts`、`controller.ts` 的 `openDesktop`、`supervisorManager.ts` 的 `openDesktopApp` |

## 为什么不复用桌面端安装的 dsh 命令

桌面端会把 `dsh` / `dsh.cmd` 装进 PATH（`command-installation`），指向应用内置的 CLI。这条命令不能替代接入：

- `dsh --profile desktop` 被直接拒绝：`parseDshArgs` 的 `rejectElectronProfile` 判定 desktop profile 由 Electron 应用独占；桌面端自己的 CLI 只额外放开 `dsh plugin --profile desktop`（`runDesktopCli` 传的 `manageDesktopProfile`）。
- 不带 profile 时 `dsh web` 等价 `dsh --profile web`，起的是**第二套** DSH 进程。
- 两套进程共享同一个 DSH home，但**会话语义不共享**：会话写入是一把跨进程内核锁（`SessionWriteLease.acquire` 的 `session.lock`，冲突抛 `SessionAlreadyOwnedError`）。第二套进程最多只读桌面端正开着的会话，发不出消息、接不了正在跑的轮次。
- 附带代价：第二套进程会把插件子进程（MCP 服务器等）再起一遍。

因此接入目标只有一个：桌面端**已经在内置运行**的那套服务。

## 桌面端的进程与服务拓扑

| 角色 | 事实 |
|---|---|
| Electron 主进程 | 持有窗口、`dsh-app://` 品牌协议，以及到内置服务的转发 |
| DSH 子进程 | Electron 以 Node 模式 spawn，入口是 `@deepseek-ai/dsh-desktop-host`；profile 为 `<DSH_HOME>/profiles/desktop`，固定 `--host 127.0.0.1 --port 0`，端口每次启动随机 |
| 服务启动时机 | `main()` 的 `reconcileBackend()` 在应用 ready 后即启动，**不依赖登录或进入 workspace**；停在欢迎页时服务同样在跑 |
| 服务重启时机 | 安装更新会停掉宿主再拉起替换宿主，**端口与凭据都会变** |
| 单实例 | `claimDesktopSingleInstance`：重复启动只聚焦已有窗口，不开第二套服务 |
| profile 归属 | desktop profile 由应用独占（见上节），扩展只读它的端点，不写它的配置 |

## 启动令牌拿不到（设计如此）

链条每一环都堵住，不是"没找对地方"：

| 环节 | 事实 |
|---|---|
| 生成 | `browser-auth` 的 `processLaunchToken` 用 `randomBytes(32)`，存在进程内 `WeakMap`，随进程生灭 |
| 唯一出口 | `BrowserAuth.authenticatedUrl()` 把它拼进 URL 查询参数 |
| 交付 | desktop-host 把含令牌的 `ready.url` 经 IPC 发给 Electron 主进程 |
| 落地 | 主进程只在内存留 `hostUrl` / `hostCookie`，`authenticateWebHost` 用普通 `fetch` 换 cookie，`forwardWebRequest` 转发时自己写 Cookie 头 |
| 隔离 | 转发响应剔除 `set-cookie`（`WITHHELD_RESPONSE_HEADERS`）；窗口加载的是 `dsh-app://app/`，从不加载带令牌的 URL。令牌与 cookie 都没进过 Chromium 的 cookie 库，渲染进程拿不到 |
| 无旁路 | 没有 url-file / 环境变量 / CLI 开关；`printUrl` 打印的那行进的是子进程 stdout → Electron 主进程 stdout（打包 GUI 无可用控制台）；`DSH_WEB_URL` 是不含凭据的广告地址；未开 remote debugging |

结论：扩展不可能"要"到令牌，只能自铸等价凭据。

## 接入凭据：用本机签名密钥自铸浏览器会话 cookie

信任根不是启动令牌，而是 DSH home 里的签名密钥：

- 位置：`<DSH_HOME>/.credentials.yaml` 的 `records` 下 `client-connection/browser-session`；`payload.secret` 是 32 字节 base64url（`STORED_SECRET_VERSION` 为 1），由服务端首次启动时生成，跨重启不变，桌面端与 `dsh web` 共用。
- cookie 形状（`browser-auth`）：名字 `dsh-auth-` + base64url(sha256(authority))；值 `v1.` + base64url(JSON{version, authority, issuedAt, expiresAt}) + `.` + base64url(HMAC-SHA256(secret, 该 JSON 串))。`COOKIE_PAYLOAD_VERSION` 为 1。
- 验签是无状态的：`BrowserAuth.authenticate` 重算签名、比对 `authority`、检查有效期，没有发放台账。谁有密钥谁就能签出合法票。
- 有效期上限：请求的 `expiresAt - issuedAt` 不得超过 `connection` 行的 `cookieMaxAgeDays`（默认 30）。按天级短票、每次连接重铸。
- authority 必须与请求 `Host` 完全一致：统一用 `127.0.0.1:<port>`，不与 `localhost` 混用，否则票只对另一个地址有效。
- 通道覆盖：`rpc-host` 的 `admit()` 先认 v1 浏览器 cookie（`isAuthenticated`），再退到 v2 操作者 cookie（`authenticateApi`），因此一元 HTTP 与 `/api/remote.mux` 升级握手都认这张票。
- 信任栅栏：`isTrustedApiRequest` 接受 loopback Host，且无 `Origin` 时放行（扩展是 Node 客户端，不带 Origin）。
- 身份语义：v1 票对应进程内**共享的 `browserPeer`**（`rpc-host`），principal 为 owner、`interactions` 默认 `answer`——与桌面端窗口转发请求所用的是同一个 peer。审批与提问可能同时出现在桌面端窗口与扩展，任一侧作答都算作答；这与扩展连外部 `dsh web` 时与浏览器标签页并存的情形相同，不是新语义。
- 已核对：安装产物的 0.2.1-rc.2 与 checkout 的常量一致（cookie 前缀、v1 载荷、记录键、密钥长度）；对等版本的本机 loopback 服务实测：无票 `GET /` 401，自铸票 `GET /` 200、`POST /api/settings/describe` 返回 `ok:true`、`WS /api/remote.mux` 握手 101。

## 端点发现

四步，判据都不含机器相关固定值：

1. **认人**：命令行含 `dsh-desktop-host` 的进程即 DSH 子进程（spawn 形态见 `host-process`）。Windows 复用扩展已有的命令行快照（`processTable.fetchCommandLines`，CIM 批量查询）；macOS / Linux 用 `ps -A -o pid=,args=`。
2. **找口**：取该 pid 的 loopback LISTEN 端口（Windows `Get-NetTCPConnection`，macOS / Linux `lsof -F n`，Linux 无 lsof 时退到 `ss -ltnp` 并按 `pid=` 过滤）。同一个 pid 可能同时有别的端口，不能只取一个——候选按端口升序逐个确认。
3. **确认**：对候选端口发 `GET /`，401 即认领成功（正文能读到时再核对一眼是否提到 dsh，读不到不强求）。这一步只证明"这是 DSH"，不代表鉴权可用。
4. **鉴权**：按该端口算 authority 签票，打一次只读一元调用（`settings/describe`），成功才算可连接。**票的有效期走阶梯**：先按官方默认的 30 天签，被拒就重读密钥、改用 1 天（配置项 `cookieMaxAgeDays` 的下限就是 1 天）再签一次；两次都拒才算不可连接——那个配置值不在凭据文件里，扩展不猜它。

`dshChat.desktopExecutable` 有三个用途：**收窄认人**（只认从该路径启动的进程，避免误认另一份安装；比较时路径分隔符归一、大小写不敏感）、**启动**（连接条上那两颗按钮）与**打开**（连上之后顶栏那颗「打开 DSH 桌面端」，见「浏览器访问」）。它为空时整条桌面端支路关闭（一次系统查询都不做）。

**认人结论缓存 10 秒**（`SupervisorManager.desktopProbe`）：认人要查一次进程表（Windows 上是秒级的 CIM 查询），而心跳 5 秒一拍、按钮文案与激活期选路都读它。用户显式动作（点按钮 / 激活期选路）强制重探；连接**已建立**时不再探测（沿用上次结论，与外部那一轴同口径）。

## 选路与优先级

两条轴之外新增桌面端轴，**事实**由本机制提供：`desktopConfigured`（配置了可执行文件）与 `desktopAttachable`（发现与鉴权都通过）。完整优先级链的权威在[后台与连接](<design-supervisor.md#选路与粘性目标>)，这里只声明本轴给判据的两条约束：

- **"已启动"不等于"可连接"**：进程在只说明下一步有得谈；按钮文案用"认人成功"（第 2 步），选路用"鉴权成功"（第 4 步）。
- **已启动完毕的桌面端可以复用其内部服务**：服务随应用启动即跑、与登录状态无关，对外只要求鉴权（loopback 过信任栅栏），不要求由谁发起；扩展连的是同一个服务进程，所以会话写入在进程内完成，能继续桌面端正开着的会话，不存在第二套进程的写锁冲突。前提是**同源**：扩展与桌面端解析到同一个 DSH home，否则签名密钥不同，签出的票会被拒——发现流程必须把"票被拒"与"没找到服务"分开报。
- **只想用桌面端**：把 `dshChat.command` 留空，内部那一轴就整个不存在（探测 / 接上 / 启动一并跳过），"都没有"那一支自然落到桌面端（见[选路](<design-supervisor.md#选路与粘性目标>)与[配置生效](<design-supervisor.md#配置生效>)）。

## 配置

`dshChat.desktopExecutable`：桌面端可执行文件路径。machine 作用域，禁止工作区覆盖，与 `dshChat.command` / `dshChat.url` 同列并同步 `invariants` 断言；默认空值关闭桌面端支路；改动提示重载，不热切服务（同[配置生效](<design-supervisor.md#配置生效>)）。界面文案按双语登记规则进 `packages.nls` 与 `MESSAGES`。

## 连接条与按钮

未连接态在 `desktopExecutable` 非空时增加一个按钮，文案按认人结果二分：未在跑为「启动 DSH 桌面端」，已在跑为「连接 DSH 桌面端」。启动后进入发现等待，超时归为**启动类**失败（不自动重试，避免 spawn 风暴，与现有启动类口径一致）。

「停止连接」对桌面端只有断 socket 一层语义：**扩展不关停桌面端进程**，也不进"停止内部 DSH"那套收场流程。取消等待从初始发现起覆盖到接入完成：启动前与异步结果返回后均检查取消；用户叫停、换目标或管理器释放后，旧尝试不得再启动应用或发布就绪。切到桌面端时立即交还内部 socket 与内部状态记忆，不等桌面端发现完成或下一次心跳。

## 启动桌面端：干净环境与早退

扩展宿主自己是被 VS Code 以 `ELECTRON_RUN_AS_NODE=1` 拉起来的，而 `spawn` 默认继承 `process.env`：那个变量会让桌面端可执行文件**以纯 Node 方式启动**——没有窗口、起一个 REPL、stdin 被 `ignore` 后立刻退出。而 `spawn` 事件在"进程已创建"时就触发，光看它察觉不到这一切，所以除了洗干净环境，还得能看见它的输出、也得认得出它退出了。

因此 `launchDesktop` 三件事一起做：

- **环境洗过**（`desktopLaunchEnv`）：删掉 `ELECTRON_RUN_AS_NODE`、`runtimeEnv` 列过的那几个 `ELECTRON_*` 变体与 `NODE_OPTIONS`。**只删不加**——桌面端要的是它自己那个正常的 GUI 启动形态；
- **输出留证据**：stdout / stderr 落到会合目录里的 `desktop.log`（`stdio: ["ignore", fd, fd]`，与那份 `supervisor.log` 并列但分开），失败时把它的尾巴经 `redactSecrets` 打进开发日志。**不用 `ignore`**：那等于把"起不来的原因"直接扔掉；**也不用管道**：它拖住调用方，而且扩展退出后读端一关，桌面端再往 stdout 写就是 EPIPE——一个不随 VS Code 退出的应用不该有这种死法；
- **把退出码交出去**：`launchDesktop` 返回一个句柄，等就绪那一轮（`startDesktopAndWait`）每轮问一次"它退出了没有"。

早退的判据是**两个条件的合取**：进程已退出，**且**现在认不到任何桌面端宿主进程。少了后一半会把单实例情形误判成失败——已经有一个桌面端在跑时，重复拉起只会聚焦已有窗口，拉起的那个进程随即退出而服务本来就该在。拿不到进程表时按"还有宿主在跑"保守处理（宁可多等，也不要把已经在跑的那个报成失败）。两档失败各报各的：刚起来就退出是 `@desktopExited`（带退出码，被信号杀死时不带参数），等满上限仍没就绪才是 `@desktopNotReady`。

## 浏览器访问：那颗按钮改成打开桌面端

桌面端内置服务**对浏览器是关着的**：入口层对非 `dsh-app://app` 的来源直接回 403，转发时还剔掉 `set-cookie`；浏览器能碰到的只有宿主那条回环端口，而它无票一律 401（票的两条来路见上「启动令牌拿不到」与「接入凭据」）。扩展自铸的票服务端认，但**塞不进浏览器**——没有跨源写 cookie 的手段，`openExternal` 也带不了请求头。

所以连的**就是桌面端内置服务**时（`ChatState.desktopConnected`：这一轮建起客户端的那份服务信息归属为 `desktop`），顶栏那颗「打开」按钮改成「打开 DSH 桌面端」：点它把桌面端应用拉起来（已在跑则聚焦已有窗口），**不动连接**——连的还是同一个服务进程，发现与重连仍归 `ensure()` 那条链路。目标粘在桌面端、这一轮还没连上时按钮保持原样（那时也没有能给浏览器的可用地址）。

这条判据读的是 `status.info.ownership`（`ServerInfo` 的归属），所以**内部那套的收尾只作废 `self` / `peer` 那一份**：目标不是内部时，管理器的 5 秒心跳会走一道"收掉陈旧内部连接"的兜底（`detachConnection`），而 `status.info` 里也可能放着另外两条轴的地址——外部与桌面端的就绪信息不归它管，必须原样留着。清状态本身不发帧，界面要等下一次整份快照（切换会话就是最常发生的那一次）才读得到它，一次误清就足以让那颗按钮退回"在浏览器中打开"。

要让真浏览器访问这套服务，唯一路线是扩展自己起一个本机回环反向代理（`/api/remote.mux` 的升级要原样管道、流式响应不能缓冲、二进制直传、一次性令牌与生命周期都得自己管）。它是独立特性，见「未决与暂不做」。

## 失败与回落

| 情形 | 处置 |
|---|---|
| 票被拒（401 / 403） | 重读密钥、按阶梯重签一次；仍被拒则判不可连接、回按钮态并说明。桌面端没有可输入的令牌，**不弹输入令牌框** |
| 读不到密钥（记录不存在，例如从未启动过任何 web / 桌面端服务） | 判不可连接、回按钮态并说明，不重试 |
| 启动类（可执行文件起不来、拉起后等不到就绪、**刚起来就退出**） | 判启动类失败，回按钮态 + 原因，**不自动重试**（避免 spawn 风暴），与内部那套的启动类口径一致。早退（`@desktopExited`）与等满上限（`@desktopNotReady`）分开报，前者不必白等满上限 |
| 端口消失（桌面端退出）/ 无匹配进程 / 端口不是 DSH | **不是终结**：留在「正在连接…」，下个心跳重新发现（≤10 秒一次的探测），直到连上或用户点「停止连接」——与内部后台失踪时的口径一致 |
| 更新重启宿主 | 端口与凭据同时变：已连接中途断线时，桌面端目标的重建**重新发现**（比对的端点是刚探到的那一份，不是上次 `ensure()` 留下的） |
| 验票时地址已不可达 | 按"没找到服务"处理（不是"票被拒"）：可能是宿主刚被换掉 |

## 安全与凭据处置

- 读 `.credentials.yaml` 等于读服务端签名私钥：只在发现流程内短活持有，用后即弃；不进日志（走 `redactSecrets`）、不进界面、不进错误详情，失败只报"读不到凭据"。
- 票按凭据对待（同外部会话 cookie）：**只在内存里持有**，用完即弃。**刻意不落 SecretStorage**——端口每次启动都变（安装更新还会换宿主），按固定键长期缓存一张过期的票只会误导；每次连接重铸一张天级短票的代价是一次 loopback POST。
- 发现只读进程表与 socket、只发只读一元调用；不执行任何进程操作（不杀、不改、不写入桌面端 profile）。
- 桌面端的 stdout / stderr 落到会合目录里的 `desktop.log`（0o600，与那份 `supervisor.log` 同权限，目录 0o700）：里面可能有它自己打印的带令牌地址，所以**只在失败时**取尾巴进日志、经 `redactSecrets`；这份文件不进界面、不进错误详情。
- `<DSH_HOME>/.credentials.yaml` 的权限由服务端保证，扩展不改它。

## 兼容与版本风险

- 依赖的都不是公开契约：cookie 名字前缀、v1 载荷、HMAC 口径、凭据记录键属 `dsh-client-connection` 内部实现，不在 `CONTRACT_PACKAGES` 里；`dsh-desktop-host` 的入口路径与 spawn 形态属桌面端实现（`host-process`）。两者都要按仓库惯例在[版本兼容](<dsh-compat.md>)登记为兼容分支：起算日 + 两个月后的复核 / 移除期限，并随官方版本对拍。
- 基准提升时，除契约快照外要额外核对本文点名的常量：cookie 前缀、`COOKIE_PAYLOAD_VERSION` / `STORED_SECRET_VERSION`、凭据记录键、`dsh-desktop-host` 入口。

## 验证方式

- 离线（登记到 `esbuild.scripts.mjs`）：
  - `scripts/browserSession.test.ts`——票的名字（固定向量）、载荷字段与顺序、HMAC 口径（独立重算）、有效期、密钥扫描（块作用域、记录缺失、格式非法、别的记录里的 `secret` 不误取、引号与流式形态、注释不算命中）；
  - `scripts/desktopAttach.test.ts`——认人（多进程、可执行文件收窄、大小写与分隔符）、找口（回环筛选、通配不算、多端口逐个确认）、四个平台解析器（CIM / `ps` / `lsof` / `ss`）、发现与鉴权的四种结论、有效期阶梯（被拒后重读密钥改短票）、拉起并等就绪的四档收场（就绪 / 超时 / 用户叫停 / 刚起来就退出，含"退出但认到宿主进程"不误报）、给桌面端准备的干净子进程环境（清掉 `ELECTRON_RUN_AS_NODE` 等、只删不加）；
  - `scripts/desktopOpen.test.ts`——顶栏「打开 DSH 桌面端」的宿主接线（真控制器）：`desktopConnected` 的判据（归属 desktop 且这一轮已连上）、切会话那一帧仍带它、点击只拉起桌面端且不动连接、起不来时一条共享通知、没配可执行文件时不 spawn；
  - `scripts/connectSnapshot.test.ts`——管理器只读快照；其中一组钉住"收掉内部连接"只作废 `self` / `peer` 那一份，外部与桌面端的就绪信息留着（界面那颗按钮的判据）；
  - [scripts/supervisorPolicy.test.ts](<../scripts/supervisorPolicy.test.ts>)——真 socket 假守护进程验证切桌面端立即交还内部占用；受控发现验证停止 / 释放后的迟到结果不启动应用、不发布就绪，已释放管理器不能复活；
  - [scripts/autoConnectOnce.test.ts](<../scripts/autoConnectOnce.test.ts>)——关闭自动连接后首次新建保存桌面端粘性目标，桌面端换端口后心跳只接上新端点（`start: false`）；
  - `scripts/connectTarget.test.ts`——选路组合（内部在 / 不在 × 外部配了 / 没配 / 可达 / 不可达 × 桌面端配了 / 没配 / 在跑 / 可连接 × 内部命令可用 / 不可用）与诊断串的三态；
  - `scripts/connectView.test.ts`——按钮矩阵（配置了才给那颗按钮、措辞按认人结论二分、连接中不给它、凭据失败不给输入令牌）。
- 实机联调属**需当次批准**的探针：启动桌面端 → 发现端点 → 签票 → 只读调用。只读探测同样按探针口径报批。
- 已做过的**只读真机核对**（Windows，2026-10-18，不发 HTTP、不读凭据、不起进程）：命令行批量查询解析了 201 个进程、认人给出 0 个候选（当时桌面端没在跑，所以"认到 + 收窄"仍只有离线夹具覆盖）；对当时在跑的 `dsh web`（pid 3812）查监听端口得到**两个**回环端口（`127.0.0.1:5674` 与 `127.0.0.1:9230`）——这正是"同一个 pid 可能同时有别的端口、必须逐个确认"的实例，也说明不能只取第一个。
- 跨平台：非 Windows 的认人与端口查询（`ps` / `lsof` / `ss` 三个解析器已被离线夹具覆盖，真机查询未跑过）发布前按仓库惯例在 WSL 上过一遍。

## 未决与暂不做

- 不做"扩展内嵌桌面端窗口"或接管桌面端 GUI：只接服务；连上之后那颗「打开」按钮也只是把桌面端应用拉起来，不嵌它。
- 不做**浏览器访问桌面端内置服务**的回环反向代理（见「浏览器访问」）：要自己扛 WebSocket 升级管道、流式转发、二进制直传与一次性令牌，属独立特性。这颗按钮的"改成打开桌面端"就是它的替代方案；哪天要做，它才是让真浏览器进得来的唯一路线。
- 不做桌面端的启动后自动关闭、也不管它的进程生命周期。
- 桌面端停在欢迎页 / 未登录时服务已在跑，扩展能连上并按该 home 的既有会话工作；是否为此改变连接条文案（例如提示桌面端尚未登录）留待后续评估。
- 更新替换宿主的那段时间可能连不上，暂不专门做"更新中"状态。
- 连接条那行**两轴短语**没有加第三段（"桌面端 DSH：…"）：桌面端那一轴由那颗按钮的措辞表达（未在跑 → 「启动」，在跑 → 「连接」），加第三段会让窄侧栏更挤。真要加，就是 `statusDesktopRunning` / `statusDesktopNotRunning` 两条文案加一个拼装分支。
