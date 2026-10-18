/**
 * 本地文件系统访问层：`@` 发现的**信任门**、有界等待与全局未完成操作上限。
 *
 * 为什么需要它：工作区外的 `@` 发现（见 `docs/design-mentions.md`「工作区外的发现范围」）
 * 只有在**执行世界就是本机**时才成立——`dshChat.url` 指向别的机器、或 `dshChat.command`
 * 里跑的是 WSL 时，本机列出的路径在那边可能不存在、或是另一个同名文件。门由宿主独家
 * 持有（界面没有文件系统），两条判据缺一即关：
 *
 * 1. **形状**：服务器报的会话 cwd 必须是**宿主平台的原生绝对形态**
 *    （见 {@link isNativeAbsolutePath}）。POSIX 形态的 cwd 在 Windows 宿主上直接判假——
 *    否则 `Uri.file("/")` 会落到 `C:\`，把远端世界误判成本机；
 * 2. **证据**：该 cwd 在本机 `stat` 出来是**目录**（{@link LocalAccessGate.allows}）。
 *
 * 这是**启发式**的门，不是执行世界的身份认证：同路径的另一台机器它认不出来（那种
 * 部署下本机恰好有同名目录时两边会混），本模块不宣称能识别所有远端部署。
 *
 * 另一条硬约束是**等待有界**：UNC / 映射盘上的 stat 可能挂到几十秒，而 libuv 默认只有
 * 4 个 FS worker——挂住几个就把扩展宿主其它文件操作一起拖住。于是：
 *
 * - {@link LocalFsBudget}：一条查询链路一条预算（默认 {@link LOCAL_FS_BUDGET_MS}），
 *   信任门检查、抑制判定、路径逐段检查与目录读取**共用同一条**，不逐步重新计时；
 * - {@link withinBudget}：所有本地 FS 调用都从它走。全局（跨窗口、跨查询）最多
 *   {@link MAX_PENDING_FS_OPS} 个底层操作在飞；超时只放弃**等待**，槽位要等底层操作
 *   自己结算才释放——「未完成操作有界」就是这条：迟到的结果一律丢弃，不会再起新的；
 * - 排队等槽的调用在预算耗尽或查询作废时**连底层操作都不启动**。
 *
 * 缓存：门的结果按 **cwd 串**缓存（容量 {@link GATE_CACHE_LIMIT}，超出按插入顺序淘汰）。
 * 会话 cwd 变化（切会话、换目录）是另一个键，自然重算。**只有肯定的通过结果进缓存**，
 * absent / unknown / 超时都不缓存——网络短暂恢复后下一次查询还能再试，不会把一次
 * 抖动永久钉成「这个 cwd 不可用」。迟到结果按 cwd 键写，不会污染别的 cwd 的判定。
 */
import { lstat, readdir, stat } from "node:fs/promises";

/**
 * 本地 FS 查询总预算（毫秒）。
 *
 * 覆盖信任门存在性检查、抑制判定、路径逐段检查与目录读取：一次 `@` 查询里
 * 这些步骤共用同一个截止时刻，任何一步都不能把它推后。超时回退服务端已有结果。
 */
export const LOCAL_FS_BUDGET_MS = 1500;

/**
 * 全局**未完成**底层操作的并发上限。
 *
 * 为什么是 2：libuv 的 FS 线程池默认 4 个 worker，而本扩展的其它链路（图片、附件、
 * 文件芯片）也走它。挂死的 UNC stat 会一直占着槽位，留两个给宿主其余文件操作，
 * 用户敲字时不会因为一个不可达的共享盘整个宿主卡住。
 */
export const MAX_PENDING_FS_OPS = 2;

/** 门缓存容量（键 = cwd 串）。缓存只在会话 cwd 反复切换时有用，不需要更大。 */
export const GATE_CACHE_LIMIT = 64;

