/**
 * 离线断言：**后台不在了，心跳也不许自己再拉起一套**（用户 2026-10-18 口径：
 * 自动连接只在扩展启动时做一次）。
 *
 * 报的现象是多窗口的：A 窗口点「停止内部 DSH」之后，B 窗口过几秒又拉起一套新的
 * supervisor。管理器这一侧的来路就在心跳里：`heartbeatTick()` 在"会合文件不在了
 * （或 supervisor 已退出）"那一支曾经按 `canStart()` 去 `ensure({ start: true })`——
 * `dshChat.autoConnect` 默认开着，于是每 5 秒重来一次。控制器那一侧的来路（心跳沿用
 * 粘性目标上的 `mayStart` 许可）由 `autoConnectOnce.test.ts` 用真 `ChatController` 钉。
 *
 * 判据必须是**真的 socket 服务端 + 真的会合文件 + 假启动器的调用次数**：「有没有拉起一套」
 * 用源码正则看不出来——只有"启动器到底被调了几次"是事实（`SupervisorManager` 的启动决策
 * 全部汇到一个 `launcher.launch()`）。
 *
 * 覆盖：
 * 1. 两个窗口共用一套后台，A `stop()` 之后 B 真的收到 `goodbye(stop)`（后台终结的样子）；
 * 2. 那之后 B 的心跳跑三轮，**一次都不调用启动器**，状态回按钮态；
 * 3. socket 瞬断（后台还活着）时心跳**接回现有那套**——复用优先，仍然不另起；
 * 4. 自动连接许可（`autoConnect`）与用户显式 `start: true` 的原语义不变：没许可不拉起，
 *    有许可（省略 `start` 时取它）照样拉起。
 *
 * 全程不 spawn 真实进程、不连真实 dsh、不消耗 token：启动器是假的，会合文件由断言自己写，
 * socket 用本地真监听（"对面看到几条活连接"必须是事实判据，不能用假函数）。
 *
 * 运行：npm test（必须登记到 `esbuild.scripts.mjs` 的 entries，否则静默不跑）
 */
import assert from "node:assert";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 纯协议模块（只 `import type` 会合协议、运行时不读环境变量），可以静态引入
import { decodeClientMessage, encodeMessage } from "../src/dsh/supervisorWire";
// 必须排在最前面：把会合根目录指到本次断言专用的临时目录（模块求值期读一次）
const TEST_ROOT = mkdtempSync(join(tmpdir(), "dsh-chat-norespawn-"));
process.env.DSH_CHAT_SUPERVISOR_DIR = TEST_ROOT;
const { ServerNotRunningError, SupervisorManager } = await import("../src/dsh/supervisorManager");
const { STATE_VERSION, clearState, removeSocketNode, socketPathIn, supervisorDirectory, writeState } = await import(
  "../src/dsh/supervisorProtocol"
);

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 一定不存在的 socket（连接立刻失败，不会等超时）。 */
const DEAD_SOCKET = process.platform === "win32" ? "\\\\.\\pipe\\dsh-chat-norespawn-none" : join(TEST_ROOT, "none.sock");

/** 等一个真实事件到达（socket 断开/收到道别都是异步的，不能立刻断言）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 心跳那一轮是私有的（编译产物里没有 `private`；等 5 秒太慢，而它正是**唯一**会
 * "自己接回来 / 自己拉起"的路径）。
 */
function tick(manager: SupervisorManager): Promise<void> {
  return (manager as unknown as { heartbeatTick(): Promise<void> }).heartbeatTick();
}

/** 起一个真的本地监听，当"外部/内部 dsh 在不在"这个事实判据（`probeRunning` 只连不发数据）。 */
async function listen(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
        setTimeout(resolve, 1_000).unref?.();
      }),
  };
}

/** 写一份"守护进程就在本进程里、dsh 在这个地址上"的会合文件。 */
function publishState(group: string, options: { baseUrl?: string; token?: string; socket?: string } = {}): void {
  writeState(supervisorDirectory(group), {
    version: STATE_VERSION,
    supervisorPid: process.pid,
    startedAt: Date.now(),
    serverPid: 4242,
    baseUrl: options.baseUrl,
    token: options.token,
    command: "dsh web --port 0 --no-open",
    idleSec: 10,
    socket: options.socket ?? DEAD_SOCKET,
    starting: false,
  });
}

