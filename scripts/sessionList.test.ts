/**
 * 会话列表行的可见性与分支的呈现。
 *
 * 用户 2026-09-12 反馈：「创建了分支，但新分支会话不会在会话历史里显示」。
 * 根因是过滤判据写错——契约里 `parentSessionId` 分支与子代理**都有**，
 * 只有 `origin` 能区分（`'subagent'`）。这组断言把判据钉死，并覆盖分支行
 * 与普通会话**同级**（不缩进、靠标题前缀「分支: 」区分，用户 2026-09-19 口径）。
 *
 * 还钉住**发帧前的按窗口收窄**（用户 2026-10-10 口径）：没有打开文件夹时，每个会话
 * 可以各自选一个工作目录，历史列表跟着**这个窗口当前那条会话的 cwd**——纯函数判据在
 * 这里，行为级回归（驱动真控制器）在 `scripts/sessionListScope.test.ts`。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizePath, upperDriveLetter, visibleForView, visibleForWorkspace, visibleSessionCandidates, visibleSessionRows } from "../src/dsh/sessionList";
import { dictionaryFor, TextsContext } from "../src/webview/texts";

// `bridge.ts`（`History.tsx` 间接引入）在模块求值期就挂了 `window.addEventListener`
// （webview 里那是真实存在的宿主）。无头环境里补一个最小 window，且必须补在
// **动态 import 之前**（同 `questionRender.test.ts` 的做法）。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
const { HistoryPanel } = await import("../src/webview/components/History");

// ---------- 1. 分支必须留着，子代理必须藏起来 ----------
//
// 形状取自真实 `session/list`（scripts/sessionListProbe.ts 实测）：
// fork 子会话 = { parentSessionId: 源会话, origin: undefined }
// 子代理会话 = { parentSessionId: 源会话, origin: 'subagent' }
{
  const rows = [
    { sessionId: "root" },
    { sessionId: "branch", parentSessionId: "root" },
    { sessionId: "branch-of-branch", parentSessionId: "branch" },
    { sessionId: "subagent-child", parentSessionId: "root", origin: "subagent" },
  ];
  const visible = visibleSessionRows(rows).map((row) => row.sessionId);
  assert.deepStrictEqual(
    visible,
    ["root", "branch", "branch-of-branch"],
    "分支（有 parent、origin 为空）必须在列表里，只有 origin='subagent' 才该藏",
  );
  assert.ok(
    !visible.includes("subagent-child"),
    "子代理会话仍然不该出现在历史列表里",
  );
}
console.log("sessionList: 分支可见、子代理隐藏 ✓");

// ---------- 2. 分支与普通会话**同级**：不缩进，靠标题前缀区分 ----------
//
// 用户 2026-09-12 的诉求是「分支要看得见」，2026-09-19 追加口径：**不缩进**，
// 和普通会话一样平铺，新会话的名字读作「分支: 原会话标题」。所以这里钉住
// 「界面按 `parentSessionId` 判断是不是分支」+「没有缩进那套东西」。
{
  const history = readFileSync(
    join(process.cwd(), "src", "webview", "components", "History.tsx"),
    "utf8",
  );
  assert.ok(
    /const forked = session\.parentSessionId !== undefined;/.test(history),
    "History 必须按 parentSessionId 判断分支（depth 已随缩进一起删掉）",
  );
  assert.ok(
    /\{forked \? texts\.forkedTitle\(title\) : title\}/.test(history),
    "分支行的标题必须走词典的 forkedTitle（「分支: 」/「Fork: 」两套文案）",
  );
  assert.ok(
    !/session-indent|is-child/.test(history),
    "分支行不再缩进（用户 2026-09-19 口径）：History 里不该再有缩进类或缩进变量",
  );
  const styles = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  assert.ok(
    !/session-indent|\.session-item\.is-child/.test(styles),
    "缩进与分支竖线的样式必须一起删掉（留着就是死样式，下次改样式会被它误导）",
  );

  // 词典：中英都要有，且都带标题参数（TS 会强制，这里顺带钉住形态）
  // 两种语言统一「半角冒号 + 一个空格」（用户口径）
  // 词典断言（连参数一起验），不 grep 源文件里的字面量——文案表现在住在 messages.ts
  assert.strictEqual(dictionaryFor("zh").forkedTitle("x"), "分支: x", "中文前缀是「分支: 」");
  assert.strictEqual(dictionaryFor("en").forkedTitle("x"), "Fork: x", "英文前缀是「Fork: 」");
}
console.log("sessionList: 分支与普通会话同级（标题前缀区分）✓");

// ---------- 2a. 行内「复制会话 ID」：常驻（当前会话 / 运行中的会话也有），且在归档左边 ----------
//
// 用户 2026-10-01 口径。两件事都容易在后续改动里悄悄回退：归档 / 删除那排按钮整体被
// `locked ? null :` 包着，把复制按钮顺手写进去就会出现「最需要它的当前会话反而没有」；
// 位置要求（归档左边）也只是书写顺序，没有任何编译期约束。
{
  const history = readFileSync(
    join(process.cwd(), "src", "webview", "components", "History.tsx"),
    "utf8",
  );
  const actionsStart = history.indexOf('<span className="session-item-actions">');
  const copyButton = history.indexOf("<IconCopyButton", actionsStart);
  const lockedBranch = history.indexOf("{locked ? null : (", actionsStart);
  const archiveButton = history.indexOf("<IconArchive size={13}", actionsStart);
  assert.ok(actionsStart > 0, "取不到会话行的操作区（.session-item-actions）");
  assert.ok(copyButton > actionsStart, "会话行操作区里必须有复制会话 ID 按钮");
  assert.ok(
    /<IconCopyButton text=\{session\.id\} title=\{texts\.copySessionId\} \/>/.test(history),
    "复制按钮复制的是 session.id，title 走词典的 copySessionId（中英各一份）",
  );
  assert.ok(
    lockedBranch > 0 && lockedBranch > copyButton,
    "复制会话 ID 必须在 locked 分支**之外**——当前会话与运行中的会话同样要能复制自己的 ID",
  );
  assert.ok(
    archiveButton > 0 && copyButton < archiveButton,
    "复制按钮要在归档按钮左边（用户 2026-10-01 的位置口径）",
  );
}
console.log("sessionList: 复制会话 ID 常驻且在归档左边 ✓");

// ---------- 2b. 历史列表的多选与批量动作（用户 2026-10-15 口径） ----------
//
// 用户 2026-10-15：抽屉顶部加一颗**多选形态开关**（在归档切换按钮左边，与它同一套切换制：
// 点开才长出复选框与批量工具条，再点一次退出）；多选形态下可全选、对选中项归档 / 恢复 /
// 删除（删除要二次确认）；切到归档列表复用同一套逻辑，只是归档那颗变成**恢复**。
//
// 纯判据（可选 / 选择集跟随列表 / 全选翻转）在 `sessionSelection.test.ts` 里钉；这里钉
// 组件与宿主侧的接线——它们漏一处都不会编译报错，只会让按钮点了没反应或选错了对象：
// ① 复选框与行内那两颗按钮必须用**同一个**可选判据（`sessionLocked`）：各写各的，就会出现
//    「复选框勾得上、点下去却被宿主拒」；
// ② 复选框与工具条**只在多选形态里**渲染（平时抽屉是一张干净列表）；
// ③ 归档视图那条恢复链路（`unarchiveSession` 从界面一路到控制器）；
// ④ 批量删除与行内垃圾桶同一条二次确认口径（`DELETE_ARM_MS`）。
{
  const history = readFileSync(
    join(process.cwd(), "src", "webview", "components", "History.tsx"),
    "utf8",
  );
  assert.ok(
    /const locked = sessionLocked\(session, currentId\);/.test(history),
    "行内归档 / 恢复 / 删除与复选框必须共用 sessionLocked（写两遍判据迟早漂）",
  );
  assert.ok(
    /<input[\s\S]{0,300}?type="checkbox"[\s\S]{0,300}?checked=\{selected\.has\(session\.id\)\}[\s\S]{0,300}?disabled=\{locked\}/.test(
      history,
    ),
    "多选形态的行要有复选框：勾选态读选择集、禁用位读那个共用的可选判据",
  );
  assert.ok(
    /pruneSelection/.test(history) && /selectableSessionIds/.test(history) && /toggleAllSelection/.test(history),
    "多选判据必须走 sessionSelection 那三个纯函数（选择集跟随列表 + 全选翻转都在那里）",
  );

  // 多选形态开关：位置（归档切换左边）、切换制（aria-pressed + is-active）、进出都清干净
  const headStart = history.indexOf('<div className="drawer-head">');
  const multiToggle = history.indexOf("title={multiSelect ? texts.multiSelectExit : texts.multiSelect}", headStart);
  const archiveToggle = history.indexOf("title={texts.archiveList}", headStart);
  assert.ok(
    headStart > 0 && multiToggle > headStart && archiveToggle > multiToggle,
    "多选开关必须在顶部归档切换按钮的**左边**（用户 2026-10-15 的位置口径）",
  );
  assert.ok(
    /aria-pressed=\{multiSelect\}/.test(history) &&
      /className=\{`icon-btn\$\{multiSelect \? " is-active" : ""\}`\}/.test(history),
    "多选开关是切换制：状态写在 aria-pressed 上，打开时有按下态（与归档入口同一套 is-active）",
  );
  // 两道闸门：一道给行首复选框、一道给批量工具条（顺序也是这两处）
  const gates = [...history.matchAll(/\{multiSelect \? \(/g)].map((match) => match.index ?? -1);
  assert.strictEqual(gates.length, 2, "复选框与批量工具条各要一道 `{multiSelect ? (` 闸门");
  const checkBox = history.indexOf("session-item-check");
  const batchBar = history.indexOf('<div className="drawer-batch">');
  assert.ok(
    checkBox > 0 && batchBar > 0 && gates[0] < checkBox && gates[1] < batchBar,
    "复选框与工具条只在多选形态里渲染（平时不该长出来）",
  );
  assert.ok(
    /if \(multiSelect\) \{[\s\S]{0,200}?if \(!locked\) changeSelection\(toggleSelection\(selected, session\.id\)\);/.test(
      history,
    ),
    "多选形态下点整行 = 勾选 / 取消勾选（不打开会话、不关抽屉），锁定行点了没反应",
  );
  assert.ok(
    /const toggleMultiSelect = \(\) => \{[\s\S]{0,300}?setSelected\(NO_SELECTION\)/.test(history),
    "进出多选形态都要清掉选择集（退出时收干净，进来时不带上次的残留）",
  );

  // 归档视图：行内那颗与工具条那颗都是**恢复**
  assert.ok(
    /if \(archived\) post\(\{ type: "unarchiveSession", sessionId: session\.id \}\);/.test(history),
    "归档视图里行内那颗按钮要走 unarchiveSession（同一位置、同一套行为，只把方向反过来）",
  );
  assert.ok(
    /onClick=\{archived \? restoreSelected : archiveSelected\}/.test(history),
    "多选工具条那颗按钮按视图在恢复 / 归档之间翻转",
  );
  // 批量删除的二次确认：与行内同一条时长常量，确认文案带影响条数
  assert.ok(
    /if \(!armed\) \{/.test(history) &&
      /setTimeout\(\(\) => setArmedBatch\(false\), DELETE_ARM_MS\)/.test(history) &&
      /texts\.deleteSelectedConfirm\(selectedCount\)/.test(history),
    "批量删除必须两段式：第一下只武装，第二下才发（与行内垃圾桶共用 DELETE_ARM_MS 与确认文案）",
  );
  assert.ok(
    /className="btn btn-ghost drawer-batch-all"/.test(history) &&
      /allChecked \? texts\.selectNone : texts\.selectAll/.test(history),
    "「全选 / 取消全选」按是否已全选翻转（判据在 sessionSelection 的 allSelected）",
  );

  // 恢复链路的宿主侧：IPC 消息 → 客户端端点 → 控制器的归档集合与列表刷新
  const ipc = readFileSync(join(process.cwd(), "src", "shared", "ipc.ts"), "utf8");
  assert.ok(
    /\{ type: "unarchiveSession"; sessionId: string \}/.test(ipc),
    "界面要能发 unarchiveSession（ipc.ts 的消息联合）",
  );
  const client = readFileSync(join(process.cwd(), "src", "dsh", "client.ts"), "utf8");
  assert.ok(
    /unarchiveSession\(sessionId: string\)[\s\S]{0,200}?"workspace\/unarchiveSession", \{ request: \{ sessionId \} \}/.test(
      client,
    ),
    "客户端要打到官方端点 workspace/unarchiveSession（请求体只有 sessionId）",
  );
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /case "unarchiveSession":/.test(controller) && /private async unarchiveSession\(sessionId: string\)/.test(controller),
    "控制器要有 unarchiveSession 分派与实现",
  );
  assert.ok(
    /archivedSessionIds\.delete\(sessionId\)/.test(controller),
    "恢复后要把它从归档集合退掉（列表立刻回到普通视图），权威值仍由 workspace/follow 流确认",
  );

  // 文案：条数必须真的进到确认文案里（中英各一份）
  assert.ok(dictionaryFor("zh").deleteSelectedConfirm(2).includes("2"), "中文确认文案要报出条数");
  assert.ok(dictionaryFor("en").deleteSelectedConfirm(2).includes("2"), "英文确认文案要报出条数");
  assert.ok(dictionaryFor("en").selectedCount(3).includes("3"), "已选数量要报出条数");
}
console.log("sessionList: 多选、批量归档 / 恢复 / 删除与二次确认 ✓");

// ---------- 2c. 真渲染抽屉：复选框的禁用位与工具条的禁用位对上（SSR 静态渲染） ----------
//
// 2b 是源码形状，这一条是**渲染出来的标记**：每行一颗复选框、运行中与当前会话那两颗
// 是禁用的、没有选中项时工具条上两颗动作按钮都不可点（但「全选」可点）。本仓库没有
// jsdom（不为测试引入依赖），所以只渲染静态标记，事件行为靠 2b 与
// `sessionSelection.test.ts` 的纯判据覆盖。
{
  const now = Date.now();
  const markup = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(HistoryPanel, {
        sessions: [
          { id: "plain", title: "PLAIN", updatedAt: now, running: false },
          { id: "busy", title: "BUSY", updatedAt: now, running: true },
          { id: "current", title: "CURRENT", updatedAt: now, running: false },
        ],
        archivedSessions: [{ id: "arch", title: "ARCH", updatedAt: now, running: false }],
        currentId: "current",
        onClose: () => {},
      }),
    ),
  );

  const bodyStart = markup.indexOf('class="drawer-body"');
  assert.ok(bodyStart > 0, "渲染结果里没有抽屉的列表区");
  const body = markup.slice(bodyStart);

  // 默认是**普通形态**：一颗复选框都没有、也没有批量工具条（多选开关点开才长出来）。
  // 多选形态本身是组件内部状态，SSR 点不动它——那边的接线由 2b 的源码断言与预览页实测覆盖。
  assert.strictEqual(
    (body.match(/type="checkbox"/g) ?? []).length,
    0,
    "没开多选时列表里不该有任何复选框（用户 2026-10-15：不是常驻多选）",
  );
  assert.ok(!/drawer-batch/.test(markup), "没开多选时不该有批量工具条");
  assert.ok(
    (body.match(/session-item-main/g) ?? []).length === 3,
    "列表照常渲染三行（当前视图只有 sessions 那份，归档那份不渲染）",
  );

  // 顶部那颗多选开关：未打开时 aria-pressed=false，且排在归档切换左边
  const toggle = /<button[^>]*aria-pressed="false"[^>]*>/.exec(markup);
  assert.ok(toggle, "抽屉顶部要有多选形态开关，未打开时 aria-pressed=false");
  assert.ok(
    markup.indexOf(toggle[0]) < markup.indexOf('title="归档列表"'),
    "多选开关在归档切换按钮左边（用户 2026-10-15 的位置口径）",
  );
}
console.log("sessionList: 抽屉真渲染（默认普通形态：无复选框 / 无工具条 / 有多选开关）✓");

// ---------- 3. 工作区可见性：打开文件夹跟随工作区；没有文件夹只给未分组 ----------
//
// 用户 2026-09-15 的设计口径。判据按**服务端工作区注册表**（会话不在任何工作区
// 记录里 = 未分组），路径比较只做兜底。
{
  const rows = [
    { sessionId: "own", cwd: "D:/dev/demo-app" },
    { sessionId: "own-late", cwd: "d:\\dev\\Demo-App\\" }, // 大小写/斜杠写法不同
    { sessionId: "other-project", cwd: "D:/dev/other" },
    { sessionId: "ungrouped", cwd: "C:/tmp/scratch" },
    { sessionId: "own-registry", cwd: "D:/somewhere/else" }, // 注册表记账（cwd 不同）
    { sessionId: "no-cwd" },
  ];
  const grouped = new Set(["own-registry"]);
  const withFolder = visibleForWorkspace(rows, {
    workspacePath: "d:/dev/demo-app",
    workspaceSessionIds: new Set(["own-registry"]),
    groupedSessionIds: grouped,
    openCwds: [],
  }).map((row) => row.sessionId);
  assert.deepStrictEqual(
    withFolder,
    ["own", "own-late", "own-registry"],
    "打开了文件夹：只显示本工作区的会话（路径兜底 + 注册表记账），未分组与别的项目都不显示",
  );

  const noFolder = visibleForWorkspace(rows, {
    groupedSessionIds: grouped,
    openCwds: [],
  }).map((row) => row.sessionId);
  assert.deepStrictEqual(
    noFolder,
    ["own", "own-late", "other-project", "ungrouped"],
    "没有打开文件夹：显示未分组（含 dsh web 直接建的、别的目录的），但不显示任何工作区记账的会话",
  );

  const withOpenScope = visibleForWorkspace(rows, {
    workspacePath: undefined,
    groupedSessionIds: grouped,
    openCwds: ["d:\\dev\\other\\"],
  }).map((row) => row.sessionId);
  assert.ok(
    withOpenScope.includes("other-project"),
    "**任何已打开域**的 cwd 一律放行：恢复窗口时不能因为路径写法差异把要接回的会话滤掉",
  );
  assert.ok(
    !withOpenScope.includes("own-registry"),
    "没有打开文件夹时，注册表记账的会话**不**显示（它属于别的工作区）；" +
      "放行只靠「已打开域的 cwd」这一条",
  );
  assert.ok(
    !withOpenScope.includes("no-cwd"),
    "没有 cwd 的会话不显示（服务端建会话时必给 cwd 或 workspaceId）",
  );
}
console.log("sessionList: 工作区可见性（有文件夹 / 无文件夹 / 已打开域兜底）✓");

// ---------- 3a. 发帧那一步按**窗口**收窄：没有文件夹时只看当前会话的 cwd ----------
//
// 用户 2026-10-10 口径：VS Code 没有打开文件夹时，每个会话可以各自选一个工作目录，
// 历史列表必须跟着**这个窗口当前那条会话的 cwd**（两个面板各开一个目录时，各自的历史
// 里不许混进对方的会话）。全局那一份（`visibleForWorkspace` 的结论）保持并集不变——
// 打开会话 / 空壳复用 / running 打底都读它（行为级回归见 `sessionListScope.test.ts`）。
{
  const rows = [
    { sessionId: "a-1", cwd: "C:/work/alpha" },
    { sessionId: "a-2", cwd: "c:\\WORK\\Alpha\\" }, // 同一目录的另一种写法
    { sessionId: "b-1", cwd: "C:/work/beta" },
    { sessionId: "no-cwd" },
  ];

  // ① 无文件夹 + 窗口有 cwd：只留同一目录（大小写 / 斜杠算同一个）
  assert.deepStrictEqual(
    visibleForView(rows, { folderOpen: false, cwd: "C:/work/ALPHA" }).map((row) => row.sessionId),
    ["a-1", "a-2"],
    "窗口当前会话在 alpha：历史只许有 alpha 的会话（写法不同也算同一个目录）",
  );

  // ② 无文件夹 + 窗口没有 cwd：原样放行（未分组那一档），不拿别的目录猜
  assert.deepStrictEqual(
    visibleForView(rows, { folderOpen: false }).map((row) => row.sessionId),
    ["a-1", "a-2", "b-1", "no-cwd"],
    "拿不到目录证据时不收紧：保持全局那一份（收紧会把无文件夹新窗口从历史恢复会话的路堵死）",
  );

  // ③ 打开着文件夹：原样放行 —— 目录跟随 VS Code，所有窗口同一份（旧口径不动）
  assert.deepStrictEqual(
    visibleForView(rows, { folderOpen: true, cwd: "C:/work/beta" }).map((row) => row.sessionId),
    ["a-1", "a-2", "b-1", "no-cwd"],
    "打开着文件夹时不做按窗口收窄（folder 的注册表 + cwd 口径在 visibleForWorkspace 里）",
  );

  // ④ 返回的就是入参本身（第 1、3 档）：调用方不许改它，也不该有人误以为拿到了副本
  assert.strictEqual(
    visibleForView(rows, { folderOpen: true }),
    rows,
    "不收窄的两档直接返回入参（省一次分配；语义是只读视图）",
  );
}
console.log("sessionList: 窗口级收窄（有 cwd 跟随、无 cwd 放宽、folder 放行）✓");

// ---------- 4. 结构不变量：控制器必须走这两个函数，不能自己写过滤 ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /visibleSessionRows\(value\.items \?\? \[\]\)/.test(controller),
    "refreshSessions 必须用 visibleSessionRows 过滤子代理（判据在 sessionList.ts 里注释着）",
  );
  assert.ok(
    /visibleForWorkspace\(/.test(controller),
    "refreshSessions 的工作区可见性必须走 visibleForWorkspace（它带断言、也是设计口径的落点）",
  );
  assert.ok(
    !/return cwd === workspace \|\| openCwds\.includes\(cwd\)/.test(controller),
    "不能再回到「cwd == 当前工作区」的老判据——没有文件夹时它会把未分组会话全滤掉",
  );
  assert.ok(
    !/\.filter\(\(item\) => !item\.origin && !item\.parentSessionId\)/.test(controller),
    "不能再回到「有 parent 就滤掉」的老判据——那会把分支会话一起藏了",
  );
  assert.ok(
    !/lineageDepths/.test(controller),
    "血缘深度已随缩进一起删掉（用户 2026-09-19：分支和普通会话同级）",
  );

  // 发帧那一步按窗口收窄：判据是**这个窗口当前会话的 cwd**（`viewCwd`），
  // 不是 activeViewId 那一个窗口、也不是「本窗口打开过的所有 cwd」的并集。
  const emitStart = controller.indexOf("private emitSessionLists(): void {");
  assert.ok(emitStart > 0, "取不到 emitSessionLists");
  const emitBody = controller.slice(emitStart, controller.indexOf("\n  private viewCwd(", emitStart));
  assert.ok(
    /visibleForView\(this\.sessions, \{ folderOpen: false, cwd: this\.viewCwd\(viewId\) \}\)/.test(emitBody),
    "无文件夹时必须按窗口收窄（`visibleForView` + 该窗口的 `viewCwd`）",
  );
  assert.ok(
    !/activeViewId/.test(emitBody),
    "收窄判据不许读 activeViewId（那是一个窗口的 cwd，两个面板会拿到同一份列表）",
  );
  assert.ok(
    /vscode\.workspace\.workspaceFolders\?\.\[0\]/.test(emitBody) &&
      /this\.emitAll\(\{ type: "sessions", sessions: active \}\)/.test(emitBody),
    "打开着文件夹时仍走广播（所有窗口同一份，行为与旧口径逐字相同）",
  );
  assert.ok(
    /for \(const viewId of this\.liveViewIds\(\)\)/.test(emitBody),
    "按窗口发帧时收件人取活窗口名册（viewOrder ∪ viewSessions ∪ viewKinds），不许漏掉已有窗口",
  );
  assert.ok(
    /this\.sessions = views;/.test(controller),
    "全局 this.sessions 仍是 visibleForWorkspace 的并集（打开 / 空壳复用 / running 打底都读它）",
  );

  // 权威 cwd 账本：从 `session/list` 的**原始行**建（在任何可见性过滤之前），
  // 因为窗口当前会话可能是**子代理会话**——它不在 `this.sessions` 里，cwd 只能靠账本。
  assert.ok(
    /private sessionCwds = new Map<string, string>\(\)/.test(controller) &&
      /cwds\.set\(item\.sessionId, item\.cwd\)/.test(controller),
    "权威 cwd 账本要从 session/list 的原始行整份重建（子代理会话的 cwd 也要记进去）",
  );
  assert.ok(
    /this\.sessionCwds\.clear\(\)/.test(controller),
    "换连接 / 断线收场要清空权威 cwd 账本（生命周期收口，下次列表到达重建）",
  );

  const viewCwdStart = controller.indexOf("private viewCwd(viewId: string)");
  assert.ok(viewCwdStart > 0, "取不到 viewCwd");
  const viewCwdBody = controller.slice(viewCwdStart, controller.indexOf("\n  /**", viewCwdStart + 10));
  assert.ok(
    /this\.viewSessions\.get\(viewId\)/.test(viewCwdBody) &&
      /this\.sessionCwds\.get\(sessionId\)/.test(viewCwdBody),
    "绑了会话就以**那条会话的 cwd** 为准（会话的创建事实，判据读权威账本而不是可见列表）",
  );
  assert.ok(
    /this\.newSessionCwd/.test(viewCwdBody),
    "没绑会话（空态页）才退回用户选定的目录（newSessionCwd）",
  );
  assert.ok(
    !/this\.sessions\b/.test(viewCwdBody),
    "viewCwd 不许读 `this.sessions`——那份是界面该看见的历史，子代理会话不在里面（读它会让子代理页退回跨目录全列）",
  );
  assert.ok(
    !/activeViewId/.test(viewCwdBody) && !/openCwds/.test(viewCwdBody),
    "viewCwd 不许读 activeViewId / openCwds 并集",
  );

  // 换绑 / 退回空态时，列表与空态页那行目录要在同一刻跟着换（否则界面停在旧 cwd 的口径上）
  assert.ok(
    /this\.emitViewScopedState\(\);/.test(controller) &&
      /this\.emitSessionLists\(\);\s*\n\s*this\.emitWorkspaceViews\(\);/m.test(controller),
    "绑定 / 解绑要经 `emitViewScopedState` 同时重发历史列表与按窗口的工作目录",
  );
  assert.ok(
    /private workspaceView\(viewId\?: string\)/.test(controller) &&
      /this\.workspaceView\(viewId\)/.test(controller),
    "空态页那行目录按窗口取（先看该窗口当前会话的 cwd）——与历史列表同一套判据",
  );
}
console.log("sessionList: 控制器与界面都接上了 ✓");

// ---------- 5. @ 提及的「对话候选」也不显示子代理会话（用户 2026-09-22 口径），
//             也不显示还没开始对话的空会话（用户 2026-09-24 口径：菜单按需建的
//             那条空会话在历史列表里被挡着，@ 候选那条路也不能漏出来） ----------
//
// 候选 RPC（sessionReferenceResolver/candidates）的行不带 origin、也不带 blank（契约
// SessionReferenceMentionCandidate 只有 sessionId/label/displayTitle/cwd/
// sameWorkspace/createdAt/mention），两种身份只能由客户端维护的 id 集合判断。
// 集合的来源都必须接上，缺一路就有漏网。
{
  const subagentIds = new Set(["sub-a", "sub-b"]);
  const blankIds = new Set(["empty-1"]);
  const candidates = [
    { sessionId: "root" },
    { sessionId: "sub-a" },
    { sessionId: "branch", parentSessionId: "root" }, // 分支照样可见
    { sessionId: "empty-1" },
    { sessionId: "sub-b" },
  ];
  assert.deepStrictEqual(
    visibleSessionCandidates(candidates, subagentIds).map((row) => row.sessionId),
    ["root", "branch", "empty-1"],
    "子代理会话必须从 @ 对话候选里滤掉，分支与普通会话留下",
  );
  assert.deepStrictEqual(
    visibleSessionCandidates(candidates, subagentIds, blankIds).map((row) => row.sessionId),
    ["root", "branch"],
    "还没开始对话的空会话也要从 @ 对话候选里滤掉（它连标题都没有，候选行只能显示会话 id）",
  );
  assert.deepStrictEqual(
    visibleSessionCandidates(candidates, new Set()).length,
    candidates.length,
    "集合为空（比如刚启动还没拉到列表）时一个候选都不能少",
  );

  // 控制器接线：queryFiles 走 visibleSessionCandidates，且两个隐藏集合都传进去
  // （判据取 `queryFiles` 的函数体，不绑某一行的书写形状——它现在住在
  //  `files/sessions` 那一帧的发射点里，见 `controller.queryFiles`）
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const queryFilesStart = controller.indexOf("private async queryFiles(");
  const queryFiles = controller.slice(
    queryFilesStart,
    controller.indexOf("\n  private ", queryFilesStart + 10),
  );
  assert.ok(queryFilesStart > 0, "取不到 queryFiles");
  assert.ok(
    /visibleSessionCandidates\(\s*rows \?\? \[\],\s*this\.subagentSessionIds,\s*this\.blankSessionIds\(\),/.test(
      queryFiles,
    ),
    "queryFiles 必须用 visibleSessionCandidates 过滤 @ 对话候选，并同时传子代理 id 与空会话 id" +
      "（判据在 sessionList.ts 里注释着）",
  );
  assert.ok(
    /item\.origin === "subagent"\)\s*\{[^}]*this\.subagentSessionIds\.add\(item\.sessionId\)/.test(controller),
    "subagentSessionIds 必须由 session/list 原始行的 origin 打底（refreshSessions）",
  );
  assert.ok(
    /this\.subagentSessionIds\.add\(entry\.id\)/.test(controller),
    "subagentSessionIds 必须由子代理目录的并入点（mergeSubagentEntries）实时补充",
  );
  assert.ok(
    /if \(session\.blank === true\) continue;/.test(controller),
    "历史列表必须挡掉服务端标了 blank 的空会话（emitSessionLists）",
  );
}
console.log("sessionList: @ 对话候选隐藏子代理会话与空会话 ✓");

// ---------- 7. 盘符大写（用户 2026-10-01：空态页工作目录的盘符应为大写） ----------
//
// VS Code 以小写盘符打开文件夹（命令行 `code d:\dev`）时 `fsPath` 原样保留小写，
// 空态页照抄就显示小写。只动开头盘符；路径其余大小写有意义，不碰。
{
  assert.strictEqual(upperDriveLetter("d:\\dev\\demo-app"), "D:\\dev\\demo-app");
  assert.strictEqual(upperDriveLetter("d:/dev/demo-app"), "D:/dev/demo-app");
  assert.strictEqual(upperDriveLetter("D:\\dev"), "D:\\dev", "已是大写时原样");
  assert.strictEqual(
    upperDriveLetter("d:\\Dev\\src"),
    "D:\\Dev\\src",
    "只动盘符，路径其余部分的大小写保留",
  );
  assert.strictEqual(upperDriveLetter("/home/user"), "/home/user", "POSIX 路径原样");
  assert.strictEqual(upperDriveLetter(""), "", "空串原样");
}
console.log("sessionList: 盘符大写 ✓");

console.log("\nsessionList: all assertions passed");
