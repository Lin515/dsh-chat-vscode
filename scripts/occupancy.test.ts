/**
 * 上下文占用环：**常驻显示**、每轮刷新、口径唯一。
 *
 * 需求（用户 2026-09-12 明确）：
 * - 占用条要**常驻显示**，不能空着；
 * - 没刷新时**保留旧值**，不要清空；
 * - 每轮对话都应该刷新（此前「好几轮都没刷新」）。
 *
 * 实测依据（`scripts/pressureProbe.ts`，三轮真实对话）：
 * ```
 * 轮次    官方 pressure  官方 projected  本地复算    窗口
 * 一轮后  -              -               19206     1000000   ← 分子要等下次请求才出现
 * 二轮后  19206          19215           19206     1000000
 * 三轮后  19206          19844           19206     1000000   ← pressure 不动，projected 每轮都动
 * ```
 * 两条关键结论：
 * 1. **`projectedTokens` 才是逐轮变化的那个**（也是压缩后唯一会下降的），必须优先；
 * 2. 本地 `input + cached` 与官方 `pressureTokens` **逐字相等**（19206 == 19206）
 *    且不等于 `totalTokens`（19208）→ 投影没给分子时用它兜底是**同口径**的，不是另算。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import { contextNumbers, formatContextSpan } from "../src/webview/components/primitives";

/** 收集 patch 帧里的 contextOccupancy 序列。 */
function harness() {
  const occupancy: (unknown)[] = [];
  const adapter = new SessionAdapter((frame) => {
    if (frame.type === "patch" && "contextOccupancy" in frame.patch) {
      occupancy.push(frame.patch.contextOccupancy);
    }
  });
  return { adapter, occupancy };
}

const value = (pressureTokens?: number, projectedTokens?: number, contextWindow?: number) => ({
  pressureTokens,
  projectedTokens,
  contextWindow,
});

/**
 * 线格式的用量（`TokenUsage`）。
 *
 * 注意与 `UsageView` 的区别：线格式分 `cacheReadTokens` / `cacheWriteTokens` 两桶，
 * 而 `toUsage` 把它们合成 `UsageView.cachedTokens`。喂合成字段是**无效**的
 * ——`toUsage` 只读线格式字段，写 `cachedTokens` 会被静默忽略（我第一版就这么错过了）。
 */
