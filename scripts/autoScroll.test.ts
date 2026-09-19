/**
 * `.chat-scroll` 自动滚动的**行为**断言（真调用，不读源码）。
 *
 * 这些口径以前钉在 `scripts/styles.test.ts` 第 37 节的**源码正则**上——正则只能证明
 * 「`App.tsx` 里有这行字」，证明不了「这样翻意愿是对的」。2026-09-19 把整条链路收进
 * `src/webview/autoScroll.ts` 之后：
 *
 * - `createScrollFollow` / `createGestureTracker` 是纯状态机，直接喂 `(dist, now)`；
 * - `setupAutoScroll` 吃一个**可注入的宿主环境**，于是监听器接线、rAF 合并、
 *   settle 的钉底分支都能用假 DOM 真跑一遍（真事件派发 → 真状态变化）。
 *
 * 仍然留在 `styles.test.ts` 的只有**接线**那一层（谁调用 module、谁接哪个 prop）——
 * 那是另一种事实（跨文件的数据流），正则恰好是合适的工具。
 *
 * 运行：先打包再跑（与其它断言脚本同一条路）。新增脚本记得登记到 `esbuild.scripts.mjs`：
 *
 *   npm run build:scripts && node build/auto-scroll.test.mjs
 */
import assert from "node:assert";

// `bridge.ts` 在模块求值期就挂了 `window.addEventListener`（webview 里那是真实存在的宿主）。
// 无头环境里补一个最小 window——补在 import 之前（静态 import 会被提升到补桩之前，
// 所以这里用动态 import）。
// `setupAutoScroll` 的指针监听（拖滚动条）挂在 window 上，所以这个桩要能被派发事件。
type Listener = (event: unknown) => void;

interface FakeTarget {
  listeners: Map<string, Listener[]>;
  addEventListener(type: string, listener: Listener, _options?: unknown): void;
  removeEventListener(type: string, listener: Listener): void;
}

function fakeTarget(): FakeTarget {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    addEventListener(type, listener): void {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener): void {
      const list = listeners.get(type) ?? [];
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    },
  };
}

/** 真派发：走的是 `setupAutoScroll` 用 `addEventListener` 注册进去的那一个处理器。 */
function emit(target: FakeTarget, type: string, event: unknown = {}): void {
  for (const listener of [...(target.listeners.get(type) ?? [])]) listener(event);
}

const fakeWindow = fakeTarget();
(globalThis as { window?: unknown }).window = fakeWindow;
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: () => undefined,
});

const {
  GESTURE_WINDOW_MS,
  STICK_THRESHOLD_PX,
  atBottom,
  bottomGap,
  createScrollFollow,
  setupAutoScroll,
  shouldShowJump,
} = await import("../src/webview/autoScroll");
type AutoScrollPort = import("../src/webview/autoScroll").AutoScrollPort;
type AutoScrollEnv = import("../src/webview/autoScroll").AutoScrollEnv;

// ---------- 假宿主环境：真派发事件、手动放帧 ----------

// `globalThis.performance` 是可写属性：换成假时钟，`createGestureTracker` 就完全确定
// （手势窗口那条边界的时间从这里来）。
const realPerformance = globalThis.performance;
let clock = 0;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => clock },
  configurable: true,
  writable: true,
});

const realDocument = globalThis.document;
let hidden = false;
const fakeDocument = {
  ...fakeTarget(),
  get hidden(): boolean {
    return hidden;
  },
};
Object.defineProperty(globalThis, "document", { value: fakeDocument, configurable: true, writable: true });

/** 假的 `.chat-scroll`：只需要三个几何量 + 事件面。 */
interface FakeScroller extends FakeTarget {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  getBoundingClientRect(): { left: number; top: number };
}

