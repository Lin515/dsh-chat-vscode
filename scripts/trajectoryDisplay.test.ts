/**
 * 轨迹账本「一行显示什么」的离线断言（`src/webview/trajectoryDisplay.ts` +
 * `src/dsh/trajectory.ts` 的助手行字段）。
 *
 * 钉的是与官方 `TrajectoryTable.tsx` 的 `recordDisplayText()` / `isToolCallOnly()`
 * 逐条对齐的那套判据，重点是**曾把助手行误判成「仅工具调用」**的那条：
 * 官方只有「没有正文、没有思考、有工具调用」三条同时成立才显示「（仅工具调用）」，
 * 而本扩展此前是「已结算且 text 为空 → 仅工具调用」——真实日志里 36% 的助手消息
 * （只有思考没有正文）因此全被写成那四个字（对拍探针见
 * `scripts/trajectoryAlignProbe.ts`，它在 45k 条真实消息上量过这个比例）。
 *
 * 夹具的块组合**来自真实会话日志的分布**（`reasoning,tool-call` 是最大的一类）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveTrajectoryModel } from "../src/dsh/trajectory";
import type { SessionWireEvent } from "../src/dsh/protocol";
import { trajectoryTurnCells, TRAJECTORY_COMPACTION_INTERRUPTED } from "../src/shared/trajectory";
import type { TrajectoryAssistantMetrics, TrajectoryCell } from "../src/shared/trajectory";
import {
  trajectoryAssistantRequestNumber,
  trajectoryAssistantSummary,
  trajectoryBlockLabel,
  trajectoryBlockOpenLabel,
  trajectoryCellContent,
  trajectoryCellError,
  trajectoryCodeProgram,
  trajectoryDisplayText,
  trajectoryGroupTitle,
  trajectoryIsToolCallOnly,
  trajectoryPreviewText,
  trajectoryRecordGenerationTime,
  trajectoryRecordThroughput,
  trajectoryRecordTotalTime,
  trajectoryRecordTtft,
  trajectoryRequestCallCounts,
  trajectoryRequestCells,
  trajectoryRowLabel,
  trajectoryToolUpdateParams,
  trajectoryTurnStartsLabel,
  trajectoryTurnSummary,
  trajectoryUsesSourceBlocks,
} from "../src/webview/trajectoryDisplay";
import { trajectoryTexts } from "../src/webview/trajectoryTexts";

const texts = trajectoryTexts("zh-cn");
const en = trajectoryTexts("en");

let seq = 0;
const at = (offset: number) => 1_700_000_000_000 + offset * 1000;
const event = (type: string, data: Record<string, unknown>, offset = seq): SessionWireEvent => {
  seq += 1;
  return { type, seq: seq - 1, time: at(offset), data };
};

/** 助手消息的内容块（真实日志里的几种组合）。 */
const blocks = (...content: { type: string; text?: string; id?: string; name?: string; arguments?: string }[]) => content;
const assistant = (...content: { type: string; text?: string; id?: string; name?: string; arguments?: string }[]) =>
  event("assistant/message", { turn: 0, step: 0, message: { role: "assistant", content }, usage: {} }, 2);

/** 折叠一条助手消息，取出它的 cell（与界面拿到的是同一份）。 */
function foldAssistant(
  ...content: { type: string; text?: string; id?: string; name?: string; arguments?: string }[]
): TrajectoryCell {
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", { id: "u1", role: "user", content: [{ type: "text", text: "问" }], source: { kind: "user" } }, 1),
    assistant(...content),
    event("turn/end", { turn: 0, reason: "success" }, 3),
  ];
  const cell = deriveTrajectoryModel(events, false)
    .turns.flatMap(trajectoryTurnCells)
    .find((entry) => entry.kind === "message");
  assert.ok(cell, "助手消息必须折出一行");
  return cell;
}

/** 界面实际画在内容列里的那一行。 */
const rowText = (cell: TrajectoryCell) => trajectoryCellContent(cell, texts).text;

// ---------- 1. 只有思考 + 工具调用：**不是**「仅工具调用」（本次修复的现场） ----------
{
  const cell = foldAssistant(
    { type: "reasoning", text: "先想一下 **怎么做**" },
    { type: "tool-call", text: "" },
  );
  assert.strictEqual(cell.emptySummary, undefined, "有思考就不该落「没有正文」的摘要语义");
  assert.strictEqual(trajectoryIsToolCallOnly(cell), false, "有思考的助手行不是「仅工具调用」");
  assert.strictEqual(cell.thinkingDetail, "先想一下 **怎么做**");
  assert.strictEqual(cell.previewMarkdown, "先想一下 **怎么做**", "思考也要能当行预览（官方同口径）");
  assert.strictEqual(cell.text, "", "行文本由界面按 previewMarkdown 现算，宿主不留摘要");
  assert.strictEqual(rowText(cell), "先想一下 怎么做", "行里显示思考的纯文本预览（去掉 markdown 记号）");
  assert.notStrictEqual(rowText(cell), texts.toolCallOnly);
  assert.notStrictEqual(rowText(cell), texts.recordToolCallOnly);
}
console.log("trajectoryDisplay: 只有思考的助手行不再退化成「仅工具调用」 ✓");

// ---------- 2. 只有思考、连工具都没有：同样不许说「仅工具调用」 ----------
{
  const cell = foldAssistant({ type: "reasoning", text: "只想了想要不要回答" });
  assert.strictEqual(cell.emptySummary, undefined);
  assert.strictEqual(rowText(cell), "只想了想要不要回答");
}
console.log("trajectoryDisplay: 没有工具调用的思考行 ✓");

// ---------- 3. 真的只有工具调用：显示记录文案（带括号）+ 单独样式 ----------
{
  const cell = foldAssistant({ type: "tool-call", text: "" }, { type: "tool-call", text: "" });
  assert.deepStrictEqual(cell.emptySummary, { kind: "tool-call" });
  assert.strictEqual(trajectoryIsToolCallOnly(cell), true);
  const content = trajectoryCellContent(cell, texts);
  assert.strictEqual(content.text, texts.recordToolCallOnly, "账本行用记录文案「（仅工具调用）」");
  assert.strictEqual(content.toolCallOnly, true, "这一行要单独弱化配色");
  assert.strictEqual(trajectoryCellContent(cell, en).text, en.recordToolCallOnly, "英文同一支");
}
console.log("trajectoryDisplay: 纯工具调用行用记录文案 + 标记 ✓");

// ---------- 4. 有正文：显示正文预览（markdown 去记号、按 512 截断） ----------
{
  const cell = foldAssistant({ type: "text", text: "# 标题\n\n正文**加粗**收尾" }, { type: "tool-call", text: "" });
  assert.strictEqual(cell.emptySummary, undefined);
  assert.strictEqual(cell.outputDetail, "# 标题\n\n正文**加粗**收尾", "详情留原文");
  assert.strictEqual(rowText(cell), "标题 正文加粗收尾", "行里是压平去记号的预览");
  assert.strictEqual(cell.thinkingDetail, undefined);
}
console.log("trajectoryDisplay: 有正文时给纯文本预览 ✓");

