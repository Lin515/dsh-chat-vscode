/**
 * 端到端探针：**VS Code 非正常关闭后，遗留的 dsh 后台能不能被直接复用**。
 *
 * 用户口径（2026-09-14）：dsh 后台与 VS Code 本来就没有强绑定关系。上次 VS Code 崩了、
 * dsh 还在跑，这次启动就**应当直接复用它**（它手里还攥着会话与内存状态），
 * 等到这次正常关闭时再结束它——而不是"先杀旧的重起一个"。
 *
 * 三进程结构（必须如此，见 `crashWindow.ts` 的说明）：
 *   编排者（本文件）
 *     ├─ 窗口 A：起后台 → 写握手文件 → **被强杀**（模拟 VS Code 崩溃，不跑清理代码）
 *     └─ 窗口 B：崩溃之后激活 → 必须复用同一个后台 → 正常关闭时把它带走
 *
 * 全部用真实进程与真实 dsh；输出写文件、子进程 stdio 全程 ignore
 * （探针会起真实 dsh，绝不能拖住调用方管道）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：把租约目录指到本次探针专用的临时目录（见 sharedServerProbeEnv）
import { PROBE_LEASE_DIR } from "./sharedServerProbeEnv";
import { leaseDirectory, readLeases } from "../src/dsh/processRegistry";

const LOG = process.argv[2] ?? ".tmp/crash-reuse.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Handshake {
  baseUrl: string;
  serverPid?: number;
  ownership?: string;
  windowPid?: number;
  ready?: boolean;
}

const scriptDir = process.cwd();
const handshakeFile = join(PROBE_LEASE_DIR, "handshake.json");

async function serving(url: string): Promise<boolean> {
  try {
    await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_200) });
    return true;
  } catch {
    return false;
  }
}

async function waitGone(url: string, timeoutMs: number): Promise<string | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await serving(url))) return `端口已关闭（${Date.now() - started}ms）`;
    await delay(400);
  }
  return undefined;
}

/** 现在有几个后台真的在监听（按租约里的端口逐个探）。 */
async function listeningCount(): Promise<number> {
  let count = 0;
  for (const { lease } of readLeases()) {
    if (!lease.baseUrl) continue;
    if (await serving(lease.baseUrl)) count++;
  }
  return count;
}

/** 起一个窗口进程并等它的握手文件。 */
async function startWindow(tag: string, logFile: string): Promise<{ child: ChildProcess; info: Handshake }> {
  rmSync(handshakeFile, { force: true });
  const child = spawn(process.execPath, [join(scriptDir, "build", "crash-window.mjs"), handshakeFile, logFile], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    env: { ...process.env, DSH_CHAT_LEASE_DIR: PROBE_LEASE_DIR },
  });
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const parsed = JSON.parse(readFileSync(handshakeFile, "utf8")) as Handshake;
      if (parsed.ready) return { child, info: parsed };
    } catch {
      // 还没写出来
    }
    await delay(300);
  }
  throw new Error(`窗口 ${tag} 未能在超时内就绪（exitCode=${child.exitCode}）`);
}

/**
 * 强杀**一个**进程（模拟崩溃：对方来不及跑任何清理代码）。
 *
 * **刻意不加 `/T`**：要模拟的是"VS Code 这个进程没了"，而不是"连它拉起的 dsh 一起没了"
 * ——后者正是崩溃后**遗留后台**的来源，也正是本探针要复用的东西。
 * （实测踩过：加了 `/T` 会把探针自己拉起的整棵链一起带走，连编排者都陪葬。）
 */
function killProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
}

/** 连带子孙一起杀（只用于收尾清理，正常路径用不到）。 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/** 收尾：把还听着的端口对应的进程杀掉（安全网，避免留下孤儿与占用的端口）。 */
async function killLeftovers(baseUrl: string | undefined): Promise<void> {
  if (!baseUrl || !(await serving(baseUrl))) return;
  const port = new URL(baseUrl).port;
  for (const { lease } of readLeases()) {
    killTree(lease.serverPid);
  }
  const net = spawn("netstat", ["-ano", "-p", "TCP"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  net.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  await new Promise((resolve) => net.on("close", resolve));
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(`:${port} `) || !/LISTENING/i.test(line)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid)) killTree(Number(pid));
  }
  await waitGone(baseUrl, 30_000);
}

