/**
 * 缓存命中率：**口径**（分子分母是谁、怎么进位）、「没有数据时不显示」与「界面只有这一个口径」。
 *
 * 这块逻辑只有一个实现（`src/webview/cacheHit.ts`，官方 `formatCacheHitPercent` 的等价移植），
 * 界面上的三处读数（工具栏那枚 `98.7%HIT` 与两处悬停明细里的「缓存命中」行）共用它：
 * **会话累计**口径，数据来自 `tokenUsage` 投影，等价官方 `UsagePill` 的 `cacheHitPercent`
 * （用户 2026-10-10 口径：明细里的数必须与工具栏一致，官方可见的也是这个口径）。
 * 官方另一个命中率在「本轮用量」对话框，那是**整轮累加**（`deriveTurnTokenUsage`），
 * 与逐 step 的用量都不是一回事，本扩展不放那个数——下面有一条断言钉住这一点。
 *
 * 这个文件钉四件事（前两件是任务验收要求的）：
 * 1. 命中率的算法与官方逐值同口径（含「部分命中不许显示成 100%」那条）；
 * 2. 数据缺失时返回 `undefined`（调用方据此隐藏该元素，而不是显示 `0%`）；
 * 3. 视图模型不许替服务端编总账（`inputTokens` 是未缓存输入，加出来的 total 会漏缓存桶）；
 * 4. 工具栏那一档与两处悬停明细接的都是**同一个会话口径的值**（结构不变量）。
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
} from "../src/webview/cacheHit";
import { SessionAdapter } from "../src/dsh/adapter";
import type { UsageView } from "../src/shared/chat";

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
  // 一位小数（用户口径的示例形如 `98.7%HIT`）
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

// ---------- 3. 视图模型不许替服务端编总账 ----------
//
// `UsageView.totalTokens` 从前是 `totalTokens ?? inputTokens + outputTokens` 算出来的。
// 那个补法漏掉两个缓存桶（线格式契约：`inputTokens` 只是**未缓存**输入，prompt 侧三桶互不
// 重叠），谁拿它当分母就会得到一个不是命中率的比例——用户 2026-10-10 报的「详情里的与官方
// 差很多」就有它一份。这里驱动**真实适配器**，钉住「服务端没给就没有」。
{
  const usages: (UsageView | undefined)[] = [];
  const adapter = new SessionAdapter((frame) => {
    if (frame.type === "message/upsert" && frame.message.role === "assistant") {
      usages.push(frame.message.usage);
    }
  });
  const feed = (usage: Record<string, number>): void => {
    adapter.applyEvent({
      type: "assistant/message",
      seq: 1,
      time: 1,
      data: { turn: 1, step: 0, usage, message: { id: "m1", role: "assistant", content: [] } },
    } as never);
  };

  feed({ inputTokens: 18_054, outputTokens: 2, cacheReadTokens: 1_152, cacheWriteTokens: 0 });
  assert.strictEqual(
    usages.at(-1)?.totalTokens,
    undefined,
    "服务端没给 totalTokens 时视图模型**没有**总账（不许拿 inputTokens + outputTokens 补）",
  );
  assert.strictEqual(usages.at(-1)?.cacheWriteTokens, 0, "缓存写入桶单独带出来（线格式里它与缓存读是两桶）");

  feed({ inputTokens: 18_054, outputTokens: 2, cacheReadTokens: 1_152, cacheWriteTokens: 0, totalTokens: 19_208 });
  assert.strictEqual(usages.at(-1)?.totalTokens, 19_208, "服务端给了 totalTokens 就原样透传");
}
console.log("cacheHit: 视图模型不编总账（透传服务端 / 缺就缺）✓");


// ---------- 4. 结构不变量：工具栏那一档接的是会话口径与会话数据 ----------
//
// 纯函数测不到「谁喂给它什么」。这里读源码钉住三点：工具栏的命中率来自
// `tokenUsage`（会话累计）、它是**独立元素**（用户 2026-10-10 第二条口径）且文案走词典。
{
  /** 行尾统一（本仓库 `.gitattributes` 是 `text=auto`，检出可能是 CRLF）。 */
  const source = (relative: string): string =>
    readFileSync(join(process.cwd(), relative), "utf8").replace(/\r\n/g, "\n");
  const composer = source(join("src", "webview", "components", "Composer.tsx"));
  const primitives = source(join("src", "webview", "components", "primitives.tsx"));

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
    /className="ctx-cache-hit" title=\{ctxDetailTitle\}/.test(composer) &&
      /\{texts\.ctxCacheHit\(cacheHitText\)\}/.test(composer),
    "独立元素的文案必须走词典（`ctxCacheHit`），不在组件里拼 `%HIT`；悬停明细挂 `ctxDetailTitle`",
  );
  // 悬停：命中率读数与上下文圆环**共用同一份明细**（用户 2026-10-10 口径：
  // 缓存命中悬停显示与上下文悬停一模一样的信息）。两侧各钉一条，防止有人改一处。
  assert.ok(
    /const ctxDetailTitle = contextDetailLines\(ctxProps, texts\)/.test(composer),
    "缓存命中的悬停明细必须由 `contextDetailLines` + 同一组 `ctxProps` 拼出，不许另拼一份",
  );
  assert.ok(
    /const detail = contextDetailLines\(\{ percent, used, total, cacheHit, breakdown \}, texts\);/.test(primitives),
    "上下文圆环的悬停明细也必须走这同一个拼法（否则「一模一样」会随任一处改动过期）",
  );
  // 明细里那一行**就是**工具栏那个数（用户 2026-10-10 口径：两处同一个数）。
  // 数据源只有一个 `cacheHitText`，所以这里钉的是「它被喂进明细」，而不是「再算一遍」。
  assert.ok(
    /cacheHit: cacheHitText,/.test(composer),
    "明细里的命中率必须直接取 `cacheHitText`（会话累计口径），不许回退到某条消息的用量",
  );
  assert.ok(
    !/usage/.test(primitives.slice(primitives.indexOf("export interface ContextDetailInput"), primitives.indexOf("export function contextDetailLines"))),
    "`ContextDetailInput` 不再收单步 usage：明细里的命中率只有会话口径一个来源",
  );
  // 位置：`{bar.cache}` 必须紧跟 `{bar.context}`（用户在容量数值右边）
  assert.ok(
    /\{bar\.context\}\s*\n[\s\S]{0,400}?\{bar\.cache\}/.test(composer),
    "`{bar.cache}` 必须排在 `{bar.context}` 之后（用户口径：位置在上下文容量右边）",
  );
}
console.log("cacheHit: 工具栏那一档的接线（会话口径 + 独立元素 + 词典文案）✓");

console.log("\ncacheHit: all assertions passed");
