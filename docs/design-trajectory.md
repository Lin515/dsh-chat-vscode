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

system diff 用 structuredPatch(context=3)，system / tools 分开比前后同类快照，相同或缺一份不显示。Schema 用调用时版本。PTC code-program 行显描述、参数叫代码、有程序即使空输出也给结果页签；TypeScript / Python 只按 Schema，不猜源码。PTC 真实零样本，不把契约回归当安装验证。

SourceBlocks 显原文与精确调用链接，纯工具目录变更用名字清单，无块退文本。统一 TrajectoryPre，默认 pre，可拨 pre-wrap + break-all；动作条在正文上方独立行，dsh.trajectory.jsonStringWrapping 仅拨动落盘、各段独立。

trajectoryTexts.ts 唯一登记 zh / en，参数函数；缺时长为不可用，<1 秒整数毫秒、<10 秒两位小数、其余一位。绝对时刻切本地日期 / Unix 秒（3 位），时长不切。服务端错误原样、语义标记本地化，AUTH 经 displayFailure 清文案。

## 验收与差异管理

契约 / 时序 / 连续交互缺陷必须正确预期回归与实际 DOM 验收，不能按频率豁免；新增形态才衡量收益。未确认先取证，不按静态猜测改行为。统计写明形状、源数与分母：JSON 候选 / 成功 / 失败及应比 / 已比 / 缺失 / 错配分列；零样本不算通过。历史比例不代表现代信封口径的当前收益；读取日志或 token 探针均须当次批准。

#### 当前可复现验收边界（2026-10-09）

**输入准入先于派生与计量。** [日志库](<../scripts/sessionLog.ts>)保留旧宽松入口兼容历史消费者；
[夹具提取入口](<../scripts/trajectoryFixtureBuild.ts>)必须显式走严格入口：完整 zstd 帧与尾部消费、
原生解压／校验和、各帧字节拼接后的 fatal UTF-8、逐行 JSON 对象验证。合法 U+FFFD 不等于坏 UTF-8，
可以跨帧；完整末行无需换行。源摘要和派生消费同一份字节快照，不二次读取源制造 TOCTOU。
秘密扫描在临时写盘前执行，写后完整读回再 rename；用法／完整性／秘密失败分别退出 2／3／4。
[离线校验](<../scripts/trajectoryFixtureVerify.ts>)只验证既有登记、脱敏与结构自洽，不认证历史源身份。
内部完整性、来源授权、来源认证是三件事，不能用自洽 hash 替代后两者。

原生引擎的宽容度是运行期 Node 的版本行为，不是契约：Node 24.19 及更早把「魔数 + 垃圾」当完整空帧
接受（`zstdDecompressSync` 不抛错、buffer 为 0 字节），24.20 起改抛 `Z_BUF_ERROR`。因此帧头合法性与
「垃圾不得被读成空内容」由日志库自己判，断言只钉产物契约（非法帧头 → `undefined`）与「引擎不得解出
内容」，不钉这一次引擎偏宽还是偏严。

当前三份[真实脱敏夹具](<../test/fixtures/trajectory/README.md>)均以无上限 `--limit 0` 生成：
`payloadReduced=false`、`payloadMeasurementEligible=true`、`provenance.truncatedFields={}`，派生源码固定 SHA-256 为
`922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb`。
自由文本保 UTF-16 长度，不保 UTF-8 字节等长；脱敏模型字节不得冒充原始 wire 字节。

| 夹具 | durable 事件（不含 metadata 行） | 轮／组／记录／请求 | 脱敏模型 JSON 字节 | 夹具文件字节 |
|---|---:|---|---:|---:|
| [real-small](<../test/fixtures/trajectory/real-small.json>) | 63 | 3／9／21／6 | 206721 | 280131 |
| [real-long](<../test/fixtures/trajectory/real-long.json>) | 5141 | 20／985／2047／926 | 13485165 | 15166299 |
| [real-compaction](<../test/fixtures/trajectory/real-compaction.json>) | 732 | 4／107／297／84 | 3714411 | 4069664 |

这里 durable 数为登记 `sourceEventCounts` 合计减去一条 `session` 元数据行：合计分别为 64／5142／733；不要把带元数据的 JSONL 行数与 durable 分母混用。

