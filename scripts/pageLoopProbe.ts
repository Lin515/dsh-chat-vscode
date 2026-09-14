/**
 * 「加载更早的历史」分页循环的真实推演（用户 2026-09-15 报的「没取到上一条用户
 * 消息就停了」）。
 *
 *   node build/page-loop-probe.mjs --session ff34f000 [--pages 8]
 *
 * 做的事与扩展**完全一致**（同一份适配器代码、同一个 `session/page` 调用序列）：
 *   1. `session/follow`（`maxMessages: 60`，与扩展同值）开窗；
 *   2. 反复 `session/page(cursor, earliestSeq)` 并 `prependRecords(...)`；
 *   3. 每页打印：这一页加进来多少事件、`hasMore`、消息数与**首条消息**的角色/id，
 *      以及界面那条「顶部还是助手消息 → 接着取」的判据结论。
 * 停在哪、为什么停，一眼可见。
 *
 * 只读：只开跟随流与分页，不发消息、不建会话。
 */
import { SessionAdapter } from "../src/dsh/adapter";
import { DshClient } from "../src/dsh/client";
import { MAX_HISTORY_PAGES, shouldContinuePaging } from "../src/dsh/historyPaging";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const want = opt("--session") ?? "ff34f000";
const maxPages = Number(opt("--pages") ?? 8);
const maxMessages = Number(opt("--max-messages") ?? 60);

const log = (line: string) => console.log(line);
const server = new SupervisorManager({ url: "", command: "dsh", startTimeoutMs: 180_000, log: () => {} });
let client: DshClient | undefined;

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, () => {});
  await client.authenticate();
  client.connect();

  const rows = (await client.listSessions()).items as { sessionId: string; cwd?: string }[];
  const target =
    rows.find((row) => row.sessionId.includes(want)) ??
    rows.find((row) => (row.cwd ?? "").toLowerCase().includes("dsh-chat"));
  if (!target) throw new Error(`没找到会话 ${want}`);
  console.log(`会话：${target.sessionId}  cwd=${target.cwd ?? "?"}  maxMessages=${maxMessages}`);

  const adapter = new SessionAdapter(() => {});
  let done = false;
  const follow = client.followSession(
    target.sessionId,
    {
      onItem: (value) => {
        adapter.applyFrame(value as never);
        const frame = value as { type?: string };
        if (frame.type === "snapshot") done = true;
      },
    },
    { maxMessages },
  );
  const deadline = Date.now() + 60_000;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  follow.cancel();
  if (!done) throw new Error("等不到跟随开窗快照");

  const first = adapter.snapshotMessages()[0];
  console.log(
    `开窗：消息 ${adapter.snapshotMessages().length} 条；首条 = ${first?.role} ${first?.id ?? "?"}；` +
      `hasMore=${adapter.hasMoreHistory()}；cursor=${adapter.cursor()}；earliestSeq=${adapter.earliestSeq()}`,
  );

  for (let page = 1; page <= maxPages; page += 1) {
    const cursor = adapter.cursor();
    const beforeSeq = adapter.earliestSeq();
    if (cursor === undefined || beforeSeq === undefined) {
      console.log(`第 ${page} 页：拿不到分页锚点（cursor=${cursor} beforeSeq=${beforeSeq}）→ 停止`);
      break;
    }
    const answer = await client.page(target.sessionId, cursor, beforeSeq);
    const before = adapter.snapshotMessages();
    const beforeFirst = before[0]?.id;
    const added = adapter.prependRecords((answer.records ?? []) as never[], Boolean(answer.hasMore));
    const after = adapter.snapshotMessages();
    const top = after[0];
    console.log(
      `第 ${page} 页：records=${(answer.records ?? []).length} → **新并入 ${added} 条事件**；` +
        `消息 ${before.length} → ${after.length}；首条 ${beforeFirst ?? "?"} → ${top?.id ?? "?"}（${top?.role ?? "?"}）；` +
        `hasMore=${adapter.hasMoreHistory()}；earliestSeq=${adapter.earliestSeq()}`,
    );
    // 宿主侧的停止判据（与 `src/dsh/historyPaging.ts` 同一份逻辑）：
    // 现在是「一次取到底」——只有服务端说没有了、或这一页没进展才停。
    if (!shouldContinuePaging(added, adapter.hasMoreHistory(), page)) {
      const why =
        added <= 0
          ? "这一页没有带来新事件 → 再取也没意义"
          : !adapter.hasMoreHistory()
            ? "服务端说没有更早的了（= 已取回全部历史）"
            : `到页数安全阀 ${MAX_HISTORY_PAGES} 页`;
      console.log(`   ■ 停止：${why}`);
      break;
    }
    console.log(`   · 还有更早的历史 → 继续取下一页`);
  }
} catch (error) {
  console.log(`探针失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  client?.dispose();
  server.stop();
}
