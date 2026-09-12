/**
 * `read` 工具的行号区间：判断这次读的是整个文件还是只读了一段。
 *
 * 为什么要单独做：读取节点的标题只显示文件名，而「读了一部分」和「读了全文」
 * 在界面上完全一样——用户没法分辨模型是看到了整个文件，还是只扫了 20 行。
 * 把行号缀在文件名后（`…/controller.ts:3201-3220`）就能一眼看出来。
 *
 * 数据来源有两条，优先级从高到低：
 * 1. `tool/result.meta`——dsh-tool-fs 的 `presentationMeta`，带
 *    `{path, offset, lines:[{number,text}], totalLines}`，是**权威值**；
 * 2. 模型侧正文——文件类信封里的 `N: ` 行号 + 三种尾注之一：
 *    - `(Showing lines A-B of N. Use offset=… to continue.)`  有区间也有总数
 *    - `(Output capped. Showing lines A-B. Use offset=… )`     只有区间（按字节截断）
 *    - `(End of file - total N lines)`                        只有总数
 *
 * meta 缺失时才回退到正文：正文尾注不含起始行时（`End of file`）靠内容行号补齐。
 *
 * 与 vscode 无关，便于离线测试。
 */

export interface ReadRange {
  /** 本次读到的首行（1-based）。 */
  start: number;
  /** 本次读到的末行（1-based）。 */
  end: number;
  /** 文件总行数（拿得到时）。 */
  total?: number;
  /** 是否只读了文件的一部分（全文读取为 false）。 */
  partial: boolean;
}

/** 判断区间是否覆盖整个文件。总行数未知时，只能靠「是否从第 1 行开始」保守判断。 */
function computePartial(start: number, end: number, total: number | undefined): boolean {
  if (total === undefined) return start > 1;
  return start > 1 || end < total;
}

/** 从 `tool/result.meta` 解析（权威路径）。形状不对一律返回 undefined。 */
export function readRangeFromMeta(meta: unknown): ReadRange | undefined {
  const value = meta as
    | { offset?: unknown; totalLines?: unknown; lines?: unknown }
    | undefined;
  if (!value || typeof value !== "object") return undefined;
  const total = typeof value.totalLines === "number" && Number.isInteger(value.totalLines) ? value.totalLines : undefined;
  if (total === undefined || total < 0) return undefined;
  if (!Array.isArray(value.lines) || value.lines.length === 0) return undefined;

  const numbers = value.lines
    .map((line) => (line as { number?: unknown } | null)?.number)
    .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
  if (numbers.length === 0) return undefined;

  const start = numbers[0];
  const end = numbers[numbers.length - 1];
  if (end < start) return undefined;
  return { start, end, total, partial: computePartial(start, end, total) };
}

/** 正文里的 `N: ` 行号取值（文件类信封的内容就是这种编号行）。 */
function numberedLines(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/^(\d+): /gm)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) out.push(value);
  }
  return out;
}

/**
 * 从模型侧正文解析（meta 缺失时的回退）。
 *
 * 三种尾注都要认，且必须结合内容行号——`(End of file - total N lines)` 只说总行数，
 * 起始行只能从第一行编号得到（`offset=101` 读到结尾时也是这个尾注）。
 */
export function readRangeFromOutput(output: string): ReadRange | undefined {
  if (!output) return undefined;
  const numbers = numberedLines(output);
  const first = numbers[0];
  const last = numbers[numbers.length - 1];

  // 变体 2：Showing lines A-B of N
  const showing = /\(Showing lines (\d+)-(\d+) of (\d+)\./.exec(output);
  if (showing) {
    const start = Number(showing[1]);
    const end = Number(showing[2]);
    const total = Number(showing[3]);
    return { start, end, total, partial: computePartial(start, end, total) };
  }

  // 变体 3：Output capped（按字节截断，没有总数）
  const capped = /\(Output capped\. Showing lines (\d+)-(\d+)\./.exec(output);
  if (capped) {
    const start = Number(capped[1]);
    const end = Number(capped[2]);
    return { start, end, partial: true };
  }

  // 变体 1：End of file - total N lines（可能是整篇，也可能是 offset=101 读到结尾）
  const eof = /\(End of file - total (\d+) lines\)/.exec(output);
  if (eof) {
    const total = Number(eof[1]);
    if (total === 0) return undefined; // 空文件：没有可标注的区间
    const start = first ?? 1;
    const end = last ?? total;
    return { start, end, total, partial: computePartial(start, end, total) };
  }

  return undefined;
}

/**
 * 把行号缀到文件名末尾（供测试与文本场景复用）。
 *
 * 只读一段时给 `path:start-end`；整篇读取返回 undefined，调用方保留原始文件名。
 * `total` 不并进字符串：单行标题空间紧张，总行数对「这次读了哪一段」没有帮助。
 *
 * 注意界面**没有**用这个函数拼字符串，而是把区间单独下发、由 `.row-detail-suffix`
 * 渲染成不可压缩的一段——拼进 `detail` 里会跟着路径一起被省略（`detail` 是按
 * 「目录可裁、文件名不裁」的规则省略的，区间缀在字符串末尾就守不住）。
 * 界面上它紧跟在文件名之后（在 `.row-detail` 内部，见 primitives.tsx 的 Row）。
 * 这里保留给「需要一行纯文本」的场景（例如日志、测试断言）。
 */
export function formatReadDetail(displayPath: string, range: ReadRange): string | undefined {
  if (!range.partial) return undefined;
  return `${displayPath}:${range.start}-${range.end}`;
}
