/**
 * 「轨迹 Schema 不可用」的回归：跟随窗口没带进 `request/header` 时，宿主**按需回补**
 * 更早的那几帧表头（`src/dsh/trajectoryBackfill.ts` + `SessionAdapter.absorbTrajectoryBackfill`
 * → `deriveTrajectoryModel` 的第三个参数）。
 *
 * 现场（2026-10-13，本机 784 份会话日志实测）：`session/page`/`follow` 的分页切点是
 * **按消息对齐**的（切点落在那条消息的 `sourceEventSeqs` 最小 seq 上），而
 * `request/header` 不属于任何消息 —— 只要落在这道刀口之外就被整个切掉。跟随开窗只带
 * `maxMessages` 条消息（本扩展 60，官方 500 + `turnWindow`），于是窗口一开就可能没有
 * 表头：窗口里所有工具行都取不到目录，界面上整片「Schema 不可用」。
 * 实测开窗那一刻有 **399 份会话、20810 条工具行**如此；按日志全量折叠则只有 15 条缺
 * （那些是真缺席，见下面 D 组）。
 *
 * 本文件按**缺 schemaDetail 的各种形态**分组：
 * - A. 窗口没带表头（可修）：回补表头后恢复，且**账本一行都不许多**；
 * - B. 回补不许动聊天流（事件集 / 分页锚点 / hasMore 都不许变）；
 * - C. 判据本身（谁才算「窗口缺表头」）；
 * - D. 真缺席（表头在、目录里就是没有这个名字 / 表头比调用晚到）：**填补不了**，
 *      而且判据必须返回 `undefined`，否则回补会一路翻到底还翻不出东西；
 * - E. 回补循环的停止条件（没有新事件 / 没有更早的 / 页数上限）；
 * - F. 重连新开窗要清掉回补的那一份；
 * - G. 控制器接线（源码级）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import type { SessionWireEvent } from "../src/dsh/protocol";
import { deriveTrajectoryModel } from "../src/dsh/trajectory";
import { trajectoryTurnCells } from "../src/shared/trajectory";
import type { TrajectoryCell } from "../src/shared/trajectory";
import {
  MAX_SCHEMA_BACKFILL_PAGES,
  SCHEMA_BACKFILL_PAGE_MESSAGES,
  backfillTrajectorySchemas,
  missingSchemaAnchor,
} from "../src/dsh/trajectoryBackfill";

const at = (seq: number) => 1_700_000_000_000 + seq * 1000;

/** 收集宿主 → 界面的帧（与 `historyReplay.test.ts` 同一套：深拷贝模拟 postMessage）。 */
function harness() {
  const frames: string[] = [];
  const adapter = new SessionAdapter((original) => {
    frames.push((structuredClone(original) as { type: string }).type);
  });
  return { adapter, frames };
}

/** `session/follow` 开帧：窗口内容由 `records` 给，`cursor` 是分页的 `throughSeq`。 */
function openWindow(adapter: SessionAdapter, records: SessionWireEvent[], cursor: number, hasMore: boolean): void {
  adapter.applyFrame({
    type: "snapshot",
    header: { version: 3, id: "s1", createdAt: at(0) },
    cursor,
    hasMore,
    projections: { asOfSeq: cursor, values: {} },
    records: records.map((event) => ({ type: "event", event })),
  } as never);
}

const header = (seq: number, tools: string[], reason = "initial"): SessionWireEvent =>
  ({
    type: "request/header",
    seq,
    time: at(seq),
    data: { header: { config: { provider: "p", model: "m" }, tools: tools.map((name) => ({ name })) }, reason },
  }) as never;

/** 一次工具调用（含它所属的轮次 / 步骤 / 助手消息）：折叠后是一条 `tool` 记录。 */
function toolCall(seq: number, callId: string, name: string, turn = 1, step = 1): SessionWireEvent[] {
  return [
    { type: "turn/start", seq, time: at(seq), data: { turn } },
    { type: "step/start", seq: seq + 1, time: at(seq + 1), data: { turn, step } },
    {
      type: "assistant/message",
      seq: seq + 2,
      time: at(seq + 2),
      data: { turn, step, message: { id: `m${seq}`, role: "assistant", content: [{ type: "text", text: "调用一下" }] } },
    },
    { type: "tool/call", seq: seq + 3, time: at(seq + 3), data: { turn, step, callId, name, arguments: "{}" } },
    {
      type: "tool/result",
      seq: seq + 4,
      time: at(seq + 4),
      data: { message: { source: { callId }, content: [{ type: "tool-result", content: [{ type: "text", text: "ok" }] }] } },
    },
    { type: "turn/end", seq: seq + 5, time: at(seq + 5), data: { turn, reason: "success" } },
  ] as never[];
}

