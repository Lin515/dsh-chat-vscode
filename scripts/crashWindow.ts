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
import { appendFileSync, writeFileSync } from "node:fs";
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
  readHostLeases,
  readLeases,
} from "../src/dsh/processRegistry";

const handshake = process.argv[2];
const log = process.argv[3];

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
const say = (line: string) => {
  if (log) appendFileSync(log, `${line}\n`, "utf8");
};

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
  command: "dsh web --port 0 --no-open",
  startTimeoutMs: 120_000,
  workspace: "D:/dev/dsh-chat#crash-window",
  log: say,
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

const info = await manager.ensure();
const lease = readLeases().find((item) => item.lease.baseUrl === info.baseUrl)?.lease;
writeFileSync(
  handshake,
  JSON.stringify({
    baseUrl: info.baseUrl,
    serverPid: lease?.serverPid,
    ownership: info.ownership,
    windowPid: process.pid,
    ready: true,
  }),
  "utf8",
);
say(
  `[window] 就绪 ${info.baseUrl}（pid=${lease?.serverPid}，ownership=${info.ownership}）` +
    `；当前租约数=${readLeases().length}`,
);

// 等被强杀；stdin 关闭时走正常退出（模拟用户关窗）
process.stdin.resume();
process.stdin.on("end", () => {
  manager.dispose();
  process.exit(0);
});
