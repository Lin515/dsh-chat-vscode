/**
 * 底部工具栏的按优先级分配：`src/webview/toolbarFit.ts` 的纯函数断言。
 *
 * 这套逻辑没有写死的像素阈值（宽度是界面实测出来的），所以「多宽该显示谁」
 * 在无头环境里没法靠渲染验证；能钉住、也正是最容易改错的是**分配规则**本身：
 * 谁先被挤掉、同槽位的两档会不会同时出现、pinned 是否真的保底。
 *
 * 后半部分（「量不到盒」「观察者随节点走」两节）钉的是**什么时候才允许结算**与
 * **观察者挂在谁身上**：真浏览器回路（`.agent` 下的 iframe 壳子 + Playwright）验行为，
 * 这里用可注入的假观察者把生命周期与判据钉住，最后再用源码判据确认 Composer 把两端接上了。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BAR_ORDER, createFitAnchor, pickVariants, toolbarAvailableWidth, type FitObserver, type ToolbarVariant } from "../src/webview/toolbarFit";

/** 一份贴近真实的宽度样本（px）：模型名较长、权限文字是中文口径。
 *
 * 权限与模型两个胶囊**不带下箭头**（用户 2026-09-22 精简 UI），所以它们的宽度是
 * 「图标/文字 + 内边距」，比带箭头时各少 12px（箭头 8px + 间距 4px）——
 * 样本跟着改，阶梯的临界值也随之前移（这不是写死的常量，只是这份样本的算术结果）。 */
const WIDTHS: Record<string, number> = {
  "permission:icon": 22,
  "model:full": 120,
  // `提供商/模型名` 全格式档：模型名之外再挂一个提供商展示名（如「某提供商/」）
  "model:provider": 190,
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
  // 容量数值右侧的缓存命中率（`98.7%HIT`，用户 2026-10-10 口径的最低优先级元素）：
  // 它是**独立元素**（同日第二条口径：不与上下文数字逗号连写），所以量的是它自己
  // （按 11px 字号的样本估 50px），不再把上下文那一格整个换掉。
  "cache:full": 50,
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
  // 宽度充裕时上下文数值与命中率**同时**在（命中率是独立元素，不再替换数值档）
  "cache:full",
  "context:text",
  "effort:full",
  // model 槽位在宽度充裕时停在最高档（`提供商/模型名`），裸模型名档被它替换
  "model:provider",
  "permission:label",
  "preset:full",
  "send:full",
  "tps:full",
];

/** 上一级：除命中率外全都在（命中率是最后回来的那一档，独立性就体现在这里）。 */
const ALL_WITHOUT_CACHE = ALL.filter((key) => key !== "cache:full").sort();

