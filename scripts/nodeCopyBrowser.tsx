/** 点击生产组件核验 copy 帧；供独立 jsdom realm 使用，不声称验证系统剪贴板。 */
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { MessageView, QuestionView, ToolCallView } from "../src/shared/chat";
import { Message } from "../src/webview/components/Message";
import { approvalCopyText, commandCopyText, pendingQuestionCopyText, planReviewRecordCopyText, ApprovalCard, CommandRow, InjectedRow, NoticeRow, QuestionCard, ThinkingRow, ToolRow, UnknownBlockRow } from "../src/webview/components/Rows";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

export async function run(): Promise<{ checks: number }> {
  let checks = 0;
  const check = (value: unknown, message: string): void => {
    checks += 1;
    if (!value) throw new Error(message);
  };
  const frames = (globalThis as typeof globalThis & { __copyFrames: { type: string; text?: string }[] }).__copyFrames;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const texts = dictionaryFor("zh");
  const render = (node: ReactNode): void => {
    flushSync(() => root.render(<TextsContext.Provider value={texts}>{node}</TextsContext.Provider>));
  };
  const reset = (node: ReactNode): void => { render(null); render(node); };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const opened = { open: true, openedWhileActive: false, setOpen: () => undefined };
  function clickCopy(selector = 'button[title="复制"]', index = 0): string {
    const button = host.querySelectorAll<HTMLButtonElement>(selector)[index] ?? null;
    check(button !== null, `存在复制按钮：${selector}`);
    check(button?.closest("button button") === null, "复制按钮不嵌套在折叠按钮中");
    const before = frames.length;
    flushSync(() => button!.click());
    check(frames.length === before + 1 && frames.at(-1)?.type === "copy", "只发送一帧 copy，不能触发回答或取消");
    check(button!.classList.contains("is-copied"), "成功沿用统一对勾状态");
    return frames.at(-1)!.text!;
  }
  const clearSelection = (): void => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  };
  try {
    check(commandCopyText({ name: "help", args: "", text: "" }) === "/help", "无命令结果时不添加空分隔");
    check(approvalCopyText("pwsh", "  ", "echo hello") === "pwsh\necho hello", "审批缺失字段不添加空行");
    check(planReviewRecordCopyText("", "reply") === "reply", "空计划记录只复制回答");
    check(planReviewRecordCopyText("plan", "") === "plan", "空回答记录只复制计划");
    const allQuestions = pendingQuestionCopyText([
      { id: "a", question: "first", options: [{ label: "A", description: "desc" }] },
      { id: "b", question: "second", options: [{ label: "B" }] },
    ], { a: ["A"] }, { b: "draft" }, { custom: "Custom answer" });
    check(allQuestions === "first\n[x] A — desc\n\nsecond\n[ ] B\n[x] Custom answer: draft", "逐题复制全部题目与当前填写状态，不混入回答记录措辞");
    const raw = "**第一行**\r\n\t第二行\n末尾  ";
    reset(<ThinkingRow node={opened} text={raw} streaming />);
    check(clickCopy() === raw, "思考复制完整原文，不复制折叠摘要或渲染文本");
    reset(<ThinkingRow node={opened} text="" />);
    check(host.querySelector('[title="复制"]') === null, "空思考不提供空复制");

    reset(<InjectedRow node={opened} injected={{ sourceKind: "system-prompt", text: raw }} />);
    check(clickCopy() === raw, "注入正文保留 CRLF / 缩进 / 尾空白");
    reset(<InjectedRow node={opened} injected={{ sourceKind: "skill-catalog", text: "", source: {
      entries: [{ name: "skill-a", description: "完整描述" }],
    } }} />);
    const structured = clickCopy();
    check(structured.includes("skill-a") && structured.includes("完整描述"), "纯结构化注入也能复制有效字段");
    // 复制入口与首个分段抬头同一行（用户 2026-11-05 口径）
    check(
      host.querySelector(".ctx-body .ctx-head .card-copy-actions > button") !== null,
      "结构化注入的复制入口落在分段抬头行右端",
    );
    check(
      host.querySelector(".ctx-body > .node-copy-actions") === null,
      "结构化注入不再为复制按钮单独占一行",
    );

    const skill: ToolCallView = { id: "skill", name: "skill", title: "skill", detail: "", status: "ok",
      output: "<skill_instructions>\n# Skill\n\t正文\n</skill_instructions>" };
    reset(<ToolRow node={opened} tool={skill} />);
    check(clickCopy() === "# Skill\n\t正文", "技能只复制 SKILL 原文，不带工具信封");

    reset(<CommandRow node={opened} command={{ commandId: "cmd", name: "help", args: "--all", state: "ok", text: "result\nnext" }} />);
    check(clickCopy() === "/help --all\n\nresult\nnext", "命令包含命令、参数和完整结果");
    // 复制入口与命令行同一行，不再自己占一行（用户 2026-11-05 口径）
    check(
      host.querySelector(".row-command-head .card-copy-actions > button") !== null,
      "命令的复制入口落在命令行行尾",
    );
    check(host.querySelector(".row-command .node-copy-actions") === null, "命令不再为复制按钮单独占一行");
    reset(<UnknownBlockRow node={opened} block={{ type: "future", json: '{\n  "keep": true\n}' }} />);
    check(clickCopy() === '{\n  "keep": true\n}', "未知块保留完整 JSON 原文");
    reset(<NoticeRow level="warn" text={raw} />);
    check(clickCopy() === raw, "提示复制完整当前文案");
    reset(<NoticeRow level="warn" text="" />);
    check(host.querySelector('[title="复制"]') === null, "空提示不提供空复制");

    reset(<ApprovalCard approval={{ requestId: "approve", toolName: "pwsh", reason: "reason", detail: "echo hello" }} />);
    const approval = clickCopy();
    check(["pwsh", "reason", "echo hello"].every((part) => approval.includes(part)), "审批包含工具、原因与参数");
    const question: QuestionView = { requestId: "q", state: "waiting", items: [{ id: "one", header: "方向",
      question: "选择哪个？", detail: "**背景**", options: [{ label: "A", description: "方案 A" }, { label: "B" }] }] };
    reset(<QuestionCard question={question} />);
    const prompt = clickCopy();
    check(["方向", "选择哪个？", "**背景**", "A", "方案 A", "B"].every((part) => prompt.includes(part)), "待答问卷包含题头、正文、详情与选项");
    check(!prompt.includes(texts.questionAnswerSkipped), "待答复制不把未提交草稿当成已跳过回答");
    // 复制入口与第一题题头同一行，不再自己占一行（用户 2026-11-05 口径）
    check(
      host.querySelectorAll(".question .question-head .card-copy-actions > button").length === 1,
      "待答问卷的复制入口落在题头行右端",
    );
    check(host.querySelector(".question .node-copy-actions") === null, "待答问卷不再为复制按钮单独占一行");
    const plan: QuestionView = { requestId: "plan", state: "waiting", items: [{ id: "p", question: "同意计划？",
      detail: "# Plan\n\n- step", options: [{ label: "Approve" }], intent: { kind: "plan-review", approve: "Approve" } }] };
    reset(<QuestionCard question={plan} />);
    check(clickCopy().includes("# Plan\n\n- step"), "待审计划包含完整 Markdown 原文");
    reset(<QuestionCard question={{ ...plan, state: "answered", answers: { p: { selected: ["Approve"] } } }} />);
    const recordHead = host.querySelector<HTMLButtonElement>(".row-head");
    flushSync(() => recordHead!.click());
    const record = clickCopy();
    check(record.includes("# Plan\n\n- step") && record.includes("Approve"), "计划记录同时复制计划正文与已提交回答");
    // 记录卡展开后同样与第一题题头同一行（用户 2026-11-05 口径）
    check(
      host.querySelectorAll(".question.is-record .question-head .card-copy-actions > button").length === 1,
      "记录卡的复制入口落在第一题题头行右端",
    );
    check(host.querySelector(".question-record-actions") === null, "记录卡不再为复制按钮单独占一行");

    const message: MessageView = { id: "assistant", role: "assistant", ts: 1, segments: [
      { id: "t1", kind: "text", text: "**before**\n\n第二自然段" },
      { id: "tool", kind: "tool", tool: { id: "tool", name: "read", title: "read", detail: "a", status: "ok", output: "tool body" } },
      { id: "t2", kind: "text", text: "after\n" },
    ] };
    reset(<Message message={message} turnProcessThreshold={0} />);
    check(host.querySelectorAll(".segment-copy-actions").length === 0, "中间正文不挂复制按钮");
    check(
      clickCopy('.msg-actions button[title="复制"]') === "after\n",
      "回答末尾只复制最后一段正文，不拼工具与前文",
    );
    check(host.querySelectorAll('.msg-actions button[title="复制"]').length === 1, "轮尾只有一枚复制入口");
    // 换 key 创建独立实例，避免已复制防抖影响后续断言。
    reset(<Message message={{ ...message, segments: [{ id: "empty", kind: "text", text: " \n\t" }] }} />);
    check(host.querySelector('.msg-actions button[title="复制"]') === null, "没有正文的轮不画复制按钮");
    reset(<Message message={{ id: "user", role: "user", ts: 1, text: raw, segments: [] }} />);
    check(clickCopy() === raw, "用户气泡仍提供整条原文复制");

    // 流式期间不画轮尾操作行（复制入口随它一起不出现），正文仍按选区冻结渲染。
    const streaming: MessageView = { id: "stream", role: "assistant", ts: 1, streaming: true,
      segments: [{ id: "s", kind: "text", text: "visible **raw**" }] };
    reset(<Message message={streaming} />);
    check(host.querySelector('.msg-actions button[title="复制"]') === null, "生成过程中没有轮尾复制入口");
    const paragraph = host.querySelector(".md-wrapper p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    render(<Message message={{ ...streaming, segments: [{ id: "s", kind: "text", text: "visible **raw** + new" }] }} />);
    check(host.querySelector(".md-wrapper p")?.textContent === "visible raw", "流式划选时冻结当前显示正文");
    clearSelection();
    await tick();
    check(host.querySelector(".md-wrapper p")?.textContent === "visible raw + new", "选区解除后恢复最新正文");
  } finally {
    clearSelection();
    flushSync(() => root.unmount());
    host.remove();
  }
  return { checks };
}
