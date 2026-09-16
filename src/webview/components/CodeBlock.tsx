/**
 * 代码块卡片（Continue 的观感：`--vscode-editor-background` 作底、outline 而非
 * border，头部 12px，右侧一组悬停才出现的图标按钮）。
 *
 * 单独一个文件而不是留在 `Markdown.tsx` 里：正文（markdown 渲染）与工具卡
 * （`run_code` 的代码正文，官方 `formatToolBody` 的 code 分支）都要用它，而
 * `Markdown.tsx` 那条链会拉起 DOMPurify——工具行被无头环境渲染时（例如
 * `scripts/questionRender.test.ts`）不该被它牵连。
 */
import { useMemo, useState } from "react";
import { post } from "../bridge";
import { IconChevronDown, IconChevronRight, IconCopy, IconPencil } from "../icons";
import { useTexts } from "../texts";

export function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const texts = useTexts();
  const lines = useMemo(() => code.split("\n"), [code]);
  const long = lines.length > 20;

  return (
    <div className={`code-block${collapsed ? " is-collapsed" : ""}`}>
      <div className="code-block-head">
        <span className="code-block-lang">{lang || "text"}</span>
        <span className="code-block-actions">
          <button
            className="icon-btn"
            title={texts.insertToEditor}
            onClick={() => post({ type: "insertText", text: code })}
          >
            <IconPencil size={13} />
          </button>
          <button
            className="icon-btn"
            title={texts.copy}
            onClick={() => post({ type: "copy", text: code })}
          >
            <IconCopy size={13} />
          </button>
        </span>
      </div>
      <div className="code-block-body">
        <pre>
          <code>{code}</code>
        </pre>
      </div>
      {long ? (
        <button className="code-block-expand" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </button>
      ) : null}
    </div>
  );
}
