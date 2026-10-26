/**
 * 阅读定位（reading placement）：**一次阅读动作**的唯一实现。
 *
 * 「阅读动作」= 把视口落到一个阅读目标上，落在哪里由两种**刻意分开**的几何策略决定，
 * 不抹平：
 *
 * - **落到某一行**（轮次横条）：行顶停在滚动区顶部下方 `LAND_OFFSET_PX`（官方
 *   `landOnRow` 的几何）。行还要取历史时先挂一个**延期目标**，取回来之后再落位；
 *   落位之后**继续跟踪到布局稳定**（代码高亮 / Markdown / 图片 / 折叠都是异步变高的，
 *   只落位一次会被它们推走），观察窗 `TRACK_FRAMES` 帧，用户一有滚动手势立刻让位。
 * - **把一处命中带到可见处**（查找条）：命中若在折叠气泡里先点开它的展开按钮
 *   （只点带 `aria-expanded` 的那一颗，见 `expandClamped`），目标 Range 的矩形在
 *   **两帧之后**才量（第一帧等 React 提交，第二帧才是展开后的布局），按矩形顶部与
 *   端口高度的差居中。
 *
 * 时序不变量全部在这一层，调用方**不需要、也不许**自己记顺序：
 *
 * 1. **先放跟随，再写视口**：程序化滚动不算手势（`autoScroll` 的意愿只由手势翻），
 *    不放的话下一次 settle 会把视口钉回底部，落位等于没落。取历史那条路更严——
 *    请求本身要先放跟随（取回的补偿会让视口落在（近）底部，settle 从那里把意愿翻
 *    回来），取回来落位之前还要**再放一次**（`commitRow` 里那次）。
 * 2. **没有合法目标就不动视口、不放跟随**：行不在 DOM 里、Range 取不到宿主元素、
 *    滚动区不在场——不写视口，**也不放跟随**（否则一次白点的点击会顺手关掉实况跟随）。
 *    这不等于「动作什么都没做」：横条那两条定位动作在端口在场时仍会作废上一个延期目标
 *    与在飞的跟踪（一次只允许有一个阅读意图）；只有端口层面就早退的那两种（滚动区 /
 *    正文列表不在场、Range 没有宿主元素）连这一步都不做。
 *    也不包括「展开之后命中仍不可见」（矩形高 0）：那时跟随已经放了，动作只把视口留在
 *    原处（既有行为，见 `revealMatch` 里的收手分支）。
 * 3. **过期目标不许再写视口**：`cancel()`（切会话 / 面板切换 / 卸载）与任何新动作都会
 *    把在飞的帧、延期目标与跟踪一起作废；迟到的帧回调靠**代次**认出自己已经过期，
 *    另外还要求「当初那个滚动区仍是端口里的那一个」（面板切换会换掉/摘掉它）。
 *
 * 输入面只有一个端口（`AutoScrollPort`：滚动区 / 正文列表 / 放跟随），DOM 与帧源走可
 * 注入的 `ReadingEnv`——断言脚本喂假实现，于是监听器接线、两帧延期、手势中断、跟踪
 * 收手与清理都能**真跑**一遍（见 `scripts/readingPlacement.test.ts`）。
 */

import { useEffect, useMemo, type MutableRefObject } from "react";
import type { AutoScrollPort } from "./autoScroll";
import { anchorElement, flowTop } from "./turnRail";

/**
 * 落位时行顶停在滚动区顶部下方多少像素（官方 `landOnRow` 的 24）。
 *
 * 这是**落位几何**、与容器量无关，也不进贴底阈值那条账——与改前同值，任何界面倍率下
 * 的落点都与改前一致。
 */
export const LAND_OFFSET_PX = 24;
/** 落位跟踪的观察窗（帧数，≈5s）：够覆盖慢图片 / 慢高亮，又不会长期占着视口。 */
export const TRACK_FRAMES = 300;
/** 跟踪写入的偏差容差（px）：已对齐时每帧都写会跟用户的滚动打架。 */
const DRIFT_TOLERANCE_PX = 1;

/** 一次定位要落到的行：行每次都要重新找（React 会换掉行元素）。 */
export interface RowTarget {
  /** 此刻的锚点行 id；`null` = 还没进 DOM（延期目标靠它逐次重试）。 */
  resolve(): string | null;
  /** 视口**真的**被写时回调（落位那一次与跟踪期间的每次写入）。 */
  placed?: () => void;
}

