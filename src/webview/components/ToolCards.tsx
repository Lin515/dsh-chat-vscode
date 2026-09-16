/**
 * 工具卡：官方 `ToolRow` 的 card 槽位在本扩展的落地。
 *
 * 官方对一类工具**不用通用 IN/OUT 两段**，而是按工具语义画一张卡（`ReadBlock` /
 * `SearchBlock` / `TerminalBlock` / `WebBlock` / `CodeBlock`）。用户 2026-09-16
 * 报的「工具不需要显示 agent 的完整具体输入内容，重在可读性与输出」就是这条：
 * 读取给行号 + 内容、搜索给文件 + 命中行、终端给命令 + 输出 + 退出码、网页给
 * 答案 + 来源；**有卡片时参数 JSON 不再出现在展开区**。
 *
 * 数据形状与判据在 `src/shared/toolCard.ts`（宿主侧折好，见那里的文件头逐条对照）。
 * 这里只负责画，并保持官方的三条交互口径：
 * 1. 卡片横幅：左标签（读：路径；搜索：计数摘要）、右侧「语言 / 计数 / 复制」；
 * 2. 正文超长时**只显示头尾两半**（官方 `K6`：头 `ceil(max/2)`、尾 `max - 头`），
 *    中间一枚展开钮（「… 其余 N 行」），点开铺满；
 * 3. 终端卡在会话行里**不截断**（官方 `maxLines: Infinity`），没输出时给「无输出」。
 */
import { useState } from "react";
import type { ToolCardView } from "../../shared/chat";
import { post } from "../bridge";
import { useTexts } from "../texts";
import { IconChevronDown, IconChevronRight, IconCopy } from "../icons";
import { Markdown } from "./Markdown";

/** 卡片正文在会话流里最多显示多少行（官方 `CHAT_READ_MAX_LINES` / `CHAT_SEARCH_MAX_LINES`）。 */
const CHAT_CARD_MAX_LINES = 8;

/** 复制按钮的短暂反馈时长（官方 1s）。 */
const COPIED_MS = 1000;

/**
 * 官方 `K6`：把 N 行切成「头 + 尾」两半，中间那 `hidden` 行由展开钮回收。
 * `expanded` 时不截断。头部取 `ceil(max/2)`，尾部取剩下的——两头都露一点，
 * 用户既看到开头也看到结尾。
 */
function capRows<T>(rows: readonly T[], expanded: boolean): { head: T[]; tail: T[]; hidden: number } {
  const hidden = rows.length - CHAT_CARD_MAX_LINES;
  if (hidden <= 0 || expanded) return { head: [...rows], tail: [], hidden: 0 };
  const headCount = Math.ceil(CHAT_CARD_MAX_LINES / 2);
  return {
    head: rows.slice(0, headCount),
    tail: rows.slice(rows.length - (CHAT_CARD_MAX_LINES - headCount)),
    hidden,
  };
}

/** 复制按钮：点了把正文交给宿主写剪贴板（`post({type:"copy"})`，与代码块同一入口）。 */
function CopyButton({ text }: { text: string }) {
  const texts = useTexts();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tool-card-copy"
      title={texts.copy}
      onClick={() => {
        if (copied) return;
        post({ type: "copy", text });
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      }}
    >
      <IconCopy size={12} />
      <span>{copied ? texts.copied : texts.copy}</span>
    </button>
  );
}

