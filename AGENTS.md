# 项目 AI 文档（DSH Chat）

> 本文件是**本仓库所有 AI 会话的强制约束**。项目内约定优先于用户级 `~/.dsh/AGENTS.md`。
> 改代码前先读这一份；与它冲突的改动一律先问用户。

## 最高优先级：任何改动都必须考虑中英双语

**硬规则，不是建议。** 扩展商店面向全球，任何**新增/修改用户可见文字**的改动都必须同时备好中英两套。

### 三条链路，语言来源不同

| 载体 | 语言来源 | 放哪里 |
|---|---|---|
| **webview 界面**（聊天区、输入框、面板、目标条…） | `dshChat.language` 设置（`auto` 跟随 VS Code 显示语言） | `src/webview/messages.ts` 的 `MESSAGES`（唯一登记表；`texts.ts` 的两本词典由它派生） |
| **VS Code 原生 UI**（通知、输入框标题、错误弹窗、命令名、配置项描述） | **VS Code 自己的显示语言**（与上面的设置无关） | `package.nls.json`（英文，源语言）/ `package.nls.zh-cn.json`（中文） |
| **宿主 → webview 的文案**（toast、连接说明、错误详情） | 由 webview 决定 | 见下方「`@key` 标记」 |

### 硬性检查项（每次改动都要过一遍）

1. **不在宿主里写死用户可见的中文**。交给 webview 渲染的 → `@key` 标记；交给
   VS Code 自己弹出的 → `vscode.l10n.t(...)`，并在 `l10n/bundle.l10n.zh-cn.json` 里加译文
   （l10n 的 key 是英文源串，不是自定义 id；`package.json` 必须有 `"l10n": "./l10n"`，
   缺了 bundle 不加载、译文静默失效）。例外：`log()` 写进输出通道的调试日志是开发者可见，
   中文照旧。
2. **加了 `@key` 只需在 `MESSAGES` 里加一条**（`zh`/`en` 缺一不可，TS 会强制；带参数登记成
   函数、不带参数登记成字符串——于是「裸字符串被当函数调用」编译期就报）。词典与
   `resolveText()` 都由这张表派生；`scripts/i18n.test.ts` 核对登记表 ↔ `Texts` 接口 ↔
   宿主发射点 ↔ VS Code 两层的一致性。
3. **加了 VS Code 命令或配置项**，`package.nls.json` 与 `package.nls.zh-cn.json` 各加一条，
   `package.json` 里写 `%key%`。
4. **配置项说明只写作用**：说清「干什么、特殊值什么效果」即可，不写实现原理与历史口径、
   不写「改完需重载窗口」套话、不用 `**` 加粗（设置页不渲染成粗体）。
5. **文案不要拼字符串**（中英语序不同，`"已清理 " + n + " 个进程"` 翻不准）：带变量的写成
   `(n) => ...` 函数（见 `messages.ts` 的 `imagePathsInserted`），或 `@key:arg` + 词典函数。
6. **新增界面元素先想「英文下会不会溢出」**（英文常比中文长 1.5~2 倍）：按钮/胶囊/标签一律
   `white-space: nowrap` + `text-overflow: ellipsis`，不靠固定宽度；布局用 flex/grid、
   不依赖中文字数；窄侧栏最容易出事，改完用 `npm run preview` 看一眼。

### `@key` 标记：宿主怎么把文案交给界面

宿主不知道用户选了哪种语言，只传语言中立标记：
`this.emit({ type: "toast", level: "warn", text: "@uploadIncomplete:report.pdf" })`。
界面侧 `resolveText()` 翻译；不以 `@` 开头的文本原样显示（模型/服务端的原始报错就是这类，
**不要**翻译）。`i18n.test.ts` 双向检查：宿主发出的每个标记都要登记，登记过的每个标记也
必须有发射点——「死文案」和裸 key 一样是缺陷（`serverExited` / `switchingServer` 这么残留过
两轮）。可能外溢到 VS Code 原生通知的条目加 `vscode: true`（可选 `l10n:` 给位置占位符），
`hostText.ts` 与 l10n bundle 按这套清单对齐，缺译文/漏处理都会被断言抓住。

## 与官方 dsh web 前端保持一致

