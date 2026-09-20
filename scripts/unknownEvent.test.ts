/**
 * 「不认识的事件」告警的边界。
 *
 * 背景：告警原文是「遇到了本客户端不认识的事件「x」，已跳过其内容。」，它唯一的
 * 价值是提示「内核冒出了本客户端从未见过的词汇」。此前判断只看
 * `RENDERED_EVENT_TYPES`，于是**已知但不渲染**的簿记事件也落进告警分支：
 * `agent/inbox/spliced`（每条消息入队 + 领取各一条，新会话开场 3~5 条）、
 * `command/*`（每次斜杠命令）、`llm/retry`（每次重试）都命中，把告警刷成噪音
 * （docs/audit-summary.md §11）。
 *
 * 正确行为（本次修复）：
 *  - dsh 已知词汇（渲染的 ∪ 知情静默的）→ 一律不告警；
 *  - 真正没见过的类型且没标 `ignorable` → 告警保留（这是唯一的升级信号）；
 *  - 没见过的类型但标了 `ignorable: true` → 安全跳过，不告警。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import { RENDERED_EVENT_TYPES, SILENT_EVENT_TYPES } from "../src/dsh/protocol";

/** dsh 0.1.5-rc.1 的 `KNOWN_SESSION_EVENT_TYPES` 冻结快照（逐字取自
 *  `@deepseek-ai/dsh-session/lib/types/known-event-types.js`）。内核日后新增的类型
 *  不会出现在这里——那正是运行期告警该响的时候，所以本表刻意不跟随升级。 */
const DSH_KNOWN_EVENT_TYPES = [
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/attempt",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "deliverables/presented",
  "feedback/message-delete",
  "feedback/message-put",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "model/selection",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session-log-deepseek/delivery-accepted",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/catalog",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "system/message",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
  // 0.1.6-alpha 新增（`feat(web): record turn file changes with git snapshots and
  // render the changed-files card`）：顶层轮次停止时宣告本轮改了哪些文件。
  "workspace/changes",
];

function harness() {
  const toasts: string[] = [];
  const lines: string[] = [];
  const adapter = new SessionAdapter((frame) => {
    if (frame.type === "toast") toasts.push(frame.text);
  });
  // 宿主日志落点（控制器在真实链路上注入的是 `[event] 会话=… ` 前缀的 log）
  adapter.log = (line) => lines.push(line);
  return { adapter, toasts, lines };
}

/** 造一条最简事件：data 为空也要不崩（真实事件字段远多于此）。 */
let seq = 0;
function wire(type: string, extra: Record<string, unknown> = {}) {
  return { type, seq: seq++, time: 1789147200000, data: {}, ...extra };
}

// ---------- 1. dsh 已知词汇一律不告警 ----------

{
  const { adapter, toasts } = harness();
  for (const type of DSH_KNOWN_EVENT_TYPES) adapter.applyEvent(wire(type) as never);
  assert.deepStrictEqual(
    toasts.filter((t) => t.startsWith("@unknownEvent:")),
    [],
    `已知类型不该告警，实际弹了：${JSON.stringify(toasts)}`,
  );
}
console.log(`unknownEvent: dsh 已知的 ${DSH_KNOWN_EVENT_TYPES.length} 种事件均不告警 ✓`);

// ---------- 2. 名单完整性：已知词汇必须被两个集合覆盖 ----------

{
  const uncovered = DSH_KNOWN_EVENT_TYPES.filter(
    (type) => !RENDERED_EVENT_TYPES.has(type) && !SILENT_EVENT_TYPES.has(type),
  );
  assert.deepStrictEqual(uncovered, [], `以下已知类型既没渲染也没静默，会弹告警：${uncovered.join(", ")}`);

  const both = DSH_KNOWN_EVENT_TYPES.filter(
    (type) => RENDERED_EVENT_TYPES.has(type) && SILENT_EVENT_TYPES.has(type),
  );
  assert.deepStrictEqual(both, [], `同一类型不该既渲染又静默：${both.join(", ")}`);
}
console.log("unknownEvent: 已知词汇被「渲染 ∪ 静默」完整覆盖，且两集合不相交 ✓");

// ---------- 3. 真正没见过的类型：告警保留 ----------

{
  const { adapter, toasts } = harness();
  adapter.applyEvent(wire("kernel/brand-new-thing") as never);
  assert.deepStrictEqual(toasts, ["@unknownEvent:kernel/brand-new-thing"]);
}
console.log("unknownEvent: 未知类型仍弹告警（升级信号保留） ✓");

// ---------- 4. 标了 ignorable 的未知类型：安全跳过 ----------

{
  const { adapter, toasts } = harness();
  adapter.applyEvent(wire("plugin/out-of-tree", { ignorable: true }) as never);
  assert.deepStrictEqual(toasts, []);
}
console.log("unknownEvent: 未知但 ignorable → 静默跳过 ✓");

// ---------- 5. 回归点：agent/inbox/spliced 不再告警 ----------