**统计分母与最终态分开。** 用[共用统计模块](<../scripts/trajectoryProbeFacts.ts>)逐源复算，
不是把三个从头编号的 seq 窗口拼起来再派生。工具结果共 1178 帧：现代信封 176、旧信封 1002、
无内容字段 0；JSON 候选 64、解析成功 9、失败 55。逐源结果帧为 3／999／176，JSON 候选为
3／54／7，成功为 3／1／5。三源探针与当前完整模型的工具名／内容块名字枚举未观察到 PTC；
这不是登记 `capabilities` 已包含 PTC 计数。subtool 登记及模型枚举均为零，long 有 20 条 steering；
v4 样本有 2 条压缩记录、2 个压缩请求、1 条工具目录更新。零样本不证明全库不存在。
当前[对拍入口](<../scripts/trajectoryAlignProbe.ts>)逐源应比 9／949／83（合计 1041，助手 1010），
列明消息／用户判据没有 missing 或 mismatch；这不是全部字段等价。

本轮字段审计采用**先完整枚举候选、冻结键集合、再具名判定**：键包含规则／来源／事件身份或 occurrence／字段；
未知键、重复判定、残留 pending 都失败。每个 rule×source 包括零样本行，满足
`candidate = compared + notCompared`，`mismatched` 是 `compared` 的子集；源预言机、模型自洽与 API
传参分别标记。此次 33 条规则为 33435 = 32694 + 741，仍保留历史事件口径的 13 条错配，
不能写成「全字段 0 错配」。缺源字段的 `header.system`（5）和 `compaction/start.turn`（2）全未比较，
三源没有边界前仍开着的压缩实例。该字段矩阵是有限一次性审计，不是标准 CLI 已有的全部字段断言。

其中工具结果必须区分**历史事件**与**同 callId 最终态**：固定官方 trajectory 目标自身接受 replace，
更新 `calls.set(rootId, result)`；固定布局对同 callId 取末条。chat 目标的 append-only 过滤不能外推到
trajectory。long 的 999 帧 = 985 个最终结果 + 14 次重复；三源 1178 = 1164 + 14。
历史起点对最终模型的 13 条错配（11 条 append 正文、2 条 trim 空正文）不删除；另列最终态 1164 条、
错配 0。定义／更新与固定布局已实际对照，不声称官方 event-registry 全文装配或官方浏览器端到端通过。

**真实消费者跨同一 seam。** [账本投影模块](<../src/webview/trajectoryLedgerRows.ts>)拥有
flatten／search-first filter／两种 collapse／每 section 起点；非空查询临时覆盖折叠而不改折叠集合，
清查询恢复。调用摘要是布局行，`cellIndex=-1`、不写 `data-cell-index`、不顶轮次标签。
[交互端口](<../src/webview/trajectoryInteraction.ts>)由账本与[时间线组件](<../src/webview/components/TrajectoryTimeline.tsx>)
共同消费，拥有互斥 record/request、reveal nonce、pending focus、最新 viewport 与 document 拖动监听；
不是两个组件各自复制状态机。focus 命中必须 ack，refresh 不重播，未命中保留到目标抵达，离开／切会话清理。
新 reveal 可以重复同一目标，已消费旧票不能因手滚或普通 render 再滚动。
[虚拟规划](<../src/webview/trajectoryVirtual.ts>)按布局行位置分段垫高，插入 pinned 行后也不乱序；
摘要与记录同属布局行单位，padding 不计真实行，不能拿 DOM 窗口数当逻辑总数。

完整 long 的连续 DOM 已验证完整 2047 条输入不裁、不改正文：选择／搜索／折叠／20 段起点、
真实 chat 的 Inspect 入口与 ack、原生 wheel／右键／区外抬起／最新 viewport／切会话清理。
受控历史投影保原 index／seq／callId，用生产 loadMore 按钮恢复完整模型，只证明分页入口与身份保留，
不冒充源自然分页或完整载荷量测。英文与中文 420px 均隐藏 index、种类不越事件格；
请求 Summary 的计数／retry／结果均可读，长错误保完整 title。首次 reveal 的几何另以完整 long
从尾部 2046 跳到工具 5 验证：原生滚动锚定会在窗口重排时把写下的 116px 改成 117px，
超过 0.5px 位置守卫而弃票，26px 行只见 13.5px。账本容器用 `overflow-anchor: none`
把位置所有权交还应用与用户；未放宽守卫、不加轮询。当前生产原触发首次见 25.5／26px（1px 边框容差），
重复同目标仍可见，手滚 2000px 保持 2000px；随后同页九组连续 DOM 通过。
计划追上与有界收尾仍由同一交互端口负责，不能拿理想化重排模拟或源级 CSS 断言代替真实可视几何。

**完整链计量协议，而非单个 folding 微基准。** [核心量测](<../scripts/trajectoryPayloadBench.ts>)
与[薄 CLI](<../scripts/trajectoryPayloadBenchCli.ts>)、[浏览器装配／runner](<../scripts/trajectoryPayloadBenchBrowser.ts>)
共用资格门：登记完整、严格 `payloadReduced === false`、完整资格为真、无任何截断，指定 derive hash
贯穿 Node 与 emit。默认 warmup=2、samples=11；报告原值及 min／median／nearest-rank p95／max，
`n=11` 时 p95 就是最大观测。缺依赖、零工件、失败写盘、端口未监听都必须失败，不 skip 成通过。

