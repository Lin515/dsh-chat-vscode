/**
 * 轨迹账本「一行显示什么」的**唯一出处**：官方 `TrajectoryTable.tsx` 的
 * `recordDisplayText()` / `recordResultText()` / `isToolCallOnly()` /
 * `RecordPresentation.listDisplayText`（外加 `layout.ts` 的
 * `summarizeAssistantActivity()`）在本扩展的等价实现。
 *
 * 为什么单独一个纯模块（不引 React、不引 vscode）：
 * 1. **口径要能对拍**——`scripts/trajectoryAlignProbe.ts` 拿真实会话日志把这里与
 *    官方规则逐条比（合成夹具发现不了「真实日志里 36% 的助手消息只有思考没有正文」
 *    这种分布问题）；
 * 2. 从前这条规则内联在 `Trajectory.tsx` 的 `cellContent()` 里，还自造了一条官方
 *    没有的规则（「已结算且没正文 → 仅工具调用」），于是助手行只要没有正式正文就
 *    退化成那四个字——**只有思考的、连工具都没有的行**也一样。
 *
 * 与官方唯一的结构差异：官方那份折叠跑在浏览器里，`cell.text` 里直接就是本地化文案
 * （`layout.toolCallOnly` / `layout.imageCount` / 四条提示词变更文案）；本扩展的折叠
 * 跑在扩展宿主、不知道界面语言，因此宿主给**语义**（`emptySummary` / `attachments` /
 * `resultSummary` / `promptChange`），文案在这一层补齐（宿主 → 界面的用户可见文字
 * 一律如此，见 AGENTS.md）。
 *
 * **预览文本的解析不是手抄的**：`trajectoryPreviewText` 直接来自 vendor 进来的官方
 * `trajectory-preview.ts`（mdast + GFM，与官方渲染器同一套语法），不再是 marked 近似版。
 */
import { codeProgram, PTC_TOOL_NAME } from "../vendor/ui-trajectory/code-program";
import { trajectoryPreviewText } from "../vendor/ui-trajectory/trajectory-preview";
import { vendorCell } from "./trajectoryVendor";
import { TRAJECTORY_COMPACTION_INTERRUPTED, trajectoryTurnCells } from "../shared/trajectory";
import type { CodeProgram } from "../vendor/ui-trajectory/code-program";
import type {
  TrajectoryAssistantMetrics,
  TrajectoryCell,
  TrajectoryGroupTitle,
  TrajectoryPromptChange,
  TrajectorySourceBlock,
  TrajectoryToolUpdate,
  TrajectoryTurn,
} from "../shared/trajectory";
import type { TrajectoryTexts } from "./trajectoryTexts";
import { formatDurationMs, kindLabel } from "./trajectoryTexts";

export { trajectoryPreviewText };

/**
 * 一轮里**哪条记录**顶着轮次标签（官方 `TrajectoryTable` 的 `turnStart`）。
 *
 * 官方不是在轮次第一行画标签，而是在**第一条像样的记录**上：跳过 `requestOnly`
 * 请求锚点行与 `system` 行，压缩行也跳过（**除非**这一段不属于任何轮次——「轮次之间」
 * 那一段本来就靠压缩行起头）。照「第一行」画的话，第 2 轮那种以「系统提示词已更新」
 * 开头的轮次，标签会落在提示词行上——官方落在紧跟其后的那条记录上。
 *
 * 一轮里一条都不满足时**不出标签**（官方 `flattenRecords()` 的 `firstInSection`
 * 一直没被消费掉）。
 *
 * @param cell - 该轮的一条记录。
 * @param turn - 它所属的轮次（`null` = 轮次之间）。
 * @returns 该记录是否顶着这一轮的轮次标签。
 */
export function trajectoryTurnStartsLabel(cell: TrajectoryCell, turn: number | null): boolean {
  return cell.requestOnly !== true
    && cell.kind !== "system"
    && (cell.kind !== "compacted" || turn === null);
}