// ---------- 5. 正文与思考都有：预览取**正文**（官方 `messageText` 优先） ----------
{
  const cell = foldAssistant({ type: "reasoning", text: "思考内容" }, { type: "text", text: "正式回答" });
  assert.strictEqual(cell.previewMarkdown, "正式回答");
  assert.strictEqual(cell.thinkingDetail, "思考内容");
  assert.strictEqual(rowText(cell), "正式回答");
}
console.log("trajectoryDisplay: 正文优先于思考 ✓");

// ---------- 6. 只有图片：官方 `layout.imageCount` ----------
{
  const cell = foldAssistant({ type: "image", text: "" });
  assert.deepStrictEqual(cell.emptySummary, { kind: "images", count: 1 });
  assert.strictEqual(trajectoryIsToolCallOnly(cell), false, "图片行不是工具调用行");
  assert.strictEqual(rowText(cell), texts.imageCount(1));
}
console.log("trajectoryDisplay: 只有图片的助手行 ✓");

// ---------- 7. 什么都没有：列表兜底是「—」（官方 `displayText || '—'`） ----------
{
  const cell = foldAssistant();
  assert.strictEqual(cell.emptySummary, undefined);
  assert.strictEqual(rowText(cell), "—");
}
console.log("trajectoryDisplay: 空行的「—」兜底 ✓");

// ---------- 8. 流式占位行（本扩展没有官方那种流式正文）：留空而不是「—」 ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", { id: "u1", role: "user", content: [{ type: "text", text: "问" }], source: { kind: "user" } }, 1),
    event("tool/call", { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" }, 2),
  ];
  const placeholder = deriveTrajectoryModel(events, false)
    .turns.flatMap(trajectoryTurnCells)
    .find((cell) => cell.kind === "message" && cell.status === "running");
  assert.ok(placeholder, "运行中的占位行要出");
  assert.strictEqual(rowText(placeholder), "", "正文还没到，留空（不是「—」，也不是「仅工具调用」）");
}
console.log("trajectoryDisplay: 流式占位行留空 ✓");

// ---------- 9. 预览：去 markdown、压平空白、512 截断 + 省略号 ----------
{
  assert.strictEqual(trajectoryPreviewText("**粗体** 与 `code`"), "粗体 与 code");
  assert.strictEqual(trajectoryPreviewText("```\nconst a = 1;\n```"), "const a = 1;");
  assert.strictEqual(trajectoryPreviewText("- 甲\n- 乙"), "甲 乙");
  assert.strictEqual(trajectoryPreviewText(""), "");
  const long = trajectoryPreviewText("字".repeat(600));
  assert.strictEqual(long.length, 513, "512 字符 + 省略号");
  assert.ok(long.endsWith("…"));
  const multi = trajectoryPreviewText("a\n\n\n\nb");
  assert.strictEqual(multi, "a b", "多空行压成一个空格（行内预览是单行）");
}
console.log("trajectoryDisplay: 有界单行预览（去 markdown / 512 截断） ✓");

// ---------- 10. 系统行：四条「为什么出现」的文案（官方 `promptChangeLabel`） ----------
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: { content: [{ type: "text", text: "第一版提示词" }] } }, 0),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "read" }] }, reason: "initial" }, 0),
    event("user/message", { id: "u1", role: "user", content: [{ type: "text", text: "问" }], source: { kind: "user" } }, 1),
    event("assistant/message", { turn: 0, step: 0, message: { content: [{ type: "text", text: "答" }] }, usage: {} }, 1),
    event("turn/end", { turn: 0, reason: "success" }, 2),
    event("turn/start", { turn: 1 }, 2),
    event("step/start", { turn: 1, step: 0 }, 2),
    // 第二轮：工具目录变了（提示词正文没变）→ 官方只出一行「工具已更新」
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "read" }, { name: "bash" }] }, reason: "change" }, 2),
    event("user/message", { id: "u2", role: "user", content: [{ type: "text", text: "再问" }], source: { kind: "user" } }, 3),
    event("assistant/message", { turn: 1, step: 0, message: { content: [{ type: "text", text: "再答" }] }, usage: {} }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const systems = deriveTrajectoryModel(events, false)
    .turns.flatMap(trajectoryTurnCells)
    .filter((cell) => cell.kind === "system");
  assert.deepStrictEqual(
    systems.map((cell) => cell.promptChange),
    ["initial", "tools"],
    "初始一行 + 工具变化一行；提示词正文没变就不出 system 行",
  );
  assert.strictEqual(rowText(systems[0]), texts.initialSystemPrompt);
  assert.strictEqual(rowText(systems[1]), texts.toolsUpdated, "只有工具变了 → 「工具已更新」，不是「系统提示词和工具已更新」");
  assert.strictEqual(trajectoryCellContent(systems[1], en).text, en.toolsUpdated);
}
// 工具目录逐字没变 → **不出**新的一行（官方 `JSON.stringify` 比较；曾经是「带 tools 就出行」）
{
  seq = 0;
  const tools = [{ name: "read", description: "读文件" }];
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("system/message", { turn: 0, step: 0, message: { content: [{ type: "text", text: "提示词" }] } }, 0),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools }, reason: "initial" }, 0),
    event("user/message", { id: "u1", role: "user", content: [{ type: "text", text: "问" }], source: { kind: "user" } }, 1),
    event("assistant/message", { turn: 0, step: 0, message: { content: [{ type: "text", text: "答" }] }, usage: {} }, 1),
    event("turn/end", { turn: 0, reason: "success" }, 2),
    event("turn/start", { turn: 1 }, 2),
    event("step/start", { turn: 1, step: 0 }, 2),
    event("request/header", { header: { config: { provider: "p", model: "m" }, tools }, reason: "change" }, 2),
    event("user/message", { id: "u2", role: "user", content: [{ type: "text", text: "再问" }], source: { kind: "user" } }, 3),
    event("assistant/message", { turn: 1, step: 0, message: { content: [{ type: "text", text: "再答" }] }, usage: {} }, 3),
    event("turn/end", { turn: 1, reason: "success" }, 4),
  ];
  const systems = deriveTrajectoryModel(events, false)
    .turns.flatMap(trajectoryTurnCells)
    .filter((cell) => cell.kind === "system");
  assert.strictEqual(systems.length, 1, "工具目录逐字相同 → 不再出一行「已更新」");
}
console.log("trajectoryDisplay: 系统行按变更种类取文案 ✓");

