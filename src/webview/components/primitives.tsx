import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconChevronRight } from "../icons";
import { useTexts } from "../texts";

/** 一个可折叠的单行过程行（思考、工具、用量…），沿用 Continue 的导轨观感。 */
export function Row({
  icon,
  title,
  detail,
  meta,
  open,
  onToggle,
  tone,
  children,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
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
        {detail ? <span className="row-detail">{detail}</span> : null}
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
      if (event.key === "Escape") onClose();
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

/** 上下文占用小竖条：14×7，超过 60% 变琥珀色。 */
export function CtxBar({ used, total }: { used?: number; total?: number }) {
  const texts = useTexts();
  if (!used || !total || total <= 0) return null;
  const percent = Math.min(100, Math.round((used / total) * 100));
  return (
    <span className="ctx-bar" title={texts.contextUsed(percent, formatTokens(used), formatTokens(total))}>
      <span className="ctx-track">
        <span className={`ctx-fill${percent >= 60 ? " is-high" : ""}`} style={{ width: `${percent}%` }} />
      </span>
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

export function Ellipsis() {
  return <span className="ellipsis" />;
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
