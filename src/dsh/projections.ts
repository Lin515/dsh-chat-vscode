/**
 * 投影值的形状解析（纯函数，便于离线断言）。
 *
 * 抽出来的理由很直接：`goal` 与 `subagentCatalog` 两个 bug 都是**形状读错**——
 * 按猜测的字段写、没有契约核对、也没有断言，于是「恒为空」这种失败在界面上
 * 表现为「这个功能没有」，而不是报错（docs/audit-summary.md §3、§4）。
 * 形状解析是这一层里最容易错、又最容易测的部分，所以从控制器里挪出来单测。
 */
import type { GoalView, SubagentView } from "../shared/chat";

/**
 * `goal` 投影 → 目标条数据。
 *
 * 线格式是**嵌套**的（`GoalProjection`，`dsh-goal/lib/types/types.d.ts`）：
 * ```
 * { goal: { id, revision, objective, phase, blockedReason?, maxGoalRounds },
 *   roundsStarted, createdAt, updatedAt }
 * ```
 * 注意轮次计数在**外层**：`roundsStarted` 不属于 `goal` 本体。
 * 没有目标时投影值是 `null`。
 */
export function goalFromProjection(value: unknown): GoalView | undefined {
  const projection = value as { goal?: unknown; roundsStarted?: unknown } | null | undefined;
  const goal = projection?.goal as
    | {
        id?: unknown;
        revision?: unknown;
        objective?: unknown;
        phase?: unknown;
        blockedReason?: { message?: unknown } | null;
        maxGoalRounds?: unknown;
      }
    | null
    | undefined;
  if (!goal || typeof goal.objective !== "string" || !goal.objective) return undefined;
  const phase = goal.phase;
  return {
    id: typeof goal.id === "string" ? goal.id : undefined,
    revision: typeof goal.revision === "number" ? goal.revision : undefined,
    objective: goal.objective,
    // 词表外的 phase 一律当 active：界面有标签可显示，不至于整条不渲染
    phase: phase === "paused" || phase === "blocked" || phase === "complete" ? phase : "active",
    rounds: typeof projection?.roundsStarted === "number" ? projection.roundsStarted : 0,
    maxRounds: typeof goal.maxGoalRounds === "number" ? goal.maxGoalRounds : undefined,
    blockedReason:
      typeof goal.blockedReason?.message === "string" ? goal.blockedReason.message : undefined,
  };
}

/**
 * `plan` 投影 → 「计划模式是否生效」。
 *
 * 投影是 `{ active, pending }`（`dsh-plan-mode/lib/types/types.d.ts`）：
 * `active` 是**已落日志**的状态（最后一条 `plan/mode`），`pending` 表示有一次
 * `/plan` 选择指向与 `active` 不同的目标、且还没有 `plan/mode` 记录它。
 * 所以**生效**状态是 `pending ? !active : active`（等价于 `active !== pending`）。
 *
 * 只读 `active` 会在**轮次进行中**点「进入计划模式」时立刻出错：那一刻服务端返回
 * 「Entering plan mode (applies from the next step).」，`active` 仍为 false，于是
 * 按钮看起来毫无反应——用户会再点一次，而契约里对同一目标重复选择是 no-op。
 * 官方 chip 用的就是这个表达式（`dsh-client-ui-plan/lib/client.js:47`）。
 */
export function planModeFromProjection(value: unknown): boolean {
  const projection = value as { active?: unknown; pending?: unknown } | null | undefined;
  const active = Boolean(projection?.active);
  const pending = Boolean(projection?.pending);
  return pending ? !active : active;
}

/**
 * `subagentCatalog` 投影 → 子代理列表。
 *
 * 投影值是 `SubagentCatalogEntry[]` = `{id, createdAt, mode, label?}`——**没有**
 * `kind`/`activity`（那两个字段属于 `subagents/list` 的 RPC 行 `SubagentListEntry`）。
 * 把 RPC 行的 `kind === "child"` 过滤套在投影上会让目录恒为空。
 *
 * 投影也不携带驻留状态，所以 `known`（上一次 RPC 列表）里同 id 的 `activity`
 * 原样保留；不知道就不下发——界面据此不画状态点，而不是猜「正在运行」。
 *
 * @param value 投影值（数组）。
 * @param known 上一次已知的列表，用于保留 activity。
 */
export function subagentsFromCatalog(value: unknown, known: readonly SubagentView[] = []): SubagentView[] {
  const entries = Array.isArray(value) ? value : [];
  return entries.map((entry) => {
    const child = entry as { id?: unknown; mode?: unknown; label?: unknown };
    const id = String(child.id ?? "");
    const previous = known.find((item) => item.id === id);
    return {
      id,
      label: typeof child.label === "string" && child.label ? child.label : id,
      // `SubagentCatalogEntry` 是判别联合：continuable 必带 label，one-shot 的 label 可省。
      // 认不出就按 one-shot 处理——拿它去 follow 不会被鉴权拒绝，反过来会。
      mode: child.mode === "continuable" ? ("continuable" as const) : ("one-shot" as const),
      activity: previous?.activity,
    };
  });
}

/**
 * `subagents/list` RPC 行 → 子代理列表。
 *
 * 这里是 `SubagentListEntry`：`kind:'child'` 才是可用子代理，`kind:'diagnostic'`
 * 是「有候选但读不出身份」的诊断行。与投影不同，这一路**带** `activity`/`mode`。
 */
export function subagentsFromList(value: unknown): SubagentView[] {
  const entries = Array.isArray(value) ? value : [];
  return entries
    .filter((entry) => (entry as { kind?: unknown })?.kind === "child")
    .map((entry) => {
      const child = entry as { id?: unknown; activity?: unknown; label?: unknown; mode?: unknown };
      const id = String(child.id ?? "");
      return {
        id,
        label: typeof child.label === "string" && child.label ? child.label : id,
        mode: child.mode === "continuable" ? ("continuable" as const) : ("one-shot" as const),
        activity: child.activity === "running" ? ("running" as const) : ("inactive" as const),
      };
    });
}
