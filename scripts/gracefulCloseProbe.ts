/**
 * 端到端探针：**正常关窗（deactivate → dispose）必须把后台带走**。
 *
 * 为什么单独测这条：`crashReuseProbe` 验证的是"强杀窗口后遗留后台能被接管"，
 * 而用户实际报的问题是**关闭 VS Code 后后台还在**——那是优雅退出路径。
 * 两者走的代码完全不同（前者不执行任何清理，后者必须 `release()` 杀掉最后一个后台）。
 *
 * 场景：
 *   1) 窗口 A 起后台；
 *   2) **优雅关窗**（stdin EOF → dispose，等价于 deactivate）→ 后台必须停止；
 *   3) 再起窗口 B → 应该起一个**新的**（旧的不该还在，也不该"接管"一个死掉的）；
 *   4) 优雅关窗 B → 后台再次被带走。
 *
 * 每一步都用 netstat/HTTP 取证，不看进程 pid 以外的间接信号。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：租约目录指到本次探针专用的临时目录
import { PROBE_LEASE_DIR } from "./sharedServerProbeEnv";
import { leaseDirectory, readLeases } from "../src/dsh/processRegistry";

const LOG = process.argv[2] ?? ".tmp/graceful.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Handshake {
  baseUrl: string;
  windowPid?: number;
  ready?: boolean;
}

const scriptDir = process.cwd();
const handshakeFile = join(tmpdir(), `dsh-chat-graceful-${process.pid}.json`);

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
    await delay(300);
  }
  return undefined;
}

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

/** 优雅关窗：关掉 stdin → 子进程走 dispose（等价于 VS Code 的 deactivate）。 */
async function closeWindow(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  await Promise.race([
    new Promise((resolve) => child.on("close", resolve)),
    delay(30_000).then(() => say("   （等子进程退出超时，继续）")),
  ]);
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

let current: ChildProcess | undefined;
let currentUrl: string | undefined;

try {
  say(`租约目录（隔离）：${leaseDirectory()}`);

  say("\n1) 窗口 A 起后台…");
  const a = await startWindow("A", join(PROBE_LEASE_DIR, "a.log"));
  current = a.child;
  currentUrl = a.info.baseUrl;
  check("A 就绪", Boolean(currentUrl), currentUrl);

  say("\n2) **优雅关窗** A（等价于 VS Code 的 deactivate）→ 后台必须停止…");
  await closeWindow(a.child);
  current = undefined;
  const goneA = await waitGone(currentUrl, 60_000);
  check("关窗后后台停止", goneA !== undefined, goneA ?? "等了 60s 仍在服务");
  check("租约被清掉", readLeases().length === 0, `剩余=${readLeases().length}`);

  say("\n3) 再起窗口 B → 应当拿到一个**新的**后台…");
  const b = await startWindow("B", join(PROBE_LEASE_DIR, "b.log"));
  current = b.child;
  const urlB = b.info.baseUrl;
  check("B 拿到了新的后台（旧地址已不可用）", urlB !== currentUrl, `旧=${currentUrl} 新=${urlB}`);
  check("B 的后台在服务", await serving(urlB), urlB);

  say("\n4) 优雅关窗 B → 后台再次被带走…");
  await closeWindow(b.child);
  current = undefined;
  const goneB = await waitGone(urlB, 60_000);
  check("关窗后后台停止", goneB !== undefined, goneB ?? "等了 60s 仍在服务");
  check("租约被清掉", readLeases().length === 0, `剩余=${readLeases().length}`);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  killTree(current?.pid);
  current = undefined;
  await delay(500);
  if (currentUrl && (await serving(currentUrl))) {
    for (const { lease } of readLeases()) killTree(lease.serverPid);
    await waitGone(currentUrl, 30_000);
  }
  say(failures === 0 ? "\n✓ 正常关窗会带走后台" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
