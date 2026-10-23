/**
 * `@` / `/` 补全的规则集（`src/webview/composerCompletion.tsx`）与「返回上一层目录」。
 *
 * 这一套规则此前散在 `Composer.tsx` 的 9 段不相邻代码里，判据只能靠「读 `Composer.tsx`
 * 源码 + 正则」钉（`applyCandidate(highlight, "drill")`、`return [up, ...files, ...sessions]`
 * 之类）。那种断言只证明「代码里有这行字」：换个参数名、把逻辑搬进 helper 就失效，
 * 而且失败信息指向的是调用形状而不是行为（`scripts/styles.test.ts` 里对同类
 * 源码正则的判词；`src/webview/turnProcess.ts` 那种「抽的是行为」的形状才是样板）。
 *
 * 现在规则本身收进了 module：能纯函数化的直接断言函数（第 5–9 节），必须走 React 的
 * 部分用 `react-dom/server` 渲染一个只有 hook 的组件，再把 hook 返回的 prop 当普通
 * 函数调——事件对象是手写的假对象，只带被读的字段，`textareaRef` 指向一个假节点
 * （同时是「光标真的落到哪」的观察点）。第 10–16 节跑的是真实的「事件 → 渲染」链，
 * 第 17–20 节是**弹层何时弹**这一口径的回归（用户 2026-10-10 与 2026-10-11 两轮：
 * 浏览入口恒弹，块已经能引用到内容时整块不弹），最后「键盘只在弹层画出来时接管」
 * 一节钉住键盘与渲染同判据（用户 2026-10-18 报的现场：抑制门按住时回车改写了正文，
 * 选中一个看不见的「..」）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ReactRuntime from "react";
import {
  createElement,
  type ChangeEvent,
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommandView, FileRefView, SessionRefView } from "../src/shared/chat";
import { mentionParent } from "../src/webview/mentionNav";
import { dictionaryFor } from "../src/webview/texts";

// `composerCompletion` 连带 `bridge.ts` 在**模块求值期**就挂 `window.addEventListener`
// （webview 里那是真实存在的宿主），无头环境必须先补一个最小 window、**再动态 import**
// ——静态 import 会被提升到补桩之前，报 `ReferenceError: window is not defined`。
// `acquireVsCodeApi` 也要补：候选选中时会真调 `post({type:"setDraft"})`（bridge 里的全局）。
// 与 `scripts/questionRender.test.ts` 同一手法。
(globalThis as { window?: unknown; acquireVsCodeApi?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
/**
 * 界面发给宿主的帧（`post`），供「一次导航只写一条草稿、导航本身不发查询帧」这类
 * 计数断言读。原先是纯 no-op，改成记录不改行为。
 */
const POSTED: Array<Record<string, unknown>> = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => {
    POSTED.push(message as Record<string, unknown>);
  },
});
const {
  candidateRows,
  commandMenuDraft,
  commandRequestTrigger,
  clickAction,
  ComposerCompletionState,
  findTrigger,
  hasDrillableFolder,
  isSessionCandidate,
  outcomeFor,
  popoverVisible,
  rankCandidates,
  useComposerCompletion,
} = await import("../src/webview/composerCompletion");
type ComposerCompletionStateHook = import("../src/webview/composerCompletion").ComposerCompletionStateHook;
type MentionCandidate = import("../src/webview/composerCompletion").MentionCandidate;
type UseComposerCompletionInput = import("../src/webview/composerCompletion").UseComposerCompletionInput;
const { scanCommandLinks } = await import("../src/webview/commandLinks");

/**
 * 界面文案（中文词典）：分组标题、`Tab 进入目录` 提示这些都在它里面。
 *
 * 用 `dictionaryFor` 而不是某个导出的常量——词典本身是别人的重构目标（`texts.ts` /
 * `messages.ts` 正在被另一个会话重排），这里只需要「一个真的词典对象」。
 */
const TEXTS = dictionaryFor("zh");

/**
 * `requestAnimationFrame` 的替身：Node 里没有它，而**「光标在 rAF 里落」正是要断言的
 * 行为之一**（同步落会被 React 的重渲染顶掉）。所以不直接执行回调，而是排进队列，
 * 由 `flushRaf` 显式放行——一次都没排队，就说明有人把落光标改成了同步。
 */
