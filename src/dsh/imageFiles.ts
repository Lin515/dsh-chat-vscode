import { join } from "node:path";
import * as vscode from "vscode";
import { imageFileName, resolveImageBytes } from "./imageBytes";

/**
 * 「保存图片」的**宿主那一半**：问路径 + 写盘。
 *
 * 界面弹不了系统对话框、也读不了磁盘，所以图片右键菜单的「保存」只把**图片地址原文**
 * 交过来（`shared/ipc.ts` 的 `saveImage`）。地址 → 字节与文件名的推断在
 * `imageBytes.ts`（那份不碰 `vscode`，可以离线断言），这里只剩两件必须由扩展宿主
 * 做的事：`showSaveDialog` 与 `workspace.fs.writeFile`。
 */

/** 保存结果：`failed` 带一句原因，给宿主日志（用户看到的是同一条 toast）。 */
export type SaveImageResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "failed"; reason: string };

/**
 * 解析字节 → 弹保存对话框（默认落在 `defaultDir`）→ 写盘。
 *
 * **取消不算失败**：用户在对话框里按了取消，界面上不该弹任何东西。
 */
export async function saveChatImage(
  src: string,
  name: string | undefined,
  defaultDir: string,
): Promise<SaveImageResult> {
  const image = await resolveImageBytes(src);
  if (!image) {
    return { status: "failed", reason: "图片字节取不回来（地址不支持 / 不是图片 / 下载失败）" };
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(join(defaultDir, imageFileName(name, image.mimeType, src))),
  });
  if (!target) return { status: "cancelled" };
  try {
    await vscode.workspace.fs.writeFile(target, image.bytes);
    return { status: "saved", path: target.fsPath };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "failed", reason: `写盘失败：${detail}` };
  }
}
