/**
 * 判断一份字节内容是不是可以安全内联进提示词的 UTF-8 文本。
 *
 * 为什么需要：文件附件的发送路径是「按 UTF-8 读成文本、拼进提示词」。对二进制
 * （.exe/.dll/.png 以外的 .pdf、压缩包…）这一步不会报错——`Buffer.toString("utf8")`
 * 把非法字节**静默替换成 U+FFFD**，于是一段乱码被当成「文件内容」喂给模型：
 * 既浪费 token，又可能误导模型。
 *
 * 判定口径刻意与 dsh 自己的 `read` 工具一致（`dsh-fs-local` 的 `readWholeText`）：
 * 1. 前 8192 字节里出现 NUL 字节 → 二进制（`FS_NOT_TEXT`）；
 * 2. 严格 UTF-8 解码失败（`TextDecoder` 的 `fatal: true`）→ 非文本。
 * 这样扩展与模型自己的工具对「这个文件能不能读」给出同一个答案。
 *
 * 与 vscode 无关，便于离线测试。
 */

/** 取样长度：与 dsh-fs-local 的 `BINARY_SAMPLE_BYTES` 保持一致。 */
export const BINARY_SAMPLE_BYTES = 8192;

export type TextFileResult =
  | { kind: "text"; text: string }
  /** 取样里有 NUL 字节：判定为二进制。 */
  | { kind: "binary" }
  /** 能当文本看，但不是合法 UTF-8（例如 GBK 编码的中文）。 */
  | { kind: "not-utf8" };

/**
 * 把文件字节解码为文本；非文本时给出原因而不是替换字符。
 *
 * 只取前 {@link BINARY_SAMPLE_BYTES} 字节做 NUL 判断——与官方口径一致，
 * 少量「开头是文本、后面才有二进制」的文件（如某些 PDF）会落到 UTF-8 校验这关。
 */
export function decodeTextFile(bytes: Uint8Array): TextFileResult {
  const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES);
  if (sample.includes(0)) return { kind: "binary" };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "not-utf8" };
  }
}

/**
 * 给模型的说明：文件没能内联，只给了路径。
 *
 * 附上**绝对路径**——dsh 的文件工具要求绝对路径，只给相对路径模型也用不上。
 */
export function notInlinedNote(displayPath: string, absolutePath: string, reason: "binary" | "not-utf8", sizeBytes: number): string {
  const size = `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  const why = reason === "binary" ? "二进制文件" : "非 UTF-8 编码的文本";
  return `文件 ${displayPath} 是${why}（${size}），未内联内容。绝对路径：${absolutePath}`;
}
