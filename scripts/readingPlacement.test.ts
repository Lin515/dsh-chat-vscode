/**
 * 阅读定位端口（`src/webview/readingPlacement.ts`）的**行为**断言（真调用，不读源码）。
 *
 * 这条链路以前散在两处、靠调用方各自记顺序：
 * - `turnRailNav.ts` 里五个 `releaseRef.current?.()`，每个后面各接自己的 scrollTop /
 *   `landOnRow` / `trackLanding`；
 * - `FindBar.tsx` 的 `reveal()` 先放跟随、再双 rAF、再居中。
 *
 * 现在一次阅读动作（有效性判定 → 放跟随 → 几何写入 → 延期 / 稳定落位 → 过期作废）
 * 只有一份实现，喂一个**可注入的 DOM / 帧源**就能真跑：本脚本的假滚动区记录每一次
 * `scrollTop` 写入，于是「release 在写之前」「无效目标 no-op」「取历史前后各放一次」
 * 都能按**调用顺序**断言，而不是读源码正则。
 *
 * 仍然留在源码层的只有**接线**（谁接哪个端口、闸门在动作之前）——那是另一种事实。
 *
 * 运行：npm test（或 npm run build:scripts && node build/reading-placement.test.mjs）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createReadingPort, type ReadingEnv } from "../src/webview/readingPlacement";
import type { AutoScrollPort } from "../src/webview/autoScroll";

type Listener = (event: unknown) => void;

/** 按调用顺序记录的日志：`release` / `expand` / `expanded` / `fetch` / `write:<值>`。 */
type Log = string[];

interface FakeScroller {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  top: number;
  listeners: Map<string, Listener[]>;
  addEventListener(type: string, listener: Listener, options?: unknown): void;
  removeEventListener(type: string, listener: Listener): void;
  getBoundingClientRect(): { top: number; left: number };
}

/**
 * 假滚动区：`scrollTop` 的每次写入都进日志（用 Proxy 拦赋值，`+=` 也走同一条）。
 *
 * 不做浏览器那种夹取——本脚本要断言的是**写不写、写多少、谁先谁后**，量足够大
 * （`scrollHeight` 十万）就不会有测试摆出「实际不可达的位置」这回事。
 */
function fakeScroller(log: Log): FakeScroller {
  const listeners = new Map<string, Listener[]>();
  const el: FakeScroller = {
    scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 100000,
    top: 0,
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
    getBoundingClientRect: () => ({ top: el.top, left: 0 }),
  };
  return new Proxy(el, {
    set(target, key, value): boolean {
      if (key === "scrollTop") log.push(`write:${String(value)}`);
      Reflect.set(target, key, value);
      return true;
    },
  });
}

/** 真派发：走模块用 `addEventListener` 注册进去的那一个处理器。 */
function emit(target: { listeners: Map<string, Listener[]> }, type: string): void {
  for (const listener of [...(target.listeners.get(type) ?? [])]) listener({});
}

/**
 * 假行：`top` 是**文档坐标**里的位置，`getBoundingClientRect` 由滚动位置算出来——
 * 真实浏览器里滚一下，行的视口矩形就跟着上移，跟踪那条「偏差归零」的收敛全靠它。
 */
interface FakeRow {
  isConnected: boolean;
  top: number;
  getBoundingClientRect(): { top: number; left: number; height: number };
}

function fakeRow(top: number, scrollport: () => number): FakeRow {
  const row: FakeRow = {
    isConnected: true,
    top,
    getBoundingClientRect: () => ({ top: row.top - scrollport(), left: 0, height: 20 }),
  };
  return row;
}

