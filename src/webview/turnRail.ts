/**
 * 右侧轮次横条（官方 Web UI 的 TurnNavigator）的数据层。
 *
 * 官方的横条吃两份来源（`dsh-client-ui-chat` 的 `turn-rail-items.ts`）：
 * **全日志的 `turnOutline` 投影**（没加载进窗口的轮次也在里面，这是「未加载的
 * 刻点也能跳——先取历史再落位」的依据）与**已加载窗口**自己折出的锚点与预览。
 * 本扩展的宿主早已把 `turnOutline` 投影原样下发（`shared/chat.ts`），这里在
 * 界面侧做同样的合并：
 *
 * - 大纲铺底：每一轮一枚刻点（`unloaded`，带 `turn/start` 的 seq）；
 * - 已加载窗口覆盖：从消息流里折出「这一轮的锚点行」与两段预览（`loaded`）。
 *   锚点是**该轮第一条助手消息上方最近的一条用户消息**（官方口径 `user ?? loaded[0]`；
 *   本扩展的用户消息 id 是 `u:<seq>`、助手消息是 `a:<turn>`，插话切分的第二段是
 *   `a:<turn>:<part>`，恰好足够还原官方的归属关系）。**大纲在场时已加载轮次必须
 *   被它确认**——本地消息流里存在首个 `turn/start` 之前拼出来的幻影轮 `a:0`
 *   （斜杠命令行 / 系统提示词注入），拿大纲当轮次边界的权威正好把它挡掉。
 *
 * **「部分加载」的轮次不退化**：窗口按消息条数切，切点常落在某轮的助手消息上（一轮里
 * 助手消息比用户消息多一个数量级），于是窗口第一轮的用户消息不在窗口里。这类轮次的
 * 锚点**不许**退化成该轮第一条助手消息——那会让刻点看着「已加载」，点击却只落到该轮
 * 已加载的最早内容，永远到不了用户消息处。它们按「未加载」呈现，点击时先取回用户消息
 * 再落位（见 `mergeTurnRailItems` 里的判据）。
 *
 * 纯函数、不引 react：断言见 `scripts/turnRail.test.ts`。
 */

import type { MessageView } from "../shared/chat";

/** 横条上的一枚刻点。 */
export interface TurnRailItem {
  /** 轮号（服务端从 0 起）。 */
  turn: number;
  /** 提示词预览（有界）：已加载窗口优先，空了退回大纲那份。 */
  prompt: string;
  /** 响应预览（有界）：同上。 */
  response: string;
  /** 怎么到达这一轮：已加载 → 滚到锚点行；未加载 → 先取历史。 */
  anchor: { kind: "loaded"; messageId: string } | { kind: "unloaded"; seq: number };
  /**
   * 窗口里**看得见**的这一轮的行（只用于「阅读线上是哪一轮」的命中测试）。
   *
   * 只有「部分加载」的轮次带它：那时跳转锚点是 `unloaded`（用户消息还没取回来），
   * 但该轮的助手消息确实在窗口里——不记下来的话，读者滚到这一轮时命中测试找不到它，
   * 横条会把激活轮点亮成前一轮。
   */
  visibleMessageId?: string;
}

/** 提示词预览的字符上限（与官方 `turnOutline` 投影的 preview() 同口径）。 */
const PROMPT_PREVIEW_LIMIT = 50;
/** 响应预览的字符上限（同上）。 */
const RESPONSE_PREVIEW_LIMIT = 120;

/**
 * 折叠空白并按上限截断（超长带省略号）。
 *
 * 与官方 preview() 同一条性质：**先截原始文本再折叠**——一段没有空白的长文本
 * 不能整段做过正则（每次结构化更新都会跑到这里）。
 */
