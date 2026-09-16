import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ChatState } from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import { post, subscribe } from "./bridge";
import { Composer } from "./components/Composer";
import { HistoryPanel } from "./components/History";
import { Message } from "./components/Message";
import { JobsPanel, SubagentTranscriptPanel, SubagentsPanel } from "./components/Panels";
import { TrajectoryView } from "./components/Trajectory";
import { Spinner, hasSelectionInside } from "./components/primitives";
import { AppState, useAppState, type PanelKind } from "./state";
import { pendingInteractionOf } from "./pendingInteraction";
import {
  IconAgents,
  IconChat,
  IconGlobe,
  IconHistory,
  IconJobs,
  IconKey,
  IconOpenInEditor,
  IconPlus,
  IconRefresh,
  IconTrajectory,
} from "./icons";
import { TextsContext, dictionaryFor, normalizeLocale, resolveText, useTexts } from "./texts";

/**
 * 顶部只有一排图标按钮——Continue 的聊天页没有传统工具栏，
 * 这里保留最少的入口：新建、历史、子代理、后台任务、在编辑器中打开、
 * 在浏览器中打开（官方 Web UI）。
 *
 * 这里曾经还有一颗**设置**按钮（自绘的 DSH 服务端设置面板）。它被删掉了：
 * Web 端的设置页是各功能插件自绘的页面组合（`settings.section` 槽），没有任何
 * 数据契约可以自绘复刻，而通用 schema 表单只能展示裸字段名。现在 Web 专属设置
 * 走「在浏览器中打开」，扩展真正读取的设置（模型、`busyEnter`…）另有入口。
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
        // 轨迹是**整页**视图（不是抽屉），这颗按钮就是进出它的唯一开关：
        // 会话视图下它是「轨迹」图标，切过去之后变成「会话」图标（点回来）。
        // 它**不显示选中态**（用户 2026-09-15 口径）：轨迹视图下这颗按钮上画的是
        // 「会话」图标，选中态属于**当前显示的那个视图**，而当前显示的是轨迹——
        // 图标与选中态指的必须是同一件事，否则看着像「我现在在会话页」。
        // 迷你模式下别的按钮都收起来，唯独这颗在轨迹视图里必须留着——
        // 否则把侧栏拖窄之后就出不来了（`data-mini` 只在不显示轨迹时生效）。
        data-mini={state.panel === "trajectory" ? undefined : "hide"}
        className="icon-btn"
        title={state.panel === "trajectory" ? texts.backToChat : texts.trajectory}
        onClick={() => toggle("trajectory", () => post({ type: "listTrajectory" }))}
      >
        {state.panel === "trajectory" ? <IconChat size={15} /> : <IconTrajectory size={15} />}
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
        className="icon-btn"
        title={texts.openInBrowser}
        onClick={() => post({ type: "openInBrowser" })}
      >
        <IconGlobe size={15} />
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

/**
 * 连接条：**未就绪时**显示在所有内容上方（就绪时不占位置）。
 *
 * 三种"没好"的状态要给出**不同的下一步**（用户 2026-09-14 口径，2026-09-15 微调）：
 * - `stopped`：后台没在跑（关掉 `dshChat.autoStart` 的常态）→ 「启动服务器」；
 *   外部服务器不由本扩展启动 → 「尝试连接」；
 * - `connecting`：正在连（首轮连接、掉线后的重连循环、外部地址的等待都算）→ 「停止连接」；
 *   这个按钮**绑 `connecting` 本身，不绑 `reconnecting`**——只要在连接就得能停（用户口径）；
 * - `error`：连不上 → 原因 + 「尝试连接」（+ 外部模式的「输入令牌」、内部模式的「重启服务器」）。
 *
 * 三种状态下都留一个「查看日志」：失败原因写进扩展的输出通道，用户得有个入口去看。
 */