const RAF_QUEUE: Array<() => void> = [];
(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (
  cb,
) => {
  RAF_QUEUE.push(cb);
  return RAF_QUEUE.length;
};

/** 放行所有排队中的 rAF 回调（= 浏览器里的下一帧）。 */
function flushRaf(): number {
  const pending = RAF_QUEUE.splice(0, RAF_QUEUE.length);
  for (const cb of pending) cb();
  return pending.length;
}

/* ============================ 判据：纯函数 ============================ */

// ---------- 1. 根目录没有上一层 ----------
{
  assert.strictEqual(mentionParent(""), undefined, "空查询 = 工作区根目录");
  assert.strictEqual(mentionParent("src"), undefined, "没有分隔符 = 还在根目录列候选");
  assert.strictEqual(mentionParent("web"), undefined, "正在根目录里打字");
}
console.log("mentionNav: 根目录没有「..」 ✓");

// ---------- 2. 一层层往回 ----------
{
  assert.strictEqual(mentionParent("src/"), "", "src/ 的上一层是根目录（空查询）");
  assert.strictEqual(mentionParent("src/webview/"), "src/", "子目录回到父目录");
  assert.strictEqual(mentionParent("src/webview/components/"), "src/webview/", "深层同理");
  assert.strictEqual(mentionParent("a/b/c/d/"), "a/b/c/");
}
console.log("mentionNav: 逐层回退 ✓");

// ---------- 3. 正在输入某个半截名字时，上一层仍按**当前目录**算 ----------
{
  assert.strictEqual(mentionParent("src/webview/Com"), "src/", "半截名字不影响上一层");
  assert.strictEqual(mentionParent("src/webview"), "", "只打到目录名、没打斜杠：列的是 src 下匹配项 → 上一层是根");
}
console.log("mentionNav: 半截输入下的上一层 ✓");

// ---------- 4. 反斜杠写法（Windows 手输）同样认 ----------
//
// 认的是**写法**：反斜杠按分隔符切段（否则 `src\webview\` 会被当成一个名字）。
// 返回值一律是正斜杠形态——`@` 引用本身就是正斜杠语法，写回正文那条路
// （`drillQueryToken` 与 `shared/mentions.ts` 的 `normalizeMentionPath`）也会归一，
// 所以候选行里显示的上一层与最终写进正文的形态是同一个。
{
  assert.strictEqual(mentionParent("src\\webview\\"), "src/", "反斜杠写法照常切段，返回值归一成正斜杠");
  assert.strictEqual(mentionParent("src\\"), "", "一层深度的反斜杠写法回到根");
}
console.log("mentionNav: 反斜杠写法 ✓");

// ---------- 5. 候选列表的拼装：`..` 最前、文件在前对话在后 ----------
//
// 用户 2026-09-14 口径（列表顶部给一个回上一层的入口）与官方 `reference` 源的顺序
// （`fileItems` 在前、`sessionItems` 在后）。这两条以前是读 Composer 源码的正则
// （`return [up, ...files, ...sessions]`），现在直接调 `rankCandidates` 看结果。
{
  const files: FileRefView[] = [
    { path: "src/a.ts", kind: "file" },
    { path: "src/webview", kind: "directory" },
  ];
  const sessions: SessionRefView[] = [
    { sessionId: "s1", label: "上一个会话", mention: "@[上一个会话](dsh-session:s1)" },
  ];
  const nameOf = (c: MentionCandidate) =>
    (c as FileRefView).path ?? (c as SessionRefView).sessionId;

  // 没进子目录：没有 `..`，文件在前、对话在后
  const flat = rankCandidates({ kind: "mention", start: 0, query: "src" }, [], files, sessions);
  assert.deepStrictEqual(
    flat.map(nameOf),
    ["src/a.ts", "src/webview", "s1"],
    "根目录查询：文件候选在前、对话候选在后，没有 `..`",
  );

  // 进了子目录：`..` 排在最前，且它指向**上一层**（`src/webview/` → `src/`）。
  // 对话候选**只在工作区根目录列**（用户 2026-09-25 口径，刻意偏离官方 `@` 源）：
  // 进了目录那一组直接不参与排序——它是同步判掉的，不是「先渲染再消失」。
  const nested = rankCandidates({ kind: "mention", start: 0, query: "src/webview/" }, [], files, sessions);
  assert.deepStrictEqual(
    nested.map(nameOf),
    ["src/", "src/a.ts", "src/webview"],
    "「..」排在最前（用户口径：顶部提供返回上一层）；进了目录不再列对话候选",
  );
  assert.strictEqual((nested[0] as FileRefView).parent, true, "第一条必须是界面自己插的「..」行");
  assert.strictEqual((nested[0] as FileRefView).kind, "directory", "「..」也是一条目录候选");
  // 反斜杠写法同样算「进了目录」（用户手输 / Windows 候选两种来源）
  assert.ok(
    !rankCandidates({ kind: "mention", start: 0, query: "src\\webview" }, [], files, sessions).some(
      isSessionCandidate,
    ),
    "反斜杠查询也算进了目录：同样不列对话候选",
  );
  // 只在根目录筛（还没进任何目录）时对话候选照常参与排序
  assert.deepStrictEqual(
    rankCandidates({ kind: "mention", start: 0, query: "webview" }, [], files, sessions).map(nameOf),
    ["src/a.ts", "src/webview", "s1"],
    "根目录里打字（没进目录）时对话候选照常列",
  );

  // 命令通道按名字做大小写不敏感的子串过滤
  const commands: CommandView[] = [
    { name: "git-guard", description: "guard" },
    { name: "Plan", description: "plan" },
  ];
  assert.deepStrictEqual(
    rankCandidates({ kind: "command", start: 0, query: "pl" }, commands, files, sessions).map(
      (c) => (c as CommandView).name,
    ),
    ["Plan"],
    "命令候选按名字过滤（大小写不敏感）",
  );
  assert.deepStrictEqual(rankCandidates(undefined, commands, files, sessions), [], "没有触发词就没有候选");
}
console.log("completion: 候选取用与优先级（`..` 最前、文件在前对话在后） ✓");

// ---------- 6. 行的形状：`..` / 目录 / 对话怎么渲染 ----------
{
  const files: FileRefView[] = [
    { path: "src/", kind: "directory", parent: true },
    { path: "src/a.ts", kind: "file" },
    { path: "src/webview", kind: "directory" },
  ];
  const sessions: SessionRefView[] = [
    { sessionId: "s1", label: "上一个会话", mention: "@[上一个会话](dsh-session:s1)" },
  ];
  const rows = candidateRows([...files, ...sessions], "mention", TEXTS);

  assert.deepStrictEqual(
    rows.map((r) => [r.parent, r.folder, r.session, r.priority]),
    [
      [true, false, false, true], // 「..」：优先完整、但**不是**可载入的目录
      [false, false, false, false], // 普通文件：长路径必须能省略
      [false, true, false, false], // 目录：右侧有「整个目录」按钮
      [false, false, true, true], // 对话：优先完整
    ],
    "「..」是目录行但没有「整个目录」按钮；文件路径不挂 .is-priority",
  );
  assert.deepStrictEqual(
    rows.map((r) => r.showSection),
    [true, false, false, true],
    "分组标题只出现在组的第一行（文件组一条、对话组一条）",
  );
  assert.strictEqual(rows[0].section, TEXTS.mentionFiles);
  assert.strictEqual(rows[3].section, TEXTS.mentionSessions);

  // 命令通道只有一组
  assert.deepStrictEqual(
    candidateRows([{ name: "plan", description: "" }], "command", TEXTS).map((r) => [
      r.section,
      r.priority,
      r.showSection,
    ]),
    [[TEXTS.commands, true, true]],
  );

  // 「有可下钻的目录」不算 `..`：它本身是回上一层，没有「进到它里面」这回事。
  // 这只决定「Tab 进入目录」那条提示显不显示，**不**决定 Tab 有没有动作——`..` 上
  // Tab 照旧有动作（回上一层，与 Enter 一致，见第 7 节的 parent 用例）。
  assert.strictEqual(hasDrillableFolder(files), true, "有一个真目录 → 标题栏要显示 Tab 提示");
  assert.strictEqual(
    hasDrillableFolder([{ path: "src/", kind: "directory", parent: true }]),
    false,
    "只有 `..` 时不显示「按 Tab 进入目录」（没有可下钻的子目录，不是 Tab 没动作）",
  );
  assert.strictEqual(hasDrillableFolder(sessions), false, "对话候选不是目录");
}
console.log("completion: 分组标题 / 优先完整 / 目录按钮的判据 ✓");

// ---------- 7. pick 与 drill 的差别（官方 input-trigger 口径） ----------
//
// 官方 `case "tab"`：`item.drill === true`（目录）才 `pick(..., "drill")`，否则退回普通
// pick；`case "enter"` 永远是普通 pick。此前是读 Composer 源码的三对正则，现在直接
// 调 `outcomeFor` 看它给的动作。
{
  const dir: FileRefView = { path: "src/webview", kind: "directory" };
  const file: FileRefView = { path: "src/a.ts", kind: "file" };
  const up: FileRefView = { path: "src/", kind: "directory", parent: true };
  const session: SessionRefView = { sessionId: "s1", label: "标题", mention: "@[标题](dsh-session:s1)" };
  const command: CommandView = { name: "plan", description: "" };

  assert.deepStrictEqual(
    outcomeFor("mention", dir, "pick"),
    { type: "insert", token: "@src/webview/" },
    "目录 + pick（Enter / 点行）= 引用**整个目录**（补结尾斜杠）",
  );
  assert.deepStrictEqual(
    outcomeFor("mention", dir, "drill"),
    { type: "drill", path: "src/webview" },
    "只有「目录 + drill」（Tab）才下钻",
  );
  assert.deepStrictEqual(
    outcomeFor("mention", file, "drill"),
    { type: "insert", token: "@src/a.ts" },
    '非目录带 drill 也退回普通插入（官方 case "tab" 的 else 分支）',
  );
  assert.deepStrictEqual(
    outcomeFor("mention", up, "pick"),
    { type: "parent", path: "src/" },
    "「..」走自己的分支：回到上一层，而不是把 `..` 载入成引用",
  );
  assert.deepStrictEqual(
    outcomeFor("mention", up, "drill"),
    { type: "parent", path: "src/" },
    "「..」上 Tab（drill）与 Enter（pick）同一条动作：它是导航行，不是可下钻的目录",
  );
  assert.deepStrictEqual(
    outcomeFor("mention", session, "drill"),
    { type: "session", token: "@[标题](dsh-session:s1)" },
    "对话引用原样插入服务端铸好的 mention，不参与下钻",
  );
  assert.deepStrictEqual(
    outcomeFor("command", command, "drill"),
    { type: "command", name: "plan" },
    "命令通道忽略 drill（Tab 对命令没有意义）",
  );
  assert.strictEqual(
    outcomeFor("mention", { sessionId: "s", label: "l", mention: "  " }, "pick"),
    undefined,
    "mention 为空的对话候选不该被选中",
  );
  assert.strictEqual(outcomeFor("mention", undefined, "pick"), undefined, "没有候选时什么都不做");

  // 文件名含空格 → 引号形式；含引号 → 不可引用，退回带引号路径
  assert.deepStrictEqual(
    outcomeFor("mention", { path: "my file.txt", kind: "file" }, "pick"),
    { type: "insert", token: '@"my file.txt"' },
  );
  assert.deepStrictEqual(
    outcomeFor("mention", { path: 'a"b.txt', kind: "file" }, "pick"),
    { type: "insert", token: '"a"b.txt"' },
  );

  // ---------- 鼠标点行主体的动作（用户 2026-09-21 口径） ----------
  //
  // 「@ 列表中，鼠标点击目录的默认行为应该是打开该目录，而不是直接选中该目录，
  //   如果是选中该目录，尾部已有整个目录按钮用于满足该需求了」。
  // 所以：目录行点主体 = drill（打开），文件 / 对话 / `..` = pick；
  // 右下那枚「整个目录」按钮仍是 pick（它在 JSX 里写死，见 styles.test 的接线断言）。
  // 键盘分工不动：Enter = pick、Tab = drill（上面那批用例钉的就是它）；「..」行是唯一
  // 的例外——它是导航行，pick 与 drill 都给同一个 `parent` 结果（见上面的 `up` 用例）。
  {
    const dirRow = candidateRows([...rankCandidates({ kind: "mention", start: 0, query: "src" }, [], [dir], [])], "mention", TEXTS).find(
      (row) => row.folder,
    );
    assert.ok(dirRow, "候选里应当有一行是「可进目录」");
    assert.strictEqual(clickAction(dirRow), "drill", "点目录行主体 = 打开该目录（不是选中它）");
    const fileRow = candidateRows([file], "mention", TEXTS)[0];
    assert.strictEqual(clickAction(fileRow), "pick", "点文件行 = 选中（文件没有「打开」这一说）");
    const upRow = candidateRows([up], "mention", TEXTS)[0];
    assert.strictEqual(clickAction(upRow), "pick", "「..」行仍是 pick（两把键的 outcome 都是回上一层）");
    const sessionRow = candidateRows([session], "mention", TEXTS)[0];
    assert.strictEqual(clickAction(sessionRow), "pick", "对话行 = 选中");
    console.log("completion: 点目录行 = 进目录（选中整个目录留给尾部按钮 / Enter） ✓");
  }
}
console.log("completion: Tab 进入目录 / Enter 引用整个目录（「..」上两把键同为回上一层） ✓");

// ---------- 8. 触发词判定：`/` 与 `@` 不是同一条规则 ----------
//
// `@` 的判定分**两层**（用户 2026-10-10 与 2026-10-11 两轮口径）：
//
// (一) 这一节钉的「块认不认得出来」：
//   (1) 光标紧靠裸 `@` 右侧、且整个 `@` 内容块没有内容 —— 刚敲下 `@`，列工作区根目录；
//   (2) 块里**有内容**就触发（目录块、会话 id / 名字片段、已写成的引用都一样），
//       光标在块内**任意位置**都算，查询用**整个内容块**，不是光标前半截。
//
// 「`@` 内容块」= 那个 `@` 之后那一段：不带引号时到下一个空白（或文本末尾）为止，
// 成对引号（`@"…"`）时到闭引号为止（含空白的路径因此是一整块）；块里可以出现 `@`
// （`node_modules/@types/` 这种真路径），但它不是触发点。触发用的 `@` 必须落在行首或
// 空白之后——与 `/` 同一条边界规则（`mail@example.com`、`看@src` 都不算）。
//
// (二) 弹不弹由**宿主**的判定说了算（块本身已经能引用到内容就不弹，否则弹）：
// 判据要查盘、查会话列表，界面这一层没有证据，所以它随后面那条 `files/list` 帧回来
// （`resolved`）——行为断言在第 17 节（真渲染 hook），宿主侧判据在
// `scripts/mentionResolve.test.ts`。**浏览入口**（裸 `@`、以分隔符结尾的路径）不做判定、
// 恒弹：那是「进去看这一层」的意思，目录在不在都要能进去。
{
  // `/` 命令通道：行首 / 空白 / 包装标点之后；查询就是光标前那一段（路径与 URI 不算）
  assert.deepStrictEqual(findTrigger("/", 1), { kind: "command", start: 0, query: "" }, "行首一个 `/` 就触发命令");
  assert.deepStrictEqual(findTrigger("/pl", 3), { kind: "command", start: 0, query: "pl" });
  assert.deepStrictEqual(
    findTrigger("先看 /pl", 6),
    { kind: "command", start: 3, query: "pl" },
    "空白之后也能触发（否则用户在已有文字后打空格再输 `/` 弹不出菜单）",
  );
  assert.strictEqual(
    findTrigger("src/dsh/controller.ts", 21),
    undefined,
    "路径里的 `/` 前面是非空白字符 → 不误判成命令",
  );
  assert.strictEqual(findTrigger("/plan off", 9), undefined, "命令参数里的 `/` 不在行首/空白后 → 不触发");

  // ---- (1) 裸 `@`：光标紧靠它右侧，块里没有内容 ----
  assert.deepStrictEqual(findTrigger("@", 1), { kind: "mention", start: 0, query: "" }, "行首裸 `@` → 根目录列表");
  assert.deepStrictEqual(
    findTrigger("看一下 @", 5),
    { kind: "mention", start: 4, query: "" },
    "空白后的裸 `@` 同样触发（与 `/` 同一条边界规则）",
  );
  assert.deepStrictEqual(
    findTrigger("@ 后面还有字", 1),
    { kind: "mention", start: 0, query: "" },
    "块后面有什么字与它无关：光标紧靠 `@` 右侧就算",
  );
  assert.strictEqual(
    findTrigger("@ 后面还有字", 2),
    undefined,
    "光标离开了 `@` 的紧邻位置（中间隔了空白）就不算裸 `@`",
  );

  // ---- (2) 目录块：整块的语义路径以分隔符结尾，光标在块内任意位置 ----
  const nestedText = "看一下 @src/webview/";
  for (const caret of [5, 10, 19]) {
    assert.deepStrictEqual(
      findTrigger(nestedText, caret),
      { kind: "mention", start: 4, query: "src/webview/" },
      `目录块内的光标 ${caret}：查询必须是**整个块**（不是光标前半截）`,
    );
  }
  assert.deepStrictEqual(
    findTrigger("看一下 @src\\webview\\", 10),
    { kind: "mention", start: 4, query: "src\\webview\\" },
    "Windows 反斜杠写法同样是目录块（查询原样保留反斜杠，归一在写回正文时做）",
  );
  assert.deepStrictEqual(
    findTrigger("@/", 2),
    { kind: "mention", start: 0, query: "/" },
    "`@/` 是回到工作区根目录的目录块",
  );
  assert.deepStrictEqual(
    findTrigger("先看 @src/ 再继续", 6),
    { kind: "mention", start: 3, query: "src/" },
    "块后的空白把块切断：后面的字不属于查询",
  );
  assert.deepStrictEqual(
    findTrigger("先看 @src/ 再继续", 8),
    { kind: "mention", start: 3, query: "src/" },
    "光标紧贴块尾（分隔符右侧、那块空白左侧）仍在块内",
  );
  assert.strictEqual(
    findTrigger("先看 @src/ 再继续", 9),
    undefined,
    "光标越过块后的空白（进到下一段里）就不再是触发词",
  );

  // ---- (2) 带引号（含空白）的目录 token：引号是引用包装，判据看**语义路径** ----
  //
  // `formatFileMention` 给含空白的路径产出的就是 `@"my dir/"`：块要跨过那个空格
  // （否则块只剩 `"my`），查询串去掉引号（服务端要的是路径，不是 mention 语法），
  // 替换区间要覆盖闭引号（否则正文里会留半个引号）。
  {
    const quoted = '看一下 @"my dir/" 后面';
    for (const caret of [6, 7, 12, 14]) {
      assert.deepStrictEqual(
        findTrigger(quoted, caret),
        { kind: "mention", start: 4, query: "my dir/" },
        `带引号目录块内的光标 ${caret}：查询是整个块的语义路径（去掉引号）`,
      );
    }
    assert.strictEqual(
      findTrigger(quoted, 15),
      undefined,
      "光标越过块后的空白（闭引号之外、下一段里）就不再是触发词",
    );
    assert.deepStrictEqual(
      findTrigger('@"src\\webview\\"', 5),
      { kind: "mention", start: 0, query: "src\\webview\\" },
      "带引号的反斜杠目录同样算（语义路径以 `\\` 结尾）",
    );
    assert.deepStrictEqual(
      findTrigger('@"user@host dir/"', 8),
      { kind: "mention", start: 0, query: "user@host dir/" },
      "引号块里的 `@`（用户名那种）不是触发点：整块仍归开头那个 `@`",
    );
    // 引号块**可以含空白**，于是里面也可能出现「空白之后的 `@`」（`@"my @scope/"`）：
    // 先认外层那个完整 token，内部 `@` 就不能抢起点。逐个光标位置回归——
    // 尤其紧贴内部 `@` 右侧那一格（旧实现正是在那里把整块切成 `scope/"`，于是目录块
    // 当场不再触发）。
    {
      const inner = '看 @"my @scope/" 后面';
      for (const caret of [4, 8, 11, 14, 15]) {
        assert.deepStrictEqual(
          findTrigger(inner, caret),
          { kind: "mention", start: 2, query: "my @scope/" },
          `引号块内出现「空白 + @」时，光标 ${caret} 仍归外层完整 token（内部 @ 不抢起点）`,
        );
      }
      assert.strictEqual(
        findTrigger(inner, 16),
        undefined,
        "光标越过引号块后的空白：内部 `@` 也不许在中途补一个起点出来",
      );
    }
    assert.deepStrictEqual(
      findTrigger('看一下 @"my a.ts"', 7),
      { kind: "mention", start: 4, query: "my a.ts" },
      "带引号的**文件**同样触发（查询是去掉引号的语义路径）：弹不弹由宿主判——盘上有就抑制",
    );
    assert.strictEqual(
      findTrigger('看一下 @"my dir/"后面', 15),
      undefined,
      "闭引号后紧贴着别的字：光标进到那一段里不弹",
    );
    assert.strictEqual(
      findTrigger('看一下 @"my dir/', 13),
      undefined,
      "没有闭引号的半截引号退回按空白切块（块只到 `\"my`），光标在块外 → 不算触发词",
    );
    assert.strictEqual(findTrigger('@""', 1), undefined, "成对空引号不算裸 `@`，也没有内容可言 → 不触发");
    assert.strictEqual(findTrigger('@""', 3), undefined, "光标在成对空引号的闭引号之后同样不触发");
  }

  // ---- 有内容的块一律触发：查询串就是整个块，弹不弹由宿主判 ----
  //
  // 用户 2026-10-11 口径：**块本身已经是一条能引用到内容的引用**（文件在盘上 / 对话
  // 引用指向的会话还在）时不弹，否则就要弹。判据只有宿主给得出（要查盘、查会话列表），
  // 所以这里只管把块认出来、把整块当查询串（见 `useCompletion` 的抑制门与
  // `scripts/mentionResolve.test.ts`）。
  //
  // 头两条是父代理用真实输入实测过的现场（`fill('@src/file.ts')` 整串填完后光标在末尾；
  // `@src/webview/` 把光标用 Home + 右方向键挪到块中间，旧实现发的是光标前半截
  // `"src/"`）——这里按真实输入与真实光标位置各钉一条。
  assert.deepStrictEqual(
    findTrigger("@src/file.ts", 13),
    { kind: "mention", start: 0, query: "src/file.ts" },
    "整串 `@src/file.ts` 填完（光标在末尾）：块触发、查询是整块（盘上有这个文件 → 宿主抑制）",
  );
  assert.deepStrictEqual(
    findTrigger("@src/webview/", 5),
    { kind: "mention", start: 0, query: "src/webview/" },
    "`@src/webview/` + Home + 右方向键 5 次（光标在块中间）→ 查询仍是整个块",
  );
  assert.deepStrictEqual(
    findTrigger("看一下 @src/webview", 19),
    { kind: "mention", start: 4, query: "src/webview" },
    "没有尾分隔符的路径同样触发（盘上没有这个路径时列表就要弹）",
  );
  assert.deepStrictEqual(
    findTrigger("看一下 @src/webview", 8),
    { kind: "mention", start: 4, query: "src/webview" },
    "把光标移进这个块里也一样（查询串与光标位置无关）",
  );
  assert.deepStrictEqual(
    findTrigger("看一下 @web", 7),
    { kind: "mention", start: 4, query: "web" },
    "普通查询（会话 id / 名字片段）走同一条：这是服务端筛对话的入口",
  );
  assert.deepStrictEqual(
    findTrigger("看一下 @src/a.ts", 12),
    { kind: "mention", start: 4, query: "src/a.ts" },
    "已引用的文件：光标移进去仍触发，由宿主按「盘上有」抑制",
  );
  assert.deepStrictEqual(
    findTrigger("@[标题](dsh-session:s1)", 3),
    { kind: "mention", start: 0, query: "[标题](dsh-session:s1)" },
    "已引用的对话：同上（宿主按「会话还在」抑制）",
  );
  assert.deepStrictEqual(
    findTrigger("看一下 @src/a.ts#L12-L40", 20),
    { kind: "mention", start: 4, query: "src/a.ts#L12-L40" },
    "带行号区间的引用：整块（含区间）就是查询串——宿主判存在性时自己去区间",
  );
  assert.strictEqual(
    findTrigger("看一下 @src/my file.ts", 12),
    undefined,
    "含空格的手写路径被空白切成 `@src/my` 那一段：光标 12 已经越过块（块到空白为止）→ 不算触发词",
  );
  assert.deepStrictEqual(
    findTrigger("看一下 @src/my file.ts", 10),
    { kind: "mention", start: 4, query: "src/my" },
    "同一段里光标落在块内：触发，查询就是这一块（含空格的路径本来就该写成带引号形态）",
  );

  // ---- 边界：`@` 必须落在行首或空白之后 ----
  assert.strictEqual(findTrigger("看@src/", 6), undefined, "`@` 紧贴汉字不算触发词（边界是行首或空白）");
  assert.strictEqual(findTrigger("mail@example.com 之后", 20), undefined, "`@` 后面跟着空白就不再是触发词");
  assert.strictEqual(findTrigger("@a b", 4), undefined, "块在空白处结束，光标在下一段里不算触发词");
  assert.strictEqual(findTrigger("草稿", 2), undefined, "没有触发词");

  // ---- 邻近多个 `@`：光标所在块的那个赢，且**不许**退回更早的目录块 ----
  {
    const nearby = "看 @a/ @b/";
    assert.deepStrictEqual(
      findTrigger(nearby, nearby.length),
      { kind: "mention", start: 6, query: "b/" },
      "邻近多个 `@`：认离光标最近（且含光标）的那个块",
    );
    assert.deepStrictEqual(
      findTrigger(nearby, 5),
      { kind: "mention", start: 2, query: "a/" },
      "光标在前一个块里就认前一个",
    );
    assert.deepStrictEqual(
      findTrigger("看 @a/ @b", 8),
      { kind: "mention", start: 6, query: "b" },
      "光标在后一个块里就认它（它是普通块，一样触发）——绝不退回前面那个目录块",
    );
    assert.deepStrictEqual(
      findTrigger("看 @node_modules/@types/", 23),
      { kind: "mention", start: 2, query: "node_modules/@types/" },
      "路径里的 `@`（`@types`）不是触发点：整块仍归那个行首/空白后的 `@`",
    );
    for (const caret of [17, 19]) {
      assert.deepStrictEqual(
        findTrigger("看 @node_modules/@types/", caret),
        { kind: "mention", start: 2, query: "node_modules/@types/" },
        `光标 ${caret} 紧贴/落在内部 \`@\` 那一段里：起点仍是外层那个 \`@\``,
      );
    }
    const mixed = '看 @"a b/" @c/';
    assert.deepStrictEqual(
      findTrigger(mixed, 5),
      { kind: "mention", start: 2, query: "a b/" },
      "邻近多个 `@`：前一个是带引号目录块时，光标在块里就认它",
    );
    assert.deepStrictEqual(
      findTrigger(mixed, 13),
      { kind: "mention", start: 10, query: "c/" },
      "光标在后一个块里就认后一个",
    );
  }

  // ---- 光标在中间的命令：只看光标**之前**的文本 ----
  assert.strictEqual(
    findTrigger("/plan 后面还有字", 6),
    undefined,
    "光标已经越过命令名与空格 → 不算触发词",
  );
  assert.deepStrictEqual(
    findTrigger("/plan 后面还有字", 5),
    { kind: "command", start: 0, query: "plan" },
    "光标还在命令名末尾时仍是触发词",
  );
  // 一段文本里两个触发词：**离光标最近的那个**赢
  assert.deepStrictEqual(
    findTrigger("先写 /pl 再看 @src/", 12),
    { kind: "mention", start: 10, query: "src/" },
    "光标在第二个 `@` 的目录块里 → 走提及通道（不是前面那个 `/pl`）",
  );
  assert.deepStrictEqual(
    findTrigger("先写 /pl 再看 @src/", 6),
    { kind: "command", start: 3, query: "pl" },
    "光标回到 `/pl` 末尾时走命令通道",
  );
}
console.log("completion: 触发词判定（`/` 行首不变；`@` 认整块，弹不弹由宿主判） ✓");

// ---------- 8b. `/` 前界与包装标点：扫描 / 触发 / 点击共用同一条规则 ----------
//
// 用户报障：`(/plan)` 在正文里蓝且可点（扫描允许左括号），点开却拿不到菜单——
// `findTrigger` 只认行首或空白，range 末尾重扫得到 null。两端必须同一条前界：
// 行首、空白与句子的包装标点（引号 / 方括号 / 中文书名号 / markdown 的 ** 等）；
// 单词、路径、URI、盘符、UNC、mention 与下划线包装都不算（`_` 是合法命令字符）。
// 后界仍是「完整命令名」：扩展名 / 子路径 / 名字后续字符都不能切一半。
{
  const plan: CommandView = { name: "plan", description: "计划模式" };
  const wrapped: Array<[string, number, number]> = [
    ["(/plan)", 6, 1],
    ["（/plan）", 6, 1],
    ["( /plan", 7, 2],
    ["【/plan】", 6, 1],
    ["「/plan」", 6, 1],
    ["『/plan』", 6, 1],
    ["《/plan》", 6, 1],
    ["[/plan]", 6, 1],
    ["{/plan}", 6, 1],
    ['"/plan"', 6, 1],
    ["'/plan'", 6, 1],
    ["`/plan`", 6, 1],
    ["**/plan**", 7, 2],
    ["“/plan”", 6, 1],
  ];
  for (const [text, caret, start] of wrapped) {
    assert.deepStrictEqual(
      findTrigger(text, caret),
      { kind: "command", start, query: "plan" },
      `包装标点旁的 /plan 必须触发命令通道：${text}`,
    );
  }

  // 点击路径同源：扫描出的区间末尾正是触发词末尾（`(/plan)` 后面那个 `)` 不属于 token）。
  const clicked = "先看 (/plan) 再继续";
  const clickedSpan = scanCommandLinks(clicked, [plan])[0];
  assert.ok(clickedSpan, "前提：扫描能认出 `(/plan)`");
  assert.deepStrictEqual(
    findTrigger(clicked, clickedSpan.end),
    { kind: "command", start: clickedSpan.start, query: "plan" },
    "点击区间末尾重扫仍要得到同一个触发词（旧实现只认空白，重扫得 null）",
  );
  assert.strictEqual(clickedSpan.end, clicked.indexOf("/plan") + "/plan".length, "区间不含右括号");

  // 输入补全仍容许未匹配前缀 / 未知查询：这里不做目录过滤，只负责认出触发词。
  assert.deepStrictEqual(findTrigger("【/pl", 5), { kind: "command", start: 1, query: "pl" }, "包装标点里的部分前缀仍触发");
  assert.deepStrictEqual(findTrigger("(/zzz", 5), { kind: "command", start: 1, query: "zzz" }, "未知查询仍交给候选过滤（不能在这里禁掉补全）");
  assert.deepStrictEqual(findTrigger("(/", 3), { kind: "command", start: 1, query: "" }, "左括号后刚敲下 / 就要弹");

  const rejected: Array<[string, string]> = [
    ["https://host/plan", "URI 路径里的 /plan"],
    ["file:///C:/plan", "file URI 里的 /plan"],
    ["C:/plan", "盘符路径里的 /plan"],
    ["\\\\server\\share/plan", "UNC 路径里的 /plan"],
    ["src/plan", "相对路径里的 /plan"],
    ["./plan", "当前目录路径里的 /plan"],
    ["../plan", "父目录路径里的 /plan"],
    ["word/plan", "单词之后的 /plan"],
    ["__/plan", "下划线是合法命令字符，不能当下划线包装"],
    ["//plan", "双斜杠"],
    ["/plan mode", "命令参数之后"],
    ["(/plan mode)", "包装标点里的命令参数之后"],
  ];
  for (const [text, message] of rejected) {
    assert.strictEqual(findTrigger(text, text.length), undefined, `${message}不得触发：${text}`);
  }
  // `@/plan` 走 mention 通道（不是命令）：同一条前界白名单里没有 `@`，所以命令分支
  // 不会接它；但 `@` 自己的内容块判定仍要把它认成 mention。
  assert.deepStrictEqual(
    findTrigger("@/plan", 6),
    { kind: "mention", start: 0, query: "/plan" },
    "mention 的 @/ 路径仍归 mention 通道，不能被命令通道抢走",
  );
}
console.log("completion: 命令前界（包装标点允许；单词 / 路径 / URI / 参数不误触发） ✓");

// ---------- 9. 弹层可见性 ----------
{
  assert.strictEqual(popoverVisible(undefined, 3), false, "没有触发词就没有弹层");
  assert.strictEqual(
    popoverVisible({ kind: "mention", start: 0, query: "" }, 0),
    true,
    "`@` 空结果也要给「没有文件」的提示",
  );
  assert.strictEqual(
    popoverVisible({ kind: "command", start: 0, query: "zzz" }, 0),
    false,
    "命令没有匹配项就不弹（否则一个空框挂在那里）",
  );
  assert.strictEqual(popoverVisible({ kind: "command", start: 0, query: "zzz" }, 2), true);
  // 还没有工作目录时两个菜单都必然是空的（那时连空壳会话都建不出来，宿主没有会话可查，
  // 见 controller 的 `ensureSession`）：这时必须弹，否则「未选择工作区」这句解释没地方说，
  // 用户看到的就是「输入 / 什么都没发生」（用户 2026-09-24 报的现场）。
  assert.strictEqual(
    popoverVisible({ kind: "command", start: 0, query: "" }, 0, true),
    true,
    "还没有工作目录时 `/` 也要弹（用来说清为什么没有命令）",
  );
  assert.strictEqual(
    popoverVisible({ kind: "mention", start: 0, query: "" }, 0, true),
    true,
    "还没有工作目录时 `@` 照常弹（换成「未选择工作区」那句）",
  );
}
console.log("completion: 弹层何时出现 ✓");

/* ================= hook 的行为（真实渲染，事件走假对象） ================= */

/**
 * `react-dom/server` 不执行 passive effect（`useEffect` 只在浏览器提交阶段跑）。
 *
 * 但「点击链接之后 commandRequest 的 effect 真的改写草稿 / 落光标 / 开菜单」正是
 * 这一轮要钉的链路，只调 `commandMenuDraft` + 再渲染一帧会把 effect 整段跳过。
 * 于是渲染期间把 React 的当前 dispatcher 上的 `useEffect` 换成一个**收集器**：
 * 组件照常按 hook 规则登记，回调攒在这一帧上，由 `flushEffects` 在渲染结束后
 * 手动执行（此时闭包、ref 与假 `setState` 都是真的，只有「浏览器何时调用它」被
 * 换成了测试驱动）。
 *
 * 只替换 `useEffect`：`useLayoutEffect` 在 server 上本来就是 no-op，本文件另有
 * 断言（候选滚动）走元素 props，不需要它。
 */
interface EffectDispatcher {
  useEffect?: (create: () => void | (() => void), deps?: readonly unknown[]) => void;
}

const REACT_INTERNALS = (
  ReactRuntime as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: {
      ReactCurrentDispatcher?: { current?: EffectDispatcher };
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

function captureEffects(effects: Array<() => void>): () => void {
  const dispatcher = REACT_INTERNALS?.ReactCurrentDispatcher?.current;
  if (!dispatcher) return () => {};
  const original = dispatcher.useEffect;
  dispatcher.useEffect = (create) => {
    effects.push(() => {
      create();
    });
  };
  return () => {
    dispatcher.useEffect = original;
  };
}

/** 执行这一帧捕获到的全部 passive effect（= 浏览器提交后的那一次）。 */
function flushEffects(frame: Frame): void {
  for (const effect of frame.effects.splice(0, frame.effects.length)) effect();
}

/** 假文本域节点：只带 hook 会读 / 会写的字段，并记下最后一次落光标的位置。 */
function fakeTextarea(value: string, caret: number) {
  const node = {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    focused: 0,
    lastSelection: undefined as number | undefined,
    focus() {
      node.focused += 1;
    },
    setSelectionRange(start: number) {
      node.lastSelection = start;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return node;
}
type FakeTextarea = ReturnType<typeof fakeTextarea>;

/** 一帧可变状态：`draft` / `caret` 由事件改、由下一次渲染读。 */
interface Frame {
  draft: string;
  caret: number;
  written: string[];
  posted: string[];
  /** 当前这一帧渲染出来的弹层 HTML 与文本域 prop。 */
  html: string;
  /**
   * 这一帧返回的**弹层 React 元素**（未渲染）。
   *
   * `html` 只看得见渲染结果——挂在行上的事件处理器不会出现在里面，而「悬停改高亮」
   * 这一类接线恰恰只在 props 上（第 16 节的回归锁要用它）。
   */
  popoverNode: ReactNode;
  props: ReturnType<typeof useComposerCompletion>["textareaProps"];
  node: FakeTextarea;
  /** 这一帧登记、尚未执行的 passive effect（由 `flushEffects` 手动驱动）。 */
  effects: Array<() => void>;
  /** 假 `useState` 的状态表（跨帧保留走它）。 */
  store: Map<number, unknown>;
}

const FILES: FileRefView[] = [
  { path: "src/dsh", kind: "directory" },
  { path: "a.txt", kind: "file" },
  { path: "src/webview", kind: "directory" },
];
const SESSIONS: SessionRefView[] = [
  { sessionId: "s1", label: "上一个会话", mention: "@[上一个会话](dsh-session:s1)" },
];
const COMMANDS: CommandView[] = [
  { name: "plan", description: "计划模式" },
  { name: "zerocandidate", description: "" },
];

/**
 * 把 hook 渲染出来（不挂 DOM），把返回的 prop 收到 `frame` 上。
 *
 * 状态钩子换成「挂在同一个 map 上、跨渲染保留」的假 `useState`：`react-dom/server`
 * 的渲染不重放状态更新（`setState` 排队后就结束），不换的话弹层永远停在第一帧，
 * 「事件 → 下一帧」这条链就没法断言。同一帧里连续调两次（`ArrowDown` 两次）会像
 * React 一样**累计**（`setHighlight((v) => v + 1)` 走的是函数式更新）；要跨帧保留
 * 同一个 map，走 `nextFrame`。
 *
 * `overrides` 用来覆盖入参（例如断言「宿主下发的插入请求」那一支）。
 */
function frame(
  draft: string,
  caret: number,
  overrides: Partial<UseComposerCompletionInput> = {},
  store = new Map<number, unknown>(),
): Frame {
  const node = fakeTextarea(draft, caret);
  let slot = 0;
  const out: Frame = {
    draft,
    caret,
    written: [],
    posted: [],
    html: "",
    popoverNode: null,
    node,
    effects: [],
    store,
    props: {} as Frame["props"],
  };
  const fakeState: ComposerCompletionStateHook = <T,>(initial: T | (() => T)) => {
    const key = slot++;
    if (!store.has(key)) {
      store.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    }
    const set = (next: SetStateAction<T>) => {
      const current = store.get(key) as T;
      store.set(key, typeof next === "function" ? (next as (prev: T) => T)(current) : next);
      return undefined;
    };
    return [store.get(key) as T, set as Dispatch<SetStateAction<T>>];
  };

  let captured: ReturnType<typeof useComposerCompletion> | undefined;
  function Probe() {
    // 只在本组件跑 hook 的这段时间里换掉 dispatcher 的 `useEffect`：回调攒到
    // `out.effects`，跑完立即还原，后续渲染弹层元素不受影响。
    const restore = captureEffects(out.effects);
    try {
      captured = useComposerCompletion({
        draft,
        caret,
        commands: COMMANDS,
        // `fileRefs.query` 是**服务器那次查询的查询串**（`files/list` 帧带回来的那一个），
        // 对 `@` 块就是整块的查询串——与真实宿主同形。界面按它判「这一帧是不是这一层的」
        // （旧帧的文件行不许充当这一层的候选），所以夹具不能拿整份草稿当查询串。
        fileRefs: {
          query: findTrigger(draft, caret, undefined)?.query ?? "",
          items: FILES,
          sessions: SESSIONS,
        },
        texts: TEXTS,
        onDraft: (text) => {
          out.draft = text;
          out.written.push(text);
        },
        textareaRef: { current: node as unknown as HTMLTextAreaElement },
        ...overrides,
      });
    } finally {
      restore();
    }
    return null;
  }
  // 状态钩子经 context 注入（见 frame 的注释）。
  //
  // 渲染分两步：先把 Probe 渲一遍（hook 真的跑，返回的 prop 收下来），再**单独**
  // 把它这一帧返回的弹层元素渲成 HTML。一步走完有个坑：这个 Probe 里有
  // `useLayoutEffect`，`renderToStaticMarkup` 会把「带 effect 的组件的返回值」
  // 丢掉（实测 html 为空串，而 `captured.popover` 明明是合法元素）。单独渲那个
  // 元素既稳、又正好只断言「弹层这一帧是什么样」。
  //
  // server 渲染还会对 `useLayoutEffect` 打一句 warning（它本来就不在 server 上跑，
  // 这里只是为了把 hook 跑起来）。它会淹掉断言输出，所以渲染期间临时静音——
  // 只静音这一句，其它 error 照旧打到 stderr。
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (first.includes("useLayoutEffect does nothing on the server")) return;
    realError(...args);
  };
  try {
    renderToStaticMarkup(
      createElement(ComposerCompletionState.Provider, { value: fakeState }, createElement(Probe)),
    );
  } finally {
    console.error = realError;
  }
  assert.ok(captured, "hook 没被渲染（Probe 写错了？）");
  out.html = captured.popover ? renderToStaticMarkup(captured.popover) : "";
  out.popoverNode = captured.popover;
  out.props = captured.textareaProps;
  return out;
}

/** 假键盘事件：只带 hook 会读的字段，并记下「被消费了吗」。 */
function press(frame: Frame, key: string, extra: Record<string, unknown> = {}) {
  const calls = { prevented: 0, stopped: 0 };
  const event = {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    nativeEvent: { isComposing: false },
    currentTarget: frame.node as unknown as HTMLTextAreaElement,
    preventDefault: () => {
      calls.prevented += 1;
    },
    stopPropagation: () => {
      calls.stopped += 1;
    },
    ...extra,
  };
  frame.props.onKeyDown?.(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
  return calls;
}

/**
 * 按一次键并交出这一动作发给宿主的帧（`post`）。
 *
 * 「一次导航只写一条草稿、导航本身不发查询帧」这类计数断言读它：`queryFiles` 的重取点
 * 只有查询串那个 effect 一处（第 19 节钉住它的依赖数组），effect 在无头渲染里不跑，
 * 这里能观察的是**动作本身**有没有自己再发一遍（或写两遍草稿）。
 */
function pressAndPost(frame: Frame, key: string): Array<Record<string, unknown>> {
  POSTED.length = 0;
  press(frame, key);
  return POSTED.splice(0, POSTED.length);
}

/**
 * 假焦点事件：焦点**重新进入**输入框（`onFocus`）。
 *
 * 只带 hook 会读的两个字段：`currentTarget.value` 与 `selectionStart`——用户「点回输入框」
 * 时这两样就是那一刻的草稿与光标，而 `onFocus` 正是拿它们重算触发词的。
 */
function focus(frame: Frame) {
  frame.props.onFocus?.({
    currentTarget: frame.node as unknown as HTMLTextAreaElement,
  } as unknown as FocusEvent<HTMLTextAreaElement>);
}

/** 「事件 → 重新渲染」：用当前的 draft / caret 再渲染一帧（模拟 React 的下一帧）。 */
function nextFrame(prev: Frame, overrides: Partial<UseComposerCompletionInput> = {}): Frame {
  return frame(
    prev.draft,
    prev.caret,
    { insertRequest: undefined, ...overrides },
    prev.store,
  );
}

/**
 * **真的敲一次字**：改假文本域里的值与光标，调一次 `onChange`（草稿两次写 + 按新文本
 * 重算触发词），再用同一个状态表渲下一帧。
 *
 * 与 `frame(draft, caret, …, prev.store)` 的区别：那个只换输入，**触发词仍停在上一帧**
 * （`useState` 的初值只在第一次渲染时算）——「敲字之后查询串变了」这条链路只有真调一次
 * 编辑事件才走得出来。
 */
function typeAt(
  prev: Frame,
  text: string,
  caret: number,
  overrides: Partial<UseComposerCompletionInput> = {},
): Frame {
  prev.node.value = text;
  prev.node.selectionStart = caret;
  prev.node.selectionEnd = caret;
  prev.props.onChange?.({
    target: prev.node as unknown as HTMLTextAreaElement,
  } as unknown as ChangeEvent<HTMLTextAreaElement>);
  return frame(text, caret, overrides, prev.store);
}

/**
 * 弹层元素树里候选行**主体按钮**（`.popover-item-hit`）的 props，按行顺序。
 *
 * 挂在行上的事件处理器不会出现在 `html` 里（见 `Frame.html` 的注释），而「点这一行
 * 会发生什么」只能真调一次那个处理器才知道，所以这里把 props 抠出来。
 */
function hitPropsOf(node: ReactNode): Array<Record<string, unknown>> {
  const hits: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const props = (value as { props?: Record<string, unknown> }).props;
    if (!props) return;
    if (typeof props.className === "string" && props.className.split(/\s+/u).includes("popover-item-hit")) {
      hits.push(props);
    }
    visit(props.children);
  };
  visit(node);
  return hits;
}

// ---------- 10. 草稿的两次写 + 光标在 rAF 里落 ----------
//
// 顺序与内容都是契约：先 `onDraft`（界面立刻变），再 `post({type:"setDraft"})`
// （换会话 / 重载后草稿还在）。少哪一个都会静默丢草稿。
//
// 落光标必须在 `requestAnimationFrame` 里：同步改 textarea 会有两种表现——
// 要么被 React 这次重渲染按新 prop 顶掉（光标跑回原处），要么在受控 textarea 上
// 被 React 拒绝。所以这里既断言「排了 rAF」，也放行后断言「真的落到了插入内容之后」。
//
// 列表的入口用裸 `@`（新口径的第 (1) 条）：根目录那一层没有 `..`，第 0 条候选就是
// `src/dsh` 目录，Enter（pick）与下钻写出的是同一个 `@src/dsh/`。
{
  const f = frame("看看 @", 4);
  assert.ok(f.html.includes("a.txt"), "`a.txt` 有候选，弹层应当渲染出来");
  assert.deepStrictEqual(f.posted, [], "渲染本身不该发帧");

  press(f, "Enter"); // 弹层打开时 Enter = 选中第一条（pick）
  assert.deepStrictEqual(f.written, ["看看 @src/dsh/"], "本地 state 立刻拿到替换后的草稿（两次写的第一写）");
  assert.strictEqual(f.node.lastSelection, undefined, "落光标**不许同步做**（要给 React 留出重渲染那一帧）");
  assert.strictEqual(RAF_QUEUE.length, 1, "落光标必须排在 requestAnimationFrame 里");
  assert.strictEqual(flushRaf(), 1, "下一帧真的跑了那个回调");
  assert.strictEqual(f.node.lastSelection, "看看 @src/dsh/".length, "光标落在插入内容之后");
  assert.strictEqual(f.node.focused, 1, "落光标前要把焦点还给输入框");
  assert.ok(f.html.includes("popover-item"), "这一帧的弹层是旧的（新状态要下一次渲染才生效）");
}
console.log("completion(hook): 选完立刻写回草稿 + 光标在 rAF 里落 ✓");

// ---------- 11. 选完先 dismissed 一次，弹层不立刻重开 ----------
//
// 没有这条记忆时，选完那次 keyup 的重新探测会在同一个位置再命中目录块，弹层关了又弹
// （用户看到「列表闪一下」）。
{
  const first = frame("看看 @", 4);
  assert.ok(first.html.includes("popover-item"), "前提：弹层开着");
  press(first, "Enter");
  assert.strictEqual(first.draft, "看看 @src/dsh/");

  const after = nextFrame(first);
  assert.strictEqual(after.html, "", "选完之后同一个位置不许再弹（否则就是「按回车列表闪一下」）");
  assert.ok(!after.html.includes("popover-item"));

  // 光标真的动了（记忆失效）→ 允许重新打开：新位置在目录块里，本来就该开着
  const moved = frame("看看 @src/dsh/", 6);
  assert.ok(moved.html.includes("popover-item"), "光标挪进 `@` 里就是新的编辑动作，弹层该回来");
}
console.log("completion(hook): 「刚选完先别重开」的记忆 ✓");

// ---------- 11b. 焦点重新进入输入框 = 新的编辑动作（用户 2026-10-11 报的现场） ----------
//
// 现场：从输入框外点回来、光标落在能触发的 `@` 块里 → 列表不出来；而光标已经在框里、
// 再挪一下（位置变了）就出来了。
//
// 根因是两件事叠在一起，所以这条同时钉两边：
// - 触发词只在事件里重算（`findTrigger`），焦点回来（点进来、宿主把焦点还回来）本身
//   不重算 → 一帧都不弹；
// - 「已关闭」记忆按（文本, 光标）匹配，而点回来时位置常常一个字没动（点在文本右侧的
//   空白处就是末尾那一格）→ 那次探测直接返回，跟没重算一样。
{
  // 浏览入口（目录块）：ESC 关掉 → 同位置 keyup 不重开（既有口径）→ 焦点回来必须重开
  const dir = frame("@src/webview/", 13);
  assert.ok(dir.html.includes("popover-item"), "前提：目录块里列表开着");
  press(dir, "Escape");
  const dirClosed = nextFrame(dir);
  assert.strictEqual(dirClosed.html, "", "ESC 之后同位置的 keyup 不许重开（既有口径不变）");
  focus(dirClosed);
  assert.ok(
    nextFrame(dirClosed).html.includes("popover-item"),
    "焦点回到输入框 → 重算触发词 + 清掉「已关闭」记忆：列表该回来",
  );

  // 会话检索块（普通块）同理——它是这次报障的正题。判定已经在状态里（`resolved: false`），
  // 所以焦点回来这一帧就该弹，不用等新的帧。
  const refs = { query: "session-4be424ed", items: [], sessions: SESSIONS, resolved: false };
  const search = frame("看看 @session-4be424ed", 20, { fileRefs: refs });
  assert.ok(search.html.includes("popover-item"), "前提：会话检索块里列表开着");
  press(search, "Escape");
  const searchClosed = frame("看看 @session-4be424ed", 20, { fileRefs: refs }, search.store);
  assert.strictEqual(searchClosed.html, "", "ESC 之后同一个位置不重开");
  focus(searchClosed);
  assert.ok(
    frame("看看 @session-4be424ed", 20, { fileRefs: refs }, searchClosed.store).html.includes("popover-item"),
    "焦点回到输入框 → 会话检索列表重新弹出来（用户报的「从框外回来不弹」）",
  );

  // 焦点回来时**光标不在任何块里**（比如草稿末尾是普通文字）：不许凭空弹一个列表
  const outside = frame("看看 @src/webview/ 后面", 24);
  assert.ok(outside.html.includes("popover-item") === false, "前提：光标在块外，本来就没弹");
  focus(outside);
  assert.strictEqual(nextFrame(outside).html, "", "焦点回来也不许给「光标不在块里」的草稿弹列表");
}
console.log("completion(hook): 焦点回输入框 = 新编辑动作（清「已关闭」记忆 + 重算触发词） ✓");

// ---------- 12. ESC 优先级链：先关弹层并 stopPropagation ----------
//
// 不 `stopPropagation` 的话，这次 ESC 会落到 App 的 window 层兜底监听上——
// 用户只是想关掉候选列表，结果把正在跑的那一轮中止了。
{
  const f = frame("@src/", 5);
  assert.ok(f.html.includes("popover"), "前提：弹层开着");

  const calls = press(f, "Escape");
  assert.strictEqual(calls.prevented, 1, "ESC 要 preventDefault（不让浏览器再处理一次）");
  assert.strictEqual(calls.stopped, 1, "ESC 要 stopPropagation：不能把正在跑的那一轮中止了");
  assert.deepStrictEqual(f.written, [], "关弹层不改草稿、不写回");

  const after = nextFrame(f);
  assert.ok(!after.html.includes("popover-item"), "ESC 之后的 keyup 不许把列表弹回来");

  // ESC 只吃「弹层打开」那一次：弹层没开时不许拦（否则 App 的 ESC 停止生成会失灵）
  const closed = frame("普通草稿", 4);
  const closedCalls = press(closed, "Escape");
  assert.deepStrictEqual(closedCalls, { prevented: 0, stopped: 0 }, "弹层没开时 ESC 一律放行");
}
console.log("completion(hook): ESC 优先级链（弹层先消费、其余放行） ✓");

// ---------- 13. Enter / Tab 的接线（走真实事件链） ----------
//
// `pick` 与 `drill` 的**判据**在第 7 节用纯函数钉死了；这里钉接线：Enter 与 Tab 真的
// 分别落到那两条动作上（此前这一条是读源码的正则 `/applyCandidate\(highlight, "drill"\)/`）。
//
// 两次都让 highlight 停在 0（不做键盘导航）：上面那个「触发词变化时把高亮复位」
// 的 effect 会在重新渲染那一帧把导航结果抹掉（真实 React 里会另有一次渲染把它花掉），
// 而第 0 条候选本来就够用——`..` 那行验 pick、裸 `@` 的第一条（目录）验 drill。
{
  const start = frame("@src/webview/", 13);
  // 列表第一行是 `..`（回到上一层），它的悬停标题是解析出来的**完整目标**（这里没有
  // cwd，退回展示路径本身），按钮上的动作说明仍走词典
  assert.ok(
    /class="popover-item-main is-priority" title="src\/">\.\.</.test(start.html),
    "顶部第一条是「..」，悬停标题给上一层目标",
  );
  assert.ok(start.html.includes(TEXTS.mentionParent), "「..」那行的动作说明（按钮 title）走词典");

  // Enter（pick）在「..」行 = 回到上一层：正文只留 `@<上一层>`
  const enterFrames = pressAndPost(start, "Enter");
  assert.strictEqual(start.draft, "@src/", "「..」= 回到上一层（正文只留上一层的查询串）");

  // Tab（drill）落在同一行 = **与 Enter 同一个结果**：正文一样、发给宿主的帧一样，
  // 且一次导航只写一次草稿、不发查询帧、不落成发送。
  {
    const sent: string[] = [];
    const tabUp = frame("@src/webview/", 13, { onSubmit: (gesture) => sent.push(gesture) });
    const tabFrames = pressAndPost(tabUp, "Tab");
    assert.strictEqual(tabUp.draft, start.draft, "Tab 与 Enter 结果一致：也回上一层");
    assert.deepStrictEqual(tabFrames, enterFrames, "两把键发给宿主的帧逐字相同（不许重复写 / 重复查询）");
    assert.deepStrictEqual(tabFrames, [{ type: "setDraft", text: "@src/" }], "一次回上一层只写一条草稿帧，不发 queryFiles");
    assert.deepStrictEqual(sent, [], "回上一层不发送（这一键由弹层接管）");
    assert.strictEqual(flushRaf() >= 1, true, "落光标同样排在 rAF 里");
    assert.strictEqual(tabUp.node.lastSelection, "@src/".length, "光标落在写回的查询串之后");
  }

  // Tab（drill）在目录行 = 下钻：正文换成该目录的查询串（根目录那一层没有 `..`，
  // 所以第 0 条就是目录；入口只能是裸 `@`——普通查询已经不再弹列表）
  const tabbed = frame("@", 1);
  press(tabbed, "Tab");
  assert.strictEqual(tabbed.draft, "@src/dsh/", "Tab 下钻：正文变成目录查询串（继续留在候选态）");
  assert.strictEqual(tabbed.node.lastSelection, undefined, "下钻的落光标同样在 rAF 里（不许同步做）");
  assert.ok(flushRaf() >= 1, "至少排了一个 rAF 回调（前面几节的 Enter 也会各排一个）");
  assert.strictEqual(tabbed.node.lastSelection, "@src/dsh/".length, "光标落在新查询串之后");
}
console.log("completion(hook): Enter / Tab 的接线 ✓");

// ---------- 13b. 引用文本的归一化（用户 2026-09-21 口径） ----------
//
// 两条口径：「引用进目录时，将 `\` 统一换成 `/`」「引进带空格目录时，只有头部有引号、
// 尾部没有」。判据本身在 `shared/mentions.ts`（逐字断言见 `scripts/references.test.ts`），
// 这里钉的是**两个写入口真的都归一了**：
// - 下钻 / 回上一层是**直接改正文**（不走 token 生成），必须自己调 `normalizeMentionPath`；
// - 选中（pick）走 `formatFileMention`，引号成对与分隔符归一都在那里。
{
  // 候选路径来自 Windows 侧（反斜杠）时，下钻写进正文的必须是正斜杠
  const winDir: FileRefView[] = [{ path: "src\\dsh", kind: "directory" }];
  const drilled = frame("@", 1, { fileRefs: { query: "", items: winDir, sessions: [] } });
  press(drilled, "Tab");
  assert.strictEqual(drilled.draft, "@src/dsh/", "下钻：候选里的反斜杠要归一（不许写成 `@src\\dsh/`）");

  // 「..」那行同理：用户手输反斜杠时，上一层也要归一再写回正文
  const back = frame("@src\\dsh\\", 9, { fileRefs: { query: "@src\\dsh\\", items: winDir, sessions: [] } });
  assert.ok(back.html.includes(".."), "进到子目录后，「..」那行必须在");
  press(back, "Enter");
  assert.strictEqual(back.draft, "@src/", "回上一层：`src\\` 也要写成 `@src/`");

  // 选中带空格的目录：引号成对，且尾斜杠留在引号**内**（目录标记不能丢）
  const spaced: FileRefView[] = [{ path: "docs\\my dir", kind: "directory" }];
  const picked = frame("@", 1, { fileRefs: { query: "", items: spaced, sessions: [] } });
  press(picked, "Enter");
  assert.strictEqual(picked.draft, '@"docs/my dir/"', "选中带空格目录：引号成对 + 分隔符归一");

  // 下钻 / 回上一层：含空白的目录同样要写带引号的查询形态。不带引号的话块会在空白处
  // 结束（`@my`），下钻当场掉出候选态——所以查询形态与选中形态共用同一份拼写规则。
  const spacedNested: FileRefView[] = [{ path: "my dir/sub", kind: "directory" }];
  const intoNested = frame("@", 1, { fileRefs: { query: "", items: spacedNested, sessions: [] } });
  press(intoNested, "Tab");
  assert.strictEqual(intoNested.draft, '@"my dir/sub/"', "下钻含空格目录：写回带引号的目录块");

  const backSpaced = frame('@"my dir/sub/"', 8, {
    fileRefs: { query: "my dir/sub/", items: [], sessions: [] },
  });
  assert.ok(backSpaced.html.includes(".."), "前提：进了子目录就有「..」那一行");
  press(backSpaced, "Enter");
  assert.strictEqual(
    backSpaced.draft,
    '@"my dir/"',
    "回到含空白的上一层：引号跟着保留（否则列表会掉出候选态）",
  );
  console.log("completion(hook): 引用文本归一化（分隔符 / 成对引号） ✓");
}

// ---------- 13c. 悬停标题 = 完整绝对路径（长路径被省略时的确认手段） ----------
//
// 工作区外的候选保留绝对 / `../` 前缀（见 docs/design-mentions.md「不增加「工作区外」
// 标签」：长路径的省略不得使目标无法确认）。候选行主体那个 span 的 `title` 就是完整
// 目标——解析基准是 `files/list` 帧下发的**会话 cwd**，所以界面自己合成的「上一层」行
// （`src/`、`../`、盘根回工作区那种空 path）也能算出来。没有 cwd（旧宿主）时退回原样的
// 展示路径，不猜。
{
  const absolute = { query: "D:/dev/other/", items: [{ path: "D:/dev/other/x.txt", kind: "file" as const }], sessions: [], cwd: "D:/dev/other" };
  const m1 = frame("@D:/dev/other/", 14, { fileRefs: absolute });
  assert.ok(
    m1.html.includes('title="D:/dev/other/x.txt"'),
    "工作区外的绝对路径候选：悬停标题就是那条完整路径",
  );

  const up = { query: "../", items: [{ path: "../x.txt", kind: "file" as const }], sessions: [], cwd: "D:/dev/other" };
  const m3 = frame("@../", 4, { fileRefs: up });
  assert.ok(
    m3.html.includes('title="D:/dev/x.txt"'),
    "`../` 形态的候选：拿会话 cwd 解析成完整绝对路径（否则只看到一个省略后的相对路径）",
  );

  const nested = frame("@src/webview/", 13, { fileRefs: { query: "src/webview/", items: [], sessions: [], cwd: "D:/dev/other" } });
  assert.ok(
    nested.html.includes('title="D:/dev/other/src"'),
    "界面自己合成的「上一层」行同样给出完整目标（它的 path 是相对的 `src/`）",
  );

  const driveRoot = frame("@D:/", 5, { fileRefs: { query: "D:/", items: [], sessions: [], cwd: "D:/dev/other" } });
  assert.ok(
    driveRoot.html.includes('title="D:/dev/other"'),
    "盘根的「上一层」回到工作区（空 path）：悬停标题就是会话 cwd 本身",
  );

  // 没有 cwd 时不猜：退回展示路径原样（`src/`），至少和行里显示的一致
  const noCwd = frame("@src/webview/", 13, { fileRefs: { query: "src/webview/", items: [], sessions: [] } });
  assert.ok(noCwd.html.includes('title="src/"'), "旧宿主不发 cwd 时悬停退回展示路径本身");
  console.log("completion(hook): 悬停标题给完整绝对路径（含合成的「上一层」行） ✓");
}

// ---------- 14. 弹层**没**接管时的 Enter = 发送（回归锁） ----------
//
// 2026-09-19 的现场：把弹层按键分支搬进这个 module 时，`Composer.tsx` 里「Enter 发送」
// 那一段留在原地没人看见（新注释还写着「由组件处理」），于是**回车变成了换行**、
// 用户只能按 Shift+Enter？反过来——Shift+Enter 才是换行，回车发送整个没了。
// 这条断言钉的就是那一步：弹层关着时 Enter 必须交给 `onSubmit`，且 Shift/组合输入放过。
{
  const sent: ("enter" | "accelerated")[] = [];
  const closes = frame("普通草稿", 4, { onSubmit: (gesture) => sent.push(gesture) });
  const enter = press(closes, "Enter");
  assert.deepStrictEqual(sent, ["enter"], "弹层没开时 Enter 必须交给 onSubmit（发送）");
  assert.strictEqual(enter.prevented, 1, "发送的 Enter 要 preventDefault（否则还会插入换行）");

  const shifted = frame("普通草稿", 4, { onSubmit: (gesture) => sent.push(gesture) });
  const shiftEnter = press(shifted, "Enter", { shiftKey: true });
  assert.deepStrictEqual(sent, ["enter"], "Shift+Enter 是换行，不许发送");
  assert.strictEqual(shiftEnter.prevented, 0, "Shift+Enter 不拦（交给浏览器换行）");

  const composing = frame("普通草稿", 4, { onSubmit: (gesture) => sent.push(gesture) });
  press(composing, "Enter", { nativeEvent: { isComposing: true } });
  assert.deepStrictEqual(sent, ["enter"], "输入法组合中的 Enter 放过（选词），不许发送");

  const accelerated = frame("普通草稿", 4, { onSubmit: (gesture) => sent.push(gesture) });
  press(accelerated, "Enter", { ctrlKey: true });
  assert.deepStrictEqual(sent, ["enter", "accelerated"], "Cmd/Ctrl+Enter = 加速手势（原样交给宿主）");

  // 反向：弹层**开着**时 Enter 只选候选，不许顺手把消息发出去
  const sentWhileOpen: ("enter" | "accelerated")[] = [];
  const open = frame("@src/webview/", 13, { onSubmit: (gesture) => sentWhileOpen.push(gesture) });
  const picked = press(open, "Enter");
  assert.deepStrictEqual(sentWhileOpen, [], "弹层开着时 Enter 只选候选，绝不发送");
  assert.strictEqual(picked.prevented, 1, "选中候选同样要 preventDefault");
  assert.strictEqual(open.draft, "@src/", "并且真的选走了候选（这里是「..」回上一层）");
}
console.log("completion(hook): 弹层没接管时的 Enter = 发送 ✓");

// ---------- 15. 底部提示栏：命令菜单不说「Tab 进入目录」，且常驻在列表之外 ----------
//
// 用户 2026-09-25 两条口径：① `/` 照搬 `@` 那份提示，里面写着按下去没有作用的
// 「Tab 进入目录」（命令候选是平铺列表，没有目录可进）；② 提示原来是候选列表里的
// 最后一行，候选多到要滚时得滑到底才看得见，要它成为列表**下面**单独一栏、常驻。
{
  /** 提示栏所在的层数（相对弹层外框）：1 = 外框自己，2 = 外框的直接子节点。 */
  function hintDepth(html: string): number {
    const token = /<div\b[^>]*>|<\/div>/g;
    let depth = 0;
    for (let m = token.exec(html); m; m = token.exec(html)) {
      if (m[0].startsWith("</")) {
        depth -= 1;
        continue;
      }
      depth += 1;
      if (m[0].includes("popover-hint")) return depth;
    }
    return -1;
  }

  // ① 两个菜单各说各的：`/` 那份不许出现「进入目录」
  const command = frame("/p", 2);
  assert.ok(command.html.includes(TEXTS.commandHint), "`/` 菜单底部的提示走 commandHint");
  assert.ok(
    !command.html.includes(TEXTS.mentionHint) && !command.html.includes(TEXTS.mentionDrill),
    "`/` 菜单里不许出现「Tab 进入目录」那套说明（命令候选没有目录可进）",
  );

  const mention = frame("@src/", 5);
  assert.ok(mention.html.includes(TEXTS.mentionHint), "`@` 菜单底部的提示仍是带 Tab 的那份");

  // ② 提示栏是滚动列表的**兄弟**节点：层数为 2 才算「在列表之外」
  assert.strictEqual(
    hintDepth(command.html),
    2,
    "`/` 菜单的提示栏要挂在弹层外框下面（进了候选列表就会跟着滚）",
  );
  assert.strictEqual(hintDepth(mention.html), 2, "`@` 菜单的提示栏同样在滚动列表之外");
  assert.ok(
    /<div class="popover-list" role="listbox">[\s\S]*<\/div><div class="popover-hint">/.test(
      mention.html,
    ),
    "候选列表闭合之后才轮到提示栏（换成列表里的最后一行就又会跟着滚）",
  );
}
console.log("completion(hook): 底部提示栏（命令菜单去掉 Tab、常驻在列表之外） ✓");

// ---------- 16. 候选行的高亮只许被**真实指针移动**改（滚动不许把键盘的高亮抢走） ----------
//
// 现场（用户 2026-09-25 报）：鼠标停在某条候选上不动，用方向键往下翻——列表为了露出
// 键盘选中的那一行而滚动时，浏览器会把 `mouseover` / `mouseenter` **补发**给「刚滚到
// 静止指针底下」的那一行，于是高亮被抢回指针那条，下一次按键从那里继续走（实测连按
// 12 次：第 6 次起 6 → 2，正好是列表第一次滚动的帧）。判据：行上挂的必须是
// `onMouseMove`（只在指针真的动了时派发），不许挂 `onMouseEnter`。
//
// 浏览器侧的对拍（缺陷现场是 DOM 事件，无头环境造不出来）：预览页里把鼠标停在某一行、
// 连按方向键穿过滚动边缘，看选中行是否一路跟着走——改前第 6 次按键起失败（6 → 2），
// 改后 12/12 通过，且真移动指针时悬停仍能接管高亮（`/` 与 `@` 两个菜单各一遍）。
{
  /** 弹层元素树里候选行的 props（按出现顺序）。`html` 看不见挂上去的事件，只能走元素树。 */
  function rowPropsOf(node: ReactNode): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const props = (value as { props?: Record<string, unknown> }).props;
      if (!props) return;
      if (typeof props.className === "string" && /(^|\s)popover-item(\s|$)/.test(props.className)) {
        rows.push(props);
      }
      visit(props.children);
    };
    visit(node);
    return rows;
  }

  /** 当前选中行是第几条（没有就是 -1）。 */
  function selectedIndexOf(node: ReactNode): number {
    return rowPropsOf(node).findIndex(
      (props) => typeof props.className === "string" && props.className.includes("is-selected"),
    );
  }

  const f = frame("@a/", 3);
  const rows = rowPropsOf(f.popoverNode);
  assert.ok(rows.length > 1, "前提：这一帧有多条候选行");
  assert.strictEqual(selectedIndexOf(f.popoverNode), 0, "前提：起点选中的是第 0 条");

  assert.deepStrictEqual(
    rows.filter((props) => "onMouseEnter" in props),
    [],
    "候选行不许挂 onMouseEnter——列表滚动会让浏览器补发 enter，把键盘的高亮抢回指针那条",
  );
  assert.ok(
    rows.some((props) => typeof props.onMouseMove === "function"),
    "非选中行要挂 onMouseMove（指针真的动了才改高亮）",
  );

  // 真调一次那一行的悬停处理器：下一帧的选中行要换成它——证明挂的确实是「改高亮」那一支，
  // 而不是把鼠标接管整条路一起砍掉了。
  const target = 2;
  (rows[target].onMouseMove as () => void)();
  assert.strictEqual(
    selectedIndexOf(nextFrame(f).popoverNode),
    target,
    "悬停处理器要真的改高亮（真移动指针时鼠标仍能接管）",
  );
}
console.log("completion(hook): 悬停改高亮只认真实指针移动（滚动抢不走） ✓");

/* ============ 弹不弹：浏览入口恒弹，「已经能引用到内容」的块不弹 ============ */

// ---------- 17. 抑制门（用户 2026-10-11 口径） ----------
//
// 界面这一层只有一条判据：宿主对**这一块**的判定（`fileRefs.resolved`）说它已经能
// 引用到内容时不弹；判定还没到（`fileRefs.query` 对不上这次查询）也先不弹——否则光标
// 移进一条已经写好的引用时会先闪一个列表出来（用户 2026-10-10 报的现场）。
// 浏览入口不看这条：裸 `@` 是唯一的「从头浏览」入口，等一个往返就是「刚敲 `@` 没反应」。
{
  // ---- 判定说「能引用」→ 整块不弹 ----
  const suppressed: Array<[string, string, number, string]> = [
    ["已引用的文件", "看一下 @src/a.ts", 8, "src/a.ts"],
    ["整串填完的路径（光标在末尾）", "@src/file.ts", 13, "src/file.ts"],
    ["带行号区间的引用", "@src/a.ts#L12-L40", 17, "src/a.ts#L12-L40"],
    ["已引用的对话", "@[标题](dsh-session:s1)", 4, "[标题](dsh-session:s1)"],
    ["带引号空格的文件", '看一下 @"my a.ts"', 7, "my a.ts"],
  ];
  for (const [label, draft, caret, query] of suppressed) {
    const f = frame(draft, caret, {
      fileRefs: { query, items: FILES, sessions: SESSIONS, resolved: true },
    });
    assert.strictEqual(f.html, "", `${label}：判定说这块已经能引用到内容 → 一个候选行都不许出现`);
  }

  // ---- 判定还没到 → 也先不弹（宁可晚一两帧，也不闪一个列表出来） ----
  {
    const draft = "看一下 @session-4be424ed";
    const pending = frame(draft, draft.length, {
      fileRefs: { query: "", items: FILES, sessions: SESSIONS, resolved: false },
    });
    assert.strictEqual(pending.html, "", "这一次的判定还没回来（查询串对不上）→ 先不弹");

    // 上一块留下的判定（哪怕是「能引用」）不算这一次的：那会让光标一移进新块就整块不弹
    const other = frame(draft, draft.length, {
      fileRefs: { query: "别的查询", items: FILES, sessions: SESSIONS, resolved: true },
    });
    assert.strictEqual(other.html, "", "别的查询留下的判定不算数（按「还没到」处理）");
  }

  // ---- 判定说「不能引用」→ 弹，且候选就是整块查询的结果 ----
  {
    const sessionId = "session-4be424ed-3f46-4c23-ad68-9a4fd33f3d6d";
    const draft = `看一下 @${sessionId}`;
    const f = frame(draft, draft.length, {
      fileRefs: { query: sessionId, items: FILES, sessions: SESSIONS, resolved: false },
    });
    assert.ok(f.html.includes("popover-item"), "会话检索块：块本身还引用不到内容 → 列表要弹");
    assert.ok(f.html.includes(TEXTS.mentionSessions), "对话候选那一组在（服务端按整块筛会话）");
    assert.ok(f.html.includes("上一个会话"), "候选里就是那条会话");
    assert.ok(!f.html.includes(">..</span>"), "没有分隔符的查询不该冒出「..」");

    // 一条候选都没有也要弹：用户口径是「否则就要弹」，空结果由弹层自己说明
    const empty = frame(draft, draft.length, {
      fileRefs: { query: sessionId, items: [], sessions: [], resolved: false },
    });
    assert.ok(empty.html.includes(TEXTS.mentionEmpty), "判定说引用不到、又没有候选 → 弹层说「没有匹配的文件」");
  }

  // ---- 浏览入口恒弹：不吃判定，也不等判定 ----
  //
  // 「不等判定」的意思是**这一层当场画得出来**，不是「拿上一层的帧来画」：帧还没回来时
  // 文件 / 对话候选一律按空算（旧层的宿主「上一层」行与文件行不许占住首行——用户
  // 2026-10-18 报的现场），但弹层本身照旧出来（裸 `@` 给「没有匹配的文件」，进了目录的
  // 块给界面自己按当前查询合成的「..」）。
  for (const [label, draft, caret] of [
    ["裸 `@`", "@", 1],
    ["目录块（尾分隔符）", "@src/webview/", 13],
    ["带引号空格的目录块", '看一下 @"my dir/" 后面', 7],
  ] as const) {
    const f = frame(draft, caret, {
      fileRefs: { query: "别的查询", items: FILES, sessions: SESSIONS, resolved: true },
    });
    assert.ok(f.popoverNode !== null, `${label}：浏览入口当场弹（目录在不在都要能进去）`);
    assert.ok(
      !f.html.includes("a.txt"),
      `${label}：旧帧的文件行不许充当这一层的候选（快按 Enter 会选到上一层的东西）`,
    );
  }
  for (const [label, draft, caret] of [
    ["目录块（尾分隔符）", "@src/webview/", 13],
    ["带引号空格的目录块", '看一下 @"my dir/" 后面', 7],
  ] as const) {
    const f = frame(draft, caret, {
      fileRefs: { query: "别的查询", items: FILES, sessions: SESSIONS, resolved: true },
    });
    assert.ok(f.html.includes(">..</"), `${label}：「..」按**当前查询**合成（不等帧也能导航）`);
  }
  assert.ok(
    frame("@", 1, { fileRefs: { query: "别的查询", items: FILES, sessions: SESSIONS, resolved: true } })
      .html.includes(TEXTS.mentionEmpty),
    "裸 `@` 那一层的帧还没回来时弹的是空结果说明（宿主还没给「上一层」行）",
  );

  // 裸 `@` 那一层照旧带对话候选（服务端按空查询筛历史会话）
  assert.ok(frame("@", 1).html.includes(TEXTS.mentionSessions), "根目录这一层照旧列对话候选");

  // ---- 目录块里光标在**任意位置**都开着，且查询串是**整块** ----
  //
  // 判据是「..」指向 `src/`：若查询串只取光标前半截，后两帧的「..」会指回工作区根目录
  // （`mentionParent` 拿到的就是半截串）——正是 2026-10-10 那次要修掉的偏差。
  const nested = "@src/webview/";
  for (const [label, caret] of [["紧靠 `@`", 1], ["块中间", 6], ["块末尾", 13]] as const) {
    const f = frame(nested, caret);
    assert.ok(f.html.includes("popover-item"), `光标在目录块（${label}）→ 列表开着`);
    assert.ok(
      f.html.includes('popover-item-sub">src/<'),
      `查询串必须是整个块（${label}）：「..」指向 src/ 而不是根目录`,
    );
    assert.ok(!f.html.includes(TEXTS.mentionSessions), `进了目录不再列对话候选（${label}）`);
  }
  // 带引号（含空白）的目录 token 同理：`my dir/` 的上一层是工作区根目录
  const spacedDir = frame('看一下 @"my dir/" 后面', 7);
  assert.ok(spacedDir.html.includes('popover-item-main is-priority">..'), "带引号空格的目录块：顶部有 `..`");
  assert.ok(spacedDir.html.includes(TEXTS.mentionParent), "`..` 指向工作区根目录（语义路径 `my dir/` 的一层）");
  assert.ok(!spacedDir.html.includes(TEXTS.mentionSessions), "进了目录不再列对话候选");
}
console.log("completion(hook): 抑制门（能引用到内容 / 判定未到不弹；浏览入口恒弹） ✓");

// ---------- 18. 目录整段替换：换掉的是整个块，前后文一个字不动 ----------
//
// 光标在块中间时，替换区间也必须是**整个块**（`tokenSpan` 取 `trigger.query` 的全长，
// 而新口径下 `query` 就是整块）：只换光标前半截会留下半截路径，把块后面的正文一起
// 吃进去则是「误吞后缀」。这里前后各挂一段文字，两边都要在。
{
  const text = "前文 @src/webview/ 后文";
  const up = frame(text, 8); // 光标在 `src/we|bview/` 中间
  assert.ok(up.html.includes("popover-item"), "前提：目录块里列表开着");
  press(up, "Enter"); // 第 0 条是 `..` = 回上一层
  assert.strictEqual(up.draft, "前文 @src/ 后文", "整块被换掉：前缀与后缀一个字都没被吃掉");
  assert.ok(flushRaf() >= 1, "落光标仍走 rAF");
  assert.strictEqual(up.node.lastSelection, "前文 @src/".length, "光标落在替换结果之后");

  // 下钻同样整段替换（裸 `@` 的第 0 条是 `src/dsh` 目录），后缀不许动
  const wide = frame("前文 @ 后文", 4, {
    fileRefs: { query: "", items: [{ path: "src/webview", kind: "directory" }], sessions: [] },
  });
  press(wide, "Tab");
  assert.strictEqual(wide.draft, "前文 @src/webview/ 后文", "下钻写入的是目录块，前后文不动");

  // 带引号的目录块：替换区间要**覆盖闭引号**（按查询串长度算会留下一个孤引号），
  // 前后文同样一个字不动
  const quoted = frame('前文 @"my dir/" 后文', 6, {
    fileRefs: { query: "my dir/", items: [], sessions: [] },
  });
  assert.ok(quoted.html.includes("popover-item"), "前提：带引号目录块里列表开着");
  press(quoted, "Enter"); // 第 0 条是 `..`：`my dir/` 的上一层是工作区根目录
  assert.strictEqual(
    quoted.draft,
    "前文 @ 后文",
    "带引号目录块整段替换：闭引号一起被换掉，前后文不误吞",
  );
  assert.ok(flushRaf() >= 1, "落光标仍走 rAF");
  assert.strictEqual(quoted.node.lastSelection, "前文 @".length, "光标落在替换结果之后");
}
console.log("completion(hook): 目录块整段替换（前后文不误吞） ✓");

// ---------- 19. 不发重复 queries：光标在块内挪动不算「查询变了」 ----------
//
// 一次 `@` 查询在服务端是「扫全部会话日志」那一趟（百毫秒级，见
// `docs/design-mentions.md`），所以「同一个目录块里挪光标」
// 绝不能重发 `queryFiles`：重取 effect 的依赖只有触发词种类 + 查询串。
//
// 为什么只钉到「依赖数组」这一层：本仓库的界面断言走 `react-dom/server` 渲染，
// **effect 不跑**，这种时序在无头环境里造不出来（`mentionCandidates.test.ts` 对同一个
// effect 用的也是结构判据 + 发射点计数，理由相同）。
{
  const text = "@src/webview/";
  const queries = [1, 6, 13].map((caret) => findTrigger(text, caret)?.query);
  assert.deepStrictEqual(
    queries,
    ["src/webview/", "src/webview/", "src/webview/"],
    "光标在块内的位置不改变查询串（于是「查询串变了才重取」不会因挪光标而多发一帧）",
  );
  const quotedText = '@"my dir/"';
  assert.deepStrictEqual(
    [1, 7, 9].map((caret) => findTrigger(quotedText, caret)?.query),
    ["my dir/", "my dir/", "my dir/"],
    "带引号的目录块同理：整块一个查询串（引号只是包装，不进查询）",
  );

  const source = readFileSync(join(process.cwd(), "src", "webview", "composerCompletion.tsx"), "utf8");
  assert.ok(
    /\}, \[trigger\?\.kind, trigger\?\.query, trigger\?\.sessionOnly, sessionId, workingDirectory\]\);/.test(source),
    "`@` 重取依赖查询语义、会话和执行目录，不依赖光标位置：块内每挪一格不应多发一帧",
  );
}
console.log("completion(hook): 同一目录块内挪光标不发重复 queries ✓");

