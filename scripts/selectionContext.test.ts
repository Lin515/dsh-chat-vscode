/**
 * 「编辑器当前选区」芯片（`dshChat.autoSelection`，评审 2026-11-24 口径）的几条链路。
 *
 * 1. **引用折算**（`relativeMentionPath`）：按目标会话的执行目录折相对路径，
 *    目录之外（多根同名、`..` 越界、空目录）一律 undefined = 不自动附带；
 * 2. **发送拼接**（`appendAutoReference`）：正文与引用之间空一行，空正文直接是
 *    引用——宿主在命令识别**之后**才拼（见 `selectionSend.test.ts`）；
 * 3. **三档开关**（`parseAutoSelectionMode`）：合法档位原样收下，旧布尔按迁移表
 *    翻（true → file、false → off），其余回默认 `selection`；
 * 4. **归约**（`reducer` 的 `ui/selectionContext` / `ui/selectionDismiss`）：
 *    宿主帧置上 / 清除、用户点掉；空态收到清除帧不许换引用（白渲染）；
 * 5. **渲染**（真渲染 `Composer`，react-dom/server）：芯片直接显示**实际会发出去**
 *    的引用 token（显示与发送共用同一个值，评审设计建议），悬停给选区原文预览；
 *    没有那一帧时芯片整枚不出现。
 *
 * 投递归属、命令安全与取消回填是**行为**链路，见 `selectionSend.test.ts`
 * （驱动真控制器）；这里钉纯函数与界面。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appendAutoReference, relativeMentionPath } from "../src/shared/mentions";
import { parseAutoSelectionMode } from "../src/shared/autoSelection";
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
  id: 1,
  token: "@src/config.ts#L12-L18",
  preview: "const port = 3080;",
};
/** 带空格的路径：实际发送形态带成对引号（SSR 会把 `"` 转义，断言按转义后比对）。 */
const quotedContext: SelectionContextView = {
  id: 2,
  token: '@"src/my file.ts"#L12-L18',
  preview: "",
};

// ---------- 1. 引用折算：按目标会话的执行目录 ----------
{
  assert.strictEqual(relativeMentionPath("C:\\work\\demo", "C:\\work\\demo\\src\\a.ts"), "src/a.ts", "Windows 目录与反斜杠文件路径折成 `@` 语法所需的正斜杠相对路径");
  assert.strictEqual(relativeMentionPath("/w/demo", "/w/demo/src/a.ts"), "src/a.ts", "POSIX 目录之下照折");
  assert.strictEqual(relativeMentionPath("/w/demo/", "/w/demo/a.ts"), "a.ts", "目录尾分隔符不参与比对");
  assert.strictEqual(relativeMentionPath("/w/demo", "/w/other/src/a.ts"), undefined, "另一个根（多根工作区）不给引用——字符串层面证明不了 Agent 读得到同一文件");
  assert.strictEqual(relativeMentionPath("/w/demo", "/w/demo/../escape/a.ts"), undefined, "前缀撞上但相对段越界（..）不引用");
  assert.strictEqual(relativeMentionPath("/w/demo", "/w/demox/a.ts"), undefined, "目录前缀是别名的开头（demo 与 demox）不算同目录");
  assert.strictEqual(relativeMentionPath("", "/w/demo/a.ts"), undefined, "没有目录证据不猜");
  // 多根同名文件：两个根各有一个 src/config.ts，只有「目标会话的那个根」折得出来
  assert.strictEqual(relativeMentionPath("/w/alpha", "/w/alpha/src/config.ts"), "src/config.ts");
  assert.strictEqual(relativeMentionPath("/w/beta", "/w/alpha/src/config.ts"), undefined, "目标会话在 beta 根时，alpha 根的同名文件不自动附带");
}
console.log("selectionContext: 按会话执行目录折引用（多根 / 越界 / 空目录不附带）✓");

// ---------- 2. 发送拼接：正文 + 引用 ----------
{
  assert.strictEqual(appendAutoReference("帮我解释这段", context.token), `帮我解释这段\n\n${context.token}`, "正文与引用之间空一行");
  assert.strictEqual(appendAutoReference("", context.token), context.token, "空正文（只发附件的场景）直接是引用");
  assert.strictEqual(appendAutoReference("第一行\n第二行", context.token), `第一行\n第二行\n\n${context.token}`, "多行正文同样只在末尾追加");
}
console.log("selectionContext: 发送拼接（正文 + 引用，宿主在命令识别后拼）✓");

// ---------- 3. 三档开关：合法档位、旧布尔迁移、未知回默认 ----------
{
  assert.strictEqual(parseAutoSelectionMode("off"), "off");
  assert.strictEqual(parseAutoSelectionMode("selection"), "selection");
  assert.strictEqual(parseAutoSelectionMode("file"), "file");
  assert.strictEqual(parseAutoSelectionMode(undefined), "selection", "未设置回默认档");
  assert.strictEqual(parseAutoSelectionMode("whatever"), "selection", "拼错回默认档");
  assert.strictEqual(parseAutoSelectionMode(true), "file", "旧布尔 true = 选区或整文件（迁移）");
  assert.strictEqual(parseAutoSelectionMode(false), "off", "旧布尔 false = 关闭（迁移）");
}
console.log("selectionContext: 三档开关（含旧布尔迁移）✓");

