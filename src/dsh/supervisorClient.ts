/**
 * 扩展侧：找 supervisor、必要时拉起它、并保持一条长连接（设计见 `docs/design-supervisor.md`「启动协议」「长连接与自检」）。
 *
 * **纪律（本次架构改动最重要的一条）**：扩展只负责"找到/拉起/连上"和"关自己的连接"。
 * 杀 dsh 永远是 supervisor 的事——今天所有麻烦都源于"扩展也在杀 dsh"。
 *
 * 三件事分开，便于离线断言：
 * 1. `readState`（`supervisorProtocol`）：读会合文件；
 * 2. `SupervisorLauncher`：**怎么把一个 supervisor 拉起来**（真实实现用 VS Code 自带 Node
 *    spawn `dist/supervisor.js`；断言里换成假的，于是"并发只起一个"这类逻辑可以离线测）；
 * 3. `SupervisorConnection`：连上 socket、1s 一次 ping、接收状态推送与告别。
 */
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  IDLE_SEC_DEFAULT,
  PING_INTERVAL_MS,
  acquireStartLock,
  clampIdleSec,
  readState,
  releaseStartLock,
  rendezvousPaths,
  supervisorDirectory,
  type SupervisorState,
} from "./supervisorProtocol";
import { LineDecoder, decodeServerMessage, encodeMessage, type GoodbyeReason } from "./supervisorWire";

/** 拉起 supervisor 的结果：成功（已写会合文件）或失败原因（人话，直接进界面/日志）。 */
export type LaunchOutcome = { ok: true } | { ok: false; reason: string };

/**
 * 拿到启动锁之后、真正 spawn 之前再等这么久，复查一次"别人是不是已经起好了"。
 *
 * 并发窗口实测会走到"两个都判定要起"（锁只串行化决策，拿锁与 spawn 之间有时间差）。
 * 300ms 足够让先启动的那个把会合文件写出来（它写文件在 spawn **之前**，见 supervisor 的
 * `runSupervisor`：先 listen + publish 才去起 dsh），而这个等待只发生在"本窗口负责启动"那一次。
 */
const START_DECISION_SETTLE_MS = 300;

/**
 * 拉起一个 supervisor。
 *
 * 真实实现见 `createSupervisorLauncher`（扩展宿主里用）；断言与探针可以给假的，
 * 于是"需要时才起、并发只起一个"这层逻辑不必真起进程就能测。
 */
export interface SupervisorLauncher {
  launch(input: { directory: string; command: string; idleSec: number; socket: string }): Promise<LaunchOutcome>;
}

/**
 * 写入会合文件所需的最小集合（supervisor 起来后自己是权威，这些只是"起跑参数"）。
 *
 * **socket 地址只由 `rendezvousPaths` 算一处**（见 `supervisorProtocol`）：它由会合目录
 * 决定，与传不传分组无关——分组只用来找目录（`supervisorDirectory`）。
 */
export function initialStartInput(options: {
  directory: string;
  command: string;
  idleSec?: number;
}): { directory: string; command: string; idleSec: number; socket: string } {
  return {
    directory: options.directory,
    command: options.command,
    idleSec: clampIdleSec(options.idleSec ?? IDLE_SEC_DEFAULT),
    socket: rendezvousPaths(options.directory).socket,
  };
}

/** 连上 supervisor 的 socket（拿不到返回 undefined，**不抛**）。 */
export function connectToSupervisor(socketPath: string, timeoutMs = 3_000): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(socketPath);
    const finish = (value: Socket | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(undefined);
    }, timeoutMs);
    socket.once("connect", () => finish(socket));
    socket.once("error", () => finish(undefined));
  });
}

/**
 * 一条常驻连接：负责 ping、接收状态推送、接收 goodbye。
 *
 * 断开时**不自己重连**：重连的决策属于上层（它知道当前是"窗口要退出了"还是"后台该重拉了"），
 * 这里只如实报告断开。
 */