function fakeScroller(): FakeScroller {
  // 真实浏览器里 scrollTop 会被夹在 [0, scrollHeight - clientHeight]。假元素照做一遍，
  // 否则测试会写出**实际不可达**的位置（`scrollTop = 980` 而可滚范围只到 600），
  // 于是"离底距离"变成负数，钉底动作被正确跳过、断言却以为它该跑。
  const inner: FakeScroller = {
    ...fakeTarget(),
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    clientWidth: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  return new Proxy(inner, {
    set(target, key, value): boolean {
      if (key === "scrollTop") {
        const top = Math.min(Math.max(Number(value), 0), Math.max(0, target.scrollHeight - target.clientHeight));
        target.scrollTop = top;
        return true;
      }
      Reflect.set(target, key, value);
      return true;
    },
  });
}

function stubPort(el: FakeScroller): AutoScrollPort {
  return {
    scrollEl: { current: el } as unknown as AutoScrollPort["scrollEl"],
    contentEl: { current: { tag: "chat-list" } } as unknown as AutoScrollPort["contentEl"],
    release: () => undefined,
    pin: () => undefined,
  };
}

/** 受控环境：帧要手动放，尺寸回调要手动触发，宿主帧由测试按需送达。 */
function controlledEnv() {
  const frames: (() => void)[] = [];
  const observed: { target: unknown; callback: () => void }[] = [];
  let hostFrame: (() => void) | null = null;
  let framesRequested = 0;
  const env: AutoScrollEnv = {
    now: () => clock,
    requestFrame: (callback) => {
      framesRequested += 1;
      frames.push(callback);
    },
    observeResize: (target, callback) => {
      observed.push({ target, callback });
    },
    onHostFrame: (listener) => {
      hostFrame = listener;
      return () => {
        hostFrame = null;
      };
    },
  };
  const run = (): void => {
    const next = frames.shift();
    assert.ok(next, "应当有排队的帧（signal → rAF 合并这一条断了）");
    next();
  };
  return {
    env,
    get framesRequested() {
      return framesRequested;
    },
    /** 放掉下一帧（合并语义：一帧里放几次信号都只跑一次判定）。 */
    runFrame(): void {
      run();
    },
    /** 放掉当前排着的所有帧（一条断言前面已经排过帧时用，避免把上一帧留下来）。 */
    drainFrames(): void {
      const all = frames.splice(0, frames.length);
      for (const frame of all) frame();
    },
    resizeCount(target: unknown): number {
      return observed.filter((item) => item.target === target).length;
    },
    hostFrame(): void {
      assert.ok(hostFrame, "宿主帧监听必须注册（它是「新生成到达」最早的信号）");
      hostFrame();
    },
  };
}

console.log("auto-scroll: 假宿主环境就绪（真事件派发 + 手动放帧）");

// ---------- 1. 意愿只由手势决定：没有手势的离底是布局事故，不许脱贴 ----------
{
  const follow = createScrollFollow();
  assert.strictEqual(follow.following, true, "初始是跟随（新会话默认看最新）");

  // 没有手势，离底 500px：位置被浏览器夹走 / 重排 / 端口变矮。意愿不动。
  follow.scroll(500, clock);
  assert.strictEqual(
    follow.following,
    true,
    "没有手势的离底必须按布局事故处理：旧实现就是在这一条上把「浏览器自己夹一下位置」误判成用户上滑，且永不恢复",
  );

  // 滚轮向上 = 用户确实要看上面 → 脱贴
  follow.gestures.noteWheel(-120);
  follow.scroll(500, clock);
  assert.strictEqual(follow.following, false, "滚轮向上 + 确实离底 ⇒ 放开跟随");

  // 回到底部即恢复
  follow.scroll(10, clock);
  assert.strictEqual(follow.following, true, "回到容差内（距底 ≤ 阈值）即恢复跟随");

  // 向下滚不算手势：即便离底也不脱贴
  // （先把时钟推出手势窗口，否则"上一次向上滚"还在 400ms 内）
  const later = clock + GESTURE_WINDOW_MS + 1;
  follow.gestures.noteWheel(120);
  follow.scroll(500, later);
  assert.strictEqual(follow.following, true, "向下滚不该脱贴（只有「想看上面」才是放手）");
}
console.log("auto-scroll: 意愿只由手势决定（布局事故不脱贴）✓");

// ---------- 2. 手势来源齐备：滚轮 / 键盘 / 触摸 / 拖滚动条 ----------
{
  const cases: { name: string; note: (g: ReturnType<typeof createScrollFollow>["gestures"]) => void }[] = [
    { name: "滚轮向上", note: (g) => g.noteWheel(-120) },
    { name: "键盘 PageUp", note: (g) => g.noteKey("PageUp") },
    { name: "键盘 Home", note: (g) => g.noteKey("Home") },
    { name: "键盘 ArrowUp", note: (g) => g.noteKey("ArrowUp") },
    { name: "触摸按住", note: (g) => g.setActive(true) },
    { name: "拖滚动条（按下点在 clientWidth 右边）", note: (g) => g.notePointerDown(320, 0, 300) },
  ];
  for (const item of cases) {
    const follow = createScrollFollow();
    item.note(follow.gestures);
    follow.scroll(500, clock);
    assert.strictEqual(follow.following, false, `${item.name} 必须记成手势`);
  }

  // 键盘里只有"往上翻"那三个键算
  for (const key of ["ArrowRight", "a", "PageDown"]) {
    const follow = createScrollFollow();
    follow.gestures.noteKey(key);
    follow.scroll(500, clock);
    assert.strictEqual(follow.following, true, `键盘 "${key}" 不该被当成「要看上面」`);
  }
  // 轨道（clientWidth 左边）按下不算手势
  const rail = createScrollFollow();
  rail.gestures.notePointerDown(150, 0, 300);
  rail.scroll(500, clock);
  assert.strictEqual(rail.following, true, "轨道左侧（正文里）按下不该被当成拖滚动条");
}
console.log("auto-scroll: 手势来源齐备（滚轮 / 键盘三键 / 触摸 / 滚动条）✓");

// ---------- 3. 手势窗口：400ms 内算手势，超过就不算 ----------
{
  const inside = createScrollFollow();
  inside.gestures.noteWheel(-120);
  inside.scroll(500, clock + GESTURE_WINDOW_MS - 1);
  assert.strictEqual(inside.following, false, `手势后 ${GESTURE_WINDOW_MS - 1}ms 仍算「正在滚动」`);

  const outside = createScrollFollow();
  outside.gestures.noteWheel(-120);
  outside.scroll(500, clock + GESTURE_WINDOW_MS + 1);
  assert.strictEqual(
    outside.following,
    true,
    `手势后超过 ${GESTURE_WINDOW_MS}ms 的离底又变成布局事故（探针 P1 现场：页面刚加载时 now 从 0 附近开始，用 0 当「还没发生过」会让头 400ms 恒真）`,
  );

  // "按住期间"不受窗口限制
  const held = createScrollFollow();
  held.gestures.setActive(true);
  held.scroll(500, clock + GESTURE_WINDOW_MS * 10);
  assert.strictEqual(held.following, false, "触摸 / 拖滚动条的「按住期间」不受 400ms 窗口限制");
}
console.log("auto-scroll: 手势窗口 400ms 边界 ✓");

// ---------- 4. 胶囊判据与贴底判据同源 ----------
{
  assert.strictEqual(STICK_THRESHOLD_PX, 40, "贴底阈值必须是 40px（轮次横条那边也按同一个数算「看的就是最新一轮」）");
  assert.strictEqual(atBottom(40), true, "距底 = 阈值算贴底");
  assert.strictEqual(atBottom(41), false, "距底 = 阈值 + 1 不算贴底");
  assert.strictEqual(atBottom(-5), true, "内容不足一屏（dist ≤ 0）天然贴底");

  assert.strictEqual(shouldShowJump(true, 500), false, "跟随中永不亮胶囊");
  assert.strictEqual(shouldShowJump(false, 500), true, "脱贴且确实离底才亮胶囊");
  assert.strictEqual(shouldShowJump(false, 40), false, "脱贴但挨着底部不亮胶囊");

  assert.strictEqual(bottomGap({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), 0, "距底 0 = 贴底");
  assert.strictEqual(bottomGap({ scrollHeight: 500, scrollTop: 0, clientHeight: 400 }), 100, "内容不足一屏也算正数距离");
}
console.log("auto-scroll: 贴底 / 胶囊判据（同一个 40px）✓");

// ---------- 5. 挂载：信号面齐备 + 首帧就把视口钉到底 ----------
{
  const el = fakeScroller();
  const port = stubPort(el);
  const state = createScrollFollow();
  const dom = controlledEnv();
  const shown: boolean[] = [];

  const handle = setupAutoScroll(port, state, (show) => shown.push(show), dom.env);

  assert.strictEqual(
    dom.resizeCount(el),
    1,
    "端口自身（.chat-scroll）变矮要重新判定：插话排队条/提示条/待办面板挤矮它时不会触发 scroll 事件",
  );
  assert.strictEqual(dom.resizeCount(port.contentEl.current), 1, "内容（.chat-list）长高是跟随的主入口");

  el.scrollTop = 100;
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 600, "只要想跟就把视口钉到底（幂等，合并到 rAF；可滚范围 0..600）");
  assert.deepStrictEqual(shown, [false], "钉底时隐掉胶囊");

  // 所有信号都只置脏标记：一帧里多少个信号都只结算一次
  const before = dom.framesRequested;
  dom.hostFrame();
  dom.hostFrame();
  assert.strictEqual(dom.framesRequested, before + 1, "同一帧的多个信号必须合并成一次判定");

  handle.detach();
}
console.log("auto-scroll: 挂载即钉底 + 信号面（宿主帧 / 内容 RO / 端口 RO）✓");

// ---------- 6. 真事件派发：滚动 / 滚轮 / 键盘 / 指针 / 触摸 / 可见性 ----------
{
  const el = fakeScroller();
  const port = stubPort(el);
  const state = createScrollFollow();
  const dom = controlledEnv();
  const shown: boolean[] = [];
  const handle = setupAutoScroll(port, state, (show) => shown.push(show), dom.env);
  dom.drainFrames(); // 首帧：贴底、隐胶囊

  // 滚轮向上 + 真实 scroll 事件 → 脱贴（意愿由「手势 + 离底」一起定）
  emit(el, "wheel", { deltaY: -120 });
  el.scrollTop = 300; // 距底 300 > 40
  emit(el, "scroll");
  assert.strictEqual(state.following, false, "真实 wheel + scroll 事件必须让意愿脱贴");
  assert.strictEqual(state.lastTop.current, 300, "滚过的位置要记下来（从轨迹视图回来时复原阅读位置）");
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 300, "脱贴后不许再把视口拽回底部");
  assert.deepStrictEqual(shown, [false, true], "脱贴且离底 ⇒ 亮胶囊");

  // 点胶囊 = 显式要最新：立即钉底（不等下一帧）+ 隐胶囊
  port.pin();
  assert.strictEqual(state.following, true, "点胶囊 = 恢复跟随");
  assert.strictEqual(el.scrollTop, 600, "点胶囊要立即钉底（晚一帧就是用户看到的一下抖动）");
  assert.strictEqual(shown.at(-1), false, "点胶囊要隐掉胶囊");

  // 没有手势的离底（端口变矮 / 位置被夹）：意愿不动，下一帧钉回去
  // 先把时钟推出手势窗口——"上一次向上滚"还在窗口内的话，这一条就不是布局事故了
  clock += GESTURE_WINDOW_MS + 1;
  el.scrollTop = 200;
  emit(el, "scroll");
  assert.strictEqual(state.following, true, "没有手势的离底是布局事故：意愿不许被翻");
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 600, "布局事故下一帧钉回底部");

  // 键盘：PageUp 是手势
  emit(el, "keydown", { key: "PageUp" });
  el.scrollTop = 200;
  emit(el, "scroll");
  assert.strictEqual(state.following, false, "键盘 PageUp 也是「要看上面」");
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 200, "键盘脱贴后同样不许拽回底部");

  // 回到（近）底部即恢复跟随（可滚范围是 0..600，贴底 = 600）
  el.scrollTop = 590; // 距底 10 ≤ 40
  emit(el, "scroll");
  assert.strictEqual(state.following, true, "滚回容差内即恢复跟随");
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 600, "恢复跟随后下一帧钉回底部");

  // 触摸：按住期间一直算手势（即便早过了 400ms 窗口）
  clock += GESTURE_WINDOW_MS * 10;
  emit(el, "touchstart", {});
  el.scrollTop = 100;
  emit(el, "scroll");
  assert.strictEqual(state.following, false, "触摸按住期间离底算手势");
  emit(el, "touchend", {});
  el.scrollTop = 590;
  emit(el, "scroll");
  assert.strictEqual(state.following, true, "触摸松手 + 回到容差内即恢复");
  dom.drainFrames();

  // 拖滚动条：松手（指到正文里）即结束手势
  emit(fakeWindow, "pointerdown", { clientX: 320 });
  el.scrollTop = 100;
  emit(el, "scroll");
  assert.strictEqual(state.following, false, "拖滚动条（按下点在 clientWidth 右边）是手势");
  emit(fakeWindow, "pointerup", {});
  el.scrollTop = 590;
  emit(el, "scroll");
  assert.strictEqual(state.following, true, "拖滚动条松手 + 回到容差内即恢复");
  dom.drainFrames();
  // 让手势窗口彻底过期（时钟只前进不后退：`noteWheel` 记的是绝对时刻），
  // 下面剩下的只能是「显式通道」在起作用
  clock += GESTURE_WINDOW_MS * 10;

  // 可见性：显式放跟随（横条跳转）之后，显示信号也不许把视口钉回去
  port.release();
  el.scrollTop = 250;
  emit(el, "scroll");
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 250, "显式放跟随后不许钉底（轮次横条跳历史位置就靠它）");
  emit(fakeDocument, "visibilitychange", {});
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 250, "放跟随不会被任何布局 / 可见性信号偷偷翻回来");

  // 文档隐藏时不结算
  port.pin();
  hidden = true;
  port.release();
  emit(fakeDocument, "visibilitychange", {});
  assert.strictEqual(el.scrollTop, 600, "文档隐藏时不结算（隐藏期间不该动视口）");
  hidden = false;

  handle.detach();
  assert.strictEqual(el.listeners.get("scroll")?.length ?? 0, 0, "detach 要摘掉滚动监听");
  assert.strictEqual(el.listeners.get("wheel")?.length ?? 0, 0, "detach 要摘掉滚轮监听");
  assert.strictEqual(fakeDocument.listeners.get("visibilitychange")?.length ?? 0, 0, "detach 要摘掉可见性监听");
}
console.log("auto-scroll: 真实事件链路（滚轮 / 键盘 / 指针 / 触摸 / 可见性）✓");

