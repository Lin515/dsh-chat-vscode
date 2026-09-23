# DSH 兼容性追踪与对齐

**本文是什么**：本扩展与官方 `@deepseek-ai/dsh` 的版本对齐规则、核对台账、以及**兼容代码的登记与退役**
表。**什么时候读**：官方发新版后、要改协议相关代码前、要删「兼容旧版」的分支前；以及发布扩展版本时
定发布去向（商店还是只发 GitHub）。

工具在 `scripts/dshCompat.ts`（命令 `npm run dsh:watch` / `dsh:check`）；分级与抽取规则在
`scripts/dshContract.ts`。契约面本身见 `docs/dsh-server-api.md`。

---

## 一、官方渠道（事实，不是推测）

官方只发四档，映射写在它的发布脚本里（`deepseek-harness/scripts/release/families.ts` 的
`DshFamily.distTagForVersion`，断言在同目录 `families.spec.ts`）：

| 官方版本串 | npm dist-tag | 俗称 |
|---|---|---|
| `x.y.z` | 不设 tag → `latest` | 正式版 |
| `x.y.z-rc.N` | `next` | 候选版 |
| `x.y.z-alpha.N` | `alpha` | 内部版 |
| `x.y.z-canary.N` | `canary` | 金丝雀 |

- **没有 beta 档**。真出现 `beta`，按上面的映射会落进 `next`；本工具把它单列，只是为了不误判成 rc。
- **发布 npm 是手动动作**：`.github/workflows/release-publish.yml` 是 `workflow_dispatch`，且
  `release:verify` 强制要求当前 ref 是 `dsh-v*` tag。所以 **tag 一定先于 npm 存在**，
  「官方 git tag 有、npm 上查不到」就是**仅在 GitHub 发布的测试版**（实测存在：`0.1.3-alpha.1`）。
  这是本工具的机械判据，不需要人去判断。
- **扩展商店的对齐基准是 npm 的 `latest` 现值**。不要用版本串去推导「是不是正式版」：
  `latest` 当前指向 `0.1.5-rc.3`（一个 rc，因为正式版还没发过），而 `alpha` 指向 `0.1.7-alpha.2`。
  每次读 registry 的 `dist-tags` 现值即可，`npm run dsh:watch` 会把当前基准打出来。

---

## 二、判定 → 动作 → 发布去向

契约差异分三级（规则与实现见 `scripts/dshContract.ts`）：

- **P0 破坏**：本扩展**在用**的东西消失 / 改名 / 内容变了。
- **P1 新增**：官方新增端点 / 事件 / 类型，或我们消费的类型**只多了成员**——读的一方不受影响，
  不崩；是否跟进是产品决策。（`dsh:check` 会把「只新增」单列成 `type-members-added`，与破坏分开。）
- **P2 无关**：不在消费面上的变化。

| 契约差异 | 扩展动作 | 发布去向 |
|---|---|---|
| 只有 P2 | 台账记一行「已核对，无影响」，**不动代码、不发版** | 无 |
| 有 P1、无 P0 | 可跟进；不跟进则只记台账 | 无 |
| 有 P0，且该版本是 npm `latest` | 改代码 + `npm run typecheck` / `test` / `build` + 版本号 + CHANGELOG | **扩展商店 + GitHub Release** |
| 有 P0，且该版本不是 `latest`（alpha / rc / canary / 仅 GitHub） | 同上 | **仅 GitHub Release** |

CHANGELOG：某版本若含与 DSH 对齐的改动，在该版本条目里写明**对齐的是哪个 DSH 版本**。

---

## 三、兼容代码的规矩

1. **能同时兼容新旧就兼容**，不要为了跟进新版而把还在用旧版的用户抛下。两个模式：
   - **新名优先 + 记住可用名**（`runCommand` 的 `images` ↔ `submittedAttachments` 回退）；
   - **双通道读、新通道权威**（`onControlFrame` 同时读 `queues` 帧与 `inbox` 投影）。
2. **每条兼容代码都要登记到第五节**：兼容哪个 DSH 区间、落在哪个文件/函数、起算日、移除期限。
   写清「为什么留着」与「什么时候能删」——否则半年后没人敢删。
3. **移除期限 = 起算日 + 半年**。到期后由 `npm run dsh:watch` 报出来（打印已到期的条目），
   确认没有用户还在受影响版本上之后，删掉旧分支并把该行从表里移除。
4. 存量兼容代码（本表建立之前就写下的）以**本表建立日**为起算日。

---

## 四、核对台账

