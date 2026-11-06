/**
 * `dsh/submissionReceipts.ts` 的纯函数回归：**收件箱回执**（判定「服务端收下了、
 * 但那一轮没能把它落盘」）。
 *
 * 这里只钉数学本身（位次平移、水位只许前进、取消与领取的分野、边界成帧）；
 * 「控制器据此把回显标成失败 / 撤回收显」的行为级验收在 `scripts/pendingEcho.test.ts`。
 *
 * 口径逐条对应官方客户端 Session 的 `settlement.receipt`
 * （`@deepseek-ai/dsh-client`）：入队记位次、领取置 `null`、取消当场丢、
 * 边界帧（`turn/end` / `request/context`）上仍是 `null` 且水位更旧 ⇒ 这条提交失败。
 */
import assert from "node:assert";

import { SessionAdapter } from "../src/dsh/adapter";
import type { SessionFollowFrame } from "../src/dsh/protocol";
import {
  inboxSpliceOf,
  noteInboxInserted,
  noteInboxProjection,
  noteInboxSplice,
  rpcIdOfMessage,
  takeLostSubmissions,
  takeObservedSubmissions,
  type SubmissionReceipts,
} from "../src/dsh/submissionReceipts";

console.log("submissionReceipts: 收件箱回执（服务端受理但没落盘的判定）");

/** 一条带提交身份的人发消息（`agent/inbox/spliced` 的 `inserted` 元素形状）。 */
function userMessage(rpcId: string, text = "x") {
  return { id: `m-${rpcId}`, source: { kind: "user-rpc", rpcId }, content: [{ type: "text", text }] };
}

/** 一帧 splice → 走一遍两条推进（顺序与适配器一致：先平移、后记入队）。 */
function frame(
  receipts: SubmissionReceipts,
  seq: number,
  data: Record<string, unknown>,
): { canceled: string[]; splice: ReturnType<typeof inboxSpliceOf> } {
  const splice = inboxSpliceOf(data);
  assert.ok(splice, `这一帧必须解析得出来：${JSON.stringify(data)}`);
  const canceled = noteInboxSplice(receipts, splice, seq);
  noteInboxInserted(receipts, splice, seq);
  return { canceled, splice };
}

// ---------- 一、形状：认人发消息的两种 source，别的都不认 ----------
{
  assert.strictEqual(rpcIdOfMessage(userMessage("r1")), "r1", "user-rpc 带 rpcId");
  assert.strictEqual(
    rpcIdOfMessage({ source: { kind: "user", rpcId: "r2" } }),
    "r2",
    "旧版 / 其它客户端的 user 也算",
  );
  assert.strictEqual(rpcIdOfMessage({ source: { kind: "user-rpc" } }), undefined, "没有 rpcId 不算");
  assert.strictEqual(rpcIdOfMessage({ source: { kind: "runtime-context", rpcId: "r3" } }), undefined, "注入类不算");
  assert.strictEqual(rpcIdOfMessage(null), undefined);
  assert.strictEqual(inboxSpliceOf({ target: "next-step", start: "0" }), undefined, "start 不是数就不猜");
  assert.strictEqual(inboxSpliceOf({ target: "elsewhere", start: 0 }), undefined, "不认识的 target 不猜");

  // 形状不可用的 inserted 元素**占位**：位次就是语义，后面的项不能整体前移
  const shifted: SubmissionReceipts = new Map();
  frame(shifted, 1, { target: "next-turn", start: 0, inserted: [null, userMessage("r4")] });
  assert.deepStrictEqual(shifted.get("r4"), { target: "next-turn", seq: 1, index: 1 }, "坏元素占位、位次照数");
  console.log("  形状与占位 ✓");
}

// ---------- 二、位次平移：前面的项被领走，后面的位次跟着前移 ----------
{
  const receipts: SubmissionReceipts = new Map();
  frame(receipts, 1, { target: "next-turn", start: 0, inserted: [userMessage("a"), userMessage("b")] });
  assert.deepStrictEqual(receipts.get("b"), { target: "next-turn", seq: 1, index: 1 }, "入队记位次");

  const { canceled } = frame(receipts, 2, { target: "next-turn", start: 0, removedCount: 1 });
  assert.deepStrictEqual(canceled, [], "领取不是取消");
  assert.deepStrictEqual(receipts.get("a"), { target: "next-turn", seq: 2, index: null }, "被领走 ⇒ 位次置空");
  assert.deepStrictEqual(receipts.get("b"), { target: "next-turn", seq: 2, index: 0 }, "后面的项前移");

  // 边界帧上：被领走的 a 定性为「永远到不了 durable」，还在队里的 b 什么都不许说
  assert.deepStrictEqual(takeLostSubmissions(receipts, 3), ["a"], "被领走的那条在边界上定性");
  assert.deepStrictEqual(receipts.get("b"), { target: "next-turn", seq: 2, index: 0 }, "还在收件箱里的不许判失败");
  assert.deepStrictEqual(takeLostSubmissions(receipts, 4), [], "b 仍在队里，再过一个边界也不许下结论");
  console.log("  位次平移与「仍在队里」✓");
}