/**
 * 组标题的文案（官方 `group.message` / `group.step` / `group.compaction`）。
 *
 * 宿主给的是**语义**（`TrajectoryGroupTitle`），文案只在这一层取——与行文本同一个理由
 * （折叠跑在扩展宿主，不知道界面语言）。官方拿这个字符串做两件事：记录检查器的落点
 * （`第 M 轮 · 第 K 步`）与搜索索引的组标题字段。
 *
 * @param title - 折叠层给的组标题语义。
 * @param texts - 当前语言的轨迹词典。
 * @returns 该组的显示文案。
 */
export function trajectoryGroupTitle(title: TrajectoryGroupTitle, texts: TrajectoryTexts): string {
  if (title.kind === "step") return texts.groupStep(title.step);
  if (title.kind === "compaction") return texts.groupCompaction(title.seq);
  return texts.groupMessage;
}

/**
 * 轮次折叠后那一行的摘要（官方 `request.collapsedSummary` + `summarizeTurn()`）。
 *
 * 官方口径：折叠时**第一条有内容的记录仍然显示**，摘要描述的是它**之后**那批
 * （`contentRecords.slice(1)`）——「N 个步骤 · M 个工具调用」。
 *
 * **步骤数**照 `summarizeTurn()`：数「这批记录里**带请求的组**」的个数（官方拿
 * `requestKey(turn, group)` 去重，再用服务端的请求分组集合 `requestGroups` 过滤；
 * 我们没有那一份，判据等价成「这一组里有没有带请求号的记录」）。
 * **只数步骤组与压缩组**——服务端那份集合里是「第 K 步」与「压缩 N」，消息组从来不在内；
 * 而本扩展的消息组里**也有**带请求号的记录（用户 / 上下文行都挂请求号，那是「每一行都
 * 挂得上请求」的口径），不排除就会把步骤数算多。从前这里数的是「不同 `requestNumber`
 * 的个数」，同义但不同源，压缩请求因此会被多算一步。
 *
 * **工具调用数** = `tool` / `subtool` 记录的条数（与官方逐字相同）。
 *
 * @param turn - 一轮账本（含分组）。
 * @param texts - 当前语言的轨迹词典。
 * @returns 折叠行要显示的摘要（外层再由 `collapsedSummary` 拼成整句）。
 */
export function trajectoryTurnSummary(turn: TrajectoryTurn, texts: TrajectoryTexts): string {
  const content = trajectoryTurnCells(turn).filter(
    (cell) => cell.requestOnly !== true && cell.kind !== "system",
  );
  const rest = content.slice(1);
  const restIndexes = new Set(rest.map((cell) => cell.index));
  let steps = 0;
  for (const group of turn.groups) {
    if (group.title.kind === "message") continue;
    const inRest = group.cells.filter((cell) => restIndexes.has(cell.index));
    if (inRest.some((cell) => cell.requestNumber !== undefined)) steps += 1;
  }
  const toolCalls = rest.filter((cell) => cell.kind === "tool" || cell.kind === "subtool").length;
  return `${texts.summarySteps(steps)} · ${texts.summaryToolCalls(toolCalls)}`;
}

/**
 * 「调用折叠」摘要行的正文（官方 `summarizeAssistantTools()`）：`N 个工具调用` +
 * 工具名清单（` · ` 分隔）。
 *
 * 工具名的口径**逐字照官方**：取 `cell.text` 里第一个 ` · ` **之前**那一段
 * （官方 `record.cell.text.indexOf(' · ')`，工具行的 `text` 就是 `名字 · 参数预览`），
 * 空名去掉、按首次出现去重、保持账本顺序。没有可显示的名字时只剩计数那一句。
 *
 * 与 `trajectoryTurnSummary()` 同一个位置：它是「这一行显示什么」的唯一出处，
 * 所以组件与离线断言共用（不存在第二份镜像算法）。
 *
 * @param calls - 被收起的那串工具 / 子工具记录（账本行投影给的 `collapsedCalls`）。
 * @param texts - 当前语言的轨迹词典。
 * @returns 摘要正文（不含官方的 `…` 前缀与 `request.collapsedSummary` 外壳）。
 */
export function trajectoryAssistantSummary(
  calls: readonly TrajectoryCell[],
  texts: TrajectoryTexts,
): string {
  const names = [
    ...new Set(
      calls
        .map((cell) => {
          const separator = cell.text.indexOf(" · ");
          return separator === -1 ? cell.text : cell.text.slice(0, separator);
        })
        .filter((name) => name !== ""),
    ),
  ];
  const summary = texts.summaryToolCalls(calls.length);
  return names.length > 0 ? `${summary} · ${names.join(", ")}` : summary;
}

