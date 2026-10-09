/**
 * 轨迹**交互端口**的离线断言（`src/webview/trajectoryInteraction.ts`）。
 *
 * 组件与测试跨的是**同一个缝**：`createTrajectoryInteraction()`。真实组件经
 * `useTrajectoryInteraction()` 拿到的就是这里 `makePort()` 拿到的那个对象，
 * 所以下面这些规则不是「照着组件重写一遍的镜像」，而是组件真的会执行的那份代码。
 *
 * 覆盖的是主代理真实 DOM 验收里红的四条加 §8 的两条纠偏：
 *
 * - **F06 落点只消费一次**：定位之后手滚的位置不许被旧 `reveal` 拉回；
 * - **F06 首次落点完整可见**：端口写下的 `scrollTop` 会让绘制计划按新位置重排，重排之后
 *   目标行还会偏（真实 DOM 首次裁半行），所以补一次实测余量（`settleReveal`，票据在对齐 /
 *   用户手滚 / 切会话 / 卸载时作废），且不做 rAF 轮询；判定还必须等**计划追上写下的位置**
 *   （重排之前量到的「已经贴边」属于马上要被换掉的布局，拿它收票据首次落点照样裁行）；
 * - **F08 落点命中才 ack**：未命中保持 pending、命中即 ack，且同一个 callId 再来
 *   一次算新动作（`focusRevision`）；
 * - **F10 选择链唯一拥有者**：时间线点选清请求、层级链接开请求清记录、Escape /
 *   关闭 / 切会话三者一致清空；
 * - **§8.2 用户手势优先**：用户平移 / 缩放之后，旧选中不再把视口拉回；
 * - **边缘平移用最新几何**：每次调用都现读容器矩形并累加最新 `offset`（不 rAF 节流）；
 * - **区外抬起 / 卸载清理**：`document` 监听一定摘掉。
 *
 * 运行：npm test（本文件登记在 `esbuild.scripts.mjs` 的 entries 里）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTrajectoryInteraction,
  minimumSelection,
  trajectoryCenteredRange,
  trajectoryFollowOffset,
  trajectoryNearestSpanIndex,
} from "../src/webview/trajectoryInteraction";
import { trajectoryWindowPlan } from "../src/webview/trajectoryVirtual";

/** 一个可控的假账本容器：行位置（`rect.top`）由表给定。 */
function fakeLedger(tops: Record<number, number>, boxTop = 0) {
  return {
    scrollTop: 0,
    querySelector(selector: string) {
      const match = /data-cell-index="(\d+)"/.exec(selector);
      const index = match === null ? Number.NaN : Number(match[1]);
      if (!(index in tops)) return null;
      return { getBoundingClientRect: () => ({ top: tops[index] }) };
    },
    getBoundingClientRect: () => ({ top: boxTop }),
  } as unknown as HTMLDivElement;
}

/** 一个可控的假绘图区（时间线容器）。 */
function fakePlot(rect = { left: 0, width: 1000, top: 0, height: 50 }) {
  return { getBoundingClientRect: () => rect } as unknown as HTMLDivElement;
}

const SPANS = [
  { cellIndex: 1, left: 0.0, width: 0.1 },
  { cellIndex: 2, left: 0.1, width: 0.1 },
  { cellIndex: 3, left: 0.2, width: 0.1 },
];

// ---------- 1. 选择链：记录 / 请求 / 页签三者互斥（F10①②③） ----------
{
  const port = createTrajectoryInteraction("s1");
  // F10①：时间线点选（openRecord）必须清掉请求检查器
  port.selectRecord(3);
  port.selectRequest(1);
  assert.strictEqual(port.state.record, undefined, "开请求检查器要清记录检查器");
  port.openRecord(7);
  assert.strictEqual(port.state.request, undefined, "时间线点选要把请求检查器关掉（否则记录与请求两个都亮）");
  assert.strictEqual(port.state.requestTab, undefined, "点选记录不该留着请求页签");
  assert.strictEqual(port.state.record, 7, "点选的那条记录就是选中");
  assert.strictEqual(port.state.range, null, "点 span = 直接选中并清掉旧选区（官方 onRangeChange(null)）");

  // F10②：层级链接进请求面板 → 记录检查器不该留着重开
  port.selectRecord(3);
  port.selectRequest(1);
  assert.strictEqual(port.state.record, undefined, "层级链接开请求时记录检查器不复存在（关掉请求不会复活它）");
  port.clearSelection();
  assert.strictEqual(port.state.record, undefined, "关闭之后记录检查器不会复活");
  assert.strictEqual(port.state.request, undefined, "关闭之后请求检查器也不在");

  // F10③：Escape（clearSelection）三者一起清
  port.selectRequest(2, "timing");
  port.setRange({ start: 0.2, end: 0.4 });
  assert.strictEqual(port.state.requestTab, "timing", "请求计时那条入口带页签");
  port.clearSelection();
  assert.deepStrictEqual(
    [port.state.record, port.state.request, port.state.requestTab, port.state.range],
    [undefined, undefined, undefined, null],
    "Escape / 双击 / 关闭：选择、请求、选区、页签一起清（从前 Escape 不清请求）",
  );
}

// ---------- 2. F06：落点只消费一次，手滚不被拉回 ----------
{
  const port = createTrajectoryInteraction("s1");
  port.ledger.current = fakeLedger({ 7: 235 });
  port.reveal(7);
  const first = port.state.reveal;
  assert.ok(first !== null && first.index === 7, "落点请求带目标与 nonce");
  assert.strictEqual(port.applyReveal(7, first.nonce), true, "第一次消费成功");
  assert.strictEqual(port.ledger.current.scrollTop, 235, "目标行顶边贴住账本视口顶边");
  // 用户手滚：窗口变化 / 重渲染都不该再消费同一个 nonce
  port.ledger.current.scrollTop = 2000;
  assert.strictEqual(port.applyReveal(7, first.nonce), false, "同一个 nonce 只消费一次（旧 reveal 不会把用户拉回）");
  assert.strictEqual(port.ledger.current.scrollTop, 2000, "手滚到的位置原地不动");
  // 同目标的新动作：nonce 变了就该重新对齐一次
  port.reveal(7);
  const second = port.state.reveal;
  assert.ok(second !== null && second.nonce > first.nonce, "同一条记录再点一次是新 nonce");
  assert.strictEqual(port.applyReveal(7, second.nonce), true, "新 nonce 重新消费（同 callId 的新动作不被吞掉）");
  // 目标行还不在账本里（历史没到 / 被搜索滤掉）：不消费，留着等
  const port2 = createTrajectoryInteraction("s1");
  port2.ledger.current = fakeLedger({});
  port2.reveal(99);
  const pending = port2.state.reveal;
  assert.ok(pending !== null);
  assert.strictEqual(port2.applyReveal(99, pending.nonce), false, "目标行不在 DOM 里时这次不算消费");
  port2.ledger.current = fakeLedger({ 99: 12 });
  assert.strictEqual(port2.applyReveal(99, pending.nonce), true, "行一出现仍能消费同一个请求");
}

