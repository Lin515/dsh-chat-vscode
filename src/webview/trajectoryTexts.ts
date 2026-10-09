/**
 * 「轨迹」视图的文案：**逐字取自官方**（`dsh-client-ui-trajectory` 的 locales，
 * key → 中文 / 英文），只收录本扩展当前真正渲染的那些——本文件就是唯一登记表
 * （时间 / 时长格式化口径见 `docs/design-trajectory.md` 的「文案」一节）。
 *
 * 为什么单独一个文件而不是塞进 `texts.ts`：这些文案**只在 webview 内部消费**
 * （不走宿主 → 界面的 `@key` 标记），所以不需要进 `resolveText` 的 switch，
 * 也不必挤进那份已经很大的词典。但双语是硬规则：`zh` 与 `en` 必须同时齐全，
 * 带参数的写成函数（中英语序不同，拼字符串必然错）。
 */
import type { TrajectoryCellKind } from "../shared/trajectory";

export interface TrajectoryTexts {
  /** 视图 / 工具栏 */
  title: string;
  toolbarAria: string;
  toolbarTurns: string;
  toolbarExpandTurns: string;
  toolbarCollapseTurns: string;
  toolbarCalls: string;
  toolbarExpandCalls: string;
  toolbarCollapseCalls: string;
  toolbarSearch: string;
  toolbarSearchPlaceholder: string;

  /** 记录种类 */
  kindSystem: string;
  kindUser: string;
  kindContext: string;
  kindCompacted: string;
  kindAssistant: string;
  kindTool: string;
  kindSubtool: string;

  /** 轮次 / 状态 */
  turnLabel: (turn: number) => string;
  betweenTurns: string;
  /** 组标题（官方 `group.message` / `group.step` / `group.compaction` 三条文案）。 */
  groupMessage: string;
  groupStep: (step: number) => string;
  groupCompaction: (seq: number) => string;
  statusFailed: string;
  statusPending: string;
  statusCompleted: string;

  /** 详情页签 */
  tabSummary: string;
  tabRawOutput: string;
  tabPreview: string;
  tabRaw: string;
  tabSource: string;
  tabPayload: string;
  tabResult: string;
  tabSchema: string;
  tabTiming: string;
  tabSystemPrompt: string;
  tabTools: string;
  /** 系统提示词变更时的对照页签（官方 `diff` 页签）。 */
  tabDiff: string;
  /** 请求级检查器的两个页签（官方 `tab.options` / `tab.usage`）。 */
  tabOptions: string;
  tabUsage: string;

  /** 布局 / 摘要 */
  compacting: string;
  compactionFailed: string;
  /** 会话在压缩跑到一半时结束（官方 `layout.compactionInterrupted`）。 */
  compactionInterrupted: string;
  compacted: string;
  /** layout 层的「仅工具调用」（检索/纯文本用），账本行用的是下面那条记录文案。 */
  toolCallOnly: string;
  /** 账本行里「这一行只有工具调用」的记录文案（官方 `record.toolCallOnly`，带括号）。 */
  recordToolCallOnly: string;
  /** 助手行只有图片时的摘要（官方 `layout.imageCount`）。 */
  imageCount: (count: number) => string;
  /** 用户/上下文行的文件附件摘要（官方 `layout.fileAttachments`）。 */
  fileAttachments: (count: number) => string;
  initialSystemPrompt: string;
  systemPromptUpdated: string;
  /** 只有工具目录变了（官方 `layout.toolsUpdated`）。 */
  toolsUpdated: string;
  systemPromptAndToolsUpdated: string;
  /** 工具目录变更的行文本（官方 `layout.toolAdded` 一族；两种 kind 下同字符串）。 */
  toolAdded: (name: string) => string;
  toolRemoved: (name: string) => string;
  /** 官方 `layout.toolUpdateNotice`：与上面的 `toolsUpdated` 是**两个 key、同一句文案**。 */
  toolUpdateNotice: string;
  toolsAdded: (names: string) => string;
  toolsRemoved: (names: string) => string;
  toolsAddedCount: (count: number) => string;
  toolsRemovedCount: (count: number) => string;
  toolsChanged: (added: number, removed: number) => string;