/**
 * 账本一行的**无障碍名字**（官方同一处的 `aria-label`：`request.rowAria` /
 * `request.rowPrefix` / `request.rowAriaCompaction`）。
 *
 * 官方把整行读成一句「请求 #N，种类，内容」，而不是让读屏把事件格与内容格里那几枚
 * 碎片（轮次标签、`#N`、种类徽章、正文）逐个念出来。三个分支：
 *
 * - **请求锚点行**（`requestOnly`）：没有种类也没有内容 → 官方的专用那句「请求 #N，压缩」；
 * - **带请求号的行**：`requestRowPrefix` 给出「请求 #N，」这半句，再拼种类与内容；
 * - 内容为空（仅工具调用那类 `trajectoryDisplayText()` 返回空串）→ `recordNoContent` 兜底。
 *
 * @param cell - 该行记录。
 * @param texts - 当前语言的轨迹词典。
 * @param requestNumber - 该行要念的请求号；没有就不念（官方传的是 `request ?? ''`）。
 * @returns 整行的无障碍名字。
 */
export function trajectoryRowLabel(
  cell: TrajectoryCell,
  texts: TrajectoryTexts,
  requestNumber: number | undefined,
): string {
  const request = requestNumber === undefined ? "" : String(requestNumber);
  if (cell.requestOnly === true) return texts.requestRowAriaCompaction(request);
  const prefix = requestNumber === undefined ? "" : texts.requestRowPrefix(requestNumber);
  const content = trajectoryDisplayText(cell, texts);
  return texts.requestRowAria(prefix, kindLabel(cell.kind, texts), content === "" ? texts.recordNoContent : content);
}

/**
 * 官方 `isToolCallOnly()`：助手行、**没有正文也没有思考**、layout 判成「仅工具调用」。
 *
 * 这条判据是本文件存在的理由：官方列表里这一行显示带括号的记录文案
 * （`record.toolCallOnly`「（仅工具调用）」）并单独弱化配色，其余任何情况都不许用它。
 */
export function trajectoryIsToolCallOnly(cell: TrajectoryCell): boolean {
  return (
    cell.kind === "message" &&
    cell.emptySummary?.kind === "tool-call" &&
    cell.outputDetail === undefined &&
    cell.thinkingDetail === undefined
  );
}

/**
 * 这一条记录是不是一段**录下来的 PTC 程序**（官方 `codeProgram(cell)`）。
 *
 * 官方那份纯决策已 vendor 进来（`src/vendor/ui-trajectory/code-program.ts`），这里只做
 * 「我们的记录 → 官方 `TrajectoryCellProps`」这一步转换（适配层是 `trajectoryVendor.ts`）。
 * 判据逐字来自官方：只有工具 / 子工具行、`toolName === 'run_code'`、`inputDetail` 能解析成
 * 对象、且 `code` 是字符串才算。**没有真样本时它是唯一依据**——本机 450 份日志里
 * `run_code` 一次都没出现过（发生率 0.0%），所以别改成「按工具名猜」。
 *
 * @param cell - 本扩展折叠层产出的一条记录。
 * @returns 程序（源码 / 描述 / 原始参数 / 语言），不是 PTC 调用时是 `undefined`。
 */
export function trajectoryCodeProgram(cell: TrajectoryCell): CodeProgram | undefined {
  return codeProgram(vendorCell(cell));
}

/**
 * PTC 调用行的行文本（官方 `recordDisplayText()` 的代码程序分支）：`` `run_code · 描述` ``。
 *
 * 官方在这一支里把描述**压平空白**（`description.replace(/\s+/g, ' ')`）——它是单行列表文本，
 * 描述里带换行会把行高撑开。走的是工具名常量而不是记录里的 `toolName`，与官方逐字相同。
 *
 * @param program - `trajectoryCodeProgram()` 已经解出来的那一份（调用方手上就有）。
 */
function trajectoryProgramText(program: CodeProgram): string {
  return `${PTC_TOOL_NAME} · ${program.description.replace(/\s+/g, " ")}`;
}