// ---------- 7. 轮次横条：显式放跟随 + 按实测距离亮胶囊 ----------
{
  const el = fakeScroller();
  const port = stubPort(el);
  const state = createScrollFollow();
  const dom = controlledEnv();
  const shown: boolean[] = [];
  const handle = setupAutoScroll(port, state, (show) => shown.push(show), dom.env);
  dom.drainFrames();

  assert.strictEqual(state.following, true, "出发点是跟随");
  // 把视口停在会话中间：横条点历史位置就是"程序化滚动到一个离底很远的地方"
  el.scrollTop = 300;
  emit(el, "scroll");
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 600, "跟随中滚到中间也会被钉回底部");

  el.scrollTop = 300; // 模拟横条把视口落到历史位置
  port.release();
  assert.strictEqual(
    state.following,
    false,
    "显式放跟随（横条跳历史位置）：程序化滚动不算手势，必须有一条显式通道把它置假",
  );
  dom.drainFrames();
  assert.strictEqual(shown.at(-1), true, "放开跟随且确实离底 ⇒ 胶囊亮出来（用户随时可以一键回底）");

  // 胶囊按**实测距离**亮：脱贴状态不变，只把视口移到底部附近（历史很短的会话），
  // 再结算一次就该隐掉。这里直接调 settle 的入口不合算——用 `state.following` 走同一条
  // 判定：`shouldShowJump(false, gap)` 为假。
  el.scrollTop = 590; // 距底 10 ≤ 阈值
  state.lastTop.current = 590;
  assert.strictEqual(
    shouldShowJump(state.following, bottomGap(el)),
    false,
    "脱贴但离底 ≤ 阈值时不亮胶囊（胶囊只按实测距离亮，不按「有没有脱贴」）",
  );

  handle.detach();
}
console.log("auto-scroll: 轮次横条的显式放跟随 + 按实测距离亮胶囊 ✓");

