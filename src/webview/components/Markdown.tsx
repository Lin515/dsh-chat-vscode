import { memo, useMemo } from "react";
import type { FileLinkPort } from "../fileLinks";
import { parseGfmMarkdown } from "../markdown/parse";
import { renderMarkdownDocument } from "../markdown/render";
import type { MarkdownPhase } from "../markdown/types";
import { useTexts } from "../texts";

/**
 * 助手正文的 Markdown 入口（薄包装）。
 *
 * 解析与渲染都在 `webview/markdown/`：这里只把文本、完成态与文件词表交给
 * 同一棵 React 文档树，不再切分 HTML 块、不再用 innerHTML，也不在渲染后
 * hydrate / replaceChildren。图片、文件按钮与链接都由 React 叶节点拥有。
 *
 * `phase` 缺省 `settled`：历史消息、工具详情、计划与轨迹预览都是完成态；
 * 只有助手正文在生成期间显式传 `streaming`（见 `Message.tsx` 的 `StreamText`）。
 *
 * 阶段 4 的 KaTeX / MathView 尚未接线：即使消息 settled，这里也显式走普通 GFM
 * 臂（[parseGfmMarkdown]），不让 math 节点进入尚不认识的渲染树。接线后改用
 * `parseMarkdown(text, phase)`。
 */
export const Markdown = memo(function Markdown({
  text,
  phase = "settled",
  fileLinks,
  cwd,
}: {
  text: string;
  /** 生成中 / 完成态。阶段 2 只透传，代码高亮与公式在后续阶段接入。 */
  phase?: MarkdownPhase;
  /** 文件链接词表（助手正文由 `Message` 按本轮文件给出，见 `fileLinks.ts`）。 */
  fileLinks?: FileLinkPort;
  /** 会话工作目录：相对路径的悬停标题按它补全；缺省保留链接上的原样拼写。 */
  cwd?: string;
}) {
  const texts = useTexts();
  const document = useMemo(() => parseGfmMarkdown(text), [text]);
  return (
    <div className="md">
      {renderMarkdownDocument(document, { phase, fileLinks, cwd, texts })}
    </div>
  );
});
