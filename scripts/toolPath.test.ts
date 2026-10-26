/**
 * 工具路径模型的取值矩阵：工具行、产物、终端标签各按自己的判据。
 *
 * 官方三处规则故意不同（`toolRowModel` / `mutationResultPath` / `terminalCardModel`），
 * 本文件把它们钉在**同一个纯函数层**，再用适配器测试钉住实时结算与历史重放走同一路径。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import {
  argumentPathOf,
  mutationResultPath,
  terminalCwdOf,
  toolRowFilePath,
} from "../src/shared/toolPath";

// ---------- 1. 参数路径：file_path 优先（含流式半截里的完整字段），path 仅整份 JSON ----------
{
  assert.strictEqual(argumentPathOf("read", JSON.stringify({ file_path: "src/a.ts" })), "src/a.ts");
  assert.strictEqual(argumentPathOf("write", JSON.stringify({ path: "src/b.ts" })), "src/b.ts");
  assert.strictEqual(
    argumentPathOf("edit", JSON.stringify({ path: "src/first.ts", file_path: "src/second.ts" })),
    "src/second.ts",
    "file_path 优先于 path（官方 argumentSummary 先读 file_path）",
  );
  assert.strictEqual(
    argumentPathOf("read", '{"file_path":"/B/a.ts","content":"still streaming'),
    "/B/a.ts",
    "流式载荷里 file_path 已闭合时可用",
  );
  assert.strictEqual(
    argumentPathOf("read", '{"file_path":"/B/a.ts\\nignored","content":'),
    "/B/a.ts",
    "路径字段按官方 firstLine 只取首行",
  );
  assert.strictEqual(argumentPathOf("read", '{"file_path":"/B/unfin'), undefined, "路径字段本身半截不可用");
  assert.strictEqual(
    argumentPathOf("read", '{"file_path":"/B/\\q.ts","content":"unfinished'),
    undefined,
    "非法转义不能猜出一个路径",
  );
  assert.strictEqual(
    argumentPathOf("read", '{"payload":{"file_path":"/nested/a.ts"},"content":"x'),
    undefined,
    "嵌套对象里的同名键不是顶层参数",
  );
  // path 的兜底仍要求整份 JSON 合法（官方不对 path 用增量视图）
  assert.strictEqual(argumentPathOf("read", '{"path":"/B/a.ts","content":"unfinished'), undefined);
  // 非文件变体 / 非对象 / 空字段
  assert.strictEqual(argumentPathOf("some_tool", JSON.stringify({ file_path: "/a" })), undefined);
  // `web_fetch` 落在 read 变体：正常情况下只有 url；若显式给了 file_path，官方同样按
  // 路径变体读取（这里不为求「看起来合理」而改写官方判据）。
  assert.strictEqual(argumentPathOf("web_fetch", JSON.stringify({ url: "https://example.com/a" })), undefined);
  assert.strictEqual(argumentPathOf("web_fetch", JSON.stringify({ file_path: "/a" })), "/a");
  assert.strictEqual(argumentPathOf("read", "[]"), undefined);
  assert.strictEqual(argumentPathOf("read", JSON.stringify({ file_path: "" })), undefined);
  assert.strictEqual(argumentPathOf("read", JSON.stringify({ file_path: "   " })), "   ");
}
console.log("toolPath: 参数路径的精确参数门（含流式完整 file_path，path 不增量） ✓");

// ---------- 2. 工具行：记录值覆盖已有参数路径，不凭空造动作 ----------
const row = (extra: Partial<Parameters<typeof toolRowFilePath>[0]>) =>
  toolRowFilePath({
    name: "write",
    argsRaw: JSON.stringify({ file_path: "src/a.ts", content: "x" }),
    settled: true,
    isError: false,
    ...extra,
  });
{
  assert.strictEqual(row({}), "src/a.ts", "成功结算的根调用可用相对参数");
  assert.strictEqual(row({ meta: { path: "/exec/a.ts" } }), "/exec/a.ts", "绝对记录值优先");
  assert.strictEqual(row({ meta: { path: "relative/invalid" } }), "src/a.ts", "无效记录值不阻断参数回退");
  assert.strictEqual(row({ argsRaw: JSON.stringify({ file_path: "/abs/a.ts" }) }), "/abs/a.ts");
  // 运行中 / 失败 / 嵌套：相对参数不可用；绝对参数仍可直接用
  assert.strictEqual(row({ settled: false }), undefined);
  assert.strictEqual(row({ settled: false, argsRaw: JSON.stringify({ file_path: "/abs/a.ts" }) }), "/abs/a.ts");
  assert.strictEqual(row({ isError: true }), undefined);
  assert.strictEqual(row({ parentCallId: "root" }), undefined);
  assert.strictEqual(
    row({ parentCallId: "root", argsRaw: JSON.stringify({ file_path: "/abs/a.ts" }) }),
    "/abs/a.ts",
    "嵌套调用不禁止绝对参数",
  );
  // 记录值不另加成功条件：失败 / 嵌套也能用绝对记录值
  assert.strictEqual(row({ isError: true, meta: { path: "/exec/a.ts" } }), "/exec/a.ts");
  assert.strictEqual(row({ parentCallId: "root", meta: { path: "/exec/a.ts" } }), "/exec/a.ts");
  // 没有参数路径时，孤立的 meta.path 不新增动作
  assert.strictEqual(
    row({ argsRaw: JSON.stringify({ content: "x" }), meta: { path: "/exec/a.ts" } }),
    undefined,
  );
  // 运行中不读 meta（还没有结算结果）
  assert.strictEqual(row({ settled: false, meta: { path: "/exec/a.ts" } }), undefined);
}
console.log("toolPath: 工具行记录值优先、参数门分运行/成功/失败/嵌套 ✓");

// ---------- 3. 产物：官方 mutationResultPath 三档，独立于工具行 ----------
{
  assert.strictEqual(mutationResultPath("src/a.ts", {}), "src/a.ts", "没有自有 path 键 → 旧结果参数回退");
  assert.strictEqual(mutationResultPath("src/a.ts", null), "src/a.ts");
  assert.strictEqual(mutationResultPath("src/a.ts", { path: "/exec/a.ts" }), "/exec/a.ts");
  assert.strictEqual(
    mutationResultPath("src/a.ts", { path: "relative/invalid" }),
    null,
    "自有 path 无效且参数相对 → 不登记（工具行却仍可保留动作）",
  );
  assert.strictEqual(
    mutationResultPath("/exec/a.ts", { path: "relative/invalid" }),
    "/exec/a.ts",
    "自有 path 无效但参数绝对 → 保留参数",
  );
  assert.strictEqual(mutationResultPath("src/a.ts", { path: "" }), null);
  assert.strictEqual(mutationResultPath("src/a.ts", { path: 42 }), null);
  assert.strictEqual(mutationResultPath("/exec/a.ts", { path: 42 }), "/exec/a.ts");
  // 自有键（含值为 undefined）与继承键的区别：官方用 Object.hasOwn
  assert.strictEqual(mutationResultPath("src/a.ts", { path: undefined }), null);
  const inherited = Object.create({ path: "/exec/a.ts" }) as unknown;
  assert.strictEqual(mutationResultPath("src/a.ts", inherited), "src/a.ts");
}
console.log("toolPath: 产物三档独立（无效 meta 时工具行可保留、产物不登记） ✓");

// ---------- 4. 终端目录：记录 cwd 原样；旧根调用按创建目录回退；运行/嵌套不猜 ----------
const cwd = (extra: Partial<Parameters<typeof terminalCwdOf>[0]>) =>
  terminalCwdOf({
    name: "bash",
    argsRaw: JSON.stringify({ command: "echo x", workdir: "sub", description: "inspect" }),
    settled: true,
    sessionCwd: "/A",
    ...extra,
  });
{
  // 记录值原样保留，不做 normalize（官方 terminalCardModel 同口径）
  assert.strictEqual(cwd({ meta: { cwd: "/B/../recorded" } }), "/B/../recorded");
  assert.strictEqual(cwd({ meta: { cwd: "relative/invalid" } }), "/A/sub", "相对记录值无效 → 旧回退");
  // 旧根调用：相对 workdir 拼创建目录并 normalize；省略显示创建目录
  assert.strictEqual(cwd({}), "/A/sub");
  assert.strictEqual(
    cwd({ argsRaw: JSON.stringify({ command: "pwd", workdir: "../B/./x", description: "x" }) }),
    "/B/x",
  );
  assert.strictEqual(cwd({ argsRaw: JSON.stringify({ command: "pwd", description: "x" }) }), "/A");
  // 缺创建目录：相对拼写仍是相对展示
  assert.strictEqual(cwd({ sessionCwd: undefined }), "sub");
  assert.strictEqual(cwd({ sessionCwd: undefined, argsRaw: JSON.stringify({ command: "pwd" }) }), undefined);
  // 运行中：只认绝对 workdir，不替相对 / 省略参数猜目录
  assert.strictEqual(cwd({ settled: false }), undefined);
  assert.strictEqual(
    cwd({ settled: false, argsRaw: JSON.stringify({ command: "pwd", workdir: "/B/../run", description: "x" }) }),
    "/run",
  );
  // 嵌套：settled 也不拿创建目录回退；绝对 workdir 仍可用于展示
  assert.strictEqual(cwd({ parentCallId: "root" }), undefined);
  assert.strictEqual(
    cwd({ parentCallId: "root", argsRaw: JSON.stringify({ command: "pwd", workdir: "/B/sub", description: "x" }) }),
    "/B/sub",
  );
  // terminal_send：settled 认绝对记录 cwd；running 没有记录值
  const send = JSON.stringify({ sessionId: "term-1", text: "pwd" });
  assert.strictEqual(
    terminalCwdOf({ name: "terminal_send", argsRaw: send, settled: true, meta: { cwd: "/B/term" } }),
    "/B/term",
  );
  assert.strictEqual(
    terminalCwdOf({ name: "terminal_send", argsRaw: send, settled: true, meta: { cwd: "relative" } }),
    undefined,
  );
  assert.strictEqual(
    terminalCwdOf({ name: "terminal_send", argsRaw: send, settled: false, meta: { cwd: "/B/term" } }),
    undefined,
  );
  // 参数残缺的 shell / terminal_send 不产生目录标签
  assert.strictEqual(cwd({ argsRaw: '{"command":' }), undefined);
  assert.strictEqual(
    terminalCwdOf({ name: "terminal_send", argsRaw: '{"sessionId":"t"}', settled: true, meta: { cwd: "/B" } }),
    undefined,
  );
  // description 缺省按持久 shell 处理（结算后没有终端卡），目录标签仍取 workdir
  assert.strictEqual(
    cwd({ settled: false, argsRaw: JSON.stringify({ command: "pwd", workdir: "/B/sub" }) }),
    "/B/sub",
    "持久 shell 的绝对 workdir 仍可作为运行中标签",
  );
  assert.strictEqual(
    cwd({ argsRaw: JSON.stringify({ command: "pwd", description: 42 }) }),
    undefined,
    "description 非字符串时官方不建终端卡",
  );
  assert.strictEqual(
    cwd({ argsRaw: JSON.stringify({ command: "pwd", description: "x", timeoutMs: 0 }) }),
    undefined,
    "timeoutMs 非正数时官方不建终端卡",
  );
}
console.log("toolPath: 终端记录 cwd 原样、旧根调用回退、运行/嵌套/terminal_send 分档 ✓");

console.log("\ntoolPath: all assertions passed");
