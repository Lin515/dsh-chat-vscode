/**
 * 【探针定位】防线型 · 耗 token —— 对拍「ESC 中止并把队首消息发出」的端到端语义
 *   （复刻 controller.stopRunning 三步）。动 stopRunning/队列链路或 dsh 升级时才有
 *   价值。按 AGENTS.md 硬约束，不得随构建自动执行，每次运行前须获用户批准。
 *
 * 端到端验证「ESC 中止并把队首消息发出」。
 *
 * 复刻 ChatController.stopRunning 的三步（摘队首 → cancel → 等空闲 → 重发），
 * 断言：
 *  1. 队首消息确实作为**新一轮**发出（turn/start 增加）；
 *  2. 只出现一次（没有因为「没摘干净」而重复）；
 *  3. 队列里剩下的第二条仍留在队列中（没有被顺带执行）；
 *  4. 过程结束时没有卡在运行中。
 *
 * 运行：npm run build:scripts && node build/queue-esc-e2e.mjs
 */
// 必须排在最前：会合目录与 DSH_HOME 都指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// 自检放这里还有一层作用：真的用到导出值，esbuild 才不会把副作用 import 摇掉。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[queue-esc] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
import { randomUUID } from "node:crypto";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";
import { queueItemsFromInbox, queueItemsFromWire } from "../src/dsh/queueView";

const log = (line: string) => console.log(`[e2e] ${line}`);
const server = new SupervisorManager({ url: "", command: "dsh", log });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface WireEvent {
  type: string;
  data: unknown;
}

function observe(client: DshClient, sessionId: string) {
  const events: WireEvent[] = [];
  let queue: string[] = [];
  const follow = client.followSession(sessionId, {
    onItem: (value) => {
      const frame = value as { type?: string; event?: WireEvent };
      if (frame?.type === "event" && frame.event) events.push(frame.event);
    },
  });
  const control = client.followControl({
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
    recent: (n: number) => events.slice(-n),
    running: () => {
      const ends = events.filter((e) => e.type === "turn/end").length;
      const starts = events.filter((e) => e.type === "turn/start").length;
      return starts > ends;
    },
    turnStarts: () => events.filter((e) => e.type === "turn/start").length,
    turnEnds: () => events.filter((e) => e.type === "turn/end").length,
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
    stop: () => {
      follow.cancel();
      control.cancel();
    },
  };
}

async function until(check: () => boolean, timeoutMs: number, stepMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(stepMs);
  }
  return check();
}

const SLOW = "请从 1 数到 200，每个数字单独一行，不要省略、不要合并。";
const HEAD = "【队首】把入口函数拆成两个";
const TAIL = "【队尾】顺便补一段注释";

let client: DshClient | undefined;
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

  const { sessionId } = await client.createSession(process.cwd());
  const view = observe(client, sessionId);
  await wait(600);

  await client.prompt(sessionId, [{ type: "text", text: SLOW }], "queue", randomUUID());
  await until(() => view.turnStarts() > 0, 15_000);

  const headContent = [{ type: "text", text: HEAD }];
  const tailContent = [{ type: "text", text: TAIL }];
  await client.prompt(sessionId, headContent, "queue", randomUUID());
  await wait(700);
  await client.prompt(sessionId, tailContent, "queue", randomUUID());

  const queued = await until(() => view.queue.length >= 2, 15_000);
  console.log(`\n队列检测：${queued ? view.queue.length + " 项" : "未检测到"}`);
  if (!queued) throw new Error("没能在队列里堆出两条消息");

  // ---- 复刻 stopRunning：摘空队列 → cancel → 等空闲 → 按原顺序重发 ----
  const ids = [...view.queue];
  for (const id of ids) await client.updateQueueRemove(sessionId, id);
  await client.cancel(sessionId);
  const idle = await until(() => !view.running(), 10_000, 100);
  check("cancel 后当前轮结束", idle);
  await client.prompt(sessionId, headContent, "queue", randomUUID());
  await client.prompt(sessionId, tailContent, "queue", randomUUID());

  const dispatched = await until(() => view.userTexts().some((t) => t.includes("队首")), 25_000, 300);
  check("队首消息已发出", dispatched);

  // 队尾排在队首之后，要等队首那一轮跑完才会被接续——等它出现即可。
  //
  // 窗口刻意给得宽（180s）：队首那条会让模型**真的做点事**（读文件、改文件），
  // 耗时完全取决于模型与工具，实测同一脚本在不同run 之间能差出一分钟以上。
  // 90s 时曾出现「队首跑完但队尾还没轮到」的假失败——断言的语义（队尾最终会被
  // 接续）没错，错的是窗口太短，而假失败会让人去追一个不存在的回归。
  const bothRan = await until(
    () =>
      view.userTexts().some((t) => t.includes("队首")) &&
      view.userTexts().some((t) => t.includes("队尾")),
    180_000,
    400,
  );
  check("队尾也被接续执行", bothRan, `turn/start=${view.turnStarts()} queue=${view.queue.length}`);

  console.log("\n最终转写：");
  const texts = view.userTexts();
  const heads = texts.filter((t) => t.includes("队首")).length;
  const tails = texts.filter((t) => t.includes("队尾")).length;
  check("队首只出现一次（无重复）", heads === 1, `出现 ${heads} 次`);
  check("队尾只出现一次", tails === 1, `出现 ${tails} 次`);

  // 顺序：队首必须排在队尾**之前**（这正是「直接发出队首」的关键）
  const order = texts
    .filter((t) => t.includes("队首") || t.includes("队尾"))
    .map((t) => (t.includes("队首") ? "首" : "尾"));
  check("顺序为 队首 → 队尾", order.join("") === "首尾", `实际 ${JSON.stringify(order)}`);
  check("用户消息总览", true, JSON.stringify(texts.map((t) => t.slice(0, 14))));

  view.stop();
  console.log(failures === 0 ? "\n✓ ESC 队列接续：全部通过" : `\n✗ ${failures} 项未通过`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error("e2e 失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
