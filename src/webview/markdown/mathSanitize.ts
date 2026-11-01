import createDOMPurify, { type DOMPurify as Purifier } from "dompurify";

/**
 * 数学输出的私有净化链：只服务 KaTeX 的 `htmlAndMathml` 输出，不向正文开放
 * 任意 HTML 入口。调用方必须传入已经从语法确认的公式；这条链不扫描 DOM、
 * 不识别用户正文，也不复用旧 `marked` 时代的整篇 HTML 净化器。
 *
 * 白名单按 **真实 namespace + tag** 收紧：
 * - HTML 只允许排版用的 `span`；
 * - MathML 只允许 KaTeX 实际产出的辅助语义元素；
 * - SVG 只允许 `svg` / `path` / `line` 三种几何元素。
 *
 * 危险属性（`href`、`xlink:*`、`src`、事件、`data-*`、`form*` 等）不在
 * DOMPurify 的允许表里，另有结构、namespace、class 与 style 值域校验。
 * 任一项无法确认就整体返回 `undefined`，由渲染层回退原文，绝不拼一份畸形数学。
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const SVG_NS = "http://www.w3.org/2000/svg";

/** 单条 style 属性的有界长度；KaTeX 实际值远小于此上限。 */
const MAX_STYLE_LENGTH = 4096;
/** 单个 SVG path 数据的有界长度；合法伸缩符号也远小于此上限。 */
const MAX_PATH_DATA_LENGTH = 20_000;
/** 任意坐标 / 排版长度的有界绝对值；400em / 400000 viewBox 仍合法。 */
const MAX_LENGTH_VALUE = 1_000_000;

/** 0.16.47 实际会输出的 class；不含正文项目类，`katex-error` 永不接受。 */
const KATEX_CLASSES = new Set(
  `
  accent accent-body accent-full accentunder amsrm angl anglpad arraycolsep base
  boldsymbol boxpad brace-center brace-left brace-right cancel-lap cancel-pad
  cd-arrow-pad cd-label-left cd-label-right cd-vert-arrow clap col-align-c
  col-align-l col-align-r colorbox delim-size1 delim-size4 delimcenter delimsizing
  eqn-num fbox fcolorbox fix fleqn fontsize-ensurer frac-line halfarrow-left
  halfarrow-right hbox hdashline hide-tail hline inner katex katex-display
  katex-html katex-mathml large-op leqno llap mainrm mathbb mathbf mathboldfrak
  mathboldsf mathcal mathfrak mathit mathitsf mathnormal mathrm mathscr mathsf
  mathsfit mathtt mbin mclose mfrac minner mml-eqn-num mop mopen mord mover mpunct
  mrel mspace msupsub mtable mtight mtr-glue mult munder newline nobreak nulldelimiter
  op-limits op-symbol overlay overline overline-line pstrut reset-size1 reset-size10
  reset-size11 reset-size2 reset-size3 reset-size4 reset-size5 reset-size6
  reset-size7 reset-size8 reset-size9 rlap root rule size1 size10 size11 size2 size3
  size4 size5 size6 size7 size8 size9 sizing small-op smash sout sqrt stretchy strut
  svg-align tag text textbb textbf textboldfrak textboldsf textfrak textit textitsf
  textrm textscr textsf texttt thinbox underline underline-line vbox
  vertical-separator vlist vlist-r vlist-s vlist-t vlist-t2 x-arrow x-arrow-pad
  `.trim().split(/\s+/u),
);

const MATHML_CLASSES = new Set(["mml-eqn-num", "mtr-glue"]);

/**
 * KaTeX 的 `mo` 里可能嵌这些辅助 token。HTML parser 把 `mo`（MathML text
 * integration point）的子元素按 HTML 建树，DOMPurify 随后会按 namespace 拒绝
 * 它们；这里只接受能安全折叠成 `mo` 文本的 token 集合。
 */
const MISNAMESPACED_MO_TOKEN_TAGS = new Set(["mi", "mn", "mo", "mtext"]);

/** 折叠后 token 文本的有界上限；正常运算符远小于此值。 */
const MAX_MO_TOKEN_TEXT_LENGTH = 512;

