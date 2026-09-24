import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChatState } from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import { persistIdentity, post, subscribe } from "./bridge";
import { useAutoScroll } from "./autoScroll";
import { Composer } from "./components/Composer";
import { EmptyMeta } from "./components/EmptyMeta";
import { HistoryPanel } from "./components/History";
import { ImagePreviewLayer } from "./components/Images";
import { ContextMenuLayer } from "./components/ContextMenu";
import { Message } from "./components/Message";
import { JobsPanel } from "./components/Panels";
import { TrajectoryView } from "./components/Trajectory";
import { Spinner } from "./components/primitives";
import { AppState, useAppState, type PanelKind } from "./state";
import { changesSummaryKey, turnsWithChangesCard } from "../shared/changesSummary";
import { resolveInteractions } from "./pendingInteraction";
import { attachDroppedFiles, attachPastedFiles, clipboardFiles, dragHasFiles } from "./attachIntake";
import { setLocalImageScope } from "./localImages";
import { TurnRail } from "./components/TurnRail";
import { useTurnRailItems, useTurnRailNav } from "./turnRailNav";
import {
  IconAttach,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconGlobe,
  IconHistory,
  IconJobs,
  IconKey,
  IconOpenInEditor,
  IconPlus,
  IconRefresh,
  IconTrajectory,
} from "./icons";
import { connectViewOf, type ConnectButton, type ConnectButtonId } from "./connectView";
import { usePageContextMenu } from "./contextMenu";
import { jobsBusy, subagentsBusy } from "./activity";
import { TextsContext, dictionaryFor, normalizeLocale, resolveText, useTexts } from "./texts";
import type { SubagentView } from "../shared/chat";

/**
 * 顶部只有一排图标按钮——Continue 的聊天页没有传统工具栏，
 * 这里保留最少的入口：新建、历史、后台任务、在编辑器中打开、
 * 在浏览器中打开（官方 Web UI）。
 *
 * 子代理**没有**按钮（官方 Web 端也没有）：它的入口在标题右侧——普通会话显示
 * 目录计数触发器、子代理页显示面包屑（见 `SubagentNav`），没有子代理时什么都不占。
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

  // 「现在有东西在跑吗」（用户 2026-09-19 口径）：判据是纯函数，见 `activity.ts`。
  // 子代理目录上有在跑的，计数触发器会亮出状态点（同一判据）。
  const agentsBusy = subagentsBusy(state.subagentEntries, state.jobs);
  const jobsRunning = jobsBusy(state.jobs);
  // 子代理页：标题栏显示的本来就是「主会话的标题」——把它变成可点的返回入口
  // （官方 crumbs 左半的 openTitle 同款），后面只接 `/ 子代理标题`，不重复一节。
  const child = state.subagent;
  const title = child ? child.parentTitle : (state.session?.title || texts.untitled);

  return (
    <div className="header">
      <span className="header-brand" title="DeepSeek Harness">
        <BrandMark />
      </span>
      {child ? (
        // 子代理页：标题 = 主会话标题，可点返回主会话（官方 .crumb 的可点形态）
        <button
          type="button"
          className="header-title"
          title={texts.backToParent(child.parentTitle)}
          onClick={() => post({ type: "openSession", sessionId: child.parentSessionId })}
        >
          {title}
        </button>
      ) : (
        // 侧栏容器名已经是「DSH Chat」，这里只放会话名，不再重复产品名
        <span className="header-title">{title}</span>
      )}
      {/* 子代理导航（官方同款）：普通会话显示「N 个子代理 ▾」，子代理页只接
          「/ 当前子代理标题 ▾」（返回主会话由左边可点的标题承担）；没有子代理时
          整个不渲染。点击展开 / 再点关闭（不搞悬停自动展开）。 */}
      <SubagentNav state={state} agentsBusy={agentsBusy} />
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
        className={`icon-btn${state.panel === "jobs" ? " is-active" : ""}${jobsRunning ? " is-busy" : ""}`}
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

