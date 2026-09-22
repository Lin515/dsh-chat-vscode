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
import { dictionaryFor } from "../src/webview/texts";

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
    /min-width:\s*(\d+)px/.exec(status)?.[1],
    "13",
    `.row-icon-status 的坑位必须与图标同宽（13px），现在是 "${status.trim()}"`,
  );
  assert.ok(
    /<span className="row-icon row-icon-status">\s*<span className=\{`dot dot-\$\{tone\}`\} \/>/.test(
      readFileSync(join(process.cwd(), "src", "webview", "components", "primitives.tsx"), "utf8"),
    ),
    "Row 的状态点必须渲染在与图标同宽的坑位里（.row-icon-status）",
  );
}
console.log("styles: 运行中节点呼吸发光与图标同色、完成态保色 ✓");

// ---------- 4d. 顶栏两颗面板入口的「有东西在跑」态与运行圆点同一节奏 ----------
//
// 用户 2026-09-19 口径：有子代理 / 后台任务在跑时，右上角那两颗按钮要亮起来并呼吸。
// 判据与接线在 `scripts/activity.test.ts`；这里只钉样式本身，避免下次有人另写一套
// 关键帧（呼吸节奏不一致比不呼吸更难发现）。
{
  const busy = rule(".icon-btn.is-busy > svg");
  assert.ok(/animation:\s*icon-glow/.test(busy), ".icon-btn.is-busy 必须复用 icon-glow 关键帧");

  // 子代理行的状态点有**独享一格**：格内水平垂直居中 + 与标题留距（用户同日口径）
  const state = rule(".session-item-state");
  assert.ok(/align-items:\s*center/.test(state), ".session-item-state 里圆点垂直居中");
  assert.ok(/justify-content:\s*center/.test(state), ".session-item-state 里圆点水平居中");
  assert.ok(/margin-left:/.test(state), ".session-item-state 与标题之间要有间距");
}
console.log("styles: 面板入口的活性态与状态点格子 ✓");

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
  const margin = Number(/margin-left:\s*(\d+(?:\.\d+)?)px/.exec(detail)?.[1] ?? "0");
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

