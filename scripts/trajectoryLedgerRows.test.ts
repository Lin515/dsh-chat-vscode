/**
 * 账本**行投影**的离线断言（`src/webview/trajectoryLedgerRows.ts`）。
 *
 * 这一段规则从前长在 `components/Trajectory.tsx` 的渲染循环里，没有任何离线防线，
 * 于是三条都在主代理的真实 DOM 验收里红了：
 *
 * - **每一轮都要有起点**：整本账本只有一个 `labelShown` 标志，60 轮的长账本只出
 *   第一轮的轮次标签（真机 `is-turn-start` 的 `#N` 实测 `[1]`，应为 `[1,5,9]`…）；
 * - **搜索优先于折叠**：搜索命中一条被「调用折叠」收走的工具行时结果为**空**，
 *   而被「轮次折叠」收走时又整轮照出（实测 `[]` 与 `[1,5,9]`，都应为 `[2]`）；
 * - **清掉查询要恢复原来的折叠**：投影只读两个折叠集合，不改它们。
 *
 * 运行：npm test（本文件登记在 `esbuild.scripts.mjs` 的 entries 里）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trajectoryTurnCells } from "../src/shared/trajectory";
import type { TrajectoryCell, TrajectoryTurn } from "../src/shared/trajectory";
import {
  trajectoryCollapsibleCalls,
  trajectoryCollapsibleTurns,
  trajectoryLedgerRows,
} from "../src/webview/trajectoryLedgerRows";
import { trajectoryCellRecordId } from "../src/webview/trajectoryVendor";

/** 一条记录（只放投影用得到的字段）。 */
function cell(
  index: number,
  kind: TrajectoryCell["kind"],
  turn: number | null,
  extra: Partial<TrajectoryCell> = {},
): TrajectoryCell {
  return {
    index,
    kind,
    turn,
    seq: index,
    time: index * 1000,
    text: `#${index}`,
    timeSeconds: null,
    startedAt: null,
    ...extra,
  };
}

/**
 * 三轮账本，形状照真实的 `?trajectory=long` 夹具：每轮一条用户/助手消息 + 一条工具行
 * + 一条上下文行（序号 1/2/3/4、5/6/7/8、9/10/11/12）。
 */
const turns: TrajectoryTurn[] = [0, 1, 2].map((turn) => ({
  turn,
  groups: [
    { title: { kind: "message" }, cells: [cell(turn * 4 + 1, "message", turn)] },
    {
      title: { kind: "step", step: 1 },
      cells: [
        cell(turn * 4 + 2, "tool", turn, { callId: `call_${turn}` }),
        cell(turn * 4 + 3, "message", turn),
        cell(turn * 4 + 4, "context", turn),
      ],
    },
  ],
}));

const indexes = (input: Parameters<typeof trajectoryLedgerRows>[0]) =>
  trajectoryLedgerRows(input).map((row) =>
    row.summary === "turn"
      ? `sum${row.turn}`
      : row.summary === "assistant"
        ? `asum${row.record?.index}`
        : row.cellIndex,
  );

const NONE = new Set<number>();
const NO_FOLD = new Set<string>();

// ---------- 1. 每一轮各有一个起点（官方 flattenRecords 的 firstInSection 是**按段**的） ----------
{
  const rows = trajectoryLedgerRows({ turns, collapsedTurns: NONE, collapsedCalls: NO_FOLD, matchIndexes: null });
  const starts = rows.filter((row) => row.turnStart).map((row) => row.cellIndex);
  assert.deepStrictEqual(
    starts,
    [1, 5, 9],
    "三段各出一个轮次标签：全账本只出一枚是从前的缺陷（真机实测 [1]）",
  );
  assert.deepStrictEqual(
    indexes({ turns, collapsedTurns: NONE, collapsedCalls: NO_FOLD, matchIndexes: null }),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    "不折叠、不搜索时整份账本按原序出行",
  );
  // 起点不是「每段第一行」：`system` 与 `requestOnly` 都要跳过
  const withSystem: TrajectoryTurn[] = [
    {
      turn: 0,
      groups: [
        {
          title: { kind: "message" },
          cells: [
            cell(1, "system", 0, { systemPromptDetail: "s" }),
            cell(2, "context", 0, { requestOnly: true }),
            cell(3, "user", 0),
          ],
        },
      ],
    },
  ];
  const systemRows = trajectoryLedgerRows({ turns: withSystem, collapsedTurns: NONE, collapsedCalls: NO_FOLD, matchIndexes: null });
  assert.deepStrictEqual(
    systemRows.filter((row) => row.turnStart).map((row) => row.cellIndex),
    [3],
    "起点跳过 system 与 requestOnly（官方同款：标签落在第一条像样的记录上）",
  );
}