/** 官方目录行的状态点色调：在跑 = 运行色，不在跑 = 已完成色（原面板的同一口径）。 */
function subagentTone(activity: SubagentView["activity"]): string {
  return activity === "running" ? "dot-running" : "dot-ok";
}

/** 目录行右侧的副文字：知道驻留状态就报状态，不知道就报生命周期模式。 */
function subagentRowSub(entry: SubagentView, texts: ReturnType<typeof useTexts>): string {
  if (entry.activity === "running") return texts.jobRunning;
  if (entry.activity === "inactive") return texts.subagentCompleted;
  return entry.mode === "one-shot" ? texts.subagentOneShot : texts.subagentContinuable;
}

/**
 * 目录树里的一行（官方 `CatalogRows` 的行结构：状态点列 + 标题/副文两行 + 右侧箭头）。
 * 点行进入该子代理；当前所在的那一行标题加粗、不可再点（与官方 `aria-current` 同义）。
 */
function SubagentCatalogRow({
  entry,
  current,
  onOpen,
}: {
  entry: SubagentView;
  current: boolean;
  onOpen: (id: string) => void;
}) {
  const texts = useTexts();
  return (
    <button
      className={`subagent-row${current ? " is-current" : ""}`}
      title={entry.label}
      // 当前行不可再点（已经在这里了）：点别行才切换
      disabled={current || undefined}
      onClick={() => onOpen(entry.id)}
    >
      {/* 状态点**独享一格**（格内居中）：没有驻留证据时不画点，但保留同一列宽，
          让各行标题对齐（官方每行保留同一状态列的口径一致）。 */}
      <span className="subagent-row-state">
        {entry.activity ? <span className={`dot ${subagentTone(entry.activity)}`} /> : null}
      </span>
      <span className="subagent-row-content">
        <span className="subagent-row-label">{entry.label}</span>
        <span className="subagent-row-sub">{subagentRowSub(entry, texts)}</span>
      </span>
      <span className="subagent-row-arrow" aria-hidden>
        <IconChevronRight size={12} />
      </span>
    </button>
  );
}

/**
 * 标题右侧的子代理导航（官方 `dsh-client-ui-subagent` 目录触发的移植，按用户口径
 * 收敛交互）：
 *
 * - **普通会话**：目录非空时显示一枚「N 个子代理 ▾」触发器（有在跑的先亮状态点）；
 *   **点击展开**一个固定宽度的树形列表（官方 336px 目录菜单的同款皮肤），**再点
 *   关闭**；点行进入该子代理（`openSubagent`，会话级切换）。目录为空（或还没拿到）
 *   时**整个不渲染**。
 * - **正在看子代理**：只接「/ 当前子代理标题 ▾」一节（返回主会话由左边可点的
 *   主会话标题承担，见 `Header`）；点 ▾ 展开父目录，当前行加粗、不可再点，点
 *   兄弟行切换。
 *
 * 开合**只认点击**（用户 2026-09-24 口径：不要悬停自动展开）；展开时点外部 / Esc
 * 收起；展开那一刻补一次 `listSubagents` 刷新——投影那一路可能落后于服务端的
 * 完整检索，打开菜单这一下就是「把最新的要一遍」。
 */
