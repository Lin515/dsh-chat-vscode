import type { Segment } from "../shared/chat";
import { isSubagentDelegationTool } from "../shared/toolMeta";

/**
 * 轮级过程折叠——官方默认的 compact 转写模式（`DEFAULT_TRANSCRIPT_VIEW_MODE =
 * "compact"`，`dsh-client-ui-chat/lib/client.js`）。
 *
 * 官方语义（读实现逐条对齐，见 `docs/continue-ui-spec.md` 之外的审计记录）：
 * - 一轮**关闭之后**，把「答案步」之前的全部节点折成一枚按钮，读作
 *   「N 次工具调用 · M 条消息 · K 个 subagent」，三者皆 0 时读「已思考」；
 * - 点开就把成员原样铺回来；
 * - **有几类节点永不折叠**（官方 `TURN_PROCESS_INDEPENDENT_KINDS` =
 *   system-prompt / user / steering / turn-process / turn-error / turn-max-tokens /
 *   turn-tail）：对我们而言对应的是**系统提示词那一条** `injected`（`sourceKind ===
 *   "system"`）与 `notice`（中止/截断/失败这类提示）——把「回答被截断了」折进按钮里
 *   是绝不能接受的信息损失。**其余上下文注入照常折叠**（插件注入 / 项目指令 /
 *   技能目录 / 运行时上下文）：官方那个集合里没有 context 一类，它们在 Web 上就是
 *   过程里的一条普通节点（用户 2026-09-14 对照 Web 报的）；
 * - 答案步**自己的思考**在折叠态也不显示（官方 `reasoningHidden`）。
 *
 * 我们的显示段没有官方那种节点锚点，边界只能靠 `step`：
 * **答案步 = 最后一个产出正文的 step**，它之前（以及它自己的 thinking）都算过程。
 * 拿不到 step（历史里缺 `step/start`）时**不折叠**——宁可平铺，也不要折错。
 *
 * 纯函数、不引 React：断言见 `scripts/turnProcess.test.ts`。
 */

/** 永不折叠的段（官方 `TURN_PROCESS_INDEPENDENT_KINDS` 里与本扩展对应得上的那几类）。 */
function isFoldExempt(segment: Segment): boolean {
  // 中止 / 截断 / 失败这类提示：把「回答被截断了」折进按钮里是绝不能接受的信息损失
  // （官方 `turn-error` / `turn-max-tokens`）
  if (segment.kind === "notice") return true;
  // **系统提示词**是官方明确豁免的那一类（`system-prompt`）；
  // 其余上下文注入（插件注入 / 项目指令 / 技能目录 / 运行时上下文）**参与折叠**
  // ——官方那个集合里没有 context 一类，它们就是过程里的一条普通节点
  // （用户 2026-09-14 对照 Web 提的；此前我们把 `injected` 整类都豁免了）
  if (segment.kind === "injected") return segment.injected.sourceKind === "system";
  return false;
}

export interface TurnProcessCounts {
  toolCalls: number;
  messages: number;
  subagents: number;
}

export interface TurnProcessFold {
  /** 保持原样显示的段（答案部分 + 不参与折叠的豁免段）。 */
  visible: Segment[];
  /** 折进按钮里的成员（展开后按原顺序插回 visible 的位置）。 */
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
    counts: { toolCalls: 0, messages: 0, subagents: 0 },
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

  // 答案步 = 最后一个**产出正文**的 step（官方的 `latestAnswer`：最后一个有回复内容的
  // 助手步）。没有正文（只有工具与思考）就没有答案步可言，不折。
  let answerStep: number | undefined;
  for (const segment of segments) {
    if (segment.kind !== "text" || !segment.text.trim()) continue;
    if (segment.step === undefined) continue;
    if (answerStep === undefined || segment.step > answerStep) answerStep = segment.step;
  }
  if (answerStep === undefined) return noFold(segments);

  // 边界 = 答案步的第一个段。官方按锚点切：锚点 < answerAnchorSeq 的才是成员，
  // 所以答案步自己的段一个都不折（它自己的 thinking 另算，见下）。
  const boundary = segments.findIndex(
    (segment) => segment.step === answerStep && !isFoldExempt(segment),
  );
  if (boundary <= 0) return noFold(segments); // 答案步就是第一个段 → 没有过程可折

  const visible: Segment[] = [];
  const folded: Segment[] = [];
  const counts: TurnProcessCounts = { toolCalls: 0, messages: 0, subagents: 0 };

  segments.forEach((segment, index) => {
    // 豁免段永远可见（就地保留，位置不变）
    if (isFoldExempt(segment)) {
      visible.push(segment);
      return;
    }
    if (index < boundary) {
      folded.push(segment);
      countInto(counts, segment);
      return;
    }
    // 答案步自己的思考也算过程（官方 `reasoningHidden`：折叠态不显示答案步的推理）
    if (segment.step === answerStep && segment.kind === "thinking") {
      folded.push(segment);
      return;
    }
    visible.push(segment);
  });

  if (!folded.length) return noFold(segments);
  return { visible, folded, counts, foldable: true };
}

function countInto(counts: TurnProcessCounts, segment: Segment): void {
  if (segment.kind === "tool") {
    // 子代理派发单独计数（官方 `isSubagentDelegationTool`）
    if (isSubagentDelegationTool(segment.tool.name)) counts.subagents += 1;
    else counts.toolCalls += 1;
    return;
  }
  // 「M 条消息」= 过程里模型说过的中间话（官方按 step 累计 assistant/message 条数）
  if (segment.kind === "text" && segment.text.trim()) counts.messages += 1;
}