// ---------- 11. 压缩行：有摘要给摘要预览，没有才给「上下文已压缩」 ----------
{
  const cell: TrajectoryCell = {
    index: 1,
    kind: "compacted",
    turn: 0,
    seq: 1,
    time: at(0),
    text: "",
    previewMarkdown: "## 摘要\n\n要点一",
    timeSeconds: 1,
    startedAt: at(0),
    status: "complete",
  };
  assert.strictEqual(trajectoryCellContent(cell, texts).text, "摘要 要点一");
  assert.strictEqual(trajectoryCellContent({ ...cell, previewMarkdown: undefined }, texts).text, texts.compacted);
  assert.strictEqual(trajectoryCellContent({ ...cell, status: "running" }, texts).text, texts.compacting);
  assert.strictEqual(trajectoryCellContent({ ...cell, status: "error" }, texts).text, texts.compactionFailed);
}
console.log("trajectoryDisplay: 压缩行的摘要与状态文案 ✓");

// ---------- 12. 反面：任何已结算、有内容的助手行都不许渲染成「仅工具调用」 ----------
{
  const samples: { type: string; text?: string }[][] = [
    [{ type: "text", text: "正文" }],
    [{ type: "reasoning", text: "思考" }],
    [{ type: "reasoning", text: "思考" }, { type: "tool-call", text: "" }],
    [{ type: "reasoning", text: "思考" }, { type: "text", text: "正文" }, { type: "tool-call", text: "" }],
    [{ type: "image", text: "" }],
  ];
  for (const content of samples) {
    const cell = foldAssistant(...content);
    const text = rowText(cell);
    assert.notStrictEqual(text, texts.toolCallOnly, `有内容却渲染成「仅工具调用」：${JSON.stringify(content)}`);
    assert.notStrictEqual(text, texts.recordToolCallOnly, `有内容却渲染成「（仅工具调用）」：${JSON.stringify(content)}`);
    assert.notStrictEqual(text, "—", `有内容却渲染成「—」：${JSON.stringify(content)}`);
  }
}
console.log("trajectoryDisplay: 有内容的助手行不会退化成「仅工具调用」 ✓");

// ---------- 13. 行文本按官方那支函数拼：附件摘要、`name · preview(args)`、结果预览 ----------
//
// 从前这几类记录的 `text` 是宿主截好的 160 字首行摘要，官方是
// `preview(首个文本块)`（工具行 `name · preview(argsRaw)`）；现在宿主只给数据，
// 拼接与截断都在这一层（`trajectoryDisplay.ts`）。
{
  seq = 0;
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    // 用户消息：两张图 + 一个文件 + 正文
    event("user/message", {
      id: "u1", role: "user", source: { kind: "user" },
      content: [
        { type: "image", attachment: { name: "a.png" } },
        { type: "image", attachment: { name: "b.png" } },
        { type: "file", attachment: { name: "c.ts" } },
        { type: "text", text: "看 **这两个** 文件" },
      ],
    }, 1),
    event("assistant/message", { turn: 0, step: 0, message: { content: [{ type: "tool-call", text: "" }] }, usage: {} }, 2),
    event("tool/call", { turn: 0, step: 0, callId: "c1", name: "read", arguments: '{"file_path":"a.ts"}' }, 3),
    event("tool/result", { turn: 0, step: 0, message: { role: "tool", source: { callId: "c1" }, content: [{ type: "text", text: "## 结果\n\n内容" }] } }, 4),
    event("turn/end", { turn: 0, reason: "success" }, 4),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  const user = cells.find((cell) => cell.kind === "user");
  const tool = cells.find((cell) => cell.kind === "tool");
  assert.ok(user && tool);

  // 用户行：附件摘要（本地化文案在界面侧）拼在正文预览前面
  assert.deepStrictEqual(user.attachments, { images: 2, files: 1 });
  assert.strictEqual(user.text, "", "宿主不预截行文本");
  assert.strictEqual(
    rowText(user),
    "图片 ×2 · 文件 ×1 · 看 这两个 文件",
    "附件摘要 · 正文预览（正文的 markdown 记号被去掉）",
  );
  assert.strictEqual(
    trajectoryCellContent(user, en).text,
    "Images ×2 · Files ×1 · 看 这两个 文件",
    "英文同一支（计数文案在词典里）",
  );

  // 工具行：`name · preview(args)`，结果那栏取 `resultPreviewMarkdown` 的预览
  const content = trajectoryCellContent(tool, texts);
  assert.strictEqual(content.text, 'read · {"file_path":"a.ts"}');
  assert.strictEqual(content.result, "结果 内容", "结果是**原文的预览**（去 markdown 记号）");

  // 结果只有图片 / 什么都没有 → 两条语义分支
  assert.strictEqual(
    trajectoryCellContent({ ...tool, resultPreviewMarkdown: undefined, resultSummary: { kind: "images", count: 3 } }, texts).result,
    texts.imageCount(3),
  );
  assert.strictEqual(
    trajectoryCellContent({ ...tool, resultPreviewMarkdown: undefined, resultSummary: { kind: "no-output" } }, texts).result,
    texts.recordNoOutput,
  );
  // 失败 → 结果那栏是错误码
  assert.strictEqual(
    trajectoryCellContent({ ...tool, resultPreviewMarkdown: undefined, result: "EACCES" }, texts).result,
    "EACCES",
  );
}
console.log("trajectoryDisplay: 用户 / 工具行的官方拼接（附件摘要 · 参数 · 结果预览） ✓");

// ---------- 14. 工具目录变更行（`developer/message` 的 tool-addition / tool-removal） ----------
//
// 判据与文案逐条对齐官方 `inputCellDetail()` 的工具目录分支。真实证据：438 份本机
// 会话日志里 52 份含 `tool-addition`、13 份含 `tool-removal`，形状就是下面这条。
{
  seq = 0;
  const registry = (...content: { type: string; toolName?: string }[]) =>
    event("developer/message", { turn: 0, step: 0, message: { source: { kind: "tool-registry" }, content } }, 0);
  const events: SessionWireEvent[] = [
    event("turn/start", { turn: 0 }, 0),
    registry({ type: "tool-addition", toolName: "read" }),
    registry({ type: "tool-removal", toolName: "bash" }),
    registry(
      { type: "tool-addition", toolName: "read" },
      { type: "tool-addition", toolName: "edit" },
      { type: "tool-removal", toolName: "bash" },
    ),
    // 内容块不是 tool-* → 不是目录变更，整条不出行（官方只在「全部是这两类」时才认）
    registry({ type: "text", toolName: "" }),
    event("turn/end", { turn: 0, reason: "success" }, 0),
  ];
  const cells = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
  assert.strictEqual(cells.length, 3, "第四条不是目录变更 → 不出行");
  assert.strictEqual(cells[0].kind, "context", "官方把它归成 context 记录");
  assert.deepStrictEqual(cells[0].toolUpdate, { added: ["read"], removed: [] });
  assert.deepStrictEqual(
    cells[0].sourceBlocks,
    [{ type: "tool-addition", content: "read" }],
    "原始块也留着（搜索索引按块索引工具名）",
  );
  assert.strictEqual(cells[0].messageSource?.kind, "tool-registry");
  assert.strictEqual(cells[0].timeSeconds, 0);

  // 单条 → 「已添加工具：X」/「已移除工具：X」
  assert.strictEqual(rowText(cells[0]), "已添加工具：read");
  assert.strictEqual(rowText(cells[1]), "已移除工具：bash");
  // 多条 → 「工具已更新 · <计数摘要>」
  assert.strictEqual(rowText(cells[2]), "工具已更新 · 新增 2 个，移除 1 个");
  assert.strictEqual(trajectoryCellContent(cells[2], en).text, "Tools updated · 2 added, 1 removed");
  // 参数页正文（官方那份 `inputDetail`，一行新增一行移除）
  assert.strictEqual(
    trajectoryToolUpdateParams(cells[2].toolUpdate as never, texts),
    "新增：read, edit\n移除：bash",
  );
  // 只有新增的多条 → 「新增 N 个」；只有移除的多条 → 「移除 N 个」
  assert.strictEqual(
    trajectoryCellContent({ ...cells[2], toolUpdate: { added: ["a", "b"], removed: [] } }, texts).text,
    "工具已更新 · 新增 2 个",
  );
  assert.strictEqual(
    trajectoryCellContent({ ...cells[2], toolUpdate: { added: [], removed: ["a", "b"] } }, texts).text,
    "工具已更新 · 移除 2 个",
  );
}
console.log("trajectoryDisplay: 工具目录变更行（单条 / 多条 / 混合） ✓");

