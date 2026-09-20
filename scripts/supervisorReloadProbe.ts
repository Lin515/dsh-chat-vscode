/**
 * 【探针定位】防线型 · 零模型 token —— R1「重载窗口不打断后台」：地址/pid/世代
 *   不变的架构核心断言；动 supervisor 链路后跑，可自由运行。
 *
 * 端到端探针 **R1：重载窗口不打断后台**（设计 §6.2）——本次架构改动的核心断言。
 *
 * 现场：`dsh` 的生死挂在扩展宿主上，而 VS Code 打开文件夹/装扩展/改配置都会重载窗口；
 * 旧实例退出时看到"没有别的活心跳"就把 dsh 杀了，而接替它的新实例还没出生、投不了票。
 * 于是**每次重载都要冷启**（实测 5~8 秒），这正是用户报的"打开文件夹后后台没了"。
 *
 * 新形态的判据很直接：**dsh 的地址、pid 与世代必须一个字都不变**。
 *
 * 结构（窗口 = 扩展真正用的 `SupervisorManager`，见 `scripts/supervisorPingerHarness.ts`）：
 *   1) 窗口 A 起来 → 后台就绪，记下 baseUrl/serverPid/世代；
 *   2) **关掉 A**（`dispose()` = 扩展退出时那件事：只关自己的连接、不杀任何进程；
 *      "扩展宿主被强杀、来不及跑清理代码"那一格由 `dispose` + 连接断开覆盖——
 *      对守护进程而言两者都是"这条连接没了"）；
 *   3) 隔几秒起窗口 B → 必须**接着用同一个后台**（同一 baseUrl + 同一 serverPid）；
 *   4) 关窗 B → 收尾（等 supervisor 自己空闲退场，或由探针请它收场）。
 */
import { appendFileSync, writeFileSync } from "node:fs";
// 必须排在最前面：会合目录指到本次探针专用目录
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { setTimeout as delay } from "node:timers/promises";
import { generationOf, readState } from "../src/dsh/supervisorProtocol";
import { ProbeWindow, portListening, stopAllProbeProcesses, waitUntil } from "./supervisorPingerHarness";

const LOG = process.argv[2] ?? ".tmp/supervisor-reload.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const COMMAND = "dsh web --port 0 --no-open";

/**
 * 隔离自检：会合目录必须是本探针的临时目录。
 *
 * 踩过的坑：`supervisorProbeEnv` 只靠副作用设环境变量，esbuild 会把"没用到处方导出"
 * 的模块摇掉 → 环境变量没设上 → 探针静默跑进用户的真实目录。
 * 所以这里既用一下那个导出，也把它当硬前置条件。
 */
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}

let windowA: ProbeWindow | undefined;
let windowB: ProbeWindow | undefined;

try {
  say(`会合根目录（隔离）：${PROBE_SUPERVISOR_ROOT}`);

  say("\n1) 窗口 A 起来 → 后台就绪…");
  windowA = new ProbeWindow({ tag: "reload-a", command: COMMAND }, say);
  const infoA = await windowA.ensure({ start: true });
  const directory = windowA.directory;
  const serverPid = windowA.state()?.serverPid;
  const generationA = windowA.generation;
  say(`会合目录：${directory}`);
  check("A 就绪", Boolean(infoA.baseUrl), `${infoA.baseUrl}（server=${serverPid} supervisor=${windowA.state()?.supervisorPid}）`);
  check("A 是启动者（这一轮由它把 supervisor 拉起来）", windowA.launched, String(windowA.launched));

  say("\n2) **关掉窗口 A**（扩展退出/扩展宿主被强杀时做的事：只关自己的连接，不跑任何清理）…");
  windowA.dispose();
  await delay(3_000);
  const afterKill = readState(directory);
  check(
    "窗口没了，后台还在（这正是重载期间必须发生的事）",
    Boolean(afterKill?.baseUrl) && afterKill?.serverPid === serverPid,
    `会合文件：url=${afterKill?.baseUrl ?? "无"} server=${afterKill?.serverPid ?? "?"}`,
  );

  say("\n3) 隔 3 秒起窗口 B → **必须接着用同一个后台，不许重启**…");
  windowB = new ProbeWindow({ tag: "reload-b", command: COMMAND }, say);
  const infoB = await windowB.ensure({ start: true });
  check("B 接上的还是那个地址", infoB.baseUrl === infoA.baseUrl, `${infoA.baseUrl} vs ${infoB.baseUrl}`);
  check(
    "dsh 的 pid 一个字都没变（核心断言：重载没有打断后台）",
    windowB.state()?.serverPid === serverPid && serverPid !== undefined,
    `A=${serverPid} B=${windowB.state()?.serverPid}`,
  );
  check("还是同一套 supervisor（世代未变）", windowB.generation === generationA, `A=${generationA} B=${windowB.generation}`);
  check("B 不是启动者（它是接上去的）", windowB.launched === false, String(windowB.launched));
  check("端口照旧在服务", await portListening(windowB.port ?? 0), `端口 ${windowB.port ?? "?"}`);

  say("\n4) 关窗 B → 等 supervisor 空闲退场…");
  const bPort = windowB.port;
  windowB.dispose();
  const stateGone = await waitUntil("supervisor 自己收场", () => readState(directory) === undefined, 60_000);
  check("最后一个窗口退出后，会合文件被清掉（supervisor 自己收场）", stateGone, stateGone ? "已清" : "等了 60s 还在");
  // 顺带确认端口真的关了（进程没了才有意义）
  check("dsh 端口已关闭（没有留下孤儿）", !(await portListening(bPort ?? 0)), `端口 ${bPort ?? "?"}`);
  // 生成一次"世代"字符串，便于失败时对照
  if (afterKill) say(`   （诊断）关窗后的世代=${generationOf(afterKill)}`);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  // 两个窗口都已经关了（R1 要的就是"窗口没了"）；收尾只按会合目录兜一道，绝不留给用户机器
  await stopAllProbeProcesses({ windows: [], directory: windowB?.directory ?? windowA?.directory });
  say(failures === 0 ? "\n✓ 重载窗口不会打断后台" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
