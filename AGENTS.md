# 项目 AI 文档（DSH Chat）

> 本文件是**本仓库所有 AI 会话的强制约束**。项目内约定优先于用户级 `~/.dsh/AGENTS.md`。
> 改代码前先读这一份；与它冲突的改动一律先问用户。

## 最高优先级：任何改动都必须考虑中英双语

**这是硬规则，不是建议。** 本项目从第一天就是双语的：VS Code 扩展商店面向全球，
用户里有中文也有英文用户。任何一次改动，只要**新增/修改了用户能看到的文字**，
就必须同时准备好中英两套。

### 三条链路，各自的语言来源不同

| 载体 | 语言来源 | 放哪里 |
|---|---|---|
| **webview 界面**（聊天区、输入框、面板、目标条…） | `dshChat.language` 设置（`auto` 跟随 VS Code 显示语言） | `src/webview/texts.ts` 的 `zh` / `en` 两个字典 |
| **VS Code 原生 UI**（通知、输入框标题、错误弹窗、命令名、配置项描述） | **VS Code 自己的显示语言**（与上面的设置无关） | `package.nls.json`（英文，源语言）/ `package.nls.zh-cn.json`（中文） |
| **宿主 → webview 的文案**（toast、连接说明、错误详情） | 由 webview 决定 | 见下方「`@key` 标记」 |

### 硬性检查项（每次改动都要过一遍）

1. **不在宿主里写死用户可见的中文**。宿主侧（`src/dsh/`、`src/extension.ts`）的
   注释用中文没问题，但**要显示给用户的文字**必须走下面两条之一：
   - 交给 webview 渲染的 → 用 `@key` 标记；
   - 交给 VS Code 自己弹出的 → 用 `vscode.l10n.t(...)`，并在
     `l10n/bundle.l10n.zh-cn.json` 里加译文。
   - **例外**：`log()` 写进输出通道的调试日志是**开发者可见**，不是用户界面文字，
     中文照旧（排查时读起来更快）——「用户可见」指的是界面与弹窗。
   - **`vscode.l10n` 的 key 是英文源串**（不是自定义 id），且 `package.json` 里
     必须有 `"l10n": "./l10n"`——缺这一项 bundle 根本不加载，译文会静默不生效。
2. **加了 `@key` 就必须补齐三个地方**，缺一个界面就会显示成原始 key：
   - `src/webview/texts.ts` 的 `Texts` 接口；
   - 同文件的 `zh` 与 `en` **两个**字典（TS 会强制，别绕过去）；
   - 同文件 `resolveText()` 的 `switch`（带参数的 key 必须在这里拆参数）。
3. **加了 VS Code 命令或配置项**，必须在 `package.nls.json`（英文）与
   `package.nls.zh-cn.json`（中文）里各加一条，`package.json` 里写 `%key%`。
4. **配置项说明只写作用**：nls 里的描述说清「这个选项干什么、特殊值是什么效果」
   即可，**不写实现原理、设计理由或历史口径**（那些放代码注释）。一两句话收住。
   不写「这是用户级设置（工作区覆盖不了）；改完需重载窗口」这类套话；也不用
   `**` 加粗（设置页里并不渲染成粗体）。
5. **文案不要拼字符串**。中文与英文的语序不同，`"已清理 " + n + " 个进程"` 翻不准。
   带变量的文案写成 `(n) => ...` 形式的函数（见 `texts.ts` 里 `imagePathsInserted`
   这类），或 `@key:arg` 标记 + 词典里的函数。
6. **新增界面元素先想「英文下会不会溢出」**。英文通常比中文长 1.5~2 倍：
   - 按钮/胶囊/标签一律 `white-space: nowrap` + `text-overflow: ellipsis`，
     不要靠固定宽度；
   - 一行里多个元素的布局不能依赖中文字数（用 flex/grid，不要用「大概这么宽」）；
   - 这条在**窄侧栏**下最容易出事——改动后自己用 `npm run preview` 看一眼。

### `@key` 标记：宿主怎么把文案交给界面

宿主不知道用户选了哪种语言，所以它只传**语言中立的标记**：

```ts
this.emit({ type: "toast", level: "warn", text: "@uploadIncomplete:report.pdf" });
```

界面侧由 `resolveText()` 翻译；不以 `@` 开头的文本原样显示（模型/服务端的原始报错
就是这类，**不要**去翻译它们）。

现有标记见 `src/webview/texts.ts` 的 `resolveText()`——**加新标记时同步加 case**，
否则用户会看到 `@yourNewKey`。`scripts/i18n.test.ts` 双向检查：宿主发出的每个标记
都要登记（`MARKERS`）、**登记过的每个标记也必须真有发射点**（只存在于词典里的
「死文案」和裸 key 一样是缺陷，`serverExited` / `switchingServer` 就这么残留了两轮）。

## 与官方 dsh web 前端保持一致

