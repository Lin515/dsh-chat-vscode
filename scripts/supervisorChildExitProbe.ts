/**
 * 探针：**守护进程判不判得出 dsh 死了，判得出又会不会自己重启**。
 *
 * 起因（用户 2026-09-15 提问）："守护进程如果发现跑 dsh 服务的 node.exe 卡死或者已经
 * 卡退消失了，能自动重启它吗？"
 *
 * 判据在 `src/supervisor/main.ts` 的主循环里：`!serverStarting && childGone() && clients.size > 0`。
 * `server.child` 是 `spawn(..., { shell: true })` 返回的 **cmd.exe 外壳**，
 * 真 dsh 是外壳的子进程（本机实测链路：
 *   `Code.exe`(supervisor) → `cmd.exe /d /s /c "dsh web …"` → `node.exe bin.js web …`）。
 * 所以能验的就三件事：
 *   A. 真 node 被杀（外壳随之退出）→ 判据看得见 → 重启；
 *   B. 真 node 被强杀（taskkill /F，外壳**在不在**）→ 同上；
 *   C. 真 node 卡死（进程在、端口不再响应）→ 判据**没有探活**，重启不了。
 *
 * **窗口 = 扩展真正用的 `SupervisorManager`**（从前的 pinger 手抄了扩展侧流程，
 * 于是这条探针验的是副本；现在客户端这一侧就是扩展那一份代码）。
 * 起守护进程仍走真产物 `dist/supervisor.js`（扩展拉起的也正是它）。
 *
 * 计数用假 dsh 自己往 `DSH_FAKE_BOOT_LOG` 追加的 `boot pid=…`：
 * 数日志里的 `--- dsh attempt` marker 是不够的——marker 是**每次 bringUp 尝试**都写，
 * 里面那次 dsh 可能起来就退（第一版探针正是栽在这里，得出过假结论）。
 *
 * 用法：node build/supervisor-child-exit-probe.mjs [日志文件]
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// 必须排在最前面：会合目录指到本次探针专用目录（模块求值期读一次）
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readState } from "../src/dsh/supervisorProtocol";
import { isProcessAlive } from "../src/dsh/processRegistry";
import { killTree, listeningPids } from "../src/supervisor/main";
import { ProbeWindow, alive, killProcess, stopAllProbeProcesses, waitUntil } from "./supervisorPingerHarness";

const LOG = process.argv[2] ?? ".tmp/supervisor-child-exit.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string): void => {
  appendFileSync(LOG, `${line}\n`, "utf8");
};

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const isolated = PROBE_SUPERVISOR_ROOT;
if (!isolated || !/dsh-chat-sup-probe-/.test(isolated)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${isolated}（探针只在专用临时目录里跑）\n`);
  process.exit(2);
}

const REPO = "D:/dev/dsh-chat";
const fakeDir = mkdtempSync(join(tmpdir(), "dsh-chat-fakedsh-"));
const fakeScript = join(fakeDir, "fakeDsh.cjs");
const bootLog = join(fakeDir, "boots.log");
/**
 * 假 dsh 的记账文件**靠环境变量传给它**，而它要经过三跳才到：
 * 探针进程 → （启动器 `spawnDetached` 用 `runtimeEnv(process.env)`）→ 守护进程 →
 * （`spawn(command, {shell:true})` 继承自身环境）→ 假 dsh。
 *
 * **必须在 `ProbeWindow` 构造之前设**（构造时就 `resolveNodeRuntime()` 把 env 取走了）。
 * 2026-09-19 探针改写时漏了这一行：假 dsh 照样跑、照样公告地址，但一行记账都不写，
 * 于是 `真 node pid=undefined`、A/B/C 三档全崩——而"✓ 真 node 已消失"还空过了。
 */
process.env.DSH_FAKE_BOOT_LOG = bootLog;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 探针驱动的是**真产物** `dist/supervisor.js`：它可能比 src 旧（`npm run build:scripts`
// 不会重建它），拿旧产物跑出来的结论会是假绿的——这里先做一道硬前置。
if (!existsSync(`${REPO}/dist/supervisor.js`)) {
  process.stderr.write(`[probe] 缺 ${REPO}/dist/supervisor.js：先跑 \`npm run build\`（build:scripts 不会重建它）\n`);
  process.exit(2);
}

/** 探针自己起的一个空闲端口（真正监听它的"服务器"在子进程里）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 假 dsh 的启动记录（由它自己写进 `DSH_FAKE_BOOT_LOG`，supervisor 原样透传环境变量）。
 *
 * `pid` 是"真正在跑的那个 node"，`shell` 是它的父进程（cmd.exe）——正是
 * `spawn(..., {shell:true})` 返回给 supervisor 的那个句柄。
 */
