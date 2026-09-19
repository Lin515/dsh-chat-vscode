/**
 * `src/dsh/pendingInteractions.ts` 的四条内部规则（真 API 断言）。
 *
 * 这套断言接替了此前对 `controller.ts` 的**源码切片**检查：那时候「未结算的审批/提问」
 * 的生命周期散在三个集合（`heldEvents` / `eventSessions` / `handledEvents`）与六个方法
 * 里，唯一能钉住它的办法是读 5000 行源码、找字符串位置、数 `this.heldEvents.delete(`
 * 出现几次——改个注释或挪一行就假红/假绿（`AGENTS.md` 的「断言只钉确定的事实」）。
 * 现在规则归模块，断言直接调 API：
 *
 * 1. **去重**：同一条 waterfall 重投递只收一次，而且不覆盖已记内容；
 * 2. **回放不删**：`forSession()` 是读，同一条可以回放任意多次；
 * 3. **结算才删**：`settle()` / `withdraw()` 是两个（也是仅有的两个）删条目的出口；
 * 4. **结算把记账清干净**：结算过的条目不再回放、不再“见过”、拿到的是原始请求。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { PendingInteractions, type HeldInteraction } from "../src/dsh/pendingInteractions";

const approval = (eventId: string, sessionId: string, callId = "call_1"): HeldInteraction => ({
  eventId,
  kind: "approval",
  sessionId,
  request: { toolName: "pwsh", callId },
});

const question = (eventId: string, sessionId: string): HeldInteraction => ({
  eventId,
  kind: "question",
  sessionId,
  request: { questions: [{ id: "q1", question: "选哪个？", options: [] }] },
});

// ---------- 1. 去重：重投递只收一次，且不改动已记内容 ----------
{
  const ledger = new PendingInteractions();
  const first = approval("ev-1", "s1");
  assert.strictEqual(ledger.hold(first), "new", "第一次见到 → 该投递");
  assert.strictEqual(ledger.hold(first), "duplicate", "同一条重投递 → 不重复弹卡");
  assert.strictEqual(ledger.hasSeen("ev-1"), true);
  assert.strictEqual(ledger.hasSeen("ev-2"), false, "没见过的 id 不算见过");

  // 重投递带的是「等价但不同对象」的请求：账上必须仍是**先到那份**。
  // 覆盖它只会在两份不一样时（服务端换代）让先投出去的卡与账本变成两份事实。
  const second = { ...first, request: { toolName: "other", callId: "call_9" } };
  assert.strictEqual(ledger.hold(second), "duplicate");
  assert.strictEqual(ledger.forSession("s1")[0], first, "账上的仍是先收下的那条");
}
console.log("pendingInteractions: 重投递去重（不覆盖已记内容）✓");

// ---------- 2. 回放不删：切走又切回来，条目一直在 ----------
{
  const ledger = new PendingInteractions();
  const a = approval("ev-a", "s1");
  const q = question("ev-q", "s1");
  const other = approval("ev-b", "s2");
  ledger.hold(a);
  ledger.hold(q);
  ledger.hold(other);

  assert.deepStrictEqual(ledger.forSession("s1"), [a, q], "按会话分桶、按收下顺序");
  assert.deepStrictEqual(ledger.forSession("s2"), [other], "别的会话是另一桶");
  assert.deepStrictEqual(ledger.forSession("s1"), [a, q], "回放任意多次都还在（切走再切回来就是两次）");
  assert.deepStrictEqual(ledger.forSession("s3"), [], "没有条目的会话给空数组（不是 undefined）");

  // 回放之外，重复收下也不许改动已记内容（上一节）；回放本身更是只读——
  // 投递路径拿着这些对象，改动它们就等于改账
  assert.strictEqual(ledger.forSession("s1")[0], a, "读出来的是账上那条（同一引用）");
  const snapshot = ledger.forSession("s1");
  snapshot.length = 0;
  assert.strictEqual(ledger.forSession("s1").length, 2, "改返回数组不影响账本");
}
console.log("pendingInteractions: 回放不删条目（读任意多次）✓");

// ---------- 3. 结算才删：两个出口、都交出那条记录 ----------
{
  const ledger = new PendingInteractions();
  const a = approval("ev-a", "s1");
  const q = question("ev-q", "s1");
  ledger.hold(a);
  ledger.hold(q);

  // `settle`：本窗口答复（answerApproval / answerQuestion）与用户撤回（cancelQuestion）走它。
  // 返回会话 id —— 调用方据此把卡片状态落回对的域，不需要自己维护第二份「事件 → 会话」索引。
  assert.strictEqual(ledger.settle("ev-a")?.sessionId, "s1", "结算要交出会话 id（路由回域靠它）");
  assert.deepStrictEqual(ledger.forSession("s1"), [q], "结算掉的那条不再回放");
  assert.strictEqual(ledger.settle("ev-a"), undefined, "再结算一次是空操作（不是崩溃、不是复活）");
  assert.strictEqual(ledger.settle("从没见过的"), undefined, "没 hold 过的 id 也能安全 settle");

  // `withdraw`：Host 撤回（cancel 帧）走它，调用方拿原始请求去收场本窗口那张卡
  const taken = ledger.withdraw("ev-q");
  assert.strictEqual(taken, q, "撤回要交出**原始请求**（adapter.cancelEvent 只需要 id，投递另有用处）");
  assert.deepStrictEqual(ledger.forSession("s1"), [], "撤回之后账上就没有这条了");

  // 没投递到任何域的请求（账上可能没有）也能撤回：留着只会在用户下次打开这个会话时
  // 凭空弹一张过期的卡
  assert.strictEqual(ledger.withdraw("ev-never-held"), undefined);
}
console.log("pendingInteractions: 结算才删（settle / withdraw 两个出口）✓");

// ---------- 4. 结算过的条目不会被重投递复活 ----------
//
// 「结算」= 这次询问结束了（也许该问的是「这条 waterfall 我还欠不欠一次回答」）。
// 服务端结算后还会把同一条重投递给别的投递方（多窗口）——那不能把账目重新挂上，
// 否则卡会在用户切回会话时凭空回来并永远占着输入区。
{
  const ledger = new PendingInteractions();
  const a = approval("ev-a", "s1");
  ledger.hold(a);
  ledger.settle("ev-a");
  assert.strictEqual(ledger.hold(a), "duplicate", "结算过的 id 依然算「见过」");
  assert.deepStrictEqual(ledger.forSession("s1"), [], "所以它不会被重新挂上");

  ledger.hold(approval("ev-b", "s1"));
  ledger.withdraw("ev-b");
  assert.strictEqual(ledger.hold(approval("ev-b", "s1")), "duplicate", "撤回过的同理");
}
console.log("pendingInteractions: 结算过的条目不会被重投递复活 ✓");

// ---------- 5. resetDedupe：只清「见过」，不清账 ----------
//
// 连接被收掉（`teardownStreams`）时旧的那份「这条我回过了」不作数：重连后服务端
// 重投递必须被当成 `"new"` 重新投递（适配器自己按 requestId 去重，不会两张卡）。
// 而**账本一个字都不能动**——「重连 → 切会话 → 切回来」这条路上卡片能回来靠的就是它。
{
  const ledger = new PendingInteractions();
  const a = approval("ev-a", "s1");
  ledger.hold(a);
  ledger.settle("ev-a");
  ledger.hold(approval("ev-b", "s1"));

  ledger.resetDedupe();
  assert.strictEqual(ledger.hasSeen("ev-a"), false, "旧的去重记账清掉了");
  assert.strictEqual(ledger.hold(a), "new", "重连后重投递的 waterfall 重新算「新」（卡片照旧投递）");
  assert.deepStrictEqual(
    ledger.forSession("s1").map((item) => item.eventId),
    ["ev-b", "ev-a"],
    "**未结算的 `ev-b` 一直都在**，重连不让它消失（它是「切走再切回来」时卡片能回来的唯一依据）",
  );
}
console.log("pendingInteractions: resetDedupe 只清去重记账、不动账本 ✓");

// ---------- 6. API 面：结算出口不许再长出第三个 ----------
//
// 「结算点恰好 4 处」这条不变量的实现基础是「能删条目的出口只有 `settle` / `withdraw`
// 两个」。控制器那 4 个调点由 `interactionSync.test.ts` 钉；这里钉另一半：模块**没有**
// 别的办法能动账本。将来真要加出口，这条断言会先红，逼着改的人说明理由。
{
  const methods = Object.getOwnPropertyNames(PendingInteractions.prototype).sort();
  assert.deepStrictEqual(
    methods,
    ["constructor", "forSession", "hasSeen", "hold", "resetDedupe", "settle", "withdraw"],
    "PendingInteractions 的 API 面（多一个方法就要在 `interactionSync.test.ts` 的 4 个结算点" +
      "口径里重新算一遍——`resetDedupe` 之外任何新名字都可能是第三个结算出口）",
  );
}
console.log("pendingInteractions: 结算出口只有两个（API 面受钉）✓");

// ---------- 7. 两种 kind 走同一条账 ----------
//
// 审批与提问的**收场方式**不同（resolveApproval / resolveQuestion / cancelEvent），
// 但「未结算」这件事的规则完全一样——kind 只是记录的一部分，不改变四条规则。
{
  const ledger = new PendingInteractions();
  const a = approval("ev-a", "s1");
  const q = question("ev-a-same-session", "s1");
  ledger.hold(a);
  ledger.hold(q);
  assert.deepStrictEqual(
    ledger.forSession("s1").map((item) => item.kind).sort(),
    ["approval", "question"],
    "审批与提问同账同桶（回放时按 kind 各自投递）",
  );
  assert.strictEqual(ledger.settle("ev-a")?.kind, "approval");
  assert.strictEqual(ledger.withdraw("ev-a-same-session")?.kind, "question");
  assert.deepStrictEqual(ledger.forSession("s1"), []);
}
console.log("pendingInteractions: 审批与提问同一条账 ✓");

console.log("\npendingInteractions: all assertions passed");
