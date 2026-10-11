/**
 * 连接尝试的账本与收场。
 *
 * 「一次连接尝试」（下称**一轮**；注意与 CONTEXT 里的「轮次」不是一回事——那是用户对话
 * 生成的一轮）从发起到收场要做的事，原本散在控制器连接区域的几个落点上：作废在途轮、
 * 中止管理器那侧的等待、收掉跟随流、dispose 客户端、交还内部后台的占用、请守护进程收场。
 * 每个落点各挑其中几件，**挑错或漏挑都不报错**，只会在用户那里表现为「点了停止过一会儿
 * 又连上了」「点了停止还在转圈」或「停止内部 DSH 把外部那条连接也收掉了」。
 *
 * 这个模块把它们收成两样东西：
 *
 * 1. **账本**：轮次号（在途那一轮还算不算数）、当前客户端（回调身份判据）、用户叫停的闸。
 *    它们必须同一处写、同一处读——分散之后必然出现「作废了 A 却还在按 A 写状态」。
 * 2. **意图 → 动作**：调用方只说「用户要什么」（`stopByUser` / `abandon` / `stopInternal`
 *    / `retarget`），由这里决定调管理器 `stop()` 的哪一档、要不要 dispose、要不要置闸，
 *    以及这些动作的**顺序**。
 *
 * ## 面与能力分开
 *
 * 导出的只有 `ConnectionAttempts`（意图方法 + 两个只读闸）与 `ConnectionRound`（读法 +
 * 它自己那条客户端的手续）。账本的**写能力**——`被顶掉的轮次交回客户端`、`结束这一轮`、
 * `换掉当前客户端`——不在导出面上：它们由闭包持有，或由调用方通过 `clientSlot` 交出存放点
 * 来表达。调用方因此绕不过完整收场（不会出现「只把字段清掉、没 dispose」这种半收场）。
 *
 * ## 收场意图（每一档的差异由本模块说了算）
 *
 * | 意图 | 作废在途轮 | 中止在途等待 | 交还占用 | 请守护进程收场 | 收跟随流 / 客户端 |
 * |---|---|---|---|---|---|
 * | `retarget`（换目标 / 重开一轮） | 是 | 是 | 否 | 否 | 都收 |
 * | `stopByUser`（「停止连接」） | 是 | 是 | 是 | 否 | 都收 |
 * | `abandon`（用户叫停后放弃这一轮） | 否（这一轮自己正在结束） | 否 | 是 | 否 | 收这一轮建的那条 |
 * | `stopInternal`（「停止内部 DSH」） | 是 | 是 | 否 | 是 | 都收 |
 *
 * 长期不变量：
 *
 * - **换目标绝不交还占用**：马上要重新接上的可能是同一个后台，收掉 socket 等于把占用交还，
 *   `ownership` 从 self 掉成 peer，诊断里「是不是本窗口拉起的」随之说谎。
 * - **用户叫停要同时断与挡**：只断不挡 → 心跳会把连接接回来；只挡不断 → 守护进程永远认为
 *   有人用，内部 dsh 不按空闲退场。
 * - **放弃一轮要幂等地再交还一次**：一轮排队／重试可能在叫停之后才走到管理器的 `bringUp`
 *   （它会清掉用户叫停那道闸）并把连接建起来，而控制器随后放弃了这一轮。
 * - **停内部后台时目标不是内部就一个字都不动**：要停的是内部那一套，与外部服务器无关；
 *   本窗口连外部的那条连接（客户端 + 跟随流）与界面状态都不受影响，只有请求照发。
 * - 后台（守护进程 + dsh）的生死不在这里：这里收的只有**本窗口的连接**，进程归守护进程
 *   按「还有没有活连接」自己裁决（见 `docs/design-supervisor.md`）。
 */
import type { DshClient } from "./client";
import type { DshTarget } from "./connectTarget";
import type { StopOptions } from "./supervisorManager";

