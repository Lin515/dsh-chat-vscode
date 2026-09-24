/**
 * 顶栏那两个面板入口（子代理 / 后台任务）的「现在有东西在跑吗」判据。
 *
 * 用户 2026-09-19 口径：有子代理在跑 → 子代理按钮亮起并呼吸；有后台任务在跑 →
 * 后台任务按钮亮起并呼吸。**运行中才有信号**，跑完立刻熄，所以判据必须是活的
 * 那一份数据，不能是「面板打开时抓的一把」。
 *
 * 纯函数、不引 React：断言见 `scripts/activity.test.ts`。
 */
import type { JobItemView, SubagentView } from "../shared/chat";
import { isLiveJob, isSubagentJob } from "./jobsOrder";

/**
 * 有子代理在跑吗。
 *
 * 两条来源，缺一不可：
 * - **目录**带 `activity`（0.1.7-alpha.1 之前由 `subagents/list` RPC 给，
 *   之后由 `api-session/status` 中继补——投影本身没有这个字段）；
 * - **后台任务**里 `kind: 'subagent'` 的活行——目录可能只有投影那一份，
 *   那时还没有状态中继过，只看目录会漏掉正在跑的子代理。
 */
export function subagentsBusy(
  entries: readonly SubagentView[],
  jobs: readonly JobItemView[],
): boolean {
  if (entries.some((entry) => entry.activity === "running")) return true;
  return jobs.some((job) => isSubagentJob(job) && isLiveJob(job));
}

/**
 * 有后台任务在跑吗（含「正在停止」——那也还没结束）。
 *
 * **子代理那一路不点亮这颗按钮**（用户 2026-09-24 口径）：子代理有自己的面板、
 * 自己的信号（上面的 `subagentsBusy`），而且后台任务面板也不收它——
 * 若不过滤，会出现「按钮亮着、面板却是空的」的矛盾。
 */
export function jobsBusy(jobs: readonly JobItemView[]): boolean {
  return jobs.some((job) => !isSubagentJob(job) && isLiveJob(job));
}