/**
 * 一次工具调用在账本里落在**哪一条记录**上（官方 `TrajectoryTable` 那段
 * `flattenRecords(turns).find(record => record.cell.callId === inspectCallId)`）。
 *
 * 用途是跨视图跳转：会话里点工具行的「查看」，轨迹侧据 `callId` 找到那一行、选中并
 * 滚过去。判据**只认等值**——`callId` 是服务端给的身份串，前缀相同不代表同一次调用
 * （`call_1` 与 `call_1:ptc:1` 是父调用与它的子调用），模糊匹配会跳到别的行上。
 *
 * 找不到时返回 `undefined` 而不是兜底到最近的一条：调用方据此**什么都不做**、
 * 把请求留着等账本补齐（官方那句「Not-found leaves the request pending」）。
 *
 * @param turns - 整份账本。
 * @param callId - 会话侧那次工具调用的 id。
 * @returns 那一条记录的 `index`；账本里没有就是 `undefined`。
 */
export function trajectoryCallCellIndex(
  turns: readonly TrajectoryTurn[],
  callId: string,
): number | undefined {
  for (const turn of turns) {
    for (const cell of trajectoryTurnCells(turn)) {
      if (cell.callId === callId) return cell.index;
    }
  }
  return undefined;
}

/**
 * 工具目录变更那一行的文案（官方 `inputCellDetail()` 的工具目录分支）。
 *
 * 单条变更 → 「已添加工具：X」/「已移除工具：X」；多条 → 「工具已更新 · 新增 3 个」
 * （或「新增 2 个，移除 1 个」/「移除 2 个」）。
 */
export function trajectoryToolUpdateText(
  update: TrajectoryToolUpdate,
  texts: TrajectoryTexts,
): string {
  if (update.added.length === 1 && update.removed.length === 0) return texts.toolAdded(update.added[0]);
  if (update.removed.length === 1 && update.added.length === 0) return texts.toolRemoved(update.removed[0]);
  return `${texts.toolUpdateNotice} · ${toolUpdateCounts(update, texts)}`;
}

/** 官方多条变更时的计数摘要（`layout.toolsChanged` / `toolsAddedCount` / `toolsRemovedCount`）。 */
function toolUpdateCounts(update: TrajectoryToolUpdate, texts: TrajectoryTexts): string {
  if (update.added.length > 0 && update.removed.length > 0) {
    return texts.toolsChanged(update.added.length, update.removed.length);
  }
  return update.added.length > 0
    ? texts.toolsAddedCount(update.added.length)
    : texts.toolsRemovedCount(update.removed.length);
}

/**
 * 工具目录变更的**参数页正文**（官方给这一格的 `inputDetail`：多条形才给，
 * 一行「新增：a, b」，一行「移除：c」）。官方那份是本地化文案，这里按同一张表拼。
 */
