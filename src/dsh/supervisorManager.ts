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
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { isProcessAlive, tcpReachableSync } from "./processRegistry";

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
  /** 等 dsh 就绪的超时（毫秒）。 */
  startTimeoutMs: number;
  /** 空闲阈值（秒）：写进会合文件，supervisor 热读。 */
  idleSec?: number;
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
  private disposed = false;
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
   * 三条分支：外部模式只探测；内部模式"读会合文件 → 必要时拉起 supervisor → 连上"。
   * 全程幂等（`ensurePromise` 合并并发调用）。
   */
  async ensure(): Promise<ServerInfo> {
    const external = this.externalUrl;
    if (external) {
      this.setStatus({ state: "starting", detail: `connecting ${external}` });
      if (!(await this.waitForHttp(external, 5_000))) {
        const detail = `@serverUnreachable:${external}`;
        this.setStatus({ state: "failed", detail });
        throw new Error(detail);
      }
      const info: ServerInfo = { baseUrl: external, owned: false, ownership: "external" };
      this.setStatus({ state: "ready", info });
      return info;
    }
    // 已经就绪**且长连接还在**才算数：只看状态会在"地址还在、连接没了"时误判成已完成
    // （实测：restart 之后状态是 ready、连接却没重建，于是再也收不到状态推送）
    if (this.status.state === "ready" && this.status.info && this.connection?.connected) return this.status.info;
    this.ensurePromise ??= this.bringUp().finally(() => {
      this.ensurePromise = undefined;
    });
    return this.ensurePromise;
  }

  private async bringUp(): Promise<ServerInfo> {
    this.disposed = false;
    this.setStatus({ state: "starting" });

    // 先把上一轮遗留的崩溃残留处理掉：会合文件在、但 supervisor 进程已死
    const existing = readState(this.directory);
    if (existing && !isProcessAlive(existing.supervisorPid)) {
      this.options.log(`[supervisor] 会合文件指向的 supervisor（pid=${existing.supervisorPid}）已不在，重新起一套`);
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
        timeoutMs: this.options.startTimeoutMs,
        usable: (candidate) => this.usable(candidate),
        onTick: (tick) => {
          if (tick) {
            this.state = tick;
            this.setStatus({ state: "starting", detail: tick.starting ? "starting server" : undefined });
          }
        },
      });
    }
    if (!state?.baseUrl || !state.token) {
      const tail = this.logTail();
      const detail = [
        `@serverStartTimeout:${Math.round(this.options.startTimeoutMs / 1000)}`,
        // 把"到底缺哪一样"写进详情：否则只剩一个超时数字，排查时完全看不出方向
        `detail: state=${state ? `url=${state.baseUrl ?? "无"} token=${state.token ? "有" : "无"} starting=${state.starting}` : "（会合文件不存在）"}`,
        this.staleLockHint(),
        tail && `@serverLogTail:${tail}`,
      ]
        .filter(Boolean)
        .join("\n");
      this.setStatus({ state: "failed", detail });
      throw new Error(detail);
    }

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

  /**
   * 会合文件里那一套还可用吗：supervisor 进程在 + （就绪后）地址连得上。
   *
   * **整体包 try/catch**：它是轮询里的判据，任何一处抛出去都会把"等待就绪"整段打断，
   * 而错误信息会伪装成"启动超时"（实测踩到：探针里表现为几百毫秒就报 `@serverStartTimeout`，
   * 看着像超时，其实是判据自己炸了）。判据的纪律是：**拿不到证据就当"还不可用"**，
   * 让轮询继续，而不是把异常抛给上层。
   */
  private async usable(state: SupervisorState): Promise<boolean> {
    try {
      if (!isProcessAlive(state.supervisorPid)) return false;
      if (!state.baseUrl) return state.starting; // 正在启动：算"可用"，交给等待逻辑
      return tcpReachableSync(state.baseUrl, 1_500);
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
   * 按连接数自己裁决了。
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
    // 让控制器做它那侧的体检（连接存活 / 跟随换了地址的后台）
    try {
      this.heartbeatHook?.();
    } catch (error) {
      this.options.log(`[supervisor] 心跳自检失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.connection?.connected) return;
    if (this.externalUrl) return;
    // 连接没了：先看会合文件里那一套还在不在；不在就重新 ensure 一套
    const state = readState(this.directory);
    if (state && isProcessAlive(state.supervisorPid)) {
      this.state = state;
      await this.connect(state);
      return;
    }
    this.options.log("[supervisor] 会合文件不在了（或 supervisor 已退出），重新确保一套");
    this.setStatus({ state: "stopped" });
    try {
      await this.ensure();
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
      return this.ensure();
    }
    this.options.log("[supervisor] 重启请求：交给 supervisor 执行");
    this.setStatus({ state: "starting", detail: "restarting server" });
    this.connection.control("restart");
    // **刻意不断开这条连接**（踩过）：断开会立刻变成"0 个窗口在用"——`--idle-sec` 一过
    // supervisor 就自己退场，而重起 dsh 要 5~8 秒，于是它会在半路把自己收走
    // （实测：会合文件被删、新地址只出现在日志里）。连接本身也是"我还在用"的凭据。
    const deadline = Date.now() + this.options.startTimeoutMs;
    // 必须先看到 supervisor 把"连接信息清空（正在重起）"写出来，才认后面那个新地址。
    // 否则会在它还没开始重起时读到**旧的**那一份（时间上完全可能：控制消息才刚发出去），
    // 于是"重启完成"返回的其实是旧后台（实测偶发，表现为令牌没变、地址照旧）。
    let sawReset = false;
    while (Date.now() < deadline) {
      await delay(500);
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
        return this.ensure();
      }
    }
    const detail = `@serverStartTimeout:${Math.round(this.options.startTimeoutMs / 1000)}`;
    this.setStatus({ state: "failed", detail });
    throw new Error(detail);
  }

  /**
   * 「停止服务器」：请 supervisor 连 dsh 一起收场并退出。
   *
   * 本窗口只发请求 + 关连接；**不自己 taskkill**（那条纪律的落点）。
   */
  async stopAndExit(): Promise<void> {
    this.disposed = true;
    const connection = this.connection;
    if (connection?.connected) {
      this.options.log("[supervisor] 停止请求：交给 supervisor 执行");
      connection.control("stop");
    }
    connection?.close();
    this.connection = undefined;
    this.stopHeartbeat();
    this.setStatus({ state: "stopped" });
  }

  /** 旧接口名（扩展里 `dispose()` 语义）：**只关自己的连接**，不杀任何进程。 */
  dispose(): void {
    this.disposed = true;
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

  private async waitForHttp(baseUrl: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.reachable(baseUrl)) return true;
      await delay(300);
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
