/**
 * 账本**行投影**：把 `TrajectoryTurn[]` 折成「画哪几行」，一行都不画。
 *
 * 为什么单独一个模块：账本的三条规则——**轮次折叠**、**调用折叠**、**搜索优先**——
 * 从前跟绘制混在 `components/Trajectory.tsx` 的一个两趟循环里，谁都断言不了
 * （组件里没有可跨的缝，`scripts/` 也没有能 import 它的测试）。它们错起来的样子是
 * 「搜索查不到明明存在的行」「一轮只出一枚轮次标签」「折叠集合被搜索悄悄改掉」，
 * 全是用户能看见、却没有任何离线防线的东西。
 *
 * 这一层的规则**逐条照官方 `TrajectoryTable.tsx`**（rc2，tag `dsh-v0.2.0-rc.2`）：
 *
 * 1. **搜索优先于折叠**（官方 `records` 那段 `searchMatchIndexes !== null` 分支）：
 *    有查询时只按命中集合出行，**两个折叠集合一概不参与**——但也不去改动它们，
 *    所以清掉查询之后原来的折叠原样回来。
 * 2. **轮次折叠**（官方 `collapseTurnRecords`）：该轮的 `system` 行与 `requestOnly`
 *    请求锚点行照常显示；内容行只留**第一条**，紧跟其后补一枚摘要行（它代表
 *    `contentRecords.slice(1)`，与 `trajectoryTurnSummary()` 同一个切片口径）。
 *    内容行 ≤ 1 时整轮不收。
 * 3. **调用折叠**（官方 `collapseAssistantRecords`）：一条助手行被收起时，**紧跟
 *    它后面**那串工具 / 子工具行一起收走（走到下一条别的记录为止），随后追加一枚
 *    摘要**呈现行**（`summary: "assistant"`，共享原记录的 cell / recordId，但自己的
 *    `cellIndex` 是 `-1`——它是布局行，见 `assistantSummaryRow()`）。原助手行的正文
 *    不丢。
 * 4. **轮次标签落点**（官方 `flattenRecords` 的 `turnStart` / `filterRecords` 的
 *    重算）：**每一段**（= `turns` 里的一轮，含「轮次之间」那一段）各自挑第一条
 *    像样的记录顶标签——跳过 `requestOnly` 与 `system`，压缩行只在「轮次之间」
 *    那一段才算数。**每段至多一条**，不是全账本至多一条。
 *
 * 身份（React key、折叠集合键）用 `trajectoryCellRecordId()`：往前加载历史会让
 * 记录编号整体平移，用编号当键会把折叠串到别的行上。
 */
import { trajectoryTurnCells, type TrajectoryCell, type TrajectoryTurn } from "../shared/trajectory";
import { trajectoryTurnStartsLabel } from "./trajectoryDisplay";
import { trajectoryCellRecordId } from "./trajectoryVendor";

/** 行投影的输入（三个折叠/过滤输入都只读，投影不改它们）。 */
export interface TrajectoryLedgerRowsInput {
  /** 折叠层给的轮次列表。 */
  turns: readonly TrajectoryTurn[];
  /** 被收起（只留第一条内容行 + 摘要行）的轮号。 */
  collapsedTurns: ReadonlySet<number>;
  /** 被收起（连带后面的工具行）的助手行稳定身份。 */
  collapsedCalls: ReadonlySet<string>;
  /** 搜索命中的记录序号；`null` = 没有查询（不是「零命中」）。 */
  matchIndexes: ReadonlySet<number> | null;
}

/** 账本的一行。 */
export interface TrajectoryLedgerRow {
  /** React key / 折叠键：记录身份，摘要行是 `turn-<N>-summary` / `summary-assistant:<index>`。 */
  key: string;
  /** 记录序号；两种折叠摘要布局行都没有记录，是 `-1`。 */
  cellIndex: number;
  /** 所属轮号（`null` = 轮次之间）。 */
  turn: number | null;
  /** 在 `turns` 数组里的位次（取回 `TrajectoryTurn` 用，避免按轮号线性找）。 */
  section: number;
  /** 记录行要画的记录；摘要布局行也带着它共享的那条原记录（身份/选中/aria 都用它）。 */
  record?: TrajectoryCell;
  /** 这一行是否顶着所属段的轮次标签（官方 `turnStart`）；摘要布局行恒为假。 */
  turnStart: boolean;
  /**
   * 折叠摘要**布局行**的种类（官方 `collapsedSummaryKind`）。
   *
   * 它是一条呈现行、不是又一条 primary 记录：`cellIndex` 是 `-1`，DOM 上也不带
   * `data-cell-index`（否则与共享记录的那一行同号）。
   */
  summary?: "turn" | "assistant";
  /**
   * 「调用折叠」收走的那串工具 / 子工具行（`summary === "assistant"` 时才有）：
   * 摘要文本的输入（官方 `summarizeAssistantTools(calls)`，取词在
   * `trajectoryDisplay.trajectoryAssistantSummary()`）。
   */
  collapsedCalls?: readonly TrajectoryCell[];
}

