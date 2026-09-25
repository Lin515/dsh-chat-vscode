import type { MessageView, PendingMessageView } from "../shared/chat";

/**
 * 乐观回显（`PendingMessageView`）的**行身份、去重与插入位置**。
 *
 * 账本里只有「已经发出去」的那一类（按下发送那一刻 agent 空闲，见 `shared/chat.ts`
 * 的 `PendingMessageView`）：排队 / 插话的那几条**还没发出去**，它们压根不进账本，
 * 界面侧一条都不画——这里也就不需要「画不画」的判据。
 *
 * 这里有四件事，都是纯函数（断言见 `scripts/pendingEcho.test.ts`）：
 *
 * 1. **对话流的行**（`pendingAsMessage`）：复用 `Message` 的用户消息那一支；
 * 2. **去重**（`pendingVisible`）：宿主的 durable 行与回显是同一个身份（`rpcId`），
 *    真实行已经在 `messages` 里时就不再画回显——收回帧晚于落位帧的那一帧里，
 *    两个来源同时在场，全靠这一条不重复；
 * 3. **行身份**（`messageRowKey` / `pendingAsMessage` 的 id）：两边都用 `p:<rpcId>`，
 *    React 因此复用同一个 DOM 节点，交接时不卸载重建（用户报的「闪一下」有一半来自这里）；
 * 4. **插在哪**（`pendingPlacement`）：真实行将来落在哪，回显就插在哪——空闲发送那条
 *    插在本轮助手消息之前（`adapter` 的落位分支同判据）。
 */

/** 回显行 id / React key 的前缀（`p:` + rpcId）。真消息的 id 是 `u:<seq>` / `a:<turn>`，不撞。 */
export const PENDING_ECHO_ID_PREFIX = "p:";

/** 一个提交身份（rpcId）对应的行 key：回显行与 durable 行**共用**它。 */
export function pendingRowKey(rpcId: string): string {
  return `${PENDING_ECHO_ID_PREFIX}${rpcId}`;
}

/**
 * 一条真实消息的 React key：用户消息带 `rpcId` 时用回显那一套 key。
 *
 * 界面上「同一条消息」在交接前后必须是**同一个 key**，否则 React 会卸载旧行、
 * 重建新行：图片重新解码、气泡重新量高，看起来就是那条消息闪了一下。
 */
export function messageRowKey(message: MessageView): string {
  return message.rpcId ? pendingRowKey(message.rpcId) : message.id;
}

/** 一条回显在对话流里的样子（复用用户消息那一支渲染）。 */
export function pendingAsMessage(echo: PendingMessageView): MessageView {
  return {
    id: pendingRowKey(echo.requestId),
    role: "user",
    ts: echo.ts,
    text: echo.text,
    // 用户消息的正文不在 segments 里（见 `MessageView.text` 的注释）
    segments: [],
    rpcId: echo.requestId,
    sendState: echo.status,
    ...(echo.error ? { sendError: echo.error } : {}),
    ...(echo.attachments.length ? { attachments: echo.attachments } : {}),
  };
}

/** `messages` 里已经出现过的提交身份（durable 行带的 `rpcId`）。 */
export function admittedRpcIds(messages: readonly MessageView[]): Set<string> {
  const admitted = new Set<string>();
  for (const message of messages) {
    if (message.rpcId) admitted.add(message.rpcId);
  }
  return admitted;
}

/**
 * 还要画的回显：**已被承认**的那些让位给真实行。
 *
 * 服务端不回 `rpcId` 的老版本上这一条不成立（真实行没有身份可比），那种情况下
 * 宿主按正文兜底收回（见 `controller.retireEchoByText`），最坏也只是多画一帧。
 */
export function pendingVisible(
  messages: readonly MessageView[],
  echoes: readonly PendingMessageView[],
): PendingMessageView[] {
  if (!echoes.length) return [];
  const admitted = admittedRpcIds(messages);
  return echoes.filter((echo) => !admitted.has(echo.requestId));
}

/**
 * 回显在消息表里的插入位置。
 *
 * 按下那一刻 agent 空闲，真实行将来会插在**本轮助手行之前**（`adapter` 的
 * `user/message` 落位分支同判据），所以回显也要插在它之前——否则 `turn/start`
 * 造出助手行的那一瞬，回显会掉到它下方、随后又跳回上方。
 */
export function pendingInsertIndex(messages: readonly MessageView[]): number {
  const last = messages[messages.length - 1];
  // 末尾不是助手消息（还没有本轮、或末尾就是用户消息）：追加即可
  if (!last || last.role !== "assistant") return messages.length;
  // 助手消息上方已经有用户消息了：这一轮的提问在场，回显属于下一轮 → 追加
  const before = messages[messages.length - 2];
  if (before && before.role === "user") return messages.length;
  return messages.length - 1;
}

/**
 * 对话流那几条回显分成两段：`index` 之前插 `before`、末尾追加 `after`。
 *
 * 同段内保持发送先后。
 */
export function pendingPlacement(
  messages: readonly MessageView[],
  echoes: readonly PendingMessageView[],
): { index: number; before: PendingMessageView[]; after: PendingMessageView[] } {
  const index = pendingInsertIndex(messages);
  const before: PendingMessageView[] = [];
  const after: PendingMessageView[] = [];
  for (const echo of echoes) {
    if (index < messages.length) before.push(echo);
    else after.push(echo);
  }
  return { index, before, after };
}
