import type { Token, TokenizerAndRendererExtension } from "marked";

/**
 * 脚注（`[^label]` 引用 + `[^label]: 定义`）。
 *
 * 官方渲染链的 `markdown.footnotes` 是**真实存在**的一项能力（`dsh-client-locale`
 * 的 `markdown.footnotes` 字典键 + 内置渲染器的脚注分支），而 marked 本身**不带**
 * 脚注语法（`lib/marked.esm.js` 里 grep 不到 footnote），所以这里是自带的扩展：
 * 不引入新依赖，只改渲染链。
 *
 * 结构逐字对齐官方渲染器的产出（`dsh-web-frontend/dist/assets/index-*.js` 的
 * 脚注分支）：
 *
 * ```html
 * <section data-footnotes class="footnotes">
 *   <h2 id="footnote-label" class="sr-only">脚注</h2>
 *   <ol><li id="user-content-fn-1"><p>正文 <span>↩</span></p></li></ol>
 * </section>
 * ```
 *
 * 三条与官方一致的语义：
 * 1. 引用渲染成 `<sup>N</sup>`，编号按**首次引用**的顺序（重复引用同一个编号，
 *    不新开一条）；
 * 2. 只有引用、没有对应定义的标号**不出现**在脚注区（官方 `continue` 同口径）；
 * 3. 定义本身不在原地渲染，全部收集到文末的脚注区里。
 *
 * 与 markdown 主链的关系：这里只提供「扩展 + 状态 + 收尾拼装」，净化与分块在
 * `markdown.ts`。刻意不引 DOMPurify，好处是这一层能在 Node 里直接跑断言
 * （见 `scripts/footnotes.test.ts`）。
 */

/** 一份文档里脚注的编排状态（引用顺序、引用次数、定义体 HTML）。 */
export interface FootnoteState {
  /** label（小写）→ 定义体渲染出的 HTML。 */
  defs: Map<string, string>;
  /** 首次引用的顺序（决定编号）。 */
  order: string[];
  /** label → 被引用次数（回跳箭头的个数）。 */
  counts: Map<string, number>;
}

function createState(): FootnoteState {
  return { defs: new Map(), order: [], counts: new Map() };
}

/**
 * 当前正在渲染的那份文档的状态。
 *
 * 模块级一份而不是塞进 token：marked 的渲染器只拿到 token 与 parser，没有地方
 * 透传自定义上下文；而 `marked.parse` 是**同步**的（我们固定 `async: false`），
 * 渲染期间不会重入，所以一份就够。`markdown.ts` 在每次 parse 前后成对调用
 * `beginFootnotes()` / `endFootnotes()`。
 */
let active: FootnoteState | undefined;

/** 开始渲染一份文档：重置这一份文档的脚注编排状态。 */
export function beginFootnotes(): FootnoteState {
  active = createState();
  return active;
}

/** 结束一份文档的渲染（没结束时留着也无害，但会拖住上一份的内存）。 */
export function endFootnotes(): void {
  active = undefined;
}

/** 定义的头部：`[^label]:` 之后是本行正文。 */
const DEFINITION_HEAD = /^\[\^([^\]\s]+)\]:[ \t]*/u;

/**
 * 从源串开头读一条脚注定义。
 *
 * 续行规则取**保守的一档**：紧跟着的、以空白开头且非空的行算定义体（缩进去掉
 * 一层）。CommonMark 允许多段落定义（空行 + 缩进），但脚注写成多段极少见，
 * 保守处理宁可少吞一行——多吞会把后面的正文吸进脚注里，那是不可逆的信息错位。
 */
function readDefinition(src: string): { raw: string; label: string; body: string } | undefined {
  const head = DEFINITION_HEAD.exec(src);
  if (!head) return undefined;
  const lines: string[] = [];
  const readLine = (from: number): { line: string; next: number } => {
    const end = src.indexOf("\n", from);
    return end < 0
      ? { line: src.slice(from), next: src.length }
      : { line: src.slice(from, end), next: end + 1 };
  };
  const first = readLine(head[0].length);
  lines.push(first.line);
  let cursor = first.next;
  while (cursor < src.length) {
    const item = readLine(cursor);
    if (!/^(?:[ \t]+\S)/u.test(item.line)) break;
    lines.push(item.line.replace(/^(?: {1,4}|\t)/u, ""));
    cursor = item.next;
  }
  return { raw: src.slice(0, cursor), label: head[1].toLowerCase(), body: lines.join("\n").trim() };
}

