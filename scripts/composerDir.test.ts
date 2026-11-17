/**
 * 输入栏工作目录胶囊 / 弹层的判据（`composerDirView`）与弹层渲染。
 *
 * 口径（用户 2026-11-17）：目录像权限那样显示在输入栏，需要时在那里改。改的方式按会话状态分：
 * 空会话 + 打开着文件夹 → 切根或「选择其他文件夹…」（可以选工作区外的目录）；空会话 + 没开文件夹 →
 * 系统目录选择器；
 * 已有对话 → 只读。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatState } from "../src/shared/chat";
import { composerDirView, dirKey } from "../src/webview/composerDir";
import { dictionaryFor, TextsContext } from "../src/webview/texts";

// `bridge.ts` 在模块求值期挂 window 监听：无头环境补一个最小 window（先于动态 import）。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => undefined, setState: () => {} }),
};
const { DirMenu } = await import("../src/webview/components/ComposerDir");

type Input = Pick<ChatState, "workspace" | "session" | "workingDirectory" | "messages" | "subagent">;
const base = (over: Partial<Input>): Input => ({ messages: [], ...over });
const msgs = [{ id: "m1" }] as unknown as ChatState["messages"];

// 没有任何目录 → 不出胶囊（不拿宿主 cwd 冒充）
assert.strictEqual(composerDirView(base({})), undefined);
assert.strictEqual(composerDirView(base({ workspace: { path: "", locked: false } })), undefined);

// 子代理页不给入口
assert.strictEqual(
  composerDirView(
    base({
      workspace: { path: "D:\\proj\\a", locked: true },
      subagent: { parentSessionId: "p", mode: "one-shot" } as unknown as ChatState["subagent"],
    }),
  ),
  undefined,
);

// 空会话 + 文件夹但宿主没给根目录列表（旧形态）：只读，名字取末段
{
  const view = composerDirView(base({ workspace: { path: "D:\\proj\\a", locked: true } }));
  assert.ok(view);
  assert.strictEqual(view.name, "a");
  assert.strictEqual(view.mode, "none");
  assert.strictEqual(view.switched, false);
}

// 空会话 + 单个文件夹：也能「选择其他文件夹…」（不再是只读死路）
{
  const view = composerDirView(base({ workspace: { path: "D:\\proj\\a", locked: true, roots: ["D:\\proj\\a"] } }));
  assert.ok(view);
  assert.strictEqual(view.mode, "switch-root");
}

// 空会话 + 多根：可在根目录间切换
{
  const roots = ["D:\\proj\\a", "D:\\proj\\b"];
  const view = composerDirView(base({ workspace: { path: "D:\\proj\\a", locked: true, roots } }));
  assert.ok(view);
  assert.strictEqual(view.mode, "switch-root");
  assert.deepStrictEqual([...view.roots], roots);
}

// 空会话 + 没打开文件夹且选过目录：走系统目录选择器
{
  const view = composerDirView(base({ workspace: { path: "D:\\x\\y", locked: false } }));
  assert.ok(view);
  assert.strictEqual(view.mode, "pick-folder");
}

// 已有对话：只读；执行目录与创建目录不同时标出来，胶囊显示执行目录
{
  const view = composerDirView(
    base({
      messages: msgs,
      workspace: { path: "D:\\proj\\a", locked: true, roots: ["D:\\proj\\a", "D:\\proj\\b"] },
      session: { cwd: "D:\\proj\\a" } as unknown as ChatState["session"],
      workingDirectory: "D:\\proj\\b",
    }),
  );
  assert.ok(view);
  assert.strictEqual(view.mode, "started");
  assert.strictEqual(view.name, "b");
  assert.strictEqual(view.path, "D:\\proj\\b");
  assert.strictEqual(view.created, "D:\\proj\\a");
  assert.strictEqual(view.switched, true);
}

// 执行目录缺失 → 退回创建目录；大小写 / 斜杠不同不算「已切换」
{
  const view = composerDirView(
    base({
      messages: msgs,
      workspace: { path: "D:\\proj\\a", locked: true },
      session: { cwd: "D:\\proj\\a" } as unknown as ChatState["session"],
    }),
  );
  assert.ok(view);
  assert.strictEqual(view.path, "D:\\proj\\a");
  assert.strictEqual(view.switched, false);
  const same = composerDirView(
    base({
      messages: msgs,
      session: { cwd: "D:\\Proj\\A" } as unknown as ChatState["session"],
      workingDirectory: "d:/proj/a/",
    }),
  );
  assert.strictEqual(same?.switched, false);
}

// POSIX 路径保留大小写；Windows 形态不区分
assert.notStrictEqual(dirKey("/home/A"), dirKey("/home/a"));
assert.strictEqual(dirKey("C:\\Foo\\"), dirKey("c:/foo"));

/** `renderToStaticMarkup` 会转义 HTML 特殊字符（英文文案里的 `'`），比对前同样转义。 */
const esc = (text: string): string =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#x27;");

// 弹层：各形态的文案都在（中英各渲染一遍，防止漏登记）
function render(lang: "zh" | "en", view: NonNullable<ReturnType<typeof composerDirView>>): string {
  return renderToStaticMarkup(
    createElement(TextsContext.Provider, { value: dictionaryFor(lang) }, createElement(DirMenu, { view, onClose: () => {} })),
  );
}
const roots2 = ["D:\\proj\\a", "D:\\proj\\b"];
const started = composerDirView(
  base({
    messages: msgs,
    workspace: { path: "D:\\proj\\a", locked: true, roots: roots2 },
    session: { cwd: "D:\\proj\\a" } as unknown as ChatState["session"],
  }),
)!;
const switchRoot = composerDirView(base({ workspace: { path: "D:\\proj\\a", locked: true, roots: roots2 } }))!;
// 当前目录是工作区外的文件夹（用户「选择其他文件夹…」选的）：仍是 switch-root，当前行单独列出
const outside = composerDirView(
  base({ workspace: { path: "E:\\other\\place", locked: true, roots: roots2 } }),
)!;
assert.strictEqual(outside.mode, "switch-root");
assert.strictEqual(outside.name, "place");
const locked = composerDirView(base({ workspace: { path: "D:\\proj\\a", locked: true } }))!;
const picker = composerDirView(base({ workspace: { path: "D:\\x\\y", locked: false } }))!;
for (const lang of ["zh", "en"] as const) {
  const t = dictionaryFor(lang);
  const m = render(lang, started);
  assert.ok(m.includes(esc(t.dirStartedHint)), `${lang}: 已有对话形态（只读说明）`);
  assert.ok(!m.includes("popover-item"), `${lang}: 已有对话不给任何更改入口`);
  const r = render(lang, switchRoot);
  assert.ok(r.includes(t.dirSwitchRoot) && r.includes("D:\\proj\\b"), `${lang}: 空会话多根形态（列出另一个根）`);
  assert.ok(r.includes(t.dirOtherFolder), `${lang}: 多根形态有「选择其他文件夹…」`);
  const o = render(lang, outside);
  assert.ok(o.includes("E:\\other\\place") && o.includes(t.dirOtherFolder), `${lang}: 工作区外目录作为已选中行列出，且仍可再选`);
  assert.ok(!r.includes("E:\\other"), `${lang}: 工作区内的目录不会多出「外部」行`);
  assert.ok(render(lang, locked).includes(t.workspaceLocked), `${lang}: 单根只读形态`);
  assert.ok(render(lang, picker).includes(t.dirPickFolder), `${lang}: 没开文件夹形态`);
}

console.log("composerDir.test: ok");
