/**
 * 【探针定位】工具型 · 零 token —— 只读本机会话日志离线回放，不连服务端、不发消息。
 *
 * 轮尾三样（改动文件卡片 / 本轮文件改动 / 交付文件）的分布体检。
 *
 * 背景（用户 2026-09-21 报告）：打开以前的会话时，一轮尾部经常同时出现卡片、
 * 「本轮文件改动」与「交付文件」三样；而把整份历史加载完之后，后两样有时又不见了。
 * 三者本该分工明确，所以这里把真实日志离线折两遍，回答两件事：
 *
 *  1. **同一轮次**里三种数据分别落在哪几条消息上——轮被插话切成多段时（id 形如
 *     `a:N`、`a:N:2`…），卡片挂在最后一段、而 `produced` / `deliverables` 挂在
 *     其各自发生的那一段，界面上就是「一轮尾部好几样并排」；
 *  2. 首帧（只带最近 N 条）与「加载全部历史」（`prependRecords` + 重折）两条路径下，
 *     同一条消息的 `produced` / `deliverables` 是否变化——用户观察到的
 *     「翻页后本轮改动没了」。
 *
 * 用法：
 *   npm run build:scripts
 *   node build/tail-rows-probe.mjs --ws --d-dev-dsh-chat-- --all   # 该工作区全部会话（汇总）
 *   node build/tail-rows-probe.mjs --session 1e2690c9              # 指定会话（详列）
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import { decodeSessionLog } from "./sessionLog";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
const args = process.argv.slice(2);
const value = (name: string): string | undefined =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const onlySession = value("--session");
const onlyWs = value("--ws");
const all = args.includes("--all");

/** 首帧带多少条（`session/follow` 的真实窗口量级）；其余靠 `session/page` 往前翻。 */
const TAIL = 60;

interface Row {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, any>;
}

function logs(): { file: string; name: string }[] {
  const out: { file: string; name: string; mtime: number }[] = [];
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    if (onlyWs && ws !== onlyWs) continue;
    for (const name of readdirSync(join(SESSIONS_ROOT, ws))) {
      if (onlySession && !name.includes(onlySession)) continue;
      const file = join(SESSIONS_ROOT, ws, name, "session.v3.jsonl.zstd");
      try {
        out.push({ file, name, mtime: statSync(file).mtimeMs });
      } catch {
        // 没有日志文件：跳过
      }
    }
  }
  out.sort((left, right) => right.mtime - left.mtime);
  return out;
}

function readEvents(file: string): Row[] {
  const text = decodeSessionLog(file);
  if (!text) return [];
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      if (typeof row.seq === "number" && typeof row.type === "string") rows.push(row);
    } catch {
      // 半截行（写到一半被杀）跳过
    }
  }
  rows.sort((left, right) => (left.seq as number) - (right.seq as number));
  return rows;
}

interface Shape {
  id: string;
  turn: string;
  streaming: boolean;
  produced: number;
  deliverables: number;
  changes?: string;
}

function shapeOf(messages: readonly any[]): Shape[] {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      id: String(message.id),
      // `a:12:2` → 轮 12（第二段）
      turn: String(message.id).replace(/^a:/, "").split(":")[0]!,
      streaming: Boolean(message.streaming),
      produced: message.produced?.length ?? 0,
      deliverables: message.deliverables?.length ?? 0,
      changes: message.changes ? `seq=${message.changes.seq}` : undefined,
    }));
}

function foldAll(events: readonly Row[]): Shape[] {
  const adapter = new SessionAdapter(() => {});
  // 走 `applyFrame` 而不是 `applyEvent`：前者才会 `remember(event)`（进 `seen`），
  // 而「加载更早」的重折只认 `seen`——直接 applyEvent 会让重折后只剩 prepend 进来的
  // 那一段（探针第一版就是这么误报出「交付与卡片丢失」的）。
  for (const event of events) adapter.applyFrame({ type: "event", event } as never);
  return shapeOf(adapter.snapshotMessages());
}

function foldPaged(events: readonly Row[]): { first: Shape[]; after: Shape[] } {
  const adapter = new SessionAdapter(() => {});
  const tail = events.slice(-TAIL);
  // 首帧按真实形状给：`session/follow` 的 snapshot 帧（records + hasMore），
  // 适配器会 refold 一遍——与线上同一条路径。
  adapter.applyFrame({
    type: "snapshot",
    header: { version: 3, id: "probe", createdAt: 0 },
    cursor: (tail[tail.length - 1]?.seq as number) ?? 0,
    records: tail.map((event) => ({ type: "event", event })),
    hasMore: events.length > tail.length,
    projections: { asOfSeq: 0, values: {} },
  } as never);
  const first = shapeOf(adapter.snapshotMessages());
  // 往上翻：把更早的历史并进来，适配器整体重折
  adapter.prependRecords(
    events.slice(0, Math.max(0, events.length - TAIL)).map((event) => ({ type: "event", event })) as never,
    false,
  );
  return { first, after: shapeOf(adapter.snapshotMessages()) };
}

const targets = logs();
if (!targets.length) {
  console.log("没找到匹配的会话日志（--session / --ws 过滤太严？）");
  process.exit(0);
}

// `--keys`：每种事件类型的 data 键 + 是否带数字 turn —— 判断「轮号归位」能不能
// 依赖事件自带的 turn（见 adapter 里 applyEvent 的归位分支）。
if (args.includes("--keys")) {
  const seen = new Map<string, { count: number; keys: Set<string>; turn: number }>();
  for (const target of targets.slice(0, all ? targets.length : 1)) {
    for (const event of readEvents(target.file)) {
      const entry = seen.get(event.type!) ?? { count: 0, keys: new Set<string>(), turn: 0 };
      entry.count += 1;
      for (const key of Object.keys(event.data ?? {})) entry.keys.add(key);
      if (typeof (event.data ?? {}).turn === "number") entry.turn += 1;
      seen.set(event.type!, entry);
    }
  }
  for (const [type, entry] of [...seen.entries()].sort()) {
    console.log(
      `${type.padEnd(34)} n=${String(entry.count).padStart(5)} turn=${String(entry.turn).padStart(5)} keys=${[...entry.keys].join(",")}`,
    );
  }
  process.exit(0);
}

