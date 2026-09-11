import { memo } from "react";
import type { MessageView, Segment } from "../../shared/chat";
import { post } from "../bridge";
import { IconCopy, IconThumbDown, IconThumbUp } from "../icons";
import { Markdown } from "./Markdown";
import { formatClock } from "./primitives";
import { ApprovalCard, NoticeRow, QuestionCard, ThinkingRow, ToolRow, UsageRow } from "./Rows";
import { useTexts } from "../texts";

/** 单条消息。用户消息是输入框样式的块，助手消息是无气泡正文。 */
export const Message = memo(function Message({
  message,
  showUsageStats = true,
}: {
  message: MessageView;
  showUsageStats?: boolean;
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
              return (
                <div key={segment.id} className="md-wrapper">
                  <Markdown text={segment.text} />
                </div>
              );
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
              return <ToolRow key={segment.id} tool={segment.tool} />;
            case "approval":
              return <ApprovalCard key={segment.id} approval={segment.approval} />;
            case "question":
              return <QuestionCard key={segment.id} question={segment.question} />;
            case "notice":
              return <NoticeRow key={segment.id} level={segment.level} text={segment.text} />;
            default:
              return null;
          }
        })}
        {message.error ? <NoticeRow level="error" text={message.error} /> : null}
        <UsageRow
          usage={message.usage}
          durationMs={message.durationMs}
          firstTokenMs={message.firstTokenMs}
          enabled={showUsageStats}
        />
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
        <button className="icon-btn" title={texts.thumbsUp} onClick={() => post({ type: "copy", text: "/feedback good" })}>
          <IconThumbUp size={14} />
        </button>
        <button className="icon-btn" title={texts.thumbsDown} onClick={() => post({ type: "copy", text: "/feedback bad" })}>
          <IconThumbDown size={14} />
        </button>
      </div>
    </div>
  );
});