/** 与控制器同一套接线折一次：窗口事件 + 已回补的表头 + hasOlder。 */
function foldCells(adapter: SessionAdapter): TrajectoryCell[] {
  return deriveTrajectoryModel(
    adapter.trajectoryEvents(),
    adapter.hasMoreHistory(),
    adapter.trajectoryCallCatalogs(),
  ).turns.flatMap(trajectoryTurnCells);
}

function toolCells(adapter: SessionAdapter): TrajectoryCell[] {
  return foldCells(adapter).filter((cell) => cell.kind === "tool" || cell.kind === "subtool");
}

function anchorOf(adapter: SessionAdapter): number | undefined {
  const events = adapter.trajectoryEvents();
  const catalogs = adapter.trajectoryCallCatalogs();
  return missingSchemaAnchor(deriveTrajectoryModel(events, adapter.hasMoreHistory(), catalogs), events, catalogs);
}

interface Page {
  records: { type: "event"; event: SessionWireEvent }[];
  hasMore: boolean;
}

/** 把回补循环接到真的适配器上，`fetchPage` 由一张「脚本化」的页表回答。 */
function wireBackfill(adapter: SessionAdapter, pages: Page[]) {
  const requests: { throughSeq: number; beforeSeq: number; maxMessages: number }[] = [];
  let served = 0;
  const seam = {
    missingAnchor: () => anchorOf(adapter),
    earliestSeq: () => adapter.trajectoryEarliestSeq(),
    throughSeq: () => adapter.cursor(),
    fetchPage: async (request: { throughSeq: number; beforeSeq: number; maxMessages: number }) => {
      requests.push(request);
      const page = pages[served] ?? { records: [], hasMore: false };
      served += 1;
      return page;
    },
    absorb: (records: readonly unknown[]) => adapter.absorbTrajectoryBackfill(records as never[]),
  };
  return { requests, run: () => backfillTrajectorySchemas(seam) };
}

const pageOf = (events: SessionWireEvent[], hasMore: boolean): Page => ({
  records: events.map((event) => ({ type: "event", event })),
  hasMore,
});

// ---------- A1. 窗口没带表头：整段窗口的工具行都没有 schema（缺陷现场） ----------
{
  const { adapter } = harness();
  openWindow(adapter, toolCall(100, "c1", "read"), 105, true);

  const cells = toolCells(adapter);
  assert.strictEqual(cells.length, 1, "窗口里有一条工具行");
  assert.strictEqual(cells[0].toolName, "read");
  assert.strictEqual(
    cells[0].schemaDetail,
    undefined,
    "窗口里没有 request/header → 这一条取不到目录（界面上就是「Schema 不可用」）",
  );
  assert.strictEqual(anchorOf(adapter), 103, "判据锚点 = 那条工具行的 seq（它的目录不在窗口里）");
}
console.log("trajectorySchemaBackfill: 窗口没带表头 → 工具行缺 schema ✓");

