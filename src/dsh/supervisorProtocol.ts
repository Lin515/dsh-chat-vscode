/**
 * supervisor 的**会合协议**：状态文件、启动锁、socket 寻址。纯文件与纯函数，可离线断言。
 *
 * 设计见 `docs/design-supervisor.md`「传输层」与「磁盘协议」。要点：
 * - **高频信号走 socket**（谁在用、控制请求），文件只放"跨世代会合信息"
 *   （`baseUrl`/`token`/`supervisorPid`/命令）——新窗口在 supervisor 未起或刚崩时必须读得到；
 * - 文件一律**原子写**（同目录临时文件 + rename）：读到半个 JSON 会让"有没有可用的后台"
 *   这种判断直接跑偏，而它跑偏的后果是多起一个后台、抢端口、会话全丢；
 * - 读一律**宽容**：缺字段/坏 JSON 当"没有"，不让一个坏文件把整条链路拖死。
 *
 * 目录布局（`<根>/<配置指纹>/`，四处路径由 `rendezvousPaths()` **唯一产出**）：
 * ```
 *   supervisor.json   会合信息（supervisor 写、扩展只读）
 *   supervisor.lock   启动锁（抢"启动 supervisor"这一个动作）
 *   supervisor.log    supervisor 与 dsh 的输出（进程没了之后的唯一线索）
 *   sup.sock          socket（Windows 上是命名管道路径 \\.\pipe\…）
 * ```
 * `<根>` 默认 `<DSH_HOME>/dsh-chat-vscode/supervisors`（`DSH_HOME` 缺省 `~/.dsh`）；
 * `DSH_CHAT_SUPERVISOR_DIR` 可整体改掉
 * （探针与断言用：起真实 dsh 时绝不能和用户那套混在一起）。
 *
 * **状态解码也只有一份**（`decodeState`）：文件路（`readState`）与管道路
 * （`supervisorWire`）共用同一套逐字段校验，差异只剩"版本要不要严格"与"缺 idleSec 用什么"
 * 两个显式参数——见 `DecodeStateOptions`。
 *
 * **Windows 上隔离必须连管道名一起隔离**：目录算出来的只是文件位置，socket 却是
 * `\\.\pipe\…` 这个**全局命名空间**里的名字——只看分组的话，隔离目录里的探针会和
 * 用户正在用的那套撞名（见 `socketPathIn` 的 `isolatedScope`）。
 */
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { dshHome } from "./dshLocks";

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

/** 默认会合根目录（`supervisorRoot` 的缺省值）：扩展数据统一放在 DSH 家目录下
 * （`$DSH_HOME/dsh-chat-vscode/`，缺省 `~/.dsh/dsh-chat-vscode/`，2026-09-16 起）。 */
function defaultSupervisorRoot(): string {
  return join(dshHome(), "dsh-chat-vscode", "supervisors");
}

/** 会合根目录（`DSH_CHAT_SUPERVISOR_DIR` 可覆盖）。 */
export function supervisorRoot(): string {
  const configured = process.env.DSH_CHAT_SUPERVISOR_DIR?.trim();
  return configured ? configured : defaultSupervisorRoot();
}

/**
 * 某个配置分组的目录。
 *
 * 分组名在生产里是 `groupForConfig` 算出的 12 位十六进制（见 `supervisorManager`），
 * 但它是**参数**，探针与手工启动也能传：过滤掉路径分隔符之后仍要挡住「只由点组成」
 * 的段（`..` 会让 `join` 直接跳出状态根目录），所以这里显式拦一道。
 */
export function supervisorDirectory(group: string): string {
  const safe = filterGroupName(group);
  return join(supervisorRoot(), safe);
}

/** 分组名 → 安全的**单层目录名**（空/全是点/含分隔符都收敛成 `default`）。 */
function filterGroupName(group: string): string {
  const cleaned = group.trim().replace(/[^\w.-]/g, "_");
  if (!cleaned || /^\.+$/.test(cleaned)) return "default";
  return cleaned;
}

/**
 * 会合目录里的**四个路径**——一份会合只有**一个形状**（`rendezvousPaths` 是唯一产出）。
 *
 * 为什么要有它：从前"会合文件叫什么、锁叫什么、socket 在哪"散在好几处，最险的那一处是
 * 启动器**切目录字符串**把分组名反推回来再算 socket（`supervisorRunner`）。两处算法一旦
 * 漂移，扩展就会连到一个没人监听的地址上——而且症状是"后台明明起了却连不上"，极难定位。
 * 现在所有需要路径的地方都问这一个函数，分组只从**目录**派生（见 `socketPathIn`）。
 */
