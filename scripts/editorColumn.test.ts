/**
 * 「在编辑器中打开」与 `@会话` 引用的**落点**（编辑区哪一个标签组）——行为级回归；
 * 编辑器标题栏鲸鱼的单击 / Alt+单击落点也在这里钉。
 *
 * 用户 2026-10-10 口径：
 * 1. 来源窗口自己就在某个标签组里（编辑区面板，`@会话` 引用从那里点出来）→ 开在
 *    **同一组**的新标签里（跳去别的组等于把用户正看着的这一组丢下）；
 * 2. 否则编辑器区**已有任意标签组**（哪怕里面只有代码文件、一个 DSH 标签都没有）→
 *    开在**当前活动**的那一组里，而不是每点一次就多开一个分组；
 * 3. 一个标签组都没有（空窗口才会这样）→ 新开一个分组（`ViewColumn.Beside`）。
 *
 * 驱动**真的** `ChatViewProvider`（vscode 依赖由 esbuild.scripts.mjs 的 alias 指到
 * `vscodeTestStub.ts`）：这条判定的三个分支都要拿真的面板对象、真的标签组现场跑一遍
 * ——正则只能证明「代码里有这行字」，证明不了落点对不对。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

// 动态 import：让 alias（esbuild 打包期）把 chatView 依赖的 vscode 换成 stub
const { ChatViewProvider } = await import("../src/chatView");

/**
 * `vscode.window.tabGroups`：stub 里是可变的现场，类型上是只读的，测试按需摆。
 *
 * `stageGroups` 摆出来的分组**没有任何标签**——这正是要钉的那条：判据是「编辑器区
 * 存在分组」，不是「已经有一个 DSH 标签」。
 */
const tabGroups = (
  vscode.window as unknown as {
    tabGroups: { all: { viewColumn: number }[]; activeTabGroup: { viewColumn: number } };
  }
).tabGroups;

/** 摆一次编辑区分组现场：`groups` 是各分组的列号，`active` 是当前活动的那个。 */
function stageGroups(groups: number[], active: number): void {
  tabGroups.all = groups.map((viewColumn) => ({ viewColumn }));
  tabGroups.activeTabGroup = { viewColumn: active };
}

/** 面板：只给 `attachPanel` 会碰到的那些面。 */
function fakePanel(viewColumn: number) {
  const viewListeners: ((event: { webviewPanel: { visible: boolean } }) => void)[] = [];
  const disposeListeners: (() => void)[] = [];
  const panel = {
    viewColumn,
    iconPath: undefined as unknown,
    webview: {
      options: undefined as unknown,
      html: "",
      cspSource: "vscode-webview://test",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: () => new vscode.Disposable(),
    },
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener);
      return new vscode.Disposable();
    },
    onDidChangeViewState: (listener: (event: { webviewPanel: { visible: boolean } }) => void) => {
      viewListeners.push(listener);
      return new vscode.Disposable();
    },
    reveal: () => {},
  };
  return {
    panel,
    /** 用户在编辑器里把标签拖到别的分组（或让它重新可见）：列号跟着事件一起变。 */
    moveTo(next: number): void {
      panel.viewColumn = next;
      for (const listener of viewListeners) listener({ webviewPanel: { visible: true } });
    },
    /** 用户关掉这个标签。 */
    close(): void {
      for (const listener of disposeListeners) listener();
    },
  };
}

const controller = {
  subscribe: () => new vscode.Disposable(),
  bindView: () => {},
  unbindView: () => {},
  registerRevealer: () => {},
  registerTitleSetter: () => {},
  bindViewKind: () => {},
  noteActiveView: () => {},
  openSession: async () => {},
};

const provider = new ChatViewProvider(
  { extensionUri: { fsPath: "C:/ext" } } as never,
  controller as never,
  "panel",
  () => {},
);

/** 挂一个编辑区面板（与 `openPanel` 里那条路同一个入口，拿到它的 viewId）。 */
const attach = (panel: unknown): string =>
  (provider as unknown as { attachPanel(panel: unknown): string }).attachPanel(panel);

// ---------- 1. 来源窗口自己就在某个标签组里 → 同组新标签 ----------
{
  const a = fakePanel(2);
  const viewA = attach(a.panel);
  // 活动分组刻意**不是**面板那一组：这一条才分得出「自己那一组」与「活动分组」
  stageGroups([1, 2], 1);
  assert.strictEqual(
    provider.editorColumnFor(viewA),
    2,
    "面板里点出来的 `@会话` 要开在面板**自己那一组**的新标签里，而不是活动分组",
  );
  a.moveTo(3);
  assert.strictEqual(
    provider.editorColumnFor(viewA),
    3,
    "面板被拖到别的分组后，落点跟着它走（记的是最近一次读到的组）",
  );
  // 关掉这个标签 → 记的组一起清（否则一个已经不存在的窗口还能把落点拽回旧分组）
  stageGroups([1, 2, 3], 3);
  a.close();
  assert.strictEqual(
    provider.editorColumnFor(viewA),
    3,
    "窗口关掉后不再按它记的旧分组落点（那只标签已经不在那儿了）",
  );
  console.log("editorColumn: 来源面板在自己那一组开新标签 ✓");
}

// ---------- 2. 侧栏 / 辅助栏里的窗口（没有自己的分组）→ 当前活动分组 ----------
{
  stageGroups([1, 2, 3], 2);
  assert.strictEqual(
    provider.editorColumnFor(),
    2,
    "「在编辑器中打开」按钮（无来源窗口）开在当前活动分组的新标签里",
  );
  assert.strictEqual(
    provider.editorColumnFor("sidebar-view"),
    2,
    "侧栏 / 辅助栏的窗口没有自己的标签组，同样落到活动分组",
  );
  assert.strictEqual(
    provider.editorColumnFor("never-seen"),
    2,
    "没见过的窗口（已关闭的面板）不臆造分组：按活动分组落点",
  );
  console.log("editorColumn: 没有自己分组的窗口落在活动分组 ✓");
}

