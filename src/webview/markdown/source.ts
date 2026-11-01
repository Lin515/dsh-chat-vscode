import type { Code, RootContent } from "mdast";
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyStrong } from "../../vendor/ui-primitives/markdown/cjkFriendlyStrong";

/**
 * 代码节点的**源代码载荷**：去掉围栏 / 容器缩进，但保留用户真正写下的
 * CRLF、tab、行尾空白、闭合围栏前的空行与未闭合围栏的尾换行。
 *
 * 提取不用“从节点位置逐行剥 4 个空格”这类手工容器规则：同一份正文的后续行
 * 仍带着 `> ` / 列表内容缩进，列表标记后的 tab 又按 4 列制表位展开，手写规则
 * 很容易在某一种合法容器上少剥一层（丢内容）或多剥一层（把 `>` 吃进代码）。
 *
 * 这里改用与解析同源的 micromark 事件流：`codeFenced` / `codeIndented` 的
 * `codeFlowValue` 与 `lineEnding` 给出每行内容的权威边界。内容字符以源码切片
 * 为准；`context.sliceSerialize(token)` 只用来补“部分消费 tab”的虚拟空格
 * （它同时会把 NUL 规范成 U+FFFD，不能整段当作源文）。因此每份文档只按需跑
 * **一次**额外解析并按下标建索引，不按代码块数重复解析全文。
 *
 * 阶段 2 的语法与 `parseGfm` 必须一致（GFM + 中文加粗）；轨迹投影仍直接消费
 * vendor `parseGfm`，这里不改变它的语义。
 */

export interface CodePayload {
  readonly text: string;
  /** `source` = 事件流的权威源码边界；`value` = 节点没有位置时的安全回落。 */
  readonly origin: "source" | "value";
}

/** 一个代码块在事件流里的提取结果；`indented` 需要节点末尾的换行。 */
export interface CodeSource {
  readonly kind: "fenced" | "indented";
  readonly text: string;
  /** 围栏代码是否真的闭合（缩进代码恒为 true，不参与判定）。 */
  readonly closed: boolean;
}

/**
 * 收集一份正文里全部代码块的内容，键为代码节点的源码起点 offset。
 *
 * 调用方只在 mdast 里确实有 `code` 节点时调用，避免无代码消息多解析一遍。
 * 返回值属于这份文档（随文档树一起丢弃），不做模块级缓存。
 */
export function collectCodeSources(source: string): ReadonlyMap<number, CodeSource> {
  const sources = new Map<number, CodeSource>();
  if (source === "") return sources;

  const events = postprocess(
    parse({ extensions: [gfm(), cjkFriendlyStrong()] })
      .document()
      .write(preprocess()(source, undefined, true)),
  );

  interface Frame {
    readonly type: "codeFenced" | "codeIndented";
    readonly start: number;
    depth: number;
    fences: number;
    /** 开围栏行的行尾不是内容；跳过它。 */
    afterOpening: boolean;
    content: string;
    lines: string[];
  }

  let frame: Frame | undefined;
  for (const [kind, token, context] of events) {
    if (frame === undefined) {
      if (kind === "enter" && (token.type === "codeFenced" || token.type === "codeIndented")) {
        frame = {
          type: token.type,
          start: token.start.offset,
          depth: 1,
          fences: 0,
          afterOpening: false,
          content: "",
          lines: [],
        };
      }
      continue;
    }

    if (kind === "enter") {
      frame.depth += 1;
      if (token.type === "codeFencedFence") {
        frame.fences += 1;
        if (frame.fences === 1) frame.afterOpening = true;
      } else if (token.type === "codeFlowValue") {
        // 内容字符以源码切片为准（`sliceSerialize` 会把 NUL 规范成 U+FFFD，
        // 直接拿它当源文会改掉用户真的写下的字符）；只有“部分消费 tab”的虚拟
        // 空格是源码里没有的，从序列化结果按长度差补回来。比较前把源码里的 NUL
        // 按同一规范映射成 U+FFFD——否则 raw 含 NUL 时 `endsWith(raw)` 永不成立，
        // 虚拟空格会丢；补回的仍是从源码切出的 raw，不是替换后的字符。
        const raw = source.slice(token.start.offset, token.end.offset);
        const serialized = context.sliceSerialize(token);
        const comparable = raw.replace(/\0/gu, "\uFFFD");
        const padding = serialized.length > comparable.length
          && serialized.endsWith(comparable)
          && /^ +$/u.test(serialized.slice(0, serialized.length - comparable.length))
          ? serialized.length - comparable.length
          : 0;
        frame.content += " ".repeat(padding) + raw;
      } else if (token.type === "lineEnding") {
        const serialized = context.sliceSerialize(token);
        const eol = /^(?:\r\n|\r|\n)/u.exec(serialized)?.[0] ?? "";
        if (frame.afterOpening) {
          frame.afterOpening = false;
        } else {
          frame.lines.push(frame.content + eol);
          frame.content = "";
        }
      }
      continue;
    }

    frame.depth -= 1;
    if (frame.depth === 0 && token.type === frame.type) {
      if (frame.content !== "") frame.lines.push(frame.content);
      let text = frame.lines.join("");
      if (frame.type === "codeFenced") {
        const closed = frame.fences > 1;
        if (closed) text = removeOneTrailingEol(text);
        sources.set(frame.start, { kind: "fenced", text, closed });
      } else {
        sources.set(frame.start, { kind: "indented", text, closed: true });
      }
      frame = undefined;
    }
  }
  return sources;
}

/**
 * 取一个 `code` 节点的载荷。
 *
 * 围栏代码的闭合行尾由事件流去掉（解析器的 value 也不含它）；缩进代码没有
 * 闭围栏，`position.end` 停在最后一个代码字符上，节点之后**恰好一条**行尾属于
 * 最后一行代码。事件流只给出内容行，这条行尾按节点位置补回，尾空行仍不并入。
 */
export function codePayload(
  node: Code,
  source: string,
  sources: ReadonlyMap<number, CodeSource>,
): CodePayload {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return { text: node.value, origin: "value" };
  const extracted = sources.get(start);
  if (extracted === undefined) return { text: node.value, origin: "value" };
  if (extracted.kind === "fenced" && extracted.closed) {
    return { text: extracted.text, origin: "source" };
  }
  return { text: extracted.text + trailingEol(source, end), origin: "source" };
}

/** 未识别节点（未来语法/未知容器）的安全源码回退：不删内容、不解释成 DOM。 */
export function sourceFallback(node: RootContent, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined && end > start) return source.slice(start, end);
  if ("value" in node && typeof node.value === "string") return node.value;
  return "";
}

function trailingEol(source: string, end: number): string {
  if (source.startsWith("\r\n", end)) return "\r\n";
  const char = source[end];
  return char === "\n" || char === "\r" ? char : "";
}

function removeOneTrailingEol(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
  return value;
}
