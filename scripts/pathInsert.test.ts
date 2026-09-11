/**
 * 「能不能内嵌」的归类 + 路径插入光标处。
 *
 * 契约（用户指定）：
 *  - 合法图片 / 合法文本且不过大 → **附件**，随消息内嵌发送；
 *  - 目录 / 二进制 / 非 UTF-8 / 过大 / 读不出来 → **只给路径**，
 *    由界面以双引号包裹插到输入框光标处。
 *
 * 这两件事以前都是「一律做成附件」：二进制被按 UTF-8 读成乱码（`toString("utf8")`
 * 不报错，只把坏字节换成 U+FFFD），目录更直接抛 EISDIR。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INLINE_TEXT_MAX_BYTES,
  classifyPath,
  formatPathList,
  quotePath,
} from "../src/dsh/attachments";
import { insertAtCaret } from "../src/webview/insert";

const dir = mkdtempSync(join(tmpdir(), "dsh-classify-"));
try {
  const textPath = join(dir, "notes.txt");
  writeFileSync(textPath, "hello 中文\n", "utf8");

  const pngPath = join(dir, "shot.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(pngPath, pngBytes);

  const exePath = join(dir, "tool.exe");
  writeFileSync(exePath, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64), Buffer.from([0xff, 0xfe])]));

  const gbkPath = join(dir, "gbk.txt");
  writeFileSync(gbkPath, Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // GBK 的「中文」

  const bigPath = join(dir, "big.txt");
  writeFileSync(bigPath, "x".repeat(INLINE_TEXT_MAX_BYTES + 1), "utf8");

  const subDir = join(dir, "assets");
  mkdirSync(subDir, { recursive: true });

  // ---------- 1. 能内嵌 → 附件 ----------

  const text = classifyPath({ path: textPath, name: "notes.txt", acceptsImage: true });
  assert.strictEqual(text.kind, "attachment", "合法 UTF-8 文本应当内嵌");
  assert.strictEqual(text.kind === "attachment" && text.attachment.kind, "file");

  const png = classifyPath({ path: pngPath, name: "shot.png", acceptsImage: true });
  assert.strictEqual(png.kind, "attachment", "合法图片应当内嵌");
  assert.strictEqual(png.kind === "attachment" && png.attachment.kind, "image");
  assert.ok(png.kind === "attachment" && png.attachment.dataUrl?.startsWith("data:image/png;base64,"));
  console.log("classify: 合法文本/图片 → 附件 ✓");

  // ---------- 2. 不能内嵌 → 路径（且理由正确） ----------

  const cases: [string, string, Parameters<typeof classifyPath>[0]][] = [
    ["目录", "directory", { path: subDir, name: "assets", acceptsImage: true }],
    ["二进制", "binary", { path: exePath, name: "tool.exe", acceptsImage: true }],
    ["非 UTF-8", "not-utf8", { path: gbkPath, name: "gbk.txt", acceptsImage: true }],
    ["过大", "too-large", { path: bigPath, name: "big.txt", acceptsImage: true }],
    ["不存在", "unreadable", { path: join(dir, "nope.txt"), name: "nope.txt", acceptsImage: true }],
    ["模型不支持图片", "image-unsupported", { path: pngPath, name: "shot.png", acceptsImage: false }],
  ];
  for (const [label, reason, input] of cases) {
    const outcome = classifyPath(input);
    assert.strictEqual(outcome.kind, "path", `${label} 应当只给路径`);
    assert.strictEqual(outcome.kind === "path" && outcome.reason, reason, `${label} 的理由`);
  }
  console.log("classify: 不能内嵌的六种情形 → 路径 ✓");

  // 目录名像图片（xxx.png/）仍按目录处理，不能因为扩展名就去读它
  const imageNamedDir = join(dir, "screenshot.png");
  mkdirSync(imageNamedDir, { recursive: true });
  const dirOutcome = classifyPath({ path: imageNamedDir, name: "screenshot.png", acceptsImage: true });
  assert.strictEqual(dirOutcome.kind === "path" && dirOutcome.reason, "directory");
  console.log("classify: 名字像图片的目录仍按目录 ✓");

  // ---------- 3. 引号与拼接 ----------

  assert.strictEqual(quotePath("C:\\a b\\c.exe"), '"C:\\a b\\c.exe"', "路径必须整体被双引号包住");
  assert.strictEqual(
    formatPathList(["C:\\a b\\c.exe", "/tmp/x"]),
    '"C:\\a b\\c.exe" "/tmp/x"',
    "多个路径用空格分隔，各自带引号",
  );
  // 空列表不该产生空引号
  assert.strictEqual(formatPathList([]), "");
  console.log("classify: 引号与拼接 ✓");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 4. 光标处插入 ----------

// 末尾追加：前面有文字 → 补一个空格
{
  const result = insertAtCaret("看一下", '"C:\\a.exe"', 3);
  assert.strictEqual(result.value, '看一下 "C:\\a.exe"');
  assert.strictEqual(result.caret, result.value.length);
}
// 已有空白结尾 → 不重复补空格
assert.strictEqual(insertAtCaret("看一下 ", '"C:\\a.exe"', 4).value, '看一下 "C:\\a.exe"');
// 中间插入：前后都补空格，光标落在插入内容之后（而不是留在插入点）
{
  const result = insertAtCaret("读取然后继续", '"C:\\a b.txt"', 2);
  assert.strictEqual(result.value, '读取 "C:\\a b.txt" 然后继续');
  // 光标正好落在「插入内容 + 补的那个空格」之后：用户接着打字会接在空格后，
  // 不会与后面的文字粘连
  assert.strictEqual(result.value.slice(0, result.caret), '读取 "C:\\a b.txt" ');
  assert.strictEqual(result.value.slice(result.caret), "然后继续");
}
// 插入点在开头：前面没东西 → 不补前导空格；后面有字 → 补尾随空格
{
  const result = insertAtCaret("后续文字", '"C:\\x"', 0);
  assert.strictEqual(result.value, '"C:\\x" 后续文字');
  assert.strictEqual(result.value.slice(0, result.caret), '"C:\\x" ', "光标在插入内容+空格之后");
}
// 空草稿：前后都没东西 → 不补空格
{
  const result = insertAtCaret("", '"C:\\x"', 0);
  assert.strictEqual(result.value, '"C:\\x"');
  assert.strictEqual(result.caret, result.value.length, "空草稿插入后光标在末尾");
}
// 越界光标夹到两端，不抛错（调用方可能传来过期位置）
assert.strictEqual(insertAtCaret("abc", '"p"', 999).value, 'abc "p"');
assert.strictEqual(insertAtCaret("abc", '"p"', -5).value, '"p" abc');
assert.strictEqual(insertAtCaret("abc", '"p"', Number.NaN).value, 'abc "p"', "NaN 应按末尾处理");
// 连续插两次：第二次不会把第一次的结果弄乱
{
  const first = insertAtCaret("看看", '"C:\\a"', 2);
  const second = insertAtCaret(first.value, '"C:\\b"', first.caret);
  assert.strictEqual(second.value, '看看 "C:\\a" "C:\\b"');
}
console.log("insert: 光标处插入 ✓");

console.log("\nclassify/insert: all assertions passed");
