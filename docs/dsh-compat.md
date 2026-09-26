# DSH 兼容性追踪与对齐

**本文是什么**：本扩展与官方 `@deepseek-ai/dsh` 的版本对齐规则、当前对齐基准，以及**兼容代码的
登记与退役**表。**什么时候读**：官方发新版后、要改协议相关代码前、要删「兼容旧版」的分支前；
以及发布扩展版本时定发布去向（商店还是只发 GitHub）。

工具在 `scripts/dshCompat.ts`（命令 `npm run dsh:watch` / `dsh:check`）；分级与抽取规则在
`scripts/dshContract.ts`。契约面本身见 `docs/dsh-server-api.md`。

**本文不记历史核对台账**：逐版本的核对结论属于提交说明与 `CHANGELOG.md`，文档只保留规则、
当前基准与兼容层登记——否则它会长成一份没人再读的流水账，而且每换一版就得维护两处。

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

---

## 二、判定 → 动作 → 发布去向

契约差异分三级（规则与实现见 `scripts/dshContract.ts`）：

- **P0 破坏**：本扩展**在用**的东西消失 / 改名 / 内容变了。
- **P1 新增**：官方新增端点 / 事件 / 类型，或我们消费的类型**只多了成员**——读的一方不受影响，
  不崩；是否跟进是产品决策。（`dsh:check` 会把「只新增」单列成 `type-members-added`，与破坏分开。）
- **P2 无关**：不在消费面上的变化。

| 契约差异 | 扩展动作 | 发布去向 |
|---|---|---|
| 只有 P2 | **不动代码、不发版**，核对完直接把基准行推进到该版本 | 无 |
| 有 P1、无 P0 | 可跟进；不跟进也推进基准行（P1 是产品决策，不影响「已对齐到这一版」） | 无 |
| 有 P0，且该版本是 npm `latest` | 改代码 + `npm run typecheck` / `test` / `build` + 版本号 + CHANGELOG，**处理完才推进基准行** | **扩展商店 + GitHub Release** |
| 有 P0，且该版本不是 `latest`（alpha / rc / canary / 仅 GitHub） | 同上 | **仅 GitHub Release** |

CHANGELOG：某版本若含与 DSH 对齐的改动，在该版本条目里写明**对齐的是哪个 DSH 版本**。
核对的结论（哪几处 P0、怎么处理的）写进提交说明与那条 CHANGELOG——不写进本文档。

---

## 三、兼容代码的规矩

1. **能同时兼容新旧就兼容**，不要为了跟进新版而把还在用旧版的用户抛下。两个模式：
   - **新名优先 + 记住可用名**（`runCommand` 的 `images` ↔ `submittedAttachments` 回退）；
   - **双通道读、新通道权威**（`onControlFrame` 同时读 `queues` 帧与 `inbox` 投影）。
2. **每条兼容代码都要登记到「兼容层登记」一节**：兼容哪个 DSH 区间、落在哪个文件/函数、起算日、
   移除期限。写清「为什么留着」与「什么时候能删」——否则到期后没人敢删。
3. **移除期限 = 起算日 + 两个月**（口径 2026-09-25 由半年缩短）：兼容旧版只保这么长的窗口，
   更老的用户已经该升级了。到期后由 `npm run dsh:watch` 报出来（打印已到期的条目），
   确认没有用户还在受影响版本上之后，删掉旧分支并把该行从登记表里移除。
4. 存量兼容代码（本表建立之前就写下的）以**本表建立日**为起算日。

---

## 四、当前对齐基准

**这里只记一个版本，不记历史台账。** 基准行的用途与推进时机：

- `npm run dsh:watch` 只列**基准之后**的官方版本；`npm run dsh:check -- <版本>` 拿基准与目标版本求差。
- **把那一版的差异处理完才推进基准**（有 P0 就改完代码并跑过三件套，无影响就直接改）。
  没处理完就保持原样——`watch` 会一直把基准之后的版本列出来，直到有人收尾。
- 基准**单调向前**：它之前的官方版本不需要核对（从最早的 tag 补起会把二十多个历史版本变成待办）。
  要看两个历史版本之间的差异，用 `npm run dsh:diff -- <旧版本> <新版本>`。

本扩展当前对齐：DSH `0.1.7-rc.2`（rc 渠道；与扩展 0.9.5 一起于 2026-09-24 核对）<!-- dsh-compat:baseline -->

---

## 五、兼容层登记

