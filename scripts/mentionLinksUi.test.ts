/**
 * 用户消息里 `@` 引用的**渲染**断言（服务端渲染，无浏览器）。
 *
 * 为什么要有这一层：`scripts/mentionLinks.test.ts` 钉的是**判定**（哪一段文字指向哪个
 * 目标），这里钉的是「用户真能点到」——判定对了却没渲染成按钮、或者按钮长在了一段
 * 本来就该是普通文本的文字上，源码正则都看不出来。
 *
 * 覆盖六件事：
 * 1. `@src/a.ts` 渲染成带 `.mention-link` 的行内按钮，悬停说明按「文件」那一档给；
 * 2. 目录引用同样可点，但提示是「展开目录」——三档目标点开的行为不同，提示不能混；
 * 3. 会话引用按**显示形态**（`@标题`）渲染，原始的长 token 一个字节都不出现在界面上；
 * 4. 解不开 id 的会话引用**不做成链接**（点了也不知道开哪一条），照旧只做显示还原；
 * 5. 普通文本里的路径不造链接；
 * 6. **已经发出去**的会话引用（落盘时被服务端折成 `@标题`、id 由召回清单带回来）按会
 *    话渲染，且同一条正文在没有清单时按形状是文件引用。
 *
 * 另有一条样式断言：`.mention-link` 必须是**行内**元素、没有上下内边距——气泡的折叠
 * 判定量的是 `scrollHeight`，按钮把行盒撑高的话「5 行」的阈值就与实际行数对不上。
 *
 * 用 `react-dom/server` 的 `renderToStaticMarkup`：断言落在**产出的 HTML** 上而不是
 * 源码正则上——正则只能证明「代码里有这行字」，渲染能证明「用户真能看见」。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommandView, MessageView } from "../src/shared/chat";
import { CommandLinksContext, scanCommandLinks, commandDescription } from "../src/webview/commandLinks";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

// `bridge.ts` 在模块求值期就挂了 `window.addEventListener`（webview 里那是真实存在的
// 宿主）。无头环境里补一个最小 window，免得 import 阶段就炸——补在 import 之前。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => posted.push(message) });
const { Message } = await import("../src/webview/components/Message");
const { openMentionTarget } = await import("../src/webview/mentionOpen");

const zh = dictionaryFor("zh");

/**
 * SSR 下 `useLayoutEffect` 会打一条「does nothing on the server」的警告。
 *
 * 本文件渲染的是真组件（用户气泡里就有一个 useLayoutEffect，用来量高度），这条警告是
 * **预期**的、与断言无关；不静音的话 `npm test` 的输出会被它淹掉。
 */
function quietly<T>(run: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return run();
  } finally {
    console.error = original;
  }
}

const userMessage = (text: string, sessionRefs?: MessageView["sessionRefs"]): MessageView => ({
  id: "u:1",
  role: "user",
  ts: Date.now(),
  text,
  segments: [],
  ...(sessionRefs === undefined ? {} : { sessionRefs }),
});

/** 渲染一条用户消息的 HTML。 */
const render = (
  text: string,
  locale: "zh" | "en" = "zh",
  sessionRefs?: MessageView["sessionRefs"],
  commands: readonly CommandView[] = [],
  cwd?: string,
): string =>
  quietly(() =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor(locale) },
        createElement(CommandLinksContext.Provider, { value: { commands, openMenu() {} } },
          createElement(Message, { message: userMessage(text, sessionRefs), cwd })),
      ),
    ),
  );

/**
 * 会话引用的**原始 token**（`@[标题](dsh-session:…)`）。
 *
 * 负载是 id 的 UTF-8 JSON 再 base64url——与 `shared/mentions.ts` 的
 * `decodeSessionReferenceUri` 同一条口径（这里真走一遍解码，而不是喂一个刚好长得像的
 * 字符串）。
 */
const sessionToken = (label: string, id: string): string =>
  `@[${label}](dsh-session:${Buffer.from(JSON.stringify(id), "utf8").toString("base64url")})`;

