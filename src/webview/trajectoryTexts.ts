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

  /** 布局 / 摘要 */
  compacting: string;
  compactionFailed: string;
  compacted: string;
  toolCallOnly: string;
  initialSystemPrompt: string;
  systemPromptUpdated: string;
  systemPromptAndToolsUpdated: string;

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

  /** 用量 / 计时 */
  usageInput: string;
  usageCached: string;
  usageCacheCreated: string;
  usageOutput: string;
  usageReasoning: string;
  timingStarted: string;
  timingTotalDuration: string;
  timingTtft: string;
  timingGeneration: string;
  timingNotAvailable: string;
  timingNotRecorded: string;

  /** 单位（带参数） */
  unitMs: (value: number) => string;
  unitSeconds: (value: number) => string;

  /** 请求 */
  requestLabel: (request: number) => string;
  requestLabelCompaction: (request: number) => string;
  requestRetryProgress: (retry: number, maximum: number) => string;
  /** 折叠行：官方 `request.collapsedSummary` + `request.collapsedTurn/Assistant` */
  collapsedTurn: string;
  collapsedSummary: (kind: string, summary: string) => string;

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

  compacting: "正在压缩上下文…",
  compactionFailed: "上下文压缩失败",
  compacted: "上下文已压缩",
  toolCallOnly: "仅工具调用",
  initialSystemPrompt: "初始系统提示词",
  systemPromptUpdated: "系统提示词已更新",
  systemPromptAndToolsUpdated: "系统提示词和工具已更新",

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

  usageInput: "输入",
  usageCached: "缓存读取",
  usageCacheCreated: "缓存写入",
  usageOutput: "输出",
  usageReasoning: "推理",
  timingStarted: "开始时间",
  timingTotalDuration: "总时长",
  timingTtft: "首 token 延迟",
  timingGeneration: "生成",
  timingNotAvailable: "不可用",
  timingNotRecorded: "未记录",

  unitMs: (value) => `${value} 毫秒`,
  unitSeconds: (value) => `${value} 秒`,

  requestLabel: (request) => `请求 #${request}`,
  requestLabelCompaction: (request) => `请求 #${request} · 压缩`,
  requestRetryProgress: (retry, maximum) => `${retry}/${maximum}`,
  collapsedTurn: "轮次",
  collapsedSummary: (kind, summary) => `已收起的${kind}概述，${summary}`,

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

  compacting: "Compacting context…",
  compactionFailed: "Compaction failed",
  compacted: "Context compacted",
  toolCallOnly: "Tool call only",
  initialSystemPrompt: "Initial System Prompt",
  systemPromptUpdated: "System Prompt Updated",
  systemPromptAndToolsUpdated: "System Prompt and Tools Updated",

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

  usageInput: "Input",
  usageCached: "Cached",
  usageCacheCreated: "Cache created",
  usageOutput: "Output",
  usageReasoning: "Reasoning",
  timingStarted: "Started",
  timingTotalDuration: "Total duration",
  timingTtft: "TTFT",
  timingGeneration: "Generation",
  timingNotAvailable: "Not available",
  timingNotRecorded: "Not recorded",

  unitMs: (value) => `${value} ms`,
  unitSeconds: (value) => `${value} s`,

  requestLabel: (request) => `Request #${request}`,
  requestLabelCompaction: (request) => `Request #${request} · Compaction`,
  requestRetryProgress: (retry, maximum) => `${retry} of ${maximum}`,
  collapsedTurn: "turn",
  collapsedSummary: (kind, summary) => `Collapsed ${kind} summary, ${summary}`,

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

/** 来源标签（官方 `messageSourceLabel` 的三条分支 + 生产者自有 kind 的两种形态）。 */
export function sourceLabel(
  source: { kind?: string; plugin?: string; round?: number } | undefined,
  texts: TrajectoryTexts,
): string {
  if (!source?.kind) return texts.sourceNotRecorded;
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