/**
 * 一条查询链路的本地 FS 预算。
 *
 * `signal` 传的是这次 `@` 查询的作废句柄（`controller.menuQueries` 的 AbortController）：
 * 用户又敲了一个字符、窗口下线时旧查询立刻作废，排队中的 FS 调用**连启动都不启动**，
 * 避免一批没人要的探针去抢全局槽位。
 */
export class LocalFsBudget {
  private readonly deadline: number;

  constructor(
    budgetMs: number = LOCAL_FS_BUDGET_MS,
    private readonly options: { now?: number; signal?: AbortSignal } = {},
  ) {
    this.deadline = (options.now ?? Date.now()) + Math.max(0, budgetMs);
  }

  /** 这条预算绑定的查询作废了吗（新的一次查询会 abort 旧的）。 */
  cancelled(): boolean {
    return this.signal?.aborted === true;
  }

  /** 这条预算的作废句柄（没有绑定时是 undefined）。 */
  get signal(): AbortSignal | undefined {
    return this.options.signal;
  }

  /** 还剩多少毫秒（已耗尽时是 0）。 */
  remaining(now: number = Date.now()): number {
    return Math.max(0, this.deadline - now);
  }

  /** 预算耗尽了吗。 */
  expired(now: number = Date.now()): boolean {
    return now >= this.deadline;
  }

  /** 还能不能继续做本地 FS 工作（既没过期、也没作废）。 */
  usable(now: number = Date.now()): boolean {
    return !this.cancelled() && !this.expired(now);
  }
}

/** 一次有界 FS 查询的收场：`ok: false` 时调用方一律按「没有证据」处理。 */
export type FsOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "cancelled" | "error"; error?: unknown };

interface Waiter {
  /** 把槽位交给它（`pending` 计数不变，直接转交）。 */
  grant: () => void;
  /** 放弃等待（预算耗尽 / 查询作废），槽位还给队列里的下一个。 */
  cancel: () => void;
  /** 摘掉 abort 监听（已收场时）。 */
  detach: () => void;
}

/** 全局未完成操作数（跨窗口、跨查询；不随新查询重置）。 */
let pendingFsOps = 0;
const fsWaiters: Waiter[] = [];

/** 当前有多少个本地 FS 底层操作还没结算（测试与诊断用）。 */
export function pendingFsOperations(): number {
  return pendingFsOps;
}

/** 抢一个全局槽位；预算耗尽 / 作废时返回 false（**不启动**底层操作）。 */
function acquireSlot(budget: LocalFsBudget): Promise<boolean> {
  if (!budget.usable()) return Promise.resolve(false);
  if (pendingFsOps < MAX_PENDING_FS_OPS) {
    pendingFsOps += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const waiter: Waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        waiter.detach();
        resolve(true);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        waiter.detach();
        resolve(false);
      },
      detach: () => {
        budget.signal?.removeEventListener("abort", onAbort);
        const at = fsWaiters.indexOf(waiter);
        if (at >= 0) fsWaiters.splice(at, 1);
      },
    };
    const onAbort = () => waiter.cancel();
    timer = setTimeout(() => waiter.cancel(), budget.remaining());
    budget.signal?.addEventListener("abort", onAbort, { once: true });
    fsWaiters.push(waiter);
  });
}

/** 释放槽位：直接转交给队列里第一个等待者，没有等待者才减计数。 */
function releaseSlot(): void {
  const next = fsWaiters.shift();
  if (next) {
    next.grant();
    return;
  }
  pendingFsOps = Math.max(0, pendingFsOps - 1);
}

/**
 * 在预算与全局未完成上限内跑一次底层 FS 操作。
 *
 * 超时 / 作废只是**放弃等待**：底层操作还在跑（Node 的 fs 调用没有取消），它的槽位
 * 要等它自己结算才释放，因此挂死的操作最多占用 {@link MAX_PENDING_FS_OPS} 个槽位，
 * 不会随连续输入累积；它的结果也不再被任何人读取。
 */
