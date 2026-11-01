import type {
  Definition,
  FootnoteDefinition,
  FootnoteReference,
  Root,
  RootContent,
} from "mdast";
import { parseGfm } from "../../vendor/ui-primitives/markdown/parse";
import { createSettledSyntax, parseSettledRoot } from "./math";
import { collectCodeSources, type CodeSource } from "./source";
import { fixWindowsDestinations } from "./windowsDestinations";
import type { MarkdownPhase } from "./types";

export {
  mathFenceSource,
  mathSourceOf,
  parseSettledRoot,
  type MathFenceSource,
  type MathSource,
} from "./math";

/**
 * 正文的解析适配：官方 GFM（+ 中文加粗 + 本地图片语法恢复）之后，只补本扩展的
 * Windows 链接目标修复，并收集文档级参考定义 / 脚注定义。
 *
 * 两个语法臂按 `phase` 选择：
 *
 * - `streaming`：vendor `parseGfm`，不含数学，生成中的 TeX 不会闪成公式；
 * - `settled`（缺省）：本地 [parseSettledRoot] 使用与 vendor `parseGfmWithMath`
 *   相同的扩展集合，并补上保守金额否决与围栏 / 源码事实（见 [math.ts](<math.ts>)）。
 *
 * 阶段 4 已接线：正文组件调用 `parseMarkdown(text, phase)`，settled 的数学节点
 * 进入 `MathView`；[parseGfmMarkdown] 只保留给显式要求普通 GFM 的调用方 / 测试。
 * 轨迹的纯文本投影继续直接消费 vendor `parseGfm`，语义不变。
 *
 * mdast 类型只在本适配层与渲染层之间流转；业务的 `Markdown` 接口只接收文本。
 */
export interface MarkdownDocument {
  readonly source: string;
  readonly root: Root;
  /** 参考链接 / 图片定义：identifier（大写）→ 首次定义。 */
  readonly definitions: ReadonlyMap<string, Definition>;
  /** 脚注定义：identifier（大写）→ 末次定义（沿用旧界面的覆盖口径）。 */
  readonly footnotes: ReadonlyMap<string, FootnoteDefinition>;
  /** 代码块源码载荷，键为节点起点 offset；只有文中有代码时才建立索引。 */
  readonly codeSources: ReadonlyMap<number, CodeSource>;
}

/** 解析一份正文。脚注与参考定义按整篇文档收集，不跨文档复用状态。 */
export function parseMarkdown(source: string, phase: MarkdownPhase = "settled"): MarkdownDocument {
  const text = source ?? "";
  return finalizeDocument(text, phase === "streaming" ? parseGfm(text) : parseSettledRoot(text), phase);
}

/**
 * 显式只解析普通 GFM 的入口：即使消息已经 settled 也不产生数学节点。
 * 生产正文已走 `parseMarkdown(text, phase)`；本函数仅供只接受普通 GFM 的调用方 / 测试。
 */
export function parseGfmMarkdown(source: string): MarkdownDocument {
  return parseMarkdown(source, "streaming");
}

function finalizeDocument(text: string, root: Root, phase: MarkdownPhase): MarkdownDocument {
  fixWindowsDestinations(root, text);
  const definitions = new Map<string, Definition>();
  const footnotes = new Map<string, FootnoteDefinition>();
  let hasCode = false;
  collect(root.children, definitions, footnotes, () => {
    hasCode = true;
  });
  restoreMissingFootnoteReferences(root, text, footnotes);
  // 有代码才跑那次同源事件流；一份文档至多一次，不按代码块重复解析全文。
  // 必须与当前 phase 的 mdast 语法一致：settled 公式中的围栏不是代码，不能用
  // streaming 的 GFM 边界去索引后续代码，否则会回落 node.value 丢失尾换行 / NUL。
  const codeSources = hasCode
    ? collectCodeSources(text, phase === "settled" ? createSettledSyntax(text) : undefined)
    : new Map<number, CodeSource>();
  return { source: text, root, definitions, footnotes, codeSources };
}

