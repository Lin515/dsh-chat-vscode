/**
 * 崩溃复用探针的**窗口进程**：起后台，然后把地址/pid 写进一个握手文件，静静等着被强杀
 * （或收到 stdin EOF 时正常退出）。
 *
 * 为什么单独一个进程：要验证"VS Code 崩溃后遗留的后台能否被复用"，就必须有一个
 * **真的被强杀、来不及跑任何清理代码**的窗口。它自己不能兼任断言方。
 *
 * 用法：node crashWindow.ts <握手文件> [--dispose-on-eof]
 *   握手文件内容（每次状态变化重写）：{"baseUrl":"…","serverPid":123,"ready":true}
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createHostLog } from "../src/dsh/hostLog";
import { ServerManager } from "../src/dsh/serverManager";
import {
  dropDeadLeases,
  dropStaleHostLeases,
  findAdoptable,
  hasLiveHostFor,
  isOrphanLease,
  isProcessAlive,
  isServiceable,
  leaseDirectory,
  liveHostIds,
  parseListeningPidsSync,
  readHostLeases,
  readLeases,
} from "../src/dsh/processRegistry";

const handshake = process.argv[2];
const log = process.argv[3];

const say = (line: string) => {
  if (log) appendFileSync(log, `${line}\n`, "utf8");
};

/**
 * `--kill-on-log-throw`：**单窗口自检**——把"日志函数直接抛异常"的极端情形塞进
 * `ServerManager.dispose()`，然后断言后台真的没了、端口真的关了。
 *
 * 为什么单独留一条：`release()` 跑在扩展停用的尾巴上，它的唯一职责是把最后一个后台
 * 带走；那里每一步都可能出错。这条自检不问"异常有没有被咽下"，只问最终事实
 * （端口关了没有），所以它同时钉住 hostLog 的纪律与 `release()` 自身的 try/finally。
 *
 * 输出 `KILL-ON-THROW: PASS/FAIL`，退出码 0/1；它自己就是一个小型探针，可直接跑：
 *   node build/crash-window.mjs .tmp/h.json .tmp/h.log --kill-on-log-throw
 */
