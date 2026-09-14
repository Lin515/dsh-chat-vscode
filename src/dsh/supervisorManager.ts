/**
 * 后台管理器（**客户端形态**）：找 supervisor、必要时拉起、连上并保持长连接。
 *
 * 这是 `docs/design-supervisor.md` 落地后取代旧 `ServerManager` 的东西。区别是根本性的：
 *
 * | | 旧（会合租约） | 新（supervisor） |
 * |---|---|---|
 * | dsh 的生死挂在谁身上 | **扩展宿主**（VS Code 随时创建/销毁它） | **独立进程**（与 VS Code 无关） |
 * | "还有没有人在用"怎么判 | 窗口之间互相投票（心跳文件 + 六个判据） | 单一裁决者看"socket 上还有没有活连接" |
 * | 窗口重载 | 旧实例退出时把 dsh 杀了（新实例还没出生、投不了票）→ 每次冷启 | dsh 从未中断，新实例直接接上 |
 * | 扩展退出时要做什么 | 判"是不是最后一个"，是就杀 dsh | **什么都不杀**，只关自己的连接 |
 *
 * **本文件不杀任何进程**（唯一例外：`restart()`/`stop()` 是把"请求"交给 supervisor 执行，
 * 由它动手）。这条纪律是本次架构改动的核心：今天所有麻烦都源于"扩展也在杀 dsh"。
 *
 * ## 2026-09-14：启动决策（`autoStart` 关掉之后）
 *
 * 用户口径：**关掉 `dshChat.autoStart` 时，后台不存在就只显示「启动服务器」按钮，
 * 扩展不许自作主张拉起一套**；但后台（守护进程 + dsh）真的在跑时，要**自动接上**
 * 并且一直重试（没有总超时）。因此这里把"能不能启动"变成一条**显式许可**：
 *
 * - `options.autoStart`（配置项）：**自动**路径（激活期、心跳自检）的许可，默认 true；
 * - `ensure({ start: true })`：**用户显式**动作（点「启动服务器」、发消息、重启服务器）的许可，
 *   它覆盖配置——用户要后台的时候不该被配置挡住；
 * - `ensure({ start: false })`：只接上已经在跑的（「尝试重连」用）。
 *
 * ## 2026-09-14：等待**不再由时长决定**（用户口径，见 `docs/design-supervisor.md` §8.4）
 *
 * 配置项 `dshChat.startTimeoutSec`（以及 `ManagerOptions.startTimeoutMs`）已删除：
 * 等待只由两件事结束——**真的就绪**，或用户按钮（「停止连接」/「停止服务器」→
 * `cancelWaiting()` → `WaitCancelledError`，调用方按"用户叫停"处理，不当失败）。
 * 从前的"到 90 秒就报一次启动超时、再由心跳拉回重试"是一档**由时钟改写界面状态**
 * 的逻辑，与"状态只由真实事件与按钮改变"冲突。
 *
 * 另一条纪律：**守护进程还活着时，永远只接入、不另起一套**。Windows 上命名管道只能被
 * 一个进程监听，重复 spawn 出来的第二个 supervisor 会在 `listen` 处失败自杀，而它
 * 已经把父进程的 spawn 开销付掉了；接入还顺带把"dsh 崩了但守护进程还在"这套自愈
 * 交回给唯一裁决者（连接本身就是"我在用"，它据此重起 dsh）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  IDLE_SEC_DEFAULT,
  type SupervisorState,
  clampIdleSec,
  generationOf,
  logFileIn,
  readState,
  supervisorDirectory,
} from "./supervisorProtocol";
import {
  SupervisorConnection,
  connectToSupervisor,
  ensureSupervisor,
  waitForReadyState,
  type SupervisorLauncher,
} from "./supervisorClient";
import { createDefaultSupervisorLauncher } from "./supervisorRunner";
import { isProcessAlive } from "./processRegistry";

/** 后台连接信息（沿用旧形状，controller 与界面不必跟着改）。 */
export interface ServerInfo {
  /** 形如 http://127.0.0.1:3080（不含尾部斜杠）。 */
  baseUrl: string;
  /** 用于换取签名 cookie 的启动令牌（外部服务器可能没有）。 */
  token?: string;
  /** 是否由本窗口拉起（保留字段，供诊断与文案判断）。 */
  owned: boolean;
  /**
   * 归属：`self` = 本窗口拉起的 supervisor 那套；`peer` = 别的窗口拉起的同一套；
   * `external` = 用户用 `dshChat.url` 指定的外部服务器。
   *
   * 注意：**它与"谁负责杀"已经无关**（现在是 supervisor 负责），只用于界面文案与诊断。
   */
  ownership: Ownership;
}

