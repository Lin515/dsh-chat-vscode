/**
 * 验证「附件不是 UTF-8 文本时不内联」。
 *
 * 缺陷背景：文件附件的发送路径是按 UTF-8 读成文本拼进提示词，而
 * `Buffer.toString("utf8")` 对非法字节**不报错**，只把每个坏字节换成 U+FFFD。
 * 于是一个 352KB 的 notepad.exe（在 512KB 上限内）会带着满屏乱码进提示词。
 *
 * 判定口径与 dsh 自己的 read 工具一致（dsh-fs-local 的 readWholeText）：
 * 前 8192 字节含 NUL → 二进制；否则严格 UTF-8 解码，失败 → 非文本。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARY_SAMPLE_BYTES, decodeTextFile } from "../src/dsh/textFile";

// ---------- 1. 纯文本照常解码 ----------

{
  const bytes = Buffer.from("export const x = 1;\n中文注释\n", "utf8");
  const result = decodeTextFile(bytes);
  assert.strictEqual(result.kind, "text");
  assert.strictEqual(result.kind === "text" && result.text, "export const x = 1;\n中文注释\n");
}
console.log("textFile: 纯文本（含中文）✓");

// 空文件也是合法文本
{
  const result = decodeTextFile(Buffer.alloc(0));
  assert.strictEqual(result.kind, "text");
  assert.strictEqual(result.kind === "text" && result.text, "");
}
console.log("textFile: 空文件 ✓");

// ---------- 2. NUL 字节 → 二进制 ----------

{
  // 模拟 PE 头：'MZ' + 若干 NUL
  const pe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64), Buffer.from([0x90, 0x00, 0x03])]);
  const result = decodeTextFile(pe);
  assert.strictEqual(result.kind, "binary");
}
console.log("textFile: NUL 字节 → 二进制 ✓");

// 只看前 8192 字节：NUL 出现在取样窗口之后就不算二进制（与官方口径一致）
{
  const beyond = Buffer.concat([Buffer.from("a".repeat(BINARY_SAMPLE_BYTES)), Buffer.from([0])]);
  const result = decodeTextFile(beyond);
  assert.strictEqual(result.kind, "text", "取样窗口之外的 NUL 不影响判定（与 dsh read 一致）");
  const inside = Buffer.concat([Buffer.from("a".repeat(BINARY_SAMPLE_BYTES - 1)), Buffer.from([0])]);
  assert.strictEqual(decodeTextFile(inside).kind, "binary", "窗口内最后一个字节是 NUL → 二进制");
}
console.log("textFile: 8192 字节取样边界 ✓");

// ---------- 3. 非法 UTF-8 → 非文本（而不是一堆替换字符） ----------

{
  // 0xFF 0xFE 在 UTF-8 里永远非法
  const result = decodeTextFile(Buffer.from([0x41, 0xff, 0xfe, 0x42]));
  assert.strictEqual(result.kind, "not-utf8");
}
console.log("textFile: 非法 UTF-8 → 非文本 ✓");

// GBK 编码的中文（无 NUL，但不是合法 UTF-8）：正是「不是二进制但读不了」的情况
{
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // "中文" 的 GBK 字节
  const result = decodeTextFile(gbk);
  assert.strictEqual(result.kind, "not-utf8", "GBK 文本应判为非 UTF-8，而不是二进制");
}
console.log("textFile: GBK 文本 → 非 UTF-8 ✓");

// ---------- 4. 对照：旧写法确实会产出乱码（证明这个修复是必要的） ----------

{
  const pe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64), Buffer.from([0xff, 0xfe])]);
  const legacy = pe.toString("utf8"); // 旧代码路径：readFileSync(path, "utf8")
  assert.ok(legacy.includes("\uFFFD"), "旧写法确实把非法字节变成了替换字符");
  assert.strictEqual(decodeTextFile(pe).kind, "binary", "新写法在解码前就拦下它");
}
console.log("textFile: 旧写法会产出乱码（回归对照）✓");

// ---------- 5. 真实文件：有 exe 就用它，没有就构造一个 ----------

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-textfile-"));
  try {
    const exePath = join(dir, "fake.exe");
    writeFileSync(exePath, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(1024), Buffer.from([0x00, 0xff])]));
    const result = decodeTextFile(readFileSync(exePath));
    assert.strictEqual(result.kind, "binary");

    const txtPath = join(dir, "ok.txt");
    writeFileSync(txtPath, "hello 中文", "utf8");
    const ok = decodeTextFile(readFileSync(txtPath));
    assert.strictEqual(ok.kind, "text");
    assert.strictEqual(ok.kind === "text" && ok.text, "hello 中文");

    // 系统的 notepad.exe：真实 PE 文件，验证判定在真家伙上成立
    const realExe = "C:\\Windows\\System32\\notepad.exe";
    if (existsSync(realExe)) {
      const bytes = readFileSync(realExe);
      const decoded = decodeTextFile(bytes);
      assert.notStrictEqual(decoded.kind, "text", "真实 exe 不能被当成文本");
      console.log(
        `textFile: 真实 notepad.exe（${Math.round(bytes.length / 1024)} KB）→ ${decoded.kind} ✓`,
      );
    } else {
      console.log("textFile: 真实 notepad.exe（本机不存在，跳过）");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("textFile: 真实文件 ✓");

console.log("\ntextFile: all assertions passed");
