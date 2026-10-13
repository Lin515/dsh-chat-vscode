/**
 * 图片**头部**里的固有宽高：不解码整图，只读前几十字节。
 *
 * ## 为什么需要它
 *
 * 服务端的图片准入里有一条**像素**上限（`maxImagePixels`，默认 64,000,000 = 宽 × 高）
 * 和一条**单边**上限（`maxImageDimension`，默认 8192）。它们与文件大小无关：PNG 对
 * UI 截图、大片纯色的压缩率极高，一张 8192×8192（67.1M 像素）的截图压到 5～6 MB
 * 很常见。本扩展此前只消费了 `maxImageBytes`，于是这类图能一路内联成内容块发出去，
 * 直到服务端在提交时整批拒掉（`session/attachment-invalid`），用户看到的是一句
 * 英文原文报错（2026-10-13 用户实测：5.64 MB 的图报
 * "Image exceeds the configured decoded-pixel limit."）。
 *
 * 准入要在**接入那一刻**做完，所以需要宽高；而为了宽高去解码整图（服务端用 sharp）
 * 在扩展宿主里既没有依赖、也不值得——四种允许的格式（png / jpeg / webp / gif）的
 * 尺寸都在**固定偏移**上，读头部足够。
 *
 * ## 拿不到就放行
 *
 * 格式不认识、字节被截断、字段非法（0 边长）时返回 `undefined`，调用方**不拦**——
 * 判据按肯定证据写：宁可让服务端去拒，也不要凭一个猜出来的尺寸误伤正常图片。
 * 调用方据此记一条日志，好让「为什么这张图没被本地拦住」有据可查。
 */

/** 一张图片的固有尺寸（像素）。 */
export interface ImageSize {
  width: number;
  height: number;
}

/** PNG 的 8 字节签名。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * 从图片字节的头部读出宽高；读不出来（格式不支持 / 字节截断 / 字段非法）给 `undefined`。
 *
 * 只读头部，**不校验**图片内容是否完整（那是服务端解码时的事）：这里只需要尺寸，
 * 而「能不能解码」由服务端与它自己的错误码回答。
 */
export function imageSizeOf(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes);
}

/** PNG：签名之后第一个块必须是 IHDR，宽高是它紧接着的两个大端 32 位。 */
function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24) return undefined;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return undefined;
  }
  if (ascii(bytes, 12, 4) !== "IHDR") return undefined;
  return checked(uint32be(bytes, 16), uint32be(bytes, 20));
}

/**
 * JPEG：从 `FF D8` 起逐个段跳过，直到某个 SOF 段（`FF C0`–`FF CF`，但 `C4` 是 DHT、
 * `C8` 是 JPG、`CC` 是 DAC）——它的载荷里第 1 字节是精度、接着 2 字节高、2 字节宽。
 *
 * 走到扫描数据（`FF DA`）还没见到 SOF 就放弃：那是渐进式的续段，头部里没有尺寸。
 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // 无长度字段的段（TEM / RSTn）
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = uint16be(bytes, offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return checked(uint16be(bytes, offset + 7), uint16be(bytes, offset + 5));
    }
    offset += 2 + length;
  }
  return undefined;
}

/** GIF：`GIF87a` / `GIF89a` 之后就是两个小端 16 位的逻辑屏幕宽高。 */
function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined;
  const header = ascii(bytes, 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return undefined;
  return checked(uint16le(bytes, 6), uint16le(bytes, 8));
}

/**
 * WebP：`RIFF….WEBP` 之后第一个块有三种，尺寸位置各不相同。
 *
 * - `VP8X`（扩展格式）：`flags(4) + reserved(3)` 之后是两个 24 位小端的「边长 − 1」；
 * - `VP8L`（无损）：`0x2F` 签名之后 32 位里打包着两个 14 位的「边长 − 1」；
 * - `VP8 `（有损）：3 字节帧标签 + `9D 01 2A` 起始码之后，两个 14 位小端边长。
 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) return undefined;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") return checked(uint24le(bytes, 24) + 1, uint24le(bytes, 27) + 1);
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return undefined;
    const packed = uint32le(bytes, 21);
    return checked((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return checked(uint16le(bytes, 26) & 0x3fff, uint16le(bytes, 28) & 0x3fff);
  }
  return undefined;
}

/** 0 边长在四种格式里都不是合法图像：与其拿它去算像素，不如当读不出来。 */
function checked(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index]!);
  return text;
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}