// ---------- 3. 一个分组都没有 → 新开一个分组（改动前的落点） ----------
{
  stageGroups([], 0);
  assert.strictEqual(
    provider.editorColumnFor(),
    vscode.ViewColumn.Beside,
    "编辑器区没有任何分组时新开一个（ViewColumn.Beside）",
  );
  console.log("editorColumn: 没有分组时新开一个 ✓");
}

// ---------- 4. 接线：来源窗口真的传到落点判定；编辑区标签组里不显示那颗按钮 ----------
//
// 这三处是「点下去的落点」的上下游，都在需要 `vscode` 的宿主 / 需要 React 的界面里，
// 离线起不了实例，只能按源码钉（与本仓库既有的宿主接线断言同一手法）。
{
  const controllerSource = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /executeCommand\("dshChat.openInEditor", sessionForEditor, viewId\)/.test(controllerSource),
    "`@会话` 与按钮那条帧要把**来源窗口**一起交给命令——落点判定全靠它",
  );
  assert.ok(
    /inEditorTab: this\.viewKinds\.get\(viewId \?\? ""\) === "panel"/.test(controllerSource),
    "首帧快照要告诉界面「本窗口是不是编辑区标签组里的会话」",
  );
  const extensionSource = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  assert.ok(
    /const column = provider\.editorColumnFor\(sourceViewId\);/.test(extensionSource),
    "命令的落点必须走 `provider.editorColumnFor`（规则只有一处）",
  );
  assert.ok(
    !/ViewColumn\.Beside/.test(extensionSource),
    "命令里不写死分组落点：单击与 Alt+单击两侧规则都在 `ChatViewProvider`（`openPanelInCurrentGroup` / `openPanelBeside`）",
  );
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /\{state\.inEditorTab \? null : \(/.test(app),
    "编辑区标签组里的会话不显示「在编辑器中打开」（自己就在标签组里）",
  );
  console.log("editorColumn: 来源窗口与按钮显示条件都接上了 ✓");
}

// ---------- 5. 编辑器标题栏鲸鱼：单击本分组，Alt+单击右侧并排 ----------
//
// 单击走 `newSessionInGroup`（`ViewColumn.Active`）；Alt+单击由 `package.json` 的
// `editor/title` 菜单 `alt` 字段接到 `newSessionBeside`（`ViewColumn.Beside`）。
// 两条命令都只调 provider 里的一个方法，落点规则只有一处。
{
  const created = (
    vscode as unknown as {
      createdWebviewPanels: {
        viewType: string;
        title: string;
        viewColumn: number | undefined;
        preserveFocus: boolean;
      }[];
    }
  ).createdWebviewPanels;
  created.length = 0;

  provider.openPanelInCurrentGroup();
  const single = created[created.length - 1];
  assert.strictEqual(
    single?.viewColumn,
    vscode.ViewColumn.Active,
    "单击鲸鱼在**当前分组**开新会话（ViewColumn.Active）",
  );
  assert.strictEqual(single?.preserveFocus, false, "点一下要跳过去：显式 focus");

  provider.openPanelBeside();
  const alt = created[created.length - 1];
  assert.strictEqual(
    alt?.viewColumn,
    vscode.ViewColumn.Beside,
    "Alt+单击在**代码区右侧并排**开新分组（ViewColumn.Beside）",
  );
  assert.strictEqual(alt?.preserveFocus, false, "Alt+单击同样跳过去：显式 focus");
  console.log("editorColumn: 鲸鱼单击本分组 / Alt+单击右侧并排 ✓");
}

// ---------- 6. 清单接线：菜单 `alt` 必须指向已声明的命令，且宿主真的注册了 ----------
//
// VS Code 的菜单 `alt` 只认 `contributes.commands` 里声明过的命令（宿主按 id 查
// 命令表）；少一条，Alt+单击就会静默退回单击。清单与宿主分处两处，按源码钉。
{
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    contributes: {
      commands: { command: string }[];
      menus: Record<string, { command?: string; alt?: string }[]>;
    };
  };
  const whale = (manifest.contributes.menus["editor/title"] ?? []).find(
    (item) => item.command === "dshChat.newSessionInGroup",
  );
  assert.strictEqual(
    whale?.alt,
    "dshChat.newSessionBeside",
    "编辑器标题栏鲸鱼的 `alt` 分支指向「在右侧新建对话窗口」",
  );
  assert.ok(
    manifest.contributes.commands.some((item) => item.command === "dshChat.newSessionBeside"),
    "`alt` 指向的命令必须在 contributes.commands 里声明（否则 VS Code 不认这条分支）",
  );
  const extensionSource = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  assert.ok(
    /provider\.openPanelInCurrentGroup\(\)/.test(extensionSource),
    "单击鲸鱼的落点走 `provider.openPanelInCurrentGroup`（命令侧不写死分组常量）",
  );
  assert.ok(
    /registerCommand\("dshChat\.newSessionBeside"/.test(extensionSource),
    "Alt 分支的命令要在宿主里注册",
  );
  assert.ok(
    /provider\.openPanelBeside\(\)/.test(extensionSource),
    "Alt 分支的落点走 `provider.openPanelBeside`",
  );
  console.log("editorColumn: 菜单 alt / 命令声明 / 宿主注册接上了 ✓");
}

console.log("\neditorColumn: all assertions passed");
