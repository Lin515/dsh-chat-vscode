/**
 * 工具节点的渲染事实（服务端渲染，无浏览器）：
 *
 * 1. 技能节点**只显示 SKILL 正文**：不显示参数（输入），也不显示「输入 / 输出」标题；
 * 2. 读 / 写 / 编辑节点与技能节点在真有可打开目标时，行头带两行悬停提示：
 *    按住 Ctrl/Cmd 单击打开只读副本（原有动作）、按住 Alt 单击打开可编辑的真实
 *    文件 / SKILL.md；没有目标（例如服务端没给技能路径）时不提示一个不存在的操作。
 *    只读那一档排在真实文件之前（见 `readonlyCopyHint` 与 `toolOpenFileHint`）。
 *
 * 用 `react-dom/server` 的 `renderToStaticMarkup`：断言落在产出的 HTML 上，而不是
 * 源码正则上。Ctrl/Cmd 单击本身是事件处理器，静态标记看不到；这里钉住的是
 * 「提示只挂在有动作的节点上」「技能正文确实进了展开体」两件用户可见事实。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallView } from "../src/shared/chat";
import type { NodeOpenPort } from "../src/webview/nodeOpen";
import { altLabel, modifierLabel } from "../src/webview/modifierLabel";

// `bridge.ts` 在模块求值期挂 `window` 监听；无头环境补最小实现，见 questionRender。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { ToolRow, modifierTargetOf } = await import("../src/webview/components/Rows");
const { TextsContext, dictionaryFor } = await import("../src/webview/texts");
const alt = altLabel();
const modifier = modifierLabel();

/** 展开态的端口：测试里恒为展开，才能看到展开体。 */
const openNode: NodeOpenPort = {
  open: true,
  openedWhileActive: false,
  setOpen: () => {},
};

function render(tool: ToolCallView, skillPath?: string): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(ToolRow, {
        tool,
        node: openNode,
        ...(skillPath === undefined ? {} : { skillPath }),
      }),
    ),
  );
}

const SKILL_OUTPUT = [
  '<skill_content name="build">',
  "<skill_resources>",
  "Base directory for this skill: /skills/build",
  "</skill_resources>",
  "",
  "<skill_instructions>",
  "# Build",
  "",
  "先读文档，再构建。",
  "</skill_instructions>",
  "</skill_content>",
].join("\n");

const skillTool = (overrides: Partial<ToolCallView> = {}): ToolCallView => ({
  id: "call-skill",
  name: "skill",
  title: "",
  detail: "build",
  status: "ok",
  input: '{"name":"build"}',
  output: SKILL_OUTPUT,
  skillName: "build",
  ...overrides,
});

// ---------- 1. 技能节点：只给正文 ----------

{
  const html = render(skillTool(), "/skills/build/SKILL.md");
  assert.ok(html.includes("先读文档，再构建。"), "技能正文要进展开体");
  assert.ok(!html.includes("io-label"), "不再显示「输入 / 输出」标题");
  assert.ok(!html.includes("&quot;name&quot;"), "不再显示调用参数 JSON");
  assert.ok(html.includes("加载技能"), "技能节点用自有标题");
  assert.ok(
    html.includes(`按住 ${alt} 单击打开可编辑的 SKILL.md`),
    "服务端给了 SKILL.md 路径时，行头要有真实文件修饰键提示",
  );
  assert.ok(
    html.includes(`按住 ${modifier} 单击打开只读副本`),
    "只读副本那一档也要提示，并排在真实文件那一行之前",
  );
  // 行头的 title 是这段说明的唯一出口：两行的**先后**也在这里真渲染一次，
  // 光有子串断言时把顺序写反照样绿。
  const headTitle = /<button[^>]*class="row-head[^"]*"[^>]*title="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(
    headTitle.indexOf("只读副本") >= 0 && headTitle.indexOf("只读副本") < headTitle.indexOf("可编辑的 SKILL.md"),
    `行头悬停必须是「只读副本」在前、「真实 SKILL.md」在后：${headTitle}`,
  );
}
console.log("toolRowRender: 技能节点只显示 SKILL 正文，并提示修饰键打开真实 SKILL.md ✓");

// ---------- 1b. 服务端没给路径：不挂动作，也不提示 ----------

