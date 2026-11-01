import { useRef } from "react";
import type { DiffHunkView, DiffLayout } from "../../shared/chat";
import type { WritePreview } from "../writePreview";
import { useTexts } from "../texts";
import { DiffView } from "./Diff";
import { useSelectionFreeze, useStickyBody } from "./primitives";

/** write 原文与既有 diff 共用一个阅读盒子，划选期间连同呈现方式一并冻结。 */
export function WriteBody({ preview, diff, layout, active, openedWhileActive }: {
  preview?: WritePreview;
  diff?: DiffHunkView[];
  layout?: DiffLayout;
  active: boolean;
  openedWhileActive: boolean;
}) {
  const texts = useTexts();
  const ref = useRef<HTMLDivElement>(null);
  const shown = useSelectionFreeze(ref, { preview, diff, layout });
  const hasDiff = Boolean(shown.diff?.length);
  useStickyBody(ref, true, active, openedWhileActive);
  return (
    <div ref={ref} className={`row-body ${hasDiff ? "diff-body" : "io-card write-preview"}`}>
      {hasDiff && shown.diff ? <DiffView hunks={shown.diff} layout={shown.layout} unified /> : (
        <div className="io-section">
          <span className="io-label">{texts.toolWritePreview}</span>
          <span className="row-running-hint">{shown.preview?.complete ? texts.toolWritePreviewHint : texts.toolWritePreviewPartialHint}</span>
          <span className="io-text mono">{shown.preview?.text}</span>
        </div>
      )}
    </div>
  );
}
