# 轨迹面板：契约与验证边界

轨迹是同一份 durable 事件的第二次客户端折叠，没有独立 RPC / 投影。session/follow 与 session/page → adapter.trajectoryEvents() → deriveTrajectoryModel → JSON trajectory 帧 → TrajectoryView。字段、时序和交互变更须同时核对 [宿主折叠](<../src/dsh/trajectory.ts>) 文件头；离线断言、真实样本对拍、DOM 操作与安装端验收是不同证据。

## 完美搬运的可行边界

官方基准固定为 dsh-v0.2.0-rc.2，commit `639ed015397290b3745d163aafe02ffee4aa3f84`，不是 checkout HEAD。声明与实际装配的 client.js 一起核对；未装配组件与零渲染 key 不代表可见能力。

整包依赖 ConversationNode、插件槽、主题与 primitives，直接搬入会引入另一套运行时。本项目只 vendor 纯决策：预览、稳定 recordId、时间线、搜索、inbox 状态机与 code-program；分组 / 事件折叠在宿主，适配层是唯一接缝。

[Vendor 索引](<../src/vendor/README.md>)登记来源与同步方法；来源锁双向核对 11 份原文字节见证、固定 tag / commit 与规范化摘要。仅允许模块说明符及注释 / 排版适配，不改普通字符串、模板、正则或 ASI；内部自洽不是外部认证，不手改 vendor。dsh:watch / dsh:check 只追服务端消费契约，不检测 UI 漂移；显式同步才更新锁。适配层仍须正确喂入字段，vendor 不能纠正错误形状。

## 记录与快照

账本为 turn → group → cell，压缩可位于 turn=null；kind 闭集 system / user / context / compacted / message / tool / subtool。

- index 从 1 起供选择 / 定位，不显示为编号；稳定身份依次 recordId、kind+call+callId、kind+seq+sourceSeq、kind+index。
- previewMarkdown 保原 markdown，全文存 input/output/thinking/schema detail。宿主仅发 attachments / emptySummary / resultSummary / promptChange / toolUpdate 等语义标记，文案在界面本地化。
- sourceBlocks 保 type/content 与 callId/toolName/attachment.name；reasoning 改名 thinking，tool-call 的 name/arguments 保留在 content 搜索面。
- 真用户消息 opensTurn；steering 外观 user 但不开轮，按领取落点入组。schemaDetail 捕获调用当时 Schema，不回查新目录；宿主对象身份复用字符串不代表 wire 去重。
- 工具错误只看 isError；错误码、原文、图片 / 无输出语义分开。缺 startedAt / timeSeconds 为 null，不折成 0；状态与时间是独立事实。请求事实在 requests，行只挂 requestNumber。

user/message.data 就是 UserMessage，不包 message；system/message 与 tool/result 才有包装。tool-call 内容块身份 id，不是事件参数 callId，兼容双读时 id 优先。throughSeq 只能取 follow 开帧 snapshot.cursor，beforeSeq 随窗口推进；官方 gateway 内部切点是否更新仍未知。

贡献按 anchorSeq、同级 key 排序；初始 system 排第一并按 firstVisibleTurn 归轮。turn 0 在建组前无条件改为 1，保“系统行第一、摊平序号对应显示”；与官方先拼组的角落顺序不同。组内递增、每条恰好一组，steering 落组后不要求全局 seq 单调。

## 请求与时序

### 请求表与配置

step/start 开助手请求并提供起点；compaction 独立占号，不因同一步 overflow 替换助手请求。累计用量最后按请求顺序累加，不按结算到达顺序。

显式 turn/step 无对应 start 时，结算 / attempt / retry 不借当前请求；无身份畸形帧才回退当前步。孤儿节点保自己的身份与首 token，不挂别人请求号。

effectiveHeader 是最近生效的整份配置，新 start 继承；本步 header 按 locationStep 整份替换，空 / 不可读配置也失效。消息结算不等于 step 关闭，晚 header 仍可属于该步；步骤间 / 收尾后 header 仅供未来继承。

