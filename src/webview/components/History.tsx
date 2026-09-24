import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummaryView } from "../../shared/chat";
import { post } from "../bridge";
import { IconArchive, IconClose, IconPlus, IconSearch, IconTrash } from "../icons";
import { formatClock } from "./primitives";
import { useTexts } from "../texts";

/** 删除确认（二次点击）的自动解除时长。 */
const DELETE_ARM_MS = 3000;

/**
 * 抽屉**不再自己屏蔽**右键菜单。
 *
 * 用户 2026-09-12 要的是「去掉历史对话里那个没用的右键菜单」，2026-09-23 这条口径升级成
 * **全局**的：整个界面只有「右键压在自己选中的文字上」时才放行原生菜单，其余地方一律拦掉
 * ——判据与拦法都在 `webview/contextMenu.ts`（挂 `document`，先于 VS Code 挂在 window 上
 * 的那个监听）。这里再留一份「抽屉里禁用右键」就成了第二条口径：它会连「选中会话标题 →
 * 右键复制」一起吃掉，而且两处判据会各自漂。
 */

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
          // 分支（fork）会话：**和普通会话同级**（用户 2026-09-19 口径，不再缩进）——
          // 它继承源会话的标题，所以靠标题前缀「分支: 」区分，不靠缩进。
          const forked = session.parentSessionId !== undefined;
          const title = session.title || texts.untitled;
          return (
            <div
              key={session.id}
              className={`session-item${session.id === currentId ? " is-current" : ""}${
                // 运行中，或「离开时它还在生成、回来时已经完毕」：标题显示蓝色（.is-highlight）
                session.running || session.unread ? " is-highlight" : ""
              }`}
            >
              <button
                className="session-item-main"
                onClick={() => {
                  post({ type: "openSession", sessionId: session.id });
                  onClose();
                }}
              >
                {/* 分支标题加「分支:」前缀：它继承源会话的标题，不加前缀会看成
                    同一条重复项（文案在词典里，中英各一份） */}
                <span className="session-item-title">
                  {forked ? texts.forkedTitle(title) : title}
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
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
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
