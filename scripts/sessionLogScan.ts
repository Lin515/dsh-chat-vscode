/**
 * 会话日志体检：直接读本机 `~/.dsh/sessions/**` 里的会话日志，回答「服务端到底
 * 认为这个会话是什么状态」这类问题。
 *
 * 为什么需要它：客户端看到的只是投影的**结果**，吵架时没有第三方证据。
 * 「有个目标一直卡在界面上」那次（2026-09-12），就是靠它确定的：
 *
 * ```
 * seq=3800 command/run  name=goal args=" clear"  source={kind:user}
 * seq=3801 goal/change  operation=clear  →  "Goal cleared."
 * seq=3803 command/run  name=goal args=" pause"  →  error: No goal is currently set
 * ```
 *
 * —— 服务端早已清掉，界面却没更新；根因在宿主 → webview 的 JSON 过线丢 undefined
 * （见 `src/shared/wire.ts`）。没有这份日志，很容易误判成「服务端没清干净」。
 *
 * 两个实现要点：
 * 1. 会话日志是 `session.v3.jsonl.zstd`，**多帧** zstd（每次追加一个 frame）。
 *    Node 的 `zstdDecompressSync` / `createZstdDecompress` 只解第一帧（拿到的
 *    是那行 session 头），所以这里按帧魔数切开逐帧解码再拼起来。
 * 2. 帧魔数 `28 B5 2F FD` 可能出现在压缩数据里，因此切点要往后试到能解码为止。
 *
 * 用法：
 *   npm run build:scripts
 *   node build/session-log-scan.mjs                       # 列出所有带 goal 事件的会话
 *   node build/session-log-scan.mjs --ws --d-dev-dsh-chat--   # 只看某个工作区
 *   node build/session-log-scan.mjs --session 24d26055-...    # 看某个会话的 goal 记录与尾部
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");

/** 多帧 zstd → 整份 jsonl 文本。解不出来返回 undefined。 */
export function decodeSessionLog(file: string): string | undefined {
  const buf = readFileSync(file);
  const offsets: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      offsets.push(i);
    }
  }
  if (!offsets.length || offsets[0] !== 0) return undefined;

  const parts: Buffer[] = [];
  let index = 0;
  while (index < offsets.length) {
    let decoded: Buffer | undefined;
    // 从当前帧起点往后试切点：真正的帧边界是「切到那里能解码」的那个
    for (let end = index + 1; end <= offsets.length && !decoded; end += 1) {
      const stop = end < offsets.length ? offsets[end] : buf.length;
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(offsets[index], stop));
        index = end;
      } catch {
        // 切在帧内部：换下一个候选
      }
    }
    if (!decoded) return undefined;
    parts.push(decoded);
  }
  return Buffer.concat(parts).toString("utf8");
}

interface Row {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, any>;
}

function readRows(file: string): Row[] | undefined {
  const text = decodeSessionLog(file);
  if (!text) return undefined;
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      // 半截行（写到一半被杀）跳过即可
    }
  }
  return rows;
}

const args = process.argv.slice(2);
const onlyWs = args.includes("--ws") ? args[args.indexOf("--ws") + 1] : undefined;
const onlySession = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;

const at = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString("zh-CN") : "-");

let scanned = 0;
let failed = 0;
const found: { ws: string; name: string; file: string; goals: Row[]; mtime: number }[] = [];

for (const ws of readdirSync(SESSIONS_ROOT)) {
  if (onlyWs && ws !== onlyWs) continue;
  let names: string[] = [];
  try {
    names = readdirSync(join(SESSIONS_ROOT, ws));
  } catch {
    continue;
  }
  for (const name of names) {
    if (onlySession && !name.includes(onlySession)) continue;
    const file = join(SESSIONS_ROOT, ws, name, "session.v3.jsonl.zstd");
    const rows = readRows(file);
    if (!rows) {
      failed += 1;
      continue;
    }
    scanned += 1;
    const goals = rows.filter((row) => String(row.type ?? "").startsWith("goal/"));
    if (goals.length) found.push({ ws, name, file, goals, mtime: statSync(file).mtimeMs });
  }
}

found.sort((a, b) => b.mtime - a.mtime);
for (const item of found) {
  console.log(`\n=== ${item.ws} / ${item.name}`);
  console.log(`    日志改于 ${at(item.mtime)}；goal 事件 ${item.goals.length} 条`);
  for (const goal of item.goals) {
    const data = goal.data ?? {};
    const body = (data.goal ?? {}) as Record<string, unknown>;
    const what = data.operation === "clear" ? `clear（清掉 ${JSON.stringify(data.cleared ?? {})}）` : `phase=${body.phase}`;
    console.log(`    seq=${goal.seq} ${at(goal.time)} ${what} ${JSON.stringify(String(body.objective ?? "").slice(0, 48))}`);
  }
}

// 指定单个会话时，额外把尾部记录打出来——「界面卡住的那一刻服务端在做什么」全靠它
if (onlySession && found.length) {
  for (const item of found) {
    const rows = readRows(item.file) ?? [];
    console.log(`\n--- ${item.name} 末尾 12 条 ---`);
    for (const row of rows.slice(-12)) {
      console.log(`  seq=${row.seq} ${at(row.time)} ${row.type} ${JSON.stringify(row.data ?? {}).slice(0, 200)}`);
    }
  }
}

console.log(`\n扫过 ${scanned} 个会话（${failed} 个没能解码），带 goal 事件的 ${found.length} 个`);
