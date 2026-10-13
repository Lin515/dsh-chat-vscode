import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 「单击打开附件」的**本地落点**：临时副本的命名与落盘、data URL 解码，以及
 * 「附件内容身份 → 本地可打开的那个文件」的索引。
 *
 * 为什么需要临时副本：拖放 / 截图粘贴进来的附件**磁盘上没有对应文件**（webview 只给
 * 字节，见 `shared/ipc.ts` 的 `attachBytes`），而 VS Code 内置的图片预览只认**真实文件
 * URI**——内存里的虚拟文档（`TextDocumentContentProvider`）按文本渲染，一张 PNG 只会是
 * 一片乱码。于是「本地没有原文件」的那一类统一在临时目录里落一份内容寻址的副本，
 * 再用正常的 `file:` URI 打开：图片按图片预览、文本按文本编辑。
 *
 * 这一份刻意不碰 `vscode`：命名、解码、索引都是纯逻辑（可离线断言），「谁来调用、
 * 失败时提示什么」那一层在 `controller.openAttachment`。临时目录由调用方给
 * （`os.tmpdir()`），写盘走 `node:fs`，测试里换成自己的目录即可。
 */

/** 临时副本所在的目录名（挂在系统临时目录下，不进工作区）。 */
export const ATTACHMENT_TEMP_DIR = "dsh-chat-attachments";

/**
 * 单份临时副本的字节上限。
 *
 * 接入侧的图片内联上限是 64 MB（服务端 `maxImagePixels` 那一套之前会先量字节），
 * 路径通道的图片也照此判据落账，所以这里取同一量级兜住「一个畸形 data URL 把宿主
 * 拖垮」——它是我们自己账本里的字符串，但仍然给个上限。
 */
export const ATTACHMENT_TEMP_MAX_BYTES = 64 * 1024 * 1024;

/** 内容寻址目录的摘要前缀长度：够区分同一临时目录里的几百份副本。 */
const DIGEST_PREFIX = 12;

/** 媒体类型 → 扩展名（名字给不出扩展名时补一个；认不出的一律不补）。 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "text/plain": "txt",
  "application/json": "json",
  "application/pdf": "pdf",
};

/** 临时副本的根目录（系统临时目录 + 固定子目录）。 */
export function attachmentTempRoot(tmpdir: string): string {
  return join(tmpdir, ATTACHMENT_TEMP_DIR);
}

/** 名字主干的长度上限（与服务器侧的叶子名上限同量级，避免超长名建不出文件）。 */
const MAX_NAME_CHARS = 120;

/**
 * 附件展示名 → 能落盘的**叶子名**。
 *
 * 与服务器侧的 `fileLeafName` 同一套考虑：两种分隔符都要亲手剥（Windows 的名字到了
 * POSIX 上 `\` 只是普通字符，`basename` 会把整条路径留下），Windows 拒绝的字符换成
 * `_`，结尾的点与空格去掉（Windows 建不出这样的文件）。
 */
export function safeAttachmentFileName(name: string, mediaType?: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  let clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/u, "");
  if (clean === "" || clean === "." || clean === "..") clean = "attachment";
  clean = clean.slice(0, MAX_NAME_CHARS).replace(/[. ]+$/u, "");
  if (clean === "") clean = "attachment";
  // 名字里没有扩展名时按媒体类型补一个：VS Code 靠扩展名挑编辑器，`image` 这种
  // 名字（服务端图片句柄的缺省名）不给扩展名就只会打开成二进制。
  if (!/\.[a-z0-9]+$/i.test(clean)) {
    const extension = mediaType ? MIME_EXTENSIONS[mediaType.toLowerCase()] : undefined;
    if (extension) clean = `${clean}.${extension}`;
  }
  return clean;
}

/** 临时副本的绝对路径：`<root>/<摘要前 12 位>/<叶子名>`（同名不同内容因此不撞）。 */
export function attachmentTempPath(root: string, sha256: string, name: string, mediaType?: string): string {
  return join(root, sha256.slice(0, DIGEST_PREFIX), safeAttachmentFileName(name, mediaType));
}

