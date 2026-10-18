/**
 * 样式不变量：这些约束靠肉眼很难在每次改动后复查，但破坏后果明显。
 *
 * 都在 `app.css` 上做文本断言。CSS 的**布局结果**没法在无头环境里测，
 * 但「某个关键声明还在不在」是稳定可查的——而这正是回归发生的地方。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrajectoryCell, TrajectoryTurn } from "../src/shared/trajectory";
import { trajectoryLedgerRows } from "../src/webview/trajectoryLedgerRows";
import { dictionaryFor } from "../src/webview/texts";
import { lineThickness } from "../src/webview/uiScale";

const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");

/** 取出一个选择器的声明块（第一个匹配）。 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
  assert.ok(match, `app.css 里找不到选择器 ${selector}`);
  return match[1];
}

/**
 * 设计像素的两种合法写法：`calc(N * var(--dp))`（倍率下的写法）与裸 `Npx`。
 * 尺度一律走设计像素，见 `docs/design-ui-scale.md`。
 */
const DESIGN_PX = String.raw`(?:calc\(\s*-?\d+(?:\.\d+)?\s*\*\s*var\(--dp\)\s*\)|-?\d+(?:\.\d+)?px)`;

/** 取出设计像素的**数值**：`calc(13 * var(--dp))` / `13px` → 13。断言钉的是设计值。 */
function designPx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const calc = /^calc\(\s*(-?\d+(?:\.\d+)?)\s*\*\s*var\(--dp\)\s*\)$/u.exec(value.trim());
  if (calc) return Number(calc[1]);
  const raw = /^(-?\d+(?:\.\d+)?)px$/u.exec(value.trim());
  return raw ? Number(raw[1]) : undefined;
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

// ---------- 1b. `/` `@` 候选弹层：滚的只有列表那一层，底部提示栏常驻 ----------
//
// 用户 2026-09-25 口径：键位提示要单独一栏、始终显示，不许跟着候选列表滚
// （原来是列表里的最后一行，候选一多就得滑到底才看得见）。
// 结构上提示栏是列表的兄弟节点（见 `composerCompletion.tsx`），样式上由这两条保证：
// 外框不滚、滚的是内层列表，而提示栏不参与收缩。
{
  const shell = rule(".trigger-popover");
  assert.ok(
    /overflow:\s*hidden/.test(shell),
    ".trigger-popover 自己不许滚（滚动要留给 .popover-list）——外框一滚，提示栏就跟着列表走了",
  );
  assert.ok(
    /display:\s*flex/.test(shell) && /flex-direction:\s*column/.test(shell),
    ".trigger-popover 要按竖排 flex 分配「列表 + 提示栏」两行的高度",
  );

  const list = rule(".trigger-popover .popover-list");
  assert.ok(/overflow-y:\s*auto/.test(list), "候选列表那一层才是滚动容器（overflow-y: auto）");
  assert.ok(
    /min-height:\s*0/.test(list),
    ".popover-list 必须 min-height: 0——否则候选一多就按内容高度把外框顶开，提示栏被挤出 max-height",
  );
  assert.ok(/flex:\s*1\s+1/.test(list), ".popover-list 吃掉外框剩余高度（提示栏在上面那两条约束下不被压缩）");

  const hint = rule(".popover-hint");
  assert.ok(
    /flex:\s*0\s+0/.test(hint),
    ".popover-hint 必须 flex: 0 0 auto（不参与收缩），否则列表一长就把提示栏压没",
  );
}
console.log("styles: 候选弹层的提示栏常驻（滚动只归列表） ✓");

// ---------- 1c. 候选行的高亮不许画到行盒之外（鼠标扫过的残影） ----------
//
// 用户 2026-10-10 报「鼠标在 @ 列表里移动会留下项目之间的分割残影」。截图逐格采样：
// 被描过的行各在**上边缘**留一条 1px 亮线（R68 G68 B69），间隔恰好 32px = 行距，当前
// 高亮行底色 R68 G67 B68 —— 细线与高亮同色，所以它不是分隔符而是高亮的旧像素。
// 落点就是原先那条 `border: 1px solid transparent`：`background-clip` 初始值 border-box，
// 高亮会连这 1px 透明边框一起涂满；透明边框自己不绘制，取消高亮时就留下没有归属的 1px。
// 修法是把这 1px 折进内边距，让行盒 = 高亮背景矩形。这三条断言钉住「不许回到那个写法」，
// 并且折进去之后几何必须与改前等价（否则行高会少 2px）。
{
  const item = rule(".popover-item");
  const border = /(?:^|[\s;])border(?:-(?:top|right|bottom|left|width|style|color))?\s*:\s*([^;]+);/.exec(
    item,
  )?.[1]?.trim();
  assert.ok(
    border === undefined || /^(?:none|0)$/.test(border),
    `候选行不许带占位或着色的边框（透明边框会被高亮背景涂满，取消高亮时留下 1px 残影），` +
      `现在是 "border: ${border}"：\n${item.trim()}`,
  );
  const padding = /(?:^|[\s;])padding\s*:\s*([^;]+);/.exec(item)?.[1]?.trim();
  assert.deepStrictEqual(
    // 值里带空格（`calc(5 * var(--dp))`），所以按公式整体匹配，不能按空白切
    padding ? [...padding.matchAll(new RegExp(DESIGN_PX, "g"))].map((match) => designPx(match[0])) : undefined,
    [5, 7],
    `候选行的内边距要把原来那 1px 透明边框折进去（竖 5 / 横 7 个设计像素），现在是 "${padding}"` +
      "——少了这 1px，行高与内容宽度都会比改前小 2px（视觉变更）",
  );

  const list = rule(".trigger-popover .popover-list");
  assert.ok(
    /contain:\s*paint/.test(list),
    "滚动列表要 contain: paint（绘制边界清帧）：否则越出行盒的上一帧像素会留在画布上（残影的第二条通路）",
  );
}
console.log("styles: 候选行高亮不越出行盒（消残影）+ 滚动层自清帧 ✓");

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

// ---------- 3b. 几个活性指示器在「减少动画」下必须同等对待 ----------
//
// 真实 bug：@media (prefers-reduced-motion) 里只列了 .dot-running 而漏了 .icon-glow，
// 于是开启「减少动画」的系统上出现「思考鲸鱼在呼吸、执行圆点纹丝不动」——
// 用户合理地以为任务卡死了。这属于两者的**待遇不一致**，而不是抑制与不抑制的选择，
// 所以断言写成「要么都在名单里，要么都不在」，任一种都比现在这种好。
// 2026-09-20 加入第三个同类指示器：面板入口的呼吸（`.icon-btn.is-busy`）。
{
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(reduced, "应当存在 prefers-reduced-motion 媒体查询");

  const body = reduced[1];
  const hasDot = /\.dot-running/.test(body);
  const hasGlow = /\.icon-glow/.test(body);
  // 面板入口的呼吸（`.icon-btn.is-busy`）是**第三个**同类指示器：同样不许被抑制
  const hasBusy = /\.icon-btn\.is-busy/.test(body);
  assert.strictEqual(
    hasDot,
    hasGlow,
    `\`.dot-running\` 与 \`.icon-glow\` 必须在减少动画时同等对待，` +
      `现在是 圆点${hasDot ? "被抑制" : "保留"}、鲸鱼${hasGlow ? "被抑制" : "保留"}：\n${body.trim()}`,
  );
  assert.strictEqual(
    hasBusy,
    false,
    "面板入口的呼吸（.icon-btn.is-busy）不能被「减少动画」抑制——它也是「还在跑」的功能性信号",
  );
}
console.log("styles: 减少动画下几个活性指示器待遇一致 ✓");

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
//
// 用户 2026-09-12 追加：执行完毕的一瞬间图标会「小挪动」一下。根因是两态的
// **盒子不同**——`.icon-glow` 自带 `display: inline-flex`（13px 盒子），而完成态
// 的内层 span 是普通 inline（16px 行盒、SVG 沿基线摆），实测向上跳 1.5px。
// 现在两态都由 `.node-icon` 提供 inline-flex，断言同时钉住这件事。
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /<span className=\{`node-icon \$\{iconClass\}\$\{running \? " icon-glow" : ""\}`\}>\{icon\}<\/span>/.test(
      rows,
    ),
    "ToolRow 行首图标必须恒带 .node-icon（两态同一盒子），运行中再叠 .icon-glow + 节点色类",
  );
  assert.ok(
    /<span className=\{`node-icon node-command\$\{command\.state === "running" \? " icon-glow" : ""\}`\}>/.test(
      rows,
    ),
    "CommandRow 行首图标同样恒带 .node-icon，运行中叠 .icon-glow（带命令色）",
  );
  assert.ok(
    !/tone=\{[^}]*"running"/.test(rows),
    "「运行中」状态不该再用 dot-running 小圆点——呼吸灯在图标级",
  );

  // 两态的盒子必须由同一个类提供布局：`.icon-glow` 只负责动画，不再改 display
  const nodeIcon = rule(".node-icon");
  assert.ok(
    /display:\s*inline-flex/.test(nodeIcon),
    ".node-icon 必须是 display: inline-flex——否则完成态落回行盒，图标会跳 1.5px",
  );

  // 出错 / 被中止时行首换成 7px 圆点：坑位宽度要与图标一致（13px），
  // 否则节点名横向跳 6px（实测 61 → 55）——同一类「两态盒子不同」的问题
  const status = rule(".row-icon-status");
  assert.strictEqual(
    designPx(/min-width:\s*([^;]+);/.exec(status)?.[1]),
    13,
    `.row-icon-status 的坑位必须与图标同宽（13 个设计像素），现在是 "${status.trim()}"`,
  );
  assert.ok(
    /<span className="row-icon row-icon-status">\s*<span className=\{`dot dot-\$\{tone\}`\} \/>/.test(
      readFileSync(join(process.cwd(), "src", "webview", "components", "primitives.tsx"), "utf8"),
    ),
    "Row 的状态点必须渲染在与图标同宽的坑位里（.row-icon-status）",
  );
}
console.log("styles: 运行中节点呼吸发光与图标同色、完成态保色 ✓");

