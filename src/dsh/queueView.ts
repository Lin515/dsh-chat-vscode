import type { Attachment, QueuedMessageView } from "../shared/chat";

/**
 * 队列里「用户等待发送的消息」的视图。**两条线格式并存**，都由这里折成同一个
 * `QueuedMessageView`：
 *
 * 1. **`inbox` 投影（当前服务端）**：键 `'inbox'`，值
 *    `{'next-turn': UserMessage[], 'next-step': UserMessage[]}`。两个列表的语义由
 *    **归属**给出：`next-turn` = 排队等下一轮（旧格式的 `queued`）、
 *    `next-step` = 等下一个 step 的插话（旧格式的 `steering`）。消息体自带
 *    `id` / `content` / `source:{kind,rpcId?}`。
 *    依据：`dsh-agent-loop/src/inbox.ts` 的 `inboxProjectionDefinition`
 *    （`{'next-turn','next-step'}` 两个 `UserMessage[]`）。
 * 2. **`SessionQueuedItem[]`（2026-09-09 之前的服务端）**：`session/control` 的
 *    baseline `value.queues[sessionId]` 与 `{type:'queue', items}` 帧。
 *    条目形如 `{id, placement:'queued'|'steering'|'context', rpcId?, message:{content}}`。
 *    服务端提交 `72f2e71070` 删掉了这条通道，改由 `inbox` 投影承载；扩展**两条都读**
 *    （见 `controller.onControlFrame` 的兼容分支），所以这一份不能删。
 *
 * 两条通道同源同值：旧通道当年就是由 `inbox` 投影派生出来的
 * （`8b0ea3e461` 的 `queueItemsFromInbox()`），对照关系逐条一致——`next-turn` →
 * `queued` 全部下发、`next-step` 里 `source.kind === 'user'` → `steering`、其余
 * （插件注入的环境上下文）丢弃；顺序都是排队在前、插话在后（宿主「ESC 中止并把
 * 队首发出去」按这个顺序重发，不许改）。
 *
 * 放在这里而不是 controller 里：这是纯映射，冒烟测试能直接验证，
 * 不必启动扩展宿主（controller 依赖 vscode）。
 */

/** 队列项的内部形态：给界面的视图 + 重新发出它所需的原始内容块。 */
export interface QueuedItemEntry {
  view: QueuedMessageView;
  /**
   * 原始内容块（线上消息的 `content`）。
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
 * `inbox` 投影 → 队列条目（当前服务端；见文件头）。
 *
 * 形状校验做在这一层：将来任一侧改了形状，结果只会「少显示几条」，不会崩、
 * 也不会把非队列消息当成待发项画出来。
 */
export function queueItemsFromInbox(
  value: unknown,
  resolve?: (rpcId: string | undefined) => QueueOrigin | undefined,
): QueuedItemEntry[] {
  const inbox = value as { "next-turn"?: unknown; "next-step"?: unknown } | null | undefined;
  return [
    ...fromInboxList(inbox?.["next-turn"], "queued", false, resolve),
    ...fromInboxList(inbox?.["next-step"], "steering", true, resolve),
  ];
}

/**
 * 旧线格式 `SessionQueuedItem[]` → 队列条目（2026-09-09 之前的服务端；见文件头）。
 */
export function queueItemsFromWire(
  items: unknown[] | undefined,
  resolve?: (rpcId: string | undefined) => QueueOrigin | undefined,
): QueuedItemEntry[] {
  if (!Array.isArray(items)) return [];
  const out: QueuedItemEntry[] = [];
  for (const raw of items) {
    const item = raw as {
      id?: unknown;
      placement?: unknown;
      rpcId?: unknown;
      message?: { content?: unknown };
    } | null;
    if (typeof item?.id !== "string" || !item.id) continue;
    // 只有 `queued` / `steering` 是用户消息；`context` 是插件注入的环境上下文，
    // 不是用户消息，不下发——否则全新会话一开场就会显示一串「排队消息」。
    if (item.placement !== "queued" && item.placement !== "steering") continue;
    out.push(
      entryOf(
        {
          id: item.id,
          placement: item.placement,
          rpcId: typeof item.rpcId === "string" && item.rpcId ? item.rpcId : undefined,
          content: item.message?.content,
        },
        resolve,
      ),
    );
  }
  return out;
}

/**
 * `inbox` 的一个列表 → 条目。
 *
 * `next-step` 要求 `source.kind === 'user'`：这一列里也有插件注入的环境上下文
 * （旧通道把这类标成 `placement:'context'` 并丢弃，语义等价）。缺 source 同样丢弃
 * ——拿不到「是用户消息」的证据就不显示，而不是照显示。
 */
function fromInboxList(
  raw: unknown,
  placement: QueuedMessageView["placement"],
  requireUserSource: boolean,
  resolve?: (rpcId: string | undefined) => QueueOrigin | undefined,
): QueuedItemEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: QueuedItemEntry[] = [];
  for (const value of raw) {
    const message = value as { id?: unknown; source?: unknown; content?: unknown } | null;
    if (typeof message?.id !== "string" || !message.id) continue;
    const source = message.source as { kind?: unknown; rpcId?: unknown } | null | undefined;
    if (requireUserSource && source?.kind !== "user") continue;
    out.push(
      entryOf(
        {
          id: message.id,
          placement,
          rpcId: typeof source?.rpcId === "string" && source.rpcId ? source.rpcId : undefined,
          content: message.content,
        },
        resolve,
      ),
    );
  }
  return out;
}

/** 两条线格式共用的条目级折算：文本 / 附件 / 本地原始输入优先。 */
function entryOf(
  fields: {
    id: string;
    placement: QueuedMessageView["placement"];
    rpcId?: string;
    content: unknown;
  },
  resolve?: (rpcId: string | undefined) => QueueOrigin | undefined,
): QueuedItemEntry {
  const parts = Array.isArray(fields.content) ? fields.content : [];
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
  const origin = resolve?.(fields.rpcId);
  return {
    content: origin?.content ?? parts,
    view: {
      id: fields.id,
      rpcId: fields.rpcId,
      text: origin?.text ?? wireText,
      attachments: origin?.attachments.length,
      hasMedia,
      placement: fields.placement,
    },
  };
}