本扩展是 `dsh web` 的**自绘前端**：界面与组件是自己的，**能力与数据语义必须与官方一致**。
判断某处怎么实现：先读官方类型声明
`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包>\lib\types\**\*.d.ts`
（短、可读，是契约）→ 回 `lib/client.js` grep 确认实现 → 有疑问写探针实测，
**不要按猜测的形状写代码**。`docs/audit-summary.md` 是逐条对照的结论汇总，动相关代码前先看它；
`goal` 投影嵌套形状、`plan` 投影 `pending` 字段两个坑都源于没读契约。

**投影的通用读法**：投影里出现 `pending` / `wanted` 这类待提交值并与一个已提交值成对出现时，
界面上看到的生效状态是**两者的组合**，不是任何单个字段（`plan` 的 `pending ? !active : active`
即实例）。契约里逐字找这对字段再定读法。`schedule`、`agentPreset`、`subagentTiming` 三个面板
没做，重做时必然再撞。

## 官方版本对齐与兼容

追踪口径、发布去向、核对台账与兼容层登记都在 **`docs/dsh-compat.md`**（含官方四档渠道的出处）。
每次要做的动作：

- **官方发新版后跑 `npm run dsh:watch`**，对基准之后的每个版本跑 `npm run dsh:check -- <版本>`。
  核对结论必须落一行到 `docs/dsh-compat.md` 的台账——**没有台账记录就等于没核对过**，
  `dsh:watch` 正是拿那张表当基准（这是「声称已处理必须附证据」在版本对齐上的落点）。
- **只有 P0 才改代码**：P0 = 本扩展在用的端点/事件/类型消失、改名或形状变。只有 P2 时台账记一行
  「已核对，无影响」，**不动代码、不发版**。
- **发布去向**：该 DSH 版本是 npm `latest` 的现值 → 扩展同步发扩展商店；否则**只发 GitHub Release**。
- **能同时兼容新旧就兼容**（新名优先 + 记住可用名 / 双通道读，新通道权威），并登记进
  `docs/dsh-compat.md` 的兼容层表：起算日 + 半年 = 移除期限，到期由 `dsh:watch` 报出，确认后再删。
- **CHANGELOG**：某版本含与 DSH 对齐的改动时，写明**对齐的是哪个 DSH 版本**。
- 契约快照（`docs/dsh-contract/<版本>.json`）要提交进仓库：核对下一版时不必重新下载旧版，
  也让「当时是怎么判的」以后可复核。

## 构建与验证

- **npm 脚本直接在 `pwsh` 里跑**（会话沙箱需 `danger-full-access`；受限模式下 esbuild 会
  `spawn EPERM`、探针写 `~/.dsh` 会 `EPERM`）。构建姿势见 `build` skill。
- **标准命令：`npm run typecheck`、`npm test`、`npm run build`**——每次改动跑这三个就够，
  不起真实 dsh、不发真实消息、不花 token。
- **smoke 与探针是重验证，只在对应链路被改动时才跑**（对真实服务端建会话、发真实消息、
  每次花真 token；环境已由 `scripts/supervisorProbeEnv.ts` 全隔离到一次性临时目录，
  但「少跑」仍是第一道）：
  - `npm run smoke`：动了 `SupervisorManager` / `DshClient` / `SessionAdapter` /
    supervisor 连接链路才跑；
  - 各探针：动了 plan / goal / subagent / 工具行 / 队列 / 投影契约才跑，改前改后各一遍对拍；
  - 纯界面 / 文案 / 样式 / webview 改动**不要**跑——断言与改动无关，纯属烧 token。
- **（硬约束，用户 2026-09-20 立）禁止自动执行任何消耗 token 的验证**：smoke、探针、e2e
  一律**不得**在未经用户**当次明确批准**的情况下运行——即使用户要求「验证构建/改动」，默认也
  只跑三件套。确有必要时先说明「跑哪个、为什么非跑不可、预计耗时」，获批再跑；一次批准只对
  那一次有效。各探针的定位见文件头部「探针定位」块。
- **新增测试必须登记到 `esbuild.scripts.mjs` 的 `entries`**，否则 `npm test` 静默不跑。
- 改动界面后 `npm run preview` 看一眼（夹具覆盖各种节点形态；**夹具数据必须来自真实输出**）。
- **改完长 `switch` 或夹具必须看 `npm run build` 的 esbuild 警告**：`[duplicate-case]` 与
  重复对象键都不会让 typecheck 或断言变红——工具链全绿也会静默丢功能。
