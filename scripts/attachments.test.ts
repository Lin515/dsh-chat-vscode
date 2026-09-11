/**
 * 附件归类里**不属于** `pathInsert.test.ts` 的两块：
 *
 * 1. 扩展名 → mediaType 的纯映射（最便宜的落点）；
 * 2. `showOpenDialog` 的跨平台约束——这条无法在无头环境测行为，只能扫源码。
 *
 * `classifyPath` 的完整覆盖（能内嵌 / 目录 / 二进制 / 非 UTF-8 / 过大 /
 * 读不出来 / 模型不支持图片）在 `pathInsert.test.ts`，那里有真实临时文件。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, imageMediaTypeFor, isDirectoryPath, isImagePath } from "../src/dsh/attachments";

// ---------- 1. 扩展名 → mediaType ----------

assert.strictEqual(imageMediaTypeFor("a.png"), "image/png");
assert.strictEqual(imageMediaTypeFor("D:\\shots\\a.JPG"), "image/jpeg");
assert.strictEqual(imageMediaTypeFor("a.jpeg"), "image/jpeg");
assert.strictEqual(imageMediaTypeFor("a.webp"), "image/webp");
assert.strictEqual(imageMediaTypeFor("a.gif"), "image/gif");
// 非图片 / 无扩展名 / 路径里有点但不是扩展名
assert.strictEqual(imageMediaTypeFor("a.txt"), undefined);
assert.strictEqual(imageMediaTypeFor("Makefile"), undefined);
assert.strictEqual(imageMediaTypeFor("a.png.txt"), undefined);
assert.strictEqual(imageMediaTypeFor("archive.tar.gz"), undefined);
assert.strictEqual(isImagePath("logo.webp"), true);
assert.strictEqual(isImagePath("logo.svg"), false, "svg 不在支持列表内");
console.log("attachments: 扩展名归类 ✓");

// ---------- 2. 目录静态探测 + 附件 id 唯一 ----------

const dir = mkdtempSync(join(tmpdir(), "dsh-attach-"));
try {
  const txtPath = join(dir, "notes.txt");
  writeFileSync(txtPath, "hello", "utf8");

  assert.strictEqual(isDirectoryPath(dir), true, "真实目录要认出来");
  assert.strictEqual(isDirectoryPath(txtPath), false, "普通文件不能被判成目录");
  assert.strictEqual(isDirectoryPath(join(dir, "nope")), false, "不存在的路径不能抛错");

  // 同一次选择里的两个附件不能撞 id
  const a = classifyPath({ path: txtPath, name: "notes.txt", acceptsImage: true });
  const b = classifyPath({ path: txtPath, name: "notes.txt", acceptsImage: true });
  assert.ok(a.kind === "attachment" && b.kind === "attachment");
  assert.notStrictEqual(a.attachment.id, b.attachment.id);

  // 读取失败要能报出来（而不是静默变成空结果）
  const messages: string[] = [];
  classifyPath({
    path: join(dir, "missing.txt"),
    name: "missing.txt",
    acceptsImage: true,
    onError: (message) => messages.push(message),
  });
  assert.strictEqual(messages.length, 1, "应当报告读取失败");
  assert.ok(messages[0].includes("missing.txt"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("attachments: 目录探测 / id / 错误上报 ✓");

// ---------- 3. 回归防线：OpenDialog 的 canSelectFiles / canSelectFolders 不能同时为 true ----------
//
// VS Code 的 OpenDialogOptions 明确写着（@types/vscode/index.d.ts:2063）：
//   "On Windows and Linux, a file dialog cannot be both a file selector and a
//    folder selector, so if you set both `canSelectFiles` and `canSelectFolders`
//    to `true` on these platforms, a folder selector will be shown."
//
// 也就是说「同时置 true」在 Windows 上会**只**弹目录选择器、文件全被过滤掉。
// 这个 bug 真实发生过（pickFiles 曾是无人调用的死代码，接上按钮后才暴露），
// 所以直接扫源码把这个不变量钉住——showOpenDialog 无法在无头环境里测行为。
{
  const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const calls = [...source.matchAll(/showOpenDialog\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `应当至少有两个 showOpenDialog 调用，实际 ${calls.length}`);

  for (const body of calls) {
    const files = /canSelectFiles:\s*(true|false)/.exec(body)?.[1];
    const folders = /canSelectFolders:\s*(true|false)/.exec(body)?.[1];
    assert.ok(
      !(files === "true" && folders === "true"),
      `不能同时选文件与目录（Windows 上只会弹目录选择器）：\n${body.trim()}`,
    );
  }
  console.log(`attachments: showOpenDialog 标志互斥（扫到 ${calls.length} 处）✓`);
}

console.log("\nattachments: all assertions passed");