// ---------- 3. F08：跨视图落点命中才 ack，未命中保持 pending ----------
{
  const port = createTrajectoryInteraction("s1");
  port.inspectCall("call_x");
  assert.strictEqual(port.state.pendingCallId, "call_x", "请求进端口就是 pending");
  assert.strictEqual(port.resolveFocus(undefined), false, "解不出来什么都不做（官方 Not-found leaves pending）");
  assert.strictEqual(port.state.pendingCallId, "call_x", "未命中时请求留着");
  assert.strictEqual(port.state.record, undefined, "未命中不改选中");
  assert.strictEqual(port.resolveFocus(50), true, "命中：选中 + 滚动 + ack");
  assert.strictEqual(port.state.pendingCallId, undefined, "命中即 ack（这就是 F08 的修复点）");
  assert.strictEqual(port.state.record, 50, "选中的是目标那一条");
  assert.strictEqual(port.state.reveal?.index, 50, "同时请求账本滚过去");
  // ack 之后账本换身份（turns 更新）也不重放：调用方读 pendingCallId 会直接短路
  assert.strictEqual(port.resolveFocus(50), false, "没有 pending 时 resolveFocus 不做任何事");
  assert.strictEqual(port.state.record, 50, "也不会改选中");
  // 同一个 callId 再来一次算新动作
  const before = port.state.focusRevision;
  port.inspectCall("call_x");
  assert.ok(port.state.focusRevision > before, "同 callId 的新动作要有版本号（只认 value 变化会吞掉它）");
  assert.strictEqual(port.state.pendingCallId, "call_x", "又重新挂起");
}

// ---------- 4. §8.2：用户手势优先，旧选中不拉回视口 ----------
{
  const port = createTrajectoryInteraction("s1");
  port.plot.current = fakePlot();
  /** 一条在很右边、缩进去之后必然看不见的记录。 */
  const far = [...SPANS, { cellIndex: 9, left: 0.9, width: 0.05 }];
  // 先缩进去（未缩放时整个域都在视口里，跟随本来就不该动）
  port.zoomAtCursor(0, -600, 8);
  assert.ok(port.state.zoom > 1, "先放大到有视口余量");
  port.selectRecord(9);
  assert.strictEqual(port.state.followPending, true, "刚选中：欠一次「把选中条带回视野」");
  assert.strictEqual(port.followSelected(far), true, "欠着的那次会动视口");
  assert.ok(port.state.offset > 0, "选中条不在视口里时把视口挪过去");
  assert.strictEqual(port.state.animateViewport, true, "这一次视口变化要走过渡（官方同款）");
  assert.strictEqual(port.followSelected(far), false, "一次就够，不反复动");
  // 用户自己缩放 / 平移之后，旧选中不许再把他拉回去
  port.zoomAtCursor(500, -400, 8);
  const zoomed = port.state.offset;
  assert.strictEqual(port.state.followPending, false, "用户手势清掉跟随欠账");
  assert.strictEqual(port.followSelected(far), false, "旧选中不再回拉（F06 的 §8.2 纠偏）");
  assert.strictEqual(port.state.offset, zoomed, "视口停在用户放下的位置");
  port.panTo(0.1);
  assert.strictEqual(port.followSelected(far), false, "平移之后同样不回拉");
  assert.strictEqual(port.state.offset, 0.1, "平移到位");
  // 没缩放时整个域都在视口里，边缘平移没有余量
  const flat = createTrajectoryInteraction("s1");
  flat.plot.current = fakePlot();
  assert.strictEqual(flat.edgePanAt(0), false, "没缩放时边缘平移没有余量");
}

// ---------- 5. 视口：以光标为锚缩放、边缘平移用最新几何（每次现读，不 rAF） ----------
{
  const port = createTrajectoryInteraction("s1");
  port.plot.current = fakePlot();
  const anchorBefore = port.domainAt(500);
  port.zoomAtCursor(500, -600, 8);
  const zoom = port.state.zoom;
  assert.ok(zoom > 1, "向上滚 = 放大");
  assert.ok(
    Math.abs(port.domainAt(500) - anchorBefore) < 1e-6,
    "光标下的域位置不动（以光标为锚）",
  );
  const before = port.state.offset;
  assert.strictEqual(port.edgePanAt(999), true, "贴着右缘时自动平移一格");
  const afterFirst = port.state.offset;
  assert.ok(afterFirst > before, "往右挪");
  assert.strictEqual(port.edgePanAt(999), true, "再来一次仍要挪（每次都读最新 offset，它不是从渲染闭包来的）");
  assert.ok(port.state.offset > afterFirst, "第二次是在第一次的基础上累加");
  assert.strictEqual(port.state.animateViewport, false, "自动平移不走过渡（有过渡会追动画）");
  const clamped = (() => {
    port.edgePanAt(999);
    return port.state.offset;
  })();
  assert.ok(clamped <= 1 - 1 / zoom + 1e-9, "视口左边界夹在合法范围内");
  port.resetViewport();
  assert.deepStrictEqual([port.state.zoom, port.state.offset], [1, 0], "复位回全部铺满");
}

