import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ChatState } from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import { onHostFrame, post, subscribe } from "./bridge";
import { Composer } from "./components/Composer";
import { HistoryPanel } from "./components/History";
import { Message } from "./components/Message";
import { JobsPanel, SubagentTranscriptPanel, SubagentsPanel } from "./components/Panels";
import { TrajectoryView } from "./components/Trajectory";
import { Spinner } from "./components/primitives";
import { AppState, useAppState, type PanelKind } from "./state";
import { pendingInteractionOf } from "./pendingInteraction";
import { attachDroppedFiles, dragHasFiles } from "./dropAttach";
import {
  IconAgents,
  IconAttach,
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
 * 全页拖放接取：拖文件进会话页 = 添加附件。
 *
 * 之前只有输入框接 drop，拖到消息区（页面的大头）没有任何 drop 目标，浏览器走
 * 默认行为——导航到被拖的文件，在 VS Code 里表现为「文件被打开」而不是附件。
 * 现在整页都是目标：**dragover 的 preventDefault 就是「本页接受文件投放」的声明**，
 * 缺了它松手必被 VS Code 捕获；drop 统一走 `attachDroppedFiles`（字节上传，
 * 见 `dropAttach.ts`）。
 *
 * 只拦**文件**拖拽（`dragHasFiles`）：文本拖拽不 preventDefault，textarea 的
 * 原生插入照常工作。overlay 显隐用 enter/leave 计数（元素间移动会成对触发这对
 * 事件，计数不闪）；drop 后清零。监听挂在 window 上且只注册一次。
 */
function usePageFileDrop() {
  const [dragActive, setDragActive] = useState(false);
  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      depth += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragActive(false);
      attachDroppedFiles([...(event.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  return dragActive;
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
  // `onDismiss` 是父组件每次渲染新建的箭头函数（流式期间每帧都重渲染），把它写进
  // 依赖数组会让**每个 token**都重开一次计时器——提示条于是永不消失，直到这一轮
  // 生成结束（2026-09-17 全项目审计发现）。用 ref 拿最新的回调，
  // 计时只跟 `notice.id` 走：同一条提示靠 id 变化重新计时（连点两次复制也能再闪一次）。
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismissRef.current(), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice?.id]);

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
 * 自动滚动（2026-09-16 三次修订）：**不再从滚动几何里推断意愿**。
 *
 * 机制只有两条：
 *
 * 1. **意愿（`followRef`）只由输入决定**：距底超过阈值 **且** 近期有滚动手势
 *    （滚轮 / 触摸 / 键盘 / 拖滚动条）才算"用户要看上面"；位置回到距底容差内、或用户
 *    显式要最新（发消息、切会话、点胶囊）就重新贴上。
 *
 *    为什么不能省掉这一条：`scroll` 事件是**异步**派发的，处理器当场读到的 `scrollTop`
 *    可能来自**已经过去的布局**（位置被浏览器夹过），而 `scrollHeight` 来自**当前布局**
 *    ——两份不同布局的数据在同一个判断里对不上。旧实现用"`scrollTop` 变小 ⇒ 用户上滑了"
 *    来翻贴底标志，于是浏览器自己夹一下位置（生成期间任何一次"瞬态塌缩 → 恢复"的重渲染：
 *    过程折叠、中途插消息搬 DOM、消息整体替换…）就被误判成用户上滑；而一旦 `stick=false`
 *    **再没有任何东西会翻回来**，症状是"最新内容留在视野下方 + 胶囊亮着 + 永不恢复"，
 *    且**用户根本没有操作**（2026-09-16 实测复现，正是用户报的"生成中突然不贴底"，
 *    见 `test/scroll-probe.html` 的 P1）。同一类还有端口变矮（插话排队条 / 待办面板 /
 *    提示条：`scrollTop` 不变、连 `scroll` 事件都没有）。
 *
 * 2. **只要想跟，就把视口钉在底部**：任何"内容 / 端口 / 可见性可能变了"的信号都只置一个
 *    脏标记，rAF 里**幂等**重贴一次。没有"之前是否在底部"这个记忆值，因此不存在
 *    "某次判定被跳过之后永久停在错误一侧"（旧实现在展开后 500ms 内跳过所有跟随，窗口过后
 *    没有任何东西再触发判定——实测点了工具行就永久不恢复，见 P3；面板隐藏期间推帧再显示
 *    也被误判成用户上滑，见 P6）。
 *
 * 判据是"距底 ≤ `STICK_THRESHOLD_PX`"：内容不足一屏时 `dist ≤ 0`，天然算贴底，
 * `scrollTop` 赋值被浏览器夹回 0，是 no-op（用户口径里"还没出现滚动条"那种情况）。
 */
const STICK_THRESHOLD_PX = 40;
/** 手势之后多久内算"用户正在滚动"（ms）：滚轮有惯性、键盘会连发，给足余量。 */
const GESTURE_WINDOW_MS = 400;

function useAutoScroll(active: boolean, sessionId: string | undefined) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 是否跟着最新（意愿）。置假只有一条路：手势 + 确实离底。 */
  const followRef = useRef(true);
  /** "内容/端口可能变了"的脏标记：任何信号只置位，rAF 里统一处理一次。 */
  const pendingRef = useRef(true);
  /**
   * 滚轮与键盘各自记最近一次手势时刻。
   *
   * **初始值必须是 `-Infinity` 而不是 0**：`performance.now()` 在新文档里从 0 附近开始，
   * 用 0 当"还没发生过"会让页面刚加载的头 400ms 里 `now - 0 < GESTURE_WINDOW_MS` 恒真
   * ——那段时间任何一次离底都被当成"用户上滑"（探针 P1 就是这么红的）。
   */
  const wheelAtRef = useRef(-Infinity);
  const keyAtRef = useRef(-Infinity);
  /** 触摸、拖滚动条这类"有开始有结束"的手势：按住期间算活跃。 */
  const gestureActiveRef = useRef(false);
  /** 最近一次滚动位置：**只用于**从轨迹视图回来时复原阅读位置，不参与意愿判断。 */
  const lastTopRef = useRef(0);
  /** 是否已经挂过一次：用来区分「首次挂载」与「从轨迹视图回来」。 */
  const attachedRef = useRef(false);
  /** 脱贴且距底超过阈值：亮出「回到最新」胶囊。 */
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    if (attachedRef.current) {
      // 从轨迹视图回来：这是一个**新元素**，旧元素连同滚动位置一起没了
      // （新元素 scrollTop 一律是 0，不补一下就会把用户丢回会话开头）。
      // 按意愿复原：贴着底就跟到底，否则回到原来的阅读位置。
      el.scrollTop = followRef.current
        ? el.scrollHeight
        : Math.min(lastTopRef.current, Math.max(0, el.scrollHeight - el.clientHeight));
    } else {
      attachedRef.current = true;
      lastTopRef.current = el.scrollTop;
    }

    const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const gestureRecently = () =>
      gestureActiveRef.current ||
      performance.now() - wheelAtRef.current < GESTURE_WINDOW_MS ||
      performance.now() - keyAtRef.current < GESTURE_WINDOW_MS;

    /** 想跟就把视口钉到底（幂等）；不跟就只按实测距离同步胶囊。 */
    const settle = () => {
      const dist = gap();
      if (followRef.current) {
        if (dist > 0) el.scrollTop = el.scrollHeight;
        setShowJump(false);
      } else {
        setShowJump(dist > STICK_THRESHOLD_PX);
      }
    };
    /**
     * 置脏 + 合并到下一帧。
     *
     * 所有信号（宿主帧、内容 RO、端口 RO、可见性）都只走这里：rAF 在绘制之前跑，
     * 钉底不会闪；同一帧的多个信号合并成一次判定。
     */
    let scheduled = false;
    const schedule = () => {
      pendingRef.current = true;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!pendingRef.current) return;
        pendingRef.current = false;
        settle();
      });
    };

    const onScroll = () => {
      lastTopRef.current = el.scrollTop;
      const dist = gap();
      if (dist < STICK_THRESHOLD_PX) {
        followRef.current = true; // 回到（近）底部即恢复跟随
      } else if (gestureRecently()) {
        // **只有**"用户手势 + 确实离底"才算要看上面。没有手势的离底（位置被浏览器夹走、
        // 重排、端口变矮）一律按布局事故处理：不动意愿，下一次 settle 把它钉回底部。
        followRef.current = false;
      }
      schedule();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) wheelAtRef.current = performance.now();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "PageUp" || event.key === "Home" || event.key === "ArrowUp") {
        keyAtRef.current = performance.now();
      }
    };
    /** 滚动条：`clientWidth` 右边那一条（滑块与轨道都算），按下到松开算手势活跃。 */
    const onPointerDown = (event: PointerEvent) => {
      if (event.clientX - el.getBoundingClientRect().left > el.clientWidth) {
        gestureActiveRef.current = true;
      }
    };
    const onPointerUp = () => {
      gestureActiveRef.current = false;
    };
    const onTouchStart = () => {
      gestureActiveRef.current = true;
    };
    const onTouchEnd = () => {
      gestureActiveRef.current = false;
    };
    const onVisibility = () => {
      if (!document.hidden) schedule();
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    // 端口自身变矮也要重新判定：插话排队条 / 提示条 / 待办面板 / 变高的输入框都是从下面
    // 把 `.chat-scroll` 挤矮——此时 `scrollTop` 不变、连 `scroll` 事件都没有。
    observer.observe(el);
    // 宿主来过一帧 = 内容可能变了（"新生成"到达的信号，不依赖 RO 时序）
    const offFrame = onHostFrame(schedule);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", schedule);
    schedule();
    return () => {
      observer.disconnect();
      offFrame();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", schedule);
    };
    // `active`：轨迹视图会把会话页整块卸载（元素换了一个），回来时必须重挂
  }, [active]);

  // 切会话 = 要看最新：恢复贴底并回到底部（意愿不跨会话继承——上个会话滚到中间的阅读
  // 位置对新会话没有意义，继承过去的表现是「切过来不跟最新」）。
  // 首次挂载也会跑一次，此时内容通常还没到，scrollTop 赋值是 no-op，无副作用。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    pendingRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  }, [sessionId]);

  /** 用户显式要最新：点胶囊、发消息（见 `App` 传给 `Composer` 的 `onFollowLatest`）。 */
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    pendingRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  }, []);

  return { scrollRef, contentRef, showJump, jumpToLatest };
}

