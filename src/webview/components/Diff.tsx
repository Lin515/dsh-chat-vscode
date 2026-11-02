import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { DiffHunkView, DiffLayout, DiffLineView } from "../../shared/chat";
import { diffClipboardText, splitDiffEnabled } from "../../shared/diff";
import { languageForPath, splitSpansByLine, type HighlightSpan } from "../markdown/highlight";
import type { MarkdownPhase } from "../markdown/types";
import { diffLineSides } from "../diffHighlight";
import { renderHighlighted } from "./HighlightedText";
import { CopyButton } from "./CopyButton";
import { useCodeHighlight } from "./useCodeHighlight";
import { useTexts } from "../texts";
import { dp, useUiScale } from "../uiScale";

/**
 * 编辑类节点的 diff 渲染。
 *
 * 两种排版：
 * - 单栏（unified）：一段行序列，`+` / `-` 前缀 + 底色；
 * - 双栏（split）：左旧右新，同一处改动上下对齐（连续删除块与新增块配对）。
 *
 * `auto` 由容器宽度决定：窄对话框（侧栏）单栏，宽（编辑器面板）双栏。
 * **例外**见 `shared/diff.splitDiffEnabled`：写入节点（整篇新建）与任何「没有删除
 * 行」的差异一律单栏——双栏在那种形状下有一整列是空的（用户 2026-09-16 口径）。
 *
 * 高亮只在 `phase === "settled"` 生效，且**旧侧 = context + del、新侧 =
 * context + add 分别 tokenize**：两侧各自是本 hunk 内的连续片段，
 * 不跨 hunk / 不连续片段拼成整文件。每个 hunk 独立请求，缺上下文时只影响当前
 * hunk 的着色，不会把相邻片段的状态假接过来。
 */
const SPLIT_MIN_WIDTH = 640;

/** 观察容器宽度，决定自适应模式是否用双栏。 */
function useWideEnough(ref: RefObject<HTMLElement | null>): boolean {
  const scale = useUiScale();
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 640 是**设计像素**：两栏里的代码文本随界面倍率变宽，这条线也得跟着走
    const check = () => setWide(el.clientWidth >= dp(SPLIT_MIN_WIDTH, scale));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, scale]);
  return wide;
}

type DiffSide = "old" | "new";

/** 某个 hunk 行下标在指定一侧的 token 段；没有高亮 / 不属于该侧时 undefined。 */
type SpanFor = (index: number, side: DiffSide) => readonly HighlightSpan[] | undefined;

interface IndexedLine {
  line: DiffLineView;
  index: number;
}

/** 连续删除块与新增块配对成左右两栏，上下文行两边相同。 */
function splitRows(lines: DiffLineView[]): { left?: IndexedLine; right?: IndexedLine }[] {
  const rows: { left?: IndexedLine; right?: IndexedLine }[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      rows.push({ left: { line, index }, right: { line, index } });
      index++;
      continue;
    }
    const removed: IndexedLine[] = [];
    const added: IndexedLine[] = [];
    while (index < lines.length && lines[index].kind === "del") {
      removed.push({ line: lines[index], index });
      index++;
    }
    while (index < lines.length && lines[index].kind === "add") {
      added.push({ line: lines[index], index });
      index++;
    }
    const height = Math.max(removed.length, added.length);
    for (let at = 0; at < height; at++) rows.push({ left: removed[at], right: added[at] });
  }
  return rows;
}

function sign(line: DiffLineView | undefined): string {
  if (!line) return " ";
  return line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
}

function HunkHead({ hunk, copy }: { hunk: DiffHunkView; copy?: ReactNode }) {
  return (
    <div className="diff-head">
      {hunk.path ? (
        <span className="diff-path" title={hunk.path}>
          {hunk.path}
        </span>
      ) : null}
      <span className="diff-stat">
        {hunk.added ? <span className="diff-add">+{hunk.added}</span> : null}
        {hunk.removed ? <span className="diff-del">-{hunk.removed}</span> : null}
      </span>
      {copy}
    </div>
  );
}

/** 一行 diff 正文：可选中与复制的是原 `line.text`，高亮只加受控 span。 */
function DiffText({ text, spans }: { text: string; spans?: readonly HighlightSpan[] }) {
  return (
    <span className="diff-text">
      {spans === undefined ? text : renderHighlighted(text, spans)}
    </span>
  );
}

function UnifiedLines({ lines, spanFor }: { lines: DiffLineView[]; spanFor: SpanFor }) {
  return (
    <>
      {lines.map((line, index) => (
        <div className={`diff-line is-${line.kind}`} key={index}>
          <span className="diff-sign">{sign(line)}</span>
          <DiffText text={line.text} spans={spanFor(index, line.kind === "add" ? "new" : "old")} />
        </div>
      ))}
    </>
  );
}

