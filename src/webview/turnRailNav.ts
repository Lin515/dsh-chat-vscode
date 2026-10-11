import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MessageView } from "../shared/chat";
import { atBottom, bottomGap } from "./autoScroll";
import type { ReadingPort, RowTarget } from "./readingPlacement";
import {
  anchorTurnIndex,
  mergeTurnRailItems,
  sameTurnRailItem,
  turnAtLine,
  type TurnRailItem,
} from "./turnRail";

/**
 * 轮次横条与滚动区的**胶水**（两条链路，官方 ChatView 各有一条对应物）：
 *
 * 1. **激活轮跟踪**：按滚动位置算出「读者正在看哪一轮」，横条据此点亮刻点。
 *    官方的 `syncActiveTurn` / `turnAtLine`——贴底恒亮最新一轮（判据与 `autoScroll`
 *    同一份：`atBottom` / `bottomGap`，本文件不再自带一份 40px）；否则在阅读线
 *    （视口顶部往下 96px / 视口高的 20%）上做命中测试。
 * 2. **跳转**：已加载轮次直接滚到锚点行（行顶落在滚动区顶部下方 24px，官方 `landOnRow`）；
 *    窗口外的轮次先取历史（`loadThrough(seq)`：宿主按目标 seq 循环翻页，就是官方
 *    `ISession.loadThrough` 那条语义），取完再定位。定位分两种：
 *    - **目录第一枚刻点一律置顶**（`scrollTop = 0`，用户 2026-09-20 口径）——它是唯一
 *      需要取历史的那个，取回后目标行上方还会插入内容，与其事后校正不如直接停顶部；
 *    - **其他轮次落位到锚点行**，并在之后**继续跟踪到布局稳定**。
 *
 *    两种定位都是**一次完整阅读动作**：先放跟随、再写视口，以及取历史前后各放一次跟随、
 *    无效目标 no-op、过期目标作废，全部在 `readingPlacement.ts` 的端口里。本文件
 *    只保留横条自己的**策略**——点哪一枚刻点、哪一枚置顶、什么时候算「取完了」。
 *    这样调用方不可能把「先释放再落位」这条顺序写错，也不必各自接一半端口。
 */

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

export interface TurnRailNav {
  /** 读者正在看的轮（横条点亮它）。 */
  activeTurn: number | null;
  /** 正在取历史的跳转目标（刻点脉冲）。 */
  busyTurn: number | null;
  /** 点击刻点。 */
  navigate: (item: TurnRailItem) => void;
}