// ---------- A2. 回补一页（那一页里有表头）→ 同一批工具行拿到 schema，账本行数不变 ----------
{
  const { adapter, frames } = harness();
  openWindow(adapter, toolCall(100, "c1", "read"), 105, true);
  const before = adapter.snapshotMessages().length;
  const beforeCells = foldCells(adapter);
  frames.length = 0;

  const { requests, run } = wireBackfill(adapter, [
    pageOf([header(1, ["read", "write"]), ...toolCall(10, "c0", "write")], false),
  ]);
  const changed = await run();

  assert.strictEqual(changed, true, "补进来了事件 → 调用方要重折补发一帧");
  assert.strictEqual(requests.length, 1, "一页就够：补进来那一页里带上了表头");
  assert.deepStrictEqual(
    requests[0],
    { throughSeq: 105, beforeSeq: 100, maxMessages: SCHEMA_BACKFILL_PAGE_MESSAGES },
    "beforeSeq 取回补锚点、throughSeq 取自开帧 cursor",
  );
  const afterCells = foldCells(adapter);
  const read = toolCells(adapter).find((cell) => cell.seq === 103);
  assert.ok(read, "回补后窗口里那条工具行仍在");
  assert.ok(read!.schemaDetail !== undefined, "回补把表头带进来后，这一条必须拿到目录（Schema 有内容）");
  assert.ok(read!.schemaDetail!.includes('"name": "read"'), "拿到的就是那一帧表头里的那一份目录");

  // —— 回补**不进账本**：面板正开着的时候往上面插行会把用户的视图顶走 ——
  assert.deepStrictEqual(
    afterCells.map((cell) => cell.index),
    beforeCells.map((cell) => cell.index),
    "账本的行号不许变（界面按行号定位 / 滚动）",
  );
  assert.deepStrictEqual(
    afterCells.map((cell) => cell.kind),
    beforeCells.map((cell) => cell.kind),
    "行的种类也不许变：补进来的表头**不出**一行「工具已更新」",
  );
  assert.strictEqual(
    afterCells.filter((cell) => cell.kind === "tool").length,
    1,
    "补进来的那一页里的调用（write）不进账本（它在窗口之外，用户没要求看）",
  );
  assert.strictEqual(anchorOf(adapter), undefined, "补齐之后判据不再成立（不许接着往前翻）");
  assert.strictEqual(adapter.snapshotMessages().length, before, "回补不产生聊天消息");
  assert.ok(
    !frames.includes("messages/reset"),
    "回补不许发聊天流的整份 reset（它只补表头，不是「加载更早」）",
  );
  assert.deepStrictEqual(
    adapter.trajectoryCallCatalogs().map((catalog) => [catalog.seq, catalog.tools?.map((tool) => tool.name)]),
    [[1, ["read", "write"]]],
    "回补只留下表头那一份最小形状（seq + 那一帧的目录）",
  );
}
console.log("trajectorySchemaBackfill: 回补表头 → Schema 恢复且账本不变 ✓");

// ---------- A3. 回补窗口外**更早**的表头之后，窗口最前面那几条也拿到 schema ----------
{
  const { adapter } = harness();
  // 窗口里有一条**不是**表头的 request/header（工具无关的请求）：它不给目录，
  // 但它本身是窗口里的事件，判据要认得它「在调用之前」。
  openWindow(adapter, [header(90, []), ...toolCall(100, "c1", "read")], 105, true);
  assert.strictEqual(anchorOf(adapter), undefined, "窗口里有表头（哪怕它没带目录）→ 不触发回补");
  assert.strictEqual(toolCells(adapter)[0].schemaDetail, undefined, "工具无关的请求不给目录 → 保持缺席");

  const older = harness();
  openWindow(older.adapter, toolCall(100, "c1", "read"), 105, true);
  const { run } = wireBackfill(older.adapter, [pageOf([header(1, ["read"])], true)]);
  await run();
  assert.ok(toolCells(older.adapter)[0].schemaDetail !== undefined, "补进窗口外的表头 → 拿到目录");
}
console.log("trajectorySchemaBackfill: 工具无关的表头 / 更早的表头 ✓");

// ---------- B. 回补只进轨迹那一份：聊天流的事件集 / 锚点 / hasMore 一律不动 ----------
{
  const { adapter } = harness();
  openWindow(adapter, toolCall(100, "c1", "read"), 105, true);
  const chatEarliest = adapter.earliestSeq();
  const chatMessages = adapter.snapshotMessages();

  const { run } = wireBackfill(adapter, [pageOf([header(1, ["read"])], true)]);
  await run();

  assert.strictEqual(adapter.earliestSeq(), chatEarliest, "聊天流的分页锚点不许被回补推小");
  assert.strictEqual(adapter.snapshotMessages(), chatMessages, "聊天消息流那一份不许被换掉");
  assert.strictEqual(adapter.hasMoreHistory(), true, "hasMore 是聊天流的事实，回补不许改它");
  assert.strictEqual(adapter.trajectoryEvents().length, 6, "轨迹折叠的事件集仍是窗口那一份");
  assert.strictEqual(adapter.trajectoryEarliestSeq(), 1, "回补锚点（beforeSeq）才是被推小的那个");
  assert.strictEqual(
    adapter.absorbTrajectoryBackfill([{ type: "event", event: header(1, ["read"]) }] as never),
    0,
    "同一个 seq 再吸收一次不算新增（回补循环据此停下）",
  );
}
console.log("trajectorySchemaBackfill: 回补与聊天流分离 ✓");

