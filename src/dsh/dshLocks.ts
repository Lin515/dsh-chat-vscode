/**
 * `dsh` 自己的文件锁（writer lock）与 `$DSH_HOME` 定位。
 *
 * **为什么这几行单独成文件**：它们与"后台生命周期"无关，是"dsh 起不来"的兜底——
 * `dsh web` 的 boot 会去锁 `<DSH_HOME>/.credentials.yaml`，拿不到就等 30 秒然后把
 * 整个进程带走。库本身刻意**不回收孤儿锁**（它的注释写明"文件年龄无法证明持有者已停止，
 * 孤儿回收是运维动作"），所以这个"运维动作"落在客户端身上。
 *
 * 生命周期那一层（会合租约 / 心跳 / 接管）在 supervisor 架构落地后已经整体删除，
 * 见 `docs/design-supervisor.md`；这里留下的是与"谁持有 dsh"无关的那部分。
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "./processRegistry";
import { fetchCommandLines } from "./processTable";

/** 需要探测残留锁的文件（相对 `$DSH_HOME`）。 */
const LOCKED_DOCUMENTS = [".credentials.yaml", "settings.yaml"] as const;

/** 一次残留锁检查的结果。 */
export interface StaleLockResult {
  /** 被清掉的锁文件路径。 */
  cleared: string[];
  /** 锁存在且持有者仍然活着，没动的。 */
  held: string[];
}

/**
 * `$DSH_HOME`（默认 `~/.dsh`；`DSH_HOME` 环境变量可覆盖）。
 *
 * 为什么扩展要知道它：崩溃遗留的锁与配置都在这里；`clearStaleDocumentLocks` 要按它定位，
 * 桌面端支路也要按它找凭据文件（`desktopAttach.ts` 的 `productionDesktopDeps`）。
 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? configured : join(homedir(), ".dsh");
}

/** 读锁文件里的 pid（内容形如 `<pid>\n`）；读不到返回 undefined。 */
export function readLockPid(lockPath: string): number | undefined {
  try {
    const text = readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 锁文件是否**老到**值得怀疑（超过 10 分钟）。
 *
 * 只用于诊断输出，不参与删除判据：年龄从来不是「持有者已死」的证据
 * （一次慢的凭据刷新可以合理地持有很久）。
 */
export function lockAgeMs(lockPath: string): number | undefined {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

function removeLock(
  lockPath: string,
  pid: number,
  why: string,
  log: (line: string) => void,
  result: StaleLockResult,
): void {
  // 先量年龄再删：删掉之后就 stat 不到了
  const age = lockAgeMs(lockPath);
  try {
    rmSync(lockPath, { force: true });
    log(
      `[lock] 已清理残留锁 ${lockPath}（pid=${pid}，${why}` +
        `${age === undefined ? "" : `，已存在 ${Math.round(age / 1000)}s`}）`,
    );
    result.cleared.push(lockPath);
  } catch {
    // 删不掉就把结论说清楚：服务器会自己等 30 秒后失败，用户得知道为什么
    log(`[lock] 清理残留锁失败：${lockPath}（pid=${pid}，${why}）——可能需要手动删除`);
    result.held.push(lockPath);
  }
}

/**
 * 清理**崩溃遗留**的 writer 锁。
 *
 * 背景（用户 2026-09-12 实测）：强杀 VS Code 后重新打开，`dsh web` 启动直接崩：
 * ```text
 * Error: atomic-write: timed out waiting for the writer lock at
 *   C:\Users\...\.dsh\.credentials.yaml.lock
 *   at withFileLock (.../dsh-atomic-write/lib/index.js:136:37)
 *     at async boot (.../dsh-app-boot/lib/index.js:1535:3)
 * ```
 * 根因：`withFileLock` 用 `wx` 建 `<file>.lock`，内容是持有者的 pid，`finally` 里删除。
 * 进程被强杀时 `finally` 不会执行，锁就留下了。
 *
 * 判定按**肯定证据**来（与 `isKillable` 同一纪律）：
 * - pid 不存活 → 持有者已死，删锁；
 * - pid 存活但命令行不是 dsh/node → pid 被回收，删锁；
 * - pid 存活且确实是 dsh → 真的在用，不动。
 *
 * 拿不到命令行时**不删**（无从排除「pid 被回收」这个最危险的情形）——
 * 宁可让用户手动删，也不要在一个正在写的进程下面抽掉它的锁。
 *
 * @param log 诊断输出。
 */
export async function clearStaleDocumentLocks(log: (line: string) => void): Promise<StaleLockResult> {
  const result: StaleLockResult = { cleared: [], held: [] };
  const home = dshHome();

  // 先把「锁文件 → pid」读出来（同步、微秒级），再一次性查进程表，
  // 避免每个锁各起一次 PowerShell（成本几乎全在解释器启动上）
  const candidates: { lockPath: string; pid: number }[] = [];
  for (const document of LOCKED_DOCUMENTS) {
    const lockPath = join(home, `${document}.lock`);
    const pid = readLockPid(lockPath);
    if (pid !== undefined) candidates.push({ lockPath, pid });
  }
  if (!candidates.length) return result;

  const alive = candidates.filter((item) => isProcessAlive(item.pid));
  const pids = alive.map((item) => item.pid);
  const commandLines = pids.length ? await fetchCommandLines() : undefined;

  for (const item of candidates) {
    if (!alive.some((entry) => entry.lockPath === item.lockPath)) {
      // 肯定证据：持有者进程已不存在 → 纯粹是崩溃留下的
      removeLock(item.lockPath, item.pid, "持有者进程已退出", log, result);
      continue;
    }
    const command = commandLines?.get(item.pid);
    if (command === undefined) {
      log(`[lock] ${item.lockPath} 的持有者 pid=${item.pid} 仍在运行，但拿不到命令行，保持不动`);
      result.held.push(item.lockPath);
      continue;
    }
    if (!/\b(dsh|node)(\.exe)?\b/i.test(command)) {
      // 肯定证据：pid 被回收给了别的程序 → 锁是孤儿
      removeLock(item.lockPath, item.pid, `pid 已被回收（${command.slice(0, 60)}）`, log, result);
      continue;
    }
    log(`[lock] ${item.lockPath} 的持有者 pid=${item.pid} 正在运行，保持不动`);
    result.held.push(item.lockPath);
  }
  return result;
}
