import { createHash, randomUUID } from "node:crypto";
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

// ---------- 「取回重新编辑」的附件还原 ----------

/**
 * 「取回重新编辑」时要放回输入框的附件（纯折算，控制器只管落地）。
 *
 * 两个来源、一条判据：
 *
 * 1. **本地提交记录**（`submissions`，扩展没重载过）——最权威，含展示名、路径、
 *    上传回执与内联字节，原样还回去即可；
 * 2. **内容块**（本地记录被 TTL / 条数上限淘汰，或扩展重载过）——只有线格式能给的
 *    东西。这里必须区分两种形态，它们的可还原性不同：
 *    - **提交态**（`PromptContentPart`：图片 `{mediaType,data}`、文件 `{receiptId}`）
 *      是 `buildPromptContent` 装出来的，图片字节就在块里；
 *    - **durable 态**（`protocol.ts` 的 `ImageBlock` / `FileBlock`：`attachment{}` 带
 *      `attachmentId`）是服务端落盘后的引用。图片能用 `session/attachment` 换回字节
 *      （与回放同一条通道，见 `pendingImages`）；**文件没有上传回执**——而
 *      `buildPromptContent` 只认回执，造一枚发不出去的文件芯片比不还原更糟，
 *      所以只计数（`unrestorable`），由调用方如实告知用户。
 */
export interface QueueRestorePlan {
  /** 现在就能用的附件（本地记录原样，或提交态内容块里的图片）。 */
  attachments: Attachment[];
  /** 只有 durable 句柄的图片：要经 `session/attachment` 换回字节才算能用。 */
  pendingImages: { attachment: Attachment; attachmentId: string }[];
  /** 还原不出来的附件数量（durable 文件块等）——只有它非 0 才需要提示用户。 */
  unrestorable: number;
}

/** base64 的长度 → 原始字节数（`bytes` 只是芯片上的展示元数据）。 */
function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** 内容块（提交态 / durable 态混在一条通道里）→ 附件还原计划。 */
function restoreFromContent(content: unknown): QueueRestorePlan {
  const plan: QueueRestorePlan = { attachments: [], pendingImages: [], unrestorable: 0 };
  for (const raw of Array.isArray(content) ? content : []) {
    const part = raw as {
      type?: unknown;
      mediaType?: unknown;
      data?: unknown;
      name?: unknown;
      attachment?: {
        attachmentId?: unknown;
        mediaType?: unknown;
        bytes?: unknown;
        name?: unknown;
        width?: unknown;
        height?: unknown;
      };
    } | null;
    if (!part || typeof part !== "object") continue;

    if (part.type === "image") {
      const ref = part.attachment;
      const attachmentId = typeof ref?.attachmentId === "string" && ref.attachmentId ? ref.attachmentId : undefined;
      if (attachmentId) {
        // durable 句柄：字节要另取（`pendingImages`）
        const mediaType = typeof ref?.mediaType === "string" ? ref.mediaType : undefined;
        plan.pendingImages.push({
          attachmentId,
          attachment: {
            id: randomUUID(),
            kind: "image",
            name: typeof ref?.name === "string" && ref.name ? ref.name : "image",
            attachmentId,
            ...(mediaType ? { mediaType } : {}),
            ...(typeof ref?.bytes === "number" ? { bytes: ref.bytes } : {}),
            ...(typeof ref?.width === "number" ? { width: ref.width } : {}),
            ...(typeof ref?.height === "number" ? { height: ref.height } : {}),
          },
        });
        continue;
      }
      if (typeof part.data === "string" && part.data && typeof part.mediaType === "string" && part.mediaType) {
        plan.attachments.push({
          id: randomUUID(),
          kind: "image",
          name: typeof part.name === "string" && part.name ? part.name : "image",
          dataUrl: `data:${part.mediaType};base64,${part.data}`,
          bytes: base64ByteLength(part.data),
          mediaType: part.mediaType,
        });
        continue;
      }
      plan.unrestorable += 1;
      continue;
    }

    // 文件块：durable 态没有回执、提交态没有展示名；而本地记录在场时走的是上面那条
    // 短路（`content ⊆ attachments`），所以这里一律按「还原不了」计数
    if (part.type === "file") plan.unrestorable += 1;
  }
  return plan;
}

/**
 * 队列项的原文与内容块 → 附件还原计划。
 *
 * 本地记录优先：它是全量（内容块里只有真发出去的那些），带展示名与回执；
 * 没有它（重载 / 淘汰）才退回内容块。返回的附件是**副本**——输入框里的那份会被
 * 上传状态就地改写（`setStateForUpload`），不能让它反过来改到提交记录。
 */
export function queueRestoreAttachments(local: readonly Attachment[], content: unknown): QueueRestorePlan {
  if (local.length) {
    return { attachments: local.map((attachment) => ({ ...attachment })), pendingImages: [], unrestorable: 0 };
  }
  return restoreFromContent(content);
}

/**
 * 附件的**肯定身份**（追加还原附件时用它去重）：一条附件可以同时有几个身份，只要
 * **任一**命中就算同一份。
 *
 * 只认有证据的同一性——同 `id`、同上传回执（`receiptId`，一次上传一个句柄）、同
 * durable 句柄（`attachmentId` 是字节 sha256）、图片的实际字节（`dataUrl` 的 sha256）。
 * **刻意不用「名字 + 字节数」或「路径」**：截图常被系统命名为 `image`，同名同大小的
 * 两张不同图不是同一份；路径相同也不等于内容相同（同一个文件改了再传、不同选区，
 * 回执与字节都不一样）。没有证据时**不合并**——按仓库纪律「拿不到证据就不动手」，
 * 少合并只是多一枚芯片，多合并会把用户真正要发的东西吞掉。
 */
export function attachmentIdentities(attachment: Attachment): string[] {
  const keys = [`id:${attachment.id}`];
  if (attachment.kind === "file" && attachment.upload?.status === "ready") {
    keys.push(`receipt:${attachment.upload.receiptId}`);
  }
  if (attachment.attachmentId) keys.push(`ref:${attachment.attachmentId}`);
  if (attachment.kind === "image" && attachment.dataUrl) {
    // 图片字节就是身份：dataUrl 可能很大，取摘要当键（不拿它当字符串拼前缀）
    keys.push(`data:${createHash("sha256").update(attachment.dataUrl).digest("hex")}`);
  }
  return keys;
}

/** 把还原出来的附件追加进已有列表（就地改，按 `attachmentIdentities` 去重）。 */
export function appendRestoredAttachments(list: Attachment[], additions: readonly Attachment[]): void {
  const seen = new Set<string>();
  for (const attachment of list) {
    for (const key of attachmentIdentities(attachment)) seen.add(key);
  }
  for (const attachment of additions) {
    const keys = attachmentIdentities(attachment);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    list.push(attachment);
  }
}
