import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatState } from "../../shared/chat";
import { ESC_LAYER, useEscapeLayer } from "../escapeOwner";
import { IconChevronRight } from "../icons";
import { splitPath } from "../pathDisplay";
import { useTexts, type Texts } from "../texts";
import { dpLength } from "../uiScale";

/**
 * 元素的内容是否**真的被裁**（内容的布局宽度超过可见宽度）。
 *
 * 用在标题行的目录段上：左侧渐隐是「前面还有内容」的提示，只在被裁时才成立。
 * 无条件挂着的话，短目录（`…/`、`src/`）开头那 10px 会被无端吃掉一截，
 * 看着像被节点名盖住——用户 2026-09-12 报的正是这个。
 *
 * 判据**不能**用 `scrollWidth`：目录段是 flex 容器，文本排在匿名 flex 项里，
 * 项内的溢出不计入父级的 scrollable overflow——实测长目录文本宽 338px、
 * 盒子 245px，而 `scrollWidth == clientWidth == 245`，判据永远为 false。
 * 量「文本自己的布局宽度」（Range 覆盖内容）才准。
 *
 * 依赖两项：`content` 变化时复检（路径是流式长出来的），容器宽度变化由
 * `ResizeObserver` 兜住（目录段是 flex 项，侧栏变窄它跟着变窄）。
 * 只在挂载与内容变化时读尺寸，不在每次渲染里读——流式期间每来一个 token 都强制
 * 同步布局会很贵。
 *
 * @param ref 目标元素。
 * @param content 该元素的内容；为空表示这一段不存在，直接返回 false。
 */
function useClipped(ref: RefObject<HTMLElement>, content: string | undefined): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (!content) {
      setClipped(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      setClipped(range.getBoundingClientRect().width - el.clientWidth > 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, content]);
  return clipped;
}

/**
 * 行头的修饰键动作：按住 Ctrl/Cmd 单击整行时打开对应的文件。
 *
 * 动作与悬停说明住在**同一个端口对象**里：对象在，两者就都在；对象缺席，Row 既
 * 不拦截修饰键也不提示——调用方不必再单独维护「有没有动作」的第二份判据。
 */
export interface RowModifierAction {
  /** 按住 Ctrl/Cmd 单击行头时执行（普通单击仍是开合节点）。 */
  activate: () => void;
  /** 修饰键动作的悬停说明（与动作同生共死）。 */
  hint: string;
}

