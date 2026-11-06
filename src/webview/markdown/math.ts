import type { Code, Root, RootContent } from "mdast";
import type { InlineMath, Math as MathNode } from "mdast-util-math";
import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  CompileContext,
  Extension as FromMarkdownExtension,
} from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import type {
  Construct,
  Effects,
  Extension,
  State,
  Token,
  TokenizeContext,
} from "micromark-util-types";
import { codes } from "micromark-util-symbol";
import { cjkFriendlyStrong } from "../../vendor/ui-primitives/markdown/cjkFriendlyStrong";
import { recoverLocalImages } from "../../vendor/ui-primitives/markdown/local-image-syntax";
import { mathCompatibility } from "../../vendor/ui-primitives/markdown/mathCompatibility";
import { windowsPathDestinations } from "../../vendor/ui-primitives/markdown/windows-path-destinations";
import { codePayload, type CodeSource } from "./source";

/**
 * 完成态数学的**解析事实**适配（不排版、不接 KaTeX）。
 *
 * 上游 `parseGfmWithMath` 的语法规则不复制：这里用与 vendor 相同的扩展集合与顺序
 * （`gfm` + `cjkFriendlyStrong` + `mathCompatibility` + `math`）调**一次**
 * `fromMarkdown`，再做官方同款的本地图片恢复。不同点只有两处公开扩展的包装：
 *
 * 1. `math()` 的文本 construct（`text[36]`）：在 `$` 起始处用 `this.now().offset`
 *    读同一份 source，命中保守金额形状就 `nok`，否则原样委托。源文不改写、不插入
 *    占位符、不二次解析；代码 / 行内代码 / 链接目标 / HTML / 实体仍由官方语法接管。
 * 2. `mathFromMarkdown().exit.mathFlowFence`：记录开 / 关围栏 token 的 offset。
 *    `closed` 只由是否收到关闭围栏 token 决定；EOF 结束的 flow（包括
 *    `$$\nx+y $$` 这种行内 `$$` 并不是合法 flow 关闭）只有开事件，记为未闭合。
 *    官方 handler 会把 `fragment` 压到栈顶，所以找 math 节点要从栈尾向前找最近的
 *    `type === "math"`，不能只看 `stack[stack.length - 1]`。
 *
 * 解析后只做一次树遍历，把 `MathSource` 写进节点的 data（命名空间键），
 * 不建 module 级活跃上下文，也不按公式重新 parse。`raw` 永远来自
 * `position` 的源码切片；`tex` 永远取官方委托后的 `node.value`（引用 / 列表的
 * `> `、缩进已被官方剥掉）。缺位置或无法确认关闭事实时不标事实，渲染层继续用
 * `sourceFallback` 原文回退。
 *
 * 解析层的 `math` 围栏仍是 `code` 节点；[mathFenceSource] 用已有 `codeSources`
 * 提供 raw / 精确载荷 / 权威闭合事实，供渲染层在 settled 转成 MathView。
 * `tex` / `latex` 围栏仍按普通代码处理。
 */

/** 数学定界符；`$$` / `\[` 在产品契约里是 display，即使官方产的是 inlineMath。 */
export type MathDelimiter = "$" | "$$" | "\\(" | "\\[";

/** 产品渲染形态：由定界符决定，不只看 mdast 节点类型。 */
export type MathForm = "inline" | "display";

/** 一个已由官方语法确认的公式候选的独立事实。 */
export interface MathSource {
  /** `$` / `\(` 为 inline；`$$` / `\[` 为 display（含同线 `$$` 的 inlineMath 节点）。`closed=false` 时只作原文回退，不排版。 */
  readonly form: MathForm;
  readonly delimiter: MathDelimiter;
  /** 是否真的读到关闭围栏；行内数学由语法保证为 true，flow 由 token 事实决定。 */
  readonly closed: boolean;
  /** 源码起点（含定界符），闭区间左端。 */
  readonly start: number;
  /** 源码终点（含定界符），开区间右端。 */
  readonly end: number;
  /** 源码原样切片（含定界符与容器前缀）；失败回退用它，不拼 node.value。 */
  readonly raw: string;
  /** 官方去容器标记后的有效 TeX 载荷（`node.value`）；不要拿 raw 当载荷。 */
  readonly tex: string;
}