/** DOM 的 text node 类型值；不依赖浏览器全局 `Node`，便于 Node 纯断言。 */
const TEXT_NODE = 3;

type Namespace = "html" | "mathml" | "svg";

/** tag → 唯一允许的 namespace。 */
const TAG_NAMESPACES: Readonly<Record<string, Namespace>> = {
  span: "html",
  math: "mathml",
  semantics: "mathml",
  annotation: "mathml",
  mrow: "mathml",
  mi: "mathml",
  mn: "mathml",
  mo: "mathml",
  mtext: "mathml",
  mspace: "mathml",
  mfrac: "mathml",
  msqrt: "mathml",
  mroot: "mathml",
  mstyle: "mathml",
  mtable: "mathml",
  mtr: "mathml",
  mtd: "mathml",
  munder: "mathml",
  mover: "mathml",
  munderover: "mathml",
  msub: "mathml",
  msup: "mathml",
  msubsup: "mathml",
  mpadded: "mathml",
  mphantom: "mathml",
  menclose: "mathml",
  svg: "svg",
  path: "svg",
  line: "svg",
};

/** 每个 tag 允许的属性；值域在 `isValidAttributeValue` 里逐项校验。 */
const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  span: ["class", "style", "aria-hidden"],
  math: ["xmlns", "display"],
  semantics: [],
  annotation: ["encoding"],
  mrow: [],
  mi: ["mathvariant"],
  mn: ["mathvariant"],
  mo: [
    "mathvariant", "form", "fence", "stretchy", "symmetric", "separator",
    "largeop", "movablelimits", "lspace", "rspace", "minsize", "maxsize",
  ],
  mtext: ["mathvariant"],
  mspace: ["width", "height", "depth", "mathbackground"],
  mfrac: ["linethickness"],
  msqrt: [],
  mroot: [],
  mstyle: [
    "displaystyle", "scriptlevel", "mathcolor", "mathbackground", "mathsize",
    "style",
  ],
  mtable: [
    "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines",
    "rowlines", "width", "frame", "framespacing", "equalrows", "equalcolumns",
    "side", "displaystyle", "align",
  ],
  mtr: ["columnalign", "rowalign"],
  mtd: [
    "class", "width", "columnalign", "rowalign", "rowspan", "columnspan",
    "mathbackground",
  ],
  munder: ["accentunder"],
  mover: ["accent"],
  munderover: ["accent", "accentunder"],
  msub: [],
  msup: [],
  msubsup: [],
  mpadded: [
    "width", "height", "depth", "lspace", "voffset", "mathbackground", "style",
  ],
  mphantom: [],
  menclose: ["notation"],
  svg: [
    "xmlns", "width", "height", "viewBox", "viewbox", "preserveAspectRatio",
    "preserveaspectratio", "style",
  ],
  path: ["d"],
  line: ["x1", "y1", "x2", "y2", "stroke-width"],
};

const ALLOWED_TAGS = [...Object.keys(TAG_NAMESPACES), "#text"];
const ALLOWED_ATTR = [
  ...new Set(Object.values(TAG_ATTRIBUTES).flat()),
];

/**
 * DOMPurify 的文本节点 tag 名是 `#text`，必须显式进入 ALLOWED_TAGS；
 * 否则 `KEEP_CONTENT: false` 会把所有 mi / mtext / annotation / 视觉层文字删空，
 * 只留下空壳元素。导出只读清单供 Node 静态断言（真实 DOM 仍由主代理验收）。
 */
export const MATH_SANITIZE_TAGS: readonly string[] = ALLOWED_TAGS;

