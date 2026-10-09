/**
 * 跨视图跳转「在轨迹里查看这次调用」的离线断言（官方 `row.inspect` + `inspectCall` +
 * `viewRequest.focus` 三件套的等价物）。
 *
 * 三段各钉一件事：
 * 1. **工具行那颗按钮**（真渲染，SSR）：有 `tool.id` 且有落点回调、且**行是展开的**才
 *    渲染；缺任一样都不渲染——一颗点了没反应的按钮比没有按钮更糟。文案逐字取自官方
 *    `row.inspect`（「查看 / Inspect」）。
 * 2. **轨迹侧的落点判据**（纯函数）：`cell.callId === focus` 找唯一那条，找不到就是
 *    `undefined`——调用方据此**什么都不做**、把请求留着等账本补齐（官方
 *    「Not-found leaves the request pending」）。
 * 3. **两端的入参与接线**：按钮点的回调带的是**调用 id**；`App` → `Message` → `ToolRow`
 *    这一路真的接上了，轨迹侧接住时既选中也滚过去。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 最小 `window`：`bridge.ts` 在模块求值期就挂了 `window.addEventListener`
 * （webview 里那是真实存在的宿主），无头环境里不给它一个就会在 import 阶段炸。
 * **必须补在静态 import 之前**——所以碰 `window` 的模块一律走下面的动态 `import`
 * （与 `scripts/trajectoryPre.test.ts` / `questionRender.test.ts` 同一套解法）。
 */
(globalThis as { window?: unknown }).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { ToolRow } = (await import("../src/webview/components/Rows")) as unknown as {
  ToolRow: ComponentType<{
    tool: unknown;
    node: unknown;
    onInspectCall?: (callId: string) => void;
  }>;
};
const { TextsContext, dictionaryFor } = (await import("../src/webview/texts")) as {
  TextsContext: { Provider: ComponentType<{ value: unknown; children?: unknown }> };
  dictionaryFor: (locale: "zh" | "en") => unknown;
};
const { nodePortOf, withNodeOpen, NO_NODE_OPEN } = (await import("../src/webview/nodeOpen")) as {
  nodePortOf: (state: unknown, id: string, update: (next: unknown) => unknown) => unknown;
  withNodeOpen: (state: unknown, id: string, open: boolean, whileActive: boolean) => unknown;
  NO_NODE_OPEN: unknown;
};
const { trajectoryCallCellIndex } = (await import("../src/webview/trajectoryDisplay")) as {
  trajectoryCallCellIndex: (
    turns: readonly { turn: number | null; groups: { title: unknown; cells: unknown[] }[] }[],
    callId: string,
  ) => number | undefined;
};

const ZH = dictionaryFor("zh");
const EN = dictionaryFor("en");

/** 一份最小的工具调用（只放这条链路要用到的字段）。 */
const tool = (extra: Record<string, unknown> = {}) => ({
  id: "call_1",
  name: "read",
  title: "读取 package.json",
  status: "ok",
  ...extra,
});

/**
 * 渲染一个工具行。
 *
 * 展开态走真实端口（`nodePortOf`）：`Row` 只在展开时渲染 children，而官方那颗按钮就
 * 长在展开区底部——所以「收起态不渲染」是**结构**保证的，这里两种态都渲一遍来钉它。
 * 端口用真件而不是桩：桩出来的形状一旦与真件漂移，断言就变成了在测桩。
 */
function render(toolValue: unknown, onInspectCall?: (callId: string) => void, open = true): string {
  const state = open ? withNodeOpen(NO_NODE_OPEN, "seg-1", true, false) : NO_NODE_OPEN;
  const port = nodePortOf(state, "seg-1", (next) => next);
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: ZH },
      createElement(ToolRow, {
        tool: toolValue,
        node: port,
        ...(onInspectCall === undefined ? {} : { onInspectCall }),
      }),
    ),
  );
}

// ---------- 1. 工具行那颗「查看」按钮 ----------
{
  const html = render(tool(), () => undefined);
  assert.ok(
    /class="btn btn-ghost row-inspect"/.test(html),
    `展开区里要有那颗「查看」按钮，实际渲染：${html.slice(0, 240)}`,
  );
  assert.ok(/>查看</.test(html), "中文文案逐字用官方 `row.inspect` 那句「查看」");
  assert.ok(/title="在轨迹里查看这次调用"/.test(html), "悬停说明要说清是去哪儿看");

  // 英文同样要出（双语文案硬规则）
  const en = renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: EN },
      createElement(ToolRow, {
        tool: tool(),
        node: nodePortOf(withNodeOpen(NO_NODE_OPEN, "seg-1", true, false), "seg-1", (next) => next),
        onInspectCall: () => undefined,
      }),
    ),
  );
  assert.ok(/>Inspect</.test(en) && /title="Inspect this call in the trajectory"/.test(en), "英文译文齐备");

  // 缺 `tool.id`（调用在窗口之外、只有结果那种补出来的行）→ 整颗不渲染：
  // 没有 id 就无从定位，给了只会是一颗点了没反应的按钮
  const withoutId = render(tool({ id: undefined }), () => undefined);
  assert.ok(!/row-inspect/.test(withoutId), "没有调用 id 的行不许出这颗按钮");

  // 没有落点回调（宿主没接这条链路）→ 同样不渲染
  assert.ok(!/row-inspect/.test(render(tool())), "没有落点回调时不许出这颗按钮");

  // 收起态（`Row` 不渲染 children）→ 不渲染
  assert.ok(!/row-inspect/.test(render(tool(), () => undefined, false)), "收起态不渲染展开体，按钮自然不在");
}