// ---------- 组标题与轮次折叠摘要（官方 group.* 文案 + summarizeTurn 的组口径） ----------
{
  assert.strictEqual(trajectoryGroupTitle({ kind: "message" }, texts), "消息");
  assert.strictEqual(trajectoryGroupTitle({ kind: "step", step: 3 }, texts), "第 3 步");
  assert.strictEqual(trajectoryGroupTitle({ kind: "compaction", seq: 7 }, texts), "压缩 7");
  assert.strictEqual(trajectoryGroupTitle({ kind: "step", step: 3 }, en), "Step 3");
  assert.strictEqual(trajectoryGroupTitle({ kind: "message" }, en), "Message");

  /**
   * 摘要的**步骤数只数带请求的步骤组 / 压缩组**。
   *
   * 关键在排除消息组：本扩展的用户 / 上下文行**也挂请求号**（「每一行都挂得上请求」），
   * 若按「任何带请求号的组」去数，第一组（消息组里的用户行 + 第 0 步助手）会被多算一步。
   */
  seq = 0;
  const userMessage = (text: string) => ({ id: `u${seq}`, role: "user", content: blocks({ type: "text", text }), source: { kind: "user" } });
  const model = deriveTrajectoryModel([
    event("turn/start", { turn: 0 }, 0),
    event("step/start", { turn: 0, step: 0 }, 0),
    event("user/message", userMessage("第一句"), 1),
    event("assistant/message", { turn: 0, step: 0, message: { role: "assistant", content: blocks({ type: "text", text: "答" }) } }, 2),
    event("step/start", { turn: 0, step: 1 }, 3),
    event("assistant/message", { turn: 0, step: 1, message: { role: "assistant", content: blocks({ type: "text", text: "第二答" }) } }, 4),
    event("tool/call", { turn: 0, step: 1, callId: "c1", name: "read", arguments: "{}" }, 5),
    event("turn/end", { turn: 0, reason: "success" }, 6),
  ], false);
  assert.strictEqual(
    trajectoryTurnSummary(model.turns[0], texts),
    "1 个步骤 · 1 个工具调用",
    "只数带请求的**步骤组**：消息组里那些挂请求号的记录（用户行、第 0 步助手）不算，"
    + "不排除的话这里会数成 2",
  );
}
console.log("trajectoryDisplay: 组标题与折叠摘要（只数步骤组） ✓");

// ---------- 轮次标签落在哪条记录上（官方 turnStart） ----------
/**
 * 官方不是在轮次第一行画标签，而是在**第一条像样的记录**上：跳过 `requestOnly` 与
 * `system`，压缩行也跳过——除非这一段不属于任何轮次（「轮次之间」本来就靠压缩行起头）。
 * 照「第一行」画的话，以「系统提示词已更新」开头的轮次会把标签画在提示词行上。
 */
{
  const base: TrajectoryCell = {
    index: 1,
    kind: "user",
    turn: 1,
    seq: 1,
    time: 0,
    text: "",
    timeSeconds: null,
    startedAt: null,
  };
  const of = (kind: TrajectoryCell["kind"], turn: number | null, extra: Partial<TrajectoryCell> = {}) => ({
    ...base,
    kind,
    turn,
    ...extra,
  });

  assert.strictEqual(trajectoryTurnStartsLabel(of("system", 1), 1), false, "系统行不顶标签");
  assert.strictEqual(
    trajectoryTurnStartsLabel(of("message", 1, { requestOnly: true }), 1),
    false,
    "requestOnly 请求锚点行不顶标签",
  );
  assert.strictEqual(trajectoryTurnStartsLabel(of("compacted", 1), 1), false, "轮内的压缩行不顶标签");
  assert.strictEqual(trajectoryTurnStartsLabel(of("compacted", null), null), true, "「轮次之间」那一段靠压缩行起头");
  assert.strictEqual(trajectoryTurnStartsLabel(of("user", 1), 1), true);
  assert.strictEqual(trajectoryTurnStartsLabel(of("message", 1), 1), true);
  assert.strictEqual(trajectoryTurnStartsLabel(of("tool", 1), 1), true);
  assert.strictEqual(trajectoryTurnStartsLabel(of("subtool", 1), 1), true);
  assert.strictEqual(trajectoryTurnStartsLabel(of("context", 1), 1), true);
}
console.log("trajectoryDisplay: 轮次标签的落点（官方 turnStart） ✓");

// ---------- 账本行的无障碍名字（官方 request.rowAria 一族） ----------
/**
 * 官方在账本行上挂的 `aria-label` 是一整句「请求 #N，种类，内容」——读屏按行读时拿的是
 * 它，而不是把事件格与内容格里那几枚碎片（轮次标签、`#N`、种类徽章、正文）逐个念出来。
 * 三个分支都要钉住，其中「请求锚点行给专用那句」与「内容为空兜底成『无内容』」这两条
 * 最容易在改行文本时被顺手漏掉（漏了读屏会念出「请求 3，已压缩，」这种半句话）。
 */
{
  const base: TrajectoryCell = {
    index: 1,
    kind: "user",
    turn: 1,
    seq: 1,
    time: 0,
    text: "",
    timeSeconds: null,
    startedAt: null,
  };
  const of = (kind: TrajectoryCell["kind"], extra: Partial<TrajectoryCell> = {}) => ({
    ...base,
    kind,
    ...extra,
  });

  assert.strictEqual(
    trajectoryRowLabel(of("user", { text: "把入口合起来" }), texts, 3),
    "请求 3，用户，把入口合起来",
    "带请求号的行读成「请求 #N，种类，内容」一句（官方 `rowPrefix` + `rowAria`）",
  );
  assert.strictEqual(
    trajectoryRowLabel(of("tool", { text: "read · {…}" }), en, 7),
    "Request 7, TOOL, read · {…}",
    "英文那本词典的拼接口径（前缀带后置逗号 + 空格，与中文的全角逗号不同）",
  );
  assert.strictEqual(
    trajectoryRowLabel(of("user", { text: "把入口合起来" }), texts, undefined),
    "用户，把入口合起来",
    "没有请求号时前半句整段省略（官方传的是空串），不留一个孤零零的逗号",
  );
  assert.strictEqual(
    trajectoryRowLabel(of("tool", { requestOnly: true }), texts, 4),
    "请求 4，压缩",
    "请求锚点行没有种类也没有内容，走官方的专用那句 `rowAriaCompaction`",
  );
  assert.strictEqual(
    trajectoryRowLabel(of("message", { emptySummary: { kind: "tool-call" } }), texts, 5),
    "请求 5，助手，无内容",
    "行文本为空（仅工具调用那类）时用「无内容」兜底，不能读出半句话",
  );
  assert.ok(
    trajectoryRowLabel(of("subtool", { text: "grep" }), texts, 6).includes(texts.kindSubtool),
    "种类词与徽章同一处取（`trajectoryTexts.kindLabel()`）——两处分开写会让读屏念的种类与屏幕上看到的不一致",
  );
}
console.log("trajectoryDisplay: 账本行无障碍名字（官方 rowAria / 无内容兜底 / 锚点行专用句） ✓");

