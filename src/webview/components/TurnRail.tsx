import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import type { TurnRailItem } from "../turnRail";
import { userPromptCount } from "../turnRail";
import { useTexts } from "../texts";

/**
 * 右侧轮次横条（官方 Web UI 的 `TurnNavigator` 移植，见
 * `packages/client/ui-chat/src/client/chat/TurnNavigator.tsx`）：
 *
 * - 每一轮一枚**固定间距**的刻点（相隔 10px，右缘一列短横线）；
 * - **悬停 / 键盘聚焦**给出预览卡：一行提示词 + 三行响应；
 * - **点击**跳到那一轮（未加载的先取历史再落位，由父级处理，这里只上报）；
 * - 阶梯比框高时在框**内部**滚动，两端用渐变淡出提示「还能往这个方向滚」；
 * - 当前轮的刻点自己保持在视野里（指针不在横条上时才动）。
 *
 * 两条与官方一致的关键实现：刻点本体 `pointer-events: none`——**整列**的指针
 * 输入归 `<nav>` 所有，按 Y 坐标换算出刻点（悬停预览与点击都是这套换算）；
 * 外层槽位是 **sticky + 零高度**——横条浮在正文右缘而不把 scrollHeight 撑长。
 */
const TURN_SPACING_PX = 10;
/** 上下两端各留的空隙（刻点不贴框）。 */
const RAIL_INSET_PX = 6;
/** 渐变淡出的带宽。 */
const FADE_PX = 24;

type TurnPositionStyle = CSSProperties & { readonly "--turn-natural-position": string };

type TurnFrameStyle = CSSProperties & {
  readonly "--turn-natural-height": string;
  readonly "--turn-rail-inset": string;
  readonly "--turn-scroll-top": string;
};

function itemPosition(index: number): TurnPositionStyle {
  return { "--turn-natural-position": `${String(index * TURN_SPACING_PX)}px` };
}

