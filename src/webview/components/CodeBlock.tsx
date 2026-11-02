/**
 * 代码块卡片（Continue 的观感：`--vscode-editor-background` 作底、outline 而非
 * border，头部 12px，右侧一组悬停才出现的图标按钮）。
 *
 * 单独一个文件而不是留在 `Markdown.tsx` 里：正文（markdown 渲染）与工具卡
 * （`run_code` 的代码正文，官方 `formatToolBody` 的 code 分支）共用同一张卡片；
 * 工具行会被无头环境渲染（例如 `scripts/questionRender.test.ts`），卡片留在组件层
 * 可避免正文入口的解析依赖牵连工具行。
 *
 * 完成态高亮的边界（见 docs/design-markdown-rendering.md 的「代码高亮」）：
 * - streaming / SSR 只输出纯文本，effect 不跑就不会初始化 Shiki；
 * - 只有 `code` / 归一化语言 / `phase` 变化才重新请求；普通重渲染（词表、locale、
 *   cwd）与同义语言标签切换都不会重复着色；
 * - 异步结果按请求取消标记隔离，旧结果绝不写进新代码；渲染前再核对当前 key，避免
 *   切换瞬间旧 span 覆盖新 `code`；
 * - 结果抵达时若活动选区与 `<code>` 相交（含从段落拖进代码、跨两张卡），先暂存，
 *   等选区清空 / 移开后再应用；卡片 DOM、折展状态和复制用的 `code` 都不变；
 * - span 文本全部由原 `code` 切片生成，不拼 HTML、不用 `dangerouslySetInnerHTML`。
 */
import { useRef, useState } from "react";
import type { MarkdownPhase } from "../markdown/types";
import { IconChevronDown } from "../icons";
import { useTexts } from "../texts";
import { CopyButton } from "./CopyButton";
import { renderHighlighted } from "./HighlightedText";
import { useCodeHighlight } from "./useCodeHighlight";

/**
 * 阶段 3 起，`phase` 决定是否做完成态高亮；缺省 settled（静态调用方与 `run_code`
 * 的完整参数）。卡片折展状态留在本组件内，同一卡片从 streaming 到 settled 不重挂
 * 即可保留。
 */
export function CodeBlock({
  lang,
  code,
  phase = "settled",
}: {
  lang?: string;
  code: string;
  phase?: MarkdownPhase;
}) {
  const texts = useTexts();
  const lines = code.split("\n");
  const long = lines.length > 20;
  // 没点过折展箭头时按内容长度取默认：长块收起、短块展开（短块没有箭头，收起就打不开）。
  // 即使把长块收起过，内容变成短块时也强制展开；点过之后，长块沿用用户的选择。
  const [chosenCollapsed, setChosenCollapsed] = useState<boolean | null>(null);
  const collapsed = long && (chosenCollapsed ?? true);
  const codeElRef = useRef<HTMLElement | null>(null);
  // 身份、请求取消与选区冻结都在共享 hook 里；这里只把 phase 翻译成 active。
  // `ts` / `TypeScript` / `ts title=x` 只是同一个语法的不同标签，切换标签不会拆掉
  // 已有 span、重新请求或破坏正在拖动的选区。
  const activeSpans = useCodeHighlight({
    code,
    lang,
    active: phase === "settled",
    elementRef: codeElRef,
  });

  return (
    <div className={`code-block${collapsed ? " is-collapsed" : ""}`}>
      <div className="code-block-head">
        <span className="code-block-lang">{lang || "text"}</span>
        <span className="code-block-actions">
          <CopyButton text={code} title={texts.copy} />
        </span>
      </div>
      <div className="code-block-body">
        <pre>
          <code ref={codeElRef}>
            {activeSpans === null ? code : renderHighlighted(code, activeSpans)}
          </code>
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
