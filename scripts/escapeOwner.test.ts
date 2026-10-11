/**
 * ESC 归属链（`src/webview/escapeOwner.ts`）：一次按键只归一个消费者，
 * 没有消费者才轮到「停止生成」——而这一步只在会话页占据前景时存在。
 *
 * 这条链要防住三个已复现的事件传播问题：
 *
 * 1. **轨迹时间线聚焦时 ESC 把会话中止了**：绘图区的处理器只 `preventDefault`、
 *    没吃掉按键，事件冒到 App 的 window 兜底，用户只是想清掉选区；
 * 2. **原图上开着右键菜单**：两层都在 window 捕获阶段、`stopPropagation` 同节点同
 *    阶段互相拦不住，一次 ESC 把菜单与原图一起关掉；
 * 3. **兜底被当成全局快捷键**：「停止生成」是**会话页**的动作，可轨迹整页 / 历史 /
 *    任务抽屉顶掉会话页之后，一次没人消费的 ESC 照样把正在跑的那一轮中止掉。
 *
 * 本回归的驱动方式（本仓库没有 jsdom，也不为测试引依赖）：
 *
 * - **手写的事件链**：`ChainNode` 按真实语义跑「捕获自上而下 + 冒泡自下而上」，
 *    认 `stopPropagation` / `preventDefault`。它只是把浏览器那段的派发搬进来，
 *    不是「读源码正则」式的假断言。
 * - **真实的处理器**：绘图区那一条直接调 `TrajectoryTimeline` 里接线用的
 *   那个命名处理器（`timelineEscape`），window 那一条直接调
 *    `escapeFallbackListener`（`attachEscapeFallback` 装的就是它），前景判据直接调
 *    `isConversationForeground`——三边都是生产代码里同一份函数，不在测试里另写镜像。
 *
 * 第 1 节的两条「红」：`timelineEscape` 若退回成只 `preventDefault`（改前就是那样），
 * 事件会一路冒到 window，`stop` 被调一次；兜底若不看前景（改前不看），在轨迹页上
 * 一次没人消费的 ESC 也会 `stop`——两条都在本文件当场失败。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESC_LAYER,
  attachEscapeFallback,
  consumeEscape,
  dispatchEscape,
  escapeFallbackListener,
  isConversationForeground,
  registerEscapeLayer,
} from "../src/webview/escapeOwner";
import type { PanelKind } from "../src/webview/state";
import { timelineEscape } from "../src/webview/components/TrajectoryTimeline";

/* ==================== 手写的事件链 ==================== */

type Listener = (event: ChainEvent) => void;

/** 一次按键：只带归属链会读 / 会写的面。 */
class ChainEvent {
  readonly key: string;
  defaultPrevented = false;
  stopped = false;
  constructor(key: string) {
    this.key = key;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.stopped = true;
  }
}

/** 事件链上的一个节点：父子关系 + 监听表。 */
class ChainNode {
  readonly parent: ChainNode | null;
  private readonly listeners: Array<{ type: string; listener: Listener; capture: boolean }> = [];

  constructor(parent: ChainNode | null = null) {
    this.parent = parent;
  }

  addEventListener(type: string, listener: Listener, capture = false): void {
    this.listeners.push({ type, listener, capture });
  }

