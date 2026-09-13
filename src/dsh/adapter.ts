import type {
  ApprovalView,
  Attachment,
  ChatState,
  CommandRunView,
  DiffHunkView,
  FileChangeKind,
  InjectedSourceView,
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
import {
  parseCatalogEntries,
  parseInstructionChanges,
  parseRecalledSessions,
  parseRelaySender,
  parseSnapshotSections,
} from "../shared/injectedSource";
import { classifyTool, parseExitStatus, summaryKeys, terminalFailed } from "../shared/toolMeta";
import { readRangeFromMeta, readRangeFromOutput } from "./readRange";
import { producedPath } from "./produced";
import type { HostToWebview } from "../shared/ipc";
import {
  isKnownEventType,
  type AssistantStreamFrame,
  type ContentBlock,
  type SessionFollowFrame,
  type SessionHistoryRecord,
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
 * 取出 `tool/result` 的**内层内容块**（`tool-result` 块自己的 `content`）。
 *
 * 工具结果的信封是 `message.content = [tool-result{ content: [...] }]`，
 * 真正的内容（文本、图片句柄）在里层。`blocksToText` 只关心文本，会顺手把里层
 * 拍平；但**图片句柄**必须按块处理，拍平就丢了，所以单独取一次。
 */
function toolResultContent(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === "tool-result" && Array.isArray(block.content)) return block.content;
  }
  return [];
}

/**
 * 未知内容块的 JSON 记录（有上限）。
 *
 * 官方用 `boundedText` + `json.truncated` 截断，因为未知生产方可能塞进任意大的
 * 字符串或数组。这里也截断：整份内容要跟着 message/upsert 过线，几百 KB 的载荷
 * 会把界面拖住，而它的价值只是「让用户知道这里有个东西、长什么样」。
 */
const UNKNOWN_BLOCK_LIMIT = 4000;

function boundedJson(block: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(block, null, 2) ?? String(block);
  } catch {
    text = String(block);
  }
  return text.length > UNKNOWN_BLOCK_LIMIT
    ? `${text.slice(0, UNKNOWN_BLOCK_LIMIT)}\n…`
    : text;
}

/**
 * 按 `form` 解析上下文条目的结构化字段（官方 `ContextBody` 的分派口径）。
 *
 * 每种 form 读的是 `source` 上不同的字段与形状，认不出就整项不填——
 * 界面上退回「正文 + 原样字段」，而不是显示一个半截的列表。
 */
function injectedSourceFields(form: string | undefined, source: unknown): InjectedSourceView | undefined {
  const fields: InjectedSourceView = {
    ...(form === "instructions" ? { changes: parseInstructionChanges(source) } : {}),
    ...(form === "catalog" ? { entries: parseCatalogEntries(source) } : {}),
    ...(form === "snapshot" ? { sections: parseSnapshotSections(source) } : {}),
    ...(form === "relay" ? { senderSessionId: parseRelaySender(source) } : {}),
    ...(form === "recall" ? { references: parseRecalledSessions(source) } : {}),
  };
  // 键都存在但值全是 undefined（形状不合预期）时不留空壳
  return Object.values(fields).some((value) => value !== undefined) ? fields : undefined;
}

/** 图片句柄（不透明 id + 元数据），用于向服务端换取可显示的字节。 */
export interface ImageRef {
  attachmentId: string;
  mediaType?: string;
  name?: string;
}

/**
 * 从内容块里挑出图片句柄（没有就返回空数组）。
 *
 * `attachment.attachmentId` 是**不透明存储标识**——既不是路径也不是 URL，
 * 只能通过 `session/attachment` 换取 base64 字节。所以这里只收集句柄，
 * 真正的字节由控制器异步取（适配器不持有网络客户端）。
 */
function imageAttachments(content: unknown): ImageRef[] {
  if (!Array.isArray(content)) return [];
  const refs: ImageRef[] = [];
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== "object" || block.type !== "image") continue;
    const attachment = (block as { attachment?: { attachmentId?: unknown; mediaType?: unknown; name?: unknown } })
      .attachment;
    const id = attachment?.attachmentId;
    if (typeof id !== "string" || !id) continue;
    refs.push({
      attachmentId: id,
      mediaType: typeof attachment?.mediaType === "string" ? attachment.mediaType : undefined,
      name: typeof attachment?.name === "string" ? attachment.name : undefined,
    });
  }
  return refs;
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
 * 从用户消息的内容块里取出**非文本**附件（图片 / 文件）。
 *
 * 这些块代表用户真正发出去的东西，但在人类转写里此前被整体丢弃：
 * `blocksToText` 只认文本，于是「纯图片消息」渲染成空、`text` 也为空 →
 * 整条消息被 `if (!text) break;` 跳掉，用户看不到自己发过什么。
 *
 * 图片句柄是不透明的 `attachmentId`（不是路径也不是 URL），所以这里**不取字节**，
 * 只把「这是一张图/一个文件」的事实与它的元数据带出来——用户消息的图片展示不需要
 * 再拉一次字节（发送时就是用户自己选的），文件显示名字与大小即可。
 */
function userMedia(content: unknown): Attachment[] {
  if (!Array.isArray(content)) return [];
  const media: Attachment[] = [];
  let index = 0;
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image") {
      const attachment = (block as { attachment?: Record<string, unknown> }).attachment ?? {};
      const name = typeof attachment.name === "string" && attachment.name ? attachment.name : "image";
      media.push({
        id: `m${index++}`,
        kind: "image",
        name,
        bytes: typeof attachment.bytes === "number" ? attachment.bytes : undefined,
      });
      continue;
    }
    if (block.type === "file") {
      const attachment = (block as { attachment?: Record<string, unknown> }).attachment ?? {};
      const name = typeof attachment.name === "string" && attachment.name ? attachment.name : "file";
      media.push({
        id: `m${index++}`,
        kind: "file",
        name,
        bytes: typeof attachment.bytes === "number" ? attachment.bytes : undefined,
      });
    }
  }
  return media;
}

/**
 * 从一份用量复算「最近一次请求的 prompt 侧压力」。
 *
 * 契约里 `pressureTokens` 的定义正是「未缓存输入 + 缓存读 + 缓存写」，**不含 output**。
 * 我们的 `UsageView` 把两个缓存桶合成了 `cachedTokens`（见 `toUsage`），
 * 所以复算式就是 `inputTokens + cachedTokens`。
 *
 * 实测（`scripts/pressureProbe.ts`）它与官方 `pressureTokens` **逐字相等**
 * （18054 + 1152 = 19206 = 官方的 19206），同时**不等于** `totalTokens`（19208）。
 * 所以它是在投影还没给出分子时的一个**同口径**兜底，不是「自己另算一个近似值」。
 *
 * 拿不到任何输入桶时返回 undefined（不猜）。
 */
function pressureFromUsage(usage: UsageView | undefined): number | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens;
  if (typeof input !== "number") return undefined;
  const cached = typeof usage.cachedTokens === "number" ? usage.cachedTokens : usage.cacheReadTokens;
  return input + (typeof cached === "number" ? cached : 0);
}

/**
 * 两个占用值是否等价（用于「只在真的变了才下发」）。
 *
 * `undefined` 与 `undefined` 等价 —— 反复清空不该反复发帧。
 */
function sameOccupancy(
  left: { percent: number; usedTokens: number; contextWindow: number } | undefined,
  right: { percent: number; usedTokens: number; contextWindow: number } | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.percent === right.percent &&
    left.usedTokens === right.usedTokens &&
    left.contextWindow === right.contextWindow
  );
}

