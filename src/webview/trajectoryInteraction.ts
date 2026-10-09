/**
 * 轨迹视图的**交互端口**：一条交互链一个对象（AGENTS「一条交互链路只开一个端口对象」）。
 *
 * ## 它拥有什么
 *
 * 从前这些规则散在 `components/Trajectory.tsx`（五组并列 state + 三条回调 + 两处
 * 内联清空）与 `components/TrajectoryTimeline.tsx`（13 个 prop 里的 7 个）里，于是
 * 「谁该清谁」只能靠读码保证，实测出现了四种不一致（记录检查器与请求检查器互相
 * 复活、Escape 只清一半、点空白的最小选区被点选清掉、切会话什么都不清）。
 * 现在**唯一拥有者**是这里：
 *
 * 1. **选择**：记录 / 请求 / 请求页签三者互斥（`selectRecord` 清请求、`selectRequest`
 *    清记录、`clearSelection` 两个都清）；
 * 2. **选区**（时间线拖出来的 `range`）与它的提交（抬手 / 点空白的最小选区）；
 * 3. **跨视图落点**（`pendingCallId`）：命中才 ack，未命中保持 pending；
 * 4. **滚动落点**（`reveal`）：带 nonce 的一次性对齐，`applyReveal()` 保证同一个
 *    nonce 只消费一次——手滚 / 窗口变化不会把用户拉回旧目标；写下的 `scrollTop` 会让
 *    绘制计划按新位置重排，所以 `settleReveal()` 只对**刚写下的那一次**补一次实测余量
 *    （用户手滚 / 切会话 / 卸载都让票据作废）；补的前提是**绘制计划已经按新位置重算**
 *    （组件把这一帧计划用的滚动位置一起传进来）：重排之前量到的余量属于一个马上要被
 *    换掉的布局，拿它判定会把票据当成「已对齐」提前收掉，重排之后目标行照样裁着；
 * 5. **时间线视口**（`zoom` / `offset` / `animateViewport`）与**容器几何**：
 *    容器 ref 与动作在同一个对象里，`zoomAtCursor` / `edgePanAt` 每次都现读
 *    `plot.getBoundingClientRect()` 并直接读对象里的最新 `zoom`/`offset`——
 *    这条链上不存在渲染闭包里的旧值，也就不需要 rAF 节流（边缘平移要求
 *    「每次 mousemove 都用最新 zoom/offset/rect」）；
 * 6. **账本视图态**（折叠集合 / 搜索词）与会话切换的整份重置。
 *
 * ## 为什么是普通对象 + `useSyncExternalStore`，不是 `useState` + reducer
 *
 * 时间线的手势（拖动框选、右键平移、边缘自动平移、滚轮缩放）要在**事件之间**
 * 累加最新值，而 React 的 state 读到的总是上一次渲染的闭包。官方那份用
 * `setViewport(current => …)` 的原子更新绕开了一半，边缘自动平移却仍拿渲染时的
 * `domainStart`（拖到边缘时视口追不上）。这里的对象本身就是那份最新值，组件只订阅
 * 它的快照——**测试与真实组件跨的是同一个缝**（`createTrajectoryInteraction()`，
 * 组件经 `useTrajectoryInteraction()` 用它）。
 *
 * ## 用户手势优先于程序化跟随
 *
 * 选中某条记录要把时间线视口带过去（官方 `selectedIndex` 那段 effect），但
 * **用户自己缩放/平移之后不许被旧选中拉回**（官方那份的依赖里没有 viewport，
 * 本扩展从前有，静态读码就能看出可能回拉）。这里的判据是 `followPending`：
 * 选中动作置它，任何用户手势（滚轮 / 平移 / 边缘平移 / 复位）清它，
 * `followSelected()` 只在它还在时动视口——「用户平移过没有」因此有唯一事实，
 * 不靠依赖数组的巧合。
 */
import { useEffect, useMemo, useSyncExternalStore, type MutableRefObject } from "react";
import { trajectoryDomainPosition } from "../shared/trajectory";

/** 请求检查器的页签（官方 `selectRequest(target, tab)` 的第二个参数）。 */
export type TrajectoryRequestTab = "summary" | "options" | "usage" | "timing";

/** 时间线一条条在归一化域里的位置（`trajectoryTimeline.ts` 的视图事实子集）。 */
export interface TrajectorySpanBox {
  cellIndex: number;
  left: number;
  width: number;
}

/** 归一化域里的一个区间。 */
export interface TrajectoryFractionRange {
  start: number;
  end: number;
}

