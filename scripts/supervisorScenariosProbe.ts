/**
 * 端到端探针 **R2/R4/R5/R6**（设计 §6.2），一个文件跑四件事（共用 `supervisorPingerHarness`）：
 *
 * - **R4 并发启动只有一个赢**：3 个窗口同时激活 → 只有 1 个 supervisor、1 个 dsh，三者拿到同一地址；
 * - **R2 多窗口共享**：三个窗口同时在线时仍只有 1 个 dsh；关掉其中两个，第三个不受影响；
 * - **R5 supervisor 崩了能自愈**：强杀 supervisor（**不加 /T**，留下孤儿 dsh）→
 *   新一轮窗口必须能重新起一套并接上，且**遗留的 dsh 被回收**（端口不乱占）；
 * - **R6 用户能立刻停**：任一窗口请守护进程停（`stopAndExit()` = 命令面板「停止内部 DSH」那条路）
 *   → supervisor 与 dsh 都干净退出、会合文件清掉。
 *
 * **窗口就是扩展真正用的那个管理器**（`SupervisorManager`）：三个"窗口"是三个管理器实例，
 * 并发的 `ensure()` 走的就是扩展激活期那一步——从前的 pinger 手抄了一遍流程，
 * 那时这几个验收探针验的是副本。
 */
import { appendFileSync, writeFileSync } from "node:fs";
// 必须排在最前面：会合目录指到本次探针专用目录
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { readState } from "../src/dsh/supervisorProtocol";
import { isProcessAlive } from "../src/dsh/processRegistry";
import {
  ProbeWindow,
  alive,
  killProcess,
  portListening,
  stopAllProbeProcesses,
  waitUntil,
} from "./supervisorPingerHarness";

const LOG = process.argv[2] ?? ".tmp/supervisor-scenarios.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const COMMAND = "dsh web --port 0 --no-open";

/**
 * 隔离自检：**必须**跑在临时目录里。
 *
 * 这一条是踩出来的：`supervisorProbeEnv` 只靠副作用设环境变量，而 esbuild 会把
 * "没有用到处方导出"的模块整份摇掉 —— 于是环境变量根本没设上，探针静默跑到了
 * 用户的真实目录（`~/.dsh/dsh-chat-vscode/supervisors`）里去起后台、甚至可能把用户的后台带走。
 * 所以这里既**用一下**那个导出（保住副作用），又把它当作硬前置条件断言。
 */
