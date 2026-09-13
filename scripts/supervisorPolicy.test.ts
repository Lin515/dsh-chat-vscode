/**
 * 离线断言：**启动/重连的决策**（`SupervisorManager` 的 `autoStart` 许可与"复用优先"）。
 *
 * 为什么单独一条（2026-09-14）：这是用户在"关掉自动启动"场景下的核心验收标准——
 *
 * - **没许可就不许拉起**：`dshChat.autoStart` 关掉、后台又不在时，`ensure()` 只能抛
 *   `ServerNotRunningError`（界面据此显示「启动服务器」），**一次 spawn 都不能发生**；
 * - **有许可才拉起**：用户显式动作（`ensure({start:true})`）必须能起一套，不管配置；
 * - **守护进程还活着就只接入、不另起**（重复 spawn 出来的 supervisor 会因管道被占用
 *   自杀，而父进程的 spawn 开销已经付掉了）；
 * - **令牌/地址来自会合文件**：这是"多窗口复用同一个后台"的唯一凭据（认证链部分由
 *   `build/auth-chain-probe.mjs` 用真实 dsh 覆盖，这里覆盖"值有没有传出来"）。
 *
 * 全程不 spawn 任何真实进程：启动器是假的，会合文件由断言自己写，端口用本地
 * `net.createServer` 真监听（"服务在不在"必须用事实判据，不能用假函数）。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 必须排在最前面：把会合根目录指到本次断言专用的临时目录（模块求值期读一次）
const TEST_ROOT = mkdtempSync(join(tmpdir(), "dsh-chat-policy-"));
process.env.DSH_CHAT_SUPERVISOR_DIR = TEST_ROOT;
const { ServerNotRunningError, SupervisorManager } = await import("../src/dsh/supervisorManager");
const { STATE_VERSION, socketPathIn, supervisorDirectory, writeState } = await import("../src/dsh/supervisorProtocol");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 一定不存在的 socket（连接立刻失败，不会等超时）。 */
const DEAD_SOCKET = process.platform === "win32" ? "\\\\.\\pipe\\dsh-chat-policy-none" : join(TEST_ROOT, "none.sock");

