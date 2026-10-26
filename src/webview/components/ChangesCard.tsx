import { useEffect, useRef, useState } from "react";
import type { ChangesSummaryView } from "../../shared/chat";
import { CHANGES_CARD_VISIBLE, visibleChangeFiles } from "../../shared/changesSummary";
import { post } from "../bridge";
import { IconChevronDown } from "../icons";
import { resolvedFilePath } from "../linkHovers";
import { useTexts } from "../texts";

/**
 * 轮尾的**改动文件卡片**（官方 `ui-deliverables` 的 changed-files card）。
 *
 * 数据来源与官方同构：会话事件 `workspace/changes` 只宣告「本轮改了文件」并给出
 * 轮号，清单本身留在 Host 内存里按 `(sessionId, seq)` 提供（认证路由
 * `/api/changes.summary`）。所以卡片**可能根本没有**：
 *
 * - 还没问到（`summary === undefined`）：这里发一次 `requestChanges`，先**不显示**
 *   ——官方在读取未完成时同样没有卡片，不占位、不闪骨架；
 * - Host 说没有（`summary === null`，Host 重启过或 Session 已释放）：不显示，而且
 *   界面记下「问过了、没有」，不再重复问（见 `webview/state.ts` 的缓存值语义）；
 * - 清单里一个文件都没有：不显示（官方的同一条 rules）。
 *
 * 调用方（`Message`）在**卡片真的显示出来**时才让「本轮改动」文件行让位——拿不到
 * 清单时那一行还留着，信息不会两头都丢。
 */
export function ChangesCard({
  sessionId,
  coordinates,
  summary,
  cwd,
}: {
  sessionId: string;
  /** 该轮最新一条 `workspace/changes` 宣告的坐标（轮号 + 事件 seq）。 */
  coordinates: { turn: number; seq: number };
  /** 清单：`undefined` = 还没问过，`null` = Host 说没有。 */
  summary: ChangesSummaryView | null | undefined;
  /** 会话**创建目录**：行悬停给出完整路径（清单里的 `path` 可能是相对拼写）。 */
  cwd?: string;
}) {
  const texts = useTexts();
  const [expanded, setExpanded] = useState(false);
  const { seq } = coordinates;
  const missing = summary === undefined;
  /** 已经发过预热的行（同一行在一次卡片生命周期内只发一帧，悬停进出不刷宿主）。 */
  const prefetched = useRef(new Set<number>());

  useEffect(() => {
    if (!missing) return;
    post({ type: "requestChanges", sessionId, seq });
  }, [missing, sessionId, seq]);

  // 同一轮后来的宣告会换 seq：预热记的是「这份清单的哪些行」，换清单就重新记
  useEffect(() => {
    prefetched.current.clear();
  }, [seq]);

  /**
   * 悬停 / 聚焦时预热这一行的对比。
   *
   * 只取数、不打开编辑器（见 `shared/ipc.ts` 的 `prefetchChanges`）：用户从悬停到
   * 按下鼠标通常有几十到几百毫秒，这段时间足够宿主把 `/api/changes.diff` 取回来；
   * 真正点击时直接命中缓存，不再等「点了才去加载」。
   */
  const prefetch = (index: number): void => {
    if (prefetched.current.has(index)) return;
    prefetched.current.add(index);
    post({ type: "prefetchChanges", seq, index });
  };

  if (!summary || summary.files.length === 0) return null;

  const shown = visibleChangeFiles(summary.files, expanded);
  const hidden = summary.files.length - shown.length;
  const foldable = summary.files.length > CHANGES_CARD_VISIBLE;
  /** 展开/收起：标题栏与底部那枚按钮共用它，两处的 `expanded` 与文案才是同一个状态。 */
  const toggle = () => setExpanded((value) => !value);

  /** 标题 + 折展箭头 + 靠右的增删行数。箭头只在真有东西可折时画（否则是在许空愿）。 */
  const heading = (
    <>
      <span className="changes-card-title">{texts.changesCardTitle(summary.total)}</span>
      {foldable ? <IconChevronDown size={12} className="changes-card-chevron" /> : null}
      <span className="changes-card-counts">
        <span className="diff-add">{texts.changesCardAdded(summary.added)}</span>
        <span className="diff-del">{texts.changesCardDeleted(summary.deleted)}</span>
      </span>
    </>
  );

  return (
    <div className="changes-card">
      {/* 标题栏：文件多到折起来时，它自己就是展开/收起入口（右侧箭头随开合翻转，
          与底部那枚按钮同一动作），文件不多时退回纯表头——不做点了没反应的控件。
          **任何形态都不打开文件**：官方那张卡片的标题点开的是侧边栏复查面板
          （`ChangedFiles.tsx` 的 header → `openReview(0)`），本客户端没有那个面板，
          先前照搬成「点标题 = 打开第一个文件的改动」，于是看起来是表头的那一行成了
          第一个文件的行，标题高度的点击落在第一个文件上（用户 2026-09-25 报
          「第一个文件的触发区一直高到标题栏」）。打开文件只从下面的文件行进
          （默认看改动、按住修饰键直接打开文件）。 */}
      {foldable ? (
        <button type="button" className="changes-card-head" aria-expanded={expanded} onClick={toggle}>
          {heading}
        </button>
      ) : (
        <div className="changes-card-head">{heading}</div>
      )}
      <div className="changes-card-files">
        {shown.map((file, index) => (
          <button
            type="button"
            key={file.path}
            className="changes-card-row"
            title={`${resolvedFilePath(cwd, file.path)}\n${texts.openChangesHint}`}
            aria-label={texts.openChangesAria(file.display)}
            // 悬停 / 键盘聚焦即预热：点击时大概率已经命中缓存（见上面的 prefetch）
            onPointerEnter={() => prefetch(index)}
            onFocus={() => prefetch(index)}
            onClick={(event) =>
              // 坐标带的是 Host 清单里的**原始下标**：折叠只是不铺出来，不重排
              // `files`，所以 `shown` 里的位置与它一致（可见行总是从 0 开始切）。
              // 有了这份坐标，宿主才能打开本轮快照的对比——提交之后照样看得到。
              post({
                type: "openFile",
                path: file.path,
                diff: !hasModifier(event),
                changes: { seq, index, turn: summary.turn },
              })
            }
          >
            <span className="changes-card-path">{file.display}</span>
            {/* 二进制 / 过大没有行数可言（Host 给的计数是 0），照实说明而不是印「+0 −0」。
                行数与标题用的是同一对类名（`.diff-add` 绿 / `.diff-del` 红），与 diff
                视图里的统计同一套配色。 */}
            <span className="changes-card-delta">
              {file.binary ? (
                texts.changesCardBinary
              ) : file.oversized ? (
                texts.changesCardOversized
              ) : (
                <>
                  <span className="diff-add">{texts.changesCardAdded(file.added)}</span>
                  <span className="diff-del">{texts.changesCardDeleted(file.deleted)}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </div>
      {foldable ? (
        <button
          type="button"
          className="changes-card-more"
          aria-expanded={expanded}
          aria-label={expanded ? texts.changesCardCollapseAria : texts.changesCardExpandAria(summary.files.length)}
          onClick={toggle}
        >
          {expanded ? texts.filesCollapse : texts.changesCardMore(hidden)}
        </button>
      ) : null}
    </div>
  );
}

/** 与文件芯片同一套点击意图：默认看改动，按住 Alt/Ctrl/Cmd/Shift 时直接打开文件。 */
function hasModifier(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}
