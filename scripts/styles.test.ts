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
  //   - 「..」那行（它就是两个字符，绝不能被右侧的说明挤没）；
  //   - 权限档位名（英文 Read Only / Workspace Write 曾被长描述挤成 `Read O…`）。
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /isCommand \|\| isParent \? " is-priority" : ""/.test(composer),
    "Composer 的候选行必须按 isCommand / isParent 加 .is-priority（普通文件路径不加）",
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
  assert.ok(
    !/-webkit-line-clamp/.test(css) && !/\bline-clamp:/.test(css),
    "不许用「最多两行」的钳制（用户明确否决的中间态）：要么一行截断、要么全文",
  );

  const expanded = rule(".goal-bar.is-expanded .goal-objective");
  assert.ok(
    /white-space:\s*normal/.test(expanded),
    "展开态必须允许换行，否则「看了全文」还是被截",
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
  const texts = readFileSync(join(process.cwd(), "src", "webview", "texts.ts"), "utf8");
  assert.ok(
    /running: "深度求索中"/.test(texts),
    "运行中的文案应当是「深度求索中」（原来写的是「生成中」）",
  );
  assert.ok(
    !/deepDiving/.test(texts),
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
    /const open = manual \?\? false;/.test(rows),
    "思考段必须恒默认折叠（官方 useState(false)，运行中也不展开）",
  );
  assert.ok(
    !/manual \?\? Boolean\(streaming\)/.test(rows),
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
    /!hasDiff && \(inputText \|\| showOutput\)/.test(rows),
    "IN/OUT 只在**没有 diff** 时渲染（官方 diff 类工具直接给 DiffBlock，套 IN/OUT 会重复）",
  );
  assert.ok(/className="io-label">\{texts\.toolInput\}/.test(rows), "输入段要有标签");
  assert.ok(/className="io-label">\{texts\.toolOutput\}/.test(rows), "输出段要有标签");
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

  const texts = readFileSync(join(process.cwd(), "src", "webview", "texts.ts"), "utf8");
  assert.ok(/toolInput: "输入"/.test(texts) && /toolInput: "IN"/.test(texts), "两段标签要双语且与官方一致");
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
    /pending=\{pendingInteractionOf\(state\.messages\)\}/.test(app),
    "App 要把待处理交互交给 Composer（接管输入区）",
  );

  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /className="composer-interaction"/.test(composer),
    "输入区要有承载这张卡的容器（与目标条同一条 dock 带）",
  );
  assert.ok(
    /pending\.kind === "approval" \? \(\s*<ApprovalCard/.test(composer),
    "审批卡在这里渲染",
  );
  assert.ok(/<QuestionCard question=\{pending\.question\}/.test(composer), "提问卡同理");

  const message = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Message.tsx"),
    "utf8",
  );
  assert.ok(
    /isTakenOverByComposer\(segment\) \? null : \(\s*<ApprovalCard/.test(message),
    "流里要跳过**待处理**的卡（否则同一张卡出现两次），已答过的照常渲染",
  );
  assert.ok(
    /isTakenOverByComposer\(segment\) \? null : \(\s*<QuestionCard/.test(message),
    "提问卡同理",
  );
}
console.log("styles: 待处理交互接管输入区（流里跳过、答过留档） ✓");

// ---------- 18. 工具栏：按实测宽度分配，而不是按固定阈值隐藏 ----------
//
// 用户 2026-09-14 口径：底部工具栏「根据窗口宽度与优先级调整显示」——
// P0 权限/模型/发送（始终显示）、P1 思考强度/附件/tps/上下文环、
// P2 权限文字与上下文精确数值。宽度是**量**出来的（Composer 的 useToolbarFit
// 把候选档位渲染进测量层读 getBoundingClientRect），所以文案长短（中英差异）、
// 模型名、字号变化都能自动跟上——固定阈值做不到这件事。
//
// 这里钉住三件靠肉眼很难复查、坏了却很难看出来的事：
//   1. 测量层的三条硬约束（零尺寸 / 裁剪 / 不被压缩）；
//   2. 工具栏（.composer-bar）必须是测量层的定位基准；
//   3. 旧的固定阈值通道没有回来（`.app.is-mini` 不再决定工具栏显示谁）。
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
}
console.log("styles: 工具栏按实测宽度分配、测量层约束完整 ✓");

// ---------- 16. 连接条：按钮不裁切，文字可以让位（2026-09-14 新增四种状态与按钮） ----------
//
// 连接条现在最多有四个按钮（启动服务器 / 尝试重连 / 停止重连 / 查看日志），而英文文案
// 比中文长 1.5~2 倍。三件事必须同时成立，否则窄侧栏下会裁掉按钮（不是"难看"，是点不到）：
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
  const plotStart = flatTrajectory.indexOf("className={`trajectory-plot");
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

console.log("\nstyles: all assertions passed");
