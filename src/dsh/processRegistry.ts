import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * **2026-09-14 起租约还承担第二件事：多窗口共享同一个后台**（见
 * `docs/design-shared-server.md`）。于是租约从「一个宿主 pid」升级成一份
 * **会合信息**：`baseUrl` + 启动令牌 + `hosts[]`（谁在用、各自心跳）。
 * 共享能成立的根据是两条实测事实：
 * - 启动令牌是 `randomBytes(32)` 的**进程内内存值**，只随公告行打印一次，
 *   磁盘上本来没有——所以想复用就得由起服务器的那个窗口**主动写下来**（`token` 字段）；
 * - 签名 cookie 跨重启有效但**绑定 host:port**（cookie 名 = sha256(authority)），
 *   所以接入方必须知道当前的 `baseUrl` 才能换到能用的 cookie。
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
  /** 租约格式版本：1 = 只有 `hostPid`（旧），2 = 带 `hosts[]` / `token`（共享）。 */
  version?: number;
  /** dsh web 进程 pid（Windows 上经 shell 启动，是 cmd 外壳，/T 带走整棵树）。 */
  serverPid: number;
  /** 拉起它的扩展宿主进程 pid（VS Code 窗口）。v2 里由 `hosts` 取代，仅为兼容旧文件保留。 */
  hostPid?: number;
  /** 记录时的工作区路径（同机多窗口时便于分辨）。 */
  workspace?: string;
  /** 服务器就绪后的地址。启动中（尚未就绪）时不存在。 */
  baseUrl?: string;
  /**
   * 启动令牌（v2 新增）。
   *
   * 它本来只存在于 `dsh web` 进程的内存里，**写进租约是共享能成立的唯一办法**：
   * 其它窗口拿它去 `GET /?token=…` 换一张绑定当前 host:port 的 cookie。
   * 权限假设：`~/.dsh-chat/` 与 `~/.dsh/`（.credentials.yaml 同级）等价，
   * 只对当前用户开放。
   */
  token?: string;
  startedAt: number;
  /** 启动命令（诊断用）。 */
  command: string;
  /** 正在使用这个后台的 VS Code 窗口（v2）。 */
  hosts?: LeaseHost[];
}

/** 一个正在使用某个后台的 VS Code 窗口。 */
export interface LeaseHost {
  /** 扩展宿主进程 pid。 */
  pid: number;
  /** 该窗口的工作区路径（诊断 + 界面显示来源）。 */
  workspace?: string;
  /** 心跳时间（epoch ms）：**判活的依据**，不是 `startedAt`。 */
  seenAt: number;
}

/**
 * 会合租约（与启动锁）的目录。
 *
 * 默认 `~/.dsh-chat/servers`。`DSH_CHAT_LEASE_DIR` 可以整体改掉它——**探针要用**：
 * 共享后台的端到端验证要起真实的 `dsh web` 并伪造多个"窗口"，如果和用户正在跑的
 * VS Code 共用同一份租约，两边会互相接入/互相清理，测出来的结论不可信。
 * 顺带也是排查手段：指向一个空目录就退化成"每个窗口各自一个后台"。
 */
function resolveLeaseDir(): string {
  const configured = process.env.DSH_CHAT_LEASE_DIR?.trim();
  return configured ? configured : join(homedir(), ".dsh-chat", "servers");
}

const LEASE_DIR = resolveLeaseDir();

function leaseFileFor(pid: number): string {
  return join(LEASE_DIR, `server-${pid}.json`);
}

/**
 * 租约的**读—改—写**必须互斥：两个窗口会同时写同一张租约（各自 5 秒一次心跳）。
 *
 * 不互斥的后果很具体（端到端探针实测撞到过一次）：A 的心跳带着"写之前读到的" hosts
 * 覆盖回去，把 B 刚登记的那条挤掉；A 关窗时 `isLastLiveHost` 于是以为自己是最后一个，
 * **杀掉 B 还在用的后台**——需求 R3 直接被破坏。
 *
 * 锁是 `<租约文件>.lock`（内容一行 pid），**同步自旋最多 150ms**：这是几十字节的
 * 同步写，正常永远不撞；真撞上了也不值得让扩展宿主卡住，超时就按参数决定是
 * "跳过这次刷新"（`skip`，用于纯心跳）还是"不加锁写一次"（`write`，用于登记/摘除）。
 * 无论哪种，下一轮心跳都会把状态修回来。
 *
 * @param onTimeout 拿不到锁时怎么办：`undefined` = 放弃这次写。
 */
function withLeaseLock<T>(key: string, body: () => T): T {
  const lockPath = join(LEASE_DIR, `${key}.lock`);
  let locked = false;
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    locked = true;
  } catch {
    const deadline = Date.now() + 150;
    while (Date.now() < deadline) {
      const holder = readLockPid(lockPath);
      if (holder === undefined || !isProcessAlive(holder)) {
        // 残留锁（持有者已死 / 内容坏掉）→ 清掉重试
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // 忽略
        }
      }
      try {
        writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        locked = true;
        break;
      } catch {
        // 还在被别人持有
      }
      // 同步阻塞几毫秒：租约读写刻意保持同步（调用方遍布同步路径），
      // 用 Atomics.wait 而不是忙等，避免白烧 CPU
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      } catch {
        // 极少数环境不支持 → 直接放弃本轮等待
        break;
      }
    }
  }
  if (!locked) return body(); // 退化成不加锁：宁可偶尔丢一次刷新，也不卡住宿主
  try {
    return body();
  } finally {
    try {
      if (readLockPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // 忽略
    }
  }
}

