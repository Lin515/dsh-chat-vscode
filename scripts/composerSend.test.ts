/**
 * 发送按钮的手势链路：按住 Ctrl / Cmd 时，按钮文字与**实际发出去的手势**都跟着切。
 *
 * 用户 2026-10-10 口径：生成中 Ctrl/Cmd+Enter 已经能切换排队 / 插话（键盘那条路在
 * `composerCompletion.tsx`，由 `mentionNav.test.ts` 的第 14 节守着，本任务不动它）；
 * 发送按钮要跟它**同一条判据**——按住修饰键时按钮文字换成这一次真会走的那条路
 * （默认 queue 时按住显示「插话发送」，默认 steer 时按住显示「排队发送」），
 * 按住修饰键点按钮发的是 `accelerated`。空闲照旧发送、运行中无草稿照旧是停止
 * （不把停止改成发送）。判定只有一份，在 `webview/composerSend.ts`。
 *
 * 四层各钉一段，最后一段把它们扣在一起：
 * 1. **手势判定**（`submitGesture`）：Ctrl / Cmd 一条判据，点击这条链用它；
 * 2. **键盘链**（`watchModifierKeys`）：把监听真的接出来、**真的喂事件**——
 *    keydown / keyup 判修饰键、失焦一律按「没按」（按住态的全部三个边界）；
 * 3. **点击链**（`clickGestureHandler`）：事件 → 手势 → **真的落到宿主帧**，
 *    且同一个处理器先后收到不同事件时结果跟着事件走（证明读的是事件本身，
 *    不是渲染期那份可能过期的 state）；
 * 4. **渲染链**（`react-dom/server` 真渲染 `Composer`）：工具栏里真的画出那枚按钮，
 *    渲染出的文字 / 悬停 / 停止态与共享判定 `sendButtonView` 的输出**逐字相同**——
 *    「按住态」那一档在无头环境起不来（它是组件本地 state，SSR 不跑 effect），
 *    那一档由第 5 节的同一函数表覆盖；「渲染结果 === 函数输出」把两条链扣住。
 *
 * 本仓库没有 jsdom（不为测试引入依赖），事件用最小面喂：键盘链接
 * `{ addEventListener, removeEventListener }`，点击链接一个「事件 → 手势」的工厂。
 * 两者都是组件里**实际在用**的那一份，本回归直接调它。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  busySubmitIntent,
  clickGestureHandler,
  sendButtonView,
  submitGesture,
  watchModifierKeys,
  type ModifierEvent,
  type SubmitGesture,
} from "../src/webview/composerSend";
import { TextsContext, dictionaryFor } from "../src/webview/texts";
import { initialState, type AppState } from "../src/webview/state";

// `bridge.ts`（被 Composer 间接引入）在模块求值期就挂 `window.addEventListener`——
// webview 里那是真实存在的宿主。无头环境补一个最小 window，补在 import 之前。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { Composer } = await import("../src/webview/components/Composer");

const zh = dictionaryFor("zh");
const en = dictionaryFor("en");

// ---------- 1. 手势判定：Ctrl / Cmd 一条判据 ----------
//
// 键盘那条路（`composerCompletion.tsx`，本任务不改）与按钮这条路必须得出同一个手势；
// 这里钉的是判据本身：任意一边的 `ctrlKey` / `metaKey` 为真就是加速手势。
{
  assert.strictEqual(submitGesture({ ctrlKey: true }), "accelerated", "Ctrl = 加速手势");
  assert.strictEqual(submitGesture({ metaKey: true }), "accelerated", "Cmd = 加速手势（macOS）");
  assert.strictEqual(submitGesture({ ctrlKey: true, metaKey: true }), "accelerated", "两个都按也是加速");
  assert.strictEqual(submitGesture({ ctrlKey: false, metaKey: false }), "enter", "没按修饰键 = 主手势");
  assert.strictEqual(submitGesture({}), "enter", "事件上没有修饰键字段（普通点击）= 主手势");
  console.log("composerSend: Ctrl / Cmd 手势判定 ✓");
}

// ---------- 2. 运行中主按钮这一次走哪条路：与宿主 resolveSubmitMode 同口径 ----------
//
// 宿主（`src/dsh/controller.ts` 的 `resolveSubmitMode`）：空闲恒 queue；运行中主手势用
// `busyEnter` 设置值、加速手势取**反面**。这里算的是「按钮该显示什么」，**不是**发出
// 去的模式——`send` 帧永远只带手势，模式由宿主按「按下那一刻在不在跑」解析。
{
  const table: [AppState["busyEnter"], SubmitGesture, "queue" | "steer"][] = [
    [undefined, "enter", "queue"],
    ["queue", "enter", "queue"],
    ["steer", "enter", "steer"],
    [undefined, "accelerated", "steer"],
    ["queue", "accelerated", "steer"],
    ["steer", "accelerated", "queue"],
  ];
  for (const [busyEnter, gesture, expected] of table) {
    assert.strictEqual(
      busySubmitIntent(busyEnter, gesture),
      expected,
      `busyEnter=${String(busyEnter)} 手势=${gesture} 应当走 ${expected}`,
    );
  }
  console.log("composerSend: 运行中走哪条路（加速手势取反）✓");
}

// ---------- 3. 键盘链：真的接上监听，真的喂事件 ----------
//
// 按住态的**全部来源**就在这里：keydown / keyup 各判一次修饰键，窗口失焦一律按「没按」
// （切到别的应用时键盘状态不再可靠，留着按住态会让按钮一直显示插话文案）。
{
  type Listener = (event: Event) => void;
  const listeners = new Map<string, Listener>();
  const attached: string[] = [];
  const detached: string[] = [];
  const target = {
    addEventListener(type: string, listener: Listener) {
      attached.push(type);
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: Listener) {
      detached.push(type);
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  /** 无头环境没有真的 `KeyboardEvent` / `FocusEvent`：喂只带修饰键的最小面。 */
  const key = (fields: ModifierEvent) => fields as unknown as Event;
  const seen: boolean[] = [];
  const detach = watchModifierKeys(target, (held) => seen.push(held));
  assert.deepStrictEqual(
    [...attached].sort(),
    ["blur", "keydown", "keyup"],
    "三条监听都要接上（少一条就有一种边界失灵）",
  );

  listeners.get("keydown")?.(key({ ctrlKey: true }));
  listeners.get("keyup")?.(key({ ctrlKey: false }));
  listeners.get("keydown")?.(key({ metaKey: true }));
  listeners.get("keyup")?.(key({ metaKey: false }));
  listeners.get("keydown")?.(key({})); // 普通打字（没按修饰键）
  listeners.get("blur")?.(key({})); // 窗口失焦
  assert.deepStrictEqual(
    seen,
    [true, false, true, false, false, false],
    "keydown 按下 → true；keyup 松开 → false；Cmd 同理；普通按键与失焦 → false",
  );

  detach();
  assert.deepStrictEqual([...detached].sort(), ["blur", "keydown", "keyup"], "卸载要摘掉三条监听");
  assert.strictEqual(listeners.size, 0, "摘干净了（不留悬挂监听）");
  console.log("composerSend: 键盘按住态 keydown / keyup / blur ✓");
}