function bootRecords(): { pid: number; shell: number; port: number }[] {
  try {
    return readFileSync(bootLog, "utf8")
      .split(/\r?\n/)
      .map((line) => /boot pid=(\d+) shell=(\d+) port=(\d+)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ pid: Number(match[1]), shell: Number(match[2]), port: Number(match[3]) }));
  } catch {
    return [];
  }
}

/** 起一个新的探针场景（自己的会合目录、自己的守护进程 + 假 dsh，窗口走真管理器）。 */
async function startScenario(name: string, hangAfterMs: number) {
  const port = await freePort();
  const command = `node "${fakeScript}" ${port} probe-token${hangAfterMs > 0 ? ` --hang-after ${hangAfterMs}` : ""}`;
  const window = new ProbeWindow({ tag: `child-exit-${name}`, command, idleSec: 60 }, say);
  // **先登记再启动**：`ensure()` 可能中途抛错，那时这个窗口（以及它拉起的守护进程）只能靠
  // 收尾清单带走——漏登记就等于给机器留下一个后台。
  scenarios.push(window);
  const bootIndex = bootRecords().length;
  const info = await window.ensure({ start: true });
  const state = readState(window.directory);
  const boot = bootRecords()[bootIndex];
  return {
    name,
    port,
    window,
    directory: window.directory,
    socket: state?.socket,
    supervisorPid: state?.supervisorPid ?? 0,
    ready: info.baseUrl !== undefined && state?.starting !== true,
    state,
    boot,
    bootIndex,
    /** 真正在跑的 node（真 dsh 的那个进程） */
    nodePid: boot?.pid,
    /** spawn 句柄（= 外壳 cmd.exe） */
    shellPid: state?.serverPid,
  };
}

const cleanup: { directory: string; port: number; supervisorPid: number; window: ProbeWindow }[] = [];
/** 本探针起过的**全部**窗口（收尾时交给 `stopAllProbeProcesses`，中途抛错也不漏）。 */
const scenarios: ProbeWindow[] = [];
/** 这个场景的 dsh 被重新拉起了几次（0 = 首次之后没有任何重启）。 */
const restarts = (scenario: { bootIndex: number }): number => Math.max(0, bootRecords().length - scenario.bootIndex - 1);

