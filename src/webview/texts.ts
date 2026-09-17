import { createContext, useContext } from "react";

/**
 * 界面文案：跟随 VS Code 显示语言。
 *
 * 宿主把语言标识放进 state，webview 用它选词典。只做中英两套；
 * 其余语言一律回落英文（而不是显示中文），避免出现半截翻译。
 */

export type Locale = "zh" | "en";

export interface Texts {
  newChat: string;
  history: string;
  openInEditor: string;
  /** 顶部那颗「在浏览器中打开」按钮的 title。 */
  openInBrowser: string;
  /** 还没连上服务器时点它的提示（`@key` 标记，宿主发）。 */
  openInBrowserOffline: string;
  /** 系统拒绝了这次打开（openExternal 返回 false）。 */
  openInBrowserFailed: string;

  emptyHint: string;

  placeholderFirst: string;
  placeholderFollowUp: string;
  send: string;
  sendTitle: string;
  stopTitle: string;
  thinkingDepth: string;
  models: string;
  defaultModel: string;
  noModels: string;
  /** 通用附件按钮（图片与普通文件同一入口）。 */
  attachFile: string;
  /** `@` 列表里目录行右侧的按钮：把整个目录作为引用载入。 */
  attachFolder: string;
  cancel: string;
  remove: string;
  /** 抽屉标题栏的「关闭」/「返回」（此前这两个是写死的中文，双语规则不允许）。 */
  close: string;
  back: string;

  permission: string;
  permReadOnly: string;
  permReadOnlyDesc: string;
  permWorkspaceWrite: string;
  permWorkspaceWriteDesc: string;
  permFullAccess: string;
  permFullAccessDesc: string;
  permConfirmTitle: string;
  permConfirmBody: string;
  permConfirmEnable: string;
  enterPlanMode: string;
  exitPlanMode: string;

  /** 目标条（`goal` 投影）：阶段标签与三个操作。 */
  goalActive: string;
  goalPaused: string;
  goalBlocked: string;
  goalPause: string;
  goalResume: string;
  goalClear: string;
  /** 目标条的「编辑」按钮（官方 GoalBar 有内联编辑，键名 action.edit）。 */
  goalEdit: string;
  /** 内联编辑表单的保存 / 取消（官方 action.save / action.cancel）。 */
  goalSave: string;
  goalCancel: string;
  /** 目标条展开 / 收起全文（目标正文默认一行截断，悬停也能看到全文）。 */
  goalExpand: string;
  goalCollapse: string;

  /**
   * 轮尾「用时 X」里的时长。格式与官方 `formatRunDuration` 逐字一致
   * （zh「42秒」「1分05秒」/ en「42s」「1m 05s」），**不能**复用界面里工具行的
   * `formatDuration`：那是本扩展自己的紧凑格式（「1m 5s」「0.8s」），单位口径不同。
   */
  turnClock: (ms: number) => string;
  /**
   * 连续过程折叠那枚按钮的文案（官方 `message.turnProcess.*`）。
   *
   * 官方是「N 次工具调用 · M 条消息 · K 个 subagent」三段拼起来（各自单复数），
   * 三者皆 0 时读「已思考」；**我们照搬这套文案**（中间那段数的是**折进去的中途消息**
   * 条数，`turnProcess.ts` 的 `messages`）。计数是**这一段**的（一轮最多两枚按钮）。
   * **整句交给词典**而不是在组件里拼：中文没有复数变化、英文有（tool call / tool calls），
   * 分隔符两语言也可能不同（官方 zh/en 都是「 · 」，但仍由词典定义）。
   */
  turnProcessLabel: (counts: { toolCalls: number; messages: number; subagents: number }) => string;
  /** 轮尾的用时与速度（`TurnStatsView` 的展示文案）。 */
  turnRanFor: (duration: string) => string;
  /** 用时胶囊点开后的明细（官方 `message.turnTime.*`）。 */
  turnTimeTitle: string;
  turnTimeDuration: string;
  turnTimeSpeed: string;
  turnTimeTtft: string;
  /** 输出速度的值（官方 `message.tokensPerSecond`：`{tps} tok/s`）。 */
  tokensPerSecond: (tps: string) => string;
  /**
   * 首 token 用时（TTFT）。**与 `turnClock` 不同**：官方这里走
   * `formatLatencySeconds`——**十秒以内保留一位小数**、十秒以上取整（TTFT 是
   * 亚秒级的量，「1.9 秒」和「1 秒」是两回事，抹掉小数就没信息了）。
   */
  turnLatency: (ms: number) => string;

  /** 命令节点：命令名 + 参数、运行中、结果。 */
  commandRunning: string;
  commandFailed: string;
  /** 「没有这条命令」的提示（命令通道返回空结果）。 */
  unknownCommand: (line: string) => string;
  /** 命令通道调用失败（RPC 层面）的提示。 */
  commandDispatchFailed: (line: string) => string;
  /** 轮尾产出文件行的标签（与官方 `produced.label` 逐字一致）。 */
  producedLabel: string;
  /** 轮尾申报交付文件行的标签。 */
  presentedLabel: string;
  /** 产出文件超出展示上限时的剩余计数（也是「展开全部」按钮的文案）。 */
  producedMore: (count: number) => string;
  /** 文件芯片的无障碍标题（点击查看该文件的改动）。 */
  openChangesAria: (name: string) => string;
  /** 助手消息里图片块的无障碍文本（工具结果图片另有一份，见 `toolImageAlt`）。 */
  messageImageAlt: string;
  /** 点开原图（缩略图的悬停说明与浮层的无障碍标题）。 */
  imagePreview: string;
  /** 关闭原图浮层。 */
  imagePreviewClose: string;
  /** 图片加载失败的降级文案（外链被拦、本地文件被删、字节取不回来）。 */
  imageLoadFailed: string;
  /** 工具行展开体的两段标签（官方 `row.input` / `row.output`：zh「输入/输出」、en「IN/OUT」）。 */
  toolInput: string;
  toolOutput: string;
  /** 可点路径的无障碍/悬停说明（官方把摘要做成 fileLink，点了预览该文件）。 */
  /** 认不出的内容块的标签（官方 `message.unknownBlock` 逐字）。 */
  unknownBlock: string;
  /** 上下文条目的 per-form 正文文案（官方 `message.context.*` 逐字）。 */
  contextInstructions: string;
  contextAdded: string;
  contextUpdated: string;
  contextRemoved: string;
  contextCatalogReplaced: string;
  contextCatalogMore: (count: number) => string;
  contextSnapshotSupersedes: string;
  contextRelayFrom: (session: string) => string;
  contextRecallCounts: (retained: number, omitted: number) => string;
  contextRecallTruncated: string;
  /** 文件芯片的悬停说明：默认看改动、按住修饰键直接打开文件。 */
  openChangesHint: string;
  /** 文件芯片行「展开全部」按钮的无障碍标题。 */
  filesExpandAria: (count: number) => string;
  /** 文件芯片行展开后的「收起」文案。 */
  filesCollapse: string;
  /** 文件芯片行「收起」的无障碍标题。 */
  filesCollapseAria: string;
  /**
   * 新建文件芯片的前缀记号（git 未跟踪 = 模型新建，点击直接打开文件）。
   *
   * 判定见 `dsh/fileChange.ts` 的 `isUntracked`——它要同时认 `git.untrackedChanges`
   * 的 `"mixed"`（默认）与 `"separate"` 两种口径，否则这个记号在实际使用中不出现。
   */
  fileNewTag: string;
  /**
   * 已删除芯片（文件名画删除线）的悬停说明。
   *
   * 只陈述**磁盘上没有了**这个事实，并给出可试的动作——**不能**说「内容找不回来
   * 了」：被跟踪的文件删除后仍在工作区改动清单里，点开对比窗口就能看到删除前的
   * 内容（见 `dsh/fileChange.ts` 的 `fileChangeKind` 与 `fileChange.test.ts` 的
   * 「跟踪中的删除」断言）。真正找不回时才由宿主发 `@chipFileDeleted`。
   */
  fileDeletedHint: string;
  /** 已删除芯片的无障碍标题（与 `openChangesAria` 同构，不带语言特有的括号）。 */
  deletedFileAria: (name: string) => string;
  /** 文件已删除且**内容确实找不回**时的 toast（宿主 `@chipFileDeleted` 专用）。 */
  chipFileDeleted: string;
  /** 相对路径但拿不到会话工作目录时的 toast（宿主 `@chipPathUnresolved` 专用）。 */
  chipPathUnresolved: string;
  /** 拖放里读不出字节的项（目录等）的 toast（宿主 `@dropUnreadable:name`）。 */
  dropUnreadable: (name: string) => string;
  /** 拖放里超过大小上限的项的 toast（宿主 `@dropTooLarge:name`）。 */
  dropTooLarge: (name: string) => string;
  /** 图片超过服务端内联上限、被降级成文件上传时的 toast（宿主 `@imageTooLarge:name`）。 */
  imageTooLarge: (name: string) => string;
  /** 拖放区高亮时显示的提示（松开即添加）。 */
  dropHint: string;