export function useTurnRailNav({
  port,
  items,
  active,
  sessionId,
  hasMoreHistory,
  historyLoading,
  loadThrough,
}: {
  /** 阅读定位端口：滚动区 / 正文列表 / 定位动作全在这一份上。 */
  port: ReadingPort;
  items: readonly TurnRailItem[];
  /** 会话页是否在场（轨迹视图顶掉它时所有监听都要歇）。 */
  active: boolean;
  sessionId: string | undefined;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  /** 取到目标 seq 为止（官方 `loadThrough`）：点未加载刻点时用它先补历史。 */
  loadThrough: (seq: number) => void;
}): TurnRailNav {
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);
  // effect / 回调里读到的必须是最新值——items 与 loadThrough 每次渲染都可能换新
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const loadThroughRef = useRef(loadThrough);
  loadThroughRef.current = loadThrough;
  const setActiveTurnStable = useCallback((turn: number) => {
    setActiveTurn((current) => (current === turn ? current : turn));
  }, []);
  const clearBusy = useCallback(() => {
    setBusyTurn((current) => (current === null ? current : null));
  }, []);

  /**
   * 未加载轮次的延期目标：`resolve` 只给「这一轮的锚点标识」（行还没进来时给 `null`），
   * DOM 查找与重试都在阅读定位端口里，不散回这里。
   */
  const rowTargetOf = useCallback(
    (turn: number): RowTarget => ({
      resolve: () => {
        const item = itemsRef.current.find((candidate) => candidate.turn === turn);
        return item !== undefined && item.anchor.kind === "loaded" ? item.anchor.messageId : null;
      },
      placed: () => setActiveTurnStable(turn),
    }),
    [setActiveTurnStable],
  );

  // ---- 1. 激活轮跟踪：scroll + 尺寸变化 → rAF 命中测试一次 ----
  const anchors = useMemo(() => anchorTurnIndex(items), [items]);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  /** 主 effect 建好的 rAF 合并调度器；轮次集合变化时（下面的 effect）也用它补一次。 */
  const scheduleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!active) return;
    const el = port.scrollEl.current;
    const list = port.contentEl.current;
    if (!el || !list) return;
    let scheduled = false;
    const sync = (): void => {
      scheduled = false;
      const currentItems = itemsRef.current;
      if (currentItems.length === 0) {
        setActiveTurn((current) => (current === null ? current : null));
        return;
      }
      // 贴底 = 看的就是最新一轮（官方先做这个短路）。判据与 `autoScroll` 同一份——
      // 阈值知识只有那一处，本文件不再复制一个 40。
      if (atBottom(bottomGap(el))) {
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
  }, [active, sessionId, port]);

  // 轮次集合变了（新一轮开始、历史取回、横条从隐藏变显示）也要补一次判定。
  // 不能只靠 scroll/RO：内容比端口矮时连高度都不变，ResizeObserver 也不响——
  // 实测两条消息的会话里发出第二轮，刻点已经画出来了，亮的还是第一轮。
  useEffect(() => {
    if (!active) return;
    scheduleRef.current?.();
  }, [items, active]);

  // ---- 2. 窗口外轮次的落位：锚点行一渲染出来就跳过去 ----
  //
  // 切会话 / 面板切换的作废必须排在下面那条落位 effect **之前**（同一次提交里布局
  // effect 按声明顺序跑）：否则换会话后的第一次提交会拿新的 items 去落旧会话的延期目标。
  // 它同时把横条自己的 React 状态清干净，在飞的定位与跟踪由端口作废。
  useLayoutEffect(() => {
    port.cancel();
    clearBusy();
    setActiveTurn(null);
  }, [sessionId, active, port, clearBusy]);

  // 没写依赖数组：取历史的结算会换一次 messages，要在每次渲染后试一次；
  // 空闲时的常态开销只是「端口上没有延期目标 → 早退」。
  useLayoutEffect(() => {
    if (port.commitRow()) clearBusy();
  });

  /**
   * 宿主说「取完了」就结算（`historyLoading` 落回 false）——**不看**该轮是否变成
   * loaded。
   *
   * 为什么不等 loaded：那条判据要绕一圈（messages → items → anchor.kind），实战里常常
   * 等不到——于是脉冲空转、视口一动不动，用户「等加载完成了再点一次」才好（那时数据
   * 已在窗口里，判据立刻成立）。`historyLoading` 落回 false 才是宿主对「取完了」的
   * **直接**声明。
   *
   * 结算两件事：待置顶的首枚刻点此刻置顶；取不回来的延期目标（页数安全阀 / 服务端没给）
   * 就此放弃，别让刻点一直脉冲。没有延期目标时是 no-op。
   *
   * 注意 `historyLoading` 从 false → true 的那一帧不会误触：那时它是 true，直接早退。
   * 「点击时就没在取历史」那条路由 `navigate` 的已加载分支立刻置顶。
   */
  useEffect(() => {
    if (historyLoading) return;
    port.settleHistory();
    clearBusy();
  }, [historyLoading, port, clearBusy]);

  // ---- 3. 点击刻点 ----
  const navigate = useCallback(
    (item: TurnRailItem): void => {
      // 用户 2026-09-20 口径：**目录第一枚刻点一律置顶**（不论它加载了没有）。
      const jumpToTop = itemsRef.current[0]?.turn === item.turn;
      if (item.anchor.kind === "unloaded") {
        // 没有更早的历史 / **已经有一次取历史在飞**：一律不动。
        // 最后一条尤其重要——`historyLoading` 同时也是 `start()` 的闸门，不在这里判就会
        // 挂上一个「永远等不到落位」的脉冲，用户看到的就是「点了没反应」。
        // **生成中不再拦**：官方点未加载刻点也不看 running，宿主那边的重折会把在飞的
        // 流式正文与工具行抄送回去（见 `CarriedLiveOverlay`）。
        // 闸门必须早于任何动作：no-op 的点击不许顺手把实况跟随关掉。
        if (!hasMoreHistory || historyLoading) return;
        const seq = item.anchor.seq;
        const turn = item.turn;
        const fetch = (): void => {
          loadThroughRef.current?.(seq);
        };
        // 「放跟随 → 取历史」在端口里是一步：顺序不可能写错（取回的补偿会被当成
        // 布局事故，先放掉跟随，取回来落位时还会再放一次）
        const started = jumpToTop
          ? port.awaitTop(fetch)
          : port.awaitRow(rowTargetOf(turn), fetch);
        if (started) setBusyTurn(turn);
        return;
      }
      const messageId = item.anchor.messageId;
      // 已加载刻点的点击顶掉还在取历史的跳转（目标已换成本次这一轮）
      if (jumpToTop) {
        // 已经加载好的第一枚刻点：立刻置顶，不用等任何东西
        port.toTop();
      } else {
        port.landRow({ resolve: () => messageId, placed: () => setActiveTurnStable(item.turn) });
      }
      clearBusy();
    },
    [port, hasMoreHistory, historyLoading, setActiveTurnStable, rowTargetOf, clearBusy],
  );

  return { activeTurn, busyTurn, navigate };
}
