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
import { useTexts } from "../texts";

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
   * 单独一个元素而不是拼进 detail：detail 从右侧省略，拼在末尾的内容在窄侧栏
   * 会被截掉——那恰好是这个后缀要传达的信息。
   */
  detailSuffix?: string;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** 状态点颜色，用于工具行。 */
  tone?: "running" | "ok" | "error";
  children?: ReactNode;
}) {
  return (
    <div className={`row${open ? " is-open" : ""}`}>
      <button className="row-head" onClick={onToggle} aria-expanded={open}>
        <span className="row-chevron">
          <IconChevronRight size={11} />
        </span>
        {tone ? <span className={`dot dot-${tone}`} /> : icon ? <span className="row-icon">{icon}</span> : null}
        <span className="row-title">{title}</span>
        {/* detail 会被省略号从右侧截断（路径太长时），所以补 title：
            即使截断，悬停仍能看到完整内容 */}
        {detail ? (
          <span className="row-detail" title={detailSuffix ? `${detail}${detailSuffix}` : detail}>
            {detail}
          </span>
        ) : null}
        {detailSuffix ? <span className="row-detail-suffix">{detailSuffix}</span> : null}
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
 * 上下文占用百分比：`xx%`，超过 60% 变琥珀色；
 * 悬停显示明细行（已用/上限、缓存命中、上下文构成）。
 *
 * 主界面只显示百分比，避免发送更新时数字跳动闪烁。
 * 明细里的数字每次发送/更新会重新计算，但只在 hover 时才可见。
 */
export function CtxText({
  percent,
  used,
  total,
  usage,
  breakdown,
}: {
  /** 宿主算好的百分比（dsh web `context-occupancy` 投影的等价输出）；未传时本地重算。 */
  percent?: number;
  used?: number;
  total?: number;
  usage?: import("../../shared/chat").UsageView;
  /** 上下文构成（`contextBreakdown` 投影），与 Web 的 ContextMeter 面板同源。 */
  breakdown?: import("../../shared/chat").ChatState["contextBreakdown"];
}) {
  const texts = useTexts();
  if (!total || total <= 0) return null;
  const usedValue = used ?? usage?.totalTokens ?? 0;
  if (!usedValue) return null;
  const pct = percent ?? Math.min(100, Math.round((usedValue / total) * 100));

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
    <span
      className={`ctx-text${pct >= 60 ? " is-high" : ""}`}
      title={detail.join("\n")}
    >
      {pct}%
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