/** 记下一张租约（启动服务器后调用）；返回是否写成功。 */
export function writeLease(lease: ServerLease): boolean {
  // 整个写包在租约锁里（见 `withLeaseLock`）：写的是完整快照，和别人的读改写交错
  // 就会互相覆盖
  return withLeaseLock(`server-${lease.serverPid}`, () => {
    try {
      mkdirSync(LEASE_DIR, { recursive: true });
      writeFileSync(leaseFileFor(lease.serverPid), JSON.stringify(lease), "utf8");
      return true;
    } catch {
      // 租约只影响「能否自动清理残留」与共享，写不进去不能影响服务器本身
      return false;
    }
  });
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
    const parsed = JSON.parse(readFileSync(leaseFileFor(pid), "utf8")) as ServerLease;
    if (typeof parsed?.serverPid !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 按 pid 读一张租约（等另一个窗口写 `baseUrl` 时用；读不到返回 undefined）。 */
export function readLeaseByPid(pid: number): ServerLease | undefined {
  return readLease(pid);
}

// ---------- 共享后台：心跳判活与窗口登记（见 docs/design-shared-server.md）----------

/** 心跳间隔：每个窗口每隔这么久刷一次自己的 `seenAt`。 */
export const HOST_HEARTBEAT_MS = 5_000;

/**
 * 判死阈值：`seenAt` 比这还旧就当作「这个窗口已经没了」。
 *
 * 取心跳的 6 倍（30s）是刻意的保守：误判「窗口已死」的后果是**杀掉别人正在用的后台**，
 * 而漏判的后果只是多留一个孤儿进程（下次激活还会被清）。宁可漏判。
 */
export const HOST_STALE_MS = 30_000;

/**
 * 这个窗口还活着吗。
 *
 * 两个条件都要：进程在（肯定证据）+ 心跳足够新。**心跳不是冗余的**——
 * pid 会被系统回收，一个刚启动的无关进程完全可能占用旧 pid；`seenAt` 是我们
 * 自己写的时间戳，它陈旧就说明那个窗口确实没在刷了。
 */
export function isHostLive(host: LeaseHost, now = Date.now()): boolean {
  if (!isProcessAlive(host.pid)) return false;
  return now - host.seenAt < HOST_STALE_MS;
}

/**
 * 把租约里的 hosts 归一化。
 *
 * 旧格式（v1，只有 `hostPid`）在这里被折成一个 host：**不做版本迁移脚本**，
 * 下一次写入自然升级成 v2。`seenAt` 缺失时按 `startedAt` 算（它同样是"最后见到
 * 这个宿主"的时间下界），于是旧租约不会被误判成陈旧。
 */
export function leaseHosts(lease: ServerLease): LeaseHost[] {
  if (Array.isArray(lease.hosts) && lease.hosts.length) {
    return lease.hosts.filter(
      (host): host is LeaseHost =>
        typeof host === "object" && host !== null && typeof (host as LeaseHost).pid === "number",
    );
  }
  if (typeof lease.hostPid === "number") {
    return [{ pid: lease.hostPid, workspace: lease.workspace, seenAt: lease.startedAt }];
  }
  return [];
}

/** 租约里还活着的窗口。 */
export function liveHosts(lease: ServerLease, now = Date.now()): LeaseHost[] {
  return leaseHosts(lease).filter((host) => isHostLive(host, now));
}

// ---------- 每个扩展实例的心跳文件（"窗口被禁用"能不能被发现，全靠它）----------

/**
 * 心跳文件的目录：`<租约目录>/hosts/<hostId>.json`。
 *
 * **为什么不能只靠租约里的 `hosts[].seenAt`**：一个 VS Code 窗口里所有扩展共享同一个
 * 扩展宿主进程，所以同一个窗口的两个扩展实例（比如两个对话面板挂在不同视图上）
 * pid 完全相同。按 pid 记心跳时，只要还有一个实例活着，`hosts` 里那条就永远新鲜
 * ——用户**禁用了某个窗口的扩展**，别的窗口却认为它还在用后台（实测口径问题）。
 * 每个扩展实例给自己生成一个 `hostId`（激活期一次），各自写一份心跳文件，
 * 谁被禁用/关掉，它那份就自然停更、随后被判死。
 *
 * 心跳文件只有当前进程在读（`hostsOf`），所以不需要加锁。
 */
const HOST_DIR = join(LEASE_DIR, "hosts");

function hostLeaseFile(hostId: string): string {
  return join(HOST_DIR, `${hostId.replace(/[^\w.-]/g, "_")}.json`);
}

/**
 * 写自己的心跳：我（这个扩展实例）正在用哪个后台。
 *
 * **连接信息（`baseUrl`/`token`/`command`）也记在这里**，这是崩溃复用能成立的唯一办法：
 * 上次 VS Code 崩溃时，租约会被服务器进程的 exit 处理器顺手删掉（它随父进程一起死），
 * 磁盘上只剩这份心跳——里面若没有地址与令牌，新窗口就永远接不上那个仍然活着的服务器
 * （`--port 0` 端口是随机的、令牌只存在于服务器进程内存里）。
 */
export function writeHostLease(host: {
  hostId: string;
  serverPid: number;
  workspace?: string;
  baseUrl?: string;
  token?: string;
  command?: string;
}): boolean {
  try {
    mkdirSync(HOST_DIR, { recursive: true });
    writeFileSync(
      hostLeaseFile(host.hostId),
      JSON.stringify({
        hostId: host.hostId,
        serverPid: host.serverPid,
        pid: process.pid,
        workspace: host.workspace,
        baseUrl: host.baseUrl,
        token: host.token,
        command: host.command,
        seenAt: Date.now(),
      }),
      "utf8",
    );
    return true;
  } catch {
    // 心跳写不进去只影响"别的窗口多久发现我没了"，不该影响本窗口的连接
    return false;
  }
}

/**
 * 这个扩展实例还活着吗：**心跳文件在、且足够新**。
 *
 * 刻意不看 pid：文件由实例自己写，停更就是停更——这正是"被禁用"与"还活着"的区别。
 */
export function isHostLeaseLive(hostId: string, now = Date.now()): boolean {
  const entry = readHostLease(hostId);
  if (!entry) return false;
  if (now - entry.seenAt >= HOST_STALE_MS) return false;
  return entry.pid === undefined || livePidsSync([entry.pid]).has(entry.pid);
}

/** 读一条心跳记录（诊断/判活共用）。 */
function readHostLease(hostId: string): HostLeaseEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(hostLeaseFile(hostId), "utf8")) as {
      hostId?: string;
      serverPid?: number;
      pid?: number;
      baseUrl?: string;
      token?: string;
      command?: string;
      seenAt?: number;
    };
    if (typeof parsed?.seenAt !== "number") return undefined;
    return {
      hostId: typeof parsed.hostId === "string" ? parsed.hostId : hostId,
      serverPid: typeof parsed.serverPid === "number" ? parsed.serverPid : undefined,
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      command: typeof parsed.command === "string" ? parsed.command : undefined,
      seenAt: parsed.seenAt,
    };
  } catch {
    return undefined;
  }
}

