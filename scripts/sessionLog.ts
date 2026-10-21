/**
 * 【探针定位】工具型 · 零 token —— 被 sessionLogScan 等探针 import 的解码库
 *   （非 CLI），可自由使用。
 *
 * 会话日志解码（多帧 zstd → JSONL 文本）。
 *
 * 单独一个模块而不是塞在 `sessionLogScan.ts`：那个文件**既是库也是 CLI**（顶层就是
 * 扫描与打印），任何 `import` 都会把它的 CLI 输出一起跑出来。探针要的是纯解码。
 *
 * 两个实现要点（踩过的坑）：
 * 1. 会话日志是 `session.v3.jsonl.zstd`，**多帧** zstd（每次追加一个 frame）。
 *    Node 的 `zstdDecompressSync` 只解第一帧（拿到的是那行 session 头），
 *    所以这里逐帧走出帧边界、逐帧解码再拼起来。
 * 2. **帧边界不能靠「切在哪里能解码」猜**，也不能无条件相信引擎「解出来了」：
 *    - 切在帧内部魔数处的截断前缀会被 zstd 当成**完整的空帧**（`info: true` 下
 *      `bytesWritten` 等于该前缀长度、buffer 为 0 字节），旧启发式于是走过真边界，
 *      整份文件返回 `undefined` —— **合法帧内容被丢掉**；
 *    - 反过来，「魔数 + 几个垃圾字节」在**旧版 Node（24.19 及更早）**同样会被当成完整的空帧，
 *      **垃圾被读成空内容**（Node 24.20 起引擎自己抛 `Z_BUF_ERROR`；宽容入口的结果不能随
 *      运行期 Node 版本变，所以这一层不依赖引擎的脾气）。
 *
 *    现在改成：先按帧格式规范**走完整帧边界**（RFC 8878 §3.1.1 与 §3.1.2 的帧头、块与校验和，
 *    见 {@link walkZstdFrame}），再把**恰好这一帧**的切片交给引擎解压。边界不靠引擎对尾随字节的
 *    宽严：Node 24.19 及更早会忽略帧后的残片，Node 24.22 起直接拒绝，同一份日志的结果不能随
 *    运行期 Node 版本变化。两条正确契约由 `scripts/sessionLog.test.ts` 的「帧内部出现魔数」与
 *    「非法帧头」用例钉住（前者：合法帧必须解出全部内容；后者：垃圾不得被读成空内容）。
 *
 * **这一条路（`decodeSessionLogBytes`）刻意保持宽容**：它要向后兼容追加式日志的残尾
 * （写到一半就中断）与「完整前缀 + 垃圾」，因此**不**声称整份输入完整。
 * 需要「整份输入必须由完整合法帧构成」时用 {@link decodeSessionLogBytesStrict}：那里按
 * RFC 8878 逐帧走块（FCS 宽度、`dictId` 宽度、块类型 / `Last_Block` / 校验和长度都实证），
 * 每帧再交给原生引擎解压并核对字节消耗。两条契约并存：**默认宽容、严格显式**。
 *
 * **唯一实现是字节接口** {@link decodeSessionLogBytes}：它只吃传进来的这段字节，
 * 自己**不读盘**。路径接口 {@link decodeSessionLog} 只是 `readFileSync` + 委托的薄壳，
 * 两者行为逐字一致（多帧 / 空 / 损坏 / 帧内部魔数 / 非法帧头）。
 *
 * 为什么要有字节接口：「先读一次算 sha256、再按路径解码一次」会让来源摘要与派生事件
 * 来自**两次不同的读盘**（两次之间文件可能被追加或替换，即 TOCTOU）。调用方要保证
 * 摘要与事件同源时，先读成一份字节快照，再对它调用字节接口。
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

/** zstd 帧魔数（`28 B5 2F FD`）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/** `from` 处是不是一个帧魔数。 */
function isMagicAt(buf: Buffer, from: number): boolean {
  return from + 4 <= buf.length
    && buf[from] === ZSTD_MAGIC[0]
    && buf[from + 1] === ZSTD_MAGIC[1]
    && buf[from + 2] === ZSTD_MAGIC[2]
    && buf[from + 3] === ZSTD_MAGIC[3];
}

