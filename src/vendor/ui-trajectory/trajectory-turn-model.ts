/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-trajectory`（`0.2.0-rc.2`，检出 tag
 * `dsh-v0.2.0-rc.2`）`src/client/layout.ts` 里的**账本结构类型摘录**。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 *
 * 为什么只有类型、没有实现：上游 `layout.ts`（41 KB）的输入是
 * `ui-conversation` 折出来的 `TrajectorySnapshot`，我们没有那一层，搬不动
 * （见 `docs/design-trajectory.md` 的「完美搬运的可行边界」）。但 vendor 进来的
 * `timeline.ts` / `trajectory-search-index.ts` 只依赖这两个接口——只读 `turn`、
 * `groups[].title` 与 `groups[].cells`——所以把它们逐字抄过来，让那两份 vendor
 * 文件保持原样；本扩展的 turn 结构由 `src/shared/trajectoryVendor.ts` 适配过去。
 *
 * 上游对应行：`layout.ts` 的 `TrajectoryGroupModel` / `TrajectoryTurnModel`。
 */

import type { TrajectoryCellProps } from './trajectory-record'

/** One Message or Step group inside a turn. */
export interface TrajectoryGroupModel {
  title: string
  description?: string
  cells: readonly TrajectoryCellProps[]
}

/** One sticky turn, or a standalone compaction section between turns. */
export interface TrajectoryTurnModel {
  turn: number | null
  groups: readonly TrajectoryGroupModel[]
}
