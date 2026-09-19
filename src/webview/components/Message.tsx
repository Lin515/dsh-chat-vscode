import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { DiffLayout, FileChangeKind, MessageView, Segment } from "../../shared/chat";
import { localImageMediaType } from "../../shared/imageRef";
import { post } from "../bridge";
import { IconBranch, IconCopy } from "../icons";
import { Markdown } from "./Markdown";
import { ImageGallery, LocalImageGallery, type ImageSource } from "./Images";
import { formatClock, useSelectionFreeze } from "./primitives";
import { ApprovalCard, CommandRow, FileChips, InjectedRow, MessageImages, NoticeRow, QuestionCard, ThinkingRow, ToolRow, TurnProcessRow, TurnStatsButton, UnknownBlockRow } from "./Rows";
import { useTexts } from "../texts";
import { producedOnly, withoutVanished } from "../turnFiles";
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

/**
 * 用户消息默认折叠的行数（用户 2026-09-14 口径：超过 5 行就默认收缩）。
 *
 * 实现走 CSS `max-height` + 实测溢出，而不是「数字符串里的换行符」：一段很长的
 * prompt 可能一个 `\n` 都没有，却会折行占满整屏——按换行符数会以为只有一行、
 * 于是不折，正是用户抱怨的那种「一条消息把整个会话顶下去」。
 */
const USER_COLLAPSE_LINES = 5;

/**
 * 用户消息正文（只渲染气泡；「展开 / 收起」按钮在消息的**操作行**里，见下面）。
 *
 * 溢出判定必须**在折叠态下量**：`is-clamped` 一直在（未展开时），于是
 * `scrollHeight > clientHeight` 就是「内容比 5 行高」这个事实本身。展开后不再
 * 重算（那时量不出区别），按钮由已知的溢出状态决定去留。
 *
 * 状态与测量都由**父组件**（`Message`）持有：「展开」按用户口径要和时间、复制
 * 同一行、且最靠右——那三个按钮都在 `.msg-actions` 里，气泡在它上面。hooks 因此
 * 提到 `Message` 顶部（必须在 role 早退之前，顺序才固定）。
 */
function UserBubble({
  text,
  expanded,
  nodeRef,
}: {
  text: string;
  expanded: boolean;
  /**
   * **不能叫 `ref`**：React 18 里 `ref` 是函数组件的保留 prop，传进去不会出现在
   * props 里（会警告「Function components cannot be given refs」），
   * `bubbleRef.current` 于是永远是 null、溢出永远测不出来——按钮就不出现。
   */
  nodeRef: RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={nodeRef}
      className={`bubble${expanded ? "" : " is-clamped"}`}
      // 折叠行数只写在这一个常量里，CSS 通过自定义属性读它（见 app.css 的
      // `.bubble.is-clamped`）——两处各写一个 5 迟早会对不上。
      style={{ "--user-clamp-lines": USER_COLLAPSE_LINES } as CSSProperties}
    >
      {text}
    </div>
  );
}