export function trajectoryToolUpdateParams(
  update: TrajectoryToolUpdate,
  texts: TrajectoryTexts,
): string {
  return [
    update.added.length > 0 ? texts.toolsAdded(update.added.join(", ")) : undefined,
    update.removed.length > 0 ? texts.toolsRemoved(update.removed.join(", ")) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

/**
 * 布局层算出的那一行前缀（官方 `cell.text` 的本地化部分）。
 *
 * 官方在浏览器里折账本，`text` 直接就是本地化文案；这里换成宿主给的语义标记。
 */
function cellText(cell: TrajectoryCell, texts: TrajectoryTexts): string {
  if (cell.toolUpdate !== undefined) return trajectoryToolUpdateText(cell.toolUpdate, texts);
  if (cell.attachments !== undefined) {
    return [
      cell.attachments.images > 0 ? texts.imageCount(cell.attachments.images) : undefined,
      cell.attachments.files > 0 ? texts.fileAttachments(cell.attachments.files) : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  }
  if (cell.emptySummary?.kind === "images") return texts.imageCount(cell.emptySummary.count);
  return cell.text;
}

/** 官方 `recordDisplayText()`：预览优先 → layout 文本 → 详情正文的预览 → 空串。 */
export function trajectoryDisplayText(cell: TrajectoryCell, texts: TrajectoryTexts): string {
  if (trajectoryIsToolCallOnly(cell)) return "";
  const program = trajectoryCodeProgram(cell);
  if (program !== undefined) return trajectoryProgramText(program);
  if (cell.previewMarkdown !== undefined) {
    const preview = trajectoryPreviewText(cell.previewMarkdown);
    const text = cellText(cell, texts);
    if (text === "") return preview;
    return preview === "" ? text : `${text} · ${preview}`;
  }
  const text = cellText(cell, texts);
  if (text !== "") return text;
  const markdown =
    cell.kind === "user" || cell.kind === "context"
      ? cell.inputDetail
      : cell.kind === "message"
        ? (cell.outputDetail ?? cell.thinkingDetail)
        : undefined;
  return markdown === undefined ? "" : trajectoryPreviewText(markdown);
}

/**
 * 官方 `recordResultText()`：有原文就用原文的预览，否则用 `result`；
 * `resultSummary` 是宿主给的两条**语义**分支（官方那两句文案在布局层就本地化了）。
 */
export function trajectoryResultText(
  cell: TrajectoryCell,
  texts: TrajectoryTexts,
): string | undefined {
  if (cell.resultPreviewMarkdown !== undefined) {
    return trajectoryPreviewText(cell.resultPreviewMarkdown);
  }
  if (cell.resultSummary?.kind === "images") return texts.imageCount(cell.resultSummary.count);
  if (cell.resultSummary?.kind === "no-output") return texts.recordNoOutput;
  return cell.result;
}

/** 账本一行的内容列要画什么。 */
export interface TrajectoryRowContent {
  text: string;
  /** 工具行右侧那一段（`请求 → 结果`）。 */
  result?: string;
  /** 「仅工具调用」行：官方给它单独的弱化配色（`record.toolCallOnly`）。 */
  toolCallOnly?: boolean;
}

/**
 * 该行在内容列里显示什么（工具行摊成「请求 → 结果」）。
 *
 * `system` / `compacted` 两支仍在界面侧取文案：官方在**布局层**就把那几条本地化
 * 文案写进 `cell.text` 了，而这一层在本扩展里位于扩展宿主（见文件头）。
 * 其余种类一律走 `trajectoryDisplayText`（官方 `recordDisplayText`）——工具行的
 * `name · preview(args)`、用户/上下文行的 `附件摘要 · preview(首块)` 都由它拼出来，
 * 宿主不再自己截 160 字摘要。
 */
export function trajectoryCellContent(
  cell: TrajectoryCell,
  texts: TrajectoryTexts,
): TrajectoryRowContent {
  switch (cell.kind) {
    case "system": {
      // 四条「为什么出现」的文案（官方 `promptChangeLabel`）。用查表而不是嵌套
      // switch：内层 case 与外层同名（`system`）会被 `invariants.test.ts` 的
      // 重复 case 扫描当成静默死代码（它按 switch 块收集 case 字面量）。
      const labels: Record<TrajectoryPromptChange, string> = {
        initial: texts.initialSystemPrompt,
        system: texts.systemPromptUpdated,
        tools: texts.toolsUpdated,
        "system-and-tools": texts.systemPromptAndToolsUpdated,
      };
      return { text: cell.text || labels[cell.promptChange ?? "initial"] };
    }
    case "compacted":
      // 「被中断」有专用文案（官方 `layout.compactionInterrupted`）：它不是模型报的错，
      // 而是会话在压缩跑到一半时结束——与「压缩失败」不是同一件事，别混成一句。
      if (cell.status === "error" && cell.error === TRAJECTORY_COMPACTION_INTERRUPTED) {
        return { text: texts.compactionInterrupted };
      }
      if (cell.status === "error") return { text: texts.compactionFailed };
      if (cell.status === "running") return { text: texts.compacting };
      // 有摘要 → 摘要的预览（官方 `previewMarkdown`）；没有 → 「上下文已压缩」
      return {
        text:
          cell.previewMarkdown === undefined
            ? texts.compacted
            : trajectoryPreviewText(cell.previewMarkdown) || texts.compacted,
      };
    case "message": {
      // 流式占位行（本扩展没有官方那种流式正文）：正文还没到，留空而不是给「—」
      if (cell.status === "running" && cell.previewMarkdown === undefined && cell.emptySummary === undefined) {
        return { text: "" };
      }
      if (trajectoryIsToolCallOnly(cell)) {
        return { text: texts.recordToolCallOnly, toolCallOnly: true };
      }
      // 官方列表的兜底是 `displayText || '—'`（`request.noContent` 只用在 aria 上）
      return { text: trajectoryDisplayText(cell, texts) || "—" };
    }
    default: {
      const result = trajectoryResultText(cell, texts);
      // PTC 调用（官方 `recordDisplayText` 的代码程序分支，在预览那一支之前）
      const program = trajectoryCodeProgram(cell);
      if (program !== undefined) {
        return { text: trajectoryProgramText(program), ...(result === undefined ? {} : { result }) };
      }
      const text = trajectoryDisplayText(cell, texts);
      return {
        // 官方工具行的兜底是 `displayText || '—'`（`request.noContent`）
        text: text || "—",
        ...(result === undefined ? {} : { result }),
      };
    }
  }
}

/**
 * 检查器「错误」那一行的正文（本扩展特有的一行：官方只在请求面板里显示错误）。
 *
 * 两条已知的**语义标记**要换成文案，不能原样渲染——宿主不知道界面语言，写进
 * `cell.error` 的是一个记号：
 * - `@interrupted`：助手回答在完成前被中断（`assistant/message` 的 `interrupted`）；
 * - 压缩被中断的合成错误码走 `compactionInterrupted`（与账本行的口径同一句）。
 *
 * 其余的错误（`turn/end` 的 reason、工具失败原因）是服务端 / 运行时的原话，
 * **原样显示**——那些不该翻译。
 *
 * @param cell - 当前记录。
 * @param texts - 当前语言的轨迹词典。
 * @returns 要显示的正文；没有错误时是 `undefined`。
 */
export function trajectoryCellError(
  cell: TrajectoryCell,
  texts: TrajectoryTexts,
): string | undefined {
  if (cell.error === undefined) return undefined;
  if (cell.error === "@interrupted") return texts.detailsInterrupted;
  if (cell.error === TRAJECTORY_COMPACTION_INTERRUPTED) return texts.compactionInterrupted;
  return cell.error;
}

/**
 * 助手记录概述里「请求计时」那一节的**跳转目标**（官方
 * `selectedAssistantRequestTarget` + `selectRequest(target, 'timing')`）。
 *
 * 独立成纯函数是为了**能离线断言**：这条链路有三处「宁可不给」的守卫，全都在组件里
 * 就只能靠手点，而它们的错误形态都是**静默的**——多给一节是「点过去是另一次请求的计时」，
 * 少给一节是「功能看起来没做」。
 *
 * 三条与官方同源的判据：
 * 1. **只有助手记录**（官方 `selected.cell.kind === 'message'`）：压缩行也带请求号，
 *    但那是一个**压缩请求**的号——拿它当「这次请求的计时」是对错了对象；
 * 2. 这一格得有请求号（`cell.requestNumber`）；
 * 3. 那个号得能在请求表里解析出来（`requestsByNumber`）。**不兜底到别的请求**，
 *    与 `trajectoryCallCellIndex()` 的「拿不到证据就不动手」同一条口径。
 *
 * @param cell - 当前选中的记录。
 * @param requestNumbers - 请求表里现有的请求号（`TrajectoryModel.requests` 的 number 集合）。
 * @returns 该跳去的请求号；不该出这一节时 `undefined`。
 */
export function trajectoryAssistantRequestNumber(
  cell: TrajectoryCell,
  requestNumbers: ReadonlySet<number>,
): number | undefined {
  if (cell.kind !== "message") return undefined;
  const number = cell.requestNumber;
  if (number === undefined || !requestNumbers.has(number)) return undefined;
  return number;
}

/**
 * 一次请求在账本里落下的那批记录（官方 `selectedRequestRecordTemplates`）。
 *
 * 官方按 `record.turn === request.turn && record.group === request.group` 认；本扩展的
 * 账本行自带 `requestNumber`（宿主保证「每一行都要挂得上请求」），按它筛是同一批记录，
 * 且不吃「组」这个中间层。请求面板的计时要用它挑出助手记录（官方
 * `selectedRequestAssistant`）。
 *
 * @param cells - 整份账本的扁平记录（顺序即账本顺序）。
 * @param requestNumber - 请求号（`TrajectoryRequest.number`）。
 * @returns 该请求的记录，按账本顺序；没有就是空数组。
 */
export function trajectoryRequestCells(
  cells: readonly TrajectoryCell[],
  requestNumber: number,
): TrajectoryCell[] {
  return cells.filter((cell) => cell.requestNumber === requestNumber);
}

/** 一次请求的账本记录里工具 / 子工具的条数（官方 `selectedRequestToolCalls` 一族）。 */
export interface TrajectoryRequestCallCounts {
  toolCalls: number;
  subtoolCalls: number;
}

/**
 * 请求概述里那两行计数（官方 `details.toolCalls` / `details.subtoolCalls`）。
 *
 * 官方按 `record.turn === request.turn && record.group === request.group` 数
 * `kind === 'tool'` / `'subtool'` 的记录条数；这里复用同一个身份 seam
 * （`trajectoryRequestCells`：按请求号筛账本行），所以计数与请求面板的落点、计时
 * 挑的是同一批记录。**工具与子工具分开数**，其余种类（助手消息、压缩行）一条都不算。
 *
 * 每次按当前请求现算（组件不缓存）：切换请求时不会残留上一个请求的计数。
 *
 * @param cells - 整份账本的扁平记录（顺序即账本顺序）。
 * @param requestNumber - 请求号（`TrajectoryRequest.number`）。
 * @returns 两行计数（子工具为 0 时视图层不出那一行，官方同款）。
 */
export function trajectoryRequestCallCounts(
  cells: readonly TrajectoryCell[],
  requestNumber: number,
): TrajectoryRequestCallCounts {
  const records = trajectoryRequestCells(cells, requestNumber);
  return {
    toolCalls: records.filter((cell) => cell.kind === "tool").length,
    subtoolCalls: records.filter((cell) => cell.kind === "subtool").length,
  };
}

/**
 * 助手记录计时面板的四条值（官方 `TrajectoryTable.tsx` 的 `totalTime` / `ttft` /
 * `generationTime` / `throughput`），逐条对齐**包括缺哪种证据时报哪一句**——官方四种
 * 「不可用」各有自己的 key，不是一句笼统的话：
 *
 * - 没记录计时 → 「未记录」；
 * - 记录过但缺步骤开始时刻 → 「步骤开始时间不可用」（这是**这一族**的前提，
 *   TTFT 与吞吐都量不出来）；
 * - **TTFT 是「首个 token 相对步骤开始」的**时长**，不是时刻**（这里曾经画成
 *   `formatRecordedTime(firstTokenTime)`——一个绝对时刻，与官方同一个位置显示的
 *   「1.2 秒」根本不是同一个量）。
 *
 * 放在这个纯模块里是为了**能离线断言**：四条值各有五种缺失组合，摊在组件里只能靠
 * 预览页手点。`scripts/trajectoryDisplay.test.ts` 逐条钉住。
 *
 * @param metrics - 助手记录的计时/用量（`cell.assistantMetrics`），缺席 = 没记录。
 * @param texts - 当前语言的轨迹词典。
 * @returns 该行要显示的文案。
 */
export function trajectoryRecordTotalTime(
  metrics: TrajectoryAssistantMetrics | undefined,
  texts: TrajectoryTexts,
): string {
  if (metrics === undefined || !metrics.timingRecorded) return texts.timingNotRecorded;
  if (metrics.stepStartTime === null) return texts.timingStepStartUnavailable;
  if (metrics.completedTime === null) return texts.statusPending;
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.stepStartTime), texts);
}

export function trajectoryRecordTtft(metrics: TrajectoryAssistantMetrics, texts: TrajectoryTexts): string {
  if (!metrics.timingRecorded) return texts.timingNotRecorded;
  if (metrics.stepStartTime === null) return texts.timingStepStartUnavailable;
  if (metrics.firstTokenTime === null) return texts.timingFirstTokenUnavailable;
  return formatDurationMs(Math.max(0, metrics.firstTokenTime - metrics.stepStartTime), texts);
}

export function trajectoryRecordGenerationTime(
  metrics: TrajectoryAssistantMetrics,
  texts: TrajectoryTexts,
): string {
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return texts.timingFirstTokenUnavailable;
  if (metrics.completedTime === null) return texts.statusPending;
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.firstTokenTime), texts);
}