本扩展是 `dsh web` 的**自绘前端**，不是它的复刻，也不拿别的产品当类比：
界面是一套标准的 Chat 界面（token 与组件都是本仓库自己的），
但**能力与数据语义必须与官方一致**。判断某一处该怎么实现时：

1. 先读官方类型声明 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包>\lib\types\**\*.d.ts`
   （短、可读，是契约）；
2. 再回 `lib/client.js` grep 确认实现（直接读动辄几百 KB，很痛苦）；
3. 有疑问就写探针实测，**不要按猜测的形状写代码**。

`docs/audit-summary.md` 记录了逐条对照的结论与证据等级（含 2026-09-17 第二轮
全项目审计的漏洞 / BUG / 死代码清单），动相关代码前先看它。
已经踩过的两个坑（`goal` 投影的嵌套形状、`plan` 投影的 `pending` 字段）都源于
「没读契约、按猜测的形状写」。

**投影的通用读法（`plan` 只是个案，不是特例）**：凡是投影里出现 `pending` /
`wanted` 这类**待提交值**、并与一个已提交值成对出现时，界面上看到的生效状态
是**两者的组合**，不是任何单个字段。`plan` 的 `pending ? !active : active` 就是
这个通则在计划模式上的实例。契约里逐字找这对字段再定读法——还有
`schedule`、`agentPreset`、`subagentTiming` 三个面板没做，重做时必然再撞。

## 构建与验证

- **直接在 `pwsh` 里跑 npm 脚本**（会话沙箱需 `danger-full-access`；受限模式下
  esbuild 会 `spawn EPERM`、探针写 `~/.dsh` 会 `EPERM`）。构建姿势见 `build` skill。
- 标准命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`；
  端到端探针：`node build/command-e2e.mjs`、`node build/queue-continue-probe.mjs`。
- **新增测试必须登记到 `esbuild.scripts.mjs` 的 `entries`**，否则 `npm test`
  静默不跑（runner 只发现 `build/*.test.mjs`）。
- 改动界面后跑 `npm run preview` 看一眼：`test/preview.html` 的夹具覆盖了
  各种节点形态。**夹具数据必须来自真实输出**，不要编。
- **改完长 `switch` 或夹具后，必须看 `npm run build` 的 esbuild 警告**：
  `[duplicate-case]`（重复 `case` = 后者不可达，旧逻辑静默消失）与重复对象键
  （后者静默覆盖）都**不会**让 typecheck 或断言变红——工具链全绿也会丢功能。
  `npm test` 的 runner 只跑断言，看不到这类警告。
- **`.vscodeignore` 没列的东西会进 vsix**（`AGENTS.md` 自己曾被打进包 5.5 KB）。
  动发布相关内容时核对一遍。
- **动 plan / goal / subagent / 工具行之前先取基线**：`node build/command-e2e.mjs`
  （约 1 分钟）跑一遍，改完再跑一遍对拍。
- **长探针前台跑并给足 `timeoutMs`**（`queue-continue-probe` 单轮约 3 分钟）。
- **跨 webview ↔ 宿主的改动要把两边都装上**：`dist/webview.js` 与 `dist/extension.js`
  是两份产物，只更新一半时那条 IPC 会**静默失效**——webview 发了新帧类型，宿主侧
  旧产物里没有对应分支，请求落进 `default` 无响应，界面只显示自己的降级态，
  宿主日志里**一行都没有**（2026-09-18 实测：本地图片一直「加载失败」，代价是两轮排查）。
  判据：改完 `npm run package && npm run install:vsix`，再确认安装目录下两份产物的时间戳
  都是新的。

## 代码约定

- **"能不能启动后台"是一条显式许可**（`supervisorManager` 的 `autoConnect` + `ensure({start})`）：
  `autoConnect` 只约束**自动**路径（激活期选路、窗口恢复、5 秒心跳），用户**显式**动作
  （发消息 / 新建 / 切换会话 / 启动内部 DSH / 连接内部 DSH / 重启内部 DSH）一律允许启动——
  用户要后台时不该被配置挡住。**「启动内部 DSH」与「连接内部 DSH」是同一套逻辑**（有就接上、
  没有就起一套）：界面的两轴状态与后台的真实状态之间会有偏差，两个按钮语义相同才不会出现
  「点对了按钮却什么都没发生」。只有「连接外部 DSH」不启动任何东西（外部目标从来不由扩展拉起）。
  认证链按 `ownership === "external"` 分叉，**不按 `owned`**：peer 窗口
  （第二个窗口、重载后接上的同一个后台）同样用会合文件里的 `token` 换 cookie，内部模式没有
  「输入令牌」。连接状态里 `stopped`（按钮态：没连也没在试）与 `error`（启动类 / 认证类失败，
  要用户动作）必须分开渲染，而**连接类失败留在 `connecting` 里一轮轮重试**（没有自动停止的
  时间限制）。**选路**（内部优先、外部备用）是纯函数 `connectTarget.chooseTarget`，目标
  **粘性**——自动路径永不换目标。详见 `docs/design-supervisor.md` §8、§9。
