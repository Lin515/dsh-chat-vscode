/**
 * 「不认识的事件」告警的边界。
 *
 * 背景：告警原文是「遇到了本客户端不认识的事件「x」，已跳过其内容。」，它唯一的
 * 价值是提示「内核冒出了本客户端从未见过的词汇」。此前判断只看
 * `RENDERED_EVENT_TYPES`，于是**已知但不渲染**的簿记事件也落进告警分支：
 * `agent/inbox/spliced`（每条消息入队 + 领取各一条，新会话开场 3~5 条）、
 * `command/*`（每次斜杠命令）、`llm/retry`（每次重试）都命中，把告警刷成噪音
 * （docs/audit-summary.md「已知未处理的事件反复触发 warn」一条）。
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
import { CONSUMED_EVENT_TYPES, RENDERED_EVENT_TYPES, SILENT_EVENT_TYPES } from "../src/dsh/protocol";

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

// ---------- 2. 名单完整性：已知词汇必须被三个集合覆盖 ----------

{
  const uncovered = DSH_KNOWN_EVENT_TYPES.filter(
    (type) =>
      !RENDERED_EVENT_TYPES.has(type) && !SILENT_EVENT_TYPES.has(type) && !CONSUMED_EVENT_TYPES.has(type),
  );
  assert.deepStrictEqual(uncovered, [], `以下已知类型既没渲染也没静默/消费，会弹告警：${uncovered.join(", ")}`);

  const owned = (type: string): number =>
    [RENDERED_EVENT_TYPES, SILENT_EVENT_TYPES, CONSUMED_EVENT_TYPES].filter((set) => set.has(type)).length;
  const both = DSH_KNOWN_EVENT_TYPES.filter((type) => owned(type) > 1);
  assert.deepStrictEqual(both, [], `同一类型只能属于一个集合：${both.join(", ")}`);
}
console.log("unknownEvent: 已知词汇被「渲染 ∪ 静默 ∪ 消费」完整覆盖，且三集合互斥 ✓");

// ---------- 2b. 升级新增的类型：登记为已知，不误报 ----------
//
// 上面那张冻结表**刻意**停在 0.1.5-rc.1（新词汇正是告警该响的时候），所以内核新加的
// 类型要单独登记。这里逐个钉住「升级时新出现、本扩展有意不渲染」的类型——漏一个，
// 用户每次升级都会看到一条「不认识的事件」提示。
{
  const ADDED_KNOWN: readonly string[] = [
    // 0.1.6-alpha：顶层轮次停止时宣告本轮改了哪些文件（已渲染，见 RENDERED_EVENT_TYPES）
    "workspace/changes",
    // 0.1.7-alpha.1：工具目录增量（`role:'developer'` 的消息）。官方把它的内容块标为
    // 「保留：生产者与消费者一起实现之前，provider 与 UI 都拒绝」，即这一版没有生产者。
    "developer/message",
  ];
  const uncovered = ADDED_KNOWN.filter(
    (type) =>
      !RENDERED_EVENT_TYPES.has(type) && !SILENT_EVENT_TYPES.has(type) && !CONSUMED_EVENT_TYPES.has(type),
  );
  assert.deepStrictEqual(uncovered, [], `升级新增的类型必须登记：${uncovered.join(", ")}`);
  const { adapter, toasts } = harness();
  for (const type of ADDED_KNOWN) adapter.applyEvent(wire(type) as never);
  assert.deepStrictEqual(toasts.filter((t) => t.startsWith("@unknownEvent:")), []);
}
console.log("unknownEvent: 升级新增的类型已登记（workspace/changes、developer/message） ✓");

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
// （docs/dsh-server-api.md「线上事件信封」一节）要求的降级纪律也是「至少在输出通道里报一次」。

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
// （子代理对话在 2026-09-24 之后是**会话级切换**——域和适配器与普通会话共用
// `openScopeFollow` 这一条装配路，所以这里只剩一处。）

{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const wired = controller.match(/adapter\.log = \(line\) => this\.log\(/g) ?? [];
  assert.strictEqual(
    wired.length,
    1,
    `会话域的适配器要注入日志落点，实际接了 ${wired.length} 处`,
  );
  assert.ok(
    /adapter\.log = \(line\) => this\.log\(`\[event\] 会话=\$\{sessionId\} /.test(controller),
    "会话域的日志行要带会话 id：多会话并存时才知道是哪个会话冒出的未知事件",
  );
}
console.log("unknownEvent: 控制器的适配器接上了日志落点 ✓");

// ---------- 8. `subagent/catalog`：被消费（注册进目录），不告警也不记未知日志 ----------
//
// 它是第三类（`CONSUMED_EVENT_TYPES`）：适配器要**读它的内容**把子代理注册进目录
// （用户 2026-09-23 报的「子代理启动后要点开面板才看得到」就是缺这条注册），
// 但它不该在聊天流里出节点，也不该退化成「内核冒出新词汇」的噪音。
{
  const established: string[] = [];
  const { adapter, toasts, lines } = harness();
  adapter.onSubagentEstablished = (entry) => established.push(`${entry.id}:${entry.mode}:${entry.label}`);
  adapter.applyEvent({
    type: "subagent/catalog",
    seq: 10,
    time: 1789147200000,
    data: { version: 0, childId: "child-1", childCreatedAt: 1, mode: "continuable", label: "调研契约" },
  } as never);
  assert.deepStrictEqual(established, ["child-1:continuable:调研契约"], "建立事实要交给控制器注册");
  assert.deepStrictEqual(toasts, [], "已消费的类型不弹「不认识的事件」");
  assert.deepStrictEqual(lines, [], "已消费的类型不进「未知事件」日志");
}
console.log("unknownEvent: subagent/catalog 被消费：注册 + 不告警 ✓");

{
  // 分叉会话的继承前缀：前缀里的目录事实属于**源会话**，必须忽略（判据与服务端
  // `subagentCatalog` 投影的 `event.seq < inheritedEventCount` 同口径）。
  // 走**真实那条路**（快照 records → refold）：继承切点排在它标记的事件之后，
  // 边走边认是认不出来的，`refold` 因此先扫一遍边界。
  const established: string[] = [];
  const { adapter } = harness();
  adapter.onSubagentEstablished = (entry) => established.push(entry.id);
  const ev = (seq: number, type: string, data: Record<string, unknown> = {}) =>
    ({ type, seq, time: 1789147200000, data }) as never;
  adapter.applyFrame({
    type: "snapshot",
    cursor: 9,
    hasMore: false,
    records: [
      // 分叉时从源会话抄下来的前缀：里面带着源会话的子代理目录事实
      { type: "event", event: ev(1, "subagent/catalog", { version: 0, childId: "inherited", mode: "one-shot" }) },
      // 继承切点（源会话自己的种子末尾也在这里，同样带 inherited:true）
      { type: "event", event: ev(2, "session/end-seed", { inherited: true }) },
      // 本会话自己建立的子代理
      { type: "event", event: ev(9, "subagent/catalog", { version: 0, childId: "own", mode: "continuable", label: "自己的" }) },
    ],
  } as never);
  assert.deepStrictEqual(established, ["own"], "继承前缀里的目录事实不能被注册成本会话的子代理");

  // 本地种子末尾（`session/end-seed {}`，例如子代理会话自己写的那条）**不是**继承切点：
  // 拿它排除会把本会话建立子代理的事实一起吃掉
  const local: string[] = [];
  const { adapter: adapter2 } = harness();
  adapter2.onSubagentEstablished = (entry) => local.push(entry.id);
  adapter2.applyFrame({
    type: "snapshot",
    cursor: 3,
    hasMore: false,
    records: [
      { type: "event", event: ev(1, "session/end-seed", {}) },
      { type: "event", event: ev(2, "subagent/catalog", { version: 0, childId: "local-seed-own", mode: "one-shot" }) },
    ],
  } as never);
  assert.deepStrictEqual(local, ["local-seed-own"], "本地种子末尾不是继承切点");
}
console.log("unknownEvent: 继承前缀的目录事实被忽略（本地种子末尾不误伤）✓");
