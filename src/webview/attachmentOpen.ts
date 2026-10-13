import type { Attachment } from "../shared/chat";
import { post } from "./bridge";

/**
 * 点一枚附件之后**做什么**（唯一一份打开动作）。
 *
 * 界面只交它手上的**身份**（原文件路径 / 账本里的附件 id / durable 句柄），怎么找到
 * 本地能打开的那个东西是宿主的事——webview 读不了磁盘，也读不了服务端附件存储
 * （解析链见 `dsh/controller.ts` 的 `openAttachment`）。
 *
 * 两个调用点共用这一份分派：输入框草稿芯片（`components/Composer.tsx`）与消息里的
 * 附件芯片（`components/Message.tsx`）。**单击即打开**，不用按修饰键——芯片上原本
 * 没有别的点击动作，编辑器的文件链接习惯在这里不适用。
 *
 * 图片**缩略图**不在此列：它单击出来的是原图浮层（`components/Images.tsx` 的
 * `openImagePreview`），与助手消息、工具行、正文外链的图同一套待遇。放大看是缩略图
 * 最常见的动作，把它改成打开编辑器，等于让用户为了看一眼图去开一个编辑器。
 */
export function openAttachment(attachment: Attachment): void {
  post({
    type: "openAttachment",
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.path ? { path: attachment.path } : {}),
    ...(attachment.id ? { id: attachment.id } : {}),
    ...(attachment.attachmentId ? { attachmentId: attachment.attachmentId } : {}),
    ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
  });
}

/**
 * 这枚附件**可能**打得开吗（界面侧的粗判据，决定要不要给点击与提示）。
 *
 * 认三种身份：原文件路径、durable 句柄、账本里还没结算完的上传（`upload` 在 = 宿主
 * 账本里那一条还在，暂存字节也能落临时副本）。**真拿不拿得到由宿主定**：历史消息里的
 * 文件附件只有服务端副本，点下去会明确提示打不开，而不是静默。
 *
 * 输入框里的草稿芯片不适用这条判据（下发的草稿列表被剥掉了 `dataUrl`，粘贴进来的
 * 截图三个身份一个都不占，可它恰恰是最该点得开的一类）：那些芯片**总是**可点，
 * 由宿主按账本 id 取字节（见 `components/Composer.tsx`）。
 */
export function canOpenAttachment(attachment: Attachment): boolean {
  return Boolean(attachment.path || attachment.attachmentId || attachment.upload || attachment.dataUrl);
}