  /** 详情 */
  detailsEvent: string;
  detailsClose: string;
  detailsStatus: string;
  detailsProvider: string;
  detailsModel: string;
  detailsError: string;
  detailsRetry: string;
  detailsSource: string;
  detailsCompacted: string;
  /** 检查器可拖宽（官方 `details.resize` / `details.resizeTitle`）。 */
  detailsResize: string;
  detailsResizeTitle: string;

  /**
   * 账本行的无障碍名字（官方 `request.rowPrefix` / `request.rowAria`）。
   *
   * 官方把**整行**读成「请求 #N，种类，内容」一句：`rowPrefix` 是前半句（带请求号时才有），
   * `rowAria` 把它与种类、内容拼起来。内容为空时用 `recordNoContent`（「无内容」）兜底。
   * 请求锚点行（`requestOnly`）没有种类也没有内容，官方单独给一句 `rowAriaCompaction`。
   */
  requestRowPrefix: (request: number) => string;
  requestRowAria: (request: string, kind: string, content: string) => string;
  requestRowAriaCompaction: (request: string) => string;

  /** 记录正文 */
  recordNoContent: string;
  recordNoPayload: string;
  recordNoResult: string;
  recordNoOutput: string;
  recordSchemaUnavailable: string;
  recordParameters: string;
  recordThinking: string;
  recordSystemPromptMissing: string;
  recordToolsMissing: string;

  /** 来源 */
  sourceUser: string;
  sourcePlugin: string;
  sourcePluginNamed: (plugin: string) => string;
  sourceGoal: string;
  sourceGoalRound: (round: number) => string;
  sourceNotRecorded: string;
  /** 来源对象在、但 `kind` 缺失或为空（官方 `source.unknown`）。 */
  sourceUnknown: string;

  /** 用量 / 计时 */
  usageInput: string;
  usageCached: string;
  usageCacheCreated: string;
  usageOutput: string;
  usageReasoning: string;
  /** 输入合计下面的「其他」层（官方 `usage.other`：`input` 那一桶，不含缓存）。 */
  usageOther: string;
  /** 输出合计下面的「内容」层（官方 `usage.content`：`output - reasoning`）。 */
  usageContent: string;
  usageNotReported: string;
  /** 请求检查器「用量」页签的两个分组标题（官方 `usage.thisRequest` / `usage.sessionCumulative`）。 */
  usageThisRequest: string;
  usageSessionCumulative: string;
  timingStarted: string;
  timingTotalDuration: string;
  /**
   * 请求面板那一行的时长标签。
   *
   * 与记录级的 `timingTotalDuration` **必须分开**：官方记录面板用的是 `timing.total`
   * （「总时长」），请求面板用的是 `timing.duration`（「时长」）。从前为了「一处文案
   * 两处用」两边都写「总时长」，与官方不一致。
   */
  timingDuration: string;
  timingTtft: string;
  timingGeneration: string;
  timingThroughput: string;
  timingNotAvailable: string;
  timingNotRecorded: string;
  /** 计时面板分开的四种「不可用」口径（官方各有一个 key，不是一句笼统的话）。 */
  timingStepStartUnavailable: string;
  timingFirstTokenUnavailable: string;
  timingUsageUnavailable: string;
  timingOutputTokensUnavailable: string;
  timingDurationTooShort: string;
  /** 计时来源：会话时间戳（运行中时另有一句）。 */
  timingSource: string;
  timingSessionTimestamps: string;
  timingSessionTimestampsRunning: string;
  /**
   * 助手记录概述里那一节的标题（官方 `timing.request`）：「这个请求的计时」。
   *
   * 与 `tabTiming`（「计时」）分开：它是**请求级**那一格的入口——点它跳到该请求的
   * 计时页签，而不是本记录的计时。
   */
  timingRequest: string;
  /**
   * 时刻那一格的显示形态开关（官方 `timing.showLocalTime` / `timing.showUnixTimestamp`）：
   * 两个 key 互为对方的 action 说明（当前显示 Unix 时提示切回本地时间，反之亦然）。
   */
  timingShowLocalTime: string;
  timingShowUnixTimestamp: string;

  /** 单位（带参数） */
  unitMs: (value: number) => string;
  unitSeconds: (value: number) => string;
  unitTokens: (value: number) => string;
  unitTokensPerSecond: (value: string) => string;