/** 「这是点还是拖」的阈值（官方 `MINIMUM_DRAG_PX`）。 */
export const MINIMUM_DRAG_PX = 3;
/** 边缘自动平移的三常数（官方 `EDGE_PAN_*`）：8% 区域、每步 2.5%、最多 32px。 */
export const EDGE_PAN_ZONE_FRACTION = 0.08;
export const EDGE_PAN_STEP_FRACTION = 0.025;
export const MAXIMUM_EDGE_PAN_PX = 32;

/**
 * 落点对齐的判定余量（像素）：`applyReveal` / `settleReveal` 量出来的余量小于它就认为
 * 目标行已经贴住账本顶边。不能要求严格 0——账本表格的 `border-collapse` 会带来半像素级
 * 的差，真实 DOM 里「已经对齐」的那一次量到的是 −0.5px。
 */
const REVEAL_ALIGN_TOLERANCE_PX = 0.5;

/**
 * 落点收尾的步数上限：每补一次，余量按「(估计行高 − 实测行高) / 估计行高」收缩，
 * 正常的估计偏差一两步就到位。上限只是**保证收敛**——收尾在组件的 layout effect 里
 * 同步跑（写 `scrollTop` → 交回 React → 窗口重排 → 再量），不能让这里出现无限重渲染。
 */
const MAXIMUM_REVEAL_SETTLE_STEPS = 3;

/** 端口持有的全部状态（一次 `publish` 换一份新对象，快照身份即版本）。 */
export interface TrajectoryInteractionState {
  /** 当前会话 id：变了就整份重置（选择 / 选区 / 落点 / 折叠 / 搜索 / 视口）。 */
  sessionId: string | undefined;
  /** 选中的记录序号。与 `request` 互斥。 */
  record: number | undefined;
  /** 选中的请求号。与 `record` 互斥。 */
  request: number | undefined;
  /** 请求检查器打开时落在哪个页签。 */
  requestTab: TrajectoryRequestTab | undefined;
  /** 时间线上拖出来的选区。 */
  range: TrajectoryFractionRange | null;
  /** 未消费的跨视图落点请求（会话侧「查看」给的 callId）。 */
  pendingCallId: string | undefined;
  /** 落点请求的版本号：**同一个 callId 再来一次也算新动作**。 */
  focusRevision: number;
  /** 最近一次「把这一条滚进视野」的目标；`nonce` 变了才重新对齐一次。 */
  reveal: { index: number; nonce: number } | null;
  /** 被收起的轮号（跨会话不留）。 */
  collapsedTurns: ReadonlySet<number>;
  /** 被收起的助手行稳定身份。 */
  collapsedCalls: ReadonlySet<string>;
  /** 账本搜索词。 */
  query: string;
  /** 时间线放大倍数（1 = 全部铺满）。 */
  zoom: number;
  /** 时间线视口左边界在 0..1 里的位置。 */
  offset: number;
  /** 视口变化要不要走 CSS 过渡（只有选中跟随要）。 */
  animateViewport: boolean;
  /** 是否还欠一次「把选中条带回视野」；用户手势会清掉它。 */
  followPending: boolean;
  /** 正在进行的手势（拖动框选 / 右键平移 / 没有）。hover 这类悬停反馈要据此让位。 */
  gesture: "slice" | "pan" | null;
}

/**
 * 交给消费方的**那一个**端口对象。
 *
 * 容器 ref 与动作合成同一个对象（不是两个 prop）：`ledger` / `plot` 是账本与时间线
 * 绘图区的容器，`applyReveal()` / `zoomAtCursor()` 这些动作直接读它们。对象的身份在
 * 一次挂载内稳定（`useTrajectoryInteraction` 只建一次）。
 */
export interface TrajectoryInteraction {
  /** 账本滚动容器（`.trajectory-ledger`）。 */
  readonly ledger: MutableRefObject<HTMLDivElement | null>;
  /** 时间线绘图区（`.trajectory-plot`）：几何现读，命中判定与缩放都用它。 */
  readonly plot: MutableRefObject<HTMLDivElement | null>;
  /** 当前快照（`useSyncExternalStore` 的 getSnapshot）。 */
  readonly state: TrajectoryInteractionState;
  subscribe(listener: () => void): () => void;
  /** 卸载：摘掉可能还挂在 `document` 上的拖动 / 平移监听。 */
  dispose(): void;

