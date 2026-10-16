/**
 * 已提交消息在服务端**收件箱**里的回执：判定「服务端收下了，但这一轮没能把它落盘」。
 *
 * ## 为什么需要它
 *
 * `session/prompt` 回 `accepted` 只说明那句话进了 Agent 的收件箱，**不代表它落盘**。
 * `agent-loop` 的次序是：`turn/start` → `preStep` 领取收件箱里那条 → `prepareRequest`
 * （解析模型 / 请求配置，见 `llm.prepareCall`）→ 才 `session.append('user/message')`。
 * 中间任何一步抛错都会让这一轮只剩 `turn/end{reason:{kind:'error'}}`，而那句人话
 * **永远不落盘**。真实例子：所选模型没有对应的思考档位 →
 * `UNSUPPORTED_REASONING_EFFORT` 正好抛在 `user/message` 之前。
 *
 * 宿主的乐观回显只在 durable `user/message` 承认时收回（见 `controller.noteUserAdmitted`），
 * 于是这一类提交会一直停在 `sending`：界面把它画成一条**正常**消息，`pendingInsertIndex`
 * 又把它一路甩到会话最底部（用户 2026-10-16 报的现场）。收件箱回执就是把它认出来的凭据。
 *
 * ## 口径来自官方客户端
 *
 * `@deepseek-ai/dsh-client` 的 Session 给每个本地提交带一份 `settlement.receipt`
 * （收件箱位次 + 事件水位），规则逐条对应这里：
 *
 * - **入队帧**（`agent/inbox/spliced` 带 `inserted`）→ 记下目标与位次；
 * - **领取帧**（`removedCount` 且 outcome 不是 `canceled`）→ 位次置 `null`（已离开收件箱，
 *   还没有 durable 承认）；
 * - **取消帧**（`outcome: 'canceled'`，官方 `Session.clear()` 与队列取消都走它）→
 *   这条待发消息被有意丢掉；
 * - 之后 **`turn/end` / `request/context`** 上仍未承认、位次还是 `null`、且回执水位更旧
 *   ⇒ 这条提交永远到不了 durable。
 *
 * 两条纪律让重连重放同一批事件保持幂等：位次只随**带水位**的 splice 平移，水位只许前进
 * （旧帧、重放帧一律不倒退）。
 *
 * 覆盖面：回执只由 durable 事件建立/推进。客户端若在那条入队 splice 上正好掉线、跟随
 * 开窗快照又没带回它，这条回执就缺失，判定不触发（官方的 `observeSubmissionInbox` 另有
 * `inbox` 投影兜底，本扩展暂无这一层）——缺失只会漏判，不会误判。
 */

/** 收件箱的两条待发队列（`agent/inbox/spliced` 的 `target`）。 */
export type InboxTarget = "next-turn" | "next-step";

/**
 * 一条提交在收件箱里的回执。
 *
 * `index` 是它在 `target` 那条队列里的位次，`null` = 已经被某一轮领取（或已被移出）——
 * 也就是「不再等着发、但还没成为 durable 用户消息」的那个中间态。
 */
export interface SubmissionReceipt {
  readonly target: InboxTarget;
  /** 推进它的那条事件的水位；只许前进（旧帧 / 重放帧不倒退）。 */
  readonly seq: number;
  readonly index: number | null;
}

/** rpcId → 回执。键是客户端铸造的提交身份，与乐观回显同一个身份。 */
export type SubmissionReceipts = Map<string, SubmissionReceipt>;

/** 一条归一化后的 `agent/inbox/spliced`。形状不可用（target 不认 / start 不是数）时为 `undefined`。 */
export interface InboxSplice {
  readonly target: InboxTarget;
  readonly start: number;
  readonly removedCount: number;
  /**
   * 这一帧插进来的消息，**原样**留着：位次只需要条数，而认「哪条是自己的提交」要读
   * 消息里的 `source.rpcId`（见 `rpcIdOfMessage`）。形状不可用的元素占一个空位——
   * 位次就是语义，丢掉会让后面的位次整体前移。
   */
  readonly inserted: readonly unknown[];
  /** 这一帧是「有意丢掉这些待发消息」（官方 `outcome: 'canceled'`）。 */
  readonly canceled: boolean;
}

