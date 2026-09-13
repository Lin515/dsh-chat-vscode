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
