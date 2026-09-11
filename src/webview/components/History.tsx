import { useMemo, useState } from "react";
import type { SessionSummaryView } from "../../shared/chat";
import { post } from "../bridge";
import { IconClose, IconPlus, IconSearch } from "../icons";
import { formatClock } from "./primitives";
import { useTexts } from "../texts";

/** 会话历史抽屉。Continue 在宽侧栏用常驻列表，窄侧栏用独立页；这里用抽屉兼顾两者。 */
export function HistoryPanel({
  sessions,
  currentId,
  onClose,
}: {
  sessions: SessionSummaryView[];
  currentId?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const texts = useTexts();

  const { today, earlier } = useMemo(() => {
    const filtered = query.trim()
      ? sessions.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()))
      : sessions;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayList: SessionSummaryView[] = [];
    const earlierList: SessionSummaryView[] = [];
    for (const session of filtered) {
      (session.updatedAt >= startOfToday.getTime() ? todayList : earlierList).push(session);
    }
    return { today: todayList, earlier: earlierList };
  }, [sessions, query]);

  const renderGroup = (label: string, items: SessionSummaryView[]) =>
    items.length ? (
      <>
        <div className="session-group">{label}</div>
        {items.map((session) => (
          <button
            key={session.id}
            className={`session-item${session.id === currentId ? " is-current" : ""}`}
            onClick={() => {
              post({ type: "openSession", sessionId: session.id });
              onClose();
            }}
          >
            <span className="session-item-title">{session.title || texts.untitled}</span>
            <span className="session-item-sub">
              {session.running ? `${texts.runningTag} · ` : ""}
              {formatClock(session.updatedAt)}
            </span>
          </button>
        ))}
      </>
    ) : null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <IconSearch size={13} />
          <span>{texts.history}</span>
          <span className="spacer" style={{ flex: 1 }} />
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
        <input
          className="drawer-search"
          placeholder={texts.searchSessions}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="drawer-body">
          {sessions.length === 0 ? (
            <div className="popover-empty">{texts.noSessions}</div>
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