export interface RendezvousPaths {
  /** 会合目录本身（`<根>/<分组>`）。 */
  directory: string;
  /** 会合信息（supervisor 原子写、扩展只读）。 */
  state: string;
  /** 启动锁（只保护"启动 supervisor"这一个动作）。 */
  lock: string;
  /** supervisor 与 dsh 的输出（进程没了之后的唯一线索）。 */
  log: string;
  /** socket（Windows 命名管道 / 其它平台 AF_UNIX 路径）。 */
  socket: string;
}

/** 一个会合目录下的全部路径（**唯一产出**，见 `RendezvousPaths`）。 */
export function rendezvousPaths(directory: string): RendezvousPaths {
  return {
    directory,
    state: join(directory, "supervisor.json"),
    lock: join(directory, "supervisor.lock"),
    log: join(directory, "supervisor.log"),
    socket: socketPathIn(directory),
  };
}

/** 会合文件路径。 */
export function stateFileIn(directory: string): string {
  return rendezvousPaths(directory).state;
}

/** 启动锁路径。 */
export function lockFileIn(directory: string): string {
  return rendezvousPaths(directory).lock;
}

/** supervisor 与 dsh 的输出。 */
export function logFileIn(directory: string): string {
  return rendezvousPaths(directory).log;
}

/**
 * socket 地址。**分组名由目录派生**（目录的最后一段），不再接受调用方传分组。
 *
 * 为什么（2026-09-19 收敛）：socket 名必须与"目录"一一对应——它是这套后台的**唯一地址**。
 * 只要允许调用方另外传一个分组，就会出现"同一个目录、两个名字"的可能：以前
 * `supervisorRunner` 就是从目录里**切字符串**把分组反推回来再算一遍（它自己的注释都写着
 * "两处算法一旦漂移，扩展会连到一个没人监听的地址上"）。现在目录就是分组，
 * 分组只由 `supervisorDirectory()` 算一次。
 *
 * `group` 参数**只为断言与手工排查保留**（不传时取目录最后一段）：生产调用一律不传。
 *
 * - Windows：命名管道 `\\.\pipe\dsh-chat-<分组>`（AF_UNIX 路径在 Windows 上也有长度限制，
 *   管道名更稳；Node 的 `net` 在 win32 上对 `\\.\pipe\` 是原生支持）；
 * - 其它平台：`<目录>/sup.sock`，注意 AF_UNIX 路径长度上限（约 100 字节），
 *   所以目录短、文件名短——分组名已做过文件系统安全过滤。
 *
 * **Windows 还要把「隔离目录」算进管道名**（`isolatedScope`）：管道名活在**全局命名
 * 空间**里，只看分组的话，探针那套（`DSH_CHAT_SUPERVISOR_DIR` 指到临时目录）会和用户
 * 正在用的那套撞名——探针的 supervisor 一起来就 `EADDRINUSE` 退出、被无限重起，
 * `npm run smoke` 就是这么卡住的（2026-09-15 实测）。Unix 侧不需要这一手：
 * socket 本来就在隔离目录里。
 */
export function socketPathIn(directory: string, group?: string): string {
  if (process.platform === "win32") {
    const safe = filterGroupName(group ?? basename(directory));
    return `\\\\.\\pipe\\dsh-chat-${safe}${isolatedScope(directory)}`;
  }
  return join(directory, "sup.sock");
}

/**
 * 管道名的隔离后缀：**只有目录不是默认会合根时**才加，生产返回空串
 * （默认路径算出来的管道名与从前**逐字节相同**）。
 *
 * 为什么按「目录是不是默认那个」判、而不是看 `DSH_CHAT_SUPERVISOR_DIR` 设没设：
 * 管道名要由参与的双方各自算出来还得一致（扩展拉起 supervisor 时传 `--directory`，
 * 两边拿的是同一个目录），而"目录是不是默认那个"是它们都看得到的**纯函数**——
 * 有人手工起 supervisor 只给 `--directory` 时也能对上号。后缀取目录的哈希，
 * 于是不同临时目录之间不会互相撞（这正是隔离要的效果）。
 */
function isolatedScope(directory: string): string {
  // `directory` 是 `<根>/<分组>`（见 `supervisorDirectory`），所以「是不是默认那套」
  // 看的是它的**父目录**——拿完整目录去比根目录永远不会相等，那会让生产也带上后缀。
  if (canonicalPath(dirname(directory)) === canonicalPath(defaultSupervisorRoot())) return "";
  return `-${createHash("sha256").update(canonicalPath(directory)).digest("hex").slice(0, 8)}`;
}

