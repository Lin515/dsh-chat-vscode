import type { TodoView } from "../../shared/chat";
import { stepDotClass } from "../activity";
import { IconChevronDown } from "../icons";
import { useTexts } from "../texts";
import { collapsedTodo } from "../todoPanel";

/**
 * 「任务清单」面板：`todo_write` 投影（`ChatState.todos`）画出的那一块清单。
 *
 * 抬头是一枚**原生按钮**（`aria-expanded` + 键盘 Enter / Space 天然可用），点它开合清单；
 * 抬头里恒带进度（完成数 / 总数），所以折起来也看得出「还有几条没做」——折叠省掉的是高度，
 * 不是信息。开合值**不在本组件里**：轨迹视图会把整块会话页卸载（`App` 的 `panel` 分支），
 * 组件级 state 会在「去轨迹看一眼再回来」时丢掉，所以它由 `App` 持有、经 `TodoPanelState`
 * 按会话记账（见 `../todoPanel.ts` 的文件头）。
 *
 * **收起不是把清单藏掉**（用户 2026-10-10 口径）：那时只挂载 `collapsedTodo` 选出的那一行
 * ——当前执行项，没有在执行的则是最后一条执行过的；全 pending / 空清单给不出条目，于是
 * 收起态只有抬头。抬头箭头的方向也按这条口径：图标本身朝下（`IconChevronDown`），
 * 收起时才转 180° 朝上（样式见 `styles/app.css` 的 `.todos-chevron`）。
 *
 * 清单项的结构与折叠前逐字相同（`.todo-item` / `.todo-glyph` / `.dot` / `.todo-content`），
 * 展开与收起走**同一段渲染**，样式仍走 `styles/app.css` 里 `.todos` 那一节。
 */
export function TodoPanel({
  todos,
  running,
  open,
  onToggle,
}: {
  todos: TodoView[];
  /**
   * 会话此刻是否还在生成（`ChatState.running`）。当前执行步骤那枚刻点的活性吃它：
   * 生成中呼吸，会话停下来（点停 / 出错 / 打开早就停下的会话）之后保持蓝色不闪动
   * ——判据见 `../activity.ts` 的 `stepDotClass`。
   */
  running: boolean;
  /** 展开态（由 `App` 按会话记账，见 `../todoPanel.ts`）。 */
  open: boolean;
  onToggle: () => void;
}) {
  const texts = useTexts();
  // 契约里状态只有三态（`pending` / `in_progress` / `completed`），进度就是「完成数 / 总数」
  const done = todos.filter((todo) => todo.status === "completed").length;
  // 展开 → 整份投影；收起 → 只留 `collapsedTodo` 选中的那一条（可能一条都没有）
  const current = collapsedTodo(todos);
  const rows = open ? todos : current ? [current] : [];
  return (
    <div className="todos">
      <button type="button" className="todos-head" aria-expanded={open} onClick={onToggle}>
        <span className="todos-title">{texts.todoPanelTitle(done, todos.length)}</span>
        <IconChevronDown size={12} className="todos-chevron" />
      </button>
      {/* 收起时其余行不挂载（与其它折叠块同口径：省掉的是布局，不是把文字藏起来）；
          留下的那一行与展开时是同一段渲染，刻点档位 / 样式逐字相同 */}
      {rows.map((todo) => (
        <div
          key={todo.id}
          className={`todo-item${todo.status === "completed" ? " is-completed" : ""}`}
        >
          <span className="todo-glyph">
            {/* 当前执行步骤的活性随会话停 / 跑切换：生成中呼吸，会话停下来
                之后保持蓝色不闪动（判据见 `activity.ts` 的 `stepDotClass`）。 */}
            <span className={`dot ${stepDotClass(todo.status, running)}`} />
          </span>
          <span className="todo-content">{todo.content}</span>
        </div>
      ))}
    </div>
  );
}