// ---------- 检查器「错误」那一行：语义标记要换成文案，服务端原话原样显示 ----------
//
// 这一行是本扩展特有的（官方只在请求面板里显示错误）。宿主不知道界面语言，写进
// `cell.error` 的是**记号**——`@interrupted` 曾经被原样渲染，用户看到的是这个内部符号。
{
  const cellOf = (error: string | undefined) =>
    ({ index: 1, kind: "message", turn: 0, seq: 1, time: 0, text: "", timeSeconds: null, startedAt: null, ...(error === undefined ? {} : { error }) }) as TrajectoryCell;
  assert.strictEqual(
    trajectoryCellError(cellOf(undefined), texts),
    undefined,
    "没有错误就不出这一行",
  );
  assert.strictEqual(
    trajectoryCellError(cellOf("@interrupted"), texts),
    texts.detailsInterrupted,
    "`@interrupted` 这个宿主记号要换成文案（从前原样渲染，用户看到的是 `@interrupted`）",
  );
  assert.strictEqual(
    trajectoryCellError(cellOf(TRAJECTORY_COMPACTION_INTERRUPTED), texts),
    texts.compactionInterrupted,
    "压缩被中断的合成错误码与账本行同一句文案",
  );
  assert.strictEqual(
    trajectoryCellError(cellOf("max-tokens"), texts),
    "max-tokens",
    "服务端 / 运行时的原话**原样显示**，不翻译",
  );
  // 中英各有一条译文（双语硬规则）
  assert.ok(texts.detailsInterrupted.length > 0);
  assert.notStrictEqual(
    trajectoryTexts("en").detailsInterrupted,
    texts.detailsInterrupted,
    "「被中断」这一句必须有英文译文",
  );
}
console.log("trajectoryDisplay: 检查器错误行的语义标记与原文 ✓");

// ---------- PTC（`run_code`）：行文本是程序描述，不是参数 JSON ----------
//
// 官方 `recordDisplayText()` 在预览那一支**之前**先看 `codeProgram(cell)`：命中的行文本是
// `` `run_code · 描述` ``（描述压平空白），**不再**走 `text · previewMarkdown`。
//
// 本机**零样本**：450 份会话日志、57731 个工具/子工具行里 `run_code` 一次都没出现过
// （「所有参数里带 code / language 的调用」那 197 次全是无关的浏览器工具）。所以这一段
// 是这一刀唯一的防线——判据只能来自官方契约与官方单测（`code-program.client.spec.ts`）。
{
  const programCell = (extra: Partial<TrajectoryCell> = {}): TrajectoryCell =>
    ({
      index: 1,
      kind: "tool",
      turn: 0,
      seq: 1,
      time: 0,
      text: "run_code",
      toolName: "run_code",
      // 官方那条夹具的同款形状（换行 + 多空白，用来钉「压平空白」这一步）
      inputDetail: '{"code":"return 42\\n","description":"Compute\\n  the answer"}',
      timeSeconds: 1,
      startedAt: null,
      ...extra,
    }) as TrajectoryCell;

  assert.strictEqual(
    trajectoryCellContent(programCell(), texts).text,
    "run_code · Compute the answer",
    "行文本是「工具名 · 程序描述」（描述压平空白，与官方同一式）",
  );
  assert.strictEqual(
    trajectoryDisplayText(programCell(), texts),
    "run_code · Compute the answer",
    "同一支也走 `trajectoryDisplayText`（官方 `recordDisplayText` 就是它）",
  );
  // 反面：不命中时仍是 `name · preview(args)`（工具行的 `previewMarkdown` 是参数原文）
  assert.strictEqual(
    trajectoryCellContent(
      programCell({
        toolName: "read",
        text: "read",
        previewMarkdown: '{"code":"return 42\\n","description":"Compute\\n  the answer"}',
      }),
      texts,
    ).text,
    'read · {"code":"return 42\\n","description":"Compute\\n the answer"}',
    "别的工具照旧走 `name · preview(参数)`（预览那一支把值里的连续空白压成一个空格）",
  );
  // 描述缺失 → 回落源码首行（且同样是压平过的那一行）
  assert.strictEqual(
    trajectoryCellContent(
      programCell({ inputDetail: '{"code":"\\n  const x = 1\\nreturn x\\n"}' }),
      texts,
    ).text,
    "run_code · const x = 1",
    "没有描述时用源码第一行非空内容（官方 `codeProgram` 的回落）",
  );
  // 坏形状不特化：`code` 不是字符串时退回普通工具行
  assert.strictEqual(
    trajectoryCellContent(
      programCell({
        inputDetail: '{"code":42}',
        previewMarkdown: '{"code":42}',
      }),
      texts,
    ).text,
    'run_code · {"code":42}',
    "参数不是可用的程序时退回普通工具行（走预览那一支）",
  );
  // **有预览也不改口径**：官方那一支在预览之前就返回了，参数 JSON 不进列表文本
  assert.strictEqual(
    trajectoryCellContent(
      programCell({ previewMarkdown: '{"code":"return 42\\n","description":"Compute\\n  the answer"}' }),
      texts,
    ).text,
    "run_code · Compute the answer",
    "命中的行不吃 `text · previewMarkdown` 那一条（官方的顺序就是先判代码程序）",
  );
  // 语言标记取自**调用时**的 schema（官方只认「TypeScript / Python 二选一」）
  assert.strictEqual(
    trajectoryCodeProgram(programCell({
      schemaDetail: '{"parameters":{"properties":{"code":{"description":"The program: the body of an async TypeScript function."}}}}',
    }))?.language,
    "typescript",
  );
  assert.strictEqual(
    trajectoryCodeProgram(programCell({
      schemaDetail: '{"parameters":{"properties":{"code":{"description":"A TypeScript or Python program."}}}}',
    }))?.language,
    undefined,
    "两个都提到就不标语言（不猜）",
  );
  assert.strictEqual(trajectoryCodeProgram(programCell())?.language, undefined, "没记 schema 就不标语言");
}
console.log("trajectoryDisplay: PTC 行文本取程序描述（零样本，判据来自官方单测） ✓");

