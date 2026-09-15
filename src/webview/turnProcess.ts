import type { Segment } from "../shared/chat";
import { isSubagentDelegationTool } from "../shared/toolMeta";

/**
 * 轮级过程折叠——官方默认的 compact 转写模式（`DEFAULT_TRANSCRIPT_VIEW_MODE =
 * "compact"`，`dsh-client-ui-chat/lib/client.js`）。
 *
 * ## 本扩展的口径：**只折机器噪声，正文永不折**
 *
 * 折叠成员只有三类：`thinking`、`tool`、以及**非 system 的 `injected`**
 * （插件注入 / 项目指令 / 技能目录 / 运行时上下文）。**助手正文一律留在流里**，
 * 包括过程中途那些说明性的话（"Now let me implement item 9…" 这类）。理由：
 *
 * 1. 折叠的目的是压掉机器噪声；正文是模型特意写给用户看的内容，折起来就是信息损失
 *    （用户 2026-09-16 报：「中间的长消息也会被折叠掉，容易被忽略」）。
 * 2. **免阈值**：「多长算长」是会漂的判据（239 字的重要说明和 240 字的长旁白没区别），
 *    而「是不是正文」是硬的。
 * 3. **不依赖 `step`**：官方的边界靠「答案步」，那要求历史里有 `step/start`；按性质
 *    分派之后，缺 step 的历史窗口同样折得对（此前只能整轮平铺）。
 *
 * ## 与官方的**有意**差异
 *
 * 官方把「最后一个定稿答案步」之前的**所有**节点都折起来，**中间正文也算成员**，
 * 于是按钮读「N 次工具调用 · M 条消息 · K 个 subagent」（`processSpec` 的
 * `answerAnchorSeq` / `messageCount`，见 client.js:6756-6786、1555-1557）。我们保留
 * 它的计数与豁免口径，只把**正文**移出成员集合，按钮因此只报「N 次工具调用 ·
 * K 个 subagent」。两个副作用都是想要的：
 *
 * - 中途正文（可能很长）永远不会被藏起来；
 * - 「边界之后的过程没人回收」这类缺口不存在了——官方在尾步不是答案时整轮不折，
 *   而按性质分派没有边界，被中断轮尾部的工具行照样折进按钮（用户 2026-09-16 报的
 *   「大量工具没有折叠进去」）。
 *
 * ## 保留的官方口径
 *
 * - **流式期间不折**（官方 `turnClosed`）：成员还在长，折了会闪。
 * - **豁免**（官方 `TURN_PROCESS_INDEPENDENT_KINDS` 里对得上的那几类）：中止 / 截断 /
 *   失败提示（`notice`）与**系统提示词**（`injected` 且 `sourceKind === "system"`）
 *   永不折——把「回答被截断了」折进按钮是绝不能接受的信息损失。其余上下文注入照折
 *   （官方那个集合里没有 context 一类）。
 * - 子代理派发单独计数（官方 `isSubagentDelegationTool`）。
 *
 * 纯函数、不引 React：断言见 `scripts/turnProcess.test.ts`。
 */

/**
 * 这一段算不算机器噪声（= 折叠成员）。
 *
 * 判据是**段的性质**，不是它在轮里的位置：正文 / 提示 / 交互卡 / 图片 / 命令行
 * 一律留在流里（折起一张问卷卡或一条失败提示都是信息损失）。
 */
function isNoise(segment: Segment): boolean {
  if (segment.kind === "thinking" || segment.kind === "tool") return true;
  if (segment.kind === "injected") return segment.injected.sourceKind !== "system";
  return false;
}

export interface TurnProcessCounts {
  toolCalls: number;
  subagents: number;
}

export interface TurnProcessFold {
  /** 留在流里的段（正文、提示、交互卡…按原序）。 */
  visible: Segment[];
  /** 折进按钮的成员（展开后按原顺序插回流里的位置）。 */
  folded: Segment[];
  counts: TurnProcessCounts;
  /** 是否有可折的东西（false 时界面按原样平铺，不画按钮）。 */
  foldable: boolean;
}

/** 没什么可折：原样返回。 */
function noFold(segments: readonly Segment[]): TurnProcessFold {
  return {
    visible: [...segments],
    folded: [],
    counts: { toolCalls: 0, subagents: 0 },
    foldable: false,
  };
}

/**
 * 一轮的显示段 → 「哪些折起来、哪些留着」。
 *
 * @param segments 该轮助手消息的全部显示段（按到达顺序）。
 * @param closed 这一轮是否已结束（官方只在 `turnClosed` 时折叠；流式期间不折）。
 */
export function foldTurnProcess(
  segments: readonly Segment[],
  closed: boolean,
): TurnProcessFold {
  if (!closed) return noFold(segments);

  const visible: Segment[] = [];
  const folded: Segment[] = [];
  const counts: TurnProcessCounts = { toolCalls: 0, subagents: 0 };

  for (const segment of segments) {
    if (!isNoise(segment)) {
      visible.push(segment);
      continue;
    }
    folded.push(segment);
    countInto(counts, segment);
  }

  if (!folded.length) return noFold(segments);
  return { visible, folded, counts, foldable: true };
}

function countInto(counts: TurnProcessCounts, segment: Segment): void {
  if (segment.kind !== "tool") return;
  // 子代理派发单独计数（官方 `isSubagentDelegationTool`）
  if (isSubagentDelegationTool(segment.tool.name)) counts.subagents += 1;
  else counts.toolCalls += 1;
}
