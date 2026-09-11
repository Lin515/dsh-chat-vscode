import { memo, useRef } from "react";
import type { DiffLayout, MessageView, Segment } from "../../shared/chat";
import { post } from "../bridge";
import { IconCopy } from "../icons";
import { Markdown } from "./Markdown";
import { formatClock, useSelectionFreeze } from "./primitives";
import { ApprovalCard, InjectedRow, NoticeRow, QuestionCard, ThinkingRow, ToolRow } from "./Rows";
import { useTexts } from "../texts";

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
}: {
  message: MessageView;
  /** 编辑类节点的 diff 排版（来自设置；缺省自适应）。 */
  diffLayout?: DiffLayout;
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
            case "notice":
              return <NoticeRow key={segment.id} level={segment.level} text={segment.text} />;
            default:
              return null;
          }
        })}
        {message.error ? <NoticeRow level="error" text={message.error} /> : null}
      </div>
      <div className="msg-actions">
        <span className="msg-time">{formatClock(message.ts)}</span>
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
