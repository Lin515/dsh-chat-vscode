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

/**
 * `session/follow` 的请求体（`SessionFollowRequest`，逐字对照契约）。
 *
 * **`assistantStream` 是字面量 `true`，不是布尔开关**（契约里写的是
 * `readonly assistantStream?: true`）。传 `false` 会被网关的边界校验**整条**拒掉：
 *
 * ```
 * gateway/input-invalid: typert gateway: session/follow: wire field "request" failed boundary validation
 * ```
 *
 * 这个类型存在的唯一理由就是让编译器拦住那一手——调用点收 `unknown`（`openStream`），
 * 写错不会报错，只会在界面上表现为「这个子代理没有可显示的内容」（2026-09-22 实测：
 * 子代理记录整条链路因此从上线起一直是空的）。
 */
export interface SessionFollowRequest {
  address: SessionAddress;
  maxMessages?: number;
  assistantStream?: true;
}

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
/**
 * 工具结果的**旧信封**（`message.content = [tool-result{ content: [...] }]`）。
 *
 * **只有旧服务端**会发它。0.1.7-alpha.1 起 `dsh-llm` 的 `ContentBlockMap` 删掉了这个块：
 * 工具结果改成一等消息——`ToolResultMessage = { role:'tool', source:{kind:'tool', callId},
 * toolCallId, content: ContentBlock[], isError? }`，内容块直接挂在 `message.content` 上。
 * V3→V4 迁移会把旧信封抬升成新消息（`dsh-session-format-v3-to-v4` 的 `tool-role.ts`，
 * 新格式下再出现这个块会被判为「退役语法」而拒绝）。保留类型只为兼容没升级的服务端，
 * 读取顺序永远是**新形状优先**（见 `dsh/adapter.ts` 的 `toolResultParts`）。
 */
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

/**
 * 一条会话消息的线格式（0.1.7-rc.1 的 `MessageRoleMap` 判别联合）。
 *
 * 角色面在 0.1.7-alpha.1 变了：工具结果从「role:'user' + `tool-result` 内容块」变成
 * 一等 `role:'tool'` 消息（带 `toolCallId`/`isError`），并新增 `role:'developer'`
 * （工具目录增量的 `developer/message` 事件，见 `SILENT_EVENT_TYPES`）。
 * `role` 本扩展几乎不读（判据一直是 `source.kind`），这里放宽只为形状如实。
 */
export interface WireMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: ContentBlock[];
  source?: { kind: string; [key: string]: unknown };
  /** 工具结果消息与它回答的调用（`role:'tool'` 时必有）。 */
  toolCallId?: string;
  /** 工具结果的失败判据（新形状把它放在消息上，旧形状放在内容块上）。 */
  isError?: boolean;
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

// ---------- 端点参数名（严格校验，见 docs/dsh-server-api.md「端点位置参数名总表」） ----------

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
  /**
   * 某个会话看得见的后台任务名册（`dsh-api-job-controller` 的 `job.list`）。
   *
   * 0.1.7-alpha.1 起 job 从 `session/control` 的 `jobs` 帧搬到这里：帧是**整表替换**
   * （`{type:'rows', jobs}`，打开时一帧、之后每次生命周期变化一帧），所以重连后
   * 第一帧就是真值。旧服务端没有这条流，`session/control` 的 `jobs` 通道仍然读
   * （见 `dsh/controller.ts` 的 `onControlFrame`）。
   */
  jobList: "job/list",
  events: "$events",
} as const;

/**
 * `job/list` 的帧（`JobListFrame`）。
 *
 * 只认 `rows`：契约里这是这条路唯一的帧类型，认不出的帧整条丢掉——把未知帧当
 * 名册用会把面板清空，而「未知」不等于「没有任务」。
 */
export interface JobListFrameWire {
  type: string;
  jobs?: unknown[];
}

/**
 * 一条后台任务的线格式（`dsh-jobs` 的 `JobView`）。
 *
 * 与旧 `session/control` 里的 `SessionJob` 字段相容（`id`/`kind`/`label`/`status`/
 * `detail`/`startedAt`/`finishedAt`），新增 `progress`/`output`/`owner` 等，本扩展
 * 只消费前七个（见 `controller.applyJobs`）。
 */
export interface JobViewWire {
  id: string;
  kind?: string;
  label?: string;
  status?: string;
  progress?: string;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
}

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
 * `command/*` 每次斜杠命令、`llm/retry` 每次模型重试都会命中（docs/audit-summary.md「已知未处理的事件反复触发 warn」一条）。
 *
 * 名单 = dsh-session `KNOWN_SESSION_EVENT_TYPES`（0.1.5-rc.1）减去已渲染的类型、再减去
 * `CONSUMED_EVENT_TYPES`（那些要读内容、只是不出节点）。
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
  // 子代理描述符 / 模型选择策略
  "subagent/descriptor",
  "subagent/model-selection-policy",
  // 工具目录增量（`role:'developer'` 的消息，0.1.7-alpha.1 新增）。
  // 官方把它的内容块（`tool-addition` / `tool-removal`）标为「保留：生产者与消费者
  // 一起实现之前，provider 与 UI 都拒绝」——即这一版还没有生产者会发它。登记为已知
  // 只为不误报「不认识的事件」；真有内容进来时这里是待补的渲染缺口，不是永久决定。
  "developer/message",
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
 * 已知、**被消费**、但不在聊天流里出节点的 durable 事件。
 *
 * 第三类是必要的：`subagent/catalog` 既不该弹「不认识的事件」告警（它很常见），
 * 也不属于「知情静默」——适配器要**读它的内容**把子代理注册进目录（见
 * `adapter.ts` 的 `onSubagentEstablished` 与 `projections.subagentFromCatalogEvent`）。
 * 把它塞进 `SILENT_EVENT_TYPES` 会让「静默」这个名字说谎（那里全是不读内容的簿记事件），
 * 塞进 `RENDERED_EVENT_TYPES` 又会让它被当成「有聊天节点」，两个都不对。
 */
export const CONSUMED_EVENT_TYPES: ReadonlySet<string> = new Set([
  // 父会话的子代理建立事实：读它注册目录（不发聊天节点）
  "subagent/catalog",
]);

/**
 * 本客户端是否认识这个事件类型（渲染的 ∪ 静默的 ∪ 消费的）。
 * 不认识、又没标 `ignorable` 的才需要告警，见 `adapter.ts` 的 default 分支。
 */
export function isKnownEventType(type: string): boolean {
  return RENDERED_EVENT_TYPES.has(type) || SILENT_EVENT_TYPES.has(type) || CONSUMED_EVENT_TYPES.has(type);
}