function collect(
  nodes: readonly RootContent[],
  definitions: Map<string, Definition>,
  footnotes: Map<string, FootnoteDefinition>,
  markCode: () => void,
): void {
  for (const node of nodes) {
    if (node.type === "code") {
      markCode();
    } else if (node.type === "definition") {
      const identifier = node.identifier.toUpperCase();
      if (!definitions.has(identifier)) definitions.set(identifier, node);
    } else if (node.type === "footnoteDefinition") {
      // 脚注重复定义沿用旧界面口径：后者覆盖（参考链接定义仍按 CommonMark 首次胜出）。
      footnotes.set(node.identifier.toUpperCase(), node);
    }
    if ("children" in node) collect(node.children, definitions, footnotes, markCode);
  }
}

/**
 * 补回**没有定义**的脚注引用。
 *
 * vendor 的 GFM 脚注只在存在同名定义时产出 `footnoteReference`；没有定义时
 * 整段留在文本里。旧界面把这种引用照样编号成上标（只是不进脚注区），编号还会
 * 参与后续脚注的序号。这里在解析结果上补节点，而不是全文正则改源码：只处理
 * 文本节点（代码 / 原始 HTML 不是文本节点，天然不受影响），并且按原文位置避开
 * `\[^x]` 这种转义写法。
 *
 * 只在文本节点是单一文本值时补；找不到对应原文位置说明文本被实体等改写过，
 * 保守放弃（宁可保持字面，也不改错位置）。
 */
function restoreMissingFootnoteReferences(
  root: Root,
  source: string,
  footnotes: ReadonlyMap<string, FootnoteDefinition>,
): void {
  visit(root, source, footnotes);
}

function visit(node: Root | RootContent, source: string, footnotes: ReadonlyMap<string, FootnoteDefinition>): void {
  if (!("children" in node)) return;
  const children = node.children as RootContent[];
  let changed = false;
  const next: RootContent[] = [];
  for (const child of children) {
    if (child.type === "text") {
      const split = splitMissingReferences(child, source, footnotes);
      if (split !== undefined) {
        next.push(...split);
        changed = true;
        continue;
      }
    } else {
      visit(child, source, footnotes);
    }
    next.push(child);
  }
  if (changed) node.children = next as typeof node.children;
}

function splitMissingReferences(
  node: Extract<RootContent, { type: "text" }>,
  source: string,
  footnotes: ReadonlyMap<string, FootnoteDefinition>,
): RootContent[] | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return undefined;

  const value = node.value;
  const parts: RootContent[] = [];
  let search = start;
  let copied = 0;
  let found = false;
  let cursor = 0;
  // 单向扫描：`[^` 失败时直接跳到已扫过的位置，不从每个内层 `[^` 重新匹配，
  // 避免 `"[^".repeat(n)` 这类未闭合输入退化成二次时间。
  while (cursor < value.length) {
    const open = value.indexOf("[^", cursor);
    if (open < 0) break;
    let close = open + 2;
    while (close < value.length && value[close] !== "]" && !isReferenceWhitespace(value[close]!)) {
      close += 1;
    }
    if (close >= value.length) break;
    if (value[close] !== "]") {
      cursor = close;
      continue;
    }
    const identifier = value.slice(open + 2, close);
    if (identifier === "" || footnotes.has(identifier.toUpperCase())) {
      cursor = close + 1;
      continue;
    }
    const raw = value.slice(open, close + 1);
    const at = source.indexOf(raw, search);
    if (at < 0 || at + raw.length > end) return undefined;
    search = at + raw.length;
    let backslashes = 0;
    for (let index = at - 1; index >= start && source[index] === "\\"; index -= 1) backslashes += 1;
    cursor = close + 1;
    if (backslashes % 2 === 1) continue;
    if (open > copied) parts.push(textNode(value.slice(copied, open)));
    const reference: FootnoteReference = { type: "footnoteReference", identifier };
    parts.push(reference);
    copied = close + 1;
    found = true;
  }
  if (!found) return undefined;
  if (copied < value.length) parts.push(textNode(value.slice(copied)));
  return parts;
}

function isReferenceWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function textNode(value: string): RootContent {
  return { type: "text", value };
}
