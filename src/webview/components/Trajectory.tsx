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
 * 文件头）：流式中的助手正文不出行、系统提示词按 `request/header` 变化合并。
 * 时间线的交互与官方同款（滚轮以光标为锚缩放、右键拖动平移、双击复位，见
 * `TrajectoryTimeline`）。
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  trajectoryTurnCells,
  type TrajectoryCell,
  type TrajectoryModel,
  type TrajectoryRequest,
  type TrajectoryRequestUsage,
  type TrajectoryTimelineMode,
  type TrajectoryTurn,
} from "../../shared/trajectory";
import { TrajectorySearchIndex } from "../../vendor/ui-trajectory/trajectory-search-index";
import { IconChevronRight, IconKindAssistant, IconKindCompacted, IconKindContext, IconKindSystem, IconKindUser, IconSearch, IconWrench } from "../icons";
import { Markdown } from "./Markdown";
import { PromptDiffSection } from "./PromptDiff";
import { Spinner } from "./primitives";
import { SourceBlocks } from "./SourceBlocks";
import { TrajectoryPre } from "./TrajectoryPre";
import { useTexts } from "../texts";
import { trajectoryAssistantRequestNumber, trajectoryAssistantSummary, trajectoryCallCellIndex, trajectoryCellContent, trajectoryCellError, trajectoryCodeProgram, trajectoryGroupTitle, trajectoryRecordGenerationTime, trajectoryRecordThroughput, trajectoryRecordTotalTime, trajectoryRecordTtft, trajectoryRequestCallCounts, trajectoryRequestCells, trajectoryRowLabel, trajectoryToolUpdateParams, trajectoryTurnSummary, trajectoryUsesSourceBlocks, type TrajectoryRequestCallCounts } from "../trajectoryDisplay";
import { trajectoryRowPositions, trajectoryWindowPlan, VIRTUALIZATION_THRESHOLD, VIRTUAL_ROW_HEIGHT } from "../trajectoryVirtual";
import { trajectoryCollapsibleCalls, trajectoryCollapsibleTurns, trajectoryLedgerRows } from "../trajectoryLedgerRows";
import { useTrajectoryInteraction, type TrajectoryRequestTab } from "../trajectoryInteraction";
import { TrajectoryTimeline } from "./TrajectoryTimeline";
import { deriveTrajectoryTimeline } from "../trajectoryTimeline";
import { trajectoryCellRecordId, vendorTurns } from "../trajectoryVendor";
import { dp, useUiScale } from "../uiScale";

/**
 * 空轮次列表的**稳定**引用。
 *
 * `model?.turns ?? []` 每次渲染都会新建一个数组，而它正是下面两个 `useMemo`
 * 的依赖——数组每次都是新身份，`allCells` / `timeline` 于是每渲染必重算
 * （时间线几百条记录，流式期间每帧都白烧一遍）。
 */
const NO_TURNS: TrajectoryTurn[] = [];

/**
 * 搜索索引的更新节流（官方 `SEARCH_INDEX_THROTTLE_MS`，3 秒）。
 *
 * 索引重建要重解析每条记录里那几段 Markdown 预览，属于这一页最贵的计算；流式期间
 * 账本每几秒就变一次，不节流会把同一批记录反复重解析。官方取 3 秒，这里照抄。
 */
const SEARCH_INDEX_THROTTLE_MS = 3_000;

/**
 * 「时长」开关的持久化键（官方 `dsh.trajectory.duration`，跨会话共享同一个偏好）。
 * webview 的 `localStorage` 按扩展 origin 隔离，正好是官方那份「浏览器级偏好」的对应物。
 */
const DURATION_PREFERENCE_KEY = "dsh.trajectory.duration";

/** 读「时长」开关：只有明确存过 `1` 才是按耗时（默认等宽，与官方的默认值一致）。 */
function readDurationPreference(): TrajectoryTimelineMode {
  try {
    return window.localStorage.getItem(DURATION_PREFERENCE_KEY) === "1" ? "duration" : "sequence";
  } catch {
    // 隐私模式 / 存储被禁用时读会抛：退化成默认值，不影响这一页能用
    return "sequence";
  }
}

/** 写「时长」开关（写失败就算了，偏好不是功能）。 */
function writeDurationPreference(mode: TrajectoryTimelineMode): void {
  try {
    window.localStorage.setItem(DURATION_PREFERENCE_KEY, mode === "sequence" ? "0" : "1");
  } catch {
    // 同上
  }
}
import {
  formatDurationMs,
  formatElapsedSeconds,
  formatStartedAt,
  kindLabel,
  sourceLabel,
  trajectoryTexts,
  type TrajectoryTexts,
} from "../trajectoryTexts";

/**
 * 检查器的默认宽度：官方是 `clamp(320px, 38%, 440px)`（相对面板宽算一个初值），
 * 拖动范围 320–720（官方 `clampDetailsWidth` 的 min/max）。
 *
 * 两个端点都是**设计像素**（按界面倍率换算）；`38%` 那一支量的是面板宽，是容器给的
 * 物理像素，不乘倍率——同一把尺子上比大小，故先把设计像素换成实际像素再夹。
 */
function defaultInspectorWidth(scale: number): number {
  const panel = typeof window === "undefined" ? 480 : window.innerWidth;
  return Math.min(dp(440, scale), Math.max(dp(320, scale), Math.round(panel * 0.38)));
}

/**
 * 虚拟化的三个数在 `../trajectoryVirtual.ts`（纯决策 + 断言都在那边）：行数超过
 * `VIRTUALIZATION_THRESHOLD` 才启用、视口外多渲染 `VIRTUAL_OVERSCAN_ROWS` 行、
 * 行高估不出来时按 `VIRTUAL_ROW_HEIGHT` 算。这里只引阈值做一次「要不要走窗口」的
 * 本地判断（用它决定要不要挂 `ResizeObserver` 与量行高）。
 */

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
        ? [{ id: "diff", label: texts.tabDiff }, prompt, tools]
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
    }    default: {
      // 工具 / 子工具：官方 = overview + (有参数→payload) + (有结果→result) + schema + timing
      // PTC（`run_code`）那一格不叫「参数」而叫「代码」（官方 `detailTabs()` 按
      // `codeProgram(cell)` 现判），正文也换成源码，见 `bodies.payload`。
      const program = trajectoryCodeProgram(cell);
      const tabs: Tab[] = [summary];
      if (cell.inputDetail !== undefined) {
        tabs.push({ id: "payload", label: program === undefined ? texts.tabPayload : texts.codeSource });
      }
      // **有代码程序时即使没有结果也出「结果」页签**（官方同一处的
      // `record.cell.outputDetail || codeProgram(record.cell) !== undefined`）：
      // PTC 调用的结果就是程序输出，官方给它留一格（跑空了的程序那一格显示「无输出」）。
      if (cell.outputDetail !== undefined || program !== undefined) {
        tabs.push({ id: "result", label: texts.tabResult });
      }
      tabs.push({ id: "schema", label: texts.tabSchema }, { id: "timing", label: texts.tabTiming });
      return tabs;
    }
  }
}

/** 记录种类的配色类名（官方 `kindTag` 的七种）。 */
function kindClass(cell: TrajectoryCell): string {
  return `trajectory-kind is-${cell.kind}${cell.status === "error" ? " is-error" : ""}`;
}

/**
 * 记录种类的字形（官方 `TrajectoryTable.tsx` 的 `KIND_ICON`）。
 *
 * 只有在窄容器下才显形——宽栏由容器的 `overflow: hidden` 把文字那枚顶出去、字形本身
 * 宽 0，与官方同一套机制（不是因为 `display: none`）。形状与取名的由来见
 * `icons.tsx` 里那一族 `IconKind*` 的注释。
 */
const KIND_ICON: Record<TrajectoryCell["kind"], ReactNode> = {
  system: <IconKindSystem size={13} />,
  user: <IconKindUser size={13} />,
  context: <IconKindContext size={13} />,
  compacted: <IconKindCompacted size={13} />,
  message: <IconKindAssistant size={13} />,
  tool: <IconWrench size={13} />,
  subtool: <IconWrench size={13} />,
};

/** 一轮里能不能折叠（官方 `collapsibleTurnIds`：非 system 的记录多于一条）。 */
function turnCollapsible(turn: TrajectoryTurn): boolean {
  if (turn.turn === null) return false;
  return trajectoryTurnCells(turn).filter((cell) => cell.requestOnly !== true && cell.kind !== "system").length > 1;
}

/**
 * 轮次折叠后那行显示的摘要（官方 `request.collapsedSummary` + `summarizeTurn`）。
 *
 * 取词与步骤口径都在 `trajectoryDisplay.ts` 的 `trajectoryTurnSummary()` 里
 * （那一层是「一行显示什么」的唯一出处，也是能被离线断言钉住的地方）。
 */
function turnSummary(turn: TrajectoryTurn, texts: TrajectoryTexts): string {
  return texts.collapsedSummary(texts.collapsedTurn, trajectoryTurnSummary(turn, texts));
}

/**
 * 「调用折叠」摘要**呈现行**上显示的整句（官方 `request.collapsedSummary` +
 * `request.collapsedAssistant`）：`已收起的助手概述，N 个工具调用 · name1, name2`。
 *
 * 取词与名字口径都在 `trajectoryDisplay.ts` 的 `trajectoryAssistantSummary()` 里
 * （那一层是「一行显示什么」的唯一出处，也是能被离线断言钉住的地方）。
 */
function assistantSummary(calls: readonly TrajectoryCell[], texts: TrajectoryTexts): string {
  return texts.collapsedSummary(texts.collapsedAssistant, trajectoryAssistantSummary(calls, texts));
}

/**
 * 一条记录在检查器标题里的**落点**（官方 `TrajectoryTable` 的 `detailsTitle`）：
 * 助手 / 工具等记录是 `第 M 轮 · 第 K 步`，压缩记录只有轮次（它自己那一段已经写了
 * 「压缩」，再拼组标题会重复）。
 *
 * 组标题由折叠层的语义经 `trajectoryGroupTitle()` 取词——它正是官方
 * `selected.group` 那一格。
 */
function recordLocation(cell: TrajectoryCell, turn: TrajectoryTurn, texts: TrajectoryTexts): string {
  const section = turn.turn === null ? texts.betweenTurns : texts.turnLabel(turn.turn + 1);
  if (cell.kind === "compacted") return section;
  const group = turn.groups.find((entry) => entry.cells.some((candidate) => candidate.index === cell.index));
  if (group === undefined) return section;
  return `${section} · ${trajectoryGroupTitle(group.title, texts)}`;
}

/**
 * 时刻那一格：**可切换**本地时间 / Unix 时间戳（官方 `StartedAtValue`）。
 *
 * 为什么要它：轨迹里几乎所有时刻都来自服务端时间戳，而这一格是用户核对「这条记录
 * 与日志里那条对不对得上」的地方——本地时间是给人看的，Unix 时间戳是拿去 grep 日志的。
 *
 * 两个细节逐字对齐官方：
 * 1. **点在有选区上不算点击**（官方 `clickSelectsText`）：这一格是可以拖选复制的，
 *    拖完手指一松正好落在按钮上，不判选区就会把选中时刻换成另一种形态；
 * 2. 两个态的悬停说明互为对方的动作（`title` 是「点了会怎样」，不是「现在是什么」）。
 */
