import type { ChatState, UsageView } from "../shared/chat";

/**
 * 缓存命中率：**官方口径在本仓库的唯一一份实现**。
 *
 * 依据官方客户端 `@deepseek-ai/dsh-client-ui-chat`（源码树里的 `packages/client/ui-chat`）：
 * - `src/client/chat/token-format.ts` 的 `formatCacheHitPercent`——百分比文本怎么算
 *   （整数进位、以及「部分命中绝不被四舍五入成 100%」时自动多给几位）；
 * - `src/client/chat/StatsPills.tsx` 的 `billedInputTokens` 与 `cacheHitPercent`——
 *   **会话口径**：分子 `cacheReadTokens`，分母是三个 prompt 侧计费桶之和
 *   （`uncachedInputTokens + cacheReadTokens + cacheWriteTokens`），数据来自 `tokenUsage` 投影；
 * - `src/client/chat/TurnUsagePanel.tsx`——**单轮口径**：分母 `totalTokens - outputTokens`。
 *
 * 官方的两个面板共用同一个 `formatCacheHitPercent`，差别只在数据源与小数位
 * （会话胶囊 0 位、单轮明细 1 位）。这里照同一套分工：两个入口各一个函数、
 * 共用一个格式化实现——**不许在组件里再算一遍**，否则同一个界面上会出现两个口径。
 */

/** 会话累计用量（`tokenUsage` 投影）里本模块要读的三个 prompt 侧计费桶。 */
type BilledUsage = Pick<
  NonNullable<ChatState["tokenUsage"]>,
  "uncachedInputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

/**
 * 计费输入 token：三个 prompt 侧计费桶之和（官方 `billedInputTokens` 同式）。
 *
 * 三桶**互不重叠**，所以相加不重复计数；output 不在这里（它不在命中率的分母里）。
 */
export function billedInputTokens(usage: BilledUsage): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * 比例进位到**精确的百分比单位**（0 位时 1 单位 = 1%，1 位时 1 单位 = 0.1%），
 * 正中点向上取整（官方同名内部函数：不用浮点乘除，避免临界值少一位）。
 */
function roundedPercentUnits(
  cacheReadTokens: number,
  denominator: number,
  decimalPlaces: 0 | 1,
): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
  const scale = unitsPerPercent * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    const threshold =
      factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale);
    if (cacheReadTokens >= threshold) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

/** 把百分比单位还原成文本（0 位时是整数，1 位时末位为 0 就省掉小数点）。 */
function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

/**
 * 可直接显示的缓存命中率（**不含 `%`**）。
 *
 * 与官方 `formatCacheHitPercent` 逐字同口径：
 * - 分母为 0（没有计费输入）→ `null`，调用方不显示；
 * - 全部命中 → `100`；
 * - 其余按 `decimalPlaces` 进位；**要进成 `100` 而实际有未命中时**，改用
 *   「刚好还能区分出未命中的最短位数」——`99.9` / `99.99` 这种写法。这是官方刻意
 *   钉住的一条：把 99.97% 显示成「100%」会让用户以为缓存全覆盖了。
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens === 0) return null;
  const missedInputTokens = promptTokens - cacheReadTokens;
  if (missedInputTokens === 0) return "100";

  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000;
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces);

  let distinguishingPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}

/**
 * 工具栏那枚命中率读数（**会话口径**，用户 2026-10-10 口径的最低优先级元素，
 * 界面里是容量数值右侧的**独立**元素，写法 `98.7% HIT`）。
 *
 * 数据源是 `tokenUsage` 投影（全会话累计，官方 `UsagePill` 读的同一个键）而不是
 * 「最后一条消息的 usage」：后者是**单步**用量、且最后一条消息不一定有 usage，
 * 拿它当工具栏的常驻读数会一会儿有一会儿没有。分母按官方 `cacheHitPercent`：
 * 三个 prompt 侧计费桶之和（`docs/audit-projections-panels.md` 的 tokenUsage 一节
 * 记的也是这个口径）。
 *
 * **拿不到数据就什么都不给**（调用方据此隐藏这一档，而不是显示 0%）：
 * - 没有投影——老服务端没有这个计量单元，`state.tokenUsage` 是 `undefined`；
 * - `cacheReadTokens` 不是正数——读取器（`projections.tokenUsageFromProjection`）
 *   对缺失字段补 0，所以「服务端没报这个字段」与「服务端报了 0」在投影层分不开，
 *   两种情况都不该编出一个读数；会话第一次发请求时也还没读到过缓存。
 * 按肯定证据写：**只有确实读到过缓存读取**才显示命中率。
 */
export function sessionCacheHitPercent(usage: ChatState["tokenUsage"] | undefined): string | undefined {
  if (!usage || !(usage.cacheReadTokens > 0)) return undefined;
  // 一位小数：用户口径的示例形如 `98.7% HIT`（官方的会话胶囊默认取整数，但同一个
  // `formatCacheHitPercent` 的单轮面板取一位——精度是显示选择，口径才是算法）。
  return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage), 1) ?? undefined;
}

/**
 * 上下文圆环悬停明细里的命中率（**单轮口径**，官方 `TurnUsagePanel` 同式：
 * 分母是 `totalTokens - outputTokens`）。
 *
 * 扩展的 `UsageView` 比官方的单轮契约更穷：`totalTokens` 可能压根没有（线格式里
 * 它是可选的），那时退回 `inputTokens`——它同样是 prompt 侧、不含 output。
 * 两者都拿不到就不显示（这一行在明细里是可选项，官方也一样）。
 */
export function turnCacheHitPercent(usage: UsageView | undefined): string | undefined {
  const read = usage?.cacheReadTokens;
  if (typeof read !== "number" || read < 0) return undefined;
  const denominator =
    typeof usage?.totalTokens === "number" && typeof usage.outputTokens === "number"
      ? usage.totalTokens - usage.outputTokens
      : usage?.inputTokens;
  if (typeof denominator !== "number" || denominator <= 0) return undefined;
  return formatCacheHitPercent(read, denominator, 1) ?? undefined;
}