const LENGTH = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|pt|px|mu|cm|mm|in|pc|%)?$/u;
const MPADDED_LENGTH = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|pt|px|mu|cm|mm|in|pc|%|width)?$/u;
const COLOR = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z]{3,30}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]+\))$/u;
const BORDER_STYLE = /^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/u;
const VERTICAL_ALIGN = /^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/u;
const POSITION = /^(?:relative|absolute)$/u;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9+\-.,\s]+$/u;
const PRESERVE_ASPECT_RATIO = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?: (?:meet|slice))?$/u;
const MATH_VARIANT = /^(?:normal|bold|italic|bold-italic|double-struck|bold-fraktur|script|bold-script|fraktur|sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace|initial|tailed|looped|stretched)$/u;
const NOTATION = /^(?:longdiv|actuarial|radic|box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike|madruwb|updiagonalarrow|phasorangle)$/u;
const LINE_STYLE = /^(?:none|solid|dashed|dotted|double)$/u;
const COLUMN_ALIGN = /^(?:left|center|right)$/u;
const ROW_ALIGN = /^(?:top|center|bottom|baseline|axis)$/u;
const SCRIPT_LEVEL = /^[+-]?\d{1,2}$/u;
const SPAN_COUNT = /^\d{1,3}$/u;

/** 每个 style 属性自己的值域；不在表里的属性一律丢弃。 */
const STYLE_VALUES: Readonly<Record<string, (value: string) => boolean>> = {
  color: isColor,
  "background-color": isColor,
  border: isBorder,
  "border-width": (value) => isLengthList(value, 4),
  "border-style": (value) => isEnumList(value, 4, (item) => BORDER_STYLE.test(item)),
  "border-color": (value) => isLengthOrColorList(value, 4),
  "border-top-width": isLength,
  "border-right-width": isLength,
  "border-bottom-width": isLength,
  "border-left-width": isLength,
  "border-top-style": (value) => BORDER_STYLE.test(value),
  "border-right-style": (value) => BORDER_STYLE.test(value),
  "border-bottom-style": (value) => BORDER_STYLE.test(value),
  "border-left-style": (value) => BORDER_STYLE.test(value),
  "border-top-color": isColor,
  "border-right-color": isColor,
  "border-bottom-color": isColor,
  "border-left-color": isColor,
  height: isLengthOrCalc,
  width: isLengthOrCalc,
  "min-width": isLengthOrCalc,
  "min-height": isLengthOrCalc,
  "max-width": isLengthOrCalc,
  "max-height": isLengthOrCalc,
  top: isLength,
  bottom: isLength,
  left: isLength,
  right: isLength,
  margin: (value) => isLengthList(value, 4),
  "margin-left": isLength,
  "margin-right": isLength,
  "margin-top": isLength,
  "margin-bottom": isLength,
  padding: (value) => isLengthList(value, 4),
  "padding-left": isLength,
  "padding-right": isLength,
  "padding-top": isLength,
  "padding-bottom": isLength,
  position: (value) => POSITION.test(value),
  "vertical-align": (value) => VERTICAL_ALIGN.test(value) || isLength(value),
  "text-shadow": isTextShadow,
};

/** 有界长度：单位限于 CSS / KaTeX 实际用到的集合，百分数限制在 0–100。 */
function isLength(value: string): boolean {
  return isLengthWith(value, LENGTH);
}

function isMpaddedLength(value: string): boolean {
  return isLengthWith(value, MPADDED_LENGTH);
}

function isLengthWith(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value)) return false;
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > MAX_LENGTH_VALUE) return false;
  if (value.endsWith("%") && (numeric < 0 || numeric > 100)) return false;
  return true;
}

function isLengthOrCalc(value: string): boolean {
  if (isLength(value)) return true;
  const match = /^calc\((.+)\)$/iu.exec(value);
  if (match === null) return false;
  const tokens = match[1]!.trim().split(/\s+/u);
  if (tokens.length === 0 || tokens.length % 2 === 0) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (index % 2 === 0) {
      if (!isLength(token)) return false;
    } else if (token !== "+" && token !== "-") {
      return false;
    }
  }
  return true;
}

function isLengthList(value: string, max: number): boolean {
  const parts = value.trim().split(/\s+/u);
  return parts.length >= 1 && parts.length <= max && parts.every(isLength);
}

function isLengthOrColorList(value: string, max: number): boolean {
  const parts = value.trim().split(/\s+/u);
  return parts.length >= 1
    && parts.length <= max
    && parts.every((item) => isLength(item) || isColor(item));
}

function isEnumList(value: string, max: number, test: (item: string) => boolean): boolean {
  const parts = value.trim().split(/\s+/u);
  return parts.length >= 1 && parts.length <= max && parts.every(test);
}

