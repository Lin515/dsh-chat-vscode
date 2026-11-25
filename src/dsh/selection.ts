/**
 * 编辑器选区 → 行号区间。
 *
 * 「部分引用要体现出行号」是本扩展的一条用户口径（2026-09-14）：编辑器右键
 * 「添加选中代码到对话」带过来的是一段被选中的代码，芯片上要能看出引的是哪几行，
 * 发给模型的正文里也要写清范围——否则引用就退化成一个光秃秃的文件名。
 *
 * 之所以单独成模块（而不是写在 `extension.ts` 的命令回调里）：这里有一条**容易
 * 写错**的边界——选区在「下一行行首」结束时要少算一行，而它只能靠运行时观察
 * 才对得上（见 `endLine` 的注释）。纯函数、不引 `vscode`，断言见
 * `scripts/selection.test.ts`。
 */

import {
  formatFileMentionWithLines,
  isDriveQuery,
  mentionPathOf,
  normalizeMentionPath,
  relativeMentionPath,
  selectionDirectoryKey,
} from "../shared/mentions";
import { isAbsoluteWorkspacePath, isWindowsStylePath } from "../shared/workspacePath";
import type { RemoteFileAddress } from "./remoteFileAddress";

/** 选区端点的**结构**视图（`vscode.Position` 的字段子集）。 */
export interface SelectionPointLike {
  /** 0 基行号。 */
  line: number;
  /** 0 基列号。 */
  character: number;
}

/** 选区端点的**结构**视图（`vscode.Selection` 的字段子集）。 */
export interface SelectionLike {
  start: SelectionPointLike;
  end: SelectionPointLike;
}

/**
 * 选区覆盖的行号区间（**1 基、闭区间**），供界面显示与提示词正文使用。
 *
 * 边界：选区在下一行的**行首**结束时（`end.character === 0` 且跨了行），那一行
 * 一个字符都没被选中——VS Code 的「按行选中」正是这个形状（Shift+↓ 会把 end
 * 停在下一行行首）。不减掉的话 `:1-3` 会多报一行，用户照着行号回文件里找会对不上。
 *
 * 空选区（只有光标）返回 `undefined`：没有「部分」可言，不该在芯片上写 `:N-N`。
 */
export function selectionLines(selection: SelectionLike): { start: number; end: number } | undefined {
  // 空选区（只有光标）：起点与终点是同一个位置，没有「部分」可言，
  // 不该在芯片上写 `:N-N`。注意判据必须是**两个端点都相同**——跨行拖到下一行
  // 行首时 end 的**行号**会与 start+1 相等，那是真实选区（见上）。
  if (
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character
  ) {
    return undefined;
  }
  const start = selection.start.line + 1;
  const end =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line
      : selection.end.line + 1;
  return { start, end };
}

/**
 * 选区芯片的悬停预览：归一换行、去掉首尾的空行、超长截断。
 *
 * 只为「一眼认出是哪段」：芯片上有文件名与行号，模型读到的永远是文件本身，
 * 预览截断不丢信息。**保留缩进**（只丢空行，不 trim 行内容）——代码预览丢了
 * 缩进就认不出是哪段；`\r\n` 归一成 `\n`（悬停 title 的多行显示口径）。
 * 整段只有空白时给空串（芯片仍显示，行号还在）。纯函数、不引 `vscode`，
 * 断言见 `scripts/selection.test.ts`。
 */
export function selectionPreview(text: string, cap = 400): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  // 只丢「整行空白」的行（首尾的），行内的缩进与空格原样保留
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const body = lines.join("\n");
  if (body.length <= cap) return body;
  return `${body.slice(0, cap)}…`;
}

/**
 * 编辑器「当前选区」的**事实**快照（`extension.ts` 在编辑器事件那一刻算好，
 * 300ms 防抖只延迟投递；控制器按活动窗口的会话执行目录把它折成引用帧，
 * 见 `ChatController.setSelectionFacts`）。
 *
 * 这里只有「编辑器里是什么」的原始事实，不含任何按窗口折算的产物（引用 token
 * 取决于目标会话的执行目录，多根工作区下不同窗口折出的 token 可以不同）：
 * - `filePath`：本机文件绝对路径；`remoteFile`：只读副本的「连接 + 会话 + 原始绝对路径」。
 * - `lines`：选区覆盖的行号（1 基闭区间）；`undefined` = 只有光标、没有选中
 *   （`selection` 档不显示，`file` 档引用整个文件）；
 * - `preview`：选区原文预览（{@link selectionPreview} 的产物），悬停显示。
 */
export type EditorReferenceSource =
  | { filePath: string; remoteFile?: never }
  | { filePath?: never; remoteFile: RemoteFileAddress };

export type SelectionFacts = EditorReferenceSource & {
  lines?: { start: number; end: number };
  preview: string;
};

/** 只接受不需要消 `.` / `..` 或猜测分隔符就能表示的执行世界绝对路径。 */
function remoteReferencePath(path: string, directory: boolean): string | undefined {
  // `/a\b` 中的反斜杠在 POSIX 是文件名的一部分，不能交给会无条件归一的引用语法。
  if (!isAbsoluteWorkspacePath(path) || (!isWindowsStylePath(path) && path.includes("\\"))) return undefined;
  const slashed = normalizeMentionPath(path);
  const key = selectionDirectoryKey(slashed);
  if (!key || /^\/\/[?.](?:\/|$)/u.test(slashed)) return undefined;
  const value = directory ? key : slashed;
  const root = /^(?:\/\/[^/]+\/[^/]+(?:\/|$)|[A-Za-z]:\/|\/)/u.exec(value)?.[0];
  if (!root) return undefined;
  // 根目录不能作为整文件引用，也不消文件路径中的空段或尾斜杠。
  const tail = value.slice(root.length);
  if (!tail) return directory ? value : undefined;
  return tail.split("/").every(Boolean) ? value : undefined;
}

/** 不把无法相对化的 cwd 当成同一个目录；退用绝对引用也要在 cwd 变化时撤下旧芯片。 */
export function remoteSelectionCwdKey(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : (remoteReferencePath(cwd, true) ?? cwd);
}

/** 只读副本折回原始文件：优先相对路径，无法安全相对化时用可表示的绝对路径。 */
export function remoteFileReference(
  path: string,
  cwd: string | undefined,
  lines?: SelectionFacts["lines"],
): string | undefined {
  const absolute = remoteReferencePath(path, false);
  if (!absolute || mentionPathOf(absolute) !== absolute) return undefined;
  const absoluteToken = formatFileMentionWithLines(absolute, lines);
  if (!absoluteToken) return undefined;
  const dir = cwd === undefined ? undefined : remoteReferencePath(cwd, true);
  const relative = dir === undefined ? undefined : relativeMentionPath(dir, absolute);
  // POSIX 目录下合法的 `C:/x` 或 `C:` 相对拼写会被误认成 Windows 路径或盘符查询。
  if (relative === undefined || isAbsoluteWorkspacePath(relative) || isDriveQuery(relative)) return absoluteToken;
  return formatFileMentionWithLines(relative, lines);
}
