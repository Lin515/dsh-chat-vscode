/**
 * 「轨迹」的宿主侧折叠：把 durable 会话事件折成官方那种**账本**（turn → cell）。
 *
 * ## 为什么是「第二次折叠」
 *
 * 官方的轨迹视图（`dsh-client-ui-trajectory`）**不是**服务端接口、也不是投影：
 * 它是客户端对**同一份 durable 事件窗口**做的第二次独立折叠（8 个
 * `ConversationNodeDefinition` 各自贡献 `TrajectoryContribution`，
 * `TrajectorySnapshotBuilder` 合并，视图再折成 turn → group → cell）。
 * `session/follow` + `session/page` 就是它的**全部**输入——所以本扩展不需要任何
 * 新 RPC，需要的只是**同一份事件的另一套折叠**（聊天流那套在 `adapter.ts` 里，
 * 口径是「人类转写」，不是「账本」）。
 *
 * 完整规格（含官方逐行证据、175 条文案、分步计划）见 `docs/design-trajectory.md`。
 *
 * ## 与官方实现的刻意差异（都写在这里，免得下次当成 bug 查）
 *
 * 1. **流式中的助手正文**（官方 `PartialAssistant`）不单独出行：官方把「未结算的
 *    助手流」折成一条 `requestOnly` 行，本扩展的流式叠加层语义与它不同，映射错会
 *    出现重复行。这里只出**已结算**的 `assistant/message`，加上「已发起未结算」的
 *    工具行（这两类是 durable 的，不会重复）。
 * 2. **系统提示词的独立更新**按 `request/header` 的变化合并：`system/message` 自己
 *    的多次改写不单独出行（官方会出）。初始与「变了」两种都在。
 * 3. **`session/end-seed`** 不产生行（官方也只是一条边界），只用来标记「is-seed」。
 * 4. **请求编号**按 `step/start` / `compaction/start` 递增，与官方从
 *    `RequestView.startSeq` 派生的编号在**常见情形**下一致（每个 step 一次请求）。
 * 5. 时间线**不在本层**（第一步不做），但 `startedAt` / `timeSeconds` /
 *    `assistantMetrics` 已经算好并存下，第二步直接用。
 *
 * 纯函数、不引 vscode：断言见 `scripts/trajectory.test.ts`。
 */
import type { SessionWireEvent } from "./protocol";
import { blocksToText } from "./adapter";
import type {
  TrajectoryCell,
  TrajectoryModel,
  TrajectoryToolSchema,
  TrajectoryTurn,
  TrajectoryUsage,
} from "../shared/trajectory";

/** 折叠时能看到的字段（`data` 是任意 JSON，逐字段守卫，不猜形状）。 */
type EventData = Record<string, unknown>;

interface MessageLike {
  content?: unknown;
  source?: { kind?: unknown; plugin?: unknown; round?: unknown; callId?: unknown } & Record<string, unknown>;
}

/**
 * 账本里的时间口径：**只认事件带来的时刻**，不臆造。
 * `end` 缺失（还在跑）时 `timeSeconds` 为 null，而不是 0。
 */
function secondsBetween(start: number | undefined, end: number | undefined): number | null {
  if (typeof start !== "number" || typeof end !== "number" || end < start) return null;
  return (end - start) / 1000;
}

/** 单行摘要：压平空白、截断。官方用 CSS 省略号，摘要本身也要短。 */
export function trajectorySummary(text: string | undefined, limit = 160): string {
  const flat = (text ?? "").replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 首行（正文短摘要用）。 */
function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
}

/** `assistant/message` 的 `stream` 里能取到的首个时刻（TTFT 的来源，取不到就是 null）。 */
function streamFirstTime(data: EventData): number | null {
  const stream = data.stream;
  if (!Array.isArray(stream) || stream.length === 0) return null;
  const first = stream[0] as { time?: unknown } | undefined;
  return typeof first?.time === "number" ? first.time : null;
}

