/**
 * `src/dsh/imageSize.ts` 的离线断言：四种图片格式的头部宽高解析。
 *
 * 这一份的价值在**边界的可控**：真实图片很难随手造出「8192×8192 但只有几 MB」
 * 与「SOF 段前面压着 APP0」这类形状，而实现只读几十字节的头，所以测试直接造头。
 * 顺带钉住「读不出来就返回 undefined」（调用方据此**不拦**那张图）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { imageSizeOf } from "../src/dsh/imageSize";

/** 把 ASCII 串写成字节（测试里造头用）。 */
function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function writeUint16be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint16le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeUint24le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

function writeUint32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUint32le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeUint32be(bytes, 8, 13);
  bytes.set(ascii("IHDR"), 12);
  writeUint32be(bytes, 16, width);
  writeUint32be(bytes, 20, height);
  return bytes;
}

function jpegHeader(width: number, height: number, app0 = false): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (app0) parts.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00);
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08);
  parts.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  parts.push(0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00);
  return new Uint8Array(parts);
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(ascii("GIF89a"), 0);
  writeUint16le(bytes, 6, width);
  writeUint16le(bytes, 8, height);
  return bytes;
}

function webpHeader(chunk: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(ascii("RIFF"), 0);
  bytes.set(ascii("WEBP"), 8);
  bytes.set(ascii(chunk), 12);
  if (chunk === "VP8X") {
    writeUint24le(bytes, 24, width - 1);
    writeUint24le(bytes, 27, height - 1);
  } else if (chunk === "VP8L") {
    bytes[20] = 0x2f;
    writeUint32le(bytes, 21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14));
  } else {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    writeUint16le(bytes, 26, width);
    writeUint16le(bytes, 28, height);
  }
  return bytes;
}

// ---------- 1. 四种格式 ----------

assert.deepStrictEqual(imageSizeOf(pngHeader(8192, 8192)), { width: 8192, height: 8192 }, "PNG 的 IHDR");
assert.deepStrictEqual(imageSizeOf(pngHeader(1, 1)), { width: 1, height: 1 }, "PNG 的最小尺寸");
assert.deepStrictEqual(imageSizeOf(jpegHeader(640, 480)), { width: 640, height: 480 }, "JPEG 的 SOF 段");
assert.deepStrictEqual(
  imageSizeOf(jpegHeader(4000, 3000, true)),
  { width: 4000, height: 3000 },
  "SOF 前面压着 APP0 时要跳过它继续找（真实照片几乎都有 EXIF/JFIF 段）",
);
assert.deepStrictEqual(imageSizeOf(gifHeader(320, 200)), { width: 320, height: 200 }, "GIF 的逻辑屏幕");
assert.deepStrictEqual(imageSizeOf(webpHeader("VP8X", 7000, 5000)), { width: 7000, height: 5000 }, "WebP VP8X");
assert.deepStrictEqual(imageSizeOf(webpHeader("VP8L", 16384, 3)), { width: 16384, height: 3 }, "WebP VP8L（打包 14 位）");
assert.deepStrictEqual(imageSizeOf(webpHeader("VP8 ", 1920, 1080)), { width: 1920, height: 1080 }, "WebP VP8 有损");
console.log("imageSize: 四种格式的头部读数 ✓");

// ---------- 2. 读不出来就返回 undefined（调用方据此放行） ----------

assert.strictEqual(imageSizeOf(new Uint8Array(0)), undefined, "空字节");
assert.strictEqual(imageSizeOf(pngHeader(10, 10).subarray(0, 20)), undefined, "截断的 PNG 头");
assert.strictEqual(imageSizeOf(pngHeader(0, 10)), undefined, "0 宽不是合法图像");
assert.strictEqual(imageSizeOf(gifHeader(10, 0)), undefined, "0 高不是合法图像");
assert.strictEqual(imageSizeOf(jpegHeader(10, 10).subarray(0, 6)), undefined, "截断的 JPEG 头");
assert.strictEqual(
  imageSizeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
  undefined,
  "到了扫描数据还没见到 SOF —— 头部里没有尺寸，不猜",
);
assert.strictEqual(imageSizeOf(webpHeader("VP8 ", 10, 10).subarray(0, 22)), undefined, "截断的 WebP");
assert.strictEqual(
  imageSizeOf(new Uint8Array([...ascii("BM"), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
  undefined,
  "不认识的格式（BMP 不在服务端允许的媒体类型里）",
);
console.log("imageSize: 读不出来一律 undefined（拿不到就不拦）✓");

console.log("\nimageSize: all assertions passed");
