/**
 * 【探针定位】工具型 · 零 token —— 量**宿主侧轨迹折叠的代价**（`deriveTrajectoryModel`）。
 *
 * 为什么需要它：官方只折「最近 50 个节点」并带短路判断，本扩展每次 `listTrajectory`
 * 都把**整份事件窗口**重折一遍（视图开着时运行中每 3 秒一次）。要不要为此加窗口，
 * 取决于这笔开销在真实日志上到底有多大——**先量再改**，这也是本仓库对「值不值得做」
 * 的一贯口径（同 `trajectoryGapProbe`）。
 *
 * 量三样：
 *   1. 事件窗口有多大（行数 / 字节数）；
 *   2. 折一次要多久（同一份连折 3 次取**最好一次**，避开 JIT 与 GC 噪声）；
 *   3. 折叠结果有多大（账本记录数），用来判断「窗口能省多少」。
 *
 * 输出的是**观察**（分位数与最坏样本），不是断言：本探针不改红、不改绿，退出码恒 0。
 *
 * 用法：
 *   npm run build:scripts
 *   node build/trajectory-fold-probe.mjs
 *   node build/trajectory-fold-probe.mjs --limit 100
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeSessionLog } from "./sessionLog";
import { deriveTrajectoryModel } from "../src/dsh/trajectory";
import { trajectoryTurnCells } from "../src/shared/trajectory";
import type { SessionWireEvent } from "../src/dsh/protocol";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
const args = process.argv.slice(2);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Number.POSITIVE_INFINITY;

interface Row {
  type?: string;
  seq?: number;
}

function files(): string[] {
  const found: { file: string; mtime: number }[] = [];
  let wsNames: string[] = [];
  try {
    wsNames = readdirSync(SESSIONS_ROOT);
  } catch {
    return [];
  }
  for (const ws of wsNames) {
    let names: string[] = [];
    try {
      names = readdirSync(join(SESSIONS_ROOT, ws));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(SESSIONS_ROOT, ws, name);
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry)) continue;
        const file = join(dir, entry);
        found.push({ file, mtime: statSync(file).mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((entry) => entry.file);
}

interface Sample {
  events: number;
  bytes: number;
  foldMs: number;
  foldOnlyMs: number;
  cells: number;
  requests: number;
}

const samples: Sample[] = [];
let skipped = 0;

for (const file of files()) {
  let decoded: string | undefined;
  try {
    decoded = decodeSessionLog(file);
  } catch {
    skipped += 1;
    continue;
  }
  if (!decoded) {
    skipped += 1;
    continue;
  }
  const events: SessionWireEvent[] = [];
  for (const line of decoded.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      if (typeof row.type === "string" && typeof row.seq === "number") {
        events.push(row as unknown as SessionWireEvent);
      }
    } catch {
      // 半截行跳过
    }
  }
  if (events.length === 0) continue;

  // 连折 3 次取最好一次：JIT 预热与 GC 都只会让某一次偏慢，最小值最接近真实成本。
  // 量的**不只是折叠**：`trajectoryEvents()` 自己还要把 `seen` 里那份 Map 摊开并**按 seq 排序**
  // （宿主每折一次都要排一遍），这一笔同样算在「取一份账本」的成本里。
  const seen = new Map<number, SessionWireEvent>();
  for (const event of events) seen.set(event.seq as number, event);
  const hostEvents = () => [...seen.values()].sort((left, right) => (left.seq as number) - (right.seq as number));
  let best = Number.POSITIVE_INFINITY;
  let bestFold = Number.POSITIVE_INFINITY;
  let model = deriveTrajectoryModel(hostEvents(), false);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = process.hrtime.bigint();
    const ordered = hostEvents();
    const afterSort = process.hrtime.bigint();
    model = deriveTrajectoryModel(ordered, false);
    const finished = process.hrtime.bigint();
    const total = Number(finished - started) / 1e6;
    if (total < best) {
      best = total;
      bestFold = Number(finished - afterSort) / 1e6;
    }
  }
  const cells = model.turns.flatMap(trajectoryTurnCells).length;
  samples.push({
    events: events.length,
    bytes: decoded.length,
    foldMs: best,
    foldOnlyMs: bestFold,
    cells,
    requests: model.requests.length,
  });
}

if (samples.length === 0) {
  console.log("没有可用的会话日志样本");
  process.exit(0);
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
};
const median = (values: number[]) => percentile(values, 0.5);

const folds = samples.map((sample) => sample.foldMs);
const eventsList = samples.map((sample) => sample.events);
console.log(`样本：${samples.length} 份会话（跳过 ${skipped} 份解不开/为空）`);
console.log("");
console.log("事件窗口（折叠的输入）");
console.log(`  行数   中位 ${median(eventsList)}   p90 ${percentile(eventsList, 0.9)}   最大 ${Math.max(...eventsList)}`);
console.log(`  字节   中位 ${Math.round(median(samples.map((s) => s.bytes)) / 1024)} KB   最大 ${Math.round(Math.max(...samples.map((s) => s.bytes)) / 1024)} KB`);
console.log("");
console.log("取一份账本（`trajectoryEvents()` 摊开 + 排序 + 折叠，取三次里最快的一次）");
console.log(`  毫秒   中位 ${median(folds).toFixed(1)}   p90 ${percentile(folds, 0.9).toFixed(1)}   最大 ${Math.max(...folds).toFixed(1)}`);
console.log(
  `  其中折叠本身占 ${Math.round((median(samples.map((s) => s.foldOnlyMs)) / median(folds)) * 100)}%（其余是摊开 + 排序）`,
);
console.log(`  账本   记录数中位 ${median(samples.map((s) => s.cells))}   最大 ${Math.max(...samples.map((s) => s.cells))}`);
console.log("");

const worst = samples.reduce((a, b) => (a.foldMs >= b.foldMs ? a : b));
const worstByEvents = samples.reduce((a, b) => (a.events >= b.events ? a : b));
console.log("最坏两份");
console.log(`  最慢：${worst.events} 行 / ${Math.round(worst.bytes / 1024)} KB → ${worst.foldMs.toFixed(1)} ms（其中折叠 ${worst.foldOnlyMs.toFixed(1)} ms，${worst.cells} 条记录）`);
console.log(`  最长：${worstByEvents.events} 行 / ${Math.round(worstByEvents.bytes / 1024)} KB → ${worstByEvents.foldMs.toFixed(1)} ms（其中折叠 ${worstByEvents.foldOnlyMs.toFixed(1)} ms，${worstByEvents.cells} 条记录）`);
console.log("");
console.log("读法：轨迹视图开着时运行中**每 3 秒**折一次（停手后再折一次收尾）。");
console.log("      中位数远小于一帧（16ms）就不值得为它加窗口——复杂度买不到可感收益；");
console.log("      出现几十上百毫秒的样本时才值得做「事件窗口 / 增量折叠」，而那要另附实测依据。");