- Node 覆盖 fixture read／parse／validate、wire stringify／hash／parse、vendor、ledger、timeline、search、
  allocation／virtual。`fold.rebuild` 是由模型合成事件后的**下界**，不是原始日志解码／派生。
  真源前段须另以一次授权字节快照量 decode／对象 JSONL／DTO／derive／stringify，IO 单读不报 11 次分布。
- 浏览器使用生产 CSS 原字节与主题桥、实际生产消费点的打点见证。首载与 11 次刷新同步阶段和异步索引
  分开：保原始 `schedule → fire → index.update`，同 timer／nonce 配对与 landed，取消／合并单列。
   索引执行判据选首载真实模型那一次完整 timer；刷新尾部 `afterRefreshExecuted`／`updatesDuringRefresh`
   只是观察，允许合并，不能单凭尾部等待结果声称执行失败或已落地。timer 绑定负例仍须通过正式判据拒绝，不能只输出诊断标志。
  从真实 schedule 到 fire 的延迟判节流，不用首载之后取得的 `modelSetAt` 冒充 timer 起点；
  原始 schedule 必须包含首载 commit 中的调度，缺 schedule 仍失败。requestedDelay=3000ms，
  最低观测延迟 2500ms；不为修计量脚手架而放宽生产判据。
- 滚动按每个 sweep 判单调，跨 sweep 回起点正常；从组件取逻辑 ledger/allRows 数与 DOM 渲染行用同单位。
  small 的 21 行非虚拟分支标 not-applicable，不当虚拟性能证据；长／压缩样本必须真滚动、真 padding、
  未全量 DOM 渲染。保存滚动帧原值，idle rAF 不能冒充滚动流畅。
- 同时等 `window.__M06_DONE__ === true` 与 `window.__M06__.done === true` 后才读最终 status／checks。
  量测 passed 只说明协议完成，不等于速度达标；历史真实滚动曾观测 long 多数帧 590–675ms、
  compaction 116–132ms，应保留为慢帧信号，不拿折叠微基准覆盖。产品冻结后须专用 CPU 窗口重新量测。
- JSON wire clone／React DOM 是离线桥，不是已安装 VS Code IPC；本轮没有启动模型或耗模型 token 的验证。

##### 本轮最终完整载荷量测与决策

2026-10-09 的最终前景重复使用 Windows x64、Node `v24.19.0`、Chrome `154.0.0.0`、
1249×1277 CSS 像素、DPR=1；产品与夹具冻结，未与构建、Node 量测或其他浏览器采样并行。
三夹具均等到双 DONE，21 项量测协议检查通过；这不是交互流畅的认证。
浏览器重复预热 2 次、采样 11 次；以下时间单位均为 ms，`中位／p95` 的 p95 在 n=11 时等于 max。
滚动帧有 132 个原始观测，median 取较低中央秩（不是偶数样本中央两值平均）。

| 夹具 | 首载墙钟（单次） | 刷新墙钟 中位／p95 | 滚动帧间隔 中位／p95 | 12 步 sweep 中位／p95 | 索引真实 timer 延迟／CPU（单次） |
|---|---:|---:|---:|---:|---:|
| [real-small](<../test/fixtures/trajectory/real-small.json>) | 40.2 | 9.7／10.9 | 5.9／7.7（非虚拟，N/A） | 70.5／87.8（无滚动） | 3001.3／5.8 |
| [real-long](<../test/fixtures/trajectory/real-long.json>) | 1185.6 | 573.2／620.3 | 570.7／591.1 | 6300.1／6406.6 | 3007.5／373.9 |
| [real-compaction](<../test/fixtures/trajectory/real-compaction.json>) | 210.8 | 98.5／113.4 | 102.3／110.5 | 1142.7／1185.0 | 3000.8／78.9 |

long／compaction 的逻辑行分别为 2047／297，实际 DOM 行 40–53、padding=2，最大 scrollTop
58439／7694；两者各有 156 次非零 applied scroll，预热与采样每个 sweep 都单调。
small 为 21 行、没有 padding 或实际滚动，不把它计为虚拟化性能证据。
60 个空闲 rAF 的中位／p95／max 是 5.9／7.2／14.4ms，远低于 long 的滚动帧间隔，
因此本轮慢刷新／滚动信号不能再被约 1 秒的空闲调度基线解释。
第一次同字节重复的空闲中位为 1005.6ms，与滚动同阶；仅 `bringToFront()` 后空闲恢复，
故第一次只保留为受调度影响的历史，不据其约 1 秒帧间隔判定产品开销，也不删除原报告。
尚未唯一定位具体浏览器／操作系统节流机制。