// ---------- 2. 搜索优先于折叠（官方 records 的 filterRecords 分支） ----------
{
  const hit2 = new Set([2]);
  // 控制组：不折叠
  assert.deepStrictEqual(
    indexes({ turns, collapsedTurns: NONE, collapsedCalls: NO_FOLD, matchIndexes: hit2 }),
    [2],
    "命中一条就只出这一条",
  );
  // 调用折叠收起的是 assistant 行后面那串工具行——搜索必须照旧查得到
  const collapsedCalls = new Set(["message\u0000seq\u00001"]);
  assert.deepStrictEqual(
    indexes({ turns, collapsedTurns: NONE, collapsedCalls, matchIndexes: hit2 }),
    [2],
    "命中被「调用折叠」收走的工具行时仍要出这一行（真机实测是空）",
  );
  // 轮次折叠同理：整轮收起也不能把命中的行吞掉
  const collapsedTurns = new Set([0, 1, 2]);
  assert.deepStrictEqual(
    indexes({ turns, collapsedTurns, collapsedCalls: NO_FOLD, matchIndexes: hit2 }),
    [2],
    "命中被「轮次折叠」收走的行时仍要出这一行（真机实测是整轮 [1,5,9]）",
  );
  // 零命中：一条都不出（也不出任何摘要行）
  const zero = trajectoryLedgerRows({ turns, collapsedTurns, collapsedCalls, matchIndexes: new Set<number>() });
  assert.deepStrictEqual(zero, [], "零命中就是空账本——不出摘要行，也不退回折叠视图");
  // 命中集合里的 `requestOnly` 锚点行不进结果（官方 filterRecords 明确滤掉）
  const requestOnlyTurn: TrajectoryTurn[] = [
    {
      turn: 0,
      groups: [
        {
          title: { kind: "step", step: 0 },
          cells: [cell(1, "context", 0, { requestOnly: true }), cell(2, "message", 0)],
        },
      ],
    },
  ];
  assert.deepStrictEqual(
    indexes({ turns: requestOnlyTurn, collapsedTurns: NONE, collapsedCalls: NO_FOLD, matchIndexes: new Set([1, 2]) }),
    [2],
    "请求锚点行没有可搜的内容，命中也不出（官方同款）",
  );
  // 搜索期间的轮次标签按**过滤后**的列表重算（官方 filterRecords 的重算那一段）
  const searchRows = trajectoryLedgerRows({ turns, collapsedTurns, collapsedCalls, matchIndexes: hit2 });
  assert.deepStrictEqual(
    searchRows.filter((row) => row.turnStart).map((row) => row.cellIndex),
    [2],
    "过滤后每一段的第一条命中就是该段的起点",
  );
}

// ---------- 3. 清掉查询恢复原有折叠（投影不改两个折叠集合） ----------
{
  const collapsedTurns = new Set([0]);
  const collapsedCalls = new Set(["message\u0000seq\u00001"]);
  const searched = trajectoryLedgerRows({ turns, collapsedTurns, collapsedCalls, matchIndexes: new Set([2]) });
  assert.deepStrictEqual(searched.map((row) => row.cellIndex), [2], "搜索期只按命中出行");
  assert.deepStrictEqual([...collapsedTurns], [0], "投影不改调用方的折叠集合（清查询后要原样回来）");
  assert.deepStrictEqual([...collapsedCalls], ["message\u0000seq\u00001"], "同上");
  const restored = trajectoryLedgerRows({ turns, collapsedTurns, collapsedCalls, matchIndexes: null });
  assert.deepStrictEqual(
    indexes({ turns, collapsedTurns, collapsedCalls, matchIndexes: null }),
    restored.map((row) => (row.summary === undefined ? row.cellIndex : `sum${row.turn}`)),
    "清掉查询恢复的就是同一套折叠",
  );
  assert.ok(restored.some((row) => row.summary === "turn" && row.turn === 0), "第 0 轮仍收着");
}

