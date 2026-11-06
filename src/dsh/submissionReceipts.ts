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
 * ## 两条兜底（与官方 `observeSubmissionInbox` / `replaceWindow` 同口径）
 *
 * durable splice 可能恰好落在掉线窗口里，所以回执还有两条**更低水位**的来源：
 *
 * - **`inbox` 投影**：每个会话的 `inbox` 值就是 Host 当前完整的两条待发队列，投影自带
 *   水位（`seqOf('inbox')`，官方 `ProjectionValueStore` 的 cached 值没有水位）。它能把
 *   「入队 splice 没收到」的那条补回来；**只按存在补位**，绝不从「投影里没有它」反推
 *   领取或取消——取消有 durable `outcome:'canceled'`，反推会把用户取消的提交误判成丢失。
 * - **跟随开窗快照**：`projections.asOfSeq` 是这次开窗覆盖到的日志截点。**截点之前**已经
 *   有回执的提交，Host 已经持有（官方 `replaceWindow` 把它们按 `observed` 退回显），不是
 *   「快照清空即丢失」；即便它仍排在收件箱里、或已被领取但还没落盘，也不能在重连时改判成
 *   失败。缺水位（`undefined` / 非数）时一律不初始化、不推断。
 *
 * 两条纪律让重连重放同一批事件保持幂等：位次只随**带水位**的 splice / 投影平移，水位只许
 * 前进（旧帧、重放帧一律不倒退）。投影缺位或掉线只会漏判，不会误判。
 *
 * ## 身份与「已承认、等水位」
 *
 * - 收件箱是服务端共享的：只有**本客户端铸的 rpcId** 才进这本账（调用方用 `accept`
 *   传身份边界）。别的窗口 / 客户端的待发消息不该让本客户端弹失败、也不该回填草稿。
 * - durable `user/message` 先到、`inbox` 投影还没确认领取时，回执标 `admitted` 留在账本里
 *   等水位（官方 `retireAdmittedSubmission`）：它不再参与失败判定，但收显要等投影追上
 *   `seq`——否则队列里的旧行会在收显之后又出现一次。
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
  /**
   * 已经收到 durable `user/message`，正在等 `inbox` 投影追上领取水位（官方
   * `retireAdmittedSubmission` 的延迟收显）。
   *
   * 这种回执**不再参与失败判定**：它已经是历史了，只是本地回显要等队列投影确认
   * 那条旧行不会再出现。投影推进到 `seq` 之后由适配器交给控制器收显。
   */
  readonly admitted?: true;
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

/** `inbox` 投影里的两条队列，顺序固定（官方 `InboxState` 的键）。 */
const INBOX_TARGETS: readonly InboxTarget[] = ["next-turn", "next-step"];

/** 投影里一条带提交身份的人发消息：目标队列 + 位次 + rpcId。 */
interface InboxProjectionPosition {
  readonly target: InboxTarget;
  readonly rpcId: string;
  readonly index: number;
}

/**
 * `inbox` 投影 → 其中**带提交身份**的消息位次。
 *
 * 形状不认识（不是对象 / 某个队列不是数组）时该队列按空处理——少补几条只会漏判，
 * 不能凭猜把插件注入的环境上下文当成用户提交。
 */
function inboxProjectionPositions(value: unknown): InboxProjectionPosition[] {
  if (value === null || typeof value !== "object") return [];
  const inbox = value as Record<string, unknown>;
  const positions: InboxProjectionPosition[] = [];
  for (const target of INBOX_TARGETS) {
    const messages = inbox[target];
    if (!Array.isArray(messages)) continue;
    for (const [index, message] of messages.entries()) {
      const rpcId = rpcIdOfMessage(message);
      if (rpcId) positions.push({ target, rpcId, index });
    }
  }
  return positions;
}

