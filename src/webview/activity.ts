/**
 * 界面上那几个「现在有东西在跑吗」的判据：后台任务抽屉入口与标题后的子代理计数、
 * 以及待办清单里的**当前执行步骤**。
 *
 * 用户 2026-09-19 口径：有子代理在跑 → 标题后的计数提示亮起状态点；有后台任务在跑 →
 * 后台任务按钮亮起并呼吸。**运行中才有信号**，跑完立刻熄，所以判据必须是活的
 * 那一份数据，不能是「面板打开时抓的一把」。待办那一枚同一条纪律（见 `stepDotClass`）。
 *
 * 用户 2026-10-15 口径：**有待执行的自动化任务时，后台任务按钮同样要亮**——那个抽屉
 * 现在装着自动化任务与后台任务两个分区，抽屉里还有东西排着（哪怕此刻没有命令在跑），
 * 入口就不该看起来是空的。那一档**亮而不呼吸**（见 `JobsEntrySignal`）：排着不是
 * 在跑，`--info` 色给到、动画不给。
 *
 * 纯函数、不引 React：断言见 `scripts/activity.test.ts`。
 */
import type { JobItemView, ScheduleItemView, SubagentView, TodoView } from "../shared/chat";
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
 * 背景任务抽屉入口的指示灯档位。
 *
 * - `off`：抽屉里什么都没有；
 * - `pending`：**排着**待执行的自动化任务（亮，但**不呼吸**）；
 * - `busy`：有后台任务在跑（含「正在停止」——那也还没结束），亮起并呼吸。
 *
 * 为什么把「排着」与「在跑」分成两档而不是一个布尔：这两件事在事实层面不同
 * （`pending` 时并没有任何东西在执行），而这只界面已经把「呼吸」当作活动的专用信号
 * （运行圆点、思考鲸鱼、待办刻点）。给一个长期排着的任务配一枚永远呼吸的图标，正是
 * 用户自己抱怨过的那类谎报——「会话早停了、那点还在闪」（见 `stepDotClass` 与
 * `ToDo.md`），所以 `pending` 复用同一套「亮而不动」的口径。
 */
export type JobsEntrySignal = "off" | "pending" | "busy";

/**
 * 背景任务抽屉的入口该亮成哪一档：**有后台任务在跑**，或**有待执行的自动化任务**。
 *
 * 两条来源合在一个判据里，因为它们指向同一个入口（同一个抽屉的两个分区）：
 * 分开判会让「抽屉里有东西」与「入口亮着」这两件事各写一遍，迟早漂。
 *
 * - **子代理那一路不点亮这颗按钮**（用户 2026-09-24 口径）：子代理有自己的面板、
 *   自己的信号（上面的 `subagentsBusy`），而且后台任务面板也不收它——
 *   若不过滤，会出现「按钮亮着、面板却是空的」矛盾。
 * - **自动化任务只认 `status: 'active'`**：那是服务端说的「还会触发」。已结束
 *   （一次性投递完的 `inactive`）与词表外的状态都**不**点亮——不认识的状态不认领，
 *   与后台任务那边同一条纪律（不猜「在跑」，也不猜「已结束」）。
 *   注意这是**排着**而不是**在跑**：一条每小时的固定间隔任务会让入口一直亮着，
 *   这正是用户要的语义（抽屉里确实一直有东西待执行）。
 */
export function jobsEntrySignal(
  jobs: readonly JobItemView[],
  schedules: readonly ScheduleItemView[],
): JobsEntrySignal {
  if (jobs.some((job) => !isSubagentJob(job) && isLiveJob(job))) return "busy";
  return schedules.some((item) => item.status === "active") ? "pending" : "off";
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