// ---------- 4. 轮次折叠：官方 collapseTurnRecords 的逐条规则 ----------
{
  const withSystem: TrajectoryTurn[] = [
    {
      turn: 0,
      groups: [
        {
          title: { kind: "message" },
          cells: [
            cell(1, "system", 0, { systemPromptDetail: "s" }),
            cell(2, "context", 0, { requestOnly: true }),
            cell(3, "user", 0),
            cell(4, "tool", 0, { callId: "c" }),
            cell(5, "context", 0),
          ],
        },
      ],
    },
  ];
  const rows = trajectoryLedgerRows({
    turns: withSystem,
    collapsedTurns: new Set([0]),
    collapsedCalls: NO_FOLD,
    matchIndexes: null,
  });
  assert.deepStrictEqual(
    rows.map((row) => (row.summary === undefined ? row.cellIndex : "summary")),
    [1, 2, 3, "summary"],
    "只留 system / 请求锚点 / 第一条内容行，摘要行紧随其后（官方同款）",
  );
  assert.strictEqual(rows.at(-1)?.cellIndex, -1, "摘要行没有记录下标");
  assert.strictEqual(rows.at(-1)?.turn, 0, "摘要行记得自己属于哪一轮");
  assert.strictEqual(rows.find((row) => row.cellIndex === 3)?.turnStart, true, "留着的内容行继续顶轮次标签");
  assert.strictEqual(rows.at(-1)?.turnStart, false, "摘要行不顶标签（两行都挂就重了）");

  // 内容行 ≤ 1 时整轮不收（官方 `contentRecords.length <= 1` 直接原样返回）
  const single: TrajectoryTurn[] = [
    { turn: 0, groups: [{ title: { kind: "message" }, cells: [cell(1, "user", 0)] }] },
  ];
  assert.deepStrictEqual(
    trajectoryLedgerRows({ turns: single, collapsedTurns: new Set([0]), collapsedCalls: NO_FOLD, matchIndexes: null }).map((row) => row.cellIndex),
    [1],
    "一轮就一条内容行时折叠集合即便有它也不收",
  );

  // 轮次之间（turn === null）没有可折叠的轮号：`system` / 压缩行都照原样出
  const between: TrajectoryTurn[] = [
    {
      turn: null,
      groups: [
        { title: { kind: "compaction", seq: 7 }, cells: [cell(1, "compacted", null)] },
        { title: { kind: "message" }, cells: [cell(2, "system", null, { systemPromptDetail: "s" })] },
      ],
    },
  ];
  const betweenRows = trajectoryLedgerRows({ turns: between, collapsedTurns: new Set([0, 1]), collapsedCalls: NO_FOLD, matchIndexes: null });
  assert.deepStrictEqual(betweenRows.map((row) => row.cellIndex), [1, 2], "轮次之间那一段不受轮号折叠影响");
  assert.strictEqual(
    betweenRows.find((row) => row.cellIndex === 1)?.turnStart,
    true,
    "压缩行在「轮次之间」那一段算起点（官方 `cell.kind !== 'compacted' || turn === null`）",
  );
  assert.strictEqual(betweenRows.find((row) => row.cellIndex === 2)?.turnStart, false, "system 行不算起点");
}

