/**
 * 完成态代码高亮的共享接线：身份、异步取消与选区冻结。
 *
 * `highlightCode` 是纯模块；真正容易写错的是 React 这一层：
 * - 只有 `active`（streaming / 运行中为 false）才请求，SSR effect 不跑、保持纯文；
 * - 身份用「归一化语言 + 原 code」，旧结果绝不写进新代码；
 * - 结果抵达时若活动选区与目标元素相交，先暂存，等选区清空 / 移开再应用；
 * - 渲染前再核对当前 key，代码或语言一变立即退回纯文本。
 *
 * `CodeBlock`、read 卡、diff 两侧、write 预览与 JSON 输出都复用这一份，不另造引擎。
 */
import { useEffect, useState, type RefObject } from "react";
import { highlightCode, normalizeLang, type HighlightSpan } from "../markdown/highlight";
import { selectionIntersectsElement } from "../selectionRange";

/** 结果身份：归一化语言 + 原 code；别名共享同一份结果。 */
function highlightKey(lang: string, code: string): string {
  return `${lang}\u0000${code}`;
}

export function useCodeHighlight({
  code,
  lang,
  active,
  elementRef,
}: {
  /** 原源码；span 渲染时仍从这里切片，不重新拼接。 */
  code: string;
  /** 未归一化的语言标签（可来自文件扩展名或工具元数据）。 */
  lang: string | undefined;
  /** false = 生成中 / 运行中 / 尚未结算：保持纯文本且不发起请求。 */
  active: boolean;
  /** 选区冻结的判定范围（通常就是承载这段文本的元素）。 */
  elementRef: RefObject<HTMLElement | null>;
}): HighlightSpan[] | null {
  const normalized = normalizeLang(lang);
  const key = normalized === undefined ? undefined : highlightKey(normalized, code);
  const [result, setResult] = useState<{ key: string; spans: HighlightSpan[] } | null>(null);

  useEffect(() => {
    if (!active || normalized === undefined || key === undefined) {
      setResult(null);
      return;
    }
    let cancelled = false;
    let detach: (() => void) | undefined;
    // 代码 / 语言一变，第一帧就退回纯文；旧结果不能等到新结果回来才让位。
    setResult(null);
    const apply = (spans: HighlightSpan[]) => {
      if (!cancelled) setResult({ key, spans });
    };
    /** 选区与这段文本相交时先冻结；等选区清空 / 移开再应用最新结果。 */
    const waitForSelection = (spans: HighlightSpan[]) => {
      const element = elementRef.current;
      if (element === null || !selectionIntersectsElement(element)) {
        apply(spans);
        return;
      }
      const onSelectionChange = () => {
        if (cancelled) return;
        const current = elementRef.current;
        if (current !== null && selectionIntersectsElement(current)) return;
        detach?.();
        detach = undefined;
        apply(spans);
      };
      document.addEventListener("selectionchange", onSelectionChange);
      detach = () => document.removeEventListener("selectionchange", onSelectionChange);
    };
    void highlightCode(code, normalized).then((spans) => {
      if (cancelled || spans === null) return;
      waitForSelection(spans);
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [active, code, elementRef, key, normalized]);

  return active && result !== null && result.key === key ? result.spans : null;
}
