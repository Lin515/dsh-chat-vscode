import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ChatState } from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import { post, subscribe } from "./bridge";
import { Composer } from "./components/Composer";
import { HistoryPanel } from "./components/History";
import { Message } from "./components/Message";
import { JobsPanel, SettingsPanel, SubagentTranscriptPanel, SubagentsPanel, TrajectoryPanel } from "./components/Panels";
import { Spinner, hasSelectionInside } from "./components/primitives";
import { AppState, useAppState, type PanelKind } from "./state";
import { pendingInteractionOf } from "./pendingInteraction";
import {
  IconAgents,
  IconHistory,
  IconJobs,
  IconKey,
  IconOpenInEditor,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrajectory,
} from "./icons";
import { TextsContext, dictionaryFor, normalizeLocale, resolveText, useTexts } from "./texts";

/**
 * 顶部只有一排图标按钮——Continue 的聊天页没有传统工具栏，
 * 这里保留最少的入口：新建、历史、子代理、后台任务、在编辑器中打开、设置。
 */
function Header({
  state,
  dispatch,
}: {
  state: AppState;
  dispatch: (action: HostToWebview | { type: "ui/setPanel"; panel: PanelKind }) => void;
}) {
  const texts = useTexts();

  const toggle = (panel: PanelKind, request?: () => void) => {
    const next = state.panel === panel ? "none" : panel;
    if (next !== "none") request?.();
    dispatch({ type: "ui/setPanel", panel: next });
  };

  return (
    <div className="header">
      <span className="header-brand" title="DeepSeek Harness">
        <BrandMark />
      </span>
      {/* 侧栏容器名已经是「DSH Chat」，这里只放会话名，不再重复产品名 */}
      <span className="header-title">{state.session?.title || texts.untitled}</span>
      <span className="header-spacer" />
      <button className="icon-btn" title={texts.newChat} onClick={() => post({ type: "newSession" })}>
        <IconPlus size={15} />
      </button>
      <button
        className={`icon-btn${state.panel === "history" ? " is-active" : ""}`}
        title={texts.history}
        onClick={() => toggle("history", () => post({ type: "listSessions" }))}
      >
        <IconHistory size={15} />
      </button>
      <button
        data-mini="hide"
        className={`icon-btn${state.panel === "subagents" ? " is-active" : ""}`}
        title={texts.subagents}
        onClick={() => toggle("subagents", () => post({ type: "listSubagents" }))}
      >
        <IconAgents size={15} />
      </button>
      <button
        data-mini="hide"
        className={`icon-btn${state.panel === "jobs" ? " is-active" : ""}`}
        title={texts.jobs}
        onClick={() => toggle("jobs", () => post({ type: "listJobs" }))}
      >
        <IconJobs size={15} />
      </button>
      <button
        data-mini="hide"
        className={`icon-btn${state.panel === "trajectory" ? " is-active" : ""}`}
        title={texts.trajectory}
        onClick={() => toggle("trajectory")}
      >
        <IconTrajectory size={15} />
      </button>
      <button
        data-mini="hide"
        className="icon-btn"
        title={texts.openInEditor}
        onClick={() => post({ type: "openInEditor" })}
      >
        <IconOpenInEditor size={15} />
      </button>
      <button
        data-mini="hide"
        className={`icon-btn${state.panel === "settings" ? " is-active" : ""}`}
        title={texts.settingsTitle}
        onClick={() => toggle("settings", () => post({ type: "describeSettings" }))}
      >
        <IconSettings size={15} />
      </button>
    </div>
  );
}

function BrandMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.4A.6.6 0 0 1 5 18.9V16h-.5A.5.5 0 0 1 4 15.5v-10Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 6.2l1.05 2.35L15.4 9.6l-2.35 1.05L12 13l-1.05-2.35L8.6 9.6l2.35-1.05L12 6.2Z" fill="currentColor" />
    </svg>
  );
}

