/**
 * 「任务清单」面板的折叠开关（`todo_write` 投影画出的那一块）。
 *
 * 口径：清单一直展开着会把输入区越顶越高，要能折起来；但**默认展开**，折起来之后
 * 抬头仍要能看出进度（完成数 / 总数），而且重新渲染不能弹回展开。
 *
 * **收起不是把清单藏掉**（用户 2026-10-10 口径）：折起来仍留**当前执行的那一条**，
 * 省掉的是其余行的高度。当前执行项按投影里的 `in_progress` 认；一条都没有（这一轮
 * 已经做完 / 模型没写 in_progress）时留**最后执行过的那一条**，绝不拿还没执行的
 * `pending` 顶替——全 pending 与空清单因此**一行都不挂**，只有抬头照报进度。
 *
 * 四层各钉一半，缺一层就漏一种错法：
 * 1. `webview/todoPanel.ts` 的纯状态：默认展开、折叠后**同一会话**保持折叠、
 *    换会话回默认展开、状态是单槽位（不给每个访问过的会话留一条，那会无界增长）；
 * 2. 同一个模块的 `collapsedTodo`：收起时留哪一条（当前执行项 → 最后执行过的那条 → 不给）；
 * 3. 真渲染（`react-dom/server`）：抬头是个带 `aria-expanded` 的原生按钮（键盘可达）、
 *    收起时**恰好一行**清单项且三态点的类名与展开时逐字相同、中英双语；
 * 4. 接线与样式：折叠态是 App 的**本地 state**（不进聊天数据）、容器搬进组件、
 *    抬头箭头的方向（展开朝下、收起朝上：图标本身朝下 + 收起时才转 180°）。
 *
 * 断言落在产出的 HTML 与纯函数结果上，而不是源码正则上：正则只证明「代码里有这行字」，
 * 渲染能证明「用户真能看见 / 真点得到」。样式那三条是例外——旋转是 CSS 声明本身，
 * 无头环境里没有排版结果可断言。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TodoView } from "../src/shared/chat";
import {
  TODO_PANEL_DEFAULT,
  collapsedTodo,
  todosOpenIn,
  toggleTodos,
} from "../src/webview/todoPanel";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

// `bridge.ts` 在模块求值期就挂了 `window.addEventListener`（webview 里那是真实存在的
// 宿主）。无头环境里补一个最小 window，免得 import 阶段就炸——补在 import 之前。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { TodoPanel } = await import("../src/webview/components/TodoPanel");

/** 三条各自一种状态（契约里的三态词表：`pending` / `in_progress` / `completed`）。 */
const todos: TodoView[] = [
  { id: "t1", content: "读契约", status: "completed" },
  { id: "t2", content: "改界面", status: "in_progress" },
  { id: "t3", content: "跑三件套", status: "pending" },
];

/**
 * 渲染成 HTML；语言按真实链路给（默认英文，这里显式喂词典）。
 *
 * `running` 会话是否还在生成：当前执行步骤那枚刻点的活性吃它（生成中呼吸、停下
 * 之后蓝色不闪动，见 `activity.ts` 的 `stepDotClass`）。默认 `true` = 生成中那一档，
 * 也就是折叠之前的老观感，下面的「逐字相同」断言都按它比。
 */
const render = (
  open: boolean,
  locale: "zh" | "en" = "zh",
  items: TodoView[] = todos,
  running = true,
): string =>
  renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor(locale) },
      createElement(TodoPanel, { todos: items, running, open, onToggle: () => {} }),
    ),
  );

// ---------- 1. 纯状态：默认展开，折叠后同一会话保持折叠 ----------
{
  assert.strictEqual(
    TODO_PANEL_DEFAULT.open,
    true,
    "折叠开关的默认值必须是**展开**（用户 2026-10-10 口径）",
  );
  assert.strictEqual(todosOpenIn(TODO_PANEL_DEFAULT, "s1"), true, "还没人点过时，任何会话都是展开");

  const collapsed = toggleTodos(TODO_PANEL_DEFAULT, "s1");
  assert.strictEqual(todosOpenIn(collapsed, "s1"), false, "点一下即折叠");
  // 这条就是「重新渲染不要立刻弹回展开」：数据帧继续来（状态对象不变）时读出来还是折叠。
  // 若开合值改由投影 / 每帧重算（而不是本地 state），这里立刻回到 true。
  assert.strictEqual(
    todosOpenIn(collapsed, "s1"),
    false,
    "同一会话内反复读都要是折叠（重新渲染不弹回展开）",
  );
  assert.strictEqual(todosOpenIn(toggleTodos(collapsed, "s1"), "s1"), true, "再点一下展开回来");

  // 换会话读默认值：上一个会话的折叠**不跟过来**（新清单不该一出来就是收着的）
  assert.strictEqual(todosOpenIn(collapsed, "s2"), true, "换会话回默认（展开）");
  // 单槽位：状态里只有「哪个会话 + 那次的开合」两个键，不给每个访问过的会话留一条
  assert.deepStrictEqual(
    Object.keys(collapsed).sort(),
    ["open", "sessionId"],
    "折叠态只留一个槽位——按会话攒成 Map 会随访问过的会话数无界增长",
  );
}
console.log("todoCollapse: 纯状态（默认展开 / 折叠保持 / 换会话回默认 / 单槽位） ✓");