// ---------- 三、领取 + 边界帧 ⇒ 永远到不了 durable ----------
{
  const receipts: SubmissionReceipts = new Map();
  frame(receipts, 1, { target: "next-turn", start: 0, inserted: [userMessage("lost")] });
  frame(receipts, 2, { target: "next-turn", start: 0, removedCount: 1 });
  assert.deepStrictEqual(takeLostSubmissions(receipts, 3), ["lost"], "领走之后越过边界 ⇒ 判定失败");
  assert.deepStrictEqual(takeLostSubmissions(receipts, 4), [], "结论只下一次（回执已删）");
  console.log("  领取 + 边界 ⇒ 判定 ✓");
}

// ---------- 四、水位只许前进：重连重放同一批事件不许翻案 ----------
{
  const receipts: SubmissionReceipts = new Map();
  frame(receipts, 5, { target: "next-turn", start: 0, inserted: [userMessage("r")] });
  frame(receipts, 6, { target: "next-turn", start: 0, removedCount: 1 });
  assert.deepStrictEqual(receipts.get("r"), { target: "next-turn", seq: 6, index: null });

  // 重放：更旧的两帧原样再来一遍
  frame(receipts, 5, { target: "next-turn", start: 0, inserted: [userMessage("r")] });
  assert.deepStrictEqual(receipts.get("r"), { target: "next-turn", seq: 6, index: null }, "旧帧不能把它顶回队里");
  frame(receipts, 6, { target: "next-turn", start: 0, removedCount: 1 });
  assert.deepStrictEqual(receipts.get("r"), { target: "next-turn", seq: 6, index: null }, "同一帧再来一次也是空操作");

  // 水位更旧的边界帧同样不许下结论
  assert.deepStrictEqual(takeLostSubmissions(receipts, 6), [], "同一水位不算「更旧」");
  assert.deepStrictEqual(takeLostSubmissions(receipts, 7), ["r"], "更新的一步才定性");
  console.log("  水位单调与重放幂等 ✓");
}

// ---------- 五、取消：当场交出去，不进边界判定 ----------
{
  const receipts: SubmissionReceipts = new Map();
  frame(receipts, 1, { target: "next-turn", start: 0, inserted: [userMessage("c")] });
  const { canceled } = frame(receipts, 2, {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    outcome: "canceled",
  });
  assert.deepStrictEqual(canceled, ["c"], "取消的当场交出去（按「用户丢掉了它」收场）");
  assert.strictEqual(receipts.has("c"), false, "取消的回执一并删掉");
  assert.deepStrictEqual(takeLostSubmissions(receipts, 3), [], "取消不是「领走没落盘」，不再判一次");
  console.log("  取消与领取的分野 ✓");
}

// ---------- 六、两条队列互不串位：next-step 的领取不动 next-turn 的位次 ----------
{
  const receipts: SubmissionReceipts = new Map();
  frame(receipts, 1, { target: "next-turn", start: 0, inserted: [userMessage("t")] });
  frame(receipts, 2, { target: "next-step", start: 0, inserted: [userMessage("s")] });
  frame(receipts, 3, { target: "next-step", start: 0, removedCount: 1 });
  assert.deepStrictEqual(receipts.get("t"), { target: "next-turn", seq: 1, index: 0 }, "另一条队列的项不动");
  assert.deepStrictEqual(receipts.get("s"), { target: "next-step", seq: 3, index: null });
  assert.deepStrictEqual(takeLostSubmissions(receipts, 4), ["s"], "只判被领走的那条");
  console.log("  两条队列互不干扰 ✓");
}

