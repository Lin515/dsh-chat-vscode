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
 * （同时是「光标真的落到哪」的观察点）。第 10–13 节跑的是真实的「事件 → 渲染」链。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { createElement, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
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
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: () => undefined,
});
const {
  candidateRows,
  clickAction,
  ComposerCompletionState,
  findTrigger,
  hasDrillableFolder,
  outcomeFor,
  popoverVisible,
  rankCandidates,
  useComposerCompletion,
} = await import("../src/webview/composerCompletion");
type ComposerCompletionStateHook = import("../src/webview/composerCompletion").ComposerCompletionStateHook;
type MentionCandidate = import("../src/webview/composerCompletion").MentionCandidate;
type UseComposerCompletionInput = import("../src/webview/composerCompletion").UseComposerCompletionInput;

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
{
  assert.strictEqual(mentionParent("src\\webview\\"), "src\\", "反斜杠分隔符照原样保留");
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

  // 进了子目录：`..` 排在最前，且它指向**上一层**（`src/webview/` → `src/`）
  const nested = rankCandidates({ kind: "mention", start: 0, query: "src/webview/" }, [], files, sessions);
  assert.deepStrictEqual(
    nested.map(nameOf),
    ["src/", "src/a.ts", "src/webview", "s1"],
    "「..」排在最前（用户口径：顶部提供返回上一层）",
  );
  assert.strictEqual((nested[0] as FileRefView).parent, true, "第一条必须是界面自己插的「..」行");
  assert.strictEqual((nested[0] as FileRefView).kind, "directory", "「..」也是一条目录候选");

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

  // 「有可下钻的目录」不算 `..`（它是回上一层，Tab 对它没有意义）
  assert.strictEqual(hasDrillableFolder(files), true, "有一个真目录 → 标题栏要显示 Tab 提示");
  assert.strictEqual(
    hasDrillableFolder([{ path: "src/", kind: "directory", parent: true }]),
    false,
    "只有 `..` 时不该显示「按 Tab 进入目录」",
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
  // 键盘分工不动：Enter = pick、Tab = drill（上面那批用例钉的就是它）。
  {
    const dirRow = candidateRows([...rankCandidates({ kind: "mention", start: 0, query: "src" }, [], [dir], [])], "mention", TEXTS).find(
      (row) => row.folder,
    );
    assert.ok(dirRow, "候选里应当有一行是「可进目录」");
    assert.strictEqual(clickAction(dirRow), "drill", "点目录行主体 = 打开该目录（不是选中它）");
    const fileRow = candidateRows([file], "mention", TEXTS)[0];
    assert.strictEqual(clickAction(fileRow), "pick", "点文件行 = 选中（文件没有「打开」这一说）");
    const upRow = candidateRows([up], "mention", TEXTS)[0];
    assert.strictEqual(clickAction(upRow), "pick", "「..」行仍是 pick（它的 outcome 本来就是回上一层）");
    const sessionRow = candidateRows([session], "mention", TEXTS)[0];
    assert.strictEqual(clickAction(sessionRow), "pick", "对话行 = 选中");
    console.log("completion: 点目录行 = 进目录（选中整个目录留给尾部按钮 / Enter） ✓");
  }
}
console.log("completion: Tab 进入目录 / Enter 引用整个目录 ✓");

// ---------- 8. 触发词判定：`/` 与 `@` 不是同一条规则 ----------
{
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

  assert.deepStrictEqual(findTrigger("@", 1), { kind: "mention", start: 0, query: "" });
  assert.deepStrictEqual(
    findTrigger("看一下 @src/webview", 16),
    { kind: "mention", start: 4, query: "src/webview" },
    "`@` 允许句中触发（与 `/` 同一条空白边界规则）",
  );
  // `@` 与 `/` 用的是**同一条**边界规则（行首或空白）：紧贴汉字不算触发词。
  // 这是搬家时逐字核对出来的既有行为（`findTrigger` 的 `(^|\s)` 对两者都成立），
  // 不是「应该怎样」——断言钉在这里是防止它被无意改掉。
  assert.strictEqual(findTrigger("看@src", 5), undefined, "`@` 紧贴汉字不算触发词（边界是行首或空白）");
  assert.deepStrictEqual(findTrigger("  @src", 6), { kind: "mention", start: 2, query: "src" });
  assert.strictEqual(findTrigger("mail@example.com 之后", 20), undefined, "`@` 后面跟着空白就不再是触发词");
  assert.strictEqual(findTrigger("@a b", 4), undefined, "触发词里不含空白");
  assert.strictEqual(findTrigger("草稿", 2), undefined, "没有触发词");

  // 光标在中间：只看光标**之前**的文本
  // （光标停在命令名之后头一个空格上 → 查询串已经结束，不再算触发词）
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
  // 一段文本里两个触发词：**离光标最近的那个**赢（`@` 分支先判、又必须贴着光标）
  assert.deepStrictEqual(
    findTrigger("先写 /pl 再看 @src", 11),
    { kind: "mention", start: 10, query: "" },
    "光标贴在第二个 `@` 后面时走提及通道（不是前面那个 `/pl`）",
  );
  assert.deepStrictEqual(
    findTrigger("先写 /pl 再看 @src", 6),
    { kind: "command", start: 3, query: "pl" },
    "光标回到 `/pl` 末尾时走命令通道",
  );
}
console.log("completion: 触发词判定（`/` 行首 / `@` 提及） ✓");

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
}
console.log("completion: 弹层何时出现 ✓");

