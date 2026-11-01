import { memo, useEffect, useMemo, useRef, useState } from "react";
import { renderMath, type MathRenderSource } from "../markdown/mathRender";
import type { MarkdownPhase } from "../markdown/types";
import { selectionIntersectsElement } from "../selectionRange";
import { useSelectionFreeze } from "./primitives";

/**
 * 私有公式视图。只接受解析层已经确认的 [MathRenderSource] 事实，不接受原始
 * HTML、不扫描正文、不识别任意 class。
 *
 * - 首帧与 SSR 显示 `raw` 原文；settled 后懒调 `renderMath`。未闭合、超长、
 *   缺少 DOM、KaTeX 抛错或净化失败都继续显示原文，绝不补闭合或拼 HTML。
 * - 异步结果按渲染身份隔离：phase 与 `{form, closed, raw, tex}` 编成 JSON 元组，
 *   render 期只显示与当前有效身份一致的结果；源变化第一帧即回 `raw`，不靠
 *   effect 事后清旧 HTML。`memo` 只比较这些 primitive，父级重渲染、词表 / cwd /
 *   i18n 变化不会重新初始化引擎。
 * - 选区冻结复用 `useSelectionFreeze` 保留完整的 `{source, phase}` 快照（含
 *   `raw` / `form`），而不是只冻结已排版 HTML：显示原文时被选中的 TextNode
 *   同样不能因 props 更新被替换。异步结果应用前再检查一次活动选区（含多
 *   Range、从其他段落 / 消息跨进公式），相交时暂存并等 `selectionchange`。
 * - 根节点是受 React 控制的 `span`，带 `data-math-view` 来源标识；display
 *   由 CSS 设为块级，因此 heading / 表格单元格等不可拆容器也不会出现 p 包 div。
 *   成功时只注入 [renderMath] 返回的已净化 HTML；失败路径只放文本节点。
 */
export interface MathViewProps {
  readonly source: MathRenderSource;
  readonly phase: MarkdownPhase;
}

/**
 * 渲染身份 = phase 与决定 `renderMath` 输出的四个事实。用 JSON 元组而不是
 * 分隔符拼接：`raw` / `tex` 允许 NUL、换行和任意分隔符，拼接字符串会碰撞。
 */
export function mathViewIdentity(source: MathRenderSource, phase: MarkdownPhase): string {
  return JSON.stringify([phase, source.form, source.closed, source.raw, source.tex]);
}

function sameMathView(previous: MathViewProps, next: MathViewProps): boolean {
  return previous.phase === next.phase
    && previous.source.form === next.source.form
    && previous.source.closed === next.source.closed
    && previous.source.raw === next.source.raw
    && previous.source.tex === next.source.tex;
}

function MathViewImpl({ source, phase }: MathViewProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  // 选区冻结必须连同 raw / form 一起保留：html 为 null（显示原文）时，只冻结
  // 已排版结果仍会在 props 更新时换掉被选中的 TextNode。
  const snapshot = useMemo(
    () => ({ source, phase }),
    [phase, source.form, source.closed, source.raw, source.tex],
  );
  const effective = useSelectionFreeze(rootRef, snapshot);
  const effectiveSource = effective.source;
  const effectivePhase = effective.phase;
  const identity = mathViewIdentity(effectiveSource, effectivePhase);
  // 结果带渲染身份：render 期只显示与当前有效身份一致的那份。source 变
  // invalid 时第一帧就回 raw，不靠 effect 事后清旧 DOM。
  const [rendered, setRendered] = useState<{
    readonly key: string;
    readonly html: string | null;
  } | null>(null);
  const html = rendered !== null && rendered.key === identity ? rendered.html : null;
  const pendingRef = useRef<{ readonly html: string | null } | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = (value: string | null): void => {
      if (!cancelled) setRendered({ key: identity, html: value });
    };
    const stopListening = (): void => {
      detachRef.current?.();
      detachRef.current = null;
    };
    /** 没有相交选区就立即应用；否则只保留最新一份，等选区解除。 */
    const applyWhenSelectionIdle = (value: string | null): void => {
      if (cancelled) return;
      const element = rootRef.current;
      if (element === null || !selectionIntersectsElement(element)) {
        pendingRef.current = null;
        stopListening();
        apply(value);
        return;
      }
      pendingRef.current = { html: value };
      if (detachRef.current !== null) return;
      const onSelectionChange = (): void => {
        if (cancelled) return;
        const current = rootRef.current;
        if (current !== null && selectionIntersectsElement(current)) return;
        const pending = pendingRef.current;
        pendingRef.current = null;
        stopListening();
        if (pending !== null) apply(pending.html);
      };
      document.addEventListener("selectionchange", onSelectionChange);
      detachRef.current = () => document.removeEventListener("selectionchange", onSelectionChange);
    };

    // 同一有效身份重新排版先回原文；身份变化已经由渲染期 key 挡住旧 HTML。
    applyWhenSelectionIdle(null);
    // streaming 只走 GFM，这里再守一道：不在生成期初始化 KaTeX。
    if (effectivePhase !== "settled") {
      return () => {
        cancelled = true;
        pendingRef.current = null;
        stopListening();
      };
    }
    void renderMath({
      form: effectiveSource.form,
      closed: effectiveSource.closed,
      tex: effectiveSource.tex,
      raw: effectiveSource.raw,
    }).then((renderedMath) => {
      if (cancelled) return;
      applyWhenSelectionIdle(renderedMath === undefined ? null : renderedMath.html);
    }).catch(() => {
      if (!cancelled) applyWhenSelectionIdle(null);
    });
    return () => {
      cancelled = true;
      pendingRef.current = null;
      stopListening();
    };
  }, [identity, effectivePhase, effectiveSource.closed, effectiveSource.form, effectiveSource.raw, effectiveSource.tex]);

  return (
    <span
      ref={rootRef}
      className={`math-view math-view-${effectiveSource.form}${html === null ? " math-view-source" : ""}`}
      data-math-view={effectiveSource.form}
    >
      {html === null
        ? effectiveSource.raw
        : <span className="math-content" dangerouslySetInnerHTML={{ __html: html }} />}
    </span>
  );
}

export const MathView = memo(MathViewImpl, sameMathView);
