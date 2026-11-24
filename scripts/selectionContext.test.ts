/**
 * 「编辑器当前选区」芯片（`dshChat.autoSelection`）的三条链路。
 *
 * 1. **拼接**（`appendSelectionReference`）：发送那一刻把 `@` 引用 token 追加到
 *    正文末尾——正文与 token 之间空一行、正文为空时直接是 token；
 * 2. **归约**（`reducer` 的 `ui/selectionContext` / `ui/selectionDismiss`）：
 *    宿主帧置上 / 清除、用户点掉；空态收到清除帧不许换引用（白渲染）；
 * 3. **渲染**（真渲染 `Composer`，react-dom/server）：芯片画出文件名、行号与
 *    悬停预览（中英两份词典各渲一遍，钉住「行号文案进了词典而不是写死中文」），
 *    没有那一帧时芯片整枚不出现。
 *
 * 发送动作本身（`send` 里读 `state.selectionContext`）不在这条无头链上：仓库不为
 * 测试引入 jsdom，点击模拟起不来；拼接规则与状态归约各自钉死后，剩下的只是一行
 * 接线（`Composer` 的 `send`）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appendSelectionReference } from "../src/webview/selectionContext";
import { initialState, reducer, type AppState } from "../src/webview/state";
import type { SelectionContextView } from "../src/shared/ipc";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

// `bridge.ts`（被 Composer 间接引入）在模块求值期就挂 `window.addEventListener`——
// webview 里那是真实存在的宿主。无头环境补一个最小 window，补在 import 之前。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { Composer } = await import("../src/webview/components/Composer");

const context: SelectionContextView = {
  token: "@src/config.ts#L12-L18",
  name: "src/config.ts",
  lines: { start: 12, end: 18 },
  preview: "const port = 3080;",
};

// ---------- 1. 拼接：正文 + token ----------
{
  assert.strictEqual(appendSelectionReference("帮我解释这段", context.token), `帮我解释这段\n\n${context.token}`, "正文与 token 之间空一行");
  assert.strictEqual(appendSelectionReference("", context.token), context.token, "空正文（只发附件的场景）直接是 token");
  assert.strictEqual(appendSelectionReference("第一行\n第二行", context.token), `第一行\n第二行\n\n${context.token}`, "多行正文同样只在末尾追加");
}
console.log("selectionContext: 发送拼接（正文 + 引用 token）✓");

// ---------- 2. 归约：宿主帧与用户点掉 ----------
{
  const set = reducer(initialState, { type: "ui/selectionContext", context });
  assert.strictEqual(set.selectionContext, context, "宿主帧把芯片置上");

  const cleared = reducer(set, { type: "ui/selectionContext", context: null });
  assert.strictEqual("selectionContext" in cleared, false, "清除帧把键整个拿掉（undefined = 不显示，区别于 null 过线）");

  assert.strictEqual(reducer(cleared, { type: "ui/selectionContext", context: null }), cleared, "空态再收清除帧不换引用（不白渲染）");
  assert.strictEqual(reducer(initialState, { type: "ui/selectionDismiss" }), initialState, "空态点掉是 no-op");

  const dismissed = reducer(set, { type: "ui/selectionDismiss" });
  assert.strictEqual("selectionContext" in dismissed, false, "用户点掉同样清键");
}
console.log("selectionContext: 状态归约（置上 / 清除 / 点掉）✓");

// ---------- 3. 渲染：芯片画出文件名、行号与悬停预览 ----------
{
  // React 在 server 渲染时会对 `useLayoutEffect` 打一句 warning（组件本来就不在
  // server 上跑）。只在渲染期间静音那一句，其它 error 照旧。
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0] ?? "").includes("useLayoutEffect does nothing on the server")) return;
    realError(...args);
  };
  const render = (state: AppState, locale: "zh" | "en") =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor(locale) },
        createElement(Composer, { state, onDraft: () => {} }),
      ),
    );
  try {
    const withChip = { ...initialState, connection: "ready" as const, draft: "帮我解释", selectionContext: context };
    const zh = render(withChip, "zh");
    assert.ok(zh.includes("src/config.ts"), "芯片上有文件名");
    assert.ok(zh.includes("第12-18行"), "中文行号文案来自词典");
    assert.ok(zh.includes("第12-18行") && !zh.includes("Lines 12-18"), "中文界面不出现英文行号");
    assert.ok(zh.includes("已选"), "芯片带「已选」前缀（用户 2026-11-23 口径）");
    const en = render(withChip, "en");
    assert.ok(en.includes("Lines 12-18"), "英文行号文案来自词典");
    assert.ok(en.includes("Selected"), "英文界面前缀来自词典");
    assert.ok(en.includes("Line ") === false || en.includes("Lines 12-18"), "英文区间形态正确");

    for (const html of [zh, en]) {
      assert.ok(html.includes("const port = 3080;"), "悬停 title 里有选区原文预览");
      assert.ok(html.includes(context.token), "悬停 title 里有会发出去的 token");
      assert.ok(html.includes("chip-remove"), "点掉按钮在");
    }

    // 整文件档（只有光标、没有选中）：芯片只显示文件名，不出现行号段
    const wholeFile: SelectionContextView = { token: "@src/config.ts", name: "src/config.ts", preview: "" };
    for (const [locale, html] of [
      ["zh", render({ ...initialState, connection: "ready", draft: "帮我解释", selectionContext: wholeFile }, "zh")],
      ["en", render({ ...initialState, connection: "ready", draft: "帮我解释", selectionContext: wholeFile }, "en")],
    ] as const) {
      assert.ok(html.includes("@src/config.ts"), `${locale}：悬停 title 里有整文件 token`);
      assert.ok(html.includes("已选") || html.includes("Selected"), `${locale}：前缀在`);
      assert.ok(!html.includes("第12-18行") && !html.includes("Lines 12-18"), `${locale}：没有行号段`);
      assert.ok(!/第\d+-\d+行/.test(html), `${locale}：不出现任何行号区间`);
    }

    const without = render({ ...initialState, connection: "ready" as const, draft: "hi" }, "zh");
    assert.ok(!without.includes("chip-sub") && !without.includes("src/config.ts"), "没有那一帧时芯片整枚不出现");
  } finally {
    console.error = realError;
  }
}
console.log("selectionContext: 芯片渲染（文件名 / 行号 / 预览，中英双语，整文件档）✓");

console.log("\nselectionContext: all assertions passed");
