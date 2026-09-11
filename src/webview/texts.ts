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
  /** 计划模式挂起态提示条（下一条消息将进入计划模式，可取消）。 */
  planPending: string;

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

  searchSessions: string;
  today: string;
  earlier: string;
  noSessions: string;
  untitled: string;
  runningTag: string;
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
  /** 附件是二进制/非文本、没能内联时的提示（文件名作为变量）。 */
  attachmentNotInlined: (names: string) => string;
  turnFailed: string;
  interrupted: string;
  compacted: string;
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
  planPending: "下一条消息将进入计划模式",

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

  searchSessions: "搜索历史对话",
  today: "今天",
  earlier: "更早",
  noSessions: "还没有历史对话",
  untitled: "未命名对话",
  runningTag: "运行中",
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
  /** 当前模型不支持图片输入时的提示（模型名作为变量）。 */
  imagePathsInserted: (count, model) =>
    `模型「${model}」不支持图片输入，已把 ${count} 个路径插入输入框`,
  queueAttachmentsLost: "这条消息的附件无法还原，请重新添加（正文已放回输入框）",
  queueContentLost: "排队消息的内容无法还原，已只中止当前轮",
  queueDispatchFailed: "排队消息没能自动发出，内容已放回输入框",
  attachmentNotInlined: (names) => `${names} 不是文本文件，只把路径发给了模型（未内联内容）`,
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
  planPending: "Plan mode will be enabled on your next message",

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

  searchSessions: "Search past sessions",
  today: "Today",
  earlier: "Earlier",
  noSessions: "No past sessions yet",
  untitled: "Untitled chat",
  runningTag: "running",
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
  imagePathsInserted: (count, model) =>
    `Model "${model}" does not accept image input; inserted ${count} path(s) into the box`,
  queueAttachmentsLost: "Attachments could not be restored; please re-attach them (text is back in the box)",
  queueContentLost: "Could not restore the queued message; only the current turn was stopped",
  queueDispatchFailed: "The queued message could not be sent; its content is back in the box",
  attachmentNotInlined: (names) => `${names} is not a text file; only the path was sent (contents not inlined)`,
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
 */
export function resolveText(text: string, texts: Texts): string {
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
    case "attachmentNotInlined":
      return texts.attachmentNotInlined(arg);
    case "unknownEvent":
      return texts.unknownEvent(arg);
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
