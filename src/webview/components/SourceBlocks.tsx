/**
 * 「原始内容」页签的**逐块排版**（官方 `TrajectoryTable.tsx` 的 `SourceBlocks()`）。
 *
 * 官方吃 `sourceBlocks` 的组件有三个，本扩展只做**数据真有的那一个**，位置与官方同一处
 * （`!rendered && sourceBlocks.length`）：
 * - `SourceBlocks`（按块的类型排版）→ 就是这里；
 * - `AssistantToolCalls`（助手消息里每个 tool-call 块一枚「打开调用概述」）→ **不做**：
 *   账本行右侧本来就画了每次调用的「摘要 → 结果」，账本里每个调用另有自己的工具行，
 *   预览页下方再列一遍是同一份信息的第三个落点。跳转入口改由这一页里 callId 那枚按钮给；
 * - `RecordAttachments`（附件 / 图片块）→ **没有数据**：2026-10-05 量过 455 份日志的
 *   101640 个块，`sourceBlocks` 里 `image` / `file` 块是 **0 例**（附件块只出现在工具结果
 *   里，那属于 `outputBlocks`）。所以这里对附件块只留一条**兜底**分支：真出现了就画出
 *   文件名与那段原文，不静默丢弃——图片字节的取回通道与 `outputBlocks` 的采集是同一件
 *   事，都还没做。
 *
 * 官方的第四个组件 `ToolOutputBlocks` 吃的是 `outputBlocks`，不在这一页的范围内。
 *
 * 块标题里的类型是**块类型串**（`thinking` / `text` / `tool-call`），不翻译：轨迹是拿日志
 * 核对事实的地方（口径见 `trajectoryDisplay.ts` 的 `trajectoryBlockLabel()`）。
 */
import { IconChevronRight } from "../icons";
import { trajectoryBlockLabel, trajectoryBlockOpenLabel } from "../trajectoryDisplay";
import type { TrajectorySourceBlock } from "../../shared/trajectory";
import type { TrajectoryTexts } from "../trajectoryTexts";

/** 块上的附件引用显示名（官方 `recordAttachments()` 的 `ref.name`；取不到给空串）。 */
function attachmentName(block: TrajectorySourceBlock): string {
  const ref = block.attachment ?? block.file;
  return typeof ref?.name === "string" ? ref.name : "";
}

export function SourceBlocks({
  blocks,
  texts,
  onOpenCall,
}: {
  blocks: readonly TrajectorySourceBlock[];
  texts: TrajectoryTexts;
  /**
   * 点了某个工具调用块（官方 `SourceBlocks` 的 `onOpenCall(block.callId)`）。
   *
   * 缺席时**不渲染那枚按钮**：官方对没有 `callId` 的块也是只画标题 + 正文
   * （`block.callId !== undefined` 才给按钮）。按钮画出来却点不动是最坏的一种。
   */
  onOpenCall?: (callId: string) => void;
}) {
  return (
    <div className="trajectory-source-blocks">
      {blocks.map((block, index) => {
        const label = trajectoryBlockLabel(block, index, texts);
        const callId = block.callId;
        const jumpable = callId !== undefined && onOpenCall !== undefined;
        const name = attachmentName(block);
        return (
          // 块没有稳定身份（就是数组下标），`index` 作 key 与官方同一取值
          <section className="trajectory-source-block" key={index}>
            {jumpable ? (
              <button
                type="button"
                className="trajectory-source-block-jump"
                aria-label={trajectoryBlockOpenLabel(index, texts)}
                title={texts.blockOpenSummaryTitle}
                onClick={() => {
                  onOpenCall(callId);
                }}
              >
                <span className="trajectory-source-block-label">{label}</span>
                <IconChevronRight size={12} className="trajectory-source-block-icon" />
              </button>
            ) : (
              <div className="trajectory-source-block-header">
                <span className="trajectory-source-block-label">{label}</span>
                {name ? (
                  <span className="trajectory-source-block-name" title={name}>
                    {name}
                  </span>
                ) : null}
              </div>
            )}
            {/* `tabIndex` 是给**键盘滚动**用的：这个 `<pre>` 自己横竖都能滚
                （`overflow: auto`），不可聚焦的滚动区键盘用户滚不动它。 */}
            <pre className="trajectory-source-block-content" tabIndex={0}>
              {block.content}
            </pre>
          </section>
        );
      })}
    </div>
  );
}
