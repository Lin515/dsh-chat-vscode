/**
 * supervisor 进程本体（设计 §3.5）——**独立于 VS Code 存在**，这是整个架构的地基。
 *
 * 放在 `src/supervisor/` 而不是 `src/dsh/`：它是**独立进程的入口**，
 * 由扩展以脚本方式拉起（`dist/supervisor.js`），与"扩展宿主里的代码"是两种运行环境。
 * 它只能依赖 `src/dsh/` 里那几个纯模块（协议、编解码），不能碰 `vscode`。
 *
 * 它只做四件事：
 * 1. 持有 `dsh web` 子进程（命令原样来自 `dshChat.command`，本文件不追加任何参数）；
 * 2. 在 socket 上接受各扩展实例的连接（连接本身 = "我在用"），并推送状态变化；
 * 3. 没人用了（连续 `idleSec` 无活连接）→ 按端口杀掉 dsh 整棵树 → 清会合文件与 socket → 退出；
 * 4. dsh 自己崩了就重新拉起（还有人用）或退场（没人用）。
 *
 * **它不感知 VS Code**：窗口重载/崩溃/被强杀对它全是透明的，这正是"重载后台不断"的由来。
 *
 * 启动方式（扩展侧负责，见 `supervisorClient.createSupervisorLauncher`）：
 * 用 VS Code 自带的 Node 跑本文件，参数是起跑配置：
 * ```
 *   --directory <会合目录> --group <分组> --command <启动命令> --idle-sec <秒>
 * ```
 * 会合文件与日志都写在 `<会合目录>` 下；socket 路径由协议模块给出。
 *
 * 本文件被 `esbuild.mjs` 打成 `dist/supervisor.js`（CJS，随扩展分发，只依赖 node 内置模块）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  IDLE_SEC_DEFAULT,
  PING_INTERVAL_MS,
  SPAWN_GRACE_MS,
  STATE_VERSION,
  clampIdleSec,
  clearState,
  logFileIn,
  readState,
  socketPathIn,
  removeSocketNode,
  writeState,
  type SupervisorState,
} from "../dsh/supervisorProtocol";
import { LineDecoder, decodeClientMessage, encodeMessage } from "../dsh/supervisorWire";
import { isProcessAlive } from "../dsh/processRegistry";
import { createErrorReporter, type SupervisorErrorKind } from "../dsh/supervisorErrors";

interface Options {
  directory: string;
  group: string;
  command: string;
  idleSec: number;
  socket: string;
}

/** 解析命令行（缺参数按默认值走；真缺目录就报错退出——那属于调用方 bug）。 */
export function parseOptions(argv: string[]): Options | undefined {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const directory = value("--directory");
  if (!directory) return undefined;
  const group = value("--group") ?? "default";
  /**
   * 启动命令用 **base64** 传（`--command-b64`），不用明文 `--command`。
   *
   * 为什么（实测踩到）：启动命令是"带空格的一整串"（`dsh web --port 20000 --no-open`），
   * 而它要穿过 shell / `Start-Process` / `cmd` 好几层——**任何一层把它按空格拆开**，
   * supervisor 收到的就只剩 `dsh`，于是 dsh 直接 `error: --profile <name> is required` 退出。
   * 这种失败很难看：日志里只有 `code=1`，而真正的原因在参数里。
   * base64 里没有空格与引号，天然免疫；明文 `--command` 仍然兼容（手工调试时方便）。
   */
  const encoded = value("--command-b64");
  let command = value("--command") ?? "dsh web --port 0 --no-open";
  if (encoded) {
    try {
      command = Buffer.from(encoded, "base64").toString("utf8") || command;
    } catch {
      // 解不开就用明文那个
    }
  }
  return {
    directory,
    group,
    command,
    idleSec: clampIdleSec(value("--idle-sec") ?? IDLE_SEC_DEFAULT),
    socket: value("--socket") ?? socketPathIn(directory, group),
  };
}

