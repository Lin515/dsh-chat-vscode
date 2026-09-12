import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { IconChevronRight } from "../icons";
import { splitPath } from "../pathDisplay";
import { useTexts } from "../texts";

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

/** 一个可折叠的单行过程行（思考、工具、用量…），沿用 Continue 的导轨观感。 */
export function Row({
  icon,
  title,
  detail,
  detailSuffix,
  meta,
  open,
  onToggle,
  tone,
  children,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  /**
   * 紧跟在 detail 之后的**不可压缩**片段（读取节点的 `:100-120`）。
   *
   * 单独一个元素而不是拼进 detail：detail 里的路径会从**前段**省略，
   * 拼在末尾的内容在窄侧栏会被一起截掉——那恰好是这个后缀要传达的信息。
   */
  detailSuffix?: string;
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
  return (
    <div className={`row${open ? " is-open" : ""}`}>
      <button className="row-head" onClick={onToggle} aria-expanded={open}>
        <span className="row-chevron">
          <IconChevronRight size={11} />
        </span>
        {tone ? (
          // 状态点占的格子与图标同宽（.row-icon-status）：否则「运行中（13px 图标）
          // → 出错 / 被中止（7px 圆点）」时，后面的节点名会横向跳 6px
          // （预览页实测 title 的 x 从 61 → 55）。圆点自身位置不变。
          <span className="row-icon row-icon-status">
            <span className={`dot dot-${tone}`} />
          </span>
        ) : icon ? (
          <span className="row-icon">{icon}</span>
        ) : null}
        <span className="row-title">{title}</span>
        {/* detail 过长时会被裁掉，所以补 title：即使截断，悬停仍能看到完整内容 */}
        {parts ? (
          <span className="row-detail" title={detail}>
            {parts.dir ? (
              <span
                ref={dirRef}
                className={`row-detail-dir${dirClipped ? " is-clipped" : ""}`}
              >
                {parts.dir}
              </span>
            ) : null}
            <span className="row-detail-name">{parts.name}</span>
            {detailSuffix ? <span className="row-detail-suffix">{detailSuffix}</span> : null}
          </span>
        ) : detail ? (
          <span className="row-detail is-text" title={detail}>
            <span className="row-detail-name">{detail}</span>
            {detailSuffix ? <span className="row-detail-suffix">{detailSuffix}</span> : null}
          </span>
        ) : detailSuffix ? (
          // 没有 detail 只有后缀：单独渲染，仍然是不可压缩的一段
          <span className="row-detail-suffix">{detailSuffix}</span>
        ) : null}
        {meta ? <span className="row-meta">{meta}</span> : null}
      </button>
      {open && children ? children : null}
    </div>
  );
}

/** 触发器旁的浮层；点击外部或按 Esc 关闭。 */
export function Popover({
  open,
  onClose,
  align = "left",
  children,
  style,
}: {
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  children: ReactNode;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setFlipUp(rect.bottom > window.innerHeight && rect.height < rect.top);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 本层消费：不再落到全局「ESC 停止生成」
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  const placement = flipUp ? { top: "calc(100% + 6px)", bottom: "auto" } : undefined;
  return (
    <div
      ref={ref}
      className={`popover ${align}`}
      style={{ ...placement, ...style }}
      role="dialog"
    >
      {children}
    </div>
  );
}

/**
 * 上下文占用：圆环 + 环内百分比，悬停显示明细行。
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
 * 主界面只显示百分比，避免发送更新时数字跳动闪烁；
 * 明细里的数字每次更新会重新计算，但只在 hover 时才可见。
 */
export function CtxText({
  percent,
  used,
  total,
  usage,
  breakdown,
}: {
  /** 宿主算好的百分比（官方 `contextOccupancy` 的等价输出）。 */
  percent?: number;
  used?: number;
  /** 分母；与 `percent` 一样只来自投影/宿主，缺一不显示。 */
  total?: number;
  usage?: import("../../shared/chat").UsageView;
  /** 上下文构成（`contextBreakdown` 投影），与 Web 的 ContextMeter 面板同源。 */
  breakdown?: import("../../shared/chat").ChatState["contextBreakdown"];
}) {
  const texts = useTexts();
  // 三个值同源同现：宿主没给（还没拿到任何可信测量）就不显示
  if (percent === undefined || used === undefined || !total || total <= 0) return null;
  const usedValue = used;
  const pct = percent;

  const detail: string[] = [texts.contextUsed(pct, formatTokens(usedValue), formatTokens(total))];
  if (usage) {
    const cacheHit = cacheHitPercent(usage);
    if (cacheHit !== undefined) detail.push(`${texts.ctxDetailCached} ${cacheHit}%`);
    else if (usage.cachedTokens) detail.push(`${texts.ctxDetailCached} ${formatTokens(usage.cachedTokens)}`);
  }
  // 上下文构成三行（启发式估算，~ 前缀与 Web 一致）；不再显示单步的
  // 输入/输出/推理/合计——那是本轮用量，不是上下文总量
  if (breakdown) {
    detail.push(`${texts.ctxDetailSystem} ~${formatTokens(breakdown.systemTokens)}`);
    detail.push(`${texts.ctxDetailTools} ~${formatTokens(breakdown.toolsTokens)}`);
    detail.push(`${texts.ctxDetailMessages} ~${formatTokens(breakdown.messageTokens)}`);
  }

  return (
    <CtxRing
      percent={pct}
      label={`${pct}%`}
      title={detail.join("\n")}
      used={usedValue}
      total={total}
    />
  );
}

/**
 * 上下文占用的图形化显示：一个圆环 + 环内的百分比。
 *
 * 取代原来的纯文字 `67%`。文字读的是「精确数值」，圆环读的是「还剩多少余地」——
 * 后者才是用上下文条的目的（扫一眼就知道快满了）。数值与明细都保留：
 * 百分比在环内，悬停给出明细。
 *
 * 用 SVG 而不是 CSS `conic-gradient`：环在任意尺寸/缩放（含 VS Code 的
 * webview 缩放与高 DPI）下都是清晰的矢量，且 `stroke-dasharray` 的表达
 * 比角度拼接更容易按百分比精确控制。环从 12 点方向顺时针填充。
 */
export function CtxRing({
  percent,
  label,
  title,
  used,
  total,
}: {
  percent: number;
  /** 环内文字（一般就是百分比；迷你模式传空则只留环）。 */
  label?: string;
  title?: string;
  used?: number;
  total?: number;
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
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="ctx-ring-track" cx="8" cy="8" r={radius} />
        <circle
          className="ctx-ring-value"
          cx="8"
          cy="8"
          r={radius}
          strokeDasharray={`${dash} ${circumference - dash}`}
        />
      </svg>
      {label ? <span className="ctx-ring-label">{label}</span> : null}
    </span>
  );
}

/** 6 秒一圈的慢速 spinner——Continue 的节奏。 */
export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
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
 * 折叠 body 区（`.row-body`）的自动滚动：节点展开时贴住最新内容——
 * 内容超出 `max-height` 出现垂直滚动条时自动滚到最新一行。
 *
 * 粘性语义与主对话区一致：只有「scrollTop 真正变小」（用户上滑）才脱离跟随，
 * 滚回底部重新跟随。body 区自身是滚动容器（max-height 固定，盒子尺寸不变，
 * ResizeObserver 不会触发），内容增长改由 MutationObserver 捕获后主动跟随。
 */
export function useStickyBody(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): void {
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    stickRef.current = true;
    lastTopRef.current = 0;
    // 展开即从最新内容开始
    el.scrollTop = el.scrollHeight;

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
  }, [enabled]);
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
 * 缓存命中率（官方 turn-usage 口径）：缓存读取 / 总输入
 * （totalTokens - outputTokens，total 缺失时退回 inputTokens）。
 * provider 未报 cacheReadTokens 或分母非正时返回 undefined。
 */
function cacheHitPercent(usage: import("../../shared/chat").UsageView): number | undefined {
  const read = usage.cacheReadTokens;
  if (typeof read !== "number" || read < 0) return undefined;
  const denom =
    typeof usage.totalTokens === "number" && typeof usage.outputTokens === "number"
      ? usage.totalTokens - usage.outputTokens
      : usage.inputTokens;
  if (typeof denom !== "number" || denom <= 0) return undefined;
  return Math.round((read / denom) * 1000) / 10;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
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
