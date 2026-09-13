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
import {
  clearHostLease,
  clearLease,
  cleanupResidualServers,
  isKillable,
  isProcessAlive,
  parseProcessList,
  readLeases,
  resetCommandLineCache,
  scanServers,
  shellCallCount,
  writeHostLease,
  writeLease,
} from "../src/dsh/processRegistry";

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

/**
 * 轮询等待条件成立。
 *
 * 取代原来的固定 `setTimeout`：既有的 400/700/1500ms 三处硬等占了本测试一半以上
 * 时间，而且慢机器上还可能不够。轮询通常在 30ms 内就满足，慢机器上会一直等到超时。
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`等待超时（${timeoutMs}ms）：${label}`);
}

/** 起一个存活 60s 的假进程；`args` 会出现在命令行里，用于「是不是 dsh」的判定。 */
async function fakeProcess(args: string[]): Promise<{ pid: number; kill: () => void }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", ...args], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const pid = child.pid;
  assert.ok(pid, "子进程应当有 pid");
  await waitFor(() => isProcessAlive(pid), "子进程应当存活");
  // 进程表里出现该进程的行需要一点时间，命令行快照才认得它
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(isProcessAlive(pid), "测试用子进程应当存活");
  return { pid: pid!, kill: () => child.kill() };
}

// 2a. 有活着的扩展实例（心跳文件）→ 不算孤儿，清理不动它
{
  // 命令行故意带 dsh：证明「有人在用」这一条优先于「像 dsh」。
  // 注意判据是**实例心跳文件**，不是租约里的 hostPid——多窗口共享之后，
  // "当初拉起它的宿主还在不在"已经不是问题所在（owner 先关、别人还在用是正常的）。
  const alive = await fakeProcess(["dsh", "web"]);
  try {
    writeLease({ serverPid: alive.pid, hostPid: process.pid, command: "dsh", startedAt: Date.now() });
    writeHostLease({ hostId: "cleanup-2a", serverPid: alive.pid });
    const found = (await scanServers()).filter((item) => item.lease.serverPid === alive.pid);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].orphan, false, "有活实例时不能判为孤儿");
    assert.strictEqual(found[0].heldByLiveHost, true);
    const result = await cleanupResidualServers(log);
    assert.ok(!result.killed.includes(alive.pid), "有活实例时不能被杀");
    assert.ok(isProcessAlive(alive.pid), "有活实例时进程应当还在");
    console.log("cleanup: 有活实例 → 不清理 ✓");
  } finally {
    clearHostLease("cleanup-2a");
    clearLease(alive.pid);
    alive.kill();
  }
}