/** 心跳文件的记录形状。 */
interface HostLeaseEntry {
  hostId: string;
  serverPid?: number;
  pid?: number;
  /** 服务器就绪后记下的连接信息：崩溃复用的唯一依据。 */
  baseUrl?: string;
  token?: string;
  command?: string;
  seenAt: number;
}

/**
 * 批量判断这些 pid 是否**真的**还活着（同步，一次进程表查询）。
 *
 * 为什么不能用 `process.kill(pid, 0)`：在 Windows 上，**被杀死但还没被回收的进程**
 * 也会让这个探测返回成功（实测：窗口被 taskkill 之后 2.5 秒，探测仍说它活着）。
 * 后果很具体——崩溃遗留的后台会被判成"还有人在用"，于是新窗口不接管它、反而另起
 * 一个（需求"崩溃后应当复用遗留后台"直接失效）。
 *
 * 只查一次进程表（`Get-Process -Id a,b,c`）。查不到结果时退回逐 pid 探测（保守）。
 */
function livePidsSync(pids: number[]): Set<number> {
  const wanted = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!wanted.length) return new Set();
  if (process.platform !== "win32") return new Set(wanted.filter((pid) => isProcessAlive(pid)));

  const script = `Get-Process -Id ${wanted.join(",")} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`;
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const out = spawnSyncQuiet("pwsh.exe", args, 15_000) ?? spawnSyncQuiet("powershell.exe", args, 15_000);
  if (out === undefined) return new Set(wanted.filter((pid) => isProcessAlive(pid)));
  const live = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) live.add(pid);
  }
  return live;
}

/**
 * 一份"谁真的还活着"的快照，用于一次判定走完所有心跳。
 *
 * 读心跳是微秒级，但判活要起一次 PowerShell（约 1.5s）——所以判活**必须批量**：
 * 把所有 pid 一次问完，而不是每条心跳问一次。这也是本模块一贯的纪律
 * （见 `commandLinesFor` 的注释）。
 */
function liveHostSnapshot(entries: HostLeaseEntry[], now: number): HostLeaseEntry[] {
  const fresh = entries.filter((entry) => now - entry.seenAt < HOST_STALE_MS);
  const withPid = fresh.filter((entry) => typeof entry.pid === "number") as (HostLeaseEntry & { pid: number })[];
  if (!withPid.length) return fresh;
  const live = livePidsSync(withPid.map((entry) => entry.pid));
  return fresh.filter((entry) => entry.pid === undefined || live.has(entry.pid));
}

/** 列出全部心跳文件（诊断 + 清理用）。 */
export function readHostLeases(): HostLeaseEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(HOST_DIR);
  } catch {
    return [];
  }
  const out: HostLeaseEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const parsed = readHostLease(entry.replace(/\.json$/, ""));
    if (parsed) out.push(parsed);
  }
  return out;
}

/** 删掉自己的心跳文件（正常停用/不再使用某个后台时）。 */
export function clearHostLease(hostId: string): void {
  try {
    rmSync(hostLeaseFile(hostId), { force: true });
  } catch {
    // 忽略
  }
}

/** 清理陈旧心跳文件；返回清掉的 hostId。 */
export function dropStaleHostLeases(now = Date.now()): string[] {
  const dropped: string[] = [];
  for (const entry of readHostLeases()) {
    if (now - entry.seenAt < HOST_STALE_MS) continue;
    const hostId = entry.hostId;
    clearHostLease(hostId);
    dropped.push(hostId);
  }
  return dropped;
}

/** 现在活着（心跳新鲜）的扩展实例 id。 */
/** 现在活着（心跳新鲜、且写它的进程真的在）的扩展实例 id。 */
export function liveHostIds(now = Date.now()): string[] {
  return liveHostSnapshot(readHostLeases(), now).map((entry) => entry.hostId);
}

