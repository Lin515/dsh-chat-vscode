/**
 * 工具节点的渲染事实（服务端渲染，无浏览器）：
 *
 * 1. 技能节点**只显示 SKILL 正文**：不显示参数（输入），也不显示「输入 / 输出」标题；
 * 2. 读 / 写 / 编辑节点与技能节点在真有可打开目标时，行头带「按住 Ctrl/Cmd 单击打开…」
 *    的悬停提示；没有目标（例如服务端没给技能路径）时不提示一个不存在的操作。
 *
 * 用 `react-dom/server` 的 `renderToStaticMarkup`：断言落在产出的 HTML 上，而不是
 * 源码正则上。Ctrl/Cmd 单击本身是事件处理器，静态标记看不到；这里钉住的是
 * 「提示只挂在有动作的节点上」「技能正文确实进了展开体」两件用户可见事实。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallView } from "../src/shared/chat";
import type { NodeOpenPort } from "../src/webview/nodeOpen";
import { altLabel } from "../src/webview/modifierLabel";

// `bridge.ts` 在模块求值期挂 `window` 监听；无头环境补最小实现，见 questionRender。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { ToolRow, modifierTargetOf } = await import("../src/webview/components/Rows");
const { TextsContext, dictionaryFor } = await import("../src/webview/texts");
const alt = altLabel();

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
    html.includes(`title="按住 ${alt} 单击打开可编辑的 SKILL.md"`),
    "服务端给了 SKILL.md 路径时，行头要有真实文件修饰键提示",
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

console.log("\ntoolRowRender: all assertions passed");
