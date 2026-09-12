import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 *
 * **为什么整个扫描/清理链路是异步的**：判定「命令行里是不是 dsh」要起 PowerShell，
 * 而 Windows 上一次 PowerShell 启动约 1.5s。用 `spawnSync` 的话这 1.5s 会把
 * **扩展宿主的主线程整个卡住**（JS 单线程）——启动时表现为界面迟滞、命令无响应。
 * 改动前实测：`isProcessAlive` 之后的同步段会阻塞约 1700ms。
 * 现在同步段只做租约文件的同步读写（微秒级），进程查询一律 await。
 */

/**
 * 起一个子进程并收集 stdout，返回**永不 reject** 的结果。
 *
 * 为什么不用 `execFile`：需要自己控制超时与输出上限（`Get-CimInstance` 全量输出
 * 可能上兆，而 `execFile` 的 `maxBuffer` 超限是个一次性错误，拿不到已收内容）。
 * 这里统一成「退出码 + stdout + 错误码」，调用方据此区分「命令失败」与
 * 「根本起不来（ENOENT）」，两者的处置不同。
 */
interface ExecOutcome {
  /** 退出码；进程未正常退出（超时/被杀/起不来）时为 undefined。 */
  code: number | undefined;
  stdout: string;
  /** 起不来或异常终止的原因码（ENOENT / TIMEOUT / MAXBUFFER…）。 */
  errorCode: string | undefined;
}

function execCapture(
  executable: string,
  args: string[],
  options: { timeoutMs: number; maxBytes: number },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve({
        code: undefined,
        stdout: "",
        errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED",
      });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已经退出了
      }
      finish({ code: undefined, stdout: "", errorCode: "TIMEOUT" });
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        try {
          child.kill();
        } catch {
          // 忽略
        }
        // 输出超限说明拿到的数据不可信，宁可不确认（不杀）也不要截断后误判
        finish({ code: undefined, stdout: "", errorCode: "MAXBUFFER" });
        return;
      }
      chunks.push(chunk);
    });

    child.on("error", (error) => {
      finish({
        code: undefined,
        stdout: "",
        errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED",
      });
    });

    child.on("close", (code) => {
      finish({ code: code ?? undefined, stdout: Buffer.concat(chunks).toString("utf8"), errorCode: undefined });
    });
  });
}
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

/**
 * 取「所有进程的命令行」，按 pid 索引。
 *
 * 为什么是**批量**而不是逐个查：Windows 上取命令行只能起 PowerShell 查 CIM，
 * 而代价几乎全在**解释器启动**上——实测单查一个 pid 约 1600ms，而一次查全部进程
 * 约 1800ms（几乎一样）。逐个查会让 N 个孤儿耗时 N×1600ms，批量后恒为一次。
 * （`wmic` 已在新版 Windows 上移除，不能用；`pwsh` 比 `powershell.exe` 快约 300ms，
 * 所以优先用它，取不到再退回。）
 *
 * 快照带一个很短的 TTL：同一轮启动里 `scanServers` 与 `cleanupResidualServers`
 * 会先后扫描，命中缓存可省掉第二次 PowerShell。TTL 故意取得很短（2s）——
 * 判定「杀哪个进程」依赖命令行，过期数据有 pid 被回收后误杀的风险；
 * 而 pid 在 2s 内被回收、且新进程命令行里同样带 `dsh` 的概率可以忽略。
 */
const COMMAND_LINE_TTL_MS = 2_000;

let commandLineCache: { at: number; lines: Map<number, string> } | undefined;
/** 在途的全量查询：并发调用共享它，避免同时起多个 PowerShell。 */
let commandLineInFlight: Promise<Map<number, string> | undefined> | undefined;
/** 已经验证可用的 PowerShell 可执行名（避免每次都试错）。 */
let shellExecutable: string | undefined;
/** 本进程内起过几次 PowerShell（含失败）。仅用于诊断与测试断言批量化，不参与业务逻辑。 */
let shellCalls = 0;

/** 诊断/测试用：本进程内启动 PowerShell 取命令行的次数。 */
export function shellCallCount(): number {
  return shellCalls;
}

/** 重置缓存与计数（测试用）。 */
export function resetCommandLineCache(): void {
  commandLineCache = undefined;
  commandLineInFlight = undefined;
  shellCalls = 0;
}

function shellCandidates(): string[] {
  // pwsh 启动比 Windows PowerShell 快，优先；不存在时会以 ENOENT 失败，再退回
  return process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell"];
}