/** `from` 起（含）之后还有没有帧魔数 —— 区分「中段对不上」与「纯尾部垃圾」。 */
function hasMagicFrom(buf: Buffer, from: number): boolean {
  for (let i = from; i + 4 <= buf.length; i += 1) {
    if (isMagicAt(buf, i)) return true;
  }
  return false;
}

/**
 * 多帧 zstd 字节 → 整份 jsonl 文本。解不出来返回 `undefined`。
 *
 * **只看传入的这段 view**（`byteOffset` / `byteLength` 决定边界）：绝不能写成
 * `Buffer.from(bytes.buffer)` —— 那会把 view 之外的前缀 / 尾部垃圾一起读进来。
 *
 * 每一帧的处理顺序：**先按 RFC 8878 走出这一帧的结束偏移**（{@link walkZstdFrame}），
 * 再把恰好这一帧的切片交给引擎解压。帧边界不依赖引擎对尾随字节的宽严，因此同一份日志
 * 在 Node 24.19 与 24.22 上得到相同结果。
 *
 * 边界（明写在契约里，不当保证）：
 * - 帧不完整 / 帧头不合法且**前面还没有解出任何帧** → 整体 `undefined`（不得把垃圾读成空内容）；
 * - 帧不完整 / 帧头不合法，但前面已有完整帧 → 当作**追加式日志的残尾**（写了一半就中断），
 *   保留已解出的完整帧并停止。这正是 `readFileSync` 时代的旧容忍行为，保持不变；
 * - 中段还有帧起点却对不上 → 整体 `undefined`（不给半份内容）。
 */
export function decodeSessionLogBytes(bytes: Uint8Array): string | undefined {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Buffer[] = [];
  let start = 0;
  while (start < buf.length) {
    const end = walkZstdFrame(buf, start);
    if (end === undefined) {
      if (parts.length === 0) return undefined;
      // 纯尾部垃圾 → 保留已解出的帧；中段还有帧起点 → 这一段对不上
      if (!isMagicAt(buf, start) && hasMagicFrom(buf, start)) return undefined;
      return finish(parts);
    }
    let frame: Buffer;
    try {
      /**
       * `@types/node` 目前只有「返回 Buffer」这一个 `zstdDecompressSync` 重载，而运行期
       * `info: true` 按官方文档返回 `{buffer, engine}`（`ZstdOptions.info` 在类型里存在）。
       * 这里显式窄化，并在下面**先验证运行期形状**再使用 —— 形状不符就按解码失败处理。
       */
      const result = zlib.zstdDecompressSync(buf.subarray(start, end), { info: true }) as unknown as {
        buffer?: Buffer;
        engine?: { bytesWritten?: number };
      };
      if (
        !Buffer.isBuffer(result?.buffer)
        || result?.engine?.bytesWritten !== end - start
      ) {
        return parts.length === 0 ? undefined : finish(parts);
      }
      frame = result.buffer;
    } catch {
      return parts.length === 0 ? undefined : finish(parts);
    }
    parts.push(frame);
    start = end;
  }
  // 一个帧都没解出来（空输入 / 只有垃圾）→ undefined，不能返回空串当成功
  return parts.length === 0 ? undefined : finish(parts);
}

/** 已解出的帧拼接成文本（失败路径统一走 `undefined`，这里只处理有帧的情形）。 */
function finish(parts: readonly Buffer[]): string {
  return Buffer.concat(parts as Buffer[]).toString("utf8");
}

/** 多帧 zstd 文件 → 整份 jsonl 文本。解不出来返回 undefined。 */
export function decodeSessionLog(file: string): string | undefined {
  // 读盘失败照旧抛（调用方来接）——字节接口不改变路径接口的 I/O 行为
  return decodeSessionLogBytes(readFileSync(file));
}

/** 日志里的一行。 */
export interface SessionLogRow {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, any>;
}

