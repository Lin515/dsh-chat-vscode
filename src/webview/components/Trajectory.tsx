/**
 * 「轨迹」视图：**官方账本的对齐实现**（第一步：工具栏 + 账本 + 详情检查器；
 * 时间线留给第二步）。
 *
 * 结构逐条对照 `dsh-client-ui-trajectory` 的客户端实现：
 * - **工具栏**（官方的 `TrajectoryToolbar`）：轮次折叠 / 调用折叠 / 搜索；
 * - **账本**（官方 2 列：event + content）：每行 = 记录种类标签 + `#N` + 摘要，
 *   工具行把「请求 → 结果」摊成两列；
 * - **详情检查器**（官方的 `details` 面板）：页签集合按记录种类派生，与官方
 *   `detailTabs()` 同一套分支。
 *
 * 与官方**刻意的差异**（见 `docs/design-trajectory.md` 与 `dsh/trajectory.ts` 的
 * 文件头）：时间是第二步、流式中的助手正文不出行、系统提示词按 `request/header`
 * 变化合并、折叠行用官方的 `request.collapsedSummary` 文案。
 */
import { useMemo, useState } from "react";
import type { TrajectoryCell, TrajectoryModel, TrajectoryTurn } from "../../shared/trajectory";
import { IconSearch } from "../icons";
import { Markdown } from "./Markdown";
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

/** 详情检查器的页签（官方 `detailTabs()` 的等价分支）。 */
type TabId = "summary" | "payload" | "result" | "schema" | "timing" | "preview" | "raw" | "source" | "system-prompt" | "tools" | "diff" | "raw-output";

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
  onClose,
}: {
  cell: TrajectoryCell;
  /** 该行之前最近一次生效的工具目录（Schema 页签要按调用时的目录查）。 */
  previousTools: TrajectoryCell["toolsDetail"];
  texts: TrajectoryTexts;
  onClose: () => void;
}) {
  const tabs = useMemo(() => tabsFor(cell, texts), [cell, texts]);
  const [tab, setTab] = useState<TabId>("summary");
  const [history, setHistory] = useState<{ key: string; tab: TabId }>({ key: "", tab: "summary" });
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

  return (
    <aside className="trajectory-details" aria-label={texts.detailsEvent}>
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
            {row(texts.timingStarted, formatRecordedTime(cell.startedAt))}
            {row(texts.timingTotalDuration, formatElapsedSeconds(cell.timeSeconds, texts))}
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
          </>
        ) : null}

        {tab === "payload" ? (
          cell.inputDetail ? (
            <pre className="trajectory-pre">{cell.inputDetail}</pre>
          ) : (
            <div className="trajectory-empty">{texts.recordNoPayload}</div>
          )
        ) : null}

        {tab === "result" ? (
          cell.outputDetail ? (
            <pre className="trajectory-pre">{cell.outputDetail}</pre>
          ) : (
            <div className="trajectory-empty">{texts.recordNoResult}</div>
          )
        ) : null}

        {tab === "raw-output" ? (
          cell.inputDetail ? (
            <pre className="trajectory-pre">{cell.inputDetail}</pre>
          ) : (
            <div className="trajectory-empty">{texts.recordNoOutput}</div>
          )
        ) : null}

        {tab === "preview" ? (
          cell.previewMarkdown ? (
            <div className="trajectory-markdown">
              <Markdown text={cell.previewMarkdown} />
            </div>
          ) : (
            <div className="trajectory-empty">{texts.recordNoContent}</div>
          )
        ) : null}

        {tab === "raw" ? <pre className="trajectory-pre">{cell.previewMarkdown ?? cell.outputDetail ?? ""}</pre> : null}

        {tab === "source" ? (
          cell.messageSource?.raw !== undefined ? (
            <pre className="trajectory-pre">{JSON.stringify(cell.messageSource.raw, null, 2)}</pre>
          ) : (
            <div className="trajectory-empty">{texts.sourceNotRecorded}</div>
          )
        ) : null}

        {tab === "system-prompt" ? (
          cell.systemPromptDetail ? (
            <pre className="trajectory-pre">{cell.systemPromptDetail}</pre>
          ) : (
            <div className="trajectory-empty">{texts.recordSystemPromptMissing}</div>
          )
        ) : null}

        {tab === "diff" ? (
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
        ) : null}

        {tab === "tools" ? (
          cell.toolsDetail?.length ? (
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
          )
        ) : null}

        {tab === "schema" ? (
          schema ? (
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
          )
        ) : null}

        {tab === "timing" ? (
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
        ) : null}
      </div>
    </aside>
  );
}

export function TrajectoryPanel({
  model,
  locale,
  onClose,
  onLoadEarlier,
  loadingEarlier,
}: {
  model: TrajectoryModel | undefined;
  locale: string | undefined;
  onClose: () => void;
  onLoadEarlier: () => void;
  loadingEarlier: boolean;
}) {
  const texts = useTexts();
  const tt = useMemo(() => trajectoryTexts(locale), [locale]);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<number>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ index: number } | undefined>(undefined);

  const turns = model?.turns ?? [];
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
          }${needle && !isMatch ? " is-dimmed" : ""}${isMatch ? " is-match" : ""}`}
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
    <div className="drawer trajectory-drawer" role="dialog" aria-label={tt.title}>
      <div className="drawer-head">
        <span className="drawer-title">{tt.title}</span>
        <span className="spacer" />
        {model?.hasOlder ? (
          <button className="btn btn-ghost" disabled={loadingEarlier} onClick={onLoadEarlier}>
            {loadingEarlier ? tt.loadingEarlier : tt.loadEarlier}
          </button>
        ) : null}
        <button className="icon-btn" title={texts.close} onClick={onClose}>
          ×
        </button>
      </div>

      <div className="trajectory-toolbar" role="toolbar" aria-label={tt.toolbarAria}>
        <div className="trajectory-toolbar-actions">
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
              <tbody>{rows}</tbody>
            </table>
          )}
        </div>
        {selectedCell ? (
          <Inspector cell={selectedCell} previousTools={selectedTools} texts={tt} onClose={() => setSelected(undefined)} />
        ) : null}
      </div>
    </div>
  );
}