// ---------- 20. 下钻自动变目录块 → 列表不关 ----------
//
// 「新输入裸 `@` 自动打开、通过列表下钻自动变目录」是这套口径能用的关键：下钻写回
// 正文的就是 `@<目录>/`——一个**浏览入口**（宿主不做判定、界面不等判定），所以列表
// 不会因为换了个查询串而关掉。
{
  const root = frame("@", 1);
  press(root, "Tab"); // 第 0 条是 `src/dsh` 目录
  assert.strictEqual(root.draft, "@src/dsh/", "裸 `@` + Tab = 进第一条目录");

  const drilled = frame(root.draft, root.draft.length);
  assert.ok(drilled.html.includes("popover-item"), "下钻后是目录块（浏览入口）→ 列表仍开着");
  assert.ok(
    drilled.html.includes('popover-item-sub">src/<'),
    "下钻后的查询串是整块 `src/dsh/`：「..」指向 src/",
  );
  assert.ok(!drilled.html.includes(TEXTS.mentionSessions), "进了目录不再列对话候选");
}
console.log("completion(hook): 下钻自动变目录块（列表不关） ✓");

/* ============ 键盘只在弹层真画出来时才接管 ============ */

// ---------- 21. 弹层没画出来时，Enter / ↑↓ / ESC 都不算它的（用户 2026-10-18 报的现场） ----------
//
// 现场：在输入框里敲一条**工作区外的路径**，`@` 列表并不存在（抑制门按住），接着按回车，
// 正文却被改写成「上一层目录」——选中了一个用户看不见的第一行。
//
// 根因是两处判据分了家：
// - 渲染那一支读 `resolvedSuppressed` / `waiting` + `popoverVisible`（弹层此刻画不画）；
// - 键盘那一支只读「有触发词 + 候选非空」，而 `..` 由 `rankCandidates` **无条件**挂在最前
//   （进了目录就一定有它），于是「候选非空」在弹层被按住时照样为真。
//
// 判据必须**同一份**：弹层没画出来，这一键就不归补全（Enter 照旧是发送，↑↓ 照旧挪光标，
// ESC 交给归属链的兜底）。三条通道各钉一遍，最后用同一份草稿的「画出来」那一帧作对照
// ——两组只差「弹层画没画」，行为必须天差地别。
{
  // 一条工作区外的绝对路径：进过目录（有分隔符，于是 `..` 在候选里），宿主判定说这块
  // 已经能引用到内容 → 抑制门按住 → 弹层一个行都不画。
  const outside = "@D:/dev/other/notes.txt";
  const outsideQuery = "D:/dev/other/notes.txt";

  /** 一遍「抑制门按住」的现场：弹层没画出来，回车 / 方向键 / ESC 都不该被它接管。 */
  function hidden(label: string, fileRefs: UseComposerCompletionInput["fileRefs"]): void {
    const sent: string[] = [];
    const f = frame(outside, outside.length, {
      fileRefs,
      onSubmit: (gesture) => {
        sent.push(gesture);
      },
    });
    assert.strictEqual(f.html, "", `${label}：前提是弹层没画出来`);

    // 回车：不许改写正文（不许选中看不见的「..」），要落到发送
    press(f, "Enter");
    assert.strictEqual(f.draft, outside, `${label}：列表没画出来时 Enter 不许改写正文`);
    assert.deepStrictEqual(sent, ["enter"], `${label}：Enter 归发送`);

    // ↑↓：不许被吃掉（那会让光标挪不动，同时改一个看不见的高亮）
    assert.strictEqual(press(f, "ArrowUp").prevented, 0, `${label}：↑ 要留给光标`);
    assert.strictEqual(press(f, "ArrowDown").prevented, 0, `${label}：↓ 要留给光标`);

    // ESC：没有画出来的东西可关，这一键交给归属链（生成中就是停止生成）
    const escape = press(f, "Escape");
    assert.strictEqual(escape.prevented, 0, `${label}：ESC 不该被一个不存在的列表消费`);
    assert.strictEqual(escape.stopped, 0, `${label}：ESC 要能继续冒泡到兜底`);
  }

  // 抑制的两条来路各一遍：判定说「已经能引用到内容」，与「这一次的判定还没回来」。
  hidden("判定说能引用", { query: outsideQuery, items: [], sessions: [], resolved: true });
  hidden("判定还没到", { query: "上一次的查询", items: FILES, sessions: SESSIONS, resolved: false });

  // 对照：同一份草稿、同一条查询，只是判定说「引用不到」（`resolved: false`）→ 弹层真的
  // 画出来，这时键盘归它：Enter 选中第一行（`..` → 上一层目录）、↑↓ 与 ESC 都被接管。
  {
    const sent: string[] = [];
    const f = frame(outside, outside.length, {
      fileRefs: { query: outsideQuery, items: [], sessions: [], resolved: false },
      onSubmit: (gesture) => {
        sent.push(gesture);
      },
    });
    assert.ok(f.html.includes("popover-item"), "对照：弹层画出来了才轮到键盘接管");
    assert.ok(
      /class="popover-item-main is-priority"(?: title="[^"]*")?>\.\.</.test(f.html),
      "对照：第一行就是「..」",
    );

    assert.strictEqual(press(f, "ArrowUp").prevented, 1, "对照：弹层在时 ↑ 归它");
    assert.strictEqual(press(f, "Escape").prevented, 1, "对照：弹层在时 ESC 归它");
    assert.deepStrictEqual(sent, [], "对照：ESC 关列表不发送");
  }

  // 对照的「Enter 选中」单独一帧：前一帧的 ESC 已经把列表关掉了
  {
    const f = frame(outside, outside.length, {
      fileRefs: { query: outsideQuery, items: [], sessions: [], resolved: false },
    });
    press(f, "Enter");
    assert.strictEqual(f.draft, "@D:/dev/", "对照：弹层画出来时 Enter 照样选中「..」（回上一层）");
  }
}
console.log("completion(hook): 键盘只在弹层画出来时接管（抑制门按住时 Enter 归发送） ✓");

