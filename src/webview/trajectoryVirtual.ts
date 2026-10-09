/**
 * 账本**虚拟化**的纯决策：一行都不画，只算「哪一段下标该画」。
 *
 * 为什么单独一个模块：这段算术是本扩展唯一一处「界面自己算几何」的地方——行的
 * 高度是内容决定的，垫行高度按估计值算，跳转目标还要强行留在窗口里。它错起来的样子
 * 很安静（边缘缺几行、跳过去是空白、滚动条长度不对），而组件里根本断言不了；
 * 抽出来之后 `scripts/trajectoryVirtual.test.ts` 能把每种窗口形态都钉住。
 *
 * 三个数**逐字取自官方** `TrajectoryTable.tsx` 顶部那三个常量：阈值 100、
 * overscan 12、行高估不出来时按 30。它们决定的是「什么时候开始窗口化」与
 * 「窗口留多宽」，属于用户能感觉到的行为（快速滚动时边上会不会闪白），
 * 所以不做「更适合本扩展」的微调。
 */

/** 账本行数超过这个值才启用窗口化（官方 `VIRTUALIZATION_THRESHOLD`）。 */
export const VIRTUALIZATION_THRESHOLD = 100;

/** 视口之外上下各多渲染几行（官方 `VIRTUAL_OVERSCAN_ROWS`）。 */
export const VIRTUAL_OVERSCAN_ROWS = 12;

/** 行高估计值的初值，**设计像素**（官方 `estimateVirtualRowSize` 的兜底 30）。 */
export const VIRTUAL_ROW_HEIGHT = 30;

/** 一次窗口计算要的输入。 */
export interface TrajectoryWindowInput {
  /** 账本一共多少行（折叠 / 过滤之后）。 */
  rowCount: number;
  /** 上面还有更早的历史（官方把这一条也并进「要不要窗口化」的判据）。 */
  hasOlder: boolean;
  /** 滚动容器的 `scrollTop`。 */
  scrollTop: number;
  /** 滚动容器的可视高度；`0` = 还没量到（首帧）。 */
  viewportHeight: number;
  /** 一行按多少像素算（估计值 × 界面倍率）。 */
  rowHeight: number;
  /**
   * 必须留在窗口里的**行位置**（跳转 / 选中目标）——它们在视口外也要渲染。
   *
   * `trajectoryRowWindow()` **不消费**它（强留的行不进 `indexes`，垫行高度也就不会
   * 被算重）；`trajectoryWindowPlan()` 消费它，把强留行按位次夹进分段垫行里。
   */
  pinned?: readonly number[];
}

/** 算出来的窗口。 */
export interface TrajectoryWindow {
  /** 要不要走窗口化（不需要时调用方直接画全部行）。 */
  virtualized: boolean;
  /** 要画的下标，升序（不含 `pinned` 里那些被强留的行）。 */
  indexes: number[];
  /** 上面被切掉几行 / 下面被切掉几行（调用方据此给垫行高度）。 */
  before: number;
  after: number;
}

/**
 * 算一次窗口。
 *
 * 首帧（`viewportHeight <= 0`）刻意**先给一小段**（overscan × 2 行）而不是全画：
 * `ResizeObserver` 报高度之前若按「视口高 0」算，会得到「一行都不画」的白屏；
 * 按全画又等于首帧就把几百行铺出去，正好是这一层要避免的事。
 *
 * @param input - 行数、滚动位置、视口高、行高与要强留的下标。
 * @returns 该画哪一段，以及上下各切掉多少行。
 */
export function trajectoryRowWindow(input: TrajectoryWindowInput): TrajectoryWindow {
  const { rowCount, hasOlder, scrollTop, viewportHeight, rowHeight } = input;
  const virtualized = hasOlder || rowCount > VIRTUALIZATION_THRESHOLD;
  if (!virtualized || rowCount === 0) {
    return { virtualized: false, indexes: range(0, rowCount), before: 0, after: 0 };
  }
  // 行高算不出来时按 1 兜底：`rowHeight <= 0` 会让下面两处除法得到 Infinity / NaN
  const height = rowHeight > 0 ? rowHeight : 1;
  const first = viewportHeight <= 0
    ? 0
    : Math.floor(scrollTop / height) - VIRTUAL_OVERSCAN_ROWS;
  const start = clamp(first, 0, Math.max(0, rowCount - 1));
  const last = viewportHeight <= 0
    ? VIRTUAL_OVERSCAN_ROWS * 2
    : Math.ceil((scrollTop + viewportHeight) / height) + VIRTUAL_OVERSCAN_ROWS;
  /**
   * `end` 必须**先夹下界再夹上界**，而且下界要取 `start`。
   *
   * 只夹上界是不够的：视口比整份账本还高时（`last` 超过总行数，而 `start` 又靠后——
   * 滚到中段的那一刻视口变高了就会这样），`end` 会小于 `start`，于是
   * `after = rowCount - end` 变成**负数**，调用方拿算出来的可见区间去切数组就会切到
   * 空、垫行高度也跟着错。这正是「账本少画了十来行」的成因。
   */
  const end = Math.max(start, clamp(last, 0, rowCount));
  const indexes = range(start, end);
  // 强留的行**不重复进 `indexes`**：它们由调用方另外补，垫行高度按切掉的行数算，
  // 所以这里只报「窗口本身切了多少」——重复画一行会让总高度对不上。
  return { virtualized: true, indexes, before: start, after: rowCount - end };
}

