/**
 * 「本轮产出文件」的推导（`producedPath`）。
 *
 * 背景：`deliverables/presented` 只有 `present` 工具会发，而绝大多数改动是
 * write / edit 直接落盘的——官方因此**另外**从成功的变更调用参数里推导一份
 * 「本轮文件改动」列表（`dsh-client-ui-deliverables` 的 `producedForClosing`），
 * 不指望模型在收尾正文里点名。本扩展此前只有 `deliverables` 一条来源、且从不渲染，
 * 于是写过的文件在界面上完全不可见（docs/audit-summary.md「交付文件完全不可见」一条）。
 *
 * 判定逐字对齐官方 `mutationPath`：只认**成功的**第一方变更调用，参数残缺、
 * 读类工具、不认识的工具一律不算。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { producedPath } from "../src/dsh/produced";

const args = (value: unknown) => JSON.stringify(value);

// ---------- 1. 三种受支持的变更调用 ----------

assert.strictEqual(producedPath("write", args({ file_path: "a.ts", content: "x" })), "a.ts");
assert.strictEqual(
  producedPath("edit", args({ file_path: "b.ts", old_string: "a", new_string: "b" })),
  "b.ts",
);
assert.strictEqual(
  producedPath("str_replace_editor", args({ command: "create", path: "c.ts", file_text: "x" })),
  "c.ts",
);
console.log("produced: 三种变更调用都能取出路径 ✓");

// ---------- 2. 路径保持原样拼写（不归一化，界面拿它直接开文件） ----------

assert.strictEqual(
  producedPath("write", args({ file_path: "src\\sub/odd name.ts", content: "" })),
  "src\\sub/odd name.ts",
  "路径必须原样保留：归一化后 openFile 可能打不开",
);
assert.strictEqual(producedPath("write", args({ file_path: "  a.ts  ", content: "x" })), "  a.ts  ");
console.log("produced: 路径原样保留（含空格与混合分隔符） ✓");

// ---------- 3. 参数残缺 / 非变更调用一律不算 ----------
//
// 这一组是**假阳性防线**：把没真正写成功的调用算进去，会让「本轮文件改动」
// 多出用户根本没改过的文件。

{
  // 读类工具即使带了 file_path 也不算
  assert.strictEqual(producedPath("read", args({ file_path: "a.ts" })), undefined);
  assert.strictEqual(producedPath("read_image", args({ file_path: "a.png" })), undefined);
  // 不认识的工具
  assert.strictEqual(producedPath("pwsh", args({ command: "echo hi" })), undefined);
  // write 少了 content
  assert.strictEqual(producedPath("write", args({ file_path: "a.ts" })), undefined);
  // write 少了路径
  assert.strictEqual(producedPath("write", args({ content: "x" })), undefined);
  // 空白路径
  assert.strictEqual(producedPath("write", args({ file_path: "   ", content: "x" })), undefined);
}
console.log("produced: 读类/未知工具/残缺参数都不算产出 ✓");

// ---------- 4. edit 的字段校验与 str_replace_editor 的子命令校验 ----------

{
  // old_string 与 new_string 相同 = 空改动，官方同样不算
  assert.strictEqual(
    producedPath("edit", args({ file_path: "a.ts", old_string: "same", new_string: "same" })),
    undefined,
  );
  assert.strictEqual(
    producedPath("edit", args({ file_path: "a.ts", old_string: "", new_string: "b" })),
    undefined,
  );
  assert.strictEqual(producedPath("edit", args({ file_path: "a.ts", new_string: "b" })), undefined);
  assert.strictEqual(
    producedPath("edit", args({ file_path: "a.ts", old_string: "a", new_string: "b", replace_all: "yes" })),
    undefined,
    "replace_all 不是布尔值时参数不合法",
  );
  assert.strictEqual(
    producedPath("edit", args({ file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true })),
    "a.ts",
  );
}

{
  const editor = (extra: Record<string, unknown>) =>
    producedPath("str_replace_editor", args({ path: "a.ts", ...extra }));
  // 只读子命令 view 不算变更
  assert.strictEqual(editor({ command: "view" }), undefined);
  // create 缺 file_text
  assert.strictEqual(editor({ command: "create" }), undefined);
  // str_replace 缺 old_str
  assert.strictEqual(editor({ command: "str_replace", new_str: "b" }), undefined);
  assert.strictEqual(editor({ command: "str_replace", old_str: "", new_str: "b" }), undefined);
  assert.strictEqual(editor({ command: "str_replace", old_str: "a", new_str: "b" }), "a.ts");
  // insert 的 insert_line 必须是 >= 0 的整数
  assert.strictEqual(editor({ command: "insert", insert_line: -1, new_str: "b" }), undefined);
  assert.strictEqual(editor({ command: "insert", insert_line: 1.5, new_str: "b" }), undefined);
  assert.strictEqual(editor({ command: "insert", insert_line: 0, new_str: "b" }), "a.ts");
}
console.log("produced: edit / str_replace_editor 的子命令与字段校验逐条生效 ✓");

// ---------- 5. 流式期参数还不是合法 JSON：不能抛，也不能算 ----------

assert.strictEqual(producedPath("write", '{"file_path": "a.ts", "cont'), undefined);
assert.strictEqual(producedPath("write", ""), undefined);
assert.strictEqual(producedPath("write", "[]"), undefined, "参数是数组不是对象");
assert.strictEqual(producedPath("write", "null"), undefined);
console.log("produced: 非 JSON / 非对象参数安全返回 undefined ✓");

console.log("\nproduced: all assertions passed");