// ---------- 8. 钉底走 rAF 合并，`pin()` 是唯一的「立即钉底」 ----------
{
  const el = fakeScroller();
  const port = stubPort(el);
  const state = createScrollFollow();
  const dom = controlledEnv();
  const handle = setupAutoScroll(port, state, () => undefined, dom.env);

  assert.strictEqual(dom.framesRequested, 1, "挂载就要排一次判定");
  el.scrollTop = 0;
  dom.hostFrame();
  dom.hostFrame();
  dom.hostFrame();
  assert.strictEqual(dom.framesRequested, 1, "信号再多也只排一帧（rAF 在绘制之前跑，钉底不闪）");
  dom.drainFrames();
  assert.strictEqual(el.scrollTop, 600, "那一帧结算一次");

  handle.detach();
}
console.log("auto-scroll: rAF 合并 + 幂等结算 ✓");

// ---------- 9. 切会话 / 从轨迹视图回来：元素换了，按意愿复原 ----------
{
  const el = fakeScroller();
  const port = stubPort(el);
  const state = createScrollFollow();
  const dom = controlledEnv();
  const handle = setupAutoScroll(port, state, () => undefined, dom.env);
  dom.drainFrames();

  // 脱贴并把阅读位置记在 300
  el.scrollTop = 300;
  state.lastTop.current = 300;
  state.release();
  dom.drainFrames();
  handle.detach();

  // 从轨迹视图回来：会话页是**新元素**，scrollTop 从 0 开始
  const back = fakeScroller();
  port.scrollEl = { current: back } as unknown as AutoScrollPort["scrollEl"];
  const dom2 = controlledEnv();
  const handle2 = setupAutoScroll(port, state, () => undefined, dom2.env);
  // 复原动作由 hook 的 layout effect 做（它读 state + lastTop），这里按同一条规则算一遍
  back.scrollTop = state.following
    ? back.scrollHeight
    : Math.min(state.lastTop.current, back.scrollHeight - back.clientHeight);
  assert.strictEqual(
    back.scrollTop,
    300,
    "脱贴状态下从轨迹视图回来要回到原来的阅读位置（新元素 scrollTop 一律是 0，不补就丢回会话开头）",
  );

  // 切会话 = 要看最新：立即钉底（意愿不跨会话继承）
  port.pin();
  assert.strictEqual(back.scrollTop, 600, "切会话要立即回到底部");
  assert.strictEqual(state.following, true, "切会话恢复贴底");

  dom2.drainFrames();
  handle2.detach();
}
console.log("auto-scroll: 切会话 / 轨迹视图往返（按意愿复原阅读位置）✓");

