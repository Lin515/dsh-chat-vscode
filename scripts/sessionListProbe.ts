/**
 * 探针：`session/list` 里**分支（fork）出来的会话**长什么样。
 *
 * 背景（用户 2026-09-12 反馈）：「创建了分支，但新分支会话不会在会话历史里显示」。
 * 扩展侧 `refreshSessions()` 把「有 `parentSessionId` 或有 `origin`」的行整个滤掉了——
 * 那条过滤的本意是藏起**子代理**会话，却把分支一起藏了。
 *
 * 契约（`dsh-api-session-controller/lib/types/types.d.ts` 的 `SessionSummary`）：
 *   parentSessionId?: SessionId;   // 分支与子代理**都会有**
 *   origin?: 'subagent';           // 只有子代理有 —— 这才是该过滤的判据
 * 这里用真实服务端把这条钉死：fork 出来的子会话确实在列表里、
 * `parentSessionId` 指向源会话、`origin` 为空。
 *
 * 运行：npm run build:scripts && node build/session-list-probe.mjs
 */
import { randomUUID } from "node:crypto";
import { SessionAdapter } from "../src/dsh/adapter";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const log = (line: string) => console.log(`[list-probe] ${line}`);
const server = new SupervisorManager({ url: "", command: "dsh", log });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let client: DshClient | undefined;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function until(test: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test()) return true;
    await wait(stepMs);
  }
  return test();
}

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  // ---------- 源会话 + 一个已完成的轮次（fork 的锚点是 turn/end） ----------
  const parent = (await client.createSession(process.cwd())).sessionId;
  const adapter = new SessionAdapter(() => {});
  let ended = false;
  const follow = client.followSession(parent, {
    onItem: (value) => {
      const frame = value as { type?: string; event?: { type?: string } };
      if (frame?.type === "event" && frame.event) {
        adapter.applyEvent(frame.event as never);
        if (frame.event.type === "turn/end") ended = true;
      }
    },
  });
  await client.prompt(parent, [{ type: "text", text: "只回复两个字：收到" }], "queue", randomUUID());
  const finished = await until(() => ended, 120_000, 300);
  follow.cancel();
  check("源会话产生了一个已完成的轮次", finished, finished ? "" : "（2 分钟内没等到 turn/end）");

  // ---------- 建分支 ----------
  const forked = await client.request<{ sessionId?: string }>("session/fork", {
    request: { sessionId: parent },
  });
  const child = forked?.sessionId;
  check("session/fork 返回子会话 id", typeof child === "string" && child.length > 0, String(child));

  // ---------- 列表里的 lineage 字段 ----------
  const listed = await client.listSessions();
  const items = listed.items ?? [];
  const parentRow = items.find((item) => item.sessionId === parent);
  const childRow = child ? items.find((item) => item.sessionId === child) : undefined;

  console.log("\n   列表里两行的原始字段：");
  for (const [label, row] of [["父", parentRow], ["子", childRow]] as const) {
    console.log(
      `     ${label} ${row?.sessionId ?? "（不在列表里）"} parentSessionId=${row?.parentSessionId ?? "-"} ` +
        `origin=${row?.origin ?? "-"} blank=${row?.blank} cwd=${row?.cwd}`,
    );
  }

  check("分支出现在 session/list 里", Boolean(childRow), childRow ? "" : "→ 扩展过滤掉的就是它");
  check(
    "分支行的 parentSessionId 指向源会话（所以「有 parent 就滤掉」是错的判据）",
    childRow?.parentSessionId === parent,
    `parentSessionId=${childRow?.parentSessionId ?? "-"}`,
  );
  check(
    "分支行的 origin 不是 'subagent'（判据应是 origin，不是 parent）",
    childRow?.origin === undefined,
    `origin=${String(childRow?.origin)}`,
  );
  check("源会话行本身没有 parent", parentRow?.parentSessionId === undefined);

  await client.archiveSession(parent).catch(() => undefined);
  if (child) await client.archiveSession(child).catch(() => undefined);
} catch (error) {
  console.error("list-probe 失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}

console.log(failures === 0 ? "\n✓ 分支在 session/list 里的形状：符合契约" : `\n✗ ${failures} 项未通过`);
if (failures > 0) process.exitCode = 1;
