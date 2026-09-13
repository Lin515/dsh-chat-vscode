/**
 * 诊断探针：**残留的 dsh 后台为什么没有被新窗口接管**（用户 2026-09-13 报的第二件事）。
 *
 * 用户口径：本扩展起的 dsh 应当**跟随扩展生命周期**（关窗即走，已修）；而"没能正常关闭"
 * （崩溃 / 强杀 / 扩展宿主被带走）留下的那个后台，下一次激活**必须直接接管**——
 * 它手里还攥着会话与内存状态，重起纯属浪费，而且固定端口下重起还会 EADDRINUSE 直接失败。
 *
 * 现状是"又起了一个 node.exe，然后被端口占用卡死"。本探针把"接管决策"的**每一步判据**
 * 逐条打出来（含耗时），这样"为什么没接管"就有确定答案，而不是靠读代码猜。
 *
 * 用法：
 *   node build/orphan-diagnose.mjs                            # 只打印当前机器上的判据（不动任何东西）
 *   node build/orphan-diagnose.mjs --repro                    # 造残留后台 → 走真实启动决策
 *   node build/orphan-diagnose.mjs --repro --delay 31000      # 同上，先等 31 秒（越过心跳新鲜度阈值）
 *   node build/orphan-diagnose.mjs --repro --pid-reused       # 同上，但让"写心跳的那个 pid"
 *                                                             # **被别人占用**（pid 复用的现实情形）
 *   node build/orphan-diagnose.mjs --repro --no-heartbeat      # 同上，但删掉心跳只留租约
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：租约目录指到本次探针专用的临时目录（见 sharedServerProbeEnv）
import { PROBE_LEASE_DIR } from "./sharedServerProbeEnv";
import { ServerManager } from "../src/dsh/serverManager";
import {
  HOST_STALE_MS,
  STARTING_GRACE_MS,
  dropDeadLeases,
  dropStaleHostLeases,
  findAdoptable,
  findAttachable,
  findStarting,
  hasLiveHostFor,
  isOrphanLease,
  isProcessAlive,
  isServiceable,
  leaseDirectory,
  leasePort,
  liveHostIds,
  readHostLeases,
  readLeases,
  tcpReachableSync,
} from "../src/dsh/processRegistry";

const COMMAND = process.env.DSH_CHAT_PROBE_COMMAND || "dsh web --port 0 --no-open";
const LOG = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".tmp/orphan-diagnose.log";
const REPRO = process.argv.includes("--repro");
const PID_REUSED = process.argv.includes("--pid-reused");
/** `--kill-tree`：强杀窗口时**连进程树一起**（模拟"VS Code 被结束进程树"）。 */
const KILL_TREE = process.argv.includes("--kill-tree");
/** `--no-heartbeat`：造完残留后删掉心跳文件，只留租约（心跳丢失的情形）。 */
const NO_HEARTBEAT = process.argv.includes("--no-heartbeat");
const DELAY_MS = Number(process.argv[process.argv.indexOf("--delay") + 1]) || 0;
writeFileSync(LOG, "", "utf8");
const say = (line: string) => {
  appendFileSync(LOG, `${line}\n`, "utf8");
  process.stdout.write(`${line}\n`);
};

