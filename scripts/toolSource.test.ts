/**
 * 工具节点「语言可确定」事实的离线断言（无 DOM、无 React）：
 *
 * - workflow 当前 schema 的 `script` 优先、旧包 `code` 兜底；只认完整 JSON 与
 *   非空字符串，其余参数原样保留且不重复脚本字段；
 * - inspect 只认明确定位表的整段 JSON（对象 / 数组），错误 / 半截 / 标量 / 其它
 *   工具（包括名字里带 inspect 的）一律不着色；
 * - 继承键（`constructor` / `__proto__`）不污染结果。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { isInspectJsonOutput, workflowScriptOf } from "../src/shared/toolSource";

// ---------- 1. workflow：script 优先，code 兼容，其他参数不丢不重复 ----------
{
  const current = workflowScriptOf(
    "workflow",
    JSON.stringify({ script: "export default 1", objective: "demo", agents: 2 }),
  );
  assert.deepStrictEqual(current, {
    key: "script",
    code: "export default 1",
    rest: { objective: "demo", agents: 2 },
  });
  assert.ok(!Object.hasOwn(current!.rest, "script"), "脚本字段不再重复留在 rest 里");

  assert.deepStrictEqual(
    workflowScriptOf("workflow", JSON.stringify({ code: "return 1", task: "old" })),
    { key: "code", code: "return 1", rest: { task: "old" } },
    "旧包字段 code 兼容",
  );
  assert.strictEqual(
    workflowScriptOf("workflow", JSON.stringify({ script: "new", code: "old" }))?.key,
    "script",
    "两个字段同时存在时 script 优先",
  );
  const both = workflowScriptOf("workflow", JSON.stringify({ script: "new", code: "old" }));
  assert.deepStrictEqual(both?.rest, { code: "old" }, "未被采用的同名字段作为普通参数保留");
}

// ---------- 2. workflow：身份与失败路径严格回退 ----------
{
  for (const name of ["workflow_extra", "run_workflow", "workflow ", "WORKFLOW", ""]) {
    assert.strictEqual(workflowScriptOf(name, JSON.stringify({ script: "x" })), undefined, `${name} 不是 workflow`);
  }
  assert.strictEqual(workflowScriptOf("workflow", '{"script":"x"'), undefined, "半截 JSON 不着色");
  assert.strictEqual(workflowScriptOf("workflow", "not json"), undefined);
  assert.strictEqual(workflowScriptOf("workflow", "[]"), undefined, "根不是对象");
  assert.strictEqual(workflowScriptOf("workflow", JSON.stringify({ script: 1 })), undefined, "非字符串");
  assert.strictEqual(workflowScriptOf("workflow", JSON.stringify({ script: "" })), undefined, "空脚本");
  assert.strictEqual(workflowScriptOf("workflow", JSON.stringify({ other: "x" })), undefined, "没有脚本字段");
}

// ---------- 3. 继承键 / 原型污染 ----------
{
  const args = JSON.parse(
    '{"script":"x","constructor":"own","__proto__":{"polluted":true},"toString":"own"}',
  ) as Record<string, unknown>;
  const script = workflowScriptOf("workflow", JSON.stringify(args));
  assert.ok(script !== undefined);
  assert.strictEqual(script.rest.constructor, "own", "自有 constructor 参数保留");
  assert.strictEqual(script.rest.toString, "own", "自有 toString 参数保留");
  assert.strictEqual(({} as { polluted?: unknown }).polluted, undefined, "不污染全局原型");
}

// ---------- 4. inspect：精确身份 + 整段 JSON ----------
{
  for (const name of [
    "cordis_inspect_list",
    "cordis_inspect_query",
    "cordis_inspect_self",
    "cordis_package_inspect",
    "cordis_runtime_inspect",
  ]) {
    assert.strictEqual(isInspectJsonOutput(name, '{"providers":[]}'), true, `${name} 对象`);
    assert.strictEqual(isInspectJsonOutput(name, "[1,2,3]"), true, `${name} 数组`);
  }
  assert.strictEqual(isInspectJsonOutput("session_event_read", '{"type":"tool/call"}'), true);
  assert.strictEqual(
    isInspectJsonOutput("session_event_read", 'Session s — t\nTarget event seq 1:\n```json\n{"a":1}\n```'),
    false,
    "标题 + 围栏不是整段 JSON，回退纯文",
  );
}

// ---------- 5. inspect：错误 / 半截 / 标量 / 其它工具一律不着色 ----------
{
  for (const name of [
    "my_inspect_tool",
    "cordis_inspect_list_extra",
    "cordis_package_inspect_extra",
    "cordis_runtime_inspector",
    "inspect",
    "workflow",
    "constructor",
    "__proto__",
  ]) {
    assert.strictEqual(isInspectJsonOutput(name, '{"a":1}'), false, `${name} 不在精确表里`);
  }
  assert.strictEqual(isInspectJsonOutput("cordis_inspect_list", ""), false);
  assert.strictEqual(isInspectJsonOutput("cordis_inspect_list", '{"a":1'), false, "半截 JSON");
  assert.strictEqual(isInspectJsonOutput("cordis_inspect_list", "Error: boom"), false);
  assert.strictEqual(isInspectJsonOutput("cordis_inspect_list", "null"), false, "null 不着色");
  assert.strictEqual(isInspectJsonOutput("cordis_inspect_list", '"text"'), false, "标量不着色");
  assert.strictEqual(isInspectJsonOutput("cordis_inspect_list", "42"), false);
}

console.log("toolSource: workflow script/code 提取、inspect JSON 身份与失败回退 ✓");
