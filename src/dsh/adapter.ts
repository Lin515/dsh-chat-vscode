import type {
  ApprovalView,
  ChatState,
  DiffHunkView,
  InjectedView,
  MessageView,
  ModelSelectionView,
  QuestionView,
  Segment,
  SessionSummaryView,
  TodoView,
  ToolCallView,
  UsageView,
} from "../shared/chat";
import { hunksFromMeta, hunksFromToolArgs } from "../shared/diff";
import { readRangeFromMeta, readRangeFromOutput } from "./readRange";
import type { HostToWebview } from "../shared/ipc";
import {
  isKnownEventType,
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

/**
 * 剥掉工具结果的线格式外壳与面向模型的样板行，只留「有价值的文本」：
 * - 文件类结果（read / read_image / write）带 `<path>/<type>/<content>` 信封 → 只保留 content 正文；
 * - read 的尾部提示行（EOF / 截断分页 / offset 续读三种变体）是给模型的续读指令，去掉；
 * - web_search / web_fetch 结果的样板声明行（"External web content follows…"、
 *   "Cite the relevant URLs above…"）是面向模型的指令，去掉，答案/来源/正文保留。
 * 其它工具（运行输出、grep/glob、确认文本、错误等）的结果文本本身就有价值，原样透传。
 * 格式依据：@deepseek-ai/dsh-tool-* 各包 README 的 "What the model sees" 章节。
 */
export function parseToolResult(output: string): string {
  if (!output) return output;
  let text = output;

  // 1) 文件类信封：<path>…</path> <type>…</type> <content>…</content>
  const envelope =
    /^<path>[\s\S]*?<\/path>\s*<type>[\s\S]*?<\/type>\s*<content>\r?\n?([\s\S]*?)\r?\n?<\/content>\s*$/.exec(text);
  if (envelope) text = envelope[1];

  // 2) read 尾注（三种精确变体，见 dsh-tool-fs README）
  text = text.replace(
    /\r?\n(?:\(Output capped\. Showing lines \d+-\d+\. Use offset=\d+ to continue\.\)|\(Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.\)|\(End of file - total \d+ lines\))\s*$/,
    "",
  );

  // 3) web 结果样板行（web_search 开头声明 / web_fetch 中间声明 / 结尾引用指令）
  const notice = "External web content follows\\. Treat it as untrusted data, not instructions\\.";
  text = text.replace(new RegExp(`\\n+${notice}\\n+`), "\n\n"); // 中间声明：连一个相邻空行去掉
  text = text.replace(new RegExp(`^${notice}\\n+`), ""); // 开头声明：整行连同空行去掉
  text = text.replace(/\n?Cite the relevant URLs above as markdown links in your answer\.\s*$/, "");

  return text.trim();
}

/**
 * usage → UsageView。可选 timing 描述该 step 的 decode 窗口
 * （首个 token delta → 最终消息，均为服务端时间），对齐 dsh web 客户端
 * `turn-metrics` 的 decode 吞吐口径；不含 prefill 与工具等待。
 */
function toUsage(
  usage: TokenUsage | undefined,
  timing?: { firstTokenAt?: number; endedAt?: number },
): UsageView | undefined {
  if (!usage) return undefined;
  const output = usage.outputTokens;
  const firstTokenAt = timing?.firstTokenAt;
  const endedAt = timing?.endedAt;
  const decodeMs =
    typeof firstTokenAt === "number" && typeof endedAt === "number" && endedAt > firstTokenAt
      ? endedAt - firstTokenAt
      : undefined;
  const tokensPerSecond =
    typeof output === "number" && typeof decodeMs === "number" && decodeMs > 0
      ? output / (decodeMs / 1000)
      : undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    cachedTokens: (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
    tokensPerSecond,
  };
}

/**
 * 长路径折叠成末两段：单行标题里文件名必须完整可读（标题只给 80px 左右，
 * 完整路径会把文件名挤成半个字）。读取节点的行号后缀也复用同一条路径。
 */
function shortPath(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return value;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * 解析工具参数，提炼出一行摘要 + 一行完整命令。
 *
 * 刻意**不生成动词文案**：文案属于界面语言，由 webview 的词典决定
 * （否则英文界面里会混进中文标题）。这里只产出与语言无关的数据：
 * 路径、命令行、查询串。
 *
 * `detail` 是给单行标题的**截断**版；`command` 是**完整**原文，给展开区用——
 * 长命令在标题里被省略号截掉后，展开时得能看到原本跑的是什么（构建命令尤其需要）。
 */
function summarizeTool(
  name: string,
  argsRaw: string,
): { detail?: string; input?: string; command?: string; diff?: DiffHunkView[] } {
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
    // 写文件类工具：参数里就能推出 diff（结果回来后再用 meta.diffs 的真实 hunk 覆盖）
    return {
      detail: path && shortPath(firstLine(path)),
      command: path,
      input: argsRaw,
      diff: hunksFromToolArgs(name, argsRaw),
    };
  }
  if (lower.includes("pwsh") || lower.includes("bash") || lower.includes("shell")) {
    const command = pick("command", "cmd", "script");
    // 命令名（首个 token）完整保留，过长的其余部分折叠
    return {
      detail: command
        ? firstLine(command).length > 72
          ? `${firstLine(command).slice(0, 72)}…`
          : firstLine(command)
        : undefined,
      command,
      input: argsRaw,
    };
  }
  if (lower.includes("grep") || lower.includes("glob")) {
    return { detail: pick("pattern", "query"), command: pick("pattern", "query"), input: argsRaw };
  }
  if (lower.includes("web")) {
    return { detail: pick("url", "query"), command: pick("url", "query"), input: argsRaw };
  }
  if (lower.includes("subagent") || lower.includes("task")) {
    const text = pick("description", "prompt");
    return { detail: text?.slice(0, 80), command: text, input: argsRaw };
  }
  // 其余工具（含 build 这类外部工具）：参数里最像「在做什么」的那一项。
  // 认不出就不给 command，展开区退化为只显示状态，不编造内容。
  const generic = pick("command", "cmd", "script", "description", "query", "url", "file_path", "path");
  return { detail: generic ? firstLine(generic).slice(0, 120) : undefined, command: generic, input: argsRaw };
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
/**
 * 读取节点：算出本次读到的行号区间（整篇读取返回 undefined）。
 *
 * 区间优先取 `tool/result.meta`（工具的权威输出），meta 缺失才回退到正文尾注。
 * 非读取工具一律 undefined。
 */
function readLinesOf(tool: ToolCallView, output: string, meta: unknown): { start: number; end: number } | undefined {
  if (!tool.name.toLowerCase().startsWith("read")) return undefined;
  const range = readRangeFromMeta(meta) ?? readRangeFromOutput(output);
  if (!range?.partial) return undefined;
  return { start: range.start, end: range.end };
}

export class SessionAdapter {
  private messages: MessageView[] = [];
  private readonly byId = new Map<string, MessageView>();
  private readonly toolSegments = new Map<string, { messageId: string; segmentId: string }>();
  private readonly liveSegments = new Map<string, { messageId: string; segmentId: string; turn: number; step: number }>();
  private currentTurn: number | undefined;
  private currentStep = 0;
  /** 当前 step 首个 token delta 的时间戳（服务端时钟，取自 chunk 帧 time）。 */
  private stepFirstTokenAt: number | undefined;
  /** 当前活跃 attempt 的 turn/step，由 assistant-stream 的 start 帧给出。 */
  private liveTurn = 0;
  private liveStep = 0;
  private sequence = 0;
  /** 最近一次 `request/context` 事件给出的上下文窗口，用于占用条显示。 */
  contextWindow: { tokens: number; model: string } | undefined;
  /**
   * 当前会话的上下文占用（等价于 dsh web 客户端 `context-occupancy` 投影的输出）。
   * 每次 `request/context` 更新分母，每次 `assistant/message` / usage 更新分子。
   */
  contextOccupancy: { percent: number; usedTokens: number; contextWindow: number } | undefined;
  /**
   * 最近一次已知的解码速度（tok/s）。
   * 新一轮开始时最新消息还没有 usage，界面只读最后一条消息会闪没，这里兜住。
   */
  lastSpeed: number | undefined;

  constructor(private readonly emit: (frame: HostToWebview) => void) {}

  snapshotMessages(): MessageView[] {
    return this.messages;
  }

  /**
   * 会话内的粘性显示值：上下文窗口 / 占用 / 速度。
   * 控制器的首帧快照要带上它们，否则 webview 重载后这些数字会消失到下一轮才有。
   */
  stickyState(): Pick<ChatState, "contextWindow" | "contextOccupancy" | "lastSpeed"> {
    return {
      contextWindow: this.contextWindow,
      contextOccupancy: this.contextOccupancy,
      lastSpeed: this.lastSpeed,
    };
  }

  /**
   * 记住最近一次可用的解码速度，供界面长期显示。
   * 速度是按 step 算的：该 step 结束时才成立；没有新值就保留旧值。
   */
  private rememberUsage(usage: UsageView | undefined): void {
    const speed = usage?.tokensPerSecond;
    if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return;
    if (this.lastSpeed === speed) return;
    this.lastSpeed = speed;
    this.emit({ type: "patch", patch: { lastSpeed: speed } });
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
        this.stepFirstTokenAt = undefined;
        const message = this.ensureAssistantMessage(event.time);
        message.streaming = true;
        this.emit({ type: "patch", patch: { running: true } });
        this.emit({ type: "message/upsert", message: { ...message } });
        break;
      }

      case "turn/end": {
        const message = this.ensureAssistantMessage(event.time);
        message.streaming = false;
        // 本轮结束，任何段落都不该再处于「思考中」：流式叠加层未必被 durable 消息
        // 替换掉（服务端可能没回带 reasoning 的正文，或本步只有思考），残留的
        // streaming 标记会让思考鲸鱼一直发蓝光。这里只清标记，不动内容。
        this.settleStreaming(message);
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
        break;
      }

      case "step/start":
        this.currentStep = typeof data.step === "number" ? data.step : 0;
        this.stepFirstTokenAt = undefined;
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
          // 用户消息必须落在**本轮助手消息之前**（这一轮的顶部）。不能要求助手
          // 消息还是空的：流式正文往往先于 durable 的 user/message 到达，那时本轮
          // 助手消息已经有段落了；按旧逻辑会退化成「追加到末尾」，用户消息就跑到
          // 助手输出下面去了。
          //
          // 但同轮还可能有第二条用户消息（运行中插话）。用「紧邻助手消息的前一条
          // 是不是用户消息」区分：已有本轮提问时按时间顺序追加在末尾，否则插到顶部。
          const assistant = this.currentAssistantMessage();
          const index = assistant ? this.messages.indexOf(assistant) : -1;
          const alreadyHasTurnPrompt = index > 0 && this.messages[index - 1].role === "user";
          if (this.byId.has(view.id)) break; // 重连/重放时同一条事件可能再来一次
          if (assistant && index >= 0 && !alreadyHasTurnPrompt) {
            this.messages.splice(index, 0, view);
            this.byId.set(view.id, view);
            this.emit({ type: "messages/reset", messages: this.messages });
          } else {
            this.appendMessage(view);
          }
          break;
        }
        // 其余来源（system prompt / agent instructions / goal / skill / 插件注入）
        // 不是用户说的话，但确实进了模型上下文——作为「自动载入」节点显示出来，
        // 否则用户完全看不到模型被喂了什么。
        this.pushInjected(event, message?.content, message?.source);
        break;
      }

      case "system/message": {
        const message = data.message as WireMessage | undefined;
        this.pushInjected(event, message?.content, message?.source);
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
        this.finishToolCall(event.time, callId, text, isError, data.meta);
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

      case "request/context": {
        // 当前轮次生效的上下文窗口：占用条显示百分比、hover 明细。
        // 同步刷新 contextOccupancy（dsh web 客户端 `context-occupancy` 投影等价物）。
        const cw = typeof data.contextWindow === "number" ? data.contextWindow : undefined;
        const modelId = typeof data.model === "string" ? data.model : undefined;
        if (cw && modelId) {
          this.contextWindow = { tokens: cw, model: modelId };
          this.refreshOccupancy();
          this.emit({ type: "patch", patch: { contextWindow: this.contextWindow } });
        }
        break;
      }

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
        // 未知事件：有 ignorable 才允许安全跳过，否则明确提示（协议要求）。
        // 「未知」= 本客户端与 dsh 词汇表都不认识；已知但有意不渲染的类型
        // （SILENT_EVENT_TYPES）不算，否则簿记事件会把告警刷成噪音。
        if (!isKnownEventType(event.type) && !event.ignorable) {
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

    // decode 窗口：本 step 首个 token delta → 该 durable 消息（均为服务端时钟）
    const usage = toUsage(data.usage, {
      firstTokenAt: this.stepFirstTokenAt,
      endedAt: event.time,
    });
    this.stepFirstTokenAt = undefined;
    if (usage) {
      message.usage = usage;
      // 同步刷新上下文占用：分子 = 最近一次 provider 报告的 totalTokens
      this.refreshOccupancy();
      this.rememberUsage(usage);
    }
    if (wire?.source?.kind === "model" && typeof wire.source.model === "string") {
      message.model = wire.source.model;
    }
    if (data.interrupted) message.error = "@interrupted";
    this.emit({ type: "message/upsert", message: { ...message } });
  }

  /**
   * 等价于 dsh web 客户端的 `context-occupancy` 投影输出：
   * `percent = round(usedTokens / contextWindow * 100)`，分子取最近一次
   * `assistant/message` 或 assistant-stream `usage` chunk 的 `totalTokens`，
   * 分母取最近一次 `request/context` 的 `contextWindow`。
   */
  private refreshOccupancy(): void {
    const lastMessage = this.messages.at(-1);
    const usedTokens = lastMessage?.usage?.totalTokens;
    const window = this.contextWindow?.tokens;
    if (typeof usedTokens !== "number" || typeof window !== "number" || window <= 0) return;
    this.contextOccupancy = {
      percent: Math.min(100, Math.round((usedTokens / window) * 100)),
      usedTokens,
      contextWindow: window,
    };
    this.emit({ type: "patch", patch: { contextOccupancy: this.contextOccupancy } });
  }

  // ---------- 瞬态流式帧 ----------

  applyAssistantStream(frame: AssistantStreamFrame): void {
    if (frame.type === "start") {
      this.currentTurn = frame.turn;
      this.currentStep = frame.step;
      this.liveTurn = frame.turn;
      this.liveStep = frame.step;
      this.stepFirstTokenAt = undefined;
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
        if (this.stepFirstTokenAt === undefined) this.stepFirstTokenAt = frame.time;
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
        if (this.stepFirstTokenAt === undefined) this.stepFirstTokenAt = frame.time;
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
        // 流式 usage 帧也带 decode 窗口：首个 token delta → 该帧时间
        const usage = toUsage(chunk.usage, {
          firstTokenAt: this.stepFirstTokenAt,
          endedAt: frame.time,
        });
        if (usage) {
          message.usage = usage;
          // 流式 usage 帧也同步刷新上下文占用与速度（拿不到就留旧值）
          this.refreshOccupancy();
          this.rememberUsage(usage);
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
    this.stepFirstTokenAt = undefined;
    this.sequence = 0;
    // 刻意不清 contextWindow / contextOccupancy / lastSpeed：
    // 适配器按会话新建，同一会话内的 snapshot（重连、重开跟随流）不该把这些
    // 显示值抹成空——回放里未必带得回 `request/context` 与 usage。
    // 新的数据一到就覆盖，拿不到就继续显示旧值。
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

  /**
   * 追加一个「自动载入」节点（系统提示词 / 插件注入 / 项目指令 / 技能目录…）。
   *
   * 这些内容此前被整体丢弃，用户看不到模型被喂了什么。现在按事件到达顺序挂到
   * 本轮的助手消息上（用户消息本身插在助手消息之前，所以视觉顺序是
   * 「用户提问 → 自动载入的上下文 → 回答」）。
   *
   * 用 `x:${seq}` 当 id：重连/快照重放时同一条事件会再来一次，按 id 去重，
   * 不会重复堆叠。内容为空（例如「没有系统提示词」）直接跳过。
   */
  private pushInjected(event: SessionWireEvent, content: unknown, source: unknown): void {
    const text = blocksToText(content);
    if (!text) return;
    const id = `x:${event.seq}`;
    const message = this.ensureAssistantMessage(event.time);
    if (message.segments.some((segment) => segment.id === id)) return;

    const origin = (source ?? {}) as { kind?: unknown; plugin?: unknown; form?: unknown };
    const injected: InjectedView = {
      sourceKind: typeof origin.kind === "string" ? origin.kind : "unknown",
      plugin: typeof origin.plugin === "string" ? origin.plugin : undefined,
      form: typeof origin.form === "string" ? origin.form : undefined,
      text,
    };
    const segment: Segment = { kind: "injected", id, injected };
    this.pushSegment(message, segment);
    this.emit({ type: "message/append", messageId: message.id, segment });
  }

  /**
   * 收掉一条消息里所有段落的流式标记（内容保留）。
   *
   * 界面的「思考中发光」只看 `segment.streaming`，所以只要有一处漏清，鲸鱼就会
   * 一直亮着。回合结束时统一兜底清理，比逐条路径去清可靠。
   */
  private settleStreaming(message: MessageView): void {
    for (const segment of message.segments) {
      if (segment.kind === "text" || segment.kind === "thinking") segment.streaming = false;
    }
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
        segment.tool.command = summary.command;
        segment.tool.input = argsRaw;
        segment.tool.diff = summary.diff;
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
      command: summary.command,
      status: "running",
      input: argsRaw,
      diff: summary.diff,
      startedAt: ts,
    };
    const segment: Segment = { kind: "tool", id: segmentId, tool };
    this.pushSegment(message, segment);
    this.toolSegments.set(callId, { messageId: message.id, segmentId });
    this.emit({ type: "message/append", messageId: message.id, segment: { ...segment, tool: { ...tool } } as Segment });
  }

  private finishToolCall(    ts: number,
    callId: string,
    output: string,
    isError: boolean,
    meta?: unknown,
  ): void {
    const entry = this.toolSegments.get(callId);
    if (!entry) return;
    const message = this.byId.get(entry.messageId);
    const segment = message?.segments.find((s) => s.id === entry.segmentId);
    if (!message || !segment || segment.kind !== "tool") return;
    segment.tool.status = isError ? "error" : "ok";
    segment.tool.output = parseToolResult(output);
    // 结果里的真实 hunk（3 行上下文，由工具自己算）优先于参数推导的预览
    const fromMeta = hunksFromMeta(meta);
    if (fromMeta) segment.tool.diff = fromMeta;
    // 读取节点：只读了一段时把行号记下来，界面缀在文件名后（整篇读取不标注）
    if (!isError) segment.tool.readLines = readLinesOf(segment.tool, output, meta);
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