/** `math` 围栏在解析层仍是代码节点；这些事实供 settled 渲染转换使用，未闭合时原文回退。 */
export interface MathFenceSource {
  readonly form: "display";
  readonly closed: boolean;
  readonly start: number;
  readonly end: number;
  /** 含围栏与容器的源码切片，未闭合时按原文回退。 */
  readonly raw: string;
  /** 去掉围栏与容器缩进后的精确代码载荷（已有 `codeSources` / `codePayload`）。 */
  readonly tex: string;
}

const MATH_DATA_KEY = "dshMathSource";

/** 金额判定只看一小段窗口；超过窗口说明更像公式或普通长文本，不猜。 */
const CURRENCY_WINDOW = 64;
const CURRENCY_AMOUNT = /^[0-9]+(?:[.,][0-9]+)*/u;
const CURRENCY_TEX = /[\\{}_^=+*/<>]/u;
/** 金额后接空格 + 至少两个字母（"5 and "），单字母 / 纯空白保留数学。 */
const CURRENCY_WORD = /^[ \t]+\p{L}{2,}/u;
const CURRENCY_SEPARATORS = /^[\s.,;:、，；：。]+$/u;
const CURRENCY_PUNCTUATION = /[.,;:、，；：。]/u;
/** 金额后接标点、空白与短词（"5. It costs "）；不是通用语言识别。 */
const CURRENCY_PUNCTUATED_WORD = /^[.,;:、，；：。]+[ \t]+\p{L}{2,}/u;

interface FlowFenceFacts {
  readonly openStart: number;
  readonly openEnd: number;
  closeStart?: number;
  closeEnd?: number;
}

/**
 * 解析一份完成态文档的根：官方数学语法 + 本地的金额否决 / 围栏事实记录。
 *
 * 不跑 Windows 目标修复、定义收集或代码源文提取——那些仍由 `parse.ts` 统一处理。
 */
export function parseSettledRoot(source: string): Root {
  const text = source ?? "";
  const flow = recordFlowFences(mathFromMarkdown());
  const root = recoverLocalImages(
    fromMarkdown(text, {
      extensions: createSettledSyntax(text),
      mdastExtensions: [gfmFromMarkdown(), flow.extension, windowsPathDestinations()],
    }),
    text,
  );
  annotateMathSources(root, text, flow.facts);
  return root;
}

/** mdast 与代码源码事件流必须复用同一套完成态语法，包括扩展顺序与金额否决。 */
export function createSettledSyntax(source: string): Extension[] {
  const syntax = math();
  const dollarText = syntax.text?.[codes.dollarSign];
  if (dollarText === undefined || Array.isArray(dollarText)) {
    throw new Error("micromark-extension-math: missing dollar text construct");
  }
  const vetoedText: Construct = {
    ...dollarText,
    tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
      if (isCurrencyDollar(source, this.now().offset)) return nok;
      return dollarText.tokenize.call(this, effects, ok, nok);
    },
  };
  return [
    gfm({ singleTilde: false }),
    cjkFriendlyStrong(),
    mathCompatibility(),
    { ...syntax, text: { ...(syntax.text ?? {}), [codes.dollarSign]: vetoedText } },
  ];
}

/** 读取某个节点上的公式事实；未标记（未识别 / 缺位置）返回 undefined。 */
export function mathSourceOf(node: RootContent): MathSource | undefined {
  const value = mathData(node)?.[MATH_DATA_KEY];
  return isMathSource(value) ? value : undefined;
}

/**
 * `math` 围栏的展示事实，供渲染层在 settled 转成 MathView。
 *
 * 闭合事实来自 [CodeSource.closed]（micromark 围栏 token 计数），载荷来自
 * [codePayload]；`tex` / `latex` 围栏不进入。
 */