/**
 * 路径的规范形式：去掉结尾分隔符；Windows 上再折叠大小写。
 *
 * 两侧（扩展与 supervisor）本来是同一个字符串，用不着规范化；这里做是因为哈希一旦
 * 吃进"大小写不同 / 多个尾斜杠"的写法差异，同一个目录就会算出两个管道名——
 * 那是"两个后台"级别的故障，代价远大于这一行。
 */
function canonicalPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * 原子写一份文本文件：同目录临时文件 + rename。
 *
 * 为什么必须原子：读方在"另一个进程正在写"时可能读到半个 JSON，而它据此决定
 * "有没有可用的后台"——读崩的后果是多起一个后台并抢端口。rename 在同一文件系统内是原子的。
 *
 * **权限**：会合文件里有**启动令牌**（`token` 字段，服务端每次启动随机生成）。
 * 令牌 = 换会话 cookie 的凭据，所以文件按 `0o600`、目录按 `0o700` 创建——多用户
 * 主机上同机其它账号不该读得到（Windows 上用户 profile 的 ACL 本来就挡住了，
 * `mode` 在那边是空操作）。
 */
export function writeFileAtomic(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  mkdirSync(join(path, ".."), { recursive: true, mode: PRIVATE_DIR_MODE });
  writeFileSync(temp, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  renameSync(temp, path);
}

/** 私有目录/文件权限（POSIX；Windows 忽略）。 */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
export { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE };

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
 * 解码一份 `SupervisorState` 的**唯一实现**（文件路与管道路都走它）。
 *
 * ## 为什么必须只有一份
 *
 * 同一份 `SupervisorState` 从前被解码三遍：文件路（`readState`）、管道路
 * （`supervisorWire.checkState`）、写侧（`supervisor/main.ts` 的 `stateOf`），
 * 而且**宽容规则互不一致**——例如文件路要求 `version === STATE_VERSION`、管道路缺省成 1；
 * 文件路把 `idleSec` 收敛到 5~600、管道路缺省成 0。三处各写一份字段表的代价不是啰嗦，
 * 而是**改一处忘两处**：加一个字段时只有一处认得它，另一条路静默丢掉。
 *
 * ## 安全边界（`docs/design-supervisor.md`「传输层」，2026-09-17 审计立的纪律）
 *
 * 管道路推来的 `baseUrl`/`token` 决定**凭据发往哪个 origin**，所以这份解码**只许收紧**：
 * `baseUrl` 必须是 http(s) 且能解析、`token` 必须是字符串、pid 与时刻必须是整数。
 * 这些逐字段校验一条都不能放宽（`scripts/supervisorProtocol.test.ts` 第 3.5 组逐条钉住）。
 * 文件路是同机同用户的另一个进程写的，风险面小，但同样按这套严格规则解——
 * 两条路**共用同一份严格性**，差异只允许出现在'哪些字段必须有'与'缺省值取什么'上。
 *
 * ## 两条路的差异（显式参数化，不各写一遍字段表）
 *
 * | | 文件路 `readState` | 管道路 `supervisorWire` |
 * |---|---|---|
 * | `version` | 必须 `=== STATE_VERSION`（`requireVersion`）——文件可能是一个旧世代留下的，字段语义已经变了，整份当"没有"才不会拿旧字段当新字段用 | 缺省成 `1`：协议对面可能是旧守护进程，`state` 帧里没写版本。**读不懂就忽略**是协议纪律，但状态本身要照收（否则旧守护进程推来的状态全被丢掉，"连不上、要手动清理"那种症状） |
 * | `command`/`socket` | 必须有：两者都参与决策（重启时复用命令、连接时用 socket） | 必须有：socket 是"连哪一个守护进程"的唯一地址；`command` 只用于诊断 |
 * | `idleSec` 缺失 | `clampIdleSec(undefined)` → 默认 10 | `0`：守护进程每次推状态都带 `idleSec`，缺了说明对面是**不做空闲判定**的老形态/异常形态，用 0 表示"没有可用的阈值"而不是替它编一个默认值 | *
 * `runtime`/`serverStartedAt`/`serverPid`/`baseUrl`/`token` 缺失都只是"还没就绪"或"没这个信息"，
 * 一律保留为 `undefined`，**不因为缺它们丢掉整份状态**（扩展要靠这份状态等待后台就绪）。
 */
export interface DecodeStateOptions {
  /** 要求 `version` 严格等于这个值（文件路用 `STATE_VERSION`）；省略则不校验版本。 */
  requireVersion?: number;
  /** `idleSec` 缺失时用它（**不再夹范围**，见下）；省略时交给 `clampIdleSec` 收敛到默认值。 */
  idleSecWhenMissing?: number;
}

export function decodeState(value: unknown, options: DecodeStateOptions = {}): SupervisorState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (options.requireVersion !== undefined && raw.version !== options.requireVersion) return undefined;

  // pid 与时刻必须**是整数**（`Number.isInteger` 而不只是 `typeof number`）：
  // 它们是"世代"与进程判活的输入（`generationOf` / `isProcessAlive`），
  // 一个 `12.5` 或 `NaN` 会让后面的判断全都不可信。
  const supervisorPid = raw.supervisorPid;
  if (typeof supervisorPid !== "number" || !Number.isInteger(supervisorPid) || supervisorPid <= 0) return undefined;
  const startedAt = raw.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;

  // `command`/`socket` 参与决策（重启复用命令、连接用 socket），必须是非空字符串
  const command = nonEmptyString(raw.command);
  if (!command) return undefined;
  const socket = nonEmptyString(raw.socket);
  if (!socket) return undefined;

  // `baseUrl` 是**安全边界**：它决定令牌与 cookie 发往哪个 origin，必须是 http(s)
  const baseUrl = nonEmptyString(raw.baseUrl);
  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) return undefined;
  const token = nonEmptyString(raw.token);
  const serverPid =
    typeof raw.serverPid === "number" && Number.isInteger(raw.serverPid) && raw.serverPid > 0
      ? raw.serverPid
      : undefined;
  const serverStartedAt = typeof raw.serverStartedAt === "number" && Number.isFinite(raw.serverStartedAt)
    ? raw.serverStartedAt
    : undefined;

  return {
    // 版本按"这份状态自己的版本"记：文件路已被 `requireVersion` 保证等于 `STATE_VERSION`；
    // 管道路缺省成 1（对面没写）；写了别的数字就照实记下来（不编造）。
    version: typeof raw.version === "number" ? raw.version : STATE_VERSION,
    supervisorPid,
    startedAt,
    serverPid,
    baseUrl,
    token,
    command,
    // `idleSec`：**有值就夹到合法范围**（坏值不让整份状态不可用）；**缺了就用调用方给的缺省**
    // —— 缺省本身**不夹**，否则"管道路缺了取 0"会被夹成 `IDLE_SEC_MIN`（5），
    // 那个 5 看起来像个真阈值，而它其实只是夹紧的下限（两条路的口径就分不出来了）。
    idleSec: raw.idleSec === undefined ? options.idleSecWhenMissing ?? IDLE_SEC_DEFAULT : clampIdleSec(raw.idleSec),
    socket,
    serverStartedAt,
    starting: raw.starting === true,
    runtime: decodeRuntime(raw.runtime),
  };
}