/** 单条消息。用户消息是输入框样式的块，助手消息是无气泡正文。 */
export const Message = memo(function Message({
  message,
  diffLayout,
  fileKinds,
  questionBatch,
  turnProcessThreshold,
  canBranch = false,
  takenOverId,
}: {
  message: MessageView;
  /** 编辑类节点的 diff 排版（来自设置；缺省自适应）。 */
  diffLayout?: DiffLayout;
  /** 文件芯片的种类表（宿主按 git 判定后整表下发；缺省不标记号）。 */
  fileKinds?: Record<string, FileChangeKind>;
  /** 问卷一次展开几道题（`dshChat.questionBatch`；缺省用默认阈值）。 */
  questionBatch?: number;
  /**
   * 连续过程折叠的阈值（`dshChat.turnProcessThreshold`；缺省用默认 5）。
   * `0` = 永不折叠；`1–2` = 永远折叠（只有 1 次工具调用的段照旧平铺）。
   */
  turnProcessThreshold?: number;
  /**
   * 这条消息能否作为分支锚点（只有**已结束**的那一轮可以）。
   *
   * `session/fork` 的 `atSeq` 必须落在 `turn/end` 上：开放轮里锚定会被宿主
   * 以 `OPEN_TURN` 拒绝，而不是往前裁剪——所以按钮在这里就要禁用。
   */
  canBranch?: boolean;
  /**
   * 被输入区接管的那个交互的 `requestId`（`pendingRequestId(pending)`）。
   *
   * **只有这一条** waiting 段要从流里撤下（由输入区渲染）；其余的留在流里。
   * 缺省（`undefined`）表示当前没有待处理交互，卡片一律留在流里。
   */
  takenOverId?: string;
}) {
  const texts = useTexts();
  // 连续过程折叠的展开态，**按段记**（键 = 那一段首段的 id）：一轮里可能有好几枚
  // 按钮（一段连续工具调用一枚），各自开合。hooks 必须在早退之前（顺序固定）
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  // 用户消息的收缩态与「内容比 5 行高」这个事实（同上，必须在早退之前）。
  // 按钮画在操作行里、气泡在它上面，所以状态只能由这里持有。
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [bubbleOverflowing, setBubbleOverflowing] = useState(false);

  useLayoutEffect(() => {
    if (message.role !== "user") return;
    const el = bubbleRef.current;
    if (!el || bubbleOpen) return;
    const measure = () => setBubbleOverflowing(el.scrollHeight - el.clientHeight > 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // 面板变窄会让同样的文字折成更多行：窗口尺寸变化也要重量一次
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [message.role, message.text, bubbleOpen]);

  if (message.role === "user") {
    // 附件分两路：图片附件一旦拿到字节（服务端 durable 句柄换的 data URL）就画成
    // 缩略图；还没到 / 取不回来、以及文件附件，退回文件名芯片——用户至少能确认
    // 「我发出去的是哪些东西」，而不是一片空白或一个碎图图标。
    const attachments = message.attachments ?? [];
    const images: ImageSource[] = attachments
      .filter((attachment) => attachment.kind === "image" && attachment.dataUrl)
      .map((attachment) => ({
        src: attachment.dataUrl as string,
        alt: attachment.name,
        width: attachment.width,
        height: attachment.height,
      }));
    const chips = attachments.filter((attachment) => attachment.kind !== "image" || !attachment.dataUrl);
    return (
      <div className="msg msg-user" data-msg-id={message.id}>
        <UserBubble text={message.text ?? ""} expanded={bubbleOpen} nodeRef={bubbleRef} />
        {attachments.length ? (
          <div className="msg-media">
            {images.length ? <ImageGallery alt={texts.messageImageAlt} sources={images} /> : null}
            {chips.length ? (
              <div className="composer-chips">
                {chips.map((attachment) => (
                  <span className="chip" key={attachment.id}>
                    <span className="chip-name">{attachment.name}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {/* 用户消息也有操作行：官方 `MessageIconActions` 是用户与助手**共用**的，
            用户那一支给「时钟（start）+ 复制」、**没有分支**（分支必须锚在
            `turn/end` 上，用户消息不是锚点）。此前用户消息完全没有操作行，
            想复制自己刚发的那段长 prompt 无处可点，只能手动选中。

            「展开 / 收起」也在这里，且**最靠右**（用户 2026-09-14 口径）：它属于
            「这条消息的操作」，和复制同一行才顺手；放在气泡下方会另起一段空白。 */}
        <div className="msg-actions">
          <span className="msg-time">{formatClock(message.ts)}</span>
          <button
            className="icon-btn"
            title={texts.copy}
            onClick={() => post({ type: "copy", text: message.text ?? "" })}
          >
            <IconCopy size={14} />
          </button>
          {bubbleOverflowing ? (
            <button
              className="msg-expand"
              aria-expanded={bubbleOpen}
              title={bubbleOpen ? texts.userMessageCollapse : texts.userMessageExpand}
              onClick={() => setBubbleOpen((value) => !value)}
            >
              {bubbleOpen ? texts.userMessageCollapse : texts.userMessageExpand}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const fullText = message.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n");

  // 「本轮改动」里刨掉已经申报交付的文件：模型申报的通常就是它刚改的那几个，
  // 两行都列一遍看着像同一件事说了两遍（口径见 turnFiles.ts）。
  // 再刨掉**净效果为零**的文件（写了又删、git 完全不认识，宿主分类为 `gone`）：
  // 模型提交时写的 `commit.msg.txt` 正是这一类。
  const producedFiles = withoutVanished(
    producedOnly(message.produced, message.deliverables),
    fileKinds,
    (path) => path,
  );
  const deliverables = withoutVanished(
    message.deliverables ?? [],
    fileKinds,
    (file) => file.path,
  );

  // 本轮**生成或申报交付**的图片文件：这是 agent 表达「给你一张图」最常用的方式
  // （`present` 申报、或直接 write 出来），而它此前只长成一行文件芯片——用户在界面上
  // 永远看不到图（2026-09-18 实测：agent 下载一张 jpg、写一张 svg 再 present，
  // 界面上一张都看不见）。非图片路径仍走芯片，一个路径只画一遍。
  const imageFiles = [
    ...new Set([...producedFiles, ...deliverables.map((file) => file.path)]),
  ].filter((path) => localImageMediaType(path));

  // 连续过程折叠：一轮**结束后**，把最后那段正文之外的一切折成按钮（中途正文也在里面），
  // 折完读作「按钮 → 回答」——中途的话不会再跟回答贴到一起（用户 2026-09-16 最终口径）。
  // 流式期间不折（官方要求 turnClosed）；阈值来自 `dshChat.turnProcessThreshold`
  // （默认 5，0 = 永不折）。口径与官方的差异见 turnProcess.ts 的文件头。
  const fold = foldTurnProcess(message.segments, !message.streaming, turnProcessThreshold);

  const toggleRun = (anchorId: string) =>
    setOpenRuns((prev) => {
      const next = new Set(prev);
      if (next.has(anchorId)) next.delete(anchorId);
      else next.add(anchorId);
      return next;
    });

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
        // 待处理的审批卡由**输入区**渲染（官方 `conversation.composer` 接管），这里跳过
        // 免得同一张卡出现两次；已经答过的留在流里当记录。
        // **只跳过被选中的那一条**（`takenOverId`）：万一同一个会话出现两张 waiting 卡
        // （框架层不合法，但宿主侧的卡片补投有机会造出来），被撤下的那张必须留在流里，
        // 否则输入区只画一张、这张谁也渲染不了（见 pendingInteraction.ts 文件头）。
        return isTakenOverByComposer(segment, takenOverId) ? null : (
          <ApprovalCard key={segment.id} approval={segment.approval} />
        );
      case "question":
        return isTakenOverByComposer(segment, takenOverId) ? null : (
          <QuestionCard key={segment.id} question={segment.question} batch={questionBatch} />
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

  // 每一段连续过程在它的**首段**位置放一枚按钮，其余成员略过；展开后按钮留在原位
  // （官方 `turn-process` 节点就是流里的一个普通节点，成员在它下面展开），成员照原序
  // 铺回来。除「本轮最后一段正文」外的一切都是成员——已答复的交互卡、轮级提示、
  // 命令、图片、未知块也照样折进去（成员清单见 `turnProcess.ts` 文件头；官方
  // `TURN_PROCESS_INDEPENDENT_KINDS` 那套豁免在本扩展口径里不存在）。待处理的
  // 审批/提问卡不是折不折的问题：它由输入区接管，renderSegment 里直接渲染成 null。
  // `message.error` 不在段集合里，由消息尾部的 NoticeRow 单独渲染，同样不进按钮。
  const rendered: ReactNode[] = [];
  for (const segment of message.segments) {
    const run = fold.bySegment.get(segment.id);
    if (run) {
      const open = openRuns.has(run.anchorId);
      if (segment.id === run.anchorId) {
        rendered.push(
          <TurnProcessRow
            key={`turn-process-${run.anchorId}`}
            label={texts.turnProcessLabel(run.counts)}
            open={open}
            onToggle={() => toggleRun(run.anchorId)}
          />,
        );
      }
      if (!open) continue;
    }
    rendered.push(renderSegment(segment));
  }

  return (
    <div className="msg msg-assistant" data-msg-id={message.id}>
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
        {!message.streaming && imageFiles.length ? (
          <LocalImageGallery paths={imageFiles} />
        ) : null}
        {!message.streaming && producedFiles.length ? (
          <FileChips
            label={texts.producedLabel}
            paths={producedFiles.map((path) => ({ path }))}
            kinds={fileKinds}
          />
        ) : null}
        {!message.streaming && deliverables.length ? (
          <FileChips label={texts.presentedLabel} paths={deliverables} kinds={fileKinds} />
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
      {/* 轮尾操作行（时间 / 分支 / 复制 / 用时）。**生成过程中整行不画**（用户
          2026-09-17 口径）：流式期间时间在跳、分支不可点、复制的内容也没定稿，
          右下角这一排是噪音；轮次结束（`streaming === false`）才出现。 */}
      {!message.streaming ? (
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
          {/* 复制不给「工具串」（用户 2026-09-17 澄清口径）：整轮只有连续工具调用、
              一段正文都没有时，这条消息没有可复制的正文，按钮不出现；单张工具卡
              展开的内容仍有各自的复制按钮（见 ToolCards.tsx）。 */}
          {fullText !== "" ? (
            <button
              className="icon-btn"
              title={texts.copy}
              onClick={() => post({ type: "copy", text: fullText })}
            >
              <IconCopy size={14} />
            </button>
          ) : null}
          {/* 轮尾「用时 X」胶囊：官方把它挂在操作条的 usageAction 槽里（最新一轮常显、
              其余轮悬停出现），点开是「本轮总用时 / 输出速度 / 首 token 用时」明细。
              只在轮次结束后有数据（`turnStats` 由 turn/end 写入）。 */}
          {message.turnStats ? <TurnStatsButton stats={message.turnStats} /> : null}
        </div>
      ) : null}
    </div>
  );
});