header 与结算身份分开：message.source 逐字段优先；后到 header 不覆写已结算身份、用量、状态或时刻。没有 header 不从身份倒推选项。prompt / promptChange 接线与截断窗口不因配置回归通过而自动等价。

### 状态与重试

非中断助手结算 → complete；否则有 retry 或步骤 / 轮次边界 → error；都没有 → running。中断消息本身不是失败证据，行级中断标记另论。关闭边界补 completedAt，不覆写已有结算 / step 结束时刻。

turn/end.reason 仅 kind=error 提供失败证据，不从文案 / 码反推；只作用该轮最后助手请求，不污染压缩。多次 turn/end 逐条积累，非失败不撤销既有失败，最后边界推进；AUTH 清除此前 retry 文案，空失败文案也替换旧文案。

llm/retry 重置请求结算时刻、诊断与身份，保首 token / 用量；诊断整份替换（AUTH 保码清文案、无码清旧码），身份只用该请求最后有效 header 兜底。账本保每次历史结算，不随请求表回溯。旧 step/end 后再 retry 的不可达边界未补官方位置索引闭合分支，不声称等价。

session/end-seed 将边界前未结算压缩置 error，合成码 trajectory.compaction-interrupted；当前三源没有仍开压缩的边界样本，此规则仅契约回归。

### 首 token

attempt / message 都读合格 stream delta，先到者胜，不取任意首帧或最小时刻。raw 仅 token delta，packed 按 time0 + Σdt 找首个非空片段；空白文本合法，字符串工具名算 token（raw 空名也合法）。缺字段 / 非字符串跳过是本地加强，不是非法输入等价。

晚 attempt 回填同身份首 token 仍空的节点与请求；不跨步、不串身份、已结算步不补运行占位。代表回归 start=1000、非 token=1100、真 token=1700、settle=2000 → TTFT=700、解码=300，不代表所有截断窗口。

### steering 与系统行

仅 target=next-step 的 splice 入 vendor inbox 状态机，领取集合是 removed id，不是 inserted。步骤中领取入该步，否则入后续助手步骤；按 durable seq 关联，不按前插后会改号的 index。step/end 清 locationStep，turn/end 全清。

初始系统行按当前有效助手 / partial 的最小正轮号归位，无候选为 1；更新行取随后第一个 step>0 的当前助手节点，否则 partial 或 1。retry 撤销有 start 身份的旧 final / partial，孤儿 fallback 不重放 retry。闭合有块证据贡献 boundary.seq - 0.9 中断节点：文本 / 思考须非空白，空工具块也算；块替换撤销旧证据，重复 start 不重建流状态。

## 界面与交互

- 整页轨迹仍保留输入区；默认展开无选择，贴底阈值 2px。运行中视图每 3 秒取数，停止取收尾，切会话重取，关闭不取。JSON 字符串帧保有意义 null。
- 加载更早共用 loadMore，生成中重折须抄送 CarriedLiveOverlay 保正文 / 工具 / 首 token。只有按钮，无自动上滚加载；每次折全量已加载事件，不截最近 N 条。
- trajectoryDisplay.ts 统一判据：正文优先思考；仅工具调用须无正文 / 思考且有调用，空结算为破折号。vendor 预览读取 2048，转纯文本折空白，截 512 + 省略号。
- 搜索 AND，requestOnly 不入索引，身份 recordId；先搜索后折叠，清查询恢复折叠集合。未命中时间线压暗为 14%，索引节流 3000ms，引用不变跳过。
- 折叠轮保 system / requestOnly / 第一内容行，摘要只代表其后内容；摘要无 index、不顶轮标签、不进时间线。步骤摘要只数请求步骤 / 压缩组；调用折叠按 recordId。
- 轮标签跳过 system / requestOnly / 轮内压缩，绝对定位不占高；首行界线 2px，表首 / 分页后不画。列宽 EN=122、ZH=96，420px 以下 50；编号不显示，标签与种类一起紧凑。摘要支持 Enter / Space。
- 虚拟化 records>100 或有更早历史，overscan=12，估高 30；按真实布局位置排序，pinned 与窗口分段 padding。record index 不等于含摘要布局位置，DOM 行数不是总数。
- trajectoryInteraction 单端口管理 record/request 互斥选择、reveal nonce、pending focus、viewport 与 document 拖动。callId 精确匹配；未中保留、命中 ack、切会话 / 离开清理。refresh 不重播旧票，新票可再定位同目标。
- overflow-anchor:none 交滚动所有权给应用；验收实际几何，不放宽守卫 / 加轮询掩盖原生锚定。