try {
  say(`会合根目录（隔离）：${isolated}`);
  writeFileSync(fakeScript, readFileSync(`${REPO}/shared/fakeDsh.cjs`), "utf8");

  // ================= 场景 A：只杀真 node（温和），外壳留着 =================
  say("\n【A】杀掉真 dsh 的 node（`process.kill`），看守护进程认不认、重启不重启…");
  const a = await startScenario("a", 0);
  cleanup.push({ directory: a.directory, port: a.port, supervisorPid: a.supervisorPid, window: a.window });
  check("守护进程拉起了 dsh 并写出会合文件", a.ready, `baseUrl=${a.state?.baseUrl ?? "（无）"}`);
  const aNode = a.nodePid;
  const aShell = a.shellPid;
  say(`   会合文件 serverPid=${aShell}（spawn 句柄）；真 node pid=${aNode}`);
  check("spawn 句柄记的是 cmd.exe 外壳、真 dsh 是它的子进程", aShell !== aNode, `shell=${aShell} node=${aNode}`);

  // 窗口（= 真管理器）已经连着 socket = "有窗口在用"：主循环只在 clients.size > 0 时才重启 dsh
  check("窗口连着守护进程的 socket（否则它不会重启 dsh）", a.window.manager.getStatus().state === "ready", a.window.manager.getStatus().state);

  if (aNode !== undefined) process.kill(aNode);
  check("真 node 已消失", await waitUntil("node 消失", () => !isProcessAlive(aNode), 5_000));
  await sleep(1_000);
  say(`   外壳 cmd.exe(pid=${aShell})：${isProcessAlive(aShell) ? "还活着" : "已随之退出"}（这就是守护进程能看到的唯一信号）`);
  const restartedA = await waitUntil("守护进程重新拉起 dsh", () => restarts(a) >= 1 && readState(a.directory)?.baseUrl !== undefined, 30_000);
  const aState = readState(a.directory);
  const aLast = bootRecords()[bootRecords().length - 1];
  check(
    "守护进程自动重启了 dsh（A：温和杀 node）",
    restartedA && aState?.baseUrl !== undefined,
    restartedA
      ? `新 node pid=${aLast?.pid}（外壳 ${aLast?.shell}），新地址=${aState?.baseUrl}`
      : `没有重启：boots=${bootRecords().length}，会合文件 serverPid=${aState?.serverPid ?? "?"}`,
  );
  a.window.dispose();

  // ================= 场景 B：强杀真 node（taskkill /F） =================
  say("\n【B】强杀真 node（`taskkill /F`，即任务管理器「结束任务」的等价物）…");
  const b = await startScenario("b", 0);
  cleanup.push({ directory: b.directory, port: b.port, supervisorPid: b.supervisorPid, window: b.window });
  const bNode = b.nodePid;
  const bShell = b.shellPid;
  say(`   会合文件 serverPid=${bShell}；真 node pid=${bNode}`);
  if (bNode !== undefined) {
    spawn("taskkill", ["/pid", String(bNode), "/F"], { windowsHide: true, stdio: "ignore" });
  }
  check("真 node 已消失", await waitUntil("node 消失", () => !isProcessAlive(bNode), 5_000));
  await sleep(2_000);
  const bShellAlive = isProcessAlive(bShell);
  say(`   2 秒后外壳 cmd.exe(pid=${bShell}) 还活着吗：${bShellAlive ? "活着" : "已随之退出"}`);
  const restartedB = await waitUntil("守护进程重新拉起 dsh", () => restarts(b) >= 1 && readState(b.directory)?.baseUrl !== undefined, 30_000);
  const bState = readState(b.directory);
  const bLast = bootRecords()[bootRecords().length - 1];
  check(
    "守护进程自动重启了 dsh（B：强杀 node）",
    restartedB && bState?.baseUrl !== undefined,
    restartedB
      ? `新 node pid=${bLast?.pid}（外壳 ${bLast?.shell}），新地址=${bState?.baseUrl}`
      : `没有重启：boots=${bootRecords().length}，会合文件 serverPid=${bState?.serverPid ?? "?"}`,
  );
  b.window.dispose();

  // ================= 场景 C：卡死（进程在、端口不再响应） =================
  say("\n【C】让 dsh「卡死」：进程还在、端口不再响应（不杀任何进程）…");
  const c = await startScenario("c", 3_000);
  cleanup.push({ directory: c.directory, port: c.port, supervisorPid: c.supervisorPid, window: c.window });
  const cNode = c.nodePid;
  await sleep(5_000); // 等它进入卡死形态
  const answers = await fetch(`http://127.0.0.1:${c.port}/`, { signal: AbortSignal.timeout(1_500) })
    .then(() => true)
    .catch(() => false);
  check(
    "dsh 已进入「卡死」形态：进程还在但端口不应答",
    isProcessAlive(cNode) && !answers,
    `node 存活=${isProcessAlive(cNode)} 端口应答=${answers}`,
  );
  const restartedC = await waitUntil("守护进程重新拉起 dsh", () => restarts(c) >= 1, 8_000);
  check(
    "守护进程**不会**因为「不应答」而重启 dsh（现状：它只看子进程句柄，没有探活）",
    !restartedC,
    `重启次数=${restarts(c)}`,
  );
  c.window.dispose();

  // ================= 收尾 =================
  say("\n【收尾】带走本探针起的一切…");
  // 交给共用收尾（原来是这里手抄一遍"请守护进程收场 + 按端口兜底"，与别的探针各写一份）
  await stopAllProbeProcesses({
    windows: scenarios,
    extraPids: bootRecords().map((boot) => boot.pid),
  });
  for (const item of cleanup) {
    // 假 dsh 那个端口是探针自己选的（不一定是 dsh 宣布的那个），按端口再兜一道
    for (const pid of listeningPids(item.port)) {
      if (pid !== process.pid) killTree(pid);
    }
  }
  await sleep(800);
  say(`   残留的假 dsh 进程：${bootRecords().filter((boot) => alive(boot.pid)).map((boot) => boot.pid).join(",") || "（无）"}`);
  say(`\n结论：${failures === 0 ? "全部符合预期（见上）" : `${failures} 条不符合预期`}`);
  // 假 dsh 自己的启动/退出记录：**必须留到日志里**（它是"到底谁把 dsh 弄死的"
  // 唯一直接证据；只留在临时目录里会被 finally 删掉）
  say(`\n假 dsh 自述（boot/exit/log）：\n${(() => {
    try {
      return readFileSync(bootLog, "utf8").trim() || "（无）";
    } catch {
      return "（读不到）";
    }
  })()}`);
} catch (error) {
  say(`[probe] 异常：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  failures++;
  // 中途抛错时也要把起过的东西带走（**绝不能留给用户机器**）
  await stopAllProbeProcesses({ windows: scenarios, extraPids: bootRecords().map((boot) => boot.pid) }).catch(() => undefined);
} finally {
  try {
    rmSync(fakeDir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
  process.exit(failures === 0 ? 0 : 1);
}
