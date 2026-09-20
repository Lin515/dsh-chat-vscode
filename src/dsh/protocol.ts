/**
 * DSH 线上协议的线格式类型。
 *
 * 依据 docs/dsh-server-api.md（从 0.1.5-rc.1 安装产物逐字摘录）。协议没有版本
 * 协商，因此这里刻意只保留客户端真正用到的字段，并对未知事件按 `ignorable`
 * 规则降级。
 */

// ---------- 一元 RPC 信封 ----------

export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: { args: Record<string, unknown> };
}

export interface RpcError {
  code: string;
  message: string;
  details?: unknown;
}

export type ServerResponse =
  | { type: "server-response"; rpcId: string; result: { ok: true; value?: unknown } }
  | { type: "server-response"; rpcId: string; result: { ok: false; error: RpcError } };

// ---------- 多路复用流 ----------

export type RemoteStreamServerMessage =
  | { type: "item"; streamId: string; value?: unknown }
  | { type: "end"; streamId: string }
  | { type: "error"; streamId: string; error: RpcError };

// ---------- 会话事件 ----------

export interface SessionWireEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  ignorable?: true;
  sourceEventSeqs?: unknown;
  surfaceOp?: "append" | { op: "replace"; startSeq: number; endSeq: number };
}

export type SessionHistoryRecord = { type: "event"; event: SessionWireEvent };
export type SessionAddress =
  | { kind: "session"; sessionId: string }
  | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" };

export interface SessionFollowSnapshot {
  type: "snapshot";
  header: { version: number; id: string; createdAt: number; cwd?: string; agentPreset?: string };
  cursor: number;
  records: SessionHistoryRecord[];
  hasMore: boolean;
  projections: { asOfSeq: number; values: Record<string, unknown> };
  assistantStream?: {
    revision: number;
    activeAttempt?: { attemptId: string; turn: number; step: number; nextIndex: number; stream: unknown[] };
  };
}

export type SessionFollowFrame =
  | SessionFollowSnapshot
  | { type: "event"; event: SessionWireEvent }
  | { type: "assistant-stream"; frame: AssistantStreamFrame };

export type StreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: ContentBlock }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: unknown };

export type AssistantStreamFrame =
  | { type: "start"; attemptId: string; revision: number; turn: number; step: number }
  | { type: "chunk"; attemptId: string; revision: number; index: number; time: number; chunk: StreamChunk }
  | { type: "end"; attemptId: string; revision: number; index: number; outcome: { kind: "committed"; eventType: string; seq: number } | { kind: "abandoned" } };

/**
 * `session/control` 的帧（宽形状，逐字段在消费处校验）。
 *
 * `type: "queue"` 与 `items` 是**兼容**用的：2026-09-09（提交 `72f2e71070`）之前
 * 的服务端用它们下发队列，之后队列改由 `inbox` 投影承载（走 `projection` 帧的
 * `key: "inbox"`）。两条通道都读，见 controller 的 `onControlFrame`。
 */
export interface SessionControlFrame {
  type: "baseline" | "queue" | "jobs" | "projection";
  sessionId?: string;
  /** 旧通道（`type: "queue"`）的 `SessionQueuedItem[]`。 */
  items?: unknown[];
  jobs?: unknown[];
  key?: string;
  value?: unknown;
  seq?: number;
  [key: string]: unknown;
}

// ---------- 内容块与消息 ----------

export interface ReasoningBlock { type: "reasoning"; text: string }
export interface TextBlock { type: "text"; text: string }
export interface ImageBlock { type: "image"; attachment: { attachmentId: string; mediaType: string; bytes?: number; name?: string; width?: number; height?: number } }
export interface FileBlock { type: "file"; attachment: { attachmentId: string; name: string; bytes?: number } }
export interface ToolCallBlock { type: "tool-call"; id: string; name: string; arguments: string }
export interface ToolResultBlock { type: "tool-result"; toolCallId: string; content: ContentBlock[]; isError?: boolean }
export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | FileBlock
  | ToolCallBlock
  | ToolResultBlock;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface WireMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: ContentBlock[];
  source?: { kind: string; [key: string]: unknown };
}

// ---------- $events ----------

export interface RemoteEventWaterfall {
  type: "waterfall";
  event: string;
  eventId: string;
  agentId: string;
  request: unknown;
}

export interface RemoteEventReady {
  type: "ready";
  clientId: string;
  host?: { home?: string };
}