function ConnectionBar({ state }: { state: ChatState }) {
  const texts = useTexts();
  if (state.connection === "ready") return null;
  const isError = state.connection === "error";
  return (
    <div className={`conn-bar${isError ? " is-error" : ""}`}>
      {state.connection === "connecting" ? <Spinner size={11} /> : null}
      <span>
        {isError
          ? resolveText(state.connectionDetail ?? texts.connectionFailed, texts)
          : `${texts.connecting}${state.serverUrl ? ` ${state.serverUrl}` : ""}`}
      </span>
      <span className="spacer" />
      {isError && state.needsToken ? (
        <button className="btn" onClick={() => post({ type: "setToken" })}>
          <IconKey size={12} /> {texts.enterToken}
        </button>
      ) : null}
      {isError ? (
        <button className="btn" onClick={() => post({ type: "restartServer" })}>
          <IconRefresh size={12} /> {texts.restartServer}
        </button>
      ) : null}
    </div>
  );
}

/** 空态：只留一行提示，不要问候语与起始卡片。 */
function EmptyState() {
  const texts = useTexts();
  return (
    <div className="empty">
      <div className="empty-hint">{texts.emptyHint}</div>
    </div>
  );
}

/** 轻提示的停留时长（毫秒）。 */
const NOTICE_MS = 4000;

/**
 * 「滚到顶就自动取更早的历史」的触发距离（px）。
 *
 * 不写成 0：滚动条贴到最顶上才算的话，稍快一点的滚轮/拖动会一下子冲到 0 再被
 * 浏览器回弹，用户得停在极窄的一条里才触发。几十像素是「已经在看开头了」。
 */
const HISTORY_TOP_PX = 64;

/**
 * 滚动到接近顶部时**自动加载**更早的历史（`session/page`）。
 *
 * 此前只有一枚「加载更早的消息」按钮：跟随窗口只带 60 条，用户想往回看就得先
 * 意识到「上面还有东西」并准确点到按钮（用户 2026-09-14 要求按滚动条位置自动加载）。
 *
 * 分工（2026-09-15 定稿）：
 * - **连取由宿主驱动**：界面只发一次 `loadMore`，宿主一页一页往前取，直到取到
 *   用户的上一条消息（一轮的开头）或没有更早的了——「到没到一轮的开头」「这一页
 *   有没有带来新事件」只有宿主有真凭据（见 `dsh/historyPaging.ts` 的注释：
 *   界面侧拿「首条消息 id 变没变」猜，会在旧事件只是把第一条助手消息补长时提前收手）；
 * - **界面只管两件事**：把视口钉住（每落一页就补一次高度差），以及按钮的加载态
 *   （读宿主发的 `historyLoading`）。
 *
 * 视口钉住的细节：更早的内容插在**上面**，浏览器保持 scrollTop 不变，于是正文整体
 * 下滑。加载前记下 scrollHeight，每落一页把差值补回 scrollTop——按高度差补，**不**按
 * 「首条消息变没变」判断（同一条消息被补长时首条 id 不变，但上面的内容确实变多了）。
 * 手动按钮走同一个入口。
 */
function useHistoryPaging(scrollRef: React.RefObject<HTMLDivElement>, state: AppState) {
  /** 本次加载开始时的内容高度（每落一页后更新成新高度）。 */
  const height = useRef<number | null>(null);
  // 监听器只注册一次（流式期间每次渲染都重挂/摘监听器是白烧）
  const latest = useRef(state);
  latest.current = state;

  const loadEarlier = useCallback(() => {
    const el = scrollRef.current;
    const current = latest.current;
    if (!el || !current.hasMoreHistory) return;
    // 已经在取（宿主说了算）：滚动事件一秒来几十个也不会重复发
    if (current.historyLoading) return;
    height.current = el.scrollHeight;
    post({ type: "loadMore" });
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop > HISTORY_TOP_PX) return;
      const current = latest.current;
      if (current.historyLoading || !current.hasMoreHistory || current.running) return;
      loadEarlier();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, loadEarlier]);

  // 每落一页：把视口钉回加载前那一行；取完（宿主说落定）就丢掉锚点
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && height.current !== null) {
      el.scrollTop += el.scrollHeight - height.current;
      height.current = el.scrollHeight;
    }
    if (!state.historyLoading) height.current = null;
  }, [state.messages, state.historyLoading, scrollRef]);

  return { loadEarlier, loading: state.historyLoading === true };
}

