/**
 * 账本虚拟化的离线断言（`src/webview/trajectoryVirtual.ts`）。
 *
 * 这一段算术错起来很安静：边缘缺几行、跳过去是空白、滚动条长度不对——组件里断言不了，
 * 所以把每种窗口形态都在这里钉一遍。三个数（阈值 100 / overscan 12 / 行高 30）是
 * 官方 `TrajectoryTable.tsx` 顶部的同一组常量，改它们就是改用户能感觉到的行为。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  trajectoryRowPositions,
  trajectoryRowWindow,
  trajectoryWindowPlan,
  VIRTUALIZATION_THRESHOLD,
  VIRTUAL_OVERSCAN_ROWS,
  VIRTUAL_ROW_HEIGHT,
} from "../src/webview/trajectoryVirtual";

const base = { rowCount: 10, hasOlder: false, scrollTop: 0, viewportHeight: 600, rowHeight: 30 };

// ---------- 1. 什么时候不窗口化 ----------
{
  const small = trajectoryRowWindow({ ...base, rowCount: VIRTUALIZATION_THRESHOLD });
  assert.strictEqual(small.virtualized, false, "正好 100 行还不窗口化（官方是 `>` 不是 `>=`）");
  assert.deepStrictEqual(small.indexes, [...Array(VIRTUALIZATION_THRESHOLD).keys()], "不窗口化时全画");
  assert.strictEqual(small.before, 0);
  assert.strictEqual(small.after, 0);

  const over = trajectoryRowWindow({ ...base, rowCount: VIRTUALIZATION_THRESHOLD + 1 });
  assert.strictEqual(over.virtualized, true, "101 行开始窗口化");
  assert.ok(over.indexes.length < VIRTUALIZATION_THRESHOLD + 1, "窗口化就该少画几行");

  const empty = trajectoryRowWindow({ ...base, rowCount: 0 });
  assert.strictEqual(empty.virtualized, false, "空账本不窗口化（也不该出垫行）");
  assert.deepStrictEqual(empty.indexes, []);

  const older = trajectoryRowWindow({ ...base, rowCount: 5, hasOlder: true });
  assert.strictEqual(older.virtualized, true, "上面还有更早的历史时，行少也走窗口（官方同款）");
}

// ---------- 2. 窗口跟着滚动位置走，上下各留 overscan ----------
{
  const rowHeight = 30;
  const viewportHeight = 600;
  const first = trajectoryRowWindow({ ...base, rowCount: 1000, rowHeight, viewportHeight });
  assert.strictEqual(first.before, 0, "在顶部时上面没得切");
  // 视口 600 / 行高 30 = 20 行，再加 overscan
  assert.strictEqual(first.indexes[0], 0);
  assert.strictEqual(
    first.indexes.at(-1),
    19 + VIRTUAL_OVERSCAN_ROWS,
    "视口最后一行 + overscan",
  );

  const middle = trajectoryRowWindow({ ...base, rowCount: 1000, rowHeight, viewportHeight, scrollTop: 3000 });
  assert.strictEqual(middle.before, 100 - VIRTUAL_OVERSCAN_ROWS, "视口首行再往上 overscan 行");
  assert.strictEqual(middle.indexes[0], middle.before);
  assert.strictEqual(middle.after, 1000 - middle.indexes.at(-1)!.valueOf() - 1, "下面的垫行数 = 总行数 - 末行 - 1");
  assert.ok(middle.indexes.length <= 20 + VIRTUAL_OVERSCAN_ROWS * 2 + 1, "窗口宽度是视口行数 + 两倍 overscan 上下界");

  const bottom = trajectoryRowWindow({ ...base, rowCount: 1000, rowHeight, viewportHeight, scrollTop: 30 * 1000 });
  assert.strictEqual(bottom.after, 0, "滚过头时下面没得切");
  assert.strictEqual(bottom.indexes.at(-1), 999, "末行一定在窗口里");
  assert.ok(bottom.before <= 1000, "垫行数不会是负数");
}

// ---------- 3. 首帧（还没量到视口高）与坏输入 ----------
{
  const cold = trajectoryRowWindow({ ...base, rowCount: 1000, viewportHeight: 0 });
  assert.strictEqual(cold.before, 0);
  assert.strictEqual(cold.indexes.length, VIRTUAL_OVERSCAN_ROWS * 2, "视口高还没有时报一小段，不白屏也不铺满");
  assert.strictEqual(cold.after, 1000 - VIRTUAL_OVERSCAN_ROWS * 2);

  // 行高 0 / 负 / NaN：不许算出 Infinity 或 NaN 的下标（那会让 `slice` 得到空数组 → 白屏）
  for (const rowHeight of [0, -5, Number.NaN]) {
    const window = trajectoryRowWindow({ ...base, rowCount: 500, rowHeight, scrollTop: 100 });
    assert.ok(window.indexes.length > 0, `行高 ${rowHeight} 时仍要有行可画`);
    assert.ok(
      window.indexes.every((index) => Number.isInteger(index) && index >= 0 && index < 500),
      `行高 ${rowHeight} 时下标必须都是合法的整数`,
    );
  }

  // 负数 scrollTop（某些浏览器在橡皮筋回弹时会报）与超过总高的 scrollTop
  const negative = trajectoryRowWindow({ ...base, rowCount: 500, scrollTop: -200 });
  assert.strictEqual(negative.before, 0, "负的滚动位置按顶部算");
  const overscroll = trajectoryRowWindow({ ...base, rowCount: 500, scrollTop: 10 ** 9 });
  assert.strictEqual(overscroll.after, 0);
  assert.ok(overscroll.indexes.at(-1)! < 500, "滚过头也不许越界");
}

// ---------- 4. 垫行高度与窗口对得上（总高度不丢不重） ----------
{
  const rowHeight = 27;
  for (const scrollTop of [0, 123, 4567, 99999]) {
    const window = trajectoryRowWindow({ ...base, rowCount: 400, rowHeight, scrollTop });
    const kept = window.indexes.length;
    assert.strictEqual(
      window.before + kept + window.after,
      400,
      `切掉的 + 画出来的必须正好是总行数（scrollTop=${scrollTop}）`,
    );
  }
}

// ---------- 4b. 视口比整份账本还高（负垫行的现场，2026-10-05 实测踩到） ----------
//
// 现象：账本里滚到中段后**少画了十来行**，而且被强留的那一行画了两遍。
// 成因：`end` 只夹了上界没夹下界——`last` 超过总行数时 `end < start`，
// `after = rowCount - end` 成了负数，调用方切出来的可见区间是空的。
// 这一段把这个形状钉死。
{
  const rowHeight = 30;
  const viewportHeight = 900; // 比 240 × 30 = 7200 小，但足够让 start 靠后时越过总数
  for (const scrollTop of [0, 5000, 6000, 7100, 7200]) {
    const window = trajectoryRowWindow({ ...base, rowCount: 240, rowHeight, viewportHeight, scrollTop });
    assert.ok(
      window.after >= 0,
      `下面的垫行数不许是负数（scrollTop=${scrollTop} 时 after=${window.after}）`,
    );
    assert.ok(
      window.before + window.indexes.length + window.after === 240,
      `切掉的 + 画出来的要正好是 240 行（scrollTop=${scrollTop}）`,
    );
    assert.ok(window.indexes.length > 0, `任何时候都要有行可画（scrollTop=${scrollTop}）`);
    assert.strictEqual(window.indexes.at(-1), 240 - window.after - 1, "末行的下标与 after 自洽");
  }

  // 极端：视口高到一次能装下整份账本，且已经滚到中段——末行仍必须进窗口
  const huge = trajectoryRowWindow({ ...base, rowCount: 120, rowHeight: 30, viewportHeight: 100000, scrollTop: 3000 });
  assert.strictEqual(huge.before, 88, "起点仍按滚动位置算");
  assert.strictEqual(huge.after, 0, "整份都装得下时下面没有垫行");
  assert.strictEqual(huge.indexes.at(-1), 119, "末行要在窗口里（这正是从前被丢掉的那一段）");
}

// ---------- 5. 强留的行：记录下标 → 行位置（2026-10-05 实测踩到的补错一行） ----------
//
// 现象：从会话点「查看」跳过来，账本把**目标行之后那一行**画了两遍，目标行自己消失。
// 成因：跳转落点与选中都是**记录下标**（`cell.index`，1 起），而行列表里混着没有记录
// 下标的折叠摘要行（`-1`），两者并不相等——拿记录下标当数组位置用就整体错位。
// 这一段把换算钉死，并覆盖「同一行被要求两次」（跳转落点与选中常常是同一条）。
{
  const rows = [
    { cellIndex: 1 },
    { cellIndex: 2 },
    { cellIndex: -1 }, // 折叠摘要行：没有记录下标
    { cellIndex: 3 },
    { cellIndex: 4 },
    { cellIndex: 5 },
  ];

  assert.deepStrictEqual(trajectoryRowPositions(rows, [3]), [3], "记录下标 3 在第 3 个位置（1 基与 0 基不同）");
  assert.deepStrictEqual(
    trajectoryRowPositions(rows, [5]),
    [5],
    "摘要在中间时后面整体后移——这正是错位的来源（下标 5 落在位置 5，不是 4）",
  );
  assert.deepStrictEqual(
    trajectoryRowPositions(rows, [3, 3]),
    [3],
    "同一条被要求两次只算一次（补两遍会让 React 的 key 撞车，丢掉另一行）",
  );
  assert.deepStrictEqual(
    trajectoryRowPositions(rows, [5, 2]),
    [1, 5],
    "多条时按**行的顺序**给出（与哪个先要求无关）",
  );
  assert.deepStrictEqual(trajectoryRowPositions(rows, [99]), [], "记录不在列表里就略过，不兜底到别的行");
  assert.deepStrictEqual(trajectoryRowPositions(rows, []), [], "没有要求就没有位置");
  assert.deepStrictEqual(
    trajectoryRowPositions([{ cellIndex: -1 }, { cellIndex: -1 }], [1]),
    [],
    "全是摘要行时找不到任何目标（摘要行不参与）",
  );
}

// ---------- 6. 绘制计划：窗口 + 强留行按位次夹在**分段垫行**之间 ----------
//
// 现象（主代理真实 DOM 验收，F06-pinned-order）：普通选中一条记录再手滚一屏，
// 账本里画出来的记录下标是 `[57..108, 10]`——逆序、而且总行数比账本多一行
// （窗口 57..108 是 52 行 + 强留 10 = 53，而 `scrollHeight / rowHeight` 与账本不等）。
// 成因：强留行被 `push` 到绘制列表末尾，垫行仍按整个窗口全额算。
// 现在改成「按位次排好、空隙各垫一行」，下面把每种形状都钉住。
{
  const rowHeight = 30;
  const viewportHeight = 400;
  const input = { rowCount: 200, hasOlder: false, scrollTop: 6000, viewportHeight, rowHeight };
  const window = trajectoryRowWindow(input);
  assert.deepStrictEqual(
    [window.before, window.indexes[0], window.indexes.at(-1), window.after],
    [188, 188, 199, 0],
    "先确认现场：滚到底部的窗口就是最后 12 行",
  );
  const plan = trajectoryWindowPlan({ ...input, pinned: [10] });
  assert.strictEqual(plan.virtualized, true);
  const drawn = plan.items.flatMap((item) => (item.kind === "row" ? [item.index] : []));
  const padded = plan.items.flatMap((item) => (item.kind === "pad" ? [item.rows] : []));
  assert.deepStrictEqual(
    drawn,
    [10, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199],
    "强留的第 10 行按**真实位次**排在最前，窗口那段紧随其后（不是拼在末尾）",
  );
  assert.deepStrictEqual(padded, [10, 177], "第 10 行之前一段、第 10 行与窗口之间那段 177 行各垫一行");
  assert.ok(
    drawn.every((index, i) => i === 0 || drawn[i - 1]! < index),
    "DOM 里的记录下标必须严格递增（真机红的就是这一条）",
  );
  assert.strictEqual(
    padded.reduce((sum, rows) => sum + rows, 0) + drawn.length,
    200,
    "垫行 + 行 = 账本行数（总高度不多不少）",
  );

  // 多个强留行、且分布在不同段：每段各一段垫行（`{before, after}` 两个数表达不了它）
  const multi = trajectoryWindowPlan({
    ...input,
    rowCount: 200,
    scrollTop: 6000,
    pinned: [3, 100, 199],
  });
  const multiDrawn = multi.items.flatMap((item) => (item.kind === "row" ? [item.index] : []));
  const multiPads = multi.items.flatMap((item) => (item.kind === "pad" ? [item.rows] : []));
  assert.deepStrictEqual(
    multiDrawn,
    [3, 100, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199],
    "三段强留行都按位次排好，199 与窗口里的自己只出现一次",
  );
  assert.deepStrictEqual(multiPads, [3, 96, 87], "位次 3 之前、3 与 100 之间、100 与 188 之间各垫一段");
  assert.strictEqual(
    multiPads.reduce((sum, rows) => sum + rows, 0) + multiDrawn.length,
    200,
    "多段垫行同样守恒",
  );

  // 不窗口化时没有垫行（整份账本按原序）
  const small = trajectoryWindowPlan({ rowCount: 5, hasOlder: false, scrollTop: 0, viewportHeight, rowHeight, pinned: [2] });
  assert.strictEqual(small.virtualized, false);
  assert.deepStrictEqual(
    small.items.map((item) => (item.kind === "row" ? item.index : `pad${item.rows}`)),
    [0, 1, 2, 3, 4],
    "不窗口化时整份都画、一个垫行都没有（强留也只是其中普通一行）",
  );

  // 强留的行位置越界 / 重复：不许画出重复行，也不许越界
  const edge = trajectoryWindowPlan({ ...input, rowCount: 20, scrollTop: 0, viewportHeight: 100, pinned: [-1, 25, 4, 4] });
  const edgeDrawn = edge.items.flatMap((item) => (item.kind === "row" ? [item.index] : []));
  assert.deepStrictEqual(edgeDrawn, [...Array(20).keys()], "越界与重复的强留都不额外画行");
}

// ---------- 7. 组件那边真的用了这份算术（读源码，防「算了但没接」） ----------
//
// 行为判据在模块这一层（窗口算术、垫行守恒、绘制计划）与主代理的真实 DOM 验收里；
// 这里只防「算了但没接」，以及防旧的「窗口 + 末尾补强留行」写法长回来。
{
  const view = readFileSync(join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"), "utf8");
  assert.ok(/trajectoryWindowPlan\(\{/.test(view), "组件要按绘制计划画，不许自带一份窗口实现");
  assert.ok(/trajectoryRowPositions\(allRows, pinnedIndexes\)/.test(view), "强留行先按记录下标换算成行位置");
  assert.ok(
    /tr\.trajectory-row:not\(\.trajectory-virtual-pad\)/.test(view),
    "行高实测要跳过垫行（它们只是高度占位，量进去会把估计越拉越偏）",
  );
  assert.ok(/item\.rows \* rowHeightPx/.test(view), "每段垫行的高度按它那一段切掉的行数给");
  assert.ok(
    !/visibleRows/.test(view) && !/windowStart/.test(view),
    "旧的「窗口切片 + 末尾补强留行」写法不许回来（那正是逆序与多一行的成因）",
  );
}

console.log(`trajectoryVirtual: 窗口算术（阈值 ${VIRTUALIZATION_THRESHOLD} / overscan ${VIRTUAL_OVERSCAN_ROWS} / 行高 ${VIRTUAL_ROW_HEIGHT}） ✓`);
console.log("trajectoryVirtual: 首帧、坏输入、分段垫行守恒与组件接线 ✓");

console.log("\ntrajectoryVirtual: all assertions passed");