{
  const { adapter, toasts } = harness();
  // 新会话开场的真实序列：两次插件注入入队 → 用户消息入队 → 两条领取
  adapter.applyEvent(
    wire("agent/inbox/spliced", {
      data: { target: "next-step", start: 0, inserted: [{ id: "m1" }] },
    }) as never,
  );
  adapter.applyEvent(
    wire("agent/inbox/spliced", { data: { target: "next-turn", start: 0, inserted: [{ id: "m2" }] } }) as never,
  );
  adapter.applyEvent(wire("agent/inbox/spliced", { data: { target: "next-step", start: 0, removedCount: 2 } }) as never);
  adapter.applyEvent(wire("agent/inbox/spliced", { data: { target: "next-turn", start: 0, removedCount: 1 } }) as never);
  assert.deepStrictEqual(toasts, [], "inbox 队列簿记不该弹「不认识的事件」");
}
console.log("unknownEvent: agent/inbox/spliced 不再告警 ✓");

// ---------- 6. 未知事件同时记进宿主日志（可追溯） ----------
//
// 告警在界面上是一闪而过的提示条，日志才是事后能回看的那一份；协议文档
// （docs/dsh-server-api.md §6.1）要求的降级纪律也是「至少在输出通道里报一次」。

{
  const { adapter, toasts, lines } = harness();
  adapter.applyEvent(wire("kernel/other-new-thing", { data: { turn: 1 } }) as never);
  assert.deepStrictEqual(toasts, ["@unknownEvent:kernel/other-new-thing"]);
  assert.strictEqual(lines.length, 1, `未知事件应记一行日志，实际：${JSON.stringify(lines)}`);
  assert.ok(lines[0]!.includes("type=kernel/other-new-thing"), lines[0]);
  assert.ok(lines[0]!.includes("turn"), `日志里应带上 data：${lines[0]}`);
  assert.ok(!lines[0]!.includes("\n"), "日志必须单行（多行会把时间戳前缀截在中间）");
}
console.log("unknownEvent: 未知事件记进宿主日志，含 seq 与 data ✓");

{
  // 回归点：`workspace/changes` 曾每轮弹一次告警（内核 0.1.6-alpha 新增、本客户端
  // 名单还停在 0.1.5-rc.1，且它没标 ignorable）。它现在是**渲染**的一员（轮尾改动
  // 文件卡片），所以既不告警也不该进那条「未知事件」日志。
  const { adapter, toasts, lines } = harness();
  adapter.applyEvent(wire("workspace/changes", { data: { turn: 1 } }) as never);
  assert.deepStrictEqual(toasts, [], "改动文件卡片的事件不该再弹「不认识的事件」");
  assert.deepStrictEqual(lines, [], "已知类型不记「未知事件」日志");
}
console.log("unknownEvent: workspace/changes 不再告警也不进未知事件日志 ✓");

{
  // 重放/重连会把同一类型重折很多遍：日志长度只跟「新词汇的种类数」有关
  const { adapter, lines } = harness();
  for (let turn = 0; turn < 5; turn++) {
    adapter.applyEvent(wire("kernel/other-new-thing", { data: { turn } }) as never);
  }
  assert.strictEqual(lines.length, 1, `同一类型只该记首见一条，实际 ${lines.length} 条`);
}
console.log("unknownEvent: 同一类型只记首见一条（重放不刷日志） ✓");

{
  const { adapter, toasts, lines } = harness();
  adapter.applyEvent(wire("tool/call", { data: {} }) as never);
  adapter.applyEvent(wire("agent/inbox/spliced", { data: {} }) as never);
  assert.deepStrictEqual(lines, [], "已知类型（渲染的 ∪ 静默的）不该记日志");
  // ignorable 的未知事件界面上完全无声，但同样要留痕
  adapter.applyEvent(wire("plugin/out-of-tree", { ignorable: true }) as never);
  assert.deepStrictEqual(toasts, [], "ignorable 的未知事件不提示（既有行为）");
  assert.strictEqual(lines.length, 1, "ignorable 的未知事件仍要记日志");
  assert.ok(lines[0]!.includes("ignorable"), `日志应写明按 ignorable 跳过：${lines[0]}`);
}
console.log("unknownEvent: 已知类型不记日志；ignorable 的未知类型记但界面无声 ✓");

{
  const { adapter, lines } = harness();
  adapter.applyEvent(wire("kernel/huge", { data: { blob: "x".repeat(5000) } }) as never);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0]!.includes("已截断"), "超长 data 应截断，避免一行撑爆日志");
  assert.ok(!lines[0]!.includes("\n"), "截断后仍必须单行");
}
console.log("unknownEvent: 超长 data 截断且保持单行 ✓");

// ---------- 7. 结构不变量：控制器必须把日志落点接上 ----------
//
// 只测适配器是不够的：接线漏了，`log` 永远是 undefined，上面几组断言照样绿，
// 而真实链路上一个字都不会写进输出通道（本仓库「测试绿、功能缺」的经典形态）。

{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const wired = controller.match(/adapter\.log = \(line\) => this\.log\(/g) ?? [];
  assert.strictEqual(
    wired.length,
    2,
    `会话域与子代理两处适配器都要注入日志落点，实际接了 ${wired.length} 处`,
  );
  assert.ok(
    /adapter\.log = \(line\) => this\.log\(`\[event\] 会话=\$\{sessionId\} /.test(controller),
    "会话域的日志行要带会话 id：多会话并存时才知道是哪个会话冒出的未知事件",
  );
}
console.log("unknownEvent: 控制器两处适配器都接上了日志落点 ✓");
