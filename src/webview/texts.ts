import { createContext, useContext } from "react";

/**
 * 界面文案：跟随 VS Code 显示语言。
 *
 * 宿主把语言标识放进 state，webview 用它选词典。只做中英两套；
 * 其余语言一律回落英文（而不是显示中文），避免出现半截翻译。
 */

export type Locale = "zh" | "en";

export interface Texts {
  brand: string;
  newChat: string;
  history: string;
  openInEditor: string;
  settings: string;

  emptyTitle: string;
  emptyHint: string;

  placeholderFirst: string;
  placeholderFollowUp: string;
  send: string;
  sendTitle: string;
  stop: string;
  stopTitle: string;
  mode: string;
  modeAgent: string;
  modePlan: string;
  thinkingDepth: string;
  models: string;
  defaultModel: string;
  noModels: string;
  /** 通用附件按钮（图片与普通文件同一入口）。 */
  attachFile: string;
  attachFolder: string;
  cancel: string;
  toggleThinking: string;
  remove: string;

  permission: string;
  permReadOnly: string;
  permReadOnlyDesc: string;
  permWorkspaceWrite: string;
  permWorkspaceWriteDesc: string;
  permFullAccess: string;
  permFullAccessDesc: string;
  permConfirmTitle: string;
  permConfirmBody: string;
  permConfirmAck: string;
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
  /** 文件芯片的悬停说明：默认看改动、按住修饰键直接打开文件。 */
  openChangesHint: string;
  /** 文件芯片行「展开全部」按钮的无障碍标题。 */
  filesExpandAria: (count: number) => string;
  /** 文件芯片行展开后的「收起」文案。 */
  filesCollapse: string;
  /** 文件芯片行「收起」的无障碍标题。 */
  filesCollapseAria: string;

  /** 子代理面板 */
  subagents: string;
  subagentsEmpty: string;
  subagentOneShot: string;
  subagentContinuable: string;
  subagentInactive: string;
  /** 轨迹面板 */
  trajectory: string;
  trajectoryEmpty: string;
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
  uploadFailed: string;
  /** 有附件没上传成功、发送时被跳过（文件名预览 + 总个数）。 */
  uploadIncomplete: (names: string, count: number) => string;
  /** 还没有会话（连不上服务器），附件传不上去。 */
  uploadNoSession: string;
  /** @ 提及 */
  mentionFiles: string;
  mentionEmpty: string;
  mentionHint: string;
  /** 设置面板 */
  settingsTitle: string;
  settingsLoading: string;
  settingsEmpty: string;
  settingsRestart: string;
  settingsReset: string;
  settingsResetDone: string;
  /** 字段被用户层覆盖过的标记。 */
  settingsOverridden: string;
  settingsSaved: string;
  settingsSecretSet: string;
  settingsSecretUnset: string;
  settingsSave: string;
  settingsAdvanced: string;
  settingsNoDocument: string;
  settingsNamespace: (ns: string) => string;

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
  injectedPlugin: string;
  injectedGeneric: string;
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

  copy: string;
  copied: string;
  insertToEditor: string;
  openFile: string;
  stopped: string;

  connecting: string;
  connectionFailed: string;
  reconnect: string;
  restartServer: string;
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
  /** 连接失败条：dsh web 进程退出（退出码 / 信号，取不到时是 `?`）。 */
  serverExited: (code: string, signal: string) => string;
  /** 连接失败条：等 dsh web 就绪超时（秒数）。 */
  serverStartTimeout: (seconds: number) => string;
  /** 连接失败条：该地址上连不上 dsh web（地址）。 */
  serverUnreachable: (baseUrl: string) => string;
  /** 连接失败条：崩溃遗留的 writer 锁（锁文件路径）。 */
  serverStaleLock: (lockPath: string) => string;
  /** 连接失败条末段：服务器日志尾部（原文照贴，不翻译）。 */
  serverLogTail: (tail: string) => string;

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
  toolGlob: string;
  toolWeb: string;
  toolTodo: string;
  toolDelegate: string;
  toolPresent: string;
  /** 官方 `TOOL_TITLE_KEYS` 里各工具的**自有标题**（不套用变体名）。 */
  toolPwsh: string;
  toolReadImage: string;
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
  toolStatusRunning: string;
  /** 已停止（官方 `row.stopped`：中断，不是失败）。 */
  toolStatusStopped: string;
  /** 失败（官方 `row.failed`）。 */
  toolStatusFailed: string;
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
  branchTag: string;
  /** 历史：加载更早的一页（跟随窗口只有 60 条）。 */
  historyMore: string;
  /** 生成中不能翻历史（重折会让流式正文重来）。 */
  historyBusy: string;

  /** 设置：字体大小。 */
  fontSize: string;
  fontSizeDesc: string;

