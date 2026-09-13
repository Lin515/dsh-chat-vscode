import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST_HEARTBEAT_MS,
  acquireStartLock,
  clearHostLease,
  clearLease,
  clearStaleDocumentLocks,
  dropDeadLeases,
  dropStaleHostLeases,
  findAdoptable,
  findAttachable,
  findStarting,
  hasLiveHostFor,
  isProcessAlive,
  killLeasedServer,
  killLeasedServerAndWait,
  listeningPids,
  liveHosts,
  readLeaseByPid,
  readLeases,
  registerHost,
  removeHost,
  startedLongAgo,
  touchHost,
  updateLease,
  writeHostLease,
  writeLease,
  type ServerLease,
} from "./processRegistry";

/**
 * **除本实例之外**还有活着的扩展实例在用这个后台吗。
 *
 * 判据只看**各实例的心跳文件**，不看租约里那份按 pid 记的 `hosts[]`：调用点
 * （`stop` / `release`）已经清掉了本实例的心跳，所以剩下的新鲜心跳就是"别的窗口"。
 * 拿 pid 去比会误判——同一个窗口里多个面板共用一个 pid，而那条登记可能已经陈旧。
 */
function otherLiveHost(serverPid: number): boolean {
  return hasLiveHostFor(serverPid);
}

/**
 * 杀掉一个由本扩展启动的后台：**先按记录的 pid，再按端口兜底**（同步发起）。
 *
 * 为什么必须同步发起（实测教训）：调用点在窗口退出 / 扩展停用路径上，而**进程随时
 * 可能 exit**——曾经这里是 `async`，子进程在 `dispose()` 之后立刻 `process.exit(0)`，
 * 把还没发出去的 taskkill 直接掐断，后台就这么留下了（探针第 4 步反复失败的真因）。
 *
 * 端口兜底解决的是另一件事：Windows 上 `dsh web` 经 shell 启动，租约里记的是
 * `cmd.exe` 外壳 pid；外壳先死时，对着它调 `taskkill` 只会得到"找不到进程"，
 * 而真正的 node 还在监听端口。
 */
function killOwnedServer(serverPid: number, log: (line: string) => void): void {
  const lease = readLeaseByPid(serverPid);
  const sent = killLeasedServer(
    lease ?? { serverPid, command: "", startedAt: Date.now() },
    log,
  );
  if (!sent.length) log(`[server] pid=${serverPid} 已无可清理的进程`);
}


/**
 * 服务器连接信息。
 */
export interface ServerInfo {
  /** 形如 http://127.0.0.1:3080（不含尾部斜杠）。 */
  baseUrl: string;
  /** 用于换取签名 cookie 的启动 token（外部服务器可能没有）。 */
  token?: string;
  /** 是否由本扩展启动并持有其生命周期。 */
  owned: boolean;
  /**
   * 谁负责这个后台的生死（共享后台引入的第三态，见 `Ownership`）。
   * `owned` 保留是为了不破坏既有调用点，两者由 `ownership` 派生。
   */
  ownership: Ownership;
}

/**
 * 后台的归属：
 * - `self`：本窗口拉起的，**我负责杀**；
 * - `peer`：另一个 VS Code 窗口拉起的，我用它的令牌接入，**我不杀**（但最后一个窗口退出时，
 *   谁在最后谁负责——判据见 `release()`）；
 * - `external`：用户用 `dshChat.url` 指定的外部服务器，永远不杀、也不登记心跳。
 */
export type Ownership = "self" | "peer" | "external";

export type ServerState = "stopped" | "starting" | "ready" | "failed";

export interface ServerStatus {
  state: ServerState;
  info?: ServerInfo;
  detail?: string;
}

/** 心跳：每 `HOST_HEARTBEAT_MS` 一次，由控制器注入的回调做连接侧的事。 */
export type HeartbeatHook = () => void;

/**
 * `dsh web` 服务器生命周期管理。
 *
 * 设计要点：
 * - **启动命令完全由 `dshChat.command` 决定，本类一个参数都不拼**（2026-09-13 起）。
 *   默认值是 `dsh web --port 0 --no-open`——「端口交给系统分配（永不撞端口）」与
 *   「不抢占用户浏览器」都是这条默认值的一部分。用户想固定端口就在配置里写
 *   `dsh web --port 3080 --no-open`，想用自定义 profile 就写
 *   `dsh --profile <name> --port 0 --no-open`（`dsh web` 是硬别名，**不接受**
 *   `--profile`，实测会 `error: web takes none of parent --profile …`）。
 * - 服务器就绪时会打印一行 `dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`，
 *   我们从子进程日志里解析出真实端口与启动 token（0.1.2 起 /api 需要签名 cookie）。
 *   端口、profile、host 全都不必由扩展知道——公告行是唯一真相来源。
 * - 子进程输出重定向到临时日志文件而非管道：既避免管道缓冲/沙箱限制，也便于出错时回看。
 * - **多窗口共享**（2026-09-14 起，`docs/design-shared-server.md`）：同机的第二个窗口
 *   激活时若发现已有可用后台（会合租约里进程活着、有地址、有令牌、还有活窗口），
 *   就**直接用它的令牌接入**，不再起第二个进程；每个窗口每 5 秒刷一次心跳；
 *   **杀不杀只看还剩几个活窗口**，与谁先启动无关（需求 R3/R4）。
 */