// ---------- 1b. 收起时留哪一条：当前执行项 → 最后执行过的那条 → 一条都不给 ----------
//
// 「最后执行过的项目」只能由**投影里的顺序 + 状态**推出来：官方 `TodoItem` 每条只有
// `content` + `status`（三态词表，见 `docs/audit-projections-panels.md` 的
// 「todos（任务清单）」一节与 `activity.ts` 的 `stepDotClass`），没有时间戳之类的
// 历史字段可按——不去猜服务端字段，也就不在这里发明一种。
{
  const mixed: TodoView[] = [
    { id: "a", content: "已完成的旧步骤", status: "completed" },
    { id: "b", content: "正在做", status: "in_progress" },
    { id: "c", content: "还没做", status: "pending" },
  ];
  assert.strictEqual(collapsedTodo(mixed)?.id, "b", "有正在做的那条就留它");

  // 投影里可能同时写着多条 `in_progress`（模型一次写宽的清单）：留**最后一条**
  const twoActive: TodoView[] = [
    { id: "a", content: "先做的", status: "in_progress" },
    { id: "b", content: "后做的", status: "in_progress" },
    { id: "c", content: "还没做", status: "pending" },
  ];
  assert.strictEqual(collapsedTodo(twoActive)?.id, "b", "多条 in_progress 时留最后一条");

  // 没有 in_progress：留**最后一条执行过的**（completed），不是第一条、更不是后面的 pending
  const done: TodoView[] = [
    { id: "a", content: "第一步", status: "completed" },
    { id: "b", content: "第二步", status: "completed" },
    { id: "c", content: "还没做", status: "pending" },
  ];
  assert.strictEqual(collapsedTodo(done)?.id, "b", "没有当前执行项时留最后一条已完成项");

  // 只有 pending（还没开始跑）/ 空清单：明确给不出——收起态因此一行都不挂
  assert.strictEqual(
    collapsedTodo([{ id: "a", content: "待办", status: "pending" }]),
    undefined,
    "全 pending 时没有「执行过的项目」——不拿 pending 顶替",
  );
  assert.strictEqual(collapsedTodo([]), undefined, "空清单给不出条目");

  // 只读：不许就地反转 / 排序调用方那份投影数组
  const input: TodoView[] = [...done];
  collapsedTodo(input);
  assert.deepStrictEqual(
    input.map((todo) => todo.id),
    ["a", "b", "c"],
    "取末条不许改动传入的投影数组",
  );
}
console.log("todoCollapse: 收起留哪一条（当前执行项 → 最后执行过的那条 → 一条不给） ✓");

// ---------- 2. 默认展开：抬头 + 全部清单项都在 ----------
{
  const html = render(true);
  // 抬头是**原生按钮**（键盘 Enter / Space 天然可用）+ `aria-expanded`（无障碍语义）
  assert.ok(
    /<button type="button" class="todos-head" aria-expanded="true">/.test(html),
    `抬头必须是带 aria-expanded 的原生按钮（键盘可达）：${html.slice(0, 240)}`,
  );
  assert.ok(html.includes("任务清单 (1/3)"), `抬头要能看出进度（完成数 / 总数）：${html.slice(0, 240)}`);
  // 三条清单项与折叠前逐字相同的结构（既有样式体系不许被这次改动破坏）
  for (const content of ["读契约", "改界面", "跑三件套"]) {
    assert.ok(html.includes(content), `展开时清单项要照旧渲染：${content}`);
  }
  assert.ok(/<span class="todos-title">/.test(html), "抬头文字有独立的容器（窄侧栏靠它出省略号）");
  assert.ok(/class="todos-chevron"/.test(html), "抬头右侧要有折展箭头");
}
console.log("todoCollapse: 默认展开 + 抬头带进度 ✓");