export type Ownership = "self" | "peer" | "external";
export type ServerState = "stopped" | "starting" | "ready" | "failed";

/**
 * 后台**现在到底在不在跑**（只读探测，绝不启动任何东西）。
 *
 * 单独一个类型是因为"要不要自动重连"完全由它决定（用户 2026-09-14 口径）：
 * 守护进程还在 → 自动接上并重试到成功；不在 → 界面只给「启动服务器」按钮。
 */
export interface RunningSnapshot {
  /** 会合目录里有会合文件（诊断用：没有 = 从没起过，或被 supervisor 收尾删掉了）。 */
  hasState: boolean;
  /** 守护进程进程还在。 */
  supervisorAlive: boolean;
  /** dsh 真的在监听会合文件里的地址。 */
  serverAlive: boolean;
  /** 守护进程正在拉起 dsh（还没就绪）。 */
  starting: boolean;
  baseUrl?: string;
  supervisorPid?: number;
  serverPid?: number;
}

/**
 * 后台没有在跑，而本次调用**不允许**启动一套。
 *
 * 调用方据此把界面切到"已停止 + 启动服务器按钮"，而不是当成连接失败
 * （那是两件不同的事：失败要重试，没启动要用户点头）。
 */
export class ServerNotRunningError extends Error {
  constructor() {
    super("@serverNotRunning");
    this.name = "ServerNotRunningError";
  }
}

/**
 * 用户点了「停止连接」/「停止服务器」：**在途的等待立刻让位**。
 *
 * 这不是失败（对方没坏），也不是"后台没在跑"（对方可能正在起）：它是一条
 * **用户指令**的产物，所以调用方只把界面切回 `stopped`（给「尝试重连」），
 * 不报错误详情、也不重试。
 */
export class WaitCancelledError extends Error {
  constructor() {
    super("wait cancelled by user");
    this.name = "WaitCancelledError";
  }
}

/** `ensure()` 的许可参数（见文件头「启动决策」）。省略时取 `options.autoStart`。 */
export interface EnsureOptions {
  /** true = 允许在后台不存在时拉起一套；false = 只接上已经在跑的。 */
  start?: boolean;
}

export interface ServerStatus {
  state: ServerState;
  info?: ServerInfo;
  detail?: string;
}

export interface ManagerOptions {
  /** 用户配置的外部地址（`dshChat.url`）；非空即外部模式。 */
  url: string;
  /** 启动命令（`dshChat.command`，原样执行、不追加参数）。 */
  command: string;
  /** 空闲阈值（秒）：写进会合文件，supervisor 热读。 */
  idleSec?: number;
  /**
   * `dshChat.autoStart`：**自动**路径是否允许"后台不存在时自己拉起一套"（默认 true）。
   *
   * 只约束自动路径（激活期的自动连接、5 秒一次的心跳自检）。用户显式动作走
   * `ensure({ start: true })`，一律覆盖它。
   */
  autoStart?: boolean;
  workspace?: string;
  /** 配置分组（由有效配置算出的指纹）。**省缺时按命令算**（与扩展的 `leaseGroupKey` 同构）。 */
  group?: string;
  /** 拉起 supervisor 的真实实现。省缺时自动找 `dist/supervisor.js`（探针走这条）。 */
  launcher?: SupervisorLauncher;
  /** 扩展安装目录（给启动器找脚本用）。 */
  extensionPath?: string;
  /** VS Code 的 `vscode.env.appRoot`（扩展宿主里传；探针不传）。 */
  appRoot?: string;
  log: (line: string) => void;
}

/**
 * 分组指纹：由**有效配置**算出来（与 `extension.ts` 的 `leaseGroupKey` 同构）。
 *
 * 单独放这里是为了让探针也能用同一套算法——它们只给命令而不给分组，
 * 而"分组算错"的后果是两个窗口互相看不见对方的后台（各起一个）。
 */
