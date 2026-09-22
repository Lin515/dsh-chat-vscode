/**
 * 【探针定位】勘察型 · 耗 token —— 钉「只 cancel 不会让队列接续」这条服务端事实，
 *   结论已固化在 controller.stopRunning 的设计与 docs/audit-summary.md「仍未修复」的停止语义条；
 *   只在重开队列语义问题时跑。按 AGENTS.md 硬约束，每次运行前须获用户批准，
 *   不得随构建自动执行。
 *
 * 探针：只 `cancel` 会不会让队列自动接续？
 *
 * 背景：`controller.stopRunning`（ESC）的做法是「摘空整条队列 → cancel → 等空闲 →
 * 按原顺序重发」，而不是「只 cancel，让服务端自己把队列接着跑完」。这个设计依赖
 * 两个服务端事实，本探针把它们重新变成可复现的证据（该脚本曾被删除，导致注释里的
 * 引用成了悬空引用，见 docs/audit-summary.md 五章「悬空引用」）：
 *
 *  1. **只 cancel 不会让队列接续**——agent 因 abort 抛出而跳出轮循环，队列项保留
 *     （`cancel` 用 `keepInbox: true`）但不会被消费。这一条两轮实测都是 3/3，
 *     是确定性的。
 *  2. **中止之后提交新消息，服务端会不会顺带把保留的队列项跑起来，是不确定的**：
 *     同一份脚本的两次运行得到**相反**结果——一次 3/3 都唤醒了队列项（于是用户刚提交
 *     的那条被排到后面），另一次 3/3 都没唤醒（两条都停在队列里）。取决于中止落在
 *     轮循环哪一步，客户端无法预判。
 *
 * 由此，本探针的断言只钉**确定的东西**：
 *  - 事实 1：只 cancel 不会自动接续（严格断言 3/3）；
 *  - 任何一条消息都不会重复出现（无论唤醒与否）。
 * 事实 2 作为**观察**打印出分布——它的证据就是「两次运行结果相反」本身，
 * 对它做硬断言只会得到一个随机器负载飘的假防线。
 *
 * 两轮各 3 次（与 controller.ts 的注释引用一致）。
 *
 * 运行：npm run build:scripts && node build/queue-continue-probe.mjs
 */
// 必须排在最前：会合目录与 DSH_HOME 都指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// 自检放这里还有一层作用：真的用到导出值，esbuild 才不会把副作用 import 摇掉。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
import { randomUUID } from "node:crypto";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";
import { queueItemsFromInbox, queueItemsFromWire } from "../src/dsh/queueView";

const log = (line: string) => console.log(`[probe] ${line}`);
const server = new SupervisorManager({ url: "", command: "dsh", log });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface WireEvent {
  type: string;
  data: unknown;
}

/** 一次试验的观察结果。 */
interface Trial {
  /** 只 cancel 之后，队列项是否被服务端自己消费过（事实 1 的反例）。 */
  queueDrained: boolean;
  /** 提交新消息后，保留的队列项是否被唤醒并跑起来（事实 2 的观察点）。 */
  woken: boolean;
  /** 新提交的消息是否**抢在**保留的队列项之前执行。 */
  newFirst: boolean;
  /** 观察到的执行顺序，形如 `["队列项", "新消息"]`。 */
  order: string[];
}

// 只要「一轮跑得足够久」即可：数到 80 已经远超入队 + cancel 所需的窗口，
// 又不至于为了做实验烧掉大量输出 token
const SLOW = "请从 1 数到 80，每个数字单独一行，不要省略、不要合并。";
// 排在队列里的两条要**跑得快**：第二轮要观察它们的先后顺序，
// 若它们各自是一整轮真实工作，观察窗口会被模型耗时主导。
// 文案必须与 smoke.ts 里的提示词不同，否则两边的日志会互相认错。
// 标记与「给人看的顺序标签」分开：长文案拼进提示词，短标记只用来认转写。
const QUEUED = "【QUEUED】只回复一个字：甲";
const FRESH = "【FRESH】只回复一个字：乙";
const QUEUED_TAG = "【QUEUED】";
const FRESH_TAG = "【FRESH】";

let client: DshClient | undefined;