// ---------- 七、同帧既删又插：插入项落在 start 上，被删项置空 ----------
{
  const receipts: SubmissionReceipts = new Map();
  frame(receipts, 1, { target: "next-turn", start: 0, inserted: [userMessage("old"), userMessage("keep")] });
  frame(receipts, 2, {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [userMessage("new")],
  });
  assert.deepStrictEqual(receipts.get("old"), { target: "next-turn", seq: 2, index: null }, "被换掉的那条置空");
  assert.deepStrictEqual(receipts.get("new"), { target: "next-turn", seq: 2, index: 0 }, "新插入的落在 start");
  assert.deepStrictEqual(receipts.get("keep"), { target: "next-turn", seq: 2, index: 1 }, "后面的项按净增量平移");
  console.log("  同帧既删又插 ✓");
}

// ---------- 八、inbox 投影兜底：只按存在补位，水位只许前进 ----------
//
// 入队 splice 完全可能落在那条连接的掉线窗口里。官方 `observeSubmissionInbox` 用
// `inbox` 投影补这一层；这里钉住同一口径：有水位才写、缺位不推断、旧帧不倒退。
{
  const receipts: SubmissionReceipts = new Map();
  assert.deepStrictEqual(
    noteInboxProjection(receipts, { "next-turn": [userMessage("no-watermark")] }, undefined),
    [],
    "没有水位（cached 值 / 无水位通道）时整帧跳过",
  );
  assert.strictEqual(receipts.size, 0, "无水位不造回执");

  const touched = noteInboxProjection(
    receipts,
    { "next-turn": [null, userMessage("a")], "next-step": [userMessage("s")] },
    7,
  );
  assert.deepStrictEqual([...touched].sort(), ["a", "s"], "两条队列里带身份的提交都补到");
  assert.deepStrictEqual(
    receipts.get("a"),
    { target: "next-turn", seq: 7, index: 1 },
    "坏元素占一个位次（位次就是语义）",
  );
  assert.deepStrictEqual(receipts.get("s"), { target: "next-step", seq: 7, index: 0 });

  // 缺位 ≠ 领取 / 取消：投影里没有它时什么都不许推
  noteInboxProjection(receipts, { "next-turn": [], "next-step": [] }, 8);
  assert.deepStrictEqual(
    receipts.get("a"),
    { target: "next-turn", seq: 7, index: 1 },
    "投影里缺位时保留原位次（不反推领取 / 取消）",
  );
  assert.deepStrictEqual(takeLostSubmissions(receipts, 9), [], "位次非空 ⇒ 仍算在队里，不许判失败");

  // 同水位重发按当前位次覆盖；更旧的水位不许倒退
  noteInboxProjection(receipts, { "next-turn": [userMessage("x"), userMessage("y"), userMessage("a")] }, 7);
  assert.deepStrictEqual(
    receipts.get("a"),
    { target: "next-turn", seq: 7, index: 2 },
    "同一水位的重发按投影当前位次覆盖",
  );
  noteInboxProjection(receipts, { "next-turn": [userMessage("a")] }, 6);
  assert.deepStrictEqual(
    receipts.get("a"),
    { target: "next-turn", seq: 7, index: 2 },
    "更旧的水位（重连重放）不能把位次顶回去",
  );

  noteInboxProjection(receipts, { "next-turn": [userMessage("skipped")] }, 8, new Set(["skipped"]));
  assert.strictEqual(receipts.has("skipped"), false, "调用方点名的 rpcId 不补（刚判过 Host 已持有 / 已承认）");
  console.log("  inbox 投影补位、缺位不推断与水位单调 ✓");
}

// ---------- 九、掉线的入队 splice：投影补回执后，领取 + 边界仍能收场 ----------
{
  const receipts: SubmissionReceipts = new Map();
  // 只有投影，没收到入队 splice
  noteInboxProjection(receipts, { "next-turn": [userMessage("missed")], "next-step": [] }, 10);
  frame(receipts, 11, { target: "next-turn", start: 0, removedCount: 1 });
  assert.deepStrictEqual(
    takeLostSubmissions(receipts, 12),
    ["missed"],
    "投影补出的回执同样能被领取帧 + 轮次边界定性",
  );
  console.log("  漏收入队 splice 的兜底收场 ✓");
}

