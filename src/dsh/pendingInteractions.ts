/**
 * 宿主侧「还没结算的审批 / 提问」的托管。
 *
 * ## 它管什么
 *
 * `$events` 流上的两类 waterfall（`approval/request` / `user-questions/request`）
 * **必须先记一份在宿主手里**才能投给界面。原因只有一个：审批 / 提问**不是 durable
 * 事件**（会话日志里没有它们，重放不回），卡片只存在于会话域的适配器里，而适配器
 * 会随域被回收——用户切去看别的会话就是一次回收（`dropViewers` → `destroyScope`）。
 * 只在适配器里留一份，切回来时卡片就永久没了：agent 卡在 ask 节点，只能中断重问
 * （用户 2026-09-15 报的现场）。
 *
 * 于是「事件 id → 原始请求（含它属于哪个会话）」这份账本归本模块，宿主只负责投递：
 *
 * ```
 * 收到 waterfall         → hold()      → "new" 就投进域（有域的话）
 * 窗口绑上某个会话       → forSession() → 逐条投进该域的适配器
 * 本窗口答复 / 用户撤回  → settle()    → 回 Host，账目结清
 * Host 撤回（cancel 帧） → withdraw()  → 收场本窗口那张卡（什么都不回）
 * ```
 *
 * ## 四条规则由本模块的 API 保证（调用方**不需要**记得配对）
 *
 * 1. **去重**：同一个 `eventId` 第二次 `hold()` 报 `"duplicate"`，不改动已记内容。
 *    重连、窗口重载、另一窗口绑上时服务端都会重投递同一条 waterfall——`"duplicate"`
 *    就是「这条已经收下了，别重复弹卡」的判据（要不要回 Host `next` 由调用方决定）。
 * 2. **回放不删**：`forSession()` 是**读**，返回的条目继续留在账上。回放只解决
 *    「卡片现在要显示出来」，不解决「这次询问结束了」——后者只有结算能解决。
 * 3. **结算才删**：`settle()` / `withdraw()` 是**仅有的**两个把条目从账上拿掉的入口，
 *    而且两条路都返回那条记录，所以调用方不需要自己维护第二份「事件 → 会话」索引
 *    就能把卡片结果落回对的域（改造前那份 `eventSessions` 就是这么多出来的，
 *    并且只增不删——见 `AGENTS.md` 的内存口径）。
 * 4. **投递状态与账目分开记**：`seen` 只回答「这条 waterfall 我见过了吗」，与
 *    「它还欠不欠一次回答」无关。所以重连（`resetDedupe`）不会把未结算的条目弄丢，
 *    而结算（`settle` / `withdraw`）也不会把去重记账弄丢——两件事以前混在
 *    三个集合里，靠调用方记得配对。
 *
 * 规则 3 是「结算点恰好四处」（`answerApproval` / `answerQuestion` / `cancelQuestion` /
 * Host 撤回）的实现基础：宿主侧那四处各调一次 `settle()` / `withdraw()`，而
 * **没有别的 API 能把条目从账上拿掉**——`held` 是私有字段，模块外拿不到 `Map`，
 * 也就写不出第五种结算。这条由 `scripts/pendingInteractions.test.ts` 的行为断言守着。
 *
 * 改造前这套规则散在 `controller.ts` 的三个集合（`heldEvents` / `eventSessions` /
 * `handledEvents`）与六个方法里；「回放只投递不删」「结算清哪些集合」无法被任何断言
 * 钉住，只能对 5000 行源码做切片 + 数字符串。
 */

/**
 * 一条**还没结算**的审批 / 提问。
 *
 * `request` 是服务端 waterfall 里那份原始请求（形状按 `kind` 分叉，由
 * `controller.deliverEventToScope` 解析），本模块不碰它的内部。
 */
export interface HeldInteraction {
  eventId: string;
  kind: "approval" | "question";
  sessionId: string;
  request: unknown;
}

/** `hold()` 的结论：`"new"` = 这条第一次见，`"duplicate"` = 重投递。 */
export type HoldOutcome = "new" | "duplicate";

export class PendingInteractions {
  /** 账本本体：`eventId` → 记录。删条目只有 `settle` / `withdraw` 两条出口。 */
  private readonly held = new Map<string, HeldInteraction>();
  /** 见过的 `eventId`：重投递去重用（`resetDedupe` 清）。 */
  private readonly seen = new Set<string>();

  /**
   * 收下一条审批 / 提问（收帧路径）。返回 `"new"` 时调用方应当把它投进域
   * （有域的话）；`"duplicate"` 时什么都不用做——卡片已经在页面上了。
   */
  hold(item: HeldInteraction): HoldOutcome {
    if (this.seen.has(item.eventId)) return "duplicate";
    this.seen.add(item.eventId);
    this.held.set(item.eventId, item);
    return "new";
  }

  /** 这条 `eventId` 见过没有（重投递判据，`controller.onEventFrame` 用）。 */
  hasSeen(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** 某个会话的**全部未结算**条目，按收下顺序（`bindViewToSession` 的回放输入）。**读**，不删。 */
  forSession(sessionId: string): HeldInteraction[] {
    const items: HeldInteraction[] = [];
    for (const item of this.held.values()) {
      if (item.sessionId === sessionId) items.push(item);
    }
    return items;
  }

  /**
   * **结算**一条：本窗口答复了（`answerApproval` / `answerQuestion`）或用户自己撤回
   * （`cancelQuestion`，计划审阅卡的「去聊天里说」）。返回那条记录，供调用方把卡片
   * 状态落回 `sessionId` 对应的域；这条从没被 `hold()` 过时是 `undefined`。
   *
   * 结算之后它再也不会被 `forSession()` 回放。
   */
  settle(eventId: string): HeldInteraction | undefined {
    const item = this.held.get(eventId);
    this.held.delete(eventId);
    return item;
  }

  /**
   * Host 撤回一条（`$events` 的 `cancel` 帧：另一个窗口答了 / 轮次中止 / Agent Context
   * 释放）。与 `settle()` 的唯一区别是调用方拿它做什么：`cancel` 帧**什么都不要回**，
   * 只把本窗口那张卡收场（`adapter.cancelEvent`）。
   *
   * 两种情形都走这里：卡片已经在某个窗口上（账上有这条，调用方据此收场），或请求还没
   * 投递到任何域（账上没有，返回 `undefined`——它已经不需要人回答了，留着只会在用户
   * 下次打开这个会话时凭空弹一张过期的卡）。
   */
  withdraw(eventId: string): HeldInteraction | undefined {
    const item = this.held.get(eventId);
    this.held.delete(eventId);
    return item;
  }

  /**
   * 重置**去重记账**（`teardownStreams`：连接被收掉，旧的那份「这条我回过了」不作数）。
   *
   * 只清 `seen`，**账本 `held` 一个字都不动**——这看起来不对称，但正是生命周期需要的：
   * 「重连 → 切会话 → 切回来」这条路上，卡片能回来靠的就是条目留在账上；而重连后
   * 服务端重投递的 waterfall 必须被当成 `"new"` 重新投递一次（适配器自己按 `requestId`
   * 去重，所以不会变成两张卡）。
   */
  resetDedupe(): void {
    this.seen.clear();
  }
}
