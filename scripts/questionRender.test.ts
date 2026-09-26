/**
 * 问卷卡片的**渲染**断言（服务端渲染，无浏览器）。
 *
 * 为什么要有这一层：`scripts/questionFlow.test.ts` 钉的是判据（选了没选、能不能提交），
 * 而用户 2026-09-15 报的两件事都发生在**渲染**上：
 *
 * 1. 「答完的问题展开后没有显示用户的回答」——消息流里那张记录卡与输入区那张卡是
 *    **两个组件实例**（`Message.tsx` 与 `Composer.tsx` 各自渲染一个）。答完之后输入区
 *    那张消失、记录那张是**全新实例**（本地 state 全空），所以选项与自定义回答都必须
 *    从 `question.answers` 里读。这里把「answers 进了渲染」真渲染一遍钉住。
 * 2. 「自定义回答要和其它选项一样可以被选择」——它必须是选项列表里的一行
 *    （`.question-option.question-custom`），且那一行是**组合组件**：标题
 *    「自定义回答」+ 多行输入框（用户 2026-09-15 口径）。
 *
 * 用 `react-dom/server` 的 `renderToStaticMarkup`：断言落在**产出的 HTML** 上而不是
 * 源码正则上——正则只能证明「代码里有这行字」，渲染能证明「用户真能看见」。
 *
 * **记录卡默认是收起的**（`Row` 只在 `open` 时挂载 children，用户 2026-09-14 的口径），
 * 所以「展开后长什么样」在无头环境里渲染不到：那一层的证据是这里第 2 组（同一对
 * `selectedOf` / `customOf` 读取器）+ `scripts/interactionSync.test.ts`（答案确实被写进
 * `question.answers`）+ 预览页 `test/preview.html`（夹具里带 answers，可肉眼核）。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuestionView } from "../src/shared/chat";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

// `bridge.ts` 在模块求值期就挂了 `window.addEventListener`（webview 里那是真实存在的
// 宿主）。无头环境里补一个最小 window，免得 import 阶段就炸——补在 import 之前。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { QuestionCard } = await import("../src/webview/components/Rows");
// 整条消息（含审批 / 提问两种交互段）：用来钉「只撤下被接管的那一条」（第 7 节）
const { Message } = await import("../src/webview/components/Message");
// 第 7 节的 `takenOver` 由公开入口现算（不手写段 id），选举 → 抑制 → 渲染一条链路都过一遍
const { resolveInteractions } = await import("../src/webview/pendingInteraction");

/** 渲染成 HTML；语言按真实链路给（`useTexts` 的默认是英文，这里显式喂词典）。 */
const render = (question: QuestionView, locale: "zh" | "en" = "zh"): string =>
  renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor(locale) },
      createElement(QuestionCard, { question, batch: 3 }),
    ),
  );

const items: QuestionView["items"] = [
  {
    id: "scope",
    header: "范围",
    question: "这次改动覆盖到哪一层？",
    options: [{ label: "只改入口文件" }, { label: "连同配置读取一起收敛" }],
  },
  {
    id: "docs",
    header: "文档",
    question: "要不要同步更新 README？",
    options: [{ label: "要" }, { label: "不要" }],
  },
];

const selectedLabels = (html: string): string[] =>
  [...html.matchAll(/<button class="question-option is-selected">[\s\S]*?<span class="question-option-label">([^<]*)<\/span>/g)].map(
    (match) => match[1],
  );

