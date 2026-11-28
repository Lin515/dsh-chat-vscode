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
  formatFileMention,
  formatFileMentionWithLines,
  mentionPathOf,
  normalizeMentionPath,
  relativeMentionPath,
  selectionDirectoryKey,
} from "../shared/mentions";
import { isAbsoluteWorkspacePath, isDeviceNamespacePath, isWindowsStylePath, upperDriveLetter } from "../shared/workspacePath";
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
function referenceablePath(path: string, directory: boolean): string | undefined {
  // `/a\b` 中的反斜杠在 POSIX 是文件名的一部分，不能交给会无条件归一的引用语法。
  if (!isAbsoluteWorkspacePath(path) || (!isWindowsStylePath(path) && path.includes("\\"))) return undefined;
  if (isDeviceNamespacePath(path)) return undefined;
  // 盘符统一大写只改开头一个字母；目录段 / 文件名的大小写是路径身份的一部分，原样保留。
  const slashed = upperDriveLetter(normalizeMentionPath(path));
  const key = selectionDirectoryKey(slashed);
  if (!key) return undefined;
  const value = directory ? key : slashed;
  const root = /^(?:\/\/[^/]+\/[^/]+(?:\/|$)|[A-Za-z]:\/|\/)/u.exec(value)?.[0];
  if (!root) return undefined;
  // 根目录不能作为整文件引用，也不消文件路径中的空段或尾斜杠。
  const tail = value.slice(root.length);
  if (!tail) return directory ? value : undefined;
  return tail.split("/").every(Boolean) ? value : undefined;
}

/**
 * 只读副本执行目录的**仅比较键**：无法安全折算成引用语法时退回原样 cwd。
 *
 * 它只回答「比较两次读到的 cwd 是不是同一个拼写」，绝不拿去拼相对引用——那是
 * `selectionDirectoryKey`（可折算键）的职责。保留这种 opaque 回退，是为了让
 * 「目录无法表示」的会话在 cwd 真的变化时仍能撤下旧芯片，而不是因为键为空就
 * 一直显示一个可能指向别的目录的绝对引用。
 */
export function remoteSelectionCwdKey(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : (referenceablePath(cwd, true) ?? cwd);
}

/**
 * 本机选区的引用：**只允许安全的目录内相对路径**（任务口径：本机不做绝对回退，
 * 也不把目录外文件自动带上）。
 *
 * 校验统一走 `relativeMentionPath`：路径家族（POSIX 字面反斜杠）、点段、目录边界、
 * 设备命名空间、盘符样式与行号后缀歧义都在那一处判断；这里只把折出的相对路径
 * 交给 token 生成。
 */
export function localFileReference(
  path: string,
  cwd: string | undefined,
  lines?: SelectionFacts["lines"],
): string | undefined {
  if (cwd === undefined) return undefined;
  const relative = relativeMentionPath(cwd, path);
  if (relative === undefined) return undefined;
  return formatFileMentionWithLines(relative, lines);
}

/**
 * 手动添加的**本机文件**引用：优先相对目标会话执行目录，目录之外退可表示的绝对路径。
 *
 * 与 {@link localFileReference}（自动附带）的分别只在「折不出来怎么办」：自动附带
 * 是背景行为，目录之外就静默不附带；手动命令是用户显式动作，选中的文件可能就在
 * 多根工作区的另一个根下，不能什么都不做（那会让快捷键看起来失灵）。绝对路径与
 * 只读副本的回退同口径——同一个执行世界，`@` 语法两种拼写模型都读得到；盘符统一
 * 大写（VS Code 的 `Uri.fsPath` 给小写盘符），与工作目录显示同一口径。
 *
 * 返回 `undefined` 只表示**连绝对拼写也无法无歧义表示**（相对拼写、设备命名空间、
 * 控制字符/引号、行号后缀歧义等），调用方按「跳过插入」处理。
 */
export function manualFileReference(
  path: string,
  cwd: string | undefined,
  lines?: SelectionFacts["lines"],
): string | undefined {
  return localFileReference(path, cwd, lines) ?? absoluteFileReference(path, lines);
}

/** 执行世界绝对路径的 `@` 引用（本机目录外回退与只读副本共用）。 */
export function absoluteFileReference(
  path: string,
  lines?: SelectionFacts["lines"],
): string | undefined {
  const absolute = referenceablePath(path, false);
  if (!absolute || mentionPathOf(absolute) !== absolute) return undefined;
  return formatFileMentionWithLines(absolute, lines);
}

/**
 * 手动添加的**本机目录**引用：与 {@link manualFileReference} 同一条链，只多结尾斜杠。
 *
 * 目录拼写的相对折算要先把结尾分隔符去掉：`relativeMentionPath` 只认真实的目录段，
 * 尾斜杠会被当成空段而拒绝。POSIX 上反斜杠是文件名的一部分，所以只有 Windows 形态
 * 才把 `\\` 归成 `/`；绝对回退交给 `referenceablePath` 校验。
 */
export function manualDirectoryReference(path: string, cwd: string | undefined): string | undefined {
  const trimmed = isWindowsStylePath(path)
    ? normalizeMentionPath(path).replace(/\/+$/u, "")
    : path.replace(/\/+$/u, "");
  const relative = cwd === undefined || trimmed === "" ? undefined : relativeMentionPath(cwd, trimmed);
  const value = relative ?? referenceablePath(path, true);
  return value === undefined ? undefined : formatFileMention(value, "directory");
}

/** 只读副本折回原始文件：优先相对路径，无法安全相对化时用可表示的绝对路径。 */
export function remoteFileReference(
  path: string,
  cwd: string | undefined,
  lines?: SelectionFacts["lines"],
): string | undefined {
  const absolute = referenceablePath(path, false);
  if (!absolute || mentionPathOf(absolute) !== absolute) return undefined;
  const absoluteToken = formatFileMentionWithLines(absolute, lines);
  if (!absoluteToken) return undefined;
  const dir = cwd === undefined ? undefined : referenceablePath(cwd, true);
  const relative = dir === undefined ? undefined : relativeMentionPath(dir, absolute);
  // 相对拼写不安全（POSIX 字面反斜杠、盘符样式、行号后缀……）时用绝对路径；
  // 这些语法判据统一在 `relativeMentionPath` 里，两边不再各写一份。
  if (relative === undefined) return absoluteToken;
  return formatFileMentionWithLines(relative, lines);
}