// ---------- C. 判据：谁才算「窗口缺表头」 ----------
{
  // C1. 表头落在那条工具行之前 → 不是窗口的锅（真缺席），不触发回补
  const { adapter } = harness();
  openWindow(adapter, [header(50, ["write"]), ...toolCall(100, "c1", "read")], 105, true);
  assert.strictEqual(anchorOf(adapter), undefined, "有前驱表头 → 判据返回 undefined");

  // C2. 全是「有 schema」的工具行 → 不需要回补
  const ok = harness();
  openWindow(ok.adapter, [header(1, ["read"]), ...toolCall(100, "c1", "read")], 105, true);
  assert.strictEqual(toolCells(ok.adapter)[0].schemaDetail !== undefined, true, "这一条本来就有目录");
  assert.strictEqual(anchorOf(ok.adapter), undefined, "没有缺的 → 判据返回 undefined");

  // C3. 多条缺的时候取**最老**那条（补页要从最老那条之前开始，否则前面几条仍然缺）
  const many = harness();
  openWindow(many.adapter, [...toolCall(100, "c1", "read", 1, 1), ...toolCall(200, "c2", "grep", 2, 1)], 205, true);
  assert.strictEqual(anchorOf(many.adapter), 103, "锚点取最老那条工具行的 seq");

  // C4. 已经补进来的表头也算「有前驱表头」——否则每轮都会把同样几页再取一遍
  const backfilled = harness();
  openWindow(backfilled.adapter, toolCall(100, "c1", "read"), 105, true);
  backfilled.adapter.absorbTrajectoryBackfill([
    { type: "event", event: header(1, ["write"]) },
  ] as never);
  assert.strictEqual(
    anchorOf(backfilled.adapter),
    undefined,
    "补进来的表头同样满足判据：那一帧目录里没有 read，是真缺席，不许再翻",
  );
}
console.log("trajectorySchemaBackfill: 判据（有前驱表头 / 不缺 / 取最老 / 补过的不再翻） ✓");

// ---------- D1. `resume` 表头的目录变小（MCP 工具还没连上来）→ 真缺席，不许回补 ----------
//
// 真实日志里的形态（2026-10-13）：`request/header` reason=resume 只带 32 个工具
// （`mcp__playwright__*` 不在里面），那一窗里的 `mcp__playwright__browser_navigate`
// 就是取不到目录——官方 `captureSchemas()` 的判据同样是「调用之前最近的表头」，
// 回查后来的表头会拿到**调用当时并不存在**的那一份。
{
  const { adapter } = harness();
  openWindow(
    adapter,
    [
      header(1, ["read", "mcp__playwright__browser_navigate"]),
      header(50, ["read"], "resume"),
      ...toolCall(100, "c1", "mcp__playwright__browser_navigate"),
    ],
    105,
    true,
  );
  const cells = toolCells(adapter);
  assert.strictEqual(cells[0].schemaDetail, undefined, "那一帧表头里没有这个工具名 → 真缺席");
  assert.strictEqual(anchorOf(adapter), undefined, "表头在前 → 判据不许把它算成「窗口缺表头」");

  const { requests, run } = wireBackfill(adapter, [pageOf([header(0, ["mcp__playwright__browser_navigate"])], false)]);
  const changed = await run();
  assert.strictEqual(changed, false, "真缺席不许回补");
  assert.strictEqual(requests.length, 0, "一页都不许取（否则每次开面板都白翻一遍历史）");
  assert.strictEqual(toolCells(adapter)[0].schemaDetail, undefined, "缺席保持缺席（不臆造 schema）");
}
console.log("trajectorySchemaBackfill: resume 缩水目录 = 真缺席，不回补 ✓");