// ---------- 十、开窗截点：截点之前已有的回执是 Host 已持有，不是 lost ----------
{
  const receipts: SubmissionReceipts = new Map([
    ["old", { target: "next-turn", seq: 5, index: 0 }],
    ["claimed", { target: "next-step", seq: 9, index: null }],
    ["newer", { target: "next-turn", seq: 11, index: 0 }],
  ]);
  assert.deepStrictEqual(takeObservedSubmissions(receipts, undefined), [], "没有截点就不判断");
  assert.deepStrictEqual(
    takeObservedSubmissions(receipts, 10),
    ["old", "claimed"],
    "截点之前已有的回执（含已被领取、位次 null 的）都按 Host 已持有摘掉",
  );
  assert.deepStrictEqual(receipts.get("newer"), { target: "next-turn", seq: 11, index: 0 }, "比截点新的回执不动");
  assert.deepStrictEqual(takeObservedSubmissions(receipts, 10), [], "同一截点重复调用幂等");

  // 重连场景：快照窗口里恰好带着那一轮的 turn/end，也不许把 Host 已持有的那条改判成 lost
  const reconnect: SubmissionReceipts = new Map();
  noteInboxProjection(reconnect, { "next-turn": [userMessage("held")], "next-step": [] }, 5);
  frame(reconnect, 6, { target: "next-turn", start: 0, removedCount: 1 });
  takeObservedSubmissions(reconnect, 10);
  assert.deepStrictEqual(
    takeLostSubmissions(reconnect, 11),
    [],
    "官方 replaceWindow 714–724：receipt <= cut 是 Host 已持有，不是「快照清空即 lost」",
  );
  console.log("  开窗截点按 Host 已持有收显、不改判失败 ✓");
}

// ---------- 十一、admitted 回执、身份边界与水位等待 ----------
{
  // admitted：durable 已承认，只等 inbox 投影确认领取；不再参与失败 / 取消判定
  const receipts: SubmissionReceipts = new Map([
    ["a", { target: "next-turn", seq: 5, index: null, admitted: true }],
  ]);
  assert.deepStrictEqual(takeLostSubmissions(receipts, 6), [], "已承认的回执不参与失败判定");
  const canceled = noteInboxSplice(
    receipts,
    inboxSpliceOf({ target: "next-turn", start: 0, removedCount: 1, outcome: "canceled" })!,
    6,
  );
  assert.deepStrictEqual(canceled, [], "已承认的回执不被后来的取消帧改成失败");
  assert.deepStrictEqual(receipts.get("a"), { target: "next-turn", seq: 5, index: null, admitted: true });

  // 投影 / 入队重放只推进位次与水位，admitted 标记保留
  noteInboxProjection(receipts, { "next-turn": [userMessage("a")] }, 7);
  assert.deepStrictEqual(
    receipts.get("a"),
    { target: "next-turn", seq: 7, index: 0, admitted: true },
    "投影推进位次时保留 admitted",
  );
  const inserted: SubmissionReceipts = new Map([
    ["b", { target: "next-step", seq: 5, index: null, admitted: true }],
  ]);
  noteInboxInserted(
    inserted,
    inboxSpliceOf({ target: "next-step", start: 0, inserted: [userMessage("b")] })!,
    7,
  );
  assert.deepStrictEqual(
    inserted.get("b"),
    { target: "next-step", seq: 7, index: 0, admitted: true },
    "重放入队帧同样保留 admitted",
  );

  // 身份边界：别的窗口 / 客户端的 rpcId 不进入本地账本
  const mine: SubmissionReceipts = new Map();
  noteInboxInserted(
    mine,
    inboxSpliceOf({
      target: "next-turn",
      start: 0,
      inserted: [userMessage("foreign"), userMessage("local")],
    })!,
    10,
    (rpcId) => rpcId === "local",
  );
  assert.deepStrictEqual(mine.get("local"), { target: "next-turn", seq: 10, index: 1 }, "本地提交照记");
  assert.strictEqual(mine.has("foreign"), false, "别人的 rpcId 不记（位置仍按数组下标算）");

  noteInboxProjection(
    mine,
    { "next-turn": [userMessage("foreign"), userMessage("local")], "next-step": [] },
    11,
    undefined,
    (rpcId) => rpcId === "local",
  );
  assert.deepStrictEqual(mine.get("local"), { target: "next-turn", seq: 11, index: 1 });
  assert.strictEqual(mine.has("foreign"), false);
  console.log("  admitted 回执、身份边界与水位等待 ✓");
}