/**
 * 窗口化的**绘制计划**：一条行，或者一段高度占位（垫行）。
 *
 * 为什么要「分段垫行」而不是「窗口 + 末尾补几行」：窗口外的强留行（跳转落点、当前
 * 选中）必须**按真实位次**夹在垫行之间，行序才与记录序一致。从前是把它们
 * `push` 到绘制列表末尾、垫行仍按整个窗口全额算——于是 DOM 里出现
 * `[…, 108, 10]` 这样的逆序，总行数还比真实多一行（实测：窗口 57..108 + 强留 10
 * 拼出 53 行，而 `scrollHeight / rowHeight` 与账本行数不等）。
 */
export type TrajectoryWindowItem =
  | { kind: "row"; index: number }
  | { kind: "pad"; rows: number };

/** 绘制计划：items 里的行按下标升序、互不重复，垫行补满其余位置。 */
export interface TrajectoryWindowPlan {
  /** 要不要走窗口化（`false` 时 `items` 就是整份账本、没有任何垫行）。 */
  virtualized: boolean;
  items: TrajectoryWindowItem[];
}

/**
 * 算一次绘制计划：窗口那一段 + 必须强留的行，**按位次分段**、垫行补齐空隙。
 *
 * 恒等式（断言在 `scripts/trajectoryVirtual.test.ts`）：
 * `Σ pad.rows + 行数 = rowCount`，且行下标严格递增、无重复——所以
 * `scrollHeight` 与账本行数恒等、`data-cell-index` 的 DOM 顺序与记录序一致。
 *
 * @param input - 行数、滚动位置、视口高、行高与要强留的**行位置**。
 * @returns 绘制计划（`virtualized` 为假时是整份账本）。
 */
export function trajectoryWindowPlan(input: TrajectoryWindowInput): TrajectoryWindowPlan {
  const { rowCount } = input;
  const window = trajectoryRowWindow(input);
  if (!window.virtualized) {
    return { virtualized: false, items: range(0, rowCount).map((index) => ({ kind: "row", index })) };
  }
  // 窗口那一段 + 强留的行位置：并集之后按位次升序排（同一行被要求两次只算一次）
  const positions = new Set(window.indexes);
  for (const position of input.pinned ?? []) {
    if (position >= 0 && position < rowCount) positions.add(position);
  }
  const items: TrajectoryWindowItem[] = [];
  let cursor = 0;
  for (const position of [...positions].sort((left, right) => left - right)) {
    if (position > cursor) items.push({ kind: "pad", rows: position - cursor });
    items.push({ kind: "row", index: position });
    cursor = position + 1;
  }
  if (cursor < rowCount) items.push({ kind: "pad", rows: rowCount - cursor });
  return { virtualized: true, items };
}

/** `[from, to)` 的下标数组。 */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let index = from; index < to; index += 1) out.push(index);
  return out;
}

/**
 * **记录下标 → 行位置**：要强留的那几条记录，在行列表里各自排在第几行。
 *
 * 为什么需要转这一道：调用方手上那两个目标（跳转落点、当前选中）都是**记录下标**
 * （`cell.index`，1 起、来自账本记录），而行列表里还可能混着**折叠摘要行**
 * （它们没有记录下标），两者并不相等。拿记录下标当数组位置用，后果是**补错一行**：
 * 实测「选中第 51 条」却把第 52 条画了两遍、真正该显示的那一行反而消失，
 * 而界面上一片安静（没有报错，只是少了一行、多了一行）。
 *
 * 同一行被重复要求（跳转落点与选中常常是同一条）算一次：补两遍会把总高度算重，
 * React 更会因为 key 撞车把**另一行**丢掉。
 *
 * @param rows - 行列表，每项给出它对应的记录下标（折叠摘要行是 `-1`）。
 * @param cellIndexes - 要强留的记录下标（可以重复）。
 * @returns 去重后的行位置，升序；记录不在列表里时该条被略过。
 */
export function trajectoryRowPositions(
  rows: readonly { cellIndex: number }[],
  cellIndexes: readonly number[],
): number[] {
  if (cellIndexes.length === 0) return [];
  const wanted = new Set(cellIndexes);
  const positions: number[] = [];
  rows.forEach((row, position) => {
    if (row.cellIndex >= 0 && wanted.has(row.cellIndex)) positions.push(position);
  });
  return positions;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
