/**
 * 探针：真实 `read` 工具调用的 `tool/result.meta` 长什么样，以及适配器最终
 * 把读取节点的 detail 算成了什么。
 *
 * 关键要验证两件事：
 * 1. `presentationMeta` 真的随 `tool/result.meta` 送达（否则只能靠正文尾注回退）；
 * 2. 部分读取会被缀上行号（`…/file.ts:100-120`），整篇读取不被缀。
 *
 * 运行：npm run build:scripts && node build/read-range-probe.mjs
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import { DshClient } from "../src/dsh/client";
import { ServerManager } from "../src/dsh/serverManager";
import type { ToolCallView } from "../src/shared/chat";

const log = () => {};
const server = new ServerManager({ url: "", command: "dsh", startTimeoutMs: 120_000, log });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 拿一个确实很长的文件，保证能演示「部分读取」。 */
function pickTarget(): { path: string; lines: number } {
  const candidates = [
    join(process.cwd(), "src", "dsh", "controller.ts"),
    join(process.cwd(), "src", "dsh", "adapter.ts"),
    join(process.cwd(), "src", "webview", "styles", "app.css"),
  ];
  for (const path of candidates) {
    try {
      const lines = readFileSync(path, "utf8").split("\n").length;
      if (lines > 400) return { path, lines };
    } catch {
      // 换下一个
    }
  }
  throw new Error("找不到足够长的文件做探针");
}

/** 收集每次 tool/result 的 meta，供事后核对形状。 */
const metas: { name: string; meta: unknown }[] = [];
const namesByCall = new Map<string, string>();

let client: DshClient | undefined;
try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  const { sessionId } = await client.createSession(process.cwd());

  // 适配器照常折叠事件，同时把 tool/result 的 meta 抓下来
  const adapter = new SessionAdapter(() => {});
  const follow = client.followSession(sessionId, {
    onItem: (value) => {
      const frame = value as { type?: string; event?: { type?: string; data?: any } };
      if (frame?.type !== "event" || !frame.event) return;
      const event = frame.event;
      if (event.type === "tool/call") {
        namesByCall.set(String(event.data?.callId ?? ""), String(event.data?.name ?? ""));
      }
      if (event.type === "tool/result") {
        const callId = String(event.data?.message?.source?.callId ?? "");
        metas.push({ name: namesByCall.get(callId) ?? "?", meta: event.data?.meta });
      }
      adapter.applyEvent(event as never);
    },
  });
  await wait(800);

  const target = pickTarget();
  console.log(`目标文件：${target.path}（约 ${target.lines} 行）`);

  const ask = (text: string) =>
    client!.prompt(sessionId, [{ type: "text", text }], "queue", crypto.randomUUID());

  const toolCount = () =>
    adapter
      .snapshotMessages()
      .flatMap((m) => m.segments)
      .filter((s) => s.kind === "tool").length;

  const runningTools = () =>
    adapter
      .snapshotMessages()
      .flatMap((m) => m.segments)
      .filter((s): s is Extract<typeof s, { kind: "tool" }> => s.kind === "tool")
      .map((s) => s.tool)
      .filter((t) => !t.endedAt).length;

  /** 等「新出现的工具调用」跑完（不能只看「所有工具都已结束」——旧的那批早就结束了）。 */
  const settle = async (before: number) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (toolCount() > before && runningTools() === 0) return;
      await wait(500);
    }
  };

  // 1) 部分读取：明确要求 offset/limit
  let before = toolCount();
  await ask(
    `用 read 工具读取 ${target.path} 的第 100 到第 120 行` +
      `（即 offset=100, limit=21），不要读其它范围。完成后只回复：OK`,
  );
  await settle(before);
  await wait(1500);

  const partialTools = adapter
    .snapshotMessages()
    .flatMap((m) => m.segments)
    .filter((s): s is Extract<typeof s, { kind: "tool" }> => s.kind === "tool")
    .map((s) => s.tool);

  console.log("\n=== 部分读取 ===");
  for (const tool of partialTools) {
    console.log(
      `  ${JSON.stringify({ name: tool.name, detail: tool.detail, readLines: tool.readLines, status: tool.status })}` +
        `\n    → 界面显示：${tool.detail}${tool.readLines ? `:${tool.readLines.start}-${tool.readLines.end}` : "（无行号）"}`,
    );
  }

  console.log("\n=== tool/result.meta 形状 ===");
  for (const entry of metas) {
    const meta = entry.meta as Record<string, unknown> | undefined;
    if (!meta) {
      console.log(`  ${entry.name}: meta = ${String(entry.meta)}`);
      continue;
    }
    const lines = Array.isArray(meta.lines) ? meta.lines : undefined;
    console.log(
      `  ${entry.name}: keys=[${Object.keys(meta).join(",")}]` +
        ` offset=${String(meta.offset)} totalLines=${String(meta.totalLines)}` +
        ` lines=${lines ? `${lines.length} 条（首 ${JSON.stringify((lines[0] as any)?.number)} 末 ${JSON.stringify((lines[lines.length - 1] as any)?.number)}）` : "无"}`,
    );
  }

  // 2) 整篇读取：不加行号后缀
  before = toolCount();
  await ask(`用 read 工具读取 ${process.cwd()}\\package.json（不传 offset 和 limit）。完成后只回复：OK`);
  await settle(before);
  await wait(1500);

  const allTools = adapter
    .snapshotMessages()
    .flatMap((m) => m.segments)
    .filter((s): s is Extract<typeof s, { kind: "tool" }> => s.kind === "tool")
    .map((s) => s.tool);
  console.log("\n=== 整篇读取（应无行号）===");
  for (const tool of allTools.slice(partialTools.length)) {
    console.log(
      `  ${JSON.stringify({ name: tool.name, detail: tool.detail, readLines: tool.readLines, status: tool.status })}` +
        `\n    → 界面显示：${tool.detail}${tool.readLines ? `:${tool.readLines.start}-${tool.readLines.end}` : "（无行号）"}`,
    );
  }

  follow.cancel();
  console.log(`\n目标文件实际大小：${statSync(target.path).size} 字节`);
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