  // —— 选择链（时间线 / 账本 / 检查器共用；三者互斥的规则只在这里）——
  /** 只选中一条记录：清选区、清请求检查器。 */
  selectRecord(index: number): void;
  /** 选中一条记录**并**请求账本滚过去（时间线点选 / 跨视图落点）。 */
  openRecord(index: number): void;
  /** 只请求账本滚到某条记录（框选提交），不动选中。 */
  reveal(index: number): void;
  /** 消费一次滚动落点；同一个 `nonce` 只消费一次（成功对齐才消费）。 */
  applyReveal(index: number, nonce: number): boolean;
  /**
   * 落点收尾：`applyReveal` 写下的 `scrollTop` 会让绘制计划按新的滚动位置重排，而垫行
   * 是按估计行高画的——重排之后目标行的实测位置还会偏。窗口真的按新位置重排之后调它，
   * 把残留的实测余量补一次（同一个 nonce 内部有步数上限）。
   *
   * `planScrollTop` 是**当前这一帧绘制计划用的滚动位置**（组件渲染时那个 state）：
   * 重排的标志就是它追上容器实际停下的位置。没追上就说明这一刻量到的余量属于马上要被
   * 换掉的布局（垫行还没换成真实行），此时**一个字都不改、票据也留着**——判定留给计划
   * 追上来之后那一次；否则「在旧布局里看起来已经贴边」会把票据提前收掉（真实 DOM 的
   * F06 首次落点就是这样裁掉半行的：写下的 117 让窗口重排到真实行高，目标行真实位置
   * 变成 104.5，而票据早在重排前就被判成对齐了）。
   *
   * 票据不在时（已对齐 / 用户手滚 / 切会话 / 卸载 / 换了新落点）返回 `false`，
   * **一个字都不改滚动位置**——所以它不会把用户拉回旧目标，也不是重放旧 `reveal`。
   * @param index - 目标记录下标。
   * @param nonce - 落点请求的版本号（只认最新那一次）。
   * @param planScrollTop - 这一帧绘制计划用的滚动位置。
   * @returns 这一次是否真的改了滚动位置（改了才会再触发一次重排后的重测）。
   */
  settleReveal(index: number, nonce: number, planScrollTop: number): boolean;
  /** 打开请求检查器（清记录检查器）；`tab` 缺席 = 回到默认页签。 */
  selectRequest(number: number, tab?: TrajectoryRequestTab): void;
  /** 只改选区（拖动过程中每帧都调）。 */
  setRange(range: TrajectoryFractionRange | null): void;
  /** 点空白：**保留**已提交的选区，选中并滚到最近的记录（官方 `onRecordFocus`）。 */
  focusNearest(index: number): void;
  /** Escape / 双击 / 关闭检查器：选择、请求、选区一起清。 */
  clearSelection(): void;

  // —— 时间线手势（视口与选区；容器几何现读）——
  /** 左键按下：开始框选。 */
  beginSlice(clientX: number): void;
  /** 拖动中：按边缘区自动平移一格，再用**挪过之后**的视口换算域坐标。 */
  extendSlice(clientX: number): void;
  /** 抬起：拖过 = 提交选区并滚到第一条；点一下 = 最小选区 + 聚焦最近记录。 */
  endSlice(clientX: number): void;
  /** 右键按下：开始平移（轻点不拖 = 清选择）。 */
  beginPan(clientX: number): void;
  /** 滚轮缩放：以光标为锚。 */
  zoomAtCursor(clientX: number, deltaY: number, maxZoom: number): void;
  /** 视口左边界（0..1，按当前 zoom 夹住）。 */
  panTo(offset: number): void;
  /** 边缘自动平移一格；不在边缘区或没缩放时返回 `false`。 */
  edgePanAt(clientX: number): boolean;
  /** 复位视口（双击的第二档）。 */
  resetViewport(): void;
  /** 欠着的那次「把选中条带回视野」；用户手势之后调用是空操作。 */
  followSelected(spans: readonly TrajectorySpanBox[]): boolean;
  /** 客户端 x → 归一化域位置（hover 竖线、命中判定）。 */
  domainAt(clientX: number): number;
  /** 只把最新一份时间线位置交给端口（手势的几何输入，不进快照）。 */
  syncSpans(spans: readonly TrajectorySpanBox[]): void;

  // —— 跨视图落点 ——
  /** 收到一个「在轨迹里查看这次调用」请求（未命中就一直是 pending）。 */
  inspectCall(callId: string): void;
  /** 落点解出来了就选中 + 滚动 + ack；解不出来保持 pending。 */
  resolveFocus(index: number | undefined): boolean;

