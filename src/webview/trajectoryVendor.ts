/**
 * **本扩展的账本 → vendor 的官方形状**的适配层（唯一一处）。
 *
 * vendor 进来的三份纯决策模块（`timeline` / `trajectory-search-index` /
 * `trajectory-record`）吃的是官方那份 `TrajectoryCellProps` 与 `TrajectoryTurnModel`；
 * 我们的折叠层（`src/dsh/trajectory.ts`）产出的是自己的 `TrajectoryCell` /
 * `TrajectoryTurn`（字段是官方语义的**子集**，另加两个宿主侧语义标记
 * `emptySummary` / `promptChange`）。把差异集中在这一层，vendor 文件才能保持逐字副本，
 * 上游升级时 diff 才干净——**不要**在 vendor 文件里加分支。
 *
 * ## 已知的「喂不满」（都是差距清单里的条目，不是这里写错了）
 *
 * - `outputBlocks`：宿主还没采集。2026-10-04 量过真实日志后判断**不必采**：官方三处
 *   `outputBlocks`（工具结果 35437 处、压缩摘要 8 处、助手消息）里，工具结果那部分的
 *   内容就是内层 text 块的原文（`tool-result` 信封再套一层 JSON），而那份原文已经原样在
 *   `outputDetail` / `resultPreviewMarkdown` 里、搜索面早就有它——再采一遍等于把同一份
 *   结果文本存两份（实测 35k 块、7400 万字符）。详细核算见 `docs/design-trajectory.md`
 *   的「搜索」那条。
 * - `promptDetail` / `previousPromptDetail`：**已经在喂**（`promptSnapshot()` 把
 *   `systemPromptDetail` + `toolsDetail` 合成官方那个 `{system, tools}` 快照）。
 *   官方那份多带一个 `config`，但 `config` 的四个键（provider / model /
 *   reasoningEffort / maxTokens）已经在 `provider` / `model` 两个散字段里，搜索面上没有增量。
 */

import { trajectoryRecordId } from "../vendor/ui-trajectory/trajectory-record";
import type { TrajectoryCellProps } from "../vendor/ui-trajectory/trajectory-record";
import type { TrajectoryTurnModel } from "../vendor/ui-trajectory/trajectory-turn-model";
import type { TrajectoryCell, TrajectoryGroupTitle, TrajectoryTurn } from "../shared/trajectory";

/**
 * 不给组标题的消费方（时间线只读 `groups[].cells`）用的空串。
 *
 * 官方 `group.message` / `group.step` / `group.compaction` 是本地化文案，所以真正的
 * 标题由调用方经 `titleOf` 交进来；`titleOf` 缺席时就是这个空串。
 */
export const NO_GROUP_TITLE = "";

/**
 * 我们的记录 → 官方 `TrajectoryCellProps`。
 *
 * 逐字段对齐（只列**名字不同**的那几个，其余同名直传）：
 *
 * | 我们 | 官方 | 说明 |
 * |---|---|---|
 * | `seq` | `sourceSeq` | 官方用它做跨记录定位与 `recordId` 回退链的二级身份 |
 * | `messageSource` | `messageSource` | 官方原样 JSON 化后进搜索索引 |
 * | `systemPromptDetail` + `toolsDetail` | `promptDetail` | 官方那是一个 `{system, tools}` 快照 |
 * | `previousSystemPromptDetail` | `previousPromptDetail` | 同上，被替换前的那一份 |
 *
 * 我们多出来的 `emptySummary` / `promptChange` / `status` / `error` / `retry` 等
 * 是**宿主侧的语义标记与视图事实**，官方那边由布局层直接写成本地化文案，
 * 因此不进这一层（界面侧自己取，见 `trajectoryDisplay.ts`）。
 *
 * @param cell - 本扩展折叠层产出的一条记录。
 * @returns 官方形状的记录（同名字段直传）。
 */