  /** 设置：界面语言。 */
  language: string;
  languageDesc: string;
  languageAuto: string;
  languageZh: string;
  languageEn: string;
  /** 运行中的工具行展开后：`运行中 · 已用 {duration}`。 */
  toolRunning: string;
  /** 运行中的工具行展开后：说明为什么现在还没有输出。 */
  toolRunningHint: string;
}

const zh: Texts = {
  brand: "DSH",
  newChat: "新建对话",
  history: "历史对话",
  openInEditor: "在编辑器中打开",
  settings: "设置",

  emptyTitle: "有什么可以帮你？",
  emptyHint: "用 @ 添加文件或选区作为上下文；Shift+Enter 换行。",

  placeholderFirst: "问点什么，或用 @ 添加上下文",
  placeholderFollowUp: "继续追问…",
  send: "发送",
  sendTitle: "发送（Enter）",
  stop: "停止",
  stopTitle: "停止生成",
  mode: "模式与权限",
  modeAgent: "Agent",
  modePlan: "Plan",
  thinkingDepth: "思考深度",
  models: "模型",
  defaultModel: "默认模型",
  noModels: "未获取到模型目录",
  attachFile: "添加文件",
  attachFolder: "整个目录",
  cancel: "取消",
  toggleThinking: "切换思考深度",
  remove: "移除",

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
  permConfirmAck: "我已了解风险，并愿意继续",
  permConfirmEnable: "启用完全权限",
  enterPlanMode: "进入计划模式",
  exitPlanMode: "退出计划模式",

  goalActive: "进行中的目标",
  goalPaused: "已暂停的目标",
  goalBlocked: "受阻的目标",
  goalPause: "暂停目标",
  goalResume: "恢复目标",
  goalClear: "清除目标",

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

  subagents: "子代理",
  subagentsEmpty: "当前会话没有子代理",
  subagentOneShot: "一次性",
  subagentContinuable: "可继续",
  subagentInactive: "已结束",
  trajectory: "轨迹",
  trajectoryEmpty: "本会话还没有工具调用",
  jobs: "后台任务",
  jobsEmpty: "当前会话没有后台任务",
  jobRunning: "运行中",
  jobStopping: "停止中",
  jobCompleted: "已完成",
  jobKilled: "已终止",
  jobFailed: "失败",
  commands: "命令",
  commandsEmpty: "没有可用命令",
  skillTag: "技能",
  uploadFailed: "上传失败，点击重试",
  uploadIncomplete: (names, count) =>
    `有 ${count} 个文件没能上传（${names}），本次只发送了就绪的附件`,
  uploadNoSession: "还没有连上服务器，附件传不上去",
  mentionFiles: "文件",
  mentionEmpty: "没有匹配的文件",
  mentionHint: "↑↓ 选择 · Enter 确认 · Esc 取消",
  settingsTitle: "设置",
  settingsLoading: "正在读取设置…",
  settingsEmpty: "服务器没有返回可配置项",
  settingsRestart: "需重启生效",
  settingsReset: "重置本组",
  settingsResetDone: "已重置为默认值",
  settingsOverridden: "已修改",
  settingsSaved: "已保存",
  settingsSecretSet: "已配置",
  settingsSecretUnset: "未配置",
  settingsSave: "保存",
  settingsAdvanced: "高级（JSON）",
  settingsNoDocument: "服务器未启用设置文档，只读展示",
  settingsNamespace: (ns) => `命名空间 ${ns}`,

  running: "生成中",
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
  injectedPlugin: "插件上下文",
  injectedGeneric: "自动载入",
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

  copy: "复制",
  copied: "已复制到剪贴板",
  insertToEditor: "插入到当前编辑器",
  openFile: "打开文件",
  stopped: "已停止",

  connecting: "正在连接…",
  connectionFailed: "无法连接 DSH 服务器",
  reconnect: "重新连接",
  restartServer: "重启服务器",
  enterToken: "输入令牌",
  authNeedsToken:
    "外部 DSH 服务器需要访问令牌：请点「输入令牌」填入 dsh web 启动时打印的 token（或命令面板「DSH: 输入访问令牌」）。",
  authTokenRejected:
    "服务器要求授权，且自动获取的令牌未被接受。请用命令面板「DSH: 重启服务器」重启它。",
  connectionLost: "与服务器的连接已断开，正在重连…",
  serverSpawnFailed: (detail) => `启动 dsh 进程失败：${detail}`,
  serverExited: (code, signal) => `dsh web 进程已退出（code=${code} signal=${signal}）`,
  serverStartTimeout: (seconds) => `等待 dsh web 就绪超时（${seconds}s）`,
  serverUnreachable: (baseUrl) => `无法连接 ${baseUrl}，请确认该地址上运行着 dsh web。`,
  serverStaleLock: (lockPath) =>
    `检测到崩溃遗留的文件锁：${lockPath}\n` +
    "它属于一次被强制结束的 dsh 进程（锁的持有者已不在）。确认没有其它 dsh 正在运行后，" +
    "删除该文件并重试；或执行命令「DSH: 重新连接」——扩展会在启动前清掉无主的锁。",
  serverLogTail: (tail) => `日志尾部：\n${tail}`,

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
  statsSpeed: "输出速度（TPS）",
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
  toolGlob: "查找文件",
  toolWeb: "访问网络",
  toolTodo: "更新待办",
  toolDelegate: "委派子代理",
  toolPresent: "交付文件",
  toolPwsh: "Pwsh",
  toolReadImage: "读取图片",
  toolGeneric: "工具调用",
  toolCode: "代码",
  toolExitCode: (code) => `退出码 ${code}`,
  toolSignal: (signal) => `被信号 ${signal} 终止`,
  toolImageAlt: "工具返回的图片",
  toolStatusRunning: "运行中",
  toolStatusStopped: "已停止",
  toolStatusFailed: "失败",
  maxTokens: "已达到输出 token 上限，回答被截断。发送「继续」可接着写。",

  branchFromHere: "从这里分支",
  branchFailed: "创建分支失败",
  branchCreated: (title) => `已创建分支：${title}`,
  branchNoAnchor: "这条消息还取不到分支锚点（本轮尚未收尾），暂时不能分支",
  branchRunning: "生成中不能分支",
  branchTag: "分支",
  historyMore: "加载更早的消息",
  historyBusy: "生成中不能加载历史，请等这一轮结束",

  fontSize: "字体大小",
  fontSizeDesc: "聊天界面的字号（整数 px）；0 跟随 VS Code。",

  language: "界面语言",
  languageDesc: "聊天界面的显示语言（默认跟随 VS Code）。",
  languageAuto: "跟随 VS Code",
  languageZh: "简体中文",
  languageEn: "English",
  toolRunning: "运行中 · 已用 {duration}",
  toolRunningHint: "输出会在执行结束后显示",
};

