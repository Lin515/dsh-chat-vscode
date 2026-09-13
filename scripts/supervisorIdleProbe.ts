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
 * 用 `--idle-sec 5`（配置下限）跑，让探针在十几秒内出结论；默认值的正确性由
 * `supervisorProtocol.test.ts` 的阈值断言与手动验收覆盖。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：会合目录指到本次探针专用目录
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { readState, supervisorDirectory } from "../src/dsh/supervisorProtocol";
import { isProcessAlive, tcpReachableSync } from "../src/dsh/processRegistry";

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
const GROUP = require("node:crypto").createHash("sha256").update(`internal:${COMMAND}`).digest("hex").slice(0, 12);
const DIRECTORY = supervisorDirectory(GROUP);
const HANDSHAKE = join(tmpdir(), `dsh-chat-idle-${process.pid}.json`);

/** 隔离自检（见 `supervisorReloadProbe` 的说明：esbuild 会摇掉"没用到导出"的副作用模块）。 */
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}

interface PingerInfo {
  ready?: boolean;
  baseUrl?: string;
  supervisorPid?: number;
  serverPid?: number;
  windowPid?: number;
  launched?: boolean;
}

/** 起一个窗口（不带 `--idle-sec`：默认值由协议定，探针不改它——见文件头）。 */
async function startPinger(tag: string): Promise<{ child: ChildProcess; info: PingerInfo }> {
  rmSync(HANDSHAKE, { force: true });
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "build", "pinger.mjs"), HANDSHAKE, join(PROBE_SUPERVISOR_ROOT, `pinger-${tag}.log`), "--command", COMMAND],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env: { ...process.env, DSH_CHAT_IDLE_SEC: String(IDLE_SEC) } },
  );
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const parsed = JSON.parse(readFileSync(HANDSHAKE, "utf8")) as PingerInfo;
      if (parsed.ready) return { child, info: parsed };
    } catch {
      // 还没写出来
    }
    await delay(300);
  }
  throw new Error(`窗口 ${tag} 未能在超时内就绪（exitCode=${child.exitCode}）`);
}

let window: ChildProcess | undefined;
let baseUrl: string | undefined;
let supervisorPid: number | undefined;

try {
  say(`会合根目录（隔离）：${PROBE_SUPERVISOR_ROOT}`);
  say(`会合目录：${DIRECTORY}（阈值 ${IDLE_SEC}s）`);

  say("\n1) 起窗口 → 后台就绪…");
  const pinger = await startPinger("idle");
  window = pinger.child;
  baseUrl = pinger.info.baseUrl;
  supervisorPid = pinger.info.supervisorPid;
  const configuredIdle = readState(DIRECTORY)?.idleSec;
  check(
    "前台按探针要求起了阈值（会合文件里记的就是它，supervisor 热读同一份）",
    configuredIdle === IDLE_SEC,
    `会合文件 idleSec=${configuredIdle ?? "?"}`,
  );
  check("就绪", Boolean(baseUrl), `${baseUrl}（supervisor=${supervisorPid} server=${pinger.info.serverPid}）`);

  say("\n2) 关窗 → **阈值之内**必须照旧活着（重载空档就靠这一档容忍）…");
  window = undefined;
  pinger.child.stdin?.end();
  await delay(Math.max(1_000, (IDLE_SEC - 3) * 1_000));
  const during = readState(DIRECTORY);
  check("阈值内：会合文件还在", during !== undefined);
  check("阈值内：后台还在服务", baseUrl ? tcpReachableSync(baseUrl, 1_500) : false, baseUrl ?? "");
  check("阈值内：supervisor 进程还活着", supervisorPid !== undefined && isProcessAlive(supervisorPid), String(supervisorPid));

  say("\n3) 继续等过阈值 → 端口关闭、会合文件消失、supervisor 自己也退场…");
  const started = Date.now();
  const deadline = started + 60_000;
  let goneAt: number | undefined;
  while (Date.now() < deadline) {
    const state = readState(DIRECTORY);
    const serving = baseUrl ? tcpReachableSync(baseUrl, 1_000) : false;
    const supervisorAlive = supervisorPid !== undefined && isProcessAlive(supervisorPid);
    if (state === undefined && !serving && !supervisorAlive) {
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
  if (window?.pid !== undefined) spawn("taskkill", ["/pid", String(window.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  const state = readState(DIRECTORY);
  if (state) {
    spawn("taskkill", ["/pid", String(state.supervisorPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (state.serverPid) spawn("taskkill", ["/pid", String(state.serverPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else if (supervisorPid !== undefined) {
    spawn("taskkill", ["/pid", String(supervisorPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  say(failures === 0 ? "\n✓ 没人用就自己退场" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