// ---------- 6. 点空白：保留已提交的最小选区（官方 onRecordFocus 不碰 range） ----------
{
  const port = createTrajectoryInteraction("s1");
  port.plot.current = fakePlot();
  port.syncSpans(SPANS);
  port.setRange({ start: 0.12, end: 0.15 });
  port.focusNearest(2);
  assert.deepStrictEqual(
    [port.state.range?.start, port.state.range?.end],
    [0.12, 0.15],
    "点空白保住了已提交的选区（从前被同 tick 的点选清掉）",
  );
  assert.strictEqual(port.state.record, 2, "同时聚焦最近的那条记录");
  assert.strictEqual(port.state.request, undefined, "聚焦记录不该留着请求检查器");
  // 与「关闭检查器 / 请求标记再点一次」**刻意相反**：那两条走 `clearSelection()`，
  // 连选区一起清掉（清理一致，见「选择链：记录 / 请求 / 页签三者互斥」那节的
  // `clearSelection` 断言——记录、请求、页签与选区一起清）；空白 focus 只聚焦、不碰
  // `range`（官方 `onRecordFocus` 同款）。这条区别由上面「保 range」与那一节的
  // 「一起清」断言一头一尾钉住。
  // 真实手势：点一下（位移 0px）= 最小选区 + 最近记录；拖过 = 提交选区 + 滚第一条
  const port2 = createTrajectoryInteraction("s1");
  port2.plot.current = fakePlot();
  port2.syncSpans(SPANS);
  port2.beginSlice(210); // 域位置 0.21 → 落在第 3 条上
  assert.strictEqual(port2.state.gesture, "slice", "按下就是框选手势（hover 要让位）");
  port2.endSlice(210);
  assert.strictEqual(port2.state.gesture, null, "抬手结束手势");
  const width = minimumSelection(SPANS.length, 1);
  assert.deepStrictEqual(
    { start: port2.state.range?.start, end: port2.state.range?.end },
    trajectoryCenteredRange(0.21, width),
    "点一下给一条以落点为中心的最小选区",
  );
  assert.strictEqual(port2.state.record, 3, "最近的是第 3 条");
  assert.strictEqual(port2.state.reveal?.index, 3, "聚焦同时要滚过去");
  // 拖过：选区已经由拖动写进状态，抬手只提交（滚到选区第一条）
  const port3 = createTrajectoryInteraction("s1");
  port3.plot.current = fakePlot();
  port3.syncSpans(SPANS);
  port3.beginSlice(20);
  port3.extendSlice(180);
  const dragged = port3.state.range;
  assert.ok(dragged !== null && dragged.end > dragged.start, "拖动过程中选区跟着走");
  port3.endSlice(180);
  assert.deepStrictEqual(port3.state.range, dragged, "拖过时不提交最小选区（保的是拖出来的那条）");
  assert.strictEqual(port3.state.reveal?.index, 1, "滚到选区里第一条");
}

