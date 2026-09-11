/**
 * 离线验证：外部服务器令牌流程 + 残留进程租约检测。
 *
 * 不需要 VS Code，也不需要真的起 dsh：
 * - 令牌部分用一个本地 HTTP stub 模拟「要求授权 / 拒绝令牌 / 接受令牌」三种响应，
 *   断言 DshClient 会抛 DshAuthError（控制器据此弹输入框）；
 * - 进程部分直接操作租约模块：写租约 → 扫描 → 清理，用当前进程当「活宿主」、
 *   用一个真实存活的子进程当「dsh 进程」。
 *
 * 运行：npm run test
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { DshAuthError, DshClient } from "../src/dsh/client";
import { clearLease, cleanupResidualServers, isProcessAlive, readLeases, scanServers, writeLease } from "../src/dsh/processRegistry";

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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// 1a. 服务器要求授权、客户端没带令牌 → 401 → DshAuthError
{
  const s = await stub(() => ({ status: 401 }));
  const client = new DshClient(s.baseUrl, undefined, () => {});
  await assert.rejects(() => client.listSessions(), (error: unknown) => error instanceof DshAuthError);
  client.dispose();
  await s.close();
  console.log("token: 无令牌访问受保护服务器 → DshAuthError ✓");
}

// 1b. 带令牌换到 cookie，但 /api 仍拒绝（令牌无效）→ DshAuthError
{
  const s = await stub((token, pathname) => {
    if (pathname === "/") return { status: 200, cookie: true };
    return { status: token === "good" ? 200 : 403 };
  });
  const bad = new DshClient(s.baseUrl, "bad", () => {});
  await bad.authenticate();
  await assert.rejects(() => bad.listSessions(), (error: unknown) => error instanceof DshAuthError);
  bad.dispose();
  await s.close();
  console.log("token: 错误令牌 → DshAuthError ✓");
}

// 1c. 正确令牌：authenticate + listSessions 通过（控制器据此写入 SecretStorage）
{
  const s = await stub((_token, pathname) => {
    if (pathname === "/") return { status: 200, cookie: true };
    return { status: 200 };
  });
  const client = new DshClient(s.baseUrl, "good", () => {});
  await client.authenticate();
  await client.listSessions();
  client.dispose();
  await s.close();
  console.log("token: 有效令牌 → 连接成功 ✓");
}

// 1d. 无认证的老服务器：不带令牌也应放行（authenticate 静默通过）
{
  const s = await stub(() => ({ status: 200 }));
  const client = new DshClient(s.baseUrl, undefined, () => {});
  await client.authenticate();
  await client.listSessions();
  client.dispose();
  await s.close();
  console.log("token: 无认证服务器 → 不带令牌也放行 ✓");
}

// ---------- 2. 残留进程：租约写入 / 扫描 / 清理 ----------

const log = () => {};

/** 起一个存活 60s 的假进程；`args` 会出现在命令行里，用于「是不是 dsh」的判定。 */
async function fakeProcess(args: string[]): Promise<{ pid: number; kill: () => void }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", ...args], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const pid = child.pid;
  assert.ok(pid && isProcessAlive(pid), "测试用子进程应当存活");
  return { pid: pid!, kill: () => child.kill() };
}

// 2a. 宿主还活着（用当前进程 pid）→ 不算孤儿，清理不动它
{
  // 命令行故意带 dsh：证明「宿主存活」这一条优先于「像 dsh」
  const alive = await fakeProcess(["dsh", "web"]);
  try {
    writeLease({ serverPid: alive.pid, hostPid: process.pid, command: "dsh", startedAt: Date.now() });
    const found = scanServers().filter((item) => item.lease.serverPid === alive.pid);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].orphan, false, "宿主存活时不能判为孤儿");
    assert.strictEqual(found[0].heldByLiveHost, true);
    const result = cleanupResidualServers(log);
    assert.ok(!result.killed.includes(alive.pid), "宿主存活时不能被杀");
    assert.ok(isProcessAlive(alive.pid), "宿主存活时进程应当还在");
    console.log("cleanup: 宿主存活 → 不清理 ✓");
  } finally {
    clearLease(alive.pid);
    alive.kill();
  }
}

// 2b. 宿主已消失 → 判为孤儿；命令行不含 dsh → 只清租约、不动进程（防 pid 回收误杀）
{
  // 注意：标记不能以 `-` 开头，否则 node 把它当自己的选项直接退出
  const plain = await fakeProcess(["plain-worker"]);
  try {
    // 用一个几乎不可能存在的 pid 当「死掉的宿主」
    writeLease({ serverPid: plain.pid, hostPid: 999_999_999, command: "node", startedAt: Date.now() });
    const item = scanServers().find((entry) => entry.lease.serverPid === plain.pid);
    assert.ok(item?.orphan, "宿主消失后应判为孤儿");
    assert.strictEqual(item?.confirmed, false, "命令行不含 dsh 时应确认失败");
    const result = cleanupResidualServers(log);
    assert.ok(result.orphans.includes(plain.pid), "应报告这个孤儿");
    assert.ok(result.skipped.includes(plain.pid), "命令行不含 dsh 时应跳过进程、只清租约");
    assert.ok(isProcessAlive(plain.pid), "未确认是 dsh 时不能杀进程");
    assert.strictEqual(
      readLeases().some((entry) => entry.lease.serverPid === plain.pid),
      false,
      "租约应被清掉",
    );
    console.log("cleanup: 宿主消失 + 命令行非 dsh → 只清租约 ✓");
  } finally {
    clearLease(plain.pid);
    plain.kill();
  }
}

// 2c. 命令行确认是 dsh → 杀掉整棵进程树并清租约
{
  const dshLike = await fakeProcess(["dsh", "web", "--port", "0"]);
  writeLease({ serverPid: dshLike.pid, hostPid: 999_999_999, command: "dsh", startedAt: Date.now() });
  const item = scanServers().find((entry) => entry.lease.serverPid === dshLike.pid);
  assert.strictEqual(item?.confirmed, true, "命令行含 dsh 时应确认成功");
  const result = cleanupResidualServers(log);
  assert.ok(result.killed.includes(dshLike.pid), `应杀掉 pid=${dshLike.pid}，实际 killed=${result.killed.join()}`);
  // taskkill /F 是异步生效的，给它一点时间
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.strictEqual(isProcessAlive(dshLike.pid), false, "dsh 进程应已被清理");
  assert.strictEqual(
    readLeases().some((entry) => entry.lease.serverPid === dshLike.pid),
    false,
    "租约应被清掉",
  );
  console.log("cleanup: 宿主消失 + 命令行是 dsh → 杀掉并清租约 ✓");
}

// 2d. 服务器进程已退出 → 租约作废
{
  const gone = spawn(process.execPath, ["-e", "process.exit(0)", "dsh"], { stdio: "ignore", windowsHide: true });
  gone.unref();
  const gonePid = gone.pid!;
  await new Promise((resolve) => setTimeout(resolve, 700));
  writeLease({ serverPid: gonePid, hostPid: 999_999_999, command: "dsh", startedAt: Date.now() });
  const result = cleanupResidualServers(log);
  assert.ok(!result.killed.includes(gonePid), "已退出的进程不该出现在 killed 里");
  assert.strictEqual(
    readLeases().some((entry) => entry.lease.serverPid === gonePid),
    false,
    "死进程的租约应被删除",
  );
  console.log("cleanup: 进程已退出 → 租约作废 ✓");
}

console.log("\nprocessRegistry / token: all assertions passed");
