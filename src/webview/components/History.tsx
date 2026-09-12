import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummaryView } from "../../shared/chat";
import { post } from "../bridge";
import { IconArchive, IconClose, IconPlus, IconSearch, IconTrash } from "../icons";
import { formatClock } from "./primitives";
import { useTexts } from "../texts";

/** 删除确认（二次点击）的自动解除时长。 */
const DELETE_ARM_MS = 3000;

/**
 * 屏蔽 webview 里的默认右键菜单。
 *
 * 会话历史是纯浏览/挑选的场景：右键弹出的「复制 / 全选」是噪音（用户 2026-09-12
 * 要求去掉）。webview 宿主本身把 `defaultPrevented` 当作「扩展已处理」的开关
 * （VS Code 的 `webview/browser/pre/index.html`：监听 contextmenu，`if
 * (e.defaultPrevented) return;`，否则才弹它自己的原生菜单），所以
 * `preventDefault()` 就是「别弹菜单」的唯一手段。
 *
 * 搜索框例外：那里右键要能粘贴，所以可编辑元素放行。
 */
function blockContextMenu(event: React.MouseEvent<HTMLElement>): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  event.preventDefault();
}

/** 抽屉的两种视图：普通会话列表 / 归档列表。 */
type HistoryView = "sessions" | "archived";

/** 会话历史抽屉。Continue 在宽侧栏用常驻列表，窄侧栏用独立页；这里用抽屉兼顾两者。 */
export function HistoryPanel({
  sessions,
  archivedSessions,
  currentId,
  onClose,
}: {
  sessions: SessionSummaryView[];
  archivedSessions: SessionSummaryView[];
  currentId?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<HistoryView>("sessions");
  const [query, setQuery] = useState("");
  // 垃圾桶的二次确认：首次点击只「武装」该行图标（变红 + 提示），
  // 3 秒内再点才真正删除
  const [armedDelete, setArmedDelete] = useState<string | undefined>(undefined);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  const texts = useTexts();

  const armDelete = (sessionId: string) => {
    setArmedDelete(sessionId);
    clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmedDelete(undefined), DELETE_ARM_MS);
  };

  const archived = view === "archived";

  const { today, earlier } = useMemo(() => {
    const source = archived ? archivedSessions : sessions;
    const filtered = query.trim()
      ? source.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()))
      : source;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayList: SessionSummaryView[] = [];
    const earlierList: SessionSummaryView[] = [];
    for (const session of filtered) {
      (session.updatedAt >= startOfToday.getTime() ? todayList : earlierList).push(session);
    }
    return { today: todayList, earlier: earlierList };
  }, [archived, sessions, archivedSessions, query]);

  const renderGroup = (label: string, items: SessionSummaryView[]) =>
    items.length ? (
      <>
        <div className="session-group">{label}</div>
        {items.map((session) => {
          // 已被占用（运行中）或当前正在查看的会话：不显示归档 / 删除按钮
          const locked = session.running || session.id === currentId;
          const depth = session.depth ?? 0;
          const title = session.title || texts.untitled;
          return (
            <div
              key={session.id}
              className={`session-item${session.id === currentId ? " is-current" : ""}${
                depth > 0 ? " is-child" : ""
              }`}
              // 分支会话缩进挂在源会话下面：它继承源会话的标题（官方 fork 的
              // 行为），不缩进就会被看成两条一模一样的重复条目。
              style={{ "--session-indent": `${2 + depth * 14}px` } as React.CSSProperties}
            >
              <button
                className="session-item-main"
                onClick={() => {
                  post({ type: "openSession", sessionId: session.id });
                  onClose();
                }}
              >
                {/* 分支标题加「分支:」前缀：它继承源会话的标题，光靠缩进
                    仍可能被当成同一条重复项（文案在词典里，中英各一份） */}
                <span className="session-item-title">
                  {depth > 0 ? texts.forkedTitle(title) : title}
                </span>
                <span className="session-item-sub">
                  {armedDelete === session.id ? (
                    <span className="session-item-delete-hint">{texts.deleteSessionConfirm}</span>
                  ) : (
                    <>
                      {session.running ? `${texts.runningTag} · ` : ""}
                      {formatClock(session.updatedAt)}
                    </>
                  )}
                </span>
              </button>
              {locked ? null : (
                <span className="session-item-actions">
                  {archived ? null : (
                    <button
                      className="icon-btn"
                      title={texts.archive}
                      onClick={() => post({ type: "archiveSession", sessionId: session.id })}
                    >
                      <IconArchive size={13} />
                    </button>
                  )}
                  <button
                    className={`icon-btn${armedDelete === session.id ? " is-danger" : ""}`}
                    title={armedDelete === session.id ? texts.deleteSessionConfirm : texts.deleteSession}
                    onClick={() => {
                      if (armedDelete === session.id) {
                        setArmedDelete(undefined);
                        clearTimeout(armTimer.current);
                        post({ type: "deleteSession", sessionId: session.id });
                      } else {
                        armDelete(session.id);
                      }
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </>
    ) : null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} onContextMenu={blockContextMenu} />
      <div className="drawer" onContextMenu={blockContextMenu}>
        <div className="drawer-head">
          <span>{archived ? texts.archiveList : texts.history}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            className={`icon-btn${archived ? " is-active" : ""}`}
            title={texts.archiveList}
            onClick={() => {
              setView(archived ? "sessions" : "archived");
              // 归档集合可能已变化（workspace/follow 流），切视图时顺手刷新一次
              post({ type: "listSessions" });
            }}
          >
            <IconArchive size={14} />
          </button>
          <button
            className="icon-btn"
            title={texts.newChat}
            onClick={() => {
              post({ type: "newSession" });
              onClose();
            }}
          >
            <IconPlus size={14} />
          </button>
          <button className="icon-btn" title={texts.cancel} onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>
        <label className="drawer-search-box">
          <IconSearch size={13} />
          <input
            className="drawer-search"
            placeholder={texts.searchSessions}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="drawer-body">
          {view === "sessions"
            ? sessions.length === 0 ? (
                <div className="popover-empty">{texts.noSessions}</div>
              ) : (
                <>
                  {renderGroup(texts.today, today)}
                  {renderGroup(texts.earlier, earlier)}
                </>
              )
            : archivedSessions.length === 0 ? (
                <div className="popover-empty">{texts.noArchivedSessions}</div>
              ) : (
                <>
                  {renderGroup(texts.today, today)}
                  {renderGroup(texts.earlier, earlier)}
                </>
              )}
        </div>
      </div>
    </>
  );
}