export type RemoteEventFrame =
  | RemoteEventReady
  | RemoteEventWaterfall
  | { type: "emit"; event: string; args?: unknown[] }
  /**
   * Host 撤回某条 waterfall（另一个客户端答了 / 轮次中止 / Agent Context 释放）。
   *
   * 契约（`dsh-api-gateway` 的 `parseRemoteEventFrame` 与 `finishRemoteEvent`）：
   * 只带 `eventId`，收到后**不要回复**——请求已经结算，再回一条等于放行。
   * 网关在**结算之后**把它推给所有还没答复的投递方，所以它同时是
   * 「另一个窗口替我答了」的通知。
   */
  | { type: "cancel"; eventId: string };

export type RemoteEventOutcome =
  | { kind: "next" }
  | { kind: "result"; value?: unknown }
  | { kind: "rejected"; error: { name: string; message: string; code?: string; details?: unknown } };

// ---------- 端点参数名（严格校验，见 §9.2） ----------

export const METHODS = {
  sessionList: "session/list",
  sessionCreate: "session/create",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionPage: "session/page",
  sessionRename: "session/rename",
  sessionModelCatalog: "session/modelCatalog",
  sessionSelectModel: "session/selectModel",
  sessionUpdateQueue: "session/updateQueue",
  sessionAttachment: "session/attachment",
  eventsResult: "$events/result",
} as const;

export const STREAMS = {
  sessionFollow: "session/follow",
  sessionControl: "session/control",
  events: "$events",
} as const;

/** 会话事件里我们主动渲染的类型；其余按下面的 `SILENT_EVENT_TYPES` / `ignorable` 规则降级。 */
export const RENDERED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "system/message",
  "assistant/message",
  "assistant/attempt",
  "tool/call",
  "tool/result",
  "session/title",
  "todo/write",
  "plan/mode",
  "goal/change",
  "model/selection",
  "permission/preset",
  "sandbox/mode",
  "deliverables/presented",
  "command/run",
  "command/done",
  "llm/retry",
  "llm/retry-started",
  "compaction/start",
  "compaction/summary",
  "compaction/end",
  "approval/policy",
  "approval/asked",
  "approval/decided",
  "request/header",
  "request/context",
  "session/end-seed",
  "agent-preset/selected",
  // 顶层轮次停止时宣告「本轮改了哪些文件」（dsh 0.1.6-alpha 新增的 log-only 事件）。
  // 渲染它不需要事件本身带内容——它只有轮号，清单由 Host 按 seq 另供，见
  // `MessageView.changes` 与 `dsh/changes.ts`。
  "workspace/changes",
]);

/**
 * 已知但**有意不渲染**的事件类型（dsh 内核的簿记类事件）。
 *
 * 和 `RENDERED_EVENT_TYPES` 的唯一区别是「渲染」还是「知情的静默」：两者都表示
 * 本客户端**认识**这个类型，因此都不该触发「不认识的事件」告警。那条告警唯一的
 * 价值是提示「内核冒出了本客户端从未见过的词汇」；一旦已知类型混进去，就退化成
 * 噪音——`agent/inbox/spliced` 每次入队/领取各来一条（新会话开场就有 3~5 条），
 * `command/*` 每次斜杠命令、`llm/retry` 每次模型重试都会命中（审计报告 §11）。
 *
 * 名单 = dsh-session `KNOWN_SESSION_EVENT_TYPES`（0.1.5-rc.1）减去已渲染的类型。
 * 其中 `llm/retry*`、`command/*`、`tool/ptc-dispatch*` 官方 web 端是有界面的
 * （重试提示、斜杠命令节点、`run_code` 子派发卡片），这里先静默，属于待补的
 * 功能缺口，而非永久决定。
 */
export const SILENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  // inbox 队列簿记：插入 / 编辑 / 领取 / 取消（每条用户消息至少两条）
  "agent/inbox/spliced",
  // 上下文压缩的裁剪明细（start/summary/end 已渲染，prune 只是记账）
  "compaction/prune",
  // 消息反馈插件
  "feedback/message-delete",
  "feedback/message-put",
  "feedback/record",
  // 钩子
  "hook/invoked",
  "hook/result",
  // 定时任务
  "schedule/change",
  // 会话日志上报回执
  "session-log-deepseek/delivery-accepted",
  // 标题生成的模型请求快照
  "session/title-llm-request",
  // 子代理目录 / 描述符 / 模型选择策略
  "subagent/catalog",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  // 团队协作
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  // run_code 子派发（官方 web 端渲染卡片）
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  // 工作流工具
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  // web_search 的模型请求快照
  "web/deepseek-search-llm-request",
]);

/**
 * 本客户端是否认识这个事件类型（渲染或知情静默）。
 * 不认识、又没标 `ignorable` 的才需要告警，见 `adapter.ts` 的 default 分支。
 */
export function isKnownEventType(type: string): boolean {
  return RENDERED_EVENT_TYPES.has(type) || SILENT_EVENT_TYPES.has(type);
}