  /** 子代理面板 */
  subagents: string;
  subagentsEmpty: string;
  subagentOneShot: string;
  subagentContinuable: string;
  subagentInactive: string;
  /** 轨迹面板 */
  trajectory: string;
  trajectoryEmpty: string;
  /** 轨迹视图（整页）下那颗按钮的提示：点它回到会话。 */
  backToChat: string;
  /** 后台任务面板 */
  jobs: string;
  jobsEmpty: string;
  jobRunning: string;
  jobStopping: string;
  jobCompleted: string;
  jobKilled: string;
  jobFailed: string;
  /** 斜杠命令 */
  commands: string;
  commandsEmpty: string;
  /** `/` 列表里标记「这条是技能，不是可执行的斜杠命令」。 */
  skillTag: string;
  /** 文件附件上传失败（芯片上给重试）。 */
  /** 上传失败且**拿不到服务端原因**时的兜底文案。 */
  uploadFailed: string;
  /**
   * 上传失败芯片的悬停说明：`reason` 是服务端/宿主给的真实原因（可能本身是
   * `@` 标记，调用方先过 `resolveText` 再进来），换行后接「点击重试」。
   */
  uploadFailedReason: (reason: string) => string;
  /** 有附件没上传成功、发送时被跳过（文件名预览 + 总个数）。 */
  uploadIncomplete: (names: string, count: number) => string;
  /** 还没有会话（连不上服务器），附件传不上去。 */
  uploadNoSession: string;
  /** @ 提及 */
  mentionFiles: string;
  /** @ 列表里**对话候选**那一组的标题（官方 `reference.section.sessions`）。 */
  mentionSessions: string;
  mentionEmpty: string;
  mentionHint: string;
  /** @ 列表里「返回上一层目录」那一行的无障碍标题与悬停说明。 */  mentionParent: string;
  /**
   * 目录行右侧的「Tab 进入目录」提示（官方 `reference.drill.*`：徽标写 `Tab`，
   * 文字说明「进入目录」）。Enter / 点击该行是**引用整个目录**，两者口径不同。
   */
  mentionDrill: string;
  /**
   * 「进入目录」那个键的键帽文字（官方 `reference.drill.key`，中英都是 `Tab`——
   * 键名不翻译，但按双语规则仍走词典，免得在组件里写死字符串）。
   */
  mentionDrillKey: string;
  /** 对话候选没有工作目录时的占位（官方 `reference.candidate.noCwd`）。 */
  mentionNoCwd: string;

  running: string;
  queued: string;
  queueRemove: string;
  /** 把排队消息取回输入框重新编辑。 */
  queueEdit: string;
  queueMediaOnly: string;
  runningHint: string;
  /** 队列非空时的运行提示：ESC 除了中止，还会把队首消息发出去。 */
  runningHintQueue: string;

  thinking: string;
  /** diff 行数超上限时的截断提示。 */
  diffTruncated: string;

  /** 自动载入的提示词节点：把来源映射成人类可读标签。 */
  injectedSystemPrompt: string;
  injectedRuntimeContext: string;
  injectedAgentInstructions: string;
  injectedSkillCatalog: string;
  /**
   * 上下文注入节点的**标题**（官方 `message.contextInjection` =「上下文注入」）。
   *
   * 用户 2026-09-14 要求与 Web 一致：非系统提示词的注入（插件注入、项目指令、
   * 技能目录、运行时上下文…）在 Web 上**统一**叫「上下文注入」，具体来源放在右侧。
   * 我们此前按来源各起一个名字（「插件上下文」等），标题与 Web 不一致。
   */
  injectedContext: string;
  /** 跨会话召回的标题（官方 `message.contextRecall` =「跨会话召回」）。 */
  injectedRecall: string;
  /** 自动载入节点的字数标注，如「7.0K 字符」。 */
  injectedChars: (chars: string) => string;

  approvalTitle: string;
  approvalApproved: string;
  approvalRejected: string;
  approvalExpired: string;
  allow: string;
  allowAlways: string;
  reject: string;
  /** 审批卡上的「调用标识」（工具调用的 callId）。 */
  callId: (id: string) => string;
  questionHead: string;
  questionPlaceholder: string;
  submit: string;
  /**
   * 依次问答时的进度（官方 `QuestionComposer` 的分页只给一个 `N/M` 数字，
   * 这里给出带「题」的完整短语——中文没有 the 这类冠词，拼串翻不准）。
   */
  questionStep: (index: number, total: number) => string;
  /** 依次问答的上一题 / 下一题（官方 `nav.prev` / `action.next`）。 */
  questionPrev: string;
  questionNext: string;
  /** 答完收缩后的摘要（「已作答 N 题」）。 */
  questionAnswered: (count: number) => string;
  /** 被撤回的提问（Host 取消了这次提问 / 轮次中止）的摘要（「已取消 N 题」）。 */
  questionCancelled: (count: number) => string;
  /** 自定义回答那一行的**标题**（它是个「标题 + 输入框」的组合组件）。 */
  questionCustomTitle: string;
  /** 自定义回答那一行的无障碍说明（它和普通选项一样可以选，只是带编辑框）。 */
  questionCustomAria: string;
  /**
   * 计划审阅卡（`exit_plan_mode`）的文案，与官方 `dsh-client-ui-user-questions`
   * 的 `plan.*` 词条逐字对齐：条带「计划待审」+ 三个决定
   * （确认执行 / 拒绝 / 去聊天里说）。
   */
  planReviewHeader: string;
  planReviewApprove: string;
  planReviewDecline: string;
  planReviewDiscuss: string;

  copy: string;
  /** 复制按钮的 1s 瞬时反馈（按钮文案自换；宿主不再发「已复制」toast）。 */
  copied: string;
  insertToEditor: string;
  stopped: string;