  // —— 账本视图态 ——
  setQuery(query: string): void;
  /** 收起 / 展开一轮（双击行与摘要行都用它）。 */
  toggleTurn(turn: number): void;
  /** 展开一轮（摘要行、跨视图落点都用它）。 */
  expandTurn(turn: number): void;
  /** 收起 / 展开一条助手行（连带它后面那串工具行）。 */
  toggleCall(id: string): void;
  /** 展开一条助手行（跨视图落点用）。 */
  expandCall(id: string): void;
  toggleAllTurns(turns: readonly number[]): void;
  toggleAllCalls(ids: readonly string[]): void;

  // —— 会话 ——
  setSession(sessionId: string | undefined): void;
}

/** 端口初值（会话切换也回到这一份）。 */
function initialState(sessionId: string | undefined): TrajectoryInteractionState {
  return {
    sessionId,
    record: undefined,
    request: undefined,
    requestTab: undefined,
    range: null,
    pendingCallId: undefined,
    focusRevision: 0,
    reveal: null,
    collapsedTurns: new Set<number>(),
    collapsedCalls: new Set<string>(),
    query: "",
    zoom: 1,
    offset: 0,
    animateViewport: false,
    followPending: false,
    gesture: null,
  };
}

/** `document` 的最小面（无头环境里没有它，手势的状态机仍然要能跑）。 */
interface DomDocument {
  addEventListener(type: string, listener: (event: MouseEvent) => void): void;
  removeEventListener(type: string, listener: (event: MouseEvent) => void): void;
}

function domDocument(): DomDocument | undefined {
  const value = (globalThis as { document?: unknown }).document;
  return value === undefined || value === null ? undefined : (value as DomDocument);
}

/**
 * 建一个端口。组件与测试都从这里拿同一个对象（`useTrajectoryInteraction` 只是
 * 给它接上 React 的订阅）。
 * @param sessionId - 初始会话 id（之后由 `setSession` 跟随）。
 * @returns 端口对象。
 */
