/**
 * 轨迹**时间线**（官方 `TrajectoryTimeline`）：三条泳道、轮次边界、点选与拖动选区、
 * 滚轮以光标为锚缩放、右键拖动平移、左端「加载更早」。
 *
 * 它是**呈现组件**：自己不拥有一处交互状态，只从**同一个端口对象**（
 * `trajectoryInteraction.ts` 的 `TrajectoryInteraction`）读选区 / 选中 / 视口，
 * 并把鼠标手势原样转给端口。容器 ref 也在端口里——命中判定、缩放锚点、边缘自动
 * 平移用的是**同一个** `plot` 元素与同一份最新 `zoom`/`offset`，不存在两个组件
 * 各自量一遍容器的可能（那是「拖到边缘视口追不上」「缩放锚点偏一格」的成因）。
 *
 * 与官方**刻意的差异**（见 `docs/design-trajectory.md`）：官方那三条 `onRangeChange`
 * / `onRecordSelect` / `onRecordFocus` 回调在这里合成端口上的三个动作；官方双击只清
 * 选区，本扩展在没有选区时把双击当成「复位缩放」（否则缩进去之后没有别的出路）。
 */
import { useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import {
  trajectoryScreenFraction,
  type TrajectoryTimelineMode,
} from "../../shared/trajectory";
import type { TrajectoryInteraction } from "../trajectoryInteraction";
import { consumeEscape, type EscapeKeyEvent } from "../escapeOwner";
import type { TrajectoryTimeline as TrajectoryTimelineModel } from "../trajectoryTimeline";
import {
  formatDurationMs,
  formatElapsedSeconds,
  formatRecordedTime,
  kindLabel,
  type TrajectoryTexts,
} from "../trajectoryTexts";
import { dp, useUiScale } from "../uiScale";

/** 时间线上一条条在屏幕上的落点（`left` 与 `width` 都是 0..1，含它让出的缝隙）。 */
interface SpanBox {
  span: TrajectoryTimelineModel["spans"][number];
  left: number;
  width: number;
  gap: number;
}

/**
 * 绘图区的一次按键：只有 Escape 归它——清选区与选中（官方只在有选区时吃这个键；这里
 * 一律吃，因为记录 / 请求两个检查器也归这条清理链），其余按键原样放过。
 *
 * 单独命名是为了让离线回归驱动**这一个**处理器走真实冒泡链：这次按键归元素层
 * （`consumeEscape` 盖章并吃掉冒泡），不能让没有消费者的兜底把它当成「停止生成」。
 */
export function timelineEscape(event: EscapeKeyEvent, clearSelection: () => void): void {
  if (event.key !== "Escape") return;
  consumeEscape(event);
  clearSelection();
}

/**
 * 时间线。
 * @param port - **唯一**的交互端口（容器 ref + 全部动作与状态）。
 * @param timeline - 归一化后的时间线视图模型（纯数据）。
 * @param mode - 当前模式：`time`（等时长）下的条要定宽成方形（官方 `data-equal-duration`）。
 * @param matchIndexes - 搜索命中的记录序号；`null` = 没在搜（未命中的条压暗）。
 * @param hasOlder - 上面还有更早的历史（左端那枚 `…` 出不出）。
 * @param loadingEarlier - 正在取更早的历史。
 * @param onLoadEarlier - 取更早的一页。
 * @param texts - 当前语言的轨迹词典。
 */
export function TrajectoryTimeline({
  port,
  timeline,
  mode,
  matchIndexes,
  hasOlder,
  loadingEarlier,
  onLoadEarlier,
  texts,
}: {
  port: TrajectoryInteraction;
  timeline: TrajectoryTimelineModel;
  mode: TrajectoryTimelineMode;
  matchIndexes: ReadonlySet<number> | null;
  hasOlder: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  texts: TrajectoryTexts;
}) {
  const { zoom, offset, range, record, animateViewport, gesture } = port.state;
  /** 界面倍率：缝隙与最小宽度这类几何量要走设计像素（见 `uiScale.ts`）。 */
  const scale = useUiScale();
  /**
   * 光标下的域位置（官方跟随竖线 + 高亮环的数据源）；不在绘图区里就是 null。
   *
   * hover 是**悬停反馈**、不进端口：它每帧都变，而它不参与任何决策（命中判定问 DOM）。
   */
  const [hover, setHover] = useState<number | null>(null);
  /**
   * 光标**压在哪条记录上**（官方 `hover.recordIndex`）：hover 高亮环要它，且只有它为空
   * 时才画跟随竖线。官方从事件目标上读 `data-timeline-record-index`；这里用
   * `elementFromPoint` 做同一件事（**不自己重算条的矩形**——缝隙是次像素量，
   * 自己算必然与浏览器舍入差一点）。
   */
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  /**
   * 绘图区的实际宽度（px）：把「≤1px 的缝隙」换算成域比例时要用它。
   *
   * 走 ResizeObserver 而不是在渲染时读 `port.plot`——渲染期读 DOM 会在同一帧里拿到
   * 旧值，窄栏切换 / 检查器拖宽时缝隙的判据就会滞后一帧。
   */
  const [plotWidth, setPlotWidth] = useState(0);
  useLayoutEffect(() => {
    const el = port.plot.current;
    if (!el) return;
    const measure = () => setPlotWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [port]);
  /**
   * 手势的几何输入：端口要按记录位置算「最近的一条」「边缘平移累加」，
   * 而位置在父级算好（时间线视图模型）。镜像不进快照——它每次渲染都换身份，
   * 进了快照会让订阅每帧都变。
   */
  useLayoutEffect(() => {
    port.syncSpans(timeline.spans);
  });

  /** 归一化域位置 → 屏幕比例（0..1；乘 100% 就是 CSS 位置）。 */
  const screen = (value: number) => trajectoryScreenFraction(value, offset, zoom);

  /**
   * 把时间线的每一条换算成**要画出来的**屏幕盒子（含它让出的缝隙）。
   *
   * 只给渲染用（`left` 让出一个 gap、宽度减两个 gap、还有「至少 2px」的兜底）。
   * **命中判定不吃这一份**：缝隙是 `min(宽度×8%, 1px)` 的次像素量，自己再算一遍
   * 必然与浏览器的舍入差一点。
   */
  const spanBoxes = useMemo<SpanBox[]>(() => {
    // 最小可见宽度（与渲染同一个 `max(Npx, …)` 口径）：`time` 模式与极窄条都靠它兜底
    const minimum = plotWidth > 0 ? dp(2, scale) / plotWidth : 0.005;
    // 缝隙的 1px 上限：**按比例**算一次，不是每条各减 1px
    const gapFloor = plotWidth > 0 ? dp(1, scale) / plotWidth : 0.01;
    return timeline.spans.map((span) => {
      const width = Math.max(Math.max(span.width * zoom, 0.005), minimum);
      const gap = Math.min(width * 0.08, gapFloor);
      return { span, left: screen(span.left), width, gap };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, zoom, offset, plotWidth, scale]);

  /**
   * 缩放上限：官方的最小窗口是**绝对值**（`sequence` 4 条操作 / 其余 20ms），
   * 所以「最多能放大多少倍」取决于这个会话的域有多长——长会话能放得更深。
   */
  const minimumDomain = mode === "sequence" ? 4 : 20;
  const currentDomain =
    mode === "sequence" ? timeline.spans.length : Math.max(1, timeline.domainMs);
  const maxZoom = Math.max(1, currentDomain / minimumDomain);

  const tooltipOf = (span: TrajectoryTimelineModel["spans"][number]): string => {
    const parts = [kindLabel(span.kind, texts)];
    parts.push(
      span.timeSeconds === null
        ? texts.timelineStarted(formatRecordedTime(span.startedAt))
        : texts.timelineTotal(formatElapsedSeconds(span.timeSeconds, texts)),
    );
    if (span.ttftMs !== null && span.decodingMs !== null) {
      parts.push(
        texts.timelineTtftDecoding(
          formatDurationMs(span.ttftMs, texts),
          formatDurationMs(span.decodingMs, texts),
        ),
      );
    }
    return parts.join(" · ");
  };

  return (
    <div
      className="trajectory-timeline"
      onContextMenu={(event) => {
        // 整条时间线上右键都是**平移**手势，不是弹菜单（官方 `onContextMenu` 无条件吃掉）。
        // 从前只拦了绘图区、且只在缩放后拦，于是右键会弹出 VS Code 的原生菜单、
        // 把「右键拖动」整个挡住。
        event.preventDefault();
      }}
    >
      <div className="trajectory-lanes" aria-hidden>
        <span>{texts.columnInput}</span>
        <span>{texts.columnModel}</span>
        <span>{texts.columnTools}</span>
      </div>
      <div
        className="trajectory-plot"
        ref={port.plot}
        // 视口过渡的开关（CSS 只在这条属性为 true 时给 left 加 transition）
        data-animate-viewport={animateViewport || undefined}
        role="group"
        // 可聚焦：Escape 清选区要有落点（官方那条 track 也是可聚焦的）
        tabIndex={0}
        aria-label={texts.timelineAria}
        onKeyDown={(event) => timelineEscape(event, port.clearSelection)}
        onWheel={(event) => port.zoomAtCursor(event.clientX, event.deltaY, maxZoom)}
        onMouseDown={(event) => {
          // 右键 = 平移手势；轻点不拖 = 清选择。拖到时间线外面也要跟手，
          // 监听挂在 `document` 上（在端口里），用 pointer capture 会打断 span 的点击选中。
          if (event.button === 2) {
            port.beginPan(event.clientX);
            return;
          }
          if (event.button !== 0) return;
          port.beginSlice(event.clientX);
        }}
        onMouseMove={(event) => {
          if (gesture !== null) return;
          setHover(port.domainAt(event.clientX));
          const under = document.elementFromPoint(event.clientX, event.clientY);
          const cell = under instanceof HTMLElement
            ? under.closest<HTMLElement>(".trajectory-span")
            : null;
          const index = cell?.dataset.cellIndex === undefined ? undefined : Number(cell.dataset.cellIndex);
          setHoveredIndex(index === undefined || !Number.isFinite(index) ? null : index);
        }}
        onMouseUp={(event) => port.endSlice(event.clientX)}
        onMouseLeave={() => {
          // 只收掉 hover 竖线：拖出绘图区**不结束框选**，移动与抬起由 `document` 上
          // 那两个监听接管。
          setHover(null);
          setHoveredIndex(null);
        }}
        onDoubleClick={() => {
          // 双击：有选区 / 选中就清掉（官方 `onRangeChange(null)`）；已经没得清就把
          // 缩放复位——否则缩进去之后没有别的出路
          if ((range && range.end > range.start) || record !== undefined) port.clearSelection();
          else port.resetViewport();
        }}
      >
        {/* 没有计时数据时绘图区留空提示（官方 `timeline.noTimingData`）——
            但**左端的 `…` 照样在**：有没有更早的历史与有没有计时无关 */}
        {timeline.spans.length === 0 ? (
          <span className="trajectory-plot-empty">{texts.timelineNoTimingData}</span>
        ) : null}
        {timeline.boundaries.map((boundary) => {
          const left = screen(boundary.left);
          if (left < 0 || left > 1) return null;
          return (
            <span
              key={`turn-${boundary.turn}`}
              className="trajectory-boundary"
              style={{ left: `${left * 100}%` }}
              title={texts.turnLabel(boundary.turn + 1)}
            />
          );
        })}
        {spanBoxes.map(({ span, left, width, gap }) => {
          const isSelected = span.cellIndex === record;
          // 视口外的条不画，**选中的那条例外**（官方始终保留选中条，否则点一条
          // 正好在边缘外的记录会「什么都没发生」）
          if ((left + width < 0 || left > 1) && !isSelected) return null;
          const dimmed = matchIndexes !== null && !matchIndexes.has(span.cellIndex);
          /**
           * 助手条上 TTFT / 解码的分界（官方 `--trajectory-assistant-ttft`）：
           * 只在两个时长都取到、且和为正时给，否则整条单色。
           */
          const ttftFraction =
            span.ttftMs !== null && span.decodingMs !== null && span.ttftMs + span.decodingMs > 0
              ? span.ttftMs / (span.ttftMs + span.decodingMs)
              : null;
          return (
            <button
              key={`span-${span.cellIndex}`}
              type="button"
              data-lane={span.lane}
              data-kind={span.kind}
              // 命中判定要读它（`onMouseMove` 用 `elementFromPoint` + `closest` 认这条）
              data-cell-index={span.cellIndex}
              // 官方那三个属性选择器（渐变 / 等宽定宽 / hover 环）都按它们挑
              data-assistant-timing={ttftFraction === null ? undefined : "true"}
              data-equal-duration={mode === "time" || undefined}
              data-hovered={hoveredIndex === span.cellIndex || undefined}
              className={`trajectory-span is-${span.kind}${span.error ? " is-error" : ""}${
                isSelected ? " is-selected" : ""
              }${dimmed ? " is-dimmed" : ""}`}
              style={
                {
                  // 左边界右移一个 gap、宽度减两个 gap——相邻条之间由此露出缝隙
                  left: `${(left + gap) * 100}%`,
                  width: `max(${dp(2, scale)}px, ${(width - gap * 2) * 100}%)`,
                  ...(ttftFraction === null
                    ? {}
                    : { "--trajectory-assistant-ttft-stop": `${ttftFraction * 100}%` }),
                } as CSSProperties
              }
              title={tooltipOf(span)}
              // 只拦左键：右键拖动平移要能从这个 span 上起手
              onMouseDown={(event) => {
                if (event.button === 0) event.stopPropagation();
              }}
              onClick={() => port.openRecord(span.cellIndex)}
            />
          );
        })}
        {/* 光标跟随竖线（官方 `hoverLine`）：只在不拖动、且**不在某条记录上**时画 */}
        {hover !== null && hoveredIndex === null && gesture === null ? (
          <span className="trajectory-hover" style={{ left: `${screen(hover) * 100}%` }} />
        ) : null}
        {/* 选区本体与两枚把手（官方 `.selection` + `.selectionEdges`） */}
        {range && range.end > range.start ? (
          <>
            <span
              className="trajectory-range"
              style={{
                left: `${screen(range.start) * 100}%`,
                width: `${(range.end - range.start) * zoom * 100}%`,
              }}
            />
            <span
              className="trajectory-range-edges"
              style={{
                left: `${screen(range.start) * 100}%`,
                width: `${(range.end - range.start) * zoom * 100}%`,
              }}
            />
          </>
        ) : null}
        {/* 左端「加载更早」（官方 `earlierHistory` 的位置与形态）：它标的是
            「绘图区左边界之外还有内容」，所以必须贴左缘；按下时不能起手拖选区，
            所以把 mousedown 拦掉 */}
        {hasOlder ? (
          <button
            type="button"
            className="trajectory-earlier"
            data-loading={loadingEarlier || undefined}
            title={loadingEarlier ? texts.loadingEarlier : texts.loadEarlier}
            aria-label={loadingEarlier ? texts.loadingEarlier : texts.loadEarlier}
            aria-disabled={loadingEarlier || undefined}
            disabled={loadingEarlier}
            onMouseDown={(event) => {
              if (event.button === 0) event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onLoadEarlier();
            }}
          >
            …
          </button>
        ) : null}
      </div>
      {zoom > 1 ? (
        <button
          className="trajectory-more"
          title={texts.timelineResetZoom}
          aria-label={texts.timelineResetZoom}
          onClick={() => port.resetViewport()}
        >
          ⤢
        </button>
      ) : null}
    </div>
  );
}
