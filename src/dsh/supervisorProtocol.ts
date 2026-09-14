/**
 * supervisor 的**会合协议**：状态文件、启动锁、socket 寻址。纯文件与纯函数，可离线断言。
 *
 * 设计见 `docs/design-supervisor.md` §3.0/§3.2。要点：
 * - **高频信号走 socket**（谁在用、控制请求），文件只放"跨世代会合信息"
 *   （`baseUrl`/`token`/`supervisorPid`/命令）——新窗口在 supervisor 未起或刚崩时必须读得到；
 * - 文件一律**原子写**（同目录临时文件 + rename）：读到半个 JSON 会让"有没有可用的后台"
 *   这种判断直接跑偏，而它跑偏的后果是多起一个后台、抢端口、会话全丢；
 * - 读一律**宽容**：缺字段/坏 JSON 当"没有"，不让一个坏文件把整条链路拖死。
 *
 * 目录布局（`<根>/<配置指纹>/`）：
 * ```
 *   supervisor.json   会合信息（supervisor 写、扩展只读）
 *   supervisor.lock   启动锁（抢"启动 supervisor"这一个动作）
 *   supervisor.log    supervisor 与 dsh 的输出（进程没了之后的唯一线索）
 *   sup.sock          socket（Windows 上是命名管道路径 \\.\pipe\…）
 * ```
 * `<根>` 默认 `~/.dsh-chat/supervisors`；`DSH_CHAT_SUPERVISOR_DIR` 可整体改掉
 * （探针与断言用：起真实 dsh 时绝不能和用户那套混在一起）。
 */
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 会合文件格式版本。字段不兼容时整份当"没有"。 */
export const STATE_VERSION = 1;

/** 状态文件里的一份"当前后台"。所有字段都可能是 undefined（宽容读取）。 */
export interface SupervisorState {
  version: number;
  /** supervisor 进程 pid。 */
  supervisorPid: number;
  /** supervisor 的启动时刻（epoch ms）：与 pid 一起构成"世代"，用来识别"换了新的一套"。 */
  startedAt: number;
  /** dsh 子进程 pid（Windows 上通常是要经 shell 启动的外壳 pid）。 */
  serverPid?: number;
  /** dsh 就绪后的地址（`http://127.0.0.1:<port>`）。 */
  baseUrl?: string;
  /** 启动令牌：扩展拿它换绑定 authority 的 cookie。 */
  token?: string;
  /** 启动命令（原样来自 `dshChat.command`，诊断与重启时复用）。 */
  command: string;
  /** 期望的空闲阈值（秒）：扩展写入、supervisor 热读。 */
  idleSec: number;
  /** socket 地址（Windows 的命名管道路径 / 其它平台的 AF_UNIX 路径）。 */
  socket: string;
  /** dsh 就绪时刻（未就绪时缺省）。 */
  serverStartedAt?: number;
  /** true = 正在拉起 dsh（扩展据此等待，而不是自己起一个）。 */
  starting: boolean;
  /** 运行时自述（排查用：supervisor 崩了之后这是唯一线索之一）。 */
  runtime?: { execPath: string; node: string; electron?: string };
}

/** 一份"当前后台"的世代标识：pid + 启动时刻。两者任一变化 = 换了新的一套。 */
export function generationOf(state: Pick<SupervisorState, "supervisorPid" | "startedAt">): string {
  return `${state.supervisorPid}@${state.startedAt}`;
}

/** 空闲阈值的允许范围（秒）：下限 5 是因为窗口重载的空档实测就有 2~5 秒。 */
export const IDLE_SEC_MIN = 5;
export const IDLE_SEC_MAX = 600;
/** 空闲阈值默认值（秒）。用户 2026-09-13 定：默认 10、可配。 */
export const IDLE_SEC_DEFAULT = 10;
/** socket 上的保活间隔（毫秒）。 */
export const PING_INTERVAL_MS = 1_000;
/** supervisor 等 dsh 打印公告行的宽限（毫秒）——**supervisor 自己的**一轮尝试上限，与扩展侧无关
 *  （扩展侧已经没有"等多久算超时"这一档了，见 `supervisorClient.waitForReadyState`）。 */