// ---------- D2. 目录里只有「更晚的表头」才有这个名字 → 也不回查 ----------
{
  const { adapter } = harness();
  openWindow(
    adapter,
    [
      header(1, ["write"]),
      ...toolCall(100, "c1", "read", 1, 1),
      header(150, ["write", "read"], "change"),
      ...toolCall(200, "c2", "read", 2, 1),
    ],
    205,
    true,
  );
  const cells = toolCells(adapter);
  const early = cells.find((cell) => cell.seq === 103);
  const later = cells.find((cell) => cell.seq === 203);
  assert.strictEqual(early?.schemaDetail, undefined, "调用时目录里没有 read → 保持缺席（不回查新目录）");
  assert.strictEqual(later?.schemaDetail !== undefined, true, "表头补上 read 之后的那次调用有目录");
  assert.strictEqual(anchorOf(adapter), undefined, "两条都在表头之后 → 判据不成立");
}
console.log("trajectorySchemaBackfill: 不回查更晚的目录 ✓");

// ---------- D3. 表头比调用**晚到**（分叉 / 窗口错位）→ 真缺席 ----------
{
  const { adapter } = harness();
  openWindow(adapter, [...toolCall(100, "c1", "read"), header(200, ["read"])], 205, true);
  assert.strictEqual(toolCells(adapter)[0].schemaDetail, undefined, "调用之前的窗口里没有表头 → 缺席");
  assert.strictEqual(anchorOf(adapter), 103, "这一条确实属于「窗口缺表头」（回头翻历史可能翻得到）");
}
console.log("trajectorySchemaBackfill: 表头晚于调用 ✓");

// ---------- D4. 结果在窗口里、调用在窗口外（结果行）→ 不给 schema（与官方同口径） ----------
//
// 这种行没有工具名（连查什么都没法查），官方那边 `callSchemas` 也装的是加载到的**调用**，
// 所以同样显示不可用。回补**刻意不**为它臆造一份：把调用事件也回补进来只会让账本多一行
// （见 A2 的口径）。它是本修复**不覆盖**的一类，这里把边界钉住，免得下次误判成回归。
{
  const { adapter } = harness();
  openWindow(
    adapter,
    [
      { type: "turn/start", seq: 50, time: at(50), data: { turn: 1 } },
      header(51, ["read"]),
      {
        type: "tool/result",
        seq: 52,
        time: at(52),
        data: {
          message: {
            source: { callId: "c9" },
            content: [{ type: "tool-result", content: [{ type: "text", text: "窗口外的那个调用的结果" }] }],
          },
        },
      },
    ] as never,
    60,
    true,
  );
  const cells = toolCells(adapter);
  assert.strictEqual(cells.length, 1, "只有结果也出一行（官方 `resultAsText()` 同口径）");
  assert.strictEqual(cells[0].toolName, undefined, "没有调用事件 → 这一行没有工具名");
  assert.strictEqual(cells[0].schemaDetail, undefined, "没有工具名就没有目录可查（官方这种行也不可用）");
  assert.strictEqual(anchorOf(adapter), undefined, "表头在它之前 → 不触发回补");
}
console.log("trajectorySchemaBackfill: 结果行（调用在窗口外）= 已知边界 ✓");

// ---------- E1. 停止条件：这一页没有新事件 ----------
{
  const { adapter } = harness();
  openWindow(adapter, toolCall(100, "c1", "read"), 105, true);
  const { requests, run } = wireBackfill(adapter, [pageOf([], true)]);
  const changed = await run();
  assert.strictEqual(changed, false, "没补进来东西 → 不必重折补帧");
  assert.strictEqual(requests.length, 1, "取一页、没进展就停（不死循环）");
}
console.log("trajectorySchemaBackfill: 空页即停 ✓");

// ---------- E2. 停止条件：服务端说没有更早的 ----------
{
  const { adapter } = harness();
  openWindow(adapter, toolCall(100, "c1", "read"), 105, true);
  const { requests, run } = wireBackfill(adapter, [
    pageOf([{ type: "step/start", seq: 1, time: at(1), data: { turn: 1, step: 0 } }], false),
  ]);
  await run();
  assert.strictEqual(requests.length, 1, "hasMore=false（且这一页不含表头）时停手");
  assert.strictEqual(anchorOf(adapter), 103, "判据仍成立（那一段历史确实没有表头），但已经没得取了");
}
console.log("trajectorySchemaBackfill: 没有更早的即停 ✓");

