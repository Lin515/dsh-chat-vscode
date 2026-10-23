/**
 * 会话右键菜单（全界面接管）的判据、「引用」的落点算术、保存的建议文件名。
 *
 * 契约（用户 2026-09-23 口径）：
 *  - 原生菜单（剪切 / 复制 / 粘贴）**全界面拦掉**；只有「右键压在自己选中的文字上」
 *    才放行——那时那里的 Copy 才真的有用；
 *  - 会话正文区里右键 → 自绘「复制 / 引用」；图片（任何地方）→ 自绘「复制 / 保存」；
 *  - **可编辑元素一律放行原生菜单**：自绘菜单做不了粘贴，吃掉它等于把粘贴删掉。
 *
 * 这些判据都是纯函数（`contextMenuKind` / `quoteBlock`），所以能离线逐条断言：
 * 它们错了的现场是「右键弹出无关菜单」「粘贴没了」，靠手点很难每次回归都覆盖。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import type { ContextMenuProbe } from "../src/webview/contextMenu";

// `contextMenu` 连带 `bridge.ts`（还有它 import 的 `state.ts`）在模块求值期碰 `window`：
// 无头环境先补最小 window（外加 `acquireVsCodeApi`）、再动态 import
// （理由与 `pathInsert.test.ts` 同一处注释）。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
const POSTED: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => POSTED.push(message),
});
const { contextMenuKind, suggestedFileName, chatSelectionText, handleChatCopy } = await import("../src/webview/contextMenu");
const { quoteBlock } = await import("../src/webview/composerCompletion");

/** 默认探针：正文区里选中了一段文字（最常见的形态）。 */
function probe(overrides: Partial<ContextMenuProbe> = {}): ContextMenuProbe {
  return {
    editable: false,
    image: false,
    inChat: true,
    selectedText: "选中的话",
    onSelection: true,
    ...overrides,
  };
}

// ---------- 1. 判定矩阵 ----------

// 正文区里选中文字 → 自绘的「复制 / 引用」
assert.strictEqual(contextMenuKind(probe()), "text");

// 正文区里没有选区 → 拦下且不弹（原来那三条没有一条能用）
assert.strictEqual(contextMenuKind(probe({ selectedText: "", onSelection: false })), "blocked");

// 图片优先于文字：图就是图，哪怕旁边选着一段字
assert.strictEqual(contextMenuKind(probe({ image: true })), "image");
assert.strictEqual(
  contextMenuKind(probe({ image: true, selectedText: "", onSelection: false })),
  "image",
  "正文里的图没选中文字时也给图片菜单",
);
assert.strictEqual(
  contextMenuKind(probe({ inChat: false, selectedText: "", onSelection: false, image: true })),
  "image",
  "子代理记录等处的图同样给「复制 / 保存」",
);

// 可编辑元素（输入框 / 问卷填空 / 目标编辑框）永远放行原生菜单——粘贴只在那里有意义。
// 这一条优先于一切。
assert.strictEqual(contextMenuKind(probe({ editable: true })), "native");
assert.strictEqual(contextMenuKind(probe({ editable: true, image: true })), "native");
assert.strictEqual(
  contextMenuKind(probe({ editable: true, selectedText: "", onSelection: false })),
  "native",
);

// 正文区之外（头部、历史抽屉、子代理 / 后台任务面板、轨迹页……）：**没选中文字就拦掉**
// （原来那些「剪切 / 复制 / 粘贴」在这儿一条都用不上）
assert.strictEqual(
  contextMenuKind(probe({ inChat: false, selectedText: "", onSelection: false })),
  "blocked",
  "正文区之外、又没选中文字：拦掉原生菜单",
);

// **右键压在自己选中的文字上**才放行（那时原生菜单里的 Copy 真的有用）
assert.strictEqual(
  contextMenuKind(probe({ inChat: false, selectedText: "", onSelection: true })),
  "native",
  "选中文字后在这段文字上右键：放行原生菜单",
);
// 正文区里即使压着选区也走自绘菜单（正文区是我们特化的地方）
assert.strictEqual(contextMenuKind(probe({ onSelection: true })), "text");

console.log("contextMenu: 判定矩阵 ✓");

// ---------- 2. 「引用」的落点算术（引用块自己占整行） ----------

// 空草稿：引用块独占一行，光标落在它**下面**（接着敲的字不会被并进引用里）
{
  const result = quoteBlock("", "这句话有问题", 0);
  assert.strictEqual(result.value, "> 这句话有问题\n");
  assert.strictEqual(result.caret, result.value.length, "光标落在引用块之后");
  assert.strictEqual(result.value.slice(result.caret), "", "引用块之后不再有内容");
}

// 已有草稿且光标在末尾、上一行不是行首：先换行，再成块
{
  const result = quoteBlock("先写一句", "原文", 4);
  assert.strictEqual(result.value, "先写一句\n> 原文\n");
  assert.strictEqual(result.value.slice(0, result.caret), "先写一句\n> 原文\n");
}

// 光标在行中间：引用块插在原地，**它后面原有的文字另起一行**（不会被并进引用）
{
  const result = quoteBlock("前面后面", "原文", 2);
  assert.strictEqual(result.value, "前面\n> 原文\n后面");
  assert.strictEqual(result.value.slice(result.caret), "后面", "光标之后是原来的文字，另起一行");
}

// 后面已经是换行时不重复补一个（否则会多出一个空行）
{
  const result = quoteBlock("前面\n后面", "原文", 3);
  assert.strictEqual(result.value, "前面\n> 原文\n后面");
}

// 多行选中：每一行各自带 `>`；中间的空行也带（裸空行会把引用块切断）
{
  const result = quoteBlock("", "第一行\n\n第三行", 0);
  assert.strictEqual(result.value, "> 第一行\n>\n> 第三行\n");
}