/**
 * 算一次行投影。
 * @param input - 轮次、两个折叠集合与搜索命中集合。
 * @returns 按账本顺序排好的行；每段至多一行带 `turnStart`。
 */
export function trajectoryLedgerRows(input: TrajectoryLedgerRowsInput): TrajectoryLedgerRow[] {
  const { turns, collapsedTurns, collapsedCalls, matchIndexes } = input;
  const rows: TrajectoryLedgerRow[] = [];
  // 被「调用折叠」收走的工具行 + 每条被收起的助手行要出摘要的那串调用（官方
  // `collapseAssistantRecords`：一条助手行收起时，**紧跟它后面**那串工具 / 子工具行
  // 一起收走，走到别的记录为止；随后追加一枚摘要呈现行）。作用于摊平后的列表
  // （官方就在摊平列表上走），所以按**记录序号**记下来，逐行判。
  const collapsed = collapsedCallsOf(turns, collapsedCalls);
  for (let section = 0; section < turns.length; section += 1) {
    const turn = turns[section];
    if (turn === undefined) continue;
    const cells = trajectoryTurnCells(turn);
    if (matchIndexes !== null) {
      // 搜索优先：折叠一概不参与（连摘要呈现行也不出）。官方 `filterRecords` 连
      // `requestOnly` 锚点行也一起滤掉（它没有可搜的内容，留着只会在命中行之间插空白）。
      for (const cell of cells) {
        if (cell.requestOnly === true || !matchIndexes.has(cell.index)) continue;
        rows.push(recordRow(cell, turn.turn, section));
      }
      continue;
    }
    const turnCollapsed = turn.turn !== null && collapsedTurns.has(turn.turn);
    const content = cells.filter((cell) => cell.requestOnly !== true && cell.kind !== "system");
    // 摘要行插在「第一条内容行」**之后**（官方那对 `[contentRecords[0], summary]`）。
    const summaryAfter = turnCollapsed && content.length > 1 && content[0] !== undefined
      ? cells.indexOf(content[0])
      : -1;
    for (let position = 0; position < cells.length; position += 1) {
      const cell = cells[position];
      if (cell === undefined) continue;
      if (summaryAfter >= 0) {
        // 整轮收起：只留 system / 请求锚点 / 那一条内容行（摘要行在它后面单独补）。
        // 这一支下「调用折叠」不参与：官方是先折轮、再在折过的列表上折调用，而轮摘要行
        // 让 `collapseAssistantRecords` 的收集循环当场断链（`candidate.collapsedSummary
        // !== undefined` ⇒ `calls.length === 0` ⇒ 不追加摘要行）。
        if (cell.requestOnly !== true && cell.kind !== "system" && position !== summaryAfter) continue;
        rows.push(recordRow(cell, turn.turn, section));
        if (position === summaryAfter && turn.turn !== null) {
          rows.push(summaryRow(turn.turn, section));
        }
        continue;
      }
      if (collapsed.hidden.has(cell.index)) continue;
      const calls = collapsed.calls.get(trajectoryCellRecordId(cell));
      rows.push(recordRow(cell, turn.turn, section));
      if (calls !== undefined) {
        // 原助手行**保留**（正文不丢），紧跟其后补一枚摘要呈现行——官方
        // `out.push(record)` 之后那一枚 `{...record, collapsedSummary, collapsedSummaryKind:'assistant'}`。
        rows.push(assistantSummaryRow(cell, calls, turn.turn, section));
      }
    }
    // 内容行 ≤ 1 的轮次**不出摘要行**（官方 `contentRecords.length <= 1` 直接原样返回）：
    // 那些行本来就一条没少，再补一枚「0 步 · 0 个工具调用」只是噪音。
  }
  markTurnStarts(rows);
  return rows;
}

/**
 * 可折叠的轮次（官方 `collapsibleTurnIds`：该轮非 `requestOnly` / 非 `system` 的记录多于一条）。
 * @param turns - 折叠层给的轮次列表。
 * @returns 可折叠的轮号，按账本顺序。
 */
export function trajectoryCollapsibleTurns(turns: readonly TrajectoryTurn[]): number[] {
  const ids: number[] = [];
  for (const turn of turns) {
    if (turn.turn === null) continue;
    const content = trajectoryTurnCells(turn).filter(
      (cell) => cell.requestOnly !== true && cell.kind !== "system",
    );
    if (content.length > 1) ids.push(turn.turn);
  }
  return ids;
}

/**
 * 可折叠的助手行（官方 `assistantToolCalls(allRecords, index).length > 0`：紧跟其后的
 * 工具 / 子工具行非空）。
 * @param turns - 折叠层给的轮次列表。
 * @returns 可折叠的助手行稳定身份，按账本顺序。
 */
