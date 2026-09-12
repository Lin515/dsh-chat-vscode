/**
 * 附件新模型：`@path` 引用 + 文件上传（对齐官方，取代早期的「内联正文」）。
 *
 * 为什么改：早期版本把文件内容读进 prompt（上限 512KB）。官方从不这么做，代价是
 * 实打实的——token 成本高、二进制读不到、`@path` 的语义消失、队列「重新编辑」退化。
 * 官方两条路（证据见 docs/audit-summary.md §19 与 `dsh/references.ts` 的文件头）：
 * 1. `@path` 引用：只发路径 token，目录以结尾 `/` 标记；
 * 2. 文件上传：拿 `receiptId`，随 prompt 作为 `{type:'file', receiptId}` 发出。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { composeWithReferences, formatFileMention } from "../src/dsh/references";

// ---------- 1. mention 文本：逐字对齐官方 formatFileMention ----------

{
  assert.strictEqual(formatFileMention("src/dsh/controller.ts"), "@src/dsh/controller.ts");
  // 目录补结尾斜杠——系统提示段用它区分「这是目录，要内容就 list」
  assert.strictEqual(formatFileMention("src/dsh", "directory"), "@src/dsh/");
  // 已带尾斜杠时不重复追加（`@dir//` 语义不变但很难看；
  // 官方那行是无条件拼接，因为它的调用方从不传带尾斜杠的路径）
  assert.strictEqual(formatFileMention("src/dsh/", "directory"), "@src/dsh/");
  assert.strictEqual(formatFileMention("src\\dsh\\", "directory"), "@src\\dsh\\");
  // **文件**不补斜杠，哪怕路径以斜杠结尾也不动它
  assert.strictEqual(formatFileMention("src/dsh/", "file"), "@src/dsh/");
}
console.log("references: 普通路径与目录的 mention（不重复补斜杠） ✓");

// ---------- 2. 含空白的路径要加引号；目录只加**开**引号 ----------
//
// 目录只加开引号是官方刻意的：那个形式在输入框里仍是「未闭合」的引用，
// 用户继续往下打字（下钻）时语法仍然成立。
{
  assert.strictEqual(formatFileMention("my file.txt"), '@"my file.txt"');
  assert.strictEqual(formatFileMention("my dir", "directory"), '@"my dir/');
  assert.ok(
    !formatFileMention("my dir", "directory")!.endsWith('"'),
    "目录的 mention 不能闭合引号——否则用户没法继续往下打",
  );
  assert.ok(!formatFileMention("plain.ts")!.includes('"'), "无空格的路径不加引号");
}
console.log("references: 含空白路径加引号，目录只加开引号 ✓");

// ---------- 3. 含控制字符或 `"` 的路径无法引用 ----------

{
  assert.strictEqual(formatFileMention('has"quote.ts'), undefined, "含引号无法转义，拒绝");
  assert.strictEqual(formatFileMention("has\u0000nul.ts"), undefined);
  assert.strictEqual(formatFileMention("has\nnewline.ts"), undefined);
  assert.strictEqual(formatFileMention("ok/path.ts"), "@ok/path.ts", "正常路径不受影响");
}
console.log("references: 含控制字符/引号的路径拒绝引用 ✓");

// ---------- 4. 引用拼进正文：引用在前、正文在后，空正文只剩引用 ----------

{
  assert.strictEqual(
    composeWithReferences("看看这个", [{ path: "a.ts", kind: "file" }]),
    "@a.ts\n看看这个",
  );
  assert.strictEqual(
    composeWithReferences("  ", [{ path: "a.ts", kind: "file" }]),
    "@a.ts",
    "正文为空时只留引用（单独发一个引用是合法提示词）",
  );
  assert.strictEqual(composeWithReferences("没有引用", []), "没有引用");
  assert.strictEqual(
    composeWithReferences("多个", [
      { path: "a.ts", kind: "file" },
      { path: "src", kind: "directory" },
    ]),
    "@a.ts\n@src/\n多个",
    "多个引用各占一行、保持顺序",
  );
}
console.log("references: 引用拼进正文（引用在前，空正文只剩引用） ✓");

// ---------- 5. 非法引用被跳过，正文照发（不能因为一个坏路径整条发不出去） ----------

{
  const composed = composeWithReferences("正文", [
    { path: 'bad"quote.ts', kind: "file" },
    { path: "good.ts", kind: "file" },
  ]);
  assert.strictEqual(composed, "@good.ts\n正文", "坏引用被丢掉，好引用与正文都保留");
}
console.log("references: 非法引用单独跳过，不影响其余内容 ✓");

console.log("\nreferences: all assertions passed");
