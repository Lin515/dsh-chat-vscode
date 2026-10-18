/**
 * 消息通知的**界面侧**回归：宿主镜像怎么进状态、抽屉面板怎么开关、以及界面上报的
 * 「本地复制图片失败」那条帧。
 *
 * 契约见 `docs/design-notifications.md`，队列本体在 `src/dsh/notificationQueue.ts`
 * （宿主那一半由 `scripts/notificationQueue.test.ts` 覆盖）。这里钉的是界面自己那一半：
 *
 *  1. **收到的镜像整体覆盖**：`state` 快照与 `patch` 都是整份列表（不是按 id 合并），
 *     空列表清空、`null`（过线的清空）也清掉——界面不做任何本地增删；
 *  2. **面板开关不碰通知**：打开 / 关闭抽屉不确认、不改次数；`ui/openPanel` 只认登记过的
 *     抽屉名，未知值忽略（不做 `as PanelKind` 强转）；
 *  3. **可见范围与顺序**：过滤别的会话、共享恒可见、**整体保持最近发生顺序**（不把
 *     未确认挪到前面）、顶部取最近一条未确认（并列取宿主序靠前那条）；
 *  4. **上报帧只有固定字段**：`{type, sessionId?, requestId}`，没有 level / text / path
 *     这类任意通道；发起会话变了就丢弃；并发复制按**完成（post）顺序**递增报告序号。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import type { NotificationView } from "../src/shared/chat";
import type { AppState } from "../src/webview/state";

// `imageCopyFailure` 连带 `bridge.ts` 在模块求值期就要 `window`：无头环境先补最小桩，
// 再动态 import（理由与 `contextMenu.test.ts` 同一处注释）。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
/** 真正落到宿主的那一帧（断言 IPC 字段用）。 */
const frames: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => {
    frames.push(message);
  },
  setState: () => {},
});

const { PANEL_KINDS, initialState, isPanelKind, reducer } = await import("../src/webview/state");
const { formatNotificationTime, notificationList, topNotification, visibleNotifications } =
  await import("../src/webview/notifications");
const { imageCopyFailureSession, reportImageCopyFailure, setImageCopyFailureScope } =
  await import("../src/webview/imageCopyFailure");
const { isConversationForeground } = await import("../src/webview/escapeOwner");

/** 一条镜像通知（缺省：本会话、黄色、未确认、发生 1 次）。 */
function notice(overrides: Partial<NotificationView> & { id: string }): NotificationView {
  return {
    sessionId: "s1",
    level: "warn",
    text: "@imageCopyFailed",
    count: 1,
    firstAt: 1_000,
    lastAt: 1_000,
    acknowledged: false,
    ...overrides,
  };
}

/**
 * 一帧宿主消息。
 *
 * 宿主发的是**整份** ChatState / patch，测试里只关心通知那一格，所以这里按部分对象拼帧
 * （`as never` 与 `composerDraft.test.ts` 同一处口径：帧形状由类型层保证，夹具不求全）。
 */
function hostFrame(frame: object): never {
  return frame as never;
}

// ---------- 1. 收到的镜像：整体覆盖、空列表清空、null 清空 ----------

{
  const first = notice({ id: "n1", level: "error", text: "@queueDispatchFailed" });
  const second = notice({ id: "n2", sessionId: undefined, text: "@imageCopyFailed", count: 3 });

  let state: AppState = reducer(
    initialState,
    hostFrame({ type: "state", state: { notifications: [first, second] } }),
  );
  assert.deepStrictEqual(
    state.notifications?.map((item) => item.id),
    ["n1", "n2"],
    "快照里的通知列表要原样进状态",
  );

  // patch 的列表是**整份镜像**：旧的那条不在里面就该消失，而不是按 id 合并
  const replacement = notice({ id: "n3", text: "@unknownEvent:kernel/x" });
  state = reducer(state, hostFrame({ type: "patch", patch: { notifications: [replacement] } }));
  assert.deepStrictEqual(
    state.notifications?.map((item) => item.id),
    ["n3"],
    "patch 是整份镜像（不是按 id 合并到旧列表）",
  );

  state = reducer(state, hostFrame({ type: "patch", patch: { notifications: [] } }));
  assert.deepStrictEqual(state.notifications, [], "空列表 = 队列清空");

  state = reducer(state, hostFrame({ type: "patch", patch: { notifications: null } }));
  assert.strictEqual(state.notifications, undefined, "null（过线的清空）也把这条删掉");
}
console.log("notificationsView: 镜像整体覆盖 / 空列表与 null 清空 ✓");

