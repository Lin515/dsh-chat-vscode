/**
 * 后台任务名册的显示口径（纯函数，便于离线断言）。
 *
 * 1. **live（`running` / `stopping`）在前**，按 `startedAt` 升序——先开跑的排上面；
 * 2. settled 在后，按 `finishedAt` 降序。
 *    （以前一律按 `startedAt` 倒序，于是一个跑了十分钟的后台任务会被刚结束的
 *    任务挤到列表下面，看起来像"不见了"。）
 *
 * 另有一条例外：`kind: 'subagent'` 的行**不进后台任务面板**（用户 2026-09-24 口径
 * ——子代理有自己的面板）。名册数据里仍保留它们：目录投影没有 `activity` 时，
 * 那一行是子代理按钮唯一的活性证据（见 `activity.ts` 的 `subagentsBusy`）。
 */
import type { JobItemView } from "../shared/chat";

/** 名册里代表子代理派发的 `kind`（`JobKindMap` 目前只有 `bash` / `subagent` 两个键，可扩展联合）。 */
export const SUBAGENT_JOB_KIND = "subagent";

/** 这一行是子代理派发吗（它不进后台任务面板，但仍是子代理按钮的活性来源之一）。 */
export function isSubagentJob(job: JobItemView): boolean {
  return job.kind === SUBAGENT_JOB_KIND;
}

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