interface WireUsage {
  inputTokens: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

/** 实测里那一轮：input 18054 + 缓存 1152 → 官方 pressureTokens 19206（不是 total 19208）。 */
const USAGE: WireUsage = {
  inputTokens: 18_054,
  outputTokens: 2,
  cacheReadTokens: 1_152,
  cacheWriteTokens: 0,
  totalTokens: 19_208,
};

/** 把一份**线格式**用量喂进适配器（走真实的 assistant/message 路径）。 */
function feedUsage(adapter: SessionAdapter, usage: WireUsage = USAGE): void {
  adapter.applyEvent({
    type: "assistant/message",
    seq: 1,
    time: 1_789_147_200_000,
    data: { turn: 1, step: 0, usage, message: { id: "m1", role: "assistant", content: [] } },
  } as never);
}

// ---------- 1. 分子优先 projectedTokens（唯一会逐轮变化、且压缩后会降的那个） ----------

{
  const { adapter, occupancy } = harness();
  adapter.applyContextPressure(value(19_206, 19_844, 1_000_000));
  assert.deepStrictEqual(
    occupancy.at(-1),
    { percent: 2, usedTokens: 19_844, contextWindow: 1_000_000 },
    "同时有 pressure 与 projected 时用 projected —— 实测只有它逐轮变化，压缩后也只有它会降",
  );

  adapter.applyContextPressure(value(19_206, undefined, 1_000_000));
  assert.deepStrictEqual(occupancy.at(-1), { percent: 2, usedTokens: 19_206, contextWindow: 1_000_000 });
}
console.log("occupancy: 分子优先 projectedTokens、其次 pressureTokens ✓");

// ---------- 2. 投影没给分子时，用本地同口径复算（一轮之后就有数） ----------
//
// 这是「常驻显示」的关键：实测第一轮结束后投影**只有分母**，此时若没有本地兜底，
// 界面就只能空着或者停在上一个会话的旧值。
{
  const { adapter, occupancy } = harness();
  adapter.applyContextPressure(value(undefined, undefined, 1_000_000));
  assert.strictEqual(occupancy.length, 0, "只有分母时还没法算百分比（分母到了但分子没有）");

  feedUsage(adapter); // 一轮结束：本地拿到 input + cached
  assert.deepStrictEqual(
    occupancy.at(-1),
    { percent: 2, usedTokens: 19_206, contextWindow: 1_000_000 },
    "本地复算 18054+1152 = 19206，与官方 pressureTokens 逐字相同",
  );
}
console.log("occupancy: 投影缺分子时用本地同口径复算兜底 ✓");

// ---------- 2b. 本地复算**不含 output**（不是 totalTokens） ----------

{
  const { adapter, occupancy } = harness();
  adapter.applyContextPressure(value(undefined, undefined, 1_000_000));
  feedUsage(adapter);
  const shown = occupancy.at(-1) as { usedTokens: number };
  assert.strictEqual(shown.usedTokens, 19_206);
  assert.notStrictEqual(shown.usedTokens, USAGE.totalTokens, "用 totalTokens(19208) 会混进 output，系统性偏高");
}
console.log("occupancy: 本地复算不含 output ✓");

// ---------- 3. 官方值优先于本地值（压缩后要能下降） ----------

{
  const { adapter, occupancy } = harness();
  adapter.applyContextPressure(value(undefined, undefined, 1_000_000));
  feedUsage(adapter); // 本地先给 19206
  // 官方随后给出「下一次请求」的估计（压缩后它会变小）
  adapter.applyContextPressure(value(19_206, 5_000, 1_000_000));
  assert.deepStrictEqual(
    occupancy.at(-1),
    { percent: 1, usedTokens: 5_000, contextWindow: 1_000_000 },
    "官方 projectedTokens 必须覆盖本地值 —— 否则压缩后占用条不会下降",
  );
}
console.log("occupancy: 官方值优先，压缩后能下降 ✓");

// ---------- 4. 什么来源都没有时**保留旧值**（常驻显示，不清空） ----------

{
  const { adapter, occupancy } = harness();
  feedUsage(adapter); // 本地分子 = 19206（这份会一直留着）
  adapter.applyContextPressure(value(undefined, undefined, 1_000_000));
  const shown = { percent: 2, usedTokens: 19_206, contextWindow: 1_000_000 };
  assert.deepStrictEqual(occupancy.at(-1), shown);

  // 投影什么都没给（分子分母都消失）：**保留旧值**
  adapter.applyContextPressure(value(undefined, undefined, undefined));
  assert.strictEqual(occupancy.length, 1, "没有新数据时不该再发帧");
  assert.deepStrictEqual(adapter.contextOccupancy, shown, "**保留旧值**，不是清空（占用条是常驻指示器）");

  // 分母换了 → 用已知分子 + 新分母重算
  adapter.applyContextPressure(value(undefined, undefined, 2_000_000));
  assert.deepStrictEqual(
    occupancy.at(-1),
    { percent: 1, usedTokens: 19_206, contextWindow: 2_000_000 },
    "分母换了就用新分母重算（分子沿用已知值）",
  );
}
console.log("occupancy: 没有新数据时保留旧值（常驻，不清空） ✓");

// ---------- 4a. 连本地值都没有时也不清空（宁旧勿空） ----------

{
  const { adapter, occupancy } = harness();
  adapter.applyContextPressure(value(19_206, undefined, 1_000_000));
  const shown = occupancy.at(-1);
  // 之后投影把分子丢了，而本地也从没拿到过用量 → 无从重算
  adapter.applyContextPressure(value(undefined, undefined, undefined));
  assert.strictEqual(occupancy.length, 1);
  assert.deepStrictEqual(adapter.contextOccupancy, shown, "算不出来就保持原样，而不是把它抹掉");
}
console.log("occupancy: 算不出来时保持原样（不清空） ✓");

// ---------- 4b. 分母回退到 request/context 事件（同一个量） ----------

{
  const { adapter, occupancy } = harness();
  adapter.applyEvent({
    type: "request/context", seq: 1, time: 1, data: { contextWindow: 500_000, model: "m" },
  } as never);
  feedUsage(adapter);
  assert.deepStrictEqual(
    occupancy.at(-1),
    { percent: 4, usedTokens: 19_206, contextWindow: 500_000 },
    "投影还没给分母时，用 request/context 的那份（两者是同一个量）",
  );
}
console.log("occupancy: 分母可回退到 request/context 事件 ✓");

// ---------- 5. 每轮用量都会触发刷新（这就是「好几轮没刷新」的修复） ----------

{
  const { adapter, occupancy } = harness();
  adapter.applyContextPressure(value(undefined, undefined, 1_000_000));
  feedUsage(adapter);
  assert.strictEqual(occupancy.length, 1);

  // 第二轮：上下文长了，本地值变大 → 必须刷新
  // 线格式：input 30000 + cacheRead 1000 = 31000（**不含** output 10）
  feedUsage(adapter, { inputTokens: 30_000, cacheReadTokens: 1_000, outputTokens: 10, totalTokens: 31_010 });
  assert.strictEqual(occupancy.length, 2, "每来一份用量都要刷新占用（投影不动时这是唯一的刷新源）");
  assert.deepStrictEqual(occupancy.at(-1), { percent: 3, usedTokens: 31_000, contextWindow: 1_000_000 });
}
console.log("occupancy: 每轮用量都触发刷新 ✓");

// ---------- 6. 百分比封顶 / 容量为 0 不算 / 值未变不重复发 ----------

{
  const { adapter, occupancy } = harness();
  adapter.applyContextPressure(value(12_000, undefined, 10_000));
  assert.strictEqual((occupancy.at(-1) as { percent: number }).percent, 100, "不能显示 120%");
  adapter.applyContextPressure(value(12_000, undefined, 10_000));
  assert.strictEqual(occupancy.length, 1, "值未变不重复发帧");

  const other = harness();
  other.adapter.applyContextPressure(value(5_000, undefined, 0));
  assert.strictEqual(other.occupancy.length, 0, "容量为 0 时不该算出 Infinity%");
  assert.strictEqual(other.adapter.contextOccupancy, undefined);
}
console.log("occupancy: 封顶 100 / 容量 0 不算 / 未变不发 ✓");

// ---------- 7. 界面侧不许自己算：结构不变量 ----------
//
// 数字口径只能有一处。界面里再留一条「拿不到就回退到 usage 自己算」的路，
// 同一个圆环就会时而官方口径、时而含 output 的本地口径。
{
  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  const start = primitives.indexOf("export function CtxText(");
  assert.ok(start >= 0, "找不到 CtxText");
  const end = primitives.indexOf("\n}\n", start);
  assert.ok(end > start, "找不到 CtxText 的函数体结尾");
  const ctxText = primitives.slice(start, end);
  assert.ok(ctxText.length > 400, `抽出来的 CtxText 太短，正则多半提前收工了（${ctxText.length} 字符）`);

  assert.ok(
    !/usage\?\.totalTokens/.test(ctxText),
    "CtxText 不许引用 usage.totalTokens —— 那是含 output 的本地口径",
  );
  assert.ok(
    !/Math\.round\(\(usedValue \/ total\)/.test(ctxText),
    "CtxText 不许本地算百分比；百分比必须由宿主给出",
  );

  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  const callStart = composer.indexOf("<CtxText");
  assert.ok(callStart >= 0, "Composer 里找不到 <CtxText />");
  const call = composer.slice(callStart, composer.indexOf("/>", callStart) + 2);
  assert.ok(
    !/\?\?\s*lastMessage\?\.usage\?\.totalTokens/.test(call),
    "Composer 传给 CtxText 的 used 不许回退到 lastMessage.usage.totalTokens",
  );
}
console.log("occupancy: 界面侧没有本地重算 / 回退路径（结构不变量） ✓");

// ---------- 8. 精确数值的写法（用户 2026-09-14 口径 `44K/128K` / `400K/1.0M`）----------
//
// 工具栏最宽裕那一档把这段文字显示在圆环右侧。分子分母**各自按量级挑单位**：
// 百万位的窗口就该写作 `1.0M`，不是 `1000K`，也不再额外加括号把总量重复一遍。
{
  assert.strictEqual(formatContextSpan(43_520, 128_000), "44K/128K");
  assert.strictEqual(formatContextSpan(8_500, 128_000), "8.5K/128K", "万位以下保留一位小数");
  assert.strictEqual(formatContextSpan(400_000, 1_000_000), "400K/1.0M", "1M 的窗口用 M，不用 1000K");
  assert.strictEqual(formatContextSpan(437_000, 1_000_000), "437K/1.0M");
  assert.strictEqual(formatContextSpan(250_000, 2_000_000), "250K/2.0M");
  assert.strictEqual(formatContextSpan(1_500_000, 2_000_000), "1.5M/2.0M", "分子超过 1M 也照样升到 M");
  assert.strictEqual(formatContextSpan(500, 128_000), "500/128K", "不足 1K 时照实给数字");
  assert.ok(!/\(/.test(formatContextSpan(437_000, 1_000_000)), "不再有括号");
  // 三个数同源同现：缺一就不该有「上下文占用」这一档（工具栏按它决定要不要占坑位）
  assert.strictEqual(contextNumbers(34, 43_520, 128_000)?.used, 43_520);
  assert.strictEqual(contextNumbers(34, 43_520, undefined), undefined, "缺分母不显示");
  assert.strictEqual(contextNumbers(undefined, 43_520, 128_000), undefined, "缺百分比不显示");
  assert.strictEqual(contextNumbers(34, undefined, 128_000), undefined, "缺分子不显示");
  assert.strictEqual(contextNumbers(34, 43_520, 0), undefined, "分母为 0 不显示");
}
console.log("occupancy: 精确数值写法 `44K/128K` / `400K/1.0M` ✓");

console.log("\noccupancy: all assertions passed");
