/**
 * 底部工具栏的按优先级分配：`src/webview/toolbarFit.ts` 的纯函数断言。
 *
 * 这套逻辑没有写死的像素阈值（宽度是界面实测出来的），所以「多宽该显示谁」
 * 在无头环境里没法靠渲染验证；能钉住、也正是最容易改错的是**分配规则**本身：
 * 谁先被挤掉、同槽位的两档会不会同时出现、pinned 是否真的保底。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BAR_ORDER, pickVariants, type ToolbarVariant } from "../src/webview/toolbarFit";

/** 一份贴近真实的宽度样本（px）：模型名较长、权限文字是中文口径。
 *
 * 权限与模型两个胶囊**不带下箭头**（用户 2026-09-22 精简 UI），所以它们的宽度是
 * 「图标/文字 + 内边距」，比带箭头时各少 12px（箭头 8px + 间距 4px）——
 * 样本跟着改，阶梯的临界值也随之前移（这不是写死的常量，只是这份样本的算术结果）。 */
const WIDTHS: Record<string, number> = {
  "permission:icon": 22,
  "model:full": 120,
  "send:full": 52,
  "effort:full": 26,
  "attach:full": 22,
  "tps:full": 44,
  "context:ring": 16,
  "permission:label": 80,
  // 预设标签是纯文字（无图标无内边距），量的是名字本身：72px 大致是 11px 字号下的
  // 英文 "Standard mode"，中文「标准模式」只有 44px——档位的宽度随语言变，
  // 这也是它必须实测、不能写死阈值的原因。
  "preset:full": 72,
  "context:text": 62,
};

const VARIANTS: ToolbarVariant[] = BAR_ORDER.map((spec) => ({
  ...spec,
  width: WIDTHS[`${spec.slot}:${spec.level}`] ?? 0,
}));

/** 取一次分配结果，返回排好序的 `槽位:档位`，便于整体比对。 */
function say(available: number, gap = 8): string[] {
  return [...pickVariants(VARIANTS, available, gap).values()]
    .map((variant) => `${variant.slot}:${variant.level}`)
    .sort();
}

const ALL = [
  "attach:full",
  "context:text",
  "effort:full",
  "model:full",
  "permission:label",
  "preset:full",
  "send:full",
  "tps:full",
];

// ---------- 1. 优先级表就是用户口径 ----------
//
// P0 三项 pinned（始终显示）；P1（思考强度/附件/tps/上下文环）全部排在
// P2（权限文字、预设标签、上下文数值）之前；同槽位的档位 rank 必须递增，
// 否则「先图标、后图标+文字」这种升级在算法里永远升不上去。
//
// **同一档内部按元素在工具栏里的左右次序定优先级**（用户 2026-09-22 口径）：
// 越靠左越先保住。所以 P1/P2 各自的 rank 次序必须与下面记的左右次序一致，
// 而左右次序的**真正来源**是 Composer 的渲染次序——两条一起断言，
// 挪动元素位置却不改表就会被抓住。
{
  const byRank = [...BAR_ORDER].sort((a, b) => a.rank - b.rank);
  const pinned = byRank.filter((spec) => spec.pinned).map((spec) => spec.slot);
  assert.deepStrictEqual(
    pinned,
    ["permission", "model", "send"],
    "P0（始终显示的）必须是权限、模型、发送三个",
  );
  assert.ok(
    byRank.every((spec, index) => spec.rank === index),
    "rank 必须是从 0 开始的连续整数（优先级表的可读性靠它）",
  );

  const rankOf = (key: string) => BAR_ORDER.find((s) => `${s.slot}:${s.level}` === key)?.rank;
  const p1 = ["effort:full", "attach:full", "tps:full", "context:ring"].map(rankOf);
  const p2 = ["permission:label", "preset:full", "context:text"].map(rankOf);
  assert.ok(
    p1.every((rank) => rank !== undefined) && p2.every((rank) => rank !== undefined),
    "P1/P2 的档位都要在表里（含 agent 预设标签）",
  );
  for (const [tier, ranks] of [
    ["P1（思考强度 → 附件 → tps → 上下文环）", p1],
    ["P2（权限文字 → 预设标签 → 上下文数值）", p2],
  ] as [string, (number | undefined)[]][]) {
    assert.ok(
      ranks.every((rank, index) => index === 0 || (rank as number) > (ranks[index - 1] as number)),
      `${tier} 的 rank 必须按左右次序递增（同档内从左至右，用户 2026-09-22 口径）`,
    );
  }
  assert.ok(
    Math.max(...(p1 as number[])) < Math.min(...(p2 as number[])),
    "P1（思考强度/附件/tps/上下文环）必须整体优先于 P2（权限文字/预设/上下文数值）",
  );

  const perm = BAR_ORDER.filter((spec) => spec.slot === "permission").map((spec) => spec.level);
  const ctx = BAR_ORDER.filter((spec) => spec.slot === "context").map((spec) => spec.level);
  assert.deepStrictEqual(perm, ["icon", "label"], "权限槽位必须是「先图标、后图标+文字」");
  assert.deepStrictEqual(ctx, ["ring", "text"], "上下文槽位必须是「先环、后环+数值」");

  // 左右次序的**来源**：Composer 里 `{bar.槽位}` 的先后就是工具栏的左右布局
  // （`.composer-bar` 是 flex 行）。它一变，「哪一项先被挤掉」就跟着变。
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  const visual = [...composer.matchAll(/\{bar\.(\w+)\}/g)].map((match) => match[1]);
  assert.deepStrictEqual(
    visual,
    ["permission", "model", "effort", "preset", "attach", "tps", "context", "send"],
    "工具栏的渲染次序（= 从左至右）变了：同档内的优先级就是按它定的，改位置要同步改 rank",
  );
}
console.log("toolbarFit: 优先级表符合用户口径 ✓");