function frameStyle(count: number, scrollTop: number): TurnFrameStyle {
  return {
    "--turn-natural-height": `${String((count - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
    "--turn-rail-inset": `${String(RAIL_INSET_PX)}px`,
    "--turn-scroll-top": `${String(scrollTop)}px`,
  };
}

function itemAtPointer(
  items: readonly TurnRailItem[],
  frame: HTMLElement,
  scrollTop: number,
  clientY: number,
): TurnRailItem | undefined {
  const rect = frame.getBoundingClientRect();
  const offset = clientY - rect.top + scrollTop - RAIL_INSET_PX;
  const index = Math.max(0, Math.min(items.length - 1, Math.round(offset / TURN_SPACING_PX)));
  return items[index];
}

/** 滚动态：渐隐的朝向与「跟随激活刻点」都读它。 */
interface RailScrollState {
  readonly top: number;
  readonly canScrollUp: boolean;
  readonly canScrollDown: boolean;
}

const RAIL_AT_REST: RailScrollState = { top: 0, canScrollUp: false, canScrollDown: false };

function railScrollState(scroller: HTMLElement): RailScrollState {
  const top = scroller.scrollTop;
  return {
    top,
    canScrollUp: top > 1,
    canScrollDown: top < scroller.scrollHeight - scroller.clientHeight - 1,
  };
}

function sameRailScrollState(left: RailScrollState, right: RailScrollState): boolean {
  return left.top === right.top && left.canScrollUp === right.canScrollUp && left.canScrollDown === right.canScrollDown;
}

function TurnNavigatorRail({
  items,
  activeTurn,
  busyTurn,
  onNavigate,
}: {
  items: readonly TurnRailItem[];
  activeTurn: number | null;
  busyTurn: number | null;
  onNavigate: (item: TurnRailItem) => void;
}) {
  const texts = useTexts();
  const [previewTurn, setPreviewTurn] = useState<number | null>(null);
  const [scrollState, setScrollState] = useState<RailScrollState>(RAIL_AT_REST);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  /** 指针在横条上工作时，「激活刻点保持在视野里」的跟随必须让位。 */
  const pointerInsideRef = useRef(false);
  const previewId = useId();
  /**
   * 显示判据：**用户消息 ≥ 2** 且宽度足够（宽度走 CSS 容器查询）才渲染。
   * 用户消息数 = 带提示词预览的轮数（`userPromptCount`）——一条消息的会话
   * 没有可导航的东西，横条只是右缘的噪音。刻点少到不成梯子同理。
   * **必须盯它重跑 effect**：条件不满足时组件整个返回 null（各 ref 为 null），
   * 一次性 effect 那时跑完就再也不会跑了——观察者会永远缺席。
   */
  const rendered = userPromptCount(items) >= 2;

  const syncScrollState = (): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const next = railScrollState(scroller);
    setScrollState((current) => (sameRailScrollState(current, next) ? current : next));
  };

  // 框的尺寸变了（会话窗口被拖动 / 输入区长高）滚动边界会动，但没有 scroll 事件；
  // 刻点数量变了内容高度同理。都归 ResizeObserver 补一次。
  // **必须盯 `rendered`**：条目未到时组件整个返回 null（scrollerRef 为 null），
  // 一次性 effect 那时跑完就再也不会跑了——观察者会永远缺席。
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!rendered || scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [rendered]);
  useEffect(syncScrollState, [items.length, rendered]);

  // **竖向带高**（`--turn-rail-band`）：横条要垂直居中在「滚动区的可视高度」里，
  // 而不是整个面板里（下面还有输入区）。滚动区是槽位的父元素，观察它即可；
  // layout effect 先量一次，首帧就不跳。
  useLayoutEffect(() => {
    const slotEl = slotRef.current;
    const scrollport = slotEl?.parentElement;
    if (!rendered || !slotEl || !scrollport) return;
    const syncBand = () => {
      slotEl.style.setProperty("--turn-rail-band", `${String(scrollport.clientHeight)}px`);
    };
    syncBand();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncBand);
    observer.observe(scrollport);
    return () => observer.disconnect();
  }, [rendered]);

  // 激活刻点离开视野就居中回它（指针正在横条上时不动——不能把手底下的东西挪走）。
  useEffect(() => {
    const scroller = scrollerRef.current;
    const index = items.findIndex((item) => item.turn === activeTurn);
    if (scroller === null || index < 0 || pointerInsideRef.current) return;
    const markTop = index * TURN_SPACING_PX + RAIL_INSET_PX;
    const viewTop = scroller.scrollTop;
    const viewHeight = scroller.clientHeight;
    if (viewHeight <= 0 || (markTop >= viewTop + FADE_PX && markTop <= viewTop + viewHeight - FADE_PX)) return;
    const target = Math.max(0, markTop - viewHeight / 2);
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: target, behavior: reduced ? "auto" : "smooth" });
    } else {
      scroller.scrollTop = target;
    }
    syncScrollState();
  }, [activeTurn, items]);

  if (!rendered) return null;
  const previewIndex = items.findIndex((item) => item.turn === previewTurn);
  const preview = previewIndex < 0 ? undefined : items[previewIndex];
  const previewPosition = previewIndex < 0 ? undefined : itemPosition(previewIndex);
  const previewAtPointer = (event: PointerEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    setPreviewTurn(itemAtPointer(items, event.currentTarget, scrollTop, event.clientY)?.turn ?? null);
  };
  const navigateAtPointer = (event: MouseEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    const item = itemAtPointer(items, event.currentTarget, scrollTop, event.clientY);
    if (item !== undefined) onNavigate(item);
  };
  const fadeClasses = ["turn-rail-scroller"];
  if (scrollState.canScrollUp) fadeClasses.push("is-fade-top");
  if (scrollState.canScrollDown) fadeClasses.push("is-fade-bottom");
  return (
    <div ref={slotRef} className="turn-rail-slot">
      <nav
        className="turn-rail-frame"
        style={frameStyle(items.length, scrollState.top)}
        aria-label={texts.turnRailLabel}
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerEnter={() => {
          pointerInsideRef.current = true;
        }}
        onPointerLeave={() => {
          pointerInsideRef.current = false;
          setPreviewTurn(null);
        }}
      >
        <div ref={scrollerRef} className={fadeClasses.join(" ")} onScroll={() => syncScrollState()}>
          <div className="turn-rail-marks">
            {items.map((item, index) => {
              const active = item.turn === activeTurn;
              const showingPreview = item.turn === previewTurn;
              const classes = ["turn-rail-mark"];
              if (item.anchor.kind === "unloaded") classes.push("is-unloaded");
              if (active) classes.push("is-active");
              else if (showingPreview) classes.push("is-preview");
              if (item.turn === busyTurn) classes.push("is-busy");
              return (
                <div key={item.turn} className="turn-rail-mark-pos" style={itemPosition(index)}>
                  <button
                    type="button"
                    className={classes.join(" ")}
                    aria-label={item.anchor.kind === "loaded" ? texts.turnRailJump(item.turn) : texts.turnRailJumpLoad(item.turn)}
                    aria-current={active ? "true" : undefined}
                    aria-busy={item.turn === busyTurn ? "true" : undefined}
                    aria-describedby={showingPreview ? previewId : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      onNavigate(item);
                    }}
                    onFocus={() => setPreviewTurn(item.turn)}
                    onBlur={() => setPreviewTurn(null)}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {preview !== undefined && previewPosition !== undefined ? (
          <div id={previewId} role="tooltip" className="turn-rail-preview" style={previewPosition}>
            <div className="turn-rail-preview-prompt">{preview.prompt || texts.turnRailTurn(preview.turn)}</div>
            {preview.response !== "" ? <div className="turn-rail-preview-response">{preview.response}</div> : null}
          </div>
        ) : null}
      </nav>
    </div>
  );
}

/**
 * memo 掉：外层的会话视图在流式期间每帧都重渲染，而横条只在「轮次增减 /
 * 预览文本变化 / 激活轮切换」时才需要动。props 里的 `items` 由调用方做
 * **引用稳定**（`useTurnRailItems` 复用内容相同的旧项），`onNavigate` 保持
 * useCallback——两者都稳，memo 才有意义。
 */
export const TurnRail = memo(TurnNavigatorRail);