export async function withinBudget<T>(
  budget: LocalFsBudget,
  run: () => Promise<T>,
): Promise<FsOutcome<T>> {
  if (!(await acquireSlot(budget))) return budgetFailure(budget);
  if (!budget.usable()) {
    releaseSlot();
    return budgetFailure(budget);
  }
  let started: Promise<T>;
  try {
    started = run();
  } catch (error) {
    releaseSlot();
    return { ok: false, reason: "error", error };
  }
  // 槽位挂在**底层操作**上：超时 / 作废之后仍被占用，这正是「未完成操作有界」的机制
  // （Node 的 fs 调用没有取消，提前放槽只会让新的探针挤进来）。
  void started.then(
    () => releaseSlot(),
    () => releaseSlot(),
  );
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const settled: Promise<FsOutcome<T>> = started.then(
    (value): FsOutcome<T> => ({ ok: true, value }),
    (error): FsOutcome<T> => ({ ok: false, reason: "error", error }),
  );
  const cancelled = new Promise<FsOutcome<T>>((resolve) => {
    if (!budget.signal) return; // 没有作废句柄：这一支永远不结算（race 里的死支）
    onAbort = () => resolve({ ok: false, reason: "cancelled" });
    budget.signal.addEventListener("abort", onAbort, { once: true });
  });
  const expired = new Promise<FsOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve(budgetFailure(budget)), budget.remaining());
  });
  const outcome = await Promise.race([settled, cancelled, expired]);
  if (timer) clearTimeout(timer);
  if (onAbort) budget.signal?.removeEventListener("abort", onAbort);
  // 收场时**再查一次**：事件循环被别的活阻塞时 deadline 可能早就过了（微任务先于
  // 定时器跑），或这次查询已被作废——那种情况下底层操作「恰好先回来」也不算证据，
  // 否则一个过期的 ok 会被写进门的缓存。
  if (outcome.ok && !budget.usable()) return budgetFailure(budget);
  return outcome;
}

/** 预算耗尽 / 查询作废的收场（调用方一律按「没有证据」处理）。 */
function budgetFailure(budget: LocalFsBudget): FsOutcome<never> {
  return { ok: false, reason: budget.cancelled() ? "cancelled" : "timeout" };
}

/**
 * 本地 FS 探测接口（生产接 `node:fs/promises`，测试可注入）。
 *
 * 注入点存在的理由：UNC / 映射盘用例必须能在**不连真实共享**的前提下断言路径解析与
 * 「哪些形态根本不该被探测」，而真实网络调用在测试里既慢又不确定。
 */
export interface FsStatsLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface FsDirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface FsProbe {
  stat(path: string): Promise<FsStatsLike>;
  lstat(path: string): Promise<FsStatsLike>;
  readdir(path: string): Promise<readonly FsDirentLike[]>;
}