/** 现在这一刻，各判据分别怎么说（每条都带耗时：判活要起 PowerShell，慢就是问题本身）。 */
function dumpPredicates(tag: string): void {
  const leases = readLeases();
  const hosts = readHostLeases();
  const now = Date.now();
  const timed = <T>(body: () => T): [T, number] => {
    const started = Date.now();
    const value = body();
    return [value, Date.now() - started];
  };

  const [attachable, msAttach] = timed(() => findAttachable());
  const [starting, msStarting] = timed(() => findStarting(90_000));
  const [adoptable, msAdopt] = timed(() => findAdoptable(COMMAND));
  const [liveIds, msLive] = timed(() => liveHostIds());

  say(`\n[${tag}] 租约数=${leases.length} 心跳数=${hosts.length}（租约目录=${leaseDirectory()}）`);
  for (const { file, lease } of leases) {
    const [alive, msAlive] = timed(() => isProcessAlive(lease.serverPid));
    say(
      `  租约 ${file}：pid=${lease.serverPid} url=${lease.baseUrl ?? "（无）"} token=${lease.token ? "有" : "无"}` +
        ` cmd=${JSON.stringify(lease.command)}` +
        `\n     进程活=${alive}(${msAlive}ms) 可服务=${isServiceable(lease)} 孤儿=${isOrphanLease(lease)}` +
        ` 有活窗口=${hasLiveHostFor(lease.serverPid)} 端口=${leasePort(lease) ?? "?"} 宣布于 ${Math.round((now - lease.startedAt) / 1000)}s 前`,
    );
  }
  for (const entry of hosts) {
    const [alive, msAlive] = timed(() => isProcessAlive(entry.pid));
    say(
      `  心跳 ${entry.hostId.slice(0, 8)}：写它的进程 pid=${entry.pid ?? "?"} 活=${alive}(${msAlive}ms)` +
        ` serverPid=${entry.serverPid ?? "?"} url=${entry.baseUrl ?? "（无）"} token=${entry.token ? "有" : "无"}` +
        ` cmd=${JSON.stringify(entry.command)} 记于 ${Math.round((now - entry.seenAt) / 1000)}s 前` +
        `（阈值 ${HOST_STALE_MS / 1000}s）`,
    );
  }
  say(
    `  判据结论：可接入(findAttachable)=${attachable?.serverPid ?? "无"}(${msAttach}ms)` +
      ` 启动中(findStarting)=${starting?.serverPid ?? "无"}(${msStarting}ms)`,
  );
  say(
    `  判据结论：**可接管(findAdoptable)**=${adoptable ? `pid=${adoptable.serverPid} url=${adoptable.baseUrl}` : "无"}(${msAdopt}ms)` +
      ` 活实例=${JSON.stringify(liveIds.map((id) => id.slice(0, 8)))}(${msLive}ms)`,
  );
  const port = leases[0] ? leasePort(leases[0].lease) : undefined;
  if (port !== undefined) {
    const [ok, msTcp] = timed(() => tcpReachableSync(`http://127.0.0.1:${port}`));
    say(`  端口 ${port} 真的在服务=${ok}(${msTcp}ms)（启动宽限 ${STARTING_GRACE_MS / 1000}s）`);
  }
}

/** 造一个"没能正常关闭"的残留后台：起窗口 → 写握手 → **强杀窗口**（不跑任何清理代码）。 */
async function makeOrphan(): Promise<{ url: string; serverPid?: number; windowPid?: number }> {
  const handshake = join(tmpdir(), `dsh-chat-orphan-${process.pid}.json`);
  rmSync(handshake, { force: true });
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "build", "crash-window.mjs"), handshake, join(PROBE_LEASE_DIR, "orphan-window.log")],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env: { ...process.env, DSH_CHAT_LEASE_DIR: PROBE_LEASE_DIR } },
  );
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const parsed = JSON.parse(readFileSync(handshake, "utf8")) as {
        ready?: boolean;
        baseUrl?: string;
        serverPid?: number;
        windowPid?: number;
      };
      if (parsed.ready) {
        // 强杀窗口：`/T` 会连它拉起的 dsh 一起带走（模拟"VS Code 被结束进程树"），
        // 不带 `/T` 则只杀窗口本身（模拟扩展宿主被杀、dsh 活下来成孤儿）。
        const args = ["/pid", String(parsed.windowPid), "/F"];
        if (KILL_TREE) args.splice(3, 0, "/T");
        spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
        await delay(2_500);
        return { url: parsed.baseUrl ?? "", serverPid: parsed.serverPid, windowPid: parsed.windowPid };
      }
    } catch {
      // 还没写出来
    }
    await delay(300);
  }
  throw new Error("窗口未能就绪，无法造出残留后台");
}

let orphanUrl: string | undefined;
let squatter: ChildProcess | undefined;

/**
 * 让"写心跳的那个 pid"**被别人占用**：Windows 会回收 pid，老扩展宿主死后那串数字
 * 很快可能落到一个无关进程上。此时 `hostEntryStale` 的"按 pid 判活"会认为**老窗口还活着**，
 * 于是 `findAdoptable` 直接跳过这条心跳 —— 这正是"明明残留还在服务，却不去接管"的一种成因。
 *
 * 造法：起一个和扩展宿主毫无关系的进程，把它的 pid 写进那条心跳。
 */
