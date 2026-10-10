/**
 * 「任务清单」面板（`todo_write` 投影画出的那一块）的**折叠态**。
 *
 * 它为什么是一个独立模块：折叠态是**界面自己的视图偏好**，不是服务端投影、也不进
 * 聊天数据（`ChatState` 里的 `todos` 只读不写）。而它必须**活得过重新渲染**——
 * 待办投影每变一次就重渲染一次，若开合值每帧重算（或顺手写回投影），用户刚折起来的
 * 清单会立刻弹回展开。所以开合值只在用户点开关时变，这里把这套口径写成纯函数，
 * 让它在无头环境里可断言（渲染层与 App 的接线见 `components/TodoPanel.tsx` 与 `App.tsx`）。
 *
 * **单槽位**：只记「上一次是哪个会话 + 那一次的开合」，不给每个访问过的会话留一条
 * ——那种 Map 会随访问过的会话数无界增长（与 `AGENTS.md` 对长期存活进程里按会话为键的
 * Map 的要求同一条）。代价是切回旧会话时回到默认展开，这在「默认展开」的口径下没有损失。
 *
 * **收起留哪一条**也在这一层（下面的 `collapsedTodo`）：收起不是把清单藏掉，只留当前
 * 执行项 / 最后执行过的那条，判据同样是无副作用的纯函数。
 */
import type { TodoView } from "../shared/chat";

export interface TodoPanelState {
  /** 这个开合值记在**哪个会话**名下；`undefined` = 还没有任何会话时记的。 */
  sessionId: string | undefined;
  open: boolean;
}

/** 初始值：默认**展开**（用户 2026-10-10 口径），且不属于任何会话。 */
export const TODO_PANEL_DEFAULT: TodoPanelState = { sessionId: undefined, open: true };

/**
 * 当前会话该用哪个开合值。
 *
 * 存的会话与当前会话**不同**时返回默认值（展开）：新会话的清单不该一出来就是收着的。
 */
export function todosOpenIn(state: TodoPanelState, sessionId: string | undefined): boolean {
  return state.sessionId === sessionId ? state.open : TODO_PANEL_DEFAULT.open;
}

/** 点一下开关：把新开合值记在**当前会话**名下（于是它活得过这个会话里的所有重渲染）。 */
export function toggleTodos(state: TodoPanelState, sessionId: string | undefined): TodoPanelState {
  return { sessionId, open: !todosOpenIn(state, sessionId) };
}

/**
 * 收起时清单上留哪一条（用户 2026-10-10 口径：**收起不是把清单藏掉**，只留当前执行项）。
 *
 * 取法按优先级，逐条都是「投影里已有的顺序 + 状态」：
 * 1. **最后一条 `in_progress`**——正在执行的那一步（模型偶尔会一次写宽两条，取末条）；
 * 2. 没有 `in_progress` 时取**最后一条 `completed`**——这一轮已经做完 / 停下之后，
 *    用户仍要看得见「最后执行到哪」。**不取 `pending`**：那是还没轮到的步骤，
 *    把它摆到收起态上等于谎报进度；
 * 3. 两条都取不到（全 `pending`、空清单）→ `undefined`，收起态因而**一行都不挂**，
 *    只有抬头照报 `0/N` 的进度。
 *
 * 为什么只能这么推：官方 `TodoItem` 每条只有 `content` + `status`
 * （见 `docs/audit-projections-panels.md` 的「todos（任务清单）」一节），
 * 没有时间戳之类的历史字段可按——不猜服务端字段，也就不在这里发明一种。
 *
 * 纯函数、只读入参：投影数组是聊天数据，界面不许就地反转 / 排序它。
 */
export function collapsedTodo(todos: readonly TodoView[]): TodoView | undefined {
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    if (todos[index].status === "in_progress") return todos[index];
  }
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    if (todos[index].status === "completed") return todos[index];
  }
  return undefined;
}
