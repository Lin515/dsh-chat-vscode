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

import {
  inboxSpliceOf,
  noteInboxInserted,
  noteInboxSplice,
  rpcIdOfMessage,
  takeLostSubmissions,
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

console.log("submissionReceipts: 收件箱回执的位次、水位与两种收场 ✓");
