/**
 * 段顺序的**活路径**端到端证据（用户 2026-09-15 报的「思考/正文与工具行错位」）。
 *
 *   node build/render-order-probe.mjs --live
 *
 * 为什么要真跑一轮：错位只在**流式路径**上出现——模型边说边吐工具调用，
 * `tool-call-delta` 会先把工具行建出来，该 step 的 durable `assistant/message`
 * （思考/正文）随后才到。离线重放（`--session`）的顺序本来就是对的，单元测试用的
 * 也是**合成**的帧序，所以这里再对着真实服务器跑一轮，验证：
 *
 *   1. 服务端确实会在 durable `assistant/message` **之前**推 `tool-call-delta`；
 *   2. 修好之后，同一个 step 里**没有工具行排在该 step 的思考/正文之前**。
 *
 * 会往本机 DSH 里建一条测试会话并真发一次模型请求（与 smoke / commandE2E 同口径）。
 */
import { SessionAdapter } from "../src/dsh/adapter";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";
import type { MessageView, Segment } from "../src/shared/chat";

export async function liveOrderCheck(): Promise<number> {
  const log = (line: string) => console.log(`[live] ${line}`);
  const server = new SupervisorManager({ url: "", command: "dsh", startTimeoutMs: 180_000, log });
  let client: DshClient | undefined;
  let failures = 0;
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  try {
    const info = await server.ensure();
    client = new DshClient(info.baseUrl, info.token, log);
    await client.authenticate();
    client.connect();
    const { sessionId } = await client.createSession(process.cwd());
    log(`会话 ${sessionId}`);

    const adapter = new SessionAdapter(() => {});
    /** 帧到达顺序：记「活路径先建工具行」这件事本身。 */
    const arrivals: string[] = [];
    const liveAdapter = new SessionAdapter((frame) => {
      if (frame.type === "message/append") {
        arrivals.push(
          frame.segment.kind === "tool" ? `live-tool:${frame.segment.tool.name}` : `live-${frame.segment.kind}`,
        );
      }
    });

    let done = false;
    const follow = client.followSession(sessionId, {
      onItem: (value) => {
        const frame = value as { type?: string };
        // 两份适配器：一份只为记「帧到达顺序」，一份用来断言最终段顺序。
        // **两份都必须喂 follow 帧**（`snapshot` / `event` / `assistant-stream`）；
        // 给 adapter 喂 liveAdapter 的**出帧**是错的——出帧是 HostToWebview 形状，
        // applyFrame 全都不认，adapter 会一直是空的（断言就成了空断言）。
        liveAdapter.applyFrame(value as never);
        adapter.applyFrame(value as never);
        if (frame?.type === "event") {
          const event = (value as { event?: { type?: string } }).event;
          arrivals.push(`event:${event?.type}`);
          if (event?.type === "turn/end") done = true;
        }
      },
    });

    await client.prompt(
      sessionId,
      [
        {
          type: "text",
          text:
            "先用一句话说明你打算怎么做，然后读取 package.json 的前 12 行，" +
            "再读取 tsconfig.json 的前 12 行，最后用一句话告诉我 package.json 里的 name。",
        },
      ],
      "queue",
    );

    const deadline = Date.now() + 180_000;
    while (!done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    follow.cancel();
    check(done, "这一轮跑完了（turn/end 到达）");

    // 1) 服务端真的会在 durable assistant/message 之前推 tool-call-delta？
    const firstToolArrival = arrivals.findIndex((item) => item.startsWith("live-tool:"));
    const firstDurableMsg = arrivals.findIndex((item) => item === "event:assistant/message");
    check(
      firstToolArrival >= 0,
      "活路径确实从 `tool-call-delta` 先建出了工具行（这正是错位的来源）",
      `到达序列前 14 项：${arrivals.slice(0, 14).join(" → ")}`,
    );
    check(
      firstToolArrival >= 0 && firstDurableMsg >= 0 && firstToolArrival < firstDurableMsg,
      "工具行早于 durable assistant/message 到达（所以「追加到末尾」必然错位）",
      `live-tool@${firstToolArrival} vs assistant/message@${firstDurableMsg}`,
    );

    // 2) 最终段顺序：同一个 step 里不能有工具行排在该 step 的思考/正文之前
    const messages: MessageView[] = adapter.snapshotMessages();
    const offenders: string[] = [];
    for (const message of messages) {
      const firstTool = new Map<number, number>();
      const firstText = new Map<number, number>();
      message.segments.forEach((segment: Segment, index) => {
        const step = segment.step ?? -1;
        if (segment.kind === "tool" && !firstTool.has(step)) firstTool.set(step, index);
        if ((segment.kind === "text" || segment.kind === "thinking") && !firstText.has(step)) {
          firstText.set(step, index);
        }
      });
      for (const [step, toolIndex] of firstTool) {
        const textIndex = firstText.get(step);
        if (textIndex !== undefined && toolIndex < textIndex) {
          offenders.push(`${message.id} step=${step}: 工具行@${toolIndex} 早于 思考/正文@${textIndex}`);
        }
      }
    }
    check(
      offenders.length === 0,
      "同一个 step 里没有工具行排在思考/正文之前",
      offenders.length ? offenders.join("\n      ") : "",
    );

    const target = [...messages].reverse().find((message) => message.role === "assistant" && message.segments.length);
    console.log(`\n  最终段顺序（${target?.id ?? "?"}）：`);
    target?.segments.forEach((segment: Segment, index) => {
      const step = segment.step ?? "?";
      const label =
        segment.kind === "tool"
          ? `tool:${segment.tool.name}`
          : segment.kind === "text" || segment.kind === "thinking"
            ? `${segment.kind}(${String(segment.text ?? "").slice(0, 24).replace(/\n/g, " ")})`
            : segment.kind;
      console.log(`    [${String(index).padStart(2, " ")}] step=${step} ${label}`);
    });
  } catch (error) {
    check(false, "活路径探针执行失败", error instanceof Error ? error.message : String(error));
  } finally {
    client?.dispose();
    server.stop();
  }
  console.log(failures ? `\n活路径顺序：失败 ${failures} 项` : "\n活路径顺序：全部通过");
  return failures;
}

// 直接运行（`node build/render-order-probe.mjs --live`）时才跑；被 import 时不跑
if (process.argv.includes("--live")) {
  const failures = await liveOrderCheck();
  process.exitCode = failures ? 1 : 0;
}
