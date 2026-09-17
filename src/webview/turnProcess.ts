import type { Segment } from "../shared/chat";
import { effectiveFoldThreshold } from "../shared/turnProcessThreshold";
import { isSubagentDelegationTool } from "../shared/toolMeta";

/**
 * 连续过程折叠——一轮里**只留最后那段正文**，其余全折进按钮。
 *
 * ## 唯一留下的是「最后一段正文」（用户 2026-09-16 拍板，两轮收敛）
 *
 * 折叠一开始是「整轮一枚按钮」（0513070）：噪声全藏起来，留在流里的中途正文彼此贴到
 * 一起，看起来像被并进了最后那段回答（用户报「中间的 agent 消息会被塞进回答正文」）。
 * 中间试过「正文是边界、按连续段各折一枚」——穿插关系对了，但一轮变成「正文／按钮／
 * 正文／按钮」交替，读起来又碎。用户最终的判断是：**中途那些话大多是进度叙述，真有价值
 * 的信息会在最终回答里复述**；要保证的只有一件事——**用户读的那段回答留在流里**。
 *
 * 所以口径收敛成一条：
 *
 * - **边界 = 本轮最后一段 `text`**。哪怕它出现在中途（被中断 / 报错的轮没有最终回答，
 *   那时的「最后一段正文」就是模型留下的最后的话），它也必须留在流里。
 * - **其余一切都是成员**：中途正文、思考、工具、subagent、上下文注入（含系统提示词）、
 *   轮级提示（已停止 / 被截断 / 重试）、交互卡、命令节点、图片块、未知内容块。
 * - 边界把这把刀切成**前后两段**，每段按**段内工具调用次数**判阈值
 *   （配置项 `dshChat.turnProcessThreshold`，默认 5；`0` 永不折、`1–2` 永远折
 *   但只有一次工具调用的段照旧平铺，语义见 `shared/turnProcessThreshold.ts`）。
 *
 * 于是折完读作「按钮 → 回答」（尾段够长时后面再跟一枚按钮）：中途正文要么在按钮里、
 * 要么整轮平铺，不会再有「两段不相邻的话被并成一段」的错觉。
 *
 * **失败原因不受影响**：它是 `message.error`（含 `@interrupted`），由消息尾部的
 * NoticeRow 单独渲染，本来就不在段集合里。
 *
 * 分段不看 `step`（历史里缺 `step/start` 时同样折得对），流式期间不折。纯函数、
 * 不引 React：断言见 `scripts/turnProcess.test.ts`。
 */

/**
 * 折叠阈值（配置项 `dshChat.turnProcessThreshold`，默认 5）→ 实际生效值的换算
 * 在 `shared/turnProcessThreshold.ts`（0 = 永不折；1–2 = 永远折，但只有 1 次工具
 * 调用的段落地为不折）。这里只消费换算结果。
 */

/**
 * 本轮最后一段正文的下标（`-1` = 整轮没有正文）。
 *
 * 找不到正文时**没有任何边界**：整轮合成一段——这正是想要的（没有回答可读的轮，
 * 折叠按钮就是它的全部）。
 */
function lastTextIndex(segments: readonly Segment[]): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].kind === "text") return index;
  }
  return -1;
}

export interface TurnProcessCounts {
  toolCalls: number;
  /** 折进去的**中途消息**（正文段）条数——按钮文案的第二段（官方 `messageCount`）。 */
  messages: number;
  subagents: number;
}

/** 一段连续过程：折成一枚按钮的那些段。 */
export interface TurnProcessRun {
  /**
   * 按钮的锚点 = 这段的**首段 id**。
   *
   * 按钮画在流里这个位置（展开后成员从这里铺回去），同时它也是 React key 与界面
   * 展开状态的键：段的 id 在轮内唯一且稳定，不必再造一套编号。
   */
  anchorId: string;
  /** 折进这一枚按钮的段（按原序）。 */
  segments: readonly Segment[];
  /** 这一段的计数（按钮文案用）。 */
  counts: TurnProcessCounts;
}

export interface TurnProcessFold {
  /** 可折的段（按出现顺序，最多两段：最后那段正文之前 / 之后）。没折的段不在这里。 */
  runs: readonly TurnProcessRun[];
  /** 段 id → 它所属的可折段；查不到 = 这一段留在流里。 */
  bySegment: ReadonlyMap<string, TurnProcessRun>;
}

const NOTHING: TurnProcessFold = { runs: [], bySegment: new Map() };

/** 一段过程从零开始计数（三段：工具调用 / 中途消息 / subagent，官方口径）。 */
function emptyCounts(): TurnProcessCounts {
  return { toolCalls: 0, messages: 0, subagents: 0 };
}

/**
 * 一轮的显示段 → 「哪几段折起来、各自折成一枚按钮」。
 *
 * @param segments 该轮助手消息的全部显示段（按到达顺序）。
 * @param closed 这一轮是否已结束（流式期间**不折**：成员还在长，折了会闪）。
 * @param threshold 配置阈值（`dshChat.turnProcessThreshold`）。缺省/首帧未到时
 *   用默认 5；归一化与特殊值语义见 `shared/turnProcessThreshold.ts`。
 */
export function foldTurnProcess(
  segments: readonly Segment[],
  closed: boolean,
  threshold?: number,
): TurnProcessFold {
  if (!closed) return NOTHING;
  const at = effectiveFoldThreshold(threshold);
  const keep = lastTextIndex(segments);

  const runs: TurnProcessRun[] = [];
  const bySegment = new Map<string, TurnProcessRun>();
  /** 正在积累的这一段（遇到最后那段正文就结算）。 */
  let pending: Segment[] = [];
  let counts: TurnProcessCounts = emptyCounts();

  const settle = () => {
    if (!pending.length) return;
    // subagent 派发也是工具调用：一样算进阈值（只在按钮文案里分开报）
    if (counts.toolCalls + counts.subagents >= at) {
      const run: TurnProcessRun = { anchorId: pending[0].id, segments: pending, counts };
      runs.push(run);
      for (const segment of pending) bySegment.set(segment.id, run);
    }
    pending = [];
    counts = emptyCounts();
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    // 唯一留在流里的段：本轮最后那段正文
    if (index === keep) {
      settle();
      continue;
    }
    pending.push(segment);
    countInto(counts, segment);
  }
  settle();

  return { runs, bySegment };
}

function countInto(counts: TurnProcessCounts, segment: Segment): void {
  if (segment.kind === "text") {
    // 中途消息（最后那段正文是边界、不进成员，所以这里数到的都是「折起来的过程话」）
    counts.messages += 1;
    return;
  }
  if (segment.kind !== "tool") return;
  // 子代理派发单独计数（官方 `isSubagentDelegationTool`）
  if (isSubagentDelegationTool(segment.tool.name)) counts.subagents += 1;
  else counts.toolCalls += 1;
}