// ---------- 4. 点击链：事件 → 手势 → 真的落到宿主的那一帧 ----------
//
// 链路的末端走**真的 `post`**（`bridge.ts`）：把 `acquireVsCodeApi` 换成替身，断言最终
// 进宿主的帧。组件里的发送动作是 `send`（读草稿 / 附件后 post 一条 `send` 帧），这里用
// 同一个帧形状：手势怎么选是这一节的事，其余字段在上面的接线一节里钉住不许动。
{
  const frames: { type: string; gesture?: string; text?: string }[] = [];
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => {
      frames.push(message as { type: string; gesture?: string; text?: string });
    },
    setState: () => {},
  });
  const { post } = await import("../src/webview/bridge");
  const send = (gesture: SubmitGesture) => post({ type: "send", text: "hi", attachments: [], gesture });

  const onClick = clickGestureHandler(send);
  onClick({ ctrlKey: true });
  onClick({ metaKey: true });
  onClick({});
  // 同一个处理器：结果跟着**这一次事件**走，而不是某次渲染时记下的按住态
  onClick({ ctrlKey: false });
  onClick({ ctrlKey: true });

  assert.deepStrictEqual(
    frames.map((frame) => frame.gesture),
    ["accelerated", "accelerated", "enter", "enter", "accelerated"],
    "按住 Ctrl / Cmd 点按钮 = 加速手势，与键盘一致；没按住 = 主手势",
  );
  assert.ok(
    frames.every((frame) => frame.type === "send"),
    "落到宿主的都是 send 帧",
  );
  assert.ok(
    frames.every((frame) => !("mode" in frame)),
    "帧里不许出现 mode：它是手势，模式由宿主按 busyEnter + 按下那一刻是否在跑解析",
  );
  console.log("composerSend: 点击手势读事件本身（ctrlKey / metaKey）✓");
}

