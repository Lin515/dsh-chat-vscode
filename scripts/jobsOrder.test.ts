/**
 * 后台任务列表的排序口径（官方 `dsh-client-ui-jobs` 的 `ordered()`）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import type { JobItemView } from "../src/shared/chat";
import { compareJobs, isLiveJob } from "../src/webview/jobsOrder";

const job = (id: string, status: JobItemView["status"], startedAt: number, finishedAt?: number): JobItemView => ({
  id,
  kind: "bash",
  label: id,
  status,
  startedAt,
  ...(finishedAt === undefined ? {} : { finishedAt }),
});

// ---------- 1. live 判定：正在停止也算 live（官方 isLive） ----------
{
  assert.strictEqual(isLiveJob(job("a", "running", 0)), true);
  assert.strictEqual(isLiveJob(job("b", "stopping", 0)), true);
  assert.strictEqual(isLiveJob(job("c", "completed", 0, 1)), false);
  assert.strictEqual(isLiveJob(job("d", "killed", 0, 1)), false);
  assert.strictEqual(isLiveJob(job("e", "failed", 0, 1)), false);
}
console.log("jobsOrder: live 判定 ✓");

// ---------- 2. 排序：live 在前（按开始时间升序），settled 在后（按结束降序） ----------
{
  const longRunning = job("long", "running", 1_000);
  const stopping = job("stopping", "stopping", 2_000);
  const justFinished = job("recent", "completed", 3_000, 20_000);
  const finishedEarlier = job("older", "completed", 500, 9_000);
  const failed = job("failed", "failed", 100, 8_000);

  const sorted = [justFinished, longRunning, failed, stopping, finishedEarlier].sort(compareJobs);
  assert.deepStrictEqual(
    sorted.map((item) => item.id),
    ["long", "stopping", "recent", "older", "failed"],
    "跑了很久的 live 任务不能被刚结束的挤下去；settled 按结束时间倒序",
  );
}
console.log("jobsOrder: 排序口径 ✓");

// ---------- 3. 缺字段时不炸（startedAt/finishedAt 都缺） ----------
{
  const a = { id: "a", kind: "bash", label: "a", status: "completed" } as unknown as JobItemView;
  const b = { id: "b", kind: "bash", label: "b", status: "completed" } as unknown as JobItemView;
  assert.strictEqual(compareJobs(a, b), 0, "两边都缺时间 → 视作相等，不产生 NaN 比较");
  assert.ok(Number.isFinite(compareJobs(a, job("c", "completed", 5, 9))), "缺时间与有时间混排也要给出有限值");
}
console.log("jobsOrder: 缺字段兜底 ✓");

console.log("\njobsOrder: all assertions passed");
