/**
 * next-step inbox 的**领取账本**：判定一条人发消息是「开启本轮的提问」还是
 * 「生成中插话」。
 *
 * 判据与官方**只有一条**（`@deepseek-ai/dsh-client-ui-chat` 的
 * `conversation-nodes/message.ts`，`input-message` 的 `match`/`start`）：
 * `user/message` 的 id 落在 `inbox-next-step` 状态机的**本次领取**
 * （`InboxState.currentClaimed`）里 ⇒ 这条消息是被 splice 进还在跑的那一轮的
 * 引导消息（官方 `kind: 'steering'`）；不落在里面 ⇒ 它是开启本轮的提问。
 * 状态机逐字 vendor 在 `src/vendor/ui-trajectory/inbox-state.ts`（轨迹那边
 * 已经在用同一台，两处口径必须同源）。
 *
 * **为什么不能按「紧邻助手消息的前一条是不是用户消息」猜**（本仓库 2026-09-12 的
 * 旧启发式）：子代理 / 队列驱动的会话里，一轮常常**没有人发消息开启**——
 * `agent-message`、`subagent-settled`、`tool-jobs` 这些注入与队列派发都能开一轮，
 * 于是那个前提不成立，插话被当成「迟到的提问」插到本轮顶部（用户 2026-10-11 报的
 * 「用户消息发送错位」即此）。判据换成官方那台状态机之后，只有**真的没被领取**的
 * 消息才走「迟到提问」那条路。
 *
 * 只读 durable 事件（`agent/inbox/spliced` 与其后的 `user/message`），不碰任何
 * 界面状态，可离线断言。
 */
import {
  applySplice,
  type InboxIdentity,
  type InboxSplice,
  type InboxState,
} from "../vendor/ui-trajectory/inbox-state";

export type { InboxState };

/**
 * 顶层的 `agent/inbox/spliced` payload → 官方状态机的入参。
 *
 * **只认 `target === 'next-step'`**：两类帧的 `start` / `removedCount` 共用同一个
 * 队列索引空间，把 `next-turn` 也喂进这台状态机会把大量普通排队消息误判成插话——
 * 实测本机 442 份日志，只吃 next-step 时人发消息里 9.2% 判成插话，连 next-turn
 * 一起吃会变成 85%，显然不是官方语义。
 *
 * `inserted` 元素实测全部带 string `id`；畸形元素**保留槽位**——位次就是语义
 * （`materializePending()` 按 `start` 做 `splice`），丢掉会让后面的位次整体前移，
 * 占位用空串（它不可能与真实的 uuid 撞上）。
 *
 * @param data - `agent/inbox/spliced` 的 `data`（不受信任的线上值）。
 * @returns 状态机入参；不是 next-step、或形状不可用（没有数字 `start`）时
 *   `undefined`（调用方保持原状态，不猜）。
 */
export function nextStepSpliceOf(data: unknown): InboxSplice | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const wire = data as {
    target?: unknown;
    start?: unknown;
    removedCount?: unknown;
    inserted?: unknown;
    outcome?: unknown;
  };
  if (wire.target !== "next-step") return undefined;
  if (typeof wire.start !== "number") return undefined;
  const inserted: InboxIdentity[] = (Array.isArray(wire.inserted) ? wire.inserted : []).map((identity) => {
    const id =
      identity !== null && typeof identity === "object" ? (identity as { id?: unknown }).id : undefined;
    return { id: typeof id === "string" ? id : "" };
  });
  return {
    start: wire.start,
    ...(typeof wire.removedCount === "number" ? { removedCount: wire.removedCount } : {}),
    inserted,
    ...(wire.outcome === "canceled" ? { outcome: "canceled" as const } : {}),
  };
}

/**
 * 吃下一条 `agent/inbox/spliced`，返回新的领取账本。
 *
 * @param state - 上一条 splice 之后的状态（调用方持有）。
 * @param data - 这一帧的 `data`。
 * @returns 新状态；这一帧与 next-step 无关时**原样返回** `state`（不是清空）。
 */
export function applyNextStepSplice(state: InboxState | undefined, data: unknown): InboxState | undefined {
  const splice = nextStepSpliceOf(data);
  return splice === undefined ? state : applySplice(state, splice);
}

/**
 * 这条消息 id 是不是 next-step 的**本次领取**（＝生成中插话）。
 *
 * `id` 不是字符串时一律**不算**（与轨迹侧 `dsh/trajectory.ts` 的判据同形）：
 * 官方那侧写的是 `currentClaimed.has(String(event.data.id))`，把缺失的 id 变成
 * 字符串 `"undefined"` 去查表；本扩展不复制那个兜底——收不到 id 时按「不是插话」
 * 处理，最多是一次落位保守，不会把正常提问切进轮中间。
 */
export function claimedByNextStep(state: InboxState | undefined, id: unknown): boolean {
  return state !== undefined && typeof id === "string" && state.currentClaimed.has(id);
}
