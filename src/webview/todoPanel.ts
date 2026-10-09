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
 */
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