// 选中文字里的回车不规范（`\r\n`）与首尾空白：归一化后再成块
{
  const result = quoteBlock("", "\r\n  第一行  \r\n第二行\n\n", 0);
  assert.strictEqual(result.value, "> 第一行  \n> 第二行\n", "首尾空白去掉，行内空白（如代码缩进）保留");
}

// 越界光标夹到两端（与 `insertToken` 同一口径：调用方可能传来过期位置）
assert.strictEqual(quoteBlock("abc", "x", 999).value, "abc\n> x\n");
assert.strictEqual(quoteBlock("abc", "x", -5).value, "> x\nabc");
assert.strictEqual(quoteBlock("abc", "x", Number.NaN).value, "abc\n> x\n");

console.log("contextMenu: 引用块落点算术 ✓");

// ---------- 3. 保存的建议文件名（不能让无障碍文案变成文件名） ----------

const img = (alt: string) => ({ alt }) as HTMLImageElement;

assert.strictEqual(suggestedFileName(img("photo.png")), "photo.png", "附件原名照用");
assert.strictEqual(suggestedFileName(img("out/chart.png")), "out/chart.png", "本地图 alt 是路径，宿主会取 basename");
assert.strictEqual(suggestedFileName(img("Image in the message")), undefined, "无障碍文案不是文件名");
assert.strictEqual(suggestedFileName(img("消息里的图片")), undefined, "中文无障碍文案同理");
assert.strictEqual(suggestedFileName(img("")), undefined);
assert.strictEqual(suggestedFileName(img("   ")), undefined);

console.log("contextMenu: 保存的建议文件名 ✓");

// ---------- 4. 会话复制快捷键：真实处理器 + 选区包含性 + 宿主消息 ----------
class CopyElement {
  readonly nodeType = 1;
  constructor(readonly parentElement: CopyElement | null = null, readonly editable = false) {}
  get isContentEditable() { return this.editable; }
  closest(_selector: string): CopyElement | null {
    return this.editable ? this : this.parentElement?.closest(_selector) ?? null;
  }
  contains(node: CopyElement | null): boolean {
    return node === this || !!node?.parentElement && this.contains(node.parentElement);
  }
}
const chat = new CopyElement();
const firstMessage = new CopyElement(chat);
const secondMessage = new CopyElement(chat);
const outside = new CopyElement();
const input = new CopyElement(chat, true);
let active: CopyElement | null = null;
let selection: Record<string, unknown> | null;
Object.assign(globalThis, {
  Element: CopyElement,
  Node: { ELEMENT_NODE: 1 },
  document: {
    get activeElement() { return active; },
    querySelector: () => chat,
  },
});
Object.assign(window, { getSelection: () => selection });
function select(text = "  第一行\n\n第二行  ", anchor: CopyElement = firstMessage, focus: CopyElement = secondMessage) {
  selection = {
    isCollapsed: false, rangeCount: 1,
    anchorNode: { nodeType: 3, parentElement: anchor },
    focusNode: { nodeType: 3, parentElement: focus },
    toString: () => text,
  };
}
function copyKey(overrides: Record<string, unknown> = {}) {
  const event = {
    key: "c", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    isComposing: false, repeat: false, defaultPrevented: false, stopped: false,
    target: firstMessage,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...overrides,
  };
  return event;
}
function runCopy(overrides: Record<string, unknown> = {}) {
  POSTED.length = 0;
  const event = copyKey(overrides);
  handleChatCopy(event as unknown as KeyboardEvent);
  return event;
}
for (const modifiers of [{}, { ctrlKey: false, metaKey: true }]) {
  select();
  const event = runCopy(modifiers);
  assert.deepStrictEqual(POSTED, [{ type: "copy", text: "  第一行\n\n第二行  " }], "跨消息复制保留原始空白与换行");
  assert.ok(event.defaultPrevented && event.stopped, "先于宿主转发接住复制");
  handleChatCopy(event as unknown as KeyboardEvent);
  assert.strictEqual(POSTED.length, 1, "已处理的同一事件不重复复制");
}
for (const overrides of [
  { ctrlKey: false }, { ctrlKey: true, metaKey: true }, { altKey: true },
  { shiftKey: true }, { key: "v" }, { key: "x" }, { repeat: true },
  { isComposing: true }, { defaultPrevented: true }, { target: input },
]) {
  select();
  const event = runCopy(overrides);
  assert.deepStrictEqual(POSTED, [], `不抢原生/无关快捷键 ${JSON.stringify(overrides)}`);
  assert.strictEqual(event.stopped, false);
}
active = input;
select();
assert.strictEqual(runCopy().stopped, false, "可编辑区域聚焦时保留原生复制，即使正文残留选区");
active = null;
for (const endpoints of [[outside, secondMessage], [firstMessage, outside], [outside, outside]]) {
  select("text", endpoints[0], endpoints[1]);
  assert.strictEqual(runCopy().defaultPrevented, false, "选区越界不接管");
  assert.deepStrictEqual(POSTED, []);
}
select(" \n  ");
runCopy();
assert.deepStrictEqual(POSTED, [{ type: "copy", text: " \n  " }], "仅空白的有效选区也照实复制");
for (const absent of [null, { isCollapsed: true }, { isCollapsed: false, rangeCount: 0 }]) {
  selection = absent;
  assert.strictEqual(runCopy().defaultPrevented, false, "无有效选区不覆盖剪贴板");
  assert.deepStrictEqual(POSTED, []);
}
assert.strictEqual(chatSelectionText(null), "");
console.log("contextMenu: 会话 Ctrl+C / Cmd+C 选区与原生编辑边界 ✓");

console.log("\ncontextMenu: all assertions passed");