/**
 * 造客户端的 seam。
 *
 * 生产实现只有一处：`new DshClient(baseUrl, token, log)`；离线测试换成假客户端
 * （按 `DshClient` 断言即可），于是「这一轮建了几个客户端、什么时候被 dispose、
 * dispose 了几次」都能当行为断言。
 */
export type DshClientFactory = (baseUrl: string, token: string | undefined) => DshClient;

/**
 * 「当前这条连接」的存放点。
 *
 * 账本不自己存一份，而是读写调用方给的槽——控制器里一百多处 RPC 调用点读的正是同一个
 * 字段，两份存放点必然各说各话（一处已经收掉了、另一处还以为连着）。
 */
export interface ClientSlot {
  get(): DshClient | undefined;
  set(client: DshClient | undefined): void;
}

/**
 * 一轮连接尝试的账本（调用方看得见的部分）。
 *
 * 它同时是**作废的证据**与**回调身份的判据**：每一轮开始取自己的号，苏醒后 `stale()`
 * 为真就静默让位（不能只靠「用户叫停」判据——换目标时用户并没有叫停，但那一轮已经不作数）；
 * 客户端回调第一句问 `isCurrent(client)`，被替换掉的客户端自己带着无限重连，它的
 * connecting/disconnected 会把界面反复拉回「连接中」。
 */
export interface ConnectionRound {
  /** 轮次号：被 `retarget` 顶掉之后，这一轮的一切回调都不再算数。 */
  readonly id: number;
  /** 这一轮的**目标身份**（并发合并时判断「目标变了没有」）。 */
  readonly target: DshTarget;
  /** 这一轮有没有拿到「后台不存在就拉起一套」的许可（用户显式动作才为真）。 */
  readonly mayStart: boolean;
  /** 这一轮结束（成功或抛错）的 promise：并发合并时调用方等的就是它。 */
  readonly finished: Promise<void>;

  /** 这一轮已经被顶掉了吗（换目标 / 用户停止 / 窗口释放）。 */
  stale(): boolean;
  /**
   * 用户叫停过、且这一轮**不是**用户自己发起的 → 该放弃。
   *
   * 用户显式动作（发消息 / 启动内部 DSH / 重启）永远算数；只有自动路径的那一轮才该在
   * 叫停后让位（见 `docs/design-supervisor.md`「能不能启动后台是一条显式许可」）。
   */
  userStopped(): boolean;
  /** 这一轮手里有没有已经建起来的连接（「要不要连带收跟随流」的判据）。 */
  hasClient(): boolean;
  /**
   * 接管这一轮建好的客户端：此后它的 dispose 归这一轮与账本管。
   *
   * 返回 `false` = **这一轮已经不作数**（换目标 / 用户叫停 / 窗口释放）：客户端已被账本
   * 收掉、**没有**进账本，当前那条连接一个字都没动——调用方必须立刻放弃这一轮。
   */
  adopt(client: DshClient): boolean;
  /** 这条回调还代表「当前这个客户端」吗（旧客户端不许写全局状态）。 */
  isCurrent(client: DshClient): boolean;
  /**
   * 收掉这一轮手里的客户端。
   *
   * `client` 传「刚建好、还没接管」的那一个（换 cookie / 换令牌那几秒里用户可能已经换了
   * 目标或点了停止，那时它还没进账本）；省略则收已经接管的那条。
   */
  discard(client?: DshClient): void;
}

/** `createConnectionAttempts` 的依赖：管理器那一下、控制器那几处窄回调、客户端存放点。 */
export interface ConnectionAttemptsOptions {
  /** 管理器那侧的停止入口（窄端口：收场只用到这一个动作；档位由本模块决定）。 */
  stop: (options?: StopOptions) => Promise<boolean>;
  /** 收掉本窗口所有跟随流 / 控制流句柄（域保留，重连时由 `onConnected` 重开）。 */
  teardownFollows: () => void;
  /** 界面回到按钮态；只在**本窗口这一轮真被收掉**时调用。 */
  markStopped: () => void;
  /** 当前客户端的存放点（见 `ClientSlot`）。 */
  clientSlot: ClientSlot;
  /** 造客户端（生产是 `new DshClient(baseUrl, token, log)`）。 */
  createClient: DshClientFactory;
  /** 开发者可见的调试日志（输出通道）。 */
  log: (line: string) => void;
}

