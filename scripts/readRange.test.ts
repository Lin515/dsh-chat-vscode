/**
 * 验证读取节点的行号区间解析。
 *
 * 目标：只读了一段时把行号缀到文件名后（`…/controller.ts:100-120`），
 * 整篇读取不标注。
 *
 * 数据来源两条，meta 优先：
 *  - `tool/result.meta` = `{path, offset, lines:[{number,text}], totalLines, lang}`
 *    （dsh-tool-fs 的 presentationMeta，真实抓包确认过）；
 *  - 正文尾注三种变体 + `N: ` 编号行（meta 缺失时回退）。
 *
 * 注意界面渲染走的是 `tool.readLines`（单独一段不可压缩的后缀），
 * 不是 `formatReadDetail` 拼出来的字符串——`detail` 从右侧省略，拼进去会被截掉。
 * 这里对两条路径都做断言。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";
import {
  formatReadDetail,
  readRangeFromMeta,
  readRangeFromOutput,
} from "../src/dsh/readRange";

// ---------- 1. meta 路径（权威） ----------

// 部分读取：offset=100 读到 120，共 2205 行
{
  const range = readRangeFromMeta({
    path: "D:/dev/x/controller.ts",
    offset: 100,
    lines: [{ number: 100, text: "a" }, { number: 120, text: "b" }],
    totalLines: 2205,
  });
  assert.ok(range);
  assert.deepStrictEqual(
    { start: range.start, end: range.end, total: range.total, partial: range.partial },
    { start: 100, end: 120, total: 2205, partial: true },
  );
  assert.strictEqual(formatReadDetail("…/dsh/controller.ts", range), "…/dsh/controller.ts:100-120");
}
console.log("readRange: meta 部分读取 ✓");

// 整篇读取：1..total → 不加后缀
{
  const range = readRangeFromMeta({
    offset: 1,
    lines: [{ number: 1, text: "a" }, { number: 62, text: "b" }],
    totalLines: 62,
  });
  assert.ok(range);
  assert.strictEqual(range.partial, false, "1..total 是整篇，不该标注");
  assert.strictEqual(formatReadDetail("…/dsh/package.json", range), undefined);
}
console.log("readRange: meta 整篇读取不加后缀 ✓");

// offset>1 且读到文件末尾（End of file 那种）：仍是部分读取
{
  const range = readRangeFromMeta({
    offset: 61,
    lines: [{ number: 61, text: "a" }, { number: 62, text: "b" }],
    totalLines: 62,
  });
  assert.ok(range);
  assert.strictEqual(range.partial, true, "从 61 行读到结尾只覆盖了尾部，仍算部分读取");
  assert.strictEqual(formatReadDetail("f.txt", range), "f.txt:61-62");
}
console.log("readRange: meta 尾部片段仍标注 ✓");

// 空文件 / 畸形 meta：不产生区间，不抛错
{
  assert.strictEqual(readRangeFromMeta({ offset: 1, lines: [], totalLines: 0 }), undefined, "空文件无区间");
  assert.strictEqual(readRangeFromMeta(undefined), undefined);
  assert.strictEqual(readRangeFromMeta(null), undefined);
  assert.strictEqual(readRangeFromMeta("nope"), undefined);
  assert.strictEqual(readRangeFromMeta({ totalLines: "x", lines: [{}] }), undefined, "类型不对应拒绝");
  assert.strictEqual(readRangeFromMeta({ totalLines: 5, lines: [{ text: "无 number" }] }), undefined);
}
console.log("readRange: 畸形 meta 安全忽略 ✓");

// ---------- 2. 正文回退（meta 缺失） ----------

// 变体 2：Showing lines A-B of N
{
  const text = [
    "<path>a.ts</path>",
    "<type>file</type>",
    "<content>",
    "1: x",
    "2: y",
    "(Showing lines 1-2 of 100. Use offset=3 to continue.)",
    "</content>",
  ].join("\n");
  const range = readRangeFromOutput(text);
  assert.ok(range);
  assert.deepStrictEqual(
    { start: range.start, end: range.end, total: range.total, partial: range.partial },
    { start: 1, end: 2, total: 100, partial: true },
  );
}
console.log("readRange: Showing lines A-B of N ✓");

// 变体 3：Output capped（按字节截断，没有总数）
{
  const text = "1: x\n120: y\n(Output capped. Showing lines 1-120. Use offset=121 to continue.)";
  const range = readRangeFromOutput(text);
  assert.ok(range);
  assert.deepStrictEqual({ start: range.start, end: range.end, total: range.total }, { start: 1, end: 120, total: undefined });
  assert.strictEqual(range.partial, true, "按字节截断一定是部分读取");
}
console.log("readRange: Output capped ✓");

// 变体 1a：End of file + 从第 1 行开始 → 整篇
{
  const text = "1: #include <thread>\n2: int main() {}\n(End of file - total 2 lines)";
  const range = readRangeFromOutput(text);
  assert.ok(range);
  assert.strictEqual(range.partial, false);
  assert.strictEqual(formatReadDetail("a.cpp", range), undefined);
}
console.log("readRange: End of file（整篇）✓");

// 变体 1b：End of file 但从 offset=101 读起 → 部分读取（起始行靠内容行号得出）
{
  const text = "101: x\n163: y\n(End of file - total 163 lines)";
  const range = readRangeFromOutput(text);
  assert.ok(range);
  assert.deepStrictEqual({ start: range.start, end: range.end, total: range.total, partial: range.partial }, {
    start: 101, end: 163, total: 163, partial: true,
  });
}
console.log("readRange: End of file（从中间读到结尾）✓");

// 非文件类输出（运行命令、搜索结果）：不产生区间
{
  assert.strictEqual(readRangeFromOutput("total 3\nsrc/a.ts:12"), undefined);
  assert.strictEqual(readRangeFromOutput(""), undefined);
  // 有编号行但没有尾注：不认（避免把普通输出里的 `1: ` 当成文件行号）
  assert.strictEqual(readRangeFromOutput("1: alpha\n2: beta"), undefined);
}
console.log("readRange: 非读取输出不误判 ✓");

// ---------- 3. 空文件尾注 ----------

{
  // 空文件的正文只有尾注、没有编号行
  const range = readRangeFromOutput("(End of file - total 0 lines)");
  assert.strictEqual(range, undefined, "空文件不该标注行号");
}
console.log("readRange: 空文件 ✓");

// ---------- 4. 适配器把它落到 tool.readLines（界面真正读的字段） ----------

{
  const frames: import("../src/shared/ipc").HostToWebview[] = [];
  const adapter = new SessionAdapter((frame) => frames.push(frame as never));

  const feed = (name: string, args: unknown, resultMeta: unknown, output: string) => {
    adapter.applyEvent({
      type: "tool/call", seq: 1, time: Date.now(),
      data: { callId: "c1", name, arguments: JSON.stringify(args) },
    });
    adapter.applyEvent({
      type: "tool/result", seq: 2, time: Date.now() + 5,
      data: {
        message: { source: { callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: output }] }] },
        meta: resultMeta,
      },
    });
  };
  const lastTool = () => {
    const seg = [...frames].reverse().find((f) => f.type === "message/segment");
    assert.ok(seg && seg.type === "message/segment");
    const segment = seg.segment as Extract<typeof seg.segment, { kind: "tool" }>;
    return segment.tool;
  };

  // 部分读取：meta 带区间 → readLines 落上
  feed(
    "read",
    { file_path: "D:/dev/x/controller.ts", offset: 100, limit: 20 },
    { path: "D:/dev/x/controller.ts", offset: 100, totalLines: 2205, lines: [{ number: 100, text: "a" }, { number: 120, text: "b" }] },
    "100: a\n120: b\n(Showing lines 100-120 of 2205. Use offset=121 to continue.)",
  );
  assert.deepStrictEqual(lastTool().readLines, { start: 100, end: 120 });

  // 整篇读取：不落 readLines（界面也就不会加后缀）
  frames.length = 0;
  feed(
    "read",
    { file_path: "D:/dev/x/package.json" },
    { path: "D:/dev/x/package.json", offset: 1, totalLines: 2, lines: [{ number: 1, text: "a" }, { number: 2, text: "b" }] },
    "1: a\n2: b\n(End of file - total 2 lines)",
  );
  assert.strictEqual(lastTool().readLines, undefined, "整篇读取不该标注行号");

  // meta 缺失：靠正文尾注回退
  frames.length = 0;
  feed("read", { file_path: "D:/dev/x/a.ts", offset: 1 }, undefined, "1: x\n2: y\n(Showing lines 1-2 of 100. Use offset=3 to continue.)");
  assert.deepStrictEqual(lastTool().readLines, { start: 1, end: 2 });

  // 非读取工具：永不落 readLines
  frames.length = 0;
  feed("pwsh", { command: "npm test" }, undefined, "1: 看起来像行号\n(Showing lines 1-1 of 9. Use offset=2 to continue.)");
  assert.strictEqual(lastTool().readLines, undefined, "非读取工具不该被误标注");
}
console.log("readRange: 适配器落到 tool.readLines ✓");

console.log("\nreadRange: all assertions passed");