  connecting: string;
  connectionFailed: string;
  /** 连接条按钮：手动去连一次（只接上已在跑的后台/外部地址，不负责拉起）。 */
  reconnect: string;
  restartServer: string;
  /** 连接条按钮：用户显式拉起后台（关掉 `dshChat.autoStart` 时的主要入口）。 */
  startServer: string;
  /**
   * 连接条按钮：停掉**正在进行的连接**。
   *
   * 它绑定的是"界面正在连接"（`connection === "connecting"`，含首轮连接与失败后的重连循环），
   * **不绑定 `reconnecting`**——那个字段只描述"循环还在不在跑"（见 `ChatState.reconnecting`）。
   * 用户 2026-09-15 口径：只要在连接，就得有个按钮能停下来。
   */
  stopReconnect: string;
  /** 连接条按钮：打开扩展的输出通道看原因。 */
  showLogs: string;
  /** 连接条：后台（守护进程 + dsh）没有在运行。 */
  serverNotRunning: string;
  /** 连接条：用户刚停止过服务器。 */
  serverStopped: string;
  /** 连接条：正在一轮轮重连（没有总超时）。 */
  reconnecting: string;
  /** 连接条：用户按了「停止连接」，而后台还在跑（可以再点「尝试连接」）。 */
  reconnectStopped: string;
  /** 外部服务器要求授权时的「输入令牌」按钮。 */
  enterToken: string;
  /** 连接失败条：外部服务器要令牌，而自动获取的那个没被接受。 */
  authNeedsToken: string;
  /** 连接失败条：令牌连续被拒。 */
  authTokenRejected: string;
  /** 连接失败条：连接断开，正在重连。 */
  connectionLost: string;
  /** 连接失败条：dsh 进程起不来（原因来自 spawn）。 */
  serverSpawnFailed: (detail: string) => string;
  /** 连接失败条：后台没能就绪（缺地址或令牌；**不再有"等超时"这一档**）。 */
  serverNotReady: string;
  /** 连接条：该地址上一次都没应答过（**仍在重试**，直到连通或用户点「停止连接」）。 */
  serverUnreachable: (baseUrl: string) => string;
  /** 连接失败条末段：服务器日志尾部（原文照贴，不翻译）。 */
  serverLogTail: (tail: string) => string;
  /** toast：在共享后台的窗口里执行「重启服务器」，后台已由本窗口接管重起。 */
  sharedRestarted: string;

  searchSessions: string;
  today: string;
  earlier: string;
  noSessions: string;
  untitled: string;
  runningTag: string;
  /**
   * 分支（`session/fork`）会话在历史列表里的标题前缀。
   *
   * 分支**继承源会话的标题**（官方 wire 端点没有 `increaseTitle` 字段），
   * 不前缀的话历史里就是两条一模一样的标题。带标题参数，避免在组件里拼串。
   *
   * 两种语言都用**半角冒号 + 一个空格**与标题分隔（用户口径）：
   * `分支: 标题` / `Fork: Title`。
   */
  forkedTitle: (title: string) => string;
  /** 历史列表行内操作：归档（服务端从工作区移出）与删除（本地删除日志文件）。 */
  archive: string;
  /** 归档视图入口按钮 / 抽屉标题。 */
  archiveList: string;
  deleteSession: string;
  deleteSessionConfirm: string;
  noArchivedSessions: string;

  contextUsed: (percent: number, used: string, total: string) => string;
  /** 悬停上下文占用时的明细行（标签 + 数值）。 */
  ctxDetailCached: string;
  ctxDetailSystem: string;
  ctxDetailTools: string;
  ctxDetailMessages: string;
  /** 速度值悬停明细（全日志会话统计），行标签与 Web「会话统计」对话框对齐。 */
  statsLlmTime: string;
  statsToolTime: string;
  statsTtft: string;
  statsSpeed: string;
  /**
   * 悬停明细的标题：**必须**说清这份明细的口径是全日志的会话统计。
   *
   * 工具栏上直接显示的那个 tps 是**最近一条助手消息**的解码窗口吞吐（逐 token
   * 变化），明细里的是**全会话累计**（Σ 输出 token ÷ Σ 解码窗口）——两者本来就
   * 不是同一个数（用户 2026-09-14 就是被这一点问住的）。标题让口径写在脸上。
   */
  statsTitle: string;
  /** Markdown 脚注区的无障碍标题（官方 `markdown.footnotes`，视觉上隐藏）。 */
  markdownFootnotes: string;
  /** 模型不支持图片输入、改为把路径插进输入框的提示（张数 + 模型名）。 */
  imagePathsInserted: (count: number, model: string) => string;
  /** 排队消息取回编辑时，附件无法还原的提示。 */
  queueAttachmentsLost: string;
  /** 排队消息拿不到可重发内容时的提示。 */
  queueContentLost: string;
  /** 排队消息没能自动发出时的提示（内容已放回输入框）。 */
  queueDispatchFailed: string;
  turnFailed: string;
  interrupted: string;
  compacted: string;
  /** 模型调用失败后自动重试（第几次 / 共几次）。 */
  llmRetry: (attempt: number, max: number) => string;
  /** 同上，但服务端没给重试上限。 */
  llmRetryAlways: (attempt: number) => string;
  unknownEvent: (type: string) => string;
  toolRead: string;
  toolWrite: string;
  toolEdit: string;
  toolRun: string;
  toolSearch: string;
  /** 官方 `TOOL_TITLE_KEYS` 里各工具的**自有标题**（不套用变体名）。 */
  toolPwsh: string;
  toolReadImage: string;
  /**
   * cordis（插件运行时）那几只工具的自有标题。
   *
   * 它们由 `shared/toolMeta.ts` 的 `TOOL_TITLE_KEYS` 按名字映射过来，而界面侧是
   * **动态查表**（`Rows.tsx` 里 `texts[titleKey]`）——字典缺键时 TS 不会报错，
   * 界面会把工具 id 原样（`cordis_run`）画成标题。所以 `scripts/i18n.test.ts`
   * 有一条断言逐个核对这张表里的键在两份字典里都存在。
   */
  toolInspect: string;
  toolRunCordis: string;
  toolStopCordis: string;
  toolRemoveCordis: string;
  /** `others` 变体的兜底标题（官方 `tool.title.generic`）。 */
  toolGeneric: string;
  toolCode: string;
  /** 非零退出码的标注（官方 `terminal.exitCode`）。 */
  toolExitCode: (code: number) => string;
  /** 被信号杀死的标注（官方 `terminal.signal`）。 */
  toolSignal: (signal: string) => string;
  /** 工具结果里图片的替代文本。 */
  toolImageAlt: string;
  /** 运行中工具行的状态点标签（官方 `row.running`）。 */
  /** 已停止（官方 `row.stopped`：中断，不是失败）。 */
  /** 失败（官方 `row.failed`）。 */

