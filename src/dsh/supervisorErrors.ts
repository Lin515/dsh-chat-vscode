/**
 * 守护进程的**错误上报器**（2026-09-15 用户要求："抛错可以捕获，并将错误发回 VSCode 的日志"）。
 *
 * 为什么单独一个模块（而不是写在 `src/supervisor/main.ts` 里）：
 * 它是"出错了怎么办"的**全部策略**，而策略应该能离线断言——不需要真把守护进程跑起来、
 * 更不需要真让它崩一次。`scripts/supervisorErrors.test.ts` 直接构造它来验三条：
 * ① 两处都发（文件 + 广播）；② 任何一处炸了都不影响另一处、也绝不外抛；
 * ③ 计数与"反复出错"的提示。
 *
 * ## 为什么是"两处"而不是只发给 VS Code
 *
 * 守护进程是**独立于 VS Code 的进程**（整个 supervisor 架构的地基）：扩展宿主随时可能
 * 不在（窗口关了、重载中、VS Code 整个退出了），那时"发回 VS Code"**没有收件人**。
 * 所以：
 * - **文件**（`supervisor.log`）是底线：不管有没有人在看，证据都留在那儿；
 * - **socket 广播**是实时通道：有窗口连着就顺手送过去，扩展侧转发进输出通道「DSH Chat」，
 *   用户不用去翻 `~/.dsh-chat/supervisors/<分组>/supervisor.log`。
 *
 * 本模块**只依赖 node 内置能力与纯函数**（`encodeMessage`），可以被打进 supervisor 产物，
 * 也能在断言里直接跑。
 */
import { encodeMessage } from "./supervisorWire";

/**
 * 异常来源分类（既进日志、也进推送消息的 `kind`）。
 *
 * 它的价值是**排查时能一眼定位**：日志里 grep `⚠ 内部错误（tick）` 就知道是主循环出的事，
 * 而不用从一大坨堆栈里猜。
 */
export type SupervisorErrorKind =
  | "tick" // 主循环（空闲判定 / 崩溃重启 / 热读阈值）
  | "dsh-exit" // dsh 子进程的 exit/error 回调与启动轮询
  | "socket" // net server 与各客户端连接的事件
  | "protocol" // 客户端消息的处理（含控制请求）
  | "bringUp" // 拉起 dsh（restart 请求或主循环触发）
  | "shutdown" // 收尾退场
  | "global"; // process 级兜底（uncaughtException / unhandledRejection）

export interface SupervisorErrorReporter {
  /** 上报一条异常。**绝不抛**。 */
  report(kind: SupervisorErrorKind, error: unknown): void;
  /** 已捕获的异常条数。 */
  readonly count: number;
  /**
   * 接上"当前有哪些客户端连接"（用于广播）。
   *
   * 用 getter 而不是构造参数，是因为连接集合在 `runSupervisor` 里是**后于**日志函数创建的：
   * 上报器必须在最早的时刻就能用（否则早期错误又变成静默的）。
   */
  publish(getClients: () => Iterable<{ write(data: string): unknown }>): void;
  /**
   * 给**刚连上**的客户端补发最近的错误（2026-09-15 实测补）。
   *
   * 为什么必须有：最要命的错误恰恰发生在"还没有任何窗口连上"的时候——守护进程刚起来、
   * 日志不可写、dsh 起来就退……那时 `report` 广播给的是一个**空集合**，只有文件知道。
   * 而用户是**后来**才打开窗口的，他等到的是一份干净的状态推送，于是"后台为什么不工作"
   * 又回到了只能翻 `supervisor.log` 的老问题（探针第一次跑就抓到了这条）。
   */
  replayTo(client: { write(data: string): unknown }): void;
}

/**
 * 给新连接补发的**最近错误条数上限**。
 *
 * 有上限是必须的：反复出错的守护进程可能攒下上千条，补发等于把窗口淹掉。
 * 16 条足够覆盖"起来到连上之间"的那一段（那里通常就那么几条）。
 */
const REPLAY_LIMIT = 16;

/** 把任意抛出物变成一行可读文本（Error 取 name/message + 堆栈前三行）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const stack = (error.stack ?? "").split(/\r?\n/).slice(0, 3).join(" | ");
    return `${error.name}: ${error.message}${stack ? ` @ ${stack}` : ""}`;
  }
  return String(error);
}

/**
 * 造一个上报器。
 *
 * @param log 写日志的函数（调用方给的那个已经自带"写不进去退 stderr"的兜底）
 * @param warn 反复出错时的额外提示行（默认与首条同一条日志）
 */
export function createErrorReporter(log: (line: string) => void): SupervisorErrorReporter {
  let count = 0;
  let clients: (() => Iterable<{ write(data: string): unknown }>) | undefined;
  /** 最近若干条已编码的 error 报文，供刚连上的窗口补发（见 `replayTo` 注释）。 */
  const pending: string[] = [];

  const report = (kind: SupervisorErrorKind, error: unknown): void => {
    count++;
    const text = describeError(error);
    // ① 文件（底线）。log 自己已经兜了"文件写不进去 → stderr"，这里再兜一层，
    //    确保"上报"这件事本身永远不会成为新的崩溃源。
    try {
      log(`[supervisor] ⚠ 内部错误（${kind}）：${text}`);
      // 反复出错要说出来：只写一次的话，用户看到的日志里只有一行，
      // 会以为是一次偶发；连续出错往往意味着一整类操作都坏了。
      if (count >= 3) log(`[supervisor] ⚠ 已累计捕获 ${count} 次内部错误（守护进程仍继续服务）`);
    } catch {
      // 忽略：文件那条路已经尽力了
    }
    // ② socket 广播（实时通道）。旧扩展不认识 `t:"error"`，会按协议"读不懂就忽略"处理。
    let message: string;
    try {
      message = encodeMessage({ t: "error", kind, message: text });
    } catch {
      return;
    }
    // 存一份给"还没连上的窗口"（这些错误往往正是它们没连上的原因）
    pending.push(message);
    if (pending.length > REPLAY_LIMIT) pending.splice(0, pending.length - REPLAY_LIMIT);
    if (!clients) return;
    for (const client of clients()) {
      try {
        client.write(message);
      } catch {
        // 写失败由该连接的 close 事件收尾
      }
    }
  };

  return {
    report,
    get count() {
      return count;
    },
    publish: (getClients) => {
      clients = getClients;
    },
    replayTo: (client) => {
      // 补发是"尽力而为"：任何一条写不进去都不该影响这个新连接的使用
      for (const message of pending) {
        try {
          client.write(message);
        } catch {
          return;
        }
      }
    },
  };
}
