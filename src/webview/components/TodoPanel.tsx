import type { TodoView } from "../../shared/chat";
import { IconChevronDown } from "../icons";
import { useTexts } from "../texts";

/**
 * 「任务清单」面板：`todo_write` 投影（`ChatState.todos`）画出的那一块清单。
 *
 * 抬头是一枚**原生按钮**（`aria-expanded` + 键盘 Enter / Space 天然可用），点它开合清单；
 * 抬头里恒带进度（完成数 / 总数），所以折起来也看得出「还有几条没做」——折叠省掉的是高度，
 * 不是信息。开合值**不在本组件里**：轨迹视图会把整块会话页卸载（`App` 的 `panel` 分支），
 * 组件级 state 会在「去轨迹看一眼再回来」时丢掉，所以它由 `App` 持有、经 `TodoPanelState`
 * 按会话记账（见 `../todoPanel.ts` 的文件头）。
 *
 * 清单项的结构与折叠前逐字相同（`.todo-item` / `.todo-glyph` / `.dot` / `.todo-content`），
 * 样式仍走 `styles/app.css` 里 `.todos` 那一节。
 */
export function TodoPanel({
  todos,
  open,
  onToggle,
}: {
  todos: TodoView[];
  /** 展开态（由 `App` 按会话记账，见 `../todoPanel.ts`）。 */
  open: boolean;
  onToggle: () => void;
}) {
  const texts = useTexts();
  // 契约里状态只有三态（`pending` / `in_progress` / `completed`），进度就是「完成数 / 总数」
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <div className="todos">
      <button type="button" className="todos-head" aria-expanded={open} onClick={onToggle}>
        <span className="todos-title">{texts.todoPanelTitle(done, todos.length)}</span>
        <IconChevronDown size={12} className="todos-chevron" />
      </button>
      {/* 折叠时清单项**不挂载**（与其它折叠块同口径：省掉的是布局，不是把文字藏起来） */}
      {open
        ? todos.map((todo) => (
            <div
              key={todo.id}
              className={`todo-item${todo.status === "completed" ? " is-completed" : ""}`}
            >
              <span className="todo-glyph">
                <span
                  className={`dot ${
                    todo.status === "completed" ? "dot-ok" : todo.status === "in_progress" ? "dot-running" : ""
                  }`}
                />
              </span>
              <span className="todo-content">{todo.content}</span>
            </div>
          ))
        : null}
    </div>
  );
}