- **发布包走 `package.json` 的 `files` 白名单，仓库里不再有 `.vscodeignore`**（两者不能共存，同时存在
  会让 `npm run package` 直接失败）。白名单的含义是「**没列的不进包**」，所以新增要发布的东西时必须补进
  `files`——实测漏掉过 `CHANGELOG.md` 与 `LICENSE`：vsce 的 readme / changelog / license 处理器只处理
  **通过了过滤**的文件，漏掉时**不报错、包照出**。反过来，模式写错或过期会让 vsce 退出 1 并点名，不会静默；
  `scripts/manifest.test.ts` 还按清单里被引用的位置（`main` / `icon` / `l10n` / `%key%` / 演示图 /
  更新日志 / 许可证 / 第三方声明）逐条钉住了白名单。
- **动 plan / goal / subagent / 工具行之前先取基线**：`node build/command-e2e.mjs`（约 1 分钟）
  改前改后各一遍。长探针前台跑并给足 `timeoutMs`（`queue-continue-probe` 单轮约 3 分钟）。
- **跨 webview ↔ 宿主的改动两边都要装上**：`dist/webview.js` 与 `dist/extension.js` 是两份
  产物，只更新一半时新帧类型落进宿主旧产物的 `default` 分支静默失效，宿主日志里一行都没有
  （本地图片「加载失败」曾为此排查两轮）。判据：`npm run package && npm run install:vsix`
  后确认安装目录下两份产物的时间戳都是新的。

## 代码约定

- **「能不能启动后台」是一条显式许可**：`autoConnect` 只约束**自动**路径（激活期选路、窗口
  恢复、5 秒心跳），用户显式动作（发消息 / 新建 / 切换会话 / 启动 / 连接 / 重启内部 DSH）
  一律允许启动。「启动内部 DSH」与「连接内部 DSH」是**同一套逻辑**（有就接上、没有就起一套；
  界面两轴状态与真实状态有偏差，按钮同义才不会「点对了却没反应」）。只有「连接外部 DSH」
  不启动任何东西。认证链按 `ownership === "external"` 分叉（peer 窗口同样用会合文件里的
  token 换 cookie）。连接状态里 `stopped`（按钮态）与 `error`（启动/认证失败，要用户动作）
  分开渲染，连接类失败留在 `connecting` 里一轮轮重试。选路是纯函数
  `connectTarget.chooseTarget`，目标粘性——自动路径永不换目标。详见 `docs/design-supervisor.md`。
- **注释与文档用中文**（本仓库既有风格）；标识符用英文。引用其它文件内容用具体栏目名、
  函数名，不用节号、行号等易变标识。
- **界面文案一律走词典**，不在组件里写死中文字符串。
- **安全谓词按肯定证据写**（`=== true`），不按否定证据写——见 `processRegistry.isKillable`
  的教训：拿不到证据应当**不动**，而不是动手。
- **进程查询一律异步**（`await`）：同步 `spawnSync` 会冻住扩展宿主约 1.5 秒。
- **宿主 → webview 的帧是 JSON 过的，值为 `undefined` 的键会被整条丢掉**：「清空某个字段」
  必须发 `null`（宿主侧 `jsonSafeFrame`，界面侧 `mergeWirePatch` 折回「键不存在」），否则
  清空指令静默失效（「进行中的目标清不掉」即此）。细则见 `src/shared/wire.ts`，
  回归断言在 `scripts/wire.test.ts`。
- **线格式 ≠ 视图模型**：服务端字段与界面字段长得像时编译器不会拦——`toUsage` 只认线格式的
  `cacheReadTokens`，喂视图模型的 `cachedTokens` 会被静默忽略（不报错、值为空）。跨这层边界
  对着官方 `.d.ts` 逐字核字段名。
- **一条交互链路只开一个端口对象**：容器 ref 与该链路的动作合成**一个**对象交给组件
  （`src/webview/autoScroll.ts` 的 `AutoScrollPort` 是范例），不要把同一条链路的端口拆成
  多个 prop——规则会跟着端口散到多个文件，回归断言也只能写成「读源码正则」。
