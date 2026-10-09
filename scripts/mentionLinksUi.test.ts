/**
 * 用户消息里 `@` 引用的**渲染**断言（服务端渲染，无浏览器）。
 *
 * 为什么要有这一层：`scripts/mentionLinks.test.ts` 钉的是**判定**（哪一段文字指向哪个
 * 目标），这里钉的是「用户真能点到」——判定对了却没渲染成按钮、或者按钮长在了一段
 * 本来就该是普通文本的文字上，源码正则都看不出来。
 *
 * 覆盖四件事：
 * 1. `@src/a.ts` 渲染成带 `.mention-link` 的行内按钮，悬停说明按「文件」那一档给；
 * 2. 目录引用同样可点，但提示是「展开目录」——三档目标点开的行为不同，提示不能混；
 * 3. 会话引用按**显示形态**（`@标题`）渲染，原始的长 token 一个字节都不出现在界面上；
 * 4. 解不开 id 的会话引用**不做成链接**（点了也不知道开哪一条），照旧只做显示还原。
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
import type { MessageView } from "../src/shared/chat";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

// `bridge.ts` 在模块求值期就挂了 `window.addEventListener`（webview 里那是真实存在的
// 宿主）。无头环境里补一个最小 window，免得 import 阶段就炸——补在 import 之前。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { Message } = await import("../src/webview/components/Message");

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

const userMessage = (text: string): MessageView => ({
  id: "u:1",
  role: "user",
  ts: Date.now(),
  text,
  segments: [],
});

/** 渲染一条用户消息的 HTML。 */
const render = (text: string, locale: "zh" | "en" = "zh"): string =>
  quietly(() =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor(locale) },
        createElement(Message, { message: userMessage(text) }),
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
    html.includes(`title="${zh.mentionOpenFile}"`),
    "悬停说明要用「打开文件」那一档（用户点之前得知道会发生什么）",
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
    html.includes(`title="${zh.mentionRevealFolder}"`),
    "目录引用的悬停说明必须是「展开目录」，不能与「打开文件」混用",
  );
  console.log("mentionLinksUi: 目录引用用「展开目录」那一档提示 ✓");
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

// ---------- 6. 样式：行内元素、不撑高行盒，观感与正文链接一致 ----------
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
