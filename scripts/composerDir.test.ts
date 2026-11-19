/**
 * 空态页工作目录行与菜单的判据（`workspaceDirView`）及渲染。
 *
 * 口径：目录只在「会话还没开始」时有得改。打开着文件夹时把工作区根目录作为新会话
 * 预设列出，并允许（宿主没禁用时）选一个工作区外目录；没有根目录列表的老宿主仍走
 * 原来的系统目录选择器；已有对话不渲染这一行（标题栏那枚目录只是静态说明）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceView } from "../src/shared/chat";
import { dirKey, workspaceDirView } from "../src/webview/composerDir";
import { shortDirectoryLabels } from "../src/webview/directoryLabel";
import { dictionaryFor, TextsContext } from "../src/webview/texts";

// `bridge.ts` 在模块求值期挂 window 监听：无头环境补一个最小 window（先于动态 import）。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => undefined, setState: () => {} }),
};
const { EmptyMeta, WorkspaceMenu } = await import("../src/webview/components/EmptyMeta");

const dir = (path: string, name?: string) => ({
  path,
  name: name ?? path.split(/[/\\]/u).filter(Boolean).pop() ?? path,
});
const workspace = (over: Partial<WorkspaceView>): WorkspaceView => ({ path: "", locked: false, ...over });

// 没有 workspace → 整行不出现（不拿宿主 cwd 冒充）
assert.strictEqual(workspaceDirView(undefined), undefined);

// 打开着文件夹：根目录作为预设，不因 `locked` 变成只读；canPickOther 缺省可用
{
  const roots = [dir("D:\\proj\\a"), dir("D:\\proj\\b")];
  const view = workspaceDirView(workspace({ path: "D:\\proj\\a", locked: true, roots }));
  assert.ok(view);
  assert.strictEqual(view.mode, "roots");
  assert.strictEqual(view.name, "a");
  assert.strictEqual(view.current?.path, "D:\\proj\\a");
  assert.strictEqual(view.currentInRoots, true);
  assert.strictEqual(view.canPickOther, true);
  assert.deepStrictEqual([...view.roots], roots);
}

// 宿主明确禁用外部目录：仍列根目录，但「选择其他文件夹…」不出现
{
  const view = workspaceDirView(
    workspace({ path: "D:\\proj\\a", locked: true, roots: [dir("D:\\proj\\a")], canPickOther: false }),
  );
  assert.ok(view);
  assert.strictEqual(view.mode, "roots");
  assert.strictEqual(view.canPickOther, false);
}

// 当前目录是「选择其他文件夹…」选的工作区外目录：不在根里，但仍显示当前值
{
  const view = workspaceDirView(
    workspace({ path: "E:\\elsewhere\\notes", locked: true, roots: [dir("D:\\proj\\a")] }),
  );
  assert.ok(view);
  assert.strictEqual(view.mode, "roots");
  assert.strictEqual(view.current, undefined);
  assert.strictEqual(view.currentInRoots, false);
  assert.strictEqual(view.name, "notes");
}

// 没有根目录列表、没有打开文件夹：沿用原来的系统目录选择器（没选过也是这一档）
{
  const chosen = workspaceDirView(workspace({ path: "D:\\x\\y", locked: false }));
  assert.ok(chosen);
  assert.strictEqual(chosen.mode, "pick");
  assert.strictEqual(chosen.current?.path, "D:\\x\\y");
  const empty = workspaceDirView(workspace({ path: "", locked: false }));
  assert.ok(empty);
  assert.strictEqual(empty.mode, "pick");
  assert.strictEqual(empty.name, "");
}

// 老宿主只给 locked + path：静态只读，与旧界面一致
{
  const view = workspaceDirView(workspace({ path: "D:\\proj\\a", locked: true }));
  assert.ok(view);
  assert.strictEqual(view.mode, "locked");
  assert.strictEqual(view.canPickOther, false);
}

// 没有根目录列表 + 宿主明确禁用外部目录：静态只读，不能退回系统选择器
{
  const view = workspaceDirView(workspace({ path: "", locked: false, canPickOther: false }));
  assert.ok(view);
  assert.strictEqual(view.mode, "disabled");
  assert.strictEqual(view.canPickOther, false);
  const withPath = workspaceDirView(workspace({ path: "D:\\proj\\a", locked: false, canPickOther: false }));
  assert.strictEqual(withPath?.mode, "disabled");
}

// 路径键：Windows 不区分大小写 / 斜杠方向；POSIX 保留大小写，根 `/` 不能归一成空串
assert.strictEqual(dirKey("C:\\Foo\\"), dirKey("c:/foo"));
assert.notStrictEqual(dirKey("/home/A"), dirKey("/home/a"));
assert.strictEqual(dirKey("/"), "/");

// 同名目录去重短名：先补父目录，再带上根；仍撞名时完整路径兜底
{
  const labels = shortDirectoryLabels([
    dir("C:\\client\\app"),
    dir("C:\\server\\app"),
    dir("C:\\solo"),
  ]);
  assert.strictEqual(labels.get(dirKey("C:\\client\\app")), "client/app");
  assert.strictEqual(labels.get(dirKey("C:\\server\\app")), "server/app");
  assert.strictEqual(labels.get(dirKey("C:\\solo")), "solo");

  // 不同盘符、同样的尾路径：补到根仍撞名，退回完整路径（仍是可区分的唯一写法）
  const drives = shortDirectoryLabels([dir("C:\\dev\\app"), dir("D:\\dev\\app")]);
  assert.strictEqual(drives.get(dirKey("C:\\dev\\app")), "C:\\dev\\app");
  assert.strictEqual(drives.get(dirKey("D:\\dev\\app")), "D:\\dev\\app");

  // POSIX 根不能变成空名；只差大小写的两个目录保留完整路径才分得开
  const posix = shortDirectoryLabels([dir("/"), dir("/a/src"), dir("/A/src")]);
  assert.strictEqual(posix.get(dirKey("/")), "/");
  assert.strictEqual(posix.get(dirKey("/a/src")), "/a/src");
  assert.strictEqual(posix.get(dirKey("/A/src")), "/A/src");
}

/** `renderToStaticMarkup` 会转义 HTML 特殊字符（英文文案里的 `'`），比对前同样转义。 */
const esc = (text: string): string =>
  text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#x27;");