// ---------- 7. 区外抬起 / 卸载：document 监听一定摘掉 ----------
{
  const added: string[] = [];
  const removed: string[] = [];
  const fakeDoc = {
    addEventListener: (type: string) => added.push(type),
    removeEventListener: (type: string) => removed.push(type),
  };
  const original = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDoc;
  try {
    const port = createTrajectoryInteraction("s1");
    port.plot.current = fakePlot();
    port.beginSlice(10);
    assert.deepStrictEqual(added, ["mousemove", "mouseup"], "按下时挂上拖动监听（拖出绘图区继续跟手）");
    port.endSlice(10);
    assert.deepStrictEqual(removed, ["mousemove", "mouseup"], "抬起时摘掉（区外抬起也算）");
    const port2 = createTrajectoryInteraction("s1");
    port2.plot.current = fakePlot();
    port2.beginPan(50);
    assert.strictEqual(added.length, 4, "右键平移同样挂监听");
    port2.dispose();
    assert.strictEqual(removed.length, 4, "卸载兜底摘掉还没抬起的监听");
    assert.strictEqual(port2.state.gesture, "pan", "dispose 不改状态（组件已经卸载）");
  } finally {
    if (original === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = original;
  }
}

// ---------- 8. F10④：切会话整份重置 ----------
{
  const port = createTrajectoryInteraction("s1");
  port.plot.current = fakePlot();
  port.selectRequest(1, "usage");
  port.setRange({ start: 0.3, end: 0.4 });
  port.setQuery("target");
  port.toggleAllTurns([0, 1]);
  port.toggleAllCalls(["m1"]);
  port.inspectCall("call_x");
  port.reveal(5);
  port.zoomAtCursor(200, -500, 8);
  port.setSession("s2");
  assert.deepStrictEqual(
    {
      record: port.state.record,
      request: port.state.request,
      requestTab: port.state.requestTab,
      range: port.state.range,
      query: port.state.query,
      collapsedTurns: [...port.state.collapsedTurns],
      collapsedCalls: [...port.state.collapsedCalls],
      pending: port.state.pendingCallId,
      reveal: port.state.reveal,
      zoom: port.state.zoom,
      offset: port.state.offset,
    },
    {
      record: undefined,
      request: undefined,
      requestTab: undefined,
      range: null,
      query: "",
      collapsedTurns: [],
      collapsedCalls: [],
      pending: undefined,
      reveal: null,
      zoom: 1,
      offset: 0,
    },
    "切会话：选择 / 请求 / 选区 / 搜索 / 折叠 / 落点 / 视口一起清（从前只清 App 的 focusCallId）",
  );
  port.setSession("s2");
  assert.strictEqual(port.state.sessionId, "s2", "同一个会话 id 再设一次是空操作");
}

// ---------- 9. 折叠与搜索的状态动作（投影的输入侧） ----------
{
  const port = createTrajectoryInteraction("s1");
  port.toggleTurn(2);
  assert.deepStrictEqual([...port.state.collapsedTurns], [2], "收起一轮");
  port.toggleTurn(2);
  assert.deepStrictEqual([...port.state.collapsedTurns], [], "再点一次展开");
  port.toggleAllTurns([0, 1]);
  assert.deepStrictEqual([...port.state.collapsedTurns].sort(), [0, 1], "全部收起");
  port.toggleAllTurns([0, 1]);
  assert.deepStrictEqual([...port.state.collapsedTurns], [], "全都收着时再点是全部展开");
  port.toggleAllCalls(["m1", "m2"]);
  assert.deepStrictEqual([...port.state.collapsedCalls].sort(), ["m1", "m2"], "调用折叠是稳定身份集合");
  port.expandCall("m1");
  assert.deepStrictEqual([...port.state.collapsedCalls], ["m2"], "展开一条不动其余");
  port.expandTurn(9);
  assert.deepStrictEqual([...port.state.collapsedTurns], [], "展开一条没收起的轮是空操作");
  port.setQuery("abc");
  assert.strictEqual(port.state.query, "abc", "搜索词只由输入改（清掉查询不该动折叠集合）");
  assert.deepStrictEqual([...port.state.collapsedCalls], ["m2"], "清查询/改查询不碰折叠集合");
}

// ---------- 10. 纯辅助：最小选区 / 居中 / 最近 / 跟随偏移 ----------
{
  assert.strictEqual(minimumSelection(0, 1), 1, "没有记录时最小选区是整个域");
  assert.strictEqual(minimumSelection(100, 1), 0.01, "一条记录的平均跨度");
  assert.strictEqual(minimumSelection(4, 8), 0.125, "缩得越深，最小选区越窄（取视口跨度）");
  assert.deepStrictEqual(trajectoryCenteredRange(0, 0.2), { start: 0, end: 0.2 }, "左端夹住");
  assert.deepStrictEqual(trajectoryCenteredRange(1, 0.2), { start: 0.8, end: 1 }, "右端夹住");
  assert.strictEqual(trajectoryNearestSpanIndex(SPANS, 0.11), 2, "落点在第 2 条里就是它");
  assert.strictEqual(trajectoryNearestSpanIndex(SPANS, 0.5), 3, "落在右边空白处时取最近的一条");
  assert.strictEqual(trajectoryNearestSpanIndex([], 0.5), undefined, "一条都没有时不猜");
  assert.strictEqual(trajectoryFollowOffset(SPANS[1], 1, 0), null, "已经完整在视口里就不动");
  assert.strictEqual(
    trajectoryFollowOffset({ cellIndex: 9, left: 0.6, width: 0.05 }, 2, 0),
    0.375,
    "不在视口里时居中（0.625 - 0.5/2）",
  );
  assert.strictEqual(
    trajectoryFollowOffset({ cellIndex: 9, left: 0.9, width: 0.05 }, 2, 0),
    0.5,
    "居中之后越界就夹在右端（1 - 1/2）",
  );
}

// ---------- 11. 组件真的用这个端口（接线，不是行为判据） ----------
{
  const view = readFileSync(join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"), "utf8");
  assert.ok(/useTrajectoryInteraction\(sessionId\)/.test(view), "组件要从端口拿状态与动作");
  assert.ok(/port\.applyReveal\(target\.index, target\.nonce\)/.test(view), "落点由端口消费（一次性判据在端口里）");
  assert.ok(
    /\}, \[reveal\?\.nonce, port\]\)/.test(view),
    "落点对齐只跟 nonce 走：窗口下标 / 行高变化不重跑（重跑会把用户手滚拉回）",
  );
  assert.ok(
    /port\.settleReveal\(target\.index, target\.nonce, scrollTop\)/.test(view),
    "窗口按新的 scrollTop 重排之后，组件再补一次实测余量（并把这一帧计划用的滚动位置一起交进去：计划没追上之前不许取判定）",
  );
  assert.ok(
    /\}, \[scrollTop, port\]\)/.test(view),
    "收尾只跟新的滚动位置走；跟着每一次渲染跑就成了重复回拉",
  );
  assert.ok(/setScrollTop\(applied\)/.test(view), "写下的 scrollTop 立刻交回 React（窗口就是按它重排的）");
  const revealRegion = view.slice(
    view.indexOf("port.applyReveal(target.index, target.nonce)"),
    view.indexOf("port.settleReveal(target.index, target.nonce)"),
  );
  assert.ok(revealRegion.length > 0, "落点对齐与收尾两段 effect 都在组件里");
  assert.ok(!/requestAnimationFrame/.test(revealRegion), "落点不做 rAF 轮询（那会把用户手滚拉回）");
  assert.ok(/port\.resolveFocus\(index\)/.test(view), "跨视图落点命中即 ack");
  const timeline = readFileSync(join(process.cwd(), "src", "webview", "components", "TrajectoryTimeline.tsx"), "utf8");
  assert.ok(/port: TrajectoryInteraction/.test(timeline), "时间线只收一个端口对象（不再是 13 个散 prop）");
  assert.ok(/ref=\{port\.plot\}/.test(timeline), "容器 ref 也在同一个端口里");
  assert.ok(!/onRangeCommit/.test(timeline), "旧的三通道回调（onSelect/onRange/onRangeCommit）不许回来");
}