// ---------- 2. 面板开关不确认、未知 panel 忽略 ----------

{
  const unacknowledged = notice({ id: "n1" });
  const acknowledged = notice({ id: "n2", acknowledged: true, lastAt: 500 });
  let state: AppState = reducer(
    initialState,
    hostFrame({ type: "state", state: { notifications: [unacknowledged, acknowledged] } }),
  );
  const before = state.notifications;

  state = reducer(state, { type: "ui/openPanel", panel: "notifications" });
  assert.strictEqual(state.panel, "notifications", "命令入口打开的正是通知抽屉");
  assert.strictEqual(state.notifications, before, "打开抽屉不碰通知（不改确认、不改次数）");

  state = reducer(state, { type: "ui/setPanel", panel: "none" });
  assert.strictEqual(state.panel, "none");
  assert.strictEqual(
    state.notifications?.[0]?.acknowledged,
    false,
    "关闭抽屉**不**确认任何一条（确认只走 acknowledgeNotification）",
  );

  // 未知抽屉名：忽略（界面不猜、不存），已有的面板也不被顶掉
  const opened = reducer(state, { type: "ui/openPanel", panel: "notifications" });
  const unknown = reducer(opened, { type: "ui/openPanel", panel: "nope" });
  assert.strictEqual(unknown.panel, "notifications", "未知 panel 忽略，不靠强转落进状态");

  assert.deepStrictEqual([...PANEL_KINDS], ["none", "history", "jobs", "trajectory", "notifications"]);
  assert.ok(isPanelKind("notifications"), "notifications 是登记过的抽屉");
  assert.ok(!isPanelKind("nope"), "没登记的名字不是抽屉");

  // 通知抽屉占据前景 → 「无人认领的 ESC = 停止生成」这条兜底不存在（只收起抽屉）
  assert.strictEqual(isConversationForeground("notifications"), false);
  assert.strictEqual(isConversationForeground("none"), true);
}
console.log("notificationsView: 抽屉开关不确认 / 未知 panel 忽略 / 非前景不兜底停止 ✓");

// ---------- 3. 可见范围、整体顺序与顶部取值 ----------

{
  // 宿主的镜像顺序：**最近发生在前**（已确认的也在这一条序里，不单独排后面）
  const otherSession = notice({ id: "x1", sessionId: "s2", level: "error", lastAt: 9_000 });
  const mineAcked = notice({ id: "n3", lastAt: 500, acknowledged: true });
  const sharedNewest = notice({ id: "n2", sessionId: undefined, lastAt: 500 });
  const mineOld = notice({ id: "n1", lastAt: 100 });
  const list = [otherSession, mineAcked, sharedNewest, mineOld];

  assert.deepStrictEqual(
    visibleNotifications(list, "s1").map((item) => item.id),
    ["n3", "n2", "n1"],
    "别的会话的通知不进本视图；共享通知恒可见",
  );
  assert.deepStrictEqual(
    visibleNotifications(list, undefined).map((item) => item.id),
    ["n2"],
    "没有绑定会话时只有共享通知",
  );
  assert.deepStrictEqual(
    notificationList(list, "s1").map((item) => item.id),
    ["n3", "n2", "n1"],
    "抽屉保持**整体**最近发生顺序：已确认的 n3 仍在旧的未确认 n1 之前（不按确认状态分组重排）",
  );
  // 防御性：镜像顺序不是最近序时界面也**原样透传**（不猜、不自己排一次），
  // 只有「顶部取哪一条」按 lastAt 判——于是顺序这一件事只有宿主一个出处。
  assert.deepStrictEqual(
    notificationList([mineOld, sharedNewest, mineAcked], "s1").map((item) => item.id),
    ["n1", "n2", "n3"],
    "顺序原样透传（不重排）",
  );

  // 顶部：最近一条**未确认**；已确认的那条不参与
  assert.strictEqual(topNotification(list, "s1")?.id, "n2", "顶部取最近发生的未确认（n3 已确认）");
  assert.strictEqual(topNotification(list, undefined)?.id, "n2");
  assert.strictEqual(topNotification([mineOld, sharedNewest, mineAcked], "s1")?.id, "n2", "乱序输入也不改顶部判据");
  assert.strictEqual(
    topNotification(list.filter((item) => item.id !== "n2"), "s1")?.id,
    "n1",
    "只剩一条可见未确认时就是它",
  );
  assert.strictEqual(
    topNotification([notice({ id: "a1", acknowledged: true })], "s1"),
    undefined,
    "全部确认后顶部什么都不画（不占空间）",
  );
  assert.strictEqual(topNotification([], "s1"), undefined);
  assert.strictEqual(topNotification(undefined, "s1"), undefined);

  // 并列（同一毫秒）：取宿主序里靠前的那条（镜像顺序本身就是权威的最近口径）
  const tieOne = notice({ id: "t1", lastAt: 700 });
  const tieTwo = notice({ id: "t2", lastAt: 700 });
  assert.strictEqual(topNotification([tieOne, tieTwo], "s1")?.id, "t1", "并列取靠前那条");
  assert.strictEqual(topNotification([tieTwo, tieOne], "s1")?.id, "t2", "换顺序就换结论");
}
console.log("notificationsView: 可见范围 / 整体顺序 / 顶部未确认与并列 ✓");