export const SPAWN_GRACE_MS = 120_000;

/** 把用户填的阈值夹到合法范围（NaN/越界都收敛，不报错：配置项不该让扩展用不了）。 */
export function clampIdleSec(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return IDLE_SEC_DEFAULT;
  return Math.min(IDLE_SEC_MAX, Math.max(IDLE_SEC_MIN, Math.round(n)));
}

/** 会合根目录（`DSH_CHAT_SUPERVISOR_DIR` 可覆盖）。 */
export function supervisorRoot(): string {
  const configured = process.env.DSH_CHAT_SUPERVISOR_DIR?.trim();
  return configured ? configured : join(homedir(), ".dsh-chat", "supervisors");
}

/** 某个配置分组的目录。 */
export function supervisorDirectory(group: string): string {
  const safe = group.trim().replace(/[^\w.-]/g, "_") || "default";
  return join(supervisorRoot(), safe);
}

/** 会合文件路径。 */
export function stateFileIn(directory: string): string {
  return join(directory, "supervisor.json");
}

/** 启动锁路径。 */
export function lockFileIn(directory: string): string {
  return join(directory, "supervisor.lock");
}

/** supervisor 与 dsh 的输出。 */
export function logFileIn(directory: string): string {
  return join(directory, "supervisor.log");
}

/**
 * socket 地址。
 *
 * - Windows：命名管道 `\\.\pipe\dsh-chat-<分组>`（AF_UNIX 路径在 Windows 上也有长度限制，
 *   管道名更稳；Node 的 `net` 在 win32 上对 `\\.\pipe\` 是原生支持）；
 * - 其它平台：`<目录>/sup.sock`，注意 AF_UNIX 路径长度上限（约 100 字节），
 *   所以目录短、文件名短——分组名已做过文件系统安全过滤。
 */
export function socketPathIn(directory: string, group: string): string {
  if (process.platform === "win32") {
    const safe = group.trim().replace(/[^\w.-]/g, "_") || "default";
    return `\\\\.\\pipe\\dsh-chat-${safe}`;
  }
  return join(directory, "sup.sock");
}

/**
 * 原子写一份文本文件：同目录临时文件 + rename。
 *
 * 为什么必须原子：读方在"另一个进程正在写"时可能读到半个 JSON，而它据此决定
 * "有没有可用的后台"——读崩的后果是多起一个后台并抢端口。rename 在同一文件系统内是原子的。
 */
export function writeFileAtomic(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(temp, text, "utf8");
  renameSync(temp, path);
}

/** 原子写会合文件（内容由调用方给全，避免"读-改-写"丢字段）。 */
export function writeState(directory: string, state: SupervisorState): boolean {
  try {
    writeFileAtomic(stateFileIn(directory), JSON.stringify(state));
    return true;
  } catch {
    // 写不进去：supervisor 侧只能记日志后继续（后续轮次会重试）；扩展侧不该因此崩
    return false;
  }
}

/**
 * 读会合文件。**宽容**：文件不在、JSON 坏、版本不认识、关键字段缺失 → `undefined`。
 *
 * `command`/`idleSec`/`socket` 三个字段缺失时按"这份状态不可用"处理（它们参与决策）；
 * 其余字段（`serverPid`/`baseUrl`/`token`/`runtime`）缺失只是"还没就绪"。
 */
