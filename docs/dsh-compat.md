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
| 0.1.6-alpha.1 | alpha | 需兼容更新（P0 2：权限投影拆成两项、模型消息来源类型消失） | 待定 | 2026-09-23 | 未决 |
<!-- dsh-compat:ledger:end -->

**0.1.6-alpha.1 的两个 P0 是什么**（这是第一个跑完的实际核对，留作范例）：

- `PermissionSelect` 消失：0.1.5-rc.3 是 `{ options; currentValue }` 一个类型，0.1.6-alpha.1 拆成
  `PermissionCatalog = { options }` 与 `PermissionSelection = { currentValue }`，并新增
  `permissionPresets/catalog` 端点与 `permission-presets/catalog-changed` 事件。**权限投影被拆成两个**，
  扩展那侧按 `{options, currentValue}` 读投影，需要在真实服务端上确认新形状。
- `AssistantProvenance` 消失：`ModelMessageSource` 的来源形状变了（模型消息的来源字段）。
- ⚠ 这一条**只证明契约面变了**，还没证明扩展真的坏——两者都要在真实 `dsh web` 上实测才能定。
  P0 是「要去看」的信号，不是「结论」。

---

## 五、兼容层登记

<!-- dsh-compat:layers:start -->
| 兼容项 | 兼容的 DSH 区间 | 落点 | 起算日 | 移除期限 | 为什么留着 |
| --- | --- | --- | --- | --- | --- |
| `session/control` 的旧队列通道（`queues` / `queue` 帧） | 2026-09-09 之前的服务端 | `src/dsh/queueView.ts`、`src/dsh/controller.ts` 的 `onControlFrame` | 2026-09-23 | 2027-03-23 | 官方提交 `72f2e71070` 删掉旧通道改由 `inbox` 投影承载；两条同源同值，双读是为兼容没升级的旧服务端 |
| `commands/execute` 第三参数改名（`images` → `submittedAttachments`） | 0.1.5 前后两代 | `src/dsh/controller.ts` 的 `runCommand`（`attachmentsParam`） | 2026-09-23 | 2027-03-23 | 网关对参数名严格校验（多一个少一个都拒），改名即整条调用失败；协议无版本协商，只能试错回退 |
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
  那张表，否则那个包的变化不进报告。
- 工具不判断「该不该跟进 P1」，也不改代码——只给证据与分级。