/** 一个可折叠的单行过程行（思考、工具、用量…），沿用 Continue 的导轨观感。 */
export function Row({
  icon,
  title,
  detail,
  detailSuffix,
  diffStat,
  onDetailActivate,
  modifier,
  meta,
  open,
  onToggle,
  tone,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail?: string;
  /**
   * 紧跟在 detail 之后的**不可压缩**片段（读取节点的 `:100-120`）。
   *
   * 单独一个元素而不是拼进 detail：detail 里的路径会从**前段**省略，
   * 拼在末尾的内容在窄侧栏会被一起截掉——那恰好是这个后缀要传达的信息。
   */
  detailSuffix?: string;
  /**
   * 改动统计（编辑类工具折叠行右侧的 `+N -M`，官方 `diffTotals`）。
   *
   * 单独一个 prop 而不是拼进 `detailSuffix`：它要按增/删分别着色。
   */
  diffStat?: { added: number; removed: number };
  /**
   * detail 是**可点的文件路径**时给一个动作（官方把摘要做成 `fileLink` 按钮，
   * 点了用侧栏预览打开该文件）。
   *
   * 这里做成行内 `<span role="link">` 而不是嵌套 `<button>`：行头本身已经是一个
   * 切换展开的按钮，HTML 不允许按钮嵌套按钮。用 role/tabIndex + Enter/Space
   * 保住键盘可达，点击时 `stopPropagation` 免得顺手把行展开了。
   */
  onDetailActivate?: () => void;
  /**
   * 按住 Ctrl/Cmd 单击整行时执行的文件动作（文件类节点的「直接打开对应文件」）。
   *
   * 缺席 = 这一行没有可打开目标：不挂 `is-file-openable`、不设 `title`，单击照旧
   * 只开合节点。动作与悬停说明捆在同一个对象里（见 `RowModifierAction`），
   * 不会出现「有提示没动作」或反之。
   */
  modifier?: RowModifierAction;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** 状态点颜色，用于工具行。 */
  tone?: "running" | "ok" | "error" | "stopped";
  children?: ReactNode;
}) {
  // 路径类 detail 拆成「目录 + 文件名」：目录可压缩（从左裁掉），文件名不吃压缩。
  // 行号（detailSuffix）作为**同一个 detail 块内部**的最后一个片段：
  // 块内没有 gap，所以它是 `文件名:行号` 而不是「文件名 行号」；同时它自己不压缩，
  // 挨裁的永远是目录那一段（曾经把它放在 detail 之外，detail 一撑宽就被顶到行尾）。
  const parts = detail ? splitPath(detail) : undefined;
  // 目录段真的被裁时才做左侧渐隐（见 useClipped）
  const dirRef = useRef<HTMLSpanElement>(null);
  const dirClipped = useClipped(dirRef, parts?.dir);
  // 只有真有动作时才挂类名与提示：没有可打开目标的节点不该出现「按住 Ctrl 打开」。
  const openable = modifier !== undefined;
  return (
    <div className={`row${open ? " is-open" : ""}`}>
      <button
        className={`row-head${openable ? " is-file-openable" : ""}`}
        title={modifier?.hint}
        onClick={(event) => {
          // Ctrl/Cmd+单击 = 直接打开这个节点对应的文件；其余单击照旧开合。
          if (openable && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            modifier.activate();
            return;
          }
          onToggle();
        }}
        aria-expanded={open}
      >
        <span className="row-chevron">
          <IconChevronRight size={11} />
        </span>
        {tone ? (
          // 状态点占的格子与图标同宽（.row-icon-status）：否则「运行中（13px 图标）
          // → 出错 / 被中止（7px 圆点）」时，后面的节点名会横向跳 6px
          // （预览页实测 title 的 x 从 61 → 55）。圆点在格子内居中（CSS），
          // 中心与相邻行的图标中心对齐。
          <span className="row-icon row-icon-status">
            <span className={`dot dot-${tone}`} />
          </span>
        ) : icon ? (
          <span className="row-icon">{icon}</span>
        ) : null}
        <span className="row-title">{title}</span>
        {/* detail 过长时会被裁掉，所以补 title：即使截断，悬停仍能看到完整内容。
            路径类 detail 若带 onDetailActivate，则整块变成可点的文件链接。 */}
        {parts ? (
          // detail 自己的 title 会盖住行头的 title：把修饰键动作的说明追加在这里，
          // 悬停在路径上（正是用户最想去点的地方）也能看到它。
          <span className="row-detail" title={openable ? `${detail}\n${modifier.hint}` : detail}>
            {parts.dir ? (
              <span
                ref={dirRef}
                className={`row-detail-dir${dirClipped ? " is-clipped" : ""}`}
              >
                {parts.dir}
              </span>
            ) : null}
            {onDetailActivate ? (
              <span
                className="row-detail-name is-link"
                role="link"
                tabIndex={0}
                onClick={(event) => {
                  // 别顺手把行展开了（这也是用 span 而不是嵌套 button 的原因）
                  event.stopPropagation();
                  onDetailActivate();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onDetailActivate();
                }}
              >
                {parts.name}
              </span>
            ) : (
              <span className="row-detail-name">{parts.name}</span>
            )}
            {detailSuffix ? <span className="row-detail-suffix">{detailSuffix}</span> : null}
          </span>
        ) : detail ? (
          <span className="row-detail is-text" title={openable ? `${detail}\n${modifier.hint}` : detail}>
            <span className="row-detail-name">{detail}</span>
            {detailSuffix ? <span className="row-detail-suffix">{detailSuffix}</span> : null}
          </span>
        ) : detailSuffix ? (
          // 没有 detail 只有后缀：单独渲染，仍然是不可压缩的一段
          <span className="row-detail-suffix">{detailSuffix}</span>
        ) : null}
        {/* 编辑类工具的折叠行右侧 `+N -M`（官方 diffStat）：绿加红减，一览改动量 */}
        {diffStat && (diffStat.added > 0 || diffStat.removed > 0) ? (
          <span className="row-diffstat" aria-label={`+${diffStat.added} -${diffStat.removed}`}>
            {diffStat.added > 0 ? <span className="is-added">{`+${diffStat.added}`}</span> : null}
            {diffStat.removed > 0 ? <span className="is-removed">{`-${diffStat.removed}`}</span> : null}
          </span>
        ) : null}
        {meta ? <span className="row-meta">{meta}</span> : null}
      </button>
      {open && children ? children : null}
    </div>
  );
}