### 时间线

vendor 提供 sequence / duration / time / actual：duration 去空闲、保并发重叠，actual 保空闲，非有限起点不入线。开关只 sequence / duration，坐标存归一化域，绘制 / 命中互逆，不混域与像素。

左拖选区、右拖平移（轻点清选区），contextmenu 始终拦，位移<3px 为点击。滚轮锚光标 exp(deltaY*0.0015)，最小窗 sequence=4 条、其他=20ms；边缘 8%（最多 32px）平移。document 监听允许区外抬起并须清理。空白点最近记录并最小选区，条点击选中定位；Escape 清选择、双击先清选择否则复位。

仅选中跟随过渡 180ms，手势不动画，视口外选择保留。hover 问 DOM，不自算矩形、不画竖线；助手渐变须齐 TTFT / 解码证据。偏好 dsh.trajectory.duration，空态仍三泳道与历史入口。

### 检查器与文案

记录 / 请求双向跳转；工具→助手按 callIds，认不到不链接。请求计时有助手记录复用，否则读请求起点 / 时长 / 来源，不跨请求兜底；计时标题直达页签，边界回概述。请求选项不入搜索。

system diff 用 structuredPatch(context=3)，system / tools 分开比前后同类快照，相同或缺一份不显示。Schema 用调用时版本。窗口没带进「调用之前那一帧 request/header」时（跟随分页按消息对齐切，而表头不属于任何消息），宿主按需往前补页、只取其中的表头交给折叠：判据是「这条工具行之前有没有表头」，有表头即视为真缺席（那一帧目录里本来就没有这个工具名）不再往回翻；账本一行都不变（回补不进账本，否则往用户正看着的视图上方插行），聊天流的消息、分页锚点与 hasMore 同样不动。「结果在窗口里、调用在窗口外」的结果行没有工具名，仍不可用（官方同口径）。PTC code-program 行显描述、参数叫代码、有程序即使空输出也给结果页签；TypeScript / Python 只按 Schema，不猜源码。PTC 真实零样本，不把契约回归当安装验证。

SourceBlocks 显原文与精确调用链接，纯工具目录变更用名字清单，无块退文本。统一 TrajectoryPre，默认 pre，可拨 pre-wrap + break-all；动作条在正文上方独立行，dsh.trajectory.jsonStringWrapping 仅拨动落盘、各段独立。

trajectoryTexts.ts 唯一登记 zh / en，参数函数；缺时长为不可用，<1 秒整数毫秒、<10 秒两位小数、其余一位。绝对时刻切本地日期 / Unix 秒（3 位），时长不切。服务端错误原样、语义标记本地化，AUTH 经 displayFailure 清文案。

## 验收与差异管理

契约 / 时序 / 连续交互缺陷必须正确预期回归与实际 DOM 验收，不能按频率豁免；新增形态才衡量收益。未确认先取证，不按静态猜测改行为。统计写明形状、源数与分母：JSON 候选 / 成功 / 失败及应比 / 已比 / 缺失 / 错配分列；零样本不算通过。历史比例不代表现代信封口径的当前收益；读取日志或 token 探针均须当次批准。

### 输入准入与夹具资格

[日志库](<../scripts/sessionLog.ts>)保留旧宽松入口；[提取入口](<../scripts/trajectoryFixtureBuild.ts>)必须显式走严格入口：完整 zstd 帧及尾部消费、原生解压 / 校验和、拼接后 fatal UTF-8、逐行 JSON 对象。合法 U+FFFD 与跨帧字符合法，完整末行无需换行。摘要与派生消费同一份字节快照，避免二次读取制造 TOCTOU；秘密扫描先于临时写盘，写后完整读回再 rename，用法 / 完整性 / 秘密失败分别退出 2 / 3 / 4。

