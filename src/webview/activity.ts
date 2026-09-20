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
import { isLiveJob } from "./jobsOrder";

/**
 * 后台任务里代表子代理的 `kind`（`JobKindMap` 目前只有 `bash` / `subagent` 两个键，
 * 但它是可扩展联合：别的 kind 一律按「后台任务」算，不认识就不认领）。
 */
const SUBAGENT_JOB_KIND = "subagent";

/**
 * 有子代理在跑吗。
 *
 * 两条来源，缺一不可：
 * - **目录**（`subagents/list` RPC）带 `activity`，那是权威值；
 * - **后台任务**（`session/control` 的 jobs 帧）里 `kind: 'subagent'` 的活行——
 *   目录可能只有投影（投影**没有** `activity`，见 `SubagentView` 的注释），
 *   那时角色还没问过 RPC，只看目录会漏掉正在跑的子代理。
 */
export function subagentsBusy(
  entries: readonly SubagentView[],
  jobs: readonly JobItemView[],
): boolean {
  if (entries.some((entry) => entry.activity === "running")) return true;
  return jobs.some((job) => job.kind === SUBAGENT_JOB_KIND && isLiveJob(job));
}

/** 有后台任务在跑吗（含「正在停止」——那也还没结束）。 */
export function jobsBusy(jobs: readonly JobItemView[]): boolean {
  return jobs.some(isLiveJob);
}