// ---------- 1. 文件引用：行内按钮，悬停说明按「文件」那一档 ----------
{
  const html = render("先看 @src/a.ts 再改别的");
  assert.ok(
    /<button[^>]*class="mention-link"[^>]*>@src\/a\.ts<\/button>/.test(html),
    `@src/a.ts 必须渲染成可点的行内按钮（class=mention-link）：${html}`,
  );
  assert.ok(
    html.includes(`title="src/a.ts\n${zh.mentionOpenFile}"`),
    "悬停说明要先给完整路径、再说「打开文件」（用户点之前得知道会发生什么）",
  );
  assert.ok(
    html.includes("先看 ") && html.includes(" 再改别的"),
    "引用两侧的普通文本一个字符都不能丢（按区间切段，不能只画按钮）",
  );
  console.log("mentionLinksUi: 文件引用渲染成行内链接 ✓");
}

// ---------- 2. 目录引用：同样可点，但提示是「展开目录」 ----------
{
  const html = render("整个 @src/ 目录都看一遍");
  assert.ok(
    /<button[^>]*class="mention-link"[^>]*>@src\/<\/button>/.test(html),
    `@src/ 必须渲染成可点链接（目录与文件是两种目标）：${html}`,
  );
  assert.ok(
    html.includes(`title="src/\n${zh.mentionRevealFolder}"`),
    "目录引用的悬停说明要先给完整路径，再用「展开目录」，不能与「打开文件」混用",
  );
  console.log("mentionLinksUi: 目录引用用「展开目录」那一档提示 ✓");
}

// ---------- 2b. HTML 文件引用：完整路径 + 浏览器修饰键提示 ----------
{
  const html = render("看 @out/index.html 的渲染结果", "zh", undefined, [], "D:/dev/app");
  assert.ok(
    html.includes(`title="D:/dev/app/out/index.html\n${zh.webFileBrowserHint}\n${zh.mentionOpenFile}"`),
    `HTML 文件引用要先给完整路径，再给 Ctrl/Cmd 浏览器提示与普通单击的动作：${html}`,
  );
  posted.length = 0;
  openMentionTarget({ kind: "file", path: "out/index.html" }, undefined, true);
  assert.deepEqual(posted, [{ type: "openFileInBrowser", path: "out/index.html" }]);
  posted.length = 0;
  openMentionTarget({ kind: "file", path: "out/index.html" });
  assert.deepEqual(posted, [{ type: "openFile", path: "out/index.html", line: undefined, link: true }]);
  posted.length = 0;
  console.log("mentionLinksUi: HTML 文件引用显示完整路径并按修饰键分流浏览器 ✓");
}

// ---------- 3. 纯文本消息：一个链接按钮都不该出现 ----------
{
  const html = render("看看 src/a.ts 就行，别动别的");
  assert.ok(
    !html.includes("mention-link"),
    `不带 @ 的路径是普通文本，不能变成链接（假链接点了没反应）：${html}`,
  );
  console.log("mentionLinksUi: 普通文本里不造链接 ✓");
}

// ---------- 4. 会话引用：折成 `@标题` 渲染，原始 token 不上界面 ----------
{
  const html = render(`接上 ${sessionToken("昨天的排查", "sess-9")} 继续`);
  assert.ok(
    /<button[^>]*class="mention-link"[^>]*>@昨天的排查<\/button>/.test(html),
    `会话引用要按显示形态（@标题）渲染成可点链接：${html}`,
  );
  assert.ok(
    html.includes(`title="${zh.mentionOpenSession}"`),
    "会话引用的悬停说明是「在新标签页打开这个会话」",
  );
  assert.ok(
    !html.includes("dsh-session:"),
    `原始 token（给服务端看的那一串）不该出现在界面上：${html}`,
  );
  console.log("mentionLinksUi: 会话引用折成 @标题 且可点 ✓");
}