// ---------- 8. 会话历史里不弹 webview 的默认右键菜单 ----------
//
// 用户 2026-09-12：「去掉历史对话中的右键菜单」。webview 宿主把
// `defaultPrevented` 当作「扩展已处理」的开关，所以 preventDefault 就是唯一手段；
// 搜索框（可编辑元素）要放行，否则连粘贴都没了。
{
  const history = readFileSync(
    join(process.cwd(), "src", "webview", "components", "History.tsx"),
    "utf8",
  );
  assert.ok(
    /event\.preventDefault\(\)/.test(history),
    "History 必须 preventDefault 掉右键菜单",
  );
  assert.ok(
    /closest\("input, textarea, \[contenteditable='true'\]"\)/.test(history),
    "搜索框这类可编辑元素要放行右键菜单（否则粘贴没了）",
  );
  assert.ok(
    /<div className="drawer" onContextMenu=\{blockContextMenu\}>/.test(history),
    "抽屉本体必须挂上 onContextMenu",
  );
}
console.log("styles: 会话历史屏蔽默认右键菜单 ✓");

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
    /post\(\{ type: "copy", text: message\.text \?\? "" \}\)/.test(userBranch),
    "用户消息的复制按钮要把正文发出去（text 可空，不能是 undefined）",
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
  // 文案走词典断言（文案表已搬进 messages.ts，见 docs/audit-summary.md 修复一览第六批）
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
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const flatApp = app.replace(/\s+/gu, " ");
  const flatTrajectory = trajectory.replace(/\s+/gu, " ");

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
  const plotStart = flatTrajectory.indexOf('className="trajectory-plot"');
  assert.ok(plotStart > 0, "找不到时间线绘图区");
  const resetAt = flatTrajectory.indexOf('className="trajectory-more"');
  assert.ok(resetAt > plotStart, "绘图区之后应当还有右侧的缩放复位按钮");
  assert.ok(
    flatTrajectory.slice(plotStart, resetAt).includes("trajectory-earlier"),
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
  const details = rule(".trajectory-details");
  assert.ok(
    /max-width:\s*calc\(100% - 280px\)/.test(details),
    "检查器的 max-width 要留 280px 给账本（官方 TABLE_MIN_WIDTH）",
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

// ---------- 35. 滚动条拐角 / 右下角拉伸角不许是白底 ----------
//
// 用户 2026-09-15 报的：问卷自定义回答的编辑框一出现垂直滚动条，右下角那块「可拉动」
// 的标志就变成白底。实测（预览页取像素）修复前那一块是 **#efefef 实心方块**——Chromium
// 在深色主题下给 resizer 画的就是这个，而本项目的滚动条轨道是透明的，所以特别扎眼。
// 修法两条一起看：**底色清成透明** + **自己用主题色画两道斜线**（只清底的话那个角
// 就彻底看不见了，等于把「可以拉」这个提示删掉）。
{
  const tokens = readFileSync(
    join(process.cwd(), "src", "webview", "styles", "tokens.css"),
    "utf8",
  );
  const block = (selector: string): string => {
    const match = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(tokens);
    assert.ok(match, `tokens.css 里要有 ${selector} 这条规则`);
    return (match as RegExpExecArray)[1];
  };
  assert.ok(
    /background-color:\s*transparent/.test(block("::-webkit-scrollbar-corner")),
    "滚动条拐角必须清成透明（自定义了 ::-webkit-scrollbar 却不给拐角清底 = 一块白方块）",
  );
  const resizer = block("::-webkit-resizer");
  assert.ok(
    /background-color:\s*transparent/.test(resizer),
    "右下角的拉伸角必须清成透明底（用户 2026-09-15 报的白底就是它）",
  );
  assert.ok(
    /background-image:[\s\S]*?var\(--muted\)/.test(resizer) &&
      /background-size:/.test(resizer) &&
      /background-position:\s*right bottom/.test(resizer),
    "清底之后要自己画拉伸标记（主题色斜线、贴右下角），否则那个角什么都看不见",
  );
}
console.log("styles: 滚动条拐角与拉伸角透明 + 自绘拉伸标记 ✓");

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

// ---------- 36. 顶部两颗「打开」按钮必须是两个不同的图标 ----------
//
// 用户 2026-09-15 报：「在浏览器中打开」的图标和在编辑区中打开的一模一样。
// 根因是两者都画成「方框 + 右上角箭头」——`IconExternal`（文件链接行在用）与
// `IconOpenInEditor` 只差一条斜线的长短（`M20 4l-8 8` vs `M20 4l-8.5 8.5`），
// 15px 下分不出来。浏览器那颗改成 `IconGlobe`（VS Code 自己的 Simple Browser
// 也是地球）。这条断言按**图标组件名**钉住两者不同——形状相似是肉眼很难复查的
// 一类回归，而"顺手换成同一个"又极其自然（我就是这么写错的）。
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const editorIcon = /type: "openInEditor"[\s\S]{0,160}?<(\w+)/.exec(app)?.[1];
  const browserIcon = /type: "openInBrowser"[\s\S]{0,160}?<(\w+)/.exec(app)?.[1];
  assert.ok(editorIcon && browserIcon, "顶部两颗「打开」按钮都应当存在");
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
}
console.log("styles: 两颗「打开」按钮图标不同（编辑区=方框箭头 / 浏览器=地球）✓");

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
    "卡片按官方口径限高（min(60vh, 520px)）并裁掉溢出，滚动交给正文那一段",
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
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
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
    /\}, \[draft, chatScroll\]\);/.test(composer),
    "自适应 effect 的依赖要带上滚动端口（对象恒定，不会多跑）",
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
    /--turn-rail-gutter:\s*\d+px/.test(pane),
    ".chat-pane 必须定义 --turn-rail-gutter（横条占的宽度）",
  );
  const reserved = rule(".chat-pane .chat-list");
  assert.ok(
    /padding-right:\s*calc\(6px \+ var\(--turn-rail-gutter/.test(reserved),
    `正文列表必须按 --turn-rail-gutter 让出右内边距，否则横条会盖在会话内容上；现在是 "${reserved.trim()}"`,
  );

  // 关闭规则：阈值不许回到过窄的值（用户 2026-09-18 报「触发关闭的宽度太窄了」），
  // 而且**预留条必须与横条同生共死**——只藏横条不还空间，正文会留一条无端空档。
  const hide = /@container \(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(hide, "必须存在 @container (max-width: …px) 的自动关闭规则");
  const threshold = Number(hide[1]);
  assert.ok(
    threshold >= 340,
    `自动关闭的阈值必须在 340px 以上（现在是 ${threshold}px）——正文要保住约 300px 才读得下去`,
  );
  assert.ok(
    /\.turn-rail-slot/.test(hide[2]) && /display:\s*none/.test(hide[2]),
    "自动关闭规则要把 .turn-rail-slot 整个 display: none",
  );
  assert.ok(
    /\.chat-pane \.chat-list/.test(hide[2]) && /padding-right:\s*6px/.test(hide[2]),
    "自动关闭时预留条要一起撤掉（把 40px 还给正文），不能只藏横条",
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

  // 显示判据：**用户消息 ≥ 2**（不是"轮次 ≥ 2"）——一条消息的会话没有可导航的东西，
  // 而且适配器在首个 turn/start 之前拼出来的幻影轮 a:0 会让"轮次 ≥ 2"误判为有得导航。
  // 判据换掉时这条断言变红是有意的：它同时钉住「组件用 userPromptCount 而非 items.length」。
  const turnRail = readFileSync(
    join(process.cwd(), "src", "webview", "components", "TurnRail.tsx"),
    "utf8",
  );
  assert.ok(
    /const rendered = userPromptCount\(items\) >= 2;/.test(turnRail),
    "横条的显示判据必须是「用户消息 ≥ 2」（userPromptCount），宽度那一半由 CSS 容器查询负责",
  );
  assert.ok(
    !/if \(items\.length < 2\) return null;/.test(turnRail),
    "旧的「轮次 ≥ 2」判据不许回来：幻影轮 a:0 会让它把单消息会话也显示出来",
  );

  // 文案双语
  assert.strictEqual(dictionaryFor("zh").turnRailLabel, "轮次导航", "横条的 aria 标签必须中英双语都在词典里（中文）");
  assert.strictEqual(dictionaryFor("en").turnRailLabel, "Turn navigation", "横条的 aria 标签必须中英双语都在词典里（英文）");
}
console.log("styles: 右侧轮次横条（零高度槽位 + 点击穿透 + 过窄自动关闭） ✓");

console.log("\nstyles: all assertions passed");
