import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { MessageView } from "../shared/chat";
import {
  anchorElement,
  anchorTurnIndex,
  flowTop,
  mergeTurnRailItems,
  sameTurnRailItem,
  turnAtLine,
  type TurnRailItem,
} from "./turnRail";

/**
 * 轮次横条与滚动区的**胶水**（两条链路，官方 ChatView 各有一条对应物）：
 *
 * 1. **激活轮跟踪**：按滚动位置算出「读者正在看哪一轮」，横条据此点亮刻点。
 *    官方的 `syncActiveTurn` / `turnAtLine`——贴底恒亮最新一轮；否则在阅读线
 *    （视口顶部往下 96px / 视口高的 20%）上做命中测试。
 * 2. **跳转**：已加载轮次直接滚到锚点行（行顶落在阅读线下 24px，官方 `landOnRow`）；
 *    窗口外的轮次先取历史（`loadThrough(seq)`：宿主按目标 seq 循环翻页，就是官方
 *    `ISession.loadThrough` 那条语义），取完再定位。定位分两种：
 *    - **目录第一枚刻点一律置顶**（`scrollTop = 0`，用户 2026-09-20 口径）——它是唯一
 *      需要取历史的那个，取回后目标行上方还会插入内容，与其事后校正不如直接停顶部；
 *    - **其他轮次落位到锚点行**，并在之后**继续跟踪到布局稳定**（见 `trackLanding`）：
 *      加载进来的内容里有**异步变高**的部分（代码高亮 / Markdown / 图片 / 折叠），
 *      只落位一次会被它们推走。
 *    两种定位**都必须先放掉跟随**——取历史的补偿会让视口落在（近）底部，而
 *    `autoScroll` 的「回到近底部即恢复跟随」会把意愿翻回去，rAF 里的 `settle()`
 *    随即 `scrollTop = scrollHeight`，把刚算好的位置整个吃掉（详见各自的调用点）。
 */

/** 贴底判据：与 `useAutoScroll` 的 STICK_THRESHOLD_PX 同一个值。 */
const FOLLOW_THRESHOLD_PX = 40;
/** 落位时行顶停在阅读线下方多少 px（官方 landOnRow 的 24）。 */
const LAND_OFFSET_PX = 24;
/** 落位跟踪的观察窗（帧数，≈5s）：够覆盖慢图片 / 慢高亮，又不会长期占着视口。 */
const TRACK_FRAMES = 300;

/**
 * 合并横条刻度，并**复用内容相同的旧项**。
 *
 * 流式期间消息数组每次 delta 都换新引用，`mergeTurnRailItems` 的输出里只有
 * 最后一轮的响应预览真的在变——不保引用的话，memo 过的横条每个 token 都要
 * 重渲染一遍，激活轮的居中 effect 也会跟着空转。官方靠 `sameTurnNavigationItem`
 * 达到的正是这个目的。复用逻辑抽成纯函数（`reuseTurnRailItems`），断言见
 * `scripts/turnRail.test.ts`。
 */
export function reuseTurnRailItems(
  previous: readonly TurnRailItem[],
  next: readonly TurnRailItem[],
): readonly TurnRailItem[] {
  if (previous.length === 0) return next;
  const previousByTurn = new Map(previous.map((item) => [item.turn, item] as const));
  let changed = false;
  const merged = next.map((item) => {
    const old = previousByTurn.get(item.turn);
    if (old !== undefined && sameTurnRailItem(old, item)) return old;
    changed = true;
    return item;
  });
  if (!changed && merged.length === previous.length) return previous;
  return merged;
}

export function useTurnRailItems(
  messages: readonly MessageView[],
  outline: readonly { turn: number; seq: number; prompt: string; response: string }[] | undefined,
  /** 服务端是否还有更早的记录：决定「部分加载」的轮次能否被取回来（见 `mergeTurnRailItems`）。 */
  hasMoreHistory: boolean,
): readonly TurnRailItem[] {
  const previousRef = useRef<readonly TurnRailItem[]>([]);
  return useMemo(() => {
    const merged = reuseTurnRailItems(
      previousRef.current,
      mergeTurnRailItems(messages, outline, hasMoreHistory),
    );
    previousRef.current = merged;
    return merged;
  }, [messages, outline, hasMoreHistory]);
}

