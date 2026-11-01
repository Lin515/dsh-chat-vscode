/**
 * 完成态代码高亮的**纯模块**：Shiki 细粒度 core + 原生 RegExp 引擎，静态精选语法。
 *
 * 设计边界（见 docs/design-markdown-rendering.md 的「代码高亮」）：
 * - 不 import `shiki` / `shiki/bundle/*` / `shiki/langs`（后者是全量语法包）；
 * - 无 Oniguruma WASM、CDN、网络或 unsafe-eval；
 * - 引擎只在浏览器里按需创建（React effect 调 `highlightCode`），模块顶层不初始化，
 *   Node / SSR 导入本模块不会加载 grammar 之外的运行时；
 * - 输出的是**源码偏移 + 受控颜色/字体修饰**，React 层用原 `code` 切片渲染 span，
 *   不生成 HTML、不经过 `dangerouslySetInnerHTML`。
 *
 * 文本保真：`token.offset` 相对输入代码；每个 token 显示源码切片，token 之间的缺口
 * （CRLF / 空行 / 其它未被 token 覆盖的字符）作为普通文本补齐。校验 offset 为安全
 * 整数、单调、不越界，切片与 token.content 相符（仅允许 NUL→U+FFFD 这一条 Shiki
 * 规范差异）；任何异常都回退纯文本，绝不用错位 offset 着色。
 */

import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import javascript from "@shikijs/langs/javascript";
import typescript from "@shikijs/langs/typescript";
import jsx from "@shikijs/langs/jsx";
import tsx from "@shikijs/langs/tsx";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import python from "@shikijs/langs/python";
import shellscript from "@shikijs/langs/shellscript";
import powershell from "@shikijs/langs/powershell";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import go from "@shikijs/langs/go";
import rust from "@shikijs/langs/rust";
import java from "@shikijs/langs/java";
import html from "@shikijs/langs/html";
import css from "@shikijs/langs/css";
import sql from "@shikijs/langs/sql";
import yaml from "@shikijs/langs/yaml";
import markdown from "@shikijs/langs/markdown";
import diff from "@shikijs/langs/diff";

/** 主题名同时是 `codeToTokensBase` 的 theme 参数。 */
const THEME_NAME = "md-code";
/** 主题策略版本：颜色变量名或修饰规则变化时递增，旧缓存自然失效。 */
const THEME_VERSION = 1;

/** 单块代码超过这个字符数就不增强（纯文本仍可读）。 */
export const MAX_HIGHLIGHT_CHARS = 50_000;
/**
 * 单行超过这个字符数就整块回退纯文本。
 *
 * JavaScript 正则引擎的单行 tokenize 耗时随行长近似平方增长（实测 1 万字符约
 * 63ms、4.9 万字符约 1.7s）；50k 总长限制挡不住“一行占满”的秒级卡顿。4000 是
 * 保守折衷：常见生成代码的压缩行仍可着色，极端长行保留原文、不阻塞界面。
 */
export const MAX_HIGHLIGHT_LINE_CHARS = 4_000;
/** 单行 tokenize 的时间上限（ms）：防多 token 的超长行累加拖住主线程。 */
const TOKENIZE_TIME_LIMIT_MS = 500;
/** 单块最多多少段（含普通文本缺口），防止极碎 token 撑出几十万节点。 */
const MAX_SPANS = 4_000;
/** 缓存条数上限。 */
export const MAX_CACHE_ENTRIES = 64;
/** 缓存总字符上限（按 key 的代码长度累计）。 */
export const MAX_CACHE_CHARS = 200_000;

/** 受控文本修饰位（TextMate fontStyle）：1 斜体 / 2 粗体 / 4 下划线。 */
export interface HighlightSpan {
  readonly start: number;
  readonly end: number;
  /** 只可能是本地主题生成的 `var(--md-code-*)` 之一；普通缺口为空。 */
  readonly color?: string;
  readonly fontStyle?: number;
}