let windowA: ChildProcess | undefined;
let windowB: ChildProcess | undefined;
let crashedUrl: string | undefined;

try {
  say(`租约目录（隔离）：${leaseDirectory()}`);

  say("\n1) 窗口 A 起后台…");
  const a = await startWindow("A", join(PROBE_LEASE_DIR, "window-a.log"));
  windowA = a.child;
  crashedUrl = a.info.baseUrl;
  check("A 就绪", Boolean(crashedUrl), `${crashedUrl}（serverPid=${a.info.serverPid}）`);

  say("\n2) 强杀窗口 A（模拟 VS Code 崩溃：不跑任何清理代码）…");
  killProcess(a.info.windowPid);
  await delay(2_500);
  check("崩溃后后台仍在服务（它本来就不依赖 VS Code）", await serving(crashedUrl));
  check("崩溃后租约还在（心跳已陈旧，但租约是证据）", readLeases().length === 1);

  say("\n2b) 诊断：决策过程各步之后，遗留租约是否仍可接管…");
  {
    const diag = spawn(
      process.execPath,
      [join(scriptDir, "build", "crash-window.mjs"), join(PROBE_LEASE_DIR, "diag.json"), join(PROBE_LEASE_DIR, "diag.log"), "--diagnose"],
      { stdio: "ignore", windowsHide: true, env: { ...process.env, DSH_CHAT_LEASE_DIR: PROBE_LEASE_DIR } },
    );
    await new Promise((resolve) => diag.on("close", resolve));
    try {
      for (const line of readFileSync(join(PROBE_LEASE_DIR, "diag.log"), "utf8").split(/\r?\n/)) {
        if (line.trim()) say(`   ${line.trim()}`);
      }
    } catch {
      say("   （诊断日志没写出来）");
    }
  }

  say("\n3) 新窗口 B 激活 → 应当**直接复用**这个遗留后台…");
  const b = await startWindow("B", join(PROBE_LEASE_DIR, "window-b.log"));
  windowB = b.child;
  check("B 接上的就是崩溃前那个后台（同一地址）", b.info.baseUrl === crashedUrl, `${crashedUrl} vs ${b.info.baseUrl}`);
  // 数"**在服务**的后台"而不是"租约文件数"：崩溃会留下陈旧租约（服务器 exit 处理器删不掉
  // 已是死 pid 的那份），那是需要收拾的垃圾，不等于"起了第二个后台"。
  const listening = await listeningCount();
  check("整场只有一个后台在服务（没有重起）", listening === 1, `监听中的后台数=${listening}`);
  check("陈旧租约已被收拾（只剩一条）", readLeases().length === 1, `租约数=${readLeases().length}`);

  say("\n4) 窗口 B 正常关闭 → 这时才带走后台…");
  b.child.stdin?.end();
  await Promise.race([
    new Promise((resolve) => b.child.on("close", resolve)),
    delay(45_000).then(() => say("   （等子进程退出超时，继续）")),
  ]);
  windowB = undefined;
  const gone = await waitGone(crashedUrl, 60_000);
  check("B 关闭后后台不再服务", gone !== undefined, gone ?? "等了 60s 仍在服务");
  check("租约被清掉", readLeases().length === 0, `剩余租约=${JSON.stringify(readLeases().map((item) => item.lease.serverPid))}`);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  killTree(windowA?.pid);
  killTree(windowB?.pid);
  windowA = undefined;
  windowB = undefined;
  await delay(500);
  await killLeftovers(crashedUrl);
  say(failures === 0 ? "\n✓ 崩溃遗留的后台会被直接复用" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
