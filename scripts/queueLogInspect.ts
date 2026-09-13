/**
 * 队列错位取证：在真实会话日志里查「用户消息相对轮次边界的落盘位置」。
 *
 * 背景（用户 2026-09-14）：队列消息自动发出后「生成内容在用户消息上方继续生成」，
 * 随后普通发送的消息也跟着错位，且重开会话依旧。客户端折叠逻辑是一层，先把
 * **服务端落盘的 seq 顺序**钉下来——它才是权威时序。
 *
 * 对每条**真实用户输入**（source.kind = user / user-rpc）打印：
 *   seq、它前面最近的 turn/start|turn/end、它后面最近的 turn/start|turn/end
 * ——一眼看出「这条消息落在轮内还是轮间」。队列派发若发生在轮结束之前，
 * 消息就会出现在 turn/end **之前**（落在上一轮里）。
 *
 * 运行：npm run build:scripts && node build/queue-log-inspect.mjs [--ws <名称>] [--hours 6]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeSessionLog } from "./sessionLog";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
const args = process.argv.slice(2);
const onlyWs = args.includes("--ws") ? args[args.indexOf("--ws") + 1] : undefined;
const hours = args.includes("--hours") ? Number(args[args.indexOf("--hours") + 1]) : 8;
const since = Date.now() - hours * 3600_000;

interface Row {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, any>;
}

function readRows(file: string): Row[] | undefined {
  let text: string | undefined;
  try {
    text = decodeSessionLog(file);
  } catch {
    return undefined; // 日志还没落盘 / 文件名不同的会话直接跳过
  }
  if (!text) return undefined;
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      /* 半截行跳过 */
    }
  }
  return rows;
}

const at = (ms: number | undefined) => (ms ? new Date(ms).toLocaleTimeString("zh-CN", { hour12: false }) : "-");

const interesting = new Set(["turn/start", "turn/end", "step/start", "step/end", "assistant/message", "user/message"]);

// ---------- --replay <文本片段>：把命中会话的 durable 日志按 seq 序喂给适配器 ----------
//
// 验证「插话切分」对真实日志生效：出错的历史会话重开时走的就是这条重放路径，
// 折叠结果应当是「插话下方是新段 a:N:2，后续生成在那里」。
if (args.includes("--replay")) {
  const marker = args[args.indexOf("--replay") + 1] ?? "";
  const { SessionAdapter } = await import("../src/dsh/adapter");
  let replayed = false;
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    if (onlyWs && ws !== onlyWs) continue;
    let names: string[] = [];
    try {
      names = readdirSync(join(SESSIONS_ROOT, ws));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(SESSIONS_ROOT, ws, name, "session.v3.jsonl.zstd");
      const rows = readRows(file);
      if (!rows?.length) continue;
      const hit = rows.some((row) => {
        if (row.type !== "user/message" || (row.data?.source?.kind ?? "") !== "user") return false;
        const blocks = (row.data?.content ?? []) as { type?: string; text?: string }[];
        return blocks
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .includes(marker);
      });
      if (!hit) continue;
      replayed = true;
      console.log(`\n=== 重放 ${ws} / ${name}（命中 "${marker.slice(0, 30)}"） ===`);
      const adapter = new SessionAdapter(() => undefined);
      const durable = rows
        .filter((row) => typeof row.seq === "number")
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      for (const row of durable) adapter.applyEvent(row as never);
      for (const message of adapter.snapshotMessages()) {
        const first = message.segments.find((s) => s.kind === "text" || s.kind === "thinking") as
          | { kind: string; text?: string }
          | undefined;
        const preview = (first?.text ?? message.text ?? "").replace(/\s+/g, " ").slice(0, 48);
        const n = message.segments.length;
        console.log(`  ${message.id} (${message.role}, ${n} 段) "${preview}"`);
      }
    }
  }
  if (!replayed) console.log(`\n[replay] 没有找到含 "${marker}" 的会话`);
  process.exit(0);
}

for (const ws of readdirSync(SESSIONS_ROOT)) {
  if (onlyWs && ws !== onlyWs) continue;
  let names: string[] = [];
  try {
    names = readdirSync(join(SESSIONS_ROOT, ws));
  } catch {
    continue;
  }
  for (const name of names) {
    const file = join(SESSIONS_ROOT, ws, name, "session.v3.jsonl.zstd");
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue; // 日志文件还没写出来的会话
    }
    if (mtime < since) continue;
    const rows = readRows(file);
    if (!rows) continue;
    // 只看含真实用户输入的会话
    const userRows = rows.filter((r) => {
      if (r.type !== "user/message") return false;
      const kind = r.data?.source?.kind;
      return kind === "user" || kind === "user-rpc";
    });
    if (!userRows.length) continue;
    console.log(`\n=== ${ws} / ${name}（改于 ${at(mtime)}，真实用户消息 ${userRows.length} 条） ===`);
    // 轮次骨架：interesting 类型逐条打，真实用户消息高亮，注入类 user/message 折叠为一行摘要
    for (const row of rows) {
      if (!row.type || !interesting.has(row.type) || row.seq === undefined) continue;
      const time = at(row.time);
      if (row.type === "user/message") {
        const kind = row.data?.source?.kind ?? "?";
        const blocks = (row.data?.content ?? []) as { type?: string; text?: string }[];
        const text = blocks
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .replace(/\s+/g, " ")
          .slice(0, 60);
        const real = kind === "user" || kind === "user-rpc";
        const mark = real ? "★" : "·";
        console.log(`  ${mark} seq=${row.seq} ${time} user/message(${kind}) "${text}"`);
      } else if (row.type === "turn/start" || row.type === "turn/end") {
        console.log(`  ═ seq=${row.seq} ${time} ${row.type} turn=${row.data?.turn}`);
      } else if (row.type === "assistant/message") {
        console.log(`    seq=${row.seq} ${time} assistant/message turn=${row.data?.turn}`);
      } else {
        console.log(`    seq=${row.seq} ${time} ${row.type} turn=${row.data?.turn}`);
      }
    }
  }
}