/**
 * 「吞吐量」（官方 `throughput()`）：输出 token 数 ÷ 解码时长。
 *
 * 五道守卫的**顺序**与官方一致（用量 → 输出 token 数 → 计时 → 首个 token → 收尾时刻），
 * 所以同一份残缺数据在两边得到同一句「不可用」；解码时长非正时报「时长过短」而不是
 * 除以零。
 */
export function trajectoryRecordThroughput(
  metrics: TrajectoryAssistantMetrics,
  texts: TrajectoryTexts,
): string {
  if (!metrics.usageProvided) return texts.timingUsageUnavailable;
  if (metrics.outputTokens === null) return texts.timingOutputTokensUnavailable;
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return texts.timingFirstTokenUnavailable;
  if (metrics.completedTime === null) return texts.statusPending;
  const generationSeconds = (metrics.completedTime - metrics.firstTokenTime) / 1000;
  if (generationSeconds <= 0) return texts.timingDurationTooShort;
  return texts.unitTokensPerSecond((metrics.outputTokens / generationSeconds).toFixed(1));
}

/**
 * 「原始内容」页签该不该走**逐块排版**（官方 `MarkdownRecordContent` 的第二分支：
 * `!rendered && sourceBlocks && sourceBlocks.length > 0` → 整块改用 `SourceBlocks`）。
 *
 * 两条排除，都是官方那里逐字有的：
 * 1. **全是工具目录变更的块**（`tool-addition` / `tool-removal`）→ 官方第一分支
 *    优先命中，那一格显示的是参数文本（`inputDetail`，即本扩展的
 *    `trajectoryToolUpdateParams()` 拼出来的名字清单）。这些块的 `content` 只有一个
 *    工具名，逐块排出来是「块 #1 tool-addition / read」这种比正文还长的形式。
 * 2. 没有块可排（`undefined` 或空数组）→ 落回那段裸文本。
 *
 * @param cell - 一条记录。
 * @returns 该记录的「原始内容」页签是否逐块渲染。
 */
