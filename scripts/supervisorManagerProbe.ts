/**
 * 【探针定位】防线型 · 零模型 token —— 验「扩展真正用的 SupervisorManager」端到端
 *   行为（会合/接入/心跳/就绪），发的是协议帧不是模型消息；动 supervisor 链路后跑，
 *   可自由运行。
 *
 * 端到端探针：**扩展真正用的那个管理器**（`SupervisorManager`）能不能跑通。
 *
 * 为什么单独一条：`supervisorReloadProbe` / `IdleProbe` / `ScenariosProbe` 都是拿
 * pinger 直接驱动 `supervisorClient`（协议层），而扩展里跑的是 `SupervisorManager`
 * ——它才是"窗口"这一侧的真实实现（会合 → 确保 → 长连接 → 心跳 → 就绪信息）。
 * 少了这一条，"集成"就是没验证过的。
 *
 * 覆盖：
 *   1) `ensure()` 能起一套并拿到 baseUrl/token（走真实启动器：VS Code 自带 Node 跑 dist/supervisor.js）；
 *   2) 第二个"窗口"（同分组的另一个 manager）拿到**同一个地址**，且它是"接入"不是"启动"；
 *   3) `sharedSummary().hostCount` 从 supervisor 报的活连接数来（两个窗口 = 2）；
 *   4) 关掉第一个窗口（`dispose()`）**不杀后台**；第二个窗口继续可用；
 *   5) `restart()` 能换一个新的 dsh（端口可能变），本窗口跟着换地址；
 *   6) `stopAndExit()` 让 supervisor 收场（端口关闭、会合文件消失）；
 *   7) **切到外部之后，内部那套必须自己退场**（2026-09-19 修的那个 bug 的端到端验收）：
 *      起一套内部后台 → 目标切到外部 → 本窗口一断开，守护进程就没有活连接了，于是它按
 *      空闲阈值连 dsh 一起收场（会合文件消失、端口关闭）。判据全是真事件，不看日志。
 *
 * 用法：node build/supervisor-manager-probe.mjs [日志文件]
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：会合目录指到本次探针专用目录
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { SupervisorManager } from "../src/dsh/supervisorManager";
import { createDefaultSupervisorLauncher } from "../src/dsh/supervisorRunner";
import { readState, supervisorDirectory } from "../src/dsh/supervisorProtocol";
import { portListening } from "./supervisorPingerHarness";

const LOG = process.argv[2] ?? ".tmp/supervisor-manager.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 隔离自检（esbuild 会摇掉"没用到导出"的副作用模块，见 supervisorReloadProbe 的说明）。 */
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}

const COMMAND = "dsh web --port 0 --no-open";
const GROUP = "manager-probe";

/** 造一个"窗口"：与扩展里完全同构（同一份 SupervisorManager + 同一个真实启动器）。 */
function makeWindow(tag: string, url = ""): SupervisorManager {
  return new SupervisorManager({
    group: GROUP,
    url,
    command: COMMAND,
    // 阈值取下限：探针十几秒出结论；默认值的正确性由离线断言覆盖
    idleSec: 5,
    workspace: `D:/dev/dsh-chat#${tag}`,
    launcher: createDefaultSupervisorLauncher({ log: (line) => say(`   [${tag}] ${line}`) }),
    log: (line) => say(`   [${tag}] ${line}`),
  });
}

