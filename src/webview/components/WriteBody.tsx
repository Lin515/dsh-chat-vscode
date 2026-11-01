import { useRef } from "react";
import type { DiffHunkView, DiffLayout } from "../../shared/chat";
import { languageForPath } from "../markdown/highlight";
import type { WritePreview } from "../writePreview";
import { useTexts } from "../texts";
import { DiffView } from "./Diff";
import { CodeText } from "./HighlightedText";
import { useSelectionFreeze, useStickyBody } from "./primitives";

/** write 原文与既有 diff 共用一个阅读盒子，划选期间连同呈现方式一并冻结。 */
export function WriteBody({ preview, diff, layout, active, openedWhileActive, path }: {
  preview?: WritePreview;
  diff?: DiffHunkView[];
  layout?: DiffLayout;
  /** 工具还在运行：预览保持纯文，diff 也不着色。 */
  active: boolean;
  openedWhileActive: boolean;
  /** 参数里的目标文件路径：只在 hunk 没有 path 时作为语言回退。 */
  path?: string;
}) {
  const texts = useTexts();
  const ref = useRef<HTMLDivElement>(null);
  const shown = useSelectionFreeze(ref, { preview, diff, layout });
  const hasDiff = Boolean(shown.diff?.length);
  const lang = languageForPath(path);
  useStickyBody(ref, true, active, openedWhileActive);
  return (
    <div ref={ref} className={`row-body${hasDiff ? "" : " io-card write-preview"}`}>
      {hasDiff && shown.diff ? (
        <DiffView
          hunks={shown.diff}
          layout={shown.layout}
          unified
          phase={active ? "streaming" : "settled"}
          {...(lang === undefined ? {} : { fallbackLang: lang })}
        />
      ) : (
        <div className="io-section">
          <span className="io-label">{texts.toolWritePreview}</span>
          <span className="row-running-hint">{shown.preview?.complete ? texts.toolWritePreviewHint : texts.toolWritePreviewPartialHint}</span>
          <CodeText
            className="io-text mono"
            text={shown.preview?.text ?? ""}
            active={!active}
            {...(lang === undefined ? {} : { lang })}
          />
        </div>
      )}
    </div>
  );
}