function ConnectionBar({ state }: { state: ChatState }) {
  const texts = useTexts();
  if (state.connection === "ready") return null;
  const isError = state.connection === "error";
  const isStopped = state.connection === "stopped";
  const isConnecting = state.connection === "connecting";
  const external = state.externalServer === true;
  // 详情优先：`stopped` 也可能是"用户按了停止连接"，那时条上的原因是上一轮的失败原因
  const detail = state.connectionDetail ? resolveText(state.connectionDetail, texts) : undefined;
  const text = isError
    ? (detail ?? texts.connectionFailed)
    : isStopped
      ? (detail ?? (state.serverRunning || external ? texts.reconnectStopped : texts.serverNotRunning))
      : state.reconnecting
        ? (detail && detail !== resolveText("@connectionLost", texts) ? detail : texts.reconnecting)
        : `${texts.connecting}${state.serverUrl ? ` ${state.serverUrl}` : ""}`;
  return (
    <div className={`conn-bar${isError ? " is-error" : ""}${isStopped ? " is-stopped" : ""}`}>
      {isConnecting ? <Spinner size={11} /> : null}
      <span className="conn-text" title={text}>
        {text}
      </span>
      <span className="spacer" />
      {state.needsToken ? (
        <button className="btn" onClick={() => post({ type: "setToken" })}>
          <IconKey size={12} /> {texts.enterToken}
        </button>
      ) : null}
      {/* 后台没在跑（且不是外部服务器）→ 用户显式拉起一套 */}
      {isStopped && !state.serverRunning && !external ? (
        <button className="btn btn-primary" onClick={() => post({ type: "startServer" })}>
          <IconPlus size={12} /> {texts.startServer}
        </button>
      ) : null}
      {/* 连不上 / 已停止但后台还在 → 只接上已经在跑的那一套 */}
      {isError || (isStopped && (state.serverRunning || external)) ? (
        <button className="btn" onClick={() => post({ type: "reconnectNow" })}>
          <IconRefresh size={12} /> {texts.reconnect}
        </button>
      ) : null}
      {/* 正在连接：必须能停（重连没有总超时，首轮连接也可能卡在等就绪上） */}
      {isConnecting ? (
        <button className="btn" onClick={() => post({ type: "stopReconnect" })}>
          {texts.stopReconnect}
        </button>
      ) : null}
      {/* 内部后台连不上时，「重启服务器」是最有效的一招（守护进程重起 dsh） */}
      {isError && !external ? (
        <button className="btn" onClick={() => post({ type: "restartServer" })}>
          <IconRefresh size={12} /> {texts.restartServer}
        </button>
      ) : null}
      {/* 查看日志：**连接条上恒显**（用户 2026-09-15 口径）——上面每一种状态都可能是
          "连不上但说不清"，用户得随时有个入口去看扩展的输出通道 */}
      <button className="btn btn-ghost" data-mini="hide" onClick={() => post({ type: "showLogs" })}>
        {texts.showLogs}
      </button>
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
 * 分工（2026-09-14 定稿）：
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
function useHistoryPaging(scrollRef: React.RefObject<HTMLDivElement>, state: AppState, active: boolean) {
  /** 本次加载开始时的内容高度（每落一页后更新成新高度）。 */
  const height = useRef<number | null>(null);
  // 监听器只注册一次（流式期间每次渲染都重挂/摘监听器是白烧）
  const latest = useRef(state);
  latest.current = state;

  const loadEarlier = useCallback(() => {
    const current = latest.current;
    if (!current.hasMoreHistory) return;
    // 已经在取（宿主说了算）：滚动事件一秒来几十个也不会重复发
    if (current.historyLoading) return;
    // 视口锚点只有会话页在的时候才有得记：轨迹视图里聊天区是卸载的
    // （入口仍然要能用——那就是轨迹时间线左端那个 `…`）
    const el = scrollRef.current;
    height.current = el ? el.scrollHeight : null;
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
    // `active`：会话页被轨迹视图顶掉又回来时，元素是新的，监听必须重新挂上
  }, [scrollRef, loadEarlier, active]);

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
 * 展开某个节点之后，多久内的高度变化算「用户正在查看」（ms）。
 *
 * 展开 → 重排 → ResizeObserver 回调都在同一帧里，几毫秒的事；给足余量是为了覆盖
 * 卡顿，以及「一次展开触发多处高度变化」（展开的节点里有自己会长高的卡片时，回调
 * 会来好几次）。
 */
const EXPAND_READ_GRACE_MS = 500;

/**
 * 自动滚动：仅当用户本来就贴在底部时才跟随，否则不打断阅读。
 *
 * 贴底判定只由「scrollTop 真正变小」（用户上滑）推翻：贴底时内容先长高、
 * 滚动事件后结算会让距离超过阈值，但那不是用户移动，不能据此脱离跟随。
 * 内容高度变化（新行、流式文本、图片加载）由 ResizeObserver 主动跟随，
 * 不依赖滚动事件时序。
 *
 * **展开某个节点 = 用户要看内容**（用户 2026-09-16 口径）：
 *
 * 1. 展开那一次高度变化**不跟随**——否则贴底时跟随立刻把 scrollTop 拉回底部，刚展开
 *    的那块被顶到视野上方（用户报的「展开工具调用后向上挤」）；
 * 2. 同时**取消贴底**——他正在看展开的内容，生成中的新输出不该把他强行拽回底部；
 *    想恢复跟随就滚回底部（`onScroll` 会重新贴上）。
 *
 * 判据是「刚点了某个**当前还没展开**的 `[aria-expanded]` 控件」：工具行、思考行、折叠
 * 按钮、注入行、问卷卡…全是这种控件，不必各自接线。**收起**（`aria-expanded` 已经是
 * `"true"`）不算「要看内容」，复制 / 分支 / 划选这类不改高度的点击也不影响跟随。
 */
function useAutoScroll(active: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  /** 最近一次「展开某个节点」的时刻（`performance.now()`；0 = 还没展开过）。 */
  const expandedAtRef = useRef(0);
  /** 是否已经挂过一次：用来区分「首次挂载」与「从轨迹视图回来」。 */
  const attachedRef = useRef(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    if (attachedRef.current) {
      // 从轨迹视图回来：这是一个**新元素**，旧元素连同滚动位置一起没了
      // （新元素 scrollTop 一律是 0，不补一下就会把用户丢回会话开头、
      // 而且贴底状态也没了）。按离开前的状态复原：贴着底就跟到底，
      // 否则回到原来的位置。
      el.scrollTop = stickRef.current
        ? el.scrollHeight
        : Math.min(lastTopRef.current, Math.max(0, el.scrollHeight - el.clientHeight));
    } else {
      attachedRef.current = true;
      // 初始贴底按实际位置定（内容不足一屏即贴底）
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      lastTopRef.current = el.scrollTop;
    }

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance < 40) {
        stickRef.current = true;
      } else if (el.scrollTop < lastTopRef.current) {
        stickRef.current = false; // 用户真的上滑了
      }
      lastTopRef.current = el.scrollTop;
    };
    const onTranscriptClick = (event: MouseEvent) => {
      const control = (event.target as Element | null)?.closest?.("[aria-expanded]");
      // 只有**展开**（当前还不是展开态）才算「用户在查看内容」；收起 / 复制 / 分支
      // / 点链接都不改变跟随。
      if (!control || control.getAttribute("aria-expanded") === "true") return;
      expandedAtRef.current = performance.now();
    };
    const pin = () => {
      // 用户刚展开节点在查看：这次高度变化是他造成的（不跟随，免得把展开的那块顶上去），
      // 并且**取消贴底**——后续生成的新输出也停在他的视野之外，不再强行拽回底部。
      if (performance.now() - expandedAtRef.current < EXPAND_READ_GRACE_MS) {
        stickRef.current = false;
        return;
      }
      // 用户正在对话区划选时不要跟着滚：会把选区内容推出视野
      if (stickRef.current && !hasSelectionInside(el)) el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    el.addEventListener("scroll", onScroll, { passive: true });
    // 用**捕获**：React 的 onClick 挂在根节点上（冒泡阶段），这里要抢在它更新状态、
    // 重排之前记下时刻
    el.addEventListener("click", onTranscriptClick, true);
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("click", onTranscriptClick, true);
    };
    // `active`：轨迹视图会把会话页整块卸载（元素换了一个），回来时必须重挂
  }, [active]);

  return { scrollRef, contentRef };
}

