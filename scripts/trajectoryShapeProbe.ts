/**
 * 【探针定位】工具型 · 零 token —— 把真实会话日志里几类事件的**形状** dump 出来，
 * 用来判断「官方那几项需要的输入到底在不在 durable 事件里」——不在就没法折，在就值得做。
 *
 * 输出的是**观察**，不改红也不改绿（退出码恒 0）。其中的 B1 段（inbox 状态机）量的是
 * steering 分类的落地效果：`inserted[]` 的 id 覆盖、`target` 过滤、领取集合装的是哪一批，
 * 以及「官方状态机跑真实日志会把多少条人发消息归成 steering」。
 * **分类本身的逐条对拍在 `trajectoryAlignProbe.ts`**（那边拿折叠层的输出与独立复算比）。
 *
 * 用法：
 *   npm run build:scripts
 *   node build/trajectory-shape-probe.mjs
 *   node build/trajectory-shape-probe.mjs --limit 500
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeSessionLog } from "./sessionLog";

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");

function files(limit: number): string[] {
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

const eventCounts = new Map<string, number>();
const keysByType = new Map<string, Map<string, number>>();
/** 对每个类型的 data 里嵌套对象的**键**也记一层（看 schema / blocks 这类结构）。 */
const nestedKeys = new Map<string, Map<string, number>>();
const toolResultBlockTypes = new Map<string, number>();
const spliceTargets = new Map<string, number>();

/* ======================================================================
 * B1 前置取证：`agent/inbox/spliced` 的真实形状 + 官方状态机的落地效果
 * ======================================================================
 *
 * B1（steering 区分）的第一件事不是写代码，而是量两件事：
 *
 * 1. `inserted[]` 里到底有多少元素**没有** `id`。官方 `applySplice` 直接
 *    `.map(identity => identity.id)`，没有 id 就得到 `undefined`，并可能随
 *    `materializePending()` 进到 `currentClaimed` 里。
 * 2. 官方那台状态机跑在真实日志上，**最终能把多少条 `user/message` 归成 steering**。
 *    判据是「splice 里被领取掉的 id」与「`user/message` 的 `data.id`」对得上——
 *    两者若对不上，这一项就没有可兑现的价值（这正是上一位留下的未验证假设：
 *    「影响面约 10%」是从 splice 帧数推的，不是从 id 匹配量的）。
 *
 * 顺带量 `removedCount` / `outcome` / `start` 的分布：官方「一次领取」的判据是
 * `removedCount > 0 && outcome !== 'canceled'`，这几档若在真实数据里长尾异常，
 * 直译出来的分派就会跟着异常。
 */

/** 官方 `PendingState`：只把 `inserted` 放宽成 `unknown[]` 以便数出 `undefined`。 */
type ProbePending =
  | { kind: "snapshot"; ids: string[] }
  | {
    kind: "splice";
    previous: ProbePending;
    start: number;
    removedCount: number;
    inserted: unknown[];
  };

/** 官方 `materializePending()`。 */
function probeMaterializePending(state: ProbePending): unknown[] {
  const splices: Extract<ProbePending, { kind: "splice" }>[] = [];
  let current = state;
  while (current.kind === "splice") {
    splices.push(current);
    current = current.previous;
  }
  const pending: unknown[] = [...current.ids];
  for (const splice of splices.reverse()) {
    pending.splice(splice.start, splice.removedCount, ...splice.inserted);
  }
  return pending;
}

/** 官方 `withoutInserted()`。 */
function probeWithoutInserted(claimed: ReadonlySet<unknown>, inserted: readonly unknown[]): Set<unknown> {
  let next: Set<unknown> | undefined;
  for (const id of inserted) {
    if (!claimed.has(id)) continue;
    next ??= new Set(claimed);
    next.delete(id);
  }
  return next ?? new Set(claimed);
}

/** 一台状态机跑下来的计数。 */
interface B1MachineStats {
  label: string;
  framesApplied: number;
  claims: number;
  /** 进过 `currentClaimed` 的非字符串（`undefined` / 物件）个数。 */
  nonStringClaimed: number;
  claimedSizeHist: Map<string, number>;
  /** 人发消息被归成 steering / user 的条数。 */
  steering: number;
  user: number;
  claimedIdSamples: Set<string>;
}