// ---------- 4d. 面板入口的「有东西在跑」态与标题旁的子代理导航 ----------
//
// 用户 2026-09-19 口径：有子代理 / 后台任务在跑时，右上角那两颗按钮要亮起来并呼吸。
// 判据与接线在 `scripts/activity.test.ts`；这里只钉样式本身，避免下次有人另写一套
// 关键帧（呼吸节奏不一致比不呼吸更难发现）。
{
  const busy = rule(".icon-btn.is-busy > svg");
  assert.ok(/animation:\s*icon-glow/.test(busy), ".icon-btn.is-busy 必须复用 icon-glow 关键帧");

  // 标题旁导航的目录行：状态点**独享一格**，格内水平垂直居中（用户同日口径；
  // 行的 gap 只有 8px，没有这一格的话点会贴在标题上）
  const rowState = rule(".subagent-row-state");
  assert.ok(/align-items:\s*center/.test(rowState), ".subagent-row-state 里圆点垂直居中");
  assert.ok(/justify-content:\s*center/.test(rowState), ".subagent-row-state 里圆点水平居中");
  assert.ok(
    new RegExp(`width:\\s*${DESIGN_PX}`).test(rowState),
    ".subagent-row-state 要有明确的边长（独享空间）",
  );

  // 导航本体要存在（可点的主会话标题 / 触发器 / 弹出列表 / 只读说明）
  for (const selector of [
    "button.header-title",
    ".subagent-nav",
    ".subagent-trigger",
    ".subagent-menu",
    ".subagent-row",
    ".composer-readonly",
  ]) {
    assert.ok(css.indexOf(selector) >= 0, `app.css 必须有 ${selector}（标题旁导航与只读说明的样式）`);
  }
  // 触发器的 chevron 要有开合旋转（官方 .triggerOpen 同款）
  const chevron = rule(".subagent-trigger > svg.is-open");
  assert.ok(/transform:\s*rotate/.test(chevron), ".subagent-trigger 的 chevron 开合要旋转（官方 triggerOpen）");
}
console.log("styles: 面板入口的活性态与子代理导航样式 ✓");

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
  //   - 命令名、对话标题（挂到文件路径上会让长路径撑破弹层，所以按 isCommand /
  //     isSession 区分）；
  //   - 「..」那行（它就是两个字符，绝不能被右侧的说明挤没）；
  //   - 权限档位名（英文 Read Only / Workspace Write 曾被长描述挤成 `Read O…`）。
  //
  // 候选行的形状现在由 `composerCompletion.tsx` 的 `candidateRows` 算出（`.is-priority`
  // 也在那个 module 的 JSX 里），所以这一条改读那个文件；权限档位名仍在本组件。
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  const completion = readFileSync(
    join(process.cwd(), "src", "webview", "composerCompletion.tsx"),
    "utf8",
  );
  assert.ok(
    /isCommand \|\| isParent \|\| isSession/.test(completion) &&
      /shape\.priority \? " is-priority" : ""/.test(completion),
    "候选行必须按 isCommand / isParent / isSession 加 .is-priority（普通文件路径不加）",
  );
  // 鼠标两个入口必须分工（用户 2026-09-21 口径）：**点行主体**按 `clickAction`
  // （目录 = 进目录），**尾部「整个目录」按钮**固定 `pick`。两处都写 `pick` 时
  // 那枚按钮就是多余的，用户报的正是这个；两处都写 `clickAction` 则键盘之外的
  // 「选中整个目录」会整个消失。判据在 `scripts/mentionNav.test.ts`（真调 `clickAction`），
  // 这里只钉接线。
  assert.ok(
    /applyCandidate\(index, clickAction\(shape\)\)/.test(completion),
    "点行主体必须走 clickAction(shape)：目录进目录、其余选中",
  );
  assert.ok(
    /onMouseDown=\{\(event\) => \{\s*\n\s*event\.preventDefault\(\);\s*\n\s*applyCandidate\(index, "pick"\);/.test(completion),
    "尾部「整个目录」按钮必须仍是 pick（鼠标唯一「选中整个目录」的入口）",
  );
  assert.ok(
    /popover-item-main is-priority">\s*\{item\.label\}/.test(composer),
    "权限弹层的档位名也要 .is-priority（否则英文长描述会把档位名挤成 `Read O…`）",
  );

  // 实验档（Auto review）的确认卡：官方 `RiskConfirmation` 要求**先勾选**才能点确认，
  // 而勾选项与「确认按钮的可用性」是两处接线——只加一处就会出现「勾了没反应」或
  // 「没勾也能开」这种假门。这里钉住两者都在，且判据读的是同一个勾选态。
  const ack = rule(".confirm-ack");
  assert.ok(
    /align-items:\s*flex-start/.test(ack),
    `.confirm-ack 的勾选框要对齐首行（长文案换行时不能飘到中间），现在是 "${ack.trim()}"`,
  );
  assert.ok(
    /<input[\s\S]{0,200}checked=\{acknowledged\}/.test(composer) &&
      /disabled=\{confirmCard\.acknowledge !== undefined && !acknowledged\}/.test(composer),
    "Auto review 的确认按钮必须由勾选态把关（未勾选时 disabled），否则那道警告只是摆设",
  );
  assert.ok(
    /const \[acknowledged, setAcknowledged\] = useState\(false\)/.test(composer),
    "勾选态要显式复位（换档位/关弹层时清零），不能靠输入框自己记住",
  );

  // 实验标记（`EXP`）是**标记**不是文字：官方在 13px 的档位名旁边用 8px（比它自己最小的
  // 文本档还小两档）。用 2xs 时它与描述文字同样大，看起来像档位名的一部分（用户 2026-09-26
  // 报「有点太大」）。这里钉住它**显式算过**、不是直接取 2xs。
  const badge = rule(".perm-badge");
  assert.ok(
    /font-size:[^;]*calc\(/.test(badge) && !/font-size:\s*var\(--font-size-2xs\);/.test(badge),
    `EXP 标必须明显小于档位名（现在是 "${badge.trim()}"）——取 2xs 会与描述文字一样大`,
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
  // 文件名本身有两种形态（可点链接 / 纯文本，见工具行的 fileLink 对齐），
  // 所以断言钉的是「文件名那一块之后紧跟 detailSuffix、且都在 .row-detail 里」。
  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  const detailBlock = /<span className="row-detail" title=\{detail\}>([\s\S]*?)<\/span>\s*\) : detail \?/.exec(
    primitives,
  )?.[1] ?? "";
  const inner =
    /row-detail-name[\s\S]*?<\/span>\s*\)\s*\}\s*\{detailSuffix \? <span className="row-detail-suffix">/.test(
      detailBlock,
    );
  assert.ok(
    inner,
    "primitives 的 Row 必须把 detailSuffix 渲染在 .row-detail 内部、紧跟文件名之后",
  );
  assert.ok(
    !/\{detailSuffix \? <span className="row-detail-suffix">\{detailSuffix\}<\/span> : null\}\s*\n\s*\{meta \?/.test(
      primitives,
    ),
    "detailSuffix 不该再作为 .row-detail 的兄弟节点出现（那会飘到行尾）",
  );
}
console.log("styles: 行号紧跟文件名、时长先让位 ✓");

// ---------- 7. 节点名与文件路径之间要有呼吸空间，且目录渐隐只在真被裁时出现 ----------
//
// 用户 2026-09-12：「写入、编辑等文件路径太靠左了，有一点点被节点名遮盖」。
// 两处原因：
//   a) `.row-head` 的 gap 只有 6px，路径第一个字符紧贴节点名；
//   b) `.row-detail-dir` **无条件**挂着左侧 10px 渐隐，于是短目录（`…/`、`src/`）
//      开头那一段被吃掉——它其实一个字都没被裁，渐隐在这里是假信号。
//      渐隐因此挪到 `.is-clipped`（由 primitives.tsx 量 `scrollWidth` 决定）。
{
  const detail = rule(".row-detail");
  // 这条是负数（抵消容器的内边距），断言要的是「拉开了多少」，故取绝对值
  const margin = Math.abs(designPx(/margin-left:\s*([^;]+);/.exec(detail)?.[1]) ?? 0);
  assert.ok(
    margin >= 4,
    `.row-detail 需要与节点名拉开距离（现在 margin-left: ${margin}px）——太近会像被节点名盖住`,
  );

  const dir = rule(".row-detail-dir");
  assert.ok(
    !/mask-image/.test(dir),
    ".row-detail-dir 的基础规则不能带渐隐——短目录会被无端吃掉开头一截；" +
      "渐隐只属于 .row-detail-dir.is-clipped",
  );
  const clipped = rule(".row-detail-dir.is-clipped");
  assert.ok(
    /mask-image:\s*linear-gradient\(to right/.test(clipped),
    ".row-detail-dir.is-clipped 必须有左侧渐隐（真被裁时提示「前面还有内容」）",
  );

  // 组件侧：渐隐类由实测决定，且判据必须是**文本布局宽度**而不是 scrollWidth
  // （目录段是 flex 容器，匿名 flex 项的溢出不进 scrollWidth——实测长目录
  //   文本 338px / 盒子 245px，scrollWidth 却等于 clientWidth，判据永远 false）
  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  assert.ok(
    /className=\{`row-detail-dir\$\{dirClipped \? " is-clipped" : ""\}`\}/.test(primitives),
    "Row 的目录段必须按实测结果决定是否挂 .is-clipped",
  );
  assert.ok(
    /createRange\(\)[\s\S]{0,200}?getBoundingClientRect\(\)\.width - el\.clientWidth > 1/.test(primitives),
    "useClipped 必须量文本的布局宽度（Range）而不是 scrollWidth——后者对 flex 项的溢出恒为 0",
  );
}
console.log("styles: 路径与节点名有间距、目录渐隐只在被裁时 ✓");

// ---------- 8. 右键菜单的口径**只有一处**：全局接管（`webview/contextMenu.ts`） ----------
//
// 用户 2026-09-12 最初只要求「历史对话里不要那个没用的右键菜单」；2026-09-23 这条
// 升级成全局的：整个界面一律拦掉原生菜单，只有「右键压在自己选中的文字上」才放行
// （正文 / 图片另有特化菜单）。于是抽屉**不再自己挂** `onContextMenu`——留着就是
// 第二条口径，它会连「选中会话标题 → 右键复制」一起吃掉，两处判据还会各自漂。
{
  const history = readFileSync(
    join(process.cwd(), "src", "webview", "components", "History.tsx"),
    "utf8",
  );
  assert.ok(
    !/blockContextMenu/.test(history),
    "History 不该再自己屏蔽右键（判据全在 contextMenu.ts；留着会吃掉「选中标题 → 复制」）",
  );
  assert.ok(
    /<div className="drawer">/.test(history),
    "抽屉本体不再挂 onContextMenu",
  );
}
console.log("styles: 右键菜单口径只有全局一处（History 不留第二条） ✓");

// ---------- 8a. 历史抽屉的多选：自绘复选框、工具条压在列表下方、武装态压过 .btn:hover ----------
//
// 用户 2026-10-15 口径（顶部开关切多选 + 全选 + 归档 / 恢复 / 删除；之后又要求「多选框
// 样式不太好看，请优化」）。四条都只有看 CSS 才知道：
// ① 复选框是**自绘**的（`appearance: none` + 主题色的边框 / 填充 / 勾），不是系统那套
//    白底蓝勾——后者在深色主题下与本界面不是一种语言，尺寸也不跟 --dp 走；
// ② 勾中、禁用两个档位各有自己的样子（禁用只留淡描边空框：这两类宿主一律拒）；
// ③ 被勾中的行整行淡染（`.is-picked`）——与 `.session-item:hover` 同特异性，必须写在它
//    后面，否则鼠标一悬停就退回灰底（同 `btn-ghost` 那条按下态的坑）；
// ④ 工具条是抽屉里的一行（`border-top` 分隔线），动作按钮不被说明文字挤扁，武装后的
//    删除按钮整颗变红且压过 `.btn:hover`；
// ⑤ 勾是在方框里**居中**的（用户随后报「√ 位置不够居中」「怎么感觉还是偏左」）：靠
//    「铺满内框 + 六边形 clip-path」跟着方框的像素网格走，不能再回到「小盒子 + transform」。
{
  const checkBox = /\.session-item-check\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  assert.ok(checkBox.length > 0, "app.css 里找不到 .session-item-check（多选的复选框）");
  assert.ok(!/opacity:\s*0/.test(checkBox), "复选框是这一行的状态指示，不是悬停才浮现的图标");

  const checkInput = /\.session-item-check input\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  assert.ok(checkInput.length > 0, "app.css 里找不到 .session-item-check input");
  assert.ok(
    /appearance:\s*none/.test(checkInput) && /-webkit-appearance:\s*none/.test(checkInput),
    "复选框要自绘（appearance: none），不能留系统那套白底蓝勾",
  );
  assert.ok(
    designPx(/width:\s*([^;]+)/.exec(checkInput)?.[1]) === 14 &&
      designPx(/height:\s*([^;]+)/.exec(checkInput)?.[1]) === 14 &&
      designPx(/border-radius:\s*([^;]+)/.exec(checkInput)?.[1]) === 4,
    "方框尺寸与圆角按设计像素写（原生外观不跟 --dp，字号改了就会与行内图标不成比例）",
  );
  assert.ok(/border:\s*1px solid var\(--input-border\)/.test(checkInput), "空框用输入框那支描边色");
  assert.ok(/cursor:\s*pointer/.test(checkInput), "方框本身可点（整行也是热区，见 History 的行 onClick）");

  assert.ok(
    /\.session-item-check input:checked\s*\{([\s\S]*?)\}/.exec(css)?.[1]?.includes("var(--primary)") ?? false,
    "勾中时整颗填 --primary（与选中行同一套配色）",
  );
  const tick = /\.session-item-check input:checked::after\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  assert.ok(tick.length > 0, "勾要用 ::after 画出来（`appearance: none` 之后浏览器不再画勾）");
  // 用户 2026-10-15 口径「被选中时 √ 位置不够居中，上下左右都要居中」，以及随后的
  // 「怎么感觉还是偏左」。居中不能靠「小盒子 + margin auto + transform」：被 transform 的
  // 元素按亚像素栅格化，而方框（背景 / 边框）会吸附到整数设备像素，两者一叠加勾相对方框
  // 就会偏最多半个像素，偏向还随元素落在网格上的相位摇摆（实测字号 16px 时左右留白 3 / 4，
  // 换个侧栏宽度又变成 4 / 3）。所以勾改成「::after 铺满内框 + 六边形 clip-path 剪出来」：
  // 勾的格子跟着输入框自己的像素网格走，且不受 `border-width` 向下取整到整数设备像素的影响。
  assert.ok(
    /background:\s*var\(--primary-fg\)/.test(tick) && /clip-path:\s*polygon\(/.test(tick),
    "勾是内框大小的一层 --primary-fg + 六边形 clip-path（形状与「两条描边转 45°」等价）",
  );
  assert.ok(
    !/transform:/.test(tick) && !/border-width:/.test(tick),
    "勾不许再靠 transform 摆位：亚像素栅格化会让它相对像素对齐的方框偏半个像素（偏向还随侧栏宽度摇摆）",
  );
  assert.ok(
    ["left", "right", "top", "bottom"].every((side) =>
      new RegExp(`(?:^|;)\\s*${side}:\\s*0(?:px)?\\s*;`).test(tick),
    ),
    "勾那一层要铺满输入框内框（四边贴 0），这样 50% 才是方框中心",
  );
  const polygon = /clip-path:\s*polygon\(([\s\S]*?)\);/.exec(tick)?.[1] ?? "";
  const points = polygon
    .split(",")
    .map((point) => point.trim())
    .filter((point) => point.length > 0)
    .map((point) => {
      const match = /^calc\(50% ([+-]) ([0-9.]+) \* var\(--dp\)\) calc\(50% ([+-]) ([0-9.]+) \* var\(--dp\)\)$/.exec(point);
      return match
        ? {
            x: (match[1] === "-" ? -1 : 1) * Number(match[2]),
            y: (match[3] === "-" ? -1 : 1) * Number(match[4]),
          }
        : undefined;
    });
  assert.ok(
    points.length === 6 && points.every((point) => point !== undefined),
    `勾的六边形要写成 calc(50% ± N * var(--dp)) 的六个顶点（现在 ${points.length} 个）`,
  );
  const xs = points.map((point) => point!.x);
  const ys = points.map((point) => point!.y);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.002;
  // 勾的形状本身左右不对称（左下那条短臂更短），要钉的是**墨迹外接框**关于中心对称：
  // 两个方向的最远顶点到中心的距离相等，勾就压不到任何一边。
  assert.ok(
    near(Math.max(...xs), -Math.min(...xs)),
    `勾的水平外接框必须关于中心对称（现在 x 偏移 ${JSON.stringify(xs)}），否则就是又偏左 / 偏右了`,
  );
  assert.ok(
    near(Math.max(...ys), -Math.min(...ys)),
    `勾的垂直外接框也必须关于中心对称（现在 y 偏移 ${JSON.stringify(ys)}）：转 45° 后墨迹比盒子中心低 min(宽, 高) / (2√2)，那点对角差要写进顶点里`,
  );
  // 外接框尺寸＝(宽 + 高 + 2 × 描边) / √2 与 (高 + 2 × 描边) / √2：把「4 × 7 内容 +
  // 1.6 描边」钉住，免得有人顺手改坐标却改了勾的比例。
  assert.ok(
    near(Math.max(...xs) - Math.min(...xs), (4 + 7 + 1.6 * 2) / Math.SQRT2) &&
      near(Math.max(...ys) - Math.min(...ys), (7 + 1.6 * 2) / Math.SQRT2),
    "勾的宽高要落在「4 × 7 内容 + 1.6 描边」转 45° 后的外接框上",
  );
  const disabled = /\.session-item-check input:disabled\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  assert.ok(
    disabled.length > 0 && /background:\s*transparent/.test(disabled) && /opacity:/.test(disabled),
    "禁用（运行中 / 当前会话）要退回一个淡描边空框，不能看着像能勾",
  );
  assert.ok(
    /\.session-item-check input:focus-visible\s*\{([\s\S]*?)\}/.test(css),
    "键盘焦点要有环（原生外观没了，焦点环也得自己补）",
  );

  const picked = css.indexOf(".session-item.is-picked");
  const itemHover = css.indexOf(".session-item:hover");
  assert.ok(
    picked > 0 && itemHover > 0 && picked > itemHover,
    "被勾中的行整行淡染，且必须写在 .session-item:hover 之后（同特异性后者胜）",
  );

  const batch = rule(".drawer-batch");
  assert.ok(/border-top:/.test(batch), "工具条是抽屉里的一行（靠上边框与列表分隔），不是浮层");
  assert.ok(/flex:\s*0 0 auto/.test(batch), "工具条不参与 .drawer-body 的伸缩（列表滚它不滚）");
  assert.ok(
    /flex:\s*0 0 auto/.test(rule(".drawer-batch-action")),
    "两颗动作按钮不许被说明文字挤扁（窄侧栏下先截断的是数量文字）",
  );
  assert.ok(
    !/white-space:\s*normal/.test(rule(".drawer-batch-count")) &&
      /text-overflow:\s*ellipsis/.test(rule(".drawer-batch-count")),
    "已选数量单行截断（英文那条比中文长，布局要容得下）",
  );

  const armed = css.indexOf(".drawer-batch-delete.is-danger");
  const btnHover = css.indexOf(".btn:hover");
  assert.ok(armed > 0 && btnHover > 0 && armed > btnHover, "武装态必须写在 .btn:hover 之后（同特异性后者胜）");
  assert.ok(
    /\.drawer-batch-delete\.is-danger:hover\s*\{([\s\S]*?)\}/.test(css),
    "武装态要显式再写一条 :hover（光靠源码顺序，后面谁插一条 .btn:hover 就会吃掉它）",
  );
}
console.log("styles: 历史抽屉的多选（自绘复选框 / 勾中行 / 工具条 / 武装态压过 hover） ✓");

// ---------- 8b. 自绘右键菜单：定位 / 压层 / 文案不溢出 / 接线 ----------
//
// 用户 2026-09-23 口径：原生菜单全界面拦掉，正文右键换成「复制 / 引用」、图片右键换成
// 「复制 / 保存」，只有「压在自己选中的文字上」才放行原生菜单。判据与落点算术在
// `contextMenu.test.ts` 里逐条断言；这里钉的是**只有看 CSS 与接线才知道**的几件事——
// 菜单是视口定位的（挂着 overflow 的正文会把 absolute 的菜单裁掉）、它要压在原图浮层
// 之上（在原图上点右键就是弹在原图上）、接取必须挂 `document` 而不是 `window`
// （挂 window 会排在 VS Code 自己那个监听后面，永远只能看到 defaultPrevented=true，
// 菜单一次都不出现——而所有纯函数断言照样全绿）、以及「挂了接取却忘了挂浮层」。
{
  const menu = rule(".ctx-menu");
  assert.ok(
    /position:\s*fixed/.test(menu),
    "右键菜单必须 position: fixed（视口坐标）：正文是滚动容器，absolute 会被裁掉",
  );
  const minWidth = /min-width:\s*([^;]+);/.exec(menu)?.[1]?.trim();
  const maxWidth = /max-width:\s*([^;]+);/.exec(menu)?.[1]?.trim();
  assert.ok(
    minWidth && maxWidth && /vw|calc\(|min\(/.test(maxWidth),
    `菜单宽度要视口感知（现在 min="${minWidth}" max="${maxWidth}"）——窄侧栏里固定宽度会被顶出视口`,
  );
  const menuZ = Number(/z-index:\s*(\d+)/.exec(menu)?.[1]);
  const previewZ = Number(/z-index:\s*(\d+)/.exec(rule(".image-preview"))?.[1]);
  assert.ok(menuZ > previewZ, `菜单要压在原图浮层之上（菜单 ${menuZ} vs 浮层 ${previewZ}）`);

  const item = rule(".ctx-menu-item");
  assert.ok(
    /white-space:\s*nowrap/.test(item) && /text-overflow:\s*ellipsis/.test(item),
    "菜单条目文字要一行截断（英文比中文长得多，窄侧栏靠它兜底）",
  );

  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /usePageContextMenu\(dispatch, texts\)/.test(app),
    "App 必须挂上页面级右键接取（否则原生菜单照旧弹）",
  );
  assert.ok(
    /<ContextMenuLayer \/>/.test(app),
    "App 必须挂上菜单浮层（只挂接取不挂浮层 = 菜单永远不出现，且纯函数断言全绿）",
  );

  const context = readFileSync(join(process.cwd(), "src", "webview", "contextMenu.ts"), "utf8");
  assert.ok(
    /document\.addEventListener\("contextmenu"/.test(context),
    "接取必须挂 document：VS Code 自己那个监听挂在 window 上且注册得更早，" +
      "挂 window 只会排在它后面、永远只看到 defaultPrevented=true（实测踩过：菜单一次都不弹）",
  );
  assert.ok(
    !/window\.addEventListener\("contextmenu"/.test(context),
    "不许挂 window（同上：注册顺序输给它，接取等于没有）",
  );
  assert.ok(
    /closest\(EDITABLE\)/.test(context),
    "可编辑元素必须放行给系统菜单——自绘菜单做不了粘贴，吃掉它等于把粘贴删掉",
  );
  assert.ok(
    /event\.defaultPrevented/.test(context),
    "别人处理过的右键不能抢（轨迹时间线的右键是平移手势，自己 preventDefault 声明过）",
  );
}
console.log("styles: 自绘右键菜单定位 / 压层 / 接线 ✓");

// ---------- 13. 目标条：默认一行截断，展开按钮切全文（不做「最多两行」） ----------
//
// 用户 2026-09-14 拍板：**要么一行截断、要么全文**，中间态（-webkit-line-clamp: 2）
// 不要——半截的目标比一行还难认，多出来的那一行还把输入区往上顶。
// 展开按钮放在暂停按钮左侧，可以再收起；悬停本来就能看到全文（title）。
{
  const objective = rule(".goal-objective");
  assert.ok(
    /white-space:\s*nowrap/.test(objective) && /text-overflow:\s*ellipsis/.test(objective),
    ".goal-objective 默认必须是一行截断（省略号）",
  );

  const expanded = rule(".goal-bar.is-expanded .goal-objective");
  assert.ok(
    /white-space:\s*normal/.test(expanded),
    "展开态必须允许换行，否则「看了全文」还是被截",
  );
  // 「最多两行」的禁令钉在**目标条**上（那是被否决的中间态）。全文件的宽域检查
  // 会误伤轮次横条的预览卡——那里的 line-clamp 是官方 TurnNavigator 的口径
  // （提示词 1 行 + 响应 3 行，滚出去的内容本来就不该在预览里全展开）。
  assert.ok(
    !/-webkit-line-clamp/.test(objective) && !/-webkit-line-clamp/.test(expanded),
    "目标条不许用「最多两行」的钳制（用户明确否决的中间态）：要么一行截断、要么全文",
  );
  assert.ok(
    /overflow-wrap:\s*anywhere/.test(expanded),
    "长目标（中文长串/无空格路径）展开时要能强制换行，不能撑破条",
  );

  // 按钮顺序：展开在暂停/恢复**左侧**（用户指定的位置）
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  const expandAt = composer.indexOf('goal-action goal-expand');
  const pauseAt = composer.indexOf("texts.goalPause}");
  assert.ok(expandAt > 0 && pauseAt > 0, "展开按钮与暂停按钮都应当存在");
  assert.ok(
    expandAt < pauseAt,
    "展开按钮必须在暂停按钮**左侧**（源码顺序即渲染顺序）",
  );
  assert.ok(
    /aria-expanded=\{expanded\}/.test(composer),
    "展开按钮要带 aria-expanded（无障碍状态）",
  );
}
console.log("styles: 目标条默认一行截断 + 展开切全文 ✓");

// ---------- 14. 用户消息也要有操作行（官方 MessageIconActions 是两者共用的） ----------
//
// 官方 `MessageIconActions`（`dsh-client-ui-chat/lib/client.js`）用户与助手**共用**：
// 顺序固定 clock → copy → extra → branch → usage，用户那一支给「时钟（start）+ 复制」、
// **没有分支**（分支必须锚在 `turn/end` 上，用户消息不是锚点）。
// 此前本扩展的用户消息只有一个气泡 + 附件芯片、没有任何操作行——想复制自己刚发的
// 那段长 prompt 无处可点，只能手动选中。这里钉住三件事：有操作行、能复制正文、
// 且**没有**分支按钮。
{
  const message = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Message.tsx"),
    "utf8",
  );
  const userBranch = message.slice(
    message.indexOf('if (message.role === "user")'),
    message.indexOf("const fullText"),
  );
  assert.ok(userBranch.length > 0, "应当能找到用户消息分支");
  assert.ok(
    /className="msg-actions"/.test(userBranch),
    "用户消息必须有操作行（否则复制不了自己发过的内容）",
  );
  assert.ok(
    /post\(\{ type: "copy", text: readableMentionText\(message\.text \?\? ""\) \}\)/.test(userBranch),
    "用户消息的复制按钮要把**可读文本**发出去（会话引用的原始 token 折成 `@标题`，见 readableMentionText；text 可空，不能是 undefined）",
  );
  assert.ok(
    /formatClock\(message\.ts\)/.test(userBranch),
    "用户消息按时钟（start）显示时间，与官方顺序一致",
  );
  assert.ok(
    !/branchFrom/.test(userBranch),
    "用户消息**不能**有分支按钮：分支锚点必须落在 turn/end 上，用户消息不是锚点",
  );
}
console.log("styles: 用户消息操作行（时钟 + 复制，无分支） ✓");

// ---------- 14b. 助手轮尾的时钟显示**完成时刻**，不是开始处理的时刻 ----------
//
// 官方轮尾时钟取自轮次收场（`TurnTailNodeView` 的 `closing.time` ← `turn/end`），
// 所以长回答下显示的是「什么时候答完」。本扩展原来直接显示 `message.ts`（本轮开始
// 时刻），一轮跑几十分钟时会看着像「刚回复完却显示半小时前」。收尾时刻由宿主写在
// `MessageView.endedAt`（见 dsh/adapter.ts），界面取不到时回落到 `ts`。
{
  const message = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Message.tsx"),
    "utf8",
  );
  assert.ok(
    /formatClock\(message\.endedAt \?\? message\.ts\)/.test(message),
    "助手轮尾时钟要取 endedAt（完成时刻），取不到才回落到 ts",
  );
}
console.log("styles: 助手轮尾时钟取完成时刻 ✓");

// ---------- 3c. 「正在生成」那一行：只留文案，不搞扫光动画与秒表 ----------
//
// 用户 2026-09-14 拍板：**鲸鱼发光本身就是「还在跑」的证据**，官方那套
// 「深度求索中... + 渐变扫光 + ≥15s 实时用时」不要；
// 而工具行本来就各自显示实时耗时（那是我们要保留的信息增量），
// 轮次总用时另由轮尾的「用时 X」胶囊给出。这里钉住「没有扫光那套」不回来。
{
  assert.ok(
    !/turn-status-shimmer/.test(css) && !/\.turn-status\b/.test(css),
    "不应再有 TurnStatus 的扫光状态行（用户明确去掉：鲸鱼发光已足够）",
  );
  // 文案走词典，见 docs/design-messages.md。
  assert.strictEqual(
    dictionaryFor("zh").running,
    "深度求索中",
    "运行中的文案应当是「深度求索中」（原来写的是「生成中」）",
  );
  assert.ok(
    !("deepDiving" in dictionaryFor("zh")),
    "不再保留 deepDiving 词条（那是被去掉的扫光行专用文案）",
  );
}
console.log("styles: 运行中文案（无扫光/无秒表） ✓");

// ---------- 3c. 思考段与官方对齐：恒默认折叠 + 摘要口径 ----------
//
// 官方 `ReasoningRow`：`useState(false)`（运行中也不展开）、标题「思考」，
// 折叠摘要 = **流式中取最后一行、结束后取第一行**，并且**去掉 `**`**。
// 本扩展此前是「流式期间整段展开、摘要恒取首行且不剥 `**`」——长思考把正文顶出
// 屏幕，而摘要里露出的 markdown 强调符号看着很脏。
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /const open = node\.open \?\? false;/.test(rows),
    "思考段必须恒默认折叠（官方 useState(false)，运行中也不展开）——展开态只来自消息持有的端口",
  );
  assert.ok(
    !/open \?\? Boolean\(streaming\)/.test(rows),
    "不再有「流式期间默认展开」那条旧口径",
  );
  assert.ok(
    /\(streaming \? latestLine\(text\) : firstLine\(text\)\)\.replaceAll\("\*\*", ""\)/.test(rows),
    "摘要在流式中取最后一行、结束后取第一行，并剥掉 **（与官方逐字同口径）",
  );
  assert.ok(
    /function latestLine\(text: string\): string \{[\s\S]*?text\.trimEnd\(\)[\s\S]*?lastIndexOf\("\\n"\)/.test(rows),
    "latestLine 要先去尾部空白再取最后一个换行之后（官方 latestLine 的实现）",
  );
  assert.ok(
    /function firstLine\(text: string\): string \{[\s\S]*?text\.indexOf\("\\n"\)/.test(rows),
    "firstLine 取第一个换行之前（官方 firstLine 的实现）",
  );
}
console.log("styles: 思考段恒折叠 + 摘要口径对齐官方 ✓");

// ---------- 15. 工具行三件套对齐官方：IN/OUT 分区、`+N -M`、可点路径 ----------
//
// 官方 `ToolRow`（`dsh-client-ui-tool/lib/client.js`）：
// - 非 diff 工具的展开体是 `ioCard` 两段，标签 `row.input`/`row.output`
//   （zh「输入/输出」、en「IN/OUT」）；**diff 类工具直接给 DiffBlock**，不套 IN/OUT；
// - 折叠行右侧的 suffix 是 `+N -M`（`diffTotals(card.diffs)`，`.diffStat` 类）；
// - 摘要是文件路径时，摘要本身是个 `fileLink` 按钮（点了预览该文件）。
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    // 判据抽成 `showIoCard` 一份（渲染与滚动定位共用它，见第 16c 段）
    /const showIoCard = !hasDiff && !hasCard && \(\(Boolean\(inputText\) && !codeCard\) \|\| showOutput\);/.test(rows) &&
      /\{showIoCard \? \(/.test(rows),
    "IN/OUT 只在**既没有 diff 也没有卡片**时渲染（官方 diff 类给 DiffBlock、读取/搜索/终端/网页给各自的卡，再套 IN/OUT 就是重复）",
  );
  assert.ok(/className="io-label">\{texts\.toolInput\}/.test(rows), "输入段要有标签");
  assert.ok(/className="io-label">\{texts\.toolOutput\}/.test(rows), "输出段要有标签");
  assert.ok(
    /hasCard && card \? \(/.test(rows) && /<ToolCardBody card=\{card\} \/>/.test(rows),
    "有卡片时要渲染工具卡（用户 2026-09-16：工具的展开区重在与可读性与输出，不显示完整参数）",
  );
  assert.ok(
    /codeCard \? \([\s\S]{0,120}?<CodeBlock lang="typescript" code=\{codeCard\.code\}/.test(rows),
    "run_code 的正文用 CodeBlock（官方 `formatToolBody` 的 code 分支）",
  );
  assert.ok(
    /\(Boolean\(inputText\) && !codeCard\) \|\| showOutput/.test(rows),
    "run_code 只省掉 IN 段：输出照常渲染（官方对 code 变体 `cardBody = null`，OUT 仍在）",
  );
  assert.ok(
    /diffStat=\{diffStat\}/.test(rows),
    "编辑类工具的折叠行要带 `+N -M`（官方 diffStat）",
  );
  assert.ok(
    /const diffStat = hasDiff && diff[\s\S]*?added: total\.added[\s\S]*?removed: total\.removed/.test(rows),
    "`+N -M` 必须由 diff hunk 累加而来（官方 diffTotals 口径）",
  );
  assert.ok(
    /onDetailActivate=\{[\s\S]*?!tool\.command[\s\S]*?openFile/.test(rows),
    "路径类 detail 可点开预览（官方 fileLink）；命令行类的 detail 不能当路径打开",
  );
  assert.ok(
    /<DiffView hunks=\{diff\} layout=\{diffLayout\} unified=\{classifyTool\(tool\.name\) === "write"\}/.test(rows),
    "写入节点固化单栏（双栏对整篇新建没有意义——用户 2026-09-16 口径）",
  );

  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  assert.ok(
    /role="link"[\s\S]*?tabIndex=\{0\}/.test(primitives),
    "行内文件链接要键盘可达（role=link + tabIndex，HTML 不允许按钮嵌套按钮）",
  );
  assert.ok(
    /event\.stopPropagation\(\);\s*\n\s*onDetailActivate\(\)/.test(primitives),
    "点链接不能顺手把行展开（stopPropagation）",
  );
  assert.ok(
    !/onDetailActivate && <button/.test(primitives),
    "链接不能用嵌套 <button>：行头本身已经是按钮",
  );

  assert.strictEqual(dictionaryFor("zh").toolInput, "输入", "两段标签要双语且与官方一致（中文）");
  assert.strictEqual(dictionaryFor("en").toolInput, "IN", "两段标签要双语且与官方一致（英文）");
}
console.log("styles: 工具行 IN/OUT + 改动统计 + 可点路径 ✓");

// ---------- 16. 代码块自动换行（官方 pre-wrap + break-all，不横向滚动） ----------
//
// 官方 `pre { white-space: pre-wrap; word-break: break-all }`。窄侧栏里横向滚动
// 意味着长行要一路拖到底才读得完，而代码块正是窄栏里最长的东西。
{
  const pre = rule(".code-block pre");
  assert.ok(
    /white-space:\s*pre-wrap/.test(pre),
    "代码块要自动换行（官方 pre-wrap）——横向滚动在窄侧栏里读长行很痛苦",
  );
  assert.ok(/word-break:\s*break-all/.test(pre), "断词方式与官方一致（break-all）");
  assert.ok(!/overflow-x:\s*auto/.test(pre), "换了行就不该再留横向滚动");
}
console.log("styles: 代码块自动换行（官方 pre-wrap） ✓");

// ---------- 17. 待处理的审批 / 提问卡接管输入区 ----------
//
// 官方把两者注册进 `conversation.composer` 槽（`select: ({pendingInteraction}) => …`），
// 待处理时**接管输入区**——卡片常驻视野，界面看起来就是「在等你回答」。
// 我们此前画在对话流里，滚上去就看不见了。口径：待处理的归输入区、已答过的留流里当记录。
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /pending=\{pending\}/.test(app),
    "App 要把待处理交互交给 Composer（接管输入区）",
  );
  assert.ok(
    /const \{ pending, takenOver \} = resolveInteractions\(state\.messages\)/.test(app),
    "选举与抑制要合成**一次**计算：Composer 渲染当选那张、Message 跳过同一段（两处读同一个结果）",
  );
  assert.ok(
    /takenOver=\{takenOver\}/.test(app),
    "要交给输入区渲染的那些**段**（段 id 集合）也要给 Message，否则可能出现「两边都画」或「两边都不画」",
  );

  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /className=\{`composer-interaction/.test(composer),
    "输入区要有承载这张卡的容器（与目标条同一条 dock 带）",
  );
  assert.ok(
    /pending\.kind === "approval" \? \(\s*<ApprovalCard/.test(composer),
    "审批卡在这里渲染",
  );
  assert.ok(/<QuestionCard question=\{pending\.question\}/.test(composer), "提问卡同理");

  // 卡片必须**限高内滚**：`.composer` 是 `flex: 0 0 auto`，一张多题问卷会长到
  // 1500+px，把上面的会话 / 轨迹压成 0 高、自己还从面板底部溢出去（420×900 实测
  // 6 题全展开：问卷卡 1538px、轨迹视图 0px、输入框 top 1603——用户 2026-09-15 报的
  // 「问卷出来时点轨迹，轨迹页显示不正常」）。限高用视口单位：窄面板下也要按比例收。
  const interaction = rule(".composer-interaction");
  const cap = /max-height:\s*([^;]+);/.exec(interaction)?.[1]?.trim();
  assert.ok(
    cap && /vh|%/.test(cap),
    `.composer-interaction 必须限高且视口感知（现在是 "${cap}"）——不限高会把会话 / 轨迹挤成一条缝`,
  );
  assert.ok(
    /overflow-y:\s*auto/.test(interaction),
    "限高之后卡片要能在内部滚动，否则下半截题目点不到",
  );

  // 「流里只跳过**被输入区接管的那一条**」这条行为不在这里断言：它是纯逻辑 + 渲染结果，
  // 现在钉在 `scripts/pendingInteraction.test.ts`（判据）与 `scripts/questionRender.test.ts`
  // （用真实 Message 渲染出 HTML）里。这里原来那两条源码正则只证明「代码里有这行字」，
  // 换个参数就失效，而且失败信息指向的是调用形状而不是行为。
}
console.log("styles: 待处理交互接管输入区（流里跳过、答过留档） ✓");

// ---------- 18. 工具栏：按实测宽度分配，而不是按固定阈值隐藏 ----------
//
// 用户 2026-09-14 口径：底部工具栏「根据窗口宽度与优先级调整显示」——
// P0 权限/模型/发送（始终显示）、P1 思考强度/附件/tps/上下文环、
// P2 权限文字/agent 预设标签/上下文精确数值（同档内按从左至右，用户 2026-09-22）。
// 宽度是**量**出来的（Composer 的 useToolbarFit
// 把候选档位渲染进测量层读 getBoundingClientRect），所以文案长短（中英差异）、
// 模型名、字号变化都能自动跟上——固定阈值做不到这件事。
//
// 这里钉住四件靠肉眼很难复查、坏了却很难看出来的事：
//   1. 测量层的三条硬约束（零尺寸 / 裁剪 / 不被压缩）；
//   2. 工具栏（.composer-bar）必须是测量层的定位基准；
//   3. 旧的固定阈值通道没有回来（`.app.is-mini` 不再决定工具栏显示谁）；
//   4. 预设标签这个纯文字元素自己收窄出省略号（名字长度不受控）。
{
  const measure = rule(".composer-measure");
  assert.ok(
    /position:\s*absolute/.test(measure) && /width:\s*0/.test(measure) && /height:\s*0/.test(measure),
    `测量层必须是零尺寸的绝对定位元素，现在是 "${measure.trim()}"——它会占掉工具栏的位置`,
  );
  assert.ok(
    /overflow:\s*hidden/.test(measure),
    "测量层必须裁剪：里面那行是 max-content，比工具栏宽，不裁剪会把 webview 撑出横向滚动条",
  );
  assert.ok(
    /visibility:\s*hidden/.test(measure),
    "测量层要 visibility: hidden（不是 display: none——那样量不到宽度）",
  );

  const row = rule(".composer-measure-row");
  assert.ok(
    /width:\s*max-content/.test(row),
    `测量行必须是 max-content，否则会被外层压窄、量出的宽度偏小；现在是 "${row.trim()}"`,
  );
  assert.ok(
    /flex:\s*0\s+0/.test(rule(".composer-measure-row > *")),
    "测量行里的每一项都不许被压缩（flex: 0 0 auto）——压缩后量的就不是自然宽度了",
  );

  // 用行首锚定的正则取规则本体：`rule()` 是按子串找第一个匹配，
  // 而 `.app.is-mini .composer-bar { … }` 排在前面，会把它的声明块认成工具栏本体
  const bar = /^\.composer-bar\s*\{([\s\S]*?)\}/m.exec(css)?.[1] ?? "";
  assert.ok(
    /position:\s*relative/.test(bar),
    `工具栏必须是测量层的定位基准（position: relative），现在是 "${bar.trim()}"`,
  );

  // 固定阈值通道不许回来：工具栏显示谁由 toolbarFit 决定
  assert.ok(
    !/\.app\.is-mini \.ctx-speed/.test(css) && !/\.app\.is-mini \.pill\[data-mini/.test(css),
    "工具栏的元素显示不能再用 220px 的迷你模式阈值决定（那是固定值，中英文字宽不同就会错）",
  );

  // agent 预设标签：工具栏里唯一的纯文字只读元素。用户自己写的预设名长度不受控、
  // 英文名也比中文长，所以它必须自己收窄出省略号——折行会顶高工具栏，不裁则会挤走别人。
  const presetBar = rule(".bar-preset");
  assert.ok(
    /white-space:\s*nowrap/.test(presetBar) && /text-overflow:\s*ellipsis/.test(presetBar),
    `预设标签必须 nowrap + ellipsis（现在是 "${presetBar.trim()}"）`,
  );

  // 模型名（模型胶囊）相反：**不许写死 max-width**（用户 2026-09-23：工具栏够长时
  // 要把模型名显示全）。写死上限的话，宽侧栏里也会在同一个像素处截断，跟侧栏多宽无关。
  // 它多宽由「测量层量自然宽度 → toolbarFit 分配 → 排不下时 flex 压缩」这条链决定，
  // 所以这里只留 nowrap + ellipsis 兜底。
  const modelLabel = rule(".pill-label");
  assert.ok(
    /white-space:\s*nowrap/.test(modelLabel) && /text-overflow:\s*ellipsis/.test(modelLabel),
    `模型名胶囊要 nowrap + ellipsis（塞不下时出省略号，现在是 "${modelLabel.trim()}"）`,
  );
  assert.ok(
    !/max-width/.test(modelLabel),
    `模型名胶囊不许写死 max-width（宽工具栏下会连带截断，现在是 "${modelLabel.trim()}"）`,
  );

  // 环内百分比按用户口径去掉：只留环，精确数值改到环右侧（最低优先级那一档）
  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  assert.ok(
    /ctx-ring-text/.test(primitives) && !/ctx-ring-label/.test(primitives),
    "上下文圆环：环内不再写百分比（ctx-ring-label），精确数值走环右侧的 ctx-ring-text",
  );
  assert.ok(!/ctx-ring-label/.test(css), "app.css 里不该再留 .ctx-ring-label 的样式");

  // 思考强度胶囊与模型按钮开的是**同一个**弹层，点击语义也必须一致（用户 2026-09-14：
  // 「思考强度按钮点击并没有和模型按钮点击一样，如果已经弹出了切换窗口，则再次点击
  // 应是将其关闭」）。此前写的是 setModelOpen(true)（只开不关），表现为弹层开着时
  // 点它毫无反应、像按钮失灵。两者都是 toggle。
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  const effortPill = /const effortPill = effort \? \(([\s\S]*?)\n  \) : null;/.exec(composer)?.[1] ?? "";
  assert.ok(effortPill.length > 100, "取不到 effortPill 的定义（组件结构变了？）");
  assert.ok(
    /setModelOpen\(\(v\) => !v\)/.test(effortPill),
    "思考强度胶囊必须与模型按钮同样 toggle（setModelOpen((v) => !v)）",
  );
  assert.ok(
    !/setModelOpen\(true\)/.test(effortPill),
    "思考强度胶囊不能是「只开不关」——弹层开着时再点应当关掉",
  );
  assert.ok(
    /modelToggleRef\.current = true/.test(effortPill),
    "思考强度胶囊也要在 mousedown 打标记，否则会被弹层的外部点击检测先关掉再打开（闪一下）",
  );

  // 权限与模型两个胶囊不带下箭头（用户 2026-09-22 精简 UI）。箭头不只是装饰：
  // 它是 8px 图标 + 4px 间距的宽度来源之一，加回来等于把整条响应式阶梯一起右移，
  // 所以这里连「它没回来」一起钉住。
  const permissionPill = /const permissionPill = \(withLabel: boolean\) => \(([\s\S]*?)\n  \);/.exec(composer)?.[1] ?? "";
  const modelPill = /const modelPill = \(([\s\S]*?)\n  \);/.exec(composer)?.[1] ?? "";
  assert.ok(
    permissionPill.length > 100 && modelPill.length > 100,
    "取不到 permissionPill / modelPill 的定义（组件结构变了？下面的断言会空转）",
  );
  for (const [name, source] of [
    ["权限", permissionPill],
    ["模型", modelPill],
  ] as [string, string][]) {
    assert.ok(!/Chevron/.test(source), `${name}胶囊不该再带下箭头（用户 2026-09-22 精简 UI）`);
  }

  // 两个入口开的是同一个弹层，但悬停提示要说**各自是干什么的**（用户 2026-09-23：
  // 悬停模型按钮也显示「思考深度」）。「思考深度」属于右侧的思考强度胶囊，
  // 模型按钮是「选择模型」。
  assert.ok(
    /title=\{texts\.selectModel\}/.test(modelPill) && !/texts\.thinkingDepth/.test(modelPill),
    "模型按钮的悬停提示必须是「选择模型」，不能沿用「思考深度」",
  );
  assert.ok(
    /title=\{texts\.thinkingDepth\}/.test(effortPill),
    "思考强度胶囊的悬停提示保持「思考深度」",
  );
}
console.log("styles: 工具栏按实测宽度分配、测量层约束完整 ✓");

// ---------- 16. 连接条：按钮不裁切，文字可以让位（2026-09-14 新增四种状态与按钮） ----------
//
// 连接条整行按钮会随状态变（按钮态：启动/连接内部 DSH、连接外部 DSH、重启内部 DSH、
// 输入令牌、查看日志；连接中：只有停止连接 + 查看日志），满配时五个同现，
// 而英文文案比中文长 1.5~2 倍。三件事必须同时成立，否则窄侧栏下会裁掉按钮（不是"难看"，是点不到）：
// 1. 按钮自己不换行（继承 `.btn` 的 nowrap）——换行由容器负责；
// 2. 容器允许换行（flex-wrap: wrap），放不下就折到第二行，**不裁**；
// 3. 说明文字可以被压缩（min-width: 0 + 省略号），但按钮不参与压缩。
{
  // **按行首锚定**取主规则：`rule(".conn-bar")` 会先命中 `.app.is-mini .conn-bar`
  // （那个助手不做行首锚定，选择器更短就赢），所以这里自己锚一下
  const barMatch = /^\.conn-bar\s*\{([\s\S]*?)\}/mu.exec(css);
  assert.ok(barMatch, "app.css 里找不到 .conn-bar 主规则");
  const bar = barMatch[1];
  assert.ok(
    /flex-wrap:\s*wrap/.test(bar),
    "`.conn-bar` 必须允许换行：按钮是 nowrap 的，不换行就会在窄侧栏里被裁掉（点不到的按钮等于没有）",
  );
  const btn = rule(".btn");
  assert.ok(/white-space:\s*nowrap/.test(btn), "`.btn` 一律 nowrap（条内的按钮标签不能被折成两行）");

  const text = rule(".conn-bar .conn-text");
  assert.ok(/min-width:\s*0/.test(text), "连接条说明文字要能压缩（min-width: 0），否则会把按钮挤出去");
  assert.ok(
    /text-overflow:\s*ellipsis/.test(text) && /white-space:\s*nowrap/.test(text),
    "连接条说明文字超长时出省略号（长 URL / 长错误文本不能顶破一行）",
  );

  // 「没在跑」不是错误：不该用错误色（红色会让用户以为出事了）
  assert.ok(/\.conn-bar\.is-stopped/.test(css), "连接条要有 is-stopped 的中性色一档（没启动 ≠ 失败）");
  // 极小宽度下先收起「查看日志」（命令面板里还有同一个入口）
  assert.ok(
    /\.app\.is-mini \.conn-bar \[data-mini="hide"\]/.test(css),
    "迷你模式下连接条要能收起次要按钮（查看日志），保证启动/重连按钮仍然可点",
  );
}
console.log("styles: 连接条按钮不被裁切、文字可让位 ✓");

// ---------- 16b. 滚动容器只能有一层：工具卡自己不再限高 ----------
//
// 用户 2026-09-16 报的「命令行节点怎么会出现两层垂直滚动条」：外层 `.row-body`
// 本来就有 `max-height: 320px; overflow: auto`（所有工具行共用的那个滚动区），
// 终端卡若再给自己的 `.tool-card-body` 加一层 max-height，就会出现两条滚动条
// （实测：80 行输出下两个可滚动容器嵌套）。官方在会话行里把 TerminalBlock 的
// maxLines 设成 Infinity，只留外面一层。
{
  const body = rule(".tool-card-body");
  assert.ok(
    !/max-height|overflow-y\s*:\s*(auto|scroll)/.test(body),
    `.tool-card-body 不许自己限高/滚动（已有的滚动容器是外层 .row-body），现在是 "${body.trim()}"`,
  );
  assert.ok(
    !/\.tool-card\.is-terminal \.tool-card-body/.test(css),
    "终端卡不许再给自己加一层滚动区——那就是「两层垂直滚动条」的来源",
  );
}
console.log("styles: 工具卡只有一层滚动条 ✓");

// ---------- 16b'. 复制按钮的归属：工具卡内容有、工具串没有（用户 2026-09-17 口径） ----------
//
// 这条口径澄清过一轮（第一轮误读成「工具卡一律不给复制」），钉死完整版：
// - 每张**有内容**的工具卡都有复制按钮：读/搜索/终端在横幅右侧，网页搜索卡
//   借横幅行补在内容右上角；web_fetch 只有链接没有内容体，不给。
// - 「工具串」不给：整轮只有连续工具调用、没有正文的消息，轮尾复制按钮
//   必须包在 `fullText !== ""` 条件里。
// - 生成过程中整条操作行（时间/分支/复制）都不画。
{
  const toolCards = readFileSync(join(process.cwd(), "src", "webview", "components", "ToolCards.tsx"), "utf8");
  assert.strictEqual(
    (toolCards.match(/<CopyButton /g) ?? []).length,
    4,
    "工具卡应有 4 处复制按钮（读/搜索/终端横幅 + 网页搜索卡内容右上角）；web_fetch 无内容体不给",
  );

  const message = readFileSync(join(process.cwd(), "src", "webview", "components", "Message.tsx"), "utf8");
  const assistant = message.slice(message.indexOf("const fullText"));
  assert.ok(assistant.length > 0, "应当能找到助手消息分支");
  const copyAt = assistant.indexOf('post({ type: "copy", text: fullText })');
  assert.ok(copyAt > 0, "轮尾复制按钮应把 fullText 发给宿主");
  assert.ok(
    /fullText !== "" \? \(/.test(assistant.slice(Math.max(0, copyAt - 800), copyAt)),
    "轮尾复制按钮必须包在「有正文」的条件里——工具串（无正文的整轮）不给复制",
  );
  const actionsAt = assistant.indexOf('className="msg-actions"');
  assert.ok(actionsAt > 0, "助手消息应有操作行");
  assert.ok(
    /!message\.streaming/.test(assistant.slice(Math.max(0, actionsAt - 200), actionsAt)),
    "操作行（时间/分支/复制/用时）必须包在 !message.streaming 里：生成过程中右下角不画",
  );
}
console.log("styles: 复制按钮归属（工具卡内容有 / 工具串没有 / 生成中不画） ✓");

// ---------- 16c. 节点展开后：还在跑的贴底，已结束的置顶 ----------
//
// 用户 2026-09-16 口径：「各类节点打开后，如果有垂直滚动条，默认应当居于最顶部」——
// 那时一律 `scrollTop = 0`，只有**还在逐 token 增长且盒子装得下**的思考节点跟随。
// 用户 2026-09-20 修正：**未结束、还在执行中的节点打开后滚动条应当在底部**（最新
// 信息才是有用的），已结束的节点维持置顶。旧实现的两处不合口径之处因此都要改：
//   ① 运行中的工具行 / 命令节点当时根本不传「进行中」（只有思考传 streaming）；
//   ② 思考节点的跟随被「盒子装得下（<40px 溢出）」卡住——一长就退回置顶。
{
  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  assert.ok(
    /el\.scrollTop = active \|\| openedWhileActive \? el\.scrollHeight : 0;/.test(primitives),
    "出现那一刻的定位必须两分：进行中（或用户是跑着的时候点开的）贴底，已结束的置顶",
  );
  assert.ok(
    !/el\.scrollTop = 0;\s*\n\s*lastTopRef\.current = 0;/.test(primitives),
    "旧的「一律回顶」写法不能回来",
  );
  assert.ok(
    // 「装得下才跟随」那条限制正是用户这次报的现象：长一点就退回顶部
    !/scrollHeight - el\.clientHeight < 40;/.test(primitives),
    "跟随不再以「盒子装得下」为条件——进行中的节点一律贴底跟随",
  );
  assert.ok(
    /if \(!active\) return;/.test(primitives),
    "静态（已结束）内容不注册观察者——否则后续更新会抢用户的滚动位置",
  );
  assert.ok(
    /stickRef\.current = active;/.test(primitives),
    "跟随态直接等于「还在进行中」（打开那一刻不再要求先滑到底）",
  );
  // 打开那一刻只定位一次：`active` 由真翻假（跑完了）时不许再动滚动位置，
  // 否则用户盯着末尾看输出、节点一结束就被拽回顶部
  assert.ok(
    /if \(!openedRef\.current\) \{[\s\S]{0,220}?el\.scrollTop = active \|\| openedWhileActive \? el\.scrollHeight : 0;/.test(primitives),
    "出现定位必须包在「刚出现」分支里（`openedRef`），结束后不许重定位",
  );
  assert.ok(
    /if \(!el \|\| !enabled\) \{\s*\n\s*openedRef\.current = false;/.test(primitives),
    "收起时要复位「刚出现」标记，否则再展开不会重新定位",
  );
  assert.ok(
    /lastTopRef\.current = el\.scrollTop;/.test(primitives),
    "记录基线要记**定位之后**的位置（贴底时的基线是底部，不是 0）",
  );
  // 第 4 个参数 = 「用户点开它的时候它还在跑」（用户 2026-09-21 口径）：默认取 `active`
  // （旧行为不变），行的展开意图由 `Message` 持有并随展开态一起记
  assert.ok(
    /openedWhileActive = active,/.test(primitives) && /\[enabled, active, openedWhileActive\]/.test(primitives),
    "第 4 个参数要有默认值，并且是 effect 的依赖（改了它要重新定位）",
  );

  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  // 工具行：`running` = status 还在跑（running / pending）
  assert.ok(
    /useStickyBody\(diffRef, open && hasDiff, running, node\.openedWhileActive\)/.test(rows) &&
      /useStickyBody\(bodyRef, open && !hasDiff && \(showOutput \|\| hasCard \|\| Boolean\(codeCard\)\), running, node\.openedWhileActive\)/.test(rows),
    "工具行的两个 body（diff 段 / 结果-卡片段）都要传 `running`：跑着就贴底看最新输出",
  );
  // 运行中的工具行**唯一的**滚动盒子是 IN 卡（卡片在跑的时候不渲染），它此前压根没有
  // ref，于是永远停在顶部——用户报的正是这个形态。渲染判据与定位判据必须是同一份
  // `showIoCard`，两处各写一份必然漂移。
  assert.ok(
    /const showIoCard = !hasDiff && !hasCard && \(\(Boolean\(inputText\) && !codeCard\) \|\| showOutput\);/.test(rows),
    "IN/OUT 卡的渲染判据只留一份（showIoCard），渲染与滚动定位共用它",
  );
  assert.ok(
    /useStickyBody\(ioRef, open && showIoCard, running, node\.openedWhileActive\)/.test(rows) &&
      /\{showIoCard \? \(\s*\n\s*<div ref=\{ioRef\} className="row-body io-card">/.test(rows),
    "IN 卡要真的绑上 ioRef 并传 running（少了 ref，那条滚动条永远停在顶部）",
  );
  assert.ok(
    /useStickyBody\(runningRef, open && runningBody, running, node\.openedWhileActive\)/.test(rows) &&
      /<div ref=\{runningRef\} className="row-body mono row-running">/.test(rows),
    "「运行中」那块自己也是滚动盒子（长命令会撑开），同样要贴底——一个展开区里两条滚动条不该各朝一头",
  );
  assert.ok(
    /useStickyBody\(bodyRef, open, streaming === true, node\.openedWhileActive\)/.test(rows),
    "思考节点传 streaming（它逐 token 增长）",
  );
  assert.ok(
    /useStickyBody\(bodyRef, open, command\.state === "running", node\.openedWhileActive\)/.test(rows),
    "命令节点与工具同口径：running 时贴底",
  );
  assert.ok(
    /useStickyBody\(bodyRef, open\);/.test(rows),
    "注入节点（系统提示词等）永远不会「进行中」，保持默认置顶",
  );
  // 七处可展开节点：工具行 4 个滚动盒子（diff / 卡片-结果 / IN 卡 / 运行状态块）
  // + 思考 + 命令 + 注入；只有注入那一处不传「进行中」（也不传展开意图）
  const calls = rows.match(/useStickyBody\([^;]*\)/g) ?? [];
  assert.strictEqual(
    calls.length,
    7,
    `Rows.tsx 里应当有 7 处 useStickyBody，实际：${JSON.stringify(calls)}`,
  );
  const withActive = calls.filter((call) => (call.match(/,/g) ?? []).length >= 2);
  const withoutActive = calls.filter((call) => (call.match(/,/g) ?? []).length < 2);
  assert.strictEqual(
    withActive.length,
    6,
    `应当有六处传「进行中」（工具 4 + 思考 + 命令），实际：${JSON.stringify(withActive)}`,
  );
  assert.deepStrictEqual(
    withoutActive,
    ["useStickyBody(bodyRef, open)"],
    "不传「进行中」的只能有注入节点那一处",
  );
  const withIntent = calls.filter((call) => /node\.openedWhileActive\)$/.test(call.trim()));
  assert.strictEqual(
    withIntent.length,
    6,
    `传「进行中」的六处都要把展开意图一起传下去（跑完那一刻新出现的盒子按它定位），实际：${JSON.stringify(withIntent)}`,
  );
}
console.log("styles: 节点展开后——进行中的贴底、已结束的置顶（跑完不重定位；运行中点开的贴底） ✓");

// ---------- 16c'. 节点展开体统一是「节点框」：内容不许和正文同级 ----------
//
// 用户 2026-10-02 报的「已完成的问卷、读取图片展开后，内容和正文同级，看不出属于
// 上面那一行节点」。此前展开体只有一条 1px 左边线（`.row-body` 的 `border-left`），
// 问卷记录（`.question.is-record` 曾把外框整个去掉）与工具行的结果图库
// （`.row-body-images`，只有一段缩进）连那一条都没有。
//
// 现在三处共用同一张卡（同一组选择器里的一份声明），这条钉住三件事：
// ① 共用声明还在，且各自只补自己的强调色；
// ② 展开体里**自带卡片**的两种（工具卡 / 代码卡）不再往外层叠一层边框；
// ③ 工具行的结果图片真的套进了节点框，且图片那一档不吃文本档的 320px 限高。
{
  const shared = /\.row-body,\s*\.row-exit,\s*\.question\.is-record\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(
    shared,
    "`.row-body` / `.row-exit` / `.question.is-record` 必须共用同一组「节点框」声明——分成三处写迟早各自漂移",
  );
  const frame = shared[1];
  assert.ok(/border:\s*1px solid/.test(frame), `节点框要有整圈边框（不是只有一条左边线），现在是 "${frame.trim()}"`);
  assert.ok(/border-radius:/.test(frame), "节点框要有圆角");
  assert.ok(/background:\s*var\(--node-body-bg\)/.test(frame), "节点框要有那层极淡的底色（token 见 tokens.css）");
  assert.ok(
    /margin:\s*[^;]*calc\(18 \* var\(--dp\)\)/.test(frame),
    "节点框要缩进到节点名之下（左 18 个设计像素，与行首图标对齐），否则又和正文同级了",
  );

  // ① 问卷记录只补强调色左边：等待态那张卡也是这个颜色，两种形态应当同族
  // （不能走 `rule()`：共用那组选择器里也有 `.question.is-record`，首个匹配拿到的是那一份）
  const recordBlocks = [...css.matchAll(/\.question\.is-record\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(recordBlocks.length > 0, "应当有 `.question.is-record` 的声明（共用那组 + 自己的补充）");
  assert.ok(
    recordBlocks.some((block) => /border-left:\s*2px solid var\(--accent\)/.test(block)),
    "问卷记录要保留问卷自己的强调色左边（与等待态那张卡同族）",
  );
  assert.ok(
    !recordBlocks.some((block) => /border:\s*none/.test(block) || /background:\s*none/.test(block)),
    "问卷记录不许再把节点框整个去掉——那正是「展开后和正文同级」这个缺陷的成因",
  );

  // ② 自带卡片的展开体：框由内层（.tool-card / .code-block）提供
  const cardBody = rule(".row-body.card-body");
  assert.ok(
    /border:\s*none/.test(cardBody) && /background:\s*none/.test(cardBody) && /padding:\s*0/.test(cardBody),
    "`.row-body.card-body` 只留缩进与滚动：再叠一层边框就成了「卡里还套着一张卡」",
  );

  // ③ 工具行的结果图片
  const rowsSrc = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /<div className="row-body is-media">\s*\n\s*<ImageGallery/.test(rowsSrc),
    "工具行的结果图片要套进节点框（`.row-body.is-media`）——此前它只有一段缩进，几张图直接浮在会话流里",
  );
  const media = rule(".row-body.is-media");
  assert.ok(
    /max-height:\s*none/.test(media) && /overflow:\s*visible/.test(media),
    "图片那一档不吃文本展开体的 320px 限高与内滚（图是拿来看的）",
  );
  assert.ok(
    /\.row-body \.row-body-images\s*\{[^}]*margin:\s*0/.test(css),
    "进框之后图库自己不再留那 18px 缩进（缩进由框提供）",
  );
  assert.ok(
    /\.msg-assistant \.row-body-images\s*\{[^}]*margin:\s*calc\(4 \* var\(--dp\)\) 0;/.test(css),
    "助手消息里的图库要跟正文一条左边界——`images` 段与轮尾交付的图都是正文的一部分，" +
      "带着节点展开体那 18px 缩进却没有框，看起来正像一个没了框的节点展开体",
  );
}
console.log("styles: 节点展开体统一是「节点框」（问卷记录 / 图片 / 退出状态与其它展开体同框） ✓");

// ---------- 16c''. 正文里的图有官方那一档尺寸上限：超出的按比例缩，原图点开看 ----------
//
// 官方 dsh web 的正文图（`MarkdownText.module.css` 的 `.image` + `.imageButton .image`）：
// 宽 `min(100%, 640px)`、高 360px，点击放大走浮层。本扩展此前只写 `max-width: 100%`，
// 于是一张竖长的截图能把整个会话窗口占满（用户 2026-10-03 报「太占空间，像是没有限制
// 大小」）。两件事一起钉：**缩略图有上限**、**原图仍然看得到**（只有上限没有放大入口，
// 就等于把图压成看不清的小块）。
{
  const image = rule(".md img");
  assert.ok(
    /max-width:\s*min\(100%,\s*calc\(640 \* var\(--dp\)\)\)/.test(image),
    `正文图的宽度上限要是官方的 \`min(100%, 640)\`（设计像素；写死会在窄侧栏溢出），现在是 "${image.trim()}"`,
  );
  assert.ok(
    /max-height:\s*calc\(360 \* var\(--dp\)\)/.test(image),
    "正文图的高度上限要是官方的 360（设计像素，竖长截图的体积全靠它）",
  );
  assert.ok(/cursor:\s*zoom-in/.test(image), "缩略图要能点开看原图，光标得给提示");

  const preview = rule(".image-preview img");
  assert.ok(
    /max-width:\s*100%/.test(preview) && /max-height:\s*100%/.test(preview),
    "原图浮层只受视口约束——它才是「看原图」的地方，别把正文那档上限带进来",
  );
  assert.ok(
    !/360/.test(preview),
    "正文的 360（设计像素）上限不许漏进原图浮层，否则大图永远看不清",
  );
}
console.log("styles: 正文图限高 360px（官方式缩略图）+ 原图浮层不受该上限 ✓");

// ---------- 16d. 轨迹是整页视图：打开就占用整个会话窗口，输入区让位 ----------
//
// 用户 2026-09-16 口径：「轨迹页面应当打开就是占用整个会话窗口，但是切换回会话时要能
// 将问卷正常显示出来，以及在有问卷显示时点击轨迹也能正常显示为占用整个会话的轨迹页面，
// 而不是现在这样的问卷始终占用会话底部空间」。
//
// 做法上有一条硬约束：输入区**不能卸载、也不能 `display: none`**——待答问卷里填了一半
// 的选择是 `QuestionCard` 的本地 state，卸载就没了；`display: none` 还会跳过布局，
// 让输入框的自增高算出 0 高。所以是「绝对定位（不占高度）+ visibility: hidden」。
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /is-trajectory" : ""\}/.test(app) && /state\.panel === "trajectory" \? " is-trajectory"/.test(app),
    "轨迹视图下 .app 要带 is-trajectory（输入区据此让位）",
  );

  const hidden = rule(".app.is-trajectory .composer");
  assert.ok(
    /position:\s*absolute/.test(hidden),
    `.app.is-trajectory .composer 必须**移出文档流**（position: absolute），否则它还占着高度，轨迹拿不到整个窗口；现在是 "${hidden.trim()}"`,
  );
  assert.ok(
    /visibility:\s*hidden/.test(hidden),
    "隐藏方式必须是 visibility: hidden",
  );
  assert.ok(
    !/display:\s*none/.test(hidden),
    "**不能**用 display: none：那会跳过布局（输入框自增高算成 0 高），卸载组件更会丢掉问卷里填了一半的选择",
  );
  assert.ok(
    /pointer-events:\s*none/.test(hidden),
    "隐藏的输入区不能挡住轨迹区的点击（它绝对定位在底部，与账本重叠）",
  );
}
console.log("styles: 轨迹整页占用会话窗口（输入区移出布局但不卸载） ✓");

// ---------- 17. 轨迹是整页视图（不是抽屉），「加载更早」贴在时间线左端 ----------
//
// 用户 2026-09-14 口径：
// 1) 点轨迹按钮应当**整页**切到轨迹（像官方 Web UI 的视图槽），不是弹出侧边抽屉；
//    切过去之后那颗图标要变成会话图标，点它能回来；
// 2) 官方的「加载更早」是时间线**左端**的 `…`（`earlierHistory`：贴左缘、向右渐隐），
//    我们此前排在绘图区右侧；标题栏里那个重复的「加载更早」按钮要一起去掉。
{
  const trajectory = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"),
    "utf8",
  );
  // 时间线本体（绘图区、左端 `…`、右侧复位）自 2026-10-09 起是**独立的呈现组件**
  // （`TrajectoryTimeline.tsx`，只收一个交互端口）：绘图区那几样接线断言要去那一份里找。
  const timeline = readFileSync(
    join(process.cwd(), "src", "webview", "components", "TrajectoryTimeline.tsx"),
    "utf8",
  );
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const flatApp = app.replace(/\s+/gu, " ");
  const flatTrajectory = trajectory.replace(/\s+/gu, " ");
  const flatTimeline = timeline.replace(/\s+/gu, " ");

  assert.ok(
    /className="trajectory-view" role="region"/.test(flatTrajectory),
    '轨迹视图必须是整页区块（.trajectory-view），不是 role="dialog" 的抽屉',
  );
  assert.ok(
    !/role="dialog"/.test(trajectory) && !/drawer-head/.test(trajectory),
    "轨迹视图不许再有抽屉头——标题栏里那个「加载更早」正是它带出来的重复入口",
  );
  assert.ok(
    /\{state\.panel === "trajectory" \? \( <TrajectoryView/.test(flatApp),
    "App 必须在轨迹分支里**顶掉整块会话页**（含 chat-scroll），而不是叠在会话上",
  );

  // 「…」在绘图区**内部**、贴左缘（官方 earlierHistory）
  const plotStart = flatTimeline.indexOf('className="trajectory-plot"');
  assert.ok(plotStart > 0, "在 TrajectoryTimeline.tsx 里找不到时间线绘图区");
  const resetAt = flatTimeline.indexOf('className="trajectory-more"');
  assert.ok(resetAt > plotStart, "绘图区之后应当还有右侧的缩放复位按钮");
  assert.ok(
    flatTimeline.slice(plotStart, resetAt).includes("trajectory-earlier"),
    "「加载更早」的 `…` 必须画在绘图区里（左端），不能再排到绘图区右侧",
  );
  const earlier = rule(".trajectory-earlier");
  assert.ok(
    /position:\s*absolute/.test(earlier) && /left:\s*0/.test(earlier),
    "`.trajectory-earlier` 必须绝对定位贴住绘图区左缘（官方 earlierHistory 的位置）",
  );
  assert.ok(
    /linear-gradient\(to right/.test(earlier),
    "`.trajectory-earlier` 要向右渐隐，否则会整片盖住左端的记录条",
  );

  // 头部那颗按钮：会话 ⇄ 轨迹共用一个开关，且轨迹视图下迷你模式也必须留着
  // （它是唯一的退路，收起来就出不来了）
  assert.ok(
    /\{state\.panel === "trajectory" \? <IconChat size=\{15\} \/> : <IconTrajectory size=\{15\} \/>\}/.test(flatApp),
    "头部按钮要在轨迹视图下换成会话图标（点它回来），会话视图下才是轨迹图标",
  );
  assert.ok(
    /data-mini=\{state\.panel === "trajectory" \? undefined : "hide"\}/.test(flatApp),
    "轨迹视图下那颗按钮不能被迷你模式收起——它是回到会话的唯一入口",
  );
}
console.log("styles: 轨迹整页切换、加载更早在时间线左端 ✓");

// ---------- 18. 轨迹取历史与会话同一条链路；概述里直接摊开后几张卡片 ----------
//
// 用户 2026-09-14 口径：
// 1) 「轨迹点击加载历史 → 触发会话页那条取历史的链路 → 取完轨迹自己刷新」；
//    加载中要看得见（账本顶部那行显示 spinner + 文案），不能「点了没反应」；
// 2) 概述页要像官方那样**直接把后几张卡片的内容摊出来**（工具行 = 参数 / 结果 /
//    Schema / 计时），不是让人一页一页点过去。
{
  const trajectory = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"),
    "utf8",
  );
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const flatApp = app.replace(/\s+/gu, " ");
  const flatTrajectory = trajectory.replace(/\s+/gu, " ");

  // 1) 取历史：轨迹侧只有 `onLoadEarlier` 一个入口（不自己发 loadMore），
  //    宿主说「取完了」（historyLoading 回落）时界面自己再要一份账本。
  assert.ok(
    /onLoadEarlier=\{\(\) => loadEarlier\(\)\}/.test(flatApp),
    "轨迹的「加载更早」必须接会话页那条链路（App 里同一个 loadEarlier）",
  );
  assert.ok(
    !/post\(\{ type: "loadMore" \}\)/.test(flatTrajectory),
    "轨迹侧不许自己发 loadMore——必须走会话页那条链路，否则两边会各取各的",
  );
  assert.ok(
    /const settled = historyWasLoading\.current && !loading;/.test(flatApp) &&
      /settled && state\.panel === "trajectory"[\s\S]{0,60}listTrajectory/.test(flatApp),
    "取完（historyLoading 由 true 落回 false）时，轨迹视图必须自己重取账本",
  );
  // 加载中看得见：账本最上面那行（官方 historyLoadRow 的位置）
  assert.ok(
    /className="trajectory-history-load"/.test(flatTrajectory),
    "账本最上面要有「加载更早的历史」那一行（官方 `historyLoadRow`）",
  );
  assert.ok(
    /disabled=\{loadingEarlier\}/.test(flatTrajectory) &&
      /<Spinner size=\{11\} \/>/.test(flatTrajectory),
    "取历史的过程中那一行要禁用并显示 spinner（不是「点了没反应」）",
  );

  // 2) 概述里的分节：工具/子工具 = 参数 / 结果 / Schema / 计时；markdown 记录 = 预览
  assert.ok(
    /className="trajectory-overview-sections"/.test(flatTrajectory),
    "概述页要有「后几张卡片」的分节容器（官方 `overviewSections`）",
  );
  const sectionPush = /const sections:[\s\S]*?sections\.push\(\{ key: "timing"[\s\S]*?\n\s*\}/.exec(trajectory)?.[0] ?? "";
  assert.ok(sectionPush.length > 100, "取不到概述分节的构造（组件结构变了？）");
  for (const key of ['"payload"', '"result"', '"schema"', '"timing"']) {
    assert.ok(sectionPush.includes(key), `工具行的概述分节必须包含 ${key}`);
  }
  assert.ok(
    /sections\.push\(\{ key: "preview", label: texts\.tabPreview/.test(flatTrajectory),
    "markdown 记录（用户/上下文/助手）的概述分节是「预览」",
  );
  assert.ok(
    /onClick=\{\(\) => setTab\(section\.tab as TabId\)\}/.test(flatTrajectory),
    "分节标题可点：点了切到对应页签看完整版（官方 `OverviewSection` 的 onOpen）",
  );
  // 同一份正文只写一次（分节与页签共用），否则两处迟早走样
  assert.ok(
    /const bodies: Record<TabId, React\.ReactNode>/.test(flatTrajectory),
    "各页签正文要抽成一份（`bodies`），概述分节与页签共用",
  );

  // 2b)「原始内容」页签的逐块渲染（官方 `MarkdownRecordContent` 第二分支）
  const sourceBlocksSrc = readFileSync(
    join(process.cwd(), "src", "webview", "components", "SourceBlocks.tsx"),
    "utf8",
  ).replace(/\s+/gu, " ");
  assert.ok(
    /trajectoryUsesSourceBlocks\(cell\) \? \( <SourceBlocks/.test(flatTrajectory),
    "有原始块时「原始内容」页签要整块改用逐块排版（不是把块列表加在那段裸文本下面）",
  );
  assert.ok(
    /<SourceBlocks blocks=\{cell\.sourceBlocks \?\? \[\]\} texts=\{texts\} onOpenCall=\{onOpenCall\} \/>/.test(flatTrajectory),
    "逐块视图要吃**这一格**的原始块，跳转回调由检查器透传（认到哪一行是视图层的事）",
  );
  // 跳转那一步不能只 `selectRecord`：目标行可能被折叠收走、也可能在虚拟化窗口之外，
  // 少了下面三样，用户点完**什么都看不到**（与官方 `openRecordSummary` 同一套）。
  // 这三样自 2026-10-09 起都由**交互端口**（`trajectoryInteraction.ts`）提供，
  // 组件只按需调用——端口那一侧的行为断言在 `scripts/trajectoryInteraction.test.ts`。
  // 源码已折成单空格（`flatTrajectory`），所以边界用「下一个顶层 const」而不是行首缩进
  const openCall = /const openCallRecord = \(callId: string\) => \{[\s\S]*?const selectedCell =/.exec(flatTrajectory)?.[0] ?? "";
  assert.ok(openCall.length > 0, "找不到 openCallRecord（逐块跳转那一步的实现变了？）");
  for (const [needle, why] of [
    ["port.expandTurn(", "目标那一轮被折了要展开（官方 openRecordSummary 的第一步）"],
    ["port.expandCall(", "目标是工具行时，发起它的那条助手行被「调用折叠」收走了也要展开"],
    ["port.openRecord(index)", "选中目标行并请求把它滚进视野（否则窗口外的目标看不见）"],
  ] as const) {
    assert.ok(openCall.includes(needle), `逐块跳转缺了「${needle}」：${why}`);
  }
  assert.ok(
    /className="trajectory-source-block-content"/.test(sourceBlocksSrc),
    "每块一节，正文那一枚的类名由样式表按 `calc(N * var(--dp))` 定义",
  );
  assert.ok(
    /jumpable \? \( <button[\s\S]{0,80}?className="trajectory-source-block-jump"/.test(sourceBlocksSrc),
    "块标题只在有 callId 且给得出回调时才是跳转按钮（画出按钮却点不动是最坏的一种）",
  );
  assert.ok(
    /var\(--dp\)/.test(rule(".trajectory-source-block-content")) &&
      /var\(--dp\)/.test(rule(".trajectory-source-blocks")),
    "逐块排版那两处几何量必须走 --dp（裸 px 会被界面尺度那条断言抓住）",
  );

  // 2c) 「系统提示词变更」页签的**行级差分**（官方 `PromptDiffSection`）
  const promptDiffSrc = readFileSync(
    join(process.cwd(), "src", "webview", "components", "PromptDiff.tsx"),
    "utf8",
  ).replace(/\s+/gu, " ");
  assert.ok(
    /trajectory-prompt-diff-section/.test(promptDiffSrc) &&
      /trajectory-prompt-diff-title/.test(promptDiffSrc) &&
      /trajectory-prompt-diff-line/.test(promptDiffSrc),
    "差分那一节的三个类名要在组件里出现（样式表按它们写）",
  );
  assert.ok(
    /if \(lines\.length === 0\) return null;/.test(promptDiffSrc),
    "两段相同时整节不渲染（挂一个空标题会让人以为这里本来有内容）",
  );
  assert.ok(
    /is-\$\{kind\}/.test(promptDiffSrc) &&
      /var\(--success\)/.test(rule(".trajectory-prompt-diff-line.is-added")) &&
      /var\(--error\)/.test(rule(".trajectory-prompt-diff-line.is-removed")),
    "新增 / 删除行分别用主题的成功 / 错误色（与 diff 视图、改动统计同一对变量）",
  );
  assert.ok(
    /trajectoryUsesSourceBlocks|PromptDiffSection/.test(flatTrajectory) &&
      /<PromptDiffSection title=\{texts\.tabSystemPrompt\}/.test(flatTrajectory),
    "对照页签那一节要喂「改动前 vs 改动后」的两段提示词",
  );
  // 工具目录那一节**只在这一行记下了 before 的目录时**才出：拿改动前的 system 去比
  // 改动后的 tools 是错的对照，所以缺席时宁可不显示（官方那边这个字段总是有）
  assert.ok(
    /cell\.previousPromptTools !== undefined && cell\.toolsDetail !== undefined/.test(flatTrajectory),
    "工具目录那一节要在**两份目录都在**时才渲染",
  );
  const flatVendor = readFileSync(
    join(process.cwd(), "src", "webview", "trajectoryVendor.ts"),
    "utf8",
  ).replace(/\s+/gu, " ");
  // 适配层要做的是**合成官方形状**：宿主那一列（`previousPromptTools`，官方 `TrajectoryCellProps`
  // 里没有它）进 `previousPromptDetail.tools`，而不是原样多透传一个键。拆成正反两条断言是有意的
  // ——只写「合成有了」会漏掉「同时又透传了一份」，S01 之前正是这个状态。
  assert.ok(
    /\{ tools: cell\.previousPromptTools \}/.test(flatVendor),
    "被替换掉的工具目录要合成进 `previousPromptDetail.tools`（少了它，vendor 形状里那一半永远是缺的）",
  );
  assert.ok(
    !/previousPromptTools: cell\.previousPromptTools/.test(flatVendor),
    "vendor 形状不得再透传宿主字段 `previousPromptTools`（官方没有这一列）",
  );

  // 2d) 助手记录概述里的「请求计时」一节（跨检查器的入口）
  assert.ok(
    /section\.onOpen !== undefined \? \(/.test(flatTrajectory),
    "分节标题要支持**跨面板**的 onOpen（请求计时开的是请求检查器，不是记录检查器的页签）",
  );
  assert.ok(
    /onOpenRequestTiming=\{openRequestTimingFor\(selectedCell\)\}/.test(flatTrajectory),
    "记录检查器要拿到「跳到该请求的计时页签」这个回调（视图层按请求号解析，见 trajectoryDisplay）",
  );
  assert.ok(
    /port\.selectRequest\(number, "timing"\)/.test(flatTrajectory) &&
      /initialTab=\{requestTab\}/.test(flatTrajectory),
    "跳过去要把目标页签一起交过去（请求检查器默认开在概述，不指定就像是没生效）",
  );
  assert.ok(
    /key=\{selectedRequestInfo\.number\}/.test(flatTrajectory),
    "请求检查器按请求号重挂：页签态在组件内，不重挂就采不到新的 initialTab",
  );
  assert.ok(
    /if \(requestSelected\) port\.clearSelection\(\); else port\.selectRequest\(requestNumber\);/.test(flatTrajectory),
    "点账本行那枚请求小标记要清掉上一次的目标页签（端口 `selectRequest` 不带 tab 就是回到默认页签）",
  );

  // 3) 布局：分节限高自己滚；账本与检查器**不换行**、检查器最多占满去掉 280px 的宽度
  const preview = rule(".trajectory-overview-preview");
  assert.ok(
    /max-height:/.test(preview) && /overflow:\s*auto/.test(preview),
    ".trajectory-overview-preview 必须限高自己滚（一节原文可能几千字）",
  );
  const body = rule(".trajectory-body");
  assert.ok(
    /flex-wrap:\s*nowrap/.test(body),
    ".trajectory-body 不许换行——换行会把检查器挤到第二行并撑出主体",
  );
  assert.ok(
    /overflow-anchor:\s*none/.test(rule(".trajectory-ledger")),
    "账本滚动容器必须关掉浏览器滚动锚定：账本位置由应用拥有（落点写 scrollTop、用户手势改它、" +
      "窗口计划按它算），而虚拟窗口重排（垫行↔真实行）正是原生锚定的触发条件——它自己挪走那 1px 之后，" +
      "落点收尾会把它当成「用户手滚」弃票，首次落点就裁掉半行（实测 auto 13.5/26px 可见、none 整行可见）",
  );
  const details = rule(".trajectory-details");
  assert.ok(
    /max-width:\s*calc\(100% - 280 \* var\(--dp\)\)/.test(details),
    "检查器的 max-width 要留 280 个设计像素给账本（官方 TABLE_MIN_WIDTH）",
  );
}
console.log("styles: 轨迹取历史同链路、概述摊开后几张卡片 ✓");

// ---------- 19. 轨迹记录配色对齐官方（输入绿 / 模型紫） ----------
//
// 用户 2026-09-14：「官方轨迹样式输入是绿色，模型是紫色，请对齐」。
// 官方那两个关键色调是 `contextGreen`（context）与 `assistantVioletBright`（message）；
// 账本种类标签与时间线的条共用同一套（官方时间线也是按 kind 着色）。
// 这里钉两件事：**色相**（token 本身是绿/紫）与**接线**（轨迹用的是这两个 token）。
{
  const tokens = readFileSync(
    join(process.cwd(), "src", "webview", "styles", "tokens.css"),
    "utf8",
  );
  assert.ok(
    /--node-read:\s*var\(--vscode-charts-green/.test(tokens),
    "--node-read 必须是绿色——轨迹的「上下文 / 输入」用它",
  );
  assert.ok(
    /--node-edit:\s*var\(--vscode-charts-purple/.test(tokens),
    "--node-edit 必须是紫色——轨迹的「助手 / 模型」用它",
  );

  const contextTag = rule(".trajectory-kind.is-context");
  const messageTag = rule(".trajectory-kind.is-message");
  const contextSpan = rule(".trajectory-span.is-context");
  const messageSpan = rule(".trajectory-span.is-message");
  assert.ok(/color:\s*var\(--node-read\)/.test(contextTag), "账本里「上下文」标签是绿的");
  assert.ok(/color:\s*var\(--node-edit\)/.test(messageTag), "账本里「助手」标签是紫的");
  assert.ok(/background:\s*var\(--node-read\)/.test(contextSpan), "时间线上「上下文」的条是绿的");
  assert.ok(/background:\s*var\(--node-edit\)/.test(messageSpan), "时间线上「助手」的条是紫的");
  assert.ok(
    /opacity:\s*1/.test(contextSpan) && /opacity:\s*1/.test(messageSpan),
    "有色调的条不透明度拉满（官方 span 只有中性那档是 .78）",
  );
  assert.ok(
    /opacity:\s*0\.78/.test(rule(".trajectory-span")),
    "时间线条的基准是中性 + .78 不透明度（官方 `._1p9O6q_span`）",
  );
  // 七种记录一个都不能漏（漏了会静默落回中性色，看着像「没实现」）
  for (const kind of ["system", "user", "context", "compacted", "message", "tool", "subtool"]) {
    assert.ok(
      new RegExp(`\\.trajectory-kind\\.is-${kind}\\s*\\{`).test(css),
      `记录种类 ${kind} 必须有配色（漏了会静默变中性）`,
    );
  }
  // 标签底色 = 该色调的淡色版（官方 kindTag 的 tertiary 底）
  //
  // **按行首锚定**取主规则：`rule(".trajectory-kind")` 会先命中
  // `.trajectory-row.is-error .trajectory-kind { color: ... }`（那个助手不做行首锚定，
  // 选择器更短就赢），拿到的根本不是主规则。
  const kindBase = /^\.trajectory-kind\s*\{([\s\S]*?)\}/mu.exec(css)?.[1] ?? "";
  assert.ok(kindBase.length > 50, "app.css 里找不到 .trajectory-kind 主规则");
  assert.ok(
    /background:\s*color-mix\(in srgb, currentColor/.test(kindBase),
    "种类标签的底色要跟着自己的色调走（官方 kindTag 的浅色底）",
  );
}
console.log("styles: 轨迹配色对齐官方（输入绿 / 模型紫）✓");

// ---------- 19b. 「（仅工具调用）」行的弱化色必须**压在** .trajectory-text 之后 ----------
//
// 官方 `TrajectoryTable.module.css` 的 `.toolCallOnly` 只是一条 `color: var(--label-tertiary)`；
// CSS **同特异性下后者胜**，我们这条 `.trajectory-text.is-tool-call-only` 的特异性比
// `.trajectory-text` 高（两个类），但如果将来有人把它挪到主规则前面、或主规则加了 `color`，
// 弱化色就会被吃掉——那正是「仅工具调用」行看着跟普通行一样的原因。
{
  const base = css.indexOf("\n.trajectory-text {");
  const muted = css.indexOf("\n.trajectory-text.is-tool-call-only {");
  assert.ok(base >= 0, "app.css 里找不到 .trajectory-text 主规则");
  assert.ok(muted >= 0, "app.css 里找不到 .trajectory-text.is-tool-call-only（「仅工具调用」行的弱化色）");
  assert.ok(muted > base, "弱化色必须写在 .trajectory-text 主规则之后（同特异性下后者胜）");
  assert.ok(
    /color:\s*var\(--muted\)/.test(rule(".trajectory-text.is-tool-call-only")),
    "「仅工具调用」行用中性弱化色（官方 `--label-tertiary` 的对应物是 --muted）",
  );
}
console.log("styles: 「（仅工具调用）」行的弱化色 + 书写次序 ✓");

// ---------- 19c. 请求边界小标记：真的有可点的圆点 + 悬停浮出的请求号胶囊 ----------
//
// 那枚小标记是**请求级检查器的唯一入口**（选项 / 用量含会话累计 / 请求计时都只能从它进），
// 所以它必须是可点的（`cursor: pointer`、`background: transparent` 的按钮），
// 而且**悬停提示走 `content: attr(data-label)`**——提示文案由界面按语言写进 `data-label`，
// CSS 不持有任何一句用户可见文字（本仓库的中英双语硬规则）。
{
  /**
   * 取一条规则体。**必须比 `rule()` 宽松**：选中态与悬停态写在同一个逗号组里
   * （`.is-active::before,\n.is-active:hover::before { … }`），`rule()` 找的是
   * 「选择器紧跟 `{`」，取不到组里的那个。
   */
  const bodyFor = (selector: string): string => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `app.css 里找不到选择器 ${selector}`);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  };
  const marker = bodyFor(".trajectory-request-marker {");
  assert.ok(/cursor:\s*pointer/.test(marker), "请求标记要能点（它是请求级检查器的唯一入口）");
  assert.ok(
    /position:\s*absolute/.test(marker) && /top:\s*calc\(-?[\d.]+ \* var\(--dp\)\)/.test(marker),
    "请求标记绝对定位、上移压在行缝之间（官方 `top:-8px` 的对应物），不占行高",
  );
  const dot = bodyFor(".trajectory-request-marker::before {");
  assert.ok(
    /width:\s*calc\([\d.]+ \* var\(--dp\)\)/.test(dot) && /border-radius:\s*50%/.test(dot),
    "圆点本体是 1:1 的圆、尺寸跟倍率走（裸 px 会被界面尺度那条断言抓住）",
  );
  assert.ok(
    /box-shadow:[^;]*var\(--bg\)/.test(dot),
    "圆点带一圈底色描边——不描的话它压在行缝上会被下面那行的背景吃掉",
  );
  const errorDot = bodyFor('.trajectory-request-marker[data-request-status="error"]::before');
  assert.ok(/background:\s*var\(--error\)/.test(errorDot), "失败请求的圆点涂红（按 data-request-status 分派）");
  const activeDot = bodyFor(".trajectory-request-marker.is-active::before");
  assert.ok(/background:\s*var\(--link\)/.test(activeDot), "选中的请求标记要看得出来（选中态与悬停态分开）");
  const tip = bodyFor(".trajectory-request-marker::after {");
  assert.ok(
    /content:\s*attr\(data-label\)/.test(tip),
    "悬停提示的文字来自 data-label（CSS 里不写死任何一句用户可见文案）",
  );
  assert.ok(
    /opacity:\s*0/.test(tip) && /pointer-events:\s*none/.test(tip),
    "提示默认藏起来且不吃鼠标（否则它会挡住自己那颗圆点的点击）",
  );
  assert.ok(
    /white-space:\s*nowrap/.test(tip),
    "提示不折行（「请求 #12 · 压缩」英文更长，折行会把胶囊撑成两行）",
  );
}
console.log("styles: 请求边界小标记（可点圆点 + data-label 悬停提示）✓");

// ---------- 34. 连接条按钮矩阵：判定在纯函数里，界面只渲染 ----------
//
// （2026-09-19）判定搬进 `src/webview/connectView.ts` 的 `connectViewOf` 之后，原先按渲染分支
// 形状写的两条正则（`{isConnecting ? ( … ) : ( … )}` 与查看日志按钮的 JSX）不再成立，而且其中
// 一条会退化成**空断言**（取到的分支为空串 → 恒真，防线静默消失）。矩阵本身改由
// `scripts/connectView.test.ts` 逐条断言（三类状态 × 每种标志、按钮顺序、置灰与悬停提示）。
// 这一组只留三件别处没人管的事：界面**没有**再自己判两轴/再塞回按钮、四颗目标按钮仍然真的有指令、
// `state.reconnecting` 没有复活。
// 注意：这个块注释里不能出现 `星号加斜杠` 这种序列（哪怕写在反引号里也会提前闭合注释，
// esbuild 会报一个指向很远行的 Syntax error）——所以下面把正则拆成字符串拼接。
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const flat = app.replace(/\s+/gu, " ");

  assert.ok(
    flat.includes("connectViewOf(state, texts"),
    "连接条必须渲染纯函数的结论（判定不在组件里）——否则「连接中只有停止+日志」这条又回到现场代码里",
  );
  assert.ok(
    !/state\.internalRunning\s*===|state\.externalState\s*===/u.test(flat),
    "界面不再自己判两轴（判定在 connectViewOf 里）",
  );
  assert.ok(
    !/\{state\.reconnecting/u.test(flat),
    "`state.reconnecting` 已随新机制删除（连接条文案改由 connectTarget / connectPhase 决定）",
  );
  // 四个目标按钮必须真的存在于界面（别只在 IPC 类型里存在）
  for (const kind of ["startInternal", "connectInternal", "connectExternal", "restartInternal"]) {
    assert.ok(flat.includes(`type: "${kind}"`), `按钮态缺少 ${kind}（界面漏了入口）`);
  }
}
console.log("styles: 连接条按钮矩阵（判定在纯函数里 / 四颗目标按钮仍有指令）✓");

// ---------- 35. 滚动条交给 VS Code 画，我们不自绘 ----------
//
// 用户 2026-09-15 报过「问卷自定义回答的编辑框一出现滚动条，右下角那块可拉动的标志就变成
// 白底」，当时的修法是自绘 `::-webkit-scrollbar-corner`（清成透明）与 `::-webkit-resizer`
// （自己画两道主题色斜线）。后来发现**这组规则在真机上一直是死的**：VS Code 的默认层给
// `html` 写了 `scrollbar-color`，而它一旦存在，Chromium 就改用标准滚动条、把
// `::-webkit-scrollbar*` 整组忽略——实测同一条 `::-webkit-scrollbar{width:30px}` 在没有
// `scrollbar-color` 时是 30px，有了就变回 15px（`scrollbar-width: thin` 压到 10px）。
// 用户 2026-10-03 的实测也印证了：字号调到很大滚动条也不变宽，因为那条宽度规则从未生效。
//
// 于是口径定成「**不接管**」：宽度、形状、配色全交给 VS Code 的主题（标准路径按轨道色画
// 拐角与拉伸角，白底那块不会再出现）。tokens.css 里不再留任何自绘规则——留着只会让人以为
// 它们是活的，还会在下一次改字号时被当成「该跟着缩放的东西」。
//
// 这条口径有个**验证盲区**必须一起钉住：预览页缺了 VS Code 默认层的 `scrollbar-color` 时，
// webkit 路径是活的，预览里能看到我们自己画的滚动条（10px、自绘滑块），与真机的 15px
// 标准滚动条不是一回事。所以预览页必须复刻那一条。
{
  const tokensRaw = readFileSync(
    join(process.cwd(), "src", "webview", "styles", "tokens.css"),
    "utf8",
  );
  // 注释里会提到这些选择器名（讲清为什么不留它们），先抹成等长空白再扫
  let tokens = tokensRaw;
  for (let i = tokens.indexOf("/*"); i >= 0; i = tokens.indexOf("/*", i + 2)) {
    const end = tokens.indexOf("*/", i + 2);
    const stop = end < 0 ? tokens.length : end + 2;
    tokens = `${tokens.slice(0, i)}${" ".repeat(stop - i)}${tokens.slice(stop)}`;
  }
  const painted = [...tokens.matchAll(/::-webkit-(?:scrollbar|resizer)[\w-]*/g)].map((m) => m[0]);
  assert.deepStrictEqual(
    painted,
    [],
    `tokens.css 里不许再有自绘滚动条规则（在 scrollbar-color 存在时它们整组被忽略）：${painted.join("、")}`,
  );

  const preview = readFileSync(join(process.cwd(), "test", "preview.html"), "utf8");
  assert.ok(
    /scrollbar-color:\s*[^;]+;/u.test(preview),
    "预览页必须复刻 VS Code 默认层的 `scrollbar-color`——少了它，预览里的滚动条与真机不是一回事",
  );
}
console.log("styles: 滚动条交给 VS Code（不自绘；预览复刻 scrollbar-color）✓");

// ---------- 36. 轨迹工具栏的开关按钮必须有「按下」的样子 ----------
//
// 用户 2026-09-15 口径：轨迹里的「时长 / 轮次 / 调用」按下去要有**被按下的选中效果**。
// 三个按钮的状态本来就在 `aria-pressed` 上（无障碍树一直是对的），但画面上**什么都没有**
// ——按下去分不出生效没，这正是被报的那件事。这里钉三样：
// 1. 三个按钮的状态确实挂在 `aria-pressed` 上（不是各写一个 class）；
// 2. `.btn[aria-pressed="true"]` 有按下态的底色（与其它「选中」同一套 `--active`）；
// 3. 那条规则排在 `.btn-ghost:hover` **之后**——同特异性下后者胜，顺序反了悬停就会
//    把按下态吃掉（`is-stop` 压过 `:hover` 就是踩过的同一个坑）。
{
  const component = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"),
    "utf8",
  );
  assert.ok(/aria-pressed=\{mode !== "sequence"\}/.test(component), "时长开关的状态要挂在 aria-pressed 上");
  assert.ok(/aria-pressed=\{allTurnsCollapsed\}/.test(component), "「轮次」折叠开关同理");
  assert.ok(/aria-pressed=\{allCallsCollapsed\}/.test(component), "「调用」折叠开关同理");

  const pressed = /\.btn\[aria-pressed="true"\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(pressed, 'app.css 必须有 `.btn[aria-pressed="true"]` 的按下态样式');
  assert.ok(
    /background:\s*var\(--active\)/.test((pressed as RegExpExecArray)[1]),
    "按下态要有底色（与 .icon-btn.is-active / 账本选中行同一套 --active）",
  );
  const pressedAt = css.indexOf('.btn[aria-pressed="true"]');
  const ghostHoverAt = css.indexOf(".btn-ghost:hover");
  assert.ok(ghostHoverAt > 0, "`.btn-ghost:hover` 应该在（按下态的排序基准）");
  assert.ok(
    pressedAt > ghostHoverAt,
    "按下态必须写在 `.btn-ghost:hover` 之后：同特异性后者胜，写在前面会被悬停吃掉",
  );
  // 悬停时也要看得出是按下（显式写一条，不靠源码顺序兜底）
  assert.ok(
    /\.btn\[aria-pressed="true"\]:hover\s*\{[^}]*var\(--active\)/.test(css),
    "悬停一条也要显式写：否则顺序一变，按下的按钮悬停时又变回 hover 底色",
  );
}
console.log("styles: 轨迹工具栏开关的按下态（aria-pressed + --active，压在 hover 之后）✓");

// ---------- 37. 轨迹顶条的光标：框选区域用文本 I 字，不许再有手掌 ----------
//
// 用户 2026-09-15 口径：轨迹顶条选中区域应当用输入光标的 I 字，而不是手掌。
// 此前未缩放时是十字线（crosshair）、缩放后是 grab/grabbing（手掌）——手掌正是
// 被点名的那个。这里钉三件事：
// 1. `.trajectory-plot` 的光标是 `text`（I 字，框选 = 文本选区的隐喻）；
// 2. app.css 里不许再有 grab/grabbing（手掌不许回来；右键平移保留、无光标暗示）；
// 3. TSX 里也不再发 `is-zoomed` 修饰类——它只为那颗手掌光标而存在，删了光标就该删它。
{
  const plot = rule(".trajectory-plot");
  assert.ok(
    /cursor:\s*text/.test(plot),
    "轨迹顶条的光标必须是 text（I 字；用户 2026-09-15 口径：框选区域用文本光标）",
  );
  assert.ok(
    !/cursor:\s*(grab|grabbing)/.test(css),
    "app.css 不许再有 grab/grabbing 手掌光标（用户点名的就是它）",
  );
  const trajectory = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"),
    "utf8",
  );
  assert.ok(
    !trajectory.includes("is-zoomed"),
    "Trajectory.tsx 不许再发 is-zoomed 修饰类——它只服务过那颗手掌光标",
  );
}
console.log("styles: 轨迹顶条光标 = 框选 I 字，手掌光标与 is-zoomed 已除 ✓");

// ---------- 38. 轮次起点的三种视觉（标签 / 分隔线 / 紧凑态）是**一组** ----------
//
// 官方同一个 `turnStart` 判据驱动三件事，它们互为前提，任缺一件都会走形：
//   ① 2px 全宽分隔线：`.trajectory-row.is-turn-start .trajectory-event::before`。
//      两条取消规则都不能漏——整张表的第一行不画、`trajectory-history-row` 之后那一行
//      不画（那是分页控件，不是轮次边界）。
//   ② 标签**绝对定位**在事件格力左上：这是「不占行高」的唯一来源。它一旦落回文档流，
//      带标签的行会比别的行高出一截（实测 43px vs 26px）——③ 的紧凑态也就无从谈起。
//   ③ 紧凑态由容器查询在两枚标签之间翻转。两枚的**隐藏态必须写在主规则里**（基线先藏、
//      查询里再放开），否则宽栏下两枚标签会同时可见、叠在 `grid-area` 的同一格里。
//
// 「待遇一致性」：种类标签的收窄分布（`padding: 0 calc(3 * var(--dp))`）在**两条**容器
// 查询里都要有，不能只在宽的那条或窄的那条给。
{
  /**
   * 取一条**顶层、只列这一个选择器**的规则的声明块。
   *
   * 三个坑都踩过，全写下来：
   *   1. `indexOf(选择器)` 会把分组规则里的同名类名当命中，取到别人的声明块；
   *   2. 同名选择器在 `@container` 里还有一份，`indexOf` 会先拿到它——所以先把
   *      `@container` 整块按大括号配对挖成等长空白（不是正则截断：`calc(...)` 带括号）；
   *   3. 光靠「顶格 + 后面是 `{`」**仍然分不出**分组规则的第二行——`.a,\n.b { … }` 里
   *      `.b` 也是顶格、后面也是 `{`。判据得看**前一个非空白字符**：是逗号就是分组里的
   *      一员，跳过它继续找下一条。
   */
  const bodyOf = (selector: string): string => {
    let text = css;
    for (let at = text.indexOf("@container"); at >= 0; at = text.indexOf("@container")) {
      const open = text.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (; end < text.length; end += 1) {
        if (text[end] === "{") depth += 1;
        else if (text[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      // 等长空白替换，偏移与行号都不变
      text = text.slice(0, at) + " ".repeat(end + 1 - at) + text.slice(end + 1);
    }
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const hit of text.matchAll(new RegExp(`(?:^|\\n)(${escaped}[ \\t]*)(?=\\{)`, "gm"))) {
      const start = hit.index + hit[0].length - hit[1].length;
      // 往左跳过空白，看前一个非空白字符：是逗号 ⇒ 它只是选择器分组里的一员（跳过）；
      // 是 `{` / `}` / 行首 ⇒ 这一条规则的选择器就只有它一个。
      let back = start - 1;
      while (back >= 0 && /\s/.test(text[back] as string)) back -= 1;
      if (text[back] === ",") continue;
      const open = text.indexOf("{", hit.index);
      const close = text.indexOf("}", open);
      return text.slice(open + 1, close);
    }
    assert.fail(`app.css 顶层找不到**单选择器**规则 ${selector}（分组规则里的成员不算）`);
  };

  // ① 分隔线：骑在行缝上的 2px 全宽线
  const separator = bodyOf(".trajectory-row.is-turn-start:not(:first-child) .trajectory-event::before");
  assert.ok(
    /position:\s*absolute/.test(separator) && /height:\s*calc\(2 \* var\(--dp\)\)/.test(separator),
    "轮次首行要有 2px 全宽分隔线（官方 `td::before` 的那条）",
  );
  assert.ok(
    /transform:\s*translateY\(-50%\)/.test(separator),
    "分隔线要 `translateY(-50%)` 骑在行缝上——不translate 就画在行内部、看着像多了一条线",
  );
  assert.ok(
    /left:\s*0/.test(separator) && /right:\s*0/.test(separator),
    "分隔线要**全宽**（左右都贴到 0），只画事件列宽度就不是轮次边界了",
  );
  // 两条取消规则
  assert.ok(
    css.includes(".trajectory-history-row + .trajectory-row.is-turn-start .trajectory-event::before") &&
      /content:\s*none/.test(
        bodyOf(".trajectory-history-row + .trajectory-row.is-turn-start .trajectory-event::before"),
      ),
    "「加载更早的历史」之后那一行不许画轮次分隔线（官方 `.historyLoadRow + tr[data-turn-start] td::before { content: none }`）",
  );
  assert.ok(
    /:not\(:first-child\)/.test(css.slice(css.indexOf(".trajectory-row.is-turn-start"), css.indexOf(".trajectory-row.is-turn-start") + 120)),
    "整张表的第一行不画轮次分隔线（上面没有东西可分）",
  );

  // ② 标签绝对定位 + 事件格预留左内边距
  const label = bodyOf(".trajectory-turn-label");
  assert.ok(
    /position:\s*absolute/.test(label) && /top:\s*0/.test(label) && /left:\s*0/.test(label),
    "轮次标签必须绝对定位在事件格左上——在流里就会把行撑高（③ 的紧凑态依赖它不占行高）",
  );
  assert.ok(
    /width:\s*max-content/.test(label),
    "标签宽度 `max-content`（官方 `turnLabel`）：定宽会让「第 10 轮」这种更长的文案被截",
  );
  assert.ok(
    !/max-width:\s*100%/.test(label),
    "标签不许写 `max-width: 100%`：百分比按事件格的 padding box 算（英文 122 的列减掉左 36 右 4 只剩 82，" +
      "中文那一档更少），而「第 10 轮」就有 51 宽——一 clamp 就换行、把行撑高，正是绝对定位要避免的事",
  );
  // 定位祖先与裁剪口径写在**另一条** `.trajectory-event` 规则里（那里同时挂着请求边界
  // 小标记的理由注释），所以按「同名顶层规则的合集」查，而不是只看第一条。
  const eventRules = [...css.matchAll(/^\.trajectory-event\s*\{([\s\S]*?)\}/gmu)].map(m => m[1]).join("\n");
  assert.ok(eventRules.length > 0, "app.css 顶层找不到 .trajectory-event 规则");
  assert.ok(
    /padding:[^;]*calc\(36 \* var\(--dp\)\)/.test(eventRules),
    "事件格要预留 36 的左侧留白给轮次标签（官方 `.event` 的 `padding-left: 36px`），否则标签压在 #N 与种类标签上",
  );
  assert.ok(
    /position:\s*relative/.test(eventRules) && /overflow:\s*visible/.test(eventRules),
    "事件格要 `position: relative` + `overflow: visible`：标签与 -50% 的分隔线都挂在它身上，单元格自带的 `overflow: hidden` 会把两者裁掉",
  );
  // 内容条的高度对齐口径：`inline-flex` + `vertical-align: top`。
  // **不许改成块级 flex + `height: 100%`**（那样最像官方 `.eventInner`）：块级盒会让工具 /
  // 子工具行的行高从 26 缩到 25（实测）；只写 `inline-flex` 不给 `vertical-align: top`
  // 又会让带标签的行内容低 2px。两个失效方向都钉住。
  const inner = bodyOf(".trajectory-event-inner");
  assert.ok(
    /display:\s*inline-flex/.test(inner),
    "内容条要 `inline-flex`：块级 flex 会把工具行的行高从 26 缩到 25",
  );
  assert.ok(
    /vertical-align:\s*top/.test(inner),
    "内容条要 `vertical-align: top`：少了它，有轮次标签的行内容比别的行低 2px",
  );
  assert.ok(
    !/height:\s*100%/.test(inner),
    "内容条不许写 `height: 100%`（照着官方 `.eventInner` 抄会踩上面那条行高坑）",
  );

  // ③ 两枚标签的隐藏态写在主规则里，紧凑态在容器查询里翻转
  //
  // 两枚标签**叠在同一格里**（官方那两枚的 `grid-area: 1 / 1`）：全宽那枚靠上面那条
  // 分组规则放出来（`max-width: 64px` + `opacity: 1`），紧凑那枚在主规则里先藏起来、
  // 到 620 那一档才放开。基线不藏的话宽栏下两枚会同时可见。
  const stacked = /\.trajectory-turn-label-full,\s+\.trajectory-turn-label-compact\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(
    /grid-area:\s*1 \/ 1/.test(stacked) && /opacity:\s*1/.test(stacked),
    "两枚标签要叠在同一格（`grid-area: 1 / 1`）且默认放出来的是全宽那枚——分组规则的 `.trajectory-turn-label-full, .trajectory-turn-label-compact`",
  );
  const compactLabel = bodyOf(".trajectory-turn-label-compact");
  assert.ok(
    /max-width:\s*0/.test(compactLabel) && /opacity:\s*0/.test(compactLabel),
    "紧凑标签的隐藏态（max-width: 0 + opacity: 0）必须写在主规则里，不能只写在容器查询里——否则宽栏下两枚同时可见",
  );
  /**
   * 取一条容器查询的整个块。**不能正则截到第一个 `\n}`**：块里每条规则自带一个 `}`，
   * 那样只会拿到第一条规则就断掉（原来就是这么写的，`trajectory-kind` 那条恰好排在最后
   * 才没暴露）。按大括号配对取。
   */
  const queryBody = (condition: string): string => {
    const at = css.indexOf(`@container (${condition})`);
    assert.ok(at >= 0, `app.css 里找不到容器查询 ${condition}`);
    const open = css.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return css.slice(open + 1, end);
  };

  // 紧凑形态**只挂在 420 那一条线上**（与事件列收窄同一档）。
  //
  // 照官方另加一条 620 是错的：官方把「收列」与「换紧凑形态」都放在它的 620，而本扩展
  // 收列在 420——多出来的那条会让 420~620 之间「列还宽着、标签已经缩成 `#N`」。这里钉三件：
  // ① 420 那一档里四种翻转齐全；② 不许再有 620 那条线；③ 收列与换形态同档。
  assert.ok(
    !/calc\(620em \/ 13\)/.test(css),
    "不许再有 620 那条容器查询：它会让 420~620 之间出现「列还宽、标签已紧凑」的中间态",
  );
  const narrowQuery = queryBody("max-width: calc(420em / 13)");
  assert.ok(
    /\.trajectory-turn-label-full\s*\{[^}]*max-width:\s*0/.test(narrowQuery) &&
      /\.trajectory-turn-label-compact\s*\{[^}]*opacity:\s*1/.test(narrowQuery),
    "420 那一档要把全宽轮次标签收起、紧凑 `#N` 放开",
  );
  // 收列那条的**选择器组里必须有 `:lang(zh)` 那一份**：中文档位（96）写在容器查询外面且
  // 多一个伪类，窄栏只写 `.trajectory-col-event` 的话中文下收列会静默失效（同特异性下
  // 源序在后的 `:lang(zh)` 赢），窄栏里留着 96 的列、旁边站着 19 的方徽章。
  assert.ok(
    /\.trajectory-col-event,\s*\.trajectory-col-event:lang\(zh\)\s*\{[^}]*calc\(50 \* var\(--dp\)\)/.test(
      narrowQuery,
    ),
    "换紧凑形态与事件列收成 50 必须在同一档，且**按语言的两条都要收**（`:lang(zh)` 那份漏了会静默失效）",
  );
  assert.ok(
    /\.trajectory-event\s+\.trajectory-kind\s*\{[^}]*padding:\s*0 calc\(3 \* var\(--dp\)\)/.test(narrowQuery),
    "420 那一档要把种类标签的左右内边距收到 3（50 的列宽下不收就顶出列），" +
      "且这条**必须限定在账本事件格里**——不限作用域会把检查器标题那枚纯文本徽章也压成 " +
      "19dp（见下面 ④ 的实测数字）",
  );

  // ③ 事件列宽度**按语言分档**（官方 `.eventColumn` 122 / `:where(:lang(zh))` 84；
  //    本扩展中文取 96，理由见下面那条断言）
  //
  // 这一档与容器查询无关，是两套并存的宽栏档位：中文种类标签（「已压缩」/「助手」）比
  // 英文（`COMPACTED` / `ASSISTANT`）短一半以上，照抄 122 等于白占内容列 38。
  // 语言由界面写在**根元素**上（`App.tsx` 的 insertion effect），所以 `:lang()` 能匹配到
  // 每一条规则——这条链路断开时 CSS 不会报错，只会静默用英文档位（两处钉住）。
  assert.ok(
    /\.trajectory-col-event\s*\{[^}]*calc\(122 \* var\(--dp\)\)/.test(css),
    "英文（默认）下事件列 122（官方 `.eventColumn`）",
  );
  assert.ok(
    /\.trajectory-col-event:lang\(zh\)\s*\{[^}]*calc\(96 \* var\(--dp\)\)/.test(css),
    "中文下保留事件列 96：种类徽章、状态点与轮次标签仍需空间，移除记录编号不连带改变列宽",
  );
  {
    const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
    assert.ok(
      /document\.documentElement\.lang\s*=\s*normalizeLocale\(state\.locale\)/.test(app),
      "界面要把归一化后的语言写到根元素的 `lang` 上，`:lang(zh)` 那一档才有依据——" +
        "`:lang()` 按子标签前缀匹配，`zh` 覆盖 `zh-cn` / `zh-tw` 等全部中文变体",
    );
  }

  // ④ 种类徽章里的纯图标那一档（官方 `kindTagIcon` / `kindTagLabel`）
  const kindIcon = bodyOf(".trajectory-kind-icon");
  assert.ok(
    /width:\s*0/.test(kindIcon) && /opacity:\s*0/.test(kindIcon),
    "字形那枚默认宽 0 透明——宽栏显示文字那枚，窄栏才由容器查询放开",
  );
  assert.ok(
    /flex:\s*none/.test(kindIcon),
    "字形那枚必须 `flex: none`：不给的话它在宽栏零宽状态下被 flex 收成 0 宽，窄栏放开 `width` 也长不回来",
  );
  assert.ok(
    /\.trajectory-kind-icon\s*\{[^}]*width:\s*calc\(13 \* var\(--dp\)\)/.test(narrowQuery) &&
      /\.trajectory-kind-icon\s*\{[^}]*opacity:\s*1/.test(narrowQuery),
    "420 那一档要把字形放开（官方窄栏是 13px 的纯图标）",
  );
  assert.ok(
    /\.trajectory-kind-label\s*\{[^}]*max-width:\s*0/.test(narrowQuery) &&
      !/display:\s*none/.test(bodyOf(".trajectory-kind-label")),
    "文字那枚收到 0 宽即可，**不许 `display: none`**——留它在 DOM 里，读屏与搜索还拿得到种类词",
  );
  // 七种记录都要有字形，漏一种窄栏下那一种会变成空徽章
  {
    const trajectory = readFileSync(
      join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"),
      "utf8",
    );
    const map = /const KIND_ICON[\s\S]*?\n\};/.exec(trajectory)?.[0] ?? "";
    assert.ok(map.length > 0, "Trajectory.tsx 里找不到 KIND_ICON 映射");
    for (const kind of ["system", "user", "context", "compacted", "message", "tool", "subtool"]) {
      assert.ok(
        new RegExp(`\\b${kind}:`).test(map),
        `KIND_ICON 缺 ${kind} 的字形——窄栏下那一种记录会渲染成空徽章`,
      );
    }
  }

  // ④ 420 档的种类徽章规则只作用于账本事件格；所有宽度下均不渲染记录序号
  //
  // 官方那句 `.kindTag { width: 19px; padding: 0 }` 写在 `@container trajectory-table`
  // 里，具名容器声明在**账本滚动区** `.tablePane` 上，而检查器是它的兄弟节点——那句规则
  // 永远碰不到检查器标题。我们这条容器挂在整页 `.trajectory-view` 上（账本与检查器都是
  // 它的后代），照抄就会把标题那枚**纯文本**徽章也压成 19dp（`border-box` 下内容盒只剩
  // 13dp），「助手」这类种类词必然被裁——主代理 420px 生产 DOM 实测：标题徽章宽 19、
  // 真实文字宽 49.296875。收作用域是这条差异的正解（不是把 19dp 放宽）。
  //
  // 官方账本不显示记录序号，因此直接移除渲染节点，而不是仅在窄栏藏起来。
  // `data-cell-index` 与选择行为继续保留，序号仍是时间线定位的内部身份。
  {
    const stripped = narrowQuery.replace(/\/\*[\s\S]*?\*\//g, "");
    const kindSelectors = [...stripped.matchAll(/([^{}]*\.trajectory-kind[^{}]*)\{/g)].map((m) => m[1].trim());
    assert.ok(kindSelectors.length > 0, "420 档里找不到种类徽章的紧凑规则");
    for (const selector of kindSelectors) {
      assert.ok(
        selector.split(",").every((one) => one.includes(".trajectory-event")),
        "420 档的种类徽章规则必须限定在账本事件格（`.trajectory-event`）里——检查器标题里" +
          "那枚是**纯文本**（没有 icon/label 两枚可对调），被同一条规则压成 19dp 后种类词" +
          `必然被裁：现在是「${selector}」`,
      );
    }
    const trajectory = readFileSync(
      join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"),
      "utf8",
    );
    assert.ok(!/trajectory-index/.test(trajectory), "所有宽度下均不渲染节点前的记录 #编号，与官方账本一致");
    assert.ok(!/\.trajectory-index\s*\{/.test(css), "移除编号后不得保留仅用于它的样式");
    assert.ok(
      /data-cell-index=\{cell\.index\}/.test(trajectory) && /port\.selectRecord\(cell\.index\)/.test(trajectory),
      "记录编号只从呈现移除：时间线定位与行选择仍使用原记录身份",
    );
    assert.ok(
      /\.trajectory-details-title-record\s+\.trajectory-kind\s*\{[^}]*flex:\s*0 0 auto/.test(css),
      "检查器标题里的种类徽章要 `flex: 0 0 auto`（按内容取宽）：它没有可对调的 icon/label 两枚，" +
        "窄档规则一旦收到它身上就会被压成 19dp",
    );
  }

  // ⑤ 折叠一轮时保留哪些行（官方 `collapseTurnRecords()`）
  //
  // 官方折叠**不是**「整轮变成一枚摘要行」：该轮的 system 行与 requestOnly 请求锚点行
  // 照常显示，第一条**内容行**也留着，摘要只代表它**之后**那批。从前本扩展整轮只出一枚
  // 摘要行，把提示词变更、上下文行、全场唯一的助手回复一起收掉了。
  // 这里钉住那三条判据（保留 system / requestOnly、留第一条内容行、其余进摘要且摘要用
  // `content.slice(1)` 那个切片）。
  {
    const ledgerRows = readFileSync(
      join(process.cwd(), "src", "webview", "trajectoryLedgerRows.ts"),
      "utf8",
    );
    /**
     * 取「折叠一轮」那一段源码。
     *
     * 锚点跟着实现走：2026-10-05 加了账本虚拟化，这一段从「渲染时逐行判」搬进了
     * `selectedRowIndexes` 那一趟；**2026-10-09 又整体搬进了 `trajectoryLedgerRows.ts`**
     * （行投影独占搜索优先折叠、轮次/调用折叠与轮次标签落点）——判据一个字没动。
     */
    const at = ledgerRows.indexOf("const summaryAfter");
    const until = ledgerRows.indexOf("markTurnStarts(rows)", at);
    const collapsed = at >= 0 && until > at ? ledgerRows.slice(at, until) : "";
    assert.ok(collapsed.length > 0, "trajectoryLedgerRows.ts 里找不到折叠一轮那个分支");
    assert.ok(
      /cell\.requestOnly !== true && cell\.kind !== "system" && position !== summaryAfter/.test(collapsed),
      "折叠时只丢掉「第一条内容行之后」的内容行：system 行与 requestOnly 请求锚点行必须照常显示" +
        "（官方 `collapseTurnRecords()` 对这两类直接 `return [record]`）",
    );
    assert.ok(
      /cells\.indexOf\(content\[0\]\)/.test(collapsed) && /content\[0\] !== undefined/.test(collapsed),
      "第一条内容行要留着（官方 `record.cell.index !== contentRecords[0]?.cell.index` 才丢），" +
        "摘要行贴在它后面——位次按「第一条内容行在原始列表里的位置」现算",
    );
    assert.ok(
      /content\.length > 1/.test(collapsed),
      "内容行不多于一条时整轮一行都不收（官方 `contentRecords.length <= 1` 原样返回），" +
        "否则会把唯一那条回复收进摘要",
    );

    // 行为：用**组件同一个函数**把这三条判据跑一遍（源码正则只说明「写了」，
    // 这里说明「真的是这个结果」）
    const cell = (index: number, kind: TrajectoryCell["kind"], extra: Partial<TrajectoryCell> = {}): TrajectoryCell => ({
      index,
      kind,
      turn: 0,
      seq: index,
      time: index,
      text: `#${index}`,
      timeSeconds: null,
      startedAt: null,
      ...extra,
    });
    const turn: TrajectoryTurn = {
      turn: 0,
      groups: [
        {
          title: { kind: "step", step: 1 },
          cells: [
            cell(1, "system", { systemPromptDetail: "s" }),
            cell(2, "context", { requestOnly: true }),
            cell(3, "user"),
            cell(4, "tool", { callId: "c" }),
            cell(5, "context"),
          ],
        },
      ],
    };
    assert.deepStrictEqual(
      trajectoryLedgerRows({
        turns: [turn],
        collapsedTurns: new Set([0]),
        collapsedCalls: new Set<string>(),
        matchIndexes: null,
      }).map((row) => (row.summary === undefined ? row.cellIndex : "summary")),
      [1, 2, 3, "summary"],
      "收起一轮：system / requestOnly / 第一条内容行留着，摘要行紧随其后（其余内容行收进摘要）",
    );
    const single: TrajectoryTurn = {
      turn: 0,
      groups: [{ title: { kind: "message" }, cells: [cell(1, "user")] }],
    };
    assert.deepStrictEqual(
      trajectoryLedgerRows({
        turns: [single],
        collapsedTurns: new Set([0]),
        collapsedCalls: new Set<string>(),
        matchIndexes: null,
      }).map((row) => row.cellIndex),
      [1],
      "内容行只有一条时整轮一行都不收（否则唯一那条回复会被收进摘要）",
    );
  }
}
console.log(
  "styles: 轮次起点三种视觉（标签绝对定位 / 2px 分隔线 / 420 紧凑态含纯图标）+ 事件列按语言分档（122/96）+ 折叠保留行 ✓",
);

// ---------- 36. 顶部两颗「打开」按钮必须是两个不同的图标 ----------
//
// 用户 2026-09-15 报：「在浏览器中打开」的图标和在编辑区中打开的一模一样。
// 根因是两者都画成「方框 + 右上角箭头」——`IconExternal`（文件链接行在用）与
// `IconOpenInEditor` 只差一条斜线的长短（`M20 4l-8 8` vs `M20 4l-8.5 8.5`），
// 15px 下分不出来。浏览器那颗改成 `IconGlobe`（VS Code 自己的 Simple Browser
// 也是地球）。这条断言按**图标组件名**钉住两者不同——形状相似是肉眼很难复查的
// 一类回归，而"顺手换成同一个"又极其自然（我就是这么写错的）。
//
// 第三种形态是：那颗按钮在**当前连的是桌面端内置服务**时改开桌面端应用窗口
// （`state.desktopConnected` 二分，见 `docs/design-desktop.md`「浏览器访问」）。
// 三颗「打开」类的图标两两不同（编辑区 = 方框箭头 / 浏览器 = 地球 / 桌面端 = 显示器），
// 同一颗按钮在两种形态间切换时，用户看的正是图标有没有变。
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const editorIcon = /type: "openInEditor"[\s\S]{0,160}?<(\w+)/.exec(app)?.[1];
  const browserIcon = /type: "openInBrowser"[\s\S]{0,160}?<(\w+)/.exec(app)?.[1];
  const desktopIcon = /type: "openDesktop"[\s\S]{0,160}?<(\w+)/.exec(app)?.[1];
  assert.ok(editorIcon && browserIcon && desktopIcon, "顶部三颗「打开」按钮都应当存在");
  assert.notStrictEqual(
    browserIcon,
    editorIcon,
    `「在浏览器中打开」与「在编辑器中打开」不能用同一个图标（都是 ${browserIcon}）` +
      "——用户报过它们看起来一模一样",
  );
  assert.strictEqual(editorIcon, "IconOpenInEditor", "「在编辑器中打开」的图标");
  assert.strictEqual(
    browserIcon,
    "IconGlobe",
    "「在浏览器中打开」用地球（VS Code 的 Simple Browser 同款）",
  );
  assert.strictEqual(desktopIcon, "IconDesktop", "「打开 DSH 桌面端」的图标（显示器）");
  // 「打开」那颗按钮的两种形态必须**看得出换了**：它就在同一格里、同一个位置
  assert.notStrictEqual(desktopIcon, browserIcon, "桌面端形态不能沿用地球");
  assert.notStrictEqual(desktopIcon, editorIcon, "桌面端形态不能与「在编辑器中打开」撞图标");
  assert.ok(
    /state\.desktopConnected\s*\?/.test(app),
    "那颗按钮必须按 state.desktopConnected 二分（否则连桌面端时仍会去开浏览器）",
  );
}
console.log("styles: 三颗「打开」按钮图标两两不同（编辑区=方框箭头 / 浏览器=地球 / 桌面端=显示器）✓");

// ---------- 37. 贴底：意愿只由手势决定，几何只负责续跟 ----------
//
// 用户 2026-09-16 报：「正常贴底生成着，突然就不知道为什么就不贴底了」。根因是
// **从滚动几何里推断意愿**：`scroll` 事件是异步派发的，处理器当场读的 `scrollTop`
// 可能来自已经过去的布局（位置被浏览器夹过），而 `scrollHeight` 来自当前布局。
// 旧实现那条「`scrollTop` 变小 ⇒ 用户上滑了」把"浏览器自己夹一下位置"误判成用户操作，
// `stick=false` 之后没有任何东西会翻回来（探针 P1 复现；同类还有端口变矮 P2、
// 展开豁免 P3、面板隐藏/恢复 P6）。
//
// 2026-09-19：整条链路收进 `src/webview/autoScroll.ts`。**行为断言搬去了
// `scripts/autoScroll.test.ts`**（真调用状态机 + 假 DOM 真派发事件），这里只留
// **接线**那一层——那是另一种事实（跨文件的数据流），正则恰好是合适的工具。
{
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  const scroller = /\.chat-scroll \{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
  assert.ok(scroller, "app.css 里必须有 .chat-scroll 规则");
  assert.ok(
    /overflow-anchor:\s*none/.test(scroller),
    ".chat-scroll 必须关掉浏览器滚动锚定——否则「展开」把上方内容顶到视野外（用户报的向上挤）",
  );

  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const module = readFileSync(join(process.cwd(), "src", "webview", "autoScroll.ts"), "utf8");

  // ① 规则只在一个地方：`App.tsx` 里不许再有这条链路的实现痕迹
  assert.ok(
    /import \{ useAutoScroll \} from "\.\/autoScroll";/.test(app),
    "App.tsx 要从 autoScroll 模块取 hook（接线），而不是自己实现",
  );
  assert.ok(
    !/function useAutoScroll/.test(app),
    "App.tsx 里不许再有 useAutoScroll 的实现：规则跨文件散着放，加一处端口就得动所有调用点",
  );
  assert.ok(
    !/followRef|stickRef/.test(app),
    "App.tsx 里不许再有意愿状态（followRef）或几何推断的记忆值（stickRef）——它们全在 autoScroll 模块里",
  );
  assert.ok(
    !/EXPAND_READ_GRACE_MS|expandedAtRef|onTranscriptClick|hasSelectionInside/.test(app),
    "展开豁免（500ms 时间窗 + aria-expanded 点击捕获）与划选豁免不许回来：跳过之后没有任何东西会再触发判定（实测「点了工具行就永久不恢复」）",
  );
  assert.ok(
    !/addEventListener\("wheel"|addEventListener\("touchstart"|gestureRecently|requestAnimationFrame/.test(app),
    "App.tsx 不许自己接线滚动信号（滚轮 / 触摸 / 手势判定 / rAF 合并都在 autoScroll 模块里）；它只留「滚到顶取更早历史」那一条监听",
  );

  // 意愿置假只有两个入口：① 手势 + 确实离底（onScroll）；② 轮次横条的显式释放
  // （`release()`——程序化滚动不算手势，不显式放掉的话 settle 会把视口钉回底部，
  // 跳转等于没跳）。出现第三个就是几何推断回来了。
  const followWrites = (module.match(/following = false;/g) ?? []).length;
  assert.strictEqual(
    followWrites,
    2,
    "脱离跟随只允许「手势离底」与「显式 release」两个入口（模块里两处写入），出现第三个就是几何推断回来了",
  );
  assert.ok(
    /else if \(this\.gestures\.recently\(now\)\)/.test(module),
    "脱贴必须同时满足「近期有手势 + 确实离底」：没有手势的离底（位置被浏览器夹走 / 重排 / 端口变矮）是布局事故，不许写成脱贴",
  );
  assert.ok(
    /recently\(now: number\): boolean \{\s*\n\s*return active \|\|/.test(module),
    "手势判据要包含「按下到松开」的活跃区间（触摸、拖滚动条）",
  );

  // ③ 模块里：信号面齐备（少一个就会在真实场景里丢一次钉底）
  assert.ok(
    /addEventListener\("wheel"/.test(module) && /deltaY < 0/.test(module),
    "滚轮向上要记手势（向下滚不该脱贴）",
  );
  assert.ok(/PageUp[\s\S]{0,80}ArrowUp/.test(module), "键盘上翻（PageUp/Home/ArrowUp）要记手势");
  assert.ok(
    /clientX - rectLeft > clientWidth/.test(module),
    "拖滚动条（滑块与轨道都在 clientWidth 右边）要记手势",
  );
  assert.ok(/"touchstart"/.test(module) && /"touchend"/.test(module), "触摸要记手势");
  assert.ok(/onHostFrame\(schedule\)/.test(module), "宿主来过一帧就要重新判定一次（「新生成到达」最早、且不依赖 RO 时序的信号）");
  assert.ok(/observeResize\(content, schedule\)/.test(module), "内容（.chat-list）长高是跟随的主入口，不能删");
  assert.ok(
    /observeResize\(el, schedule\)/.test(module),
    "滚动端口自身（.chat-scroll）变矮也要重新判定：插话排队条/提示条/待办面板挤矮它时不会触发 scroll 事件",
  );
  assert.ok(
    /addEventListener\("visibilitychange"/.test(module) && /addEventListener\("focus", schedule\)/.test(module),
    "可见性 / 焦点变化要重新判定（面板隐藏期间推帧、再显示时必须贴回底部）",
  );

  // ④ 幂等钉底：合并到 rAF，赋值只在「想跟」分支里；胶囊按实测距离亮
  assert.ok(/requestAnimationFrame\(callback\)/.test(module), "钉底要合并到下一帧（绘制之前跑，不闪）");
  assert.ok(
    /if \(state\.following\) \{\s*\n\s*if \(dist > 0\) el\.scrollTop = el\.scrollHeight;/.test(module),
    "跟随本体：想跟就把视口钉到底（幂等）",
  );
  assert.ok(
    /setShowJump\(dist > STICK_THRESHOLD_PX\)/.test(module),
    "胶囊按**实测距离**亮：脱贴且确实离底才亮，贴底即隐（不能出现「脱贴了没胶囊」或「没脱贴却亮着」）",
  );

  // ⑤ 「显式要最新」只有一处实现：切会话 / 点胶囊 / 发消息共用 `rearm()`
  assert.ok(
    /rearm\(\): void \{\s*\n\s*following = true;/.test(module),
    "「显式要最新」只能有一处实现（`rearm`）：切会话、点胶囊、发消息三条入口共用它，谁都不会各自漂移",
  );
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(/chatScroll\?: AutoScrollPort;/.test(composer), "Composer 要接滚动端口的**唯一对象**（不再各接一半）");
  assert.ok(
    /chatScroll\?\.scrollEl\.current/.test(composer),
    "Composer 从端口取滚动容器（自适应量高的瞬态补回要用它）",
  );
  assert.ok(
    /post\(\{ type: "send"[\s\S]{0,400}?onFollowLatest\?\.\(\)/.test(composer),
    "发消息 = 要看最新（官方 useAutoScroll 同口径）：脱贴状态下发出去也要贴回底部",
  );
  assert.ok(
    /post\(\{ type: "queueSteer"[\s\S]{0,200}?onFollowLatest\?\.\(\)/.test(composer),
    "把排队消息立刻发出去同样是「要看最新」",
  );
  assert.ok(/onFollowLatest\?: \(\) => void;/.test(composer), "Composer 要接「用户要看最新」回调");
  assert.ok(
    /<Lump state=\{state\} onFollowLatest=\{onFollowLatest\} \/>/.test(composer),
    "排队条（Lump）的「立刻发出」也要能要最新：Composer 必须把同一份动作透传下去（这是组件内部的接线，端口收敛动不到它）",
  );
  assert.ok(
    /onFollowLatest=\{chatScroll\.jumpToLatest\}/.test(app),
    "App 要把回底动作从 module 的绑定里接给 Composer",
  );

  // ⑥ 布局阶段钉底：切会话 / 从轨迹视图回来必须在 layout effect 里完成
  //    （挪到 useEffect 就会先画一帧旧位置，用户看到的就是一次闪）
  assert.ok(
    /useLayoutEffect\(\(\) => \{\s*\n\s*port\.pin\(\);/.test(module),
    "切会话的贴底必须在 useLayoutEffect 里（`port.pin()` 是那个 effect 的第一件事）",
  );
  assert.ok(
    /useLayoutEffect\(\(\) => \{\s*\n\s*const handle = setupAutoScroll/.test(module),
    "从轨迹视图回来时的挂载与按意愿复原也要在 useLayoutEffect 里",
  );
  assert.ok(
    /\}, \[sessionId, port, state\]\);/.test(module),
    "切会话那条 effect 要依赖 sessionId（切会话重置贴底并回最新）",
  );

  // ⑦ 不变量探针必须在仓库里：这一类故障（位置被夹 / 端口变矮 / 展开 / 隐藏恢复）
  //    没有别的回归锁，靠人肉想场景一定漏（它已经漏了三轮）。
  assert.ok(
    existsSync(join(process.cwd(), "test", "scroll-probe.html")),
    "贴底不变量探针 test/scroll-probe.html 必须在场（npm run preview 打开即可跑）",
  );

  // ⑧ 「回到最新」胶囊：脱贴兜底（旧实现 stick 被打掉后无任何恢复途径）
  assert.ok(
    /className="jump-latest"/.test(app) && /\.jump-latest \{/.test(css),
    "脱贴后必须有「回到最新」胶囊（界面 + 样式都在场）",
  );
  assert.ok(
    /chatScroll\.showJump \? \(/.test(app) && /onClick=\{chatScroll\.jumpToLatest\}/.test(app),
    "胶囊的显隐与点击都从 module 的绑定取（App 不再自己算）",
  );
  assert.strictEqual(dictionaryFor("zh").jumpToLatest, "回到最新", "胶囊文案必须中英双语都在词典里（中文）");
  assert.strictEqual(dictionaryFor("en").jumpToLatest, "Jump to latest", "胶囊文案必须中英双语都在词典里（英文）");

  // ⑨ App 只剩接线：两个 ref + 一个端口对象交给组件，历史翻页仍走同一个滚动容器
  assert.ok(
    /const chatScroll = useAutoScroll\(chatActive, sessionId\);/.test(app),
    "App 调 hook（吃 active + sessionId），拿到的就是全部",
  );
  assert.ok(
    /const \{ loadEarlier, loadThrough, loading: loadingEarlier \} = useHistoryPaging\(scrollRef, state\);/.test(app),
    "历史翻页仍用同一个滚动容器（端口不改变这条链路的入口）；两个档位都从这一个 hook 取",
  );
  assert.ok(
    /ref=\{chatScroll\.port\.scrollEl\}/.test(app) && /ref=\{chatScroll\.port\.contentEl\}/.test(app),
    ".chat-scroll / .chat-list 的 ref 来自端口（谁拥有容器谁就拥有这条链路）",
  );
}
console.log("styles: 贴底（规则在 autoScroll.ts；App 只剩接线；回底胶囊）✓");

// ---------- 19. 计划审阅卡：只有一个滚动层，且决定按钮不会被滚走 ----------
//
// 官方 `PlanReviewPanel` 是「条带 + 可滚动的计划正文 + 底部决定行」，卡片自己有
// `max-height: min(60vh, 520px)`。而输入区那个容器本来就限高内滚
// （`.composer-interaction`，为多题问卷设的）——两层叠起来会出现两条滚动条，
// 而且**决定按钮会被外层滚走**（计划几百行时，用户得先滚到底才能点「确认执行」）。
// 所以这个形态下外层让位（不设限、不滚动），限高只有卡片自己一处。
{
  const body = rule(".plan-review-body");
  assert.ok(
    /overflow-y:\s*auto/.test(body) && /min-height:\s*0/.test(body),
    "计划正文必须自己内滚（flex 子项要配 min-height: 0，否则它会被内容撑开、根本滚不起来）",
  );
  const card = rule(".plan-review");
  assert.ok(
    /max-height:\s*min\(60vh/.test(card) && /overflow:\s*hidden/.test(card),
    "卡片按官方口径限高（min(60vh, 520 设计像素)）并裁掉溢出，滚动交给正文那一段",
  );
  assert.ok(
    /max-height:\s*none/.test(rule(".composer-interaction.is-plan-review")) ||
      /overflow:\s*visible/.test(rule(".composer-interaction.is-plan-review")),
    "计划审阅形态下外层容器必须让位（不限高 / 不滚动），否则决定按钮会被外层滚走",
  );

  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /pending\.kind === "plan-review" \? " is-plan-review" : ""/.test(composer),
    "Composer 要按 pending 的种类给外层挂 .is-plan-review",
  );
  assert.ok(
    /pending\.kind === "plan-review" \? \(\s*<PlanReviewCard/.test(composer),
    "计划审阅卡在输入区渲染（与审批 / 问卷同一个接管位）",
  );

  // 底部决定行：英文文案比中文长，窄侧栏里必须能折行而不是把按钮挤出边界
  const footer = rule(".plan-review-footer");
  assert.ok(
    /flex-wrap:\s*wrap/.test(footer),
    "决定行必须允许折行（`Chat about it` / `Refuse` / `Approve` 在窄侧栏里放不下）",
  );

  // 按钮上显示界面语言、发出去提问方的 label：文案必须全部走词典
  const rows = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Rows.tsx"),
    "utf8",
  );
  const panel = rows.slice(rows.indexOf("export function PlanReviewCard"));
  assert.ok(
    /decide\(review\.approve\.label\)/.test(panel) && /decide\(decline\.label\)/.test(panel),
    "两个决定提交的是**提问方的 label**（显示语言 ≠ 答案，判定是逐字比较）",
  );
  assert.ok(
    /post\(\{ type: "cancelQuestion", requestId: question\.requestId \}\)/.test(panel),
    "「去聊天里说」发 cancelQuestion（撤回，不是答案）",
  );
  assert.ok(
    /texts\.planReviewHeader/.test(panel) &&
      /texts\.planReviewApprove/.test(panel) &&
      /texts\.planReviewDecline/.test(panel) &&
      /texts\.planReviewDiscuss/.test(panel),
    "四个文案都走词典（双语规则）",
  );
}
console.log("styles: 计划审阅卡单层滚动 + 决定按钮常驻 ✓");

// ---------- 37b. 问卷的「放弃整组问题」：次要出口的观感与折行待遇 ----------
//
// 与官方 web 端同步（2026-09-21）：待答问卷卡的 footer 加「放弃整组问题」（官方卡头
// ✕ / `nav.cancel` 的同一条结算，见 Rows.tsx 的 dismiss）。它是**次要出口**——ghost +
// 次级文字色，与计划审阅卡的「去聊天里说」同一个观感；footer 必须允许折行（英文
// Dismiss all questions / Previous / Next 都比中文宽一截，与 37 组同一条纪律）。
{
  const footer = rule(".question-footer");
  assert.ok(
    /flex-wrap:\s*wrap/.test(footer),
    "问卷 footer 必须允许折行（Dismiss all questions / Previous / Next 在窄侧栏里放不下）",
  );
  const dismiss = rule(".question-dismiss");
  assert.ok(
    /white-space:\s*nowrap/.test(dismiss) && /var\(--description\)/.test(dismiss),
    "放弃按钮自身文案不折行、用次级文字色（与 plan-review-discuss 同待遇）",
  );

  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  const card = rows.slice(rows.indexOf("export function QuestionCard"));
  assert.ok(
    /className="btn btn-ghost question-dismiss"/.test(card) && /texts\.questionDismissAll/.test(card),
    "放弃按钮走 ghost 次级观感、文案走词典（双语规则）",
  );
  assert.ok(
    /disabled=\{closing\}/.test(card) && /disabled=\{!ready \|\| closing\}/.test(card),
    "放弃点下后提交 / 放弃两个按钮都按住到收场（防重复发帧 / 防放弃后再提交）",
  );
}
console.log("styles: 问卷可放弃整组问题（次要出口观感 + 折行待遇）✓");

// ---------- 38. 多行草稿打字不闪：自适应量高的瞬态必须在同一帧内消化 ----------
//
// 用户 2026-09-17 报：「输入框大于 1 行时，打字会造成会话页面闪烁」。实测（preview
// 探针逐帧采样）：贴底时 scrollTop 随每个按键在 1021 ↔ 1000 来回振荡，Δ 恰为一行高。
// 根因：Composer 的自适应 effect 先把 textarea 塌回 `height: auto` 再量 `scrollHeight`
// ——塌回的一瞬输入区矮一行，`.chat-scroll` 可视端口**变高**，浏览器立刻把 scrollTop
// **夹小**（贴底 1021→1000）；量完把高度设回去、端口复原，但 scrollTop 不会自己弹回，
// 要等下一帧 rAF 的 settle 才钉回——每敲一个字就落进「底部缺一条 → 钉回」的振荡。
// 一行草稿塌回 auto 高度不变，所以只在 >1 行时出现，与报告一致。
// 锁：量高前先记贴底距离与 scrollTop；量完（仍在同一 effect、绘制之前）把被夹走的
// scrollTop 补回，原本贴底而端口变矮时直接钉底。补回动作不许推迟到 rAF/定时器。
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  const autoAt = composer.indexOf('el.style.height = "auto";');
  const restoreAt = composer.indexOf("pane.scrollTop = prevTop;");
  const pinAt = composer.indexOf("pane.scrollTop = pane.scrollHeight;");
  assert.ok(autoAt >= 0, "自适应量高（塌回 auto 再量）必须还在");
  assert.ok(
    /const distBefore = pane \? bottomGap\(pane\) : 0;/.test(composer) &&
      /const prevTop = pane\?\.scrollTop \?\? 0;/.test(composer) &&
      composer.indexOf("const distBefore") < autoAt,
    "量高前必须先记贴底距离与 scrollTop（瞬态基线），否则无从补回；距离走 `autoScroll` 的 `bottomGap`（同一份定义）",
  );
  assert.ok(
    restoreAt > autoAt && pinAt > restoreAt,
    "量完必须在同一 effect 里先补回被夹走的 scrollTop，贴底时再钉底（顺序不可反）",
  );
  assert.ok(
    !/requestAnimationFrame|setTimeout/.test(composer.slice(autoAt, restoreAt)),
    "补回不许推迟到 rAF/定时器：晚一帧就是用户看到的那一下闪烁",
  );
  assert.ok(
    /\}, \[draft, chatScroll, uiScale, syncMirror\]\);/.test(composer),
    "自适应 effect 的依赖要带滚动端口（对象恒定，不会多跑）、界面倍率（字号变了必须重量）" +
      "与镜像对齐回调（`syncMirror` 只读 ref，空依赖恒定，进表不会让它多跑）",
  );
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /chatScroll=\{chatScroll\.port\}/.test(app),
    "App 要把会话滚动端口的唯一对象传给 Composer（瞬态补回需要它）",
  );
}
console.log("styles: 多行草稿打字不闪（量高瞬态同帧消化）✓");

// ---------- 39. 右侧轮次横条：官方 TurnNavigator 的移植，关键几何不可回归 ----------
//
// 与官方 `TurnNavigator.module.css` 对照（packages/client/ui-chat），本扩展有两处
// **有意偏离**官方：横条占的宽度是**让出来的**（官方浮在正文右缘之上，会把内容盖住），
// 过窄阈值按侧栏尺度定（官方的 900px 是整页 Web 的尺度，照搬会让侧栏永远不显示）。
// 五件事靠肉眼很难每次改动后复查，坏了却很要命：
//   1. 槽位 sticky + 零高度——**不**撑长 scrollHeight（撑长了会话区就多出一段
//      永远滚不到头的空白）；
//   2. 槽位 pointer-events: none、框 auto——槽位横跨整个滚动区，不关掉的话
//      正文右缘一整列都点不了、选不了；
//   3. 正文按 --turn-rail-gutter 让出右内边距（横条不覆盖内容，用户 2026-09-18 口径）；
//   4. 过窄自动关闭（容器查询）——阈值不许回到过窄的值，且**预留条与横条同生共死**；
//   5. 减少动画时横条的动效同样被抑制（与 3b 的「待遇一致」同一性质）。
{
  const slot = rule(".turn-rail-slot");
  assert.ok(
    /position:\s*sticky/.test(slot) && /height:\s*0/.test(slot),
    `槽位必须是 sticky 零高度（现在是 "${slot.trim()}"）——否则横条把 scrollHeight 撑长，正文下方多出一段空白`,
  );
  assert.ok(
    /pointer-events:\s*none/.test(slot),
    "槽位必须 pointer-events: none——它横跨整个滚动区，不能拦选择与点击",
  );
  const frame = rule(".turn-rail-frame");
  assert.ok(
    /pointer-events:\s*auto/.test(frame),
    "框必须 pointer-events: auto（整列的点击 / 悬停都在框上，刻线本体是 none）",
  );
  assert.ok(
    /top:\s*calc\(var\(--turn-rail-band, 100vh\) \/ 2\)/.test(frame),
    "横条要垂直居中在滚动区的可视高度里（带高由 ResizeObserver 实测写入）",
  );
  const mark = rule(".turn-rail-mark");
  assert.ok(
    /pointer-events:\s*none/.test(mark),
    "刻线本体必须 pointer-events: none——悬停预览与点击都按 Y 坐标在框上换算（官方同款）",
  );

  // 刻线残影（用户 2026-10-11 报「会话里两枚刻线时，鼠标移到一枚上再移走会留下一道
  // 很薄的灰色残影」）。逐格采样那张截图：残留的一行是**悬停档的宽度**（18dp ≈ 22px、
  // 右缘对齐），当时刻线本身只剩非悬停档（8dp）那么短——不是画出来的线，是悬停时更长的
  // 旧像素没被清掉：宽度从 18dp 缩回 12dp／8dp 时缩掉的那一段落在新盒子之外，重画按新
  // 盒子清帧就把它剩下了。口径与候选行高亮那条（`.popover-item`：行盒与高亮背景矩形必须
  // 逐像素重合）同源，于是两条防线都要在：
  //   ① 刻线盒宽**恒定**在最宽档、各档位只改「画多长」（scaleX，右缘对齐）；
  //   ② 那一层 `contain: paint`（按层清帧，横条自己的「第二道防线」，与
  //      `.trigger-popover .popover-list` 同一口径）。
  const tick = rule(".turn-rail-mark::before");
  assert.ok(
    /width:\s*calc\(20 \* var\(--dp\)\)/.test(tick),
    `刻线盒宽必须恒定在最宽档 20dp（现在是 "${tick.trim()}"）——盒宽随档位变时，缩掉的那一段落在新盒子之外，旧像素就会剩下（残影）`,
  );
  assert.ok(
    /transform:\s*translateY\(-50%\)\s*scaleX\(var\(--turn-tick-scale/.test(tick) &&
      /transform-origin:\s*right center/.test(tick),
    "刻线的档位只能走 transform 的 scaleX（右缘对齐、往左长）——不许回到改 width 的写法",
  );
  // 刻线厚度（用户 2026-10-13 报「轮次多了以后每根刻线厚度不一致」）：`2 × --dp` 只在
  // 倍率 1 时是整数（2 个设备像素），字号 16（1.2308）时是 2.4615——一两个像素厚的量
  // 落在小数上会被光栅化器按每一枚的位置就近取整，同一串刻线于是有的 2 个设备像素、
  // 有的 3 个。组件把厚度取整到整 CSS 像素后写进 `--turn-tick-thickness`；CSS 只许读它
  // （设计像素的写法只留作回退值）。
  assert.ok(
    /height:\s*var\(--turn-tick-thickness,\s*calc\(2 \* var\(--dp\)\)\)/.test(tick),
    `刻线厚度必须读组件写好的 --turn-tick-thickness（现在是 "${tick.trim()}"）——厚度落在小数上时同一串刻线粗细不匀`,
  );
  const uiScaleTs = readFileSync(join(process.cwd(), "src", "webview", "uiScale.ts"), "utf8");
  const railTs = readFileSync(join(process.cwd(), "src", "webview", "components", "TurnRail.tsx"), "utf8");
  assert.ok(
    /export function lineThickness\(/.test(uiScaleTs),
    "uiScale.ts 要提供线宽取整的入口（刻线厚度、未来的发丝线都从它走）",
  );
  assert.ok(
    /lineThickness\(TURN_TICK_PX, scale\)/.test(railTs) && /--turn-tick-thickness/.test(railTs),
    "横条要用 lineThickness 算刻线厚度，并把它写进 --turn-tick-thickness（否则 CSS 读不到取整后的值）",
  );
  // 断言取整本身：线宽永远是整 CSS 像素（与 DPR 无关——实测取整到设备像素在 DPR 2 上更差，见 uiScale.ts）
  assert.strictEqual(lineThickness(2, 16 / 13), 2, "字号 16（1.2308）：2.4615 取整到 2");
  assert.strictEqual(lineThickness(2, 1), 2, "基准倍率下保持设计值 2");
  assert.strictEqual(lineThickness(2, 12 / 13), 2, "字号 12（0.9231）：1.8461 取整到 2");
  assert.strictEqual(lineThickness(2, 20 / 13), 3, "字号 20（1.5385）：3.0769 取整到 3");
  assert.strictEqual(lineThickness(2, 8 / 13), 1, "字号 8（0.6154）：1.2308 取整到 1");
  assert.strictEqual(lineThickness(2, 0.1), 1, "极小倍率也要保住 1px，不许取整成 0（线会消失）");
  for (const scale of [0.6154, 0.9231, 1, 1.0769, 1.1538, 1.2308, 1.5385]) {
    const thickness = lineThickness(2, scale);
    assert.ok(
      Number.isInteger(thickness) && thickness >= 1,
      `厚度必须是至少 1 的整 CSS 像素（倍率 ${String(scale)} 得到 ${String(thickness)}）`,
    );
  }
  for (const selector of [
    ".turn-rail-mark.is-unloaded::before",
    ".turn-rail-mark.is-preview::before",
    ".turn-rail-mark.is-active::before",
    ".turn-rail-mark:focus-visible::before",
  ]) {
    const block = rule(selector);
    assert.ok(
      /--turn-tick-scale:\s*[\d.]+/.test(block) && !/\bwidth:/.test(block),
      `${selector} 只能设 --turn-tick-scale，不许再改 width（盒宽一旦随档位变，残影就回来）`,
    );
  }
  assert.ok(
    /contain:\s*paint/.test(rule(".turn-rail-scroller")),
    "横条的内滚层必须 contain: paint——刻线残影的第二道防线（与 .trigger-popover .popover-list 同一口径）",
  );
  // 焦点环画在刻线盒**内侧**：刻线盒右缘就是那一层的右缘，`contain: paint` 会把往外的
  // 半圈裁掉（实测那一竖从来就没画出来过，看着像缺口朝右的半环）。
  const focusRing = rule(".turn-rail-mark:focus-visible");
  const focusOffset = designPx(/outline-offset:\s*([^;}]+)/.exec(focusRing)?.[1]?.trim());
  assert.ok(
    typeof focusOffset === "number" && focusOffset <= 0,
    `焦点环要画在刻线盒内侧（outline-offset ≤ 0，现在是 "${String(focusOffset)}"）——往外画会被那一层的 contain: paint 裁掉`,
  );

  // 容器查询的基准与关闭规则必须成对存在：基准没了查询永远不命中（横条挤死窄栏），
  // 规则没了基准白设
  const pane = rule(".chat-pane");
  assert.ok(
    /container-type:\s*inline-size/.test(pane),
    ".chat-pane 必须是容器查询基准（过窄自动关闭量的是它的宽度）",
  );

  // **预留空间**（用户 2026-09-18 口径：「给目录条预留空间，不覆盖在会话内容上显示」）：
  // 正文列表按 --turn-rail-gutter 让出右内边距，横条落在这条空档里。
  assert.ok(
    new RegExp(`--turn-rail-gutter:\\s*${DESIGN_PX}`).test(pane),
    ".chat-pane 必须定义 --turn-rail-gutter（横条占的宽度，设计像素）",
  );
  const reserved = rule(".chat-pane .chat-list");
  assert.ok(
    /padding-right:\s*calc\(6 \* var\(--dp\) \+ var\(--turn-rail-gutter/.test(reserved),
    `正文列表必须按 --turn-rail-gutter 让出右内边距，否则横条会盖在会话内容上；现在是 "${reserved.trim()}"`,
  );

  // 关闭规则：阈值不许回到过窄的值（用户 2026-09-18 报「触发关闭的宽度太窄了」），
  // 而且**预留条必须与横条同生共死**——只藏横条不还空间，正文会留一条无端空档。
  // 阈值写成 `calc(N em / 13)`：容器查询的 `em` 相对查询容器自身的字号，这条线才跟着
  // 界面倍率走（项目口径见 ADR 0004；写成裸 px 就是回归）。
  const hide = /@container \(max-width:\s*calc\((\d+)em \/ 13\)\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(hide, "必须存在 `@container (max-width: calc(N em / 13))` 形式的自动关闭规则");
  const threshold = Number(hide[1]);
  assert.ok(
    threshold >= 340,
    `自动关闭的阈值必须在 340 以上（现在是 ${threshold} 设计像素）——正文要保住约 300 才读得下去`,
  );
  assert.ok(
    /\.turn-rail-slot/.test(hide[2]) && /display:\s*none/.test(hide[2]),
    "自动关闭规则要把 .turn-rail-slot 整个 display: none",
  );
  assert.ok(
    /\.chat-pane \.chat-list/.test(hide[2]) && /padding-right:\s*calc\(6 \* var\(--dp\)\)/.test(hide[2]),
    "自动关闭时预留条要一起撤掉（把 40 个设计像素还给正文），不能只藏横条",
  );

  // 减少动画：横条的入场淡入 / 脉冲 / 预览滑入 / 缓动都在抑制名单里
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(reduced, "应当存在 prefers-reduced-motion 媒体查询");
  for (const selector of [".turn-rail-mark-pos", ".turn-rail-preview", ".turn-rail-frame"]) {
    assert.ok(
      reduced[1].includes(selector),
      `减少动画时 ${selector} 也要被抑制（横条的动效全是装饰性的）`,
    );
  }

  // 数据层在 App 上接线：条目来源、跳转导航、激活轮都要挂上
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /<TurnRail items=\{railItems\} activeTurn=\{activeTurn\} busyTurn=\{busyTurn\} onNavigate=\{navigate\} \/>/.test(app),
    "TurnRail 要渲染在 .chat-scroll 里（App.tsx）",
  );
  assert.ok(
    /useTurnRailItems\(state\.messages, state\.turnOutline, state\.hasMoreHistory === true\)/.test(app),
    "条目要由 turnOutline 投影 ∪ 已加载窗口合并而来；hasMoreHistory 一并传下去，供「部分加载」判定（见 turnRail.ts）",
  );
  assert.ok(
    /data-msg-id=\{message\.id\}/.test(
      readFileSync(join(process.cwd(), "src", "webview", "components", "Message.tsx"), "utf8"),
    ),
    "消息根节点必须带 data-msg-id（跳转锚点与激活轮的命中测试都靠它）",
  );

  // 显示判据：**有用户消息**（≥ 1，不是"轮次 ≥ 2"）——一条消息的会话同样要显示
  // （那一枚刻点是"回到开头"的入口，用户 2026-10-10 口径），而且适配器在首个
  // turn/start 之前拼出来的幻影轮 a:0 会让"轮次 ≥ 1"误判为有用户消息。
  // 判据换掉时这条断言变红是有意的：它同时钉住「组件用 userPromptCount 而非 items.length」。
  const turnRail = readFileSync(
    join(process.cwd(), "src", "webview", "components", "TurnRail.tsx"),
    "utf8",
  );
  assert.ok(
    /const rendered = userPromptCount\(items\) >= 1;/.test(turnRail),
    "横条的显示判据必须是「有用户消息」（userPromptCount），宽度那一半由 CSS 容器查询负责",
  );
  assert.ok(
    !/if \(items\.length < 2\) return null;/.test(turnRail),
    "旧的「轮次 ≥ 2」判据不许回来：幻影轮 a:0 会让它把无用户消息的会话也显示出来",
  );

  // 文案双语
  assert.strictEqual(dictionaryFor("zh").turnRailLabel, "轮次导航", "横条的 aria 标签必须中英双语都在词典里（中文）");
  assert.strictEqual(dictionaryFor("en").turnRailLabel, "Turn navigation", "横条的 aria 标签必须中英双语都在词典里（英文）");
}
console.log("styles: 右侧轮次横条（零高度槽位 + 点击穿透 + 过窄自动关闭） ✓");

// ---------- 后台任务详情：输出区限高内滚、行主体不许溢出 ----------
//
// 展开区把服务端留下的**整整 128KB** 输出一次画出来（界面侧的保留上限见
// `webview/jobObserve.ts`）。这一块坏了不是「难看」：
//   a) 不限高 → 一条长输出把抽屉撑成几万像素，上面的行再也滚不到；
//   b) 不换行 → 窄侧栏里每行都要横向拖到底才读得完（与代码块同一条口径）；
//   c) 行主体不 nowrap + ellipsis → 英文长命令 / 长路径把行撑破（chevron 被挤出视野）。
{
  const output = rule(".job-output");
  const cap = /max-height:\s*([^;]+);/.exec(output)?.[1]?.trim();
  assert.ok(
    cap !== undefined && /vh|calc\(|min\(/.test(cap),
    `.job-output 必须限高且视口感知（现在是 "${cap}"）——128KB 输出不许把抽屉撑高`,
  );
  assert.ok(/overflow:\s*auto/.test(output), ".job-output 限高之后要能内部滚动（否则下半截看不到）");
  assert.ok(
    /white-space:\s*pre-wrap/.test(output),
    ".job-output 必须自动换行（窄侧栏里横向滚动意味着长行要一路拖到底）",
  );

  const toggle = rule(".job-row-toggle");
  assert.ok(/min-width:\s*0/.test(toggle), ".job-row-toggle 要能收缩（否则里面的省略号不生效）");
  const command = rule(".job-panel-command");
  assert.ok(
    /white-space:\s*nowrap/.test(command) && /text-overflow:\s*ellipsis/.test(command),
    "命令头必须一行截断（英文长命令与长路径不能把面板撑宽）",
  );

  const chevron = rule(".job-chevron.is-open");
  assert.ok(/transform:\s*rotate/.test(chevron), "展开态的 chevron 要旋转（官方 .chevronOpen 同款）");
}
console.log("styles: 后台任务详情（输出限高内滚 + 行主体不溢出） ✓");

// ---------- 发送失败的回显行：红框 + 两个动作顶到最左 + 原因单行截断 ----------
//
// 用户 2026-09-25 口径：发送失败**不撤回显示**——那一行留在原地，气泡走错误色，
// 操作行最左侧给「重发 / 撤回」，行尾写原因。三条都是"看着对不对"的东西，
// 但坏掉的后果很实在：错误色走了别的颜色 = 与普通消息分不开；动作没顶到最左 =
// 与「时间 / 复制」混在一起，用户找不到；原因不 nowrap+省略号 = 英文长报错把行撑破。
{
  const failedBubble = rule(".msg-user.is-failed .bubble");
  assert.ok(
    /border-color:\s*var\(--error\)/.test(failedBubble),
    "失败那一行的气泡必须用错误色描边（与已发送的消息一眼可分）",
  );
  assert.ok(
    /background:\s*color-mix\(in srgb, var\(--error\)/.test(failedBubble),
    "失败气泡的底色也要走错误色（与既有错误态的 color-mix 手法一致）",
  );

  const actions = rule(".msg-failed-actions");
  assert.ok(
    /margin-right:\s*auto/.test(actions),
    "「重发 / 撤回」要顶到操作行最左侧（把时间 / 复制留在右端）",
  );
  assert.ok(
    /flex:\s*0 0 auto/.test(actions),
    "两枚文字按钮不许被压扁（它们是这一行唯一的动作，英文下更容易挤；压的是后面的原因）",
  );

  const reason = rule(".msg-failed-reason");
  assert.ok(
    /white-space:\s*nowrap/.test(reason) && /text-overflow:\s*ellipsis/.test(reason),
    "失败原因必须单行截断（英文报错通常比中文长一倍，撑破 28px 高的操作行就看不见时间了）",
  );
  assert.ok(
    /color:\s*var\(--error\)/.test(reason),
    "原因文字用错误色（与气泡边框同一语义）",
  );
}
console.log("styles: 失败回显行的动作与原因 ✓");

// ---------- 会话查找条：高亮走 Custom Highlight API，计数格不许折行 ----------
//
// 高亮配色**必须**挂在 `::highlight()` 伪元素上、并直接取编辑器查找的主题变量：
// FindBar 往 `CSS.highlights` 登记的是 Range，样式只能从这两个选择器来——登记名
// 与选择器字面不一致时高亮会静默消失（CSS 不报错、界面只是没有颜色）。
// 计数格的中英文长度差一倍（"3/17" ↔ "No results"），不 nowrap 就会把查找条挤折行。
{
  const all = rule("::highlight(dsh-find-all)");
  assert.ok(
    /--vscode-editor-findMatchHighlightBackground/.test(all),
    "全部命中的高亮必须取编辑器查找的主题变量（::highlight(dsh-find-all)）——登记名与选择器对不上时高亮静默消失",
  );
  const current = rule("::highlight(dsh-find-current)");
  assert.ok(
    /--vscode-editor-findMatchBackground/.test(current),
    "当前命中的高亮必须取编辑器查找的主题变量（::highlight(dsh-find-current)，比全部命中更深一档）",
  );

  // 两档的区分度必须是**双通道**：底色差（全部命中压淡）+ 当前命中的下划线。
  // `::highlight()` 只放行 color / background-color / text-decoration / text-shadow
  // 这几组属性，outline 会被静默丢弃——上一版给当前项写的描边是永不生效的死代码，
  // 只剩同色相两档透明度（0.33 vs 0.6）在撑，用户实测"几乎一样"。
  assert.ok(
    /text-decoration:\s*underline/.test(current),
    "当前命中必须有下划线（::highlight() 不支持 outline，描边是死代码；只靠底色差在多数主题里分不开）",
  );
  assert.ok(
    /color-mix/.test(all),
    "全部命中要压淡一档（color-mix 掺透明），否则与当前项的底色差拉不开",
  );

  const bar = rule(".find-bar");
  assert.ok(
    /display:\s*flex/.test(bar) && /flex:\s*0\s+0\s+auto/.test(bar),
    ".find-bar 是滚动区上方的定高 chrome 行（不参与 flex 收缩）",
  );

  const count = rule(".find-count");
  assert.ok(
    /white-space:\s*nowrap/.test(count),
    ".find-count 必须一行截断之外不折行（英文「No results」比中文长一倍，折行会把查找条撑高）",
  );
}
console.log("styles: 会话查找条的高亮与计数格 ✓");

// ---------- 25. 界面尺度：几何量一律走设计像素，倍率只有一处真相 ----------
//
// 用户 2026-10-03 口径：界面以 13px 为基准设计，字号配置改了之后**元素尺寸**也要等比
// 缩放。做法与理由见 docs/design-ui-scale.md。这里钉住的是「不这么做就
// 会静默退化」的几件事——它们全都能通过编译、也看不出报错，只会在某个字号下悄悄走形。
{
  const tokens = readFileSync(join(process.cwd(), "src", "webview", "styles", "tokens.css"), "utf8");

  // 倍率的**唯一真相**：由字号基准推出，13 是基准字号。写成别的数、或者挪到别处声明，
  // 都会让「auto（13px）下与基准字号像素级一致」这条不变量失效。
  const scaleRule = /--ui-scale:\s*calc\(var\(--font-size\)\s*\/\s*(\d+)px\)/.exec(tokens);
  assert.ok(
    scaleRule,
    "tokens.css 必须在 :root 上由 --font-size 推出 --ui-scale（`calc(var(--font-size) / 13px)`）",
  );
  const baseFromCss = Number(scaleRule[1]);
  assert.ok(
    /--dp:\s*calc\(1px \* var\(--ui-scale\)\)/.test(tokens),
    "tokens.css 必须定义 --dp = 1px × 倍率（几何量一律写成 calc(N * var(--dp))）",
  );

  // 倍率注册成 <number> 且初值 1：坏值退回「不缩放」而不是让每条用到它的声明整条失效
  assert.ok(
    /@property --ui-scale\s*\{[^}]*syntax:\s*"<number>"[^}]*inherits:\s*true[^}]*initial-value:\s*1[^}]*\}/.test(
      tokens,
    ),
    "@property --ui-scale 必须注册成 <number>、inherits: true、initial-value: 1（坏值的兜底）",
  );

  // 尺度来源只有设计像素：rem 锚在 html 的 16px 上，不跟倍率走
  for (const [name, text] of [
    ["tokens.css", tokens],
    ["app.css", css],
  ] as const) {
    const rem = /(?<![\w.])-?\d+(?:\.\d+)?rem/.exec(text);
    assert.ok(!rem, `${name} 里不许再用 rem 写尺寸（"${rem?.[0]}"）——它不跟界面倍率走`);
  }

  // 圆角与代码字号都要跟倍率
  assert.ok(
    /--radius:\s*calc\(8 \* var\(--dp\)\)/.test(tokens) && /--radius-sm:\s*calc\(6 \* var\(--dp\)\)/.test(tokens),
    "--radius / --radius-sm 必须按设计像素定义（8 / 6），否则圆角在字号变化时不动",
  );
  assert.ok(
    /--mono-size:\s*max\(calc\(var\(--vscode-editor-font-size,[^)]*\) \* var\(--ui-scale\)\)/.test(tokens),
    "--mono-size 的编辑器字号那一支要乘 --ui-scale（代码字号跟随倍率，界面字号那一支本身就是配置值）",
  );

  // 滚动条**不在**设计像素的账上：它由 VS Code 的主题决定宽度与配色，我们不自绘
  // （口径与实测见上面第 35 段）。这条只钉「它没有被误拉进倍率体系」。

  // 「量出来的尺寸」在字号变化后必须重量，而**变量要先于测量写上**：React 的 layout
  // effect 是子先父后，写 `--font-size` 的是父（App）——写成 layout effect 的话，子组件
  // 在同一个提交里量到的还是上一档字号，量完设成写死的 px，父组件随后改字号也不会让它
  // 重算（用户 2026-10-03 报的「刚调完字体输入框偏矮、敲一个字才正常」）。所以 App 用
  // insertion effect（早于所有 layout effect），而量高度的那个 effect 把倍率放进依赖。
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /useInsertionEffect\(\(\) => \{[\s\S]{0,400}?--font-size[\s\S]{0,200}?\}, \[state\.fontSizePx\]\)/.test(app),
    "App 必须用 useInsertionEffect 写 --font-size——layout effect 是子先父后，量尺寸的子组件会读到旧字号",
  );
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /\}, \[draft, chatScroll, uiScale, syncMirror\]\)/.test(composer),
    "输入框自适应高度的 effect 必须把界面倍率放进依赖（否则改完字号停在旧高度）；" +
      "镜像对齐回调是空依赖的 `useCallback`，一并列出不会让它多跑",
  );

  // JS 侧的倍率基准必须与 CSS 同一个数：两处分开写，只有断言能把它们钉在一起
  const uiScaleTs = readFileSync(join(process.cwd(), "src", "webview", "uiScale.ts"), "utf8");
  const baseFromTs = Number(/UI_SCALE_BASE_PX\s*=\s*(\d+)/.exec(uiScaleTs)?.[1]);
  assert.strictEqual(
    baseFromTs,
    baseFromCss,
    `uiScale.ts 的 UI_SCALE_BASE_PX（${baseFromTs}）必须与 tokens.css 里的基准字号（${baseFromCss}）一致`,
  );

  // 注释里的 `@container` 字样与示例写法都不算数：先抹成等长空白，扫描才干净
  let masked = css;
  for (let i = masked.indexOf("/*"); i >= 0; i = masked.indexOf("/*", i + 2)) {
    const end = masked.indexOf("*/", i + 2);
    const stop = end < 0 ? masked.length : end + 2;
    masked = `${masked.slice(0, i)}${" ".repeat(stop - i)}${masked.slice(stop)}`;
  }

  // 所有宽度类断点都必须是 `calc(N em / 13)`：裸 px 的容器查询与任何宽度类媒体查询都不
  // 跟着倍率走（媒体查询的 em 固定按初始 16px 算，所以那边没有可用写法）。
  // 条件文本里自带括号（`calc(...)`），所以要按括号配对取，不能正则截到第一个 `)`。
  const containerConds: string[] = [];
  for (let i = masked.indexOf("@container"); i >= 0; i = masked.indexOf("@container", i + 1)) {
    const open = masked.indexOf("(", i);
    let depth = 0;
    for (let j = open; j < masked.length; j += 1) {
      if (masked[j] === "(") depth += 1;
      else if (masked[j] === ")") {
        depth -= 1;
        if (depth === 0) {
          containerConds.push(masked.slice(open + 1, j));
          break;
        }
      }
    }
  }
  assert.ok(containerConds.length >= 3, `宽度类容器查询至少三条（现在 ${containerConds.length} 条）`);
  for (const cond of containerConds) {
    assert.ok(
      /^(max|min)-width:\s*calc\(\d+em \/ 13\)$/.test(cond),
      `容器查询条件必须是 calc(N em / 13) 形式，现在是 "${cond}"——裸 px 不跟界面倍率走`,
    );
  }
  assert.ok(
    !/@media[^{]*\b(max|min)-width/.test(css),
    "不许再有宽度类媒体查询：它的 em 固定按初始 16px 算，阈值不会跟倍率走（改用容器查询）",
  );

  // 几何属性上的裸 px：除白名单（线宽、0、视口/容器量）外一律判失败。
  const LINE_WIDTH = /^(border|border-(top|right|bottom|left|block|inline)|border-width|outline|text-decoration-thickness)$/;
  const offenders: string[] = [];
  for (const decl of masked.matchAll(/(?:^|[;{}])\s*(-{0,2}[A-Za-z][\w-]*)\s*:\s*([^;{}]*)/g)) {
    const [, prop, value] = decl;
    if (!/\d(?:\.\d+)?px/.test(value)) continue;
    if (LINE_WIDTH.test(prop)) continue; // 发丝线恒定，不是尺寸
    for (const px of value.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?)px/g)) {
      if (Number(px[1]) !== 0) offenders.push(`${prop}: ${value.trim()}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `几何量必须写成 calc(N * var(--dp))（0px 与线宽除外），这些还是裸 px：\n${offenders.join("\n")}`,
  );
}
console.log("styles: 界面尺度（设计像素 / 倍率 / 断点）✓");

console.log("\nstyles: all assertions passed");
