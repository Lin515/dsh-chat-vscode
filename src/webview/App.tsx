import { useCallback, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatState, MessageView, PendingMessageView } from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import { persistIdentity, post, subscribe } from "./bridge";
import { useAutoScroll } from "./autoScroll";
import { useReadingPort } from "./readingPlacement";
import { Composer } from "./components/Composer";
import { EmptyMeta } from "./components/EmptyMeta";
import { HistoryPanel } from "./components/History";
import { ImagePreviewLayer } from "./components/Images";
import { ContextMenuLayer } from "./components/ContextMenu";
import { FindBar } from "./components/FindBar";
import { Message } from "./components/Message";
import { JobsPanel } from "./components/Panels";
import { NotificationBar, NotificationsPanel } from "./components/Notifications";
import { TrajectoryView } from "./components/Trajectory";
import { TodoPanel } from "./components/TodoPanel";
import { Spinner } from "./components/primitives";
import { AppState, useAppState, type PanelKind } from "./state";
import { TODO_PANEL_DEFAULT, todosOpenIn, toggleTodos, type TodoPanelState } from "./todoPanel";
import { changesSummaryKey, turnsWithChangesCard } from "../shared/changesSummary";
import { resolveInteractions } from "./pendingInteraction";
import {
  messageRowKey,
  pendingAsMessage,
  pendingPlacement,
  pendingVisible,
} from "./pendingMessage";
import { attachDroppedFiles, attachPastedFiles, clipboardFiles, dragHasFiles } from "./attachIntake";
import { createPastedImageSequence, visibleImageNames } from "./pastedImageNames";
import { setImageCopyFailureScope } from "./imageCopyFailure";
import { setLocalImageScope } from "./localImages";
import { dp, dpLength, uiScaleOf, UiScaleContext } from "./uiScale";
import { TurnRail } from "./components/TurnRail";
import { useTurnRailItems, useTurnRailNav } from "./turnRailNav";
import {
  IconAttach,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconDesktop,
  IconFolder,
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
import {
  attachEscapeFallback,
  ESC_LAYER,
  isConversationForeground,
  useEscapeLayer,
} from "./escapeOwner";
import { usePageContextMenu } from "./contextMenu";
import { jobsEntrySignal, subagentsBusy } from "./activity";
import { subagentRowFace } from "./subagentRow";
import { subagentCurrentNode, subagentDescendants } from "./subagentTree";
import { sessionDirParts, sessionDirPath } from "./sessionDir";
import { LocaleContext, TextsContext, dictionaryFor, normalizeLocale, resolveText, useTexts } from "./texts";
import type { SubagentTreeView, SubagentView } from "../shared/chat";

/**
 * 顶部只有一排图标按钮——Continue 的聊天页没有传统工具栏，
 * 这里保留最少的入口：新建、历史、后台任务、在编辑器中打开、
 * 打开（官方 Web UI / 桌面端应用窗口，见 `state.desktopConnected`）。
 *
 * 子代理**没有**单独的按钮：切换入口在标题上（用户 2026-10-20 口径）——有子代理时
 * 标题可点，展开「顶层会话 + 多层子代理树」，标题后的计数提示保留；没有子代理时
 * 标题保持纯文本。见 `SessionTitle`。
 *
 * 这里曾经还有一颗**设置**按钮（自绘的 DSH 服务端设置面板）。它被删掉了：
 * Web 端的设置页是各功能插件自绘的页面组合（`settings.section` 槽），没有任何
 * 数据契约可以自绘复刻，而通用 schema 表单只能展示裸字段名。现在 Web 专属设置
 * 走「打开」（连桌面端时改开桌面端窗口），扩展真正读取的设置（模型、`busyEnter`…）另有入口。
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
  // 子代理目录上有在跑的，计数触发器会亮出状态点（同一判据）；后台任务那枚还看
  // **待执行的自动化任务**（用户 2026-10-15 口径——同一个抽屉里还有东西排着），
  // 那一档亮而不呼吸。
  const agentsBusy = subagentsBusy(state.subagentEntries, state.jobs);
  const jobsSignal = jobsEntrySignal(state.jobs, state.schedules);

  return (
    <div className="header">
      <span className="header-brand" title="DeepSeek Harness">
        <BrandMark />
      </span>
      {/* 标题本身就是切换入口（用户 2026-10-20 口径）：有子代理时变成可点击，
          点击展开「顶层会话 + 多层子代理树」；标题后的计数仍在。 */}
      <SessionTitle state={state} agentsBusy={agentsBusy} />
      {/* 执行目录跟在标题（与子代理计数）之后；未打开文件夹或与工作区目录不同时
          显示，见 sessionDirPath。 */}
      <HeaderDir state={state} />
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
        className={`icon-btn${state.panel === "jobs" ? " is-active" : ""}${
          jobsSignal === "busy" ? " is-busy" : jobsSignal === "pending" ? " is-pending" : ""
        }`}
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
      {/* 「在编辑器中打开」：**编辑区标签组里的会话不显示这颗按钮**（用户 2026-10-10
          口径）——它自己就在标签组里，再开一次只会得到两个开着同一条会话的标签。
          侧栏 / 辅助栏里的窗口才需要它。 */}
      {state.inEditorTab ? null : (
        <button
          data-mini="hide"
          className="icon-btn"
          title={texts.openInEditor}
          onClick={() => post({ type: "openInEditor" })}
        >
          <IconOpenInEditor size={15} />
        </button>
      )}
      {/* 「打开」：**一颗按钮两种形态**（用户 2026-10-18 口径）。当前连的是桌面端内置
          服务时打开桌面端应用窗口——那套服务对浏览器是关着的（只认自己按进程生成的
          启动令牌），在浏览器里打开只会得到一页 401；其余情况打开官方 Web UI。 */}
      {state.desktopConnected ? (
        <button
          data-mini="hide"
          className="icon-btn"
          title={texts.openDesktop}
          onClick={() => post({ type: "openDesktop" })}
        >
          <IconDesktop size={15} />
        </button>
      ) : (
        <button
          data-mini="hide"
          className="icon-btn"
          title={texts.openInBrowser}
          onClick={() => post({ type: "openInBrowser" })}
        >
          <IconGlobe size={15} />
        </button>
      )}
    </div>
  );
}