/** 阅读定位要的宿主环境：生产用真实 DOM / rAF，断言脚本喂假实现。 */
export interface ReadingEnv {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  /** 行顶在滚动区坐标系里的位置（视口无关）。 */
  flowTop(row: HTMLElement, scrollport: HTMLElement): number;
  /** 命中 Range 的矩形（判定可见性 + 居中）。 */
  rangeRect(range: Range): { top: number; height: number };
  /** 按 messageId 在正文列表里找锚点行。 */
  anchorRow(list: HTMLElement, messageId: string): HTMLElement | null;
  /**
   * 命中所在的用户气泡若被折叠，先点开它的展开按钮。
   *
   * 必须**点按钮**（带 `aria-expanded` 的那一颗）而不是自己撕 class：`is-clamped` 是
   * React 状态画的，手改 class 撑不过下一次渲染。展开按钮与失败回显行的「重发 / 撤回」
   * 共用 `msg-expand` 类，所以选择器必须带上 `aria-expanded`。
   *
   * 折叠态落在 `.bubble` 上，夹的却是气泡里的正文 `.bubble-text`（附件不折叠，见
   * `Message.tsx` 的 `UserBubble`），所以命中的宿主节点要往上找到气泡再判。
   */
  expandClamped(anchor: HTMLElement): void;
}

/** 生产环境：真实 rAF 与真实 DOM 查询（查询实现与横条数据层同一份）。 */
export const defaultReadingEnv: ReadingEnv = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => {
    cancelAnimationFrame(handle);
  },
  flowTop: (row, scrollport) => flowTop(row, scrollport),
  rangeRect: (range) => {
    const rect = range.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  },
  anchorRow: (list, messageId) => anchorElement(list, messageId),
  expandClamped: (anchor) => {
    const bubble = anchor.closest(".bubble");
    if (bubble === null || !bubble.classList.contains("is-clamped")) return;
    bubble
      .closest(".msg")
      ?.querySelector<HTMLButtonElement>(".msg-expand[aria-expanded]")
      ?.click();
  },
};

/**
 * 一条阅读链路的唯一端口：滚谁（两个 ref）、放跟随（由动作内部使用，不外露成第二个
 * 释放通道）、以及全部阅读动作。
 *
 * 每个方法都是**一次完整动作**：自己判定目标是否有效、自己先放跟随、自己写几何、
 * 自己起停跟踪、自己按代次丢掉过期回调。调用方只交目标，不接触 rect / rAF / 释放。
 *
 * 消费方（轮次横条、查找条）从**同一个**端口取「滚动区 / 正文列表 / 动作」，不再各自
 * 接一半——规则一旦跟着 prop 散开，加一处动作就得动所有调用点。
 */
export interface ReadingPort {
  /** 会话滚动区（`.chat-scroll`）：定位的坐标系。 */
  readonly scrollEl: MutableRefObject<HTMLDivElement | null>;
  /** 正文列表（`.chat-list`）：锚点行与查找范围的根。 */
  readonly contentEl: MutableRefObject<HTMLDivElement | null>;
  /** 首枚刻点：置顶。顶部没有还能再变高的东西，落完即稳，不跟踪。 */
  toTop(): boolean;
  /**
   * 落到一个**已加载**目标行（落位 + 跟踪到布局稳定）。
   *
   * 目标行此刻不在 DOM 里时不写视口、不放跟随；但这一次调用已经**接手**了阅读意图，
   * 上一个延期目标与在飞的跟踪会被作废（`toTop` / `revealMatch` 同理）。
   */
  landRow(target: RowTarget): boolean;
  /** 窗口外轮次：放跟随 → 取历史；行取回后由 `commitRow` 落位。 */
  awaitRow(target: RowTarget, fetch: () => void): boolean;
  /** 窗口外首枚刻点：放跟随 → 取历史；宿主说取完了由 `settleHistory` 置顶。 */
  awaitTop(fetch: () => void): boolean;
  /** 每次布局提交试一次延期落位；返回是否真的落了位。 */
  commitRow(): boolean;
  /** 宿主说「取完了」：待置顶的就置顶，取不回来的延期目标就此放弃。 */
  settleHistory(): void;
  /**
   * 把一处命中带到可见处并居中（折叠先展开、放跟随、两帧后量布局）。
   *
   * 没有宿主元素时连展开与放跟随都不做（也没接手动作，不作废旧延期目标）；
   * 展开之后命中仍不可见时跟随已经放了，只是不写视口。
   */
  revealMatch(range: Range): boolean;
  /** 取消在飞的一切（切会话 / 面板切换 / 卸载 / 新动作），迟到的回调不再写视口。 */
  cancel(): void;
}

/**
 * 建端口：跟随释放走 `AutoScrollPort.release()`（唯一一条「程序化滚动先放跟随」的
 * 通道），两个 ref 直接借自它——于是这条链路依旧只有**一个**需要装配的对象。
 */
