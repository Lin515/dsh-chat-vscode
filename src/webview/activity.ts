/**
 * 界面上那几个「现在有东西在跑吗」的判据：顶栏的两个面板入口（子代理 / 后台任务）
 * 与待办清单里的**当前执行步骤**。
 *
 * 用户 2026-09-19 口径：有子代理在跑 → 子代理按钮亮起并呼吸；有后台任务在跑 →
 * 后台任务按钮亮起并呼吸。**运行中才有信号**，跑完立刻熄，所以判据必须是活的
 * 那一份数据，不能是「面板打开时抓的一把」。待办那一枚同一条纪律（见 `stepDotClass`）。
 *
 * 纯函数、不引 React：断言见 `scripts/activity.test.ts`。
 */
import type { JobItemView, SubagentView, TodoView } from "../shared/chat";
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

/**
 * 待办清单里某一枚刻点此刻该画成哪一档（`dot` 的修饰类）。
 *
 * 用户 ToDo 口径（仓库根 `ToDo.md`）：会话生成中，清单里的**当前执行步骤**是蓝色
 * 呼吸灯；但会话中止 / 停止之后它**仍然在闪**，与实际状态不符——应当「显示为蓝色
 * 不闪动」。
 *
 * 为什么判据里必须有 `running`：`todos` 是**投影**，`in_progress` 是最后一次写入的
 * 状态，轮次收场时服务端**不会**回头改它——用户按停、这一轮报错、甚至只是打开一个
 * 早就停下的会话，投影里那一条照样写着 `in_progress`
 * （`todosFromProjection` 的状态词表只有 pending / in_progress / completed，
 * 表达不了「已停止」）。于是「它是当前步骤」（投影）与「它正在被执行」（会话域的
 * `running`）是两件事，只看前者就会留下一枚永远呼吸的蓝点。
 *
 * 停下时**不换颜色**：仍然是蓝点、仍然带常驻光晕（点看着还是亮的），只是不呼吸
 * （`.dot-running.is-idle` 只关动画）——「这一步是当前步骤、还没做完」仍然要看得见。
 */
export function stepDotClass(status: TodoView["status"], running: boolean): string {
  if (status === "completed") return "dot-ok";
  if (status !== "in_progress") return "";
  return running ? "dot-running" : "dot-running is-idle";
}