if (process.argv.includes("--kill-on-log-throw")) {
  // 起后台的过程本身就写日志（`[server] 启动：…`），所以"抛"必须等到就绪之后再开——
  // 否则死在启动阶段，测的就不是"关窗那一刻"了。
  let armThrow = false;
  const rawLog = (line: string): void => {
    say(line);
    if (armThrow) throw new Error("Channel has been closed");
  };
  const manager = new ServerManager({
    url: "",
    command: "dsh web --port 0 --no-open",
    startTimeoutMs: 120_000,
    workspace: "D:/dev/dsh-chat#kill-on-throw",
    log: rawLog,
  });
  const info = await manager.ensure();
  const port = Number(new URL(info.baseUrl).port);
  const myPid = readLeases().find((item) => item.lease.baseUrl === info.baseUrl)?.lease.serverPid;
  armThrow = true;
  say(`[selfcheck] 后台已就绪 ${info.baseUrl}（pid=${myPid}）；现在在"日志必抛"的情况下 dispose()`);
  try {
    manager.dispose();
    say("[selfcheck] dispose 正常返回");
  } catch (error) {
    say(`[selfcheck] dispose 抛出了：${error instanceof Error ? error.message : String(error)}`);
  }
  // 只看最终事实：端口还在不在。用 netstat 找监听者，确认是我的 pid 再杀（收尾），
  // 然后等它真的消失——绝不去碰别人的端口（比如用户正在用的那个后台）。
  let stillServing = false;
  for (let i = 0; i < 40; i++) {
    const owners = parseListeningPidsSync(port);
    if (owners.length) {
      stillServing = true;
      if (myPid !== undefined && owners.includes(myPid)) {
        spawn("taskkill", ["/pid", String(myPid), "/F"], { stdio: "ignore", windowsHide: true });
      }
      await delay(250);
      continue;
    }
    stillServing = false;
    break;
  }
  say(
    stillServing
      ? `KILL-ON-THROW: FAIL（端口 ${port} 上还有监听者——日志抛异常把 kill 掐断了）`
      : "KILL-ON-THROW: PASS（日志每次都抛异常，后台照样被带走）",
  );
  for (const { lease } of readLeases()) {
    spawn("taskkill", ["/pid", String(lease.serverPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  process.exit(stillServing ? 1 : 0);
}

// 诊断模式：只把"当前看到的租约/心跳/各判据"打一遍就退出（不动任何东西）。
// 用来定位"决策过程中哪一步把可接管的遗留租约弄没了"。
if (process.argv.includes("--diagnose")) {
  const dump = (tag: string) => {
    const leases = readLeases();
    const hosts = readHostLeases();
    say(
      `[diag:${tag}] 租约=${JSON.stringify(
        leases.map((item) => ({
          pid: item.lease.serverPid,
          url: item.lease.baseUrl,
          alive: isProcessAlive(item.lease.serverPid),
          serviceable: isServiceable(item.lease),
          orphan: isOrphanLease(item.lease),
          adoptable: findAdoptable("dsh web --port 0 --no-open")?.serverPid,
        })),
      )} 心跳数=${hosts.length} 心跳判活=${JSON.stringify(hosts.map(() => liveHostIds().length))}`,
    );
  };
  dump("初始");
  dump("清理失效心跳后");
  dump("dropDeadLeases 后");
  process.exit(0);
}
if (!handshake) {
  console.error("usage: node crashWindow.js <handshake-file> [log-file]");
  process.exit(2);
}

/**
 * 窗口的日志链路：**与扩展完全一致**——`createHostLog` 包着"取通道"的回调，
 * 通道关闭时由它把消息攒下来（见 `src/dsh/hostLog.ts`）。
 *
 * 真实扩展里这条链是：`ServerManager` → `createHostLog` → `vscode.OutputChannel`。
 * 探针里换成"写文件"这个 sink，纪律（永不外抛）保持同一份实现——否则测的就不是
 * 产品代码，而是探针自己写的另一套。
 *
 * `DSH_CHAT_PROBE_RAW_LOG=1`（对照模式）：**整条 hostLog 包装一并拆掉**，日志函数就是
 * 0.6.0 那样的裸写入（通道关闭时直接抛出去）。`closedChannelProbe --control`
 * 用它证明探针本身抓得住缺陷——只把"抛异常"塞进通道回调是不够的：
 * hostLog 会照纪律兜住它，对照就绿了。
 */
let sinks: ((line: string) => void)[] = [
  (line) => {
    if (log) appendFileSync(log, `${line}\n`, "utf8");
  },
];
/** 通道"已关闭"（由探针经 stdin 宣布）。 */
let channelOff = false;
const rawLog = process.env.DSH_CHAT_PROBE_RAW_LOG === "1";
const rawWindowLog = (line: string): void => {
  for (const sink of sinks) sink(line);
  if (channelOff) throw new Error("Channel has been closed");
};
const windowLog = rawLog
  ? rawWindowLog
  : createHostLog(() => ({
      appendLine: (line: string) => {
        for (const sink of sinks) sink(line);
      },
    }));

// 顶层兜底：任何未捕获异常都要写进日志（否则进程静默退出，排查只能靠猜）
process.on("uncaughtException", (error) => {
  say(`[window] 未捕获异常：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  say(`[window] 未处理的 Promise 拒绝：${reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason)}`);
  process.exit(1);
});

const manager = new ServerManager({
  url: "",
  command: process.env.DSH_CHAT_PROBE_COMMAND || "dsh web --port 0 --no-open",
  startTimeoutMs: 120_000,
  workspace: "D:/dev/dsh-chat#crash-window",
  log: windowLog,
});

// 决策前把"我看到的租约、心跳、以及各判据的结论"逐条打出来：诊断"为什么没复用"只能靠这个
const leases = readLeases();
const hosts = readHostLeases();
say(
  `[window] 决策前：租约目录=${leaseDirectory()}；` +
    `租约=${JSON.stringify(
      leases.map((item) => ({
        pid: item.lease.serverPid,
        url: item.lease.baseUrl,
        cmd: item.lease.command,
        alive: isProcessAlive(item.lease.serverPid),
        serviceable: isServiceable(item.lease),
        hasLiveHost: hasLiveHostFor(item.lease.serverPid),
        adoptable: findAdoptable("dsh web --port 0 --no-open")?.serverPid,
      })),
    )}；` +
    `心跳=${JSON.stringify(hosts)}；` +
    `心跳判活=${JSON.stringify(hosts.map((entry) => liveHostIds().includes(entry.hostId)))}`,
);

let info;
try {
  info = await manager.ensure();
} catch (error) {
  say(
    `[window] ensure() 抛错：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`,
  );
  process.exit(1);
}
const lease = readLeases().find((item) => item.lease.baseUrl === info.baseUrl)?.lease;
/** 握手文件的内容（状态变化时重写：`channelClosed` 是给探针的"已关掉通道"回执）。 */
const writeHandshake = (extra?: Record<string, unknown>): void => {
  writeFileSync(
    handshake,
    JSON.stringify({
      baseUrl: info.baseUrl,
      serverPid: lease?.serverPid,
      ownership: info.ownership,
      windowPid: process.pid,
      ready: true,
      ...extra,
    }),
    "utf8",
  );
};
writeHandshake();
say(
  `[window] 就绪 ${info.baseUrl}（pid=${lease?.serverPid}，ownership=${info.ownership}）` +
    `；当前租约数=${readLeases().length}`,
);

/**
 * 两种关闭姿势，都由探针经 stdin 驱动：
 * - `closed`：把输出通道"关掉"（此后日志写不出去），**然后**才关窗；
 * - 直接 EOF：正常关窗（日志能写）。
 *
 * 顺序是硬要求：先关通道、再 dispose，才等价于真实现场
 * （VS Code 先关输出通道，扩展随后才停用）。
 *
 * `closed` 之后**连本地文件 sink 一起摘掉**：真实现场那一刻通道已经没了，
 * 而"日志还能落盘"会让探针失去判别力（写不出去这件事必须真的发生）。
 * 证据由握手文件与探针自己的进程状态提供。
 */
process.stdin.setEncoding("utf8");
process.stdin.resume();
let armed = false;
process.stdin.on("data", (chunk: string) => {
  if (!chunk.includes("closed")) return;
  armed = true;
  channelOff = true;
  sinks = [];
  writeHandshake({ channelClosed: true });
});
process.stdin.on("end", () => {
  say(`[window] 收到关窗信号（通道已关闭=${armed}），开始 dispose`);
  try {
    manager.dispose();
    say("[window] dispose 已返回（kill 是同步发起的），进程退出");
    process.exit(0);
  } catch (error) {
    // 真实扩展里这里会被 VS Code 记成 "An error occurred when disposing the subscriptions"，
    // 探针要能把同一件事判成失败，所以显式落一条证据再以非零码退出。
    say(`[window] dispose 抛异常：${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  }
});
