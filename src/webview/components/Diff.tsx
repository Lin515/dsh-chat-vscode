import { useEffect, useRef, useState, type RefObject } from "react";
import type { DiffHunkView, DiffLayout, DiffLineView } from "../../shared/chat";
import { splitDiffEnabled } from "../../shared/diff";
import { useTexts } from "../texts";

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
 */
const SPLIT_MIN_WIDTH = 640;

/** 观察容器宽度，决定自适应模式是否用双栏。 */
function useWideEnough(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setWide(el.clientWidth >= SPLIT_MIN_WIDTH);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}

/** 连续删除块与新增块配对成左右两栏，上下文行两边相同。 */
function splitRows(lines: DiffLineView[]): { left?: DiffLineView; right?: DiffLineView }[] {
  const rows: { left?: DiffLineView; right?: DiffLineView }[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }
    const removed: DiffLineView[] = [];
    const added: DiffLineView[] = [];
    while (index < lines.length && lines[index].kind === "del") removed.push(lines[index++]);
    while (index < lines.length && lines[index].kind === "add") added.push(lines[index++]);
    const height = Math.max(removed.length, added.length);
    for (let i = 0; i < height; i++) rows.push({ left: removed[i], right: added[i] });
  }
  return rows;
}

function sign(line: DiffLineView | undefined): string {
  if (!line) return " ";
  return line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
}

function HunkHead({ hunk }: { hunk: DiffHunkView }) {
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
    </div>
  );
}

function UnifiedLines({ lines }: { lines: DiffLineView[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <div className={`diff-line is-${line.kind}`} key={index}>
          <span className="diff-sign">{sign(line)}</span>
          <span className="diff-text">{line.text}</span>
        </div>
      ))}
    </>
  );
}

function SplitLines({ lines }: { lines: DiffLineView[] }) {
  return (
    <>
      {splitRows(lines).map((row, index) => (
        <div className="diff-pair" key={index}>
          <div className={`diff-cell${row.left ? ` is-${row.left.kind}` : " is-empty"}`}>
            <span className="diff-sign">{sign(row.left)}</span>
            <span className="diff-text">{row.left?.text ?? ""}</span>
          </div>
          <div className={`diff-cell${row.right ? ` is-${row.right.kind}` : " is-empty"}`}>
            <span className="diff-sign">{sign(row.right)}</span>
            <span className="diff-text">{row.right?.text ?? ""}</span>
          </div>
        </div>
      ))}
    </>
  );
}

/** 一个 hunk：单栏或双栏。 */
function Hunk({ hunk, split }: { hunk: DiffHunkView; split: boolean }) {
  const texts = useTexts();
  if (hunk.lines.length === 0) return null;

  return (
    <div className="diff-hunk">
      <HunkHead hunk={hunk} />
      {split ? <SplitLines lines={hunk.lines} /> : <UnifiedLines lines={hunk.lines} />}
      {hunk.truncated ? <div className="diff-more">{texts.diffTruncated}</div> : null}
    </div>
  );
}

export function DiffView({
  hunks,
  layout,
  unified,
}: {
  hunks: DiffHunkView[];
  layout?: DiffLayout;
  /** 调用方固化单栏（写入节点传 true，见 `splitDiffEnabled`）。 */
  unified?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wide = useWideEnough(ref);
  const split = splitDiffEnabled({ hunks, layout, wide, unified });
  return (
    <div ref={ref} className={`diff${split ? " is-split" : ""}`}>
      {hunks.map((hunk, index) => (
        <Hunk key={index} hunk={hunk} split={split} />
      ))}
    </div>
  );
}