/** 行顶落到阅读线下 `LAND_OFFSET_PX` 处（官方 landOnRow 的几何）。 */
function landOnRow(
  scrollport: HTMLElement,
  row: HTMLElement,
  turn: number,
  setActiveTurn: (turn: number) => void,
): void {
  scrollport.scrollTop += flowTop(row, scrollport) - LAND_OFFSET_PX;
  setActiveTurn(turn);
}

export interface TurnRailNav {
  /** 读者正在看的轮（横条点亮它）。 */
  activeTurn: number | null;
  /** 正在取历史的跳转目标（刻点脉冲）。 */
  busyTurn: number | null;
  /** 点击刻点。 */
  navigate: (item: TurnRailItem) => void;
}

export function useTurnRailNav({
  scrollRef,
  listRef,
  items,
  releaseFollow,
  active,
  sessionId,
  running,
  hasMoreHistory,
  historyLoading,
  loadThrough,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  items: readonly TurnRailItem[];
  /** 把「跟随最新」的意愿放掉（程序化滚动不算手势，不会自动放）。 */
  releaseFollow: () => void;
  /** 会话页是否在场（轨迹视图顶掉它时所有监听都要歇）。 */
  active: boolean;
  sessionId: string | undefined;
  running: boolean;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  /** 取到目标 seq 为止（官方 `loadThrough`）：点未加载刻点时用它先补历史。 */
  loadThrough: (seq: number) => void;
}): TurnRailNav {
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);
  /** 未加载轮次的跳转：等锚点行渲染出来再落位。 */
  const pendingJumpRef = useRef<number | null>(null);
  /**
   * 这次跳转要**停在最顶部**（用户 2026-09-20 口径：目录第一枚刻点一律置顶）。
   *
   * 第一枚刻点是唯一需要取历史的那个，取回后目标行上方还会插入内容（注入 / 幻影轮）；
   * 与其事后校正，不如直接停在 `scrollTop = 0`——**顶部没有还能再变高的东西，落完即稳**。
   */
  const pendingJumpTopRef = useRef(false);
  // effect / 回调里读到的必须是最新值——items 与 releaseFollow 每次渲染都可能换新
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const releaseRef = useRef(releaseFollow);
  releaseRef.current = releaseFollow;
  const loadThroughRef = useRef(loadThrough);
  loadThroughRef.current = loadThrough;
  const setActiveTurnStable = useCallback((turn: number) => {
    setActiveTurn((current) => (current === turn ? current : turn));
  }, []);

  // ---- 落位之后的跟踪 ----
  /** 正在跟踪的落位：停止函数（`null` = 没在跟踪）。 */
  const trackingRef = useRef<(() => void) | null>(null);
  const stopTracking = useCallback((): void => {
    trackingRef.current?.();
    trackingRef.current = null;
  }, []);
  /**
   * 落位之后继续盯着目标行，直到布局**稳定**为止。
   *
   * 为什么需要它：取回历史时，目标行**上方**会插入内容，其中一部分是**异步变高**的
   * ——代码块高亮、Markdown 渲染、图片解码、折叠展开都不在同一帧里完成。落位只做一次
   * 的话，这些内容会在落位**之后**把目标行往下推（实测：落位 24px，上方撑开 300px 后
   * 目标漂到 258px）。
   *
   * 逐帧读目标行的位置最直接：`row` 缓存住，正常情况下每帧只做一次
   * `getBoundingClientRect`，不遍历 DOM。
   *
   * 收手条件：**跑满观察窗**（`TRACK_FRAMES`），或**用户一有滚动手势立刻停**。
   * 不用「已对齐就提前收手」——实测那一版会漏掉慢内容（撑开发生在落位之后 ~270ms，
   * 而跟踪 200ms 就撤了，偏差照旧）。让位交给手势那一条，跟踪才不会跟用户抢方向盘，
   * 观察窗也才敢放满。
   */
  const trackLanding = useCallback(
    (
      el: HTMLElement,
      list: HTMLElement,
      turn: number,
      messageId: string,
      initial: HTMLElement,
    ): void => {
      stopTracking();
      let cached: HTMLElement | null = initial;
      let frames = 0;
      let raf = 0;
      let stopped = false;
      function stop(): void {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(raf);
        el.removeEventListener("wheel", onGesture);
        el.removeEventListener("touchstart", onGesture);
        el.removeEventListener("keydown", onGesture);
      }
      function onGesture(): void {
        stop();
      }
      function tick(): void {
        if (stopped) return;
        frames += 1;
        // 行被 React 换掉时按 id 重新找（id 由轮次 / seq 派生，稳定）
        if (cached !== null && !cached.isConnected) cached = null;
        const row = cached ?? (cached = anchorElement(list, messageId));
        if (row !== null) {
          // 只在真的偏了才写 scrollTop：已对齐时每帧都写会跟用户的滚动打架
          const drift = flowTop(row, el) - LAND_OFFSET_PX;
          if (Math.abs(drift) > 1) landOnRow(el, row, turn, setActiveTurnStable);
        }
        if (frames >= TRACK_FRAMES) {
          stop();
          return;
        }
        raf = requestAnimationFrame(tick);
      }
      el.addEventListener("wheel", onGesture, { passive: true });
      el.addEventListener("touchstart", onGesture, { passive: true });
      el.addEventListener("keydown", onGesture);
      raf = requestAnimationFrame(tick);
      trackingRef.current = stop;
    },
    [stopTracking, setActiveTurnStable],
  );

  // ---- 1. 激活轮跟踪：scroll + 尺寸变化 → rAF 命中测试一次 ----
  const anchors = useMemo(() => anchorTurnIndex(items), [items]);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  /** 主 effect 建好的 rAF 合并调度器；轮次集合变化时（下面的 effect）也用它补一次。 */
  const scheduleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    let scheduled = false;
    const sync = (): void => {
      scheduled = false;
      const currentItems = itemsRef.current;
      if (currentItems.length === 0) {
        setActiveTurn((current) => (current === null ? current : null));
        return;
      }
      // 贴底 = 看的就是最新一轮（官方先做这个短路）
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap <= FOLLOW_THRESHOLD_PX) {
        const latest = currentItems[currentItems.length - 1]?.turn ?? null;
        setActiveTurn((current) => (current === latest ? current : latest));
        return;
      }
      const line = el.getBoundingClientRect().top + Math.min(96, el.clientHeight * 0.2);
      const reading = turnAtLine(list, line, anchorsRef.current);
      // 阅读线还没够到任何行（罕见）→ 首轮；读到的轮次若不在横条上（它的节点全被
      // 隐藏了之类），取「≤ 它」的最新一个有刻点的轮次——与官方同一条口径。
      let next = reading ?? currentItems[0]?.turn ?? null;
      if (reading !== null) {
        for (const item of currentItems) {
          if (item.turn > reading) break;
          next = item.turn;
        }
      }
      setActiveTurn((current) => (current === next ? current : next));
    };
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(sync);
    };
    scheduleRef.current = schedule;
    const onScroll = (): void => schedule();
    el.addEventListener("scroll", onScroll, { passive: true });
    // 内容长高 / 端口变矮都不带 scroll 事件（贴底时跟随滚动是另一条链管的），
    // 激活轮的命中测试也要补一次
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(el);
      observer.observe(list);
    }
    schedule();
    return () => {
      scheduleRef.current = null;
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [active, sessionId, scrollRef, listRef]);

  // 轮次集合变了（新一轮开始、历史取回、横条从隐藏变显示）也要补一次判定。
  // 不能只靠 scroll/RO：内容比端口矮时连高度都不变，ResizeObserver 也不响——
  // 实测两条消息的会话里发出第二轮，刻点已经画出来了，亮的还是第一轮。
  useEffect(() => {
    if (!active) return;
    scheduleRef.current?.();
  }, [items, active]);

  // ---- 2. 窗口外轮次的落位：锚点行一渲染出来就跳过去 ----
  // 没写依赖数组：取历史的结算会换一次 messages，要在每次渲染后试一次；
  // 空闲时的常态开销只是「pendingJump 为 null → 早退」。
  useLayoutEffect(() => {
    const turn = pendingJumpRef.current;
    if (turn === null) return;
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const item = itemsRef.current.find((candidate) => candidate.turn === turn);
    if (item === undefined || item.anchor.kind !== "loaded") return;
    const row = anchorElement(list, item.anchor.messageId);
    if (row === null) return;
    pendingJumpRef.current = null;
    setBusyTurn((current) => (current === null ? current : null));
    // **落位前必须再放一次跟随**（点击时那次不够）：取历史的补偿把视口落在（近）底部，
    // `scroll()` 的「回到近底部即恢复跟随」会把意愿翻回 true，紧接着 rAF 里的
    // `settle()` 就 `scrollTop = scrollHeight`，把这次落位吃掉。
    releaseRef.current?.();
    landOnRow(el, row, item.turn, setActiveTurnStable);
    trackLanding(el, list, item.turn, item.anchor.messageId, row);
  });
  /**
   * 第一枚刻点的置顶：**等宿主说「取完了」就跳**（`historyLoading` 落回 false），
   * 不看该轮是否变成 loaded。
   *
   * 为什么不等 loaded：那条判据要绕一圈（messages → items → anchor.kind），实战里常常
   * 等不到——于是脉冲空转、视口一动不动，用户「等加载完成了再点一次」才好（那时数据
   * 已在窗口里，判据立刻成立）。`historyLoading` 落回 false 才是宿主对「取完了」的
   * **直接**声明。
   *
   * 注意 `historyLoading` 从 false → true 的那一帧不会误触：那时它是 true，直接早退。
   * 「点击时就没在取历史」那条路由 `navigate` 的已加载分支立刻置顶。
   */
  useEffect(() => {
    if (historyLoading) return;
    if (!pendingJumpTopRef.current) return;
    pendingJumpTopRef.current = false;
    pendingJumpRef.current = null;
    setBusyTurn((current) => (current === null ? current : null));
    const el = scrollRef.current;
    if (el === null) return;
    // **必须先放掉跟随**：理由与落位那条一样，否则 rAF 里的 settle 会把它钉回底部。
    releaseRef.current?.();
    el.scrollTop = 0;
  }, [historyLoading, scrollRef]);
  // 历史取完还没落位 = 目标取不回来（页数安全阀 / 服务端没给）→ 放弃，别让刻点一直脉冲。
  // 注意：刚点击、宿主的 `historyLoading: true` 还没到时这里不会跑（依赖没变）。
  useEffect(() => {
    if (historyLoading) return;
    if (pendingJumpRef.current === null) return;
    pendingJumpRef.current = null;
    setBusyTurn((current) => (current === null ? current : null));
  }, [historyLoading]);
  // 切会话：未落的跳转对新会话没有意义
  useEffect(() => {
    pendingJumpRef.current = null;
    pendingJumpTopRef.current = false;
    stopTracking();
    setBusyTurn((current) => (current === null ? current : null));
    setActiveTurn(null);
  }, [sessionId, stopTracking]);

  // ---- 3. 点击刻点 ----
  const navigate = useCallback(
    (item: TurnRailItem): void => {
      const el = scrollRef.current;
      const list = listRef.current;
      if (!el || !list) return;
      // 新的一次跳转取消上一次的落位跟踪（它盯的是旧目标）
      stopTracking();
      // 用户 2026-09-20 口径：**目录第一枚刻点一律置顶**（不论它加载了没有）。
      const jumpToTop = itemsRef.current[0]?.turn === item.turn;
      if (item.anchor.kind === "unloaded") {
        // 生成中 / 没有更早历史 / **已经有一次取历史在飞**：一律不动。
        // 最后一条尤其重要——`historyLoading` 同时也是 `start()` 的闸门，不在这里判就会
        // 挂上一个「永远等不到落位」的脉冲，用户看到的就是「点了没反应」。
        if (running || !hasMoreHistory || historyLoading) return;
        releaseRef.current?.();
        if (jumpToTop) {
          // 第一枚刻点不进「落位」那条链，只挂「等宿主说取完了就置顶」（见上面那个 effect）
          pendingJumpTopRef.current = true;
          setBusyTurn(item.turn);
          loadThroughRef.current?.(item.anchor.seq);
          return;
        }
        pendingJumpRef.current = item.turn;
        setBusyTurn(item.turn);
        loadThroughRef.current?.(item.anchor.seq);
        return;
      }
      if (jumpToTop) {
        // 已经加载好的第一枚刻点：立刻置顶，不用等任何东西
        releaseRef.current?.();
        el.scrollTop = 0;
        return;
      }
      const row = anchorElement(list, item.anchor.messageId);
      if (row === null) return;
      // 已加载刻点的点击顶掉还在取历史的跳转
      pendingJumpRef.current = null;
      pendingJumpTopRef.current = false;
      setBusyTurn((current) => (current === null ? current : null));
      releaseRef.current?.();
      landOnRow(el, row, item.turn, setActiveTurnStable);
    },
    [scrollRef, listRef, running, hasMoreHistory, historyLoading, setActiveTurnStable, stopTracking],
  );

  return { activeTurn, busyTurn, navigate };
}
