/**
 * 「轨迹」视图：**官方账本的对齐实现**（第一步：工具栏 + 账本 + 详情检查器；
 * 第二步：时间线）。
 *
 * 它是**整页**视图（`App` 里会话页整块让位），不是盖在会话上的抽屉——和官方
 * Web UI 一样：官方把轨迹注册进 `conversation.view` 槽，选中哪个视图就整块换掉
 * （`dsh-client-ui-conversation lib/client.js:15122-15129`）。所以这里没有标题栏、
 * 没有关闭按钮：进出靠头部那颗「轨迹 ⇄ 会话」图标。
 *
 * 结构逐条对照 `dsh-client-ui-trajectory` 的客户端实现：
 * - **工具栏**（官方的 `TrajectoryToolbar`）：时长开关 / 轮次折叠 / 调用折叠 / 搜索；
 * - **账本**（官方 2 列：event + content）：每行 = 记录种类标签 + `#N` + 摘要，
 *   工具行把「请求 → 结果」摊成两列；
 * - **时间线**（官方的 `TrajectoryTimeline`）：三条泳道（输入 / 模型 / 工具）、
 *   轮次边界竖线、点选与拖动选区、**左端**的「加载更早」（官方 `earlierHistory`）；
 * - **详情检查器**（官方的 `details` 面板）：页签集合按记录种类派生，与官方
 *   `detailTabs()` 同一套分支。
 *
 * 与官方**刻意的差异**（见 `docs/design-trajectory.md` 与 `dsh/trajectory.ts` 的
 * 文件头）：流式中的助手正文不出行、系统提示词按 `request/header` 变化合并、
 * 时间线**没有滚轮缩放与右键平移**（官方有；这两样是纯交互糖，数据层已经齐了）。
 */
import { useMemo, useRef, useState } from "react";
import {
  deriveTrajectoryTimeline,
  type TrajectoryCell,
  type TrajectoryModel,
  type TrajectoryTimelineMode,
  type TrajectoryTurn,
} from "../../shared/trajectory";
import { IconChevronRight, IconSearch } from "../icons";
import { Markdown } from "./Markdown";
import { Spinner } from "./primitives";
import { useTexts } from "../texts";
import {
  formatDurationMs,
  formatElapsedSeconds,
  formatRecordedTime,
  kindLabel,
  sourceLabel,
  trajectoryTexts,
  type TrajectoryTexts,
} from "../trajectoryTexts";

/**
 * 检查器的默认宽度：官方是 `clamp(320px, 38%, 440px)`（相对面板宽算一个初值），
 * 拖动范围 320–720（官方 `clampDetailsWidth` 的 min/max）。
 */
function defaultInspectorWidth(): number {
  const panel = typeof window === "undefined" ? 480 : window.innerWidth;
  return Math.min(440, Math.max(320, Math.round(panel * 0.38)));
}

/** 详情检查器的页签（官方 `detailTabs()` 的等价分支）。 */type TabId = "summary" | "payload" | "result" | "schema" | "timing" | "preview" | "raw" | "source" | "system-prompt" | "tools" | "diff" | "raw-output";

interface Tab {
  id: TabId;
  label: string;
}

function tabsFor(cell: TrajectoryCell, texts: TrajectoryTexts): Tab[] {
  const summary: Tab = { id: "summary", label: texts.tabSummary };
  switch (cell.kind) {
    case "system": {
      const prompt: Tab = { id: "system-prompt", label: texts.tabSystemPrompt };
      const tools: Tab = { id: "tools", label: texts.tabTools };
      // 只有系统提示词（拿不到请求配置/工具目录）→ 官方也只给一个页签
      if (cell.systemPromptDetail !== undefined && cell.optionsDetail === undefined) return [prompt];
      return cell.previousSystemPromptDetail !== undefined
        ? [{ id: "diff", label: "Diff" }, prompt, tools]
        : [prompt, tools];
    }
    case "compacted":
      return [summary, { id: "raw-output", label: texts.tabRawOutput }];
    case "user":
    case "context":
    case "message": {
      const tabs: Tab[] = [summary, { id: "preview", label: texts.tabPreview }, { id: "raw", label: texts.tabRaw }];
      if (cell.messageSource !== undefined) tabs.push({ id: "source", label: texts.tabSource });
      return tabs;
    }
    default: {
      // 工具 / 子工具：官方 = overview + (有参数→payload) + (有结果→result) + schema + timing
      const tabs: Tab[] = [summary];
      if (cell.inputDetail !== undefined) tabs.push({ id: "payload", label: texts.tabPayload });
      if (cell.outputDetail !== undefined) tabs.push({ id: "result", label: texts.tabResult });
      tabs.push({ id: "schema", label: texts.tabSchema }, { id: "timing", label: texts.tabTiming });
      return tabs;
    }
  }
}