async function runPowerShell(script: string): Promise<string | undefined> {
  const candidates = shellExecutable ? [shellExecutable] : shellCandidates();
  for (const executable of candidates) {
    shellCalls++;
    const outcome = await execCapture(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeoutMs: 20_000,
      // 全部进程的命令行可能上兆
      maxBytes: 64 * 1024 * 1024,
    });
    if (outcome.errorCode !== undefined) {
      // 只有「这个解释器不存在」才值得换一个再试；超时/超限直接放弃
      if (outcome.errorCode === "ENOENT") continue;
      return undefined;
    }
    if (outcome.code !== 0) return undefined;
    shellExecutable = executable;
    return outcome.stdout;
  }
  return undefined;
}

/**
 * 解析 PowerShell 输出的进程 JSON。
 *
 * `ConvertTo-Json` 在只有一个元素时给对象、多个时给数组，两种都要吃下。
 * 导出以便离线断言（这是批量化里最容易写错的一段）。
 */
export function parseProcessList(stdout: string): Map<number, string> {
  const lines = new Map<number, string>();
  const text = stdout.trim();
  if (!text) return lines;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return lines;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { ProcessId, CommandLine } = row as { ProcessId?: unknown; CommandLine?: unknown };
    if (typeof ProcessId !== "number" || !Number.isSafeInteger(ProcessId)) continue;
    if (typeof CommandLine !== "string" || !CommandLine.trim()) continue;
    lines.set(ProcessId, CommandLine.trim());
  }
  return lines;
}

/**
 * 取这些 pid 的命令行快照；取不到返回 undefined（此时一律按「无法确认」处理）。
 *
 * 缓存只在**能回答全部 pid** 时才复用：若某个 pid 不在缓存里，很可能是快照之后才
 * 启动的进程（例如刚拉起的服务器），此时必须重取，否则会把它当成「查不到命令行」。
 * 每次调用最多起一次 PowerShell。
 */
async function commandLinesFor(pids: number[]): Promise<Map<number, string> | undefined> {
  if (pids.length === 0) return undefined;
  const fresh = commandLineCache && Date.now() - commandLineCache.at < COMMAND_LINE_TTL_MS;
  if (fresh && pids.every((pid) => commandLineCache!.lines.has(pid))) return commandLineCache!.lines;
  return fetchCommandLines();
}

/**
 * 取回全量快照并写入缓存。
 *
 * 同时只允许一次在途查询（single-flight）：改成异步后，两个并发调用（例如启动清理
 * 与「显示诊断信息」同时触发）会各自起一次 PowerShell——异步本来就是为了不卡主线程，
 * 却因此可能起两倍的解释器。共享同一个 promise 既省时间也省内存。
 */
function fetchCommandLines(): Promise<Map<number, string> | undefined> {
  if (commandLineInFlight) return commandLineInFlight;

  const task = (async (): Promise<Map<number, string> | undefined> => {
    const stdout = await runPowerShell(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    );
    if (stdout === undefined) {
      commandLineCache = undefined;
      return undefined;
    }
    const lines = parseProcessList(stdout);
    // 时间戳取**取回之后**：TTL 语义是「数据有多旧」。若记成发起时刻，
    // 一次慢查询（PowerShell 冷启动可能超过 TTL）会让刚拿到的数据立刻被判过期。
    commandLineCache = { at: Date.now(), lines };
    return lines;
  })();

  commandLineInFlight = task.finally(() => {
    commandLineInFlight = undefined;
  });
  return commandLineInFlight;
}

/** 非 Windows：`ps` 逐进程查，代价很小（约 5ms），不需要批量化。 */
async function commandLinesPosix(pids: number[]): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  for (const pid of pids) {
    const outcome = await execCapture("ps", ["-p", String(pid), "-o", "command="], {
      timeoutMs: 5_000,
      maxBytes: 4 * 1024 * 1024,
    });
    const text = outcome.code === 0 ? outcome.stdout.trim() : "";
    if (text) lines.set(pid, text);
  }
  return lines;
}