/**
 * 服务器公告行：`dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`。
 *
 * URL 那一段必须写 `[^\s]+` 而**不能**写 `[^\s?]+`：后者会停在 `?` 上，于是
 * `(?:\/\?token=…)?` 永远匹配不到——**token 静默丢失**，扩展拿不到令牌就一直等到超时。
 * 这个 bug 只在"真的去问打包后的解析器"时才显形（读源码两轮都看不出问题），
 * 诊断脚本见 `scripts/parserDiag.mjs`。
 */
export function parseAnnouncement(text: string): { baseUrl: string; token?: string } | undefined {
  const match = text.match(/dsh web:\s*(http:\/\/[^\s]+?)(?:\/\?token=([^\s]+))?(?:\s|$)/);
  if (!match) return undefined;
  return { baseUrl: match[1].replace(/\/+$/, ""), token: match[2] };
}

/**
 * 从一段日志里取**本次启动尝试**的公告行。
 *
 * 为什么必须按 marker 切（三轮实测踩出来的，症状都是"重起之后接管到旧地址"）：
 * 日志文件是 supervisor 与 dsh **共用**的，而 supervisor 会把"dsh 日志尾部"回写进去
 * （排查用），于是同一段文本里会嵌着**历史公告**；再加上"旧进程退出输出可能晚于新进程"，
 * 单靠"取第一条/最后一条"都不成立。所以每次启动前先往日志写一行唯一 marker，
 * 只认**最后一条 marker 之后**的内容——归属就没有歧义了。
 */
export function announcementAfterMarker(text: string, marker: string): { baseUrl: string; token?: string } | undefined {
  const markerAt = text.lastIndexOf(marker);
  if (markerAt < 0) return undefined;
  const tail = text.slice(markerAt + marker.length);
  let found: { baseUrl: string; token?: string } | undefined;
  for (const line of tail.split(/\r?\n/)) {
    if (line.includes("[supervisor]")) continue; // supervisor 自己的诊断行，里面的地址是历史
    const parsed = parseAnnouncement(line);
    if (parsed) found = parsed;
  }
  return found;
}