  /** 请求 */
  requestLabel: (request: number) => string;
  requestLabelCompaction: (request: number) => string;
  requestRetryProgress: (retry: number, maximum: number) => string;
  /** 压缩请求的「用途」行（官方 `request.compactionPurpose`）。 */
  requestCompactionPurpose: string;
  /** 请求检查器「概述」里的两个标签（官方 `details.purpose` / `details.error` 复用）。 */
  detailsPurpose: string;
  /** 重试进度的两条文案（官方 `details.retry` 与 `details.scheduled` / `details.retryDelay`）。 */
  detailsScheduled: string;
  detailsRetryDelay: string;
  /** 已知的提供方失败归类（官方 `details.failure.auth`）。 */
  detailsFailureAuth: string;
  /**
   * 助手记录被中断时的错误正文（本扩展自有：宿主把这种记录标成 `@interrupted`）。
   *
   * 那个标记是**宿主 → 界面的语义**，不是给人看的文案——从前它被原样渲染进
   * 「错误」那一行，用户看到的是 `@interrupted` 这个内部记号。
   */
  detailsInterrupted: string;
  /** 检查器「层级」那一行的三个反向链接标签（官方 `details.hierarchy` 一族）。 */
  detailsHierarchy: string;
  detailsAssistantMessage: string;
  detailsToolCall: string;
  /**
   * 请求概述里那两行计数与「结果」跳转行（官方 `details.toolCalls` /
   * `details.subtoolCalls` / `details.result`）。
   *
   * `detailsResult` 是那枚链接的**行标签**，链接文字用官方的 `detailsAssistantMessage`
   * / `detailsCompacted`（压缩请求跳的是压缩记录）。
   */
  detailsToolCalls: string;
  detailsSubtoolCalls: string;
  detailsResult: string;
  /** 选项页签没有那一帧时的回落（官方 `options.notRecorded`）。 */
  optionsNotRecorded: string;
  /** 选项 JSON 的标题（官方 `options.json`）。 */
  optionsJson: string;
  /** 来源 JSON 的标题（官方 `source.messageJson`；官方那两个 JSON 树都带标题）。 */
  sourceMessageJson: string;
  /**
   * 「原始内容」页签逐块渲染时每块的节标题（官方 `block.label`）。
   *
   * `type` 是**块类型串**（`thinking` / `text` / `tool-call` / `unknown`），原样显示、
   * 不翻译——官方也没有把块类型翻成自然语言的表，而这一页是拿轨迹核对日志事实的地方。
   * `index` 是块序号（1 起）。中英各自的语序不同，所以是函数。
   */
  blockLabel: (index: number, type: string) => string;
  /** 工具调用块那枚跳转按钮的**无障碍名字**（官方 `block.openSummary`，带块序号）。 */
  blockOpenSummary: (index: number) => string;
  /** 同一枚按钮的悬停说明（官方 `block.openSummaryTitle`，不带序号）。 */
  blockOpenSummaryTitle: string;
  /** 折叠行：官方 `request.collapsedSummary` + `request.collapsedTurn/Assistant` */
  collapsedTurn: string;
  collapsedAssistant: string;
  collapsedSummary: (kind: string, summary: string) => string;
  /** 轮次折叠摘要的两段（官方 `summarizeTurn` 的 `summary.steps` / `summary.toolCalls`）。 */
  summarySteps: (count: number) => string;
  summaryToolCalls: (count: number) => string;

  /** 历史 */
  loadEarlier: string;
  loadingEarlier: string;
  /** 面板还没取过账本（刚打开、宿主还没回帧） */
  loading: string;

  /** 时间线（工具栏开关 + 泳道标签 + tooltip） */
  toolbarDuration: string;
  toolbarUseActualDuration: string;
  toolbarUseEqualWidth: string;
  columnInput: string;
  columnModel: string;
  columnTools: string;
  timelineAria: string;
  timelineNoTimingData: string;
  timelineTotal: (duration: string) => string;
  timelineStarted: (time: string) => string;
  timelineTtftDecoding: (ttft: string, decoding: string) => string;
  /** 缩放复位（官方没有这个按钮：官方只有双击清选区；这里多一个出路）。 */
  timelineResetZoom: string;