export function createTrajectoryInteraction(
  sessionId?: string | undefined,
): TrajectoryInteraction {
  let state = initialState(sessionId);
  const listeners = new Set<() => void>();
  const ledger: MutableRefObject<HTMLDivElement | null> = { current: null };
  const plot: MutableRefObject<HTMLDivElement | null> = { current: null };
  /** 最新一份时间线位置（手势要用；只做镜像，不进快照）。 */
  let spans: readonly TrajectorySpanBox[] = [];
  /** 已消费的最大 nonce（`applyReveal` 的一次性判据；nonce 只增不减）。 */
  let appliedRevealNonce = -1;
  let revealNonce = 0;
  /**
   * 落点收尾的票据：`applyReveal` 写下的那一次落点与它**实际落在**的 `scrollTop`
   * （写完之后读回来的，两端会被浏览器夹住）。`scrollTop` 用来分辨「这一步是我们自己
   * 滚的」还是「用户抢滚的」；`steps` 是这条票据已经补过的次数。`null` = 没有待收尾的落点。
   *
   * 票据**不记**绘制计划的位置：那是组件每帧交进来的（`settleReveal` 的第三个参数），
   * 因为「计划追上来了没有」只有渲染那一侧知道，端口只看容器实际停在哪。
   */
  let revealSettle: { index: number; nonce: number; scrollTop: number; steps: number } | null = null;
  let sliceAnchor: { clientX: number; domain: number } | null = null;
  let panAnchor: { clientX: number; offset: number; moved: boolean } | null = null;
  /** 还挂在 `document` 上的那对监听（拖动与平移共用一份）。 */
  let detach: (() => void) | undefined;

  const publish = (patch: Partial<TrajectoryInteractionState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  /** 夹在 `[0, 1 - 1/zoom]` 里的视口左边界。 */
  const clampOffset = (value: number, zoom: number): number =>
    Math.min(Math.max(0, 1 - 1 / zoom), Math.max(0, value));

  const plotRect = (): DOMRect | null => {
    const element = plot.current;
    if (element === null) return null;
    return element.getBoundingClientRect();
  };

  /** 客户端 x → 绘图区内的 0..1 屏幕比例（夹到两端）。 */
  const screenFraction = (clientX: number): number => {
    const rect = plotRect();
    if (rect === null || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const domainAt = (clientX: number): number =>
    trajectoryDomainPosition(screenFraction(clientX), state.offset, state.zoom);

  /** 把当前这份手势的 document 监听摘掉（抬起 / 卸载都走它）。 */
  const detachDocument = (): void => {
    detach?.();
    detach = undefined;
  };

  /**
   * 丢掉进行中的手势与它挂着的 `document` 监听（**跨会话**与卸载都走它）。
   *
   * 为什么必须有这一步：`publish(initialState(...))` 换掉的只是**公开快照**，闭包里的
   * `sliceAnchor` / `panAnchor` 还指着上一个会话的几何、`detach` 还挂着两个监听——于是
   * **已经排队**的旧 `mousemove` / `mouseup` 进来时照样按旧锚点改新会话的选区与选中。
   * 主代理独立生命期验收（`accept-ui-session-lifetime.mjs`，byte witness 是本模块上一版）
   * 红的正是这一条：**重置 state ≠ 重置资源**。这里把资源一起收掉，排队回调进来时
   * 锚点是 `null` → 一个字都不改。
   */
  const cancelGesture = (): void => {
    sliceAnchor = null;
    panAnchor = null;
    detachDocument();
  };

  /** 挂上一对 document 监听：拖动与平移都要「拖出绘图区继续跟手」。 */
  const attachDocument = (
    onMove: (event: MouseEvent) => void,
    onUp: (event: MouseEvent) => void,
  ): void => {
    detachDocument();
    const doc = domDocument();
    if (doc === undefined) return;
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
    detach = () => {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
    };
  };

  const selectRecord = (index: number): void => {
    publish({
      record: index,
      request: undefined,
      requestTab: undefined,
      range: null,
      followPending: true,
    });
  };

  const reveal = (index: number): void => {
    revealNonce += 1;
    publish({ reveal: { index, nonce: revealNonce } });
  };

  const clearSelection = (): void => {
    publish({
      record: undefined,
      request: undefined,
      requestTab: undefined,
      range: null,
      followPending: false,
    });
  };

  const focusNearest = (index: number): void => {
    // **不碰 `range`**：点空白那条最小选区要留下来（官方 `onRecordFocus` 也不碰）。
    publish({ record: index, request: undefined, requestTab: undefined, followPending: true });
    reveal(index);
  };

  /** 框选提交：账本滚到选区里第一条（用与高亮同一条判据）。 */
  const commitRange = (): void => {
    const range = state.range;
    if (range === null || range.end <= range.start) return;
    const hit = spans.find((span) => span.left <= range.end && span.left + span.width >= range.start);
    if (hit !== undefined) reveal(hit.cellIndex);
  };

  /**
   * 抬手收尾。拖动与平移共用：先摘监听、收手势标记，再按手势类型决定结局
   * （React 的 `onMouseUp` 与 `document` 上的监听都会调它，靠锚点是否已清空做到幂等）。
   * @param clientX - 抬起时的客户端 x。
   */
  const endDrag = (clientX: number): void => {
    const anchor = sliceAnchor;
    const pan = panAnchor;
    sliceAnchor = null;
    panAnchor = null;
    detachDocument();
    if (state.gesture !== null) publish({ gesture: null });
    if (anchor !== null) {
      if (Math.abs(clientX - anchor.clientX) >= MINIMUM_DRAG_PX) {
        // 拖过：选区已经由拖动写进状态，这里只让账本滚到选区里第一条
        commitRange();
        return;
      }
      // 点一下：给一条最小选区（**保留**它，不是清掉），再聚焦最近的记录
      const width = minimumSelection(spans.length, state.zoom);
      publish({ range: trajectoryCenteredRange(anchor.domain, width) });
      const nearest = trajectoryNearestSpanIndex(spans, anchor.domain);
      if (nearest !== undefined) focusNearest(nearest);
      return;
    }
    if (pan !== null && !pan.moved && Math.abs(clientX - pan.clientX) < MINIMUM_DRAG_PX) {
      // 右键轻点（不拖）= 退掉选区与选择（官方 `onPointerEnd` 的 `if (!moved)`）
      clearSelection();
    }
  };

  const interaction: TrajectoryInteraction = {
    ledger,
    plot,
    get state() {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      // 卸载兜底：还挂着的手势监听必须摘掉（排队回调引用的是已卸载组件的闭包）。
      // **不改公开状态**：这时组件已经卸载，再 publish 没有意义。
      // 未收尾的落点票据一并作废：卸载之后不会有人再来收尾，它指的目标行也没有意义。
      cancelGesture();
      revealSettle = null;
      listeners.clear();
    },

    selectRecord,
    openRecord(index: number): void {
      selectRecord(index);
      reveal(index);
    },
    reveal,
    applyReveal(index: number, nonce: number): boolean {
      if (nonce <= appliedRevealNonce) return false;
      const container = ledger.current;
      if (container === null) return false;
      const row = container.querySelector<HTMLElement>(`tr[data-cell-index="${index}"]`);
      if (row === null) return false;
      // 目标行顶边贴住账本视口顶边；尾部最后几行贴不了顶，浏览器会把 scrollTop 夹回去
      const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (Math.abs(offset) <= REVEAL_ALIGN_TOLERANCE_PX) {
        // 本来就在顶边：这一次不会产生滚动，也就没有「重排之后」要收尾
        revealSettle = null;
      } else {
        container.scrollTop += offset;
        // **写下之后读回来**：这个值决定了收尾要认的位置，必须是浏览器实际停下的地方
        revealSettle = { index, nonce, scrollTop: container.scrollTop, steps: 0 };
      }
      appliedRevealNonce = nonce;
      return true;
    },
    settleReveal(index: number, nonce: number, planScrollTop: number): boolean {
      const settle = revealSettle;
      if (settle === null || settle.index !== index || settle.nonce !== nonce) return false;
      // 换过新落点（nonce 不再是最新消费的那一个）：旧票据作废，不许动滚动位置
      if (nonce !== appliedRevealNonce) {
        revealSettle = null;
        return false;
      }
      const container = ledger.current;
      if (container === null) {
        revealSettle = null;
        return false;
      }
      // 绘制计划还没按我们写下的位置重算（计划用的滚动位置与容器实际停的位置对不上）：
      // 这一刻量到的余量属于马上要被换掉的布局，**一个字都不改、票据也留着**——判定留给
      // 计划追上来之后那一次（拿旧布局的「已经贴边」收票据，重排之后目标行就裁着了）。
      if (Math.abs(planScrollTop - container.scrollTop) > REVEAL_ALIGN_TOLERANCE_PX) return false;
      // 容器已经不在我们写下的位置上 = 用户自己滚过（或浏览器的滚动锚定改过）：不许拉回
      if (Math.abs(container.scrollTop - settle.scrollTop) > REVEAL_ALIGN_TOLERANCE_PX) {
        revealSettle = null;
        return false;
      }
      const row = container.querySelector<HTMLElement>(`tr[data-cell-index="${index}"]`);
      if (row === null) {
        revealSettle = null;
        return false;
      }
      const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (Math.abs(offset) <= REVEAL_ALIGN_TOLERANCE_PX || settle.steps >= MAXIMUM_REVEAL_SETTLE_STEPS) {
        // 对齐了（或已到步数上限）：票据用完即弃，之后任何滚动都与这次落点无关
        revealSettle = null;
        return false;
      }
      const before = container.scrollTop;
      container.scrollTop += offset;
      const after = container.scrollTop;
      settle.steps += 1;
      settle.scrollTop = after;
      if (Math.abs(after - before) <= REVEAL_ALIGN_TOLERANCE_PX) {
        // 浏览器把这次修正夹住了（尾部最后几条记录贴不了顶）：这张票据已经做完了它能做的，
        // 留着只会让下一次无关的布局变化又拿它去补一次——收掉。
        revealSettle = null;
        return false;
      }
      return true;
    },
    selectRequest(number: number, tab?: TrajectoryRequestTab): void {
      publish({ record: undefined, request: number, requestTab: tab });
    },
    setRange(range: TrajectoryFractionRange | null): void {
      publish({ range });
    },
    focusNearest,
    clearSelection,

    beginSlice(clientX: number): void {
      const at = domainAt(clientX);
      sliceAnchor = { clientX, domain: at };
      publish({ range: { start: at, end: at }, gesture: "slice" });
      attachDocument(
        (event) => interaction.extendSlice(event.clientX),
        (event) => endDrag(event.clientX),
      );
    },
    extendSlice(clientX: number): void {
      const anchor = sliceAnchor;
      if (anchor === null) return;
      // 先按边缘区挪一格、再用**挪过之后**的视口换算域坐标（否则自动平移期间
      // 框选终点停在旧视口上，与手划的位置对不上）
      interaction.edgePanAt(clientX);
      const point = domainAt(clientX);
      publish({
        range: { start: Math.min(anchor.domain, point), end: Math.max(anchor.domain, point) },
      });
    },
    endSlice(clientX: number): void {
      endDrag(clientX);
    },
    beginPan(clientX: number): void {
      panAnchor = { clientX, offset: state.offset, moved: false };
      publish({ gesture: "pan", ...(state.zoom > 1 ? { animateViewport: false, followPending: false } : {}) });
      attachDocument(
        (event) => {
          const pan = panAnchor;
          if (pan === null) return;
          if (Math.abs(event.clientX - pan.clientX) >= MINIMUM_DRAG_PX) pan.moved = true;
          const zoom = state.zoom;
          if (zoom <= 1) return;
          const rect = plotRect();
          if (rect === null || rect.width <= 0) return;
          // 累加起点用按下那一刻的 offset（不是每帧的 state.offset，否则不跟手）
          const next = clampOffset(pan.offset - (event.clientX - pan.clientX) / rect.width / zoom, zoom);
          if (next === state.offset) return;
          publish({ offset: next, animateViewport: false, followPending: false });
        },
        (event) => endDrag(event.clientX),
      );
    },
    zoomAtCursor(clientX: number, deltaY: number, maxZoom: number): void {
      const anchorScreen = screenFraction(clientX);
      const anchorDomain = state.offset + anchorScreen / state.zoom;
      // 官方那行是 `Math.exp(deltaY * 0.0015)`，乘在**域跨度**上：向上滚（deltaY<0）
      // 域变小 = 放大。这里的 `zoom` 是放大倍数，所以要取倒数。
      const factor = Math.exp(-deltaY * 0.0015);
      const next = Math.min(Math.max(1, maxZoom), Math.max(1, state.zoom * factor));
      if (next === state.zoom) return;
      publish({
        zoom: next,
        offset: clampOffset(anchorDomain - anchorScreen / next, next),
        animateViewport: false,
        followPending: false,
      });
    },
    panTo(offset: number): void {
      publish({ offset: clampOffset(offset, state.zoom), animateViewport: false, followPending: false });
    },
    edgePanAt(clientX: number): boolean {
      const element = plot.current;
      const zoom = state.zoom;
      if (element === null || zoom <= 1) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0) return false;
      const localX = clientX - rect.left;
      const edgeWidth = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION));
      const direction = localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0;
      if (direction === 0) return false;
      const edgeDistance =
        direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
      const strength = Math.min(1, Math.max(0, edgeDistance / edgeWidth));
      const next = clampOffset(
        state.offset + (direction * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength)) / zoom,
        zoom,
      );
      if (next === state.offset) return false;
      publish({ offset: next, animateViewport: false, followPending: false });
      return true;
    },
    resetViewport(): void {
      publish({ zoom: 1, offset: 0, animateViewport: false, followPending: false });
    },
    followSelected(positions: readonly TrajectorySpanBox[]): boolean {
      if (!state.followPending) return false;
      const index = state.record;
      const span = index === undefined ? undefined : positions.find((entry) => entry.cellIndex === index);
      if (span === undefined) {
        publish({ followPending: false });
        return false;
      }
      const next = trajectoryFollowOffset(span, state.zoom, state.offset);
      if (next === null) {
        publish({ followPending: false });
        return false;
      }
      publish({ offset: next, animateViewport: true, followPending: false });
      return true;
    },
    domainAt,
    syncSpans(next: readonly TrajectorySpanBox[]): void {
      spans = next;
    },

    inspectCall(callId: string): void {
      publish({ pendingCallId: callId, focusRevision: state.focusRevision + 1 });
    },
    resolveFocus(index: number | undefined): boolean {
      if (state.pendingCallId === undefined) return false;
      // 未命中：什么都不做，把请求留着等账本补齐（官方 `target === undefined` 那一支）
      if (index === undefined) return false;
      interaction.openRecord(index);
      publish({ pendingCallId: undefined });
      return true;
    },
    setQuery(query: string): void {
      publish({ query });
    },
    toggleTurn(turn: number): void {
      const next = new Set(state.collapsedTurns);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      publish({ collapsedTurns: next });
    },
    expandTurn(turn: number): void {
      if (!state.collapsedTurns.has(turn)) return;
      const next = new Set(state.collapsedTurns);
      next.delete(turn);
      publish({ collapsedTurns: next });
    },
    toggleCall(id: string): void {
      const next = new Set(state.collapsedCalls);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      publish({ collapsedCalls: next });
    },
    expandCall(id: string): void {
      if (!state.collapsedCalls.has(id)) return;
      const next = new Set(state.collapsedCalls);
      next.delete(id);
      publish({ collapsedCalls: next });
    },
    toggleAllTurns(turns: readonly number[]): void {
      const all = turns.length > 0 && turns.every((turn) => state.collapsedTurns.has(turn));
      publish({ collapsedTurns: all ? new Set<number>() : new Set(turns) });
    },
    toggleAllCalls(ids: readonly string[]): void {
      const all = ids.length > 0 && ids.every((id) => state.collapsedCalls.has(id));
      publish({ collapsedCalls: all ? new Set<string>() : new Set(ids) });
    },
    setSession(next: string | undefined): void {
      // 同一个会话 id 再赋值是**空操作**：那是一次无关重渲染，不许打断进行中的手势
      // （生命期验收里这一条是绿项，别顺手「统一处理」掉）。
      if (next === state.sessionId) return;
      // 跨会话：公开状态重置**之外**，闭包资源也要收（锚点 + 监听）——见 `cancelGesture`。
      cancelGesture();
      // 旧会话的**几何**同样是跨身份状态：清掉之后「最近一条 / 选区第一条」这类判定在
      // 新几何同步进来之前什么都不做（fail-quiet），而不是拿旧会话的条去算新会话的落点。
      // 真实组件下一次 commit 的 `port.syncSpans(timeline.spans)` 就会把它补上。
      // 落点票据（`revealNonce` / `appliedRevealNonce`）刻意**不清**：它只增不减，
      // 清零会让旧 nonce 重新可用（重复消费同一个落点）。**未收尾**的那张票据则要清：
      // 它记的是上一个会话的行与几何，拿去补新会话的滚动位置是错的。
      revealSettle = null;
      spans = [];
      publish(initialState(next));
    },
  };

  return interaction;
}

