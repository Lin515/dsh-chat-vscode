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

  // 组件里鲸鱼运行与结束两态都必须保留 .icon-brand（品牌蓝）：
  // 裸 <IconDsh /> 落回 .row-icon 的灰色；裸 .icon-glow 也不行——该类已不带颜色
  // （呼吸光色改由图标自己的颜色决定，见下方 4c/4b）
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /streaming\s*\?\s*"icon-glow icon-brand"\s*:\s*"icon-brand"/.test(rows),
    "ThinkingRow 的鲸鱼必须恒带 .icon-brand（品牌蓝）；裸 <IconDsh /> 会变灰，裸 .icon-glow 现在无色",
  );
}
console.log("styles: 思考结束后的鲸鱼仍为蓝色 ✓");

// ---------- 4b. 运行中的节点呼吸发光颜色必须跟随节点自己的颜色 ----------
//
// 用户要求：正在执行的节点要有呼吸灯式发光，且**光色与图标颜色同步**；
// 完成态保持彩色图标（不落回灰）。断言钉组件层面：ToolRow / CommandRow
// 运行中给行首图标挂 `.icon-glow <节点色类>`，结束态也带节点色类
// （裸图标 = .row-icon 的灰色）；「运行中」不再用小圆点。
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /running\s*\?\s*\(\s*<span className=\{`icon-glow \$\{iconClass\}`\}>\{icon\}<\/span>/.test(rows),
    "ToolRow 行首图标运行中必须挂 .icon-glow + 节点色类（同色呼吸发光）——不能只有静态灰图标",
  );
  assert.ok(
    /<span className="icon-glow node-command">\s*<IconSlash size=\{13\} \/>/.test(rows),
    "CommandRow 行首图标运行中同样要挂 .icon-glow（带命令色）",
  );
  assert.ok(
    /:\s*\(\s*<span className=\{iconClass\}>\{icon\}<\/span>/.test(rows),
    "ToolRow 完成态行首图标必须保留节点色类（.node-*）——裸图标会落回 .row-icon 的灰",
  );
  assert.ok(
    !/tone=\{[^}]*"running"/.test(rows),
    "「运行中」状态不该再用 dot-running 小圆点——呼吸灯在图标级",
  );
}
console.log("styles: 运行中节点呼吸发光与图标同色、完成态保色 ✓");

// ---------- 4c. 鲸鱼的品牌蓝是独属色：其它节点色不得用它 ----------
//
// 用户要求：思考鲸鱼的蓝色是它的辨识度，其它图标不得用同一色。
// tokens.css 里所有 --node-* 的定义不得引用 charts-blue / --info；
// app.css 里每种节点（含命令与注入）都必有专属色类。
{
  const tokens = readFileSync(
    join(process.cwd(), "src", "webview", "styles", "tokens.css"),
    "utf8",
  );
  const nodeTokens = tokens.match(/--node-\w+\s*:\s*[^;]+/g) ?? [];
  assert.ok(
    nodeTokens.length >= 9,
    `tokens.css 至少定义 9 个 --node-* 节点色（现在是 ${nodeTokens.length} 个）`,
  );
  for (const def of nodeTokens) {
    assert.ok(
      !/charts-blue|var\(--info\)/.test(def),
      `节点色 ${def.trim()} 不得用鲸鱼独属的蓝（charts-blue / --info）`,
    );
  }
  for (const node of ["search", "read", "bash", "write", "edit", "code", "others", "command", "injected"]) {
    assert.ok(
      new RegExp(`\\.node-${node}\\s*\\{[^}]*color:\\s*var\\(--node-${node}\\)`).test(css),
      `app.css 缺少 .node-${node} 的颜色规则（或没引用 --node-${node}）`,
    );
  }
}
console.log("styles: 鲸鱼蓝色独属、各节点有专属色 ✓");