/**
 * 一次性轻提示条（复制成功、设置已保存、图片被跳过…）。
 *
 * 宿主用语言中立的 `@key:arg` 传文案，这里按当前语言翻译（`resolveText`）。
 * 同一条提示靠 `id` 变化重新计时：连点两次复制也能再闪一次。
 */
function NoticeBar({
  notice,
  onDismiss,
}: {
  notice: ChatState["notice"];
  onDismiss: () => void;
}) {
  const texts = useTexts();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onDismiss, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice?.id, onDismiss]);

  if (!notice) return null;
  const cls =
    notice.level === "error"
      ? "notice notice-error"
      : notice.level === "warn"
        ? "notice notice-warn"
        : "notice";
  return (
    <div className="notice-bar">
      <div className={cls}>{resolveText(notice.text, texts)}</div>
    </div>
  );
}

/**
 * 自动滚动：仅当用户本来就贴在底部时才跟随，否则不打断阅读。
 *
 * 贴底判定只由「scrollTop 真正变小」（用户上滑）推翻：贴底时内容先长高、
 * 滚动事件后结算会让距离超过阈值，但那不是用户移动，不能据此脱离跟随。
 * 内容高度变化（新行、工具/思考展开、流式文本、图片加载）由 ResizeObserver
 * 主动跟随，不依赖滚动事件时序。
 */
function useAutoScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    // 初始贴底按实际位置定（内容不足一屏即贴底）
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    lastTopRef.current = el.scrollTop;

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance < 40) {
        stickRef.current = true;
      } else if (el.scrollTop < lastTopRef.current) {
        stickRef.current = false; // 用户真的上滑了
      }
      lastTopRef.current = el.scrollTop;
    };
    const pin = () => {
      // 用户正在对话区划选时不要跟着滚：会把选区内容推出视野
      if (stickRef.current && !hasSelectionInside(el)) el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  return { scrollRef, contentRef };
}