一行一个官方版本。**没有记录就等于没核对过**——`dsh:watch` 正是拿这张表当基准来判断哪些版本还欠核对。
第一行是**基准行**：本扩展当前对齐到的版本，它之前的版本不需要核对。

`状态` 一列只有两个值：`已核对`（结论已定，可以作为下一个版本的基准）、`未决`（报了 P0、
这轮还没处理完——它留在表里保住证据，但**不作为基准**，`watch` 会一直把它列出来直到有人收尾）。

<!-- dsh-compat:ledger:start -->
| DSH 版本 | 渠道 | 结论 | 扩展版本 | 核对日期 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 0.1.5-rc.3 | rc | 基准行：本扩展既有对齐版本，未逐项核对 | 0.9.2 | 2026-09-23 | 已核对 |
| 0.1.6-alpha.1 | alpha | P0 2，已确认无破坏（权限投影只读 `currentValue`，形状仍在；来源类型在 0.1.7-alpha.1 才真正换形状） | 0.9.3 | 2026-09-23 | 已核对 |
| 0.1.6-alpha.2 | alpha | P0 4，已确认无破坏（控制流的旧队列通道被删，扩展本来就双读 `inbox` 投影；`SessionSummary.completed` 与 `SessionQueuedItem` 本扩展不消费） | 0.9.3 | 2026-09-23 | 已核对 |
| 0.1.7-alpha.1 | alpha | 需兼容更新（P0 18：消息来源改「生产者自有 kind」、工具结果改一等消息、`session/control` 的 jobs 通道搬去 `job/*` 流、`subagents/list` 端点删除、预设 roster 删掉 `trust`、agent-presets 报 `package-removed`——实际是包改名） | 0.9.3 | 2026-09-23 | 已核对 |
| 0.1.7-alpha.2 | alpha | 已核对，无影响（`SessionFollowRequest.maxMessages` 是继承自 `SessionPageRequest` 的 Pick，成员仍在——见第七节「继承来的成员看不见」） | 0.9.3 | 2026-09-23 | 已核对 |
| 0.1.7-rc.1 | rc | 已核对，无影响（P0 0；P1 为新增的 `agentPresets/read` 与 `AgentPresetDocument`，未消费） | 0.9.3 | 2026-09-23 | 已核对 |
<!-- dsh-compat:ledger:end -->

**0.1.7-alpha.1 的 P0 18 里，真正动了代码的是六件事**（这是把扩展从 0.1.6-alpha.2 抬到
0.1.7-rc.1 的那一批，逐条都对着官方源码核过形状；第 18 条 `package-removed` 见本节末尾）：

- **消息来源不再有通用 `plugin` 成员**（`MessageSourceMap`）：每个生产者声明自己的 kind
  （`system-prompt` / `runtime-context` / `agent-instructions` / `skill-catalog` /
  `compact-checkpoint` / `ptc-mode` / `tool-jobs` / `goal` …），第三方插件落成
  `plugin:<包名>`，而 `source.kind === 'plugin'` 的消息**被服务端拒收**
  （`dsh-session-format-v3-to-v4` 的 `message-sources.ts`）。落点：`adapter.pushInjected`
  取插件名、`trajectory.sourcePluginName`、`webview/trajectoryTexts.sourceLabel`、
  `webview/components/Rows.tsx` 的副标题。
- **工具结果改成一等 `role:'tool'` 消息**：内容块直接挂在 `message.content` 上、失败在
  `message.isError`，旧的 `tool-result` 信封块被删除（V3→V4 迁移会抬升历史日志，新格式下
  再出现它会被判退役语法）。落点：`adapter.toolResultParts`（新旧都认、新形状优先）、
  `trajectory.resultText` / `resultIsError`。
- **后台任务换了通道**：`session/control` 的 `jobs` 字段与 `type:'jobs'` 帧删除（`SessionJob`
  类型也没了），改由 `@deepseek-ai/dsh-api-job-controller` 的 `job/list` 流
  （整表替换的 `{type:'rows', jobs}`）+ `job/kill`。落点：`protocol.STREAMS.jobList`
  / `client.followJobs`、`controller.openScopeJobs` 与 `onJobFrame`、形状读取器
  `dsh/jobView.ts`。
- **`subagents/list` 端点删除**（`SubagentCatalog` / `SubagentListEntry` 类型同去）：
  子代理目录现在只有 `subagentCatalog` 投影与 `subagent/catalog` durable 事件两条来源，
  活动状态由 `api-session/status` 中继补齐——**这三条扩展本来都在用**，所以改动只是
  「旧 RPC 不再请求」。落点：`controller.refreshSubagentCatalog` + `client.endpointAbsent`。