{
  const html = render(skillTool());
  assert.ok(html.includes("先读文档，再构建。"), "正文照旧显示");
  assert.ok(!html.includes("打开可编辑的真实文件"), "没有 SKILL.md 路径时不得提示一个不存在的动作");
}
console.log("toolRowRender: 缺少 SKILL.md 路径时不提示、不构造本机路径 ✓");

// ---------- 1c. 出错 / 旧结果：正文原样显示，仍然没有标题 ----------

{
  const html = render(skillTool({ status: "error", output: "skill 加载失败：unknown" }));
  assert.ok(html.includes("skill 加载失败：unknown"));
  assert.ok(!html.includes("io-label"), "错误正文也不套「输出」标题");
}
console.log("toolRowRender: 技能加载失败时正文原样显示，不套输出标题 ✓");

// ---------- 2. 读 / 写 / 编辑节点：有文件路径才提示 ----------

for (const name of ["read", "write", "edit"]) {
  const withPath = render({
    id: `call-${name}`,
    name,
    title: "",
    detail: "src/a.ts",
    status: "ok",
    input: '{"file_path":"src/a.ts"}',
    filePath: "src/a.ts",
  });
  assert.ok(
    withPath.includes(`按住 ${alt} 单击打开可编辑的真实文件`),
    `${name}: 有文件路径时行头要有真实文件修饰键提示`,
  );
  assert.ok(
    withPath.includes(`按住 ${modifier} 单击打开只读副本`),
    `${name}: 只读副本那一档也要提示，并排在真实文件那一行之前`,
  );

  const withoutPath = render({
    id: `call-${name}-none`,
    name,
    title: "",
    detail: "src/a.ts",
    status: "ok",
    input: '{"file_path":"src/a.ts"}',
  });
  assert.ok(
    !withoutPath.includes("is-file-openable"),
    `${name}: 没有 filePath 时行头不得挂修饰键动作（detail 自己的普通点击是另一档）`,
  );
}
console.log("toolRowRender: 读 / 写 / 编辑节点只在有路径时提示 Ctrl/Cmd 打开文件 ✓");

// ---------- 2b. 修饰键目标：读取节点带起始行，编辑节点不猜行号 ----------

{
  const readTool = (overrides: Partial<ToolCallView> = {}): ToolCallView => ({
    id: "call-read",
    name: "read",
    title: "",
    detail: "src/a.ts",
    status: "ok",
    input: '{"file_path":"src/a.ts"}',
    filePath: "src/a.ts",
    ...overrides,
  });

  assert.deepStrictEqual(
    modifierTargetOf(readTool({ readLines: { start: 12, end: 40 } })),
    { path: "src/a.ts", line: 12 },
    "读取节点带行号区间时，打开目标要带起始行",
  );
  assert.deepStrictEqual(
    modifierTargetOf(readTool()),
    { path: "src/a.ts" },
    "读取节点没有带行号区间时只打开文件，不带行号",
  );

  assert.deepStrictEqual(
    modifierTargetOf({
      id: "call-edit",
      name: "edit",
      title: "",
      detail: "src/a.ts",
      status: "ok",
      input: '{"file_path":"src/a.ts"}',
      filePath: "src/a.ts",
      diff: [{ path: "src/a.ts", lines: [{ kind: "add", text: "x" }], added: 1, removed: 0 }],
    }),
    { path: "src/a.ts" },
    "编辑节点没有行号数据，只打开文件、不猜行号",
  );

  assert.deepStrictEqual(
    modifierTargetOf(skillTool(), "/skills/build/SKILL.md"),
    { path: "/skills/build/SKILL.md" },
    "技能节点用服务端给的 SKILL.md 路径，不带行号",
  );
  assert.strictEqual(
    modifierTargetOf(skillTool()),
    undefined,
    "没有 SKILL.md 路径时不得按技能名拼路径",
  );

  assert.strictEqual(
    modifierTargetOf({
      id: "call-pwsh",
      name: "pwsh",
      title: "",
      detail: "npm test",
      status: "ok",
      input: '{"command":"npm test"}',
    }),
    undefined,
    "没有文件路径的普通节点没有打开目标",
  );
}
console.log("toolRowRender: 读取节点带起始行，编辑节点只打开文件、不猜行号 ✓");