const en: Texts = {
  brand: "DSH",
  newChat: "New chat",
  history: "Chat history",
  openInEditor: "Open in editor",
  settings: "Settings",

  emptyTitle: "What can I help you with?",
  emptyHint: "Use @ to attach files or a selection. Shift+Enter for a new line.",

  placeholderFirst: "Ask anything, or use @ to add context",
  placeholderFollowUp: "Ask a follow-up",
  send: "Send",
  sendTitle: "Send (Enter)",
  stop: "Stop",
  stopTitle: "Stop generating",
  mode: "Mode and permissions",
  modeAgent: "Agent",
  modePlan: "Plan",
  thinkingDepth: "Thinking depth",
  models: "Models",
  defaultModel: "Default model",
  noModels: "No model catalog available",
  attachFile: "Attach file",
  attachFolder: "whole folder",
  cancel: "Cancel",
  toggleThinking: "Cycle thinking depth",
  remove: "Remove",

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
  permConfirmAck: "I understand the risk and want to continue",
  permConfirmEnable: "Enable full access",
  enterPlanMode: "Enter plan mode",
  exitPlanMode: "Exit plan mode",

  goalActive: "Ongoing Goal",
  goalPaused: "Paused Goal",
  goalBlocked: "Blocked Goal",
  goalPause: "Pause goal",
  goalResume: "Resume goal",
  goalClear: "Clear goal",

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

  subagents: "Subagents",
  subagentsEmpty: "This session has no subagents",
  subagentOneShot: "one-shot",
  subagentContinuable: "continuable",
  subagentInactive: "finished",
  trajectory: "Trajectory",
  trajectoryEmpty: "No tool calls in this session yet",
  jobs: "Background jobs",
  jobsEmpty: "This session has no background jobs",
  jobRunning: "running",
  jobStopping: "stopping",
  jobCompleted: "completed",
  jobKilled: "killed",
  jobFailed: "failed",
  commands: "Commands",
  commandsEmpty: "No commands available",
  skillTag: "Skill",
  uploadFailed: "Upload failed — click to retry",
  uploadIncomplete: (names, count) =>
    `${count} file(s) could not be uploaded (${names}); only the ready attachments were sent`,
  uploadNoSession: "Not connected to the server yet; the attachment cannot be uploaded",
  mentionFiles: "Files",
  mentionEmpty: "No matching files",
  mentionHint: "↑↓ select · Enter confirm · Esc cancel",
  settingsTitle: "Settings",
  settingsLoading: "Loading settings…",
  settingsEmpty: "The server returned no configurable namespaces",
  settingsRestart: "needs restart",
  settingsReset: "Reset group",
  settingsResetDone: "Reset to defaults",
  settingsOverridden: "modified",
  settingsSaved: "Saved",
  settingsSecretSet: "configured",
  settingsSecretUnset: "not set",
  settingsSave: "Save",
  settingsAdvanced: "Advanced (JSON)",
  settingsNoDocument: "The server exposes no settings document; showing read-only values",
  settingsNamespace: (ns) => `namespace ${ns}`,

  running: "Generating",
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
  injectedPlugin: "Plugin context",
  injectedGeneric: "Auto-loaded",
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

  copy: "Copy",
  copied: "Copied to clipboard",
  insertToEditor: "Insert into the active editor",
  openFile: "Open file",
  stopped: "Stopped",

  connecting: "Connecting…",
  connectionFailed: "Cannot reach the DSH server",
  reconnect: "Reconnect",
  restartServer: "Restart server",
  enterToken: "Enter token",
  authNeedsToken:
    "The external DSH server requires an access token: click “Enter token” and paste the token printed by dsh web (or run “DSH: Enter Access Token” from the Command Palette).",
  authTokenRejected:
    "The server requires authentication and the token obtained automatically was rejected. Restart it with “DSH: Restart Server” from the Command Palette.",
  connectionLost: "Lost the connection to the server; reconnecting…",
  serverSpawnFailed: (detail) => `Could not start the dsh process: ${detail}`,
  serverExited: (code, signal) => `The dsh web process exited (code=${code} signal=${signal})`,
  serverStartTimeout: (seconds) => `Timed out waiting for dsh web to become ready (${seconds}s)`,
  serverUnreachable: (baseUrl) => `Cannot reach ${baseUrl}; make sure dsh web is running there.`,
  serverStaleLock: (lockPath) =>
    `Found a file lock left behind by a crash: ${lockPath}\n` +
    "It belongs to a dsh process that was force-killed (its owner is gone). Once you are sure no " +
    "other dsh is running, delete the file and retry; or run “DSH: Reconnect” — the extension " +
    "clears ownerless locks before starting the server.",
  serverLogTail: (tail) => `Log tail:\n${tail}`,

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
  statsSpeed: "Tokens per second (TPS)",
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
  toolGlob: "Find files",
  toolWeb: "Web",
  toolTodo: "Update to-dos",
  toolDelegate: "Delegate",
  toolPresent: "Deliver",
  toolPwsh: "Pwsh",
  toolReadImage: "Read image",
  toolGeneric: "Tool call",
  toolCode: "Code",
  toolExitCode: (code) => `exit code ${code}`,
  toolSignal: (signal) => `killed by signal ${signal}`,
  toolImageAlt: "Image returned by the tool",
  toolStatusRunning: "Running",
  toolStatusStopped: "Stopped",
  toolStatusFailed: "Failed",
  maxTokens: "Output token limit reached; the answer was truncated. Send “continue” to resume.",

  branchFromHere: "Branch from here",
  branchFailed: "Could not create the branch",
  branchCreated: (title) => `Branch created: ${title}`,
  branchNoAnchor: "No branch anchor for this message yet (the turn has not finished)",
  branchRunning: "Cannot branch while generating",
  branchTag: "Branch",
  historyMore: "Load earlier messages",
  historyBusy: "Cannot load history while generating — wait for this turn to finish",

  fontSize: "Font size",
  fontSizeDesc: "Chat UI font size (integer px); 0 follows VS Code.",

  language: "Language",
  languageDesc: "Language of the chat UI (follows VS Code by default).",
  languageAuto: "Follow VS Code",
  languageZh: "简体中文",
  languageEn: "English",
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
    case "copied":
      return texts.copied;
    case "settingsSaved":
      return texts.settingsSaved;
    case "settingsResetDone":
      return texts.settingsResetDone;
    case "queueAttachmentsLost":
      return texts.queueAttachmentsLost;
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
    case "authNeedsToken":
      return texts.authNeedsToken;
    case "authTokenRejected":
      return texts.authTokenRejected;
    case "serverSpawnFailed":
      return texts.serverSpawnFailed(arg);
    case "serverUnreachable":
      return texts.serverUnreachable(arg);
    case "serverStaleLock":
      return texts.serverStaleLock(arg);
    case "serverLogTail":
      return texts.serverLogTail(arg);
    case "serverStartTimeout":
      return texts.serverStartTimeout(Number(arg));
    case "serverExited": {
      // 参数形如 `<code>:<signal>`，两者都可能是 `?`
      const separator = arg.indexOf(":");
      const code = separator < 0 ? arg : arg.slice(0, separator);
      const signal = separator < 0 ? "" : arg.slice(separator + 1);
      return texts.serverExited(code, signal);
    }
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