/** 端口（从 baseUrl 取；取不到 undefined）。 */
export function portOf(baseUrl: string | undefined): number | undefined {
  if (!baseUrl) return undefined;
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** `netstat -ano` 里监听某端口的 pid（supervisor 收尾用；同 `processRegistry` 的口径）。 */
export function listeningPids(port: number): number[] {
  const result = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (result.error) return [];
  const pids = new Set<number>();
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (!parts.some((part) => part.endsWith(`:${port}`))) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * 从**日志**里找回上一次宣布的地址。
 *
 * 为什么需要它：supervisor 被强杀（崩溃、结束进程树）时，`supervisor.json` 会随它的
 * 收尾代码一起消失，而它拉起的 dsh **可能还活着**——那个后台的地址从此只存在于日志里。
 * 不找回来的话，固定端口（`dshChat.command` 写死 `--port`）场景下新 dsh 必然
 * `EADDRINUSE` 起不来，而那个孤儿谁也看不见（用户 2026-09-13 报的正是这个症状）。
 */
export function lastAnnouncedUrl(logPath: string): string | undefined {
  try {
    const text = readFileSync(logPath, "utf8");
    let found: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseAnnouncement(line);
      if (parsed) found = parsed.baseUrl;
    }
    return found;
  } catch {
    return undefined;
  }
}

/** 杀一棵进程树（Windows）/ 发信号（其它平台）。 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 已退出
  }
}

/**
 * 收尾：把 dsh 带走。
 *
 * **两道**（沿用本仓库既有教训）：先按记录的 pid 杀整棵树（常规路径，连 shell 一起），
 * 再按端口把真正在监听的进程杀掉（外壳先死、node 成孤儿时的兜底）。
 * 只杀"端口上的监听者"，不碰别的进程。
 */
export function killServer(serverPid: number | undefined, baseUrl: string | undefined, log: (line: string) => void): void {
  const port = portOf(baseUrl);
  log(`[supervisor] 收尾：停止 dsh（pid=${serverPid ?? "?"} 端口=${port ?? "?"}）`);
  killTree(serverPid);
  if (port !== undefined) {
    for (const pid of listeningPids(port)) {
      if (pid === process.pid) continue;
      log(`[supervisor] 端口 ${port} 上还在监听的是 pid=${pid}，一并带走`);
      killTree(pid);
    }
  }
}

export interface RunningServer {
  child?: ChildProcess;
  baseUrl?: string;
  token?: string;
}

/** 起 dsh 并从它的日志里解析公告行（最多等 `graceMs`）。 */
export function startServer(options: {
  command: string;
  logFd: number;
  logPath: string;
  /** 本次尝试的唯一标记（写在日志里；只认标记之后的公告行）。 */
  marker: string;
  graceMs?: number;
  log: (line: string) => void;
  /**
   * 回调里出错时的上报（`runSupervisor` 传 `reportFailure`）。
   *
   * **为什么非要有它**：这个 promise 只在"解析到公告行"或"到点"时 settle，
   * 一旦轮询回调或 `child.on(...)` 里抛了错，promise 就**永远不 settle**，
   * 调用方 `bringUp` 永远卡在 `await` 上、`serverStarting` 也永远复位不了——
   * 主循环的"崩了要重起"和"没人用要退场"两条路全部瘫痪。所以这里的原则是
   * **出错就当本轮失败终结**（`finish(undefined)`），而不是让错误冒出去。
   */
  onError?: (error: unknown) => void;
}): Promise<RunningServer | undefined> {
  return new Promise((resolve) => {
    const child = spawn(options.command, [], {
      shell: true, // Windows 上是 dsh.cmd，必须经 shell 解析（命令原样执行，不追加参数）
      windowsHide: true,
      stdio: ["ignore", options.logFd, options.logFd],
      env: { ...process.env, BROWSER: "none" },
    });
    const deadline = Date.now() + (options.graceMs ?? SPAWN_GRACE_MS);
    let settled = false;
    const finish = (value: RunningServer | undefined) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(value);
    };
    /** 出错即"本轮失败"，绝不让错误把 promise 挂死。 */
    const fail = (error: unknown) => {
      options.onError?.(error);
      finish(undefined);
    };
    const timer = setInterval(() => {
      try {
        if (options.logPath) {
          // 每次都从**整个文件的尾部窗口**里找（不再维护偏移量）：偏移量会因"文件被同时追加"
          // 而漂移，而带 marker 的窗口查找没有这个状态，重起多少次都不会看错。
          const whole = readFileSync(options.logPath, "utf8");
          const parsed = announcementAfterMarker(whole, options.marker);
          if (parsed) {
            options.log(`[supervisor] dsh 就绪：${parsed.baseUrl}（token=${parsed.token ? "有" : "无"}）`);
            finish({ child, baseUrl: parsed.baseUrl, token: parsed.token });
          }
        }
        if (Date.now() > deadline) {
          options.log(`[supervisor] dsh 在 ${Math.round((options.graceMs ?? SPAWN_GRACE_MS) / 1000)}s 内没有宣布地址`);
          finish(undefined);
        }
      } catch (error) {
        fail(error);
      }
    }, 300);
    timer.unref?.();
    child.on("error", (error) => {
      try {
        options.log(`[supervisor] dsh 启动失败：${error.message}`);
      } catch (logged) {
        options.onError?.(logged);
      }
      finish(undefined);
    });
    child.on("exit", (code) => {
      // 注意：**这里不能吞错**。`readFileSync` 在日志被删/被占用时会抛，而这段代码跑的
      // 正是"dsh 死了"这个关键时刻——它的诊断信息（日志尾部）没了，等于把最后的线索丢了。
      // 所以日志尾部的读取失败要走 `onError` 上报（2026-09-15：改成可复现的真实故障路径）。
      try {
        options.log(`[supervisor] dsh 进程退出：code=${code ?? "?"}`);
        // 退出时把日志尾部带进 supervisor 日志：dsh 自己崩了的话，原因只在它的 stderr 里，
        // 而那个文件是"运行日志"（会被追加），排查时不翻它就只剩 code=1 这种无用信息
        const tail = readFileSync(options.logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
        if (tail) options.log(`[supervisor] dsh 日志尾部：${tail}`);
      } catch (error) {
        // 日志尾部读不到（文件被删/被占用）时**不能吞**：这段代码跑的正是"dsh 死了"这个
        // 关键时刻，把它的诊断丢了等于把最后的线索丢了。走 onError 上报。
        options.onError?.(error);
      }
      finish(undefined);
    });
  });
}

/** 跑起来（供 `dist/supervisor.js` 的入口调用；导出是为了能被探针直接驱动）。 */
export async function runSupervisor(options: Options): Promise<number> {
  const logPath = logFileIn(options.directory);
  const logFd = openSync(logPath, "a");
  const log = (line: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toLocaleTimeString()}] ${line}\n`, "utf8");
    } catch (error) {
      // 日志写不进去绝不影响主流程——但**不能连消息一起吞掉**：Windows 上文件被占用/
      // 目录被清理时 appendFileSync 会抛，而那正是最需要留证据的时刻。退到 stderr
      // （Windows 上由父进程/cmd 的窗口接住，也可能进 supervisor 自己的 stderr 捕获）。
      try {
        process.stderr.write(`[supervisor] 日志写入失败（${String(error)}）：${line}\n`);
      } catch {
        // 连 stderr 都写不进去就只能丢弃了
      }
    }
  };

  const startedAt = Date.now();
  const socketPath = options.socket;
  let server: RunningServer = {};
  let idleSec = clampIdleSec(options.idleSec);
  let stopping = false;
  let serverStarting = false;

  /**
   * 捕获到异常的次数由上报器维护（`reporter.count`）。
   *
   * **刻意不做"错太多次就退出"**：这是一台守护进程，它死了以后没有任何东西能接替它
   * （窗口只会连不上、dsh 崩了也不会再被拉起）。宁可带着一条错误日志继续活着。
   */

  /** 各窗口的连接（连接本身 = "我在用"）。 */
  const clients = new Set<Socket>();
  /** 每个连接上攒的半行数据。 */
  const decoders = new WeakMap<Socket, LineDecoder>();
  /** 最近一次"还有人在用"的时刻。 */
  let lastActiveAt = Date.now();
  const touch = (): void => {
    lastActiveAt = Date.now();
  };

  /**
   * 错误上报器（策略见 `src/dsh/supervisorErrors.ts`，可离线断言）：
   * 一条错误同时进 **supervisor.log**（底线）与 **socket 广播**（扩展侧转发进
   * VS Code 输出通道「DSH Chat」）。`publish` 放进来的取连接的函数见下面的 `clients`。
   */
  const reporter = createErrorReporter(log);
  reporter.publish(() => clients);
  const reportFailure = (kind: SupervisorErrorKind, error: unknown): void => reporter.report(kind, error);

  /**
   * **启动自检**：确认这个进程能把自己的日志写下去。
   *
   * 守护进程是 detached 启动的（`stdio: "ignore"`），它的 stderr 落在**没人看的地方**——
   * 一旦日志不可写（目录被 ACL 挡了、盘满、目录被换成文件），后面的错误就全都没了证据，
   * 用户看到的现象只会是"后台不重启/连不上"。所以起来第一件事就是自己写一行自检，
   * 写不进去立刻上报（文件那条路走不通时，`log` 会退到 stderr，网络那条路由 `reportFailure` 走）。
   */
  try {
    appendFileSync(logPath, `[${new Date().toLocaleTimeString()}] [supervisor] 启动自检（pid=${process.pid}）\n`, "utf8");
  } catch (error) {
    reportFailure("shutdown", new Error(`日志不可写（${logPath}）：${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * **最后一道网**：进程级未捕获异常与未处理 rejection。
   *
   * 事件回调还会被 `guard` 逐个包住，但总有漏网的（第三方 API 里的异步回调、
   * 我们没预料到的路径）。Node 默认行为是打印后 `exit(1)`——对守护进程来说这是
   * 最坏的结局：**它一死，没有任何东西会把它拉回来**，而 dsh 也没人管了。
   * 所以这里的原则是"记下来、活下去"：写日志 + 广播给窗口，进程不倒。
   *
   * 副作用要说清楚：`uncaughtException` 之后进程状态可能已经不干净。这里的安全前提是
   * 本进程的职责很窄（转发状态、看住子进程、按空闲退场），而且所有对外写入都在 try 里；
   * 退场路径（`shutdown`）仍会照常按空闲阈值或用户 stop 走，不会赖着不走。
   */
  process.on("uncaughtException", (error) => reportFailure("global", error));
  process.on("unhandledRejection", (reason) => reportFailure("global", reason));

  /**
   * 包一层事件回调/handler：**个别回调抛错绝不弄死守护进程**。
   *
   * 这正是一个真实 bug 的形状：2026-09-15 我在 `child.on("exit")` 里加了一行诊断，
   * 里面引用了不存在的变量 → `ReferenceError` 从事件回调冒到顶层 → 整个守护进程
   * 以 code=1 静默消失（窗口侧只看到"连不上"）。同步回调在这里兜；返回 Promise 的
   * （`bringUp` 是 async）另用 `settle` 兜 rejection。
   */
  const guard =
    <A extends unknown[]>(kind: SupervisorErrorKind, fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch (error) {
        reportFailure(kind, error);
      }
    };

  /**
   * 「**现在就跑**这段收尾/副作用代码，抛错也别弄死守护进程」。
   *
   * 为什么不直接写 `guard(kind, fn)()`：`guard` 是**工厂**（返回包装函数），在语句位置
   * 写成 `guard(kind, fn);` 编译器不报错、回调却永远不会执行——2026-09-15 的 `shutdown`
   * 就是这么坏的（收尾体一行都没跑，`stopping` 却已置真 → 守护进程变僵尸：不退场、
   * 也不再重起 dsh）。多一个显式名字，这种写法就再也写不出来。
   */
  const runGuarded = (kind: SupervisorErrorKind, fn: () => void): void => {
    // 泛型要显式给 `[]`：`guard` 的参数列表类型推断不出零参调用
    guard<[]>(kind, fn)();
  };

  /** 兜住 async 调用的 rejection（`void bringUp()` 漏掉的那一半）。 */
  const settle = <T>(kind: SupervisorErrorKind, promise: Promise<T>): void => {
    promise.catch((error: unknown) => reportFailure(kind, error));
  };

  /**
   * 至少活到这一刻之前不做空闲判定。
   *
   * **这是启动竞态的正解**（探针实测抓到）：supervisor 从"生下来"就开始算空闲，
   * 而扩展此刻还在轮询会合文件、**一个连接都还没建立**；阈值小的时候（用户可配到 5 秒）
   * 它会在客户端连上来之前就把自己关掉——会合文件随之消失，客户端等一场空。
   * 所以给一个下限：空闲阈值 + 10 秒，之后才开始判"没人用"。
   * 代价是"起了但从没人连"时多活 10 秒；收益是"任何阈值下都不会自我拆台"。
   */
  const idleGraceUntil = startedAt + (idleSec + 10) * 1_000;

  const stateOf = (): SupervisorState => ({
    version: STATE_VERSION,
    supervisorPid: process.pid,
    startedAt,
    serverPid: server.child?.pid,
    baseUrl: server.baseUrl,
    token: server.token,
    command: options.command,
    idleSec,
    socket: socketPath,
    serverStartedAt: server.baseUrl ? startedAt : undefined,
    starting: serverStarting,
    runtime: {
      execPath: process.execPath,
      node: process.version,
      electron: process.versions.electron,
    },
  });

  const publish = (): void => {
    writeState(options.directory, stateOf());
    const message = encodeMessage({ t: "state", state: stateOf(), clients: clients.size });
    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        // 写失败由 close 事件收尾
      }
    }
  };

  /**
   * 拉起 dsh（或重新拉起），并把结果广播出去。
   *
   * `try/finally` 不是装饰：`serverStarting` 卡在 `true` 的后果是**静默瘫痪**——
   * 主循环里"崩了要重起"和"没人用要退场"两条路都以 `!serverStarting` 为前提，
   * 一旦这里中途抛错而没复位，守护进程就永远不再重启 dsh、也永远不退场
   * （表现和 §8.6 那个 bug 一样："后台没了，谁都救不回来"）。所以无论走哪条路都要复位。
   */
  const bringUp = async (): Promise<void> => {
    serverStarting = true;
    try {
      // 重起时先把**旧的那个 dsh 带走**（否则会留下一个占着端口的孤儿——它不在会合文件里，
      // 谁也看不见）。放在清连接信息之前杀，这样按端口兜底的判据还能用上旧地址。
      if (server.child || server.baseUrl) {
        killServer(server.child?.pid, server.baseUrl, log);
      }
      // **先把旧的连接信息清掉再宣布"正在启动"**：不清的话会合文件里留着上一次的
      // baseUrl/serverPid，扩展看到"地址有、token 有、starting=false"就会以为后台还活着，
      // 于是永远发现不了它已经换了（实测：restart 之后扩展一直连旧地址）。
      server = {};
      publish();
      // **起新的之前，先收拾上一次留下的孤儿**：supervisor 被强杀时会话文件没了，
      // 但它拉起的 dsh 可能还在监听（地址只留在日志里）。不收拾的话，固定端口场景下
      // 新 dsh 必然 EADDRINUSE —— 这正是用户报过的"连不上、要手动清理"。
      const stale = lastAnnouncedUrl(logPath);
      const stalePort = portOf(stale);
      if (stalePort !== undefined) {
        const owners = listeningPids(stalePort).filter((pid) => pid !== process.pid);
        if (owners.length) {
          log(`[supervisor] 发现上次遗留的 dsh 还占着端口 ${stalePort}（pid=${owners.join(",")}），先回收它`);
          for (const pid of owners) killTree(pid);
          const until = Date.now() + 10_000;
          while (Date.now() < until && listeningPids(stalePort).some((pid) => pid !== process.pid)) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      }
      // 本次尝试的唯一标记：写在 spawn **之前**，于是"标记之后的公告行"必定属于这一次
      const marker = `--- dsh attempt ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)} ---`;
      try {
        appendFileSync(logPath, `${marker}\n`, "utf8");
      } catch {
        // 标记写不进去就退化成普通解析（`announcementAfterMarker` 找不到时返回 undefined）
      }
      const next = await startServer({
        command: options.command,
        logFd,
        logPath,
        marker,
        log,
        onError: (error) => reportFailure("dsh-exit", error),
      });
      if (!next) {
        server = {};
        serverStarting = false;
        publish();
        return;
      }
      server = next;
      touch();
      // **这一行必须在 publish() 之前**（2026-09-15 探针实测抓到回归）：`stateOf()` 里的
      // `starting` 直接取 `serverStarting`，而扩展侧"能不能用这个后台"靠的就是会合文件里
      // `starting !== true`。先 publish 再复位的话，文件里永远是 `starting:true`——
      // 新窗口/重载后的窗口会一直等一个"正在启动"的后台，直到下一轮 bringUp 才可能翻过来。
      // 复位本身仍由 finally 兜住（异常路径也要清），这里只是把"正常路径"的顺序摆正。
      serverStarting = false;
      publish();
    } finally {
      serverStarting = false;
    }
  };

  const goodbye = (reason: "idle" | "stop" | "replaced"): void => {
    const message = encodeMessage({ t: "goodbye", reason });
    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        // 忽略
      }
      try {
        client.end();
      } catch {
        // 忽略
      }
    }
  };

  /** 收尾并退出。 */
  const shutdown = (reason: "idle" | "stop"): void => {
    if (stopping) return;
    stopping = true;
    // 收尾路径也套守卫：这里抛错会让进程**退到一半**（dsh 没杀干净、会合文件没删），
    // 比直接退出更糟——残留下来的东西下一个窗口还接手不了。
    //
    // 必须用 `runGuarded`（= 立即执行）：写成 `guard("shutdown", …)` 的话那个回调
    // 永远不会跑，而 `stopping` 已经置真，守护进程就变成了僵尸（不退场、`tick` 从此
    // 直接 return，连"dsh 崩了要重起"都不再做）。2026-09-15 实测：`npm run smoke`
    // 打印「端到端通过」后，它拉起的 supervisor 收到 stop 请求却一直活着、会合文件
    // 也没清（日志停在「收到客户端的 stop 请求」那一行）。上一轮加 `guard` 时漏掉了调用。
    runGuarded("shutdown", () => {
      log(`[supervisor] 退场（${reason}）：没有人再使用这个后台`);
      killServer(server.child?.pid, server.baseUrl, log);
      server = {};
      goodbye(reason);
      clearState(options.directory);
      removeSocketNode(socketPath);
      try {
        closeSync(logFd);
      } catch {
        // 忽略
      }
      // 给 socket 一点时间把 goodbye 发出去
      setTimeout(() => process.exit(0), 150).unref?.();
    });
  };

  // ---- socket 服务 ----
  const netServer: Server = createServer(
    guard("socket", (socket: Socket) => {
      clients.add(socket);
      decoders.set(socket, new LineDecoder());
      touch();
      socket.setEncoding("utf8");
      // **先补发最近的内部错误**，再推状态：这个窗口之所以到现在才连上，很可能正是因为
      // 守护进程前面出过错（日志不可写、dsh 起来就退……）。晚一步补发的话，用户看到的
      // 是一份"一切正常"的状态，问题只能去翻 supervisor.log（探针实测到的丢消息）。
      reporter.replayTo(socket);
      // 连上就先给一份当前状态（扩展据此决定"直接接上"还是"等启动"）
      try {
        socket.write(encodeMessage({ t: "state", state: stateOf(), clients: clients.size }));
        // 连接数变了也要让**其它**窗口知道（它们拿这个数字显示"几个窗口在共用"）
        const notice = encodeMessage({ t: "state", state: stateOf(), clients: clients.size });
        for (const other of clients) {
          if (other === socket) continue;
          try {
            other.write(notice);
          } catch {
            // 忽略
          }
        }
      } catch {
        // 忽略
      }
      socket.on(
        "data",
        guard("protocol", (chunk: string) => {
          touch();
          const decoder = decoders.get(socket) ?? new LineDecoder();
          decoders.set(socket, decoder);
          for (const line of decoder.push(chunk)) {
            const message = decodeClientMessage(line);
            if (!message) continue;
            if (message.t === "control") {
              if (message.action === "stop") {
                log("[supervisor] 收到客户端的 stop 请求");
                shutdown("stop");
              } else {
                log("[supervisor] 收到客户端的 restart 请求：重起 dsh");
                // 直接 bringUp：它开头会把旧连接信息清掉并宣布"正在启动"，
                // 旧的 dsh 由 bringUp 里的孤儿回收按端口带走（不必在这里先杀一次）
                settle("bringUp", bringUp());
              }
            }
          }
        }),
      );
      const drop = (): void => {
        clients.delete(socket);
        decoders.delete(socket);
        // 少了一个窗口：把新的连接数广播出去（其余窗口的"几个窗口在共用"要跟着变）
        if (!stopping) publish();
      };
      socket.on("close", guard("socket", drop));
      socket.on("error", guard("socket", drop));
    }),
  );

  await new Promise<void>((resolve, reject) => {
    netServer.once("error", (error) => {
      log(`[supervisor] socket 监听失败：${error.message}`);
      reject(error);
    });
    netServer.listen(socketPath, () => {
      log(`[supervisor] 已监听 ${socketPath}（分组=${options.group}，空闲阈值=${idleSec}s）`);
      resolve();
    });
  });

  publish();
  await bringUp();

  // ---- 主循环：空闲判定 / dsh 崩溃重启 / 热读阈值 ----
  /**
   * `server.child` 里那个句柄对应的进程还在不在。
   *
   * **不能只看 `!server.child`**（2026-09-15 实测修）：`server.child` 是 `spawn` 返回的
   * ChildProcess 对象，**进程死了它也不会自动变成 undefined**——`exit` 处理器只负责
   * 记日志，没人清这个字段。于是 dsh 一死，`!server.child` 永远为假，重启分支再也走不到：
   * 实测（`node build/supervisor-child-exit-probe.mjs`）杀掉 dsh 的 node 之后，
   * `server.child` 一直停在那具"尸体"上（日志里 tick#5…tick#80 都是同一个死 pid），
   * 窗口侧只能看到连接永远接不回来。
   *
   * 句柄判活用 `exitCode/signalCode`（Node 在子进程终结时置位，最权威），
   * 再补一道 `isProcessAlive`（防"句柄在、进程早已不在"的僵死形态）。
   */
  const childGone = (): boolean => {
    const child = server.child;
    if (!child) return true;
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return !isProcessAlive(child.pid);
  };

  const tick = setInterval(
    guard("tick", () => {
      if (stopping) return;
      // 热读阈值（用户改配置后不必重启 supervisor）
      const current = readState(options.directory);
      if (current && current.idleSec !== idleSec) {
        idleSec = clampIdleSec(current.idleSec);
        log(`[supervisor] 空闲阈值改为 ${idleSec}s`);
      }
      // dsh 崩了：还有人用就重起，没人用就等下一轮空闲判定
      if (!serverStarting && childGone() && clients.size > 0) {
        log(`[supervisor] dsh 不在了，但还有窗口在用：重起（旧 pid=${server.child?.pid ?? "（无）"}）`);
        settle("bringUp", bringUp());
      }
      // 空闲判定：所有连接都断了（或从来没有过）且持续超过阈值。
      // `idleGraceUntil` 是"刚起来还没人来得及连"的保护，见它的注释。
      if (
        !serverStarting &&
        clients.size === 0 &&
        Date.now() >= idleGraceUntil &&
        Date.now() - lastActiveAt >= idleSec * 1000
      ) {
        shutdown("idle");
      }
    }),
    Math.min(PING_INTERVAL_MS, 1_000),
  );
  tick.unref?.();

  process.on("SIGTERM", guard("shutdown", () => shutdown("stop")));
  process.on("SIGINT", guard("shutdown", () => shutdown("stop")));

  return 0;
}

/**
 * 入口：被当作脚本直接执行时跑起来。
 *
 * 判定用 `process.argv[1]` 与 `__filename` 相等（而不是"文件名长得像 supervisor"）：
 * 探针会 import 本模块复用 `parseOptions`/`runSupervisor`，那种情况下不能自动开跑。
 * esbuild 打成 CJS 后 `__filename` 可用（`typeof` 兜一层，便于在 ESM 下也不炸）。
 */
const entryFile = typeof __filename === "string" ? __filename : undefined;
if (entryFile !== undefined && process.argv[1] !== undefined && entryFile === process.argv[1]) {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    process.stderr.write("usage: supervisor --directory <dir> [--group <g>] [--command <cmd>] [--idle-sec <n>]\n");
    process.exit(2);
  }
  void runSupervisor(options);
}
