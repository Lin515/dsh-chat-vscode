# DSH Chat

在 VS Code 里用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）对话的第三方扩展。

`dsh web` 在后台运行，**界面由扩展自己绘制**——不嵌入浏览器页面，也不是网页端的复刻。
界面语言与交互遵循 [Continue](https://github.com/continuedev/continue) 的设计取向
（无气泡的消息流、单行可折叠的过程信息、带缺口状态条与流式描边的输入框），
会话能力则全部来自 dsh。

[English](#english) | 简体中文

---

## 特性

**会话与对话**

- 自动拉起并连接本机 `dsh web`，断线指数退避重连，长活流自动重开
- 会话列表（按今天/更早分组、可搜索）、新建、切换、历史回放；滚到顶自动加载更早的
  历史（一次触发**取到一轮的开头为止**，插进来之后视口停在原来那几行上、旧轮次一出现
  就是折叠态；手动按钮保留作兜底，整条连取链期间显示「正在加载更早消息…」）
- 会话会**注册进当前项目的工作区**（`workspace/create` + 按 `workspaceId` 建会话），
  所以在 DSH Web 端按工作区分组显示，而不是一律「未分组」（证据见
  `scripts/workspaceProbe.ts`；此前已经建好的会话不会追溯分组）
- 流式对话：正文逐 token 上屏，思考独立成块并在结束后自动收起
- 工具调用压成单行（读取 / 写入 / 编辑 / 运行 / 搜索…），点开查看完整参数与结果
- 读取节点只读了一段时，行号缀在文件名后（`…/controller.ts:100-120`）；该后缀不参与
  压缩，窄侧栏下宁可截断路径也保住行号——一眼看出模型是读了整个文件还是只扫了一段
- **自动载入的提示词可见**：系统提示词、上下文注入（插件注入、MCP 状态、记忆召回…）、
  项目指令（AGENTS.md）、技能目录都作为节点出现在对话里，默认收起、标注来源与字数，
  点开看全文；标签用官方词汇（「上下文注入」/「跨会话召回」/「系统提示词」），
  并随上下文注入一起进「轮级过程」折叠（只有系统提示词那一条与中止/截断提示不折）
- 运行中的节点（构建等长任务）：圆点与思考节点同样呼吸发光，展开区显示完整命令与
  **每秒跳动的实时耗时**，随时能确认它还在跑
- 编辑类节点（`edit` / `write` / `str_replace`）展开时渲染为**结构化 diff**：
  窄对话框单栏、宽对话框左右对照（`dshChat.diffLayout` 可选自适应 / 固定单栏 / 固定双栏）
- 审批与提问卡片：允许 / 拒绝；未识别的交互事件一律放行，避免把 Agent 挂住。
  **问卷**（`ask_user_question`）默认一次展开全部题目，题目多于 `dshChat.questionBatch`
  时改成依次问答（上一题 / 下一题），答完**自动收缩**成一行，可再点开复看
- 代码块卡片：复制、插入当前编辑器、语言标注、长块折叠
- 停止生成（按钮或 Esc）；**队列非空时，Esc 会中止当前轮并把队首消息接着发出去**
  （提示文案随之变为「按 ESC 可中止并发出排队消息」）；排队消息逐条列出，可直接
  「取回重新编辑」（内容回到输入框，附件一并还原）或单独取消

**输入与上下文**

- 输入 `/` 弹出斜杠命令菜单（含**技能**，技能带「技能」标记——它不是可执行的命令，
  选中只是把名字写进正文），继续输入即过滤，↑↓ 选择（选中项自动滚进视野）、Enter 确认
- 输入 `@` 弹出文件候选（含目录）。**选中目录默认是打开它**（继续下钻）；
  只有点右侧的「整个目录」按钮才是把目录本身作为 `@dir/` 引用载入。
  进了子目录之后列表**顶部**多出 `..` 一行，点它回到上一层
- 编辑器右键「添加选中代码到对话」加进来的是**部分引用**：芯片上带行号
  （`src/config.ts:12-40`），提示词正文里同样写明行范围；加完之后焦点回到
  你上次用的那个对话窗口（侧栏或编辑区面板），不再固定跳主侧栏
- **引用与上传（对齐官方）**：文件不再把正文塞进提示词，而是走两条官方路径——
  - 图片 → 内容块（字节随消息发送）；
  - 其余文件 → **选中即上传**，芯片上显示进度，发送时只带 `receiptId`；
  - `@` 引用 → 正文里只出现 `@path`（目录是 `@dir/`），模型需要内容时自己用
    `read` 工具读。这条由系统提示段 `context:file-reference` 定义语义
  - 为什么不再内联：内联让 token 成本高（一个源文件就吃掉几千 token）、二进制
    根本读不到、`@path` 的语义被抹掉、队列「取回重新编辑」退化成几百行文件内容
- 回形针按钮是**通用文件入口**，按内容分派；**读不出来又传不上去的**（极端情况）
  把带双引号的路径插到输入框光标处，而不是做一个读不出内容的芯片
  （模型不支持图片输入时，图片也走这条路径）；选区、拖拽同样归入附件
- **拖放文件到输入框**即可加入附件：界面只能拿到**字节和文件名**（VS Code 不给
  webview 拖拽资源的路径，`File.path` 自 Electron 32 起也已移除），所以拖放走
  base64 字节上传，单文件上限 8 MB（更大的请用回形针按钮，那条路是宿主直接读盘）。
  **注意：从 VS Code 资源管理器往外拖时，要按住 `Shift` 才能拖进 webview** ——
  webview 是 iframe，拖拽期间被 VS Code 用 `pointer-events` 挡住，不按 `Shift`
  时事件根本到不了界面（文件会在编辑器里被打开）。从系统资源管理器拖不受此限。
  目录不能拖放（读不出字节），请用回形针或 `@` 引用
- 目录单独入口（命令面板「添加文件夹到对话」或资源管理器右键文件夹）：
  VS Code 的文件对话框在 Windows/Linux 上**不能同时**选文件与目录，同时开只会
  变成目录选择器、文件全被过滤，所以两者必须分开
- 二进制 / 非 UTF-8 的判定口径与 dsh 自己的 `read` 工具一致
  （前 8KB 含 NUL 即二进制，否则要求严格 UTF-8）
- 模型与思考档位切换：4 档及以下一行；5/6 档固定分两行且均匀（5 → 3+2，6 → 3+3，
  用 grid 定列，上下两行列宽对齐）
- 权限模式切换：仅可查看 / 工作区内修改 / 完全权限（启用完全权限前有风险确认）

**过程信息与工具行（对齐官方语义）**

- 工具行**只在失败 / 被中止时画状态点**，其余时候显示工具自己的图标；分类走官方
  的精确名表（`bash`/`read`/`search`/`write`/`edit`/`code`/其余），`pwsh` 与
  `read_image` 等有各自的标题
- **四种状态**：运行中 / 成功 / 失败 / **已停止**（被中止——警告色而不是错误色，
  中断不是工具的失败）。中止时仍在跑的调用会**合成**一个中断结果，不会永远卡在
  「运行中」
- **终端退出状态**：`[exit code: N]` / `[killed by signal: X]` 从结果正文里剥掉，
  改以「退出码 N」呈现，并把非零退出升级为失败——bash/pwsh **故意**不把非零退出
  标成错误（「退出状态是结果数据」），所以这一步必须由客户端做，
  否则 `exit 1` 和 `exit 0` 长得一模一样
- **图片结果可见**：`read_image` 的图像块此前被整体丢弃；现在用
  `session/attachment` 把不透明句柄换成字节后显示
- **斜杠命令有自己的节点**：`command/run` ↔ `command/done` 折成一行可展开的
  命令记录，所以界面上按钮发出的命令（权限预设、计划模式）也看得见结果
- **模型重试有提示**：`llm/retry` 显示「正在重试 n/m…」，重试成功后收掉
- **达到输出上限会说明**：`turn/end` 原因为 `max-tokens` 时给一条「回答被截断」
- **轮尾两行文件都要等这一轮生成完**（`turn/end`）才出现：「本轮文件改动」
  （从成功的 `write`/`edit` 推导）与「交付文件」（`present` 工具的显式申报）是
  两条**互补**来源，官方也是两行并存、互不抑制——生成期间画的只是一行不断变长的
  文件名，看起来像已经定稿，所以与官方一致地等轮次结束。轮次结束的同一时刻会**主动
  推一次 Git 重扫**，于是这两行出现时记号是准的、用户第一次点芯片就直接进 diff
  视图（此前 git 扩展按文件事件去抖，刚写完的文件还没进改动清单，第一次点只会
  打开完整文件、点第二次才是 diff）
- **芯片上的改动记号**：新建文件标 `[新增]`、已删除的画删除线（文件在磁盘上不存在
  且**有确证**——`stat` 只把 `FileNotFound` 当删除，权限/离线盘等一律按「不确定」
  处理，不标记号）。这是本扩展在官方之上的信息增量（官方芯片只区分文件类型）

**面板**

- **历史对话**：分组、搜索、当前会话高亮
- **子代理**：列出当前会话的子代理，点进去查看它的完整对话记录
- **后台任务**：bash / pwsh / 子代理任务的状态、起止时间、耗时与明细
- **设置**：按服务端 schema 渲染全部命名空间（字符串 / 数字 / 布尔 / 枚举表单，
  复杂结构走 JSON 编辑），支持逐字段保存、整组重置、密钥写入（不回显）、
  「需重启生效」标注

**其它**

- 中英双语界面，跟随 VS Code 显示语言（也可用 `dshChat.language` 固定）
- 活动栏与辅助侧栏两种容器，另可在编辑器区打开独立面板
- **各对话窗口的状态跟着工作区走**：上次关掉这个文件夹时开着的窗口（主侧栏 / 辅助侧栏 /
  编辑区面板）与它们各自的会话，下次打开时自动回到原样；最近活动的那个窗口也记得，
  命令面板入口仍指向它。记录存放在 **VS Code 自己的工作区缓存**里
  （`workspaceState`，即 `workspaceStorage` 下的 `state.vscdb`），**不往项目目录写文件**；
  会话已被删除或归档时该窗口回落空态
- **任意助手回复都能「从这里分支」**（复制按钮左侧）：以该轮为界开一个新会话，
  原会话不动。生成中不能分支——契约要求锚点落在 `turn/end` 上
- **目标条**：当前目标的阶段、进度与暂停 / 恢复 / 清除，贴在输入框上方
- **占用率以圆环显示**：环内是百分比（60% 起转黄、90% 起转红），悬停给明细。
  数值口径与官方一致——prompt 侧、不含 output、优先 `projectedTokens`
  （所以**压缩后会下降**）。**常驻显示**：每轮结束都会刷新；投影还没给出新值时用
  同口径的本地复算兜底；什么新数据都没有时保留上一次的数字，不会空掉。
- **「加载更早的消息」**：跟随窗口只带 60 条，更早的内容**滚到顶部就自动加载**，
  并且一次触发就**取到一轮的开头为止**（顶部变成用户消息；连取由宿主驱动，界面只发
  一次请求）；插进来之后视口停在原来那几行上，旧轮次一出现就是折叠态。按钮只在服务端
  还有更早内容时出现，整条连取链期间它自己是**不可点的「正在加载更早消息…」**
- **Markdown**：GFM 任务列表、表格、脚注（`[^1]`，官方 `markdown.footnotes` 同口径，
  定义收进文末的 `section.footnotes`）；公式与代码高亮**刻意不做**（要引入 KaTeX / Shiki，
  见 `THIRD-PARTY-NOTICES.md` 的取舍记录）
- dsh 特有信息（token 用量、回合耗时）收进折叠行，默认不打扰
- VS Code 非正常关闭留下的 dsh 残留进程会在下次启动时被识别并清理；
  **崩溃遗留的文件锁**（`~/.dsh/*.yaml.lock`）同样会在启动前清掉——
  否则 `dsh web` 会因等锁 30 秒而整个启动失败

## 安装

### 从 VSIX

```bash
npm install
npm run package        # 产出 Releases/dsh-chat-<version>.vsix
```

VS Code → 扩展 → `…` → 从 VSIX 安装 → 选择产物 → 重载窗口。

### 从源码调试

```bash
npm install
npm run watch          # 增量构建
```

用 VS Code 打开本仓库，按 `F5` 启动扩展开发宿主。

### 前置条件

- VS Code ≥ 1.101（辅助侧栏容器需 ≥ 1.106，旧版本自动回退到活动栏）
- 本机可运行 `dsh`（未安装时扩展会回退到 `npx --yes @deepseek-ai/dsh@latest`）
- dsh 已配置模型凭据

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dshChat.url` | 空 | 已运行的 `dsh web` 地址；留空则由扩展自行启动并管理服务器 |
| `dshChat.autoStart` | `true` | 启动 VS Code 时自动连接 |
| `dshChat.command` | `dsh` | 启动命令（找不到时回退 `npx`） |
| `dshChat.startTimeoutSec` | `90` | 等待服务器就绪的秒数 |
| `dshChat.openPanelOnStartup` | `false` | 启动时在编辑器区打开对话面板 |
| `dshChat.diffLayout` | `auto` | 编辑类节点的 diff 排版：`auto`（窄单栏 / 宽双栏）、`unified`（固定单栏）、`split`（固定双栏） |
| `dshChat.language` | `auto` | 聊天界面语言：`auto` 跟随 VS Code、`zh-cn` 固定中文、`en` 固定英文 |
| `dshChat.fontSize` | `0` | 聊天界面字号（整数 px，≥8）；`0` 跟随 VS Code 的字号 |
| `dshChat.questionBatch` | `3` | 一份问卷一次展开几道题；题目多于它时改为**依次问答**。`0` = 始终一次展开全部 |

> 语言、字号与问卷题数改完**即时生效**，不需要重载窗口（它们只影响词典与几个数字，
> 重载反而会丢掉滚动位置与展开状态）。

### 外部服务器与访问令牌

`dshChat.url` 指向别人启动的 `dsh web` 时，该服务器若要求授权，扩展会弹框要求
输入访问令牌（就是启动 `dsh web` 时打印在 URL 里 `?token=` 之后那一段）。
取消输入时对话面板会给出「输入令牌」按钮，也可以用命令面板的
**DSH: 输入访问令牌** 随时重填。扩展自行启动的服务器不需要手动填：令牌由扩展
从子进程日志里解析。

**关于令牌刷新**：启动令牌是服务端**每次启动随机生成**的，存下来下次必然失效。
所以扩展存进 SecretStorage（不写 `settings.json`）的不是令牌，而是用它换来的
**会话 cookie**——cookie 的签名密钥存在服务端凭据库里，跨重启不变，有效期默认
30 天（由服务端 `cookieMaxAgeDays` 配置）。因此：

- 重启你自己的 `dsh web` 之后**不需要重新输入令牌**；
- 换机器、改端口、清空 DSH home 或 cookie 过期时才会再要一次。

> 实测记录见 `scripts/cookieSurvivesRestart.ts`：同一端口重启后旧令牌失效、旧 cookie 仍可鉴权。

### 残留进程检测

VS Code 正常关闭时扩展会连带结束自己拉起的 `dsh web` 进程树；但崩溃或强杀时
退出钩子不会执行，Windows 上就会留下 `node.exe` 孤儿进程。扩展每次启动服务器
都会写一张进程租约（`~/.dsh-chat/servers/`），下次激活时扫描：宿主进程已经
消失、而 dsh 进程还在的，确认命令行后自动清理并提示。手动入口是命令面板的
**DSH: 清理残留进程**，**DSH: 显示诊断信息** 会列出当前发现的残留进程。

两个实现要点：

- **判定「是不是 dsh」要起 PowerShell，所以整条链路是异步的**。Windows 上一次
  PowerShell 启动约 1.5s，用同步调用会把扩展宿主的主线程整个卡住（启动时表现为
  界面迟滞）。现在同步段只读租约文件，进程查询与 `taskkill` 一律 await；
  并发的扫描共享同一次在途查询，不会因为异步化而起两倍解释器。
- **只有确认命令行里确实是 dsh 才会杀**。拿不到命令行时按「不杀」处理——
  那恰好是最无法排除「pid 已被系统回收」的情形，此时动手等于闭着眼睛杀进程。
  判定写成「肯定证据才杀」（`=== true`）而不是「否定证据才跳过」（`!== false`），
  因为后者会让「拿不到命令行」这一态漏过去。

### 崩溃遗留的文件锁

强杀 VS Code（乃至强杀 `dsh`）会让 `~/.dsh/.credentials.yaml.lock` 这类
**writer 锁**留下来：`dsh-atomic-write` 用 `wx` 创建 `<file>.lock`（内容是持有者 pid），
靠 `finally` 删除；进程被强杀时 `finally` 不会执行。库本身**刻意不回收**孤儿锁
（「文件年龄无法证明持有者已经停止，孤儿回收是运维动作」），而 `dsh web` 的 boot
会去锁 `.credentials.yaml`，等 30 秒拿不到就抛错退出——于是下次启动直接失败：

```
Error: atomic-write: timed out waiting for the writer lock at
  C:\Users\<you>\.dsh\.credentials.yaml.lock
```

扩展把这个「运维动作」接了过来：**每次拉起服务器之前**检查 `.credentials.yaml`
与 `settings.yaml` 的锁文件，按**肯定证据**判定持有者是否已死——

| 情形 | 处置 |
| --- | --- |
| 锁里的 pid 不存活 | 持有者已死 → 删锁 |
| pid 存活但命令行不是 dsh/node | pid 被回收 → 删锁 |
| pid 存活且确实是 dsh | 真的在用 → **不动** |
| 拿不到命令行 | **不删**（无法排除 pid 被回收） |

删了锁会弹一条通知说明；启动仍然失败时，错误信息里会直接点出是哪个锁文件、
以及该怎么办（`ServerManager` 从子进程日志里把锁路径解析出来）。

## 工作原理

1. 扩展启动时运行 `dsh web --port 0 --no-open`：端口交给操作系统分配（不会撞端口），
   也不会抢占你的浏览器。
2. 从子进程输出解析 `dsh web: http://127.0.0.1:<port>/?token=…`，
   用该启动令牌换取签名 cookie——0.1.2 起 `/api` 与 WebSocket 握手都需要它。
3. 一元调用走 `POST /api/<method>`；实时内容走单条 WebSocket `/api/remote.mux`
   上的 `session/follow` 流（带 `assistantStream` 才有逐 token 增量）。
4. 事件流在宿主侧折叠成视图模型后才发给界面，**界面代码不认识 dsh 协议**——
   协议变更只影响适配层。

不想让扩展自行启动服务器：把 `dshChat.url` 指向你已经在跑的 `dsh web` 即可。

### 代码结构

```
src/
  extension.ts          命令注册与激活
  chatView.ts           webview 容器（CSP/nonce/资源加载/消息转发）
  shared/               宿主与界面共用的视图模型与 IPC 协议
  dsh/
    protocol.ts         线格式类型与端点参数名
    client.ts           HTTP RPC + WebSocket 多路复用流 + 认证
    serverManager.ts    拉起/探测/停止 dsh web，解析端口与令牌
    adapter.ts          事件流 → 对话记录（流式叠加层与去重）
    controller.ts       会话总控：连接、发消息、审批、模型、附件、面板
    settingsSchema.ts   设置 schema → 表单字段（纯函数，可离线测试）
  webview/
    App.tsx             界面骨架与顶栏
    components/         Composer / Message / Rows / Panels / History / Markdown
    styles/             tokens.css（设计 token）+ app.css（组件样式）
    texts.ts            中英文案词典
    markdown.ts         Markdown → 净化 HTML + 代码块切分
docs/
  continue-ui-spec.md   Continue 界面规格（px 级，带上游行号）
  dsh-server-api.md     DSH 服务端协议契约（带上游包名与行号）
```

## 开发

```bash
npm run watch          # 增量构建
npm run typecheck      # 宿主与 webview 两套 tsconfig（并行跑）
npm run test           # 离线单元断言（42 套，并行跑）
npm run build          # 生产构建
npm run package        # 打成 vsix
node scripts/bench.mjs # 开发循环耗时分解（哪一步慢）
```

> 构建本身很快（`npm run build` 约 0.7s）。历史上真正拖慢验证循环的是
> `token-cleanup` 那套断言：它在 Windows 上**逐个 pid** 起 PowerShell 取命令行，
> 而每次查询的代价几乎全在解释器启动上（实测单查一个 pid ≈1600ms，
> 一次查全部进程 ≈1800ms）。改成「一次取回全部进程的命令行」并取消固定 sleep、
> 再并行化之后，`npm test` 从约 14.6s 降到约 6s。
> 同样的问题也会拖慢扩展启动时的残留进程清理，所以这是产品与开发共同受益的改动。

### 验证手段

**端到端冒烟测试**（真实拉起 `dsh web`、真实调一次模型，不需要 VS Code）：

```bash
npm run smoke
```

覆盖：启动与令牌解析 → 签名 cookie → 会话列表 → 模型目录 → 新建会话
→ `$events` 审批通道 → 斜杠命令 → 发消息与流式 → 事件→视图转写
→ 历史回放 → 中途停止 → 审批应答 → 权限投影 → 模型切换。
测试会遍历模型目录挑选**本机真正可用**的模型，并在结束时还原被改动的
`agent-default-model` 设置。

**界面预览**（浏览器里加载真实 webview 产物，改样式时最快）：

```bash
npm run preview        # 打开 http://127.0.0.1:8777/test/preview.html
                       # 加 ?locale=en 预览英文界面
```

**专项诊断脚本**（由 `npm run build:scripts` 产出到 `build/`）：

| 脚本 | 用途 |
| --- | --- |
| `node build/probe.mjs <url> <token>` | 对一个运行中的服务器打印会话、投影与控制流状态 |
| `node build/model-switch.mjs` | 模型切换各条路径（跨 provider、沿用档位、不存在的模型） |
| `node build/panels-probe.mjs` | 子代理 / 后台任务 / 命令列表 / `@` 提及 / 设置表单的数据源 |
| `node build/schema-debug.mjs` | 设置 schema → 表单字段的离线转换结果 |
| `node build/dump-settings.mjs` | 转储全部设置命名空间到 `build/settings-schema.json` |
| `node build/set-default-model.mjs …` | 还原部署默认模型 |
| `npm run e2e:queue-esc` | 「Esc 中止并把队首消息发出」的端到端验证（真实起 dsh，断言发出且不重复、顺序正确） |
| `node build/cookie-survives-restart.mjs` | 验证「启动令牌每次刷新，但会话 cookie 跨重启仍有效」 |
| `node build/system-prompt-probe.mjs` | dump 真实会话里自动载入的提示词（系统提示词 / 插件注入 / 项目指令 / 技能目录）的来源、字数与是否重复 |
| `node build/effort-probe.mjs` | 打印各模型真实有几个思考档位（排版依据，别照预览夹具猜） |
| `node build/read-range-probe.mjs` | 真实跑一次 read，验证 `tool/result.meta` 形状与行号标注 |
| `node build/command-e2e.mjs` | 命令通道与投影形状的端到端验证：`/plan` 只认命令通道、`plan.pending` 的生效语义、`command/run`↔`done` 折叠、**真实** `goal` 投影的嵌套形状 |
| `node build/queue-continue-probe.mjs` | 「只 cancel 会不会让队列自动接续」——ESC 设计的立论依据（两轮各 3 次） |

> `session/selectModel` 会写回 `agent-default-model` 设置（dsh 服务端自身行为）。
> 会切模型的脚本都在结束前自动还原，避免污染本机默认。

## 已知限制

- **窗口状态恢复依赖 VS Code 自己的工作区缓存与面板恢复**：关掉工作区时若
  `window.restoreWindows` 为 `none`（或直接以「打开文件夹」重新进入而没有恢复上次的
  编辑器布局），编辑区面板本身就不会被 VS Code 恢复，这时只有侧栏视图按槽位接回会话。
  缓存里的会话被删 / 归档时窗口回落空态，不做「自动挑一个最近的会话顶上」。
- 不做回合级 Git 回退、子代理追问、计划模式的确认交互、轨迹视图。
- 上下文占用环需要服务端给出 `contextPressure` 投影（分子 + 分母）；没有该投影时不显示。
- 在模型胶囊里换模型会写回部署默认模型（与 dsh 网页端行为一致）。
- 服务端协议无版本协商。本项目针对 DSH **0.1.5-rc.1** 实测；0.1.2 的已知差异
  只有 `commands/execute` 的附件参数名（`images` → `submittedAttachments`），
  已按「新名优先、参数不匹配则回退并记忆」处理。
- **停止语义与官方契约有一处刻意的偏离**：官方契约说 cancel 后「排队的工作保留并按
  FIFO 继续」，UI 只发一次 cancel、不碰队列。但本机实测（`build/queue-continue-probe.mjs`）
  **只 cancel 不会让队列自行接续**（两轮 3/3 都停住），而「之后再提交新消息会不会唤醒
  队列项」则**不稳定**（同一脚本两次运行得到 0/3 与 3/3 两种相反结果）。
  所以本扩展仍是「摘空队列 → cancel → 等空闲 → 按原序重发」：它让 ESC 的行为**由客户端
  决定**，不依赖服务端那个测不准的分支。这是实测与契约冲突时的取舍，不是遗漏。
- **从 VS Code 资源管理器拖文件进输入框必须先按 `Shift`**：webview 是 iframe，
  拖拽期间 VS Code 用 `pointer-events` 挡住它，不按 `Shift` 事件到不了界面。
  这是 VS Code 的既有行为（`workbench.desktop.main.js` 的 `windowDidDragStart`），
  本扩展无法绕过；从系统资源管理器拖不受此限。拖放按字节上传，单文件上限 8 MB，
  目录不支持（读不出字节）。

## 归属与许可

本项目以 **MIT** 许可发布，见 `LICENSE`。

它建立在他人工作之上，**完整、逐项的披露见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)**，
一句话概括：

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**（MIT）——
  线协议类型的事实来源，`src/dsh/protocol.ts` 取自官方包的 `.d.ts` 声明。
- **[DeepSeek-Harness-for-VS-Code](https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code)**（MIT）——
  本项目 DSH 传输层（认证、`remote.mux` 流注册表、重连行为、服务器生命周期）
  是在阅读该扩展的客户端后编写的，**继承其结构写法**；界面层未采用其实现。
- **[Continue](https://github.com/continuedev/continue)**（Apache-2.0）——
  界面遵循其视觉与交互设计，按书面规格重新实现；**未拷贝其源码**，
  也未使用其名称或 Logo。

欢迎 issue 与 PR。提交前请确保 `npm run typecheck` 与 `npm run smoke` 通过。

---

<a id="english"></a>

# DSH Chat

A third-party VS Code extension for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

The `dsh web` server runs in the background and **the extension draws the conversation
itself** — no embedded browser page, and not a replica of the web UI. The interface
follows [Continue](https://github.com/continuedev/continue)'s design language
(bubble-less messages, single-line collapsible process rows, a notched composer with a
rainbow outline while streaming), while every conversational capability comes from dsh.

## Features

**Conversation** — auto-start and connect to a local `dsh web` with exponential-backoff
reconnect and automatic stream recovery; session list (grouped by today/earlier,
searchable), new chat, switching, history replay; earlier history loads automatically when
you scroll to the top; sessions are **registered into the project's workspace**
(`workspace/create` plus creating them by `workspaceId`), so they appear grouped by
workspace in the DSH Web UI instead of under "Ungrouped" (evidence:
`scripts/workspaceProbe.ts`; sessions created before this change keep their old grouping);
token-by-token streaming with reasoning
in its own collapsible block; **auto-loaded prompts are visible** — the system prompt,
plugin injections (MCP status, memory recall …), workspace instructions (AGENTS.md) and the
skill catalog each appear as a node labelled by origin with its size, collapsed by default
and expandable to the full text; tool calls collapsed to one line with full arguments and
results on click — a `read` that covered only part of a file shows the line range after the
filename (`…/controller.ts:100-120`), and that suffix never shrinks, so a narrow sidebar
truncates the path rather than the range; a call that is still running (a build, say) keeps
a breathing glow on its status line like the thinking node, and expanding it shows the
untruncated command plus a **live elapsed timer**, and edit-style calls (`edit` / `write` / `str_replace`) expanding into a
structured diff — single column in a narrow panel, side-by-side when wide
(`dshChat.diffLayout`: adaptive / always single column / always side-by-side); approval and
question cards (unknown interaction events are always
passed through so the agent never hangs) — a **questionnaire** opens with every question at
once, switches to one-at-a-time paging (Previous / Next) when it has more questions than
`dshChat.questionBatch`, and **collapses into a single row once answered**, expandable again
to review what was asked; code blocks with copy/insert, language label and
collapsing for long blocks; stop generation (button or Esc) — when messages are queued, Esc
also stops the current turn and sends the frontmost queued message; queued messages are
listed individually so each can be taken back into the composer for editing (text and
attachments restored) or cancelled on its own.

**Input and context** — type `/` for a slash-command menu that filters as you type
(↑↓ to move, Enter to confirm); it also lists **skills**, tagged as such because a skill is
not an executable command — picking one just writes its name into the message. Type `@` for
file mentions (files *and* folders): **selecting a folder opens it** (drills in); only the
"whole folder" button on the right of the row loads the folder itself as an `@dir/`
reference; once you have drilled into a folder, a `..` row appears **at the top** of the
list to climb back one level; a selection added from the editor's context menu is a
**partial reference** and carries its line range (`src/config.ts:12-40`) both on the chip
and in the prompt text, and focus returns to the chat window you were last using (sidebar
or editor panel) instead of always jumping to the primary sidebar. Attachments follow the
official two paths — images are sent as content blocks,
**every other file uploads the moment it is picked** (the chip shows progress, and the send
carries only a `receiptId`), and an `@` reference puts just `@path` in the message text, so
the model reads the file itself when it needs the contents (the `context:file-reference`
system-prompt section defines that meaning). Nothing inlines file bodies any more: inlining
cost thousands of tokens per source file, could never carry a binary, erased the `@path`
semantics, and degraded the queue's "take back to edit" into hundreds of lines of file
content. The paperclip button is a **single file entry point** that routes by content; what
can neither be read nor uploaded (a rare edge case) has its **double-quoted path inserted at
the caret** rather than becoming an attachment chip whose contents could never be read —
images go that way too when the active model takes no image input. Selections and
drag-and-drop land in the same attachment list; the binary/non-UTF-8 test is the same one
dsh's own `read` tool applies (a NUL byte in the first 8 KB means binary, otherwise strict
UTF-8 is required). **Dropping files onto the composer** attaches them: the webview can only
ever get the **bytes and the file name** (VS Code never hands a webview the paths of dragged
resources, and `File.path` was removed in Electron 32), so a drop uploads base64 bytes, with
a 8 MB per-file limit (use the paperclip for anything larger — that path reads from disk in
the extension host). **Dragging from the VS Code Explorer requires holding `Shift`**: the
webview is an iframe and VS Code blocks its pointer events for the duration of the drag
(`windowDidDragStart` in `workbench.desktop.main.js`), so without `Shift` the events never
arrive and the file opens in the editor instead. Drags from the OS file manager are not
affected. Folders cannot be dropped (their bytes cannot be read) — use the paperclip or an
`@` reference. Folders have their own entry point (the **DSH: Add Folder to Chat**
command, or right-clicking a folder in the Explorer), because VS Code's file dialog
**cannot** be both a file and a folder selector on Windows/Linux — enabling both silently
degenerates into a folder picker and filters every file out. Model and thinking-effort
switching (4 tiers or fewer stay on one row; 5–6 tiers are forced onto two evenly split rows
— 3+2 and 3+3 — using a fixed-column grid so the two rows line up); permission mode
switching (Read Only / Workspace Write / Full Access, with a risk confirmation before Full
Access).

**Process rows and tool semantics** — a tool row draws a **status dot only when it failed or
was stopped**; otherwise it shows the tool's own icon, classified by the official
exact-match table (`bash`/`read`/`search`/`write`/`edit`/`code`/others), with per-tool titles
(`pwsh`, `read_image`, …). Four states: running / ok / failed / **stopped** (interrupted —
a warning colour, not an error one, because an interrupt is not a tool failure); calls still
running when a turn aborts get a **synthesised** interrupted result instead of staying on
"running" forever. **Terminal exit status** is extracted from the result tail
(`[exit code: N]` / `[killed by signal: X]`) and stripped from the body, rendered as
"exit code N", and a non-zero exit is upgraded to a failure — bash/pwsh deliberately leave
`isError` false for a non-zero exit ("the exit status is result data"), so the client has to
do this or `exit 1` and `exit 0` look identical. **Image results are visible**: a
`read_image` image block used to be dropped entirely; it is now fetched through
`session/attachment` and shown. **Slash commands get their own node** (`command/run` ↔
`command/done`), so a command issued from a UI button has a visible result too. **Model
retries are announced** (`llm/retry` → "retrying n/m …", cleared once the retry resumes), and
a turn that ends at the output-token cap says so instead of looking complete. **The two
turn-tail file rows wait until the turn is finished** (`turn/end`): "Files changed" (derived
from successful `write`/`edit` calls) and "Presented files" (the `present` tool's explicit
declaration) are two **complementary** sources — the official UI shows both side by side
without suppressing or de-duplicating either — and drawing them mid-turn only produces a row
of file names that keeps growing and looks final. The same moment triggers **one explicit Git
re-scan**, so the rows appear with correct markers and the first click on a chip opens the
diff view (previously the git extension's debounced refresh had not yet seen the new file, so
the first click opened the whole file and only the second showed a diff). **Change markers on
chips**: a newly created file is tagged `[new]`, a deleted one is struck through — deleted
only on positive evidence (`stat` counts `FileNotFound` alone as deletion; permissions,
offline shares and the like are treated as "unknown" and left unmarked). That is information
the official UI does not offer (its chips only distinguish file type).

**Panels** — **History** (grouped, searchable), **Subagents** (list the session's
subagents and open their full transcripts), **Background jobs** (state, start/end, duration
and detail), **Settings** (every namespace rendered from the server schema: string/number/
boolean/enum forms, JSON editing for complex structures, per-field save, per-group reset,
secret writes without echo, "needs restart" badges).

**Other** — bilingual UI following the VS Code display language (or pinned via
`dshChat.language`); **any assistant reply can be branched** (the button left of Copy) into
a new session cut at that turn, leaving the original untouched — not while generating, since
the contract requires the anchor to land on a `turn/end`; a **goal bar** above the composer
showing phase, progress and pause/resume/clear; **context occupancy as a ring** with the
percentage inside (amber from 60%, red from 90%) and the breakdown on hover, using the
official numerator (prompt-side, preferring `projectedTokens`, so it **drops after a
compaction**) and **always on screen** — it refreshes every turn, falls back to an
identically-derived local figure while the projection has no numerator yet, and keeps the
previous number rather than blanking when there is nothing new; earlier history **loads
automatically when you scroll to the top** and keeps paging (host-driven) until it reaches
**the start of a turn** — the topmost message becomes the user's previous message — pinning
the viewport to the lines you were reading, with turns that come back already folded staying
folded; the manual "load earlier messages" button stays as a fallback and shows
**"Loading earlier messages…" (disabled)** for the whole run; **Markdown** covers GFM task
lists, tables and **footnotes** (`[^1]`, the same shape as the official `markdown.footnotes`:
the definitions collect into a trailing `section.footnotes`), while math and syntax
highlighting are **deliberately out** (they would pull in KaTeX / Shiki — see
`THIRD-PARTY-NOTICES.md`); activity bar and secondary
sidebar containers plus a standalone editor-area panel, and **each chat window's state
travels with the workspace**: the windows that were open when you last closed the folder
(activity bar / secondary sidebar / editor-area panel) reopen on their own sessions, and
the most recently active window is remembered so command-palette entries still target it —
the record lives in **VS Code's own per-workspace cache** (`workspaceState`, i.e. the
`state.vscdb` under `workspaceStorage`), never in a file inside your project, and a window
falls back to its empty state if its session has since been deleted or archived;
dsh-specific stats (token usage,
turn duration) tucked into collapsible rows;
leftover `dsh web` processes from an unclean VS Code shutdown are detected and cleaned up on
the next launch, and so are **orphaned writer locks** (`~/.dsh/*.yaml.lock`) — without that
cleanup `dsh web` fails to boot after waiting 30s for a lock whose owner is long gone.

## Install

```bash
npm install
npm run package        # produces Releases/dsh-chat-<version>.vsix
```

Then in VS Code: Extensions → `…` → Install from VSIX → reload.

Prerequisites: VS Code ≥ 1.101 (secondary sidebar needs ≥ 1.106, otherwise the activity
bar is used); `dsh` runnable locally (falls back to `npx`); model credentials configured.

### Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `dshChat.url` | empty | Address of an already-running `dsh web`; leave empty to let the extension manage its own server |
| `dshChat.autoStart` | `true` | Connect automatically when VS Code starts |
| `dshChat.command` | `dsh` | Launch command (falls back to `npx`) |
| `dshChat.startTimeoutSec` | `90` | Seconds to wait for the server to become ready |
| `dshChat.openPanelOnStartup` | `false` | Open the panel in the editor area on startup |
| `dshChat.diffLayout` | `auto` | Diff layout for edit calls: `auto` (single column when narrow, side-by-side when wide), `unified`, `split` |
| `dshChat.language` | `auto` | Chat UI language: `auto` follows VS Code, `zh-cn`, `en` |
| `dshChat.fontSize` | `0` | Chat UI font size in integer px (≥ 8); `0` follows the VS Code font size |
| `dshChat.questionBatch` | `3` | How many questions of one questionnaire to show at once; more than this many are asked **one at a time**. `0` always shows every question at once |

Language and font size apply **immediately** — no window reload, which would cost you the
scroll position and every expanded row for no reason.

## How it works

The extension spawns `dsh web --port 0 --no-open` (the OS picks the port, so it never
collides and never steals your browser), parses the launch token from the child's output to
exchange for a signed cookie, then talks to the server over `POST /api/<method>` for
one-shot calls and a single multiplexed WebSocket at `/api/remote.mux` for streaming.
Events are folded into a view model on the host side before reaching the webview, so **the
UI code knows nothing about the dsh protocol**.

Point `dshChat.url` at an existing server if you would rather manage it yourself. If that
server requires authorization the extension prompts for the access token (the `?token=`
value from the `dsh web` launch URL), verifies it and keeps the resulting **session cookie**
in VS Code's SecretStorage — or use **DSH: Enter Access Token** from the command palette.
Servers the extension starts itself need no manual token: it parses one from the child
process output.

The launch token is regenerated randomly on **every** server start, so it is never worth
persisting; the signed cookie is, because its signing secret lives in the server's
credential store and survives restarts (30 days by default, the server's
`cookieMaxAgeDays`). Restarting your own `dsh web` therefore does not ask for the token
again.

Leftover processes: every launch writes a process lease under `~/.dsh-chat/servers/`; on the
next activation the extension looks for dsh processes whose owning VS Code window is gone,
confirms the command line and kills the tree, and reports what it found. **DSH: Clean Up
Leftover Processes** does it on demand, and **DSH: Show Diagnostics** lists what is
currently detected.

Two things worth knowing about the implementation. The whole chain is **asynchronous**,
because deciding "is this command line dsh?" needs PowerShell and a single Windows PowerShell
start-up costs about 1.5s — a synchronous call would freeze the extension host's main thread
(visible as UI lag during activation), so only the lease-file reads are synchronous and every
process query and `taskkill` is awaited; concurrent scans share one in-flight query so
becoming async does not double the number of interpreters. And a process is killed **only when
its command line is positively confirmed to be dsh**: when the command line cannot be read the
extension does not kill, since that is exactly the case where the PID may already have been
recycled, which is why the check is written as "kill on positive evidence"
(`confirmed === true`) rather than "skip on negative evidence" (`confirmed !== false`).

Orphaned writer locks: killing `dsh` (or VS Code) mid-write leaves `~/.dsh/.credentials.yaml.lock`
behind, because `dsh-atomic-write` creates `<file>.lock` with `wx` and relies on `finally` to
remove it. The library deliberately refuses to reclaim orphans ("file age cannot prove the owner
stopped; orphan recovery is an operator action") — but `dsh web`'s boot takes that same lock and
gives up after 30 seconds, so the next launch fails outright. The extension performs that
operator action **before every server start**, deciding on positive evidence only: a dead PID, or
a live PID whose command line is not dsh/node, means the lock is orphaned and gets removed; a live
dsh owner is left alone; an unreadable command line means leave it. When startup still fails, the
error message names the lock file and says what to do.

## Licence and attribution

MIT — see `LICENSE`. This project builds on the work of others; the full itemised
disclosure is in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). In short: protocol
types come from DeepSeek Harness (MIT); the DSH transport layer inherits its structural
approach from DeepSeek-Harness-for-VS-Code (MIT); the interface follows Continue's design
(Apache-2.0) and was re-implemented from a specification without copying its source.