export function trajectoryUsesSourceBlocks(cell: TrajectoryCell): boolean {
  const blocks = cell.sourceBlocks;
  if (blocks === undefined || blocks.length === 0) return false;
  return !blocks.every((block) => block.type === "tool-addition" || block.type === "tool-removal");
}

/**
 * 一个原始块的节标题（官方 `block.label`，`块 #{index} {type}`）。
 *
 * `type` **原样用块类型串**（`thinking` / `text` / `tool-call` / `unknown`）——官方没有
 * 一张把块类型翻成自然语言的表，这两份词典里也没有对应词条；轨迹本来就是拿日志核对
 * 事实的地方，写类型串才能与 `session.jsonl` 里的块对上。位置是无障碍名字与悬停说明
 * 里的 `#{index}`，用的是块的**序号**（1 起），与官方同一个取值。
 *
 * @param block - 那一块（只用它的 `type`）。
 * @param index - 块在记录里的**下标**（0 起；显示时 +1）。
 * @param texts - 当前语言的轨迹词典。
 * @returns 该节的标题文案。
 */
export function trajectoryBlockLabel(
  block: TrajectorySourceBlock,
  index: number,
  texts: TrajectoryTexts,
): string {
  return texts.blockLabel(index + 1, block.type);
}

/**
 * 工具调用块那枚跳转按钮的名字（官方 `block.openSummary`）。
 *
 * 与 `trajectoryBlockLabel` 分开是因为**两者的语言不同**：节标题给读代码 / 查日志的人看
 * （类型串），这个名字是给读屏的（「打开第 3 个块的工具调用概述」）。
 *
 * @param index - 块在记录里的下标（0 起；显示时 +1）。
 * @param texts - 当前语言的轨迹词典。
 * @returns 该按钮的无障碍名字。
 */
export function trajectoryBlockOpenLabel(index: number, texts: TrajectoryTexts): string {
  return texts.blockOpenSummary(index + 1);
}