function StartedAtValue({ timestamp, texts }: { timestamp: number | null; texts: TrajectoryTexts }) {
  const [showUnix, setShowUnix] = useState(false);
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return <span className="trajectory-detail-value">{texts.timingNotAvailable}</span>;
  }
  return (
    <button
      type="button"
      className="trajectory-detail-value trajectory-timestamp"
      title={showUnix ? texts.timingShowLocalTime : texts.timingShowUnixTimestamp}
      onClick={(event) => {
        // `getSelection()` 在无 DOM 的渲染测试里是 undefined，所以要有这一层兜底
        if (clickSelectsText(event.currentTarget)) return;
        setShowUnix((current) => !current);
      }}
    >
      {showUnix ? (timestamp / 1000).toFixed(3) : formatStartedAt(timestamp)}
    </button>
  );
}

/**
 * 点击是否落在**已有选区**上（官方 `TrajectoryTable.tsx` 的 `clickSelectsText`）。
 * 没选中任何东西、拿不到选区（无头渲染）都算「不是」——照常执行点击动作。
 */
function clickSelectsText(target: Node): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (selection === null || selection === undefined || selection.isCollapsed) return false;
  if (selection.rangeCount === 0) return false;
  return selection.getRangeAt(0).intersectsNode(target);
}

/** 「Schema」页签解析出来的形状（官方 `ParsedToolSchema`）。 */
interface ParsedToolSchema {
  name: string;
  description: string;
  parameters: object;
}

/**
 * 解析宿主存下的 `schemaDetail`（官方 `parseToolSchema()` 逐字同判据）。
 *
 * 三样缺一不可：`name` / `description` 是字符串、`parameters` 是**非数组**对象。
 * 任一不满足就返回 `undefined`，由调用方退回显示原文——官方在解析失败时也是
 * 把那段 JSON 字符串原样铺出来，而不是报「不可用」。
 */
function parseToolSchema(value: string | undefined): ParsedToolSchema | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const schema = parsed as Record<string, unknown>;
    if (
      typeof schema.name !== "string"
      || typeof schema.description !== "string"
      || typeof schema.parameters !== "object"
      || schema.parameters === null
      || Array.isArray(schema.parameters)
    ) {
      return undefined;
    }
    return { name: schema.name, description: schema.description, parameters: schema.parameters };
  } catch {
    return undefined;
  }
}

/**
 * 一行「标签 + 值」。文本值那条路把值同时写进 `title`（窄栏里长值会被截断）；
 * **节点值**那条路不写 `title`——节点自带交互（`StartedAtValue` 那一格点了切换
 * 显示形态），外面再套一个 `title` 会与它自己的悬停说明打架。
 *
 * 提到模块级是因为**三个面板共用**：记录检查器的概述与计时、请求检查器的计时
 * （官方那三个位置也是同一套 `<dl className={css.overview}>`）。
 */
function detailRowNode(label: string, value: ReactNode) {
  return value ? (
    <div className="trajectory-detail-row" key={label}>
      <span className="trajectory-detail-label">{label}</span>
      {value}
    </div>
  ) : null;
}

function detailRow(label: string, value: string) {
  return value
    ? detailRowNode(
      label,
      <span className="trajectory-detail-value" title={value}>
        {value}
      </span>,
    )
    : null;
}

/**
 * **记录级**计时面板（官方 `RecordTiming` 的两条分支，逐字对齐）。
 *
 * 1. 助手记录且有 `assistantMetrics` → 官方的 `AssistantTimingPanel` 五行：
 *    开始时刻（`stepStartTime`）/ 总时长 / 首 token / 生成 / **吞吐量**。
 *    从前这里第五行画的是「输出 N」（token 数）——官方那一格是吞吐量，token 数在
 *    用量区（概述与用量页签）已经有了。
 * 2. 其余记录（含没有 `metrics` 的助手记录）→ 开始时刻（`cell.startedAt`）+
 *    时长（`cell.timeSeconds`）+ 计时来源（`preview` 时不出：概述里的那一节是缩略）。
 */
function RecordTimingPanel({
  cell,
  preview,
  texts,
}: {
  cell: TrajectoryCell;
  /** 是不是「概述里的缩略那一份」（官方 `preview`：只有它才藏掉「计时来源」那行）。 */
  preview: boolean;
  texts: TrajectoryTexts;
}) {
  const metrics = cell.assistantMetrics;
  if (cell.kind === "message" && metrics !== undefined) {
    return (
      <>
        {detailRowNode(texts.timingStarted, <StartedAtValue timestamp={metrics.stepStartTime} texts={texts} />)}
        {detailRow(texts.timingTotalDuration, trajectoryRecordTotalTime(metrics, texts))}
        {detailRow(texts.timingTtft, trajectoryRecordTtft(metrics, texts))}
        {detailRow(texts.timingGeneration, trajectoryRecordGenerationTime(metrics, texts))}
        {detailRow(texts.timingThroughput, trajectoryRecordThroughput(metrics, texts))}
      </>
    );
  }
  return (
    <>
      {detailRowNode(texts.timingStarted, <StartedAtValue timestamp={cell.startedAt} texts={texts} />)}
      {detailRow(texts.timingDuration, formatElapsedSeconds(cell.timeSeconds, texts))}
      {preview
        ? null
        : detailRow(
          texts.timingSource,
          cell.timeSeconds === null ? texts.timingNotAvailable : texts.timingSessionTimestamps,
        )}
    </>
  );
}

