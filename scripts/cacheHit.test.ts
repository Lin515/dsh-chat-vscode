/**
 * 缓存命中率：**口径**（分子分母是谁、怎么进位）与「没有数据时不显示」。
 *
 * 这块逻辑只有一个实现（`src/webview/cacheHit.ts`，官方 `formatCacheHitPercent` 的等价
 * 移植），两个界面入口共用它：
 * - 工具栏那枚最低优先级的独立读数（容量数值右侧的 `98.7% HIT`）→ **会话累计**口径，
 *   数据来自 `tokenUsage` 投影，等价官方 `UsagePill` 的 `cacheHitPercent`；
 * - 上下文圆环悬停明细里那一行 → **单轮**口径，数据来自最后一条消息的 usage，
 *   等价官方 `TurnUsagePanel`。
 *
 * 这个文件钉三件事（前两件是任务验收要求的）：
 * 1. 命中率的算法与官方逐值同口径（含「部分命中不许显示成 100%」那条）；
 * 2. 数据缺失时返回 `undefined`（调用方据此隐藏该元素，而不是显示 `0%`）；
 * 3. 工具栏那一档确实接的是会话口径与会话数据（结构不变量，防止有人换回单步用量）。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  billedInputTokens,
  formatCacheHitPercent,
  sessionCacheHitPercent,
  turnCacheHitPercent,
} from "../src/webview/cacheHit";

// ---------- 1. 会话口径：分子是缓存读取，分母是三个 prompt 侧计费桶之和 ----------
//
// 样本逐字取界面夹具里那一份真实量级（`test/preview.html` 的 `tokenUsage`）：
// 40100 / (18240 + 40100 + 2048) = 66.4%。
{
  const usage = {
    uncachedInputTokens: 18240,
    outputTokens: 3120,
    cacheReadTokens: 40100,
    cacheWriteTokens: 2048,
  };
  assert.strictEqual(
    billedInputTokens(usage),
    60388,
    "计费输入 = 未命中输入 + 缓存读取 + 缓存写入（三桶互不重叠，官方 billedInputTokens 同式）",
  );
  assert.strictEqual(sessionCacheHitPercent(usage), "66.4", "40100/60388 = 66.4%");

  // output **不进分母**：官方口径里它是 prompt 侧之外的另一侧
  assert.strictEqual(
    sessionCacheHitPercent({ ...usage, outputTokens: 999_999 }),
    "66.4",
    "输出 token 不参与命中率的分母",
  );
  // 缓存写入同样算「没命中的输入」：只把 read+uncached 当分母会得到 68.7%（另一个数）
  assert.strictEqual(
    sessionCacheHitPercent({ ...usage, cacheWriteTokens: 0 }),
    "68.7",
    "缓存写入必须计入分母（否则同一个会话会显示成另一个命中率）",
  );

  assert.strictEqual(
    sessionCacheHitPercent({
      uncachedInputTokens: 0,
      outputTokens: 10,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
    }),
    "100",
    "整段提示词全部命中 → 100",
  );
  // 官方那条刻意的进位规则：99.99% 不许被显示成「100%」
  assert.strictEqual(
    sessionCacheHitPercent({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 9999,
      cacheWriteTokens: 1,
    }),
    "99.99",
    "有未命中时不能显示成 100%（官方 formatCacheHitPercent 的加精度分支）",
  );
  // 一位小数（用户口径的示例形如 `98.7% HIT`）
  assert.strictEqual(formatCacheHitPercent(988, 1000, 1), "98.8");
  assert.strictEqual(formatCacheHitPercent(988, 1000, 0), "99");
}
console.log("cacheHit: 会话口径（三桶做分母、部分命中不显示 100%）✓");

// ---------- 2. 数据缺失 → 隐藏（不是显示 0%） ----------
//
// 「数据缺失」有三种形态，前两种在投影层是**同一个形状**（读取器对缺失字段补 0，
// 见 `projections.tokenUsageFromProjection`），所以判据是「读到过缓存读取」这个
// 肯定证据；第三种是分母不成立。
{
  assert.strictEqual(sessionCacheHitPercent(undefined), undefined, "没有 tokenUsage 投影（老服务端）→ 不显示");

  const zeroed = {
    uncachedInputTokens: 18240,
    outputTokens: 3120,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  assert.strictEqual(
    sessionCacheHitPercent(zeroed),
    undefined,
    "cacheReadTokens 为 0（服务端没报这个字段 / 会话还没读到过缓存）→ 不显示，不要编一个 0%",
  );
  assert.strictEqual(
    sessionCacheHitPercent({ ...zeroed, cacheWriteTokens: 2048 }),
    undefined,
    "只写过缓存、还没命中过（第一轮）→ 不显示",
  );
  assert.strictEqual(
    sessionCacheHitPercent({ ...zeroed, uncachedInputTokens: 0 }),
    undefined,
    "全零的投影（没有任何计费输入）→ 不显示",
  );
  // 返回值是**不带 `%`** 的数字文本：百分号与前面的逗号由词典文案负责（中英间距不同）
  assert.ok(
    !String(sessionCacheHitPercent({ ...zeroed, cacheReadTokens: 40100 })).includes("%"),
    "命中率文本不带 `%`（那是文案的事）",
  );
}
console.log("cacheHit: 数据缺失时隐藏（undefined，而不是 0%）✓");

// ---------- 3. 单轮口径（悬停明细那条）：分母 totalTokens - outputTokens ----------
//
// 与官方 `TurnUsagePanel` 同式；扩展的线格式里 `totalTokens` 是可选的，所以多一条
// 退回 `inputTokens`（同样是 prompt 侧、不含 output）的兜底。
{
  assert.strictEqual(
    turnCacheHitPercent({ totalTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 4_000 }),
    "50",
    "4000 / (10000 - 2000) = 50%",
  );
  assert.strictEqual(
    turnCacheHitPercent({ inputTokens: 2_000, cacheReadTokens: 1_000 }),
    "50",
    "没有 totalTokens 时退回 inputTokens（同是 prompt 侧）",
  );
  assert.strictEqual(
    turnCacheHitPercent({ totalTokens: 10_000, cacheReadTokens: 4_000 }),
    undefined,
    "totalTokens 有而 outputTokens 没有、也没有 inputTokens：两个口径都算不出，不猜",
  );
  assert.strictEqual(turnCacheHitPercent({ totalTokens: 10_000, outputTokens: 2_000 }), undefined, "没报 cacheReadTokens → 不显示");
  assert.strictEqual(
    turnCacheHitPercent({ totalTokens: 2_000, outputTokens: 2_000, cacheReadTokens: 0 }),
    undefined,
    "分母非正（这一轮只有输出）→ 不显示",
  );
  // 与工具栏那条**故意不同**：单轮明细里 read=0 是「这一轮没吃到缓存」的真实读数
  assert.strictEqual(
    turnCacheHitPercent({ totalTokens: 5_000, outputTokens: 1_000, cacheReadTokens: 0 }),
    "0",
    "单轮明细里 0 是有意义的读数（它问的就是这一轮）",
  );
}
console.log("cacheHit: 单轮口径（悬停明细）与它的兜底/隐藏判据 ✓");

// ---------- 4. 结构不变量：工具栏那一档接的是会话口径与会话数据 ----------
//
// 纯函数测不到「谁喂给它什么」。这里读源码钉住三点：工具栏的命中率来自
// `tokenUsage`（会话累计）、它是**独立元素**（用户 2026-10-10 第二条口径）且文案走词典。
{
  /** 行尾统一（本仓库 `.gitattributes` 是 `text=auto`，检出可能是 CRLF）。 */
  const source = (relative: string): string =>
    readFileSync(join(process.cwd(), relative), "utf8").replace(/\r\n/g, "\n");
  const composer = source(join("src", "webview", "components", "Composer.tsx"));

  assert.ok(
    /const cacheHitText = sessionCacheHitPercent\(state\.tokenUsage\);/.test(composer),
    "工具栏命中率必须取会话累计的 tokenUsage（单步 usage 时有时无，当常驻读数会一闪一闪）",
  );
  assert.ok(
    /"cache:full": cacheHitText \?/.test(composer),
    "命中率必须自成一个 `cache:full` 档，且只以命中率数据为条件（不再挂在上下文数值上）",
  );
  assert.ok(
    !/"context:cache"|cacheHit=\{/.test(composer),
    "命中率不许再当上下文槽位的第三档 / 传进 CtxRing 与数值拼成一格（用户口径：单独的元素）",
  );
  assert.ok(
    /<span className="ctx-cache-hit">\{texts\.ctxCacheHit\(cacheHitText\)\}<\/span>/.test(composer),
    "独立元素的文案必须走词典（`ctxCacheHit`），不在组件里拼 `% HIT`",
  );
  // 位置：`{bar.cache}` 必须紧跟 `{bar.context}`（用户在容量数值右边）
  assert.ok(
    /\{bar\.context\}\s*\n[\s\S]{0,400}?\{bar\.cache\}/.test(composer),
    "`{bar.cache}` 必须排在 `{bar.context}` 之后（用户口径：位置在上下文容量右边）",
  );
}
console.log("cacheHit: 工具栏那一档的接线（会话口径 + 独立元素 + 词典文案）✓");

console.log("\ncacheHit: all assertions passed");