export function App() {
  const { state, dispatch } = useAppState();
  const { scrollRef, contentRef } = useAutoScroll();
  // 滚到顶附近自动取更早的历史；手动按钮走同一个入口（取到轮次边界为止）
  const { loadEarlier, loading: loadingEarlier } = useHistoryPaging(scrollRef, state);
  // 迷你模式：.app 宽度 < 220px 时收成图标条（滞回 ≥232 恢复），由 Composer 测宽后同步到这里
  const appRef = useRef<HTMLDivElement>(null);
  const [mini, setMini] = useState(false);
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const check = () => setMini((prev) => (prev ? el.clientWidth < 232 : el.clientWidth < 220));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 文案跟随 VS Code 显示语言（或 `dshChat.language` 的固定选择）；
  // 词典随语言切换而重建，界面即时更新
  const texts = dictionaryFor(normalizeLocale(state.locale));
  // 字号：只写一个 CSS 变量，整套文本尺度从它派生（tokens.css）。
  // 0（auto）时不下发像素值，`--font-size` 继续取 VS Code 注入的 `--vscode-font-size`。
  const fontStyle = state.fontSizePx
    ? ({ "--font-size": `${state.fontSizePx}px` } as CSSProperties)
    : undefined;
  const closePanel = () => dispatch({ type: "ui/setPanel", panel: "none" });

  // 下面的监听只在挂载时注册一次，running 用 ref 读，避免闭包里是首帧的旧值
  const runningRef = useRef(state.running);
  useEffect(() => {
    runningRef.current = state.running;
  }, [state.running]);

  useEffect(() => {
    const unsubscribe = subscribe(dispatch as (message: HostToWebview) => void);
    post({ type: "ready" });
    // ESC 优先级链的兜底层：候选弹层（textarea 层）> 浮层（document 层）> 停止
    // 生成（window 层）。上层消费后会 stopPropagation，不会走到这里
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && runningRef.current) post({ type: "stop" });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onKey);
    };
    // 只在挂载时订阅一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TextsContext.Provider value={texts}>
      <div ref={appRef} className={`app${mini ? " is-mini" : ""}`} style={fontStyle}>
        <Header state={state} dispatch={dispatch} />
        <ConnectionBar state={state} />
        <NoticeBar
          notice={state.notice}
          onDismiss={() => dispatch({ type: "ui/dismissNotice" })}
        />

        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-list" ref={contentRef}>
            {state.messages.length === 0 ? (
              <EmptyState />
            ) : (
              <>
                {/* 「加载更早」：跟随窗口只带 60 条，更早的内容从没进过客户端。
                    按钮只在服务端说「还有更早的」时出现——空按钮比没有按钮更烦人。
                    滚到顶会自动取，这个按钮是同一个入口；**取的过程中**它自己变成
                    「正在加载更早消息…」的不可点状态（连取多页时一直保持），
                    这样「点了没反应」与「还在取」一眼可分。 */}
                {state.hasMoreHistory ? (
                  <button
                    className="history-more"
                    disabled={state.running || loadingEarlier}
                    title={
                      loadingEarlier
                        ? texts.historyLoading
                        : state.running
                          ? texts.historyBusy
                          : texts.historyMore
                    }
                    onClick={() => loadEarlier()}
                  >
                    {loadingEarlier ? texts.historyLoading : texts.historyMore}
                  </button>
                ) : null}
                {state.messages.map((message, index) => (
                  <Message
                    key={message.id}
                    message={message}
                    diffLayout={state.diffLayout}
                    fileKinds={state.fileKinds}
                    questionBatch={state.questionBatch}
                    // 只有非最后一条（= 不是正在跑的那一轮）才能作为分支锚点
                    canBranch={!state.running || index < state.messages.length - 1}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {state.todos.length ? (
          <div className="todos">
            {state.todos.map((todo) => (
              <div
                key={todo.id}
                className={`todo-item${todo.status === "completed" ? " is-completed" : ""}`}
              >
                <span className="todo-glyph">
                  <span
                    className={`dot ${
                      todo.status === "completed" ? "dot-ok" : todo.status === "in_progress" ? "dot-running" : ""
                    }`}
                  />
                </span>
                <span className="todo-content">{todo.content}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* 待处理的审批 / 提问**接管输入区**（官方把两者注册进 `conversation.composer` 槽）：
            卡片永远在视野里，界面看起来就是「在等你回答」；已经答过的仍留在对话流里当记录
            （见 Message.tsx 里对 waiting 段的跳过）。 */}
        <Composer
          state={state}
          pending={pendingInteractionOf(state.messages)}
          onDraft={(text) => dispatch({ type: "ui/setDraft", text })}
        />

        {state.panel === "history" ? (
          <HistoryPanel
            sessions={state.sessions}
            archivedSessions={state.archivedSessions}
            currentId={state.session?.id}
            onClose={closePanel}
          />
        ) : null}

        {state.panel === "subagents" ? (
          <SubagentsPanel
            entries={state.subagentEntries}
            onClose={closePanel}
            onOpen={(id) => {
              post({ type: "openSubagent", id });
              dispatch({ type: "ui/setPanel", panel: "subagent" });
            }}
          />
        ) : null}

        {state.panel === "subagent" && state.subagent ? (
          <SubagentTranscriptPanel
            id={state.subagent.id}
            messages={state.subagent.messages}
            onClose={closePanel}
            onBack={() => dispatch({ type: "ui/setPanel", panel: "subagents" })}
          />
        ) : null}

        {state.panel === "jobs" ? <JobsPanel jobs={state.jobs} onClose={closePanel} /> : null}

        {state.panel === "trajectory" ? (
          <TrajectoryPanel
            tools={state.trajectory}
            diffLayout={state.diffLayout}
            onClose={closePanel}
          />
        ) : null}

        {state.panel === "settings" ? (
          <SettingsPanel
            sections={state.settingsSections}
            writable={state.settingsWritable}
            loaded={state.settingsLoaded}
            onClose={closePanel}
          />
        ) : null}
      </div>
    </TextsContext.Provider>
  );
}
