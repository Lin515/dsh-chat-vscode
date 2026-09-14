/**
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
 *   6) `stopAndExit()` 让 supervisor 收场（端口关闭、会合文件消失）。
 *
 * 用法：node build/supervisor-manager-probe.mjs [日志文件]
 */
import { appendFileSync, writeFileSync } from "node:fs";
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
function makeWindow(tag: string): SupervisorManager {
  return new SupervisorManager({
    group: GROUP,
    url: "",
    command: COMMAND,
    // 阈值取下限：探针十几秒出结论；默认值的正确性由离线断言覆盖
    idleSec: 5,
    workspace: `D:/dev/dsh-chat#${tag}`,
    launcher: createDefaultSupervisorLauncher({ log: (line) => say(`   [${tag}] ${line}`) }),
    log: (line) => say(`   [${tag}] ${line}`),
  });
}

let windowA: SupervisorManager | undefined;
let windowB: SupervisorManager | undefined;
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
  windowB = undefined;
  check("会合文件消失、端口关闭", cleaned, `端口 ${stopPort}`);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  windowA?.dispose();
  windowB?.dispose();
  const state = readState(supervisorDirectory(GROUP));
  if (state) {
    const { spawn } = await import("node:child_process");
    spawn("taskkill", ["/pid", String(state.supervisorPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (state.serverPid) spawn("taskkill", ["/pid", String(state.serverPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  say(failures === 0 ? "\n✓ 扩展侧管理器（ensure/接入/心跳/重启/停止）全通" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
void url;
