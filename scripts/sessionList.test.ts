/**
 * 会话列表行的可见性与血缘深度。
 *
 * 用户 2026-09-12 反馈：「创建了分支，但新分支会话不会在会话历史里显示」。
 * 根因是过滤判据写错——契约里 `parentSessionId` 分支与子代理**都有**，
 * 只有 `origin` 能区分（`'subagent'`）。这组断言把判据钉死，
 * 并覆盖血缘深度这个把分支缩进到源会话下面的依据。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineageDepths, visibleSessionRows } from "../src/dsh/sessionList";

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

// ---------- 2. 血缘深度：分支缩进到源会话下面 ----------
{
  const rows = [
    { id: "root" },
    { id: "branch", parentSessionId: "root" },
    { id: "branch2", parentSessionId: "branch" },
    { id: "orphan", parentSessionId: "archived-parent" },
    { id: "loop-a", parentSessionId: "loop-b" },
    { id: "loop-b", parentSessionId: "loop-a" },
  ];
  const depths = lineageDepths(rows);
  assert.strictEqual(depths.get("root"), 0, "根会话 depth = 0");
  assert.strictEqual(depths.get("branch"), 1, "分支 = 1");
  assert.strictEqual(depths.get("branch2"), 2, "分支的分支 = 2");
  assert.strictEqual(depths.get("orphan"), 0, "源会话不在列表里时按根处理（不炸、不猜）");
  assert.ok(Number.isFinite(depths.get("loop-a")), "成环时也不能死循环");
}
console.log("sessionList: 血缘深度（含孤儿与成环）✓");

// ---------- 3. 结构不变量：控制器必须走这两个函数，不能自己写过滤 ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /const views = visibleSessionRows\(value\.items \?\? \[\]\)/.test(controller),
    "refreshSessions 必须用 visibleSessionRows 过滤（判据在 sessionList.ts 里注释着）",
  );
  assert.ok(
    !/\.filter\(\(item\) => !item\.origin && !item\.parentSessionId\)/.test(controller),
    "不能再回到「有 parent 就滤掉」的老判据——那会把分支会话一起藏了",
  );
  assert.ok(
    /const depths = lineageDepths\(views\)/.test(controller),
    "refreshSessions 必须算血缘深度，否则分支不会缩进到源会话下面",
  );

  // 界面侧：缩进 + 「分支:」前缀
  const history = readFileSync(
    join(process.cwd(), "src", "webview", "components", "History.tsx"),
    "utf8",
  );
  assert.ok(
    /"--session-indent": `\$\{2 \+ depth \* 14\}px`/.test(history),
    "History 必须按 depth 算缩进（分支继承源标题，不缩进会看成重复条目）",
  );
  assert.ok(
    /\{depth > 0 \? texts\.forkedTitle\(title\) : title\}/.test(history),
    "分支行的标题必须走词典的 forkedTitle（「分支:」/「Fork:」两套文案）",
  );

  // 词典：中英都要有，且都带标题参数（TS 会强制，这里顺带钉住形态）
  // 两种语言统一「半角冒号 + 一个空格」（用户口径）
  const texts = readFileSync(join(process.cwd(), "src", "webview", "texts.ts"), "utf8");
  assert.ok(/forkedTitle: \(title\) => `分支: \$\{title\}`/.test(texts), "中文前缀是「分支: 」");
  assert.ok(/forkedTitle: \(title\) => `Fork: \$\{title\}`/.test(texts), "英文前缀是「Fork: 」");
}
console.log("sessionList: 控制器与界面都接上了 ✓");

console.log("\nsessionList: all assertions passed");
