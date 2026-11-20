/**
 * 历史抽屉范围选择器与投影列表的判据（`historyDirectoryView.ts`）及渲染。
 *
 * 契约：
 * - 有宿主投影（`ChatState.history`）时**只用**投影的两份列表；缺席时退回顶层
 *   `sessions` / `archivedSessions`（其他消费者仍读那份宽列表）；
 * - 范围选择器独立于归档切换、在列表为空时也看得见；普通与归档共用同一份范围；
 * - 混合目录的结果行显示去重后的创建目录短名，完整路径在悬停标题里；
 * - 行点击仍只按 id 打开会话，不碰空会话目录。
 *
 * 运行：npm test（在 esbuild.scripts.mjs 的 entries 里登记）。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryDirectoryView, SessionSummaryView } from "../src/shared/chat";
import { dirKey } from "../src/webview/composerDir";
import {
  historyDirectoryLabels,
  historyLists,
  historyScopeKey,
  historyScopeOptions,
  historyScopeValue,
  parseHistoryScopeValue,
} from "../src/webview/historyDirectoryView";
import { dictionaryFor, TextsContext } from "../src/webview/texts";

// `bridge.ts`（`History.tsx` 间接引入）在模块求值期挂 window 监听：无头环境先补最小 window。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
const { HistoryPanel } = await import("../src/webview/components/History");

const row = (id: string, over: Partial<SessionSummaryView> = {}): SessionSummaryView => ({
  id,
  title: id.toUpperCase(),
  updatedAt: Date.now(),
  running: false,
  ...over,
});
const dir = (path: string, name?: string) => ({
  path,
  name: name ?? path.split(/[/\\]/u).filter(Boolean).pop() ?? path,
});
const view = (over: Partial<HistoryDirectoryView> = {}): HistoryDirectoryView => ({
  scope: { kind: "current" },
  roots: [dir("C:\\client\\app"), dir("C:\\server\\app")],
  mixedDirectories: false,
  sessions: [],
  archivedSessions: [],
  ...over,
});

// ---------- 1. 范围值编码：路径里的冒号 / 引号不参与解析 ----------
{
  const scopes = [
    { kind: "current" as const },
    { kind: "roots" as const },
    { kind: "directory" as const, path: "D:\\a\\b:c" },
    { kind: "directory" as const, path: "/home/me/a\"b" },
  ];
  for (const scope of scopes) {
    assert.deepStrictEqual(parseHistoryScopeValue(historyScopeValue(scope)), scope, `范围往返失败：${scope.kind}`);
  }
  assert.strictEqual(parseHistoryScopeValue(""), undefined);
  assert.strictEqual(parseHistoryScopeValue("{}"), undefined);
  assert.strictEqual(parseHistoryScopeValue('{"kind":"directory","path":""}'), undefined);
  assert.strictEqual(historyScopeKey({ kind: "current" }), "current");
  assert.strictEqual(historyScopeKey({ kind: "roots" }), "roots");
  assert.strictEqual(
    historyScopeKey({ kind: "directory", path: "c:/Foo/" }),
    historyScopeKey({ kind: "directory", path: "C:\\foo" }),
    "范围身份在 Windows 上不区分大小写 / 斜杠",
  );
}

// ---------- 2. 选项：当前 / 全部根 / 各显式添加的根目录；少于两个根没有选项 ----------
{
  const options = historyScopeOptions(view(), {
    current: "Current directory",
    roots: "All workspace roots",
  });
  assert.deepStrictEqual(
    options.map((option) => option.label),
    ["Current directory", "All workspace roots", "client/app", "server/app"],
    "范围选项的次序与去重短名（不同根里同名的 app 必须能区分）",
  );
  assert.strictEqual(options[2]?.title, "C:\\client\\app", "目录选项悬停给完整路径");
  for (const roots of [[], [dir("C:\\client\\app")]]) {
    assert.deepStrictEqual(historyScopeOptions(view({ roots }), { current: "C", roots: "R" }), []);
  }
}

// ---------- 3. 列表来源：投影优先，缺席才回退；不混用 ----------
{
  const projected = historyLists(
    view({ sessions: [row("projected")], archivedSessions: [row("archived")], mixedDirectories: true }),
    [row("fallback")],
    [row("fallback-archived")],
  );
  assert.deepStrictEqual(projected.sessions.map((item) => item.id), ["projected"], "有投影时只用投影的普通列表");
  assert.deepStrictEqual(projected.archivedSessions.map((item) => item.id), ["archived"], "有投影时只用投影的归档列表");
  assert.strictEqual(projected.projected, true);
  assert.strictEqual(projected.mixedDirectories, true);

  const fallback = historyLists(undefined, [row("old")], [row("old-archived")]);
  assert.deepStrictEqual(fallback.sessions.map((item) => item.id), ["old"], "旧宿主退回顶层列表");
  assert.deepStrictEqual(fallback.archivedSessions.map((item) => item.id), ["old-archived"]);
  assert.strictEqual(fallback.projected, false);
  assert.strictEqual(fallback.mixedDirectories, false);
}

// ---------- 4. 混合目录短名：同名补父段，完整路径另存 title ----------
{
  const labels = historyDirectoryLabels([
    row("a", { cwd: "C:\\client\\app" }),
    row("b", { cwd: "C:\\server\\app" }),
    row("c"),
  ]);
  assert.strictEqual(labels.get(dirKey("C:\\client\\app")), "client/app");
  assert.strictEqual(labels.get(dirKey("C:\\server\\app")), "server/app");
  assert.strictEqual(labels.has(dirKey("C:\\missing")), false, "没有 cwd 的行不占短名");
}

// ---------- 5. 真渲染：投影列表、空结果仍见范围选择器、混合目录子标题 ----------
const esc = (text: string): string =>
  text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#x27;");
function renderPanel(history: HistoryDirectoryView | undefined, fallback: SessionSummaryView[] = []): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("en") },
      createElement(HistoryPanel, {
        sessions: fallback,
        archivedSessions: [],
        history,
        currentId: undefined,
        onClose: () => {},
      }),
    ),
  );
}

// 5a) 有投影：渲染投影行，不渲染回退行的标题
{
  const markup = renderPanel(view({ sessions: [row("PROJECTED")] }), [row("FALLBACK")]);
  assert.ok(markup.includes("PROJECTED"), "有投影时显示投影会话");
  assert.ok(!markup.includes("FALLBACK"), "有投影时不得把旧顶层列表混进来");
  assert.ok(markup.includes('class="drawer-scope"'), "有投影时有独立范围选择器");
  assert.ok(markup.includes(`aria-label="${esc(dictionaryFor("en").historyScope)}"`), "下拉框保留本地化无障碍名称");
  assert.ok(!markup.includes(`>${esc(dictionaryFor("en").historyScope)}<`), "不另画可见的范围标签");
  assert.ok(markup.includes(esc(dictionaryFor("en").historyScopeCurrent)), "默认范围是当前目录");
}

// 5b) 当前范围没有结果：范围选择器仍在（否则用户没法换范围）
{
  const markup = renderPanel(view({ sessions: [], archivedSessions: [] }));
  assert.ok(markup.includes('class="drawer-scope"'), "列表为空时范围选择器仍可见");
  assert.ok(markup.includes(esc(dictionaryFor("en").noScopedSessions)), "空范围用「此范围没有会话」而不是「还没有历史」");
}

// 5c) 旧宿主：没有范围选择器，沿用旧的空态文案
{
  const markup = renderPanel(undefined, []);
  assert.ok(!markup.includes('class="drawer-scope"'), "旧宿主不显示无法生效的范围选择器");
  assert.ok(markup.includes(esc(dictionaryFor("en").noSessions)), "旧宿主保持原来的空态文案");
}

// 5c2) 同一历史投影在单根 / 无根下仍显示会话，但不画范围选择器
for (const roots of [[], [dir("C:\\client\\app")]]) {
  const markup = renderPanel(view({ roots, sessions: [row("CURRENT")] }));
  assert.ok(markup.includes("CURRENT"));
  assert.ok(!markup.includes('class="drawer-scope"'));
}

// 5c3) 宿主把范围路径规范化成另一种拼写（盘符大小写 / 斜杠方向）：仍要选中同一目录
{
  const canonical = view({
    scope: { kind: "directory", path: "c:/WORK/alpha/" },
    roots: [dir("C:\\work\\alpha"), dir("C:\\work\\beta")],
    mixedDirectories: false,
    sessions: [row("ONE", { cwd: "C:\\work\\alpha" })],
  });
  const markup = renderPanel(canonical);
  const selected = /<option value="([^"]*)"[^>]*selected=""/.exec(markup);
  assert.ok(selected, "规范化后的目录范围仍能找到并选中对应选项（不显示空白）");
  assert.strictEqual(
    selected[1],
    esc(historyScopeValue({ kind: "directory", path: "C:\\work\\alpha" })),
    "选中值取候选里的规范拼写（宿主下一次回帧的同一身份）",
  );
  assert.ok(
    !markup.includes(esc(historyScopeValue({ kind: "directory", path: "c:/WORK/alpha/" }))),
    "不再补一条与同一目录重复的原始拼写选项",
  );
}

// 5d) 混合目录：行内显示去重短名，完整路径在 title 上；非混合不显示
{
  const mixed = view({
    mixedDirectories: true,
    sessions: [
      row("ONE", { cwd: "C:\\client\\app" }),
      row("TWO", { cwd: "C:\\server\\app" }),
    ],
  });
  const markup = renderPanel(mixed);
  assert.ok(markup.includes('class="session-item-dir"'), "混合目录的结果行显示创建目录");
  assert.ok(markup.includes("client/app") && markup.includes("server/app"), "同名目录逐级补父段");
  assert.ok(markup.includes('title="C:\\client\\app"'), "创建目录短名的悬停标题是完整路径");

  const single = renderPanel(view({ mixedDirectories: false, sessions: [row("ONE", { cwd: "C:\\client\\app" })] }));
  assert.ok(!single.includes('class="session-item-dir"'), "单一目录列表不重复显示同一个目录名");
}

// ---------- 6. 接线源码：范围共用、点行只按 id 打开、不改空会话目录 ----------
{
  const history = readFileSync(join(process.cwd(), "src", "webview", "components", "History.tsx"), "utf8");
  assert.ok(
    /post\(\{ type: "historyScope", scope: next \}\)/.test(history),
    "范围选择器发 historyScope（不是 listSessions / 换会话）",
  );
  assert.ok(
    /const scope = history\?\.scope;/.test(history) &&
      !/archived \? history\.scope|view === "archived" \? history\.scope/.test(history),
    "范围是宿主投影的一份状态，普通 / 归档共用（不在 view 分支里各存一份）",
  );
  assert.ok(
    /sameHistoryScope\(option\.scope, scope\)/.test(history) && /value=\{selectValue\}/.test(history),
    "选中项按范围身份（sameHistoryScope）匹配，不按编码字节串",
  );
  const batchLoops = [...history.matchAll(/for \(const sessionId of visibleSelected\)/g)];
  assert.strictEqual(batchLoops.length, 3, "归档 / 恢复 / 删除都只遍历当帧可见选中项");
  assert.ok(
    /const visibleSelected = selectableIds\.filter\(\(sessionId\) => selected\.has\(sessionId\)\)/.test(history) &&
      /const selectedCount = visibleSelected\.length/.test(history),
    "批量数量与动作共用「当帧可见且可选」的选中集",
  );
  assert.ok(
    /post\(\{ type: "openSession", sessionId: session\.id \}\)/.test(history),
    "点历史行仍按 id 打开会话",
  );
  assert.ok(
    !/pickWorkspace|switchRoot|pickOtherRoot/.test(history),
    "历史抽屉不改空会话目录（不出现目录选择动作）",
  );
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(/history=\{state\.history\}/.test(app), "App 把 state.history 交给历史抽屉");
}

console.log("historyDirectoryView.test: ok");