// ---------- 3. 收起：只剩**当前执行项**一行，抬头（进度）仍在 ----------
{
  const html = render(false);
  assert.ok(
    /<button type="button" class="todos-head" aria-expanded="false">/.test(html),
    `收起时 aria-expanded 必须是 false：${html.slice(0, 240)}`,
  );
  assert.ok(html.includes("任务清单 (1/3)"), "折起来也要能看出有几条 / 完成了几条");
  assert.ok(html.includes("改界面"), "收起时当前执行项要留在面板上（不是整块藏掉）");
  for (const content of ["读契约", "跑三件套"]) {
    assert.ok(!html.includes(content), `收起时其余行不挂载（省的是高度）：${content}`);
  }
  assert.strictEqual(
    html.match(/class="todo-item/g)?.length,
    1,
    `收起时恰好一行清单项：${html.slice(0, 400)}`,
  );
  // 留下的那一行与展开时**逐字同结构**（`.todo-item` / `.todo-glyph` / `.dot` /
  // `.todo-content`，样式体系一个字没动），刻点档位也照旧：会话仍在生成 → 呼吸。
  assert.ok(
    /class="todo-item"><span class="todo-glyph"><span class="dot dot-running"><\/span><\/span><span class="todo-content">改界面<\/span>/.test(
      html,
    ),
    `收起那一行与展开时逐字相同：${html.slice(0, 400)}`,
  );
  // 会话停下来那一档在收起态同样成立（用户口径：停下之后蓝色不闪动）
  const stopped = render(false, "zh", todos, false);
  assert.ok(
    /class="todo-item"><span class="todo-glyph"><span class="dot dot-running is-idle"/.test(stopped),
    `收起态里停下之后仍是蓝点不闪（is-idle）：${stopped.slice(0, 400)}`,
  );
}
console.log("todoCollapse: 收起后只留当前执行项、其余不挂载 ✓");

// ---------- 3b. 没有当前执行项：留最后执行过的那条（不是 pending） ----------
{
  const done: TodoView[] = [
    { id: "a", content: "第一步", status: "completed" },
    { id: "b", content: "第二步", status: "completed" },
    { id: "c", content: "还没做", status: "pending" },
  ];
  const html = render(false, "zh", done);
  assert.ok(html.includes("第二步"), `没有 in_progress 时留最后一条已完成项：${html.slice(0, 400)}`);
  assert.ok(!html.includes("第一步"), "不留更早的那条已完成项");
  assert.ok(!html.includes("还没做"), "不许拿还没执行的 pending 顶替");
  assert.ok(/class="dot dot-ok"/.test(html), "留下的已完成项照旧用 .dot-ok");
  assert.strictEqual(html.match(/class="todo-item/g)?.length, 1, "仍然恰好一行");
}
console.log("todoCollapse: 无 in_progress 时留最后执行过的那条 ✓");

// ---------- 3c. 全 pending / 空清单：收起态一行都不挂，抬头照报进度 ----------
{
  const allPending: TodoView[] = [
    { id: "a", content: "还没做的一", status: "pending" },
    { id: "b", content: "还没做的二", status: "pending" },
  ];
  const html = render(false, "zh", allPending);
  assert.ok(html.includes("任务清单 (0/2)"), `全 pending 时抬头照报进度：${html.slice(0, 240)}`);
  assert.ok(!html.includes("还没做的"), "还没执行的条目不许当成当前步骤展示");
  assert.ok(!/class="todo-item/.test(html), "全 pending 时收起态没有条目行");

  const empty = render(false, "zh", []);
  assert.ok(empty.includes("任务清单 (0/0)"), `空清单的抬头照旧：${empty.slice(0, 240)}`);
  assert.ok(!/class="todo-item/.test(empty), "空清单没有条目行");
}
console.log("todoCollapse: 全 pending / 空清单收起后不留条目行 ✓");

// ---------- 4. 三态点色与折叠前的旧行为逐字相同 ----------
//
// 顺手核对：契约里的 `TodoItem.status` 只有三态（`pending` / `in_progress` / `completed`，
// 见官方 `TodoItem` 与 docs/audit-projections-panels.md 的 todos 一节），
// 所以进度只算「完成数 / 总数」，不发明第四种状态。
{
  const html = render(true);
  assert.ok(
    /class="todo-item is-completed"[\s\S]{0,200}?class="dot dot-ok"/.test(html),
    "completed：行加 .is-completed、点用 .dot-ok（既有口径不动）",
  );
  assert.ok(
    /class="todo-item"[\s\S]{0,200}?class="dot dot-running"/.test(html),
    "in_progress 且会话仍在生成：点用 .dot-running（呼吸）",
  );
  // 会话停下来那一档（用户点停 / 本轮出错 / 打开早就停下的会话）：同一个 in_progress
  // 条目仍走 `.dot-running` 的蓝色观感，只多一个 `is-idle` 关掉呼吸——用户 2026-10-10
  // 口径是「显示为蓝色不闪动」，不是换一种颜色（判据见 `activity.ts` 的 `stepDotClass`）。
  const stopped = render(true, "zh", todos, false);
  assert.ok(
    /class="todo-item"[\s\S]{0,200}?class="dot dot-running is-idle"/.test(stopped),
    "in_progress 且会话已停下：点用 .dot-running is-idle（蓝色不闪动）",
  );
  const pending = html.slice(html.indexOf("跑三件套") - 200, html.indexOf("跑三件套"));
  assert.ok(
    /<div class="todo-item">[\s\S]*<span class="todo-glyph">[\s\S]*<span class="dot\s*"/.test(pending),
    `pending：点不带状态类（空的 class 落到基础 .dot）：${pending}`,
  );

  // 进度只数 completed
  const oneDone = render(true, "zh", [
    { id: "a", content: "已完成", status: "completed" },
    { id: "b", content: "进行中", status: "in_progress" },
  ]);
  assert.ok(oneDone.includes("任务清单 (1/2)"), `进行中不算完成：${oneDone.slice(0, 240)}`);
  const noneDone = render(true, "zh", [{ id: "a", content: "待办", status: "pending" }]);
  assert.ok(noneDone.includes("任务清单 (0/1)"), `一条都没完成时给 0/1：${noneDone.slice(0, 240)}`);
}
console.log("todoCollapse: 三态点色不变、进度只数完成数 ✓");

// ---------- 5. 英文（双语规则：文案走词典，组件里不写死） ----------
{
  const open = render(true, "en");
  assert.ok(open.includes("To-do list (1/3)"), `英文抬头要能看出进度：${open.slice(0, 240)}`);
  assert.ok(!open.includes("任务清单"), "英文词典下不该漏出中文");
  const closed = render(false, "en");
  assert.ok(closed.includes("To-do list (1/3)"), `英文折叠态同样带进度：${closed.slice(0, 240)}`);
  assert.strictEqual(
    dictionaryFor("zh").todoPanelTitle(1, 3),
    "任务清单 (1/3)",
    "抬头文案登记成字典函数（中英各一份）",
  );
  assert.strictEqual(
    dictionaryFor("en").todoPanelTitle(1, 3),
    "To-do list (1/3)",
    "英文抬头文案同样登记",
  );
}
console.log("todoCollapse: 中英双语抬头 ✓");

// ---------- 6. 接线：折叠态是 App 的本地 state，不进聊天数据 ----------
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /const \[todosState, setTodosState\] = useState<TodoPanelState>\(TODO_PANEL_DEFAULT\)/.test(app),
    "折叠态由 App 的本地 state 持有（组件卸载/重渲染都不该丢）",
  );
  assert.ok(
    /const todosOpen = todosOpenIn\(todosState, sessionId\)/.test(app),
    "开合值按**当前会话**读出来（切会话回默认展开）",
  );
  assert.ok(
    /setTodosState\(toggleTodos\(todosState, sessionId\)\)/.test(app),
    "点开关只改本地 state（不往宿主 / 服务端发指令）",
  );
  assert.ok(
    /<TodoPanel[\s\S]{0,200}?todos=\{state\.todos\}/.test(app),
    "面板拿投影原值（界面不自己折叠待办）",
  );
  assert.ok(
    !/className="todos"/.test(app),
    "清单容器已搬进 TodoPanel（App 不再内联画它，否则两处口径会各漂）",
  );

  // 反方向：折叠态不许混进聊天数据 / 状态机（那是服务端投影的地盘）
  const chat = readFileSync(join(process.cwd(), "src", "shared", "chat.ts"), "utf8");
  assert.ok(!/todosOpen|todosCollapsed|todoPanel/i.test(chat), "折叠态不进 ChatState");
  const state = readFileSync(join(process.cwd(), "src", "webview", "state.ts"), "utf8");
  assert.ok(!/todosOpen|todosCollapsed/.test(state), "state.ts 不为折叠态新增字段 / action");
}
console.log("todoCollapse: 折叠态是本地 UI state、不进聊天数据 ✓");

// ---------- 7. 样式：在既有 `.todos` 规则上扩展，不推翻 ----------
{
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  /** 取一个选择器的声明块（第一个匹配）。 */
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
    assert.ok(match, `app.css 里找不到选择器 ${selector}`);
    return match[1];
  };

  // 既有容器与清单项规则原样保留（这次只是**扩展**）
  const container = rule(".todos");
  assert.ok(/border:\s*1px solid var\(--border\)/.test(container), ".todos 的边框照旧");
  assert.ok(/background:\s*var\(--editor-bg\)/.test(container), ".todos 的底色照旧");
  assert.ok(/flex-direction:\s*column/.test(container), ".todos 仍是竖排容器");
  assert.ok(/display:\s*flex/.test(rule(".todo-item")), ".todo-item 的排版照旧");
  assert.ok(/line-height:\s*1\.5/.test(rule(".todo-item")), "条目使用明确行高，刻点槽与文字首行高度保持一致");
  const glyph = rule(".todo-glyph");
  assert.ok(/height:\s*1lh/.test(glyph), "刻点槽高度跟随首行行高，换行与字号变化不依赖固定偏移");
  assert.ok(
    /align-items:\s*center/.test(glyph) && /justify-content:\s*center/.test(glyph),
    "展开与收起、三种状态共用双轴居中的刻点槽",
  );
  assert.ok(!/padding|margin|transform/.test(glyph), "刻点槽不使用手工偏移模拟居中");
  assert.ok(
    /text-decoration:\s*line-through/.test(rule(".todo-item.is-completed .todo-content")),
    "已完成项的删除线照旧",
  );

  // 新增的抬头：可点、文字能被裁（英文比中文长）、箭头随开合转
  const head = rule(".todos-head");
  assert.ok(/cursor:\s*pointer/.test(head), ".todos-head 要露出手型（它是开关）");
  assert.ok(/display:\s*flex/.test(head), ".todos-head 按一行排「标题 + 箭头」");
  assert.ok(/width:\s*100%/.test(head), ".todos-head 占满整行（不然只有图标那一小段能点）");
  const title = rule(".todos-title");
  assert.ok(
    /white-space:\s*nowrap/.test(title) && /text-overflow:\s*ellipsis/.test(title),
    "抬头文字要一行截断（英文比中文长，窄侧栏靠它兜底）",
  );
  assert.ok(/transition:\s*transform/.test(rule(".todos-chevron")), "箭头要有旋转过渡");
  // 箭头方向（用户 2026-10-10 口径）：**展开朝下、收起朝上**。两半合起来才成立——
  // 图标本身是朝下的 `IconChevronDown`（下面用真渲染钉住它的路径），所以收起时才转 180°。
  // 这条刻意与本应用其它折展箭头（`.changes-card-chevron` / `.turn-process-chevron`
  // 那一套「展开朝上」）相反：清单贴在输入区上方，箭头指的是面板自身往哪边收。
  assert.ok(
    /transform:\s*rotate\(180deg\)/.test(rule('.todos-head[aria-expanded="false"] .todos-chevron')),
    "收起时箭头朝上（图标朝下 + 转 180°）",
  );
  {
    const expandedChevron = new RegExp(
      '\\.todos-head\\[aria-expanded="true"\\]\\s*\\.todos-chevron\\s*\\{([\\s\\S]*?)\\}',
      "u",
    ).exec(css);
    assert.ok(
      expandedChevron === null || !/rotate/.test(expandedChevron[1]),
      "展开时箭头不旋转（图标本身就朝下）",
    );
    // 图标那半：真渲染出来的就是朝下的 chevron（`M5 9l7 7 7-7`），展开 / 收起都一样，
    // 方向差别全在 CSS 的旋转上。
    for (const open of [true, false]) {
      assert.ok(
        render(open).includes('d="M5 9l7 7 7-7"'),
        `抬头那颗图标本身朝下（open=${open}）`,
      );
    }
  }
  assert.ok(/outline/.test(rule(".todos-head:focus-visible")), "键盘聚焦要有可见的焦点环");
}
console.log("todoCollapse: 在既有 .todos 规则上扩展（容器与清单项不动） ✓");

console.log("\ntodoCollapse: all assertions passed");