const newMachineStats = (label: string): B1MachineStats => ({
  label,
  framesApplied: 0,
  claims: 0,
  nonStringClaimed: 0,
  claimedSizeHist: new Map(),
  steering: 0,
  user: 0,
  claimedIdSamples: new Set(),
});

interface B1Stats {
  files: number;
  frames: number;
  framesByTarget: Map<string, number>;
  insertedLenHist: Map<string, number>;
  insertedNotArray: number;
  insertedItems: number;
  insertedWithId: number;
  insertedWithoutId: number;
  /** 键签名 → 次数，按「有 id / 没 id」分开。 */
  keysWithId: Map<string, number>;
  keysWithoutId: Map<string, number>;
  /** 没 id 的元素样本（去重，最多留 12 条）。 */
  noIdSamples: Map<string, number>;
  /** 按 target 分开的 removedCount / outcome / start 分布（claim 判据只在 next-step 上有意义）。 */
  removedCountByTarget: Map<string, Map<string, number>>;
  outcomeByTarget: Map<string, Map<string, number>>;
  startByTarget: Map<string, Map<string, number>>;
  /** 官方口径：只吃 `target === 'next-step'`（与官方 definition 的 `match` 一致）。 */
  official: B1MachineStats;
  /** 全队列口径：`next-step` + `next-turn` 都吃（量「只跟 next-step 会不会索引错位」）。 */
  allTargets: B1MachineStats;
  /** `user/message` 侧。 */
  userMessages: number;
  userMessagesWithId: number;
  userMessagesWithoutId: number;
  kindHist: Map<string, number>;
  humanWithoutId: number;
  /** 官方口径下命中了 claim 集合、但 `source.kind` 不是 `user` 的消息。 */
  claimedButNotUserKind: Map<string, number>;
  /** 用户消息 id 样本。 */
  userIdSamples: Set<string>;
  /**
   * 交叉表：官方分派 × 「消息到达时 agent 是否正在跑」。
   *
   * 这是对 steering 分类的**意义核验**（不只是数量）：steering 的语义是「生成过程中
   * 插进队列、在下一次 step 边界被领取」，所以它应当落在「最近一轮已产出过模型输出、
   * 且该轮还没 `turn/end`」的位置上；落在那儿之外的 steering 就是误判。
   */
  crossSteering: B1Expectation;
  crossUser: B1Expectation;
}

interface B1Expectation {
  /** 最近一轮已产出模型输出且未收尾 → 期望是「生成中插话」。 */
  insert: number;
  /** 最近一轮未产出输出，或已收尾 → 期望是「开新轮」。 */
  fresh: number;
  /** 窗口内没见过 `assistant/message`（无法判定）。 */
  unknown: number;
}

const b1: B1Stats = {
  files: 0,
  frames: 0,
  framesByTarget: new Map(),
  insertedLenHist: new Map(),
  insertedNotArray: 0,
  insertedItems: 0,
  insertedWithId: 0,
  insertedWithoutId: 0,
  keysWithId: new Map(),
  keysWithoutId: new Map(),
  noIdSamples: new Map(),
  removedCountByTarget: new Map(),
  outcomeByTarget: new Map(),
  startByTarget: new Map(),
  official: newMachineStats("官方口径（只吃 next-step）"),
  allTargets: newMachineStats("全队列口径（next-step + next-turn）"),
  userMessages: 0,
  userMessagesWithId: 0,
  userMessagesWithoutId: 0,
  kindHist: new Map(),
  humanWithoutId: 0,
  claimedButNotUserKind: new Map(),
  userIdSamples: new Set(),
  crossSteering: { insert: 0, fresh: 0, unknown: 0 },
  crossUser: { insert: 0, fresh: 0, unknown: 0 },
};

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/** 按 target 分桶的计数（`Map<target, Map<档位, 次数>>`）。 */
const bumpByTarget = (map: Map<string, Map<string, number>>, target: string, key: string): void => {
  const inner = map.get(target) ?? new Map<string, number>();
  bump(inner, key);
  map.set(target, inner);
};

