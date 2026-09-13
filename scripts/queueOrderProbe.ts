/**
 * 探针：队列消息被服务端自动派发时，帧的**真实到达顺序**与适配器的折叠结果。
 *
 * 背景（用户 2026-09-14 报告）：队列消息自动发出后，「生成内容在用户消息上方继续
 * 生成」——用户消息错位到正在生成的内容上方/下方，而且之后普通发送的消息也跟着
 * 错位。用户记得「之前没有这种情况」；`alreadyHasTurnPrompt` 启发式是 09-12
 * （9679a64）引入的。本探针把派发时刻的帧序与折叠结果变成可复现的证据：
 *
 *  1. 服务端派发队列项时，durable 事件的落盘顺序是
 *     `turn/end(N) → user/message(Q) → turn/start(N+1)`，
 *     还是 `user/message(Q)` 先于 `turn/end(N)`（= 派发发生在轮结束之前）？
 *  2. 按真实到达序（含瞬态流式帧）回放给 SessionAdapter，折叠出的消息顺序是否正确？
 *  3. 只按 durable 事件 seq 序重折（refold 的口径），结果是否一致？
 *
 * 运行：npm run build:scripts && node build/queue-order-probe.mjs
 */
import { randomUUID } from "node:crypto";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";
import { SessionAdapter } from "../src/dsh/adapter";

const log = (line: string) => console.log(`[probe] ${line}`);
const server = new SupervisorManager({ url: "", command: "dsh", startTimeoutMs: 120_000, log });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 慢轮：足够长，保证队列项派发时刻可以落在它的生成中途/刚结束。 */
const SLOW = "请从 1 数到 40，每个数字单独一行，不要省略。";
const QUEUED = "【QUEUED】只回复两个字：收到";

interface FrameRecord {
  kind: string; // "event"（durable）| 其它（瞬态/投影）
  type: string;
  seq?: number;
  turn?: number;
  snippet?: string;
  raw: unknown;
}

let client: DshClient | undefined;

function describe(value: unknown): FrameRecord {
  const frame = value as { type?: string; event?: { type?: string; seq?: number; data?: any; time?: number } };
  if (frame?.type === "event" && frame.event) {
    const event = frame.event as { type: string; seq: number; data: any };
    let snippet: string | undefined;
    if (event.type === "user/message") {
      const blocks = (event.data?.content ?? []) as { type?: string; text?: string }[];
      snippet = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .slice(0, 40);
    }
    return { kind: "event", type: event.type, seq: event.seq, turn: event.data?.turn, snippet, raw: value };
  }
  const type = String(frame?.type ?? "?");
  const turn = (frame as any)?.turn;
  return { kind: type === "snapshot" ? "snapshot" : "live", type, turn, raw: value };
}

function summarize(adapter: SessionAdapter): string[] {
  return adapter.snapshotMessages().map((m) => {
    const first = m.segments.find((s) => s.kind === "text" || s.kind === "thinking") as
      | { kind: string; text?: string }
      | undefined;
    const preview = (first?.text ?? m.text ?? "").slice(0, 30).replace(/\n/g, "\\n");
    const streaming = (m as any).streaming ? " [streaming]" : "";
    return `${m.id}(${m.role[0]})${streaming} "${preview}"`;
  });
}

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  const { sessionId } = await client.createSession(process.cwd());
  const frames: FrameRecord[] = [];
  const adapter = new SessionAdapter((frame) => {
    // 界面会收到的帧先记账（顺序即真实推送顺序）
    const f = frame as { type?: string };
    if (f?.type === "messages/reset" || f?.type === "message/append" || f?.type === "message/upsert") {
      // 只记折叠结果变化的信号，细节最后用 snapshotMessages 汇总
    }
  });
  const follow = client.followSession(sessionId, {
    onItem: (value) => {
      const record = describe(value);
      frames.push(record);
      adapter.applyFrame(value as never);
    },
  });
  await wait(500);

  // 1) 慢轮跑起来
  await client.prompt(sessionId, [{ type: "text", text: SLOW }], "queue", randomUUID());
  await wait(4000); // 让慢轮进入稳定生成期

  // 2) 运行中排入一条（webview 在运行中提交用的就是 queue 模式）
  const markerAt = frames.length;
  await client.prompt(sessionId, [{ type: "text", text: QUEUED }], "queue", randomUUID());

  // 3) 等队列派发并跑完：turn/start 出现两次且不再 running
  const deadline = Date.now() + 120_000;
  let turnStarts = 0;
  while (Date.now() < deadline) {
    turnStarts = frames.filter((f) => f.kind === "event" && f.type === "turn/start").length;
    const ends = frames.filter((f) => f.kind === "event" && f.type === "turn/end").length;
    if (turnStarts >= 2 && ends >= 2) break;
    await wait(500);
  }
  await wait(1500);
  follow.cancel();

  // ---- 证据 1：派发时刻附近的 durable 事件顺序 ----
  console.log("\n=== durable 事件顺序（全量） ===");
  for (const f of frames) {
    if (f.kind !== "event") continue;
    const tail = f.snippet ? ` "${f.snippet}"` : "";
    console.log(`  seq=${String(f.seq).padStart(4)} ${f.type}${f.turn !== undefined ? ` turn=${f.turn}` : ""}${tail}`);
  }

  console.log("\n=== 排队提交之后的全部帧（含瞬态） ===");
  frames.slice(markerAt).forEach((f, i) => {
    const tail = f.snippet ? ` "${f.snippet}"` : "";
    console.log(`  +${String(i).padStart(2)} ${f.kind}/${f.type}${f.turn !== undefined ? ` turn=${f.turn}` : ""}${tail}`);
  });

  // ---- 证据 2：真实到达序的折叠结果 ----
  console.log("\n=== 折叠结果（真实到达序回放） ===");
  for (const line of summarize(adapter)) console.log(`  ${line}`);

  // ---- 证据 3：seq 序重折（refold 口径） ----
  const adapter2 = new SessionAdapter(() => undefined);
  const durable = frames
    .filter((f) => f.kind === "event")
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const f of durable) {
    adapter2.applyEvent((f.raw as { event: unknown }).event as never);
  }
  console.log("\n=== 折叠结果（durable seq 序重折 = 重开会的口径） ===");
  for (const line of summarize(adapter2)) console.log(`  ${line}`);

  console.log("\n[probe] 观察完毕（本探针只出证据，不做硬断言）");
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
