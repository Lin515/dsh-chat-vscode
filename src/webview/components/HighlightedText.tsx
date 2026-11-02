/**
 * 高亮 token 的受控渲染：只把源码偏移段切成 React span，颜色仅来自本地主题的
 * `var(--md-code-*)`，字形修饰仅斜体 / 粗体 / 下划线 / 删除线。
 *
 * 不拼 HTML、不经过 `dangerouslySetInnerHTML`；普通缺口与末尾始终取原 `text`
 * 切片，因此显示文本逐字等于源文（CRLF / tab / NUL / 尾空白不变）。
 *
 * `CodeText` 是单块文本的共享接线（write 预览、inspect JSON 输出），内部复用
 * `useCodeHighlight`。read 卡与 diff 需要逐行排版，各自用 hook + 行切分渲染。
 */
import { useRef, type ReactNode } from "react";
import type { HighlightSpan } from "../markdown/highlight";
import { useCodeHighlight } from "./useCodeHighlight";

/** 官方 token 字形 → 受控 class（1 斜体 / 2 粗体 / 4 下划线 / 8 删除线）。 */
export function fontStyleClass(style: number | undefined): string | undefined {
  if (style === undefined) return undefined;
  const classes: string[] = [];
  if ((style & 1) !== 0) classes.push("is-italic");
  if ((style & 2) !== 0) classes.push("is-bold");
  if ((style & 4) !== 0) classes.push("is-underlined");
  if ((style & 8) !== 0) classes.push("is-struck");
  return classes.length === 0 ? undefined : classes.join(" ");
}

/** 按源码偏移段渲染：普通缺口也取原 `text` 切片，保证文本逐字等于源码。 */
export function renderHighlighted(text: string, spans: readonly HighlightSpan[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) nodes.push(text.slice(cursor, span.start));
    const slice = text.slice(span.start, span.end);
    const className = fontStyleClass(span.fontStyle);
    if (span.color === undefined && className === undefined) {
      nodes.push(slice);
    } else {
      nodes.push(
        <span
          key={span.start}
          className={className === undefined ? "md-code-token" : `md-code-token ${className}`}
          style={span.color === undefined ? undefined : { color: span.color }}
        >
          {slice}
        </span>,
      );
    }
    cursor = span.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * 单块文本 + 完成态高亮。`lang` 未知 / `active` 为假 / 超限 / 失败时输出原纯文本。
 * 自带 `md-code-surface` 语义类：只提供 `--md-code-*` 主题变量，不引入卡片几何。
 */
export function CodeText({
  text,
  lang,
  active,
  className,
}: {
  text: string;
  lang?: string;
  /** false = 生成中 / 运行中；仍渲染原文本，只是不着色。 */
  active: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const spans = useCodeHighlight({ code: text, lang, active, elementRef: ref });
  // 只有真的带语言时才挂主题变量面；未识别 / 错误的 OUT 保持原有 class 与纯文，
  // 不因为传进 CodeText 就多出一个无关的语义类。
  const classes = [className, lang === undefined ? undefined : "md-code-surface"]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" ");
  return (
    <span ref={ref} className={classes === "" ? undefined : classes}>
      {spans === null ? text : renderHighlighted(text, spans)}
    </span>
  );
}
