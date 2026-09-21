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
 * webview 字节通道（拖放 / 粘贴）的单文件上限。
 *
 * 那条路走 base64 过线（见 `shared/ipc.ts` 的 `attachBytes`），4/3 的体积放大加上
 * webview RPC 的字符串拷贝，太大就会卡住界面。超限的直接提示改用「添加文件」
 * 按钮——那条路是宿主 `readFileSync` + 原始字节 POST，不经过 webview。
 *
 * 这条限制**只关于 webview 这条通道**，不是「附件判据」：回形针 / 资源管理器
 * 右键那条路不限大小（官方也不限）。
 */
export const ATTACH_BYTES_LIMIT = 8 * 1024 * 1024;

/**
 * 一个条目的**图片判据**：有浏览器 MIME 就先认 MIME，没有才退回文件名后缀。
 *
 * 为什么两套：官方在浏览器里判图只认 MIME（`isImageMediaType(file.type)`，见
 * `packages/client/ui-conversation/src/client/service.ts:597-600`），扩展的**路径**
 * 那条路拿不到 MIME（VS Code 的文件对话框只给路径），只能看后缀；而拖放 / 粘贴
 * 这条路 webview 手上**有** `File.type`，丢掉了就会与官方分道扬镳（`shot.jfif`、
 * 后缀与 MIME 不一致的条目会归类不同）。所以帧里带上 `mimeType`，这里优先采信。
 *
 * 只认官方那张表（png / jpeg / webp / gif）：MIME 说是 `image/bmp`、`image/svg+xml`
 * 的一律**当普通文件上传**——官方同样不把它们当图片（`imageMediaType` 对表外的值
 * 直接抛 `UnsupportedImageMediaTypeError`），这条不能放宽。
 */
export function imageMediaTypeForEntry(mimeType: string | undefined, name: string): string | undefined {
  if (mimeType) {
    const normalized = mimeType.split(";", 1)[0]!.trim().toLowerCase();
    for (const accepted of Object.values(IMAGE_MEDIA_TYPES)) {
      if (accepted === normalized) return accepted;
    }
    // MIME 在表外（哪怕是别的 image/*）：按**文件**走，不再看后缀——
    // 否则一个 `a.png` 的文本文件会被当成图片内联，提交时被服务端整批拒掉
    if (normalized) return undefined;
  }
  return imageMediaTypeFor(name);
}

export interface DroppedBytesInput {
  /** 文件名（webview 侧 `File.name`，只有名字，没有路径）。 */
  name: string;
  bytes: Uint8Array;
  /** 当前模型是否接受图片输入；false 时图片不能内嵌，改走上传。 */
  acceptsImage: boolean;
  /** 浏览器声明的 MIME（`File.type`），可能与后缀不一致；有就优先采信。 */
  mimeType?: string;
  /** 图片**内联**上限（字节）：超过它就不内联、改按普通文件上传（与 `classifyPath` 同口径）。 */
  maxImageBytes?: number;
  /** 读取 / 降级原因的回调（默认静默）。 */
  onError?: (message: string) => void;
}

export interface DroppedBytesOutcome {
  kind: "attachment";
  attachment: Attachment;
  /** 图片超过内联上限、已改按文件上传（调用方据此提示，与路径通道同一条文案）。 */
  degraded?: "image-over-limit";
}

/**
 * 归类一份**只有字节和文件名**的附件（拖放 / 剪贴板里没有真路径的那些）。
 *
 * 判据与 `classifyPath` 同口径，只是信息更少：
 * - **图片且模型收图** → 图片附件（内容块，与官方内联图片字节一致），
 *   `dataUrl` 由字节直接拼，无需路径；超过 `maxImageBytes` 则**降级为文件上传**
 *   （与路径通道一样，不能让一张超大图以内联块发出去、到提交时被服务端整批拒）；
 * - **其余**（含模型不收图的图片）→ 文件附件，调用方**立即上传字节**
 *   （上传路径按字节发、不挑类型，图片当普通文件上传也比丢掉强——模型仍能用
 *   工具处理它，而"模型不收图"时退回路径文本对这两条路根本不可行：没有路径可插）。
 *
 * 刻意不读盘、不引 `vscode`：冒烟测试能直接验证归类结果。
 */