// ---------- 2. 宽度充裕：全部都显示（含 P2 三档） ----------
//
// 10 个档位落在 8 个槽位上（权限与上下文各占一个槽位的两档），
// 所以「全显示」= 8 项，且两处都是最高档。
{
  const shown = say(600);
  assert.deepStrictEqual(shown, ALL, `宽度充裕时应当全显示，实际 ${shown.join(" ")}`);
}
console.log("toolbarFit: 宽度充裕时全部显示 ✓");

// ---------- 3. 极窄：只剩 P0 三项，且不崩 ----------
{
  for (const available of [120, 0, -20]) {
    const shown = say(available);
    assert.deepStrictEqual(
      shown,
      ["model:full", "permission:icon", "send:full"],
      `可用宽度 ${available}px 时只应剩 P0 三项（且权限是图标档），实际 ${shown.join(" ")}`,
    );
  }
}
console.log("toolbarFit: 极窄时只剩 P0（pinned 保底） ✓");

// ---------- 4. 逐级降级：每一档的临界宽度 ----------
//
// 按样本宽度算出来的阶梯（P0 194px，每个可见元素再吃 8px 间距）：
//   218 P0 三项 → 252 +思考强度 → 282 +附件 → 334 +tps → 358 +上下文环
//   → 416 权限图标升成图标+文字（换档只花差价 +58）
//   → 496 +预设标签（新开一个槽位：+72 自身 +8 间距）
//   → 542 上下文环升成环+数值（+46，同槽位只花差价）
// 写死这几个边界是有意的：它们同时钉住「间距计入」与「换档只花差价」两件事，
// 也钉住 P2 内部「左端的权限文字 → 中段的预设标签 → 右端的上下文数值」这一次序。
{
  const P0 = ["model:full", "permission:icon", "send:full"];
  const L3 = ["effort:full", ...P0].sort();
  const L4 = ["attach:full", ...L3].sort();
  const L5 = ["tps:full", ...L4].sort();
  const L6 = ["context:ring", ...L5].sort();
  const L7 = ["permission:label", ...L6.filter((key) => key !== "permission:icon")].sort();
  const L8 = ["preset:full", ...L7].sort();
  const L9 = ALL;

  const steps: [number, string[]][] = [
    [218, P0],
    [252, L3],
    [282, L4],
    [334, L5],
    [358, L6],
    [416, L7],
    [496, L8],
    [542, L9],
  ];
  for (const [available, expected] of steps) {
    assert.deepStrictEqual(
      say(available),
      expected,
      `可用宽度 ${available}px 时的档位不对：\n期望 ${expected.join(" ")}\n实际 ${say(available).join(" ")}`,
    );
  }
  // 差一像素就差一档（宽度先向上取整再比大小，临界点上没有半像素抖动）
  assert.deepStrictEqual(say(251), P0, "251px 还放不下思考强度");
  assert.deepStrictEqual(say(415), L6, "415px 还放不下权限文字");
  assert.deepStrictEqual(say(495), L7, "495px 还放不下预设标签");
  assert.deepStrictEqual(say(541), L8, "541px 还放不下上下文数值");
}

