/**
 * 工具行的契约事实。
 *
 * 三条此前与官方不一致、用户可感知的行为：
 * 1. 工具分类用**子串启发**（`includes("web")`）→ 自定义工具名会被误分类；
 * 2. 终端结果的 `[exit code: N]` / `[killed by signal: X]` 从未解析 → 失败的
 *    命令在界面上和成功长得一样；
 * 3. 工具行只有 running/ok/error，缺官方的 `stopped`（中断）。
 *
 * 依据逐字来自 `@deepseek-ai/dsh-client-ui-tool/lib/client.js`：
 * `TOOL_VARIANTS`/`TOOL_TITLE_KEYS`（:805-849）、`parseExitStatus`（:656-677）、
 * `terminalFailed`（:513-525）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
  classifyTool,
  parseExitStatus,
  summaryKeys,
  terminalFailed,
  toolTitleKey,
} from "../src/shared/toolMeta";

// ---------- 1. TOOL_VARIANTS 是**精确名表**，不是子串启发 ----------

{
  // 官方表里的 16 项逐一核对
  const expected: [string, string][] = [
    ["bash", "bash"],
    ["pwsh", "bash"],
    ["read", "read"],
    ["read_image", "read"],
    ["web_fetch", "read"],
    ["web_search", "search"],
    ["grep", "search"],
    ["glob", "search"],
    ["write", "write"],
    ["edit", "edit"],
    ["run_code", "code"],
    ["cordis_package_inspect", "read"],
    ["cordis_runtime_inspect", "read"],
    ["cordis_run", "others"],
    ["cordis_stop", "others"],
    ["cordis_undefine", "others"],
  ];
  for (const [name, variant] of expected) {
    assert.strictEqual(classifyTool(name), variant, `${name} 应归类为 ${variant}`);
  }
}
console.log("toolMeta: TOOL_VARIANTS 的 16 项逐条对齐官方 ✓");

// ---------- 1b. 子串启发会误分类的那几个反例 ----------
//
// 这些名字含 "web"/"list"/"search" 之类子串，但**不在**官方表里 → 必须是 others。
// 旧的 `includes("web")` 会把它们全判成网页工具。
{
  for (const name of [
    "mcp__openviking__find", // 含不到子串，但也是 others
    "my_web_scraper",
    "list_files",
    "search_replace",
    "webhook_send",
    "batch_read",
    "some_editor",
  ]) {
    assert.strictEqual(
      classifyTool(name),
      "others",
      `${name} 不在官方表里，必须是 others（子串启发会把它误分类）`,
    );
  }
}
console.log("toolMeta: 表外的名字一律 others（子串启发会误分类的反例） ✓");

// ---------- 2. TOOL_TITLE_KEYS：pwsh 等工具有自己的标题 ----------

{
  assert.strictEqual(toolTitleKey("pwsh"), "toolPwsh", "pwsh 属 bash 变体但标题是 Pwsh");
  assert.strictEqual(toolTitleKey("read_image"), "toolReadImage");
  assert.strictEqual(toolTitleKey("cordis_run"), "toolRunCordis");
  // bash 本身没有覆盖项（用变体名 Bash）
  assert.strictEqual(toolTitleKey("bash"), undefined);
  assert.strictEqual(toolTitleKey("read"), undefined);
}
console.log("toolMeta: 工具自有标题（pwsh→Pwsh 等） ✓");

// ---------- 3. SUMMARY_KEYS：每个变体取参数字段的偏好 ----------

{
  assert.deepStrictEqual([...summaryKeys("bash")], ["description", "command"]);
  assert.deepStrictEqual([...summaryKeys("read")], ["path", "file_path", "url"]);
  assert.deepStrictEqual([...summaryKeys("search")], ["query", "pattern", "url"]);
  assert.deepStrictEqual([...summaryKeys("write")], ["path", "file_path"]);
  assert.deepStrictEqual([...summaryKeys("edit")], ["path", "file_path"]);
  assert.deepStrictEqual([...summaryKeys("code")], ["description"]);
  // `others` 是**空表**：官方对未知工具不猜字段
  assert.deepStrictEqual([...summaryKeys("others")], []);
}
console.log("toolMeta: SUMMARY_KEYS 逐条对齐（others 是空表） ✓");

// ---------- 4. parseExitStatus：剥掉标记行并取出退出状态 ----------

{
  // 普通非零退出
  const failed = parseExitStatus("boom\nmore output\n[exit code: 1]");
  assert.strictEqual(failed.exitCode, 1);
  assert.strictEqual(failed.output, "boom\nmore output", "标记行连同它前面的换行一起被剥掉");
  assert.strictEqual(failed.signal, undefined);

  // 信号优先于退出码（官方先判 signal）
  const killed = parseExitStatus("partial output\n[killed by signal: SIGKILL]");
  assert.strictEqual(killed.signal, "SIGKILL");
  assert.strictEqual(killed.exitCode, undefined, "有信号时不再给退出码");
  assert.strictEqual(killed.output, "partial output");

  // 干净退出：没有标记 → exitCode 0，正文原样
  const clean = parseExitStatus("all good");
  assert.strictEqual(clean.exitCode, 0);
  assert.strictEqual(clean.output, "all good");
  assert.strictEqual(clean.signal, undefined);

  // 空输出
  const empty = parseExitStatus("");
  assert.strictEqual(empty.exitCode, 0);
  assert.strictEqual(empty.output, "");
}
console.log("toolMeta: parseExitStatus 提取并剥掉标记行 ✓");

// ---------- 4b. 标记必须在**结尾**才认（官方用 `$` 锚定） ----------

{
  // 中间出现的 `[exit code: 1]` 是用户输出的一部分，不能当标记
  const middle = parseExitStatus("[exit code: 1]\nthen more output");
  assert.strictEqual(middle.exitCode, 0, "标记不在结尾 → 不解析");
  assert.strictEqual(middle.output, "[exit code: 1]\nthen more output");

  // 没有前导换行的也不算（必须独占一行）
  const inline = parseExitStatus("output [exit code: 3]");
  assert.strictEqual(inline.exitCode, 0);

  // 超大退出码不匹配 `\d+` 之外的形态
  assert.strictEqual(parseExitStatus("x\n[exit code: abc]").exitCode, 0);
}
console.log("toolMeta: 只有结尾独占一行的标记才解析 ✓");

// ---------- 4c. 持久 shell 的词汇**刻意不匹配** ----------

{
  // dsh-tool-*-persistent 用的是 `[shell exited: code N]` / `[shell killed by signal: X]`
  for (const text of [
    "output\n[shell exited: code 1]",
    "output\n[shell killed by signal: SIGTERM]",
    "output\n[shell exited]",
  ]) {
    const status = parseExitStatus(text);
    assert.strictEqual(status.exitCode, 0, `持久 shell 的词汇不该被解析：${text}`);
    assert.strictEqual(status.signal, undefined);
    assert.strictEqual(status.output, text, "正文原样保留");
  }
}
console.log("toolMeta: 持久 shell 的标记词汇刻意不匹配 ✓");

// ---------- 5. terminalFailed：非零退出升级为失败 ----------

{
  assert.strictEqual(terminalFailed({ exitCode: 0 }), false, "0 是成功");
  assert.strictEqual(terminalFailed({ exitCode: 1 }), true, "非零是失败");
  assert.strictEqual(terminalFailed({ exitCode: undefined, signal: "SIGKILL" }), true, "信号是失败");
  assert.strictEqual(terminalFailed({ exitCode: 0, signal: undefined }), false);
  // 运行中不算失败（还没结束）
  assert.strictEqual(terminalFailed({ running: true, exitCode: 1 }), false);
}
console.log("toolMeta: terminalFailed 把非零退出升级为失败 ✓");

console.log("\ntoolMeta: all assertions passed");