export function classifyDroppedBytes(input: DroppedBytesInput): DroppedBytesOutcome {
  const { name, bytes, acceptsImage, mimeType } = input;
  const mediaType = imageMediaTypeForEntry(mimeType, name);
  if (mediaType && acceptsImage) {
    if (input.maxImageBytes !== undefined && bytes.length > input.maxImageBytes) {
      input.onError?.(
        `图片超过内联上限（${bytes.length} > ${input.maxImageBytes} 字节），改按文件上传：${name}`,
      );
      return {
        kind: "attachment",
        attachment: { id: randomUUID(), kind: "file", name },
        degraded: "image-over-limit",
      };
    }
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

/**
 * 一个待接入的条目：**路径**（按钮 / 粘贴拿到的真路径）或**字节**（拖放 / 剪贴板位图）。
 *
 * 这是三个入口唯一的输入形态——它们只是同一件事的不同来源，所以接入必须只有一份
 * 实现（见 `planIntake`）。`name` 由调用方按各自的显示口径给出（图片与目录取
 * basename，其余取工作区相对路径，见 controller 的 `attachmentName`）。
 */
export type IntakeItem =
  | { from: "path"; path: string; name: string; directory?: boolean }
  | { from: "bytes"; name: string; bytes: Uint8Array; mimeType?: string };

/** 这一批里没进来的条目（界面已判出来的，以及宿主自己判出来的）。 */
export interface IntakeRejection {
  name: string;
  /** `unreadable`：目录条目（拖放不支持）/ 0 字节 / 读不出来；`too-large`：超过字节通道上限。 */
  reason: "unreadable" | "too-large";
}

export interface IntakePlanInput {
  items: readonly IntakeItem[];
  /** 当前模型是否接受图片输入；false 时图片不内联。 */
  acceptsImage: boolean;
  /** 图片内联上限（缺省时调用方给一个保守硬上限）。 */
  maxImageBytes?: number;
  /** 已经在附件列表里的路径：**路径项**按它去重（同一份文件加两次没有意义）。 */
  existingPaths?: readonly string[];
  /** 目录探测（默认 `isDirectoryPath`，测试可注入）。 */
  directory?: (path: string) => boolean;
  /** 界面侧已经判掉的条目（0 字节目录条目、超 8 MB 的文件）。 */
  rejected?: readonly IntakeRejection[];
  onError?: (message: string) => void;
}

/** 一份附件的上传来源：有路径的重读磁盘，只有字节的用手上这一份。 */
export interface IntakeUpload {
  id: string;
  source: { kind: "path"; path: string } | { kind: "bytes"; bytes: Uint8Array };
}

export interface IntakePlan {
  /** 新增的附件（文件带 upload 状态由调用方随后写入；图片已内联成 data URL）。 */
  attachments: Attachment[];
  /** 需要立即上传的文件附件。 */
  uploads: IntakeUpload[];
  /** 目录 → 调用方插 `@dir/` **引用**（附件列表里不出现目录）。 */
  directories: string[];
  /** 读不出来 / 模型不收图 → 调用方把带引号的路径插进正文（最后一道兜底）。 */
  pathOnly: string[];
  /** 没进来的条目（含界面报来的）。 */
  rejected: IntakeRejection[];
  /** 图片超过内联上限、已改按文件上传（提示用）。 */
  degradedImages: string[];
  /** 模型不收图的图片条数（调用方提示「路径已插入」用）。 */
  unsupportedImages: number;
}

/**
 * 三个入口（添加文件 / 拖放 / 粘贴）**唯一**的接入决策：条目 → 附件 / 目录引用 / 拒绝。
 *
 * 为什么收成一个纯函数：路径与字节两条路曾经各写一遍（分类、上限、去重、提示都各一套），
 * 于是漂移出了真 BUG——字节通道的附件没有 `path`，发送装配按 `path` 过滤，
 * 上传成功的文件**根本没进 prompt**（2026-09-21）。同一件事只留一份实现，
 * 这类漂移就没有落脚点。
 *
 * 判据（与官方一致）：
 * - **目录** → 引用（官方靠结尾斜杠标记，模型自己决定要不要 list）；
 * - **图片**（模型收图、且不超内联上限）→ 图片附件；
 * - **其余** → 文件附件 + 立即上传；
 * - 读不出来 / 模型不收图 → 路径文本兜底（字节条目没有路径可插，只能上传）。
 *
 * 不读 vscode、不写界面：调用方负责把结果落到视图上。
 */
export function planIntake(input: IntakePlanInput): IntakePlan {
  const isDirectory = input.directory ?? isDirectoryPath;
  const plan: IntakePlan = {
    attachments: [],
    uploads: [],
    directories: [],
    pathOnly: [],
    rejected: [...(input.rejected ?? [])],
    degradedImages: [],
    unsupportedImages: 0,
  };
  const seen = new Set(input.existingPaths ?? []);

  for (const item of input.items) {
    if (item.from === "bytes") {
      // 0 字节条目读不出内容（复制目录时 Chromium 给的就是这种），界面上游已拦，
      // 宿主这一侧再拦一道：按 base64 长度判到的超大条目同样在这里拒绝
      if (item.bytes.length === 0) {
        plan.rejected.push({ name: item.name, reason: "unreadable" });
        continue;
      }
      const outcome = classifyDroppedBytes({
        name: item.name,
        bytes: item.bytes,
        mimeType: item.mimeType,
        acceptsImage: input.acceptsImage,
        maxImageBytes: input.maxImageBytes,
        onError: input.onError,
      });
      plan.attachments.push(outcome.attachment);
      if (outcome.attachment.kind === "file") {
        plan.uploads.push({ id: outcome.attachment.id, source: { kind: "bytes", bytes: item.bytes } });
        if (outcome.degraded === "image-over-limit") plan.degradedImages.push(item.name);
      }
      continue;
    }

    // 附件按路径去重；路径型结果（目录引用、兜底路径文本）不去重——
    // 用户每次明确选择都应该在光标处再插一份
    if (seen.has(item.path)) continue;
    seen.add(item.path);

    if (item.directory ?? isDirectory(item.path)) {
      plan.directories.push(item.path);
      continue;
    }

    const outcome = classifyPath({
      path: item.path,
      name: item.name,
      acceptsImage: input.acceptsImage,
      maxImageBytes: input.maxImageBytes,
      onError: input.onError,
    });
    if (outcome.kind === "attachment") {
      plan.attachments.push(outcome.attachment);
      if (outcome.attachment.kind === "file") {
        plan.uploads.push({ id: outcome.attachment.id, source: { kind: "path", path: item.path } });
        if (imageMediaTypeFor(item.path)) plan.degradedImages.push(item.name);
      }
      continue;
    }
    plan.pathOnly.push(item.path);
    if (outcome.reason === "image-unsupported") plan.unsupportedImages++;
  }
  return plan;
}

/** 随 prompt 发出的内容块（官方 `PromptContentPart` 的三态）。 */
export type PromptContentPart =
  | { type: "file"; receiptId: string }
  | { type: "image"; mediaType: string; data: string; name: string }
  | { type: "text"; text: string };

export interface PromptContentPlan {
  content: PromptContentPart[];
  /** 没能随消息发出的文件附件（上传中 / 失败 / 没有回执）——调用方要提示用户。 */
  notUploaded: string[];
  /** 表示不出来而被丢掉的（图片没有可解析的 data URL）——调用方至少记日志。 */
  dropped: string[];
}

/**
 * 把「正文 + 附件列表」装配成 prompt 的内容块。
 *
 * **官方的顺序**：`content = [...attachments, text]`，且附件之间保持列表顺序
 * （`packages/client/ui-conversation/src/client/service.ts:259-263`、`:288`）——
 * 所以这里一趟遍历、按附件顺序出块，`text` 块永远在最后。
 *
 * 文件附件只看**上传回执**，不看有没有路径：拖放 / 粘贴进来的字节附件没有 `path`，
 * 早先那道 `!attachment.path` 的门会把它们整批丢掉（上传照做、prompt 里却没有），
 * 而且因为同一道门连"没传上去"的提示都不会发。回执才是唯一判据。
 */
export function buildPromptContent(
  text: string,
  attachments: readonly Attachment[],
): PromptContentPlan {
  const content: PromptContentPart[] = [];
  const notUploaded: string[] = [];
  const dropped: string[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "file") {
      if (attachment.upload?.status === "ready") {
        content.push({ type: "file", receiptId: attachment.upload.receiptId });
      } else {
        notUploaded.push(attachment.name);
      }
      continue;
    }
    if (attachment.kind === "image") {
      const match = attachment.dataUrl ? /^data:([^;]+);base64,(.*)$/.exec(attachment.dataUrl) : null;
      if (match) content.push({ type: "image", mediaType: match[1]!, data: match[2]!, name: attachment.name });
      else dropped.push(attachment.name);
    }
  }

  const body = text.trim();
  if (body) content.push({ type: "text", text: body });
  return { content, notUploaded, dropped };
}