/** 一台状态机的状态（官方 `InboxState` 的两个字段）。 */
interface B1Machine {
  pending: ProbePending;
  claimed: ReadonlySet<unknown>;
}

const newMachine = (): B1Machine => ({ pending: { kind: "snapshot", ids: [] }, claimed: new Set() });

/**
 * 官方 `applySplice()` 逐字照搬，只把 `inserted` 放宽成 `unknown[]` 以便数出混进来的
 * 非字符串。起手 `pending` 为空——与官方「本 definition 的节点不在已加载窗口里」时
 * `reader.previous()` 返回 `undefined` 同构。
 */
function applyFrame(machine: B1Machine, record: Record<string, unknown>, stats: B1MachineStats): void {
  const inserted = Array.isArray(record.inserted) ? (record.inserted as unknown[]) : [];
  const ids = inserted.map((identity) =>
    identity !== null && typeof identity === "object" ? (identity as { id?: unknown }).id : undefined);
  const removedCount = typeof record.removedCount === "number" ? record.removedCount : 0;
  const start = typeof record.start === "number" ? record.start : 0;
  stats.framesApplied += 1;
  if (removedCount > 0 && record.outcome !== "canceled") {
    const materialized = probeMaterializePending(machine.pending);
    const removed = materialized.splice(start, removedCount, ...ids);
    machine.pending = { kind: "snapshot", ids: materialized as string[] };
    machine.claimed = new Set(removed);
    stats.claims += 1;
    for (const id of removed) {
      if (typeof id !== "string") stats.nonStringClaimed += 1;
      else if (stats.claimedIdSamples.size < 6) stats.claimedIdSamples.add(id);
    }
  } else {
    machine.claimed = probeWithoutInserted(machine.claimed, ids);
    machine.pending = { kind: "splice", previous: machine.pending, start, removedCount, inserted: ids };
  }
  bump(stats.claimedSizeHist, String(machine.claimed.size));
}

/** 一份会话日志里与 B1 相关的事件（只留这两类，按 seq 排序后跑状态机）。 */
interface B1Event {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

function probeB1(events: B1Event[]): void {
  b1.files += 1;
  const official = newMachine();
  const allTargets = newMachine();
  /** 「最近一轮」的判据：最后一条 `assistant/message` 的轮号 + 哪些轮已 `turn/end`。 */
  let lastAssistantTurn: number | null = null;
  const closedTurns = new Set<number>();
  const expectation = (): keyof B1Expectation =>
    lastAssistantTurn === null ? "unknown" : closedTurns.has(lastAssistantTurn) ? "fresh" : "insert";

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type === "assistant/message") {
      if (typeof event.data.turn === "number") lastAssistantTurn = event.data.turn;
      continue;
    }
    if (event.type === "turn/end") {
      if (typeof event.data.turn === "number") closedTurns.add(event.data.turn);
      continue;
    }
    if (event.type === "turn/start") continue;
    if (event.type === "agent/inbox/spliced") {
      const record = event.data;
      b1.frames += 1;
      const target = String(record.target);
      bump(b1.framesByTarget, target);
      if (!Array.isArray(record.inserted)) b1.insertedNotArray += 1;
      const inserted = Array.isArray(record.inserted) ? (record.inserted as unknown[]) : [];
      bump(b1.insertedLenHist, String(inserted.length));
      for (const item of inserted) {
        b1.insertedItems += 1;
        const isObject = item !== null && typeof item === "object";
        const keys = isObject ? Object.keys(item as Record<string, unknown>).sort().join(",") : `<${typeof item}>`;
        const id = isObject ? (item as { id?: unknown }).id : undefined;
        if (typeof id === "string") {
          b1.insertedWithId += 1;
          bump(b1.keysWithId, keys);
        } else {
          b1.insertedWithoutId += 1;
          bump(b1.keysWithoutId, keys);
          if (b1.noIdSamples.size < 12) {
            const json = JSON.stringify(item);
            bump(b1.noIdSamples, json.length > 220 ? `${json.slice(0, 220)}…` : json);
          }
        }
      }
      bumpByTarget(b1.removedCountByTarget, target, record.removedCount === undefined ? "<缺>" : String(record.removedCount));
      bumpByTarget(b1.outcomeByTarget, target, record.outcome === undefined ? "<缺>" : String(record.outcome));
      bumpByTarget(b1.startByTarget, target, typeof record.start === "number" ? String(record.start) : `<${typeof record.start}>`);

      // 官方 definition 的 `match` 只认 next-step；另一台机器吃全部 target，用作对照。
      if (target === "next-step") applyFrame(official, record, b1.official);
      applyFrame(allTargets, record, b1.allTargets);
      continue;
    }