/** 中间那枚展开钮（官方 `ExpandRow`）：`aria-expanded` + 「… 其余 N 行」/「收起」。 */
function CardExpander({
  expanded,
  expandLabel,
  collapseLabel,
  expandAria,
  collapseAria,
  onToggle,
}: {
  expanded: boolean;
  expandLabel: string;
  collapseLabel: string;
  expandAria: string;
  collapseAria: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="tool-card-expand"
      aria-expanded={expanded}
      aria-label={expanded ? collapseAria : expandAria}
      onClick={onToggle}
    >
      {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
      <span>{expanded ? collapseLabel : expandLabel}</span>
    </button>
  );
}

/** 读取卡（官方 `ReadBlock`）：行号槽 + 内容，只读一段时横幅给「显示 X / Y 行」。 */
function ReadCard({ card }: { card: Extract<ToolCardView, { kind: "read" }> }) {
  const texts = useTexts();
  const [expanded, setExpanded] = useState(false);
  const { head, tail, hidden } = capRows(card.lines, expanded);
  const partial = card.lines.length < card.totalLines;
  const copyText = card.lines.map((line) => line.text).join("\n");
  const line = (entry: { number: number; text: string }) => (
    <div className="tool-card-line" key={entry.number}>
      <span className="tool-card-gutter" aria-hidden>
        {entry.number}
      </span>
      <span className="tool-card-text">{entry.text}</span>
    </div>
  );
  return (
    <div className="tool-card is-read">
      <div className="tool-card-banner">
        <span className="tool-card-label" title={card.label}>
          {card.label}
        </span>
        <span className="tool-card-actions">
          {partial ? <span className="tool-card-count">{texts.readWindow(card.lines.length, card.totalLines)}</span> : null}
          {card.lang ? <span className="tool-card-lang">{card.lang}</span> : null}
          {card.lines.length > 0 ? <CopyButton text={copyText} /> : null}
        </span>
      </div>
      <div className="tool-card-body mono">
        {head.map(line)}
        {hidden > 0 ? (
          <CardExpander
            expanded={expanded}
            expandLabel={texts.readExpandRest(hidden)}
            collapseLabel={texts.toolCollapse}
            expandAria={texts.readExpandAria(hidden)}
            collapseAria={texts.readCollapseAria}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        {tail.map(line)}
      </div>
    </div>
  );
}

/** 搜索卡（官方 `SearchBlock`）：命中按文件分组（可折叠），或纯路径列表。 */
function SearchCard({ card }: { card: Extract<ToolCardView, { kind: "search" }> }) {
  const texts = useTexts();
  const [expanded, setExpanded] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());

  type Row =
    | { kind: "path"; path: string }
    | { kind: "file"; path: string; count: number }
    | { kind: "match"; lineNumber: number; line: string; file: string };

  const rows: Row[] = [];
  let matchCount = 0;
  if (card.shape === "paths") {
    for (const path of card.paths) rows.push({ kind: "path", path });
  } else {
    for (const file of card.files) {
      rows.push({ kind: "file", path: file.path, count: file.matches.length });
      if (collapsedFiles.has(file.path)) continue;
      for (const match of file.matches) {
        rows.push({ kind: "match", lineNumber: match.lineNumber, line: match.line, file: file.path });
      }
    }
    matchCount = card.files.reduce((total, file) => total + file.matches.length, 0);
  }

  const summary =
    card.shape === "paths"
      ? card.truncated
        ? texts.searchPathsTruncated(card.paths.length, card.total)
        : texts.searchPaths(card.paths.length)
      : card.truncated
        ? texts.searchMatchesTruncated(matchCount, card.total, card.files.length)
        : texts.searchMatches(matchCount, card.files.length);

  const copyText =
    card.shape === "paths"
      ? card.paths.join("\n")
      : card.files.map((file) => [file.path, ...file.matches.map((m) => `${m.lineNumber}: ${m.line}`)].join("\n")).join("\n\n");

  const { head, tail, hidden } = capRows(rows, expanded);
  const render = (row: Row) => {
    if (row.kind === "path") {
      return (
        <div className="tool-card-line" key={`p:${row.path}`}>
          <span className="tool-card-text" title={row.path}>
            {row.path}
          </span>
        </div>
      );
    }
    if (row.kind === "file") {
      const collapsed = collapsedFiles.has(row.path);
      return (
        <button
          type="button"
          className="tool-card-file"
          key={`f:${row.path}`}
          aria-expanded={!collapsed}
          onClick={() =>
            setCollapsedFiles((previous) => {
              const next = new Set(previous);
              if (next.has(row.path)) next.delete(row.path);
              else next.add(row.path);
              return next;
            })
          }
        >
          <span className="tool-card-filepath" title={row.path}>
            {row.path}
          </span>
          <span className="tool-card-filecount">{row.count}</span>
        </button>
      );
    }
    return (
      <div className="tool-card-line" key={`m:${row.file}:${row.lineNumber}`}>
        <span className="tool-card-gutter">{row.lineNumber}: </span>
        <span className="tool-card-text">{row.line}</span>
      </div>
    );
  };

  return (
    <div className="tool-card is-search">
      <div className="tool-card-banner">
        <span className="tool-card-label">{summary}</span>
        <span className="tool-card-actions">
          {rows.length > 0 ? <CopyButton text={copyText} /> : null}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="tool-card-empty">{texts.searchNoResults}</div>
      ) : (
        <div className="tool-card-body mono">
          {head.map(render)}
          {hidden > 0 ? (
            <CardExpander
              expanded={expanded}
              expandLabel={texts.searchExpandRest(hidden)}
              collapseLabel={texts.toolCollapse}
              expandAria={texts.searchExpandAria(hidden)}
              collapseAria={texts.searchCollapseAria}
              onToggle={() => setExpanded((value) => !value)}
            />
          ) : null}
          {tail.map(render)}
        </div>
      )}
      {/* 结果被截断时，正文里那条「完整结果在哪」的说明原样给出（官方 recovery） */}
      {card.recovery !== undefined && card.recovery !== "" ? (
        <div className="tool-card-recovery mono">{card.recovery}</div>
      ) : null}
    </div>
  );
}

/** 工作目录只显示末段（官方 `xm()`：与 home 相同时给 `~`，否则取 basename）。 */
function cwdLabel(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  const last = parts[parts.length - 1];
  return last === undefined || last === "" ? cwd : last;
}

