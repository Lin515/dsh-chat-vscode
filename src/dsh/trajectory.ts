/**
 * 「轨迹」的宿主侧折叠：把 durable 会话事件折成官方那种**账本**（turn → group → cell）。
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
 * 契约、界面口径与差距清单见 `docs/design-trajectory.md`（文案登记表就是
 * `trajectoryTexts.ts`，文档不再复列清单）。
 *
 * ## 与官方实现的刻意差异（都写在这里，免得下次当成 bug 查）
 *
 * 1. **流式中的助手正文**（官方 `PartialAssistant`）不单独出行：官方把「未结算的
 *    助手流」折成一条 `requestOnly` 行，本扩展的流式叠加层语义与它不同，映射错会
 *    出现重复行。这里只出**已结算**的 `assistant/message`，加上「已发起未结算」的
 *    工具行（这两类是 durable 的，不会重复）。**布局仍然跟踪「在跑的流」的身份**
 *    （官方的 `TrajectorySnapshot.partial`）：「初始 / 更新提示词那一行归哪一轮」要用它
 *    兜底，见 `streamStates` 那一段——跟踪的是身份，不是内容。
 * 2. **系统提示词的独立更新**按 `request/header` 的变化合并：`system/message` 自己
 *    的多次改写不单独出行（官方会出）。初始与「变了」两种都在。
 * 3. **`session/end-seed`** 不产生行（官方也只是一条边界），只用来标记「is-seed」。
 * 4. **请求编号**按 `step/start` / `compaction/start` 递增，与官方从
 *    `RequestView.startSeq` 派生的编号在**常见情形**下一致（每个 step 一次请求）。
 * 5. 时间线**不在本层**：本层只把 `startedAt` / `timeSeconds` / `assistantMetrics` 算好，
 *    时间线投影在界面侧（`src/webview/trajectoryTimeline.ts` + vendor 的 `timeline.ts`）。
 *
 * ## 请求表（`TrajectoryModel.requests`）
 *
 * 官方把「一次模型请求」做成 `RequestView[]`（`ui-conversation` 折出来的
 * `{startSeq, startedAt, completedAt, status, usage, …}`），账本行上只有一个请求号。
 * 本扩展没有那一层，所以在同一次遍历里顺手折出等价的一张表（`TrajectoryRequest`），
 * 供请求级检查器（选项 / 用量含会话累计 / 请求计时）使用。判据逐条对着官方：
 *
 * - `startedAt` 取 **`step/start` 的事件时刻**（官方 `initialState` 的 `startTime`）。
 *   曾经从 `assistant/message` 的 `data.startedAt` 取——那个字段在真实日志里
 *   **一条都没有**（438 份日志、3503 条助手消息全无），于是 `assistantMetrics.timingRecorded`
 *   恒为 false，计时页签永远只显示「未记录」。
 * - 重试来自 `llm/retry`（`retry` / `maxRetries` / `delayMs` / `failure`），
 *   失败文案经 `displayFailure()`，`AUTH` 码下清空。
 * - 用量取结算帧 `assistant/message` 的 `usage`；**会话累计**按请求号顺序逐个相加
 *   （官方 `cumulativeUsage`）——收尾后统一算，不边折边加（结算帧到达顺序在
 *   overflow 恢复时序里与请求号顺序相反）。
 * - **助手请求与压缩请求分开记**：助手请求按 `turn:step` 存一张表（与官方
 *   `trajectory-assistant-step` 的 definition id 同一身份），压缩请求自己一份；
 *   都**按帧自己的身份查表，查不到就不写**（只有帧自己没带 `turn`/`step` 的畸形帧才
 *   退回窗口当前步、再退最后一次助手请求）——overflow 恢复时 `compaction/start` 会插在
 *   `step/start` 与同一步的 `assistant/message` 之间，取那个值就会把助手的结算
 *   （状态 / 用量 / 选项 / 收尾时刻 / 计时开始）全落到压缩请求上。
 * - **请求状态按官方 `assistantRequest()` 派生**：非中断的 `assistant/message`
 *   （最终节点）优先 → `complete`；没有最终节点时，`llm/retry` 或步骤关闭
 *   （`boundary`）任一成立 → `error`，否则 `running`。重试事实（失败文案 / 错误码 /
 *   次数 / 上限 / 延迟）与状态**分开**记，重试后成功的请求照样留着它们（官方同形）。
 * - **请求配置按官方两条分支取**（`headerFor()`）：这一步有 header 就用这一步最新的
 *   那一帧；没有就继承「这个请求开始之前」最后生效的那一帧（`step/start` 开请求时先挂上，
 *   随后到达的本步 header 再整份替换）。配置没变时服务端不再发 header，少了这份继承，
 *   第二步之后的请求「选项」页签会整个消失，而 `reasoningEffort` / `maxTokens` 补不回来
 *   （结算帧只带 provider / model）。窗口里没有 header 就不挂配置——**不从结算帧倒推**。
 *   归属按**事件落点步骤**（官方 `ConversationLocationIndex` 口径）：落点在某一步上就写那一步
 *   的助手请求——含「该步助手消息已结算、`step/end` 还没到」的时序（官方 `headersByStep` 是
 *   预扫描，结算不等于步骤关闭）；落点不在步骤上（两步之间、轮次已收尾）则谁都不回写，只作为
 *   后续请求继承的配置。配置与**身份**分开：`assistant/message` 的 `message.source` 是请求
 *   自己的身份（官方 `providerMetadata`），逐字段优先于 header 的 `provider` / `model`。
 *   口径见 `docs/design-trajectory.md` 的请求表与请求配置两段。
 *
 * 纯函数、不引 vscode：断言见 `scripts/trajectory.test.ts`。
 */
import type { SessionWireEvent } from "./protocol";
import { blocksToText } from "./adapter";
import { displaySessionMentions } from "../shared/mentions";
import { TRAJECTORY_COMPACTION_INTERRUPTED } from "../shared/trajectory";
import type {
  TrajectoryAttachmentRef,
  TrajectoryCell,
  TrajectoryGroup,
  TrajectoryModel,
  TrajectoryPromptChange,
  TrajectoryRequest,
  TrajectoryRequestOptions,
  TrajectoryRequestUsage,
  TrajectorySourceBlock,
  TrajectoryToolSchema,
  TrajectoryTurn,
  TrajectoryUsage,
} from "../shared/trajectory";
import { applyNextStepSplice, claimedByNextStep, type InboxState } from "./inboxClaim";

/** 折叠时能看到的字段（`data` 是任意 JSON，逐字段守卫，不猜形状）。 */
type EventData = Record<string, unknown>;

interface MessageLike {
  /** 消息 id（inbox 状态机的领取集合按它匹配，见 `agent/inbox/spliced` 那一段）。 */
  id?: unknown;
  content?: unknown;
  source?: { kind?: unknown; plugin?: unknown; round?: unknown; callId?: unknown } & Record<string, unknown>;
  /** 工具结果消息的失败标记（0.1.7-alpha.1 起在此，旧信封在内容块上）。 */
  isError?: unknown;
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

/**
 * 内容块里某一类块的文本（官方在助手消息里按 `\n\n` 连接同类块，别处按 `\n`）。
 *
 * `blocksToText` 只认「正文」且把工具结果的内层文本也拉进来；这里是**按块类型**
 * 取值——助手一行的正文与思考必须分开（官方的 `messageText` / `thinkingText`）。
 */
function blockTexts(content: unknown, type: string, separator = "\n"): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: string } | undefined)?.type === type)
    .map((block) =>
      typeof (block as { text?: unknown }).text === "string" ? ((block as { text: string }).text) : "",
    )
    .join(separator);
}

/** 内容块里某一类块的条数（官方 `imageBlockCount` 同一口径）。 */
function blockCount(content: unknown, type: string): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => (block as { type?: string } | undefined)?.type === type).length;
}

/** 第一个同类块的**原文**（官方 `previewContent`：预览只取首块，不拼接）。 */
function firstBlockText(content: unknown, type: string): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const entry = block as { type?: string; text?: unknown };
    if (entry?.type === type && typeof entry.text === "string") return entry.text;
  }
  return undefined;
}

/**
 * 官方 `isTokenDelta()`（`dsh-llm` 的 `assistant-stream.ts`）：这个 chunk 是不是
 * 「模型的第一个输出 token」。
 *
 * 三条判据逐字照搬（**不是**界面上看不看得见那一套 `isVisibleChunk`）：
 * - `text-delta` / `reasoning-delta`：`text !== ''`——**空白字符串也算 token**，不 trim；
 * - `tool-call-delta`：`argumentsDelta !== '' || name !== undefined`——只带名字
 *   （名字是空串也算带名字）的片段照样算，连名字都没有且参数也为空才跳过；
 * - 其余（`block-start` / `block-end` / `usage` / `finish`）一律不算。
 *
 * **适配边界加强**：官方那支信任静态类型（`assistant-stream.ts` 文件头：
 * 「Readers trust the static record type」），契约里这三个字段都是 string，所以
 * 合法输入上下面两条判据与官方逐字同值；但畸形帧（缺字段 / 非字符串）在官方口径下
 * `undefined !== ''`、`name !== undefined` 仍为真，会拿这一帧的时刻冒充 TTFT。
 * 本扩展到处都按**肯定证据**读（`typeof … === "string"`），非字符串片段不是 token 候选。
 */
function isTokenDelta(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null) return false;
  const typed = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown };
  switch (typed.type) {
    case "text-delta":
    case "reasoning-delta":
      return typeof typed.text === "string" && typed.text !== "";
    case "tool-call-delta":
      return (typeof typed.argumentsDelta === "string" && typed.argumentsDelta !== "")
        || typeof typed.name === "string";
    default:
      return false;
  }
}

/**
 * packed run 的成员是不是「非空片段」的**肯定证据**（`texts` / `args` 契约里都是
 * `string[]`）：非字符串成员不是 token 候选，跳过它继续找后面的合法片段——
 * 与 `assistantStreamFirstTokenTime()` 外层「一条记录折不出时刻就继续下一条」同一套读法。
 */
function isTokenFragment(member: unknown): boolean {
  return typeof member === "string" && member !== "";
}

/**
 * 一条 packed run 里首个命中判据的成员时刻（官方 `firstRunMemberTime()`）：
 * 成员时刻 = `time0 + Σ dt`（`dt` 存的是相邻成员的间隔）。
 */
function firstRunMemberTime(
  time0: unknown,
  dt: unknown,
  members: unknown,
  accept: (member: unknown) => boolean,
): number | null {
  if (typeof time0 !== "number" || !Array.isArray(dt) || !Array.isArray(members)) return null;
  let time = time0;
  for (let index = 0; index < members.length; index += 1) {
    if (index > 0) {
      const gap = dt[index - 1];
      if (typeof gap !== "number") return null;
      time += gap;
    }
    if (accept(members[index])) return time;
  }
  return null;
}

/**
 * 一条 `AssistantStreamRecord` 的首个 token 时刻（官方 `runFirstTokenTime()` 加
 * `isTokenDelta()` 的 raw 分支）。认不出的记录一律 null——**裸 `{time}` 不是合法
 * chunk**，不能拿它冒充首 token 时刻。
 *
 * 成员判据用 `isTokenFragment()`（只认 string），`name` 用 `typeof === "string"`
 * 而非官方的 `!== undefined`：合法输入（`name?: string`）上两者同值——空串名字照样算
 * name-bearing——畸形帧的 `name: null` / 缺 `args` 则不再被当成 token。
 */
function recordFirstTokenTime(record: Record<string, unknown>): number | null {
  switch (record.type) {
    case "chunk": {
      const time = record.time;
      return typeof time === "number" && isTokenDelta(record.chunk) ? time : null;
    }
    case "text-chunks":
    case "reasoning-chunks":
      // 文本与思考的 run 口径相同：首个**非空**片段的累加时刻
      return firstRunMemberTime(record.time0, record.dt, record.texts, isTokenFragment);
    case "tool-call-chunks": {
      // 带 `name` 的 run 从 `time0` 起就是 token（参数片段还没来也算）；否则看首个非空参数
      if (typeof record.name === "string" && typeof record.time0 === "number") return record.time0;
      return firstRunMemberTime(record.time0, record.dt, record.args, isTokenFragment);
    }
    default:
      return null;
  }
}

/**
 * `assistant/message` / `assistant/attempt` 的 `data.stream` 里首个 token 的时刻
 * （官方 `assistantStreamFirstTokenTime()`；取不到就是 null）。
 *
 * 从前这里只读 `stream[0].time`：非 token 的 raw 帧（`block-start` / `usage` /
 * `finish`）与空片段会被当成首 token，而 packed run（`time0` + `dt`，记录里根本
 * 没有 `time` 字段）永远折不出时刻——TTFT / 生成 / 吞吐因此整块「不可用」。
 */
function streamFirstTokenTime(stream: unknown): number | null {
  if (!Array.isArray(stream)) return null;
  for (const record of stream) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const time = recordFirstTokenTime(record as Record<string, unknown>);
    if (time !== null) return time;
  }
  return null;
}

/**
 * 助手消息内容里那些工具调用的 `callId`（顺序即模型发出的顺序）。
 *
 * 界面侧「返回它的发起者」要用它把工具记录挂回助手那一行（官方 `parentRecords()`
 * 吃的是助手格的 `sourceBlocks[].callId`；我们没采集 `sourceBlocks`，只摘 id）。
 * 没有 id 的调用块跳过——**拿不到证据就不挂**，宁可不给这条链接，也不挂错父行。
 *
 * **字段名是 `id`，不是 `callId`**：契约 `@deepseek-ai/dsh-llm` 的 `ToolCallBlock` 就是
 * `{ type, id, name, arguments }`，官方投影层也一律 `String(block.id)`
 * （`trajectory-event-projection.ts` / `conversation-nodes/event-projection.ts`）。
 * 这里从前按 `callId` 读——那个名字是**工具调用自己的**（`tool/call` 事件与 `tool` 角色的
 * 消息），不是内容块上的。于是这一项在真实数据上**恒为空**（实测本机 455 份日志
 * 58776/58776 个调用块带的是 `id`），工具行那条「助手消息」层级链接永远不出现，而它是
 * 绿的：合成夹具当初照着错名字写的。两个名字都读、`id` 优先。
 */
function callIdsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    const typed = block as { type?: unknown; id?: unknown; callId?: unknown } | undefined;
    if (typed?.type !== "tool-call") continue;
    const raw = typed.id ?? typed.callId;
    if (typeof raw === "string" && raw !== "") ids.push(raw);
  }
  return ids;
}

/**
 * 工具结果正文：**两种信封都认，新形状优先**（与 adapter 的 `toolResultParts` 同口径）。
 *
 * - 新形状（0.1.7-alpha.1 起）：内容块直接是 `message.content`；
 * - 旧信封（0.1.6-alpha.2 及更早）：文本在**嵌套**的 `tool-result` 块里。
 */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const nested = content.filter(
    (block): block is { content?: unknown } => (block as { type?: string } | undefined)?.type === "tool-result",
  );
  if (nested.length === 0) return blocksToText(content);
  const inner = nested.flatMap((block) => (Array.isArray(block.content) ? (block.content as unknown[]) : []));
  return blocksToText(inner.length ? inner : content);
}

/** 工具结果是不是失败。
 *
 * 判据与 adapter 逐字一致：有 `data.error`，**或**消息自己/旧的嵌套 `tool-result` 块
 * 标了 `isError: true`。0.1.7-alpha.1 起失败标记移到**消息**上（`ToolResultMessage.isError`），
 * 旧信封把它放在内容块上——两个都读，因为协议没有版本协商。
 * 曾经把「content 是数组」当成失败——那是把「有结果」读成了「有错误」，
 * 每一行工具都会红（本文件的回归断言就是为了钉住这一点）。
 */
function resultIsError(message: MessageLike | undefined, error: unknown): boolean {
  if (error) return true;
  if (message?.isError === true) return true;
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      (block as { type?: string; isError?: boolean } | undefined)?.type === "tool-result" &&
      (block as { isError?: boolean }).isError === true,
  );
}

/** 失败结果的错误码（官方 `summarizeResult` 的失败分支：`node.error?.code ?? 'error'`）。 */
function resultErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code ? code : "error";
}

/**
 * 官方 `summarizeResult()`：工具结果那一栏显示什么。
 *
 * 四条分支逐字对应官方（`layout.ts`）：
 * - 失败 → `result` 存**错误码**；
 * - 有文本块 → `resultPreviewMarkdown` 存**原文**（不是截好的摘要！截断在界面侧，
 *   官方列表显示的是它的预览）；
 * - 只有图片 → 语义「图片 ×N」（文案在界面侧取，宿主不知道语言）；
 * - 什么都没有 → 语义「无输出」。
 */
function resultSummaryOf(
  content: unknown,
  error: unknown,
  isError: boolean,
): Pick<TrajectoryCell, "result" | "resultPreviewMarkdown" | "resultSummary"> {
  if (isError) return { result: resultErrorCode(error) };
  const text = resultText(content);
  if (text) return { resultPreviewMarkdown: text };
  const images = blockCount(content, "image");
  if (images > 0) return { resultSummary: { kind: "images", count: images } };
  return { resultSummary: { kind: "no-output" } };
}

/** 附件计数摘要（官方 `imageBlockCount` / `fileBlockCount` 的本地化拼接，宿主只给计数）。 */
function attachmentSummary(content: unknown): { images: number; files: number } | undefined {
  const images = blockCount(content, "image");
  const files = blockCount(content, "file");
  return images > 0 || files > 0 ? { images, files } : undefined;
}