// ---------- 1. 优先级表就是用户口径 ----------
//
// P0 四项 pinned（始终显示；上下文圆环 2026-10-06 起为最高优先级）；P1（思考强度/
// 附件/tps）全部排在 P2（权限文字、预设标签、上下文数值）之前；同槽位的档位 rank
// 必须递增，否则「先图标、后图标+文字」这种升级在算法里永远升不上去。
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
    ["context", "permission", "model", "send"],
    "P0（始终显示的）必须是上下文圆环、权限、模型、发送四个",
  );
  assert.ok(
    byRank.every((spec, index) => spec.rank === index),
    "rank 必须是从 0 开始的连续整数（优先级表的可读性靠它）",
  );

  const rankOf = (key: string) => BAR_ORDER.find((s) => `${s.slot}:${s.level}` === key)?.rank;
  const p1 = ["effort:full", "attach:full", "tps:full"].map(rankOf);
  const p2 = ["permission:label", "preset:full", "context:text", "model:provider", "cache:full"].map(rankOf);
  assert.ok(
    p1.every((rank) => rank !== undefined) && p2.every((rank) => rank !== undefined),
    "P1/P2 的档位都要在表里（含 agent 预设标签、模型全格式档与缓存命中率）",
  );
  for (const [tier, ranks] of [
    ["P1（思考强度 → 附件 → tps）", p1],
    ["P2（权限文字 → 预设标签 → 上下文数值 → 缓存命中率 → 模型全格式档）", p2],
  ] as [string, (number | undefined)[]][]) {
    assert.ok(
      ranks.every((rank, index) => index === 0 || (rank as number) > (ranks[index - 1] as number)),
      `${tier} 的 rank 必须按左右次序递增（同档内从左至右，用户 2026-09-22 口径）`,
    );
  }
  assert.ok(
    Math.max(...(p1 as number[])) < Math.min(...(p2 as number[])),
    "P1（思考强度/附件/tps）必须整体优先于 P2（权限文字/预设/上下文数值/命中率/模型全格式）",
  );
  // 缓存命中率是**全场最低优先级**（用户 2026-10-10 口径）：它是唯一一个「可有可无的
  // 附加读数」，宽度不够时第一个让位——所以 rank 必须是最大的那个。
  assert.strictEqual(
    rankOf("cache:full"),
    BAR_ORDER.length - 1,
    "缓存命中率必须排在最后一名（rank 最大 = 平级里最后回来、最先被挤掉）",
  );

  const perm = BAR_ORDER.filter((spec) => spec.slot === "permission").map((spec) => spec.level);
  const ctx = BAR_ORDER.filter((spec) => spec.slot === "context").map((spec) => spec.level);
  const mdl = BAR_ORDER.filter((spec) => spec.slot === "model").map((spec) => spec.level);
  const cache = BAR_ORDER.filter((spec) => spec.slot === "cache").map((spec) => spec.level);
  assert.deepStrictEqual(perm, ["icon", "label"], "权限槽位必须是「先图标、后图标+文字」");
  assert.deepStrictEqual(ctx, ["ring", "text"], "上下文槽位必须是「先环、后环+数值」（命中率不在这个槽位里）");
  assert.deepStrictEqual(mdl, ["full", "provider"], "模型槽位必须是「先模型名、后提供商+模型名」");
  // 命中率是**独立槽位**（用户 2026-10-10 第二条口径：不与上下文数字逗号连写）：
  // 它自成一项，于是「数值」与「命中率」各自进退——宽度不够时先掉命中率，数值仍留着。
  assert.deepStrictEqual(cache, ["full"], "缓存命中率必须是独立槽位（不是上下文槽位的第三档）");

  // 左右次序的**来源**：Composer 里 `{bar.槽位}` 的先后就是工具栏的左右布局
  // （`.composer-bar` 是 flex 行）。它一变，「哪一项先被挤掉」就跟着变。
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  const visual = [...composer.matchAll(/\{bar\.(\w+)\}/g)].map((match) => match[1]);
  assert.deepStrictEqual(
    visual,
    ["permission", "model", "effort", "preset", "attach", "tps", "context", "cache", "send"],
    "工具栏的渲染次序（= 从左至右）变了：同档内的优先级就是按它定的，改位置要同步改 rank（命中率必须紧跟上下文数值右边）",
  );
  assert.ok(
    /"model:provider": modelPill\(true\)/.test(composer),
    "Composer 必须把「提供商/模型名」档接进节点表（表里有档、节点表没节点 = 该档永远不渲染）",
  );
}
console.log("toolbarFit: 优先级表符合用户口径 ✓");

// ---------- 2. 宽度充裕：全部都显示（含 P2 各档） ----------
//
// 12 个档位落在 9 个槽位上（权限、上下文、模型各占一个槽位的多档，命中率自成一格），
// 所以「全显示」= 9 项，且三处都停在最高档。
{
  const shown = say(670);
  assert.deepStrictEqual(shown, ALL, `宽度充裕时应当全显示，实际 ${shown.join(" ")}`);
}
console.log("toolbarFit: 宽度充裕时全部显示 ✓");

// ---------- 3. 极窄：只剩 P0 四项（上下文圆环始终在），且不崩 ----------
{
  for (const available of [120, 0, -20]) {
    const shown = say(available);
    assert.deepStrictEqual(
      shown,
      ["context:ring", "model:full", "permission:icon", "send:full"],
      `可用宽度 ${available}px 时只应剩 P0 四项（且权限是图标档），实际 ${shown.join(" ")}`,
    );
  }
}
console.log("toolbarFit: 极窄时只剩 P0 四项（pinned 保底，含上下文圆环） ✓");