/** 回跳箭头：第一次是 `↩`，重复引用加 `<sup>2</sup>`（官方同形）。 */
function backReferences(count: number): string {
  return Array.from({ length: Math.max(1, count) }, (_, index) =>
    index === 0 ? "↩" : `↩<sup>${index + 1}</sup>`,
  ).join(" ");
}

/** 回跳箭头接在**最后一段正文的末尾**（官方把它塞进最后一个 `<p>` 里）。 */
function appendBackReference(body: string, back: string): string {
  const trimmed = body.replace(/\s+$/u, "");
  return trimmed.endsWith("</p>") ? `${trimmed.slice(0, -4)} ${back}</p>` : `${trimmed} ${back}`;
}

/** 锚点 id 用的 slug：只留字母/数字/下划线/连字符/汉字，空格转连字符。 */
function slug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]+/gu, "")
    .replace(/\s+/gu, "-");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/**
 * 文末的脚注区；没有任何**有定义**的引用时返回 undefined（不渲染空壳）。
 *
 * @param state 这份文档的状态（`beginFootnotes()` 的返回值）。
 * @param label 无障碍标题的文字（界面词典的 `markdownFootnotes`）。
 */
export function footnoteSection(state: FootnoteState, label: string): string | undefined {
  const items: string[] = [];
  for (const key of state.order) {
    const body = state.defs.get(key);
    // 只有引用、没有定义：整条不渲染（官方 `if (s === undefined) continue`）
    if (body === undefined) continue;
    const back = backReferences(state.counts.get(key) ?? 1);
    items.push(`<li id="user-content-fn-${slug(key)}">${appendBackReference(body, back)}</li>`);
  }
  if (!items.length) return undefined;
  return (
    `<section data-footnotes class="footnotes">` +
    `<h2 id="footnote-label" class="sr-only">${escapeHtml(label)}</h2>` +
    `<ol>${items.join("")}</ol>` +
    `</section>`
  );
}

/**
 * marked 的两条扩展（定义 / 引用）。
 *
 * 定义是 **block** 级：这样 marked 自己的词法器先把围栏代码块整块吃掉，定义写
 * 在代码块里不会被误认（而行内代码 `` `[^1]` `` 也安全——扫描位置总是落在反引号
 * 上，由 codespan 整段消费）。这是不用正则预处理全文的关键好处。
 */
export function footnoteExtensions(): TokenizerAndRendererExtension[] {
  return [
    {
      name: "footnoteDef",
      level: "block",
      start(src) {
        return /^\[\^[^\]\s]+\]:/mu.exec(src)?.index;
      },
      tokenizer(src) {
        const def = readDefinition(src);
        if (!def) return undefined;
        const token: Token = { type: "footnoteDef", raw: def.raw, label: def.label, tokens: [] };
        // 定义体按**块级**再走一遍词法，于是里面可以有列表、代码块、强调……
        if (def.body) this.lexer.blockTokens(def.body, token.tokens as Token[]);
        return token;
      },
      childTokens: ["tokens"],
      renderer(token) {
        // 正文在这里渲染成 HTML 存起来：脚注区在文末拼装，那时已经没有 parser 了
        const label = String(token.label ?? "");
        const html = this.parser.parse((token.tokens as Token[]) ?? []);
        active?.defs.set(label, html);
        return "";
      },
    },
    {
      name: "footnoteRef",
      level: "inline",
      start(src) {
        return /\[\^/u.exec(src)?.index;
      },
      tokenizer(src) {
        const match = /^\[\^([^\]\s]+)\]/u.exec(src);
        if (!match) return undefined;
        return { type: "footnoteRef", raw: match[0], label: match[1].toLowerCase() };
      },
      renderer(token) {
        const label = String(token.label ?? "");
        const state = active;
        let index = 1;
        if (state) {
          const seen = state.counts.get(label) ?? 0;
          if (seen === 0) state.order.push(label);
          state.counts.set(label, seen + 1);
          index = state.order.indexOf(label) + 1;
        }
        // 官方：引用就是一个上标数字（不是链接——回跳箭头只出现在脚注区）
        return `<sup>${index}</sup>`;
      },
    },
  ];
}
