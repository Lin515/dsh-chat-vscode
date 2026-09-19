/**
 * 离线断言：`SupervisorManager.snapshot()` —— **一份只读快照**（2026-09-19 第二轮收敛）。
 *
 * 为什么要有它：管理器里"本窗口与这一套后台现在是什么关系"这件事此前散在七八个读法里
 * （`getStatus()` / `canStart()` / `peekState()` / `activeBaseUrl` / `sharedSummary()` /
 * `generation`，外加三个私有字段），控制器只能**自己镜像**一份（`target` / `connection` /
 * `internalRunning` / `autoReconnect` …）——两处状态必然各说各话。快照把这些**同源值**一次给全。
 *
 * 这一组钉三件事，都是"形状/一致性"层面的（真行为由 `supervisorPolicy.test.ts` 第 10 组用
 * 真 socket 覆盖）：
 *
 * 1. **够用**：控制器要的字段都在（目标、状态、连接在不在、两道闸、许可、活连接数、会合状态），
 *    且每个字段**等于**它对应的老读法（不是第二份实现）；
 * 2. **只读**：全是普通值、没有方法，且 `status` / `status.info` 是拷贝——改快照改不坏管理器；
 * 3. **闸与在飞状态如实**：`release` 之后 `detachedByUser` 为真、`stopping` 在飞时为真。
 *
 * 运行：npm test（**新增文件必须登记到 esbuild.scripts.mjs 的 entries**，否则静默不跑）
 */
import assert from "node:assert";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须排在最前面：把会合根目录指到本次断言专用的临时目录（模块求值期读一次）
const TEST_ROOT = mkdtempSync(join(tmpdir(), "dsh-chat-snapshot-"));
process.env.DSH_CHAT_SUPERVISOR_DIR = TEST_ROOT;
const { SupervisorManager } = await import("../src/dsh/supervisorManager");
const { STATE_VERSION, socketPathIn, supervisorDirectory, writeState } = await import("../src/dsh/supervisorProtocol");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 起一个真的本地监听（"服务在不在"用事实判据），返回地址与收尾函数。 */
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

/** 起一个**真的守护进程 socket 服务端**（"手里还握着连接吗"只能这样测，见 supervisorPolicy）。 */
async function listenDaemon(path: string): Promise<{ close: () => Promise<void>; clients: () => number }> {
  let live = 0;
  const server: Server = createServer((socket) => {
    live += 1;
    socket.on("data", () => undefined);
    socket.on("close", () => {
      live -= 1;
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    clients: () => live,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 1_000).unref?.();
      }),
  };
}

const DEAD_SOCKET = process.platform === "win32" ? "\\\\.\\pipe\\dsh-chat-snapshot-none" : join(TEST_ROOT, "none.sock");

