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
];

function harness() {
  const toasts: string[] = [];
  const adapter = new SessionAdapter((frame) => {
    if (frame.type === "toast") toasts.push(frame.text);
  });
  return { adapter, toasts };
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