export function readState(directory: string): SupervisorState | undefined {
  let raw: string;
  try {
    raw = readFileSync(stateFileIn(directory), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.version !== STATE_VERSION) return undefined;
  const supervisorPid = typeof value.supervisorPid === "number" ? value.supervisorPid : undefined;
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const socket = typeof value.socket === "string" ? value.socket : undefined;
  if (supervisorPid === undefined || startedAt === undefined || !command || !socket) return undefined;
  const runtime = value.runtime as Record<string, unknown> | undefined;
  return {
    version: STATE_VERSION,
    supervisorPid,
    startedAt,
    serverPid: typeof value.serverPid === "number" ? value.serverPid : undefined,
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl ? value.baseUrl : undefined,
    token: typeof value.token === "string" && value.token ? value.token : undefined,
    command,
    idleSec: clampIdleSec(value.idleSec),
    socket,
    serverStartedAt: typeof value.serverStartedAt === "number" ? value.serverStartedAt : undefined,
    starting: value.starting === true,
    runtime:
      runtime && typeof runtime.execPath === "string" && typeof runtime.node === "string"
        ? {
            execPath: runtime.execPath,
            node: runtime.node,
            electron: typeof runtime.electron === "string" ? runtime.electron : undefined,
          }
        : undefined,
  };
}

/** 删掉会合文件（supervisor 收尾时）。 */
export function clearState(directory: string): void {
  try {
    rmSync(stateFileIn(directory), { force: true });
  } catch {
    // 忽略
  }
}

/**
 * 抢启动锁：写临时文件，然后**硬链接到锁文件**——链接已存在则抛错，这就是"没抢到"。
 *
 * 为什么不用 rename（本仓库踩过的坑，2026-09-13 断言当场抓到）：`fs.renameSync` 在
 * **Windows 上是覆盖语义**（POSIX 也是），目标已存在照样成功 —— 用它做锁，第二个窗口
 * 会"抢到"同一把锁，于是两个窗口同时去起 supervisor。`linkSync` 则在目标存在时**必然失败**，
 * 且同样是原子操作。临时文件与锁文件是两个名字，半成品不会冒充锁。
 *
 * @returns 抢到返回 true；已有人持有返回 false（其它错误也按"没抢到"处理，宁可不启也不双启）。
 */
export function acquireStartLock(directory: string): boolean {
  const lockPath = lockFileIn(directory);
  const temp = `${lockPath}.acquire-${process.pid}`;
  try {
    mkdirSync(directory, { recursive: true });
    rmSync(temp, { force: true });
    writeFileSync(temp, `${process.pid} ${Date.now()}`, "utf8");
    linkSync(temp, lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 忽略
    }
  }
}

/** 锁的持有者 pid（读不到返回 undefined）。 */
export function lockHolder(directory: string): number | undefined {
  try {
    const text = readFileSync(lockFileIn(directory), "utf8");
    const pid = Number(text.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** 释放锁（只删自己持有的那把：持有者不是自己时不动手）。 */
export function releaseStartLock(directory: string): void {
  if (lockHolder(directory) !== process.pid) return;
  try {
    rmSync(lockFileIn(directory), { force: true });
  } catch {
    // 忽略
  }
}

/**
 * 清掉**已经无效**的锁（持有者进程不在了）。
 *
 * `alive` 由调用方注入（宿主里是异步的进程表查询；断言里可以给假的）：
 * 拿不到证据时**不动手**——这是本仓库的既有纪律（见 `isKillable` 的教训）。
 */
export function dropStaleStartLock(directory: string, alive: (pid: number) => boolean): boolean {
  const holder = lockHolder(directory);
  if (holder === undefined) {
    try {
      rmSync(lockFileIn(directory), { force: true });
      return true;
    } catch {
      return false;
    }
  }
  if (alive(holder)) return false;
  try {
    rmSync(lockFileIn(directory), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** socket 节点是否还在磁盘上（Windows 命名管道没有对应文件，恒为 false）。 */
export function socketNodeExists(socket: string): boolean {
  if (process.platform === "win32") return false;
  return existsSync(socket);
}

/** 删掉 socket 节点（只在确认没人监听后调用；Windows 上无操作）。 */
export function removeSocketNode(socket: string): void {
  if (process.platform === "win32") return;
  try {
    rmSync(socket, { force: true });
  } catch {
    // 忽略
  }
}

/**
 * 以 `wx` 独占方式创建并立即关闭一个文件——给"标记/凭证"类小文件用。
 *
 * 单独抽出来是因为它必须在**同一次调用**里完成"创建并关闭"，
 * 否则 Windows 上句柄泄漏会让后续删除失败。
 */
export function createExclusive(path: string, text: string): boolean {
  let fd: number | undefined;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    fd = openSync(path, "wx");
    writeFileSync(fd, text, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略
      }
    }
  }
}
