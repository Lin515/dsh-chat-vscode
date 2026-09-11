/**
 * 探针：dump 一个真实会话里的 `system/message` 事件，看清「自动载入的提示词」
 * 到底长什么样、有多少、每次是否重复。
 *
 * 结论将决定界面怎么呈现（尤其：系统提示词每轮都会重发吗？要不要去重？）。
 *
 * 运行：npm run build:scripts && node build/system-prompt-probe.mjs
 */
import { DshClient } from "../src/dsh/client";
import { ServerManager } from "../src/dsh/serverManager";

const log = () => {};
const server = new ServerManager({ url: "", command: "dsh", startTimeoutMs: 120_000, log });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WireEvent {
  type: string;
  seq: number;
  time: number;
  data: any;
  surfaceOp?: unknown;
}

const events: WireEvent[] = [];

let client: DshClient | undefined;
try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  const { sessionId } = await client.createSession(process.cwd());
  const follow = client.followSession(sessionId, {
    onItem: (value) => {
      const frame = value as { type?: string; event?: WireEvent };
      if (frame?.type === "event" && frame.event) events.push(frame.event);
    },
  });
  await wait(800);

  // 跑多轮：观察哪些注入是「每轮都有」的（这决定界面会不会累积）
  const TURNS = 6;
  for (let i = 1; i <= TURNS; i++) {
    await client.prompt(sessionId, [{ type: "text", text: `只回复：${i}` }], "queue", crypto.randomUUID());
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ends = events.filter((e) => e.type === "turn/end").length;
      const starts = events.filter((e) => e.type === "turn/start").length;
      if (ends >= starts && starts > 0) break;
      await wait(400);
    }
    await wait(1200);
  }
  follow.cancel();

  const systems = events.filter((e) => e.type === "system/message");
  console.log(`\n=== system/message：共 ${systems.length} 条 ===\n`);

  for (const event of systems) {
    const message = event.data?.message;
    const text = (message?.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const source = message?.source ?? {};
    const op = typeof event.surfaceOp === "string" ? event.surfaceOp : JSON.stringify(event.surfaceOp);
    console.log(
      JSON.stringify({
        seq: event.seq,
        turn: event.data?.turn,
        step: event.data?.step,
        surfaceOp: op,
        sourceKind: source.kind,
        plugin: source.plugin ?? source.name ?? source.id ?? null,
        sourceKeys: Object.keys(source),
        chars: text.length,
        head: text.slice(0, 120).replace(/\n/g, "⏎"),
      }),
    );
  }

  // 按来源聚合，看去重潜力
  console.log("\n=== 按 source 聚合 ===");
  const bySource = new Map<string, { count: number; chars: number[]; texts: string[] }>();
  for (const event of systems) {
    const message = event.data?.message;
    const text = (message?.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const key = JSON.stringify(message?.source ?? {});
    const entry = bySource.get(key) ?? { count: 0, chars: [], texts: [] };
    entry.count++;
    entry.chars.push(text.length);
    entry.texts.push(text);
    bySource.set(key, entry);
  }
  for (const [key, entry] of bySource) {
    const identical = entry.texts.every((t) => t === entry.texts[0]);
    console.log(`  ${key}  ×${entry.count}  字符数=${entry.chars.join(",")}  内容全同=${identical}`);
  }

  console.log(`\n全部事件类型：${[...new Set(events.map((e) => e.type))].join(", ")}`);

  // ---- 关键：user/message 里哪些不是「人说的话」？----
  console.log("\n=== user/message 按 source 分类 ===");
  const users = events.filter((e) => e.type === "user/message");
  for (const event of users) {
    const message = event.data ?? {};
    const text = (message.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    console.log(
      JSON.stringify({
        seq: event.seq,
        source: message.source ?? null,
        chars: text.length,
        head: text.slice(0, 90).replace(/\n/g, "⏎"),
      }),
    );
  }

  // ---- agent/inbox/spliced：插件把内容塞进收件箱 ----
  console.log("\n=== agent/inbox/spliced ===");
  for (const event of events.filter((e) => e.type === "agent/inbox/spliced")) {
    const data = event.data ?? {};
    const inserted = Array.isArray(data.inserted) ? data.inserted : [];
    console.log(
      JSON.stringify({
        seq: event.seq,
        target: data.target,
        start: data.start,
        removedCount: data.removedCount,
        outcome: data.outcome,
        inserted: inserted.map((m: any) => ({
          source: m?.source ?? null,
          chars: (m?.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("").length,
          head: (m?.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("")
            .slice(0, 80)
            .replace(/\n/g, "⏎"),
        })),
      }),
    );
  }
  // ---- 累积量化：每种注入共出现几次、总字符数、以及界面会渲染出多少个节点 ----
  console.log("\n=== 累积量化（界面会渲染成多少个「自动载入」节点）===");
  // 界面侧只认这两类：system/message，以及 source.kind !== 'user' 的 user/message
  const injectedEvents = events.filter((e) => {
    if (e.type === "system/message") return true;
    if (e.type !== "user/message") return false;
    const kind = e.data?.source?.kind;
    return kind !== "user" && kind !== "user-rpc";
  });

  let totalChars = 0;
  const perForm = new Map<string, { count: number; chars: number }>();
  for (const e of injectedEvents) {
    const content = e.type === "system/message" ? e.data?.message?.content : e.data?.content;
    const source = e.type === "system/message" ? e.data?.message?.source : e.data?.source;
    const text = (content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    totalChars += text.length;
    const key = `${source?.kind ?? "?"}${source?.plugin ? `/${source.plugin}` : ""}${source?.form ? `#${source.form}` : ""}`;
    const entry = perForm.get(key) ?? { count: 0, chars: 0 };
    entry.count++;
    entry.chars += text.length;
    perForm.set(key, entry);
  }

  console.log(`  轮数：${events.filter((e) => e.type === "turn/start").length}`);
  console.log(`  注入节点总数：${injectedEvents.length}`);
  console.log(`  注入内容总字符：${totalChars}`);
  console.log("  按来源：");
  for (const [key, entry] of [...perForm].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${key}  ×${entry.count}  共 ${entry.chars} 字符`);
  }
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
