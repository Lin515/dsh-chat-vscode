/**
 * 验证工具行的运行中数据：长命令要能完整带出，供展开区显示。
 *
 * 用户场景：`build` 这类工具跑起来很久（几分钟），单行标题里的命令被省略号截掉，
 * 而协议**没有**工具进度事件（`tool/result` 只在结束时落地），所以展开区至少要
 * 给出「完整命令 + 还在跑」，否则用户既不知道在跑什么、也不知道还在不在跑。
 *
 * 走真实的适配器路径（构造 SessionAdapter → 灌 tool/call 事件 → 看产出），
 * 而不是直接测内部函数。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";
import { filePathFrom } from "../src/shared/toolMeta";
import type { HostToWebview } from "../src/shared/ipc";
import type { ToolCallView } from "../src/shared/chat";

/** 灌一个 tool/call 事件，取回它产出的工具视图。 */
function toolFrom(name: string, args: unknown): ToolCallView {
  const frames: HostToWebview[] = [];
  const adapter = new SessionAdapter((frame) => frames.push(frame));
  adapter.applyEvent({
    type: "tool/call",
    seq: 1,
    time: Date.now(),
    data: { callId: "c1", name, arguments: JSON.stringify(args) },
  });
  const appended = frames.find((frame) => frame.type === "message/append");
  assert.ok(appended && appended.type === "message/append", `${name}: 应当产出 message/append`);
  const segment = appended.segment;
  assert.strictEqual(segment.kind, "tool");
  return (segment as Extract<typeof segment, { kind: "tool" }>).tool;
}

const LONG_BUILD = "cmake --build build-agent --config RelWithDebInfo --target dsh_chat_plugin --parallel 8";

// 1. build（外部工具，参数名就是 command）：完整命令必须原样带出
{
  const tool = toolFrom("build", { command: LONG_BUILD, workdir: "d:/dev/x", arch: "auto" });
  assert.strictEqual(tool.command, LONG_BUILD, "展开区要拿到未截断的命令");
  assert.strictEqual(tool.status, "running");
  assert.ok(tool.startedAt && tool.startedAt > 0, "要有开始时间，界面才能显示实时耗时");
  // `build` 不在官方的精确名表里 → `others` 变体：官方对未知工具**不猜字段**、
  // 摘要只取首行（不额外截断），长出来的部分由 CSS 省略号处理。
  assert.ok((tool.detail?.length ?? 0) <= 120, `标题摘要不该过长：${tool.detail}`);
}

// 1b. `others` 变体对**未知工具**不编造字段（官方 SUMMARY_KEYS.others 是空表）
{
  const tool = toolFrom("mcp__openviking__find", { query: "memory", limit: 5 });
  // 官方对未知工具退回「参数里第一个非空字符串」，所以能取到 query 当摘要
  assert.strictEqual(tool.detail, "memory");
}

// 1c. 「可打开的工程文件」这条语义**只**给 read/write/edit 变体
//
// 这是 `FILE_PATH_VARIANTS` 那道闸：`command` 只是「展开区要显示的完整文本」，
// 什么工具都可能有；而「这是不是工作区里的文件、能不能点开」是另一回事。
// 混为一谈会让未知工具的参数被当成可打开路径。
{
  assert.strictEqual(filePathFrom("read", { file_path: "a.ts" }), "a.ts");
  assert.strictEqual(filePathFrom("write", { path: "a.ts" }), "a.ts");
  assert.strictEqual(filePathFrom("edit", { file_path: "a.ts" }), "a.ts");
  // 未知工具即便参数里有 file_path，也不算文件（官方 FILE_PATH_VARIANTS 只含三者）
  assert.strictEqual(filePathFrom("some_unknown_tool", { file_path: "D:/x/y.ts" }), undefined);
  // `read` 变体里的 `web_fetch` 用 url：官方**刻意**不把 url 当路径键
  assert.strictEqual(filePathFrom("web_fetch", { url: "https://example.com/a" }), undefined);
  // 空白路径不算
  assert.strictEqual(filePathFrom("read", { file_path: "   " }), undefined);
}
console.log("toolView: others 变体不编造文件语义；路径语义只给 read/write/edit ✓");
console.log("toolView: build 完整命令 ✓");

