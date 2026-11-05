/** 生产记录入口的点击判据；同一入口可在 Chromium 中执行，不用 jsdom 证明布局。 */
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { MessageView, QuestionView } from "../src/shared/chat";
import type { WebviewToHost } from "../src/shared/ipc";
import { Message } from "../src/webview/components/Message";
import { QuestionCard } from "../src/webview/components/Rows";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

export function run(): { checks: number } {
  let checks = 0;
  const check = (value: unknown, message: string): void => {
    checks += 1;
    if (!value) throw new Error(message);
  };
  const frames = (globalThis as typeof globalThis & { __questionFrames: WebviewToHost[] }).__questionFrames;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let locale: "zh" | "en" = "zh";
  const render = (node: ReactNode): void => {
    flushSync(() => root.render(<TextsContext.Provider value={dictionaryFor(locale)}>{node}</TextsContext.Provider>));
  };
  const reset = (node: ReactNode): void => { render(null); render(node); };
  const click = (button: HTMLButtonElement | null | undefined): void => {
    check(button !== null && button !== undefined && !button.disabled, `目标按钮存在且可点击（检查 ${checks + 1}，${host.textContent}）`);
    flushSync(() => button!.click());
  };
  const byText = (text: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
  const next = (): void => click(byText(dictionaryFor(locale).questionNext));
  const prev = (): void => click(byText(dictionaryFor(locale).questionPrev));
  const checkPage = (text: string): void => {
    check(host.querySelectorAll(".question-item").length === 1, "逐题模式只挂载一题，不是用 CSS 隐藏其余题");
    check(host.querySelector(".question-text")?.textContent === text, `当前题为 ${text}`);
    check([...host.querySelectorAll<HTMLButtonElement>("button.question-option")].every((button) => button.disabled), "记录选项始终只读");
    check(host.querySelector("textarea") === null, "记录不出现可编辑的输入框");
  };
  const question: QuestionView = {
    requestId: "record", state: "answered",
    items: [
      { id: "first", header: "测试题一", question: "第一题", options: [{ label: "A" }, { label: "B" }] },
      { id: "second", header: "测试题二", question: "第二题", options: [{ label: "C" }, { label: "D" }] },
    ],
    answers: { first: { selected: ["A"] }, second: { selected: ["C"], custom: "当时的补充回答" } },
  };
  const messageOf = (value: QuestionView, kind: "tool" | "question"): MessageView => ({
    id: "message", role: "assistant", ts: 1,
    segments: [kind === "question" ? { id: "question:record", kind, question: value } : {
      id: "tool:record", kind, tool: {
        id: "record", name: "ask_user_question", title: "", detail: "", status: "ok", question: value,
      },
    }],
  });
  const record = (batch: number | undefined, kind: "tool" | "question" = "tool", value = question): ReactNode =>
    <Message message={messageOf(value, kind)} questionBatch={batch} turnProcessThreshold={0} />;
  const head = (): HTMLButtonElement | null => host.querySelector(".row-head");
  try {
    for (const language of ["zh", "en"] as const) {
      locale = language;
      for (const kind of ["tool", "question"] as const) {
        for (const batch of [1, undefined, -1, 1.5, Number.NaN]) {
          reset(record(batch, kind));
          check(head()?.getAttribute("aria-expanded") === "false", "两题阈值 1/缺省/坏值：外层默认收起");
          click(head());
          check(head()?.getAttribute("aria-expanded") === "true", "真实点击已展开记录");
          check(host.querySelectorAll(".question.is-record .question-item").length === 1,
            "questionBatch=1：点开两题已答记录后只能显示一题，不能铺开全部题目");
          checkPage("第一题");
          check(byText(dictionaryFor(locale).questionPrev)?.disabled, "第一题上一题禁用");
          check(host.querySelector(".question-option.is-selected")?.textContent === "A", "第一题显示权威答案 A");
          const before = frames.length;
          next();
          checkPage("第二题");
          check(byText(dictionaryFor(locale).questionNext)?.disabled, "最后一题下一题禁用");
          check(host.querySelector(".question-step")?.textContent === dictionaryFor(locale).questionStep(2, 2), "页码正确");
          check(host.querySelector(".question-option.is-selected")?.textContent === "C", "第二题显示权威答案 C");
          check(host.textContent?.includes("当时的补充回答"), "自定义回答随当前题只读显示");
          prev();
          checkPage("第一题");
          check(frames.length === before, "翻页不发送回答、取消或其它宿主帧");
          next();
          const copy = host.querySelector<HTMLButtonElement>('.card-copy-actions button');
          click(copy);
          const copied = frames.at(-1);
          check(copied?.type === "copy" && ["测试题一", "A", "测试题二", "C", "当时的补充回答"].every((part) => copied.text.includes(part)),
            "在第二题复制仍带走完整问卷，不只复制当前页");
        }
        for (const batch of [2, 3, 0]) {
          reset(record(batch, kind));
          check(head()?.getAttribute("aria-expanded") === "true", "阈值内/0 默认展开");
          check(host.querySelectorAll(".question-item").length === 2, "阈值内/0 同时显示全部题目");
          check(host.querySelector(".question-pager") === null, "一次展开时没有分页器");
        }
      }
    }
    locale = "zh";
    reset(record(1));
    click(head());
    next();
    render(record(0));
    check(host.querySelectorAll(".question-item").length === 2, "同一已手动展开实例切到 0 后显示全部");
    render(record(1));
    checkPage("第二题");
    const shorter = { ...question, items: question.items.slice(0, 1) };
    render(record(1, "tool", shorter));
    checkPage("第一题");
    check(host.querySelector(".question-pager") === null, "题数缩短后夹住下标且不留下空页");
    reset(record(1, "tool", { ...question, answers: {} }));
    click(head());
    next();
    checkPage("第二题");
    check(host.querySelector(".question-option.is-selected") === null, "未答题可自由复看，不伪造选项");
    reset(record(1, "tool", { ...question, state: "cancelled", answers: undefined }));
    click(head());
    next();
    checkPage("第二题");

    // 真实填写 → 提交帧 → 新消息记录；记录应从第一题开始，而不是继承提交页。
    const waiting: QuestionView = { ...question, state: "waiting", answers: undefined };
    reset(<QuestionCard question={waiting} batch={1} sessionId="offline" />);
    check(host.querySelectorAll(".question-item").length === 1, "新问卷仍一次一题");
    click(host.querySelector<HTMLButtonElement>(".question-option"));
    check(host.querySelector(".question-text")?.textContent === "第二题", "单选仍自动前进");
    click(host.querySelector<HTMLButtonElement>(".question-option"));
    click(byText(dictionaryFor(locale).submit));
    const submitted = frames.at(-1);
    check(submitted?.type === "answerQuestion" && submitted.answers.length === 2, "提交仍包含两道题的完整答案");
    if (submitted?.type !== "answerQuestion") throw new Error("未捕获提交帧");
    const completed: QuestionView = { ...waiting, state: "answered", answers: Object.fromEntries(submitted.answers.map(({ id, ...answer }) => [id, answer])) };
    render(record(1, "tool", completed));
    click(head());
    checkPage("第一题");
    // 同一组件从待答切成已答，也不能把最后的填写页当作首次复看页。
    reset(<QuestionCard question={waiting} batch={1} sessionId="offline" />);
    click(host.querySelector<HTMLButtonElement>(".question-option"));
    render(<QuestionCard question={completed} batch={1} sessionId="offline" />);
    click(head());
    checkPage("第一题");
    return { checks };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
}
