/**
 * 端到端探针 **R2/R4/R5/R6**（设计 §6.2），一个文件跑四件事（共用 `supervisorPingerHarness`）：
 *
 * - **R4 并发启动只有一个赢**：3 个窗口同时激活 → 只有 1 个 supervisor、1 个 dsh，三者拿到同一地址；
 * - **R2 多窗口共享**：三个窗口同时在线时仍只有 1 个 dsh；关掉其中两个，第三个不受影响；
 * - **R5 supervisor 崩了能自愈**：强杀 supervisor（**不加 /T**，留下孤儿 dsh）→
 *   新一轮窗口必须能重新起一套并接上，且**遗留的 dsh 被回收**（端口不乱占）；
 * - **R6 用户能立刻停**：任一窗口发 `stop` 控制请求 → supervisor 与 dsh 都干净退出、会合文件与 socket 清掉。
 *
 * 用法：node build/supervisor-scenarios-probe.mjs [日志文件]
 */
import { appendFileSync, writeFileSync } from "node:fs";
// 必须排在最前面：会合目录指到本次探针专用目录
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { readState, supervisorDirectory } from "../src/dsh/supervisorProtocol";
import { SupervisorConnection } from "../src/dsh/supervisorClient";
import { isProcessAlive } from "../src/dsh/processRegistry";
import {
  closePinger,
  killPinger,
  killTree,
  portListening,
  startPinger,
  waitUntil,
  type StartedPinger,
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
const GROUP = require("node:crypto").createHash("sha256").update(`internal:${COMMAND}`).digest("hex").slice(0, 12);
const DIRECTORY = supervisorDirectory(GROUP);

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
const started: StartedPinger[] = [];
const extraPids: number[] = [];

try {
  say(`会合根目录（隔离）：${isolated}`);
  say(`会合目录：${DIRECTORY}`);

  // ---------- R4：三个窗口同时激活 ----------
  say("\n【R4】三个窗口同时激活 → 只能有一套 supervisor + 一个 dsh…");
  const trio = await Promise.all([
    startPinger("race-a", COMMAND),
    startPinger("race-b", COMMAND),
    startPinger("race-c", COMMAND),
  ]);
  started.push(...trio);
  const urls = trio.map((item) => item.info.baseUrl);
  const supervisorPids = trio.map((item) => item.info.supervisorPid);
  const serverPids = trio.map((item) => item.info.serverPid);
  check("三个窗口都拿到了地址", urls.every(Boolean), urls.join(" / "));
  check("三个窗口拿到的是**同一个**后台", new Set(urls).size === 1, JSON.stringify(urls));
  check("只有一套 supervisor", new Set(supervisorPids).size === 1, JSON.stringify(supervisorPids));
  check("只有一个 dsh 进程", new Set(serverPids).size === 1, JSON.stringify(serverPids));
  const launchers = trio.filter((item) => item.info.launched === true).length;
  check("只有一个窗口是「启动者」（并发靠锁串行化）", launchers === 1, `启动者数=${launchers}`);

  // ---------- R2：多窗口共享 ----------
  say("\n【R2】关掉其中两个窗口 → 第三个必须不受影响…");
  const survivor = trio[2];
  const survivorUrl = survivor.info.baseUrl ?? "";
  const survivorPort = Number(new URL(survivorUrl).port);
  await closePinger(trio[0]);
  await closePinger(trio[1]);
  const stillServing = await waitUntil("后台仍在服务", async () => {
    const state = readState(DIRECTORY);
    return state?.baseUrl === survivorUrl && (await portListening(survivorPort));
  }, 10_000);
  check("后台没被带走（还有人在用）", stillServing, `${survivorUrl}（api=${await portListening(survivorPort)}）`);
  check(
    "会合文件里还是同一套（supervisor 没重启）",
    readState(DIRECTORY)?.serverPid === survivor.info.serverPid,
    `server=${readState(DIRECTORY)?.serverPid ?? "?"}`,
  );

  // ---------- R6：stop 控制请求 ----------
  say("\n【R6】发 stop 控制请求 → supervisor 与 dsh 都干净退出…");
  const stateBeforeStop = readState(DIRECTORY);
  const connection = new SupervisorConnection(
    stateBeforeStop?.socket ?? "",
    {
      onState: () => undefined,
      onGoodbye: (reason) => say(`   （收到 goodbye：${reason}）`),
      onClosed: () => undefined,
      log: say,
    },
    { hostId: `stopper-${process.pid}`, workspace: "D:/dev/dsh-chat#stopper" },
  );
  const connected = await connection.open();
  check("stop 连接建立", connected);
  if (connected && stateBeforeStop) {
    const supervisorPid = stateBeforeStop.supervisorPid;
    extraPids.push(supervisorPid);
    connection.control("stop");
    const cleaned = await waitUntil("干净退场", async () => {
      const state = readState(DIRECTORY);
      return state === undefined && !(await portListening(survivorPort)) && !isProcessAlive(supervisorPid);
    }, 30_000);
    check("stop 之后：会合文件、端口、supervisor 全部清干净", cleaned, `pid=${supervisorPid} port=${survivorPort}`);
  }
  connection.close();
  await closePinger(survivor);

  // ---------- R5：强杀 supervisor，留孤儿 dsh ----------
  say("\n【R5】强杀 supervisor（**不加 /T**）→ 留下孤儿 dsh → 新一轮窗口必须能自愈…");
  const first = await startPinger("crash-a", COMMAND);
  started.push(first);
  const crashedUrl = first.info.baseUrl ?? "";
  const crashedPort = Number(new URL(crashedUrl).port);
  const crashedSupervisor = first.info.supervisorPid;
  check("先有一套可用后台", Boolean(crashedUrl), `${crashedUrl}（supervisor=${crashedSupervisor}）`);

  // 窗口也一起关掉：确保"没人用"，只有孤儿 dsh 留在端口上
  await closePinger(first);
  killPinger(crashedSupervisor);
  const supervisorGone = await waitUntil("supervisor 已死", async () => !isProcessAlive(crashedSupervisor), 15_000);
  check("supervisor 已被强杀（会合文件随之变成陈旧/消失）", supervisorGone, `pid=${crashedSupervisor}`);
  const orphanStillListening = await portListening(crashedPort);
  say(`   （现场）孤儿 dsh 是否还在监听 ${crashedPort}：${orphanStillListening}`);

  const second = await startPinger("crash-b", COMMAND);
  started.push(second);
  check("新一轮窗口拿到了可用后台", Boolean(second.info.baseUrl), second.info.baseUrl ?? "");
  check(
    "新一轮是一套**新的** supervisor（旧的确实死了）",
    second.info.supervisorPid !== crashedSupervisor,
    `旧=${crashedSupervisor} 新=${second.info.supervisorPid}`,
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
  for (const pinger of started) {
    if (pinger.child.pid !== undefined) killTree(pinger.child.pid);
  }
  const state = readState(DIRECTORY);
  if (state) {
    killTree(state.supervisorPid);
    killTree(state.serverPid);
  }
  for (const pid of extraPids) killTree(pid);
  say(failures === 0 ? "\n✓ 并发/共享/崩溃自愈/立刻停 四条都成立" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