  /** 检查器里各段原文右上角那对按钮（官方 `code.copySource` / `record.wrapLines`）。 */
  copy: string;
  wrapLines: string;
  /** 复制按钮的悬停说明按段落内容分（官方 `code.copySource` / `code.copyOutput` / `copy.json`）。 */
  copyParameters: string;
  copyOutput: string;
  /**
   * PTC（`run_code`）那一格的标题与复制说明（官方 `code.source` / `code.copySource`）。
   * 它的正文是**程序源码**而不是参数 JSON，所以三个词条都与参数那套分开。
   */
  codeSource: string;
  codeCopySource: string;
}

const zh: TrajectoryTexts = {
  title: "轨迹",
  toolbarAria: "轨迹工具栏",
  toolbarTurns: "轮次",
  toolbarExpandTurns: "展开所有轮次",
  toolbarCollapseTurns: "收起所有轮次",
  toolbarCalls: "调用",
  toolbarExpandCalls: "展开所有调用",
  toolbarCollapseCalls: "收起所有调用",
  toolbarSearch: "搜索轨迹",
  toolbarSearchPlaceholder: "搜索",

  kindSystem: "系统",
  kindUser: "用户",
  kindContext: "上下文",
  kindCompacted: "已压缩",
  kindAssistant: "助手",
  kindTool: "工具",
  kindSubtool: "子工具",

  turnLabel: (turn) => `第 ${turn} 轮`,
  betweenTurns: "轮次之间",
  groupMessage: "消息",
  groupStep: (step) => `第 ${step} 步`,
  groupCompaction: (seq) => `压缩 ${seq}`,
  statusFailed: "失败",
  statusPending: "等待中",
  statusCompleted: "已完成",

  tabSummary: "概述",
  tabRawOutput: "原始输出",
  tabPreview: "预览",
  tabRaw: "原始内容",
  tabSource: "来源",
  tabPayload: "参数",
  tabResult: "结果",
  tabSchema: "Schema",
  tabTiming: "计时",
  tabSystemPrompt: "系统提示词",
  tabTools: "工具",
  tabDiff: "差异",
  tabOptions: "选项",
  tabUsage: "用量",
  /** PTC（`run_code`）那一格：官方在有代码程序时把「参数」改叫「代码」（`code.source`）。 */
  codeSource: "代码",

  compacting: "正在压缩上下文…",
  compactionFailed: "上下文压缩失败",
  compactionInterrupted: "上下文压缩在完成前被中断。",
  compacted: "上下文已压缩",
  toolCallOnly: "仅工具调用",
  recordToolCallOnly: "（仅工具调用）",
  imageCount: (count) => `图片 ×${count}`,
  fileAttachments: (count) => `文件 ×${count}`,
  initialSystemPrompt: "初始系统提示词",
  systemPromptUpdated: "系统提示词已更新",
  toolsUpdated: "工具已更新",
  systemPromptAndToolsUpdated: "系统提示词和工具已更新",
  toolAdded: (name) => `已添加工具：${name}`,
  toolRemoved: (name) => `已移除工具：${name}`,
  toolUpdateNotice: "工具已更新",
  toolsAdded: (names) => `新增：${names}`,
  toolsRemoved: (names) => `移除：${names}`,
  toolsAddedCount: (count) => `新增 ${count} 个`,
  toolsRemovedCount: (count) => `移除 ${count} 个`,
  toolsChanged: (added, removed) => `新增 ${added} 个，移除 ${removed} 个`,

  detailsEvent: "事件详情",
  detailsClose: "关闭详情",
  detailsStatus: "状态",
  detailsProvider: "提供方",
  detailsModel: "模型",
  detailsError: "错误",
  detailsRetry: "重试",
  detailsSource: "来源",
  detailsCompacted: "已压缩",
  detailsResize: "调整事件详情宽度",
  detailsResizeTitle: "拖动调整大小；双击恢复默认值。",
  requestRowPrefix: (request) => `请求 ${request}，`,
  requestRowAria: (request, kind, content) => `${request}${kind}，${content}`,
  requestRowAriaCompaction: (request) => `请求 ${request}，压缩`,
  recordNoContent: "无内容",
  recordNoPayload: "未捕获参数",
  recordNoResult: "未捕获结果",
  recordNoOutput: "无输出",
  recordSchemaUnavailable: "Schema 不可用",
  recordParameters: "参数",
  recordThinking: "思考",
  recordSystemPromptMissing: "本次请求没有系统提示词",
  recordToolsMissing: "本次请求没有工具",

  sourceUser: "用户",
  sourcePlugin: "插件",
  sourcePluginNamed: (plugin) => `插件 · ${plugin}`,
  sourceGoal: "目标",
  sourceGoalRound: (round) => `目标 · Round ${round}`,
  sourceNotRecorded: "未记录来源",
  sourceUnknown: "未知",

  usageInput: "输入",
  usageCached: "缓存读取",
  usageCacheCreated: "缓存写入",
  usageOutput: "输出",
  usageReasoning: "推理",
  usageOther: "其他",
  usageContent: "内容",
  usageNotReported: "未报告用量",
  usageThisRequest: "本次请求",
  usageSessionCumulative: "会话累计",
  timingStarted: "开始时间",
  timingTotalDuration: "总时长",
  timingRequest: "请求计时",
  timingDuration: "时长",
  timingTtft: "首 token 延迟",
  timingGeneration: "生成",
  timingThroughput: "吞吐量",
  timingNotAvailable: "不可用",
  timingNotRecorded: "未记录",
  timingStepStartUnavailable: "步骤开始时间不可用",
  timingFirstTokenUnavailable: "首 token 时间不可用",
  timingUsageUnavailable: "用量不可用",
  timingOutputTokensUnavailable: "输出 token 数不可用",
  timingDurationTooShort: "时长过短",
  timingSource: "计时来源",
  timingSessionTimestamps: "会话时间戳",
  timingSessionTimestampsRunning: "会话时间戳（运行中）",
  timingShowLocalTime: "显示本地时间",
  timingShowUnixTimestamp: "显示 Unix 时间戳",

  unitMs: (value) => `${value} 毫秒`,
  unitSeconds: (value) => `${value} 秒`,
  unitTokens: (value) => `${value} tok`,
  unitTokensPerSecond: (value) => `${value} tok/s`,

  requestLabel: (request) => `请求 #${request}`,
  requestLabelCompaction: (request) => `请求 #${request} · 压缩`,
  requestRetryProgress: (retry, maximum) => `${retry}/${maximum}`,
  requestCompactionPurpose: "压缩",
  detailsPurpose: "用途",
  detailsScheduled: "已计划",
  detailsRetryDelay: "重试延迟",
  detailsFailureAuth: "API 密钥无效",
  detailsInterrupted: "回答在完成前被中断。",
  detailsHierarchy: "层级",
  detailsAssistantMessage: "助手消息",
  detailsToolCall: "工具调用",
  detailsToolCalls: "工具调用",
  detailsSubtoolCalls: "子工具调用",
  detailsResult: "结果",
  optionsNotRecorded: "未记录选项",
  optionsJson: "请求选项 JSON",
  sourceMessageJson: "消息来源 JSON",
  blockLabel: (index, type) => `块 #${index} ${type}`,
  blockOpenSummary: (index) => `打开第 ${index} 个块的工具调用概述`,
  blockOpenSummaryTitle: "打开工具调用概述",
  collapsedTurn: "轮次",
  collapsedAssistant: "助手",
  collapsedSummary: (kind, summary) => `已收起的${kind}概述，${summary}`,
  summarySteps: (count) => `${count} 个步骤`,
  summaryToolCalls: (count) => `${count} 个工具调用`,

  loadEarlier: "加载更早的历史",
  loadingEarlier: "正在加载更早的历史…",
  loading: "正在加载轨迹…",

  toolbarDuration: "时长",
  toolbarUseActualDuration: "使用实际时长",
  toolbarUseEqualWidth: "使用等宽操作",
  columnInput: "输入",
  columnModel: "模型",
  columnTools: "工具",
  timelineAria: "轨迹时间线",
  timelineNoTimingData: "无计时数据",
  timelineTotal: (duration) => `总计 ${duration}`,
  timelineStarted: (time) => `开始于 ${time}`,
  timelineTtftDecoding: (ttft, decoding) => `首 token ${ttft} · 解码 ${decoding}`,
  timelineResetZoom: "缩放复位（当前已放大；悬停滚轮缩放，右键拖动平移）",

  copy: "复制",
  wrapLines: "自动换行",
  copyParameters: "复制参数",
  copyOutput: "复制输出",
  codeCopySource: "复制代码",
};