console.log("inspectCall: 工具行的「查看」按钮（两样缺一就不出、双语齐备） ✓");

// ---------- 2. 轨迹侧的落点判据（官方 `record.cell.callId === inspectCallId`） ----------
{
  const turns = [
    {
      turn: 0,
      groups: [
        {
          title: { kind: "step", step: 1 },
          cells: [
            { index: 1, kind: "tool", callId: "call_1" },
            { index: 2, kind: "subtool", callId: "call_1:ptc:1" },
            { index: 3, kind: "message" },
            { index: 4, kind: "tool" },
          ],
        },
      ],
    },
  ] as never;

  assert.strictEqual(trajectoryCallCellIndex(turns, "call_1"), 1, "按 callId 找到那一条");
  assert.strictEqual(trajectoryCallCellIndex(turns, "call_1:ptc:1"), 2, "子工具行同样找得到");
  assert.strictEqual(
    trajectoryCallCellIndex(turns, "call_missing"),
    undefined,
    "找不到就是 undefined（调用方据此什么都不做、把请求留着等账本补齐）",
  );
  assert.strictEqual(
    trajectoryCallCellIndex(turns, "call_1:ptc"),
    undefined,
    "前缀相同但不是同一个 id：不许按前缀模糊匹配（会跳到别的调用上）",
  );
  assert.strictEqual(trajectoryCallCellIndex([], "call_1"), undefined, "空账本不抛错（历史还没到）");
}

console.log("inspectCall: 轨迹侧的落点判据（找不到就留着请求） ✓");

// ---------- 3. 入参口径与两端接线（读源码：这条路跨了四个文件） ----------
{
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

  const rows = read("src", "webview", "components", "Rows.tsx");
  assert.ok(
    /onClick=\{\(\) => onInspectCall\(tool\.id\)\}/.test(rows),
    "按钮点的回调带的是**调用 id**（给工具名或事件对象都不对）",
  );

  const app = read("src", "webview", "App.tsx");
  assert.ok(/onInspectCall=\{inspectCall\}/.test(app), "App 要把落点交给消息行");
  assert.ok(
    /const inspectCall = \(callId: string\): void => \{[\s\S]{0,400}?setPanel", panel: "trajectory"[\s\S]{0,200}?listTrajectory/.test(app),
    "落点要切到轨迹视图并立刻取一份账本（只切面板会让第一次跳转落在可能还没有账本的页上）",
  );
  assert.ok(
    /focusCallId === undefined \? \{\} : \{ focusCallId \}/.test(app),
    "待办目标要交给轨迹视图",
  );
  assert.ok(
    /if \(state\.panel === "trajectory"\) return;[\s\S]{0,160}setFocusCallId/.test(app),
    "离开轨迹视图要清掉待办目标（否则下次进来会莫名跳一次）",
  );
  assert.ok(/focusSessionRef/.test(app), "切会话要清掉待办目标（callId 只在同一个会话里唯一）");

  const message = read("src", "webview", "components", "Message.tsx");
  assert.ok(
    /onInspectCall === undefined \? \{\} : \{ onInspectCall \}/.test(message),
    "Message 要把落点透给工具行",
  );

  const display = read("src", "webview", "trajectoryDisplay.ts");
  assert.ok(
    /export function trajectoryCallCellIndex/.test(display),
    "落点判据要在 `trajectoryDisplay.ts` 里（「一行显示什么」那一层是唯一出处，也才钉得住）",
  );

  const view = read("src", "webview", "components", "Trajectory.tsx");
  assert.ok(
    /port\.inspectCall\(focusCallId\)/.test(view),
    "会话侧给的 callId 要进端口：pending 由端口唯一拥有（App 不再自己记着它有没有被消费）",
  );
  assert.ok(
    /const pending = port\.state\.pendingCallId;[\s\S]{0,220}?trajectoryCallCellIndex\(turns, pending\)/.test(view),
    "轨迹侧要**用**那份判据（官方 `record.cell.callId === inspectCallId` 同一判据）",
  );
  assert.ok(
    /if \(index === undefined\) return;[\s\S]{0,160}?port\.resolveFocus\(index\)/.test(view),
    "命中时选中 + 滚动 + ack 由端口一次做完（只选中不滚，用户看不到落点）",
  );
  assert.ok(
    /if \(port\.resolveFocus\(index\)\) onFocusApplied\?\.\(\)/.test(view),
    "命中才回调父级清请求（官方 `onInspectApplied`）：不 ack 会在账本换身份时重放",
  );
  assert.ok(
    /if \(index === undefined\) return;/.test(view),
    "落点解不出来时什么都不做（把请求留着，等账本补齐）",
  );
  assert.ok(
    /onFocusApplied=\{\(\) => setFocusCallId\(undefined\)\}/.test(app),
    "App 收到 ack 才清请求——下一次点同一次调用又是一件新事",
  );
}

console.log("inspectCall: 入参口径与两端接线（App → Message → ToolRow，轨迹侧接住） ✓");

console.log("\ninspectCall: all assertions passed");
