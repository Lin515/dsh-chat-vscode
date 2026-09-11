import type {
  ApprovalView,
  MessageView,
  ModelSelectionView,
  QuestionView,
  Segment,
  SessionSummaryView,
  TodoView,
  ToolCallView,
  UsageView,
} from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import {
  RENDERED_EVENT_TYPES,
  type AssistantStreamFrame,
  type ContentBlock,
  type SessionFollowFrame,
  type SessionWireEvent,
  type StreamChunk,
  type TokenUsage,
  type WireMessage,
} from "./protocol";

/** 从内容块里取出纯文本（含工具结果里的嵌套文本）。 */
export function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "reasoning") continue; // 思考单独成段
    else if (block.type === "tool-result") parts.push(blocksToText(block.content));
  }
  return parts.join("\n").trim();
}

function toUsage(usage: TokenUsage | undefined): UsageView | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    cachedTokens: (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: usage.reasoningTokens,
  };
}

/**
 * 解析工具参数，提炼出一行摘要。
 *
 * 刻意**不生成动词文案**：文案属于界面语言，由 webview 的词典决定
 * （否则英文界面里会混进中文标题）。这里只产出与语言无关的数据：
 * 路径、命令行、查询串。
 */
function summarizeTool(name: string, argsRaw: string): { detail?: string; input?: string } {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsRaw || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    return { input: argsRaw };
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const firstLine = (text: string) => text.split("\n")[0].slice(0, 120);

  const lower = name.toLowerCase();
  const path = pick("file_path", "path", "filePath", "filename");
  if (lower.startsWith("read") || lower.startsWith("write") || lower.includes("edit") || lower.includes("replace")) {
    return { detail: path && firstLine(path), input: argsRaw };
  }
  if (lower.includes("pwsh") || lower.includes("bash")) {
    const command = pick("command", "cmd", "script");
    return { detail: command && firstLine(command), input: argsRaw };
  }
  if (lower.includes("grep") || lower.includes("glob")) {
    return { detail: pick("pattern", "query"), input: argsRaw };
  }
  if (lower.includes("web")) return { detail: pick("url", "query"), input: argsRaw };
  if (lower.includes("subagent") || lower.includes("task")) {
    return { detail: pick("description", "prompt")?.slice(0, 80), input: argsRaw };
  }
  return { input: argsRaw };
}

/**
 * 把 DSH 的会话事件流折叠成 Continue 风格的对话记录。
 *
 * 两条来源合并：
 * - durable 事件（历史与提交后的消息），只取表层 `surfaceOp === 'append'` 的事件——
 *   替换式的副本是给模型看的，用它做人类转写会抹掉用户已经看过的内容；
 * - 瞬态的 assistant-stream 帧（逐 token 增量），仅在开了 assistantStream 时才有。
 *
 * 流式文本以「叠加层」形式存在，durable 的 assistant/message 到达时按 turn/step
 * 替换掉该叠加层，因此不会重复也不会丢内容。
 */
export class SessionAdapter {
  private messages: MessageView[] = [];
  private readonly byId = new Map<string, MessageView>();
  private readonly toolSegments = new Map<string, { messageId: string; segmentId: string }>();
  private readonly liveSegments = new Map<string, { messageId: string; segmentId: string; turn: number; step: number }>();
  private currentTurn: number | undefined;
  private currentStep = 0;
  private turnStartedAt: number | undefined;
  /** 当前活跃 attempt 的 turn/step，由 assistant-stream 的 start 帧给出。 */
  private liveTurn = 0;
  private liveStep = 0;
  private sequence = 0;

  constructor(private readonly emit: (frame: HostToWebview) => void) {}

  snapshotMessages(): MessageView[] {
    return this.messages;
  }

  // ---------- 帧入口 ----------

  applyFrame(frame: SessionFollowFrame): void {
    if (frame.type === "snapshot") {
      this.reset();
      for (const record of frame.records ?? []) {
        if (record?.type === "event") this.applyEvent(record.event);
      }
      this.emit({ type: "patch", patch: { hasMoreHistory: Boolean(frame.hasMore) } });
      const title = frame.projections?.values?.title;
      if (typeof title === "string" && title) {
        this.emit({ type: "patch", patch: { session: this.sessionWithTitle(title) } });
      }
      this.emit({ type: "messages/reset", messages: this.messages });
      return;
    }
    if (frame.type === "event") {
      this.applyEvent(frame.event);
      return;
    }
    if (frame.type === "assistant-stream") {
      this.applyAssistantStream(frame.frame);
    }
  }

