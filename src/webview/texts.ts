import { createContext, useContext } from "react";
import { asMessageTable, MESSAGES } from "./messages";
import type { Marker } from "./messages";

/**
 * 界面文案：跟随 VS Code 显示语言。
 *
 * 宿主把语言标识放进 state，webview 用它选词典。只做中英两套；
 * 其余语言一律回落英文（而不是显示中文），避免出现半截翻译。
 *
 * **文案本体在 `messages.ts` 的唯一一份消息表里**（以 `@key` 标记为键，每条自带
 * 中英两份）。本文件只做三件事：
 * 1. `Texts`——给「视图字段名 → 文案」定形的接口（下面逐个成员带注释）；
 * 2. 由消息表派生出 zh / en 两份字典；
 * 3. `resolveText()`——查表 + 按冒号拆参数（宿主发来的 `@key` / `@key:arg`）。
 *
 * 于是「加一条用户可见文案」从前要改的 4 处（接口 / zh / en / switch）收成**一条**：
 * 在 `messages.ts` 的表里加一条。带参数的登记成函数、不带参数的登记成字符串，
 * 所以「把裸字符串当函数调用」由 `tsc` 拦住。
 */

export type Locale = "zh" | "en";

/**
 * 界面词典的形状（**键名即消息表的键名**，`scripts/i18n.test.ts` 逐个核对）。
 *
 * 这里是文档与契约：每个成员在哪个界面出现、带什么参数。文案的**取值**不写在这里，
 * 写 `messages.ts`；`dictionaryFor()` 的返回值按本接口收窄，所以
 * `dictionaryFor("zh").copied` 这类调用点编译期仍然受约束（缺键直接报错）。
 */
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

  /** 空态页：点目录那一行的 title（可以改，点了弹系统目录选择器）。 */
  workspaceChange: string;
  /** 空态页：还没选过目录时的 title（点了弹系统目录选择器）。 */
  workspaceChoose: string;
  /** 空态页：没打开文件夹也没选目录时的占位文案。 */
  workspaceNone: string;
  /** 空态页：目录那一行不可改时的 title（跟随 VS Code 打开的文件夹）。 */
  workspaceLocked: string;
  /** 预设下拉框的分组标题。 */
  agentPresetLabel: string;
  /** 预设胶囊的 title（官方 `seatHint` 同一句话）。 */
  agentPresetSeat: string;
  /** 工具栏那枚只读预设标签的 title（带预设名）。 */
  agentPresetRunning: (name: string) => string;
  /** 预设没有发布描述时那一行的替代文案。 */
  agentPresetNoDescription: string;
  /** 切换预设被拒（`@key` 标记，宿主发）。 */
  agentPresetFailed: (reason: string) => string;
  /**
   * 随产品交付的四个预设的展示名与描述（逐字抄官方，见 `presetDisplay.ts`）。
   * 用户自己写的预设名不走这里。
   */
  presetStandardName: string;
  presetStandardDescription: string;
  presetPtcName: string;
  presetPtcDescription: string;
  presetMinimalName: string;
  presetMinimalDescription: string;
  presetCordisName: string;
  presetCordisDescription: string;

  placeholderFirst: string;
  placeholderFollowUp: string;
  send: string;
  sendTitle: string;
  stopTitle: string;
  thinkingDepth: string;
  /** 模型按钮的悬停提示（动作口径）：「思考深度」是右侧思考强度胶囊的。 */
  selectModel: string;
  models: string;
  defaultModel: string;
  noModels: string;
  /** 通用附件按钮（图片与普通文件同一入口）。 */
  attachFile: string;
  /** `@` 列表里目录行右侧的按钮：把整个目录作为引用载入。 */
  attachFolder: string;
  cancel: string;
  remove: string;
  /** 抽屉标题栏的「关闭」（此前是写死的中文，双语规则不允许）。 */
  close: string;

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
  /** 改动文件卡片的标题（参数是 Host 报的完整文件数，可能大于卡片铺出来的行数）。 */
  changesCardTitle: (files: number) => string;
  /** 改动行 / 卡片标题右侧的**新增**行数（`+N`，界面上走绿色）。 */
  changesCardAdded: (added: number) => string;
  /** 改动行 / 卡片标题右侧的**删除**行数（`−N`，界面上走红色）。 */
  changesCardDeleted: (deleted: number) => string;
  /** 二进制文件（Host 没有行数）的替代文案。 */
  changesCardBinary: string;
  /** 超过 Host 捕获上限、没有对比的文件。 */
  changesCardOversized: string;
  /** 卡片折叠后「展开其余 N 个文件」的按钮文案。 */
  changesCardMore: (count: number) => string;
  /** 卡片「展开全部」按钮的无障碍标题。 */
  changesCardExpandAria: (count: number) => string;
  /** 卡片「收起」按钮的无障碍标题。 */
  changesCardCollapseAria: string;
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
  /** 同一条降级文案，但**知道是哪一张**：参数是引用原文（本地路径或远程 URL）。 */
  imageLoadFailedAt: (path: string) => string;
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

  /**
   * 子代理导航（标题右侧，官方 `dsh-client-ui-subagent` 同款）。
   *
   * `subagents` 是触发器的 title；`subagentCount` 是计数触发器上的文字（含个数）；
   * `subagentChildren` 是切换下拉里「本级子代理」那一节的标题；`backToParent` /
   * `subagentSwitcher` 是面包屑两半的 title；`subagentReadonly*` 是一次性子代理
   * 的只读说明（替代整个输入区）。
   */
  subagents: string;
  subagentCount: (count: number) => string;
  subagentChildren: string;
  backToParent: (title: string) => string;
  subagentSwitcher: (title: string) => string;
  subagentReadonlyTitle: string;
  subagentReadonlyBody: string;
  subagentOneShot: string;
  subagentContinuable: string;
  /** 「现在不在跑」的子代理：读作**已完成**（用户 2026-09-19 口径），不再读作「未运行」。 */
  subagentCompleted: string;
  /** 点了目录里已经不在的那条子代理（列表一闪而过时的兜底）。 */
  subagentNotFound: string;
  /** 子代理会话不收文件附件（官方硬规则）：去掉文件芯片再发。 */
  subagentFilesUnsupported: string;
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
  /** 展开 / 收起一行的无障碍标签（带任务标签）。 */
  jobExpandAria: (label: string) => string;
  jobCollapseAria: (label: string) => string;
  /** 输出开头丢了（环头被淘汰 / 续传有洞 / 超出显示上限截断）。 */
  jobOutputGap: string;
  /** 观察流中断：`detail` 是原样报错。 */
  jobOutputError: (detail: string) => string;
  /** 连流都没能开（没连接 / 没有绑定会话）。 */
  jobOutputUnavailable: string;
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
  /**
   * 菜单空着、而且原因是**这个窗口还没有工作目录**时的说明（空态下 `/` 与 `@` 都是
   * 会话作用域的服务端目录，没有目录就没有候选）。见 `messages.ts` 同名条目。
   */
  menuNoWorkspace: string;
  /**
   * `/` 命令菜单底部的键位提示：与 `mentionHint` 同一套写法，**去掉 Tab**
   * （命令候选是平铺列表，没有可进入的目录）。见 `messages.ts` 同名条目。
   */
  commandHint: string;
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
  /**
   * 队列行行首的「这条带附件」标记（`[含附件]`）。见 `messages.ts` 同名条目。
   */
  queueHasAttachment: string;
  /**
   * 发送失败那一行上的两个动作（用户 2026-09-25 口径）。
   *
   * 「重发」= 先删掉这一行再按普通发送重走一遍；「撤回」= 只删掉这一行（不把正文
   * 塞回输入框）。失败原因跟在它们后面，见 `sendFailed` 那几个宿主标记。
   */
  resend: string;
  retract: string;
  /** 宿主发来的失败原因（`@sendFailed:<detail>`）。 */
  sendFailed: (detail: string) => string;
  /** 连不上 DSH，什么都没发出去。 */
  sendNoConnection: string;
  /** 没有可发送的内容（附件表示不出来、又没有正文）。 */
  sendEmpty: string;
  /** 会话已关 / 连接断了，始终没收到服务端确认。 */
  sendUnconfirmed: string;
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
   * 待答卡上的「放弃整组问题」（官方 `nav.cancel` 逐字）：点了不是回答，宿主回
   * `rejected` + `ASK_CANCELLED` 把整份等待收场（见 `Rows.tsx` 的 `dismiss`）。
   */
  questionDismissAll: string;
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
  /** 正文右键菜单第二项：把选中文字以引用块插进输入框（引用自己占整行）。 */
  quoteSelection: string;
  /** 复制图片失败（跨域图污染画布 / 剪贴板写不进去）——界面自产的提示。 */
  imageCopyFailed: string;
  /** 图片右键菜单第二项：另存到用户选的路径（宿主弹保存对话框）。 */
  imageSave: string;
  /** 保存图片失败（字节取不回来 / 写盘失败）。宿主发出。 */
  imageSaveFailed: string;
  stopped: string;

  connecting: string;
  connectionFailed: string;
  /** 连接条按钮：用户显式拉起一套**内部**后台（内部不存在时的主动作）。 */
  startInternal: string;
  /** 连接条按钮：接上**已经在跑**的内部后台（不负责拉起）。 */
  connectInternal: string;
  /** 连接条按钮：连 `dshChat.url` 那个备用地址。 */
  connectExternal: string;
  /** 连接条按钮：让守护进程把内部 dsh 重起一个（外部目标没有"重启"可言）。 */
  restartInternal: string;
  /** 「连接外部 DSH」置灰时的悬停提示（没配 `dshChat.url`）。 */
  externalDisabledHint: string;
  /** 连接条：正在**拉起**一套内部后台。 */
  startingInternal: string;
  /** 连接条：正在连已经在跑的内部后台。 */
  connectingInternal: string;
  /** 连接条：正在连外部备用地址（带地址）。 */
  connectingExternal: (baseUrl: string) => string;
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
  /**
   * 连接条（按钮态）的**两轴**状态短语：左轴内部、右轴外部，拼成
   * 「内部 DSH：未运行 · 外部 DSH：可达」这样一行（见 `App.tsx` 的 `ConnectionBar`）。
   */
  statusInternalRunning: string;
  statusInternalNotRunning: string;
  statusExternalReachable: string;
  statusExternalUnreachable: string;
  statusExternalUnconfigured: string;
  /** 两轴之间的分隔符（中英都是 ` · `）。 */
  statusSeparator: string;
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
  /** 排队消息没能发出时的提示（两种收场各自在界面上看得见，见 messages.ts 的同名条目）。 */
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
  /** 「回到最新」胶囊：脱贴后内容继续增长时的兜底入口（点击回底并恢复贴底）。 */
  jumpToLatest: string;
  /** 右侧轮次横条：整条导航的 aria 标签（官方 chat.turnNavigation.label）。 */
  turnRailLabel: string;
  /** 轮次横条的刻度：跳到第 {turn} 轮（已加载，官方 chat.turnNavigation.jump）。 */
  turnRailJump: (turn: number) => string;
  /** 轮次横条的刻度：先取历史再跳到第 {turn} 轮（窗口外，官方 chat.turnNavigation.jumpLoad）。 */
  turnRailJumpLoad: (turn: number) => string;
  /** 轮次横条的预览卡：没有提示词可预览时的兜底标题（官方 chat.turnNavigation.turn）。 */
  turnRailTurn: (turn: number) => string;
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

  /** 后台任务停止按钮（两段式，官方 `kill.*` 同口径） */
  /** 正常档的悬停说明，带上任务名（官方 `kill.stop`）。 */
  jobStopTitle: (label: string) => string;
  /** `armed` 档的悬停说明：第一下已按，等第二次确认。 */
  jobStopConfirm: string;
  /** `armed` 档按钮上亮出的文字（官方 `kill.confirmAction`）。 */
  jobStopConfirmAction: string;
  /** 请求没被受理时短暂亮出的一档（官方 `kill.failed`）。 */
  jobStopFailed: string;

  /** 设置：字体大小。 */

  /** 设置：界面语言。 */
  /** 运行中的工具行展开后：`运行中 · 已用 {duration}`。 */
  toolRunning: string;
  /** 运行中的工具行展开后：说明为什么现在还没有输出。 */
  toolRunningHint: string;
}