/**
 * 工具目录变更（官方 `inputCellDetail()` 的 `tool-addition` / `tool-removal` 分支）。
 *
 * 线格式（438 份真实日志里 52 份有 `tool-addition`、13 份有 `tool-removal`，形状逐字）：
 *
 * ```json
 * {"type":"developer/message","data":{"turn":1,"step":33,"message":{
 *   "source":{"kind":"tool-registry"},
 *   "content":[{"type":"tool-addition","toolName":"list_mcp_resources"}, …]}}}
 * ```
 *
 * 判据与官方一致：内容块**全部**是这两类之一（且非空）才算目录变更，否则这条
 * `developer/message` 不是我们认识的形状、整条不出行。
 *
 * @param content - 消息的内容块数组。
 * @returns 新增/移除的工具名与原始块；不是目录变更时 `undefined`。
 */
function toolCatalogUpdate(
  content: unknown,
): { added: string[]; removed: string[]; blocks: TrajectorySourceBlock[] } | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const blocks: { type: string; name: string }[] = [];
  for (const entry of content) {
    const block = entry as { type?: unknown; toolName?: unknown } | undefined;
    const type = typeof block?.type === "string" ? block.type : "";
    if (type !== "tool-addition" && type !== "tool-removal") return undefined;
    blocks.push({ type, name: typeof block?.toolName === "string" ? block.toolName : "" });
  }
  return {
    added: blocks.filter((block) => block.type === "tool-addition").map((block) => block.name),
    removed: blocks.filter((block) => block.type === "tool-removal").map((block) => block.name),
    blocks: blocks.map((block) => ({ type: block.type, content: block.name })),
  };
}

/**
 * 官方 `resultAsText()`：**没有调用只有结果**的行，正文直接取自结果本身
 * （`text` 与 `previewMarkdown` 都是它），而不是「tool」这种占位名。
 */
function resultAsText(
  summary: Pick<TrajectoryCell, "result" | "resultPreviewMarkdown" | "resultSummary">,
): Pick<TrajectoryCell, "text" | "previewMarkdown"> {
  if (summary.resultPreviewMarkdown !== undefined) {
    return { text: summary.resultPreviewMarkdown, previewMarkdown: summary.resultPreviewMarkdown };
  }
  return { text: summary.result ?? "" };
}

/**
 * 来源插件名（**两种形态**）。
 *
 * 0.1.7-alpha.1 起消息来源是生产者自有的 kind，内置生产者没有 `plugin` 字段，第三方
 * 插件落成 `plugin:<包名>`（`rewritePluginSource` 的回退形态）——两处都给得出名字，
 * 轨迹行右侧那一栏才不会退化成裸 kind。
 */
function sourcePluginName(source: { kind?: unknown; plugin?: unknown } | undefined): string | undefined {
  if (typeof source?.plugin === "string" && source.plugin) return source.plugin;
  const kind = typeof source?.kind === "string" ? source.kind : "";
  return kind.startsWith("plugin:") ? kind.slice("plugin:".length) : undefined;
}

