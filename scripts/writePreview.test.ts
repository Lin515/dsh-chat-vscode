/** 离线：与 ToolRow 相同的累计参数解析 seam；不读磁盘源文件或用户日志，不连接 DSH。 */
import assert from "node:assert/strict";
import { WritePreviewReader } from "../src/webview/writePreview";

const decode = (input: string, name = "write") => new WritePreviewReader().update("call", name, input);
const contents = ["", "a\nb\r\n\t  tail  \n", String.raw`literal\n and \u0041 and \\"`, '<script>alert("x")</script>\n# not markdown', "鲸🐳𐀀", "\b\f\t/\\\"", "\ud800", "\udc00", "\ud800x\ud800\udc00"];
const samples = contents.flatMap((content) => [
  JSON.stringify({ file_path: "a.ts", content }),
  JSON.stringify({ content, file_path: "a.ts", other: [false, null, -1.2e3, { content: "ignore" }] }),
]);
samples.push(String.raw` { "co\u006etent" : "\uD83D\uDC33\r\n\u0041\/\"\\\t\b\f", "x": [true, 0, {}] } `);
for (const input of samples) {
  const expected = JSON.parse(input).content as string;
  assert.deepEqual(decode(input), { text: expected, complete: true });
  // 所有两段切分，包括反斜杠、unicode四位、代理对、闭引号和闭对象中间。
  for (let cut = 0; cut <= input.length; cut++) {
    const reader = new WritePreviewReader();
    reader.update("call", "write", input.slice(0, cut));
    assert.deepEqual(reader.update("call", "write", input), { text: expected, complete: true });
  }
  const reader = new WritePreviewReader();
  for (let length = 0; length <= input.length; length++) {
    const prefix = input.slice(0, length);
    const actual = reader.update("call", "write", prefix);
    assert.deepEqual(actual, decode(prefix), "逐字符累计与重新打开同一快照必须等价");
    if (actual) assert.ok(expected.startsWith(actual.text), "只展示已确定文本前缀");
    assert.deepEqual(reader.update("call", "write", prefix), actual, "重复render/快照幂等");
  }
}

for (const input of [
  '{"description":"content: fake"}', '{"other":{"content":"nested"}}',
  '[{"content":"array"}]', '"content"', '{"content":42}', '{"content":null}',
  '{"file_path":"content", "note":"\\\"content\\\":\\\"fake"}',
  '{"content"', '{"content":',
]) assert.equal(decode(input), undefined, input);
for (const name of ["edit", "mcp__write", "Write", "read", "write_file"])
  assert.equal(decode('{"content":"do not decode"}', name), undefined);

const prefix = String.raw`{"content":"line\n`;
assert.deepEqual(decode(prefix), { text: "line\n", complete: false });
assert.deepEqual(decode('{"content":""'), { text: "", complete: false });
assert.deepEqual(decode('{"content":"done","file_path":'), { text: "done", complete: false });
assert.deepEqual(decode(String.raw`{"content":"x\uD83D`), { text: "x", complete: false });
assert.deepEqual(decode(String.raw`{"content":"x\uD83D\uDC`), { text: "x", complete: false });
assert.deepEqual(decode(String.raw`{"content":"x\\n`), { text: String.raw`x\n`, complete: false });
for (const input of [
  String.raw`{"content":"bad\q"}`, String.raw`{"content":"bad\u00z0"}`, '{"content":"bad\nraw"}',
  '{"content":"x",}', '{"content":"x"} garbage', '{"content":"x","content":"y"}',
  '{"content":"x","co\\u006etent":"y"}', '{"content":"x","other":01}',
  '{"content":"x","other":tru}', '{"content":"x","other":[1,]}',
  '{"content":"x" "other":"y"}', '{"content":"x", other: 1}',
  '{"content":"x","other":{"a":}}', '{"content":"x","other":[}',
  '{"content":"x","other":' + '['.repeat(128),
]) {
  const reader = new WritePreviewReader();
  for (let i = 1; i <= input.length; i++) reader.update("call", "write", input.slice(0, i));
  assert.equal(reader.update("call", "write", input), undefined, `无效输入安全回退：${input}`);
}

const reader = new WritePreviewReader();
assert.equal(reader.update("a", "write", '{"content":"old"}')?.text, "old");
assert.equal(reader.update("a", "write", '{"content":"new"}')?.text, "new", "同长替换");
assert.equal(reader.update("a", "write", '{"content":"n')?.text, "n", "截短重置");
assert.equal(reader.update("a", "write", ""), undefined, "清空重置");
reader.update("a", "write", prefix);
assert.equal(reader.update("b", "write", '{"content":"fresh"}')?.text, "fresh", "换身份重置");
assert.equal(reader.update("b", "edit", '{"content":"fresh"}'), undefined, "换工具立即失效");
assert.equal(reader.update("b", "write", '{"content":"back"}')?.text, "back");
reader.update("b", "write", '{"content":"bad\\q"}');
assert.equal(reader.update("b", "write", '{"content":"recovered"}')?.text, "recovered", "无效后被新快照替换可恢复");

// 大文本追加的解析路径，不用耗时阈值伪装成整链线性性能保证。
const large = JSON.stringify({ content: "  line\\n\r\n".repeat(20000) });
const largeReader = new WritePreviewReader();
for (let n = 1024; n < large.length; n += 1024) largeReader.update("large", "write", large.slice(0, n));
assert.equal(largeReader.update("large", "write", large)?.text, JSON.parse(large).content);
console.log("writePreview: 解码/所有切分/根键语法/无效回退/身份与快照重置/重放幂等/大文本追加 ✓");