export const nodeFsProbe: FsProbe = {
  stat: (path) => stat(path),
  lstat: (path) => lstat(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
};

/** 宿主平台的两支：Windows 与其它（POSIX）。形态判据只分这两支。 */
export type HostPlatform = "win32" | "posix";

/** 当前宿主平台（形态判据的默认值）。 */
export function hostPlatform(): HostPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

/**
 * 这段路径是不是**宿主平台的原生绝对形态**。
 *
 * - POSIX 宿主：`/` 开头即可；
 * - Windows 宿主：盘符（`D:\` / `D:/`）或**完整的 UNC 根**（`\\server\share` /
 *   `//server/share`）。
 *
 * UNC 要求**至少到共享名**：`\\server`、`//server/`、`//` 都不是可列举的根（`win32.parse`
 * 对它们给出的根是 `/`、`resolve` 会落到当前盘），形状判据直接判假，于是不会有人拿它们去
 * `stat` / `readdir`——「不探测未输入的共享」这条从形态这一层就成立。
 *
 * **设备 / 扩展长度命名空间（`\\?\`、`\\.\`）本轮不支持**：`\\?\UNC\server\share\dir` 的
 * 解析根是 `\\?\UNC\`，照普通 UNC 处理会去探测一个根本不是共享的根。这里显式判假，
 * 宁可不做本地发现（用户仍可手写完整路径引用）。
 */
export function isNativeAbsolutePath(path: string, platform: HostPlatform = hostPlatform()): boolean {
  const text = path ?? "";
  if (platform === "posix") return text.startsWith("/");
  if (/^[A-Za-z]:[\\/]/u.test(text)) return true;
  if (/^[\\/]{2}[?.][\\/]/u.test(text)) return false;
  // 两个分隔符 + 非分隔符 + 分隔符 + 非分隔符：`\\server\share…`
  return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/u.test(text);
}

/**
 * 本机存在性的三态（与 `controller.fileExistence` 同一口径）：只有明确「找不到」才算
 * `absent`，其余异常（权限、离线共享、非法字符、虚拟文件系统不支持…）一律 `unknown`
 * ——拿不到证据就不动手。
 */
export type LocalExistence = "present" | "absent" | "unknown";

/** 把一次 FS 失败归入三态（Node 的 ENOENT / ENOTDIR 是唯一肯定的「不存在」）。 */
export function classifyFsFailure(error: unknown): LocalExistence {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
}

/**
 * 一个路径在本机存不存在（有界；超时与作废按 `unknown` 收）。
 *
 * 与 `controller.fileExistence` 的差别只有两点：走的是**本机** `node:fs`（不是
 * `vscode.workspace.fs`，后者在远端部署里查的是远端世界），以及有界等待。三态语义一致。
 * 调用方（`mentionResolves`）只把 `present` 当作抑制候选的肯定证据。
 */
export async function probeExistence(
  path: string,
  budget: LocalFsBudget,
  fs: FsProbe = nodeFsProbe,
): Promise<LocalExistence> {
  const outcome = await withinBudget(budget, () => fs.stat(path));
  if (outcome.ok) return "present";
  return outcome.reason === "error" ? classifyFsFailure(outcome.error) : "unknown";
}

/**
 * 信任门：服务器报的会话 cwd 是不是**本机**上一个真实存在的目录。
 *
 * 门是「执行世界就是本机」的启发式肯定证据（见文件头：不是身份认证）。结果按 cwd 串
 * 缓存，**只缓存通过**；缓存有界。
 */
export class LocalAccessGate {
  private readonly cache = new Set<string>();
  private readonly platform: HostPlatform;
  private readonly fs: FsProbe;

  constructor(options: { platform?: HostPlatform; fs?: FsProbe } = {}) {
    this.platform = options.platform ?? hostPlatform();
    this.fs = options.fs ?? nodeFsProbe;
  }

  /**
   * 这一条 cwd 能不能把发现范围扩到本机文件系统。
   *
   * 形状先过（{@link isNativeAbsolutePath}，零 FS 成本），再用本机 `stat` 找证据：
   * 只有明确 `isDirectory()` 才算通过。abs/unknown/超时/作废一律判关，且**不进缓存**。
   */
  async allows(cwd: string, budget: LocalFsBudget): Promise<boolean> {
    if (!isNativeAbsolutePath(cwd, this.platform)) return false;
    // 预算已耗尽 / 这次查询已作废时不给通过结果：作废查询不该拿到门，更不该把
    // 它算成一次「用过门」（缓存写入只发生在下面那次真实的 stat 之后）
    if (!budget.usable()) return false;
    if (this.cache.has(cwd)) return true;
    const outcome = await withinBudget(budget, () => this.fs.stat(cwd));
    if (!outcome.ok || !outcome.value.isDirectory()) return false;
    this.remember(cwd);
    return true;
  }

  /** 当前缓存条数（测试与诊断用）。 */
  get size(): number {
    return this.cache.size;
  }

  private remember(cwd: string): void {
    if (this.cache.size >= GATE_CACHE_LIMIT) {
      const oldest = this.cache.values().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.add(cwd);
  }
}