// 2b. 宿主已消失 → 判为孤儿；命令行不含 dsh → 只清租约、不动进程（防 pid 回收误杀）
//
// 这里放**两个**孤儿，顺便钉住「一次扫描只起一次 PowerShell」的批量化不变量：
// 逐个 pid 查的话 Windows 上每次都要付 ~1600ms 的解释器启动成本
// （实测：单查一个 pid 约 1600ms，一次查全部进程约 1800ms），
// 于是 N 个孤儿 = N×1600ms。本文件曾因此慢到 11.6s。
{
  resetCommandLineCache();
  // 注意：标记不能以 `-` 开头，否则 node 把它当自己的选项直接退出
  const plain = await fakeProcess(["plain-worker"]);
  const plain2 = await fakeProcess(["plain-worker-2"]);
  try {
    // 用一个几乎不可能存在的 pid 当「死掉的宿主」
    for (const pid of [plain.pid, plain2.pid]) {
      writeLease({ serverPid: pid, hostPid: 999_999_999, command: "node", startedAt: Date.now() });
    }
    resetCommandLineCache();
    // 异步不变量：调用必须**立刻**返回，把 1.5s 的 PowerShell 查询交给事件循环。
    // 退回 spawnSync 时这一段会阻塞 1500ms 以上（扩展宿主会卡住）。
    const scanStarted = Date.now();
    const scannedPromise = scanServers();
    const scanSyncMs = Date.now() - scanStarted;
    assert.ok(
      scanSyncMs < 250,
      `scanServers 应当立刻返回（同步段只读租约文件），实际阻塞 ${scanSyncMs}ms——` +
        `退回 spawnSync 会卡住扩展宿主约 1.5s`,
    );
    const scanned = (await scannedPromise).filter(
      (entry) => entry.lease.serverPid === plain.pid || entry.lease.serverPid === plain2.pid,
    );
    assert.strictEqual(scanned.length, 2, "两个孤儿都该被扫到");
    assert.ok(
      scanned.every((entry) => entry.orphan),
      "宿主消失后应判为孤儿",
    );
    assert.ok(
      scanned.every((entry) => entry.confirmed === false),
      "命令行不含 dsh 时应确认失败",
    );
    const shellCalls = shellCallCount();
    assert.strictEqual(
      shellCalls,
      1,
      `两个孤儿只应起一次 PowerShell（批量取全部命令行），实际起了 ${shellCalls} 次——` +
        `退回逐个查会让每次扫描慢 N×1600ms`,
    );

    // 缓存命中（上一个 scanServers 刚取过），这里不再起 PowerShell
    const result = await cleanupResidualServers(log);
    for (const pid of [plain.pid, plain2.pid]) {
      assert.ok(result.orphans.includes(pid), "应报告这个孤儿");
      assert.ok(result.skipped.includes(pid), "命令行不含 dsh 时应跳过进程、只清租约");
      assert.ok(isProcessAlive(pid), "未确认是 dsh 时不能杀进程");
      assert.strictEqual(
        readLeases().some((entry) => entry.lease.serverPid === pid),
        false,
        "租约应被清掉",
      );
    }
    console.log("cleanup: 宿主消失 + 命令行非 dsh → 只清租约 ✓");
    console.log("cleanup: 多个孤儿只起一次 PowerShell（批量）✓");
  } finally {
    clearLease(plain.pid);
    clearLease(plain2.pid);
    plain.kill();
    plain2.kill();
  }
}

// 2c. 命令行确认是 dsh → 杀掉整棵进程树并清租约
{
  const dshLike = await fakeProcess(["dsh", "web", "--port", "0"]);
  writeLease({ serverPid: dshLike.pid, hostPid: 999_999_999, command: "dsh", startedAt: Date.now() });
  // 先清缓存，让下面的 cleanup 必须真起一次 PowerShell——这样「同步段不阻塞」的
  // 断言才是在有真实进程查询的前提下测的（缓存命中时它当然立刻就返回）
  resetCommandLineCache();
  // 异步不变量：cleanup 也必须立刻返回，把查询与 taskkill 都交给事件循环
  const cleanupStarted = Date.now();
  const cleanupPromise = cleanupResidualServers(log);
  const cleanupSyncMs = Date.now() - cleanupStarted;
  assert.ok(
    cleanupSyncMs < 250,
    `cleanupResidualServers 应当立刻返回，实际阻塞 ${cleanupSyncMs}ms——` +
      `它的同步段只该读租约文件，进程查询必须 await`,
  );
  const result = await cleanupPromise;
  assert.ok(result.killed.includes(dshLike.pid), `应杀掉 pid=${dshLike.pid}，实际 killed=${result.killed.join()}`);
  // taskkill /F 返回不等于进程已经消失，轮询等它真的不见
  await waitFor(() => !isProcessAlive(dshLike.pid), `pid=${dshLike.pid} 应被清理`);
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
  await waitFor(() => !isProcessAlive(gonePid), "子进程应当已退出");
  writeLease({ serverPid: gonePid, hostPid: 999_999_999, command: "dsh", startedAt: Date.now() });
  const result = await cleanupResidualServers(log);
  assert.ok(!result.killed.includes(gonePid), "已退出的进程不该出现在 killed 里");
  assert.strictEqual(
    readLeases().some((entry) => entry.lease.serverPid === gonePid),
    false,
    "死进程的租约应被删除",
  );
  console.log("cleanup: 进程已退出 → 租约作废 ✓");
}