export function groupForConfig(url: string, command: string): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "");
  const identity = trimmed ? `external:${trimmed}` : `internal:${command}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

/** 连接状态的推送里带的"有多少个窗口在用"。 */

export class SupervisorManager {
  private status: ServerStatus = { state: "stopped" };
  private readonly listeners = new Set<(status: ServerStatus) => void>();
  private connection: SupervisorConnection | undefined;
  private heartbeatHook: (() => void) | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private ensurePromise: Promise<ServerInfo> | undefined;
  /**
   * 在途的"等就绪/等新地址"（`beginWait` 登记、`endWait` 注销）。
   *
   * 等待**没有时长上限**，能结束它的只有两件事：真的就绪，或用户按钮
   * （「停止连接」/「停止服务器」→ `cancelWaiting`）。少了中断这一半，
   * "无上限"就会退化成"点了停止还在等"。
   *
   * 用**集合**而不是单个控制器：同时可能有两轮在等（`ensure()` 那一轮 +
   * 「重启服务器」等新地址那一轮），而**后开的绝不能把先开的顶掉**——
   * 顶掉过一次（顶掉的写法见 git 历史）：重启那一轮被心跳发起的 ensure 中止，
   * 于是"重启完成"的收尾与提示全被跳过。用户叫停时两轮一起中断才是对的。
   */
  private readonly waits = new Set<AbortController>();
  /**
   * 本轮 `bringUp` 有没有拿到"可以拉起一套"的许可（见文件头的启动决策）。
   *
   * 它是**本轮**的暂态而不是配置快照：并发调用会合并到同一次 `bringUp`，
   * 许可按最宽的那个算（用户点「启动服务器」时，正好在跑的心跳自检不该把它降级掉）。
   */
  private startAllowed = false;
  private disposed = false;
  /**
   * 用户按过「停止服务器」：**不许**自动重连、也不许自动拉起，直到用户显式要求
   * （点「启动服务器」/发消息/重启服务器，任何一条都会走 `bringUp` 清掉它）。
   *
   * 与 `disposed` 分开：`disposed` 是"本窗口退出了"（心跳也停），这个是"后台是用户
   * 主动停的"——心跳要继续跑，别的窗口把后台重新起起来时这边要能自动接上。
   */
  private stoppedByUser = false;
  private state: SupervisorState | undefined;
  private launched = false;
  /** supervisor 报的**活连接数**（它才是"还有几个人在用"的唯一裁决者）。 */
  private clientCount = 1;
  private readonly hostId = `win-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly directory: string;
  private readonly group: string;
  private readonly launcher: SupervisorLauncher;

  constructor(private readonly options: ManagerOptions) {
    this.group = options.group ?? groupForConfig(options.url ?? "", options.command);
    this.directory = supervisorDirectory(this.group);
    this.launcher =
      options.launcher ??
      createDefaultSupervisorLauncher({ extensionPath: options.extensionPath, appRoot: options.appRoot, log: options.log });
    // 心跳**常驻**（旧实现只在连上 socket 之后才开）：它现在同时承担"后台还在吗"的
    // 巡检——关掉自动启动时，正是这一次巡检发现"守护进程起来了"并自动接上，
    // 而不会自己去拉起一套。控制器的心跳自检（`onHeartbeat`）也挂在同一个节拍上。
    this.startHeartbeat();
  }

  // ---------- 对外只读信息 ----------

  getStatus(): ServerStatus {
    return this.status;
  }

  onDidChangeStatus(listener: (status: ServerStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  get externalUrl(): string | undefined {
    const url = this.options.url?.trim();
    return url ? url.replace(/\/+$/, "") : undefined;
  }

  /** 当前生效的地址（连接用）。 */
  get activeBaseUrl(): string | undefined {
    return this.status.info?.baseUrl;
  }

  /** supervisor 与本窗口共用的日志文件（诊断命令展示用）。 */
  get logPath(): string {
    return logFileIn(this.directory);
  }

  /** 会合目录（诊断命令展示用）。 */
  get rendezvousDirectory(): string {
    return this.directory;
  }

  /** 当前这一套的世代（pid@启动时刻）；没有时返回 undefined。 */
  get generation(): string | undefined {
    return this.state ? generationOf(this.state) : undefined;
  }

  logTail(lines = 12): string {
    try {
      const text = readFileSync(this.logPath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-lines)
        .join("\n");
    } catch {
      return "";
    }
  }

  /**
   * dsh 起不来时最可能的原因是崩溃遗留的 writer 锁（沿用旧实现的经验）。
   *
   * 刻意返回**普通文本**而不是 `@标记`：它是附在错误详情里的诊断提示
   * （和日志尾巴同一类内容，`@serverLogTail` 那种），不该再走一遍界面词典；
   * 而且带 `@` 会被 i18n 断言判成"未登记的标记"（实测当场抓到了）。
   */
  staleLockHint(): string | undefined {
    const tail = this.logTail(20);
    if (/writer lock|timed out waiting/i.test(tail)) {
      return "hint: dsh 可能在等一把遗留的 writer 锁（.credentials.yaml），用「DSH: 启动服务器」重试一次通常就好了";
    }
    return undefined;
  }

  /**
   * 共享情况（诊断 + 「接入共享后台」的提示文案用）。
   *
   * `hostCount` 是 supervisor 报的**活连接数**（它才是唯一裁决者）；
   * `ownership` 只表示"这套是不是本窗口拉起的"，与"谁负责杀"无关。
   */
  sharedSummary(): { ownership: Ownership; serverPid?: number; hostCount: number } | undefined {
    if (this.externalUrl) return { ownership: "external", hostCount: 1 };
    const state = this.state;
    if (!state) return undefined;
    return {
      ownership: this.launched ? "self" : "peer",
      serverPid: state.serverPid,
      hostCount: Math.max(1, this.clientCount),
    };
  }

  onHeartbeat(hook: () => void): void {
    this.heartbeatHook = hook;
  }

  // ---------- 只读探测（绝不启动任何东西） ----------

  /** 自动路径允许拉起一套吗（`dshChat.autoStart`，缺省 true）。 */
  canStart(): boolean {
    return this.options.autoStart ?? true;
  }

  /**
   * 后台现在在不在跑。
   *
   * **异步**（不像旧的 5 秒心跳里那个 `tcpReachableSync`）：Windows 上那个同步探测
   * 要 spawn 一个 PowerShell，几秒一次地把扩展宿主冻住百来毫秒，不值得。
   */
  async probeRunning(): Promise<RunningSnapshot> {
    const state = readState(this.directory);
    if (!state) {
      return { hasState: false, supervisorAlive: false, serverAlive: false, starting: false };
    }
    const supervisorAlive = isProcessAlive(state.supervisorPid);
    const serverAlive = supervisorAlive && Boolean(state.baseUrl) && (await this.tcpReachable(state.baseUrl!));
    return {
      hasState: true,
      supervisorAlive,
      serverAlive,
      starting: state.starting,
      baseUrl: state.baseUrl,
      supervisorPid: state.supervisorPid,
      serverPid: state.serverPid,
    };
  }

  /**
   * 会合文件里**现读**一份启动令牌。
   *
   * 用途只有一个：本窗口刚用过的那份令牌被服务端拒了（守护进程在我们换 cookie 的
   * 空档里重起了 dsh、换了新令牌），重读一次再用，而不是把用户丢给"输入令牌"。
   */
  freshToken(): string | undefined {
    return readState(this.directory)?.token;
  }

  /** 异步探一个地址上有没有人监听（几毫秒级；失败即 false）。 */
  private tcpReachable(baseUrl: string, timeoutMs = 1_200): Promise<boolean> {
    let host: string;
    let port: number;
    try {
      const url = new URL(baseUrl);
      host = url.hostname;
      port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    } catch {
      return Promise.resolve(false);
    }
    if (!host || !Number.isInteger(port) || port <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const socket = connectTcp({ host, port });
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }

  // ---------- 状态 ----------

  private setStatus(next: ServerStatus): void {
    this.status = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // 监听者自己出错不该影响管理器
      }
    }
  }

  // ---------- 主流程 ----------

  /**
   * 确保有一个可用后台。
   *
   * 三条分支：外部模式只探测；内部模式"守护进程还在就接入，不在才（有许可时）拉起"。
   * 全程幂等（`ensurePromise` 合并并发调用，许可按最宽的那个算）。
   *
   * `options.start` 决定"后台不存在时允不允许拉一套"；省略时取 `dshChat.autoStart`。
   * 不允许时会抛 `ServerNotRunningError`（界面据此切到"已停止 + 启动服务器"，
   * 而不是当成连接失败去重试）。
   */
  async ensure(options: EnsureOptions = {}): Promise<ServerInfo> {
    const external = this.externalUrl;
    if (external) {
      this.setStatus({ state: "starting", detail: `connecting ${external}` });
      // 外部地址**同样等到底**（没有"到点就报连不上"这一档）：连上，或用户点「停止连接」。
      // 口径与内部模式一致——状态只由真实事件与用户按钮改变（用户 2026-09-14 口径）。
      const wait = this.beginWait();
      try {
        if (!(await this.waitForHttp(external, wait.signal))) throw new WaitCancelledError();
      } finally {
        this.endWait(wait);
      }
      const info: ServerInfo = { baseUrl: external, owned: false, ownership: "external" };
      this.setStatus({ state: "ready", info });
      return info;
    }
    // 已经就绪**且长连接还在**才算数：只看状态会在"地址还在、连接没了"时误判成已完成
    // （实测：restart 之后状态是 ready、连接却没重建，于是再也收不到状态推送）
    if (this.status.state === "ready" && this.status.info && this.connection?.connected) return this.status.info;
    if (options.start ?? this.canStart()) this.startAllowed = true;
    this.ensurePromise ??= this.bringUp().finally(() => {
      this.ensurePromise = undefined;
      this.startAllowed = false;
    });
    return this.ensurePromise;
  }

  // ---------- 等待的中断（用户按钮） ----------

  /** 登记一轮等待，返回它的中断器（可以同时有多轮，见 `waits` 字段注释）。 */
  private beginWait(): AbortController {
    const controller = new AbortController();
    this.waits.add(controller);
    return controller;
  }

  private endWait(controller: AbortController): void {
    this.waits.delete(controller);
  }

  /**
   * 用户点了「停止连接」/「停止服务器」：让**所有在途的等待**立刻让位。
   *
   * **不碰任何进程**（本文件那条纪律）：守护进程与 dsh 的生死照旧归 supervisor。
   * 界面侧把这件事当"用户叫停"，不当失败（见 `WaitCancelledError`）。
   */
  cancelWaiting(): void {
    const live = [...this.waits];
    this.waits.clear();
    for (const controller of live) controller.abort();
  }

  private async bringUp(): Promise<ServerInfo> {
    this.disposed = false;
    this.stoppedByUser = false;
    this.setStatus({ state: "starting" });
    const wait = this.beginWait();
    try {
      return await this.bringUpWith(wait.signal);
    } finally {
      this.endWait(wait);
    }
  }

  /**
   * `bringUp` 的本体：等待一律走 `signal`（用户按钮可中断），
   * **没有任何时长判据**（超时不再改写状态）。
   */
  private async bringUpWith(signal: AbortSignal): Promise<ServerInfo> {
    // ① 守护进程还活着 → **只接入，绝不另起一套**（见文件头的启动决策）
    const existing = readState(this.directory);
    if (existing && isProcessAlive(existing.supervisorPid)) {
      this.launched = false;
      this.state = existing;
      // 先连上它的 socket 再谈别的：连接本身就是"我在用"，守护进程据此会把
      // 崩掉的 dsh 重新拉起（它只在有活连接时才重起 dsh）
      if (!this.connection?.connected) await this.connect(existing);
      if (existing.baseUrl && existing.token && (await this.usable(existing))) {
        return this.publishReady(existing);
      }
      // 它正在拉起（或刚被我们唤醒）→ 等它写出一份可用状态。
      // **等多久不由时钟决定**：一直等到就绪，或用户点「停止连接」（用户 2026-09-14 口径）。
      const state = await waitForReadyState({
        group: this.group,
        signal,
        usable: (candidate) => this.usable(candidate),
        onTick: (tick) => {
          if (tick) {
            this.state = tick;
            this.setStatus({ state: "starting", detail: tick.starting ? "starting server" : undefined });
          }
        },
      });
      if (signal.aborted) throw new WaitCancelledError();
      if (!state) throw this.startFailure(state);
      return this.publishReady(state);
    }

    // ①' 会合文件在、但守护进程已死：崩溃残留（留给下一次决策，顺带记一条日志）
    if (existing) {
      this.options.log(`[supervisor] 会合文件指向的 supervisor（pid=${existing.supervisorPid}）已不在，重新起一套`);
    }

    // ② 守护进程不在：**只有拿到许可**才拉一套
    if (!this.startAllowed) {
      this.options.log("[supervisor] 后台没有在跑，且本次调用不允许启动（dshChat.autoStart 关掉时只显示启动按钮）");
      this.setStatus({ state: "stopped", detail: "@serverNotRunning" });
      throw new ServerNotRunningError();
    }

    const ensured = await ensureSupervisor({
      group: this.group,
      command: this.options.command,
      idleSec: clampIdleSec(this.options.idleSec ?? IDLE_SEC_DEFAULT),
      launcher: this.launcher,
      log: this.options.log,
      usable: (state) => this.usable(state),
    });
    if (ensured.error) {
      this.setStatus({ state: "failed", detail: ensured.error });
      throw new Error(ensured.error);
    }
    this.launched = ensured.launched;
    // 已经就绪的话直接用；否则等（supervisor 正在起 dsh）
    let state = ensured.state && ensured.state.baseUrl ? ensured.state : undefined;
    if (!state) {
      state = await waitForReadyState({
        group: this.group,
        signal,
        usable: (candidate) => this.usable(candidate),
        onTick: (tick) => {
          if (tick) {
            this.state = tick;
            this.setStatus({ state: "starting", detail: tick.starting ? "starting server" : undefined });
          }
        },
      });
    }
    if (signal.aborted) throw new WaitCancelledError();
    if (!state) throw this.startFailure(state);
    return this.publishReady(state);
  }

  /**
   * 一份状态可用时收尾：记下来、报就绪、建立/恢复长连接。
   *
   * 缺地址或令牌时按"还没就绪"抛错——错误详情里会写清**到底缺哪一样**
   * （否则只剩一条没头没脑的失败，排查时完全看不出方向）。多窗口接入靠的就是
   * 会合文件里那份令牌：`token` 是 supervisor 写进去的、跨窗口共用的唯一凭据。
   */
  private async publishReady(state: SupervisorState): Promise<ServerInfo> {
    if (!state.baseUrl || !state.token) throw this.startFailure(state);
    const info: ServerInfo = {
      baseUrl: state.baseUrl,
      token: state.token,
      owned: this.launched,
      ownership: this.launched ? "self" : "peer",
    };
    this.state = state;
    this.setStatus({ state: "ready", info });
    // **始终建立/恢复长连接**（哪怕这一套早就在跑）：`ensure()` 会在"地址还在、但连接没了"
    // 时被再次调用（restart、连接断开、命令手动连），此时跳过 connect() 就会留下
    // "状态 ready、其实没连着"的假象（实测：restart 之后本窗口再也收不到状态推送）。
    if (!this.connection?.connected) await this.connect(state);
    return info;
  }

  /** 启动/等待失败时的错误（详情含"缺哪一样"、遗留锁提示与日志尾部）。 */
  private startFailure(state: SupervisorState | undefined): Error {
    const tail = this.logTail();
    const detail = [
      "@serverNotReady",
      `detail: state=${state ? `url=${state.baseUrl ?? "无"} token=${state.token ? "有" : "无"} starting=${state.starting}` : "（会合文件不存在）"}`,
      this.staleLockHint(),
      tail && `@serverLogTail:${tail}`,
    ]
      .filter(Boolean)
      .join("\n");
    this.setStatus({ state: "failed", detail });
    return new Error(detail);
  }

  /**
   * 会合文件里那一套还可用吗：supervisor 进程在 + （就绪后）地址连得上。
   *
   * **整体包 try/catch**：它是轮询里的判据，任何一处抛出去都会把"等待就绪"整段打断，
   * 而错误信息会伪装成一次失败（实测踩到：探针里表现为几百毫秒就报失败，
   * 看着像对方坏了，其实是判据自己炸了）。判据的纪律是：**拿不到证据就当"还不可用"**，
   * 让轮询继续，而不是把异常抛给上层。
   */
  private async usable(state: SupervisorState): Promise<boolean> {
    try {
      if (!isProcessAlive(state.supervisorPid)) return false;
      if (!state.baseUrl) return state.starting; // 正在启动：算"可用"，交给等待逻辑
      return await this.tcpReachable(state.baseUrl);
    } catch {
      return false;
    }
  }

  /**
   * 连上 supervisor 的 socket 并保持长连接。
   *
   * 连接本身就是"我在用"——断开即表示本窗口不再使用；**不杀任何东西**。
   * 断开后按 `HEARTBEAT_MS` 的节拍尝试重连（后台可能被重启成新地址）。
   */
  private async connect(state: SupervisorState): Promise<void> {
    this.connection?.close();
    const connection = new SupervisorConnection(
      state.socket,
      {
        onState: (next, clients) => this.onStatePush(next, clients),
        onGoodbye: (reason) => {
          this.options.log(`[supervisor] supervisor 告别（${reason}）`);
          this.connection = undefined;
          this.setStatus({ state: "stopped", detail: `supervisor ${reason}` });
        },
        onClosed: (reason) => {
          this.options.log(`[supervisor] 与 supervisor 的连接断开：${reason}`);
          this.connection = undefined;
        },
        log: this.options.log,
      },
      { hostId: this.hostId, workspace: this.options.workspace },
    );
    const ok = await connection.open();
    if (!ok) {
      this.options.log("[supervisor] 连不上 supervisor 的 socket，将在心跳里重试");
      return;
    }
    this.connection = connection;
    this.startHeartbeat();
  }

  private onStatePush(next: SupervisorState | null, clients?: number): void {
    if (!next) return;
    const previous = this.state;
    this.state = next;
    if (typeof clients === "number" && clients > 0) {
      if (clients !== this.clientCount) {
        this.options.log(`[supervisor] 在用的窗口数：${this.clientCount} → ${clients}`);
      }
      this.clientCount = clients;
    }
    const changed = !previous || previous.baseUrl !== next.baseUrl || previous.serverPid !== next.serverPid;
    if (next.baseUrl && next.token) {
      const info: ServerInfo = {
        baseUrl: next.baseUrl,
        token: next.token,
        owned: this.launched,
        ownership: this.launched ? "self" : "peer",
      };
      if (changed) {
        this.options.log(`[supervisor] 后台就绪：${next.baseUrl}`);
        this.setStatus({ state: "ready", info });
      } else if (this.status.state !== "ready") {
        this.setStatus({ state: "ready", info });
      }
    } else if (next.starting) {
      this.setStatus({ state: "starting", detail: "starting server" });
    }
  }

  /**
   * 心跳：只做"连接还在吗 / 该不该重连"。
   *
   * **不做**旧实现那套"判还有没有别的窗口、决定要不要杀"——那件事已经由 supervisor
   * 按连接数自己裁决了。也**不做**"后台不在就自己拉一套"，除非 `autoStart` 允许
   * （见文件头的启动决策）：关掉自动启动的用户要的是"没启动就显示按钮"。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async heartbeatTick(): Promise<void> {
    if (this.disposed) return;
    // 让控制器做它那侧的体检（连接存活 / 跟随换了地址的后台 / 该不该继续重连）
    try {
      this.heartbeatHook?.();
    } catch (error) {
      this.options.log(`[supervisor] 心跳自检失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.connection?.connected) return;
    if (this.externalUrl) return;
    // 连接没了：先看会合文件里那一套还在不在；在就接上（连接本身就是"我在用"）
    const state = readState(this.directory);
    if (state && isProcessAlive(state.supervisorPid)) {
      this.state = state;
      await this.connect(state);
      return;
    }
    // 守护进程不在了：关掉自动启动、或用户刚按过「停止服务器」时，**不许**自己拉一套
    if (this.stoppedByUser || !this.canStart()) {
      if (this.status.state !== "stopped") {
        this.options.log(
          this.stoppedByUser
            ? "[supervisor] 用户已停止服务器：不自动拉起（界面给「启动服务器」）"
            : "[supervisor] 守护进程不在了；已关闭自动启动，不自行拉起（界面给「启动服务器」）",
        );
        this.setStatus({ state: "stopped", detail: "@serverNotRunning" });
      }
      return;
    }
    this.options.log("[supervisor] 会合文件不在了（或 supervisor 已退出），重新确保一套");
    this.setStatus({ state: "stopped" });
    try {
      await this.ensure({ start: true });
    } catch (error) {
      this.options.log(`[supervisor] 重新确保后台失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------- 用户命令 ----------

  /**
   * 「重启服务器」：把请求交给 supervisor（它杀掉 dsh 再拉起一个），并等新地址。
   *
   * 与旧实现的关键差别：旧的是扩展自己 `taskkill` + 自己起进程；现在是**请求**，
   * 由唯一持有者执行。代价是其余窗口会短暂断连（它们的心跳会发现新地址并重连）。
   */
  async restart(): Promise<ServerInfo> {
    if (this.externalUrl) {
      const info = { baseUrl: this.externalUrl, owned: false, ownership: "external" as const };
      this.setStatus({ state: "ready", info });
      return info;
    }
    const previous = this.state?.serverPid;
    if (!this.connection?.connected) {
      this.options.log("[supervisor] 重启请求：连接不在，先重新确保一套");
      // 「重启服务器」是**用户显式动作**：允许拉起一套（关掉自动启动时也算数）
      return this.ensure({ start: true });
    }
    this.options.log("[supervisor] 重启请求：交给 supervisor 执行");
    this.setStatus({ state: "starting", detail: "restarting server" });
    this.connection.control("restart");
    // **刻意不断开这条连接**（踩过）：断开会立刻变成"0 个窗口在用"——`--idle-sec` 一过
    // supervisor 就自己退场，而重起 dsh 要 5~8 秒，于是它会在半路把自己收走
    // （实测：会合文件被删、新地址只出现在日志里）。连接本身也是"我还在用"的凭据。
    //
    // 等新地址**同样没有时长上限**（用户 2026-09-14 口径）：等到就绪，或用户点
    // 「停止连接」——时钟不替用户判定"重起失败了"。
    const wait = this.beginWait();
    const signal = wait.signal;
    try {
      // 必须先看到 supervisor 把"连接信息清空（正在重起）"写出来，才认后面那个新地址。
      // 否则会在它还没开始重起时读到**旧的**那一份（时间上完全可能：控制消息才刚发出去），
      // 于是"重启完成"返回的其实是旧后台（实测偶发，表现为令牌没变、地址照旧）。
      let sawReset = false;
      while (!signal.aborted) {
        await delay(500);
        if (signal.aborted) break;
        const state = readState(this.directory);
        if (!state?.baseUrl) {
          sawReset = true;
          continue;
        }
        if (state.starting) continue;
        if (!sawReset && state.serverPid === previous) continue; // 还没开始重起，等
        const serving = await this.usable(state);
        if (serving) {
          this.options.log(`[supervisor] 重启完成：${state.baseUrl}（server=${state.serverPid ?? "?"}）`);
          return this.ensure({ start: true });
        }
      }
      this.options.log("[supervisor] 等新地址被用户中止（「停止连接」）");
      throw new WaitCancelledError();
    } finally {
      this.endWait(wait);
    }
  }

  /**
   * 「停止服务器」：请 supervisor 连 dsh 一起收场并退出。
   *
   * 本窗口只发请求 + 关连接；**不自己 taskkill**（那条纪律的落点）。
   */
  async stopAndExit(): Promise<void> {
    // **心跳继续跑**（不 stopHeartbeat）：别的窗口把后台重新起起来时，本窗口要能自动接上。
    // 抑制"自动拉起"改用 `stoppedByUser`（见字段注释）。
    this.stoppedByUser = true;
    // 在途的"等就绪/等新地址"立刻让位：用户已经明确要停了，不需要再等出结果
    this.cancelWaiting();
    const connection = this.connection;
    if (connection?.connected) {
      this.options.log("[supervisor] 停止请求：交给 supervisor 执行");
      connection.control("stop");
    }
    connection?.close();
    this.connection = undefined;
    this.setStatus({ state: "stopped", detail: "@serverStopped" });
  }

  /** 旧接口名（扩展里 `dispose()` 语义）：**只关自己的连接**，不杀任何进程。 */
  dispose(): void {
    this.disposed = true;
    // 在途的等待没有时长上限：本窗口要走了就别再留着它空转（只停等待，不碰后台）
    this.cancelWaiting();
    this.stopHeartbeat();
    this.connection?.close();
    this.connection = undefined;
  }

  /** 旧接口名：显式停止（命令用）。 */
  async stop(): Promise<void> {
    await this.stopAndExit();
  }

  /** 供断言/探针：当前会合状态。 */
  peekState(): SupervisorState | undefined {
    return this.state ?? readState(this.directory);
  }

  /**
   * 等这个外部地址上真的有人应答：**没有时长上限**，一轮轮探测到连通，或用户叫停。
   *
   * 单次探测自己仍然有 2 秒上限（`reachable` 的 fetch 超时）——那是"这一次探测等多久"，
   * 不是"等多久就放弃"。第一次探不通时把原因同时写进日志与状态详情
   * （`@serverUnreachable`，界面据此在连接条上说明"地址连不上、还在重试"）：
   * 地址填错时用户不必点开日志才知道。
   */
  private async waitForHttp(baseUrl: string, signal: AbortSignal): Promise<boolean> {
    let announced = false;
    while (!signal.aborted) {
      if (await this.reachable(baseUrl)) return true;
      if (!announced) {
        announced = true;
        this.options.log(`[supervisor] ${baseUrl} 暂时连不上（外部服务器），继续重试到连上或用户点「停止连接」`);
        this.setStatus({ state: "starting", detail: `@serverUnreachable:${baseUrl}` });
      }
      await delay(300, undefined, { signal }).catch(() => undefined);
    }
    return false;
  }

  private async reachable(baseUrl: string): Promise<boolean> {
    try {
      await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      return true;
    } catch (error) {
      // 401/403 也算"这个地址上有东西"（沿用旧实现的口径）
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code === "ECONNREFUSED" ? false : !/fetch failed/i.test(String(error));
    }
  }
}

/** 心跳节拍：与旧实现一致（5s）。 */
const HEARTBEAT_MS = 5_000;

/** 只有 socket 连不上、且 supervisor 进程也活着时，等它一次（避免立刻重起一套）。 */
export async function waitForSocket(socketPath: string, timeoutMs = 3_000): Promise<boolean> {
  const socket = await connectToSupervisor(socketPath, timeoutMs);
  if (!socket) return false;
  socket.destroy();
  return true;
}
