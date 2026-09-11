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

export interface SessionControlFrame {
  type: "baseline" | "queue" | "jobs" | "projection";
  sessionId?: string;
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
export interface ImageBlock { type: "image"; attachment: { attachmentId: string; mediaType: string; bytes?: number; name?: string } }
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

export type RemoteEventFrame = RemoteEventReady | RemoteEventWaterfall | { type: "emit"; event: string; args?: unknown[] };

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
  sessionAttachment: "session/attachment",
  eventsResult: "$events/result",
} as const;

export const STREAMS = {
  sessionFollow: "session/follow",
  sessionControl: "session/control",
  events: "$events",
} as const;

/** 会话事件里我们主动渲染的类型；未列出的按 `ignorable` 规则降级。 */
export const RENDERED_EVENT_TYPES = new Set([
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
]);
