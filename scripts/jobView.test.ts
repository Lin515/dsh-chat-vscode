/**
 * 后台任务名册 / 单任务输出流 / 「端点不存在」判据的离线断言。
 *
 * 这一条链修的是 0.1.7-alpha.1 的搬运：job 观察从 `session/control` 的帧搬到了
 * `dsh-api-job-controller` 的 `job` 命名空间（`job/list` 名册 + `job/follow` 单任务
 * 输出），而 `subagents/list` 被删除。两件事都**没有版本协商**可用——只能按帧形状
 * 与回包现认，所以两处的读取器都抽成纯函数钉住：认不出就**不动手**
 * （不发空名册、不重复请求不存在的端点、不猜输出坐标）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { DshApiError, endpointAbsent } from "../src/dsh/client";
import { jobFollowFrameFromWire, jobItemsFromWire, jobRowsFromFrame } from "../src/dsh/jobView";

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
    progress: "3/10",
    output: undefined,
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

// ---------- 2b. 输出坐标（决定这一行能不能展开看实时输出） ----------

{
  const [withOutput, partial, malformed, emptyProgress] = jobItemsFromWire([
    { id: "a", status: "completed", startedAt: 1, output: { total: 4096, earliest: 0, spillPaths: ["C:\\tmp\\a.log"] } },
    // 只有 total：契约里两个数成对出现，缺一个就不算拿到了坐标——**不编** earliest
    { id: "b", status: "completed", startedAt: 1, output: { total: 10 } },
    { id: "c", status: "completed", startedAt: 1, output: "10" },
    { id: "d", status: "running", startedAt: 1, progress: "" },
  ]);
  assert.deepStrictEqual(
    withOutput!.output,
    { total: 4096, earliest: 0 },
    "两个数都在才读坐标（spillPaths 不消费）",
  );
  assert.strictEqual(partial!.output, undefined, "缺 earliest 就不算拿到坐标");
  assert.strictEqual(malformed!.output, undefined, "output 不是对象不算");
  assert.strictEqual(emptyProgress!.progress, undefined, "空字符串的 progress 视为没有");
}
console.log("jobView: 输出坐标成对读取、不编造缺的一半 ✓");

// ---------- 2c. `job/follow` 的帧（单任务实时输出） ----------

{
  // opened：锚点偏移 + 环里最旧的保留字节（两者一起才判得出「开头是不是没了」）
  assert.deepStrictEqual(
    jobFollowFrameFromWire({ type: "opened", job: { output: { total: 90, earliest: 40 } }, from: 40 }),
    { kind: "opened", from: 40, earliest: 40 },
    "opened 读出 from 与 earliest",
  );
  assert.strictEqual(
    jobFollowFrameFromWire({ type: "opened", job: { output: { total: 90 } }, from: 0 }),
    undefined,
    "opened 缺 earliest 整帧丢掉（半个锚点算不出「开头没了没有」）",
  );
  assert.strictEqual(
    jobFollowFrameFromWire({ type: "opened", job: { output: { total: 90, earliest: 0 } } }),
    undefined,
    "opened 缺 from 同理",
  );

  // output：多个 chunk 拼成一段；lossy 与 chunk.gapBefore 折算成一个 gapBefore
  assert.deepStrictEqual(
    jobFollowFrameFromWire({
      type: "output",
      chunks: [{ at: 0, text: "line1\n" }, { at: 6, text: "line2\n", gapBefore: true }],
      next: 12,
    }),
    { kind: "output", text: "line1\nline2\n", next: 12, gapBefore: true },
    "chunk 自己的 gapBefore 也算丢过字节",
  );
  assert.deepStrictEqual(
    jobFollowFrameFromWire({ type: "output", chunks: [{ text: "x" }], next: 1, lossy: true }),
    { kind: "output", text: "x", next: 1, gapBefore: true },
    "lossy 同样折算成 gapBefore",
  );
  assert.deepStrictEqual(
    jobFollowFrameFromWire({ type: "output", chunks: [], next: 0 }),
    { kind: "output", text: "", next: 0, gapBefore: false },
    "空批次是合法帧（只是没有字节）",
  );
  assert.strictEqual(
    jobFollowFrameFromWire({ type: "output", next: 0 }),
    undefined,
    "chunks 不是数组认不出",
  );
  assert.strictEqual(
    jobFollowFrameFromWire({ type: "output", chunks: [], next: "3" }),
    undefined,
    "next 不是数字认不出（续传游标读错会把输出接乱）",
  );

  // status：终态。宿主只用它收尾（名册行自己会变收场态），所以不带负载
  assert.deepStrictEqual(jobFollowFrameFromWire({ type: "status", job: { id: "bash-1" } }), {
    kind: "status",
  });

  // 未知帧与坏输入：认不出就不动手（不当成终态、不当成空输出）
  for (const bad of [undefined, null, "opened", {}, { type: "rows" }, { type: 7 }]) {
    assert.strictEqual(jobFollowFrameFromWire(bad), undefined, `认不出的帧不动手：${JSON.stringify(bad)}`);
  }
}
console.log("jobView: job/follow 三型帧的读取与折算 ✓");

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