/**
 * 连接尝试的账本与收场：控制器连接区域里「从发起到收场」的唯一落点。
 *
 * 用法是「说意图」：
 *
 * ```ts
 * void attempts.run({ target, mayStart }, (round) => this.connectOnce(round));
 * attempts.retarget();   // 换目标 / 重开一轮（马上要接上同一个后台，所以不交还占用）
 * attempts.stopByUser(); // 「停止连接」（关闸 + 收场 + 交还占用 + 界面回按钮态）
 * ```
 */
export interface ConnectionAttempts {
  /** 在途那一轮（并发合并用）；没有在跑的轮次时为 `undefined`。 */
  readonly inFlight: ConnectionRound | undefined;
  /** 自动路径的闸：用户叫停后为假，心跳不许把连接接回来。 */
  readonly autoReconnect: boolean;
  /** 本轮的结算：连接类失败接着试，启动/认证类停下等用户。 */
  readonly retryable: boolean;

  /** 造客户端：全控制器**唯一**的 `new DshClient` 出入口。 */
  newClient(baseUrl: string, token: string | undefined): DshClient;

  /** 显式动作 / 自动选路：打开自动路径的闸，并允许本轮接着试（用户要后台时不该被配置挡住）。 */
  reopen(): void;
  /** 本轮的结算：还能不能接着自动重试。 */
  markRetry(value: boolean): void;

  /** 起一轮连接尝试：`body` 拿到属于**它自己**那一轮的账本。 */
  run(input: { target: DshTarget; mayStart: boolean }, body: (round: ConnectionRound) => Promise<void>): Promise<void>;
  /** 只中止管理器那侧在途的等待（不收连接、不动轮次）——换目标时让旧轮让位用。 */
  cancelWait(): void;
  /** 收掉本窗口当前这条连接（跟随流 + 客户端）。不碰轮次、等待与占用。 */
  detach(): void;
  /** 换目标 / 重开一轮的收场。 */
  retarget(): void;
  /** 「停止连接」：关闸 + 收场 + 交还内部后台的占用 + 界面回按钮态。 */
  stopByUser(): void;
  /** 用户叫停后放弃这一轮（幂等）。 */
  abandon(round: ConnectionRound): void;
  /**
   * 「停止内部 DSH」：请守护进程连 dsh 一起收场，返回「请求到底有没有发出去」。
   *
   * `target` 由这里判：目标不是内部时本窗口这条连接一个字都不动。
   */
  stopInternal(target: DshTarget | undefined): Promise<boolean>;
  /** 窗口释放：作废在途轮（迟到的完成一律静默让位）+ 收掉本窗口的连接。 */
  dispose(): void;
}

/**
 * 一轮的**实现**：比导出面多两个写能力（`invalidate` / `finish`）。
 *
 * 它是模块私有的（没有导出），调用方拿到的类型是 `ConnectionRound`——所以「作废这一轮」
 * 与「结束这一轮」只能由账本按定死的顺序触发，调用方绕不过完整收场。
 */
class RoundImplementation implements ConnectionRound {
  readonly finished: Promise<void>;
  private held: DshClient | undefined;
  private settle!: () => void;
  private fail!: (error: unknown) => void;

  constructor(
    private readonly ledger: AttemptsClosure,
    readonly id: number,
    readonly target: DshTarget,
    readonly mayStart: boolean,
  ) {
    this.finished = new Promise<void>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
  }

  stale(): boolean {
    return this.ledger.isStale(this.id);
  }

