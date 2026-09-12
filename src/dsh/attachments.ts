import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Attachment } from "../shared/chat";

/**
 * 路径 → 「附件怎么发」的归类。
 *
 * 刻意与 vscode 无关，这样冒烟/单元测试能直接验证归类结果，不必启动扩展宿主。
 *
 * 判据与官方两条路对齐（见 references.ts 文件头）：
 * - **目录** → 引用（官方靠结尾斜杠标记，模型自己决定要不要 list）；
 * - **图片**（模型接受图片输入）→ 图片内容块（官方同样内联图片字节）；
 * - **其余文件** → 文件附件，选中即**逐字节上传**拿 `receiptId`。
 *   上传路径对字节不做任何假设——二进制、非 UTF-8、任意大小都能传，
 *   所以这里**不读内容**（旧版按 UTF-8 解码 + 512KB 上限是「内联正文」时代的
 *   判据，0.5.0 起正文不再内联，门槛随之移除）；只 stat 确认存在。
 * - **读不出来 / 模型不收图片** → 最后兜底：把带引号的路径插到输入框光标处。
 */

/** 以图片块发送的扩展名 → mediaType（与服务端支持的图片类型对齐）。 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 候选路径是图片吗（用于界面提示与测试）。 */
export function isImagePath(path: string): boolean {
  return imageMediaTypeFor(path) !== undefined;
}

/** 路径是图片时给出 mediaType，否则 undefined。 */
export function imageMediaTypeFor(path: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? IMAGE_MEDIA_TYPES[match[1].toLowerCase()] : undefined;
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

/** 不能做附件时的原因（用于提示与测试断言）。 */
export type PathOnlyReason = "directory" | "unreadable" | "image-unsupported";

export type ClassifyOutcome =
  /** 可以做附件：随消息发送（图片内容块 / 上传后拿 receiptId）。 */
  | { kind: "attachment"; attachment: Attachment }
  /** 不做附件：目录交给引用，读不出来的把路径交给用户。 */
  | { kind: "path"; reason: PathOnlyReason };

export interface ClassifyInput {
  path: string;
  /** 附件展示名（图片用 basename，文本用工作区相对路径）。路径型结果不需要。 */
  name: string;
  /** 调用方已知是目录时可显式声明；省略则自行 stat 探测。 */
  directory?: boolean;
  /** 当前模型是否接受图片输入；false 时图片无法内嵌。 */
  acceptsImage: boolean;
  /** 读取失败时的回调（默认静默）。 */
  onError?: (message: string) => void;
}

/**
 * 归类一个路径。
 *
 * 顺序有讲究：先判目录（目录不做附件）、再判图片（图片要读字节做内容块）、
 * 最后才是普通文件（上传不挑内容，stat 确认存在即可）。
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

  // 普通文件：上传路径按字节发，不读内容（二进制/非 UTF-8/过大都不是障碍）；
  // 只确认文件还在（选择到读取之间被删掉的竞态）
  try {
    statSync(path);
  } catch (error) {
    onError?.(`读取文件失败 ${path}：${error instanceof Error ? error.message : String(error)}`);
    return { kind: "path", reason: "unreadable" };
  }
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

/**
 * 拖放单个文件的字节上限。
 *
 * 拖放走 base64 过线（见 `shared/ipc.ts` 的 `attachBytes`），4/3 的体积放大加上
 * webview RPC 的字符串拷贝，太大就会卡住界面。超限的直接提示改用「添加文件」
 * 按钮——那条路是宿主 `readFileSync`，多大都不经过 webview。
 */
export const DROP_BYTES_LIMIT = 8 * 1024 * 1024;

export interface DroppedBytesInput {
  /** 文件名（webview 侧 `File.name`，只有名字，没有路径）。 */
  name: string;
  bytes: Uint8Array;
  /** 当前模型是否接受图片输入；false 时图片不能内嵌，改走上传。 */
  acceptsImage: boolean;
}

/**
 * 归类一份**只有字节和文件名**的附件（拖放进来的文件没有路径）。
 *
 * 判据与 `classifyPath` 同口径，只是能用的信息更少：
 * - **图片且模型收图** → 图片附件（内容块，与官方内联图片字节一致），
 *   `dataUrl` 由字节直接拼，无需路径；
 * - **其余**（含模型不收图的图片）→ 文件附件，调用方**立即上传字节**
 *   （上传路径按字节发、不挑类型，图片当普通文件上传也比丢掉强——模型仍能用
 *   工具处理它，而"模型不收图"时退回路径文本对拖放根本不可行：没有路径可插）。
 *
 * 刻意不读盘、不引 `vscode`：冒烟测试能直接验证归类结果。
 */
export function classifyDroppedBytes(
  input: DroppedBytesInput,
): { kind: "attachment"; attachment: Attachment } {
  const { name, bytes, acceptsImage } = input;
  const mediaType = imageMediaTypeFor(name);
  if (mediaType && acceptsImage) {
    return {
      kind: "attachment",
      attachment: {
        id: randomUUID(),
        kind: "image",
        name,
        dataUrl: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
        bytes: bytes.length,
      },
    };
  }
  return { kind: "attachment", attachment: { id: randomUUID(), kind: "file", name } };
}