export function mathFenceSource(
  node: Code,
  source: string,
  codeSources: ReadonlyMap<number, CodeSource>,
): MathFenceSource | undefined {
  if (node.lang?.trim().toLowerCase() !== "math") return undefined;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return undefined;
  const extracted = codeSources.get(start);
  if (extracted === undefined) return undefined;
  return {
    form: "display",
    closed: extracted.closed,
    start,
    end,
    raw: source.slice(start, end),
    tex: codePayload(node, source, codeSources).text,
  };
}

/**
 * 保守的单个美元金额判定。
 *
 * 只在**官方语法正要开启一个单 `$` 行内公式**时调用；返回 true 表示这个 `$`
 * 按普通文本处理。规则刻意窄：`$$` 永不参与；金额后必须还有正文；尾空格、
 * 纯数字、单个标点都不足以判成金额。歧义时保留明确闭合的数学。
 *
 * 已知边界（设计文档同步记录）：`$5.00$`、`$5-$10`、文末 `$5 USD$`、关闭 `$`
 * 后是空白等情况仍按官方数学处理；不做通用语言识别。
 */
function isCurrencyDollar(source: string, open: number): boolean {
  if (source[open] !== "$" || source[open + 1] === "$") return false;

  const limit = Math.min(source.length, open + CURRENCY_WINDOW);
  let close = -1;
  for (let index = open + 1; index < limit; index += 1) {
    if (source[index] === "$") {
      close = index;
      break;
    }
  }
  if (close < 0) return false;
  // `$$` 连写时这个位置不是官方关闭处（tokenizer 会把整段 run 当内容），
  // 不把半截当金额，也不改源文。
  if (source[close + 1] === "$") return false;

  const content = source.slice(open + 1, close);
  if (content.includes("\n") || content.includes("\r")) return false;
  const amount = CURRENCY_AMOUNT.exec(content);
  if (amount === null) return false;
  const tail = content.slice(amount[0].length);
  if (tail === "" || CURRENCY_TEX.test(tail)) return false;

  // 关闭后必须紧接正文。文末或空白后的 `$` 不猜金额，这样 `$5 $ and $x$`、
  // `$5,$`、`$5.$` 仍保留为数学。字母 / 数字之外，`\alpha`、`-x` 这类后继公式
  // 也必须放行：金额分支不能把下一个公式的起始符当成句末。
  const after = source[close + 1] ?? "";
  if (after === "" || /\s/u.test(after)) return false;

  // 自然语言金额前缀（"5 and " / "5. It costs "）：关闭后的任意非空白字符都可能是
  // 下一段正文或下一个公式，不要求它是字母数字。
  if (CURRENCY_WORD.test(tail) || CURRENCY_PUNCTUATED_WORD.test(tail)) return true;

  // 仅分隔符的尾（"5.00、" / "5, "）更保守：关闭后只认字母、数字、TeX 反斜杠
  // 与负号，避免把少数标点型数学误判成金额；`$5,$` / `$5.$` 因文末无后续仍保留。
  return CURRENCY_SEPARATORS.test(tail)
    && CURRENCY_PUNCTUATION.test(tail)
    && (/[\p{L}\p{N}\\]/u.test(after) || after === "-");
}

function recordFlowFences(
  mdast: FromMarkdownExtension,
): { readonly facts: Map<number, FlowFenceFacts>; readonly extension: FromMarkdownExtension } {
  const facts = new Map<number, FlowFenceFacts>();
  const openFences: number[] = [];
  const exit = mdast.exit;
  const original = exit?.mathFlowFence;
  if (exit === undefined || original === undefined) {
    throw new Error("mdast-util-math: missing mathFlowFence exit handler");
  }
  return {
    facts,
    extension: {
      ...mdast,
      exit: {
        ...exit,
        mathFlowFence(this: CompileContext, token: Token): void {
          if (this.data.mathFlowInside === true) {
            const openStart = openFences.pop();
            const fact = openStart === undefined ? undefined : facts.get(openStart);
            if (fact !== undefined) {
              fact.closeStart = token.start.offset;
              fact.closeEnd = token.end.offset;
            }
          } else {
            const node = nearestMath(this.stack);
            const openStart = node?.position?.start.offset ?? token.start.offset;
            facts.set(openStart, {
              openStart: token.start.offset,
              openEnd: token.end.offset,
            });
            openFences.push(openStart);
          }
          original.call(this, token);
        },
      },
    },
  };
}

