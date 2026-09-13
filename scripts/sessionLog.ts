/**
 * 会话日志解码（多帧 zstd → JSONL 文本）。
 *
 * 单独一个模块而不是塞在 `sessionLogScan.ts`：那个文件**既是库也是 CLI**（顶层就是
 * 扫描与打印），任何 `import` 都会把它的 CLI 输出一起跑出来。探针要的是纯解码。
 *
 * 两个实现要点（踩过的坑）：
 * 1. 会话日志是 `session.v3.jsonl.zstd`，**多帧** zstd（每次追加一个 frame）。
 *    Node 的 `zstdDecompressSync` 只解第一帧（拿到的是那行 session 头），
 *    所以这里按帧魔数切开逐帧解码再拼起来。
 * 2. 帧魔数 `28 B5 2F FD` 可能出现在压缩数据里，因此切点要往后试到能解码为止。
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

/** 多帧 zstd → 整份 jsonl 文本。解不出来返回 undefined。 */
export function decodeSessionLog(file: string): string | undefined {
  const buf = readFileSync(file);
  const offsets: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      offsets.push(i);
    }
  }
  if (!offsets.length || offsets[0] !== 0) return undefined;

  const parts: Buffer[] = [];
  let index = 0;
  while (index < offsets.length) {
    let decoded: Buffer | undefined;
    // 从当前帧起点往后试切点：真正的帧边界是「切到那里能解码」的那个
    for (let end = index + 1; end <= offsets.length && !decoded; end += 1) {
      const stop = end < offsets.length ? offsets[end] : buf.length;
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(offsets[index], stop));
        index = end;
      } catch {
        // 切在帧内部：换下一个候选
      }
    }
    if (!decoded) return undefined;
    parts.push(decoded);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** 日志里的一行。 */
export interface SessionLogRow {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, any>;
}

/**
 * 日志文件 → 行。
 *
 * 日志可能还没落盘（刚建会话）、或读到一半：都当「解不出来」跳过，
 * 不能让单个坏文件炸掉整个扫描（queueLogInspect 引用本文件时同样受益）。
 */
export function readSessionLogRows(file: string): SessionLogRow[] | undefined {
  let text: string | undefined;
  try {
    text = decodeSessionLog(file);
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  const rows: SessionLogRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as SessionLogRow);
    } catch {
      // 半截行（写到一半被杀）跳过即可
    }
  }
  return rows;
}
