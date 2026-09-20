/**
 * 【探针定位】勘察型 · 零 token —— **纯离线**：只读 `~/.dsh/sessions` 下的真实会话
 * 日志，不连服务、不建会话、不发消息、不调用模型。可自由运行。
 *
 * 钉住「点目录上未加载的刻点 → 先取回该轮的用户消息 → 再落位」这条链路的**数据侧
 * 全链路**（用户 2026-09-20 报的「加载到位置了但视口没跳过去；目标在视口上方」）。
 *
 *   node build/rail-jump-probe.mjs [--session <id 片段>] [--limit 40] [--verbose]
 *
 * 为什么要有它：落位 effect（`src/webview/turnRailNav.ts`）的第一个判据是
 * `item.anchor.kind === "loaded"`。取完历史后该轮**若仍是 unloaded**，落位会直接早退，
 * 紧接着 `historyLoading: false` 到达时「放弃 effect」把 pendingJump 清掉——界面上就是
 * **视口一动不动**（= 用户看到的现象）。本探针判的就是它到底会不会变成 loaded。
 *
 * 复刻的部分（服务端在对面，只能按源码逐字抄，出处都在注释里）：
 *   - `paginate()`（`dsh-api-session-controller/src/history.ts:384-410`），含
 *     `isAppendSurfaceEvent`（`dsh-session/src/surface.ts:88-92`，类型集合在同文件 `:50-55`）；
 *   - `turnOutline` 投影的折叠（`dsh-session-turn-outline/src/projection.ts:90-132`，
 *     含它的 `preview()` `:36-59`）。
 * 其余全是产品自己的代码：`SessionAdapter`（`absorbRecords`/`settleHistory`）、
 * `shouldContinuePaging`、`mergeTurnRailItems`——与扩展跑的是同一份。
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { SessionAdapter } from "../src/dsh/adapter";
import { MAX_HISTORY_PAGES, shouldContinuePaging } from "../src/dsh/historyPaging";
import type { SessionHistoryRecord, SessionWireEvent } from "../src/dsh/protocol";
import { mergeTurnRailItems } from "../src/webview/turnRail";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const want = opt("--session");
const limit = Number(opt("--limit") ?? 40);
const verbose = args.includes("--verbose");

/** 跟随窗口与分页的条数（与扩展同值：`followSession` 60、`client.page` 50）。 */
const FOLLOW_MESSAGES = 60;
const PAGE_MESSAGES = 50;

// ---------------------------------------------------------------- 会话日志读取

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 追加写入的 zstd 文件是**多帧**的：只解第一帧会得到几条事件（踩过）。 */
function decodeSessionLog(path: string): string {
  const buffer = readFileSync(path);
  if (!path.endsWith(".zstd")) return buffer.toString("utf8");
  const offsets: number[] = [];
  let at = 0;
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    offsets.push(at);
    at += 4;
  }
  let text = "";
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[index], end)).toString("utf8");
    } catch {
      // 半截帧（进程被杀时最后一条）跳过
    }
  }
  return text;
}

function collectLogs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^session(\.v3)?\.jsonl(\.zstd)?$/.test(entry.name)) found.push(path);
    }
  };
  try {
    walk(root);
  } catch {
    // 没有目录就是没有会话
  }
  return found;
}

// ------------------------------------------------- 服务端行为复刻（逐字抄自 harness）