// ---------- 1. 待回答：自定义回答是选项列表里的一行（标题 + 多行输入框的组合） ----------
{
  const html = render({ requestId: "ev1", state: "waiting", items });
  // 用户 2026-09-15 口径：它是一个**组合组件**——标题「自定义回答」+ 多行输入框，
  // 整行是一个 `.question-option`（与普通选项同权，可选中 / 可取消选中）。
  const custom =
    /<div class="question-option question-custom">[\s\S]*?<span class="question-custom-title"[^>]*>自定义回答<\/span>[\s\S]*?<textarea class="question-input"[^>]*><\/textarea>/.exec(
      html,
    );
  assert.ok(
    custom,
    `自定义回答必须是「标题 + 多行输入框」的一行（.question-option.question-custom）：${
      html.slice(html.indexOf("question-custom"), html.indexOf("question-custom") + 400)
    }`,
  );
  // 每道题的自定义回答都在**该题的选项之后**（官方 `customRow` 同一个位置）。
  // 拿第一题的最后一个选项与第一行自定义回答比（跨题比较没有意义）。
  assert.ok(
    html.indexOf("question-custom") > html.indexOf("连同配置读取一起收敛"),
    "自定义回答排在普通选项**之后**（官方 `customRow` 同一个位置）",
  );
  assert.deepStrictEqual(selectedLabels(html), [], "还没选任何东西时没有选中态");
  assert.ok(
    !/question-custom is-selected/.test(html),
    "输入框里没字、也没点过它时，这一行不该是选中态（选中态与「有没有字」是两件事）",
  );
  assert.ok(html.includes("提交"), "提交按钮在");
  assert.ok(!html.includes("已作答"), "还在等回答时不该显示「已作答 N 题」");
}
console.log("questionRender: 待回答的自定义回答与选项同列表 ✓");

// ---------- 2. 有答案时，选项高亮与自定义文本都由 `question.answers` 驱动 ----------
//
// 这正是记录卡展开后要走的那对读取器（`selectedOf` / `customOf`）：本地 state 是空的，
// 只有 answers 能给出「用户当时选了什么 / 写了什么」。
{
  const html = render({
    requestId: "ev2",
    state: "waiting",
    items,
    answers: {
      scope: { selected: ["连同配置读取一起收敛"] },
      docs: { selected: [], custom: "顺手把分节标题也统一一下" },
    },
  });
  assert.deepStrictEqual(
    selectedLabels(html),
    ["连同配置读取一起收敛"],
    "answers 里选中的选项要渲染成选中态（记录卡本地 state 是空的，只能靠它）",
  );
  assert.ok(
    /<div class="question-option question-custom is-selected">[\s\S]*?<textarea class="question-input"[^>]*>顺手把分节标题也统一一下<\/textarea>/.test(
      html,
    ),
    "自定义回答的选中态与文本都要从 answers 里回填（此前它只活在输入框里，答完就没了）",
  );
}
console.log("questionRender: 选项高亮与自定义文本都由 answers 驱动 ✓");

// ---------- 3. 已答完：收缩成一行（正文不进首帧 HTML），摘要是「已作答 N 题」 ----------
{
  const html = render({
    requestId: "ev3",
    state: "answered",
    items,
    answers: { scope: { selected: ["一起收敛"] }, docs: { selected: ["要"] } },
  });
  assert.ok(html.includes("已作答 2 题"), `收场摘要要在：${html.slice(0, 240)}`);
  assert.ok(!html.includes("question-options"), "已答完默认**收起**（2026-09-14 口径），正文不挂载");
  assert.ok(!/<input/.test(html) && !/<textarea/.test(html), "收起时也不该有可编辑的输入框");
  // 行头可点开复看：aria-expanded=false 且是个按钮
  assert.ok(/<button class="row-head" aria-expanded="false">/.test(html), "行头是「可展开」的按钮");
}
console.log("questionRender: 已答完的问卷默认收起、摘要正确 ✓");

// ---------- 4. 已撤回：摘要与「已作答」分开 ----------
{
  const html = render({ requestId: "ev4", state: "cancelled", items });
  assert.ok(html.includes("已取消 2 题"), `撤回的问卷要说「已取消」：${html.slice(0, 240)}`);
  assert.ok(!html.includes("已作答"), "没人回答过就不能写「已作答」");
}
console.log("questionRender: 撤回的问卷与已作答分得开 ✓");