/** 第 7 步用的"外部 DSH"：一个**会应答**的本地 HTTP 服务（可达性探测认的就是应答）。 */
async function fakeExternal(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createHttpServer((_request, response) => {
    response.statusCode = 200;
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // keep-alive 连接会让 close() 的回调一直等（fetch 留下的）
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let windowA: SupervisorManager | undefined;
let windowB: SupervisorManager | undefined;
let windowC: SupervisorManager | undefined;
let windowD: SupervisorManager | undefined;
let windowE: SupervisorManager | undefined;
let externalProbe: { close: () => Promise<void> } | undefined;
let url: string | undefined;

try {
  say(`会合根目录（隔离）：${PROBE_SUPERVISOR_ROOT}`);
  say(`会合目录：${supervisorDirectory(GROUP)}`);

  say("\n1) 窗口 A：ensure() 起一套后台…");
  windowA = makeWindow("A");
  const infoA = await windowA.ensure();
  url = infoA.baseUrl;
  const port = Number(new URL(url).port);
  check("拿到地址与令牌", Boolean(infoA.baseUrl && infoA.token), `${infoA.baseUrl} ownership=${infoA.ownership}`);
  check("本窗口是启动者（ownership=self）", infoA.ownership === "self");
  check("端口真的在服务", await portListening(port), `端口 ${port}`);
  check("状态是 ready", windowA.getStatus().state === "ready", windowA.getStatus().state);

  say("\n2) 窗口 B（同分组）：必须接入同一套，而不是各起一个…");
  windowB = makeWindow("B");
  const infoB = await windowB.ensure();
  check("B 拿到同一个地址", infoB.baseUrl === url, `${url} vs ${infoB.baseUrl}`);
  check("B 是接入者（ownership=peer）", infoB.ownership === "peer", infoB.ownership);
  // 连接数是 supervisor 广播过来的，B 连上之后要等那一帧到（异步，不是同步可读）
  const sawTwo = await (async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if ((windowB?.sharedSummary()?.hostCount ?? 0) === 2) return true;
      await delay(300);
    }
    return false;
  })();
  check(
    "supervisor 报的活连接数=2（这个数字只有它知道，不再靠窗口之间投票）",
    sawTwo,
    `hostCount=${windowB.sharedSummary()?.hostCount}`,
  );

  say("\n3) 关掉窗口 A（dispose）→ **不许杀后台**…");
  windowA.dispose();
  windowA = undefined;
  await delay(2_000);
  const stateAfterA = readState(supervisorDirectory(GROUP));
  check("会合文件还在（supervisor 没被带走）", stateAfterA !== undefined);
  check("端口还在服务", await portListening(port), `端口 ${port}`);
  check("B 的连接仍然可用", windowB.getStatus().state === "ready", windowB.getStatus().state);

  say("\n4) 窗口 B：restart() → 换一个新的 dsh…");
  // 判"换了进程"用**令牌**而不是 pid：`--port 0` 下端口会变、而 shell 的 pid 会被 Windows
  // 立刻回收（实测：重起前后 pid 相同，但确实是新进程）。令牌是 dsh 每次启动新铸的随机值，
  // 它是"这是新起的 dsh"的确定证据。
  const beforeRestart = readState(supervisorDirectory(GROUP));
  const infoRestart = await windowB.restart();
  const afterRestart = readState(supervisorDirectory(GROUP));
  check("重启后拿到可用地址", Boolean(infoRestart.baseUrl), infoRestart.baseUrl ?? "");
  check(
    "dsh 确实换了新进程（令牌变了）",
    Boolean(beforeRestart?.token) && Boolean(afterRestart?.token) && beforeRestart?.token !== afterRestart?.token,
    `token ${beforeRestart?.token ? "旧有" : "旧无"} → ${afterRestart?.token ? "新有" : "新无"}`,
  );
  check("新地址在服务", await portListening(Number(new URL(infoRestart.baseUrl).port)), infoRestart.baseUrl);

  say("\n5) 窗口 B：stopAndExit() → supervisor 与 dsh 一起收场…");
  const stopPort = Number(new URL(infoRestart.baseUrl).port);
  windowB.stopAndExit();
  const cleaned = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (readState(supervisorDirectory(GROUP)) === undefined && !(await portListening(stopPort))) return true;
      await delay(400);
    }
    return false;
  })();
  check("会合文件消失、端口关闭", cleaned, `端口 ${stopPort}`);
  // **必须真的 dispose**（原来只是把引用置空）：不 dispose 的话它的心跳还活着，而心跳里
  // "会合文件里那一套还在就接上"是**设计行为**（别的窗口把后台重新起起来时本窗口要能接上）
  // ——第 6 步 C 起的新后台会被这个"已经没人管的 B"自动接上，于是数不出"没人用"，
  // 内部后台当然不会退场（实测：日志里出现 `[B] 在用的窗口数：1 → 2`）。
  windowB.dispose();
  windowB = undefined;

  say("\n6) 窗口 C：连内部 → 切到外部 → **内部那套必须自己退场**（2026-09-19 修的场景）…");
  // 用户实测的 bug：本来是内部那套，切到「连接外部 DSH」之后，那条守护进程 socket 还开着，
  // 守护进程就永远认为"还有人用"——它自动拉起来的内部 DSH 一直存在。现在切目标时会断开，
  // 于是守护进程按空闲阈值连 dsh 一起收场。这一格验的就是这条**真事件**链。
  const external = await fakeExternal();
  externalProbe = external;
  const winC = makeWindow("C", external.baseUrl);
  windowC = winC;
  const infoC = await winC.ensure({ start: true, target: "internal" });
  check("C 又拉起一套内部后台", Boolean(infoC.baseUrl && infoC.token), infoC.baseUrl ?? "");
  const cPort = Number(new URL(infoC.baseUrl).port);

  const toExternal = await winC.ensure({ start: false, target: "external" });
  check("切到外部：拿到外部地址", toExternal.baseUrl === external.baseUrl, toExternal.baseUrl);
  check(
    "切到外部：本窗口不再报内部那套后台（peekState 为空）",
    winC.peekState() === undefined,
    String(winC.peekState()),
  );
  check(
    "切到外部：状态里的地址是外部那个（没有被内部推送改回去）",
    winC.getStatus().info?.baseUrl === external.baseUrl,
    winC.getStatus().info?.baseUrl ?? "（无）",
  );

  // 本窗口断了 ⇒ 守护进程没有活连接 ⇒ 空闲阈值（这里 5s，另有"刚起来还没人连"的宽限）
  // 到点后它连 dsh 一起收场：会合文件消失、端口关闭。这正是"内部 DSH 不再一直存在"。
  const retired = await (async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (readState(supervisorDirectory(GROUP)) === undefined && !(await portListening(cPort))) return true;
      await delay(500);
    }
    return false;
  })();
  check("切到外部之后：内部后台自己退场（会合文件消失、dsh 端口关闭）", retired, `端口 ${cPort}`);

  say("\n7) 窗口 D：连内部 → 用户点「停止连接」→ 内部后台同样必须自己退场…");
  // 用户 2026-09-19 口径：**不连就不占用**。交还之后心跳**不许**把连接接回来（否则 5 秒后
  // 又连上了，"停止"等于没停），而没有别的窗口连着时后台就按空闲阈值退场。
  const winD = makeWindow("D");
  windowD = winD;
  const infoD = await winD.ensure({ start: true, target: "internal" });
  check("D 拉起一套内部后台", Boolean(infoD.baseUrl && infoD.token), infoD.baseUrl ?? "");
  const dPort = Number(new URL(infoD.baseUrl).port);

  winD.releaseInternal(); // = 界面上的「停止连接」在管理器侧做的那件事
  check("「停止连接」：本窗口不再报内部那套后台（peekState 为空）", winD.peekState() === undefined);

  const retiredAfterStop = await (async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (readState(supervisorDirectory(GROUP)) === undefined && !(await portListening(dPort))) return true;
      await delay(500);
    }
    return false;
  })();
  check("「停止连接」之后：内部后台自己退场（会合文件消失、dsh 端口关闭）", retiredAfterStop, `端口 ${dPort}`);

  say("\n8) 窗口 E：交还占用之后再点「重启内部 DSH」→ 必须**真的重起 dsh**（不是只接上）…");
  // 这条路径在"用户点过「停止连接」"之后是常态（连接是空的）。从前的实现只接上、一个控制帧
  // 都不发，界面却照旧弹"已重启"；判据用**令牌变了**（dsh 每次启动新铸随机值，见第 4 步）。
  const winE = makeWindow("E");
  windowE = winE;
  const infoE = await winE.ensure({ start: true, target: "internal" });
  check("E 拉起一套内部后台", Boolean(infoE.baseUrl && infoE.token), infoE.baseUrl ?? "");

  winE.releaseInternal(); // =「停止连接」
  const beforeRestartDetached = readState(supervisorDirectory(GROUP));
  const restarted = await winE.restart({ target: "internal" });
  const afterRestartDetached = readState(supervisorDirectory(GROUP));
  check(
    "交还占用之后再重启：dsh 确实换了新进程（令牌变了）",
    Boolean(beforeRestartDetached?.token) &&
      Boolean(afterRestartDetached?.token) &&
      beforeRestartDetached?.token !== afterRestartDetached?.token,
    `token ${beforeRestartDetached?.token ? "旧有" : "旧无"} → ${afterRestartDetached?.token ? "新有" : "新无"}`,
  );
  check("交还占用之后再重启：新地址在服务", await portListening(Number(new URL(restarted.baseUrl).port)), restarted.baseUrl);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  windowA?.dispose();
  windowB?.dispose();
  windowC?.dispose();
  windowD?.dispose();
  windowE?.dispose();
  await externalProbe?.close().catch(() => undefined);
  const state = readState(supervisorDirectory(GROUP));
  if (state) {
    const { spawn } = await import("node:child_process");
    spawn("taskkill", ["/pid", String(state.supervisorPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (state.serverPid) spawn("taskkill", ["/pid", String(state.serverPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  say(
    failures === 0
      ? "\n✓ 扩展侧管理器（ensure/接入/心跳/重启/停止/切到外部与停止连接后内部退场/交还后重启仍是真重启）全通"
      : `\n✗ ${failures} 项未通过`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
void url;