  // ---------- 工具卡（官方 `ReadBlock` / `SearchBlock` / `TerminalBlock` / `WebBlock`）
  //
  // 有卡片时展开区**不再渲染 IN/OUT**（参数 JSON 不进界面），所以这些标签与
  // 计数文案必须齐全：读了多少行、命中多少处、退出码是多少、来源截断没有。
  /** 卡片的通用「收起」（官方 `collapse`）。 */
  toolCollapse: string;
  /** 读取卡：只读了一段时的「显示 X / Y 行」（官方 `read.window`）。 */
  readWindow: (shown: number, total: number) => string;
  /** 读取卡：中间那枚展开钮的文案（官方 `read.expandRest`）。 */
  readExpandRest: (count: number) => string;
  /** 读取卡：展开钮的无障碍名（官方 `read.expandAria`）。 */
  readExpandAria: (count: number) => string;
  /** 读取卡：收起钮的无障碍名（官方 `read.collapseAria`）。 */
  readCollapseAria: string;
  /** 搜索卡：路径结果的计数（官方 `search.paths`）。 */
  searchPaths: (shown: number) => string;
  /** 搜索卡：路径结果被截断时的计数（官方 `search.paths.truncated`）。 */
  searchPathsTruncated: (shown: number, total: number) => string;
  /** 搜索卡：命中结果的计数（官方 `search.matches`）。 */
  searchMatches: (shown: number, files: number) => string;
  /** 搜索卡：命中结果被截断时的计数（官方 `search.matches.truncated`）。 */
  searchMatchesTruncated: (shown: number, total: number, files: number) => string;
  /** 搜索卡：没有结果（官方 `search.noResults`）。 */
  searchNoResults: string;
  /** 搜索卡：展开 / 收起钮的无障碍名（官方 `search.expandAria` / `collapseAria`）。 */
  searchExpandAria: (count: number) => string;
  searchCollapseAria: string;
  /** 搜索卡：展开钮的文案（官方 `search.expandRest`）。 */
  searchExpandRest: (count: number) => string;
  /** 网页搜索卡：没有结果（官方 `web.noResults`）。 */
  webNoResults: string;
  /** 网页卡：来源列表被截断（官方 `web.sourcesTruncated`）。 */
  webSourcesTruncated: string;
  /** 网页获取卡：HTTP 状态码前缀（官方 `web.http`）。 */
  webHttp: string;
  /** 网页获取卡：正文被截断（官方 `web.contentTruncated`）。 */
  webContentTruncated: string;
  /** 终端卡：运行中 / 已完成 / 失败（官方 `terminal.running` / `done` / `failed`）。 */
  terminalRunning: string;
  terminalDone: string;
  terminalFailed: string;
  /** 终端卡：没有输出（官方 `terminal.noOutput`）。 */
  terminalNoOutput: string;
  /** 终端卡：输出区的展开 / 收起钮（官方 `terminal.expandAria` / `collapseAria`）。 */
  /** 待办工具行的标题（官方 `todo.rowTitle`）。 */
  toolTodoTitle: string;
  /** 待办进度：`{done}/{total} 已完成`（官方 `todo.completed`）。 */
  toolTodoProgress: (done: number, total: number) => string;
  /** 达到输出 token 上限、回答被截断（官方 `turn-max-tokens` 节点）。 */
  maxTokens: string;

  /** 分支：从某个回复节点创建新的并行会话。 */
  branchFromHere: string;
  /** 分支创建失败的提示。 */
  branchFailed: string;
  /** 分支创建成功的提示（新会话标题作为变量）。 */
  branchCreated: (title: string) => string;
  /** 这条消息还取不到分支锚点（本轮尚未收尾）。 */
  branchNoAnchor: string;
  /** 分支按钮的禁用说明（运行中不能分支）。 */
  branchRunning: string;
  /** 会话列表里「这是分支」的角标。 */
  /** 历史：把窗口外的历史**一次全部**取回来（不再按「上一条用户消息」分段）。 */
  historyMore: string;
  /** 正在取更早的历史（按钮在此期间是不可点的）。 */
  historyLoading: string;
  /** 生成中不能翻历史（重折会让流式正文重来）。 */
  historyBusy: string;
  /** 「回到最新」胶囊：脱贴后内容继续增长时的兜底入口（点击回底并恢复贴底）。 */
  jumpToLatest: string;
  /** 用户消息过长时默认折叠：展开。 */
  userMessageExpand: string;
  /** 用户消息过长时默认折叠：收起。 */
  userMessageCollapse: string;
  /** 运行中发消息：按 busyEnter=queue 时的按钮文案。 */
  sendQueue: string;
  /** 运行中发消息：按 busyEnter=steer 时的按钮文案。 */
  sendSteer: string;
  /** 队列行：把这条排队消息改成插话（仅运行中可用）。 */
  queueSteer: string;
  /** 插话按钮的禁用说明（非运行中）。 */
  queueSteerUnavailable: string;
  /** 插话失败（服务端拒绝）。 */
  /** 服务端给了本扩展还不认识的状态：原样说明，不猜它已完成。 */
  jobUnknown: string;

  /** 设置：字体大小。 */

  /** 设置：界面语言。 */
  /** 运行中的工具行展开后：`运行中 · 已用 {duration}`。 */
  toolRunning: string;
  /** 运行中的工具行展开后：说明为什么现在还没有输出。 */
  toolRunningHint: string;
}

