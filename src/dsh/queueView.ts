import type { Attachment, QueuedMessageView } from "../shared/chat";

/**
 * 队列里「用户等待发送的消息」的视图（线格式 `SessionQueuedItem` → `QueuedMessageView`）。
 *
 * 队列项有三种 `placement`：`queued`（用户排队待发的消息）、`steering`（插话）、
 * `context`（插件注入的环境上下文，例如 MCP 服务器状态）。context 不是用户消息，
 * 不下发——否则全新会话一开场就会显示一串「排队消息」。
 *
 * 放在这里而不是 controller 里：这是纯映射，冒烟测试能直接验证，
 * 不必启动扩展宿主（controller 依赖 vscode）。
 */

/** 队列项的内部形态：给界面的视图 + 重新发出它所需的原始内容块。 */
export interface QueuedItemEntry {
  view: QueuedMessageView;
  /**
   * 原始内容块（`SessionQueuedItem.message.content`）。
   *
   * 用途是「ESC 中止并把这条发出去」：本地没有提交记录时（扩展重载过），
   * 直接拿它原样重新提交，比用文本重建更准确——它包含图片等非文本块。
   */
  content: unknown[];
}

export interface QueueOrigin {
  text: string;
  attachments: Attachment[];
  /** 本地记录的原始提交内容（最权威）。 */
  content?: unknown[];
}

/**
 * 把队列项映射成视图 + 原始内容。
 *
 * `resolve` 按队列项的 `rpcId` 取回用户原始输入：线格式正文里已拼进
 * `@path` 引用 token（见 controller 的 `composeWithReferences`），上传文件
 * 则是 `{type:'file', receiptId}` 块，直接显示回显会丢掉附件芯片。
 * 取不到时（例如扩展重载过）退回线上文本，至少有内容。
 */
export function queueItems(
  items: unknown[] | undefined,
  resolve?: (rpcId: string | undefined) => QueueOrigin | undefined,
): QueuedItemEntry[] {
  if (!Array.isArray(items)) return [];
  const out: QueuedItemEntry[] = [];
  for (const raw of items) {
    const item = raw as {
      id?: string;
      placement?: string;
      rpcId?: string;
      message?: { content?: unknown[] };
    } | null;
    if (!item?.id) continue;
    if (item.placement !== "queued" && item.placement !== "steering") continue;
    const parts = Array.isArray(item.message?.content) ? item.message!.content : [];
    const wireText = parts
      .map((part) => part as { type?: string; text?: string } | null)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part!.text)
      .join("\n")
      .trim();
    const hasMedia = parts.some((part) => {
      const type = (part as { type?: string } | null)?.type;
      return type === "image" || type === "file";
    });
    // 有本地原始记录时以它为准：线上文本含内联上下文，不是用户输入的原样
    const origin = resolve?.(item.rpcId);
    out.push({
      content: origin?.content ?? parts,
      view: {
        id: item.id,
        rpcId: item.rpcId,
        text: origin?.text ?? wireText,
        attachments: origin?.attachments.length,
        hasMedia,
        placement: item.placement,
      },
    });
  }
  return out;
}

/** 只要界面视图时的薄封装。 */
export function queueItemsView(
  items: unknown[] | undefined,
  resolve?: (rpcId: string | undefined) => QueueOrigin | undefined,
): QueuedMessageView[] {
  return queueItems(items, resolve).map((entry) => entry.view);
}