  // ---------- durable 事件 ----------

  applyEvent(event: SessionWireEvent): void {
    // 替换式的表层事件是模型视图，不是人类转写
    if (event.surfaceOp && typeof event.surfaceOp === "object") return;

    const data = (event.data ?? {}) as Record<string, any>;
    switch (event.type) {
      case "turn/start": {
        this.currentTurn = typeof data.turn === "number" ? data.turn : this.currentTurn;
        this.currentStep = 0;
        this.turnStartedAt = event.time;
        const message = this.ensureAssistantMessage(event.time);
        message.streaming = true;
        this.emit({ type: "patch", patch: { running: true } });
        this.emit({ type: "message/upsert", message: { ...message } });
        break;
      }

      case "turn/end": {
        const message = this.ensureAssistantMessage(event.time);
        message.streaming = false;
        if (this.turnStartedAt) message.durationMs = Math.max(0, event.time - this.turnStartedAt);
        const reason = data.reason as { kind?: string; error?: { message?: string } } | undefined;
        if (reason?.kind === "error") {
          // 模型/服务端的原始报错原样透出；没有报文时用语言中立 key 交给界面翻译
          message.error = reason.error?.message ?? "@turnFailed";
        } else if (reason?.kind === "aborted") {
          this.pushSegment(message, {
            kind: "notice",
            id: `n${event.seq}`,
            level: "warn",
            text: "@stopped",
          });
        }
        this.emit({ type: "message/upsert", message: { ...message } });
        this.emit({ type: "patch", patch: { running: false } });
        this.turnStartedAt = undefined;
        break;
      }

      case "step/start":
        this.currentStep = typeof data.step === "number" ? data.step : 0;
        break;

      case "user/message": {
        const message = data as WireMessage;
        const kind = message?.source?.kind;
        const text = blocksToText(message?.content);
        if (kind === "user" || kind === "user-rpc") {
          if (!text) break;
          const view: MessageView = {
            id: `u:${event.seq}`,
            role: "user",
            ts: event.time,
            text,
            segments: [],
          };
          // 日志里 turn/start 可能先于 user/message 落盘，而 turn/start 已经建好了
          // 本轮的助手消息；此时把用户消息插到它前面，保证对话顺序正确。
          const assistant = this.currentAssistantMessage();
          const index = assistant ? this.messages.indexOf(assistant) : -1;
          if (assistant && index >= 0 && assistant.segments.length === 0) {
            this.messages.splice(index, 0, view);
            this.byId.set(view.id, view);
            this.emit({ type: "messages/reset", messages: this.messages });
          } else {
            this.appendMessage(view);
          }
        }
        // 其余来源（system prompt / agent instructions / goal / skill）不是用户输入，
        // 与 Continue 一致地不进转写
        break;
      }

      case "assistant/message": {
        this.applyAssistantMessage(event, data);
        break;
      }

      case "tool/call": {
        const callId = String(data.callId ?? "");
        if (!callId) break;
        const name = String(data.name ?? "tool");
        const argsRaw = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {});
        this.upsertToolCall(event.time, callId, name, argsRaw);
        break;
      }

      case "tool/result": {
        const message = data.message as WireMessage | undefined;
        const callId = String(message?.source?.callId ?? "");
        const text = blocksToText(message?.content);
        const isError = Boolean(data.error) || (Array.isArray(message?.content) && (message!.content as ContentBlock[]).some((b) => b.type === "tool-result" && b.isError));
        this.finishToolCall(event.time, callId, text, isError);
        break;
      }

      case "session/title": {
        const title = typeof data.title === "string" ? data.title : undefined;
        if (title) this.emit({ type: "patch", patch: { session: this.sessionWithTitle(title) } });
        break;
      }

      case "todo/write": {
        const todos = Array.isArray(data.todos) ? data.todos : [];
        const view: TodoView[] = todos.map((todo: any, index: number) => ({
          id: String(todo?.id ?? index),
          content: String(todo?.content ?? todo?.text ?? ""),
          status: todo?.status === "completed" ? "completed" : todo?.status === "in_progress" ? "in_progress" : "pending",
        }));
        this.emit({ type: "todos", todos: view });
        break;
      }

      case "plan/mode":
        this.emit({ type: "patch", patch: { planMode: Boolean(data.active) } });
        break;

      case "permission/preset":
        if (typeof data.preset === "string") this.emit({ type: "patch", patch: { permission: data.preset } });
        break;

      case "sandbox/mode":
        if (typeof data.mode === "string") this.emit({ type: "patch", patch: { permission: data.mode } });
        break;

      case "model/selection": {
        if (typeof data.provider === "string" && typeof data.model === "string") {
          this.emit({
            type: "patch",
            patch: {
              model: {
                provider: data.provider,
                model: data.model,
                label: String(data.model),
                ...(typeof data.reasoningEffort === "string" ? { reasoningEffort: data.reasoningEffort } : {}),
              } satisfies ModelSelectionView,
            },
          });
        }
        break;
      }

      case "deliverables/presented": {
        const files = Array.isArray(data.files) ? data.files : [];
        const message = this.currentAssistantMessage() ?? this.ensureAssistantMessage(event.time);
        message.deliverables = files.map((file: any) => ({
          path: String(file?.path ?? ""),
          description: typeof file?.description === "string" ? file.description : undefined,
        }));
        this.emit({ type: "message/upsert", message: { ...message } });
        break;
      }

      case "compaction/summary": {
        const message = this.ensureAssistantMessage(event.time);
        this.pushSegment(message, {
          kind: "notice",
          id: `n${event.seq}`,
          level: "info",
          text: "@compacted",
        });
        this.emit({ type: "message/upsert", message: { ...message } });
        break;
      }

      default: {
        // 未知事件：有 ignorable 才允许安全跳过，否则明确提示（协议要求）
        if (!RENDERED_EVENT_TYPES.has(event.type) && !event.ignorable) {
          this.emit({
            type: "toast",
            level: "warn",
            text: `@unknownEvent:${event.type}`,
          });
        }
        break;
      }
    }
  }

  private applyAssistantMessage(event: SessionWireEvent, data: Record<string, any>): void {
    const turn = typeof data.turn === "number" ? data.turn : this.currentTurn ?? 0;
    const step = typeof data.step === "number" ? data.step : this.currentStep;
    const message = this.ensureAssistantMessage(event.time);
    const wire = data.message as WireMessage | undefined;

    // 丢弃该 step 的流式叠加层，改用 durable 内容，避免重复
    this.dropLiveSegments(message, turn, step);

    const content = Array.isArray(wire?.content) ? (wire!.content as ContentBlock[]) : [];
    for (const block of content) {
      if (block.type === "text" && block.text.trim()) {
        this.pushSegment(message, { kind: "text", id: `t${event.seq}:${this.sequence++}`, text: block.text });
      } else if (block.type === "reasoning" && block.text.trim()) {
        this.pushSegment(message, { kind: "thinking", id: `r${event.seq}:${this.sequence++}`, text: block.text });
      }
    }

    const usage = toUsage(data.usage);
    if (usage) message.usage = usage;
    if (wire?.source?.kind === "model" && typeof wire.source.model === "string") {
      message.model = wire.source.model;
    }
    if (data.interrupted) message.error = "@interrupted";
    this.emit({ type: "message/upsert", message: { ...message } });
  }

  // ---------- 瞬态流式帧 ----------

  applyAssistantStream(frame: AssistantStreamFrame): void {
    if (frame.type === "start") {
      this.currentTurn = frame.turn;
      this.currentStep = frame.step;
      this.liveTurn = frame.turn;
      this.liveStep = frame.step;
      const message = this.ensureAssistantMessage(Date.now());
      message.streaming = true;
      this.emit({ type: "message/upsert", message: { ...message } });
      return;
    }
    if (frame.type === "end") {
      if (frame.outcome.kind === "abandoned") {
        this.dropLiveSegments(
          this.ensureAssistantMessage(Date.now()),
          this.currentTurn ?? 0,
          this.currentStep,
          true,
        );
      }
      return;
    }

    const chunk: StreamChunk = frame.chunk;
    const message = this.ensureAssistantMessage(Date.now());
    // 段落按「块下标」区分：同一次尝试里 index 稳定，用它当 segment id 的组成部分
    const blockIndex = "index" in chunk ? chunk.index : 0;
    const liveId = `live:${frame.attemptId}:${blockIndex}`;

    switch (chunk.type) {
      case "block-start":
        break;

      case "text-delta": {
        const existing = this.liveSegments.get(liveId);
        if (existing) {
          this.emit({ type: "message/delta", messageId: message.id, segmentId: existing.segmentId, delta: chunk.text });
          break;
        }
        const segmentId = liveId;
        this.liveSegments.set(liveId, {
          messageId: message.id,
          segmentId,
          turn: this.liveTurn,
          step: this.liveStep,
        });
        const segment: Segment = { kind: "text", id: segmentId, text: chunk.text, streaming: true };
        this.pushSegment(message, segment);
        this.emit({ type: "message/append", messageId: message.id, segment });
        break;
      }

      case "reasoning-delta": {
        const existing = this.liveSegments.get(liveId);
        if (existing) {
          this.emit({ type: "message/delta", messageId: message.id, segmentId: existing.segmentId, delta: chunk.text });
          break;
        }
        const segmentId = liveId;
        this.liveSegments.set(liveId, {
          messageId: message.id,
          segmentId,
          turn: this.liveTurn,
          step: this.liveStep,
        });
        const segment: Segment = { kind: "thinking", id: segmentId, text: chunk.text, streaming: true };
        this.pushSegment(message, segment);
        this.emit({ type: "message/append", messageId: message.id, segment });
        break;
      }

      case "tool-call-delta": {
        const callId = chunk.id || `live-tool-${liveId}`;
        const existing = this.toolSegments.get(callId);
        if (!existing) {
          this.upsertToolCall(Date.now(), callId, chunk.name ?? "tool", chunk.argumentsDelta, message.id);
        } else {
          const target = this.byId.get(existing.messageId);
          const segment = target?.segments.find((s) => s.id === existing.segmentId);
          if (target && segment && segment.kind === "tool") {
            segment.tool.input = (segment.tool.input ?? "") + chunk.argumentsDelta;
            segment.tool.status = "running";
            this.emit({ type: "message/segment", messageId: target.id, segment: { ...segment } });
          }
        }
        break;
      }

      case "usage": {
        const usage = toUsage(chunk.usage);
        if (usage) {
          message.usage = usage;
          this.emit({ type: "message/upsert", message: { ...message } });
        }
        break;
      }

      default:
        break;
    }
  }

  // ---------- 内部工具 ----------

  private reset(): void {
    this.messages = [];
    this.byId.clear();
    this.toolSegments.clear();
    this.liveSegments.clear();
    this.currentTurn = undefined;
    this.currentStep = 0;
    this.sequence = 0;
  }

  private currentSession: SessionSummaryView | undefined;

  setSession(session: SessionSummaryView): void {
    this.currentSession = session;
  }

  /** 标题来自 session/title 事件或投影，会话本体可能还没建立。 */
  private sessionWithTitle(title: string): SessionSummaryView {
    if (this.currentSession) {
      this.currentSession = { ...this.currentSession, title };
      return this.currentSession;
    }
    this.currentSession = { id: "", title, updatedAt: Date.now(), running: false };
    return this.currentSession;
  }

  private ensureAssistantMessage(ts: number): MessageView {
    const turn = this.currentTurn ?? 0;
    const id = `a:${turn}`;
    let message = this.byId.get(id);
    if (!message) {
      message = { id, role: "assistant", ts, segments: [] };
      this.appendMessage(message);
    }
    return message;
  }

  private currentAssistantMessage(): MessageView | undefined {
    if (this.currentTurn === undefined) return undefined;
    return this.byId.get(`a:${this.currentTurn}`);
  }

  private appendMessage(message: MessageView): void {
    this.messages.push(message);
    this.byId.set(message.id, message);
    this.emit({ type: "message/upsert", message: { ...message } });
  }

  private pushSegment(message: MessageView, segment: Segment): void {
    message.segments.push(segment);
  }

  private dropLiveSegments(message: MessageView, turn: number, step: number, all = false): void {
    let changed = false;
    for (const [key, value] of [...this.liveSegments]) {
      if (value.messageId !== message.id) continue;
      if (!all && (value.turn !== turn || value.step !== step)) continue;
      const index = message.segments.findIndex((s) => s.id === value.segmentId);
      if (index >= 0) {
        message.segments.splice(index, 1);
        changed = true;
      }
      this.liveSegments.delete(key);
    }
    if (changed) this.emit({ type: "message/upsert", message: { ...message } });
  }

  private upsertToolCall(ts: number, callId: string, name: string, argsRaw: string, messageId?: string): void {
    const message = (messageId ? this.byId.get(messageId) : undefined) ?? this.ensureAssistantMessage(ts);
    const summary = summarizeTool(name, argsRaw);
    const existing = this.toolSegments.get(callId);
    if (existing) {
      const target = this.byId.get(existing.messageId);
      const segment = target?.segments.find((s) => s.id === existing.segmentId);
      if (target && segment && segment.kind === "tool") {
        segment.tool.name = name;
        segment.tool.detail = summary.detail;
        segment.tool.input = argsRaw;
        this.emit({ type: "message/segment", messageId: target.id, segment: { ...segment } });
      }
      return;
    }
    const segmentId = `tool:${callId}`;
    const tool: ToolCallView = {
      id: callId,
      name,
      // title 留空：动词由界面按当前语言渲染（见 webview/components/Rows.tsx）
      title: "",
      detail: summary.detail,
      status: "running",
      input: argsRaw,
      startedAt: ts,
    };
    const segment: Segment = { kind: "tool", id: segmentId, tool };
    this.pushSegment(message, segment);
    this.toolSegments.set(callId, { messageId: message.id, segmentId });
    this.emit({ type: "message/append", messageId: message.id, segment: { ...segment, tool: { ...tool } } as Segment });
  }

  private finishToolCall(ts: number, callId: string, output: string, isError: boolean): void {
    const entry = this.toolSegments.get(callId);
    if (!entry) return;
    const message = this.byId.get(entry.messageId);
    const segment = message?.segments.find((s) => s.id === entry.segmentId);
    if (!message || !segment || segment.kind !== "tool") return;
    segment.tool.status = isError ? "error" : "ok";
    segment.tool.output = output;
    segment.tool.endedAt = ts;
    this.emit({ type: "message/segment", messageId: message.id, segment: { ...segment, tool: { ...segment.tool } } as Segment });
  }

  /** 追加一个审批卡片到当前回合。 */
  addApproval(approval: ApprovalView): void {
    const message = this.ensureAssistantMessage(Date.now());
    const segment: Segment = { kind: "approval", id: `ap:${approval.requestId}`, approval };
    this.pushSegment(message, segment);
    this.emit({ type: "message/append", messageId: message.id, segment });
  }

  resolveApproval(requestId: string, state: ApprovalView["state"]): void {
    for (const message of this.messages) {
      const segment = message.segments.find((s) => s.kind === "approval" && s.approval.requestId === requestId);
      if (segment && segment.kind === "approval") {
        segment.approval.state = state;
        this.emit({ type: "message/segment", messageId: message.id, segment: { ...segment, approval: { ...segment.approval } } as Segment });
      }
    }
  }

  /** 追加一个提问卡片到当前回合。 */
  addQuestion(question: QuestionView): void {
    const message = this.ensureAssistantMessage(Date.now());
    const segment: Segment = { kind: "question", id: `q:${question.requestId}`, question };
    this.pushSegment(message, segment);
    this.emit({ type: "message/append", messageId: message.id, segment });
  }

  resolveQuestion(requestId: string): void {
    for (const message of this.messages) {
      const segment = message.segments.find((s) => s.kind === "question" && s.question.requestId === requestId);
      if (segment && segment.kind === "question") {
        segment.question.state = "answered";
        this.emit({ type: "message/segment", messageId: message.id, segment: { ...segment, question: { ...segment.question } } as Segment });
      }
    }
  }
}