[离线校验](<../scripts/trajectoryFixtureVerify.ts>)只验证登记、脱敏与结构自洽，不认证历史源身份。完整性、来源授权与来源认证分开，不能用 hash 替代后两者。Node 24.19 及更早可能将「魔数 + 垃圾」解成 0 字节空帧，24.20 起抛 `Z_BUF_ERROR`；日志库自己拒非法帧头，断言钉非法输入 → `undefined` 与不得解出内容，不钉引擎宽容度。

[三份完整脱敏夹具](<../test/fixtures/trajectory/README.md>)以 `--limit 0` 生成：`payloadReduced=false`、`payloadMeasurementEligible=true`、`provenance.truncatedFields={}`；派生 SHA-256 固定为 `922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb`。自由文本保 UTF-16 长度，不保 UTF-8 等长，脱敏字节不能冒充原 wire。

| 夹具 | durable 事件 | 轮 / 组 / 记录 / 请求 |
|---|---:|---|
| [real-small](<../test/fixtures/trajectory/real-small.json>) | 63 | 3 / 9 / 21 / 6 |
| [real-long](<../test/fixtures/trajectory/real-long.json>) | 5141 | 20 / 985 / 2047 / 926 |
| [real-compaction](<../test/fixtures/trajectory/real-compaction.json>) | 732 | 4 / 107 / 297 / 84 |

事件分母为 `sourceEventCounts` 合计减一条 `session` 元数据，不与 JSONL 总行数混用。完整 long 已验证 2047 条逻辑记录全部输入、不裁不改正文；这不是安装端传输证明。正式测试只读既有受控夹具，不自动消费用户日志；新源另行授权。

### 统计口径与证据上限

- [统计模块](<../scripts/trajectoryProbeFacts.ts>)逐源复算，不拼三个从头编号的 seq 窗口。冻结候选键（规则 / 来源 / 事件身份或 occurrence / 字段）再具名判定；未知键、重复判定、残留 pending 失败。各 rule×source 含零样本，`candidate = compared + notCompared`，`mismatched` 是 `compared` 子集；源预言机、模型自洽、API 传参分列。
- 2026-10-09 的有限字段审计为 33 条规则，33435 = 32694 + 741，历史口径仍有 13 条错配；缺源 `header.system`（5）与 `compaction/start.turn`（2）未比较。它不是标准 CLI 已有的全字段断言，不能称全字段等价。
- 工具历史 1178 帧 = 1164 个同 callId 最终结果 + 14 次重复（long 999 = 985 + 14）。固定官方 trajectory 接受 replace，以 `calls.set(rootId, result)` 保末条；chat append-only 规则不能外推。历史对最终模型的 13 错配（11 append、2 trim 空正文）保留，最终态 1164 条另列为零错配，不删除历史分母。
- 三源现代 / 旧信封为 176 / 1002；JSON 候选 64 = 成功 9 + 失败 55。[对拍入口](<../scripts/trajectoryAlignProbe.ts>)应比 9 / 949 / 83，列明消息 / 用户判据无 missing / mismatch，不覆盖所有字段。PTC / subtool 零样本不证明全库不存在；long 有 20 条 steering，压缩源有 2 条压缩记录 / 请求与 1 次工具目录更新。

### 生产 seam 与计量规约