// ---------- 5. 解不开的会话引用：只做显示还原，不做成链接 ----------
{
  // 负载不是合法 base64url（含 `!`）→ 解不出会话 id。此时界面上仍要把它折成可读的
  // `@标题`（否则用户看到的就是一长串 token），但**不能**做成按钮。
  const html = render("接上 @[某个旧会话](dsh-session:%%%%) 继续");
  assert.ok(
    !html.includes("mention-link"),
    `解不开 id 的会话引用不做链接（点了也不知道开哪一条）：${html}`,
  );
  assert.ok(html.includes("@某个旧会话"), "仍然按显示形态折成 @标题（不还原就是一串 token）");
  console.log("mentionLinksUi: 解不开的会话引用只显示、不链接 ✓");
}

// ---------- 6. 已经发出去的会话引用：正文只剩 `@标题`，靠召回清单认 ----------
{
  // **真实落盘形态**（取自会话日志）：服务端把 `@[标题](dsh-session:…)` 折成 `@标题`
  // 之后才落盘，id 只在紧随消息的召回事件里（宿主折成 `MessageView.sessionRefs`）。
  const text = "@轨迹四项收口与逐块渲染交接 里出现了大量思考前的未知内容块节点";
  const refs = [{ label: "轨迹四项收口与逐块渲染交接", sessionId: "session-10263ccf" }];
  const html = render(text, "zh", refs);
  assert.ok(
    /<button[^>]*class="mention-link"[^>]*>@轨迹四项收口与逐块渲染交接<\/button>/.test(html),
    `已发出的会话引用要渲染成可点链接（修复前它被当成文件引用）：${html}`,
  );
  assert.ok(
    html.includes(`title="${zh.mentionOpenSession}"`),
    "悬停说明必须是「在新标签页打开这个会话」，不能是「打开这个文件」",
  );
  assert.ok(
    !html.includes(`title="${zh.mentionOpenFile}"`),
    `不能同时挂着文件那一档的提示：${html}`,
  );

  // 同一条正文**没有**清单时按形状是文件引用——这份清单就是这两种引用唯一的分界
  const shapeOnly = render(text);
  assert.ok(
    shapeOnly.includes(`\n${zh.mentionOpenFile}"`),
    `没有召回清单时按形状当文件引用（就是用户报的那个现象）：${shapeOnly}`,
  );
  console.log("mentionLinksUi: 已发出的会话引用按召回清单认成会话 ✓");
}

// ---------- 7. 样式：行内元素、不撑高行盒，观感与正文链接一致 ----------
{
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  const rule = /\.mention-link\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "app.css 里必须有 .mention-link 的主规则");
  const body = rule[1];
  assert.ok(/color:\s*var\(--link\)/.test(body), "颜色与正文里 agent 发来的链接一致（--link）");
  assert.ok(
    /display:\s*inline/.test(body),
    "必须是行内元素：气泡按 scrollHeight 判「超过 5 行」，按钮不能把行盒撑高",
  );
  assert.ok(
    /padding:\s*0/.test(body) && /margin:\s*0/.test(body),
    "没有内边距 / 外边距（上下任一处非零都会让折叠阈值与实际行数对不上）",
  );
  assert.ok(
    /\.mention-link:hover\s*\{[^}]*text-decoration:\s*underline/.test(css),
    "悬停补下划线（与 `.md a` 同一套观感）",
  );
  assert.ok(
    /\.mention-link:focus-visible\s*\{/.test(css),
    "键盘聚焦要有焦点环（真按钮就得键盘可达）",
  );
  console.log("mentionLinksUi: .mention-link 行内、不撑高行盒、观感同正文链接 ✓");
}