/** 杀掉整棵进程树（Windows 用 taskkill /T，其它平台 SIGTERM）。 */
async function killTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    const outcome = await execCapture("taskkill", ["/pid", String(pid), "/T", "/F"], {
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
    });
    return outcome.code === 0;
  }
  try {
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

/**
 * 只读扫描：列出所有租约及其状态，不做任何清理。
 *
 * 同步段只有租约文件的读写（微秒级）；需要起进程的部分（命令行查询）全部 await，
 * 因此调用它不会阻塞扩展宿主。
 */
export async function scanServers(): Promise<ResidualProcess[]> {
  const out: ResidualProcess[] = [];
  /** 需要确认命令行的孤儿：记下它在 out 里的下标，稍后一次性回填。 */
  const orphanIndexes: { index: number; pid: number }[] = [];

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
    orphanIndexes.push({ index: out.length, pid: lease.serverPid });
    out.push({ lease, orphan: true, confirmed: undefined, heldByLiveHost: false });
  }

  // 一次性取回**全部**孤儿的命令行（Windows 上逐个查会付 N 次 PowerShell 启动成本）
  if (orphanIndexes.length) {
    const pids = orphanIndexes.map((item) => item.pid);
    const commandLines =
      process.platform === "win32" ? await commandLinesFor(pids) : await commandLinesPosix(pids);
    for (const { index, pid } of orphanIndexes) {
      const commandLine = commandLines?.get(pid);
      out[index].confirmed = commandLine === undefined ? undefined : /dsh/i.test(commandLine);
    }
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
 * 是否允许杀掉这个进程：**只有确认命令行里是 dsh** 才允许。
 *
 * `confirmed` 为 undefined（拿不到命令行，例如 PowerShell 不可用、被策略拦住）
 * 时必须按「不杀」处理——那恰恰是最无法排除「pid 已被回收」的情形，
 * 此时动手等于闭着眼睛杀进程。这里刻意用 `=== true` 而非 `!== false`：
 * 三态里只有 true 是肯定证据，其余两态都不足以支撑一次 taskkill。
 */
export function isKillable(item: Pick<ResidualProcess, "orphan" | "confirmed">): boolean {
  return item.orphan && item.confirmed === true;
}

/**
 * 清理残留：杀死「宿主已消失」的 dsh 进程并删除对应租约。
 * 拿不到命令行、或命令行里看不到 dsh 的，只清租约不动进程（避免 pid 被回收后误杀）。
 *
 * 异步：中间的进程查询与 taskkill 都要起子进程，await 期间扩展宿主仍能响应。
 */
export async function cleanupResidualServers(log: (line: string) => void): Promise<CleanupResult> {
  const result: CleanupResult = { scanned: 0, orphans: [], killed: [], skipped: [] };
  for (const item of await scanServers()) {
    result.scanned++;
    const pid = item.lease.serverPid;
    if (!isProcessAlive(pid)) {
      // 进程已退出：租约作废
      clearLease(pid);
      continue;
    }
    if (!item.orphan) continue;
    result.orphans.push(pid);
    if (!isKillable(item)) {
      const why =
        item.confirmed === false
          ? "命令行里没有 dsh，疑似 pid 被回收"
          : "拿不到命令行，无法确认是 dsh";
      log(`[cleanup] 跳过 pid=${pid}：${why}`);
      result.skipped.push(pid);
      clearLease(pid);
      continue;
    }
    if (await killTree(pid)) {
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

// ---------- 崩溃后残留的 writer 锁 ----------

/**
 * `dsh` 用户目录（`$DSH_HOME`，未设置时 `~/.dsh`）。
 *
 * 与 `dsh-home-paths.resolveDshHome` 同一套优先级。这里只读环境变量、不引那个包：
 * 本扩展是独立进程，且只需要拿一个路径。
 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? configured : join(homedir(), ".dsh");
}

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
 * 清理**崩溃遗留**的 writer 锁。
 *
 * 背景（用户 2026-09-12 实测）：强杀 VS Code 后重新打开，`dsh web` 启动直接崩：
 * ```
 * Error: atomic-write: timed out waiting for the writer lock at
 *   C:\Users\...\.dsh\.credentials.yaml.lock
 *   at withFileLock (.../dsh-atomic-write/lib/index.js:136:37)
 *     at async boot (.../dsh-app-boot/lib/index.js:1535:3)
 * ```
 * 根因：`withFileLock` 用 `wx` 建 `<file>.lock`，内容是持有者的 pid，`finally` 里删除。
 * 进程被强杀时 `finally` 不会执行，锁就留下了。库本身**刻意不回收**它——
 * 注释写明「文件年龄无法证明持有者已经停止；孤儿回收是运维动作」
 * （`dsh-atomic-write/lib/index.js` 的 `withFileLock` 文档）。而 `boot()` 里那次
 * 加锁等 30 秒后抛错，直接把整个 `dsh web` 进程带走。
 *
 * 于是「运维动作」落在本扩展身上：我们**能**证明持有者是否已死——
 * 锁里写着 pid，进程表也查得到。判定按**肯定证据**来（与 `isKillable` 同一纪律）：
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