function nearestMath(stack: CompileContext["stack"]): MathNode | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const node = stack[index];
    if (node?.type === "math") return node;
  }
  return undefined;
}

function annotateMathSources(
  root: Root,
  source: string,
  fences: ReadonlyMap<number, FlowFenceFacts>,
): void {
  const visit = (node: Root | RootContent): void => {
    if (node.type === "inlineMath") {
      const fact = inlineMathSource(node, source);
      if (fact !== undefined) setMathData(node, fact);
    } else if (node.type === "math") {
      const fact = flowMathSource(node, source, fences);
      if (fact !== undefined) setMathData(node, fact);
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
}

function inlineMathSource(node: InlineMath, source: string): MathSource | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return undefined;
  const raw = source.slice(start, end);
  const delimiter = inlineDelimiter(raw);
  if (delimiter === undefined) return undefined;
  return {
    form: formOf(delimiter),
    delimiter,
    closed: true,
    start,
    end,
    raw,
    tex: node.value,
  };
}

function flowMathSource(
  node: MathNode,
  source: string,
  fences: ReadonlyMap<number, FlowFenceFacts>,
): MathSource | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return undefined;
  const raw = source.slice(start, end);
  const delimiter = displayDelimiter(raw);
  if (delimiter === undefined) return undefined;
  const fence = fences.get(start);
  // 没有围栏事实就不声称闭合与否；渲染层按 sourceFallback 原文处理。
  if (fence === undefined) return undefined;
  return {
    form: "display",
    delimiter,
    closed: fence.closeStart !== undefined,
    start,
    end,
    raw,
    tex: node.value,
  };
}

function inlineDelimiter(raw: string): MathDelimiter | undefined {
  if (raw.startsWith("\\(")) return "\\(";
  if (raw.startsWith("\\[")) return "\\[";
  if (raw.startsWith("$$")) return "$$";
  if (raw.startsWith("$")) return "$";
  return undefined;
}

function displayDelimiter(raw: string): MathDelimiter | undefined {
  if (raw.startsWith("$$")) return "$$";
  if (raw.startsWith("\\[")) return "\\[";
  return undefined;
}

function formOf(delimiter: MathDelimiter): MathForm {
  return delimiter === "$$" || delimiter === "\\[" ? "display" : "inline";
}

function isMathSource(value: unknown): value is MathSource {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MathSource>;
  return (candidate.form === "inline" || candidate.form === "display")
    && isDelimiter(candidate.delimiter)
    && typeof candidate.closed === "boolean"
    && isOffset(candidate.start)
    && isOffset(candidate.end)
    && typeof candidate.raw === "string"
    && typeof candidate.tex === "string";
}

/**
 * mdast 各节点的 `data` 类型是官方 data 接口的联合，没有开放索引签名；
 * 本模块只放一个命名空间私有键，读取 / 写入经这层窄转换，不修改官方形状。
 */
type MathDataCarrier = { data?: Record<string, unknown> };

function mathData(node: RootContent): Record<string, unknown> | undefined {
  return (node as unknown as MathDataCarrier).data;
}

function setMathData(node: RootContent, fact: MathSource): void {
  (node as unknown as MathDataCarrier).data = {
    ...mathData(node),
    [MATH_DATA_KEY]: fact,
  };
}

function isDelimiter(value: unknown): value is MathDelimiter {
  return value === "$" || value === "$$" || value === "\\(" || value === "\\[";
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