不同载荷与阶段必须分表，不能相加构造一个不存在的 VS Code IPC 关键路径：

| 夹具 | 未脱敏源模型 JSON 字节 | 真源 decode／parse／derive／stringify 中位 | 真源顺序总量 中位／p95 | 脱敏 wire stringify 中位／p95 | 脱敏 wire parse 中位／p95 |
|---|---:|---:|---:|---:|---:|
| [real-small](<../test/fixtures/trajectory/real-small.json>) | 177200 | 0.99／0.37／0.16／0.45 | 2.02／2.49 | 0.55／0.61 | 0.35／0.37 |
| [real-long](<../test/fixtures/trajectory/real-long.json>) | 11079437 | 89.58／33.11／12.33／29.44 | 165.30／180.25 | 29.26／31.25 | 16.23／17.39 |
| [real-compaction](<../test/fixtures/trajectory/real-compaction.json>) | 3240047 | 13.03／6.18／1.38／7.14 | 27.89／35.86 | 7.78／8.20 | 4.67／5.79 |

真源前段仅三授权停止日志，一次字节快照 IO（0.13／1.25／0.73ms），总量还包含事件 DTO 映射；
逐阶段中位不要求相加等于总量中位。脱敏 wire 是此前登记的 206721／13485165／3714411 字节，
不是本表的未脱敏源模型字节。Node 独立阶段覆盖 fixture 准入、vendor／ledger／timeline、完整 search、
allocation 与 virtual plan；互斥折叠／搜索分支不能相加，orderedPass 只有 cold／warm 两个顺序观测，
不冒充 11 个完整生产刷新样本。完整性／秘密准入成本也不冒充每次 UI 刷新的必要成本。

**先测后的决策**：下一次性能优化应优先检查[组件](<../src/webview/components/Trajectory.tsx>)中
虚拟裁窗口之前的 `allRows = ledgerRows.map(...)` 全量 JSX／行展示构造，而不是先截掉模型历史或扩大 folding。
本轮刷新窗口 `view.allRows` 总 CPU 中位 small／long／compaction 为 9.0／566.5／96.5ms；
long 11 个刷新窗口共 12 次调用，单调用中位／p95 为 563.5／611.3ms，个别窗口含两次调用，
其 1115ms 合计不能与单次刷新墙钟相除。首载窗口同样可含多次调用，不能将累计 CPU 当一次首载耗时。
DOM 已虚拟化并不意味着窗口外行尚未构造；这为“先规划窗口、再构造可见／pinned 行”提供明确优化候选。
第二优先级是完整搜索索引的重建 CPU（long 单次 373.9ms）；3 秒节流本身不能消除执行时阻塞。
以上是定位范围与优先级，不是已实施或已证实收益的优化。优化时必须保留查询覆盖折叠、摘要、pin 顺序、
首次定位、互斥选择及完整来源语义，并重新以同消费 seam 的红→修→独验量测；本轮不追加性能重构，
不恢复最近 N 条截断，不新增既定不采用的 outputBlocks，也不宣称流畅、全部字段等价或安装真机通过。

无需用户日志的复现入口（先执行标准构建；三夹具读取不扩来源授权）：

```powershell
npm run typecheck
npm test
npm run build
node build/trajectory-fixture-verify.mjs --fixture test/fixtures/trajectory/real-long.json
node build/trajectory-payload-bench.mjs --fixture test/fixtures/trajectory/real-small.json --fixture test/fixtures/trajectory/real-long.json --fixture test/fixtures/trajectory/real-compaction.json --expect-derive-sha256 922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb --samples 11 --warmup 2 --out bench-node.json
node build/trajectory-payload-bench.mjs --fixture test/fixtures/trajectory/real-small.json --fixture test/fixtures/trajectory/real-long.json --fixture test/fixtures/trajectory/real-compaction.json --expect-derive-sha256 922c508989987643f4c873e6120c15e3dfbc1981c8e0cb497140400f95c450cb --emit-browser bench-browser
node build/trajectory-payload-bench.mjs --serve-browser bench-browser --port 8780
```

浏览器使用 CLI 宣告的 URL；预览真实面板使用 `test/preview.html?locale=en&trajectory=long`
（中文用 `locale=zh`），点「Trajectory／轨迹」。它是项目预览，不是 Harness GUI 或安装验收。
正式测试只读受控夹具，不自动消费用户日志；获准新源时用提取 CLI 的显式来源参数另行授权。

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
