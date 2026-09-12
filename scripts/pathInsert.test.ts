/**
 * 附件归类（`classifyPath`）+ 路径插入光标处。
 *
 * 契约（0.5.0 起，对齐官方两条路）：
 *  - 目录 → **引用**（`@dir/`，模型自己决定要不要 list）；
 *  - 图片（模型收图）→ 图片内容块；
 *  - 其余文件（二进制/非 UTF-8/任意大小都一样）→ 文件附件，选中即上传；
 *  - 只有「读不出来」（选择到读取之间被删）与「模型不收图片」退回**只给路径**，
 *    由界面以双引号包裹插到输入框光标处。
 *
 * 旧版还按「内容能不能内联正文」分派（二进制/非 UTF-8/过大 → 只给路径）——那是
 * 内联时代的判据；0.5.0 起文件走逐字节上传，上传不挑内容，门槛随之移除。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, formatPathList, quotePath } from "../src/dsh/attachments";
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
  writeFileSync(bigPath, "x".repeat(600 * 1024), "utf8");

  const subDir = join(dir, "assets");
  mkdirSync(subDir, { recursive: true });

  // ---------- 1. 可附件：文本/图片/二进制/非 UTF-8/过大，一律附件 ----------

  const text = classifyPath({ path: textPath, name: "notes.txt", acceptsImage: true });
  assert.strictEqual(text.kind, "attachment", "文本文件应当上传");
  assert.strictEqual(text.kind === "attachment" && text.attachment.kind, "file");

  const png = classifyPath({ path: pngPath, name: "shot.png", acceptsImage: true });
  assert.strictEqual(png.kind, "attachment", "合法图片应当内嵌");
  assert.strictEqual(png.kind === "attachment" && png.attachment.kind, "image");
  assert.ok(png.kind === "attachment" && png.attachment.dataUrl?.startsWith("data:image/png;base64,"));

  // 旧版这三样都退回「只给路径」；上传路径按字节发，它们都能传
  const cases: [string, Parameters<typeof classifyPath>[0]][] = [
    ["二进制", { path: exePath, name: "tool.exe", acceptsImage: true }],
    ["非 UTF-8", { path: gbkPath, name: "gbk.txt", acceptsImage: true }],
    ["过大", { path: bigPath, name: "big.txt", acceptsImage: true }],
  ];
  for (const [label, input] of cases) {
    const outcome = classifyPath(input);
    assert.strictEqual(outcome.kind, "attachment", `${label} 应当作为文件附件上传`);
    assert.strictEqual(outcome.kind === "attachment" && outcome.attachment.kind, "file", `${label} 是文件附件`);
  }
  console.log("classify: 文本/图片/二进制/非 UTF-8/过大 → 附件 ✓");

  // ---------- 2. 不做附件 → 路径（且理由正确） ----------

  const pathCases: [string, string, Parameters<typeof classifyPath>[0]][] = [
    ["目录", "directory", { path: subDir, name: "assets", acceptsImage: true }],
    ["不存在", "unreadable", { path: join(dir, "nope.txt"), name: "nope.txt", acceptsImage: true }],
    ["模型不支持图片", "image-unsupported", { path: pngPath, name: "shot.png", acceptsImage: false }],
  ];
  for (const [label, reason, input] of pathCases) {
    const outcome = classifyPath(input);
    assert.strictEqual(outcome.kind, "path", `${label} 应当只给路径`);
    assert.strictEqual(outcome.kind === "path" && outcome.reason, reason, `${label} 的理由`);
  }
  console.log("classify: 目录/读不出/模型不收图 → 路径 ✓");

  // 目录名像图片（xxx.png/）仍按目录处理，不能因为扩展名就去读它
  const imageNamedDir = join(dir, "screenshot.png");
  mkdirSync(imageNamedDir, { recursive: true });
  const dirOutcome = classifyPath({ path: imageNamedDir, name: "screenshot.png", acceptsImage: true });
  assert.strictEqual(dirOutcome.kind === "path" && dirOutcome.reason, "directory");
  console.log("classify: 名字像图片的目录仍按目录 ✓");

  // ---------- 3. 引号与拼接（兜底路径文本） ----------

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
