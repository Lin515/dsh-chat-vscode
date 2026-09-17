/**
 * 「事件顺序 vs 渲染顺序」探针。
 *
 * 现场（用户 2026-09-14 报的）：连续工具调用里，助手说过的中间话（正文）与思考
 * 会**错位**——DSH Web 上是「思考 → 4 次编辑 → 正文 → 编辑…」，本扩展却把某条
 * 工具行排到了那段正文前面。
 *
 * 这个探针把**真实会话日志**按 seq 顺序喂给 `SessionAdapter`，并把两条线并排打出来：
 *   1. 原始事件（seq / type / turn / step / 一句话摘要），**按 seq 排成一列**；
 *   2. 适配器折出来的段（索引 / 种类 / step / 摘要）。
 * 一比就知道是「服务端就这么发的」还是「我们折错了」。
 *
 * 用法：
 *   npm run build:scripts
 *   node build/render-order-probe.mjs                       # 本工作区最新的会话、最后一轮
 *   node build/render-order-probe.mjs --session 96cc413a    # 指定会话（id 片段即可）
 *   node build/render-order-probe.mjs --turn 3              # 指定轮次
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import { decodeSessionLog, type SessionLogRow } from "./sessionLog";
import { DEFAULT_TURN_PROCESS_THRESHOLD } from "../src/shared/turnProcessThreshold";
import { foldTurnProcess } from "../src/webview/turnProcess";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const onlySession = opt("--session");
const onlyTurn = opt("--turn") ? Number(opt("--turn")) : undefined;
const workspace = opt("--ws") ?? "--d-dev-dsh-chat--";

/** 一句话摘要：够认出「这条是哪个工具 / 哪段话」。 */
function summarize(row: SessionLogRow): string {
  const data = row.data ?? {};
  switch (row.type) {
    case "turn/start":
      return `turn=${data.turn}`;
    case "turn/end":
      return `turn=${data.turn} reason=${JSON.stringify(data.reason?.kind ?? data.reason)}`;
    case "step/start":
      return `turn=${data.turn} step=${data.step}`;
    case "step/end":
      return `step=${data.step}`;
    case "assistant/message": {
      const content = (data.message?.content ?? []) as { type?: string; text?: string; name?: string }[];
      const shape = content
        .map((block) => {
          if (block.type === "reasoning") return `★reasoning(${(block.text ?? "").slice(0, 20).replace(/\n/g, " ")})`;
          if (block.type === "text") return `★text(${(block.text ?? "").slice(0, 24).replace(/\n/g, " ")})`;
          if (block.type === "tool-call") return `tool-call(${block.name ?? "?"})`;
          return String(block.type);
        })
        .join(" + ");
      return `turn=${data.turn} step=${data.step} [${shape}]`;
    }
    case "tool/call":
      return `callId=${data.callId} name=${data.name} args=${String(data.arguments ?? "").slice(0, 48).replace(/\n/g, " ")}`;
    case "tool/result":
      return `callId=${data.message?.source?.callId ?? "?"} ${data.message?.error ? "ERROR" : "ok"}`;
    case "user/message":
      return `source=${data.source?.kind} text=${JSON.stringify(String(data.content?.[0]?.text ?? "").slice(0, 40))}`;
    default:
      return "";
  }
}

/** 段摘要。 */
function segmentLabel(segment: { kind: string; step?: number; [key: string]: any }): string {
  switch (segment.kind) {
    case "text":
      return `text(step=${segment.step}) ${JSON.stringify(String(segment.text ?? "").slice(0, 36).replace(/\n/g, " "))}`;
    case "thinking":
      return `thinking(step=${segment.step}) ${JSON.stringify(String(segment.text ?? "").slice(0, 28).replace(/\n/g, " "))}`;
    case "tool":
      return `tool(step=${segment.step}) ${segment.tool?.name} ${String(segment.tool?.detail ?? "").slice(-30)} [${segment.tool?.status}]${segment.tool?.error ? " ⚠" : ""}`;
    case "notice":
      return `notice(step=${segment.step}) ${segment.text}`;
    default:
      return `${segment.kind}(step=${segment.step})`;
  }
}

