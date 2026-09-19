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
 * - **换目标是彻底的**（2026-09-19，第 7 组）：切到外部时，本窗口与内部守护进程之间的
 *   连接必须**真的断开**（判据是"对面看到几条活连接"，所以这里起一个真的 socket 服务端来数
 *   ——那条连接只要在，守护进程就会一直把 dsh 拎着不放，诊断里也还是内部那一套）。
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
// 纯协议模块（只 `import type` 会合协议，运行时不读环境变量），可以静态引入
import { decodeClientMessage } from "../src/dsh/supervisorWire";
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
  // 这是一个 **net** 服务端（"端口上有没有人在听"就是判据，`tcpReachable` 只连不发数据），
  // 但同一批地址也被 `fetch` 用作"外部 DSH 的地址"——所以收到请求要回一个最小 HTTP 响应：
  // `fetch` 拿到响应头才 settle，而"连上了但永远不回"会挂到超时、并在收尾时留下半开的
  // 连接（实测：`await close()` 永不 settle，脚本以"unsettled top-level await"退出）。
  // 真实的外部 dsh 是会应答的（401/403 也算"有东西"），这里照它来。
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
        // 顺手掐掉在途连接：`close()` 的回调要等所有连接结束才来，别让断言结尾挂在它上面
        (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
        setTimeout(resolve, 1_000).unref?.();
      }),
  };
}

/** 写一份"守护进程就在本进程里、dsh 在这个地址上"的会合文件。 */
function publishState(
  group: string,
  options: {
    baseUrl?: string;
    token?: string;
    supervisorPid?: number;
    starting?: boolean;
    socket?: string;
    /** dsh 子进程 pid（第 9 组要"换了新进程"这个事实）。 */
    serverPid?: number;
  } = {},
): void {
  const directory = supervisorDirectory(group);
  writeState(directory, {
    version: STATE_VERSION,
    supervisorPid: options.supervisorPid ?? process.pid,
    startedAt: Date.now(),
    serverPid: options.serverPid ?? 4242,
    baseUrl: options.baseUrl,
    token: options.token,
    command: "dsh web --port 0 --no-open",
    idleSec: 10,
    socket: options.socket ?? DEAD_SOCKET,
    starting: options.starting ?? false,
  });
}

/**
 * 起一个**真的守护进程 socket 服务端**，数它当前有几条活连接、并记下收到的 control 请求。
 *
 * 「切到外部 / 停止连接之后本窗口还连着守护进程吗」只能这样测：管理器认的是 `state.socket`，
 * 而"还连着"的后果正是"守护进程把它算作还有人用"——所以判据必须是**对面看到的连接数**，
 * 不是源码里有没有某一句。control 请求同理：第 9 组要的是"重启这个请求到底有没有发出去"。
 *
 * **必须挂一个 `data` 监听**（实测，不是风格问题）：socket 处在 paused 态时，Node 不跑
 * 读循环，对面 `destroy()` 之后这里**永远收不到 `close`**（本机实测：paused 版 2 秒后
 * closed=false，flowing 版立刻 true）。真实的守护进程正是挂了 `data`（`main.ts` 里解析
 * control 请求），所以这里要跟它一样——否则测的就不是它。
 */
async function listenDaemon(
  path: string,
  onControl?: (action: string) => void,
): Promise<{ close: () => Promise<void>; clients: () => number; controls: () => string[] }> {
  let live = 0;
  const controls: string[] = [];
  const server: Server = createServer((socket) => {
    live += 1;
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // 用**真的**协议解码器：这里要判"重启请求到底有没有发出去"，
        // 自己拿 JSON.parse 猜一遍就等于把被测协议又实现了一次
        const message = decodeClientMessage(line.trim());
        if (message?.t !== "control") continue;
        controls.push(message.action);
        onControl?.(message.action);
      }
    });
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
    controls: () => [...controls],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 兜底：还有连接没断时 `close()` 的回调不会来（它等所有连接结束）。
        // 断言结尾不该被一条没断干净的连接挂住整个测试进程。
        setTimeout(resolve, 1_000).unref?.();
      }),
  };
}

