/**
 * 离线断言：**启动/重连的决策**（`SupervisorManager` 的 `autoConnect` 许可与"复用优先"）。
 *
 * 为什么单独一条（2026-09-14，2026-09-18 随 `autoStart`→`autoConnect` 改名调整口径）：
 *
 * - **没许可就不许拉起**：`dshChat.autoConnect` 关掉、内部后台又不在时，`ensure()` 只能抛
 *   `ServerNotRunningError`（界面据此回到按钮态），**一次 spawn 都不能发生**；
 * - **有许可才拉起**：用户显式动作（`ensure({start:true})`）必须能起一套，不管配置；
 * - **守护进程还活着就只接入、不另起**（重复 spawn 出来的 supervisor 会因管道被占用
 *   自杀，而父进程的 spawn 开销已经付掉了）；
 * - **目标由调用方给定**（选路在控制器那侧，见 `connectTarget.ts`）：配了 `url` 不再
 *   等于"这一轮连外部"——内部优先、外部备用，所以外部那一轮必须显式传 `target`；
 * - **令牌/地址来自会合文件**：这是"多窗口复用同一个后台"的唯一凭据（认证链部分由
 *   `build/auth-chain-probe.mjs` 用真实 dsh 覆盖，这里覆盖"值有没有传出来"）；
 * - **等就绪没有时长上限、且用户能中断**（用户 2026-09-14 口径）：后台在起的时候
 *   `ensure()` 一直等（状态不会被时钟改写成"失败"），只有 `cancelWaiting()`
 *   （= 界面「停止连接」）能让它结束，结束方式是 `WaitCancelledError`。
 *   这一条是"删掉 `startTimeoutSec`"之后**唯一**保证等待不会变成"点了停止还在等"的防线；
 *   外部目标走**同一条口径**：没人应答就一直探，不再"5 秒到点报错"。
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
const { ServerNotRunningError, SupervisorManager, WaitCancelledError } = await import("../src/dsh/supervisorManager");
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

function makeManager(group: string, autoConnect: boolean, launcher: { launch: (input: never) => Promise<{ ok: true }> }): SupervisorManager {
  return new SupervisorManager({
    group,
    url: "",
    command: "dsh web --port 0 --no-open",
    autoConnect,
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
    check("autoConnect=false 时 ensure() 抛 ServerNotRunningError", error instanceof ServerNotRunningError, String(error));
    check("没有拉起任何一条后台（启动器调用次数 0）", launcher.calls() === 0, `calls=${launcher.calls()}`);
    check("状态是 stopped（界面据此给按钮态）", manager.getStatus().state === "stopped", manager.getStatus().state);
    check(
      "详情不再带 `@`（按钮态的文案由界面按两轴探测结论拼）",
      manager.getStatus().detail === "server not running",
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

  // ---------- 5. 等就绪：没有时长上限，只有用户能叫停（2026-09-14） ----------
  {
    // 守护进程活着、dsh 还没交出地址 —— 这正是"以前等 90 秒就报超时"的那个窗口
    publishState("policy-wait", { starting: true });
    const launcher = fakeLauncher();
    const manager = makeManager("policy-wait", false, launcher.launcher);
    managers.push(manager);
    let settled: Error | "resolved" | undefined;
    const pending = manager.ensure({ start: false }).then(
      () => {
        settled = "resolved";
      },
      (error: unknown) => {
        settled = error instanceof Error ? error : new Error(String(error));
      },
    );
    // 观察一段：这期间**不该**有任何东西因为"时间到了"而结束这一轮
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    check(
      "等待期间状态仍是 starting（没有被时长判定改写成失败）",
      manager.getStatus().state === "starting",
      manager.getStatus().state,
    );
    check("等待期间这一轮没有结束（没有超时这一档）", settled === undefined, String(settled));
    check("等待期间一次 spawn 都没发生（守护进程活着就只接入）", launcher.calls() === 0, `calls=${launcher.calls()}`);

    // 用户点「停止连接」= cancelWaiting()：等待必须立刻让位，且按"用户叫停"而不是失败结束
    const startedAt = Date.now();
    manager.cancelWaiting();
    await pending;
    check(
      "cancelWaiting() 后 ensure() 以 WaitCancelledError 结束（不是超时失败）",
      settled instanceof WaitCancelledError,
      String(settled),
    );
    check("中断是立刻的（< 2s，不用等下一轮判据）", Date.now() - startedAt < 2_000, `${Date.now() - startedAt}ms`);
    manager.dispose();
  }

  // ---------- 6. 外部服务器**同样等到底**（原来 5 秒探不通就报 @serverUnreachable） ----------
  {
    // 端口拿到手就立刻关掉：这个地址上确实没人应答（真实事实判据，不靠猜）
    const dead = await listen();
    await dead.close();
    const manager = new SupervisorManager({
      url: dead.baseUrl,
      command: "dsh web --port 0 --no-open",
      autoConnect: false,
      launcher: fakeLauncher().launcher as never,
      log: () => undefined,
    });
    managers.push(manager);
    let settled: Error | "resolved" | undefined;
    // 目标必须显式给"外部"：配了 url 不再等于"这一轮就连外部"（2026-09-18 新口径，
    // 内部优先、外部备用），选路是控制器的事，管理器只执行给定目标。
    const pending = manager.ensure({ target: "external" }).then(
      () => {
        settled = "resolved";
      },
      (error: unknown) => {
        settled = error instanceof Error ? error : new Error(String(error));
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    check("外部地址没人应答时不会“到点报错”（等待仍在继续）", settled === undefined, String(settled));
    check(
      "状态是 starting，且详情写明是哪个地址（@serverUnreachable:…）",
      manager.getStatus().state === "starting" && (manager.getStatus().detail ?? "").startsWith("@serverUnreachable:"),
      manager.getStatus().detail ?? "（无）",
    );
    manager.cancelWaiting();
    await pending;
    check("外部等待也能被用户叫停（WaitCancelledError）", settled instanceof WaitCancelledError, String(settled));
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
  console.log("\n✓ supervisor 启动/重连决策（许可 / 复用 / 令牌来自会合文件 / 只读探测 / 等待可中断 / 外部也等到底）全通过");
  assert.ok(true);
}