const zh: Texts = {
  newChat: "新建对话",
  history: "历史对话",
  openInEditor: "在编辑器中打开",
  openInBrowser: "在浏览器中打开 DSH Web",
  openInBrowserOffline: "还没有连上 DSH 服务器，暂时无法在浏览器中打开。",
  openInBrowserFailed: "系统没有打开浏览器，可以手动访问 dsh web 打印的地址。",

  emptyHint: "用 @ 添加文件或选区作为上下文；Shift+Enter 换行。",

  placeholderFirst: "问点什么，或用 @ 添加上下文",
  placeholderFollowUp: "继续追问…",
  send: "发送",
  sendTitle: "发送（Enter）",
  stopTitle: "停止生成",
  thinkingDepth: "思考深度",
  models: "模型",
  defaultModel: "默认模型",
  noModels: "未获取到模型目录",
  attachFile: "添加文件",
  attachFolder: "整个目录",
  cancel: "取消",
  remove: "移除",
  close: "关闭",
  back: "返回",

  permission: "权限",
  permReadOnly: "仅可查看",
  permReadOnlyDesc: "只能读取，不做任何修改",
  permWorkspaceWrite: "工作区内修改",
  permWorkspaceWriteDesc: "可在工作区内读写，越界需授权",
  permFullAccess: "完全权限",
  permFullAccessDesc: "不受工作区限制，含敏感操作（危险）",
  permConfirmTitle: "确认启用完全权限？",
  permConfirmBody:
    "启用后新会话将减少确认步骤，可直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。",
  permConfirmEnable: "启用完全权限",
  enterPlanMode: "进入计划模式",
  exitPlanMode: "退出计划模式",

  goalActive: "进行中的目标",
  goalPaused: "已暂停的目标",
  goalBlocked: "受阻的目标",
  goalPause: "暂停目标",
  goalResume: "恢复目标",
  goalClear: "清除目标",
  goalEdit: "编辑目标",
  goalSave: "保存",
  goalCancel: "取消",
  goalExpand: "展开目标全文",
  goalCollapse: "收起目标全文",
  turnClock: (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0
      ? `${minutes}分${String(seconds).padStart(2, "0")}秒`
      : `${seconds}秒`;
  },
  turnRanFor: (duration) => `用时 ${duration}`,
  turnProcessLabel: ({ toolCalls, messages, subagents }) => {
    const parts: string[] = [];
    if (toolCalls > 0) parts.push(`${toolCalls} 次工具调用`);
    if (messages > 0) parts.push(`${messages} 条消息`);
    if (subagents > 0) parts.push(`${subagents} 个 subagent`);
    return parts.length ? parts.join(" · ") : "已思考";
  },
  turnTimeTitle: "本轮用时和速度",
  turnTimeDuration: "本轮总用时",
  turnTimeSpeed: "输出速度（TPS）",
  turnTimeTtft: "首 token 用时（TTFT）",
  tokensPerSecond: (tps) => `${tps} tok/s`,
  turnLatency: (ms) => {
    const seconds = Math.max(0, ms) / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}秒`;
  },

  commandRunning: "执行中",
  commandFailed: "执行失败",
  unknownCommand: (line) => `没有这条命令：${line}`,
  commandDispatchFailed: (line) => `命令 ${line} 没能发出去`,
  producedLabel: "本轮文件改动",
  presentedLabel: "交付文件",
  producedMore: (count) => `+ ${count} 个文件`,
  openChangesAria: (name) => `查看 ${name} 的改动`,
  openChangesHint: "点击查看改动对比；按住 Alt 直接打开文件",
  filesExpandAria: (count) => `展开全部 ${count} 个文件`,
  filesCollapse: "收起",
  filesCollapseAria: "收起文件列表",
  fileNewTag: "[新增]",
  fileDeletedHint: "文件已从磁盘删除；点击尝试查看删除前的内容",
  deletedFileAria: (name) => `已删除的文件 ${name}`,
  chipFileDeleted: "文件已删除，内容找不回来了",
  chipPathUnresolved: "暂时拿不到会话工作目录，无法定位这个文件；稍后再点一次试试",
  dropUnreadable: (name) => `${name} 读不出来，没有加进来（目录暂不支持拖放，请用「添加文件」或 @ 引用）`,
  dropTooLarge: (name) => `${name} 太大，拖放上限 8 MB；请改用「添加文件」`,
  imageTooLarge: (name) => `${name} 超过服务端的图片上限，已改为按文件上传`,
  dropHint: "松开即添加为附件",

  subagents: "子代理",
  subagentsEmpty: "当前会话没有子代理",
  subagentOneShot: "一次性",
  subagentContinuable: "可继续",
  subagentInactive: "未运行",
  trajectory: "轨迹",
  trajectoryEmpty: "本会话还没有工具调用",
  backToChat: "返回会话",
  jobs: "后台任务",
  jobsEmpty: "当前会话没有后台任务",
  jobRunning: "运行中",
  jobStopping: "正在停止",
  jobCompleted: "已完成",
  jobKilled: "已取消",
  jobUnknown: "未知状态",
  jobFailed: "失败",
  commands: "命令",
  commandsEmpty: "没有可用命令",
  skillTag: "技能",
  uploadFailed: "上传失败，点击重试",
  uploadFailedReason: (reason) => `${reason}\n点击重试`,
  uploadIncomplete: (names, count) =>
    `有 ${count} 个文件没能上传（${names}），本次只发送了就绪的附件`,
  uploadNoSession: "还没有连上服务器，附件传不上去",
  mentionFiles: "文件",
  mentionSessions: "对话",
  mentionEmpty: "没有匹配的文件",
  mentionHint: "↑↓ 选择 · Enter 引用 · Tab 进入目录 · Esc 取消",
  mentionParent: "返回上一层目录",
  mentionDrill: "进入目录",
  mentionDrillKey: "Tab",
  mentionNoCwd: "（无工作目录）",

  running: "深度求索中",
  queued: "待发送 {n} 条",
  queueRemove: "取消这条消息",
  queueEdit: "取回重新编辑",
  queueMediaOnly: "（附件）",
  runningHint: "按 ESC 可中止",
  runningHintQueue: "按 ESC 可中止并发出排队消息",

  thinking: "思考",
  diffTruncated: "… 内容过长，已截断",

  injectedSystemPrompt: "系统提示词",
  injectedRuntimeContext: "运行时上下文",
  injectedAgentInstructions: "项目指令",
  injectedSkillCatalog: "技能目录",
  injectedContext: "上下文注入",
  injectedRecall: "跨会话召回",
  injectedChars: (chars) => `${chars} 字符`,

  approvalTitle: "需要你的许可",
  approvalApproved: "已允许",
  approvalRejected: "已拒绝",
  approvalExpired: "已失效",
  allow: "允许",
  allowAlways: "始终允许",
  reject: "拒绝",
  callId: (id) => `调用标识：${id}`,
  questionHead: "问题",
  questionPlaceholder: "或直接输入回答…",
  submit: "提交",
  questionStep: (index, total) => `第 ${index} / ${total} 题`,
  questionPrev: "上一题",
  questionNext: "下一题",
  questionAnswered: (count) => `已作答 ${count} 题`,
  questionCancelled: (count) => `已取消 ${count} 题`,
  questionCustomTitle: "自定义回答",
  questionCustomAria: "自定义回答（选中后其它选项会被取消）",
  planReviewHeader: "计划待审",
  planReviewApprove: "确认执行",
  planReviewDecline: "拒绝",
  planReviewDiscuss: "去聊天里说",

  copy: "复制",
  copied: "已复制到剪贴板",
  insertToEditor: "插入到当前编辑器",
  stopped: "已停止",

  connecting: "正在连接…",
  connectionFailed: "无法连接 DSH 服务器",
  reconnect: "尝试连接",
  restartServer: "重启服务器",
  startServer: "启动服务器",
  stopReconnect: "停止连接",
  showLogs: "查看日志",
  serverNotRunning: "后台服务器没有在运行。点「启动服务器」拉起一套。",
  serverStopped: "DSH 服务器已停止。",
  reconnecting: "正在连接…",
  reconnectStopped: "已停止连接。可点「尝试连接」重新连接。",
  enterToken: "输入令牌",
  authNeedsToken:
    "外部 DSH 服务器需要访问令牌：请点「输入令牌」填入 dsh web 启动时打印的 token（或命令面板「DSH: 输入访问令牌」）。",
  authTokenRejected:
    "服务器要求授权，且自动获取的令牌未被接受。请用命令面板「DSH: 重启服务器」重启它。",
  connectionLost: "与服务器的连接已断开，正在重连…",
  serverSpawnFailed: (detail) => `启动 dsh 进程失败：${detail}`,
  serverNotReady: "后台没有就绪（会合文件里还没有地址或令牌）。可点「重启服务器」重试，或用「查看日志」看原因。",
  serverUnreachable: (baseUrl) => `连不上 ${baseUrl}（会一直重试，可点「停止连接」）。请确认该地址上运行着 dsh web。`,
  serverLogTail: (tail) => `日志尾部：\n${tail}`,
  sharedRestarted: "共享后台已由本窗口接管并重启，其它窗口会自动重新接入。",

  searchSessions: "搜索历史对话",
  today: "今天",
  earlier: "更早",
  noSessions: "还没有历史对话",
  untitled: "未命名对话",
  runningTag: "运行中",
  forkedTitle: (title) => `分支: ${title}`,
  archive: "归档（从工作区列表移出）",
  archiveList: "归档列表",
  deleteSession: "删除（删除本地日志文件）",
  deleteSessionConfirm: "再次点击确认删除",
  noArchivedSessions: "暂无归档会话",

  contextUsed: (percent, used, total) => `上下文已用 ${percent}%（${used} / ${total}）`,
  ctxDetailCached: "缓存命中",
  ctxDetailSystem: "系统提示词",
  ctxDetailTools: "工具定义",
  ctxDetailMessages: "对话消息",
  statsLlmTime: "模型用时",
  statsToolTime: "工具调用用时",
  statsTtft: "首 token 平均（TTFT）",
  statsSpeed: "平均输出速度（TPS）",
  statsTitle: "会话统计（全日志累计）",
  markdownFootnotes: "脚注",
  turnFailed: "本轮执行失败",
  interrupted: "本轮被中断",
  compacted: "上下文已压缩",
  llmRetry: (attempt, max) => `模型调用失败，正在重试（第 ${attempt} / ${max} 次）`,
  llmRetryAlways: (attempt) => `模型调用失败，正在重试（第 ${attempt} 次）`,
  /** 当前模型不支持图片输入时的提示（模型名作为变量）。 */
  imagePathsInserted: (count, model) =>
    `模型「${model}」不支持图片输入，已把 ${count} 个路径插入输入框`,
  queueAttachmentsLost: "这条消息的附件无法还原，请重新添加（正文已放回输入框）",
  queueContentLost: "排队消息的内容无法还原，已只中止当前轮",
  queueDispatchFailed: "排队消息没能自动发出，内容已放回输入框",
  unknownEvent: (type) => `遇到了本客户端不认识的事件「${type}」，已跳过其内容。`,
  toolRead: "读取",
  toolWrite: "写入",
  toolEdit: "编辑",
  toolRun: "运行",
  toolSearch: "搜索",
  toolPwsh: "Pwsh",
  toolReadImage: "读取图片",
  toolInspect: "查看插件",
  toolRunCordis: "运行插件",
  toolStopCordis: "停止插件",
  toolRemoveCordis: "移除插件",
  toolGeneric: "工具调用",
  toolCode: "代码",
  toolExitCode: (code) => `退出码 ${code}`,
  toolSignal: (signal) => `被信号 ${signal} 终止`,
  toolImageAlt: "工具返回的图片",
  messageImageAlt: "消息里的图片",
  imagePreview: "查看原图",
  imagePreviewClose: "关闭原图预览",
  imageLoadFailed: "图片加载失败",
  toolInput: "输入",
  toolOutput: "输出",
  unknownBlock: "未知内容块",
  contextInstructions: "上下文指令",
  contextAdded: "已新增",
  contextUpdated: "已更新",
  contextRemoved: "已移除",
  contextCatalogReplaced: "替换目录",
  contextCatalogMore: (count) => `…还有 ${count} 条`,
  contextSnapshotSupersedes: "取代先前的快照",
  contextRelayFrom: (session) => `来自会话 ${session}`,
  contextRecallCounts: (retained, omitted) => `保留 ${retained} 条 · 省略 ${omitted} 条`,
  contextRecallTruncated: "已截断",
  toolCollapse: "收起",
  readWindow: (shown, total) => `显示 ${shown} / ${total} 行`,
  readExpandRest: (count) => `… 其余 ${count} 行`,
  readExpandAria: (count) => `展开其余 ${count} 行`,
  readCollapseAria: "收起内容",
  searchPaths: (shown) => `${shown} 个路径`,
  searchPathsTruncated: (shown, total) => `显示 ${shown} / 共 ${total} 个路径`,
  searchMatches: (shown, files) => `${shown} 处匹配 · ${files} 个文件`,
  searchMatchesTruncated: (shown, total, files) => `显示 ${shown} / 共 ${total} 处匹配 · ${files} 个文件`,
  searchNoResults: "无结果",
  searchExpandAria: (count) => `展开其余 ${count} 行结果`,
  searchCollapseAria: "收起结果",
  searchExpandRest: (count) => `… 其余 ${count} 行`,
  webNoResults: "未找到结果",
  webSourcesTruncated: "来源列表已截断",
  webHttp: "HTTP",
  webContentTruncated: "内容已截断",
  terminalRunning: "运行中",
  terminalDone: "已完成",
  terminalFailed: "失败",
  terminalNoOutput: "无输出",
  toolTodoTitle: "更新任务清单",
  toolTodoProgress: (done, total) => `${done}/${total} 已完成`,
  maxTokens: "已达到输出 token 上限，回答被截断。发送「继续」可接着写。",

  branchFromHere: "从这里分支",
  branchFailed: "创建分支失败",
  branchCreated: (title) => `已创建分支：${title}`,
  branchNoAnchor: "这条消息还取不到分支锚点（本轮尚未收尾），暂时不能分支",
  branchRunning: "生成中不能分支",
  historyMore: "加载全部历史",
  historyLoading: "正在加载全部历史…",
  jumpToLatest: "回到最新",
  historyBusy: "生成中不能加载历史，请等这一轮结束",
  userMessageExpand: "展开",
  userMessageCollapse: "收起",
  sendQueue: "排队发送",
  sendSteer: "插话发送",
  queueSteer: "插话发送",
  queueSteerUnavailable: "仅运行中可插话发送",


  toolRunning: "运行中 · 已用 {duration}",
  toolRunningHint: "输出会在执行结束后显示",
};

const en: Texts = {
  newChat: "New chat",
  history: "Chat history",
  openInEditor: "Open in editor",
  openInBrowser: "Open DSH Web in browser",
  openInBrowserOffline: "Not connected to a DSH server yet, so it cannot be opened in the browser.",
  openInBrowserFailed: "The browser was not opened; you can visit the URL printed by dsh web manually.",

  emptyHint: "Use @ to attach files or a selection. Shift+Enter for a new line.",

  placeholderFirst: "Ask anything, or use @ to add context",
  placeholderFollowUp: "Ask a follow-up",
  send: "Send",
  sendTitle: "Send (Enter)",
  stopTitle: "Stop generating",
  thinkingDepth: "Thinking depth",
  models: "Models",
  defaultModel: "Default model",
  noModels: "No model catalog available",
  attachFile: "Attach file",
  attachFolder: "whole folder",
  cancel: "Cancel",
  remove: "Remove",
  close: "Close",
  back: "Back",

  permission: "Permission",
  permReadOnly: "Read Only",
  permReadOnlyDesc: "Can read but never modify anything",
  permWorkspaceWrite: "Workspace Write",
  permWorkspaceWriteDesc: "Can read and write inside the workspace; beyond it needs approval",
  permFullAccess: "Full Access",
  permFullAccessDesc: "Unrestricted, including sensitive operations (dangerous)",
  permConfirmTitle: "Enable full access?",
  permConfirmBody:
    "New sessions will skip most confirmations and may run sensitive operations, modify files or run external commands. Only use it when you trust the work that follows.",
  permConfirmEnable: "Enable full access",
  enterPlanMode: "Enter plan mode",
  exitPlanMode: "Exit plan mode",

  goalActive: "Ongoing Goal",
  goalPaused: "Paused Goal",
  goalBlocked: "Blocked Goal",
  goalPause: "Pause goal",
  goalResume: "Resume goal",
  goalClear: "Clear goal",
  goalEdit: "Edit goal",
  goalSave: "Save",
  goalCancel: "Cancel",
  goalExpand: "Show the full goal",
  goalCollapse: "Collapse the goal",
  turnClock: (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0
      ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
      : `${seconds}s`;
  },
  turnRanFor: (duration) => `Ran for ${duration}`,
  turnProcessLabel: ({ toolCalls, messages, subagents }) => {
    const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
    const parts: string[] = [];
    if (toolCalls > 0) parts.push(plural(toolCalls, "tool call"));
    if (messages > 0) parts.push(plural(messages, "message"));
    if (subagents > 0) parts.push(plural(subagents, "subagent"));
    return parts.length ? parts.join(" · ") : "Thought for a while";
  },
  turnTimeTitle: "Turn time and speed",
  turnTimeDuration: "Total run time",
  turnTimeSpeed: "Tokens per second (TPS)",
  turnTimeTtft: "Time to first token (TTFT)",
  tokensPerSecond: (tps) => `${tps} tok/s`,
  turnLatency: (ms) => {
    const seconds = Math.max(0, ms) / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}s`;
  },

  commandRunning: "Running",
  commandFailed: "Failed",
  unknownCommand: (line) => `No such command: ${line}`,
  commandDispatchFailed: (line) => `Could not dispatch ${line}`,
  producedLabel: "Files changed",
  presentedLabel: "Presented files",
  producedMore: (count) => `+ ${count} file${count === 1 ? "" : "s"}`,
  openChangesAria: (name) => `View changes in ${name}`,
  openChangesHint: "Click to view changes; hold Alt to open the file",
  filesExpandAria: (count) => `Show all ${count} file${count === 1 ? "" : "s"}`,
  filesCollapse: "Collapse",
  filesCollapseAria: "Collapse file list",
  fileNewTag: "[new]",
  fileDeletedHint: "This file is no longer on disk; click to try to view its content before deletion",
  deletedFileAria: (name) => `Deleted file ${name}`,
  chipFileDeleted: "The file was deleted; its content is no longer available",
  chipPathUnresolved:
    "The session working directory is not available yet, so this file cannot be located; try again in a moment",
  dropUnreadable: (name) =>
    `${name} could not be read and was not attached (folders cannot be dropped; use the attach button or an @ reference)`,
  dropTooLarge: (name) => `${name} is too large to drop (limit 8 MB); use the attach button instead`,
  imageTooLarge: (name) => `${name} is over the server's image limit and was uploaded as a file instead`,
  dropHint: "Release to attach",

  subagents: "Subagents",
  subagentsEmpty: "This session has no subagents",
  subagentOneShot: "one-shot",
  subagentContinuable: "continuable",
  subagentInactive: "not running",
  trajectory: "Trajectory",
  trajectoryEmpty: "No tool calls in this session yet",
  backToChat: "Back to chat",
  jobs: "Background jobs",
  jobsEmpty: "This session has no background jobs",
  jobRunning: "running",
  jobStopping: "stopping",
  jobCompleted: "completed",
  jobKilled: "cancelled",
  jobUnknown: "unknown status",
  jobFailed: "failed",
  commands: "Commands",
  commandsEmpty: "No commands available",
  skillTag: "Skill",
  uploadFailed: "Upload failed — click to retry",
  uploadFailedReason: (reason) => `${reason}\nClick to retry`,
  uploadIncomplete: (names, count) =>
    `${count} file(s) could not be uploaded (${names}); only the ready attachments were sent`,
  uploadNoSession: "Not connected to the server yet; the attachment cannot be uploaded",
  mentionFiles: "Files",
  mentionSessions: "Sessions",
  mentionEmpty: "No matching files",
  mentionHint: "↑↓ select · Enter reference · Tab browse folder · Esc cancel",
  mentionParent: "Go to the parent folder",
  mentionDrill: "Browse folder",
  mentionDrillKey: "Tab",
  mentionNoCwd: "(no cwd)",

  running: "Deep diving",
  queued: "{n} queued",
  queueRemove: "Remove this message",
  queueEdit: "Take back to edit",
  queueMediaOnly: "(attachment)",
  runningHint: "Press ESC to stop",
  runningHintQueue: "Press ESC to stop and send the queued message",

  thinking: "Thinking",
  diffTruncated: "… truncated",

  injectedSystemPrompt: "System prompt",
  injectedRuntimeContext: "Runtime context",
  injectedAgentInstructions: "Workspace instructions",
  injectedSkillCatalog: "Skill catalog",
  injectedContext: "Context injection",
  injectedRecall: "Session recall",
  injectedChars: (chars) => `${chars} chars`,

  approvalTitle: "Permission required",
  approvalApproved: "Allowed",
  approvalRejected: "Rejected",
  approvalExpired: "Expired",
  allow: "Allow",
  allowAlways: "Always allow",
  reject: "Reject",
  callId: (id) => `Call ID: ${id}`,
  questionHead: "Question",
  questionPlaceholder: "Or type your own answer…",
  submit: "Submit",
  questionStep: (index, total) => `Question ${index} of ${total}`,
  questionPrev: "Previous",
  questionNext: "Next",
  questionAnswered: (count) => (count === 1 ? "1 question answered" : `${count} questions answered`),
  questionCancelled: (count) => (count === 1 ? "1 question withdrawn" : `${count} questions withdrawn`),
  questionCustomTitle: "Custom answer",
  questionCustomAria: "Custom answer (selecting it clears the other options)",
  planReviewHeader: "Plan review",
  planReviewApprove: "Approve",
  planReviewDecline: "Refuse",
  planReviewDiscuss: "Chat about it",

  copy: "Copy",
  copied: "Copied to clipboard",
  insertToEditor: "Insert into the active editor",
  stopped: "Stopped",

  connecting: "Connecting…",
  connectionFailed: "Cannot reach the DSH server",
  reconnect: "Connect",
  restartServer: "Restart server",
  startServer: "Start server",
  stopReconnect: "Stop connecting",
  showLogs: "Show logs",
  serverNotRunning: "The DSH server is not running. Click “Start server” to launch one.",
  serverStopped: "The DSH server has been stopped.",
  reconnecting: "Connecting…",
  reconnectStopped: "Stopped connecting. Click “Connect” to try again.",
  enterToken: "Enter token",
  authNeedsToken:
    "The external DSH server requires an access token: click “Enter token” and paste the token printed by dsh web (or run “DSH: Enter Access Token” from the Command Palette).",
  authTokenRejected:
    "The server requires authentication and the token obtained automatically was rejected. Restart it with “DSH: Restart Server” from the Command Palette.",
  connectionLost: "Lost the connection to the server; reconnecting…",
  serverSpawnFailed: (detail) => `Could not start the dsh process: ${detail}`,
  serverNotReady:
    "The background server did not become ready (the rendezvous file has no address or token yet). Try “Restart Server”, or check the logs.",
  serverUnreachable: (baseUrl) =>
    `Cannot reach ${baseUrl} yet (retrying until it answers or you click “Stop connecting”). Make sure dsh web is running there.`,
  serverLogTail: (tail) => `Log tail:\n${tail}`,
  sharedRestarted: "This window took over the shared server and restarted it; the other windows reconnect automatically.",

  searchSessions: "Search past sessions",
  today: "Today",
  earlier: "Earlier",
  noSessions: "No past sessions yet",
  untitled: "Untitled chat",
  runningTag: "running",
  forkedTitle: (title) => `Fork: ${title}`,
  archive: "Archive (move out of workspace list)",
  archiveList: "Archived sessions",
  deleteSession: "Delete (remove local log files)",
  deleteSessionConfirm: "Click again to confirm",
  noArchivedSessions: "No archived sessions",

  contextUsed: (percent, used, total) => `Context used ${percent}% (${used} / ${total})`,
  ctxDetailCached: "Cache hit",
  ctxDetailSystem: "System prompt",
  ctxDetailTools: "Tool definitions",
  ctxDetailMessages: "Conversation messages",
  statsLlmTime: "LLM time",
  statsToolTime: "Tool time",
  statsTtft: "Avg time to first token (TTFT)",
  statsSpeed: "Average tokens per second (TPS)",
  statsTitle: "Session stats (whole log)",
  markdownFootnotes: "Footnotes",
  turnFailed: "This turn failed",
  interrupted: "This turn was interrupted",
  compacted: "Context compacted",
  llmRetry: (attempt, max) => `The model call failed; retrying (attempt ${attempt} of ${max})`,
  llmRetryAlways: (attempt) => `The model call failed; retrying (attempt ${attempt})`,
  imagePathsInserted: (count, model) =>
    `Model "${model}" does not accept image input; inserted ${count} path(s) into the box`,
  queueAttachmentsLost: "Attachments could not be restored; please re-attach them (text is back in the box)",
  queueContentLost: "Could not restore the queued message; only the current turn was stopped",
  queueDispatchFailed: "The queued message could not be sent; its content is back in the box",
  unknownEvent: (type) => `Skipped an event this client does not understand: "${type}".`,
  toolRead: "Read",
  toolWrite: "Write",
  toolEdit: "Edit",
  toolRun: "Run",
  toolSearch: "Search",
  toolPwsh: "Pwsh",
  toolReadImage: "Read image",
  toolInspect: "Inspect plugin",
  toolRunCordis: "Run plugin",
  toolStopCordis: "Stop plugin",
  toolRemoveCordis: "Remove plugin",
  toolGeneric: "Tool call",
  toolCode: "Code",
  toolExitCode: (code) => `exit code ${code}`,
  toolSignal: (signal) => `killed by signal ${signal}`,
  toolImageAlt: "Image returned by the tool",
  messageImageAlt: "Image in the message",
  imagePreview: "View original",
  imagePreviewClose: "Close original image preview",
  imageLoadFailed: "Image failed to load",
  toolInput: "IN",
  toolOutput: "OUT",
  unknownBlock: "Unknown content block",
  contextInstructions: "Context instructions",
  contextAdded: "Added",
  contextUpdated: "Updated",
  contextRemoved: "Removed",
  contextCatalogReplaced: "Catalog replaced",
  contextCatalogMore: (count) => `…and ${count} more`,
  contextSnapshotSupersedes: "Supersedes the previous snapshot",
  contextRelayFrom: (session) => `From session ${session}`,
  contextRecallCounts: (retained, omitted) => `${retained} kept · ${omitted} omitted`,
  contextRecallTruncated: "Truncated",
  toolCollapse: "Collapse",
  readWindow: (shown, total) => `Showing ${shown} of ${total} lines`,
  readExpandRest: (count) => `… ${count} more lines`,
  readExpandAria: (count) => `Expand ${count} more lines`,
  readCollapseAria: "Collapse content",
  searchPaths: (shown) => `${shown} paths`,
  searchPathsTruncated: (shown, total) => `Showing ${shown} of ${total} paths`,
  searchMatches: (shown, files) => `${shown} matches · ${files} files`,
  searchMatchesTruncated: (shown, total, files) => `Showing ${shown} of ${total} matches · ${files} files`,
  searchNoResults: "No results",
  searchExpandAria: (count) => `Expand ${count} more result lines`,
  searchCollapseAria: "Collapse results",
  searchExpandRest: (count) => `… ${count} more lines`,
  webNoResults: "No results found",
  webSourcesTruncated: "Source list truncated",
  webHttp: "HTTP",
  webContentTruncated: "Content truncated",
  terminalRunning: "Running",
  terminalDone: "Done",
  terminalFailed: "Failed",
  terminalNoOutput: "No output",
  toolTodoTitle: "Update to-do list",
  toolTodoProgress: (done, total) => `${done}/${total} completed`,
  maxTokens: "Output token limit reached; the answer was truncated. Send “continue” to resume.",

  branchFromHere: "Branch from here",
  branchFailed: "Could not create the branch",
  branchCreated: (title) => `Branch created: ${title}`,
  branchNoAnchor: "No branch anchor for this message yet (the turn has not finished)",
  branchRunning: "Cannot branch while generating",
  historyMore: "Load all history",
  historyLoading: "Loading all history…",
  jumpToLatest: "Jump to latest",
  historyBusy: "Cannot load history while generating — wait for this turn to finish",
  userMessageExpand: "Expand",
  userMessageCollapse: "Collapse",
  sendQueue: "Queue message",
  sendSteer: "Send as steer",
  queueSteer: "Send as steer",
  queueSteerUnavailable: "Steering is only available while the agent is running",


  toolRunning: "Running · {duration} elapsed",
  toolRunningHint: "Output appears once the call finishes",
};