// ---------- 5. 候选行：主文字完整优先，宽度不够先省描述 ----------
//
// 用户口径：「命令列表应当将命令显示完整，如果宽度不够则应去省略描述」。
// 改前两段文字按 flex-shrink 比例一起收缩，窄侧栏下实测 `/transfer-read` 的
// 名字框只剩 26px（渲染成 `/tr…`），而描述还占着 131px——主次反了。
// 现在主文字 flex-shrink: 0，收缩只由描述承担；这组断言钉住这个方向。
{
  const name = rule(".popover-item-main.is-priority");
  assert.ok(
    /flex:\s*0\s+0\s/.test(name),
    `.popover-item-main.is-priority 必须是 flex: 0 0 auto（不收缩、不抢空白），现在是 "${name.trim()}"`,
  );

  const sub = rule(".popover-item-sub");
  assert.ok(
    !/flex-shrink:\s*0/.test(sub),
    ".popover-item-sub 不能设 flex-shrink: 0——它是行里唯一能给主文字让位的一方",
  );
  // 描述必须能被压到 0：要么 min-width: 0，要么 overflow: hidden（后者按 flex 规范
  // 让自动最小尺寸为 0）。两条都没有时它会挡在内容宽度上，主文字又被挤没。
  assert.ok(
    /min-width:\s*0/.test(sub) || /overflow:\s*hidden/.test(sub),
    ".popover-item-sub 必须允许收缩到 0（min-width: 0 或 overflow: hidden）——" +
      "否则它不让位，收缩会重新落到主文字上",
  );

  // 组件里两处主文字必须真的挂上标记：
  //   - 命令名（挂到文件路径上会让长路径撑破弹层，所以按 isCommand 区分）；
  //   - 权限档位名（英文 Read Only / Workspace Write 曾被长描述挤成 `Read O…`）。
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /isCommand \? " is-priority" : ""/.test(composer),
    "Composer 的候选行必须按 isCommand 给命令名加 .is-priority（文件路径不加）",
  );
  assert.ok(
    /popover-item-main is-priority">\{item\.label\}/.test(composer),
    "权限弹层的档位名也要 .is-priority（否则英文长描述会把档位名挤成 `Read O…`）",
  );
}
console.log("styles: 主文字优先完整、描述先省略 ✓");

// ---------- 6. 行号必须贴着文件名，不能飘到行尾 ----------
//
// 用户 2026-09-12 反馈「行号还是没有紧跟在文件名后面，一直靠右」：
// `.row-detail` 当时是 `flex: 1 1 0`，吃掉整行剩余空间 → 它后面的行号
// （`.row-detail-suffix`）被顶到行尾。实测（预览页 420px）：文件名结束于 x=191、
// 行号起于 x=289，中间空了 98px。现在行号是 `.row-detail` **内部**的最后一段，
// 块内无 gap，挨裁的只有目录段。
{
  const detail = rule(".row-detail");
  assert.ok(
    /flex:\s*0\s+1\s/.test(detail),
    `.row-detail 不能吃剩余空间（现在是 "${detail.trim()}" 里的 flex）——` +
      "一旦写成 `flex: 1 1 …`，行号又会被推到行尾，回到用户报的那个 bug",
  );

  const suffix = rule(".row-detail-suffix");
  assert.ok(
    /flex:\s*0\s+0\s/.test(suffix),
    ".row-detail-suffix 不参与压缩（它是要紧的行号区间）",
  );

  // 尾部 meta（时长）必须**先让位**：靠 margin-left: auto 顶到行尾，
  // 收缩权重远大于 detail；否则缺口按比例摊到 detail，行号会被 overflow 裁掉半截。
  const meta = rule(".row-meta");
  assert.ok(/margin-left:\s*auto/.test(meta), ".row-meta 要用 margin-left: auto 顶到行尾");
  const shrink = Number(/flex:\s*0\s+(\d+)/.exec(meta)?.[1] ?? "0");
  assert.ok(
    shrink >= 100,
    `.row-meta 的收缩权重必须远大于 detail 的 1（现在是 ${shrink}）——` +
      "空间不够时要先丢时长，不能去裁文件名和行号",
  );

  // 组件结构：行号必须渲染在 .row-detail **内部**（在文件名之后），
  // 放外面就又会隔着 .row-head 的 gap 被推开。
  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  const inner =
    /<span className="row-detail-name">\{parts\.name\}<\/span>\s*\{detailSuffix \? <span className="row-detail-suffix">/.test(
      primitives,
    );
  assert.ok(inner, "primitives 的 Row 必须把 detailSuffix 渲染在 .row-detail 内部、紧跟文件名之后");
  assert.ok(
    !/\{detailSuffix \? <span className="row-detail-suffix">\{detailSuffix\}<\/span> : null\}\s*\n\s*\{meta \?/.test(
      primitives,
    ),
    "detailSuffix 不该再作为 .row-detail 的兄弟节点出现（那会飘到行尾）",
  );
}
console.log("styles: 行号紧跟文件名、时长先让位 ✓");

console.log("\nstyles: all assertions passed");