/**
 * `data:` URL → 字节（不是 base64 / 载荷超上限时 undefined）。
 *
 * 只认 base64：本扩展自己产出的 data URL 全是这个形态（`readFileSync(...).toString("base64")`），
 * 百分号转义的那种不认。
 */
export function parseBase64DataUrl(
  dataUrl: string,
  maxBytes: number = ATTACHMENT_TEMP_MAX_BYTES,
): { bytes: Buffer; mediaType: string } | undefined {
  const value = dataUrl.trim();
  // base64 约 4/3 体积：先按字符串长度粗筛，别把几百 MB 的串解成 Buffer 才判超限
  if (!value || value.length > maxBytes * 2) return undefined;
  const match = /^data:([^;,]+)((?:;[^,]*)*),(.*)$/is.exec(value);
  if (!match) return undefined;
  if (!/;base64/i.test(match[2])) return undefined;
  const bytes = Buffer.from(match[3], "base64");
  if (!bytes.length || bytes.byteLength > maxBytes) return undefined;
  return { bytes, mediaType: match[1].trim().toLowerCase() };
}

/** 字节的内容摘要（与服务器的文件附件 id 同口径：sha256 的十六进制）。 */
export function contentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 把一份字节落成临时副本，返回它的绝对路径。
 *
 * **内容寻址**：路径只由字节摘要与叶子名决定，同一份内容重复点开只会写一次（第二次
 * 命中已有文件直接返回）。已存在但内容不同不可能发生——摘要就在路径里。
 */
export async function materializeAttachment(input: {
  root: string;
  bytes: Uint8Array;
  name: string;
  mediaType?: string;
}): Promise<string> {
  const digest = contentDigest(input.bytes);
  const path = attachmentTempPath(input.root, digest, input.name, input.mediaType);
  if (await exists(path)) return path;
  await mkdir(join(input.root, digest.slice(0, DIGEST_PREFIX)), { recursive: true });
  await writeFile(path, input.bytes);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 「附件内容身份 → 本地能打开的那个文件」。
 *
 * 两份来源都记在这里，因为它们对「打开」是同一件事：
 * - 路径通道进来的附件：记**原文件路径**（打开的就是用户自己那个文件，不是拷贝）；
 * - 字节通道进来的附件：上传成功那一刻留的临时副本路径。
 *
 * 键是 durable 句柄（`sha256:…`），所以**回放的消息**（只有内容块里的句柄）也能命中
 * ——只要那份附件是这套扩展上传的。查不到就退回线上换字节（图片）或明确说打不开。
 *
 * `limit` 是唯一的清理路径：越过就丢最旧的一条（只丢索引，**不删临时文件**——那可能
 * 正开在编辑器里，且临时目录本来就归系统清理）。语义上丢一条的后果只是「这枚附件
 * 要重新从线上取字节」，不会丢用户数据。
 */
export class AttachmentOpenIndex {
  private readonly targets = new Map<string, string | Promise<string | undefined>>();

  constructor(private readonly limit: number = 256) {}

  /** 记下一条：`target` 可以是现成的路径，也可以是「正在落盘」的承诺（按需等待）。 */
  remember(id: string, target: string | Promise<string | undefined>): void {
    this.targets.delete(id);
    this.targets.set(id, target);
    while (this.targets.size > this.limit) {
      const oldest = this.targets.keys().next().value;
      if (oldest === undefined) break;
      this.targets.delete(oldest);
    }
  }

  /** 取一条：还在落盘就等它；落盘失败（undefined）顺手丢掉这条索引。 */
  async pathFor(id: string): Promise<string | undefined> {
    const target = this.targets.get(id);
    if (target === undefined) return undefined;
    const path = typeof target === "string" ? target : await target.catch(() => undefined);
    if (!path) {
      this.targets.delete(id);
      return undefined;
    }
    return path;
  }

  /** 索引里的条数（离线断言用）。 */
  get size(): number {
    return this.targets.size;
  }
}