/**
 * 由消息表派生一份词典：把每条消息的对应语言取出来（函数原样引用，不包一层，
 * 保住参数类型与 `Function.length`）。
 *
 * 返回值按 `Texts` 收窄，所以 `dictionaryFor("zh").xxx` 的调用点编译期仍然受约束。
 * 表与接口的一致性由 `scripts/i18n.test.ts` 断言：**键集合必须一致**——表里多一个
 * `Texts` 没登记的键，或者接口比表多写了一个键（界面上就会显示裸 key），都在那里
 * 报出来；成员类型也对了一遍（导出类型，没有运行时开销）。
 */
function derive(locale: Locale): Texts {
  const out: Record<string, string | ((...args: never[]) => string)> = {};
  for (const key of Object.keys(MESSAGES) as Marker[]) {
    out[key] = MESSAGES[key][locale];
  }
  return out as unknown as Texts;
}

const zh: Texts = derive("zh");
const en: Texts = derive("en");

/** 表的「契约视角」：读 `argParts` / `swapArgs` 这类可选元数据时用它。 */
const TABLE = asMessageTable(MESSAGES);

const DICTIONARIES: Record<Locale, Texts> = { zh, en };

/** 把 VS Code 的语言标识归一化成我们支持的两种。 */
export function normalizeLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const TextsContext = createContext<Texts>(en);