  userStopped(): boolean {
    return !this.ledger.autoPath() && !this.mayStart;
  }

  hasClient(): boolean {
    return this.held !== undefined;
  }

  adopt(client: DshClient): boolean {
    // 这一轮已经不作数（换目标 / 用户叫停 / 窗口释放）：**不许**把自己的客户端装进账本
    // ——那会覆盖掉新轮已经接管的那条，还会把它的回调接进全局状态。只把拿来的这条收掉，
    // 当前连接一个字都不动。安全性在这里，不靠调用方记得先查 `stale()`。
    if (this.stale()) {
      this.ledger.release(client);
      return false;
    }
    this.held = client;
    this.ledger.slot.set(client);
    return true;
  }

  isCurrent(client: DshClient): boolean {
    return this.held === client && this.ledger.slot.get() === client;
  }

  discard(client?: DshClient): void {
    const target = client ?? this.held;
    if (!target) return;
    if (target === this.held) this.held = undefined;
    this.ledger.release(target);
  }

  /** 私有能力：作废这一轮，把它手里的客户端交回账本（dispose 由账本按定死顺序做）。 */
  invalidate(): DshClient | undefined {
    const held = this.held;
    this.held = undefined;
    return held;
  }

  /** 私有能力：这一轮收口（`finished` 随之结束）。 */
  finish(error?: unknown): void {
    if (error === undefined) this.settle();
    else this.fail(error);
  }
}

/** 闭包内的账本状态与写能力（不导出：调用方拿不到）。 */
interface AttemptsClosure {
  slot: ClientSlot;
  autoPath(): boolean;
  isStale(id: number): boolean;
  /**
   * 收掉某条连接：它若还是当前那条，先清掉再 dispose。
   *
   * **恰好一次**：同一个客户端会被多条路径经手（终止时从槽里收、旧轮迟到时再 discard、
   * 窗口释放再收一遍），收过的记在墓碑集里，重复调用什么都不做。
   */
  release(client: DshClient): void;
}