/**
 * 触发器旁的浮层；点击外部或按 Esc 关闭。
 *
 * 展开方向的默认值是**向上**（`bottom: 100%`，输入区工具栏那一排就是它：触发器贴着
 * 底边，下方没有空间）。空态页的元信息行在页面中间，那里要 `drop="down"`。
 *
 * `align="center"` 是给「弹层比触发按钮宽得多、而按钮又不在页面边缘」的场合：
 * 左右对齐在这种位置必然裁掉一边，居中并把自己钳进视口才是要的结果（居中相对的是
 * **最近的定位祖先**，所以调用方要保证那一层就是它要对齐的那一行）。
 *
 * `className` 是给需要**自己分区**的弹层的额外挂点（模型弹层要把「可滚的列表」与
 * 「常驻的思考档位」拆开，见 `app.css` 的 `.model-popover`）。宽度、边距这类尺寸不
 * 走它——那些仍由 `.popover` 统一管。
 */
export function Popover({
  open,
  onClose,
  align = "left",
  drop = "up",
  children,
  style,
  className,
}: {
  open: boolean;
  onClose: () => void;
  align?: "left" | "right" | "center";
  /** 向上（缺省）还是向下展开。 */
  drop?: "up" | "down";
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(false);

  useLayoutEffect(() => {
    // 向下展开的浮层不做翻转判定：它的方向是调用方按所在页面位置定死的
    if (!open || drop === "down") return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setFlipUp(rect.bottom > window.innerHeight && rect.height < rect.top);
  }, [open, drop]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  // ESC 关闭走归属链（不是自己挂 document 监听）：活跃期间登记，关掉 / 卸载即注销
  useEscapeLayer(ESC_LAYER.floating, open, onClose);

  if (!open) return null;
  const placement = flipUp ? { top: "calc(100% + 6px)", bottom: "auto" } : undefined;
  return (
    <div
      ref={ref}
      className={`popover ${align}${drop === "down" ? " is-down" : ""}${className ? ` ${className}` : ""}`}
      style={{ ...placement, ...style }}
      role="dialog"
    >
      {children}
    </div>
  );
}

/**
 * 上下文占用的三个数**同源同现**：缺一个就不显示（宿主没算出可信测量时不下发）。
 *
 * 单独抽出来是给工具栏用的：它要在**渲染之前**决定「上下文占用」这一档是否参与
 * 宽度分配（见 `Composer` 的候选档位表）——数据没有就不该占一个坑位与一段间距。
 */
export function contextNumbers(
  percent?: number,
  used?: number,
  total?: number,
): { percent: number; used: number; total: number } | undefined {
  if (percent === undefined || used === undefined || total === undefined || total <= 0) {
    return undefined;
  }
  return { percent, used, total };
}

/** 悬停明细的输入：与 `CtxText` 的 props 同形，只是不含「环右侧要不要带数值」。 */
export interface ContextDetailInput {
  /** 宿主算好的百分比（官方 `contextOccupancy` 的等价输出）。 */
  percent?: number;
  used?: number;
  /** 分母；与 `percent` 一样只来自投影/宿主，缺一不显示。 */
  total?: number;
  /**
   * 会话累计的缓存命中率（**不含 `%` 的百分比文本**，与工具栏那枚 `98.7%HIT` 同一个值）。
   *
   * 明细里这一行**刻意**与工具栏共用同一个数：官方 ContextMeter 面板（本悬停对应的那个
   * 面板）根本没有缓存命中这一行，官方可见的那枚读数是会话累计口径的（`UsagePill` /
   * `StatsPills`），所以两处给同一个数才是「与官方一致」；单轮口径另有说法（官方「本轮用量」
   * 对话框是**整轮累加**），不在这里显示。
   */
  cacheHit?: string;
  /** 上下文构成（`contextBreakdown` 投影），与 Web 的 ContextMeter 面板同源。 */
  breakdown?: ChatState["contextBreakdown"];
}

/**
 * 上下文悬停明细的**唯一一份拼法**，界面里两处悬停共用它：
 * 上下文占用的圆环（`CtxText`），以及工具栏里那枚**独立**的缓存命中读数
 * （`Composer` 的 `.ctx-cache-hit`——两处悬停给的信息必须一模一样）。
 *
 * 所以拼法只此一份：两处各自拼一遍的话，加一行、改一个标签都会只改一处，
 * 「一模一样」就成了一句会过期的话。
 *
 * 三组行各自独立，缺数据的行**不出现**（于是数据相同时两处必然逐字一致）：
 * - 首行要三个数同源同现（判据见 `contextNumbers`，宿主没算出可信测量时不下发）；
 * - 缓存命中那行读的是**会话累计**口径（用户 2026-10-10 口径：与工具栏那枚读数同值，
 *   官方可见的也是这个口径——官方那个面板本身没有这一行）；
 * - 构成三行是启发式估算（`~` 前缀与 Web 一致，数值**固定一位小数**），说的是当前
 *   上下文由什么构成，与上面两个读数不是同一个维度。
 *
 * @param input 与 `CtxText` 同源的三个上下文数与构成投影。
 * @param texts 界面词典（调用方自己 `useTexts()` 取）。
 */
export function contextDetailLines(input: ContextDetailInput, texts: Texts): string[] {
  const detail: string[] = [];
  const numbers = contextNumbers(input.percent, input.used, input.total);
  if (numbers) {
    detail.push(texts.contextUsed(numbers.percent, formatTokens(numbers.used), formatTokens(numbers.total)));
  }
  if (input.cacheHit) detail.push(`${texts.ctxDetailCached} ${input.cacheHit}%`);
  if (input.breakdown) {
    // 三行的数值写法是**固定一位小数**（用户 2026-10-10 口径），走 `formatBreakdownTokens`，
    // 不与上下文的紧凑写法（`44K/128K`）共用 `formatTokens`。
    detail.push(`${texts.ctxDetailSystem} ~${formatBreakdownTokens(input.breakdown.systemTokens)}`);
    detail.push(`${texts.ctxDetailTools} ~${formatBreakdownTokens(input.breakdown.toolsTokens)}`);
    detail.push(`${texts.ctxDetailMessages} ~${formatBreakdownTokens(input.breakdown.messageTokens)}`);
  }
  return detail;
}

/**
 * 上下文占用：圆环（宽裕时环右侧再给精确数值），悬停显示明细行。
 *
 * **数字只有一个来源**：宿主按官方口径算好的 `contextOccupancy`
 * （`projectedTokens ?? pressureTokens`，prompt 侧、不含 output）。
 * 这里刻意**不本地重算、也不回退到 `usage.totalTokens`**：
 * 后者含 output，会让同一个圆环在不同时刻代表不同口径的东西
 * ——「这数字怎么不动了 / 怎么乱跳」的观感正是这么来的。
 *
 * 拿不到值时**什么都不显示**（宿主会在没数据时不下发）。但**一旦有过值就不会再空**：
 * 宿主那边会一直保留上一次的数字（占用条是常驻指示器，见 `adapter.refreshOccupancy`）。
 *
 * 两种形态由工具栏的优先级分配决定（`toolbarFit.ts`）：
 * - 圆环：P0 始终显示（用户 2026-10-06 口径：最高优先级）——弧长本身就回答了「还剩多少余地」；
 * - 最低优先级：`detailed` 打开，环右侧补 `44K/128K` 的精确数值。
 *
 * 环内**始终不写百分比**（用户 2026-09-14 口径：只显示圆圈）；
 * 百分比与构成只在悬停明细里——那里每次更新都会重算，但只有悬停时才看得见。
 */
export function CtxText({
  percent,
  used,
  total,
  cacheHit,
  breakdown,
  detailed,
}: ContextDetailInput & {
  /** 最低优先级档位：环右侧再显示 `44K/128K`。 */
  detailed?: boolean;
}) {
  const texts = useTexts();
  const numbers = contextNumbers(percent, used, total);
  if (!numbers) return null;

  // 明细在这里、在缓存命中读数那里都是同一份（`contextDetailLines`）；
  // 环本身与它**不是**一回事：环看「还剩多少余地」，明细看精确读数与构成。
  const detail = contextDetailLines({ percent, used, total, cacheHit, breakdown }, texts);

  return (
    <CtxRing
      percent={numbers.percent}
      title={detail.join("\n")}
      used={numbers.used}
      total={numbers.total}
      text={detailed ? formatContextSpan(numbers.used, numbers.total) : undefined}
    />
  );
}

/**
 * 上下文占用的图形化显示：一个圆环（可选在右侧带一段精确数值）。
 *
 * 取代更早的纯文字 `67%`。文字读的是「精确数值」，圆环读的是「还剩多少余地」——
 * 后者才是用上下文条的目的（扫一眼就知道快满了）。数值仍然保留：
 * 平时在悬停明细里，宽度宽裕时贴到环右侧（用户口径的最低优先级那一档）；
 * 环内**不写百分比**。
 *
 * 用 SVG 而不是 CSS `conic-gradient`：环在任意尺寸/缩放（含 VS Code 的
 * webview 缩放与高 DPI）下都是清晰的矢量，且 `stroke-dasharray` 的表达
 * 比角度拼接更容易按百分比精确控制。环从 12 点方向顺时针填充。
 */
export function CtxRing({
  percent,
  title,
  used,
  total,
  text,
}: {
  percent: number;
  title?: string;
  used?: number;
  total?: number;
  /** 环右侧的精确数值（`44K/128K`）；不传就只有环。 */
  text?: string;
}) {
  // 半径与描边按 16×16 视窗设计：小尺寸下仍有 1px 以上的笔画，不会糊成一团
  const radius = 6.4;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const dash = (clamped / 100) * circumference;
  // 与文字版同一套阈值语义：60% 起进入「偏高」，90% 起算「快满」
  const level = clamped >= 90 ? "is-critical" : clamped >= 60 ? "is-high" : "";
  return (
    <span
      className={`ctx-ring ${level}`.trimEnd()}
      title={title}
      role="img"
      aria-label={title ?? `${clamped}%`}
      data-used={used}
      data-total={total}
    >
      <svg
        style={{ width: dpLength(16), height: dpLength(16) }}
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle className="ctx-ring-track" cx="8" cy="8" r={radius} />
        <circle
          className="ctx-ring-value"
          cx="8"
          cy="8"
          r={radius}
          strokeDasharray={`${dash} ${circumference - dash}`}
        />
      </svg>
      {/* 精确数值写在环的右边（`.ctx-ring` 是 flex 行）。缓存命中率**不在这里**：
          它是工具栏里的独立元素（用户 2026-10-10 第二条口径），样式见 `.ctx-cache-hit`。 */}
      {text ? <span className="ctx-ring-text">{text}</span> : null}
    </span>
  );
}

/** 6 秒一圈的慢速 spinner——Continue 的节奏。 */
export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="spinner"
      style={{ width: dpLength(size), height: dpLength(size) }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/**
 * 折叠 body 区（`.row-body`）的滚动位置：**还在跑的贴底，已结束的置顶**。
 *
 * 两条口径合起来看（后者是用户 2026-09-20 的修正，覆盖前者的适用范围；第三条是
 * 用户 2026-09-21 补的边界）：
 *
 * - **已结束的节点**（用户 2026-09-16）：打开后垂直滚动条默认居于**最顶部**——内容
 *   都是成型后一次性呈现的（工具的 diff / 卡片 / IN-OUT、注入的提示词、命令结果），
 *   打开就该从第一行读起。此前一律 `scrollTop = scrollHeight`（贴底），于是一张长
 *   diff、一段长输出打开后停在末尾，得自己往上翻。
 * - **未结束、还在执行中的节点**（用户 2026-09-20）：打开后滚动条应当在**底部**。
 *   思考在逐 token 长、工具在持续吐输出，最新的一行才是用户点开要看的东西；停在
 *   顶部等于「每次都先看一遍开头再手滑到底」。所以 `active` 为真时**打开即贴底**，
 *   并且一直跟着新内容走。
 *
 * `active` = 「这个节点还在执行 / 内容还在增长」：思考节点传 `streaming`，工具行与
 * 命令节点传「status 还在跑」。注意它**不是**「有没有滚动条」——装不装得下都贴底，
 * 新的判据不再要求「盒子还装得下」（旧口径那条限制正是用户这次报的现象）。
 *
 * **打开那一刻只定位一次**：`active` 从真翻到假（节点跑完了）时**不动滚动位置**。
 * 否则用户正盯着末尾看输出，节点一结束就被拽回顶部——那是最糟的打断。后续节点若
 * 重新变成进行中（罕见），跟随态恢复、内容一变即回到末尾。
 *
 * **盒子是跑完之后才出现的**（工具行跑的时候只有「运行状态块 + 输入卡」，跑完才换成
 * 结果卡 / 终端卡，那是新元素）时，定位按 `openedWhileActive` 分：用户**在它还跑着的
 * 时候**点开的，就贴底（延续运行中的「跟着最新一行」，用户 2026-09-21 口径）；用户是
 * 结束后才点开的，就置顶（从第一行读起）。
 *
 * 粘性语义与主对话区一致：只有「scrollTop 真正变小」（用户上滑）才脱离跟随，
 * 滚回底部重新跟随。body 区自身是滚动容器（max-height 固定，盒子尺寸不变，
 * ResizeObserver 不会触发），内容增长改由 MutationObserver 捕获后主动跟随。
 */
export function useStickyBody(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  active = false,
  openedWhileActive = active,
): void {
  const stickRef = useRef(false);
  const lastTopRef = useRef(0);
  /** 这一次 `enabled` 是不是「刚打开」（上一次 effect 跑时还没开）。 */
  const openedRef = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) {
      openedRef.current = false;
      return;
    }
    if (!openedRef.current) {
      openedRef.current = true;
      // 出现那一刻的定位：进行中（或用户是跑着的时候点开的）停在最新一行，
      // 已结束的从第一行读起
      el.scrollTop = active || openedWhileActive ? el.scrollHeight : 0;
      lastTopRef.current = el.scrollTop;
    }
    stickRef.current = active;
    // 内容不会再变：不需要观察者，更不该在后续更新时抢用户的滚动位置
    if (!active) return;

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance < 40) {
        stickRef.current = true;
      } else if (el.scrollTop < lastTopRef.current) {
        stickRef.current = false; // 用户真的上滑了
      }
      lastTopRef.current = el.scrollTop;
    };
    const pin = () => {
      // 用户正在这里划选时不要跟着滚：滚动会把选区内容推出视野
      if (stickRef.current && !hasSelectionInside(el)) el.scrollTop = el.scrollHeight;
    };
    const observer = new MutationObserver(pin);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [enabled, active, openedWhileActive]);
}