const DICTIONARIES: Record<Locale, Texts> = { zh, en };

/** 把 VS Code 的语言标识归一化成我们支持的两种。 */
export function normalizeLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const TextsContext = createContext<Texts>(en);

export function useTexts(): Texts {
  return useContext(TextsContext);
}

export function dictionaryFor(locale: Locale): Texts {
  return DICTIONARIES[locale];
}

/** 极简占位符替换：`{n}`。 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * 宿主用 `@key` / `@key:arg` 这种语言中立的标记传递文案，
 * 由界面按当前语言翻译；不以 `@` 开头的文本（如模型原始报错）原样显示。
 *
 * 连接失败条的说明是**多行**拼接的（原因 + 遗留锁提示 + 服务器日志尾部），
 * 所以按行解析：每一行各自是一个标记，不认识的 key 原样保留——这样宿主
 * 拼进日志原文也不会被误伤。
 */
export function resolveText(text: string, texts: Texts): string {
  if (!text.includes("@")) return text;
  return text
    .split("\n")
    .map((line) => resolveMarker(line, texts))
    .join("\n");
}

function resolveMarker(text: string, texts: Texts): string {
  if (!text.startsWith("@")) return text;
  const [key, ...rest] = text.slice(1).split(":");
  const arg = rest.join(":");
  switch (key) {
    case "turnFailed":
      return texts.turnFailed;
    case "interrupted":
      return texts.interrupted;
    case "stopped":
      return texts.stopped;
    case "compacted":
      return texts.compacted;
    case "llmRetryAlways":
      return texts.llmRetryAlways(Number(arg));
    case "llmRetry": {
      // 参数形如 `<第几次>:<共几次>`
      const separator = arg.indexOf(":");
      const attempt = Number(separator < 0 ? arg : arg.slice(0, separator));
      const max = Number(separator < 0 ? "" : arg.slice(separator + 1));
      return texts.llmRetry(attempt, max);
    }
    case "maxTokens":
      return texts.maxTokens;
    case "openInBrowserOffline":
      return texts.openInBrowserOffline;
    case "openInBrowserFailed":
      return texts.openInBrowserFailed;
    case "queueAttachmentsLost":
      return texts.queueAttachmentsLost;
    case "chipFileDeleted":
      return texts.chipFileDeleted;
    case "chipPathUnresolved":
      return texts.chipPathUnresolved;
    case "dropUnreadable":
      return texts.dropUnreadable(arg);
    case "dropTooLarge":
      return texts.dropTooLarge(arg);
    case "imageTooLarge":
      return texts.imageTooLarge(arg);
    case "queueContentLost":
      return texts.queueContentLost;
    case "queueDispatchFailed":
      return texts.queueDispatchFailed;
    case "uploadNoSession":
      return texts.uploadNoSession;
    case "historyBusy":
      return texts.historyBusy;
    case "branchNoAnchor":
      return texts.branchNoAnchor;
    case "branchFailed":
      return texts.branchFailed;
    case "branchCreated":
      return texts.branchCreated(arg);
    case "unknownEvent":
      return texts.unknownEvent(arg);
    case "unknownCommand":
      return texts.unknownCommand(arg);
    case "commandFailed":
      return texts.commandDispatchFailed(arg);
    case "callId":
      return texts.callId(arg);
    case "toolGeneric":
      return texts.toolGeneric;
    case "connectionLost":
      return texts.connectionLost;
    case "serverNotRunning":
      return texts.serverNotRunning;
    case "serverStopped":
      return texts.serverStopped;
    case "authNeedsToken":
      return texts.authNeedsToken;
    case "authTokenRejected":
      return texts.authTokenRejected;
    case "serverSpawnFailed":
      return texts.serverSpawnFailed(arg);
    case "serverUnreachable":
      return texts.serverUnreachable(arg);
    case "serverLogTail":
      return texts.serverLogTail(arg);
    case "serverNotReady":
      return texts.serverNotReady;
    case "sharedRestarted":
      return texts.sharedRestarted;
    case "uploadIncomplete": {
      // 参数形如 `<个数>:<文件名预览>`：个数在前，文件名里可能含冒号，所以按第一段切
      const separator = arg.indexOf(":");
      const count = Number(separator < 0 ? arg : arg.slice(0, separator));
      const names = separator < 0 ? "" : arg.slice(separator + 1);
      return texts.uploadIncomplete(names, Number.isFinite(count) ? count : 0);
    }
    case "imagePathsInserted": {
      // 参数形如 `<张数>:<模型名>`：张数在前，模型名里可能含冒号，所以按第一段切
      const separator = arg.indexOf(":");
      const count = Number(separator < 0 ? arg : arg.slice(0, separator));
      const model = separator < 0 ? "" : arg.slice(separator + 1);
      return texts.imagePathsInserted(Number.isFinite(count) ? count : 0, model);
    }
    default:
      return text;
  }
}