function isColor(value: string): boolean {
  if (/^(?:url|var|env|expression|calc)$/iu.test(value)) return false;
  return COLOR.test(value);
}

function isBorder(value: string): boolean {
  const parts = value.trim().split(/\s+/u);
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((item) => isLength(item) || BORDER_STYLE.test(item) || isColor(item));
}

function isTextShadow(value: string): boolean {
  const parts = value.trim().split(/\s+/u);
  if (parts.length < 2 || parts.length > 4) return false;
  let lengths = 0;
  let colors = 0;
  for (const part of parts) {
    if (isLength(part)) {
      lengths += 1;
    } else if (isColor(part)) {
      colors += 1;
    } else {
      return false;
    }
  }
  return lengths >= 2 && colors <= 1;
}

/**
 * 正向清洗一条 KaTeX style：只保留实际排版属性与合法值。
 *
 * 危险 token（反斜杠转义、注释、`!important`）直接让整条 style 失效，避免
 * 解析器差异；其余按声明逐条丢弃。正常 KaTeX 输出全部落在白名单内，不会被改写。
 */
export function sanitizeMathStyle(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STYLE_LENGTH) {
    return undefined;
  }
  if (/[\\\0]|\/\*|\*\/|!important/iu.test(value)) return undefined;
  const declarations: string[] = [];
  for (const raw of value.split(";")) {
    const declaration = raw.trim();
    if (declaration === "") continue;
    const colon = declaration.indexOf(":");
    if (colon <= 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const propertyValue = declaration.slice(colon + 1).trim();
    const test = ownValue(STYLE_VALUES, property);
    if (test === undefined || propertyValue === "" || propertyValue.length > 512) continue;
    if (!test(propertyValue)) continue;
    declarations.push(`${property}:${propertyValue};`);
  }
  if (declarations.length === 0) return undefined;
  return declarations.join("");
}

/**
 * 单个属性是否属于该 namespace / tag，且值域合法。
 *
 * 供净化内部与测试共用；`style` 只判断“至少有一条安全声明”，真正写回时用
 * [sanitizeMathStyle] 的清洗结果。
 */
export function isAllowedMathAttribute(
  namespace: Namespace,
  tag: string,
  name: string,
  value: string,
): boolean {
  if (ownValue(TAG_NAMESPACES, tag) !== namespace) return false;
  const allowed = ownValue(TAG_ATTRIBUTES, tag);
  if (allowed === undefined || !allowed.includes(name)) return false;
  if (name === "class") return isAllowedMathClass(tag, value);
  if (name === "style") return sanitizeMathStyle(value) !== undefined;
  return isValidAttributeValue(tag, name, value);
}

/** 只读普通对象上的自有键；`constructor` / `__proto__` 等继承键不会命中。 */
function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isAllowedMathClass(tag: string, value: string): boolean {
  const tokens = value.trim().split(/\s+/u);
  if (tokens.length === 0 || tokens.some((token) => token === "")) return false;
  if (tag === "span") return tokens.every((token) => KATEX_CLASSES.has(token));
  if (tag === "mtd") return tokens.every((token) => MATHML_CLASSES.has(token));
  return false;
}