  removeEventListener(type: string, listener: Listener): void {
    const at = this.listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  /** 本节点到根的路径（本节点在前）。 */
  private path(): ChainNode[] {
    const chain: ChainNode[] = [];
    for (let node: ChainNode | null = this; node !== null; node = node.parent) chain.push(node);
    return chain;
  }

  /**
   * 派发一次按键：捕获自上而下、冒泡自下而上。
   *
   * `stopPropagation` 的语义**只作用在节点之间**：同一个节点、同一阶段的其它监听照样
   * 全部执行（要连同节点的后一个也拦住，得用 `stopImmediatePropagation`）。这里刻意
   * 与浏览器对齐——「两层都在 window 捕获阶段、互相拦不住」正是要复现的东西。
   */
  dispatch(event: ChainEvent): ChainEvent {
    const path = this.path(); // 目标在前
    const visit = (node: ChainNode, capture: boolean) => {
      for (const entry of [...node.listeners]) {
        if (entry.type !== "keydown" || entry.capture !== capture) continue;
        entry.listener(event);
      }
    };
    for (const node of [...path].reverse()) {
      visit(node, true);
      if (event.stopped) return event;
    }
    for (const node of path) {
      visit(node, false);
      if (event.stopped) return event;
    }
    return event;
  }

  press(key: string): ChainEvent {
    return this.dispatch(new ChainEvent(key));
  }
}

/** webview 的窗口形状：`window > document > root > …`，浮层与绘图区都挂在链上。 */
function chain() {
  const window = new ChainNode();
  const document = new ChainNode(window);
  const root = new ChainNode(document);
  const plot = new ChainNode(root);
  return { window, document, root, plot };
}

/** 只用来接住「停止生成」的观察点。 */
function stops() {
  const calls: string[] = [];
  return { calls, stop: () => calls.push("stop") };
}

/**
 * 生产接线的兜底监听：App 装的正是 `escapeFallbackListener`，前景判据也正是
 * `isConversationForeground`。这里只把「当前面板」与「是否运行中」两个事实换掉，
 * 判据与顺序都走生产那份代码。
 */
function fallback(panel: PanelKind, running: boolean, stop: () => void) {
  return escapeFallbackListener({
    isConversationForeground: () => isConversationForeground(panel),
    isRunning: () => running,
    stop,
  });
}

/** 当前面板集合：新增面板必须一并想清楚它算不算会话页（允许名单默认不触发中止）。 */
const PANELS: PanelKind[] = ["none", "history", "jobs", "trajectory"];

/** 一个活跃浮层：关掉自己就注销（真的浮层是「值变 null → effect 清理」）。 */
function activeLayer(priority: number, label: string, log: string[]) {
  const state = { open: true };
  let release: () => void = () => {};
  release = registerEscapeLayer({
    priority,
    consume: () => {
      state.open = false;
      log.push(label);
      release();
      return true;
    },
  });
  return { state, release: () => release() };
}

/* ==================== 0. 事件链自身的语义：stopPropagation 只挡节点之间 ==================== */

{
  const { window, plot } = chain();
  const seen: string[] = [];
  // 同一个节点（window）、同一阶段（捕获）上的两个监听——旧实现里右键菜单与原图浮层
  // 就是这个形状。第一个 `stopPropagation` 之后，第二个**照样执行**：`stopPropagation`
  // 只挡「往别的节点传」，同节点同阶段要靠 `stopImmediatePropagation` 才拦得住。
  window.addEventListener(
    "keydown",
    (event) => {
      seen.push("window-capture-1");
      event.stopPropagation();
    },
    true,
  );
  window.addEventListener("keydown", () => seen.push("window-capture-2"), true);
  window.addEventListener("keydown", () => seen.push("window-bubble"));
  plot.addEventListener("keydown", () => seen.push("plot"));
  plot.press("Escape");
  assert.deepStrictEqual(
    seen,
    ["window-capture-1", "window-capture-2"],
    "同节点同阶段的监听全部执行；停止只发生在节点之间（目标与冒泡阶段都到不了）",
  );
}

/* ==================== 1. 真实链路：会话页前景的 ESC 才可能是停止 ==================== */

{
  const { window, root, plot } = chain();
  const cleared: number[] = [];
  const stop = stops();
  // 生产接线：绘图区的 onKeyDown 调的就是 timelineEscape（同一个函数）
  plot.addEventListener("keydown", (event) => timelineEscape(event, () => cleared.push(1)));
  // 生产接线：App 挂的 window 兜底就是 escapeFallbackListener（attach 装的就是它），
  // 前景判据来自 isConversationForeground；这一幕在**会话页**上
  window.addEventListener("keydown", fallback("none", true, stop.stop));

  const hit = plot.press("Escape");
  assert.strictEqual(cleared.length, 1, "ESC 归绘图区：清选区与选中照旧（元素自己的清理动作不变）");
  assert.deepStrictEqual(stop.calls, [], "轨迹聚焦时的 ESC 不许停止正在跑的那一轮（改前就是在这里红的）");
  assert.strictEqual(hit.defaultPrevented, true, "元素层消费要 preventDefault");
  assert.strictEqual(hit.stopped, true, "元素层消费要 stopPropagation（这次的按键不再往上冒）");

  // 非 ESC 键原样放过
  plot.press("a");
  assert.strictEqual(cleared.length, 1, "只有 Escape 归绘图区");

  // 焦点不在绘图区（没有任何元素层消费）时，会话页上的兜底照旧停止
  root.press("Escape");
  assert.deepStrictEqual(stop.calls, ["stop"], "会话页前景、没有消费者且生成中：兜底照旧停止生成");
}

/* ==================== 1b. 非会话页面在前景：中止机制根本不存在 ==================== */

{
  // 每个面板各按一次 ESC：没有元素层消费、也没有浮层，running 恒为真——改前除了会话页
  // 之外的每一个都会冒出一次 stop
  const stopped = PANELS.filter((panel) => {
    const { plot } = chain();
    const stop = stops();
    plot.addEventListener("keydown", fallback(panel, true, stop.stop));
    plot.press("Escape");
    return stop.calls.length > 0;
  });
  assert.deepStrictEqual(
    stopped,
    ["none"],
    "只有会话页占据前景时，无人认领的 ESC 才等于中止会话（轨迹页是用户报的那一例）",
  );

  // 非会话页面上的这一键连传播状态都不许动：没人认领就是没人认领
  const { window, plot } = chain();
  const stop = stops();
  window.addEventListener("keydown", fallback("trajectory", true, stop.stop));
  const event = plot.press("Escape");
  assert.deepStrictEqual(stop.calls, [], "轨迹页上的 ESC 不是「停止生成」的入口");
  assert.strictEqual(event.defaultPrevented, false, "中止机制不在了，就不该有 preventDefault");
  assert.strictEqual(event.stopped, false, "中止机制不在了，也不该吃掉冒泡");
}

/* ==================== 2. 菜单 > 原图：两次 ESC 各关一层 ==================== */

{
  const { window, plot } = chain();
  const log: string[] = [];
  const stop = stops();
  window.addEventListener("keydown", fallback("none", true, stop.stop));

  // 原图浮层的登记刻意排在菜单**之后**，且中途因 `value` 更新真的注销再登记了一次
  // （React effect 重跑的形状）——层级说了算，后登记的低层级不许抢在菜单前面
  const menu = activeLayer(ESC_LAYER.contextMenu, "menu", log);
  const previewStale = activeLayer(ESC_LAYER.imagePreview, "preview", log);
  previewStale.release();
  const previewClosed = activeLayer(ESC_LAYER.imagePreview, "preview", log);

  plot.press("Escape");
  assert.deepStrictEqual(log, ["menu"], "第一次 ESC 只关右键菜单（它盖在原图上，重注册也不改变先后）");
  assert.strictEqual(menu.state.open, false);

  plot.press("Escape");
  assert.deepStrictEqual(log, ["menu", "preview"], "第二次 ESC 才关原图");
  assert.strictEqual(previewClosed.state.open, false);

  plot.press("Escape");
  assert.deepStrictEqual(log, ["menu", "preview"], "两个浮层都关了之后没有消费者");
  assert.deepStrictEqual(stop.calls, ["stop"], "第三次 ESC 才轮到停止生成");

  menu.release();
  previewClosed.release();
  plot.press("Escape");
  assert.deepStrictEqual(
    stop.calls,
    ["stop", "stop"],
    "注销之后这次 ESC 无人认领：兜底照旧停止（注销没有留下永久吞键的空壳）",
  );
}

/* ==================== 3. 同层并列：后注册的先看（LIFO） ==================== */

{
  const log: string[] = [];
  const first = activeLayer(ESC_LAYER.floating, "first", log);
  const second = activeLayer(ESC_LAYER.floating, "second", log);
  dispatchEscape(new ChainEvent("Escape"));
  assert.deepStrictEqual(log, ["second"], "同层并列时后注册的先消费");
  first.release();
  second.release();
  const stop = stops();
  fallback("none", true, stop.stop)(new ChainEvent("Escape"));
  assert.deepStrictEqual(stop.calls, ["stop"], "两层都注销后这次 ESC 无人认领");
}

/* ==================== 3b. 抽屉：压过并列浮层，低于原图与菜单 ==================== */

{
  // 全屏模态抽屉（会话历史 / 后台任务）与查找条 / Popover 可以同时开着（抽屉不卸载
  // 会话页），所以先后必须由层级说；抽屉的视觉层级在原图与右键菜单之下，先后同序
  const log: string[] = [];
  const drawer = activeLayer(ESC_LAYER.drawer, "drawer", log);
  activeLayer(ESC_LAYER.imagePreview, "preview", log);
  activeLayer(ESC_LAYER.contextMenu, "menu", log);
  dispatchEscape(new ChainEvent("Escape"));
  assert.deepStrictEqual(log, ["menu"], "抽屉之上的右键菜单先消费");
  dispatchEscape(new ChainEvent("Escape"));
  assert.deepStrictEqual(log, ["menu", "preview"], "再下一次才轮到原图");
  dispatchEscape(new ChainEvent("Escape"));
  assert.deepStrictEqual(log, ["menu", "preview", "drawer"], "第三次才轮到抽屉自己");
  assert.strictEqual(dispatchEscape(new ChainEvent("Escape")), "unclaimed", "三层都关掉后无人认领");

  // 抽屉 vs 并列浮层：抽屉带全屏遮罩，必须抢在浮层前面（否则用户按 ESC 关掉的是
  // 遮罩后面的查找条，抽屉还杵在最上面）
  const under: string[] = [];
  const floating = activeLayer(ESC_LAYER.floating, "floating", under);
  const drawer2 = activeLayer(ESC_LAYER.drawer, "drawer", under);
  dispatchEscape(new ChainEvent("Escape"));
  assert.deepStrictEqual(under, ["drawer"], "抽屉压过并列浮层，一次 ESC 只关它");
  dispatchEscape(new ChainEvent("Escape"));
  assert.deepStrictEqual(under, ["drawer", "floating"], "抽屉关掉之后才轮到并列浮层");

  // 抽屉关掉 = 组件卸载 = 注销：不留吞键的空壳（`activeLayer` 消费即自我注销，同形）
  assert.strictEqual(drawer2.state.open, false, "消费一次就关掉自己");
  assert.strictEqual(drawer.state.open, false, "消费一次就关掉自己");
  floating.release();
}

/* ==================== 4. 元素层的消费标记只认自己的章 ==================== */

{
  // 元素层消费过的按键：即便它因为某种原因冒到了归属链上，也绝不当成「无人认领」
  const consumed = new ChainEvent("Escape");
  consumeEscape(consumed);
  assert.strictEqual(dispatchEscape(consumed), "element", "已消费的按键归元素层");
  const stop = stops();
  fallback("none", true, stop.stop)(consumed);
  assert.deepStrictEqual(stop.calls, [], "已消费的按键不再兜底停止生成");
  assert.strictEqual(consumed.defaultPrevented, true);
  assert.strictEqual(consumed.stopped, true);

  // React 合成事件：标记要落到原生事件上，同一次按键在 window 上仍是同一份真相
  // （判据只经 dispatchEscape 出场，不另开观测口）
  const native = new ChainEvent("Escape");
  const synthetic = {
    key: "Escape",
    nativeEvent: native,
    preventDefault: () => native.preventDefault(),
    stopPropagation: () => native.stopPropagation(),
  };
  consumeEscape(synthetic);
  assert.strictEqual(dispatchEscape(native), "element", "合成事件的消费标记挂在原生事件上");
  const syntheticStop = stops();
  fallback("none", true, syntheticStop.stop)(native);
  assert.deepStrictEqual(syntheticStop.calls, [], "原生事件上认得这次消费，不再兜底停止");
}

/* ==================== 5. 不拿 defaultPrevented 当消费证据 ==================== */

{
  // 无关处理器顺手 preventDefault 过的 ESC：没有归属者时照旧停止生成
  const { window, plot } = chain();
  const stop = stops();
  window.addEventListener("keydown", fallback("none", true, stop.stop));
  const foreign = new ChainEvent("Escape");
  foreign.preventDefault();
  plot.dispatch(foreign);
  assert.deepStrictEqual(stop.calls, ["stop"], "defaultPrevented 不是消费证据：没人认领就照旧停止");

  // 反过来：无关处理器 preventDefault 也不许挡住**活跃浮层**的归属
  const log: string[] = [];
  const menu = activeLayer(ESC_LAYER.contextMenu, "menu", log);
  const blocked = new ChainEvent("Escape");
  blocked.preventDefault();
  plot.dispatch(blocked);
  assert.deepStrictEqual(log, ["menu"], "浮层消费不看别人立的 defaultPrevented");
  menu.release();

  // 不是 ESC 的按键一律放过（否则任何按键都会去停一轮）
  const notEscape = new ChainEvent("a");
  plot.dispatch(notEscape);
  assert.deepStrictEqual(stop.calls, ["stop"], "非 ESC 不许触发兜底");
  assert.strictEqual(dispatchEscape(notEscape), "ignored");
}

/* ==================== 6. 生命周期：卸载 / 失活必须注销，不能永久吞键 ==================== */

{
  const { window, plot } = chain();
  const log: string[] = [];
  const stop = stops();
  window.addEventListener("keydown", fallback("none", true, stop.stop));

  // 活跃期间接管；注销（含幂等重复注销）之后这次按键重新落到兜底上——清理效果由
  // 事件本身观察，不另开观测口
  const layer = activeLayer(ESC_LAYER.floating, "one", log);
  plot.press("Escape");
  assert.deepStrictEqual(log, ["one"], "活跃层消费");
  assert.deepStrictEqual(stop.calls, [], "有消费者时不停止");
  const release = layer.release;
  release();
  release(); // 幂等：重复注销（StrictMode 双跑 cleanup）不许把别人删掉
  plot.press("Escape");
  assert.deepStrictEqual(log, ["one"], "注销之后不再消费");
  assert.deepStrictEqual(stop.calls, ["stop"], "注销之后同一次 ESC 回到兜底（没有留下永久吞键的空壳）");

  // 两个浮层各登记一次（同层）：注销其中一个，另一个照旧接管，没有连带删掉别人
  const a = registerEscapeLayer({
    priority: ESC_LAYER.floating,
    consume: () => {
      log.push("a");
      return true;
    },
  });
  const b = registerEscapeLayer({
    priority: ESC_LAYER.floating,
    consume: () => {
      log.push("b");
      return true;
    },
  });
  a();
  plot.press("Escape");
  assert.deepStrictEqual(log, ["one", "b"], "注销 a 不影响 b（同层后注册的先消费）");
  b();
  plot.press("Escape");
  assert.deepStrictEqual(stop.calls, ["stop", "stop"], "两个都注销后回到兜底");

  // 没有在生成：什么都不做
  const idle = stops();
  fallback("none", false, idle.stop)(new ChainEvent("Escape"));
  assert.deepStrictEqual(idle.calls, [], "没在生成时没有消费者也不动手");
}

/* ==================== 7. attach：唯一监听挂在全局目标上，注销摘掉 ==================== */

{
  const globals = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
  const realAdd = globals.addEventListener;
  const realRemove = globals.removeEventListener;
  const attached: string[] = [];
  const detached: string[] = [];
  globals.addEventListener = (type: string) => attached.push(type);
  globals.removeEventListener = (type: string) => detached.push(type);
  try {
    const off = attachEscapeFallback({
      isConversationForeground: () => true,
      isRunning: () => false,
      stop: () => undefined,
    });
    assert.deepStrictEqual(attached, ["keydown"], "挂且只挂一个 keydown 监听");
    off();
    assert.deepStrictEqual(detached, ["keydown"], "注销摘掉那个监听");
  } finally {
    globals.addEventListener = realAdd;
    globals.removeEventListener = realRemove;
  }
}

/* ==================== 8. 接线锁：消费点都走归属链，不再各写一份 ==================== */

{
  /**
   * 每一处**必须**走归属链（元素层 `consumeEscape` / 浮层 `useEscapeLayer`）的接线。
   * 行为由前面几节钉，这一节只防「有人又手写一份 preventDefault+stopPropagation 或
   * 自己挂一个 window 监听」——那是这条链重新散开的起点。
   */
  const wiring: Array<[string, string]> = [
    ["src/webview/App.tsx", "attachEscapeFallback("],
    // 兜底的前景判据必须来自共享那一个函数，不许在 App 里另写一份 `panel === "none"`
    ["src/webview/App.tsx", "isConversationForeground("],
    ["src/webview/App.tsx", "useEscapeLayer(ESC_LAYER.floating"],
    ["src/webview/components/ContextMenu.tsx", "useEscapeLayer(ESC_LAYER.contextMenu"],
    // 两个全屏模态抽屉各关自己：历史会话（自己的外壳）与后台任务（共用 Drawer 外壳）
    ["src/webview/components/History.tsx", "useEscapeLayer(ESC_LAYER.drawer"],
    ["src/webview/components/Panels.tsx", "useEscapeLayer(ESC_LAYER.drawer"],
    ["src/webview/components/Images.tsx", "useEscapeLayer(ESC_LAYER.imagePreview"],
    ["src/webview/components/primitives.tsx", "useEscapeLayer(ESC_LAYER.floating"],
    ["src/webview/components/FindBar.tsx", "useEscapeLayer(ESC_LAYER.floating"],
    ["src/webview/components/TrajectoryTimeline.tsx", "consumeEscape(event)"],
    ["src/webview/composerCompletion.tsx", "consumeEscape(event)"],
    ["src/webview/components/Composer.tsx", "consumeEscape(event)"],
    ["src/webview/components/Rows.tsx", "consumeEscape(event)"],
  ];
  for (const [file, needle] of wiring) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    assert.ok(source.includes(needle), `${file} 应当走归属链接线（缺 ${needle}）`);
  }