/**
 * 用一帧 `inbox` 投影补回执（官方 `observeSubmissionInbox` 的初始化口径）。
 *
 * - 投影里**存在**的提交：补一条回执，或把它推进到投影水位与当前位次；这样即使入队
 *   splice 掉线，后面的领取帧与轮次边界仍能按同一套数学收场。
 * - 投影里**不存在**的提交：什么都不做。领取 / 取消只认 durable splice——从「不在队列里」
 *   反推会把有意取消的提交误判成失败。
 * - `seq` 不是有限数（cached 值 / 控制流没带水位）时整帧跳过：没有水位就无法与已有回执
 *   比新旧，凭猜写入会顶掉已有的准确位次。
 * - 水位只许前进：比已记水位更旧的投影不覆盖。
 *
 * @param skip 本次**不要**补的 rpcId（例如刚按开窗截点判为 Host 已持有、或窗口里已经
 *   落盘承认的那些）。
 * @param accept 这个 rpcId 要不要记（身份边界：只认本客户端铸的提交；别的窗口 / 客户端
 *   的待发消息同样会出现在共享收件箱里，但它们的失败不该由本客户端收场）。
 * @returns 实际被这帧投影覆盖到的提交身份（供调用方判断「它们已经在 Host 的队列里」，
 *   与 durable 承认是两件事）。
 */
export function noteInboxProjection(
  receipts: SubmissionReceipts,
  value: unknown,
  seq: number | undefined,
  skip?: ReadonlySet<string>,
  accept?: (rpcId: string) => boolean,
): string[] {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return [];
  const touched: string[] = [];
  for (const { target, rpcId, index } of inboxProjectionPositions(value)) {
    if (skip?.has(rpcId)) continue;
    if (accept && !accept(rpcId)) continue;
    const existing = receipts.get(rpcId);
    if (existing && existing.seq > seq) continue;
    receipts.set(rpcId, {
      target,
      seq,
      index,
      ...(existing?.admitted === true ? { admitted: true as const } : {}),
    });
    touched.push(rpcId);
  }
  return [...new Set(touched)];
}

/**
 * 开窗快照的截点之前已经存在的回执 → **Host 已持有**（官方 `replaceWindow` 的
 * `observed` 退回显，不是失败）。
 *
 * 判据是回执自己的水位，不是「快照里有没有这条 durable 行」：那条行可能落在窗口外，
 * 也可能刚被领取还没落盘。把它们从账本里摘掉并交给调用方收显；同一个截点重复调用
 * 返回空表（幂等）。
 *
 * @param cut 跟随开帧 `projections.asOfSeq`；不是有限数时不做任何判断。
 */
export function takeObservedSubmissions(receipts: SubmissionReceipts, cut: number | undefined): string[] {
  if (typeof cut !== "number" || !Number.isFinite(cut)) return [];
  const observed: string[] = [];
  for (const [rpcId, receipt] of [...receipts]) {
    if (receipt.seq > cut) continue;
    receipts.delete(rpcId);
    observed.push(rpcId);
  }
  return observed;
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
  accept?: (rpcId: string) => boolean,
): void {
  for (const [offset, message] of splice.inserted.entries()) {
    const rpcId = rpcIdOfMessage(message);
    if (!rpcId) continue;
    if (accept && !accept(rpcId)) continue;
    const existing = receipts.get(rpcId);
    // 水位只许前进：更旧的帧（重连重放）不能把已经领取的那条顶回「还在排队」
    if (existing && existing.seq > seq) continue;
    receipts.set(rpcId, {
      target: splice.target,
      seq,
      index: splice.start + offset,
      ...(existing?.admitted === true ? { admitted: true as const } : {}),
    });
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
    // 已经 durable 承认的回执只是在等投影水位：领取 / 取消 / 编辑都不再改变它的收场
    if (receipt.admitted === true) continue;
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
    if (receipt.admitted === true) continue;
    if (receipt.index !== null || receipt.seq >= seq) continue;
    receipts.delete(rpcId);
    lost.push(rpcId);
  }
  return lost;
}