// ---------- 21b. 刷新期间列表**原地留屏**：只换一次内容，键位一并冻结 ----------
//
// 现场（用户 2026-10-18）：`@` 每改一个字都要重发一次查询（宿主查盘、扫会话日志），
// 而那一帧回来之前界面会把列表撤掉——弹层在 `.composer` 的常规流里，撤掉它输入区就矮
// 一截、会话区跟着弹一下，看着像闪一下。口径是「列表常驻，只在内容上刷新」。
//
// 留屏期间屏上那一份是**上一次查询**的结果，所以键位与指针动作一并冻结（官方
// `ui-input-trigger` 的 `menuReduce` 把各源置成 pending、items 与高亮原地不动，
// `arbitrate` / `pick` 再按 `status !== 'ready'` 把 Enter / Tab / pick 挡掉）。
//
// 这一节钉四件事：留屏那一份是完整的（不塌成空结果、也不掺进当前查询的半份）、
// 留屏期间 Enter / Tab / ↑↓ / 点击都不生效、帧到了**只换一次**内容并交还键位、
// 换块或触发词消失后不复用上一份。
{
  const ROOT: FileRefView[] = [
    { path: "D:/dev", kind: "directory", parent: true },
    { path: "a.txt", kind: "file" },
    { path: "src", kind: "directory" },
  ];
  /** 裸 `@` 那一层的帧（`query` 是空串）——下一帧里它就成了「上一次查询」。 */
  const rootFrame: UseComposerCompletionInput["fileRefs"] = {
    query: "",
    items: ROOT,
    sessions: SESSIONS,
    resolved: false,
    cwd: "D:/dev/proj",
  };

  const first = frame("@", 1, { fileRefs: rootFrame });
  assert.ok(first.html.includes("a.txt"), "前提：裸 `@` 这一层的候选已经在屏上");

  // 真的敲一个字：查询串变成 `s`，而这一次的帧还没回来（宿主还在查盘 / 扫会话日志）
  const typing = typeAt(first, "@s", 2, { fileRefs: rootFrame });
  assert.ok(typing.html.includes("a.txt"), "留屏：上一份候选原样在（不许塌成空列表）");
  assert.ok(/title="D:\/dev"/.test(typing.html), "留屏：首行仍是上一份的「上一层」行");
  assert.ok(!typing.html.includes(TEXTS.mentionEmpty), "留屏：不许先画一个「没有匹配的文件」");
  assert.strictEqual(typing.draft, "@s", "留屏不改正文");

  // 留屏期间键位一并冻结：Enter / Tab / ↑↓ 都被吞掉（不选中陈旧行、不发送、不挪光标）
  const sent: string[] = [];
  const held = nextFrame(typing, { fileRefs: rootFrame, onSubmit: (gesture) => sent.push(gesture) });
  assert.ok(held.html.includes("a.txt"), "前提：这一帧仍在留屏");
  assert.strictEqual(press(held, "Enter").prevented, 1, "留屏：Enter 被吞掉");
  assert.deepStrictEqual(sent, [], "留屏：Enter 不许把半截 `@s` 当普通消息发出去");
  assert.deepStrictEqual(held.written, [], "留屏：Enter 不许选中陈旧的候选行");
  assert.strictEqual(press(held, "Tab").prevented, 1, "留屏：Tab 被吞掉（焦点不许离开输入框）");
  assert.strictEqual(press(held, "ArrowDown").prevented, 1, "留屏：↓ 归列表，不许挪光标");
  assert.strictEqual(press(held, "ArrowUp").prevented, 1, "留屏：↑ 归列表，不许挪光标");

  // 指针同理：画着的那一行点下去什么都不发生（判据收在 `applyCandidate` 一处）
  const hits = hitPropsOf(held.popoverNode);
  assert.ok(hits.length >= 2, "前提：留屏那一份里有候选行");
  let clickPrevented = 0;
  (hits[1]?.onMouseDown as ((event: unknown) => void))?.({ preventDefault: () => (clickPrevented += 1) });
  assert.strictEqual(clickPrevented, 1, "留屏：点击同样要 preventDefault（焦点不许被抢走）");
  assert.deepStrictEqual(held.written, [], "留屏：点击不许选中陈旧的候选行");

  // 帧到了（查询串对上）→ 整份换成本次查询的候选，键位交还列表
  const SETTLED: UseComposerCompletionInput["fileRefs"] = {
    query: "s",
    items: [{ path: "src", kind: "directory" }],
    sessions: [],
    resolved: false,
    cwd: "D:/dev/proj",
  };
  const settled = nextFrame(held, { fileRefs: SETTLED });
  assert.ok(settled.html.includes("src"), "帧到了 → 换成本次查询的候选");
  assert.ok(!settled.html.includes("a.txt"), "帧到了 → 上一次查询的候选整份退场（内容只换一次）");
  press(settled, "Enter");
  assert.strictEqual(settled.draft, "@src/", "帧到了 → 键盘交还列表（Enter 选中第一条目录）");

  // 高亮不跟着查询串复位：留屏期间屏上那一份没换，用户挪过去的高亮就停在原处。
  // 复位那一支是 effect（提交之后的事），离线渲染里不跑，所以这里同时钉它的**依赖数组**：
  // 跟着 `trigger.query` 走会在留屏期间先把高亮跳回顶部、等帧到了再跳一次，等于刷一次新动两次屏。
  const nav = frame("@", 1, { fileRefs: rootFrame });
  press(nav, "ArrowDown");
  const navTyping = typeAt(nav, "@s", 2, { fileRefs: rootFrame });
  assert.ok(
    /class="popover-item is-selected"[^>]*>[\s\S]*?a\.txt</.test(navTyping.html),
    "留屏：高亮仍停在第二行（内容没换就不复位）",
  );
  const source = readFileSync(join(process.cwd(), "src", "webview", "composerCompletion.tsx"), "utf8");
  assert.ok(
    /\}, \[shownKey\]\);/.test(source),
    "高亮复位 effect 的依赖只能是 `shownKey`（屏上这一份属于哪一次查询），不是查询串",
  );

  // 换块（触发词起点不同）不复用上一份：那一份不是这一块的候选
  const otherBlock = typeAt(first, "看看 @s", 5, { fileRefs: rootFrame });
  assert.strictEqual(otherBlock.html, "", "另一块的判定还没到 → 没画过就不画，更不许拿上一块的行顶上");

  // 裸 `@` 还没等到帧时先画出来的「没有匹配的文件」同样算「画过」：敲下一个字符时它留在屏上，
  // 不许先消失、等结果到了再长回来（那正是这次要治的那种闪）
  const staleFrame: UseComposerCompletionInput["fileRefs"] = {
    query: "别的查询",
    items: FILES,
    sessions: SESSIONS,
    resolved: false,
  };
  const bareRoot = frame("@", 1, { fileRefs: staleFrame });
  assert.ok(bareRoot.html.includes(TEXTS.mentionEmpty), "前提：裸 `@` 的帧还没到，先画空结果说明");
  const bareTyping = typeAt(bareRoot, "@s", 2, { fileRefs: staleFrame });
  assert.ok(bareTyping.html.includes(TEXTS.mentionEmpty), "留屏：这一份说明留在屏上，不许塌掉再长回来");
  assert.ok(!bareTyping.html.includes("a.txt"), "留屏：仍不许掺进旧帧的文件行");

  // 触发词消失即清空记录：光标挪出块再挪回来，pending 期间不许先闪一个旧列表
  const outside = typeAt(first, "@src/a.ts 后面", 13, { fileRefs: rootFrame });
  assert.strictEqual(outside.html, "", "光标在块外：不画（这一帧顺带把记录清掉）");
  const backIn = typeAt(outside, "@src/a.ts 后面", 4, { fileRefs: rootFrame });
  assert.strictEqual(
    backIn.html,
    "",
    "挪回块里、判定还没到 → 先不画（不许拿已经清掉的上一份闪一下）",
  );
}
console.log("completion(hook): 刷新期间列表原地留屏（只换一次内容 + 键位冻结） ✓");