// 2. pwsh/bash：同样带出完整命令（标题截断、展开区完整）
{
  const long = `python -c "${"x".repeat(200)}"`;
  const tool = toolFrom("pwsh", { command: long });
  assert.strictEqual(tool.command, long);
  assert.notStrictEqual(tool.detail, long, "标题应被截断，展开区才是完整命令");
}
console.log("toolView: pwsh 完整命令 ✓");

// 3. read/write/edit：command 取完整路径，detail 也是完整路径
//
// detail 刻意**不**在宿主侧预先缩短：省略口径是「保住文件名、省略前段路径」，
// 由界面按可用宽度执行（webview/pathDisplay.ts 的 splitPath + `.row-detail-dir`）。
// 宿主预缩短会让宽面板也只看到末两段，且窄侧栏里文件名仍可能被右省略切掉。
{
  const path = "D:/dev/very/deep/nested/folder/structure/src/server/index.ts";
  const tool = toolFrom("read", { file_path: path });
  assert.strictEqual(tool.command, path);
  assert.strictEqual(tool.detail, path, "detail 要给完整路径，省略交给界面做");
}
console.log("toolView: 读文件完整路径（省略交给界面） ✓");

// 4. 认不出参数的未知工具：不编造命令，但仍要给到 startedAt（界面才能发光/计时）
{
  const tool = toolFrom("some_external_tool", { whatever: 42 });
  assert.strictEqual(tool.command, undefined, "认不出就不该编一个命令出来");
  assert.strictEqual(tool.status, "running");
  assert.ok(tool.startedAt && tool.startedAt > 0);
}
console.log("toolView: 未知工具不编造命令 ✓");

// 5. 参数是半截 JSON（流式期）：不能抛错，仍建立 running 行
{
  const frames: HostToWebview[] = [];
  const adapter = new SessionAdapter((frame) => frames.push(frame));
  adapter.applyEvent({
    type: "tool/call",
    seq: 2,
    time: Date.now(),
    data: { callId: "c2", name: "build", arguments: '{"command":"cmake --bu' },
  });
  const appended = frames.find((f) => f.type === "message/append");
  assert.ok(appended && appended.type === "message/append");
  const segment = appended.segment as Extract<typeof appended.segment, { kind: "tool" }>;
  assert.strictEqual(segment.tool.status, "running");
  assert.strictEqual(segment.tool.command, undefined, "半截 JSON 解析不出命令");
  assert.strictEqual(segment.tool.input, '{"command":"cmake --bu', "原始载荷仍保留");
}
console.log("toolView: 半截 JSON 不崩 ✓");

// 6. 同一 callId 的后续更新会刷新 command（流式参数补全后）
{
  const frames: HostToWebview[] = [];
  const adapter = new SessionAdapter((frame) => frames.push(frame));
  const time = Date.now();
  adapter.applyEvent({
    type: "tool/call", seq: 1, time,
    data: { callId: "c3", name: "build", arguments: '{"command":"cmake' },
  });
  adapter.applyEvent({
    type: "tool/call", seq: 2, time: time + 10,
    data: { callId: "c3", name: "build", arguments: JSON.stringify({ command: LONG_BUILD }) },
  });
  const updates = frames.filter((f) => f.type === "message/segment");
  assert.ok(updates.length >= 1, "同一调用应当发 message/segment 更新");
  const last = updates[updates.length - 1] as Extract<HostToWebview, { type: "message/segment" }>;
  const segment = last.segment as Extract<typeof last.segment, { kind: "tool" }>;
  assert.strictEqual(segment.tool.command, LONG_BUILD, "补全后应当刷新为完整命令");
}
console.log("toolView: 参数补全后刷新命令 ✓");

console.log("\ntoolView: all assertions passed");
