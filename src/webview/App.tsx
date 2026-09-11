import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatState } from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import { post, subscribe } from "./bridge";
import { Composer } from "./components/Composer";
import { HistoryPanel } from "./components/History";
import { Message } from "./components/Message";
import { JobsPanel, SettingsPanel, SubagentTranscriptPanel, SubagentsPanel, TrajectoryPanel } from "./components/Panels";
import { Spinner } from "./components/primitives";
import { AppState, useAppState, type PanelKind } from "./state";
import {
  IconAgents,
  IconHistory,
  IconJobs,
  IconOpenInEditor,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrajectory,
} from "./icons";
import { TextsContext, dictionaryFor, normalizeLocale, useTexts } from "./texts";

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
          ? state.connectionDetail ?? texts.connectionFailed
          : `${texts.connecting}${state.serverUrl ? ` ${state.serverUrl}` : ""}`}
      </span>
      <span className="spacer" />
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

/**
 * 自动滚动：仅当用户本来就贴在底部时才跟随，否则不打断阅读。
 */
function useAutoScroll(dependency: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);

  return scrollRef;
}

export function App() {
  const { state, dispatch } = useAppState();
  const scrollRef = useAutoScroll(state.messages);
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
  // 文案跟随 VS Code 显示语言；词典随语言切换而重建，界面即时更新
  const texts = dictionaryFor(normalizeLocale(state.locale));
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
      <div ref={appRef} className={`app${mini ? " is-mini" : ""}`}>
        <Header state={state} dispatch={dispatch} />
        <ConnectionBar state={state} />

        <div className="chat-scroll" ref={scrollRef}>
          {state.messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="chat-list">
              {state.messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  showUsageStats={state.showUsageStats !== false}
                />
              ))}
            </div>
          )}
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

        <Composer state={state} onDraft={(text) => dispatch({ type: "ui/setDraft", text })} />

        {state.panel === "history" ? (
          <HistoryPanel
            sessions={state.sessions}
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
          <TrajectoryPanel tools={state.trajectory} onClose={closePanel} />
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