// ---------- 5. 文案表：运行中按手势切、空闲恒「发送」、无草稿恒「停止」----------
{
  for (const [busyEnter, held, expected] of [
    ["queue", false, zh.sendQueue],
    ["queue", true, zh.sendSteer],
    ["steer", false, zh.sendSteer],
    ["steer", true, zh.sendQueue],
  ] as const) {
    const view = sendButtonView({ running: true, canSend: true, busyEnter, modifierHeld: held, texts: zh });
    assert.strictEqual(view.kind, "send", "有草稿时是发送按钮");
    assert.strictEqual(
      view.label,
      expected,
      `运行中 busyEnter=${busyEnter} 按住修饰键=${held} 时必须预告这一次真会走的那条路`,
    );
    assert.strictEqual(view.title, expected, "悬停与按钮文字同一个口径");
  }

  // 空闲：设置值不参与，按住修饰键也不参与（它就是一次普通发送）
  for (const busyEnter of ["queue", "steer"] as const) {
    for (const held of [false, true]) {
      const view = sendButtonView({ running: false, canSend: true, busyEnter, modifierHeld: held, texts: zh });
      assert.strictEqual(view.label, zh.send, "空闲时按钮就是「发送」");
      assert.strictEqual(view.title, zh.sendTitle, "空闲时提示是「发送（Enter）」");
    }
  }

  // 运行中且草稿为空：停止，且**按住修饰键也不变成发送**（用户口径：不把停止改成发送）
  for (const held of [false, true]) {
    const view = sendButtonView({ running: true, canSend: false, busyEnter: "queue", modifierHeld: held, texts: zh });
    assert.strictEqual(view.kind, "stop", `无草稿 + 运行中 = 停止（按住修饰键=${held} 也一样）`);
    assert.strictEqual(view.title, zh.stopTitle, "停止按钮的悬停是「停止生成」");
    assert.strictEqual(view.label, "", "停止按钮上没有发送字样（它只有一枚停止图标）");
  }

  // 英文下同一套
  const englishHeld = sendButtonView({
    running: true,
    canSend: true,
    busyEnter: "queue",
    modifierHeld: true,
    texts: en,
  });
  assert.strictEqual(englishHeld.label, en.sendSteer, "英文下按住修饰键同样切到「Send as steer」");
  assert.notStrictEqual(en.sendSteer, zh.sendSteer, "两份词典确实不是同一个串（否则上一条证明不了语言链路）");
  console.log("composerSend: 运行中 / 空闲 / 停止三档文案（中英）✓");
}

// ---------- 6. 渲染链：真 Composer 画出的那枚按钮与共享判定逐字相同 ----------
/**
 * React 在 server 渲染时会对 `useLayoutEffect` 打一句 warning（组件本来就不在 server 上
 * 跑，这里只是为了把渲染链跑起来）。它只在这一段渲染期间静音，其它 error 照旧。
 */
function renderComposer(overrides: Partial<AppState>, locale: "zh" | "en" = "zh"): string {
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0] ?? "").includes("useLayoutEffect does nothing on the server")) return;
    realError(...args);
  };
  try {
    return renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor(locale) },
        createElement(Composer, {
          state: { ...initialState, connection: "ready", draft: "hi", ...overrides },
          onDraft: () => {},
        }),
      ),
    );
  } finally {
    console.error = realError;
  }
}