// 执行目录变了但查询串没变：旧候选只留屏，不能被选中；新目录回帧后交还动作。
{
  const refs: UseComposerCompletionInput["fileRefs"] = {
    sessionId: "owner", cwd: "/project", query: "", items: [{ path: "old.txt", kind: "file" }], sessions: [], resolved: false,
  };
  const first = frame("@", 1, { sessionId: "owner", workingDirectory: "/project", fileRefs: refs });
  assert.ok(first.html.includes("old.txt"));
  const moved = nextFrame(first, { sessionId: "owner", workingDirectory: "/worktree", fileRefs: refs });
  assert.ok(moved.html.includes("old.txt"), "同一会话的旧目录候选原地留屏");
  press(moved, "Enter");
  assert.deepEqual(moved.written, [], "旧目录结果不可选中");
  const fresh = nextFrame(moved, { sessionId: "owner", workingDirectory: "/worktree", fileRefs: {
    ...refs, cwd: "/worktree", items: [{ path: "new.txt", kind: "file" }],
  } });
  assert.ok(fresh.html.includes("new.txt") && !fresh.html.includes("old.txt"));
  press(fresh, "Enter");
  assert.equal(fresh.draft, "@new.txt", "新目录候选可以选中");
  const switched = nextFrame(first, { sessionId: "other", workingDirectory: "/project", fileRefs: refs });
  assert.ok(!switched.html.includes("old.txt"), "不同会话即使目录相同也不复用留屏列表");
  const source = readFileSync(join(process.cwd(), "src", "webview", "composerCompletion.tsx"), "utf8");
  assert.ok(/\[trigger\?\.kind, trigger\?\.query, trigger\?\.sessionOnly, sessionId, workingDirectory\]/u.test(source), "执行目录和会话身份改变时重发同一查询");
}
console.log("completion(hook): 同查询串切执行目录与切会话隔离 ✓");