const SURFACE_EVENT_TYPES = new Set([
  "system/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);

/** `isAppendSurfaceEvent`：surface 事件里 `surfaceOp === 'append'` 的那些。 */
function isAppendSurfaceEvent(event: SessionWireEvent): boolean {
  return SURFACE_EVENT_TYPES.has(event.type) && (event as { surfaceOp?: string }).surfaceOp === "append";
}

/** `paginate()`：从 `beforeSeq` 往前数够 `maxMessages` 条消息切一刀。 */
function paginate(
  events: readonly SessionWireEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
  throughSeq: number = events.at(-1)?.seq ?? -1,
): { events: SessionWireEvent[]; hasMore: boolean } {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
  let count = 0;
  let cut = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionWireEvent;
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue;
    count += 1;
    const sources = (event as { sourceEventSeqs?: readonly number[] }).sourceEventSeqs;
    let groupStart = event.seq;
    if (sources !== undefined) for (const source of sources) if (source < groupStart) groupStart = source;
    if (count >= maxMessages) {
      cut = groupStart;
      break;
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 };
}

function pageRecords(events: readonly SessionWireEvent[]): SessionHistoryRecord[] {
  return events.map((event) => ({ type: "event", event }) as SessionHistoryRecord);
}

/** 投影的 `preview()`（`projection.ts:36-59`）：空格连接文本块、折叠空白、超限加省略号。 */
function preview(content: readonly { type?: string; text?: string }[], limit: number): string {
  let text = "";
  let unread = false;
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    if (text.length >= limit * 2) {
      unread = true;
      break;
    }
    const clipped = block.text.length > limit * 2;
    const chunk = clipped ? block.text.slice(0, limit * 2) : block.text;
    text += text === "" ? chunk : ` ${chunk}`;
    if (clipped) {
      unread = true;
      break;
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`;
  return unread ? `${normalized}…` : normalized;
}

type OutlineEntry = { turn: number; seq: number; prompt: string; response: string };

/** `turnOutline` 投影折叠（`projection.ts:90-132`）。 */
function foldOutline(events: readonly SessionWireEvent[]): OutlineEntry[] {
  const turns: OutlineEntry[] = [];
  let draft = "";
  for (const event of events) {
    const data = (event as { data?: Record<string, any> }).data ?? {};
    if (event.type === "turn/start") {
      const last = turns.at(-1);
      if (last !== undefined && Number(data.turn) <= last.turn) continue;
      turns.push({ turn: Number(data.turn), seq: event.seq, prompt: "", response: "" });
      draft = "";
    } else if (event.type === "user/message") {
      if (data.source?.kind !== "user") continue;
      const last = turns.at(-1);
      if (last === undefined || last.prompt !== "") continue;
      const prompt = preview(data.content ?? [], 50);
      if (prompt === "") continue;
      turns[turns.length - 1] = { ...last, prompt };
    } else if (event.type === "assistant/message") {
      const next = preview(data.message?.content ?? [], 120);
      if (next === "" || next === draft) continue;
      draft = next;
    } else if (event.type === "turn/end") {
      if (draft === "") continue;
      const last = turns.at(-1);
      if (last === undefined || last.response === draft) {
        draft = "";
        continue;
      }
      turns[turns.length - 1] = { ...last, response: draft };
      draft = "";
    }
  }
  return turns;
}

// ------------------------------------------------------------------- 单个会话推演

interface CaseResult {
  session: string;
  rounds: number;
  windowHead: string;
  pickTurn: number;
  pickSeq: number;
  pages: number;
  /** 取完历史后该轮是否变成 `loaded`。 */
  loaded: boolean;
  /** 锚点 id（loaded 时）。 */
  anchor: string | undefined;
  /** 锚点是否用户消息（`u:*`）。 */
  anchorIsUser: boolean;
  /** 锚点那条消息是否真的在消息流里（界面 `anchorElement` 找行的前提）。 */
  anchorInFlow: boolean;
  note: string;
}

function runCase(path: string): CaseResult | undefined {
  const text = decodeSessionLog(path);
  const events: SessionWireEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { event?: SessionWireEvent } & SessionWireEvent;
      events.push((parsed.event ?? parsed) as SessionWireEvent);
    } catch {
      // 坏行跳过
    }
  }
  if (events.length === 0) return undefined;

  const outline = foldOutline(events);
  const session = basename(dirname(path));

  // 1) 跟随开窗（maxMessages 60），喂给真实的适配器
  const adapter = new SessionAdapter(() => {});
  const first = paginate(events, undefined, FOLLOW_MESSAGES);
  const cursor = events.at(-1)?.seq ?? -1;
  adapter.applyFrame({
    type: "snapshot",
    cursor,
    hasMore: first.hasMore,
    records: pageRecords(first.events),
  } as never);

  const head = adapter.snapshotMessages()[0];
  const before = mergeTurnRailItems(adapter.snapshotMessages(), outline, adapter.hasMoreHistory());
  const pick = before.find((item) => item.anchor.kind === "unloaded" && item.prompt !== "");
  if (pick === undefined || pick.anchor.kind !== "unloaded") return undefined;

  const targetSeq = pick.anchor.seq;
  let pages = 0;
  const trail: string[] = [];
  for (;;) {
    const throughSeq = adapter.cursor();
    const beforeSeq = adapter.earliestSeq();
    if (throughSeq === undefined || beforeSeq === undefined) break;
    const page = paginate(events, beforeSeq, PAGE_MESSAGES, throughSeq);
    const added = adapter.absorbRecords(pageRecords(page.events), page.hasMore);
    pages += 1;
    const earliest = adapter.earliestSeq() ?? beforeSeq;
    if (verbose) {
      const seen = mergeTurnRailItems(
        adapter.snapshotMessages(),
        outline,
        adapter.hasMoreHistory(),
      ).find((item) => item.turn === pick.turn);
      trail.push(
        `      第 ${pages} 页：records=${page.events.length}、新并入 ${added}、` +
          `earliest=${earliest}（目标 ${targetSeq}）、hasMore=${page.hasMore}、` +
          `该轮 = ${seen?.anchor.kind ?? "缺失"}`,
      );
    }
    if (!shouldContinuePaging(added, page.hasMore, pages, { seq: targetSeq, earliest })) break;
    if (pages >= MAX_HISTORY_PAGES) break;
  }
  adapter.settleHistory();
  for (const line of trail) console.log(line);

  const after = mergeTurnRailItems(adapter.snapshotMessages(), outline, adapter.hasMoreHistory());
  const landed = after.find((item) => item.turn === pick.turn);
  const loaded = landed?.anchor.kind === "loaded";
  const anchor = loaded ? (landed?.anchor as { messageId: string }).messageId : undefined;
  const anchorInFlow =
    anchor !== undefined && adapter.snapshotMessages().some((message) => message.id === anchor);
  return {
    session,
    rounds: outline.length,
    windowHead: head === undefined ? "?" : `${head.role}:${head.id}`,
    pickTurn: pick.turn,
    pickSeq: targetSeq,
    pages,
    loaded,
    anchor,
    anchorIsUser: anchor?.startsWith("u:") === true,
    anchorInFlow,
    note: loaded ? "" : "取完仍是 unloaded → 落位会早退、pendingJump 被放弃 → 视口一动不动",
  };
}

// ------------------------------------------------------------------------ 主流程

const root = join(homedir(), ".dsh", "sessions");
const logs = collectLogs(root)
  .map((path) => ({ path, size: (() => { try { return readFileSync(path).length; } catch { return 0; } })() }))
  .filter((entry) => want === undefined || entry.path.includes(want))
  .sort((left, right) => right.size - left.size)
  .slice(0, want === undefined ? limit : 1);

console.log(`扫描 ${logs.length} 个会话日志（按体积从大到小）\n`);
const results: CaseResult[] = [];
for (const entry of logs) {
  try {
    const result = runCase(entry.path);
    if (result === undefined) continue;
    results.push(result);
    const flag = result.loaded && result.anchorIsUser && result.anchorInFlow ? "✓" : "✗";
    console.log(
      `${flag} ${result.session.slice(0, 12)}  轮 ${result.pickTurn}/${result.rounds}  ` +
        `窗口首条 ${result.windowHead}  取 ${result.pages} 页  ` +
        `→ ${result.loaded ? `loaded 锚点=${result.anchor}${result.anchorIsUser ? "" : "（非用户消息！）"}${result.anchorInFlow ? "" : "（不在消息流里！）"}` : "仍 unloaded"}  ${result.note}`,
    );
  } catch (error) {
    console.log(`! ${entry.path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

const good = results.filter((r) => r.loaded && r.anchorIsUser && r.anchorInFlow).length;
console.log(
  `\n合计 ${results.length} 个可推演会话：` +
    `取完历史后锚点落到**用户消息**且该行在消息流里 = ${good}/${results.length}`,
);
const stillUnloaded = results.filter((r) => !r.loaded);
if (stillUnloaded.length > 0) {
  console.log(
    `■ 仍 unloaded 的 ${stillUnloaded.length} 个：这正是「视口一动不动」的数据侧成因（落位早退）。`,
  );
}
const wrongAnchor = results.filter((r) => r.loaded && !r.anchorIsUser);
if (wrongAnchor.length > 0) {
  console.log(`■ 锚点退化成非用户消息的 ${wrongAnchor.length} 个：点击只会到该轮已加载的最早内容。`);
}