/**
 * 起一个**真的守护进程 socket 服务端**：数它当前有几条活连接、记下收到的 control 请求，
 * 并支持`s.destroy()`（模拟传输层瞬断）与广播 `goodbye`（模拟它主动退场前通知）。
 *
 * 「B 有没有收到 goodbye(stop)」以及「心跳有没有接回现有那套」都只能这样测：判据是
 * **对面看到的连接数**与**管理器的快照**，不是源码里有没有某一句。
 *
 * **必须挂 `data` 监听**（实测，不是风格问题）：socket 处在 paused 态时 Node 不跑读循环，
 * 对面 `destroy()` 之后这里永远收不到 `close`。真实守护进程正是挂了 `data` 的。
 */
async function listenDaemon(
  path: string,
  onControl?: (action: string, sockets: Set<Socket>) => void,
): Promise<{ close: () => Promise<void>; dropAll: () => void; clients: () => number; controls: () => string[] }> {
  let live = 0;
  const controls: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    live += 1;
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // 用**真的**协议解码器：自己拿 JSON.parse 猜一遍等于把被测协议又实现了一次
        const message = decodeClientMessage(line.trim());
        if (message?.t !== "control") continue;
        controls.push(message.action);
        onControl?.(message.action, sockets);
      }
    });
    socket.on("close", () => {
      live -= 1;
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    clients: () => live,
    controls: () => [...controls],
    dropAll: () => {
      for (const socket of [...sockets]) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of [...sockets]) socket.destroy();
        server.close(() => resolve());
        // 兜底：还有连接没断时 `close()` 的回调不会来（它等所有连接结束）
        setTimeout(resolve, 1_000).unref?.();
      }),
  };
}

