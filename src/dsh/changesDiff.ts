/**
 * 一轮改动的**逐文件对比**（`/api/changes.diff`）与「怎么把它铺成两段文本」。
 *
 * 数据来源与官方 web 端同一条认证路由：`workspace/changes` 只宣告轮号，Host 在
 * Session 存活期间按 `(sessionId, seq, index)` 现算某个文件的 turn-start / turn-end
 * 对比。它**不依赖 git 的工作区改动**，所以提交之后仍然看得到——这正是它相对
 * `git.openChange` 的唯一价值。
 *
 * 路由给的是 **hunk**（每段带 3 行上下文的 `+` / `-` / 空格行），不是两整份文件。
 * 要开 VS Code 的对比窗口，必须自己拼出左右两侧的文本：
 *
 * - 整份新建 / 整份删除 / 粗粒度（`coarse`）时，hunk 本身就覆盖了整侧，直接拼；
 * - 两边都存在时，先试着用**磁盘上的当前文件**当右侧、按 hunk 位置回填左侧
 *   （只接受每个 hunk 的 new 侧在当前文件里逐行对得上的情况——对不上说明文件在
 *   本轮之后又变过，回填出来的「未改动区」就不再是本轮结束时的样子）；
 * - 回填不成立就退化成**片段**：只铺 hunk 本身，未展示的区间用一行省略标记代替。
 *   宁可承认「这里还有没展示的行」，也不把另一版的文件内容冒充成本轮的上下文。
 *
 * 纯函数、不引 `vscode`：断言见 `scripts/changesDiff.test.ts`。
 */
import { toLines } from "../shared/diff";

/** 一段 hunk：行首保留 `+` / `-` / 空格标记，与 Host 的 `WorkspaceDiffHunk` 同形。 */
export interface AgentDiffHunk {
  /** 该段在 turn-start 侧的第一行（1 基；该侧没有行时为 1）。 */
  oldStart: number;
  /** 该段在 turn-start 侧的行数。 */
  oldLines: number;
  /** 该段在 turn-end 侧的第一行（1 基；该侧没有行时为 1）。 */
  newStart: number;
  /** 该段在 turn-end 侧的行数。 */
  newLines: number;
  /** 段体，逐行以 `+` / `-` / 空格开头。 */
  lines: string[];
}

/** 一个文件的对比：文本 hunk、二进制、过大（后两者没有行可显示）。 */
export type AgentDiff =
  | {
      kind: "text";
      path: string;
      display: string;
      /** 文件在 turn-start 时是否存在。 */
      before: boolean;
      /** 文件在 turn-end 时是否存在。 */
      after: boolean;
      /** 按文件顺序的 hunk；两侧行相同为空。 */
      hunks: AgentDiffHunk[];
      /** 行比较超时，整份文件按「全删 + 全增」给出。 */
      coarse: boolean;
    }
  | { kind: "binary"; path: string; display: string }
  | { kind: "oversized"; path: string; display: string };

/** 铺给对比窗口的两段文本，以及它是否只是片段。 */
export interface AgentDiffTexts {
  before: string;
  after: string;
  /**
   * `true` = 只铺了 hunk 片段（中间夹省略标记），不是整份文件。
   *
   * 标题据此说明「片段」：用户不会误以为没展示的内容在本轮里也没动过。
   */
  excerpt: boolean;
}

/** 数组的每一项都是一个对象（不是 null / 数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非负安全整数。 */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** 一段 hunk 是否合规：四个坐标非负、段体逐行带三种标记之一。 */
function isHunk(value: unknown): value is AgentDiffHunk {
  if (!isRecord(value)) return false;
  const { oldStart, oldLines, newStart, newLines, lines } = value;
  return (
    isCount(oldStart) &&
    isCount(oldLines) &&
    isCount(newStart) &&
    isCount(newLines) &&
    Array.isArray(lines) &&
    lines.every((line) => typeof line === "string" && /^[+ -]/u.test(line))
  );
}

/**
 * 把路由回来的 JSON 收窄成 {@link AgentDiff}；形状不对返回 `null`。
 *
 * 服务端给的值一律不可信：整份丢弃比画一个半截对比安全（半截对比会让人以为
 * 自己看到了全貌）。`binary` / `oversized` 只接受这两个字面量，带别的值说明
 * 对方不是这个协议的实现。
 */
export function decodeChangesDiff(raw: unknown): AgentDiff | null {
  if (!isRecord(raw)) return null;
  const { kind, path, display } = raw;
  if (typeof path !== "string" || path.length === 0) return null;
  if (typeof display !== "string" || display.length === 0) return null;
  if (kind === "binary" || kind === "oversized") return { kind, path, display };
  if (kind !== "text") return null;
  const { before, after, hunks, coarse } = raw;
  if (typeof before !== "boolean" || typeof after !== "boolean") return null;
  if (typeof coarse !== "boolean") return null;
  if (!Array.isArray(hunks) || !hunks.every(isHunk)) return null;
  return {
    kind: "text",
    path,
    display,
    before,
    after,
    hunks: hunks as AgentDiffHunk[],
    coarse,
  };
}

