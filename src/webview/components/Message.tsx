import { memo, useRef } from "react";
import type { DiffLayout, MessageView, Segment } from "../../shared/chat";
import { post } from "../bridge";
import { IconBranch, IconCopy } from "../icons";
import { Markdown } from "./Markdown";
import { formatClock, useSelectionFreeze } from "./primitives";
import { ApprovalCard, CommandRow, FileChips, InjectedRow, NoticeRow, QuestionCard, ThinkingRow, ToolRow } from "./Rows";
import { useTexts } from "../texts";
import { producedOnly } from "../turnFiles";

/**
 * 助手正文块。流式期间正文每个 token 都在变，用户划选时冻结渲染保住选区
 * （只影响界面，后台 agent 不受影响），选区消失后立刻恢复跟随最新内容。
 */
function StreamText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useSelectionFreeze(ref, text);
  return (
    <div ref={ref} className="md-wrapper">
      <Markdown text={shown} />
    </div>
  );
}

/** 单条消息。用户消息是输入框样式的块，助手消息是无气泡正文。 */
export const Message = memo(function Message({
  message,
  diffLayout,
  canBranch = false,
}: {
  message: MessageView;
  /** 编辑类节点的 diff 排版（来自设置；缺省自适应）。 */
  diffLayout?: DiffLayout;
  /**
   * 这条消息能否作为分支锚点（只有**已结束**的那一轮可以）。
   *
   * `session/fork` 的 `atSeq` 必须落在 `turn/end` 上：开放轮里锚定会被宿主
   * 以 `OPEN_TURN` 拒绝，而不是往前裁剪——所以按钮在这里就要禁用。
   */
  canBranch?: boolean;
}) {
  const texts = useTexts();
  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <div className="bubble">{message.text}</div>
        {message.attachments?.length ? (
          <div className="composer-chips">
            {message.attachments.map((attachment) => (
              <span className="chip" key={attachment.id}>
                <span className="chip-name">{attachment.name}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const fullText = message.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n");

  // 「本轮改动」里刨掉已经申报交付的文件：模型申报的通常就是它刚改的那几个，
  // 两行都列一遍看着像同一件事说了两遍（口径见 turnFiles.ts）
  const producedFiles = producedOnly(message.produced, message.deliverables);

  return (
    <div className="msg msg-assistant">
      <div className="segments">
        {message.segments.map((segment) => {
          switch (segment.kind) {
            case "text":
              return <StreamText key={segment.id} text={segment.text} />;
            case "thinking":
              return (
                <ThinkingRow
                  key={segment.id}
                  text={segment.text}
                  streaming={segment.streaming}
                  durationMs={segment.durationMs}
                />
              );
            case "tool":
              return <ToolRow key={segment.id} tool={segment.tool} diffLayout={diffLayout} />;
            case "approval":
              return <ApprovalCard key={segment.id} approval={segment.approval} />;
            case "question":
              return <QuestionCard key={segment.id} question={segment.question} />;
            case "injected":
              return <InjectedRow key={segment.id} injected={segment.injected} />;
            case "command":
              return <CommandRow key={segment.id} command={segment.command} />;
            case "notice":
              return <NoticeRow key={segment.id} level={segment.level} text={segment.text} />;
            default:
              return null;
          }
        })}
        {/* 轮尾文件：先「本轮改动」（从成功的写类调用推导），再「交付文件」
            （present 工具的显式申报）。两者此前都不渲染——写过的文件在界面上
            完全不可见，只能靠模型在正文里自己说（docs/audit-summary.md §5）。
            申报过交付的文件不再在本行重复，只留在下面的交付行。 */}
        {producedFiles.length ? (
          <FileChips
            label={texts.producedLabel}
            paths={producedFiles.map((path) => ({ path }))}
          />
        ) : null}
        {message.deliverables?.length ? (
          <FileChips label={texts.presentedLabel} paths={message.deliverables} />
        ) : null}
        {message.error ? <NoticeRow level="error" text={message.error} /> : null}
      </div>
      <div className="msg-actions">
        <span className="msg-time">{formatClock(message.ts)}</span>
        {/* 分支：复制按钮**左侧**（用户指定）。运行中不能分支——`session/fork`
            的锚点必须落在 `turn/end` 上，开放轮里锚定会被宿主拒绝而不是往前裁剪。 */}
        <button
          className="icon-btn"
          title={canBranch ? texts.branchFromHere : texts.branchRunning}
          disabled={!canBranch}
          onClick={() => post({ type: "branchFrom", messageId: message.id })}
        >
          <IconBranch size={14} />
        </button>
        <button
          className="icon-btn"
          title={texts.copy}
          onClick={() => post({ type: "copy", text: fullText })}
        >
          <IconCopy size={14} />
        </button>
      </div>
    </div>
  );
});
