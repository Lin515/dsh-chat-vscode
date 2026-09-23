/**
 * 后台任务名册与「端点不存在」判据的离线断言。
 *
 * 这一条链修的是 0.1.7-alpha.1 的搬运：job 观察从 `session/control` 的帧搬到了
 * `dsh-api-job-controller` 的 `job/list` 流，而 `subagents/list` 被删除。两件事都
 * **没有版本协商**可用——只能按帧形状与回包现认，所以两处的读取器都抽成纯函数钉住：
 * 认不出就**不动手**（不发空名册、不重复请求不存在的端点）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { DshApiError, endpointAbsent } from "../src/dsh/client";
import { jobItemsFromWire, jobRowsFromFrame } from "../src/dsh/jobView";

// ---------- 1. job/list 的帧：整表替换，认出 'rows' 才算名册 ----------

{
  const jobs = [{ id: "bash-1", kind: "bash", label: "npm test", status: "running", startedAt: 5 }];
  assert.deepStrictEqual(jobRowsFromFrame({ type: "rows", jobs }), jobs, "rows 帧取 jobs 数组");
  assert.deepStrictEqual(jobRowsFromFrame({ type: "rows", jobs: [] }), [], "空数组 = 名册确实是空的（清空面板）");
  assert.strictEqual(jobRowsFromFrame({ type: "rows" }), undefined, "rows 帧没带 jobs 数组算坏帧，不动手");
  assert.strictEqual(jobRowsFromFrame({ type: "rows", jobs: "bad" }), undefined, "jobs 不是数组认不出");
  // 关键的一条：未知帧类型**不是**空名册。把它当空名册会把面板凭空清空。
  assert.strictEqual(jobRowsFromFrame({ type: "roster", jobs }), undefined, "未知帧类型不动手");
  assert.strictEqual(jobRowsFromFrame(null), undefined, "null 认不出");
  assert.strictEqual(jobRowsFromFrame("rows"), undefined, "字符串认不出");
  assert.strictEqual(jobRowsFromFrame({}), undefined, "缺 type 认不出");
}
console.log("jobView: job/list 帧只认 'rows'，未知帧不当空名册 ✓");

// ---------- 2. 一条任务：字段缺失的容忍度 ----------

{
  const items = jobItemsFromWire([
    { id: "bash-1", kind: "bash", label: "npm test", status: "running", startedAt: 10, progress: "3/10" },
    // 词表外的状态**原样保留**（不许兜底成 completed——那是对未知给出肯定结论）
    { id: "bash-2", status: "weird", startedAt: 11 },
    // id 是承重字段：没有就整条丢弃，不编一个出来
    { kind: "bash", status: "running" },
    null,
  ]);
  assert.strictEqual(items.length, 2, "缺 id 的整条丢弃");
  assert.deepStrictEqual(items[0], {
    id: "bash-1",
    kind: "bash",
    label: "npm test",
    status: "running",
    detail: undefined,
    startedAt: 10,
    finishedAt: undefined,
  });
  assert.strictEqual(items[1]!.status, "weird", "词表外的状态原样保留");
  assert.strictEqual(items[1]!.kind, "job", "缺 kind 退化成 job");
  assert.strictEqual(items[1]!.label, "bash-2", "缺 label 退化成 id");
  assert.deepStrictEqual(jobItemsFromWire(undefined), [], "拿不到名册就是空表");
}
console.log("jobView: 任务字段按契约读取，缺 id 丢弃、未知状态原样保留 ✓");

// ---------- 3. 「端点不存在」：只认 404/405 这类肯定证据 ----------

{
  assert.strictEqual(
    endpointAbsent(new Error("subagents/list 失败：HTTP 404")),
    true,
    "网关回 404 = 这一版没有这个端点（0.1.7-rc.1 实测的形态）",
  );
  assert.strictEqual(endpointAbsent(new Error("subagents/list 失败：HTTP 405")), true, "405 同理");
  assert.strictEqual(
    endpointAbsent(new DshApiError("gateway/not-found", "no such route")),
    true,
    "信封回错误码时也认得出",
  );
  // 关键的一条：**业务**自己的 not-found（会话不存在）不是端点缺失——把它算进来
  // 会让一次业务拒绝永久关掉这条通道。
  assert.strictEqual(endpointAbsent(new DshApiError("session/not-found", "no such session")), false, "业务 not-found 不算端点缺失");
  assert.strictEqual(endpointAbsent(new DshApiError("job/not-found", "no such job")), false, "业务 not-found 不算端点缺失");
  // 关键的一条：超时 / 断线 / 5xx 都**不是**「端点不存在」——那些是「这次没拿到」，
  // 记成不存在会让一次瞬时故障永久关掉这条通道。
  assert.strictEqual(endpointAbsent(new Error("subagents/list 失败：HTTP 500")), false, "5xx 不算");
  assert.strictEqual(endpointAbsent(new Error("fetch failed")), false, "断线不算");
  assert.strictEqual(endpointAbsent(new DshApiError("session/not-found", "no such session")), false, "业务 not-found 不算端点缺失");
  assert.strictEqual(endpointAbsent(undefined), false, "没有错误不算");
}
console.log("endpointAbsent: 只认 404/405 与路由类错误码，瞬时故障不算 ✓");