// ---------- 严格入口（显式选择；默认入口的宽容契约不受影响） ----------

/**
 * 严格入口的错误码（**机器可读、语言中立**，不含内容 / 路径 / 会话 id）。
 *
 * - `frameHeader`：当前位置不是帧魔数，或帧头非法（保留位、可选字段 / 块头放不下）；
 * - `block`：`Block_Type` 保留值（`3`），或块里声明的有效载荷 / 校验和字节不够；
 * - `engine`：原生解压这一帧抛错（含 `ZSTD_error_checksum_wrong`）；
 * - `frameConsumed`：原生引擎没有正好消耗掉这一帧的字节数（半帧 / 走私字节）；
 * - `emptyInput`：整份输入 0 字节 —— 严格口径下不是「合法的空日志」；
 * - `utf8`：全部帧拼接后不是合法 UTF-8；
 * - `jsonLine`：非空行不是合法 JSON，或 JSON 值不是对象（原 `parseEvents` 静默丢弃的那些）。
 */
export const SESSION_LOG_ERROR_CODES = [
  "frameHeader",
  "block",
  "engine",
  "frameConsumed",
  "emptyInput",
  "utf8",
  "jsonLine",
] as const;

export type SessionLogErrorCode = (typeof SESSION_LOG_ERROR_CODES)[number];

/**
 * 严格入口的失败类型。
 *
 * `code` 是 {@link SESSION_LOG_ERROR_CODES} 里的一项；`detail` 只放**数字位置**
 * （帧起始偏移 / 行号）这类无内容摘要 —— 调用方拿它写日志、写测试断言都安全。
 * `message` 沿用「错误码 + 位置」的机器可读形状，**不**承载源文本。
 */
export class SessionLogError extends Error {
  readonly code: SessionLogErrorCode;
  readonly detail: number;

  constructor(code: SessionLogErrorCode, detail: number) {
    super(`${code}@${detail}`);
    this.name = "SessionLogError";
    this.code = code;
    this.detail = detail;
  }
}

/** 帧头描述符里 `Frame_Content_Size` 的宽度（0 表示没有该字段）。 */
const FRAME_CONTENT_SIZE_NONE = 0;

/**
 * `Frame_Header_Descriptor`（RFC 8878 §3.1.1.1.1）声明的 `Frame_Content_Size` 字节数。
 *
 * 口径（已用原生压缩产物逐字节见证，别照旧实现里的算术猜）：
 * `fcsFlag` 0/1/2/3 → **1 / 2 / 4 / 8** 字节；其中 `fcsFlag` 为 0 时字段**只对
 * 单段帧存在**（非单段帧没有 `Frame_Content_Size`），2 字节时的值表示「内容大小 − 256」。
 */
function frameContentSizeWidth(descriptor: number): number {
  const fcsFlag = descriptor >> 6;
  if (fcsFlag === 0) return (descriptor & 0x20) !== 0 ? 1 : FRAME_CONTENT_SIZE_NONE;
  return 1 << fcsFlag;
}

/**
 * 走一帧（只看结构，不解压），返回**这一帧的结束偏移**；结构不完整 / 非法返回 `undefined`。
 *
 * 依据 RFC 8878 §3.1.1 与 §3.1.2 的字段尺寸，不猜、不搜索下一个魔数：
 * 帧头之后按块头走（`Block_Header` 3 字节 LE：bit0 `Last_Block`、bit1–2 `Block_Type`、
 * bit3–23 `Block_Size`；`Raw` 块跟 `Block_Size` 字节、`RLE` 块只跟 1 字节、`Compressed`
 * 块跟 `Block_Size` 字节、`Reserved` 立即拒绝），`Last_Block` 之后按描述符 bit2 决定
 * 是否还有 4 字节校验和。**只有整帧字节都在输入里才算走通**。
 */
