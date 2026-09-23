/**
 * 会话里的图片**地址 → 字节**（图片右键菜单「保存」的第一步）。
 *
 * 这里刻意不碰 `vscode` API：地址解析、文件名推断都是纯逻辑（可离线断言），
 * 「弹对话框 + 写盘」那一层在 `imageFiles.ts`。分开的实际好处是这一份能在测试里
 * 直接跑——`vscode` 模块只有在扩展宿主里才存在。
 *
 * 地址只认两种（与界面里能画出来的图同源）：
 * - `data:` URL：服务端附件、宿主读回来的本地文件图都是这个形态，直接解码，不碰网络；
 * - `http(s):`：模型写在 markdown 里的外链图。**这不算新增外传面**——同一个地址浏览器
 *   已经按 `img-src https:` 拉过一次了；这里只是把用户**明确点了保存**的那张图再取一遍
 *   字节，好写进他自己选的路径。
 *
 * 反过来说：**不是图片的地址一律拒绝**（`image/` 之外的 MIME、非 base64 的 data URL、
 * 其它 scheme），并且有字节上限与下载超时——地址是模型可控的字符串，不能当可信输入。
 */

/**
 * 单张图的字节上限。
 *
 * 比本地图读取的 8 MB（`LOCAL_IMAGE_MAX_BYTES`）宽松：那张表管「一次读一批图塞进
 * 正文」，条数多、容易累积；这里一次只有用户点的那一张。上限存在只为拦住
 * 「一个几百 MB 的地址把扩展宿主拖垮」。
 */
export const IMAGE_SAVE_MAX_BYTES = 32 * 1024 * 1024;

/** 外链图的下载超时：卡住的地址不该让保存对话框永远不弹。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 媒体类型 → 扩展名（写盘时的文件名用；认不出的一律按 png）。 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

/**
 * `data:` 图片 → 字节（不是图片 / 不是 base64 / 超上限时 undefined）。
 *
 * 载荷可能很大，所以**先按字符串长度粗筛**再解码：一个几百 MB 的 data URL 在
 * 解成 Buffer 之前就该被拦住。
 */
export function readDataUrlImage(src: string): { mimeType: string; bytes: Buffer } | undefined {
  const value = src.trim();
  if (value.length > IMAGE_SAVE_MAX_BYTES * 2) return undefined; // base64 约 4/3 体积，先粗筛
  const match = /^data:([^;,]+)((?:;[^,]*)*),(.*)$/is.exec(value);
  if (!match) return undefined;
  const mimeType = match[1].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) return undefined;
  if (!/;base64/i.test(match[2])) return undefined; // 百分号转义的 data URL 不认（本扩展从不产出）
  const bytes = Buffer.from(match[3], "base64");
  if (!bytes.length || bytes.byteLength > IMAGE_SAVE_MAX_BYTES) return undefined;
  return { mimeType, bytes };
}

/** 地址里的文件名（外链取最后一段、本地路径取 basename）；取不到时 undefined。 */
function fileNameFromSrc(src: string): string | undefined {
  const value = src.split(/[?#]/)[0].trim();
  if (!value) return undefined;
  // `data:` 的「最后一段」是 `;base64,AAAA` 这种载荷，不是文件名——内联图一律走
  // 建议名，给不出就是 `image.<媒体类型>`。
  if (/^data:/i.test(value)) return undefined;
  const segment = value.split(/[\\/]/).pop();
  if (!segment) return undefined;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.trim() || undefined;
  } catch {
    // 转义序列畸形（模型的地址里什么都可能有）：用原样的那一段，总比没有强
    return segment.trim() || undefined;
  }
}

/**
 * 去掉路径与扩展名，留下一个能当文件名的主干（什么都不剩时给空串）。
 *
 * Windows 的非法字符（`<>:"/\|?*`）与控制字符一律剔掉：`<img alt>` 是模型的文案，
 * 带着它们去 `showSaveDialog` 会得到一个写不进去的路径。
 */
function fileNameBase(raw: string | undefined): string {
  if (!raw) return "";
  const withoutPath = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = withoutPath
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 只有扩展名（`.png`）或只有点号时不算名字
  const stem = cleaned
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  return stem.slice(0, 80);
}

/**
 * 保存对话框的默认文件名。
 *
 * 优先级：界面给的建议名（`<img alt>`，用户附件就是原文件名）→ 源地址里的文件名
 * → `image`。**扩展名按真实媒体类型定**，不跟着建议名走：建议名是模型 / 服务端的
 * 文案，它说 `.png` 而字节其实是 jpeg 时照它写，会得到一个打不开的文件。
 */
export function imageFileName(
  suggested: string | undefined,
  mimeType: string,
  src?: string,
): string {
  const extension = MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "png";
  const base = fileNameBase(suggested) || fileNameBase(src ? fileNameFromSrc(src) : undefined);
  return `${base || "image"}.${extension}`;
}

/** 解析地址 → 字节（读不到 / 不是图片 / 超上限时 undefined）。 */
export async function resolveImageBytes(
  src: string,
): Promise<{ mimeType: string; bytes: Buffer } | undefined> {
  const inline = readDataUrlImage(src);
  if (inline) return inline;
  const value = src.trim();
  if (!/^https?:\/\//i.test(value)) return undefined;
  return downloadImage(value);
}

/** 拉一次外链图（超时 / 非 2xx / 不是图片 / 超上限 → undefined）。 */
async function downloadImage(url: string): Promise<{ mimeType: string; bytes: Buffer } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) return undefined;
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("image/")) return undefined;
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > IMAGE_SAVE_MAX_BYTES) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.byteLength > IMAGE_SAVE_MAX_BYTES) return undefined;
    return { mimeType, bytes };
  } catch {
    // 超时 / 网络错误 / DNS：都算「这张图取不回来」，由调用方提示
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