// ---------- 十二、适配器接线：快照 / 投影 / 重连搬运 ----------
//
// 适配器是回执账本的持有者（`submissions`），也是跟随流重建时唯一会丢掉它的地方。
// 这里直接驱动真 `SessionAdapter`，只断言它交给控制器的回调：
// - `onSubmissionObserved`：Host 已持有（开窗截点），是收显的唯一非 durable 来路；
// - `onSubmissionLost`：领取后越过轮次边界仍没落盘；
// - `onUserMessage`：durable 承认（与「进入队列」是两件事）。
{
  /** 一条跟随事件帧。 */
  const eventFrame = (seq: number, type: string, data: Record<string, unknown>): SessionFollowFrame => ({
    type: "event",
    event: { type, seq, time: seq, data },
  });
  /** 一份只带投影截点 / inbox 与记录的最简快照。 */
  const snapshotFrame = (options: {
    cut?: number;
    inbox?: unknown;
    omitInbox?: boolean;
    records?: SessionFollowFrame[];
  }): SessionFollowFrame => ({
    type: "snapshot",
    header: { version: 4, id: "session-receipts", createdAt: 0 },
    cursor: options.cut ?? 10,
    records: (options.records ?? []).filter(
      (record): record is Extract<SessionFollowFrame, { type: "event" }> => record.type === "event",
    ),
    hasMore: false,
    projections: {
      asOfSeq: options.cut ?? 10,
      values: options.omitInbox ? {} : { inbox: options.inbox ?? { "next-turn": [], "next-step": [] } },
    },
  });
  const claimFrame = (seq: number, target: "next-turn" | "next-step" = "next-turn") =>
    eventFrame(seq, "agent/inbox/spliced", { target, start: 0, removedCount: 1 });
  const boundaryFrame = (seq: number) =>
    eventFrame(seq, "turn/end", { turn: 1, reason: { kind: "error", error: { message: "prepareRequest failed" } } });
  const admitFrame = (seq: number, rpcId: string, text: string) =>
    eventFrame(seq, "user/message", {
      id: `m-${rpcId}`,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user-rpc", rpcId },
      surfaceOp: "append",
    });

  // A) 漏收入队 splice：投影补位，领取 + 边界照样判 lost；排队受理不等于 durable 承认
  {
    const adapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    let admitted = 0;
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.onUserMessage = () => {
      admitted += 1;
    };

    adapter.noteInboxProjection({ "next-turn": [userMessage("fallback")], "next-step": [] }, 10);
    assert.deepStrictEqual(observed, [], "inbox 里出现只补回执，不凭存在去收 chat 回显");
    assert.strictEqual(admitted, 0, "排队受理不触发 onUserMessage");
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(boundaryFrame(12));
    assert.deepStrictEqual(lost, ["fallback"], "投影补出的回执在领取 + 边界后判 lost");
    console.log("  适配器：投影补位 → 领取 + 边界收场 ✓");
  }

  // B) 开窗截点：已有回执 <= cut → observed(snapshot)，窗口里的 turn/end 不许把它改判成 lost
  {
    const adapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.noteInboxProjection({ "next-turn": [userMessage("held")], "next-step": [] }, 5);
    observed.length = 0;
    adapter.applyFrame(
      snapshotFrame({
        cut: 10,
        records: [eventFrame(9, "turn/end", { turn: 1, reason: { kind: "error" } })],
        inbox: { "next-turn": [userMessage("held")], "next-step": [] },
      }),
    );
    assert.deepStrictEqual(observed, ["held"], "截点之前已有回执 ⇒ Host 已持有，退回显");
    assert.deepStrictEqual(lost, [], "重连快照不许把 Host 已持有的提交改判成失败");

    // 快照之后才到的 inbox 投影仍可能列着那条排队消息：不许把它重新补成回执
    adapter.noteInboxProjection({ "next-turn": [userMessage("held")], "next-step": [] }, 10);
    assert.deepStrictEqual(observed, ["held"], "已判 Host 已持有的 rpcId 不被迟到的投影重新补回");

    adapter.applyFrame(boundaryFrame(11));
    assert.deepStrictEqual(lost, [], "下一次轮次边界也不许翻案（截点已把它摘掉）");
    console.log("  适配器：快照截点退回显、不是 snapshot 清空即 lost ✓");
  }

  // C) 快照里的 inbox 能补回执，但只补位次，不当作 durable 承认
  {
    const adapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    let admitted = 0;
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.onUserMessage = () => {
      admitted += 1;
    };
    adapter.applyFrame(
      snapshotFrame({
        cut: 10,
        records: [],
        inbox: { "next-turn": [userMessage("in-snapshot")], "next-step": [] },
      }),
    );
    assert.deepStrictEqual(observed, [], "快照 seed 不冒充「进入队列」的收显通知（官方 installWindow 同口径）");
    assert.strictEqual(admitted, 0);
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(boundaryFrame(12));
    assert.deepStrictEqual(lost, ["in-snapshot"], "快照投影补出的回执同样能被后续边界定性");
    console.log("  适配器：快照 inbox 初始化回执 ✓");
  }

  // D) 重连搬运：新适配器接上旧账本，截点之前的那条照旧按 Host 已持有收显
  {
    const oldAdapter = new SessionAdapter(() => undefined);
    oldAdapter.noteInboxProjection({ "next-turn": [userMessage("carried")], "next-step": [] }, 5);
    const nextAdapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    nextAdapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    nextAdapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    nextAdapter.adoptSubmissionReceipts(oldAdapter.submissionReceipts());
    nextAdapter.applyFrame(snapshotFrame({ cut: 10, records: [] }));
    assert.deepStrictEqual(observed, ["carried"], "重连后新适配器仍认得旧回执");
    assert.deepStrictEqual(lost, [], "不会因为适配器重建而把在飞提交丢掉");

    nextAdapter.applyFrame(boundaryFrame(11));
    assert.deepStrictEqual(lost, [], "搬运过来的回执同样不会被后续边界误判");
    console.log("  适配器：重连搬运回执账本 ✓");
  }

  // E) durable 承认优先：窗口里的 user/message 与截点重叠时走承认路径，不重复 observed
  {
    const adapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    const admitted: string[] = [];
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    adapter.noteInboxProjection({ "next-turn": [userMessage("admitted")], "next-step": [] }, 5);
    observed.length = 0;
    adapter.applyFrame(
      snapshotFrame({
        cut: 10,
        records: [
          eventFrame(6, "user/message", {
            id: "m-admitted",
            role: "user",
            content: [{ type: "text", text: "承认那一句" }],
            source: { kind: "user-rpc", rpcId: "admitted" },
            surfaceOp: "append",
          }),
        ],
        inbox: { "next-turn": [userMessage("admitted")], "next-step": [] },
      }),
    );
    assert.deepStrictEqual(observed, [], "窗口里已落盘的那条走 onUserMessage，不重复 observed");
    assert.deepStrictEqual(admitted, ["admitted:承认那一句"], "durable 承认是独立语义");
    adapter.applyFrame(boundaryFrame(11));
    assert.deepStrictEqual(lost, [], "已经落盘的那条绝不能被后续边界翻案");
    console.log("  适配器：durable 承认与排队受理分开 ✓");
  }

  // F) 身份边界：别人的 rpcId 不建本地回执，也不会替别人收场
  {
    const adapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    adapter.ownsSubmission = (rpcId) => rpcId === "local";
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.noteInboxProjection(
      { "next-turn": [userMessage("foreign"), userMessage("local")], "next-step": [] },
      10,
    );
    assert.deepStrictEqual(observed, [], "inbox 存在不是 chat 回显的收显凭据");
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(claimFrame(12));
    adapter.applyFrame(boundaryFrame(13));
    assert.deepStrictEqual(lost, ["local"], "只给本地提交下失败结论（foreign 没有回执）");

    // 入队 splice 这条来路同样按身份过滤
    const viaSplice = new SessionAdapter(() => undefined);
    const spliceLost: string[] = [];
    viaSplice.ownsSubmission = (rpcId) => rpcId === "local2";
    viaSplice.onSubmissionLost = (rpcId) => spliceLost.push(rpcId);
    viaSplice.applyFrame(
      eventFrame(10, "agent/inbox/spliced", {
        target: "next-turn",
        start: 0,
        inserted: [userMessage("foreign2"), userMessage("local2")],
      }),
    );
    viaSplice.applyFrame(claimFrame(11));
    viaSplice.applyFrame(claimFrame(12));
    viaSplice.applyFrame(boundaryFrame(13));
    assert.deepStrictEqual(spliceLost, ["local2"], "splice 入队同样过滤外来 rpcId");
    console.log("  适配器：本地提交身份边界 ✓");
  }

  // G) 没有投影水位也照样观察队列行（官方 observeSubmissionInbox 的 seq undefined 分支）
  {
    const adapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    adapter.ownsSubmission = (rpcId) => rpcId === "queued";
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.noteInboxProjection(
      { "next-turn": [userMessage("queued"), userMessage("foreign")], "next-step": [] },
      undefined,
    );
    assert.deepStrictEqual(
      observed,
      [],
      "无水位只跳过位次初始化；本扩展没有 queued echo，不能凭 inbox 存在收 chat 回显",
    );
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(boundaryFrame(12));
    assert.deepStrictEqual(lost, [], "无水位不建回执 ⇒ 不产生失败判定");

    // 同一帧稍后带水位到达时才补回执，后续仍能按同一套数学收场
    adapter.noteInboxProjection({ "next-turn": [userMessage("queued")], "next-step": [] }, 20);
    adapter.applyFrame(claimFrame(21));
    adapter.applyFrame(boundaryFrame(22));
    assert.deepStrictEqual(lost, ["queued"], "有水位后才具备失败判定的凭据");
    console.log("  适配器：seq undefined 不初始化回执、也不收 chat 回显 ✓");
  }

  // H) durable 承认后的水位等待：领取未被投影确认前不交收显，确认后再交且不再判失败
  {
    const adapter = new SessionAdapter(() => undefined);
    const lost: string[] = [];
    const observed: string[] = [];
    const admitted: string[] = [];
    adapter.ownsSubmission = (rpcId) => rpcId === "wait";
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    adapter.noteInboxProjection({ "next-turn": [userMessage("wait")], "next-step": [] }, 10);
    observed.length = 0;
    assert.deepStrictEqual(observed, [], "inbox 存在不是 chat 回显的收显凭据");
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(
      eventFrame(12, "user/message", {
        id: "m-wait",
        role: "user",
        content: [{ type: "text", text: "等水位那一句" }],
        source: { kind: "user-rpc", rpcId: "wait" },
        surfaceOp: "append",
      }),
    );
    assert.deepStrictEqual(admitted, [], "inbox 水位 10 < 领取水位 11：先不收显（官方 retireAdmittedSubmission）");
    // 位次已 null 但 admitted 标记保住：边界帧不许把它翻成 lost
    adapter.applyFrame(boundaryFrame(13));
    assert.deepStrictEqual(lost, [], "已承认的回执不参与失败判定");

    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 10);
    assert.deepStrictEqual(admitted, [], "投影没推进到 11：继续等");
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 11);
    assert.deepStrictEqual(admitted, ["wait:等水位那一句"], "投影追上领取水位后交收显");
    adapter.applyFrame(boundaryFrame(14));
    assert.deepStrictEqual(lost, [], "收显之后也不再有失败判定");
    console.log("  适配器：durable 承认按 inbox 水位延迟收显 ✓");
  }

  // I) admitted 回执随重连搬运：新适配器继续等水位，追上后才收显
  {
    const oldAdapter = new SessionAdapter(() => undefined);
    oldAdapter.noteInboxProjection({ "next-turn": [userMessage("carried-wait")], "next-step": [] }, 10);
    oldAdapter.applyFrame(claimFrame(11));
    oldAdapter.applyFrame(
      eventFrame(12, "user/message", {
        id: "m-carried-wait",
        role: "user",
        content: [{ type: "text", text: "重连也要等" }],
        source: { kind: "user-rpc", rpcId: "carried-wait" },
        surfaceOp: "append",
      }),
    );
    const nextAdapter = new SessionAdapter(() => undefined);
    const admitted: string[] = [];
    const lost: string[] = [];
    nextAdapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    nextAdapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    nextAdapter.adoptSubmissionReceipts(oldAdapter.submissionReceipts());
    nextAdapter.applyFrame(snapshotFrame({ cut: 10, records: [] }));
    assert.deepStrictEqual(admitted, [], "新适配器快照 10 < 回执 11：继续等");
    nextAdapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 11);
    assert.deepStrictEqual(admitted, ["carried-wait:"], "追上后交收显（rpcId 足够；正文只在无 rpcId 时用）");
    nextAdapter.applyFrame(boundaryFrame(12));
    assert.deepStrictEqual(lost, [], "搬运后的 admitted 回执也不判失败");
    console.log("  适配器：admitted 回执跨重连搬运 ✓");
  }

  // J) 同一适配器遇到替换型 baseline 的低水位：按**当前权威值**下降，不保留历史最高
  {
    const adapter = new SessionAdapter(() => undefined);
    const admitted: string[] = [];
    adapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    adapter.noteInboxProjection({ "next-turn": [userMessage("lowered")], "next-step": [] }, 10);
    adapter.applyFrame(claimFrame(11));
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 20);
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 5); // truncate 到更低
    adapter.applyFrame(admitFrame(12, "lowered", "低水位后承认"));
    assert.deepStrictEqual(
      admitted,
      [],
      "权威水位降到 5 后必须继续等（Math.max 会保留 20 并提前放行）",
    );
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 11);
    assert.deepStrictEqual(admitted, ["lowered:低水位后承认"], "真正追上领取水位才放行");
    console.log("  适配器：替换型 baseline 降低 inbox 水位 ✓");
  }

  // K) 同一适配器第二次替换 snapshot：cut 也要按当前窗口取值，不能取历史最大
  {
    const adapter = new SessionAdapter(() => undefined);
    const admitted: string[] = [];
    adapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    adapter.applyFrame(snapshotFrame({ cut: 20, records: [] }));
    adapter.applyFrame(snapshotFrame({ cut: 5, records: [] }));
    adapter.applyFrame(
      eventFrame(10, "agent/inbox/spliced", {
        target: "next-turn",
        start: 0,
        inserted: [userMessage("second-snapshot")],
      }),
    );
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(admitFrame(12, "second-snapshot", "第二个快照后承认"));
    assert.deepStrictEqual(admitted, [], "第二次 snapshot cut=5 必须覆盖旧 20，继续等水位");
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 11);
    assert.deepStrictEqual(admitted, ["second-snapshot:第二个快照后承认"], "追上后才放行");
    console.log("  适配器：同适配器第二次 snapshot 按当前 cut ✓");
  }

  // L) snapshot 没带 inbox：不能把 cut 当 inbox 水位（官方 seqOf('inbox') 没有这一行）
  {
    const adapter = new SessionAdapter(() => undefined);
    const admitted: string[] = [];
    adapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 10);
    adapter.applyFrame(snapshotFrame({ cut: 20, omitInbox: true, records: [] }));
    adapter.applyFrame(
      eventFrame(15, "agent/inbox/spliced", {
        target: "next-turn",
        start: 0,
        inserted: [userMessage("missing-inbox")],
      }),
    );
    adapter.applyFrame(claimFrame(16));
    adapter.applyFrame(admitFrame(17, "missing-inbox", "缺 inbox 块后承认"));
    assert.deepStrictEqual(admitted, [], "缺 inbox 的 snapshot 不能把 cut=20 抬成水位");
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 16);
    assert.deepStrictEqual(admitted, ["missing-inbox:缺 inbox 块后承认"], "真实投影到达后才放行");
    console.log("  适配器：snapshot 缺 inbox 不抬水位 ✓");
  }

  // M) snapshot 缺 inbox 时，截点覆盖到的 admitted 回执已先按 Host 已持有收掉，不会错误放行
  {
    const adapter = new SessionAdapter(() => undefined);
    const admitted: string[] = [];
    const observed: string[] = [];
    const lost: string[] = [];
    adapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    adapter.onSubmissionObserved = (rpcId) => observed.push(rpcId);
    adapter.onSubmissionLost = (rpcId) => lost.push(rpcId);
    adapter.noteInboxProjection({ "next-turn": [userMessage("observed-first")], "next-step": [] }, 10);
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(admitFrame(12, "observed-first", "先承认等水位"));
    assert.deepStrictEqual(admitted, [], "前置：水位未追上，先等");
    adapter.applyFrame(snapshotFrame({ cut: 20, omitInbox: true, records: [] }));
    assert.deepStrictEqual(observed, ["observed-first"], "cut 覆盖到的回执先按 Host 已持有交出去");
    assert.deepStrictEqual(admitted, [], "不会再把仍在等待的 admitted 当成已放行");
    assert.deepStrictEqual(lost, [], "更不会判失败");
    console.log("  适配器：snapshot 缺 inbox 时 cut 覆盖的回执先 observed ✓");
  }

  // N) 控制流把 inbox 键清掉（value/seq 都 undefined）：水位回到未知，admitted 继续等
  {
    const adapter = new SessionAdapter(() => undefined);
    const admitted: string[] = [];
    adapter.onUserMessage = (message) => admitted.push(`${message.rpcId}:${message.text}`);
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 20);
    adapter.noteInboxProjection(undefined, undefined);
    adapter.applyFrame(
      eventFrame(10, "agent/inbox/spliced", {
        target: "next-turn",
        start: 0,
        inserted: [userMessage("cleared-key")],
      }),
    );
    adapter.applyFrame(claimFrame(11));
    adapter.applyFrame(admitFrame(12, "cleared-key", "键清掉后承认"));
    assert.deepStrictEqual(admitted, [], "水位回到 undefined 后按 -1 继续等");
    adapter.noteInboxProjection({ "next-turn": [], "next-step": [] }, 11);
    assert.deepStrictEqual(admitted, ["cleared-key:键清掉后承认"], "新水位到达后放行");
    console.log("  适配器：inbox 键清掉回到未知水位 ✓");
  }
}

console.log("submissionReceipts: 收件箱回执的位次、水位与两种收场 ✓");
