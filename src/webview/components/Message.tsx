import { memo, useRef, useState, type ReactNode } from "react";
import type { DiffLayout, FileChangeKind, MessageView, Segment } from "../../shared/chat";
import { post } from "../bridge";
import { IconBranch, IconCopy } from "../icons";
import { Markdown } from "./Markdown";
import { formatClock, useSelectionFreeze } from "./primitives";
import { ApprovalCard, CommandRow, FileChips, InjectedRow, MessageImages, NoticeRow, QuestionCard, ThinkingRow, ToolRow, TurnProcessRow, TurnStatsButton, UnknownBlockRow } from "./Rows";
import { useTexts } from "../texts";
import { producedOnly } from "../turnFiles";
import { foldTurnProcess } from "../turnProcess";
import { isTakenOverByComposer } from "../pendingInteraction";

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
  fileKinds,
  canBranch = false,
}: {
  message: MessageView;
  /** 编辑类节点的 diff 排版（来自设置；缺省自适应）。 */
  diffLayout?: DiffLayout;
  /** 文件芯片的种类表（宿主按 git 判定后整表下发；缺省不标记号）。 */
  fileKinds?: Record<string, FileChangeKind>;
  /**
   * 这条消息能否作为分支锚点（只有**已结束**的那一轮可以）。
   *
   * `session/fork` 的 `atSeq` 必须落在 `turn/end` 上：开放轮里锚定会被宿主
   * 以 `OPEN_TURN` 拒绝，而不是往前裁剪——所以按钮在这里就要禁用。
   */
  canBranch?: boolean;
}) {
  const texts = useTexts();
  // 轮级过程折叠的展开态。hooks 必须在早退之前（顺序固定）
  const [processOpen, setProcessOpen] = useState(false);
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
        {/* 用户消息也有操作行：官方 `MessageIconActions` 是用户与助手**共用**的，
            用户那一支给「时钟（start）+ 复制」、**没有分支**（分支必须锚在
            `turn/end` 上，用户消息不是锚点）。此前用户消息完全没有操作行，
            想复制自己刚发的那段长 prompt 无处可点，只能手动选中。 */}
        <div className="msg-actions">
          <span className="msg-time">{formatClock(message.ts)}</span>
          <button
            className="icon-btn"
            title={texts.copy}
            onClick={() => post({ type: "copy", text: message.text ?? "" })}
          >
            <IconCopy size={14} />
          </button>
        </div>
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

  // 轮级过程折叠（官方默认的 compact 转写模式）：一轮**结束后**，把答案步之前的一切
  // 折成一枚按钮。流式期间不折（官方要求 turnClosed）。口径与边界见 turnProcess.ts。
  const fold = foldTurnProcess(message.segments, !message.streaming);
  const foldedIds = new Set(fold.folded.map((segment) => segment.id));

  const renderSegment = (segment: Segment) => {
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
        // 待处理的审批卡由**输入区**渲染（官方 `conversation.composer` 接管），
        // 这里跳过免得同一张卡出现两次；已经答过的留在流里当记录。
        return isTakenOverByComposer(segment) ? null : (
          <ApprovalCard key={segment.id} approval={segment.approval} />
        );
      case "question":
        return isTakenOverByComposer(segment) ? null : (
          <QuestionCard key={segment.id} question={segment.question} />
        );
      case "injected":
        return <InjectedRow key={segment.id} injected={segment.injected} />;
      case "command":
        return <CommandRow key={segment.id} command={segment.command} />;
      case "notice":
        return <NoticeRow key={segment.id} level={segment.level} text={segment.text} />;
      case "images":
        return <MessageImages key={segment.id} images={segment.images} />;
      case "unknown":
        return <UnknownBlockRow key={segment.id} block={segment} />;
      default:
        return null;
    }
  };

  // 折叠时：在**第一个被折住的成员**那里放一枚按钮，其余成员整段略过。
  // 展开后按钮留在原位（官方 `turn-process` 节点就是流里的一个普通节点，成员在它
  // 下面展开），只是成员照原顺序铺回来。
  // 不参与折叠的段（自动载入的上下文、中止/截断提示）原地保留——它们折进去
  // 就是信息损失（官方 `TURN_PROCESS_INDEPENDENT_KINDS` 同理）。
  const rendered: ReactNode[] = [];
  let processRowPlaced = false;
  for (const segment of message.segments) {
    const isMember = fold.foldable && foldedIds.has(segment.id);
    if (isMember && !processRowPlaced) {
      processRowPlaced = true;
      rendered.push(
        <TurnProcessRow
          key="turn-process"
          label={texts.turnProcessLabel(fold.counts)}
          open={processOpen}
          onToggle={() => setProcessOpen(!processOpen)}
        />,
      );
    }
    if (isMember && !processOpen) continue;
    rendered.push(renderSegment(segment));
  }

  return (
    <div className="msg msg-assistant">
      <div className="segments">
        {rendered}
        {/* 轮尾文件：先「本轮改动」（从成功的写类调用推导），再「交付文件」
            （present 工具的显式申报）。两者此前都不渲染——写过的文件在界面上
            完全不可见，只能靠模型在正文里自己说（docs/audit-summary.md §5）。

            **只在轮次结束后显示**（`streaming === false`）：官方把这两行挂在
            turn-tail 节点上，`publication` 只在 `turn/end` 时 immediate，其余一律
            none（`dsh-client-ui-chat/lib/client.js` 的 turnTailDefinition）——即
            数据在轮次进行中就累积，但**节点不发布、行不渲染**。轮次没完就画一行
            不断变长的文件名，既与官方不一致，也让「本轮改了什么」看起来像已经定稿。
            宿主侧同一个时机还会先推一次 Git 重扫，所以行出现时记号与 diff 状态都是
            准的（见 `adapter.refreshFiles`）。

            申报过交付的文件不再在本行重复，只留在下面的交付行。 */}
        {!message.streaming && producedFiles.length ? (
          <FileChips
            label={texts.producedLabel}
            paths={producedFiles.map((path) => ({ path }))}
            kinds={fileKinds}
          />
        ) : null}
        {!message.streaming && message.deliverables?.length ? (
          <FileChips label={texts.presentedLabel} paths={message.deliverables} kinds={fileKinds} />
        ) : null}
        {/*
          `message.error` 有两种来源：真正的失败（`turn/end` 的 error 原因、服务端
          原始报错）与**被中断**（`assistant/message` 的 `interrupted` 标记）。
          官方把后者画成冻结正文末尾一枚 tertiary 色的小胶囊「已停止」——中止是用户
          按 ESC 的结果，不是失败；与工具行把 stopped 画成警告色是同一口径。以前
          这里一律画红色错误，按一次 ESC 看起来像出了事故。
        */}
        {message.error ? (
          <NoticeRow
            level={message.error === "@interrupted" ? "info" : "error"}
            text={message.error}
          />
        ) : null}
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
        {/* 轮尾「用时 X」胶囊：官方把它挂在操作条的 usageAction 槽里（最新一轮常显、
            其余轮悬停出现），点开是「本轮总用时 / 输出速度 / 首 token 用时」明细。
            只在轮次结束后有数据（`turnStats` 由 turn/end 写入）。 */}
        {message.turnStats ? <TurnStatsButton stats={message.turnStats} /> : null}
      </div>
    </div>
  );
});