/**
 * 最小选区宽度（域单位；官方 `minimumSelectionDuration`）：取「视口跨度」与
 * 「一条记录的平均跨度」里更小的那个。缩得越深，最小选区越窄。
 * @param spanCount - 时间线上的记录条数。
 * @param zoom - 当前放大倍数。
 * @returns 最小选区宽度（0..1 的域单位）。
 */
export function minimumSelection(spanCount: number, zoom: number): number {
  const perRecord = spanCount > 0 ? 1 / spanCount : 1;
  return Math.min(1 / Math.max(1, zoom), perRecord);
}

/**
 * 以 `center` 为中心的一条最小选区（官方 `centeredRange`，夹在域内）。
 * @param center - 域位置（0..1）。
 * @param width - 选区宽度（域单位）。
 * @returns 夹在 `[0, 1]` 里的区间。
 */
export function trajectoryCenteredRange(center: number, width: number): TrajectoryFractionRange {
  const start = Math.min(Math.max(center - width / 2, 0), Math.max(0, 1 - width));
  return { start, end: start + width };
}

/**
 * 离这个域位置最近的记录（官方点空白时聚焦它）。
 * @param spans - 时间线上的条（按域位置）。
 * @param at - 域位置（0..1）。
 * @returns 最近那条的记录序号；一条都没有时 `undefined`。
 */
