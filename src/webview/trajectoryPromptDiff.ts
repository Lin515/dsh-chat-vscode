/**
 * 系统提示词与工具目录的**行级差分**（官方 `TrajectoryTable.tsx` 的 `promptDiffLines()`，
 * 逐字对齐同一套：`diff` 包的 `structuredPatch`、`context: 3`、hunk 头 + 逐行标记）。
 *
 * 单独一个纯模块的理由与 `trajectoryDisplay.ts` 一样：这是**能离线断言**的一层。
 * 差分的边界（哪些行走 `+` / `-`、hunk 头怎么算、多段之间怎么断）在组件里只能靠手点，
 * 而它恰恰是最容易「看起来对了」的一类逻辑——`scripts/trajectoryPromptDiff.test.ts`
 * 逐条钉住。
 *
 * 与官方唯一的结构差异：官方在同一个文件里就地声明 `PromptDiffLine`，这里导出类型
 * 给组件用（**形状一致**，kind 走 `meta` / `context` / `added` / `removed` 四个字面量）。
 */
import { structuredPatch } from "diff";

/** 差分里的一行：hunk 头（`meta`）、上下文、新增、删除。 */
export interface PromptDiffLine {
  kind: "meta" | "context" | "added" | "removed";
  text: string;
}

/**
 * 两段文本 → 行级差分（官方 `promptDiffLines()`）。
 *
 * 三处细节逐字照抄官方，都是有理由的：
 * 1. **`structuredPatch('', '', before, after, undefined, undefined, { context: 3 })`**
 *    ——空文件名与空时间戳，只取 hunk 结构；上下文 3 行（与 git 默认一致）。
 * 2. **hunk 头自己拼**（`@@ -a,b +c,d @@`），不用 `patch` 里现成的字符串：官方要的是
 *    渲染进去的一行文本，而不是再解析一次。
 * 3. **以 `\` 开头的行丢掉**——那是 `diff` 标「文件末尾没有换行」的记号（`\ No newline
 *    at end of file`），对提示词这种本来就是整段文本的输入没有意义，画出来只是一行噪声。
 *
 * @param before - 替换前的文本。
 * @param after - 替换后的文本。
 * @returns 按顺序排列的行；两段相同（或都为空）时是空数组，调用方据此**不渲染这一节**。
 */
export function promptDiffLines(before: string, after: string): readonly PromptDiffLine[] {
  const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3 });
  return patch.hunks.flatMap((hunk, hunkIndex) => [
    // 多段之间空一行：不然两段 hunk 的 `@@` 头会看起来属于同一段
    ...(hunkIndex === 0 ? [] : [{ kind: "meta" as const, text: "" }]),
    {
      kind: "meta" as const,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    },
    ...hunk.lines.flatMap((line): PromptDiffLine[] => {
      if (line.startsWith("\\")) return [];
      if (line.startsWith("+")) return [{ kind: "added", text: line }];
      if (line.startsWith("-")) return [{ kind: "removed", text: line }];
      return [{ kind: "context", text: line }];
    }),
  ]);
}

/**
 * 两段 JSON 值 → 行级差分（工具目录那一节用）。
 *
 * 官方对工具目录用的是**序列化后的文本**（`JSON.stringify(tools, null, 2)` 各取一份再比），
 * 不是结构化比较——这样「同一个工具的描述改了」「新增了一个工具」都会落到具体行上，
 * 而结构化比较只能告诉你「这个键变了」。
 *
 * @param before - 替换前的值（通常是 `previousPromptDetail.tools`）。
 * @param after - 替换后的值。
 * @returns 与 {@link promptDiffLines} 同样的行序列。
 */
export function promptDiffJsonLines(before: unknown, after: unknown): readonly PromptDiffLine[] {
  return promptDiffLines(JSON.stringify(before, null, 2), JSON.stringify(after, null, 2));
}