- **预设 roster 删掉 `trust`**（`AgentPresetRow`，连 `authorable` 一起走）：四个随产品交付的
  预设不再由服务端字段标记，「哪几个算内置」的判据换成官方 `display.ts` 的
  `isBuiltInPreset`——*不发布 `name` 的已知 id 就是内置*。落点：
  `webview/presetDisplay.ts` 的 `isBuiltInPresetOption`（有 `trust` 时仍以它为准）。
  ⚠ **这条是核对里漏掉、由用户报现象才补上的**：它躲在包改名后面（见第七节
  「包改名会把包内的类型差异整段盖住」），漏掉的后果是中文界面里预设名显示成英文。
- **`agent-presets` 包改名**成 `@deepseek-ai/dsh-agent-preset-registry`（端点 `agentPresets/*`
  没变）。这一条在报告里显示为 `package-removed @deepseek-ai/dsh-agent-presets` 的 P0，实际是
  搬家不是消失；两个包名都留在 `scripts/dshCompat.ts` 的清单里（旧名让旧版本的快照仍带着
  当时的端点与类型，新名让新版能被跟踪），否则会得到一条假的 P0。


---

## 五、兼容层登记

<!-- dsh-compat:layers:start -->
| 兼容项 | 兼容的 DSH 区间 | 落点 | 起算日 | 移除期限 | 为什么留着 |
| --- | --- | --- | --- | --- | --- |
| `session/control` 的旧队列通道（`queues` / `queue` 帧） | ≤ 0.1.6-alpha.1 | `src/dsh/queueView.ts`、`src/dsh/controller.ts` 的 `onControlFrame` | 2026-09-23 | 2027-03-23 | 官方提交 `72f2e71070` 删掉旧通道改由 `inbox` 投影承载；旧帧在 0.1.6-alpha.2 被彻底删除。两条同源同值，双读是为兼容没升级的旧服务端 |
| `session/control` 的 jobs 通道（baseline 的 `jobs` / `type:'jobs'` 帧） | ≤ 0.1.6-alpha.2 | `src/dsh/controller.ts` 的 `onControlFrame` 与 `applyJobs` | 2026-09-23 | 2027-03-23 | 0.1.7-alpha.1 把任务观察搬去 `job/list` 流（`SessionJob` 类型同去）；两条通道写同一个 `jobs` 字段，双读是为兼容没升级的旧服务端 |
| 工具结果的旧信封（`message.content = [tool-result{content, isError}]`） | ≤ 0.1.6-alpha.2 | `src/dsh/adapter.ts` 的 `toolResultParts`、`src/dsh/trajectory.ts` 的 `resultText` / `resultIsError` | 2026-09-23 | 2027-03-23 | 0.1.7-alpha.1 起工具结果是一等 `role:'tool'` 消息（内容块直接挂 `message.content`、失败在 `message.isError`），旧块被删；V3→V4 迁移会抬升历史日志，所以旧信封只可能来自没升级的服务端 |
| 消息来源的旧形态（`kind:'plugin'` + `source.plugin`）与 `user-rpc` 拼写 | ≤ 0.1.6-alpha.2 | `src/dsh/adapter.ts` 的 `pushInjected`、`src/dsh/trajectory.ts` 的 `sourcePluginName`、`src/webview/components/Rows.tsx`、`src/webview/trajectoryTexts.ts` | 2026-09-23 | 2027-03-23 | 0.1.7-alpha.1 起来源是生产者自有 kind（第三方插件落成 `plugin:<包名>`），通用 `plugin` 成员被删。读取端两形态都认：旧服务端照旧显示，新服务端从 `plugin:<包名>` 里取插件名 |
| `subagents/list` 端点（目录 + `parentAvailable` + `activity`） | ≤ 0.1.6-alpha.2 | `src/dsh/controller.ts` 的 `refreshSubagentCatalog`、`src/dsh/client.ts` 的 `endpointAbsent` | 2026-09-23 | 2027-03-23 | 0.1.7-alpha.1 删掉该端点（`SubagentCatalog` / `SubagentListEntry` 同去）；新服务端的目录由 `subagentCatalog` 投影与 `subagent/catalog` 事件承载、状态由 `api-session/status` 中继补齐。端点回 404 时记住一次就不再请求 |
| `commands/execute` 第三参数改名（`images` → `submittedAttachments`） | 0.1.5 前后两代 | `src/dsh/controller.ts` 的 `runCommand`（`attachmentsParam`） | 2026-09-23 | 2027-03-23 | 网关对参数名严格校验（多一个少一个都拒），改名即整条调用失败；协议无版本协商，只能试错回退 |
| 预设 roster 的 `trust` 字段（内置预设的判据） | ≤ 0.1.6-alpha.2 | `src/dsh/projections.ts` 的 `agentPresetsFromList`、`src/webview/presetDisplay.ts` 的 `isBuiltInPresetOption` | 2026-09-23 | 2027-03-23 | 0.1.7-alpha.1 删掉了该字段，判定改用官方 `isBuiltInPreset`（不发布 `name` 的已知 id 即内置）。有 `trust` 时仍以它为准，否则用户自写的同名预设会被静默改名 |
<!-- dsh-compat:layers:end -->

