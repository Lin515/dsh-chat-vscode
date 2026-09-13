/**
 * 端到端探针 **R1：重载窗口不打断后台**（设计 §6.2）——本次架构改动的核心断言。
 *
 * 现场：`dsh` 的生死挂在扩展宿主上，而 VS Code 打开文件夹/装扩展/改配置都会重载窗口；
 * 旧实例退出时看到"没有别的活心跳"就把 dsh 杀了，而接替它的新实例还没出生、投不了票。
 * 于是**每次重载都要冷启**（实测 5~8 秒），这正是用户报的"打开文件夹后后台没了"。
 *
 * 新形态的判据很直接：**dsh 的 pid 与端口必须一个字都不变**。
 *
 * 结构（pinger 扮演窗口，见 `scripts/pinger.ts`；不必启动 VS Code）：
 *   1) 窗口 A 起来 → 后台就绪，记下 baseUrl/serverPid；
 *   2) **强杀 A**（模拟窗口被关/扩展宿主被杀，来不及跑任何清理代码）；
 *   3) 隔几秒起窗口 B → 必须**接着用同一个后台**（同一 baseUrl + 同一 serverPid）；
 *   4) 关窗 B → 收尾（等 supervisor 自己空闲退场）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：会合目录指到本次探针专用目录
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { generationOf, readState, supervisorDirectory } from "../src/dsh/supervisorProtocol";

const LOG = process.argv[2] ?? ".tmp/supervisor-reload.log";
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
const HANDSHAKE = join(tmpdir(), `dsh-chat-reload-${process.pid}.json`);

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

interface PingerInfo {
  ready?: boolean;
  baseUrl?: string;
  supervisorPid?: number;
  serverPid?: number;
  generation?: string;
  windowPid?: number;
  launched?: boolean;
}

async function startPinger(tag: string, extra: string[] = []): Promise<{ child: ChildProcess; info: PingerInfo }> {
  rmSync(HANDSHAKE, { force: true });
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "build", "pinger.mjs"), HANDSHAKE, join(PROBE_SUPERVISOR_ROOT, `pinger-${tag}.log`), "--command", COMMAND, ...extra],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env: { ...process.env } },
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

/** 强杀一个 pinger（**不加 /T**：要的就是"窗口没了、后台还在"）。 */
function killPinger(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
}

let windowA: ChildProcess | undefined;
let windowB: ChildProcess | undefined;
let serverPid: number | undefined;

try {
  say(`会合根目录（隔离）：${PROBE_SUPERVISOR_ROOT}`);
  say(`会合目录：${DIRECTORY}`);

  say("\n1) 窗口 A 起来 → 后台就绪…");
  const a = await startPinger("a");
  windowA = a.child;
  serverPid = a.info.serverPid;
  check("A 就绪", Boolean(a.info.baseUrl), `${a.info.baseUrl}（server=${serverPid} supervisor=${a.info.supervisorPid}）`);
  check("A 是启动者（这一轮由它把 supervisor 拉起来）", a.info.launched === true);

  say("\n2) **强杀窗口 A**（模拟窗口关闭/扩展宿主被杀，不跑任何清理代码）…");
  killPinger(a.info.windowPid);
  windowA = undefined;
  await delay(3_000);
  const afterKill = readState(DIRECTORY);
  check(
    "窗口没了，后台还在（这正是重载期间必须发生的事）",
    Boolean(afterKill?.baseUrl) && afterKill?.serverPid === serverPid,
    `会合文件：url=${afterKill?.baseUrl ?? "无"} server=${afterKill?.serverPid ?? "?"}`,
  );

  say("\n3) 隔 3 秒起窗口 B → **必须接着用同一个后台，不许重启**…");
  const b = await startPinger("b");
  windowB = b.child;
  check("B 接上的还是那个地址", b.info.baseUrl === a.info.baseUrl, `${a.info.baseUrl} vs ${b.info.baseUrl}`);
  check(
    "dsh 的 pid 一个字都没变（核心断言：重载没有打断后台）",
    b.info.serverPid === serverPid && serverPid !== undefined,
    `A=${serverPid} B=${b.info.serverPid}`,
  );
  check(
    "还是同一套 supervisor（世代未变）",
    b.info.generation === a.info.generation,
    `A=${a.info.generation} B=${b.info.generation}`,
  );
  check("B 不是启动者（它是接上去的）", b.info.launched === false);

  say("\n4) 关窗 B → 等 supervisor 空闲退场…");
  windowB = undefined;
  b.child.stdin?.end();
  const deadline = Date.now() + 60_000;
  let stateGone = false;
  while (Date.now() < deadline) {
    if (readState(DIRECTORY) === undefined) {
      stateGone = true;
      break;
    }
    await delay(500);
  }
  check("最后一个窗口退出后，会合文件被清掉（supervisor 自己收场）", stateGone, stateGone ? "已清" : "等了 60s 还在");
  // 顺带确认端口真的关了（进程没了才有意义）
  const port = a.info.baseUrl ? new URL(a.info.baseUrl).port : undefined;
  let stillListening = false;
  if (port) {
    const net = spawn("netstat", ["-ano", "-p", "TCP"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    net.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((resolve) => net.on("close", resolve));
    stillListening = out.split(/\r?\n/).some((line) => /LISTENING/i.test(line) && line.includes(`:${port} `));
  }
  check("dsh 端口已关闭（没有留下孤儿）", !stillListening, `端口 ${port ?? "?"}`);
  // 生成一次"世代"字符串，便于失败时对照
  if (afterKill) say(`   （诊断）关窗后的世代=${generationOf(afterKill)}`);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  for (const child of [windowA, windowB]) {
    if (child?.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  // 收尾：让 supervisor 退场（发 stop 不现实，直接按会合文件杀）
  const state = readState(DIRECTORY);
  if (state) {
    spawn("taskkill", ["/pid", String(state.supervisorPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (state.serverPid) spawn("taskkill", ["/pid", String(state.serverPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  say(failures === 0 ? "\n✓ 重载窗口不会打断后台" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