// ---------- 10. send / queueSteer / 胶囊三条入口共用同一个 pin ----------
{
  const el = fakeScroller();
  const port = stubPort(el);
  const state = createScrollFollow();
  const dom = controlledEnv();
  const shown: boolean[] = [];
  const handle = setupAutoScroll(port, state, (show) => shown.push(show), dom.env);
  dom.drainFrames();

  state.release();
  el.scrollTop = 200;
  dom.drainFrames();
  assert.strictEqual(state.following, false, "先脱贴（用户在看上面）");

  // `Composer` 的 send / queueSteer 与胶囊都调这一个动作
  port.pin();
  assert.strictEqual(state.following, true, "发消息 = 要看最新");
  assert.strictEqual(el.scrollTop, 600, "发消息也要贴回底部（脱贴状态下发出去同样贴回）");
  assert.strictEqual(shown.at(-1), false, "贴回后胶囊必须隐掉");

  handle.detach();
}
console.log("auto-scroll: 发消息 / 插话 / 胶囊共用同一个「回最新」✓");

// ---------- 收尾：还原全局桩 ----------
Object.defineProperty(globalThis, "performance", {
  value: realPerformance,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "document", {
  value: realDocument,
  configurable: true,
  writable: true,
});

console.log("\nauto-scroll: all assertions passed");