function isValidAttributeValue(tag: string, name: string, value: string): boolean {
  switch (`${tag}|${name}`) {
    case "math|xmlns":
      return value === MATHML_NS;
    case "svg|xmlns":
      return value === SVG_NS;
    case "math|display":
      return value === "block" || value === "inline";
    case "annotation|encoding":
      return value === "application/x-tex";
    case "span|aria-hidden":
      return value === "true";
    case "mi|mathvariant":
    case "mn|mathvariant":
    case "mo|mathvariant":
    case "mtext|mathvariant":
      return MATH_VARIANT.test(value);
    case "mo|form":
      return value === "prefix" || value === "infix" || value === "postfix";
    case "mo|fence":
    case "mo|stretchy":
    case "mo|symmetric":
    case "mo|separator":
    case "mo|largeop":
    case "mo|movablelimits":
    case "munder|accentunder":
    case "mover|accent":
    case "munderover|accent":
    case "munderover|accentunder":
    case "mstyle|displaystyle":
    case "mtable|equalrows":
    case "mtable|equalcolumns":
      return value === "true" || value === "false";
    case "mo|lspace":
    case "mo|rspace":
    case "mo|minsize":
    case "mo|maxsize":
      return isLength(value);
    case "mspace|width":
    case "mspace|height":
    case "mspace|depth":
      return isLength(value);
    case "mfrac|linethickness":
      return isLength(value) || value === "thin" || value === "medium" || value === "thick";
    case "mstyle|mathsize":
      return isLength(value);
    case "mstyle|scriptlevel":
      return SCRIPT_LEVEL.test(value) && Math.abs(Number(value.replace(/^\+/u, ""))) <= 10;
    case "mstyle|mathcolor":
    case "mstyle|mathbackground":
    case "mspace|mathbackground":
    case "mpadded|mathbackground":
    case "mtd|mathbackground":
      return isColor(value);
    case "mtable|columnalign":
    case "mtr|columnalign":
    case "mtd|columnalign":
      return isEnumList(value, 8, (item) => COLUMN_ALIGN.test(item));
    case "mtable|rowalign":
    case "mtr|rowalign":
    case "mtd|rowalign":
      return isEnumList(value, 8, (item) => ROW_ALIGN.test(item));
    case "mtable|columnspacing":
    case "mtable|rowspacing":
      return isLengthList(value, 8);
    case "mtable|columnlines":
    case "mtable|rowlines":
      return isEnumList(value, 8, (item) => LINE_STYLE.test(item));
    case "mtable|width":
    case "mtd|width":
      return isLength(value);
    case "mtable|frame":
      return LINE_STYLE.test(value);
    case "mtable|framespacing":
      return isLengthList(value, 4);
    case "mtable|side":
      return value === "left" || value === "right";
    case "mtable|align":
      return COLUMN_ALIGN.test(value);
    case "mtd|rowspan":
    case "mtd|columnspan":
      return SPAN_COUNT.test(value) && Number(value) >= 1 && Number(value) <= 100;
    case "mpadded|width":
    case "mpadded|height":
    case "mpadded|depth":
    case "mpadded|lspace":
    case "mpadded|voffset":
      return isMpaddedLength(value);
    case "menclose|notation":
      return isEnumList(value, 4, (item) => NOTATION.test(item));
    case "svg|width":
    case "svg|height":
      return isLength(value);
    case "svg|viewBox":
    case "svg|viewbox":
      return isValidViewBox(value);
    case "svg|preserveAspectRatio":
    case "svg|preserveaspectratio":
      return PRESERVE_ASPECT_RATIO.test(value);
    case "line|x1":
    case "line|y1":
    case "line|x2":
    case "line|y2":
      return isLength(value);
    case "line|stroke-width":
      return isLength(value) && Number.parseFloat(value) > 0;
    case "path|d":
      return isValidPathData(value);
    default:
      return false;
  }
}

function isValidViewBox(value: string): boolean {
  const parts = value.trim().split(/[\s,]+/u);
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (!numbers.every((number) => Number.isFinite(number))) return false;
  if (numbers.some((number) => Math.abs(number) > MAX_LENGTH_VALUE)) return false;
  return numbers[2]! > 0 && numbers[3]! > 0;
}

function isValidPathData(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_PATH_DATA_LENGTH
    && PATH_DATA.test(value)
    && /[MmLlHhVvCcSsQqTtAaZz]/u.test(value);
}

/** 一个被 HTML parser 重新按 HTML namespace 建树的 `mo` 子 token 的 DOM 事实。 */
export interface MisnamespacedMoTokenFacts {
  readonly namespace: string | undefined;
  readonly localName: string;
  readonly parentNamespace: string | undefined;
  readonly parentLocalName: string;
  readonly attributeCount: number;
  readonly childNodeTypes: readonly number[];
  readonly textContent: string;
}