// 菜单：根目录、当前项、外部目录入口；中英各渲染一遍，防止漏登记
const roots = [dir("D:\\proj\\a"), dir("D:\\proj\\b")];
const rootView = workspaceDirView(workspace({ path: "D:\\proj\\a", locked: true, roots }))!;
const noOtherView = workspaceDirView(
  workspace({ path: "D:\\proj\\a", locked: true, roots, canPickOther: false }),
)!;
const outsideView = workspaceDirView(
  workspace({ path: "E:\\elsewhere\\notes", locked: true, roots }),
)!;
function renderMenu(lang: "zh" | "en", view: typeof rootView): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor(lang) },
      createElement(WorkspaceMenu, { view, onClose: () => {} }),
    ),
  );
}
for (const lang of ["zh", "en"] as const) {
  const t = dictionaryFor(lang);
  const markup = renderMenu(lang, rootView);
  assert.ok(markup.includes(esc(t.dirSwitchRoot)), `${lang}: 菜单分组标题走词典`);
  assert.ok(markup.includes(">a<") && markup.includes(">b<"), `${lang}: 两个根目录都列出`);
  assert.ok(markup.includes("is-selected"), `${lang}: 当前根目录有选中态`);
  assert.ok(markup.includes(esc(t.dirOtherFolder)), `${lang}: 默认给「选择其他文件夹…」`);
  assert.ok(!renderMenu(lang, noOtherView).includes(esc(t.dirOtherFolder)), `${lang}: 宿主禁用时不显示该入口`);
  const outside = renderMenu(lang, outsideView);
  assert.ok(
    outside.includes("E:\\elsewhere\\notes") && outside.includes("notes"),
    `${lang}: 工作区外目录作为当前项列出（短名 + 完整路径）`,
  );
}

// 空态页那行：三种形态的外观（静态 / 系统选择器 / 根目录菜单入口）
{
  const locked = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(EmptyMeta, {
        workspace: workspace({ path: "D:\\proj\\a", locked: true }),
      }),
    ),
  );
  assert.ok(locked.includes(esc(dictionaryFor("zh").workspaceLocked)), "老宿主形态仍说明目录跟随 VS Code");
  assert.ok(!locked.includes("aria-haspopup"), "静态形态没有菜单入口");

  const pick = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(EmptyMeta, { workspace: workspace({ path: "", locked: false }) }),
    ),
  );
  assert.ok(pick.includes(esc(dictionaryFor("zh").workspaceChoose)), "没打开文件夹时仍是系统目录选择器");
  assert.ok(!pick.includes("aria-haspopup"), "系统目录选择器不是菜单");

  const disabled = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      createElement(EmptyMeta, {
        workspace: workspace({ path: "", locked: false, canPickOther: false }),
      }),
    ),
  );
  assert.ok(
    disabled.includes(esc(dictionaryFor("zh").workspacePickDisabled)),
    "宿主禁用外部目录时说明当前环境不能选其他目录",
  );
  assert.ok(
    !disabled.includes(esc(dictionaryFor("zh").workspaceChoose)) &&
      !disabled.includes(esc(dictionaryFor("zh").workspaceChange)),
    "禁用外部目录时不出现系统选择器提示（不能退回 pickWorkspace）",
  );

  // 有根目录时胶囊展开菜单的行为由 `WorkspaceMenu` 的直接渲染与源码接线覆盖；
  // 这里不渲染 Popover，避免 SSR 触发 useLayoutEffect 的无关警告。
}

// 接线：三种形态对应的三个 IPC 动作，以及已有对话不会出现编辑入口
{
  const source = readFileSync(join(process.cwd(), "src", "webview", "components", "EmptyMeta.tsx"), "utf8");
  assert.ok(/post\(\{ type: "pickWorkspace" \}\)/.test(source), "无根目录形态仍走系统目录选择器");
  assert.ok(/post\(\{ type: "switchRoot", path \}\)/.test(source), "根目录点选发 switchRoot");
  assert.ok(/post\(\{ type: "pickOtherRoot" \}\)/.test(source), "「选择其他文件夹…」发 pickOtherRoot");
  assert.ok(/aria-haspopup="menu"/.test(source), "根目录形态是菜单入口（有 aria-haspopup）");
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const emptyGate = app.indexOf("state.messages.length === 0");
  const emptyState = app.indexOf("<EmptyState state={state} />");
  assert.ok(
    emptyGate > 0 && emptyState > emptyGate,
    "EmptyMeta 只在空白会话页渲染，已有对话没有目录编辑入口",
  );
}

console.log("composerDir.test: ok");