export function App() {
  const { state, dispatch } = useAppState();
  // 会话页是否在场：轨迹视图下它整块卸载，两个滚动 hook 都要能重挂
  const chatActive = state.panel !== "trajectory";
  // 当前会话 id：进 useAutoScroll（切会话时恢复贴底、回最新）与轨迹刷新（下方）
  const sessionId = state.session?.id;
  // 全页拖放：拖文件进会话页的任何位置都算添加附件（dragActive 时亮出浮层）
  const dragActive = usePageFileDrop();
  const { scrollRef, contentRef, showJump, jumpToLatest } = useAutoScroll(chatActive, sessionId);
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
  useEffect(() => {
    if (state.panel !== "trajectory") return;
    if (!state.running) {
      post({ type: "listTrajectory" });
      return;
    }
    const timer = setInterval(() => post({ type: "listTrajectory" }), 3000);
    return () => clearInterval(timer);
  }, [state.panel, state.running, sessionId]);

  // 子代理面板开着时切会话：**重新拉一次这个会话的子代理**。
  // 打开面板那一下已经拉过一次（见头部按钮的 `toggle`），所以这里只处理"开着的时候换了
  // 会话"——否则列表会停在上一个会话上。宿主快照里的 `subagents` 只是投影（可能不如
  // RPC 列表全），所以补的是 RPC，而不是只靠快照。
  const subagentPanelSession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.panel !== "subagents") {
      subagentPanelSession.current = undefined;
      return;
    }
    const previous = subagentPanelSession.current;
    subagentPanelSession.current = sessionId;
    if (previous === undefined || previous === sessionId) return;
    post({ type: "listSubagents" });
  }, [state.panel, sessionId]);

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
          <div className="chat-area">
            <div className="chat-pane">
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
                        turnProcessThreshold={state.turnProcessThreshold}
                        // 只有非最后一条（= 不是正在跑的那一轮）才能作为分支锚点
                        canBranch={!state.running || index < state.messages.length - 1}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* 「回到最新」胶囊：脱贴（用户上滑）后内容继续增长时的兜底入口。
                点击回底并重新贴上（恢复跟随）；贴底时永不出现。锚在只包滚动区的
                .chat-pane 上——待办面板在 .chat-area 里更靠下，不能让胶囊叠上去。 */}
            {showJump ? (
              <button type="button" className="jump-latest" onClick={jumpToLatest}>
                <span aria-hidden="true">↓</span>
                {texts.jumpToLatest}
              </button>
            ) : null}
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
          </div>
        )}

        {/* 待处理的审批 / 提问**接管输入区**（官方把两者注册进 `conversation.composer` 槽）：
            卡片永远在视野里，界面看起来就是「在等你回答」；已经答过的仍留在对话流里当记录
            （见 Message.tsx 里对 waiting 段的跳过）。 */}
        <Composer
          state={state}
          pending={pendingInteractionOf(state.messages)}
          chatScrollRef={scrollRef}
          onDraft={(text) => dispatch({ type: "ui/setDraft", text })}
          onFollowLatest={jumpToLatest}
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

        {/* 全页拖放浮层：文件拖进会话页时整页亮起「松手即添加」。aria-hidden 的
            纯视觉层，pointer-events: none（不能自己变成 drop 目标，事件要落到
            页面上、冒泡到 window 统一处理，见 usePageFileDrop）。 */}
        {dragActive ? (
          <div className="page-drop-overlay" aria-hidden>
            <div className="page-drop-pill">
              <IconAttach size={12} />
              {texts.dropHint}
            </div>
          </div>
        ) : null}
      </div>
    </TextsContext.Provider>
  );
}