export function App() {
  const { state, dispatch } = useAppState();
  // 会话页是否在场：轨迹视图下它整块卸载，两个滚动 hook 都要能重挂
  const chatActive = state.panel !== "trajectory";
  const { scrollRef, contentRef } = useAutoScroll(chatActive);
  // 滚到顶附近自动取更早的历史；手动按钮走同一个入口（取到轮次边界为止）
  const { loadEarlier, loading: loadingEarlier } = useHistoryPaging(scrollRef, state, chatActive);
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

  // 轨迹视图开着时的刷新节奏：**运行中每 3 秒取一次**，停下后再取一次收尾。
  //
  // 官方的轨迹是跟着事件流增量长的（流式中的助手行、刚结算的工具行都会实时出现）；
  // 本扩展的账本是宿主按需折好整份下发的，所以用「视图开着 + 运行中」这个条件轮询——
  // 视图关着时一个请求都不发（整份模型几百行，不值得白推）。
  //
  // 会话 id 也进依赖：切会话 / 新建时宿主推的是**整份快照**，而轨迹模型不在快照里
  // （只有 `listTrajectory` 现折），不跟着重取就会一直显示上一个会话的账本。
  const sessionId = state.session?.id;
  useEffect(() => {
    if (state.panel !== "trajectory") return;
    if (!state.running) {
      post({ type: "listTrajectory" });
      return;
    }
    const timer = setInterval(() => post({ type: "listTrajectory" }), 3000);
    return () => clearInterval(timer);
  }, [state.panel, state.running, sessionId]);

  // 轨迹里的「加载更早」与会话页**共用同一条链路**（都发 `loadMore`，宿主一次取到底、
  // 逐页回填消息）。但宿主只回填会话侧，不会顺手重推账本，所以取完
  // （`historyLoading` 从 true 落回 false）由界面自己再要一份账本——
  // 这就是「点轨迹的『加载更早』→ 会话去取历史 → 取完轨迹自己刷新」。
  const historyWasLoading = useRef(state.historyLoading === true);
  useEffect(() => {
    const loading = state.historyLoading === true;
    const settled = historyWasLoading.current && !loading;
    historyWasLoading.current = loading;
    if (settled && state.panel === "trajectory") post({ type: "listTrajectory" });
  }, [state.historyLoading, state.panel]);

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
      <div
        ref={appRef}
        className={`app${mini ? " is-mini" : ""}${state.panel === "trajectory" ? " is-trajectory" : ""}`}
        style={fontStyle}
      >
        <Header state={state} dispatch={dispatch} />
        <ConnectionBar state={state} />
        <NoticeBar
          notice={state.notice}
          onDismiss={() => dispatch({ type: "ui/dismissNotice" })}
        />

        {/* 轨迹是**整页**视图（和官方 Web UI 一样），不是盖在会话上的抽屉：
            它顶掉的是会话页本身（消息列表 + 待办），并且**输入区也一起让位**——
            轨迹打开时就该占用整个会话窗口（用户 2026-09-16 口径：待答问卷不该一直
            占着底部，切回来时它照常还在）。
            输入区由 `.app.is-trajectory` 用「移出布局 + 隐藏」的方式让位，**不卸载**：
            待答问卷里填了一半的选择是 `QuestionCard` 的本地 state，卸载就没了。
            注意两个滚动监听挂在 `chat-scroll` 上，它被卸载后必须能在回来时重挂，
            所以下面两个 hook 都吃一个 `active`（见 `useAutoScroll`）。 */}
        {state.panel === "trajectory" ? (
          <TrajectoryView
            model={state.trajectory}
            locale={state.locale}
            onLoadEarlier={() => loadEarlier()}
            loadingEarlier={loadingEarlier}
          />
        ) : (
          <>
            <div className="chat-scroll" ref={scrollRef}>
              <div className="chat-list" ref={contentRef}>
                {state.messages.length === 0 ? (
                  <EmptyState />
                ) : (
                  <>
                    {/* 「加载全部历史」：跟随窗口只带 60 条，更早的内容从没进过客户端。
                        按钮只在服务端说「还有更早的」时出现——空按钮比没有按钮更烦人。
                        滚到顶会自动取，这个按钮是同一个入口；**取的过程中**它自己变成
                        「正在加载全部历史…」的不可点状态（可能连取多页），这样
                        「点了没反应」与「还在取」一眼可分。 */}
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
          </>
        )}

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
      </div>
    </TextsContext.Provider>
  );
}