/** 规范语言名（首个标识 + 显式别名表）；不支持 / 未知返回 undefined。 */
const LANGUAGE_ALIASES = new Map<string, string>([
  ["js", "javascript"],
  ["javascript", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["jsx", "jsx"],
  ["tsx", "tsx"],
  // VS Code language id（其它客户端 / 旧持久化 meta 可能给这种形态）
  ["javascriptreact", "jsx"],
  ["typescriptreact", "tsx"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["py", "python"],
  ["python", "python"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
  ["zsh", "shellscript"],
  ["shell", "shellscript"],
  ["shellscript", "shellscript"],
  ["ps1", "powershell"],
  ["pwsh", "powershell"],
  ["powershell", "powershell"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["csharp", "csharp"],
  ["cs", "csharp"],
  ["c#", "csharp"],
  ["go", "go"],
  ["rust", "rust"],
  ["rs", "rust"],
  ["java", "java"],
  ["html", "html"],
  ["htm", "html"],
  ["css", "css"],
  ["sql", "sql"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["diff", "diff"],
  ["patch", "diff"],
]);

/** 静态注册的语法：显式列出，不按 name 动态加载包。 */
const LANG_MODULES = [
  javascript,
  typescript,
  jsx,
  tsx,
  json,
  jsonc,
  python,
  shellscript,
  powershell,
  c,
  cpp,
  csharp,
  go,
  rust,
  java,
  html,
  css,
  sql,
  yaml,
  markdown,
  diff,
];

/** 按 name 去重后的静态语法表（html / tsx 模块自带嵌入依赖）。 */
const STATIC_LANGS = (() => {
  const byName = new Map<string, (typeof LANG_MODULES)[number][number]>();
  for (const item of LANG_MODULES.flat()) byName.set(item.name, item);
  return [...byName.values()];
})();

let engine: Promise<HighlighterCore> | undefined;

/** 按需创建的唯一高亮实例；失败后清掉 promise，下次可重试。 */
function highlighter(): Promise<HighlighterCore> {
  engine ??= createHighlighterCore({
    langs: STATIC_LANGS,
    themes: [
      createCssVariablesTheme({
        name: THEME_NAME,
        variablePrefix: "--md-code-",
        fontStyle: true,
      }),
    ],
    engine: createJavaScriptRegexEngine(),
  }).catch((error: unknown) => {
    engine = undefined;
    throw error;
  });
  return engine;
}

/** 首个语言标识（小写）；空串 / 空白返回 undefined。 */
function firstLangId(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined;
  const first = lang.trim().toLowerCase().split(/[\s,{}[\]()]/u)[0] ?? "";
  return first === "" ? undefined : first;
}

/**
 * 首个语言标识归一化：`ts`, `TypeScript`, `ts title=x` 都取第一个词。
 * 用显式 Map，`constructor` / `__proto__` / `toString` 等继承成员不会命中。
 */
export function normalizeLang(lang: string | undefined): string | undefined {
  const first = firstLangId(lang);
  return first === undefined ? undefined : LANGUAGE_ALIASES.get(first);
}

/**
 * 按文件路径末段的扩展名选语言；只查显式别名表，不碰文件系统、不猜内容。
 *
 * 供工具节点（read 窗口之外的 diff / write 预览）在只有 `path` 时取语言。
 * 无扩展名、点号在开头（`.bashrc`）、未知扩展名一律 undefined → 纯文本。
 * `constructor` / `__proto__` 等继承成员不会命中 `Map`。
 */
export function languageForPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return LANGUAGE_ALIASES.get(name.slice(dot + 1).toLowerCase());
}

/**
 * 服务端给的语言提示 + 路径扩展名 → 可高亮的规范语言。
 *
 * - 可识别的语言标识优先（`tsx` / `typescriptreact` / `json` …）；
 * - 显式的 `text` / `plaintext` 是服务端的「就是纯文」意图，保持纯文，
 *   不能按路径扩展名反悔；
 * - 语言标识缺失或未识别时才回退到 `path` 的扩展名；
 * - 未知扩展名仍返回 undefined（纯文），不猜内容。
 *
 * 只查 `LANGUAGE_ALIASES` 显式表，继承成员与任意语言名不会进入引擎。
 */
export function resolveLanguage(lang: string | undefined, path: string | undefined): string | undefined {
  const normalized = normalizeLang(lang);
  if (normalized !== undefined) return normalized;
  const first = firstLangId(lang);
  if (first === "text" || first === "plaintext") return undefined;
  return languageForPath(path);
}

/** 只接受本地 css-variables 主题生成的变量名，拒绝任何内联 CSS。 */
const SAFE_COLOR = /^var\(--md-code-(?:foreground|token-[a-z-]+)\)$/u;

/** 是否存在超过单行上限的行（按 LF / CRLF / CR 切分，行尾不计数）。 */
function hasOversizedLine(code: string): boolean {
  for (const line of code.split(/\r\n|\r|\n/u)) {
    if (line.length > MAX_HIGHLIGHT_LINE_CHARS) return true;
  }
  return false;
}

function safeColor(color: string | undefined): string | undefined {
  return color !== undefined && SAFE_COLOR.test(color) ? color : undefined;
}

function safeFontStyle(style: number | undefined): number | undefined {
  if (style === undefined) return undefined;
  const masked = style & 7;
  return masked === 0 ? undefined : masked;
}

// —— 缓存：key = code + 规范语言 + 主题策略版本；成功与失败都缓存 ——

interface CacheEntry {
  readonly value: HighlightSpan[] | null;
  readonly chars: number;
}

const cache = new Map<string, CacheEntry>();
let cacheChars = 0;
let cacheFailures = 0;
/**
 * 同一 key 的进行中任务：`Promise.all` 并发高亮同一段代码时必须共享一次
 * tokenize / remember，否则会重复累加字符数并让缓存提前淘汰。
 */
const inflight = new Map<string, Promise<HighlightSpan[] | null>>();

function cacheKey(code: string, lang: string): string {
  return `${THEME_VERSION}\u0000${lang}\u0000${code}`;
}

function remember(key: string, value: HighlightSpan[] | null, chars: number): void {
  const previous = cache.get(key);
  if (previous !== undefined) {
    cache.delete(key);
    cacheChars -= previous.chars;
    if (previous.value === null) cacheFailures -= 1;
  }
  cache.set(key, { value, chars });
  cacheChars += chars;
  if (value === null) cacheFailures += 1;
  while (cache.size > MAX_CACHE_ENTRIES || cacheChars > MAX_CACHE_CHARS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    const entry = cache.get(oldest.value);
    cache.delete(oldest.value);
    cacheChars -= entry?.chars ?? 0;
    if (entry?.value === null) cacheFailures -= 1;
  }
}

/** 缓存可观察面：测试据此断言命中 / 失败缓存 / 双限清理。 */
export function highlightCacheStats(): { entries: number; chars: number; failures: number } {
  return { entries: cache.size, chars: cacheChars, failures: cacheFailures };
}

/** 仅供测试隔离；生产调用方没有理由清空缓存。 */
export function resetHighlightCache(): void {
  cache.clear();
  cacheChars = 0;
  cacheFailures = 0;
}

function normalizeNul(value: string): string {
  return value.replace(/\0/gu, "\uFFFD");
}

/**
 * token 列表 → 源码偏移段。任何越界、倒序、长度或内容不符都返回 undefined（整块回退）。
 */
function spansFromTokens(code: string, tokens: readonly { content: string; offset?: number; color?: string; fontStyle?: number }[]): HighlightSpan[] | undefined {
  const spans: HighlightSpan[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const start = token.offset;
    const length = token.content.length;
    if (start === undefined || !Number.isSafeInteger(start) || start < cursor || length === 0) return undefined;
    const end = start + length;
    if (!Number.isSafeInteger(end) || end > code.length) return undefined;
    const slice = code.slice(start, end);
    if (slice.length !== length) return undefined;
    // 允许的唯一规范差异：Shiki 把 NUL 写成 U+FFFD；显示的仍是源码切片。
    if (slice !== token.content && normalizeNul(slice) !== token.content) return undefined;
    if (start > cursor) {
      spans.push({ start: cursor, end: start });
      if (spans.length > MAX_SPANS) return undefined;
    }
    spans.push({
      start,
      end,
      ...(safeColor(token.color) === undefined ? {} : { color: safeColor(token.color) }),
      ...(safeFontStyle(token.fontStyle) === undefined ? {} : { fontStyle: safeFontStyle(token.fontStyle) }),
    });
    cursor = end;
    if (spans.length > MAX_SPANS) return undefined;
  }
  if (cursor < code.length) {
    spans.push({ start: cursor, end: code.length });
    if (spans.length > MAX_SPANS) return undefined;
  }
  return cursor <= code.length ? spans : undefined;
}

/**
 * 把整段源码的 token 段切成逐行局部偏移：第 N 项只含该行的 span，`start`/`end`
 * 相对这一行文本（不含行尾换行）。切行只做区间相交，不改 token 颜色 / 字形，
 * 也不重新 tokenize——多行注释等跨行语法的事实已在整段 token 里。
 *
 * 行数严格等于 `code.split("\n").length`；空行给空数组。跨行 span（通常是 token
 * 之间的换行缺口）按行裁剪，不属于任何一行的换行字符不进入渲染。
 */
export function splitSpansByLine(code: string, spans: readonly HighlightSpan[]): HighlightSpan[][] {
  const lines: HighlightSpan[][] = [];
  let lineStart = 0;
  let spanIndex = 0;
  for (;;) {
    const newline = code.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? code.length : newline;
    const lineSpans: HighlightSpan[] = [];
    while (spanIndex < spans.length && spans[spanIndex].end <= lineStart) spanIndex += 1;
    for (let index = spanIndex; index < spans.length && spans[index].start < lineEnd; index += 1) {
      const span = spans[index];
      const start = Math.max(span.start, lineStart);
      const end = Math.min(span.end, lineEnd);
      if (end > start) {
        lineSpans.push({
          start: start - lineStart,
          end: end - lineStart,
          ...(span.color === undefined ? {} : { color: span.color }),
          ...(span.fontStyle === undefined ? {} : { fontStyle: span.fontStyle }),
        });
      }
      // 跨行的 span 留给下一行继续裁剪；后面的 span 起点更晚，这一行不用再看。
      if (span.end > lineEnd) break;
    }
    lines.push(lineSpans);
    if (newline === -1) return lines;
    lineStart = newline + 1;
  }
}

/**
 * 高亮一段源码并切成逐行 span：整段只 tokenize 一次，返回与
 * `code.split("\n")` 对齐的数组；不支持 / 超长 / 失败返回 null。
 *
 * read 卡与 diff 的每一侧都用这一份结果按行取 span，不能逐行调用
 * `highlightCode`——逐行重置会让多行注释、跨行字符串丢掉前文状态。
 */
export async function highlightLines(code: string, lang: string | undefined): Promise<HighlightSpan[][] | null> {
  const spans = await highlightCode(code, lang);
  return spans === null ? null : splitSpansByLine(code, spans);
}

/**
 * 高亮一段代码。返回源码偏移段；`null` 表示按纯文本显示（不支持 / 超长 / 引擎或
 * token 校验失败）。失败也进缓存，避免每次重渲染重复尝试。
 *
 * 同一 key 的并发调用共享同一个任务：只有一次 tokenize 与一次 `remember`，缓存
 * 记账不会翻倍。任务完成后从 inflight 摘除，后续调用走缓存。
 */
export async function highlightCode(code: string, lang: string | undefined): Promise<HighlightSpan[] | null> {
  const normalized = normalizeLang(lang);
  if (normalized === undefined || code === "" || code.length > MAX_HIGHLIGHT_CHARS) return null;
  // 先于引擎：单行过长直接纯文本，避免平方级单行 tokenize 卡住界面。
  if (hasOversizedLine(code)) return null;
  const key = cacheKey(code, normalized);
  const cached = cache.get(key);
  if (cached !== undefined) return cached.value;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const task = tokenize(code, normalized, key);
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

async function tokenize(code: string, lang: string, key: string): Promise<HighlightSpan[] | null> {
  try {
    const shiki = await highlighter();
    const lines = shiki.codeToTokensBase(code, {
      lang,
      theme: THEME_NAME,
      tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS,
    });
    const spans = spansFromTokens(code, lines.flat());
    remember(key, spans ?? null, code.length);
    return spans ?? null;
  } catch {
    remember(key, null, code.length);
    return null;
  }
}