/**
 * 判断一个被 HTML parser 放进 HTML namespace 的 `mo` 子 token 能否折叠成文本。
 *
 * HTML 解析规则把 MathML text integration point（`mi` / `mo` / `mn` / `ms` /
 * `mtext`）的子元素按 HTML 内容处理，所以 `<mo><mi>l</mi>…</mo>` 里的 `mi` 实际
 * 是 HTML 元素。DOMPurify 会正确拒绝 HTML namespace 里的 MathML tag（防
 * namespace 混淆），`KEEP_CONTENT:false` 随后把文字也剥掉；这里只把**完全可
 * 确认**的 token 折叠成 `mo` 的文本，保留 `lim` 等辅助语义。
 *
 * 接受条件刻意收紧到 HTML parser 对该结构的真实产物：父级是 MathML `mo`、
 * tag 属于 `mi` / `mn` / `mo` / `mtext`、没有任何属性、所有子节点都是文本、
 * 文本非空且有界。其他任何 HTML 元素（含带属性或嵌套元素的 token）都返回
 * `undefined`，由调用方把整式判为不可信，绝不让它被剥空后仍算成功。
 */
export function flattenableMisnamespacedMoTokenText(
  facts: MisnamespacedMoTokenFacts,
): string | undefined {
  if (facts.namespace !== HTML_NS) return undefined;
  if (facts.parentNamespace !== MATHML_NS || facts.parentLocalName !== "mo") {
    return undefined;
  }
  if (!MISNAMESPACED_MO_TOKEN_TAGS.has(facts.localName)) return undefined;
  if (facts.attributeCount !== 0) return undefined;
  if (facts.childNodeTypes.length === 0) return undefined;
  if (!facts.childNodeTypes.every((type) => type === TEXT_NODE)) return undefined;
  if (facts.textContent.length === 0) return undefined;
  if (facts.textContent.length > MAX_MO_TOKEN_TEXT_LENGTH) return undefined;
  return facts.textContent;
}

interface PurifierCache {
  readonly document: Document;
  readonly purifier: Purifier;
}

interface SanitizeRun {
  /** 辅助 MathML 里出现不能折叠的 HTML 元素时置位，整式回退。 */
  tainted: boolean;
}

/**
 * 当前同步净化调用的状态。`sanitizeMathHtml` 全程同步，DOMPurify 不会在
 * 另一次净化中途回调 hook；调用结束（含异常）后立即清空。
 */
let activeRun: SanitizeRun | undefined;

let cache: PurifierCache | undefined;

/**
 * 私有 DOMPurify 实例：按 document 缓存，不修改全局 DOMPurify 配置，也不把
 * 它的 hooks / 白名单暴露给正文。无 DOM 或运行环境不支持时返回 undefined。
 */
function purifierFor(document: Document): Purifier | undefined {
  if (cache?.document === document) return cache.purifier;
  const view = document.defaultView;
  if (view === null) return undefined;
  const purifier = createDOMPurify(view);
  if (!purifier.isSupported) return undefined;
  // 公共 hook：在 DOMPurify 的 namespace 校验之前规范化辅助 MathML。
  // 只处理每个 MathML `math` 根，一次遍历覆盖它下面所有被 parser 重新
  // 解释的 HTML 后代；正文视觉层（HTML `span`）不受影响。
  purifier.addHook("beforeSanitizeElements", (node) => {
    const run = activeRun;
    if (run === undefined || node.nodeType !== 1) return;
    const element = node as Element;
    if (element.namespaceURI !== MATHML_NS || element.localName !== "math") return;
    if (normalizeMisnamespacedMoTokens(element, document)) run.tainted = true;
  });
  cache = { document, purifier };
  return purifier;
}

/**
 * 把 MathML 辅助子树里被 HTML parser 重新按 HTML namespace 解释的 `mo` 子
 * token 折叠成文本；返回是否出现了不能折叠的 HTML 元素。
 *
 * 只遍历 `math` 的 HTML-namespace 后代。接受的分支只取纯文本子节点，且已由
 * [flattenableMisnamespacedMoTokenText] 确认零属性、无嵌套元素、文本有界；
 * 被替换下来的旧节点只含文本，没有可排队的事件处理器。不能折叠的 HTML 元素
 * 保持原样交给 DOMPurify 拒绝，同时把整式标记为 tainted，避免“剥空但成功”。
 */