<!-- dsh-compat:layers:start -->
| 兼容项 | 兼容的 DSH 区间 | 落点 | 起算日 | 移除期限 | 为什么留着 |
| --- | --- | --- | --- | --- | --- |
| `session/control` 的旧队列通道（`queues` / `queue` 帧） | ≤ 0.1.6-alpha.1 | `src/dsh/queueView.ts`、`src/dsh/controller.ts` 的 `onControlFrame` | 2026-09-23 | 2026-11-23 | 官方提交 `72f2e71070` 删掉旧通道改由 `inbox` 投影承载；旧帧在 0.1.6-alpha.2 被彻底删除。两条同源同值，双读是为兼容没升级的旧服务端 |
| `session/control` 的 jobs 通道（baseline 的 `jobs` / `type:'jobs'` 帧） | ≤ 0.1.6-alpha.2 | `src/dsh/controller.ts` 的 `onControlFrame` 与 `applyJobs` | 2026-09-23 | 2026-11-23 | 0.1.7-alpha.1 把任务观察搬去 `job/list` 流（`SessionJob` 类型同去）；两条通道写同一个 `jobs` 字段，双读是为兼容没升级的旧服务端 |
| 工具结果的旧信封（`message.content = [tool-result{content, isError}]`） | ≤ 0.1.6-alpha.2 | `src/dsh/adapter.ts` 的 `toolResultParts`、`src/dsh/trajectory.ts` 的 `resultText` / `resultIsError` | 2026-09-23 | 2026-11-23 | 0.1.7-alpha.1 起工具结果是一等 `role:'tool'` 消息（内容块直接挂 `message.content`、失败在 `message.isError`），旧块被删；V3→V4 迁移会抬升历史日志，所以旧信封只可能来自没升级的服务端 |
| 消息来源的旧形态（`kind:'plugin'` + `source.plugin`）与 `user-rpc` 拼写 | ≤ 0.1.6-alpha.2 | `src/dsh/adapter.ts` 的 `pushInjected`、`src/dsh/trajectory.ts` 的 `sourcePluginName`、`src/webview/components/Rows.tsx`、`src/webview/trajectoryTexts.ts` | 2026-09-23 | 2026-11-23 | 0.1.7-alpha.1 起来源是生产者自有 kind（第三方插件落成 `plugin:<包名>`），通用 `plugin` 成员被删。读取端两形态都认：旧服务端照旧显示，新服务端从 `plugin:<包名>` 里取插件名 |
| `subagents/list` 端点（目录 + `parentAvailable` + `activity`） | ≤ 0.1.6-alpha.2 | `src/dsh/controller.ts` 的 `refreshSubagentCatalog`、`src/dsh/client.ts` 的 `endpointAbsent` | 2026-09-23 | 2026-11-23 | 0.1.7-alpha.1 删掉该端点（`SubagentCatalog` / `SubagentListEntry` 同去）；新服务端的目录由 `subagentCatalog` 投影与 `subagent/catalog` 事件承载、状态由 `api-session/status` 中继补齐。端点回 404 时记住一次就不再请求 |
| `commands/execute` 第三参数改名（`images` → `submittedAttachments`） | 0.1.5 前后两代 | `src/dsh/controller.ts` 的 `runCommand`（`attachmentsParam`） | 2026-09-23 | 2026-11-23 | 网关对参数名严格校验（多一个少一个都拒），改名即整条调用失败；协议无版本协商，只能试错回退 |
| 预设 roster 的 `trust` 字段（内置预设的判据） | ≤ 0.1.6-alpha.2 | `src/dsh/projections.ts` 的 `agentPresetsFromList`、`src/webview/presetDisplay.ts` 的 `isBuiltInPresetOption` | 2026-09-23 | 2026-11-23 | 0.1.7-alpha.1 删掉了该字段，判定改用官方 `isBuiltInPreset`（不发布 `name` 的已知 id 即内置）。有 `trust` 时仍以它为准，否则用户自写的同名预设会被静默改名 |
| 预设选择的可见性判据（roster 的 `modeSelectionEnabled`） | ≤ 0.1.7-rc.1 | `src/dsh/projections.ts` 的 `agentPresetsFromList`、`src/dsh/controller.ts` 的 `loadAgentPresets` / `publishAgentPresets` / `applyDeveloperTools` | 2026-09-24 | 2026-11-24 | 0.1.7-rc.2 起服务端不再有这个策略（官方 `a44534e274` 把选择可见性并进客户端的「代码工作工具」开关，宿主持久化在 `ui-settings`）；旧服务端仍以 roster 字段为准，两代都读 |
| 审批原因的旧形态（只有 `reason`） | ≤ 0.1.7-rc.1 | `src/dsh/controller.ts` 的 `deliverEventToScope`、`src/webview/components/Rows.tsx` 的 `ApprovalCard` | 2026-09-24 | 2026-11-24 | 0.1.7-rc.2 起 asker 可附只用于展示的本地化 `displayReason`（官方界面优先用它）；没有它时仍显示审计用的 `reason` |
<!-- dsh-compat:layers:end -->

登记之外还有三条仍然有效的口径（来自核对时的取舍，不随上述条目到期）：

- **预设选择的可见性刻意 fail-open**：新旧两代判据合成在 `agentPresetsFromList` 的第二个参数上，
  但**开关值到达之前本扩展按 `true`、官方按 `false`**——否则连接初期那枚预设胶囊会闪一下。