- [账本投影](<../src/webview/trajectoryLedgerRows.ts>)统一 flatten、先搜索后折叠与 section 起点；非空查询覆盖折叠而不改集合。调用摘要是布局行，`cellIndex=-1`，不写 `data-cell-index`、不顶轮标签。
- [交互端口](<../src/webview/trajectoryInteraction.ts>)由账本与[时间线](<../src/webview/components/TrajectoryTimeline.tsx>)共用；定位命中 ack、未命中等待、refresh 不重播、离开 / 切会话清理，新票可重复同目标。[虚拟规划](<../src/webview/trajectoryVirtual.ts>)按布局位置处理窗口与 pinned，摘要也是布局行，padding 与 DOM 窗口数不冒充逻辑总数。
- 既有完整 long 的受控 DOM 覆盖选择 / 搜索 / 折叠 / Inspect、原生 wheel / 右键 / 区外抬起、首次定位及清理。`overflow-anchor:none` 修正原生锚定改写位置的问题，未放宽 0.5px 守卫或加轮询；须继续验真实几何。计划追上与有界收尾由同一交互端口负责，不能以理想化重排模拟或源级 CSS 断言代替真实可视几何。受控 loadMore 只证入口与身份，不证自然分页；离线 JSON clone / React DOM 不证 VS Code IPC 或安装端。
- [核心量测](<../scripts/trajectoryPayloadBench.ts>)、[CLI](<../scripts/trajectoryPayloadBenchCli.ts>)与[浏览器 runner](<../scripts/trajectoryPayloadBenchBrowser.ts>)共用资格门：登记完整、严格 `payloadReduced === false`、资格为真、无截断、derive hash 贯穿 Node / emit。默认 warmup=2、samples=11，报告原值及 min / median / nearest-rank p95 / max；n=11 的 p95=max。缺依赖、零工件、写盘失败、端口未监听必须失败，不能 skip。
- Node 分别量 fixture 准入、wire、vendor / ledger / timeline / search / allocation / virtual；`fold.rebuild` 为合成事件下界，不是原日志解码 / 派生。真源前段须授权单次字节快照，单读 IO 不报 11 次分布；互斥分支与不同载荷的阶段不能相加伪造 IPC 关键路径，cold / warm 不冒充 11 次生产刷新；完整性 / 秘密准入成本不冒充每次 UI 刷新的必要成本。
- 浏览器用生产 CSS / 消费 seam，同步刷新与异步索引分开；保真实 `schedule → fire → index.update`、同 timer / nonce 配对与 landed，取消 / 合并单列。首载完整 timer 是执行判据，刷新尾部只作观察；timer 负例必须被正式判据拒绝。缺原始 schedule 失败，不用 modelSetAt 代替起点；requestedDelay=3000ms，最低观测 2500ms，不因修脚手架放宽生产判据。
- 每个滚动 sweep 单调，跨 sweep 复位合法；long / compaction 须真滚动、真 padding、未全量 DOM。small 21 行非虚拟记 not-applicable。保原始滚动帧，idle rAF 不证滚动流畅；同时等 `window.__M06_DONE__ === true` 与 `window.__M06__.done === true` 再读 status / checks。passed 仅证计量协议完成，不等于速度达标。

### 性能定位与重评条件

保留决定优化顺序的历史基线，不保留每轮采样全表。2026-10-09 前景受控重复：Windows x64、Node v24.19.0、Chrome 154.0.0.0、1249×1277 CSS 像素、DPR=1；产品 / 夹具冻结，独占采样窗口，无模型调用。预热 2 次、11 次刷新；132 个滚动帧的 median 取较低中央秩，p95 用 nearest-rank。

| 夹具 | 刷新墙钟 中位 / p95（ms） | 滚动帧间隔 中位 / p95（ms） | view.allRows 窗口累计 CPU 中位（ms） |
|---|---:|---:|---:|
| real-long | 573.2 / 620.3 | 570.7 / 591.1 | 566.5 |
| real-compaction | 98.5 / 113.4 | 102.3 / 110.5 | 96.5 |

两者逻辑行 2047 / 297，DOM 40–53 行、padding=2，说明 DOM 窗口化不等于未构造窗口外行。空闲 rAF 中位 / p95 / max 为 5.9 / 7.2 / 14.4ms，不能解释上述慢帧；早期约 1 秒空闲调度只保历史，不归因产品，具体节流机制未唯一定位。

优化先查[组件](<../src/webview/components/Trajectory.tsx>)虚拟窗口前 `allRows = ledgerRows.map(...)` 的全量 JSX：先规划窗口，再构造可见 / pinned 行。窗口累计 CPU 可含多次调用，不能当单次耗时；long 11 个刷新窗有 12 次调用。第二优先级是完整搜索索引（long 单次 CPU 373.9ms），3 秒节流不消除执行阻塞。候选未实施、收益未证，见[待评估](<../ToDo.md>)。