- **注释与文档用中文**（本仓库既有风格）；标识符用英文。
- **界面文案一律走词典**，不在组件里写死中文字符串。
- **安全谓词按肯定证据写**（`=== true`），不按否定证据写（`!== false`）——
  见 `processRegistry.isKillable` 的教训：拿不到证据时应当**不动**，而不是动手。
- **进程查询一律异步**（`await`），同步的 `spawnSync` 会冻住扩展宿主约 1.5 秒。
- **宿主 → webview 的帧是 JSON 过的**（实测扩展宿主里的 `r8()` 就是
  `JSON.stringify`）：**值为 `undefined` 的键会被整条丢掉**，所以「清空某个字段」
  必须发 `null`（宿主侧走 `jsonSafeFrame`，界面侧 `mergeWirePatch` 折回
  「键不存在」）。漏掉这一步的症状是**清空指令静默失效**——用户 2026-09-12 报的
  「进行中的目标清不掉、切会话也一直在」就是它：服务端早已 `Goal cleared.`，
  界面纹丝不动。细则见 `src/shared/wire.ts`，回归断言在 `scripts/wire.test.ts`。
- **线格式 ≠ 视图模型**。服务端字段与界面字段长得像、类型都是可选 `number` 时，
  编译器**不会**帮你拦住喂错的那个——`toUsage` 只认线格式的 `cacheReadTokens`，
  喂视图模型的 `cachedTokens` 会被静默忽略（不报错、值为空）。跨这层边界时
  对着官方 `.d.ts` 逐字核字段名。
- **CSS 同特异性下后者胜**：新加的类可能悄悄吃掉既有伪类（`.is-stop` 压过
  `:hover` 就是实例）。改样式后除了看看，还要给**同语义元素**补一条
  「待遇一致性」断言（例如两个活性指示器的动画开关必须同步），否则下次改一个
  忘另一个。

## 安全口径（2026-09-17 全项目审计后立）

- **会执行代码 / 决定凭据去向的配置项必须是 `machine` 作用域**：`dshChat.command`
  经 shell 原样执行、`dshChat.url` 决定令牌与内容发往哪个 origin。默认的 `window`
  作用域允许工作区覆盖——克隆来的仓库里一行 `.vscode/settings.json` 就能执行命令。
  断言在 `scripts/invariants.test.ts`。
- **服务端给的值不可信**：会话 id 会被拿去拼路径删目录（`deleteSession` 两道：
  `isSafeSessionId` + `resolve()` 包含性检查）；socket 推来的状态要逐字段验形状
  （`decodeServerMessage` 的 `checkState`）而不是只判"是个对象"。
- **拿不到证据就不动手**：按端口兜底杀进程前先确认身份（`looksLikeDsh`）；
  孤儿锁、pid 复用同理。端口会被无关程序接管，`taskkill /T /F` 一棵无关进程树
  是不可逆的事故。
- **长期存活的进程要把住内存**：socket 行缓冲有上限（`LineDecoder`），超限就断开；
  按会话/事件为键的 Map 必须有清理路径（`eventSessions` 曾只增不删）。
- **日志里会有秘密**：`supervisor.log` 含 dsh 的 stdout（启动公告带 `?token=`），
  凡是把它展示给人看的地方都要先过 `redactSecrets`。
- **并发入口要合并**：`ensure()`/`bringUp()` 这类"拉起一套"的入口必须幂等，
  否则两个窗口同时重启会 spawn 出两个 dsh，前一个的 pid 再也找不回来。

## 协作与交付纪律

- **需求方向别读反**。中文里的「**X 而不是 Y**」是在**要 X**，不是 bug 报告；
  「不要空着」不等于「拿不到就清空」。本仓库已经读反过两次（各返工一轮）。
  动手前用一句话复述验收标准，拿不准就问。
- **断言只钉确定的事实**。同一探针跑出 `0/3`、`0/3`、`3/3` 时，那件事就是不确定的：
  把分布打印成观察、注明「另一次运行结果相反」，**不要**写硬断言——那只会得到
  一条随机器负载飘的假防线。证据不足时宁可少断言。
- **声称「已处理」必须附证据**。曾出现自称「8 个 `@key` 都处理了」而实际 6 个没做；
  逐条列出证据（文件:行 / 断言名）比一句「已完成」可靠。
- **注入式回归验证先确认注入生效**。改文件再跑的验证里，如果写盘那一步静默失败
  （例如 `Set-Content -NoNewline` 没写成），后面的「通过」是假的——先读回文件确认。
- **多个子代理并行改同一批文件前先划文件所有权**。子代理不受本仓库的观察规则约束，
  彼此读到的是中间态；同一文件交给一个代理写，其余只读。

## git

- commit **一律用中文描述**（用户全局规则）。
- **未经用户明确说「提交」不得 commit**；改完留在工作区等确认。