/* ================= hook 的行为（真实渲染，事件走假对象） ================= */

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
  props: ReturnType<typeof useComposerCompletion>["textareaProps"];
  node: FakeTextarea;
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
    node,
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
    captured = useComposerCompletion({
      draft,
      caret,
      commands: COMMANDS,
      fileRefs: { query: draft, items: FILES, sessions: SESSIONS },
      texts: TEXTS,
      onDraft: (text) => {
        out.draft = text;
        out.written.push(text);
      },
      textareaRef: { current: node as unknown as HTMLTextAreaElement },
      ...overrides,
    });
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

/** 「事件 → 重新渲染」：用当前的 draft / caret 再渲染一帧（模拟 React 的下一帧）。 */
function nextFrame(prev: Frame, overrides: Partial<UseComposerCompletionInput> = {}): Frame {
  return frame(
    prev.draft,
    prev.caret,
    { insertRequest: undefined, ...overrides },
    prev.store,
  );
}

// ---------- 10. 草稿的两次写 + 光标在 rAF 里落 ----------
//
// 顺序与内容都是契约：先 `onDraft`（界面立刻变），再 `post({type:"setDraft"})`
// （换会话 / 重载后草稿还在）。少哪一个都会静默丢草稿。
//
// 落光标必须在 `requestAnimationFrame` 里：同步改 textarea 会有两种表现——
// 要么被 React 这次重渲染按新 prop 顶掉（光标跑回原处），要么在受控 textarea 上
// 被 React 拒绝。所以这里既断言「排了 rAF」，也放行后断言「真的落到了插入内容之后」。
{
  const f = frame("看看 @a", 6);
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
// 没有这条记忆时，选完那次 keyup 的重新探测会在同一个位置再命中 `@src/dsh/`，
// 弹层关了又弹（用户看到「列表闪一下」）。
{
  const first = frame("看看 @a", 6);
  assert.ok(first.html.includes("popover-item"), "前提：弹层开着");
  press(first, "Enter");
  assert.strictEqual(first.draft, "看看 @src/dsh/");

  const after = nextFrame(first);
  assert.strictEqual(after.html, "", "选完之后同一个位置不许再弹（否则就是「按回车列表闪一下」）");
  assert.ok(!after.html.includes("popover-item"));

  // 光标真的动了（记忆失效）→ 允许重新打开
  const moved = frame("看看 @src/dsh/", 4);
  assert.ok(moved.html.includes("popover-item"), "光标挪回 `@` 里就是新的编辑动作，弹层该回来");
}
console.log("completion(hook): 「刚选完先别重开」的记忆 ✓");

// ---------- 12. ESC 优先级链：先关弹层并 stopPropagation ----------
//
// 不 `stopPropagation` 的话，这次 ESC 会落到 App 的 window 层兜底监听上——
// 用户只是想关掉候选列表，结果把正在跑的那一轮中止了。
{
  const f = frame("@src", 4);
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
// 而第 0 条候选本来就够用——`..` 那行验 pick、`@a` 的第一条（目录）验 drill。
{
  const start = frame("@src/webview/", 13);
  // 列表第一行是 `..`（回到上一层），标题来自词典
  assert.ok(start.html.includes("popover-item-main is-priority\">.."), "顶部第一条是「..」");
  assert.ok(start.html.includes(TEXTS.mentionParent), "「..」那行的悬停说明走词典");

  // Enter（pick）在「..」行 = 回到上一层：正文只留 `@<上一层>`
  press(start, "Enter");
  assert.strictEqual(start.draft, "@src/", "「..」= 回到上一层（正文只留上一层的查询串）");

  // Tab（drill）在目录行 = 下钻：正文换成该目录的查询串（`..` 不出现，所以第 0 条就是目录）
  const tabbed = frame("@a", 2);
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
  const drilled = frame("@s", 2, { fileRefs: { query: "@s", items: winDir, sessions: [] } });
  press(drilled, "Tab");
  assert.strictEqual(drilled.draft, "@src/dsh/", "下钻：候选里的反斜杠要归一（不许写成 `@src\\dsh/`）");

  // 「..」那行同理：用户手输反斜杠时，上一层也要归一再写回正文
  const back = frame("@src\\dsh\\we", 11, { fileRefs: { query: "@src\\dsh\\we", items: winDir, sessions: [] } });
  assert.ok(back.html.includes(".."), "进到子目录后，「..」那行必须在");
  press(back, "Enter");
  assert.strictEqual(back.draft, "@src/", "回上一层：`src\\` 也要写成 `@src/`");

  // 选中带空格的目录：引号成对，且尾斜杠留在引号**内**（目录标记不能丢）
  const spaced: FileRefView[] = [{ path: "docs\\my dir", kind: "directory" }];
  const picked = frame("@d", 2, { fileRefs: { query: "@d", items: spaced, sessions: [] } });
  press(picked, "Enter");
  assert.strictEqual(picked.draft, '@"docs/my dir/"', "选中带空格目录：引号成对 + 分隔符归一");
  console.log("completion(hook): 引用文本归一化（分隔符 / 成对引号） ✓");
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

console.log("\nmentionNav: all assertions passed");