export class SupervisorConnection {
  private socket: Socket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly decoder = new LineDecoder();
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly handlers: {
      onState: (state: SupervisorState | null, clients: number | undefined) => void;
      onGoodbye: (reason: GoodbyeReason) => void;
      onClosed: (reason: string) => void;
      /**
       * 守护进程上报的**内部异常**（协议 `t:"error"`）。
       *
       * 转发进 VS Code 输出通道「DSH Chat」——守护进程自己的日志在
       * `~/.dsh/dsh-chat-vscode/supervisors/<分组>/supervisor.log`，用户不会去翻那个文件，
       * 而"守护进程内部出错"过去的表现就是"后台莫名不重启"。
       */
      onError?: (kind: string, message: string) => void;
      log: (line: string) => void;
    },
    private readonly hello: { hostId: string; pid?: number; workspace?: string },
  ) {}

  /** 连接并开始心跳。成功返回 true。 */
  async open(): Promise<boolean> {
    const socket = await connectToSupervisor(this.socketPath);
    if (!socket) return false;
    this.socket = socket;
    this.closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => {
      this.stopTimer();
      if (!this.closed) this.handlers.onClosed("连接已断开");
    });
    socket.on("error", (error: Error) => {
      this.stopTimer();
      if (!this.closed) this.handlers.onClosed(error.message);
    });
    socket.write(
      encodeMessage({
        t: "hello",
        hostId: this.hello.hostId,
        pid: this.hello.pid ?? process.pid,
        workspace: this.hello.workspace,
      }),
    );
    this.timer = setInterval(() => {
      try {
        socket.write(encodeMessage({ t: "ping" }));
      } catch {
        // 写失败由 close/error 事件收尾
      }
    }, PING_INTERVAL_MS);
    this.timer.unref?.();
    return true;
  }

  /** 发一条控制请求（restart / stop）。 */
  control(action: "restart" | "stop"): void {
    try {
      this.socket?.write(encodeMessage({ t: "control", action }));
    } catch {
      // 忽略：连接没了会有 close 事件
    }
  }

  /** 主动关闭（窗口退出时用）。**只关自己的连接，不杀任何进程。** */
  close(): void {
    this.closed = true;
    this.stopTimer();
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      // 忽略
    }
    this.socket = undefined;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.closed;
  }

  private onData(chunk: string): void {
    for (const line of this.decoder.push(chunk)) {
      const message = decodeServerMessage(line);
      if (!message) continue;
      if (message.t === "state") this.handlers.onState(message.state, message.clients);
      else if (message.t === "error") this.handlers.onError?.(message.kind, message.message);
      else if (message.t === "goodbye") {
        this.closed = true;
        this.handlers.onGoodbye(message.reason);
      }
    }
    // 对面一直发不含换行的数据：这条连接已经没有意义（半行被丢弃、后续全忽略），
    // 关掉它让心跳按节拍重连，而不是让缓冲无限长。
    if (this.decoder.isOverflowed) {
      this.handlers.log("[supervisor] socket 单行超长，断开这条连接");
      this.close();
      // `close()` 已置 `closed`，socket 的 close 事件不会再回调；这里显式告诉上层，
      // 免得管理器留着一条"对象在、其实没连着"的连接（心跳下个节拍会重连）。
      this.handlers.onClosed("单行超长");
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** 一次"确保有 supervisor 可用"的结果，供上层决定"接上 / 等待 / 报错"。 */
export interface EnsureSupervisorResult {
  state?: SupervisorState;
  /** 拉起了新的一套（本窗口是启动者）。 */
  launched: boolean;
  /** 失败原因（人话）。 */
  error?: string;
}

/**
 * 确保有 supervisor：读会合文件 → 有就返回；没有就**抢锁 + 拉起**。
 *
 * 抢不到锁说明别的窗口正在起：返回 `state: undefined, launched: false`，
 * 由上层轮询等待（不要在这里 sleep，上层才知道该等多久、要不要给界面反馈）。
 */
export async function ensureSupervisor(options: {
  group: string;
  command: string;
  idleSec?: number;
  launcher: SupervisorLauncher;
  log: (line: string) => void;
  /** 判定"会合文件里那一套还可用吗"（上层用进程存活 + socket 连接一起判）。 */
  usable: (state: SupervisorState) => Promise<boolean>;
}): Promise<EnsureSupervisorResult> {
  const directory = supervisorDirectory(options.group);
  const existing = readState(directory);
  if (existing && (await options.usable(existing))) {
    return { state: existing, launched: false };
  }

  if (!acquireStartLock(directory)) {
    options.log("[supervisor] 启动锁被别的窗口持有，等它把会合文件写出来");
    return { launched: false };
  }
  try {
    // 抢到锁后再读一次：可能在抢锁前的几毫秒里别人已经写好了
    const reread = readState(directory);
    if (reread && (await options.usable(reread))) {
      return { state: reread, launched: false };
    }
    // 抢锁只保证"同一时刻一个窗口在决策"，但**拿锁与 spawn 之间仍有几毫秒**：
    // 并发激活时会出现"两个窗口都判定要起"（实测 3 个窗口同时激活时启动者=2 个）。
    // 这里再等一小会儿复查一次，把那个窗口关掉——重复 spawn 虽然会被 supervisor 的
    // 第二代检测收敛掉，但代价是两个 supervisor 同时去 spawn dsh，固定端口下就会撞车。
    await delay(START_DECISION_SETTLE_MS);
    const settled = readState(directory);
    if (settled && (await options.usable(settled))) {
      options.log("[supervisor] 我拿到锁之前别的窗口已经把它起好了，直接接入");
      return { state: settled, launched: false };
    }
    options.log("[supervisor] 本窗口负责启动 supervisor");
    const outcome = await options.launcher.launch(
      initialStartInput({ directory, command: options.command, idleSec: options.idleSec }),
    );
    if (!outcome.ok) return { launched: false, error: outcome.reason };
    return { launched: true };
  } finally {
    releaseStartLock(directory);
  }
}

/**
 * 等会合文件出现且**真的可用**（supervisor 写完"正在启动"之后还要等 dsh 打印公告行）。
 *
 * 轮询而不是订阅：这一步本来就是"等另一件事发生"，轮询最不容易出错。
 *
 * **没有时长上限**（用户 2026-09-14 口径）：等多久不由时钟决定，只由两件事结束——
 * 真的就绪，或用户点了「停止连接」（`signal` 被 abort）。所以这里不再有 deadline，
 * 也不再有"等到 N 秒就报超时"这一档状态改写。
 */
export async function waitForReadyState(options: {
  group: string;
  usable: (state: SupervisorState) => Promise<boolean>;
  onTick?: (state: SupervisorState | undefined) => void;
  /** 用户按钮（「停止连接」/「停止服务器」）的中断信号：abort 后立刻返回 undefined。 */
  signal?: AbortSignal;
}): Promise<SupervisorState | undefined> {
  const directory = supervisorDirectory(options.group);
  while (!options.signal?.aborted) {
    let state: SupervisorState | undefined;
    try {
      state = readState(directory);
    } catch {
      state = undefined;
    }
    options.onTick?.(state);
    if (state && state.baseUrl) {
      // 判据自己出错时**继续等**，不要把异常抛给调用方（那会被误读成一次失败）
      let ok = false;
      try {
        ok = await options.usable(state);
      } catch {
        ok = false;
      }
      if (ok) return state;
    }
    // abort 时 delay 会抛 AbortError：吃掉它，让 while 条件收尾
    await delay(300, undefined, { signal: options.signal }).catch(() => undefined);
  }
  return undefined;
}