/**
 * 某个后台**现在还有活着的扩展实例在用吗**。
 *
 * **唯一判据是各实例的心跳文件**（`hosts/<hostId>.json`），刻意不做 pid 兜底：
 * - 按 pid 记的话，同一个窗口里多个面板共用一个 pid，于是"用户禁用了某个窗口的扩展"
 *   永远发现不了；
 * - 反过来，本实例自己摘掉登记后，那条陈旧记录又会让判据低估"最后一个"。
 * 心跳文件按实例写，两个方向都准。老版本只写 `hosts[]` 的租约因此**不会被接入**
 * （心跳文件证明不了它还被谁用着）——那是安全的默认：宁可多起一个后台，也不要把自己
 * 挂到一个可能马上被杀的进程上。
 */
export function hasLiveHostFor(serverPid: number, now = Date.now()): boolean {
  const mine = readHostLeases().filter((entry) => entry.serverPid === serverPid);
  return liveHostSnapshot(mine, now).length > 0;
}

/**
 * 这个后台现在能拿来用吗：**有地址、有令牌，而且真的有人在监听**。
 *
 * 判据的核心是"连得上"，不是"记录的进程还活着"——Windows 上经 shell 启动时，
 * 租约里记的是 `cmd.exe` 外壳，它随 VS Code 崩溃一起死，而真正的 node 服务器还在服务
 * （实测：`alive=false` 但端口照常响应）。用进程判"可用性"会让崩溃遗留的后台
 * 永远无法被复用。
 *
 * 进程与端口两条取**或**：进程在就直接算可用（快路径，避免每次判定都起 PowerShell）；
 * 进程不在才去探端口（慢路径，只对"看起来可疑"的租约付这个成本）。
 */
export function isServiceable(lease: ServerLease): boolean {
  if (!lease.baseUrl || !lease.token) return false;
  if (isProcessAlive(lease.serverPid)) return true;
  return tcpReachableSync(lease.baseUrl);
}

/** 现在可以直接接入的后台（多个候选时取最新的一个）。 */
export function findAttachable(now = Date.now()): ServerLease | undefined {
  let best: ServerLease | undefined;
  for (const { lease } of readLeases()) {
    if (!isServiceable(lease)) continue;
    // 进程在、地址在，但**没有任何活着的窗口**：那是崩溃遗留（宿主全没了），
    // 不接入——交给清理链路处理，否则我们会把自己登记到一个即将被杀的进程上。
    if (!hasLiveHostFor(lease.serverPid, now)) continue;
    if (!best || lease.startedAt > best.startedAt) best = lease;
  }
  return best;
}

/** 正在启动中的租约：进程在、**还没有** baseUrl/token，且启动时间还不算太久。 */
export function findStarting(withinMs: number, now = Date.now()): ServerLease | undefined {
  for (const { lease } of readLeases()) {
    if (!isProcessAlive(lease.serverPid)) continue;
    if (isServiceable(lease)) continue;
    if (now - lease.startedAt > withinMs) continue;
    return lease;
  }
  return undefined;
}

/**
 * 这份心跳对应的实例**已经没了**吗（可以接管它的后台）。
 *
 * "时间陈旧"或"进程已不在"任一成立即可——**不能只等时间**：实测 `Get-Process` 在
 * 进程被强杀后约 300ms 就查不到它了，而心跳阈值是 30 秒；只按时间判会让"崩溃后复用"
 * 白等半分钟（用户口径是要立刻接着用）。
 *
 * 反过来也不能只看进程：正常退出走的是删心跳文件，所以"文件还在但进程没了"确实等于
 * "那个实例不在了"；而心跳陈旧则是兜底（进程表查不到时用）。
 */
function hostEntryStale(entry: HostLeaseEntry, now: number): boolean {
  if (now - entry.seenAt >= HOST_STALE_MS) return true;
  if (typeof entry.pid !== "number") return false;
  return !livePidsSync([entry.pid]).has(entry.pid);
}

/**
 * 可以**接管**的遗留后台：**从心跳文件里**找出「记录着连接信息、命令与当前配置一致、
 * 而写它的实例已经不在了」的那一个（多个时取最新的）。
 *
 * 为什么从心跳而不是租约找（实测得出）：上次 VS Code 崩溃时，服务器的 exit 处理器会把
 * 租约删掉（它随父进程一起死），磁盘上只剩心跳文件。所以"崩溃后那个还在跑的服务器怎么
 * 找回"这件事，只能靠心跳里记下的 `baseUrl`/`token`。
 *
 * **不做连通性检查**（那是调用方的事）：这里只保证"记过连接信息、命令匹配、实例已消失"，
 * 调用方要真的连一下才知道它还活着。
 */
export function findAdoptable(command: string, now = Date.now()): ServerLease | undefined {
  const candidates = readHostLeases()
    // 连接信息齐全（没有地址/令牌的心跳接不上，那是早期版本留下的）
    .filter((entry) => entry.serverPid !== undefined && entry.baseUrl && entry.token)
    .filter((entry) => entry.command === command)
    .filter((entry) => hostEntryStale(entry, now))
    .sort((left, right) => right.seenAt - left.seenAt);
  const best = candidates[0];
  if (!best?.baseUrl) return undefined;
  return {
    version: 2,
    serverPid: best.serverPid as number,
    command: best.command ?? command,
    startedAt: best.seenAt,
    baseUrl: best.baseUrl,
    token: best.token,
  };
}