/** 工具结果正文：文本在**嵌套**的 `tool-result` 块里（与 adapter 的 `toolResultContent` 同口径）。 */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const nested = content.filter(
    (block): block is { content?: unknown } => (block as { type?: string } | undefined)?.type === "tool-result",
  );
  if (nested.length === 0) return blocksToText(content);
  const inner = nested.flatMap((block) => (Array.isArray(block.content) ? (block.content as unknown[]) : []));
  return blocksToText(inner.length ? inner : content);
}

/**
 * 工具结果是不是失败。
 *
 * 判据与 adapter 逐字一致：有 `data.error`，**或**嵌套的 `tool-result` 块自己标了
 * `isError: true`。曾经把「content 是数组」当成失败——那是把「有结果」读成了
 * 「有错误」，每一行工具都会红（本文件的回归断言就是为了钉住这一点）。
 */
function resultIsError(content: unknown, error: unknown): boolean {
  if (error) return true;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      (block as { type?: string; isError?: boolean } | undefined)?.type === "tool-result" &&
      (block as { isError?: boolean }).isError === true,
  );
}

/** 线格式 usage（`TokenUsage`）→ 视图用量。只认线格式字段名。 */function trajectoryUsage(usage: unknown): TrajectoryUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof u[key] === "number" ? (u[key] as number) : undefined;
  const view: TrajectoryUsage = {
    input: num("inputTokens"),
    cacheRead: num("cacheReadTokens"),
    cacheWrite: num("cacheWriteTokens"),
    output: num("outputTokens"),
    think: num("reasoningTokens"),
  };
  return Object.values(view).some((value) => value !== undefined) ? view : undefined;
}

/** `EpochHeader.tools` → 详情面板用的工具目录。 */
function headerTools(header: unknown): TrajectoryToolSchema[] | undefined {
  const tools = (header as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: TrajectoryToolSchema[] = [];
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") continue;
    const tool = entry as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof tool.name !== "string") continue;
    out.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    });
  }
  return out.length ? out : undefined;
}

/** `EpochHeader.config` → 选项面板用的请求选项 + 提供方/模型。 */
function headerConfig(header: unknown): {
  provider?: string;
  model?: string;
  options: { provider?: string; model?: string; thinking?: string; reasoningEffort?: string; temperature?: number; maxTokens?: number; stop?: string[] };
} {
  const config = (header as { config?: unknown } | undefined)?.config;
  if (!config || typeof config !== "object") return { options: {} };
  const c = config as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof c[key] === "string" ? (c[key] as string) : undefined);
  const options = {
    ...(str("provider") ? { provider: str("provider") } : {}),
    ...(str("model") ? { model: str("model") } : {}),
    ...(str("thinking") ? { thinking: str("thinking") } : {}),
    ...(str("reasoningEffort") ? { reasoningEffort: str("reasoningEffort") } : {}),
    ...(typeof c.temperature === "number" ? { temperature: c.temperature } : {}),
    ...(typeof c.maxTokens === "number" ? { maxTokens: c.maxTokens } : {}),
    ...(Array.isArray(c.stop) ? { stop: c.stop.filter((s): s is string => typeof s === "string") } : {}),
  };
  return { ...(str("provider") ? { provider: str("provider") } : {}), ...(str("model") ? { model: str("model") } : {}), options };
}

/**
 * `turn/end` 的 reason → 错误文案。
 *
 * **正常收尾与「截断」都不算错误**：`max-tokens` 是「回答被输出上限截断」，
 * 聊天流里已经有一条专门的「回答被截断」提示，在账本里把它画成红色失败是错的
 * （官方把 `max-tokens` 折成单独的 `TurnMaxTokens` 节点，不是 error）。
 */
function turnEndError(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  if (reason === "success" || reason === "completed" || reason === "end" || reason === "max-tokens") {
    return undefined;
  }
  return reason;
}

/**
 * 把 durable 事件折成账本。
 *
 * `events` 必须是**按 seq 升序**的 durable 事件（`adapter.seen` 的 values 排序后）。
 */