function Inspector({
  cell,
  texts,
  width,
  onWidth,
  onClose,
  hierarchy,
  onOpenCall,
  onOpenRequestTiming,
  location,
}: {
  cell: TrajectoryCell;
  texts: TrajectoryTexts;
  /** 检查器宽度（px）。官方是 `clamp(320px, 38%, 440px)`，可拖动调宽（320–720）。 */
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
  /**
   * 标题里的**落点**（官方检查器标题的 `detailsLocation`）：`第 M 轮 · 第 K 步`。
   * 由视图层算好——组标题只有整份账本那边取得（与 `hierarchy` 同一个理由）。
   */
  location: string;
  /**
   * 「层级」那一行的反向链接（官方 `overviewParentLinks`）。由视图层算好——
   * 只有它同时拿得到整份账本与请求表，检查器自己只知道当前这一格。
   */
  hierarchy: { key: string; label: string; onOpen: () => void }[];
  /**
   * 点开某次工具调用的**记录**（官方 `SourceBlocks` / `AssistantToolCalls` 的
   * `onOpenCall(callId)`）。由视图层按 `callId` 找出那一行并选中——检查器只有当前这一格。
   */
  onOpenCall: (callId: string) => void;
  /**
   * 「请求计时」那一节的入口：跳到该请求的**计时页签**（官方 `selectRequest(target, 'timing')`）。
   *
   * 只在当前这一格是助手记录、且视图层能解析出它的请求对象时才给——官方那条判据是
   * `selected.cell.kind === 'message'` + 请求号能对上（压缩行的请求号不对应它自己那一条
   * 助手记录，所以官方也不给它）。缺席时那一节整节不出。
   */
  onOpenRequestTiming?: () => void;
}) {
  const tabs = useMemo(() => tabsFor(cell, texts), [cell, texts]);
  const [tab, setTab] = useState<TabId>("summary");
  const [history, setHistory] = useState<{ key: string; tab: TabId }>({ key: "", tab: "summary" });
  const resizing = useRef<{ x: number; width: number } | null>(null);
  const scale = useUiScale();
  // 切记录时保留仍然可用的页签（官方 `tabHistory` 同口径），否则回到「概述」
  const key = `${cell.seq}:${cell.index}`;
  if (history.key !== key) {
    const keep = tabs.some((entry) => entry.id === history.tab) ? history.tab : "summary";
    setHistory({ key, tab: keep });
    if (tab !== keep) setTab(keep);
  }

  /**
   * 「Schema」页签吃的是**调用时**记下的那一份（官方 `attachToolSchema()` 挂在调用格上）。
   *
   * 从前是拿 `toolName` 回查「这一行之前最近一次生效的工具目录」——目录在这条调用之后
   * 变更过时会给错的那一份，而界面上看不出来。现在宿主在 `tool/call` 那一刻就把 schema
   * 序列化进 `cell.schemaDetail`，这里只解析。
   */
  const schema = useMemo(() => parseToolSchema(cell.schemaDetail), [cell.schemaDetail]);  /**
   * 这一条记录是不是**录下来的 PTC 程序**（官方 `codeProgram(cell)`，纯决策在 vendor 里）。
   * 有它时：参数那一格改叫「代码」、正文换成源码、结果那一格即使没有结果也出。
   */
  const program = useMemo(() => trajectoryCodeProgram(cell), [cell]);
  // 概述那一摊行与三个计时面板共用同一套「标签 + 值」helper（模块级的 `detailRow*`）
  const rowNode = detailRowNode;
  const row = detailRow;

  const status =
    cell.status === "running" ? texts.statusPending : cell.status === "error" ? texts.statusFailed : texts.statusCompleted;

  /**
   * 各页签的正文**抽在一起**：概述页里的同名分节要显示的就是这一份内容
   * （官方 `overviewSections` 里那几节，点的也是同一个正文组件），
   * 分成两处写迟早会走样。
   */
  const bodies: Record<TabId, React.ReactNode> = {
    summary: null,
    /**
     * 「参数 / 代码」那一格：PTC 调用（`run_code`）显示的是**源码**（官方 `ProgramInput`：
     * 源码正文 + 语言标记 + 复制源码），别的工具仍是原始参数文本。
     *
     * 与官方的一处**形态差异**（刻意的）：官方那个组件另有一颗「原始 JSON」开关，
     * 在源码与 JSON 之间切换，且用的是它们的 `JsonTree`（本扩展明确不做，见
     * `docs/design-trajectory.md` 的差距清单）。这里不做那颗开关：多一颗只在 PTC 行
     * 出现的按钮，收益是一份界面里别处都拿得到的 JSON（「原始内容」页签不吃工具行，
     * 但搜索面与宿主日志里都有原文），代价是多一种从没验证过的形态。
     */
    payload: program !== undefined ? (
      <div className="trajectory-program">
        {program.description === "" ? null : (
          <div className="trajectory-program-description">{program.description}</div>
        )}
        {program.language === undefined ? null : (
          <div className="trajectory-detail-label">{program.language}</div>
        )}
        <TrajectoryPre
          text={program.source}
          copyTitle={texts.codeCopySource}
          wrapTitle={texts.wrapLines}
        />
      </div>
    ) : cell.inputDetail ? (
      <TrajectoryPre text={cell.inputDetail} copyTitle={texts.copyParameters} wrapTitle={texts.wrapLines} />
    ) : (
      <div className="trajectory-empty">{texts.recordNoPayload}</div>
    ),
    result: cell.outputDetail ? (
      <TrajectoryPre text={cell.outputDetail} copyTitle={texts.copyOutput} wrapTitle={texts.wrapLines} />
    ) : program !== undefined ? (
      /*
       * PTC 调用的「结果」那一格：**即使还没有结果也出**（官方 `detailTabs()` 的
       * `outputDetail || codeProgram(cell) !== undefined`），空的程序那一格显示
       * 「无输出」——官方 `ProgramOutput` 在没有 `outputDetail` 时就是这一句
       * （运行中另有一句「执行中…」；本扩展的工具行没有「运行中」这一档，
       * 未结算的调用在账本里不是 `running`，所以不引那句没有落点的文案）。
       */
      <div className="trajectory-empty">{texts.recordNoOutput}</div>
    ) : (
      <div className="trajectory-empty">{texts.recordNoResult}</div>
    ),
    "raw-output": cell.inputDetail ? (
      <TrajectoryPre text={cell.inputDetail} copyTitle={texts.copyOutput} wrapTitle={texts.wrapLines} />
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
    /**
     * 「原始」页签的正文（官方 `markdownSource`）：markdown 类记录里
     * `user` / `context` 取 `inputDetail`、`message` / `compacted` 取 `outputDetail`。
     * 工具目录变更那一行没有 `inputDetail`，官方那一格是现场拼的名字清单——这里按同一张
     * 表拼（`trajectoryToolUpdateParams`），而不是显示一段没法本地化的宿主文案。
     *
     * **有原始块时整块改用逐块排版**（官方 `MarkdownRecordContent` 的第二分支）：
     * 判据与两条排除都在 `trajectoryUsesSourceBlocks()` 里（纯函数，可离线断言）。
     * 工具目录变更那一行按官方第一分支走上面那条文本路，不进逐块。
     */
    raw: (
      <>
        {trajectoryUsesSourceBlocks(cell) ? (
          <SourceBlocks blocks={cell.sourceBlocks ?? []} texts={texts} onOpenCall={onOpenCall} />
        ) : (
          <TrajectoryPre
            copyTitle={texts.copy}
            wrapTitle={texts.wrapLines}
            text={
              cell.toolUpdate !== undefined
                ? trajectoryToolUpdateParams(cell.toolUpdate, texts)
                : cell.kind === "user" || cell.kind === "context"
                  ? (cell.inputDetail ?? "")
                  : (cell.outputDetail ?? "")
            }
          />
        )}
      </>
    ),
    source:
      cell.messageSource?.raw !== undefined ? (
        <>
          {/*
            来源 JSON 的标题（官方 `MessageSource` 把 `source.messageJson` 交给 JsonTree
            当标题）。本扩展没有 JsonTree，用与「请求选项 JSON」同一个标题样式——官方的
            JsonTree 也只是在内容上方排一行标题，两种形态在这一点上等价。
          */}
          <div className="trajectory-detail-label">{texts.sourceMessageJson}</div>
          <TrajectoryPre
            text={JSON.stringify(cell.messageSource.raw, null, 2)}
            copyTitle={texts.copy}
            wrapTitle={texts.wrapLines}
          />
        </>
      ) : (
        <div className="trajectory-empty">{texts.sourceNotRecorded}</div>
      ),
    "system-prompt": cell.systemPromptDetail ? (
      <TrajectoryPre text={cell.systemPromptDetail} copyTitle={texts.copy} wrapTitle={texts.wrapLines} />
    ) : (
      <div className="trajectory-empty">{texts.recordSystemPromptMissing}</div>
    ),
    /**
     * 「对照」页签（只有被替换过的系统提示词那一行才有）：**行级差分**，不是并排两段原文
     * （官方那一支走 `structuredPatch`，见 `trajectoryPromptDiff.ts`）。两节各一个标题：
     * 系统提示词、工具目录——两段完全相同时那一节整节不渲染。
     *
     * 工具目录那一节的对照只在这一行**记下了 before 的工具目录**时才有：
     * `previousPromptDetail` 是官方那个 `{system, tools}` 快照，而本扩展的宿主目前只把
     * **被替换前的 system 文本**放进 `previousSystemPromptDetail`（见
     * `dsh/trajectory.ts` 的 `previousPromptSnapshot()`），所以 `tools` 那一半缺席。
     * 缺席就**不出这一节**——拿改动前的 system 与改动后的 tools 拼一份差分是错的对照。
     */
    diff: (
      <div className="trajectory-prompt-diff-sections">
        <PromptDiffSection
          title={texts.tabSystemPrompt}
          before={cell.previousSystemPromptDetail ?? ""}
          after={cell.systemPromptDetail ?? ""}
        />
        {cell.previousPromptTools !== undefined && cell.toolsDetail !== undefined ? (
          <PromptDiffSection
            title={texts.tabTools}
            before={JSON.stringify(cell.previousPromptTools, null, 2)}
            after={JSON.stringify(cell.toolsDetail, null, 2)}
          />
        ) : null}
      </div>
    ),
    tools: cell.toolsDetail?.length ? (
      cell.toolsDetail.map((tool) => (
        <details key={tool.name} className="trajectory-tool">
          <summary>{tool.name}</summary>
          {tool.description ? <div className="trajectory-tool-desc">{tool.description}</div> : null}
          {tool.parameters === undefined ? null : (
            <TrajectoryPre
              text={JSON.stringify(tool.parameters, null, 2)}
              copyTitle={texts.copy}
              wrapTitle={texts.wrapLines}
            />
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
          <TrajectoryPre
            text={JSON.stringify(schema.parameters, null, 2)}
            copyTitle={texts.copy}
            wrapTitle={texts.wrapLines}
          />
        )}
      </>
    ) : cell.schemaDetail !== undefined ? (
      /*
       * 解析不出来就显示**原文**（官方 `parseToolSchema` 失败后渲染那段 JSON 字符串）：
       * schema 已经在手上、只是形状不是 `{name, description, parameters}`，给人看原文
       * 比一句「Schema 不可用」有用。
       */
      <TrajectoryPre text={cell.schemaDetail} copyTitle={texts.copy} wrapTitle={texts.wrapLines} />
    ) : (
      <div className="trajectory-empty">{texts.recordSchemaUnavailable}</div>
    ),
    /**
     * 「计时」那一格 = 官方 `RecordTiming`（助手记录走 `AssistantTimingPanel` 五行、
     * 其余记录走「开始时刻 / 时长 / 计时来源」三行）。这一份正文与请求面板的计时
     * **是同一个组件**：官方 `RequestTiming` 在该请求有助手记录时整块改用它。
     */
    timing: <RecordTimingPanel cell={cell} preview={false} texts={texts} />,
  };

  /**
   * 概述页里摊开哪几节（官方 `overviewSections` 的同一套分派）：
   * markdown 记录（user / context / message）只有「预览」一节；
   * 工具与子工具是「参数 / 结果 / Schema / 计时」四节（参数与结果没内容就不出）。
   *
   * 分节标题**从上面那份页签表里取**，不另写一份：PTC 那一格的标题在两种状态下不同
   * （「参数」/「代码」，官方 `detailTabs()` 现判），两处各写一份就会得到「页签叫代码、
   * 摊开那节还叫参数」这种自相矛盾。页签缺席时（理论上不会）才回落到文案。
   */
  const sectionLabel = (id: TabId, fallback: string): string =>
    tabs.find((entry) => entry.id === id)?.label ?? fallback;
  const sections: {
    key: string;
    label: string;
    tab?: TabId;
    /**
     * 「点这一节的标题去哪」——**跨面板**的那一节用它（请求计时要开的是请求检查器）。
     *
     * 不把请求检查器的页签塞进 `TabId`：那是两个不同的检查器，混成一套页签 id 之后
     * 本地那一处 `setTab(section.tab)` 迟早会把请求页签塞进记录检查器。
     */
    onOpen?: () => void;
    body: React.ReactNode;
  }[] = [];
  const timingInSection = cell.kind === "tool" || cell.kind === "subtool";
  if (cell.kind === "user" || cell.kind === "context" || cell.kind === "message") {
    sections.push({ key: "preview", label: texts.tabPreview, tab: "preview", body: bodies.preview });
  } else if (timingInSection) {
    if (cell.inputDetail !== undefined) {
      sections.push({
        key: "payload",
        label: sectionLabel("payload", texts.tabPayload),
        tab: "payload",
        body: bodies.payload,
      });
    }
    if (cell.outputDetail !== undefined) {
      sections.push({ key: "result", label: texts.tabResult, tab: "result", body: bodies.result });
    }
    sections.push({ key: "schema", label: texts.tabSchema, tab: "schema", body: bodies.schema });
    sections.push({ key: "timing", label: texts.tabTiming, tab: "timing", body: bodies.timing });
  }
  /**
   * 助手记录概述里的「请求计时」一节（官方 `selectedAssistantRequestTarget !== undefined`
   * 时那一节）：内容是**这一格的**记录级计时缩略，点标题跳到**它那次请求**的计时页签。
   *
   * 为什么要有它：这一格概述里的计时只有「开始时刻 / 总时长」两行，完整五行（首 token /
   * 生成 / 吞吐量）在请求检查器里——没有这一节，那条路只能靠账本行左端那枚请求小标记进，
   * 而这里正是用户看计时的地方。
   *
   * 判据与官方同源（`selected.cell.kind === 'message'` + 请求号能对上）：**只给助手记录**，
   * 压缩行不给——它带的请求号是压缩请求的号，拿它当「这次请求的计时」是对错了对象。
   * 请求对象解析不出来时视图层不给回调，这一节随之不出。
   */
  if (cell.kind === "message" && onOpenRequestTiming !== undefined) {
    sections.push({
      key: "request-timing",
      label: texts.timingRequest,
      onOpen: onOpenRequestTiming,
      body: <RecordTimingPanel cell={cell} preview texts={texts} />,
    });
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
          // 往左拖 = 变宽（把手在检查器左边缘）。280–720 是设计像素；拖出来的宽度是物理
          // 像素，超上限时由 .trajectory-details 的 max-width 再夹一次（容器夹子兜底）。
          onWidth(
            Math.min(
              dp(720, scale),
              Math.max(dp(280, scale), start.width - (event.clientX - start.x)),
            ),
          );
        }}
        onMouseUp={() => {
          resizing.current = null;
        }}
        onMouseLeave={() => {
          resizing.current = null;
        }}
        onDoubleClick={() => onWidth(defaultInspectorWidth(scale))}
      />
      <div className="trajectory-details-head">
        {/*
          标题 = **种类标签 + 落点**（官方 `TrajectoryTable` 的 `detailsTitle`）：种类那一枚
          与账本行同款配色，落点是「第 M 轮 · 第 K 步」（压缩记录只给轮次，它自己的标签
          已经写了「压缩」）。**不重复账本行那个 `#N`**——官方这一格没有它。
        */}
        <span className="trajectory-details-title trajectory-details-title-record">
          <span className={kindClass(cell)}>{kindLabel(cell.kind, texts)}</span>
          <span className="trajectory-details-location">{location}</span>
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
            {row(texts.detailsError, trajectoryCellError(cell, texts) ?? "")}
            {cell.retry
              ? row(
                  texts.detailsRetry,
                  cell.retry.max === undefined
                    ? String(cell.retry.attempt)
                    : texts.requestRetryProgress(cell.retry.attempt, cell.retry.max),
                )
              : null}
            {cell.messageSource ? row(texts.detailsSource, sourceLabel(cell.messageSource, texts)) : null}
            {hierarchy.length > 0 ? (
              <div className="trajectory-detail-row">
                <span className="trajectory-detail-label">{texts.detailsHierarchy}</span>
                {/* 反向链接（官方 `overviewParentLinks`）：助手记录 → 它的请求；
                    工具 / 子工具记录 → 发起它的助手消息 / 它所属的那条工具。 */}
                <span className="trajectory-hierarchy-links">
                  {hierarchy.map((link) => (
                    <button
                      key={link.key}
                      type="button"
                      className="trajectory-hierarchy-link"
                      title={link.label}
                      onClick={link.onOpen}
                    >
                      {link.label}
                    </button>
                  ))}
                </span>
              </div>
            ) : null}
            {/* 工具 / 子工具的「开始时间 + 总时长」在下面的「计时」分节里，
                这里不再重复一遍（官方也是这个分工：概述行只管来源/层级/状态，
                计时进 `tab.timing` 那一节）。 */}
            {timingInSection ? null : rowNode(texts.timingStarted, <StartedAtValue timestamp={cell.startedAt} texts={texts} />)}
            {timingInSection ? null : row(texts.timingTotalDuration, trajectoryRecordTotalTime(cell.assistantMetrics, texts))}
            {cell.usage ? (
              <>
                {/* 「输入」是**三项合计**（官方 `inputTotal()`：input + cacheRead + cacheWrite），
                    下面两行才是缓存那两个分桶。此处曾直接画裸 `usage.input`——那是官方
                    清单里的「其他」桶，同一个词指的却不是同一个量。 */}
                {row(
                  texts.usageInput,
                  String((cell.usage.input ?? 0) + (cell.usage.cacheRead ?? 0) + (cell.usage.cacheWrite ?? 0)),
                )}
                {row(texts.usageCached, String(cell.usage.cacheRead ?? 0))}
                {row(texts.usageCacheCreated, String(cell.usage.cacheWrite ?? 0))}
                {row(texts.usageOutput, String(cell.usage.output ?? 0))}
                {row(texts.usageReasoning, String(cell.usage.think ?? 0))}
              </>
            ) : null}
            {cell.thinkingDetail ? (
              <div className="trajectory-detail-block">
                <div className="trajectory-detail-label">{texts.recordThinking}</div>
                <TrajectoryPre text={cell.thinkingDetail} copyTitle={texts.copy} wrapTitle={texts.wrapLines} />
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
                    {section.onOpen !== undefined ? (
                      /* 跨面板那一节（请求计时）：标题点了开**另一个检查器**的页签 */
                      <button
                        type="button"
                        className="trajectory-overview-title"
                        title={section.label}
                        onClick={section.onOpen}
                      >
                        {section.label}
                        <IconChevronRight size={12} />
                      </button>
                    ) : section.tab === undefined ? (
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
 * **请求级检查器**（官方点行左端那枚请求小标记打开的那一面）。
 *
 * 官方一份数据两个入口：点账本行看单条记录，点请求标记看**整次请求**——页签集合
 * 是固定的四个（概述 / 选项 / 用量 / 计时），内容全部来自请求表（`TrajectoryRequest`），
 * 不碰账本行。官方那四个页签里「选项」只在真有 `requestConfig` 时才给（没有那一帧
 * 时 `REQUEST_TABS` 会在渲染期把它过滤掉），这里照抄。
 *
 * 计时的口径与**记录面板同源**：官方 `RequestTiming` 在「该请求有助手记录」时整块
 * 改用 `RecordTiming`（见 `RecordTimingPanel`），只有拿不到助手记录时才用请求表自己
 * 那三行。**TTFT / 生成 / 吞吐三条不在请求表这一支**——它们只存在于助手记录那一份
 * 数据里，从前这里拿请求表重算一遍是多余的第二份实现。
 */
type RequestTabId = TrajectoryRequestTab;

function requestTotalTime(request: TrajectoryRequest, texts: TrajectoryTexts): string {
  if (request.startedAt === null) return texts.timingNotRecorded;
  if (request.completedAt === null) return texts.statusPending;
  return formatDurationMs(Math.max(0, request.completedAt - request.startedAt), texts);
}

function requestStatusLabel(request: TrajectoryRequest, texts: TrajectoryTexts): string {
  if (request.status === "error") return texts.statusFailed;
  if (request.status === "running") return texts.statusPending;
  return texts.statusCompleted;
}

/**
 * 请求的失败文案：官方 `requestErrorMessage()`——**已有稳定错误码时优先用本地化文案**
 * （`AUTH` →「API 密钥无效」），拿不到码才回落到提供方的原始报错。
 */
function requestErrorMessage(request: TrajectoryRequest, texts: TrajectoryTexts): string | undefined {
  if (request.errorCode === "AUTH") return texts.detailsFailureAuth;
  return request.error;
}

/** 「输入」的**三项合计**（官方 `inputTotal()`：input + cacheRead + cacheWrite）。 */
function usageInputTotal(usage: TrajectoryRequestUsage): number | undefined {
  if (usage.input === undefined && usage.cacheRead === undefined && usage.cacheWrite === undefined) {
    return undefined;
  }
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function RequestUsageRows({ usage, texts }: { usage: TrajectoryRequestUsage | undefined; texts: TrajectoryTexts }) {
  if (usage === undefined) return <div className="trajectory-empty">{texts.usageNotReported}</div>;
  const totalInput = usageInputTotal(usage);
  const otherOutput =
    usage.output !== undefined && usage.reasoning !== undefined ? usage.output - usage.reasoning : undefined;
  const row = (key: string, label: string, value: number | undefined, detail = false) =>
    value === undefined ? null : (
      <div className={detail ? "trajectory-detail-row is-detail" : "trajectory-detail-row"} key={key}>
        <span className="trajectory-detail-label">{label}</span>
        <span className="trajectory-detail-value">{texts.unitTokens(value)}</span>
      </div>
    );
  return (
    <>
      {row("input", texts.usageInput, totalInput)}
      {row("cached", texts.usageCached, usage.cacheRead, true)}
      {row("cacheCreated", texts.usageCacheCreated, usage.cacheWrite, true)}
      {row("other", texts.usageOther, usage.input, true)}
      {row("output", texts.usageOutput, usage.output)}
      {row("reasoning", texts.usageReasoning, usage.reasoning, true)}
      {row("content", texts.usageContent, otherOutput, true)}
    </>
  );
}

/**
 * 请求计时面板（官方 `RequestTiming` 的三条分支，逐字对齐）：
 *
 * 1. **该请求有助手记录 → 整块改用记录级面板**（官方 `assistant !== undefined` 就走
 *    `RecordTiming`）：五行含吞吐量。从前这里不管有没有助手记录都用请求表自己算一遍
 *    ——取值虽然相同，但「怎么算」与记录面板是两份实现，迟早会漂。
 * 2. 没有助手记录但有请求时刻（压缩请求一类）→ 开始时刻 / 时长 / 计时来源三行。
 * 3. 连请求时刻都没有 → 用**落点记录**的时刻兜底，时长那格如实显示「不可用」。
 *
 * 第 2、3 条里的「计时来源」在 `preview` 时不出：官方概述里那一节是缩略
 * （`RequestTiming` 的 `!preview &&` 那道守卫），页签里才给。
 */
function RequestTimingPanel({
  request,
  assistant,
  anchor,
  preview,
  texts,
}: {
  request: TrajectoryRequest;
  /** 该请求落下的助手记录（官方 `selectedRequestAssistant`）；有它就走记录级面板。 */
  assistant: TrajectoryCell | undefined;
  /** 该请求在账本里的第一条记录（官方 `selectedRequestAnchor`，第三条分支兜底用）。 */
  anchor: TrajectoryCell | undefined;
  preview: boolean;
  texts: TrajectoryTexts;
}) {
  if (assistant !== undefined) return <RecordTimingPanel cell={assistant} preview={preview} texts={texts} />;
  if (request.startedAt !== null) {
    return (
      <>
        {/* 官方请求面板同样是 `StartedAtValue`（`RequestTiming` 里那一格），可切显示形态 */}
        {detailRowNode(texts.timingStarted, <StartedAtValue timestamp={request.startedAt} texts={texts} />)}
        {detailRow(texts.timingDuration, requestTotalTime(request, texts))}
        {preview
          ? null
          : detailRow(
            texts.timingSource,
            request.completedAt === null
              ? texts.timingSessionTimestampsRunning
              : texts.timingSessionTimestamps,
          )}
      </>
    );
  }
  return (
    <>
      {detailRowNode(
        texts.timingStarted,
        <StartedAtValue timestamp={anchor?.startedAt ?? null} texts={texts} />,
      )}
      {detailRow(texts.timingDuration, formatElapsedSeconds(null, texts))}
    </>
  );
}

function RequestInspector({
  request,
  assistant,
  anchor,
  callCounts,
  texts,
  width,
  onWidth,
  onClose,
  onOpenRecord,
  initialTab,
}: {
  request: TrajectoryRequest;
  /**
   * 该请求落下的助手记录与第一条记录（官方 `selectedRequestAssistant` /
   * `selectedRequestAnchor`）：计时面板要用它们走「有助手记录 → 记录级面板」那条分支。
   */
  assistant: TrajectoryCell | undefined;
  anchor: TrajectoryCell | undefined;
  /**
   * 该请求账本记录里的工具 / 子工具条数（官方 `selectedRequestToolCalls` 一族）。
   * 由调用方按**当前请求**从账本现算（`trajectoryDisplay.trajectoryRequestCallCounts`），
   * 所以切换请求时不会残留上一个请求的计数。
   */
  callCounts: TrajectoryRequestCallCounts;
  texts: TrajectoryTexts;
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
  /** 跳到「这次请求落在账本里的记录」；宿主这一份账本里找不到请求号时不给。 */
  onOpenRecord?: () => void;
  /**
   * 打开时落在哪个页签（官方 `selectRequest(target, tab)` 的第二个参数）。
   *
   * 默认「概述」；助手记录概述里那节「请求计时」点进来时给 `timing`——否则用户点了
   * 「请求计时」却落在概述上，像是没生效。**只在挂载时采样一次**：之后用户自己切页签
   * 不该被这个初值拉回去。
   */
  initialTab?: RequestTabId;
}) {
  const scale = useUiScale();
  const resizing = useRef<{ x: number; width: number } | null>(null);
  const hasOptions = request.options !== undefined;
  /** 选项在真实日志里只有少数会话有（`request/header` 那一帧）；没有就不给这个页签。 */
  const tabs = useMemo(() => {
    const list: { id: RequestTabId; label: string }[] = [
      { id: "summary", label: texts.tabSummary },
    ];
    if (hasOptions) list.push({ id: "options", label: texts.tabOptions });
    list.push({ id: "usage", label: texts.tabUsage }, { id: "timing", label: texts.tabTiming });
    return list;
  }, [hasOptions, texts]);
  const [tab, setTab] = useState<RequestTabId>(initialTab ?? "summary");
  // 换一个请求时，上一个请求没有的页签（例如「选项」）要退回「概述」；
  // 依赖的是 `hasOptions` 这个标量，不是每次渲染都新建的 `tabs` 数组。
  useEffect(() => {
    if (!hasOptions && tab === "options") setTab("summary");
  }, [hasOptions, tab]);

  const error = requestErrorMessage(request, texts);
  const row = (label: string, value: string | undefined) =>
    value ? (
      <div className="trajectory-detail-row" key={label}>
        <span className="trajectory-detail-label">{label}</span>
        <span className="trajectory-detail-value" title={value}>
          {value}
        </span>
      </div>
    ) : null;
  /**
   * 标题里的落点：压缩请求本身就带「压缩」（`request.labelCompaction` 已经写了），
   * 这里再拼一次会变成「请求 #2 · 压缩 · 压缩 · 第 2 轮」，所以压缩那一支只给轮次。
   */
  const location =
    request.turn === null ? texts.betweenTurns : texts.turnLabel(request.turn + 1);

  return (
    <aside className="trajectory-details" aria-label={texts.detailsEvent} style={{ width: `${width}px`, flex: "0 0 auto" }}>
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
          onWidth(Math.min(dp(720, scale), Math.max(dp(280, scale), start.width - (event.clientX - start.x))));
        }}
        onMouseUp={() => {
          resizing.current = null;
        }}
        onMouseLeave={() => {
          resizing.current = null;
        }}
        onDoubleClick={() => onWidth(defaultInspectorWidth(scale))}
      />
      <div className="trajectory-details-head">
        <span className="trajectory-details-title">
          {request.purpose === "compaction"
            ? texts.requestLabelCompaction(request.number)
            : texts.requestLabel(request.number)}
          {` · ${location}`}
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
            {row(texts.detailsStatus, requestStatusLabel(request, texts))}
            {request.purpose === "compaction" ? row(texts.detailsPurpose, texts.requestCompactionPurpose) : null}
            {row(texts.detailsProvider, request.provider ?? request.options?.provider)}
            {row(texts.detailsModel, request.model ?? request.options?.model)}
            {/* 两行计数（官方 `details.toolCalls` / `details.subtoolCalls`）：工具与子工具
                分开数，「0」也要显示（它是一条事实）；子工具为 0 时**不出那一行**（官方
                同款，免得每格都挂一条 0）。 */}
            {row(texts.detailsToolCalls, String(callCounts.toolCalls))}
            {callCounts.subtoolCalls > 0 ? row(texts.detailsSubtoolCalls, String(callCounts.subtoolCalls)) : null}
            {row(texts.detailsError, error)}
            {request.retry
              ? row(
                  texts.detailsRetry,
                  `${texts.detailsScheduled} ${
                    request.retry.max === undefined
                      ? String(request.retry.attempt)
                      : texts.requestRetryProgress(request.retry.attempt, request.retry.max)
                  }`,
                )
              : null}
            {request.retryDelayMs === undefined
              ? null
              : row(texts.detailsRetryDelay, formatDurationMs(request.retryDelayMs, texts))}
            {/* 反向链接：请求 → 它落点的那条账本记录（官方 `details.result` 那一行）。
                行标签是官方的「结果」，链接文字按请求用途取官方的「助手消息」/「已压缩」；
                **落点不变**（还是 `anchorCellForRequest` 那一条，端口也不动）。 */}
            {onOpenRecord !== undefined ? (
              <div className="trajectory-detail-row">
                <span className="trajectory-detail-label">{texts.detailsResult}</span>
                <span className="trajectory-hierarchy-links">
                  <button
                    type="button"
                    className="trajectory-hierarchy-link"
                    onClick={onOpenRecord}
                  >
                    {request.purpose === "compaction" ? texts.detailsCompacted : texts.detailsAssistantMessage}
                  </button>
                </span>
              </div>
            ) : null}
            <div className="trajectory-overview-sections">
              <section className="trajectory-overview-section">
                <div className="trajectory-overview-heading">
                  <span className="trajectory-overview-title">{texts.tabUsage}</span>
                </div>
                <div className="trajectory-overview-preview">
                  <RequestUsageRows usage={request.usage} texts={texts} />
                </div>
              </section>
              <section className="trajectory-overview-section">
                <div className="trajectory-overview-heading">
                  <span className="trajectory-overview-title">{texts.tabTiming}</span>
                </div>
                <div className="trajectory-overview-preview">
                  {/* 概述里那一份是**缩略**（官方传 `preview`：计时来源那行不出） */}
                  <RequestTimingPanel
                    request={request}
                    assistant={assistant}
                    anchor={anchor}
                    preview
                    texts={texts}
                  />
                </div>
              </section>
            </div>
          </>
        ) : null}
        {tab === "options" ? (
          request.options === undefined ? (
            <div className="trajectory-empty">{texts.optionsNotRecorded}</div>
          ) : (
            <>
              <div className="trajectory-detail-label">{texts.optionsJson}</div>
              <TrajectoryPre
                text={JSON.stringify(request.options, null, 2)}
                copyTitle={texts.copy}
                wrapTitle={texts.wrapLines}
              />
            </>
          )
        ) : null}
        {tab === "usage" ? (
          <div className="trajectory-usage-panel">
            <section className="trajectory-usage-group">
              <h4 className="trajectory-usage-heading">{texts.usageThisRequest}</h4>
              <RequestUsageRows usage={request.usage} texts={texts} />
            </section>
            <section className="trajectory-usage-group">
              <h4 className="trajectory-usage-heading">{texts.usageSessionCumulative}</h4>
              <RequestUsageRows usage={request.cumulativeUsage} texts={texts} />
            </section>
          </div>
        ) : null}
        {tab === "timing" ? (
          <RequestTimingPanel
            request={request}
            assistant={assistant}
            anchor={anchor}
            preview={false}
            texts={texts}
          />
        ) : null}
      </div>
    </aside>
  );
}

/**
 * 轨迹视图本体（整页）：工具栏 + 时间线 + 账本（+ 详情检查器）。
 *
 * **没有标题栏**：视图切换由头部那颗「轨迹 ⇄ 会话」图标负责，这里再放一条
 * 「轨迹」标题 + 关闭按钮就是重复的入口（用户 2026-09-14 报的那条「点了之后标题栏
 * 突然多出一个『加载早期历史』按钮」也是它——标题栏里那个按钮与时间线左端的 `…`
 * 是同一个动作的两份入口，现在只留官方那一个）。
 *
 * 交互状态（选择 / 请求检查器 / 跨视图落点 / 滚动落点 / 视口 / 折叠 / 搜索词）
 * 全部由 `trajectoryInteraction.ts` 的**唯一端口**拥有，行投影（轮次折叠、
 * 调用折叠、搜索优先、轮次标签落点）由 `trajectoryLedgerRows.ts` 拥有。
 * 本组件只做两件事：把数据交给它们、把端口里的状态画出来——不再各自持有一半规则
 * （那是「记录检查器与请求检查器互相复活」「Escape 只清一半」的成因）。
 */
export function TrajectoryView({
  model,
  sessionId,
  locale,
  onLoadEarlier,
  loadingEarlier,
  focusCallId,
  onFocusApplied,
}: {
  model: TrajectoryModel | undefined;
  /** 当前会话 id：变了由端口整份重置（选择 / 选区 / 折叠 / 搜索 / 视口都不跨会话）。 */
  sessionId: string | undefined;
  locale: string | undefined;
  onLoadEarlier: () => void;
  loadingEarlier: boolean;
  /**
   * 从会话侧跳过来时要**选中并滚到**的那次调用（官方 `viewRequest.focus`：
   * `{view:'trajectory', focus: callId}`）。缺席 = 没有待办的跳转。
   */
  focusCallId?: string;
  /** 落点被消费（命中并选中）之后回调：父级据此清掉请求（官方 `onInspectApplied`）。 */
  onFocusApplied?: () => void;
}) {
  const texts = useTexts();
  const uiScale = useUiScale();
  const tt = useMemo(() => trajectoryTexts(locale), [locale]);
  /** 这一页**唯一**的交互端口（含账本 / 绘图区两个容器 ref 与全部动作）。 */
  const port = useTrajectoryInteraction(sessionId);
  const { record, request, requestTab, range, query, collapsedTurns, collapsedCalls, reveal } = port.state;
  /**
   * 时间线模式：官方工具栏「时长」开关（`sequence` ⇄ `duration`），**跨会话持久化**。
   *
   * 不进端口：它是浏览器级的显示偏好（`localStorage`），与「这一页的选择 / 落点」
   * 不是同一类事实；切会话时也不该被重置。
   */
  const [mode, setMode] = useState<TrajectoryTimelineMode>(readDurationPreference);
  /** 检查器宽度（px）。官方那套 clamp(320, 38%, 440) 的初值 + 可拖到 280–720（设计像素）。
      已经拖出来的宽度是用户的选择，字号改了不重算，只在下一次挂载/双击复位时取新倍率。 */
  const [inspectorWidth, setInspectorWidth] = useState(() => defaultInspectorWidth(uiScale));

  const turns = model?.turns ?? NO_TURNS;

  /**
   * 会话侧过来的落点请求进端口（官方 `viewRequest.focus` → `inspectCallId`）。
   *
   * `focusCallId` 从「有」变成「没有」是父级 ack 的结果，这里不该把已经进端口的
   * 请求又清掉——端口的 `pendingCallId` 才是权威，`focusRevision` 让同一个 callId
   * 再来一次也算新动作。
   */
  useEffect(() => {
    if (focusCallId === undefined) return;
    port.inspectCall(focusCallId);
  }, [focusCallId, port]);

  /**
   * 落点解析（官方 `TrajectoryTable` 那段 `inspectCallId` effect）：在账本里找
   * `cell.callId === pendingCallId` 的那条记录，**命中才选中 + 滚动 + ack**。
   *
   * 三条与官方同源的细节：
   * 1. **解不出来就什么都不做**，请求留着（官方「Not-found leaves the request
   *    pending」）——历史还在往后取的时候，「先点了、那一页随后才到」正是它要活下来的
   *    场景；`turns` 进依赖，账本一到就重试。
   * 2. **命中即 ack**（端口里清 `pendingCallId` + 回调父级）：不 ack 的话每次
   *    `turns` 换身份（运行中每 3 秒一次、切会话一次）都会重放，把用户此刻的选中
   *    与滚动拉回旧目标。
   * 3. 传的是**调用 id**，判据是 `trajectoryCallCellIndex()` 的等值匹配（前缀相同
   *    不算）。
   */
  useLayoutEffect(() => {
    const pending = port.state.pendingCallId;
    if (pending === undefined) return;
    const index = trajectoryCallCellIndex(turns, pending);
    if (index === undefined) return;
    if (port.resolveFocus(index)) onFocusApplied?.();
  }, [port.state.pendingCallId, port.state.focusRevision, turns, tt, onFocusApplied, port]);

  const timeline = useMemo(() => deriveTrajectoryTimeline(turns, mode), [turns, mode]);

  /**
   * 选中某条记录时把时间线视口带过去（官方 `selectedIndex` 那段 effect）。
   *
   * 不写依赖数组是刻意的：该不该动视口由端口的 `followPending` 说了算——只有
   * 「刚选中」才欠着这一下，用户自己滚轮缩放 / 右键平移 / 边缘平移之后它就被清掉了，
   * 所以这里每渲染跑一次也不会把用户拉回旧选中（浏览器窗口无关，与窗口下标也无关）。
   */
  useLayoutEffect(() => {
    port.followSelected(timeline.spans);
  });

  /**
   * 搜索索引（vendor 的官方实现）：按**空白分词 AND**、覆盖官方那一整张字段表，
   * 身份用稳定的 `recordId`。索引更新**节流 3 秒**（官方 `SEARCH_INDEX_THROTTLE_MS`）——
   * 流式期间账本每几秒就变一次，不节流会把每条记录的 Markdown 预览反复重解析；
   * 首次立即建索引，之后的变化走节流。
   */
  const [searchIndex] = useState(() => new TrajectorySearchIndex());
  const [searchRevision, setSearchRevision] = useState(0);
  // 搜索索引吃的是官方形状的账本，组标题也一样要**当前语言**的文案（官方那份
  // `group.title` 就是本地化的）——所以按语言重建，切换语言时索引跟着走。
  const searchLayouts = useMemo(
    () => [vendorTurns(turns, (title) => trajectoryGroupTitle(title, tt))] as const,
    [turns, tt],
  );
  const latestSearchLayouts = useRef(searchLayouts);
  latestSearchLayouts.current = searchLayouts;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInitialized = useRef(false);
  useEffect(() => {
    if (!searchInitialized.current) {
      searchInitialized.current = true;
      if (searchIndex.update(searchLayouts)) setSearchRevision((revision) => revision + 1);
      return;
    }
    if (searchTimer.current !== null) return;
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      if (searchIndex.update(latestSearchLayouts.current)) setSearchRevision((revision) => revision + 1);
    }, SEARCH_INDEX_THROTTLE_MS);
  }, [searchIndex, searchLayouts]);
  useEffect(() => () => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
  }, []);

  const matchIds = useMemo(
    () => searchIndex.search(query),
    [searchIndex, searchRevision, query],
  );
  /**
   * 命中记录的**序号集合**（索引按 `recordId` 作答，账本按 `#N` 渲染）。
   * `null` = 没有查询（不是「一条都没命中」）。它同时喂给账本行投影与时间线
   * （未命中的条压暗）——两处**同一份**，不许各算一遍。
   */
  const matchIndexes = useMemo(() => {
    if (matchIds === null) return null;
    const indexes = new Set<number>();
    for (const turn of turns) {
      for (const cell of trajectoryTurnCells(turn)) {
        if (matchIds.has(trajectoryCellRecordId(cell))) indexes.add(cell.index);
      }
    }
    return indexes;
  }, [matchIds, turns]);

  /**
   * 落在时间线选区里的记录（账本行加 `is-in-range`）。
   *
   * 判据与官方 `trajectoryTimelineFocusIndexes` 逐字相同（**含端点**的区间相交）；
   * 归一化是一次单调线性变换，不改变跨度比较的结果。
   */
  const inRange = useMemo(() => {
    if (!range || range.end <= range.start) return undefined;
    const set = new Set<number>();
    for (const span of timeline.spans) {
      if (span.left <= range.end && span.left + span.width >= range.start) set.add(span.cellIndex);
    }
    return set;
  }, [range, timeline]);

  /** 可折叠的轮次与助手行（规则在 `trajectoryLedgerRows.ts`，与官方逐条同源）。 */
  const collapsibleTurns = useMemo(() => trajectoryCollapsibleTurns(turns), [turns]);
  const collapsibleCalls = useMemo(() => trajectoryCollapsibleCalls(turns), [turns]);

  const allTurnsCollapsed = collapsibleTurns.length > 0 && collapsibleTurns.every((id) => collapsedTurns.has(id));
  const allCallsCollapsed = collapsibleCalls.length > 0 && collapsibleCalls.every((id) => collapsedCalls.has(id));

  /**
   * 账本要画哪几行——**先算出一份行表，再交给绘制**（官方 `records` 与渲染分离的
   * 同一形态）。为什么要分成两趟：虚拟化要的是「一共有多少行」，而它只有把整份账本
   * 折完之后才知道。折叠 / 过滤 / 轮次标签的规则都在 `trajectoryLedgerRows.ts` 里，
   * 这里只把行投影成元素。
   */
  const ledgerRows = useMemo(
    () => trajectoryLedgerRows({ turns, collapsedTurns, collapsedCalls, matchIndexes }),
    [turns, collapsedTurns, collapsedCalls, matchIndexes],
  );

  /**
   * 原始块里那枚「打开工具调用概述」按钮（官方 `openCallSummary(callId)` →
   * `openRecordSummary(target)`）。
   *
   * 与官方同一个判据、同一个缺席行为：按 `callId` **等值**找那一条工具记录，
   * **找不到就什么都不做**（不兜底到最近的一行——点过去是别的调用比点不动更坏）。
   *
   * 认到那一行之后官方做了三件事，这里逐条对应：
   * 1. **展开挡住它的折叠**（目标那一轮被折了就展开那一轮；目标是工具 / 子工具时再
   *    往前找回它所属的那条助手行，被「调用折叠」收走了就展开它）；
   * 2. 选中那一行；
   * 3. **滚到它**——它同时把目标行**钉进虚拟化窗口**，所以窗口外的目标也看得见。
   *    少了第 1、3 步，目标行可能既没渲染又不在屏幕上：用户点完像是没反应。
   */
  const openCallRecord = (callId: string) => {
    const index = trajectoryCallCellIndex(turns, callId);
    if (index === undefined) return;
    for (const turn of turns) {
      const cells = trajectoryTurnCells(turn);
      const at = cells.findIndex((cell) => cell.index === index);
      if (at < 0) continue;
      // 目标那一轮被折了就展开它（`null` = 轮次之间那一段，没有可折的轮号）
      if (turn.turn !== null) port.expandTurn(turn.turn);
      // 工具 / 子工具的目标：往前找回发起它的那条助手行，被调用折叠收走了就展开
      for (let back = at - 1; back >= 0; back -= 1) {
        const previous = cells[back];
        if (previous === undefined) break;
        if (previous.kind === "tool" || previous.kind === "subtool") continue;
        if (previous.kind === "message") port.expandCall(trajectoryCellRecordId(previous));
        break;
      }
      break;
    }
    port.openRecord(index);
  };

  const selectedCell =
    record === undefined
      ? undefined
      : turns.flatMap(trajectoryTurnCells).find((cell) => cell.index === record);
  /**
   * 检查器标题里的落点（官方 `selected.turn` + `selected.group`）。
   *
   * 组是在**折叠层**分的，检查器只拿到当前这一格，所以这里按所在轮次找回它那一组
   * ——只有视图层同时看得到整份账本。
   */
  const selectedTurn =
    selectedCell === undefined
      ? undefined
      : turns.find((turn) => trajectoryTurnCells(turn).some((cell) => cell.index === selectedCell.index));
  const selectedLocation =
    selectedCell === undefined || selectedTurn === undefined
      ? ""
      : recordLocation(selectedCell, selectedTurn, tt);

  /**
   * 检查器里「层级」那一行的反向链接（官方 `parentRecords()` + 请求号两处）。
   *
   * 官方吃的是助手格的 `sourceBlocks[].callId`；我们采集的是同一个判据的轻量形态
   * （`cell.callIds`）。**拿不到证据就不给链接**——宁可不显示，也**不挂一条点过去是
   * 别的记录的错误链接。
   */
  const hierarchyFor = (cell: TrajectoryCell): { key: string; label: string; onOpen: () => void }[] => {
    const links: { key: string; label: string; onOpen: () => void }[] = [];
    // 助手记录 → 它属于哪次请求（官方 `selectedAssistantRequestTarget` 那一支）
    if (cell.requestNumber !== undefined && cell.kind !== "tool" && cell.kind !== "subtool") {
      const number = cell.requestNumber;
      links.push({
        key: "request",
        label: tt.requestLabel(number),
        // 走端口：打开请求检查器**同时清掉记录检查器**（两个检查器是同一个
        // aside 位置上的二选一，只设其中一个会让关掉之后旧的又冒出来）
        onOpen: () => port.selectRequest(number),
      });
    }
    if (cell.kind !== "tool" && cell.kind !== "subtool") return links;
    const all = turns.flatMap(trajectoryTurnCells);
    const at = all.findIndex((candidate) => candidate.index === cell.index);
    if (at < 0) return links;
    // 子工具 → 它所属的那条工具（同轮里往前最近的一条）
    if (cell.kind === "subtool") {
      for (let i = at - 1; i >= 0; i -= 1) {
        const candidate = all[i];
        if (candidate === undefined || candidate.turn !== cell.turn) break;
        if (candidate.kind === "tool") {
          links.push({
            key: "tool",
            label: `${tt.detailsToolCall} · ${candidate.toolName ?? ""}`,
            onOpen: () => port.selectRecord(candidate.index),
          });
          break;
        }
      }
    }
    // 工具 / 子工具 → 发起它的那条助手消息（按 callId 认，认不出就不给）
    const callId = cell.callId;
    if (callId !== undefined) {
      let parent: TrajectoryCell | undefined;
      for (let i = at - 1; i >= 0; i -= 1) {
        const candidate = all[i];
        if (candidate === undefined || candidate.turn !== cell.turn) break;
        if (candidate.kind === "message") {
          parent = candidate;
          break;
        }
      }
      if (parent?.callIds?.includes(callId) === true) {
        links.push({
          key: "message",
          label: tt.detailsAssistantMessage,
          onOpen: () => port.selectRecord(parent.index),
        });
      }
    }
    return links;
  };

  /** 请求表按号索引（点标记时 O(1) 取）。宿主给的已经是升序，键也稳。 */
  const requestsByNumber = useMemo(() => {
    const index = new Map<number, TrajectoryRequest>();
    for (const entry of model?.requests ?? []) index.set(entry.number, entry);
    return index;
  }, [model]);
  /** 同一张表的键集（「请求计时」那一节的守卫要它，判据在 `trajectoryDisplay.ts`）。 */
  const requestNumberSet = useMemo(() => new Set(requestsByNumber.keys()), [requestsByNumber]);

  /** 账本的扁平记录（请求 → 记录那几条查询共用的底表；`turns` 不变时身份稳定）。 */
  const requestCellsAll = useMemo(() => turns.flatMap(trajectoryTurnCells), [turns]);

  /**
   * 请求 → 它那批账本记录（官方 `selectedRequestRecordTemplates`，判据在
   * `trajectoryDisplay.trajectoryRequestCells`）。
   *
   * 判据用**请求号**而不是 `request.seq`：账本行都带 `requestNumber`，而 `seq` 是
   * 开帧事件的号、与记录行的号不是同一套坐标。
   */
  const requestCells = (entry: TrajectoryRequest): TrajectoryCell[] =>
    trajectoryRequestCells(requestCellsAll, entry.number);
  /**
   * 该请求的助手记录与落点（官方 `selectedRequestAssistant` / `selectedRequestAnchor`：
   * 助手记录 = 该请求记录里第一条 `message`，落点 = 助手记录、找不到才取第一条记录）。
   * 请求面板的计时按它们分派到记录级面板。
   */
  const assistantForRequest = (entry: TrajectoryRequest): TrajectoryCell | undefined =>
    requestCells(entry).find((cell) => cell.kind === "message");
  const anchorCellForRequest = (entry: TrajectoryRequest): TrajectoryCell | undefined => {
    const records = requestCells(entry);
    return records.find((cell) => cell.kind === "message") ?? records[0];
  };
  /**
   * 请求 → 它在账本里的落点（请求面板的「这次请求的记录」那条链接）。
   * 找不到就不给这条链接。
   */
  const anchorForRequest = (entry: TrajectoryRequest): (() => void) | undefined => {
    const anchor = anchorCellForRequest(entry);
    if (anchor === undefined) return undefined;
    return () => port.openRecord(anchor.index);
  };
  /**
   * 选中的请求在**这一份模型**里还找得到吗（会话切换 / 分页会换掉整份请求表）。
   * 找不到就当作没选——不渲染一个内容空白的检查器。
   */
  const selectedRequestInfo =
    request === undefined ? undefined : requestsByNumber.get(request);
  useEffect(() => {
    if (request !== undefined && selectedRequestInfo === undefined) port.clearSelection();
  }, [request, selectedRequestInfo, port]);

  /**
   * 助手记录概述里「请求计时」那一节的入口（官方 `selectRequest(selectedAssistantRequestTarget, 'timing')`）。
   *
   * 返回 `undefined` 的两种情形，都是「宁可不给这一节」：这一格没有请求号，或者请求表里
   * 找不到那个号。**不兜底到别的请求**——点过去是另一次请求的计时，比不显示更坏。
   * 请求检查器默认开在「概述」页签，所以这里还要把目标页签一起交过去（`requestTab`）。
   */
  const openRequestTimingFor = (cell: TrajectoryCell): (() => void) | undefined => {
    const number = trajectoryAssistantRequestNumber(cell, requestNumberSet);
    if (number === undefined) return undefined;
    return () => port.selectRequest(number, "timing");
  };

  /** 上一行渲染过的请求编号（连续同一个请求只画一条边界小标记）。 */
  let lastRequest: number | undefined;

  /**
   * 画一行账本。
   *
   * 入口只有一处（整本账本 + 搜索命中的过滤视图都由行投影给出），免得三处各写一份。
   */
  const renderRow = (cell: TrajectoryCell, turn: TrajectoryTurn, showTurnLabel: boolean) => {
    const turnId = turn.turn;
    const showRequest = cell.requestNumber !== undefined && cell.requestNumber !== lastRequest;
    lastRequest = cell.requestNumber ?? lastRequest;
    const content = trajectoryCellContent(cell, tt);
    const isMatch = matchIndexes !== null && matchIndexes.has(cell.index);
    /**
     * 请求边界小标记（官方 `requestBoundaryControl`）：**只画在请求的第一行**，
     * 绝对定位在事件列左端、行与行之间——它是请求级检查器的唯一入口，所以必须是
     * 一个真的 `<button>`（键盘可达、有 `aria-pressed`），而不是装饰。
     */
    const requestNumber = showRequest ? cell.requestNumber : undefined;
    const requestInfo = requestNumber === undefined ? undefined : requestsByNumber.get(requestNumber);
    const requestStatus = requestInfo?.status ?? (cell.status === "error" ? "error" : undefined);
    const requestSelected = requestNumber !== undefined && requestNumber === request;
    const requestLabel =
      requestNumber === undefined
        ? undefined
        : cell.kind === "compacted"
          ? tt.requestLabelCompaction(requestNumber)
          : tt.requestLabel(requestNumber);
    /** 轮次标签的文案。紧凑态那枚 `#N` 用的是**轮号原值**（官方 `#{record.turn}`）。 */
    const turnLabelText = turnId === null ? tt.betweenTurns : tt.turnLabel(turnId + 1);
    /**
     * 整行的无障碍名字（官方 `request.rowAria` 一族）：取值在
     * `trajectoryDisplay.ts` 的 `trajectoryRowLabel()`（「一行显示什么」的唯一出处）。
     */
    const rowLabelText = trajectoryRowLabel(cell, tt, requestNumber);
    /**
     * 键盘可达性（官方同一处的 `tabIndex`）：请求锚点行与「工具目录只变了一项」那种
     * 说明行官方都设成 `-1`——它们点开也没有检查器内容。
     */
    const rowFocusable =
      cell.requestOnly !== true &&
      !(
        cell.kind === "context" &&
        cell.sourceBlocks?.every(
          (block) => block.type === "tool-addition" || block.type === "tool-removal",
        ) === true
      );
    return (
      <tr
        key={trajectoryCellRecordId(cell)}
        // 时间线上的点选 / 框选按这个属性找行（落点对齐读的也是它）
        data-cell-index={cell.index}
        className={`trajectory-row${cell.status === "error" ? " is-error" : ""}${
          record === cell.index ? " is-selected" : ""
        }${inRange?.has(cell.index) ? " is-in-range" : ""}${isMatch ? " is-match" : ""}${
          showTurnLabel ? " is-turn-start" : ""
        }`}
        aria-label={rowLabelText}
        aria-selected={record === cell.index}
        // 键盘可达：详情检查器（参数 / 结果 / Schema / 计时）只从这里进
        tabIndex={rowFocusable ? 0 : -1}
        role="button"
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          port.selectRecord(cell.index);
        }}
        onClick={() => port.selectRecord(cell.index)}
        onDoubleClick={() => {
          if (turnId !== null && turnCollapsible(turn)) {
            port.toggleTurn(turnId);
            return;
          }
          const id = trajectoryCellRecordId(cell);
          if (collapsibleCalls.includes(id)) port.toggleCall(id);
        }}
      >
        <td className="trajectory-event">
          {showTurnLabel ? (
            /**
             * 轮次标签（官方 `turnLabel`）：绝对定位在事件格左上角，**不占行高**。
             * 全宽那枚是正经文案（`第 N 轮` / `Turn N`），紧凑那枚只有 `#N`。
             */
            <span className="trajectory-turn-label" aria-label={turnLabelText}>
              {turnId === null ? (
                turnLabelText
              ) : (
                <>
                  <span className="trajectory-turn-label-full" aria-hidden>
                    {turnLabelText}
                  </span>
                  <span className="trajectory-turn-label-compact" aria-hidden>
                    {`#${turnId}`}
                  </span>
                </>
              )}
            </span>
          ) : null}
          <span className="trajectory-event-inner">
            <span className="trajectory-index">{`#${cell.index}`}</span>
            {cell.status === "running" ? <span className="dot dot-running" aria-hidden /> : null}
            <span className={kindClass(cell)} aria-label={kindLabel(cell.kind, tt)}>
              <span className="trajectory-kind-icon">{KIND_ICON[cell.kind]}</span>
              <span className="trajectory-kind-label">{kindLabel(cell.kind, tt)}</span>
            </span>
          </span>
          {requestNumber !== undefined ? (
            <button
              type="button"
              className={`trajectory-request-marker${requestSelected ? " is-active" : ""}`}
              // `data-label` 是纯 CSS 的悬停提示（官方 `::after { content: attr(data-label) }`）
              data-label={requestLabel}
              data-request-status={requestStatus}
              aria-label={requestLabel}
              aria-pressed={requestSelected}
              onClick={(event) => {
                // 别冒泡到行上：那会把选中从「请求」改成「单条记录」
                event.stopPropagation();
                // 这个入口一律回到默认页签（官方 `selectRequest(target)` 不带第二个参数）；
                // 再点一次已选中的标记 = 收起请求检查器
                if (requestSelected) port.clearSelection();
                else port.selectRequest(requestNumber);
              }}
            />
          ) : null}
        </td>
        <td className="trajectory-content">
          {showRequest ? (
            <span className="trajectory-request">
              {cell.kind === "compacted" ? tt.requestLabelCompaction(cell.requestNumber as number) : tt.requestLabel(cell.requestNumber as number)}
            </span>
          ) : null}
          <span
            className={content.toolCallOnly ? "trajectory-text is-tool-call-only" : "trajectory-text"}
            title={[content.text, content.result].filter(Boolean).join(" → ")}
          >
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
      </tr>
    );
  };

  /**
   * 账本的一行（绘制计划的输入）：React key、它对应的**记录下标**（折叠摘要行是 `-1`）、
   * 以及要画的元素。
   */
  interface LedgerRow {
    key: string;
    cellIndex: number;
    node: ReactNode;
  }

  const allRows: LedgerRow[] = ledgerRows.map((row) => ({
    key: row.key,
    cellIndex: row.cellIndex,
    node:
      row.summary === "turn"
        ? renderTurnSummary(turns[row.section], row.turn, tt)
        : row.summary === "assistant"
          ? renderAssistantSummary(row.record as TrajectoryCell, row.collapsedCalls ?? [], tt)
          : renderRow(row.record as TrajectoryCell, turns[row.section], row.turnStart),
  }));

  /**
   * 一轮收起时那一枚摘要行（官方 `request.collapsedSummary`）。
   *
   * 抽成函数是为了让「行投影」那一趟只做选择、不建元素（虚拟化要先把行数定下来）。
   */
  function renderTurnSummary(turn: TrajectoryTurn | undefined, turnId: number | null, texts: TrajectoryTexts): ReactNode {
    if (turn === undefined || turnId === null) return null;
    return (
      <tr
        key={`turn-${turnId}-summary`}
        className="trajectory-row is-collapsed-summary"
        // 与助手摘要行同款：种别属性让「主选择判据」一眼把布局行与 primary 记录行分开
        // （官方 `data-collapsed-summary={record.collapsedSummaryKind}`）
        data-collapsed-summary="turn"
        // 摘要行整行的名字与官方同一句（`request.collapsedSummary`）
        aria-label={turnSummary(turn, texts)}
        // **必须键盘可达**：点它 = 展开这一轮，而这已经是鼠标唯一的展开动作
        tabIndex={0}
        onClick={() => port.expandTurn(turnId)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          port.expandTurn(turnId);
        }}
      >
        <td className="trajectory-event">
          <span className="trajectory-turn-label" aria-label={tt.turnLabel(turnId + 1)}>
            <span className="trajectory-turn-label-full" aria-hidden>
              {tt.turnLabel(turnId + 1)}
            </span>
            <span className="trajectory-turn-label-compact" aria-hidden>
              {`#${turnId}`}
            </span>
          </span>
        </td>
        <td className="trajectory-content">{turnSummary(turn, texts)}</td>
      </tr>
    );
  }

  /**
   * 「调用折叠」收起后那枚**摘要呈现行**（官方 `collapseAssistantRecords` 追加的
   * `{...record, collapsedSummary, collapsedSummaryKind:'assistant'}`）。
   *
   * 三条与官方逐条对齐、且主代理点名的判据：
   * 1. **布局行，不是又一条记录**：不带 `data-cell-index`（否则与它共享的那条助手行
   *    同号，撞坏虚拟窗口的「严格递增」不变量与按 index 的定位），用
   *    `data-collapsed-summary="assistant"` 与主选择判据区分开；
   * 2. **共享原记录身份**：`recordId` 取自同一条助手记录（选中 / 请求跳转 / 折叠键
   *    指回的都是它），`aria-label` 是那整句摘要（官方同一句）；
   * 3. **键盘可达**：点它 / 回车 = 展开这串调用（官方 `onToggleAssistant(recordId)`），
   *    与轮次摘要行的「点它 = 展开」同一套口径；原助手行仍是 primary 记录、照样可选中。
   */
  function renderAssistantSummary(
    cell: TrajectoryCell,
    calls: readonly TrajectoryCell[],
    texts: TrajectoryTexts,
  ): ReactNode {
    const recordId = trajectoryCellRecordId(cell);
    const sentence = assistantSummary(calls, texts);
    return (
      <tr
        key={`summary-assistant:${cell.index}`}
        className="trajectory-row is-collapsed-summary"
        data-collapsed-summary="assistant"
        aria-label={sentence}
        tabIndex={0}
        onClick={() => port.expandCall(recordId)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          port.expandCall(recordId);
        }}
      >
        <td className="trajectory-event">
          {/* 事件格只放种类徽章：这一行没有自己的记录序号（`#N` 属于原助手行那一条） */}
          <span className="trajectory-event-inner">
            <span className={kindClass(cell)} aria-label={kindLabel(cell.kind, texts)}>
              <span className="trajectory-kind-icon">{KIND_ICON[cell.kind]}</span>
              <span className="trajectory-kind-label">{kindLabel(cell.kind, texts)}</span>
            </span>
          </span>
        </td>
        <td className="trajectory-content">
          <span className="trajectory-text" title={sentence}>{`… ${sentence}`}</span>
        </td>
      </tr>
    );
  }

  /**
   * 虚拟化（官方 `TrajectoryTable` 的同一套触发条件）：`records.length > 100`，或者
   * 上面还有更早的历史（那时滚动位置本来就不稳，索性一起走窗口）。
   *
   * 算术本身在 `trajectoryVirtual.ts`（纯函数，逐种窗口形态都有断言）；绘制计划把
   * 「窗口那一段 + 必须强留的行」按**位次**排好、用分段垫行补齐空隙，所以 DOM 里的
   * `data-cell-index` 严格递增、`scrollHeight` 与账本行数恒等。
   */
  const virtualized = (model?.hasOlder ?? false) || allRows.length > VIRTUALIZATION_THRESHOLD;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  /**
   * 行高的估计值（**设计像素**，初值就是官方那个 30）。
   *
   * 账本的行高是内容决定的（长正文会折行、折叠摘要行另有高度），所以拿不到一个真常数。
   * 估计值只影响「窗口取哪一段」与垫行高度；随后按实测的平均行高自校正。
   */
  const [rowEstimate, setRowEstimate] = useState(VIRTUAL_ROW_HEIGHT);
  const rowHeightPx = dp(rowEstimate, uiScale);
  /**
   * 键盘 / 时间线要落到的行**必须留在绘制计划里**：窗口是按滚动位置算的，而跳转目标
   * 常常在视口之外（先滚过去，它才进得了窗口——鸡生蛋）。所以这两个目标行强制参与渲染。
   *
   * **这里存的是「记录下标」（`cell.index`，1 起），不是数组位置**——两者在折叠摘要行
   * 插进来之后就差了位，转换由 `trajectoryRowPositions()` 做。
   *
   * `reveal` 消费之后**仍然留着**：它是「最近一次的落点」，留着才能让那一行继续留在
   * 绘制计划里——否则消费的那一刻目标行从 DOM 里消失，视口上方的布局突然少一行，
   * 用户会看到内容一跳。分段垫行保证它排在真实位次上，留着不花任何额外代价。
   */
  const pinnedIndexes = useMemo(
    () => [reveal?.index, record].filter((value): value is number => value !== undefined),
    [reveal?.index, record],
  );
  const pinnedPositions = trajectoryRowPositions(allRows, pinnedIndexes);
  const plan = trajectoryWindowPlan({
    rowCount: allRows.length,
    hasOlder: model?.hasOlder ?? false,
    scrollTop,
    viewportHeight,
    rowHeight: rowHeightPx,
    pinned: pinnedPositions,
  });
  /**
   * 量一下滚动位置与视口高（窗口按这两个值算）。
   *
   * `ResizeObserver` 而不是监听 `resize`：账本的高度随检查器开关 / 侧栏显隐变化，
   * 那些都不是窗口尺寸事件。`scroll` 用 React 的 `onScroll`（它是被动监听的）。
   */
  useLayoutEffect(() => {
    const ledger = port.ledger.current;
    if (!ledger) return;
    const measure = () => setViewportHeight(ledger.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(ledger);
    return () => observer.disconnect();
    // 账本容器在「没有记录」时整块不渲染，所以它出现 / 消失都要重挂观察
  }, [port, turns.length === 0]);

  /**
   * 按**实测**的行高校正估计值（窗口宽度与垫行高度都按它算）。
   *
   * 只量**行本体**、跳过垫行（它们是空的高度占位，量进去会把估计越拉越偏）。
   * 用「累计平均」而不是「最近一次的平均」：慢速滚动时每帧只差一行，累计平均几步就
   * 收敛到位且不会因为某一行特别高而抖一下。
   */
  useLayoutEffect(() => {
    if (!virtualized) return;
    const ledger = port.ledger.current;
    if (!ledger) return;
    const bodies = ledger.querySelectorAll<HTMLElement>("tr.trajectory-row:not(.trajectory-virtual-pad)");
    if (bodies.length === 0) return;
    let sum = 0;
    for (const row of bodies) sum += row.getBoundingClientRect().height;
    setRowEstimate((previous) => {
      const next = (previous * 3 + sum / bodies.length / uiScale) / 4;
      // 差不到 1 设计像素就不重渲染（否则每帧一次 setState，白转）
      return Math.abs(next - previous) < 1 ? previous : next;
    });
    // 依赖刻意只放 `virtualized`：这个 effect 每次渲染都跑，但上面那道阈值把
    // 「量了但没变」挡在 setState 之前。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized]);

  /**
   * 落点对齐（端口里 `reveal` 的消费者）。
   *
   * 依赖里**只有 nonce**：同一个目标反复点也要重新滚一次；而窗口下标 / 行高 / 折叠
   * 变化都**不重跑**——重跑会把用户手滚到的位置拉回旧目标（实测：定位后手滚 2000，
   * 被旧 reveal 拉到 6086）。目标行由分段垫行保在 DOM 里，所以不需要「重试到进窗口」。
   * 一次性由端口保证（同一个 nonce 的成功对齐只算一次）。
   *
   * 端口写下的 `scrollTop` 还要**立刻交回 React**：窗口是按 `scrollTop` 算的，新的滚动
   * 位置会让绘制计划重排（垫行按估计行高画，实测行高与它不同），重排之后目标行的实测
   * 位置还会偏（实测：首次裁半行，13.5/26px 可见）。交回去触发同步重渲染之后，下面那个
   * 收尾 effect 在 **paint 之前**把残余量补掉——不是 rAF 轮询，也不重放旧 `reveal`。
   */
  useLayoutEffect(() => {
    const target = reveal;
    if (target === null) return;
    if (!port.applyReveal(target.index, target.nonce)) return;
    const applied = port.ledger.current?.scrollTop;
    if (applied !== undefined) setScrollTop(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, port]);

  /**
   * 落点收尾：窗口按新的 `scrollTop` 重排之后，目标行的实测位置还会与写下时不同
   * （垫行按估计行高、真实行按内容高），所以再补一次实测余量。只有端口里还留着
   * 「刚写下的那一次落点」的票据时才动：票据在对齐完成 / 用户手滚 / 切会话 / 卸载时
   * 作废——于是既不回拉用户手滚，也不会反复回拉（不依赖每一次渲染、没有 rAF 轮询）。
   * 收尾自己改了 `scrollTop` 就再交回 React 一次；端口里有步数上限，收敛即停。
   *
   * 交给端口的是**这一帧绘制计划用的滚动位置**（本渲染的 `scrollTop`，上面那个 `plan`
   * 就是按它算的）：重排的标志是计划追上容器实际停下的位置。没追上时端口一个字都不改、
   * 票据也留着——重排前量到的「已经贴边」属于马上要被换掉的布局，拿它收票据的话，
   * 窗口重排之后目标行又偏了（真实 DOM 首次落点裁半行正是这样发生的）。
   */
  useLayoutEffect(() => {
    const target = reveal;
    const container = port.ledger.current;
    if (target === null || container === null) return;
    if (!port.settleReveal(target.index, target.nonce, scrollTop)) return;
    setScrollTop(container.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, port]);

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
              const next: TrajectoryTimelineMode = mode === "sequence" ? "duration" : "sequence";
              setMode(next);
              writeDurationPreference(next);
              // 换模式会换掉整套域坐标，旧选区在新坐标里没有意义（官方同款）
              port.setRange(null);
            }}
          >
            {tt.toolbarDuration}
          </button>
          <button
            className="btn btn-ghost"
            title={allTurnsCollapsed ? tt.toolbarExpandTurns : tt.toolbarCollapseTurns}
            aria-pressed={allTurnsCollapsed}
            disabled={collapsibleTurns.length === 0}
            onClick={() => port.toggleAllTurns(collapsibleTurns)}
          >
            {tt.toolbarTurns}
          </button>
          <button
            className="btn btn-ghost"
            title={allCallsCollapsed ? tt.toolbarExpandCalls : tt.toolbarCollapseCalls}
            aria-pressed={allCallsCollapsed}
            disabled={collapsibleCalls.length === 0}
            onClick={() => port.toggleAllCalls(collapsibleCalls)}
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
            onChange={(event) => port.setQuery(event.target.value)}
          />
        </span>
      </div>

      {/*
        时间线**无条件渲染**（官方 `TrajectoryView` 里它就是 `<TrajectoryTimeline>`，
        不看有没有记录）：一条记录都没有时那是一条空态概览条——三条泳道与
        「没有计时数据」那句提示还在，左端的「加载更早」也照旧按历史决定出不出。
      */}
      {model !== undefined ? (
        <TrajectoryTimeline
          port={port}
          timeline={timeline}
          mode={mode}
          matchIndexes={matchIndexes}
          hasOlder={model.hasOlder}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={onLoadEarlier}
          texts={tt}
        />
      ) : null}

      <div className="trajectory-body">
        {/*
          账本滚动容器。`onScroll` 只记一个数（窗口按它算），**不做节流**：一次滚动里
          真正贵的是下面那一堆行的重建，而它本来就跟着窗口切片走——节流反而会让
          「滚到哪儿了」与「画的是哪一段」错开一帧，出现一片空白。
        */}
        <div
          className="trajectory-ledger"
          ref={port.ledger}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
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
                {/* 「加载更早的历史」：官方把这一行放在账本**最上面**，与时间线左端
                    那个 `…` 是同一个动作——两者都走会话页那条取历史的链路。 */}
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
                {/* 绘制计划：行按位次升序，被切掉的那几段各垫一行（高度 = 行数 × 行高）。
                    垫行是空的高度占位，不带任何交互，也不带 `data-cell-index`。 */}
                {plan.items.map((item, position) =>
                  item.kind === "pad" ? (
                    <tr key={`pad-${position}`} className="trajectory-virtual-pad" aria-hidden>
                      <td colSpan={2} style={{ height: item.rows * rowHeightPx }} />
                    </tr>
                  ) : (
                    <Fragment key={allRows[item.index]?.key ?? `row-${item.index}`}>
                      {allRows[item.index]?.node}
                    </Fragment>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>
        {selectedCell && selectedRequestInfo === undefined ? (
          <Inspector
            cell={selectedCell}
            texts={tt}
            location={selectedLocation}
            width={inspectorWidth}
            onWidth={setInspectorWidth}
            onClose={() => port.clearSelection()}
            hierarchy={hierarchyFor(selectedCell)}
            onOpenCall={openCallRecord}
            onOpenRequestTiming={openRequestTimingFor(selectedCell)}
          />
        ) : null}
        {selectedRequestInfo !== undefined ? (
          <RequestInspector
            // 换一个请求就重挂：页签态（含 `initialTab` 与 `hasOptions` 的回落）在组件内，
            // 不重挂的话「请求计时」跳过来时那个初值不会重新采样
            key={selectedRequestInfo.number}
            request={selectedRequestInfo}
            assistant={assistantForRequest(selectedRequestInfo)}
            anchor={anchorCellForRequest(selectedRequestInfo)}
            callCounts={trajectoryRequestCallCounts(requestCellsAll, selectedRequestInfo.number)}
            texts={tt}
            width={inspectorWidth}
            onWidth={setInspectorWidth}
            onClose={() => port.clearSelection()}
            onOpenRecord={anchorForRequest(selectedRequestInfo)}
            initialTab={requestTab}
          />
        ) : null}
      </div>
    </div>
  );
}