/** 一段 hunk 的两侧内容（去掉行首标记；`\r` 归一，Windows 文件也能对齐）。 */
function hunkSides(hunk: AgentDiffHunk): { old: string[]; next: string[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const raw of hunk.lines) {
    const text = raw.slice(1).replace(/\r$/u, "");
    if (raw.startsWith("+")) newLines.push(text);
    else if (raw.startsWith("-")) oldLines.push(text);
    else {
      oldLines.push(text);
      newLines.push(text);
    }
  }
  return { old: oldLines, next: newLines };
}

/** 一段行序列 → 文本：空序列 = 空串，其余每行都以换行结尾。 */
function toText(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * 用「当前文件 + hunk 的 new 侧」回填 turn-start 全文。
 *
 * 从后往前替换：hunk 的坐标是**新文件**里的位置，先动后面的行不会让前面的
 * `newStart` 失效。任一段的 new 侧在当前文件里对不上（行数不符或内容不同）就
 * 返回 `undefined`——那时当前文件已经不是本轮的 turn-end，不能拿它当基准。
 */
function rebuildBefore(
  current: readonly string[],
  hunks: readonly AgentDiffHunk[],
  sides: readonly { old: string[]; next: string[] }[],
): string[] | undefined {
  const rebuilt = [...current];
  for (let index = hunks.length - 1; index >= 0; index--) {
    const hunk = hunks[index]!;
    const side = sides[index]!;
    // Host 的 newLines 必须与段体自洽；不自洽说明这份载荷坏了，别按它改文本
    if (side.next.length !== hunk.newLines) return undefined;
    const start = hunk.newStart - 1;
    if (!Number.isSafeInteger(start) || start < 0) return undefined;
    if (start + hunk.newLines > rebuilt.length) return undefined;
    for (let offset = 0; offset < hunk.newLines; offset++) {
      if (rebuilt[start + offset] !== side.next[offset]) return undefined;
    }
    rebuilt.splice(start, hunk.newLines, ...side.old);
  }
  return rebuilt;
}

/**
 * 只铺 hunk 的片段：两段 hunk 之间的未展示区间用同一行省略标记占位。
 *
 * 标记在两侧是同一行，所以对比窗口把它当上下文，而不是一处假改动。省略行数取
 * 两侧缺口里较大的那个（正常情况下两边相等；坐标漂移时宁可多报，也不假装没有
 * 漏掉内容）。
 */
function excerptTexts(
  hunks: readonly AgentDiffHunk[],
  sides: readonly { old: string[]; next: string[] }[],
  omitted: (lines: number) => string,
): AgentDiffTexts {
  const before: string[] = [];
  const after: string[] = [];
  let oldCursor = 1;
  let newCursor = 1;
  for (const [index, hunk] of hunks.entries()) {
    const side = sides[index]!;
    const gap = Math.max(hunk.oldStart - oldCursor, hunk.newStart - newCursor, 0);
    if (gap > 0) {
      const marker = omitted(gap);
      before.push(marker);
      after.push(marker);
    }
    before.push(...side.old);
    after.push(...side.next);
    oldCursor = hunk.oldStart + hunk.oldLines;
    newCursor = hunk.newStart + hunk.newLines;
  }
  return { before: toText(before), after: toText(after), excerpt: true };
}

/**
 * 把一份文本对比铺成对比窗口的两段文本。
 *
 * 优先级：整份新建 / 整份删除 / `coarse` 直接由 hunk 拼出整侧 → 当前文件能对上
 * 每个 hunk 时回填整份 → 否则退化成片段。`currentText` 是**磁盘上现在**的内容；
 * 读不到（文件已删除、读取失败）就按没有处理，片段这条兜底仍然可用。
 *
 * @param diff 已通过形状校验的文本对比。
 * @param currentText 磁盘上的当前文件内容；读不到时传 undefined。
 * @param omitted 片段之间「省略了 N 行」的本地化文案。
 */
export function buildAgentDiffTexts(
  diff: Extract<AgentDiff, { kind: "text" }>,
  currentText: string | undefined,
  omitted: (lines: number) => string,
): AgentDiffTexts {
  const sides = diff.hunks.map(hunkSides);
  if (!diff.before && !diff.after) return { before: "", after: "", excerpt: false };
  // 整份新建：hunk 的 new 侧就是 turn-end 的全部内容（没有旧侧可言）
  if (!diff.before) {
    return {
      before: "",
      after: toText(sides.flatMap((side) => side.next)),
      excerpt: false,
    };
  }
  // 整份删除：hunk 的 old 侧就是 turn-start 的全部内容
  if (!diff.after) {
    return {
      before: toText(sides.flatMap((side) => side.old)),
      after: "",
      excerpt: false,
    };
  }
  // 超时降级：Host 给的是「全删 + 全增」，hunk 已覆盖两侧全文
  if (diff.coarse) {
    return {
      before: toText(sides.flatMap((side) => side.old)),
      after: toText(sides.flatMap((side) => side.next)),
      excerpt: false,
    };
  }
  if (diff.hunks.length === 0) {
    // 两侧行完全相同：给一份「无差异」的对比，而不是退回 git（那会显示另一件事）
    const same = currentText === undefined ? "" : toText(toLines(currentText));
    return { before: same, after: same, excerpt: false };
  }
  if (currentText !== undefined) {
    const current = toLines(currentText);
    const before = rebuildBefore(current, diff.hunks, sides);
    if (before !== undefined) {
      return { before: toText(before), after: toText(current), excerpt: false };
    }
  }
  return excerptTexts(diff.hunks, sides, omitted);
}