async function squatHeartbeatPid(): Promise<number | undefined> {
  const entries = readHostLeases();
  if (!entries.length) return undefined;
  const commandFile = join(tmpdir(), `dsh-chat-squat-${process.pid}.cmd`);
  writeFileSync(commandFile, "@ping -n 60 127.0.0.1 >nul\r\n", "utf8");
  squatter = spawn("cmd.exe", ["/c", commandFile], { stdio: "ignore", windowsHide: true, detached: true });
  await delay(1_200);
  const pid = squatter.pid;
  if (pid === undefined) return undefined;
  const entry = entries[0] as Record<string, unknown>;
  // 刻意连 `ownerStartedAt` 一起抹掉：那正是"老版本写的心跳"（没有启动时刻可比），
  // 此时判据只能看"pid 活不活"——它说活着，于是首选判据认为"老窗口还在"。
  const { ownerStartedAt: _dropped, ...rest } = entry;
  void _dropped;
  writeFileSync(join(PROBE_LEASE_DIR, "default", "hosts", `${entries[0].hostId}.json`), JSON.stringify({ ...rest, pid, seenAt: Date.now() }), "utf8");
  await delay(200);
  return pid;
}

/** 删掉心跳文件，只留租约——"心跳丢了"的现实情形（写盘失败 / 被清理 / 版本更早）。 */
function dropHeartbeats(): number {
  const dir = join(PROBE_LEASE_DIR, "default", "hosts");
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      rmSync(join(dir, name), { force: true });
      removed++;
    }
  } catch {
    // 目录不在就是没有心跳
  }
  return removed;
}

try {
  say(`租约目录（隔离）：${leaseDirectory()}`);

  if (!REPRO) {
    say("（只读诊断：不动任何进程。加 --repro 可造一个残留后台并走一遍真实接管决策。）");
    dumpPredicates("当前");
  } else {
    say("\n1) 造一个残留后台（起窗口 → **强杀窗口**，模拟崩溃/宿主被带走）…");
    const orphan = await makeOrphan();
    orphanUrl = orphan.url;
    say(`   残留后台：${orphan.url}（serverPid=${orphan.serverPid}，被强杀的窗口 pid=${orphan.windowPid}）`);
    if (PID_REUSED) {
      const pid = await squatHeartbeatPid();
      say(`   模拟 pid 复用：把心跳里的 pid 改成 ${pid}（一个与扩展无关的活进程，且抹掉启动时刻）`);
    }
    if (NO_HEARTBEAT) {
      say(`   模拟心跳丢失：删掉 ${dropHeartbeats()} 份心跳文件，只留租约`);
    }
    dumpPredicates("残留刚产生（窗口刚死）");

    if (DELAY_MS > 0) {
      say(`\n2) 等 ${Math.round(DELAY_MS / 1000)}s 再看（用户重开窗口往往要更久；越过心跳新鲜度阈值）…`);
      await delay(DELAY_MS);
      dumpPredicates(`窗口死后 ${Math.round(DELAY_MS / 1000)}s`);
    }

    say("\n3) 走一遍**真实启动决策**（新的 ServerManager.ensure()，与激活期同一条代码路径）…");
    const manager = new ServerManager({
      url: "",
      command: COMMAND,
      startTimeoutMs: 90_000,
      workspace: "D:/dev/dsh-chat#orphan-diagnose",
      log: (line) => say(`   [决策日志] ${line}`),
    });
    const info = await manager.ensure();
    const reused = info.baseUrl === orphan.url;
    say(
      reused
        ? `   ✓ **接管成功**：新窗口接上的就是残留后台 ${info.baseUrl}（ownership=${info.ownership}）`
        : `   ✗ **没有接管**：残留是 ${orphan.url}，新窗口用的是 ${info.baseUrl}（ownership=${info.ownership}）`,
    );
    dumpPredicates("接管决策之后");
    manager.dispose();
  }
} catch (error) {
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exitCode = 2;
} finally {
  // 收尾：杀掉本探针留下的任何后台（只碰隔离租约目录里记着的那些）
  if (squatter?.pid !== undefined) {
    spawn("taskkill", ["/pid", String(squatter.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  if (orphanUrl) {
    for (const { lease } of readLeases()) {
      spawn("taskkill", ["/pid", String(lease.serverPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
    await delay(800);
    const [gone] = [tcpReachableSync(orphanUrl)];
    say(gone ? `   （收尾）残留 ${orphanUrl} 仍在服务` : `   （收尾）残留已清理`);
  }
  // 诊断工具：这些导出被 dump 用到，避免打包时被当成未使用
  void [dropDeadLeases, dropStaleHostLeases];
  say(process.exitCode ? "\n✗ 诊断未通过" : "\n✓ 诊断结束");
}