/** 假启动器：只记次数（真正"起一套"由 publishState 模拟）。 */
function fakeLauncher(onLaunch?: () => void): {
  calls: () => number;
  launcher: { launch: (input: never) => Promise<{ ok: true }> };
} {
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

function makeManager(
  group: string,
  autoConnect: boolean,
  launcher: { launch: (input: never) => Promise<{ ok: true }> },
): SupervisorManager {
  return new SupervisorManager({
    group,
    url: "",
    command: "dsh web --port 0 --no-open",
    autoConnect,
    launcher: launcher as never,
    log: () => undefined,
  });
}

const dsh = await listen();
const managers: SupervisorManager[] = [];
const daemons: { close: () => Promise<void> }[] = [];

try {
  // ---------- 1. 别的窗口停掉后台 → 本窗口收到 goodbye(stop) → 心跳绝不拉起 ----------
  {
    const group = "norespawn-goodbye";
    const directory = supervisorDirectory(group);
    const socket = socketPathIn(directory, group);
    publishState(group, { baseUrl: dsh.baseUrl, token: "shared-token", socket });
    const daemon = await listenDaemon(socket, (action, sockets) => {
      if (action !== "stop") return;
      // 真实守护进程收场：先向所有窗口道别（`goodbye`），再停 dsh、删会合文件、退出
      for (const socket of [...sockets]) socket.write(encodeMessage({ t: "goodbye", reason: "stop" }));
    });
    daemons.push(daemon);
    const launcherA = fakeLauncher();
    const launcherB = fakeLauncher();
    // 两个窗口都开着自动连接（默认值）：改前正是 `canStart()` 为真才让心跳重新 spawn
    const a = makeManager(group, true, launcherA.launcher);
    const b = makeManager(group, true, launcherB.launcher);
    managers.push(a, b);

    await a.ensure({ start: false, target: "internal" });
    await b.ensure({ start: false, target: "internal" });
    await waitFor(() => daemon.clients() === 2);
    check("前置：两个窗口共用一套后台（对面 2 条活连接）", daemon.clients() === 2, `clients=${daemon.clients()}`);
    check("前置：两个窗口手里都接着它", a.snapshot().connected && b.snapshot().connected);

    await a.stop(); // 界面上的「停止内部 DSH」：请守护进程连 dsh 一起收场
    await waitFor(() => b.getStatus().state === "stopped");
    check(
      "A 停止后 B 真的收到 goodbye(stop)：状态回按钮态",
      b.getStatus().state === "stopped",
      `${b.getStatus().state} / ${b.getStatus().detail ?? "（无）"}`,
    );
    check("B 收到 goodbye 之后手里没有连接了", !b.snapshot().connected);
    check(
      "前置：停止这一下没有调用任何启动器（停止是收场，不是拉起）",
      launcherA.calls() === 0 && launcherB.calls() === 0,
      `A=${launcherA.calls()} B=${launcherB.calls()}`,
    );

    // 整套后台真的终结：会合文件删掉、socket 关掉（守护进程已退出的样子）
    clearState(directory);
    await daemon.close();

    for (let round = 1; round <= 3; round++) await tick(b);
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(
      "整套后台终结后 B 的心跳跑三轮：**一次都不调用启动器**（不再自动拉起新 supervisor）",
      launcherB.calls() === 0,
      `calls=${launcherB.calls()}`,
    );
    check(
      "……而且状态没有被改写成 starting（界面停在按钮态等用户动作）",
      b.getStatus().state === "stopped",
      b.getStatus().state,
    );
    await tick(a);
    await new Promise((resolve) => setTimeout(resolve, 200));
    check("A 那一侧同样不拉起（它自己刚停的）", launcherA.calls() === 0, `calls=${launcherA.calls()}`);
  }

  // ---------- 2. socket 瞬断（后台还在）→ 心跳接回现有那套，不另起 ----------
  {
    const group = "norespawn-reconnect";
    const directory = supervisorDirectory(group);
    const socket = socketPathIn(directory, group);
    publishState(group, { baseUrl: dsh.baseUrl, token: "shared-token", socket });
    const first = await listenDaemon(socket);
    const launcher = fakeLauncher();
    const manager = makeManager(group, true, launcher.launcher);
    managers.push(manager);

    await manager.ensure({ start: false, target: "internal" });
    await waitFor(() => first.clients() === 1);
    check(
      "前置：接上了会合文件里那一套（对面 1 条）",
      manager.snapshot().connected && first.clients() === 1,
      `clients=${first.clients()}`,
    );

    // 传输层瞬断：本窗口这条 socket 断了，但**后台还在跑**（会合文件照旧有效）
    first.dropAll();
    await waitFor(() => !manager.snapshot().connected);
    check("socket 断掉：本窗口的连接没了（后台没死）", !manager.snapshot().connected);

    // 对面在同一个地址上重新听（守护进程原地不动，只是这条连接断了）
    await first.close();
    removeSocketNode(socket);
    const second = await listenDaemon(socket);
    daemons.push(second);

    await tick(manager);
    await waitFor(() => second.clients() === 1);
    check(
      "心跳**接回现有那套后台**（复用优先，不换世代）",
      second.clients() === 1 && manager.snapshot().connected,
      `clients=${second.clients()} connected=${manager.snapshot().connected}`,
    );
    check(
      "……而且一次都不调用启动器（后台还在，绝不允许另起一套）",
      launcher.calls() === 0,
      `calls=${launcher.calls()}`,
    );
  }

  // ---------- 3. 许可语义不变：省略 start 时取 autoConnect，显式 start:true 照旧能拉起 ----------
  {
    const group = "norespawn-permit";
    const launcher = fakeLauncher(() =>
      publishState(group, { baseUrl: dsh.baseUrl, token: "token-from-file", socket: DEAD_SOCKET }),
    );
    const allowed = makeManager(group, true, launcher.launcher);
    managers.push(allowed);
    const info = await allowed.ensure(); // 省略 start → 用 autoConnect 这个默认许可
    check(
      "autoConnect 开着时 ensure() 仍按许可拉起一套（激活期那一次自动连接靠的就是它）",
      launcher.calls() === 1,
      `calls=${launcher.calls()}`,
    );
    check("拉起之后拿到会合文件里的地址", info.baseUrl === dsh.baseUrl, info.baseUrl);
  }
  {
    const group = "norespawn-nopermit";
    const launcher = fakeLauncher();
    const denied = makeManager(group, false, launcher.launcher);
    managers.push(denied);
    let error: unknown;
    try {
      await denied.ensure();
    } catch (caught) {
      error = caught;
    }
    check(
      "autoConnect 关着时 ensure() 依然一次都不拉起（抛 ServerNotRunningError，界面给按钮）",
      error instanceof ServerNotRunningError && launcher.calls() === 0,
      `${String(error)} calls=${launcher.calls()}`,
    );
  }
} finally {
  for (const manager of managers) manager.dispose();
  for (const daemon of daemons) await daemon.close().catch(() => undefined);
  await dsh.close().catch(() => undefined);
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n✗ 后台终结后心跳不自动拉起：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 后台终结后心跳不自动拉起（多窗口 goodbye 后不 spawn / socket 瞬断只复接现有那套 / 许可与显式动作语义不变）全通过",
  );
  assert.ok(true);
}
