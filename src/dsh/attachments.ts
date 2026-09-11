import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Attachment } from "../shared/chat";
import { decodeTextFile } from "./textFile";

/**
 * 路径 → 「能不能内嵌」的归类。
 *
 * 刻意与 vscode 无关，这样冒烟/单元测试能直接验证归类结果，不必启动扩展宿主。
 *
 * 判据只有一条：**内容能不能内嵌成消息的一部分**。
 * - 能（合法图片 / 合法 UTF-8 文本且不过大）→ 附件，随消息一起发；
 * - 不能（目录 / 二进制 / 非 UTF-8 / 过大 / 读不出来）→ 只把**路径**给它，
 *   由界面以双引号包裹插到输入框光标处。
 *
 * 为什么不能一律当附件：`kind: "file"` 的发送路径是按 UTF-8 读成文本内联，
 * 对二进制**不会报错**，只会把非法字节静默换成 U+FFFD——于是一段乱码被当成
 * 「文件内容」喂给模型。目录更直接：读它会抛 EISDIR。
 * 判定口径与 dsh 自己的 `read` 工具一致（见 textFile.ts）。
 */

/** 以图片块发送的扩展名 → mediaType（与服务端支持的图片类型对齐）。 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * 可内联文本的大小上限。
 *
 * 与 `controller.buildContextText` 发送时的上限**必须一致**：这里决定了「加进来
 * 时算不算能内嵌」，那里是最后一道防线。两处不一致会让用户看到「加进来时是正常
 * 附件、发出去时却变成一行『过大未内联』」的怪现象。
 */
export const INLINE_TEXT_MAX_BYTES = 512 * 1024;

/** 路径是图片时给出 mediaType，否则 undefined。 */
export function imageMediaTypeFor(path: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? IMAGE_MEDIA_TYPES[match[1].toLowerCase()] : undefined;
}

/** 候选路径是图片吗（用于界面提示与测试）。 */
export function isImagePath(path: string): boolean {
  return imageMediaTypeFor(path) !== undefined;
}

/**
 * 路径是不是目录（stat 失败一律当「不是」，交给后续逻辑按文件处理）。
 *
 * 自动探测而不是只信任调用方：目录被误判成文件时，错误要到发送阶段才以
 * EISDIR 的形式暴露，很难排查。
 */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 不能内嵌时的原因（用于提示与测试断言）。 */
export type PathOnlyReason =
  | "directory"
  | "binary"
  | "not-utf8"
  | "too-large"
  | "unreadable"
  | "image-unsupported";

export type ClassifyOutcome =
  /** 可以内嵌：作为附件随消息发送。 */
  | { kind: "attachment"; attachment: Attachment }
  /** 不能内嵌：只把路径交给用户/模型。 */
  | { kind: "path"; reason: PathOnlyReason };

export interface ClassifyInput {
  path: string;
  /** 附件展示名（图片用 basename，文本用工作区相对路径）。路径型结果不需要。 */
  name: string;
  /** 调用方已知是目录时可显式声明；省略则自行 stat 探测。 */
  directory?: boolean;
  /** 当前模型是否接受图片输入；false 时图片无法内嵌。 */
  acceptsImage: boolean;
  /** 读文件失败时的回调（默认静默）。 */
  onError?: (message: string) => void;
}

/**
 * 归类一个路径。
 *
 * 顺序有讲究：先判目录（否则会去读目录）、再判图片（扩展名即可，不必先读）、
 * 最后才是文本校验（要真读一遍才能确定是不是合法 UTF-8）。
 */
export function classifyPath(input: ClassifyInput): ClassifyOutcome {
  const { path, name, acceptsImage, onError } = input;

  if (input.directory ?? isDirectoryPath(path)) return { kind: "path", reason: "directory" };

  const mediaType = imageMediaTypeFor(path);
  if (mediaType) {
    if (!acceptsImage) return { kind: "path", reason: "image-unsupported" };
    try {
      const bytes = readFileSync(path);
      return {
        kind: "attachment",
        attachment: {
          id: randomUUID(),
          kind: "image",
          name,
          path,
          dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
          bytes: bytes.length,
        },
      };
    } catch (error) {
      onError?.(`读取图片失败 ${path}：${error instanceof Error ? error.message : String(error)}`);
      return { kind: "path", reason: "unreadable" };
    }
  }

  // 非图片：必须真读一遍才能确定能不能当文本内联
  let bytes: Buffer;
  try {
    const stat = statSync(path);
    if (stat.size > INLINE_TEXT_MAX_BYTES) return { kind: "path", reason: "too-large" };
    bytes = readFileSync(path);
  } catch (error) {
    onError?.(`读取文件失败 ${path}：${error instanceof Error ? error.message : String(error)}`);
    return { kind: "path", reason: "unreadable" };
  }

  const decoded = decodeTextFile(bytes);
  if (decoded.kind === "binary") return { kind: "path", reason: "binary" };
  if (decoded.kind === "not-utf8") return { kind: "path", reason: "not-utf8" };

  return { kind: "attachment", attachment: { id: randomUUID(), kind: "file", path, name } };
}

/**
 * 把路径包成可直接粘进输入框的形式：`"C:\path with space\a.exe"`。
 *
 * 用双引号而不是单引号：Windows 路径里单引号合法、双引号非法，所以双引号
 * 不可能与路径本身冲突（无需转义）。
 */
export function quotePath(path: string): string {
  return `"${path}"`;
}

/** 多个路径拼成一段插入文本（空格分隔，各自带引号）。 */
export function formatPathList(paths: string[]): string {
  return paths.map(quotePath).join(" ");
}
