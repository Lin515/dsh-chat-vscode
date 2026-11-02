import { isValidElement, type ReactNode } from "react";

/**
 * 完成态公式的宿主适配。排版与 DOM → React 映射直接复用固定来源的官方实现，
 * 不维护第二份 KaTeX 标签、class、style 或 namespace 白名单。
 * 这里只守闭合 / 长度 / DOM 边界、懒加载和错误原文回退，不缓存公式或宏表。
 */

/** 单条公式的源码长度上限（UTF-16 code units）；超限直接回退原文。 */
export const MAX_MATH_TEX_LENGTH = 4000;

/** `renderMath` 接受的最小共同接口，兼容 `MathSource` 与 `MathFenceSource`。 */
export interface MathRenderSource {
  readonly form: "inline" | "display";
  readonly closed: boolean;
  readonly tex: string;
  readonly raw: string;
}

/** 官方适配器产出的 React 树，同时保留 KaTeX 的视觉层与辅助语义层。 */
export interface MathRendered {
  readonly content: ReactNode;
  readonly form: "inline" | "display";
}

type OfficialMath = typeof import("../../vendor/ui-primitives/markdown/katex");
let rendererPromise: Promise<OfficialMath> | undefined;

/** 只识别官方错误节点，不误伤 `\\text{katex-error}`，不改写合法排版树。 */
function hasErrorNode(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasErrorNode);
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return false;
  return (node.props.className?.split(/\s+/u).includes("katex-error") ?? false)
    || hasErrorNode(node.props.children);
}

/** 无 DOM / 未闭合 / 超长均在加载官方适配器前回退；失败由 MathView 显示 raw。 */
export async function renderMath(source: MathRenderSource): Promise<MathRendered | undefined> {
  if (source === null || typeof source !== "object" || source.closed !== true) return undefined;
  if (source.form !== "inline" && source.form !== "display") return undefined;
  if (typeof source.tex !== "string" || source.tex.length > MAX_MATH_TEX_LENGTH) return undefined;
  if (typeof window === "undefined" || typeof document === "undefined"
    || typeof DOMParser === "undefined" || typeof Node === "undefined") return undefined;

  try {
    rendererPromise ??= import("../../vendor/ui-primitives/markdown/katex");
    const { renderTexToReact } = await rendererPromise;
    const content = renderTexToReact(source.tex, source.form === "display");
    return hasErrorNode(content) ? undefined : { content, form: source.form };
  } catch {
    return undefined;
  }
}