---

## 六、工具

```
npm run dsh:watch                      # 列出基准之后尚未核对的官方版本（渠道 / 是否在 npm / 是否 latest）
npm run dsh:check -- <版本>            # 核对一个版本：抓快照 → 与基准求差 → 出发布去向 → 打印台账行
npm run dsh:snapshot -- <版本>         # 只抓契约快照
npm run dsh:diff -- <旧版本> <新版本>   # 只求差
```

要点：

- 契约快照从官方 npm 产物离线抽取（每个 api 包都带 `lib/typert.host.js` 描述符与 `lib/**/*.d.ts`
  类型面），**不装 DSH、不起服务器、不花 token**。
- 快照落在 `docs/dsh-contract/<版本>.json` 并**提交进仓库**：这样核对下一个版本时不必重新下载旧版，
  也让「当时是怎么判的」以后可以复核。
- 消费面从仓库已有的唯一登记点推出来（`projectionIngest` 的投影键、`protocol.ts` 的三个事件表、
  源码里的端点字面量），**不另立清单**。
- 报告里出现 `⚠ 有 N 个包没取到` 时必须人工确认：缺证据不等于没影响。

---

## 七、已知边界

- **只覆盖契约面，不覆盖行为变化**。官方改了语义但没改形状时（例如「cancel 之后队列是否自动接续」，
  见 `docs/audit-summary.md` 的停止语义一条）快照是看不出来的，仍要靠探针实测。P0 是「要去看」的
  信号，不是结论。
- **消费面的类型名不只来自源码**：也扫 `docs/dsh-server-api.md` 里点名的类型。那份文档是逐字摘抄的
  契约参考，代码里按字段内联读值、不写类型名的地方（权限投影就是）靠它才认得出。偏保守，
  宁可多报。
- 类型面是**文本归一化后的差异**，不是语义差异：成员改名一定报，等价改写也会报（宁可多报）；
  只调成员顺序不报（接口的成员顺序不参与语义）。
- **注释不进类型文本**：官方顺手改 JSDoc 不会被报成形状变化。
- 抽取只覆盖 `scripts/dshCompat.ts` 里 `CONTRACT_PACKAGES` 列出的包；官方新增 api 包时要把包名补进
  那张表，否则那个包的变化不进报告。**包名会随官方重构搬家**（`dsh-agent-presets` →
  `dsh-agent-preset-registry` 就是实例）：新旧两个名字都留在清单里——旧名让旧版本的快照
  仍带着当时的端点与类型，新名让新版能被跟踪；只留新名会让旧快照凭空少一整个包，也会把
  端点漂移报成 `package-removed` 的假 P0。
- **继承来的成员看不见**（0.1.7-alpha.2 的 `SessionFollowRequest` 就是实例）：类型改成
  `extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>` 之后，成员不在本类型的文本里，
  工具会把它报成 `− readonly maxMessages?: number`。凡看到「接口成员消失」的 P0，先去官方源码里
  确认它是被删了、还是被搬进了 `extends` / `Pick` / 交叉类型；误报要写进台账，别照着改代码。
- **包改名会把包内的类型差异整段盖住**（0.1.7-alpha.1 的 `AgentPresetRow.trust` 就是漏网的实例）：
  同一个域的两个包名一个消失、一个出现时，报告只给 `package-removed` / `package-added` 两行，
  那个包**内部的逐字段差异一条都不会报**。所以看到这种成对的两行，必须把两边同名的类型
  **逐条对拍**（这次漏掉的后果是中文界面里预设名显示成英文，直到用户报现象才发现）。
  对拍命令：拿两个快照 JSON 的 `packages[*].types[<类型名>]` 直接比字符串数组。
- 工具不判断「该不该跟进 P1」，也不改代码——只给证据与分级。