function observe(sessionId: string) {
  const events: WireEvent[] = [];
  let queue: string[] = [];
  const follow = client!.followSession(sessionId, {
    onItem: (value) => {
      const frame = value as { type?: string; event?: WireEvent };
      if (frame?.type === "event" && frame.event) events.push(frame.event);
    },
  });
  const control = client!.followControl({
    onItem: (value) => {
      const frame = value as {
        type?: string;
        sessionId?: string;
        items?: unknown[];
        key?: string;
        value?: {
          queues?: Record<string, unknown[]>;
          projections?: Record<string, { values?: Record<string, unknown> }>;
        };
      };
      // 队列有两条通道，都认（与宿主侧 controller.onControlFrame 同一套映射）：
      // 旧服务端用 `queues` baseline + `queue` 帧，2026-09-09 起改用 `inbox` 投影。
      if (frame?.type === "queue" && frame.sessionId === sessionId) {
        queue = queueItemsFromWire(frame.items).map((entry) => entry.view.id);
      } else if (frame?.type === "projection" && frame.sessionId === sessionId && frame.key === "inbox") {
        queue = queueItemsFromInbox(frame.value).map((entry) => entry.view.id);
      } else if (frame?.type === "baseline") {
        const legacy = frame.value?.queues?.[sessionId];
        if (Array.isArray(legacy)) queue = queueItemsFromWire(legacy).map((entry) => entry.view.id);
        const inbox = frame.value?.projections?.[sessionId]?.values?.inbox;
        if (inbox !== undefined) queue = queueItemsFromInbox(inbox).map((entry) => entry.view.id);
      }
    },
  });
  return {
    get queue() {
      return queue;
    },
    running: () => {
      const ends = events.filter((e) => e.type === "turn/end").length;
      const starts = events.filter((e) => e.type === "turn/start").length;
      return starts > ends;
    },
    turnStarts: () => events.filter((e) => e.type === "turn/start").length,
    /** 用户消息正文按出现顺序（跳过插件注入的 `<...>` 信封）。 */
    userTexts: () =>
      events
        .filter((e) => e.type === "user/message")
        .map((e) => {
          const data = e.data as { content?: { type?: string; text?: string }[] };
          return (data.content ?? [])
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("");
        })
        .filter((t) => !t.startsWith("<")),
    reset: () => {
      events.length = 0;
    },
    stop: () => {
      follow.cancel();
      control.cancel();
    },
  };
}

async function until(check: () => boolean, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(stepMs);
  }
  return check();
}

/**
 * 跑一次「慢轮 + 一条排队消息」，然后**只** cancel，立刻提交新消息。
 *
 * @param settleMs 中止后等待多久再提交新消息（0 = 立即，模拟真实 ESC 的时序）。
 */