function preview(text: string, limit: number): string {
  if (text.length > limit * 2) text = text.slice(0, limit * 2);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`;
  return normalized;
}

/**
 * 助手消息 id 里的轮号与段号：`a:5` → `{ turn: 5, part: 1 }`；
 * `a:5:2`（插话切分的第二段）→ `{ turn: 5, part: 2 }`；其余 id → undefined。
 */
function assistantTurnPart(id: string): { turn: number; part: number } | undefined {
  const match = /^a:(\d+)(?::(\d+))?$/.exec(id);
  if (!match) return undefined;
  return { turn: Number(match[1]), part: match[2] === undefined ? 1 : Number(match[2]) };
}

/** 消息里**最后一段**非空正文（响应预览取它——官方 findLast(有正文的节点)）。 */
function lastTextOf(message: MessageView | undefined): string {
  if (!message) return "";
  for (let index = message.segments.length - 1; index >= 0; index--) {
    const segment = message.segments[index];
    if (segment.kind === "text" && segment.text.trim() !== "") return segment.text;
  }
  return "";
}

/**
 * 已加载窗口里的轮次归属。走一遍消息流（展示顺序）：
 * - 用户消息记为「待归属」；
 * - 首段助手消息（`a:<turn>`）收编它当锚点；插话切分段（`a:<turn>:<n>`）不收编
 *   新锚点——它上方的用户消息是**同轮插话**，属于这一轮而不是下一轮的提问；
 * - 响应预览取该轮**最后一条有正文**的助手消息（流式中最后一段还没字时退回前段）。
 */
interface LoadedTurn {
  anchorMessageId?: string;
  /** 该轮最后一条助手消息（可能被插话切成多段；预览不用它）。 */
  lastAssistantId?: string;
  /** 该轮最后一条**有正文**的助手消息（响应预览的来源）。 */
  lastTextAssistantId?: string;
}

function collectLoadedTurns(messages: readonly MessageView[]): Map<number, LoadedTurn> {
  const turns = new Map<number, LoadedTurn>();
  let pendingUser: string | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message.id;
      continue;
    }
    const parsed = assistantTurnPart(message.id);
    if (!parsed) continue;
    const entry = turns.get(parsed.turn) ?? {};
    // 锚点取「第一条用户消息」（官方 user ?? loaded[0] 的 user 分支）；
    // 整轮没有用户消息时（兜底）落在该轮第一条助手消息上。
    if (entry.anchorMessageId === undefined && pendingUser !== undefined) {
      entry.anchorMessageId = pendingUser;
    }
    if (parsed.part === 1 && entry.lastAssistantId === undefined) {
      entry.lastAssistantId = message.id;
    }
    if (lastTextOf(message) !== "") entry.lastTextAssistantId = message.id;
    turns.set(parsed.turn, entry);
    // 这条用户消息已被本轮消费——绝不能让下一轮把别人的插话认成自己的提问
    pendingUser = undefined;
  }
  return turns;
}

/** 两份刻点是否同内容（用于合并时保引用稳定，见 `useTurnRailItems`）。 */
export function sameTurnRailItem(left: TurnRailItem, right: TurnRailItem): boolean {
  if (left.turn !== right.turn || left.prompt !== right.prompt || left.response !== right.response) {
    return false;
  }
  if (left.visibleMessageId !== right.visibleMessageId) return false;
  if (left.anchor.kind !== right.anchor.kind) return false;
  return left.anchor.kind === "loaded"
    ? left.anchor.messageId === (right.anchor as { messageId: string }).messageId
    : left.anchor.seq === (right.anchor as { seq: number }).seq;
}

/**
 * 合并大纲与已加载窗口，按轮号升序返回全部刻点。
 *
 * 官方同序：**已加载窗口的预览优先**（它跟着流式实时长），空了退回大纲那份
 * （窗口头部缺 `step/start` 的轮次、或投影还没跟上的轮次，用装饰预览兜着）。
 *
 * **已加载轮次必须被大纲确认**（大纲在场时）：服务端从 1 起编轮号（harness
 * 自家投影 spec 的第一轮就是 `turn/start {turn: 1}`），而本地消息流里存在
 * **幻影轮 0**——首个 `turn/start` 之前到达的斜杠命令行 / 系统提示词注入会被
 * 适配器拼进 `a:0`（`currentTurn ?? 0` 的兜底）。每个**真实**轮都有
 * `turn/start` ⟹ 都在大纲里；拿大纲当轮次边界的权威，幻影轮自然被挡掉。
 * 大纲缺席（老服务端没挂投影）才退回「只看已加载窗口」。
 *
 * 已知代价：新一轮开始的那一刻，大纲的增量帧可能比消息晚一拍——新刻点晚
 * 一帧出现（同一股流，自愈，不影响跳转：跳转目标的历史轮大纲早就有了）。
 */
export function mergeTurnRailItems(
  messages: readonly MessageView[],
  outline:
    | readonly { turn: number; seq: number; prompt: string; response: string }[]
    | undefined,
  /** 服务端是否还有更早的记录（决定「部分加载」的轮次能否被取回来，见下方判据）。 */
  hasMoreHistory = false,
): TurnRailItem[] {
  const byTurn = new Map<number, TurnRailItem>();
  const outlinePresent = outline !== undefined;
  // 大纲铺底。`turn`/`seq` 是承重字段（没有它们刻点画不出也跳不了），坏了整条丢弃；
  // 预览只是装饰，类型不对退化成空串——容忍度与官方 `outlineEntry` 同口径。
  for (const entry of outline ?? []) {
    if (!Number.isSafeInteger(entry.turn) || entry.turn < 0) continue;
    if (!Number.isSafeInteger(entry.seq) || entry.seq < 0) continue;
    byTurn.set(entry.turn, {
      turn: entry.turn,
      prompt: typeof entry.prompt === "string" ? entry.prompt : "",
      response: typeof entry.response === "string" ? entry.response : "",
      anchor: { kind: "unloaded", seq: entry.seq },
    });
  }
  const loaded = collectLoadedTurns(messages);
  const messageById = new Map(messages.map((message) => [message.id, message] as const));
  for (const [turn, entry] of loaded) {
    // 大纲在场却没这一轮 = 本地拼出来的幻影轮（见上），整轮丢弃
    if (outlinePresent && !byTurn.has(turn)) continue;
    const anchor = entry.anchorMessageId ?? entry.lastAssistantId;
    if (anchor === undefined) continue;
    const previous = byTurn.get(turn);
    // **部分加载的轮次不许把锚点退化成助手消息**。
    //
    // 跟随窗口按**消息条数**切（`maxMessages: 60`），而一轮里助手消息比用户消息多一个
    // 数量级（本机实测 1125 : 109），所以切点十有八九落在某轮的助手消息上——窗口第一轮
    // 的用户消息于是不在窗口里。此前这种轮次会被标成 `loaded` 且锚点退化成 `a:<turn>`：
    // 刻点看着是「已加载」，点击只落到该轮**已加载的最早内容**，永远到不了用户消息处
    // （用户 2026-09-20 报的正是这个，而且它是常态不是边界）。
    //
    // 判据：大纲说这轮有提示词（= 全日志里该轮确有 `user/message`），而已加载窗口里
    // 找不到它 → 保持大纲那条 `unloaded`，点击时走「到目标档」把用户消息取回来。
    // 宿主取到 `earliestSeq <= 该轮 turn/start 的 seq` 就停，而用户消息的 seq 在其
    // **之后**，所以覆盖到 `turn/start` 必然覆盖到用户消息（`shared/ipc.ts` 的
    // `loadMore.targetSeq`）。
    //
    // 只有「还有更早的历史可取」时才这么标：`hasMoreHistory === false` 说明窗口已经
    // 到日志开头，那这轮是真的没有用户消息（自动轮 / 纯注入），只能退化到助手消息。
    if (
      entry.anchorMessageId === undefined &&
      (previous?.prompt ?? "") !== "" &&
      hasMoreHistory
    ) {
      // 跳转锚点保持大纲那条 `unloaded`，但把窗口里看得见的那行记给命中测试用
      // （否则读者滚到这一轮时激活轮会点亮成前一轮）
      if (previous !== undefined) byTurn.set(turn, { ...previous, visibleMessageId: anchor });
      continue;
    }
    const prompt = preview(
      messageById.get(entry.anchorMessageId ?? "")?.text ?? "",
      PROMPT_PREVIEW_LIMIT,
    );
    const response = preview(
      lastTextOf(messageById.get(entry.lastTextAssistantId ?? "")),
      RESPONSE_PREVIEW_LIMIT,
    );
    byTurn.set(turn, {
      turn,
      prompt: prompt !== "" ? prompt : previous?.prompt ?? "",
      response: response !== "" ? response : previous?.response ?? "",
      anchor: { kind: "loaded", messageId: anchor },
    });
  }
  if (byTurn.size === 0) return [];
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn);
}

/**
 * 横条的**用户消息数**：带提示词预览的轮数。
 *
 * 大纲的 `prompt` 只从人类的 `user/message`（`source.kind === 'user'` 且非空）
 * 折出来——自动轮（goal 驱动、纯注入）没有提示词，不计入。这就是显示判据
 * 「用户消息 ≥ 2 才显示横条」里的那个数：一条消息的会话没有任何可导航的东西，
 * 横条只是右缘的噪音。已加载与未加载的轮都算（窗口外的大纲预览同样有提示词）。
 */
export function userPromptCount(items: readonly TurnRailItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.prompt !== "") count += 1;
  }
  return count;
}

/** 已加载锚点的 messageId → turn 索引（滚动命中测试用）。 */
export function anchorTurnIndex(items: readonly TurnRailItem[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const item of items) {
    if (item.anchor.kind === "loaded") index.set(item.anchor.messageId, item.turn);
    // 「部分加载」的轮次：跳转锚点是未加载，但内容已经在窗口里，激活轮要认得出它
    if (item.visibleMessageId !== undefined) index.set(item.visibleMessageId, item.turn);
  }
  return index;
}

/** 在消息列表里找锚点行（不做选择器插值，逐行比 dataset）。 */
export function anchorElement(list: HTMLElement, messageId: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    if (row.dataset.msgId === messageId) return row;
  }
  return null;
}

/** 行顶在滚动区坐标系里的位置（视口无关）。 */
export function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
}

/**
 * 阅读线上落着哪一轮。消息行按文档序扫，读到行下方的**最后一条**有归属的行
 * ——读在助手消息正中间时，它上方那条用户消息的轮号就是当前轮。
 * `null` = 还没有任何已加载的行够到阅读线（窗口头部还空着）。
 */
export function turnAtLine(
  list: HTMLElement,
  line: number,
  anchors: ReadonlyMap<string, number>,
): number | null {
  let found: number | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    if (row.getBoundingClientRect().top > line) break;
    const turn = anchors.get(row.dataset.msgId ?? "");
    if (turn !== undefined) found = turn;
  }
  return found;
}