// ---------- 4. 逐级降级：每一档的临界宽度 ----------
//
// 按样本宽度算出来的阶梯（P0 四项自身 210px，每个可见槽位再吃 8px 间距）：
//   242 P0 四项（上下文圆环已含在内） → 276 +思考强度 → 306 +附件 → 358 +tps
//   → 416 权限图标升成图标+文字（换档只花差价 +58）
//   → 496 +预设标签（新开一个槽位：+72 自身 +8 间距）
//   → 542 上下文环升成环+数值（+46，同槽位只花差价）
//   → 612 模型胶囊升成 `提供商/模型名`（+70，同槽位只花差价）
//   → 670 命中率作为**独立元素**进来（+50 自身 +8 间距；**最后一档**）
// 写死这几个边界是有意的：它们同时钉住「间距计入」与「换档只花差价」两件事，
// 也钉住 P2 内部「左端的权限文字 → 中段的预设标签 → 右端的上下文数值 →
// 数值右边的命中率」这一次序（模型全格式档是 P0 胶囊的升级档，按同槽位规则排在
// 上下文数值之前）。**命中率那一级是独立槽位**：比上一级多花一个间距（用户
// 2026-10-10 第二条口径：不再与上下文数值合并成一格）。
{
  const P0 = ["context:ring", "model:full", "permission:icon", "send:full"];
  const L4 = ["effort:full", ...P0].sort();
  const L5 = ["attach:full", ...L4].sort();
  const L6 = ["tps:full", ...L5].sort();
  const L7 = ["permission:label", ...L6.filter((key) => key !== "permission:icon")].sort();
  const L8 = ["preset:full", ...L7].sort();
  // 同槽位升级是替换：上下文环换成环+数值，模型名换成提供商/模型名（命中率另开一格）
  const L9 = [...L8.filter((key) => key !== "context:ring"), "context:text"].sort();
  const L10 = ALL_WITHOUT_CACHE;
  const L11 = ALL;

  const steps: [number, string[]][] = [
    [242, P0],
    [276, L4],
    [306, L5],
    [358, L6],
    [416, L7],
    [496, L8],
    [542, L9],
    [612, L10],
    [670, L11],
  ];
  for (const [available, expected] of steps) {
    assert.deepStrictEqual(
      say(available),
      expected,
      `可用宽度 ${available}px 时的档位不对：\n期望 ${expected.join(" ")}\n实际 ${say(available).join(" ")}`,
    );
  }
  // 差一像素就差一档（宽度先向上取整再比大小，临界点上没有半像素抖动）
  assert.deepStrictEqual(say(275), P0, "275px 还放不下思考强度");
  assert.deepStrictEqual(say(415), L6, "415px 还放不下权限文字");
  assert.deepStrictEqual(say(495), L7, "495px 还放不下预设标签");
  assert.deepStrictEqual(say(541), L8, "541px 还放不下上下文数值");
  assert.deepStrictEqual(say(611), L9, "611px 还升不上模型全格式档");
  assert.deepStrictEqual(say(662), L10, "662px 还放不下命中率（它要自成一格，另吃一个间距）");
  assert.deepStrictEqual(say(669), L10, "669px 仍差一像素放不下命中率");
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
  // 一路撑到最后，三处「可升级的槽位」都必须停在最高档（命中率是独立槽位，另算一格）
  assert.strictEqual(levels.get("permission"), 7, "权限槽位最终应停在「图标+文字」档");
  assert.strictEqual(levels.get("context"), 9, "上下文槽位最终应停在「环+数值」档");
  assert.strictEqual(levels.get("model"), 10, "模型槽位最终应停在「提供商/模型名」档");
  assert.strictEqual(levels.get("cache"), 11, "命中率槽位最终应停在它唯一那一档（全场最低优先级）");
}
console.log("toolbarFit: 逐级降级 + 宽度变大只进不出 ✓");