  /**
   * 反向锁：**webview 里判 ESC 键的地方必须紧跟着共享消费**。
   *
   * 手写「`event.key === "Escape"` + preventDefault + stopPropagation」正是这次要消灭的
   * 形状（轨迹那处少了第二半就把会话停了；菜单与原图那两处各写一份又仲裁不了先后）。
   * 只看这一个形状，不碰别的按键（Enter / 空格那类双写与 ESC 无关，见
   * `primitives.tsx` 的行内链接）。
   */
  const escapeLiteral = /["']Esc(?:ape)?["']/;
  const handRolled = /preventDefault\(\);\s*\n\s*(?:\/\/[^\n]*\n\s*)*[^\n]*stopPropagation\(\);/;
  const owned = ["consumeEscape(", "useEscapeLayer(", "timelineEscape("];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  let escapeSites = 0;
  for (const full of walk(join(process.cwd(), "src/webview"))) {
    const file = full.replace(/\\/g, "/").split("src/webview/")[1];
    // 归属链自己就是判 ESC 的那一处，不参与这条锁
    if (file === "escapeOwner.ts") continue;
    const source = readFileSync(full, "utf8");
    for (const match of source.matchAll(new RegExp(escapeLiteral, "g"))) {
      escapeSites += 1;
      const window = source.slice(match.index ?? 0, (match.index ?? 0) + 260);
      assert.ok(
        owned.some((needle) => window.includes(needle)),
        `src/webview/${file} 里判了 ESC 键却没走共享消费（consumeEscape / useEscapeLayer）`,
      );
      assert.ok(
        !handRolled.test(window),
        `src/webview/${file} 里的 ESC 分支还在手写 preventDefault+stopPropagation：消费必须走 consumeEscape`,
      );
    }
  }
  assert.ok(escapeSites >= 4, `webview 里应当还有若干处判 ESC（实际 ${escapeSites} 处）——锁不该空转`);

  /**
   * 兜底**只有一处挂点**：`attachEscapeFallback` 不许在第二个地方再挂一份（`(` 后面跟
   * 对象字面量才算挂点，模块自己的函数声明不算）。多挂一份就等于多一条绕过归属链与
   * 前景判据的停止路径（这正是「轨迹页也能中止会话」的形状）。
   */
  const attachSites = walk(join(process.cwd(), "src/webview"))
    .filter((full) => readFileSync(full, "utf8").includes("attachEscapeFallback({"))
    .map((full) => full.replace(/\\/g, "/").split("src/webview/")[1]);
  assert.deepStrictEqual(attachSites, ["App.tsx"], "ESC 兜底只许 App 挂一次");
}

console.log(
  "escapeOwner: ESC 归属链（菜单>原图>抽屉>浮层 / 轨迹聚焦不停止 / 仅会话页前景才停止 / 生命周期） ✓",
);