export function vendorCell(cell: TrajectoryCell): TrajectoryCellProps {
  const prompt = promptSnapshot(cell);
  const previousPrompt = previousPromptSnapshot(cell);
  return {
    index: cell.index,
    kind: cell.kind,
    text: cell.text,
    ...(cell.previewMarkdown === undefined ? {} : { previewMarkdown: cell.previewMarkdown }),
    ...(cell.opensTurn === undefined ? {} : { opensTurn: cell.opensTurn }),
    sourceSeq: cell.seq,
    ...(cell.messageSource === undefined ? {} : { messageSource: cell.messageSource }),
    ...(cell.requestOnly === undefined ? {} : { requestOnly: cell.requestOnly }),
    ...(cell.inputDetail === undefined ? {} : { inputDetail: cell.inputDetail }),
    ...(prompt === undefined ? {} : { promptDetail: prompt }),
    ...(cell.systemPromptDetail === undefined
      ? {}
      : { systemPromptDetail: cell.systemPromptDetail }),
    ...(previousPrompt === undefined ? {} : { previousPromptDetail: previousPrompt }),
    ...(cell.outputDetail === undefined ? {} : { outputDetail: cell.outputDetail }),
    ...(cell.thinkingDetail === undefined ? {} : { thinkingDetail: cell.thinkingDetail }),
    ...(cell.assistantMetrics === undefined ? {} : { assistantMetrics: cell.assistantMetrics }),
    ...(cell.sourceBlocks === undefined ? {} : { sourceBlocks: cell.sourceBlocks }),
    ...(cell.schemaDetail === undefined ? {} : { schemaDetail: cell.schemaDetail }),
    ...(cell.result === undefined ? {} : { result: cell.result }),
    ...(cell.resultPreviewMarkdown === undefined
      ? {}
      : { resultPreviewMarkdown: cell.resultPreviewMarkdown }),
    ...(cell.callId === undefined ? {} : { callId: cell.callId }),
    ...(cell.toolName === undefined ? {} : { toolName: cell.toolName }),
    ...(cell.isError === undefined ? {} : { isError: cell.isError }),
    timeSeconds: cell.timeSeconds,
    startedAt: cell.startedAt,
    ...(cell.usage?.input === undefined ? {} : { input: cell.usage.input }),
    ...(cell.usage?.cacheRead === undefined ? {} : { cacheRead: cell.usage.cacheRead }),
    ...(cell.usage?.cacheWrite === undefined ? {} : { cacheWrite: cell.usage.cacheWrite }),
    ...(cell.usage?.output === undefined ? {} : { output: cell.usage.output }),
    ...(cell.usage?.think === undefined ? {} : { think: cell.usage.think }),
  };
}

/** 系统行的 `{system, tools}` 快照（官方 `ConversationPromptSnapshot` 的结构子集）。 */
function promptSnapshot(cell: TrajectoryCell): TrajectoryCellProps["promptDetail"] {
  if (cell.systemPromptDetail === undefined && cell.toolsDetail === undefined) return undefined;
  return {
    ...(cell.systemPromptDetail === undefined ? {} : { system: cell.systemPromptDetail }),
    ...(cell.toolsDetail === undefined ? {} : { tools: cell.toolsDetail }),
  };
}

/** 被替换前的那一份快照（官方 `previousPromptDetail`）。 */
function previousPromptSnapshot(cell: TrajectoryCell): TrajectoryCellProps["previousPromptDetail"] {
  if (cell.previousSystemPromptDetail === undefined && cell.previousPromptTools === undefined) {
    return undefined;
  }
  return {
    ...(cell.previousSystemPromptDetail === undefined
      ? {}
      : { system: cell.previousSystemPromptDetail }),
    // 官方那个快照带 `{system, tools}` 两项；宿主把工具那一半单独存（`TrajectoryCell` 的
    // `previousPromptTools`，不是官方字段），在这里合成官方形状。**合成必须留着**：
    // 删掉它，「对照」页签的工具目录那一节会静默变空（vendor 的搜索索引也吃不到那一半）。
    ...(cell.previousPromptTools === undefined ? {} : { tools: cell.previousPromptTools }),
  };
}

/**
 * 我们的账本 → 官方的 `TrajectoryTurnModel[]`。
 *
 * 组结构与折叠层一一对应（组标题在宿主侧是**语义**、官方那边是**本地化文案**，
 * 所以由调用方把 `titleOf` 交进来——搜索索引要的是文案，时间线完全用不到标题）。
 *
 * @param turns - 折叠层产出的轮次列表。
 * @param titleOf - 组标题语义 → 当前语言的文案（默认空串：给不看标题的消费方用）。
 * @returns vendor 模块直接可吃的形状。
 */
export function vendorTurns(
  turns: readonly TrajectoryTurn[],
  titleOf: (title: TrajectoryGroupTitle) => string = () => NO_GROUP_TITLE,
): TrajectoryTurnModel[] {
  return turns.map((turn) => ({
    turn: turn.turn,
    groups: turn.groups.map((group) => ({
      title: titleOf(group.title),
      cells: group.cells.map(vendorCell),
    })),
  }));
}

/**
 * 一条记录在**前插历史之后仍然稳定**的身份（官方 `trajectoryRecordId`）。
 *
 * 这是「调用折叠」状态键的正确取值：用 `cell.index` 时，往前加载一页历史会让所有
 * 编号整体平移，已经折叠的调用会串到别的行上（官方用事件身份，不用序号）。
 *
 * @param cell - 本扩展折叠层产出的一条记录。
 * @returns 稳定身份串。
 */
export function trajectoryCellRecordId(cell: TrajectoryCell): string {
  return trajectoryRecordId(vendorCell(cell));
}