优化不得截掉来源、恢复最近 N 条窗口或新增 outputBlocks；须保完整搜索、摘要、pin 顺序、首次定位和互斥选择，再以同消费 seam 红→修→独验。历史量测不代表当前流畅、全字段等价或安装真机通过。

### 离线复现入口

先按[AGENTS](<../AGENTS.md>)执行标准三项。以下只读既有夹具，不扩大来源授权；浏览器用 CLI 宣告的 URL，独占性能窗口采样：

```bash
node build/trajectory-fixture-verify.mjs --fixture test/fixtures/trajectory/real-long.json
node build/trajectory-payload-bench.mjs --fixture test/fixtures/trajectory/real-small.json --fixture test/fixtures/trajectory/real-long.json --fixture test/fixtures/trajectory/real-compaction.json --expect-derive-sha256 922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb --samples 11 --warmup 2 --out bench-node.json
node build/trajectory-payload-bench.mjs --fixture test/fixtures/trajectory/real-small.json --fixture test/fixtures/trajectory/real-long.json --fixture test/fixtures/trajectory/real-compaction.json --expect-derive-sha256 922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb --emit-browser bench-browser
node build/trajectory-payload-bench.mjs --serve-browser bench-browser --port 8780
```

面板预览使用 `test/preview.html?locale=en&trajectory=long`（中文 `locale=zh`），点「Trajectory／轨迹」；这是项目预览，不是 Harness GUI 或安装验收。完整阶段矩阵、过程与原报告追 Git 历史，临时新报告放 `.agent/`。

## 有意差异与未采纳形态

这些是产品边界，不是全部字段等价证明；历史全库比例不再作为当前收益依据。

| 决策 | 理由 / 重评条件 |
|---|---|
| 流式助手只出生成占位 | 扩展 live overlay 与官方 PartialAssistant 不同，直映会重复行；重做 overlay 或上游语义变更时重评 |
| system/message 更新随 request/header 合并 | 不单列每次提示词改写；用户需要完整修改流水时重评 |
| turn 0 建组前改为 1 | 保系统行第一、显示顺序对应序号，与官方拼组顺序有角落差异 |
| 更早历史只用按钮 | 与聊天页一致，不自动上滚加载；用户需求变化时重评 |
| 无轮 / 组表头四列 | 上游对应组件未实际装配，添加会偏离可见 UI |
| 多复位按钮、双击先清选区 | 时间线的有意超集 / 微差 |
| 记录检查器显错误 | 官方仅请求检查器显示，本项目自定口径 |
| promptDetail 不复制 config | 已在 provider/model 与选项面板，搜索面无增量 |
| 无 AssistantToolCalls 预览入口 | 行右侧与工具行已有落点，原始内容提供跳转 |
| 不搬 JsonTree / PTC 原始 JSON 开关 | 历史成本 850 行树 + 345 行 CSS + 564 行 Menu + 8 个不存在的主题令牌；当时收益有限，不是当前候选比例结论 |
| 无 PTC 行号 / 高亮 | 真实受控三源 PTC 零样本，收益未确认；出现真实需求再评 |
| 不采 outputBlocks | 与 outputDetail / resultPreviewMarkdown 重复；历史约 35k 块 / 7400 万字符，结果图片等对应形态未做 |
| 无 RecordAttachments 组件 | SourceBlocks 保原始附件兜底；旧零样本不证明永远无需求 |
| 不做最近 50 节点窗口 | 会损失历史与搜索语义；当前性能问题优先优化可见 / pinned JSX，再搜索，不截来源 |

## 尚未确认

- 未知 lane 默认落 0 后，背景色与实际渲染层的角落行为；零渲染 dead key 是否未来有收益。
- subtool 的真实显示 / 跳转及 PTC 真实渲染，当前三源均无样本。
- 官方 gateway 的 throughSeq cut-point 内部推进规则。
- 不可达 step/end → retry、所有无 start 结算以及全部截断窗口的官方等价性。
- 完整工具组装链路、自然分页、真实用户拖动、VS Code 安装端 IPC：当前受控证据不覆盖这些范围。
