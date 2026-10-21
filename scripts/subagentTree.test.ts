/**
 * 子代理树的组装与界面计数（用户 2026-10-20 口径）。
 *
 * 钉住四件事：
 *
 * 1. **层级**：第 1 层是顶层会话直接调用的子代理，`depth = 1`（界面与顶层会话行
 *    同级对齐）；更深层逐级 +1。
 * 2. **顺序**：`childrenOf` 给什么顺序，先序展开就按什么顺序（排序口径在
 *    `subagentOrder.ts`，这里不重排）。
 * 3. **异常数据不画错层级**：父链断掉的节点不硬塞进根下；环只出现一次。
 * 4. **界面计数**：标题后的计数是「当前会话下面的全部后代」（多层），不是只数
 *    直接下级；当前节点按 id 找。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentView } from "../src/shared/chat";
import { buildSubagentTree } from "../src/dsh/subagentTree";
import { subagentCurrentNode, subagentDescendants } from "../src/webview/subagentTree";

const entry = (id: string, label = id): SubagentView => ({ id, label, mode: "one-shot" });

console.log("subagentTree: 树组装与界面计数");

// ---------- 1. 层级与先序 ----------
{
  const children = new Map<string, SubagentView[]>([
    ["M", [entry("A"), entry("B")]],
    ["A", [entry("A1"), entry("A2")]],
    ["A1", [entry("A1a")]],
  ]);
  const tree = buildSubagentTree({
    root: { id: "M", title: "主会话", running: false },
    childrenOf: (id) => children.get(id) ?? [],
  });
  assert.strictEqual(tree.root.id, "M");
  assert.deepStrictEqual(
    tree.nodes.map((node) => `${node.id}@${String(node.depth)}<${node.parentSessionId}>`),
    [
      "A@1<M>",
      "A1@2<A>",
      "A1a@3<A1>",
      "A2@2<A>",
      "B@1<M>",
    ],
    "先序展开；第 1 层与顶层会话同级，深层逐级 +1，父 id 是真实父会话",
  );
  console.log("  ① 先序 / depth / parentSessionId ✓");
}

// ---------- 2. 父链断掉 / 环：不硬塞、不无限递归 ----------
{
  const orphan = buildSubagentTree({
    root: { id: "M", title: "主会话", running: false },
    childrenOf: (id) => (id === "M" ? [entry("A")] : id === "X" ? [entry("ORPHAN")] : []),
  });
  assert.deepStrictEqual(orphan.nodes.map((node) => node.id), ["A"], "父链断掉的节点不挂在根下");

  const cyclicChildren = new Map<string, SubagentView[]>([
    ["M", [entry("A")]],
    ["A", [entry("M"), entry("A")]],
  ]);
  const cyclic = buildSubagentTree({
    root: { id: "M", title: "主会话", running: false },
    childrenOf: (id) => cyclicChildren.get(id) ?? [],
  });
  assert.deepStrictEqual(cyclic.nodes.map((node) => node.id), ["A"], "环只出现一次（根与已见节点都不重画）");
  console.log("  ② 断链 / 环截断 ✓");
}

// ---------- 3. 界面计数 / 当前节点 ----------
{
  const tree = buildSubagentTree({
    root: { id: "M", title: "主会话", running: false },
    childrenOf: (id) =>
      id === "M" ? [entry("A"), entry("B")] : id === "A" ? [entry("A1")] : id === "A1" ? [entry("A1a")] : [],
  });
  assert.deepStrictEqual(
    subagentDescendants("M", tree.nodes).map((node) => node.id),
    ["A", "A1", "A1a", "B"],
    "顶层会话的计数含全部多层后代（先序）",
  );
  assert.deepStrictEqual(
    subagentDescendants("A", tree.nodes).map((node) => node.id),
    ["A1", "A1a"],
    "子代理页的计数只算它自己的后代（不含祖先 / 兄弟）",
  );
  assert.deepStrictEqual(subagentDescendants("A1a", tree.nodes), [], "叶子没有子代理");
  assert.strictEqual(subagentCurrentNode("A1", tree.nodes)?.parentSessionId, "A");
  assert.strictEqual(subagentCurrentNode("M", tree.nodes), undefined, "顶层会话不在子代理节点里");
  console.log("  ③ 多层后代计数 / 当前节点 ✓");
}

// ---------- 4. 线格式与宿主接线：树必须走会话状态片段 ----------
{
  const sessionView = readFileSync(join(process.cwd(), "src", "dsh", "sessionView.ts"), "utf8");
  assert.ok(
    /"subagent",\s*"subagentTree",/.test(
      sessionView.slice(sessionView.indexOf("SESSION_VIEW_KEYS"), sessionView.indexOf("] as const")),
    ),
    "subagentTree 必须在会话字段表里（切会话 / 增量 patch 才有唯一生产者）",
  );
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /private subagentTreeOf\(scope: SessionScope \| undefined\): SubagentTreeView \| undefined/.test(controller),
    "宿主必须有现算整棵树的唯一入口",
  );
  assert.ok(
    /this\.noteSubagentIndexFromList\(items, indexCandidates\);/.test(controller),
    "session/list 是跨域血缘的权威来路，刷新时要按在途候选重建索引",
  );
  assert.ok(
    /private redeliverSubagentTrees\(\): void/.test(controller),
    "树变化要有一个统一扇出点（不能只靠首帧）",
  );
}

console.log("\nsubagentTree: all assertions passed");