/** 元素内是否存在非折叠选区（用户正在其中划选文字）。 */
export function hasSelectionInside(el: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return (
    selection.anchorNode !== null &&
    selection.focusNode !== null &&
    el.contains(selection.anchorNode) &&
    el.contains(selection.focusNode)
  );
}

/**
 * 选区冻结：节点内容持续更新时（流式思考、流式正文），用户在其中划选的文字
 * 会因文本节点被改写而立刻丢失选区。这里一旦检测到该元素内的非折叠选区，
 * 就把渲染内容冻结在划选那一刻的文本，直到选区消失才恢复跟随。
 *
 * 只影响界面渲染，不中断后台 agent——新内容照常到达并保存在状态里，
 * 选区一取消即显示最新内容。
 */
export function useSelectionFreeze(
  ref: RefObject<HTMLElement | null>,
  text: string,
): string {
  const [frozen, setFrozen] = useState<string | undefined>(undefined);
  // 冻结取「当前已渲染的源文本」而不是 DOM textContent：
  // 正文按 Markdown 渲染，textContent 会丢掉语法、重新渲染可能改变结构
  const liveRef = useRef(text);
  liveRef.current = text;

  useEffect(() => {
    const onChange = () => {
      const el = ref.current;
      if (el && hasSelectionInside(el)) setFrozen((prev) => prev ?? liveRef.current);
      else setFrozen(undefined);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [ref]);

  return frozen ?? text;
}

export function Ellipsis() {
  return <span className="ellipsis" />;
}

/**
 * 实时耗时：工具还在跑时每秒跳一次。
 *
 * 构建这类工具动辄几分钟，而协议里**没有**工具进度事件（实测：`tool/result`
 * 只在结束时落地，官方 Web UI 运行中同样只有 `output: undefined`），所以
 * 「还在跑」只能靠一个会动的数字表达。`active` 为假时停止计时并返回 0，
 * 收尾后由 `endedAt` 给出最终值。
 */
export function useElapsed(startedAt: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

/**
 * 缓存命中率的算法（含会话 / 单轮两个口径）住在 `../cacheHit.ts`——那是官方同名
 * 函数的唯一一份等价实现，界面各处都从那里取，不许在这里再算一遍。
 */

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

/**
 * 上下文构成三行（系统提示词 / 工具定义 / 对话消息）的数值写法
 * （用户 2026-10-10 口径）：**固定一位小数**。
 *
 * 与通用的 `formatTokens` 有意不同——那个是全局读数用的紧凑写法（上万就取整，`44K`），
 * 这三行要的是量级变化也不改口径的固定一位小数（`44.2K`）。
 * 单位仍按量级取 K / M；不足一千照实写整数（742 个 token 写成 `742.0` 是把不存在的
 * 精度装出来）。
 */
export function formatBreakdownTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * 上下文占用的精确写法（用户 2026-09-14 口径）：`44K/128K`、`400K/1.0M`。
 *
 * 分子分母**各自按量级挑单位**（`formatTokens` 那套：千位给 K、百万位给 M），
 * 所以 1M 的窗口就写作 `1.0M` 而不是 `1000K`，也不会再加一层括号把总量重复一遍。
 *
 * 与圆环是同一份数据的两种读法：环看「还剩多少余地」，这行看精确用量。
 */
export function formatContextSpan(used: number, total: number): string {
  return `${formatTokens(used)}/${formatTokens(total)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatClock(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return time;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  }
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${time}`;
}
