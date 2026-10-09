/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-trajectory`（`0.2.0-rc.2`，检出 tag
 * `dsh-v0.2.0-rc.2`）`src/client/trajectory-message-definitions.ts` 里
 * **`trajectory-inbox-next-step` 那台纯状态机**的逐字副本。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 *
 * 为什么它能搬：这台状态机**只吃 durable 事件**（`agent/inbox/spliced` 与随后的
 * `user/message`），不碰 `TrajectorySnapshot` 那一层——正是「完美搬运的可行边界」里
 * 说的那种纯决策。上游把它写在 definition 的 `start()` 里，这里把 `start()` 的
 * 三行调用原样拆出来成为 `applySplice()`。
 *
 * 上游对应行：`trajectory-message-definitions.ts` 的 `InboxIdentity` /
 * `InboxSplice` / `PendingSnapshot` / `PendingSplice` / `PendingState` / `InboxState` /
 * `EMPTY_PENDING` / `EMPTY_CURRENT_CLAIMED` / `materializePending` /
 * `withoutInserted` / `applySplice`。
 *
 * ## 本仓库允许的偏差（只有这一处，语义逐字相同）
 *
 * 上游 `applySplice()` 的第一个参数类型是 `ConversationPreviousContext<InboxState> | undefined`
 * （它拿的是「上一个同名节点的状态」）。本扩展没有节点装配层，调用方直接持有上一次的
 * `InboxState`，所以这里换成 `InboxState | undefined`——上游函数体只用到
 * `previous?.state`，换成本地声明后**逐字**等价。
 */

/** One inbox message identity as it appears inside a splice frame. */
export interface InboxIdentity {
  readonly id: string
}

/** One durable `agent/inbox/spliced` payload for `target === 'next-step'`. */
export interface InboxSplice {
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: 'canceled'
}

interface PendingSnapshot {
  readonly kind: 'snapshot'
  readonly ids: readonly string[]
}

interface PendingSplice {
  readonly kind: 'splice'
  readonly previous: PendingState
  readonly start: number
  readonly removedCount: number
  readonly inserted: readonly string[]
}

type PendingState = PendingSnapshot | PendingSplice

export interface InboxState {
  /** Persistent splice chain materialized only when a next-step batch is claimed. */
  readonly pending: PendingState
  /** Message ids in the current claim, shared until the next claim. */
  readonly currentClaimed: ReadonlySet<string>
}

const EMPTY_PENDING: PendingState = { kind: 'snapshot', ids: [] }
const EMPTY_CURRENT_CLAIMED: ReadonlySet<string> = new Set()

function materializePending(state: PendingState): string[] {
  const splices: PendingSplice[] = []
  let current = state
  while (current.kind === 'splice') {
    splices.push(current)
    current = current.previous
  }
  const pending = [...current.ids]
  for (const splice of splices.reverse()) {
    pending.splice(splice.start, splice.removedCount, ...splice.inserted)
  }
  return pending
}

function withoutInserted(
  claimed: ReadonlySet<string>,
  inserted: readonly string[],
): ReadonlySet<string> {
  let next: Set<string> | undefined
  for (const id of inserted) {
    if (!claimed.has(id)) continue
    next ??= new Set(claimed)
    next.delete(id)
  }
  return next ?? claimed
}

/**
 * Apply one next-step splice under the AgentLoop's durable event ordering.
 * An entered claim logs its complete message batch before another claim; a
 * rejected claim logs no messages, so only the current claim can classify a
 * later `user/message`.
 *
 * @param previous - state after the previous next-step splice, if any.
 * @param splice - the durable `agent/inbox/spliced` payload.
 * @returns the state used to classify later `user/message` events.
 */
export function applySplice(
  previous: InboxState | undefined,
  splice: InboxSplice,
): InboxState {
  const priorPending = previous?.pending ?? EMPTY_PENDING
  const inserted = splice.inserted.map(identity => identity.id)
  const removedCount = splice.removedCount ?? 0
  if (removedCount > 0 && splice.outcome !== 'canceled') {
    const pending = materializePending(priorPending)
    const removed = pending.splice(splice.start, removedCount, ...inserted)
    return {
      pending: { kind: 'snapshot', ids: pending },
      currentClaimed: new Set(removed),
    }
  }
  const currentClaimed = withoutInserted(
    previous?.currentClaimed ?? EMPTY_CURRENT_CLAIMED,
    inserted,
  )
  return {
    pending: {
      kind: 'splice',
      previous: priorPending,
      start: splice.start,
      removedCount,
      inserted,
    },
    currentClaimed,
  }
}