/**
 * 解析工具参数，提炼出一行摘要 + 一行完整命令。
 *
 * 刻意**不生成动词文案**：文案属于界面语言，由 webview 的词典决定
 * （否则英文界面里会混进中文标题）。这里只产出与语言无关的数据：
 * 路径、命令行、查询串。
 *
 * 分类走**官方的精确名表**（`shared/toolMeta.classifyTool`）而不是子串启发：
 * `includes("web")` 这类判断会把自定义工具名误分类，而官方的 `TOOL_VARIANTS`
 * 只对 16 个已知名字精确匹配、其余一律 `others`。
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

  const variant = classifyTool(name);
  if (variant === "read" || variant === "write" || variant === "edit") {
    // 文件类变体：参数里就能推出 diff（结果回来后再用 meta.diffs 的真实 hunk 覆盖）。
    //
    // detail 给**完整路径**，不在宿主侧预先缩短：省略由界面按可用宽度做，口径是
    // 「保住文件名、省略前段路径」（见 webview/pathDisplay.ts），宽面板因此能显示
    // 更多上下文，窄侧栏也不会丢掉文件名。
    //
    // 注意 `read` 变体含 `web_fetch`，它用的是 `url`：官方**刻意**不把 `url` 当
    // 路径键（`FILE_PATH_KEYS = [path, file_path]`），否则 URL 会被当成可打开的文件。
    const path = pick(...summaryKeys(variant));
    return {
      detail: path ? firstLine(path) : undefined,
      command: path,
      input: argsRaw,
      diff: hunksFromToolArgs(name, argsRaw),
    };
  }
  if (variant === "bash") {
    const command = pick(...summaryKeys(variant));
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
  if (variant === "search") {
    const query = pick(...summaryKeys(variant));
    return { detail: query, command: query, input: argsRaw };
  }
  if (variant === "code") {
    const description = pick(...summaryKeys(variant));
    return { detail: description?.slice(0, 120), command: description, input: argsRaw };
  }
  // `others`：官方不猜字段（`SUMMARY_KEYS.others` 是空表），退回「参数里第一个非空
  // 字符串」。认不出就不给 command，展开区退化为只显示状态，不编造内容。
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
  /**
   * 当前轮的**显示分段**号（从 1 起）。
   *
   * 服务端会把运行中提交的消息（队列自动派发、运行中发送）经 `agent/inbox`
   * **直接 splice 进还在跑的同一轮**——实测会话日志里这条 user/message 落在
   * turn/end 之前几十分钟（用户 2026-09-14 报告的「生成内容在用户消息上方
   * 继续生成」）。轮次不结束，回答都进同一条助手消息；如果把用户消息简单地
   * 追加到末尾，后续生成永远压在它上方。
   *
   * 所以在插话处把该轮**切成多段**：第 1 段沿用传统 id `a:N`（分支锚点等
   * 旧逻辑不变），第 2 段起是 `a:N:2`、`a:N:3`……插话夹在两段之间，
   * 后续生成进下一段（= 显示在插话下方）。重放（refold）按同样的规则
   * 折叠，结果确定。
   */
  private turnPart = 1;
  /**
   * 每一轮**结束**事件的 seq（`turn` → `turn/end` 的 seq）。
   *
   * 分支的唯一合法锚点：`session/fork` 要求 `atSeq` 落在某个 `turn/end` 上
   * （边界取「atSeq 之后第一个 turn/end」；点在**开放轮**里会被直接拒绝，
   * 而不是往前裁剪——见 `SessionForkError` 的 `OPEN_TURN`）。
   */
  private readonly turnEndSeqs = new Map<number, number>();
  /** 当前 step 首个 token delta 的时间戳（服务端时钟，取自 chunk 帧 time）。 */
  private stepFirstTokenAt: number | undefined;
  /** 当前 step 的**开始**时刻（`turn/start` / `step/start` 的 time）：TTFT 的基准。 */
  private stepStartedAt: number | undefined;
  /**
   * 本轮（= 本条助手消息）的用时与速度累加器，键 = 消息 id。
   *
   * 与官方 `deriveStats` 同口径地把**各 step 相加**：解码窗口相加、输出 token 相加，
   * 最后 `decodeTokens / (decodeMs / 1000)` 得到整轮吞吐；TTFT 取**第一步**的
   * （官方 `firstStepTtftMs`）。逐 step 覆盖式的 `message.usage.tokensPerSecond`
   * 只是最后一步的速度，不能当整轮用。
   */
  private readonly turnMetrics = new Map<string, { decodeMs: number; decodeTokens: number; ttftMs?: number }>();
  /** 当前活跃 attempt 的 turn/step，由 assistant-stream 的 start 帧给出。 */
  private liveTurn = 0;
  private liveStep = 0;
  private sequence = 0;
  /**
   * 已见过的 durable 事件（seq → 事件），按需整体重折。
   *
   * 「加载更早」把窗口外的记录并进来后要重新折叠一遍——折叠本身是确定性的，
   * 重放比手工往前面插消息可靠得多（见 `prependRecords`）。
   */
  private readonly seen = new Map<number, SessionWireEvent>();
  /** 跟随开帧的 `snapshot.cursor`：`session/page` 的 `throughSeq` 唯一合法来源。 */
  private throughSeq: number | undefined;
  /** 最近一次 `request/context` 事件给出的上下文窗口（**仅供别处显示**，占用条只用投影）。 */
  contextWindow: { tokens: number; model: string } | undefined;
  /**
   * 当前会话的上下文占用，等价于官方 `contextOccupancy(contextPressure)` 的输出。
   *
   * **唯一来源是 `contextPressure` 投影**（分子与分母都取自那里）。
   * `undefined` 表示「现在没有可信的数字」，界面应当**什么都不显示**——
   * 而不是退回自己算一个（那会得到一个含 output、压缩后还不下降的数）。
   */
  contextOccupancy: { percent: number; usedTokens: number; contextWindow: number } | undefined;
  /**
   * 最近一次已知的解码速度（tok/s）。
   * 新一轮开始时最新消息还没有 usage，界面只读最后一条消息会闪没，这里兜住。
   */
  lastSpeed: number | undefined;
  /**
   * 窗口外还有没有更早的历史（跟随开帧的 `hasMore`，分页后更新）。
   * 单独存一份：首帧快照要带它，「加载更早」按钮才能在第二个窗口绑上已有
   * 会话、以及页面重载后正确显示（重放只发生在 follow 流开窗那一刻）。
   */
  private hasMore = false;

  /**
   * 重放期间**不发帧**（见 `refold`）。
   *
   * 重放是「把所有已记录事件从头折一遍」，中间态（每条 `message/append`、每轮开头
   * 那个 `running: true`、每个 step 的局部 patch）都会立刻被收尾的 `messages/reset`
   * 整体覆盖。不发的话界面**根本看不到那些中间态**——发的话（此前就是发的）界面会
   * 一帧一帧地把它画出来：用户滚到顶自动翻页时，新加载进来的旧轮次会先是「运行中 /
   * 展开」的样子，过一会儿才收成折叠态（用户 2026-09-15 报的「加载时不要将其实时
   * 渲染」就是这个），视口锚定也会因为内容分几十帧长高而漂移。
   */
  private replaying = false;

  /**
   * 当前是否有一轮在跑（`turn/start` 与 `turn/end` 之间）。
   *
   * 单独记一个字段而不是只发 `patch running`：重放期间不发帧（见 `replaying`），
   * 而「打开一个正在跑的会话」这件事**只能**从重放里看出来——`session/follow`
   * 的快照把这一轮的 `turn/start` 一起回放，重放静默之后若不补一帧，界面就会把
   * 正在生成的会话显示成空闲（连控制器的 queue/steer 判定也会错）。
   * 所以重放结束后由快照那条路径**显式**补一帧（见 `applyFrame`）。
   */
  private turnRunning = false;

  constructor(private readonly sendFrame: (frame: HostToWebview) => void) {}

  /** 发一帧给宿主；重放期间静默（见 `replaying`）。 */
  private emit(frame: HostToWebview): void {
    if (this.replaying) return;
    this.sendFrame(frame);
  }

  /**
   * 图片句柄 → 可显示字节的装载回调（由控制器注入）。
   *
   * 适配器刻意不持有网络客户端：它只把「这里有哪几张图」交出去，
   * 字节由控制器用 `session/attachment` 换取后回调。拿不到就回空数组，
   * 界面退化为不显示图（而不是显示一个坏掉的 `<img>`）。
   */
  loadImages:
    | ((refs: ImageRef[], done: (dataUrls: string[]) => void) => void)
    | undefined;

  /**
   * 文件芯片的分类回调（由控制器注入，像 `loadImages` 一样）。
   *
   * 适配器只负责「这里有哪些路径」（`produced` / `deliverables`），而「每个文件是
   * 新建 / 改动 / 已删除」要看 git 状态与磁盘，那是控制器（vscode API）的事。
   * 注入为空（比如子代理转录的适配器）就跳过分类，界面维持无记号的现状。
   *
   * 键 = 芯片上的原样路径，值 = 种类；判定细节见 `dsh/fileChange.ts`。
   */
  classifyFiles: ((paths: string[]) => Promise<Record<string, FileChangeKind>>) | undefined;

  /**
   * 「刷新 git 状态」回调（由控制器注入）：**轮次结束**时先推一次 Git 重扫，
   * 再分类。
   *
   * 为什么要这个钩子：git 扩展按文件系统事件去抖刷新，模型刚写完的文件往往还
   * 不在改动清单里。不推这一下，用户第一次点芯片会被判定成「没改动」→ 打开的是
   * 完整文件而不是 diff，点第二次才是 diff。刷新放在**轮次结束**（文件都落盘了）
   * 而不是点击时，是为了不占用点击的响应时间。
   */
  refreshFiles: (() => Promise<void>) | undefined;

  /** 文件分类的去抖计时器（见 `scheduleFileKinds`）。 */
  private fileKindsTimer: ReturnType<typeof setTimeout> | undefined;

  /** 下次分类前是否要先推一次 Git 重扫（轮次结束时置位）。 */
  private fileKindsRefreshPending = false;

  /**
   * 最近一次下发的分类表。**要进首帧快照**（`fileKindsState()`）：
   * 页面重载或第二个窗口绑上同一会话时，新窗口只有靠快照才拿得到记号；
   * 光靠 patch 不行——表没变化时 `deliverFileKinds` 会按 `lastFileKindsJson`
   * 去重跳过，新窗口就永远收不到那张表。
   */
  private fileKindsTable: Record<string, FileChangeKind> | undefined;

  /** 上次下发的分类表（JSON 形式）：没变化就不重发 patch。 */
  private lastFileKindsJson: string | undefined;

  /** 首帧快照要带的分类表（没分类过时 undefined → 界面不标记号）。 */
  fileKindsState(): Record<string, FileChangeKind> | undefined {
    return this.fileKindsTable;
  }

  /**
   * 安排一次文件分类（去抖 250ms）。
   *
   * 一轮里 write/edit 可能连发十几次，每次都分类既浪费也让 git 状态来回抖；
   * 并起来一批做完，等 `tool/result` 的连发平息后再问一次 git。历史回放
   * （快照 / 加载更早）也走这里——旧轮次的芯片同样要有记号。
   *
   * @param refreshGit 轮次结束时传 true：先推一次 Git 重扫再分类，让刚写完的
   *   文件立刻进改动清单（见 `refreshFiles`）。
   */
  scheduleFileKinds(refreshGit = false): void {
    if (!this.classifyFiles) return;
    if (refreshGit) this.fileKindsRefreshPending = true;
    if (this.fileKindsTimer) clearTimeout(this.fileKindsTimer);
    this.fileKindsTimer = setTimeout(() => {
      this.fileKindsTimer = undefined;
      void this.deliverFileKinds();
    }, 250);
  }

  /** 收集全部芯片路径 → 交给控制器分类 → 整表下发。 */
  private async deliverFileKinds(): Promise<void> {
    const classify = this.classifyFiles;
    if (!classify) return;
    if (this.fileKindsRefreshPending) {
      this.fileKindsRefreshPending = false;
      try {
        await this.refreshFiles?.();
      } catch {
        // 刷新失败不致命：分类照旧（拿不到状态的条目退化为无记号）
      }
    }
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const message of this.messages) {
      for (const path of message.produced ?? []) {
        if (path && !seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
      for (const file of message.deliverables ?? []) {
        if (file.path && !seen.has(file.path)) {
          seen.add(file.path);
          paths.push(file.path);
        }
      }
    }
    let kinds: Record<string, FileChangeKind>;
    try {
      // 没有芯片了也要走一趟：整表替换的语义要求「空表」也是一次下发，
      // 否则界面会一直留着上一次的表（芯片没了、记号却还在查表）
      kinds = paths.length ? await classify(paths) : {};
    } catch {
      return; // 分类失败不致命：芯片退化为无记号（现状）
    }
    const json = JSON.stringify(kinds);
    if (json === this.lastFileKindsJson) return;
    this.lastFileKindsJson = json;
    this.fileKindsTable = kinds;
    this.emit({ type: "patch", patch: { fileKinds: kinds } });
  }

  snapshotMessages(): MessageView[] {
    return this.messages;
  }

  /**
   * 某条助手消息（`a:<turn>`）对应的分支锚点 seq。
   *
   * 没有对应 `turn/end` 的（正在跑的那一轮、或窗口外的历史）返回 undefined——
   * 契约里在开放轮上锚定会被**拒绝**而不是往前裁剪，所以宁可拒绝也不猜。
   */
  forkAnchorFor(messageId: string): number | undefined {
    // 同轮插话会把轮切成多段（a:N:2…），分支锚点认轮号就行——每段都能作为
    // 这一轮的入口，锚点仍落在该轮的 turn/end 上
    const match = /^a:(\d+)(?::\d+)?$/.exec(messageId);
    if (!match) return undefined;
    return this.turnEndSeqs.get(Number(match[1]));
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

  /** 窗口外是否还有更早的历史（首帧快照要带，见字段注释）。 */
  hasMoreHistory(): boolean {
    return this.hasMore;
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
      // 跟随开帧带 `cursor`（本次开窗的日志截点）与 `hasMore`（窗口外还有没有更早的）。
      // `cursor` 是 `session/page` 的 `throughSeq` **唯一合法来源**，所以必须存下来。
      if (typeof frame.cursor === "number") this.throughSeq = frame.cursor;
      for (const record of frame.records ?? []) {
        if (record?.type === "event") this.remember(record.event);
      }
      this.refold();
      this.hasMore = Boolean(frame.hasMore);
      this.emit({ type: "patch", patch: { hasMoreHistory: this.hasMore } });
      // 重放静默（见 `replaying`），所以「这一轮还在跑」要**显式**补一帧：
      // 打开一个正在生成的会话时，这是 running 的唯一来源（`snapshotFor` 里那份
      // 首帧快照读的是 `scope.running`，而它同样只由这一类帧更新）。
      this.emit({ type: "patch", patch: { running: this.turnRunning } });
      // 历史里可能有旧轮次的文件芯片：回放完安排一次分类（旧文件多已定型，
      // 这一批通常一次 fs.stat + 一次 git 状态读取就出结果）
      this.scheduleFileKinds();
      const title = frame.projections?.values?.title;
      if (typeof title === "string" && title) {
        this.emit({ type: "patch", patch: { session: this.sessionWithTitle(title) } });
      }
      this.emit({ type: "messages/reset", messages: this.messages });
      return;
    }
    if (frame.type === "event") {
      this.remember(frame.event);
      this.applyEvent(frame.event);
      return;
    }
    if (frame.type === "assistant-stream") {
      this.applyAssistantStream(frame.frame);
    }
  }

  /** 记下一条 durable 事件（按 seq 去重、按 seq 排序），供「加载更早」重折。 */
  private remember(event: SessionWireEvent): void {
    if (typeof event?.seq !== "number") return;
    if (this.seen.has(event.seq)) return;
    this.seen.set(event.seq, event);
  }

  /**
   * 合并一批**更早**的历史记录，并整体重折消息流。
   *
   * 为什么是「整体重折」而不是「往前面插消息」：消息 id 是按轮次派生的
   * （`a:<turn>` / `u:<seq>`），而这个折叠过程**天然有序**——把旧事件并进集合后
   * 从头走一遍，顺序、去重、附件置顶都由同一套逻辑保证；手工做「前置插入」要
   * 重新实现一遍这些规则，且极易在边界上错位（用户消息要落在本轮助手消息之前）。
   *
   * 代价是丢掉流式叠加层（`liveSegments`）——所以只在**空闲时**调用：
   * 正在生成时往前翻页会让当前这段流式正文重来一次，而且服务端也不会在这种情况下
   * 给出稳定的分页结果。
   *
   * **重折过程不发帧**（见 `replaying`）：界面只收到「hasMoreHistory 变了」与一整份
   * `messages/reset`，于是新加载的旧轮次**一出现就是折叠好的最终态**，不会先被画成
   * 「运行中 / 展开」再收起来。
   *
   * @returns **新并入的事件条数**（0 = 这一页没带来新东西）。调用方（控制器）据此
   *   判断要不要接着取下一页——不能拿「首条消息 id 变没变」当判据：更早的事件常常
   *   只是**把现有的第一条助手消息补长**（它的 id 是按轮次派生的 `a:<turn>`，不会变），
   *   于是「没换首条」会被误判成「没进展」而在半轮中间停下（2026-09-15 的缺陷现场，
   *   见 `scripts/pageLoopProbe.ts`）。
   */
  prependRecords(records: readonly SessionHistoryRecord[], hasMore: boolean): number {
    let added = 0;
    for (const record of records ?? []) {
      if (record?.type !== "event") continue;
      if (typeof record.event?.seq !== "number" || this.seen.has(record.event.seq)) continue;
      this.seen.set(record.event.seq, record.event);
      added += 1;
    }
    if (added > 0) this.refold();
    this.hasMore = hasMore;
    this.emit({ type: "patch", patch: { hasMoreHistory: this.hasMore } });
    if (added > 0) {
      this.emit({ type: "messages/reset", messages: this.messages });
      // 更早的历史里也有芯片：同样安排分类
      this.scheduleFileKinds();
    }
    return added;
  }

  /** 当前已折叠事件里最小的 seq（`session/page` 的 `beforeSeq`）。 */
  earliestSeq(): number | undefined {
    let min: number | undefined;
    for (const seq of this.seen.keys()) {
      if (min === undefined || seq < min) min = seq;
    }
    return min;
  }

  /** `session/page` 的 `throughSeq`：来自跟随开帧的 `snapshot.cursor`。 */
  cursor(): number | undefined {
    return this.throughSeq;
  }

  /** 按 seq 顺序把已记录的事件重新折叠成消息流（清空后重放）。 */
  private refold(): void {
    const events = [...this.seen.values()].sort((left, right) => left.seq - right.seq);
    // 只清消息相关的折叠状态，**不动**粘性显示值（上下文窗口 / 速度 / 占用）：
    // 那是显示用的记忆，重折历史不该把它们抹掉
    this.messages = [];
    this.byId.clear();
    this.toolSegments.clear();
    this.liveSegments.clear();
    this.turnEndSeqs.clear();
    this.currentTurn = undefined;
    this.turnPart = 1;
    this.currentStep = 0;
    this.stepFirstTokenAt = undefined;
    this.sequence = 0;
    // 重放期间静默：中间态会被调用方随后的 `messages/reset` 整体覆盖（见 `replaying`）。
    // 两个调用方（follow 开窗快照、prependRecords）都在重放之后立刻发 reset。
    this.replaying = true;
    try {
      for (const event of events) this.applyEvent(event);
    } finally {
      this.replaying = false;
    }
  }

  // ---------- durable 事件 ----------

  applyEvent(event: SessionWireEvent): void {
    // 替换式的表层事件是模型视图，不是人类转写
    if (event.surfaceOp && typeof event.surfaceOp === "object") return;

    const data = (event.data ?? {}) as Record<string, any>;
    switch (event.type) {
      case "turn/start": {
        // 新轮次：显示分段归位。轮号没变时（同轮重复事件）不动分段。
        if (data.turn !== this.currentTurn) this.turnPart = 1;
        this.currentTurn = typeof data.turn === "number" ? data.turn : this.currentTurn;
        this.currentStep = 0;
        // TTFT 的基准：本 step 从这里开始算（官方 timing.stepStartTime 同义）
        this.stepStartedAt = event.time;
        this.stepFirstTokenAt = undefined;
        const message = this.ensureAssistantMessage(event.time);
        message.streaming = true;
        this.turnRunning = true;
        this.emit({ type: "patch", patch: { running: true } });
        this.emit({ type: "message/upsert", message: { ...message } });
        break;
      }

      case "turn/end": {
        // 记下这一轮的结束 seq：它是分支唯一合法的锚点（见 turnEndSeqs 注释）
        if (typeof data.turn === "number") this.turnEndSeqs.set(data.turn, event.seq);
        // 该轮的**每一段**都要收尾：插话切分后同轮可能有多条助手消息，
        // 残留的 streaming 标记会让思考鲸鱼一直发蓝光
        const endTurn = typeof data.turn === "number" ? data.turn : this.currentTurn ?? 0;
        for (let part = 1; part <= this.turnPart; part++) {
          const partMessage = this.byId.get(this.assistantIdFor(endTurn, part));
          if (!partMessage) continue;
          partMessage.streaming = false;
          if (this.settleStreaming(partMessage)) {
            this.emit({ type: "message/upsert", message: { ...partMessage } });
          }
        }
        const message = this.ensureAssistantMessage(event.time);
        message.streaming = false;
        // 轮尾「用时 X」胶囊的数据：总用时 = 本轮结束时刻 − 本段开始时刻
        // （官方 `runMs = turn.end.time - turn.start.time` 同口径）；
        // 速度与 TTFT 取自本轮的累加器（见 turnMetrics）。
        const metrics = this.turnMetrics.get(message.id);
        const decodeSeconds = metrics ? metrics.decodeMs / 1000 : 0;
        message.turnStats = {
          ranForMs: Math.max(0, event.time - message.ts),
          ...(metrics && decodeSeconds > 0 && metrics.decodeTokens > 0
            ? { tokensPerSecond: metrics.decodeTokens / decodeSeconds }
            : {}),
          ...(metrics?.ttftMs !== undefined ? { ttftMs: metrics.ttftMs } : {}),
        };
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
        } else if (reason?.kind === "max-tokens") {
          // 达到输出上限是**正常收场**，不是错误——但用户必须知道回答被截断了，
          // 否则会以为模型说完了。官方在这里建 `turn-max-tokens` 节点。
          this.pushSegment(message, {
            kind: "notice",
            id: `n${event.seq}`,
            level: "warn",
            text: "@maxTokens",
          });
        }
        // 本轮关闭 ⇒ 为所有**仍未结算**的工具调用合成一个中断结果。
        //
        // 这一步**不按收场原因分支**，与官方一致：官方在视图投影时只看
        // 「step/turn 是否已关闭」（`interruption(context)`），不关心是
        // aborted / error / completed。原因是同一件事：一轮关掉之后，那些调用
        // 不会再有 `tool/result` 了，不合成它们就永远停在「运行中」，
        // 看起来像任务卡死（docs/audit-summary.md §12）。
        // 「正常完成但调用没收尾」在真实会话里确实会出现（结果被截断、连接抖动）。
        this.synthesizeInterrupted(event.time);
        this.emit({ type: "message/upsert", message: { ...message } });
        this.turnRunning = false;
        this.emit({ type: "patch", patch: { running: false } });
        // 轮次结束 = 文件都落盘了：先推一次 Git 重扫再分类，让芯片的
        // [新增] / 删除线立刻是准的，也让「用户随后点芯片」直接看到 diff
        // （不推的话刚写完的文件还没进改动清单，第一次点只会打开完整文件）。
        this.scheduleFileKinds(true);
        break;
      }

      case "step/start":
        this.currentStep = typeof data.step === "number" ? data.step : 0;
        this.stepFirstTokenAt = undefined;
        this.stepStartedAt = event.time;
        break;

      case "user/message": {
        const message = data as WireMessage;
        const kind = message?.source?.kind;
        const text = blocksToText(message?.content);
        if (kind === "user" || kind === "user-rpc") {
          // 非文本块（图片 / 文件）**不能丢**：此前的 `if (!text) break;` 会
          // 让「纯图片用户消息」整条不渲染——用户发了张图，界面上什么都没有
          // （docs/audit-summary.md §14）。
          const media = userMedia(message?.content);
          if (!text && media.length === 0) break;
          const view: MessageView = {
            id: `u:${event.seq}`,
            role: "user",
            ts: event.time,
            text,
            segments: [],
            ...(media.length ? { attachments: media } : {}),
          };
          // 用户消息的落位分三种情形（服务端实测见 queueLogInspect/queue-order 探针）：
          //
          // 1. **本轮提问迟到**：turn/start 已把本轮助手消息建出来（流式正文甚至
          //    已经在跑了），提问才落盘。插到本轮助手消息之前（这一轮的顶部）。
          // 2. **运行中插话**：服务端把运行中提交的消息（队列自动派发、运行中
          //    发送）经 agent/inbox **splice 进还在跑的同一轮**——轮次不结束。
          //    表现是「紧邻助手消息的前一条是用户消息」。这时追加到末尾并把该轮
          //    **切到下一段**（turnPart+1）：后续生成进 `a:N:2`（新段在插话下方），
          //    而不是继续压在插话上方——那正是「生成内容在用户消息上方继续生成」
          //    的根源。
          // 3. **轮间正常到达**（当前轮已结束、新一轮未开始）：currentTurn 还停在
          //    上一轮，走追加分支即可，随后 turn/start 会把分段归位。
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
            // 插话切分：这一轮还有后续生成就让它进下一段（插话下方）。
            // currentTurn 未定（首轮之前）没有「本轮」可言，不切。
            if (assistant) this.turnPart += 1;
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
        // 工具结果的内容块：正文取自嵌套的 tool-result 块，图片句柄也在里面。
        // 不能只把整段拍成文本——`read_image` 的 image 块拍成文本就没了（见 settleTool）。
        const resultContent = toolResultContent(message?.content);
        const text = blocksToText(resultContent.length ? resultContent : message?.content);
        const isError =
          Boolean(data.error) ||
          (Array.isArray(message?.content) &&
            (message!.content as ContentBlock[]).some((b) => b.type === "tool-result" && b.isError));
        this.finishToolCall(event.time, callId, text, isError, data.meta, resultContent);
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
        // 申报的路径同样要分类（交付行与改动行共用一套记号）
        this.scheduleFileKinds();
        break;
      }

      case "command/run": {
        this.upsertCommandRun(event, data);
        break;
      }

      case "command/done": {
        this.finishCommandRun(event, data);
        break;
      }

      case "llm/retry": {
        // 模型请求失败正在重试。官方 web 端渲染重试提示（「正在重试 2/5…」）。
        // 此前这个类型在 `SILENT_EVENT_TYPES` 里**完全静默**，于是模型卡住重试时
        // 界面上毫无迹象——用户只看到「生成中…」不动，以为程序挂了。
        //
        // 它是一条**非表层**的日志事件（`surfaceOp` 不带 append），所以渲染它不
        // 违反「人类转写只取 append 来源」的契约：重试是系统状态，不是模型说的话。
        const retry = data as {
          retry?: unknown;
          maxRetries?: unknown;
          delayMs?: unknown;
          provider?: unknown;
        };
        const attempt = typeof retry.retry === "number" ? retry.retry : undefined;
        const max = typeof retry.maxRetries === "number" ? retry.maxRetries : undefined;
        if (attempt !== undefined) {
          this.setRetryNotice(
            event,
            max === undefined ? `@llmRetryAlways:${attempt}` : `@llmRetry:${attempt}:${max}`,
          );
        }
        break;
      }

      case "llm/retry-started": {
        // 重试等待结束、下一条请求即将发出：把「正在重试」的提示收掉，
        // 否则它会一直挂在那里，看起来像卡在重试里出不来
        this.clearRetryNotice();
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
    this.dropLiveSegmentsForStep(turn, step);

    /**
     * durable 的思考/正文插在**本 step 最早的工具行之前**，而不是追加到末尾。
     *
     * 为什么：模型是**边说边吐工具调用**的——`tool-call-delta` 流式帧会先把那个
     * 工具行建出来（`upsertToolCall`），该 step 的 durable `assistant/message`
     * （思考/正文）随后才到。追加会把思考/正文排到自己那个 step 的工具行**后面**：
     * 界面上就是「编辑 → 思考 → 编辑…」这种错位（用户 2026-09-15 报的），
     * 而官方按内容块顺序渲染——工具调用在内容里永远排在思考/正文之后。
     *
     * 锚点只认**同一个 step** 的工具行：跨 step 找会把上一步的工具行也当锚点，
     * 把后面的思考插到前面去。找不到（没有流式帧：重放、中途加入、无 tool-call-delta）
     * 就追加——那条路径的顺序本来就是对的。
     */
    let at = message.segments.findIndex((segment) => segment.kind === "tool" && segment.step === step);
    if (at < 0) at = message.segments.length;

    const content = Array.isArray(wire?.content) ? (wire!.content as ContentBlock[]) : [];
    for (const block of content) {
      if (block.type === "text" && block.text.trim()) {
        this.pushSegment(
          message,
          { kind: "text", id: `t${event.seq}:${this.sequence++}`, text: block.text },
          step,
          at++,
        );
      } else if (block.type === "reasoning" && block.text.trim()) {
        this.pushSegment(
          message,
          { kind: "thinking", id: `r${event.seq}:${this.sequence++}`, text: block.text },
          step,
          at++,
        );
      } else if (block.type === "image") {
        // 助手消息里的图片块：此前整块被丢掉，用户看不到模型给的图。
        // 句柄要换字节（一次 RPC），所以先挂一个空段、拿到 data URL 再补发。
        this.pushAssistantImages(message, event.seq, imageAttachments([block]), step, at++);
      }
      // `tool-call` / `tool-result` 块**故意不在这里渲染**：它们各自有
      // `tool/call`、`tool/result` 事件，已经折成工具行了，再画一遍就是重复
      // （官方渲染链对 `tool-call` 也是 `break`）。
      // 其余认不出的块走官方的 default 分支：留一条 JSON 记录，**不静默丢弃**
      // （`file` 块也在其中——官方同样没给它专属分支）。
      else if (block.type !== "tool-call" && block.type !== "tool-result") {
        this.pushSegment(
          message,
          {
            kind: "unknown",
            id: `u${event.seq}:${this.sequence++}`,
            type: String(block.type ?? "unknown"),
            json: boundedJson(block),
          },
          step,
        );
      }
    }

    // decode 窗口：本 step 首个 token delta → 该 durable 消息（均为服务端时钟）
    const firstTokenAt = this.stepFirstTokenAt;
    const usage = toUsage(data.usage, {
      firstTokenAt,
      endedAt: event.time,
    });
    this.stepFirstTokenAt = undefined;
    if (usage) {
      message.usage = usage;
      // 同步刷新上下文占用与速度：这条路径**每轮必到**，是占用条的常规刷新源
      // （投影走控制流，可能迟到甚至漏推）
      this.applyUsage(usage);
    }
    // 整轮指标：本 step 的解码窗口与输出 token 累加进去（官方 deriveStats 的口径），
    // TTFT 只取本轮第一步的（`firstStepTtftMs`）
    if (firstTokenAt !== undefined) {
      const metrics = this.turnMetrics.get(message.id) ?? { decodeMs: 0, decodeTokens: 0 };
      metrics.decodeMs += Math.max(0, event.time - firstTokenAt);
      metrics.decodeTokens += usage?.outputTokens ?? 0;
      if (metrics.ttftMs === undefined && this.stepStartedAt !== undefined) {
        metrics.ttftMs = Math.max(0, firstTokenAt - this.stepStartedAt);
      }
      this.turnMetrics.set(message.id, metrics);
    }
    if (wire?.source?.kind === "model" && typeof wire.source.model === "string") {
      message.model = wire.source.model;
    }
    if (data.interrupted) message.error = "@interrupted";
    this.emit({ type: "message/upsert", message: { ...message } });
  }

  /**
   * 助手消息里的图片块 → 一个 `images` 段，字节异步补。
   *
   * 与工具结果里的图片同一套机制（`loadImages` 由控制器注入，做
   * `session/attachment` 的 RPC）：先挂空段，字节到了用 `message/segment` 覆盖。
   * 拿不到 `loadImages`（子代理转录那类没有网络客户端的适配器）就不挂段——
   * 挂一个永远空着的图库位比不显示更让人困惑。
   */
  private pushAssistantImages(
    message: MessageView,
    seq: number,
    refs: ImageRef[],
    step?: number,
    at?: number,
  ): void {
    if (!refs.length || !this.loadImages) return;
    const id = `img${seq}:${this.sequence++}`;
    const segment: Segment = { kind: "images", id, images: [] };
    this.pushSegment(message, segment, step, at);
    this.loadImages(refs, (dataUrls) => {
      const holder = message.segments.find((item) => item.id === id);
      if (!holder || holder.kind !== "images") return;
      holder.images = dataUrls;
      this.emit({ type: "message/segment", messageId: message.id, segment: { ...holder } });
    });
  }

  /**
   * 上下文占用 = 官方 `contextOccupancy(contextPressure)` 的口径：
   * ```
   * 分子 = pressure.projectedTokens ?? pressure.pressureTokens
   * 百分比 = min(100, round(分子 / pressure.contextWindow * 100))
   * ```
   *
   * **口径为什么是这个**：
   * - 分子**不含 output**——它是「请求的 prompt 有多大」，不是「这轮花了多少」。
   *   用 `usage.totalTokens` 会混进回复的输出，系统性偏高；
   * - `projectedTokens` 优先：它是「**下一次**请求的 prompt 会是多少」=
   *   `pressureTokens` + 表面自那次采样以来的增减。**这是唯一会逐轮变化的那个**
   *   （实测：小对话里 `pressureTokens` 连续三轮都是 19206，而 `projectedTokens`
   *   19215 → 19844 每轮都动），且**压缩后会下降**——`pressureTokens` 做不到，
   *   因为压缩不产生 usage 事件（docs/audit-summary.md §15）。
   *
   * **分子的来源顺序**（实测依据见 `scripts/pressureProbe.ts`）：
   * 1. 官方 `projectedTokens` / `pressureTokens`（投影）；
   * 2. **本地同口径复算**：`inputTokens + cacheReadTokens + cacheWriteTokens`。
   *    这三个桶之和与官方 `pressureTokens` **逐字相等**（实测 19206 == 19206），
   *    所以它不是「另算一个近似值」，而是同一个测量的另一个来源；
   * 3. 都没有 → **保留上一次显示的值**。
   *
   * 第 2、3 条是为了满足用户明确的要求（2026-09-12）：占用条要**常驻显示**，
   * 不能因为投影还没到就空着或停住。实测投影的分子**要等下一次请求上报 usage
   * 才出现**（第一轮结束后只有分母、没有分子），那段时间界面必须有数可显示。
   *
   * 分母同理：优先投影里的 `contextWindow`（官方把压力与容量成对放在同一个投影里），
   * 回退到 `request/context` 事件的那份——两者是同一个量。
   */
  private refreshOccupancy(): void {
    const numerator =
      this.contextPressure?.projectedTokens ??
      this.contextPressure?.pressureTokens ??
      this.localPressureTokens;
    const denominator = this.contextPressure?.contextWindow ?? this.contextWindow?.tokens;
    // 一个来源都没有：**什么都不做**——保留上一次的值，而不是清空。
    // （占用条是常驻指示器；中途空一下比显示一个略旧的数字更让人困惑。）
    if (typeof numerator !== "number" || typeof denominator !== "number" || denominator <= 0) return;
    const next = {
      percent: Math.min(100, Math.round((numerator / denominator) * 100)),
      usedTokens: numerator,
      contextWindow: denominator,
    };
    // 只在真的变了的时候下发：同一轮里投影能推十来次，每次都发帧是白刷界面
    if (sameOccupancy(this.contextOccupancy, next)) return;
    this.contextOccupancy = next;
    this.emit({ type: "patch", patch: { contextOccupancy: next } });
  }

  /**
   * 每来一份用量就刷新占用。
   *
   * 这是**每轮都会触发的刷新源**：投影走控制流、可能迟到甚至漏推，而
   * `assistant/message` 的 usage 走跟随流、每轮必到。此前的实现把刷新只挂在
   * 投影上，于是投影不动时占用条就跟着不动（用户报「好几轮都没刷新」）。
   */
  private applyUsage(usage: UsageView | undefined): void {
    const local = pressureFromUsage(usage);
    if (local !== undefined) this.localPressureTokens = local;
    this.refreshOccupancy();
    this.rememberUsage(usage);
  }

  /** `contextPressure` 投影的原始值（占用条的首选来源）。 */
  private contextPressure: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } = {};

  /** 本地复算的同口径压力（`input + cacheRead + cacheWrite`），投影没给分子时兜底。 */
  private localPressureTokens: number | undefined;

  /**
   * 应用 `contextPressure` 投影并刷新占用条。
   *
   * 由控制器在收到投影帧时调用：投影走控制流、事件走跟随流，两者的到达顺序
   * 不保证，所以不能假设「先有 usage 再有压力」。
   *
   * 这里**整体替换**（而不是逐字段合并），与官方一致：投影的 view 是宿主由折叠
   * 状态整体算出来的快照、不是差分。逐字段合并反而会把宿主已经作废的槽留下
   * （例如换了模型、容量未知），得到官方明确不保证的组合。
   */
  applyContextPressure(pressure: {
    pressureTokens?: number;
    projectedTokens?: number;
    contextWindow?: number;
  }): void {
    this.contextPressure = pressure;
    // 分母也同步一份给**别处**用（占用条本身只看投影）：`request/context` 事件与
    // 投影里的 capacity 是同一件事，谁新用谁
    if (typeof pressure.contextWindow === "number" && pressure.contextWindow > 0) {
      this.contextWindow = { tokens: pressure.contextWindow, model: this.contextWindow?.model ?? "" };
    }
    this.refreshOccupancy();
  }

  // ---------- 瞬态流式帧 ----------

  applyAssistantStream(frame: AssistantStreamFrame): void {
    if (frame.type === "start") {
      // 轮号变化才算新轮（插话切分后同轮的后续 start 帧不能重置分段，
      // 否则切分又失效、生成回到插话上方）
      if (frame.turn !== this.currentTurn) this.turnPart = 1;
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
        this.dropLiveSegmentsForTurn(this.currentTurn ?? 0);
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
          // 流式 usage 帧同样进占用与速度（同 `assistant/message` 那条路径）
          this.applyUsage(usage);
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
    this.turnEndSeqs.clear();
    // **清掉已记录的事件**：snapshot 是一次全新的开窗，旧窗口的记录不再有效
    // （重连后服务端会重发基线，留着会与新窗口的 seq 集合混在一起）
    this.seen.clear();
    this.currentTurn = undefined;
    this.turnPart = 1;
    this.currentStep = 0;
    this.stepFirstTokenAt = undefined;
    this.turnRunning = false;
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
    const id = this.currentAssistantId();
    let message = this.byId.get(id);
    if (!message) {
      message = { id, role: "assistant", ts, segments: [] };
      this.appendMessage(message);
    }
    return message;
  }

  private currentAssistantMessage(): MessageView | undefined {
    if (this.currentTurn === undefined) return undefined;
    return this.byId.get(this.currentAssistantId());
  }

  /** 某（轮, 段）的助手消息 id：第 1 段 `a:N`，后续段 `a:N:2`、`a:N:3`… */
  private assistantIdFor(turn: number, part: number): string {
    return part > 1 ? `a:${turn}:${part}` : `a:${turn}`;
  }

  /** 当前（轮, 段）对应的助手消息 id。 */
  private currentAssistantId(): string {
    return this.assistantIdFor(this.currentTurn ?? 0, this.turnPart);
  }

  /**
   * 斜杠命令节点：`command/run` ↔ `command/done` 按 `commandId` 配对。
   *
   * 两个事件都是**会话日志事件**（不是模型表层），所以不论命令从哪来——手打的
   * 一行、还是界面上的按钮（权限预设、计划模式）——都会在这里留下一条可见记录。
   * 官方 web 端同样把它渲染成持久节点；此前这两个类型在 `SILENT_EVENT_TYPES`
   * 里，命令执行结果无处可见。
   */
  private upsertCommandRun(event: SessionWireEvent, data: Record<string, any>): void {
    const commandId = String(data.commandId ?? "");
    const name = String(data.name ?? "");
    if (!commandId || !name) return;
    const message = this.ensureAssistantMessage(event.time);
    const id = `cmd:${commandId}`;
    const args = typeof data.args === "string" && data.args.trim() ? data.args.trim() : undefined;
    const command: CommandRunView = { commandId, name, args, state: "running" };
    const index = message.segments.findIndex((segment) => segment.id === id);
    if (index >= 0) {
      message.segments[index] = { kind: "command", id, command };
      this.emit({ type: "message/segment", messageId: message.id, segment: { kind: "command", id, command } });
      return;
    }
    const segment: Segment = { kind: "command", id, command };
    this.pushSegment(message, segment);
    this.emit({ type: "message/append", messageId: message.id, segment });
  }

  /**
   * 结算一条命令。
   *
   * 配对不到 `command/run` 时（跟随窗口把 call 截在外面）仍补一个只带结果的节点：
   * 丢掉结果比多一行更难查（与 `tool/result` 的处理口径相反，是有意的——
   * 那边 call 是卡片的全部内容，这边结果本身就是内容）。
   */
  private finishCommandRun(event: SessionWireEvent, data: Record<string, any>): void {
    const commandId = String(data.commandId ?? "");
    if (!commandId) return;
    const id = `cmd:${commandId}`;
    const ok = data.kind !== "error";
    const text = typeof data.text === "string" && data.text ? data.text : undefined;
    for (const message of this.messages) {
      const segment = message.segments.find((s) => s.id === id);
      if (segment?.kind !== "command") continue;
      segment.command.state = ok ? "ok" : "error";
      segment.command.text = text;
      this.emit({
        type: "message/segment",
        messageId: message.id,
        segment: { kind: "command", id, command: { ...segment.command } },
      });
      return;
    }
    const message = this.ensureAssistantMessage(event.time);
    const command: CommandRunView = { commandId, name: "", state: ok ? "ok" : "error", text };
    const segment: Segment = { kind: "command", id, command };
    this.pushSegment(message, segment);
    this.emit({ type: "message/append", messageId: message.id, segment });
  }

  private appendMessage(message: MessageView): void {
    this.messages.push(message);
    this.byId.set(message.id, message);
    this.emit({ type: "message/upsert", message: { ...message } });
  }

  private pushSegment(message: MessageView, segment: Segment, step?: number, at?: number): void {
    // 顺手记下所属 step：轮级过程折叠靠它区分「过程」与「答案」（见 shared/chat.ts
    // 的 Segment 注释）。显式传进来的优先（durable 事件里带着 step 的最准），
    // 其余（工具结果等）用当前的 step 号。
    if (segment.step === undefined) segment.step = step ?? this.currentStep;
    // `at` 是**插入位置**（durable 的思考/正文要插在本 step 的工具行之前，
    // 见 applyAssistantMessage）：越界或没给就照旧追加。
    if (at === undefined || at >= message.segments.length) message.segments.push(segment);
    else message.segments.splice(Math.max(0, at), 0, segment);
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
    const form = typeof origin.form === "string" ? origin.form : undefined;
    const injected: InjectedView = {
      sourceKind: typeof origin.kind === "string" ? origin.kind : "unknown",
      plugin: typeof origin.plugin === "string" ? origin.plugin : undefined,
      form,
      text,
      // 按 form 解析 `source` 里的结构化字段（官方 `ContextBody` 就是按 form 分派正文的）。
      // 形状不合预期时整项不填 → 界面退回「正文 + 原样字段」，不显示半截列表。
      source: injectedSourceFields(form, source),
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
  private settleStreaming(message: MessageView): boolean {
    let changed = false;
    for (const segment of message.segments) {
      if ((segment.kind === "text" || segment.kind === "thinking") && segment.streaming) {
        segment.streaming = false;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 收掉该轮该 step 的流式叠加层，durable 内容到达时去重。
   *
   * **跨段清理**：叠加层记录在哪一段就从哪一段摘。运行中插话把轮切分后，
   * 同一个 (turn, step) 的 durable 内容可能落在与叠加层不同的段
   * （切分发生在叠加层与其 durable 替换之间），按 message 过滤会漏。
   */
  private dropLiveSegmentsForStep(turn: number, step: number): void {
    for (const [key, value] of [...this.liveSegments]) {
      if (value.turn !== turn || value.step !== step) continue;
      this.removeLiveSegment(key, value);
    }
  }

  /** 收掉该轮**全部**流式叠加层（轮被放弃时）。同样跨段。 */
  private dropLiveSegmentsForTurn(turn: number): void {
    for (const [key, value] of [...this.liveSegments]) {
      if (value.turn !== turn) continue;
      this.removeLiveSegment(key, value);
    }
  }

  private removeLiveSegment(
    key: string,
    value: { messageId: string; segmentId: string; turn: number; step: number },
  ): void {
    this.liveSegments.delete(key);
    const holder = this.byId.get(value.messageId);
    if (!holder) return;
    const index = holder.segments.findIndex((s) => s.id === value.segmentId);
    if (index >= 0) {
      holder.segments.splice(index, 1);
      this.emit({ type: "message/upsert", message: { ...holder } });
    }
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

  private finishToolCall(
    ts: number,
    callId: string,
    output: string,
    isError: boolean,
    meta?: unknown,
    content?: ContentBlock[],
  ): void {
    const entry = this.toolSegments.get(callId);
    if (!entry) {
      // tool/call 落在跟随窗口之外（`maxMessages` 截断）：结果本身仍有价值，
      // 不能整条丢掉。官方在这种情况下回退成一张只有结果、头部显示 callId 的
      // 卡片（`rootResult` 的 `call: null`），这里同样补一个占位卡片。
      this.orphanToolCall(ts, callId, output, isError, meta, content);
      return;
    }
    const message = this.byId.get(entry.messageId);
    const segment = message?.segments.find((s) => s.id === entry.segmentId);
    if (!message || !segment || segment.kind !== "tool") return;
    this.settleTool(message, segment, ts, output, isError, meta, { content });
  }

  /**
   * 结算一个工具调用（成功 / 失败 / 中断三种收场共用）。
   *
   * 抽出来是因为「中断」这条路径是**合成**的：`turn/end` 因 abort 收场时，官方
   * 为所有还没结算的调用补一个 `error.code === 'interrupted'` 的结果——否则这些行
   * 会永远停在「运行中」，看起来像任务卡死。
   */
  private settleTool(
    message: MessageView,
    segment: Extract<Segment, { kind: "tool" }>,
    ts: number,
    output: string,
    isError: boolean,
    meta: unknown,
    options: { interrupted?: boolean; content?: unknown } = {},
  ): void {
    const tool = segment.tool;
    // 终端类结果：先把尾部标记行剥掉并取出退出状态。
    // bash / pwsh **故意**不把非零退出标成 isError（「退出状态是结果数据」），
    // 所以失败必须在这里自己判定，否则 `exit 1` 和 `exit 0` 长得一模一样。
    const terminal = classifyTool(tool.name) === "bash" ? parseExitStatus(output) : undefined;
    tool.output = parseToolResult(terminal ? terminal.output : output);
    if (terminal) {
      tool.exitCode = terminal.exitCode;
      tool.signal = terminal.signal;
    }
    const failed = isError || (terminal !== undefined && terminalFailed(terminal));
    tool.status = options.interrupted ? "stopped" : failed ? "error" : "ok";
    // 结果里的真实 hunk（3 行上下文，由工具自己算）优先于参数推导的预览
    const fromMeta = hunksFromMeta(meta);
    if (fromMeta) tool.diff = fromMeta;
    // 读取节点：只读了一段时把行号记下来，界面缀在文件名后（整篇读取不标注）
    if (!failed && !options.interrupted) tool.readLines = readLinesOf(tool, output, meta);
    // 图片结果：`read_image` 回带一个 image 内容块，`attachment` 是**不透明句柄**
    // （不是路径也不是 URL），此前整块被 `blocksToText` 丢掉 → 图完全看不到。
    // 句柄要换成可显示的 data URL，需要一次 RPC，所以回调出去异步补。
    const refs = imageAttachments(options.content);
    if (refs.length > 0) {
      // 先占位再替换：段落在这一帧就要带上 images（界面据此展开图库位），
      // 字节到达后由回调再发一次 message/segment 覆盖。
      tool.images = refs.map(() => "");
      this.loadImages?.(refs, (dataUrls) => {
        tool.images = dataUrls;
        this.emit({
          type: "message/segment",
          messageId: message.id,
          segment: { ...segment, tool: { ...tool } } as Segment,
        });
      });
    }
    tool.endedAt = ts;
    this.emit({
      type: "message/segment",
      messageId: message.id,
      segment: { ...segment, tool: { ...tool } } as Segment,
    });
    this.rememberProduced(message, tool, failed);
  }

  /**
   * 给「窗口外的 tool/result」补一张卡片。
   *
   * 工具名拿不到（call 事件被截断），所以标题留空、detail 用 callId——与官方的
   * 处理一致（`argsRaw === ""` 时 summary 就是 callId）。宁可显示一条信息不全的
   * 记录，也不要静默丢弃：用户看到的「工具结果不见了」比「工具名不知道」难查得多。
   */
  private orphanToolCall(
    ts: number,
    callId: string,
    output: string,
    isError: boolean,
    meta: unknown,
    content?: ContentBlock[],
  ): void {
    const message = this.ensureAssistantMessage(ts);
    if (this.toolSegments.has(callId)) return;
    const tool: ToolCallView = {
      id: callId,
      name: "",
      title: "",
      detail: callId,
      status: "running",
      output: parseToolResult(output),
      startedAt: ts,
    };
    const segment: Segment = { kind: "tool", id: `tool:${callId}`, tool };
    this.pushSegment(message, segment);
    this.toolSegments.set(callId, { messageId: message.id, segmentId: segment.id });
    this.emit({ type: "message/append", messageId: message.id, segment });
    this.settleTool(message, segment as Extract<Segment, { kind: "tool" }>, ts, output, isError, meta, {
      content,
    });
  }

  /**
   * 中止本轮：为所有**仍在运行**的工具调用合成一个中断结果。
   *
   * 官方语义（`projectBlock`）：只有未结算的调用会被合成，结果是
   * `isError: true` + `error.code === 'interrupted'`，而界面把它渲染成
   * **stopped**（警告色）而不是 error——中断不是工具的失败。
   *
   * @returns 是否有调用被合成（界面据此决定要不要重绘）。
   */
  private synthesizeInterrupted(ts: number): boolean {
    let changed = false;
    for (const [, entry] of this.toolSegments) {
      const message = this.byId.get(entry.messageId);
      const segment = message?.segments.find((s) => s.id === entry.segmentId);
      if (!message || !segment || segment.kind !== "tool") continue;
      if (segment.tool.status !== "running" && segment.tool.status !== "pending") continue;
      this.settleTool(message, segment as Extract<Segment, { kind: "tool" }>, ts, "", true, undefined, {
        interrupted: true,
      });
      changed = true;
    }
    return changed;
  }

  /**
   * 记下本轮**产生**的文件（成功的写类调用）。
   *
   * 与 `deliverables/presented`（`present` 工具的显式申报）是两条独立来源，官方
   * 也分开算：这一条不依赖模型记得在收尾正文里点名。路径按首次出现去重排序，
   * 所以同一轮里「先写后改」的文件只列一次。
   *
   * 用 `message/upsert` 整体下发：`produced` 是消息级字段，`message/segment`
   * 只更新单段，界面收不到它。
   */
  private rememberProduced(message: MessageView, tool: ToolCallView, isError: boolean): void {
    if (isError) return;
    const path = producedPath(tool.name, tool.input ?? "");
    if (!path) return;
    const list = message.produced ?? (message.produced = []);
    if (list.includes(path)) return;
    list.push(path);
    this.emit({ type: "message/upsert", message: { ...message } });
    // 新路径进芯片了：安排一次分类（去抖），让 [新增]/删除线跟上来
    this.scheduleFileKinds();
  }

  /**
   * 记下当前的重试提示节点 id（`llm/retry` 建的），`llm/retry-started` 时收掉。
   *
   * 用「一个常驻节点、内容原地更新」而不是每次重试都追加一条：连续重试会产生
   * 一串几乎一样的提示，把对话刷满。id 固定 ⇒ 同一条事件重放也不会堆叠。
   */
  private retrySegmentId: string | undefined;

  /** 显示（或更新）「模型正在重试」提示。 */
  private setRetryNotice(event: SessionWireEvent, text: string): void {
    const message = this.ensureAssistantMessage(event.time);
    const id = "llm-retry";
    const index = message.segments.findIndex((segment) => segment.id === id);
    const segment: Segment = { kind: "notice", id, level: "warn", text };
    if (index >= 0) {
      message.segments[index] = segment;
      this.emit({ type: "message/segment", messageId: message.id, segment });
    } else {
      this.pushSegment(message, segment);
      this.emit({ type: "message/append", messageId: message.id, segment });
    }
    this.retrySegmentId = id;
  }

  /** 收掉「模型正在重试」提示（重试成功、下一条请求开始）。 */
  private clearRetryNotice(): void {
    if (this.retrySegmentId === undefined) return;
    const id = this.retrySegmentId;
    this.retrySegmentId = undefined;
    for (const message of this.messages) {
      const index = message.segments.findIndex((segment) => segment.id === id);
      if (index < 0) continue;
      message.segments.splice(index, 1);
      this.emit({ type: "message/upsert", message: { ...message } });
      return;
    }
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
