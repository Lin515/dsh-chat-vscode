/**
 * 附件归类里**不属于** `pathInsert.test.ts` 的两块：
 *
 * 1. 扩展名 → mediaType 的纯映射（最便宜的落点）；
 * 2. `showOpenDialog` 的跨平台约束——这条无法在无头环境测行为，只能扫源码。
 *
 * `classifyPath` 的完整覆盖（目录 / 图片 / 文本 / 二进制 / 非 UTF-8 / 过大 /
 * 读不出来 / 模型不支持图片）在 `pathInsert.test.ts`，那里有真实临时文件。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DROP_BYTES_LIMIT,
  classifyDroppedBytes,
  classifyPath,
  imageMediaTypeFor,
  isDirectoryPath,
  isImagePath,
} from "../src/dsh/attachments";

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

// ---------- 4. 拖放（只有字节 + 文件名，没有路径） ----------
//
// webview 拿不到被拖文件的路径：VS Code 不把资源注入 webview 的 DataTransfer
// （没有 ResourceURLs / text/uri-list），`File.path` 自 Electron 32 起也已移除。
// 所以拖放只能走字节，归类判据也只剩「文件名 + 模型收不收图」。
{
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const image = classifyDroppedBytes({ name: "shot.png", bytes: pngBytes, acceptsImage: true });
  assert.strictEqual(image.attachment.kind, "image", "模型收图时图片内联成内容块");
  assert.strictEqual(
    image.attachment.dataUrl,
    `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`,
    "dataUrl 必须由字节直接拼（没有路径可读）",
  );
  assert.strictEqual(image.attachment.bytes, pngBytes.length, "字节数要如实带上");
  assert.strictEqual(image.attachment.path, undefined, "拖放来的附件没有路径");

  // 模型不收图：不能退回「插入路径」——拖放根本没有路径可插，改走上传
  const unsupported = classifyDroppedBytes({ name: "shot.png", bytes: pngBytes, acceptsImage: false });
  assert.strictEqual(
    unsupported.attachment.kind,
    "file",
    "模型不收图时图片退化为普通文件上传，而不是丢掉（拖放没有路径可插）",
  );

  const text = classifyDroppedBytes({
    name: "notes.md",
    bytes: new TextEncoder().encode("# hi"),
    acceptsImage: true,
  });
  assert.strictEqual(text.attachment.kind, "file", "普通文件走上传");
  assert.strictEqual(text.attachment.name, "notes.md", "文件名原样保留（芯片上显示它）");

  // id 必须唯一：两个同名文件拖两次是两条附件
  const a = classifyDroppedBytes({ name: "same.txt", bytes: new Uint8Array([1]), acceptsImage: true });
  const b = classifyDroppedBytes({ name: "same.txt", bytes: new Uint8Array([2]), acceptsImage: true });
  assert.notStrictEqual(a.attachment.id, b.attachment.id, "同名文件的附件 id 不能相同");

  // 上限：界面按它拦掉超大文件（读了再 base64 是白烧内存），宿主侧同值
  assert.strictEqual(DROP_BYTES_LIMIT, 8 * 1024 * 1024, "拖放上限 8 MB");
  // 拖放逻辑在 dropAttach.ts（App 的全页监听用它），不在 Composer——
  // Composer 里若再留一份 attachBytes，同一份文件会被接两次、出两条附件
  const composer = readFileSync(join(process.cwd(), "src", "webview", "components", "Composer.tsx"), "utf8");
  assert.ok(
    !/post\(\{\s*type:\s*"attachBytes"/.test(composer),
    "Composer 里不得再发 attachBytes：全页统一由 App 的 window 监听接 drop，留在输入框会双发",
  );
  const dropAttach = readFileSync(join(process.cwd(), "src", "webview", "dropAttach.ts"), "utf8");
  assert.ok(
    /const DROP_BYTES_LIMIT = 8 \* 1024 \* 1024;/.test(dropAttach),
    "界面侧的上限必须与宿主同值：不一致时要么白读，要么发过去被拒",
  );
  assert.ok(
    /post\(\{ type: "attachBytes", files: payload, unreadable, tooLarge \}\)/.test(dropAttach),
    "拖放结果必须走 attachBytes（只有字节，没有路径）",
  );
  // 全页接取的钉子：dragover/drop 的 preventDefault 是「本页接受投放」的声明，
  // 缺了浏览器走默认行为（导航到文件）= VS Code 把文件在编辑器里打开
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /window\.addEventListener\("dragover", onDragOver\)/.test(app) &&
      /window\.addEventListener\("drop", onDrop\)/.test(app),
    "拖放监听必须挂 window（整页都是 drop 目标）——只挂输入框时拖到消息区会被 VS Code 打开文件",
  );
  assert.ok(
    /const onDrop = \(event: DragEvent\) => \{\s*\n\s*if \(!dragHasFiles\(event\)\) return;\s*\n\s*event\.preventDefault\(\);/.test(app),
    "onDrop 必须 preventDefault（且只拦文件拖拽）：文本拖拽要放行给 textarea 的原生插入",
  );
  console.log("attachments: 拖放字节归类 ✓");
}

console.log("\nattachments: all assertions passed");