function SplitLines({ lines, spanFor }: { lines: DiffLineView[]; spanFor: SpanFor }) {
  return (
    <>
      {splitRows(lines).map((row, index) => (
        <div className="diff-pair" key={index}>
          <div className={`diff-cell${row.left ? ` is-${row.left.line.kind}` : " is-empty"}`}>
            <span className="diff-sign">{sign(row.left?.line)}</span>
            <DiffText
              text={row.left?.line.text ?? ""}
              spans={row.left === undefined ? undefined : spanFor(row.left.index, "old")}
            />
          </div>
          <div className={`diff-cell${row.right ? ` is-${row.right.line.kind}` : " is-empty"}`}>
            <span className="diff-sign">{sign(row.right?.line)}</span>
            <DiffText
              text={row.right?.line.text ?? ""}
              spans={row.right === undefined ? undefined : spanFor(row.right.index, "new")}
            />
          </div>
        </div>
      ))}
    </>
  );
}

/** 一个 hunk：单栏或双栏；两侧各自 tokenize 整段连续片段。 */
function Hunk({ hunk, split, phase, lang, copy }: { hunk: DiffHunkView; split: boolean; phase: MarkdownPhase; lang?: string; copy?: ReactNode }) {
  const texts = useTexts();
  const rootRef = useRef<HTMLDivElement>(null);
  const active = phase === "settled";
  const sides = useMemo(() => diffLineSides(hunk.lines), [hunk.lines]);
  const oldSpans = useCodeHighlight({ code: sides.oldText, lang, active, elementRef: rootRef });
  const newSpans = useCodeHighlight({ code: sides.newText, lang, active, elementRef: rootRef });
  const oldByLine = useMemo(
    () => (oldSpans === null ? undefined : splitSpansByLine(sides.oldText, oldSpans)),
    [oldSpans, sides.oldText],
  );
  const newByLine = useMemo(
    () => (newSpans === null ? undefined : splitSpansByLine(sides.newText, newSpans)),
    [newSpans, sides.newText],
  );
  const spanFor: SpanFor = (index, side) => {
    const lineIndex = side === "old" ? sides.oldLine[index] : sides.newLine[index];
    if (lineIndex === undefined) return undefined;
    return (side === "old" ? oldByLine : newByLine)?.[lineIndex];
  };
  if (hunk.lines.length === 0) return null;

  return (
    <div ref={rootRef} className="diff-hunk">
      <HunkHead hunk={hunk} copy={copy} />
      {split ? <SplitLines lines={hunk.lines} spanFor={spanFor} /> : <UnifiedLines lines={hunk.lines} spanFor={spanFor} />}
      {hunk.truncated ? <div className="diff-more">{texts.diffTruncated}</div> : null}
    </div>
  );
}

export function DiffView({
  hunks,
  layout,
  unified,
  phase = "streaming",
  fallbackLang,
}: {
  hunks: DiffHunkView[];
  layout?: DiffLayout;
  /** 调用方固化单栏（写入节点传 true，见 `splitDiffEnabled`）。 */
  unified?: boolean;
  /** 缺省 streaming（不着色）；只有明确结算的调用方传 settled。 */
  phase?: MarkdownPhase;
  /** hunk 没有 path 或扩展名不认识时的语言回退（通常来自工具参数里的文件路径）。 */
  fallbackLang?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wide = useWideEnough(ref);
  const split = splitDiffEnabled({ hunks, layout, wide, unified });
  const diffText = useMemo(() => diffClipboardText(hunks), [hunks]);
  /**
   * 复制入口挂在**第一段** hunk 的头部（路径 + 计数那一行）。
   *
   * 官方用一条 `CodeToolbar` 横在正文上方；我们的每段 hunk 本来就有那一行，
   * 再单独加一条工具条会多出一行空白。放头部也不压正文首行（不浮动、占布局），
   * 与官方「工具条占布局」的要求一致。复制的是**整张卡**的全部 hunk，不是第一段。
   *
   * 载荷按 `hunks` 身份记忆：流式期每次增量都会重渲染，没必要每次重拼整段文本。
   */
  const copyNode = hunks.length === 0 ? undefined : <CopyButton text={diffText} />;
  return (
    <div ref={ref} className={`diff md-code-surface${split ? " is-split" : ""}`}>
      {hunks.map((hunk, index) => (
        <Hunk
          key={index}
          hunk={hunk}
          split={split}
          phase={phase}
          lang={languageForPath(hunk.path) ?? fallbackLang}
          {...(index === 0 && copyNode !== undefined ? { copy: copyNode } : {})}
        />
      ))}
    </div>
  );
}