const isolated = PROBE_SUPERVISOR_ROOT;
if (!isolated || !/dsh-chat-sup-probe-/.test(isolated)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${isolated}（探针只在专用临时目录里跑）\n`);
  process.exit(2);
}

/** 记下探针起过的一切，收尾时全部带走（绝不留给用户机器）。 */
const windows: ProbeWindow[] = [];

function makeWindow(tag: string): ProbeWindow {
  const window = new ProbeWindow({ tag, command: COMMAND }, say);
  windows.push(window);
  return window;
}

/**
 * 会合目录（分组由 `groupForConfig` 算，与扩展同构）。
 *
 * 只借一个窗口实例问一次，**马上关掉它**：它的心跳会继续跑（"别的窗口把后台起起来就接上"
 * 正是扩展的行为），留着它会让 R5 的"新一轮"判据变糊。
 */
const DIRECTORY = (() => {
  const holder = new ProbeWindow({ tag: "group-probe", command: COMMAND }, say);
  const directory = holder.directory;
  holder.dispose();
  return directory;
})();

try {
  say(`会合根目录（隔离）：${isolated}`);
  say(`会合目录：${DIRECTORY}`);

  // ---------- R4：三个窗口同时激活 ----------
  say("\n【R4】三个窗口同时激活 → 只能有一套 supervisor + 一个 dsh…");
  const trio = [makeWindow("race-a"), makeWindow("race-b"), makeWindow("race-c")];
  await Promise.all(trio.map((window) => window.ensure({ start: true })));
  const urls = trio.map((window) => window.baseUrl);
  const supervisorPids = trio.map((window) => window.state()?.supervisorPid);
  const serverPids = trio.map((window) => window.state()?.serverPid);
  check("三个窗口都拿到了地址", urls.every(Boolean), urls.join(" / "));
  check("三个窗口拿到的是**同一个**后台", new Set(urls).size === 1, JSON.stringify(urls));
  check("只有一套 supervisor", new Set(supervisorPids).size === 1, JSON.stringify(supervisorPids));
  check("只有一个 dsh 进程", new Set(serverPids).size === 1, JSON.stringify(serverPids));
  const launchers = trio.filter((window) => window.launched).length;
  check("只有一个窗口是「启动者」（并发靠锁串行化）", launchers === 1, `启动者数=${launchers}`);

  // ---------- R2：多窗口共享 ----------
  say("\n【R2】关掉其中两个窗口 → 第三个必须不受影响…");
  const survivor = trio[2];
  const survivorUrl = survivor.baseUrl ?? "";
  const survivorPort = survivor.port ?? 0;
  trio[0].dispose();
  trio[1].dispose();
  const stillServing = await waitUntil("后台仍在服务", async () => {
    const state = readState(DIRECTORY);
    return state?.baseUrl === survivorUrl && (await portListening(survivorPort));
  }, 10_000);
  check("后台没被带走（还有人在用）", stillServing, `${survivorUrl}（api=${await portListening(survivorPort)}）`);
  check(
    "会合文件里还是同一套（supervisor 没重启）",
    readState(DIRECTORY)?.serverPid === serverPids[2],
    `server=${readState(DIRECTORY)?.serverPid ?? "?"}`,
  );

  // ---------- R6：「停止内部 DSH」 ----------
  say("\n【R6】请守护进程停（「停止内部 DSH」那条路）→ supervisor 与 dsh 都干净退出…");
  const stateBeforeStop = readState(DIRECTORY);
  const supervisorPidBeforeStop = stateBeforeStop?.supervisorPid;
  const stopped = await survivor.stopAndExit();
  check("停止请求真的发出去了（回执不撒谎）", stopped, String(stopped));
  const cleaned = await waitUntil("干净退场", async () => {
    return (
      readState(DIRECTORY) === undefined &&
      !(await portListening(survivorPort)) &&
      !alive(supervisorPidBeforeStop)
    );
  }, 30_000);
  check(
    "stop 之后：会合文件、端口、supervisor 全部清干净",
    cleaned,
    `pid=${supervisorPidBeforeStop} port=${survivorPort}`,
  );

  // ---------- R5：强杀 supervisor，留孤儿 dsh ----------
  say("\n【R5】强杀 supervisor（**不加 /T**）→ 留下孤儿 dsh → 新一轮窗口必须能自愈…");
  const first = makeWindow("crash-a");
  await first.ensure({ start: true });
  const crashedUrl = first.baseUrl ?? "";
  const crashedPort = first.port ?? 0;
  const crashedSupervisor = first.state()?.supervisorPid;
  check("先有一套可用后台", Boolean(crashedUrl), `${crashedUrl}（supervisor=${crashedSupervisor}）`);

  // 窗口也一起关掉：确保"没人用"，只有孤儿 dsh 留在端口上
  first.dispose();
  killProcess(crashedSupervisor);
  const supervisorGone = await waitUntil("supervisor 已死", async () => !alive(crashedSupervisor), 15_000);
  check("supervisor 已被强杀（会合文件随之变成陈旧/消失）", supervisorGone, `pid=${crashedSupervisor}`);
  const orphanStillListening = await portListening(crashedPort);
  say(`   （现场）孤儿 dsh 是否还在监听 ${crashedPort}：${orphanStillListening}`);

  const second = makeWindow("crash-b");
  await second.ensure({ start: true });
  const secondSupervisor = second.state()?.supervisorPid;
  check("新一轮窗口拿到了可用后台", Boolean(second.baseUrl), second.baseUrl ?? "");
  check(
    "新一轮是一套**新的** supervisor（旧的确实死了）",
    secondSupervisor !== crashedSupervisor && !isProcessAlive(crashedSupervisor),
    `旧=${crashedSupervisor} 新=${secondSupervisor}`,
  );
  if (orphanStillListening) {
    const reclaimed = await waitUntil("孤儿被回收", async () => !(await portListening(crashedPort)), 20_000);
    check(
      "遗留的孤儿 dsh 被回收（否则固定端口场景下新 dsh 会 EADDRINUSE）",
      reclaimed,
      reclaimed ? `端口 ${crashedPort} 已释放` : `端口 ${crashedPort} 还被占着`,
    );
  }
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  await stopAllProbeProcesses({ windows, directory: DIRECTORY });
  say(failures === 0 ? "\n✓ 并发/共享/崩溃自愈/立刻停 四条都成立" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
