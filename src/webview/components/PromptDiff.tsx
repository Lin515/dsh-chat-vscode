/**
 * 系统提示词变更页签里的**一节差分**（官方 `TrajectoryTable.tsx` 的 `PromptDiffSection()`）。
 *
 * 行序列由 `trajectoryPromptDiff.ts` 算好（纯函数，可离线断言），这里只负责画：
 * 标题 + 一个 `<pre>`，每行按 `kind` 上色（新增 / 删除 / 上下文 / hunk 头）。
 *
 * **行级差分是这一页存在的理由**：实测提示词中位 6877 字符（`systemPromptChanges.mjs`，
 * 455 份日志），并排两段裸文本没法用——用户要的是「这 731 个字符改在哪一行」。
 */
import { promptDiffLines } from "../trajectoryPromptDiff";
import type { PromptDiffLine } from "../trajectoryPromptDiff";

/** 行的类名：官方按 `promptDiffLine${kind}` 取（kind 是 meta / context / added / removed）。 */
function lineClass(kind: PromptDiffLine["kind"]): string {
  return `trajectory-prompt-diff-line is-${kind}`;
}

export function PromptDiffSection({
  title,
  before,
  after,
}: {
  title: string;
  before: string;
  after: string;
}) {
  const lines = promptDiffLines(before, after);
  // 两段一模一样时官方也整节不渲染（`if (lines.length === 0) return null`）：
  // 挂一个空标题在那里只会让人以为「这里本来有内容，出问题了」
  if (lines.length === 0) return null;
  return (
    <section className="trajectory-prompt-diff-section">
      <h3 className="trajectory-prompt-diff-title">{title}</h3>
      <pre className="trajectory-prompt-diff">
        {lines.map((line, index) => (
          <span className={lineClass(line.kind)} key={index}>
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </section>
  );
}