// ---------- E3. 停止条件：页数上限（下一轮接着补，进度单调） ----------
{
  const { adapter } = harness();
  openWindow(adapter, toolCall(1000, "c1", "read"), 1005, true);
  // 每一页都带来新事件但都不含表头：锚点一直成立，只有页数上限能停住
  const pages: Page[] = Array.from({ length: MAX_SCHEMA_BACKFILL_PAGES + 3 }, (_unused, index) =>
    pageOf([{ type: "step/start", seq: 900 - index, time: at(900 - index), data: { turn: 1, step: 0 } }], true),
  );
  const { requests, run } = wireBackfill(adapter, pages);
  const changed = await run();
  assert.strictEqual(changed, true, "取到了东西 → 控制器要补发一帧");
  assert.strictEqual(requests.length, MAX_SCHEMA_BACKFILL_PAGES, "一轮最多取到上限就停");
  assert.ok(anchorOf(adapter) !== undefined, "判据仍成立：下一轮 listTrajectory 接着往前补");
}
console.log("trajectorySchemaBackfill: 页数上限即停 ✓");

// ---------- F. 重连新开窗：回补的那一份随窗口作废 ----------
{
  const { adapter } = harness();
  openWindow(adapter, toolCall(100, "c1", "read"), 105, true);
  const { run } = wireBackfill(adapter, [pageOf([header(1, ["read"])], true)]);
  await run();
  assert.strictEqual(adapter.trajectoryEarliestSeq(), 1, "回补已生效");
  assert.strictEqual(adapter.trajectoryCallCatalogs().length, 1, "表头那一份已记下");

  openWindow(adapter, toolCall(100, "c1", "read"), 105, true);
  assert.strictEqual(adapter.trajectoryEarliestSeq(), 100, "新开窗后回补的锚点不许残留");
  assert.deepStrictEqual(adapter.trajectoryCallCatalogs(), [], "新开窗后补来的表头不许残留");
  assert.strictEqual(toolCells(adapter)[0].schemaDetail, undefined, "新窗口要重新判锚点");
}
console.log("trajectorySchemaBackfill: 新开窗清掉回补 ✓");

// ---------- G. 控制器接线（源码级）：`listTrajectory` 真的走了这条回补 ----------
//
// 循环本身由上面 A–F 用它自己的 seam 驱过；这一层钉的是**接线**：入口改成走
// `sendTrajectory`、补的是轨迹专用的那一份、折叠时把补来的目录带上。控制器的行为级
// harness 要先搭一套假服务端与跟随流（几百行），而这里要防的回归只是「有人把入口改
// 回去 / 接错吸收路径 / 忘了把目录交给折叠」。
{
  const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /case "listTrajectory":\s*\n\s*await this\.sendTrajectory\(viewId\);/m.test(source),
    "`listTrajectory` 必须走 `sendTrajectory`（否则回补永远不会被触发）",
  );
  const body = /private async sendTrajectory\(viewId: string\)[\s\S]*?\n  \}/m.exec(source)?.[0] ?? "";
  assert.ok(body.length > 0, "controller.ts 里找不到 `sendTrajectory`");
  assert.ok(/backfillTrajectorySchemas\(/.test(body), "`sendTrajectory` 要调用回补循环");
  assert.ok(
    /absorbTrajectoryBackfill\(/.test(body),
    "回补要接**轨迹专用**的吸收路径（`absorbTrajectoryBackfill`），不能走聊天流的 `absorbRecords`",
  );
  assert.ok(
    !/absorbRecords\(/.test(body),
    "`sendTrajectory` 里不许出现 `absorbRecords`（那会把轨迹要的旧事件塞进聊天流）",
  );
  assert.ok(
    (body.match(/trajectoryCallCatalogs\(\)/g) ?? []).length >= 2,
    "折叠与判据都要拿到补来的目录（两处各一次），否则补了也用不上",
  );
  assert.ok(
    /trajectoryBackfilling/.test(body),
    "回补要有宿主侧并发闸门（运行中每 3 秒一次 `listTrajectory`）",
  );
}
console.log("trajectorySchemaBackfill: 控制器接线 ✓");

console.log("\ntrajectorySchemaBackfill: all assertions passed");