    /** 官方 `trajectory-input-message` 的判据：`source.kind !== 'user'` → context。 */
    b1.userMessages += 1;
    const source = event.data.source as { kind?: unknown } | undefined;
    const kind = typeof source?.kind === "string" ? source.kind : "";
    const id = event.data.id;
    bump(b1.kindHist, kind || "<无 kind>");
    if (typeof id === "string") {
      b1.userMessagesWithId += 1;
      if (b1.userIdSamples.size < 6) b1.userIdSamples.add(id);
    } else {
      b1.userMessagesWithoutId += 1;
    }
    const isOfficialHuman = kind === "user";
    if (!isOfficialHuman) {
      // 官方只在 `source.kind === 'user'` 时查 claim 集合；其它 kind 一律 context。
      const claimed = typeof id === "string" && official.claimed.has(id);
      if (claimed) bump(b1.claimedButNotUserKind, kind || "<无 kind>");
      continue;
    }
    if (typeof id !== "string") b1.humanWithoutId += 1;
    const expected = expectation();
    for (const [machine, stats] of [[official, b1.official], [allTargets, b1.allTargets]] as const) {
      const isSteering = typeof id === "string" && machine.claimed.has(id);
      if (isSteering) stats.steering += 1;
      else stats.user += 1;
      // 交叉表只对官方口径有意义（另一台机器是刻意的错误对照）。
      if (machine !== official) continue;
      (isSteering ? b1.crossSteering : b1.crossUser)[expected] += 1;
    }
  }
}


const LIMIT = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : 120;

for (const file of files(LIMIT)) {
  let decoded: string | undefined;
  try {
    decoded = decodeSessionLog(file);
  } catch {
    continue;
  }
  if (!decoded) continue;
  const b1Events: B1Event[] = [];
  for (const line of decoded.split("\n")) {
    if (!line.trim()) continue;
    let row: { type?: unknown; seq?: unknown; data?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    if (typeof row.type !== "string" || typeof row.seq !== "number") continue;
    eventCounts.set(row.type, (eventCounts.get(row.type) ?? 0) + 1);
    const data = row.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    const keys = keysByType.get(row.type) ?? new Map<string, number>();
    for (const key of Object.keys(record)) keys.set(key, (keys.get(key) ?? 0) + 1);
    keysByType.set(row.type, keys);

    const nested = nestedKeys.get(row.type) ?? new Map<string, number>();
    for (const [key, value] of Object.entries(record)) {
      if (value === null || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        nested.set(`${key}[]`, (nested.get(`${key}[]`) ?? 0) + 1);
        for (const item of value) {
          if (item !== null && typeof item === "object") {
            for (const inner of Object.keys(item as Record<string, unknown>)) {
              nested.set(`${key}[].${inner}`, (nested.get(`${key}[].${inner}`) ?? 0) + 1);
            }
          }
        }
      } else {
        nested.set(key, (nested.get(key) ?? 0) + 1);
        for (const inner of Object.keys(value as Record<string, unknown>)) {
          nested.set(`${key}.${inner}`, (nested.get(`${key}.${inner}`) ?? 0) + 1);
        }
      }
    }
    nestedKeys.set(row.type, nested);

    if (row.type === "agent/inbox/spliced") {
      const target = String(record.target);
      spliceTargets.set(target, (spliceTargets.get(target) ?? 0) + 1);
    }
    if (row.type === "agent/inbox/spliced" || row.type === "user/message") {
      b1Events.push({ seq: row.seq, type: row.type, data: record });
    } else if (row.type === "turn/start" || row.type === "turn/end" || row.type === "assistant/message") {
      // 只留轮号：`assistant/message` 的 data 很大（含流式帧），整条留着会吃掉内存。
      b1Events.push({ seq: row.seq, type: row.type, data: { turn: (record as { turn?: unknown }).turn } });
    }
    if (row.type === "tool/result") {
      const message = record.message as { content?: unknown } | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const type = (block as { type?: unknown })?.type;
          if (typeof type === "string") toolResultBlockTypes.set(type, (toolResultBlockTypes.get(type) ?? 0) + 1);
        }
      }
    }
  }
  probeB1(b1Events);
}