/** 受控环境：帧要手动放，DOM 查询全走这里的假实现。 */
function harness() {
  const log: Log = [];
  const rows = new Map<string, FakeRow>();
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const scroller = fakeScroller(log);
  const content = { tag: "chat-list" };

  const env: ReadingEnv = {
    requestFrame(callback) {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    flowTop: (row, scrollport) =>
      row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top,
    rangeRect: (range) => (range as unknown as { rect: { top: number; height: number } }).rect,
    anchorRow: (_list, messageId) => (rows.get(messageId) ?? null) as unknown as HTMLElement | null,
    expandClamped: (anchor) => {
      log.push("expand");
      (anchor as unknown as { expand?: () => void }).expand?.();
    },
  };

  const port = createReadingPort(
    {
      scrollEl: { current: scroller } as unknown as AutoScrollPort["scrollEl"],
      contentEl: { current: content } as unknown as AutoScrollPort["contentEl"],
      release: () => log.push("release"),
      pin: () => undefined,
    },
    env,
  );

  const pendingFrames = (): number => frames.size;
  /** 放掉**最早排队**的那一帧（两帧链要按顺序放）。 */
  const runFrame = (): void => {
    const entry = frames.entries().next();
    assert.ok(!entry.done, "应当有排队的帧（信号 → 帧这一条断了）");
    const [id, callback] = entry.value;
    frames.delete(id);
    callback();
  };
  /** 放掉当前排着的所有帧（跑满跟踪观察窗时用）。 */
  const drainFrames = (): void => {
    let guard = 0;
    while (frames.size > 0) {
      assert.ok(guard < 2000, "帧链没有收敛（每帧只该排下一帧）");
      guard += 1;
      runFrame();
    }
  };
  const row = (messageId: string, top: number): FakeRow => {
    const created = fakeRow(top, () => scroller.scrollTop);
    rows.set(messageId, created);
    return created;
  };
  const target = (messageId: string | null) => ({ resolve: () => messageId });

  return {
    log,
    rows,
    row,
    target,
    scroller,
    port,
    env,
    pendingFrames,
    runFrame,
    drainFrames,
  };
}

/** 假命中 Range：宿主元素 + 矩形（展开之后的布局由测试摆）。 */
function fakeRange(anchor: unknown, rect: { top: number; height: number }): Range {
  return { startContainer: { parentElement: anchor }, rect } as unknown as Range;
}

console.log("reading-placement: 假滚动区 / 假行 / 手放帧就绪");

// ---------- 1. 落到行：先放跟随，再写视口 ----------
//
// 程序化滚动不算手势（`autoScroll` 的意愿只由手势翻），不放跟随的话下一次 settle
// 会把视口钉回底部。顺序不能反：先写再放，settle 已经排上队了。
{
  const world = harness();
  const line = world.row("u:1", 500);
  assert.strictEqual(
    world.port.landRow(world.target("u:1")),
    true,
    "行在 DOM 里就必须落位（返回 true）",
  );
  assert.deepStrictEqual(
    world.log,
    ["release", "write:476"],
    "必须先 release、再写 scrollTop（行顶 500 − 24 落位；先写再放的话 settle 已经把它吃掉）",
  );

  // 跟踪那一帧读的是「行顶 − 24」的偏差，而不是另算一个几何
  line.top = 900;
  world.runFrame();
  assert.deepStrictEqual(
    world.log.slice(2),
    ["write:876"],
    "行被异步变高的内容推走后，跟踪帧把它拉回 24px 落位（476 + (900 − 476 − 24)）",
  );
  world.port.cancel();
}
console.log("reading-placement: 落位先放跟随、24px 落位几何 ✓");

// ---------- 2. 首枚刻点置顶：同样先放跟随 ----------
{
  const world = harness();
  world.scroller.scrollTop = 700;
  world.log.length = 0;
  assert.strictEqual(world.port.toTop(), true);
  assert.deepStrictEqual(world.log, ["release", "write:0"], "置顶也是先放跟随再写 0");
}
console.log("reading-placement: 首枚刻点置顶（先放跟随）✓");

// ---------- 3. 无效目标 no-op：不写视口，也不放跟随 ----------
{
  const world = harness();
  world.scroller.scrollTop = 300;
  world.log.length = 0;
  assert.strictEqual(
    world.port.landRow(world.target("u:404")),
    false,
    "行不在 DOM 里 → 不落位",
  );
  assert.deepStrictEqual(
    { log: world.log, top: world.scroller.scrollTop },
    { log: [], top: 300 },
    "无效目标必须完全不动：一次白点的点击不许顺手把实况跟随关掉（也不许写视口）",
  );

  // 窗口本身不在场（轨迹视图顶掉会话页）：同样 no-op
  (world.port.scrollEl as unknown as { current: unknown }).current = null;
  world.log.length = 0;
  assert.strictEqual(world.port.landRow(world.target("u:1")), false, "滚动区不在场 → 不落位");
  assert.deepStrictEqual(world.log, [], "没有窗口时连 release 都不该发生");
}
console.log("reading-placement: 无效目标 no-op（不释放跟随）✓");

// ---------- 4. 延期落位：取历史前放一次，取回来落位前再放一次 ----------
//
// 取历史的补偿会让视口落在（近）底部，`scroll()` 的「回到近底部即恢复跟随」会把意愿
// 翻回去，rAF 里的 settle 随即把刚算好的位置吃掉。所以请求前与落位前各放一次。
{
  const world = harness();
  let fetched = 0;
  assert.strictEqual(
    world.port.awaitRow(world.target("u:1"), () => {
      fetched += 1;
      world.log.push("fetch");
    }),
    true,
  );
  assert.deepStrictEqual(
    world.log,
    ["release", "fetch"],
    "取历史必须在放跟随**之后**发出去（顺序反了，取期间的 prepend 补偿会被 settle 拉回底部）",
  );
  assert.strictEqual(fetched, 1);

  // 历史还没回来：每次布局提交试一次，但什么都不做
  assert.strictEqual(world.port.commitRow(), false, "锚点行还没渲染出来 → 这一次不落位");
  assert.deepStrictEqual(world.log, ["release", "fetch"], "空转的提交不许再放一次跟随");

  // 历史回来了
  world.row("u:1", 800);
  assert.strictEqual(world.port.commitRow(), true, "锚点行一出现就落位");
  assert.deepStrictEqual(
    world.log,
    ["release", "fetch", "release", "write:776"],
    "取回来之后要**再放一次**跟随才写视口（800 − 24），这就是「再点一次就好了」那个坑",
  );
  assert.strictEqual(world.port.commitRow(), false, "落位过的延期目标不许重复消费");
  world.port.cancel();
}
console.log("reading-placement: 取历史前后各放一次跟随 ✓");

// ---------- 5. 延期目标被新动作顶掉 / 取不回来就放弃 ----------
{
  // 5a. 新的一次点击顶掉上一次的延期目标（它盯的是旧目标）
  const world = harness();
  world.port.awaitRow(world.target("u:1"), () => undefined);
  world.log.length = 0;
  world.row("u:9", 600);
  assert.strictEqual(world.port.landRow(world.target("u:9")), true);
  assert.deepStrictEqual(world.log, ["release", "write:576"], "新动作照常落位");
  world.row("u:1", 100);
  assert.strictEqual(world.port.commitRow(), false, "被顶掉的旧延期目标不许再落位");
  assert.strictEqual(world.log.length, 2, "旧目标不许再写视口");

  // 5b. 宿主说取完了但目标没回来（页数安全阀 / 服务端没给）→ 放弃
  const giveUp = harness();
  giveUp.port.awaitRow(giveUp.target("u:1"), () => undefined);
  giveUp.log.length = 0;
  giveUp.port.settleHistory();
  assert.deepStrictEqual(giveUp.log, [], "取不回来的目标：结算时不动视口（也不重复放跟随）");
  giveUp.row("u:1", 700);
  assert.strictEqual(giveUp.port.commitRow(), false, "放弃之后行再出现也不许落位");
  assert.deepStrictEqual(giveUp.log, [], "放弃之后不许再写视口");

  // 5c. 取不回的目标不许把「有一个延期目标」的状态留着（否则刻点一直脉冲）
  const taken = harness();
  taken.port.awaitRow(taken.target(null), () => undefined);
  taken.log.length = 0;
  taken.port.settleHistory();
  assert.deepStrictEqual(taken.log, [], "resolve 给 null 的延期目标结算时同样 no-op");
}
console.log("reading-placement: 延期目标被顶掉 / 取不回就放弃 ✓");

// ---------- 6. 首枚刻点取历史：等宿主说取完了才置顶 ----------
{
  const world = harness();
  world.scroller.scrollTop = 900;
  world.log.length = 0;
  world.port.awaitTop(() => world.log.push("fetch"));
  assert.deepStrictEqual(world.log, ["release", "fetch"], "取历史前先放跟随");
  world.scroller.scrollTop = 600; // 取历史的补偿把它挪回（近）底部
  world.log.length = 0;
  world.port.settleHistory();
  assert.deepStrictEqual(
    world.log,
    ["release", "write:0"],
    "宿主说取完了 → 再放一次跟随再置顶（否则 settle 会把它钉回底部）",
  );
}
console.log("reading-placement: 首枚刻点等取完再置顶（二次释放）✓");

// ---------- 7. 稳定落位跟踪：异步变高、观察窗、手势中断 ----------
{
  const world = harness();
  const row = world.row("u:1", 1000);
  world.port.landRow(world.target("u:1"));
  assert.deepStrictEqual(world.log, ["release", "write:976"]);

  // 已对齐就不写：跟踪帧每帧都写会跟用户的滚动打架
  world.runFrame();
  assert.strictEqual(world.log.length, 2, "行没动时跟踪不许写视口");
  assert.strictEqual(
    world.pendingFrames(),
    1,
    "跟踪要一直排着下一帧（收手只看观察窗，不因「已对齐」提前撤）",
  );

  // 异步变高：代码高亮 / Markdown / 图片撑开上方内容，目标行被往下推
  row.top = 1300;
  world.runFrame();
  assert.deepStrictEqual(world.log.slice(2), ["write:1276"], "被推走之后要跟踪回 24px 落位");

  // 跑满观察窗：此后即使行再动也不再写（跟踪收手）
  world.drainFrames();
  assert.strictEqual(world.pendingFrames(), 0, "跑满观察窗后不再排帧");
  assert.strictEqual(
    world.scroller.listeners.get("wheel")?.length ?? 0,
    0,
    "收手要摘掉手势监听（否则监听会跟着会话一直留着）",
  );
  const settled = world.log.length;
  row.top = 2000;
  assert.strictEqual(world.pendingFrames(), 0, "观察窗结束后不许再有跟踪帧");
  assert.strictEqual(world.log.length, settled, "观察窗结束后不许再写视口");

  // 用户手势立刻让位：跟踪不能跟用户抢方向盘
  const gesture = harness();
  const second = gesture.row("u:1", 1000);
  gesture.port.landRow(gesture.target("u:1"));
  gesture.log.length = 0;
  emit(gesture.scroller, "wheel");
  second.top = 5000;
  assert.strictEqual(gesture.pendingFrames(), 0, "手势要取消还没跑的跟踪帧");
  assert.strictEqual(
    gesture.scroller.listeners.get("wheel")?.length ?? 0,
    0,
    "手势中断后要摘掉监听",
  );
  assert.deepStrictEqual(gesture.log, [], "手势中断之后不许再写视口");

  // 触摸 / 键盘与滚轮同一条纪律
  for (const type of ["touchstart", "keydown"]) {
    const other = harness();
    other.row("u:1", 1000);
    other.port.landRow(other.target("u:1"));
    assert.ok(other.pendingFrames() > 0, "落位之后应当已经在跟踪");
    emit(other.scroller, type);
    assert.strictEqual(other.pendingFrames(), 0, `${type} 也是让位手势`);
  }
}
console.log("reading-placement: 300 帧跟踪 + 异步变高 + 手势让位 ✓");

// ---------- 8. 查找命中：展开 → 放跟随 → 两帧 → 居中 ----------
//
// 展开必须点带 `aria-expanded` 的按钮（React 状态画的 `is-clamped` 手改 class 撑不过
// 下次渲染）；居中必须用命中 Range **自己**的矩形（气泡展开后以气泡顶为目标是错的）。
{
  const world = harness();
  const anchor = { isConnected: true, expand: () => world.log.push("expanded") };
  const range = fakeRange(anchor, { top: 300, height: 20 });

  assert.strictEqual(world.port.revealMatch(range), true);
  assert.deepStrictEqual(
    world.log,
    ["expand", "expanded", "release"],
    "展开在放跟随之前（顺序由端口拥有，调用方不必记）",
  );
  assert.strictEqual(world.pendingFrames(), 1, "第一帧等 React 提交");
  world.runFrame();
  assert.deepStrictEqual(world.log.slice(3), [], "第一帧只排第二帧，不写视口");
  assert.strictEqual(world.pendingFrames(), 1);
  world.runFrame();
  assert.deepStrictEqual(
    world.log.slice(3),
    ["write:100"],
    "第二帧量展开后的布局再居中（300 − 0 − 400/2 = 100）",
  );
  assert.strictEqual(
    world.scroller.listeners.get("wheel")?.length ?? 0,
    0,
    "落定后要摘掉两帧等待期的监听",
  );
}
console.log("reading-placement: 命中展开 + 两帧后居中 ✓");

// ---------- 9. 查找的无效目标：完全不动（连跟随都不放） ----------
{
  // 元素已断开（React 换了行）
  const disconnected = harness();
  const gone = fakeRange({ isConnected: false }, { top: 300, height: 20 });
  assert.strictEqual(
    disconnected.port.revealMatch(gone),
    false,
    "宿主元素断开 → 不展开、不排帧",
  );
  assert.deepStrictEqual(
    { log: disconnected.log, pending: disconnected.pendingFrames() },
    { log: [], pending: 0 },
    "断开的目标必须完全不动（不放跟随、不排帧）",
  );

  // Range 取不到宿主元素
  const orphan = harness();
  assert.strictEqual(orphan.port.revealMatch(fakeRange(null, { top: 10, height: 10 })), false);
  assert.deepStrictEqual(orphan.log, [], "没有宿主元素 → no-op");

  // 滚动区不在场
  const closed = harness();
  (closed.port.scrollEl as unknown as { current: unknown }).current = null;
  assert.strictEqual(
    closed.port.revealMatch(fakeRange({ isConnected: true }, { top: 10, height: 10 })),
    false,
  );
  assert.deepStrictEqual(closed.log, [], "滚动区不在场 → no-op（不许放跟随）");

  // 展开之后命中仍不可见（矩形高 0）：跟随已经放了，但视口留在原处——既有行为
  const invisible = harness();
  invisible.scroller.scrollTop = 250;
  invisible.log.length = 0;
  invisible.port.revealMatch(fakeRange({ isConnected: true }, { top: 300, height: 0 }));
  assert.deepStrictEqual(invisible.log, ["expand", "release"], "展开与放跟随照做");
  invisible.drainFrames();
  assert.deepStrictEqual(
    invisible.log,
    ["expand", "release"],
    "展开后仍不可见 → 视口留在原处（不因为「已经放了跟随」就补一次滚动）",
  );
  assert.strictEqual(invisible.scroller.scrollTop, 250);
}
console.log("reading-placement: 查找无效目标 no-op / 展开后仍不可见保留原行为 ✓");

// ---------- 10. 查找两帧等待期的竞争：手势 / 切会话 / 滚动区换人 ----------
//
// 这两帧是**唯一**在两次任务之间留着的窗口：读者手势、切会话、面板切换都可能发生在
// 中间。旧实现只查了 `anchor.isConnected`，这三种一个都不拦。
{
  // 10a. 第一帧还没跑就来手势
  const early = harness();
  early.port.revealMatch(fakeRange({ isConnected: true }, { top: 300, height: 20 }));
  early.log.length = 0;
  emit(early.scroller, "wheel");
  assert.strictEqual(early.pendingFrames(), 0, "手势要取消还没跑的等待帧");
  assert.deepStrictEqual(early.log, [], "手势之后不许写视口");

  // 10b. 两帧之间来手势（第一帧已跑、第二帧在排队）
  const between = harness();
  between.port.revealMatch(fakeRange({ isConnected: true }, { top: 300, height: 20 }));
  between.runFrame();
  assert.strictEqual(between.pendingFrames(), 1, "第二帧已排队");
  between.log.length = 0;
  emit(between.scroller, "keydown");
  assert.strictEqual(between.pendingFrames(), 0, "两帧之间的手势要取消第二帧");
  assert.deepStrictEqual(between.log, [], "取消之后第二帧不许再跑（不许写视口）");
  assert.strictEqual(
    between.scroller.listeners.get("keydown")?.length ?? 0,
    0,
    "取消要摘掉监听",
  );

  // 10c. 两帧之间切会话（cancel）——迟到的帧不许再写视口
  const switched = harness();
  switched.port.revealMatch(fakeRange({ isConnected: true }, { top: 300, height: 20 }));
  switched.runFrame();
  switched.log.length = 0;
  switched.port.cancel();
  assert.strictEqual(switched.pendingFrames(), 0, "切会话要取消在飞的等待帧");
  switched.drainFrames();
  assert.deepStrictEqual(switched.log.filter((entry) => entry.startsWith("write")), [], "切会话之后迟到帧不许写视口");
  assert.strictEqual(
    switched.scroller.listeners.get("wheel")?.length ?? 0,
    0,
    "切会话要摘掉等待期的监听（rAF / 监听都要清）",
  );

  // 10d. 两帧之间滚动区换人（面板切换重挂）：当初那个元素已经不是端口里的那一个
  const swapped = harness();
  swapped.port.revealMatch(fakeRange({ isConnected: true }, { top: 300, height: 20 }));
  swapped.runFrame();
  const fresh = fakeScroller(swapped.log);
  (swapped.port.scrollEl as unknown as { current: unknown }).current = fresh;
  swapped.log.length = 0;
  swapped.drainFrames();
  assert.deepStrictEqual(swapped.log, [], "滚动区换人之后旧帧只许收手，不许写新元素");
  assert.strictEqual(fresh.scrollTop, 0, "新滚动区一个像素都不许被旧动作动过");

  // 10e. 旧的查找动作不许盖掉新的一次落位
  const superseded = harness();
  superseded.row("u:1", 500);
  superseded.port.revealMatch(fakeRange({ isConnected: true }, { top: 900, height: 20 }));
  superseded.runFrame();
  superseded.log.length = 0;
  assert.strictEqual(superseded.port.landRow(superseded.target("u:1")), true);
  superseded.drainFrames();
  assert.deepStrictEqual(
    superseded.log.filter((entry) => entry.startsWith("write")),
    ["write:476"],
    "新动作开始后，旧查找的迟到帧一个字都不许再写",
  );
  superseded.port.cancel();
}
console.log("reading-placement: 两帧窗口的手势 / 切会话 / 换元素 / 新动作竞争 ✓");

// ---------- 11. 接线：协议不许漏回调用方 ----------
//
// 事实层：谁接哪个端口、闸门在动作之前、贴底阈值只有一份。行为断言在 1–10 段。
{
  const nav = readFileSync(join(process.cwd(), "src", "webview", "turnRailNav.ts"), "utf8");
  const find = readFileSync(join(process.cwd(), "src", "webview", "components", "FindBar.tsx"), "utf8");
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const auto = readFileSync(join(process.cwd(), "src", "webview", "autoScroll.ts"), "utf8");

  // 一次阅读动作的协议（release 顺序 / 几何 / 帧 / 清理）不许漏回调用方
  assert.ok(
    !/releaseFollow|releaseRef/.test(nav),
    "横条不许再接第二个释放通道：放跟随是阅读定位端口内部的一步",
  );
  assert.ok(
    !/\.scrollTop\s*(\+|-)?=/.test(nav) && !/\.scrollTop\s*(\+|-)?=/.test(find),
    "调用方不许自己写视口（落位几何与居中都在端口里）；写出来就说明协议又漏回去了",
  );
  assert.ok(
    !/requestAnimationFrame/.test(find) && !/addEventListener\("wheel"/.test(find),
    "查找条不许自己接帧与手势（两帧等待与中断都在端口里）",
  );
  assert.ok(
    /port\.awaitTop\(fetch\)/.test(nav) && /port\.awaitRow\(rowTargetOf\(turn\), fetch\)/.test(nav),
    "窗口外轮次走端口的延期动作（放跟随 → 取历史是一步）",
  );
  assert.ok(
    /port\.landRow\(/.test(nav) && /port\.toTop\(\)/.test(nav) && /port\.commitRow\(\)/.test(nav),
    "已加载轮次 / 首枚刻点 / 取回后的落位都走端口",
  );
  assert.ok(/port\.settleHistory\(\)/.test(nav), "「宿主说取完了」的结算走端口");
  assert.ok(/port\.revealMatch\(range\)/.test(find), "查找跳命中走端口的一次完整动作");

  // 闸门仍然在动作**之前**：没有更早历史 / 已在取历史时，点击是 no-op，
  // 不许顺手把实况跟随关掉（这条防御自 2026-09-20 起就在）
  const gate = nav.indexOf('if (!hasMoreHistory || historyLoading) return;');
  const firstAction = nav.indexOf("port.awaitTop(fetch)");
  assert.ok(
    gate > 0 && firstAction > gate,
    "no-op 的点击闸门必须在任何阅读动作之前（反了的话白点一次就关掉跟随）",
  );
  assert.ok(
    !/running: boolean;/.test(nav) && !/running \|\|/.test(nav),
    "生成中不再拦「跳到未加载的轮次」（官方同一枚刻点也不看 running）",
  );

  // 贴底阈值只有 `autoScroll` 那一份：横条改用它的判据，不再自带一个 40
  assert.ok(
    /atBottom\(bottomGap\(el\)\)/.test(nav),
    "横条的贴底短路要读 autoScroll 的判据（阈值知识只留一处）",
  );
  assert.ok(
    !/FOLLOW_THRESHOLD_PX/.test(nav) && !/[<>=]=?\s*40\b/.test(nav),
    "横条不许再复制一份贴底阈值（40 只留在 autoScroll 那一份里，横条只读它的判据）",
  );
  assert.ok(
    /export function atBottom/.test(auto) && /export function bottomGap/.test(auto),
    "这两个判据本来就是 autoScroll 的导出面，横条直接用它们（不为去重复而新暴露私有规则）",
  );

  // 切会话的作废必须排在落位之前（同一次提交里布局 effect 按声明顺序跑）
  assert.ok(
    /useLayoutEffect\(\(\) => \{\s*port\.cancel\(\);/.test(nav),
    "切会话 / 面板切换的作废要是布局 effect，且声明在落位 effect 之前（否则换会话后第一次提交会拿新 items 落旧目标）",
  );
  assert.ok(
    nav.indexOf("port.cancel();") < nav.indexOf("port.commitRow()"),
    "作废声明在落位之前",
  );

  // 一份端口给两个消费方：不再各自接 release / ref / action
  assert.ok(
    /const reading = useReadingPort\(chatScroll\.port\);/.test(app),
    "App 从 autoScroll 端口建一份阅读定位端口",
  );
  assert.ok(
    /port: reading,/.test(app) && /<FindBar port=\{reading\} \/>/.test(app),
    "横条与查找条共用同一份端口（一次只可能有一个阅读动作）",
  );
  assert.ok(
    !/releaseFollow/.test(app) && !/releaseFollow\s*[:(]/.test(auto),
    "放跟随只留 port.release 一条通道（binding 上那个转发面已删）",
  );
}
console.log("reading-placement: 接线（一份端口 / 闸门在动作前 / 阈值只有一份）✓");

console.log("\nreading-placement: all assertions passed");