/**
 * 读会合文件。**宽容**：文件不在、JSON 坏、版本不认识、关键字段缺失 → `undefined`。
 *
 * 逐字段的形状校验与管道路共用 `decodeState`；这里只多加一条
 * `requireVersion: STATE_VERSION`（理由见 `DecodeStateOptions` 的差异表）与
 * "缺 `idleSec` 用默认值"。
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
  // 文件路的额外要求：版本必须是**当前**这一份（旧世代的文件字段语义可能已经变了）
  return decodeState(parsed, { requireVersion: STATE_VERSION });
}

/** 非空字符串（空串按"没有"处理：`baseUrl: ""` / `token: ""` 是"还没就绪"，不是有效值）。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `runtime` 自述（排查用）：两样关键的字符串都在才认，缺一样就"没有这份信息"。 */
function decodeRuntime(value: unknown): SupervisorState["runtime"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.execPath !== "string" || typeof raw.node !== "string") return undefined;
  return {
    execPath: raw.execPath,
    node: raw.node,
    electron: typeof raw.electron === "string" ? raw.electron : undefined,
  };
}

/**
 * `baseUrl` 必须是 http(s) 且能被 `URL` 解析。
 *
 * **刻意不限制 host 必须是回环**——用户完全可以让自己的 `dsh web` 绑到局域网地址
 * （`--host`），那种配置是合法的；能写这两个文件 / 连这条管道的攻击者本来就已经以
 * 同一用户身份在运行了。这里挡的是"协议不对"（`file:` / `javascript:` / 相对串）
 * 与"解析不了"，那才是决定凭据去向时不能含糊的部分。
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
    rmSync(temp, { force: true });
    writeFileSync(temp, `${process.pid} ${Date.now()}`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
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

/** 删掉 socket 节点（只在确认没人监听后调用；Windows 上无操作）。 */
export function removeSocketNode(socket: string): void {
  if (process.platform === "win32") return;
  try {
    rmSync(socket, { force: true });
  } catch {
    // 忽略
  }
}