const top = (map: Map<string, number>, count = 30) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);

console.log("事件类型分布（前 30）：");
for (const [type, value] of top(eventCounts, 30)) console.log(`  ${type.padEnd(38)} ${value}`);

const interesting = [
  "agent/inbox/spliced",
  "tool/call",
  "tool/result",
  "system/message",
  "request/header",
  "user/message",
];
for (const type of interesting) {
  console.log(`\n=== ${type}（${eventCounts.get(type) ?? 0} 条）的 data 键 ===`);
  for (const [key, value] of top(keysByType.get(type) ?? new Map(), 24)) {
    console.log(`  ${key.padEnd(28)} ${value}`);
  }
  const nested = nestedKeys.get(type);
  if (nested && nested.size > 0) {
    console.log(`  --- 嵌套键（前 30）---`);
    for (const [key, value] of top(nested, 30)) console.log(`    ${key.padEnd(34)} ${value}`);
  }
}

console.log("\n=== agent/inbox/spliced 的 target 分布 ===");
for (const [key, value] of top(spliceTargets, 10)) console.log(`  ${key.padEnd(16)} ${value}`);

console.log("\n=== tool/result 的 message.content 块类型 ===");
for (const [key, value] of top(toolResultBlockTypes, 16)) console.log(`  ${key.padEnd(20)} ${value}`);

// ---------- 两个「官方有、我们没有」的输入侧判据 ----------
// 1) `assistant/attempt`：官方 `settleTiming()` 拿它的 `data.stream` 补首 token 时刻
//    （`assistantStreamFirstTokenTime`），是 `assistant/message` 之外的第二条来源。
// 2) `session/end-seed`：官方 `interruptCompactions()` 以它作**会话边界**，把边界前
//    仍在 running 的压缩请求改判成「中断」（`trajectory.compaction-interrupted`）。
console.log("\n=== assistant/attempt 的 data 形状 ===");
for (const [key, value] of top(keysByType.get("assistant/attempt") ?? new Map(), 16)) {
  console.log(`  ${key.padEnd(28)} ${value}`);
}
for (const [key, value] of top(nestedKeys.get("assistant/attempt") ?? new Map(), 20)) {
  console.log(`    ${key.padEnd(30)} ${value}`);
}
console.log("\n=== session/end-seed 的 data 形状 ===");
for (const [key, value] of top(keysByType.get("session/end-seed") ?? new Map(), 16)) {
  console.log(`  ${key.padEnd(28)} ${value}`);
}

// ---------- B1 前置取证报告 ----------
const pct = (part: number, whole: number): string =>
  whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`;

console.log("\n\n########## B1 前置取证：steering 区分 ##########");
console.log(`\n扫描 ${b1.files} 份会话日志；spliced 帧 ${b1.frames} 条；user/message ${b1.userMessages} 条`);

console.log("\n--- agent/inbox/spliced 的 target ---");
for (const [key, value] of top(b1.framesByTarget, 8)) console.log(`  ${key.padEnd(18)} ${value}`);

console.log("\n--- inserted 数组长度分布 ---");
for (const [key, value] of [...b1.insertedLenHist.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  len=${key.padEnd(6)} ${String(value).padEnd(8)} 帧`);
}
if (b1.insertedNotArray > 0) console.log(`  inserted 不是数组的帧：${b1.insertedNotArray}`);

console.log(`\n--- inserted 元素总数（全部会话累计）---`);
console.log(`  元素总数        ${b1.insertedItems}`);
console.log(`  带 string id    ${b1.insertedWithId}（${pct(b1.insertedWithId, b1.insertedItems)}）`);
console.log(`  没有 string id  ${b1.insertedWithoutId}（${pct(b1.insertedWithoutId, b1.insertedItems)}）`);