export function createConnectionAttempts(options: ConnectionAttemptsOptions): ConnectionAttempts {
  let flying: RoundImplementation | undefined;
  let roundId = 0;
  let released = false;
  let autoPath = true;
  let retries = false;
  /** 已经收掉的客户端（墓碑）：`release` 的幂等判据。 */
  const disposed = new WeakSet<DshClient>();

  const closure: AttemptsClosure = {
    slot: options.clientSlot,
    autoPath: () => autoPath,
    isStale: (id) => released || id !== roundId,
    release: (client) => {
      // 收过的就不再收：多条路径会经手同一个客户端（终止时从槽里收、旧轮迟到再 discard、
      // 窗口释放再收一遍），少了这道判据第二次 dispose 会打到已经被换掉/已经收掉的那条上
      if (disposed.has(client)) return;
      disposed.add(client);
      if (options.clientSlot.get() === client) options.clientSlot.set(undefined);
      client.dispose();
    },
  };

  const finishRound = (round: RoundImplementation, error?: unknown): void => {
    round.finish(error);
    // 这一轮结束只清在途记账：**不清身份**——`held` 是这一轮那些客户端回调的判据
    // （`isCurrent`），连接还在用、掉线与恢复都要靠它更新界面。批量清掉引用不等于
    // "所有权已结算"，而"恰好收一次"由 `release` 的墓碑集负责（见 `AttemptsClosure.release`）
    if (flying === round) flying = undefined;
  };

  /**
   * 模块私有的写能力：按轮次取出「作废这一轮，把它手里的客户端交回来」。
   *
   * 有它，`invalidate` 就不必出现在导出面上（调用方拿不到这个能力）；`abandon` 也用它
   * 拿回本轮那条客户端，而不必猜自己人的实现类型。
   */
  const invalidateOf = new WeakMap<ConnectionRound, () => DshClient | undefined>();

  /**
   * 一轮终止的**定死顺序**：作废在途轮 → 中止在途等待 → 收跟随流 → 收客户端。
   *
   * 顺序不是风格问题：先中止等待才能把「正挂在没有时长上限的等待里」的那一轮叫醒；
   * 先收跟随流再 dispose 客户端，才不会留下按域重开的流。收场意图的差异一律在这四步
   * **之外**（要不要交还占用、要不要请守护进程收场、界面落哪一档）。
   */
  const terminateRound = (): void => {
    roundId += 1;
    const held = flying?.invalidate();
    void options.stop({ cancelWait: true });
    options.teardownFollows();
    const client = held ?? options.clientSlot.get();
    if (client) closure.release(client);
  };

  return {
    get inFlight() {
      return flying;
    },
    get autoReconnect() {
      return autoPath;
    },
    get retryable() {
      return retries;
    },

    newClient(baseUrl, token) {
      return options.createClient(baseUrl, token);
    },

    reopen() {
      autoPath = true;
      retries = true;
    },

    markRetry(value) {
      retries = value;
    },

    run(input, body) {
      roundId += 1;
      const round = new RoundImplementation(closure, roundId, input.target, input.mayStart);
      invalidateOf.set(round, () => round.invalidate());
      flying = round;
      let done: Promise<void>;
      try {
        done = body(round);
      } catch (error) {
        done = Promise.reject(error);
      }
      // 结束信号与清理挂在同一处：`body` 抛错也必须清掉在途轮，否则心跳会一直以为
      // 「有一轮在跑」，并发合并逻辑把后续每一次都吞掉
      const settled = done.then(
        () => {
          finishRound(round);
        },
        (error: unknown) => {
          finishRound(round, error);
        },
      );
      // 调用方会 await `round.finished`；这一道只是替上面的 `done` 兜住未处理的 rejection
      void settled.catch(() => undefined);
      return round.finished;
    },

    cancelWait() {
      void options.stop({ cancelWait: true });
    },

    detach() {
      options.teardownFollows();
      const client = options.clientSlot.get();
      if (client) closure.release(client);
    },

    retarget() {
      terminateRound();
    },

    stopByUser() {
      autoPath = false;
      retries = false;
      terminateRound();
      void options.stop({ release: true });
      options.markStopped();
    },

    abandon(round) {
      options.log("[connect] 用户已点「停止连接」：本轮不再建连");
      const invalidate = invalidateOf.get(round);
      const held = invalidate ? invalidate() : undefined;
      // 这一轮**已经不作数**（换目标之后才走到这里、或窗口已释放）：只收掉它自己残留的
      // 那条客户端，**不许**碰当前占用、跟随流与界面——那些现在归新的一轮，动了就是
      // 「放弃一个旧轮把新连接撕了 / 把界面从连接中拉回按钮态」。
      if (round.stale()) {
        if (held) closure.release(held);
        return;
      }
      retries = false;
      // 这一轮是**自己**结束的（不是被顶掉），所以不作废轮次号、也不中止等待；
      // 没建起连接时跟随流也一个字都不收——上一条连接的跟随流已由 `retarget` 收过
      if (held) {
        options.teardownFollows();
        closure.release(held);
      }
      // 幂等地再交还一次：叫停之后那一轮仍可能把连接建起来，而它随后被放弃
      void options.stop({ release: true });
      options.markStopped();
    },

    async stopInternal(target) {
      if (target === "external") {
        options.log("[server] 当前目标是外部 DSH：「停止内部 DSH」只停内部后台，这条连接不动");
        return options.stop({ cancelWait: true, askSupervisor: true });
      }
      autoPath = false;
      retries = false;
      terminateRound();
      options.markStopped();
      return options.stop({ cancelWait: true, askSupervisor: true });
    },

    dispose() {
      if (released) return; // 重复清理幂等（窗口释放路径可能被走两遍）
      released = true;
      options.teardownFollows();
      const client = options.clientSlot.get();
      if (client) closure.release(client);
    },
  };
}
