/**
 * 会话列表行的可见性与分支的呈现。
 *
 * 用户 2026-09-12 反馈：「创建了分支，但新分支会话不会在会话历史里显示」。
 * 根因是过滤判据写错——契约里 `parentSessionId` 分支与子代理**都有**，
 * 只有 `origin` 能区分（`'subagent'`）。这组断言把判据钉死，并覆盖分支行
 * 与普通会话**同级**（不缩进、靠标题前缀「分支: 」区分，用户 2026-09-19 口径）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleForWorkspace, visibleSessionRows } from "../src/dsh/sessionList";
import { dictionaryFor } from "../src/webview/texts";

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

// ---------- 3. 工作区可见性：打开文件夹跟随工作区；没有文件夹只给未分组 ----------
//
// 用户 2026-09-15 的设计口径。判据按**服务端工作区注册表**（会话不在任何工作区
// 记录里 = 未分组），路径比较只做兜底。
{
  const rows = [
    { sessionId: "own", cwd: "D:/dev/dsh-chat" },
    { sessionId: "own-late", cwd: "d:\\dev\\DSH-Chat\\" }, // 大小写/斜杠写法不同
    { sessionId: "other-project", cwd: "D:/dev/other" },
    { sessionId: "ungrouped", cwd: "C:/tmp/scratch" },
    { sessionId: "own-registry", cwd: "D:/somewhere/else" }, // 注册表记账（cwd 不同）
    { sessionId: "no-cwd" },
  ];
  const grouped = new Set(["own-registry"]);
  const withFolder = visibleForWorkspace(rows, {
    workspacePath: "d:/dev/dsh-chat",
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
}
console.log("sessionList: 控制器与界面都接上了 ✓");

console.log("\nsessionList: all assertions passed");
