/**
 * 离线验证：外部服务器令牌流程 + 进程判活。
 *
 * 不需要 VS Code，也不需要真的起 dsh：
 * - 令牌部分用一个本地 HTTP stub 模拟「要求授权 / 拒绝令牌」两种响应，
 *   断言 DshClient 会抛 DshAuthError（控制器据此弹输入框）；
 * - 进程部分只验证 `isProcessAlive`（真实子进程）。
 *
 * **这里曾经还有一大堆"残留进程扫描/清理"的断言，已随该功能一起删除**
 * （用户 2026-09-13：判定不准确，不如不要——见 `src/dsh/processRegistry.ts` 文件头）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { DshAuthError, DshClient } from "../src/dsh/client";
import { isProcessAlive } from "../src/dsh/processRegistry";

// ---------- 1. 令牌：401/403 → DshAuthError ----------

/** 一个极简 stub：/ 发 cookie，/api/* 按令牌给通过（回合法 RPC 信封）或 401/403。 */
async function stub(
  handler: (token: string | undefined, pathname: string) => { status: number; cookie?: boolean },
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cookie = req.headers.cookie as string | undefined;
    const token = url.searchParams.get("token") ?? (cookie ? cookie.replace(/^dsh=/, "") : undefined);
    const outcome = handler(token ?? undefined, url.pathname);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (outcome.cookie) headers["set-cookie"] = "dsh=signed-cookie; Path=/";

    // /api/* 成功时要回一个合法的 server-response 信封（客户端严格校验）
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: unknown = {};
      if (outcome.status === 200 && url.pathname.startsWith("/api/") && chunks.length) {
        try {
          const sent = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rpcId?: string };
          body = { type: "server-response", rpcId: sent.rpcId, result: { ok: true, value: { items: [] } } };
        } catch {
          body = {};
        }
      }
      res.writeHead(outcome.status, headers);
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

{
  const guarded = await stub((token) => (token === "good" ? { status: 200, cookie: true } : { status: 401 }));
  const client = new DshClient(guarded.baseUrl, "bad", () => {});
  let threw = false;
  try {
    await client.listSessions();
  } catch (error) {
    threw = error instanceof DshAuthError;
  }
  assert.ok(threw, "错误令牌必须抛 DshAuthError（控制器据此提示输入令牌）");
  await guarded.close();
  console.log("token: 错误令牌 → DshAuthError ✓");
}

{
  const forbidden = await stub(() => ({ status: 403 }));
  const client = new DshClient(forbidden.baseUrl, "any", () => {});
  let threw = false;
  try {
    await client.listSessions();
  } catch (error) {
    threw = error instanceof DshAuthError;
  }
  assert.ok(threw, "403 同样按「需要令牌」处理");
  await forbidden.close();
  console.log("token: 403 → DshAuthError ✓");
}

// ---------- 2. 进程判活（真实子进程） ----------

{
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.strictEqual(isProcessAlive(child.pid), true, "活着的子进程要判活");
  child.kill();
  await new Promise((resolve) => child.on("close", resolve));
  // 进程表回收有延迟：这里只断言"最终会判死"，不掐秒表
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.strictEqual(isProcessAlive(child.pid), false, "已退出的进程不能判活");
  assert.strictEqual(isProcessAlive(undefined), false, "没有 pid 时判死而不是抛");
  console.log("process: 进程判活（真实子进程 / 无 pid）✓");
}

console.log("\nprocessRegistry / token: all assertions passed");