- **权限目录的 Auto review 档刻意 fail-closed**：有没有那一档只认
  `permissionPresets/catalog` 的 `options`（`permissionCatalogHasAuto` 之外没有第二个判据）。
  那一档来自 `dsh-app-boot` 的 `OPTIONAL_BUNDLES`（随安装交付、**默认关着**，由用户在
  profile 的 `dsh.profile.bundles` 里打开），所以**同一版本不同部署的目录不一样**：实测
  开着的部署 `options` 里有 `auto`，一次性新 home 的默认 web profile 里没有（后者执行
  `/permission auto` 被服务端拒成 `unknown preset "auto"`）。老服务端没有这个端点（404）
  或插件没装时**不列那一档**——宁可少一个入口，也不列出一个点了会被拒绝的档位；连续失败
  里的「这次没拿到」（超时 / 断线 / 5xx）**不改结论**，只记日志。
- **行为面变化工具看不见**：`permission-presets` 的 `AUTO_PRESET_SPEC.approval` 由 `never` 改成
  `ask`（Auto 下评审拒绝会走用户审批）。本扩展本来就渲染 `approval/request`（拒绝那次询问照旧
  弹卡），权限目录这一侧没有要跟着改的判据。

---

## 六、工具

```
npm run dsh:watch                      # 列出基准之后尚未核对的官方版本（渠道 / 是否在 npm / 是否 latest）
npm run dsh:check -- <版本>            # 核对一个版本：抓快照 → 与基准求差 → 出发布去向 → 提示基准行怎么推进
npm run dsh:snapshot -- <版本>         # 只抓契约快照
npm run dsh:diff -- <旧版本> <新版本>   # 只求差
```

要点：

- 契约快照从官方 npm 产物离线抽取（每个 api 包都带 `lib/typert.host.js` 描述符与 `lib/**/*.d.ts`
  类型面），**不装 DSH、不起服务器、不花 token**。
- 快照落在 `docs/dsh-contract/<版本>.json`，**只留在本地**（`.gitignore` 排除了这个目录，提交
  `1ab1e29` 起不再进仓库也不进发布包）：这样核对下一个版本时不必重新下载旧版，本地也能复核
  「当时是怎么判的」。同一台机器上换会话接着核对时，先看这个目录里有没有目标版本的快照。
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
  宁可多报。**反向也成立**：在那份文档里顺手点名一个我们**并不消费**的类型名，等于把它登记进
  消费面——一条本来无关的 `type-removed` 会从 P2 变成 P0（记 `workspace/initializeDefault`
  的去参数化时就撞上过：写上那个被删的请求体类型名，报告立刻多一条假 P0）。写「未消费」的差异时
  用描述代替类型名。
- 类型面是**文本归一化后的差异**，不是语义差异：成员改名一定报，等价改写也会报（宁可多报）；
  只调成员顺序不报（接口的成员顺序不参与语义）。
- **注释不进类型文本**：官方顺手改 JSDoc 不会被报成形状变化。
- 抽取只覆盖 `scripts/dshCompat.ts` 里 `CONTRACT_PACKAGES` 列出的包；官方新增 api 包时要把包名补进
  那张表，否则那个包的变化不进报告。**包名会随官方重构搬家**（`dsh-agent-presets` →
  `dsh-agent-preset-registry` 就是实例）：新旧两个名字都留在清单里——旧名让旧版本的快照
  仍带着当时的端点与类型，新名让新版能被跟踪；只留新名会让旧快照凭空少一整个包，也会把
  端点漂移报成 `package-removed` 的假 P0。
- **继承来的成员看不见**（`SessionFollowRequest` 的 `maxMessages` 就是实例）：类型改成
  `extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>` 之后，成员不在本类型的文本里，
  工具会把它报成 `− readonly maxMessages?: number`。凡看到「接口成员消失」的 P0，先去官方源码里
  确认它是被删了、还是被搬进了 `extends` / `Pick` / 交叉类型；**误报要当场写明理由，别照着改代码**。
- **包改名会把包内的类型差异整段盖住**（`AgentPresetRow.trust` 就是漏网的那一条，后果是中文界面
  里预设名显示成英文，直到用户报现象才发现）：同一个域的两个包名一个消失、一个出现时，报告只给
  `package-removed` / `package-added` 两行，那个包**内部的逐字段差异一条都不会报**。所以看到这种
  成对的两行，必须把两边同名的类型**逐条对拍**。对拍命令：拿两个快照 JSON 的
  `packages[*].types[<类型名>]` 直接比字符串数组。
- **不在清单里的包 = 那块契约没有证据**：`approval/request` 与 `user-questions/request` 两个
  waterfall 的载荷类型分别住在 `@deepseek-ai/dsh-user-approval` / `@deepseek-ai/dsh-user-questions`
  里，两者都不在 `CONTRACT_PACKAGES` 中，所以它们的字段增删工具**一声不响**（`displayReason` 就是
  这么过去的，靠人工读官方源码才发现）。每次核对除了看报告，还要人工过一眼这两个 seam 的
  `lib/types/*.d.ts`；要彻底解决就把包名补进清单（代价是补的那一次会给已有快照报一条
  `package-added`，得重抓一次对比基准）。
- **「提交区间里有」不等于「发布产物里有」**：revert 过的提交仍留在历史里，`git log <旧>..<新>`
  会把它们列出来（timed 问卷就是实例：先合入、发布前被 revert）。判据要看 **tag 上的树**与契约
  快照，不要看提交列表。
- 工具不判断「该不该跟进 P1」，也不改代码——只给证据与分级。