// ---------- 12. 生命期：跨会话必须连**闭包资源**一起清（锚点 / document 监听 / 旧几何） ----------
//
// 主代理独立生命期验收（`parent/accept-ui-session-lifetime.mjs`，byte witness = 本模块
// `ce6d466f…` 那一版）红了 2/6：跨会话之后 `document` 上仍挂着 2 个监听，而且**已经排队**
// 的旧 `mousemove` / `mouseup` 还能改新会话的选区与选中。根因就是这里——
// `setSession` 只换公开状态（`publish(initialState)`），闭包里的手势锚点与监听没动：
// **重置 state ≠ 重置资源**。下面六组（S1–S6）把生命期规则钉住，同类里
// 「同一个会话 id 再赋值」必须是空操作（不许打断进行中的手势）。
{
  const listeners: Record<string, (event: { clientX: number }) => void> = {};
  const added: string[] = [];
  const removed: string[] = [];
  const original = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    addEventListener: (type: string, listener: (event: { clientX: number }) => void) => {
      added.push(type);
      listeners[type] = listener;
    },
    removeEventListener: (type: string) => {
      removed.push(type);
      delete listeners[type];
    },
  };
  try {
    // S1/S2/S3：拖动中切会话 —— 监听摘掉；**切换前捕获的**旧回调一个字都不许改新会话
    const port = createTrajectoryInteraction("sA");
    port.plot.current = fakePlot();
    port.syncSpans(SPANS);
    port.beginSlice(210); // 域 0.21 起手
    port.extendSlice(600); // 域 0.6
    assert.deepStrictEqual(
      { start: port.state.range?.start, end: port.state.range?.end },
      { start: 0.21, end: 0.6 },
      "拖动中：选区跟着走（先确认现场）",
    );
    const queuedMove = listeners.mousemove;
    port.setSession("sB");
    assert.strictEqual(port.state.sessionId, "sB", "切会话换身份");
    assert.strictEqual(port.state.range, null, "新会话的选区是空的");
    assert.strictEqual(port.state.gesture, null, "进行中的手势也被取消（公开状态里不留手势）");
    assert.deepStrictEqual(
      removed.slice(-2),
      ["mousemove", "mouseup"],
      "S1/S4：跨会话要把 document 监听摘掉（2 → 0）——只改 state 是不够的",
    );
    queuedMove?.({ clientX: 600 });
    assert.strictEqual(port.state.range, null, "S2：已排队的旧 mousemove 不许再改新会话的选区");

    // S3：轻点起手、抬手前切会话 —— 旧 mouseup 不许把**旧会话**第 3 条选中
    const click = createTrajectoryInteraction("sA");
    click.plot.current = fakePlot();
    click.syncSpans(SPANS);
    click.beginSlice(215); // 域 0.215 → 最近的是第 3 条
    const queuedClickUp = listeners.mouseup;
    click.setSession("sB");
    queuedClickUp?.({ clientX: 215 });
    assert.strictEqual(click.state.record, undefined, "S3：旧 mouseup 不许选中旧会话第 3 条");
    assert.strictEqual(click.state.reveal, null, "也不许为新会话请求滚动落点");
    assert.strictEqual(click.state.range, null, "新会话的选区仍是空的");

    // S4：平移中切会话 —— 监听摘掉；旧 mousemove 不许挪新会话视口
    const pan = createTrajectoryInteraction("sA");
    pan.plot.current = fakePlot();
    pan.zoomAtCursor(500, -600, 8);
    pan.panTo(0.3);
    pan.beginPan(500);
    const queuedPanMove = listeners.mousemove;
    pan.setSession("sB");
    assert.deepStrictEqual(removed.slice(-2), ["mousemove", "mouseup"], "S4：跨会话摘掉平移监听");
    queuedPanMove?.({ clientX: 300 });
    assert.strictEqual(pan.state.offset, 0, "S4：旧 mousemove 不许挪新会话的视口");
    assert.strictEqual(pan.state.zoom, 1, "新会话视口复位");

    // S5：同一个会话 id 再赋值 = 空操作，不许打断进行中的手势（这一条**不是**缺陷，别顺手改坏）
    const same = createTrajectoryInteraction("sA");
    same.plot.current = fakePlot();
    same.syncSpans(SPANS);
    const removedBefore = removed.length;
    same.beginSlice(210);
    same.setSession("sA");
    assert.strictEqual(removed.length, removedBefore, "S5：同会话赋值不许摘监听");
    assert.strictEqual(same.state.gesture, "slice", "S5：手势照旧进行中");
    same.extendSlice(600);
    assert.deepStrictEqual(
      { start: same.state.range?.start, end: same.state.range?.end },
      { start: 0.21, end: 0.6 },
      "S5：同会话赋值之后手势照旧跟手",
    );
    same.endSlice(600);
    assert.strictEqual(same.state.gesture, null, "S5：正常走完手势");

    // S6：正常结束之后挂/摘次数相等（净剩 0 个监听）
    assert.strictEqual(
      removed.length,
      added.length,
      `S6：每次挂上的监听都要摘掉（挂 ${added.length} / 摘 ${removed.length}）`,
    );

    // ③ 旧几何（spans）也是跨身份状态：切会话后不许拿旧会话的条算「最近 / 选区第一条」，
    //    下一次渲染同步新条之后恢复（fail-quiet 而不是用错几何）
    const geo = createTrajectoryInteraction("sA");
    geo.plot.current = fakePlot();
    geo.syncSpans(SPANS);
    geo.setSession("sB");
    geo.beginSlice(20);
    geo.extendSlice(180);
    geo.endSlice(180);
    assert.strictEqual(geo.state.reveal, null, "切会话后旧几何不再参与判定（拖过也不请求滚动）");
    geo.syncSpans(SPANS); // 与真实组件下一次 commit 的 `port.syncSpans(timeline.spans)` 同一条路
    geo.beginSlice(20);
    geo.extendSlice(180);
    geo.endSlice(180);
    assert.strictEqual(
      (geo.state.reveal as { index: number } | null)?.index,
      1,
      "同步新几何之后选区提交照常工作",
    );

    // ③ 落点票据是**单调**的，跨会话刻意不清：清了会让旧 nonce 重新可用（重复消费）
    const ticket = createTrajectoryInteraction("sA");
    ticket.ledger.current = {
      scrollTop: 0,
      querySelector: () => ({ getBoundingClientRect: () => ({ top: 5 }) }),
      getBoundingClientRect: () => ({ top: 0 }),
    } as never;
    ticket.reveal(7);
    const ticketNonce = ticket.state.reveal?.nonce ?? -1;
    assert.strictEqual(ticket.applyReveal(7, ticketNonce), true, "先消费一次落点");
    ticket.setSession("sB");
    assert.strictEqual(ticket.state.reveal, null, "切会话把落点请求清掉");
    ticket.reveal(8);
    // 上面那句 `strictEqual(…, null)` 会把属性访问窄化成 `null`，这里显式写回形状再读
    const nextNonce = (ticket.state.reveal as { nonce: number } | null)?.nonce ?? -1;
    assert.ok(nextNonce > ticketNonce, "新会话的落点拿新 nonce");
    assert.strictEqual(ticket.applyReveal(8, nextNonce), true, "新落点照常消费");
    assert.strictEqual(ticket.applyReveal(7, ticketNonce), false, "旧票据不许复活（票据不清）");
  } finally {
    if (original === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = original;
  }
}