async function trial(settleMs: number): Promise<Trial> {
  const { sessionId } = await client!.createSession(process.cwd());
  const view = observe(sessionId);
  await wait(500);
  try {
    await client!.prompt(sessionId, [{ type: "text", text: SLOW }], "queue", randomUUID());
    await until(() => view.turnStarts() > 0, 20_000);

    await client!.prompt(sessionId, [{ type: "text", text: QUEUED }], "queue", randomUUID());
    const queued = await until(() => view.queue.length >= 1, 15_000);
    if (!queued) throw new Error("没能在队列里堆出消息");

    // ---- 只 cancel：不摘队列、不重发（这正是设计要否定的做法） ----
    const startsBefore = view.turnStarts();
    await client!.cancel(sessionId);
    await until(() => !view.running(), 15_000, 100);

    // 事实 1：中止收尾之后，队列项仍应原封不动地留着
    await wait(1_500);
    const afterCancel = view.turnStarts();
    const drainedAfterCancel = view.queue.length === 0 || afterCancel > startsBefore;

    if (settleMs > 0) await wait(settleMs);

    // 事实 2：中止**收尾之后**再提交一条新消息（队列里那条仍在）
    view.reset();
    await client!.prompt(sessionId, [{ type: "text", text: FRESH }], "queue", randomUUID());

    // 等任一条出现：出现了就说明队列被唤醒了；两条都不出现说明没唤醒。
    // 窗口只给 45s——两条都是「只回复一个字」，被唤醒的话几秒内就会跑起来
    const woken = await until(
      () => view.userTexts().some((t) => t.includes(QUEUED_TAG) || t.includes(FRESH_TAG)),
      45_000,
      300,
    );
    if (woken) {
      // 被唤醒：等两条都跑完（各自的轮很短）
      await until(
        () => !view.running() && view.queue.length === 0,
        60_000,
        400,
      );
    }

    const texts = view.userTexts();
    const order = texts
      .filter((t) => t.includes(QUEUED_TAG) || t.includes(FRESH_TAG))
      .map((t) => (t.includes(QUEUED_TAG) ? "队列项" : "新消息"));
    return {
      queueDrained: drainedAfterCancel,
      woken: order.includes("队列项"),
      newFirst: order.indexOf("新消息") === 0,
      order,
    };
  } finally {
    view.stop();
    await client!.archiveSession(sessionId).catch(() => undefined);
  }
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  // ---- 第一轮：只 cancel，不提交新消息，看队列会不会自己接续（事实 1） ----
  console.log("\n=== 第一轮：只 cancel × 3（事实 1） ===");
  const roundOne: boolean[] = [];
  for (let i = 0; i < 3; i += 1) {
    const { sessionId } = await client.createSession(process.cwd());
    const view = observe(sessionId);
    await wait(500);
    try {
      await client.prompt(sessionId, [{ type: "text", text: SLOW }], "queue", randomUUID());
      await until(() => view.turnStarts() > 0, 20_000);
      await client.prompt(sessionId, [{ type: "text", text: QUEUED }], "queue", randomUUID());
      const queued = await until(() => view.queue.length >= 1, 15_000);
      const startsBefore = view.turnStarts();

      await client.cancel(sessionId);
      await until(() => !view.running(), 15_000, 100);
      // 给「abort 后唤醒」留足时间：若服务端会自己接续，这 5 秒内必然开始
      await wait(5_000);

      const consumed = view.turnStarts() > startsBefore || view.queue.length === 0;
      roundOne.push(consumed);
      console.log(
        `   #${i + 1} 排到队列=${queued}，cancel 后 5s：turn/start ${startsBefore}→${view.turnStarts()}，` +
          `队列剩 ${view.queue.length} 项 → ${consumed ? "被接续" : "未接续"}`,
      );
    } finally {
      view.stop();
      await client.archiveSession(sessionId).catch(() => undefined);
    }
  }
  check(
    "只 cancel 不会让队列自动接续（3/3 都未接续）",
    roundOne.every((consumed) => !consumed),
    `实际 ${roundOne.filter(Boolean).length}/3 次被接续`,
  );

  // ---- 第二轮：中止收尾后提交新消息，看会不会唤醒保留的队列项（事实 2） ----
  console.log("\n=== 第二轮：中止收尾后提交新消息 × 3（事实 2，观察） ===");
  const roundTwo: Trial[] = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await trial(0);
    roundTwo.push(result);
    console.log(
      `   #${i + 1} 顺序=${JSON.stringify(result.order)} → ` +
        (result.woken
          ? `队列项被唤醒${result.newFirst ? "，但新消息抢在它之前" : "，新消息被排到它后面"}`
          : "没被唤醒（两条都留在队列里）"),
    );
  }
  const wokenCount = roundTwo.filter((t) => t.woken).length;
  console.log(
    `   观察：${wokenCount}/3 次唤醒了保留的队列项。\n` +
      "   这一项**不可预判**：同一脚本另一次运行得到 0/3 与 3/3 两种相反结果。\n" +
      "   所以 ESC 不能依赖它——必须先摘空整条队列再按原序重发，顺序才由客户端说了算。",
  );

  // 无论唤醒与否，都不能出现「同一条消息跑两遍」
  check(
    "没有任何消息被重复执行（每条标记最多出现一次）",
    roundTwo.every((t) => t.order.filter((x) => x === "队列项").length <= 1 && t.order.filter((x) => x === "新消息").length <= 1),
    `顺序样本 ${JSON.stringify(roundTwo.map((t) => t.order))}`,
  );
  check(
    "新提交的消息不会绕过保留的队列项（只有它先跑才算绕过）",
    !roundTwo.some((t) => t.newFirst),
    `顺序样本 ${JSON.stringify(roundTwo.map((t) => t.order))}`,
  );

  console.log(failures === 0 ? "\n✓ 探针结论与 controller.ts 的注释一致" : `\n✗ ${failures} 项未通过`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
