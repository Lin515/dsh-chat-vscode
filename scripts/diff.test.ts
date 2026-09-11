import assert from "node:assert";
import { diffLines, hunkFromTexts, hunksFromMeta, hunksFromToolArgs } from "../src/shared/diff";

// 1. 新文件（oldText = null）：整体算新增
assert.deepStrictEqual(diffLines(null, "a\nb"), [
  { kind: "add", text: "a" },
  { kind: "add", text: "b" },
]);

// 2. 一处替换：上下文行保留，删除排在新增之前（双栏按此配对）
assert.deepStrictEqual(diffLines("a\nb\nc", "a\nB\nc"), [
  { kind: "context", text: "a" },
  { kind: "del", text: "b" },
  { kind: "add", text: "B" },
  { kind: "context", text: "c" },
]);

// 3. 结尾换行不产生多余的空行；纯追加
assert.deepStrictEqual(diffLines("a\n", "a\nb\n"), [
  { kind: "context", text: "a" },
  { kind: "add", text: "b" },
]);

// 4. 纯删除
assert.deepStrictEqual(diffLines("a\nb\nc", "a\nc"), [
  { kind: "context", text: "a" },
  { kind: "del", text: "b" },
  { kind: "context", text: "c" },
]);

// 5. 两侧相同 → 全是上下文（没有增删）
assert.deepStrictEqual(diffLines("x", "x"), [{ kind: "context", text: "x" }]);

// 6. 空 → 空
assert.deepStrictEqual(diffLines("", ""), []);

// 7. CRLF 归一化（服务端的 diff basis 是 LF，参数里可能是 CRLF）
assert.deepStrictEqual(diffLines("a\r\nb", "a\nc"), [
  { kind: "context", text: "a" },
  { kind: "del", text: "b" },
  { kind: "add", text: "c" },
]);

// 8. 大输入退化成「整块删除 + 整块新增」（不卡界面）
const bigBefore = Array.from({ length: 700 }, (_, i) => `old-${i}`).join("\n");
const bigAfter = Array.from({ length: 700 }, (_, i) => `new-${i}`).join("\n");
const big = diffLines(bigBefore, bigAfter);
assert.strictEqual(big.filter((line) => line.kind === "del").length, 700);
assert.strictEqual(big.filter((line) => line.kind === "add").length, 700);
assert.strictEqual(big.filter((line) => line.kind === "context").length, 0);

// 9. 工具参数推导：edit
const editHunks = hunksFromToolArgs(
  "edit",
  JSON.stringify({ file_path: "D:/x/a.ts", old_string: "a\nb", new_string: "a\nc" }),
);
assert.ok(editHunks && editHunks.length === 1);
assert.strictEqual(editHunks[0].path, "D:/x/a.ts");
assert.strictEqual(editHunks[0].added, 1);
assert.strictEqual(editHunks[0].removed, 1);
assert.deepStrictEqual(editHunks[0].lines, [
  { kind: "context", text: "a" },
  { kind: "del", text: "b" },
  { kind: "add", text: "c" },
]);

// 10. str_replace_editor 的字段名同样认得
const replaceHunks = hunksFromToolArgs(
  "str_replace_editor",
  JSON.stringify({ command: "str_replace", path: "/tmp/a", old_str: "1", new_str: "2" }),
);
assert.ok(replaceHunks && replaceHunks.length === 1);
assert.strictEqual(replaceHunks[0].added, 1);
assert.strictEqual(replaceHunks[0].removed, 1);

// 11. write：整篇算新增（没有 before）
const writeHunks = hunksFromToolArgs("write", JSON.stringify({ file_path: "a.txt", content: "x\ny" }));
assert.ok(writeHunks && writeHunks.length === 1);
assert.strictEqual(writeHunks[0].added, 2);
assert.strictEqual(writeHunks[0].removed, 0);

// 12. 非写文件工具、流式期半截 JSON → 不产出 diff
assert.strictEqual(hunksFromToolArgs("read", JSON.stringify({ file_path: "a" })), undefined);
assert.strictEqual(hunksFromToolArgs("edit", '{"file_path":"a","old_str'), undefined);
assert.strictEqual(hunksFromToolArgs("edit", "{}"), undefined);

// 13. 结果 meta（dsh-tool-fs 的 hunk，带 3 行上下文）
const metaHunks = hunksFromMeta({
  diffs: [
    { path: "a.ts", oldText: "1\n2\n3", newText: "1\nX\n3" },
    { path: "a.ts", oldText: null, newText: "brand new" },
  ],
});
assert.ok(metaHunks && metaHunks.length === 2);
assert.strictEqual(metaHunks[0].added, 1);
assert.strictEqual(metaHunks[0].removed, 1);
assert.strictEqual(metaHunks[1].added, 1);
assert.strictEqual(metaHunks[1].removed, 0);
assert.deepStrictEqual(metaHunks[1].lines, [{ kind: "add", text: "brand new" }]);

// 14. 坏 meta 一律当没有（不能抛错）
assert.strictEqual(hunksFromMeta(undefined), undefined);
assert.strictEqual(hunksFromMeta({}), undefined);
assert.strictEqual(hunksFromMeta({ diffs: [] }), undefined);
assert.strictEqual(hunksFromMeta({ diffs: [{ newText: 42 }] }), undefined);
assert.strictEqual(hunksFromMeta("nope"), undefined);

// 15. 超长 hunk 截断（保留计数，标记 truncated）
const longText = Array.from({ length: 1200 }, (_, i) => `line-${i}`).join("\n");
const longHunk = hunkFromTexts("big.txt", null, longText);
assert.strictEqual(longHunk.truncated, true);
assert.strictEqual(longHunk.lines.length, 800);
assert.strictEqual(longHunk.added, 1200);

console.log("diff: all assertions passed");