/** 记录种类的配色类名（官方 `kindTag` 的七种）。 */
function kindClass(cell: TrajectoryCell): string {
  return `trajectory-kind is-${cell.kind}${cell.status === "error" ? " is-error" : ""}`;
}

/** 该行在内容列里显示什么（工具行摊成「请求 → 结果」）。 */
function cellContent(cell: TrajectoryCell, texts: TrajectoryTexts): { text: string; result?: string } {
  switch (cell.kind) {
    case "system":
      if (cell.previousSystemPromptDetail !== undefined) {
        return {
          text:
            cell.toolsDetail !== undefined
              ? texts.systemPromptAndToolsUpdated
              : texts.systemPromptUpdated,
        };
      }
      return { text: cell.text || texts.initialSystemPrompt };
    case "compacted":
      if (cell.status === "error") return { text: texts.compactionFailed };
      return { text: cell.status === "running" ? texts.compacting : cell.text || texts.compacted };
    case "message":
      // 流式中那一行正文还是空的（官方此时也是空的，token 到了才长出来）——
      // 不能退化成「仅工具调用」，那是**已结算且没正文**时的说法
      if (cell.status === "running" && !cell.text) return { text: "" };
      return { text: cell.text || texts.toolCallOnly };
    default:
      return { text: cell.text, ...(cell.result === undefined ? {} : { result: cell.result }) };
  }
}

/** 一轮里能不能折叠（官方 `collapsibleTurnIds`：非 system 的记录多于一条）。 */
function turnCollapsible(turn: TrajectoryTurn): boolean {
  if (turn.turn === null) return false;
  return turn.cells.filter((cell) => cell.requestOnly !== true && cell.kind !== "system").length > 1;
}

/** 轮次折叠后那行显示的摘要（官方 `request.collapsedSummary`：`已收起的<kind>概述，<摘要>`）。 */
function turnSummary(turn: TrajectoryTurn, texts: TrajectoryTexts): string {
  // 摘要取这一轮里第一条非 system 记录的文本（通常就是用户的提问）——
  // 官方那行也是「…+ 摘要」的形态，不把条数写进句子里（句子里没有这个槽位）
  const first = turn.cells.find((cell) => cell.kind !== "system" && cell.text);
  return texts.collapsedSummary(texts.collapsedTurn, first?.text ?? "");
}