// ---------- 22. M2 宿主下发的「上一层」行（裸 `@` 那一层） ----------
//
// 工作区外的发现（见 docs/design-mentions.md「三种入口」）里，裸 `@` 那一层多一行「上一层」：
// 它由**宿主**下发（cwd 的父目录，绝对形态，信任门通过且父目录在本机确实是目录时才有），
// 因为只有宿主知道会话 cwd、也只有它碰得到文件系统。形状与界面自己合成的那一行**同形**
// （`{ path, kind: "directory", parent: true }`，界面不需要新字段）。
//
// 这一节用真实 hook + 手写事件钉四件事：
// - 该行**排在最前**，且宿主没下发时裸 `@` 那一层不凭空长出一行；
// - Enter / 点行主体 = pick：写回父目录的浏览 token（`@D:/dev/`，正文换成那一层的查询）；
// - **Tab 与 Enter 同一个结果**：也写回 `@D:/dev/`。它不是可下钻的目录（`hasDrillableFolder`
//   仍不算它），但那只决定「Tab 进入目录」这条提示显不显示，不是 Tab 没动作；
// - 两把键各只写一次草稿、不发 `queryFiles`、不发送。
{

  const HOST_PARENT: FileRefView = { path: "D:/dev", kind: "directory", parent: true };
  const refs: UseComposerCompletionInput["fileRefs"] = {
    query: "",
    items: [HOST_PARENT, { path: "D:/dev/proj/src", kind: "directory" }],
    sessions: [],
    cwd: "D:/dev/proj",
  };

  // 宿主没下发时：裸 `@` 那一层没有「上一层」（工作区根目录就是它，跳不出工作区）
  {
    const plain = frame("@", 1, {
      fileRefs: { query: "", items: [{ path: "D:/dev/proj/src", kind: "directory" }], sessions: [], cwd: "D:/dev/proj" },
    });
    assert.ok(plain.html.includes("popover-item"), "前提：有候选，弹层画出来了");
    assert.ok(
      !/class="popover-item-main[^"]*">\.\.</.test(plain.html),
      "宿主没下发 parent 行时，裸 `@` 那一层不凭空长出一行「..」",
    );
  }

  const f = frame("@", 1, { fileRefs: refs });
  assert.ok(f.html.includes("popover-item"), "前提：弹层画出来了");
  assert.ok(
    /class="popover-item-main is-priority" title="D:\/dev">\.\.</.test(f.html),
    "「..」排在最前，悬停标题是以会话 cwd 解析出来的完整目标",
  );
  assert.ok(f.html.includes(">D:/dev<"), "行里显示实际目标的完整路径（不省略到无法确认）");
  assert.strictEqual(
    hasDrillableFolder(rankCandidates({ kind: "mention", start: 0, query: "" }, [], refs.items, refs.sessions)),
    true,
    "这一层还有一个可下钻的真目录（于是「Tab 进入目录」的提示照样显示）",
  );

  // Tab 与 Enter 在这一行上是**同一个结果**（都是回上一层）：两把键各只写一次草稿、
  // 不发查询帧、都不发送。用两张同源帧分别按键，比较它们结果与发出的帧。
  const sent: string[] = [];
  const tabbed = frame("@", 1, { fileRefs: refs, onSubmit: (gesture) => sent.push(gesture) });
  POSTED.length = 0;
  const tabCalls = press(tabbed, "Tab");
  const tabFrames = POSTED.splice(0, POSTED.length);
  assert.strictEqual(tabCalls.prevented, 1, "Tab 仍由弹层吃掉（不许落成默认的焦点切换）");
  assert.strictEqual(tabbed.draft, "@D:/dev/", "Tab 在「..」上 = 回上一层（与 Enter 同一个结果）");
  assert.deepStrictEqual(sent, [], "回上一层不发送");
  assert.deepStrictEqual(
    tabFrames,
    [{ type: "setDraft", text: "@D:/dev/" }],
    "一次回上一层只写一条草稿帧，导航本身不发 queryFiles（重取由查询串 effect 独占）",
  );

  // Enter = pick：写回父目录的浏览 token（正文换成那一层的查询串）
  const entered = frame("@", 1, { fileRefs: refs });
  const enterFrames = pressAndPost(entered, "Enter");
  assert.deepStrictEqual(entered.written, ["@D:/dev/"], "Enter 在「..」上= 回上一层：写回父目录的浏览 token");
  assert.strictEqual(entered.draft, "@D:/dev/");
  assert.deepStrictEqual(enterFrames, tabFrames, "两把键发给宿主的帧逐字相同");

  // 点行主体 = pick（`clickAction` 对 parent 行给 pick，不是 drill）→ 同样回上一层
  {
    const clicked = frame("@", 1, { fileRefs: refs });
    const hits = hitPropsOf(clicked.popoverNode);
    assert.strictEqual(hits.length, 2, "前提：两行候选各有一个主体按钮");
    (hits[0].onMouseDown as (event: { preventDefault: () => void }) => void)({
      preventDefault: () => undefined,
    });
    assert.deepStrictEqual(clicked.written, ["@D:/dev/"], "点「..」行主体 = pick：回上一层");
    assert.strictEqual(clicked.node.lastSelection, undefined, "落光标同样排在 rAF 里（与 Enter 一条链路）");
    assert.strictEqual(flushRaf() >= 1, true, "下一帧真的落了光标");
    assert.strictEqual(clicked.node.lastSelection, "@D:/dev/".length, "光标落在写回的浏览 token 之后");
  }
}
console.log("completion(hook): M2 宿主「上一层」行（Enter / Tab / 点击同为回上一层） ✓");