export function deriveTrajectoryModel(events: readonly SessionWireEvent[], hasOlder: boolean): TrajectoryModel {
  const cells: TrajectoryCell[] = [];
  /** callId → 工具行下标（结果回来时回填同一行）。 */
  const toolCells = new Map<string, number>();
  /** subCallId → 子工具行下标。 */
  const subCells = new Map<string, number>();
  /** 已发起但还没结算的 `request/header`：等它所属 step 的助手消息到了再合并。 */
  let currentTurn: number | null = null;
  let currentStep: number | null = null;
  let requestNumber = 0;
  /** step → 每次重试的最新进度（挂到该 step 的助手行上）。 */
  const retries = new Map<string, { attempt: number; max?: number }>();
  /** 轮次收尾错误：挂到该轮**最后一条助手消息**上（官方 `applyTurnErrors`）。 */
  const turnErrors = new Map<number, string>();
  /** 系统提示词：当前生效的正文与上一次的正文（差异页签要两者）。 */
  let systemText = "";
  let systemCellWritten = false;
  let lastHeaderSeq: number | null = null;
  let previousSystemText = "";
  /**
   * **初始**系统提示词那一行单独存着，最后 unshift 到最前面。
   *
   * 官方 `layoutEntryOrder` 把 `kind==='system' && change.kind==='initial'` 强制成
   * `-Infinity`：初始提示词永远排在账本第一行。而它在事件流里的位置其实**晚于**
   * 第一条 `user/message`（顺序是 turn/start → step/start → system/message →
   * user/message → request/header），照事件顺序摆会排到用户消息后面——那不是官方
   * 的样子，也不符合「先看提示词再看对话」的读法。
   */
  let initialSystemCell: Omit<TrajectoryCell, "index"> | undefined;

  const push = (cell: Omit<TrajectoryCell, "index">): TrajectoryCell => {
    const full: TrajectoryCell = { ...cell, index: cells.length + 1 };
    cells.push(full);
    return full;
  };

  for (const event of events) {
    const data = (event.data ?? {}) as EventData;
    const type = event.type;
    const time = event.time;

    switch (type) {
      case "turn/start": {
        currentTurn = typeof data.turn === "number" ? data.turn : currentTurn;
        currentStep = null;
        break;
      }

      case "turn/end": {
        const turn = typeof data.turn === "number" ? data.turn : currentTurn;
        const error = turnEndError(data.reason);
        if (turn !== null && error !== undefined) turnErrors.set(turn, error);
        break;
      }

      case "step/start": {
        // 每个 step = 一次模型请求：请求编号在这里递增（见文件头的差异 4）
        requestNumber += 1;
        currentStep = typeof data.step === "number" ? data.step : null;
        if (typeof data.turn === "number") currentTurn = data.turn;
        break;
      }

      case "step/end":
        break;

      case "llm/retry": {
        const key = `${currentTurn ?? "?"}:${currentStep ?? "?"}`;
        const attempt = typeof data.attempt === "number" ? data.attempt : undefined;
        const max = typeof data.maxAttempts === "number" ? data.maxAttempts : undefined;
        if (attempt !== undefined) retries.set(key, { attempt, ...(max === undefined ? {} : { max }) });
        break;
      }

      case "request/header": {
        const header = data.header;
        const config = headerConfig(header);
        const tools = headerTools(header);
        const reason = typeof data.reason === "string" ? data.reason : undefined;
        const isInitial = reason === "initial" || lastHeaderSeq === null;
        const systemChanged = systemText !== previousSystemText && !isInitial;
        const toolsChanged = !isInitial && tools !== undefined;
        if (isInitial || systemChanged || toolsChanged) {
          const cell: Omit<TrajectoryCell, "index"> = {
            kind: "system",
            turn: currentTurn,
            seq: event.seq,
            time,
            // 初始行给提示词的首行当摘要（更新行留空 → 界面换成官方那三条「已更新」文案）
            text: isInitial ? trajectorySummary(firstLine(systemText)) : "",
            timeSeconds: null,
            startedAt: typeof time === "number" ? time : null,
            status: "complete",
            ...(systemText ? { systemPromptDetail: systemText } : {}),
            ...(!isInitial && previousSystemText ? { previousSystemPromptDetail: previousSystemText } : {}),
            ...(tools ? { toolsDetail: tools } : {}),
            ...(Object.keys(config.options).length ? { optionsDetail: config.options } : {}),
            ...(config.provider ? { provider: config.provider } : {}),
            ...(config.model ? { model: config.model } : {}),
          };
          if (isInitial) initialSystemCell = cell;
          else push(cell);
          previousSystemText = systemText;
        }
        lastHeaderSeq = event.seq;
        systemCellWritten = true;
        if (typeof data.turn === "number") currentTurn = data.turn;
        break;
      }

      case "system/message": {
        const message = data.message as MessageLike | undefined;
        const text = blocksToText(message?.content);
        if (text) systemText = text;
        break;
      }

      case "user/message": {
        const message = data.message as MessageLike | undefined;
        const kind = typeof message?.source?.kind === "string" ? (message.source.kind as string) : "";
        const text = blocksToText(message?.content);
        const isHuman = kind === "user" || kind === "user-rpc";
        if (!text && !isHuman) break;
        push({
          kind: isHuman ? "user" : "context",
          turn: currentTurn,
          seq: event.seq,
          time,
          text: trajectorySummary(firstLine(text)) || "",
          ...(text ? { previewMarkdown: text, inputDetail: text } : {}),
          ...(isHuman ? { opensTurn: true } : {}),
          ...(typeof requestNumber === "number" && requestNumber > 0 ? { requestNumber } : {}),
          messageSource: {
            ...(kind ? { kind } : {}),
            ...(typeof message?.source?.plugin === "string" ? { plugin: message.source.plugin } : {}),
            ...(typeof message?.source?.round === "number" ? { round: message.source.round } : {}),
            ...(message?.source ? { raw: message.source } : {}),
          },
          timeSeconds: null,
          startedAt: typeof time === "number" ? time : null,
          status: "complete",
        });
        break;
      }

      case "assistant/message": {
        const message = data.message as MessageLike | undefined;
        const text = blocksToText(message?.content);
        const thinking = blocksToText(
          Array.isArray(message?.content)
            ? (message.content as { type?: string }[]).filter((block) => block?.type === "reasoning")
            : undefined,
        );
        const usage = trajectoryUsage(data.usage);
        const startedAt = typeof data.startedAt === "number" ? (data.startedAt as number) : null;
        const stepStart = startedAt;
        const retry = retries.get(`${currentTurn ?? "?"}:${currentStep ?? "?"}`);
        const turn = typeof data.turn === "number" ? data.turn : currentTurn;
        const cell = push({
          kind: "message",
          turn,
          seq: event.seq,
          time,
          text: trajectorySummary(firstLine(text)),
          ...(text ? { previewMarkdown: text, outputDetail: text } : {}),
          ...(thinking ? { thinkingDetail: thinking } : {}),
          ...(typeof requestNumber === "number" && requestNumber > 0 ? { requestNumber } : {}),
          timeSeconds: secondsBetween(stepStart ?? undefined, time),
          startedAt: stepStart ?? (typeof time === "number" ? time : null),
          status: data.interrupted === true ? "error" : "complete",
          ...(data.interrupted === true ? { error: "@interrupted" } : {}),
          ...(usage ? { usage } : {}),
          ...(typeof message?.source?.model === "string" ? { model: message.source.model as string } : {}),
          ...(retry ? { retry } : {}),
          assistantMetrics: {
            timingRecorded: stepStart !== null,
            stepStartTime: stepStart,
            firstTokenTime: streamFirstTime(data),
            completedTime: typeof time === "number" ? time : null,
            usageProvided: usage !== undefined,
            outputTokens: usage?.output ?? null,
          },
        });
        // 轮次收尾的原因**此刻还不知道**（`turn/end` 在后面才到）——统一在收尾后挂，
        // 与官方的 `applyTurnErrors` 同一个时机。以前在这里查 `turnErrors` 恒为空，
        // 于是「这一轮失败了」在账本上永远看不到（本文件的断言钉住了它）。
        void cell;
        break;
      }

      case "tool/call": {
        const callId = typeof data.callId === "string" ? data.callId : "";
        const name = typeof data.name === "string" ? data.name : "tool";
        const args = typeof data.arguments === "string" ? data.arguments : "";
        const cell = push({
          kind: "tool",
          turn: typeof data.turn === "number" ? data.turn : currentTurn,
          seq: event.seq,
          time,
          text: trajectorySummary(args ? `${name} · ${args}` : name),
          ...(args ? { inputDetail: args } : {}),
          ...(callId ? { callId } : {}),
          toolName: name,
          ...(typeof requestNumber === "number" && requestNumber > 0 ? { requestNumber } : {}),
          timeSeconds: null,
          startedAt: typeof time === "number" ? time : null,
          status: "running",
        });
        if (callId) toolCells.set(callId, cell.index - 1);
        break;
      }

      case "tool/result": {
        const message = data.message as MessageLike | undefined;
        const callId = typeof message?.source?.callId === "string" ? (message.source.callId as string) : "";
        const text = resultText(message?.content);
        const isError = resultIsError(message?.content, data.error);
        const index = callId ? toolCells.get(callId) : undefined;
        if (index === undefined) {
          // 调用在窗口之外（分页边界）也有结果：补一行「只有结果」的记录
          push({
            kind: "tool",
            turn: typeof data.turn === "number" ? data.turn : currentTurn,
            seq: event.seq,
            time,
            text: trajectorySummary(firstLine(text)) || "tool",
            ...(callId ? { callId } : {}),
            timeSeconds: null,
            startedAt: typeof time === "number" ? time : null,
            status: isError ? "error" : "complete",
            result: trajectorySummary(firstLine(text)),
            ...(text ? { outputDetail: text } : {}),
            isError,
          });
          break;
        }
        const cell = cells[index];
        cell.result = trajectorySummary(firstLine(text)) || undefined;
        if (text) cell.outputDetail = text;
        cell.isError = isError;
        cell.status = isError ? "error" : "complete";
        cell.timeSeconds = secondsBetween(cell.startedAt ?? undefined, time);
        break;
      }

      case "tool/ptc-dispatch-start": {
        const subCallId = typeof data.subCallId === "string" ? data.subCallId : "";
        const name = typeof data.name === "string" ? data.name : "tool";
        const args = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? "");
        const cell = push({
          kind: "subtool",
          turn: currentTurn,
          seq: event.seq,
          time,
          text: trajectorySummary(args && args !== '""' ? `${name} · ${args}` : name),
          ...(args && args !== '""' ? { inputDetail: args } : {}),
          ...(subCallId ? { callId: subCallId } : {}),
          toolName: name,
          timeSeconds: null,
          startedAt: typeof time === "number" ? time : null,
          status: "running",
        });
        if (subCallId) subCells.set(subCallId, cell.index - 1);
        break;
      }

      case "tool/ptc-dispatch": {
        const subCallId = typeof data.subCallId === "string" ? data.subCallId : "";
        const text = resultText(data.content);
        const index = subCallId ? subCells.get(subCallId) : undefined;
        if (index === undefined) break;
        const cell = cells[index];
        const isError = data.isError === true;
        cell.result = trajectorySummary(firstLine(text)) || undefined;
        if (text) cell.outputDetail = text;
        cell.isError = isError;
        cell.status = isError ? "error" : "complete";
        cell.timeSeconds = secondsBetween(cell.startedAt ?? undefined, time);
        break;
      }

      case "compaction/start": {
        requestNumber += 1;
        push({
          kind: "compacted",
          turn: typeof data.turn === "number" ? data.turn : currentTurn,
          seq: event.seq,
          time,
          // 文案留空：界面按状态取「正在压缩 / 已压缩 / 压缩失败」
          text: "",
          ...(typeof requestNumber === "number" ? { requestNumber } : {}),
          timeSeconds: null,
          startedAt: typeof time === "number" ? time : null,
          status: "running",
        });
        break;
      }

      case "compaction/summary": {
        // 摘要挂到最后一条还在跑的压缩行上（相邻关系由协议保证）
        const cell = [...cells].reverse().find((entry) => entry.kind === "compacted" && entry.status === "running");
        if (!cell) break;
        const summary = blocksToText(data.summary);
        const raw = blocksToText(data.rawOutput);
        if (summary) cell.outputDetail = summary;
        cell.text = trajectorySummary(firstLine(summary));
        if (typeof data.provider === "string") cell.provider = data.provider;
        if (typeof data.model === "string") cell.model = data.model;
        const usage = trajectoryUsage(data.usage);
        if (usage) cell.usage = usage;
        // `rawOutput`（模型原始输出）在「原始输出」页签里看
        if (raw && raw !== summary) cell.inputDetail = raw;
        break;
      }

      case "compaction/end": {
        const cell = [...cells].reverse().find((entry) => entry.kind === "compacted" && entry.status === "running");
        if (!cell) break;
        const error = typeof data.error === "string" ? data.error : undefined;
        cell.status = error ? "error" : "complete";
        if (error) cell.error = error;
        cell.timeSeconds = secondsBetween(cell.startedAt ?? undefined, time);
        break;
      }

      default:
        break;
    }
  }

  // 轮次收尾的原因挂到该轮**最后一条助手行**上（官方 `applyTurnErrors` 同口径：
  // 它是收尾后的后处理，因为 `turn/end` 总在该轮的助手消息之后才到）。
  for (const [turn, error] of turnErrors) {
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      const cell = cells[index];
      if (cell.turn !== turn || cell.kind !== "message") continue;
      if (cell.error === undefined) {
        cell.error = error;
        cell.status = "error";
      }
      break;
    }
  }

  // 初始系统提示词那一行补到最前面（官方强制它排第一，见上面的注释）；
  // 完全没有 `request/header` 时退回「用已看到的 system 文本补一行」。
  const front: Omit<TrajectoryCell, "index"> | undefined =
    initialSystemCell ??
    (!systemCellWritten && systemText
      ? {
          kind: "system",
          turn: cells[0]?.turn ?? null,
          seq: cells[0]?.seq ?? 0,
          time: cells[0]?.time ?? 0,
          text: trajectorySummary(firstLine(systemText)),
          systemPromptDetail: systemText,
          timeSeconds: null,
          startedAt: null,
          status: "complete",
        }
      : undefined);
  if (front) {
    cells.unshift({ ...front, index: 1 });
    cells.forEach((cell, index) => {
      cell.index = index + 1;
    });
  }

  // 分组：按 seq 顺序走，turn 变了就开新组（含 null↔number 的切换）。
  // 官方的 prologue 规则：**turn 0 里没有用户消息时并进下一组**（初始系统提示词
  // 本来挂在 turn 0 的位置上，不并的话会出现「第 1 轮」两次）。
  const turns: TrajectoryTurn[] = [];
  for (const cell of cells) {
    const last = turns[turns.length - 1];
    if (last && last.turn === cell.turn) last.cells.push(cell);
    else turns.push({ turn: cell.turn, cells: [cell] });
  }
  for (let index = 0; index < turns.length - 1; index += 1) {
    const group = turns[index];
    if (group.turn !== 0) continue;
    if (group.cells.some((cell) => cell.kind === "user")) continue;
    const next = turns[index + 1];
    next.cells = [...group.cells, ...next.cells];
    turns.splice(index, 1);
    index -= 1;
  }

  const totalSeconds = cells.reduce((sum, cell) => sum + (cell.timeSeconds ?? 0), 0);
  return {
    turns,
    cellCount: cells.length,
    totalSeconds,
    firstStartedAt: cells.find((cell) => cell.startedAt !== null)?.startedAt ?? null,
    hasOlder,
  };
}