// `--trace`：逐条重放，并在交付 / 改动宣告事件到达时打印「挂到了哪条消息上」。
// 用来定位「同一条内容在首帧与全量两条折叠路径下落点不同」。
if (args.includes("--trace")) {
  for (const target of targets.slice(0, all ? targets.length : 1)) {
    const events = readEvents(target.file);
    console.log(`\n=== ${target.name}`);
    const adapter = new SessionAdapter(() => {});
    for (const event of events) {
      adapter.applyFrame({ type: "event", event } as never);
      if (event.type === "deliverables/presented" || event.type === "workspace/changes" || event.type === "turn/start") {
        const shapes = shapeOf(adapter.snapshotMessages());
        console.log(
          `  seq=${String(event.seq).padStart(5)} ${event.type.padEnd(22)} data.turn=${String(event.data?.turn)} → ${shapes
            .map((s) => `${s.id}(改动${s.produced},交付${s.deliverables},卡片${s.changes ?? "-"})`)
            .join("  ")}`,
        );
      }
    }
  }
  process.exit(0);
}

const list = all ? targets : targets.slice(0, 1);
let sessionsWithChanges = 0;
let turnsWithCardAndProduced = 0;
let turnsSplitAcrossMessages = 0;
let changedSessions = 0;
let vanishedMessages = 0;
const details: string[] = [];

for (const target of list) {
  const events = readEvents(target.file);
  if (!events.length) continue;
  const changesEvents = events.filter((row) => row.type === "workspace/changes").length;

  const allShapes = foldAll(events);
  const byTurn = new Map<string, Shape[]>();
  for (const item of allShapes) {
    const bucket = byTurn.get(item.turn) ?? [];
    bucket.push(item);
    byTurn.set(item.turn, bucket);
  }

  const notes: string[] = [];
  for (const [turn, items] of byTurn) {
    const withProduced = items.filter((item) => item.produced > 0);
    const withCard = items.filter((item) => item.changes);
    const withDeliverables = items.filter((item) => item.deliverables > 0);
    if (!withCard.length) continue;
    if (withProduced.length) {
      turnsWithCardAndProduced += 1;
      // 卡片与「本轮改动」落在**不同消息**上 = 界面上一定同时出现（互斥判据是按消息的）
      const split =
        withProduced.some((item) => !item.changes) && withCard.some((item) => item.produced === 0);
      if (split) turnsSplitAcrossMessages += 1;
      notes.push(
        `轮 ${turn}：改动行 [${withProduced.map((i) => i.id).join(",")}]｜卡片 [${withCard.map((i) => i.id).join(",")}]｜交付 [${withDeliverables.map((i) => i.id).join(",") || "-"}]${split ? "  ← 跨消息（会同时出现）" : ""}`,
      );
    }
  }

  const { first, after } = foldPaged(events);
  const before = new Map(first.map((item) => [item.id, item]));
  const diffs: string[] = [];
  for (const item of after) {
    const prev = before.get(item.id);
    if (!prev) continue;
    if (prev.produced !== item.produced || prev.deliverables !== item.deliverables || prev.changes !== item.changes) {
      diffs.push(
        `${item.id}: 改动行 ${prev.produced}→${item.produced}｜交付 ${prev.deliverables}→${item.deliverables}｜卡片 ${prev.changes ?? "-"}→${item.changes ?? "-"}`,
      );
    }
  }
  const gone = first.filter((item) => !after.some((other) => other.id === item.id));
  if (diffs.length || gone.length) {
    changedSessions += 1;
    vanishedMessages += gone.length;
    notes.push(
      `翻页对拍：${diffs.length} 条消息数据变化；${gone.length} 条消息消失${gone.length ? `（${gone.map((g) => g.id).join(",")}）` : ""}`,
    );
    for (const line of diffs.slice(0, 5)) notes.push(`    ${line}`);
  }

  if (changesEvents) sessionsWithChanges += 1;
  if (!all) {
    for (const item of first) {
      notes.push(
        `[首帧] ${item.id}（轮 ${item.turn}）改动行 ${item.produced}｜交付 ${item.deliverables}｜卡片 ${item.changes ?? "-"}`,
      );
    }
    for (const item of after) {
      notes.push(
        `[全量] ${item.id}（轮 ${item.turn}）改动行 ${item.produced}｜交付 ${item.deliverables}｜卡片 ${item.changes ?? "-"}`,
      );
    }
  }
  if (notes.length) details.push(`\n=== ${target.name}（${events.length} 事件；workspace/changes ${changesEvents} 条）\n  ${notes.join("\n  ")}`);
}

console.log(`扫了 ${list.length} 个会话；含 workspace/changes 的 ${sessionsWithChanges} 个`);
console.log(`「本轮改动」与卡片同轮且跨消息（界面上必然同时出现）：${turnsSplitAcrossMessages} 个轮次`);
console.log(`「本轮改动」与卡片同轮（含同消息，界面按消息互斥）：${turnsWithCardAndProduced} 个轮次`);
console.log(`首帧 vs 全量有差异的会话：${changedSessions} 个（消失消息合计 ${vanishedMessages} 条）`);
for (const block of details.slice(0, 12)) console.log(block);
if (details.length > 12) console.log(`\n…还有 ${details.length - 12} 个会话有类似情况`);