function normalizeMisnamespacedMoTokens(math: Element, document: Document): boolean {
  let tainted = false;
  for (const element of [...math.querySelectorAll("*")]) {
    if (element.namespaceURI !== HTML_NS) continue;
    const parent = element.parentElement;
    const text = flattenableMisnamespacedMoTokenText({
      namespace: element.namespaceURI,
      localName: element.localName,
      parentNamespace: parent?.namespaceURI ?? undefined,
      parentLocalName: parent?.localName ?? "",
      attributeCount: element.attributes.length,
      childNodeTypes: [...element.childNodes].map((child) => child.nodeType),
      textContent: element.textContent ?? "",
    });
    if (text === undefined) {
      tainted = true;
      continue;
    }
    element.parentNode?.replaceChild(document.createTextNode(text), element);
  }
  return tainted;
}

/**
 * 净化一份 KaTeX HTML 并校验完整结构；失败返回 undefined。
 *
 * 结构必须仍是 `katex` / `katex-mathml` / `math` / `annotation` /
 * `katex-html`（`aria-hidden` 视觉层）；未知 tag、namespace、class 或关键属性
 * 不确定时整体回退，而不是输出一棵被削掉关键节点的畸形公式。
 */
export function sanitizeMathHtml(html: string, document: Document): string | undefined {
  if (typeof html !== "string" || html.length === 0 || html.length > 2_000_000) {
    return undefined;
  }
  if (document === undefined || document === null || typeof document.createElement !== "function") {
    return undefined;
  }
  const purifier = purifierFor(document);
  if (purifier === undefined) return undefined;

  let fragment: DocumentFragment;
  const run: SanitizeRun = { tainted: false };
  activeRun = run;
  try {
    fragment = purifier.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_NAMESPACES: [HTML_NS, MATHML_NS, SVG_NS],
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: false,
      RETURN_DOM_FRAGMENT: true,
      SANITIZE_DOM: true,
    });
  } catch {
    return undefined;
  } finally {
    activeRun = undefined;
  }
  // 辅助 MathML 里出现不能安全折叠的 HTML 元素时，DOMPurify 会拒绝该元素；
  // 不能把由此产生的空壳当成功，整式回退原文。
  if (run.tainted) return undefined;
  if (fragment === undefined || typeof fragment.querySelectorAll !== "function") {
    return undefined;
  }

  const roots = [...fragment.childNodes].filter((node) => node.nodeType === 1
    || (node.nodeType === 3 && (node.textContent ?? "").trim() !== ""));
  if (roots.length !== 1 || roots[0]!.nodeType !== 1) return undefined;
  const root = roots[0] as Element;
  if (!validateMathStructure(root)) return undefined;
  // 文本节点被误删时元素壳仍可能齐全；KaTeX 的 annotation / MathML / 视觉层
  // 必然带公式文字，空文本说明净化不可信，整体回退而不是交一棵空公式。
  if ((root.textContent ?? "").trim() === "") return undefined;

  try {
    const container = document.createElement("div");
    container.append(fragment);
    return container.innerHTML;
  } catch {
    return undefined;
  }
}

function validateMathStructure(root: Element): boolean {
  const rootNamespace = namespaceOf(root);
  if (rootNamespace !== "html" || root.localName !== "span") return false;
  if (!validateAndClean(root)) return false;

  let katex = root;
  if (hasClass(root, "katex-display")) {
    const children = elementChildren(root);
    if (children.length !== 1) return false;
    katex = children[0]!;
  }
  if (namespaceOf(katex) !== "html" || katex.localName !== "span") return false;
  if (!hasClass(katex, "katex")) return false;
  if (katex !== root && !validateAndClean(katex)) return false;

  const katexChildren = elementChildren(katex);
  if (katexChildren.length !== 2) return false;
  const [mathmlSpan, htmlSpan] = katexChildren;
  if (namespaceOf(mathmlSpan!) !== "html" || mathmlSpan!.localName !== "span") return false;
  if (namespaceOf(htmlSpan!) !== "html" || htmlSpan!.localName !== "span") return false;
  if (!hasClass(mathmlSpan!, "katex-mathml") || !hasClass(htmlSpan!, "katex-html")) {
    return false;
  }
  if (htmlSpan!.getAttribute("aria-hidden") !== "true") return false;
  if (!validateAndClean(mathmlSpan!) || !validateAndClean(htmlSpan!)) return false;

  const mathChildren = elementChildren(mathmlSpan!);
  if (mathChildren.length !== 1) return false;
  const math = mathChildren[0]!;
  if (namespaceOf(math) !== "mathml" || math.localName !== "math") return false;
  if (math.getAttribute("xmlns") !== MATHML_NS) return false;
  if (!walkMath(math)) return false;

  const semanticsChildren = elementChildren(math);
  if (semanticsChildren.length !== 1) return false;
  const semantics = semanticsChildren[0]!;
  if (semantics.localName !== "semantics") return false;
  const annotation = elementChildren(semantics).find((child) => child.localName === "annotation");
  if (annotation === undefined) return false;
  if (annotation.getAttribute("encoding") !== "application/x-tex") return false;
  if (elementChildren(annotation).length !== 0) return false;

  return walkHtml(htmlSpan!, true);
}