// ---------- 23. M3 相对 `..` 向上：按会话 cwd 的深度做段算术，退到根就停 ----------
//
// `@../` 是工作区外发现的第三条入口（见 docs/design-mentions.md「三种入口」的 M3）：
// 相对形态允许越出会话 cwd，但最多退到根（盘符根 / UNC 共享根 / POSIX 根）——再往上
// 没有目标，查询串也不许一路加长（`../../../../` 与 `../../` 在根上指同一层，
// 加长只会让用户看到一串没有意义的点）。
//
// 判据只有 cwd 能给：`files/list` 帧下发它（`pathDisplay.displayPathParts` 认盘符、
// UNC 与 POSIX 三种根），这里按**平台形态**逐个断言。
{
  // Windows 盘符：cwd = D:/dev/proj（离根 2 层）
  {
    const cwd = "D:/dev/proj";
    assert.strictEqual(mentionParent("../", cwd), "../../", "`../` 再上一层：多一个 `..` 段");
    assert.strictEqual(mentionParent("../../", cwd), "", "退到盘根：回工作区空查询（键盘上唯一的回路）");
    assert.strictEqual(mentionParent("../../../", cwd), "", "已经在盘根：查询串不再加长（目标不变）");
    assert.strictEqual(mentionParent("../other/", cwd), "../", "`../other/` 的上一层就是 `../`");
    assert.strictEqual(mentionParent("foo/../", cwd), "../", "`foo/../` 归一到 cwd 本身，上一层是 cwd 的父目录");
    assert.strictEqual(mentionParent("foo/bar/../", cwd), "", "`..` 段按语义消掉：归一后是 cwd/foo，它的上一层是 cwd（裸 `@`）");
    assert.strictEqual(mentionParent("..\\", cwd), "../../", "反斜杠写法同样算");
    assert.strictEqual(mentionParent("../..", cwd), "../../", "半截输入（没打尾斜杠）按当前目录算");
  }
  // cwd 的父目录就是盘根时：`../` 直接回工作区
  assert.strictEqual(mentionParent("../", "D:/dev"), "", "cwd 离根只有一层时 `../` 就是盘根");
  assert.strictEqual(mentionParent("D:", "D:/dev/proj"), "", "盘符裸写的「上一层」：盘根没有上一层（回工作区）");
  assert.strictEqual(mentionParent("D:/", "D:/dev/proj"), "", "盘根的 `..` 保留既定取值：回工作区空查询");
  assert.strictEqual(mentionParent("D:/dev/", "D:/dev/proj"), "D:/", "盘符根下面那一层退到根");
  assert.strictEqual(mentionParent("D:/dev/other/", "D:/dev/proj"), "D:/dev/", "绝对形态逐层回退");
  assert.strictEqual(
    mentionParent("D:/dev/other/notes.txt", "D:/dev/proj"),
    "D:/dev/",
    "带筛选词的绝对查询：正在浏览的目录是 D:/dev/other/，上一层是 D:/dev/（筛选词那一段不算目录）",
  );
  assert.strictEqual(mentionParent("D:/a/../b/", "D:/dev/proj"), "D:/", "绝对形态里的 `..` 先按根锚定语义归一");
  // UNC：共享根就是根，退到它就停
  {
    const cwd = "//server/share/dev";
    assert.strictEqual(mentionParent("../", cwd), "", "UNC 共享根同样止步（回工作区）");
    assert.strictEqual(mentionParent("../other/", cwd), "../", "共享根下面那一层照常退一层");
    assert.strictEqual(mentionParent("//server/share/dev/other/", cwd), "//server/share/dev/", "UNC 绝对形态逐层回退");
    assert.strictEqual(mentionParent("//server/share/", cwd), "", "共享根本身没有上一层");
  }
  // POSIX：cwd = /home/u/proj（离根 3 层）
  {
    const cwd = "/home/u/proj";
    assert.strictEqual(mentionParent("../", cwd), "../../", "POSIX 上同样按深度算");
    assert.strictEqual(mentionParent("../../../", cwd), "", "退到 POSIX 根：回工作区");
    assert.strictEqual(mentionParent("../../../../", cwd), "", "已经在根：查询串不再加长（目标不变）");
    assert.strictEqual(mentionParent("/home/u/", cwd), "/home/", "POSIX 绝对形态逐层回退");
    assert.strictEqual(mentionParent("/", cwd), "", "POSIX 根的上一层保留既定取值：回工作区");
  }
  // 没有 cwd（旧宿主 / 还没绑定会话）：不肯把纯 `..` 串加长，退回老口径；
  // 仍在 cwd 内部的那几层不需要深度，照常算
  assert.strictEqual(mentionParent("../"), "", "没有 cwd 时不敢往上走：回工作区空查询");
  assert.strictEqual(mentionParent("foo/bar/"), "foo/", "cwd 内部的目录回退不需要 cwd");
  assert.strictEqual(mentionParent("foo/../"), "", "回到 cwd 本身时，上一层要出 cwd → 不猜");
  assert.strictEqual(mentionParent("../other/"), "../", "`../other/` 的上一层是 `../`（不需要深度）");
  // 宿主下发的 cwd 要真的传进 `rankCandidates`：`@../` 那一层的「..」是 `../../`
  {
    const upRefs: UseComposerCompletionInput["fileRefs"] = {
      query: "../",
      items: [{ path: "../x.txt", kind: "file" }],
      sessions: [],
      cwd: "D:/dev/proj",
    };
    const f = frame("@../", 4, { fileRefs: upRefs });
    assert.ok(
      /class="popover-item-main is-priority" title="D:\/">\.\.</.test(f.html),
      "`@../` 那一层：合成的「..」目标是 `../../`，悬停解析出来的完整目标是盘根",
    );
    const enterFrames = pressAndPost(f, "Enter");
    assert.strictEqual(f.draft, "@../../", "Enter 在那一行上 = 再往上一层（写回 `@../../`）");

    // 界面自己合成的 parent 行同样两把键一个结果：Tab 也回上一层，帧与 Enter 逐字相同
    const tabbed = frame("@../", 4, { fileRefs: upRefs });
    const tabFrames = pressAndPost(tabbed, "Tab");
    assert.strictEqual(tabbed.draft, f.draft, "Tab 与 Enter 在合成的「..」上结果一致（`@../../`）");
    assert.deepStrictEqual(tabFrames, enterFrames, "两把键发出的帧逐字相同（各一条 setDraft，不发 queryFiles）");
  }

  // 旧帧还在场（`fileRefs.query` 对不上当前触发词）时，这一层**不许**用旧层的候选行：
  // 浏览入口不等待判定、当场画弹层，拿旧帧去画就会让上一层的宿主「上一层」行占住首行，
  // 用户快按 Enter 选中的是上一层（用户 2026-10-18 报的现场：注入 M2 根帧后手输
  // `@D:/dev/other/`，首行 title 还是旧根目录）。
  {
    const stale: UseComposerCompletionInput["fileRefs"] = {
      query: "",
      items: [
        { path: "D:/dev", kind: "directory", parent: true },
        { path: "src", kind: "directory" },
      ],
      sessions: [],
      cwd: "D:/dev/proj",
    };
    // `@../`：首行必须是**新查询**的上一层（`../../` → 盘根），不是旧根帧那一行
    const up = frame("@../", 4, { fileRefs: stale });
    assert.ok(
      /class="popover-item-main is-priority" title="D:\/">\.\.</.test(up.html),
      "旧根帧在场时手输 `@../`：首行「..」按当前查询算（../../），不是旧根帧的 parent",
    );
    assert.ok(!up.html.includes(">src<"), "旧查询的文件行不许掺进这一层（否则快按 Enter 会误选）");
    press(up, "Enter");
    assert.strictEqual(up.draft, "@../../", "快按 Enter 选的是新查询的上一层，不是旧层的父目录");

    // 绝对目录查询同理：首行是它自己那一层的上一层
    const absolute = frame("@D:/other/", 10, { fileRefs: stale });
    assert.ok(
      /class="popover-item-main is-priority" title="D:\/">\.\.</.test(absolute.html),
      "旧根帧在场时手输 `@D:/other/`：首行「..」是 `D:/`，不是旧根帧的 parent",
    );
    press(absolute, "Enter");
    assert.strictEqual(absolute.draft, "@D:/", "Enter 写回的是新查询的上一层");
  }
}
console.log("mentionNav: M3 相对 `..` 向上（深度算术 / 盘根与共享根止步 / 无 cwd 回退 / 陈旧帧不掺入） ✓");

