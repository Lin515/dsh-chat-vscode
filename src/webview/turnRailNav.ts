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
 *    窗口外的轮次先取历史（本扩展的 `loadMore` 一路取到底），等锚点行渲染出来
 *    再落位——官方的 pendingJump 机制，这里按「一次取完」的粒度简化：
 *    多页连取期间的视口钉住复用 `useHistoryPaging` 的高度差补偿（导航走同一个
 *    `loadEarlier` 入口），落位只在目标行出现那一次生效。
 */

/** 贴底判据：与 `useAutoScroll` 的 STICK_THRESHOLD_PX 同一个值。 */
const FOLLOW_THRESHOLD_PX = 40;
/** 落位时行顶停在阅读线下方多少 px（官方 landOnRow 的 24）。 */
const LAND_OFFSET_PX = 24;

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
): readonly TurnRailItem[] {
  const previousRef = useRef<readonly TurnRailItem[]>([]);
  return useMemo(() => {
    const merged = reuseTurnRailItems(previousRef.current, mergeTurnRailItems(messages, outline));
    previousRef.current = merged;
    return merged;
  }, [messages, outline]);
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
  loadEarlier,
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
  loadEarlier: () => void;
}): TurnRailNav {
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);
  /** 未加载轮次的跳转：等锚点行渲染出来再落位。 */
  const pendingJumpRef = useRef<number | null>(null);
  // effect / 回调里读到的必须是最新值——items 与 releaseFollow 每次渲染都可能换新
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const releaseRef = useRef(releaseFollow);
  releaseRef.current = releaseFollow;
  const loadEarlierRef = useRef(loadEarlier);
  loadEarlierRef.current = loadEarlier;

  const setActiveTurnStable = useCallback((turn: number) => {
    setActiveTurn((current) => (current === turn ? current : turn));
  }, []);

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

  // ---- 2. 未加载轮次的落位：锚点行一渲染出来就跳过去 ----
  // 没写依赖数组：连取历史期间每落一页都会换一次 messages，要在每次渲染后试一次；
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
    landOnRow(el, row, item.turn, setActiveTurnStable);
  });
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
    setBusyTurn((current) => (current === null ? current : null));
    setActiveTurn(null);
  }, [sessionId]);

  // ---- 3. 点击刻点 ----
  const navigate = useCallback(
    (item: TurnRailItem): void => {
      const el = scrollRef.current;
      const list = listRef.current;
      if (!el || !list) return;
      if (item.anchor.kind === "unloaded") {
        // 生成中宿主会拒绝翻历史（toast「生成中不能翻历史」），别把脉冲挂上一个
        // 永远不落位的目标；也没有更早的历史时，这个刻点根本不该是未加载态
        // （防御：直接不动）。这两条都在**放掉跟随之前**判——no-op 的点击不能
        // 顺手把实况跟开关掉。
        if (running || !hasMoreHistory) return;
        // 跳进历史 = 离开实况尾部：点击这一刻就放掉跟随（官方同一条注释——
        // 不放的话贴底跟随会把第一次 prepend 的补偿当成布局事故拉回底部）。
        releaseRef.current?.();
        pendingJumpRef.current = item.turn;
        setBusyTurn(item.turn);
        // 走 useAutoScroll 的同一条入口：连取期间的视口钉住（高度差补偿）由它管
        loadEarlierRef.current?.();
        return;
      }
      const row = anchorElement(list, item.anchor.messageId);
      if (row === null) return;
      // 已加载刻点的点击顶掉还在取历史的跳转
      pendingJumpRef.current = null;
      setBusyTurn((current) => (current === null ? current : null));
      releaseRef.current?.();
      landOnRow(el, row, item.turn, setActiveTurnStable);
    },
    [scrollRef, listRef, running, hasMoreHistory, setActiveTurnStable],
  );

  return { activeTurn, busyTurn, navigate };
}