function walkZstdFrame(buf: Buffer, at: number): number | undefined {
  if (!isMagicAt(buf, at)) return undefined; // 起始不是帧魔数
  if (at + 5 > buf.length) return undefined; // 魔数 + 描述符都放不下
  const descriptor = buf[at + 4];
  // Unused_bit（bit4）忽略；Reserved_bit（bit3）必须为 0，置位即视为损坏帧
  if ((descriptor & 0x08) !== 0) return undefined;
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryIdWidth = [0, 1, 2, 4][descriptor & 0x03] ?? 0;
  let cursor = at + 5
    + (singleSegment ? 0 : 1) // Window_Descriptor 只对非单段帧存在
    + dictionaryIdWidth
    + frameContentSizeWidth(descriptor);
  for (;;) {
    if (cursor + 3 > buf.length) return undefined; // 块头放不下
    const blockHeader = buf[cursor] | (buf[cursor + 1] << 8) | (buf[cursor + 2] << 16);
    const lastBlock = (blockHeader & 0x01) !== 0;
    const blockType = (blockHeader >> 1) & 0x03;
    const blockSize = blockHeader >> 3;
    cursor += 3;
    if (blockType === 0x03) return undefined; // Reserved 块类型：直接拒绝
    const payloadBytes = blockType === 0x01 ? 1 : blockSize; // RLE 块只跟 1 字节
    if (cursor + payloadBytes > buf.length) return undefined; // 有效载荷被截断
    cursor += payloadBytes;
    if (lastBlock) break;
  }
  if ((descriptor & 0x04) !== 0) {
    if (cursor + 4 > buf.length) return undefined; // 声明了校验和但字节不够
    cursor += 4;
  }
  return cursor;
}

/**
 * 严格字节入口：整份输入**必须由若干完整合法 zstd 帧首尾相接构成**，否则抛
 * {@link SessionLogError}。与 {@link decodeSessionLogBytes} 的宽容契约**并存**：
 * 那个是默认兼容入口（残尾容忍），这个是显式严格入口，两者互不影响。
 *
 * 与宽容入口的区别（每一条都能被同步验收的合成矩阵证伪）：
 * - **不搜索下一个魔数**：完整前缀之后的任何垃圾 / 半帧 / 空魔数都拒绝；
 * - **整份输入必须逐帧走通**：`Last_Block` 必须出现、`Block_Type` 不得是保留值 3、
 *   有效载荷与（声明了的）校验和字节必须都在；帧走完必须正好落在输入末尾；
 * - **原生解压是必需证据**：每一帧的切片交给 `zstdDecompressSync`（`rejectGarbageAfterEnd`），
 *   内容大小与校验和由原生引擎判定（错误校验和会抛 `ZSTD_error_checksum_wrong`），
 *   且引擎回报的消耗字节数必须**恰好等于**该帧长度；
 * - **UTF-8 在拼接全部解压字节之后按字节判**：对那份拼接字节做 `TextDecoder(..., {fatal:true})`，
 *   非法序列抛 `utf8`；合法跨帧多字节码点照旧通过；**源里本来就合法的字面 U+FFFD**
 *   （`EF BF BD`）原样保留 —— 不能拿「解出的字符串里有没有 U+FFFD」当判据。
 *
 * **边界**：它证明的是「这份输入内部由完整合法的 zstd 帧构成」，**不证明**来源真实、
 * 也不证明源历史没有在某个完整帧边界被裁剪过。
 *
 * @throws {SessionLogError} 任一帧不合规 / 解压失败 / 拼接后不是合法 UTF-8
 */