/** 等一个真实事件到达（连接断开是异步的，不能立刻断言）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

  // ---------- 7. 目标切到外部：**与守护进程的连接必须真的断开**（2026-09-19 修） ----------
  //
  // 用户实测的 bug：本来是内部那套，内部 dsh 崩掉（守护进程又把它拉起来）之后用户点了
  // 「连接外部 DSH」——界面连上了外部，可那条守护进程 socket 还开着，于是
  // ① 守护进程一直把 dsh 拎着不放（"内部 DSH 一直存在"）；
  // ② 它继续推状态，把管理器的 status 改回内部那一套（诊断里显示的地址、进程、
  //    共用窗口数全成了内部的）。
  // 判据必须是**对面（守护进程）看到的活连接数**——这里起一个真的 socket 服务端来数。
  {
    const group = "policy-switch";
    const directory = supervisorDirectory(group);
    const socket = socketPathIn(directory, group);
    const internalUrl = await listen();
    const externalUrl = await listen();
    // 先写会合文件（顺带把分组目录建出来——POSIX 上 AF_UNIX 节点要在已存在的目录里），
    // 再起守护进程侧的 socket 监听
    publishState(group, { baseUrl: internalUrl.baseUrl, token: "internal-token", socket });
    const daemon = await listenDaemon(socket);
    const manager = new SupervisorManager({
      group,
      url: externalUrl.baseUrl,
      command: "dsh web --port 0 --no-open",
      autoConnect: false,
      launcher: fakeLauncher().launcher as never,
      log: () => undefined,
    });
    managers.push(manager);

    const internal = await manager.ensure({ start: false, target: "internal" });
    await waitFor(() => daemon.clients() === 1);
    check("先接上内部：守护进程看到 1 条活连接", daemon.clients() === 1, `clients=${daemon.clients()}`);
    check("内部那一轮报的是内部地址", internal.baseUrl === internalUrl.baseUrl, internal.baseUrl);

    const external = await manager.ensure({ start: false, target: "external" });
    check("切到外部：返回的是外部地址", external.baseUrl === externalUrl.baseUrl, external.baseUrl);
    check(
      "切到外部：状态里的地址也换成外部那个",
      manager.getStatus().info?.baseUrl === externalUrl.baseUrl,
      manager.getStatus().info?.baseUrl ?? "（无）",
    );
    check("切到外部：本窗口不再报内部那套后台（peekState 为空）", manager.peekState() === undefined);
    await waitFor(() => daemon.clients() === 0);
    check(
      "切到外部：与守护进程的连接**真的断了**（守护进程看到 0 条，它据此才会按空闲阈值收场）",
      daemon.clients() === 0,
      `clients=${daemon.clients()}`,
    );

    // 再等一会儿：确认没有残留推送把状态改回内部那一套
    await new Promise((resolve) => setTimeout(resolve, 600));
    check(
      "切到外部之后状态仍然是外部（内部那套不再写状态）",
      manager.getStatus().state === "ready" && manager.getStatus().info?.baseUrl === externalUrl.baseUrl,
      `${manager.getStatus().state} / ${manager.getStatus().info?.baseUrl ?? "（无）"}`,
    );

    // 切回内部：连接要能重新建起来（断开不等于把这条路焊死）
    const back = await manager.ensure({ start: false, target: "internal" });
    check("再切回内部：重新接上并拿到内部地址", back.baseUrl === internalUrl.baseUrl, back.baseUrl);
    await waitFor(() => daemon.clients() === 1);
    check("再切回内部：守护进程又看到 1 条活连接", daemon.clients() === 1, `clients=${daemon.clients()}`);

    manager.dispose();
    await daemon.close();
    await internalUrl.close();
    await externalUrl.close();
  }

  // ---------- 8. 用户点「停止连接」：彻底交还占用，且**心跳不许接回来**（2026-09-19） ----------
  //
  // 用户口径：不连就不占用。只"断"不"挡"是不够的——心跳 5 秒后会看到"会合文件里那套还活着"
  // 并立刻重新接上，用户看到的是"点了停止，过一会儿又连上了"。
  // 这里直接调私有的 `heartbeatTick`（编译产物里没有 private；等 5 秒太慢，而它正是唯一会
  // "自己接回来"的那条路径）。
  {
    const group = "policy-release";
    const directory = supervisorDirectory(group);
    const socket = socketPathIn(directory, group);
    const internalUrl = await listen();
    publishState(group, { baseUrl: internalUrl.baseUrl, token: "internal-token", socket });
    const daemon = await listenDaemon(socket);
    const manager = new SupervisorManager({
      group,
      url: "",
      command: "dsh web --port 0 --no-open",
      autoConnect: false,
      launcher: fakeLauncher().launcher as never,
      log: () => undefined,
    });
    managers.push(manager);

    await manager.ensure({ start: false, target: "internal" });
    await waitFor(() => daemon.clients() === 1);
    check("先接上内部", daemon.clients() === 1, `clients=${daemon.clients()}`);

    manager.releaseInternal();
    await waitFor(() => daemon.clients() === 0);
    check("「停止连接」：与守护进程的连接交还了（对面 0 条）", daemon.clients() === 0, `clients=${daemon.clients()}`);
    check("「停止连接」：状态回到按钮态", manager.getStatus().state === "stopped", manager.getStatus().state);
    check("「停止连接」：不再报内部那套后台（peekState 为空）", manager.peekState() === undefined);

    // 心跳跑一轮：**这是关键**——守护进程此刻还活着，接回分支就在眼前
    await (manager as unknown as { heartbeatTick(): Promise<void> }).heartbeatTick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    check(
      "心跳**没有**把连接自动接回来（用户叫停要一直算数，直到他显式动作）",
      daemon.clients() === 0,
      `clients=${daemon.clients()}`,
    );

    // 显式动作（发消息 / 点连接按钮都走这条路）：必须能重新接上
    const again = await manager.ensure({ start: false, target: "internal" });
    check("显式动作能重新接上（叫停不把这条路焊死）", again.baseUrl === internalUrl.baseUrl, again.baseUrl);
    await waitFor(() => daemon.clients() === 1);
    check("显式动作之后守护进程又看到 1 条活连接", daemon.clients() === 1, `clients=${daemon.clients()}`);

    manager.dispose();
    await daemon.close();
    await internalUrl.close();
  }

  // ---------- 9. 「停止连接」之后再点「重启内部 DSH」：**必须真的重启**（2026-09-19） ----------
  //
  // 交还占用之后 `connection` 是空的，而这正是"停止连接过"之后的常态。重启在这条路径上
  // 原来直接 `return this.ensure(...)`——只接上、**一个控制帧都没发**，界面却照旧弹
  // "DSH 服务器已重启。"。这条断言数两件事：
  // ① 守护进程真的收到了 `restart` 控制帧；
  // ② 返回的是**新地址**——那句 `state.serverPid === previous` 的 `previous` 一旦读早了
  //    （交还后 `this.state` 是空的 → undefined），"还没开始重起就接着等"就永远不成立，
  //    于是会把**旧地址**当成"重启完成"报出去。假守护进程故意留 700ms 才写新状态，
  //    就是为了让那个旧读法在这条断言上显形。
  {
    const group = "policy-restart-detached";
    const directory = supervisorDirectory(group);
    const socket = socketPathIn(directory, group);
    const oldUrl = await listen();
    const newUrl = await listen();
    publishState(group, { baseUrl: oldUrl.baseUrl, token: "old-token", socket, serverPid: 4242 });
    const daemon = await listenDaemon(socket, (action) => {
      if (action !== "restart") return;
      // 模拟真实守护进程：重起 dsh 要几秒，这段时间会合文件里还是**旧**的那一份
      setTimeout(() => {
        publishState(group, { baseUrl: newUrl.baseUrl, token: "new-token", socket, serverPid: 9001 });
      }, 700);
    });
    const manager = new SupervisorManager({
      group,
      url: "",
      command: "dsh web --port 0 --no-open",
      autoConnect: false,
      launcher: fakeLauncher().launcher as never,
      log: () => undefined,
    });
    managers.push(manager);

    await manager.ensure({ start: false, target: "internal" });
    manager.releaseInternal(); // = 界面上的「停止连接」
    await waitFor(() => daemon.clients() === 0);
    check("前置：交还占用之后对面 0 条连接", daemon.clients() === 0, `clients=${daemon.clients()}`);

    const info = await manager.restart({ target: "internal" });
    check(
      "「停止连接」之后再重启：控制帧真的发给了守护进程（不是「只接上」）",
      daemon.controls().includes("restart"),
      daemon.controls().join(",") || "（一个 control 都没收到）",
    );
    check(
      "「停止连接」之后再重启：拿到的是**新**地址（旧的那份不算「重启完成」）",
      info.baseUrl === newUrl.baseUrl,
      `${info.baseUrl}（旧地址=${oldUrl.baseUrl}）`,
    );
    await waitFor(() => daemon.clients() === 1);
    check("重启期间连接保持（断了守护进程会半路空闲退场）", daemon.clients() === 1, `clients=${daemon.clients()}`);

    manager.dispose();
    await daemon.close();
    await oldUrl.close();
    await newUrl.close();
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
  console.log(
    "\n✓ supervisor 启动/重连决策（许可 / 复用 / 令牌来自会合文件 / 只读探测 / 等待可中断 / 外部也等到底 / 换目标彻底断开 / 停止连接交还占用且心跳不接回 / 交还后重启仍是真重启）全通过",
  );
  assert.ok(true);
}
