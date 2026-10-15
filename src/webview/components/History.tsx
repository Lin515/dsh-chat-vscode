import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummaryView } from "../../shared/chat";
import { post } from "../bridge";
import { ESC_LAYER, useEscapeLayer } from "../escapeOwner";
import { IconArchive, IconClose, IconMultiSelect, IconPlus, IconSearch, IconTrash, IconUnarchive } from "../icons";
import {
  allSelected,
  pruneSelection,
  selectableSessionIds,
  sessionLocked,
  toggleAllSelection,
  toggleSelection,
} from "../sessionSelection";
import { IconCopyButton } from "./CopyButton";
import { formatClock } from "./primitives";
import { useTexts } from "../texts";

/** 删除确认（二次点击）的自动解除时长；行内垃圾桶与多选工具条共用。 */
const DELETE_ARM_MS = 3000;

/** 空选择集：清空时复用同一个对象，省掉一次无意义的重渲染。 */
const NO_SELECTION: ReadonlySet<string> = new Set<string>();

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
  /**
   * 多选形态（用户 2026-10-15 口径：顶部那颗切换按钮点开才有，再点一次退出）。
   *
   * 抽屉平时是一张干净的历史列表——复选框与批量工具条只在这个形态里出现；此外这个
   * 形态下**整行就是选择目标**（点标题不再打开会话），不必先瞄准那颗小方框。
   */
  const [multiSelect, setMultiSelect] = useState(false);
  // 垃圾桶的二次确认：首次点击只「武装」该行图标（变红 + 提示），
  // 3 秒内再点才真正删除
  const [armedDelete, setArmedDelete] = useState<string | undefined>(undefined);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 多选：勾中的会话 id（只由勾选与「对齐当前列表」两处改），以及工具条上那条
  // 二次确认（与行内垃圾桶同一条口径，见 `DELETE_ARM_MS`）
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [armedBatch, setArmedBatch] = useState(false);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(armTimer.current);
      clearTimeout(batchTimer.current);
    },
    [],
  );
  const texts = useTexts();
  // 抽屉一挂上就是开着（App 只在面板为 history 时渲染它）：ESC 归它，关掉自己。
  // 组件卸载即注销，不会留下吞键的空壳（见 `../escapeOwner.ts` 的 `useEscapeLayer`）；
  // 遮罩带全屏层级（`ESC_LAYER.drawer` 压过并列浮层），一次 ESC 只关抽屉本身
  useEscapeLayer(ESC_LAYER.drawer, true, onClose);

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

  /**
   * 当前**看得见且可选**的会话：选择集只跟这一份走。
   *
   * 搜索框改可见行、切归档视图换一份列表、归档 / 恢复 / 删除后行消失，都要让选中项
   * 跟着退——留下的那些是看不见却会被批量操作命中的幽灵选择（判据与理由见
   * `../sessionSelection.ts`）。
   */
  const selectableIds = useMemo(
    () => selectableSessionIds([...today, ...earlier], currentId),
    [today, earlier, currentId],
  );
  useEffect(() => {
    setSelected((prev) => pruneSelection(prev, selectableIds));
  }, [selectableIds]);

  const disarmRowDelete = () => {
    clearTimeout(armTimer.current);
    setArmedDelete(undefined);
  };
  /**
   * 选择集一变，工具条上的二次确认就作废：确认文案里的数量是按当时那一批算的，
   * 换了目标再点一下不该当成「还是那一批」。用户点选与上面那条「对齐当前列表」都走这里
   * （两处各写一次作废就容易漏，漏掉的那条会留下一个指错对象的确认态）。
   */
  useEffect(() => {
    clearTimeout(batchTimer.current);
    setArmedBatch(false);
  }, [selected]);
  const changeSelection = (next: ReadonlySet<string>) => setSelected(next);
  const clearSelection = () => changeSelection(NO_SELECTION);

  const armDelete = (sessionId: string) => {
    setArmedDelete(sessionId);
    clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmedDelete(undefined), DELETE_ARM_MS);
    // 同一时刻只留一个「待确认」的删除目标：两只手同时武装两处，用户就分不清
    // 再点哪一下删的是哪一批
    clearTimeout(batchTimer.current);
    setArmedBatch(false);
  };

  const selectedCount = selected.size;
  const allChecked = allSelected(selected, selectableIds);
  // 「准备删除」的渲染判据：确认态只在**真有选中项**时成立——选择集被对齐清空的那一帧
  // （下面那条 effect 还没来得及复位）不该画出「再次点击确认删除 0 项」
  const armed = armedBatch && selectedCount > 0;

  const toggleAll = () => {
    changeSelection(toggleAllSelection(selected, selectableIds));
  };

  const archiveSelected = () => {
    for (const sessionId of selected) post({ type: "archiveSession", sessionId });
    clearSelection();
  };

  const restoreSelected = () => {
    for (const sessionId of selected) post({ type: "unarchiveSession", sessionId });
    clearSelection();
  };

  const armBatchDelete = () => {
    disarmRowDelete();
    setArmedBatch(true);
    clearTimeout(batchTimer.current);
    batchTimer.current = setTimeout(() => setArmedBatch(false), DELETE_ARM_MS);
  };

  const deleteSelected = () => {
    if (!armed) {
      armBatchDelete();
      return;
    }
    for (const sessionId of selected) post({ type: "deleteSession", sessionId });
    clearSelection();
  };

  const switchView = () => {
    setView(archived ? "sessions" : "archived");
    // 两份列表是两套会话，选中项不跟着走（下面的对齐 effect 也会兜住，这里显式清一次，
    // 免得确认态跨视图留下一条字面还对的「再次点击确认删除 N 项」）。多选形态本身留着：
    // 用户切过去多半还要接着挑
    clearSelection();
    // 归档集合可能已变化（workspace/follow 流），切视图时顺手刷新一次
    post({ type: "listSessions" });
  };

  /**
   * 进出多选形态。进出都清一次选择集与确认态：退出时收干净（下次进来是一张干净的
   * 列表），进来时也保证不带着上一次的残留。
   */
  const toggleMultiSelect = () => {
    setMultiSelect(!multiSelect);
    setSelected(NO_SELECTION);
    clearTimeout(batchTimer.current);
    setArmedBatch(false);
    disarmRowDelete();
  };

  const renderGroup = (label: string, items: SessionSummaryView[]) =>
    items.length ? (
      <>
        <div className="session-group">{label}</div>
        {items.map((session) => {
          // 已被占用（运行中）或当前正在查看的会话：**不显示归档 / 恢复 / 删除按钮**，
          // 复选框也禁用（宿主对这两种情况一律拒，见 controller 的 `deleteSession`）
          const locked = sessionLocked(session, currentId);
          // 分支（fork）会话：**和普通会话同级**（用户 2026-09-19 口径，不再缩进）——
          // 它继承源会话的标题，所以靠标题前缀「分支: 」区分，不靠缩进。
          const forked = session.parentSessionId !== undefined;
          const title = session.title || texts.untitled;
          return (
            <div
              key={session.id}
              className={`session-item${session.id === currentId ? " is-current" : ""}${
                // 多选形态下勾中的行整行淡染一层：选中的是哪几条不靠那 13 设计像素的小方框
                multiSelect && selected.has(session.id) ? " is-picked" : ""
              }${
                // 运行中，或「离开时它还在生成、回来时已经完毕」：标题显示蓝色（.is-highlight）
                session.running || session.unread ? " is-highlight" : ""
              }`}
            >
              {/* 多选形态：行首一颗复选框。整行本身就是热区（下面那个按钮的 onClick），
                  这颗是**状态指示**——「全选」之后要能一眼看出勾了哪些。包在 label 里，
                  直接点这颗小方框同样算勾选 */}
              {multiSelect ? (
                <label
                  className={`session-item-check${locked ? " is-locked" : ""}`}
                  title={locked ? texts.selectLocked : texts.selectSession(title)}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(session.id)}
                    disabled={locked}
                    // 无障碍名始终报**是哪一条**（禁用的那一行也要说清自己是谁，
                    // 「不可选择」那半句已经在禁用位与 title 里了）
                    aria-label={texts.selectSession(title)}
                    onChange={() => changeSelection(toggleSelection(selected, session.id))}
                  />
                </label>
              ) : null}
              <button
                className="session-item-main"
                onClick={() => {
                  // 多选形态下点行 = 勾选 / 取消勾选（不打开会话，也不关抽屉）：
                  // 这个形态是进来做批量操作的，误触打开一条会话会把刚挑的一半选择带走
                  if (multiSelect) {
                    if (!locked) changeSelection(toggleSelection(selected, session.id));
                    return;
                  }
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
              <span className="session-item-actions">
                {/* 复制会话 ID：**与 locked 无关**，当前会话与运行中的会话同样要有
                    这颗按钮（用户 2026-10-01 口径），位置固定在归档按钮左边。 */}
                <IconCopyButton text={session.id} title={texts.copySessionId} />
                {locked ? null : (
                  <>
                    {/* 归档视图里这颗是**恢复**：同一个位置、同一套行为，只把方向反过来
                        （用户 2026-10-15 口径：归档列表复用同一套逻辑） */}
                    <button
                      className="icon-btn"
                      title={archived ? texts.unarchive : texts.archive}
                      onClick={() => {
                        if (archived) post({ type: "unarchiveSession", sessionId: session.id });
                        else post({ type: "archiveSession", sessionId: session.id });
                      }}
                    >
                      {archived ? <IconUnarchive size={13} /> : <IconArchive size={13} />}
                    </button>
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
                  </>
                )}
              </span>
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
          {/* 多选形态开关（用户 2026-10-15 口径：在归档切换按钮**左边**，与它同一套
              切换制——点一下进多选，再点一下退出）。进出都会清掉选择集与确认态 */}
          <button
            className={`icon-btn${multiSelect ? " is-active" : ""}`}
            title={multiSelect ? texts.multiSelectExit : texts.multiSelect}
            aria-pressed={multiSelect}
            onClick={toggleMultiSelect}
          >
            <IconMultiSelect size={14} />
          </button>
          <button
            className={`icon-btn${archived ? " is-active" : ""}`}
            title={texts.archiveList}
            onClick={switchView}
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
        {/* 批量工具条：**只在多选形态里出现**（平时抽屉就是一张干净的历史列表）。
            没有选中项时两颗动作按钮禁用；归档视图里那一颗是**恢复**，删除两边一致
            （都要二次点击确认）。二次确认期间「全选」让位——那几秒里能做的就是确认或
            改选择（改选择即自动作废确认），把位置留给确认文案，否则窄侧栏下它会先被截断。 */}
        {multiSelect ? (
          <div className="drawer-batch">
            {armed ? null : (
              <button
                className="btn btn-ghost drawer-batch-all"
                title={allChecked ? texts.selectNone : texts.selectAll}
                disabled={selectableIds.length === 0}
                onClick={toggleAll}
              >
                {allChecked ? texts.selectNone : texts.selectAll}
              </button>
            )}
            {selectedCount > 0 || armed ? (
              <span
                className={`drawer-batch-count${armed ? " is-danger" : ""}`}
                aria-live="polite"
              >
                {armed
                  ? texts.deleteSelectedConfirm(selectedCount)
                  : texts.selectedCount(selectedCount)}
              </span>
            ) : null}
            <span className="spacer" style={{ flex: 1 }} />
            <button
              className="btn drawer-batch-action"
              title={archived ? texts.unarchive : texts.archive}
              disabled={selectedCount === 0}
              onClick={archived ? restoreSelected : archiveSelected}
            >
              {archived ? texts.batchUnarchive : texts.batchArchive}
            </button>
            <button
              className={`btn drawer-batch-action drawer-batch-delete${armed ? " is-danger" : ""}`}
              title={armed ? texts.deleteSelectedConfirm(selectedCount) : texts.deleteSession}
              disabled={selectedCount === 0}
              onClick={deleteSelected}
            >
              {texts.batchDelete}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