// ---------- 5. 同槽位互斥：不会同时出现两档 ----------
{
  for (let available = 700; available >= 0; available -= 1) {
    const shown = say(available);
    for (const slot of ["permission", "context", "model"]) {
      const hits = shown.filter((key) => key.startsWith(`${slot}:`));
      assert.ok(hits.length <= 1, `宽度 ${available}px 时 ${slot} 槽位选了 ${hits.join(" + ")}`);
    }
  }
}
console.log("toolbarFit: 同槽位档位互斥 ✓");

// ---------- 6. 间距要计入（每个可见元素吃掉一个 gap） ----------
//
// P0 四项自身 = 210px；gap 8 时还要 4×8 = 242px 才排得下（含最右侧 spacer 前那一处）。
// 少算间距的实现会在临界宽度上多塞一项，然后把模型名挤成省略号。
{
  const pinnedOnly = ["context:ring", "model:full", "permission:icon", "send:full"];
  assert.deepStrictEqual(say(242), pinnedOnly, "gap 计入后 P0 恰好占满 242px");
  assert.deepStrictEqual(
    say(242, 0),
    ["effort:full", ...pinnedOnly].sort(),
    "同样这 242px，间距为 0 时应当能多放一档——说明 gap 确实参与计算",
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

// ---------- 8. 量不到盒时不结算；极窄但有盒仍按前缀折叠 ----------
//
// 「这一帧能不能结算」的判据是**盒在不在**，不是「宽度够不够」。两个方向都要钉住：
//
// - **没有盒**：宿主把整个 webview 隐藏起来时（用户切到别的 VS Code 标签或侧栏视图），
//   文档视口还留着原宽度，但内层每一枚元素都没有布局盒——真浏览器实测 `body` / `.app` /
//   `.composer` / `.composer-bar` 的 `clientWidth` 全是 0、`getClientRects()` 全为空。
//   此时 `clientWidth - 内边距` 会算出负值（0 - 16），拿它分配就把工具栏锁成最窄那一套；
//   而恢复显示时如果没有任何组件重渲染，用户看到的就是「明明够宽却最窄，动一下尺寸才恢复」。
// - **有盒但极窄**：内容盒塌到 0、甚至内边距比盒还宽（available 为负）都是**有效答案**，
//   必须照常按前缀规则折叠成 P0。轨迹页那种 `visibility: hidden` 的让位也仍然有盒
//   （实测宽度不变），测量照旧有效——所以不能用「宽度小于某个阈值」代替盒判据。
{
  const base = { isConnected: true, hasBox: true, clientWidth: 400, padLeft: 8, padRight: 8 };
  assert.strictEqual(
    toolbarAvailableWidth(base),
    384,
    "正常一帧：可用宽度 = clientWidth（内边距盒）减去左右内边距（内容盒）",
  );
  assert.strictEqual(
    toolbarAvailableWidth({ ...base, hasBox: false, clientWidth: 0 }),
    undefined,
    "没有布局盒时不结算（宿主隐藏整个 webview 就是这一档）",
  );
  assert.strictEqual(
    toolbarAvailableWidth({ ...base, isConnected: false, hasBox: false, clientWidth: 0 }),
    undefined,
    "节点已断开时不结算",
  );
  assert.strictEqual(
    toolbarAvailableWidth({ ...base, clientWidth: 0 }),
    undefined,
    "零宽盒（有盒也没得排）同样不结算",
  );
  assert.strictEqual(
    toolbarAvailableWidth({ ...base, hasBox: false }),
    undefined,
    "没有盒就不结算——哪怕 clientWidth 还留着旧值",
  );

  const P0 = ["context:ring", "model:full", "permission:icon", "send:full"];
  const collapsed = toolbarAvailableWidth({ ...base, clientWidth: 40, padLeft: 20, padRight: 20 });
  assert.strictEqual(collapsed, 0, "有盒但内容盒塌成 0：这仍是一个有效答案，不是「量不出来」");
  const negative = toolbarAvailableWidth({ ...base, clientWidth: 10, padLeft: 40, padRight: 40 });
  assert.strictEqual(negative, -70, "有盒时允许算出负数（内边距比盒还宽）");
  assert.deepStrictEqual(say(collapsed as number), P0, "内容盒 0：按前缀规则折叠成 P0 四件");
  assert.deepStrictEqual(say(negative as number), P0, "可用宽度为负同样折叠成 P0，而不是跳过不结算");
}
console.log("toolbarFit: 量不到盒不结算、极窄但有盒仍折叠 ✓");

// ---------- 9. 观察者随节点走（节点被替换后仍然盯新那一枚） ----------
//
// 缺陷（旧写法，实测于真浏览器）：`useEffect(..., [barRef, fit])` 里
// `observer.observe(barRef.current)`。两个依赖（ref 对象与 `useCallback` 的 fit）恒稳定，
// 于是只在**挂载**时挂一次；`.composer-bar` 被条件渲染换掉之后（只读子代理会话那一支渲染
// `div.composer-readonly`，与 `div.composer-shell` 是同类型 div，React 复用外层 div、只换
// 子树，`.composer-bar` 因此是新元素），新节点**没有任何观察者**——实测此时只改工具栏自身
// 的可用宽度，档位不再重算，恢复只能靠别的组件恰好重渲染。
//
// 这里用假观察者（`FitObserver` 只需 observe/disconnect 两面）把生命周期钉住；
// 真 DOM 接线（callback ref 挂在 `.composer-bar` 上、effect 里重挂并 dispose）由末尾的
// 源码判据与真浏览器回路共同覆盖。
{
  /** 假观察者：只记「谁在被我观察」，断开即清空（断开之后不再投递）。 */
  class FakeObserver implements FitObserver {
    static readonly live = new Set<FakeObserver>();
    readonly targets = new Set<Element>();
    constructor(private readonly callback: () => void) {
      FakeObserver.live.add(this);
    }
    observe(target: Element): void {
      this.targets.add(target);
    }
    disconnect(): void {
      this.targets.clear();
      FakeObserver.live.delete(this);
    }
    /** 浏览器投递：只有还在观察这个目标时才会回调。 */
    deliver(target: Element): void {
      if (this.targets.has(target)) this.callback();
    }
  }
  const observing = (target: Element) =>
    [...FakeObserver.live].filter((observer) => observer.targets.has(target)).length;

  const nodeA = { tag: "旧节点" } as unknown as HTMLElement;
  const nodeB = { tag: "新节点" } as unknown as HTMLElement;
  let settled = 0;
  const synced: (HTMLElement | null)[] = [];
  const anchor = createFitAnchor(
    () => {
      settled += 1;
    },
    (node) => synced.push(node),
    (callback) => new FakeObserver(callback),
  );

  anchor.attach(nodeA);
  assert.deepStrictEqual(synced, [nodeA], "callback ref 收到节点时要同步给调用方（fit 读它）");
  assert.strictEqual(observing(nodeA), 1, "当前节点上恰好一枚观察者");

  // effect 的 setup 会再 attach 一次当前节点（StrictMode 口径），同一枚节点必须幂等
  anchor.attach(nodeA);
  assert.strictEqual(observing(nodeA), 1, "同一枚节点重复 attach 不许多挂一枚（不留重复监听）");
  assert.strictEqual(synced.length, 1, "幂等的那一次不重复同步节点");
  const liveA = [...FakeObserver.live].find((observer) => observer.targets.has(nodeA));
  liveA?.deliver(nodeA);
  assert.strictEqual(settled, 1, "节点宽度变了（观察者投递）要重量一次");

  // 旧节点卸载：ref 收到 null
  anchor.attach(null);
  assert.strictEqual(observing(nodeA), 0, "旧节点卸载后必须断开");
  assert.deepStrictEqual(synced, [nodeA, null], "null 也要同步给调用方");
  liveA?.deliver(nodeA);
  assert.strictEqual(settled, 1, "断开之后旧节点再投递不许再结算");

  // 节点被条件渲染换成新元素（只读子代理会话往返）：新那一枚必须有人盯
  anchor.attach(nodeB);
  assert.strictEqual(observing(nodeB), 1, "新节点必须被观察（旧写法在这里是 0：缺陷本身）");
  assert.strictEqual(observing(nodeA), 0, "旧节点不许还挂在谁身上");
  const liveB = [...FakeObserver.live].find((observer) => observer.targets.has(nodeB));
  liveB?.deliver(nodeB);
  assert.strictEqual(settled, 2, "新节点上的投递同样要重量（工具栏继续跟随自身宽度）");

  // 负对照：旧写法的形状（挂载时 observe 一次、之后不重挂）在换节点后还停在旧节点上
  {
    const created: FakeObserver[] = [];
    let mounted: FakeObserver | null = null;
    const legacyObserveAtMount = (node: Element) => {
      if (mounted) return;
      mounted = new FakeObserver(() => {});
      created.push(mounted);
      mounted.observe(node);
    };
    legacyObserveAtMount(nodeA);
    legacyObserveAtMount(nodeB); // 换成新节点，旧 effect 不会重跑
    assert.strictEqual(created.length, 1, "旧写法只会在挂载时造一枚观察者");
    assert.ok(created[0]!.targets.has(nodeA), "旧写法的那一枚还停在旧节点上");
    assert.ok(!created[0]!.targets.has(nodeB), "旧写法：换节点后没有人盯新节点（这条就是修复前实测到的缺陷）");
    created[0]!.disconnect();
  }

  // React 18 的 StrictMode：挂载 → 清理 → 再挂载；cleanup 断掉观察者后，setup 必须重挂
  anchor.dispose();
  assert.strictEqual(observing(nodeB), 0, "cleanup 之后不该留下观察者");
  anchor.attach(nodeB);
  assert.strictEqual(observing(nodeB), 1, "StrictMode 的再挂载之后仍然（且只有）一枚观察者");
  const reattached = [...FakeObserver.live].find((observer) => observer.targets.has(nodeB));
  reattached?.deliver(nodeB);
  assert.strictEqual(settled, 3, "再挂载之后投递照旧重量");

  anchor.dispose();
  anchor.dispose();
  assert.strictEqual(FakeObserver.live.size, 0, "dispose 幂等，且不留残观察者");
}

// 真 DOM 接线：真浏览器回路（`.agent` 下的 iframe 壳子 + Playwright）验的是行为，
// 这里钉住把两端接起来的几处写法——只有 helper 绿、调用点没接上同样是缺陷。
{
  const composer = readFileSync(join(process.cwd(), "src", "webview", "components", "Composer.tsx"), "utf8");
  assert.ok(
    /hasBox: bar\.getClientRects\(\)\.length > 0/.test(composer),
    "Composer 必须把「有没有布局盒」交给 toolbarAvailableWidth（不能用宽度阈值代替）",
  );
  assert.ok(
    /if \(available === undefined\) return;/.test(composer),
    "量不到盒时 fit 必须直接返回（保留上一次有效档位），不能拿负的可用宽度去分配",
  );
  assert.ok(
    /const \{ shown, register, attachBar \} = useToolbarFit\(barVariants\);/.test(composer),
    "hook 必须把 callback ref 交出来（节点身份与观察者一起走）",
  );
  assert.ok(
    /className="composer-bar" ref=\{attachBar\}/.test(composer),
    "`.composer-bar` 必须挂那个 callback ref，而不是裸 ref 对象（裸 ref 只写 current，没人管观察者）",
  );
  assert.ok(
    /anchor\.attach\(barRef\.current\)/.test(composer) && /return \(\) => anchor\.dispose\(\);/.test(composer),
    "effect 的 setup 要按当前节点重挂、cleanup 要断开（StrictMode 也要有效）",
  );
  assert.ok(
    !/observer\.observe\(bar\)/.test(composer),
    "旧的「挂载时 observe 一次、之后不重挂」写法必须不复存在（节点被替换后再也没人观察）",
  );
}
console.log("toolbarFit: 观察者随节点走 + 真 DOM 接线 ✓");

console.log("\ntoolbarFit: all assertions passed");