const en: TrajectoryTexts = {
  title: "Trajectory",
  toolbarAria: "Trajectory toolbar",
  toolbarTurns: "Turns",
  toolbarExpandTurns: "Expand turns",
  toolbarCollapseTurns: "Collapse turns",
  toolbarCalls: "Calls",
  toolbarExpandCalls: "Expand calls",
  toolbarCollapseCalls: "Collapse calls",
  toolbarSearch: "Search trajectory",
  toolbarSearchPlaceholder: "Search",

  kindSystem: "SYSTEM",
  kindUser: "USER",
  kindContext: "CONTEXT",
  kindCompacted: "COMPACTED",
  kindAssistant: "ASSISTANT",
  kindTool: "TOOL",
  kindSubtool: "SUBTOOL",

  turnLabel: (turn) => `Turn ${turn}`,
  betweenTurns: "Between turns",
  groupMessage: "Message",
  groupStep: (step) => `Step ${step}`,
  groupCompaction: (seq) => `Compaction ${seq}`,
  statusFailed: "Failed",
  statusPending: "Pending",
  statusCompleted: "Completed",

  tabSummary: "Summary",
  tabRawOutput: "Raw Output",
  tabPreview: "Preview",
  tabRaw: "Raw",
  tabSource: "Source",
  tabPayload: "Payload",
  tabResult: "Result",
  tabSchema: "Schema",
  tabTiming: "Timing",
  tabSystemPrompt: "System Prompt",
  tabTools: "Tools",
  tabDiff: "Diff",
  tabOptions: "Options",
  tabUsage: "Usage",
  /** PTC（`run_code`）那一格：官方在有代码程序时把「参数」改叫「代码」（`code.source`）。 */
  codeSource: "Code",

  compacting: "Compacting context…",
  compactionFailed: "Compaction failed",
  compactionInterrupted: "Compaction was interrupted before completion.",
  compacted: "Context compacted",
  toolCallOnly: "Tool call only",
  recordToolCallOnly: "(tool call only)",
  imageCount: (count) => `Images ×${count}`,
  fileAttachments: (count) => `Files ×${count}`,
  initialSystemPrompt: "Initial System Prompt",
  systemPromptUpdated: "System Prompt Updated",
  toolsUpdated: "Tools Updated",
  systemPromptAndToolsUpdated: "System Prompt and Tools Updated",
  toolAdded: (name) => `Tool added: ${name}`,
  toolRemoved: (name) => `Tool removed: ${name}`,
  toolUpdateNotice: "Tools updated",
  toolsAdded: (names) => `Added: ${names}`,
  toolsRemoved: (names) => `Removed: ${names}`,
  toolsAddedCount: (count) => `${count} added`,
  toolsRemovedCount: (count) => `${count} removed`,
  toolsChanged: (added, removed) => `${added} added, ${removed} removed`,

  detailsEvent: "Event details",
  detailsClose: "Close details",
  detailsStatus: "Status",
  detailsProvider: "Provider",
  detailsModel: "Model",
  detailsError: "Error",
  detailsRetry: "Retry",
  detailsSource: "Source",
  detailsCompacted: "Compacted",
  detailsResize: "Resize event details",
  detailsResizeTitle: "Drag to resize. Double-click to reset.",
  requestRowPrefix: (request) => `Request ${request}, `,
  requestRowAria: (request, kind, content) => `${request}${kind}, ${content}`,
  requestRowAriaCompaction: (request) => `Request ${request}, compaction`,

  recordNoContent: "No content",
  recordNoPayload: "No payload captured",
  recordNoResult: "No result captured",
  recordNoOutput: "No output",
  recordSchemaUnavailable: "Schema unavailable",
  recordParameters: "Parameters",
  recordThinking: "Thinking",
  recordSystemPromptMissing: "No system prompt in this request",
  recordToolsMissing: "No tools in this request",

  sourceUser: "User",
  sourcePlugin: "Plugin",
  sourcePluginNamed: (plugin) => `Plugin · ${plugin}`,
  sourceGoal: "Goal",
  sourceGoalRound: (round) => `Goal · Round ${round}`,
  sourceNotRecorded: "Source not recorded",
  sourceUnknown: "Unknown",

  usageInput: "Input",
  usageCached: "Cached",
  usageCacheCreated: "Cache created",
  usageOutput: "Output",
  usageReasoning: "Reasoning",
  usageOther: "Other",
  usageContent: "Content",
  usageNotReported: "Usage not reported",
  usageThisRequest: "This request",
  usageSessionCumulative: "Session cumulative",
  timingStarted: "Started",
  timingTotalDuration: "Total duration",
  timingRequest: "Request timing",
  timingDuration: "Duration",
  timingTtft: "TTFT",
  timingGeneration: "Generation",
  timingThroughput: "Throughput",
  timingNotAvailable: "Not available",
  timingNotRecorded: "Not recorded",
  timingStepStartUnavailable: "Step start unavailable",
  timingFirstTokenUnavailable: "First token unavailable",
  timingUsageUnavailable: "Usage unavailable",
  timingOutputTokensUnavailable: "Output tokens unavailable",
  timingDurationTooShort: "Duration too short",
  timingSource: "Timing source",
  timingSessionTimestamps: "Session timestamps",
  timingSessionTimestampsRunning: "Session timestamps (running)",
  timingShowLocalTime: "Show local time",
  timingShowUnixTimestamp: "Show Unix timestamp",

  unitMs: (value) => `${value} ms`,
  unitSeconds: (value) => `${value} s`,
  unitTokens: (value) => `${value} tok`,
  unitTokensPerSecond: (value) => `${value} tok/s`,

  requestLabel: (request) => `Request #${request}`,
  requestLabelCompaction: (request) => `Request #${request} · Compaction`,
  requestRetryProgress: (retry, maximum) => `${retry} of ${maximum}`,
  requestCompactionPurpose: "Compaction",
  detailsPurpose: "Purpose",
  detailsScheduled: "Scheduled",
  detailsRetryDelay: "Retry delay",
  detailsFailureAuth: "API key is invalid",
  detailsInterrupted: "The answer was interrupted before it completed.",
  detailsHierarchy: "Hierarchy",
  detailsAssistantMessage: "Assistant message",
  detailsToolCall: "Tool call",
  detailsToolCalls: "Tool calls",
  detailsSubtoolCalls: "Subtool calls",
  detailsResult: "Result",
  optionsNotRecorded: "Options not recorded",
  optionsJson: "Request options JSON",
  sourceMessageJson: "Message source JSON",
  blockLabel: (index, type) => `Block #${index} ${type}`,
  blockOpenSummary: (index) => `Open Block #${index} tool call summary`,
  blockOpenSummaryTitle: "Open tool call summary",
  collapsedTurn: "turn",
  collapsedAssistant: "assistant",
  collapsedSummary: (kind, summary) => `Collapsed ${kind} summary, ${summary}`,
  // 英语要分单复数（中英两本词典按同一个接口齐全，复数在函数里分支）
  summarySteps: (count) => (count === 1 ? `${count} step` : `${count} steps`),
  summaryToolCalls: (count) => (count === 1 ? `${count} tool call` : `${count} tool calls`),

  loadEarlier: "Load earlier history",
  loadingEarlier: "Loading earlier history…",
  loading: "Loading trajectory…",

  toolbarDuration: "Duration",
  toolbarUseActualDuration: "Use actual duration",
  toolbarUseEqualWidth: "Use equal-width operations",
  columnInput: "Input",
  columnModel: "Model",
  columnTools: "Tools",
  timelineAria: "Trajectory timeline",
  timelineNoTimingData: "No timing data",
  timelineTotal: (duration) => `Total ${duration}`,
  timelineStarted: (time) => `Started ${time}`,
  timelineTtftDecoding: (ttft, decoding) => `TTFT ${ttft} · Decoding ${decoding}`,
  timelineResetZoom: "Reset zoom (wheel to zoom, right-drag to pan)",

  copy: "Copy",
  wrapLines: "Wrap lines",
  copyParameters: "Copy parameters",
  copyOutput: "Copy output",
  codeCopySource: "Copy code",
};