export function trajectoryNearestSpanIndex(
  spans: readonly TrajectorySpanBox[],
  at: number,
): number | undefined {
  let best: TrajectorySpanBox | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const right = span.left + span.width;
    const distance = at < span.left ? span.left - at : at > right ? at - right : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = span;
    }
  }
  return best?.cellIndex;
}

/**
 * 选中条要留在视口里时视口该挪到哪儿（官方那段 `selectedIndex` effect 的算术）。
 * @param span - 选中的条。
 * @param zoom - 当前放大倍数。
 * @param offset - 当前视口左边界。
 * @returns 新的视口左边界；已经完整落在视口里时 `null`（不动，免得晃）。
 */
export function trajectoryFollowOffset(
  span: TrajectorySpanBox,
  zoom: number,
  offset: number,
): number | null {
  const right = span.left + span.width;
  if (span.left >= offset && right <= offset + 1 / zoom) return null;
  const center = (span.left + right) / 2;
  const maxOffset = Math.max(0, 1 - 1 / zoom);
  return Math.min(maxOffset, Math.max(0, center - 0.5 / zoom));
}

/**
 * React 侧的绑定：建一次端口、订阅它的快照、跟着 `sessionId` 重置、卸载时摘监听。
 * @param sessionId - 当前会话 id（变了整份重置）。
 * @returns 与测试共用的那一个端口对象。
 */
export function useTrajectoryInteraction(sessionId: string | undefined): TrajectoryInteraction {
  const port = useMemo(() => createTrajectoryInteraction(sessionId), []);
  useSyncExternalStore(
    port.subscribe,
    () => port.state,
    () => port.state,
  );
  useEffect(() => {
    port.setSession(sessionId);
  }, [port, sessionId]);
  useEffect(() => () => port.dispose(), [port]);
  return port;
}
