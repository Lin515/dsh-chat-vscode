/**
 * 完成态数学的 KaTeX 排版入口。引擎、私有净化与本地资源已完成，并由
 * [MathView](<../components/MathView.tsx>) 在 settled 接线。
 *
 * 调用方只给已经由语法确认的公式事实；本模块不接受原始 HTML、不扫描 DOM、
 * 不把公式缓存起来。唯一的模块级状态是引擎加载 Promise：每份文档、每个公式
 * 都重新渲染，宏表每次都是新的，`\gdef` 不跨公式泄漏。
 *
 * 失败一律返回 `undefined`，由 MathView 用 `raw` 原文回退：未闭合、超长、
 * 无 DOM、KaTeX 抛错、真实 `katex-error` 输出、净化失败或无法确认结构。
 * 不把「来自 KaTeX」当作跳过净化的理由；净化在 [mathSanitize.ts](<mathSanitize.ts>)
 * 的私有 DOMPurify 实例里做，只接受 KaTeX 实际输出的受限结构。
 */

/** 单条公式的源码长度上限（UTF-16 code units）；超限直接回退原文。 */
export const MAX_MATH_TEX_LENGTH = 4000;

/** KaTeX 输出 HTML 的有界上限；正常排版远小于此值，超限按失败回退。 */
export const MAX_MATH_HTML_LENGTH = 2_000_000;

/** `renderMath` 接受的最小共同接口，兼容 `MathSource` 与 `MathFenceSource`。 */
export interface MathRenderSource {
  readonly form: "inline" | "display";
  readonly closed: boolean;
  readonly tex: string;
  readonly raw: string;
}

/** 净化后的 KaTeX 输出；`html` 同时含 MathML 辅助层与视觉层。 */
export interface MathRendered {
  readonly html: string;
  readonly form: "inline" | "display";
}

interface KatexEngine {
  renderToString(
    tex: string,
    options: {
      displayMode: boolean;
      output: "htmlAndMathml";
      trust: false;
      throwOnError: true;
      strict: "ignore";
      globalGroup: false;
      maxSize: number;
      maxExpand: number;
      macros: Record<string, never>;
    },
  ): string;
}

/**
 * 引擎加载 Promise 的模块级缓存。只缓存加载结果，不缓存公式、宏表或渲染结果，
 * 也不提供可替换的 loader 全局开关。首次真正渲染时才触发动态 import。
 */
let enginePromise: Promise<KatexEngine> | undefined;

function loadEngine(): Promise<KatexEngine> {
  enginePromise ??= import("katex").then((module) => module.default);
  return enginePromise;
}

/**
 * 真实 KaTeX 渲染 seam：Node 里可直接测引擎行为（宏隔离、限额、失败、trust）。
 *
 * 固定 0.16.47 的安全选项：`trust: false` 不渲染 `\href` / `\url` /
 * `\includegraphics` 等可信命令；`throwOnError` 把真实语法错误抛出后由本函数
 * 收成 `undefined`；`maxSize` / `maxExpand` 有界；`globalGroup: false` 阻止
 * `\gdef` 污染全局宏表；每次传入新的 `macros: {}`，公式之间不共享宏。
 *
 * `trust: false` 下 KaTeX 对可信命令的真实行为是**降级成红色文本而不是抛错**，
 * 因此不能靠红色或 `html.includes("katex-error")` 判失败（`\text{katex-error}`
 * 会误伤）。这里只接受真实 `class` 属性里的 `katex-error` token；可信命令由
 * 输出结构与净化白名单挡掉危险能力，不把红字猜成错误。
 */
export async function renderKatexHtml(
  tex: string,
  display: boolean,
): Promise<string | undefined> {
  if (typeof tex !== "string" || tex.length > MAX_MATH_TEX_LENGTH) return undefined;
  try {
    const katex = await loadEngine();
    const html = katex.renderToString(tex, {
      displayMode: display,
      output: "htmlAndMathml",
      trust: false,
      throwOnError: true,
      strict: "ignore",
      globalGroup: false,
      maxSize: 10,
      maxExpand: 1000,
      macros: {},
    });
    if (html.length > MAX_MATH_HTML_LENGTH) return undefined;
    if (hasKatexErrorClass(html)) return undefined;
    return html;
  } catch {
    return undefined;
  }
}

/**
 * 把一份已确认的公式事实排版成净化后的 HTML。
 *
 * 判断顺序刻意为：闭合 → 长度 → 表单 → DOM。这样 Node / SSR 导入与无 DOM 调用
 * 不会初始化 KaTeX，超长或未闭合也不会先付一次引擎加载。
 */
export async function renderMath(
  source: MathRenderSource,
): Promise<MathRendered | undefined> {
  if (source === null || typeof source !== "object") return undefined;
  if (source.closed !== true) return undefined;
  if (source.form !== "inline" && source.form !== "display") return undefined;
  if (typeof source.tex !== "string" || source.tex.length > MAX_MATH_TEX_LENGTH) {
    return undefined;
  }
  if (typeof window === "undefined" || typeof document === "undefined") return undefined;
  if (window.document === undefined) return undefined;

  try {
    const html = await renderKatexHtml(source.tex, source.form === "display");
    if (html === undefined) return undefined;
    const { sanitizeMathHtml } = await import("./mathSanitize");
    const clean = sanitizeMathHtml(html, window.document);
    if (clean === undefined) return undefined;
    return { html: clean, form: source.form };
  } catch {
    return undefined;
  }
}

/** 只看真实 `class` 属性 token；不把正文里的 `katex-error` 字样当错误。 */
function hasKatexErrorClass(html: string): boolean {
  for (const match of html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    const value = match[1] ?? match[2] ?? "";
    if (value.split(/\s+/u).includes("katex-error")) return true;
  }
  return false;
}
