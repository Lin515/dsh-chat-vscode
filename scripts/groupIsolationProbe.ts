/**
 * 端到端探针：**配置分组隔离**（用户口径 2026-09-14）。
 *
 * VS Code 的设置是有作用域的（默认 / 工作区 / 工作区文件夹），所以同一台机器上
 * **不同窗口的有效服务器配置可能不同**。口径：
 * - 有效配置相同的窗口（含"来源不同但生效值相同"）→ 共用**同一个**后台；
 * - 有效配置不同的窗口 → 各管各的，**绝不互相接入**。
 *
 * 例：A、B 两个工作区各自写了"用内部 dsh"，全局用户设置是"用外部 URL"，
 * 那就只有 A/B 共用一个内部后台，其余窗口走外部。
 *
 * 这里用"启动命令不同"来制造两个分组（等价于两份不同的有效配置）：
 *   1) 窗口 A 用命令一 → 起后台一；
 *   2) 窗口 B 用命令二 → 必须**自己起一个**（不能接入 A 的），且两者都在服务；
 *   3) 关掉 A → 只带走后台一，后台二不受影响；
 *   4) 关掉 B → 后台二也带走。
 *
 * 输出走文件、子进程 stdio 全程 ignore（探针会起真实 dsh，不能拖住调用方管道）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：租约目录指到本次探针专用的临时目录
import { PROBE_LEASE_DIR } from "./sharedServerProbeEnv";
import { leaseDirectory, readLeases } from "../src/dsh/processRegistry";

const LOG = process.argv[2] ?? ".tmp/group.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Handshake {
  baseUrl: string;
  ownership?: string;
  windowPid?: number;
  ready?: boolean;
}

const scriptDir = process.cwd();
const handshakeFile = join(tmpdir(), `dsh-chat-group-${process.pid}.json`);

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

/** 起一个窗口进程，指定它那份"有效配置"里的启动命令。 */
async function startWindow(tag: string, logFile: string, command?: string): Promise<{ child: ChildProcess; info: Handshake }> {
  rmSync(handshakeFile, { force: true });
  const args = [join(scriptDir, "build", "group-window.mjs"), handshakeFile, logFile];
  if (command) args.push("--command", command);
  const child = spawn(process.execPath, args, {
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

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

let a: ChildProcess | undefined;
let b: ChildProcess | undefined;
let urlA: string | undefined;
let urlB: string | undefined;

try {
  say(`租约根目录（隔离）：${leaseDirectory()}`);

  say("\n1) 窗口 A（配置一：默认命令）起后台…");
  const wa = await startWindow("A", join(PROBE_LEASE_DIR, "a.log"));
  a = wa.child;
  urlA = wa.info.baseUrl;
  check("A 就绪", Boolean(urlA), urlA);

  say("\n2) 窗口 B（配置二：换了个端口/profile 的命令）→ 必须自起一个，不能接入 A 的…");
  const commandB = "dsh web --port 0 --no-open --trusted-host 127.0.0.1";
  const wb = await startWindow("B", join(PROBE_LEASE_DIR, "b.log"), commandB);
  b = wb.child;
  urlB = wb.info.baseUrl;
  check("B 拿到的是**另一个**后台（配置不同不共享）", urlB !== urlA, `A=${urlA} B=${urlB}`);
  // 两组的租约应当**各在自己的子目录**里（组名由有效配置算出来，与扩展的算法同构）
  const groupOf = (command: string) =>
    createHash("sha256").update(`internal:${command}`).digest("hex").slice(0, 12);
  const leasesIn = (group: string): number =>
    existsSync(join(PROBE_LEASE_DIR, group))
      ? readdirSync(join(PROBE_LEASE_DIR, group)).filter((name) => name.startsWith("server-")).length
      : 0;
  const groupA = groupOf("dsh web --port 0 --no-open");
  const groupB = groupOf(commandB);
  check(
    "两个后台各在自己的分组目录里（互不可见）",
    groupA !== groupB && leasesIn(groupA) === 1 && leasesIn(groupB) === 1,
    `A组(${groupA})=${leasesIn(groupA)} B组(${groupB})=${leasesIn(groupB)}`,
  );

  say("\n3) 关掉 A → 只应带走后台一，后台二不受影响…");
  killTree(wa.info.windowPid);
  a = undefined;
  await delay(3_000);
  check("后台一已停止", (await waitGone(urlA, 30_000)) !== undefined);
  check("后台二仍在服务（不同配置互不影响）", await serving(urlB));

  say("\n4) 关掉 B → 后台二也带走…");
  b.stdin?.end();
  await Promise.race([
    new Promise((resolve) => b?.on("close", resolve)),
    delay(45_000).then(() => say("   （等子进程退出超时，继续）")),
  ]);
  b = undefined;
  check("后台二已停止", (await waitGone(urlB, 60_000)) !== undefined);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  killTree(a?.pid);
  killTree(b?.pid);
  a = undefined;
  b = undefined;
  await delay(500);
  for (const url of [urlA, urlB]) {
    if (url && (await serving(url))) {
      for (const { lease } of readLeases()) killTree(lease.serverPid);
      await waitGone(url, 30_000);
    }
  }
  say(failures === 0 ? "\n✓ 不同配置的窗口互不共享后台" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