/** 从渲染结果里取出那枚发送按钮（工具栏本体与测量层都有，取先出现的那一枚）。 */
function sendButtonOf(html: string): { attribute: string; text: string } {
  const match = /<button (class="send-btn[^"]*"[^>]*)>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(match, `渲染结果里没有发送按钮：${html.slice(0, 400)}`);
  return { attribute: match[1] ?? "", text: (match[2] ?? "").replace(/<[^>]*>/g, "") };
}

{
  // 运行中：渲染出来的文字 / 悬停，必须与「按 busyEnter + 这次手势」算出来的那一份相同
  for (const [busyEnter, held] of [
    ["queue", false],
    ["steer", false],
    // 「按住」那一档在无头 SSR 里起不来（modifierHeld 是组件本地 state，SSR 不跑 effect）：
    // 用同一个函数的另一组输入断言（第 5 节），渲染这一侧只钉「非按住态与函数输出一致」
  ] as const) {
    const html = renderComposer({ running: true, busyEnter });
    const rendered = sendButtonOf(html);
    const expected = sendButtonView({
      running: true,
      canSend: true,
      busyEnter,
      modifierHeld: held,
      texts: zh,
    });
    assert.strictEqual(rendered.text, expected.label, `真 Composer（busyEnter=${busyEnter}）的按钮文字`);
    assert.ok(
      rendered.attribute.includes(`title="${expected.title}"`),
      `真 Composer（busyEnter=${busyEnter}）的悬停提示：${rendered.attribute}`,
    );
    assert.ok(!rendered.attribute.includes("is-stop"), "有草稿时不是停止按钮");
  }

  // 运行中 + 无草稿：真渲染出来的是停止态（带 is-stop 与停止图标），不是发送
  const stopHtml = renderComposer({ running: true, busyEnter: "queue", draft: "" });
  const stop = sendButtonOf(stopHtml);
  assert.ok(/class="send-btn is-stop"/.test(stop.attribute), "无草稿 + 运行中渲染成停止按钮");
  assert.ok(stop.attribute.includes(`title="${zh.stopTitle}"`), "并且悬停是「停止生成」");
  assert.strictEqual(stop.text, "", "停止按钮上不出现发送文字");

  // 空闲 + 无草稿：是发送按钮但不可点（与改动前一致）
  const idle = sendButtonOf(renderComposer({ running: false, busyEnter: "queue", draft: "" }));
  assert.strictEqual(idle.text, zh.send, "空闲时按钮文字是「发送」");
  assert.ok(idle.attribute.includes("disabled"), "没有草稿时不可点");
  console.log("composerSend: 真 Composer 渲染出的按钮与共享判定逐字相同 ✓");
}

// ---------- 7. 接线：组件真的用了那一份（语义都在上面测过） ----------
//
// 这三条读源码，是因为无头环境起不了组件的事件（没有 jsdom）：语义（手势判定、文案表、
// 按住态来源）都在前面用真调用钉住了，这里只钉「组件真的用了那一份」，防止以后有人把
// 规则在组件里再抄一遍（抄出来的那份不会被任何断言覆盖）。
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /watchModifierKeys\(window, setModifierHeld\)/.test(composer),
    "Composer 的按住态必须来自共享的键盘链（keydown / keyup / blur 三条已在第 3 节真喂过）",
  );
  assert.ok(
    /sendButtonView\(\{[\s\S]{0,300}?modifierHeld,/.test(composer),
    "按住态要**真的**交给文案判定（写死 false 就等于没接：文字永远不切）",
  );
  assert.ok(
    /onClick=\{clickGestureHandler\(send\)\}/.test(composer),
    "发送按钮的点击必须把事件交给 clickGestureHandler（事件 → 手势），不许写死手势",
  );
  assert.ok(
    /post\(\{ type: "send", text: draft\.trim\(\), attachments: state\.attachments, gesture \}\)/.test(composer),
    "send 帧仍然只带 gesture：模式由宿主按 busyEnter + 按下那一刻是否在跑解析，界面不算模式",
  );
  assert.ok(
    /sendButtonView\(\{/.test(composer),
    "按钮的文字 / 悬停 / 停止态走共享判定 sendButtonView（第 5、6 节测的就是它）",
  );
  console.log("composerSend: 组件接线（按住态来源 / 点击手势 / 只发手势）✓");
}

console.log("\ncomposerSend: all assertions passed");