// ---------- 4. 归约：宿主帧与用户点掉 ----------
{
  const set = reducer(initialState, { type: "ui/selectionContext", context });
  assert.strictEqual(set.selectionContext, context, "宿主帧把芯片置上");

  const cleared = reducer(set, { type: "ui/selectionContext", context: null });
  assert.strictEqual("selectionContext" in cleared, false, "清除帧把键整个拿掉（undefined = 不显示，区别于 null 过线）");

  assert.strictEqual(reducer(cleared, { type: "ui/selectionContext", context: null }), cleared, "空态再收清除帧不换引用（不白渲染）");
  const dismiss = { type: "ui/selectionDismiss", id: context.id } as const;
  assert.strictEqual(reducer(initialState, dismiss), initialState, "空态点掉是 no-op");
  const reselection = reducer(set, { type: "ui/selectionContext", context: { ...context, id: context.id + 1 } });
  assert.strictEqual(reducer(reselection, dismiss), reselection, "旧点击不撤下 token 相同、投递标识不同的芯片");

  const dismissed = reducer(set, dismiss);
  assert.strictEqual("selectionContext" in dismissed, false, "用户点掉同样清键");
}
console.log("selectionContext: 状态归约（置上 / 清除 / 点掉）✓");

// ---------- 5. 渲染：芯片显示实际发送的引用（中英同值），悬停给原文预览 ----------
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
  const chipTitle = (html: string): string => /class="chip" title="([^"]*)"/u.exec(html)?.[1] ?? "";
  try {
    const withChip = { ...initialState, connection: "ready" as const, draft: "帮我解释", selectionContext: context };
    const zh = render(withChip, "zh");
    const en = render(withChip, "en");
    for (const [locale, html] of [
      ["zh", zh],
      ["en", en],
    ] as const) {
      assert.ok(html.includes(context.token), `${locale}：芯片显示的就是实际会发出去的引用（含引号与行号区间）`);
      assert.ok(chipTitle(html).includes(context.token), `${locale}：悬停 title 里有完整的发送 token`);
      assert.ok(chipTitle(html).includes(context.preview), `${locale}：悬停 title 里有选区原文预览`);
      assert.ok(html.includes("chip-remove"), `${locale}：点掉按钮在`);
      assert.ok(!html.includes("第12-18行") && !html.includes("Lines 12-18"), `${locale}：不再把文件名与行号拆开显示（显示即发送的 token）`);
    }
    assert.ok(zh.includes("已选"), "中文界面带「已选」前缀");
    assert.ok(en.includes("Selected"), "英文界面带「Selected」前缀");
    assert.strictEqual(
      /chip-name">([^<]*)</u.exec(zh)?.[1],
      /chip-name">([^<]*)</u.exec(en)?.[1],
      "引用 token 不随界面语言变：显示与发送共用同一个值",
    );

    // 带空格的路径：按实际发送形态（成对引号）显示，不拆开、不去引号
    const escapedToken = "@&quot;src/my file.ts&quot;#L12-L18";
    const wholeFile: SelectionContextView = { id: 3, token: "@src/config.ts", preview: "" };
    for (const locale of ["zh", "en"] as const) {
      const quoted = render({ ...withChip, selectionContext: quotedContext }, locale);
      assert.ok(quoted.includes(`class="chip-name">${escapedToken}<`), `${locale}：带空格路径按实际发送形态显示`);
      assert.ok(chipTitle(quoted).includes(escapedToken), `${locale}：悬停保留带空格引用的完整引号与行号`);

      // 整文件档（`file` 档、只有光标）：token 没有 `#L` 段，照原样显示；不需要预览也能悬停读全。
      const whole = render({ ...withChip, selectionContext: wholeFile }, locale);
      assert.ok(whole.includes(`class="chip-name">${wholeFile.token}<`), `${locale}：整文件引用照原样显示`);
      assert.ok(chipTitle(whole).includes(wholeFile.token), `${locale}：无预览的整文件引用悬停也显示全文`);
      assert.ok(!whole.includes("#L"), `${locale}：整文件档不出现行号段`);
    }

    // 单行档：宿主折出的 token 就是 `#L12` 形态，显示与发送同值（评审测试小项：
    // 单行形态独立验证，不靠区间档顺带）
    const singleLine: SelectionContextView = { id: 4, token: "@src/a.ts#L12", preview: "x" };
    const single = render({ ...initialState, connection: "ready", draft: "hi", selectionContext: singleLine }, "en");
    assert.ok(single.includes("@src/a.ts#L12"), "单行引用按实际发送形态显示（#L12）");

    const without = render({ ...initialState, connection: "ready" as const, draft: "hi" }, "zh");
    assert.ok(!without.includes("chip-sub") && !without.includes("src/config.ts"), "没有那一帧时芯片整枚不出现");
  } finally {
    console.error = realError;
  }
}
console.log("selectionContext: 芯片渲染（显示即发送的 token，中英同值，整文件 / 单行档）✓");

console.log("\nselectionContext: all assertions passed");
