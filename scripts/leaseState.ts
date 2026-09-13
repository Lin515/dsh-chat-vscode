/**
 * 只读诊断：把**当前真实租约目录**里的每一条记录与每个判据打出来。
 *
 * 与 `orphanDiagnose.ts` 的区别：那个在隔离目录里**造**场景；这个只看现场
 * （`~/.dsh-chat/servers/<配置指纹>/`），跑一次就能回答"用户机器上现在这批记录，
 * 接管决策分别会怎么判"。
 *
 * 用法：
 *   node build/lease-state.mjs [日志文件]              # 扫全部分组（每个配置指纹一个目录）
 *   node build/lease-state.mjs <日志> --group <指纹>   # 只看某个分组
 */
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HOST_STALE_MS,
  STARTING_GRACE_MS,
  findAdoptable,
  findAttachable,
  findStarting,
  hasLiveHostFor,
  isOrphanLease,
  isProcessAlive,
  isServiceable,
  leaseDirectory,
  leasePort,
  liveHostIds,
  readHostLeases,
  readLeases,
  setLeaseGroup,
  tcpReachableSync,
} from "../src/dsh/processRegistry";

const LOG = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".tmp/lease-state.log";
const GROUP = process.argv.includes("--group") ? process.argv[process.argv.indexOf("--group") + 1] : undefined;
writeFileSync(LOG, "", "utf8");
const say = (line: string) => {
  appendFileSync(LOG, `${line}\n`, "utf8");
  process.stdout.write(`${line}\n`);
};
const timed = <T>(body: () => T): [T, number] => {
  const started = Date.now();
  return [body(), Date.now() - started];
};
const ago = (ms: number) => `${Math.round((Date.now() - ms) / 1000)}s 前`;

/** 租约根目录下的全部分组（每个"有效服务器配置"一个目录）。 */
function groups(): string[] {
  if (GROUP) return [GROUP];
  const root = join(homedir(), ".dsh-chat", "servers");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  } catch {
    return [];
  }
}

for (const group of groups()) {
  setLeaseGroup(group);
  const dir = leaseDirectory();
  const leases = readLeases();
  const hosts = readHostLeases();
  say(`\n######## 分组 ${group}：${dir}`);
  say(`（心跳新鲜度阈值 ${HOST_STALE_MS / 1000}s；启动宽限 ${STARTING_GRACE_MS / 1000}s）`);
  say(`== 租约 ${leases.length} 条 / 心跳 ${hosts.length} 条 ==`);
  if (!leases.length && !hosts.length) {
    say("（空）");
  }
  for (const { file, lease } of leases) {
    const port = leasePort(lease);
    const [alive, msAlive] = timed(() => isProcessAlive(lease.serverPid));
    say(`${file}`);
    say(
      `   pid=${lease.serverPid} url=${lease.baseUrl ?? "（无）"} token=${lease.token ? "有" : "无"}` +
        ` cmd=${JSON.stringify(lease.command)} startedAt=${ago(lease.startedAt)} hosts=${lease.hosts?.length ?? 0}`,
    );
    say(
      `   进程活=${alive}(${msAlive}ms) 可服务=${isServiceable(lease)} 孤儿=${isOrphanLease(lease)}` +
        ` 有活窗口=${hasLiveHostFor(lease.serverPid)} 端口=${port ?? "?"}`,
    );
    if (port !== undefined) {
      const [ok, msTcp] = timed(() => tcpReachableSync(`http://127.0.0.1:${port}`));
      say(`   端口 ${port} 在服务=${ok}(${msTcp}ms)`);
    }
  }
  for (const entry of hosts) {
    const [alive, msAlive] = timed(() => isProcessAlive(entry.pid));
    say(
      `   心跳 ${entry.hostId}：写它的进程 pid=${entry.pid ?? "?"} 活=${alive}(${msAlive}ms)` +
        ` serverPid=${entry.serverPid ?? "?"} url=${entry.baseUrl ?? "（无）"} token=${entry.token ? "有" : "无"}` +
        ` cmd=${JSON.stringify(entry.command)} 记于 ${ago(entry.seenAt)}`,
    );
  }
  if (leases.length || hosts.length) {
    const [attachable, msA] = timed(() => findAttachable());
    const [starting, msS] = timed(() => findStarting(90_000));
    const [adoptable, msD] = timed(() => findAdoptable(leases[0]?.lease.command ?? "dsh web --port 0 --no-open"));
    const [live, msL] = timed(() => liveHostIds());
    say("== 决策判据 ==");
    say(`   可接入(findAttachable)=${attachable ? `pid=${attachable.serverPid} url=${attachable.baseUrl}` : "无"}(${msA}ms)`);
    say(`   启动中(findStarting)=${starting ? `pid=${starting.serverPid}` : "无"}(${msS}ms)`);
    say(`   可接管(命令=现场那条)=${adoptable ? `pid=${adoptable.serverPid} url=${adoptable.baseUrl}` : "无"}(${msD}ms)`);
    say(`   活实例=${JSON.stringify(live.map((id) => id.slice(0, 8)))}(${msL}ms)`);
  }
}
