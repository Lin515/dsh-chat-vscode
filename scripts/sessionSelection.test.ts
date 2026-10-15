/**
 * 历史列表的多选（`src/webview/sessionSelection.ts`）与它依赖的几条判据。
 *
 * 用户 2026-10-15 口径：历史抽屉里加多选，可对选中项**归档或删除**；切到归档列表复用
 * 同一套逻辑，只是归档那颗变成**恢复**，删除两边一致、同样要二次确认；「全选」在还没
 * 全选时选中全部、已经全选时取消全部。
 *
 * 这里只钉纯判据（哪些行可选、选择集怎么跟当前列表对齐、全选怎么翻转）——它们错了以后
 * 现场很难复现（只有点下去那一刻才知道选中的是谁）。组件里的接线与宿主侧的恢复链路在
 * `sessionList.test.ts` 里钉。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import type { SessionSummaryView } from "../src/shared/chat";
import {
  allSelected,
  pruneSelection,
  selectableSessionIds,
  sessionLocked,
  toggleAllSelection,
  toggleSelection,
} from "../src/webview/sessionSelection";

const row = (
  id: string,
  extra: Partial<SessionSummaryView> = {},
): SessionSummaryView => ({
  id,
  title: id,
  updatedAt: 0,
  running: false,
  ...extra,
});

// ---------- 1. 可选判据：运行中的会话与当前会话都不进批量操作 ----------
//
// 这两类宿主一律拒（controller 的 `deleteSession`：运行中的服务端还在往里写、当前会话
// 删完无处可看）。批量操作把它们混进去，用户点一次删除会连着收到几条拒绝提示。
{
  assert.strictEqual(sessionLocked(row("running", { running: true }), "current"), true, "运行中不可选");
  assert.strictEqual(sessionLocked(row("current"), "current"), true, "当前会话不可选");
  assert.strictEqual(sessionLocked(row("plain"), "current"), false, "其余会话可选");
  assert.strictEqual(sessionLocked(row("plain"), undefined), false, "没有当前会话时只看运行位");

  const rows = [
    row("a"),
    row("running", { running: true }),
    row("current"),
    row("b", { running: false }),
  ];
  assert.deepStrictEqual(
    selectableSessionIds(rows, "current"),
    ["a", "b"],
    "可选集按列表顺序给，运行中与当前会话都退掉",
  );
  assert.deepStrictEqual(
    selectableSessionIds(rows, undefined),
    ["a", "current", "b"],
    "没有当前会话时不额外退谁（宿主那两条保护仍然在，只是这里没有第二个判据）",
  );
  assert.deepStrictEqual(selectableSessionIds([], "current"), [], "空列表给出空集合");
}
console.log("sessionSelection: 可选判据（运行中 / 当前会话）✓");

// ---------- 2. 选择集跟随当前列表：看不见的选中项要退掉 ----------
//
// 搜索框改可见行、切归档视图换一份列表、归档 / 删除后行消失——留下的都是**看不见却会被
// 批量操作命中**的幽灵选择。
{
  const before = new Set(["a", "b", "hidden"]);
  const same = pruneSelection(before, ["a", "b", "hidden"]);
  assert.strictEqual(same, before, "没有变化时返回入参本身（effect 里每次新建 Set 会多渲染一轮）");

  const pruned = pruneSelection(before, ["a", "b"]);
  assert.deepStrictEqual([...pruned], ["a", "b"], "已经不可见的选中项退掉（搜索 / 切视图 / 行消失）");
  assert.notStrictEqual(pruned, before, "真退掉东西时要给新集合（不能就地改 state 里的那个）");
  assert.deepStrictEqual([...before], ["a", "b", "hidden"], "入参不许被就地改（state 里的 Set 是共享的）");

  assert.deepStrictEqual([...pruneSelection(new Set(["x"]), [])], [], "可选集为空时选择集清空");
  assert.deepStrictEqual([...pruneSelection(new Set(), ["a"])], [], "本来就没选中什么时保持空");
}
console.log("sessionSelection: 选择集跟随列表（退掉不可见项）✓");

// ---------- 3. 全选是**翻转**：还没有全选 → 全选；已经全选 → 取消全选 ----------
//
// 用户 2026-10-15 口径。最容易写错的是「部分选中」那一档：点一下必须补齐剩下的，
// 而不是什么都不做、也不是直接清空。
{
  const ids = ["a", "b", "c"];

  assert.strictEqual(allSelected(new Set(), ids), false, "一条没选不算全选");
  assert.strictEqual(allSelected(new Set(["a", "b"]), ids), false, "部分选中不算全选");
  assert.strictEqual(allSelected(new Set(["a", "b", "c"]), ids), true, "全部选中才算全选");
  assert.strictEqual(allSelected(new Set(), []), false, "可选集为空时不算全选");
  assert.strictEqual(
    allSelected(new Set(["a"]), []),
    false,
    "可选集为空时即便选择集里有残留也不叫全选（那几条已经不在这个列表里了）",
  );

  assert.deepStrictEqual([...toggleAllSelection(new Set(), ids)], ids, "一条没选时点全选 → 选中全部");
  assert.deepStrictEqual(
    [...toggleAllSelection(new Set(["b"]), ids)],
    ids,
    "部分选中时点全选 → 补齐剩下（不是清空）",
  );
  assert.deepStrictEqual(
    [...toggleAllSelection(new Set(["a", "b", "c"]), ids)],
    [],
    "已经全选时再点 → 取消全选",
  );
  assert.deepStrictEqual(
    [...toggleAllSelection(new Set(["stale", "a", "b", "c"]), ids)],
    [],
    "已经全选（哪怕选择集里还留着不在本列表的 id）时再点 → 全部取消",
  );
  assert.deepStrictEqual([...toggleAllSelection(new Set(), [])], [], "可选集为空时全选是无操作");
}
console.log("sessionSelection: 全选翻转（未全选→全选、已全选→取消）✓");

// ---------- 4. 单行勾选：翻转，且不动原集合 ----------
{
  const before = new Set(["a"]);
  const added = toggleSelection(before, "b");
  assert.deepStrictEqual([...added], ["a", "b"], "没勾上的勾上");
  assert.deepStrictEqual([...before], ["a"], "原集合不动（React state 里的那个是共享的）");

  const removed = toggleSelection(added, "a");
  assert.deepStrictEqual([...removed], ["b"], "勾上的再点一次就去掉");
  assert.notStrictEqual(removed, added, "去掉时给的是新集合");
}
console.log("sessionSelection: 单行勾选翻转 ✓");

console.log("\nsessionSelection: all assertions passed");