export function decodeSessionLogBytesStrict(bytes: Uint8Array): string {
  // 只看这段 view（`byteOffset` / `byteLength`）：view 之外的前缀 / 尾部都不许被读进来
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length === 0) throw new SessionLogError("emptyInput", 0);
  const parts: Buffer[] = [];
  let start = 0;
  while (start < buf.length) {
    const end = walkZstdFrame(buf, start);
    if (end === undefined) {
      // 起始不是魔数 / 帧头非法 / 块结构不完整：用 `frameHeader` 与 `block` 区分严重度
      throw new SessionLogError(isMagicAt(buf, start) ? "block" : "frameHeader", start);
    }
    const slice = buf.subarray(start, end);
    let result: { buffer?: Buffer; engine?: { bytesWritten?: number } };
    try {
      /**
       * `rejectGarbageAfterEnd`（Node 24 起支持）是这一层的关键证据：喂进来的切片若在
       * 完整帧之后还有多余字节，原生引擎直接报 `ERR_TRAILING_JUNK_AFTER_STREAM_END`。
       * 当前 `@types/node` 的 `ZstdOptions` 还没有这个成员（类型落后于运行期），
       * 所以显式放宽到带该字段的形状；**不是**绕过校验 —— 下面的形状检查照旧执行。
       */
      const options = { info: true, rejectGarbageAfterEnd: true } as unknown as zlib.ZstdOptions;
      result = zlib.zstdDecompressSync(slice, options) as unknown as {
        buffer?: Buffer;
        engine?: { bytesWritten?: number };
      };
    } catch {
      // 原生引擎的判定就是证据：错误校验和 / 损坏数据都在这里被拒；不回显异常原文
      throw new SessionLogError("engine", start);
    }
    if (!Buffer.isBuffer(result.buffer) || result.engine?.bytesWritten !== slice.length) {
      throw new SessionLogError("frameConsumed", start);
    }
    parts.push(result.buffer);
    start = end;
  }
  /**
   * **fatal UTF-8 必须判在字节上**：源里本来就合法的 U+FFFD（`EF BF BD`）与「解码器把非法
   * 字节替换成的 U+FFFD」在字符串里长得一模一样，所以判据不能是「解出的字符串里有没有
   * U+FFFD」——那会把合法源一起误拒。这里对**拼接后的那份字节**做 `TextDecoder(..., {fatal:true})`：
   * 非法序列抛错，合法字面 U+FFFD 原样保留。
   *
   * 拼接在**全部帧之后**做，所以跨帧切开的多字节码点（前帧给首字节、后帧给续字节）照旧通过。
   */
  const merged = Buffer.concat(parts);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw new SessionLogError("utf8", 0);
  }
}

/** 一条严格解析出来的 durable 事件（形状与 {@link SessionWireEvent} 一致）。 */
export interface SessionLogParsedEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

/**
 * 严格行解析：解码后的文本必须**每一非空行都是完整 JSON 对象**。
 *
 * 与宽容侧（原 `parseEvents`）的区别：那里 `JSON.parse` 失败就 `continue`、`null` 还会
 * 让后续取值抛 `TypeError`。严格口径下：
 * - 非空行不是合法 JSON → `jsonLine`（**不是**「丢弃坏行」）；
 * - JSON 值是 `null` / 数组 / 标量 → `jsonLine`（必须是非 null 对象）；
 * - **合法但非 durable** 的元数据对象允许（缺 `type` / `seq` / `time` 的行不进事件表，
 *   但不算坏行）；
 * - 最后一行没有换行符本身合法（`"…}\n"` 与 `"…}"` 等价），不以缺换行判截断；
 * - 空行（含只有空白）跳过 —— 追加式日志不该因此被判坏。
 *
 * 计数用**无原型对象**：事件 `type` 来自日志、不可信，`__proto__` 键不得改原型。
 *
 * @throws {SessionLogError} `jsonLine`（`detail` = 从 1 开始的行号）
 */
export function parseSessionLogStrict(text: string): {
  events: SessionLogParsedEvent[];
  counts: Record<string, number>;
} {
  const events: SessionLogParsedEvent[] = [];
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line) as unknown;
    } catch {
      throw new SessionLogError("jsonLine", index + 1);
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new SessionLogError("jsonLine", index + 1);
    }
    const record = row as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown };
    if (typeof record.type !== "string") continue;
    counts[record.type] = (counts[record.type] ?? 0) + 1;
    if (typeof record.seq !== "number" || typeof record.time !== "number") continue;
    events.push({ type: record.type, seq: record.seq, time: record.time, data: record.data ?? {} });
  }
  return { events, counts };
}