// 官方命令目录只有英文摘要；菜单应复用官方 Web 的本地化描述。
{
  const commands = [{ name: "plan", definitionId: "@deepseek-ai/dsh-plan-mode", description: "Enter plan mode" }];
  const zh = frame("/pl", 3, { commands });
  assert.ok(zh.html.includes("进入或退出计划模式"), "中文 / 列表必须使用官方中文描述");
  const en = frame("/pl", 3, { commands, texts: dictionaryFor("en") });
  assert.ok(en.html.includes("Enter or leave plan mode"), "英文 / 列表必须使用官方英文描述");
}
// 链接仅定位或插入 /命令，筛选继续使用文本域补全，不再维护独立输入。
{
  const original = "before /plan keep";
  const located = commandMenuDraft({ id: 1, query: "plan", range: { start: 7, end: 12 } }, original, 9);
  assert.deepEqual(located, { text: original, caret: 12 }, "草稿点击不重复插入、不吞参数");
  const inserted = commandMenuDraft({ id: 2, query: "plan" }, "before after", 7);
  assert.deepEqual(inserted, { text: "before /plan after", caret: 12 });
  assert.deepEqual(commandMenuDraft({ id: 3, query: "plan" }, "", 0), { text: "/plan", caret: 5 });
  let submitted = 0;
  const opened = frame(located.text, located.caret, { onSubmit: () => submitted++ });
  assert.ok(opened.html.includes(">/plan<") && !opened.html.includes(">/compact<"), "打开即按命令名筛选");
  assert.ok(!/<input\b/.test(opened.html), "菜单不提供额外筛选框");
  assert.deepEqual(opened.written, []);
  assert.equal(press(opened, "Escape").prevented, 1);
  assert.equal(nextFrame(opened).html, "");
  assert.equal(submitted, 0);
  assert.equal(opened.draft, original);

  // 直接编辑文本域里的 / 后内容即可改变结果。
  const edit = frame(inserted.text, inserted.caret, { onSubmit: () => submitted++ });
  edit.node.value = "before /zero after";
  edit.node.selectionStart = 12;
  edit.props.onChange?.({ target: edit.node } as never);
  const filtered = nextFrame(edit, { onSubmit: () => submitted++ });
  assert.ok(filtered.html.includes("/zerocandidate") && !filtered.html.includes(">/plan<"));
  press(filtered, "Enter", { nativeEvent: { isComposing: true } });
  assert.equal(filtered.draft, "before /zero after", "输入法确认不得选择命令");
  const posted = pressAndPost(filtered, "Enter");
  assert.equal(filtered.draft, "before /zerocandidate after");
  assert.equal(submitted, 0, "选择命令不得直接发送");
  assert.deepEqual(posted.map((entry) => entry.type), ["setDraft"]);
}
console.log("completion(hook): 斜杠链接复用文本域筛选，无额外输入或执行 ✓");

// ---------- 21. 点击被包装标点包住的 `/命令`：真实 commandRequest effect 开过滤菜单 ----------
//
// 用户报障：`(/plan)` 在正文里是蓝的、也点了，菜单却不出来。原因是点击把光标落到
// `range.end`（命令名末尾，右括号之前），随后重扫触发词的规则只认空白。
//
// 这里不手工拼下一帧：`frame(..., { commandRequest })` 走的是真 hook，effect 回调由
// `captureEffects` 捕获、`flushEffects` 执行，随后用同一个状态表再渲染，断言 effect
// 真的落了光标并让菜单按被点的命令名筛出候选。
{
  const draft = "先看 (/plan) 再说";
  const span = scanCommandLinks(draft, COMMANDS).find((item) => item.text === "/plan");
  assert.ok(span, "前提：`(/plan)` 必须被扫描成可点命令");
  const request = { id: 71, query: "plan", range: { start: span.start, end: span.end } };
  const click = frame(draft, 6, { commandRequest: request });
  assert.ok(click.effects.length > 0, "渲染时必须捕获到 hook 登记的真实 passive effect");

  POSTED.length = 0;
  flushEffects(click);
  assert.strictEqual(click.draft, draft, "range 定位不改写草稿（不重复插入、不吞右括号）");
  assert.strictEqual(click.node.value, draft, "文本域内容保持原样");
  assert.strictEqual(click.node.lastSelection, span.end, "effect 把光标落到 range.end");
  assert.ok(click.node.focused > 0, "effect 把焦点还给输入框");
  assert.deepStrictEqual(
    POSTED.filter((entry) => entry.type === "setDraft"),
    [],
    "只打开筛选菜单，不写草稿、不发送",
  );

  // 同一状态表再渲染一帧：trigger 必须已经是 /plan（这来自 effect 里的 setTrigger）。
  const opened = frame(click.node.value, click.node.lastSelection ?? click.caret, { commandRequest: undefined }, click.store);
  assert.ok(opened.html.includes("popover-item"), "effect 之后必须画出候选弹层");
  assert.ok(opened.html.includes(">/plan<"), "菜单必须按被点的命令名过滤");
  assert.ok(!opened.html.includes(">/zerocandidate<"), "其他命令不得混进来");

  // range 复核：命中当前文本就按 range 构造触发词；前界 / 后界 / 文本任何一处对不上
  // 都不许凭旧请求伪造（陈旧点击最多是“没反应”，不能打开另一条命令）。
  assert.deepStrictEqual(
    commandRequestTrigger(request, draft, span.end),
    { kind: "command", start: span.start, query: "plan" },
    "range 与当前文本逐字匹配：直接构造触发词，不依赖重扫",
  );
  assert.strictEqual(
    commandRequestTrigger(request, draft, 0),
    undefined,
    "range 只在它自己的落点上生效（光标别处不按旧请求开菜单）",
  );
  assert.strictEqual(
    commandRequestTrigger(request, "先看 x/plan", span.end),
    undefined,
    "range 前界已失效（换成单词字符）：不伪造触发词",
  );
  assert.strictEqual(
    commandRequestTrigger(request, "先看 (/plan.md)", span.end),
    undefined,
    "range 后界已失效（多了扩展名）：不当作完整命令",
  );
  assert.strictEqual(
    commandRequestTrigger(request, "先看 plan 再说", span.end),
    undefined,
    "range 已对不上当前文本：不凭旧请求开菜单",
  );
  assert.deepStrictEqual(
    commandRequestTrigger({ id: 73, query: "plan" }, "before /plan after", 12),
    { kind: "command", start: 7, query: "plan" },
    "没有 range 的插入请求仍按插入后的文本重扫",
  );

  // 对照：宿主下发“插入 /命令”时没有 range，effect 走插入分支并写出草稿。
  const insert = frame("before after", 7, { commandRequest: { id: 72, query: "plan" } });
  flushEffects(insert);
  assert.strictEqual(insert.draft, "before /plan after", "无 range 的请求仍按光标处插入");
  assert.strictEqual(insert.node.lastSelection, insert.draft.indexOf("/plan") + "/plan".length, "光标落在插入的命令名之后");
  assert.strictEqual(insert.effects.length, 0, "这一帧的 effect 已经执行完");

  const stale = frame("先看 plan 再说", 9);
  assert.strictEqual(stale.html, "", "对照：没有 `/` 的草稿不会凭空开命令菜单");
}
console.log("completion(hook): 点击包装标点里的 /命令经 request effect 打开过滤菜单 ✓");
console.log("\nmentionNav: all assertions passed");
