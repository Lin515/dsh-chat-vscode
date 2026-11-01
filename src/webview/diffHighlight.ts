/**
 * diff 行序列的**两侧源码重建**：旧侧 = context + del，新侧 = context + add，
 * 各自按 hunk 内的行序用 `\n` 连接。只重建这一段的连续片段，不把不同 hunk /
 * 不连续片段拼成整文件——缺上下文时宁可让该片段独立 tokenize，也不假造跨片段状态。
 *
 * 纯函数，不碰 DOM / React；行切分由 `splitSpansByLine` 完成。
 */
import type { DiffLineView } from "../shared/chat";

export interface DiffLineSides {
  /** 旧侧源码（context + del），行间 `\n`；没有旧侧行时为空串。 */
  oldText: string;
  /** 新侧源码（context + add），行间 `\n`；没有新侧行时为空串。 */
  newText: string;
  /** 原 hunk 每一行在旧侧文本中的行下标；不属于旧侧时为 undefined。 */
  oldLine: (number | undefined)[];
  /** 原 hunk 每一行在新侧文本中的行下标；不属于新侧时为 undefined。 */
  newLine: (number | undefined)[];
}

/** context 两侧都有，del 只在旧侧，add 只在新侧。 */
export function diffLineSides(lines: readonly DiffLineView[]): DiffLineSides {
  const oldTexts: string[] = [];
  const newTexts: string[] = [];
  const oldLine: (number | undefined)[] = new Array(lines.length).fill(undefined);
  const newLine: (number | undefined)[] = new Array(lines.length).fill(undefined);
  lines.forEach((line, index) => {
    if (line.kind !== "add") {
      oldLine[index] = oldTexts.length;
      oldTexts.push(line.text);
    }
    if (line.kind !== "del") {
      newLine[index] = newTexts.length;
      newTexts.push(line.text);
    }
  });
  return { oldText: oldTexts.join("\n"), newText: newTexts.join("\n"), oldLine, newLine };
}