// ---------- 5. 多选：自定义回答同样在列表里 ----------
{
  const html = render({
    requestId: "ev5",
    state: "waiting",
    items: [{ ...items[0], multiSelect: true }],
  });
  assert.ok(/class="question-option question-custom/.test(html), "多选同样有自定义回答行");
}
console.log("questionRender: 多选问卷同样可选自定义回答 ✓");

// ---------- 5b. 主动放弃整组问题（2026-09-21 与官方 web 端同步） ----------
//
// 官方 `QuestionComposer` 卡头有一枚 ✕（`nav.cancel`「放弃整组问题」），点了以
// `ASK_CANCELLED` 拒绝整份等待。宿主侧 `cancelQuestion` 分支早已就位（计划审阅卡的
// 「去聊天里说」在用），这里钉的是**通用问卷卡真的把这枚出口画了出来**——以及它
// 只画在能作答的卡上：已收场的卡都是记录，不给出口。
{
  const zh = render({ requestId: "ev-d1", state: "waiting", items });
  assert.ok(
    /<button type="button" class="btn btn-ghost question-dismiss"[^>]*aria-label="放弃整组问题"/.test(zh),
    `待答卡要渲染出「放弃整组问题」按钮：${zh.slice(zh.indexOf("question-footer"), zh.indexOf("question-footer") + 300)}`,
  );
  assert.ok(zh.includes("放弃整组问题"), "按钮文案走词典（zh）");
  // 次要出口与主操作（提交）同在 footer、且排在提交之前——放题头旁边会被误读成「只关这一题」
  assert.ok(
    zh.indexOf("question-dismiss") > zh.indexOf("question-footer") &&
      zh.indexOf("question-dismiss") < zh.indexOf(">提交<"),
    "放弃按钮在 footer 里、提交之前",
  );

  const en = render({ requestId: "ev-d2", state: "waiting", items }, "en");
  assert.ok(en.includes("Dismiss all questions"), `英文文案走词典（官方 nav.cancel 逐字）：${en.slice(0, 400)}`);

  // 已收场的卡（答完 / 撤回）都是记录，没有可点的出口
  for (const state of ["answered", "cancelled"] as const) {
    const done = render({ requestId: `ev-d-${state}`, state, items });
    assert.ok(!done.includes("question-dismiss"), `${state} 的记录卡不渲染放弃按钮`);
  }
}
console.log("questionRender: 待答卡可放弃整组问题、收场卡没有出口 ✓");

// ---------- 6. 英文同一条链路（双语规则：文案走词典，不写死） ----------
{
  const html = render({ requestId: "ev6", state: "answered", items }, "en");
  assert.ok(html.includes("2 questions answered"), `英文摘要：${html.slice(0, 240)}`);
  const waiting = render({ requestId: "ev7", state: "waiting", items }, "en");
  assert.ok(
    /placeholder="Or type your own answer…"/.test(waiting),
    "英文下自定义回答的提示也要走词典",
  );
  assert.ok(
    /<span class="question-custom-title"[^>]*>Custom answer<\/span>/.test(waiting),
    "自定义回答那一行的标题同样走词典（英文下是 Custom answer）",
  );
}
console.log("questionRender: 英文渲染同一条链路 ✓");

// ---------- 7. 待处理的卡片：只撤下**被输入区接管的那一条** ----------
//
// 官方框架按会话只留一个 pending interaction（`SessionPendingInteractionSnapshot =
// ReadonlyMap<SessionId, …>`），但宿主侧的卡片补投（`heldEvents` 回放、重连时重放进适配器）
// **有机会**造出「两张 waiting 并存」。那时如果按「凡是 waiting 就撤下」处理，输入区只画一张、
// 另一张谁也渲染不了——用户看不到它，也就答不了它，而 agent 正在等那次审批。
// 2026-09-19 用这个渲染口实测过那个丢卡现场，所以这里钉住它。
{
  const approvalSegment = {
    kind: "approval",
    id: "seg-approval",
    approval: { requestId: "ev-approval", toolName: "pwsh", detail: "rm -rf build" },
  };
  const questionSegment = {
    kind: "question",
    id: "seg-question",
    question: { requestId: "ev-question", state: "waiting", items: [items[0]] },
  };
  const message = {
    id: "a:1",
    role: "assistant",
    ts: 1_700_000_000_000,
    segments: [approvalSegment, questionSegment],
  };

  const html = (takenOver: ReadonlySet<string>): string =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor("zh") },
        createElement(Message!, { message: message as never, takenOver }),
      ),
    );

  // 两张 waiting 并存：`takenOver` 由公开入口 `resolveInteractions` 从**同一份消息流**
  // 现算（真实链路：选举 → 抑制 → 渲染）。当选的是问卷（官方优先级 1 > 0），
  // 问卷卡撤下（输入区渲染它），**审批卡必须留在流里**
  const electedQuestion = html(resolveInteractions([message as never]).takenOver);
  assert.ok(
    !/question-option/.test(electedQuestion),
    "被选中的问卷卡不该出现在流里（由输入区渲染）",
  );
  assert.ok(
    /class="approval"/.test(electedQuestion) && electedQuestion.includes("rm -rf build"),
    `没被选中的审批卡必须留在流里、能被回答：${electedQuestion.slice(0, 400)}`,
  );

  // 反过来：被选中的是审批 → 问卷卡留在流里（两张都还是 waiting，这里把「当选的是审批」
  // 直接交给渲染层——选举本身选不出这个结果，优先级永远是问卷在前）
  const electedApproval = html(new Set(["seg-approval"]));
  assert.ok(!/class="approval"/.test(electedApproval), "被选中的审批卡不在流里");
  assert.ok(/question-option/.test(electedApproval), "没被选中的问卷卡留在流里");

  // 没有待处理交互：两张都留在流里
  const none = html(new Set());
  assert.ok(/class="approval"/.test(none) && /question-option/.test(none), "没有待处理交互时两张都留在流里");
}
console.log("questionRender: 只撤下被输入区接管的那一条 ✓");

