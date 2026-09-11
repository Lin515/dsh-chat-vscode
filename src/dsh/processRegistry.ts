import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 残留 `dsh web` 进程的检测与清理。
 *
 * VS Code 正常关闭时走 `deactivate → ServerManager.stop()`，`taskkill /T` 会带走
 * 整棵进程树；但崩溃 / 强杀 / 断电时扩展宿主的退出钩子不会执行，Windows 上子进程
 * 也不会随父进程一起消失（没有 Job Object），于是 `node.exe` + `dsh web` 就留了下来。
 *
 * 因此每次拉起服务器都写一张「租约」：谁（扩展宿主 pid）在什么时候起了哪个进程。
 * 下次激活时扫描租约——
 * - 服务器进程已经不在 → 租约作废，删掉；
 * - 宿主进程还活着（其它 VS Code 窗口正在用它）→ 不动；
 * - 服务器活着而宿主没了 → 孤儿，确认命令行确实是 dsh 后 `taskkill /T /F`。
 */
export interface ServerLease {
  /** dsh web 进程 pid（Windows 上经 shell 启动，是 cmd 外壳，/T 带走整棵树）。 */
  serverPid: number;
  /** 拉起它的扩展宿主进程 pid（VS Code 窗口）。 */
  hostPid: number;
  /** 记录时的工作区路径（同机多窗口时便于分辨）。 */
  workspace?: string;
  /** 服务器就绪后的地址。 */
  baseUrl?: string;
  startedAt: number;
  /** 启动命令（诊断用）。 */
  command: string;
}

const LEASE_DIR = join(homedir(), ".dsh-chat", "servers");

function leaseFileFor(pid: number): string {
  return join(LEASE_DIR, `server-${pid}.json`);
}

/** 记下一张租约（启动服务器后调用）；返回是否写成功。 */
export function writeLease(lease: ServerLease): boolean {
  try {
    mkdirSync(LEASE_DIR, { recursive: true });
    writeFileSync(leaseFileFor(lease.serverPid), JSON.stringify(lease), "utf8");
    return true;
  } catch {
    // 租约只影响「能否自动清理残留」，写不进去不能影响服务器本身
    return false;
  }
}

/** 补充租约信息（服务器就绪后补 baseUrl）。 */
export function updateLease(serverPid: number, patch: Partial<ServerLease>): void {
  const current = readLease(serverPid);
  if (!current) return;
  writeLease({ ...current, ...patch });
}

/** 删除租约（正常停止 / 进程已退出时调用）。 */
export function clearLease(serverPid: number | undefined): void {
  if (serverPid === undefined) return;
  try {
    rmSync(leaseFileFor(serverPid), { force: true });
  } catch {
    // 忽略：最坏情况是下次启动多扫一次
  }
}

function readLease(pid: number): ServerLease | undefined {
  try {
    return JSON.parse(readFileSync(leaseFileFor(pid), "utf8")) as ServerLease;
  } catch {
    return undefined;
  }
}

/** 读出全部租约（跳过解析失败的坏文件并清掉）。 */
export function readLeases(): { file: string; lease: ServerLease }[] {
  let entries: string[];
  try {
    entries = readdirSync(LEASE_DIR);
  } catch {
    return [];
  }
  const out: { file: string; lease: ServerLease }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(LEASE_DIR, entry);
    try {
      const lease = JSON.parse(readFileSync(file, "utf8")) as ServerLease;
      if (typeof lease?.serverPid !== "number") throw new Error("bad lease");
      out.push({ file, lease });
    } catch {
      try {
        rmSync(file, { force: true });
      } catch {
        // 忽略
      }
    }
  }
  return out;
}

/** 进程是否还活着（活着但无权限访问也算活着）。 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读进程命令行；取不到返回 undefined（此时按「无法确认」处理，不杀）。 */
function processCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 8_000 },
      );
      if (result.status !== 0) return undefined;
      const text = (result.stdout ?? "").trim();
      return text || undefined;
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0) return undefined;
    const text = (result.stdout ?? "").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** 杀掉整棵进程树（Windows 用 taskkill /T，其它平台 SIGTERM）。 */
function killTree(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 15_000,
      });
      return result.status === 0;
    }
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export interface ResidualProcess {
  lease: ServerLease;
  /** 服务器进程还活着，但拉起它的 VS Code 已经不在了。 */
  orphan: boolean;
  /** 命令行确认是 dsh（拿不到命令行时为 undefined）。 */
  confirmed?: boolean;
  /** 宿主进程还活着：另一个 VS Code 窗口正持有它。 */
  heldByLiveHost: boolean;
}

/** 只读扫描：列出所有租约及其状态，不做任何清理。 */
export function scanServers(): ResidualProcess[] {
  const out: ResidualProcess[] = [];
  for (const { lease } of readLeases()) {
    const alive = isProcessAlive(lease.serverPid);
    const heldByLiveHost = isProcessAlive(lease.hostPid);
    if (!alive) {
      out.push({ lease, orphan: false, heldByLiveHost });
      continue;
    }
    if (heldByLiveHost) {
      out.push({ lease, orphan: false, heldByLiveHost: true });
      continue;
    }
    const commandLine = processCommandLine(lease.serverPid);
    out.push({
      lease,
      orphan: true,
      confirmed: commandLine === undefined ? undefined : /dsh/i.test(commandLine),
      heldByLiveHost: false,
    });
  }
  return out;
}

export interface CleanupResult {
  /** 扫描到的租约数。 */
  scanned: number;
  /** 判定为孤儿（宿主已消失）的进程。 */
  orphans: number[];
  /** 成功杀掉的进程。 */
  killed: number[];
  /** 判定为孤儿但没能杀掉（或无法确认是 dsh）的进程。 */
  skipped: number[];
}

/**
 * 清理残留：杀死「宿主已消失」的 dsh 进程并删除对应租约。
 * 拿不到命令行、或命令行里看不到 dsh 的，只清租约不动进程（避免 pid 被回收后误杀）。
 */
export function cleanupResidualServers(log: (line: string) => void): CleanupResult {
  const result: CleanupResult = { scanned: 0, orphans: [], killed: [], skipped: [] };
  for (const item of scanServers()) {
    result.scanned++;
    const pid = item.lease.serverPid;
    if (!isProcessAlive(pid)) {
      // 进程已退出：租约作废
      clearLease(pid);
      continue;
    }
    if (!item.orphan) continue;
    result.orphans.push(pid);
    if (item.confirmed === false) {
      log(`[cleanup] 跳过 pid=${pid}：命令行里没有 dsh，疑似 pid 被回收`);
      result.skipped.push(pid);
      clearLease(pid);
      continue;
    }
    if (killTree(pid)) {
      log(`[cleanup] 已清理残留 dsh 进程 pid=${pid}${item.lease.baseUrl ? ` (${item.lease.baseUrl})` : ""}`);
      result.killed.push(pid);
    } else {
      log(`[cleanup] 清理 pid=${pid} 失败（可能已经退出或权限不足）`);
      result.skipped.push(pid);
    }
    clearLease(pid);
  }
  return result;
}

/** 租约目录（诊断信息里展示）。 */
export function leaseDirectory(): string {
  return LEASE_DIR;
}
