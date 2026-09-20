/**
 * 【探针定位】工具型 · 零 token —— 直连**已有**服务只读打印，不发消息不起服务，
 *   可自由运行。
 *
 * 诊断探针：直连一个正在运行的 dsh web，打印会话列表与控制流 baseline。
 *
 * 用途：验证扩展界面显示的状态（队列数、模型投影）是否与服务端一致。
 *   node esbuild.probe.mjs && node build/probe.mjs <baseUrl> <token>
 */
import { DshClient } from "../src/dsh/client";
import { queueItemsFromInbox } from "../src/dsh/queueView";

const [baseUrl, token] = process.argv.slice(2);
if (!baseUrl) {
  console.error("用法：node build/probe.mjs <baseUrl> <token>");
  process.exit(1);
}

const client = new DshClient(baseUrl, token || undefined, () => {});
await client.authenticate();
client.connect();

const list = await client.listSessions();
const sessions = (list.items ?? []).slice().sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
console.log(`会话总数 ${sessions.length}；最近 6 个：`);
for (const item of sessions.slice(0, 6)) {
  const title = (item as any).projections?.values?.title;
  console.log(
    `  ${item.sessionId}  running=${item.running ? "Y" : "n"} blank=${item.blank ? "Y" : "n"} ` +
      `cwd=${item.cwd ?? "-"} title=${JSON.stringify(title ?? null)}`,
  );
}

const newest = sessions[0] as any;

console.log("\nsettings/describe 里的默认模型相关命名空间：");
try {
  const described = await client.settingsDescribe();
  const namespaces = described.namespaces ?? [];
  console.log(`  共 ${namespaces.length} 个命名空间`);
  for (const ns of namespaces) {
    if (/default|model/i.test(ns.ns)) {
      console.log(`    ${ns.ns} = ${JSON.stringify(ns.value)}`);
    }
  }
} catch (error) {
  console.log(`  失败：${error instanceof Error ? error.message : String(error)}`);
}

console.log(`\n控制流 baseline（关注 ${newest?.sessionId}）：`);
await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 12_000);
  client.followControl({
    onItem: (value: any) => {
      if (value?.type !== "baseline") {
        if (value?.type === "projection" && value.sessionId === newest?.sessionId) {
          console.log(`  投影推送 ${value.key} = ${JSON.stringify(value.value)}`);
        }
        return;
      }
      const queues = value.value?.queues ?? {};
      const jobs = value.value?.jobs ?? {};
      const projections = value.value?.projections ?? {};
      // 队列有两条通道：旧服务端的 baseline `queues`（2026-09-09 之前），
      // 当前服务端的 `inbox` 投影。两个都打印——排查「列表怎么没了」时，
      // 第一条要看的就是服务端到底发哪条。
      console.log(`  [旧通道] queues 里有 ${Object.keys(queues).length} 个会话有排队项：`);
      for (const [sessionId, items] of Object.entries<any>(queues)) {
        console.log(`    ${sessionId}: ${items.length} 项 → ${JSON.stringify(items).slice(0, 200)}`);
      }
      console.log(`  jobs 里有 ${Object.keys(jobs).length} 个会话有后台任务`);
      const forNewest = projections[newest?.sessionId]?.values ?? {};
      const inbox = queueItemsFromInbox(forNewest.inbox);
      console.log(`  [新通道] inbox 投影：${inbox.length} 项待发`);
      for (const entry of inbox) {
        console.log(`    ${entry.view.placement} ${entry.view.id} rpc=${entry.view.rpcId ?? "-"} → ${entry.view.text.slice(0, 40)}`);
      }
      console.log(`  最新会话投影键 ${Object.keys(forNewest).length} 个`);
      console.log(`    modelSelection = ${JSON.stringify(forNewest.modelSelection)}`);
      console.log(`    permissions = ${JSON.stringify(forNewest.permissions)}`);
      console.log(`    title = ${JSON.stringify(forNewest.title)}`);
      setTimeout(resolve, 4_000);
    },
  });
});

client.dispose();