// ---------- 4. 上报帧：只有固定字段，归属不符就丢弃 ----------

{
  frames.length = 0;
  setImageCopyFailureScope("s1");
  assert.strictEqual(imageCopyFailureSession(), "s1", "手势那一刻读到的是此刻绑定的会话");

  reportImageCopyFailure("s1");
  assert.deepStrictEqual(
    frames[0],
    { type: "reportImageCopyFailure", sessionId: "s1", requestId: 1 },
    "失败帧的形状固定",
  );
  assert.deepStrictEqual(
    Object.keys(frames[0] as object).sort(),
    ["requestId", "sessionId", "type"],
    "帧里没有 level / text / path 这类任意通道",
  );

  // 手势发起时是 s1、现在已切到 s2：迟到的失败**丢弃**，不误报进新会话
  setImageCopyFailureScope("s2");
  reportImageCopyFailure("s1");
  assert.strictEqual(frames.length, 1, "归属不符的失败不上报");

  // 没有绑定会话时：帧里不带 sessionId 键（过线后宿主拿到的是 undefined）
  setImageCopyFailureScope(undefined);
  reportImageCopyFailure(undefined);
  assert.deepStrictEqual(
    frames[1],
    { type: "reportImageCopyFailure", requestId: 2 },
    "空态窗口的失败不带 sessionId 键",
  );
  assert.strictEqual(frames.length, 2);
}
console.log("notificationsView: 失败帧固定字段 / 跨会话丢弃 ✓");

// ---------- 5. 并发复制：报告序号按**完成**顺序递增 ----------

{
  frames.length = 0;
  setImageCopyFailureScope("s1");
  /** 每次完成后记下它拿到的号（识别「手势先发、失败后到」的那一次）。 */
  const assigned: Record<string, number> = {};
  const copies = [
    { name: "slow", delay: 30 },
    { name: "fast", delay: 5 },
  ];
  await Promise.all(
    copies.map(
      (copy) =>
        new Promise<void>((resolve) => {
          // 两次复制**并发**发起（手势先后与完成先后相反）：号必须在失败落定的那一刻铸造，
          // 否则宿主的每窗口单调水位会按手势顺序把后完成的真实失败整条丢掉。
          setTimeout(() => {
            reportImageCopyFailure("s1");
            assigned[copy.name] = (frames[frames.length - 1] as { requestId: number }).requestId;
            resolve();
          }, copy.delay);
        }),
    ),
  );

  // 号是**进程内单调**的（上一节已经用掉两个），所以这里断言相对关系：完成得晚的号更大，
  // 且宿主看到的上报顺序就是完成顺序。
  assert.ok(assigned.fast < assigned.slow, "先完成的拿小号");
  assert.strictEqual(assigned.slow, assigned.fast + 1, "两次真实失败各占一个号");
  assert.deepStrictEqual(
    frames.map((frame) => (frame as { requestId: number }).requestId),
    [assigned.fast, assigned.slow],
    "宿主看到的是按完成顺序严格递增的报告序号（重复投递同一号才是空操作）",
  );
}
console.log("notificationsView: 并发失败按完成顺序取报告序号 ✓");

// ---------- 6. 抽屉时间：含日期的本地化时间 ----------

{
  const at = Date.UTC(2026, 0, 2, 3, 4);
  const zh = formatNotificationTime(at, "zh-cn");
  assert.ok(zh.includes("2026"), `历史时间要含日期（跨天历史才分得清）：${zh}`);
  assert.notStrictEqual(formatNotificationTime(at, "en"), "");
  assert.strictEqual(formatNotificationTime(Number.NaN, "en"), "", "坏时间不给读数");
  assert.notStrictEqual(
    formatNotificationTime(at, "not a locale!!"),
    "",
    "坏语言标识回退运行时默认，不因为一个坏串丢掉时间",
  );
}
console.log("notificationsView: 抽屉时间含日期且坏输入不崩 ✓");