/**
 * 真实 DOM 的账本事实（第 13、14 组共用）：账本总行数 / 行高估计值 / 实测行高 / 账本高，
 * 逐条取自主代理真实浏览器验收的量测（估计值被行高校正 effect 的 1px 死区停在 29，
 * 初值 30；真实行 26；账本高 771）。
 */
const ROW_COUNT = 2047;
const ESTIMATE = 29;
const REAL_ROW = 26;
const VIEWPORT = 771;

// ---------- 13. F06：首次落点必须完整可见（写下的 scrollTop 会让窗口重排） ----------
//
// 真实 DOM 的红：点时间线 span5，两帧之后目标行只有 13.5/26px 可见（半行被裁掉），
// 再点一次才对齐。根因不是算术，而是**几何换了窗口**：`applyReveal` 量的是旧窗口下的
// 行偏移，而它写下的 `scrollTop` 会让绘制计划按新位置重排（垫行按估计行高画、真实行
// 按内容高），重排之后目标行又偏了。
//
// 这里容器侧**不是自造一份算法**：绘制计划由生产模块 `trajectoryWindowPlan()` 算
// （组件画的就是它），垫行按估计行高、真实行按实测行高——两者之差正是真实 DOM 的事实
// （估计 29 / 实测 26），也是这条缺陷的输入。端口侧是 `createTrajectoryInteraction()`
// 的真实字节：红/修前的行为红见私有证据
// `.agent/temp/trajectory-20261009/f06-reveal-final/red-before.log`（同一序列：
// scrollTop=116 / rowTop=−12 / 可见 14/26，真实 DOM 是 117 / −12.5 / 13.5）。
{

  /**
   * 一个「按生产绘制计划重排」的账本容器：`scrollTop` 一变，垫行分布就变，目标行的
   * 位置跟着变。只认一个目标记录（记录 `cell` 在计划里的行位置是 `position`）。
   */
  function virtualLedger(cell: number, position: number) {
    let top = 0;
    const planAt = (scrollTop: number) =>
      trajectoryWindowPlan({
        rowCount: ROW_COUNT,
        hasOlder: false,
        scrollTop,
        viewportHeight: VIEWPORT,
        rowHeight: ESTIMATE,
        pinned: [position],
      });
    /** 计划里第 `position` 行的内容偏移：垫行按估计行高、真实行按实测行高。 */
    const contentOffset = (wanted: number, scrollTop: number): number => {
      let offset = 0;
      for (const item of planAt(scrollTop).items) {
        if (item.kind === "pad") {
          offset += item.rows * ESTIMATE;
          continue;
        }
        if (item.index === wanted) return offset;
        offset += REAL_ROW;
      }
      throw new Error(`绘制计划里没有第 ${wanted} 行（pinned 保证它在）`);
    };
    const contentHeight = (scrollTop: number): number =>
      planAt(scrollTop).items.reduce(
        (sum, item) => sum + (item.kind === "pad" ? item.rows * ESTIMATE : REAL_ROW),
        0,
      );
    const element = {
      get scrollTop() {
        return top;
      },
      set scrollTop(value: number) {
        // 浏览器两端都会夹（真实 DOM 里最后一条记录就是夹在底部的）
        top = Math.max(0, Math.min(contentHeight(Number.MAX_SAFE_INTEGER) - VIEWPORT, value));
      },
      querySelector(selector: string) {
        const match = /data-cell-index="(\d+)"/.exec(selector);
        if (match === null || Number(match[1]) !== cell) return null;
        return { getBoundingClientRect: () => ({ top: contentOffset(position, top) - top }) };
      },
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLDivElement;
    return {
      element,
      /** 这一帧绘制计划用的滚动位置：本模型里计划即时跟上容器，两者恒等。 */
      planTop: () => top,
      rowTop: () => contentOffset(position, top) - top,
      visiblePx: () => REAL_ROW - Math.max(0, -(contentOffset(position, top) - top)),
    };
  }

  // ① 首次动作：端口写下 scrollTop，窗口随之重排，目标行偏了（= 真实 DOM 的半行）
  const port = createTrajectoryInteraction("s1");
  const ledger = virtualLedger(5, 4); // 真实轨迹的 span5 = 第 5 行（0 基位置 4）
  port.ledger.current = ledger.element;
  ledger.element.scrollTop = 470; // 点击前用户停留的位置
  port.openRecord(5);
  const target = port.state.reveal;
  assert.ok(target !== null && target.index === 5, "点击落下落点请求");
  assert.strictEqual(port.applyReveal(target.index, target.nonce), true, "消费落点");
  assert.ok(
    ledger.rowTop() < -10,
    `写下的 scrollTop 让窗口重排，目标行随之偏掉（模型 ${ledger.rowTop()}px，真实 DOM −12.5px）`,
  );
  assert.ok(
    ledger.visiblePx() < REAL_ROW,
    `重排之后只有半行可见（${ledger.visiblePx()}/${REAL_ROW}px）——F06 首次裁半行就是这个`,
  );

  // ② 收尾：组件把写下的 scrollTop 交回 React，窗口重排之后调 settleReveal（paint 之前收敛）
  let steps = 0;
  while (steps < 8 && port.settleReveal(target.index, target.nonce, ledger.planTop())) steps += 1;
  assert.ok(steps >= 1 && steps <= 3, `收尾有界收敛（${steps} 步，上限 3）`);
  assert.ok(Math.abs(ledger.rowTop()) <= 0.5, `首次动作就把目标行完整放进可视区（rowTop=${ledger.rowTop()}）`);
  assert.strictEqual(ledger.visiblePx(), REAL_ROW, "整行 26px 可见（超高行除外）");

  // ③ 票据只用一次：对齐即作废；别的目标 / 旧 nonce 都不收尾、也不动滚动位置
  const aligned = ledger.element.scrollTop;
  assert.strictEqual(port.settleReveal(target.index, target.nonce, ledger.planTop()), false, "对齐之后票据作废");
  assert.strictEqual(port.settleReveal(6, target.nonce, ledger.planTop()), false, "别的目标不收尾");
  assert.strictEqual(port.settleReveal(target.index, target.nonce - 1, ledger.planTop()), false, "旧 nonce 不收尾");
  assert.strictEqual(ledger.element.scrollTop, aligned, "这些调用一个字都不改滚动位置");

  // ④ 同目标新动作有效：新 nonce 是一张新票据
  port.openRecord(5);
  const again = port.state.reveal;
  assert.ok(again !== null && again.nonce > target.nonce, "同一条记录再点一次是新 nonce");
  assert.strictEqual(port.applyReveal(again.index, again.nonce), true, "新落点照常消费");
  let againSteps = 0;
  while (againSteps < 8 && port.settleReveal(again.index, again.nonce, ledger.planTop())) againSteps += 1;
  assert.ok(Math.abs(ledger.rowTop()) <= 0.5, "同目标新动作仍然完整可见");

  // ⑤ 用户手滚：票据作废、一个字都不许回拉（真实 DOM：手滚 2000 之后停在原地）
  ledger.element.scrollTop = 2000;
  const userTop = ledger.element.scrollTop;
  assert.ok(userTop > 100, "确认用户确实滚走了");
  assert.strictEqual(
    port.settleReveal(again.index, again.nonce, ledger.planTop()),
    false,
    "用户手滚之后旧落点票据作废",
  );
  assert.strictEqual(ledger.element.scrollTop, userTop, "手滚的位置原地不动（没有 rAF 回拉、也不重放旧 reveal）");

  // ⑥ 切会话 / 卸载：未收尾的票据一并作废（新身份里它指的行与几何都不作数）
  const sessionPort = createTrajectoryInteraction("s1");
  const sessionLedger = virtualLedger(5, 4);
  sessionPort.ledger.current = sessionLedger.element;
  sessionLedger.element.scrollTop = 470;
  sessionPort.reveal(5);
  const sessionTicket = sessionPort.state.reveal;
  assert.ok(sessionTicket !== null, "会话里的落点请求");
  sessionPort.applyReveal(sessionTicket.index, sessionTicket.nonce);
  sessionPort.setSession("s2");
  sessionLedger.element.scrollTop = 1000;
  assert.strictEqual(
    sessionPort.settleReveal(sessionTicket.index, sessionTicket.nonce, sessionLedger.planTop()),
    false,
    "切会话作废未收尾的票据",
  );
  assert.strictEqual(sessionLedger.element.scrollTop, 1000, "切会话之后不许再动滚动位置");

  const disposePort = createTrajectoryInteraction("s1");
  const disposeLedger = virtualLedger(5, 4);
  disposePort.ledger.current = disposeLedger.element;
  disposeLedger.element.scrollTop = 470;
  disposePort.reveal(5);
  const disposeTicket = disposePort.state.reveal;
  assert.ok(disposeTicket !== null, "卸载前的落点请求");
  disposePort.applyReveal(disposeTicket.index, disposeTicket.nonce);
  disposePort.dispose();
  disposeLedger.element.scrollTop = 1000;
  assert.strictEqual(
    disposePort.settleReveal(disposeTicket.index, disposeTicket.nonce, disposeLedger.planTop()),
    false,
    "卸载作废未收尾的票据",
  );
  assert.strictEqual(disposeLedger.element.scrollTop, 1000, "卸载之后不许再动滚动位置");
}

// ---------- 14. F06 时序：计划没追上写下的位置之前，收尾不许取判定 ----------
//
// 第 13 组只走了「apply → 重排 → 收尾」这一条理想顺序；真实消费顺序里，收尾会在
// **apply 的同一次 commit** 上就被走到一次——落点 effect 先把 DOM 写成了新位置
// （真实 DOM：117）并 `setScrollTop(applied)`，而这一次 commit 的收尾 effect 闭包拿到的
// 仍是**这一次 render 的 `scrollTop`**（旧值）与按它算出来的**旧绘制计划**：目标行上方
// 还是垫行（按估计行高画），量出来「已经贴边」，可写下的位置会让窗口按真实行高重排
// （4×26），重排之后目标行又偏了。老口径把票据当成「已对齐」清掉，于是**首次落点照样
// 裁半行**（真实 DOM：rowTop 110.5 / 只 13.5 可见），要再点一次才对齐。
//
// 区分点就是这个组要钉的东西：**渲染用的 `scrollTop` / 已提交的绘制计划**是一侧，
// **DOM 实际被写成的滚动位置**是另一侧；两者在重排前必然不同（计划还没按新位置重算）。
// 收尾的判定必须带上前者（`settleReveal(index, nonce, planScrollTop)`）：计划没追上
// 容器实际停的位置时，一个字都不改、票据也留着，判定留给计划追上来之后那一次。
// 下面跑的是与组件同一个 `createTrajectoryInteraction()`（同一个缝），红/绿由端口字节决定
// ——同一份测试文本，`before/` 那三行字节在 ⑤ 判红（rowTop=−12），修后判绿。
{
  /**
   * 把「这一帧绘制计划用的滚动位置」与「容器实际停的位置」**分开**的账本：真实组件里
   * 前者来自 React 的渲染 state、后者来自浏览器，重排之前必然对不上。`commit()` 是一次
   * React 提交（用新的 `planTop` 重新画出窗口计划），几何与第 13 组同一套生产算术。
   */
  function planLedger(cell: number, position: number) {
    let dom = 0;
    let plan = 0;
    const planAt = (scrollTop: number) =>
      trajectoryWindowPlan({
        rowCount: ROW_COUNT,
        hasOlder: false,
        scrollTop,
        viewportHeight: VIEWPORT,
        rowHeight: ESTIMATE,
        pinned: [position],
      });
    const contentOffset = (planTop: number): number => {
      let offset = 0;
      for (const item of planAt(planTop).items) {
        if (item.kind === "pad") {
          offset += item.rows * ESTIMATE;
          continue;
        }
        if (item.index === position) return offset;
        offset += REAL_ROW;
      }
      throw new Error(`绘制计划里没有第 ${position} 行（pinned 保证它在）`);
    };
    const contentHeight = (): number =>
      planAt(Number.MAX_SAFE_INTEGER).items.reduce(
        (sum, item) => sum + (item.kind === "pad" ? item.rows * ESTIMATE : REAL_ROW),
        0,
      );
    const maxTop = (): number => Math.max(0, contentHeight() - VIEWPORT);
    const element = {
      get scrollTop() {
        return dom;
      },
      set scrollTop(value: number) {
        dom = Math.max(0, Math.min(maxTop(), value));
      },
      querySelector(selector: string) {
        const match = /data-cell-index="(\d+)"/.exec(selector);
        if (match === null || Number(match[1]) !== cell) return null;
        // 行的位置按**这一帧计划**算，视口位置按容器实际停的地方算
        return { getBoundingClientRect: () => ({ top: contentOffset(plan) - dom }) };
      },
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLDivElement;
    return {
      element,
      /** 一次 React 提交：绘制计划按 `planTop` 重新算（窗口可能因此换一批行）。 */
      commit: (planTop: number) => {
        plan = planTop;
      },
      planTop: () => plan,
      maxTop,
      rowTop: () => contentOffset(plan) - dom,
      visiblePx: () => REAL_ROW - Math.max(0, -(contentOffset(plan) - dom)),
    };
  }

  // ① 前置现场：上一次尾部落点把账本停在底部，插入的计划也按那个位置算
  const BOTTOM = 20000;
  const port = createTrajectoryInteraction("s1");
  const ledger = planLedger(5, 4); // 真实轨迹的 span5 = 第 5 行（0 基位置 4）
  port.ledger.current = ledger.element;
  ledger.commit(BOTTOM);
  ledger.element.scrollTop = BOTTOM;

  // ② 点 span5：落点下来，applyReveal 在**旧计划**里量出目标行的位置并写下去
  port.openRecord(5);
  const target = port.state.reveal;
  assert.ok(target !== null && target.index === 5, "点击落下落点请求");
  assert.strictEqual(port.applyReveal(target.index, target.nonce), true, "消费落点（量的是旧计划的垫行几何）");
  const written = ledger.element.scrollTop;
  assert.ok(written > 100 && written < BOTTOM, `写下的是旧计划里目标行的位置（${written}）`);
  assert.ok(
    Math.abs(ledger.rowTop()) <= 0.5,
    "旧计划里它看起来正好贴边——老口径的「已对齐」就是这个假象",
  );

  // ③ 同一次 commit 里收尾也被走到（落点 effect 已经 setScrollTop(applied)，但这次渲染的
  //    `scrollTop` 还是旧值、计划也还没按新位置重算）→ 不作判定、不改位置、票据留着
  const beforeSettle = ledger.element.scrollTop;
  assert.strictEqual(
    port.settleReveal(target.index, target.nonce, ledger.planTop()),
    false,
    "计划没追上来时不作判定（重排前量到的「贴边」属于马上要被换掉的布局）",
  );
  assert.strictEqual(ledger.element.scrollTop, beforeSettle, "这一刻一个字都不改滚动位置");

  // ④ 下一帧：React 用写下的位置提交了新的计划（垫行换成真实行），目标行随之偏掉
  ledger.commit(written);
  assert.ok(ledger.rowTop() < -10, `重排之后目标行偏了（${ledger.rowTop()}px，真实 DOM −12.5px）`);

  // ⑤ 计划追上之后，同一张票据把目标行放全，然后退休
  let steps = 0;
  while (steps < 8 && port.settleReveal(target.index, target.nonce, ledger.planTop())) {
    steps += 1;
    // 组件把收尾改出来的位置再交回 React：下一次提交的计划用的就是新的滚动位置
    ledger.commit(ledger.element.scrollTop);
  }
  assert.ok(Math.abs(ledger.rowTop()) <= 0.5, `首次落点整行可见（rowTop=${ledger.rowTop()}，老口径在这里是 −12）`);
  assert.strictEqual(ledger.visiblePx(), REAL_ROW, "整行 26px 可见——不需要第二次点击");
  assert.ok(steps >= 1 && steps <= 3, `计划追上来之后有界收敛（${steps} 步，上限 3）`);
  assert.strictEqual(
    port.settleReveal(target.index, target.nonce, ledger.planTop()),
    false,
    "对齐之后票据退休",
  );

  // ⑥ 尾部夹取：修正被浏览器夹住（最后几条贴不了顶）时票据当场收掉，不再赖着
  const tailPort = createTrajectoryInteraction("s1");
  const tailLedger = planLedger(2046, 2045); // 最后一条记录，贴不了顶
  tailPort.ledger.current = tailLedger.element;
  tailPort.reveal(2046);
  const tail = tailPort.state.reveal;
  assert.ok(tail !== null, "尾部落点请求");
  assert.strictEqual(tailPort.applyReveal(tail.index, tail.nonce), true, "尾部落点照常消费");
  tailLedger.commit(tailLedger.element.scrollTop);
  let tailSteps = 0;
  while (tailSteps < 6 && tailPort.settleReveal(tail.index, tail.nonce, tailLedger.planTop())) {
    tailSteps += 1;
    tailLedger.commit(tailLedger.element.scrollTop);
  }
  assert.ok(tailSteps <= 3, `尾部收尾照样有界（${tailSteps} 步，上限 3）`);
  assert.ok(tailLedger.rowTop() > 0, "最后几条贴不了顶（浏览器夹住）——这是物理边界，不是回归");
  const parkedAtTail = tailLedger.element.scrollTop;
  // 之后别的原因让计划变了（上面的内容变矮），退休的票据不许再动滚动位置
  tailLedger.commit(parkedAtTail - 300);
  assert.strictEqual(
    tailPort.settleReveal(tail.index, tail.nonce, tailLedger.planTop()),
    false,
    "退休之后无关的计划变化不会被它拿去补一次",
  );
  assert.strictEqual(tailLedger.element.scrollTop, parkedAtTail, "位置原地不动");
}

console.log("trajectoryInteraction: 选择互斥、落点一次消费、用户手势优先、切会话重置 ✓");
console.log("trajectoryInteraction: 跨会话生命期（监听 / 排队回调 / 旧几何 / 票据）✓");
console.log("trajectoryInteraction: 首次落点完整可见（窗口重排之后补实测余量）✓");
console.log("trajectoryInteraction: F06 时序（计划追上之前不取判定 / 夹取即退休）✓");
console.log("\ntrajectoryInteraction: all assertions passed");