/** 按界面语言取这套词典（与 `texts.ts` 的 `normalizeLocale` 同一套取值）。 */
export function trajectoryTexts(locale: string | undefined): TrajectoryTexts {
  const normalized = (locale ?? "").toLowerCase();
  return normalized.startsWith("zh") ? zh : en;
}

/** 记录种类的官方标签（`message` → `kind.assistant`，与官方 `KIND_LABEL_KEY` 一致）。 */
export function kindLabel(kind: TrajectoryCellKind, texts: TrajectoryTexts): string {
  switch (kind) {
    case "system":
      return texts.kindSystem;
    case "user":
      return texts.kindUser;
    case "context":
      return texts.kindContext;
    case "compacted":
      return texts.kindCompacted;
    case "message":
      return texts.kindAssistant;
    case "tool":
      return texts.kindTool;
    case "subtool":
      return texts.kindSubtool;
    default:
      return kind;
  }
}

/**
 * 时长格式化（官方 `formatDurationMs` 口径）：不到 1 秒给毫秒，否则给秒——
 * 10 秒以内保留两位小数，再长保留一位。
 */
export function formatDurationMs(milliseconds: number | null, texts: TrajectoryTexts): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return texts.timingNotAvailable;
  }
  if (milliseconds < 1000) return texts.unitMs(Math.round(milliseconds));
  const seconds = milliseconds / 1000;
  const rounded = seconds < 10 ? Math.round(seconds * 100) / 100 : Math.round(seconds * 10) / 10;
  return texts.unitSeconds(rounded);
}