/**
 * 把自己登记进某个后台的 hosts（幂等：已在则只刷心跳）。
 *
 * 顺带**清掉同一张租约里已经死掉的其它窗口**——这是刻意放在写入路径上的：
 * 崩溃窗口的记录本来就只能靠别人来收，而每个窗口每 5 秒就会走一次这里，
 * 于是「崩溃一个窗口 → 它的记录在 5 秒内被下一个窗口收掉」不需要额外机制。
 */
export function registerHost(serverPid: number, host: LeaseHost): boolean {
  const lease = readLease(serverPid);
  if (!lease) return false;
  const others = liveHosts(lease).filter((item) => item.pid !== host.pid);
  return writeLease({ ...lease, version: 2, hosts: [...others, host] });
}

/** 只刷心跳（不做清理，心跳路径要尽量便宜）。 */
export function touchHost(serverPid: number, now = Date.now()): boolean {
  const lease = readLease(serverPid);
  if (!lease) return false;
  const hosts = leaseHosts(lease);
  const mine = hosts.find((host) => host.pid === process.pid);
  if (!mine) {
    // 自己的记录被别的窗口清掉了（超过阈值没刷上）→ 补回来，否则下一轮清理
    // 会把这个后台当成「没人用」而杀掉
    return registerHost(serverPid, { pid: process.pid, workspace: lease.workspace, seenAt: now });
  }
  mine.seenAt = now;
  return writeLease({ ...lease, version: 2, hosts });
}

/** 把自己从 hosts 里摘掉（本窗口退出时）。返回摘除后的租约（没有了就是 undefined）。 */
export function removeHost(serverPid: number, now = Date.now()): ServerLease | undefined {
  const lease = readLease(serverPid);
  if (!lease) return undefined;
  const hosts = liveHosts(lease, now).filter((host) => host.pid !== process.pid);
  const next: ServerLease = { ...lease, version: 2, hosts };
  writeLease(next);
  return next;
}

/**
 * 本进程是不是**最后一个**还在用这个后台的窗口。
 *
 * 这是「什么时候该杀掉后台」的唯一判据（需求 R3/R4）：不关心谁先启动、
 * 谁是 owner——只关心还剩几个活着的窗口。
 */
export function isLastLiveHost(serverPid: number, now = Date.now()): boolean {
  const lease = readLease(serverPid);
  if (!lease) return false;
  return liveHosts(lease, now).every((host) => host.pid === process.pid);
}

/** 诊断用：当前有哪些后台、各自几个活窗口。 */
export function summarizeLeases(): {
  serverPid: number;
  command: string;
  baseUrl?: string;
  alive: boolean;
  liveHosts: number[];
}[] {
  return readLeases().map(({ lease }) => ({
    serverPid: lease.serverPid,
    command: lease.command,
    baseUrl: lease.baseUrl,
    alive: isProcessAlive(lease.serverPid),
    liveHosts: liveHosts(lease).map((host) => host.pid),
  }));
}

// ---------- 启动锁：把「扫描 → 决定起不起 → 写租约」串行化 ----------

const START_LOCK = "start.lock";

/**
 * 抢到启动锁就返回解锁函数，超时返回 undefined。
 *
 * 为什么需要它：两个窗口同时激活时都会看到「没有可用后台」，于是各起一个——
 * 需求是复用一个，所以这段「看一眼再决定」必须互斥。锁只在**决策瞬间**持有，
 * 起服务器与等就绪都在锁外（否则第二个窗口要等 30 秒才轮到自己判断）。
 *
 * 锁文件内容就是**一行 pid 文本**，与 dsh 自己的 `withFileLock` 同格式——
 * 这是刻意的：`readLockPid`（清 writer 锁时用的那个解析器）只认纯数字，
 * 写成 JSON 会让每次读取都判成"坏锁"并删掉，锁就形同虚设（实测踩过）。
 *
 * 残留锁（持有者已死 / 内容读不出 pid）会被清掉重试：与 `clearStaleDocumentLocks`
 * 同一纪律，但这里只认「进程已死」这个肯定证据，以及「超过 timeoutMs 还没人动」
 * 这个明确上界。
 */
