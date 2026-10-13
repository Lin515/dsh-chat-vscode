/**
 * 附件归类（`classifyPath`）+ 路径插入光标处。
 *
 * 契约（0.5.0 起，对齐官方两条路；图片去向见 2026-10-13 口径）：
 *  - 目录 → **引用**（`@dir/`，模型自己决定要不要 list）；
 *  - 图片（模型收图、且五项判据都过）→ 图片内容块；
 *  - **其余文件**（二进制 / 非 UTF-8 / 任意大小都一样）→ 文件附件，选中即上传；
 *  - 进不了内容块的**图片** → 同样是附件，只是变成**文件**并走上传（`notInlined` 说明原因；
 *    文件通道没有准入限制，且不依赖「执行世界能读到本地路径」，见 `src/dsh/attachments.ts` 文件头）；
 *  - 只有**非图片**的「读不出来」（选择到读取之间被删）退回**只给路径**，
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
const { caretAfterInsert, findTrigger, insertToken, replaceToken } = await import("../src/webview/composerCompletion");

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
  ];
  for (const [label, reason, input] of pathCases) {
    const outcome = classifyPath(input);
    assert.strictEqual(outcome.kind, "path", `${label} 应当只给路径`);
    assert.strictEqual(outcome.kind === "path" && outcome.reason, reason, `${label} 的理由`);
  }
  // 模型不收图的**图片**：进不了内容块 → 改按文件上传（`notInlined` 说明原因）
  const unsupported = classifyPath({ path: pngPath, name: "shot.png", acceptsImage: false });
  assert.strictEqual(unsupported.kind, "attachment", "模型不收图时该条目仍是附件（变成文件）");
  assert.strictEqual(unsupported.kind === "attachment" && unsupported.attachment.kind, "file");
  assert.deepStrictEqual(
    unsupported.kind === "attachment" ? unsupported.notInlined : undefined,
    { reason: "image-unsupported" },
  );
  console.log("classify: 目录/读不出 → 路径；模型不收图 → 按文件上传 ✓");

  // ---------- 2.5 图片判据（路径通道）：按头部尺寸判「进不了内容块」 ----------
  //
  // 这里必须是**真实文件**：路径通道会 `readFileSync` 再把字节交给头部解析，与字节通道
  // 共用同一份判据（`attachments.ts` 的 `admissionVerdict`）。
  {
    const hugePath = join(dir, "huge.png");
    const header = Buffer.alloc(29);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "latin1");
    header.writeUInt32BE(9000, 16);
    header.writeUInt32BE(8000, 20);
    writeFileSync(hugePath, header);

    const oversized = classifyPath({
      path: hugePath,
      name: "huge.png",
      acceptsImage: true,
      admission: { maxImagePixels: 64_000_000, maxImageDimension: 8192 },
    });
    assert.strictEqual(oversized.kind, "attachment", "9000×8000 = 72M 像素：改按文件上传");
    assert.strictEqual(oversized.kind === "attachment" && oversized.attachment.kind, "file");
    assert.deepStrictEqual(
      oversized.kind === "attachment" ? oversized.notInlined : undefined,
      { reason: "image-pixels", limit: 64_000_000 },
      "只报上限：实测的位数量级对用户没有指导意义",
    );

    // 同一张图在限内时照旧内嵌；不给 admission 时完全不判（既有调用点不受影响）
    const fit = classifyPath({
      path: hugePath,
      name: "huge.png",
      acceptsImage: true,
      admission: { maxImagePixels: 100_000_000 },
    });
    assert.strictEqual(fit.kind, "attachment", "调大上限后它就该进来");
    assert.strictEqual(fit.kind === "attachment" && fit.attachment.kind, "image");
    assert.strictEqual(fit.kind === "attachment" ? fit.notInlined : "x", undefined);
    const noAdmission = classifyPath({ path: hugePath, name: "huge.png", acceptsImage: true });
    assert.strictEqual(noAdmission.kind, "attachment", "没给准入上限就什么都不判（旧调用点行为不变）");
    assert.strictEqual(noAdmission.kind === "attachment" && noAdmission.attachment.kind, "image");
    console.log("classify: 图片判据（像素超限改按文件 / 限内照旧 / 不给上限不判）✓");
  }

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

// ---------- 6. `@` 目录块的整段替换（触发词 = 整个内容块） ----------
//
// 用户 2026-10-10 口径：光标在 `@` 目录块**内部任意位置**时列表都开着，而且查询用
// **整个内容块**而不是光标前半截。渲染层能看见的效果就是这里的两件事：
// - 替换区间是**整个块**（`replaceToken` 自己按文本重算块终点——带引号的形态下按
//   `trigger.query` 长度算会把闭引号留在正文里）；
// - 块之外的正文一个字都不能动（前缀、后缀都要在）。
//
// 这两条合起来才对：只换光标前半截会留下 `@src/dsh/bview/` 这种半截路径；
// 把块后面的正文一起吃掉则是「误吞后缀」。查询串与替换终点共用同一个块判据
// （`composerCompletion.tsx` 的 `mentionBlockFrom`），所以带引号（含空白）的目录
// token 也走这一套，只是查询与写法都去掉那对引号。
{
  const text = "前文 @src/webview/ 后文";
  for (const caret of [4, 8, 15]) {
    const trigger = findTrigger(text, caret);
    assert.deepStrictEqual(
      trigger,
      { kind: "mention", start: 3, query: "src/webview/" },
      `光标 ${caret} 落在目录块里：查询串是整个块`,
    );
    const result = replaceToken(text, trigger!, "@src/dsh/");
    assert.strictEqual(result.text, "前文 @src/dsh/ 后文", "整段替换：前后文一个字都没被吃掉");
    assert.strictEqual(result.caret, "前文 @src/dsh/".length, "光标落在插入内容之后");
  }

  // 带引号（含空白）的引用插进来时同样只换整个块
  {
    const withQuoted = replaceToken("看 @src/ 后面", findTrigger("看 @src/ 后面", 5)!, '@"my dir/"');
    assert.strictEqual(withQuoted.text, '看 @"my dir/" 后面', "块后的正文不许被吃进引号里");
  }
  {
    const withSpacedFile = replaceToken(
      "看 @src/ 后面",
      findTrigger("看 @src/ 后面", 5)!,
      '@"src/my file.ts"',
    );
    assert.strictEqual(withSpacedFile.text, '看 @"src/my file.ts" 后面', "含空格文件名同理");
  }

  // 带引号的**目录块**：查询串是去掉引号的语义路径，替换区间覆盖那对引号
  {
    const quoted = '看 @"my dir/" 后面';
    const trigger = findTrigger(quoted, 7);
    assert.deepStrictEqual(
      trigger,
      { kind: "mention", start: 2, query: "my dir/" },
      "带引号目录块：查询串是语义路径（不含引号）",
    );
    assert.strictEqual(
      replaceToken(quoted, trigger!, '@"my dir/sub/"').text,
      '看 @"my dir/sub/" 后面',
      "整块替换覆盖闭引号：不留孤引号，前后文不动",
    );
    // 换成不带引号的形态（上一层是工作区根目录）时，闭引号也必须一起消失
    assert.strictEqual(
      replaceToken(quoted, trigger!, "@").text,
      "看 @ 后面",
      "替换区间覆盖闭引号：换成裸 `@` 时不留下半个引号",
    );
    // 光标紧靠闭引号右侧时区间照样是整个块（替换终点不按光标截断）
    assert.strictEqual(
      replaceToken(quoted, findTrigger(quoted, 11)!, "@").text,
      "看 @ 后面",
      "光标在块尾附近也是整块替换（查询与替换共用同一套块终点）",
    );
  }

  // 引号块里出现「空白 + @」（`@"my @scope/"`）：外层完整 token 拥有整段，
  // 替换起点/终点都不许被那个内部 `@` 切走
  {
    const inner = '看 @"my @scope/" 后面';
    for (const caret of [4, 8, 11, 14]) {
      const trigger = findTrigger(inner, caret);
      assert.deepStrictEqual(
        trigger,
        { kind: "mention", start: 2, query: "my @scope/" },
        `光标 ${caret}：内部 \`@\` 不抢起点，查询是解包后的整个块`,
      );
      const result = replaceToken(inner, trigger!, "@src/");
      assert.strictEqual(result.text, "看 @src/ 后面", "整段替换：闭引号被覆盖，前缀后缀不动");
      assert.strictEqual(result.caret, "看 @src/".length, "光标落在替换结果之后");
    }
  }

  // Windows 反斜杠写的目录块：整块换掉，且反斜杠照原样进查询串
  {
    const win = "看 @src\\dsh\\ 后面";
    const trigger = findTrigger(win, 10);
    assert.deepStrictEqual(
      trigger,
      { kind: "mention", start: 2, query: "src\\dsh\\" },
      "反斜杠目录块：查询串是整个块（原样保留反斜杠）",
    );
    assert.strictEqual(
      replaceToken(win, trigger!, "@src/webview/").text,
      "看 @src/webview/ 后面",
      "反斜杠目录块同样是整段替换",
    );
  }

  // 块之后的空白另一边不该被当成触发词（否则「把光标放到目录块后面」会又弹列表、
  // 下一次替换还会把后面的字吃掉）；紧贴块尾的那一格仍算块内
  assert.deepStrictEqual(
    findTrigger("看 @src/ 后面", 7),
    { kind: "mention", start: 2, query: "src/" },
    "光标紧贴块尾（分隔符右侧、那块空白左侧）仍在块内",
  );
  assert.strictEqual(findTrigger("看 @src/ 后面", 8), undefined, "光标越过块后的空白 → 没有触发词，也就没有替换");
}
console.log("completion: `@` 目录块的整段替换 ✓");

console.log("\nclassify/insert: all assertions passed");