/** 秒 → 文案（官方 `formatElapsedSeconds`）。 */
export function formatElapsedSeconds(seconds: number | null, texts: TrajectoryTexts): string {
  if (seconds === null || !Number.isFinite(seconds)) return texts.timingNotAvailable;
  return formatDurationMs(seconds * 1000, texts);
}

/** 时刻（Unix ms）→ 本地 `HH:MM:SS.mmm`（官方 `formatRecordedTime`）。 */
export function formatRecordedTime(time: number | null): string {
  if (time === null || !Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * 时刻（Unix ms）→ 本地 `YYYY-MM-DD HH:MM:SS.mmm`（官方 `formatStartedAt`）。
 *
 * 只给**可切换时刻显示形态**的那一格用（`StartedAtValue`）：一格里既能显示本地时间
 * 又能显示 Unix 时间戳时，「只有时分秒」不够用——轨迹跨天，切到 Unix 再切回来就看不出
 * 是哪一天了。列表 / 工具提示里那一格仍走 `formatRecordedTime`（窄，日期本就多余）。
 */
export function formatStartedAt(time: number | null): string {
  if (time === null || !Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.`
    + `${pad(date.getMilliseconds(), 3)}`
  );
}

/** 来源标签（官方 `messageSourceLabel` 的三条分支 + 生产者自有 kind 的两种形态）。 */
export function sourceLabel(
  source: { kind?: string; plugin?: string; round?: number } | undefined,
  texts: TrajectoryTexts,
): string {
  // 官方 `messageSourceLabel` 的两条「没法归人话」的分支：来源对象**不在** → 未记录来源；
  // 来源对象在但 `kind` 不是非空字符串 → 未知（两者不是一回事）。
  if (source === undefined) return texts.sourceNotRecorded;
  if (!source.kind) return texts.sourceUnknown;
  switch (source.kind) {
    case "user":
    case "user-rpc":
      return texts.sourceUser;
    case "plugin":
      return source.plugin ? texts.sourcePluginNamed(source.plugin) : texts.sourcePlugin;
    case "goal":
      return typeof source.round === "number" ? texts.sourceGoalRound(source.round) : texts.sourceGoal;
    default:
      // 0.1.7-alpha.1 起来源是**生产者自有**的 kind：第三方插件落成 `plugin:<包名>`
      // （官方 `rewritePluginSource` 的回退形态），显示包名；内置生产者
      // （`system-prompt` / `runtime-context` / `agent-instructions` / `skill-catalog`…）
      // 没有更短的人话标签，与官方轨迹一致地显示 kind 本身。
      return source.kind.startsWith("plugin:")
        ? texts.sourcePluginNamed(source.kind.slice("plugin:".length))
        : source.kind;
  }
}