function Inspector({
  cell,
  previousTools,
  texts,
  width,
  onWidth,
  onClose,
}: {
  cell: TrajectoryCell;
  /** 该行之前最近一次生效的工具目录（Schema 页签要按调用时的目录查）。 */
  previousTools: TrajectoryCell["toolsDetail"];
  texts: TrajectoryTexts;
  /** 检查器宽度（px）。官方是 `clamp(320px, 38%, 440px)`，可拖动调宽（320–720）。 */
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
}) {
  const tabs = useMemo(() => tabsFor(cell, texts), [cell, texts]);
  const [tab, setTab] = useState<TabId>("summary");
  const [history, setHistory] = useState<{ key: string; tab: TabId }>({ key: "", tab: "summary" });
  const resizing = useRef<{ x: number; width: number } | null>(null);
  // 切记录时保留仍然可用的页签（官方 `tabHistory` 同口径），否则回到「概述」
  const key = `${cell.seq}:${cell.index}`;
  if (history.key !== key) {
    const keep = tabs.some((entry) => entry.id === history.tab) ? history.tab : "summary";
    setHistory({ key, tab: keep });
    if (tab !== keep) setTab(keep);
  }

  const schema = useMemo(() => {
    if (cell.toolName === undefined || !previousTools) return undefined;
    return previousTools.find((tool) => tool.name === cell.toolName);
  }, [cell.toolName, previousTools]);

  const row = (label: string, value: string) =>
    value ? (
      <div className="trajectory-detail-row" key={label}>
        <span className="trajectory-detail-label">{label}</span>
        <span className="trajectory-detail-value" title={value}>
          {value}
        </span>
      </div>
    ) : null;

  const status =
    cell.status === "running" ? texts.statusPending : cell.status === "error" ? texts.statusFailed : texts.statusCompleted;

  /**
   * 各页签的正文**抽在一起**：概述页里的同名分节要显示的就是这一份内容
   * （官方 `overviewSections` 里那几节，点的也是同一个正文组件），
   * 分成两处写迟早会走样。
   */
  const bodies: Record<TabId, React.ReactNode> = {
    summary: null,
    payload: cell.inputDetail ? (
      <pre className="trajectory-pre">{cell.inputDetail}</pre>
    ) : (
      <div className="trajectory-empty">{texts.recordNoPayload}</div>
    ),
    result: cell.outputDetail ? (
      <pre className="trajectory-pre">{cell.outputDetail}</pre>
    ) : (
      <div className="trajectory-empty">{texts.recordNoResult}</div>
    ),
    "raw-output": cell.inputDetail ? (
      <pre className="trajectory-pre">{cell.inputDetail}</pre>
    ) : (
      <div className="trajectory-empty">{texts.recordNoOutput}</div>
    ),
    preview: cell.previewMarkdown ? (
      <div className="trajectory-markdown">
        <Markdown text={cell.previewMarkdown} />
      </div>
    ) : (
      <div className="trajectory-empty">{texts.recordNoContent}</div>
    ),
    raw: <pre className="trajectory-pre">{cell.previewMarkdown ?? cell.outputDetail ?? ""}</pre>,
    source:
      cell.messageSource?.raw !== undefined ? (
        <pre className="trajectory-pre">{JSON.stringify(cell.messageSource.raw, null, 2)}</pre>
      ) : (
        <div className="trajectory-empty">{texts.sourceNotRecorded}</div>
      ),
    "system-prompt": cell.systemPromptDetail ? (
      <pre className="trajectory-pre">{cell.systemPromptDetail}</pre>
    ) : (
      <div className="trajectory-empty">{texts.recordSystemPromptMissing}</div>
    ),
    diff: (
      <>
        {cell.previousSystemPromptDetail !== undefined ? (
          <div className="trajectory-detail-block">
            <div className="trajectory-detail-label">{texts.detailsCompacted}</div>
            <pre className="trajectory-pre">{cell.previousSystemPromptDetail}</pre>
          </div>
        ) : null}
        <div className="trajectory-detail-block">
          <div className="trajectory-detail-label">{texts.tabSystemPrompt}</div>
          <pre className="trajectory-pre">{cell.systemPromptDetail ?? ""}</pre>
        </div>
      </>
    ),
    tools: cell.toolsDetail?.length ? (
      cell.toolsDetail.map((tool) => (
        <details key={tool.name} className="trajectory-tool">
          <summary>{tool.name}</summary>
          {tool.description ? <div className="trajectory-tool-desc">{tool.description}</div> : null}
          {tool.parameters === undefined ? null : (
            <pre className="trajectory-pre">{JSON.stringify(tool.parameters, null, 2)}</pre>
          )}
        </details>
      ))
    ) : (
      <div className="trajectory-empty">{texts.recordToolsMissing}</div>
    ),
    schema: schema ? (
      <>
        <div className="trajectory-detail-label">{schema.name}</div>
        {schema.description ? <div className="trajectory-tool-desc">{schema.description}</div> : null}
        {schema.parameters === undefined ? null : (
          <pre className="trajectory-pre">{JSON.stringify(schema.parameters, null, 2)}</pre>
        )}
      </>
    ) : (
      <div className="trajectory-empty">
        {cell.toolName === undefined ? texts.recordSchemaUnavailable : `${texts.recordParameters}: ${cell.toolName}`}
      </div>
    ),
    timing: (
      <>
        {row(texts.timingStarted, formatRecordedTime(cell.startedAt))}
        {row(texts.timingTotalDuration, formatElapsedSeconds(cell.timeSeconds, texts))}
        {cell.assistantMetrics ? (
          <>
            {row(
              texts.timingTtft,
              cell.assistantMetrics.firstTokenTime === null
                ? texts.timingNotRecorded
                : formatRecordedTime(cell.assistantMetrics.firstTokenTime),
            )}
            {row(
              texts.timingGeneration,
              cell.assistantMetrics.stepStartTime !== null && cell.assistantMetrics.completedTime !== null
                ? formatDurationMs(
                    cell.assistantMetrics.completedTime - cell.assistantMetrics.stepStartTime,
                    texts,
                  )
                : texts.timingNotAvailable,
            )}
            {row(
              texts.usageOutput,
              formatDurationMs(
                cell.assistantMetrics.outputTokens === null || cell.timeSeconds === null
                  ? null
                  : cell.timeSeconds * 1000,
                texts,
              ),
            )}
          </>
        ) : null}
      </>
    ),
  };

  /**
   * 概述页里摊开哪几节（官方 `overviewSections` 的同一套分派）：
   * markdown 记录（user / context / message）只有「预览」一节；
   * 工具与子工具是「参数 / 结果 / Schema / 计时」四节（参数与结果没内容就不出）。
   */
  const sections: { key: string; label: string; tab?: TabId; body: React.ReactNode }[] = [];
  const timingInSection = cell.kind === "tool" || cell.kind === "subtool";
  if (cell.kind === "user" || cell.kind === "context" || cell.kind === "message") {
    sections.push({ key: "preview", label: texts.tabPreview, tab: "preview", body: bodies.preview });
  } else if (timingInSection) {
    if (cell.inputDetail !== undefined) {
      sections.push({ key: "payload", label: texts.tabPayload, tab: "payload", body: bodies.payload });
    }
    if (cell.outputDetail !== undefined) {
      sections.push({ key: "result", label: texts.tabResult, tab: "result", body: bodies.result });
    }
    sections.push({ key: "schema", label: texts.tabSchema, tab: "schema", body: bodies.schema });
    sections.push({ key: "timing", label: texts.tabTiming, tab: "timing", body: bodies.timing });
  }

  return (
    <aside className="trajectory-details" aria-label={texts.detailsEvent} style={{ width: `${width}px`, flex: "0 0 auto" }}>
      {/* 左边这条把手调宽（官方 `details.resize` / `details.resizeTitle`；
          双击复位到默认宽度） */}
      <span
        className="trajectory-resize"
        role="separator"
        aria-label={texts.detailsResize}
        title={texts.detailsResizeTitle}
        onMouseDown={(event) => {
          resizing.current = { x: event.clientX, width };
          event.preventDefault();
        }}
        onMouseMove={(event) => {
          const start = resizing.current;
          if (!start) return;
          // 往左拖 = 变宽（把手在检查器左边缘）
          onWidth(Math.min(720, Math.max(280, start.width - (event.clientX - start.x))));
        }}
        onMouseUp={() => {
          resizing.current = null;
        }}
        onMouseLeave={() => {
          resizing.current = null;
        }}
        onDoubleClick={() => onWidth(defaultInspectorWidth())}
      />
      <div className="trajectory-details-head">
        <span className="trajectory-details-title">
          {`#${cell.index} `}
          {kindLabel(cell.kind, texts)}
        </span>
        <button className="icon-btn" title={texts.detailsClose} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="trajectory-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className={`trajectory-tab${tab === entry.id ? " is-active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="trajectory-detail-body">
        {tab === "summary" ? (
          <>
            {row(texts.detailsStatus, status)}
            {row(texts.detailsProvider, cell.provider ?? "")}
            {row(texts.detailsModel, cell.model ?? "")}
            {cell.requestNumber !== undefined
              ? row("", cell.kind === "compacted" ? texts.requestLabelCompaction(cell.requestNumber) : texts.requestLabel(cell.requestNumber))
              : null}
            {row(texts.detailsError, cell.error ?? "")}
            {cell.retry
              ? row(
                  texts.detailsRetry,
                  cell.retry.max === undefined
                    ? String(cell.retry.attempt)
                    : texts.requestRetryProgress(cell.retry.attempt, cell.retry.max),
                )
              : null}
            {cell.messageSource ? row(texts.detailsSource, sourceLabel(cell.messageSource, texts)) : null}
            {/* 工具 / 子工具的「开始时间 + 总时长」在下面的「计时」分节里，
                这里不再重复一遍（官方也是这个分工：概述行只管来源/层级/状态，
                计时进 `tab.timing` 那一节）。 */}
            {timingInSection ? null : row(texts.timingStarted, formatRecordedTime(cell.startedAt))}
            {timingInSection ? null : row(texts.timingTotalDuration, formatElapsedSeconds(cell.timeSeconds, texts))}
            {cell.usage ? (
              <>
                {row(texts.usageInput, String(cell.usage.input ?? 0))}
                {row(texts.usageCached, String(cell.usage.cacheRead ?? 0))}
                {row(texts.usageCacheCreated, String(cell.usage.cacheWrite ?? 0))}
                {row(texts.usageOutput, String(cell.usage.output ?? 0))}
                {row(texts.usageReasoning, String(cell.usage.think ?? 0))}
              </>
            ) : null}
            {cell.thinkingDetail ? (
              <div className="trajectory-detail-block">
                <div className="trajectory-detail-label">{texts.recordThinking}</div>
                <pre className="trajectory-pre">{cell.thinkingDetail}</pre>
              </div>
            ) : null}

            {/* 压缩记录的摘要正文（官方 `compactedSummary`：没有分节标题，直接摊开） */}
            {cell.kind === "compacted" && cell.outputDetail ? (
              <div className="trajectory-markdown trajectory-compacted-summary">
                <Markdown text={cell.outputDetail} />
              </div>
            ) : null}

            {/* 概述里**直接摊开后几张卡片的内容**（官方 `overviewSections`）：
                工具行 = 参数 / 结果 / Schema / 计时，markdown 记录 = 预览。
                标题可点：点了切到对应页签看完整版。 */}
            <div className="trajectory-overview-sections">
              {sections.map((section) => (
                <section className="trajectory-overview-section" key={section.key}>
                  <div className="trajectory-overview-heading">
                    {section.tab === undefined ? (
                      <span className="trajectory-overview-title">{section.label}</span>
                    ) : (
                      <button
                        type="button"
                        className="trajectory-overview-title"
                        title={section.label}
                        onClick={() => setTab(section.tab as TabId)}
                      >
                        {section.label}
                        <IconChevronRight size={12} />
                      </button>
                    )}
                  </div>
                  <div className="trajectory-overview-preview">{section.body}</div>
                </section>
              ))}
            </div>
          </>
        ) : (
          bodies[tab]
        )}
      </div>
    </aside>
  );
}

