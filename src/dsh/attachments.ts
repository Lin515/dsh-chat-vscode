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
 * - **图片**（模型接受图片输入）→ 图片内容块；
 * - **其余文件** → 文件附件，选中即**逐字节上传**拿 `receiptId`。
 *
 * ## 为什么**不**判断「文件可不可读」「文件大不大」
 *
 * 曾经按「模型能不能直接读这段字节」分派（二进制 / 非 UTF-8 / 过大 → 只给路径），
 * 理由是「给模型读不出的字节没意义」。**那是错的**，用户在 Web 端实测（上传一个
 * exe）推翻了它：
 *
 * - 官方客户端**完全不筛**：`dsh-client-file-upload` 只做 base64 / 流式上传两件事，
 *   没有任何按类型或大小的判据（`lib/types/client/runtime.js` 的 `upload()`）；
 * - 官方在上下文里也**从不放文件字节**——`session/prompt` 只带
 *   `{type:'file', receiptId}`，宿主把 receipt 解析成 `FileAttachmentRef`
 *   （`dsh-attachment/lib/types/types.d.ts`：`attachmentId` **就是字节的 sha256**，
 *   外加 `bytes` 与显示名），模型看到的是「路径 + 大小 + sha256 前缀」这个**引用**，
 *   字节原样落到 attachments 目录。
 *
 * 所以「exe 没有进上下文」不是后台做了过滤，而是**所有文件都不进上下文**；上传出来
 * 的那份只读副本 + 内容寻址 id 对模型反而有用（它可以用工具去处理那个副本、核对
 * sha256）。扩展自己那一层筛子只会让同一个文件在 Web 上是「已上传的引用」、在扩展
 * 里变成一串裸路径文本，属于自造差异。
 *
 * 唯一真实的准入限制在**图片**那条路上（官方 `IMAGE_ADMISSION_ERROR_CODES`：
 * 类型 / 张数 / 字节 / 像素上限）——那由宿主校验，并把限额经 `imageLimits` 投影
 * 下发（本扩展已消费）；这里只需按「模型收不收图」决定走内容块还是走上传。
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
  /**
   * 图片**内联**上限（字节）：超过它就不读字节、改按普通文件上传。
   *
   * 为什么要有：图片走的是「读成字节 → base64 → 内容块」，`readFileSync` 是**同步**的
   * 且 base64 再胀 4/3——一张几百 MB 的图会把扩展宿主冻住并把内存顶爆，而服务端
   * 本来也会按自己的 `maxImageBytes` 拒绝它（那份上限由 `imageLimits` 投影给出，
   * 界面侧由调用方传入；缺省时调用方给一个保守的硬上限）。
   */
  maxImageBytes?: number;
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
      // 先量大小再读字节：超大图不进内容块，改按普通文件上传（调用方据此提示原因）
      const size = statSync(path).size;
      if (input.maxImageBytes !== undefined && size > input.maxImageBytes) {
        onError?.(`图片超过内联上限（${size} > ${input.maxImageBytes} 字节），改按文件上传：${path}`);
        return { kind: "attachment", attachment: { id: randomUUID(), kind: "file", path, name } };
      }
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

  // 普通文件：上传路径按字节发，不读内容（二进制 / 非 UTF-8 / 过大都不是障碍）；
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
 * 按钮——那条路是宿主 `readFileSync` + 原始字节 POST，不经过 webview。
 *
 * 这条限制**只关于 webview 这条通道**，不是「附件判据」：回形针 / 资源管理器
 * 右键那条路不限大小（官方也不限）。
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