// ---------- 8. `ask_user_question` 的节点就是那张问卷记录 ----------
//
// 用户 2026-09-24 口径：答案与问卷合并成一个节点，不再单独开一条。适配器把题目
// （取自调用参数）与答案（取自工具结果）折进 `tool.question`，界面据此**直接画
// 记录卡**——不画工具行的 IN/OUT（那才是「输入问句 JSON / 输出答案 JSON」的来源）。
// 这里渲染整条消息，钉住「画的是记录卡、不是通用工具行」。
{
  const toolMessage = {
    id: "a:9",
    role: "assistant",
    ts: 1_700_000_000_000,
    segments: [
      {
        id: "tool:q1",
        kind: "tool",
        tool: {
          id: "q1",
          name: "ask_user_question",
          title: "",
          detail: '{"questions":[{"id":"scope"',
          status: "ok",
          input: '{"questions":[{"id":"scope","question":"这次改动覆盖到哪一层？","options":[{"label":"只改入口文件"},{"label":"一起收敛"}]}]}',
          output: '{"answers":[{"id":"scope","selected":["一起收敛"]}]}',
          question: {
            requestId: "q1",
            state: "answered",
            items: [
              {
                id: "scope",
                header: "范围",
                question: "这次改动覆盖到哪一层？",
                options: [{ label: "只改入口文件" }, { label: "一起收敛" }],
              },
            ],
            answers: { scope: { selected: ["一起收敛"] } },
          },
        },
      },
    ],
  };

  const html = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(Message!, { message: toolMessage as never }),
    ),
  );

  assert.ok(html.includes("已作答 1 题"), `工具节点要画成问卷记录卡：${html.slice(0, 400)}`);
  assert.ok(!/io-card/.test(html), "不再画通用 IN/OUT（参数 JSON 与答案 JSON 都不出现）");
  assert.ok(!html.includes("questions"), "参数 JSON 不该露出来");
  // 记录卡默认收起（与独立记录段同一形态），展开体由 `QuestionCard` 那一层钉住
  assert.ok(!/question-option/.test(html), "默认收起时不挂载题目正文");

  // 已取消的形态同样画记录卡（撤回 / 中止之后没人回答过）
  const cancelled = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(Message!, {
        message: {
          ...toolMessage,
          segments: [
            {
              ...toolMessage.segments[0],
              tool: { ...toolMessage.segments[0].tool, status: "stopped", question: { requestId: "q1", state: "cancelled", items: toolMessage.segments[0].tool.question.items } },
            },
          ],
        } as never,
      }),
    ),
  );
  assert.ok(cancelled.includes("已取消 1 题"), `撤回/中止之后也是同一张记录卡：${cancelled.slice(0, 400)}`);
}
console.log("questionRender: ask_user_question 节点渲染成问卷记录 ✓");

console.log("\nquestionRender: all assertions passed");