// 2f. 并发扫描共享同一次 PowerShell（single-flight）
//
// 改成异步后，两个并发调用（例如启动清理与「显示诊断信息」同时触发）会各自
// 起一次 PowerShell——异步本是为了不卡主线程，却可能因此起两倍解释器。
// 这里钉住「并发只起一次」。
{
  const a = await fakeProcess(["plain-c"]);
  const b = await fakeProcess(["plain-d"]);
  try {
    for (const pid of [a.pid, b.pid]) {
      writeLease({ serverPid: pid, hostPid: 999_999_999, command: "node", startedAt: Date.now() });
    }
    resetCommandLineCache();
    // 不 await 第一个，紧接着发第二个：两者必须共享在途查询
    const first = scanServers();
    const second = scanServers();
    const [one, two] = await Promise.all([first, second]);
    for (const pid of [a.pid, b.pid]) {
      assert.ok(
        one.some((entry) => entry.lease.serverPid === pid && entry.confirmed === false),
        "第一次扫描应含该孤儿",
      );
      assert.ok(
        two.some((entry) => entry.lease.serverPid === pid && entry.confirmed === false),
        "第二次扫描应含该孤儿",
      );
    }
    const calls = shellCallCount();
    assert.strictEqual(
      calls,
      1,
      `并发扫描应共享同一次 PowerShell，实际起了 ${calls} 次——异步化后没做 single-flight 就会翻倍`,
    );
    console.log("cleanup: 并发扫描共享同一次 PowerShell（single-flight）✓");
  } finally {
    clearLease(a.pid);
    clearLease(b.pid);
    a.kill();
    b.kill();
  }
}

// 2g. 进程列表解析（批量化里最容易写错的一段：ConvertTo-Json 的数组/单元素两种形状）
{
  assert.deepStrictEqual(
    [...parseProcessList('[{"ProcessId":42,"CommandLine":"node a.js"}]')],
    [[42, "node a.js"]],
    "数组形状应解析成 pid → 命令行",
  );
  assert.deepStrictEqual(
    [...parseProcessList('{"ProcessId":7,"CommandLine":"dsh web"}')],
    [[7, "dsh web"]],
    "单元素时 ConvertTo-Json 给的是对象而非数组，也必须吃下",
  );
  // 空/畸形输入一律安全降级为空表（此时确认失败 → 不杀，是安全方向）
  assert.strictEqual(parseProcessList("").size, 0);
  assert.strictEqual(parseProcessList("not json").size, 0);
  assert.strictEqual(parseProcessList("null").size, 0);
  assert.strictEqual(parseProcessList('[{"ProcessId":"42","CommandLine":"x"}]').size, 0, "pid 必须是数字");
  assert.strictEqual(parseProcessList('[{"ProcessId":0,"CommandLine":"x"}]').size, 1, "pid=0 是合法数字");
  assert.strictEqual(parseProcessList('[{"ProcessId":1,"CommandLine":""}]').size, 0, "空命令行不入表");
  assert.strictEqual(parseProcessList('[{"ProcessId":1,"CommandLine":null}]').size, 0, "null 命令行不入表");
  console.log("cleanup: 进程列表解析（数组/单元素/畸形）✓");
}

// ---------- 3. 杀进程的许可判定（安全关键） ----------
//
// `confirmed` 是三态：true=确认是 dsh / false=确认不是 / undefined=拿不到命令行。
// 曾经写成 `if (item.confirmed === false) 跳过`，于是 undefined **落到下面被杀掉**——
// 与函数注释「拿不到命令行就不动进程」正好相反，而且那恰恰是最无法排除
// 「pid 已被回收」的情形。这里把许可判定钉死：只有 true 才允许杀。
{
  assert.strictEqual(isKillable({ orphan: true, confirmed: true }), true, "确认是 dsh 才允许杀");
  assert.strictEqual(
    isKillable({ orphan: true, confirmed: undefined }),
    false,
    "拿不到命令行 ≠ 确认：必须按「不杀」处理（这正是旧代码的错误）",
  );
  assert.strictEqual(isKillable({ orphan: true, confirmed: false }), false, "确认不是 dsh 不杀");
  assert.strictEqual(isKillable({ orphan: false, confirmed: true }), false, "不是孤儿不杀");
  assert.strictEqual(isKillable({ orphan: false, confirmed: undefined }), false);
  console.log("cleanup: 只有确认是 dsh 才允许杀进程 ✓");
}

console.log("\nprocessRegistry / token: all assertions passed");