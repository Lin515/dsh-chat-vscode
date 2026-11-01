/**
 * 代码块卡片（Continue 的观感：`--vscode-editor-background` 作底、outline 而非
 * border，头部 12px，右侧一组悬停才出现的图标按钮）。
 *
 * 单独一个文件而不是留在 `Markdown.tsx` 里：正文（markdown 渲染）与工具卡
 * （`run_code` 的代码正文，官方 `formatToolBody` 的 code 分支）共用同一张卡片；
 * 工具行会被无头环境渲染（例如 `scripts/questionRender.test.ts`），卡片留在组件层
 * 可避免正文入口的解析依赖牵连工具行。
 */
import { useMemo, useState } from "react";
import type { MarkdownPhase } from "../markdown/types";
import { post } from "../bridge";
import { IconChevronDown, IconCopy, IconPencil } from "../icons";
import { useTexts } from "../texts";

/**
 * 阶段 2 只透传 `phase` 占位：完成态增强（高亮）在阶段 3 接入。
 * 卡片折展状态留在本组件内，同一卡片从 streaming 到 settled 不重挂即可保留。
 */
export function CodeBlock({ lang, code }: { lang?: string; code: string; phase?: MarkdownPhase }) {
  const texts = useTexts();
  const lines = useMemo(() => code.split("\n"), [code]);
  const long = lines.length > 20;
  // 没点过折展箭头时按内容长度取默认：长块收起、短块展开（短块没有箭头，收起就打不开）。
  // 即使把长块收起过，内容变成短块时也强制展开；点过之后，长块沿用用户的选择。
  const [chosenCollapsed, setChosenCollapsed] = useState<boolean | null>(null);
  const collapsed = long && (chosenCollapsed ?? true);

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
        <button
          type="button"
          className="code-block-expand"
          aria-expanded={!collapsed}
          aria-label={collapsed ? texts.codeBlockExpandAria : texts.codeBlockCollapseAria}
          onClick={() => setChosenCollapsed(!collapsed)}
        >
          {/* 图标恒为朝下的 chevron：收起态朝下（还能展开），展开后由样式转 180° 朝上
              （表示收起），与本应用其它正文折展箭头同口径 */}
          <IconChevronDown size={16} />
        </button>
      ) : null}
    </div>
  );
}
