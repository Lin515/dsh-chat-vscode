import * as vscode from "vscode";
import { parseRemoteFileUri } from "./remoteFileSystem";
import type { EditorReferenceSource } from "./selection";

/** 从普通编辑器取引用来源；diff 两侧即使本身是普通文件 URI，也不是引用入口。 */
export function editorReferenceSource(uri: vscode.Uri, tabInput?: unknown): EditorReferenceSource | undefined {
  if (tabInput instanceof vscode.TabInputTextDiff) {
    const key = uri.toString();
    if (key === tabInput.original.toString() || key === tabInput.modified.toString()) return undefined;
  }
  if (uri.scheme === "file") return { filePath: uri.fsPath };
  // 虚拟 URI 的 path 只有展示用的 basename；原始文件身份取自完整地址。
  const remoteFile = parseRemoteFileUri(uri);
  return remoteFile ? { remoteFile } : undefined;
}
