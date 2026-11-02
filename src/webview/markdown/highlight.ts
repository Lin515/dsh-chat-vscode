/**
 * 官方高亮核心的宿主适配层。语法、别名、引擎、主题和 token 样式由固定来源的
 * vendor/highlight 提供；路径语言由官方 code-language 提供，不维护第二份语言表。
 *
 * 本层只保留：宿主输入兼容、官方语法异步就绪、--shiki-* 到既有调色变量的映射、
 * 原文偏移校验、资源上限与有界缓存。显示始终切原 code；不使用 HTML 高亮臂。
 * 正文及工具面的 phase、身份隔离和选区冻结继续由 useCodeHighlight 控制。
 */
import {
  grammarForHint,
  StreamingHighlightSession,
  subscribeGrammarLoaded,
  type HighlightSpan as VendorSpan,
} from "../../vendor/ui-primitives/markdown/highlight";
import { languageForPath as officialLanguageForPath } from "../../vendor/code-language";

const THEME_VERSION = 2;
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
/** 单块最多多少段（含普通文本缺口），防止极碎 token 撑出几十万节点。 */
const MAX_SPANS = 4_000;
/** 缓存条数上限。 */
export const MAX_CACHE_ENTRIES = 64;
/** 缓存总字符上限（按 key 的代码长度累计）。 */
export const MAX_CACHE_CHARS = 200_000;

/** 受控文本修饰位（TextMate fontStyle）：1 斜体 / 2 粗体 / 4 下划线 / 8 删除线。 */
export interface HighlightSpan {
  readonly start: number;
  readonly end: number;
  /** 只可能是本地主题生成的 `var(--md-code-*)` 之一；普通缺口为空。 */
  readonly color?: string;
  readonly fontStyle?: number;
}

/** 首个语言标识（小写）；空串 / 空白返回 undefined。 */
function firstLangId(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined;
  const first = lang.trim().toLowerCase().split(/[\s,{}[\]()]/u)[0] ?? "";
  return first === "" ? undefined : first;
}

/** 仅兼容宿主既有元数据；其余别名与语法选择全部由官方表决定。 */
const HOST_HINTS = new Map([
  ["typescriptreact", "tsx"], ["javascriptreact", "jsx"],
  ["pwsh", "powershell"], ["c++", "cpp"], ["c#", "csharp"],
]);

/** info string 取首个标识后，交给官方别名 / 文件扩展名表。 */
export function normalizeLang(lang: string | undefined): string | undefined {
  const first = firstLangId(lang);
  if (first === undefined) return undefined;
  const hint = HOST_HINTS.get(first) ?? first;
  return grammarForHint(hint) ?? grammarForHint(officialLanguageForPath(`file.${hint}`));
}

/** 直接复用官方路径语义，包含 .env、jsonl、psm1、vue 等扩展名。 */
export function languageForPath(path: string | undefined): string | undefined {
  return path === undefined ? undefined : officialLanguageForPath(path);
}

/** 可识别元数据优先；显式纯文不按路径反悔；其余回退官方路径语言。 */
export function resolveLanguage(lang: string | undefined, path: string | undefined): string | undefined {
  const first = firstLangId(lang);
  if (first === "text" || first === "plaintext") return undefined;
  return normalizeLang(lang) ?? normalizeLang(languageForPath(path));
}

/** 是否存在超过单行上限的行（按 LF / CRLF / CR 切分，行尾不计数）。 */
function hasOversizedLine(code: string): boolean {
  for (const line of code.split(/\r\n|\r|\n/u)) {
    if (line.length > MAX_HIGHLIGHT_LINE_CHARS) return true;
  }
  return false;
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

/** 官方只产出主题变量；映射到扩展已有四主题变量，不接受任意 CSS。 */
function hostColor(value: unknown): string | undefined {
  return typeof value === "string" && /^var\(--shiki-(?:foreground|token-[a-z-]+)\)$/u.test(value)
    ? value.replace("--shiki-", "--md-code-") : undefined;
}

/** 官方样式对象只取本宿主可呈现的字形，不改官方 token 的计算。 */
function hostFontStyle(style: VendorSpan["style"]): number | undefined {
  const decoration = typeof style.textDecoration === "string" ? style.textDecoration.split(/\s+/u) : [];
  const bits = (style.fontStyle === "italic" ? 1 : 0) | (style.fontWeight === "bold" ? 2 : 0)
    | (decoration.includes("underline") ? 4 : 0) | (decoration.includes("line-through") ? 8 : 0);
  return bits === 0 ? undefined : bits;
}

/**
 * 官方提供逐行文本 run，宿主将它们对齐到原文行（保留 CRLF/CR/LF 的独立缺口）。
 * 仅允许引擎 NUL→U+FFFD 差异；任何行数 / 内容不符都整块回退，绝不猜偏移。
 */
function spansFromRuns(code: string, lines: readonly VendorSpan[][]): HighlightSpan[] | undefined {
  const spans: HighlightSpan[] = [];
  const sourceLines = code.split(/\r\n|\r|\n/u);
  if (lines.length > sourceLines.length) return undefined;
  let offset = 0;
  for (let index = 0; index < sourceLines.length; index += 1) {
    const source = sourceLines[index];
    const runs = lines[index] ?? [];
    let column = 0;
    for (const run of runs) {
      const text = source.slice(column, column + run.text.length);
      if (text.length !== run.text.length || (text !== run.text && text.replace(/\0/gu, "\uFFFD") !== run.text)) return undefined;
      if (run.text.length === 0) continue;
      const color = hostColor(run.style.color);
      const fontStyle = hostFontStyle(run.style);
      spans.push({ start: offset + column, end: offset + column + text.length,
        ...(color === undefined ? {} : { color }), ...(fontStyle === undefined ? {} : { fontStyle }) });
      column += text.length;
      if (spans.length > MAX_SPANS) return undefined;
    }
    if (column !== source.length) return undefined;
    offset += source.length;
    const eol = code.startsWith("\r\n", offset) ? 2 : /[\r\n]/u.test(code[offset] ?? "") ? 1 : 0;
    if (eol > 0) {
      spans.push({ start: offset, end: offset + eol });
      offset += eol;
      if (spans.length > MAX_SPANS) return undefined;
    }
  }
  return offset === code.length ? spans : undefined;
}

/**
 * 使用官方会保留字形的 span 臂；新会话只做一次完整高亮，不开启产品流式高亮。
 * 先订阅再请求，异步语法就绪后重试；超时解绑，不永久持有源码 / listener。
 */
function officialRuns(code: string, lang: string): Promise<readonly VendorSpan[][] | undefined> {
  return new Promise((resolve) => {
    const session = new StreamingHighlightSession();
    let detach: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: readonly VendorSpan[][] | undefined) => {
      detach?.();
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    const attempt = () => {
      try {
        const runs = session.update(code, lang);
        if (runs !== undefined) finish(runs);
      } catch { finish(undefined); }
    };
    detach = subscribeGrammarLoaded(attempt);
    timer = setTimeout(() => finish(undefined), 10_000);
    attempt();
  });
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
    const lines = await officialRuns(code, lang);
    const spans = lines === undefined ? undefined : spansFromRuns(code, lines);
    remember(key, spans ?? null, code.length);
    return spans ?? null;
  } catch {
    remember(key, null, code.length);
    return null;
  }
}
