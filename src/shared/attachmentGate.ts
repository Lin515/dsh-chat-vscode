import type { Attachment } from "./chat";

/**
 * 文件附件是否**已经可以发送**（会进 prompt）。
 *
 * 唯一判据是上传回执：`buildPromptContent` 按它装配内容块，发送门也按它决定按钮与
 * 宿主兜底——两处必须同源，否则会出现「界面说能发、宿主把文件丢了」或反过来。
 * 图片不参与（内联字节，不走上传；见 `docs/design-attachments.md`）。
 */
export function fileAttachmentReady(attachment: Attachment): boolean {
  return attachment.kind !== "file" || attachment.upload?.status === "ready";
}

/** 这批附件里让发送停下来的原因：`uploading` = 还在传，`error` = 传失败（须重试或移除）。 */
export type AttachmentUploadBlock = "uploading" | "error";

/**
 * 发送门：文件附件里有未就绪的就返回原因，全就绪或没有文件附件时返回 `undefined`。
 *
 * 只要有一枚失败就报 `error`（失败需要用户动作，优先于仍在传的提示）；同一枚附件
 * 最多一轮上传，状态只会是 uploading / ready / error，不存在第四种。
 */
export function attachmentUploadBlock(
  attachments: readonly Attachment[],
): AttachmentUploadBlock | undefined {
  let uploading = false;
  for (const attachment of attachments) {
    if (fileAttachmentReady(attachment)) continue;
    if (attachment.upload?.status === "error") return "error";
    uploading = true;
  }
  return uploading ? "uploading" : undefined;
}