export function createReadingPort(
  port: AutoScrollPort,
  env: ReadingEnv = defaultReadingEnv,
): ReadingPort {
  /**
   * 延期目标：窗口外轮次在等历史（`row`）或等置顶（`top`）。
   *
   * 它同时是「一次动作只可能有一个」的落点：任何新动作都会把它丢掉
   * （`invalidate`），只有 `commitRow` / `settleHistory` 消费它。
   */
  let deferred: { kind: "top" } | { kind: "row"; target: RowTarget } | null = null;
  /** 变更代次：已排队的帧回调靠它认出「自己已经被新动作 / 切会话作废」。 */
  let epoch = 0;
  /** 在飞的帧链的取消器（居中那条链要用两次 rAF）。 */
  let inFlight: (() => void) | null = null;
  /** 正在跟踪的落位：停止函数（`null` = 没在跟踪）。 */
  let tracking: (() => void) | null = null;

  const scrollport = (): HTMLDivElement | null => port.scrollEl.current;
  const content = (): HTMLDivElement | null => port.contentEl.current;
  /** 两个元素都在场才谈得上定位（与横条原有的早退同一条判据）。 */
  const ready = (): boolean => scrollport() !== null && content() !== null;

  function stopInFlight(): void {
    inFlight?.();
    inFlight = null;
  }
  function stopTracking(): void {
    tracking?.();
    tracking = null;
  }
  /** 新动作开始：作废在飞的帧与跟踪，并放弃上一个延期目标。 */
  function invalidate(): void {
    epoch += 1;
    stopInFlight();
    stopTracking();
    deferred = null;
  }

  /**
   * 落位：行顶停在滚动区顶部下方 `LAND_OFFSET_PX`。
   *
   * **先放跟随再写**是这条链路的全部意义——settle 的「回到近底部即恢复跟随」会把
   * 程序化滚动当成布局事故拉回底部。目标无效时在放跟随**之前**返回。
   */
  function placeRow(target: RowTarget): boolean {
    const el = scrollport();
    const list = content();
    if (el === null || list === null) return false;
    const messageId = target.resolve();
    if (messageId === null) return false;
    const row = env.anchorRow(list, messageId);
    if (row === null) return false;
    port.release();
    el.scrollTop += env.flowTop(row, el) - LAND_OFFSET_PX;
    target.placed?.();
    trackRow(target, epoch, el, list, messageId);
    return true;
  }

  /**
   * 落位之后继续盯着目标行，直到布局**稳定**为止。
   *
   * 收手条件：跑满观察窗，或用户一有滚动手势立刻停。不用「已对齐就提前收手」——
   * 实测那一版会漏掉慢内容（撑开发生在落位之后约 270ms，跟踪 200ms 就撤了，偏差照旧）。
   */
  function trackRow(
    target: RowTarget,
    token: number,
    el: HTMLDivElement,
    list: HTMLDivElement,
    messageId: string,
  ): void {
    stopTracking();
    let cached: HTMLElement | null = null;
    let frames = 0;
    let stopped = false;
    let raf: number | null = null;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (raf !== null) env.cancelFrame(raf);
      raf = null;
      el.removeEventListener("wheel", onGesture);
      el.removeEventListener("touchstart", onGesture);
      el.removeEventListener("keydown", onGesture);
    };
    function onGesture(): void {
      stop();
    }
    const tick = (): void => {
      if (stopped || token !== epoch) return;
      // 滚动区换人（面板切换 / 重挂）→ 这一轮跟踪盯的是旧元素，收手
      if (scrollport() !== el) {
        stop();
        return;
      }
      frames += 1;
      // 行被 React 换掉时按 id 重新找（id 由轮次 / seq 派生，稳定）
      if (cached !== null && !cached.isConnected) cached = null;
      if (cached === null) cached = env.anchorRow(list, messageId);
      if (cached !== null) {
        // 只在真的偏了才写 scrollTop：已对齐时每帧都写会跟用户的滚动打架
        const drift = env.flowTop(cached, el) - LAND_OFFSET_PX;
        if (Math.abs(drift) > DRIFT_TOLERANCE_PX) {
          el.scrollTop += drift;
          target.placed?.();
        }
      }
      if (frames >= TRACK_FRAMES) {
        stop();
        return;
      }
      raf = env.requestFrame(tick);
    };
    el.addEventListener("wheel", onGesture, { passive: true });
    el.addEventListener("touchstart", onGesture, { passive: true });
    el.addEventListener("keydown", onGesture);
    tracking = stop;
    raf = env.requestFrame(tick);
  }

  function toTop(): boolean {
    if (!ready()) return false;
    invalidate();
    const el = scrollport();
    if (el === null) return false;
    port.release();
    el.scrollTop = 0;
    return true;
  }

  function landRow(target: RowTarget): boolean {
    if (!ready()) return false;
    invalidate();
    return placeRow(target);
  }

  function awaitRow(target: RowTarget, fetch: () => void): boolean {
    if (!ready()) return false;
    invalidate();
    // 请求历史之前先放跟随（见文件头第 1 条）；取回来落位时 `commitRow` 会再放一次
    port.release();
    deferred = { kind: "row", target };
    fetch();
    return true;
  }

  function awaitTop(fetch: () => void): boolean {
    if (!ready()) return false;
    invalidate();
    port.release();
    deferred = { kind: "top" };
    fetch();
    return true;
  }

  function commitRow(): boolean {
    if (deferred === null || deferred.kind !== "row") return false;
    if (!placeRow(deferred.target)) return false;
    deferred = null;
    return true;
  }

  function settleHistory(): void {
    const pending = deferred;
    deferred = null;
    if (pending === null || pending.kind !== "top") return;
    const el = scrollport();
    if (el === null) return;
    // 置顶同样必须先放跟随，否则 rAF 里的 settle 会把它钉回底部（实测：置顶到 0 又被钉回）
    port.release();
    el.scrollTop = 0;
  }

  /**
   * 把一处命中带到可见处并居中——**展开 + 放跟随 + 两帧等待 + 居中**是一次动作。
   *
   * 顺序不能拆给调用方：展开必须先落进布局（第一帧等 React 提交、第二帧才是展开后的
   * 布局），而放跟随必须早于任何写视口，否则展开引发的重排会让 settle 把视口钉回底部。
   *
   * 居中用**命中 Range 自己**的矩形（展开提交之后量）：气泡展开后有十几行，以气泡顶为
   * 居中目标的话命中行仍可能留在折叠视口之下。
   *
   * 两类「不写视口」刻意分开：
   * - **没有合法目标**（滚动区不在场 / Range 取不到宿主元素 / 元素已断开）：完全不动，
   *   连跟随都不放（端口层面就早退，也不碰旧延期目标与跟踪）；
   * - **展开之后命中仍不可见**（矩形高 0，没有可点的展开钮）：跟随已经放了，视口留在
   *   原处——既有行为，不在这里顺手补一次滚动。
   */
  function revealMatch(range: Range): boolean {
    const el = scrollport();
    const anchor = range.startContainer.parentElement;
    // 没有合法目标 = 完全不动：不放跟随、不展开、不排帧
    if (el === null || anchor === null || !anchor.isConnected) return false;
    invalidate();
    const token = epoch;
    env.expandClamped(anchor);
    port.release();
    let stopped = false;
    let frame: number | null = null;
    /**
     * 收手：摘掉两帧等待期的监听并取消还没跑的帧。
     *
     * 用户手势也要走这里——两帧之间读者自己滚了，就不该再把视口拽到命中处
     * （与跟踪那条「手势立刻让位」同一条纪律）。
     */
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (frame !== null) env.cancelFrame(frame);
      frame = null;
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("keydown", stop);
    };
    inFlight = stop;
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("keydown", stop);
    const commit = (): void => {
      frame = null;
      // 过期（切会话 / 面板切换 / 新动作）或滚动区已经换人：一律不再写视口
      if (stopped || token !== epoch) return;
      if (scrollport() !== el) {
        stop();
        return;
      }
      if (!anchor.isConnected) {
        stop();
        return;
      }
      const rect = env.rangeRect(range);
      if (rect.height === 0) {
        // 展开之后仍不可见（没有可点的展开钮）：不动视口
        stop();
        return;
      }
      el.scrollTop += rect.top - el.getBoundingClientRect().top - el.clientHeight / 2;
      stop();
    };
    // 第一帧等 React 提交，第二帧量到的才是展开后的布局
    frame = env.requestFrame(() => {
      if (stopped || token !== epoch) return;
      frame = env.requestFrame(commit);
    });
    return true;
  }

  function cancel(): void {
    invalidate();
  }

  return {
    scrollEl: port.scrollEl,
    contentEl: port.contentEl,
    toTop,
    landRow,
    awaitRow,
    awaitTop,
    commitRow,
    settleHistory,
    revealMatch,
    cancel,
  };
}

/**
 * 会话页拿到的阅读定位端口。
 *
 * 身份稳定（`AutoScrollPort` 恒定），所以它可以安全地进 effect 依赖与下游
 * `useCallback`。卸载时把在飞的帧 / 跟踪 / 延期目标一律作废——迟到的回调不许再写视口。
 *
 * 切会话与面板切换的作废由持有横条的那个 hook 一并触发（那条 effect 里本来就要清它
 * 自己的 React 状态）；这里只管卸载这一条。
 */
export function useReadingPort(port: AutoScrollPort): ReadingPort {
  const reading = useMemo(() => createReadingPort(port), [port]);
  useEffect(
    () => () => {
      reading.cancel();
    },
    [reading],
  );
  return reading;
}
