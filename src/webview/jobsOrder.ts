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
 *
 * 除排序外还提供「哪一行可以展开看实时输出」的判据 `isObservableJob`（官方
 * `isObservable` 同口径）——它与排序共用同一份 `JobItemView` 读法，放一起才不会
 * 出现「能排到前面但点不开」这种两处口径打架的情况。
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

/**
 * 这一行的输出**值不值得展开看**（官方 `isObservable`）。
 *
 * live 的行恒可展开——它的输出随时可能继续来；已结束的行则要看环里还留着输出
 * （`output.total > 0`）。
 *
 * `output` 读不出来（老服务端的旧 `SessionJob` 没有这个字段、或某一帧没按契约带）
 * 时**不给展开入口**：那不是「没有输出」而是「不知道有没有」，而猜错的代价是一个
 * 点开只有「无输出」的面板——比不给入口更像故障。
 */
export function isObservableJob(job: JobItemView): boolean {
  return isLiveJob(job) || (job.output?.total ?? 0) > 0;
}

/** `Array.prototype.sort` 的比较函数（不改动入参数组）。 */
export function compareJobs(a: JobItemView, b: JobItemView): number {
  const aLive = isLiveJob(a);
  const bLive = isLiveJob(b);
  if (aLive !== bLive) return aLive ? -1 : 1;
  if (aLive) return (a.startedAt ?? 0) - (b.startedAt ?? 0);
  return (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0);
}