// ---------- 记录级计时的四条值（官方 `totalTime` / `ttft` / `generationTime` / `throughput`） ----------
//
// 四条值各有五种「缺哪一种证据」的分支，官方每种的文案都不同（不是一句笼统的
// 「未记录」），所以逐条钉住。这一族原先内联在 `Trajectory.tsx` 里，只能靠预览页手点；
// 挪进纯模块就是为了这里能离线断言。
{
  const metricsOf = (over: Partial<TrajectoryAssistantMetrics> = {}): TrajectoryAssistantMetrics => ({
    timingRecorded: true,
    stepStartTime: 1_000,
    firstTokenTime: 2_000,
    completedTime: 4_000,
    usageProvided: true,
    outputTokens: 100,
    ...over,
  });

  // 总时长：起点到收尾
  assert.strictEqual(
    trajectoryRecordTotalTime(metricsOf(), texts),
    texts.unitSeconds(3),
    "总时长 = 收尾时刻 − 步骤开始时刻",
  );
  assert.strictEqual(
    trajectoryRecordTotalTime(undefined, texts),
    texts.timingNotRecorded,
    "没有 metrics（没记录计时）→「未记录」",
  );
  assert.strictEqual(
    trajectoryRecordTotalTime(metricsOf({ timingRecorded: false }), texts),
    texts.timingNotRecorded,
  );
  assert.strictEqual(
    trajectoryRecordTotalTime(metricsOf({ stepStartTime: null }), texts),
    texts.timingStepStartUnavailable,
    "缺步骤开始时刻 → 这一族的前提不成立，各自报自己的那句",
  );
  assert.strictEqual(
    trajectoryRecordTotalTime(metricsOf({ completedTime: null }), texts),
    texts.statusPending,
  );

  // TTFT：**首个 token 相对步骤开始的时长**，不是时刻
  assert.strictEqual(trajectoryRecordTtft(metricsOf(), texts), texts.unitSeconds(1));
  assert.strictEqual(
    trajectoryRecordTtft(metricsOf({ stepStartTime: null }), texts),
    texts.timingStepStartUnavailable,
  );
  assert.strictEqual(
    trajectoryRecordTtft(metricsOf({ firstTokenTime: null }), texts),
    texts.timingFirstTokenUnavailable,
  );

  // 生成时长：首个 token 到收尾
  assert.strictEqual(trajectoryRecordGenerationTime(metricsOf(), texts), texts.unitSeconds(2));
  assert.strictEqual(
    trajectoryRecordGenerationTime(metricsOf({ firstTokenTime: null }), texts),
    texts.timingFirstTokenUnavailable,
  );
  assert.strictEqual(
    trajectoryRecordGenerationTime(metricsOf({ completedTime: null }), texts),
    texts.statusPending,
  );

  // 吞吐量：输出 token 数 ÷ 解码时长（官方 `throughput()` 的五道守卫顺序）
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf(), texts),
    texts.unitTokensPerSecond("50.0"),
    "100 token / 2 秒 = 50.0 tok/s",
  );
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf({ usageProvided: false }), texts),
    texts.timingUsageUnavailable,
    "没有用量 → 「用量不可用」（不是「输出 token 数不可用」）",
  );
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf({ outputTokens: null }), texts),
    texts.timingOutputTokensUnavailable,
  );
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf({ timingRecorded: false }), texts),
    texts.timingFirstTokenUnavailable,
  );
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf({ firstTokenTime: null }), texts),
    texts.timingFirstTokenUnavailable,
  );
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf({ completedTime: null }), texts),
    texts.statusPending,
  );
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf({ completedTime: 2_000 }), texts),
    texts.timingDurationTooShort,
    "解码时长为 0 → 「时长过短」，不是除以零得到 Infinity",
  );
  // 中英各一条（双语硬规则：这两句都在词典里，不是拼出来的）
  assert.strictEqual(
    trajectoryRecordThroughput(metricsOf(), en),
    en.unitTokensPerSecond("50.0"),
  );
}
console.log("trajectoryDisplay: 记录级计时的四条值（每条各自的「不可用」） ✓");

// ---------- 请求 → 它那批账本记录（官方 `selectedRequestRecordTemplates`） ----------
//
// 请求面板的计时按这批记录挑助手记录（官方 `selectedRequestAssistant`：第一条
// `kind === 'message'`），挑不出来才回落成请求表自己那三行。
{
  const cellOf = (index: number, kind: string, requestNumber?: number): TrajectoryCell =>
    ({
      index,
      kind,
      turn: 0,
      seq: index,
      time: index,
      text: "",
      timeSeconds: null,
      startedAt: null,
      ...(requestNumber === undefined ? {} : { requestNumber }),
    }) as TrajectoryCell;
  const cells = [
    cellOf(1, "user", 1),
    cellOf(2, "message", 1),
    cellOf(3, "tool", 1),
    cellOf(4, "message", 2),
    cellOf(5, "compacted", 3),
    cellOf(6, "system"),
  ];
  assert.deepStrictEqual(
    trajectoryRequestCells(cells, 1).map((cell) => cell.index),
    [1, 2, 3],
    "按请求号筛出整批记录（含请求边界那条与它之后的工具行）",
  );
  assert.deepStrictEqual(trajectoryRequestCells(cells, 3).map((cell) => cell.index), [5]);
  assert.deepStrictEqual(trajectoryRequestCells(cells, 9), [], "没有这个请求号就是空数组");
  // 官方挑助手记录的判据：这批记录里**第一条** `message`
  assert.strictEqual(
    trajectoryRequestCells(cells, 1).find((cell) => cell.kind === "message")?.index,
    2,
  );
  assert.strictEqual(
    trajectoryRequestCells(cells, 3).find((cell) => cell.kind === "message"),
    undefined,
    "压缩请求没有助手记录 → 请求面板走请求表那一支",
  );
}
console.log("trajectoryDisplay: 请求 → 记录（助手记录与落点的挑法） ✓");

