/**
 * 样式不变量：这些约束靠肉眼很难在每次改动后复查，但破坏后果明显。
 *
 * 都在 `app.css` 上做文本断言。CSS 的**布局结果**没法在无头环境里测，
 * 但「某个关键声明还在不在」是稳定可查的——而这正是回归发生的地方。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");

/** 取出一个选择器的声明块（第一个匹配）。 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
  assert.ok(match, `app.css 里找不到选择器 ${selector}`);
  return match[1];
}

// ---------- 1. 弹层宽度必须视口感知，否则窄侧栏会被裁掉 ----------
//
// 实测：`min-width: 224px` 这种固定下限 + 触发按钮距左边缘约 66px，
// 在 app 宽度 < ~290px 时弹层右边缘会超出视口、被裁掉一截。
// 所以下限也必须用 `calc(100vw - ...)` 钳制。
{
  const body = rule(".popover");
  const minWidth = /min-width:\s*([^;]+);/.exec(body)?.[1]?.trim();
  assert.ok(minWidth, ".popover 必须有 min-width");

  // 只允许 min()/calc() 这类带视口的写法；纯像素下限会在窄侧栏溢出
  assert.ok(
    /min\(|calc\(|vw|%/.test(minWidth),
    `弹层的 min-width 必须视口感知（现在是 "${minWidth}"）——固定像素下限会在窄侧栏把弹层顶出视口`,
  );

  const maxWidth = /max-width:\s*([^;]+);/.exec(body)?.[1]?.trim();
  assert.ok(maxWidth && /vw|calc\(/.test(maxWidth), `.popover 的 max-width 也要视口感知（现在是 "${maxWidth}"）`);
}
console.log("styles: 弹层宽度视口感知 ✓");

// ---------- 2. 思考档位不能带会把一行撑破的固定最小宽度 ----------
//
// `min-width: 3.75em` 曾让 4 档（Off/Low/High/Max）折成 3+1 两行。
// 现在条目按内容分配宽度（flex: 1 1 auto + min-width: 0）。
{
  const body = rule(".segment-item");
  const minWidth = /min-width:\s*([^;]+);/.exec(body)?.[1]?.trim();
  assert.strictEqual(
    minWidth,
    "0",
    `.segment-item 的 min-width 应为 0（按内容分配），否则档位会提前折行；现在是 "${minWidth}"`,
  );
  assert.ok(/white-space:\s*nowrap/.test(body), ".segment-item 文字不应换行（宁可折行也不要挤成两个字一行）");
}
console.log("styles: 档位条目不撑破一行 ✓");

// ---------- 2b. 5 档及以上必须走 grid 定列，而不是 flex 自然换行 ----------
//
// 用户要求：4 档及以下一行；5/6 档分两行且均匀（5 → 3+2，6 → 3+3）。
// flex-wrap 做不到：每行各自分配剩余宽度，5 档时第二行两个会被拉得比第一行
// 三个宽（实测 103px vs 68px），列对不齐；即使用 flex 定基线也仍是各行独立分配。
// grid 固定列宽才能让上下两行列对齐。
{
  const body = rule(".segment.is-multi-row");
  assert.ok(
    /display:\s*grid/.test(body),
    `.segment.is-multi-row 必须用 grid 定列（现在是 "${body.trim()}"）——flex 换行会让两行列宽不一致`,
  );
  assert.ok(
    /grid-template-columns:\s*repeat\(var\(--segment-columns/.test(body),
    "列数必须来自 --segment-columns（由 segmentColumns() 传入），否则固定列数规则失效",
  );
  // 单行档位不能带 grid：2/3/4 档要平分整条、由内容决定宽度
  assert.ok(
    !/grid-template-columns/.test(rule(".segment")),
    ".segment 本身不该是 grid（≤4 档用 flex 平分）",
  );
}
console.log("styles: 5 档以上用 grid 定列 ✓");

// ---------- 3. 运行中节点的发光动画与思考节点共用同一组关键帧 ----------
//
// 两处若各写一套关键帧，呼吸节奏会不一致（一个蓝光、一个脉冲），
// 而这类视觉不一致极难在改动时被注意到。
{
  const dot = rule(".dot-running");
  const glow = rule(".icon-glow");
  assert.ok(/animation:\s*icon-glow/.test(dot), ".dot-running 应复用 icon-glow 关键帧");
  assert.ok(/animation:\s*icon-glow/.test(glow), ".icon-glow 应使用 icon-glow 关键帧");
  assert.ok(/@keyframes\s+icon-glow/.test(css), "icon-glow 关键帧必须存在");

  // 小圆点只有 7px，纯透明度变化太不显眼：必须有常驻光晕，且动画被抑制时它仍在
  assert.ok(
    /box-shadow:/.test(dot),
    ".dot-running 必须有常驻光晕——7px 的圆点只靠透明度呼吸，长任务里几乎看不出在跑",
  );
}
console.log("styles: 运行中圆点与思考节点共用发光 ✓");

// ---------- 3b. 两个活性指示器在「减少动画」下必须同等对待 ----------
//
// 真实 bug：@media (prefers-reduced-motion) 里只列了 .dot-running 而漏了 .icon-glow，
// 于是开启「减少动画」的系统上出现「思考鲸鱼在呼吸、执行圆点纹丝不动」——
// 用户合理地以为任务卡死了。这属于两者的**待遇不一致**，而不是抑制与不抑制的选择，
// 所以断言写成「要么都在名单里，要么都不在」，任一种都比现在这种好。
{
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(reduced, "应当存在 prefers-reduced-motion 媒体查询");

  const body = reduced[1];
  const hasDot = /\.dot-running/.test(body);
  const hasGlow = /\.icon-glow/.test(body);
  assert.strictEqual(
    hasDot,
    hasGlow,
    `\`.dot-running\` 与 \`.icon-glow\` 必须在减少动画时同等对待，` +
      `现在是 圆点${hasDot ? "被抑制" : "保留"}、鲸鱼${hasGlow ? "被抑制" : "保留"}：\n${body.trim()}`,
  );
}
console.log("styles: 减少动画下两个活性指示器待遇一致 ✓");

// ---------- 4. 思考结束后的鲸鱼必须是蓝色，不能灰 ----------
//
// 用户明确要求过两次「思考完毕的鲸鱼显示为蓝色而不是灰色」。
// 曾经把结束态写成 `<IconDsh />`（落在 .row-icon 的 muted 灰上）→ 需求反向实现了。
// 这里钉住两件事：存在一个不带动画的蓝色类，且它是思考行的结束态用色。
{
  const brand = rule(".icon-brand");
  assert.ok(
    /color:\s*var\(--info\)/.test(brand),
    ".icon-brand 必须是品牌蓝 var(--info)（思考结束后鲸鱼的颜色）",
  );
  assert.ok(
    !/animation:/.test(brand),
    ".icon-brand 不该带动画——思考已结束，持续呼吸会误示「仍在活动」",
  );

  // 组件里结束态必须用 .icon-brand，不能退回裸图标（裸图标 = .row-icon 的灰色）
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /streaming\s*\?\s*"icon-glow"\s*:\s*"icon-brand"/.test(rows),
    "ThinkingRow 的结束态必须用 .icon-brand；写成裸 <IconDsh /> 会变灰",
  );
}
console.log("styles: 思考结束后的鲸鱼仍为蓝色 ✓");

console.log("\nstyles: all assertions passed");