/** 线上消息对象里那个客户端铸造的提交身份（人发的消息才带）。 */
export function rpcIdOfMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const source = (value as { source?: unknown }).source;
  if (source === null || typeof source !== "object") return undefined;
  const wire = source as { kind?: unknown; rpcId?: unknown };
  // 人发消息的两种 source：`user`（其它客户端 / 旧版）与 `user-rpc`（带 rpcId 的提交）。
  if (wire.kind !== "user" && wire.kind !== "user-rpc") return undefined;
  return typeof wire.rpcId === "string" && wire.rpcId ? wire.rpcId : undefined;
}

/**
 * 一帧 `agent/inbox/spliced` 的 `data` → 归一化形状。
 *
 * `inserted` 原样保留（只保证是数组）：位次用条数、认身份读消息里的 rpcId。
 */
export function inboxSpliceOf(data: unknown): InboxSplice | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const wire = data as {
    target?: unknown;
    start?: unknown;
    removedCount?: unknown;
    inserted?: unknown;
    outcome?: unknown;
  };
  if (wire.target !== "next-turn" && wire.target !== "next-step") return undefined;
  if (typeof wire.start !== "number" || !Number.isFinite(wire.start)) return undefined;
  const removedCount =
    typeof wire.removedCount === "number" && Number.isFinite(wire.removedCount) ? wire.removedCount : 0;
  return {
    target: wire.target,
    start: Math.trunc(wire.start),
    removedCount: Math.max(0, Math.trunc(removedCount)),
    inserted: Array.isArray(wire.inserted) ? wire.inserted : [],
    canceled: wire.outcome === "canceled",
  };
}

/**
 * 这一帧入队的消息 → 记下（或推进）各自的位置。
 *
 * 只认带提交身份的人发消息：其余（注入类 `user/message`、上下文快照）没有可配对的回显。
 * 与 `noteInboxSplice` 的次序是**先平移、后插入**（官方的次序）：同一帧里既删又插时，
 * 插入项的位置才落在 `start` 上。
 */
export function noteInboxInserted(
  receipts: SubmissionReceipts,
  splice: InboxSplice,
  seq: number,
): void {
  for (const [offset, message] of splice.inserted.entries()) {
    const rpcId = rpcIdOfMessage(message);
    if (!rpcId) continue;
    const existing = receipts.get(rpcId);
    // 水位只许前进：更旧的帧（重连重放）不能把已经领取的那条顶回「还在排队」
    if (existing && existing.seq > seq) continue;
    receipts.set(rpcId, { target: splice.target, seq, index: splice.start + offset });
  }
}

/**
 * 一帧领取 / 取消 / 编辑 → 平移已记的位次；返回**被有意取消**的那些提交身份。
 *
 * 落在被移走区间内：取消帧 ⇒ 交给调用方按「用户丢掉了它」处理；其余（领取）⇒ 位次置
 * `null`，等 `turn/end` / `request/context` 上再判它落没落盘。区间之外的项按
 * `inserted.length - removedCount` 平移。
 *
 * 水位更旧（重放）或位次已经是 `null`（已领取）的项一律跳过——这就是幂等的来源。
 */
export function noteInboxSplice(
  receipts: SubmissionReceipts,
  splice: InboxSplice,
  seq: number,
): string[] {
  const canceled: string[] = [];
  for (const [rpcId, receipt] of [...receipts]) {
    if (receipt.target !== splice.target) continue;
    if (receipt.index === null || receipt.seq >= seq) continue;
    const removed = receipt.index >= splice.start && receipt.index < splice.start + splice.removedCount;
    if (removed && splice.canceled) {
      receipts.delete(rpcId);
      canceled.push(rpcId);
      continue;
    }
    receipts.set(rpcId, {
      ...receipt,
      seq,
      index: removed
        ? null
        : receipt.index < splice.start
          ? receipt.index
          : receipt.index + splice.inserted.length - splice.removedCount,
    });
  }
  return canceled;
}

/**
 * 这个轮次边界（`turn/end` / `request/context`）上，哪些提交**已经离开收件箱、却还没有
 * durable 承认** ⇒ 永远到不了 durable。
 *
 * 水位判据（`receipt.seq < seq`）保证只对**这一步之前**就完成领取的那些下结论：同一条流里
 * 领取帧必然在边界帧之前到达，反过来则不成立。
 *
 * @returns 这些提交身份；它们同时从账本里删掉（一条提交只下这一次结论）。
 */
export function takeLostSubmissions(receipts: SubmissionReceipts, seq: number): string[] {
  const lost: string[] = [];
  for (const [rpcId, receipt] of [...receipts]) {
    if (receipt.index !== null || receipt.seq >= seq) continue;
    receipts.delete(rpcId);
    lost.push(rpcId);
  }
  return lost;
}
