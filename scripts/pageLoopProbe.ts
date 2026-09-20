/**
 * 【探针定位】工具型 · 零 token —— 只读分页推演（不开写路径），不发消息，
 *   可自由运行。
 *
 * 「加载更早的历史」分页循环的真实推演（两档语义：官方 `loadOlder` / `loadThrough`）。
 *
 *   node build/page-loop-probe.mjs --session ff34f000 [--pages 8] [--target <seq>]
 *
 * 做的事与扩展**完全一致**（同一份适配器代码、同一个 `session/page` 调用序列）：
 *   1. `session/follow`（`maxMessages: 60`，与扩展同值）开窗；
 *   2. 反复 `session/page(cursor, earliestSeq)` 并 `absorbRecords(...)`——每页只**吸收**
 *      不结算（与宿主一致），循环结束后调一次 `settleHistory()`；
 *   3. 每页打印：这一页加进来多少事件、`hasMore`、`earliestSeq`，以及停止判据的结论；
 *      结算后打印最终的消息数与首条消息的角色/id。
 *
 * 两档：不带 `--target` = **单页档**（取一页即停）；带 `--target <seq>` = **到目标档**
 * （取到窗口覆盖该 seq 为止）。停在哪、为什么停，一眼可见。
 *
 * 只读：只开跟随流与分页，不发消息、不建会话。
 */
// 必须排在最前：会合目录与 DSH_HOME 都指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// 自检放这里还有一层作用：真的用到导出值，esbuild 才不会把副作用 import 摇掉。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[page-loop] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
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
/** 目标档的落点（缺省 = 单页档）。 */
const targetSeq = opt("--target") === undefined ? undefined : Number(opt("--target"));

const log = (line: string) => console.log(line);
const server = new SupervisorManager({ url: "", command: "dsh", log: () => {} });
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
      `hasMore=${adapter.hasMoreHistory()}；cursor=${adapter.cursor()}；earliestSeq=${adapter.earliestSeq()}；` +
      `档位=${targetSeq === undefined ? "单页档" : `到目标档 seq=${targetSeq}`}`,
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
    // 与宿主同一条路径：每页只**吸收**，循环结束后才结算一次
    // （`absorbRecords` / `settleHistory`，见 `src/dsh/adapter.ts`）
    const added = adapter.absorbRecords(
      (answer.records ?? []) as never[],
      Boolean(answer.hasMore),
    );
    console.log(
      `第 ${page} 页：records=${(answer.records ?? []).length} → **新并入 ${added} 条事件**；` +
        `消息仍 ${before.length} 条（吸收不结算，故不变）；` +
        `hasMore=${adapter.hasMoreHistory()}；earliestSeq=${adapter.earliestSeq()}`,
    );
    // 宿主侧的停止判据（与 `src/dsh/historyPaging.ts` 同一份逻辑）
    const stopTarget =
      targetSeq === undefined
        ? undefined
        : { seq: targetSeq, earliest: adapter.earliestSeq() ?? beforeSeq };
    if (!shouldContinuePaging(added, adapter.hasMoreHistory(), page, stopTarget)) {
      const why =
        added <= 0
          ? "这一页没有带来新事件 → 再取也没意义"
          : !adapter.hasMoreHistory()
            ? "服务端说没有更早的了"
            : targetSeq === undefined
              ? "单页档：取满一页即停（官方 loadOlder）"
              : `到目标档：窗口已覆盖 seq=${targetSeq}（或到页数安全阀 ${MAX_HISTORY_PAGES} 页）`;
      console.log(`   ■ 停止：${why}`);
      break;
    }
    console.log(`   · 窗口还没覆盖目标 seq=${targetSeq} → 继续取下一页`);
  }

  // 结算一次（宿主在 loadMore 的 finally 里做的同一件事）
  adapter.settleHistory();
  const finalMessages = adapter.snapshotMessages();
  console.log(
    `结算后：消息 ${finalMessages.length} 条；首条 = ${finalMessages[0]?.role ?? "?"} ${finalMessages[0]?.id ?? "?"}；` +
      `hasMore=${adapter.hasMoreHistory()}；earliestSeq=${adapter.earliestSeq()}`,
  );
} catch (error) {
  console.log(`探针失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  client?.dispose();
  server.stop();
}