// write 内容在参数尚未完成时也必须是原文，不影响 edit 或既有 diff。
{
  const write = (input: string, overrides: Partial<ToolCallView> = {}): ToolCallView => ({
    id: "write-stream", name: "write", title: "", detail: "a.ts", status: "running", input, ...overrides,
  });
  const html = render(write(String.raw`{"file_path":"a.ts","content":"  one\r\n\t<script>two</script>\\n`));
  assert.ok(html.includes("write-preview"));
  assert.ok(html.includes("  one\r\n\t&lt;script&gt;two&lt;/script&gt;\\n"), "真实CRLF/缩进与字面反斜杠n；HTML保持文本");
  assert.ok(!html.includes("&quot;content&quot;"), "不展示参数JSON");
  assert.ok(html.includes("参数尚未完整"));
  assert.ok(html.includes("不代表已写入文件"));
  assert.ok(render(write('{"content":""}')).includes("write-preview"), "空content也可展开");
  for (const status of ["error", "stopped"] as const) {
    const interrupted = render(write('{"content":"partial', { status, output: "not saved" }));
    assert.ok(interrupted.includes("partial") && interrupted.includes("参数尚未完整") && interrupted.includes("not saved"));
  }
  assert.ok(!render(write(String.raw`{"content":"bad\q"}`)).includes("write-preview"), "无效JSON回退原参数");
  assert.ok(!render(write('{"content":"edit"}', { name: "edit" })).includes("write-preview"));
  const diff = render(write('{"content":"raw preview"}', {
    status: "ok", diff: [{ path: "a.ts", lines: [{ kind: "add", text: "final diff" }], added: 1, removed: 0 }],
  }));
  assert.ok(diff.includes("final diff") && !diff.includes("raw preview"), "既有diff接管，不重复展示");
}
console.log("toolRowRender: write 原文/空内容/失败中断/安全回退/仅write/diff交接 ✓");

// ---------- 4. workflow：script（旧 code 兜底）走代码块，其余参数留在 IN ----------
{
  const workflow = (input: string, overrides: Partial<ToolCallView> = {}): ToolCallView => ({
    id: "call-workflow", name: "workflow", title: "", detail: "demo", status: "ok",
    input, output: 'workflow "demo" completed (1 agent).\nReturn value:\n{"ok":true}', ...overrides,
  });
  const current = render(workflow(JSON.stringify({ script: "const value = 1;", objective: "demo" })));
  assert.ok(current.includes("code-block"), "workflow 脚本用代码块");
  assert.ok(current.includes("const value = 1;"), "脚本原文进入正文");
  assert.ok(current.includes("objective"), "其余参数仍显示");
  assert.ok(!current.includes("&quot;script&quot;"), "脚本字段不在 IN JSON 里重复出现");

  const legacy = render(workflow(JSON.stringify({ code: "return 1;", task: "old" })));
  assert.ok(legacy.includes("return 1;") && legacy.includes("task"), "旧 code 字段兼容且其余参数不丢");

  const running = render(workflow('{"script":"const value', { status: "running", output: "" }));
  assert.ok(!running.includes("code-block"), "半截参数不提前把脚本当完整代码块");
}
console.log("toolRowRender: workflow script/code 代码块与其余参数共存、不重复 ✓");