function walkMath(element: Element): boolean {
  if (namespaceOf(element) !== "mathml") return false;
  if (ownValue(TAG_NAMESPACES, element.localName) !== "mathml") return false;
  if (!validateAndClean(element)) return false;
  if (element.localName === "annotation" && elementChildren(element).length !== 0) return false;
  return elementChildren(element).every((child) => walkMath(child));
}

function walkHtml(element: Element, root = false): boolean {
  const namespace = namespaceOf(element);
  if (namespace === "svg") return walkSvg(element);
  if (namespace !== "html" || element.localName !== "span") return false;
  if (!root && hasReservedClass(element)) return false;
  if (!validateAndClean(element)) return false;
  return elementChildren(element).every((child) => {
    const childNamespace = namespaceOf(child);
    if (childNamespace === "html") return walkHtml(child);
    if (childNamespace === "svg") return walkSvg(child);
    return false;
  });
}

function walkSvg(element: Element): boolean {
  if (namespaceOf(element) !== "svg") return false;
  if (element.localName === "path" || element.localName === "line") {
    if (elementChildren(element).length !== 0) return false;
    return validateAndClean(element);
  }
  if (element.localName !== "svg") return false;
  if (element.getAttribute("xmlns") !== SVG_NS) return false;
  if (!validateAndClean(element)) return false;
  const children = elementChildren(element);
  if (children.length === 0) return false;
  return children.every((child) => (child.localName === "path" || child.localName === "line")
    && walkSvg(child));
}

function validateAndClean(element: Element): boolean {
  const namespace = namespaceOf(element);
  const tag = element.localName;
  if (namespace === undefined || ownValue(TAG_NAMESPACES, tag) !== namespace) return false;
  const allowed = ownValue(TAG_ATTRIBUTES, tag);
  if (allowed === undefined) return false;
  for (const attribute of [...element.attributes]) {
    const name = attribute.name;
    if (name === "style" && allowed.includes("style")) {
      const clean = sanitizeMathStyle(attribute.value);
      if (clean === undefined) element.removeAttribute(name);
      else if (clean !== attribute.value) element.setAttribute(name, clean);
      continue;
    }
    if (!isAllowedMathAttribute(namespace, tag, name, attribute.value)) return false;
  }
  return true;
}

function namespaceOf(element: Element): Namespace | undefined {
  switch (element.namespaceURI) {
    case HTML_NS:
      return "html";
    case MATHML_NS:
      return "mathml";
    case SVG_NS:
      return "svg";
    default:
      return undefined;
  }
}

function elementChildren(element: Element): Element[] {
  return [...element.childNodes].filter((node): node is Element => node.nodeType === 1);
}

function hasClass(element: Element, token: string): boolean {
  return (element.getAttribute("class") ?? "").split(/\s+/u).includes(token);
}

const RESERVED_CLASSES = new Set(["katex", "katex-display", "katex-mathml", "katex-html"]);

function hasReservedClass(element: Element): boolean {
  const tokens = (element.getAttribute("class") ?? "").split(/\s+/u);
  return tokens.some((token) => RESERVED_CLASSES.has(token));
}