// ---------- 「原始内容」页签的逐块渲染（官方 `MarkdownRecordContent` 的第二分支） ----------
//
// 两条判据与两条排除，逐条对官方那一处：
// - 有块 → 整块改用 `SourceBlocks`（不是「加在下面」）；
// - **全是工具目录变更的块** → 官方第一分支优先，那一格显示参数文本（排除，见
//   `trajectoryUsesSourceBlocks()` 的第一条）。
{
  const cellOf = (sourceBlocks?: TrajectoryCell["sourceBlocks"]): TrajectoryCell =>
    ({
      index: 1,
      kind: "message",
      turn: 0,
      seq: 1,
      time: 1,
      text: "",
      timeSeconds: null,
      startedAt: null,
      ...(sourceBlocks === undefined ? {} : { sourceBlocks }),
    }) as TrajectoryCell;

  // 真实分布里最大的一类块组合（`reasoning,tool-call`）走逐块
  const realCell = foldAssistant(
    { type: "reasoning", text: "先想一下" },
    { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
  );
  assert.strictEqual(
    trajectoryUsesSourceBlocks(realCell),
    true,
    "有原始块 → 「原始内容」页签走逐块排版（官方同一分支）",
  );
  assert.strictEqual(
    trajectoryUsesSourceBlocks(cellOf(undefined)),
    false,
    "没有块 → 落回那段裸文本",
  );
  assert.strictEqual(trajectoryUsesSourceBlocks(cellOf([])), false, "空数组同样落回裸文本");
  assert.strictEqual(
    trajectoryUsesSourceBlocks(cellOf([{ type: "tool-addition", content: "read" }])),
    false,
    "全是工具目录变更的块 → 走参数文本那条路（官方第一分支优先命中，逐块会排出「块 #1 tool-addition / read」这种比正文还长的形式）",
  );
  assert.strictEqual(
    trajectoryUsesSourceBlocks(cellOf([
      { type: "tool-addition", content: "read" },
      { type: "tool-removal", content: "grep" },
    ])),
    false,
  );
  assert.strictEqual(
    trajectoryUsesSourceBlocks(cellOf([
      { type: "text", content: "正文" },
      { type: "tool-addition", content: "read" },
    ])),
    true,
    "混着正文的块**不进**那条排除：只要不是**全部**为目录变更，就照逐块排",
  );

  // 块标题：`块 #{序号} {类型}`，序号从 1 起，类型原样不翻译
  assert.strictEqual(
    trajectoryBlockLabel({ type: "thinking", content: "想" }, 0, texts),
    "块 #1 thinking",
    "块序号从 1 起、类型串原样（这一页是拿轨迹核对日志的地方，写类型串才能与日志对上）",
  );
  assert.strictEqual(
    trajectoryBlockLabel({ type: "tool-call", content: "{}" }, 2, texts),
    "块 #3 tool-call",
  );
  assert.strictEqual(
    trajectoryBlockLabel({ type: "unknown", content: "?" }, 0, en),
    "Block #1 unknown",
    "英文同一形态（语序一致，但两本词典各有一条）",
  );
  assert.strictEqual(
    trajectoryBlockOpenLabel(2, texts),
    "打开第 3 个块的工具调用概述",
    "跳转按钮的无障碍名字用块序号（官方 block.openSummary 的 {index}）",
  );
  assert.strictEqual(trajectoryBlockOpenLabel(2, en), "Open Block #3 tool call summary");
  assert.strictEqual(texts.blockOpenSummaryTitle, "打开工具调用概述", "同一枚按钮的悬停说明不带序号");
}
console.log("trajectoryDisplay: 「原始内容」逐块渲染的判据与块标题 ✓");

// ---------- 助手概述里「请求计时」那一节的跳转目标（官方 selectedAssistantRequestTarget） ----------
//
// 三条守卫各自的错误形态都是**静默的**：多给一节 → 点过去是另一次请求的计时；
// 少给一节 → 这一个功能看起来没做。所以逐条钉住。
{
  const cellOf = (kind: string, requestNumber?: number): TrajectoryCell =>
    ({
      index: 1, kind, turn: 0, seq: 1, time: 1, text: "",
      timeSeconds: null, startedAt: null,
      ...(requestNumber === undefined ? {} : { requestNumber }),
    }) as TrajectoryCell;
  const known = new Set([1, 2]);

  assert.strictEqual(
    trajectoryAssistantRequestNumber(cellOf("message", 2), known),
    2,
    "助手记录 + 请求号能在请求表里解析出来 → 给这一节，跳该请求的计时页签",
  );
  assert.strictEqual(
    trajectoryAssistantRequestNumber(cellOf("message"), known),
    undefined,
    "没有请求号 → 不出这一节（没有可跳的对象）",
  );
  assert.strictEqual(
    trajectoryAssistantRequestNumber(cellOf("message", 9), known),
    undefined,
    "请求号在请求表里解析不出来 → 不出（**不兜底到别的请求**：点过去是另一次请求的计时）",
  );
  assert.strictEqual(
    trajectoryAssistantRequestNumber(cellOf("compacted", 1), known),
    undefined,
    "压缩行不给（官方那条判据也是 `kind === 'message'`）：它带的号是**压缩请求**的号，拿它当「这次请求的计时」是对错了对象",
  );
  for (const kind of ["user", "context", "system", "tool", "subtool"]) {
    assert.strictEqual(
      trajectoryAssistantRequestNumber(cellOf(kind, 1), known),
      undefined,
      `${kind} 行不给这一节（只有助手记录有「它那次请求」这回事）`,
    );
  }
  assert.strictEqual(
    trajectoryAssistantRequestNumber(cellOf("message", 2), new Set()),
    undefined,
    "请求表为空（老账本 / 宿主还没折出请求号）→ 不出这一节，也不崩",
  );
}
console.log("trajectoryDisplay: 助手概述「请求计时」那一节的跳转目标 ✓");

// ---------- 调用折叠的摘要正文（官方 `summarizeAssistantTools()`） ----------
//
// 「调用折叠」摘要行的整句 = `collapsedSummary(collapsedAssistant, 正文)`；正文这一层
// 是取词与名字口径的唯一出处（组件与账本行投影都用它，不存在第二份镜像算法）。
{
  const call = (index: number, kind: TrajectoryCell["kind"], text: string): TrajectoryCell => ({
    index,
    kind,
    turn: 0,
    seq: index,
    time: index * 1000,
    text,
    timeSeconds: null,
    startedAt: null,
  });
  const calls = [
    call(1, "tool", 'read · {"file_path":"a.ts"}'),
    call(2, "subtool", 'grep · {"pattern":"listen"}'),
    call(3, "tool", 'read · {"file_path":"b.ts"}'),
  ];
  assert.strictEqual(
    trajectoryAssistantSummary(calls, texts),
    "3 个工具调用 · read, grep",
    "名字取 `cell.text` 第一个 ` · ` 之前那一段（官方逐字口径），同名只留一次、按账本顺序",
  );
  assert.strictEqual(trajectoryAssistantSummary(calls, en), "3 tool calls · read, grep", "英文走官方的复数档");
  assert.strictEqual(trajectoryAssistantSummary([call(1, "tool", "read")], texts), "1 个工具调用 · read");
  assert.strictEqual(trajectoryAssistantSummary([call(1, "tool", "read")], en), "1 tool call · read", "英文单数档（官方 one）");
  assert.strictEqual(
    trajectoryAssistantSummary([call(1, "tool", ""), call(2, "subtool", "grep · {}")], texts),
    "2 个工具调用 · grep",
    "名字为空的那条不进清单——也不留下多余的分隔符",
  );
  // 整句（组件同式）与轮摘要同一套外壳
  assert.strictEqual(
    texts.collapsedSummary(texts.collapsedAssistant, trajectoryAssistantSummary(calls, texts)),
    "已收起的助手概述，3 个工具调用 · read, grep",
    "整句用官方 `request.collapsedSummary` + `request.collapsedAssistant`（助手）",
  );
  assert.strictEqual(
    en.collapsedSummary(en.collapsedAssistant, trajectoryAssistantSummary(calls, en)),
    "Collapsed assistant summary, 3 tool calls · read, grep",
    "英文整句（官方 `request.collapsedAssistant` = assistant）",
  );
}
console.log("trajectoryDisplay: 调用折叠摘要（计数 + 工具名清单 + 双语整句）✓");

// ---------- 请求概述的两行计数（官方 `details.toolCalls` / `details.subtoolCalls`） ----------
//
// 计数与请求面板的落点、计时走**同一个身份 seam**（`trajectoryRequestCells`：按请求号
// 筛账本行），所以工具 / 子工具分开数、别的种类一条都不算，也不会混进别的请求。
{
  const entry = (index: number, kind: TrajectoryCell["kind"], requestNumber?: number): TrajectoryCell => ({
    index,
    kind,
    turn: 0,
    seq: index,
    time: index * 1000,
    text: `#${index}`,
    timeSeconds: null,
    startedAt: null,
    ...(requestNumber === undefined ? {} : { requestNumber }),
  });
  const flat: TrajectoryCell[] = [
    entry(1, "message", 1),
    entry(2, "tool", 1),
    entry(3, "subtool", 1),
    entry(4, "tool", 1),
    entry(5, "context", 1),
    entry(6, "compacted", 2),
    entry(7, "message", 3),
    entry(8, "subtool", 3),
    entry(9, "tool"),
  ];
  assert.deepStrictEqual(
    trajectoryRequestCallCounts(flat, 1),
    { toolCalls: 2, subtoolCalls: 1 },
    "工具与子工具**分开**数；助手消息 / 上下文行一条都不算",
  );
  assert.deepStrictEqual(
    trajectoryRequestCallCounts(flat, 2),
    { toolCalls: 0, subtoolCalls: 0 },
    "压缩请求：压缩行不是工具调用，也不混成助手（只是计数为 0）",
  );
  assert.deepStrictEqual(
    trajectoryRequestCallCounts(flat, 3),
    { toolCalls: 0, subtoolCalls: 1 },
    "只带子工具的请求：工具 0 / 子工具 1（两行各自独立）",
  );
  assert.deepStrictEqual(
    trajectoryRequestCallCounts(flat, 99),
    { toolCalls: 0, subtoolCalls: 0 },
    "请求表里没有的号 → 两项 0（不兜底到别的请求）",
  );
  trajectoryRequestCallCounts(flat, 1);
  assert.deepStrictEqual(
    trajectoryRequestCallCounts(flat, 2),
    { toolCalls: 0, subtoolCalls: 0 },
    "连续取两个请求：后一个不残留前一个的计数（组件按当前请求现算）",
  );
  // 与**真实折叠模型**对拍：计数批 = 该请求记录批里的 tool / subtool 条数
  {
    seq = 0;
    const events: SessionWireEvent[] = [
      event("turn/start", { turn: 0 }, 0),
      event("step/start", { turn: 0, step: 0 }, 0),
      event("user/message", { id: "u1", role: "user", content: [{ type: "text", text: "问" }], source: { kind: "user" } }, 1),
      assistant({ type: "text", text: "答" }, { type: "tool-call", id: "call_1", name: "read", arguments: "{}" }),
      event("tool/result", { callId: "call_1", content: [{ type: "text", text: "ok" }] }, 3),
      event("turn/end", { turn: 0, reason: "success" }, 4),
    ];
    const real = deriveTrajectoryModel(events, false).turns.flatMap(trajectoryTurnCells);
    const number = real.find((cell) => cell.kind === "message")?.requestNumber;
    assert.ok(number !== undefined, "真实折叠要给助手行挂上请求号（否则这条对拍无从谈起）");
    const batch = trajectoryRequestCells(real, number as number);
    assert.deepStrictEqual(
      trajectoryRequestCallCounts(real, number as number),
      {
        toolCalls: batch.filter((cell) => cell.kind === "tool").length,
        subtoolCalls: batch.filter((cell) => cell.kind === "subtool").length,
      },
      "计数与 `trajectoryRequestCells` 是同一批记录（同一个 seam，不是另算一份）",
    );
    assert.ok((trajectoryRequestCallCounts(real, number as number).toolCalls ?? 0) >= 1, "本次真实折叠里确实有一条工具调用");
  }
}
console.log("trajectoryDisplay: 请求概述两行计数（工具 / 子工具分开、按请求号现算）✓");

// ---------- 接线（不是行为判据）：请求概述真的接上了计数与官方的「结果」行 ----------
//
// 行为判据在上面两段；这里只防「算好了没接」「文案写死在组件里」「旧的死键又长回来」，
// 以及防两本词典只补了一本（TS 的接口能挡一半，但键被删掉时它挡不住）。
{
  const view = readFileSync(join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"), "utf8");
  assert.ok(
    /trajectoryRequestCallCounts\(requestCellsAll, selectedRequestInfo\.number\)/.test(view),
    "请求概述的两行计数要按**当前请求**从账本现算（切换请求不残留）",
  );
  assert.ok(
    /texts\.detailsToolCalls/.test(view) && /texts\.detailsSubtoolCalls/.test(view),
    "两行计数的标签走词典，不在组件里写死文案",
  );
  assert.ok(
    /texts\.detailsResult/.test(view) && /texts\.detailsAssistantMessage/.test(view) && /texts\.detailsCompacted/.test(view),
    "跳转行按官方 `details.result`：行标签「结果」+ 链接「助手消息 / 已压缩」",
  );
  assert.ok(!/requestAnchor/.test(view), "旧的 `requestAnchor` 文案不许再被引用（已随官方口径删除）");
  const dict = readFileSync(join(process.cwd(), "src", "webview", "trajectoryTexts.ts"), "utf8");
  for (const member of ["detailsToolCalls", "detailsSubtoolCalls", "detailsResult", "collapsedAssistant"]) {
    // 只数**词典条目**（`成员: "文案"`），接口成员的 `成员: string;` 不算
    const count = (dict.match(new RegExp(`\\n  ${member}: "`, "g")) ?? []).length;
    assert.strictEqual(count, 2, `${member} 必须在 zh / en 两本词典里各有一条（现在 ${count} 条）`);
  }
  assert.ok(!/requestAnchor/.test(dict), "`requestAnchor` 已从词典删除（避免死键）");
}
console.log("trajectoryDisplay: 请求概述接线（计数 / 结果跳转 / 双语在册 / 死键已删）✓");



console.log("\ntrajectoryDisplay: all assertions passed");