- **CSS 同特异性下后者胜**：新加的类可能悄悄吃掉既有伪类（`.is-stop` 压过 `:hover` 就是
  实例）。改样式后给**同语义元素**补一条「待遇一致性」断言（例如两个活性指示器的动画开关
  必须同步）。

## 安全口径（2026-09-17 全项目审计后立）

- **会执行代码 / 决定凭据去向的配置项必须是 `machine` 作用域**：`dshChat.command` 经 shell
  原样执行、`dshChat.url` 决定令牌与内容发往哪个 origin。默认的 `window` 作用域允许工作区
  覆盖——克隆来的仓库里一行 `.vscode/settings.json` 就能执行命令。断言在
  `scripts/invariants.test.ts`。
- **服务端给的值不可信**：会话 id 会被拿去拼路径删目录（`deleteSession` 两道：
  `isSafeSessionId` + `resolve()` 包含性检查）；socket 推来的状态逐字段验形状
  （`decodeServerMessage` 的 `checkState`），而不是只判「是个对象」。
- **拿不到证据就不动手**：按端口兜底杀进程前先确认身份（`looksLikeDsh`）；孤儿锁、pid 复用
  同理。端口会被无关程序接管，`taskkill /T /F` 杀错进程树是不可逆的事故。
- **长期存活的进程要把住内存**：socket 行缓冲有上限（`LineDecoder`），超限就断开；按会话/
  事件为键的 Map 必须有清理路径（`eventSessions` 曾只增不删）。
- **日志里会有秘密**：`supervisor.log` 含 dsh 的 stdout（启动公告带 `?token=`），凡是展示给
  人看的地方都要先过 `redactSecrets`。
- **并发入口要合并**：`ensure()`/`bringUp()` 这类「拉起一套」的入口必须幂等，否则两个窗口
  同时重启会 spawn 出两个 dsh，前一个的 pid 再也找不回来。

## 协作与交付纪律

- **需求方向别读反**。中文里的「**X 而不是 Y**」是在**要 X**，不是 bug 报告；「不要空着」
  不等于「拿不到就清空」。本仓库已经读反过两次。动手前用一句话复述验收标准，拿不准就问。
  
- **断言只钉确定的事实**。同一探针跑出 `0/3`、`0/3`、`3/3` 时，那件事就是不确定的：把分布
  打印成观察、注明「另一次运行结果相反」，不要写硬断言——那只会得到一条随机器负载飘的假防线。
  
- **声称「已处理」必须附证据**（文件:行 / 断言名），一句「已完成」不可靠。

- **注入式回归验证先确认注入生效**。写盘那一步静默失败（如 `Set-Content -NoNewline` 没写成），
  后面的「通过」是假的——先读回文件确认。
  
- **多个子代理并行改同一批文件前先划文件所有权**。子代理不受本仓库的观察规则约束，彼此读到
  的是中间态；同一文件交给一个代理写，其余只读。
  
- **CHANGELOG.md 说明**

  - **CHANGELOG.md** ：vsce 会将其作为扩展的「更新日志」打进 vsix，扩展页与商店页渲染的就是它
  - 它按**版本发布口径**写，普通 commit 禁止更改 `CHANGELOG.md`，仅在版本号更新时，再回溯 commit 至上个版本，总结所有用户可见面的更改。如果同一个处涉及多次改动，只需要说明最终效果，去除中间态。
  - 每条一句话说清「用户会看到什么变化」（新功能 / 界面变化 / 修好了什么），不写字段名、函数名、
    配置键、日志口径、实现机制这类只有读代码才知道的东西，也不举个人环境里的具体例子
    （提供商、模型、目录、会话名）——用中性说法。

  - **发布**：版本标题为 `## <版本>（日期）`；`npm version x.y.z --no-git-tag-version`；跑三件套；提交；`git tag -a v<x.y.z>`。
    **推 tag 即自动发布 GitHub Release**（`.github/workflows/release.yml`：校验 tag 与清单版本一致 → 跑三件套 →
    打包 vsix → Release 正文取 CHANGELOG 对应版本；带 `-` 的 tag 标为预发布）。**扩展商店不在该流程里**，
    仍是手工动作——商店的对齐基准是官方 DSH 的 npm `latest`，判据见 `docs/dsh-compat.md`。
