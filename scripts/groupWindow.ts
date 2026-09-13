/**
 * 分组隔离探针用的"窗口进程"：用一个 **ServerManager** 代表一个 VS Code 窗口，
 * 它那份"有效配置"由参数给出（启动命令不同 = 配置不同 = 不同分组）。
 *
 * 分组在扩展里由 `setLeaseGroup(leaseGroupKey(config))` 设定；这里直接按命令算一个
 * 稳定的组名（与扩展的算法同构：内部配置按命令区分）。
 *
 * 用法：node group-window.mjs <handshake> <log> [--command <启动命令>]
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ServerManager } from "../src/dsh/serverManager";
import { setLeaseGroup } from "../src/dsh/processRegistry";

const handshake = process.argv[2];
const log = process.argv[3];
if (!handshake) {
  console.error("usage: node group-window.js <handshake> [log] [--command <cmd>]");
  process.exit(2);
}
const say = (line: string) => {
  if (log) appendFileSync(log, `${line}\n`, "utf8");
};
process.on("uncaughtException", (error) => {
  say(`[window] 未捕获异常：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exit(1);
});

const args = process.argv.slice(4);
const commandIndex = args.indexOf("--command");
const command = commandIndex >= 0 ? (args[commandIndex + 1] ?? "") || "dsh web --port 0 --no-open" : "dsh web --port 0 --no-open";

// 与扩展的 leaseGroupKey 同构：内部配置按命令区分
const group = createHash("sha256").update(`internal:${command}`).digest("hex").slice(0, 12);
setLeaseGroup(group);
say(`[window] 分组=${group} 命令=${command}`);

const manager = new ServerManager({
  url: "",
  command,
  startTimeoutMs: 120_000,
  workspace: "D:/dev/dsh-chat#group",
  log: say,
});
const info = await manager.ensure();
writeFileSync(
  handshake,
  JSON.stringify({ baseUrl: info.baseUrl, ownership: info.ownership, windowPid: process.pid, ready: true }),
  "utf8",
);
say(`[window] 就绪 ${info.baseUrl}（ownership=${info.ownership}）`);

process.stdin.resume();
process.stdin.on("end", () => {
  manager.dispose();
  process.exit(0);
});