export function trajectoryCollapsibleCalls(turns: readonly TrajectoryTurn[]): string[] {
  const ids: string[] = [];
  const flat = turns.flatMap(trajectoryTurnCells);
  for (let position = 0; position < flat.length - 1; position += 1) {
    const cell = flat[position];
    const next = flat[position + 1];
    if (cell === undefined || next === undefined) continue;
    if (cell.kind === "message" && (next.kind === "tool" || next.kind === "subtool")) {
      ids.push(trajectoryCellRecordId(cell));
    }
  }
  return ids;
}

/** 一条记录行。 */
function recordRow(cell: TrajectoryCell, turn: number | null, section: number): TrajectoryLedgerRow {
  return {
    key: trajectoryCellRecordId(cell),
    cellIndex: cell.index,
    turn,
    section,
    record: cell,
    turnStart: false,
  };
}

/** 一轮的折叠摘要行（没有记录下标）。 */
function summaryRow(turn: number, section: number): TrajectoryLedgerRow {
  return {
    key: `turn-${turn}-summary`,
    cellIndex: -1,
    turn,
    section,
    turnStart: false,
    summary: "turn",
  };
}

/**
 * 「调用折叠」的**摘要呈现行**（官方 `collapseAssistantRecords` 追加的那一枚
 * `{...record, collapsedSummary, collapsedSummaryKind:'assistant'}`）。
 *
 * 它是布局行而不是又一条 primary 记录：`key` 独立、`cellIndex` 是 `-1`、DOM 上不写
 * `data-cell-index`（否则与它共享的那条助手行同号，会撞坏虚拟窗口的「严格递增」不变量
 * 与按 index 的定位）。但 `record` 仍是**原助手记录本身**——选中、请求跳转、折叠键、
 * 无障碍名都靠它指回同一条记录，所以它既不是复制品也不是新记录。
 */
function assistantSummaryRow(
  cell: TrajectoryCell,
  calls: readonly TrajectoryCell[],
  turn: number | null,
  section: number,
): TrajectoryLedgerRow {
  return {
    key: `summary-assistant:${cell.index}`,
    cellIndex: -1,
    turn,
    section,
    record: cell,
    turnStart: false,
    summary: "assistant",
    collapsedCalls: calls,
  };
}

/**
 * 每段一条轮次标签（官方 `filterRecords` 重算 `turnStart` 的那一段循环）。
 * 摘要行不顶标签——两种摘要行都不算「像样的记录」：轮摘要行没有记录，助手摘要行
 * 共享的那条记录已经排在自己前面（且它自己的起点在更早的行上）。
 */
function markTurnStarts(rows: readonly TrajectoryLedgerRow[]): void {
  const started = new Set<number>();
  for (const row of rows) {
    if (row.record === undefined || row.summary !== undefined) continue;
    row.turnStart = !started.has(row.section) && trajectoryTurnStartsLabel(row.record, row.turn);
    if (row.turnStart) started.add(row.section);
  }
}

/**
 * 被「调用折叠」收走的工具行，以及每条被收起的助手行要出摘要的那串调用
 * （官方 `collapseAssistantRecords`）：一条助手行被收起时，**紧跟它后面**那串
 * 工具 / 子工具行一起收走，走到别的记录为止；后面一条调用都没有时既不收也不出摘要
 * （官方 `if (calls.length === 0) continue`）。
 *
 * 判据是**摊平后**的列表（官方就在摊平列表上走），只收 `tool` / `subtool`——助手行
 * 与上下文行一条都不收。从前这条规则写成「往前找到最近的助手行、由它决定」，于是
 * 工具行**后面**的那条助手行也会被一起收掉（同一条链上隔着一行工具就继续往前找了）。
 *
 * @param turns - 折叠层给的轮次列表。
 * @param collapsedCalls - 被收起的助手行稳定身份。
 * @returns 要略过的记录序号集合，以及 身份 → 那串调用 的映射。
 */
function collapsedCallsOf(
  turns: readonly TrajectoryTurn[],
  collapsedCalls: ReadonlySet<string>,
): { hidden: Set<number>; calls: Map<string, TrajectoryCell[]> } {
  const hidden = new Set<number>();
  const calls = new Map<string, TrajectoryCell[]>();
  if (collapsedCalls.size === 0) return { hidden, calls };
  const flat = turns.flatMap(trajectoryTurnCells);
  for (let position = 0; position < flat.length; position += 1) {
    const cell = flat[position];
    if (cell === undefined || cell.kind !== "message") continue;
    const id = trajectoryCellRecordId(cell);
    if (!collapsedCalls.has(id)) continue;
    const run: TrajectoryCell[] = [];
    for (let next = position + 1; next < flat.length; next += 1) {
      const candidate = flat[next];
      if (candidate === undefined || (candidate.kind !== "tool" && candidate.kind !== "subtool")) break;
      run.push(candidate);
      hidden.add(candidate.index);
    }
    if (run.length > 0) calls.set(id, run);
  }
  return { hidden, calls };
}