/** 起一个真的本地监听（"服务在不在"用事实判据），返回地址与收尾函数。 */
async function listen(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 写一份"守护进程就在本进程里、dsh 在这个地址上"的会合文件。 */
function publishState(group: string, options: { baseUrl?: string; token?: string; supervisorPid?: number; starting?: boolean } = {}): void {
  const directory = supervisorDirectory(group);
  writeState(directory, {
    version: STATE_VERSION,
    supervisorPid: options.supervisorPid ?? process.pid,
    startedAt: Date.now(),
    serverPid: 4242,
    baseUrl: options.baseUrl,
    token: options.token,
    command: "dsh web --port 0 --no-open",
    idleSec: 10,
    socket: DEAD_SOCKET,
    starting: options.starting ?? false,
  });
}

/** 假启动器：只记次数（真正"起一套"由 publishState 模拟）。 */
function fakeLauncher(onLaunch?: () => void) {
  const state = { calls: 0 };
  return {
    calls: () => state.calls,
    launcher: {
      async launch() {
        state.calls++;
        onLaunch?.();
        return { ok: true as const };
      },
    },
  };
}

function makeManager(group: string, autoStart: boolean, launcher: { launch: (input: never) => Promise<{ ok: true }> }): SupervisorManager {
  return new SupervisorManager({
    group,
    url: "",
    command: "dsh web --port 0 --no-open",
    startTimeoutMs: 5_000,
    autoStart,
    launcher: launcher as never,
    log: () => undefined,
  });
}

const background = await listen();
const managers: SupervisorManager[] = [];

try {
  // ---------- 1. 没有许可 + 后台不在 → 抛「没在跑」，且一次 spawn 都不许发生 ----------
  {
    const launcher = fakeLauncher();
    const manager = makeManager("policy-no-start", false, launcher.launcher);
    managers.push(manager);
    let error: unknown;
    try {
      await manager.ensure();
    } catch (caught) {
      error = caught;
    }
    check("autoStart=false 时 ensure() 抛 ServerNotRunningError", error instanceof ServerNotRunningError, String(error));
    check("没有拉起任何一条后台（启动器调用次数 0）", launcher.calls() === 0, `calls=${launcher.calls()}`);
    check("状态是 stopped（界面据此给「启动服务器」）", manager.getStatus().state === "stopped", manager.getStatus().state);
    check(
      "详情是 @serverNotRunning（界面文案的标记）",
      manager.getStatus().detail === "@serverNotRunning",
      manager.getStatus().detail ?? "（无）",
    );
    // 「尝试重连」也是同一档：只接上已经在跑的，不启动
    let retryError: unknown;
    try {
      await manager.ensure({ start: false });
    } catch (caught) {
      retryError = caught;
    }
    check("ensure({start:false}) 同样不启动", retryError instanceof ServerNotRunningError && launcher.calls() === 0);
    manager.dispose();
  }

  // ---------- 2. 有许可 → 真的拉起，并把会合文件里的地址/令牌交出去 ----------
  {
    const launcher = fakeLauncher(() => publishState("policy-start", { baseUrl: background.baseUrl, token: "token-from-file" }));
    const manager = makeManager("policy-start", false, launcher.launcher);
    managers.push(manager);
    const info = await manager.ensure({ start: true });
    check("用户显式启动（start:true）覆盖 autoStart=false：启动器被调用", launcher.calls() === 1, `calls=${launcher.calls()}`);
    check("baseUrl 来自会合文件", info.baseUrl === background.baseUrl, info.baseUrl);
    check("token 来自会合文件（多窗口复用的唯一凭据）", info.token === "token-from-file", info.token ?? "（无）");
    check("本窗口是启动者（ownership=self）", info.ownership === "self", info.ownership);
    manager.dispose();
  }

  // ---------- 3. 守护进程还活着 → **只接入、绝不另起一套** ----------
  {
    publishState("policy-attach", { baseUrl: background.baseUrl, token: "shared-token" });
    const launcher = fakeLauncher();
    const manager = makeManager("policy-attach", false, launcher.launcher);
    managers.push(manager);
    const info = await manager.ensure({ start: true });
    check("守护进程活着时不重复拉起", launcher.calls() === 0, `calls=${launcher.calls()}`);
    check("接入者（ownership=peer）", info.ownership === "peer", info.ownership);
    check("接入者也拿到了会合文件里的令牌", info.token === "shared-token", info.token ?? "（无）");
    check("状态 ready", manager.getStatus().state === "ready", manager.getStatus().state);
    manager.dispose();
  }

  // ---------- 4. probeRunning()：只读判断"后台在不在跑" ----------
  {
    const launcher = fakeLauncher();
    const manager = makeManager("policy-probe", true, launcher.launcher);
    managers.push(manager);
    const empty = await manager.probeRunning();
    check("没有会合文件 → 没在跑", !empty.hasState && !empty.supervisorAlive && !empty.serverAlive);

    publishState("policy-probe", { baseUrl: background.baseUrl });
    const alive = await manager.probeRunning();
    check("守护进程在本进程 + 端口在听 → supervisorAlive/serverAlive 都是真", alive.supervisorAlive && alive.serverAlive);
    check("probeRunning 不启动任何东西", launcher.calls() === 0, `calls=${launcher.calls()}`);

    // 进程已死的守护进程：拿一个刚退出的子进程 pid（真实事实判据，不靠猜）
    const exited = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    if (typeof exited.pid === "number" && exited.pid > 0) {
      publishState("policy-probe", { baseUrl: background.baseUrl, supervisorPid: exited.pid });
      const dead = await manager.probeRunning();
      check("守护进程已死 → supervisorAlive=false（不再把残留当在用）", !dead.supervisorAlive);
    } else {
      console.log("   （跳过：拿不到已退出进程的 pid）");
    }

    // 守护进程活着但端口已经没人听：这正是"dsh 崩了、守护进程还在"
    await background.close();
    publishState("policy-probe", { baseUrl: background.baseUrl });
    const noServer = await manager.probeRunning();
    check("端口没了 → serverAlive=false（守护进程还在）", noServer.supervisorAlive && !noServer.serverAlive);
    manager.dispose();
  }
} finally {
  for (const manager of managers) manager.dispose();
  await background.close().catch(() => undefined);
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n✗ supervisor 启动/重连决策：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ supervisor 启动/重连决策（许可 / 复用 / 令牌来自会合文件 / 只读探测）全通过");
  assert.ok(true);
}