/** 终端卡（官方 `TerminalBlock`）：状态 + 提示符行 + 退出码胶囊 + 输出。 */
function TerminalCard({ card }: { card: Extract<ToolCardView, { kind: "terminal" }> }) {
  const texts = useTexts();
  const failed = !card.running && ((card.exitCode !== undefined && card.exitCode !== 0) || card.signal !== undefined);
  const stateLabel = card.running ? texts.terminalRunning : failed ? texts.terminalFailed : texts.terminalDone;
  const status =
    card.signal !== undefined
      ? texts.toolSignal(card.signal)
      : card.exitCode !== undefined && card.exitCode !== 0
        ? texts.toolExitCode(card.exitCode)
        : undefined;
  const commandLines = (card.command.endsWith("\n") ? card.command.slice(0, -1) : card.command).split("\n");
  const outputLines = card.output === "" ? [] : card.output.replace(/\n$/, "").split("\n");
  // 会话行里的终端卡**不截断**（官方 `maxLines: Infinity`）：命令行输出本来就是要看全的
  const empty = outputLines.length === 0 || outputLines.every((line) => line.trim() === "");
  return (
    <div className={`tool-card is-terminal${card.running ? " is-running" : ""}`}>
      <div className="tool-card-banner">
        <span className="tool-card-prompt">
          <span className="tool-card-state">{stateLabel}</span>
          {commandLines.map((line, index) => (
            <span className="tool-card-promptline" key={index}>
              <span className="tool-card-cwd">{index > 0 || card.cwd === undefined ? "$" : cwdLabel(card.cwd)}</span>
              <span className="tool-card-command">{line}</span>
            </span>
          ))}
        </span>
        <span className="tool-card-actions">
          {status !== undefined ? <span className="tool-card-pill">{status}</span> : null}
          {!card.running && !empty ? <CopyButton text={card.output} /> : null}
        </span>
      </div>
      {!card.running ? (
        empty ? (
          <div className="tool-card-empty">{texts.terminalNoOutput}</div>
        ) : (
          <div className="tool-card-body mono">
            {outputLines.map((line, index) => (
              <div className="tool-card-textline" key={index}>
                {line}
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

/** 网页来源的显示名：标题优先，其次主机名（官方 `Rg(url, title)`）。 */
function sourceLabel(url: string, title?: string): string {
  if (title !== undefined && title.trim() !== "") return title;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 网页卡（官方 `WebBlock`）：搜索给答案 + 来源列表，获取给链接 + HTTP 状态。 */
function WebCard({ card }: { card: Extract<ToolCardView, { kind: "web_search" | "web_fetch" }> }) {
  const texts = useTexts();
  if (card.kind === "web_fetch") {
    return (
      <div className="tool-card is-web">
        <div className="tool-card-banner">
          <a className="tool-card-link" href={card.url} target="_blank" rel="noopener noreferrer" title={card.url}>
            {card.url}
          </a>
          <span className="tool-card-actions">
            <span className="tool-card-count">
              {texts.webHttp} {card.statusCode}
            </span>
            {card.truncated ? <span className="tool-card-count">{texts.webContentTruncated}</span> : null}
          </span>
        </div>
      </div>
    );
  }
  const empty = (card.answer === undefined || card.answer === "") && card.sources.length === 0;
  return (
    <div className="tool-card is-web">
      {card.answer !== undefined && card.answer !== "" ? (
        <div className="tool-card-answer">
          <Markdown text={card.answer} />
        </div>
      ) : null}
      {empty ? (
        <div className="tool-card-empty">{texts.webNoResults}</div>
      ) : (
        <ol className="tool-card-sources">
          {card.sources.map((source, index) => (
            <li className="tool-card-source" key={`${source.url}:${index}`} value={index + 1}>
              <a
                className="tool-card-link"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                title={source.url}
              >
                {sourceLabel(source.url, source.title)}
              </a>
              {source.snippet !== undefined && source.snippet !== "" ? (
                <div className="tool-card-snippet">{source.snippet}</div>
              ) : null}
              {source.publishedAt !== undefined && source.publishedAt !== "" ? (
                <div className="tool-card-published">{source.publishedAt}</div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {card.truncated ? <div className="tool-card-empty">{texts.webSourcesTruncated}</div> : null}
    </div>
  );
}

/** 卡片正文：按种类分派（`code` 由调用方直接渲染代码块，见 Rows.tsx）。 */
export function ToolCardBody({ card }: { card: ToolCardView }) {
  switch (card.kind) {
    case "read":
      return <ReadCard card={card} />;
    case "search":
      return <SearchCard card={card} />;
    case "terminal":
      return <TerminalCard card={card} />;
    case "web_search":
    case "web_fetch":
      return <WebCard card={card} />;
    default:
      return null;
  }
}