// ---------- 4b. 单调性：宽度只增不减时，显示的档位只进不出 ----------
//
// 这是「前缀」规则的直接后果，也是拖动侧栏时唯一不闪的实现：
// 曾经写成「跳过装不下的高档、继续试低档」的贪心填充，实测在 242~330px 之间
// 会出现「附件进来、上下文环被挤出去，再宽一点上下文环又回来」的来回跳。
{
  let previousSlots = new Set<string>();
  const levels = new Map<string, number>();
  for (let available = 0; available <= 700; available += 1) {
    const chosen = [...pickVariants(VARIANTS, available, 8).values()];
    const slots = new Set(chosen.map((variant) => variant.slot));
    for (const slot of previousSlots) {
      assert.ok(slots.has(slot), `${slot} 槽位在 ${available}px 消失了——宽度变大不该少东西`);
    }
    for (const variant of chosen) {
      const before = levels.get(variant.slot);
      assert.ok(
        before === undefined || variant.rank >= before,
        `${variant.slot} 在 ${available}px 从档位 ${before} 退回 ${variant.rank}`,
      );
      levels.set(variant.slot, variant.rank);
    }
    previousSlots = slots;
  }
  // 一路撑到最后，两处「可升级的槽位」都必须停在最高档
  assert.strictEqual(levels.get("permission"), 7, "权限槽位最终应停在「图标+文字」档");
  assert.strictEqual(levels.get("context"), 9, "上下文槽位最终应停在「环+数值」档");
}
console.log("toolbarFit: 逐级降级 + 宽度变大只进不出 ✓");

// ---------- 5. 同槽位互斥：不会同时出现两档 ----------
{
  for (let available = 600; available >= 0; available -= 1) {
    const shown = say(available);
    for (const slot of ["permission", "context"]) {
      const hits = shown.filter((key) => key.startsWith(`${slot}:`));
      assert.ok(hits.length <= 1, `宽度 ${available}px 时 ${slot} 槽位选了 ${hits.join(" + ")}`);
    }
  }
}
console.log("toolbarFit: 同槽位档位互斥 ✓");

// ---------- 6. 间距要计入（每个可见元素吃掉一个 gap） ----------
//
// P0 三项自身 = 194px；gap 8 时还要 3×8 = 218px 才排得下（含最右侧 spacer 前那一处）。
// 少算间距的实现会在临界宽度上多塞一项，然后把模型名挤成省略号。
{
  const pinnedOnly = ["model:full", "permission:icon", "send:full"];
  assert.deepStrictEqual(say(218), pinnedOnly, "gap 计入后 P0 恰好占满 218px");
  assert.deepStrictEqual(
    say(220, 0),
    ["effort:full", ...pinnedOnly].sort(),
    "同样这附近 220px，间距为 0 时应当能多放一档——说明 gap 确实参与计算",
  );
}
console.log("toolbarFit: 间距计入可用宽度 ✓");

// ---------- 7. 结构不变量：tps 胶囊与明细里的「平均输出速度」同源同格式 ----------
//
// 用户 2026-09-15 口径：编辑框下方那个 tps「始终显示为详细信息中的平均输出速度」，
// 以便和 Web 对齐。此前它取的是「最近一条助手消息的解码窗口吞吐」
// （`usage.tokensPerSecond`，回退宿主保留的 `lastSpeed`）——那是**另一个数**，
// 与悬停明细里写的对不上。这里钉住两件事：唯一来源是会话统计，且两处用同一个
// 格式化函数与同一个词典 key。
{
  const source = readFileSync(join(process.cwd(), "src", "webview", "components", "Composer.tsx"), "utf8");
  assert.ok(
    /const tps =\s*stats && stats\.decodeMs > 0 && stats\.decodeTokens > 0\s*\?\s*stats\.decodeTokens \/ \(stats\.decodeMs \/ 1000\)/.test(
      source,
    ),
    "tps 必须取会话统计的平均输出速度（Σ输出 ÷ Σ解码窗口）",
  );
  assert.ok(
    !/state\.lastSpeed/.test(source),
    "界面不该再直接读 lastSpeed（那是「最近一条消息的窗口吞吐」，与明细不是同一个数）",
  );
  assert.ok(
    /const speedValue = tps !== undefined \? formatTps\(tps\) : undefined;/.test(source),
    "胶囊与明细必须共用 formatTps（否则同一个数会显示成 1.2 和 1)",
  );
  const speedUses = source.match(/texts\.tokensPerSecond\(speedValue\)/g) ?? [];
  assert.ok(
    speedUses.length >= 2,
    "胶囊与悬停明细都要用 texts.tokensPerSecond(speedValue)（同文案、双语齐备）",
  );
}
console.log("toolbarFit: tps 与明细同源同格式 ✓");

console.log("\ntoolbarFit: all assertions passed");