/**
 * 标题右侧的执行目录（文件夹图标 + 目录名 + 所在路径）。
 *
 * VS Code 未打开文件夹时显示；打开时仅在执行目录与工作区目录不同时显示。
 * 判据与回退取值集中在 `sessionDirPath`，不影响空态页的工作区目录选择。
 *
 * 静态文字，不是切目录入口。全文挂在 `title` 上——窄侧栏里被裁掉的是所在路径，
 * 悬停仍读得到完整目录。
 *
 * 显示形态（用户 2026-10-20 口径）：文件夹图标后空一格接目录名，再空一格是它
 * 所在的路径，路径里不再重复目录名（`📁 dsh-chat D:\dev`）。装不下时先省略所在
 * 路径，目录名留住——与正文路径「末段不参与收缩」同一口径。
 */
function HeaderDir({ state }: { state: AppState }) {
  const texts = useTexts();
  const path = sessionDirPath(state);
  if (!path) return null;
  const parts = sessionDirParts(path);
  if (!parts) return null;
  return (
    <span className="header-dir" title={`${path}\n${texts.sessionDir}`}>
      <IconFolder size={16} />
      <span className="header-dir-name">{parts.name}</span>
      {parts.parent ? (
        <span className="header-dir-parent">{parts.parent}</span>
      ) : null}
    </span>
  );
}

