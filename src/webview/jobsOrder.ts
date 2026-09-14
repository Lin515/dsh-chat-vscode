/**
 * 后台任务列表的排序（纯函数，便于离线断言）。
 *
 * 口径照官方 `dsh-client-ui-jobs/lib/client.js` 的 `ordered()`：
 * 1. **live（`running` / `stopping`）在前**，按 `startedAt` 升序——先开跑的排上面；
 * 2. settled 在后，按 `finishedAt` 降序。
 *
 * 以前一律按 `startedAt` 倒序，于是一个跑了十分钟的后台任务会被刚结束的任务挤到
 * 列表下面，看起来像"不见了"。
 */
import type { JobItemView } from "../shared/chat";

/** live = 还在跑、或正在停止（官方 `isLive`）。 */
export function isLiveJob(job: JobItemView): boolean {
  return job.status === "running" || job.status === "stopping";
}

/** `Array.prototype.sort` 的比较函数（不改动入参数组）。 */
export function compareJobs(a: JobItemView, b: JobItemView): number {
  const aLive = isLiveJob(a);
  const bLive = isLiveJob(b);
  if (aLive !== bLive) return aLive ? -1 : 1;
  if (aLive) return (a.startedAt ?? 0) - (b.startedAt ?? 0);
  return (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0);
}