function publishState(
  group: string,
  options: { baseUrl?: string; token?: string; socket?: string } = {},
): void {
  const directory = supervisorDirectory(group);
  writeState(directory, {
    version: STATE_VERSION,
    // 守护进程"就在本进程里"：`isProcessAlive` 的真实事实判据
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

/** 等一个真实事件到达（连接建立/断开是异步的）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const background = await listen();
const daemons: Array<{ close: () => Promise<void> }> = [];
const managers: SupervisorManager[] = [];

/** 会合目录必须隔离：跑进用户真实目录是本仓库踩过的坑（见 design-supervisor §6.2）。 */
check(
  "会合目录在临时目录里（不碰用户的真实 ~/.dsh）",
  supervisorDirectory("snapshot-isolated").startsWith(TEST_ROOT) && statSync(TEST_ROOT).isDirectory(),
  supervisorDirectory("snapshot-isolated"),
);

try {
  // ---------- 1. 还没连过：快照仍是完整的一份（不许有"空"字段混淆"没有"与"不知道"） ----------
  {
    let launches = 0;
    const launcher = { async launch() { launches++; return { ok: true as const }; } };
    const manager = new SupervisorManager({
      group: "snapshot-idle",
      url: "",
      command: "dsh web --port 0 --no-open",
      autoConnect: false,
      launcher: launcher as never,
      log: () => undefined,
    });
    managers.push(manager);
    const snap = manager.snapshot();
    check("还没定过目标时 target 是 undefined（不是编一个 internal 出来）", snap.target === undefined, String(snap.target));
    check("状态是 stopped（按钮态）", snap.status.state === "stopped", snap.status.state);
    check("没有握着任何连接", snap.connected === false);
    check("startAllowed = canStart()（autoConnect=false）", snap.startAllowed === false && snap.startAllowed === manager.canStart());
    check("两道闸初始都是 false", snap.stoppedByUser === false && snap.detachedByUser === false);
    check("没有在飞的停止请求", snap.stopping === false);
    check("会合状态为空（peekState）", snap.state === undefined && snap.state === manager.peekState());
    check("还没接过任何一套：remembered 为 false（本窗口什么都没记）", snap.remembered === false);
    check("没有生效地址、没配外部地址", snap.activeBaseUrl === undefined && snap.externalUrl === undefined);
    check("没连上时不报活连接数与归属", snap.hostCount === undefined && snap.ownership === undefined);
    check("窗口没走（disposed=false）", snap.disposed === false);
    check(
      "诊断要用的两个路径就在快照里（会合目录 / 日志）",
      snap.rendezvousDirectory === manager.rendezvousDirectory && snap.logPath === manager.logPath,
      `${snap.rendezvousDirectory} / ${snap.logPath}`,
    );
    check(
      "快照是普通值、没有方法（控制器只渲染它）",
      Object.values(snap).every((value) => typeof value !== "function"),
    );
    check(
      "status 与 getStatus() 逐键一致（不是第二份实现）",
      JSON.stringify(snap.status) === JSON.stringify(manager.getStatus()),
      JSON.stringify(snap.status),
    );
    manager.dispose();
  }

  // ---------- 2. 接上内部之后：每个字段都等于它对应的老读法 ----------
  {
    const group = "snapshot-internal";
    const directory = supervisorDirectory(group);
    const socket = socketPathIn(directory, group);
    publishState(group, { baseUrl: background.baseUrl, token: "snap-token", socket });
    const daemon = await listenDaemon(socket);
    daemons.push(daemon);
    const manager = new SupervisorManager({
      group,
      url: "",
      command: "dsh web --port 0 --no-open",
      autoConnect: false,
      launcher: { async launch() { return { ok: true as const }; } } as never,
      log: () => undefined,
    });
    managers.push(manager);
    const info = await manager.ensure({ start: false, target: "internal" });
    await waitFor(() => daemon.clients() === 1);

    const snap = manager.snapshot();
    const shared = manager.sharedSummary();
    check("target = 这一轮的目标（internal）", snap.target === "internal", String(snap.target));
    check("status.state = ready", snap.status.state === "ready", snap.status.state);
    check("status.info.baseUrl = 会合文件里的地址", snap.status.info?.baseUrl === background.baseUrl, snap.status.info?.baseUrl ?? "（无）");
    check("activeBaseUrl = status.info.baseUrl（同一个值）", snap.activeBaseUrl === manager.activeBaseUrl && snap.activeBaseUrl === info.baseUrl);
    check("connected = 手里真的握着那条 socket（对面看到 1 条）", snap.connected === true && daemon.clients() === 1, `clients=${daemon.clients()}`);
    check("state = peekState()（本窗口正在用的那一套）", snap.state === manager.peekState(), String(snap.state?.baseUrl));
    check("remembered = 本窗口真的记着这一套（不是只从磁盘读出来的）", snap.remembered === true);
    check("generation = 那个 getter", snap.generation === manager.generation, String(snap.generation));
    check(
      "hostCount / ownership = sharedSummary()",
      snap.hostCount === shared?.hostCount && snap.ownership === shared?.ownership,
      `${snap.hostCount} / ${snap.ownership} vs ${shared?.hostCount} / ${shared?.ownership}`,
    );
    check("startAllowed = canStart()（autoConnect=false 时也如实为 false）", snap.startAllowed === manager.canStart());
    check("stoppedByUser / detachedByUser 如实为 false", !snap.stoppedByUser && !snap.detachedByUser);
    check(
      "快照里记着「是哪一套」：会合状态里有守护进程与 dsh 的 pid",
      typeof snap.state?.supervisorPid === "number" && typeof snap.state?.serverPid === "number",
      `supervisor=${snap.state?.supervisorPid} dsh=${snap.state?.serverPid}`,
    );

    // **只读**：改快照改不坏管理器（浅拷贝那两处）
    const before = manager.getStatus();
    const mutable = snap.status as unknown as { state: string; info?: { baseUrl: string } };
    mutable.state = "failed";
    if (mutable.info) mutable.info.baseUrl = "http://mutated.invalid";
    check(
      "改快照的 status / info 不影响管理器（浅拷贝）",
      manager.getStatus().state === before.state && manager.activeBaseUrl === background.baseUrl,
      `${manager.getStatus().state} / ${manager.activeBaseUrl ?? "（无）"}`,
    );

    // 闸与在飞状态：`release` 那一档置闸；`stopping` 在飞时为真、事后复位
    const stopInFlight = manager.stop({ askSupervisor: true });
    check("「请守护进程收场」在飞时快照的 stopping 为真", manager.snapshot().stopping === true);
    await stopInFlight;
    check("停止结束之后 stopping 复位", manager.snapshot().stopping === false);
    check(
      "stop({askSupervisor:true}) 同时置起 stoppedByUser（不许自动拉起）",
      manager.snapshot().stoppedByUser === true,
    );

    // 回到连接态，再走「停止连接」那一档（release）
    await manager.ensure({ start: false, target: "internal" });
    await waitFor(() => daemon.clients() === 1);
    await manager.stop({ release: true });
    await waitFor(() => daemon.clients() === 0);
    const released = manager.snapshot();
    check(
      "release 之后：快照如实给出「闸已置位 + 没有连接 + 没有内部状态」",
      released.detachedByUser === true &&
        released.connected === false &&
        released.remembered === false &&
        released.state === undefined,
      `detached=${released.detachedByUser} connected=${released.connected} remembered=${released.remembered} state=${String(released.state)}`,
    );
    check("release 之后 stoppedByUser 保持 false（两道闸管的是两件事）", released.stoppedByUser === false);

    // 显式动作清掉闸（快照要立刻反映）
    await manager.ensure({ start: false, target: "internal" });
    await waitFor(() => daemon.clients() === 1);
    check("显式动作之后 detachedByUser 被清掉（心跳可以再接回）", manager.snapshot().detachedByUser === false);

    // 许可即时生效（配置监听那条路）
    manager.setAutoConnect(true);
    check("setAutoConnect(true) 之后 startAllowed 立刻为 true", manager.snapshot().startAllowed === true);

    manager.dispose();
    check("dispose 之后 disposed 为真（快照是最新的事实，不是缓存）", manager.snapshot().disposed === true);
    await daemon.close();
  }

  // ---------- 3. 外部目标：快照要能回答"我连的是哪一个" ----------
  {
    const group = "snapshot-external";
    const manager = new SupervisorManager({
      group,
      url: `${background.baseUrl}/`,
      command: "dsh web --port 0 --no-open",
      autoConnect: true,
      launcher: { async launch() { return { ok: true as const }; } } as never,
      log: () => undefined,
    });
    managers.push(manager);
    const info = await manager.ensure({ start: false, target: "external" });
    const snap = manager.snapshot();
    check("外部目标：target = external", snap.target === "external", String(snap.target));
    check("外部地址去过尾斜杠（与 externalUrl 同一份值）", snap.externalUrl === manager.externalUrl && snap.externalUrl === background.baseUrl, snap.externalUrl ?? "（无）");
    check("外部目标下没有内部会合状态（peekState 为空）", snap.state === undefined && manager.peekState() === undefined);
    check("status.info.ownership = external（诊断据此说「不是本扩展拉起的」）", snap.status.info?.ownership === "external", String(snap.status.info?.ownership));
    check("activeBaseUrl = 外部地址", snap.activeBaseUrl === info.baseUrl, snap.activeBaseUrl ?? "（无）");
    manager.dispose();
  }
} finally {
  for (const manager of managers) manager.dispose();
  for (const daemon of daemons) await daemon.close().catch(() => undefined);
  await background.close().catch(() => undefined);
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n✗ 管理器只读快照（snapshot）：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 管理器只读快照（snapshot：字段够控制器用、每个都等于老读法、只读不改坏管理器、闸与在飞状态如实）全通过",
  );
  assert.ok(true);
}