export async function acquireStartLock(timeoutMs: number): Promise<(() => void) | undefined> {
  const path = join(LEASE_DIR, START_LOCK);
  const deadline = Date.now() + timeoutMs;
  try {
    mkdirSync(LEASE_DIR, { recursive: true });
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      // `wx` = 独占创建：抢不到会抛 EEXIST，这正是我们要的原子性
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => {
        try {
          // 只删自己那把：万一锁被别人清掉又重建，删掉别人的锁会引入新的竞态
          if (readLockPid(path) === process.pid) rmSync(path, { force: true });
        } catch {
          // 忽略
        }
      };
    } catch {
      const holder = readLockPid(path);
      if (holder === undefined || !isProcessAlive(holder)) {
        // 坏锁或持有者已死 → 残留，清掉重试
        try {
          rmSync(path, { force: true });
        } catch {
          // 忽略：下一轮再试
        }
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * 清掉**没有任何活窗口**的租约，返回清掉的数量。
 *
 * 两种情形都会走到这里：
 * - 服务器进程已经不在（租约作废，删）；
 * - 服务器还在但没有活窗口（崩溃遗留 / 所有窗口都禁用了扩展）——**删租约但不动进程**，
 *   进程留给 `reclaimOrphanServers` 按「命令行确认是 dsh」的纪律去杀。
 *
 * 刻意**不**在这里杀进程：本函数的调用方可能只是路过（另一个窗口激活），
 * 而 taskkill 要起 PowerShell（约 1.5s）且不可逆，应当只由清理链路做一次。
 */
/**
 * 清掉**已经没有进程**的租约，返回清掉的数量。
 *
 * **判据只认"进程不在"**（`isProcessAlive(serverPid)`）——这一点是硬的：租约是"这个后台
 * 存在过"的唯一证据，删早了就再也找不回它（实测踩过：刚崩溃的遗留后台被这条清理顺手
 * 删掉，于是新窗口只能重起一个，而不是接管它）。
 *
 * 进程还在、只是**暂时**没人用时（正在启动 / 崩溃遗留 / 所有窗口都禁用了扩展），
 * 一律留给 `reclaimOrphanServers` 按"确认是 dsh + 没人用 + 不在启动宽限内"去判。
 */
export function dropDeadLeases(): number {
  let dropped = 0;
  for (const { lease } of readLeases()) {
    if (isProcessAlive(lease.serverPid)) continue;
    clearLease(lease.serverPid);
    dropped++;
  }
  return dropped;
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
 * 同步探一下"这个地址上有人在监听吗"（纯 TCP 连接，**同步**，失败即 false）。
 *
 * 为什么需要它，而不是看进程：
 * Windows 上 `dsh web` 经 shell 启动，租约里记的是 `cmd.exe` 外壳 pid；VS Code 崩溃时
 * 外壳随它一起死，而真正的 node 服务器**继续活着**（实测：日志里 `alive=false`
 * 但端口仍在服务）。所以"服务器还在不在"只能问端口，不能问进程。
 *
 * 为什么是同步的：调用点在同步判定里（`isServiceable` / `isOrphanLease`），
 * 而 TCP 连接是几毫秒级；用 PowerShell 的 `TcpClient` 发起一次即可
 * （`netstat` 只能证明"有人在听"，但拿不到"连得上"的确认）。
 */
export function tcpReachableSync(baseUrl: string, timeoutMs = 1_500): boolean {
  let host: string;
  let port: number;
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return false;
  }
  if (!host || !Number.isInteger(port) || port <= 0) return false;
  if (process.platform !== "win32") {
    // 非 Windows：用 node 自己的同步 socket 探（没有 PowerShell 开销）
    return tcpReachableNode(host, port, timeoutMs);
  }
  const script =
    `$c = New-Object Net.Sockets.TcpClient; ` +
    `try { $null = $c.BeginConnect('${host}', ${port}, $null, $null); ` +
    `if ($c.Connected) { 'yes' } } catch { } finally { $c.Close() }`;
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const out = spawnSyncQuiet("pwsh.exe", args, timeoutMs + 3_000) ?? spawnSyncQuiet("powershell.exe", args, timeoutMs + 3_000);
  if (out === undefined) return tcpReachableNode(host, port, timeoutMs);
  return out.includes("yes");
}

/** 非 Windows 的同步 TCP 探测（用 net 模块 + Atomics.wait 把异步 socket 变同步）。 */
function tcpReachableNode(host: string, port: number, timeoutMs: number): boolean {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  let ok = false;
  const done = (success: boolean) => {
    ok = success;
    socket.destroy();
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0);
  };
  const socket = connect({ host, port });
  socket.setTimeout(timeoutMs);
  socket.on("connect", () => done(true));
  socket.on("error", () => done(false));
  socket.on("timeout", () => done(false));
  Atomics.wait(shared, 0, 0, timeoutMs + 500);
  return ok;
}

/** 启动宽限：宣布"正在启动"之后这么久内不算孤儿（见 `isOrphanLease`）。 */
export const STARTING_GRACE_MS = 60_000;

/** 这份租约是不是"刚宣布启动、还没打印公告行"（据此决定等它还是回收它）。 */
export function startedLongAgo(lease: ServerLease, now = Date.now()): boolean {
  return Boolean(lease.baseUrl) || now - lease.startedAt >= STARTING_GRACE_MS;
}

/**
 * 这个后台是不是"没人管了"。
 *
 * **判据是「还有没有活着的扩展实例」**，不是"当初拉起它的那个宿主还在不在"——
 * 多窗口共享之后，owner 先关、别的窗口还在用是**正常且应当继续服务**的状态
 * （需求 R3/R4）。实例是否活着由心跳文件决定（见 {@link hasLiveHostFor}）。
 */
export function isOrphanLease(lease: ServerLease, now = Date.now()): boolean {
  // 判据是"**还连得上吗**"，不是"记录的进程还在吗"：外壳 pid 会随 VS Code 崩溃而死，
  // 而服务器照常服务——那种遗留后台属于"该被复用"，不是孤儿。
  if (isServiceable(lease)) return false;
  if (hasLiveHostFor(lease.serverPid, now)) return false;
  // **正在启动中的不算孤儿**：另一个窗口刚写下租约、还没等到 dsh 打印公告行的那几秒里
  // 它没有心跳文件（心跳是就绪后才写的），此时判成孤儿并杀掉会让对方启动失败。
  // 判据取"还没有 baseUrl 且宣布时间还新"；超过宽限的属于不正常的启动，可以回收。
  if (!lease.baseUrl && now - lease.startedAt < STARTING_GRACE_MS) return false;
  // 进程还在、但连不上、也没人用：属于"死了的空壳"，可以回收
  return true;
}

/** 租约里的端口（从 baseUrl 取；取不到返回 undefined）。 */
export function leasePort(lease: ServerLease): number | undefined {
  if (!lease.baseUrl) return undefined;
  try {
    const port = Number(new URL(lease.baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析 `netstat -ano` 里监听某端口的 pid。
 *
 * 为什么需要它：`dsh web` 在 Windows 上是**经 shell 起的**，我们拿到并写进租约的 pid
 * 是 `cmd.exe` 外壳；真正的服务器是它的 node 子进程。外壳一旦先死（父进程被强杀等），
 * 对着那个 pid 调 `taskkill` 只会得到"找不到进程"，而 node 变成孤儿继续占着端口
 * ——"最后一个窗口退出要彻底清理"就会失败（实测就是这样）。
 * 所以杀掉之前先按端口把真正在监听的 pid 找出来。
 *
 * 导出以便离线断言（这是最容易写错的一段）。
 */
export function parseListeningPids(stdout: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // 形如：TCP  127.0.0.1:3080  0.0.0.0:0  LISTENING  12345
    if (!parts.some((part) => part.endsWith(`:${port}`))) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return [...new Set(pids)];
}

/** 谁在监听这个端口（起 netstat；拿不到返回空数组）。窗口退出路径请用同步版。 */
export async function listeningPids(port: number): Promise<number[]> {
  const outcome = await execCapture("netstat", ["-ano", "-p", "TCP"], {
    timeoutMs: 20_000,
    maxBytes: 8 * 1024 * 1024,
  });
  if (outcome.code !== 0) return [];
  return parseListeningPids(outcome.stdout, port);
}

/**
 * 杀掉一个由本扩展启动的后台：**先按记录的 pid，再按端口兜底**。
 *
 * 两条都做是刻意的：pid 那条在正常情况下最快（`taskkill /T` 一次带走整棵树，
 * 连 cmd 外壳的孙进程一起）；端口兜底负责"外壳已死、node 成孤儿"的情形——不兜底
 * 就会留下一个用户看不见、却占着端口和内存的 dsh（用户明确要求彻底清理）。
 *
 * **这个函数刻意是同步的**（只做"发起"）：调用点在窗口退出/扩展停用路径上，
 * 那种场合**不能依赖"本进程还能活多久"**——实测踩过：调用方在 dispose 之后立刻
 * `process.exit`，异步清理被掐断，taskkill 根本没发出去。同步发起 + `unref` 的
 * 子进程让清理与调用方生命周期解耦。
 *
 * @returns 已成功执行 taskkill 的 pid 列表（诊断用）。
 */
export function killLeasedServer(lease: ServerLease, log: (line: string) => void): number[] {
  const targets = new Set<number>();
  if (isProcessAlive(lease.serverPid)) targets.add(lease.serverPid);
  const port = leasePort(lease);
  if (port !== undefined) {
    const owners = parseListeningPidsSync(port);
    if (owners.length) {
      log(`[cleanup] 端口 ${port} 的监听者：${owners.join(",")}（记录的 pid=${lease.serverPid}）`);
      for (const pid of owners) targets.add(pid);
    }
  }
  const sent: number[] = [];
  for (const pid of targets) {
    // 台账：每一次动手都留痕。排查"服务器被谁杀了"时，这是唯一能给出答案的地方
    // （进程被杀之后没有任何界面能事后追查），排障成本很高，所以保留成常驻能力。
    ledger(`kill pid=${pid} 记录 pid=${lease.serverPid} 端口=${port ?? "?"} 触发方=${new Error().stack?.split("\n")[2]?.trim() ?? "?"}`);
    if (spawnTaskkillSync(pid)) sent.push(pid);
    else log(`[cleanup] 对 pid=${pid} 的 taskkill 未成功（进程可能已退出）`);
  }
  if (sent.length === 0) {
    log(`[cleanup] pid=${lease.serverPid} 与端口 ${port ?? "?"} 都已无进程可杀，仅清理租约`);
  }
  clearLease(lease.serverPid);
  return sent;
}

/**
 * **异步版**：发起清理并等端口真正关闭（最多 `timeoutMs`）。
 *
 * 用在"有人在等结果"的场合（下一次激活的残留回收、诊断命令），那里进程生命周期还长，
 * 可以等出确定结论；窗口退出路径用同步版（见 `killLeasedServer` 的说明）。
 */
export async function killLeasedServerAndWait(
  lease: ServerLease,
  log: (line: string) => void,
  timeoutMs = 60_000,
): Promise<boolean> {
  const port = leasePort(lease);
  killLeasedServer(lease, log);
  if (port === undefined) return true; // 没有端口可确认，已尽力
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!parseListeningPidsSync(port).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * 发起一次 `taskkill /T /F`（Windows）/ SIGTERM（其它平台）并**等它执行完**。
 *
 * 为什么必须等（实测两次踩坑）：
 * - `spawn` + `unref` 不够——调用方随后 `process.exit`，Windows 会把还没跑完的
 *   `taskkill` 一起带走，进程纹丝不动（日志里能看到"已发起"，但 pid 依然活着）；
 * - 于是这里用 `spawnSync`：`taskkill` 本地执行只要几十毫秒，这点阻塞换的是
 *   **确定性**——窗口退出路径上"确定杀掉"比"不阻塞"重要得多。
 *
 * @returns 是否执行成功（退出码 0）。
 */
/**
 * 杀进程台账：把每一次"动手杀后台"记到 `<租约目录上一级>/kill-ledger.log`。
 *
 * 为什么常驻保留：进程被杀之后**没有任何界面能事后追查**——排查"我的 dsh 被谁杀了"
 * 时，这是唯一能给出答案的地方（本轮就靠它定位过一次）。写入失败一律忽略，
 * 绝不影响杀进程本身。
 */
function ledger(line: string): void {
  try {
    appendFileSync(join(LEASE_DIR, "..", "kill-ledger.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // 忽略
  }
}

/** 杀掉整棵进程树。 */
function spawnTaskkillSync(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    timeout: 15_000,
    encoding: "utf8",
  });
  return !result.error && result.status === 0;
}

/**
 * 同步查"谁在监听这个端口"。
 *
 * `netstat` 是系统自带的小工具，实测耗时约 10~30ms；这条路径只在"要杀后台"时走，
 * 且必须同步（见 `killLeasedServer`）。失败/超时返回空数组 = 没人监听。
 */
export function parseListeningPidsSync(port: number): number[] {
  const outcome = spawnSyncQuiet("netstat", ["-ano", "-p", "TCP"], 10_000);
  if (!outcome) return [];
  return parseListeningPids(outcome, port);
}

/**
 * 同步跑一条命令并返回 stdout（失败返回 undefined）。
 *
 * 用 `spawnSync` 在这里是可接受的：`netstat -ano -p TCP` 全量输出在几千行量级，
 * 实测 10~30ms，而且**只在窗口退出/清理路径**上跑一次。相比之下，把清理做成异步
 * 已经被证明更危险（调用方 exit 会把清理掐断）。
 */
function spawnSyncQuiet(command: string, args: string[], timeoutMs: number): string | undefined {
  const result = spawnSync(command, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return result.stdout;
}

/**
 * 回收**孤儿后台**：服务器还活着，但已经没有任何活着的 VS Code 窗口在用它。
 *
 * 这就是"扩展被禁用/所有窗口关闭/VS Code 崩溃"之后真正的清理动作。它在**下一次激活**
 * 时执行（那一刻才有人能动手），因此是"最终一致"而不是"即时"——没有进程在运行时，
 * 任何即时清理都是不可能的（这一点无法绕过，属于机制边界）。
 *
 * **`shouldKeep` 是"先别杀，我打算接管它"的口子**（用户口径：崩溃遗留的后台应当被复用，
 * 而不是杀掉重起）。判定由调用方给（它知道当前配置与"这个后台还能连上吗"），
 * 返回 true 的租约只跳过、不清理。
 *
 * 判据与 `isKillable` 同纪律：**只有确认命令行里是 dsh 才动手**；拿不到命令行时
 * 只清租约、不杀进程。
 */
export async function reclaimOrphanServers(
  log: (line: string) => void,
  shouldKeep?: (lease: ServerLease) => Promise<boolean>,
): Promise<number[]> {
  const killed: number[] = [];
  for (const { lease } of readLeases()) {
    if (!isOrphanLease(lease)) {
      if (isProcessAlive(lease.serverPid)) continue;
      // 进程已不在：可能还留着一个孤儿 node 在听端口，先按端口兜一次，再作废租约
      await killLeasedServerAndWait(lease, log, 20_000);
      continue;
    }
    if (shouldKeep && (await shouldKeep(lease))) {
      log(`[cleanup] 保留 pid=${lease.serverPid}（${lease.baseUrl}）：准备接管它，不重起`);
      continue;
    }
    // 三态确认（沿用既有纪律）：只有 true 才允许动手
    const lines = await commandLinesFor([lease.serverPid]);
    const command = lines?.get(lease.serverPid);
    // 外壳已死时命令行查不到是常态；那种情况靠端口兜底（见 killLeasedServer），
    // 而端口监听者能被端口证明"是本扩展那个后台"（租约里有它的 baseUrl）
    const confirmed = command === undefined ? true : /\bdsh\b/i.test(command);
    if (!confirmed) {
      log(`[cleanup] pid=${lease.serverPid} 的命令行里没有 dsh，只清租约不动进程`);
      clearLease(lease.serverPid);
      continue;
    }
    log(`[cleanup] 回收孤儿后台 pid=${lease.serverPid}（${lease.baseUrl ?? "尚未就绪"}）`);
    const gone = await killLeasedServerAndWait(lease, log);
    if (gone) killed.push(lease.serverPid);
    else log(`[cleanup] pid=${lease.serverPid} 的端口在等待窗口内仍未关闭`);
  }
  return killed;
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
    const heldByLiveHost = hasLiveHostFor(lease.serverPid);
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
 * 实际动手交给 {@link killLeasedServer}：它先按记录的 pid 杀，**再按端口兜底**
 * （外壳已死、node 成孤儿的情形只有端口这条路能杀掉）。
 *
 * 异步：中间的进程查询与 taskkill 都要起子进程，await 期间扩展宿主仍能响应。
 */
export async function cleanupResidualServers(log: (line: string) => void): Promise<CleanupResult> {
  const result: CleanupResult = { scanned: 0, orphans: [], killed: [], skipped: [] };
  for (const item of await scanServers()) {
    result.scanned++;
    const pid = item.lease.serverPid;
    if (!isProcessAlive(pid)) {
      // 进程已退出：可能还留着一个孤儿 node 在听端口，先按端口兜一次，再作废租约
      await killLeasedServerAndWait(item.lease, log, 20_000);
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
    const gone = await killLeasedServerAndWait(item.lease, log);
    if (gone) {
      log(`[cleanup] 已清理残留 dsh 进程 pid=${pid}${item.lease.baseUrl ? ` (${item.lease.baseUrl})` : ""}`);
      result.killed.push(pid);
    } else {
      log(`[cleanup] 清理 pid=${pid} 后端口仍在监听`);
      result.skipped.push(pid);
    }
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