export function useTexts(): Texts {
  return useContext(TextsContext);
}

/**
 * 当前界面语言（宿主下发的 `state.locale`，如 `zh-cn` / `en`）。
 *
 * 词典本身已经按语言分好，所以绝大多数地方用 `useTexts()` 就够；需要**按语言取一条**
 * 而不是查词典的地方才用它——服务端给的本地化文案（审批的 `displayReason`）属于这一类，
 * 它不在我们的词典里，得在渲染时按语言挑（见 `shared/localizedText.ts`）。
 * 挂在 `TextsContext` 里会让所有 `useTexts()` 调用点的类型都变，所以单独一个 context。
 */
export const LocaleContext = createContext<string | undefined>(undefined);

export function useLocale(): string | undefined {
  return useContext(LocaleContext);
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
 *
 * 解析口径（**不许改**，宿主按这套口径拼参数）：
 * - `text.slice(1).split(":")`：冒号只切第一段当 key，其余**全部**是参数
 *   （参数里含冒号不会被截断，例如 Windows 路径 `C:\tools\dsh\bin`）；
 * - 表里标了 `argParts: 2` 的三条（`llmRetry` 的「第几次:共几次」、
 *   `uploadIncomplete` 的「个数:文件名预览」、`imagePathsInserted` 的「张数:模型名」）
 *   再按参数串里的**第一段**冒号切一次，切法与从前的 `switch` 逐字一致；
 * - `@key`（没有冒号）时参数串为空串：`Number("")` = 0、
 *   `Number.isFinite(count) ? count : 0` 这两条缺参兜底照旧。
 */
export function resolveText(text: string, texts: Texts): string {
  if (!text.includes("@")) return text;
  return text
    .split("\n")
    .map((line) => resolveMarker(line, texts))
    .join("\n");
}

/**
 * 查表解析一行标记：**表就是那唯一一份登记**（从前这里是一个 37 个 `case` 的长
 * `switch`，加一条文案要在这台机器上再抄一遍）。
 *
 * 「不认识的 `@` 文本原样透传」靠 `text` 兜底：不在表里（或表里那条被删了）就
 * 原样返回——模型 / 服务端的原始报错就是这类。
 *
 * **切参数的口径与从前的 switch 逐字一致**（`text.slice(1).split(":")` 后，
 * `parts[0]` 是 key、`parts.slice(1).join(":")` 是参数串 `arg`）：
 * - 缺省：`arg` 整段给第一个形参（`@serverLogTail:a:b` 这种含冒号的原文不被截断）；
 * - 表里标了 `argParts: 2` 的那三条（`llmRetry` / `uploadIncomplete` /
 *   `imagePathsInserted`）按 **`arg` 里的第一段冒号**再切一次，与从前逐字相同；
 * - `@key`（没有冒号）时 `arg` = ""：`Number("")` = 0、
 *   `Number.isFinite(count) ? count : 0` 这两条缺参兜底照旧（`".indexOf(":")` = -1）。
 */
function resolveMarker(text: string, texts: Texts): string {
  if (!text.startsWith("@")) return text;
  // 与从前 `text.slice(1).split(":")` 同一口径：冒号只切第一段当 key
  const parts = text.slice(1).split(":");
  const key = parts[0];
  if (!Object.hasOwn(MESSAGES, key)) return text;
  const entry = TABLE[key as Marker];
  const message = entry[localeKey(texts)];
  // 带参数的登记成函数、不带参数的登记成字符串：字符串那支直接返回
  // （「裸字符串当函数调用」由这张表的结构拦住）。
  if (typeof message === "string") return message;
  // 参数串 = 第一段冒号之后的**全部**内容（`@key` / `@key:` 都是 ""）。
  // 含冒号的原文整段保留，所以 Windows 路径这类参数不会被截断。
  const arg = parts.length > 1 ? parts.slice(1).join(":") : "";
  const separator = arg.indexOf(":");
  // 两个参数时按 `arg` 的第一段冒号切（个数/张数在前，文件名/模型名在后），
  // 再按表里声明的 `swapArgs` 对调成函数的形参顺序。
  const parsed =
    entry.argParts === 2
      ? [arg.slice(0, separator < 0 ? undefined : separator), separator < 0 ? "" : arg.slice(separator + 1)]
      : [arg];
  if (entry.swapArgs) parsed.reverse();
  // 数字形参（`llmRetry` 的「第几次 / 共几次」等）在这里转：
  // 从前那几条 `case` 里各自写的 `Number(...)` / `Number.isFinite(c) ? c : 0`
  // 就在这个位置，逐条对应见 `NUMERIC_ARG`。
  const args = convertArgs(key as Marker, parsed);
  // 逐支调用：形态与从前的 `texts.xxx(a)` / `texts.xxx(a, b)` 一一对应。
  return (message as MessageFn)(args[0], args[1]);
}

/**
 * 哪些标记的形参是**数字**，以及要不要走 `Number.isFinite(c) ? c : 0` 那条兜底。
 *
 * 这是「结构声明」而不是文案：从前它散在 `resolveText` 的几个 `case` 里
 * （`Number(arg)` 与 `Number.isFinite(count) ? count : 0` 两种写法）。
 */
const NUMERIC_ARG: Partial<Record<Marker, readonly ("string" | "number" | "finite")[]>> = {
  llmRetry: ["number", "number"], // 从前 `Number(attempt)` / `Number(max)`
  llmRetryAlways: ["number"],
  uploadIncomplete: ["string", "finite"], // 形参顺序是 (names, count)
  imagePathsInserted: ["finite", "string"], // 形参顺序是 (count, model)
};

/** 按 `NUMERIC_ARG` 把字符串参数转成数字（缺参时 `Number("")` = 0，与从前一致）。 */
function convertArgs(key: Marker, parsed: string[]): unknown[] {
  const plan = NUMERIC_ARG[key];
  if (!plan) return parsed;
  return plan.map((rule, index) => {
    if (rule === "string") return parsed[index];
    const number = Number(parsed[index]);
    return rule === "finite" && !Number.isFinite(number) ? 0 : number;
  });
}

/**
 * 带参数的文案在表里的登记形态：`(参数…) => string`。
 *
 * 调用点传进去的是宿主发来的字符串，而各条形参有的收字符串、有的收数字
 * （`llmRetry` 的「第几次 / 共几次」），所以**转换由 `NUMERIC_ARG` / `argParts` /
 * `swapArgs` 声明**、由 `resolveMarker` 完成；这里的 `any` 就是「按那几个声明摆好
 * 位置后调用」的落点——它不做逐参数类型检查，**表本身**的形参类型才是契约
 * （`Texts` 接口由表派生，写错类型在 `messages.ts` 那一行就会报错）。
 */
type MessageFn = (first?: any, second?: any) => string;

/** `Texts` 本身不带语言标识，而解析只能查表——用引用相等认出是哪一本词典。 */
function localeKey(texts: Texts): Locale {
  return texts === zh ? "zh" : "en";
}