console.log("\n--- 带 id 的 inserted 元素的键签名 ---");
for (const [key, value] of top(b1.keysWithId, 10)) console.log(`  ${key.padEnd(50)} ${value}`);

console.log("\n--- 没有 id 的 inserted 元素的键签名 ---");
if (b1.keysWithoutId.size === 0) console.log("  （无）");
for (const [key, value] of top(b1.keysWithoutId, 10)) console.log(`  ${key.padEnd(50)} ${value}`);

if (b1.noIdSamples.size > 0) {
  console.log("\n--- 没有 id 的元素长什么样（去重样本）---");
  for (const [sample, value] of top(b1.noIdSamples, 12)) console.log(`  ×${value}  ${sample}`);
}

console.log("\n--- removedCount / outcome / start 分布（按 target）---");
for (const [target, inner] of b1.removedCountByTarget) {
  console.log(`  [${target}] removedCount：${top(inner, 6).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}
for (const [target, inner] of b1.outcomeByTarget) {
  console.log(`  [${target}] outcome：     ${top(inner, 6).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}
for (const [target, inner] of b1.startByTarget) {
  console.log(`  [${target}] start：       ${top(inner, 6).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

for (const stats of [b1.official, b1.allTargets]) {
  console.log(`\n--- 状态机：${stats.label} ---`);
  console.log(`  应用过的帧          ${stats.framesApplied}`);
  console.log(`  判定为「一次领取」  ${stats.claims}`);
  console.log(`  混进 currentClaimed 的非字符串 ${stats.nonStringClaimed}`);
  const sizes = [...stats.claimedSizeHist.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 8);
  console.log(`  currentClaimed 大小分布：${sizes.map(([k, v]) => `${k}:${v}`).join("  ")}`);
  console.log(`  ★ 人发消息归 steering：${stats.steering}　归 user：${stats.user}`);
}

console.log("\n--- 交叉表：官方分派 × 消息到达时 agent 的状态 ---");
console.log("    （insert = 最近一轮已产出模型输出且未收尾 → 期望 steering；");
console.log("      fresh  = 最近一轮未产出或已收尾 → 期望 user；unknown = 窗口内无助手消息）");
const cross = (label: string, value: B1Expectation): void => {
  const total = value.insert + value.fresh + value.unknown;
  console.log(`  ${label.padEnd(14)} insert=${String(value.insert).padEnd(6)} fresh=${String(value.fresh).padEnd(6)} unknown=${value.unknown}  （合计 ${total}）`);
};
cross("官方 steering", b1.crossSteering);
cross("官方 user", b1.crossUser);

console.log("\n--- user/message 侧 ---");
console.log(`  总数                ${b1.userMessages}`);
console.log(`  带 string id        ${b1.userMessagesWithId}（${pct(b1.userMessagesWithId, b1.userMessages)}）`);
console.log(`  没有 string id      ${b1.userMessagesWithoutId}`);
console.log(`  source.kind 分布：`);
for (const [key, value] of top(b1.kindHist, 16)) console.log(`    ${key.padEnd(28)} ${value}`);
console.log(`  人发（kind=user）但没有 id：${b1.humanWithoutId}`);
if (b1.claimedButNotUserKind.size > 0) {
  console.log(`  命中 claim 集合但 kind 不是 user 的（官方会当 context，无害）：`);
  for (const [key, value] of top(b1.claimedButNotUserKind, 10)) console.log(`    ${key.padEnd(28)} ${value}`);
}

console.log("\n--- id 样本（判断两侧 id 是不是同一个空间）---");
console.log("  官方 claim 集合里的 id：");
if (b1.official.claimedIdSamples.size === 0) console.log("    （一个都没有）");
for (const id of b1.official.claimedIdSamples) console.log(`    ${id}`);
console.log("  user/message 的 id：");
if (b1.userIdSamples.size === 0) console.log("    （一个都没有）");
for (const id of b1.userIdSamples) console.log(`    ${id}`);