// 目录确认的斜杠：真命令打开筛选菜单，文件技能打开其 Markdown，虚拟技能只着色。
{
  const commands: CommandView[] = [
    { name: "plan", definitionId: "@deepseek-ai/dsh-plan-mode", description: "Enter plan mode" },
    { name: "audit", description: "Audit", skill: true, skillPath: "skills/audit/SKILL.md" },
    { name: "virtual", description: "Virtual", skill: true },
  ];
  const text = "先用 /plan，再看 /audit 和 /virtual。";
  const spans = scanCommandLinks(text, commands);
  assert.deepEqual(spans.map((span) => span.text), ["/plan", "/audit", "/virtual"]);
  assert.deepEqual(spans.map((span) => text.slice(span.start, span.end)), spans.map((span) => span.text));
  assert.deepEqual(spans.map((span) => span.target), [
    { kind: "command", name: "plan" }, { kind: "file", path: "skills/audit/SKILL.md" }, undefined,
  ]);
  const html = render(text, "zh", undefined, commands);
  assert.match(html, /<button[^>]*class="mention-link"[^>]*>\/plan<\/button>/);
  assert.match(html, /<button[^>]*class="mention-link"[^>]*>\/audit<\/button>/);
  assert.match(html, /<span class="mention-link is-inert">\/virtual<\/span>/);
  assert.ok(
    html.includes(`title="${zh.commandOpenMenu}"`) &&
      html.includes(`title="skills/audit/SKILL.md\n${zh.mentionOpenFile}"`),
  );
  assert.deepEqual(scanCommandLinks("https://host/plan /plan/file /plan.md /planner /unknown", commands), []);
  assert.equal(scanCommandLinks("(/plan) /plan.", commands).length, 2, "句末标点不属于命令");
  const collision = scanCommandLinks("/plan", [{ ...commands[1], name: "plan" }, commands[0]]);
  assert.deepEqual(collision[0]?.target, { kind: "command", name: "plan" }, "真命令与同名技能冲突时按发送目录优先");
  const overlap = render(`接上 ${sessionToken("含 /plan 的标题", "s1")} 后用 /plan`, "zh", undefined, commands);
  assert.equal((overlap.match(/title="打开并筛选斜杠命令"/gu) ?? []).length, 1, "会话引用内部不嵌套斜杠链接");
  const opened: string[] = [];
  openMentionTarget(spans[0].target!, (name) => opened.push(name));
  assert.deepEqual(opened, ["plan"]);
  assert.deepEqual(posted, [], "点击命令只打开菜单，绝不执行或写入草稿");
  openMentionTarget(spans[1].target!);
  assert.deepEqual(posted, [{ type: "openFile", path: "skills/audit/SKILL.md", line: undefined, link: true }]);
  console.log("mentionLinksUi: 斜杠渲染、边界、重叠与打开分派 ✓");
}