function SubagentNav({ state, agentsBusy }: { state: AppState; agentsBusy: boolean }) {
  const texts = useTexts();
  const child = state.subagent;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // 换了会话：展开着的那份内容属于上一次的上下文，收起来重开
  useEffect(() => {
    setOpen(false);
  }, [child?.parentSessionId, state.session?.id]);

  // 展开时点外部 / Esc 收起（悬停不参与开合——那是上一版被否掉的交互）
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 本层消费：不再落到全局「ESC 停止生成」
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const entries = child ? child.parentEntries : state.subagentEntries;
  const currentId = child ? state.session?.id : undefined;
  // 触发器上的标题 = 目录里当前那一行的 label——与列表行**同一个来源同一个值**，
  // 不会出现「列表里叫 A、标题上叫 B」（子代理会话自己的自动标题是另一套字段，
  // 不做切换入口的显示名）。
  const currentLabel = child
    ? (entries.find((entry) => entry.id === currentId)?.label ?? state.session?.title)
    : undefined;

  // 目录为空（或还没拿到）时整个不渲染：没有子代理就没有这个入口（官方同口径）
  if (entries.length === 0) return null;

  return (
    <span ref={rootRef} className="subagent-nav">
      {/* 子代理页：标题后面只接一节「/ 子代理标题 ▾」（主会话标题在左边，可点返回） */}
      {child ? (
        <span className="subagent-crumb-sep" aria-hidden>
          /
        </span>
      ) : null}
      <button
        type="button"
        className={`subagent-trigger${child ? " is-current" : ""}${agentsBusy ? " is-busy" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        title={child ? texts.subagentSwitcher(currentLabel ?? "") : texts.subagents}
        aria-label={child ? undefined : texts.subagentCount(entries.length)}
        onClick={() => {
          // 展开那一刻要最新的目录：普通会话拉自己的、子代理页拉本级的（父目录由宿主推）
          post({ type: "listSubagents" });
          setOpen((v) => !v);
        }}
      >
        {child ? (
          <span className="subagent-trigger-title">{currentLabel}</span>
        ) : (
          <>
            {agentsBusy ? <span className="dot dot-running" /> : null}
            <span className="subagent-trigger-count">{texts.subagentCount(entries.length)}</span>
          </>
        )}
        <IconChevronDown size={12} className={open ? "is-open" : undefined} />
      </button>
      {open ? (
        <div className="subagent-menu" role="menu">
          <div className="subagent-menu-head">{texts.subagents}</div>
          <div className="subagent-menu-body" role="tree" aria-label={texts.subagents}>
            {entries.map((entry) => (
              <SubagentCatalogRow
                key={entry.id}
                entry={entry}
                current={entry.id === currentId}
                onOpen={(id) => {
                  setOpen(false);
                  post({ type: "openSubagent", id });
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}

/**
 * 连接条按钮各自的**指令**：纯函数只说"这一档给哪几个按钮"，点它发哪条指令是界面的事。
 */
const CONNECT_POST: Record<ConnectButtonId, () => void> = {
  stopReconnect: () => post({ type: "stopReconnect" }),
  startInternal: () => post({ type: "startInternal" }),
  connectInternal: () => post({ type: "connectInternal" }),
  connectExternal: () => post({ type: "connectExternal" }),
  restartInternal: () => post({ type: "restartInternal" }),
  enterToken: () => post({ type: "setToken" }),
  showLogs: () => post({ type: "showLogs" }),
};

/** 按钮上的图标（纯函数只说该用哪个，画哪一个由这里定）。 */
function ConnectIcon({ icon }: { icon: ConnectButton["icon"] }) {
  if (icon === "key") return <IconKey size={12} />;
  if (icon === "plus") return <IconPlus size={12} />;
  if (icon === "refresh") return <IconRefresh size={12} />;
  return null;
}

/** 一颗连接条按钮（含「无图标」与「提示挂外层 span」这两种形态）。 */
function ConnectButtonNode({ button }: { button: ConnectButton }) {
  const node = (
    <button
      className={`btn${button.variant === "primary" ? " btn-primary" : button.variant === "ghost" ? " btn-ghost" : ""}`}
      data-mini={button.miniHide ? "hide" : undefined}
      disabled={button.disabled === true ? true : undefined}
      onClick={CONNECT_POST[button.id]}
    >
      {button.icon ? (
        <>
          <ConnectIcon icon={button.icon} />{" "}
        </>
      ) : null}
      {button.label}
    </button>
  );
  // 「连接外部 DSH」置灰时的提示挂在**外层 span**上（`disabled` 的元素收不到鼠标事件，
  // title 不会显示）。这一层**恒在**（配了地址时只是没有 title），与从前的 DOM 逐字一致。
  if (button.id !== "connectExternal") return node;
  return (
    <span className="conn-tip" title={button.tip}>
      {node}
    </span>
  );
}

/**
 * 连接条：**未就绪时**显示在所有内容上方（就绪时不占位置）。
 *
 * 三档状态、那行文案、按钮集合**全部由 `connectViewOf` 判定**（纯函数，见
 * `connectView.ts` 的文件头）——这里只渲染它的结论：`kind` 决定配色与转圈、`text` 直接
 * 落字、`buttons` 按序渲染。判定为什么搬出去：这套矩阵是用户口径
 * （`docs/design-supervisor.md`「连接条按钮矩阵」），从前它散在这个组件、`statusText` /
 * `connectingText` 与宿主的 `connectionPatch` 三处各写一遍，改一处忘两处；搬进纯函数后
 * 三类 × 每种标志的组合可以离线逐条断言（`scripts/connectView.test.ts`）。
 */
function ConnectionBar({ state }: { state: ChatState }) {
  const texts = useTexts();
  const view = connectViewOf(state, texts, (text) => resolveText(text, texts));
  if (view.kind === "hidden") return null;
  return (
    <div
      className={`conn-bar${view.kind === "error" ? " is-error" : ""}${view.kind === "stopped" ? " is-stopped" : ""}`}
    >
      {view.kind === "connecting" ? <Spinner size={11} /> : null}
      <span className="conn-text" title={view.text}>
        {view.text}
      </span>
      <span className="spacer" />
      {view.buttons.map((button) => (
        <ConnectButtonNode key={button.id} button={button} />
      ))}
    </div>
  );
}

/**
 * 空态：一行能力提示 + 两行新会话的元信息（落在哪个目录、用哪套 agent 组装）。
 * 不要问候语与起始卡片。
 */
function EmptyState({ state }: { state: AppState }) {
  const texts = useTexts();
  return (
    <div className="empty">
      <div className="empty-hint">{texts.emptyHint}</div>
      <EmptyMeta
        workspace={state.workspace}
        agentPresets={state.agentPresets}
        agentPreset={state.agentPreset}
      />
    </div>
  );
}

/** 轻提示的停留时长（毫秒）。 */
const NOTICE_MS = 4000;

/**
 * 「加载更早的历史」的两个入口（`session/page`）——**与官方同构的两档语义**
 * （判据在宿主侧，见 `dsh/historyPaging.ts`）：
 *
 * - `loadEarlier()`：**单页档**（官方 `ISession.loadOlder()`），取一页就停。会话页的
 *   「加载更早的历史」按钮与轨迹视图的同一枚按钮走这里；
 * - `loadThrough(seq)`：**到目标档**（官方 `ISession.loadThrough(seq)`），循环取到
 *   窗口覆盖该 seq 为止。右侧轮次横条上那些「未加载」的刻点走这里，取完再由
 *   `turnRailNav` 的 pendingJump 落位到那一轮。
 *
 * **没有滚动自动加载**：官方**会话页**只有那枚按钮（`ChatView` 的滚动触发属于官方
 * **轨迹表格** `TrajectoryTable`，不是会话页）。用户 2026-09-20 口径：只看按钮。
 *
 * 分工：
 * - **连取由宿主驱动**：界面只发一次 `loadMore`，由宿主按档位决定取一页还是取到目标
 *   ——「这一页有没有带来新事件」「窗口盖住目标没有」只有宿主有真凭据（见
 *   `dsh/historyPaging.ts` 的注释：界面侧拿「首条消息 id 变没变」猜，会在旧事件只是
 *   把第一条助手消息补长时提前收手）；
 * - **界面只管两件事**：把视口钉住（结算落定时补一次高度差），以及按钮的加载态
 *   （读宿主发的 `historyLoading`）。
 *
 * 视口钉住的细节：更早的内容插在**上面**，浏览器保持 scrollTop 不变，于是正文整体
 * 下滑。加载前记下 scrollHeight，落定后把差值补回 scrollTop——按高度差补，**不**按
 * 「首条消息变没变」判断（同一条消息被补长时首条 id 不变，但上面的内容确实变多了）。
 * 宿主在连取多页时只**结算一次**（只发一份 `messages/reset`），所以这里一次就把各页
 * 的高度差补回来。
 */
function useHistoryPaging(scrollRef: React.RefObject<HTMLDivElement>, state: AppState) {
  /** 本次加载开始时的内容高度（结算后更新成新高度）。 */
  const height = useRef<number | null>(null);
  // 回调里读到的必须是最新值（state 每次渲染都是新对象）
  const latest = useRef(state);
  latest.current = state;

  const start = useCallback(
    (targetSeq?: number) => {
      const current = latest.current;
      if (!current.hasMoreHistory) return;
      // 已经在取（宿主说了算）：连点不会重复发
      if (current.historyLoading) return;
      // 视口锚点只有会话页在的时候才有得记：轨迹视图里聊天区是卸载的
      // （入口仍然要能用——那就是轨迹时间线左端那个 `…`）
      const el = scrollRef.current;
      height.current = el ? el.scrollHeight : null;
      post(targetSeq === undefined ? { type: "loadMore" } : { type: "loadMore", targetSeq });
    },
    [scrollRef],
  );

  const loadEarlier = useCallback(() => start(), [start]);
  const loadThrough = useCallback((seq: number) => start(seq), [start]);

  // 结算落定：把视口钉回加载前那一行；取完（宿主说落定）就丢掉锚点
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && height.current !== null) {
      el.scrollTop += el.scrollHeight - height.current;
      height.current = el.scrollHeight;
    }
    if (!state.historyLoading) height.current = null;
  }, [state.messages, state.historyLoading, scrollRef]);

  return { loadEarlier, loadThrough, loading: state.historyLoading === true };
}

/**
 * 全页拖放接取：拖文件进会话页 = 添加附件。
 *
 * 之前只有输入框接 drop，拖到消息区（页面的大头）没有任何 drop 目标，浏览器走
 * 默认行为——导航到被拖的文件，在 VS Code 里表现为「文件被打开」而不是附件。
 * 现在整页都是目标：**dragover 的 preventDefault 就是「本页接受文件投放」的声明**，
 * 缺了它松手必被 VS Code 捕获；drop 统一走 `attachDroppedFiles`（字节上传，
 * 见 `attachIntake.ts`）。
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
 * 全页粘贴接取：`Ctrl+V` 贴进来的是图片 / 文件 = 添加附件。
 *
 * 与拖放同一套判据、同一个落点（只有字节，见 `attachIntake.ts` 的文件头）：
 * `clipboardFiles` 认出文件才 `preventDefault`，**纯文本一律放行**给 textarea 的
 * 原生插入。
 *
 * 为什么挂 window 而不是输入框：粘贴事件从焦点元素冒泡到 window，一处接住就够
 * ——挂两处会双发 `attachBytes`（同一张图两条附件），而且焦点不在输入框时
 * （比如刚点开一条消息）粘贴也该能加附件。VS Code 桌面版对 `Ctrl+V` 的处理
 * （`preventDefault` + 由宿主补发 `execCommand("paste")`）见模块文件头：**paste
 * 事件照样会到 webview**，所以这条路不需要自己抢按键。
 */
function usePagePaste() {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = clipboardFiles(event.clipboardData);
      if (!files.length) return;
      // 认出了文件才劫持：否则文本粘贴会被吃掉（textarea 拿不到原生插入）
      event.preventDefault();
      attachPastedFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
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

export function App() {
  const { state, dispatch } = useAppState();
  // 会话页是否在场：轨迹视图下它整块卸载，两个滚动 hook 都要能重挂
  const chatActive = state.panel !== "trajectory";
  // 当前会话 id：进 useAutoScroll（切会话时恢复贴底、回最新）与轨迹刷新（下方）
  const sessionId = state.session?.id;
  /**
   * 把当前会话 id 写进 VS Code 的 webview state。
   *
   * 宿主恢复编辑区面板时读它来认回自己的会话（**身份**，不是顺序）：只按 VS Code
   * 恢复面板的顺序对位，两个标签的会话会交叉（用户 2026-09-21 报的）。
   * 每次会话变化都写——空态也写（`sessionId: null`），于是「这个标签当时是新建的空窗口」
   * 与「它上次开的是会话 X」在宿主那边分得开。
   */
  useEffect(() => {
    persistIdentity(sessionId, state.subagent
      ? { parentSessionId: state.subagent.parentSessionId, mode: state.subagent.mode }
      : undefined);
  }, [sessionId, state.subagent?.parentSessionId, state.subagent?.mode]);
  /**
   * 哪些**轮次**真的会显示改动文件卡片（判据与卡片自己的渲染条件一致）。
   *
   * 按轮而不是按消息：一轮被插话切成多段时（`a:N` / `a:N:2`…），卡片挂在最后一段、
   * `produced` 往往挂在前一段，按消息判定就会让「卡片」与「本轮改动」在同一轮尾部
   * 并排（用户 2026-09-21 报告的混乱，见 `shared/changesSummary.ts`）。
   */
  const changesCardTurns = useMemo(
    () =>
      turnsWithChangesCard(state.messages, (seq) =>
        sessionId ? state.changesSummaries?.[changesSummaryKey(sessionId, seq)] : undefined,
      ),
    [state.messages, state.changesSummaries, sessionId],
  );
  // 正文里本地图片的解析缓存按会话隔离：相对路径的基准是会话工作目录，
  // 切了会话之后同名路径是另一个文件（见 webview/localImages.ts）
  useEffect(() => {
    setLocalImageScope(sessionId ?? "");
  }, [sessionId]);
  // 全页拖放：拖文件进会话页的任何位置都算添加附件（dragActive 时亮出浮层）
  const dragActive = usePageFileDrop();
  // 全页粘贴：Ctrl+V 贴图片 / 文件同样算添加附件（没有浮层可亮，纯文本仍走原生）
  usePagePaste();
  // 自动滚动（贴底 / 放跟随 / 回底胶囊）：整套规则在 `autoScroll.ts` 里，
  // 这里只把它的结果接给组件——端口一个（`chatScroll`），滚动手势与贴底判定不在这里。
  const chatScroll = useAutoScroll(chatActive, sessionId);
  const scrollRef = chatScroll.port.scrollEl;
  // 「加载更早」按钮（单页档）与轮次横条的跨轮跳转（到目标档）两个入口；
  // 没有滚动自动加载（与官方会话页一致）
  const { loadEarlier, loadThrough, loading: loadingEarlier } = useHistoryPaging(scrollRef, state);
  // 右侧轮次横条（官方 TurnNavigator 的移植）：刻度 = turnOutline 投影 ∪ 已加载
  // 窗口的锚点/预览；激活轮与跳转的滚动语义见 turnRailNav.ts。
  // `hasMoreHistory` 传下去：窗口第一轮的用户消息常被条数切点切在窗口外，该刻点要按
  // 「可加载」呈现（点击取回用户消息），而不是退化成助手消息（见 `mergeTurnRailItems`）。
  const railItems = useTurnRailItems(state.messages, state.turnOutline, state.hasMoreHistory === true);
  const { activeTurn, busyTurn, navigate } = useTurnRailNav({
    scrollRef,
    listRef: chatScroll.port.contentEl,
    items: railItems,
    releaseFollow: chatScroll.releaseFollow,
    active: chatActive,
    sessionId,
    hasMoreHistory: state.hasMoreHistory === true,
    historyLoading: state.historyLoading === true,
    loadThrough,
  });
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
  // 会话正文与图片的右键菜单：换成自绘的「复制 / 引用」「复制 / 保存」
  // （判据在 `contextMenu.ts`；输入框这类可编辑元素仍走系统菜单，否则粘贴就没了）
  usePageContextMenu(dispatch, texts);
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

  // 轨迹里的「加载更早」与会话页**共用同一条链路**（都发 `loadMore`；不带目标 = 单页档，
  // 取一页 50 条）。但宿主只回填会话侧，不会顺手重推账本，所以取完
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

  // 待处理的交互：输入区渲染**被选中的那一条**，消息流里跳过**同一条**——选举与抑制
  // 由 `resolveInteractions` **一次**算出（`pending` 给 Composer、`takenOver` 给 Message），
  // 才不会出现「两边都画」或「两边都不画」（见 pendingInteraction.ts 文件头）
  const { pending, takenOver } = resolveInteractions(state.messages);

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
              <div className="chat-scroll" ref={chatScroll.port.scrollEl}>
              {/* 右侧轮次横条：sticky 零高度槽位浮在正文右缘，不占布局、不撑长
                  scrollHeight（官方 TurnNavigator 的挂法一致）。轨迹视图下整块
                  会话页卸载，它自然不在。 */}
              <TurnRail items={railItems} activeTurn={activeTurn} busyTurn={busyTurn} onNavigate={navigate} />
              <div className="chat-list" ref={chatScroll.port.contentEl}>
                {state.messages.length === 0 ? (
                  <EmptyState state={state} />
                ) : (
                  <>
                    {/* 「加载更早的历史」：跟随窗口只带 60 条，更早的内容从没进过客户端。
                        按钮只在服务端说「还有更早的」时出现——空按钮比没有按钮更烦人。
                        这是**单页档**（官方 `loadOlder`）：点一次取一页，没有滚动自动加载
                        （跨轮跳转走轮次横条那条「到目标档」）；取的过程中它自己变成
                        「正在加载更早的历史…」的不可点状态，这样「点了没反应」与
                        「还在取」一眼可分。**生成中也照常可点**——官方的同一枚按钮同样
                        只在取的那一下禁用（`ChatView` 的 `disabled={loadingOlder}`）。 */}
                    {state.hasMoreHistory ? (
                      <button
                        className="history-more"
                        disabled={loadingEarlier}
                        title={loadingEarlier ? texts.historyLoading : texts.historyMore}
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
                        // 改动文件卡片：坐标在消息上，清单在 state 的缓存里（键带会话 id，
                        // 见 shared/changesSummary.ts）。没绑会话（空态）时不传，卡片不渲染。
                        sessionId={state.session?.id}
                        changesSummary={
                          message.changes && state.session
                            ? state.changesSummaries?.[
                                changesSummaryKey(state.session.id, message.changes.seq)
                              ]
                            : undefined
                        }
                        // 让位按**轮**判定（卡片可能在同轮的另一段上）
                        changesCardShown={
                          message.changes ? changesCardTurns.has(message.changes.turn) : false
                        }
                        // 只有非最后一条（= 不是正在跑的那一轮）才能作为分支锚点
                        canBranch={!state.running || index < state.messages.length - 1}
                        takenOver={takenOver}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* 「回到最新」胶囊：脱贴（用户上滑）后内容继续增长时的兜底入口。
                点击回底并重新贴上（恢复跟随）；贴底时永不出现。锚在只包滚动区的
                .chat-pane 上——待办面板在 .chat-area 里更靠下，不能让胶囊叠上去。 */}
            {chatScroll.showJump ? (
              <button type="button" className="jump-latest" onClick={chatScroll.jumpToLatest}>
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
            （见 Message.tsx 里对**被选中那一条**的跳过）。 */}
        <Composer
          state={state}
          pending={pending}
          chatScroll={chatScroll.port}
          onDraft={(text) => dispatch({ type: "ui/setDraft", text })}
          onFollowLatest={chatScroll.jumpToLatest}
        />

        {state.panel === "history" ? (
          <HistoryPanel
            sessions={state.sessions}
            archivedSessions={state.archivedSessions}
            currentId={state.session?.id}
            onClose={closePanel}
          />
        ) : null}

        {state.panel === "jobs" ? (
          <JobsPanel
            jobs={state.jobs}
            outputs={state.jobOutputs}
            killResult={state.jobKill}
            dispatch={dispatch}
            onClose={closePanel}
          />
        ) : null}

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
      {/* 原图浮层：**所有**来源的图片共用（缩略图、markdown 注入的外链图与本地图）。
          挂在 `.app` 之外：浮层是 position: fixed 的全屏层，不该受 app 容器的
          布局/裁剪影响。 */}
      <ImagePreviewLayer />
      {/* 右键菜单浮层：同样是全屏定位层，且要盖在原图浮层之上（在原图上点右键时
          它就是弹在原图上） */}
      <ContextMenuLayer />
    </TextsContext.Provider>
  );
}
