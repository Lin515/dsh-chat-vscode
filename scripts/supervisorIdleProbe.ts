/**
 * 端到端探针 **R3：没人用就自己退场**（设计 §6.2）。
 *
 * 用户口径：最后一个窗口关闭后，supervisor 先在空闲阈值内等一等（默认 10s，
 * 这一档必须容得下"窗口重载 2~5 秒的空档"），然后**关掉 dsh 再关掉自己**，
 * 不留孤儿、不留僵尸。
 *
 * 判据（每一步都看事实，不看日志）：
 *   1) 窗口在时：端口在听、会合文件在、supervisor 进程活着；
 *   2) 关窗后 **阈值内**：一律照旧活着（不能提前退场——那是"重载即冷启"的老病）；
 *   3) 超过阈值后：端口关闭、会合文件消失、supervisor 进程也没了。
 *
 * **窗口就是扩展真正用的那个管理器**（`SupervisorManager`，见
 * `scripts/supervisorPingerHarness.ts`）：从前的 pinger 把扩展侧流程手抄了一遍，
 * 于是这条探针验的是副本；现在它与扩展逐字同一份代码。
 *
 * 用 `--idle-sec 5`（配置下限）跑，让探针在十几秒内出结论；默认值的正确性由
 * `supervisorProtocol.test.ts` 的阈值断言与手动验收覆盖。
 */
import { appendFileSync, writeFileSync } from "node:fs";
// 必须排在最前面：会合目录指到本次探针专用目录
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { setTimeout as delay } from "node:timers/promises";
import { readState } from "../src/dsh/supervisorProtocol";
import { tcpReachableSync } from "../src/dsh/processRegistry";
import { ProbeWindow, alive, portListening, stopAllProbeProcesses } from "./supervisorPingerHarness";

const LOG = process.argv[2] ?? ".tmp/supervisor-idle.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const COMMAND = "dsh web --port 0 --no-open";
const IDLE_SEC = 5;

/** 隔离自检（见 `supervisorReloadProbe` 的说明：esbuild 会摇掉"没用到导出"的副作用模块）。 */
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}

let window: ProbeWindow | undefined;
let directory: string | undefined;

try {
  say(`会合根目录（隔离）：${PROBE_SUPERVISOR_ROOT}`);
  say("\n1) 起窗口 → 后台就绪…");
  window = new ProbeWindow({ tag: "idle", command: COMMAND, idleSec: IDLE_SEC }, say);
  const info = await window.ensure({ start: true });
  say(`会合目录：${window.directory}（阈值 ${IDLE_SEC}s）`);
  directory = window.directory;
  const baseUrl = info.baseUrl;
  const supervisorPid = window.state()?.supervisorPid;
  const configuredIdle = readState(directory)?.idleSec;
  check(
    "前台按探针要求起了阈值（会合文件里记的就是它，supervisor 热读同一份）",
    configuredIdle === IDLE_SEC,
    `会合文件 idleSec=${configuredIdle ?? "?"}`,
  );
  check("就绪", Boolean(baseUrl), `${baseUrl}（supervisor=${supervisorPid} server=${window.state()?.serverPid}）`);
  check("端口真的在服务", await portListening(window.port ?? 0), `端口 ${window.port ?? "?"}`);

  say("\n2) 关窗 → **阈值之内**必须照旧活着（重载空档就靠这一档容忍）…");
  window.dispose();
  window = undefined;
  await delay(Math.max(1_000, (IDLE_SEC - 3) * 1_000));
  const during = readState(directory);
  check("阈值内：会合文件还在", during !== undefined);
  check("阈值内：后台还在服务", baseUrl ? tcpReachableSync(baseUrl, 1_500) : false, baseUrl ?? "");
  check("阈值内：supervisor 进程还活着", alive(supervisorPid), String(supervisorPid));

  say("\n3) 继续等过阈值 → 端口关闭、会合文件消失、supervisor 自己也退场…");
  const started = Date.now();
  const deadline = started + 60_000;
  let goneAt: number | undefined;
  while (Date.now() < deadline) {
    const state = readState(directory);
    const serving = baseUrl ? tcpReachableSync(baseUrl, 1_000) : false;
    if (state === undefined && !serving && !alive(supervisorPid)) {
      goneAt = Date.now() - started;
      break;
    }
    await delay(500);
  }
  const elapsedText = goneAt !== undefined ? `阈值后 ${(goneAt / 1000).toFixed(1)}s` : "等了 60s 还没退场";
  check("退场完成（端口、会合文件、supervisor 三者都清干净）", goneAt !== undefined, elapsedText);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  // 窗口在探针里已经关掉了（R3 要的就是"没人用"）；收尾只按会合目录兜一道
  await stopAllProbeProcesses({ windows: [], directory });
  say(failures === 0 ? "\n✓ 没人用就自己退场" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