function loadRows(): { dir: string; rows: SessionLogRow[] } {
  const root = join(SESSIONS_ROOT, workspace);
  const candidates = readdirSync(root)
    .map((name) => ({ name, file: join(root, name, "session.v3.jsonl.zstd") }))
    .filter((item) => {
      try {
        statSync(item.file);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs);
  const picked = onlySession ? candidates.find((item) => item.name.includes(onlySession)) : candidates[0];
  if (!picked) throw new Error(`没找到会话（workspace=${workspace}）`);
  const text = decodeSessionLog(picked.file);
  if (!text) throw new Error(`解不出日志：${picked.file}`);
  const rows: SessionLogRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as SessionLogRow);
    } catch {
      // 半截行跳过
    }
  }
  return { dir: picked.name, rows };
}

const { dir, rows } = loadRows();
const turns = rows.filter((row) => row.type === "turn/start").map((row) => Number(row.data?.turn ?? 0));
const turn = onlyTurn ?? turns.at(-1) ?? 0;
console.log(`会话：${dir}`);
console.log(`事件 ${rows.length} 条；轮次 ${turns.join(", ")}；本次看 turn=${turn}`);

// 该轮的 seq 区间：turn/start → 下一个 turn/start（含）之前
const startSeq = rows.find((row) => row.type === "turn/start" && Number(row.data?.turn) === turn)?.seq ?? 0;
const nextTurnSeq =
  rows.find((row) => row.type === "turn/start" && Number(row.data?.turn) > turn)?.seq ?? Infinity;

console.log(`\n=== 原始事件（seq ${startSeq}..${nextTurnSeq === Infinity ? "末尾" : nextTurnSeq - 1}）===`);
for (const row of rows) {
  const seq = row.seq ?? 0;
  if (seq < startSeq || seq >= nextTurnSeq) continue;
  const text = summarize(row);
  if (!text) continue;
  console.log(`  seq=${String(seq).padStart(4, " ")} ${row.type?.padEnd(18, " ")} ${text}`);
}

// 把整份日志喂给适配器，看它折出什么顺序
const adapter = new SessionAdapter(() => {});
for (const row of rows) {
  if (!row.type || row.type === "session") continue;
  adapter.applyEvent(row as never);
}
const messages = adapter.snapshotMessages();
const target = [...messages]
  .reverse()
  .find((message) => message.id === `a:${turn}` || message.id.startsWith(`a:${turn}:`));
console.log(`\n=== 适配器折出的段顺序（${target?.id ?? "没找到该轮消息"}）===`);
if (target) {
  target.segments.forEach((segment, index) => {
    console.log(`  [${String(index).padStart(2, " ")}] ${segmentLabel(segment as never)}`);
  });
}

// 连续过程折叠的实算：真实一轮会折出几枚按钮、有多少工具行留在外面。
// 阈值口径见 `src/shared/turnProcessThreshold.ts`（默认 5；0 = 永不折，
// 1–2 = 永远折但仅 1 次工具调用的段平铺）。
if (target) {
  const fold = foldTurnProcess(target.segments, true);
  const foldedTools = fold.runs.reduce(
    (sum, run) => sum + run.counts.toolCalls + run.counts.subagents,
    0,
  );
  const toolRows = target.segments.filter((segment) => segment.kind === "tool").length;
  console.log(
    `\n=== 连续过程折叠（默认阈值 ${DEFAULT_TURN_PROCESS_THRESHOLD}）===`,
  );
  console.log(
    `  段 ${target.segments.length} 个（工具 ${toolRows} 行）→ 按钮 ${fold.runs.length} 枚，折进去 ${foldedTools} 次工具调用，留在外面 ${toolRows - foldedTools} 行`,
  );
  fold.runs.forEach((run, index) => {
    console.log(
      `  [按钮 ${index + 1}] 段 #${target.segments.findIndex((segment) => segment.id === run.anchorId)} 起，成员 ${run.segments.length} 段 = 工具 ${run.counts.toolCalls} + subagent ${run.counts.subagents}`,
    );
  });
}
