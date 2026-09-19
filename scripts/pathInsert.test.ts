/**
 * 附件归类（`classifyPath`）+ 路径插入光标处。
 *
 * 契约（0.5.0 起，对齐官方两条路）：
 *  - 目录 → **引用**（`@dir/`，模型自己决定要不要 list）；
 *  - 图片（模型收图）→ 图片内容块；
 *  - **其余文件**（二进制 / 非 UTF-8 / 任意大小都一样）→ 文件附件，选中即上传；
 *  - 只有「读不出来」（选择到读取之间被删）与「模型不收图片」退回**只给路径**，
 *    由界面以双引号包裹插到输入框光标处。
 *
 * **0.7.x 的一版曾经加过「可读性 / 大小筛子」**（二进制、非 UTF-8、>8MB → 只给
 * 路径），**已被推翻**：官方客户端与上传接口**都不筛**，而且上下文里对**任何**文件
 * 都只放「路径 + 大小 + sha256」引用、从不放字节——「exe 没进上下文」不是过滤，
 * 是所有文件都不进上下文。详见 `src/dsh/attachments.ts` 的文件头。这一组断言就是
 * 防止那个筛子再被加回来。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, formatPathList, quotePath } from "../src/dsh/attachments";

// `composerCompletion` 连带 `bridge.ts` 在模块求值期挂 `window.addEventListener`：
// 无头环境先补最小 window（外加 `acquireVsCodeApi`）、再动态 import
// （理由见 `mentionNav.test.ts` 同一处注释）。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: () => undefined,
});
const { caretAfterInsert, insertToken } = await import("../src/webview/composerCompletion");

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

  // 比 webview 拖放上限大得多：回形针这条路（宿主直读 + 原始字节 POST）不设限
  const bigPath = join(dir, "big.bin");
  writeFileSync(bigPath, Buffer.alloc(12 * 1024 * 1024, 0x78));

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

  // 这三样**不能**再被筛掉：官方上传不挑内容，上下文里只放引用（不是字节）
  const cases: [string, Parameters<typeof classifyPath>[0]][] = [
    ["二进制", { path: exePath, name: "tool.exe", acceptsImage: true }],
    ["非 UTF-8", { path: gbkPath, name: "gbk.txt", acceptsImage: true }],
    ["超过拖放上限", { path: bigPath, name: "big.bin", acceptsImage: true }],
  ];
  for (const [label, input] of cases) {
    const outcome = classifyPath(input);
    assert.strictEqual(outcome.kind, "attachment", `${label} 应当作为文件附件上传（官方不筛）`);
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
  const result = insertToken("看一下", '"C:\\a.exe"', 3);
  assert.strictEqual(result.value, '看一下 "C:\\a.exe"');
  assert.strictEqual(result.caret, result.value.length);
}
// 已有空白结尾 → 不重复补空格
assert.strictEqual(insertToken("看一下 ", '"C:\\a.exe"', 4).value, '看一下 "C:\\a.exe"');
// 中间插入：前后都补空格，光标落在插入内容之后（而不是留在插入点）
{
  const result = insertToken("读取然后继续", '"C:\\a b.txt"', 2);
  assert.strictEqual(result.value, '读取 "C:\\a b.txt" 然后继续');
  // 光标正好落在「插入内容 + 补的那个空格」之后：用户接着打字会接在空格后，
  // 不会与后面的文字粘连
  assert.strictEqual(result.value.slice(0, result.caret), '读取 "C:\\a b.txt" ');
  assert.strictEqual(result.value.slice(result.caret), "然后继续");
}
// 插入点在开头：前面没东西 → 不补前导空格；后面有字 → 补尾随空格
{
  const result = insertToken("后续文字", '"C:\\x"', 0);
  assert.strictEqual(result.value, '"C:\\x" 后续文字');
  assert.strictEqual(result.value.slice(0, result.caret), '"C:\\x" ', "光标在插入内容+空格之后");
}
// 空草稿：前后都没东西 → 不补空格
{
  const result = insertToken("", '"C:\\x"', 0);
  assert.strictEqual(result.value, '"C:\\x"');
  assert.strictEqual(result.caret, result.value.length, "空草稿插入后光标在末尾");
}
// 越界光标夹到两端，不抛错（调用方可能传来过期位置）
assert.strictEqual(insertToken("abc", '"p"', 999).value, 'abc "p"');
assert.strictEqual(insertToken("abc", '"p"', -5).value, '"p" abc');
assert.strictEqual(insertToken("abc", '"p"', Number.NaN).value, 'abc "p"', "NaN 应按末尾处理");
// 连续插两次：第二次不会把第一次的结果弄乱
{
  const first = insertToken("看看", '"C:\\a"', 2);
  const second = insertToken(first.value, '"C:\\b"', first.caret);
  assert.strictEqual(second.value, '看看 "C:\\a" "C:\\b"');
}
console.log("insert: 光标处插入 ✓");

// ---------- 5. 补全的落点算术（触发词整段替换） ----------
//
// 这一段此前**零覆盖**：`@` 选完之后的文本与光标位置全在 Composer 里现算，
// 算错了表现为「插进来的路径落在别处 / 后面的字被吃掉 / 光标跑回原处」，
// 而没有任何断言会红。现在它是纯函数 `caretAfterInsert`（`replaceToken` 的实现）。
{
  // 触发词在中间：替换掉 `@src`（start=0、end=4），后面的字一个都不能少
  const middle = caretAfterInsert("看看@src然后继续", 2, 6, "@src/webview/");
  assert.strictEqual(middle.text, "看看@src/webview/然后继续", "触发词整段被换掉、其余字节不动");
  assert.strictEqual(middle.caret, 2 + "@src/webview/".length, "光标落在插入内容之后");
  assert.strictEqual(middle.text.slice(0, middle.caret), "看看@src/webview/");
  assert.strictEqual(middle.text.slice(middle.caret), "然后继续", "后面的字没被吃掉");

  // 「..」：正文里只留 `@<上一层>`（上一层是工作区根目录时是裸 `@`）
  const up = caretAfterInsert("@src/webview/", 0, "@src/webview/".length, "@src/");
  assert.strictEqual(up.text, "@src/");
  assert.strictEqual(up.caret, 5);

  // 命令：`/git` → `/git-guard`，光标在名字之后（接下来直接打参数）
  const command = caretAfterInsert("/git 现在提交", 0, 4, "/git-guard");
  assert.strictEqual(command.text, "/git-guard 现在提交");
  assert.strictEqual(command.caret, 10);

  // 段落里的 `@`（前面有空白）同样只换触发词那一段
  const inSentence = caretAfterInsert("看一下 @src 这个目录", 4, 8, "@src/webview/");
  assert.strictEqual(inSentence.text, "看一下 @src/webview/ 这个目录");
  assert.strictEqual(inSentence.caret, 4 + "@src/webview/".length);
  assert.strictEqual(inSentence.text.slice(inSentence.caret), " 这个目录");

  // 末尾触发（后面什么都没有）
  const atEnd = caretAfterInsert("读 @src", 2, 6, "@src/dsh/");
  assert.strictEqual(atEnd.text, "读 @src/dsh/");
  assert.strictEqual(atEnd.caret, atEnd.text.length);

  // 区间会被夹到合法范围：过期的下标不抛错、也不吃掉字符
  assert.strictEqual(caretAfterInsert("abc", 99, 99, "@x").text, "abc@x");
  assert.strictEqual(caretAfterInsert("abc", -5, 1, "@x").text, "@xbc", "起点按 0 夹");
  // `to` 早于 `from` 时按「不删任何东西」处理（夹成 to = from），不是在中间吃掉一段
  assert.strictEqual(caretAfterInsert("abc", 2, 1, "@x").text, "ab@xc", "终点不早于起点（空区间插入）");
  assert.strictEqual(caretAfterInsert("abc", Number.NaN, Number.NaN, "@x").text, "abc@x");
}
console.log("completion: 触发词替换的落点算术 ✓");

console.log("\nclassify/insert: all assertions passed");
