import { useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { onHostFrame } from "./bridge";

/**
 * `.chat-scroll` 的**自动滚动**（贴底 / 回底胶囊）——一个模块，一个端口。
 *
 * 2026-09-19 把这条链路从 `App.tsx`（实现）+ `Composer.tsx`（两个 prop）收敛到这里：
 * 规则以前跨三个文件，加一处端口要动所有调用点。现在：
 *
 * - `useAutoScroll(active, sessionId)` 拥有整条链路，返回一个 `AutoScrollBinding`；
 * - 组件从**同一个**绑定取「滚谁 / 放跟随 / 回最新 / 亮不亮胶囊」，不再各自接一半
 *   （`Composer` 只剩一个 `chatScroll` prop）。
 *
 * 行为一个字都没改（2026-09-16 三次修订的定稿口径）：
 *
 * 1. **意愿（`following`）只由输入决定**——距底超过阈值**且**近期有滚动手势
 *    （滚轮 / 触摸 / 键盘 / 拖滚动条）才算"用户要看上面"；位置回到距底容差内、或
 *    用户显式要最新（发消息、切会话、点胶囊）就重新贴上。
 *
 *    为什么不能从几何里推断：`scroll` 事件是**异步**派发的，处理器当场读到的
 *    `scrollTop` 可能来自**已经过去的布局**（位置被浏览器夹过），而 `scrollHeight`
 *    来自**当前布局**——两份不同布局的数据在同一个判断里对不上。旧实现用
 *    "`scrollTop` 变小 ⇒ 用户上滑了"来翻贴底标志，于是浏览器自己夹一下位置
 *    （生成期间任何一次"瞬态塌缩 → 恢复"的重渲染）就被误判成用户上滑；而一旦
 *    `following=false` **再没有任何东西会翻回来**，症状是"最新内容留在视野下方 +
 *    胶囊亮着 + 永不恢复"，且**用户根本没有操作**（2026-09-16 实测复现，见
 *    `test/scroll-probe.html` 的 P1）。同一类还有端口变矮（插话排队条 / 待办面板 /
 *    提示条：`scrollTop` 不变、连 `scroll` 事件都没有）。
 *
 * 2. **只要想跟，就把视口钉在底部**：任何"内容 / 端口 / 可见性可能变了"的信号都只置一个
 *    脏标记，rAF 里**幂等**重贴一次。没有"之前是否在底部"这个记忆值，因此不存在
 *    "某次判定被跳过之后永久停在错误一侧"。
 *
 * 判据是"距底 ≤ `STICK_THRESHOLD_PX`"：内容不足一屏时 `dist ≤ 0`，天然算贴底，
 * `scrollTop` 赋值被浏览器夹回 0，是 no-op（用户口径里"还没出现滚动条"那种情况）。
 */

/** 贴底判据（px）：距底不超过它就算"在看最新"。 */
export const STICK_THRESHOLD_PX = 40;
/** 手势之后多久内算"用户正在滚动"（ms）：滚轮有惯性、键盘会连发，给足余量。 */
export const GESTURE_WINDOW_MS = 400;

/**
 * 滚动容器 + 两个动作，交给消费方的那**一个**端口。
 *
 * 对象的**身份是稳定的**（`useAutoScroll` 只建一次）：装进去的两个 ref 恒定，
 * `release` / `pin` 都读 `ref.current`。稳定不只是省渲染——`releaseFollow` 会进
 * `useTurnRailNav` 的依赖数组（那里的 `navigate` 是 `useCallback`），动作每渲染
 * 换一次引用就会把下游的 memo 白打掉。
 */
export interface AutoScrollPort {
  /** 会话滚动区（`.chat-scroll`）。历史翻页、轮次跳转、量高瞬态补回都要它。 */
  readonly scrollEl: MutableRefObject<HTMLDivElement | null>;
  /** 正文列表（`.chat-list`）：内容长高是跟随的主入口。 */
  readonly contentEl: MutableRefObject<HTMLDivElement | null>;
  /** 显式放掉跟随（轮次横条跳历史位置）。程序化滚动不算手势，不放的话 settle 会把它钉回底部。 */
  release: () => void;
  /** 用户显式要最新（发消息 / 插话 / 点胶囊）：恢复跟随并**立即**钉底（不等下一帧）。 */
  pin: () => void;
}

/**
 * React 这一侧看到的绑定：端口 + 唯一一个会变的量（胶囊亮不亮）。
 *
 * 「回底动作」在这里**换成稳定引用**（`jumpToLatest` / `releaseFollow`），因为它要进
 * 依赖数组与 memo 子树的 props；两个动作每次都读 port 上的最新实现，
 * 所以合成对象只需要在 `showJump` 变化时换一次。
 */
export interface AutoScrollBinding {
  readonly port: AutoScrollPort;
  /** 脱贴且确实离底：亮出「回到最新」胶囊。 */
  readonly showJump: boolean;
  /** 稳定引用的回底动作（胶囊 / `Composer` 发消息）。 */
  readonly jumpToLatest: () => void;
  /** 稳定引用的放跟随动作（轮次横条跳转）。 */
  readonly releaseFollow: () => void;
}

/** 距底距离：≤ 0 表示内容不足一屏（天然贴底）。 */
export function bottomGap(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** 贴底判据——settle 与本模块的消费方（`Composer` 的量高瞬态）共用同一个数。 */
export function atBottom(gap: number): boolean {
  return gap <= STICK_THRESHOLD_PX;
}

/** 胶囊判据：脱贴**且实测离底**才亮（贴底即隐）。 */
export function shouldShowJump(following: boolean, gap: number): boolean {
  return !following && gap > STICK_THRESHOLD_PX;
}

/**
 * 手势记录：滚轮 / 键盘各自记最近一次时刻，触摸与拖滚动条记"按住期间"。
 *
 * **初始值必须是 `-Infinity` 而不是 0**：`performance.now()` 在新文档里从 0 附近开始，
 * 用 0 当"还没发生过"会让页面刚加载的头 400ms 里 `now - 0 < GESTURE_WINDOW_MS` 恒真
 * ——那段时间任何一次离底都被当成"用户上滑"（探针 P1 就是这么红的）。
 */
export interface GestureTracker {
  noteWheel(deltaY: number): void;
  noteKey(key: string): void;
  /** 拖滚动条：按下点落在 `clientWidth` 右边那一条（滑块与轨道都算）。 */
  notePointerDown(clientX: number, rectLeft: number, clientWidth: number): void;
  setActive(active: boolean): void;
  recently(now: number): boolean;
}

export function createGestureTracker(): GestureTracker {
  let wheelAt = -Infinity;
  let keyAt = -Infinity;
  let active = false;
  return {
    noteWheel(deltaY: number): void {
      // 向下滚不该脱贴（只有"想看上面"才是放手）
      if (deltaY < 0) wheelAt = performance.now();
    },
    noteKey(key: string): void {
      if (key === "PageUp" || key === "Home" || key === "ArrowUp") keyAt = performance.now();
    },
    notePointerDown(clientX: number, rectLeft: number, clientWidth: number): void {
      if (clientX - rectLeft > clientWidth) active = true;
    },
    setActive(next: boolean): void {
      active = next;
    },
    /** 近期有手势（含"按住期间"）：没有它，任何离底都只是布局事故。 */
    recently(now: number): boolean {
      return active || now - wheelAt < GESTURE_WINDOW_MS || now - keyAt < GESTURE_WINDOW_MS;
    },
  };
}

/**
 * 贴底意愿的**全部**状态机（纯逻辑，无 DOM）。
 *
 * 抽出来的理由：意愿怎么翻（手势 vs 布局事故）是这条链路唯一有分歧的地方，
 * 以前只能靠正则从 `App.tsx` 的源码里读。现在它是一组真调用——
 * `scripts/autoScroll.test.ts` 直接喂 `(dist, now)` 断言翻不翻，注入回归能红。
 */
export interface ScrollFollowState {
  /** 是否跟着最新（意愿）。 */
  readonly following: boolean;
  /** 滚轮 / 键盘 / 触摸 / 滚动条的手势记录。 */
  readonly gestures: GestureTracker;
  /** 最近一次滚动位置：**只用于**从轨迹视图回来时复原阅读位置，不参与意愿判断。 */
  readonly lastTop: { current: number };
  /** 用户手势 + 确实离底 ⇒ 放开跟随（唯一一条"脱贴"路径）。 */
  release(): void;
  /** 滚一下：回到容差内即恢复跟随；离底且近期有手势才脱贴；其余按布局事故处理。 */
  scroll(dist: number, now: number): void;
  /**
   * 切会话 / 点胶囊 / 发消息：恢复跟随（"显式要最新"的**唯一**实现）。
   *
   * 三条入口共用它，所以"发消息贴回底部"与"切会话回最新"不可能各自漂移。
   */
  rearm(): void;
}

export function createScrollFollow(): ScrollFollowState {
  let following = true;
  return {
    get following(): boolean {
      return following;
    },
    gestures: createGestureTracker(),
    lastTop: { current: 0 },
    release(): void {
      following = false;
    },
    scroll(dist: number, now: number): void {
      if (atBottom(dist)) {
        following = true; // 回到（近）底部即恢复跟随
      } else if (this.gestures.recently(now)) {
        // **只有**"用户手势 + 确实离底"才算要看上面。没有手势的离底（位置被浏览器夹走、
        // 重排、端口变矮）一律按布局事故处理：不动意愿，下一次 settle 把它钉回底部。
        following = false;
      }
    },
    rearm(): void {
      following = true;
    },
  };
}

/**
 * 一次挂载需要的宿主环境。生产用真实 DOM；断言脚本喂假实现，
 * 于是监听器接线、rAF 合并、settle 的钉底分支都能**真跑**一遍
 * （见 `scripts/autoScroll.test.ts`）。
 */
export interface AutoScrollEnv {
  now(): number;
  requestFrame(callback: () => void): void;
  /** 观察某个元素的重排；`callback` 由本模块提供（合并到它自己的 rAF）。 */
  observeResize(target: Element, callback: () => void): void;
  onHostFrame(listener: () => void): () => void;
}

export interface AutoScrollHandle {
  /** 摘掉所有监听 / 观察者（重挂或卸载时调用）。 */
  detach(): void;
}

/** 生产环境：真实计时 / rAF / ResizeObserver / 宿主帧。 */
const defaultEnv: AutoScrollEnv = {
  now: () => performance.now(),
  requestFrame: (callback) => {
    requestAnimationFrame(callback);
  },
  observeResize: (target, callback) => {
    const observer = new ResizeObserver(callback);
    observer.observe(target);
  },
  onHostFrame,
};

/**
 * 把状态机接到真实的滚动容器上：**这里拥有全部信号面与 rAF 合并**，
 * React 那层只剩"什么时候挂 / 什么时候摘"，以及把胶囊状态同步给渲染。
 *
 * `onShowJump` 只在**值真的变**时回调：它是 React state 的写入点，多写一次就多一次渲染。
 *
 * 信号面（少一个就会在真实场景里丢一次钉底）：
 * - 宿主帧：内容可能变了（"新生成"到达最早、且不依赖 RO 时序的信号）；
 * - 内容 RO：`.chat-list` 长高是跟随的主入口；
 * - 端口 RO：插话排队条 / 提示条 / 待办面板 / 变高的输入框都是从下面把 `.chat-scroll`
 *   挤矮——此时 `scrollTop` 不变、连 `scroll` 事件都没有；
 * - 可见性 / 焦点：面板隐藏期间推帧、再显示时必须贴回底部。
 */
export function setupAutoScroll(
  port: AutoScrollPort,
  state: ScrollFollowState,
  onShowJump: (show: boolean) => void,
  env: AutoScrollEnv = defaultEnv,
): AutoScrollHandle {
  const el = port.scrollEl.current;
  const content = port.contentEl.current;
  if (!el || !content) return { detach: () => {} };

  const setShowJump = (next: boolean): void => onShowJump(next);

  /** 想跟就把视口钉到底（幂等）；不跟就只按实测距离同步胶囊。 */
  const settle = (): void => {
    const dist = bottomGap(el);
    if (state.following) {
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
  let dirty = true;
  const run = (): void => {
    scheduled = false;
    if (!dirty) return;
    dirty = false;
    settle();
  };
  const schedule = (): void => {
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    env.requestFrame(run);
  };

  // 端口上的两个动作：实现落在状态机上（`rearm` 一处定义，"发消息"与"切会话"共用）。
  port.release = () => {
    state.release();
    schedule();
  };
  port.pin = () => {
    state.rearm();
    dirty = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };

  const onScroll = (): void => {
    state.lastTop.current = el.scrollTop;
    state.scroll(bottomGap(el), env.now());
    schedule();
  };
  const onWheel = (event: WheelEvent): void => {
    state.gestures.noteWheel(event.deltaY);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    state.gestures.noteKey(event.key);
  };
  const onPointerDown = (event: PointerEvent): void => {
    const rect = el.getBoundingClientRect();
    state.gestures.notePointerDown(event.clientX, rect.left, el.clientWidth);
  };
  const onPointerUp = (): void => {
    state.gestures.setActive(false);
  };
  const onTouchStart = (): void => {
    state.gestures.setActive(true);
  };
  const onTouchEnd = (): void => {
    state.gestures.setActive(false);
  };
  const onVisibility = (): void => {
    if (!document.hidden) schedule();
  };

  env.observeResize(content, schedule);
  env.observeResize(el, schedule);
  const offFrame = env.onHostFrame(schedule);

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

  return {
    detach(): void {
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
    },
  };
}

/**
 * 自动滚动：`active` = 会话页是否在场（轨迹视图会把它整块卸载，监听必须能重挂），
 * `sessionId` = 当前会话（切会话重置贴底并回最新）。
 *
 * **钉底发生在 `useLayoutEffect` 里**（不是 `useEffect`）：切会话与从轨迹视图回来的
 * 贴底必须在布局阶段做完，挪到 `useEffect` 就会先画一帧旧位置（用户看到的是一次闪）。
 */
export function useAutoScroll(active: boolean, sessionId: string | undefined): AutoScrollBinding {
  const scrollEl = useRef<HTMLDivElement>(null);
  const contentEl = useRef<HTMLDivElement>(null);
  const state = useMemo(() => createScrollFollow(), []);
  const [showJump, setShowJump] = useState(false);
  /** 已经挂过一次：用来区分「首次挂载」与「从轨迹视图回来」（回来时元素是新的）。 */
  const attached = useRef(false);

  // 端口的身份必须稳定：两个 ref 恒定，两个动作读 ref，
  // 所以这里只建一次，之后由 `setupAutoScroll` 就地写入真正的实现。
  const port = useMemo<AutoScrollPort>(
    () => ({
      scrollEl,
      contentEl,
      release: () => undefined,
      pin: () => undefined,
    }),
    [],
  );

  useLayoutEffect(() => {
    const handle = setupAutoScroll(port, state, (next) =>
      setShowJump((prev) => (prev === next ? prev : next)),
    );
    const el = scrollEl.current;
    if (el && !attached.current) {
      // 首次挂载：只留基线。内容通常还没到，赋值是 no-op（与「还没出现滚动条」同一条路）。
      attached.current = true;
      state.lastTop.current = el.scrollTop;
    } else if (el) {
      // 从轨迹视图回来：会话页是一个**新元素**，旧元素连同滚动位置一起没了
      // （新元素 scrollTop 一律是 0，不补一下就会把用户丢回会话开头）。
      // 按意愿复原：贴着底就跟到底，否则回到原来的阅读位置。
      el.scrollTop = state.following
        ? el.scrollHeight
        : Math.min(state.lastTop.current, Math.max(0, el.scrollHeight - el.clientHeight));
    }
    // 重挂后先按当前意愿同步一次胶囊（`previous` 是上一次挂载留下的值，
    // 元素还没量到时不动它——紧接着的 settle 会给出实测距离）
    const show = el !== null && shouldShowJump(state.following, bottomGap(el));
    setShowJump((prev) => (el === null || prev === show ? prev : show));
    return () => {
      handle.detach();
    };
    // `active`：轨迹视图把会话页整块卸载，回来时元素是新的，监听必须重挂
  }, [active, port, state]);

  // 切会话 = 要看最新：恢复贴底并回到底部（意愿不跨会话继承——上个会话滚到中间的阅读
  // 位置对新会话没有意义，继承过去的表现是「切过来不跟最新」）。
  // 首次挂载也会跑一次，此时内容通常还没到，scrollTop 赋值是 no-op，无副作用。
  useLayoutEffect(() => {
    port.pin();
    const el = scrollEl.current;
    if (el) {
      const show = shouldShowJump(state.following, bottomGap(el));
      setShowJump((prev) => (prev === show ? prev : show));
    }
  }, [sessionId, port, state]);

  return useMemo(
    () => ({
      port,
      showJump,
      // 稳定引用：动作每次都读端口上的最新实现，所以这两个可以在依赖数组里长期存在
      jumpToLatest: () => port.pin(),
      releaseFollow: () => port.release(),
    }),
    [port, showJump],
  );
}