// 命令前界：句子的引号 / 括号 / 包装标点属于上下文，不属于命令名；路径、URI、
// 盘符、UNC 与 markdown 目标不凭形状染色。扫描与输入框触发共用同一条前界规则。
{
  const commands: CommandView[] = [
    { name: "plan", definitionId: "@deepseek-ai/dsh-plan-mode", description: "Enter plan mode" },
    { name: "audit", description: "Audit", skill: true, skillPath: "skills/audit/SKILL.md" },
  ];
  const wrapped = [
    "/plan",
    "(/plan)",
    "（/plan）",
    "【/plan】",
    "「/plan」",
    "『/plan』",
    "《/plan》",
    "[/plan]",
    "{/plan}",
    "\"/plan\"",
    "'/plan'",
    "`/plan`",
    "**/plan**",
    "“/plan”",
    "先看 (/plan) 再继续",
  ];
  for (const text of wrapped) {
    const spans = scanCommandLinks(text, commands);
    assert.equal(spans.length, 1, `包装标点旁的一条完整命令必须被认出来：${text}`);
    const span = spans[0]!;
    assert.equal(
      text.slice(span.start, span.end),
      "/plan",
      `区间只覆盖 /plan，包装标点留在正文里：${text}`,
    );
    assert.deepEqual(span.target, { kind: "command", name: "plan" }, `目标必须还是那条命令：${text}`);
  }

  const rejected: Array<[string, string]> = [
    ["https://host/plan", "URI 路径里的 /plan 不是命令"],
    ["file:///C:/plan", "file URI 里的 /plan 不是命令"],
    ["C:/plan", "盘符路径里的 /plan 不是命令"],
    ["\\\\server\\share/plan", "UNC 路径里的 /plan 不是命令"],
    ["src/plan", "相对路径里的 /plan 不是命令"],
    ["./plan", "当前目录路径里的 /plan 不是命令"],
    ["../plan", "父目录路径里的 /plan 不是命令"],
    ["word/plan", "单词与命令之间没有分隔符"],
    ["//plan", "双斜杠不是命令前界"],
    ["@/plan", "mention 的 @/ 路径不是命令"],
    ["__/plan__", "下划线是合法命令字符，不能当下划线包装"],
    ["[标签](/plan)", "markdown 链接目标不是命令"],
    ["@[标签](/plan)", "mention 的链接目标不是命令"],
    ["/planner", "完整名优先，/plan 不能从 /planner 里切一段"],
    ["/plan.md", "扩展名说明这不是一条完整命令"],
    ["/plan/file", "子路径说明这不是一条完整命令"],
    ["/plan\\file", "反斜杠子路径说明这不是一条完整命令"],
    ["/plan-x", "- 是命令名字符，不能切断命令名"],
    ["/plan_x", "_ 是命令名字符，不能切断命令名"],
    ["/unknown", "目录里没有的名字不凭形状染色"],
  ];
  for (const [text, message] of rejected) {
    assert.deepEqual(scanCommandLinks(text, commands), [], `${message}：${text}`);
  }

  // 包装标点必须原样留在按钮外：切段只按扫描区间，不能把句子的引号 / 括号吃进链接。
  const html = render("【/plan】与 **/audit**", "zh", undefined, commands);
  assert.match(
    html,
    /【<button[^>]*class="mention-link"[^>]*>\/plan<\/button>】/u,
    `【】必须留在链接外：${html}`,
  );
  assert.match(
    html,
    /\*\*<button[^>]*class="mention-link"[^>]*>\/audit<\/button>\*\*/u,
    `** 必须留在链接外：${html}`,
  );
  assert.ok(html.includes(`title="${zh.commandOpenMenu}"`), "可点命令仍用「打开并筛选」那一档提示");
  console.log("mentionLinksUi: 命令前界（包装标点 / 路径 / URI / mention） ✓");
}

// 精确使用官方描述；不能把同名第三方命令误译成内置命令。
{
  const cases = [
    ["@deepseek-ai/dsh-command-goal", "设置或查看长期任务目标", "Set or view the goal for a long-running task"],
    ["@deepseek-ai/dsh-plan-mode", "进入或退出计划模式", "Enter or leave plan mode"],
    ["@deepseek-ai/dsh-command-feedback", "发送关于当前会话的反馈", "Record feedback about this session"],
    ["@deepseek-ai/dsh-command-compact", "压缩以上对话内容", "Compact older conversation history"],
    ["@deepseek-ai/dsh-permission-presets", "切换权限预设（沙箱模式与审批策略）", "Switch the permission preset (sandbox mode + approval policy)"],
    ["@deepseek-ai/dsh-session-log-export", "将当前会话内容导出为 ZIP", "Download this Session log as a ZIP archive"],
  ];
  for (const [definitionId, chinese, english] of cases) {
    const command = { name: "alias", definitionId, description: "server fallback" };
    assert.equal(commandDescription(command, zh), chinese);
    assert.equal(commandDescription(command, dictionaryFor("en")), english);
  }
  assert.equal(commandDescription({ name: "plan", description: "Third-party description" }, zh), "Third-party description");
  assert.equal(commandDescription({ name: "plan", definitionId: cases[1][0], skill: true, description: "Skill description" }, zh), "Skill description");
  console.log("mentionLinksUi: 官方六项双语与单语言原文回退 ✓");
}