function BrandMark() {
  return (
    <svg
      style={{ width: dpLength(14), height: dpLength(14) }}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
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
 * 树里的一行（官方 `CatalogRows` 的行结构：状态点列 + 标题/副文两行 + 右侧箭头）。
 * 点行进入该子代理；当前所在的那一行标题加粗、不可再点（与官方 `aria-current` 同义）。
 *
 * 状态点与副文字都来自 `subagentRowFace`（状态表与三条纪律在那个模块的文件头）：
 * **点恒画**——一次性子代理从前整行没有点，用户分不出「生成中」与「已完成」。
 *
 * `depth` 只用于缩进：第 1 层（顶层会话直接调用的子代理）与顶层会话行同级，
 * 第 2 层起逐级缩进。
 */
function SubagentCatalogRow({
  entry,
  current,
  depth,
  onOpen,
}: {
  entry: SubagentView;
  current: boolean;
  depth: number;
  onOpen: (id: string) => void;
}) {
  const texts = useTexts();
  const face = subagentRowFace(entry);
  return (
    <button
      className={`subagent-row${current ? " is-current" : ""}`}
      title={entry.label}
      data-depth={depth}
      // 当前行不可再点（已经在这里了）：点别行才切换
      disabled={current || undefined}
      // 缩进写在行内：层级是数据（`SubagentTreeView.nodes[].depth`），不靠固定几档
      style={depth > 1 ? { paddingLeft: dpLength(6 + (depth - 1) * 14) } : undefined}
      onClick={() => onOpen(entry.id)}
    >
      {/* 状态点**独享一格**（格内居中）：色调由显示状态决定，只有运行中才有呼吸动画 */}
      <span className="subagent-row-state">
        <span className={`dot ${face.tone}`} />
      </span>
      <span className="subagent-row-content">
        <span className="subagent-row-label">{entry.label}</span>
        <span className="subagent-row-sub">{texts[face.key]}</span>
      </span>
      <span className="subagent-row-arrow" aria-hidden>
        <IconChevronRight size={12} />
      </span>
    </button>
  );
}

/** 顶层会话那一行：与第 1 层子代理同级对齐，靠分组标题与「子代理会话」区分。 */
function SessionCatalogRow({
  title,
  running,
  onOpen,
}: {
  title: string;
  running: boolean;
  onOpen: () => void;
}) {
  const texts = useTexts();
  return (
    <button
      className="subagent-row subagent-root-row"
      title={title}
      onClick={onOpen}
    >
      <span className="subagent-row-state">
        {/* 顶层会话不是子代理，没有「一次性 / 可继续」这种模式点：不在跑时留空，
            只有确证在跑才画运行圆点（与子代理行的状态口径一致）。 */}
        {running ? <span className="dot dot-running" /> : null}
      </span>
      <span className="subagent-row-content">
        <span className="subagent-row-label">{title || texts.untitled}</span>
      </span>
      <span className="subagent-row-arrow" aria-hidden>
        <IconChevronRight size={12} />
      </span>
    </button>
  );
}

/**
 * 宿主还没把 `subagentTree` 送到的极短窗口里，用手里已有的目录拼一棵**浅树**：
 * 普通会话的根是自己，子代理页的根是直接父会话。等正式树一到就换成它（正式树
 * 才有跨域血缘与多层嵌套）。没有子代理时返回 `undefined`，标题保持纯文本。
 */
function fallbackSubagentTree(state: AppState): SubagentTreeView | undefined {
  const sessionId = state.session?.id;
  if (!sessionId) return undefined;
  if (state.subagent) {
    const parentId = state.subagent.parentSessionId;
    return {
      root: { id: parentId, title: state.subagent.parentTitle, running: false },
      nodes: state.subagent.parentEntries.map((entry) => ({
        ...entry,
        parentSessionId: parentId,
        depth: 1,
      })),
    };
  }
  if (!state.subagentEntries.length) return undefined;
  return {
    root: { id: sessionId, title: state.session?.title ?? "", running: state.running },
    nodes: state.subagentEntries.map((entry) => ({
      ...entry,
      parentSessionId: sessionId,
      depth: 1,
    })),
  };
}

/**
 * 标题 + 子代理计数 = 会话切换入口（用户 2026-10-20 口径）。
 *
 * - **有子代理时标题可点**（子代理页本来就在树里，也可点）：点击展开固定宽度的
 *   清单，再点标题关闭；点外部 / Esc 收起。开合只认点击，不搞悬停。
 * - 清单分两组：**顶层会话**（只在正在看子代理时出现，作为回顶层的入口）与
 *   **子代理会话**（整棵多层树）。由顶层会话直接调用的子代理是第 1 层，与顶层
 *   会话行同级对齐；更深层逐级缩进。当前是顶层会话时不再重复列它自己；
 *   当前所在行加粗且不可再点。
 * - 标题后的计数是**当前会话下面全部子代理**（含多层后代），不是只数直接下级；
 *   有在跑的仍保留运行圆点。
 *
 * 展开那一刻补一次 `listSubagents`：服务端会话列表是跨域血缘与最新状态的权威
 * 来路（见宿主 `refreshSubagents`），打开菜单这一下就是「把最新的要一遍」。
 */
function SessionTitle({ state, agentsBusy }: { state: AppState; agentsBusy: boolean }) {
  const texts = useTexts();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const sessionId = state.session?.id;
  const tree = state.subagentTree ?? fallbackSubagentTree(state);
  const currentNode = subagentCurrentNode(sessionId, tree?.nodes ?? []);
  // 标题与清单里的当前行同源：优先用树里的 label（目录解析后的显示名），
  // 拿不到才退回会话标题
  const title = currentNode?.label || state.session?.title || texts.untitled;
  const descendants = subagentDescendants(sessionId, tree?.nodes ?? []);
  const count = descendants.length;
  const treeBusy = descendants.some((node) => node.activity === "running");
  const switchable = !!tree && (tree.nodes.length > 0 || !!state.subagent);

  // 换了会话：展开着的那份内容属于上一次的上下文，收起来重开
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  // 树的入口消失（子代理被删 / 切回空态）：不许留着一个没有内容的浮层
  useEffect(() => {
    if (!switchable) setOpen(false);
  }, [switchable]);

  // 展开时点外部收起；ESC 走归属链，本层活跃期间登记、消费一次就关掉自己
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  useEscapeLayer(ESC_LAYER.floating, open, () => setOpen(false));

  const openSubagent = (id: string): void => {
    setOpen(false);
    post({ type: "openSubagent", id });
  };
  const openRoot = (rootId: string): void => {
    setOpen(false);
    post({ type: "openSession", sessionId: rootId });
  };

  return (
    <span ref={rootRef} className="header-title-group">
      {switchable ? (
        <button
          type="button"
          className={`header-title is-switcher${open ? " is-open" : ""}`}
          aria-haspopup="true"
          aria-expanded={open}
          title={texts.switchSession(title)}
          onClick={() => {
            // 展开那一刻要最新的整棵树：会话列表补父子关系与自身身份，
            // 目录那条路补齐 label / activity
            post({ type: "listSubagents" });
            setOpen((value) => !value);
          }}
        >
          <span className="header-title-text">{title}</span>
          <IconChevronDown size={11} className={open ? "is-open" : undefined} />
        </button>
      ) : (
        // 侧栏容器名已经是「DSH Chat」，这里只放会话名，不再重复产品名
        <span className="header-title">{title}</span>
      )}
      {count > 0 ? (
        <span className="header-subagent-count" title={texts.subagentCount(count)}>
          {agentsBusy || treeBusy ? <span className="dot dot-running" /> : null}
          <span className="header-subagent-count-text">{texts.subagentCount(count)}</span>
        </span>
      ) : null}
      {open && tree ? (
        <div className="subagent-menu" role="menu">
          <div className="subagent-menu-body">
            {/* 用户 2026-10-20 口径：本会话已经是顶层会话时不显示「上层会话」
                （标题就是它，清单里再列一遍是冗余）；正在看子代理时才列顶层会话，
                作为回顶层的入口，并与第 1 层子代理同级对齐。 */}
            {tree.root.id === sessionId ? null : (
              <div className="subagent-menu-group">
                <div className="subagent-menu-head">{texts.subagentTopLevel}</div>
                <SessionCatalogRow
                  title={tree.root.title}
                  running={tree.root.running}
                  onOpen={() => openRoot(tree.root.id)}
                />
              </div>
            )}
            {tree.nodes.length ? (
              <div className="subagent-menu-group">
                <div className="subagent-menu-head">{texts.subagentSessions}</div>
                <div role="tree" aria-label={texts.subagentSessions}>
                  {tree.nodes.map((node) => (
                    <SubagentCatalogRow
                      key={node.id}
                      entry={node}
                      current={node.id === sessionId}
                      depth={node.depth}
                      onOpen={openSubagent}
                    />
                  ))}
                </div>
              </div>
            ) : null}
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
  startDesktop: () => post({ type: "startDesktop" }),
  connectDesktop: () => post({ type: "connectDesktop" }),
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

/** 「加载更早的历史」的两个入口（`session/page`）——**与官方同构的两档语义**
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
 *
 * 命名（`pastedImageNames.ts`）：剪贴板位图的名字一律是 `image.png`，这里在发给
 * 宿主之前按**会话内编号**改成 `图1.png` / `image1.png`，让用户能直接说「看图3」。
 */
function usePagePaste(state: AppState) {
  // 监听只挂一次（window 级），最新的会话状态从 ref 取：把 state 写进依赖数组
  // 会让每次帧到达都重挂一次监听
  const latest = useRef(state);
  latest.current = state;
  // 按会话记住已分配最大编号，A → B → A 与连续快粘都不能重用已删芯片的号。
  // 编号器只保留最近 256 个已编号会话；清理与恢复边界见 pastedImageNames。
  const assigned = useRef(createPastedImageSequence());
  // 每次会话切换都同步（不等下一次粘贴）：空态首次绑定迁移，重新进空态归零。
  useLayoutEffect(() => {
    assigned.current.selectSession(state.session?.id);
  }, [state.session?.id]);
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = clipboardFiles(event.clipboardData);
      if (!files.length) return;
      // 认出了文件才劫持：否则文本粘贴会被吃掉（textarea 拿不到原生插入）
      event.preventDefault();
      const current = latest.current;
      const named = assigned.current.rename({
        sessionId: current.session?.id,
        names: visibleImageNames(current),
        files,
        locale: normalizeLocale(current.locale),
      });
      attachPastedFiles(named.files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
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
  usePagePaste(state);
  // 自动滚动（贴底 / 放跟随 / 回底胶囊）：整套规则在 `autoScroll.ts` 里，
  // 这里只把它的结果接给组件——端口一个（`chatScroll`），滚动手势与贴底判定不在这里。
  const chatScroll = useAutoScroll(chatActive, sessionId);
  const scrollRef = chatScroll.port.scrollEl;
  // 阅读定位（点刻点跳轮 / 查找跳命中）：一次动作的完整顺序（先放跟随、再写视口，
  // 取历史前后各放一次）在 `readingPlacement.ts` 的端口里。横条与查找条共用**同一份**
  // 端口，所以「一次只可能有一个阅读动作」由它一个地方保证。
  const reading = useReadingPort(chatScroll.port);
  // 「加载更早」按钮（单页档）与轮次横条的跨轮跳转（到目标档）两个入口；
  // 没有滚动自动加载（与官方会话页一致）
  const { loadEarlier, loadThrough, loading: loadingEarlier } = useHistoryPaging(scrollRef, state);
  // 右侧轮次横条（官方 TurnNavigator 的移植）：刻度 = turnOutline 投影 ∪ 已加载
  // 窗口的锚点/预览；激活轮与跳转的滚动语义见 turnRailNav.ts。
  // `hasMoreHistory` 传下去：窗口第一轮的用户消息常被条数切点切在窗口外，该刻点要按
  // 「可加载」呈现（点击取回用户消息），而不是退化成助手消息（见 `mergeTurnRailItems`）。
  const railItems = useTurnRailItems(state.messages, state.turnOutline, state.hasMoreHistory === true);
  const { activeTurn, busyTurn, navigate } = useTurnRailNav({
    port: reading,
    items: railItems,
    active: chatActive,
    sessionId,
    hasMoreHistory: state.hasMoreHistory === true,
    historyLoading: state.historyLoading === true,
    loadThrough,
  });
  // 迷你模式：.app 宽度 < 220 个设计像素时收成图标条（滞回 ≥232 恢复），由 Composer 测宽后
  // 同步到这里。阈值按设计像素算——量到的宽度是容器给的物理像素，而「装不下」这件事随界面
  // 倍率变，所以倍率进 effect 依赖：字号一改就重判一次。
  const appRef = useRef<HTMLDivElement>(null);
  const [mini, setMini] = useState(false);
  // JS 侧的界面倍率（阈值、拖动范围、按序号算的位置）：与 CSS 同一个数，见 uiScale.ts
  const uiScale = uiScaleOf(state.fontSizePx);
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const check = () =>
      setMini((prev) =>
        prev ? el.clientWidth < dp(232, uiScale) : el.clientWidth < dp(220, uiScale),
      );
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [uiScale]);
  // 文案跟随 VS Code 显示语言（或 `dshChat.language` 的固定选择）；
  // 词典随语言切换而重建，界面即时更新
  const texts = dictionaryFor(normalizeLocale(state.locale));
  // 会话正文与图片的右键菜单：换成自绘的「复制 / 引用」「复制 / 保存」
  // （判据在 `contextMenu.ts`；输入框这类可编辑元素仍走系统菜单，否则粘贴就没了）
  usePageContextMenu(dispatch, texts);
  /**
   * 「复制图片失败」的归属登记（见 `imageCopyFailure.ts`）。
   *
   * 与上面 `setLocalImageScope` 同一套写法：模块级只记「此刻是哪条会话」，
   * 真正的失败会带上**发起那一刻**捕获的归属，回帧前再与这里核对一次——切走之后
   * 才失败的复制不画进新会话。
   */
  useEffect(() => {
    setImageCopyFailureScope(sessionId);
  }, [sessionId]);
  // 字号：只写一个 CSS 变量，整套文本与尺寸尺度从它派生（tokens.css）。
  // 0（auto）时清掉覆盖，`--font-size` 回落 VS Code 注入的 `--vscode-font-size`。
  //
  // 写在**根元素**上而不是 `.app`：图片浮层与右键菜单刻意挂在 `.app` 之外（全屏定位层），
  // 它们也要拿到派生尺度；派生声明与覆盖点必须在同一级（自定义属性的 var() 在声明处求值）。
  //
  // **必须是 insertion effect**（在变更阶段、所有 layout effect 之前触发），不能是
  // layout effect：有一批子组件在 layout effect 里**量尺寸**（输入框的自适应高度、
  // 工具栏档位、气泡是否超行…），而 React 的 layout effect 是**子先父后**——写成 layout
  // effect 的话，子组件量到的还是上一档字号，量完设成写死的 px，父组件随后改字号也不会
  // 让它重算（用户 2026-10-03 报的「刚调完字体输入框偏矮、敲一个字才正常」就是它）。
  // insertion effect 同时早于绘制，配置了字号也不会闪一帧基准字号。
  useInsertionEffect(() => {
    const root = document.documentElement;
    if (state.fontSizePx) root.style.setProperty("--font-size", `${String(state.fontSizePx)}px`);
    else root.style.removeProperty("--font-size");
  }, [state.fontSizePx]);
  // 语言也写在根元素上：有几条**按语言分档**的几何尺寸要挑（轨迹账本的事件列宽，见
  // `styles/app.css` 的 `.trajectory-col-event:lang(zh)`），而语言是用户设置、不是宿主
  // 写死在 HTML 里的那一个。用 `:lang()` 而不是给元素挂一个 `is-zh` 类：语言本来就该声明
  // 在根元素上（读屏要用），声明只此一处，省掉「类与属性两处同步」的维护面。
  //
  // 值用归一化后的 `zh` / `en`（`normalizeLocale` 的口径与词典同源）：`:lang(zh)` 是按
  // 子标签前缀匹配的，`zh` 覆盖 `zh-cn` / `zh-tw` 等全部中文，不需要把原串照抄进去。
  // 跟字体那条同放一个 insertion effect：它在绘制前跑，切语言不会先闪一帧旧几何。
  useInsertionEffect(() => {
    document.documentElement.lang = normalizeLocale(state.locale);
  }, [state.locale]);
  const closePanel = () => dispatch({ type: "ui/setPanel", panel: "none" });

  /**
   * 「在轨迹里查看这次调用」的待办目标（官方 `viewRequest.focus` 的等价物）。
   *
   * 会话侧那颗按钮给的是工具调用的 `callId`；轨迹侧把它解成**账本里那一行**
   * （`cell.callId`，官方 `TrajectoryTable` 的 `record.cell.callId === inspectCallId`
   * 同一判据），选中并滚进视野。解不出来就**一直挂着**（官方同款：找不到目标时
   * 请求保持 pending、不 ack）——历史还在往后取的时候，「先点了、那一页随后才到」
   * 正是它要活下来的场景。
   *
   * 清空时机：**轨迹侧命中并消费之后由它 ack**（`onFocusApplied`，官方
   * `onInspectApplied` 同款）；离开轨迹视图、或切了会话也清。切会话必须清——
   * `callId` 只在同一个会话里唯一，留着会在新会话里撞上一个无关的行。
   */
  const [focusCallId, setFocusCallId] = useState<string | undefined>(undefined);
  const focusSessionRef = useRef<string | undefined>(sessionId);
  useEffect(() => {
    if (focusSessionRef.current === sessionId) return;
    focusSessionRef.current = sessionId;
    setFocusCallId(undefined);
  }, [sessionId]);
  useEffect(() => {
    if (state.panel === "trajectory") return;
    setFocusCallId((current) => (current === undefined ? current : undefined));
  }, [state.panel]);

  /**
   * 「任务清单」面板的开合：**界面自己的视图偏好**，默认展开（用户 2026-10-10 口径）。
   *
   * 为什么由 App 持有而不是放进 `TodoPanel` 自己：轨迹视图会把整块会话页卸载
   * （`state.panel` 那个分支），组件级 state 会在「去轨迹看一眼再回来」时丢掉，
   * 用户刚折起来的清单又弹回展开。放在这里则活得过卸载与重挂。
   *
   * 为什么不进聊天数据：`state.todos` 是服务端投影，界面只读不写；开合跟内容无关。
   * 单槽位按会话记账的读法见 `todoPanel.ts`（切会话回默认展开，且不随会话数增长）。
   */
  const [todosState, setTodosState] = useState<TodoPanelState>(TODO_PANEL_DEFAULT);
  const todosOpen = todosOpenIn(todosState, sessionId);

  // 下面的监听只在挂载时注册一次，两个判据都用 ref 读，避免闭包里是首帧的旧值
  const runningRef = useRef(state.running);
  useEffect(() => {
    runningRef.current = state.running;
  }, [state.running]);
  // 「无人认领的 ESC = 停止生成」只在**会话页**占据前景时成立（见 isConversationForeground）：
  // 轨迹整页或历史 / 任务抽屉顶掉会话页之后，中止机制就该不存在，而不是被谁抢先消费
  const conversationForegroundRef = useRef(isConversationForeground(state.panel));
  useEffect(() => {
    conversationForegroundRef.current = isConversationForeground(state.panel);
  }, [state.panel]);

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
    // ESC 归属链的**唯一**挂点：元素层（输入框 / 绘图区）已经消费的到不了这里；活跃
    // 浮层按层级消费（菜单 > 原图 > 其余）；都没有、会话页还在前景且生成中才停止生成
    // （见 escapeOwner.ts）
    const detachEscape = attachEscapeFallback({
      isConversationForeground: () => conversationForegroundRef.current,
      isRunning: () => runningRef.current,
      stop: () => post({ type: "stop" }),
    });
    return () => {
      unsubscribe();
      detachEscape();
    };
    // 只在挂载时订阅一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 待处理的交互：输入区渲染**被选中的那一条**，消息流里跳过**同一条**——选举与抑制
  // 由 `resolveInteractions` **一次**算出（`pending` 给 Composer、`takenOver` 给 Message），
  // 才不会出现「两边都画」或「两边都不画」（见 pendingInteraction.ts 文件头）
  const { pending, takenOver } = resolveInteractions(state.messages);
  /**
   * 乐观回显（按下发送那一刻宿主就画出来了，见 `pendingMessage.ts` 与
   * `shared/chat.ts` 的 `PendingMessageView`）。
   *
   * 它**不参与**上面那场交互选举（回显里没有审批/问卷），所以单独取一份。
   * 账本里只有「已经发出去」的那一类；已被 durable 行承认的那些让位给真实行
   * （`pendingVisible` 按 rpcId 去重）。
   */
  const visibleEchoes = useMemo(
    () => pendingVisible(state.messages, state.pendingMessages),
    [state.messages, state.pendingMessages],
  );
  /**
   * 消息流的**行序列**：真实消息 + 乐观回显，一处拼装、下面只 map 一次。
   *
   * 回显行的渲染与真实行完全共用（同一个 `Message`），只有 `sendState` 让失败那行
   * 变红并给出重发 / 撤回。插装位置由 `pendingPlacement` **一处**给出：还在等承认的那些
   * 插在「真实行将来落在哪」，失败那些插回提交那一刻的锚点行之后（见它的注释）。
   */
  const messageRows = useMemo(() => {
    const rows: { key: string; message: MessageView; canBranch: boolean }[] = [];
    const pushMessage = (message: MessageView, canBranch: boolean): void => {
      rows.push({ key: messageRowKey(message), message, canBranch });
    };
    const byIndex = new Map(
      pendingPlacement(state.messages, visibleEchoes).map((entry) => [entry.index, entry.echoes]),
    );
    const echoesBefore = (index: number): PendingMessageView[] => byIndex.get(index) ?? [];
    state.messages.forEach((message, index) => {
      for (const echo of echoesBefore(index)) pushMessage(pendingAsMessage(echo), false);
      // 只有非最后一条（= 不是正在跑的那一轮）才能作为分支锚点
      pushMessage(message, !state.running || index < state.messages.length - 1);
    });
    // `index === messages.length` 的那些落在这里（追加末尾）
    for (const echo of echoesBefore(state.messages.length)) pushMessage(pendingAsMessage(echo), false);
    return rows;
  }, [state.messages, state.running, visibleEchoes]);

  /**
   * 会话侧那颗「查看」的落点（官方 `inspectCall(callId)` → `openView('trajectory', focus)`）：
   * 记下目标、切到轨迹视图、并立刻要一份账本。
   *
   * 为什么自己发 `listTrajectory`：切面板那一帧 `state.panel` 还是旧值，下面那个按面板
   * 轮询的 effect 要等下一次渲染才生效，只靠它会让第一次跳转停在一个**可能还没有账本**
   * 的轨迹页上（用户点了「查看」却看到空页）。
   */
  const inspectCall = (callId: string): void => {
    setFocusCallId(callId);
    dispatch({ type: "ui/setPanel", panel: "trajectory" });
    post({ type: "listTrajectory" });
  };

  return (
    <TextsContext.Provider value={texts}>
      {/* 语言本身也下一层：服务端给的本地化文案（审批的 displayReason）要在渲染时按它挑 */}
      <LocaleContext.Provider value={state.locale}>
      {/* 界面倍率也下一层：要按设计像素算尺寸的组件（阈值、拖动范围、刻点位置）从它取 */}
      <UiScaleContext.Provider value={uiScale}>
      <div
        ref={appRef}
        className={`app${mini ? " is-mini" : ""}${state.panel === "trajectory" ? " is-trajectory" : ""}`}
      >
        <Header state={state} dispatch={dispatch} />
        <ConnectionBar state={state} />
        {/* 顶部常驻通知条（宿主权威镜像）：只画最近一条未确认，没有就整块不渲染。
            它**不自动消失**、不自动展开抽屉；展开走那颗写明的入口。 */}
        <NotificationBar
          notifications={state.notifications}
          sessionId={sessionId}
          onOpenHistory={() => dispatch({ type: "ui/openPanel", panel: "notifications" })}
        />

        {/* 轨迹是**整页**视图（和官方 Web UI 一样），不是盖在会话上的抽屉：
            它顶掉的是会话页本身（消息列表 + 待办），并且**输入区也一起让位**——
            轨迹打开时就该占用整个会话窗口（用户 2026-09-16 口径：待答问卷不该一直
            占着底部，切回来时它照常还在）。
            输入区由 `.app.is-trajectory` 用「移出布局 + 隐藏」的方式让位，**不卸载**：
            半填的选择虽能经内存草稿表在重挂载时恢复（见 `questionDraft.ts`），但焦点、
            光标与正在输入的编辑状态会丢——看一眼轨迹回来不该打断正在填的答案。
            注意两个滚动监听挂在 `chat-scroll` 上，它被卸载后必须能在回来时重挂，
            所以下面两个 hook 都吃一个 `active`（见 `useAutoScroll`）。 */}
        {state.panel === "trajectory" ? (
          <TrajectoryView
            model={state.trajectory}
            sessionId={sessionId}
            locale={state.locale}
            onLoadEarlier={() => loadEarlier()}
            loadingEarlier={loadingEarlier}
            {...(focusCallId === undefined ? {} : { focusCallId })}
            // 落点被轨迹侧消费（命中并选中）之后**由它 ack**：这里清掉请求，
            // 于是下一次点同一次调用又是一件新事（官方 `onInspectApplied` 同款）。
            // 不 ack 的话轨迹侧每次账本换身份都会重放，把用户的选中拉回旧目标。
            onFocusApplied={() => setFocusCallId(undefined)}
          />
        ) : (
          <div className="chat-area">
            {/* 会话查找条（Ctrl+F）：自绘——webview 拿不到原生查找部件（见
                FindBar.tsx 文件头）。挂在滚动区之前、随会话页一起卸载：轨迹视图
                打开时查找自动收掉并摘掉全局注册表里的高亮。 */}
            <FindBar port={reading} />
            <div className="chat-pane">
              <div className="chat-scroll" ref={chatScroll.port.scrollEl}>
              {/* 右侧轮次横条：sticky 零高度槽位浮在正文右缘，不占布局、不撑长
                  scrollHeight（官方 TurnNavigator 的挂法一致）。轨迹视图下整块
                  会话页卸载，它自然不在。 */}
              <TurnRail items={railItems} activeTurn={activeTurn} busyTurn={busyTurn} onNavigate={navigate} />
              <div className="chat-list" ref={chatScroll.port.contentEl}>
                {/* 空态页让位的判据里带上乐观回显：第一条消息发出去那一刻，会话页就该
                    换成消息流（官方 blank → engaging 也是在这一刻翻的，见 `beginSubmission`）。
                    发送失败**不**收回那一行（它留在原地、红框、可重发/撤回），所以空态页
                    只在用户主动取消目录选择、正文回输入框之后才回来。 */}
                {state.messages.length === 0 && visibleEchoes.length === 0 ? (
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
                    {messageRows.map((row) => (
                      <Message
                        // 有 rpcId 的用户消息（= 它换来的那行）与回显行**同一个 key**：
                        // 交接时 React 复用同一个 DOM 节点，不卸载重建（见 `messageRowKey`）
                        key={row.key}
                        message={row.message}
                        diffLayout={state.diffLayout}
                        fileKinds={state.fileKinds}
                        questionBatch={state.questionBatch}
                        turnProcessThreshold={state.turnProcessThreshold}
                        // 改动文件卡片：坐标在消息上，清单在 state 的缓存里（键带会话 id，
                        // 见 shared/changesSummary.ts）。没绑会话（空态）时不传，卡片不渲染。
                        sessionId={state.session?.id}
                        changesSummary={
                          row.message.changes && state.session
                            ? state.changesSummaries?.[
                                changesSummaryKey(state.session.id, row.message.changes.seq)
                              ]
                            : undefined
                        }
                        // 让位按**轮**判定（卡片可能在同轮的另一段上）
                        changesCardShown={
                          row.message.changes
                            ? changesCardTurns.has(row.message.changes.turn)
                            : false
                        }
                        // 只有非最后一条（= 不是正在跑的那一轮）才能作为分支锚点
                        canBranch={row.canBranch}
                        takenOver={takenOver}
                        // 「在轨迹里查看这次调用」（官方 `inspectCall`）：一路透到工具行
                        onInspectCall={inspectCall}
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
            <TodoPanel
              todos={state.todos}
              running={state.running}
              open={todosOpen}
              onToggle={() => setTodosState(toggleTodos(todosState, sessionId))}
            />
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
            schedules={state.schedules}
            schedulesStatus={state.schedulesStatus}
            scheduleHistory={state.scheduleHistory}
            scheduleResult={state.scheduleResult}
            sessionId={state.session?.id}
            dispatch={dispatch}
            onClose={closePanel}
          />
        ) : null}

        {/* 通知抽屉：ESC 只收起它（`useEscapeLayer` 的抽屉层），既不确认也不停生成。
            它顶掉会话页之后，「无人认领的 ESC = 停止生成」这条兜底自然不成立
            （`isConversationForeground` 只认 none）。 */}
        {state.panel === "notifications" ? (
          <NotificationsPanel
            notifications={state.notifications}
            sessionId={sessionId}
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
      </UiScaleContext.Provider>
      </LocaleContext.Provider>
    </TextsContext.Provider>
  );
}