/** 线格式 usage（`TokenUsage`）→ 视图用量。只认线格式字段名。 */
function trajectoryUsage(usage: unknown): TrajectoryUsage | undefined {
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

/**
 * 记录级用量（推理桶叫 `think`）→ 请求级用量（推理桶叫 `reasoning`）。
 *
 * **缺席的桶要真空缺**（不是 `undefined` 值）：官方 `UsageRows` 按
 * `usage.cacheRead !== undefined` 决定画不画那一行，留一个 `undefined` 的键
 * 在 JSON 化之后会被整条丢掉、在对象比较里又是一处差异。
 */
function requestUsage(usage: TrajectoryUsage | undefined): TrajectoryRequestUsage | undefined {
  if (usage === undefined) return undefined;
  const view: TrajectoryRequestUsage = {
    ...(usage.input === undefined ? {} : { input: usage.input }),
    ...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
    ...(usage.output === undefined ? {} : { output: usage.output }),
    ...(usage.think === undefined ? {} : { reasoning: usage.think }),
  };
  return Object.keys(view).length > 0 ? view : undefined;
}

/**
 * 两个请求级用量相加（官方 `addUsage()` 逐字：桶只在**两边都缺席**时才缺席，
 * 否则按 0 累加）。
 */
function addRequestUsage(
  current: TrajectoryRequestUsage | undefined,
  next: TrajectoryRequestUsage,
): TrajectoryRequestUsage {
  const sum = (key: keyof TrajectoryRequestUsage): number | undefined =>
    current?.[key] === undefined && next[key] === undefined
      ? undefined
      : (current?.[key] ?? 0) + (next[key] ?? 0);
  const totals = {
    input: sum("input"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    output: sum("output"),
    reasoning: sum("reasoning"),
  };
  const view: TrajectoryRequestUsage = {
    ...(totals.input === undefined ? {} : { input: totals.input }),
    ...(totals.cacheRead === undefined ? {} : { cacheRead: totals.cacheRead }),
    ...(totals.cacheWrite === undefined ? {} : { cacheWrite: totals.cacheWrite }),
    ...(totals.output === undefined ? {} : { output: totals.output }),
    ...(totals.reasoning === undefined ? {} : { reasoning: totals.reasoning }),
  };
  return view;
}

/**
 * durable 的失败对象 → 可展示的 `{message, code}`（官方 `displayFailure()` 逐字）。
 *
 * `code === "AUTH"` 时**文案清空**：提供方的认证失败消息可能回显被掩码或部分保留
 * 的凭据，官方只在会话日志里留原始诊断，界面状态里一个字都不留。
 */
function displayFailure(failure: unknown): { message: string; code?: string } {
  if (failure === null || typeof failure !== "object") return { message: String(failure) };
  const record = failure as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (code === "AUTH") return { code, message: "" };
  return {
    ...(code === undefined ? {} : { code }),
    message: typeof record.message === "string" ? record.message : JSON.stringify(failure),
  };
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

/**
 * 调用时生效的工具 Schema → 详情面板与搜索索引用的一段文本（官方 `attachToolSchema()`）。
 *
 * 官方在装配层把 schema 挂到**调用格**上、`JSON.stringify(schema, null, 2)` 存成字符串，
 * 这里逐字照做（含缩进）：界面「Schema」页签直接显示原文，不再自己序列化一遍。
 *
 * 取的是**这次调用之前**最近一次 `request/header` 的目录；目录里没有这个名字就**不给**
 * （官方 `captureSchemas()` 同样是 `schema !== undefined` 才写）——拿不到证据就不臆造。
 *
 * @param toolName - 这次调用的工具名。
 * @param toolsByName - 当前生效目录按名字建的索引。
 * @param intern - 「同一份 schema 只序列化一次」的缓存，见 `deriveTrajectoryModel` 里那个 Map。
 * @returns 序列化后的 schema，取不到就是 `undefined`。
 */
function schemaDetailOf(
  toolName: string,
  toolsByName: ReadonlyMap<string, TrajectoryToolSchema>,
  intern: Map<TrajectoryToolSchema, string>,
): string | undefined {
  const schema = toolsByName.get(toolName);
  if (schema === undefined) return undefined;
  const cached = intern.get(schema);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(schema, null, 2);
  intern.set(schema, text);
  return text;
}

/**
 * 原始内容块 → 官方 `TrajectorySourceBlock`（`layout.ts` 的 `sourceBlock()` 同口径）。
 *
 * 官方只认三样：`type`（缺省 `"unknown"`，`reasoning` 改写成 `thinking`）、`text` 原文、
 * 以及 `image` / `file` 块带上的 `attachment`（**必须有 `attachmentId`** 才算，见官方那段
 * 注释：会话日志里的内容会被核心校验成 `ContentBlock`，这个守卫只是挡住线上形状里
 * 恰好有个无关 `attachment` 成员的 `other` 块）。**其余字段一律序列化进 `content`**
 * ——工具调用块的 `name` / `arguments` 就是这样进搜索索引的（`stringifySourceValue`
 * 与官方逐字同规则）。
 *
 * `callId` / `toolName` 是**额外挂上去的**（官方在 `layout.ts` 的 `assistantSourceBlock()`
 * 里对 `tool-call` 块这么做），界面侧检查器的「原始内容」页签靠它把那一节渲染成跳转按钮
 * 并显示工具名。**`content` 仍留整块 JSON 原文**：搜索索引逐字段取
 * （`trajectory-search-index.ts` 的 `recordSources()` 吃 `content`），从 `content` 里摘掉
 * 这两个键就是**丢搜索面**。实测 58776/58776 个调用块三样齐全（`id` / `name` / `arguments`），
 * 缺席时那两个键整个不写（`undefined` 过 JSON 会被丢掉，写上去只多一层噪声）。
 */
function sourceBlocksOf(content: unknown): TrajectorySourceBlock[] | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const blocks: TrajectorySourceBlock[] = [];
  for (const entry of content) {
    if (entry === null || typeof entry !== "object") {
      blocks.push({ type: "unknown", content: stringifySourceValue(entry) });
      continue;
    }
    const block = entry as {
      type?: unknown;
      text?: unknown;
      attachment?: unknown;
      id?: unknown;
      callId?: unknown;
      name?: unknown;
    };
    const type = typeof block.type === "string" ? block.type : "unknown";
    if (typeof block.text === "string") {
      blocks.push({ type: type === "reasoning" ? "thinking" : type, content: block.text });
      continue;
    }
    const attachment = block.attachment;
    if (
      (type === "image" || type === "file")
      && attachment !== null && typeof attachment === "object"
      && typeof (attachment as { attachmentId?: unknown }).attachmentId === "string"
    ) {
      blocks.push({
        type,
        content: stringifySourceValue(entry),
        ...(type === "image"
          ? { attachment: attachment as TrajectoryAttachmentRef }
          : { file: attachment as TrajectoryAttachmentRef }),
      });
      continue;
    }
    /**
     * 工具调用块：官方的加载层把 `callId` / `toolName` 提到块上（`assistantSourceBlock()`），
     * 检查器「原始内容」页签据此渲染跳转按钮与显示工具名。**`content` 里那两个键照旧留着**
     * ——从 `content` 摘掉就是丢搜索面（`trajectory-search-index.ts` 逐字段取）。
     *
     * 字段名与 `callIdsOf()` 同一个来源：线上是 `id`（契约
     * `@deepseek-ai/dsh-llm` 的 `ToolCallBlock`），`callId` 是老夹具里的名字，两个都读、
     * `id` 优先。
     */
    const rawId = block.id ?? block.callId;
    const callId = typeof rawId === "string" && rawId !== "" ? rawId : undefined;
    const toolName = typeof block.name === "string" && block.name !== "" ? block.name : undefined;
    blocks.push({
      type,
      content: stringifySourceValue(entry),
      ...(callId === undefined ? {} : { callId }),
      ...(toolName === undefined ? {} : { toolName }),
    });
  }
  return blocks.length ? blocks : undefined;
}

/** 官方 `stringifySourceValue()`：序列化不了就退回字符串形式，绝不给空串。 */
function stringifySourceValue(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json || String(value);
}

/**
 * 一份生效中的请求配置：`EpochHeader.config` 读出来的选项 + 提供方 / 模型。
 *
 * 官方那份是 `header.latest.prompt.config`（`applyHeader()` 把它**整份**挂到请求上）。
 * 本扩展没有节点层，就把同一份 config 折成这三样；`request/header` 每来一帧**整体替换**
 * 这份状态（官方 `previousHeader = data.header`），读不出配置的帧也照样替换成空配置。
 */
interface EffectiveHeaderConfig {
  provider?: string;
  model?: string;
  options: TrajectoryRequestOptions;
}

/** `EpochHeader.config` → 选项面板用的请求选项 + 提供方/模型。 */
function headerConfig(header: unknown): EffectiveHeaderConfig {
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
 * `turn/end` 的 reason → 失败事实（官方 `trajectoryTurnEndDefinition` 的口径）。
 *
 * 固定 rc.2 的 `TurnEndReason` 是**结构化联合**（`packages/core/session/src/types.ts` 的
 * `TurnEndReasonMap`）：`completed` / `aborted` / `blocked` / `error` / `max-tokens` /
 * `interrupted` / `forked`。官方那一支只认一种失败：
 *
 *     const failure = reason.kind === 'error' ? displayFailure(reason.error) : undefined
 *
 * 也就是「**只有 `kind === 'error'` 才算这一轮失败**」，`error` 是 `LlmFailure` 原文、
 * 要过 `displayFailure()`（`AUTH` 码下清空文案）；其余各 kind 都不是失败——`max-tokens`
 * 是「回答被输出上限截断」（官方折成单独的 `TurnMaxTokens` 节点），`aborted` / `blocked` /
 * `interrupted` / `forked` 也不是模型失败。
 *
 * 从前这一支只读 string，于是真实的结构化错误**整类被忽略**（`reason` 是对象 →
 * `typeof reason !== "string"` → 直接 undefined）：轮次失败在账本与请求表里都看不见。
 * 会话流那一侧一直按结构化读（`adapter.ts` 的 `turn/end` 分支读 `reason.kind` 与
 * `reason.error.message`），这里是账本侧的漏读。
 *
 * 容错：也认**字符串** reason（既有容错口径与手写夹具的回退），口径与从前一致。
 * 这一支只是回退，**不声称对应某个官方版本或某个历史信封**。
 */
function turnEndFailure(reason: unknown): { message: string; code?: string } | undefined {
  if (typeof reason === "string") {
    if (reason === "success" || reason === "completed" || reason === "end" || reason === "max-tokens") {
      return undefined;
    }
    return { message: reason };
  }
  if (reason === null || typeof reason !== "object") return undefined;
  const record = reason as { kind?: unknown; error?: unknown };
  if (record.kind !== "error") return undefined;
  // `error` 在契约里必填；真出现缺失也照样算失败证据（状态判 error），只是没有文案。
  if (record.error === undefined || record.error === null) return { message: "" };
  return displayFailure(record.error);
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
  /**
   * 已经开过 `step/start` 的步骤（key = `turn:step`）。
   *
   * 与 `settledSteps` 一减，剩下的就是**还在跑**的步骤——官方把它画成一行
   * 「流式中的助手」（`PartialAssistant` + `requestOnly`），本扩展不映射流式叠加层，
   * 只出一行「正在生成」的占位（`status: "running"`、正文留空）。
   */
  const startedSteps = new Map<string, { turn: number | null; step: number | null; time: number; seq: number; requestNumber: number }>();
  const settledSteps = new Set<string>();
  /** 最后一次 `turn/end` 的 seq：只有它**之后**开的步骤才算「还在跑」。 */
  let lastTurnEndSeq = -1;
  /**
   * 请求表（官方 `RequestView[]` 的等价物，见文件头）。
   *
   * 与账本行的关系只是 `requestNumber` 一个号：行上不放请求级事实，免得两处漂移。
   *
   * **助手请求与压缩请求是两件独立的事实**（官方也是两套 definition 状态机：助手那套的
   * definition id 就是 `turn\u0000step`，压缩那套按压缩自己的身份走）。用一个「当前请求」
   * 变量代表两种请求时，overflow 恢复时序会把助手那次顶掉——`compaction/start` 插在
   * `step/start` 与**同一步**的 `assistant/message` 之间，而恢复没有新的 `step/start`
   * （官方 overflow hook 的 `agent/request-error` 分支返回同一步重试），于是后续结算
   * 全落到压缩请求上：助手请求永远 `running`，`completedAt` / 用量 / 选项 / 计时开始全丢。
   * 所以两种请求各按**稳定身份**记：助手请求按 `turn:step` 存进 `assistantRequests`，
   * 压缩请求自己一份。**不用「最后开的那次请求」兜底**——那个值在 overflow 时序里
   * 正是压缩请求，就是本缺陷的根因。
   */
  const requests: TrajectoryRequest[] = [];
  /** `turn:step` → 那一步的助手请求（`step/start` 开；同一个 step 重复开就取最新一次）。 */
  const assistantRequests = new Map<string, TrajectoryRequest>();
  /**
   * 最近一次开的助手请求。
   *
   * **只有帧自己没带 `turn`/`step`**（畸形帧；官方契约里这两个字段必带）时才拿它兜底：
   * 官方对 `assistant/message` / `assistant/attempt` / `llm/retry` 一律按**帧自己的**
   * `turn:step` 找那一步的节点，窗口里没有该步 `step/start` 时 `assistantRequest()` 的
   * `if (!state.started) return undefined` 就是说那一步没有请求——查不到就不写。
   * 它**不是**「最近开的请求」：压缩那份在 `lastCompactionRequest` 里，取错就会把助手
   * 结算落到压缩请求上。
   */
  let lastAssistantRequest: TrajectoryRequest | undefined;
  /** 最近一次开的压缩请求：`compaction/summary` / `compaction/end` 只挂它。 */
  let lastCompactionRequest: TrajectoryRequest | undefined;
  /**
   * 每轮收尾的事实（官方 `turn-end` contributions → `applyTurnErrors`）：**逐条累积**，
   * 不是「每轮一条」。官方每条 `turn/end` 的 contribution id 是 `String(event.seq)`，
   * 同一轮来两条就是**两条独立贡献**，`snapshot()` 把它们全部收进 `turnEndings`，
   * `applyTurnErrors()` 再逐条处理——所以一条失败收尾后面跟一条成功收尾时，失败证据留下
   * （官方那条成功收尾 `ending.error === undefined`，`continue` 跳过，既不新增诊断、
   * 也不撤销先前那条失败留下的诊断）。
   *
   * 每轮一份记录的写入口径：
   * - `time`：该轮**最后一条** `turn/end` 的时刻（边界时刻，后处理补 `completedAt` 用它）；
   * - 失败收尾（`turnEndFailure()` 给出失败事实时）：`failed = true`，`error` 整份换成这一条
   *   那一份（空文案规范化为**缺席**，不写空串），`errorCode` 有值才换、缺席时**保留**此前那一个；
   * - 非失败收尾（`completed` / `aborted` / `max-tokens` / `interrupted` / `forked`…）：
   *   `failed` / `error` / `errorCode` 一个字都不改，只更新 `time`。
   *
   * `failed` 是**肯定证据**，与「有没有文案」分开记：`AUTH` 码下 `displayFailure()` 把文案清成
   * 空串，若拿「文案非空」或「错误码存在」反推，就会漏掉「这一轮确实失败了」这件事——
   * 于是终态诊断覆盖不掉前一份（`llm/retry` 留下的那份）。空文案在写进公开模型时规范化为
   * **缺席**（`error` 字段不出现），不写空串。
   *
   * 它是**后处理**的输入：助手请求的最终状态要看「轮次关闭了吗、这一轮失败了吗」
   * （官方在 `assistantRequest()` 的边界分支与 `applyTurnErrors()` 里各用一次）；
   * 后处理那一段读到的 `ending` 就是这个累积结果。
   */
  const turnEndings = new Map<number, { time: number; failed: boolean; error?: string; errorCode?: string }>();
  /** 系统提示词：当前生效的正文与上一次的正文（差异页签要两者）。 */
  let systemText = "";
  let systemCellWritten = false;
  let lastHeaderSeq: number | null = null;
  let previousSystemText = "";
  /**
   * 最近一次生效的请求配置（官方 `TrajectorySnapshotBuilder` 的 `previousHeader`）。
   *
   * 官方 `headerFor()` 的**第二条分支**：这一步自己没有 header 时，取这个请求开始之前
   * 最后一次生效的 `request-header`（`previous.seq < request.startSeq`），由
   * `applyHeader()` 把它的 `config` 整份挂上去。这一步在真实会话里是常态——配置没变时
   * 服务端不会再发 header，少了这份继承，第二步之后的请求就没有选项：检查器的「选项」
   * 页签整个消失（`hasOptions = request.options !== undefined`），而 `reasoningEffort` /
   * `maxTokens` 这些字段**补不回来**（结算帧只带 provider / model）。
   *
   * `undefined` = 窗口里还没有可用的 header；读不出配置的那一帧同样**整体替换**成空配置
   * （官方 `applyHeader()` 是整份 `requestConfig` 覆盖，不是逐字段合并）——上一份已经
   * 失效的字段不许残留。
   */
  let effectiveHeader: EffectiveHeaderConfig | undefined;
  /** 上一次生效的工具目录（官方逐字比 JSON：没变就不出「工具已更新」那一行）。 */
  let previousTools: TrajectoryToolSchema[] | undefined;
  /**
   * 当前生效目录按工具名建的索引（官方 `indexTools()`），供**调用时**取 schema。
   *
   * 官方 `captureSchemas()` 的判据是「这次调用之前最近一次 `request/header` 的目录」，
   * 所以每次 `request/header` 都整体重建——用它而不是回查目录行，目录变更后不会给错那份。
   */
  let toolsByName = new Map<string, TrajectoryToolSchema>();
  /**
   * 同一份 schema 只序列化一次的缓存（`TrajectoryToolSchema` 对象身份为键）。
   *
   * 官方也是每条调用都挂一份**同样内容**的字符串（`callSchemas` 是 Map，格子逐个引用）。
   * 实测一个会话里同一份 schema 平均被挂 16.6 遍（985 条工具行只对应 12 份不同 schema），
   * 所以这里复用同一个字符串对象：**线上载荷仍是逐格一份**（保持与官方同形状、搜索索引
   * 才能逐格取到），省下的是宿主里 95.7% 的重复分配与 GC 压力。
   */
  const schemaIntern = new Map<TrajectoryToolSchema, string>();
  /**
   * **初始**系统提示词那一行单独存着，最后 unshift 到最前面。
   *
   * 官方 `layoutEntryOrder` 把 `kind==='system' && change.kind==='initial'` 强制成
   * `-Infinity`：初始提示词永远排在账本第一行。而它在事件流里的位置其实**晚于**
   * 第一条 `user/message`（顺序是 turn/start → step/start → system/message →
   * user/message → request/header），照事件顺序摆会排到用户消息后面——那不是官方
   * 的样子，也不符合「先看提示词再看对话」的读法。
   *
   * **它的归轮不在这里定**：官方那一行走 `firstVisibleTurn()`（最早的「大于 0 的助手
   * 轮次」，一个都没有就是默认轮 1），那要等整窗事件都折完才成立，所以这里先按到达
   * 时的 `currentTurn` 暂存，最后补行时再统一改写 `turn`（见下面那个同名局部函数）。
   */
  let initialSystemCell: Omit<TrajectoryCell, "index"> | undefined;
  /**
   * inbox 队列状态机（官方 `trajectory-inbox-next-step` 的 `InboxState`，逐字 vendor 在
   * `src/vendor/ui-trajectory/inbox-state.ts`）。
   *
   * 它只为一件事存在：把「生成过程中插进队列、在下一次 step 边界被领取」的
   * `user/message` 认成 steering。官方在节点层给它 `kind: 'steering'`，在布局层
   * 又渲染成 `kind: 'user'`（同样走 `inputCellDetail`），差别只有**不置 `opensTurn`**。
   *
   * 聊天侧用**同一台状态机**决定这条消息落在轮中间还是轮顶部（`dsh/inboxClaim.ts`）。
   */
  let inboxState: InboxState | undefined;
  /**
   * 「事件落点」的当前步骤（官方 `ConversationLocationIndex` 的口径）。
   *
   * 与 `currentStep` 只差**一条**：`step/end` 收尾时落点步骤立刻消失，而 `currentStep`
   * 要留到下一个 `step/start`（助手行、重试、请求表都靠它）。官方那条时间线的规则是
   * 「`turn/start` 清、`step/start` 置、`step/end` 在**被收尾的那一步**上清、
   * `turn/end` 全清」，`user/message` 自己不带 `turn`/`step`，所以它拿到的是**事件流
   * 当时**的落点。
   *
   * 两处用到它：① steering 的落组（`steeringPlacement()` 的第一条判据）；
   * ② `request/header` 的归属（官方 `headerStepKey()` 同口径——落点是**轮**时那份
   * header 不属于任何一步，只做「最近生效的配置」给后续请求继承）。
   */
  let locationStep: number | null = null;
  /**
   * steering 记录「当时拿到的落点」（收尾后统一落组）。
   *
   * **键是事件的 `seq`，不是 `cell.index`**：初始系统提示词那一行会在最后
   * `unshift` 到账本最前面并给全表重编号（见下面的 `front`），按显示序号关联会
   * 整体错位一格——查出来的是**后一条** steering 的落点（或查不到），落组就错了。
   * `seq` 是事件自己的稳定身份（官方也是拿 `eventLocations.get(node.seq)` 查落点）。
   */
  const steeringLocated = new Map<number, { turn: number | null; step: number | null }>();

  const push = (cell: Omit<TrajectoryCell, "index">): TrajectoryCell => {
    const full: TrajectoryCell = { ...cell, index: cells.length + 1 };
    cells.push(full);
    return full;
  };

  /**
   * 步骤的稳定身份：`turn:step`（与官方 `trajectory-assistant-step` 的 definition id
   * 同形——官方就是拿它把 `assistant/live-chunk` / `assistant/message` / `llm/retry` /
   * `step/end` 归到同一次助手请求上）。取不到的值写成 `?`，与重试进度那张表同一套键。
   */
  const stepKey = (turn: number | null, step: number | null): string => `${turn ?? "?"}:${step ?? "?"}`;

  /**
   * 官方的「在跑的流式助手」状态（`AssistantState` 里与**布局**有关的那几项）。
   *
   * 本扩展不发布流式正文（刻意差异 1），但布局要用到它的**身份**：官方那个身份进
   * `TrajectorySnapshot.partial`（`buildViewNode()` 的条件是
   * `node === undefined && boundary === undefined && state.sawChunk`），而布局有两处读它：
   * 初始提示词行的 `firstVisibleTurn(nodes, partial)` 把 `partial.turn > 0` 并进候选，
   * 系统**更新**行的 `enclosingPromptTurn(nodes, seq, partial)` 在没有随后助手节点时回落到
   * `partial?.turn ?? 1`。拿窗口当前的 `currentTurn` 顶替会在「窗口截断 / 整轮收尾之后再改
   * 提示词 / 流还没结算」这些时序上给出另一个答案。
   *
   * 键与 `assistantRequests` / `retries` 同一套 `turn:step`（官方的 definition id 就是它）。
   */
  /**
   * 一个流式块的**充分证据**——官方 `hasInterruptionEvidence()` 判合成中断节点时需要的
   * 全部信息（`state.blocks` 本体在这里不做别的用）。
   *
   * 官方 `state.blocks` 存块的正文 / 思考全量，而本扩展只在**布局**这一处消费它：
   * `finalNode()` 的合成分支要求 `hasInterruptionEvidence(blocks)`——正文 / 思考
   * `trim()` 后非空，其余种类（工具调用 / 图片 / 未知块）**一律算证据**，连空 `name` /
   * 空 `argsRaw` 的工具调用块都算。正文本就不发布（刻意差异 1），所以只留判据需要的
   * 两件事：
   *
   * - `text` / `reasoning`：有没有**非空白字符**。任意一个非空白字符在 `trim()` 之后都会
   *   留下，所以逐帧累积一个布尔值就够——**不复制流内容**（每个块槽位只占一个小对象，
   *   占用与流长度无关）；
   * - 其它种类一律记成 `other`（`tool-call` / `image` / `block-start` 的未知 `blockType`）。
   */
  type BlockEvidence =
    | { readonly kind: "text" | "reasoning"; readonly nonWhitespace: boolean }
    | { readonly kind: "other" };

  interface AssistantStreamState {
    turn: number | null;
    step: number | null;
    /**
     * 这个身份**第一次**出现的 `seq`。
     *
     * 官方快照层只留最后一个非空的 `partial`（`if (data.partial !== null) partial = data.partial`），
     * 而 contributions 按 `anchorSeq` 升序迭代——`anchorSeq` 就是这个身份第一次出现的
     * `seq`（`fallbackState()` 里 `initialState(event.data.turn, event.data.step, event.seq, …)`）。
     * 所以「最后一个」按这个值比，不按 Map 的插入顺序。
     */
    firstSeq: number;
    /**
     * 窗口里见过这一步的 `step/start`——官方装配器里 `context.state !== undefined` 的判据
     * （`assembler.ts`：`const starting = role === 'start' && context.start === undefined`，
     * 之后的帧才走 `else if (context.state !== undefined) definition.update(…)`）。
     *
     * 这一条把**官方本来就不一样的两种路径**分开：窗口里开过 `step/start` 的身份才有
     * 状态机（`llm/retry` 走 `initialState()` 整份重置）；没有 `step/start` 的孤儿身份
     * 由 `fallbackState()` 按它自己的帧重放，而那一路**没有 retry 分支**。
     */
    started: boolean;
    /** 见过任何 `assistant/live-chunk`（`usage` / `finish` / 未知 `type` 同样置位）。 */
    sawChunk: boolean;
    /**
     * 当前 `final`（最新一次 `assistant/message`）的事件号；`undefined` = 没有当前节点。
     *
     * 官方 `state.final` 既是 `settleMessage()` 的落点、也是 `buildViewNode()` 里
     * `node` 的来源：`final` 在 → 不发 `partial`、`assistantRequest()` 能给 `complete`；
     * `initialState()` 重置（`step/start` / `llm/retry`）把它清掉。多个 `assistant/message`
     * 落同一个身份时**后到者胜**（官方 `final: match` 整份替换，一个 definition id
     * 只有一个 Context）。
     */
    finalSeq: number | undefined;
    /**
     * 这个身份**当前**的块槽位（官方 `state.blocks`，按 `chunk.index` 覆盖）。
     *
     * 只服务合成中断节点的证据判据（见 `BlockEvidence`）：`llm/retry` 的整份重置与首个
     * `step/start` 会把它清空（官方 `initialState()` 的 `blocks: []`），`assistant/message`
     * 结算时也清（有 `final` 时节点走第一条支，块证据用不上，见那一支的注释）。
     */
    blocks: Map<number, BlockEvidence>;
  }
  const streamStates = new Map<string, AssistantStreamState>();

  /** 取 / 建某个身份的流状态（已存在时保留它的 `firstSeq` 与 Map 位置）。 */
  const streamStateOf = (turn: number | null, step: number | null, seq: number): AssistantStreamState => {
    const key = stepKey(turn, step);
    const existing = streamStates.get(key);
    if (existing !== undefined) return existing;
    const created: AssistantStreamState = {
      turn,
      step,
      firstSeq: seq,
      started: false,
      sawChunk: false,
      finalSeq: undefined,
      blocks: new Map(),
    };
    streamStates.set(key, created);
    return created;
  };

  /**
   * 读一个合法的块槽位下标（官方按 `chunk.index` 定位槽位）。
   *
   * 畸形帧（不是非负安全整数）返回 `undefined`——**适配边界**：官方那台状态机读到的是
   * 不存在的字段（甚至写进数组的怪键），不拿畸形事件替合法等价。
   */
  const chunkIndex = (chunk: Record<string, unknown>): number | undefined => {
    const index = chunk.index;
    return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : undefined;
  };

  /**
   * 官方 `updateChunk()` 里与**证据**有关的那部分（逐槽位语义逐字对齐：`block-start`
   * 覆盖成空块、`text-delta` / `reasoning-delta` 同类追加 / 异类替换、`tool-call-delta`
   * 覆盖成工具调用块、`block-end` 整份替换成最终块；`usage` / `finish` / 未知 `type`
   * 落 `default`，**不动块**，只由调用方置 `sawChunk`）。
   *
   * **肯定证据的类型守卫**：要读的字段形状不对（下标非法、增量不是字符串、`block-end` 的
   * `block` 不是对象 / 没有字符串 `type`、`block-start` 没有字符串 `blockType`）时**不动槽位**
   * ——非法帧不许变成可见证据。合法但内容为空的块（空文本、空 `name` / 空 `argsRaw` 的
   * 工具调用）与官方同判：前者不算证据，后者算。
   */
  const applyChunkEvidence = (blocks: Map<number, BlockEvidence>, chunk: Record<string, unknown>): void => {
    const type = chunk.type;
    if (type === "block-start") {
      const index = chunkIndex(chunk);
      if (index === undefined) return;
      const blockType = chunk.blockType;
      if (typeof blockType !== "string") return;
      /**
       * 官方 `emptyAssistantBlock()`：`text` / `reasoning` 是空文本块（`trim()` 后为空 →
       * 不算证据）；**其余**（`tool-call` 与 default 支的未知种类，含 `image`）都落进
       * 「非文本块」→ `hasInterruptionEvidence()` 直接算证据。
       */
      blocks.set(
        index,
        blockType === "text" || blockType === "reasoning"
          ? { kind: blockType, nonWhitespace: false }
          : { kind: "other" },
      );
      return;
    }
    if (type === "text-delta" || type === "reasoning-delta") {
      const index = chunkIndex(chunk);
      if (index === undefined) return;
      const text = chunk.text;
      if (typeof text !== "string") return;
      const kind = type === "text-delta" ? "text" : "reasoning";
      const previous = blocks.get(index);
      // 官方：同类块上追加、异类（或没有块）时从空串开始；`trim()` 后非空 ⇔ 出过非空白字符
      const carried = previous !== undefined && previous.kind === kind ? previous.nonWhitespace : false;
      blocks.set(index, { kind, nonWhitespace: carried || /\S/.test(text) });
      return;
    }
    if (type === "tool-call-delta") {
      const index = chunkIndex(chunk);
      if (index === undefined) return;
      // 官方把槽位覆盖成工具调用块；`hasInterruptionEvidence()` 对它**不看内容**，一律算证据
      blocks.set(index, { kind: "other" });
      return;
    }
    if (type === "block-end") {
      const index = chunkIndex(chunk);
      if (index === undefined) return;
      const block = chunk.block;
      if (typeof block !== "object" || block === null) return;
      const blockType = (block as { type?: unknown }).type;
      if (typeof blockType !== "string") return;
      if (blockType === "text" || blockType === "reasoning") {
        const text = (block as { text?: unknown }).text;
        blocks.set(index, { kind: blockType, nonWhitespace: typeof text === "string" && /\S/.test(text) });
      } else {
        // 官方 `toAssistantBlock()` 的 image / tool-call / default 三支都不是 text / reasoning
        blocks.set(index, { kind: "other" });
      }
    }
  };

  /** 官方 `hasInterruptionEvidence()`：任一槽位是文本 / 思考且有非空白字符，或任一非文本块。 */
  const hasInterruptionEvidence = (blocks: Map<number, BlockEvidence>): boolean => {
    for (const block of blocks.values()) {
      if (block.kind === "other" || block.nonWhitespace) return true;
    }
    return false;
  };

  /**
   * 步骤自己的 `step/end`（官方 `closedBoundary()` 的第一、二条来源：状态机的 `stepEnd`
   * 与位置索引里步骤已关闭——两者指向**同一个事件**），键与 `streamStates` 同套 `turn:step`。
   * 值取边界帧的 `seq`（合成节点的落点是它减 0.9，只要 `seq`）。后到者胜：官方位置索引里
   * 一个步骤的 `end` 也是被后一条 `step/end` 覆盖的。
   */
  const closedSteps = new Map<string, number>();
  /** 各轮的 `turn/end`（官方第三条来源：位置索引里轮次已关闭 → 边界取 `turn.end`）。 */
  const closedTurns = new Map<number, number>();

  /**
   * 这个身份的**闭合边界**（官方 `closedBoundary()` 的优先级逐条照搬：步骤自己的
   * `step/end` 优先，其次它所在轮次已经 `turn/end`）。返回边界帧的 `seq`。
   *
   * 两条来源都**不要求**此刻已有流状态：官方第一条读状态机的 `stepEnd`、第二 / 三条读
   * 位置索引（按窗口里的事件算），窗口里没有该身份的状态时官方 `buildViewNode()` 照样
   * 返回 `null`（`currentAssistantNodes()` 只遍历流状态，天然同判）。
   */
  const boundarySeqOf = (state: AssistantStreamState): number | undefined => {
    const byStep = closedSteps.get(stepKey(state.turn, state.step));
    if (byStep !== undefined) return byStep;
    return state.turn === null ? undefined : closedTurns.get(state.turn);
  };

  /**
   * 官方的**当前**助手节点表（`TrajectorySnapshot.eventNodes` 里 `kind === 'assistant'`
   * 的那些），供 `enclosingPromptTurn()` 与 `firstVisibleTurn()` 这两条官方布局分支使用。
   *
   * 每个身份的节点按官方 `finalNode()` 的两条支：
   * 1. **最终结算**：`state.final` 在（`assistant/message` 后到者胜）→ `seq` 就是它的 `seq`；
   * 2. **合成中断节点**：没有 `final`、`closedBoundary()` 成立、且 `hasInterruptionEvidence()`
   *    为真 → `seq = boundary.seq - 0.9`、`interrupted: true`。本扩展不出流式正文行
   *    （刻意差异 1），只取它对**布局**的贡献：归轮用的 `seq` 与轮次。
   *
   * **整窗折完之后按当前贡献导出，不增量维护**：官方快照每次装配都从当前状态重建——
   * `llm/retry` 的整份重置、`block-start` 覆盖掉已可见的证据之后，官方那一个节点当场消失。
   * 增量维护（见过证据就永久留一个节点）会给出官方已经不存在的候选，本批的 P8 就是反例。
   * 官方另有「还在跑」的 `partial`（`node === undefined && boundary === undefined && sawChunk`），
   * 那不是节点，另算。
   *
   * **一个身份只有一个节点**（官方一个 definition id 一个 Context、快照层每个 key 只留一份
   * 贡献）；本扩展账本侧「每次结算各出一行」是既定差异、只作展示，不参与归轮。
   *
   * 官方自己的用例（固定 `639ed015…` 的
   * `packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts`：
   * `live-chunk{text:'second attempt'}` + `step/end` → `eventNodes: [{ seq: 6.1,
   * interrupted: true, … }]`）说明「chunk 证据还在 + 已闭合边界」同时成立是合法可达的。
   */
  const currentAssistantNodes = (): { seq: number; turn: number; step: number }[] => {
    const nodes: { seq: number; turn: number; step: number }[] = [];
    for (const state of streamStates.values()) {
      if (state.turn === null) continue;
      const step = state.step ?? 0;
      if (state.finalSeq !== undefined) {
        nodes.push({ seq: state.finalSeq, turn: state.turn, step });
        continue;
      }
      const boundary = boundarySeqOf(state);
      if (boundary !== undefined && hasInterruptionEvidence(state.blocks)) {
        nodes.push({ seq: boundary - 0.9, turn: state.turn, step });
      }
    }
    return nodes;
  };

  /** 系统**更新**行：它们的轮次要等整窗折完才能定（官方 `enclosingPromptTurn()`）。 */
  const promptUpdateCells: TrajectoryCell[] = [];

  /**
   * 当前这一步（`turn:step`）的助手请求号：这一步产出的记录都挂它。
   *
   * 不能直接用「最后开的请求号」（`requestNumber`）——overflow 恢复时序里
   * `compaction/start` 会在同一步的 `assistant/message` 之前把号推到压缩请求上，
   * 于是助手行与它发起的工具行都会挂上压缩号（归属错了）。窗口里找不到这一步的
   * `step/start` 时退回「最后开的请求号」（老行为：截断窗口下不臆造身份）。
   */
  const currentStepRequestNumber = (): number | undefined => {
    if (currentStep !== null) {
      const request = assistantRequests.get(stepKey(currentTurn, currentStep));
      if (request !== undefined) return request.number;
    }
    return requestNumber > 0 ? requestNumber : undefined;
  };

  /**
   * 记下一次请求的用量。
   *
   * **只记事实、不在这里累加**：会话累计要按**请求号顺序**相加（官方 `requestNumbers`
   * 那条循环跑在按 `startSeq` 排序后的请求表上），而结算帧到达的顺序在 overflow
   * 恢复时序里与请求号顺序相反（压缩 #2 的 `compaction/summary` 早于助手 #1 的
   * `assistant/message`）。边折边加会把顺序倒过来，累计就挂错了请求。
   * 同一请求重复结算（重试后重发）取**最后一次**，与官方「重试前的用量丢掉」一致。
   */
  const settleUsage = (request: TrajectoryRequest, usage: TrajectoryUsage | undefined): void => {
    const view = requestUsage(usage);
    if (view === undefined) return;
    request.usage = view;
  };

  /** 把一次请求收尾（结算时刻、状态）。已经收尾过就不覆盖（重试后会有第二次）。 */
  const settleRequest = (request: TrajectoryRequest, time: number, error?: string): void => {
    request.completedAt = time;
    request.status = error === undefined ? "complete" : "error";
    if (error !== undefined) request.error = error;
  };

  /**
   * 每一次助手请求已经产出的账本行（对象身份为键，不进 JSON）。
   *
   * 只为「首 token 事后补」存在：`assistant/message` 可能先到而那一帧没有 token，
   * 随后 `assistant/attempt` 才给出首 token。官方一个 step 只有一份 state，本扩展
   * 会为同一步的每次结算各出一行，所以补的时候要把已经产出的行一起补上——
   * 否则界面读记录级的计时、请求面板读请求级那份，同一个量两个值。
   */
  const cellsByRequest = new Map<TrajectoryRequest, TrajectoryCell[]>();

  /**
   * 把后到的首 token 时刻同步到这一步**还没有值**的账本行上（先到者胜：
   * 已经有值的那份就是赢家，绝不覆写）。
   */
  const publishFirstToken = (request: TrajectoryRequest, time: number): void => {
    for (const cell of cellsByRequest.get(request) ?? []) {
      if (cell.assistantMetrics !== undefined && cell.assistantMetrics.firstTokenTime === null) {
        cell.assistantMetrics.firstTokenTime = time;
      }
    }
  };

  /**
   * **没有请求的步骤**（窗口从半截开始、没有它的 `step/start`）也要记住「先到者胜」的首 token。
   *
   * 官方一个 step 的状态由**该身份自己的任意一帧**建起来：窗口里没有 `step/start` 时
   * `fallbackState()` 照样按事件顺序重放 `assistant/attempt` / `assistant/message`，
   * 而 `settleTiming()` 是 `state.firstTokenTime ?? 新值`——所以 attempt 先到、message
   * 后到的窗口里，助手行的首 token 仍是 attempt 那个时刻；同一步重复结算的各行也读同一份。
   *
   * 本扩展的请求表只在 `step/start` 上建（`assistantRequests`），没有请求的步骤没有地方
   * 存这份记忆，从前 attempt 的时刻在那种窗口里会**静默丢掉**（行改用 message 自己那个
   * 更晚的时刻）。键一律是帧自己的身份 `turn:step`（绝不跨步、绝不落回别的请求），
   * 与 `assistantRequests` / `retries` 同一套键；`assistant/message` 的行从这里取。
   */
  const orphanFirstTokens = new Map<string, number>();

  /**
   * 没有请求的步骤已经产出的账本行（键同上）。
   *
   * 与 `cellsByRequest` 对称：晚到的 `assistant/attempt` 必须把首 token 回填到**已经产出**
   * 的孤儿行上，否则先结算那一行永远停在 null，而官方那份 state 只有一个首 token
   * （`fallbackState()` 按身份重放之后，`finalNode()` 读到的就是它）。
   */
  const orphanCells = new Map<string, TrajectoryCell[]>();

  /** 把后到的首 token 回填到该身份**还没有值**的孤儿行上（先到者胜，绝不覆写）。 */
  const publishOrphanFirstToken = (key: string, time: number): void => {
    for (const cell of orphanCells.get(key) ?? []) {
      if (cell.assistantMetrics !== undefined && cell.assistantMetrics.firstTokenTime === null) {
        cell.assistantMetrics.firstTokenTime = time;
      }
    }
  };

  /**
   * 已经由结算帧给出过**身份**的请求字段（官方那是请求自己的 `providerMetadata`）。
   *
   * `assistant/message` 的 `message.source.provider` / `.model` 是权威身份，`request/header`
   * 只给**配置**（官方 `applyHeader()` 只换 `prompt` / `requestConfig`，从不碰
   * `providerMetadata`）——所以某个字段一旦由结算帧给出过，后到的 header 配置不许覆盖它。
   *
   * **按字段记**（`message.source` 可能只带 `model` 不带 `provider`），键是请求对象身份。
   * 记账**不写进请求对象**：那张表要 JSON 序列化给界面，多一个内部字段就多一份线上载荷。
   */
  const settledIdentity = new Map<TrajectoryRequest, { provider?: true; model?: true }>();
  /** 记下结算帧给出的那个身份字段（`message.source` 的字段级证据）。 */
  const markSettledIdentity = (request: TrajectoryRequest, field: "provider" | "model"): void => {
    const settled = settledIdentity.get(request);
    if (settled === undefined) settledIdentity.set(request, { [field]: true });
    else settled[field] = true;
  };

  /**
   * 每个请求**最后一次实际生效**的 header 配置（含「窗口里没有可用 header」的 `undefined`）。
   *
   * 只为官方 `llm/retry` 的 state 重置服务：重置会连**身份**一起丢掉
   * （官方那时 `node` 为 undefined → `providerMetadata` 没有来源），而本扩展的
   * `provider` / `model` 有一条既定的兜底口径「还没有身份时用 header 的 config」
   * （见 `applyHeaderConfig`）。重置时要把**这一请求自己**那份配置重新挂上，
   * 不能借用窗口里最新的那份（那可能是下一步 / 下一轮的 header）。
   *
   * 记账**不写进请求对象**：那张表要 JSON 序列化给界面。
   */
  const appliedHeader = new Map<TrajectoryRequest, EffectiveHeaderConfig | undefined>();

  /**
   * 把一份请求配置**整份**挂到请求上（官方 `applyHeader()` 的
   * `requestConfig: header.latest.prompt.config`）。
   *
   * 口径是「配置替换」不是「逐字段残留合并」：`config === undefined`（窗口里还没有可用
   * header，或那一帧读不出配置）要把 options **清掉**——上一份已经失效的字段不许留在请求上。
   *
   * `provider` / `model` 是**另一类事实**：官方那是请求自己的身份 `providerMetadata`
   * （来自 `message.source`），与 `requestConfig` 分开。所以这里逐字段让路：已经被结算帧
   * 给出过的那一个字段不许被配置覆盖，还没有身份时配置照旧写进去——界面按
   * `request.provider ?? request.options?.provider` 读，缺了身份还要靠选项兜底显示。
   */
  const applyHeaderConfig = (request: TrajectoryRequest, config: EffectiveHeaderConfig | undefined): void => {
    appliedHeader.set(request, config);
    request.options = config !== undefined && Object.keys(config.options).length > 0 ? config.options : undefined;
    const settled = settledIdentity.get(request);
    if (settled?.provider !== true) request.provider = config?.provider;
    if (settled?.model !== true) request.model = config?.model;
  };

  /** 开一次请求并入表（`step/start` / `compaction/start`），按用途记成两种事实之一。 */
  const startRequest = (request: Omit<TrajectoryRequest, "number">): TrajectoryRequest => {
    const full: TrajectoryRequest = { ...request, number: requests.length + 1 };
    requests.push(full);
    if (full.purpose === "compaction") {
      lastCompactionRequest = full;
    } else {
      lastAssistantRequest = full;
      assistantRequests.set(stepKey(full.turn, full.step), full);
    }
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
        locationStep = null;
        break;
      }

      case "turn/end": {
        const turn = typeof data.turn === "number" ? data.turn : currentTurn;
        const failure = turnEndFailure(data.reason);
        if (turn !== null) {
          const previous = turnEndings.get(turn);
          // 边界时刻取**最后一条** `turn/end`（后处理补 `completedAt` 用它，与诊断是两条独立判据）
          const at = typeof time === "number" ? time : 0;
          if (failure === undefined) {
            /**
             * 非失败收尾（`completed` / `aborted` / `max-tokens` / `interrupted` / `forked`…）：
             * **成功收尾不得清除已积累的失败证据**——官方那条 contribution 的 `ending.error`
             * 是 `undefined`，`applyTurnErrors()` 直接跳过它。所以这里只更新边界时刻，
             * `failed` / `error` / `errorCode` 原样带过来。
             */
            turnEndings.set(turn, {
              time: at,
              failed: previous?.failed === true,
              ...(previous?.error === undefined ? {} : { error: previous.error }),
              ...(previous?.errorCode === undefined ? {} : { errorCode: previous.errorCode }),
            });
          } else {
            /**
             * 失败收尾：`failed` 置真，文案**整份换成这一条那一份**——空文案（`AUTH` 那类）
             * 规范化为**缺席**（键不写，不留空串），于是这一条照样把前一份文案顶掉，
             * 与官方 `error: ending.error` 的整份覆盖同形。错误码反过来：官方只在
             * `ending.errorCode !== undefined` 时才写，所以缺席时**保留**此前那一个。
             */
            turnEndings.set(turn, {
              time: at,
              failed: true,
              ...(failure.message !== "" ? { error: failure.message } : {}),
              ...(failure.code !== undefined
                ? { errorCode: failure.code }
                : previous?.errorCode === undefined ? {} : { errorCode: previous.errorCode }),
            });
          }
        }
        lastTurnEndSeq = event.seq;
        /**
         * 轮次关闭也是官方 `closedBoundary()` 的一条来源（位置索引里
         * `location.turn.status === 'closed'`，第三条分支）：这一轮里还在流的身份从此
         * **不发 `partial`**，而「有 chunk 证据但没结算」的身份由此得到**合成中断节点**的
         * 边界（`seq = turnEnd.seq - 0.9`）。帧没带 `turn` 的畸形帧沿用窗口当前轮
         * （与请求表同口径）。
         *
         * 按轮号记，不改成遍历此刻的流状态：官方第三条来源读的是位置索引，晚一点才建起
         * 状态的身份照样落在这一轮里；有没有状态由 `currentAssistantNodes()` 那一趟判。
         */
        {
          const closedTurn = turn ?? currentTurn;
          if (closedTurn !== null) closedTurns.set(closedTurn, event.seq);
        }
        locationStep = null;
        break;
      }

      case "step/start": {
        // 每个 step = 一次模型请求：请求编号在这里递增（见文件头的差异 4）
        requestNumber += 1;
        currentStep = typeof data.step === "number" ? data.step : null;
        locationStep = currentStep;
        if (typeof data.turn === "number") currentTurn = data.turn;
        startedSteps.set(stepKey(currentTurn, currentStep), {
          turn: currentTurn,
          step: currentStep,
          time,
          seq: event.seq,
          requestNumber,
        });
        /**
         * `step/start` 是官方那台状态机的 `start`：**重建**这个身份的 state
         * （`initialState()` → `sawChunk: false` / `final: undefined` / `blocks: []`）。
         * `firstSeq` 沿用已有条目的：官方 contributions 的先后按它第一次出现的位置算。
         *
         * `started: true` 是给 `llm/retry` 用的判据：官方装配器只在
         * `context.start !== undefined`（也就是窗口里见过 `step/start`）时才把后续帧交给
         * `update`，没有 start 的孤儿身份走 `fallbackState()`（那一路没有 retry 分支）。
         *
         * **只有第一个 `step/start` 才是 `start`**：装配器里
         * `const starting = role === 'start' && context.start === undefined`——同一个身份再来
         * 一条 `step/start` 时 `context.start` 已经有了，它走 `update`，而 assistant definition
         * 的 `update` 对 `match.event.type === 'step/start'` 落到最后那句 `return context.state`
         * （只有 `llm/retry` 才整份重置）。所以**重复 `step/start` 一个字都不改**：`final`、
         * `sawChunk`、`stepEnd`（→ 闭合边界与合成中断节点）、块证据全部原样保留。
         *
         * 从前这里无条件重建并把布局节点整条删掉，等于把重复 `step/start` 当成官方不存在的
         * 第二次开帧：已结算的当前节点消失、已闭合的中断贡献被撤销（本批 P9/P10/P11）。
         * 请求表那一份（`startRequest` / `startedSteps` 的开帧编号）仍按每次 `step/start`
         * 走——那是既定口径，本批不动它，也不宣称与官方请求表等价。
         */
        {
          const identity = stepKey(currentTurn, currentStep);
          const previousStream = streamStates.get(identity);
          if (previousStream?.started !== true) {
            streamStates.set(identity, {
              turn: currentTurn,
              step: currentStep,
              firstSeq: previousStream?.firstSeq ?? event.seq,
              started: true,
              sawChunk: false,
              finalSeq: undefined,
              blocks: new Map(),
            });
          }
        }
        const stepRequest = startRequest({
          purpose: "assistant",
          turn: currentTurn,
          step: currentStep ?? 0,
          seq: event.seq,
          // 官方 `initialState()` 的 `startTime` 就是 `step/start` 的事件时刻
          startedAt: typeof time === "number" ? time : null,
          completedAt: null,
          status: "running",
        });
        /**
         * 这一步还没收到自己的 header 时，先继承「最近生效的配置」（官方
         * `headerFor()` 的第二条分支：`previous.seq < request.startSeq`）。这一步随后
         * 收到 header 的话，由 `request/header` 那一支整份替换掉。
         */
        applyHeaderConfig(stepRequest, effectiveHeader);
        break;
      }

      case "step/end": {
        /**
         * 结算时刻与「还在跑」的判据都用它；助手行自己的 `completedTime` 另有来源。
         *
         * **不能按状态筛**：重试过的那一步在 `llm/retry` 时已经是 `error`（官方亦然），
         * 而它照样会被 `step/end` 关掉——按「状态是 running」筛会让失败请求永远
         * `completedAt === null`，计时面板把一次已经结束的请求画成「运行中」。
         * 只给**这一步的助手请求**收尾（按 `turn:step` 找，不是「最后开的请求」——
         * 那可能是这一步中途的压缩），不回溯更早的请求。
         */
        const stepRequest = currentStep === null
          ? undefined
          : assistantRequests.get(stepKey(currentTurn, currentStep));
        if (stepRequest !== undefined) {
          if (stepRequest.completedAt === null) {
            stepRequest.completedAt = typeof time === "number" ? time : null;
          }
          /**
           * 官方的**边界分支**（`assistantRequest()`）：步骤关闭时这一步还没有
           * 「非中断的最终助手节点」，`boundary` 本身就是失败证据 → `error`。
           *
           * 成功结算过的请求此刻已经是 `complete`、中断 / 重试过的是 `error`，
           * 都不会被这一支改判——它只收掉「什么结算都没等到」的那一种（从前会
           * 永远停在 `running`，计时面板把它画成一次还在跑的请求）。
           */
          if (stepRequest.status === "running") stepRequest.status = "error";
          /**
           * 边界成立 = 这一次请求**停下来了**：首 token 那一格随之定稿——没记到就写**显式
           * `null`**（与 `assistant/message` 那条路同口径，那里 `= streamToken` 本来就可能
           * 落下 null）。键缺席只留给「还在跑、宿主还没定稿」的请求：截断窗口里除
           * `step/start` 什么都没有的那一步就是这一种（官方请求面板那时也没有任何流证据）。
           */
          if (stepRequest.assistantFirstTokenTime === undefined) stepRequest.assistantFirstTokenTime = null;
        }
        // 落点步骤在这一步收尾时消失（官方 `ConversationLocationIndex`；
        // 只清**被收尾的那一步**，见 `locationStep` 的注释）
        if (
          typeof data.step === "number"
          && locationStep === data.step
          && (typeof data.turn !== "number" || data.turn === currentTurn)
        ) {
          locationStep = null;
        }
        /**
         * 官方 `update` 的 `step/end` 分支只记 `stepEnd`——它是 `closedBoundary()` 的
         * 第一条来源：这一步从此不发 `partial`（`buildViewNode()` 的 `boundary === undefined`
         * 不成立），并且**与块证据一起**构成合成中断节点（`finalNode()` 的 boundary 支，
         * `seq = stepEnd.seq - 0.9`）。
         *
         * 边界按事件记（后到者胜）、**不要求此刻已有流状态**：官方第二、三条来源读的是位置
         * 索引（只认窗口里有没有这条 `step/end`），与状态机是否建起来无关；没有状态的身份
         * 照样出不了节点——官方那时 `state === undefined`、`buildViewNode()` 返回 `null`，
         * `currentAssistantNodes()` 只遍历流状态，天然同判。
         */
        {
          const endTurn = typeof data.turn === "number" ? data.turn : currentTurn;
          const endStep = typeof data.step === "number" ? data.step : currentStep;
          if (endStep !== null) closedSteps.set(stepKey(endTurn, endStep), event.seq);
        }
        break;
      }

      case "llm/retry": {
        const attempt = typeof data.retry === "number" ? data.retry : undefined;
        const max = typeof data.maxRetries === "number" ? data.maxRetries : undefined;
        /**
         * 重试事实挂到**这一 step 的助手请求**上（官方 `trajectoryAssistantDefinition`
         * 的 `llm/retry` 分支，按 `turn:step` 归并）。失败文案过 `displayFailure()`
         * ——`AUTH` 码下清空。
         *
         * **帧带了身份而请求表里没有那一步时谁都不写**：官方 `fallbackState()` 里
         * `llm/retry` 连分支都没有（它只遍历 `assistant/live-chunk` / `assistant/attempt` /
         * `assistant/message` / `step/end`），窗口里没有该步 `step/start` 时这一帧落不到
         * 任何节点上；即便落上了，`assistantRequest()` 第一句 `if (!state.started) return
         * undefined` 也说明那一步没有请求。回落到「最后开的助手请求」会把越界帧的失败文案 /
         * 错误码 / 重试次数 / 延迟写到**另一个步骤**的请求上（与 `assistant/attempt` 同一口径）。
         * 只有帧自己没带 `step`（拿不到坐标的畸形帧）时才退回窗口当前步、再退最后一次助手请求。
         *
         * `mode !== 'normal'` 时官方**不记 `maxRetries`**（那个数只在普通重试策略下
         * 有意义），这里照抄。
         */
        const explicitIdentity = typeof data.step === "number";
        const retryTurn = typeof data.turn === "number" ? data.turn : currentTurn;
        const retryStep = explicitIdentity ? (data.step as number) : currentStep;
        const retryKey = retryStep === null ? undefined : stepKey(retryTurn, retryStep);
        const request = (retryKey === undefined ? undefined : assistantRequests.get(retryKey))
          ?? (explicitIdentity ? undefined : lastAssistantRequest);
        /**
         * **助手行上的重试徽章**（`cell.retry`）与请求级事实走**同一个身份**。
         *
         * 官方那台状态机的 definition id 是 `${data.turn}:${data.step}`（`match()` 逐帧取
         * 事件自己的坐标），重试只可能挂到**那一步**的节点上；那一步没有 `step/start` 时
         * `fallbackState()` 里根本没有这一帧的分支，重试事实落不到任何节点上。从前这里按
         * 窗口当前的 `currentTurn:currentStep` 记键，越界帧于是把**窗口当前步**那一行的徽章
         * 顶掉，而请求级那一份因为身份不同而不写——同一份事实在同一屏里自相矛盾。
         * 所以：帧自带坐标时只写它自己那一步、且那一步在窗口里开过 `step/start`
         * （官方的 `state.started`）的键；畸形帧（没带 `step`）沿用「窗口当前步」兜底键，
         * 与下面 `assistant/message` 读徽章时用的键同源。
         */
        if (attempt !== undefined) {
          const badgeKey = explicitIdentity
            ? (request === undefined ? undefined : retryKey)
            : stepKey(currentTurn, currentStep);
          if (badgeKey !== undefined) retries.set(badgeKey, { attempt, ...(max === undefined ? {} : { max }) });
        }
        if (request !== undefined) {
          const failure = displayFailure(data.failure);
          /**
           * 官方 `update` 的 `llm/retry` 分支是**整份重置**（`trajectory-assistant-definition.ts`，
           * 固定 `639ed015…`）：
           *
           *     return { ...initialState(state.turn, state.step, state.startSeq, state.startTime, true),
           *              firstTokenTime: state.firstTokenTime, usage: state.usage, retry: {…} }
           *
           * 也就是回到刚 `step/start` 的状态再挂这一条新 retry，只把**首 token 与用量**带过去。
           * 于是这一帧之后官方 `assistantRequest()` 看到的是：
           * - `state.final` 没了 → `node` 为 `undefined`：`completedAt = boundary?.time ?? null`
           *   （旧 final 的收尾时刻作废，等新 final 或步骤 / 轮次边界补）、
           *   `providerMetadata` 没有来源（身份随节点一起消失）；
           * - `state.retry !== undefined` → `error`；
           * - `error` / `errorCode` 就是**这一条**的：`AUTH` 空文案规范化为缺席、
           *   没有 `code` 就没有该键——都不保留上一条（从前是「有值才覆盖」，于是
           *   `AUTH` 或第二类无码失败会遗留上一条的诊断）。
           *
           * **不属于 state 重置**的是 `requestConfig`（官方快照层 `applyHeader()` 另挂，
           * `header.latest.prompt.config` 就是线格式 `request/header` 的 `header.config`）：
           * 本扩展对应 `options`，原样保留。`seq` / `startedAt`（官方的 startSeq / startTime）、
           * `assistantFirstTokenTime`、`usage` 同样由重置原样带过。
           */
          request.completedAt = null;
          request.error = failure.message !== "" ? failure.message : undefined;
          request.errorCode = failure.code;
          request.status = "error";
          // 重试事实整份替换（`maxRetries` 只在 `mode === 'normal'` 时有意义，官方同款）
          request.retry = attempt === undefined
            ? undefined
            : { attempt, ...(data.mode === "normal" && max !== undefined ? { max } : {}) };
          request.retryDelayMs = typeof data.delayMs === "number" ? data.delayMs : undefined;
          /**
           * 身份随 final 一起消失：清掉旧 final 写下的 `provider` / `model` 与「已由结算帧
           * 给出过」的标记，再把**这一请求自己**最后一次生效的 header 配置重新挂上——
           * `applyHeaderConfig` 的既定口径是「还没有身份时配置兜底」，重置之后正是那个状态；
           * 之后到达的 header 与新 final 也都能重新写身份（旧标记不再拦着它们）。
           */
          request.provider = undefined;
          request.model = undefined;
          settledIdentity.delete(request);
          applyHeaderConfig(request, appliedHeader.get(request));
        }
        /**
         * 同一次 `initialState()` 重置也把**流来源**清掉：`sawChunk` 与 `final` 一起复位，
         * 于是「重试之前流过的内容」不再是 `partial`（官方 `buildViewNode()` 的三条件之一），
         * 而重试之后新到的 chunk 又能重新武装这个身份。
         *
         * **只有窗口里开过 `step/start` 的身份才吃这一帧**：官方装配器把 `update` 限定在
         * `context.state !== undefined` 上（`assembler.ts`：`starting = role === 'start' &&
         * context.start === undefined`，之后才 `else if (context.state !== undefined)
         * context.state = definition.update(…)`）。没有 `step/start` 的孤儿身份由
         * `buildViewNode()` 的 `fallbackState()` 按它自己的帧重放，那一支只认
         * `live-chunk` / `attempt` / `message` / `step/end`——**没有 retry 分支**，于是孤儿流
         * 的 `sawChunk`（→ `partial`）与孤儿结算的 `final`（→ `node`）都不被它清掉。
         *
         * `closed`（`step/end` / 轮次闭合）**不跟着清**：官方 `closedBoundary()` 的另两条来源
         * 是位置索引的预扫描，与状态机的 `stepEnd` 字段无关，而重试发生在模型调用期间、
         * `step/end` 在其后——durable 流里那两种顺序不可能出现（与 F04 那条契约边界同源）。
         * 这里只改**已存在且已 started** 的条目（不拿这一帧凭空造身份）；请求表那一份是
         * 另一条线，靠「这一步查不查得到请求」得到同一条 `started` 口径。
         */
        {
          const retryStreamKey = retryStep === null ? undefined : stepKey(retryTurn, retryStep);
          const retryStream = retryStreamKey === undefined ? undefined : streamStates.get(retryStreamKey);
          if (retryStream !== undefined && retryStream.started) {
            retryStream.sawChunk = false;
            retryStream.finalSeq = undefined;
            /**
             * `initialState()` 的 `blocks: []`：**块证据**也随重置清空。否则「重试之前流过的
             * 那点正文」会在这一帧之后冒充「已闭合的中断贡献」（本批 P6 的反面）——
             * 重置之后要么由新 chunk 重新武装，要么这个身份在布局上什么都不剩。
             */
            retryStream.blocks.clear();
          }
        }
        break;
      }

      case "request/header": {
        const header = data.header;
        const config = headerConfig(header);
        const tools = headerTools(header);
        const reason = typeof data.reason === "string" ? data.reason : undefined;
        const isInitial = reason === "initial" || lastHeaderSeq === null;
        /**
         * 官方 `inspectRequestPrompt()` 的两条判据：提示词正文变了吗、工具目录
         * （JSON 逐字比）变了吗。本扩展把 `system/message` 的改动并进这一支
         * （刻意差异 2），所以没有官方「`system.update === true` 时不算变化」那条。
         *
         * 曾经是「只要这一帧带了 tools 就算工具变了」——那会让每一次带工具目录的
         * `request/header` 都出一行「工具已更新」，而官方逐字比 JSON，没变就不出行。
         */
        const systemChanged = !isInitial && systemText !== previousSystemText;
        const toolsChanged = !isInitial && JSON.stringify(previousTools ?? []) !== JSON.stringify(tools ?? []);
        if (isInitial || systemChanged || toolsChanged) {
          /** 这一行为什么出现；界面按它取官方那四条文案（宿主不知道界面语言）。 */
          const promptChange: TrajectoryPromptChange = isInitial
            ? "initial"
            : systemChanged && toolsChanged
              ? "system-and-tools"
              : systemChanged
                ? "system"
                : "tools";
          const cell: Omit<TrajectoryCell, "index"> = {
            kind: "system",
            turn: currentTurn,
            seq: event.seq,
            time,
            // 行文本在界面侧按 `promptChange` 取（官方在布局层直接写那四条文案；
            // 本扩展的折叠在宿主侧，只给语义）
            text: "",
            promptChange,
            timeSeconds: null,
            startedAt: typeof time === "number" ? time : null,
            status: "complete",
            ...(systemText ? { systemPromptDetail: systemText } : {}),
            ...(!isInitial && previousSystemText ? { previousSystemPromptDetail: previousSystemText } : {}),
            ...(tools ? { toolsDetail: tools } : {}),
            /**
             * 被替换掉的那一份工具目录（官方 `previousPromptDetail.tools`）：
             * 「对照」页签的工具那一节要改动前 vs 改动后，少了它就只能拿改动前的
             * system 去比改动后的 tools（错的对照，界面上看不出来）。上一次没带目录时缺席。
             */
            ...(!isInitial && previousTools ? { previousPromptTools: previousTools } : {}),
            ...(Object.keys(config.options).length ? { optionsDetail: config.options } : {}),
            ...(config.provider ? { provider: config.provider } : {}),
            ...(config.model ? { model: config.model } : {}),
          };
          if (isInitial) initialSystemCell = cell;
          else {
            /**
             * 系统**更新**行的轮次不在这里定：官方走 `enclosingPromptTurn(nodes, change.seq, partial)`，
             * 要看「这一帧之后第一条带步骤的助手节点」，那要等整窗事件都折完才成立
             * （与初始行同一个道理）。收尾那一趟统一改写 `turn`（见 `promptUpdateCells`）。
             */
            promptUpdateCells.push(push(cell));
          }
        }
        previousTools = tools;
        previousSystemText = systemText;
        toolsByName = new Map((tools ?? []).map((tool) => [tool.name, tool]));
        lastHeaderSeq = event.seq;
        systemCellWritten = true;
        if (typeof data.turn === "number") currentTurn = data.turn;
        /**
         * 这一帧的请求配置挂到两处（官方 `TrajectorySnapshotBuilder.snapshot()` 里也正好
         * 是这两件事）：
         *
         * 1. **成为「最近生效的配置」**（`previousHeader = data.header`）：之后开的步骤
         *    在没有自己 header 时继承它。**整体替换**（读不出配置的帧替换成空配置），
         *    上一份已失效的字段不许残留。
         * 2. **落到它归属的那次助手请求上**——官方按 `headerFor()` 归到 `turn:step` 那一步
         *    （`headersByStep` 的键就是 `turn\u0000step`），所以这里按**事件落点步骤**
         *    （`locationStep`，官方 `ConversationLocationIndex` 口径：`step/end` 在收尾
         *    那一步上清、`turn/end` 全清）找，不是取「最后开的请求」：overflow 恢复时序里
         *    那个值正是压缩请求，选项会掉进压缩请求里、助手请求永远没有选项。
         *
         *    **落点不是步骤时谁都不回写**（`turn/end` 之后、`step/end` 之前这种时序）：
         *    官方 `headerStepKey()` 返回 undefined → 这一帧不进 `headersByStep`，它只做
         *    上面第 1 件事，等后续请求按 `headerFor()` 的第二分支继承
         *    （`previous.seq < request.startSeq`，而这一帧的 seq 更大）。从前这里退回
         *    「最近开的助手请求」，于是还没收尾的那次请求被这份 header 改写。
         *
         *    **也不看 `completedAt`**：助手消息结算 ≠ 步骤关闭——官方 `headersByStep` 是
         *    预扫描，与「这一步的助手消息结算没有」无关，落点仍在这一步就是它的最新配置。
         */
        effectiveHeader = { options: config.options, provider: config.provider, model: config.model };
        if (locationStep !== null) {
          const stepRequest = assistantRequests.get(stepKey(currentTurn, locationStep));
          if (stepRequest !== undefined) applyHeaderConfig(stepRequest, effectiveHeader);
        }
        break;
      }

      case "system/message": {
        const message = data.message as MessageLike | undefined;
        const text = blocksToText(message?.content);
        if (text) systemText = text;
        break;
      }

      case "developer/message": {
        /**
         * 工具目录变更（官方把这条归成 `context` 记录）。宿主只给**语义**：
         * 新增/移除了哪些工具名。官方在这一格写的是本地化文案
         * （「已添加工具：X」/「工具已更新 · 新增 3 个」），由界面侧按同一张表拼。
         *
         * `sourceBlocks` 也一并给：官方用它装工具名，搜索索引按块索引这些名字
         * （单条变更时官方**只**有这一条路径能搜到工具名）。
         */
        const message = data.message as MessageLike | undefined;
        const update = toolCatalogUpdate(message?.content);
        if (!update) break;
        // 这一步的助手请求号（不是「最后开的请求号」——同一步中途可能是压缩）
        const stepNumber = currentStepRequestNumber();
        push({
          kind: "context",
          turn: typeof data.turn === "number" ? data.turn : currentTurn,
          seq: event.seq,
          time,
          text: "",
          toolUpdate: { added: update.added, removed: update.removed },
          sourceBlocks: update.blocks,
          messageSource: { kind: "tool-registry" },
          ...(stepNumber === undefined ? {} : { requestNumber: stepNumber }),
          timeSeconds: 0,
          startedAt: typeof time === "number" ? time : null,
          status: "complete",
        });
        break;
      }

      /**
       * `agent/inbox/spliced`：inbox 队列的插入 / 编辑 / 领取 / 取消。
       *
       * 线格式换算（**只吃 `target === 'next-step'`**、`inserted` 畸形元素保留槽位）
       * 与聊天侧的落位判定**同源**，都在 `dsh/inboxClaim.ts`；那里写清了为什么不能连
       * `next-turn` 一起吃（实测本机 442 份日志：只吃 next-step 是 9.2%，一起吃 85%）。
       */
      case "agent/inbox/spliced": {
        inboxState = applyNextStepSplice(inboxState, data);
        break;
      }

      case "user/message": {
        /**
         * **线格式**：`user/message` 的 `data` **就是** `UserMessage` 自己
         * （`dsh-session lib/types/types.d.ts`：`'user/message': UserMessage`，
         * 字段是 `{id, role, content, source}`），**没有 `message` 包一层**——
         * 包一层的是 `system/message` 与 `tool/result`（`{turn, step, message}`）。
         *
         * 这里曾经按 `data.message` 读，于是 `kind` 与 `text` 全为空、整条被
         * `if (!text && !isHuman) break` 丢掉：真机上「**用户消息与上下文节点
         * 全都不出现在轨迹里**」（用户 2026-09-14 报的）就是这个。核对方式是
         * 扫 280 份真实会话日志里全部 2443 条 `user/message`：`data` 的键
         * 一律是 `content,id,role,source`，带 `message` 包装的**一条都没有**。
         */
        const message = data as MessageLike;
        const kind = typeof message?.source?.kind === "string" ? (message.source.kind as string) : "";
        // 轨迹里的这条也是**纯文本**：落盘正文里服务端已经把会话引用折成了 `@标题`，
        // 但队列条目、用户手写的裸 URI、服务端折过之前的历史快照里仍可能是原始 token
        // （`@[标题](dsh-session:…)`），不折的话用户在轨迹里看到的是一长串 base64
        // （聊天侧由 `webview/mentionLinks.ts` 还原成可点的 `@标题`，这边没有链接能力，
        // 只做同一条显示还原）
        const text = displaySessionMentions(blocksToText(message?.content));
        // 官方 `trajectory-input-message` 的判据是 `source.kind !== 'user'` → context。
        // 真实日志里的 kind 分布：plugin / user / agent-instructions / skill-catalog /
        // agent-message / subagent-settled / goal / skill-invocation（**没有 user-rpc**）。
        // 这里保留 `user-rpc` 也算人的话，是为了与本扩展聊天侧
        // （`adapter.ts` 的 user/message 分支）口径一致——两者对真实数据的分派完全相同。
        const isHuman = kind === "user" || kind === "user-rpc";
        if (!text && !isHuman) break;
        /**
         * steering（官方 `trajectory-input-message` 的第三分支）：人发消息的 id 命中
         * inbox 状态机的**本次领取**集合，就是生成过程中插进来的引导消息。
         *
         * 判据与聊天侧的落位**同一处**（`dsh/inboxClaim.ts`）：那边用它决定这条消息
         * 追加到本轮末尾并切段、还是插到本轮顶部。
         *
         * 界面上它与真用户消息**没有标签差异**（官方 cell 层同样是 `kind: 'user'`），
         * 差别只有**不置 `opensTurn`**——所以这里只改这两个字段，不动呈现。
         */
        const steering = isHuman && claimedByNextStep(inboxState, message?.id);
        const messageSourcePlugin = sourcePluginName(message?.source);
        /**
         * 官方 `inputCellDetail()` 的口径：`text` 只放**附件摘要**（本地化，所以这里
         * 只给计数），正文进 `previewMarkdown`（列表显示它的预览），全部文本块进
         * `inputDetail`。从前 `text` 是宿主截的 160 字首行，列表再把预览接在后面，
         * 于是同一段正文在行里出现两遍、且截断口径与官方不同。
         */
        const preview = firstBlockText(message?.content, "text");
        const attachments = attachmentSummary(message?.content);
        const detail = blockTexts(message?.content, "text", "\n");
        // 这条消息落在这一步，就挂这一步的助手请求号（不是「最后开的请求号」）
        const stepNumber = currentStepRequestNumber();
        push({
          kind: isHuman ? "user" : "context",
          turn: currentTurn,
          seq: event.seq,
          time,
          text: "",
          ...(attachments ? { attachments } : {}),
          ...(preview ? { previewMarkdown: preview } : {}),
          ...(detail ? { inputDetail: detail } : {}),
          ...(steering ? { steering: true } : isHuman ? { opensTurn: true } : {}),
          ...(stepNumber === undefined ? {} : { requestNumber: stepNumber }),
          messageSource: {
            ...(kind ? { kind } : {}),
            ...(messageSourcePlugin ? { plugin: messageSourcePlugin } : {}),
            ...(typeof message?.source?.round === "number" ? { round: message.source.round } : {}),
            ...(message?.source ? { raw: message.source } : {}),
          },
          timeSeconds: null,
          startedAt: typeof time === "number" ? time : null,
          status: "complete",
        });
        // steering 的落组要等收尾（要看「它之后那条助手消息」），先把当时的落点记下。
        // 按事件 `seq` 记（稳定身份），不按会被前插重编号的显示序号。
        if (steering && typeof event.seq === "number") {
          steeringLocated.set(event.seq, { turn: currentTurn, step: locationStep });
        }
        break;
      }

      /**
       * `assistant/live-chunk`：流式增量。本扩展**不发布流式正文**（刻意差异 1），
       * 这一支只为**布局**留下「在跑的流」的身份（官方 `TrajectorySnapshot.partial`）。
       *
       * 官方 `updateChunk()` 对**任何** chunk 都置 `state.sawChunk = true`：`usage` 那一支
       * 与 `finish` / 未知 `type` 落进的 `default` 支都置位，而 `sawChunk` 是
       * `buildViewNode()` 发不发 `partial` 的三个条件之一。**另一件**是块证据
       * （`state.blocks`）：只有 `block-start` / `*-delta` / `block-end` 会动它，
       * `usage` / `finish` / 未知 `type` 不动——即「用了 token 但没有可见块」不算中断证据。
       *
       * `chunk` 不是对象（畸形帧）时官方那台状态机读到的是不存在的字段，本扩展按**适配边界**
       * 处理：不置位、不建身份——这与「合法的未知 `type`」是两件事，不拿畸形事件替合法等价。
       */
      case "assistant/live-chunk": {
        const liveChunk = data.chunk;
        if (liveChunk === null || typeof liveChunk !== "object") break;
        const explicitIdentity = typeof data.step === "number";
        const chunkTurn = typeof data.turn === "number" ? data.turn : currentTurn;
        const chunkStep = explicitIdentity ? (data.step as number) : currentStep;
        const chunkState = streamStateOf(chunkTurn, chunkStep, event.seq);
        chunkState.sawChunk = true;
        /**
         * 与 `sawChunk` **分开**的那一份：块证据（官方 `updateChunk()` 里 `state.blocks` 的
         * 等价物）。它只服务 `finalNode()` 合成中断节点的判据
         * （`hasInterruptionEvidence()` / `closedBoundary()` 那条支），按 `chunk.index`
         * 覆盖槽位、**不复制流内容**（见 `BlockEvidence`）。
         */
        applyChunkEvidence(chunkState.blocks, liveChunk as Record<string, unknown>);
        break;
      }

      /**
       * `assistant/attempt`：**首个 token 时刻的第二条来源**。
       *
       * 官方 `settleTiming()` 对 `assistant/message` 与 `assistant/attempt` **都**取
       * `data.stream` 的首个 token 时刻（`assistantStreamFirstTokenTime`），并且是
       * `firstTokenTime ?? 新值`——**先到者胜**：一次尝试里两者可能都到，也可能只有后者。
       *
       * 为什么不能只靠 `assistant/message`：模型调用失败重试的那些 step 只留得下 attempt
       * （实测本机 161 个带 attempt 的 step 里有 52 个没有带时刻的助手消息），
       * 照旧只读助手消息，这 52 个请求的 TTFT / 生成 / 吞吐就一直是「不可用」。
       */
      case "assistant/attempt": {
        /**
         * 帧自带 `step` 时身份就**已经明确**：只按 `turn:step` 查那一次请求，
         * **查不到就不写**——绝不回落到「最后开的那次助手请求」。回落会把别的
         * 步骤 / 轮次的首 token 填到当前请求上（窗口从半截开始、或这一帧指向
         * 窗口里根本不存在的那一步时，界面就会显示一个错的首 token）。
         * 只有帧自己没带身份（拿不到坐标）时才退回当前步骤 / 最后一次助手请求。
         */
        const explicitIdentity = typeof data.step === "number";
        const attemptTurn = typeof data.turn === "number" ? data.turn : currentTurn;
        const attemptStep = explicitIdentity ? (data.step as number) : currentStep;
        const attemptKey = attemptStep === null ? undefined : stepKey(attemptTurn, attemptStep);
        /**
         * 身份本身也要记下：官方 `fallbackState()` 会按这个身份自己的帧重建 state，
         * 之后这一身份第一次出现的先后（`firstSeq`）按它算。`attempt` 只做
         * `settleTiming()`：**不置也不清** `sawChunk`——只有 attempt 的步骤不是在跑的流。
         */
        streamStateOf(attemptTurn, attemptStep, event.seq);
        const streamTime = streamFirstTokenTime(data.stream);
        if (streamTime !== null) {
          const byIdentity = attemptKey === undefined ? undefined : assistantRequests.get(attemptKey);
          const request = byIdentity ?? (explicitIdentity ? undefined : lastAssistantRequest);
          if (request !== undefined) {
            if ((request.assistantFirstTokenTime ?? null) === null) {
              request.assistantFirstTokenTime = streamTime;
              // 这一步可能已经有结算出来的账本行（`assistant/message` 先到、那一帧
              // 又没有 token）：记录级计时也要跟着补上，两份不许各说各话。
              publishFirstToken(request, streamTime);
            }
          } else if (explicitIdentity && attemptKey !== undefined) {
            /**
             * 帧自带坐标、那一步在窗口里没有请求（官方 `fallbackState()` 的
             * `started: false` 状态）：这个时刻仍属于**它自己那一步**的行，先到者胜地
             * 记进 `orphanFirstTokens`（键是帧自己的身份，不写任何请求），并回填**已经产出**
             * 的孤儿行——官方 `fallbackState()` 重放后 `finalNode()` 读的是同一份 state，
             * 不能只有后一行才有值。
             */
            if (!orphanFirstTokens.has(attemptKey)) {
              orphanFirstTokens.set(attemptKey, streamTime);
              publishOrphanFirstToken(attemptKey, streamTime);
            }
          }
        }
        break;
      }

      case "assistant/message": {
        const message = data.message as MessageLike | undefined;
        /**
         * 官方 `expandAssistant()` 的口径：正文与思考**分开**取（各自按 `\n\n`
         * 连接同类块），一行的 `text` 只在「两者都没有」时才有值。
         *
         * 这里是「助手行被误判成仅工具调用」的根因：从前把正文摘要塞进 `text`、
         * 没有正文时留空，界面于是拿「空 text」当「仅工具调用」——**只有思考没有
         * 正文**的助手行（真实日志里 36% 的助手消息）全被写成那四个字，而官方那时
         * 展示的是思考摘要；连一个工具都没有、只有思考的行也一样。
         */
        const messageText = blockTexts(message?.content, "text", "\n\n");
        const thinkingText = blockTexts(message?.content, "reasoning", "\n\n");
        const toolCalls = blockCount(message?.content, "tool-call");
        const images = blockCount(message?.content, "image");
        /** 官方 `summarizeAssistantActivity()`：没正文没思考时才给语义摘要。 */
        const emptySummary: TrajectoryCell["emptySummary"] =
          messageText !== "" || thinkingText !== ""
            ? undefined
            : toolCalls > 0
              ? { kind: "tool-call" }
              : images > 0
                ? { kind: "images", count: images }
                : undefined;
        const usage = trajectoryUsage(data.usage);
        /**
         * 这条助手消息所属的**助手请求**：按 `turn:step` 找（官方
         * `trajectory-assistant-step` 的 definition id 就是 `${turn}:${step}`，
         * `assistant/message` 是它的一次 update）。
         *
         * **不能用「最后开的请求」**：overflow 恢复时序里同一步中途开过压缩请求，
         * 那个值此刻是压缩请求——助手消息会把结算落到压缩请求上，而它自己的请求
         * 永远停在 `running`（用量、选项、收尾与计时开始一起丢）。
         *
         * **帧带了身份而请求表里没有那一步时谁都不写**：官方 `fallbackState()` 用这个身份
         * 自己的事件重建一个 `started: false` 的状态，`assistantRequest()` 第一句
         * `if (!state.started) return undefined`——那一步压根没有请求（官方 `finalNode()`
         * 仍发布助手节点，只是 `timing.stepStartTime` 为 `null`）。回落到「最后开的助手请求」
         * 会把这次结算的用量、收尾时刻、提供方 / 模型身份、状态与失败文案全写到**另一个
         * 步骤**的请求上。只有帧自己没带 `step`（拿不到坐标的畸形帧）时才退回窗口当前步、
         * 再退最后一次助手请求——与 `assistant/attempt` 同形。
         */
        const explicitIdentity = typeof data.step === "number";
        const messageTurn = typeof data.turn === "number" ? data.turn : currentTurn;
        const messageStep = explicitIdentity ? (data.step as number) : currentStep;
        const messageKey = messageStep === null ? undefined : stepKey(messageTurn, messageStep);
        /**
         * 「这一步已经结算过」的标记同样按**帧自己的身份**记（官方每个 step 一份 state，
         * 最终节点属于那个 identity 的节点）。从前它按窗口当前的 `currentTurn:currentStep`
         * 记：乱序结算时（第 2 步先结算、第 1 步后结算）第 1 步永远标不上「已结算」，
         * 收尾那一趟会给它补出一行多余的「正在生成」占位——那一步明明已经结算过，
         * 账本上于是同一个步骤出现两行、请求号也重了一遍。畸形帧（没带坐标）沿用窗口
         * 当前步，与下面查请求的兜底同口径。
         */
        settledSteps.add(stepKey(messageTurn, messageStep));
        /**
         * 官方 `settleMessage()` 对**流状态**做两件事：落下 `final`（`node` 从此存在）
         * 并清掉 `sawChunk`——这一步不再是「在跑的流」。两者都要记：`sawChunk` 被清之后
         * 后到的 chunk 只把它重新置位，`node` 仍挡着 `partial`（官方 `buildViewNode()`
         * 的 `node === undefined` 不成立）。
         *
         * 同一个身份在窗口里可以结算**多次**（本扩展「每次结算各出一行」的既定差异），
         * 这里每次结算都按同一套语义更新：最后一次结算仍是这个身份的 `final`，而布局节点
         * **一个身份只有一个**（官方一个 definition id 一个 Context、`final: match` 后到者胜）
         * ——`currentAssistantNodes()` 每次都由这份状态的**当前贡献**导出，所以后到的结算
         * 自动顶掉前一个，不需要在这里维护第二份表。
         */
        {
          const settledStream = streamStateOf(messageTurn, messageStep, event.seq);
          settledStream.sawChunk = false;
          settledStream.finalSeq = event.seq;
          /**
           * 官方 `settleMessage()` 把 `blocks` 换成**结算消息自己的块**。块证据只在「没有
           * `final`」时才有用（有 `final` 就走 `finalNode()` 第一条支），而 `final` 只可能
           * 被首个 `step/start` 与「已 started 的 `llm/retry`」清掉——那两处各自按官方
           * `initialState()` 把 `blocks` 一起清空。所以这里清掉槽位，与「先换成消息自己的
           * 块、之后被重置一起清」在**布局判据**上等价，也不必为不发布的正文明细做映射
           * （重复 `step/start` 不清 `final`，那条路径下也读不到块证据）。
           */
          settledStream.blocks.clear();
        }
        const stepRequest = (messageKey === undefined ? undefined : assistantRequests.get(messageKey))
          ?? (explicitIdentity ? undefined : lastAssistantRequest);
        /**
         * 步骤开始时刻取**这一步助手请求的 `startedAt`**（官方
         * `AssistantMessageNode.timing.stepStartTime` 就是 `step/start` 的时刻）。
         *
         * 从前读的是 `data.startedAt`——真实日志里 `assistant/message` **没有**这个字段
         * （438 份日志 3503 条助手消息零命中），于是 `stepStart` 恒为 null、
         * `timingRecorded` 恒为 false：计时页签永远显示「未记录」，时间线的总时长也只按
         * 各段 `timeSeconds` 求和。`request/header` 缺席的窗口里退回首帧时刻。
         */
        const stepStart = stepRequest?.startedAt ?? null;
        /**
         * 首个 token 时刻：**先到者胜**（官方 `settleTiming()` 的
         * `state.firstTokenTime ?? 新值`）。`assistant/attempt` 可能已经先把它记在请求上，
         * 而这一帧的 `stream` 未必带 token——所以以请求上那份为准，两边取值同源。
         * 这一帧自己带的时刻按官方 `assistantStreamFirstTokenTime()` 读。
         */
        const streamToken = streamFirstTokenTime(data.stream);
        /**
         * 没有请求的步骤（窗口无 `step/start`）从 `orphanFirstTokens` 取「先到者胜」那一份：
         * 官方 `fallbackState()` 按事件顺序重放该身份自己的帧，`settleTiming()` 就是
         * `state.firstTokenTime ?? 新值`——attempt 先到、message 后到时，行取的仍是 attempt
         * 那个时刻，而不是 message 自己更晚的那个。
         */
        const orphanToken = messageKey === undefined ? null : orphanFirstTokens.get(messageKey) ?? null;
        const firstToken = stepRequest?.assistantFirstTokenTime ?? orphanToken ?? streamToken ?? null;
        /**
         * 只服务**帧自带身份、且那一步没有请求**的路径：这一次结算的首 token 记回
         * 「先到者胜」那份记忆，并回填**已经产出**的孤儿行——官方一个 step 只有一份 state，
         * 先结算那一行不能停在 null（那一帧的 stream 本来就没带 token），后一行才有值。
         */
        const orphanKey = stepRequest === undefined && explicitIdentity ? messageKey : undefined;
        if (orphanKey !== undefined && firstToken !== null && !orphanFirstTokens.has(orphanKey)) {
          orphanFirstTokens.set(orphanKey, firstToken);
          publishOrphanFirstToken(orphanKey, firstToken);
        }
        const retry = retries.get(stepKey(messageTurn, messageStep));
        const turn = messageTurn;
        /**
         * 这条助手消息发起的工具调用 id（界面侧「层级跳转」用：工具记录 → 它是谁发起的）。
         *
         * 官方的判据是助手格的 `sourceBlocks[].callId`，我们两边都给：`callIds` 是轻量形态
         * （界面只读它），`sourceBlocks` 是**原始块**（搜索索引按块索引 `type` / `content`）。
         * 助手的 `tool-call` 块实测 100% 带 `name` 与 `arguments`（57095/57095），放进
         * `sourceBlocks` 之后工具名与调用参数才进得了搜索面——正文与思考本来就有
         * `previewMarkdown` / `thinkingDetail`，增量就在这几个块上。
         */
        const callIds = callIdsOf(message?.content);
        const sourceBlocks = sourceBlocksOf(message?.content);
        /**
         * 这一步的请求号：优先这一步自己的助手请求。
         *
         * 帧带了身份而请求表里没有那一步时**不给号**——官方那一步没有请求，行上也就没有
         * 请求可挂；退回 `currentStepRequestNumber()` 会给它一个属于窗口当前步的号，
         * 请求级检查器据此点开的是**别人的**请求。只有帧自己没带坐标时才退回老行为。
         */
        const stepNumber = stepRequest?.number ?? (explicitIdentity ? undefined : currentStepRequestNumber());
        const cell = push({
          kind: "message",
          turn,
          // 行自己的坐标取**帧自己的** `step`（官方 `initialState(event.data.turn,
          // event.data.step, …)` 给节点自己的 turn/step，分组判据也按它）；
          // 只有帧没带坐标的畸形帧才用窗口当前步。
          step: messageStep ?? 0,
          seq: event.seq,
          time,
          text: "",
          ...(emptySummary ? { emptySummary } : {}),
          ...(messageText !== ""
            ? { previewMarkdown: messageText, outputDetail: messageText }
            : thinkingText !== ""
              ? { previewMarkdown: thinkingText }
              : {}),
          ...(thinkingText ? { thinkingDetail: thinkingText } : {}),
          ...(sourceBlocks === undefined ? {} : { sourceBlocks }),
          ...(stepNumber === undefined ? {} : { requestNumber: stepNumber }),
          timeSeconds: secondsBetween(stepStart ?? undefined, time),
          startedAt: stepStart ?? (typeof time === "number" ? time : null),
          status: data.interrupted === true ? "error" : "complete",
          ...(data.interrupted === true ? { error: "@interrupted" } : {}),
          ...(usage ? { usage } : {}),
          ...(typeof message?.source?.model === "string" ? { model: message.source.model as string } : {}),
          ...(retry ? { retry } : {}),
          ...(callIds.length > 0 ? { callIds } : {}),
          assistantMetrics: {
            timingRecorded: stepStart !== null,
            stepStartTime: stepStart,
            firstTokenTime: firstToken,
            completedTime: typeof time === "number" ? time : null,
            usageProvided: usage !== undefined,
            outputTokens: usage?.output ?? null,
          },
        });
        // 没有请求的步骤：这一行登记进 `orphanCells`，晚到的 attempt 才能回填它的首 token。
        if (orphanKey !== undefined) {
          const producedOrphan = orphanCells.get(orphanKey);
          if (producedOrphan === undefined) orphanCells.set(orphanKey, [cell]);
          else producedOrphan.push(cell);
        }
        /**
         * 结算**这一步的助手请求**：用量、收尾时刻、提供方身份、状态。
         *
         * 状态按官方 `assistantRequest()` 的**节点分支优先**：非中断的
         * `assistant/message` 就是这次请求的最终节点 → `complete`，之前那次
         * `llm/retry` 记下的 `error` **不再把状态钉死**（F04：从前是「已经是 error
         * 就不覆盖」，于是「重试一次才成功」的请求永远显示失败，而账本里的助手行
         * 是 complete——同一个事实两个状态）。它记的重试事实（次数 / 上限 / 延迟 /
         * 失败文案与错误码）照旧留在请求上，与官方 payload 同形，这里一个都不清。
         *
         * 中断（`interrupted === true`）的帧是官方三分支里的**后两支**（官方
         * `assistantRequest()`：`node !== undefined && node.interrupted !== true` → `complete`；
         * 否则 `state.retry !== undefined || boundary !== undefined` → `error`；两者都没有 →
         * `running`）：中断**本身不是失败证据**，已经有失败证据（`llm/retry` 把它标成 `error`，
         * 或这一步已经被关掉）就保持 `error`，否则这一次请求仍在跑——`step/end` 与轮次收尾的
         * 后处理会在边界把它收成 `error`。请求级 `error` 在这一帧上照旧**不写**（官方那一份由
         * 重试或轮次失败给出，不是中断给的）；账本行上的 `status: "error"` 与 `@interrupted`
         * 是**另一件事**（界面显示的「被中断」那一行），一个字都不改。
         */
        if (stepRequest !== undefined) {
          settleUsage(stepRequest, usage);
          // 官方取 `node?.time ?? boundary?.time`：结算帧的时刻优先于 `step/end`
          if (typeof time === "number") stepRequest.completedAt = time;
          if (data.interrupted === true) {
            // 不把已有的失败证据降级：只有「没有失败证据」的那一种才留在 `running`
            if (stepRequest.status !== "error") stepRequest.status = "running";
          } else {
            stepRequest.status = "complete";
          }
          // 首个 token 时刻（请求级计时面板的 TTFT / 吞吐量要用）。
          // **先到者胜**、且「没取到」不覆盖：`assistant/attempt` 可能已经先给了这一时刻，
          // 而这一帧的 `stream` 未必带 token——无条件赋值会把已经记下的时刻抹成 null。
          if ((stepRequest.assistantFirstTokenTime ?? null) === null) {
            stepRequest.assistantFirstTokenTime = streamToken;
            /**
             * 这一步更早结算出来的行（那一帧的 stream 没有 token）也要跟着补上同一个值：
             * 官方一个 step 一份 state（`settleTiming()` 的 `state.firstTokenTime ?? 新值`），
             * 不能一行停在 null、后一行才有值——与 `assistant/attempt` 那条路
             * （`publishFirstToken()`）同一口径；与孤儿路径的 `publishOrphanFirstToken()` 对称。
             */
            if (streamToken !== null) publishFirstToken(stepRequest, streamToken);
          }
          /**
           * 记下这一步已经产出的账本行：`assistant/attempt` 晚到补首 token 时，
           * 记录级计时（界面真正读的那一份）要跟着补，不能只有请求级有值。
           */
          const produced = cellsByRequest.get(stepRequest);
          if (produced === undefined) cellsByRequest.set(stepRequest, [cell]);
          else produced.push(cell);
          if (typeof message?.source?.provider === "string") {
            stepRequest.provider = message.source.provider;
            // 身份从此有主：后到的 header 配置不许再覆盖 `provider`（见 `settledIdentity`）
            markSettledIdentity(stepRequest, "provider");
          }
          if (typeof message?.source?.model === "string") {
            stepRequest.model = message.source.model;
            markSettledIdentity(stepRequest, "model");
          }
        }
        // 轮次收尾的原因**此刻还不知道**（`turn/end` 在后面才到）——统一在收尾后挂，
        // 与官方的 `applyTurnErrors` 同一个时机。以前在这里查 `turnErrors` 恒为空，
        // 于是「这一轮失败了」在账本上永远看不到（本文件的断言钉住了它）。
        break;
      }

      case "tool/call": {
        const callId = typeof data.callId === "string" ? data.callId : "";
        const name = typeof data.name === "string" ? data.name : "tool";
        const args = typeof data.arguments === "string" ? data.arguments : "";
        const schemaDetail = schemaDetailOf(name, toolsByName, schemaIntern);
        // 这次调用是**这一步的助手请求**发起的，挂它的号（不是「最后开的请求号」：
        // 同一步中途可能压缩过，那个号属于压缩请求）
        const stepNumber = currentStepRequestNumber();
        const cell = push({
          kind: "tool",
          turn: typeof data.turn === "number" ? data.turn : currentTurn,
          step: currentStep ?? 0,
          seq: event.seq,
          time,
          // 官方 `summarizeCall()`：`text` 就是工具名，参数进 `previewMarkdown`，
          // 列表侧拼成 `name · preview(args)`（宿主不再自己拼、也不截断）。
          text: name,
          ...(args ? { previewMarkdown: args } : {}),
          ...(args ? { inputDetail: args } : {}),
          ...(callId ? { callId } : {}),
          toolName: name,
          ...(schemaDetail === undefined ? {} : { schemaDetail }),
          ...(stepNumber === undefined ? {} : { requestNumber: stepNumber }),
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
        const isError = resultIsError(message, data.error);
        const summary = resultSummaryOf(message?.content, data.error, isError);
        const index = callId ? toolCells.get(callId) : undefined;
        if (index === undefined) {
          // 调用在窗口之外（分页边界）也有结果：补一行「只有结果」的记录。
          // 官方无 call 时走 `resultAsText()`：正文取自结果（`text` 与
          // `previewMarkdown` 都是它），而不是「tool」这个占位名。
          // 这一行也是**这一步的助手请求**的产物（否则它成了账本里唯一没有请求号的行）
          const stepNumber = currentStepRequestNumber();
          push({
            kind: "tool",
            turn: typeof data.turn === "number" ? data.turn : currentTurn,
            step: currentStep ?? 0,
            seq: event.seq,
            time,
            ...resultAsText(summary),
            ...(callId ? { callId } : {}),
            ...(stepNumber === undefined ? {} : { requestNumber: stepNumber }),
            timeSeconds: null,
            startedAt: typeof time === "number" ? time : null,
            status: isError ? "error" : "complete",
            ...summary,
            ...(text ? { outputDetail: text } : {}),
            isError,
          });
          break;
        }
        const cell = cells[index];
        // 结算时按官方口径重算「请求 → 结果」两栏：结果那一栏改由
        // `resultPreviewMarkdown` / `resultSummary` / `result` 三者之一决定。
        cell.result = summary.result;
        cell.resultPreviewMarkdown = summary.resultPreviewMarkdown;
        cell.resultSummary = summary.resultSummary;
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
        const raw = args && args !== '""' ? args : "";
        const schemaDetail = schemaDetailOf(name, toolsByName, schemaIntern);
        const cell = push({
          kind: "subtool",
          turn: currentTurn,
          step: currentStep ?? 0,
          seq: event.seq,
          time,
          text: name,
          ...(raw ? { previewMarkdown: raw } : {}),
          ...(raw ? { inputDetail: raw } : {}),
          ...(subCallId ? { callId: subCallId } : {}),
          toolName: name,
          ...(schemaDetail === undefined ? {} : { schemaDetail }),
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
        const summary = resultSummaryOf(data.content, undefined, isError);
        cell.result = summary.result;
        cell.resultPreviewMarkdown = summary.resultPreviewMarkdown;
        cell.resultSummary = summary.resultSummary;
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
        // 压缩也是**一次模型请求**（官方 `CompactionRequestView`，`step` 固定 0），
        // 一样占请求号——请求表里少了它，后面的编号就对不上了。
        startRequest({
          purpose: "compaction",
          turn: typeof data.turn === "number" ? data.turn : currentTurn,
          step: 0,
          seq: event.seq,
          startedAt: typeof time === "number" ? time : null,
          completedAt: null,
          status: "running",
        });
        break;
      }

      case "compaction/summary": {
        // 摘要挂到最后一条还在跑的压缩行上（相邻关系由协议保证）
        const cell = [...cells].reverse().find((entry) => entry.kind === "compacted" && entry.status === "running");
        if (!cell) break;
        const summary = blockTexts(data.summary, "text");
        const raw = blocksToText(data.rawOutput);
        if (summary) cell.outputDetail = summary;
        // 行摘要按官方口径只留**语义**：正文进 previewMarkdown（界面侧的预览函数
        // 负责去 markdown、压平、截断），`text` 留空（有摘要就不显示「已压缩」）
        cell.text = "";
        const preview = firstBlockText(data.summary, "text");
        if (preview !== undefined) cell.previewMarkdown = preview;
        if (typeof data.provider === "string") cell.provider = data.provider;
        if (typeof data.model === "string") cell.model = data.model;
        const usage = trajectoryUsage(data.usage);
        if (usage) cell.usage = usage;
        // `rawOutput`（模型原始输出）在「原始输出」页签里看
        if (raw && raw !== summary) cell.inputDetail = raw;
        /**
         * 思考部分单独成段（官方 `layout.ts` 的压缩支：`thinkingDetail =
         * detailReasoning(rawOutput ?? summary)`）。
         *
         * 上面那句 `blocksToText` **会跳过 `reasoning` 块**（它只收正文与工具结果的内层
         * 文本），所以不在这里另取一次，rawOutput 里的思考在界面上就没有任何落点
         * ——不是「显示两遍」的问题，是整段看不见。取不到 `rawOutput` 时按官方回落到
         * `summary`（同一支的 `rawOutput ?? summary`）；分隔符也用官方那个 `\n`
         * （不是助手消息那条链路的 `\n\n`）。
         */
        const reasoning = blockTexts(data.rawOutput ?? data.summary, "reasoning", "\n");
        if (reasoning) cell.thinkingDetail = reasoning;
        // 压缩请求的用量/身份也进请求表（官方的压缩请求同样带 usage 与 providerMetadata）。
        // 只挂**压缩请求**那份事实——助手请求是另一次请求，绝不共用（F02 的根因就是共用）。
        if (lastCompactionRequest !== undefined) {
          settleUsage(lastCompactionRequest, usage);
          if (typeof data.provider === "string") lastCompactionRequest.provider = data.provider;
          if (typeof data.model === "string") lastCompactionRequest.model = data.model;
        }
        break;
      }

      case "compaction/end": {
        const cell = [...cells].reverse().find((entry) => entry.kind === "compacted" && entry.status === "running");
        if (!cell) break;
        const error = typeof data.error === "string" ? data.error : undefined;
        cell.status = error ? "error" : "complete";
        if (error) cell.error = error;
        cell.timeSeconds = secondsBetween(cell.startedAt ?? undefined, time);
        if (lastCompactionRequest !== undefined) {
          settleRequest(lastCompactionRequest, typeof time === "number" ? time : 0, error);
        }
        break;
      }

      /**
       * `session/end-seed`：**会话边界**。官方 `interruptCompactions()` 以它为界，把边界
       * 之前仍在 `running` 的压缩请求改判成「被中断」（`trajectory.compaction-interrupted`，
       * 界面按这个合成码取那一句专用文案）——会话结束了，那次压缩不会再有 `compaction/end`。
       *
       * 实测本机 440 份日志这一档是 0 例（11 次压缩全部正常收尾），但规则要与官方一致：
       * 少了它，这种请求在账本里永远停在「正在压缩」。
       */
      case "session/end-seed": {
        const boundaryTime = typeof time === "number" ? time : 0;
        for (const request of requests) {
          if (request.purpose !== "compaction" || request.status !== "running") continue;
          request.completedAt = boundaryTime;
          request.status = "error";
          request.error = TRAJECTORY_COMPACTION_INTERRUPTED;
        }
        for (const cell of cells) {
          if (cell.kind !== "compacted" || cell.status !== "running") continue;
          cell.status = "error";
          cell.error = TRAJECTORY_COMPACTION_INTERRUPTED;
          cell.timeSeconds = secondsBetween(cell.startedAt ?? undefined, time);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * 会话累计用量：按**请求号顺序**逐个相加（官方 `TrajectoryView` 把
   * `requests` 按 `startSeq` 排好之后跑同一条累加循环，压缩请求同样计入）。
   *
   * 收尾后统一算，不边折边加：结算帧到达的顺序**不等于**请求号顺序——overflow
   * 恢复时序里压缩请求（#2）的 `compaction/summary` 早于助手请求（#1）的
   * `assistant/message`，边折边加会把累计挂到错的请求上（还会顺着「扣回来再加」
   * 那条支路把别的请求的贡献一起算错）。每个请求只加一次：用量重复上报时
   * `settleUsage` 已经取最后一次，这里自然不重复累加；没有用量的请求直接跳过
   * （不编造 0）。
   */
  {
    let cumulativeUsage: TrajectoryRequestUsage | undefined;
    for (const request of requests) {
      if (request.usage === undefined) continue;
      cumulativeUsage = addRequestUsage(cumulativeUsage, request.usage);
      request.cumulativeUsage = cumulativeUsage;
    }
  }

  // 还在跑的步骤补一行「正在生成」（官方那是流式中的助手行；本扩展不出流式正文，
  // 只出占位）。判据取**最后一次 `turn/end` 之后**开的步骤——更早的未结算步骤是
  // 被中断的那一轮，官方由 `assistant/attempt` 还原，我们这里不臆造正文。
  for (const [key, started] of startedSteps) {
    if (settledSteps.has(key)) continue;
    if (started.seq < lastTurnEndSeq) continue;
    push({
      kind: "message",
      turn: started.turn,
      step: started.step ?? 0,
      seq: started.seq,
      time: started.time,
      text: "",
      requestNumber: started.requestNumber,
      timeSeconds: null,
      startedAt: started.time,
      status: "running",
    });
  }

  /**
   * 轮次收尾的后处理（官方 `trajectoryTurnEndDefinition` + `applyTurnErrors` 同口径；
   * `turn/end` 总在该轮的助手消息之后才到，所以只能在这一趟里做）。三件事：
   *
   * 1. **边界补收尾时刻**（官方 `assistantRequest()` 的 `completedAt: node?.time ?? boundary?.time`）：
   *    该轮**任何**还缺收尾时刻的助手请求都按轮次结束时刻补上——这与状态判定是**两条独立
   *    判据**：`llm/retry` 已经把它标成 `error`，不能成为不补时刻的理由（否则这一次请求
   *    永远停在 `completedAt: null`，计时面板与时间线把它当成还在跑）。已有时刻**绝不覆写**。
   *    同一个边界也把**首 token 那一格定稿**：没记到就写显式 `null`（`step/end` 那一条同口径；
   *    键缺席只留给还在跑、宿主还没定稿的请求）。
   * 2. **边界判状态**：这一轮关闭时还没有「非中断的最终节点」（状态仍 `running`）→ `error`；
   *    已有成功节点的请求不受这一支影响，无轮次错误时仍是 `complete`。
   * 3. **`applyTurnErrors`**：这一轮 `failed`（`reason.kind === 'error'`）时，**该轮最后一条
   *    助手请求**改判 `error`（即使它已经有成功节点），并**真正覆盖**前一份诊断：文案整份换成
   *    轮次那一份（空文案规范化为**缺席**，不写空串），错误码有值才换（缺席时保留原有的）、
   *    `completedAt` 同样只在缺失时取轮次结束时刻。
   *
   *    `failed` 是肯定证据，不看「文案非空 / 错误码存在」——`AUTH` 恰好两样都不成立，
   *    靠反推会漏掉覆盖，把「最后是认证失败」伪装成重试时的服务端错误。
   *
   *    **按实际 `turn` 身份隔离**：更早的请求、其他轮的请求、压缩请求都不受影响
   *    ——绝不拿「最后开的那次请求」代替（overflow + 尾部压缩时那个值可能是压缩请求）。
   */
  for (const [turn, ending] of turnEndings) {
    let lastAssistant: TrajectoryRequest | undefined;
    for (const request of requests) {
      if (request.purpose !== "assistant" || request.turn !== turn) continue;
      lastAssistant = request;
      // 1. 边界补时刻（与状态无关；已有值不覆写）
      if (request.completedAt === null) request.completedAt = ending.time;
      // 2. 没有最终成功节点 → error
      if (request.status === "running") request.status = "error";
      // 1b. 首 token 定稿（见上面第 1 条；与 `step/end` 那一条同口径）
      if (request.assistantFirstTokenTime === undefined) request.assistantFirstTokenTime = null;
    }
    if (ending.failed) {
      if (lastAssistant !== undefined) {
        lastAssistant.status = "error";
        // 3. 终态诊断覆盖前诊断：空文案写成缺席（`undefined` 的键不进 JSON），不留空串
        lastAssistant.error = ending.error;
        if (ending.errorCode !== undefined) lastAssistant.errorCode = ending.errorCode;
        if (lastAssistant.completedAt === null) lastAssistant.completedAt = ending.time;
      }
      for (let index = cells.length - 1; index >= 0; index -= 1) {
        const cell = cells[index];
        if (cell.turn !== turn || cell.kind !== "message") continue;
        /**
         * 行上没有错误码字段：`AUTH` 那类**空文案**只把这一行判失败，不写空串
         * （界面会把空串当正文画出一条空的「错误」行；失败证据是状态，不是文案）。
         */
        if (cell.error === undefined && ending.error !== undefined) {
          cell.error = ending.error;
        }
        cell.status = "error";
        break;
      }
    }
  }

  /**
   * 官方的 **`TrajectorySnapshot.partial`**：只留**最后一个**「在跑的流」。
   *
   * `buildViewNode()` 的条件是 `node === undefined && boundary === undefined && state.sawChunk`
   * （本扩展不出流式正文行，所以这里只要**身份**）；快照层
   * （`trajectory-snapshot-builder.ts`）按 `anchorSeq` 升序遍历 contributions、
   * `if (data.partial !== null) partial = data.partial`，所以赢的是**身份第一次出现最晚**
   * 的那一个（`firstSeq` 最大），不是最近被更新的那一个。
   */
  const currentPartial = (): { turn: number; step: number } | undefined => {
    let best: AssistantStreamState | undefined;
    for (const state of streamStates.values()) {
      if (!state.sawChunk || state.finalSeq !== undefined || boundarySeqOf(state) !== undefined) continue;
      if (state.turn === null) continue;
      if (best === undefined || state.firstSeq > best.firstSeq) best = state;
    }
    const turn = best?.turn;
    if (turn === null || turn === undefined) return undefined;
    return { turn, step: best?.step ?? 0 };
  };
  const partial = currentPartial();

  /**
   * 布局归轮用的**当前**助手节点（官方 `eventNodes` 的助手项）：整窗折完之后从流状态的
   * 当前贡献导出一次（`partial` 此刻也已定稿）。两条官方布局分支读的是**同一份** nodes。
   */
  const layoutNodes = currentAssistantNodes();

  /**
   * 官方 `enclosingPromptTurn(nodes, seq, partial)`（系统**更新**行的归轮）：
   * `nodes` 里**第一个** `node.seq > seq`、`kind === 'assistant' && node.step > 0` 的节点
   * 所在轮次；没有就 `partial?.turn ?? 1`。**不是** `Math.min`（那是初始行那一支），
   * 也**不是**「这一帧到达时事件流正在哪一轮」——整轮收尾之后再改提示词时，两者给的答案不同。
   *
   * `nodes` 就是 `layoutNodes` 这份**当前**节点表（官方快照每个 definition key 只留一份
   * 贡献、`eventNodes` 再按 `seq` 排）：被 `step/start` / `llm/retry` 清掉 `final` 的身份
   * 已经不在表里，被 `block-start` 覆盖掉证据的合成中断节点也不在，**历史账本行不算节点**。
   * 官方的 `find()` 跑在按 `seq` 升序排好的数组上，所以这里取满足条件的**最小 `seq`**
   * （不是 Map / 数组的插入顺序）。
   */
  const enclosingPromptTurn = (changeSeq: number): number => {
    let best: { seq: number; turn: number } | undefined;
    for (const node of layoutNodes) {
      if (node.seq <= changeSeq || node.step <= 0) continue;
      if (best === undefined || node.seq < best.seq) best = { seq: node.seq, turn: node.turn };
    }
    if (best !== undefined) return best.turn;
    return partial?.turn ?? 1;
  };
  /**
   * 更新行的轮次在这里统一改写（它们入账时只带「到达时的 `currentTurn`」暂存）。
   * 按每行自己的 `change.seq` 查——同一条更新行只由它自己那一帧决定。
   */
  for (const cell of promptUpdateCells) {
    if (typeof cell.seq === "number") cell.turn = enclosingPromptTurn(cell.seq);
  }

  /**
   * 初始提示词那一行的**归轮**（官方 `firstVisibleTurn(nodes, partial)`）。
   *
   * 官方逐字是：`nodes` 里 `kind === 'assistant' && turn > 0` 的轮次取最小值，有在跑的
   * 流（`partial.turn > 0`）时也把它的轮次并进候选，**一个候选都没有就返回 1**。
   * **不是**「这一帧到达时事件流正在哪一轮」：窗口带前插历史时（初始 header 在第 2 轮
   * 到达、窗口里已经有第 1 轮的助手记录），照到达时归轮会让账本先排一段只装提示词行的
   * 第 2 轮，同一个轮号还会被拆成两段。
   *
   * `nodes` 与上一行同源：**当前**助手节点表（`layoutNodes`），不是账本里的助手记录行——
   * 「每次结算各出一行」是展示层的既定差异，被重置作废的旧 `final`、还在跑（只有占位行）
   * 的步骤、以及被撤销了证据的合成节点在官方都不构成节点（在跑的那一类靠 `partial` 兜底）。
   * 「已闭合 + 有 chunk 证据」的**合成中断节点**（`finalNode()` 的 boundary 支，
   * `seq = boundary.seq - 0.9`）同样在表里，所以它照样是这里的候选。
   *
   * 官方 `layoutEntryOrder()` 把初始行的记账序号强制成 `-Infinity`（本扩展是它的显示
   * 序号恒为 1），所以这个轮次只决定它归**哪一段**。
   */
  const firstVisibleTurn = (): number => {
    const candidates: number[] = [];
    for (const node of layoutNodes) {
      if (node.turn > 0) candidates.push(node.turn);
    }
    if (partial !== undefined && partial.turn > 0) candidates.push(partial.turn);
    return candidates.length === 0 ? 1 : Math.min(...candidates);
  };

  // 初始系统提示词那一行补到最前面（官方强制它排第一，见上面的注释）；
  // 完全没有 `request/header` 时退回「用已看到的 system 文本补一行」——它同样是初始
  // 提示词，归轮与上面那一行同一口径（官方那两条支都走 `firstVisibleTurn()`）。
  // 这一次重编号只保证「前插之后仍连续」；分组定稿后还会按摊平顺序再统一编一次
  // （见下面「显示序号按摊平顺序统一重编」那一段）。
  const visibleTurn = firstVisibleTurn();
  const front: Omit<TrajectoryCell, "index"> | undefined =
    initialSystemCell !== undefined
      ? { ...initialSystemCell, turn: visibleTurn }
      : (!systemCellWritten && systemText
        ? {
            kind: "system",
            turn: visibleTurn,
            seq: cells[0]?.seq ?? 0,
            time: cells[0]?.time ?? 0,
            text: "",
            promptChange: "initial",
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

  /**
   * steering 的落点（官方 `steeringPlacement()`，逐条照搬它的分支顺序）：
   *
   * 1. 领取发生时**某一步正在进行**（落点就是那一步）→ 放那一步的组里；
   * 2. 否则看**它之后那条助手消息**在哪一步（官方 `followingAssistants[i]`）——
   *    落点的轮次为空、或与那条助手同轮，就放那一步的组里；
   * 3. 都不成立 → 只落轮次（进消息组）。
   *
   * 为什么必须走这一步：steering 的 `user/message` 事件是在**领取那一刻**写的
   * （两次 `step/start` 之间），照事件顺序它会被分到自己那个消息组里，而官方把它
   * 放进**消费它的那一步**的组首（`pushStepInput()` 插在请求锚点之前）。
   *
   * 落点按**事件 `seq`** 查（稳定身份，官方同款 `eventLocations.get(node.seq)`）：
   * 显示序号 `cell.index` 在这之前刚被初始 system 行的前插整体重编号过，拿它当键
   * 会错位一格、查成后一条 steering 的落点。
   */
  {
    let following: TrajectoryCell | undefined;
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      const cell = cells[index];
      if (cell.steering === true) {
        const located = typeof cell.seq === "number" ? steeringLocated.get(cell.seq) : undefined;
        if (located?.step !== null && located?.step !== undefined) {
          cell.step = located.step;
          if (located.turn !== null) cell.turn = located.turn;
        } else if (
          following !== undefined
          && following.kind === "message"
          && (following.step ?? 0) > 0
          && (located?.turn === null || located?.turn === undefined || following.turn === located.turn)
        ) {
          cell.step = following.step;
          cell.turn = following.turn;
        }
      }
      if (cell.kind === "message") following = cell;
    }
  }

  /**
   * 官方的 **prologue** 规则：**turn 0 整段并进 turn 1**（官方 `deriveTrajectoryLayout()`
   * 尾部那一支：`turns.get(0)` 存在就无条件并进 `turns.get(1) ?? 空段`，不看 turn 0 里
   * 有什么——上游注释是「Orphan turn-0 cells (orphaned tools) fold into Turn 1」）。
   *
   * 官方是在**建组之后**把 turn 0 的**组**拼在 turn 1 自己的组**之前**
   * （`first.groups = [...prologue.groups, ...first.groups]`），于是那个角落里初始系统
   * 提示词行不再是摊平后的第一行（它的记账序号仍是 1）。本扩展改成**建组之前**把
   * turn 0 的记录改号成 1：按显示顺序建组自然得到同一段、段号也是 1，同时保住本扩展
   * 既有的不变量——**初始提示词永远是账本第一行、摊平顺序 = 显示序号**。这是有出处的
   * 刻意差异（见设计文档的排序与合并规则）。
   *
   * 改号必须放在这里：轮次失败的后处理按**真实 turn** 找该轮的助手行，早改号会让
   * turn 0 的失败证据落空；steering 的落点也按事件当时的 turn/step 记。
   *
   * turn 0 只在构造输入里出现：真实服务端轮号从 1 起。
   */
  for (const cell of cells) {
    if (cell.turn === 0) cell.turn = 1;
  }

  /**
   * 分组（官方 `deriveTrajectoryLayout` 的三条推入规则）。
   *
   * 官方**不渲染组头**——`TrajectoryGroupHeader` / `TrajectoryTurn` /
   * `TrajectoryTurnHeader` 在上游是无人 import 的死组件，组结构在界面上只落地成
   * 行属性与请求分组的键。组标题真正被用到的只有两处：**记录检查器的落点**
   * （`第 M 轮 · 第 K 步`）与**搜索索引的组标题字段**。所以这一层不做组描述
   * （官方那个 `groupDescription()` 同样只被死组件消费）。
   *
   * 三条规则逐字照搬官方：
   * - `pushMessage()`：只在**最后一组恰好也是消息组**时并进去，否则新开一组——
   *   所以一轮里可以有多个消息组（被步骤组隔开）；
   * - `pushStep()`：按 step 号**查找已有组**再追加，同名不新开；
   * - 压缩：独立压缩段自成一组（标题带它的 `startSeq`），不并进任何组。
   *
   * 判据是 `cell.step > 0`（官方 `node.step > 0` 走 `pushStep`，否则走 `pushMessage`），
   * 与官方的 `call.step > 0` 分派一致。
   */
  const turns: TrajectoryTurn[] = [];
  /**
   * 取某个轮次的组表（没有就新开一段）。
   *
   * **同一个轮号只允许有一段**：官方那份是 `Map<turn, bucket>`（结构上不可能出现
   * 两段同号轮次），这里只在「最后一轮恰好同号」时并入是不够的——初始系统提示词
   * 那一行会被 `unshift` 到账本最前面，它带的轮次因此可能**排在更早轮次之前**，
   * 于是同一个轮号被拆成两段（先一段只装这一行、后面再一段装这一轮其余记录），
   * 按轮号取那一轮的调用方只会拿到空壳。轮次之间（`null`，独立压缩段）保持原样：
   * 那里本来就可以各成一段，不并进更早的同名段。
   */
  const groupsOfTurn = (turn: number | null): TrajectoryGroup[] => {
    if (turn === null) {
      const last = turns[turns.length - 1];
      if (last !== undefined && last.turn === null) return last.groups;
    } else {
      const existing = turns.find((entry) => entry.turn === turn);
      if (existing !== undefined) return existing.groups;
    }
    const created: TrajectoryGroup[] = [];
    turns.push({ turn, groups: created });
    return created;
  };
  const pushMessageGroup = (turn: number | null, cell: TrajectoryCell): void => {
    const groups = groupsOfTurn(turn);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.title.kind === "message") last.cells.push(cell);
    else groups.push({ title: { kind: "message" }, cells: [cell] });
  };
  const pushStepGroup = (turn: number | null, step: number, cell: TrajectoryCell): void => {
    const groups = groupsOfTurn(turn);
    const existing = groups.find(
      (group) => group.title.kind === "step" && group.title.step === step,
    );
    if (existing !== undefined) existing.cells.push(cell);
    else groups.push({ title: { kind: "step", step }, cells: [cell] });
  };
  /**
   * steering 与其它记录一样按 step 归组（官方 `pushStepInput()`）。
   *
   * 官方那个函数比 `pushStep()` 多一步：组里**有 `requestOnly` 请求锚点行**时插到它
   * 前面，否则 `existing.laid.push(...)` —— 也就是**追加**。而锚点行只出现在「这一步
   * 没有助手节点」的请求上（官方 `representedRequests` 只登记 `step > 0` 且有助手节点
   * 的请求），本扩展根本不发行那种锚点行，所以这里与 `pushStepGroup()` 等价。
   */
  for (const cell of cells) {
    if (cell.kind === "compacted") {
      groupsOfTurn(cell.turn).push({
        title: { kind: "compaction", seq: cell.seq },
        cells: [cell],
      });
      continue;
    }
    if (cell.step !== undefined && cell.step > 0) pushStepGroup(cell.turn, cell.step, cell);
    else pushMessageGroup(cell.turn, cell);
  }

  /**
   * **显示序号按摊平顺序统一重编**（本扩展的既定不变量：摊平顺序 = 显示序号）。
   *
   * 官方那套 index 是在 `layoutEntryOrder()` 那一趟里递增的（初始提示词 `-Infinity` 先记 1），
   * 而输出侧还要按 `firstCellIndex` 重排轮次、prologue 再把 turn 0 的组拼进 turn 1——两趟的
   * 顺序可以不同，角落里的 `#N` 因此**不单调**（`turn 0` 压缩 + 前插初始行 + 第 2 轮助手那一
   * 组就是：系统行 1、它那一轮的后一条 3、被并入第 1 轮的压缩 2）。本扩展的差异清单里明确
   * 保住「初始提示词第一行、摊平顺序 = 显示序号」，所以**分组定稿之后**按摊平顺序再编一次。
   *
   * 它只改**显示序号**：源事件 `seq`、请求号、归属步骤都不动（`toolCells` / `subCells` 用的是
   * 折叠期的数组位置，也在这之前就用完了）；`cell.index` 的唯一性保证它照样能当行身份
   * （`trajectoryTimeline` 的 `byIndex` 与账本的 `data-cell-index` 都按它查）。
   */
  {
    let displayIndex = 0;
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const cell of group.cells) cell.index = ++displayIndex;
      }
    }
  }

  const totalSeconds = cells.reduce((sum, cell) => sum + (cell.timeSeconds ?? 0), 0);
  return {
    turns,
    // 请求表按开帧顺序入表，`number` 就是入表序号——已经是升序，不用再排。
    requests,
    cellCount: cells.length,
    totalSeconds,
    firstStartedAt: cells.find((cell) => cell.startedAt !== null)?.startedAt ?? null,
    hasOlder,
  };
}