export class ServerManager {
  private child: ChildProcess | undefined;
  private status: ServerStatus = { state: "stopped" };
  private readonly listeners = new Set<(status: ServerStatus) => void>();
  private startPromise: Promise<ServerInfo> | undefined;
  /** 启动参数：`configure()` 可以就地更新（见该方法注释）。 */
  private options: {
    url?: string;
    command: string;
    startTimeoutMs: number;
    workspace?: string;
    log: (line: string) => void;
  };
  /**
   * 当前后台是不是**别的窗口**拉起的：本窗口只在租约里挂着心跳，不能杀它。
   * 存 pid 而不是布尔值——杀之前要核对「我接入的还是那个进程」。
   */
  private sharedServerPid: number | undefined;
  /** 当前生效的地址（自管/接入的都算）：心跳自检据此判断「我该连哪儿」。 */
  private activeUrl: string | undefined;
  /** 心跳定时器（接入或自建后台后启动）。 */
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 心跳自检的回调：由控制器注入（它才知道连接是否还活着）。 */
  private heartbeatHook: HeartbeatHook | undefined;

  /** 当前后台的监听端口（判"它还活着吗"用；取不到返回 undefined）。 */
  private activePort(): number | undefined {
    const url = this.activeUrl ?? this.status.info?.baseUrl;
    if (!url) return undefined;
    try {
      const port = Number(new URL(url).port);
      return Number.isInteger(port) && port > 0 ? port : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * 本扩展实例的唯一 id（每个窗口一个）——心跳按它记，见 `processRegistry` 的
   * 「每个扩展实例的心跳文件」一节：同一个窗口里多个面板共享一个进程 pid，
   * 只按 pid 记心跳会让"窗口被禁用"永远发现不了。
   */
  private readonly hostId = randomUUID();
  // 日志路径按进程唯一：固定文件名会被同机另一个扩展实例（或测试脚本）截断，
  // 正在等待就绪的那个实例就会永远解析不到 URL 行
  private readonly logFile = join(tmpdir(), `dsh-chat-server-${process.pid}.log`);

  constructor(
    options: {
      /** 用户显式配置的服务器地址；非空表示"外部服务器"模式，不自行启动。 */
      url?: string;
      /** 启动命令，默认 `dsh web --port 0 --no-open`；扩展不再往它后面追加参数。 */
      command: string;
      /** 等待就绪的最长毫秒数。 */
      startTimeoutMs: number;
      /** 当前工作区（写进进程租约，同机多窗口时便于分辨）。 */
      workspace?: string;
      log: (line: string) => void;
    },
  ) {
    this.options = options;
  }

  /**
   * 就地换一套启动参数（`dshChat.command` / `dshChat.url` / `startTimeoutSec` 改动时）。
   *
   * 只改**下一次启动**用的值：已经拉起的子进程不受影响——调用方要先
   * `stop()` 再 `ensure()`，否则会拿旧配置的结果继续用（`dshChat.url` 从空变非空
   * 时尤其明显：不重连的话扩展会一直用着自己那个后台，用户的"切到外部服务器"
   * 静默失效）。
   */
  configure(patch: { url?: string; command?: string; startTimeoutMs?: number }): void {
    this.options.url = patch.url;
    if (patch.command !== undefined) this.options.command = patch.command;
    if (patch.startTimeoutMs !== undefined) this.options.startTimeoutMs = patch.startTimeoutMs;
    // 上一次 ensure() 若已失败，其 promise 早就 settle 并自清；这里只防「正在启动中
    // 就改了配置」——那个在途 promise 用的是旧配置，留着会让新配置白改。
    this.startPromise = undefined;
  }

  getStatus(): ServerStatus {
    return this.status;
  }

  onDidChangeStatus(listener: (status: ServerStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private setStatus(status: ServerStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /** 服务器日志的路径（供诊断命令展示）。 */
  get logPath(): string {
    return this.logFile;
  }

  /**
   * 用户显式配置的外部服务器地址（`dshChat.url`），未配置时为 undefined。
   * 外部模式才需要访问令牌，控制器据此决定是否提示输入 token。
   */
  get externalUrl(): string | undefined {
    const url = this.options.url?.trim();
    return url ? url.replace(/\/+$/, "") : undefined;
  }

  /** 读取服务器日志尾部，出错时附在提示里。 */
  logTail(lines = 12): string {
    try {
      const text = readFileSync(this.logFile, "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  /**
   * 确保有一个可用服务器。
   *
   * 三条分支：外部模式只探测；**同机已有可用后台则接入**（共享，不启第二个进程）；
   * 都没有才自己起一个。全部幂等。
   */
  async ensure(): Promise<ServerInfo> {
    const external = this.options.url?.trim();
    if (external) {
      const baseUrl = external.replace(/\/+$/, "");
      this.setStatus({ state: "starting", detail: `connecting ${baseUrl}` });
      const ready = await this.waitForHttp(baseUrl, 5_000);
      if (!ready) {
        const detail = `@serverUnreachable:${baseUrl}`;
        this.setStatus({ state: "failed", detail });
        throw new Error(detail);
      }
      const info: ServerInfo = { baseUrl, owned: false, ownership: "external" };
      this.setStatus({ state: "ready", info });
      return info;
    }
    if (this.status.state === "ready" && this.status.info) return this.status.info;
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /**
   * 「重启服务器」命令：**无论当前是谁的后台，都换成由本窗口管理的一个新后台**。
   *
   * 三种情形：
   * - 外部服务器：不碰（用户自己的进程），只让控制器重连；
   * - 自己的后台：杀掉重起；
   * - **别的窗口的后台**：杀掉它、用自己的命令重起，并把租约改写成我们自己的
   *   （决策 A1）——这是"重启服务器"这个命令的字面意思，其余窗口会在各自的心跳
   *   自检里发现新租约并自动接上（代价是它们有一次短暂中断，控制器会提示）。
   */
  async restart(): Promise<ServerInfo> {
    const previous = this.status.info;
    if (previous?.ownership === "external") return previous;
    this.detach();
    return this.ensure();
  }

  /**
   * 扩展停用（关窗 / 重载扩展）时由 context.subscriptions 调用。
   *
   * 共享后台的释放语义：**只有最后一个还在用它的窗口才杀进程**（需求 R3/R4）——
   * 关掉最先启动后台的那个窗口时，其它窗口不受影响；关掉最后一个才真正释放。
   */
  dispose(): void {
    this.release();
  }

  /**
   * 摘掉心跳与租约登记，**不杀进程**：重启 / 换配置 / 主动断连前先走这里。
   */
  private detach(): void {
    this.clearHeartbeat();
    if (this.sharedServerPid !== undefined) removeHost(this.sharedServerPid);
    this.sharedServerPid = undefined;
    const child = this.child;
    this.child = undefined;
    if (child?.pid !== undefined) {
      this.options.log(`[server] 停止子进程 pid=${child.pid}`);
      killOwnedServer(child.pid, (line) => this.options.log(line));
    }
    this.activeUrl = undefined;
    this.setStatus({ state: "stopped" });
  }

  /**
   * 停止服务器。
   *
   * - **外部服务器**：只清状态，进程与心跳都不归我们管；
   * - **接入的后台（peer）**：把自己从 hosts 摘掉即可（不杀——那是别人起的）；
   * - **自己的后台**：若**还有别的活窗口在用**就不杀（只摘掉自己的登记），
   *   最后一个窗口退出时才 `taskkill /T`。这一步是 R3/R4 的落点。
   */
  stop(): void {
    if (this.options.url?.trim()) {
      this.setStatus({ state: "stopped" });
      return;
    }
    this.clearHeartbeat();
    if (this.sharedServerPid !== undefined) {
      const pid = this.sharedServerPid;
      this.sharedServerPid = undefined;
      removeHost(pid);
      this.options.log(`[server] 已断开共享后台 pid=${pid}（不杀：由它的窗口管理）`);
      this.activeUrl = undefined;
      this.setStatus({ state: "stopped" });
      return;
    }
    const child = this.child;
    this.child = undefined;
    this.activeUrl = undefined;
    if (child?.pid !== undefined) {
      // **先停掉自己的心跳**再判"还有别人吗"：心跳文件刚续过期，留着会让判据
      // 永远认为"我还在用"，于是谁都杀不掉（次序错了就是这个症状）
      clearHostLease(this.hostId);
      if (otherLiveHost(child.pid)) {
        // 还有别的窗口在用：只把自己从 hosts 摘掉，进程留着（它退出时自然会杀）
        removeHost(child.pid);
        this.options.log(`[server] pid=${child.pid} 仍被其它 VS Code 窗口使用，不停止`);
      } else {
        this.options.log(`[server] 停止子进程 pid=${child.pid}（按 pid + 端口两道清理）`);
        killOwnedServer(child.pid, (line) => this.options.log(line));
      }
    }
    this.setStatus({ state: "stopped" });
  }

  /**
   * 释放：扩展宿主退出的最后一道动作（`dispose` 走这里）。
   *
   * 与 `stop()` 的差别只在**接入的后台**怎么处理；至于自己起的后台，
   * 判据与 `stop()` **完全相同**——因为"最后一个窗口"跟"是不是 owner"无关
   * （需求 R4：最先启动后台的窗口完全可能先关）。这里曾经无条件杀，症状是
   * 「关掉先开的窗口 → 其它窗口的连接被一起带走」，端到端探针钉住了它。
   *
   * 用户口径（2026-09-14）：**本扩展启动的 dsh 必须跟随扩展生命周期，彻底清理**，
   * 不允许"留给下次激活"。所以这里不再有"宁可留孤儿"的退让：真正动手的是
   * `killOwnedServer`，它会先按 pid 杀、再按端口把真正在监听的进程找出来杀。
   *
   * 唯一真正来不及的情形是**扩展宿主被强杀**（没有 deactivate、也没有任何进程能执行
   * 清理代码）。那种情况由**下一次激活时的启动决策**收尾：那里的顺序是"能接管的接管、
   * 连不上的才回收"（见 `start()` 与 `findReusableLeftover`）——这是机制边界，
   * 不是设计退让。
   */
  private release(): void {
    this.clearHeartbeat();
    // 先摘掉自己的心跳：下面两条判据都问"还有别人吗"，自己那份必须先消失
    clearHostLease(this.hostId);
    const sharedPid = this.sharedServerPid;
    this.sharedServerPid = undefined;
    if (sharedPid !== undefined) {
      removeHost(sharedPid);
      // **摘掉自己之后再判**：owner 可能早就退了（需求 R4），那这一位就是最后一个，
      // 后台得由它带走——不然会留下一个没人管的孤儿（探针第 4 步钉的就是这条）。
      // 判据读的是磁盘上的租约与各实例的心跳文件，刚写的摘除已经落盘。
      if (!otherLiveHost(sharedPid)) {
        this.options.log(`[server] 本窗口退出：接手的共享后台 pid=${sharedPid} 已无人使用，停止它`);
        killOwnedServer(sharedPid, (line) => this.options.log(line));
      } else {
        this.options.log(`[server] 本窗口退出，已从共享后台 pid=${sharedPid} 摘除`);
      }
    }
    const child = this.child;
    this.child = undefined;
    if (child?.pid !== undefined) {
      if (otherLiveHost(child.pid)) {
        removeHost(child.pid);
        this.options.log(`[server] 本窗口退出：pid=${child.pid} 仍被其它 VS Code 窗口使用，不停止`);
      } else {
        this.options.log(`[server] 本窗口退出：停止子进程 pid=${child.pid}（按 pid + 端口两道清理）`);
        killOwnedServer(child.pid, (line) => this.options.log(line));
      }
    }
    this.setStatus({ state: "stopped" });
  }

  private async start(): Promise<ServerInfo> {
    this.setStatus({ state: "starting" });
    // 清空上一次的日志，避免解析到过期的 token/端口
    writeFileSync(this.logFile, "", "utf8");

    // 决策点用一把跨进程锁串行化：两个窗口同时激活时只能有一个进入"起进程"分支，
    // 另一个在拿到锁之后会看到"已在启动中"的租约并改为等待（见 docs/design-shared-server.md 竞态 1）
    const unlock = await acquireStartLock(5_000);
    if (!unlock) {
      // 拿不到锁（另一个窗口正在决策中）：等它把租约写出来即可
      this.options.log("[server] 启动锁被占用，等待其它窗口宣布后台…");
    }

    let pending: ServerLease | undefined;
    let adopt: ServerLease | undefined;
    try {
      // 决策之前先清一遍**失效的心跳文件**（用户口径 2026-09-14 第 2 条）：
      // 上次崩溃的窗口留下的那份心跳会让下面所有判据都以为"还有人在用"，
      // 于是既不接管也不回收（实测：崩溃后新窗口重起了一个，而不是接管遗留的那个）。
      // 判"失效"用批量 `Get-Process`——**不能**用 `process.kill(pid,0)`：被强杀但
      // 尚未回收的进程，那个探测仍返回成功。
      const stale = dropStaleHostLeases();
      if (stale.length) this.options.log(`[server] 清理了 ${stale.length} 个失效心跳（崩溃遗留）`);
      dropDeadLeases();
      // 顺序固定为：**别人的活后台 → 崩溃遗留的后台 → 别人正在启动的后台 → 自己起**。
      // 前两种都是"复用"，第三种是"等"；只有都没有才起新进程。
      // （共享是唯一模式，见 docs/design-shared-server.md。）
      const attachable = findAttachable();
      // 崩溃遗留的后台（没有活实例、但还在跑）优先接管：它手里还有会话与内存状态，
      // "杀掉重起"纯属浪费。判定要**真的连一下**——租约说它还活着不算数。
      const leftover = attachable ? undefined : await this.findReusableLeftover();
      if (attachable) {
        this.options.log(`[server] 复用已有后台 ${attachable.baseUrl}（pid=${attachable.serverPid}）`);
        adopt = attachable;
      } else if (leftover) {
        adopt = leftover;
      } else {
        const starting = findStarting(this.options.startTimeoutMs);
        if (starting) {
          this.options.log(`[server] 另一个窗口正在启动后台 pid=${starting.serverPid}，等它就绪`);
          pending = starting;
        } else {
          // 起进程**之前**清一次崩溃遗留 writer 锁。放在这里而不是只放在激活期：
          // 这是唯一能保证「无论谁触发启动都清过」的位置（重启服务器命令、手动连接、
          // 自动重连都经这里）。`dsh web` 的 boot 锁不到就等 30 秒然后整个进程退出，
          // 而库本身刻意不回收孤儿锁——回收是客户端的责任。
          await this.clearStaleLocks();
          // 命令原样执行：`web` / `--port` / `--no-open` / `--profile` 都归用户配置管，
          // 扩展只负责把它交给 shell 并从公告行里解析结果（见类注释）。
          this.options.log(`[server] 启动：${this.options.command}`);
          const child = this.spawnServer();
          const pid = child?.pid;
          if (!child || typeof pid !== "number") throw new Error("@serverSpawnFailed:spawn returned no pid");
          // 租约**在锁内**写、且带上"启动中"的空地址：这样其它窗口拿到锁时能看到
          // "有人在起"，从而等待而不是再起一个
          this.writeOwnLease(pid);
          this.child = child;
        }
      }
    } finally {
      unlock?.();
    }

    if (adopt) return this.attach(adopt);
    if (pending) return this.joinStarting(pending.serverPid);
    return this.awaitReady();
  }

  /**
   * 找一个**可以接管的崩溃遗留后台**（见 `processRegistry.findAdoptable`）。
   *
   * 三种结局（这一步就是"崩溃后能不能接着用上一个后台"的落点）：
   * - **真的还连得上** → 接管它（它手里还有会话与内存状态，重起纯属浪费）；
   * - **还在启动宽限内**（没有地址、宣布时间很新）→ 不动它，交给下面的 `findStarting` 等；
   * - **连不上** → 它是死了的空壳（进程还在但不再服务），回收掉，然后照常起一个新的。
   *
   * "连不上"必须**实测**（HTTP 探一下）：租约说它还活着不算数——Windows 上被强杀的
   * 进程在回收前，pid 探测与进程表查询都可能说它还在。
   */
  private async findReusableLeftover(): Promise<ServerLease | undefined> {
    const candidate = findAdoptable(this.options.command);
    if (!candidate) return undefined;
    const baseUrl = (candidate.baseUrl ?? "").replace(/\/+$/, "");
    if (baseUrl && (await this.waitForHttp(baseUrl, 3_000))) {
      this.options.log(
        `[server] 发现上次遗留的后台 ${baseUrl}（pid=${candidate.serverPid}，自 ${new Date(candidate.startedAt).toLocaleTimeString()} 起运行），直接接管`,
      );
      return candidate;
    }
    if (!startedLongAgo(candidate)) {
      // 刚宣布启动、还没打印公告行：属于"别人正在启动"，不要回收（会打断对方的启动）
      this.options.log(`[server] 遗留租约 pid=${candidate.serverPid} 仍在启动宽限内，暂不处理`);
      return undefined;
    }
    this.options.log(`[server] 遗留后台 ${baseUrl || `pid=${candidate.serverPid}`} 已连不上，回收它`);
    await killLeasedServerAndWait(candidate, (line) => this.options.log(line), 20_000);
    return undefined;
  }

  /** 起进程（输出进日志文件；Windows 经 shell 解析 `dsh.cmd`）。 */
  private spawnServer(): ChildProcess | undefined {
    const fd = openSync(this.logFile, "a");
    try {
      return spawn(this.options.command, [], {
        shell: true, // Windows 上是 dsh.cmd，必须经 shell 解析
        windowsHide: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, BROWSER: "none" },
      });
    } finally {
      closeSync(fd);
    }
  }

  /** 清崩溃遗留的 writer 锁（失败只记日志：服务器自己去试，失败时有 staleLockHint）。 */
  private async clearStaleLocks(): Promise<void> {
    try {
      const lock = await clearStaleDocumentLocks((line) => this.options.log(line));
      if (lock.cleared.length) {
        this.options.log(`[server] 清理了 ${lock.cleared.length} 个崩溃遗留的文件锁`);
      }
    } catch (error) {
      this.options.log(`[server] 残留锁检测失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 写心跳文件（统一入口：**连接信息与启动命令都要带上**）。
   *
   * 崩溃复用全靠它：上次 VS Code 崩溃时，租约会随服务器进程的 exit 处理器被删掉，
   * 磁盘上只剩这份心跳——没有 `baseUrl`/`token` 就永远接不回那个还活着的服务器。
   */
  private writeHeartbeat(serverPid: number, info?: { baseUrl: string; token?: string }): void {
    writeHostLease({
      hostId: this.hostId,
      serverPid,
      workspace: this.options.workspace,
      baseUrl: info?.baseUrl,
      token: info?.token,
      command: this.options.command,
    });
  }

  /**
   * 写下自己的租约（地址与令牌先空着，就绪后回填）。
   *
   * **心跳文件也在这里就写**（不等就绪）：另一个窗口在"我起了进程、dsh 还没打印
   * 公告行"的那几秒里会来读租约——它看到这条租约没有地址，会去 `findStarting`；
   * 而判"还有人在用吗"看的是心跳文件。心跳晚写的话，那几秒里对方会认为无人使用，
   * 于是**自己也去起一个**——命令里写死 `--port` 时就会撞端口起不来
   * （这正是"固定端口在多窗口下会不会冲突"的真实答案：共享本身不冲突，
   * 冲突只发生在启动竞态窗口里）。
   */
  private writeOwnLease(serverPid: number): void {
    this.writeHeartbeat(serverPid);
    const recorded = writeLease({
      version: 2,
      serverPid,
      workspace: this.options.workspace,
      command: this.options.command,
      startedAt: Date.now(),
      hosts: [{ pid: process.pid, workspace: this.options.workspace, seenAt: Date.now() }],
    });
    if (!recorded) {
      // 不致命，但要说清楚：这台机器上残留进程将无法被自动识别，共享也无从谈起
      this.options.log("[server] 进程租约写入失败，残留进程检测与多窗口共享对本进程不可用");
    }
  }

  /** 等自己刚起的那个后台打印公告行并就绪。 */
  private async awaitReady(): Promise<ServerInfo> {
    const child = this.child;
    if (!child || child.pid === undefined) throw new Error("@serverSpawnFailed:spawn returned no pid");

    let exitInfo: string | undefined;
    child.on("error", (error) => {
      exitInfo = `@serverSpawnFailed:${error.message}`;
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // 已被 stop() 主动结束
      this.child = undefined;
      clearLease(child.pid);
      const detail = `@serverExited:${code ?? "?"}:${signal ?? "?"}`;
      this.options.log(`[server] ${detail}`);
      this.setStatus({ state: "failed", detail });
    });

    const deadline = Date.now() + this.options.startTimeoutMs;
    while (Date.now() < deadline) {
      if (exitInfo !== undefined) break;
      const parsed = this.parseAnnouncement();
      if (parsed) {
        const ok = await this.waitForHttp(parsed.baseUrl, 10_000);
        if (ok) {
          const info: ServerInfo = { ...parsed, owned: true, ownership: "self" };
          this.options.log(`[server] 就绪：${info.baseUrl}`);
          if (child.pid !== undefined) {
            updateLease(child.pid, { baseUrl: info.baseUrl, token: info.token });
            this.sharedServerPid = undefined;
            this.startHeartbeat(child.pid);
          }
          this.activeUrl = info.baseUrl;
          this.setStatus({ state: "ready", info });
          // 心跳文件：本实例"正在使用这个后台"的凭据，**同时记下连接信息**——
          // 若 VS Code 在此之后崩溃，租约会随服务器进程的 exit 处理器一起被删掉，
          // 这份心跳就是新窗口找回这个后台的唯一线索（见 processRegistry.writeHostLease）
          this.writeHeartbeat(child.pid as number, info);
          return info;
        }
      }
      if (this.child === undefined) break; // 进程已退出
      await delay(300);
    }

    const tail = this.logTail();
    const detail = [
      exitInfo ??
        `@serverStartTimeout:${Math.round(this.options.startTimeoutMs / 1000)}`,
      this.staleLockHint(),
      tail && `@serverLogTail:${tail}`,
    ]
      .filter(Boolean)
      .join("\n");
    this.setStatus({ state: "failed", detail });
    // 启动失败：连心跳文件一起收掉——否则别的窗口会以为"这个后台还有人用"，
    // 既不会接入也不会回收，留下一条永远陈旧的心跳（直到 30 秒阈值才被判死）
    clearHostLease(this.hostId);
    this.stop();
    throw new Error(detail);
  }

  /**
   * 接入别的窗口拉起的后台：**不启动任何进程**，只在自己的心跳里挂上登记。
   *
   * 令牌来自租约（那是它唯一存在的地方，见 `processRegistry.ServerLease.token`），
   * 控制器的客户端拿它换一张绑定该 `baseUrl` 的 cookie 即可——与自管后台走同一条
   * 认证代码路径，差别只在"没人负责杀它"。
   */
  private async attach(lease: ServerLease): Promise<ServerInfo> {
    const baseUrl = (lease.baseUrl ?? "").replace(/\/+$/, "");
    const token = lease.token ?? "";
    const ok = await this.waitForHttp(baseUrl, 10_000);
    if (!ok) {
      const detail = `@serverUnreachable:${baseUrl}`;
      this.setStatus({ state: "failed", detail });
      throw new Error(detail);
    }
    const info: ServerInfo = { baseUrl, token, owned: false, ownership: "peer" };
    // **把"真正在服务的进程"解析出来再记住**：租约/心跳里那个 pid 往往是 `cmd.exe` 外壳，
    // VS Code 崩溃后外壳没了、服务器还在。照抄旧 pid 记下去，心跳每 5 秒就判定
    // "后台已退出"→ 再接管一次 → 死循环（实测踩过：日志里反复出现"已接入共享后台"）。
    const servedPid = await this.resolveServedPid(lease.serverPid, baseUrl);
    this.sharedServerPid = servedPid;
    // **收拾陈旧租约、只留一份真的**：崩溃时服务器进程的 exit 处理器会把租约删掉，
    // 磁盘上留下的那几份要么指向已死的外壳 pid、要么是上一轮的残影。留着它们会有两个后果：
    // ① 别的窗口按旧 pid 判断"后台还在"，② 真正那份被当成"多条后台"。所以这里清干净，
    // 下面按**真实在服务的 pid** 重建一份（实测症状：接管后 `租约数=2`、退出后清不干净）。
    for (const { lease: stale } of readLeases()) {
      if (stale.serverPid === servedPid) continue;
      clearLease(stale.serverPid);
    }
    this.options.log(`[server] 接管时整理了陈旧租约，现按 pid=${servedPid} 重建`);
    this.writeLeaseFor(servedPid, baseUrl, token);
    // 登记自己：**必须在令牌拿到之后立刻做**——否则我在别人眼里"不存在"，
    // 对方关窗时就会把后台带走，而我还连着它
    registerHost(servedPid, {
      pid: process.pid,
      workspace: this.options.workspace,
      seenAt: Date.now(),
    });
    // 心跳文件同样立刻写：它是"这个实例在用"的权威凭据，并带上连接信息供崩溃复用
    this.writeHeartbeat(servedPid, { baseUrl, token });
    this.startHeartbeat(servedPid);
    this.activeUrl = baseUrl;
    this.options.log(`[server] 已接入共享后台 ${baseUrl}（pid=${servedPid}）`);
    this.setStatus({ state: "ready", info });
    return info;
  }

  /** 为某个后台写一份租约（接管遗留后台时用：按"真正在服务的 pid"重建）。 */
  private writeLeaseFor(serverPid: number, baseUrl: string, token: string | undefined): void {
    const existing = readLeaseByPid(serverPid);
    writeLease({
      version: 2,
      serverPid,
      command: existing?.command ?? this.options.command,
      startedAt: existing?.startedAt ?? Date.now(),
      workspace: existing?.workspace ?? this.options.workspace,
      baseUrl,
      token,
      hosts: [{ pid: process.pid, workspace: this.options.workspace, seenAt: Date.now() }],
    });
  }

  /**
   * 解析"这个地址上真正在服务的进程 pid"。
   *
   * 优先用端口占用者（`netstat`），因为只有它一定准：记录里的 pid 可能是外壳、
   * 可能已被回收。拿不到就退回记录值（至少不比原来差）。
   */
  private async resolveServedPid(recordedPid: number, baseUrl: string): Promise<number> {
    let port: number | undefined;
    try {
      port = Number(new URL(baseUrl).port) || undefined;
    } catch {
      port = undefined;
    }
    if (port === undefined) return recordedPid;
    const owners = await listeningPids(port);
    return owners[0] ?? recordedPid;
  }

  /**
   * 另一个窗口正在启动后台：等它把 `baseUrl` 与令牌写进租约（不再起第二个进程）。
   *
   * 等不到就按超时失败——此时**不**自己起一个：那会变成"两个后台"，与需求相悖。
   * 租约在超时窗口内一直有效（`findStarting` 已经把太久远的排除掉了）。
   */
  private async joinStarting(serverPid: number): Promise<ServerInfo> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    while (Date.now() < deadline) {
      const lease = readLeaseByPid(serverPid);
      if (lease?.baseUrl && lease.token) return this.attach(lease);
      if (!isProcessAlive(serverPid)) break;
      await delay(300);
    }
    const detail = `@serverStartTimeout:${Math.round(this.options.startTimeoutMs / 1000)}`;
    this.setStatus({ state: "failed", detail });
    throw new Error(detail);
  }

  /** 当前生效的后台地址（自管 / 接入 / 外部都算）；没有就是 undefined。 */
  get activeBaseUrl(): string | undefined {
    return this.activeUrl;
  }

  /** 控制器注入心跳自检：它才知道"当前连接还活着吗"（异步，不阻塞心跳节拍）。 */
  onHeartbeat(hook: HeartbeatHook): void {
    this.heartbeatHook = hook;
  }

  /**
   * 心跳：每 `HOST_HEARTBEAT_MS` 一次，同时管三件事。
   *
   * 1. **刷自己的 `seenAt`**（接入或自管都要）：别的窗口靠它判断"还有人在用"，
   *    也是"最后一个窗口退出才杀"的判据；顺带清掉同一张租约里死掉的窗口记录。
   * 2. **连接健康**：把自己那个地址交给控制器的回调，由它判断连接是否还活着。
   * 3. **后台死了怎么办**：
   *    - 自己起的 → 重新 `ensure()`（起一个新的，写新租约，其余窗口会读到新地址）；
   *    - 接入的 → 重读租约：有新后台就换过去重连；**没有就自己起一个**（需求 R4：
   *      owner 崩了但还有窗口活着，不能就这么断着）。
   */
  private async heartbeat(): Promise<void> {
    if (this.options.url?.trim()) return; // 外部服务器不参与共享
    const info = this.status.info;
    if (!info) return;
    try {
      // 先让连接侧自检（它可能在内部换掉连接；这一步不能阻塞心跳，回调是同步返回的）
      this.heartbeatHook?.();

      // 我正在用哪个后台（自管的是子进程 pid，接入的是别人那个）
      let serverPid = this.sharedServerPid ?? this.child?.pid;
      if (serverPid === undefined) {
        this.options.log("[server] 自己的后台已不在，尝试重新拉起");
        this.activeUrl = undefined;
        this.setStatus({ state: "stopped" });
        await this.ensure();
        return;
      }

      // 心跳：① 租约里那条（同实例多面板共享）② 本实例自己的心跳文件（被禁用的唯一线索）
      touchHost(serverPid);
      this.writeHeartbeat(serverPid, { baseUrl: info.baseUrl, token: info.token });

      // **健康判据用"端口还在不在听"，不用 pid**（实测教训）：`dsh web` 是 shell→node 的
      // 结构，我们手里那个 pid 可能是外壳、可能已被回收，`isProcessAlive` 对它既会误报活
      // 也会误报死——后者会让心跳每 5 秒把好好的后台判死、反复重连（实测就是这么翻车的）。
      // 端口是唯一确定的事实：还在 LISTENING 就说明服务器活着。
      const port = this.activePort();
      if (port !== undefined) {
        const owners = await listeningPids(port);
        if (owners.length) {
          // 顺手把"真正在服务的 pid"记下来，供退出清理与其它窗口使用
          if (owners[0] !== serverPid) {
            this.sharedServerPid = owners[0];
            this.writeHeartbeat(owners[0], { baseUrl: info.baseUrl, token: info.token });
          }
          return;
        }
      } else if (isProcessAlive(serverPid)) {
        return; // 没有端口信息（外部/异常）：退回进程判据
      }

      // 端口没人听了 = 后台真的没了。自己起的就重起，接入的去找新的（没有就自己起）。
      this.options.log(
        `[server] 后台已不再监听端口 ${port ?? "?"}（pid=${serverPid}），寻找新的后台`,
      );
      this.sharedServerPid = undefined;
      this.activeUrl = undefined;
      this.setStatus({ state: "stopped" });
      // `ensure()` 自己带在途合并（startPromise），若干次心跳重入不会起多个进程
      await this.ensure();
    } catch (error) {
      // 心跳失败不改变既有状态：连接层有自己的重连与报错，这里只记一行
      this.options.log(`[server] 心跳自检失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 诊断用：这个后台是不是共享的（其它窗口在用吗）。
   *
   * `hostCount` 只统计**活着的**窗口（心跳判活），所以它是"现在有几个窗口在用"
   * 的大致答案，而不是累计登记数。
   */
  sharedSummary(): { ownership: Ownership; serverPid?: number; hostCount: number } | undefined {
    const info = this.status.info;
    if (!info) return undefined;
    const pid = this.sharedServerPid ?? this.child?.pid;
    if (pid === undefined) return { ownership: info.ownership, hostCount: 1 };
    const lease = readLeaseByPid(pid);
    return {
      ownership: info.ownership,
      serverPid: pid,
      hostCount: lease ? liveHosts(lease).length : 1,
    };
  }

  private startHeartbeat(serverPid: number): void {
    this.clearHeartbeat();
    // 记下"我在用哪个后台"：接入的是别人的 pid，自管的是自己的子进程 pid
    if (this.child?.pid !== serverPid) this.sharedServerPid = serverPid;
    const timer = setInterval(() => void this.heartbeat(), HOST_HEARTBEAT_MS);
    // 心跳定时器不该拖住扩展宿主的退出
    timer.unref?.();
    this.heartbeatTimer = timer;
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * 启动失败时，若原因落在**崩溃遗留的 writer 锁**上，追加一句可操作的说明。
   *
   * `dsh web` 的 boot 会去锁 `.credentials.yaml`，等 30 秒拿不到就抛错退出——
   * 日志里是 `atomic-write: timed out waiting for the writer lock at <path>`。
   * 扩展在启动服务器**之前**会清一遍（`clearStaleDocumentLocks`），但那之后又有
   * 进程被强杀的话，锁还会留下；此时用户看到的只是「启动超时」，无从下手。
   *
   * 返回 undefined 时不影响原有报错（正常失败路径一个字都不变）。
   */
  private staleLockHint(): string | undefined {
    let text: string;
    try {
      text = readFileSync(this.logFile, "utf8");
    } catch {
      return undefined;
    }
    const match = /timed out waiting for the writer lock at (.+?)[\r\n]/.exec(text);
    if (!match) return undefined;
    const lockPath = match[1].trim();
    // 标记而不是中文：这段说明会进 `connectionDetail`，由 webview 按用户选的
    // 界面语言渲染（多行说明写在词典里，见 texts.ts 的 serverStaleLock）。
    return `@serverStaleLock:${lockPath}`;
  }

  /** 从子进程日志里解析 `dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`。 */
  private parseAnnouncement(): { baseUrl: string; token: string } | undefined {
    let text: string;
    try {
      text = readFileSync(this.logFile, "utf8");
    } catch {
      return undefined;
    }
    const match = /dsh web:\s*(https?:\/\/\S+)/.exec(text);
    if (!match) return undefined;
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      return undefined;
    }
    const token = url.searchParams.get("token") ?? "";
    url.search = "";
    return { baseUrl: url.toString().replace(/\/+$/, ""), token };
  }

  /** 轮询直到服务器给出任意 HTTP 响应（未授权时 401/403 也算活着）。 */
  private async waitForHttp(baseUrl: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(baseUrl, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(2_000),
        });
        return true;
      } catch {
        await delay(200);
      }
    }
    return false;
  }
}