/**
 * 时间线：三条泳道 + 轮次边界 + 点选 / 拖动选区 + 左端「加载更早」。
 *
 * 官方那条是 50px 高的概览条（`.plot` 左侧 44px 放泳道标签）。**没有**滚轮缩放与
 * 右键平移——那两样是纯交互糖，先不做（数据层已齐，随时能补）。
 *
 * 泳道归属（官方 `laneFor` 逐字）：工具/子工具 → 工具道；助手/压缩 → 模型道；
 * 其余（系统/用户/上下文）→ 输入道。
 *
 * 「加载更早」的位置照官方：**贴住绘图区左缘**（官方 `earlierHistory` 是
 * `position:absolute; left:0; top:0; bottom:0; width:28px` + 向右渐隐），
 * 不是排在绘图区右边——它标的是「左边界之外还有内容」这个方向。
 */
function TrajectoryTimeline({
  timeline,
  selected,
  range,
  onSelect,
  onRange,
  onLoadEarlier,
  loadingEarlier,
  hasOlder,
  texts,
}: {
  timeline: ReturnType<typeof deriveTrajectoryTimeline>;
  selected: number | undefined;
  range: { start: number; end: number } | null;
  onSelect: (index: number) => void;
  onRange: (range: { start: number; end: number } | null) => void;
  onLoadEarlier: () => void;
  loadingEarlier: boolean;
  hasOlder: boolean;
  texts: TrajectoryTexts;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const panning = useRef<{ x: number; offset: number } | null>(null);
  /**
   * 视口：`zoom` = 放大倍数（1 = 全部铺满），`offset` = 左边界在 0..1 里的位置。
   *
   * 官方的交互是「滚轮以光标为锚缩放 + 右键拖动平移」（`Math.exp(deltaY * 0.0015)`、
   * `pannable` 仅在已缩放时）。这里照同一套，只是把「最小缩放」定成 1（不缩到看不全）。
   */
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(0);

  const maxOffset = Math.max(0, 1 - 1 / zoom);
  const clampOffset = (value: number) => Math.min(maxOffset, Math.max(0, value));
  /** 归一化位置 → 屏幕位置（0..1）。 */
  const screen = (value: number) => (value - offset) * zoom;

  /** 客户端 x → 0..1 的归一化位置（夹到两端）。 */
  const positionOf = (clientX: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  /** 滚轮缩放：**以光标为锚**（光标下那条记录不动）。 */
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const anchorScreen = positionOf(event.clientX);
    // 屏幕位置 → 域位置（缩放前）
    const anchorDomain = offset + anchorScreen / zoom;
    // 官方那行是 `Math.exp(deltaY * 0.0015)`，乘在**域跨度**上：向上滚（deltaY<0）
    // 域变小 = 放大。这里的 `zoom` 是放大倍数（越大越放大），所以要取倒数——
    // 照抄原式的符号会让「向上滚」变成缩小（第一次实现就是这么错的）。
    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(100, Math.max(1, zoom * factor));
    if (next === zoom) return;
    setZoom(next);
    setOffset(Math.min(Math.max(0, 1 - 1 / next), Math.max(0, anchorDomain - anchorScreen / next)));
  };

  const tooltipOf = (span: (typeof timeline.spans)[number]): string => {
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
    <div className="trajectory-timeline">
      <div className="trajectory-lanes" aria-hidden>
        <span>{texts.columnInput}</span>
        <span>{texts.columnModel}</span>
        <span>{texts.columnTools}</span>
      </div>
      <div
        className={`trajectory-plot${zoom > 1 ? " is-zoomed" : ""}`}
        ref={ref}
        role="group"
        aria-label={texts.timelineAria}
        onWheel={onWheel}
        onContextMenu={(event) => {
          // 右键是**平移**手势（官方 `pannable`）：不弹原生菜单
          if (zoom > 1) event.preventDefault();
        }}
        onMouseDown={(event) => {
          // 右键 + 已缩放 → 平移视口（官方同款）
          if (event.button === 2 && zoom > 1) {
            panning.current = { x: event.clientX, offset };
            return;
          }
          if (event.button !== 0) return;
          const at = positionOf(event.clientX);
          dragging.current = at;
          onRange({ start: at, end: at });
        }}
        onMouseMove={(event) => {
          const pan = panning.current;
          if (pan) {
            const el = ref.current;
            const width = el?.getBoundingClientRect().width ?? 0;
            if (width > 0) setOffset(clampOffset(pan.offset - (event.clientX - pan.x) / width / zoom));
            return;
          }
          const start = dragging.current;
          if (start === null) return;
          const at = positionOf(event.clientX);
          onRange({ start: Math.min(start, at), end: Math.max(start, at) });
        }}
        onMouseUp={() => {
          dragging.current = null;
          panning.current = null;
        }}
        onMouseLeave={() => {
          dragging.current = null;
          panning.current = null;
        }}
        onDoubleClick={() => {
          // 双击：先清空选区；已经没选区了就把缩放复位（官方双击是清选区，这里多一步
          // 「回到全部」，否则缩进去之后没有别的出路）
          if (range && range.end > range.start) onRange(null);
          else {
            setZoom(1);
            setOffset(0);
          }
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
        {timeline.spans.map((span) => {
          const left = screen(span.left);
          const width = span.width * zoom;
          if (left + width < 0 || left > 1) return null;
          return (
            <button
              key={`span-${span.cellIndex}`}
              type="button"
              data-lane={span.lane}
              data-kind={span.kind}
              className={`trajectory-span is-${span.kind}${span.error ? " is-error" : ""}${
                span.cellIndex === selected ? " is-selected" : ""
              }`}
              style={{
                left: `${left * 100}%`,
                // 0 宽度（`time` 模式）也要看得见：给一个最小可见宽度
                width: `${Math.max(width * 100, 0.5)}%`,
              }}
              title={tooltipOf(span)}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => onSelect(span.cellIndex)}
            />
          );
        })}
        {range && range.end > range.start ? (
          <span
            className="trajectory-range"
            style={{
              left: `${screen(range.start) * 100}%`,
              width: `${(range.end - range.start) * zoom * 100}%`,
            }}
          />
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
            onMouseDown={(event) => event.stopPropagation()}
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
          onClick={() => {
            setZoom(1);
            setOffset(0);
          }}
        >
          ⤢
        </button>
      ) : null}
    </div>
  );
}
/**
 * 轨迹视图本体（整页）：工具栏 + 时间线 + 账本（+ 详情检查器）。
 *
 * **没有标题栏**：视图切换由头部那颗「轨迹 ⇄ 会话」图标负责，这里再放一条
 * 「轨迹」标题 + 关闭按钮就是重复的入口（用户 2026-09-14 报的那条「点了之后标题栏
 * 突然多出一个『加载早期历史』按钮」也是它——标题栏里那个按钮与时间线左端的 `…`
 * 是同一个动作的两份入口，现在只留官方那一个）。
 */
export function TrajectoryView({
  model,
  locale,
  onLoadEarlier,
  loadingEarlier,
}: {
  model: TrajectoryModel | undefined;
  locale: string | undefined;
  onLoadEarlier: () => void;
  loadingEarlier: boolean;
}) {
  const texts = useTexts();
  const tt = useMemo(() => trajectoryTexts(locale), [locale]);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<number>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ index: number } | undefined>(undefined);
  /** 时间线模式：官方工具栏「时长」开关（`sequence` ⇄ `duration`）。 */
  const [mode, setMode] = useState<TrajectoryTimelineMode>("sequence");
  /** 时间线上拖出来的选区（用来在账本里高亮那一段）。 */
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  /** 检查器宽度（官方那套 clamp(320, 38%, 440) 的初值 + 可拖到 280–720）。 */
  const [inspectorWidth, setInspectorWidth] = useState(() => defaultInspectorWidth());

  const turns = model?.turns ?? [];
  const allCells = useMemo(() => turns.flatMap((turn) => turn.cells), [turns]);
  const timeline = useMemo(() => deriveTrajectoryTimeline(allCells, mode), [allCells, mode]);
  /** 落在时间线选区里的记录（账本行加 `is-in-range`）。 */
  const inRange = useMemo(() => {
    if (!range || range.end <= range.start) return undefined;
    const set = new Set<number>();
    for (const span of timeline.spans) {
      const right = span.left + span.width;
      if (span.left < range.end && right > range.start) set.add(span.cellIndex);
    }
    return set;
  }, [range, timeline]);
  /** 可折叠的轮次（`turn.turn !== null`）与「后跟工具」的助手行。 */
  const collapsibleTurns = useMemo(
    () => turns.filter((turn) => turnCollapsible(turn)).map((turn) => turn.turn as number),
    [turns],
  );
  const collapsibleCalls = useMemo(() => {
    const ids: number[] = [];
    const flat = turns.flatMap((turn) => turn.cells);
    for (let index = 0; index < flat.length - 1; index += 1) {
      const cell = flat[index];
      const next = flat[index + 1];
      if (cell.kind === "message" && (next.kind === "tool" || next.kind === "subtool")) ids.push(cell.index);
    }
    return ids;
  }, [turns]);

  const allTurnsCollapsed = collapsibleTurns.length > 0 && collapsibleTurns.every((id) => collapsedTurns.has(id));
  const allCallsCollapsed = collapsibleCalls.length > 0 && collapsibleCalls.every((id) => collapsedCalls.has(id));

  const toggleAllTurns = () => setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(collapsibleTurns));
  const toggleAllCalls = () => setCollapsedCalls(allCallsCollapsed ? new Set() : new Set(collapsibleCalls));

  const needle = query.trim().toLowerCase();
  const matches = (cell: TrajectoryCell): boolean => {
    if (!needle) return false;
    const haystack = [
      kindLabel(cell.kind, tt),
      cell.text,
      cell.previewMarkdown,
      cell.outputDetail,
      cell.inputDetail,
      cell.result,
      cell.toolName,
      cell.callId,
      cell.error,
    ]
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  };

  /** 选中行之前的工具目录（Schema 页签按调用时的目录查）。 */
  const toolsBefore = (index: number): TrajectoryCell["toolsDetail"] => {
    let found: TrajectoryCell["toolsDetail"];
    for (const turn of turns) {
      for (const cell of turn.cells) {
        if (cell.index >= index) return found;
        if (cell.kind === "system" && cell.toolsDetail) found = cell.toolsDetail;
      }
    }
    return found;
  };

  const selectedCell =
    selected === undefined
      ? undefined
      : turns.flatMap((turn) => turn.cells).find((cell) => cell.index === selected.index);
  const selectedTools = selectedCell ? toolsBefore(selectedCell.index) : undefined;

  const rows: React.ReactNode[] = [];
  for (const turn of turns) {
    const turnId = turn.turn;
    const collapsed = turnId !== null && collapsedTurns.has(turnId);
    if (collapsed) {
      rows.push(
        <tr
          key={`turn-${turnId}`}
          className="trajectory-row is-collapsed-summary"
          onClick={() => setCollapsedTurns((prev) => new Set([...prev].filter((id) => id !== turnId)))}
        >
          <td className="trajectory-event">
            <span className="trajectory-turn-label">{tt.turnLabel((turnId ?? 0) + 1)}</span>
          </td>
          <td className="trajectory-content">{turnSummary(turn, tt)}</td>
        </tr>,
      );
      continue;
    }
    let lastRequest: number | undefined;
    for (let position = 0; position < turn.cells.length; position += 1) {
      const cell = turn.cells[position];
      // 「调用」折叠：助手行折叠时把紧跟在它后面的工具行收起来
      const callHidden =
        collapsedCalls.size > 0 &&
        cell.kind !== "message" &&
        (() => {
          for (let back = position - 1; back >= 0; back -= 1) {
            const previous = turn.cells[back];
            if (previous.kind === "message") return collapsedCalls.has(previous.index);
            if (previous.kind !== "tool" && previous.kind !== "subtool") return false;
          }
          return false;
        })();
      if (callHidden) continue;
      const showTurnLabel = position === 0;
      const showRequest = cell.requestNumber !== undefined && cell.requestNumber !== lastRequest;
      lastRequest = cell.requestNumber ?? lastRequest;
      const content = cellContent(cell, tt);
      const isMatch = needle !== "" && matches(cell);
      rows.push(
        <tr
          key={`${cell.kind}-${cell.index}`}
          className={`trajectory-row${cell.status === "error" ? " is-error" : ""}${
            selected?.index === cell.index ? " is-selected" : ""
          }${inRange?.has(cell.index) ? " is-in-range" : ""}${needle && !isMatch ? " is-dimmed" : ""}${
            isMatch ? " is-match" : ""
          }`}
          aria-selected={selected?.index === cell.index}
          onClick={() => setSelected({ index: cell.index })}
          onDoubleClick={() => {
            if (turnId !== null && turnCollapsible(turn)) {
              setCollapsedTurns((prev) => {
                const next = new Set(prev);
                if (next.has(turnId)) next.delete(turnId);
                else next.add(turnId);
                return next;
              });
              return;
            }
            if (collapsibleCalls.includes(cell.index)) {
              setCollapsedCalls((prev) => {
                const next = new Set(prev);
                if (next.has(cell.index)) next.delete(cell.index);
                else next.add(cell.index);
                return next;
              });
            }
          }}
        >
          <td className="trajectory-event">
            {showTurnLabel ? (
              <span className="trajectory-turn-label">
                {turnId === null ? tt.betweenTurns : tt.turnLabel(turnId + 1)}
              </span>
            ) : null}
            <span className="trajectory-event-inner">
              <span className="trajectory-index">{`#${cell.index}`}</span>
              {cell.status === "running" ? <span className="dot dot-running" aria-hidden /> : null}
              <span className={kindClass(cell)}>{kindLabel(cell.kind, tt)}</span>
            </span>
          </td>
          <td className="trajectory-content">
            {showRequest ? (
              <span className="trajectory-request">
                {cell.kind === "compacted" ? tt.requestLabelCompaction(cell.requestNumber as number) : tt.requestLabel(cell.requestNumber as number)}
              </span>
            ) : null}
            <span className="trajectory-text" title={[content.text, content.result].filter(Boolean).join(" → ")}>
              {content.text}
            </span>
            {content.result === undefined ? null : (
              <>
                <span className="trajectory-arrow">→</span>
                <span className="trajectory-result" title={content.result}>
                  {content.result}
                </span>
              </>
            )}
          </td>
        </tr>,
      );
    }
  }

  return (
    <div className="trajectory-view" role="region" aria-label={tt.title}>
      <div className="trajectory-toolbar" role="toolbar" aria-label={tt.toolbarAria}>
        <div className="trajectory-toolbar-actions">
          {/* 时长开关：官方 `toolbar.duration`（按下 = 按真实耗时成条，未按下 = 等宽） */}
          <button
            className="btn btn-ghost"
            aria-pressed={mode !== "sequence"}
            title={mode === "sequence" ? tt.toolbarUseActualDuration : tt.toolbarUseEqualWidth}
            onClick={() => {
              setMode(mode === "sequence" ? "duration" : "sequence");
              setRange(null);
            }}
          >
            {tt.toolbarDuration}
          </button>
          <button
            className="btn btn-ghost"
            title={allTurnsCollapsed ? tt.toolbarExpandTurns : tt.toolbarCollapseTurns}
            aria-pressed={allTurnsCollapsed}
            disabled={collapsibleTurns.length === 0}
            onClick={toggleAllTurns}
          >
            {tt.toolbarTurns}
          </button>
          <button
            className="btn btn-ghost"
            title={allCallsCollapsed ? tt.toolbarExpandCalls : tt.toolbarCollapseCalls}
            aria-pressed={allCallsCollapsed}
            disabled={collapsibleCalls.length === 0}
            onClick={toggleAllCalls}
          >
            {tt.toolbarCalls}
          </button>
        </div>
        <span className="trajectory-search">
          <IconSearch size={12} />
          <input
            type="search"
            aria-label={tt.toolbarSearch}
            placeholder={tt.toolbarSearchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
      </div>

      {model !== undefined && turns.length > 0 ? (
        <TrajectoryTimeline
          timeline={timeline}
          selected={selected?.index}
          range={range}
          onSelect={(index) => setSelected({ index })}
          onRange={setRange}
          onLoadEarlier={onLoadEarlier}
          loadingEarlier={loadingEarlier}
          hasOlder={model.hasOlder}
          texts={tt}
        />
      ) : null}

      <div className="trajectory-body">
        <div className="trajectory-ledger">
          {model === undefined ? (
            <div className="popover-empty">{tt.loading}</div>
          ) : turns.length === 0 ? (
            <div className="popover-empty">{texts.trajectoryEmpty}</div>
          ) : (
            <table className="trajectory-table">
              <colgroup>
                <col className="trajectory-col-event" />
                <col className="trajectory-col-content" />
              </colgroup>
              <tbody>
                {/* 「加载更早的历史」：官方把这一行放在账本**最上面**
                    （`historyLoadRow` + `historyLoadButton`），与时间线左端那个 `…`
                    是同一个动作——两者都走会话页那条取历史的链路：点一下让会话去取，
                    取完这一页自己再要一份账本（见 `App` 的 `historyLoading` 收尾）。
                    取的过程中这行显示 spinner +「正在加载更早的历史…」，不是「点了没反应」。 */}
                {model.hasOlder ? (
                  <tr className="trajectory-history-row">
                    <td colSpan={2}>
                      <button
                        type="button"
                        className="trajectory-history-load"
                        disabled={loadingEarlier}
                        title={loadingEarlier ? tt.loadingEarlier : tt.loadEarlier}
                        onClick={onLoadEarlier}
                      >
                        {loadingEarlier ? <Spinner size={11} /> : null}
                        <span>{loadingEarlier ? tt.loadingEarlier : tt.loadEarlier}</span>
                      </button>
                    </td>
                  </tr>
                ) : null}
                {rows}
              </tbody>
            </table>
          )}
        </div>
        {selectedCell ? (
          <Inspector
            cell={selectedCell}
            previousTools={selectedTools}
            texts={tt}
            width={inspectorWidth}
            onWidth={setInspectorWidth}
            onClose={() => setSelected(undefined)}
          />
        ) : null}
      </div>
    </div>
  );
}