// ---------- 5. 调用折叠：收走助手行**后面那串**工具行，并补一枚摘要呈现行 ----------
//
// 官方 `collapseAssistantRecords`（rc2 `TrajectoryTable.tsx`）：原助手行留着
// （`out.push(record)`，只把 `turnEnd` 抹掉），紧跟其后**追加**一枚
// `{...record, collapsedSummary, collapsedSummaryKind:'assistant'}` 的呈现行。
// 那一枚是布局行，不是又一条 primary 记录：官方给它 `data-record-index=undefined`、
// `aria-selected=false`，点击 / 回车走的是 `onToggleAssistant(recordId)`（展开），
// 不是 `selectRecord`。本扩展照此：`cellIndex` 保持 -1、key 独立、DOM 不带
// `data-cell-index`（不然两行同号会撞坏虚拟窗口的「严格递增」不变量与按 index 的定位），
// 但仍然共享原记录的 cell / recordId / 请求身份，所以它指向的还是那一条助手记录。
{
  const id1 = trajectoryCellRecordId(cell(1, "message", 0));
  const rows = trajectoryLedgerRows({
    turns,
    collapsedTurns: NONE,
    collapsedCalls: new Set([id1]),
    matchIndexes: null,
  });
  assert.deepStrictEqual(
    indexes({ turns, collapsedTurns: NONE, collapsedCalls: new Set([id1]), matchIndexes: null }),
    [1, "asum1", 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    "第 0 轮的工具行被收走、摘要呈现行紧贴原助手行；别的轮次一点不动",
  );
  assert.ok(!rows.some((row) => row.cellIndex === 2), "被收走的那条工具行不在行表里");

  // ---- 摘要呈现行：位置 / 身份 / 输入 ----
  const at = rows.findIndex((row) => row.summary === "assistant");
  assert.ok(at > 0, "调用折叠要出一枚助手摘要行（官方 `collapsedSummaryKind:'assistant'`）");
  const assistantRow = rows[at - 1];
  const summaryRow = rows[at];
  assert.strictEqual(assistantRow?.record?.index, 1, "原助手行**保留**在摘要行前面（正文不丢）");
  assert.strictEqual(assistantRow?.summary, undefined, "原助手行还是 primary 记录行，不是摘要行");
  assert.strictEqual(summaryRow?.key, "summary-assistant:1", "摘要行用独立 key（布局行 role）");
  assert.strictEqual(summaryRow?.cellIndex, -1, "摘要行没有记录下标——不能与上一行同号");
  assert.strictEqual(summaryRow?.turn, 0, "摘要行记得自己属于哪一轮（窗口分段守恒要用）");
  assert.strictEqual(summaryRow?.turnStart, false, "摘要行不顶轮次标签");
  assert.strictEqual(summaryRow?.record, assistantRow?.record, "摘要行与原行是同一条记录对象（不复制、不造新记录）");
  assert.strictEqual(trajectoryCellRecordId(summaryRow?.record as TrajectoryCell), id1, "共享原记录的稳定身份（折叠键 / 选中）");
  assert.deepStrictEqual(
    (summaryRow?.collapsedCalls ?? []).map((entry) => entry.index),
    [2],
    "摘要的工具行清单 = 被收走的那一串（投影给、文本层消费，同一个 seam）",
  );
  // 模型记录数不变：投影只多出**布局行**，记录行是模型的子集、编号原样、无重复
  {
    const modelIndexes = turns.flatMap(trajectoryTurnCells).map((entry) => entry.index);
    const recordIndexes = rows.filter((row) => row.summary === undefined).map((row) => row.cellIndex);
    assert.deepStrictEqual(
      recordIndexes,
      modelIndexes.filter((index) => index !== 2),
      "记录行 = 模型里没被收走的那批、顺序原样、编号不改（cellCount 语义不变）",
    );
    assert.strictEqual(new Set(recordIndexes).size, recordIndexes.length, "没有重复的记录行——摘要行不是又一条记录");
    assert.strictEqual(rows.length, recordIndexes.length + 1, "总行数 = 记录行 + 唯一那条摘要布局行");
  }
  // 每段起点唯一：摘要行不抢轮次标签
  {
    const perSection = new Map<number, number>();
    for (const row of rows) if (row.turnStart) perSection.set(row.section, (perSection.get(row.section) ?? 0) + 1);
    assert.deepStrictEqual([...perSection.values()], [1, 1, 1], "每段恰好一枚轮次起点（摘要行不产生第二枚）");
  }

  // ---- 搜索优先：命中时不出现摘要行；清查询恢复同一套折叠 ----
  {
    const searched = trajectoryLedgerRows({ turns, collapsedTurns: NONE, collapsedCalls: new Set([id1]), matchIndexes: new Set([2]) });
    assert.deepStrictEqual(searched.map((row) => row.cellIndex), [2], "命中被收走的工具行时只出这一行");
    assert.ok(!searched.some((row) => row.summary === "assistant"), "搜索期不出摘要布局行（搜索优先于折叠）");
    const cleared = trajectoryLedgerRows({ turns, collapsedTurns: NONE, collapsedCalls: new Set([id1]), matchIndexes: null });
    assert.strictEqual(cleared[1]?.summary, "assistant", "清掉查询后摘要行原样回来");
  }

  // ---- 后面没有工具行时：既不收行也不出摘要（官方 `if (calls.length === 0) continue`） ----
  {
    const noRun: TrajectoryTurn[] = [
      { turn: 0, groups: [{ title: { kind: "message" }, cells: [cell(1, "message", 0), cell(2, "context", 0)] }] },
    ];
    const withoutRun = trajectoryLedgerRows({ turns: noRun, collapsedTurns: NONE, collapsedCalls: new Set([id1]), matchIndexes: null });
    assert.deepStrictEqual(withoutRun.map((row) => row.cellIndex), [1, 2], "后面没有工具行时两条记录照旧");
    assert.ok(!withoutRun.some((row) => row.summary === "assistant"), "没有可收的调用就不出摘要行");
  }

  // ---- 整轮收起时调用折叠不参与（官方先折轮再折调用，轮摘要行处断链） ----
  {
    const both = trajectoryLedgerRows({ turns, collapsedTurns: new Set([0]), collapsedCalls: new Set([id1]), matchIndexes: null });
    assert.ok(!both.some((row) => row.summary === "assistant"), "整轮收起时不出助手摘要行（只有轮摘要）");
  }

  // 往前找的判据：中间隔着一条非工具记录就断了（不会误收更前面的助手行的那串）
  const gap: TrajectoryTurn[] = [
    {
      turn: 0,
      groups: [
        {
          title: { kind: "step", step: 1 },
          cells: [
            cell(1, "message", 0),
            cell(2, "context", 0),
            cell(3, "tool", 0, { callId: "c" }),
          ],
        },
      ],
    },
  ];
  assert.deepStrictEqual(
    indexes({ turns: gap, collapsedTurns: NONE, collapsedCalls: new Set(["message\u0000seq\u00001"]), matchIndexes: null }),
    [1, 2, 3],
    "助手行与工具行之间隔着别的记录时，那条工具行不属于它（官方 assistantToolCalls 同款）",
  );
}

// ---------- 6. 可折叠集合（官方 collapsibleTurnIds / assistantToolCalls） ----------
{
  assert.deepStrictEqual(trajectoryCollapsibleTurns(turns), [0, 1, 2], "每轮三条内容行 → 都可折");
  assert.deepStrictEqual(
    trajectoryCollapsibleCalls(turns),
    ["message\u0000seq\u00001", "message\u0000seq\u00005", "message\u0000seq\u00009"],
    "「后跟工具行」的助手行才可折（官方 assistantToolCalls 非空）",
  );
  const onlyOne: TrajectoryTurn[] = [
    { turn: 0, groups: [{ title: { kind: "message" }, cells: [cell(1, "user", 0)] }] },
  ];
  assert.deepStrictEqual(trajectoryCollapsibleTurns(onlyOne), [], "只有一条内容行的轮次不可折");
  assert.deepStrictEqual(trajectoryCollapsibleCalls(onlyOne), [], "后面没有工具行就不可折");
}

// ---------- 7. 组件真的用这份投影（接线，不是行为判据） ----------
//
// 行为判据在模块这一层（上面六段）与主代理的真实 DOM 验收里；这里只防「算了但没接」，
// 以及防「时间线选了谁」那种旧的两趟循环又长回组件里。
{
  const view = readFileSync(join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"), "utf8");
  assert.ok(/trajectoryLedgerRows\(\{/.test(view), "账本行要由行投影给出，不许自带一份折叠循环");
  assert.ok(/trajectoryCollapsibleTurns\(turns\)/.test(view), "可折叠轮次要问行投影");
  assert.ok(/trajectoryCollapsibleCalls\(turns\)/.test(view), "可折叠助手行要问行投影");
  assert.ok(!/labelShown/.test(view), "旧的「全账本只出一个轮次标签」标志不许回来");
  // 助手摘要**呈现行**的契约（形态判据在行为测试与主代理 DOM 里，这里只防「算了但没接」
  // 与「接线时把布局行当成了又一条 primary 记录」）：
  assert.ok(
    /row\.summary === "assistant"[\s\S]{0,200}?renderAssistantSummary\(row\.record as TrajectoryCell, row\.collapsedCalls \?\? \[\], tt\)/.test(view),
    "助手摘要行要接上行投影给的记录与调用清单",
  );
  {
    const at = view.indexOf("function renderAssistantSummary(");
    const end = view.indexOf("\n  /**", at + 1);
    const body = at < 0 ? "" : view.slice(at, end < 0 ? at + 2000 : end);
    assert.ok(body.length > 0, "Trajectory.tsx 里找不到 renderAssistantSummary");
    assert.ok(/data-collapsed-summary="assistant"/.test(body), "摘要行要有独立的种别属性（主选择判据据此与 primary 记录行分开）");
    assert.ok(!/data-cell-index/.test(body), "摘要行**不许**带 `data-cell-index`——它会与共享的那条助手行同号（旧 F06 重复行 / querySelector 选错）");
    assert.ok(/aria-label=\{sentence\}/.test(body), "摘要行要有明确的整句 aria（官方 `request.collapsedSummary`）");
    assert.ok(/tabIndex=\{0\}/.test(body), "摘要行要键盘可达");
    assert.ok(/expandCall\(recordId\)/.test(body), "点 / 回车 = 展开这串调用（官方 `onToggleAssistant`，不是第二条选择入口）");
    assert.ok(/trajectoryCellRecordId\(cell\)/.test(body), "摘要行的折叠键取自共享的那条助手记录身份");
  }
}

console.log("trajectoryLedgerRows: 每段一个起点、搜索优先折叠、轮次/调用折叠逐条对齐官方 ✓");
console.log("\ntrajectoryLedgerRows: all assertions passed");