// ---------- 5. inspect：只有明确工具 + 成功 + 整段 JSON 才挂 JSON 着色面 ----------
{
  const inspect = (name: string, output: string, overrides: Partial<ToolCallView> = {}): ToolCallView => ({
    id: `call-${name}`, name, title: "", detail: "inspect", status: "ok",
    input: '{"query":"x"}', output, ...overrides,
  });
  const json = render(inspect("cordis_inspect_list", '{"providers":[{"id":"a"}]}'));
  assert.ok(json.includes("md-code-surface"), "inspect 成功且整段 JSON 时用共享 JSON 着色面");
  assert.ok(json.includes("providers"), "完整 OUT 原字符串仍显示（不拆字段）");

  const packageInspect = render(inspect("cordis_package_inspect", '{"packageId":"a","props":null}'));
  assert.ok(packageInspect.includes("md-code-surface"), "本地实际存在的 package inspect 也覆盖");
  assert.ok(packageInspect.includes("packageId"), "完整 OUT 原字符串仍显示");

  const generic = render(inspect("custom_tool", '{"providers":[{"id":"a"}]}'));
  assert.ok(!generic.includes("md-code-surface"), "其它工具的 JSON 形 OUT 不按 JSON 着色");

  const partial = render(inspect("cordis_inspect_query", '{"data":[1,2'));
  assert.ok(!partial.includes("md-code-surface"), "半截 JSON 纯文回退");

  const failed = render(inspect("cordis_inspect_self", '{"plugins":[]}', { status: "error", output: "boom" }));
  assert.ok(!failed.includes("md-code-surface"), "错误结果纯文回退");

  // running 的同一段 OUT 先由原 span 纯文承载；切 ok 后仍是同一个 CodeText 宿主，
  // 只切换 lang/active，不能按 jsonOutput 条件替换成另一个组件（会卸载 TextNode）。
  const running = render(inspect("cordis_inspect_query", '{\n  "provider": "fix', { status: "running" }));
  assert.ok(running.includes("provider"), "running 的 OUT 原样显示");
  assert.ok(!running.includes("md-code-surface"), "running 不挂 JSON 面、不请求高亮");
  const sameOutput = '{\n  "provider": "fix"}';
  const settled = render(inspect("cordis_inspect_query", sameOutput, { status: "ok" }));
  assert.ok(settled.includes("md-code-surface"), "同 output 切 ok 后才挂 JSON 面");
  assert.ok(settled.includes("provider"), "OUT 承载文本不变");

  const rowsSource = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.match(
    rowsSource,
    /\{showOutput \? \([\s\S]{0,600}?<CodeText[\s\S]{0,220}?lang=\{jsonOutput \? "json" : undefined\}[\s\S]{0,80}?active=\{jsonOutput\}/,
    "OUT 始终由同一个 CodeText 承载，JSON 资格只控 lang/active",
  );
  assert.doesNotMatch(
    rowsSource,
    /\{jsonOutput \? \(\s*<CodeText/,
    "不能用 jsonOutput 条件切换 OUT 宿主组件（选区会随 TextNode 卸载丢失）",
  );
}
console.log("toolRowRender: inspect JSON 只对明确工具与完整成功结果生效 ✓");

// ---------- 6. read 卡：共享着色面挂在完整窗口的正文上 ----------
{
  const read = render({
    id: "call-read", name: "read", title: "", detail: "a.ts", status: "ok",
    input: '{"file_path":"a.ts"}', filePath: "a.ts",
    card: {
      kind: "read", label: "a.ts", totalLines: 2, lang: "ts",
      lines: [{ number: 1, text: "/* multi" }, { number: 2, text: "line */" }],
    },
  });
  assert.ok(read.includes("md-code-surface"), "read 卡正文用共享着色面（窗口整段 tokenize 后切行）");
  assert.ok(read.includes("/* multi") && read.includes("line */"), "多行注释原文完整");
}
console.log("toolRowRender: read 卡共享着色面与完整窗口正文 ✓");

// ---------- 7. 状态接线：running 的 write/edit 明确传 streaming，不凭参数完整推 settled ----------
{
  const diffSource = readFileSync(join(process.cwd(), "src", "webview", "components", "Diff.tsx"), "utf8");
  assert.match(diffSource, /phase = "streaming"/, "DiffView 缺省不启高亮（调用方必须显式 settled）");
  assert.match(
    diffSource,
    /useCodeHighlight\(\{ code: sides\.oldText, lang, active, elementRef: rootRef \}\)/,
    "diff 两侧按 active 统一门控",
  );
  const writeBody = readFileSync(join(process.cwd(), "src", "webview", "components", "WriteBody.tsx"), "utf8");
  assert.match(writeBody, /phase=\{active \? "streaming" : "settled"\}/, "write/ edit 的 diff 由工具活性决定");
  assert.match(writeBody, /active=\{!active\}/, "write 原文预览只在水合后着色");
  const rowsSource = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.match(rowsSource, /phase=\{running \? "streaming" : "settled"\}/, "Rows 把 running 明确翻译成 streaming");
}
console.log("toolRowRender: 运行中 write/edit 保持纯文（phase/active 显式传入）✓");

console.log("\ntoolRowRender: all assertions passed");
